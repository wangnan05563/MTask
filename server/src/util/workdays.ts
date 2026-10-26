/**
 * E1（PRD-估算视图 §4.5）：工作日**正向**工具——服务端唯一实现。
 *
 * 为什么单独成模块：`PlanService` 里的 `isWorkday/calcEndDate/nextWorkday/workdaysInRange` 都是该文件的
 * 模块私有函数，而估算需要的是「从锚点日**向后走 N 个工作日**」——锚点日**不计入**（`calcEndDate` 是
 * 「起始日起 N 个工作日的含尾结束日」，两者相差一个工作日，混用会让日历天列与 duration_days 对不齐）。
 * PRD §4.5 实测点名本仓缺的正是这个正向函数。前端同语义镜像在 `web/src/utils/workday.ts` 的 `addWorkdays`，
 * 两侧由 `scripts/estimate-e1-test.mjs` 逐日网格比对（util/planDeps 的双口径教训：同语义必须可断言）。
 */

/** 日历上下文：holidays=放假日（排除），overtime=加班日（周末/节假日照常上班，强制工作日） */
export interface WorkdayCal {
  holidays: Set<string>;
  overtime: Set<string>;
}

/** holidays 表行 → 日历上下文（kind==='overtime' 归加班日，其余一律归放假日） */
export function buildCalendar(rows: Array<{ date: string; kind?: string | null }>): WorkdayCal {
  const cal: WorkdayCal = { holidays: new Set(), overtime: new Set() };
  for (const r of rows) (r.kind === 'overtime' ? cal.overtime : cal.holidays).add(r.date);
  return cal;
}

/** YYYY-MM-DD（本地时区，不用 toISOString 以免 UTC 偏移） */
export function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → Date（本地零点） */
export function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

/** 工作日判定（与 PlanService.isWorkday、前端 workday.isWorkday 同口径） */
export function isWorkday(d: Date, cal: WorkdayCal): boolean {
  if (cal.overtime.has(fmtDate(d))) return true;
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  return !cal.holidays.has(fmtDate(d));
}

/**
 * 从锚点日向后走 n 个工作日，返回落点日（**锚点日不计入**，即 n=1 得到锚点之后的第一个工作日）。
 *  - n <= 0：不推进——锚点本身是工作日则原样返回，否则顺延到其后第一个工作日；
 *  - 非法/空锚点：原样返回入参（调用方多半是缺排期日期的行，不该凭空造日期）；
 *  - 逐日推进不设上限：加班日/长假都可能命中，循环靠 isWorkday 判定而非固定步数。
 */
export function addWorkdays(anchor: string, n: number, cal: WorkdayCal): string {
  if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return anchor;
  const d = parseYmd(anchor);
  if (n <= 0) {
    while (!isWorkday(d, cal)) d.setDate(d.getDate() + 1);
    return fmtDate(d);
  }
  let left = Math.floor(n);
  for (;;) {
    d.setDate(d.getDate() + 1);
    if (isWorkday(d, cal)) {
      left -= 1;
      if (left === 0) return fmtDate(d);
    }
  }
}

/** 日历集合里落在 `[from, to]` 且 `keep` 为真的天数（`YYYY-MM-DD` 字典序即时间序） */
function countCalDates(
  set: Set<string>,
  from: string,
  to: string,
  keep: (date: string) => boolean,
): number {
  let n = 0;
  for (const d of set) {
    if (d >= from && d <= to && keep(d)) n += 1;
  }
  return n;
}

const isWeekend = (date: string): boolean => {
  const wd = parseYmd(date).getDay();
  return wd === 0 || wd === 6;
};

/**
 * §7「E 人天 > 剩余排期」的**区间**口径：`[from, to]` 两端都含的工作日数（含加班日、去放假日）。
 *  - `to < from`（排期已过期）→ 0，调用方据此判「剩余排期为 0」而不是负数把提示算成通过；
 *  - 非法日期 → 0（缺排期的行不该因为缺日期就被判成冲突，由调用方先按「无排期」跳过）。
 * 与 `PlanService` 模块私有的 `workdaysInRange` 同语义（那边是工期推导用，这里是估算剩余排期用），
 * 差别只在入参已由调用方保证有序。
 *
 * **成本与日期跨度无关**：本函数在 `GET /api/estimates` 里逐行调用（行数 = 在架计划数），
 * 而 `end_date` 是用户可填的任意日期——曾经的逐日推进实现让一条 `2099-12-31` 的排期把单次请求
 * 拖成上万次 `isWorkday`。这里改成「整周数 × 5 + 不足一周的部分（≤6 次判定）」的算术口径，
 * 再加减日历集合命中的周末加班日 / 工作日放假日，成本只与 `holidays` 行数有关。
 * 语义由 `scripts/verify-t02046-estimate-e9.mts` 的网格比对钉住（与逐日推进的参照实现全等）。
 */
export function countWorkdaysBetween(from: string, to: string, cal: WorkdayCal): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return 0;
  if (to < from) return 0;
  const a = parseYmd(from);
  // 日差用 Math.round 消化 DST 的 23/25 小时日（国内部署无 DST，但零成本）
  const dayDiff = Math.round((parseYmd(to).getTime() - a.getTime()) / 86400000);
  const days = dayDiff + 1;
  const startIdx = (a.getDay() + 6) % 7; // 周一=0 … 周日=6
  let n = Math.floor(days / 7) * 5;
  for (let k = 0; k < days % 7; k++) {
    if ((startIdx + k) % 7 < 5) n += 1;
  }
  // 加班日优先于放假日（与 isWorkday 的判定顺序一致：同名日期两集都命中时算上班）
  n -= countCalDates(cal.holidays, from, to, (d) => !isWeekend(d) && !cal.overtime.has(d));
  n += countCalDates(cal.overtime, from, to, isWeekend);
  return n;
}

// ---------- T03168（PRD D-03/D-12）：时间与工作日**共享原语**（缺失值 + 业务日/边界日 + 展示口径） ----------
// AI-204（计划行时间进度）与 PM-204（里程碑子项，P2）都从这里取数：计算模型各自维护，
// 日期/工作日/缺失值/边界日口径单源。前端同语义镜像在 `web/src/utils/workday.ts`，
// 由 `scripts/tests/verify-t03168-time-primitives.mts` 网格比对钉住（沿用 e1 镜像比对通道）。

/**
 * D-12：某时刻在指定 IANA 时区的**日历日**（YYYY-MM-DD）。
 * `tz` 空/非法回落系统时区（「项目未配置时区则跟随系统时区」的产品口径由调用方与这里共同保证）。
 */
export function ymdInTimezone(now: Date, tz?: string | null): string {
  try {
    if (tz) return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch { /* 非法时区名：按未配置处理 */ }
  return fmtDate(now);
}

/** 真实日历日：形状对且能原样回写（拒绝 2026-02-30 / 2026-13-01 这类「形状合法但不存在」的日期） */
function isRealYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseYmd(s);
  return !Number.isNaN(d.getTime()) && fmtDate(d) === s;
}

/**
 * D-12 边界日口径（**统一测试固定**）：纯日期 `end_date` 按项目/系统时区**当日结束**判到期——
 * 该时区当前日历日 `>` end_date 才算逾期；`===` 当天不算。缺失/非法日期一律 false（由调用方按「无排期」处理，不静默判逾期）。
 */
export function isPastEndDate(endDate: string, now: Date, tz?: string | null): boolean {
  if (!isRealYmd(endDate || '')) return false;
  return ymdInTimezone(now, tz) > endDate;
}

/**
 * 缺失值口径（PRD §487「缺失值不得静默按 0」）：区间工作日数，入参缺失/非法返回 **null**（≠0）。
 * 与 `countWorkdaysBetween` 的分工：那边把非法入参折成 0 供「已过期/无剩余」语义直接使用；
 * 这里保留「没有排期」与「排期为 0」的区分，供预测/清单类展示（「—」）使用。
 */
export function countWorkdaysOrMissing(from: string, to: string, cal: WorkdayCal): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return null;
  return countWorkdaysBetween(from, to, cal);
}

/** 缺失值统一展示符（消费侧「暂无可比计划」「数据积累中」等文案各自的裁决单负责；单源的是「缺失 ≠ 0」这一层） */
export const MISSING_DISPLAY = '—';

/** 数值或缺失的统一展示：null/undefined → 「—」，不把缺失渲染成 0 */
export function displayWorkdays(v: number | null | undefined): string {
  return v === null || v === undefined ? MISSING_DISPLAY : String(v);
}
