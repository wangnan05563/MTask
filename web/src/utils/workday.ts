/**
 * T01059 后续：前端工作日计算——与服务端 PlanService（isWorkday / calcEndDate）同口径。
 *
 * 口径（务必与服务端保持一致，否则甘特拖动后服务端重算的 end_date 会和预览不一致）：
 * - 加班日（kind=overtime）优先视为工作日；
 * - 否则周六日非工作日；
 * - 其余落在放假日表（kind != overtime）中的日期非工作日。
 */

/** 与服务端 fmt() 同格式：YYYY-MM-DD（本地时区，不用 toISOString 以免 UTC 偏移） */
export function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → Date（本地零点） */
export function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

/** 放假日集合：kind !== 'overtime' 的节假日 */
export function buildHolidaySet(holidays: Array<{ date: string; kind: string }>): Set<string> {
  return new Set(holidays.filter((h) => h.kind !== 'overtime').map((h) => h.date));
}

/** 加班日集合：周末/节假日里照常上班的日期 */
export function buildOvertimeSet(holidays: Array<{ date: string; kind: string }>): Set<string> {
  return new Set(holidays.filter((h) => h.kind === 'overtime').map((h) => h.date));
}

export interface WorkdayCtx {
  holidays: Set<string>;
  overtime: Set<string>;
}

export function buildWorkdayCtx(holidays: Array<{ date: string; kind: string }>): WorkdayCtx {
  return { holidays: buildHolidaySet(holidays), overtime: buildOvertimeSet(holidays) };
}

/** 工作日判定（服务端 isWorkday 的前端镜像） */
export function isWorkday(d: Date, ctx: WorkdayCtx): boolean {
  if (ctx.overtime.has(fmtDate(d))) return true;
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  return !ctx.holidays.has(fmtDate(d));
}

/** 起始日起 n 个工作日的含尾结束日（服务端 calcEndDate 的前端镜像）；n < 1 视作 1 */
export function calcEndDate(start: string, durationDays: number, ctx: WorkdayCtx): string {
  const d = parseYmd(start);
  let left = Math.max(1, Math.floor(durationDays));
  while (left > 0) {
    if (isWorkday(d, ctx)) left -= 1;
    if (left > 0) d.setDate(d.getDate() + 1);
  }
  return fmtDate(d);
}

/** [start, end] 闭区间内的工作日天数（end < start 时返回 0） */
export function countWorkdays(start: string, end: string, ctx: WorkdayCtx): number {
  const d = parseYmd(start);
  const last = parseYmd(end);
  let n = 0;
  // 上限 3660 天防御异常输入（约 10 年），避免死循环
  for (let guard = 0; guard < 3660 && d.getTime() <= last.getTime(); guard++) {
    if (isWorkday(d, ctx)) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

/** 向前（含当天）吸附到工作日——拖动起始日落在周末/节假日时用它归位 */
export function snapWorkdayForward(s: string, ctx: WorkdayCtx): string {
  const d = parseYmd(s);
  for (let guard = 0; guard < 60 && !isWorkday(d, ctx); guard++) d.setDate(d.getDate() + 1);
  return fmtDate(d);
}

/** 向后（含当天）吸附到工作日——拖动结束日落在周末/节假日时用它归位 */
export function snapWorkdayBack(s: string, ctx: WorkdayCtx): string {
  const d = parseYmd(s);
  for (let guard = 0; guard < 60 && !isWorkday(d, ctx); guard++) d.setDate(d.getDate() - 1);
  return fmtDate(d);
}

/**
 * 从锚点日向后走 n 个工作日的落点日（**锚点日不计入**，n=1 即锚点之后的第一个工作日）。
 * 服务端 `server/src/util/workdays.ts:addWorkdays` 的前端镜像，两侧由 `scripts/estimate-e1-test.mjs`
 * 逐日网格比对（估算的人天→日历天换算与日历天列展示都靠它，口径必须一致）。
 */
export function addWorkdays(anchor: string, n: number, ctx: WorkdayCtx): string {
  if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return anchor;
  const d = parseYmd(anchor);
  if (n <= 0) {
    while (!isWorkday(d, ctx)) d.setDate(d.getDate() + 1);
    return fmtDate(d);
  }
  let left = Math.floor(n);
  for (;;) {
    d.setDate(d.getDate() + 1);
    if (isWorkday(d, ctx)) {
      left -= 1;
      if (left === 0) return fmtDate(d);
    }
  }
}

/** 日历日加减（不跳周末） */
export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
