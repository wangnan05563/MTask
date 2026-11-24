import { Router } from 'express';
import { TemplateError, TemplateService, type InstantiateInput, type TemplateInput, type TemplatePatch } from '../services/TemplateService';

/**
 * T06305（REQ-010 / PRD §B2）：模板与实例化 REST。
 *
 * 瘦路由：参数搬运 + 错误映射；校验、事务、撤销回收逻辑全在 TemplateService。
 */
export const templatesApi = Router();
const service = new TemplateService();

function fail(res: import('express').Response, error: unknown): void {
  if (error instanceof TemplateError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

templatesApi.get('/', (req, res) => {
  try {
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const rows = service.list(type);
    res.json({ rows, count: rows.length });
  } catch (e) { fail(res, e); }
});

// 静态路径必须先于 /:id，避免 instances 被当成模板 id
templatesApi.get('/instances', (req, res) => {
  try {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const rows = service.listInstances(projectId);
    res.json({ rows, count: rows.length });
  } catch (e) { fail(res, e); }
});

templatesApi.post('/instances/:instanceId/undo', (req, res) => {
  try { res.json(service.undo(req.params.instanceId)); } catch (e) { fail(res, e); }
});

templatesApi.get('/instances/:instanceId', (req, res) => {
  try { res.json(service.getInstance(req.params.instanceId)); } catch (e) { fail(res, e); }
});

templatesApi.get('/:id', (req, res) => {
  try { res.json(service.get(req.params.id)); } catch (e) { fail(res, e); }
});

templatesApi.post('/', (req, res) => {
  try { res.status(201).json(service.create(req.body as TemplateInput)); } catch (e) { fail(res, e); }
});

templatesApi.patch('/:id', (req, res) => {
  try { res.json(service.update(req.params.id, req.body as TemplatePatch)); } catch (e) { fail(res, e); }
});

templatesApi.delete('/:id', (req, res) => {
  try { service.delete(req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

templatesApi.post('/:id/instantiate', (req, res) => {
  try { res.status(201).json(service.instantiate(req.params.id, req.body as InstantiateInput)); } catch (e) { fail(res, e); }
});
