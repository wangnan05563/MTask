/**
 * T01064 后续（T01558）：任务事件表 `task_events` 保留期自动清理。
 *
 * 为什么需要：`task_events` 是通知中心与任务时间线的唯一数据源，状态流转/验证/AI 状态/结果回传
 * 每次变更都写一行——长期运行的实例行数单调增长，既撑大数据库也让「最近事件」查询越来越慢。
 * 事件是**过程留痕**（任务时间线另有快照语义），保留 90 天后清理对业务无损。
 *
 * 设计口径与 `SupervisorService` 的审计清理（`SupervisorAudit.pruneMonitorRuns`）保持一致：
 * - 保留天数走 app_settings KV（`events.retentionDays`），默认 90 天，**0 = 不清理**；
 * - 清理在定时器里现读配置，改设置即时生效、无需重启；
 * - 内部节流（默认 24h），调用方可安全高频调用；
 * - 删除走索引 `idx_task_events_proj`（created_at 为 ISO 串，字典序即时间序，可直接比较）；
 * - 清理失败只记日志、不影响业务。
 */
import { getDb } from '../db/connection';
import { getSetting, setSetting } from './AppSettings';

/** 保留天数配置键 */
const RETENTION_DAYS_KEY = 'events.retentionDays';
/** 默认保留 90 天：够回溯一个季度的排障与统计，又不让库随运行时长无界膨胀 */
const DEFAULT_RETENTION_DAYS = 90;
/** 清理节流 24h：事件按天级保留即可，无需更频繁地扫表 */
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
/** 保留天数上限（10 年）：再往上等于不清，不如直接配 0；设上限只为挡住手抖多打几位数的写入 */
const MAX_RETENTION_DAYS = 3650;

/** 上次清理时刻（毫秒）；进程内节流用，重启归零不影响正确性（只是提前清一次） */
let lastPruneAtMs = 0;

/** 保留天数解析：缺失/空串/非法回退默认（显式挡空值——`Number('')` 为 0 会被误读成「永不清理」） */
export function readEventRetentionDays(): number {
  const raw = getSetting(RETENTION_DAYS_KEY);
  if (raw == null || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_RETENTION_DAYS;
}

/**
 * 在线修改事件保留天数——写入即生效（清理定时器现读配置，无需重启）。
 *
 * 校验挡在写库之前：NaN/负数会被 readEventRetentionDays 判为非法并静默回退默认，
 * 写进去就成了「面板显示已改、实际仍按默认清理」的误导性配置。
 * 显式允许 0：语义是「不清理、保留全部」，是需长期留痕的部署的合法选择。
 */
export function setEventRetentionDays(days: number): number {
  if (!Number.isFinite(days) || days < 0 || days > MAX_RETENTION_DAYS) {
    throw new Error(`事件保留天数需在 0~${MAX_RETENTION_DAYS} 天之间（0 = 不清理）`);
  }
  const rounded = Math.round(days);
  setSetting(RETENTION_DAYS_KEY, String(rounded));
  return rounded;
}

/**
 * 按保留策略清理过期事件。
 *
 * @param now   注入当前时刻（毫秒），仅供测试控制节流与截止时间
 * @param force true = 跳过节流（手动「立即清理」入口用）
 * @returns 本轮实际删除行数（0 = 未到节流点 / 已关闭清理 / 无过期行）
 */
export function pruneTaskEvents(now = Date.now(), force = false): number {
  if (!force && now - lastPruneAtMs < PRUNE_INTERVAL_MS) return 0;
  lastPruneAtMs = now;
  const days = readEventRetentionDays();
  if (days <= 0) return 0;
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  try {
    const r = getDb().prepare('DELETE FROM task_events WHERE created_at < ?').run(cutoff);
    if (r.changes > 0) {
      // 清理会永久删除留痕，必须可追溯（console.log 会被 LogService 捕获进日志缓冲）
      console.log(`[events] 保留期清理：删除 ${r.changes} 条早于 ${cutoff} 的事件（保留 ${days} 天）`);
    }
    return r.changes;
  } catch (e) {
    // 清理失败不该拖垮定时器：事件是旁路留痕，表被锁/损坏时主流程仍应继续
    console.error('[events] 保留期清理失败:', e);
    return 0;
  }
}

/** 事件流规模观测——供设置页展示「当前保留多少条」，便于判断保留期是否合适 */
export function countEvents(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}

/**
 * 启动事件保留期清理定时器：启动即跑一轮 + 每 6 小时检查一次。
 *
 * 周期取 6h 而非 24h：服务不一定 7×24 常驻（桌面端随开随关），
 * 若只在整点窗口触发，短会话实例可能永远轮不到清理；6h 配合 24h 节流，
 * 实际清理频率仍是「每日最多一次」。
 */
export function startEventRetentionTimer(): void {
  try {
    pruneTaskEvents();
  } catch (e) {
    console.error('[events] 启动清理失败:', e);
  }
  setInterval(() => {
    try {
      pruneTaskEvents();
    } catch {
      /* 单轮失败不中断定时 */
    }
  }, 6 * 60 * 60_000);
}
