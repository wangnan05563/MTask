/**
 * 代码评审会议讲稿 · 上下文分段装配（六期 2.4 / PRD FR-3.1~FR-3.3）。
 *
 * 三阶压缩：
 *  1. 全量层：`文件清单 + stat`（manifest），供大纲阶段一次看全貌；
 *  2. 单文件层：逐文件 hunk 摘要，超大 hunk / 超大文件保头保尾截断并显式标注；
 *  3. 分组层：按「项目 → 模块（目录） → 文件」分组，每组预算内拼装，超预算的模块拆多组
 *     （每组对应一次 askStream）；每个文件只进一组，组间不重复注入。
 *
 * 预算 `LECTURE_CONTEXT_BUDGET` 与 `PRD_CONTEXT_LIMIT=6000` 分立，避免悄悄复用降质；
 * 可用 `MTASK_LECTURE_CONTEXT_BUDGET` 或显式入参覆盖。
 *
 * 符号展开（FR-3.3）走既有 workspace_symbols 索引，深度固定 1：变更文件的定义 +
 * 同名符号在其他文件的索引行（不递归、不引入 embedding/新索引）。
 */
import { extname } from 'node:path';
import { WorkspaceService } from './WorkspaceService';
import { isSecurityPath, type GitFileChange } from './gitCollect';

export class LectureContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LectureContextError';
  }
}

/** 每次 askStream 的上下文字符预算（与 PRD_CONTEXT_LIMIT 分立） */
export const LECTURE_CONTEXT_BUDGET = 60_000;
const LECTURE_BUDGET_MIN = 2_000;
const LECTURE_BUDGET_MAX = 400_000;
/** 单 hunk / 单文件摘要上限，超出按「保头保尾」截断 */
export const LECTURE_HUNK_MAX_CHARS = 4_000;
export const LECTURE_FILE_MAX_CHARS = 12_000;
const LECTURE_SYMBOL_SECTION_CHARS = 1_500;
/** 符号展开深度：只做一跳（定义 → 同名索引行），不递归 */
export const LECTURE_SYMBOL_DEPTH = 1;

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.java', '.kt', '.kts', '.go', '.rs', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.swift', '.rb', '.php', '.sql',
]);

export interface LectureContextProject {
  projectId: string;
  projectName: string;
  files: readonly GitFileChange[];
}

export interface LectureManifestEntry {
  projectId: string;
  projectName: string;
  module: string;
  path: string;
  additions: number;
  deletions: number;
  changedLines: number;
  hunks: number;
  binary: boolean;
}

export interface LectureHunkSummary {
  text: string;
  truncated: boolean;
  omitted: number;
}

export interface LectureFileSummary {
  projectId: string;
  projectName: string;
  module: string;
  path: string;
  additions: number;
  deletions: number;
  changedLines: number;
  hunks: number;
  binary: boolean;
  symbolRefs: number;
  chars: number;
  /** 文件摘要被保头保尾截断（hunk 级截断另计 truncatedHunks） */
  truncated: boolean;
  truncatedHunks: number;
  text: string;
}

export interface LectureContextGroup {
  /** `${projectId}::${module}::${part}` */
  id: string;
  projectId: string;
  projectName: string;
  module: string;
  part: number;
  parts: number;
  files: string[];
  chars: number;
  content: string;
  /** 因组预算不足在组内再截断的文件 */
  trimmedFiles: string[];
}

export interface LectureContextTotals {
  projects: number;
  files: number;
  modules: number;
  groups: number;
  chars: number;
  budget: number;
  truncatedFiles: number;
  truncatedHunks: number;
  symbolFiles: number;
}

export interface LectureContextResult {
  manifest: LectureManifestEntry[];
  manifestText: string;
  files: LectureFileSummary[];
  groups: LectureContextGroup[];
  totals: LectureContextTotals;
  warnings: string[];
}

export interface LectureSymbolRef {
  path: string;
  line: number;
  kind: string;
}

export interface LectureSymbolHint {
  symbol: string;
  kind: string;
  line: number;
  refs: LectureSymbolRef[];
}

export interface LectureSymbolOptions {
  maxDefinitions?: number;
  maxNames?: number;
  refsPerName?: number;
}

export interface LectureSymbolExpansion {
  /** key = `${projectId}\0${path}` */
  hints: Map<string, LectureSymbolHint[]>;
  warnings: string[];
}

export interface LectureContextOptions {
  /** 覆盖预算（未传时读 MTASK_LECTURE_CONTEXT_BUDGET，再退回 LECTURE_CONTEXT_BUDGET） */
  budget?: unknown;
  hunkMaxChars?: number;
  fileMaxChars?: number;
  /** expandLectureSymbols 的产物；key 见 symbolKey() */
  symbolHints?: ReadonlyMap<string, readonly LectureSymbolHint[]>;
}

export function resolveLectureContextBudget(raw?: unknown): number {
  const value = raw === undefined || raw === null || raw === ''
    ? process.env.MTASK_LECTURE_CONTEXT_BUDGET
    : raw;
  if (value === undefined || value === null || value === '') return LECTURE_CONTEXT_BUDGET;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < LECTURE_BUDGET_MIN || n > LECTURE_BUDGET_MAX) {
    throw new LectureContextError(`讲稿上下文预算必须是 ${LECTURE_BUDGET_MIN}~${LECTURE_BUDGET_MAX} 的整数（收到：${String(value)}）`);
  }
  return n;
}

export function moduleOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '(根目录)' : path.slice(0, i);
}

export function symbolKey(projectId: string, path: string): string {
  return `${projectId}\0${path}`;
}

/** 保头保尾截断（纪律同 prdContext.trimPrdContent），中段显式标注略去字符数 */
export function trimMiddle(text: string, limit: number, label = '内容'): { text: string; omitted: number; truncated: boolean } {
  if (text.length <= limit) return { text, omitted: 0, truncated: false };
  const half = Math.max(0, Math.floor((limit - 160) / 2));
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const omitted = text.length - head.length - tail.length;
  let out = `${head}\n……（${label}中段略去 ${omitted} 字符，保头保尾）……\n${tail}`;
  if (out.length > limit) out = out.slice(0, limit);
  return { text: out, omitted, truncated: true };
}

export function summarizeHunk(hunkText: string, maxChars = LECTURE_HUNK_MAX_CHARS): LectureHunkSummary {
  const trimmed = trimMiddle(hunkText, Math.max(0, maxChars), 'hunk ');
  return { text: trimmed.text, truncated: trimmed.truncated, omitted: trimmed.omitted };
}

function hunkBody(hunk: GitFileChange['hunks'][number]): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`;
}

export function formatSymbolHints(hints: readonly LectureSymbolHint[], maxChars = LECTURE_SYMBOL_SECTION_CHARS): string {
  if (hints.length === 0) return '';
  const lines: string[] = ['#### 符号线索（深度 1）'];
  lines.push(`- 定义：${hints.map((h) => `\`${h.symbol}\`(${h.kind},L${h.line})`).join('、')}`);
  for (const h of hints) {
    lines.push(h.refs.length
      ? `- 引用：\`${h.symbol}\` → ${h.refs.map((r) => `${r.path}:${r.line}`).join('、')}`
      : `- 引用：\`${h.symbol}\` 未在同名索引中命中`);
  }
  const text = lines.join('\n');
  return trimMiddle(text, maxChars, '符号线索').text;
}

export function summarizeFile(
  project: LectureContextProject,
  file: GitFileChange,
  options: { hunkMaxChars?: number; fileMaxChars?: number; symbolHints?: readonly LectureSymbolHint[] } = {},
): LectureFileSummary {
  const hunkMaxChars = options.hunkMaxChars ?? LECTURE_HUNK_MAX_CHARS;
  const fileMaxChars = options.fileMaxChars ?? LECTURE_FILE_MAX_CHARS;
  const changedLines = file.additions + file.deletions;
  const parts: string[] = [`### ${file.path}（+${file.additions}/-${file.deletions}，${file.hunks.length} 个 hunk）`];
  let truncatedHunks = 0;
  if (file.binary) {
    parts.push('（二进制文件，未展开 diff）');
  } else if (file.hunks.length === 0) {
    parts.push('（无文本 hunk：仅模式/重命名等元数据变更）');
  } else {
    for (const hunk of file.hunks) {
      const s = summarizeHunk(hunkBody(hunk), hunkMaxChars);
      if (s.truncated) truncatedHunks += 1;
      parts.push(s.text);
    }
  }
  const symbolSection = formatSymbolHints(options.symbolHints ?? []);
  if (symbolSection) parts.push(symbolSection);
  const body = parts.join('\n\n');
  const trimmed = trimMiddle(body, fileMaxChars, '文件上下文');
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    module: moduleOf(file.path),
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    changedLines,
    hunks: file.hunks.length,
    binary: file.binary,
    symbolRefs: (options.symbolHints ?? []).reduce((s, h) => s + h.refs.length, 0),
    chars: trimmed.text.length,
    truncated: trimmed.truncated,
    truncatedHunks,
    text: trimmed.text,
  };
}

export function buildManifest(projects: readonly LectureContextProject[]): LectureManifestEntry[] {
  const out: LectureManifestEntry[] = [];
  for (const project of projects) {
    const entries = project.files.map((f) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      module: moduleOf(f.path),
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      changedLines: f.additions + f.deletions,
      hunks: f.hunks.length,
      binary: f.binary,
    }));
    entries.sort((a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path));
    out.push(...entries);
  }
  return out;
}

export function formatManifest(manifest: readonly LectureManifestEntry[]): string {
  if (manifest.length === 0) return '（区间内无文件变更）';
  const lines = [`## 变更文件清单（${manifest.length} 个文件）`];
  let currentProject = '';
  for (const e of manifest) {
    if (e.projectName !== currentProject) {
      currentProject = e.projectName;
      lines.push(`\n### 项目「${e.projectName}」`);
    }
    const shown = e.module === '(根目录)' ? e.path : `${e.module}/${e.path.split('/').pop() ?? e.path}`;
    lines.push(`- ${shown}（+${e.additions}/-${e.deletions}${e.binary ? '，二进制' : ''}）`);
  }
  return lines.join('\n');
}

function fileRank(summary: LectureFileSummary): [number, number, number] {
  return [summary.changedLines, isSecurityPath(summary.path) ? 1 : 0, summary.symbolRefs];
}

function compareFiles(a: LectureFileSummary, b: LectureFileSummary): number {
  const ra = fileRank(a);
  const rb = fileRank(b);
  return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2] || a.path.localeCompare(b.path);
}

interface GroupSeed {
  projectId: string;
  projectName: string;
  module: string;
  files: LectureFileSummary[];
}

function seedGroups(summaries: readonly LectureFileSummary[]): GroupSeed[] {
  const map = new Map<string, GroupSeed>();
  const projectOrder = new Map<string, number>();
  for (const s of summaries) {
    if (!projectOrder.has(s.projectId)) projectOrder.set(s.projectId, projectOrder.size);
    const key = `${s.projectId}\0${s.module}`;
    let seed = map.get(key);
    if (!seed) {
      seed = { projectId: s.projectId, projectName: s.projectName, module: s.module, files: [] };
      map.set(key, seed);
    }
    seed.files.push(s);
  }
  for (const seed of map.values()) seed.files.sort(compareFiles);
  // 项目按用户选择顺序，模块按目录名排序——分组与调用顺序确定，不随 git diff 输出顺序漂移
  return [...map.values()].sort((a, b) =>
    (projectOrder.get(a.projectId) ?? 0) - (projectOrder.get(b.projectId) ?? 0)
    || a.module.localeCompare(b.module),
  );
}

function groupHeader(projectName: string, module: string, part: number, parts: number): string {
  if (parts <= 1) return `# 代码评审讲稿上下文 · 项目「${projectName}」· 模块 ${module}\n\n`;
  return `# 代码评审讲稿上下文 · 项目「${projectName}」· 模块 ${module}（第 ${part}/${parts} 组）\n\n`;
}

function packSeed(seed: GroupSeed, budget: number): { chunks: Array<{ files: LectureFileSummary[]; texts: string[] }>; trimmed: string[] } {
  // 组头预留按最宽编号估算，保证拼装后字符数不超预算
  const reserve = groupHeader(seed.projectName, seed.module, 99, 99).length;
  const chunks: Array<{ files: LectureFileSummary[]; texts: string[] }> = [];
  const trimmed: string[] = [];
  let current: { files: LectureFileSummary[]; texts: string[] } = { files: [], texts: [] };
  let used = reserve;

  const flush = () => {
    if (current.files.length > 0) chunks.push(current);
    current = { files: [], texts: [] };
    used = reserve;
  };

  for (const file of seed.files) {
    let text = file.text;
    // 文件之间用空行分隔，预算记账必须含分隔符，否则拼装结果会超限 2 字符/次
    let sep = current.files.length > 0 ? 2 : 0;
    if (reserve + text.length > budget) {
      flush();
      const fit = trimMiddle(text, Math.max(1, budget - reserve), '文件上下文');
      text = fit.text;
      trimmed.push(file.path);
      current.files.push(file);
      current.texts.push(text);
      flush();
      continue;
    }
    if (used + text.length + sep > budget) { flush(); sep = 0; }
    current.files.push(file);
    current.texts.push(text);
    used += text.length + sep;
  }
  flush();
  return { chunks, trimmed };
}

export function buildLectureContext(
  projects: readonly LectureContextProject[],
  options: LectureContextOptions = {},
): LectureContextResult {
  const budget = resolveLectureContextBudget(options.budget);
  const symbolsEnabled = options.symbolHints !== undefined;
  const summaries = projects.flatMap((project) => project.files.map((file) => summarizeFile(project, file, {
    hunkMaxChars: options.hunkMaxChars,
    fileMaxChars: options.fileMaxChars,
    symbolHints: options.symbolHints?.get(symbolKey(project.projectId, file.path)),
  })));
  const manifest = buildManifest(projects);
  const groups: LectureContextGroup[] = [];
  const warnings: string[] = [];
  let splitModules = 0;
  let trimmedInGroup = 0;

  for (const seed of seedGroups(summaries)) {
    const { chunks, trimmed } = packSeed(seed, budget);
    if (trimmed.length > 0) trimmedInGroup += trimmed.length;
    if (chunks.length > 1) splitModules += 1;
    chunks.forEach((chunk, i) => {
      const part = i + 1;
      const parts = chunks.length;
      const content = groupHeader(seed.projectName, seed.module, part, parts) + chunk.texts.join('\n\n');
      groups.push({
        id: `${seed.projectId}::${seed.module}::${part}`,
        projectId: seed.projectId,
        projectName: seed.projectName,
        module: seed.module,
        part,
        parts,
        files: chunk.files.map((f) => f.path),
        chars: content.length,
        content,
        trimmedFiles: trimmed.filter((p) => chunk.files.some((f) => f.path === p)),
      });
    });
  }

  const truncatedFiles = summaries.filter((s) => s.truncated).length + trimmedInGroup;
  const truncatedHunks = summaries.reduce((s, f) => s + f.truncatedHunks, 0);
  const symbolFiles = symbolsEnabled
    ? summaries.filter((s) => (options.symbolHints?.get(symbolKey(s.projectId, s.path)) ?? []).length > 0).length
    : 0;

  if (summaries.length === 0) warnings.push('没有可装配的变更文件');
  if (truncatedFiles > 0) {
    const names = summaries.filter((s) => s.truncated).slice(0, 10).map((s) => s.path);
    warnings.push(`${truncatedFiles} 个文件超出单文件/组预算，已保头保尾截断${names.length ? `（${names.join('、')}${truncatedFiles > names.length ? ' 等' : ''}）` : ''}`);
  }
  if (splitModules > 0) warnings.push(`${splitModules} 个模块超出 ${budget} 字符预算，已拆分为多组逐组生成`);

  return {
    manifest,
    manifestText: formatManifest(manifest),
    files: summaries,
    groups,
    totals: {
      projects: projects.length,
      files: summaries.length,
      modules: seedGroups(summaries).length,
      groups: groups.length,
      chars: groups.reduce((s, g) => s + g.chars, 0),
      budget,
      truncatedFiles,
      truncatedHunks,
      symbolFiles,
    },
    warnings,
  };
}

/**
 * 符号展开一层：变更源码文件 → 索引中的定义（所在类/函数）+ 同名符号在其他文件的索引行。
 * 仅作上下文增强，索引缺失/项目无工作空间时跳过并记一条告警，不影响主流程。
 */
export function expandLectureSymbols(
  projects: readonly LectureContextProject[],
  options: LectureSymbolOptions = {},
): LectureSymbolExpansion {
  const maxDefs = options.maxDefinitions ?? 20;
  const maxNames = options.maxNames ?? 10;
  const refsPerName = options.refsPerName ?? 5;
  const hints = new Map<string, LectureSymbolHint[]>();
  const warnings: string[] = [];
  const failedProjects = new Set<string>();

  for (const project of projects) {
    for (const file of project.files) {
      if (file.binary || !SOURCE_EXTS.has(extname(file.path).toLowerCase())) continue;
      let defs: Array<{ symbol: string; line: number; kind: string }>;
      try {
        defs = WorkspaceService.symbolsInFile(project.projectId, file.path, maxDefs);
      } catch (e) {
        if (!failedProjects.has(project.projectId)) {
          failedProjects.add(project.projectId);
          warnings.push(`项目「${project.projectName}」符号展开跳过：${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
      if (defs.length === 0) continue;
      const list: LectureSymbolHint[] = [];
      const seen = new Set<string>();
      for (const def of defs) {
        if (list.length >= maxNames) break;
        if (seen.has(def.symbol)) continue;
        seen.add(def.symbol);
        let refs: LectureSymbolRef[] = [];
        if (def.symbol.trim().length >= 2) {
          try {
            refs = WorkspaceService.querySymbols(project.projectId, def.symbol, refsPerName * 3)
              .filter((r) => r.path !== file.path)
              .slice(0, refsPerName)
              .map((r) => ({ path: r.path, line: r.line, kind: r.kind }));
          } catch {
            refs = [];
          }
        }
        list.push({ symbol: def.symbol, kind: def.kind, line: def.line, refs });
      }
      if (list.length > 0) hints.set(symbolKey(project.projectId, file.path), list);
    }
  }
  return { hints, warnings };
}
