import { Router, raw } from 'express';
import { PlanService } from '../services/PlanService';
import { AIService } from '../services/AIService';
import { resolvePrdContext } from '../util/prdContext'; // T00763：计划关联 PRD → 评估上下文
import { exportGate } from '../util/export-gate'; // T00789：导出类端点并发闸

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

// T01058-FR1.3：就绪任务推荐——deps 前置均完成的执行行（供 AI 工作台「现在做这个」卡片）
planApi.get('/ready', (req, res) => {
  const projectId = pid(req);
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' });
  wrap(res, () => PlanService.readyTasks(projectId, Math.min(10, Math.max(1, Number(req.query.limit) || 3))));
});

planApi.post('/holidays', (req, res) => {
  const { date, name, kind } = (req.body ?? {}) as { date?: unknown; name?: unknown; kind?: unknown };
  if (!date || typeof date !== 'string') return res.status(400).json({ error: 'date 必填（YYYY-MM-DD）' });
  // T00764：kind='holiday' 放假日 | 'overtime' 加班日（默认节假日）
  const k = kind === 'overtime' ? 'overtime' : 'holiday';
  wrap(res, () => { PlanService.addHoliday(date, toStr(name), k); return { ok: true }; });
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

// T01071-FR5.3：项目全量 Markdown 导出（任务清单 + WBS + 需求矩阵，单文档）
planApi.get('/export-md', exportGate('plans-export-md'), (req, res) => {
  const projectId = req.query.projectId;
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  try {
    const md = PlanService.exportMarkdown(projectId);
    const ts = new Date().toISOString().slice(0, 19).replaceAll(/[-:T]/g, '');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mtask-export-${ts}.md"`);
    res.send(md);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// T00789：同步主线程导出（实测 ~283ms/次），加并发闸避免多路导出串行叠加阻塞
planApi.get('/export', exportGate('plans-export'), (req, res) => {
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

// ---------- T00662：从 PRD 导入（AI 拆 WBS + 需求跟踪矩阵） ----------

/** PRD 解析：上传文件 → 提取文本（多格式）→ AI 输出 {requirements, plans}（未落库，供预览确认） */
planApi.post('/ai-parse-prd', raw({ type: () => true, limit: '30mb' }), (req, res) => {
  const projectId = req.query.projectId;
  const toolId = req.query.toolId;
  const filename = typeof req.query.filename === 'string' ? req.query.filename : 'prd.md';
  if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (typeof toolId !== 'string' || !toolId) return res.status(400).json({ error: 'toolId 必填（PRD 解析需要模型工具）' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请求体应为文件二进制' });
  PlanService.extractPrdText(req.body, filename)
    .then(async (text) => {
      // T00908：随解析一并返回提取后的 PRD 全文 textMd——供前端确认导入时作 prdMd 落库到 PRD 管理视图
      const r = await PlanService.aiParsePrd(toolId, text);
      return { ok: true, ...r, textMd: text };
    })
    .then((r) => res.json(r))
    .catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

/** PRD 确认导入：事务创建需求项 + 计划（含关联）+ 可选同步生成待办任务 */
planApi.post('/import-prd', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  wrap(res, () => PlanService.importPrd(b.projectId as string, {
    requirements: Array.isArray(b.requirements) ? b.requirements as Parameters<typeof PlanService.importPrd>[1]['requirements'] : undefined,
    plans: Array.isArray(b.plans) ? b.plans as Parameters<typeof PlanService.importPrd>[1]['plans'] : undefined,
    createTasks: b.createTasks === true,
    prdMd: typeof b.prdMd === 'string' ? b.prdMd : undefined, // T00763：PRD Markdown 原文完整落库
    prdFilename: typeof b.prdFilename === 'string' ? b.prdFilename : undefined,
  }));
});

// ---------- T00763：PRD 原文文档（查看 / 反向更新） ----------

planApi.get('/prd-docs', (req, res) => wrap(res, () => PlanService.listPrdDocs(pid(req))));

planApi.get('/prd-docs/:id', (req, res) => wrap(res, () => PlanService.getPrdDoc(req.params.id)));

/** 反向更新 PRD 原文（全量覆盖）：AI 修订或用户编辑后的完整 Markdown 回写 */
planApi.put('/prd-docs/:id', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  wrap(res, () => PlanService.updatePrdDoc(req.params.id, {
    contentMd: typeof b.contentMd === 'string' ? b.contentMd : undefined,
    filename: typeof b.filename === 'string' ? b.filename : undefined,
  }));
});

// ---------- T00770：PRD 管理视图（新建 / 删除 / 状态流转 / 待确认问题） ----------

planApi.post('/prd-docs', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  wrap(res, () => PlanService.createPrdDoc({
    projectId: b.projectId as string,
    filename: typeof b.filename === 'string' ? b.filename : '',
    contentMd: typeof b.contentMd === 'string' ? b.contentMd : '',
    status: typeof b.status === 'string' ? b.status : undefined,
    originHash: typeof b.originHash === 'string' ? b.originHash : undefined,
  }));
});

planApi.delete('/prd-docs/:id', (req, res) => wrap(res, () => { PlanService.deletePrdDoc(req.params.id); return { ok: true }; }));

planApi.patch('/prd-docs/:id/status', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.status !== 'string') return res.status(400).json({ error: "status 必填（'prd' | 'confirmed'）" });
  wrap(res, () => PlanService.setPrdDocStatus(req.params.id, b.status as string));
});

/** 导出文件名安全化：去掉路径分隔与非法字符（与前端 safeFilename 同口径，避免下载文件名带斜杠） */
function safeExportName(name: string, fallback: string): string {
  const s = name.replaceAll(/[\\/:*?"<>|\n\r\t]/g, '-').replaceAll(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

/**
 * T00959：PRD 文档下载——按 format 产出 md/docx/pdf 三种格式。
 * md 直接回正文原文；docx/pdf 由服务端合成（docx / pdfkit + 系统中文黑体，与报表构建器同口径），
 * 客户端只负责触发下载，保证两处入口导出结果一致、不依赖浏览器端能力。
 */
planApi.get('/prd-docs/:id/export', exportGate('prd-doc-export', undefined, { defer: true }), async (req, res) => {
  // T01361（S6551）：query 参数先 typeof 收窄，避免 object 形态进入字符串化
  const fmtRaw = req.query.format;
  const format = (typeof fmtRaw === 'string' ? fmtRaw : 'md').toLowerCase();
  if (!['md', 'docx', 'pdf'].includes(format)) return res.status(400).json({ error: 'format 仅支持 md / docx / pdf' });
  try {
    const doc = PlanService.getPrdDoc(req.params.id) as { filename?: string; content_md?: string } | undefined;
    if (!doc) return res.status(404).json({ error: 'PRD 文档不存在' });
    const base = safeExportName((doc.filename ?? '').replace(/\.[^.]+$/, ''), 'PRD');
    const md = doc.content_md ?? '';
    if (format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      const fileName = `${base}.md`;
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.send(Buffer.from(md, 'utf8'));
      return;
    }
    const { buildPrdDocx, buildPrdPdf } = await import('../services/prdExport'); // 按需加载：docx/pdfkit 较重，仅导出时引入
    const title = base;
    const buf = format === 'docx' ? await buildPrdDocx(md, title) : await buildPrdPdf(md, title);
    res.setHeader('Content-Type', format === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf');
    const exportName = `${base}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exportName)}`);
    res.send(buf);
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

planApi.get('/prd-issues', (req, res) => {
  const projectId = pid(req);
  const prdId = typeof req.query.prdId === 'string' && req.query.prdId ? req.query.prdId : undefined;
  wrap(res, () => PlanService.listIssues(projectId, prdId));
});

planApi.post('/prd-issues', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (typeof b.question !== 'string' || !b.question.trim()) return res.status(400).json({ error: 'question 必填' });
  wrap(res, () => PlanService.addIssue({
    projectId: b.projectId as string,
    prdId: typeof b.prdId === 'string' && b.prdId ? b.prdId : undefined,
    question: b.question as string,
  }));
});

planApi.patch('/prd-issues/:id', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  wrap(res, () => PlanService.updateIssue(req.params.id, {
    question: typeof b.question === 'string' ? b.question : undefined,
    answer: typeof b.answer === 'string' ? b.answer : undefined,
    status: typeof b.status === 'string' ? b.status : undefined,
    suggestion: typeof b.suggestion === 'string' ? b.suggestion : undefined,
  }));
});

planApi.delete('/prd-issues/:id', (req, res) => wrap(res, () => { PlanService.deleteIssue(req.params.id); return { ok: true }; }));

/** T00769：批量录入待确认问题（AI 生成的清单 + 用户自定义一次入库） */
planApi.post('/prd-issues/batch', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!Array.isArray(b.items)) return res.status(400).json({ error: 'items 必须为数组' });
  wrap(res, () => PlanService.addIssuesBatch({
    projectId: b.projectId as string,
    prdId: typeof b.prdId === 'string' && b.prdId ? b.prdId : undefined,
    items: b.items as Array<{ question: string; answer?: string; level?: string; suggestion?: string }>,
  }));
});

/** 回写：把已确认问题的「问题 + 结论」写入对应 PRD 文档 Markdown */
planApi.post('/prd-issues/:id/writeback', (req, res) => wrap(res, () => PlanService.writebackIssue(req.params.id)));

// ---------- T00662：需求跟踪矩阵 CRUD ----------

planApi.get('/prd-requirements', (req, res) => wrap(res, () => PlanService.listRequirements(pid(req))));

/**
 * T00959：需求跟踪矩阵导出 Excel——数据与界面同源（PlanService.listRequirements），
 * 列序与界面一致；状态/优先级转中文标签，关联计划/待办多条以「；」拼接。
 */
planApi.get('/prd-requirements/export', exportGate('req-matrix-export', undefined, { defer: true }), async (req, res) => {
  const projectId = pid(req);
  const STATUS_LABEL: Record<string, string> = { todo: '待开始', doing: '进行中', done: '已完成', changed: '已变更' };
  const PRIORITY_LABEL: Record<string, string> = { high: '高', medium: '中', normal: '普通', low: '低' };
  try {
    const rows = PlanService.listRequirements(projectId);
    const project = PlanService.getProjectBrief(projectId);
    const { buildMatrixXlsx } = await import('../services/prdExport'); // 按需加载 exceljs
    const data = rows.map((r) => {
      const prd = r.prdDoc as { filename?: string } | null;
      const plans = (r.linkedPlans as Array<{ title?: string }> | undefined) ?? [];
      const tasks = (r.linkedTasks as Array<{ taskNo?: string | null; title?: string }> | undefined) ?? [];
      return {
        reqNo: String(r.req_no ?? ''),
        title: String(r.title ?? ''),
        content: String(r.content ?? ''),
        priority: PRIORITY_LABEL[String(r.priority ?? '')] ?? String(r.priority ?? ''),
        status: STATUS_LABEL[String(r.status ?? '')] ?? String(r.status ?? ''),
        source: String(r.source_ref ?? ''),
        prdDoc: prd?.filename ?? '',
        plans: plans.map((p) => p.title ?? '').filter(Boolean).join('；'),
        tasks: tasks.map((t) => {
          const taskLabel = t.taskNo ? `${t.taskNo} ${t.title ?? ''}` : `${t.title ?? ''}`;
          return taskLabel.trim();
        }).filter(Boolean).join('；'),
      };
    });
    const buf = await buildMatrixXlsx(data, project.name);
    const ts = new Date().toISOString().slice(0, 10);
    const fname = safeExportName(`需求跟踪矩阵-${project.name}-${ts}`, '需求跟踪矩阵') + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

planApi.post('/prd-requirements', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId || typeof b.title !== 'string' || !b.title.trim()) {
    return res.status(400).json({ error: 'projectId 与 title 必填' });
  }
  wrap(res, () => PlanService.createRequirement(b.projectId as string, {
    reqNo: optStr(b.reqNo), title: b.title as string, content: optStr(b.content),
    sourceRef: optStr(b.sourceRef), priority: optStr(b.priority), status: optStr(b.status),
  }));
});

planApi.patch('/prd-requirements/:id', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  wrap(res, () => PlanService.updateRequirement(req.params.id, {
    title: optStr(b.title), content: optStr(b.content),
    reqNo: optStr(b.reqNo), sourceRef: optStr(b.sourceRef),
    priority: optStr(b.priority), status: optStr(b.status),
    sortOrder: b.sortOrder === undefined ? undefined : Number(b.sortOrder),
    prdId: optStr(b.prdId),
  }));
});

planApi.delete('/prd-requirements/:id', (req, res) => wrap(res, () => { PlanService.deleteRequirement(req.params.id); return { ok: true }; }));

/** 关联调整：需求 ↔ 计划/待办（linked=true 建立关联，false 解除） */
planApi.post('/prd-requirements/:id/link', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  let kind: 'task' | 'plan' | null = null;
  if (b.kind === 'task') kind = 'task';
  else if (b.kind === 'plan') kind = 'plan';
  if (!kind || typeof b.targetId !== 'string' || !b.targetId) return res.status(400).json({ error: 'kind(plan|task) 与 targetId 必填' });
  wrap(res, () => { PlanService.linkRequirement(req.params.id, { kind, targetId: b.targetId as string, linked: b.linked !== false }); return { ok: true }; });
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
    // T00763：计划条目关联了 PRD 时自动加载原文作为评估上下文（评估依据可追溯至 PRD 条目）
    const prd = resolvePrdContext({ planId: id });
    const r = await AIService.evaluatePlan(
      {
        title,
        duration_days: Number(it.duration_days) || 1,
        progress: Math.min(100, Math.max(0, Number(it.progress) || 0)),
        assignee: typeof it.assignee === 'string' ? it.assignee : null,
      },
      toolId,
      prd ? `PRD 文档《${prd.filename || '未命名'}》相关原文：\n${prd.content}` : undefined,
    );
    results.push({ id, ok: r.ok, evaluation: r.evaluation, error: r.error });
  }
  res.json({ ok: true, results });
});
