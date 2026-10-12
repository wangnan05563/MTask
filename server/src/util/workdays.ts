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
