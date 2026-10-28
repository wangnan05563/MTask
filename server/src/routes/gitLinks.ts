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
  normalizeShaInput,
  resolveTask,
  unlinkCommit,
} from '../services/taskGitLinks';
import { queryGitLog, type GitLogRequest } from '../services/lectureGitLog';
import { cacheGet, cacheSet } from '../util/ttl-cache';
import { createHash } from 'node:crypto';

export const gitLinksApi = Router();

/** 摘要缓存 TTL（§3.1.6：60s 内复用，翻页/筛选变化即失效——键里含 SHA 集合，天然失效） */
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
  const links = req.body.links as { taskId?: string; sha?: string }[];
  const clean = links
    .map((l) => ({ taskId: typeof l.taskId === 'string' ? l.taskId : undefined, sha: normalizeShaInput(l.sha ?? '') ?? '' }))
    .filter((l) => l.sha);
  if (!clean.length) return res.json({ groups: [], echoed: links.length });
  const key = createHash('sha1').update(clean.map((l) => `${l.taskId ?? ''}:${l.sha}`).sort().join('|')).digest('hex');
  const hit = cacheGet(`git-summaries:${key}`) as { groups: unknown[] } | undefined;
  if (hit) return res.json(hit);
  try {
    const out = await buildSummaryGroups(clean);
    cacheSet(`git-summaries:${key}`, out, SUMMARIES_TTL_MS);
    res.json(out);
  } catch (e) {
    httpError(res, e);
  }
});

/** 抽屉首屏：该任务全部关联提交的摘要 + 统计（时间倒序） */
gitLinksApi.get('/tasks/:id/git', async (req, res) => {
  try {
    res.json(await buildTaskGitView({ id: req.params.id }));
  } catch (e) {
    httpError(res, e);
  }
});

/** 变更文件清单（`?diff=1` 时附 hunks）——单提交懒加载 */
gitLinksApi.get('/tasks/:id/git/:sha/files', async (req, res) => {
  try {
    res.json(await buildTaskGitFiles({ id: req.params.id }, req.params.sha, req.query.diff === '1'));
  } catch (e) {
    httpError(res, e);
  }
});

/** 关联列表（抽屉刷新与「+N」浮层） */
gitLinksApi.get('/tasks/:id/git/links', (req, res) => {
  if (!resolveTask({ id: req.params.id })) return res.status(404).json({ error: '任务不存在或已归档' });
  res.json({ links: listLinks(req.params.id) });
});

/** 手动绑定（Git 树弹窗确认）：body `{ sha }` */
gitLinksApi.post('/tasks/:id/git/links', async (req, res) => {
  try {
    const sha = String(req.body?.sha ?? '');
    if (!normalizeShaInput(sha)) return res.status(400).json({ error: '非法 commit ID（需 7–40 位十六进制）' });
    res.json(await manualLink({ id: req.params.id }, sha));
  } catch (e) {
    httpError(res, e);
  }
});

/** 解绑：仅 source='manual'；AI 回写返回 409 + 原因 */
gitLinksApi.delete('/tasks/:id/git/links/:sha', (req, res) => {
  try {
    res.json(unlinkCommit({ id: req.params.id }, req.params.sha));
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
    projectId: String(q.projectId ?? ''),
    head: q.head ? String(q.head) : undefined,
    all: q.all === '1' || q.all === 'true',
    skip: q.skip === undefined ? undefined : Math.max(0, Math.floor(Number(q.skip) || 0)),
    limit: q.limit === undefined ? undefined : Math.min(500, Math.max(1, Math.floor(Number(q.limit) || 50))),
    search: q.search ? String(q.search) : undefined,
  };
  if (!body.projectId) return res.status(400).json({ error: '缺少 projectId' });
  try {
    res.json(await queryGitLog(body));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
