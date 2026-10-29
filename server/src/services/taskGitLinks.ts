/**
 * 任务 ↔ Git 提交关联（八期 §2 / §3.1–§3.2 / §4.2）。
 *
 * 口径要点（PRD 裁定，实现不得自行放宽）：
 *  - **显式写入**：关联只由 AI 回写（`source='agent'`，MCP `mtask_link_git_commit`）或手动绑定
 *    （`source='manual'`）产生，绝不解析提交信息。
 *  - **工作空间解析口径**：链接行内的 `workspace_path` 只是审计快照；
 *    解析 SHA（摘要/文件/外链）一律用项目**当前** `projects.workspace_path`。
 *    项目换绑后旧 SHA 在新仓库不存在 → 回 `missing`，不静默失败。
 *  - **幂等**：同任务同 SHA 重复回写不产生重复记录（`ux_task_git_links`）。
 *  - **只读红线**：全部取数走 `gitCollect` 白名单，不写工作树。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { notifyChange } from './ChangeBus';
import {
  GitCollectError,
  collectCommitFiles,
  collectCommitSummaries,
  collectDiff,
  collectRemoteUrl,
  parseUnifiedDiff,
  runGitReadonly,
  assertSafeRepoPath,
  truncateDiffText,
  GIT_EMPTY_TREE_SHA1,
  GIT_DIFF_TEXT_LIMIT,
  type CommitFileEntry,
  type CommitSummaryRow,
  type GitCollectOptions,
  type GitErrorKind,
  type GitHunk,
} from './gitCollect';
import { shortShaOf, stripUrlCredentials, commitBaseOf, buildCommitLink, type GitPlatform } from '../util/gitRemote';

/** §3.1.3 外链信息：服务端算好前缀再下发，凭据剥离不交给渲染层（token 进了 DOM 就等于泄露） */
export interface GitRemoteInfo {
  /** 已剥离 userinfo 的 remote 地址；无远端为空串 */
  url: string;
  /** 展示用 `host/owner/repo` */
  display: string;
  platform: GitPlatform | null;
  /** 提交外链前缀（`…/commit` 或 GitLab `…/-/commit`）；平台不可识别为 null → 站内兜底 */
  commitBase: string | null;
  noRemote: boolean;
}

/** 由 origin 远端推导外链信息；无远端/解析失败都不抛错（外链只是页面动作，不该拖垮首屏） */
export function remoteInfoOf(rawUrl: string | null): GitRemoteInfo {
  const url = rawUrl ? stripUrlCredentials(rawUrl) : '';
  const base = url ? commitBaseOf(url) : null;
  return {
    url,
    display: base?.display ?? '',
    platform: base?.platform ?? null,
    commitBase: base?.commitBase ?? null,
    noRemote: !rawUrl,
  };
}

export type GitLinkSource = 'agent' | 'manual' | 'ci';
export const GIT_LINK_SOURCES: GitLinkSource[] = ['agent', 'manual', 'ci'];

export interface GitLinkRow {
  id: string;
  taskId: string;
  sha: string;
  shortSha: string;
  workspacePath: string;
  source: GitLinkSource;
  createdAt: string;
}

export interface TaskRef {
  id: string;
  taskNo: string | null;
  projectId: string;
  status: string;
  updatedAt: string;
  /** 项目当前工作空间（解析口径的唯一来源），空串 = 未绑定 */
  workspacePath: string;
}

/** 7–40 位十六进制；服务端负责把短 SHA resolve 成 40 位 */
export function normalizeShaInput(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) return null;
  return s;
}

/** 按 taskNo 或 id 定位任务（未归档）；找不到返回 null */
export function resolveTask(ref: { taskNo?: string; id?: string }): TaskRef | null {
  const db = getDb();
  const row = ref.id
    ? db.prepare('SELECT id, task_no, project_id, status, updated_at FROM tasks WHERE id = ? AND archived = 0').get(ref.id)
    : db.prepare('SELECT id, task_no, project_id, status, updated_at FROM tasks WHERE task_no = ? AND archived = 0').get(String(ref.taskNo ?? '').trim());
  if (!row) return null;
  const r = row as { id: string; task_no: string | null; project_id: string; status: string; updated_at: string };
  const proj = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(r.project_id) as { workspace_path: string | null } | undefined;
  return {
    id: r.id,
    taskNo: r.task_no,
    projectId: r.project_id,
    status: r.status,
    updatedAt: r.updated_at,
    workspacePath: (proj?.workspace_path ?? '').trim(),
  };
}

/** 解析成 40 位 commit SHA；仓库里不存在时返回 null（调用方计入 errors/missing，不抛错） */
export async function resolveCommitSha(cwd: string, input: string, opts: GitCollectOptions = {}): Promise<string | null> {
  try {
    const r = await runGitReadonly('rev-parse', ['--verify', '--quiet'], [`${input}^{commit}`], cwd, opts);
    const sha = r.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function writeGitLinkEvent(task: TaskRef, op: 'link' | 'unlink', sha: string, source: GitLinkSource): void {
  getDb()
    .prepare('INSERT INTO task_events (id, task_id, task_no, project_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), task.id, task.taskNo, task.projectId, 'git_link', `op=${op} sha=${sha} source=${source}`, new Date().toISOString());
}

export interface LinkCommitsResult {
  linked: number;
  skipped: number;
  resolved: { input: string; sha: string }[];
  errors: string[];
}

/**
 * 写入关联（AI 回写与手动绑定共用同一实现，只有 `source` 不同）。
 *
 * 降级不是失败而是结果的一部分：任务不存在/未绑定工作空间/非仓库都进 `errors` 并点名原因，
 * 调用方（MCP 工具与 REST）据此给可操作提示，而不是抛一个 500。
 */
export async function linkCommits(
  ref: { taskNo?: string; id?: string },
  commits: string | string[],
  source: GitLinkSource,
): Promise<LinkCommitsResult> {
  const out: LinkCommitsResult = { linked: 0, skipped: 0, resolved: [], errors: [] };
  const task = resolveTask(ref);
  if (!task) {
    out.errors.push(`任务不存在或已归档：${ref.taskNo ?? ref.id ?? '(空引用)'}`);
    return out;
  }
  if (!task.workspacePath) {
    out.errors.push(`项目未绑定工作空间，无法解析提交：请先在项目上绑定仓库目录（任务 ${task.taskNo ?? task.id}）`);
    return out;
  }
  const list = (Array.isArray(commits) ? commits : [commits]).filter((c) => String(c ?? '').trim() !== '');
  if (!list.length) {
    out.errors.push('commits 为空：请传 1 个或多个 commit ID（7–40 位十六进制）');
    return out;
  }
  const db = getDb();
  const now = () => new Date().toISOString();
  for (const raw of list) {
    const input = normalizeShaInput(raw);
    if (!input) {
      out.errors.push(`非法 commit ID「${String(raw).slice(0, 60)}」（需 7–40 位十六进制）`);
      continue;
    }
    const sha = await resolveCommitSha(task.workspacePath, input);
    if (!sha) {
      out.errors.push(`提交 ${input} 不在当前仓库（工作空间 ${task.workspacePath}）：项目换绑或未 fetch 时请在正确仓库中重新回写`);
      continue;
    }
    out.resolved.push({ input: String(raw), sha });
    const exists = db.prepare('SELECT id, source FROM task_git_links WHERE task_id = ? AND sha = ?').get(task.id, sha) as { id: string; source: string } | undefined;
    if (exists) {
      out.skipped += 1;
      continue;
    }
    db.prepare('INSERT INTO task_git_links (id, task_id, sha, workspace_path, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), task.id, sha, task.workspacePath, source, now());
    writeGitLinkEvent(task, 'link', sha, source);
    out.linked += 1;
  }
  if (out.linked) notifyChange('tasks');
  return out;
}

export function listLinks(taskId: string): GitLinkRow[] {
  const rows = getDb()
    .prepare('SELECT id, task_id, sha, workspace_path, source, created_at FROM task_git_links WHERE task_id = ? ORDER BY created_at DESC')
    .all(taskId) as { id: string; task_id: string; sha: string; workspace_path: string; source: string; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    sha: r.sha,
    shortSha: shortShaOf(r.sha),
    workspacePath: r.workspace_path,
    source: (r.source as GitLinkSource) ?? 'agent',
    createdAt: r.created_at,
  }));
}

/**
 * 一批任务的关联（列表页内联 `gitLinks` 用，一次查询、零逐行 SQL）。
 *
 * 契约：每项只回**最新一条**（§3.1.6）；多条时的 `+N` 由 `counts` 承载，避免前端再发请求。
 */
export function listLatestLinksByTask(taskIds: string[]): Map<string, { link: GitLinkRow; count: number }> {
  const out = new Map<string, { link: GitLinkRow; count: number }>();
  if (!taskIds.length) return out;
  const db = getDb();
  const marks = taskIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, task_id, sha, workspace_path, source, created_at FROM task_git_links WHERE task_id IN (${marks}) ORDER BY created_at DESC, rowid DESC`)
    .all(...taskIds) as { id: string; task_id: string; sha: string; workspace_path: string; source: string; created_at: string }[];
  for (const r of rows) {
    const link: GitLinkRow = {
      id: r.id,
      taskId: r.task_id,
      sha: r.sha,
      shortSha: shortShaOf(r.sha),
      workspacePath: r.workspace_path,
      source: (r.source as GitLinkSource) ?? 'agent',
      createdAt: r.created_at,
    };
    const prev = out.get(r.task_id);
    if (prev) prev.count += 1;
    else out.set(r.task_id, { link, count: 1 });
  }
  return out;
}

export class GitLinkError extends Error {
  readonly httpStatus: number;
  readonly kind?: GitErrorKind;

  constructor(httpStatus: number, message: string, kind?: GitErrorKind) {
    super(message);
    this.name = 'GitLinkError';
    this.httpStatus = httpStatus;
    this.kind = kind;
  }
}

/** 解绑：仅 `manual` 可解（AI 回写是主通道事实记录，不允许在 UI 上抹掉） */
export function unlinkCommit(taskRef: { taskNo?: string; id?: string }, shaInput: string): { ok: true } {
  const task = resolveTask(taskRef);
  if (!task) throw new GitLinkError(404, `任务不存在或已归档：${taskRef.taskNo ?? taskRef.id ?? ''}`);
  const sha = normalizeShaInput(shaInput);
  if (!sha) throw new GitLinkError(400, '非法 commit ID（需 7–40 位十六进制）');
  const db = getDb();
  const row = db.prepare('SELECT id, sha, source FROM task_git_links WHERE task_id = ? AND (sha = ? OR sha LIKE ?)').get(task.id, sha, `${sha}%`) as { id: string; sha: string; source: string } | undefined;
  if (!row) throw new GitLinkError(404, `该任务没有关联提交 ${sha}`);
  if (row.source !== 'manual') {
    throw new GitLinkError(409, `提交 ${row.sha.slice(0, 7)} 来源为 ${row.source}，仅手动绑定（manual）可解绑；AI 回写的关联请在提交侧修正后重新回写`);
  }
  db.prepare('DELETE FROM task_git_links WHERE id = ?').run(row.id);
  writeGitLinkEvent(task, 'unlink', row.sha, 'manual');
  notifyChange('tasks');
  return { ok: true };
}

export interface GitCommitCard extends CommitSummaryRow {
  source: GitLinkSource;
  linkedAt: string;
  /** 「已更改 N 个文件, N 行插入(+) / N 行删除(-)」的原料 */
  stats: { files: number; additions: number | null; deletions: number | null };
  isInitial: boolean;
  /** 提交时刻晚于任务 updated_at（§3.2.2，仅提示不改状态） */
  laterThanTask: boolean;
  /** 审计快照与项目当前工作空间不一致（换绑），摘要仍能解析时给出提示 */
  workspaceDrift: boolean;
  /** 提交外链（平台可识别时才有；已剥离凭据） */
  commitUrl?: string;
}

export interface GitTaskView {
  commits: GitCommitCard[];
  degraded?: { kind: GitErrorKind | 'no-workspace'; message: string };
  /** 请求的 SHA 里在当前仓库解析不出来的（换绑后的旧链接） */
  missing: string[];
  remote?: GitRemoteInfo;
}

/**
 * 抽屉首屏逐提交取文件统计的并发上限（T03642）：每条关联 2 个 git 进程。
 * 本机实测 10 条关联：串行 12 波等待 ≈ 数十秒；并发 4 → 11.2s；并发 8 → 5.0s。
 * 再往上收益被单进程启动（0.3–2s）吃掉，且同时拉太多进程会互相拖慢，故定 8。
 */
const GIT_FILES_CONCURRENCY = 8;

/** 抽屉首屏：提交卡（摘要 + 统计），文件清单不在此处（懒加载端点） */
export async function buildTaskGitView(taskRef: { taskNo?: string; id?: string }, opts: GitCollectOptions = {}): Promise<GitTaskView> {
  const task = resolveTask(taskRef);
  if (!task) throw new GitLinkError(404, `任务不存在或已归档：${taskRef.taskNo ?? taskRef.id ?? ''}`);
  const links = listLinks(task.id);
  if (!task.workspacePath) {
    return { commits: [], missing: [], degraded: { kind: 'no-workspace', message: '项目未绑定工作空间，请先绑定仓库目录' } };
  }
  try {
    // T03642：摘要与 origin 远端互不依赖，必须并发——单次 git 调用要付 0.3–1.5s 进程启动成本，
    // 串行 await 会让抽屉首屏白等两轮。文件统计按上限并发（git 进程数同样有代价，不无限铺开）。
    const [{ commits, missing }, remoteUrl] = await Promise.all([
      collectCommitSummaries(task.workspacePath, links.map((l) => l.sha), opts),
      safeRemoteUrl(task.workspacePath, opts),
    ]);
    const bySha = new Map(commits.map((c) => [c.sha, c]));
    // 外链前缀按 workspace 取一次 remote（§3.1.3：凭据在服务端剥离，前端只拼 SHA）
    const remote = remoteInfoOf(remoteUrl);
    const cards: GitCommitCard[] = [];
    const filesBySha = await mapLimit(links, GIT_FILES_CONCURRENCY, async (l) => {
      const c = bySha.get(l.sha);
      if (!c) return [];
      try {
        return await collectCommitFilesCached(task.workspacePath, l.sha, c.parents, opts);
      } catch (e) {
        if (e instanceof GitCollectError && ['no-git', 'not-a-repo', 'timeout', 'too-large'].includes(e.kind)) throw e;
        return [];
      }
    });
    links.forEach((l, i) => {
      const c = bySha.get(l.sha);
      if (!c) return;
      const files = filesBySha[i] ?? [];
      cards.push({
        ...c,
        source: l.source,
        linkedAt: l.createdAt,
        stats: {
          files: files.length,
          additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
          deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
        },
        isInitial: c.parents.length === 0,
        laterThanTask: !!c.date && !!task.updatedAt && new Date(c.date).getTime() > new Date(task.updatedAt).getTime(),
        workspaceDrift: !!l.workspacePath && l.workspacePath !== task.workspacePath,
        commitUrl: remoteUrl ? buildCommitLink(remoteUrl, l.sha)?.url : undefined,
      });
    });
    return { commits: cards, missing, remote };
  } catch (e) {
    if (e instanceof GitCollectError) {
      return { commits: [], missing: links.map((l) => l.sha), degraded: { kind: e.kind, message: e.message } };
    }
    throw e;
  }
}

/**
 * T03642：origin 远端的进程级缓存。每次 git 调用都要付一次进程启动成本（本机实测 0.3–1.5s），
 * 而 origin 是人工配置、一年也改不了几次——抽屉首屏与列表摘要却每轮都要 spawn 一次 `remote get-url`。
 * 键=工作空间路径（换绑即换键），5 分钟过期兜底；null 也缓存（无远端仓库同样不该反复探测），
 * 代价是用户「刚补上 origin」后最多 5 分钟内仍显示未配置，可在抽屉刷新里重试。
 */
const REMOTE_URL_TTL_MS = 5 * 60_000;
const remoteUrlCache = new Map<string, { at: number; url: string | null }>();
const remoteUrlInflight = new Map<string, Promise<string | null>>();

/** origin 远端；无远端不抛错（外链只是抽屉里的一个动作，不该拖垮首屏） */
export async function safeRemoteUrl(cwd: string, opts: GitCollectOptions = {}): Promise<string | null> {
  const hit = remoteUrlCache.get(cwd);
  if (hit && Date.now() - hit.at < REMOTE_URL_TTL_MS) return hit.url;
  const pending = remoteUrlInflight.get(cwd);
  if (pending) return pending;
  const p = (async () => {
    try {
      return await collectRemoteUrl(cwd, opts);
    } catch (e) {
      if (e instanceof GitCollectError) return null;
      throw e;
    }
  })().then(
    (url) => { remoteUrlCache.set(cwd, { at: Date.now(), url }); remoteUrlInflight.delete(cwd); return url; },
    (e) => { remoteUrlInflight.delete(cwd); throw e; },
  );
  remoteUrlInflight.set(cwd, p);
  return p;
}

/**
 * T03642：提交文件清单缓存。同一提交的 numstat/name-status 是**不可变**数据（SHA 决定内容），
 * 而抽屉首屏与文件页会对同一 SHA 各取一次、每次两条 git 进程。键含 base（首提交用空树），
 * 5 分钟过期只是防止内存无界增长，不影响正确性。
 */
const COMMIT_FILES_TTL_MS = 5 * 60_000;
const commitFilesCache = new Map<string, { at: number; files: CommitFileEntry[] }>();

async function collectCommitFilesCached(cwd: string, sha: string, parents: string[], opts: GitCollectOptions): Promise<CommitFileEntry[]> {
  const base = parents.length ? parents[0] : GIT_EMPTY_TREE_SHA1;
  const key = `${cwd}|${base}|${sha}`;
  const hit = commitFilesCache.get(key);
  if (hit && Date.now() - hit.at < COMMIT_FILES_TTL_MS) return hit.files;
  const files = await collectCommitFiles(cwd, sha, parents, opts);
  commitFilesCache.set(key, { at: Date.now(), files });
  return files;
}

/**
 * 有上限的并发映射（T03642）：结果按下标对齐，任一任务抛错即整体失败（与原串行语义一致）。
 * 用途是把「每条关联一次 git spawn」的串行等待压成常数轮，同时避免 N 条关联同时拉起 N 个进程。
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface GitFilesResult {
  files: CommitFileEntry[];
  truncated?: boolean;
  /** `?diff=1` 时逐文件附结构化 hunk（与讲稿面板同一 `LectureDiffHunk` 形态，共享 DiffView 渲染） */
  diffs?: Record<string, { hunks: GitHunk[]; truncated: boolean }>;
  /** 请求的 SHA 在当前仓库解析不出来（工作空间换绑后的旧链接） */
  missing?: string[];
  degraded?: { kind: GitErrorKind | 'no-workspace'; message: string };
}

/** 文件清单 / 差异懒加载（§4.2）：一次请求只解析一个提交 */
export async function buildTaskGitFiles(
  taskRef: { taskNo?: string; id?: string },
  shaInput: string,
  withDiff: boolean,
  opts: GitCollectOptions = {},
): Promise<GitFilesResult> {
  const task = resolveTask(taskRef);
  if (!task) throw new GitLinkError(404, `任务不存在或已归档：${taskRef.taskNo ?? taskRef.id ?? ''}`);
  if (!task.workspacePath) return { files: [], degraded: { kind: 'no-workspace', message: '项目未绑定工作空间，请先绑定仓库目录' } };
  const sha = normalizeShaInput(shaInput);
  if (!sha) throw new GitLinkError(400, '非法 commit ID（需 7–40 位十六进制）');
  const full = await resolveCommitSha(task.workspacePath, sha, opts);
  if (!full) return { files: [], missing: [sha], degraded: { kind: 'failed', message: `提交 ${sha} 已不在当前仓库（工作空间换绑或未 fetch）` } };
  const link = getDb().prepare('SELECT id FROM task_git_links WHERE task_id = ? AND sha = ?').get(task.id, full);
  if (!link) throw new GitLinkError(404, `该任务没有关联提交 ${sha.slice(0, 7)}`);
  try {
    const { commits } = await collectCommitSummaries(task.workspacePath, [full], opts);
    const head = commits[0];
    const files = await collectCommitFilesCached(task.workspacePath, full, head?.parents ?? [], opts);
    const out: GitFilesResult = { files };
    if (withDiff) {
      out.diffs = {};
      for (const f of files) {
        if (f.binary) continue;
        // 首提交没有父提交：基线取空树，diff 才能给出「全量新增」而不是报错（§3.2.1）
        const base = head?.parents?.length ? head.parents[0] : GIT_EMPTY_TREE_SHA1;
        try {
          const raw = await collectDiffTracked(task.workspacePath, [base, full], f.path, opts);
          // 结构化 hunk 下发（行首保留 diff 前缀），渲染口径与讲稿面板一致
          const hunks = parseUnifiedDiff(raw.text).flatMap((c) => c.hunks);
          out.diffs[f.path] = { hunks, truncated: raw.truncated };
        } catch {
          out.diffs[f.path] = { hunks: [], truncated: false };
        }
      }
    }
    return out;
  } catch (e) {
    if (e instanceof GitCollectError) return { files: [], degraded: { kind: e.kind, message: e.message } };
    throw e;
  }
}

async function collectDiffTracked(
  cwd: string,
  range: string[],
  relPath: string,
  opts: GitCollectOptions,
): Promise<{ text: string; truncated: boolean }> {
  const rel = assertSafeRepoPath(relPath);
  const r = await runGitReadonly('diff', ['--ignore-cr-at-eol', '-U3'], [...range, '--', rel], cwd, opts);
  const t = truncateDiffText(r.stdout, GIT_DIFF_TEXT_LIMIT);
  return { text: t.text, truncated: t.truncated };
}

/** 单页唯一 SHA 上限（§4.4 规模）；超限截断并回 truncated=true */
export const GIT_SUMMARY_MAX_SHA_PER_PAGE = 200;

export interface SummaryGroup {
  workspacePath: string;
  available: boolean;
  kind?: GitErrorKind | 'no-workspace';
  message?: string;
  commits: CommitSummaryRow[];
  missing: string[];
  truncated: boolean;
  /** 该 workspace 的外链信息（每 workspace 只取一次 remote，页内零逐行请求） */
  remote?: GitRemoteInfo;
}

/**
 * 本页提交摘要批量解析（§3.1.6）：按 workspace 分组，每组**一次** `git log --no-walk`。
 * 前端传「本页唯一 SHA 集合」，这里保证页内零逐行请求。
 */
export async function buildSummaryGroups(
  links: { taskId?: string; sha: string }[],
  opts: GitCollectOptions = {},
): Promise<{ groups: SummaryGroup[] }> {
  const byWorkspace = new Map<string, string[]>();
  for (const l of links) {
    const sha = normalizeShaInput(l.sha);
    if (!sha) continue;
    const task = l.taskId ? resolveTask({ id: l.taskId }) : null;
    const ws = task?.workspacePath || '';
    const arr = byWorkspace.get(ws) ?? [];
    if (!arr.includes(sha)) arr.push(sha);
    byWorkspace.set(ws, arr);
  }
  const groups: SummaryGroup[] = [];
  for (const [ws, shas] of byWorkspace) {
    if (!ws) {
      groups.push({ workspacePath: '', available: false, kind: 'no-workspace', commits: [], missing: shas, truncated: false });
      continue;
    }
    const capped = shas.slice(0, GIT_SUMMARY_MAX_SHA_PER_PAGE);
    try {
      const { commits, missing } = await collectCommitSummaries(ws, capped, opts);
      groups.push({
        workspacePath: ws,
        available: true,
        commits,
        // 被截断掉的 SHA 不发起解析，直接计入 missing（前端页脚据此提示「本页部分提交摘要未解析」）
        missing: [...missing, ...shas.slice(capped.length)],
        truncated: capped.length < shas.length,
        remote: remoteInfoOf(await safeRemoteUrl(ws, opts)),
      });
    } catch (e) {
      const kind = e instanceof GitCollectError ? e.kind : 'failed';
      const message = e instanceof GitCollectError ? e.message : String(e);
      groups.push({ workspacePath: ws, available: false, kind, message, commits: [], missing: shas, truncated: false });
    }
  }
  return { groups };
}

/** 列表页内联（T03361）：给一页任务附加 gitLinks（最新一条）与 gitLinkCount（「+N」角标） */
export function attachGitLinks<T extends { id: string }>(
  items: T[],
): (T & { gitLinks: { sha: string; shortSha: string; source: GitLinkSource; createdAt: string }[]; gitLinkCount: number })[] {
  const byTask = listLatestLinksByTask(items.map((i) => i.id));
  return items.map((i) => {
    const hit = byTask.get(i.id);
    return {
      ...i,
      gitLinks: hit ? [{ sha: hit.link.sha, shortSha: hit.link.shortSha, source: hit.link.source, createdAt: hit.link.createdAt }] : [],
      gitLinkCount: hit?.count ?? 0,
    };
  });
}

/** 关联写入的 REST 入口（手动绑定）：与 MCP 同一实现，仅 source 不同 */
export async function manualLink(taskRef: { taskNo?: string; id?: string }, sha: string): Promise<{ ok: true; link: GitLinkRow }> {
  const res = await linkCommits(taskRef, [sha], 'manual');
  if (res.errors.length && !res.linked && !res.skipped) throw new GitLinkError(400, res.errors.join('；'));
  const task = resolveTask(taskRef);
  const normalized = normalizeShaInput(sha);
  const found = task && normalized ? listLinks(task.id).find((l) => l.sha.startsWith(normalized)) : undefined;
  if (!found) throw new GitLinkError(404, `未能定位到关联记录：${sha}`);
  return { ok: true, link: found };
}
