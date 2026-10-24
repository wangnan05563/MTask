/**
 * 代码评审会议讲稿 · 范围选择与排除过滤器（六期 2.3 / PRD FR-2.1、FR-2.2、§7.3）。
 *
 * 三件事在这里收口：
 *  1. 项目候选：只列「现行项目」（与 `GET /api/projects` 同源的 ACTIVE_PROJECT_WHERE），
 *     未配置 `workspace_path` 的项目带 `workspaceConfigured=false`，供面板置灰并提示补配。
 *  2. 排除规则：默认集与 `WorkspaceService.DEFAULT_IGNORE_DIRS/FILES` **同源**，再叠加
 *     lockfile / 二进制 / 生成物 / 敏感面（`.env*`、`*secret*`、`*.pem` 等，§7.3）glob；
 *     面板可增删，命中即从上下文剔除并在预检逐一点名。
 *  3. 预检数据面（FR-7.1 的采集统计部分）：逐项目判定 git/patch、采集三形态区间、
 *     过滤并套 2MB 预算，返回项目数/commit/文件/增删行/排除命中/git 可用性点名。
 *     预算估算与调用次数归 T02868/T02875，本单不预设常量。
 *
 * 预检逐项目串行执行：既避免多仓同时 spawn git 抢 IO，也让单项目失败不拖垮整单
 * （失败落 `blocked`，其余项目照常出统计）。
 */
import { getDb } from '../db/connection';
import { ACTIVE_PROJECT_WHERE } from '../util/projectRouting';
import { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_FILES } from './WorkspaceService';
import {
  GIT_DIFF_TEXT_LIMIT,
  GitCollectError,
  LECTURE_PATCH_TEXT_LIMIT,
  applyDiffBudget,
  assertSafeSince,
  assertSingleRevision,
  collectGitRange,
  collectPatchRange,
  resolveCollectionMode,
  resolveRevisionSha,
  type GitCollection,
  type GitCommitEntry,
  type GitErrorKind,
  type GitHunk,
  type GitFileChange,
  type GitRangeInput,
  type GitRangeShape,
} from './gitCollect';

export class LectureScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LectureScopeError';
  }
}

/** 面板里最多同时选多少个项目——防止一次预检 spawn 出过多 git 子进程 */
export const LECTURE_MAX_PROJECTS = 20;
export const LECTURE_MAX_EXCLUDE_RULES = 100;
const EXCLUDE_RULE_MAX_LENGTH = 200;
/** 预检回传的排除命中明细上限（count 始终是真实值，明细只截前 N 条） */
const EXCLUDED_PREVIEW_LIMIT = 50;
const DROPPED_NAME_LIMIT = 20;

export interface LectureProjectOption {
  id: string;
  name: string;
  workspacePath: string;
  /** false = 未配置 workspace_path，面板置灰并要求补配（FR-2.1） */
  workspaceConfigured: boolean;
}

/** 与 DEFAULT_IGNORE_DIRS/FILES 同源的默认排除集 + 二进制/生成物 + 敏感面 */
export const DEFAULT_LECTURE_EXCLUDES: readonly string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `**/${d}/**`),
  ...Array.from(DEFAULT_IGNORE_FILES, (f) => `**/${f}`),
  '**/.env*',
  '**/*secret*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.{png,jpg,jpeg,gif,webp,ico,bmp,svg,pdf,zip,gz,tar,7z,rar,woff,woff2,ttf,eot,mp4,mp3,wasm,exe,dll,so,dylib,node,pyc,class,jar}',
];

export interface LectureProjectScopeInput {
  projectId: string;
  /** 每项目独立选区间形态（FR-2.1）；与 patch 二选一 */
  range?: GitRangeInput;
  /** Git 不可用时的降级通道（FR-1.3）：粘贴 unified diff 全文；与 range 二选一 */
  patch?: string;
}

export interface LectureScopeRequest {
  projects: LectureProjectScopeInput[];
  /** 省略 = 默认排除集；显式空数组 = 不排除任何文件 */
  excludes?: string[];
}

export interface ExcludeRule {
  pattern: string;
  regex: RegExp;
}

export interface ExcludedFile {
  path: string;
  /** 命中的规则原文，供预检「为什么被排除」展示 */
  rule: string;
}

interface ProjectRow {
  id: string;
  name: string;
  workspace_path: string | null;
}

export function listLectureProjects(): LectureProjectOption[] {
  const rows = getDb()
    .prepare(`SELECT id, name, workspace_path FROM projects WHERE ${ACTIVE_PROJECT_WHERE} ORDER BY sort_weight, created_at`)
    .all() as ProjectRow[];
  return rows.map((r) => {
    const workspacePath = (r.workspace_path ?? '').trim();
    return { id: r.id, name: r.name, workspacePath, workspaceConfigured: workspacePath !== '' };
  });
}

function escapeRegExp(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/** `{a,b}` 花括号展开（只支持一层或多层嵌套的逗号枚举） */
function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  return m[1].split(',').flatMap((part) => expandBraces(`${head}${part}${tail}`));
}

/** glob → 正则：支持 `**`、`*`、`?`、`{a,b}`、`[abc]`；`*` 不跨 `/`，`**` 跨目录 */
function globBodyToRegExp(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { out += '[^/]'; continue; }
    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i + 1) {
        out += `[${pattern.slice(i + 1, end).replaceAll('\\', '\\\\')}]`;
        i = end;
        continue;
      }
    }
    out += escapeRegExp(ch);
  }
  return out;
}

function compileRule(pattern: string): ExcludeRule {
  // 无 `/` 的模式按 gitignore 习惯在任意深度匹配（`*.md` 等价 `**/*.md`）
  const normalized = pattern.includes('/') ? pattern : `**/${pattern}`;
  const body = expandBraces(normalized).map(globBodyToRegExp).join('|');
  return { pattern, regex: new RegExp(`^(?:${body})$`, 'i') };
}

/** 校验并去重用户提交的排除规则（显式空数组 = 不排除） */
export function normalizeExcludeRules(input: unknown): string[] {
  if (!Array.isArray(input)) throw new LectureScopeError('excludes 必须是字符串数组');
  if (input.length > LECTURE_MAX_EXCLUDE_RULES) throw new LectureScopeError(`排除规则最多 ${LECTURE_MAX_EXCLUDE_RULES} 条`);
  const out: string[] = [];
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    if (typeof raw !== 'string') throw new LectureScopeError(`excludes[${i}] 必须是字符串`);
    const rule = raw.trim().replaceAll('\\', '/');
    if (!rule) return;
    if (rule.length > EXCLUDE_RULE_MAX_LENGTH) throw new LectureScopeError(`排除规则过长（>${EXCLUDE_RULE_MAX_LENGTH} 字符）：${rule.slice(0, 30)}…`);
    if (/[\0\r\n]/.test(rule)) throw new LectureScopeError(`排除规则含控制字符：${rule}`);
    if (rule.startsWith('!')) throw new LectureScopeError(`暂不支持否定规则「${rule}」`);
    if (rule.startsWith('/') || /^[A-Za-z]:/.test(rule)) throw new LectureScopeError(`排除规则必须是仓库相对路径：${rule}`);
    if (rule.split('/').some((seg) => seg === '..')) throw new LectureScopeError(`排除规则不得包含 ..：${rule}`);
    if (seen.has(rule)) return;
    seen.add(rule);
    out.push(rule);
  });
  return out;
}

export function compileExcludeRules(patterns: readonly string[]): ExcludeRule[] {
  return patterns.map(compileRule);
}

export interface FilterResult {
  kept: GitFileChange[];
  excluded: ExcludedFile[];
}

/** 按规则顺序取第一条命中（预检展示「被哪条规则排除」） */
export function filterChanges(files: readonly GitFileChange[], rules: readonly ExcludeRule[]): FilterResult {
  const kept: GitFileChange[] = [];
  const excluded: ExcludedFile[] = [];
  for (const f of files) {
    const hit = rules.find((r) => r.regex.test(f.path));
    if (hit) excluded.push({ path: f.path, rule: hit.pattern });
    else kept.push(f);
  }
  return { kept, excluded };
}

function parseRange(raw: unknown, index: number): GitRangeInput {
  if (!raw || typeof raw !== 'object') throw new LectureScopeError(`projects[${index}].range 必填`);
  const r = raw as Record<string, unknown>;
  const shape = r.shape;
  if (shape !== 'base-head' && shape !== 'first-last' && shape !== 'since') {
    throw new LectureScopeError(`projects[${index}].range.shape 只支持 base-head/first-last/since`);
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const range: GitRangeInput = { shape: shape as GitRangeShape };
  try {
    if (shape === 'base-head') {
      if (!str(r.base)) throw new LectureScopeError(`projects[${index}].range.base 必填（分支/标签/SHA）`);
      range.base = assertSingleRevision(str(r.base)!);
      if (str(r.head)) range.head = assertSingleRevision(str(r.head)!);
    } else if (shape === 'first-last') {
      if (!str(r.base) || !str(r.head)) throw new LectureScopeError(`projects[${index}].range 首末 SHA 都要填`);
      range.base = assertSingleRevision(str(r.base)!);
      range.head = assertSingleRevision(str(r.head)!);
    } else {
      if (!str(r.since)) throw new LectureScopeError(`projects[${index}].range.since 必填`);
      range.since = assertSafeSince(str(r.since)!);
      if (str(r.head)) range.head = assertSingleRevision(str(r.head)!);
    }
  } catch (e) {
    if (e instanceof LectureScopeError) throw e;
    throw new LectureScopeError(`projects[${index}].range 非法：${e instanceof Error ? e.message : String(e)}`);
  }
  return range;
}

/** 讲稿请求体 → 规范化范围（预检与流式生成共用同一份校验，避免两处口径漂移） */
export function parseLectureScopeRequest(body: unknown): { projects: LectureProjectScopeInput[]; excludes: string[] } {
  if (!body || typeof body !== 'object') throw new LectureScopeError('请求体必须是 JSON 对象');
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.projects) || b.projects.length === 0) throw new LectureScopeError('projects 必填（至少选一个项目）');
  if (b.projects.length > LECTURE_MAX_PROJECTS) throw new LectureScopeError(`一次最多预检 ${LECTURE_MAX_PROJECTS} 个项目`);
  const seen = new Set<string>();
  const projects = b.projects.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new LectureScopeError(`projects[${i}] 必须是对象`);
    const row = raw as Record<string, unknown>;
    const projectId = typeof row.projectId === 'string' ? row.projectId.trim() : '';
    if (!projectId) throw new LectureScopeError(`projects[${i}].projectId 必填`);
    if (seen.has(projectId)) throw new LectureScopeError(`项目「${projectId}」被重复选择`);
    seen.add(projectId);
    if (row.patch !== undefined) {
      if (typeof row.patch !== 'string') throw new LectureScopeError(`projects[${i}].patch 必须是字符串`);
      if (row.range !== undefined) throw new LectureScopeError(`projects[${i}] 只能选 git 区间或粘贴 patch 之一`);
      if (!row.patch.trim()) throw new LectureScopeError(`projects[${i}].patch 为空：请粘贴 unified diff 全文`);
      if (Buffer.byteLength(row.patch, 'utf8') > LECTURE_PATCH_TEXT_LIMIT) {
        throw new LectureScopeError(`projects[${i}].patch 超过 ${LECTURE_PATCH_TEXT_LIMIT / (1024 * 1024)}MB 上限，请分次评审或收窄范围`);
      }
      return { projectId, patch: row.patch };
    }
    return { projectId, range: parseRange(row.range, i) };
  });
  const excludes = b.excludes === undefined ? [...DEFAULT_LECTURE_EXCLUDES] : normalizeExcludeRules(b.excludes);
  return { projects, excludes };
}

function rangeLabelOf(range: GitRangeInput): string {
  if (range.shape === 'since') return `自 ${range.since ?? ''}`;
  if (range.shape === 'first-last') return `${range.base ?? ''}..${range.head ?? ''}`;
  return `${range.base ?? ''}..${range.head ?? 'HEAD'}`;
}

export interface LectureProjectPreview {
  projectId: string;
  projectName: string;
  workspacePath: string;
  mode: 'git' | 'patch';
  rangeLabel: string;
  git: { available: boolean; isRepo: boolean; kind?: GitErrorKind; reason?: string };
  /** 采集统计（排除前，供与 git log --stat 对账） */
  stats: { commits: number; files: number; additions: number; deletions: number };
  excluded: { count: number; files: ExcludedFile[]; truncated: boolean };
  /** 过滤并套 2MB 预算后、真正会进讲稿的规模 */
  kept: { files: number; additions: number; deletions: number; chars: number };
  budget: { dropped: number; partial: number; droppedNames: string[]; limit: number; truncated: boolean };
  warnings: string[];
  /** 硬阻塞原因（未配置 workspace / 项目不存在 / 采集失败）；空 = 该项目可继续 */
  blocked?: string;
}

export interface LectureScopePreview {
  projects: LectureProjectPreview[];
  totals: {
    projects: number;
    ready: number;
    commits: number;
    files: number;
    additions: number;
    deletions: number;
    excluded: number;
    keptFiles: number;
    keptChars: number;
  };
  /** 至少一个项目可采集（可进入下一阶段） */
  ok: boolean;
  warnings: string[];
}

function blankPreview(projectId: string, projectName: string, workspacePath: string, rangeLabel: string): LectureProjectPreview {
  return {
    projectId,
    projectName,
    workspacePath,
    mode: 'git',
    rangeLabel,
    git: { available: false, isRepo: false },
    stats: { commits: 0, files: 0, additions: 0, deletions: 0 },
    excluded: { count: 0, files: [], truncated: false },
    kept: { files: 0, additions: 0, deletions: 0, chars: 0 },
    budget: { dropped: 0, partial: 0, droppedNames: [], limit: GIT_DIFF_TEXT_LIMIT, truncated: false },
    warnings: [],
  };
}

/** 采集 + 过滤 + 预算后的项目（带 diff 正文，供流式生成；预检只回不含正文的视图） */
export interface LectureCollectedProject extends LectureProjectPreview {
  files: GitFileChange[];
  commits: GitCommitEntry[];
  /** git 采集终点的解析后 commit SHA（patch 模式无） */
  revision?: string;
}

export interface LectureCollection {
  projects: LectureCollectedProject[];
  preview: LectureScopePreview;
}

/** 过滤 + 2MB 预算收口：预检与生成共用，命中/丢弃明细只在这里算一次 */
function summarizeCollection(
  base: LectureProjectPreview,
  collected: GitCollection,
  rules: readonly ExcludeRule[],
): { preview: LectureProjectPreview; files: GitFileChange[] } {
  const filtered = filterChanges(collected.files, rules);
  const budget = applyDiffBudget(filtered.kept, GIT_DIFF_TEXT_LIMIT);
  const warnings = [...collected.warnings];
  if (budget.truncated) {
    warnings.push(`过滤后 diff 仍超过单仓 ${GIT_DIFF_TEXT_LIMIT / (1024 * 1024)}MB 预算：已丢弃 ${budget.dropped.length} 个文件`
      + (budget.dropped.length ? `（${budget.dropped.slice(0, DROPPED_NAME_LIMIT).map((e) => e.path).join('、')}${budget.dropped.length > DROPPED_NAME_LIMIT ? ' 等' : ''}）` : ''));
    if (budget.partial.length > 0) warnings.push(`单文件超出剩余预算，已保头保尾截断：${budget.partial.map((e) => e.path).join('、')}`);
  }
  if (filtered.kept.length === 0 && filtered.excluded.length > 0) warnings.push('区间内所有变更文件都被排除规则过滤，请检查排除规则');
  const kept = budget.kept;
  return {
    files: kept,
    preview: {
      ...base,
      stats: collected.stats,
      excluded: {
        count: filtered.excluded.length,
        files: filtered.excluded.slice(0, EXCLUDED_PREVIEW_LIMIT),
        truncated: filtered.excluded.length > EXCLUDED_PREVIEW_LIMIT,
      },
      kept: {
        files: kept.length,
        additions: kept.reduce((s, f) => s + f.additions, 0),
        deletions: kept.reduce((s, f) => s + f.deletions, 0),
        chars: kept.reduce((s, f) => s + f.textLength, 0),
      },
      budget: {
        dropped: budget.dropped.length,
        partial: budget.partial.length,
        droppedNames: budget.dropped.slice(0, DROPPED_NAME_LIMIT).map((e) => e.path),
        limit: budget.limit,
        truncated: budget.truncated,
      },
      warnings,
    },
  };
}

async function scanProject(
  item: LectureProjectScopeInput,
  project: ProjectRow | undefined,
  rules: readonly ExcludeRule[],
): Promise<LectureCollectedProject> {
  const workspacePath = (project?.workspace_path ?? '').trim();
  const base = blankPreview(item.projectId, project?.name ?? item.projectId, workspacePath, item.patch !== undefined ? '粘贴 patch' : rangeLabelOf(item.range!));
  if (!project) return { ...base, files: [], commits: [], blocked: '项目不存在或已归档（请刷新项目列表）' };

  // 粘贴 patch 不依赖工作空间与 git，先于 git 探测处理（FR-1.3 降级通道）
  if (item.patch !== undefined) {
    const patchBase: LectureProjectPreview = { ...base, mode: 'patch' };
    try {
      const collected = collectPatchRange(item.patch, { diffLimit: Number.MAX_SAFE_INTEGER });
      const { preview, files } = summarizeCollection(patchBase, collected, rules);
      return { ...preview, files, commits: [] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const kind = e instanceof GitCollectError ? `（${e.kind}）` : '';
      return { ...patchBase, files: [], commits: [], blocked: `粘贴 patch 无法解析${kind}：${msg}` };
    }
  }

  if (!workspacePath) return { ...base, files: [], commits: [], blocked: '未配置工作空间路径（请在项目管理中补配后重试）' };

  const decision = await resolveCollectionMode(workspacePath);
  base.git = { available: decision.probe.available, isRepo: decision.probe.isRepo, ...(decision.probe.kind ? { kind: decision.probe.kind } : {}), ...(decision.probe.detail ? { reason: decision.probe.detail } : {}) };
  if (decision.mode === 'patch') {
    return { ...base, mode: 'patch', files: [], commits: [], warnings: [decision.reason ?? 'Git 不可用，请改用「粘贴 patch」模式'] };
  }

  try {
    // 先拿全量变更再过滤：若先套 2MB 预算，低优先级文件会被提前丢弃，排除命中数就失真
    const collected = await collectGitRange(workspacePath, item.range!, { diffLimit: Number.MAX_SAFE_INTEGER });
    const { preview, files } = summarizeCollection(base, collected, rules);
    // revision 要给锚点 blob 复核当坐标，必须是解析后的 commit SHA；解析失败退回符号名而不是整项目 blocked
    let revision = collected.range.head;
    try {
      revision = await resolveRevisionSha(workspacePath, collected.range.head);
    } catch { /* 保留符号名，锚点复核按当前树尽力而为 */ }
    return { ...preview, files, commits: collected.commits, revision };
  } catch (e) {
    if (e instanceof GitCollectError) return { ...base, files: [], commits: [], blocked: `${e.message}（${e.kind}）` };
    throw e;
  }
}

const toPreview = (p: LectureCollectedProject): LectureProjectPreview => ({
  projectId: p.projectId,
  projectName: p.projectName,
  workspacePath: p.workspacePath,
  mode: p.mode,
  rangeLabel: p.rangeLabel,
  git: p.git,
  stats: p.stats,
  excluded: p.excluded,
  kept: p.kept,
  budget: p.budget,
  warnings: p.warnings,
  ...(p.blocked ? { blocked: p.blocked } : {}),
});

/**
 * 逐项目串行采集（含 patch 降级）：预检与流式生成共用。
 * 返回带 diff 正文的项目 + 与预检 HTTP 同形的轻量视图。
 */
export async function collectLectureScope(body: unknown): Promise<LectureCollection> {
  const req = parseLectureScopeRequest(body);
  const rules = compileExcludeRules(req.excludes);
  const db = getDb();
  const projects: LectureCollectedProject[] = [];
  for (const item of req.projects) {
    const project = db
      .prepare(`SELECT id, name, workspace_path FROM projects WHERE id = ? AND ${ACTIVE_PROJECT_WHERE}`)
      .get(item.projectId) as ProjectRow | undefined;
    projects.push(await scanProject(item, project, rules));
  }
  const usable = projects.filter((p) => !p.blocked && p.stats.files > 0);
  const warnings: string[] = [];
  if (usable.length === 0) warnings.push('没有可采集的项目：请补配工作空间路径，或改用「粘贴 patch」');
  return {
    projects,
    preview: {
      projects: projects.map(toPreview),
      totals: {
        projects: projects.length,
        ready: usable.length,
        commits: usable.reduce((s, p) => s + p.stats.commits, 0),
        files: usable.reduce((s, p) => s + p.stats.files, 0),
        additions: usable.reduce((s, p) => s + p.stats.additions, 0),
        deletions: usable.reduce((s, p) => s + p.stats.deletions, 0),
        excluded: usable.reduce((s, p) => s + p.excluded.count, 0),
        keptFiles: usable.reduce((s, p) => s + p.kept.files, 0),
        keptChars: usable.reduce((s, p) => s + p.kept.chars, 0),
      },
      ok: usable.length > 0,
      warnings,
    },
  };
}

/** 范围预检：逐项目串行采集 + 过滤 + 预算，返回 FR-7.1 的采集统计面（零 diff 正文） */
export async function previewLectureScope(body: unknown): Promise<LectureScopePreview> {
  return (await collectLectureScope(body)).preview;
}

/**
 * 左面板 diff 视图（T02872 三区布局 / PRD §6.1）。
 *
 * 预检端点刻意只回统计面，正文留给这里：三区布局的左栏要渲染真实的 unified diff，
 * 且锚点 `[file#Lx-Ly]` 的定位必须有 new 侧行号可对。采集与排除口径仍走 `collectLectureScope`
 * 单一通道（同一份 2MB 预算、同一份排除规则），不另起一次 git 采集。
 */
export interface LectureDiffFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** 过滤并套预算后真正会进讲稿的 hunk（含行首 diff 前缀） */
  hunks: GitHunk[];
}

export interface LectureDiffProject extends LectureProjectPreview {
  revision?: string;
  files: LectureDiffFile[];
}

export interface LectureDiffView {
  projects: LectureDiffProject[];
  totals: LectureScopePreview['totals'];
  ok: boolean;
  warnings: string[];
}

export async function buildLectureDiffView(body: unknown): Promise<LectureDiffView> {
  const { projects, preview } = await collectLectureScope(body);
  return {
    projects: projects.map((p) => ({
      ...toPreview(p),
      ...(p.revision ? { revision: p.revision } : {}),
      files: p.files.map((f) => ({
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
        additions: f.additions,
        deletions: f.deletions,
        binary: f.binary,
        hunks: f.hunks,
      })),
    })),
    totals: preview.totals,
    ok: preview.ok,
    warnings: preview.warnings,
  };
}
