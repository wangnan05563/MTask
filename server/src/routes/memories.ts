import { Router } from 'express';
import { getDb } from '../db/connection';
import { resolveMemoryScope } from '../util/memoryScope';
import { resolvePendingMemory } from '../util/memoryGuard';
import {
  deleteMemory, listMemories, listPendingMemories, listProductTags,
  queryForContext, queryMemories, saveMemory, updateMemory,
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
