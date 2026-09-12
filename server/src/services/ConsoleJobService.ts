import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { AIService } from './AIService';
import { gatherReportData, type ReportPeriod } from './ReportService';

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

/**
 * 组装每次对话的 system/user（周期类任务按所选周期注入真实任务数据）。
 * 逻辑与 /ai/chat 路由保持一致，使「持久化任务」与「同步问答」的回答口径完全一致。
 */
function buildConsoleChat(job: ConsoleJobRow): { sys: string; usr: string } {
  let sys = CHAT_SYSTEM;
  let usr = job.prompt;
  const per = job.period as ReportPeriod | null;
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
    return this.get(id)!;
  },

  get(id: string): ConsoleJobRow | null {
    const row = getDb().prepare('SELECT * FROM console_jobs WHERE id = ?').get(id) as ConsoleJobRow | undefined;
    return row ?? null;
  },

  /** 全部任务按创建时间排序：即前端 tab 的展示顺序，切页回来顺序保持一致 */
  list(): ConsoleJobRow[] {
    return getDb().prepare('SELECT * FROM console_jobs ORDER BY created_at').all() as ConsoleJobRow[];
  },

  markDone(id: string, answer: string): void {
    getDb().prepare("UPDATE console_jobs SET status = 'done', answer = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(answer, now(), id);
  },

  markError(id: string, error: string): void {
    getDb().prepare("UPDATE console_jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ?")
      .run(error, now(), id);
  },

  /** 置回 busy 并清空旧结果，供「重新分析」复用固化 prompt/周期重跑 */
  reset(id: string): void {
    getDb().prepare("UPDATE console_jobs SET status = 'busy', answer = NULL, error = NULL, updated_at = ? WHERE id = ?")
      .run(now(), id);
  },

  remove(id: string): boolean {
    const info = getDb().prepare('DELETE FROM console_jobs WHERE id = ?').run(id);
    return info.changes > 0;
  },

  /** 清空全部任务（「重置控制台」使用） */
  clear(): void {
    getDb().prepare('DELETE FROM console_jobs').run();
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