/**
 * T03590：讲稿卡「采集范围」三个点选控件的纯逻辑。
 *
 * 为什么单独成文件：分支模糊过滤、日期范围换算（结束日要含当天 → 23:59:59）、
 * 提交人标签与 `甲 | 乙` 的互转，这三件事全是不碰 DOM 的判定，抽出来 node 门可以直接对返回值断言，
 * 不必先起浏览器；组件（ui/GitScopeControls.tsx）只负责渲染与焦点。
 *
 * 与既有采集口径的关系：这里**不新增**任何 git 语义——
 *  - 分支选项来自 `git log --all` 的引用装饰（服务端已有），选中只是回填版本号字段；
 *  - 日期范围落成服务端认识的两个字符串 `since` / `until`（`--since` / `--until` 同形）；
 *  - 提交人标签只按 `|` 分组、组内保留原样（`,` 仍是服务端的「且」），回填后与手输完全等价。
 */

export interface BranchOption {
  type: 'branch' | 'remote' | 'tag';
  name: string;
}

const TYPE_WEIGHT: Record<BranchOption['type'], number> = { branch: 0, remote: 1, tag: 2 };

/** 子序列匹配：`frs` 能按顺序命中 `feature/refactor-scope`，用于「跳字母」式模糊搜 */
export function isSubsequence(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * 模糊匹配档位：0 全等 / 1 前缀 / 2 子串 / 3 子序列 / -1 不命中。
 * 档位越小越靠前，保证「输入 main 时 main 排在 origin/maintenance 前面」。
 */
export function fuzzyRank(name: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  if (isSubsequence(n, q)) return 3;
  return -1;
}

/** 分支候选过滤 + 排序（去重按 type:name）；`limit` 只截显示条数，不改数据 */
export function filterBranches(options: readonly BranchOption[], query: string, limit = 100): BranchOption[] {
  const seen = new Set<string>();
  const scored: Array<{ option: BranchOption; rank: number }> = [];
  for (const option of options) {
    const key = `${option.type}:${option.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rank = fuzzyRank(option.name, query);
    if (rank < 0) continue;
    scored.push({ option, rank });
  }
  scored.sort((a, b) => a.rank - b.rank
    || TYPE_WEIGHT[a.option.type] - TYPE_WEIGHT[b.option.type]
    || a.option.name.localeCompare(b.option.name));
  return scored.slice(0, Math.max(0, limit)).map((s) => s.option);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 严格校验 `YYYY-MM-DD`（含 2 月 30 日这类越界日） */
export function isValidDay(day: string): boolean {
  const m = DATE_ONLY.exec(day.trim());
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/**
 * 从用户可编辑的原始值里取「日期部分」：
 * `2026-10-01` / `2026-10-01 00:00:00` / `2026-10-01T00:00:00` 都认；`14 days ago` 这类相对写法返回 null。
 */
export function dayOf(raw: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.exec(raw.trim());
  return m && isValidDay(m[1]) ? m[1] : null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 本地时区的 `YYYY-MM-DD`（不要用 toISOString：UTC 会跨日） */
export function isoOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayIso(now: Date = new Date()): string {
  return isoOf(now);
}

export function addDays(day: string, delta: number): string {
  const m = DATE_ONLY.exec(day);
  if (!m) return day;
  return isoOf(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta));
}

export function compareDay(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 结束边界：`--until=2026-10-28` 会漏掉当天提交，必须补到 23:59:59 */
export const endBoundary = (day: string): string => `${day} 23:59:59`;

export type DatePresetKey = 'today' | 'yesterday' | 'last7' | 'last30';

export interface DatePreset {
  key: DatePresetKey;
  label: string;
  start: string;
  end: string;
}

/** 快捷项：今天 / 昨天 / 近 7 天（含今天）/ 近 30 天（含今天） */
export function datePresets(today: string): DatePreset[] {
  return [
    { key: 'today', label: '今天', start: today, end: today },
    { key: 'yesterday', label: '昨天', start: addDays(today, -1), end: addDays(today, -1) },
    { key: 'last7', label: '近 7 天', start: addDays(today, -6), end: today },
    { key: 'last30', label: '近 30 天', start: addDays(today, -29), end: today },
  ];
}

export interface SinceWindow {
  since?: string;
  until?: string;
  error?: string;
}

/**
 * 面板两个原始输入 → 服务端 `since` / `until`。
 * 起始允许相对写法（沿用改造前的 `14 days ago`），但**结束只接受日期**：
 * 相对写法做右端无法保证「含结束日」，静默换算比报错更坑。
 */
export function buildSinceWindow(startRaw: string, endRaw: string): SinceWindow {
  const start = startRaw.trim();
  const end = endRaw.trim();
  if (!start) return { error: '请选择起始日期（或直接填 14 days ago 这类相对时间）' };
  const startDay = dayOf(start);
  if (!startDay) {
    if (end) return { error: '结束日期只能与日期形式的起始日期一起用：请把起始也改成 YYYY-MM-DD' };
    return { since: start };
  }
  if (end) {
    const endDay = dayOf(end);
    if (!endDay) return { error: `结束日期「${end}」不是 YYYY-MM-DD` };
    if (compareDay(endDay, startDay) < 0) return { error: '开始日期不能晚于结束日期' };
    // 起始保持纯日期（与改造前单 since 的取值逐字一致，git 同样按当天 00:00 解释）；
    // 只有截止要补到 23:59:59，否则 `--until=2026-10-28` 会漏掉当天提交
    return { since: startDay, until: endBoundary(endDay) };
  }
  return { since: startDay };
}

/** 两个原始值 → 控件上的范围文案（不合法时原样回显，让用户看见自己填了什么） */
export function describeWindow(startRaw: string, endRaw: string): string {
  const start = startRaw.trim();
  const end = endRaw.trim();
  if (!start) return '';
  const startDay = dayOf(start);
  const endDay = dayOf(end);
  if (!startDay) return end ? `${start} ~ ${end}` : start;
  if (endDay) return `${startDay} ~ ${endDay}`;
  if (end) return `${startDay} ~ ${end}`;
  return `${startDay} 起`;
}

export interface MonthCell {
  iso: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

/** 月历 6×7 格（周一起始）；前后补上邻月日期，保证高度稳定不跳动 */
export function monthCells(year: number, month1: number, today: string): MonthCell[] {
  const first = new Date(year, month1 - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(year, month1 - 1, 1 - offset + i);
    const iso = isoOf(d);
    cells.push({ iso, day: d.getDate(), inMonth: d.getMonth() === month1 - 1, isToday: iso === today });
  }
  return cells;
}

export function shiftMonth(year: number, month1: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month1 - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function monthOf(day: string): { year: number; month: number } {
  const m = DATE_ONLY.exec(day);
  const now = new Date();
  return m ? { year: Number(m[1]), month: Number(m[2]) } : { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export interface DayRange {
  start: string;
  end: string;
}

/**
 * 月历点选语义：没有起点（或已有完整区间）→ 本轮从这一天重新开始；
 * 已有起点没终点 → 早于起点则重开，等于起点算单日，晚于起点则补成区间。
 */
export function pickDay(start: string, end: string, day: string): DayRange {
  if (!start || end) return { start: day, end: '' };
  if (compareDay(day, start) < 0) return { start: day, end: '' };
  if (day === start) return { start, end: day };
  return { start, end: day };
}

/** 提交人标签：只按「或」分隔符切分；组内的 `,` 是服务端的「且」，必须原样保留 */
export function parseAuthorGroups(raw: string): string[] {
  return raw.split(/[|｜]/).map((g) => g.trim()).filter(Boolean);
}

export function joinAuthorGroups(groups: readonly string[]): string {
  return groups.map((g) => g.trim()).filter(Boolean).join(' | ');
}

/** 新增一个「或」组（大小写不敏感去重；空白输入不产生标签） */
export function addAuthorGroup(groups: readonly string[], raw: string): string[] {
  const term = raw.trim();
  if (!term) return [...groups];
  const exists = groups.some((g) => g.toLowerCase() === term.toLowerCase());
  return exists ? [...groups] : [...groups, term];
}

export function removeAuthorGroup(groups: readonly string[], index: number): string[] {
  return groups.filter((_, i) => i !== index);
}

/** 下拉候选：排除已加标签，按模糊档位排序（空搜索词按候选原顺序） */
export function filterAuthorSuggestions(
  authors: readonly string[],
  groups: readonly string[],
  query: string,
  limit = 20,
): string[] {
  const taken = new Set(groups.map((g) => g.trim().toLowerCase()));
  const scored: Array<{ name: string; rank: number; index: number }> = [];
  authors.forEach((name, index) => {
    if (taken.has(name.trim().toLowerCase())) return;
    const rank = fuzzyRank(name, query);
    if (rank < 0) return;
    scored.push({ name, rank, index });
  });
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.name);
}

/** 单个提交人词的上限（与服务端 MAX_AUTHOR_TERM_LEN 同值，提前拦住而不是等 400） */
export const AUTHOR_TERM_MAX = 64;
/** 「或」组数上限（服务端 MAX_AUTHOR_TERMS 是词总数，这里按组提前拦，比服务端更保守） */
export const AUTHOR_GROUP_MAX = 8;

/** 输入清洗：去控制字符、截断到上限；返回 null 表示没有可用内容 */
export function sanitizeAuthorTerm(raw: string): string | null {
  const term = raw.replace(/[\0\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ');
  if (!term) return null;
  return term.slice(0, AUTHOR_TERM_MAX);
}
