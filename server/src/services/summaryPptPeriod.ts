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
 * 接入点：S2 `summary-preflight` 的 S9 校验项（T02853）、S1 自定义档（T02852 调
 * `assertCustomRange` + `resolveCustomWindow`，其跨度判据即 `checkPeriodCap`）、
 * S4/S5 装配器渲染 `footnote`（T02855/T02856）——三处都用这里的同一串文案，不许各抄一份。
 */
import { readEventRetentionDays } from './EventRetention';
import type { SummaryPeriod } from './ReportService';

/** 一天毫秒数（本模块内所有「天」换算的唯一口径） */
export const DAY_MS = 24 * 60 * 60_000;

/** 汇报周期枚举（PRD FR-2.1；四档口径单源——入口守卫不许悄悄回落到月报） */
export const SUMMARY_PERIODS: readonly SummaryPeriod[] = ['day', 'week', 'month', 'custom'] as const;

/** 周期入参守卫：非枚举值点名报错（`periodRange` 对未知值会按兜底走月报，不能拿它当校验） */
export function assertSummaryPeriod(period: unknown): SummaryPeriod {
  const p = typeof period === 'string' ? period : '';
  if (!(SUMMARY_PERIODS as readonly string[]).includes(p)) {
    throw new Error(`period 仅支持 ${SUMMARY_PERIODS.join('/')}，当前为「${p || '空'}」`);
  }
  return p as SummaryPeriod;
}

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

/** 自定义汇报区间的入参（PRD §5 约束：`custom` 时 `start`/`end` 必填，`YYYY-MM-DD`，**两端都含**） */
export type CustomRange = { start?: string; end?: string };

/** 解析后的自定义窗口：`start`=起始日 0 点，`end`=结束日次日 0 点（左闭右开，给 SQL 用），`endInclusive`=用户所选结束日（给展示用） */
export type CustomWindow = { start: Date; end: Date; endInclusive: Date };

/** `periodRange('custom')` 收到非法区间时抛出——端点应先调 `assertCustomRange` 转 400，抛出是兜底而非静默按今天算 */
export class PeriodRangeError extends Error {}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 严格本地时区日期解析（PRD FR-2.1：自定义经 `ymd` 同口径的本地时区解析，避免跨日误判）。
 * 只认 `YYYY-MM-DD`：`2026-1-2` 这类不补零的串、`2026-02-30` 这类溢出日（`new Date` 会回绕成 3-02）
 * 一律返回 null——回绕一旦发生，用户以为选了 2 月末，实际汇总到 3 月初。
 */
export function parseYmdLocal(value: string | undefined): Date | null {
  const m = YMD_RE.exec(value ?? '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/**
 * 自定义区间校验（PRD §3.2 约束，评审修订 B1）：通过返回 null，否则返回可直接 400 的中文文案。
 * 四条判据依 PRD 顺序短路：必填/格式 → 起始日不得晚于结束日 → 结束日不得晚于今天 → 跨度 ≤ 上限。
 * 跨度按**含两端**折算（右开多一天），故「同一天」是 1 天区间而不是 0 天。
 * 注意与 S9 的分工：这里管「上限」（不让用户选到注定被清理的超长区间），
 * `assessEventCoverage` 管「实际覆盖」（用户把保留期调小后，区间虽合规仍要降级声明）。
 */
export function assertCustomRange(custom: CustomRange | undefined, opts: { nowMs?: number } = {}): string | null {
  const startStr = custom?.start;
  const endStr = custom?.end;
  if (!startStr || !endStr) return '自定义区间必须同时提供 start 与 end（YYYY-MM-DD）';
  const s = parseYmdLocal(startStr);
  if (!s) return `起始日不是合法日期：「${startStr}」（需要 YYYY-MM-DD，且必须是真实存在的日期）`;
  const e = parseYmdLocal(endStr);
  if (!e) return `结束日不是合法日期：「${endStr}」（需要 YYYY-MM-DD，且必须是真实存在的日期）`;
  if (e.getTime() < s.getTime()) return `起始日不得晚于结束日：${startStr} 晚于 ${endStr}`;
  const now = new Date(opts.nowMs ?? Date.now());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (e.getTime() > today.getTime()) return `结束日不得晚于今天：${endStr} 晚于 ${isoDay(today.getTime())}（不汇总尚未发生的日期）`;
  const cap = checkPeriodCap(s.getTime(), e.getTime() + DAY_MS);
  if (!cap.ok) return cap.error ?? '自定义区间超出上限';
  return null;
}

/** 校验 + 折算窗口；`assertCustomRange` 的文案原样作为异常消息（两处口径恒等，端点与内部兜底不会各说一套） */
export function resolveCustomWindow(custom: CustomRange | undefined, opts: { nowMs?: number } = {}): CustomWindow {
  const error = assertCustomRange(custom, opts);
  if (error) throw new PeriodRangeError(error);
  const start = parseYmdLocal(custom!.start)!;
  const endInclusive = parseYmdLocal(custom!.end)!;
  return { start, end: new Date(endInclusive.getFullYear(), endInclusive.getMonth(), endInclusive.getDate() + 1), endInclusive };
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
