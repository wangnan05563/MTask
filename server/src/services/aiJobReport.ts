/**
 * T03316（G-3）：AI job 终态上报的统一入口。
 *
 * 各生成路由在「完整一轮」收口时调用这里，而不是各自拼 AiJobStats.record：
 *  - jobId 优先用客户端带来的稳定值（续作/重试复用同一 job），缺省才生成 UUID——
 *    若每轮请求各 new 一个，跨请求的「续作第 n 节」「重试失败节」会被算成多个 job，
 *    与 G-3「重试后最终成功计成功」的口径相反。
 *  - 指标落库失败一律吞掉：观测数据不得影响生成主流程（与 AiJobStats 调用方既有约定一致）。
 *  - 只记完整一轮终态由调用方判定（仅大纲是中间交付、片段重试不单独成 job）。
 */
import { randomUUID } from 'node:crypto';
import { AiJobStats } from './AiJobStats';

export type AiJobMode = 'ai' | 'offline';

/** 客户端 jobId 只做长度与空值兜底；不合格时回落到服务端 UUID，不让坏入参打断生成 */
export function jobIdOf(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > 120) return randomUUID();
  return text;
}

export interface AiJobTerminalInput {
  jobId?: unknown;
  cardKey: string;
  status: 'done' | 'aborted' | 'error';
  mode?: AiJobMode;
  sectionsTotal?: number;
  sectionsOk?: number;
  /** 续作轮不传：同一 jobId 的首轮起点已经更早，用本轮时间会让 startedAt 漂移 */
  startedAt?: string;
}

export function reportAiJob(job: AiJobTerminalInput): void {
  try {
    AiJobStats.record({
      jobId: jobIdOf(job.jobId),
      cardKey: job.cardKey,
      status: job.status,
      mode: job.mode ?? 'ai',
      sectionsTotal: job.sectionsTotal ?? 0,
      sectionsOk: job.sectionsOk ?? 0,
      startedAt: job.startedAt,
      finishedAt: new Date().toISOString(),
    });
  } catch { /* 指标落库失败不得影响生成主流程 */ }
}
