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
  GIT_GRAPH_MAX_PAGE,
  collectGitGraph,
  probeRepository,
  type GitGraphEntry,
  type GitRefName,
} from './gitCollect';

export interface GitLogRequest {
  projectId: string;
  /** 起点版本（分支/标签/SHA）；all=true 时忽略 */
  head?: string;
  /** true = 全部分支一起列 */
  all?: boolean;
  skip?: number;
  limit?: number;
  search?: string;
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

/** 从提交装饰里聚合去重的分支/标签名（`--all` 窗口内的可见引用） */
function collectRefNames(entries: readonly GitGraphEntry[]): GitRefName[] {
  const seen = new Set<string>();
  const out: GitRefName[] = [];
  for (const e of entries) {
    for (const r of e.refs) {
      const key = `${r.type}:${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

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
    error: { kind, message },
  };
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

  const probe = await probeRepository(workspacePath);
  if (!probe.available) return fail(project, req, probe.kind ?? 'no-git', probe.detail ?? '未找到 git 命令：请安装 Git，或改用区间/粘贴 patch 模式');
  if (!probe.isRepo) return fail(project, req, probe.kind ?? 'not-a-repo', probe.detail ?? '工作空间不是 Git 仓库：请初始化仓库，或改用区间/粘贴 patch 模式');

  const page = await collectGitGraph(workspacePath, {
    head: req.head,
    all: req.all === true,
    skip: req.skip,
    limit: req.limit,
    search: req.search,
  });
  const firstPage = (req.skip ?? 0) === 0 && !(req.search ?? '').trim();
  let refs: GitRefName[] | undefined;
  if (firstPage) {
    // 引用清单一次独立取数：只看当前分支的话，别的热分支根本不会出现在装饰里
    const all = await collectGitGraph(workspacePath, { all: true, limit: GIT_GRAPH_MAX_PAGE });
    refs = collectRefNames(all.commits);
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
  };
}
