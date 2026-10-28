import { getDb } from '../db/connection';
import { join } from 'node:path';
import { mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AIService } from './AIService';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';
import { getSetting, INBOX_PROJECT_ID } from './AppSettings';
import { logService } from './LogService';
import { resolveCustomWindow, type CustomRange } from './summaryPptPeriod';
import { buildReportProvenance, HANDLE_RESULT_LIMIT, type ReportProvenance } from './reportProvenance';
import { recordArtifact, type AiArtifact } from './aiArtifactService';
import { PREFLIGHT_ESTIMATE_MODEL, PROXY_METRIC_NOTICE, assessAiRunDeviation, estimateOutputRun, type PreflightEstimate, type RunUsageDeviation } from './preflightEstimate';

/** T03243（AI-102④）：报表这张 AI 卡片的稳定 key——ai_usage 归属与历史回看同源 */
export const AI_REPORT_CARD = 'ai.weekly_report';

/** T03243（AI-102②）：一次生成的实际用量（字符量/耗时来自 AIService 同一份计数，调用次数单列） */
export interface AiRunUsage {
  calls: number;
  chars: number;
  seconds: number;
}

/** 报表周期：day=日报 / week=周报 / month=月报 */
export type ReportPeriod = 'day' | 'week' | 'month';
/**
 * T02852（六期 S1）：总结汇报卡片在既有三档之外多一档 custom（自定义区间）。
 * 既有报表入口（`generateReport` / `aiGenerateReport` / 控制台队列）仍只收 `ReportPeriod`，
 * custom 仅由 `periodRange` / `gatherReportData` 这层参数化通道流入。
 */
export type SummaryPeriod = ReportPeriod | 'custom';
/**
 * `periodRange` 的返回形状：`end` 是取数用右开界（次日 0 点），`endInclusive` 是展示用「含」的上界。
 * T02944（裁决甲）：三档与 custom 都给出 `endInclusive`，展示层与 AI prompt 统一用「含」的那天。
 */
export type PeriodRange = { start: Date; end: Date; endInclusive: Date };
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
  period: SummaryPeriod;
  periodLabel: string;
  startDate: string;
  /** 展示用结束日，**含**这一天**（T02944 裁决甲；SQL 取数仍是左闭右开，与此无关） */
  endDate: string;
  generatedAt: string;
  projects: ReportProject[];
  tasks: ReportTaskRow[];
  /** T00452 / PRD INT-3：项目计划执行情况（本期有活动或已过期未完成），供周报联动展示 */
  plans: ReportPlanRow[];
  /**
   * T02165：多项目聚合范围（按用户勾选顺序的项目名）。
   * 仅在勾选 >1 个项目时写入——单选/全部保持 undefined，标题与既有报表版式逐字不变
   * （既有 PDF/表格门禁断言依赖单项目标题串，范围行只在多项目下才出现）。
   */
  projectScope?: string[];
  /** T03240（AI-101 ①）：因 600 字上限被截断「处理结果」的任务条数——溯源段据此说明「不完整」 */
  truncatedTasks?: number;
}

/** T02165：一次聚合的项目数上限——报表与 AI prompt 随项目数线性膨胀，超限直接拒绝而非静默截断 */
export const REPORT_PROJECT_MAX = 8;

/** 报表项目范围：不传/空 = 全部项目；字符串 = 单项目（旧口径）；数组 = 多项目聚合 */
export type ReportScope = string | string[] | undefined;

/** 范围归一：剔除空串与重复项，保留传入顺序（报表按此顺序分块展示各项目） */
export function normalizeScope(scope: ReportScope): string[] {
  if (scope == null) return [];
  const raw = Array.isArray(scope) ? scope : [scope];
  const out: string[] = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * T02165：多项目范围校验（路由/MCP 入口共用）。
 * 返回 `{ ids, error }`，error 是可直接回给前端的中文文案：
 * 空范围 = 全部项目（旧行为）；非字符串项、超上限、不存在的 id 各自点名——
 * 尤其「不存在的 id」不能静默丢掉，否则「勾了 3 个只出 2 个」无从排查。
 */
export function validateProjectIds(scope: ReportScope): { ids: string[]; error?: string } {
  if (scope == null || scope === '') return { ids: [] };
  const raw = Array.isArray(scope) ? scope : [scope];
  if (raw.some((v) => typeof v !== 'string')) return { ids: [], error: 'projectIds 需为项目 id 字符串数组' };
  const ids = normalizeScope(scope);
  if (ids.length === 0) return { ids: [] };
  if (ids.length > REPORT_PROJECT_MAX) {
    return { ids: [], error: `一次最多聚合 ${REPORT_PROJECT_MAX} 个项目，当前选择了 ${ids.length} 个` };
  }
  const db = getDb();
  const found = new Set(
    (db
      .prepare(`SELECT id FROM projects WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: string }>).map((r) => r.id),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) return { ids: [], error: `项目不存在或已删除：${missing.join('、')}` };
  return { ids };
}

/** 按 ids 顺序取项目名（不存在的跳过），供多项目标题/范围行展示 */
function projectNamesInOrder(db: ReturnType<typeof getDb>, ids: string[]): string[] {
  const rows = db
    .prepare(`SELECT id, name FROM projects WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Array<{ id: string; name: string }>;
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
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

/**
 * 生成物落盘单源（纠偏 C3）：随机 UUID 即下载令牌，文件落在数据目录 tmp 下，下载即删。
 * 启动会 PPT 等新链路必须走这里，不再各自内联 randomUUID+writeFileSync（令牌形态一旦分叉，
 * isReportToken 白名单与下载端点就要到处加特例）。
 */
export function saveReportBuffer(buffer: Buffer): string {
  const token = randomUUID();
  writeFileSync(join(reportTmpDir(), token), buffer);
  return token;
}

/** 读取并删除 AI 周报临时文件，返回 buffer；不存在返回 undefined */
export function readAndDeleteReport(token: string): Buffer | undefined {
  const p = join(reportTmpDir(), token);
  if (!existsSync(p)) return undefined;
  const buf = readFileSync(p);
  try { unlinkSync(p); } catch { /* 忽略删除失败 */ }
  return buf;
}

/** 放弃令牌（中止/无人接收 done）时立即回收落盘文件；失败不抛——清扫定时器仍是兜底 */
export function discardReport(token: string): boolean {
  try {
    unlinkSync(join(reportTmpDir(), token));
    return true;
  } catch {
    return false;
  }
}

/**
 * T02144：令牌文件的生命周期此前只有「写入」与「下载即删」两端，缺「过期/放弃回收」第三端——
 * 生成后不下载即切走、或中止落在落盘之后，令牌随组件状态归零丢失，文件成为永久孤儿（tmp 单调增长）。
 * 清扫只碰 tmp 下 UUID 命名的令牌文件（与 isReportToken 同一把白名单钥匙），目录内其他东西一律不动。
 */
export const REPORT_TMP_TTL_MS = 6 * 60 * 60 * 1000;

/** 删除超过 TTL 的令牌文件，返回删除数（now 可注入供测试） */
export function sweepReportTmp(ttlMs = REPORT_TMP_TTL_MS, now = Date.now()): number {
  const dir = reportTmpDir();
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!isReportToken(name)) continue;
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs < ttlMs) continue;
      unlinkSync(p);
      removed += 1;
    } catch { /* 单文件失败（占用/权限）不中断整轮 */ }
  }
  return removed;
}

/** 启动清一轮 + 每小时兜底（与 T01061 备份/T01064 事件保留期同一启动定时家族） */
export function startReportTmpSweeper(intervalMs = 3_600_000): ReturnType<typeof setInterval> {
  const run = () => {
    try {
      const n = sweepReportTmp();
      if (n > 0) console.log(`[mtask] report-tmp sweep: ${n} abandoned export file(s) removed`);
    } catch (e) {
      console.error('[mtask] report-tmp sweep failed:', e);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.(); // 清扫不该拖住进程退出
  return timer;
}

/**
 * 解析周期时间范围 [start, end)：按本地时区取当日 0 点，避免跨日误判。
 * T02852（六期 S1）：`period === 'custom'` 时走 `resolveCustomWindow`（区间口径与校验文案
 * 单源在 `summaryPptPeriod.ts`），**前三档的计算逐字不变**；`nowMs` 只为回归门提供可注入的
 * 取样时刻，不传时与旧实现同为 `new Date()`。
 * T02944（裁决甲）：三档也返回 `endInclusive`（今天 / 本周日 / 本月末）供展示与 AI prompt；
 * `start`/`end` 的 SQL 右开口径不变，取数结果逐字不变。
 */
export function periodRange(period: SummaryPeriod, custom?: CustomRange, nowMs?: number): PeriodRange {
  if (period === 'custom') return resolveCustomWindow(custom, { nowMs });
  const now = new Date(nowMs ?? Date.now());
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  /** 右开界前一天 0 点：展示用「含」的上界（本地时区，跨月/跨年由构造器归一） */
  const dayBefore = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  if (period === 'day') {
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return { start, end, endInclusive: start };
  }
  if (period === 'week') {
    // 以周一为一周起点；getDay() 0=周日，退回前 6 天；周报上界为下周一 0 点
    const offset = (now.getDay() + 6) % 7;
    const monday = new Date(start);
    monday.setDate(start.getDate() - offset);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    return { start: monday, end: nextMonday, endInclusive: dayBefore(nextMonday) };
  }
  // T02157：月报起点必须是**本月 1 号 0 点**——此前误用「今日 0 点」，区间变成
  // [今天, 下月1日)，既丢掉本月已发生的绝大部分活动，又混进尚未发生的未来日期
  const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
  const monthEnd = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { start: monthStart, end: monthEnd, endInclusive: dayBefore(monthEnd) };
}

const PERIOD_LABEL: Record<ReportPeriod, string> = { day: '日报', week: '周报', month: '月报' };
/**
 * T02852：custom 档的周期名（供 `periodLabel` 与导出文件名）。既有三档文案逐字不变。
 */
export const SUMMARY_PERIOD_LABEL = '阶段汇报';
export const periodLabelOf = (period: SummaryPeriod): string => (period === 'custom' ? SUMMARY_PERIOD_LABEL : PERIOD_LABEL[period]);
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

/**
 * 聚合指定周期内任务数据（按 updated_at 落在区间判定，即该周期内有活动的任务）。
 * T02165：第二参从单个 projectId 放宽为 string | string[]——数组用 `project_id IN (…)` 聚合多项目，
 * 单串与不传分别等价于旧的「单项目」「全部项目」口径，SQL 与返回结构不变。
 * T02852（六期 S1）：第一参放宽为 `SummaryPeriod`，`'custom'` 时由第三参 `custom` 提供区间；
 * 既有三档的 SQL、边界折算与返回结构与改动前逐字一致（回归由 verify-t02852 钉住）。
 */
export function gatherReportData(period: SummaryPeriod, projectScope?: ReportScope, custom?: CustomRange): ReportData {
  const db = getDb();
  const ids = normalizeScope(projectScope);
  const { start, end, endInclusive } = periodRange(period, custom);
  // updated_at 以 UTC ISO 落库，边界转成同一坐标系（toISOString）做字典序比较，避免本地日期串与 ISO 不匹配
  const s = start.toISOString();
  const e = end.toISOString();
  const taskFilter = ids.length > 0 ? `AND t.project_id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.priority, t.status, t.verified, t.updated_at, t.ai_summary, t.handle_result, t.category_id,
              p.name AS project, c.name AS category
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN task_categories c ON c.id = t.category_id
       WHERE t.archived = 0 AND t.updated_at >= ? AND t.updated_at < ?
       ${taskFilter}
       ORDER BY p.sort_weight, t.priority`,
    )
    .all(s, e, ...ids) as TaskRow[];

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
  const planFilter = ids.length > 0 ? `AND pt.project_id IN (${ids.map(() => '?').join(',')})` : '';
  const planRows = db
    .prepare(
      `SELECT pt.title, pt.status, pt.start_date, pt.end_date, pt.progress, pt.updated_at, pr.name AS project
       FROM plan_tasks pt
       JOIN projects pr ON pr.id = pt.project_id
       WHERE pt.archived = 0
       ${planFilter}
       ORDER BY pr.sort_weight, pt.sort_order`,
    )
    .all(...ids) as Array<{
    title: string; status: string; start_date: string; end_date: string; progress: number; updated_at: string; project: string;
  }>;
  const todayStr = ymd(new Date());
  const plans: ReportPlanRow[] = planRows
    .filter((r) => r.updated_at >= s || (r.status !== 'done' && r.end_date < todayStr))
    .map((r) => ({
      title: r.title, status: r.status, startDate: r.start_date, endDate: r.end_date,
      progress: r.progress, project: r.project, overdue: r.status !== 'done' && r.end_date < todayStr,
    }));

  // T02165：多项目聚合时按「用户勾选顺序」排列汇总与范围名（单选/全部维持原有 sort_weight 口径），
  // 使报表标题「周报：A + B」、汇总表与 AI prompt 的分区顺序三者一致
  const selectedNames = ids.length > 1 ? projectNamesInOrder(db, ids) : undefined;
  const projects = [...projMap.values()];
  if (selectedNames) {
    const rank = new Map(selectedNames.map((n, i) => [n, i]));
    const byRank = (a: string, b: string) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);
    projects.sort((a, b) => byRank(a.name, b.name));
    plans.sort((a, b) => byRank(a.project, b.project));
    // tasks 段内顺序（优先级）由 SQL 决定，此处按项目稳定分组，同项目内相对顺序不变
    tasks.sort((a, b) => byRank(a.project, b.project));
  }

  // T03240：溯源要说明「报告并不完整」——这里按注入 prompt 的同一阈值数出被截断条数
  const truncatedTasks = rows.filter((r) => (r.handle_result ?? '').length > HANDLE_RESULT_LIMIT).length;

  return {
    period,
    periodLabel: periodLabelOf(period),
    startDate: ymd(start),
    // T02944（裁决甲）：展示结束日用「含」的那天；SQL 右开界 `end` 只用于取数，不进展示。
    endDate: ymd(endInclusive),
    generatedAt: nowStr(),
    projects,
    tasks,
    plans,
    projectScope: selectedNames,
    truncatedTasks,
  };
}

/** AI 工具可读名（溯源段「模型」行）；查不到时回 null，不拿 toolId 冒充模型名 */
function aiToolName(toolId: string): string | null {
  try {
    const r = getDb().prepare('SELECT name FROM ai_tools WHERE id = ?').get(toolId) as { name: string } | undefined;
    return r?.name ?? null;
  } catch { return null; }
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
  /** T03240（AI-101 ③）：导出稿溯源段——与界面面板同源（reportProvenance 单源） */
  provenance?: ReportProvenance;
}

let buildWorker: Worker | null = null;
let building = false;
const buildQueue: Array<{ req: BuildRequest; resolve: (b: Buffer) => void; reject: (e: Error) => void }> = [];

/**
 * worker 堆上限（MB）：报表合成（exceljs/pdfkit/pptxgenjs）在千级数据下会显著抬高堆，
 * 封顶后即使遇到超大报表也只会让该次构建失败（worker error → 队列任务 reject → 前端看到明确错误），
 * 而不是把整个后端 RSS 顶穿。实测 heavy 阶段 RSS 峰值 390MB、CPU 峰值 152.6%。
 */
const WORKER_MAX_OLD_MB = 512;
/**
 * worker 空闲回收（ms）：worker 复用让大依赖只加载一次（好事），但代价是依赖与堆长期常驻
 * ——实测 heavy 阶段结束后稳定性阶段 RSS 均值仍 277MB（较纯写阶段 +115MB）。
 * 空闲超过该时长即销毁 worker，把内存交还系统；下次请求按需重建（多付数百 ms 依赖加载）。
 */
const WORKER_IDLE_MS = 5 * 60 * 1000;
let idleTimer: NodeJS.Timeout | null = null;

/** 取消空闲回收（有任务在途/排队时） */
function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** 队列排空后启动空闲回收定时器（unref 以免阻止进程退出） */
function armIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (building || buildQueue.length > 0) return; // 期间又有任务，交给下一次收口
    const w = buildWorker;
    buildWorker = null;
    w?.terminate().catch(() => { /* 空闲回收失败无需处理，下次请求会重建 */ });
  }, WORKER_IDLE_MS);
  idleTimer.unref?.();
}

/** worker 路径：打包/生产态（dist）为 .js，dev 态（tsx 跑 src）为 .ts */
function workerPath(): string {
  const js = join(__dirname, 'report-worker.js');
  return existsSync(js) ? js : join(__dirname, 'report-worker.ts');
}

function ensureWorker(): Worker {
  if (buildWorker) return buildWorker;
  const w = new Worker(workerPath(), { resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_MB } });
  w.on('message', (msg: { buffer?: Buffer; error?: string }) => {
    building = false;
    const task = buildQueue.shift();
    if (msg?.error) task?.reject(new Error(msg.error));
    else if (msg?.buffer) task?.resolve(Buffer.from(msg.buffer));
    else task?.reject(new Error('报表 worker 返回空结果'));
    pump();
    if (!building && buildQueue.length === 0) armIdleTimer();
  });
  // worker 异常退出：丢弃当前任务并销毁，下次请求自动重建
  w.on('error', (e) => {
    clearIdleTimer();
    building = false;
    buildQueue.shift()?.reject(e);
    // terminate() 返回 Promise，同步 try/catch 捕不到其 rejection，必须用 .catch 兜底
    w.terminate().catch(() => { /* worker 已异常退出，销毁失败无需处理，下次请求会重建 */ });
    buildWorker = null;
    pump();
    if (!building && buildQueue.length === 0) armIdleTimer();
  });
  buildWorker = w;
  return w;
}

/** 串行泵：无在途任务且有排队任务时，投递给 worker */
function pump(): void {
  if (building || buildQueue.length === 0) return;
  clearIdleTimer(); // 有任务在跑，取消空闲回收
  const task = buildQueue[0];
  building = true;
  const w = ensureWorker();
  w.postMessage({
    format: task.req.format,
    data: task.req.data,
    templateBuf: task.req.templateBuf,
    aiInsight: task.req.aiInsight,
    provenance: task.req.provenance,
  });
}

function buildInWorker(req: BuildRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    buildQueue.push({ req, resolve, reject });
    pump();
  });
}

/**
 * T02157：周期口吻的提示词单源。
 * 根因：此前 system 硬编码「AI 周报分析师…① 本周概况…④ 下周建议」——用户选月报，
 * AI 仍被指令写周报（选日报同理），且 aiGenerateReport/aiGenerateReportStream 两个入口
 * 各存一份完全相同的拷贝，改一处漏一处正是这类 bug 的温床。此处按 period 分派角色与
 * 章节口吻，两个入口共用；周期数据口径（periodLabel/起止）仍由 gatherReportData 单源供给。
 */
const REPORT_PERSONA: Record<ReportPeriod, { role: string; overview: string; advice: string }> = {
  day: { role: 'AI 日报分析师', overview: '今日概况与总体结论', advice: '明日工作建议' },
  week: { role: 'AI 周报分析师', overview: '本周概况与总体结论', advice: '下周工作建议' },
  month: { role: 'AI 月报分析师', overview: '本月概况与总体结论', advice: '下月工作建议' },
};

/** T02157：导出供门禁单测——周期口吻必须与 period 严格对应（选月报不得出周报口吻） */
export function buildReportPrompt(period: ReportPeriod, data: ReportData, skill: { name: string; desc: string }): { system: string; user: string } {
  const p = REPORT_PERSONA[period];
  const system = [
    `你是 MTask 的 ${p.role}。任务：基于给定周期的真实任务数据，遵循指定内置 SKILL 的版式规范，撰写一份专业、简洁、结构化的中文${PERIOD_LABEL[period]}洞察（Markdown 正文）。`,
    '要求：',
    '1. 严格依据提供的数据，不得虚构、不得使用占位或模拟数据',
    `2. 内容依次包含：① ${p.overview}；② 各项目进展要点；③ 重点工作与高风险项；④ ${p.advice}`,
    '3. 只输出洞察正文 Markdown，不要代码围栏、不要任何前置说明或寒暄',
    // 报表为面向用户的中文交付物，显式锁定简体，避免随任务数据(可能含繁体)连带输出繁体
    '4. 输出统一使用简体中文（简体字），严禁任何繁体字',
  ].join('\n');
  const user = [
    `【内置 SKILL】${skill.name}：${skill.desc}`,
    `【周期】${data.periodLabel} ${data.startDate} ~ ${data.endDate}`,
    // T02165：多项目聚合必须把范围显式喂给模型——否则它只能从数据里猜有几个项目，
    // 常把无活动项目漏掉、或把汇总指标写成单项目口吻
    ...(data.projectScope && data.projectScope.length > 1
      ? [`【项目范围】本${data.periodLabel}覆盖 ${data.projectScope.length} 个项目：${data.projectScope.join('、')}（概览给跨项目合并指标，进展与风险必须按项目分块逐一覆盖，不得遗漏任一项目，也不得把各项目数据混为一段）`]
      : []),
    `【项目汇总】${JSON.stringify(data.projects)}`,
    `【任务明细】${JSON.stringify(data.tasks)}`,
    ...(data.plans.length > 0 ? [`【项目计划执行情况】${JSON.stringify(data.plans)}（含延期标记 overdue，请纳入进展要点与风险分析）`] : []),
  ].join('\n\n');
  return { system, user };
}

/** T03242（AI-102①⑤⑥）：周报生成前的用量与耗时预估——只读聚合 + 构造 prompt 计长，零 AI 调用。 */
export interface ReportAiPreflightView {
  estimate: PreflightEstimate;
  /** 实际进上下文的字符量（周报按产出预估字符量，上下文体量单独如实给出） */
  contextChars: number;
  /** ⑤ 用量代理指标注记（服务端单源，前端原样展示） */
  notice: string;
  /** ⑥ 预估模型版本与系数（前端据此解释前后差异，不再自己写死数字） */
  model: {
    version: string;
    secondsPerCall: number;
    secondsLowPerCall: number;
    secondsHighPerCall: number;
    outputCharsPerCall: number;
  };
  range: { periodLabel: string; startDate: string; endDate: string; projects: number; tasks: number; plans: number; scope: string[] };
}

export function aiReportPreflight(
  period: ReportPeriod,
  format: ReportFormat,
  opts: { projectId?: string; projectIds?: string[] } = {},
): ReportAiPreflightView {
  const data = gatherReportData(period, opts.projectIds ?? opts.projectId);
  const { system, user } = buildReportPrompt(period, data, SKILL_BY_FORMAT[format]);
  return {
    // 周报链路当前就是一次流式调用；分段生成（AI-103）落地后这里随段数增长
    estimate: estimateOutputRun(1),
    contextChars: system.length + user.length,
    notice: PROXY_METRIC_NOTICE,
    model: {
      version: PREFLIGHT_ESTIMATE_MODEL.version,
      secondsPerCall: PREFLIGHT_ESTIMATE_MODEL.secondsPerCall,
      secondsLowPerCall: PREFLIGHT_ESTIMATE_MODEL.secondsLowPerCall,
      secondsHighPerCall: PREFLIGHT_ESTIMATE_MODEL.secondsHighPerCall,
      outputCharsPerCall: PREFLIGHT_ESTIMATE_MODEL.outputCharsPerCall,
    },
    range: {
      periodLabel: data.periodLabel,
      startDate: data.startDate,
      endDate: data.endDate,
      projects: data.projects.length,
      tasks: data.tasks.length,
      plans: data.plans.length,
      scope: data.projectScope ?? [],
    },
  };
}

/**
 * T03243（AI-102②）：校验前端回传的「用户确认过的那份预估」。
 * 偏差必须与用户当时看到的数字比，不能事后重算——但回传值来自客户端，数值合理性要卡住
 * （非数/负数/超量级一律视为未提供，宁可不出偏差也不展示离谱读数）。
 */
export function normalizeConfirmedEstimate(raw: unknown): PreflightEstimate | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, max: number): number | undefined =>
    (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
  const calls = num(o.calls, 100);
  const chars = num(o.chars, 5_000_000);
  const seconds = num(o.seconds, 86_400);
  const modelVersion = typeof o.modelVersion === 'string' ? o.modelVersion.trim().slice(0, 64) : '';
  if (calls === undefined || chars === undefined || seconds === undefined || !modelVersion) return undefined;
  return {
    calls: Math.floor(calls),
    chars: Math.floor(chars),
    charsBasis: o.charsBasis === 'context' ? 'context' : 'output',
    seconds,
    secondsLow: num(o.secondsLow, 86_400) ?? seconds,
    secondsHigh: num(o.secondsHigh, 86_400) ?? seconds,
    modelVersion,
  };
}

/** 生成报表，返回文件 buffer 与建议文件名（T02165：opts.projectIds 多项目聚合，与 projectId 兼容共存） */
export async function generateReport(
  period: ReportPeriod,
  format: ReportFormat,
  opts: { projectId?: string; projectIds?: string[]; templateId?: string } = {},
): Promise<{ buffer: Buffer; filename: string; provenance: ReportProvenance }> {
  const data = gatherReportData(period, opts.projectIds ?? opts.projectId);
  let templateBuf: Buffer | undefined;
  if (opts.templateId) {
    const tpl = join(templatesDir(), opts.templateId);
    templateBuf = readFileOrUndefined(tpl);
  }
  const provenance = buildReportProvenance(data, { cardKey: `report.export.${format}` });
  const buffer = await buildInWorker({ format, data, templateBuf, provenance });
  const ext = format;
  return { buffer, filename: `MTask-${data.periodLabel}-${data.startDate}.${ext}`, provenance };
}

/**
 * AI 周报生成：gatherReportData 取真实周期数据 → 经 AIService 调 LLM（注入匹配格式的内置 SKILL 版式规范）
 * 产出洞察正文 → worker 中把「真实数据 + AI 洞察」合成为指定格式文件。
 * 文件落临时目录返回下载令牌，下载即删。
 */
export async function aiGenerateReport(
  period: ReportPeriod,
  format: ReportFormat,
  opts: { projectId?: string; projectIds?: string[]; toolId: string; estimate?: PreflightEstimate },
): Promise<{ token: string; filename: string; insight: string; provenance: ReportProvenance; artifact: AiArtifact; usage: AiRunUsage; deviation?: RunUsageDeviation }> {
  const data = gatherReportData(period, opts.projectIds ?? opts.projectId);
  const skill = SKILL_BY_FORMAT[format];
  const { system, user } = buildReportPrompt(period, data, skill);
  const startedAt = Date.now();
  // T03243（AI-102④）：显式归属 ai.weekly_report，回看时按卡取实际值
  const res = await AIService.ask(opts.toolId, system, user, AI_REPORT_TIMEOUT, undefined, AI_REPORT_CARD);
  if (!res.ok || !res.content?.trim()) throw new Error(res.error ?? 'AI 生成失败');
  const insight = res.content.trim();
  const usage: AiRunUsage = {
    calls: 1,
    chars: res.content.length,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
  const filename = `MTask-AI-${data.periodLabel}-${data.startDate}.${format}`;
  const provenance = buildReportProvenance(data, { cardKey: AI_REPORT_CARD, model: aiToolName(opts.toolId) });
  const buffer = await buildInWorker({ format, data, aiInsight: insight, provenance });
  const token = saveReportBuffer(buffer);
  // T03240（④）：临时令牌文件下载即删，另存持久副本供刷新/重进找回
  const artifact = recordArtifact({ cardKey: provenance.cardKey, filename, buffer, provenance });
  // T00443 / PRD AI-5：摘要推送（可配置，默认关）——AI 周报生成后把摘要写入收件箱项目任务
  if (getSetting('report.aiSummaryToInbox') === '1') {
    try {
      const db = getDb();
      const tid = randomUUID();
      const t = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, verified, archived, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'normal', 'todo', 0, 0, 0, ?, ?)`,
      ).run(tid, INBOX_PROJECT_ID, inboxSummaryTitle(data), insight.slice(0, 4000), t, t);
      logService.log('INFO', 'ai', `[周报摘要推送] 已写入收件箱任务（${data.periodLabel}）`);
    } catch (e) {
      logService.log('ERROR', 'ai', `[周报摘要推送] 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { token, filename, insight, provenance, artifact, usage, deviation: opts.estimate ? assessAiRunDeviation(opts.estimate, usage) : undefined };
}

/**
 * T02165：收件箱摘要标题。多项目聚合时把范围写进标题——否则不同项目组合产出的摘要
 * 顶着同一个「周报 起止」无范围标题，事后无法分辨来自哪个范围。
 */
function inboxSummaryTitle(data: ReportData): string {
  const scope = data.projectScope && data.projectScope.length > 1 ? `（${data.projectScope.join(' + ')}）` : '';
  return `[周报摘要] ${data.periodLabel} ${data.startDate}~${data.endDate}${scope}`;
}

/**
 * AI 周报生成（流式版）：链路与 aiGenerateReport 一致，但通过 onStage 推送阶段进度、onChunk 逐片推送 AI 洞察正文。
 * 供 SSE 路由实时转发到前端 AI 控制台，实现"按钮联动控制台 + 流式滚动输出"。
 */
export async function aiGenerateReportStream(
  period: ReportPeriod,
  format: ReportFormat,
  opts: { projectId?: string; projectIds?: string[]; toolId: string; estimate?: PreflightEstimate },
  onStage: (msg: string) => void,
  onChunk: (text: string) => void,
  signal?: AbortSignal, // T00838：可选中止信号——周报生成可被「停止」按钮中断
): Promise<{ token: string; filename: string; insight: string; provenance: ReportProvenance; artifact: AiArtifact; usage: AiRunUsage; deviation?: RunUsageDeviation }> {
  onStage(`正在聚合${PERIOD_LABEL[period]}任务数据…`);
  const data = gatherReportData(period, opts.projectIds ?? opts.projectId);
  const skill = SKILL_BY_FORMAT[format];
  // T02165：进度里显式回显所选范围——data.projects 只统计「本期有活动」的项目，
  // 勾选 3 个可能只聚出 2 个，不回显范围用户会以为漏勾或漏数据
  const scopeLabel = data.projectScope ? `（范围：${data.projectScope.join(' + ')}）` : '';
  onStage(`已聚合 ${data.projects.length} 个项目${scopeLabel} / ${data.tasks.length} 条任务，正在调用模型生成洞察…`);
  const { system, user } = buildReportPrompt(period, data, skill);
  const res = await AIService.askStream(opts.toolId, system, user, onChunk, AI_REPORT_TIMEOUT, signal, AI_REPORT_CARD);
  if (!res.ok || !res.content?.trim()) throw new Error(res.error ?? 'AI 生成失败');
  const insight = res.content.trim();
  // T03243（AI-102②）：实际值与 ai_usage 同一份计数（流式增量字符数 / 墙钟耗时），调用次数单列
  const usage: AiRunUsage = { calls: 1, chars: res.chars, seconds: Math.round(res.durationMs / 100) / 10 };
  onStage('洞察生成完成，正在按内置 skill 版式合成文件…');
  // worker 异步合成：主事件循环不被阻塞，SSE 仍可推送/响应其它请求
  const filename = `MTask-AI-${data.periodLabel}-${data.startDate}.${format}`;
  const provenance = buildReportProvenance(data, { cardKey: AI_REPORT_CARD, model: aiToolName(opts.toolId) });
  const buffer = await buildInWorker({ format, data, aiInsight: insight, provenance });
  const token = saveReportBuffer(buffer);
  const artifact = recordArtifact({ cardKey: provenance.cardKey, filename, buffer, provenance });
  // T02144：与启动会侧同一收口点——中止若落在「已落盘、尚未回报」，done/stage 不会再有人接收，
  // 令牌随前端状态归零丢失，文件即成孤儿；这里当场回收（定时清扫是兜底）
  if (signal?.aborted) {
    discardReport(token);
    throw new Error('任务已停止');
  }
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
      ).run(tid, INBOX_PROJECT_ID, inboxSummaryTitle(data), insight.slice(0, 4000), t, t);
      logService.log('INFO', 'ai', `[周报摘要推送] 已写入收件箱任务（${data.periodLabel}，流式）`);
    } catch (e) {
      logService.log('ERROR', 'ai', `[周报摘要推送] 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { token, filename, insight, provenance, artifact, usage, deviation: opts.estimate ? assessAiRunDeviation(opts.estimate, usage) : undefined };
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
