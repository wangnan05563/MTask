/**
 * T02851（六期 S0）：阶段性项目总结汇报 PPT 的「汇报周期 ↔ 事件保留期」一致性判据。
 *
 * 为什么要这一层（PRD-阶段性项目总结汇报PPT §3.2 FR-2.1 评审修订 B1、§3.3 FR-3 S9）：
 * 「本期动态」页的数据源是 `task_events`，而 `EventRetention` 默认只保留 **90 天**
 * （`events.retentionDays`，0=不清理）。用户可以把保留期调小（如 30 天），也可以选自定义区间
 * ——一旦周期起点落在保留期边界之前，那部分事件**已经被清理掉了**，报表会拿「查不到」当成
 * 「那段时间没发生」。这是静默丢数，不是精度问题，所以 PRD 要求：
 *   ① 自定义周期上限 90 天（与保留期默认值同源，别再出现「92 天 > 保留 90 天」的窗口空洞）；
 *   ② 周期起点 < 保留期边界时判 ⚠（**不阻塞**生成，但强制在页面上降级留痕）；
 *   ③ 页脚声明**实际覆盖窗口**（「事件仅覆盖最近 N 天，更早动态已被保留策略清理」）。
 *
 * 本模块只提供**判据与文案单源**，不做取数也不写库（FR-3.4 一致性：前置校验零写入零 AI 消耗）。
 * 接入点：S2 `summary-preflight` 的 S9 校验项（T02853）、S1 自定义档（T02852 调 `checkPeriodCap`）、
 * S4/S5 装配器渲染 `footnote`（T02855/T02856）——三处都用这里的同一串文案，不许各抄一份。
 */
import { readEventRetentionDays } from './EventRetention';

/** 一天毫秒数（本模块内所有「天」换算的唯一口径） */
export const DAY_MS = 24 * 60 * 60_000;

/**
 * 自定义汇报周期跨度上限（天）——PRD FR-2.1 修订 B1 从原稿 92 收到 90，
 * 与 `EventRetention.DEFAULT_RETENTION_DAYS` 对齐：92 天的区间在默认保留期下天然存在
 * 两天「已清理却不被声明」的窗口空洞，那正是本判据要堵的东西。
 * 两个 90 必须同源，由 verify-t02851 的 C-05 断言钉住（任一侧改动即红）。
 */
export const SUMMARY_PPT_MAX_PERIOD_DAYS = 90;

/** 周期跨度校验结果（纯判据，调用方决定是 400 还是抛错） */
export type PeriodCapCheck = { ok: boolean; days: number; error?: string };

/**
 * 周期跨度上限判据：`[start, end)` 的天数（按毫秒折算，向上取整——
 * 跨到第 91 个日历日就是 91 天，不给「差一分钟算 90 天」留模糊地带）。
 * 起点晚于终点直接拒绝（PRD：起始日不得晚于结束日）。
 */
export function checkPeriodCap(startMs: number, endMs: number, capDays = SUMMARY_PPT_MAX_PERIOD_DAYS): PeriodCapCheck {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, days: NaN, error: '周期起止时间非法（需要可解析的本地日期）' };
  }
  if (endMs <= startMs) return { ok: false, days: 0, error: '起始日不得晚于（或等于）结束日' };
  const days = Math.ceil((endMs - startMs) / DAY_MS);
  if (days > capDays) {
    return { ok: false, days, error: `自定义汇报周期最长 ${capDays} 天（当前 ${days} 天）——超过事件保留期默认值会出静默丢数窗口` };
  }
  return { ok: true, days };
}

/** 事件覆盖窗口判据（S9 校验项的返回值；文案单源见 `footnote`） */
export type EventCoverage = {
  /** 周期起点是否落在保留期边界之内（PRD：起点 ≥ 边界 → ✓） */
  ok: boolean;
  /** 是否需要在页面上降级留痕（`!ok` 即 true；保留期关闭时恒 false） */
  degraded: boolean;
  /** 生效的保留天数（0 = 不清理、保留全部） */
  retentionDays: number;
  /** 保留期边界时刻（毫秒）；`retentionDays === 0` 时为 NaN（没有边界） */
  boundaryMs: number;
  /** 本期实际能覆盖到的起点（= max(周期起点, 边界)；毫秒） */
  coveredFromMs: number;
  /** 页脚/提示文案：⚠ 时给出实际覆盖窗口，✓ 或不清理时为空串 */
  footnote: string;
};

/**
 * 判「事件保留期能不能覆盖这个汇报周期」。
 *
 * `nowMs`/`retentionDays` 均可注入（门内夹具要在固定时刻与极端保留期上取证）；
 * 产品调用只传周期起点，其余现读 `app_settings`——与 `EventRetention`「定时器现读配置、
 * 改设置即时生效」同一口径，不做进程内缓存，否则用户把保留期从 90 调到 30 时判据跟不上。
 */
export function assessEventCoverage(
  startMs: number,
  opts: { nowMs?: number; retentionDays?: number } = {},
): EventCoverage {
  const nowMs = opts.nowMs ?? Date.now();
  const retentionDays = opts.retentionDays ?? readEventRetentionDays();
  // 0 = 关闭清理（EventRetention 的显式语义），任何周期起点都在窗口内，不降级也不该编造一句「仅覆盖 0 天」
  if (retentionDays <= 0) {
    return { ok: true, degraded: false, retentionDays: Math.max(0, retentionDays), boundaryMs: NaN, coveredFromMs: startMs, footnote: '' };
  }
  const boundaryMs = nowMs - retentionDays * DAY_MS;
  const ok = startMs >= boundaryMs;
  const coveredFromMs = Math.max(startMs, boundaryMs);
  return {
    ok,
    degraded: !ok,
    retentionDays,
    boundaryMs,
    coveredFromMs,
    // 文案单源（S9 的 ⚠ 提示与「本期动态」页页脚共用这一串，PRD FR-3.2 要求页面显式留痕）
    footnote: ok ? '' : `事件仅覆盖最近 ${retentionDays} 天（自 ${isoDay(coveredFromMs)} 起），更早动态已被保留策略清理`,
  };
}

/** 本地时区的 YYYY-MM-DD（与 `ReportService.ymd` 同口径，避免 UTC 串造成的跨日错位） */
function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
