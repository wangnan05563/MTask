import { Router } from 'express';
import { getDb } from '../db/connection';
import { resolveMemoryScope } from '../util/memoryScope';
import { resolvePendingMemory } from '../util/memoryGuard';
import {
  deleteOrphanTagMemories, listOrphanProductTags, reattachOrphanTag, renameProductTag,
} from '../services/ProductTagService'; // T04154（PRD MEM-505/107/108）：标签重命名与孤儿清理入口
import { appendReviewLog, listReviewLog, ruleRejectStats, sampleMemoriesForReview } from '../services/MemoryReviewLogService'; // T04158/T04164（MEM-604/F8）：评审记录与抽样
import {
  deleteMemory, listMemories, listPendingMemories, listProductTags,
  queryForContext, queryMemories, saveMemory, similarMemories, updateMemory,
} from '../services/MemoryService';

/**
 * T04151（PRD MEM-402/403）：记忆 REST 出口。
 *
 * 与 MCP 工具共用 MemoryService 的实现（不产生第二套业务逻辑，架构 §3.2「瘦路由+胖服务」）。
 * 所有读写都必须解析出产品作用域：完全缺省 → 400（C4 拒绝无作用域检索）；
 * 解析后为空串（项目未绑产品）→ 200 + 空集 + hint（MEM-302，不报错）。
 */

export const memoriesApi = Router();

function lookupProductKey(projectId: string): string | null {
  const row = getDb().prepare('SELECT product_key FROM projects WHERE id = ?').get(projectId) as
    | { product_key: string | null }
    | undefined;
  return row ? (row.product_key ?? '') : null;
}

type ScopeInput = { productKey?: unknown; projectId?: string };

/** 解析作用域；调用方按 kind 决定 400/200+hint/正常执行 */
function scopeOf(input: ScopeInput) {
  return resolveMemoryScope({
    productKey: input.productKey,
    projectId: input.projectId,
    lookupProductKey,
  });
}

function fail(res: import('express').Response, message: string, status = 400): void {
  res.status(status).json({ error: message });
}

// ---------- 产品标签（管理页筛选/绑定弹窗数据源；必须早于 /:id 注册） ----------
memoriesApi.get('/product-tags', (_req, res) => {
  res.json(listProductTags());
});

// ---------- 抽样评审记录（MEM-604/F8；T04158） ----------
memoriesApi.post('/review-log', (req, res) => {
  const r = appendReviewLog({
    batchId: typeof req.body?.batchId === 'string' ? req.body.batchId : '',
    memoryId: typeof req.body?.memoryId === 'string' ? req.body.memoryId : '',
    verdict: req.body?.verdict,
    hitRule: typeof req.body?.hitRule === 'string' ? req.body.hitRule : undefined,
    reviewer: typeof req.body?.reviewer === 'string' ? req.body.reviewer : undefined,
  });
  if (!r.ok) return fail(res, r.error);
  res.status(201).json({ ok: true, id: r.id });
});

memoriesApi.get('/review-log', (req, res) => {
  res.json({
    ok: true,
    rows: listReviewLog({
      batchId: typeof req.query.batchId === 'string' ? req.query.batchId : undefined,
      limit: Number(req.query.limit) || undefined,
    }),
  });
});

memoriesApi.get('/review-log/stats', (_req, res) => {
  res.json({ ok: true, stats: ruleRejectStats() });
});

// ---------- 语义判重候选检索（T04165）：FTS5 优先、LIKE 兜底 ----------
memoriesApi.get('/similar', (req, res) => {
  const scope = scopeOf({
    productKey: req.query.productKey,
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
  });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.json({ ok: true, source: 'like', memories: [], hint: scope.hint });
  const text = typeof req.query.text === 'string' ? req.query.text : '';
  if (!text.trim()) return fail(res, 'text 必填');
  const r = similarMemories(scope, text, {
    limit: Number(req.query.limit) || undefined,
    excludeId: typeof req.query.excludeId === 'string' ? req.query.excludeId : undefined,
  });
  res.json({ ok: true, source: r.source, memories: r.rows });
});

// T04164（MEM-604）：开一批随机抽样评审（只读，判定另行 POST /review-log 落库）
memoriesApi.get('/review-sample', (req, res) => {
  const scope = scopeOf({
    productKey: req.query.productKey,
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
  });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.json({ ok: true, batchId: '', memories: [], hint: scope.hint });
  const sample = sampleMemoriesForReview(scope.productKey, Number(req.query.batchSize) || undefined);
  res.json({ ok: true, ...sample });
});

// ---------- 产品标签重命名 / 孤儿清理（MEM-505/107/108；DELETE 必须早于 /:id 注册） ----------
memoriesApi.post('/product-tags/rename', (req, res) => {
  const r = renameProductTag(req.body?.oldKey, req.body?.newKey);
  if (!r.ok) return fail(res, r.error ?? '重命名失败');
  // mergedIntoExisting=true 表示新标签已存在，本次是合并（不阻断，由前端提示）
  res.json({ ...r, ok: true });
});

memoriesApi.get('/product-tags/orphans', (_req, res) => {
  res.json({ ok: true, orphans: listOrphanProductTags() });
});

memoriesApi.delete('/product-tags/:key', (req, res) => {
  const r = deleteOrphanTagMemories(req.params.key);
  if (!r.ok) return fail(res, r.error ?? '清理失败');
  res.json({ ok: true, deleted: r.deleted });
});

memoriesApi.post('/product-tags/:key/reattach', (req, res) => {
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
  const r = reattachOrphanTag(req.params.key, projectId);
  if (!r.ok) return fail(res, r.error ?? '挂回失败');
  res.json({ ok: true });
});

// ---------- 产品下的项目与自动抽取开关（MEM-504；PATCH 必须早于 /:id 注册） ----------
memoriesApi.get('/projects', (req, res) => {
  const scope = scopeOf({
    productKey: req.query.productKey,
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
  });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.json({ ok: true, projects: [], hint: scope.hint });
  const rows = getDb().prepare(
    'SELECT id, name, memory_auto_extract FROM projects WHERE product_key = ? ORDER BY name',
  ).all(scope.productKey);
  res.json({ ok: true, projects: rows });
});

memoriesApi.patch('/projects/:id', (req, res) => {
  const scope = scopeOf({ productKey: req.body?.productKey, projectId: req.body?.projectId });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return fail(res, scope.hint);
  const proj = getDb().prepare('SELECT product_key FROM projects WHERE id = ?').get(req.params.id) as
    | { product_key: string | null }
    | undefined;
  if (!proj) return res.status(404).json({ error: '项目不存在' });
  // MEM-503/403：开关是产品内配置，跨产品改项目开关等同越权
  if ((proj.product_key ?? '') !== scope.productKey) return res.status(403).json({ error: '项目不属于该产品，禁止跨产品修改' });
  if (typeof req.body?.enabled !== 'boolean') return fail(res, 'enabled 必须是布尔值');
  getDb().prepare('UPDATE projects SET memory_auto_extract = ?, updated_at = ? WHERE id = ?')
    .run(req.body.enabled ? 1 : 0, new Date().toISOString(), req.params.id);
  res.json({ ok: true, id: req.params.id, enabled: req.body.enabled });
});

// ---------- 待确认队列（MEM-209/402；必须早于 /:id 注册） ----------
memoriesApi.get('/pending', (req, res) => {
  const scope = scopeOf({
    productKey: req.query.productKey,
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
  });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.json({ ok: true, memories: [], hint: scope.hint });
  res.json({
    ok: true,
    memories: listPendingMemories(scope.productKey, Number(req.query.limit) || 50),
  });
});

memoriesApi.post('/pending/:id/confirm', (req, res) => {
  const scope = scopeOf({ productKey: req.body?.productKey, projectId: req.body?.projectId });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.status(404).json({ error: '待确认项不存在', hint: scope.hint });
  const row = getDb().prepare('SELECT product_key FROM memory_review_queue WHERE id = ?').get(req.params.id) as
    | { product_key: string }
    | undefined;
  if (!row) return res.status(404).json({ error: '待确认项不存在' });
  // MEM-403：跨产品确认属于越权写入，必须与队列行作用域一致
  if (row.product_key !== scope.productKey) return fail(res, '待确认项不属于该产品');
  const r = resolvePendingMemory(req.params.id, 'confirm');
  if (!r.ok) return res.status(400).json({ error: r.reason ?? '确认失败' });
  res.json({ ok: true, id: req.params.id });
});

memoriesApi.post('/pending/:id/reject', (req, res) => {
  const scope = scopeOf({ productKey: req.body?.productKey, projectId: req.body?.projectId });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.status(404).json({ error: '待确认项不存在', hint: scope.hint });
  const row = getDb().prepare('SELECT product_key FROM memory_review_queue WHERE id = ?').get(req.params.id) as
    | { product_key: string }
    | undefined;
  if (!row) return res.status(404).json({ error: '待确认项不存在' });
  if (row.product_key !== scope.productKey) return fail(res, '待确认项不属于该产品');
  const r = resolvePendingMemory(req.params.id, 'reject');
  if (!r.ok) return res.status(400).json({ error: r.reason ?? '驳回失败' });
  res.json({ ok: true, id: req.params.id });
});

// ---------- 列表 / 召回 ----------
memoriesApi.get('/', (req, res) => {
  const scope = scopeOf({
    productKey: req.query.productKey,
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
  });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.json({ ok: true, total: 0, memories: [], hint: scope.hint });
  const q = req.query;
  const opts = {
    type: typeof q.type === 'string' ? q.type : undefined,
    query: typeof q.query === 'string' ? q.query : undefined,
    tags: typeof q.tag === 'string' ? [q.tag] : undefined,
    includeInvalidated: q.includeInvalidated === '1' || q.includeInvalidated === 'true',
    limit: Number(q.limit) || undefined,
    offset: Number(q.offset) || undefined,
  };
  // mode=context 时直接产出 Agent 注入块（MEM-304 契约），避免调用方二次拼装
  if (q.mode === 'context') return res.json({ ok: true, ...queryForContext(scope, opts) });
  const r = listMemories(scope, opts);
  res.json({ ok: true, total: r.total, memories: r.rows });
});

// ---------- 新增 ----------
memoriesApi.post('/', (req, res) => {
  const scope = scopeOf({ productKey: req.body?.productKey, projectId: req.body?.projectId });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.status(400).json({ error: scope.hint });
  const r = saveMemory({
    scope,
    type: req.body?.type,
    title: req.body?.title,
    content: req.body?.content,
    tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
    sourceKind: req.body?.sourceKind,
    sourceTaskId: req.body?.sourceTaskId,
  });
  if (r.kind === 'error') return fail(res, r.error);
  if (r.kind === 'queued') return res.status(202).json({ ok: true, queued: true, id: r.id, piiKind: r.piiKind });
  res.status(201).json({ ok: true, id: r.id });
});

// ---------- 单条更新 / 删除 ----------
memoriesApi.patch('/:id', (req, res) => {
  const scope = scopeOf({ productKey: req.body?.productKey, projectId: req.body?.projectId });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return fail(res, scope.hint);
  const r = updateMemory(req.params.id, scope, {
    type: req.body?.type,
    title: req.body?.title,
    content: req.body?.content,
    tags: Array.isArray(req.body?.tags) ? req.body.tags : (req.body?.tags === null ? null : undefined),
  });
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, id: r.id });
});

memoriesApi.delete('/:id', (req, res) => {
  const scope = scopeOf({
    productKey: req.query.productKey ?? req.body?.productKey,
    projectId: (typeof req.query.projectId === 'string' ? req.query.projectId : req.body?.projectId),
  });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return fail(res, scope.hint);
  const r = deleteMemory(req.params.id, scope);
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json({ ok: true, id: r.id });
});

// ---------- 召回（供 Agent/调试直接取原始行） ----------
memoriesApi.get('/query', (req, res) => {
  const scope = scopeOf({
    productKey: req.query.productKey,
    projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
  });
  if (scope.kind === 'error') return fail(res, scope.error);
  if (scope.kind === 'empty') return res.json({ ok: true, memories: [], hint: scope.hint });
  const q = req.query;
  res.json({
    ok: true,
    memories: queryMemories(scope, {
      type: typeof q.type === 'string' ? q.type : undefined,
      query: typeof q.query === 'string' ? q.query : undefined,
      tags: typeof q.tag === 'string' ? [q.tag] : undefined,
      limit: Number(q.limit) || undefined,
    }),
  });
});
