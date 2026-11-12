/**
 * 八期 §4.2 任务 ↔ Git 提交相关端点（T03361/T03397/T03398/T03436）。
 *
 * 全部走 `services/taskGitLinks`，取数经 gitCollect 白名单（只读红线）。
 * 错误口径：降级（未绑定/非仓库/无 git/无 remote/SHA 已不在仓库）返回 200 + `degraded`，
 * 让前端按 kind 给指引；只有参数非法、任务不存在、来源不允许才用 4xx。
 */
import { Router } from 'express';
import {
  GitLinkError,
  buildSummaryGroups,
  buildTaskGitFiles,
  buildTaskGitView,
  listLinks,
  manualLink,
  normalizeRepoSub,
  normalizeShaInput,
  resolveTask,
  unlinkCommit,
} from '../services/taskGitLinks';
import { queryGitLog, queryGitRepos, type GitLogRequest } from '../services/lectureGitLog';
import { queryCommitFiles } from '../services/gitCommitFiles';
import { suggestGitLinks } from '../services/gitAiLink';
import { cacheGet, cacheSet } from '../util/ttl-cache';
import { getDb } from '../db/connection';
import { createHash } from 'node:crypto';
import { scalarText } from '../util/scalarText';

export const gitLinksApi = Router();

/** 摘要缓存 TTL（§3.1.6：60s 内复用，翻页/筛选变化即失效——键里含 SHA 集合与任务当前工作空间，换绑即失效） */
const SUMMARIES_TTL_MS = 60_000;

function httpError(res: import('express').Response, e: unknown): void {
  if (e instanceof GitLinkError) {
    res.status(e.httpStatus).json({ error: e.message, kind: e.kind });
    return;
  }
  res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

/**
 * 本页提交摘要批量解析：body `{ links: [{taskId, sha}] }`。
 * 服务端按 workspace 分组，每组一次 `git log --no-walk`；60s 内同键复用。
 */
gitLinksApi.post('/git/commit-summaries', async (req, res) => {
  // 「不静默失败」：缺 links 字段/传错形状是调用方写错了，点名比回一个空 groups 更有用
  // （空数组是合法的「本页没有关联」，仍回 groups: []）
  if (req.body?.links === undefined) return res.status(400).json({ error: 'links 必填（数组 [{taskId, sha}]）' });
  if (!Array.isArray(req.body.links)) return res.status(400).json({ error: 'links 需为数组：[{taskId, sha}]' });
  const links = req.body.links as { taskId?: string; sha?: string; repoSub?: unknown }[];
  const clean = links
    .map((l) => ({ taskId: typeof l.taskId === 'string' ? l.taskId : undefined, sha: normalizeShaInput(l.sha ?? '') ?? '', repoSub: normalizeRepoSub(l.repoSub) }))
    .filter((l) => l.sha);
  if (!clean.length) return res.json({ groups: [], echoed: links.length });
  // 缓存键里带上「任务当前工作空间 + 仓库」：只按 taskId:sha 组键时，项目换绑后 60s 内仍会命中旧仓库的摘要组，
  // 列表徽标于是继续显示已经解绑仓库的提交——§3.1.1 的「不可用」态被 stale 缓存压掉。翻页/筛选照常复用。
  const wsOf = new Map<string, string>();
  const workspaceOf = (taskId?: string): string => {
    if (!taskId) return '';
    const hit = wsOf.get(taskId);
    if (hit !== undefined) return hit;
    const ws = resolveTask({ id: taskId })?.workspacePath ?? '';
    wsOf.set(taskId, ws);
    return ws;
  };
  const key = createHash('sha1')
    .update(clean.map((l) => `${l.taskId ?? ''}:${workspaceOf(l.taskId)}:${l.repoSub}:${l.sha}`).sort((a, b) => a.localeCompare(b)).join('|'))
    .digest('hex');
  const hit = cacheGet<{ groups: unknown[] }>(`git-summaries:${key}`);
  if (hit) return res.json(hit);
  try {
    const out = await buildSummaryGroups(clean);
    cacheSet(`git-summaries:${key}`, out, SUMMARIES_TTL_MS);
    res.json(out);
  } catch (e) {
    httpError(res, e);
  }
});

/**
 * T03642：抽屉首屏结果缓存。首屏的每次 git 取数都要付进程启动成本（本机实测 0.3–1.5s/次），
 * 而「同一任务的同一组关联」在 60s 内重复打开是很常见的（开关抽屉、来回切标签）。
 * 键里包含 workspace 与关联集合（sha + linkedAt）以及任务 updatedAt——换绑、加解绑、任务编辑
 * 都会换键，不存在看到旧状态的可能；降级态不缓存，用户修好绑定/装好 git 后应立刻恢复。
 */
const TASK_GIT_VIEW_TTL_MS = 60_000;

function taskGitViewCacheKey(taskId: string): string {
  const task = resolveTask({ id: taskId });
  if (!task?.workspacePath) return '';
  const links = listLinks(task.id).map((l) => `${l.sha}:${l.createdAt}`).sort((a, b) => a.localeCompare(b)).join(',');
  const fingerprint = `${task.id}|${task.workspacePath}|${task.updatedAt}|${links}`;
  return `git-view:${createHash('sha1').update(fingerprint).digest('hex')}`;
}

/** 抽屉首屏：该任务全部关联提交的摘要 + 统计（时间倒序） */
/**
 * T05682：讲稿卡片「已完成任务」选择器——一次返回所选项目下全部已完成任务及其关联提交。
 * 前端勾选任务后把 sha 合并进既有 `projects[].range.commits` 协议，不新增采集协议；
 * 任务没有关联提交时 `commits` 为空，前端据此提示「该任务未回写 commit」。
 */
gitLinksApi.get('/git/done-task-commits', (req, res) => {
  const projectIds = String(req.query.projectIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (projectIds.length === 0) return res.status(400).json({ error: 'projectIds 必填（逗号分隔）' });
  const marks = projectIds.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT t.id, t.task_no, t.title, t.project_id, l.sha, l.repo_sub
       FROM tasks t
       LEFT JOIN task_git_links l ON l.task_id = t.id
      WHERE t.project_id IN (${marks}) AND t.status = 'done'
      ORDER BY t.task_no, l.created_at`,
  ).all(...projectIds) as Array<{
    id: string; task_no: string | null; title: string; project_id: string;
    sha: string | null; repo_sub: string | null;
  }>;
  const map = new Map<string, {
    id: string; taskNo: string; title: string; projectId: string;
    commits: Array<{ sha: string; repoSub: string }>;
  }>();
  for (const r of rows) {
    let task = map.get(r.id);
    if (!task) {
      task = { id: r.id, taskNo: r.task_no ?? '', title: r.title, projectId: r.project_id, commits: [] };
      map.set(r.id, task);
    }
    if (r.sha) task.commits.push({ sha: r.sha, repoSub: r.repo_sub ?? '' });
  }
  res.json({ ok: true, tasks: [...map.values()] });
});

gitLinksApi.get('/tasks/:id/git', async (req, res) => {
  try {
    const key = taskGitViewCacheKey(req.params.id);
    const hit = key ? cacheGet(key) : undefined;
    if (hit) return res.json(hit);
    const out = await buildTaskGitView({ id: req.params.id });
    if (key && !out.degraded) cacheSet(key, out, TASK_GIT_VIEW_TTL_MS);
    res.json(out);
  } catch (e) {
    httpError(res, e);
  }
});

/** 变更文件清单（`?diff=1` 时附 hunks）——单提交懒加载；`?repoSub=` 定位工作空间目录内的仓库 */
gitLinksApi.get('/tasks/:id/git/:sha/files', async (req, res) => {
  try {
    res.json(await buildTaskGitFiles(
      { id: req.params.id },
      req.params.sha,
      req.query.diff === '1',
      {},
      req.query.repoSub === undefined ? undefined : scalarText(req.query.repoSub),
    ));
  } catch (e) {
    httpError(res, e);
  }
});

/** 关联列表（抽屉刷新与「+N」浮层） */
gitLinksApi.get('/tasks/:id/git/links', (req, res) => {
  if (!resolveTask({ id: req.params.id })) return res.status(404).json({ error: '任务不存在或已归档' });
  res.json({ links: listLinks(req.params.id) });
});

/** 手动绑定（Git 树弹窗确认）：body `{ sha, repoSub? }`（repoSub 空/省略 = 项目根仓库） */
gitLinksApi.post('/tasks/:id/git/links', async (req, res) => {
  try {
    const sha = String(req.body?.sha ?? '');
    if (!normalizeShaInput(sha)) return res.status(400).json({ error: '非法 commit ID（需 7–40 位十六进制）' });
    res.json(await manualLink({ id: req.params.id }, sha, req.body?.repoSub));
  } catch (e) {
    httpError(res, e);
  }
});

/** 解绑：仅 source='manual'；AI 回写返回 409 + 原因。`?repoSub=` 用于区分同一 SHA 的多仓库关联 */
gitLinksApi.delete('/tasks/:id/git/links/:sha', (req, res) => {
  try {
    res.json(unlinkCommit({ id: req.params.id }, req.params.sha, req.query.repoSub === undefined ? undefined : scalarText(req.query.repoSub)));
  } catch (e) {
    httpError(res, e);
  }
});

/**
 * T03436（Q11 裁定）：Git 树取数端点上提为 `GET /git/log`。
 * 任务侧不应长期依赖讲稿命名空间；旧 `POST /plans/code-review-lecture/git-log` 保留，
 * 与这里共用同一 `queryGitLog` 实现（转发的语义即「同一份取数逻辑，两个入口」）。
 */
gitLinksApi.get('/git/log', async (req, res) => {
  const q = req.query;
  const body: GitLogRequest = {
    projectId: scalarText(q.projectId ?? ''),
    head: q.head ? scalarText(q.head) : undefined,
    all: q.all === '1' || q.all === 'true',
    skip: q.skip === undefined ? undefined : Math.max(0, Math.floor(Number(q.skip) || 0)),
    limit: q.limit === undefined ? undefined : Math.min(500, Math.max(1, Math.floor(Number(q.limit) || 50))),
    search: q.search ? scalarText(q.search) : undefined,
    /** T04525：工作空间目录内的哪一个仓库；几何包含校验在服务端 `resolveRepoSubPath` 单点做 */
    repoSub: q.repoSub ? scalarText(q.repoSub) : undefined,
  };
  if (!body.projectId) return res.status(400).json({ error: '缺少 projectId' });
  try {
    res.json(await queryGitLog(body));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * T05210：Git 树选范围弹窗**右栏变更文件树**的取数口——body `{ projectId, repoSub?, shas: string[] }`。
 *
 * 与 `/tasks/:id/git/:sha/files` 的分工：那条要任务 id（抽屉里的文件页），这条按项目 + 仓库坐标定位，
 * 因为弹窗此时还没有任务。一次请求最多点名 `MAX_COMMIT_FILES_BATCH` 个提交（超出回 `dropped`，
 * 由前端继续发下一片），内部复用 `collectCommitFilesBatch` 的一次 `git log --no-walk`。
 * 降级（未配工作空间 / 没装 git / 不是仓库）回 200 + `ok:false` + 一句话，让右栏能说清「为什么没有文件」。
 */
gitLinksApi.post('/git/commit-files', async (req, res) => {
  const body = req.body ?? {};
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' });
  const shas = Array.isArray(body.shas) ? body.shas.filter((s: unknown): s is string => typeof s === 'string') : [];
  if (!shas.length) return res.status(400).json({ error: 'shas 必填（提交 SHA 数组）' });
  try {
    res.json(await queryCommitFiles({
      projectId,
      repoSub: typeof body.repoSub === 'string' ? body.repoSub : '',
      shas,
    }));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * T04525（需求修订）：列出**同一工作空间目录内**的多个仓库（根仓库 + 下一层/两层内含 `.git` 的子目录）。
 * 旧口径下这些子仓库不可见：`rev-parse --is-inside-work-tree` 在子目录里也回 true，读起来像「只有一个仓库」。
 * 只读清单，供分支聚合视图普查；不可用（未配工作空间/无仓库）回 200 + `ok:false` + 一句话。
 */
gitLinksApi.get('/git/repos', async (req, res) => {
  const projectId = scalarText(req.query.projectId ?? '');
  if (!projectId) return res.status(400).json({ error: '缺少 projectId' });
  try {
    res.json(await queryGitRepos({ projectId }));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * T03621：「AI 智能关联」——把已完成未回写任务与仓库近期提交做语义匹配，**只出建议**。
 * body `{ projectId, toolId, maxTasks?, maxCommits? }`；写库仍走 `POST /tasks/:id/git/links`（用户确认后）。
 * 降级口径同 §4.2：未绑定/非仓库回 200 + kind，让前端给指引；缺参才是 4xx。
 */
gitLinksApi.post('/git/ai-link-suggest', async (req, res) => {
  const body = req.body ?? {};
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  const toolId = typeof body.toolId === 'string' ? body.toolId.trim() : '';
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!toolId) return res.status(400).json({ error: 'toolId 必填（请先在「模型」页添加并选择一个 AI 模型）' });
  try {
    res.json(await suggestGitLinks({ projectId, toolId, maxTasks: body.maxTasks, maxCommits: body.maxCommits }));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
