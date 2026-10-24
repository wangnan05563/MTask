/**
 * T02857（六期 S6）：阶段性总结汇报 PPT 面板的纯规则层（无 React 依赖，便于门直接 import 对账）。
 *
 * 三块内容：
 *  1. **值域镜像**：章节 / 版式 / 必含数据块 / 合并版每项目页数 / 自定义周期上限——单源在服务端
 *     `summaryPptOutline.ts` 与 `summaryPptPeriod.ts`；`verify-t02857-summary-panel` 逐项与真常量对账。
 *  2. **日期口径**：只认 `YYYY-MM-DD` 的本地时区解析，与服务端 `parseYmdLocal` 同义；
 *     自定义区间预检文案与 `assertCustomRange` 同义（服务端仍是最终裁决）。
 *  3. **大纲缺项预检**：只覆盖最常见的结构性错误（封面/目录顺序、9 个数据块、合并版每项目 4 页），
 *     目的是少发一次注定 400 的 SSE 请求；不替代 `validateSummaryOutline`。
 *
 * 抽成独立模块的原因：面板是 .tsx（含 React），门无法直接 import 纯函数；
 * 规则放这里后，门可以同时 import 本模块与服务端模块做「真对账」而不是源码字面比对。
 */

/** 大纲一页的结构口径（与 store 的 `SummaryOutlineItem` / 服务端 `SummaryOutlineItem` 同构） */
export interface OutlineRow {
  section: string;
  title: string;
  bullets: string[];
  dataKeys: string[];
  layout: string;
  projectId?: string;
}

/** 章节候选（服务端 `SUMMARY_SECTIONS`） */
export const SUMMARY_SECTIONS: readonly string[] = ['封面', '目录', '跨项目对比', '总体进展', '本期重点工作', '里程碑与阶段进展', '计划执行情况', '问题与风险', '工作量与质量', '交付物清单', '下阶段计划', '本期总结与展望', '附录'];
/** 版式候选（服务端 `SUMMARY_LAYOUTS`） */
export const SUMMARY_LAYOUTS: readonly string[] = ['cover', 'toc', 'twoCol', 'table', 'chart', 'timeline', 'list', 'chip', 'section', 'thanks'];
/** 单项目必含数据块（服务端 `REQUIRED_DATA_KEYS`：9 个数据块各至少一页） */
export const REQUIRED_SINGLE_KEYS: readonly string[] = ['kpi', 'highlights', 'milestones', 'planRows', 'risks', 'workload', 'deliverables', 'nextSteps', 'appendix'];
/** 合并版：结构页必含数据块（服务端 `validateSummaryOutline` 同判据） */
export const MERGED_STRUCTURE_KEYS: readonly string[] = ['compare', 'horizontal'];
/** 合并版：每个项目小结页必含数据块 */
export const MERGED_PROJECT_KEYS: readonly string[] = ['kpi', 'milestones', 'risks', 'nextSteps'];
/** 合并版：每个项目的小结页数（服务端 `SUMMARY_MERGED_PER_PROJECT`） */
export const MERGED_PER_PROJECT = 4;
/** 单份完整稿页数（服务端 `SUMMARY_PAGE_MIN/MAX`）；分别独立版每项目一份 */
export const SINGLE_PAGE_MIN = 12;
export const SINGLE_PAGE_MAX = 16;
/** 自定义周期上限（服务端 `SUMMARY_PPT_MAX_PERIOD_DAYS`，与 EventRetention 默认 90 天同源） */
export const SUMMARY_CUSTOM_MAX_DAYS = 90;
export const DAY_MS = 24 * 60 * 60_000;

function two(n: number): string { return String(n).padStart(2, '0'); }
export function ymd(d: Date): string { return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; }
export function todayYmd(): string { return ymd(new Date()); }
export function daysAgoYmd(days: number): string { const d = new Date(); d.setDate(d.getDate() - days); return ymd(d); }

export function parseYmd(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** 自定义区间客户端预检：文案与服务端 `assertCustomRange` 同义（服务端仍是最终裁决） */
export function customRangeErrorOf(start: string, end: string): string {
  if (!start || !end) return '自定义区间必须同时提供起始日与结束日';
  const s = parseYmd(start);
  if (!s) return `起始日不是合法日期：「${start}」`;
  const e = parseYmd(end);
  if (!e) return `结束日不是合法日期：「${end}」`;
  if (e.getTime() < s.getTime()) return `起始日不得晚于结束日：${start} 晚于 ${end}`;
  const today = parseYmd(todayYmd());
  if (today && e.getTime() > today.getTime()) return `结束日不得晚于今天：${end}`;
  const days = Math.round((e.getTime() - s.getTime()) / DAY_MS) + 1;
  if (days > SUMMARY_CUSTOM_MAX_DAYS) return `自定义汇报周期最长 ${SUMMARY_CUSTOM_MAX_DAYS} 天（当前 ${days} 天）`;
  return '';
}

/** 周期窗口展示：服务端给的是左闭右开 ISO 串，展示时把末端减 1ms 折回含尾日期 */
export function rangeText(range: { start: string; end: string } | undefined): string {
  if (!range) return '';
  const s = new Date(range.start); const e = new Date(new Date(range.end).getTime() - 1);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  return `${ymd(s)} ~ ${ymd(e)}`;
}

/**
 * 大纲与当前周期/范围的缺项检查（客户端预检；服务端 `validateSummaryOutline` 是唯一裁决）。
 * mode=separate（FR-6.2）：每项目一份完整稿——逐项目校验页数 12~16、封面/目录顺序与 9 个数据块。
 */
export function outlineGapOf(
  rows: readonly OutlineRow[],
  projectIds: readonly string[],
  mode: 'merged' | 'separate' = 'merged',
): string {
  if (rows.length === 0) return '请先生成并确认大纲';
  if (mode === 'separate' && projectIds.length > 1) {
    if (rows.some((r) => !r.projectId)) return '分别独立版每页都必须带 projectId（按项目分组）';
    const total = { min: SINGLE_PAGE_MIN * projectIds.length, max: SINGLE_PAGE_MAX * projectIds.length };
    if (rows.length < total.min || rows.length > total.max) {
      return `分别独立版 ${projectIds.length} 个项目总页数应在 ${total.min}~${total.max} 之间，当前 ${rows.length} 页`;
    }
    for (const pid of projectIds) {
      const mine = rows.filter((r) => r.projectId === pid);
      if (mine.length < SINGLE_PAGE_MIN || mine.length > SINGLE_PAGE_MAX) {
        return `项目 ${pid} 的独立稿页数应在 ${SINGLE_PAGE_MIN}~${SINGLE_PAGE_MAX} 之间，当前 ${mine.length} 页`;
      }
      if (mine[0]?.layout !== 'cover') return `项目 ${pid} 的第 1 页版式必须是 cover（封面）`;
      if (mine[1]?.layout !== 'toc') return `项目 ${pid} 的第 2 页版式必须是 toc（目录）`;
      const mineKeys = new Set(mine.flatMap((r) => r.dataKeys));
      const missing = REQUIRED_SINGLE_KEYS.filter((k) => !mineKeys.has(k));
      if (missing.length) return `项目 ${pid} 的独立稿缺少数据块页：${missing.join('、')}`;
    }
    return '';
  }
  if (rows[0]?.layout !== 'cover') return '第 1 页版式必须是 cover（封面）';
  if (rows[1]?.layout !== 'toc') return '第 2 页版式必须是 toc（目录）';
  const union = new Set(rows.flatMap((r) => r.dataKeys));
  if (projectIds.length <= 1) {
    const missing = REQUIRED_SINGLE_KEYS.filter((k) => !union.has(k));
    return missing.length ? `单项目稿缺少数据块页：${missing.join('、')}` : '';
  }
  const structural = MERGED_STRUCTURE_KEYS.filter((k) => !union.has(k));
  if (structural.length) return `合并版缺少结构页：${structural.join('、')}`;
  for (const pid of projectIds) {
    const mine = rows.filter((r) => r.projectId === pid);
    if (mine.length !== MERGED_PER_PROJECT) return `项目 ${pid} 的小结页必须恰好 ${MERGED_PER_PROJECT} 页，当前 ${mine.length} 页`;
    const mineKeys = new Set(mine.flatMap((r) => r.dataKeys));
    const missing = MERGED_PROJECT_KEYS.filter((k) => !mineKeys.has(k));
    if (missing.length) return `项目 ${pid} 的 ${MERGED_PER_PROJECT} 页中缺少：${missing.join('、')}`;
  }
  return '';
}
