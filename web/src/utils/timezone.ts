/** T03268（PRD 4.2）：项目时区——前端合法性判定与候选列表，口径与后端 isValidTimeZone 一致（运行时 ICU） */

const FALLBACK_TZ_OPTIONS = [
  'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles',
];

/** 空串不是时区，而是「跟随系统」的语义值，调用方需单独处理 */
export function isValidIanaTz(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

let cachedOptions: string[] | null = null;

/**
 * 时区候选：优先运行时全量 IANA 列表（Intl.supportedValuesOf），老内核缺该 API 时回落到常见时区。
 * 列表整体缓存——每次渲染重建数百个 option 没有收益。
 */
export function tzOptions(): string[] {
  if (cachedOptions) return cachedOptions;
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    const list = typeof fn === 'function' ? fn('timeZone') : undefined;
    if (Array.isArray(list) && list.length > 0) cachedOptions = list;
  } catch {
    /* 老内核无 supportedValuesOf：走回落列表 */
  }
  cachedOptions ??= FALLBACK_TZ_OPTIONS;
  return cachedOptions;
}
