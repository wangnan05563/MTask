/**
 * T03302：Git 树取数（评审范围选择弹窗的数据源）。
 *
 * 只做三件事，且都复用讲稿采集既有通道，不另起第二套 git 口径：
 *  1. `projectId → workspace_path`（与 `lectureScope` 同一张 ACTIVE_PROJECT_WHERE，归档项目取不到）；
 *  2. git 可用性判定（未装 git / 不是仓库 / 未配工作空间要分开的文案，弹窗据此禁用选择而不是给空表）；
 *  3. `collectGitGraph` 结果投影成弹窗形状（short sha、parents、refs 装饰）。
 *
 * 失败回结构化 `error`，不抛裸 500：弹窗要把「哪种不可用」显示成人能读懂的一句话。
 */
import { getDb } from '../db/connection';
import { ACTIVE_PROJECT_WHERE } from '../util/projectRouting';
import {
  GIT_GRAPH_DEFAULT_PAGE,
  GitCollectError,
  collectAllRefNames,
  collectAuthorNames,
  collectGitGraph,
  collectRepoBasicMeta,
  probeRepository,
  type GitGraphEntry,
  type GitRefName,
} from './gitCollect';
import { discoverNestedRepos, isRepositoryRoot, resolveRepoSubPath, type NestedRepo } from './nestedRepos';
import { cacheGet, cacheSet } from '../util/ttl-cache';

export interface GitLogRequest {
  projectId: string;
  /** 起点版本（分支/标签/SHA）；all=true 时忽略 */
  head?: string;
  /** true = 全部分支一起列 */
  all?: boolean;
  skip?: number;
  limit?: number;
  search?: string;
  /**
   * T04525：同一工作空间目录内的**第几个仓库**（相对工作空间的 POSIX 路径，空 = 工作空间根仓库）。
   * 只在读路径生效，且必须落在工作空间之内（`resolveRepoSubPath` 负责判几何包含）。
   */
  repoSub?: string;
}

export interface GitLogCommit {
  sha: string;
  short: string;
  parents: string[];
  refs: GitRefName[];
  head: boolean;
  author: string;
  date: string;
  subject: string;
}

export interface GitLogResult {
  ok: boolean;
  projectId: string;
  projectName: string;
  workspacePath: string;
  commits: GitLogCommit[];
  hasMore: boolean;
  skip: number;
  limit: number;
  scanned: number;
  scanTruncated: boolean;
  /** 分支/标签清单：仅在首页（skip=0 且无 search）回传，供弹窗顶部筛选与折叠 */
  refs?: GitRefName[];
  /** T04525：本次取数实际使用的子仓库相对路径（回传入参，空串 = 工作空间根仓库） */
  repoSub?: string;
  error?: { kind: string; message: string };
}

interface ProjectRow {
  id: string;
  name: string;
  workspace_path: string | null;
}

const toCommit = (e: GitGraphEntry): GitLogCommit => ({
  sha: e.sha,
  short: e.sha.slice(0, 8),
  parents: e.parents,
  refs: e.refs,
  head: e.head,
  author: e.author,
  date: e.date,
  subject: e.subject,
});

function fail(project: ProjectRow | undefined, req: GitLogRequest, kind: string, message: string): GitLogResult {
  return {
    ok: false,
    projectId: req.projectId,
    projectName: project?.name ?? req.projectId,
    workspacePath: (project?.workspace_path ?? '').trim(),
    commits: [],
    hasMore: false,
    skip: 0,
    limit: GIT_GRAPH_DEFAULT_PAGE,
    scanned: 0,
    scanTruncated: false,
    repoSub: (req.repoSub ?? '').trim(),
    error: { kind, message },
  };
}

/** T03590：提交人候选请求/响应——作者多选下拉的数据源，只读 */
export interface GitAuthorsRequest {
  projectId: string;
  limit?: number;
}

export interface GitAuthorsResult {
  ok: boolean;
  projectId: string;
  projectName: string;
  authors: string[];
  scanned: number;
  error?: { kind: string; message: string };
}

/**
 * T03590：作者多选控件的选项源。复用 git-log 同一套项目/仓库判定（未配工作空间、非仓库、没装 git 分别给文案），
 * 只取最近 N 个提交的 author/committer 去重；取不到不抛 500，回 `ok=false` 让控件退化成「手输 + 回车添加」。
 */
export async function queryGitAuthors(req: GitAuthorsRequest): Promise<GitAuthorsResult> {
  const projectId = typeof req.projectId === 'string' ? req.projectId.trim() : '';
  const base = { projectId, projectName: projectId, authors: [] as string[], scanned: 0 };
  if (!projectId) return { ok: false, ...base, error: { kind: 'denied', message: 'projectId 必填' } };
  const project = getDb()
    .prepare(`SELECT id, name, workspace_path FROM projects WHERE id = ? AND ${ACTIVE_PROJECT_WHERE}`)
    .get(projectId) as ProjectRow | undefined;
  if (!project) return { ok: false, ...base, error: { kind: 'denied', message: '项目不存在或已归档（请刷新项目列表）' } };
  const name = { ...base, projectName: project.name };
  const workspacePath = (project.workspace_path ?? '').trim();
  if (!workspacePath) return { ok: false, ...name, error: { kind: 'no-workspace', message: '未配置工作空间路径（请在项目管理中补配）' } };
  const probe = await probeRepository(workspacePath);
  if (!probe.available) return { ok: false, ...name, error: { kind: 'no-git', message: probe.detail ?? '未找到 git 命令：请安装 Git' } };
  if (!probe.isRepo) return { ok: false, ...name, error: { kind: 'not-a-repo', message: probe.detail ?? '工作空间不是 Git 仓库' } };
  try {
    const { authors, scanned } = await collectAuthorNames(workspacePath, { limit: req.limit });
    return { ok: true, ...name, authors, scanned };
  } catch (e) {
    return { ok: false, ...name, error: { kind: 'failed', message: e instanceof Error ? e.message : String(e) } };
  }
}

export async function queryGitLog(req: GitLogRequest): Promise<GitLogResult> {
  const projectId = typeof req.projectId === 'string' ? req.projectId.trim() : '';
  if (!projectId) return fail(undefined, req, 'denied', 'projectId 必填');
  const project = getDb()
    .prepare(`SELECT id, name, workspace_path FROM projects WHERE id = ? AND ${ACTIVE_PROJECT_WHERE}`)
    .get(projectId) as ProjectRow | undefined;
  if (!project) return fail(undefined, req, 'denied', '项目不存在或已归档（请刷新项目列表）');
  const workspacePath = (project.workspace_path ?? '').trim();
  if (!workspacePath) return fail(project, req, 'no-workspace', '未配置工作空间路径（请在项目管理中补配后再用 Git 树选范围）');

  // T04525：`repoSub` 决定「工作空间目录里的哪一个仓库」。越界与解析失败在这里收口成一句话，
  // 不回落根仓库——回落会把子仓库的提交读成「没有这些提交」，比报错更难查。
  const repoSub = (req.repoSub ?? '').trim();
  let repoPath = workspacePath;
  try {
    repoPath = resolveRepoSubPath(workspacePath, repoSub);
  } catch (e) {
    return fail(project, req, 'bad-repo', e instanceof Error ? e.message : String(e));
  }

  // T04525（D-06 实测补的一刀）：`repoSub` 是非空断言「这里是一个独立仓库」，必须按 `.git` 实体核。
  // 只靠 `--is-inside-work-tree` 不够——根仓库工作树内的 `docs/` 也回 true，
  // 于是「子仓库」会静默返回根仓库的历史：视图上多了一行，读到的却是同一份提交。
  if (repoSub && !(await isRepositoryRoot(repoPath))) {
    return fail(project, req, 'not-a-repo', `${repoSub} 不是一个 Git 仓库（该目录下没有 .git）`);
  }

  const probe = await probeRepository(repoPath);
  if (!probe.available) return fail(project, req, probe.kind ?? 'no-git', probe.detail ?? '未找到 git 命令：请安装 Git，或改用区间/粘贴 patch 模式');
  if (!probe.isRepo) {
    return fail(project, req, probe.kind ?? 'not-a-repo', repoSub
      ? `${repoSub} 不是一个 Git 仓库（该目录下没有 .git）`
      : (probe.detail ?? '工作空间不是 Git 仓库：请初始化仓库，或改用区间/粘贴 patch 模式'));
  }

  // T04581：取数失败（典型如分支只在子仓库、根仓库 bad revision）回结构化 ok:false，不抛裸错。
  // 抛出会让路由回 HTTP 400，前端 catch 把它误读成「无法连接到本机服务或取数被拒绝」；
  // 结构化 error 让前端走 r.ok=false 分支，把「这个分支在这个仓库不存在」原样显示给用户。
  let page: Awaited<ReturnType<typeof collectGitGraph>>;
  let refs: GitRefName[] | undefined;
  try {
    page = await collectGitGraph(repoPath, {
      head: req.head,
      all: req.all === true,
      skip: req.skip,
      limit: req.limit,
      search: req.search,
    });
    const firstPage = (req.skip ?? 0) === 0 && !(req.search ?? '').trim();
    if (firstPage) {
      // T04883：引用清单改由 for-each-ref 全量取，不再受 `git log --all` 的提交窗口限制。
      // 旧口径只收窗口内提交的装饰，子仓库独有/久未更新的分支 tip 落在窗口外就整个丢失，
      // 分组视图与起点分支候选都查不到它；这里一条只读命令取齐三类命名空间。
      refs = await collectAllRefNames(repoPath);
    }
  } catch (e) {
    const kind = e instanceof GitCollectError ? e.kind : 'failed';
    return fail(project, req, kind, e instanceof Error ? e.message : String(e));
  }
  return {
    ok: true,
    projectId,
    projectName: project.name,
    workspacePath,
    commits: page.commits.map(toCommit),
    hasMore: page.hasMore,
    skip: page.skip,
    limit: page.limit,
    scanned: page.scanned,
    scanTruncated: page.scanTruncated,
    ...(refs ? { refs } : {}),
    repoSub,
  };
}

/** T04525：仓库清单请求/响应——「同一工作空间目录下的多个仓库」的数据源，只读 */
export interface GitReposRequest {
  projectId: string;
}

export interface GitReposResult {
  ok: boolean;
  projectId: string;
  projectName: string;
  workspacePath: string;
  repos: NestedRepo[];
  /** 因深度/条数上限被截断：前端要显式说出来，不能让清单看起来是全集 */
  truncated: boolean;
  scannedDirs: number;
  error?: { kind: string; message: string };
}

/** T04586：元数据取数并发上限——清单可能几十个子仓库，逐个 fork git 会拖慢整视图 */
const REPO_META_CONCURRENCY = 4;

/** T04886：仓库发现 + 元数据取数结果的内存缓存 TTL。普查（`/git/repos`）会递归扫描目录并逐仓库 fork git，
 *  在极宽工作空间下开销显著（实测 BEMP5.0DEV 全量扫描约 4 分钟）；用户连续打开/刷新弹窗时命中缓存即可省掉整段开销。
 *  选 TTL 而非「目录 mtime 摘要」：摘要本身需遍历全树，开销≈扫描，得不偿失；30s 覆盖交互窗口已足够。 */
const GIT_REPOS_CACHE_TTL = 30_000;

/** T04586：给发现到的每个仓库补 当前分支/最新提交/origin URL（空仓库/无远端回空串，不剔除该仓库）。 */
async function enrichReposWithMeta(repos: NestedRepo[]): Promise<NestedRepo[]> {
  const out = [...repos];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < out.length) {
      const i = cursor;
      cursor += 1;
      const meta = await collectRepoBasicMeta(out[i].absPath);
      out[i] = { ...out[i], ...meta };
    }
  };
  await Promise.all(Array.from({ length: Math.min(REPO_META_CONCURRENCY, out.length) }, () => worker()));
  return out;
}

/**
 * T04525：把工作空间目录展开成「里面有哪些仓库」。
 *
 * 判定顺序与 git-log 一致（未配工作空间 / 没装 git 各给一句话），差别在最后一关：
 * 工作空间**根**不是仓库时不再直接判死——`D:\code\xx` 这种「只是装仓库的目录」正是本需求要支持的形状，
 * 里面发现不了仓库才回 `not-a-repo`。
 */
export async function queryGitRepos(req: GitReposRequest): Promise<GitReposResult> {
  const projectId = typeof req.projectId === 'string' ? req.projectId.trim() : '';
  const base = { projectId, projectName: projectId, workspacePath: '', repos: [] as NestedRepo[], truncated: false, scannedDirs: 0 };
  if (!projectId) return { ok: false, ...base, error: { kind: 'denied', message: 'projectId 必填' } };
  const project = getDb()
    .prepare(`SELECT id, name, workspace_path FROM projects WHERE id = ? AND ${ACTIVE_PROJECT_WHERE}`)
    .get(projectId) as ProjectRow | undefined;
  if (!project) return { ok: false, ...base, error: { kind: 'denied', message: '项目不存在或已归档（请刷新项目列表）' } };
  const named = { ...base, projectName: project.name };
  const workspacePath = (project.workspace_path ?? '').trim();
  if (!workspacePath) return { ok: false, ...named, error: { kind: 'no-workspace', message: '未配置工作空间路径（请在项目管理中补配）' } };
  // T04886：缓存命中直接返回，跳过递归扫描 + 逐仓库元数据 fork（仅缓存 ok:true，失败结果不缓存以免掩盖配置变更）。
  const cacheKey = `git-repos:${workspacePath}`;
  const cached = cacheGet<GitReposResult>(cacheKey);
  if (cached) return cached;
  try {
    // T04586：清单要覆盖「任意层级」的嵌套仓库，故深度不设浅上限（discoverNestedRepos 缺省 2 层留给
    // 聚合普查/提取卡等旧调用方保持向后兼容）；性能仍由 maxScanDirs/maxCount 兜底，截断经 truncated 显式告知。
    // T04883：census 额外开启 descendIntoRepos —— 一个目录被认定为仓库后仍继续下钻。像
    // `BEMP5.0DEV/banks` 这种「本身是仓库、内部还可能装着别的仓库」的分组目录，旧口径命中即边界，
    // 内部仓库连同它们的分支整个不出现。上限同步放宽，避免深层清单先被 40 条截断。
    const found = await discoverNestedRepos(workspacePath, {
      maxDepth: Number.POSITIVE_INFINITY,
      descendIntoRepos: true,
      maxCount: 200,
    });
    if (!found.repos.length) {
      return { ok: false, ...named, workspacePath, truncated: found.truncated, scannedDirs: found.scannedDirs,
        error: { kind: 'not-a-repo', message: '该工作空间目录及其子目录内没有 Git 仓库' } };
    }
    const repos = await enrichReposWithMeta(found.repos);
    const result: GitReposResult = { ok: true, ...named, workspacePath, repos, truncated: found.truncated, scannedDirs: found.scannedDirs };
    cacheSet(cacheKey, result, GIT_REPOS_CACHE_TTL);
    return result;
  } catch (e) {
    return { ok: false, ...named, workspacePath, error: { kind: 'failed', message: e instanceof Error ? e.message : String(e) } };
  }
}
