/**
 * 极简 cron 解析与「下次触发时刻」计算（T01073 后续：循环任务精确时刻）。
 *
 * 支持标准 5 段式：`分 时 日 月 周`（minute hour day-of-month month day-of-week），
 * 每段可用通配星号、带步长（星号后接 /n，或 a-b/n）、单值、区间 a-b、列表 a,b,c。
 * 不支持 @yearly 等宏与月份/星期英文别名——循环任务只需覆盖「每天 9 点」「每周一 9:30」这类场景，
 * 宏属于语法糖，加了只增维护面。
 *
 * ⚠ 时区口径（最容易踩的坑）：cron 的**时分按本地时间解释**（用户填 `0 9 * * *` 期望的是本地 9:00，
 * 而不是 UTC 9:00——后者在国内等于下午 5 点触发）。而 `next_run_at` 列沿用既有格式
 * （`toISOString()` 截断的 UTC 串，与 daily/weekly/monthly 的推进结果同格式，字符串比较才等价），
 * 故本模块内部用本地时间匹配、输出时统一转成该 UTC 串。
 *
 * dom 与 dow 的 OR 语义（与 Vixie cron 一致）：两者都受限时取「或」——
 * `0 0 1 * 1` = 每月 1 号**或**每个周一，而非「既是 1 号又是周一」（后者可能永远不触发）。
 */
export interface CronSpec {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** dom 段是否为 `*`（用于 OR 语义判定） */
  domStar: boolean;
  /** dow 段是否为 `*` */
  dowStar: boolean;
}

/** 各段取值范围（dow 0~7，7 归一为 0=周日） */
const RANGES: Record<'minute' | 'hour' | 'dom' | 'month' | 'dow', [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7],
};

const FIELD_NAMES = ['分', '时', '日', '月', '周'] as const;

/** 解析单段：通配星号、带步长、单值 a、区间 a-b、列表 a,b,c（步长写法为「星号或区间 后接 /n」） */
function parseField(raw: string, [min, max]: [number, number], name: string): { values: number[]; star: boolean } {
  const out = new Set<number>();
  let star = false;
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg) throw new Error(`cron 第「${name}」段含空项`);
    const [rangePart, stepPart] = seg.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 第「${name}」段步长非法：${seg}`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      star = true;
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron 第「${name}」段取值非法：${seg}（允许 ${min}~${max}）`);
    }
    for (let v = lo; v <= hi; v += step) {
      // dow：7 与 0 同为周日，归一到 0 以免重复
      if (max === 7 && v === 7) out.add(0);
      else out.add(v);
    }
  }
  if (out.size === 0) throw new Error(`cron 第「${name}」段无有效取值`);
  return { values: [...out].sort((x, y) => x - y), star };
}

/** 解析完整表达式；非法即抛（错误信息直接回给 UI，故写清段名与原因） */
export function parseCron(expr: string): CronSpec {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式需 5 段（分 时 日 月 周），实际 ${parts.length} 段：${expr}`);
  }
  const minute = parseField(parts[0], RANGES.minute, FIELD_NAMES[0]);
  const hour = parseField(parts[1], RANGES.hour, FIELD_NAMES[1]);
  const dom = parseField(parts[2], RANGES.dom, FIELD_NAMES[2]);
  const month = parseField(parts[3], RANGES.month, FIELD_NAMES[3]);
  const dow = parseField(parts[4], RANGES.dow, FIELD_NAMES[4]);
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    domStar: dom.star,
    dowStar: dow.star,
  };
}

/** 便捷校验：合法返回 null，非法返回错误文案（UI 表单即时提示用） */
export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 本地时间的「YYYY-MM-DD HH:MM:SS」——与既有 next_run_at 存储格式对齐（RecurringService.now） */
function toStoreString(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** 日级匹配：dom/dow 的 OR 语义 */
function dayMatches(spec: CronSpec, y: number, mo: number, d: number): boolean {
  if (!spec.month.includes(mo)) return false;
  const domHit = spec.dom.includes(d);
  const dowHit = spec.dow.includes(new Date(y, mo - 1, d).getDay());
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowHit;
  if (spec.dowStar) return domHit;
  return domHit || dowHit;
}

/**
 * 计算表达式在 `from` 之后的**下一次**触发时刻。
 *
 * 按「天 → 时 → 分」三级剪枝：绝大多数日期在日级就被排除（O(1)），
 * 只有命中的日期才展开 24×60 比较，故即使扫 5 年也远快于逐分钟暴力推进。
 *
 * @returns 触发时刻；表达式在 5 年内都无解（如 `0 0 30 2 *`）返回 null
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const spec = parseCron(expr);
  // 起算点：from 的下一分钟（cron 不含秒级精度；等于当前分钟的已过期）
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const MAX_DAYS = 366 * 5; // 覆盖 2 月 29 日这类最长周期（闰年 4 年一轮）
  for (let offset = 0; offset < MAX_DAYS; offset++) {
    const y = start.getFullYear();
    const mo = start.getMonth() + 1;
    // 用本地日历推进：setDate 自动处理跨月/跨年与闰年
    const cursor = new Date(y, mo - 1, start.getDate() + offset);
    const cy = cursor.getFullYear();
    const cmo = cursor.getMonth() + 1;
    const cd = cursor.getDate();
    if (!dayMatches(spec, cy, cmo, cd)) continue;
    // 当天：从「起算时刻」往后找第一个命中的 时:分
    for (const h of spec.hour) {
      for (const m of spec.minute) {
        const cand = new Date(cy, cmo - 1, cd, h, m, 0, 0);
        if (cand.getTime() >= start.getTime()) return cand;
      }
    }
  }
  return null;
}

/** 直接返回存储格式的「下次触发时间」；无解时返回空串（调用方按「无可调度时刻」处理） */
export function nextCronRunText(expr: string, from: Date = new Date()): string {
  const d = nextCronRun(expr, from);
  return d ? toStoreString(d) : '';
}
