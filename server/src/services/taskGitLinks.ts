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
  collectCommitFilesBatch,
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
    const filesByIdx = await collectLinkedCommitFiles(task.workspacePath, links, bySha, opts);
    links.forEach((l, i) => {
      const c = bySha.get(l.sha);
      if (!c) return;
      const files = filesByIdx[i] ?? [];
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

/** 首屏整体失败的三种归因：仓库根本取不了数，逐条重试也一样，直接向上转 degraded */
const FATAL_BATCH_KINDS: GitErrorKind[] = ['no-git', 'not-a-repo', 'timeout'];
const isFatalKind = (e: unknown) => e instanceof GitCollectError && FATAL_BATCH_KINDS.includes(e.kind);

/**
 * 抽屉首屏的文件统计取数（T03650）：**一次** `git log --no-walk -m --first-parent --raw --numstat`
 * 取回 N 个提交的状态与增删行数，替掉 T03642 之前「每提交两条 `git diff`」（N 条关联 = 2N 次 spawn）。
 *
 * - 只点名「摘要里解析得出来」的 SHA：换绑后已不在仓库的旧 SHA 会让整条 log 非零退出，
 *   而它们本来就该是空统计 + 进 `missing`，不该把首屏拖进回退路径。
 * - 已在 `commitFilesCache` 里的提交不进批量（T03642 的缓存收益要保住：热路径上文件统计的
 *   spawn 数是 0，而不是每轮补一发 log）；批量结果同样写回该缓存，文件页复用同一份数据。
 * - 失败回退到逐提交并发路径（T03642 的实现原样保留）：`too-large` 也回退——
 *   批量一次要吐 N 个提交的全部条目，缓冲区上限先撞在它上面不代表单提交也放不下；
 *   `no-git` / `not-a-repo` / `timeout` 三种整体失败则照旧向上抛，转成 degraded。
 *   逐提交路径内部沿用改造前的分流语义（致命上抛、其它错误该格留空）。
 *
 * 返回按 `links` 下标对齐的数组，卡片组装按下标取，不做二次 SHA 查找。
 */
async function collectLinkedCommitFiles(
  cwd: string,
  links: GitLinkRow[],
  bySha: Map<string, CommitSummaryRow>,
  opts: GitCollectOptions,
): Promise<CommitFileEntry[][]> {
  const cachedByIdx = new Map<number, CommitFileEntry[]>();
  const pending: string[] = [];
  links.forEach((l, i) => {
    const c = bySha.get(l.sha);
    if (!c) return;
    const cached = readCommitFilesCache(cwd, l.sha, c.parents);
    if (cached) cachedByIdx.set(i, cached);
    else pending.push(l.sha);
  });
  if (!pending.length) return links.map((_, i) => cachedByIdx.get(i) ?? []);
  try {
    const batch = await collectCommitFilesBatch(cwd, pending, opts);
    seedCommitFilesCache(cwd, bySha, batch);
    return links.map((l, i) => cachedByIdx.get(i) ?? batch.get(l.sha) ?? []);
  } catch (e) {
    if (isFatalKind(e)) throw e;
  }
  return mapLimit(links, GIT_FILES_CONCURRENCY, async (l) => {
    const c = bySha.get(l.sha);
    if (!c) return [];
    try {
      return await collectCommitFilesCached(cwd, l.sha, c.parents, opts);
    } catch (e) {
      if (e instanceof GitCollectError && ['no-git', 'not-a-repo', 'timeout', 'too-large'].includes(e.kind)) throw e;
      return [];
    }
  });
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

/** 缓存键含 base（首提交用空树），与单提交取数用的基线一致 */
const commitFilesKey = (cwd: string, sha: string, parents: string[]) =>
  `${cwd}|${parents.length ? parents[0] : GIT_EMPTY_TREE_SHA1}|${sha}`;

/** 读缓存：未命中或已过期返回 null（单提交路径与批量路径共用同一份时效口径） */
function readCommitFilesCache(cwd: string, sha: string, parents: string[]): CommitFileEntry[] | null {
  const hit = commitFilesCache.get(commitFilesKey(cwd, sha, parents));
  return hit && Date.now() - hit.at < COMMIT_FILES_TTL_MS ? hit.files : null;
}

async function collectCommitFilesCached(cwd: string, sha: string, parents: string[], opts: GitCollectOptions): Promise<CommitFileEntry[]> {
  const cached = readCommitFilesCache(cwd, sha, parents);
  if (cached) return cached;
  const key = commitFilesKey(cwd, sha, parents);
  const files = await collectCommitFiles(cwd, sha, parents, opts);
  commitFilesCache.set(key, { at: Date.now(), files });
  return files;
}

/**
 * T03650：批量取数结果写回单提交缓存，让「文件页」复用首屏那一次 `git log` 的成果——
 * 抽屉里点开某个提交时命中原键，不再补发 `git diff`。
 * 只写批量真正返回到的 SHA：批量缺失（如某提交不在仓库）时保留「未缓存」状态，
 * 由单提交路径去判定并如实报错，不能在这里塞一个空清单把缺失误诊为「无改动」。
 */
function seedCommitFilesCache(cwd: string, bySha: Map<string, CommitSummaryRow>, batch: Map<string, CommitFileEntry[]>) {
  const at = Date.now();
  for (const [sha, files] of batch) {
    const c = bySha.get(sha);
    if (!c) continue;
    commitFilesCache.set(commitFilesKey(cwd, sha, c.parents), { at, files });
  }
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

/**
 * T03625：单页上限按「本次取数自己的实测成本」自适应，而不是靠 rev-parse 探针猜。
 * 探针为什么不行：4 路 `git log -n 200` 负载下 rev-parse 只读到 286ms（起进程很便宜），
 * 同窗口的 200 SHA 整页却要 2.7–11.7s——它测的是 spawn 速度，不是 git 解析负载，
 * 于是最该降档的时候反而判成空闲。改成每次整页取数后回填实测 ms/条，下一次据此定上限。
 */
export const GIT_SUMMARY_BUDGET_MS = 1_200;
export const GIT_SUMMARY_MIN_SHA_PER_PAGE = 20;
export const GIT_SUMMARY_COLD_SHA_PER_PAGE = 60;
const SUMMARY_COST_TTL_MS = 10 * 60_000;

const summaryCost = new Map<string, { msPerSha: number; at: number }>();

export function clearSummaryCostCache(): void {
  summaryCost.clear();
}

/** 整页取数结束后回填实测成本（EWMA；超过 TTL 的旧样本不再参与） */
export function recordSummaryCost(workspacePath: string, shaCount: number, elapsedMs: number): void {
  if (!workspacePath || shaCount <= 0) return;
  const sample = elapsedMs / shaCount;
  const prev = summaryCost.get(workspacePath);
  const msPerSha = prev && Date.now() - prev.at < SUMMARY_COST_TTL_MS ? prev.msPerSha * 0.6 + sample * 0.4 : sample;
  summaryCost.set(workspacePath, { msPerSha, at: Date.now() });
}

/** 成本 → 上限：按 1.2s 预算反推；冷启动（无历史）先给 60 条兜底，上下夹在 [20, 200] */
export function summaryCapForCost(msPerSha: number | null): number {
  if (msPerSha === null || !(msPerSha > 0)) return GIT_SUMMARY_COLD_SHA_PER_PAGE;
  const fit = Math.floor(GIT_SUMMARY_BUDGET_MS / msPerSha);
  return Math.max(GIT_SUMMARY_MIN_SHA_PER_PAGE, Math.min(GIT_SUMMARY_MAX_SHA_PER_PAGE, fit));
}

export function resolveSummaryCapFor(workspacePath: string, shaCount: number): number {
  const prev = summaryCost.get(workspacePath);
  const msPerSha = prev && Date.now() - prev.at < SUMMARY_COST_TTL_MS ? prev.msPerSha : null;
  return Math.max(1, Math.min(shaCount, summaryCapForCost(msPerSha)));
}

/**
 * 一页摘要的唯一取数入口：定上限 → 取数 → 回填成本。
 * 上限只决定「这次解析多少条」，被截掉的部分由调用方计入 missing（前端据此提示未解析）。
 */
export async function collectSummaryPage(
  workspacePath: string,
  shas: string[],
  opts: GitCollectOptions = {},
): Promise<{ commits: CommitSummaryRow[]; missing: string[]; capped: string[] }> {
  const capped = shas.slice(0, resolveSummaryCapFor(workspacePath, shas.length));
  const t0 = Date.now();
  const { commits, missing } = await collectCommitSummaries(workspacePath, capped, opts);
  recordSummaryCost(workspacePath, capped.length, Date.now() - t0);
  return { commits, missing, capped };
}

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
    try {
      const page = await collectSummaryPage(ws, shas, opts);
      groups.push({
        workspacePath: ws,
        available: true,
        commits: page.commits,
        // 被截断掉的 SHA 不发起解析，直接计入 missing（前端页脚据此提示「本页部分提交摘要未解析」）
        missing: [...page.missing, ...shas.slice(page.capped.length)],
        truncated: page.capped.length < shas.length,
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
