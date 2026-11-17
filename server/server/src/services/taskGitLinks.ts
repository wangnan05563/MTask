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
  clearSummaryMetaCache,
  collectCommitFiles,
  collectCommitFilesBatch,
  collectCommitSummaries,
  collectRemoteUrl,
  isCacheableGitCall,
  parseUnifiedDiff,
  peekSummaryCache,
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
import { scalarText } from '../util/scalarText';
import { isRepositoryRoot, resolveRepoSubPath } from './nestedRepos';

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
  /** T04576：工作空间目录内的仓库（相对 POSIX 路径；空串 = 项目根仓库） */
  repoSub: string;
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
  // scalarText 而不是 String()：标量（如数字入参）仍按原语义转成文本再做形状校验，
  // 对象/函数则给空串（形状校验必然不通过 → null），不会拼出 "[object Object]" 去 resolve
  const s = scalarText(raw).trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) return null;
  return s;
}

/** T04576：仓库相对路径归一——`.` 与空串都表示项目根仓库（既有行的语义） */
export function normalizeRepoSub(raw: unknown): string {
  const s = scalarText(raw).trim();
  return s === '.' ? '' : s;
}

/** 仓库维度的展示名（错误文案与清单标注共用同一口径） */
export function repoLabelOf(repoSub: string): string {
  return repoSub ? `仓库 ${repoSub}` : '项目根仓库';
}

/**
 * 关联行解析 SHA 的 cwd：空 = 项目根；非空 = 工作空间目录内的独立仓库。
 *
 * 非空 `repoSub` 必须按 `.git` 实体核（与 `GET /git/log` 同口径）：只靠
 * `--is-inside-work-tree` 会让根仓库工作树内的普通目录（如 `docs/`）冒充子仓库，
 * 于是子仓库的 SHA 被静默解析成根仓库的提交——这比 missing 更难查。
 */
export async function resolveLinkCwd(task: TaskRef, repoSubInput: unknown): Promise<{ cwd: string; repoSub: string } | { error: string; repoSub: string }> {
  const repoSub = normalizeRepoSub(repoSubInput);
  if (!repoSub) return { cwd: task.workspacePath, repoSub };
  let cwd: string;
  try {
    cwd = resolveRepoSubPath(task.workspacePath, repoSub);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), repoSub };
  }
  if (!(await isRepositoryRoot(cwd))) return { error: `${repoSub} 不是一个 Git 仓库（该目录下没有 .git）`, repoSub };
  return { cwd, repoSub };
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

/**
 * M3-b（#45 裁定）：SHA 解析的进程级缓存。
 * 提交对象是内容地址，`<40 位 SHA>^{commit}` 的解析结果永不改变；而文件页每次请求都要先付一发
 * `rev-parse`（本机实测 ≈119ms），压测里同一个 URL 会被反复打到。
 * 只缓存「输入本身是十六进制 SHA」的解析结果——分支名/标签随时会移动，必须每次现查；
 * 解析失败不缓存（`git fetch` 之后应当立刻可见），null 也不进缓存。
 */
const REV_PARSE_CACHE_MAX = 2000;
const revParseCache = new Map<string, string>();
const revParseInflight = new Map<string, Promise<string | null>>();

const revParseKey = (cwd: string, input: string) => `${cwd}|${input.toLowerCase()}`;

const isHexSha = (input: string) => /^[0-9a-f]{7,40}$/.test(input);

/** 解析成 40 位 commit SHA；仓库里不存在时返回 null（调用方计入 errors/missing，不抛错） */
export async function resolveCommitSha(cwd: string, input: string, opts: GitCollectOptions = {}): Promise<string | null> {
  const cacheable = isCacheableGitCall(opts) && isHexSha(input);
  const key = revParseKey(cwd, input);
  if (cacheable) {
    const hit = revParseCache.get(key);
    if (hit) {
      revParseCache.delete(key);
      revParseCache.set(key, hit);
      return hit;
    }
    // 同一 SHA 的并发请求合流（与 runGitReadonly 的合流同口径，不引入排队）
    const running = revParseInflight.get(key);
    if (running) return running;
  }
  const resolved: Promise<string | null> = (async () => {
    try {
      const r = await runGitReadonly('rev-parse', ['--verify', '--quiet'], [`${input}^{commit}`], cwd, opts);
      const sha = r.stdout.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  })();
  if (!cacheable) return resolved;
  // 同键的下一条只可能在本条落地（即这里删掉登记）之后才建立，故删除无需比对归属
  const tracked = resolved.then((sha) => {
    revParseInflight.delete(key);
    if (sha) {
      revParseCache.delete(key);
      revParseCache.set(key, sha);
      if (revParseCache.size > REV_PARSE_CACHE_MAX) {
        const oldest = revParseCache.keys().next().value;
        if (oldest !== undefined) revParseCache.delete(oldest);
      }
    }
    return sha;
  });
  revParseInflight.set(key, tracked);
  return tracked;
}

function writeGitLinkEvent(task: TaskRef, op: 'link' | 'unlink', sha: string, source: GitLinkSource): void {
  getDb()
    .prepare('INSERT INTO task_events (id, task_id, task_no, project_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), task.id, task.taskNo, task.projectId, 'git_link', `op=${op} sha=${sha} source=${source}`, new Date().toISOString());
}

export interface LinkCommitsResult {
  linked: number;
  skipped: number;
  /** 本次写入的仓库维度（空串 = 项目根仓库） */
  repoSub: string;
  resolved: { input: string; sha: string; repoSub: string }[];
  errors: string[];
}

/**
 * 写入关联（AI 回写与手动绑定共用同一实现，只有 `source` 不同）。
 *
 * `repoSub`（T04576）：同一工作空间目录里的哪一个仓库；空串 = 项目根仓库，与改造前语义一致。
 * 关联的唯一键随之为 `(task_id, sha, repo_sub)`——同一 SHA 在两个仓库里是两条独立的事实记录。
 *
 * 降级不是失败而是结果的一部分：任务不存在/未绑定工作空间/非仓库都进 `errors` 并点名原因，
 * 调用方（MCP 工具与 REST）据此给可操作提示，而不是抛一个 500。
 */
export async function linkCommits(
  ref: { taskNo?: string; id?: string },
  commits: string | string[],
  source: GitLinkSource,
  repoSubInput: unknown = '',
): Promise<LinkCommitsResult> {
  const out: LinkCommitsResult = { linked: 0, skipped: 0, repoSub: normalizeRepoSub(repoSubInput), resolved: [], errors: [] };
  const task = resolveTask(ref);
  if (!task) {
    out.errors.push(`任务不存在或已归档：${ref.taskNo ?? ref.id ?? '(空引用)'}`);
    return out;
  }
  if (!task.workspacePath) {
    out.errors.push(`项目未绑定工作空间，无法解析提交：请先在项目上绑定仓库目录（任务 ${task.taskNo ?? task.id}）`);
    return out;
  }
  const target = await resolveLinkCwd(task, out.repoSub);
  if ('error' in target) {
    out.errors.push(`${repoLabelOf(out.repoSub)}不可用：${target.error}（任务 ${task.taskNo ?? task.id}）`);
    return out;
  }
  out.repoSub = target.repoSub;
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
    const sha = await resolveCommitSha(target.cwd, input);
    if (!sha) {
      out.errors.push(`提交 ${input} 不在${repoLabelOf(target.repoSub)}（${target.cwd}）：项目换绑、未 fetch 或选错仓库时请在正确仓库中重新回写`);
      continue;
    }
    out.resolved.push({ input: String(raw), sha, repoSub: target.repoSub });
    const exists = db.prepare('SELECT id, source FROM task_git_links WHERE task_id = ? AND sha = ? AND repo_sub = ?').get(task.id, sha, target.repoSub) as { id: string; source: string } | undefined;
    if (exists) {
      out.skipped += 1;
      continue;
    }
    db.prepare('INSERT INTO task_git_links (id, task_id, sha, repo_sub, workspace_path, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), task.id, sha, target.repoSub, task.workspacePath, source, now());
    writeGitLinkEvent(task, 'link', sha, source);
    out.linked += 1;
  }
  if (out.linked) notifyChange('tasks');
  return out;
}

export function listLinks(taskId: string): GitLinkRow[] {
  const rows = getDb()
    .prepare('SELECT id, task_id, sha, repo_sub, workspace_path, source, created_at FROM task_git_links WHERE task_id = ? ORDER BY created_at DESC')
    .all(taskId) as { id: string; task_id: string; sha: string; repo_sub: string; workspace_path: string; source: string; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    sha: r.sha,
    shortSha: shortShaOf(r.sha),
    repoSub: r.repo_sub ?? '',
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
    .prepare(`SELECT id, task_id, sha, repo_sub, workspace_path, source, created_at FROM task_git_links WHERE task_id IN (${marks}) ORDER BY created_at DESC, rowid DESC`)
    .all(...taskIds) as { id: string; task_id: string; sha: string; repo_sub: string; workspace_path: string; source: string; created_at: string }[];
  for (const r of rows) {
    const link: GitLinkRow = {
      id: r.id,
      taskId: r.task_id,
      sha: r.sha,
      shortSha: shortShaOf(r.sha),
      repoSub: r.repo_sub ?? '',
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

/**
 * 解绑：仅 `manual` 可解（AI 回写是主通道事实记录，不允许在 UI 上抹掉）。
 *
 * T04576：可按 `repoSub` 精确定位。未传时沿用既有口径（按 SHA 找），但如果同一 SHA 在
 * 多个仓库都有 manual 关联，拒绝猜——删错仓库的关联比多问一句更糟。
 */
export function unlinkCommit(taskRef: { taskNo?: string; id?: string }, shaInput: string, repoSubInput?: unknown): { ok: true } {
  const task = resolveTask(taskRef);
  if (!task) throw new GitLinkError(404, `任务不存在或已归档：${taskRef.taskNo ?? taskRef.id ?? ''}`);
  const sha = normalizeShaInput(shaInput);
  if (!sha) throw new GitLinkError(400, '非法 commit ID（需 7–40 位十六进制）');
  const db = getDb();
  const scope = repoSubInput === undefined ? '' : ' AND repo_sub = ?';
  const args = repoSubInput === undefined ? [task.id, sha, `${sha}%`] : [task.id, sha, `${sha}%`, normalizeRepoSub(repoSubInput)];
  const rows = db.prepare(`SELECT id, sha, repo_sub, source FROM task_git_links WHERE task_id = ? AND (sha = ? OR sha LIKE ?)${scope}`)
    .all(...args) as { id: string; sha: string; repo_sub: string; source: string }[];
  if (!rows.length) throw new GitLinkError(404, `该任务没有关联提交 ${sha}`);
  if (rows.length > 1) {
    const repos = [...new Set(rows.map((r) => r.repo_sub || '.'))].join('、');
    throw new GitLinkError(409, `提交 ${sha.slice(0, 7)} 在多个仓库有关联（${repos}），请指定 repoSub 后再解绑`);
  }
  const row = rows[0];
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
  /** T04576：该关联来自工作空间目录内的哪个仓库（空串 = 项目根仓库） */
  repoSub: string;
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
  /** 请求的 SHA 里在**各自仓库**解析不出来的（换绑后的旧链接 / 子仓库已移除） */
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
  // T04576：逐仓库分组取数——子仓库的 SHA 只在它自己的仓库里解析，不能被根仓库口径误判 missing。
  const byRepo = new Map<string, GitLinkRow[]>();
  for (const l of links) {
    const arr = byRepo.get(l.repoSub) ?? [];
    arr.push(l);
    byRepo.set(l.repoSub, arr);
  }
  const repos = [...byRepo.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  const cards: GitCommitCard[] = [];
  const missing: string[] = [];
  const addMissing = (sha: string) => { if (!missing.includes(sha)) missing.push(sha); };
  let degraded: GitTaskView['degraded'];
  let remote: GitRemoteInfo | undefined;
  for (const repoSub of repos) {
    const groupLinks = byRepo.get(repoSub)!;
    const target = await resolveLinkCwd(task, repoSub);
    if ('error' in target) {
      groupLinks.forEach((l) => addMissing(l.sha));
      if (repoSub === '') degraded ??= { kind: 'not-a-repo', message: target.error };
      continue;
    }
    try {
      // 摘要与 origin 远端互不依赖，必须并发（单次 git 调用要付 0.3–1.5s 进程启动成本）
      const [{ commits, missing: groupMissing }, remoteUrl] = await Promise.all([
        collectCommitSummaries(target.cwd, groupLinks.map((l) => l.sha), opts),
        safeRemoteUrl(target.cwd, opts),
      ]);
      // 顶层 remote 沿用根仓库口径；没有根仓库链接时退到第一个可用仓库
      if (!remote) remote = remoteInfoOf(remoteUrl);
      const bySha = new Map(commits.map((c) => [c.sha, c]));
      const filesByIdx = await collectLinkedCommitFiles(target.cwd, groupLinks, bySha, opts);
      groupMissing.forEach(addMissing);
      groupLinks.forEach((l, i) => {
        const c = bySha.get(l.sha);
        if (!c) {
          addMissing(l.sha);
          return;
        }
        const files = filesByIdx[i] ?? [];
        cards.push({
          ...c,
          source: l.source,
          linkedAt: l.createdAt,
          repoSub,
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
    } catch (e) {
      if (!(e instanceof GitCollectError)) throw e;
      // 根仓库整体失败维持既有降级口径；子仓库失败只把该组记为 missing，不牵连同任务其它仓库的卡片
      if (repoSub === '') degraded ??= { kind: e.kind, message: e.message };
      groupLinks.forEach((l) => addMissing(l.sha));
    }
  }
  // 链接表按 created_at DESC 取；分组后仍按关联时间倒序，与改造前卡片顺序一致
  cards.sort((a, b) => (a.linkedAt < b.linkedAt ? 1 : a.linkedAt > b.linkedAt ? -1 : 0));
  return { commits: cards, missing, remote, ...(degraded ? { degraded } : {}) };
}

/** 首屏整体失败的三种归因：仓库根本取不了数，逐条重试也一样，直接向上转 degraded */
const FATAL_BATCH_KINDS = new Set<GitErrorKind>(['no-git', 'not-a-repo', 'timeout']);
const isFatalKind = (e: unknown) => e instanceof GitCollectError && FATAL_BATCH_KINDS.has(e.kind);

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
 * 而抽屉首屏与文件页会对同一 SHA 各取一次、每次两条 git 进程。键含 base（首提交用空树）。
 * 内容不可变故不设 TTL，改按条数上限做 LRU 淘汰（命中刷新位置、写入超限丢最久未用），
 * 避免过期后对同一提交重复 spawn——这正是压测里 g_git_sha_files P95 8.9s 的主因。
 */
const COMMIT_FILES_CACHE_MAX = 2000;
const commitFilesCache = new Map<string, CommitFileEntry[]>();

/** 缓存键含 base（首提交用空树），与单提交取数用的基线一致 */
const commitFilesKey = (cwd: string, sha: string, parents: string[]) =>
  `${cwd}|${parents.length ? parents[0] : GIT_EMPTY_TREE_SHA1}|${sha}`;

/** 读缓存：未命中返回 null；命中即移到队尾（Map 迭代序即 LRU 序） */
function readCommitFilesCache(cwd: string, sha: string, parents: string[]): CommitFileEntry[] | null {
  const key = commitFilesKey(cwd, sha, parents);
  const hit = commitFilesCache.get(key);
  if (!hit) return null;
  commitFilesCache.delete(key);
  commitFilesCache.set(key, hit);
  return hit;
}

/** 写缓存：同一键覆盖（结果按 SHA 不可变，覆盖只可能是同值），超限淘汰最久未用的一条 */
function writeCommitFilesCache(key: string, files: CommitFileEntry[]) {
  commitFilesCache.delete(key);
  commitFilesCache.set(key, files);
  if (commitFilesCache.size > COMMIT_FILES_CACHE_MAX) {
    const oldest = commitFilesCache.keys().next().value;
    if (oldest !== undefined) commitFilesCache.delete(oldest);
  }
}

async function collectCommitFilesCached(cwd: string, sha: string, parents: string[], opts: GitCollectOptions): Promise<CommitFileEntry[]> {
  const cached = readCommitFilesCache(cwd, sha, parents);
  if (cached) return cached;
  const key = commitFilesKey(cwd, sha, parents);
  const files = await collectCommitFiles(cwd, sha, parents, opts);
  writeCommitFilesCache(key, files);
  return files;
}

/**
 * T03650：批量取数结果写回单提交缓存，让「文件页」复用首屏那一次 `git log` 的成果——
 * 抽屉里点开某个提交时命中原键，不再补发 `git diff`。
 * 只写批量真正返回到的 SHA：批量缺失（如某提交不在仓库）时保留「未缓存」状态，
 * 由单提交路径去判定并如实报错，不能在这里塞一个空清单把缺失误诊为「无改动」。
 */
function seedCommitFilesCache(cwd: string, bySha: Map<string, CommitSummaryRow>, batch: Map<string, CommitFileEntry[]>) {
  for (const [sha, files] of batch) {
    const c = bySha.get(sha);
    if (!c) continue;
    writeCommitFilesCache(commitFilesKey(cwd, sha, c.parents), files);
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

/**
 * M3-b（#45 裁定）：单文件 diff hunk 缓存。
 * `?diff=1` 的抽屉展开会对同一提交**逐文件**各 spawn 一发 diff（夹具实测：7 个文件 983ms，单发 ≈140ms），
 * 而 (仓库, 基线, 提交, 路径) 决定的正文按内容地址永不改变，所以长期缓存、按条数 LRU 淘汰。
 * 两条不缓存的边界：单条超过 256KB（大 diff 不该把内存顶满）、取数失败（瞬时错误不能粘住成空 hunk）。
 */
const DIFF_HUNKS_CACHE_MAX = 2000;
const DIFF_HUNKS_MAX_ENTRY_BYTES = 256 * 1024;
const diffHunksCache = new Map<string, { hunks: GitHunk[]; truncated: boolean }>();

/** 单个文件的 diff hunk；取不到就留空（个别路径的 diff 会失败，但清单本身仍要下发） */
async function diffHunksFor(
  cwd: string,
  range: string[],
  relPath: string,
  opts: GitCollectOptions,
): Promise<{ hunks: GitHunk[]; truncated: boolean }> {
  const cacheable = isCacheableGitCall(opts);
  const key = `${cwd}|${range.join('\u0000')}|${relPath}`;
  if (cacheable) {
    const hit = diffHunksCache.get(key);
    if (hit) {
      diffHunksCache.delete(key);
      diffHunksCache.set(key, hit);
      return hit;
    }
  }
  try {
    const raw = await collectDiffTracked(cwd, range, relPath, opts);
    // 结构化 hunk 下发（行首保留 diff 前缀），渲染口径与讲稿面板一致
    const result = { hunks: parseUnifiedDiff(raw.text).flatMap((c) => c.hunks), truncated: raw.truncated };
    if (cacheable && Buffer.byteLength(raw.text, 'utf8') <= DIFF_HUNKS_MAX_ENTRY_BYTES) {
      diffHunksCache.set(key, result);
      if (diffHunksCache.size > DIFF_HUNKS_CACHE_MAX) {
        const oldest = diffHunksCache.keys().next().value;
        if (oldest !== undefined) diffHunksCache.delete(oldest);
      }
    }
    return result;
  } catch {
    return { hunks: [], truncated: false };
  }
}

/** 逐文件取结构化 hunk；基线取第一父提交，根提交用空树（§3.2.1） */
async function buildFileDiffs(
  cwd: string,
  full: string,
  files: readonly CommitFileEntry[],
  parents: readonly string[],
  opts: GitCollectOptions,
): Promise<Record<string, { hunks: GitHunk[]; truncated: boolean }>> {
  const base = parents.length ? parents[0] : GIT_EMPTY_TREE_SHA1;
  const out: Record<string, { hunks: GitHunk[]; truncated: boolean }> = {};
  for (const f of files) {
    if (f.binary) continue;
    out[f.path] = await diffHunksFor(cwd, [base, full], f.path, opts);
  }
  return out;
}

/** 文件清单 / 差异懒加载（§4.2）：一次请求只解析一个提交 */
export async function buildTaskGitFiles(
  taskRef: { taskNo?: string; id?: string },
  shaInput: string,
  withDiff: boolean,
  opts: GitCollectOptions = {},
  repoSubInput?: unknown,
): Promise<GitFilesResult> {
  const task = resolveTask(taskRef);
  if (!task) throw new GitLinkError(404, `任务不存在或已归档：${taskRef.taskNo ?? taskRef.id ?? ''}`);
  if (!task.workspacePath) return { files: [], degraded: { kind: 'no-workspace', message: '项目未绑定工作空间，请先绑定仓库目录' } };
  const sha = normalizeShaInput(shaInput);
  if (!sha) throw new GitLinkError(400, '非法 commit ID（需 7–40 位十六进制）');
  // T04576：先按关联行定位仓库，再去该仓库解析 SHA。同一 SHA 在两个仓库有关联时必须问清楚，
  // 默认取根仓库会把子仓库的文件清单读成「该提交没有改动」。
  const db = getDb();
  const scoped = repoSubInput !== undefined;
  const rows = db.prepare(`SELECT sha, repo_sub FROM task_git_links WHERE task_id = ? AND (sha = ? OR sha LIKE ?)${scoped ? ' AND repo_sub = ?' : ''}`)
    .all(...(scoped ? [task.id, sha, `${sha}%`, normalizeRepoSub(repoSubInput)] : [task.id, sha, `${sha}%`])) as { sha: string; repo_sub: string }[];
  if (!rows.length) throw new GitLinkError(404, `该任务没有关联提交 ${sha.slice(0, 7)}`);
  if (rows.length > 1) {
    const repos = [...new Set(rows.map((r) => r.repo_sub || '.'))].join('、');
    throw new GitLinkError(409, `提交 ${sha.slice(0, 7)} 在多个仓库有关联（${repos}），请指定 repoSub 后再取文件清单`);
  }
  const target = await resolveLinkCwd(task, rows[0].repo_sub);
  if ('error' in target) return { files: [], degraded: { kind: 'not-a-repo', message: target.error } };
  const full = await resolveCommitSha(target.cwd, sha, opts);
  if (!full) return { files: [], missing: [sha], degraded: { kind: 'failed', message: `提交 ${sha} 已不在${repoLabelOf(target.repoSub)}（工作空间换绑或未 fetch）` } };
  try {
    const { commits } = await collectCommitSummaries(target.cwd, [full], opts);
    const head = commits[0];
    const parents = head?.parents ?? [];
    const files = await collectCommitFilesCached(target.cwd, full, parents, opts);
    const out: GitFilesResult = { files };
    if (withDiff) out.diffs = await buildFileDiffs(target.cwd, full, files, parents, opts);
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

/**
 * 清空全部 Git 读缓存（摘要 / SHA 解析 / 文件清单 / 单文件 hunk / origin 远端 / 摘要成本）。
 * 只给门与压测构造「冷起点」用（判据要能证明冷/热两条腿各自的数字），生产路径不调用。
 */
export function clearGitCaches(): void {
  clearSummaryMetaCache();
  clearSummaryCostCache();
  commitFilesCache.clear();
  remoteUrlCache.clear();
  revParseCache.clear();
  diffHunksCache.clear();
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
  // NaN 单独判：`NaN <= 0` 为 false，但「非正数」口径下它同样该走冷启动兜底
  if (msPerSha === null || Number.isNaN(msPerSha) || msPerSha <= 0) return GIT_SUMMARY_COLD_SHA_PER_PAGE;
  const fit = Math.floor(GIT_SUMMARY_BUDGET_MS / msPerSha);
  return Math.max(GIT_SUMMARY_MIN_SHA_PER_PAGE, Math.min(GIT_SUMMARY_MAX_SHA_PER_PAGE, fit));
}

export function resolveSummaryCapFor(workspacePath: string, shaCount: number): number {
  const prev = summaryCost.get(workspacePath);
  const msPerSha = prev && Date.now() - prev.at < SUMMARY_COST_TTL_MS ? prev.msPerSha : null;
  return Math.max(1, Math.min(shaCount, summaryCapForCost(msPerSha)));
}

/**
 * 取数预算之内还能往前推多少条：已缓存的 SHA 不占预算（命中零 spawn），
 * 只有真正要问 git 的条目才受 `cap` 限制。返回值仍是「请求序列的前缀长度」，
 * 保持 `capped = shas.slice(0, k)` 这条不变量——调用方靠它把没服务到的尾部计入 missing。
 */
function summaryPrefixWithinCap(workspacePath: string, shas: string[], cap: number): number {
  let budget = cap;
  let take = 0;
  for (; take < shas.length; take += 1) {
    if (isFullShaToken(shas[take]) && peekSummaryCache(workspacePath, shas[take])) continue;
    if (budget <= 0) break;
    budget -= 1;
  }
  return take;
}

const isFullShaToken = (token: string) => /^[0-9a-f]{40}$/.test(token);

/**
 * 一页摘要的唯一取数入口：定上限 → 取数 → 回填成本。
 * 上限只决定「这次解析多少条」，被截掉的部分由调用方计入 missing（前端据此提示未解析）。
 */
export async function collectSummaryPage(
  workspacePath: string,
  shas: string[],
  opts: GitCollectOptions = {},
): Promise<{ commits: CommitSummaryRow[]; missing: string[]; capped: string[] }> {
  const cap = resolveSummaryCapFor(workspacePath, shas.length);
  // 只有走缓存的调用才放宽前缀（带 signal/timeout/maxBuffer 的每页都要现取，预算照旧）
  const take = isCacheableGitCall(opts) ? summaryPrefixWithinCap(workspacePath, shas, cap) : cap;
  const capped = shas.slice(0, take);
  const t0 = Date.now();
  const { commits, missing, fetched } = await collectCommitSummaries(workspacePath, capped, opts);
  // 全命中时 elapsed ≈ 0，不能拿它当成本样本：EWMA 会被拉向 0，下一页上限掉回冷启动 60 条，
  // 剩下 140 条真实 SHA 就被静默判成「未解析」。只在整页确实走了 git 时回填。
  if (fetched >= capped.length) recordSummaryCost(workspacePath, capped.length, Date.now() - t0);
  return { commits, missing, capped };
}

export interface SummaryGroup {
  workspacePath: string;
  /** T04576：该组来自工作空间目录内的哪个仓库（空串 = 项目根仓库） */
  repoSub: string;
  available: boolean;
  kind?: GitErrorKind | 'no-workspace';
  message?: string;
  commits: CommitSummaryRow[];
  missing: string[];
  truncated: boolean;
  /** 该仓库的外链信息（每仓库只取一次 remote，页内零逐行请求） */
  remote?: GitRemoteInfo;
}

/**
 * 按「项目当前工作空间 + 仓库」分组（未绑定归到空 workspace 组），组内 SHA 去重保序。
 *
 * 仓库维度不能省：同一 SHA 同时关联在根仓库与子仓库时，只按 workspace 分组会把它合进一组，
 * 另一份关联就被解析成「不在仓库」——`missing` 永远消不掉。
 */
function groupShasByRepo(links: readonly { taskId?: string; sha: string; repoSub?: unknown }[]): Map<string, { workspacePath: string; repoSub: string; shas: string[] }> {
  const groups = new Map<string, { workspacePath: string; repoSub: string; shas: string[] }>();
  for (const l of links) {
    const sha = normalizeShaInput(l.sha);
    if (!sha) continue;
    const task = l.taskId ? resolveTask({ id: l.taskId }) : null;
    const workspacePath = task?.workspacePath || '';
    const repoSub = normalizeRepoSub(l.repoSub);
    const key = `${workspacePath}\u0000${repoSub}`;
    const group = groups.get(key) ?? { workspacePath, repoSub, shas: [] };
    if (!group.shas.includes(sha)) group.shas.push(sha);
    groups.set(key, group);
  }
  return groups;
}

/** 单个「工作空间 + 仓库」的摘要组：未绑定直接标 no-workspace，取数失败也降级成该组不可用，不牵连同页其它组 */
async function buildSummaryGroup(workspacePath: string, repoSub: string, shas: string[], opts: GitCollectOptions): Promise<SummaryGroup> {
  if (!workspacePath) {
    return { workspacePath: '', repoSub, available: false, kind: 'no-workspace', commits: [], missing: shas, truncated: false };
  }
  let cwd: string;
  try {
    cwd = repoSub ? resolveRepoSubPath(workspacePath, repoSub) : workspacePath;
    if (repoSub && !(await isRepositoryRoot(cwd))) throw new Error(`${repoSub} 不是一个 Git 仓库（该目录下没有 .git）`);
  } catch (e) {
    return { workspacePath, repoSub, available: false, kind: 'not-a-repo', message: e instanceof Error ? e.message : String(e), commits: [], missing: shas, truncated: false };
  }
  try {
    const page = await collectSummaryPage(cwd, shas, opts);
    return {
      workspacePath,
      repoSub,
      available: true,
      commits: page.commits,
      // 被截断掉的 SHA 不发起解析，直接计入 missing（前端页脚据此提示「本页部分提交摘要未解析」）
      missing: [...page.missing, ...shas.slice(page.capped.length)],
      truncated: page.capped.length < shas.length,
      remote: remoteInfoOf(await safeRemoteUrl(cwd, opts)),
    };
  } catch (e) {
    const kind = e instanceof GitCollectError ? e.kind : 'failed';
    const message = e instanceof GitCollectError ? e.message : String(e);
    return { workspacePath, repoSub, available: false, kind, message, commits: [], missing: shas, truncated: false };
  }
}

/**
 * 本页提交摘要批量解析（§3.1.6）：按「工作空间 + 仓库」分组，每组**一次** `git log --no-walk`。
 * 前端传「本页唯一 SHA 集合」，这里保证页内零逐行请求。
 */
export async function buildSummaryGroups(
  links: { taskId?: string; sha: string; repoSub?: unknown }[],
  opts: GitCollectOptions = {},
): Promise<{ groups: SummaryGroup[] }> {
  const groups: SummaryGroup[] = [];
  for (const g of groupShasByRepo(links).values()) groups.push(await buildSummaryGroup(g.workspacePath, g.repoSub, g.shas, opts));
  return { groups };
}

/** 列表页内联（T03361）：给一页任务附加 gitLinks（最新一条）与 gitLinkCount（「+N」角标） */
export function attachGitLinks<T extends { id: string }>(
  items: T[],
): (T & { gitLinks: { sha: string; shortSha: string; source: GitLinkSource; createdAt: string; repoSub: string }[]; gitLinkCount: number })[] {
  const byTask = listLatestLinksByTask(items.map((i) => i.id));
  return items.map((i) => {
    const hit = byTask.get(i.id);
    return {
      ...i,
      gitLinks: hit ? [{ sha: hit.link.sha, shortSha: hit.link.shortSha, source: hit.link.source, createdAt: hit.link.createdAt, repoSub: hit.link.repoSub }] : [],
      gitLinkCount: hit?.count ?? 0,
    };
  });
}

/** 关联写入的 REST 入口（手动绑定）：与 MCP 同一实现，仅 source 不同 */
export async function manualLink(taskRef: { taskNo?: string; id?: string }, sha: string, repoSubInput: unknown = ''): Promise<{ ok: true; link: GitLinkRow }> {
  const res = await linkCommits(taskRef, [sha], 'manual', repoSubInput);
  if (res.errors.length && !res.linked && !res.skipped) throw new GitLinkError(400, res.errors.join('；'));
  const task = resolveTask(taskRef);
  const normalized = normalizeShaInput(sha);
  const repoSub = normalizeRepoSub(repoSubInput);
  const found = task && normalized ? listLinks(task.id).find((l) => l.sha.startsWith(normalized) && l.repoSub === repoSub) : undefined;
  if (!found) throw new GitLinkError(404, `未能定位到关联记录：${sha}${repoSub ? ` @ ${repoSub}` : ''}`);
  return { ok: true, link: found };
}
