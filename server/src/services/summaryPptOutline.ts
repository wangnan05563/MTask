/**
 * 「阶段性项目总结汇报 PPT」大纲段（六期 S3，PRD-阶段性项目总结汇报PPT §3.4 第 2 步 / §4）。
 *
 * 两段 AI 的第一段：1 次 `askJson`（temperature=0，失败由 askJson 自带重试 1 次）产出
 * `[{section,title,bullets,dataKeys,layout}]`。本文件只做三件事：
 *  1. **拼提示词**——按项目数自适应预算（Σ≤6000 字符，每项目 = 6000/N），超限截断并带 `truncated`；
 *  2. **schema 校验**——页数/枚举/必含页/每项目绑定，模型能自己改对的项首轮硬失败走重试；
 *  3. **服务端二次拦截**——S1/S2 硬阻塞时直接拒，不烧配额（UI 置灰不是保险）。
 *
 * 数字纪律：大纲只写 `dataKeys` 引用，具体条数由 S4 装配器本地填充，提示词里明确禁止模型写数字。
 */
import { AIService } from './AIService';
import { parseAiJson } from './kickoffService';
import { periodRange, periodLabelOf, validateProjectIds, type ReportData, type SummaryPeriod } from './ReportService';
import { assertCustomRange, assertSummaryPeriod, type CustomRange } from './summaryPptPeriod';
import {
  assertSummaryNotBlocked,
  buildSummaryPreflight,
  gatherProjectFacts,
  gatherSummaryBundle,
  type ProjectFacts,
  type SummaryBundle,
  type SummaryPreflightItem,
} from './summaryPptService';

// ---------- 章节 / 版式 / 数据键（S3 与 S4 的唯一契约源） ----------

/** 单项目完整稿的 12 章（FR-5.1~FR-5.12，顺序固定）＋合并版的「跨项目对比」 */
export const SUMMARY_SECTIONS = [
  '封面',
  '目录',
  '跨项目对比',
  '总体进展',
  '本期重点工作',
  '里程碑与阶段进展',
  '计划执行情况',
  '问题与风险',
  '工作量与质量',
  '交付物清单',
  '下阶段计划',
  '本期总结与展望',
  '附录',
] as const;

/** 版式沿用 kickoff 的既有词表（`kickoff-layout.ts` 可直接断言），不另造新词 */
export const SUMMARY_LAYOUTS = ['cover', 'toc', 'twoCol', 'table', 'chart', 'timeline', 'list', 'chip', 'section', 'thanks'] as const;

/**
 * 数据块词表：与 FR-5 表逐行对应，键名尽量沿用 kickoff（`planRows`/`milestones`/`risks`/`workload`）。
 * `compare` / `horizontal` 只用于合并版（FR-6.1 的汇总对比页与横向对比页）。
 */
export const SUMMARY_DATA_KEYS = [
  'kpi',
  'highlights',
  'milestones',
  'planRows',
  'risks',
  'workload',
  'deliverables',
  'nextSteps',
  'summary',
  'appendix',
  'compare',
  'horizontal',
] as const;

export type SummaryLayout = (typeof SUMMARY_LAYOUTS)[number];
export type SummaryDataKey = (typeof SUMMARY_DATA_KEYS)[number];

export interface SummaryOutlineItem {
  section: string;
  title: string;
  bullets: string[];
  dataKeys: SummaryDataKey[];
  layout: SummaryLayout;
  /** 合并版分区键：每项目的 4 页必须带，取值为请求里的 projectId；单项目可省略 */
  projectId?: string;
}

// ---------- 参数与预算（PRD §3.4 / §6.2 B3） ----------

export const SUMMARY_PAGE_MIN = 12;
export const SUMMARY_PAGE_MAX = 16;
/** 合并版枚举结构固定页：封面/目录/汇总对比/横向对比/本期总结/附录 = 6（每项目 4 页另计） */
export const SUMMARY_MERGED_FIXED = 6;
export const SUMMARY_MERGED_PER_PROJECT = 4;
/** PRD §3.4 第 2 步的页数上限 */
export const SUMMARY_MERGED_CAP = 40;
/** 生成模式（PRD FR-6.1/6.2）：merged=单份合并稿；separate=每项目一份完整稿并打包 zip */
export const SUMMARY_MODES = ['merged', 'separate'] as const;
export type SummaryMode = (typeof SUMMARY_MODES)[number];
export const DEFAULT_SUMMARY_MODE: SummaryMode = 'merged';

/** mode 归一（缺省 merged）；非法值 400 点名，不静默当合并版跑 */
export function normalizeSummaryMode(raw: unknown): SummaryMode {
  const mode = (raw == null ? '' : String(raw)).trim() || DEFAULT_SUMMARY_MODE;
  if (!(SUMMARY_MODES as readonly string[]).includes(mode)) {
    throw new Error(`mode 仅支持 ${SUMMARY_MODES.join('/')}，当前为「${mode}」`);
  }
  return mode as SummaryMode;
}
/** 多项目摘要总预算（PRD §6.2 B3 的 Σ≤6000，统计摘要另计） */
export const SUMMARY_BUDGET = 6000;
export const TITLE_MAX = 30;
export const BULLET_MAX_CHARS = 42;
export const BULLET_MAX_LINES = 6;
/** 一页可挂的数据块上限（同 kickoff：3 块必然挤爆版面） */
export const DATA_KEYS_MAX = 2;
/** 结构页（纯版式，不承载数据块）：挂 dataKeys 一律清空（同 kickoff T02156） */
const STRUCTURAL_LAYOUTS: readonly string[] = ['cover', 'toc', 'section', 'thanks'];

/**
 * 页数约束：单项目 12~16；多项目合并版 = 枚举结构固定页 + 每项目 4 页 = **6+4N**（T02957 方案 A），且 ≤40。
 * 合并版结构是确定的（封面/目录/汇总对比/横向对比/本期总结/附录 6 页 + 每项目 4 页），不存在余量。
 */
export function expectedPageRange(projectCount: number): { min: number; max: number } {
  if (projectCount <= 1) return { min: SUMMARY_PAGE_MIN, max: SUMMARY_PAGE_MAX };
  // 夹到 CAP：调用方绕过 validateProjectIds 的 8 项目帽也不会出现越界
  const pages = Math.min(SUMMARY_MERGED_CAP, SUMMARY_MERGED_FIXED + SUMMARY_MERGED_PER_PROJECT * projectCount);
  return { min: pages, max: pages };
}
/** 区间文案：单点区间写成「18」而不是「18~18」 */
const rangeText = (r: { min: number; max: number }) => (r.min === r.max ? String(r.min) : `${r.min}~${r.max}`);

/** 分别独立版（FR-6.2）：每项目一份完整稿，总页数 = N×12 ~ N×16（单份上限仍是 16） */
export function expectedSeparateTotalRange(projectCount: number): { min: number; max: number } {
  const n = Math.max(1, projectCount);
  return { min: SUMMARY_PAGE_MIN * n, max: SUMMARY_PAGE_MAX * n };
}

/** 合并版「项目小结页」的锚定数据键：带这些键的页必须标 projectId（结构页/对比页反而不该标） */
const PER_PROJECT_KEYS: SummaryDataKey[] = ['kpi', 'milestones', 'risks', 'nextSteps'];

/** 每项目摘要预算：6000/N 向下取整（N=8 时 750） */
export function projectBudget(projectCount: number): number {
  return Math.floor(SUMMARY_BUDGET / Math.max(1, projectCount));
}

/** 单项目必须覆盖的数据块（封面/目录/总结是结构页与措辞页，不在此列） */
const REQUIRED_DATA_KEYS: SummaryDataKey[] = [
  'kpi',
  'highlights',
  'milestones',
  'planRows',
  'risks',
  'workload',
  'deliverables',
  'nextSteps',
  'appendix',
];

// ---------- 提示词拼装 ----------

export interface OutlinePromptInput {
  period: SummaryPeriod;
  periodLabel: string;
  range: { start: Date; end: Date };
  preflight: SummaryPreflightItem[];
  facts: ProjectFacts[];
  /** merged=合并稿（缺省）；separate=每项目完整稿（FR-6.2） */
  mode?: SummaryMode;
  /** 用户补的风格要求（`style` 入参，自由文本，最长 200 字） */
  style?: string;
  /** 用户附加要求（面板里手写的补充说明） */
  extraNote?: string;
}

const asText = (v: unknown): string => (v == null ? '' : String(v)).trim();

/** 一条事实块压到预算内：优先整行裁，最后硬裁；返回是否发生截断 */
export function clipFacts(lines: string[], budget: number): { text: string; truncated: boolean } {
  const full = lines.filter((l) => l.length > 0).join('\n');
  if ([...full].length <= budget) return { text: full, truncated: false };
  let out = '';
  for (const line of lines) {
    if (!line) continue;
    const next = out ? `${out}\n${line}` : line;
    if ([...next].length > budget - 1) break;
    out = next;
  }
  if (!out) out = [...full].slice(0, budget - 1).join('');
  return { text: `${out}…`, truncated: true };
}

/** 每项目摘要（预算内）；返回文本与截断标记 */
function projectFactsText(f: ProjectFacts, budget: number): { text: string; truncated: boolean } {
  const lines = [
    `项目：${f.name}`,
    `任务：总 ${f.tasks.total} / 已完成 ${f.tasks.done} / 已验证 ${f.tasks.verified}`,
    `计划：总 ${f.plans.total}（进行中 ${f.plans.doing}、阻塞 ${f.plans.blocked}、逾期 ${f.plans.overdue}）`,
    `里程碑：${f.milestones} 个；需求：${f.requirements} 条；用例：${f.testCases} 条；估算：${f.estimates} 行`,
    f.samples.length ? `计划样例（bullets 可引用名称）：${f.samples.map((t) => `「${t}」`).join('、')}` : '计划样例：无',
  ];
  return clipFacts(lines, budget);
}

/**
 * 拼 system/user 两段提示词。
 * 统计摘要（资料齐备性）**不计入** 6000 预算；只有各项目摘要受 N 等分预算约束（PRD §6.2 B3）。
 */
export function buildOutlinePrompt(input: OutlinePromptInput): {
  system: string;
  user: string;
  truncated: boolean;
  perProject: Array<{ id: string; name: string; chars: number; truncated: boolean }>;
  mode: SummaryMode;
  /** 每份稿的页数区间（separate 下也是单份 12~16） */
  pageRange: { min: number; max: number };
  /** 数组总页数区间：merged=pageRange；separate=N×12~N×16 */
  totalPageRange: { min: number; max: number };
} {
  const n = input.facts.length;
  const budget = projectBudget(n);
  const per = input.facts.map((f) => ({ id: f.id, name: f.name, ...projectFactsText(f, budget) }));
  const truncated = per.some((p) => p.truncated);
  const mode = input.mode ?? DEFAULT_SUMMARY_MODE;
  const separate = mode === 'separate';
  const pageRange = separate ? { min: SUMMARY_PAGE_MIN, max: SUMMARY_PAGE_MAX } : expectedPageRange(n);
  const totalPageRange = separate ? expectedSeparateTotalRange(n) : pageRange;
  const merged = n > 1 && !separate;
  const start = input.range.start.toISOString().slice(0, 10);
  const endDay = new Date(input.range.end.getTime() - 1).toISOString().slice(0, 10);
  const status = input.preflight.map((i) => `${i.key} ${i.label}=${i.count}（${i.status}）`).join('；');
  const usable = input.preflight.filter((i) => i.status === 'ok').map((i) => i.key);

  const system = `你是「阶段性项目总结汇报 PPT」的大纲编排器。只输出一个 JSON 数组，不要任何解释文字、不要代码围栏之外的内容。
数组每个元素是一页，形如 {"section":"","title":"","bullets":[""],"dataKeys":[""],"layout":"","projectId":""}，约束逐条遵守：
1. ${separate
    ? `分别独立版：每个项目一份完整稿（封面、目录 + 10 个内容章节），每项目 ${pageRange.min}~${pageRange.max} 页（共 ${totalPageRange.min}~${totalPageRange.max} 页）；数组按项目分组输出，每页必须带 projectId（取【项目清单】里的 id）。`
    : `页数 ${rangeText(pageRange)}；${merged ? `合并版结构固定：封面→目录→跨项目对比→每项目 4 页（总体进展/里程碑与阶段进展/问题与风险/下阶段计划）→横向对比→本期总结与展望→附录。` : '单项目完整稿：封面、目录 + 10 个内容章节（FR-5.3~FR-5.12），可按内容拆页但不得缺章。'}`}
2. section 只能取：${SUMMARY_SECTIONS.join(' / ')}；
3. layout 只能取：${SUMMARY_LAYOUTS.join(' / ')}；
4. dataKeys 只能取：${SUMMARY_DATA_KEYS.join(' / ')}；一页最多 ${DATA_KEYS_MAX} 个（建议每个数据块独占一页，严禁把多个数据块堆到同一页）；封面/目录/章节/致谢（cover/toc/section/thanks）为结构页，dataKeys 必须为空（不填任何数据块）；
5. 每页 bullets ≤${BULLET_MAX_LINES} 条，每条 ≤${BULLET_MAX_CHARS} 字；
6. ${merged
    ? `合并版必须有一页 dataKeys 含 "compare"（汇总对比）与一页含 "horizontal"（横向对比）；每项目的 4 页必须带 projectId（取【项目清单】里的 id），且该 4 页的 dataKeys 分别含 "kpi"、"milestones"、"risks"、"nextSteps"；`
    : `每个项目都必须覆盖的数据块：${REQUIRED_DATA_KEYS.map((k) => `"${k}"`).join(' / ')}（各至少一页）；`}
7. 铁律：凡条数、合计、覆盖率、日期、人天等数字，一律只写 dataKeys 引用，由系统按库内真实数据填充——严禁自行写数字或改写数字；
8. 只依据【资料齐备性】里标注为 ok 的数据源安排内容页；资源缺失的章节可保留页但走降级表述（布局允许）；
9. ${separate ? '每个项目的第 1 页 layout=cover、第 2 页 layout=toc' : '第 1 页 layout=cover、第 2 页 layout=toc'}（封面与目录都是结构页，dataKeys 必须为空）；章节分隔可用 layout=section（dataKeys 置空）；
10. bullets 必须引用【各项目摘要】里给过的具体名称（用「」包裹），不得写「相关工作有序推进」这类无指代套话；名称只能照抄，数字仍归 dataKeys；
11. 「问题与风险」页左栏是需求待确认（PRD 问题）、右栏是执行风险（逾期/阻塞/高复杂度），两栏都不许自造条目；
12. JSON 语法铁律：键名与字符串分隔符只能用英文双引号 "，「」只出现在 bullet 正文内部用于包裹名称，不得顶替双引号；数组/对象元素之间必须有逗号，不得写成 ["总 11""已完成"] 这种连写。`;

  const user = [
    `【汇报周期】${input.periodLabel}（${start} ~ ${endDay}）`,
    `【项目数】${n}${separate ? '（分别独立版：每项目一份完整稿）' : merged ? '（合并版：跨项目汇总 + 每项目小结）' : '（单项目完整稿）'}`,
    `【项目清单】${input.facts.map((f) => `${f.name}（id=${f.id}）`).join('；')}`,
    `【资料齐备性】${status}`,
    `【可用数据源（ok）】${usable.join('、') || '无'}`,
    `【各项目摘要】（每项目预算 ${budget} 字${truncated ? '，超限者已截断' : ''}）`,
    ...per.map((p) => `— ${p.name} —\n${p.text}`),
    input.style ? `【汇报风格】${input.style}` : '',
    input.extraNote ? `【用户补充要求】${input.extraNote}` : '',
    separate
      ? `请按上述约束输出 ${totalPageRange.min}~${totalPageRange.max} 页的大纲 JSON 数组（每项目 ${pageRange.min}~${pageRange.max} 页，逐页带 projectId）。`
      : `请按上述约束输出 ${pageRange.min}~${pageRange.max} 页的大纲 JSON 数组。`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    system,
    user,
    truncated,
    perProject: per.map((p) => ({ id: p.id, name: p.name, chars: [...p.text].length, truncated: p.truncated })),
    mode,
    pageRange,
    totalPageRange,
  };
}

// ---------- schema 校验 ----------

/** 重试轮的精简提示词（把首轮违规原因原样回喂，比静态提示更有效——同 kickoff T02314） */
const OUTLINE_SYSTEM_RETRY = `只输出 JSON 数组，元素 {section,title,bullets,dataKeys,layout,projectId}。
section∈[${SUMMARY_SECTIONS.join('|')}] layout∈[${SUMMARY_LAYOUTS.join('|')}] dataKeys⊆[${SUMMARY_DATA_KEYS.join('|')}]（每页≤${DATA_KEYS_MAX}；封面/目录/章节/致谢 cover/toc/section/thanks 为结构页，dataKeys 必须为空）
每页 bullets≤${BULLET_MAX_LINES} 条、每条≤${BULLET_MAX_CHARS} 字；单项目必须覆盖 kpi/highlights/milestones/planRows/risks/workload/deliverables/nextSteps/appendix；
合并版必须有 compare 与 horizontal 各一页，且每项目 4 页（kpi/milestones/risks/nextSteps）带 projectId；
分别独立版每项目 12~16 页、每页带 projectId，且每项目 cover/toc 与上述 9 个数据块齐全；
第 1 页 cover、第 2 页 toc；数字一律用 dataKeys 表示，禁止编造数字；bullets 用「」照抄输入出现过的名称。
JSON 语法：字符串只用英文双引号 "，「」只能出现在正文内部；元素之间必须有逗号。`;

function dedupeKeys(raw: unknown[], at: string): SummaryDataKey[] {
  const out: SummaryDataKey[] = [];
  for (const k of raw) {
    const key = String(k);
    if (!(SUMMARY_DATA_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${at} dataKeys 含未知项「${key}」（可用 ${SUMMARY_DATA_KEYS.join(' / ')}）`);
    }
    if (!out.includes(key as SummaryDataKey)) out.push(key as SummaryDataKey);
  }
  return out;
}

export interface ValidateContext {
  /** 请求范围（已展开）；合并版据此校验 projectId 绑定 */
  projectIds: string[];
  /** 生成模式（缺省 merged）：separate 要求每页绑定项目且每项目 12~16 页完整稿 */
  mode?: SummaryMode;
  /** 重试轮：bullet 超长转截断 + warning，不再整稿判废（同 kickoff 口径） */
  lenient?: boolean;
}

/** 逐页校验与规范化（拆出来压低认知复杂度） */
function validatePage(v: unknown, index: number, ctx: ValidateContext, warnings: string[]): SummaryOutlineItem {
  const at = `第 ${index + 1} 页`;
  if (!v || typeof v !== 'object') throw new Error(`${at} 不是对象`);
  const o = v as Record<string, unknown>;
  const layout = asText(o.layout);
  if (!(SUMMARY_LAYOUTS as readonly string[]).includes(layout)) {
    throw new Error(`${at} layout「${layout || '空'}」不在枚举（可用 ${SUMMARY_LAYOUTS.join(' / ')}）`);
  }
  const dataKeys = dedupeKeys(Array.isArray(o.dataKeys) ? o.dataKeys : [], at);
  // 结构页（cover/toc/section/thanks）是纯版式页，不承载数据块：直接清空并告警，
  // 不让「AI 在 toc 上堆 9 个数据块」这类输出把整稿打死（同 kickoff T02156）。
  if (STRUCTURAL_LAYOUTS.includes(layout) && dataKeys.length > 0) {
    warnings.push(`${at} layout=${layout} 为结构页，不应挂 dataKeys，已清空（原 ${dataKeys.length} 个：${dataKeys.join('/')}）`);
    dataKeys.length = 0;
  } else if (dataKeys.length > DATA_KEYS_MAX) {
    // 严格轮（首轮）抛错走自带重试；重试轮（lenient）截断为前 DATA_KEYS_MAX 个并告警，软着陆
    // （同 kickoff lenientDataKeys）。否则 temperature=0 下模型确定性复现同一结构，retry 永远过不了 → 整稿判废。
    if (!ctx.lenient) {
      throw new Error(`${at} dataKeys ${dataKeys.length} 个超出 ${DATA_KEYS_MAX} 个上限（${dataKeys.join('/')}）`);
    }
    const kept = dataKeys.slice(0, DATA_KEYS_MAX);
    const dropped = dataKeys.slice(DATA_KEYS_MAX);
    warnings.push(`${at} dataKeys ${dataKeys.length} 个超出 ${DATA_KEYS_MAX} 个上限，重试后仍超限，已截断为 ${kept.join('/')}（去掉：${dropped.join('/')}）`);
    dataKeys.length = 0;
    dataKeys.push(...kept);
  }
  const bullets = (Array.isArray(o.bullets) ? o.bullets : [])
    .map((b) => String(b ?? '').trim())
    .filter((b) => b.length > 0);
  for (let i = 0; i < bullets.length; i++) {
    const pts = [...bullets[i]];
    if (pts.length <= BULLET_MAX_CHARS) continue;
    if (!ctx.lenient) throw new Error(`${at} 第 ${i + 1} 条 bullet 超出 ${BULLET_MAX_CHARS} 字：${pts.slice(0, 20).join('')}…`);
    bullets[i] = pts.slice(0, BULLET_MAX_CHARS - 1).join('') + '…';
    warnings.push(`${at} 第 ${i + 1} 条 bullet ${pts.length} 字超出上限，重试后仍超限，已裁剪`);
  }
  if (bullets.length > BULLET_MAX_LINES) {
    warnings.push(`${at} bullet ${bullets.length} 条超出 ${BULLET_MAX_LINES} 条，已截断`);
    bullets.length = BULLET_MAX_LINES;
  }
  const rawTitle = asText(o.title);
  if (!rawTitle) throw new Error(`${at} 缺少标题`);
  const title = [...rawTitle].length > TITLE_MAX ? `${[...rawTitle].slice(0, TITLE_MAX).join('')}` : rawTitle;
  if (title !== rawTitle) warnings.push(`${at} 标题超 ${TITLE_MAX} 字，已截断`);
  const section = asText(o.section) || '正文';
  if (!(SUMMARY_SECTIONS as readonly string[]).includes(section)) warnings.push(`${at} 章节「${section}」不在标准清单，保留原值`);
  const pid = asText(o.projectId);
  if (ctx.projectIds.length > 1) {
    // 合并版只有「项目小结页」（带 kpi/milestones/risks/nextSteps）强制绑定 projectId；
    // 封面/目录/跨项目对比/总结/附录是全项目共享页，标了反而会把结构页算进某项目 4 页配额。
    // 分别独立版每页都属于某一个项目的完整稿，故每页都必须带 projectId。
    const needsPid = ctx.mode === 'separate' || dataKeys.some((k) => PER_PROJECT_KEYS.includes(k));
    if (needsPid && !pid) {
      throw new Error(`${at} 合并版的项目小结页（dataKeys 含 ${PER_PROJECT_KEYS.join('/')}）必须带 projectId（取值：${ctx.projectIds.join(' / ')}）`);
    }
    if (pid && !ctx.projectIds.includes(pid)) throw new Error(`${at} projectId「${pid}」不在请求范围（取值：${ctx.projectIds.join(' / ')}）`);
  } else if (pid && !ctx.projectIds.includes(pid)) {
    throw new Error(`${at} projectId「${pid}」不在请求范围（本次只有 ${ctx.projectIds.join(' / ') || '空'}）`);
  }
  const item: SummaryOutlineItem = { section, title, bullets, dataKeys, layout: layout as SummaryLayout };
  if (pid) item.projectId = pid;
  return item;
}

/**
 * 大纲 schema 校验（首轮严格→重试轮宽松：只有 bullet 超长转裁剪，页数/枚举/必含页仍硬失败）。
 * 必含页按 PRD：单项目覆盖 9 个数据块；合并版 compare + horizontal + 每项目 4 页绑定。
 */
export function validateSummaryOutline(raw: unknown, ctx: ValidateContext): { outline: SummaryOutlineItem[]; warnings: string[] } {
  if (!Array.isArray(raw)) throw new Error('大纲必须是 JSON 数组');
  const n = Math.max(1, ctx.projectIds.length);
  const mode = ctx.mode ?? DEFAULT_SUMMARY_MODE;
  const range = mode === 'separate' ? expectedSeparateTotalRange(n) : expectedPageRange(n);
  if (raw.length < range.min || raw.length > range.max) {
    const scope = mode === 'separate'
      ? `分别独立版 ${n} 个项目，共 ${range.min}~${range.max} 页`
      : (n > 1 ? `合并版 ${n} 个项目` : '单项目');
    throw new Error(`页数 ${raw.length} 不在 ${rangeText(range)} 页（${scope}）`);
  }
  const warnings: string[] = [];
  const outline = raw.map((v, i) => validatePage(v, i, ctx, warnings));
  if (mode === 'separate') {
    // FR-6.2：每项目一份完整稿——逐项目校验 cover/toc 与 9 个数据块，页数各 12~16
    for (const pid of ctx.projectIds) {
      const mine = n > 1 ? outline.filter((p) => p.projectId === pid) : outline;
      if (mine.length < SUMMARY_PAGE_MIN || mine.length > SUMMARY_PAGE_MAX) {
        throw new Error(`项目 ${pid} 的独立稿页数 ${mine.length} 不在 ${SUMMARY_PAGE_MIN}~${SUMMARY_PAGE_MAX} 区间`);
      }
      if (mine[0].layout !== 'cover') throw new Error(`项目 ${pid} 的第 1 页 layout 必须是 cover`);
      if (mine[1]?.layout !== 'toc') throw new Error(`项目 ${pid} 的第 2 页 layout 必须是 toc`);
      for (const key of REQUIRED_DATA_KEYS) {
        if (!mine.some((p) => p.dataKeys.includes(key))) {
          throw new Error(`项目 ${pid} 的独立稿缺少「${key}」页（须有一页 dataKeys 含 '${key}'）`);
        }
      }
    }
    return { outline, warnings };
  }
  if (outline[0].layout !== 'cover') throw new Error('第 1 页 layout 必须是 cover');
  if (outline[1].layout !== 'toc') throw new Error('第 2 页 layout 必须是 toc');
  if (n > 1) {
    for (const key of ['compare', 'horizontal'] as SummaryDataKey[]) {
      if (!outline.some((p) => p.dataKeys.includes(key))) {
        throw new Error(`合并版大纲缺少「${key}」页（须有一页 dataKeys 含 '${key}'）`);
      }
    }
    for (const pid of ctx.projectIds) {
      const mine = outline.filter((p) => p.projectId === pid);
      if (mine.length !== SUMMARY_MERGED_PER_PROJECT) {
        throw new Error(`项目 ${pid} 的小结页必须恰好 ${SUMMARY_MERGED_PER_PROJECT} 页，实际 ${mine.length} 页`);
      }
      for (const key of ['kpi', 'milestones', 'risks', 'nextSteps'] as SummaryDataKey[]) {
        if (!mine.some((p) => p.dataKeys.includes(key))) {
          throw new Error(`项目 ${pid} 的 ${SUMMARY_MERGED_PER_PROJECT} 页中缺少 dataKeys 含 '${key}' 的一页`);
        }
      }
    }
  } else {
    for (const key of REQUIRED_DATA_KEYS) {
      if (!outline.some((p) => p.dataKeys.includes(key))) {
        throw new Error(`大纲缺少「${key}」页（须有一页 dataKeys 含 '${key}'）`);
      }
    }
  }
  return { outline, warnings };
}

// ---------- 入口 ----------

export interface SummaryOutlineParams {
  period: unknown;
  projectIds?: string[];
  custom?: CustomRange;
  toolId: string;
  /** merged（缺省）/separate：分别独立版按「每项目完整稿」出大纲（FR-6.2） */
  mode?: unknown;
  style?: string;
  extraNote?: string;
  /** 测试注入用：默认 `AIService.askJson` */
  askJson?: typeof AIService.askJson;
}

export interface SummaryOutlineResult {
  outline: SummaryOutlineItem[];
  warnings: string[];
  /** 摘要是否发生过截断（PRD §6.2 B3 的 truncated 标记） */
  truncated: boolean;
  period: SummaryPeriod;
  periodLabel: string;
  mode: SummaryMode;
  /** 每份稿的页数区间（separate 下为单份 12~16） */
  pageRange: { min: number; max: number };
  /** 整稿页数区间（separate 下为 N 项合计 12N~16N） */
  totalPageRange: { min: number; max: number };
  projects: Array<{ id: string; name: string }>;
  /** 逐项目摘要字数（预算核对用，面板可显示） */
  budget: { total: number; perProject: number; chars: Array<{ id: string; name: string; chars: number }> };
}

/**
 * S3 入口：采集 → 拦截 → 拼提示词 → askJson（temperature=0，自带 1 次重试）→ 校验 → 返回。
 * 任何一次失败都不落库、不生成文件（本单只产大纲，装配在 S4）。
 */
export async function summaryOutline(params: SummaryOutlineParams): Promise<SummaryOutlineResult> {
  const toolId = asText(params.toolId);
  if (!toolId) throw new Error('toolId 必填（大纲生成需要模型工具）');
  const mode = normalizeSummaryMode(params.mode);
  const period = assertSummaryPeriod(params.period);
  const { ids, error } = validateProjectIds(params.projectIds);
  if (error) throw new Error(error);
  if (period === 'custom') {
    const rangeError = assertCustomRange(params.custom);
    if (rangeError) throw new Error(rangeError);
  }
  const style = asText(params.style);
  if (style.length > 200) throw new Error(`style 最长 200 字，当前 ${style.length} 字`);

  const bundle: SummaryBundle = gatherSummaryBundle(period, ids, params.custom);
  const preflight = buildSummaryPreflight(bundle);
  assertSummaryNotBlocked(preflight);
  const facts = gatherProjectFacts(period, bundle.projectIds, params.custom, bundle.report);
  const prompt = buildOutlinePrompt({
    period,
    periodLabel: bundle.periodLabel,
    range: bundle.range,
    preflight: preflight.items,
    facts,
    mode,
    style: style || undefined,
    extraNote: asText(params.extraNote) || undefined,
  });

  let round = 0;
  const ask = params.askJson ?? AIService.askJson;
  const ai = await ask<{ outline: SummaryOutlineItem[]; warnings: string[] }>(
    toolId,
    prompt.system,
    prompt.user,
    (content) => {
      round++;
      return validateSummaryOutline(parseAiJson(content), { projectIds: bundle.projectIds, mode, lenient: round > 1 });
    },
    {
      temperature: 0,
      retrySystem: OUTLINE_SYSTEM_RETRY,
      retrySystemFromError: (lastError) => `${OUTLINE_SYSTEM_RETRY}\n\n【上一轮输出被拒的原因，必须逐条修正后重新输出】\n${lastError}`,
      cardKey: 'ai.summary_ppt', // T03296（G-2）：显式归属卡片，不靠 kind 推断
    },
  );
  if (!ai.ok || ai.data === undefined) throw new Error(`AI 未返回合规大纲：${ai.error ?? '未知原因'}`);

  const warnings = [...ai.data.warnings];
  if (prompt.truncated) {
    const hit = prompt.perProject.filter((p) => p.truncated).map((p) => p.name);
    warnings.push(`项目摘要超出每项目 ${projectBudget(facts.length)} 字预算，已截断：${hit.join('、')}（truncated）`);
  }
  if (ai.retried) warnings.push('首轮大纲不合 schema，已自动重试 1 次后通过');
  return {
    outline: ai.data.outline,
    warnings,
    truncated: prompt.truncated,
    period,
    periodLabel: bundle.periodLabel,
    mode,
    pageRange: prompt.pageRange,
    totalPageRange: prompt.totalPageRange,
    projects: facts.map((f) => ({ id: f.id, name: f.name })),
    budget: {
      total: SUMMARY_BUDGET,
      perProject: projectBudget(facts.length),
      chars: prompt.perProject.map((p) => ({ id: p.id, name: p.name, chars: p.chars })),
    },
  };
}

/** 供门与面板核对：周期标签 + 窗口（避免 UI 侧重算） */
export function outlineWindow(period: SummaryPeriod, custom?: CustomRange) {
  const r = periodRange(period, custom);
  return { label: periodLabelOf(period), start: r.start.toISOString(), end: r.end.toISOString() };
}

export type { ReportData };
