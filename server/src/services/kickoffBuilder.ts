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
  text?: { content: string; pt: number; bold?: boolean; color?: string; align?: 'left' | 'center' };
  table?: { header: string[]; rows: string[][] };
  chart?: { type: 'bar' | 'doughnut'; name: string; labels: string[]; values: number[] };
  /** 原生形状（FR-4.5 时间线）：`addShape` 落 `<a:prstGeom>`，PowerPoint 里可拖拽改 */
  shape?: { kind: 'rect' | 'diamond' | 'line'; tone: 'bar' | 'milestone' | 'axis' };
}

export interface KickoffBuildResult {
  buffer: Buffer;
  warnings: string[];
  pageCount: number;
  /** 被降级为「标题+正文」的页码（1 起）；面板逐条列出，让用户知道去哪儿复核 */
  degradedPages: number[];
}

const TABLE_ROW_H = 0.3;
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
  return { header: ['编号', '需求', '优先级', '状态', '关联计划'], rows: clampRows(all, (n) => [`其余 ${n} 条`, '见需求跟踪矩阵'], 5) };
}

function planRowsTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.plans.map((p) => [p.title.slice(0, 20), `${cell(p.start_date)}~${cell(p.end_date)}`, cell(p.assignee), statusMark(p.status), `${p.progress}%`]);
  return { header: ['任务', '起止', '负责人', '状态', '进度'], rows: clampRows(all, (n) => [`其余 ${n} 条`, '见项目计划页'], 5) };
}

function milestonesTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.milestones.map((m) => [m.title.slice(0, 22), cell(m.start_date), cell(m.end_date), statusMark(m.status), `${m.progress}%`]);
  return { header: ['里程碑', '起', '止', '状态', '进度'], rows: clampRows(all, (n) => [`其余 ${n} 个`, '见项目计划页'], 5) };
}

function coverageLines(b: KickoffBundle): string[] {
  // P5 warn 承诺过的改写：零用例时不出「0 条 / 覆盖率 0%」这种把空缺冒充结论的数字
  if (b.coverage.total === 0) {
    return [
      `测试用例：本期未建（${KICKOFF_PLACEHOLDER}）——测试策略按 PRD 验收标准描述，覆盖统计待用例生成后补`,
      `需求 ${b.requirements.length} 条，尚无用例可比对覆盖`,
    ];
  }
  return [
    `测试用例 ${b.coverage.total} 条：覆盖 ${b.coverage.covered} / 未覆盖 ${b.coverage.uncovered}`,
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

function risksTable(b: KickoffBundle): NonNullable<Block['table']> {
  const all = b.risks.map((r) => [r.item.slice(0, 22), r.impact.slice(0, 24), r.mitigation.slice(0, 24), r.source.slice(0, 12)]);
  return { header: ['风险', '影响', '应对', '依据'], rows: clampRows(all, (n) => [`其余 ${n} 项`, '见风险登记'], 4) };
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
  const head = b.prdExcerpt
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
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
        ...(b.coverage.total > 0 ? [{ chart: { type: 'doughnut' as const, name: '用例覆盖', labels: ['已覆盖', '未覆盖'], values: [b.coverage.covered, b.coverage.uncovered] } }] : []),
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

export interface TimelineResult {
  blocks: Block[];
  /** 缺起止日期、按口径不画的条数（不画猜出来的工期） */
  undated: number;
  /** 排进行尾「其余 n 条」提示而未画的条数 */
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
 */
export function timelineBlocks(b: KickoffBundle, frame: Box): TimelineResult {
  const out: Block[] = [];
  const range = dateRangeOf(b.plans);
  if (!range) return { blocks: out, undated: b.plans.length, overflow: 0, mergedMilestones: 0, violations: ['无可用日期范围'] };

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
  let limit = Math.min(MAX_TL_ROWS, ordered.length, capacity);
  if (ordered.length > limit) limit = Math.min(limit, Math.floor((bottom - 0.32 - rowsTop) / TL_ROW_H));

  const drawn = planBarBlocks(ordered.slice(0, Math.max(0, limit)), range, bars, frame.x, rowsTop);
  out.push(...drawn.blocks);
  const undated = drawn.undated;

  const overflow = ordered.length - Math.max(0, limit);
  if (overflow > 0) {
    out.push({ box: { x: frame.x, y: bottom - 0.28, w: frame.w, h: 0.26 }, text: { content: `其余 ${overflow} 条计划未绘出，见「项目计划」列表页`, pt: TL_NOTE_PT } });
  }

  const violations = timelineViolations(out, frame);
  const mergedNote = mergedMilestones ? `（同日并成 ${clusters.length} 组）` : '';
  out.push({
    box: { x: frame.x, y: axisY - 0.13, w: TL_LABEL_W, h: 0.28 },
    text: { content: `◆ 里程碑 ${times.length} 个${mergedNote}`, pt: TL_NOTE_PT },
  });
  return { blocks: out, undated, overflow, mergedMilestones, violations };
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
    truth: (b) => String(b.coverage.total),
    missing: { when: (b) => b.coverage.total === 0, format: () => `用例${KICKOFF_PLACEHOLDER}` },
  },
  {
    re: /覆盖率\s*(\d+(?:\.\d+)?)\s*%/,
    format: (v) => `覆盖率 ${v}%`,
    truth: (b) => String(b.coverage.rate),
    missing: { when: (b) => b.coverage.total === 0, format: () => `覆盖率${KICKOFF_PLACEHOLDER}` },
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

function blockHeight(src: Omit<Block, 'box'>, width: number): number {
  if (src.chart) return CHART_H;
  if (src.table) return TABLE_ROW_H * (src.table.rows.length + 1) + TABLE_PAD;
  return textHeight(src.text?.content ?? '', width, src.text?.pt ?? MIN_BODY_PT);
}

/** 块最小可排高度：低于它画出来就是压扁的字或看不见的图，不如省略 */
const MIN_BLOCK_H = 0.45;

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
  const visible = dataRows.slice(0, Math.max(1, Math.min(dataRows.length, maxRows - 1)));
  const hidden = (restMatch ? Number(restMatch[1]) : 0) + dataRows.length - visible.length;
  if (hidden <= 0) return { ...table, rows: visible };
  const restRow = restIdx >= 0 ? [...table.rows[restIdx]] : table.header.map(() => '');
  restRow[0] = `其余 ${hidden} ${restMatch?.[2] ?? '条'}`;
  while (restRow.length < table.header.length) restRow.push('');
  return { ...table, rows: [...visible, restRow] };
}

/** 行数上限：给定可用高度能排下几行数据（含表头与留白） */
function maxRowsFor(height: number): number {
  return Math.max(1, Math.floor((height - TABLE_PAD) / TABLE_ROW_H) - 1);
}

/**
 * 把刚性表格收到版面预算内（同页多表均分预算）。
 * `budget` 已经扣掉要点/其他块要占的高度；排得下就原样返回，不无端收行。
 */
function fitRigidTables(blocks: Array<Omit<Block, 'box'>>, width: number, budget: number): Array<Omit<Block, 'box'>> {
  const rigid = blocks.filter((d) => d.table != null);
  if (!rigid.length) return blocks;
  const natural = rigid.reduce((s, d) => s + blockHeight(d, width) + MIN_GAP, 0);
  if (natural <= budget + 1e-6) return blocks;
  const per = Math.max(0, (budget - MIN_GAP * (rigid.length - 1)) / rigid.length);
  const maxRows = maxRowsFor(per);
  return blocks.map((d) => (d.table ? { ...d, table: fitTableRows(d.table, maxRows) } : d));
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
    if (avail < MIN_BLOCK_H) {
      dropped.push(describe(d));
      return;
    }
    out.push({ box: { ...boxes[i], h: Math.min(natural, avail) }, ...d });
  });
}

/** 形状版时间线的口径脚注：为 0 的项不说，避免「0 条计划缺日期」这种把空缺冒充结论 */
function timelineResultNotes(tl: TimelineResult): string[] {
  const notes: string[] = [];
  if (tl.undated) notes.push(`${tl.undated} 条计划缺起止日期，条形未绘制（起止日期补全后自动出现在时间线上）`);
  if (tl.overflow) notes.push(`${tl.overflow} 条计划超出本页可排行数，已折成页脚提示`);
  if (tl.mergedMilestones) notes.push(`${tl.mergedMilestones} 个里程碑与同日里程碑并成一枚菱形绘制（日期相同，逐个画会叠成一坨）`);
  return notes;
}

/** 时间线页这一趟：画得动就把形状块并进 `out` 并带回口径/违规；画不动只带回回落原因 */
function timelineShapePass(
  item: KickoffOutlineItem,
  b: KickoffBundle,
  body: Box,
  cursor: number,
  out: Block[]
): { drawn: true; notes: string[]; dropped: string[]; violations: string[] } | { drawn: false; note: string } {
  const frame: Box = { x: body.x, y: cursor, w: body.w, h: body.y + body.h - cursor };
  const reason = timelineDegradeReason(b);
  if (reason || frame.h < TL_MIN_H) {
    const fallback = reason ?? `剩余高度 ${frame.h.toFixed(2)}" 排不下轴与 2 行条`;
    return { drawn: false, note: `时间线回落列表版：${fallback}` };
  }
  const tl = timelineBlocks(b, frame);
  out.push(...tl.blocks);
  const dropped: string[] = [];
  for (const k of item.dataKeys.filter((x) => x !== 'timeline')) dropped.push(...blocksForKey(k, b).map(describe));
  return { drawn: true, notes: timelineResultNotes(tl), dropped, violations: tl.violations };
}

/**
 * 正文块 + 数据块的排布（单栏纵向堆叠走 stackY 单源；双栏按 6:4 左右分）。
 * 排不下的块**省略并如实回报**，不硬塞——硬塞就是越界页，静默丢就是假数据页，
 * 两者都比「少一块内容 + 一条 warning」更糟。
 * `layout === 'timeline'` 走形状版（FR-4.5）；日期或里程碑不满足绘制前提时回落列表版，
 * 前提缺失与降级原因都进 `notes`，让面板如实告诉用户「这页为什么是列表」。
 */
export function layoutBody(
  item: KickoffOutlineItem,
  b: KickoffBundle,
  frames: LayoutFrames,
  bullets: string[]
): { blocks: Block[]; dropped: string[]; notes: string[]; violations: string[] } {
  const body = frames.body;
  const out: Block[] = [];
  const dropped: string[] = [];
  const notes: string[] = [];
  const bottom = body.y + body.h;
  const bodyAvail = bottom - body.y;
  // 时间线页：形状版自成一格（只需留 TL_MIN_H），回落列表版才是一张刚性表格
  const tlPage = item.layout === 'timeline' && item.dataKeys.includes('timeline');
  const tlShape = tlPage && timelineDegradeReason(b) === null;
  // 形状版自己绘制时间线块，不让它进刚性表格预算（否则时间线区被算两次，要点被无端压扁）
  const rawBlocks = item.dataKeys
    .filter((k) => !(tlShape && k === 'timeline'))
    .flatMap((k) => blocksForKey(k, b));

  if (frames.cols) {
    const [left, right] = frames.cols;
    const dataBlocks = fitRigidTables(rawBlocks, right.w, right.h);
    if (bullets.length) out.push({ box: left, text: { content: bullets.join('\n'), pt: MIN_BODY_PT } });
    const colFrame: Box = { x: right.x, y: right.y, w: right.w, h: right.h };
    const boxes = stackY(right.y, dataBlocks.map((d) => ({ h: blockHeight(d, right.w) })), MIN_GAP, colFrame);
    pushStackedBlocks(out, dropped, dataBlocks, boxes, bottom);
    return { blocks: out, dropped, notes, violations: [] };
  }

  const dataBlocks = fitRigidTables(
    rawBlocks,
    body.w,
    bodyAvail - (bullets.length || rawBlocks.some((d) => d.table == null) ? MIN_BLOCK_H + MIN_GAP : 0) - (tlShape ? TL_MIN_H + MIN_GAP : 0)
  );

  let cursor = body.y;
  if (bullets.length) {
    const content = bullets.join('\n');
    const naturalH = textHeight(content, body.w, MIN_BODY_PT);
    // T02166：同页带**刚性数据**（表格 / 时间线区）时先给它留位，否则要点吃光 body。
    // 表格已由 fitRigidTables 按剩余高度收过行，这里要点取表格排完后的真实余量；
    // 余量不足一个最小块时要点整块让位并如实留痕——留数据、不留套话。
    const rigidUsed =
      dataBlocks.filter((d) => d.table != null).reduce((s, d) => s + blockHeight(d, body.w) + MIN_GAP, 0) +
      dataBlocks.filter((d) => d.table == null).reduce((s, d) => s + MIN_BLOCK_H + MIN_GAP, 0) +
      (tlShape ? TL_MIN_H + MIN_GAP : 0);
    const capH = bodyAvail - rigidUsed;
    if (capH >= MIN_BLOCK_H) {
      const h = Math.min(naturalH, capH);
      out.push({ box: { x: body.x, y: cursor, w: body.w, h }, text: { content, pt: MIN_BODY_PT } });
      if (h < naturalH - 1e-6) {
        notes.push(`要点为表格让位压缩排版（自然高 ${naturalH.toFixed(2)}" → 实排 ${h.toFixed(2)}"，多余部分按 pptxgenjs 截字）`);
      }
      cursor += h + MIN_GAP;
    } else {
      notes.push(`要点为本页表格让位，未排入版面（剩余 ${capH.toFixed(2)}"，可拆分该页）`);
    }
  }

  if (item.layout === 'timeline' && item.dataKeys.includes('timeline')) {
    const pass = timelineShapePass(item, b, body, cursor, out);
    if (pass.drawn) {
      notes.push(...pass.notes);
      dropped.push(...pass.dropped);
      return { blocks: out, dropped, notes, violations: pass.violations };
    }
    notes.push(pass.note);
  }

  // 走到这里 = 时间线只能用列表版：把形状版排除掉的表格块补回来，并按剩余高度再收一次行
  const stackBlocks = tlShape
    ? fitRigidTables([...dataBlocks, ...blocksForKey('timeline', b)], body.w, bottom - cursor)
    : dataBlocks;
  const boxes = stackY(cursor, stackBlocks.map((d) => ({ h: blockHeight(d, body.w) })));
  pushStackedBlocks(out, dropped, stackBlocks, boxes, bottom);
  return { blocks: out, dropped, notes, violations: [] };
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
    if (blk.shape?.tone === 'axis') continue;
    const reason = assertInBounds(blk.box);
    if (reason) issues.push(`${blockKindLabel(blk)}${reason}`);
  }
  return issues;
}

/** 参与重叠判定的块框：参照线（日期轴）排除在外——里程碑菱形按设计骑在轴上，硬算就是每页都「假重叠」 */
function contentBoxes(blocks: Block[]): Box[] {
  return blocks.filter((blk) => blk.shape?.tone !== 'axis').map((blk) => blk.box);
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
 */
function degradeToSafe(item: KickoffOutlineItem, blocks: Block[], fromBody: Box): Block[] {
  const safe = safeFrames();
  const text = blocks.find((b) => b.text && b.box.w > 1);
  if (!text?.text) return [{ box: safe.body, text: { content: item.bullets.join('\n'), pt: MIN_BODY_PT } }];
  const mapped = scaleBox(text.box, fromBody, safe.body);
  const reason = assertInBounds(mapped);
  return [{ box: reason ? safe.body : mapped, text: text.text }];
}

// ---------- 原生对象写入（只用稳定特性，兼容 PowerPoint 2016+ / WPS） ----------

/** 形状配色：按 tone 取调色板色值（hex 单源来自 kickoff-layout 的 PALETTE） */
function shapeToneColor(tone: NonNullable<Block['shape']>['tone']): string {
  // T02156：恒生品牌色系——计划条用品牌亮蓝，里程碑菱形与日期轴用品牌深蓝，
  // 与模板背景的蓝色装饰同族；不再用报告系的靛蓝/警示红（那套色与品牌模板打架）
  if (tone === 'milestone') return PALETTE.brandDeep;
  if (tone === 'bar') return PALETTE.brandBright;
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
    slide.addShape(block.shape.kind, { ...geo, fill: { color }, line: { type: 'none' } });
    return;
  }
  if (block.table) {
    const rows = [
      // T02156：表头改品牌深底白字（恒生模板表格头样式），与浅蓝页面背景成「卡片」层次
      block.table.header.map((t) => ({ text: t, options: { bold: true, color: PALETTE.onBrand, fill: { color: PALETTE.brandDeep } } })),
      ...block.table.rows.map((r, i) => r.map((t) => ({ text: t, options: { color: PALETTE.ink, fill: { color: i % 2 === 1 ? PALETTE.zebraFill : PALETTE.paper } } }))),
    ];
    slide.addTable(rows, { ...geo, fontSize: 10, fontFace: FONT.face, border: { type: 'solid', pt: 0.5, color: PALETTE.border }, valign: 'middle' });
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
  item: KickoffOutlineItem;
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

/** 断言通过 → 原样落版并做文本体检；不通过 → 整体换进安全版式并留痕（验收 7） */
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
  if (!issues.length) {
    const textIssues = checkPageText({ title: item.title, bullets }, frames.body.w);
    if (textIssues.length) warnings.push(`第 ${pageNo} 页文本提示：${textIssues.join('；')}`);
    return { titleBox: frames.title, bodyBlocks: blocks };
  }
  degradedPages.push(pageNo);
  warnings.push(`第 ${pageNo} 页版式越界（${issues[0]}），已降级为「标题 + 正文」安全版式`);
  const safe = safeFrames();
  return { titleBox: safe.title, bodyBlocks: degradeToSafe(item, blocks, frames.body) };
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
    bodyBlocks = [{ box: safe.body, text: { content: isSection ? `${num} ${item.title}` : item.title, pt: MIN_BODY_PT, align: 'center' } }];
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
  let sectionNo = 0; // T02156：章节页编号按出现序递增（01/02…），与页码解耦
  for (let idx = 0; idx < outline.length; idx++) {
    if (opts.signal?.aborted) throw new Error(KICKOFF_ABORT_MSG);
    const item = outline[idx];
    const pageNo = idx + 1;
    if (item.layout === 'section') sectionNo += 1;
    appendOutlinePage({ pptx, bundle, item, pageNo, total: outline.length, sectionNo, warnings, degradedPages });
    opts.onPage?.(pageNo, item);
    await yieldToLoop();
  }

  if (opts.signal?.aborted) throw new Error(KICKOFF_ABORT_MSG);
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return { buffer: Buffer.from(out as unknown as ArrayBuffer), warnings, pageCount: outline.length, degradedPages };
}
