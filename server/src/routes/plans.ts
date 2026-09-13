import { Router, raw } from 'express';
import { PlanService } from '../services/PlanService';
import { AIService } from '../services/AIService';

/**
 * 项目计划路由（T00431，菜单位于周报前）。
 * 数据模型与流程见 docs/PRD-项目计划.md；导入为「任一行失败整体不入库」的事务语义。
 * 注意：/holidays 系列必须注册在 /:id 之前，否则 DELETE /holidays/:date 会被 DELETE /:id 抢占。
 */
export const planApi = Router();

/** 统一错误包装：业务错误 → 400 + { error } */
function wrap(res: import('express').Response, fn: () => unknown): void {
  try {
    res.json(fn());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** 未知值显式字符串化：object 走 JSON，避免默认的 "[object Object]"（S6551） */
function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v); // NOSONAR - 前置 typeof 已排除 object 分支，此处仅剩 string/number/boolean/bigint
}

/** 可选字符串参数：null/undefined → undefined，其余同 toStr（保持原字段可选语义） */
function optStr(v: unknown): string | undefined {
  return v == null ? undefined : toStr(v);
}

/** projectId 必填校验 */
function pid(req: import('express').Request): string {
  const v = req.query.projectId;
  const s = typeof v === 'string' ? v : '';
  if (!s) throw new Error('projectId 必填');
  return s;
}

// ---------- 节假日（须先于 /:id 注册） ----------
planApi.get('/holidays', (_req, res) => wrap(res, () => PlanService.listHolidays()));

planApi.post('/holidays', (req, res) => {
  const { date, name } = (req.body ?? {}) as { date?: unknown; name?: unknown };
  if (!date || typeof date !== 'string') return res.status(400).json({ error: 'date 必填（YYYY-MM-DD）' });
  wrap(res, () => { PlanService.addHoliday(date, toStr(name)); return { ok: true }; });
});

planApi.delete('/holidays/:date', (req, res) => wrap(res, () => PlanService.removeHoliday(req.params.date)));

// 联网导入国家法定节假日（T00442）：后端代理 timor.tech 免费数据源（避开浏览器 CORS），upsert 幂等
planApi.post('/holidays/import-national', (req, res) => {
  const { year } = (req.body ?? {}) as { year?: unknown };
  const y = Number(year);
  if (!Number.isInteger(y)) return res.status(400).json({ error: 'year 必填（数字年份）' });
  PlanService.importNationalHolidays(y)
    .then((r) => res.json({ ok: true, ...r }))
    .catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

// ---------- Excel 导入 / 导出 / 模板（静态路径，同样先于 /:id） ----------
// 导入用 raw 收集 xlsx 二进制：全局 express.json 仅解析 application/json，octet-stream 上传会跳过，由这里收集
// importExcel 为 async（exceljs 解析），需 await 后再响应，不能走同步 wrap（Promise 会被序列化成 {}）
planApi.post('/import', raw({ type: () => true, limit: '30mb' }), (req, res) => {
  const projectId = req.query.projectId;
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请求体应为 xlsx 文件二进制' });
  PlanService.importExcel(projectId, req.body)
    .then((r) => res.json(r))
    .catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

planApi.get('/export', (req, res) => {
  const projectId = req.query.projectId;
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  PlanService.exportExcel(projectId).then((buf) => {
    const ts = new Date().toISOString().slice(0, 19).replaceAll(/[-:T]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="plan-${ts}.xlsx"`);
    res.send(buf);
  }).catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

planApi.get('/template', (_req, res) => {
  PlanService.templateExcel().then((buf) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plan-template.xlsx"');
    res.send(buf);
  }).catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

// ---------- AI 导入（T00438）：任意格式 Excel → AI 语义解析 → 草稿预览 → 确认批量创建 ----------
// raw 收集文件二进制；projectId/toolId/filename 走 query（raw body 无法再携带 JSON 元数据）
planApi.post('/ai-parse', raw({ type: () => true, limit: '30mb' }), (req, res) => {
  const projectId = req.query.projectId;
  const toolId = req.query.toolId;
  const filename = typeof req.query.filename === 'string' ? req.query.filename : 'upload.xlsx';
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (typeof toolId !== 'string' || !toolId) return res.status(400).json({ error: 'toolId 必填（AI 解析需要模型工具）' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请求体应为文件二进制' });
  PlanService.tableToTextAsync(req.body, filename)
    .then((text) => PlanService.aiParseDrafts(toolId, text))
    .then((r) => res.json({ ok: true, ...r }))
    .catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

// AI 导入确认保存：批量创建 + 统一重排（首条带 startDate 时作时间线锚点）
planApi.post('/batch', (req, res) => {
  const { projectId, items } = (req.body ?? {}) as { projectId?: unknown; items?: unknown };
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items 必填（计划条目数组）' });
  wrap(res, () => PlanService.createBatch(projectId, items as Parameters<typeof PlanService.createBatch>[1]));
});

// ---------- 需求文档 AI 拆分（T00439）：Word/Markdown → WBS → 标准计划草稿 ----------
planApi.post('/ai-parse-doc', raw({ type: () => true, limit: '30mb' }), (req, res) => {
  const projectId = req.query.projectId;
  const toolId = req.query.toolId;
  const filename = typeof req.query.filename === 'string' ? req.query.filename : 'doc.md';
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (typeof toolId !== 'string' || !toolId) return res.status(400).json({ error: 'toolId 必填（AI 拆分需要模型工具）' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请求体应为文档二进制' });
  const lower = filename.toLowerCase();
  // 按扩展名分派文本提取：md 原样（层级天然保留）/ docx 提取段落与标题样式；其余提示
  let textP: Promise<string>;
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    textP = Promise.resolve(req.body.toString('utf-8'));
  } else if (lower.endsWith('.docx')) {
    textP = Promise.resolve(PlanService.docxToMarkdown(req.body));
  } else {
    textP = Promise.reject(new Error('仅支持 .md / .markdown / .docx；老式 .doc 请先用 Word 另存为 .docx'));
  }
  textP
    .then((text) => PlanService.aiParseWbs(toolId, text))
    .then((r) => res.json({ ok: true, ...r }))
    .catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

// ---------- 计划任务 CRUD ----------
planApi.get('/', (req, res) => wrap(res, () => PlanService.list(pid(req))));

planApi.post('/', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!b.projectId || !b.title) return res.status(400).json({ error: 'projectId 与 title 必填' });
  wrap(res, () => PlanService.create({
    projectId: String(b.projectId),
    title: String(b.title),
    description: optStr(b.description),
    startDate: optStr(b.startDate),
    durationDays: b.durationDays == null ? undefined : Number(b.durationDays),
    assignee: optStr(b.assignee),
    kind: optStr(b.kind), // T00506
    status: b.status as Parameters<typeof PlanService.create>[0]['status'],
  }));
});

planApi.patch('/:id', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  wrap(res, () => PlanService.update(req.params.id, {
    title: optStr(b.title),
    description: optStr(b.description),
    startDate: optStr(b.startDate),
    durationDays: b.durationDays == null ? undefined : Number(b.durationDays),
    progress: b.progress == null ? undefined : Number(b.progress),
    status: b.status as Parameters<typeof PlanService.update>[1]['status'],
    assignee: optStr(b.assignee),
    color: optStr(b.color), // T00490
    deps: optStr(b.deps), // T00499
    kind: optStr(b.kind), // T00506
  }));
});

planApi.delete('/:id', (req, res) => wrap(res, () => PlanService.purge(req.params.id)));

// ---------- 归档（T00442 扩展：删除改归档，归档菜单提供恢复/彻底删除） ----------
planApi.get('/archived', (_req, res) => wrap(res, () => PlanService.listArchived()));
planApi.post('/:id/archive', (req, res) => wrap(res, () => PlanService.archive(req.params.id)));
planApi.post('/:id/restore', (req, res) => wrap(res, () => PlanService.restore(req.params.id)));

// 任意位置插入（T00459）：在指定行之后插入新计划任务，后续排期自动重排
planApi.post('/:id/insert-after', (req, res) => {
  const { title, description } = (req.body ?? {}) as { title?: unknown; description?: unknown };
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title 必填' });
  wrap(res, () => PlanService.insertAfter(req.params.id, title, typeof description === 'string' ? description : undefined));
});

// 通用需求 → 计划草稿（PRD INT-5）：把通用需求条目转为计划任务
planApi.post('/from-req', (req, res) => {
  const { reqEntryId, projectId } = (req.body ?? {}) as { reqEntryId?: unknown; projectId?: unknown };
  if (typeof reqEntryId !== 'string' || !reqEntryId || typeof projectId !== 'string' || !projectId) {
    return res.status(400).json({ error: 'reqEntryId 与 projectId 必填' });
  }
  wrap(res, () => PlanService.createFromReq(reqEntryId, projectId));
});

// 拖拽排序（T00459）：前端传拖拽后的完整活跃计划 id 顺序，事务重写 sort_order 并重排时间线
planApi.post('/reorder', (req, res) => {
  const { projectId, orderedIds } = (req.body ?? {}) as { projectId?: unknown; orderedIds?: unknown };
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'orderedIds 必填（id 字符串数组，按新顺序）' });
  }
  wrap(res, () => PlanService.reorder(projectId, orderedIds as string[]));
});

// ---------- 待办联动 ----------
planApi.post('/:id/link', (req, res) => {
  const { taskId } = (req.body ?? {}) as { taskId?: unknown };
  wrap(res, () => PlanService.linkTodo(req.params.id, taskId ? toStr(taskId) : null));
});

planApi.post('/:id/create-todo', (req, res) => wrap(res, () => PlanService.createLinkedTodo(req.params.id)));

// T00472：计划条目 AI 评估——逐条串行评估（可行性/工期/风险），返回每条评估文本
planApi.post('/ai-evaluate', async (req, res) => {
  const { toolId, items } = (req.body ?? {}) as { toolId?: unknown; items?: unknown };
  if (typeof toolId !== 'string' || !toolId) { res.status(400).json({ error: 'toolId 必填' }); return; }
  if (!Array.isArray(items) || items.length === 0 || items.some((x) => typeof x !== 'object' || x === null)) {
    res.status(400).json({ error: 'items 必须为非空对象数组' }); return;
  }
  type Item = { id?: unknown; title?: unknown; duration_days?: unknown; progress?: unknown; assignee?: unknown };
  const results: Array<{ id: string; ok: boolean; evaluation?: string; error?: string }> = [];
  for (const it of items as Item[]) {
    const id = typeof it.id === 'string' ? it.id : '';
    const title = typeof it.title === 'string' ? it.title : '';
    if (!id || !title) { results.push({ id, ok: false, error: 'id/title 必填' }); continue; }
    const r = await AIService.evaluatePlan(
      {
        title,
        duration_days: Number(it.duration_days) || 1,
        progress: Math.min(100, Math.max(0, Number(it.progress) || 0)),
        assignee: typeof it.assignee === 'string' ? it.assignee : null,
      },
      toolId,
    );
    results.push({ id, ok: r.ok, evaluation: r.evaluation, error: r.error });
  }
  res.json({ ok: true, results });
});
