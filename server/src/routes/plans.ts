import { Router, raw } from 'express';
import { PlanService } from '../services/PlanService';
import { TestCaseService } from '../services/TestCaseService'; // T01484：测试用例取数（PRD-测试用例管理 §6）
import { assertOutlineShape, kickoffOutline, preflight, kickoffPptStream } from '../services/kickoffService'; // T02095/T02096/T02103：启动会 PPT 前置校验、大纲与 SSE 流式生成
import { summaryPreflight } from '../services/summaryPptService'; // T02853（六期 S2）：总结汇报 PPT 前置校验聚合 S1~S9
import { summaryOutline } from '../services/summaryPptOutline'; // T02854（六期 S3）：总结汇报 PPT 大纲段（提示词 + schema 校验）
import { prepareSummaryPptStream, renderSummaryPptStream } from '../services/summaryPptStream'; // T02856（六期 S5）：总结汇报 PPT 流式装配 + 下载令牌
import { safeExportName } from '../util/export-name'; // T02104：导出文件名单源（与下载白名单同源）
import { discardReport } from '../services/ReportService'; // T02144：中止且 done 未送达时当场回收落盘令牌
import type { CaseBatchPatch, CaseInput, CasePatch, CaseQuery, CaseStepInput, DraftCaseImport, DraftReqImport } from '../services/TestCaseService';
import { AIService } from '../services/AIService';
import { backfillComplexity, listInvalid as listInvalidComplexity, listMissing as listMissingComplexity } from '../services/PlanComplexity'; // T01058 后续 / T02122：计划行复杂度批量补算 + 值域断言
import { resolvePrdContext } from '../util/prdContext'; // T00763：计划关联 PRD → 评估上下文
import { parseLimit, parseOffset, wantsTotal } from '../util/list-page'; // T02284：列表分页参数统一口径（limit/offset/total=1）
import { exportGate, REPORT_GATE } from '../util/export-gate'; // T00789：导出类并发闸；T02105：启动会稿与周报共用 REPORT_GATE

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

/**
 * 查询串里的多项目范围：`?projectIds=a,b`（CSV）或重复参数 `?projectIds=a&projectIds=b` 都接受，
 * 空值出 undefined（= 全部未归档项目口径，由服务端解析，不在路由里造第二份语义）。
 */
function csvList(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => toStr(x).split(','));
  const ids = parts.map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
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

// T02095：启动会 PPT 前置校验（PRD-项目启动会PPT生成 §3.2 FR-2）——只读聚合、零 AI 调用（FR-2.3）
planApi.get('/kickoff-preflight', (req, res) => wrap(res, () => preflight(pid(req))));

// T02853（六期 S2）：阶段性总结汇报 PPT 前置校验（PRD-阶段性项目总结汇报PPT §3.3 FR-3）——
// 一次聚合 S1~S9，只读、零 AI 调用（FR-3.4）；范围与周期入参可选性由服务层守卫并回 400 中文文案。
// 范围入参沿用报表族既有口径（`routes/index.ts:1543` 的 parseScopeBody）：projectIds 优先，projectId 兼容单选。
planApi.get('/summary-preflight', (req, res) =>
  wrap(res, () =>
    summaryPreflight(req.query.period, csvList(req.query.projectIds) ?? (optStr(req.query.projectId) ? [optStr(req.query.projectId)!] : undefined), {
      start: optStr(req.query.start),
      end: optStr(req.query.end),
    }),
  ),
);

/**
 * T02854（六期 S3）：阶段性总结汇报 PPT 大纲（1 次 askJson + schema 校验；不合规由 askJson 自带重试 1 次后 400）。
 * 只产内存态大纲、不落库不生成文件（装配在 S4）；S1/S2 硬阻塞时服务层直接拒，不经 AI、不烧配额。
 */
planApi.post('/summary-ppt-outline', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const toolId = toStr(b.toolId);
  if (!toolId) return res.status(400).json({ error: 'toolId 必填（大纲生成需要模型工具）' });
  if (b.period == null) return res.status(400).json({ error: 'period 必填（day/week/month/custom）' });
  const scope = csvList(b.projectIds) ?? (optStr(b.projectId) ? [optStr(b.projectId)!] : undefined);
  summaryOutline({
    period: b.period,
    projectIds: scope,
    custom: { start: optStr(b.start), end: optStr(b.end) },
    toolId,
    style: optStr(b.style),
    extraNote: optStr(b.extraNote),
  })
    .then((r) => res.json(r))
    .catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

/**
 * T02856（六期 S5）：阶段性总结汇报 PPT 流式生成（第 2 段）。事件形态与 `/kickoff-ppt-stream`
 * 同构：`stage {msg}`（逐页）/ `done {token, fileName, pageCount, warnings[], projects[], degradedPages[]}` / `error {error}`。
 * 与启动会的差别：备料（周期/范围/阻塞/大纲）全部在 SSE 头之前完成，参数错直接结构化 400，
 * 不让前端在流里猜「是模型没用还是参数不对」。
 */
planApi.post('/summary-ppt-stream', exportGate(REPORT_GATE, undefined, { defer: true }), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const scope = csvList(b.projectIds) ?? (optStr(b.projectId) ? [optStr(b.projectId)!] : undefined);
  let prepared: ReturnType<typeof prepareSummaryPptStream>;
  try {
    prepared = prepareSummaryPptStream({
      period: b.period,
      projectIds: scope,
      custom: { start: optStr(b.start), end: optStr(b.end) },
      outline: b.outline,
      mode: b.mode,
      workloadCaliber: b.workloadCaliber,
    });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let closed = false;
  const send = (event: string, payload: unknown) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  // 必须监听 res 的 close（同 T00838：req 的 close 会在请求体读完后提前触发，监听 req 会把 stage/done 全误丢）
  const ac = new AbortController();
  // T02144 同族：done 已发出后用户不下载是正常放弃（开流/清扫兜底）；
  // 只有「已落盘但 done 没送出去」的断开才当场回收，既不留孤儿也不误删待下载文件
  let issuedToken: string | undefined;
  let doneSent = false;
  res.on('close', () => {
    closed = true;
    ac.abort();
    if (issuedToken && !doneSent) discardReport(issuedToken);
  });

  try {
    const r = await renderSummaryPptStream(prepared, (msg) => send('stage', { msg }), ac.signal);
    issuedToken = r.token;
    // close 可能早于 promise 落地：此时不补删就成孤儿（close 那次已跑完）
    if (closed || res.writableEnded) {
      discardReport(r.token);
      issuedToken = undefined;
      return;
    }
    send('done', {
      token: r.token,
      fileName: r.fileName,
      pageCount: r.pageCount,
      warnings: r.warnings,
      projects: r.projects,
      degradedPages: r.degradedPages,
    });
    doneSent = true;
  } catch (e) {
    send('error', { error: e instanceof Error ? e.message : String(e) });
  }
  res.end();
});

// T02096 §2.2：启动会 PPT 大纲（1 次 askJson + schema 校验；不合规则触发自带重试后 400）
planApi.post('/kickoff-ppt-outline', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const projectId = toStr(b.projectId);
  const toolId = toStr(b.toolId);
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!toolId) return res.status(400).json({ error: 'toolId 必填（大纲生成需要模型工具）' });
  kickoffOutline(projectId, toolId, optStr(b.extraNote))
    .then((r) => res.json(r))
    .catch((e: unknown) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

/**
 * T02103 §2.3：启动会 PPT 流式生成（第 2 段）。事件形态与 `/report/ai-generate-stream`
 * （`routes/index.ts:1636`）逐字同构：`stage {msg}` / `done {token, fileName, pageCount, warnings[]}` / `error {error}`。
 */
planApi.post('/kickoff-ppt-stream', exportGate(REPORT_GATE, undefined, { defer: true }), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const projectId = toStr(b.projectId);
  const toolId = toStr(b.toolId);
  // SSE 头之前快速失败：前端拿得到结构化 400 与「哪一页不对」，而不是流建起来后才一条 error
  if (!projectId) return res.status(400).json({ error: 'projectId 必填' });
  if (!toolId) return res.status(400).json({ error: 'toolId 必填（生成需要模型工具）' });
  try {
    assertOutlineShape(b.outline);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let closed = false;
  const send = (event: string, payload: unknown) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  // 必须监听 res 的 close（响应真正关闭才代表客户端断开）：SSE 请求体已被 express.json() 消费完，
  // IncomingMessage 无数据可读时 req 会提前触发 close，监听 req 会把 stage/done 全误丢（T00838 实测坑）
  const ac = new AbortController();
  // T02144：done 已发出后用户不下载是正常放弃（归定时清扫回收，文件此刻还该留着）；
  // 只有在「已落盘但 done 没送出去」的断开里当场回收，才既不留孤儿、也不误删待下载文件
  let issuedToken: string | undefined;
  let doneSent = false;
  res.on('close', () => {
    closed = true;
    ac.abort();
    if (issuedToken && !doneSent) discardReport(issuedToken);
  });

  try {
    const r = await kickoffPptStream(projectId, toolId, b.outline, (msg) => send('stage', { msg }), ac.signal);
    issuedToken = r.token;
    // close 可能早于 promise 落地（ac.abort 时 done 还没发）：此时不补删就成孤儿，close 那次已跑完了
    if (closed || res.writableEnded) {
      discardReport(r.token);
      issuedToken = undefined;
      return;
    }
    send('done', { token: r.token, fileName: r.fileName, pageCount: r.pageCount, warnings: r.warnings });
    doneSent = true;
  } catch (e) {
    send('error', { error: e instanceof Error ? e.message : String(e) });
  }
  res.end();
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

/**
 * T02300：`/import-prd` 与 `/import-prd/preview` 共用的入参归一。
 * 两条路由必须投同一份 payload 才有「预演=实落库」的可比性，所以归一逻辑也只此一份——
 * 各写一套的话，preview 的计数与实际导入会随参数面漂移而分叉（正是本单要防的）。
 */
function normalizePrdImportBody(b: Record<string, unknown>) {
  return {
    projectId: b.projectId as string,
    input: {
      requirements: Array.isArray(b.requirements) ? b.requirements as Parameters<typeof PlanService.importPrd>[1]['requirements'] : undefined,
      plans: Array.isArray(b.plans) ? b.plans as Parameters<typeof PlanService.importPrd>[1]['plans'] : undefined,
      createTasks: b.createTasks === true,
      prdMd: typeof b.prdMd === 'string' ? b.prdMd : undefined, // T00763：PRD Markdown 原文完整落库
      prdFilename: typeof b.prdFilename === 'string' ? b.prdFilename : undefined,
      // T01875：撞名计划处置口径——'reuse' 走幂等补写，其余（含缺省）保持新建并给新行加「（N）」区分后缀
      onDuplicatePlan: b.onDuplicatePlan === 'reuse' ? 'reuse' as const : undefined,
    },
  };
}

/** PRD 确认导入：事务创建需求项 + 计划（含关联）+ 可选同步生成待办任务 */
planApi.post('/import-prd', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  const { projectId, input } = normalizePrdImportBody(b);
  wrap(res, () => PlanService.importPrd(projectId, input));
});

/**
 * T02300：PRD 导入**预演**（只读，零写库）。同一份 payload 先投这里，用户在点「导入」之前就能看到
 * 本次将新建/复用/让号多少行——T01869 的「重导后两行同名、一行被读成 todo/0」之所以被误判成
 * 「原有计划被回档」，就是因为导入前连带影响完全不可见。
 */
planApi.post('/import-prd/preview', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  const { projectId, input } = normalizePrdImportBody(b);
  wrap(res, () => PlanService.previewPrdImport(projectId, input));
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

/** T02218：批量接口的 ids 参数校验——非空字符串数组且不超单次上限（超限给出分批提示） */
const MAX_BATCH_ISSUES = 100;
function batchIssueIds(res: import('express').Response, body: Record<string, unknown>): string[] | null {
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: 'ids 必须为非空字符串数组' });
    return null;
  }
  if (ids.length > MAX_BATCH_ISSUES) {
    res.status(400).json({ error: `单次批量操作上限 ${MAX_BATCH_ISSUES} 条（本次 ${ids.length} 条），请分批处理` });
    return null;
  }
  return ids;
}

/** T02218：批量回写——逐条独立（部分失败不阻断），200 响应含成功/失败逐项明细 */
planApi.post('/prd-issues/batch-writeback', (req, res) => {
  const ids = batchIssueIds(res, (req.body ?? {}) as Record<string, unknown>);
  if (!ids) return;
  wrap(res, () => PlanService.batchWritebackIssues(ids));
});

/** T02218：批量删除（逻辑删除，数据保留可恢复；操作写日志），明细同批量回写 */
planApi.post('/prd-issues/batch-delete', (req, res) => {
  const ids = batchIssueIds(res, (req.body ?? {}) as Record<string, unknown>);
  if (!ids) return;
  wrap(res, () => PlanService.batchDeleteIssues(ids));
});

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

/** T01867：项目内重复需求编号分组（存量数据体检；新导入已按顺延器不会再产生重复） */
planApi.get('/prd-requirements/duplicates', (req, res) => wrap(res, () => ({ groups: PlanService.duplicateReqNos(pid(req)) })));

planApi.delete('/prd-requirements/:id', (req, res) => wrap(res, () => PlanService.deleteRequirement(req.params.id)));

/** 关联调整：需求 ↔ 计划/待办（linked=true 建立关联，false 解除） */
planApi.post('/prd-requirements/:id/link', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  let kind: 'task' | 'plan' | null = null;
  if (b.kind === 'task') kind = 'task';
  else if (b.kind === 'plan') kind = 'plan';
  if (!kind || typeof b.targetId !== 'string' || !b.targetId) return res.status(400).json({ error: 'kind(plan|task) 与 targetId 必填' });
  wrap(res, () => { PlanService.linkRequirement(req.params.id, { kind, targetId: b.targetId as string, linked: b.linked !== false }); return { ok: true }; });
});

// ---------- T01484：测试用例（PRD-测试用例管理 §6.1~§6.3） ----------
// 注册顺序铁律：/test-cases 下的静态段（meta / coverage / batch / reorder / duplicate）
// 必须先于 /test-cases/:id——否则 GET /test-cases/meta 会被 :id 抢注成「id=meta」，
// 返回 400 用例不存在而不是枚举（验证脚本里有专门一条反向断言盯这个坑）。

/** query 都是字符串：布尔只认 true/1，数字非法值当未传（服务层再按未传走默认） */
function queryBool(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  return v === true || v === 'true' || v === '1';
}

function queryNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 关联需求字段的三态：键不存在=不改；null / '' =解除关联（服务层归一为 NULL）；字符串=挂到该需求。
 * 不能用 optStr——它把 null 也吃成 undefined，「解除关联」点一下会静默失效。
 */
function reqIdField(b: Record<string, unknown>): string | null | undefined {
  return b.reqId === undefined ? undefined : toStr(b.reqId);
}

function caseStepList(v: unknown): CaseStepInput[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => {
    const s = (x ?? {}) as Record<string, unknown>;
    return { action: optStr(s.action), expected: optStr(s.expected), stepNo: queryNum(s.stepNo) };
  });
}

/** 批量端点统一入口：ids 必须是非空字符串数组 */
function caseIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x.trim())) return null;
  return v as string[];
}

planApi.get('/test-cases/meta', (req, res) => wrap(res, () => TestCaseService.meta(pid(req))));

planApi.get('/test-cases/coverage', (req, res) => wrap(res, () => TestCaseService.coverage(pid(req))));

// T01485：工具条统计「共 N 条 · 已关联需求 M 条 · 孤儿 K 条」——服务层 stats() 已就绪，
// 但列表面向服务端分页（limit 后只拿到当页），全项目口径必须单独取，不能由前端数当页。
planApi.get('/test-cases/stats', (req, res) => wrap(res, () => TestCaseService.stats(pid(req))));

planApi.get('/test-cases', (req, res) => {
  // pid(req) 必须留在 wrap 内：它抛的是业务校验错（约定 400 + {error}），
  // 写在 wrap 外面会变成未捕获异常 → 500 + 整页堆栈，前端 toast 拿不到人话。
  wrap(res, () => {
    const q: CaseQuery = {
      projectId: pid(req),
      reqId: optStr(req.query.reqId),
      q: optStr(req.query.q),
      module: optStr(req.query.module),
      priority: optStr(req.query.priority),
      type: optStr(req.query.type),
      status: optStr(req.query.status),
      result: optStr(req.query.result),
      orphanOnly: queryBool(req.query.orphanOnly),
      limit: queryNum(req.query.limit),
      offset: queryNum(req.query.offset),
    };
    return TestCaseService.list(q);
  });
});

planApi.patch('/test-cases/batch', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = caseIds(b.ids);
  if (!ids) return res.status(400).json({ error: 'ids 需为非空字符串数组' });
  const patch = (b.patch ?? {}) as Record<string, unknown>;
  const fields: CaseBatchPatch = {
    priority: optStr(patch.priority),
    type: optStr(patch.type),
    method: optStr(patch.method),
    status: optStr(patch.status),
    lastResult: optStr(patch.lastResult),
    module: optStr(patch.module),
    reqId: patch.reqId === undefined ? undefined : toStr(patch.reqId),
  };
  wrap(res, () => TestCaseService.batchPatch(ids, fields));
});

planApi.delete('/test-cases/batch', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = caseIds(b.ids);
  if (!ids) return res.status(400).json({ error: 'ids 需为非空字符串数组' });
  wrap(res, () => TestCaseService.batchRemove(ids));
});

planApi.post('/test-cases/reorder', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = caseIds(b.ids);
  if (!ids) return res.status(400).json({ error: 'ids 需为非空字符串数组' });
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  // reqId 三态：null=仅孤儿用例范围，''/缺省=整个项目，字符串=仅该需求
  const scope = b.reqId === null ? null : optStr(b.reqId);
  wrap(res, () => TestCaseService.reorder(b.projectId as string, ids, scope));
});

planApi.post('/test-cases/duplicate', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = caseIds(b.ids);
  if (!ids) return res.status(400).json({ error: 'ids 需为非空字符串数组' });
  wrap(res, () => TestCaseService.duplicate(ids));
});

/**
 * T01492（§8.5）：草稿确认导入。路由只做「typeof 收窄 + 形态转换」，落库/幂等/事务全交 `TestCaseService.importDraft`。
 * 静态段 `import-draft` 与 `duplicate`/`batch`/`reorder` 同区——本路由是 POST，不会被 GET/PATCH/DELETE `/:id` 抢注，
 * 但仍置于 `/:id` 之前保持「静态先于参数」的注册纪律（§6.1 铁律）。
 */
planApi.post('/test-cases/import-draft', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  const projectId = b.projectId;
  if (!Array.isArray(b.cases)) return res.status(400).json({ error: 'cases 需为数组' });
  const cases = (b.cases as unknown[]).map((x) => {
    const s = (x ?? {}) as Record<string, unknown>;
    return {
      reqNo: optStr(s.reqNo), title: optStr(s.title), module: optStr(s.module),
      preconditions: optStr(s.preconditions), expected: optStr(s.expected), testData: optStr(s.testData),
      postconditions: optStr(s.postconditions), priority: optStr(s.priority), type: optStr(s.type),
      method: optStr(s.method), tags: optStr(s.tags), steps: caseStepList(s.steps),
      include: s.include === undefined ? undefined : (s.include !== false && s.include !== 'false'),
    } satisfies DraftCaseImport;
  });
  const requirements = Array.isArray(b.requirements)
    ? (b.requirements as unknown[]).map((x) => {
      const s = (x ?? {}) as Record<string, unknown>;
      return {
        reqNo: optStr(s.reqNo), title: optStr(s.title), content: optStr(s.content),
        sourceRef: optStr(s.sourceRef), priority: optStr(s.priority), isNew: queryBool(s.isNew),
      } satisfies DraftReqImport;
    })
    : [];
  const writeRequirements = b.writeRequirements === true || b.writeRequirements === 'true';
  wrap(res, () => TestCaseService.importDraft({ projectId, requirements, cases, writeRequirements }));
});

/** 用例导出 MIME（与 `web/src/utils/download.ts` 的 EXPORT_MIME 同值；服务端不引前端模块） */
const CASE_EXPORT_MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown; charset=utf-8',
};

/**
 * 按导出格式分发渲染器（嵌套三元改独立函数早返回）。
 * 构建器由调用方动态 import 后传入——保持 exceljs/docx 只在真正导出时加载。
 */
async function renderCaseExport<T>(
  format: string,
  payload: T,
  builders: { xlsx: (p: T) => Promise<Buffer>; docx: (p: T) => Promise<Buffer>; md: (p: T) => Buffer },
): Promise<Buffer> {
  if (format === 'xlsx') return await builders.xlsx(payload);
  if (format === 'docx') return await builders.docx(payload);
  return builders.md(payload);
}

/**
 * T01487：测试用例导出（§6.4）。用 POST 不用 GET：请求体要带选择集（可达上百个 id）与筛选条件。
 * 范围优先级 选中 ids > 单需求 reqId > 当前筛选 > 全量（§7.6），取数一律回到
 * `TestCaseService`——与列表同一套 `buildCaseWhere`，界面看到什么就导出什么，不在路由里另写查询。
 * `reqId` 传 `null` 与 `reorder` 同语义 = 仅孤儿用例范围。
 */
planApi.post('/test-cases/export', exportGate('testcase-export', undefined, { defer: true }), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId) return res.status(400).json({ error: 'projectId 必填' });
  const format = typeof b.format === 'string' ? b.format.toLowerCase() : '';
  if (!Object.hasOwn(CASE_EXPORT_MIME, format)) return res.status(400).json({ error: 'format 仅支持 xlsx / docx / md' });
  try {
    const projectId = b.projectId;
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())) : [];
    const cases = ids.length > 0
      ? TestCaseService.byIds(ids)
      : TestCaseService.list({
        projectId,
        reqId: b.reqId === null ? undefined : optStr(b.reqId),
        q: optStr(b.q),
        module: optStr(b.module),
        priority: optStr(b.priority),
        type: optStr(b.type),
        status: optStr(b.status),
        result: optStr(b.result),
        orphanOnly: b.reqId === null || b.orphanOnly === true || b.orphanOnly === 'true',
        limit: 0, // 「全部」模式：导出不能只出当页（服务层自有 MAX_PAGE_SIZE 护栏）
        offset: 0,
      }).items;
    const project = PlanService.getProjectBrief(projectId);
    const { buildCaseDocx, buildCaseMd, buildCaseXlsx } = await import('../services/testCaseExport'); // 按需加载 exceljs/docx
    const payload = { projectName: project.name, cases, coverage: TestCaseService.coverage(projectId) };
    const buf = await renderCaseExport(format, payload, { xlsx: buildCaseXlsx, docx: buildCaseDocx, md: buildCaseMd });
    const ymd = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const fname = safeExportName(`测试用例-${project.name}-${ymd}`, '测试用例') + `.${format}`;
    res.setHeader('Content-Type', CASE_EXPORT_MIME[format]);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

planApi.get('/test-cases/:id', (req, res) => wrap(res, () => TestCaseService.get(req.params.id)));

planApi.post('/test-cases', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.projectId !== 'string' || !b.projectId || typeof b.title !== 'string' || !b.title.trim()) {
    return res.status(400).json({ error: 'projectId 与 title 必填' });
  }
  const input: CaseInput = {
    projectId: b.projectId,
    title: b.title,
    reqId: reqIdField(b),
    caseNo: optStr(b.caseNo),
    module: optStr(b.module),
    preconditions: optStr(b.preconditions),
    expected: optStr(b.expected),
    testData: optStr(b.testData),
    postconditions: optStr(b.postconditions),
    priority: optStr(b.priority),
    type: optStr(b.type),
    method: optStr(b.method),
    status: optStr(b.status),
    lastResult: optStr(b.lastResult),
    tags: optStr(b.tags),
    sourceKey: optStr(b.sourceKey),
    sourceHash: optStr(b.sourceHash),
    sortOrder: queryNum(b.sortOrder),
    steps: caseStepList(b.steps),
  };
  wrap(res, () => TestCaseService.create(input));
});

planApi.patch('/test-cases/:id', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: CasePatch = {
    title: optStr(b.title),
    caseNo: optStr(b.caseNo),
    module: optStr(b.module),
    preconditions: optStr(b.preconditions),
    expected: optStr(b.expected),
    testData: optStr(b.testData),
    postconditions: optStr(b.postconditions),
    tags: optStr(b.tags),
    reqId: reqIdField(b),
    priority: optStr(b.priority),
    type: optStr(b.type),
    method: optStr(b.method),
    status: optStr(b.status),
    lastResult: optStr(b.lastResult),
    sortOrder: queryNum(b.sortOrder),
    sourceKey: optStr(b.sourceKey),
    sourceHash: optStr(b.sourceHash),
    steps: caseStepList(b.steps),
  };
  wrap(res, () => TestCaseService.update(req.params.id, patch));
});

planApi.delete('/test-cases/:id', (req, res) => wrap(res, () => TestCaseService.remove(req.params.id)));

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

// T01874：彻底删除不可逆，前端先取连带影响（派生待办归档数 / 需求关联失配数）写进确认文案；DELETE 回传实际破坏面
planApi.get('/:id/purge-impact', (req, res) => wrap(res, () => PlanService.purgeImpact(req.params.id)));
planApi.delete('/:id', (req, res) => wrap(res, () => PlanService.purge(req.params.id)));

// ---------- 归档（T00442 扩展：删除改归档，归档菜单提供恢复/彻底删除） ----------
// T02284：归档区是增长最快的数据集之一，补 limit/offset + keyword/projectId 服务端筛选（口径同 /tasks：
// 显式 limit 钳 [1,500]、缺省=全量以兼容 MCP 与验收脚本）；`total=1` 加性通道换成 {items,total} 信封，
// 不带该参数时响应体逐字仍是裸数组。
planApi.get('/archived', (req, res) => wrap(res, () => {
  const { limit, offset, keyword, projectId, total } = req.query;
  const opts = {
    keyword: typeof keyword === 'string' && keyword.trim() ? keyword.trim() : undefined,
    projectId: typeof projectId === 'string' && projectId ? projectId : undefined,
    limit: parseLimit(limit),
    offset: parseOffset(offset),
  };
  const items = PlanService.listArchived(opts);
  if (wantsTotal(total)) return { items, total: PlanService.countArchived(opts) };
  return items;
}));
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

// T01058 后续 / T02122：计划行复杂度批量补算 + 值域断言。
// complexity 只在 PRD 导入时由 AI 给出，手工/Excel 导入与存量行恒为 NULL——
// 「复杂度 ≥4 建议拆分」的提示对这些行不生效，故提供批量补算入口（按批调用，非逐条）。
// T02122：响应体增加 invalid 计数，暴露「未归档行 complexity 非空但落在 1~5 之外」的非法行数量。
planApi.get('/complexity/missing', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) { res.status(400).json({ error: 'projectId 必填' }); return; }
  wrap(res, () => ({ count: listMissingComplexity(projectId).length, invalid: listInvalidComplexity(projectId).length }));
});
planApi.post('/complexity/backfill', async (req, res) => {
  const { toolId, projectId, force, ids, batch } = (req.body ?? {}) as { toolId?: unknown; projectId?: unknown; force?: unknown; ids?: unknown; batch?: unknown };
  if (typeof toolId !== 'string' || !toolId) { res.status(400).json({ error: 'toolId 必填' }); return; }
  if (typeof projectId !== 'string' || !projectId) { res.status(400).json({ error: 'projectId 必填' }); return; }
  try {
    const r = await backfillComplexity(toolId, projectId, {
      force: force === true,
      ids: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : undefined,
      batch: Number.isFinite(Number(batch)) ? Number(batch) : undefined,
    });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
