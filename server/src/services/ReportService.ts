import { getDb } from '../db/connection';
import { join } from 'node:path';
import { mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AIService } from './AIService';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';
import { getSetting } from './AppSettings';
import { INBOX_PROJECT_ID } from './AppSettings';
import { logService } from './LogService';

/** 报表周期：day=日报 / week=周报 / month=月报 */
export type ReportPeriod = 'day' | 'week' | 'month';
/** 输出格式：xlsx / docx / pdf / pptx */
export type ReportFormat = 'xlsx' | 'docx' | 'pdf' | 'pptx';

export interface ReportTaskRow {
  project: string;
  title: string;
  priority: string;
  status: string;
  verified: boolean;
  category: string;
  updatedAt: string;
  summary: string;
  /** 任务「处理结果」：AI 回传的根因/方案/验证结论，供经验教训类分析提炼复用 */
  handleResult: string;
}

export interface ReportProject {
  name: string;
  total: number;
  todo: number;
  done: number;
  verified: number;
  high: number;
  medium: number;
  low: number;
}

export interface ReportPlanRow {
  title: string;
  status: string;
  startDate: string;
  endDate: string;
  progress: number;
  project: string;
  /** 已过期（end_date < 今天）且未完成 */
  overdue: boolean;
}

export interface ReportData {
  period: ReportPeriod;
  periodLabel: string;
  startDate: string;
  endDate: string;
  generatedAt: string;
  projects: ReportProject[];
  tasks: ReportTaskRow[];
  /** T00452 / PRD INT-3：项目计划执行情况（本期有活动或已过期未完成），供周报联动展示 */
  plans: ReportPlanRow[];
}

/** 用户导入模板存放目录（与应用数据同目录，避免重装丢失） */
function templatesDir(): string {
  const dir = process.env.MTask_DATA_DIR ?? join(__dirname, '..', 'data');
  const t = join(dir, 'templates');
  mkdirSync(t, { recursive: true });
  return t;
}

/** AI 周报洞察生成限时：洞察+文件合成链路耗时长，给足 5 分钟，覆盖工具默认较短 timeoutMs */
const AI_REPORT_TIMEOUT = 5 * 60 * 1000;

/** AI 周报：输出格式 → 内置 SKILL 及其版式规范（与前端内置技能展示一致，供注入 AI 生成指令） */
const SKILL_BY_FORMAT: Record<ReportFormat, { name: string; desc: string }> = {
  xlsx: { name: 'xlsx-trae', desc: 'Excel 版式规范：浅表头填充、斑马纹、细浅边框、合计加粗强调' },
  docx: { name: 'docx-trae', desc: 'Word 文档规范：结构化标题、汇总表加粗表头' },
  pdf: { name: 'pdf-trae', desc: 'PDF 处理技能（内置资源，供参考）' },
  pptx: { name: 'pptx-trae', desc: '演示文稿技能（内置资源，供参考）' },
};

/** AI 周报生成临时文件目录（与应用数据同目录，下载即删） */
function reportTmpDir(): string {
  const dir = process.env.MTask_DATA_DIR ?? join(__dirname, '..', 'data');
  const t = join(dir, 'tmp');
  mkdirSync(t, { recursive: true });
  return t;
}

/** 校验临时下载令牌是否为合法的 UUID，防任意路径读取 */
export function isReportToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

/** 读取并删除 AI 周报临时文件，返回 buffer；不存在返回 undefined */
export function readAndDeleteReport(token: string): Buffer | undefined {
  const p = join(reportTmpDir(), token);
  if (!existsSync(p)) return undefined;
  const buf = readFileSync(p);
  try { unlinkSync(p); } catch { /* 忽略删除失败 */ }
  return buf;
}

/** 解析周期时间范围 [start, end)：按本地时区取当日 0 点，避免跨日误判 */
function periodRange(period: ReportPeriod): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'day') {
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) };
  }
  if (period === 'week') {
    // 以周一为一周起点；getDay() 0=周日，退回前 6 天；周报上界为下周一 0 点
    const offset = (now.getDay() + 6) % 7;
    const monday = new Date(start);
    monday.setDate(start.getDate() - offset);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    return { start: monday, end: nextMonday };
  }
  return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
}

const PERIOD_LABEL: Record<ReportPeriod, string> = { day: '日报', week: '周报', month: '月报' };
/** 优先级文本（与界面一致）：报表内展示中文，raw 值兜底 */
const PRIORITY_TEXT: Record<string, string> = { low: '低', normal: '中', high: '高' };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

interface TaskRow {
  project: string;
  title: string;
  priority: string;
  status: string;
  verified: number;
  updated_at: string;
  ai_summary: string | null;
  handle_result: string | null;
  category: string | null;
}

/** 聚合指定周期内任务数据（按 updated_at 落在区间判定，即该周期内有活动的任务） */
export function gatherReportData(period: ReportPeriod, projectId?: string): ReportData {
  const db = getDb();
  const { start, end } = periodRange(period);
  // updated_at 以 UTC ISO 落库，边界转成同一坐标系（toISOString）做字典序比较，避免本地日期串与 ISO 不匹配
  const s = start.toISOString();
  const e = end.toISOString();
  const params = projectId ? [s, e, projectId] : [s, e];
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.priority, t.status, t.verified, t.updated_at, t.ai_summary, t.handle_result, t.category_id,
              p.name AS project, c.name AS category
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN task_categories c ON c.id = t.category_id
       WHERE t.archived = 0 AND t.updated_at >= ? AND t.updated_at < ?
       ${projectId ? 'AND t.project_id = ?' : ''}
       ORDER BY p.sort_weight, t.priority`,
    )
    .all(...params) as TaskRow[];

  // 按项目聚合统计（保持 DU 顺序一致）
  const projMap = new Map<string, ReportProject>();
  const tasks: ReportTaskRow[] = rows.map((r) => {
    const p = projMap.get(r.project) ?? { name: r.project, total: 0, todo: 0, done: 0, verified: 0, high: 0, medium: 0, low: 0 };
    p.total += 1;
    if (r.status === 'todo') p.todo += 1;
    else p.done += 1;
    if (r.verified) p.verified += 1;
    if (r.priority === 'high') p.high += 1;
    else if (r.priority === 'medium' || r.priority === 'normal') p.medium += 1;
    else p.low += 1;
    projMap.set(r.project, p);
    return {
      project: r.project,
      title: r.title,
      priority: PRIORITY_TEXT[r.priority] ?? r.priority,
      status: r.status === 'todo' ? '待办' : '已完成',
      verified: !!r.verified,
      category: r.category ?? '',
      updatedAt: r.updated_at,
      summary: r.ai_summary ?? '',
      // 处理结果通常较长，注入时截断到 600 字内防止 prompt 长度失控，同时保留提炼所需核心信息
      handleResult: (r.handle_result ?? '').slice(0, 600),
    };
  });

  // T00452 / PRD INT-3：项目计划执行情况——本期有变动的计划 + 已过期未完成的计划（延期）
  const planRows = db
    .prepare(
      `SELECT pt.title, pt.status, pt.start_date, pt.end_date, pt.progress, pt.updated_at, pr.name AS project
       FROM plan_tasks pt
       JOIN projects pr ON pr.id = pt.project_id
       WHERE pt.archived = 0
       ${projectId ? 'AND pt.project_id = ?' : ''}
       ORDER BY pr.sort_weight, pt.sort_order`,
    )
    .all(...(projectId ? [projectId] : [])) as Array<{
    title: string; status: string; start_date: string; end_date: string; progress: number; updated_at: string; project: string;
  }>;
  const todayStr = ymd(new Date());
  const plans: ReportPlanRow[] = planRows
    .filter((r) => r.updated_at >= s || (r.status !== 'done' && r.end_date < todayStr))
    .map((r) => ({
      title: r.title, status: r.status, startDate: r.start_date, endDate: r.end_date,
      progress: r.progress, project: r.project, overdue: r.status !== 'done' && r.end_date < todayStr,
    }));

  return {
    period,
    periodLabel: PERIOD_LABEL[period],
    startDate: ymd(start),
    endDate: ymd(end),
    generatedAt: nowStr(),
    projects: [...projMap.values()],
    tasks,
    plans,
  };
}

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// 报表构建 worker 池：把 CPU 密集的文件合成（exceljs/docx/pptxgenjs/pdfkit）
// 移出 Node 主事件循环，避免生成大报表时阻塞所有其它 API（health 排队超时）。
// 单 worker 串行构建：天然避免多任务 CPU 竞争；worker 复用使大依赖只加载一次。
// ---------------------------------------------------------------------------
interface BuildRequest {
  format: ReportFormat;
  data: ReportData;
  templateBuf?: Buffer;
  aiInsight?: string;
}

let buildWorker: Worker | null = null;
let building = false;
const buildQueue: Array<{ req: BuildRequest; resolve: (b: Buffer) => void; reject: (e: Error) => void }> = [];

/** worker 路径：打包/生产态（dist）为 .js，dev 态（tsx 跑 src）为 .ts */
function workerPath(): string {
  const js = join(__dirname, 'report-worker.js');
  return existsSync(js) ? js : join(__dirname, 'report-worker.ts');
}

function ensureWorker(): Worker {
  if (buildWorker) return buildWorker;
  const w = new Worker(workerPath());
  w.on('message', (msg: { buffer?: Buffer; error?: string }) => {
    building = false;
    const task = buildQueue.shift();
    if (msg?.error) task?.reject(new Error(msg.error));
    else if (msg?.buffer) task?.resolve(Buffer.from(msg.buffer));
    else task?.reject(new Error('报表 worker 返回空结果'));
    pump();
  });
  // worker 异常退出：丢弃当前任务并销毁，下次请求自动重建
  w.on('error', (e) => {
    building = false;
    buildQueue.shift()?.reject(e);
    // terminate() 返回 Promise，同步 try/catch 捕不到其 rejection，必须用 .catch 兜底
    w.terminate().catch(() => { /* worker 已异常退出，销毁失败无需处理，下次请求会重建 */ });
    buildWorker = null;
    pump();
  });
  buildWorker = w;
  return w;
}

/** 串行泵：无在途任务且有排队任务时，投递给 worker */
function pump(): void {
  if (building || buildQueue.length === 0) return;
  const task = buildQueue[0];
  building = true;
  const w = ensureWorker();
  w.postMessage({
    format: task.req.format,
    data: task.req.data,
    templateBuf: task.req.templateBuf,
    aiInsight: task.req.aiInsight,
  });
}

function buildInWorker(req: BuildRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    buildQueue.push({ req, resolve, reject });
    pump();
  });
}

/** 生成报表，返回文件 buffer 与建议文件名 */
export async function generateReport(
  period: ReportPeriod,
  format: ReportFormat,
  opts: { projectId?: string; templateId?: string } = {},
): Promise<{ buffer: Buffer; filename: string }> {
  const data = gatherReportData(period, opts.projectId);
  let templateBuf: Buffer | undefined;
  if (opts.templateId) {
    const tpl = join(templatesDir(), opts.templateId);
    templateBuf = readFileOrUndefined(tpl);
  }
  const buffer = await buildInWorker({ format, data, templateBuf });
  const ext = format;
  return { buffer, filename: `MTask-${data.periodLabel}-${data.startDate}.${ext}` };
}

/**
 * AI 周报生成：gatherReportData 取真实周期数据 → 经 AIService 调 LLM（注入匹配格式的内置 SKILL 版式规范）
 * 产出洞察正文 → worker 中把「真实数据 + AI 洞察」合成为指定格式文件。
 * 文件落临时目录返回下载令牌，下载即删。
 */
export async function aiGenerateReport(
  period: ReportPeriod,
  format: ReportFormat,
  opts: { projectId?: string; toolId: string },
): Promise<{ token: string; filename: string; insight: string }> {
  const data = gatherReportData(period, opts.projectId);
  const skill = SKILL_BY_FORMAT[format];
  const system = [
    '你是 MTask 的 AI 周报分析师。任务：基于给定周期的真实任务数据，遵循指定内置 SKILL 的版式规范，撰写一份专业、简洁、结构化的中文周报洞察（Markdown 正文）。',
    '要求：',
    '1. 严格依据提供的数据，不得虚构、不得使用占位或模拟数据',
    '2. 内容依次包含：① 本周概况与总体结论；② 各项目进展要点；③ 重点工作与高风险项；④ 下周建议',
    '3. 只输出洞察正文 Markdown，不要代码围栏、不要任何前置说明或寒暄',
    // 周报为面向用户的中文交付物，显式锁定简体，避免随任务数据(可能含繁体)连带输出繁体
    '4. 输出统一使用简体中文（简体字），严禁任何繁体字',
  ].join('\n');
  const user = [
    `【内置 SKILL】${skill.name}：${skill.desc}`,
    `【周期】${data.periodLabel} ${data.startDate} ~ ${data.endDate}`,
    `【项目汇总】${JSON.stringify(data.projects)}`,
    `【任务明细】${JSON.stringify(data.tasks)}`,
    ...(data.plans.length > 0 ? [`【项目计划执行情况】${JSON.stringify(data.plans)}（含延期标记 overdue，请纳入进展要点与风险分析）`] : []),
  ].join('\n\n');
  const res = await AIService.ask(opts.toolId, system, user, AI_REPORT_TIMEOUT);
  if (!res.ok || !res.content?.trim()) throw new Error(res.error ?? 'AI 生成失败');
  const insight = res.content.trim();
  const buffer = await buildInWorker({ format, data, aiInsight: insight });
  const token = randomUUID();
  writeFileSync(join(reportTmpDir(), token), buffer);
  // T00443 / PRD AI-5：摘要推送（可配置，默认关）——AI 周报生成后把摘要写入收件箱项目任务
  if (getSetting('report.aiSummaryToInbox') === '1') {
    try {
      const db = getDb();
      const tid = randomUUID();
      const t = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, verified, archived, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'normal', 'todo', 0, 0, 0, ?, ?)`,
      ).run(tid, INBOX_PROJECT_ID, `[周报摘要] ${data.periodLabel} ${data.startDate}~${data.endDate}`, insight.slice(0, 4000), t, t);
      logService.log('INFO', 'ai', `[周报摘要推送] 已写入收件箱任务（${data.periodLabel}）`);
    } catch (e) {
      logService.log('ERROR', 'ai', `[周报摘要推送] 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { token, filename: `MTask-AI-${data.periodLabel}-${data.startDate}.${format}`, insight };
}

/**
 * AI 周报生成（流式版）：链路与 aiGenerateReport 一致，但通过 onStage 推送阶段进度、onChunk 逐片推送 AI 洞察正文。
 * 供 SSE 路由实时转发到前端 AI 控制台，实现"按钮联动控制台 + 流式滚动输出"。
 */
export async function aiGenerateReportStream(
  period: ReportPeriod,
  format: ReportFormat,
  opts: { projectId?: string; toolId: string },
  onStage: (msg: string) => void,
  onChunk: (text: string) => void,
): Promise<{ token: string; filename: string; insight: string }> {
  onStage(`正在聚合${PERIOD_LABEL[period]}任务数据…`);
  const data = gatherReportData(period, opts.projectId);
  const skill = SKILL_BY_FORMAT[format];
  onStage(`已聚合 ${data.projects.length} 个项目 / ${data.tasks.length} 条任务，正在调用模型生成洞察…`);
  const system = [
    '你是 MTask 的 AI 周报分析师。任务：基于给定周期的真实任务数据，遵循指定内置 SKILL 的版式规范，撰写一份专业、简洁、结构化的中文周报洞察（Markdown 正文）。',
    '要求：',
    '1. 严格依据提供的数据，不得虚构、不得使用占位或模拟数据',
    '2. 内容依次包含：① 本周概况与总体结论；② 各项目进展要点；③ 重点工作与高风险项；④ 下周建议',
    '3. 只输出洞察正文 Markdown，不要代码围栏、不要任何前置说明或寒暄',
    // 周报为面向用户的中文交付物，显式锁定简体，避免随任务数据(可能含繁体)连带输出繁体
    '4. 输出统一使用简体中文（简体字），严禁任何繁体字',
  ].join('\n');
  const user = [
    `【内置 SKILL】${skill.name}：${skill.desc}`,
    `【周期】${data.periodLabel} ${data.startDate} ~ ${data.endDate}`,
    `【项目汇总】${JSON.stringify(data.projects)}`,
    `【任务明细】${JSON.stringify(data.tasks)}`,
    ...(data.plans.length > 0 ? [`【项目计划执行情况】${JSON.stringify(data.plans)}（含延期标记 overdue，请纳入进展要点与风险分析）`] : []),
  ].join('\n\n');
  const res = await AIService.askStream(opts.toolId, system, user, onChunk, AI_REPORT_TIMEOUT);
  if (!res.ok || !res.content?.trim()) throw new Error(res.error ?? 'AI 生成失败');
  const insight = res.content.trim();
  onStage('洞察生成完成，正在按内置 skill 版式合成文件…');
  // worker 异步合成：主事件循环不被阻塞，SSE 仍可推送/响应其它请求
  const buffer = await buildInWorker({ format, data, aiInsight: insight });
  const token = randomUUID();
  writeFileSync(join(reportTmpDir(), token), buffer);
  onStage('文件已生成，可在左侧下载。');
  // T00443 / PRD AI-5：流式版同样支持摘要推送（可配置）
  if (getSetting('report.aiSummaryToInbox') === '1') {
    try {
      const db = getDb();
      const tid = randomUUID();
      const t = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, verified, archived, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'normal', 'todo', 0, 0, 0, ?, ?)`,
      ).run(tid, INBOX_PROJECT_ID, `[周报摘要] ${data.periodLabel} ${data.startDate}~${data.endDate}`, insight.slice(0, 4000), t, t);
      logService.log('INFO', 'ai', `[周报摘要推送] 已写入收件箱任务（${data.periodLabel}，流式）`);
    } catch (e) {
      logService.log('ERROR', 'ai', `[周报摘要推送] 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { token, filename: `MTask-AI-${data.periodLabel}-${data.startDate}.${format}`, insight };
}

function readFileOrUndefined(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

// ---------- 模板管理 ----------
export interface ReportTemplateMeta {
  id: string;
  filename: string;
  format: ReportFormat;
  size: number;
}

/** 列出已导入模板（仅 .xlsx/.docx）；读多写少，5s TTL + 上传/删除主动失效 */
export function listTemplates(): ReportTemplateMeta[] {
  const cached = cacheGet<ReportTemplateMeta[]>('report-templates');
  if (cached) return cached;
  const dir = templatesDir();
  const list = readdirSync(dir)
    .filter((f) => /\.(xlsx|docx)$/i.test(f))
    .map((f) => {
      const st = statSync(join(dir, f));
      const ext = (f.split('.').pop() ?? '').toLowerCase() as ReportFormat;
      return { id: f, filename: f, format: ext, size: st.size };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
  cacheSet('report-templates', list, 5000);
  return list;
}

/** 校验并保存导入模板；非法格式返回 false */
export function saveTemplate(filename: string, data: Buffer): boolean {
  const base = filename.replaceAll('\\', '/').split('/').pop() ?? filename;
  if (!/\.(xlsx|docx)$/i.test(base)) return false;
  // 仅允许安全字符，避免路径穿越
  if (!/^[\w\-.()·\u4e00-\u9fa5 ]+\.(xlsx|docx)$/i.test(base)) return false;
  // 大小限制 10MB
  if (data.length > 10 * 1024 * 1024) return false;
  writeFileSync(join(templatesDir(), base), data);
  cacheClear('report-templates'); // 模板列表缓存失效
  return true;
}

/** 删除模板 */
export function deleteTemplate(id: string): boolean {
  const dir = templatesDir();
  if (!/\.(xlsx|docx)$/i.test(id) || id.includes('/') || id.includes('\\')) return false;
  unlinkSync(join(dir, id));
  cacheClear('report-templates'); // 模板列表缓存失效
  return true;
}
