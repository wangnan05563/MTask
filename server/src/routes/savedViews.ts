import { Router } from 'express';
import { SavedViewError, SavedViewService, type SavedViewInput, type SavedViewPatch } from '../services/SavedViewService';

/**
 * T06303（REQ-009 / PRD §B1）：保存视图 REST。
 *
 * 项目隔离由 service 的 project_id 校验保证；本路由只做参数搬运与错误映射，
 * 不直接写 SQL（与全站「瘦路由 + 胖服务」一致）。
 */
export const savedViewsApi = Router();
const service = new SavedViewService();

function fail(res: import('express').Response, error: unknown): void {
  if (error instanceof SavedViewError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

savedViewsApi.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  try {
    const rows = service.list(projectId);
    res.json({ rows, count: rows.length });
  } catch (e) { fail(res, e); }
});

savedViewsApi.post('/', (req, res) => {
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
  try {
    res.status(201).json(service.create(projectId, req.body as SavedViewInput));
  } catch (e) { fail(res, e); }
});

savedViewsApi.patch('/:id', (req, res) => {
  try {
    res.json(service.update(req.params.id, req.body as SavedViewPatch));
  } catch (e) { fail(res, e); }
});

savedViewsApi.post('/:id/copy', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
  try {
    res.status(201).json(service.copy(req.params.id, name));
  } catch (e) { fail(res, e); }
});

savedViewsApi.delete('/:id', (req, res) => {
  try {
    service.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
