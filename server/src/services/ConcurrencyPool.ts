/**
 * T01066-FR1.8（并行任务池）单源：并发上限与运行中槽位的读取/写入。
 *
 * 为什么抽出来：池状态原本只在 `routes/index.ts` 内联计算，MCP 领取路径（T01066 后续）
 * 也要用同一口径给外部 Agent 池满提示。两处各写一份 SQL 必然漂移——
 * 「面板说满了、MCP 说没满」比没有提示更糟。故与业务规则一起收在本文件。
 *
 * 口径说明：MTask 是 **pull 模式**（外部 Agent 经 MCP 领任务），server 无法强制排队，
 * 因此上限为**软引导**——只观测与提示，不拦截领取（硬拦会破坏多 Agent 自主并发）。
 */
import { getDb } from '../db/connection';
import { getSetting, setSetting } from './AppSettings';

const POOL_LIMIT_KEY = 'ai.pool.limit';
/** 默认并发上限 3：单 Agent 同时啃 3 个以上任务时上下文互相污染的概率显著上升 */
const DEFAULT_LIMIT = 3;
const MIN_LIMIT = 1;
const MAX_LIMIT = 10;

export interface PoolRunSlot {
  id: string;
  task_no: string | null;
  title: string;
  ai_state_at: string;
  project_name: string;
}

export interface PoolStatus {
  limit: number;
  running: PoolRunSlot[];
  /** 运行中的任务数（= running.length，冗余只为调用方少写一次 .length） */
  runningCount: number;
  /** 待领取队列深度：待办且从未被 AI 处理过（ai_state 为空）的任务数 */
  queued: number;
  /** 池是否已满：运行中槽位 ≥ 上限 */
  full: boolean;
}

/** 上限解析：非法/缺失回退默认 3，并夹在 1~10（防止手工写库后行为失控） */
export function readPoolLimit(): number {
  const n = Number(getSetting(POOL_LIMIT_KEY));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(n)));
}

export function setPoolLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw new Error(`limit 取值 ${MIN_LIMIT}~${MAX_LIMIT}`);
  }
  const rounded = Math.round(limit);
  setSetting(POOL_LIMIT_KEY, String(rounded));
  return rounded;
}

export function readPoolStatus(): PoolStatus {
  const db = getDb();
  const limit = readPoolLimit();
  const running = db.prepare(
    `SELECT t.id, t.task_no, t.title, t.ai_state_at, p.name AS project_name
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.ai_state = 'running' AND t.archived = 0 AND COALESCE(t.shelved, 0) = 0
      ORDER BY t.ai_state_at DESC`,
  ).all() as PoolRunSlot[];
  const queued = (
    db.prepare(
      "SELECT COUNT(*) AS c FROM tasks WHERE status = 'todo' AND COALESCE(ai_state, '') = '' AND archived = 0 AND COALESCE(shelved, 0) = 0",
    ).get() as { c: number }
  ).c;
  return { limit, running, runningCount: running.length, queued, full: running.length >= limit };
}

/**
 * MCP 领取路径的池满提示文案（T01066 后续）。
 *
 * 只在**已满**时返回文案，未满返回空串——避免每次列任务都灌一段与决策无关的水，
 * 长上下文下这种噪音会稀释真正重要的任务信息。
 */
export function poolFullHint(pool: PoolStatus): string {
  if (!pool.full) return '';
  const list = pool.running
    .slice(0, 5)
    .map((r) => `${r.task_no ?? r.id.slice(0, 8)} ${r.title}`)
    .join('；');
  return (
    `⚠ 并发池已满（${pool.runningCount}/${pool.limit} 个任务运行中）：${list}。\n` +
    '建议先把已领取的任务收口（回传结果 → mtask_update_task_result / 标失败 → mtask_write_task_status）' +
    '再领取新任务；并行过多会导致上下文互相污染与结果串台。此为软引导，不阻断领取。'
  );
}
