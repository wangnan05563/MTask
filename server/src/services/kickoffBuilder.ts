/**
 * T02099：启动会 PPT 装配器（PRD-项目启动会PPT生成 FR-4 / 技术方案 §3.3 §4）。
 *
 * 职责边界：`采集 →（AI 大纲 → 用户确认）→ 逐页[dataKeys 取数 → 版式断言 → 原生对象] → Buffer`。
 * 本模块是全仓业务层 **唯一** import pptxgenjs 的地方（风险 R1：适配层独占，不散用）；
 * 几何与色彩判断一律委托 `kickoff-layout.ts`（T02098），这里只负责「把内容摆进框里并落成原生对象」。
 *
 * T02156：恒生模板视觉落地（PRD §7 非目标 N1 的 E-1 补单）。背景图取自
 * `server/src/services/assets/kickoff/`（2023恒生PPT模板.pptx 五页面角色背景的 1280×720 副本：
 * 封面/目录/章节/正文/结束各一张），品牌色走 `PALETTE.brand*` 单源；背景图缺失时降级为纯色纸面，
 * 绝不因此丢内容或出坏页。大纲新增 `section`（章节页：编号+标题）与 `thanks`（结束页）两个版式，
 * 与恒生模板的五页面结构对齐。
 *
 * 三条不可让的口径：
 * 1. 页面上的数字只来自 Bundle（库内真值）；AI 文本里可对错的数字一律改写并记 warning（FR-3.4 / 验收 8）。
 * 2. 只用 `addText/addTable/addChart/addShape` 原生对象（验收 5：PowerPoint/WPS 里可编辑），不整页贴图。
 * 3. 版式断言不过 → 该页降级「标题 + 正文」安全版式并 `warnings.push`（验收 7）——宁可素，不出坏页。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  FONT,
  KICKOFF_LAYOUT_DEF,
  MIN_BODY_PT,
  MIN_GAP,
  PALETTE,
  TEXT_SPLIT,
  TIMELINE_BAR_H,
  assertInBounds,
  auditPalette,
  axisTicks,
  barBox,
  checkPageText,
  dateRangeOf,
  diamondBox,
  estimateTextWidthIn,
  findOverlaps,
  framesFor,
  layoutFamilyOf,
  safeFrames,
  scaleBox,
  stackY,
  type Box,
  type DateRange,
  type LayoutFrames,
} from './kickoff-layout';
import { KICKOFF_ABORT_MSG, KICKOFF_PLACEHOLDER, type KickoffBundle, type KickoffDataKey, type KickoffOutlineItem } from './kickoffService';

/** 单页装配产物：一个块 = 一个原生对象 */
export interface Block {
  box: Box;
  text?: { content: string; pt: number; bold?: boolean; color?: string; align?: 'left' | 'center'; shrink?: boolean };
  table?: {
    header: string[];
    rows: string[][];
    /** T02685：列宽**相对权重**（绘制/测高时按表宽归一为英寸）。缺省各列均分。 */
    colW?: number[];
  };
  chart?: { type: 'bar' | 'doughnut'; name: string; labels: string[]; values: number[] };
  /**
   * 原生形状（FR-4.5 时间线）：`addShape` 落 `<a:prstGeom>`，PowerPoint 里可拖拽改。
   * `label`（T02198）：形状自带的居中标签，走 `addText` 的 `shape` 选项。
   * 必须是**一块一形状一带字**——「rect 块 + 叠一个 text 块」会被 `findOverlaps` 判成
   * 每对节点都重叠，等于给每个 flow 节点都造一次假坏页。
   */
  shape?: {
    kind: 'rect' | 'roundRect' | 'diamond' | 'line' | 'rightArrow';
    tone: 'bar' | 'milestone' | 'axis' | 'flowNode' | 'flow' | 'chip';
    label?: { text: string; pt: number; color?: string };
  };
}

export interface KickoffBuildResult {
  buffer: Buffer;
  warnings: string[];
  pageCount: number;
  /** 被降级为「标题+正文」的页码（1 起）；面板逐条列出，让用户知道去哪儿复核 */
  degradedPages: number[];
}

/** 表格外框留白（pptxgenjs 给表格的边距），行数换算时都要算上 */
const TABLE_PAD = 0.12;
const CHART_H = 2.4;
const MAX_TABLE_ROWS = 9;
/** 时间线条高之外，页脚带高度（底带 0.4" 内） */
const FOOTER_H = 0.3;

// ---------- T02156：恒生模板背景（E-1：模板视觉规范的单点落地） ----------

/**
 * 背景图定位候选：dev 态 `__dirname=server/src/services`（tsx 直跑 src），
 * 打包态 `=server/dist/services`（build 时 `src/services/assets` 整目录复制到 dist，见 server/package.json）。
 * 与 PrdGenService/TestCaseGenService 的 skills 定位同构——两处都找不到就不登记该版式（降级默认白版式）。
 */
const BG_DIR_CANDIDATES = [join(__dirname, 'assets', 'kickoff'), join(__dirname, '..', '..', 'src', 'services', 'assets', 'kickoff')];

/**
 * 恒生模板五页面角色 → 背景文件（来源：2023恒生PPT模板.pptx 各 slide 实际使用的版式背景）。
 * cover=模板 slide1/layout1 的 image1.jpg；toc=slide2/layout3 的 image2.jpeg；
 * section=slide3/layout5 的 image3.jpeg（中部浅蓝色带托章节标题）；
 * content=layout6 的纯白底 + 标题左侧蓝色装饰 image5.png 的合成件；
 * thanks=slide11/layout9 的 image6.jpeg（THANKS + LOGO + 版权区）。
 */
const BG_FILES = {
  cover: 'bg-cover.jpg',
  toc: 'bg-toc.jpg',
  section: 'bg-section.jpg',
  content: 'bg-content.jpg',
  thanks: 'bg-thanks.jpg',
} as const;
type BgKind = keyof typeof BG_FILES;

/** 背景种类 → 自定义版式名（defineSlideMaster 登记，页面按 layout 选版式） */
const BG_LAYOUT_NAMES: Record<BgKind, string> = {
  cover: 'KICKOFF_BG_COVER',
  toc: 'KICKOFF_BG_TOC',
  section: 'KICKOFF_BG_SECTION',
  content: 'KICKOFF_BG_CONTENT',
  thanks: 'KICKOFF_BG_THANKS',
};

/** 大纲 layout → 背景种类：封面/目录/章节/结束各一张，其余内容页共用（正文页白底+标题装饰） */
function bgKindOf(layout: string): BgKind {
  if (layout === 'cover') return 'cover';
  if (layout === 'toc') return 'toc';
  if (layout === 'section') return 'section';
  if (layout === 'thanks') return 'thanks';
  return 'content';
}

function brandBgPath(kind: BgKind): string | null {
  for (const dir of BG_DIR_CANDIDATES) {
    const p = join(dir, BG_FILES[kind]);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 把五张恒生背景登记为自定义版式（`defineSlideMaster` 的 `background`——
 * 注意 `defineLayout` 只登记尺寸不接背景，版式背景入口是 defineSlideMaster）。
 * 走版式而不是逐页 `slide.background`：同一张背景 14 页共用只落一份媒体
 * （逐页贴背景会被 pptxgenjs 按页复制成 14 份，1MB 稿里 76KB 图背 14 遍）。
 * 背景缺失的种类不登记——`addSlide({ masterName })` 找不到版式时回落默认白版式，
 * 丢的只是背景，内容与版式断言一条不受影响（与验收 7「宁可素不出坏页」同构）。
 */
function defineBrandBackgrounds(pptx: any): void {
  for (const kind of ['cover', 'toc', 'section', 'content', 'thanks'] as BgKind[]) {
    const bgPath = brandBgPath(kind);
    if (!bgPath) continue;
    pptx.defineSlideMaster({ title: BG_LAYOUT_NAMES[kind], background: { path: bgPath } });
  }
}

/** 数字呈现格式化（T02156：修「P84 43.020620726159656 人天」这类原始浮点直出） */
function fmtNum(n: number): string {
  return String(Math.round(n * 10) / 10);
}

// ---------- dataKeys 取数（数字唯一来源） ----------

function statusMark(status: string): string {
  if (status === 'done') return '已完成';
  if (status === 'doing') return '进行中';
  if (status === 'blocked') return '阻塞';
  return '未开始';
}

/** 缺失值出「待补充」占位（FR-4.1）：留空白会被读成「没有这项东西」，占位才表达「该去填」 */
function cell(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  return s || KICKOFF_PLACEHOLDER;
}

/** 表格统一收口：超限行折成一句「其余 n 条见 X」，比截断诚实，也不会让读者以为这就是全部 */
function clampRows(rows: string[][], rest: (n: number) => string[], cols: number): string[][] {
  const keep = rows.slice(0, MAX_TABLE_ROWS - 1);
  const hidden = rows.length - keep.length;
  if (hidden > 0) {
    const line = rest(hidden);
    keep.push([...line, ...Array.from({ length: cols - line.length }, () => '')]);
  }
  return keep;
}

function reqStatsLines(b: KickoffBundle): string[] {
  const done = b.requirements.filter((r) => r.status === 'done').length;
  const doing = b.requirements.filter((r) => r.status === 'doing').length;
  const unlinked = b.requirements.filter((r) => r.linkedPlans.length === 0).length;
  return [
    `需求 ${b.requirements.length} 条：已完成 ${done} / 进行中 ${doing} / 未开始 ${b.requirements.length - done - doing}`,
    `已关联计划 ${b.requirements.length - unlinked} 条，未关联 ${unlinked} 条`,
    `PRD 原文 ${b.prdDocs.length} 篇 · 里程碑 ${b.milestones.length} 个 · 计划 ${b.plans.length} 条`,
  ];
}

function reqListTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.requirements.map((r) => [r.req_no ?? '', (r.title ?? '').slice(0, 26), r.priority ?? '', statusMark(r.status ?? 'todo'), String(r.linkedPlans.length)]);
  // T02685：需求列给最大权重（窄列里需求名 2~3 行换行是表格越界的重灾区）
  return { header: ['编号', '需求', '优先级', '状态', '关联计划'], rows: clampRows(all, (n) => [`其余 ${n} 条`, '见需求跟踪矩阵'], 5), colW: [1, 2.4, 1, 1, 1.2] };
}

function planRowsTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.plans.map((p) => [p.title.slice(0, 20), `${cell(p.start_date)}~${cell(p.end_date)}`, cell(p.assignee), statusMark(p.status), `${p.progress}%`]);
  return { header: ['任务', '起止', '负责人', '状态', '进度'], rows: clampRows(all, (n) => [`其余 ${n} 条`, '见项目计划页'], 5), colW: [2.2, 1.5, 1, 0.9, 0.9] };
}

function milestonesTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.milestones.map((m) => [m.title.slice(0, 22), cell(m.start_date), cell(m.end_date), statusMark(m.status), `${m.progress}%`]);
  return { header: ['里程碑', '起', '止', '状态', '进度'], rows: clampRows(all, (n) => [`其余 ${n} 个`, '见项目计划页'], 5), colW: [2.2, 1.1, 1.1, 1, 0.9] };
}

function coverageLines(b: KickoffBundle): string[] {
  // P5 warn 承诺过的改写：零用例时不出「0 条 / 覆盖率 0%」这种把空缺冒充结论的数字。
  // 判据必须看 caseTotal（test_cases 计数）：旧写法看 total（需求数），有需求无用例时
  // 占位分支永不触发，页面把需求数写成「测试用例 N 条」（T02969）。
  if (b.coverage.caseTotal === 0) {
    return [
      `测试用例：本期未建（${KICKOFF_PLACEHOLDER}）——测试策略按 PRD 验收标准描述，覆盖统计待用例生成后补`,
      `需求 ${b.requirements.length} 条，尚无用例可比对覆盖`,
    ];
  }
  return [
    // 用例数与需求数各归各：覆盖/未覆盖是**需求**口径，不能挂在「测试用例 N 条」后面冒充用例数
    `测试用例 ${b.coverage.caseTotal} 条；需求 ${b.coverage.total} 条：已覆盖 ${b.coverage.covered} / 未覆盖 ${b.coverage.uncovered}`,
    `需求覆盖率 ${b.coverage.rate}%`,
  ];
}

function assigneesTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.assignees.map((a) => [a.name || KICKOFF_PLACEHOLDER, String(a.planCount)]);
  return { header: ['负责人', '承担任务数'], rows: clampRows(all, (n) => [`其余 ${n} 人`, '见项目计划页'], 2) };
}

/** FR-4.1：assignee 全空时整页占位 + 一句口径说明，禁止由 AI 编人名 */
function assigneesBlocks(b: KickoffBundle): Array<Omit<Block, 'box'>> {
  if (b.assignees.length === 0) {
    // 整页占位形态（t02101 U-07 / t02198 H-06 钉住）：说明文本 + 「待补充」表格行。
    // 注意：该表格信息量为零（文本已全覆盖），独占一页时是「有意的占位」；
    // 与其他数据块同页时的版面代价由 layoutBody 的占位表格降级规则处理（T02313）。
    return [
      {
        text: {
          content: `负责人来源为计划行的 assignee 字段，当前 ${b.plans.length} 条计划均未填写，一律记「${KICKOFF_PLACEHOLDER}」——会上现场确认后再补，页面不代填人名。`,
          pt: MIN_BODY_PT,
        },
      },
      { table: { header: ['负责人', '承担任务数'], rows: [[KICKOFF_PLACEHOLDER, String(b.plans.length)]] } },
    ];
  }
  return [{ table: assigneesTable(b) }];
}

/**
 * T02313：占位表格降级判据——无真实数据时产生的「待补充」单行表格（assignees 全空）。
 * 独占一页时它是「整页占位」（t02101 U-07 / t02198 H-06 的钉住形态，保留）；
 * 与其他数据块同页时它信息量为零（同 dataKey 的说明文本已全覆盖）却要占 1.02" 刚性高，
 * 会把同页真数据挤出版面——真链路第 14 页（workload+assignees 同页）就是这样丢的表格
 * （C-03「非时间线页零丢块」）。同页即降级去掉，信息不丢（文本还在）。
 */
function isPlaceholderTable(d: Omit<Block, 'box'>): boolean {
  return d.table != null && d.table.rows.length === 1 && d.table.rows[0]?.[0] === KICKOFF_PLACEHOLDER;
}

function risksTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.risks.map((r) => [r.item.slice(0, 22), r.impact.slice(0, 24), r.mitigation.slice(0, 24), r.source.slice(0, 12)]);
  return { header: ['风险', '影响', '应对', '依据'], rows: clampRows(all, (n) => [`其余 ${n} 项`, '见风险登记'], 4), colW: [2, 1.4, 1.4, 0.9] };
}

function workloadLines(b: KickoffBundle): string[] {
  const w = b.workload;
  if (w.noData) {
    // FR-4.6 占位分支：库内既无估算行也无工期，出「待补充」而不是把空缺写成 0 人天
    return [
      `总工作量：${KICKOFF_PLACEHOLDER}（无估算行，且 ${w.counted} 条计划均未填工期）`,
      `人月 = 人天 ÷ ${w.manDaysPerManMonth}（换算因子与估算视图同源），数据补齐后自动出数`,
      w.footer,
      `补数路径：估算工作台生成三点估算，或在项目计划逐条填「工期(工作日)」`,
    ];
  }
  // 合计行保持库内原值不取整（验收 6「页面数字与取数同源」按此断言）；
  // 取整只作用于派生量（报价/人月/阶段分布）的呈现，修「P84 43.020620726159656」直出
  const range = w.manDays.optimistic != null && w.manDays.pessimistic != null
    ? `${w.manDays.optimistic}~${w.manDays.pessimistic}（P50 ${w.manDays.expected}）`
    : `${w.manDays.expected}`;
  const lines = [
    `总工作量 ${range} 人天 ≈ ${w.manMonth} 人月（人月 = 人天 ÷ ${w.manDaysPerManMonth}）`,
    w.quote ? `报价区间：P50 ${fmtNum(w.quote.p50ManDays)} / P84 ${fmtNum(w.quote.p84ManDays)} 人天` : '报价区间：无三点估算，按工期口径',
    w.footer,
  ];
  if (w.phases.length) {
    const phaseText = w.phases.map((p) => `${p.phase} ${fmtNum(p.expected)}`).join(' / ');
    lines.push(`阶段分布：${phaseText} 人天`);
  }
  if (w.complexity.length) {
    const complexityText = w.complexity.map((c) => `${c.level}×${c.count}`).join(' / ');
    lines.push(`复杂度分布：${complexityText}`);
  }
  return lines;
}

function workspaceLines(b: KickoffBundle): string[] {
  return [
    b.project.workspacePath ? `工作空间：${b.project.workspacePath}` : '工作空间：未配置',
    b.workspaceNote ?? '技术章节按计划口径撰写，未引用工作空间内素材',
  ];
}

/** 时间线列表版（T02100 的甘特几何不可用时的回落形态，FR-4.5） */
function timelineListTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.plans.map((p) => [p.title.slice(0, 24), cell(p.start_date), cell(p.end_date), String(p.duration_days), statusMark(p.status)]);
  return { header: ['任务', '起', '止', '工期(工作日)', '状态'], rows: clampRows(all, (n) => [`其余 ${n} 条`, '见项目计划页'], 5) };
}

function preflightTable(b: KickoffBundle): NonNullable<Block['table']> {
  const mark = (s: string): string => {
    if (s === 'ok') return '✓';
    if (s === 'warn') return '⚠';
    return '✕';
  };
  return {
    header: ['项', '结论', '条数', '说明'],
    rows: b.preflight.items.map((i) => [`${i.key} ${i.label}`, mark(i.status), String(i.count), i.note.slice(0, 30)]),
  };
}

function prdDocLines(b: KickoffBundle): string[] {
  if (!b.prdDoc) return ['未导入 PRD 原文，技术章节按计划口径撰写'];
  // T02685：摘录行净化——剔除 Markdown 表格行（管道行/分隔行），剥行内加粗/代码/链接与行内残留管道，
  // 否则「| 模块 | 规则编号 |…」这类原文格式符会原样印上封面（用户实测截图问题 1）。
  const head = b.prdExcerpt
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l)) // 整行表格行（含表头与分隔行）
    .filter((l) => !/^\s*[-=:|\s]*$/.test(l)) // 纯分隔/空行
    .map((l) =>
      l
        // T02685 复测修正：行内剥离必须先于行首剥离——行首规则会先吃掉 ** 开头的加粗符，
        // 导致后面的 ** 失去配对而残留（首测 QA 抓到的正是这个顺序缺陷）
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s*\|.*$/, '')
        .replace(/^[#>*\-\s]+/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
    .filter((l) => l.length > 4)
    .slice(0, 5)
    .map((l) => l.slice(0, 44));
  return [`来源：${b.prdDoc.filename}（${b.prdDoc.updatedAt}）`, ...head, ...(b.prdTruncated ? ['摘要已截断，全文见 PRD 文档'] : [])];
}

/** dataKey → 内容块（不含坐标）。返回顺序即纵向堆叠顺序 */
export function blocksForKey(key: KickoffDataKey, b: KickoffBundle): Array<Omit<Block, 'box'>> {
  switch (key) {
    case 'prdDoc':
      return [{ text: { content: prdDocLines(b).join('\n'), pt: MIN_BODY_PT } }];
    case 'reqList':
      return [{ table: reqListTable(b) }];
    case 'reqStats':
      return [{ text: { content: reqStatsLines(b).join('\n'), pt: MIN_BODY_PT + 2 } }];
    case 'planRows':
      return [{ table: planRowsTable(b) }];
    case 'milestones':
      return [{ table: milestonesTable(b) }];
    case 'coverage':
      return [
        { text: { content: coverageLines(b).join('\n'), pt: MIN_BODY_PT } },
        ...(b.coverage.caseTotal > 0 ? [{ chart: { type: 'doughnut' as const, name: '用例覆盖', labels: ['已覆盖', '未覆盖'], values: [b.coverage.covered, b.coverage.uncovered] } }] : []),
      ];
    case 'assignees':
      return assigneesBlocks(b);
    case 'risks':
      return [{ table: risksTable(b) }];
    case 'workload':
      return [
        { text: { content: workloadLines(b).join('\n'), pt: MIN_BODY_PT } },
        ...(b.workload.phases.length >= 2 ? [{ chart: { type: 'bar' as const, name: '阶段人天', labels: b.workload.phases.map((p) => p.phase), values: b.workload.phases.map((p) => p.expected) } }] : []),
      ];
    case 'workspace':
      return [{ text: { content: workspaceLines(b).join('\n'), pt: MIN_BODY_PT } }];
    case 'timeline':
      return [{ table: timelineListTable(b) }];
    case 'preflight':
      return [{ table: preflightTable(b) }];
  }
}

// ---------- 时间线形状（FR-4.5：原生矩形条 + 里程碑菱形 + 日期轴） ----------

/** 左侧任务名列宽（英寸）：条形区从这之后开始，刻度与条必须共用同一栏框，否则错位 */
const TL_LABEL_W = 2.2;
const TL_LABEL_GAP = 0.15;
/** 轴带：刻度标签 + 轴线 + 骑在轴上的菱形 */
const TL_AXIS_H = 0.78;
/** 行高 = 条高 + 呼吸 */
const TL_ROW_H = TIMELINE_BAR_H + 0.16;
/** 甘特最多画这么多行：再挤下去条就成纸片，读者分不清哪条对应哪个任务 */
const MAX_TL_ROWS = 8;
/** 图内标注字号（行名/刻度/图例），与页脚 9pt 同口径，不受正文 ≥14pt 约束 */
const TL_NOTE_PT = 10;
/** 时间线区低于这个高度就画不出「轴 + 2 行」，回落列表版更诚实 */
const TL_MIN_H = TL_AXIS_H + TL_ROW_H * 2;
/** T02171：计划超出单页可排行数时最多续几页。6 页≈一个排期章节的篇幅上限，再多该按阶段拆排期而不是继续加页 */
const MAX_TL_PAGES = 6;

/**
 * 时间线分页窗口（T02171）：把「排不下的计划折成页脚提示」改成「换页继续画」。
 * `offset` 从第几条计划起画；`last` 是否本页序列的末页——只有末页才出「其余 n 条未绘出」注块，
 * 中间页的剩余量由下一页承载，注了就是谎报。
 */
export interface TimelineWindow {
  offset?: number;
  last?: boolean;
}

/** 渲染页 = 大纲项 + 可选的时间线窗口（分页后的续页仍是完整大纲项，页码/页脚口径不变） */
export type KickoffRenderPage = KickoffOutlineItem & { tlWindow?: TimelineWindow };

export interface TimelineResult {
  blocks: Block[];
  /** 缺起止日期、按口径不画的条数（不画猜出来的工期） */
  undated: number;
  /** 本页实绘的计划条数（分页探针据此前移 `offset`） */
  drawn: number;
  /** 本页之后仍未绘出的条数（末页折注 / 中间页续页口径） */
  overflow: number;
  /** 与同日里程碑并成一枚菱形绘制掉的里程碑数（一个都没少画，只是叠成一组） */
  mergedMilestones: number;
  /** 排完后的越界/重叠点名，非空即该页应降级 */
  violations: string[];
}

/**
 * 能否用形状版（技术方案 §4 P3/P4 口径）：
 * 无可用起止日期 → 线性映射没有依据；里程碑 0 个 → 验收 6 要求的菱形无从存在。
 * 两种情况都如实回落 `sort_order` 列表版，并把原因带进 warning 供面板复核。
 */
export function timelineDegradeReason(b: KickoffBundle): string | null {
  if (!dateRangeOf(b.plans)) return '库内计划没有可用的起止日期';
  if (b.milestones.length === 0) return '库内里程碑为 0 个';
  return null;
}

/**
 * 同日里程碑并组：相邻日期的菱形本就会叠在一起（跨度 3 周的稿里差 1 天 ≈ 0.29"，正好是一个菱形宽），
 * 并成一组而不是丢着不画——丢了就是「图上看 4 个、库里有 6 个」的假象。
 */
function clusterMilestones(times: number[], range: DateRange, bars: Box, axisY: number): Array<{ box: Box; count: number }> {
  const clusters: Array<{ box: Box; count: number }> = [];
  for (const t of times) {
    const box = diamondBox(t, range, bars, axisY);
    const last = clusters.at(-1);
    if (last && findOverlaps([last.box, box]).length > 0) {
      last.count += 1;
      continue;
    }
    clusters.push({ box, count: 1 });
  }
  return clusters;
}

/** 计划条逐行排布（按行序取 `plans`）：行名 + 条形，缺起止日期的行出「无起止日期」占位 */
function planBarBlocks(
  plans: Array<{ title: string; start_date: string; end_date: string }>,
  range: DateRange,
  bars: Box,
  labelX: number,
  rowsTop: number
): { blocks: Block[]; undated: number } {
  const blocks: Block[] = [];
  let undated = 0;
  for (const [i, p] of plans.entries()) {
    const rowY = rowsTop + i * TL_ROW_H;
    blocks.push({ box: { x: labelX, y: rowY - 0.01, w: TL_LABEL_W, h: TL_ROW_H - 0.03 }, text: { content: p.title.slice(0, 16), pt: TL_NOTE_PT } });
    const bar = barBox(p, range, bars, rowY);
    if (!bar) {
      undated += 1;
      blocks.push({ box: { x: bars.x, y: rowY, w: 1.3, h: TIMELINE_BAR_H }, text: { content: '无起止日期', pt: TL_NOTE_PT } });
      continue;
    }
    blocks.push({ box: bar, shape: { kind: 'rect', tone: 'bar' } });
  }
  return { blocks, undated };
}

/** 排完后的越界 / 重叠点名（轴线的两道豁免随检查一起搬到这里） */
function timelineViolations(blocks: Block[], frame: Box): string[] {
  const violations: string[] = [];
  for (const blk of blocks) {
    // 轴线按定义就是零高度参照线（`assertInBounds` 的「高度非正」只约束内容盒），
    // 把它排除出越界集，否则每页时间线都被判成坏页
    if (blk.shape?.tone === 'axis') continue;
    const reason = assertInBounds(blk.box, frame);
    if (reason) violations.push(`${blk.shape ? '形状' : '文本'}${reason}`);
  }
  // 轴线是参照线，菱形按设计就骑在它上面——把它排除出重叠集，否则每页都是「假越界」
  const overlaps = findOverlaps(blocks.filter((blk) => blk.shape?.tone !== 'axis').map((blk) => blk.box));
  if (overlaps.length) violations.push(`元素重叠 ${overlaps.length} 处`);
  return violations;
}

/**
 * 时间线页的形状装配（纯几何消费，坐标一律走 T02098 的 `barBox`/`diamondBox`/`axisTicks`）。
 * 排布：轴带（刻度 + 轴线 + 菱形）在上，计划条按起始日期升序逐行在下。
 * 同日挤在一起的里程碑按道下移，轴带容不下就**只计数不硬画**——压成叠在一起的两个菱形
 * 等于一个都没画，还骗人以为看清了。
 * `window`（T02171）：本页承载哪一段计划。缺省 = 从第 0 条起、按版面与 `MAX_TL_ROWS` 收，
 * 装不下的尾注口径与改造前一致（`last` 缺省为真）。
 */
export function timelineBlocks(b: KickoffBundle, frame: Box, window: TimelineWindow = {}): TimelineResult {
  const out: Block[] = [];
  const range = dateRangeOf(b.plans);
  if (!range) return { blocks: out, undated: b.plans.length, drawn: 0, overflow: 0, mergedMilestones: 0, violations: ['无可用日期范围'] };

  const bars: Box = {
    x: frame.x + TL_LABEL_W + TL_LABEL_GAP,
    y: frame.y,
    w: Math.max(0.6, frame.w - TL_LABEL_W - TL_LABEL_GAP),
    h: frame.h,
  };
  const axisY = frame.y + TL_AXIS_H - 0.26;
  const rowsTop = frame.y + TL_AXIS_H + 0.06;
  const bottom = frame.y + frame.h;

  // 刻度：文本盒右移贴刻度点，末格钳回轴右缘（越出画布就是越界页）
  for (const t of axisTicks(range, 4, bars)) {
    out.push({
      box: { x: Math.min(t.x, bars.x + bars.w - 0.62), y: frame.y + 0.04, w: 0.62, h: 0.24 },
      text: { content: t.label, pt: TL_NOTE_PT, align: 'center' },
    });
  }
  out.push({ box: { x: bars.x, y: axisY, w: bars.w, h: 0 }, shape: { kind: 'line', tone: 'axis' } });

  const times = b.milestones
    .map((m) => Date.parse(m.end_date || m.start_date || ''))
    .filter((t) => Number.isFinite(t))
    .sort((x, y) => x - y);
  const clusters = clusterMilestones(times, range, bars, axisY);
  const mergedMilestones = times.length - clusters.length;
  for (const c of clusters) out.push({ box: c.box, shape: { kind: 'diamond', tone: 'milestone' } });

  const ordered = [...b.plans].sort(
    (p, q) => (p.start_date || '9999-12-31').localeCompare(q.start_date || '9999-12-31') || p.sort_order - q.sort_order
  );
  const capacity = Math.floor((bottom - rowsTop) / TL_ROW_H);
  // T02171：按窗口取本页待承载的计划切片；`limit` 仍受版面容量钳制（分页只搬运，不放宽物理上限）
  const offset = Math.max(0, window.offset ?? 0);
  const rest = Math.max(0, ordered.length - offset);
  let limit = Math.min(MAX_TL_ROWS, rest, capacity);
  if (rest > limit) limit = Math.min(limit, Math.floor((bottom - 0.32 - rowsTop) / TL_ROW_H));
  limit = Math.max(0, Math.min(limit, rest));

  const rows = planBarBlocks(ordered.slice(offset, offset + limit), range, bars, frame.x, rowsTop);
  out.push(...rows.blocks);
  const undated = rows.undated;

  const overflow = rest - limit;
  if (overflow > 0 && (window.last ?? true)) {
    out.push({ box: { x: frame.x, y: bottom - 0.28, w: frame.w, h: 0.26 }, text: { content: `其余 ${overflow} 条计划未绘出，见「项目计划」列表页`, pt: TL_NOTE_PT } });
  }

  const violations = timelineViolations(out, frame);
  const mergedNote = mergedMilestones ? `（同日并成 ${clusters.length} 组）` : '';
  out.push({
    box: { x: frame.x, y: axisY - 0.13, w: TL_LABEL_W, h: 0.28 },
    text: { content: `◆ 里程碑 ${times.length} 个${mergedNote}`, pt: TL_NOTE_PT },
  });
  return { blocks: out, undated, drawn: limit, overflow, mergedMilestones, violations };
}

// ---------- 数字防幻觉改写（FR-3.4 / 验收 8） ----------

interface Metric {
  re: RegExp;
  /** 真值文案模板；unit 用于把改写后的量词还原，避免「需求 14 人天」这类缝合怪 */
  format: (v: string) => string;
  truth: (b: KickoffBundle) => string;
  /**
   * 库内没有这项数据时的整句占位（缺数时把 AI 的数字改成「0 人天 / 覆盖率 0%」，
   * 等于用一个假结论替换另一个假结论——这类指标缺数时只能出「待补充」）。
   */
  missing?: { when: (b: KickoffBundle) => boolean; format: () => string };
}

/**
 * 只认「中文标签 + 数字 + 量词」这类可判定真伪的写法。
 * 纯修辞数字（「两周内出原型」「三方协作」）不动——把它们改写成库内值会把正文变得语句不通。
 */
const METRICS: Metric[] = [
  { re: /需求\s*(\d+(?:\.\d+)?)\s*条/, format: (v) => `需求 ${v} 条`, truth: (b) => String(b.requirements.length) },
  { re: /计划\s*(\d+(?:\.\d+)?)\s*条/, format: (v) => `计划 ${v} 条`, truth: (b) => String(b.plans.length) },
  { re: /里程碑\s*(\d+(?:\.\d+)?)\s*[个条]/, format: (v) => `里程碑 ${v} 个`, truth: (b) => String(b.milestones.length) },
  {
    re: /用例\s*(\d+(?:\.\d+)?)\s*条/,
    format: (v) => `用例 ${v} 条`,
    truth: (b) => String(b.coverage.caseTotal),
    missing: { when: (b) => b.coverage.caseTotal === 0, format: () => `用例${KICKOFF_PLACEHOLDER}` },
  },
  {
    re: /覆盖率\s*(\d+(?:\.\d+)?)\s*%/,
    format: (v) => `覆盖率 ${v}%`,
    truth: (b) => String(b.coverage.rate),
    missing: { when: (b) => b.coverage.caseTotal === 0, format: () => `覆盖率${KICKOFF_PLACEHOLDER}` },
  },
  {
    re: /(\d+(?:\.\d+)?)\s*人天/,
    format: (v) => `${v} 人天`,
    truth: (b) => String(b.workload.manDays.expected),
    missing: { when: (b) => b.workload.noData, format: () => `工作量${KICKOFF_PLACEHOLDER}` },
  },
];

export function sanitizeBullets(bullets: string[], b: KickoffBundle, pageNo: number, warnings: string[]): string[] {
  return bullets.map((raw) => {
    let text = raw;
    for (const m of METRICS) {
      const hit = m.re.exec(text);
      if (!hit) continue;
      if (m.missing?.when(b)) {
        const ph = m.missing.format();
        text = text.replace(m.re, ph);
        warnings.push(`第 ${pageNo} 页数字由系统改写：AI 写「${hit[0].trim()}」，库内无此项数据，已改占位「${ph}」`);
        continue;
      }
      const truth = m.truth(b);
      if (hit[1] === truth) continue;
      text = text.replace(m.re, m.format(truth));
      warnings.push(`第 ${pageNo} 页数字由系统改写：AI 写「${hit[1]}」，库内实为「${truth}」`);
    }
    return text;
  });
}

// ---------- 版面计算 ----------

function textHeight(content: string, width: number, pt: number): number {
  const perLine = Math.max(8, Math.floor(width / (pt / 72)));
  const lines = content.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / perLine)), 0);
  return Math.min(3.2, Math.max(0.45, lines * (pt / 72) * 1.55));
}

// ---------- T02685：表格行高的确定性测高 ----------
// 旧口径 blockHeight(表格) = TABLE_ROW_H(0.3") × 行数：默认每格只占 1 行。
// 但 addTable 未设 rowH 且单元格不截字，pptxgenjs 按内容自撑行——窄列里
// 「交易主体风险校验」这类文本换 2~3 行，实际行高 0.45~0.66" ≫ 估算 0.3"，
// 表格整体越出盒底 → 与同页文字/页脚叠加、越出页面（用户实测截图问题 3/4）。
// 修法是让「测高 = 实测」成立：单元格截字封顶 TABLE_MAX_LINES 行 + 测高按同一
// 换行模型计算 + addTable 显式下发 rowH/colW。三处共用同一套换行参数，不会漂移。

const TABLE_FONT_PT = 10;
const TABLE_MAX_LINES = 2;
const TABLE_LINE_FACTOR = 1.35;
const TABLE_CELL_PAD = 0.1;

/** 显示宽度单位：全角（CJK/全角标点）记 1，半角记 0.55 */
function cjkLen(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0xff ? 1 : 0.55;
  return n;
}

/** 列宽（英寸）：colW 为相对权重时按表宽归一；缺省各列均分 */
function tableColWs(table: NonNullable<Block['table']>, width: number): number[] {
  const n = table.header.length;
  const raw = table.colW;
  if (raw && raw.length === n && raw.every((x) => x > 0)) {
    const sum = raw.reduce((s, x) => s + x, 0);
    return raw.map((x) => (x / sum) * width);
  }
  return Array(n).fill(width / n);
}

/** 单元格截字：封顶 TABLE_MAX_LINES 行（每行 perLine 个全角位），超出以 … 收尾 */
function fitCellText(text: string, colW: number, pt: number): string {
  const perLine = Math.max(2, Math.floor((colW - 0.06) / (pt / 72)));
  const maxUnits = perLine * TABLE_MAX_LINES;
  if (cjkLen(text) <= maxUnits) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = ch.charCodeAt(0) > 0xff ? 1 : 0.55;
    if (w + cw > maxUnits - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 行高估算：与 fitCellText 同一换行模型（截字后每格 ≤ TABLE_MAX_LINES 行，估算即上界） */
function estimateRowH(cells: string[], colWs: number[], pt: number): number {
  const perLine = colWs.map((w) => Math.max(2, Math.floor((w - 0.06) / (pt / 72))));
  const lines = Math.max(
    1,
    ...cells.map((t, i) => Math.min(TABLE_MAX_LINES, Math.max(1, Math.ceil(cjkLen(t) / perLine[i])))),
  );
  return lines * ((pt / 72) * TABLE_LINE_FACTOR) + TABLE_CELL_PAD;
}

/** 表格自然高：逐行估算之和 + 外框留白 */
function tableNaturalHeight(table: NonNullable<Block['table']>, width: number, pt: number): number {
  const colWs = tableColWs(table, width);
  return [table.header, ...table.rows].reduce((s, cells) => s + estimateRowH(cells, colWs, pt), TABLE_PAD);
}

/**
 * 表格的最小可排高度：收到 1 行（剩表头 + 折行提示）后的自然高——再收就只剩表头。
 * 预算层用它给刚性表格兜底：收行是丢数据，只能是「装不下」时的最后一步，
 * 不能让同页要点先把表格的预算吃成 0（那会走整块 drop，比少画几行更糟）。
 */
function tableMinHeight(table: NonNullable<Block['table']>, width: number): number {
  return tableNaturalHeight(fitTableRows(table, 1), width, TABLE_FONT_PT);
}

/** 块自然高（T02685 测高模型）：导出供验收门做同源期望值（T02956——门不再硬编码 0.3×行数旧公式） */
export function blockHeight(src: Omit<Block, 'box'>, width: number): number {
  if (src.chart) return CHART_H;
  if (src.table) return tableNaturalHeight(src.table, width, TABLE_FONT_PT);
  return textHeight(src.text?.content ?? '', width, src.text?.pt ?? MIN_BODY_PT);
}

/** 块最小可排高度：低于它画出来就是压扁的字或看不见的图，不如省略 */
const MIN_BLOCK_H = 0.45;
/**
 * 图表的最小**可读**高（T02172）：文本压到 0.45" 只是截字，图表压到 0.45" 是刻度、
 * 图例、环心全部叠成一团——块确实 placed 了（不丢内容），但人读不出任何结论，
 * 那比「少一块并点名」更糟。所以图表按类型另设下限，低于它宁可 drop 并留痕。
 */
const MIN_CHART_H = 1.2;

/** 柔性块的分型下限：图表要能读，文本只要不压字 */
function minReadableH(src: Omit<Block, 'box'>): number {
  return src.chart ? MIN_CHART_H : MIN_BLOCK_H;
}

/** `clampRows` 折行提示行的形态：`其余 n 条/个/人/项` */
const REST_ROW_RE = /^其余\s*(\d+)\s*(条|个|人|项)/;

/**
 * 版面收行（T02166）：`clampRows` 的上限是**信息密度**上限，不是**版面**上限。
 * 同页还有要点时，9 行表格的自然高（3.12"）会超过剩余高度——旧逻辑整块 drop，
 * 页面就只剩套话（用户反馈的「各页没有实际项目内容」）。这里按剩余高度反推可排行数，
 * 被再收掉的行**并进已有的「其余 n 条」计数**（没有提示行的补一行），
 * 保持「少画但不谎称画全」，同时绝不越页（表格是刚性块，裁盒无效）。
 */
export function fitTableRows(table: NonNullable<Block['table']>, maxRows: number): NonNullable<Block['table']> {
  const restIdx = table.rows.findIndex((r) => REST_ROW_RE.test((r[0] ?? '').trim()));
  const dataRows = restIdx >= 0 ? table.rows.filter((_, i) => i !== restIdx) : table.rows;
  if (restIdx < 0 && dataRows.length <= maxRows) return table;
  const restMatch = restIdx >= 0 ? REST_ROW_RE.exec((table.rows[restIdx][0] ?? '').trim()) : null;
  // T02172：`maxRows` 是**总行数**上限（含折行提示行）。此前用 `Math.max(1, …)` 兜底恒留 1 条数据行，
  // 于是 maxRows=1 时仍排「1 数据 + 1 计数」= 2 行 → 刚性表格超出预算 0.05" → 被整块 drop。
  // 图表抬到 1.2" 可读高后这类极限页变多，收无可收时让计数行单独成表：仍然「一条不谎称画全」，
  // 但块是 placed 的（少一块比画一块越界的更糟）。
  const visible = dataRows.slice(0, Math.max(0, Math.min(dataRows.length, maxRows - 1)));
  const hidden = (restMatch ? Number(restMatch[1]) : 0) + dataRows.length - visible.length;
  if (hidden <= 0) return { ...table, rows: visible };
  const restRow = restIdx >= 0 ? [...table.rows[restIdx]] : table.header.map(() => '');
  restRow[0] = `其余 ${hidden} ${restMatch?.[2] ?? '条'}`;
  while (restRow.length < table.header.length) restRow.push('');
  return { ...table, rows: [...visible, restRow] };
}

/** 行数上限：给定可用高度能排下几行数据（含表头与留白） */

/** 柔性块（文本/图表）的保底占位：裁到不能再裁也就这么多，预算与实排都按这个口径算 */
function flexStrip(blocks: Array<Omit<Block, 'box'>>): number {
  return blocks.filter((d) => d.table == null).reduce((s, d) => s + minReadableH(d) + MIN_GAP, 0);
}

/**
 * 纵向排布：刚性表格保自然高（裁盒无效），柔性块（文本/图表）在剩余高度内
 * 按自然高比例**等比裁**（T02166）——此前它们拿自然高排队，末尾的图表只剩
 * 零点几英寸 → 被 `pushStackedBlocks` 当「排不下」整块省略，页面少一块真数据。
 *
 * 等比裁用「注水」而非逐块 `max(下限, 比例)`：逐块取上限时，先触底的块把自己
 * 垫到下限、剩下的块仍按**全预算**分比例，两者相加就超出 `flexBudget`
 * （真链路第 9 页要点 0.45 + 图表 0.73 = 1.18 > 预算 1.005，多出的 0.18 直接把
 * 同页表格挤到「排不下」→ 又被整块省略）。注水口径：触底的块退出分配，
 * 余下预算在未完成块之间重分，因此柔性块合计恒 ≤ 预算（下限本身超预算时除外，
 * 那种页是真的装不下，仍走如实 drop）。
 */
function fitStack(cursor: number, blocks: Array<Omit<Block, 'box'>>, bottom: number, width: number, body: Box): Box[] {
  const naturals = blocks.map((d) => blockHeight(d, width));
  const gaps = MIN_GAP * Math.max(0, blocks.length - 1);
  const rigidSum = blocks.reduce((s, d, i) => s + (d.table ? naturals[i] : 0), 0);
  const flexIdx = blocks.map((d, i) => (d.table ? -1 : i)).filter((i) => i >= 0);
  const flexBudget = Math.max(0, bottom - cursor - gaps - rigidSum);
  const heights = naturals.slice();
  let reserved = 0;
  let pool = flexIdx.slice();
  for (;;) {
    const poolNat = pool.reduce((s, i) => s + naturals[i], 0);
    const budget = flexBudget - reserved;
    // T02172：触底线按块类型取（图表 1.2" / 文本 0.45"），不再统一 0.45"
    const firstBelowFloor = pool.find((i) => poolNat > 0 && (naturals[i] / poolNat) * budget < minReadableH(blocks[i]));
    if (firstBelowFloor === undefined) {
      for (const i of pool) heights[i] = poolNat > 0 ? Math.min(naturals[i], (naturals[i] / poolNat) * budget) : 0;
      break;
    }
    const floor = minReadableH(blocks[firstBelowFloor]);
    reserved += floor;
    heights[firstBelowFloor] = floor;
    pool = pool.filter((i) => i !== firstBelowFloor);
    if (!pool.length) break;
  }
  return stackY(cursor, heights.map((h) => ({ h })), MIN_GAP, { x: body.x, y: cursor, w: body.w, h: bottom - cursor });
}


/**
 * 把刚性表格收到版面预算内（同页多表均分预算）。
 * `budget` 已经扣掉要点/其他块要占的高度；排得下就原样返回，不无端收行。
 * T02685：改按 tableNaturalHeight（换行感知测高）逐行收缩，直到塞进均分预算；
 * 旧口径用 TABLE_ROW_H 固定行高反推行数，低估换行行高 → 收行不足 → 表格越界叠加。
 */
function fitRigidTables(blocks: Array<Omit<Block, 'box'>>, width: number, budget: number): Array<Omit<Block, 'box'>> {
  const rigid = blocks.filter((d) => d.table != null);
  if (!rigid.length) return blocks;
  const natural = rigid.reduce((s, d) => s + blockHeight(d, width) + MIN_GAP, 0);
  if (natural <= budget + 1e-6) return blocks;
  const per = Math.max(0, (budget - MIN_GAP * (rigid.length - 1)) / rigid.length);
  return blocks.map((d) => {
    if (d.table == null) return d;
    let t = d.table;
    while (t.rows.length > 1 && tableNaturalHeight(t, width, TABLE_FONT_PT) > per) {
      t = fitTableRows(t, t.rows.length - 1);
    }
    return { ...d, table: t };
  });
}

/**
 * 纵向堆叠的数据块：排不下就省略并如实回报，不硬塞。
 * T02166：只把 **表格** 当刚性——pptxgenjs `addTable` 会按 rows×rowH 自然铺开，
 * 传入的 h 只当最小高度；avail 不够时裁 h 无效，实际仍越过页面底带，
 * 而 `assertInBounds` 检的是裁后的假盒 → 既不降级也不 warning，用户看到「表格越出 PPT」。
 * 图表/文本可裁：addChart 是矢量渲染到指定盒；addText wrap 会在框内截字。二者按 avail 裁即可。
 */
function pushStackedBlocks(out: Block[], dropped: string[], dataBlocks: Array<Omit<Block, 'box'>>, boxes: Box[], bottom: number): void {
  dataBlocks.forEach((d, i) => {
    const natural = boxes[i].h;
    const avail = bottom - boxes[i].y;
    if (d.table != null) {
      // 1e-6 容差：版面预算与逐块 avail 是两次浮点减法，等值时必须算「排得下」
      if (avail + 1e-6 < natural) {
        dropped.push(describe(d));
        return;
      }
      out.push({ box: boxes[i], ...d });
      return;
    }
    if (avail < minReadableH(d)) {
      // T02172：图表拿不到可读高就整块省略并点名（宁可少一块，不画一块看不清的）
      dropped.push(describe(d));
      return;
    }
    out.push({ box: { ...boxes[i], h: Math.min(natural, avail) }, ...d });
  });
}

/** 形状版时间线的口径脚注：为 0 的项不说，避免「0 条计划缺日期」这种把空缺冒充结论 */
function timelineResultNotes(tl: TimelineResult, window: TimelineWindow): string[] {
  const notes: string[] = [];
  if (tl.undated) notes.push(`${tl.undated} 条计划缺起止日期，条形未绘制（起止日期补全后自动出现在时间线上）`);
  if (tl.overflow) {
    notes.push(
      (window.last ?? true)
        ? `${tl.overflow} 条计划超出本页可排行数，已折成页脚提示`
        : `${tl.overflow} 条计划续排到下页（分页承载，一条不丢）`
    );
  }
  if (tl.mergedMilestones) notes.push(`${tl.mergedMilestones} 个里程碑与同日里程碑并成一枚菱形绘制（日期相同，逐个画会叠成一坨）`);
  return notes;
}

/** 时间线页这一趟：画得动就把形状块并进 `out` 并带回口径/违规；画不动只带回回落原因 */
function timelineShapePass(
  item: KickoffRenderPage,
  b: KickoffBundle,
  body: Box,
  cursor: number,
  out: Block[],
  window: TimelineWindow
): { drawn: true; rows: number; notes: string[]; dropped: string[]; violations: string[] } | { drawn: false; rows: 0; note: string } {
  const frame: Box = { x: body.x, y: cursor, w: body.w, h: body.y + body.h - cursor };
  const reason = timelineDegradeReason(b);
  if (reason || frame.h < TL_MIN_H) {
    const fallback = reason ?? `剩余高度 ${frame.h.toFixed(2)}" 排不下轴与 2 行条`;
    return { drawn: false, rows: 0, note: `时间线回落列表版：${fallback}` };
  }
  const tl = timelineBlocks(b, frame, window);
  out.push(...tl.blocks);
  const dropped: string[] = [];
  for (const k of item.dataKeys.filter((x) => x !== 'timeline')) dropped.push(...blocksForKey(k, b).map(describe));
  return { drawn: true, rows: tl.drawn, notes: timelineResultNotes(tl, window), dropped, violations: tl.violations };
}

// ---------- T02198：flow / chip 图示版式（一页一个组件，内部几何自管） ----------

/**
 * flow 节点上限：横向链路超过 5 格，每格就窄到排不下一个阶段名——
 * 与其画 8 个谁也读不清的小框（块确实 placed 了），不如收前 5 个并如实注明余下数量。
 */
const FLOW_MAX_NODES = 5;
const FLOW_NODE_H = 0.62;
const FLOW_NOTE_H = 0.26;
/** flow 组件整体最小占位高：低于它节点里的阶段名就排不下，宁可回落表格版 */
const FLOW_MIN_H = FLOW_NODE_H + FLOW_NOTE_H;
const FLOW_ARROW_W = 0.24;
const FLOW_ARROW_H = 0.2;
const FLOW_NODE_GAP = 0.1;
const FLOW_NODE_PT = 10;

const CHIP_H = 0.3;
const CHIP_ROW_STEP = CHIP_H + 0.1;
/** chip 组件最小占位高：一行标签都排不下就没有画的意义 */
const CHIP_MIN_H = CHIP_ROW_STEP;
const CHIP_GAP = 0.12;
/** 标签左右内边距：文字贴着形状边缘会读成「被裁了」 */
const CHIP_PAD_X = 0.16;
const CHIP_PT = 10;

export interface DiagramResult {
  blocks: Block[];
  /** 实绘的节点/标签数：0 = 组件画不出来，调用方据此回落表格版 */
  drawn: number;
  overflow: number;
  notes: string[];
  violations: string[];
}

/** flow 页成立前提：不足 3 个里程碑就没有「链」，如实回落 milestones 表格版 */
export function flowDegradeReason(b: KickoffBundle): string | null {
  return b.milestones.length < 3 ? `库内里程碑只有 ${b.milestones.length} 个，排不出阶段链` : null;
}

/** 阶段链取数：按截止日（缺则起始日）升序，标题一律照抄库内真值——节点文字不给 AI 编的机会 */
function milestoneChain(b: KickoffBundle): KickoffBundle['milestones'] {
  const due = (m: KickoffBundle['milestones'][number]) => m.end_date || m.start_date || '';
  return [...b.milestones].sort((x, y) => due(x).localeCompare(due(y)));
}

/** 标签按框宽截断（补「…」并留痕）：压字与静默缩字都是谎报，截断必须看得见 */
function fitLabel(text: string, width: number, pt: number): { text: string; clipped: boolean } {
  const usable = width - CHIP_PAD_X * 2;
  if (estimateTextWidthIn(text, pt) <= usable) return { text, clipped: false };
  let kept = text;
  while (kept.length > 1 && estimateTextWidthIn(`${kept}…`, pt) > usable) kept = kept.slice(0, -1);
  return { text: `${kept}…`, clipped: true };
}

/** 组件内部的越界/重叠点名：箭头是连接装饰（同 `axis` 口径），既不算内容盒也不参与重叠 */
function diagramViolations(blocks: Block[], frame: Box): string[] {
  const issues: string[] = [];
  for (const blk of blocks) {
    if (blk.shape?.tone === 'flow') continue;
    const reason = assertInBounds(blk.box, frame);
    if (reason) issues.push(`${blk.shape ? '形状' : '文本'}${reason}`);
  }
  const overlaps = findOverlaps(blocks.filter((blk) => blk.shape?.tone !== 'flow').map((blk) => blk.box));
  if (overlaps.length) issues.push(`元素重叠 ${overlaps.length} 处`);
  return issues;
}

/**
 * 横向阶段链：n 个带字节点 + n-1 枚箭头，整组自成一个绘制单元。
 * 口径关键：**不进 `fitStack`/`flexStrip`**。按块累加的分型可读高（T02172）会把
 * 「5 节点 + 4 箭头 = 9 块」判成 6.75" ≫ 正文框 3.225" 而整块 drop——那条收口对独立
 * 内容块是对的，对内部自排的组件是误伤，所以这里只在版面层预留一次 `FLOW_MIN_H`。
 */
export function flowBlocks(b: KickoffBundle, frame: Box): DiagramResult {
  const chain = milestoneChain(b);
  const nodes = chain.slice(0, FLOW_MAX_NODES);
  if (nodes.length === 0 || frame.h < FLOW_MIN_H) {
    return { blocks: [], drawn: 0, overflow: chain.length, notes: [], violations: [] };
  }
  const nodeW = (frame.w - (nodes.length - 1) * (FLOW_ARROW_W + FLOW_NODE_GAP * 2)) / nodes.length;
  const step = nodeW + FLOW_ARROW_W + FLOW_NODE_GAP * 2;
  const out: Block[] = [];
  const notes: string[] = [];
  let clipped = 0;
  for (const [i, m] of nodes.entries()) {
    const x = frame.x + i * step;
    const label = fitLabel(m.title, nodeW, FLOW_NODE_PT);
    if (label.clipped) clipped++;
    out.push({
      box: { x, y: frame.y, w: nodeW, h: FLOW_NODE_H },
      shape: { kind: 'roundRect', tone: 'flowNode', label: { text: label.text, pt: FLOW_NODE_PT, color: PALETTE.onBrand } },
    });
    const due = (m.end_date || m.start_date || '').slice(5);
    out.push({
      box: { x, y: frame.y + FLOW_NODE_H + 0.02, w: nodeW, h: FLOW_NOTE_H - 0.02 },
      text: { content: due ? `截止 ${due}` : '未排截止日', pt: 9, align: 'center' },
    });
    if (i < nodes.length - 1) {
      out.push({
        box: { x: x + nodeW + FLOW_NODE_GAP, y: frame.y + (FLOW_NODE_H - FLOW_ARROW_H) / 2, w: FLOW_ARROW_W, h: FLOW_ARROW_H },
        shape: { kind: 'rightArrow', tone: 'flow' },
      });
    }
  }
  const overflow = chain.length - nodes.length;
  if (overflow > 0) notes.push(`阶段链只承载前 ${nodes.length} 个里程碑，其余 ${overflow} 个见时间线页（一条不丢）`);
  if (clipped > 0) notes.push(`${clipped} 个阶段名超出节点宽度，已截断显示（完整名称见里程碑页）`);
  return { blocks: out, drawn: nodes.length, overflow, notes, violations: diagramViolations(out, frame) };
}

/** 人员标签流：宽度按 `estimateTextWidthIn` 实算、超宽换行，排不下的如实计数不硬画 */
export function chipBlocks(b: KickoffBundle, frame: Box): DiagramResult {
  const labels = b.assignees.map((a) => `${a.name}·${a.planCount} 项`);
  const out: Block[] = [];
  const notes: string[] = [];
  let x = frame.x;
  let y = frame.y;
  let drawn = 0;
  let clipped = 0;
  for (const raw of labels) {
    const fitted = fitLabel(raw, frame.w, CHIP_PT);
    if (fitted.clipped) clipped++;
    const w = Math.min(frame.w, estimateTextWidthIn(fitted.text, CHIP_PT) + CHIP_PAD_X * 2);
    if (x > frame.x && x + w > frame.x + frame.w) {
      x = frame.x;
      y += CHIP_ROW_STEP;
    }
    if (y + CHIP_H > frame.y + frame.h) break;
    out.push({
      box: { x, y, w, h: CHIP_H },
      shape: { kind: 'roundRect', tone: 'chip', label: { text: fitted.text, pt: CHIP_PT, color: PALETTE.brandDeep } },
    });
    x += w + CHIP_GAP;
    drawn++;
  }
  const overflow = labels.length - drawn;
  if (overflow > 0) notes.push(`本页版面只排得下 ${drawn} 个人员标签，其余 ${overflow} 人见分工页与工作量页（一条不丢）`);
  if (clipped > 0) notes.push(`${clipped} 个标签过长已截断显示`);
  return { blocks: out, drawn, overflow, notes, violations: diagramViolations(out, frame) };
}

/**
 * 正文块 + 数据块的排布（单栏纵向堆叠走 stackY 单源；双栏按 6:4 左右分）。
 * 排不下的块**省略并如实回报**，不硬塞——硬塞就是越界页，静默丢就是假数据页，
 * 两者都比「少一块内容 + 一条 warning」更糟。
 * `layout === 'timeline'` 走形状版（FR-4.5）；日期或里程碑不满足绘制前提时回落列表版，
 * 前提缺失与降级原因都进 `notes`，让面板如实告诉用户「这页为什么是列表」。
 * `item.tlWindow`（T02171）：本页承载计划的时间线窗口；返回值 `tlDrawn` 是版面实收的行数，
 * 分页探针就按它前移下一页的 `offset`——用同一条排布链路问「这页画得下几条」，
 * 而不是在别处重算一遍几何（公式抄两份必漂移）。
 */
/**
 * T02685：目录/议程页要点格式化——编号 + 空行间距。
 * 裸文本平铺（用户实测第 2 页「会议议程」）看起来像忘了排版；编号列表才是议程的常规形态。
 */
function bulletBodyText(item: KickoffRenderPage, bullets: string[]): string {
  if (item.layout !== 'toc') return bullets.join('\n');
  return bullets.map((s, i) => `${i + 1}. ${s}`).join('\n\n');
}

export function layoutBody(
  item: KickoffRenderPage,
  b: KickoffBundle,
  frames: LayoutFrames,
  bullets: string[]
): { blocks: Block[]; dropped: string[]; notes: string[]; violations: string[]; tlDrawn: number } {
  const body = frames.body;
  const out: Block[] = [];
  const dropped: string[] = [];
  const notes: string[] = [];
  const bottom = body.y + body.h;
  const bodyAvail = bottom - body.y;
  // 时间线页：形状版自成一格（只需留 TL_MIN_H），回落列表版才是一张刚性表格
  const tlPage = item.layout === 'timeline' && item.dataKeys.includes('timeline');
  const tlShape = tlPage && timelineDegradeReason(b) === null;
  // T02198：flow/chip 页由组件自己绘制，其数据块（里程碑链 / 人员标签）不进堆叠预算
  const diagramKey: KickoffDataKey | null =
    item.layout === 'flow' ? 'milestones' : item.layout === 'chip' ? 'assignees' : null;
  const diagramOn =
    diagramKey !== null && (item.layout === 'flow' ? flowDegradeReason(b) === null : b.assignees.length > 0);
  const diagramMinH = item.layout === 'flow' ? FLOW_MIN_H : CHIP_MIN_H;
  // 形状版自己绘制时间线块，不让它进刚性表格预算（否则时间线区被算两次，要点被无端压扁）
  const baseBlocks = item.dataKeys
    .filter((k) => !(tlShape && k === 'timeline') && !(diagramOn && k === diagramKey))
    .flatMap((k) => blocksForKey(k, b));
  // T02313：多键同页时降级占位表格（零信息刚性块会把同页真数据挤出版面 → C-03 丢块）；
  // 独占一页时保留「整页占位」形态（t02101 U-07 / t02198 H-06 钉住的既有设计）。
  const rawBlocks = item.dataKeys.length > 1 ? baseBlocks.filter((d) => !isPlaceholderTable(d)) : baseBlocks;

  if (frames.cols) {
    const [left, right] = frames.cols;
    const dataBlocks = fitRigidTables(rawBlocks, right.w, right.h - flexStrip(rawBlocks));
    if (bullets.length) out.push({ box: left, text: { content: bulletBodyText(item, bullets), pt: MIN_BODY_PT } });
    const boxes = fitStack(right.y, dataBlocks, right.y + right.h, right.w, right);
    pushStackedBlocks(out, dropped, dataBlocks, boxes, right.y + right.h);
    return { blocks: out, dropped, notes, violations: [], tlDrawn: 0 };
  }

  // T02970：要点封顶按**数据块下限合计**算，不再只给要点留 MIN_BLOCK_H(0.45")。
  // 旧口径下要点自然高 0.90" 比预留多出的高度会从同页柔性文本块的 0.45" 地板里抠，
  // 表格+文本+要点同页时 dropped=["文本块"]——与「留数据不留套话」正好相反。
  const flexFloorH = rawBlocks.filter((d) => d.table == null).reduce((s, d) => s + minReadableH(d), 0);
  // 刚性表格的下限按「收到 1 行」的最小形态算，避免要点把表格预算吃成 0 后整块 drop。
  const rigidFloorH = rawBlocks.reduce((s, d) => s + (d.table ? tableMinHeight(d.table, body.w) : 0), 0);
  const dataGaps = MIN_GAP * Math.max(0, rawBlocks.length - 1);
  const extraRigid = (tlShape ? TL_MIN_H + MIN_GAP : 0) + (diagramOn ? diagramMinH + MIN_GAP : 0);
  // 要点与首块之间也有一个间隔；要不了位时不计入，否则会被这 0.3" 无端判成「排不下」。
  const bulletsGap = bullets.length ? MIN_GAP : 0;
  const bulletsContent = bullets.length ? bulletBodyText(item, bullets) : '';
  const bulletsNaturalH = bulletsContent ? textHeight(bulletsContent, body.w, MIN_BODY_PT) : 0;
  // 要点同样是柔性块：挤不进一个最小块就整块让位（留数据不留套话）；
  // 挤得进则按实排高度预留，表格再按剩下的预算收行。
  const bulletsH = bullets.length
    ? Math.min(bulletsNaturalH, Math.max(0, bodyAvail - flexFloorH - rigidFloorH - dataGaps - extraRigid - bulletsGap))
    : 0;
  const bulletsReserve = bulletsH >= MIN_BLOCK_H ? bulletsH + bulletsGap : 0;
  const dataBlocks = fitRigidTables(
    rawBlocks,
    body.w,
    bodyAvail - flexFloorH - dataGaps - extraRigid - bulletsReserve
  );

  let cursor = body.y;
  if (bullets.length) {
    if (bulletsH >= MIN_BLOCK_H) {
      out.push({ box: { x: body.x, y: cursor, w: body.w, h: bulletsH }, text: { content: bulletsContent, pt: MIN_BODY_PT } });
      if (bulletsH < bulletsNaturalH - 1e-6) {
        notes.push(`要点为表格让位压缩排版（自然高 ${bulletsNaturalH.toFixed(2)}" → 实排 ${bulletsH.toFixed(2)}"，多余部分按 pptxgenjs 截字）`);
      }
      cursor += bulletsH + MIN_GAP;
    } else {
      notes.push(`要点为本页表格让位，未排入版面（剩余 ${Math.max(0, bulletsH).toFixed(2)}"，可拆分该页）`);
    }
  }

  let tlDrawn = 0;
  if (item.layout === 'timeline' && item.dataKeys.includes('timeline')) {
    const pass = timelineShapePass(item, b, body, cursor, out, item.tlWindow ?? {});
    if (pass.drawn) {
      notes.push(...pass.notes);
      dropped.push(...pass.dropped);
      return { blocks: out, dropped, notes, violations: pass.violations, tlDrawn: pass.rows };
    }
    notes.push(pass.note);
  }

  // T02198：flow/chip 组件页——整组自绘后直接收口，不进堆叠预算（同时间线形状版的旁路口径）
  if (diagramOn && diagramKey) {
    const frame: Box = { x: body.x, y: cursor, w: body.w, h: bottom - cursor };
    const pass = item.layout === 'flow' ? flowBlocks(b, frame) : chipBlocks(b, frame);
    if (pass.drawn > 0) {
      out.push(...pass.blocks);
      notes.push(...pass.notes);
      return { blocks: out, dropped, notes, violations: pass.violations, tlDrawn: 0 };
    }
    notes.push(
      item.layout === 'flow'
        ? `阶段链回落表格版：剩余高度 ${frame.h.toFixed(2)}" 排不下节点与截止日注`
        : `人员标签回落表格版：库内无可排的负责人标签`
    );
  }

  // 走到这里 = 时间线只能用列表版：把形状版排除掉的表格块补回来，并按剩余高度再收一次行
  const reAddKey: KickoffDataKey | null = tlShape ? 'timeline' : diagramOn ? diagramKey : null;
  const stackBlocks = reAddKey
    ? fitRigidTables([...dataBlocks, ...blocksForKey(reAddKey, b)], body.w, bottom - cursor)
    : dataBlocks;
  const boxes = fitStack(cursor, stackBlocks, bottom, body.w, body);
  pushStackedBlocks(out, dropped, stackBlocks, boxes, bottom);
  return { blocks: out, dropped, notes, violations: [], tlDrawn };
}

/**
 * 时间线/计划页超行数 → 分页承载（T02171）。
 * 原口径是「少画但不谎称画全」：23 条计划只画前几条，其余折成一句页脚。
 * 数据没丢，可稿子里看不到完整排期。这里改成换页继续画：逐页拿 `layoutBody` 问
 * 「这一页的版面实收几条」，按真实绘制量前移窗口，最多 `MAX_TL_PAGES` 页；
 * 只有真被页数上限挡住时，末页才保留「其余 n 条」页脚。
 * 续页只带时间线本身（要点与其他数据块留在首页）——同一张表在每页重画一遍不是承载，是凑数。
 * 只处理形状版时间线：列表版与其他表格页的「其余 n 条」是信息密度上限（`clampRows`），另一层口径。
 */
export function expandTimelinePages(b: KickoffBundle, outline: KickoffOutlineItem[]): KickoffRenderPage[] {
  const pages: KickoffRenderPage[] = [];
  for (const item of outline) {
    if (!(item.layout === 'timeline' && item.dataKeys.includes('timeline') && timelineDegradeReason(b) === null)) {
      pages.push(item);
      continue;
    }
    // 探针入参与真实装配同源：同一套 frames + 清洗后的要点，问出来的行数才是本页真值
    const scratch: string[] = [];
    const bullets = sanitizeBullets(item.bullets, b, 0, scratch);
    const frames = framesFor(layoutFamilyOf(item.layout), item.layout);
    const mkPage = (window: TimelineWindow, i: number): KickoffRenderPage =>
      i === 0 ? { ...item, tlWindow: window } : { ...item, title: `${item.title}（续）`, bullets: [], dataKeys: ['timeline'], tlWindow: window };

    const total = b.plans.length;
    const windows: TimelineWindow[] = [];
    let offset = 0;
    for (;;) {
      const first = windows.length === 0;
      const window: TimelineWindow = { offset };
      const probe = layoutBody(mkPage(window, windows.length), b, frames, first ? bullets : []);
      // 画不动（版面留不下轴+2 行）：不再分页，交回原有列表版降级口径，别造出空壳续页
      if (probe.tlDrawn <= 0) {
        windows.push({ ...window, last: true });
        break;
      }
      window.last = offset + probe.tlDrawn >= total || windows.length === MAX_TL_PAGES - 1;
      windows.push(window);
      offset += probe.tlDrawn;
      if (window.last || offset >= total) break;
    }
    windows.forEach((w, i) => pages.push(mkPage(w, i)));
  }
  return pages;
}

/** 省略点名（给 warning 用的块类型 + 规模） */
function describe(src: Omit<Block, 'box'>): string {
  if (src.chart) return `图表「${src.chart.name}」`;
  if (src.table) return `表格（${src.table.rows.length + 1} 行）`;
  if (src.shape) return `形状「${src.shape.kind}」`;
  return '文本块';
}

/** 违规点名里的块类型前缀 */
function blockKindLabel(blk: Block): string {
  if (blk.table) return '表格';
  if (blk.chart) return '图表';
  if (blk.shape) return '形状';
  return '文本';
}

/** 逐块越界点名（轴线既非内容盒也不占高度，不算它） */
function blockBoundsIssues(blocks: Block[]): string[] {
  const issues: string[] = [];
  for (const blk of blocks) {
    // 参照线（日期轴）与 flow 箭头都是装饰件不是内容盒：前者零高度会被判「高度非正」，
    // 后者按设计就贴在节点之间，硬算就是每页都「假越界」
    if (blk.shape?.tone === 'axis' || blk.shape?.tone === 'flow') continue;
    const reason = assertInBounds(blk.box);
    if (reason) issues.push(`${blockKindLabel(blk)}${reason}`);
  }
  return issues;
}

/** 参与重叠判定的块框：参照线（日期轴）与 flow 箭头排除在外——里程碑菱形按设计骑在轴上、
 *  箭头按设计挨着节点，硬算就是每页都「假重叠」 */
function contentBoxes(blocks: Block[]): Box[] {
  return blocks
    .filter((blk) => blk.shape?.tone !== 'axis' && blk.shape?.tone !== 'flow')
    .map((blk) => blk.box);
}

/** 整页断言：标题与各块在内容框内、彼此不重叠（门禁 2 + 5 在此消费） */
export function pageViolations(title: Box, titleText: string, blocks: Block[], titlePt = 22): string[] {
  const issues: string[] = [];
  const titleReason = assertInBounds(title);
  if (titleReason) issues.push(`标题${titleReason}`);
  // 长标题排不进标题带是验收 7 点名的越界形态，必须在写盘前判出来
  const needH = textHeight(titleText, title.w, titlePt);
  if (needH > title.h + 1e-6) issues.push(`标题需 ${needH.toFixed(2)}" 高于标题带 ${title.h.toFixed(2)}"`);
  issues.push(...blockBoundsIssues(blocks));
  const overlaps = findOverlaps([title, ...contentBoxes(blocks)]);
  if (overlaps.length) issues.push(`元素重叠 ${overlaps.length} 处`);
  return issues;
}

/**
 * 降级页（验收 7）：换版式 = 缩放（门禁 4），把原正文块整体映射进安全版式的正文框；
 * 映射后仍越界就退回安全框本身——两条路都收敛到「标题+正文」，不再出现半越界页。
 * T02199：两条路都开 `fit:'shrink'`。安全版式是「已知会装不下原文」的页，预测量在这里
 * 反而最不可靠（框换了、字数没换），所以交给渲染期收缩；正文页不走这里。
 */
function degradeToSafe(item: KickoffOutlineItem, blocks: Block[], fromBody: Box): Block[] {
  const safe = safeFrames();
  const text = blocks.find((b) => b.text && b.box.w > 1);
  if (!text?.text) return [{ box: safe.body, text: { content: item.bullets.join('\n'), pt: MIN_BODY_PT, shrink: true } }];
  const mapped = scaleBox(text.box, fromBody, safe.body);
  const reason = assertInBounds(mapped);
  return [{ box: reason ? safe.body : mapped, text: { ...text.text, shrink: true } }];
}

// ---------- 原生对象写入（只用稳定特性，兼容 PowerPoint 2016+ / WPS） ----------

/** 形状配色：按 tone 取调色板色值（hex 单源来自 kickoff-layout 的 PALETTE） */
function shapeToneColor(tone: NonNullable<Block['shape']>['tone']): string {
  // T02156：恒生品牌色系——计划条用品牌亮蓝，里程碑菱形与日期轴用品牌深蓝，
  // 与模板背景的蓝色装饰同族；不再用报告系的靛蓝/警示红（那套色与品牌模板打架）
  if (tone === 'milestone') return PALETTE.brandDeep;
  if (tone === 'bar') return PALETTE.brandBright;
  // T02198：flow 节点深底（承载阶段名，要压得住），箭头亮蓝（连接装饰，不抢节点），
  // chip 浅底（人员标签，靠品牌深蓝字读出来）
  if (tone === 'flowNode') return PALETTE.brandDeep;
  if (tone === 'flow') return PALETTE.brandBright;
  if (tone === 'chip') return PALETTE.brandPale;
  return PALETTE.brandDeep;
}

export function drawBlock(slide: any, block: Block): void {
  const geo = { x: +block.box.x.toFixed(3), y: +block.box.y.toFixed(3), w: +block.box.w.toFixed(3), h: +block.box.h.toFixed(3) };
  if (block.shape) {
    const color = shapeToneColor(block.shape.tone);
    if (block.shape.kind === 'line') {
      slide.addShape('line', { ...geo, line: { color, width: 1.5 } });
      return;
    }
    const label = block.shape.label;
    if (label) {
      // T02198：带字形状 = `addText` 的 `shape` 选项（形状与文字同一个原生对象）。
      // 不用「addShape + 叠 addText」两块：两块同框就是 `findOverlaps` 眼里的重叠。
      slide.addText(label.text, {
        ...geo,
        shape: block.shape.kind,
        fill: { color },
        line: { type: 'none' },
        color: label.color ?? PALETTE.onBrand,
        fontSize: label.pt,
        align: 'center',
        valign: 'middle',
        fontFace: FONT.face,
      });
      return;
    }
    slide.addShape(block.shape.kind, { ...geo, fill: { color }, line: { type: 'none' } });
    return;
  }
  if (block.table) {
    // T02685：列宽/行高显式下发 + 单元格截字——测高（tableNaturalHeight）与绘制共用同一套
    // 换行模型，实测行高 ≤ 估算行高，表格不再越出盒底与文字/页脚叠加。
    const colWs = tableColWs(block.table, geo.w);
    const fit = (cells: string[]) => cells.map((t, c) => fitCellText(t, colWs[c], TABLE_FONT_PT));
    const rows = [
      // T02156：表头改品牌深底白字（恒生模板表格头样式），与浅蓝页面背景成「卡片」层次
      block.table.header.map((t, c) => ({ text: fitCellText(t, colWs[c], TABLE_FONT_PT), options: { bold: true, color: PALETTE.onBrand, fill: { color: PALETTE.brandDeep } } })),
      ...block.table.rows.map((r, i) => fit(r).map((t, c) => ({ text: t, options: { color: PALETTE.ink, fill: { color: i % 2 === 1 ? PALETTE.zebraFill : PALETTE.paper } } }))),
    ];
    const rowHs = [block.table.header, ...block.table.rows].map((cells) => estimateRowH(cells, colWs, TABLE_FONT_PT));
    slide.addTable(rows, { ...geo, fontSize: TABLE_FONT_PT, fontFace: FONT.face, border: { type: 'solid', pt: 0.5, color: PALETTE.border }, valign: 'middle', colW: colWs, rowH: rowHs });
    return;
  }
  if (block.chart) {
    slide.addChart(block.chart.type, [{ name: block.chart.name, labels: block.chart.labels, values: block.chart.values }], {
      ...geo,
      chartColors: [PALETTE.brandBright, PALETTE.brandDeep, PALETTE.headFill],
      showLegend: true,
      legendPos: 'r',
      showTitle: false,
      barDir: 'col',
      dataLabelFontSize: 9,
      showValue: block.chart.type === 'bar',
      // T02156：图表文字此前后台默认 Arial + 纯黑，与正文微软雅黑/墨色「串行」——
      // 轴/数据/图例的字体与颜色全部显式声明，图表才和页面同一个设计系统
      catAxisLabelFontFace: FONT.face,
      valAxisLabelFontFace: FONT.face,
      dataLabelFontFace: FONT.face,
      legendFontFace: FONT.face,
      catAxisLabelColor: PALETTE.ink,
      valAxisLabelColor: PALETTE.ink,
      dataLabelColor: PALETTE.ink,
      legendColor: PALETTE.ink,
      // 白底绘图区：浅蓝页面背景上成「图表卡片」，网格线与轴线用边框灰不抢品牌色
      plotArea: { fill: { color: PALETTE.paper } },
      catAxisLineColor: PALETTE.border,
      valAxisLineColor: PALETTE.border,
    });
    return;
  }
  const t = block.text!;
  slide.addText(t.content, {
    ...geo,
    fontSize: t.pt,
    bold: t.bold ?? false,
    color: t.color ?? PALETTE.ink,
    align: t.align ?? 'left',
    valign: 'top',
    fontFace: FONT.face,
    // T02199：渲染期收缩兜底只在降级页开启——正文页维持「预测量 + 截字留痕」，
    // 否则长文会静默缩成小字，读者看不到也问不出「这页被缩过」。
    ...(t.shrink ? { fit: 'shrink' as const } : {}),
  });
}

// ---------- 主入口 ----------

/**
 * 逐页脚注（FR-4.11）+ 工作量页动态口径（验收 6）+ warn 级留痕（FR-2.2）。
 * 口径与留痕都必须落在页面上：客户会上追问依据时，脚注是第一道答案，不能只在面板里提示。
 */
export function footerOf(item: KickoffOutlineItem, b: KickoffBundle, pageNo: number, total: number): string {
  const parts = [b.project.name, item.section || '正文', `数据截至 ${b.dataAsOf}`];
  if (item.dataKeys.includes('workload')) {
    parts.push(b.workload.footer);
    if (b.workload.reviewTrace) parts.push(b.workload.reviewTrace);
  }
  return `${parts.join(' · ')} · 第 ${pageNo}/${total} 页`;
}

/** 装配过程的可选接缝（T02103 SSE 链路用；不传即与 T02099 一次性装配行为一致） */
export interface KickoffBuildOptions {
  /** 逐页回调：SSE `stage` 的单源（FR-1.4），页码 1 起 */
  onPage?: (pageNo: number, item: KickoffOutlineItem) => void;
  /** 客户端断开/用户取消：每页开头检查，命中即抛错收手，绝不落半成品（验收 9） */
  signal?: AbortSignal;
}

/**
 * 让出一次事件循环。逐页画如果全挤在同一个同步轮里，stage 事件会憋到最后一次性下发，
 * 客户端点「停止」也要等整份稿画完才生效——断连检查就成了摆设。
 */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 本模块对 pptxgenjs 实例的唯一消费点就是 `addSlide`（R1：适配层独占，不引第三方类型） */
interface KickoffSlideHost {
  /** T02156：`masterName` 选自定义背景版式（defineLayout 登记的恒生三背景） */
  addSlide(opts?: { masterName?: string }): any;
}

/**
 * 单页装配的公共入参（同源于 `buildKickoffPpt` 的逐页循环）。
 * 字段名沿用循环里的现有变量名，入参对象只是将同源参数收拢，取值顺序与逐页副作用不变。
 */
interface PageAppendInput {
  pptx: KickoffSlideHost;
  bundle: KickoffBundle;
  item: KickoffRenderPage;
  pageNo: number;
  total: number;
  sectionNo: number;
  warnings: string[];
  degradedPages: number[];
}

/** 整页断言 → 落版/降级的入参（与 `PageAppendInput` 同源，另带本页排版产物） */
interface ResolvePageBoxesInput {
  item: KickoffOutlineItem;
  bullets: string[];
  blocks: Block[];
  frames: LayoutFrames;
  issues: string[];
  pageNo: number;
  warnings: string[];
  degradedPages: number[];
}

/**
 * 断言通过 → 原样落版并做文本体检；不通过 → 整体换进安全版式并留痕（验收 7）。
 * 末尾再过一道**空正文页收口**（T02199 D）：每页强制写标题带与脚注（`appendOutlinePage`），
 * 所以 v1 的「无块且无标题」永不成立——真实形态是「正文无可绘内容」：AI 交出空 bullets +
 * 空 dataKeys 的内容页，或降级路径回塞出一个 content 为空的文本块（块在、页上没字）。
 * 这类页比越界页更难在抽查里被发现，所以生成时拦截并登记降级，而不是留给真链路门间接兜。
 * 封面/目录族按设计就是留白页，不参与该收口（否则给封面无字页塞一行标题重复，是凑数）。
 */
function resolvePageBoxes({
  item,
  bullets,
  blocks,
  frames,
  issues,
  pageNo,
  warnings,
  degradedPages,
}: ResolvePageBoxesInput): { titleBox: Box; bodyBlocks: Block[] } {
  let titleBox = frames.title;
  let bodyBlocks = blocks;
  if (issues.length) {
    degradedPages.push(pageNo);
    warnings.push(`第 ${pageNo} 页版式越界（${issues[0]}），已降级为「标题 + 正文」安全版式`);
    // 口径同步：降级页走 fit:shrink，正文页那句「多余部分按 pptxgenjs 截字」对它不成立——
    // 字是被缩小的，不是被截掉的，留痕要说清是哪一种。
    warnings.push(`第 ${pageNo} 页正文改用 fit:shrink 渲染期收缩兜底（不截字，整段仍在本页内）`);
    const safe = safeFrames();
    titleBox = safe.title;
    bodyBlocks = degradeToSafe(item, blocks, frames.body);
  } else {
    const textIssues = checkPageText({ title: item.title, bullets }, frames.body.w);
    if (textIssues.length) warnings.push(`第 ${pageNo} 页文本提示：${textIssues.join('；')}`);
  }
  // 空正文收口只管「本该有正文的页」：封面/目录（cover 族）按设计就是标题 + 背景留白，
  // 章节页/结束页另走 appendBrandPage——把它们也「回塞」就是画蛇添足。
  // 判据取「有没有可绘内容」而不是「块数为 0」：降级路径可能回塞出一个 content 为空的
  // 文本块（块在、页上没字），只数块数就漏掉了真正该拦的形态。
  const drawable = (blk: Block) =>
    (blk.text != null && blk.text.content.trim().length > 0) || blk.table != null || blk.chart != null || blk.shape != null;
  const whitespaceByDesign = layoutFamilyOf(item.layout) === 'cover';
  if (!bodyBlocks.some(drawable) && !whitespaceByDesign) {
    const safe = safeFrames();
    if (!degradedPages.includes(pageNo)) degradedPages.push(pageNo);
    warnings.push(bullets.length
      ? `第 ${pageNo} 页正文无可绘内容（数据块均因版面不足被省略），已按安全版式回塞要点（正文按渲染期收缩承载，不截字）`
      : `第 ${pageNo} 页正文与要点皆空（本页无可承载内容），已降级为「标题 + 章节式留白」（正文按渲染期收缩承载，不截字）`);
    titleBox = safe.title;
    bodyBlocks = [{
      box: safe.body,
      text: bullets.length
        ? { content: bullets.join('\n'), pt: MIN_BODY_PT, shrink: true }
        : { content: item.title, pt: MIN_BODY_PT, align: 'center', color: PALETTE.brandDeep, shrink: true },
    }];
  }
  return { titleBox, bodyBlocks };
}

/** 逐块写盘：第三方库（R1）个别元素写崩不该拖垮整份稿，跳该元素并如实点名 */
function writePageBlocks(slide: any, blocks: Block[], pageNo: number, warnings: string[]): void {
  for (const block of blocks) {
    try {
      drawBlock(slide, block);
    } catch (e) {
      warnings.push(`第 ${pageNo} 页有元素写入失败（${e instanceof Error ? e.message : String(e)}），已跳过`);
    }
  }
}

/** 单页装配：取数排版 → 整页断言 →（必要时）降级 → 标题/正文/脚注落成原生对象 */
/**
 * 章节页/结束页装配（T02156 恒生五页面角色）。
 * 章节页：32pt 编号（01/02…按出现序）+ 28pt 章节标题，双双居中——编号悬在模板背景上部，
 * 标题压在中部浅蓝色带上（模板 slide3/layout5 的同款几何）；不排 dataKeys（校验层已清空）。
 * 结束页：致谢标题 + 一行「项目名 · 数据截至」，背景自带 THANKS 主视觉，页面只做口径标注。
 * 两页都走同一套越界断言：标题排不下就降级「标题+正文」安全版式并留痕，不出坏页。
 */
function appendBrandPage({
  pptx,
  bundle,
  item,
  pageNo,
  total,
  sectionNo,
  warnings,
  degradedPages,
}: PageAppendInput): void {
  const isSection = item.layout === 'section';
  const frames = framesFor(isSection ? 'section' : 'thanks', item.layout);
  const titlePt = isSection ? 28 : 32;
  const num = String(sectionNo).padStart(2, '0');
  const blocks: Block[] = isSection
    ? [{ box: frames.number!, text: { content: num, pt: 32, bold: true, align: 'center', color: PALETTE.brandDeep } }]
    : [{ box: frames.body, text: { content: `${bundle.project.name} · 数据截至 ${bundle.dataAsOf}`, pt: MIN_BODY_PT, align: 'center' } }];
  const issues = pageViolations(frames.title, item.title, blocks, titlePt);
  let titleBox = frames.title;
  let bodyBlocks = blocks;
  if (issues.length) {
    // 与内容页同一降级口径：换安全版式 + 留痕。章节号并进正文，不让编号在降级页里独活
    degradedPages.push(pageNo);
    warnings.push(`第 ${pageNo} 页版式越界（${issues[0]}），已降级为「标题 + 正文」安全版式`);
    const safe = safeFrames();
    titleBox = safe.title;
    bodyBlocks = [{ box: safe.body, text: { content: isSection ? `${num} ${item.title}` : item.title, pt: MIN_BODY_PT, align: 'center', shrink: true } }];
  }

  const slide = pptx.addSlide({ masterName: BG_LAYOUT_NAMES[bgKindOf(item.layout)] });
  writePageBlocks(slide, [
    { box: titleBox, text: { content: item.title, pt: titlePt, bold: true, align: 'center', color: PALETTE.brandDeep } },
    ...bodyBlocks,
  ], pageNo, warnings);
  slide.addText(footerOf(item, bundle, pageNo, total), {
    x: 0.5,
    y: KICKOFF_LAYOUT_DEF.height - FOOTER_H - 0.08,
    w: 9,
    h: FOOTER_H,
    fontSize: 9,
    color: PALETTE.brandDeep,
    align: 'right',
    wrap: false,
    fontFace: FONT.face,
  });
}

function appendOutlinePage(input: PageAppendInput): void {
  const { pptx, bundle, item, pageNo, total, warnings, degradedPages } = input;
  if (item.layout === 'section' || item.layout === 'thanks') {
    appendBrandPage(input);
    return;
  }
  const bullets = sanitizeBullets(item.bullets, bundle, pageNo, warnings);
  const frames = framesFor(layoutFamilyOf(item.layout), item.layout, item.layout === 'twoCol' ? TEXT_SPLIT : undefined);
  const titlePt = item.layout === 'cover' ? 32 : 22;
  const { blocks, dropped, notes, violations } = layoutBody(item, bundle, frames, bullets);
  if (dropped.length) warnings.push(`第 ${pageNo} 页空间不足，已省略 ${dropped.join('、')}（内容未丢，页面上少排一块，可拆分该页）`);
  for (const n of notes) warnings.push(`第 ${pageNo} 页：${n}`);
  const issues = [...pageViolations(frames.title, item.title, blocks, titlePt), ...violations];
  const { titleBox, bodyBlocks } = resolvePageBoxes({ item, bullets, blocks, frames, issues, pageNo, warnings, degradedPages });

  const slide = pptx.addSlide({ masterName: BG_LAYOUT_NAMES[bgKindOf(item.layout)] });
  const centered = item.layout === 'cover' || item.layout === 'toc';
  const titleBlock: Block = {
    box: titleBox,
    // T02156：标题用品牌深蓝（恒生模板各级标题实色），不再用墨黑——与背景/表头同一色系
    text: { content: item.title, pt: titlePt, bold: true, align: centered ? 'center' : 'left', color: PALETTE.brandDeep },
  };
  writePageBlocks(slide, [titleBlock, ...bodyBlocks], pageNo, warnings);
  slide.addText(footerOf(item, bundle, pageNo, total), {
    x: 0.5,
    y: KICKOFF_LAYOUT_DEF.height - FOOTER_H - 0.08,
    w: 9,
    h: FOOTER_H,
    fontSize: 9,
    color: PALETTE.brandDeep,
    align: 'right',
    // 脚注只有一行预算：换行会顶出画布下缘，宁可让长口径向左溢出（右对齐，仍在画布内）
    wrap: false,
    fontFace: FONT.face,
  });
}

export async function buildKickoffPpt(
  bundle: KickoffBundle,
  outline: KickoffOutlineItem[],
  opts: KickoffBuildOptions = {},
): Promise<KickoffBuildResult> {
  const warnings: string[] = [];
  const paletteIssues = auditPalette();
  if (paletteIssues.length) warnings.push(`配色对比度不达标：${paletteIssues.join('；')}`);

  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout(KICKOFF_LAYOUT_DEF); // 尺寸单源来自 T02098
  pptx.layout = KICKOFF_LAYOUT_DEF.name;
  defineBrandBackgrounds(pptx); // T02156：恒生五背景登记为自定义版式（缺图不登记，回落默认版式）
  pptx.title = `${bundle.project.name} 项目启动会`;
  pptx.author = 'MTask';
  pptx.company = bundle.project.name;

  const degradedPages: number[] = [];
  // T02171：先把「一页承载不下」的时间线展开成续页，页码/页脚/进度都按展开后的渲染页计
  const renderPages = expandTimelinePages(bundle, outline);
  let sectionNo = 0; // T02156：章节页编号按出现序递增（01/02…），与页码解耦
  for (let idx = 0; idx < renderPages.length; idx++) {
    if (opts.signal?.aborted) throw new Error(KICKOFF_ABORT_MSG);
    const item = renderPages[idx];
    const pageNo = idx + 1;
    if (item.layout === 'section') sectionNo += 1;
    appendOutlinePage({ pptx, bundle, item, pageNo, total: renderPages.length, sectionNo, warnings, degradedPages });
    opts.onPage?.(pageNo, item);
    await yieldToLoop();
  }

  if (opts.signal?.aborted) throw new Error(KICKOFF_ABORT_MSG);
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return { buffer: Buffer.from(out as unknown as ArrayBuffer), warnings, pageCount: renderPages.length, degradedPages };
}
