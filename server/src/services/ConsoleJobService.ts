import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';
import { AIService } from './AIService';
import { gatherReportData, type ReportPeriod } from './ReportService';

/**
 * 列表缓存键（T00787）：前端以轮询方式反复 GET /console-jobs，而该查询是
 * `SELECT *`（含完整 answer 长文本）全表扫——空查询也需读全部行并做 JSON 序列化。
 * 5s TTL 与 projects / prompt-categories 等低频集合列表口径一致；所有写路径
 * （create / markDone / markError / reset / remove / clear）均在此服务内收敛，
 * 因此失效逻辑放在服务层可保证任何调用方都不会读到脏数据。
 */
const LIST_CACHE_KEY = 'console-jobs';
const LIST_TTL_MS = 5000;

/** AI 控制台任务统一系统提示：与 /ai/chat 保持一致的助手设定，保证并行任务回答风格稳定 */
const CHAT_SYSTEM = '你是 MTask 的 AI 助手，基于任务与报表背景，用简洁专业的中文回答，并使用 Markdown 组织输出。';

/** 周期集合：仅周期类预设携带真实数据注入；自定义问答不附加周期，后端不注入数据保持纯对话 */
const REPORT_PERIODS = new Set<ReportPeriod>(['day', 'week', 'month']);

export interface ConsoleJobRow {
  id: string;
  title: string;
  prompt: string;
  category: string;
  period: string | null;
  status: 'busy' | 'done' | 'error';
  answer: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsoleJobInput {
  title: string;
  prompt: string;
  category: string;
  period: ReportPeriod | null;
}

function now(): string {
  return new Date().toISOString();
}

/** T00652 数据清洗随附数据的条数上限：已完成任务可能成百上千，截断以控制提示词体积。
 *  T00707 二轮：原 400 条在思考型模型（agnes-2.5-flash）上会把输出预算耗在思考上导致正文为空/截断，
 *  收到 150 条——若已完成任务更多，建议按项目分批发起清洗（result 与界面均会提示）。 */
const CLEAN_DATA_LIMIT = 150;

/**
 * T00652 数据清洗：抓取「已完成且未归档」的任务（任务号 + 所属项目 + 标题）供 AI 识别同项目重复。
 * 只读查询，不做任何写入；写入（合并/归档）一律由 /ai/clean-tasks 经 ArchiveService 与 TaskService 完成。
 */
function gatherCleanData(limit = CLEAN_DATA_LIMIT): {
  total: number;
  tasks: { taskNo: string; project: string; title: string }[];
} {
  const db = getDb();
  const where = "t.status = 'done' AND t.archived = 0 AND COALESCE(t.history_at, '') = ''";
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM tasks t WHERE ${where}`).get() as { c: number }).c;
  const tasks = db
    .prepare(
      `SELECT t.task_no AS taskNo, COALESCE(p.name, t.project_id) AS project, t.title AS title
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE ${where}
        ORDER BY t.project_id, t.task_no
        LIMIT ?`,
    )
    .all(limit) as { taskNo: string; project: string; title: string }[];
  return { total, tasks };
}

/**
 * 组装每次对话的 system/user（周期类任务按所选周期注入真实任务数据）。
 * 逻辑与 /ai/chat 路由保持一致，使「持久化任务」与「同步问答」的回答口径完全一致。
 */
function buildConsoleChat(job: ConsoleJobRow): { sys: string; usr: string } {
  let sys = CHAT_SYSTEM;
  let usr = job.prompt;
  const per = job.period as ReportPeriod | null;
  // T00652 数据清洗：不依赖报表周期，改为随附全量「已完成且未归档」任务，让 AI 在同一项目内识别重复
  if (job.category === 'clean') {
    const data = gatherCleanData();
    // T00751：必须明确字段 schema——首版只说「分组数组」，模型改输出 {project,tasks:[...]}，
    // 前端 parseCleanGroups 只认 keep/merge → 全部行被跳过（执行清洗弹窗无数据）；同时禁止区间简写
    // （模型曾输出 "T00056-T00080"，系统按任务号逐条执行合并，无法处理区间）
    sys = `${sys}\n本次必须严格依据随附的真实已完成任务数据作答，不得虚构任务或任务号；只在「同一个项目内」判定重复与合并，跨项目的相似任务一律不要合并。`
      + '\n**输出格式与规模控制（必须严格遵守）**：先输出 ```json 代码块，内容为数组，每元素**必须且只能**含四个字段 '
      + '{"project":"项目名","keep":"保留的代表任务号","merge":["被合并任务号",...],"reason":"≤25字理由"}；'
      + 'merge 必须逐条列出**完整任务号**（严禁 T00056-T00080 这类区间简写）；最多 20 组；'
      + 'JSON 之后再给一句简短 Markdown 说明（≤120 字），不要长篇分析——输出过长会被截断导致解析失败。'.trim();
    usr = [
      `【已完成任务数据（status=done、未归档，共 ${data.total} 条，本次随附 ${data.tasks.length} 条）】`,
      `【任务明细】${JSON.stringify(data.tasks)}`,
      `\n问题：${usr}`,
    ].join('\n\n');
    return { sys, usr };
  }
  if (per && REPORT_PERIODS.has(per)) {
    const data = gatherReportData(per);
    // 限定模型必须依据随附真实数据作答，提示所依据周期，避免常识性发挥与用户预期不符
    sys = `${sys}\n本次必须严格依据随附的当前周期真实任务数据进行作答，不得虚构任务或数据；请点明所依据周期（${data.periodLabel} ${data.startDate}~${data.endDate}）。`.trim();
    usr = [
      `【周期=${data.periodLabel} ${data.startDate} ~ ${data.endDate}】`,
      `【项目汇总】${JSON.stringify(data.projects)}`,
      `【任务明细】${JSON.stringify(data.tasks)}`,
      `\n问题：${usr}`,
    ].join('\n\n');
  }
  return { sys, usr };
}

/**
 * AI 控制台持久化并行任务（T00417）：任务落库后即可返回，真正执行在后台 promise.then 完成并回写库。
 * 相比现有 QueueService 专职队列分发，这里直接复用 AIService.ask 单轮对话封装，不再引入轮询/受理回执复杂度。
 */
export const ConsoleJobService = {
  /** 创建 busy 任务并落库（不执行 AI，调用方拿到 id 后异步 runJob） */
  create(input: ConsoleJobInput): ConsoleJobRow {
    const db = getDb();
    const id = uuid();
    const t = now();
    db.prepare(
      `INSERT INTO console_jobs (id, title, prompt, category, period, status, answer, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'busy', NULL, NULL, ?, ?)`,
    ).run(id, input.title, input.prompt, input.category, input.period, t, t);
    cacheClear(LIST_CACHE_KEY); // 新建任务后列表立刻可见（不等 5s TTL）
    return this.get(id)!;
  },

  get(id: string): ConsoleJobRow | null {
    const row = getDb().prepare('SELECT * FROM console_jobs WHERE id = ?').get(id) as ConsoleJobRow | undefined;
    return row ?? null;
  },

  /** 全部任务按创建时间排序：即前端 tab 的展示顺序，切页回来顺序保持一致。
   *  T00787：结果缓存 5s——轮询场景下 DB 行读与长文本 JSON 序列化成本≈0；
   *  任何写操作都会 cacheClear，因此轮询方在写入后立即（下一个请求）读到新状态。 */
  list(): ConsoleJobRow[] {
    const cached = cacheGet<ConsoleJobRow[]>(LIST_CACHE_KEY);
    if (cached) return cached;
    const rows = getDb().prepare('SELECT * FROM console_jobs ORDER BY created_at').all() as ConsoleJobRow[];
    cacheSet(LIST_CACHE_KEY, rows, LIST_TTL_MS);
    return rows;
  },

  markDone(id: string, answer: string): void {
    getDb().prepare("UPDATE console_jobs SET status = 'done', answer = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(answer, now(), id);
    cacheClear(LIST_CACHE_KEY); // 后台任务完成 → 轮询方需立刻看到 done 与 answer
  },

  markError(id: string, error: string): void {
    getDb().prepare("UPDATE console_jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ?")
      .run(error, now(), id);
    cacheClear(LIST_CACHE_KEY);
  },

  /** 置回 busy 并清空旧结果，供「重新分析」复用固化 prompt/周期重跑 */
  reset(id: string): void {
    getDb().prepare("UPDATE console_jobs SET status = 'busy', answer = NULL, error = NULL, updated_at = ? WHERE id = ?")
      .run(now(), id);
    cacheClear(LIST_CACHE_KEY);
  },

  remove(id: string): boolean {
    const info = getDb().prepare('DELETE FROM console_jobs WHERE id = ?').run(id);
    if (info.changes > 0) cacheClear(LIST_CACHE_KEY);
    return info.changes > 0;
  },

  /** 清空全部任务（「重置控制台」使用） */
  clear(): void {
    getDb().prepare('DELETE FROM console_jobs').run();
    cacheClear(LIST_CACHE_KEY);
  },

  /**
   * 异步执行单个任务：请求即受理，真正耗时在后台完成并回调 markDone/markError 回写库，
   * 因此任务运行不依赖前端会话（页面切换/刷新都不中断）。由调用方以不 await 方式触发。
   */
  async runJob(id: string, toolId: string): Promise<void> {
    const job = this.get(id);
    if (!job) return;
    const { sys, usr } = buildConsoleChat(job);
    try {
      const res = await AIService.ask(toolId, sys, usr);
      if (res.ok && res.content) this.markDone(id, res.content);
      else this.markError(id, res.error ?? 'AI 未返回结果');
    } catch (e) {
      this.markError(id, e instanceof Error ? e.message : String(e));
    }
  },
};