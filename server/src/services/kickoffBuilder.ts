/**
 * T02099：启动会 PPT 装配器（PRD-项目启动会PPT生成 FR-4 / 技术方案 §3.3 §4）。
 *
 * 职责边界：`采集 →（AI 大纲 → 用户确认）→ 逐页[dataKeys 取数 → 版式断言 → 原生对象] → Buffer`。
 * 本模块是全仓业务层 **唯一** import pptxgenjs 的地方（风险 R1：适配层独占，不散用）；
 * 几何与色彩判断一律委托 `kickoff-layout.ts`（T02098），这里只负责「把内容摆进框里并落成原生对象」。
 *
 * 三条不可让的口径：
 * 1. 页面上的数字只来自 Bundle（库内真值）；AI 文本里可对错的数字一律改写并记 warning（FR-3.4 / 验收 8）。
 * 2. 只用 `addText/addTable/addChart/addShape` 原生对象（验收 5：PowerPoint/WPS 里可编辑），不整页贴图。
 * 3. 版式断言不过 → 该页降级「标题 + 正文」安全版式并 `warnings.push`（验收 7）——宁可素，不出坏页。
 */
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
  type LayoutFrames,
} from './kickoff-layout';
import { KICKOFF_PLACEHOLDER, type KickoffBundle, type KickoffDataKey, type KickoffOutlineItem } from './kickoffService';

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
const CHART_H = 2.4;
const MAX_TABLE_ROWS = 9;
/** 时间线条高之外，页脚带高度（底带 0.4" 内） */
const FOOTER_H = 0.3;

// ---------- dataKeys 取数（数字唯一来源） ----------

function statusMark(status: string): string {
  return status === 'done' ? '已完成' : status === 'doing' ? '进行中' : status === 'blocked' ? '阻塞' : '未开始';
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
  const range = w.manDays.optimistic != null && w.manDays.pessimistic != null
    ? `${w.manDays.optimistic}~${w.manDays.pessimistic}（P50 ${w.manDays.expected}）`
    : `${w.manDays.expected}`;
  const lines = [
    `总工作量 ${range} 人天 ≈ ${w.manMonth} 人月（人月 = 人天 ÷ ${w.manDaysPerManMonth}）`,
    w.quote ? `报价区间：P50 ${w.quote.p50ManDays} / P84 ${w.quote.p84ManDays} 人天` : '报价区间：无三点估算，按工期口径',
    w.footer,
  ];
  if (w.phases.length) lines.push(`阶段分布：${w.phases.map((p) => `${p.phase} ${p.expected}`).join(' / ')} 人天`);
  if (w.complexity.length) lines.push(`复杂度分布：${w.complexity.map((c) => `${c.level}×${c.count}`).join(' / ')}`);
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
  const mark = (s: string) => (s === 'ok' ? '✓' : s === 'warn' ? '⚠' : '✕');
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

  const clusters: Array<{ box: Box; count: number }> = [];
  const times = b.milestones
    .map((m) => Date.parse(m.end_date || m.start_date || ''))
    .filter((t) => Number.isFinite(t))
    .sort((x, y) => x - y);
  for (const t of times) {
    const box = diamondBox(t, range, bars, axisY);
    const last = clusters[clusters.length - 1];
    // 相邻日期的菱形本就会叠在一起（跨度 3 周的稿里差 1 天 ≈ 0.29"，正好是一个菱形宽）：
    // 并成一组而不是丢着不画——丢了就是「图上看 4 个、库里有 6 个」的假象
    if (last && findOverlaps([last.box, box]).length > 0) {
      last.count += 1;
      continue;
    }
    clusters.push({ box, count: 1 });
  }
  const mergedMilestones = times.length - clusters.length;
  for (const c of clusters) out.push({ box: c.box, shape: { kind: 'diamond', tone: 'milestone' } });

  const ordered = [...b.plans].sort(
    (p, q) => (p.start_date || '9999-12-31').localeCompare(q.start_date || '9999-12-31') || p.sort_order - q.sort_order
  );
  const capacity = Math.floor((bottom - rowsTop) / TL_ROW_H);
  let limit = Math.min(MAX_TL_ROWS, ordered.length, capacity);
  if (ordered.length > limit) limit = Math.min(limit, Math.floor((bottom - 0.32 - rowsTop) / TL_ROW_H));

  let undated = 0;
  for (const [i, p] of ordered.slice(0, Math.max(0, limit)).entries()) {
    const rowY = rowsTop + i * TL_ROW_H;
    out.push({ box: { x: frame.x, y: rowY - 0.01, w: TL_LABEL_W, h: TL_ROW_H - 0.03 }, text: { content: p.title.slice(0, 16), pt: TL_NOTE_PT } });
    const bar = barBox(p, range, bars, rowY);
    if (!bar) {
      undated += 1;
      out.push({ box: { x: bars.x, y: rowY, w: 1.3, h: TIMELINE_BAR_H }, text: { content: '无起止日期', pt: TL_NOTE_PT } });
      continue;
    }
    out.push({ box: bar, shape: { kind: 'rect', tone: 'bar' } });
  }

  const overflow = ordered.length - Math.max(0, limit);
  if (overflow > 0) {
    out.push({ box: { x: frame.x, y: bottom - 0.28, w: frame.w, h: 0.26 }, text: { content: `其余 ${overflow} 条计划未绘出，见「项目计划」列表页`, pt: TL_NOTE_PT } });
  }

  const violations: string[] = [];
  for (const blk of out) {
    // 轴线按定义就是零高度参照线（`assertInBounds` 的「高度非正」只约束内容盒），
    // 把它排除出越界集，否则每页时间线都被判成坏页
    if (blk.shape?.tone === 'axis') continue;
    const reason = assertInBounds(blk.box, frame);
    if (reason) violations.push(`${blk.shape ? '形状' : '文本'}${reason}`);
  }
  // 轴线是参照线，菱形按设计就骑在它上面——把它排除出重叠集，否则每页都是「假越界」
  const overlaps = findOverlaps(out.filter((blk) => blk.shape?.tone !== 'axis').map((blk) => blk.box));
  if (overlaps.length) violations.push(`元素重叠 ${overlaps.length} 处`);
  out.push({
    box: { x: frame.x, y: axisY - 0.13, w: TL_LABEL_W, h: 0.28 },
    text: { content: `◆ 里程碑 ${times.length} 个${mergedMilestones ? `（同日并成 ${clusters.length} 组）` : ''}`, pt: TL_NOTE_PT },
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
  if (src.table) return TABLE_ROW_H * (src.table.rows.length + 1) + 0.12;
  return textHeight(src.text?.content ?? '', width, src.text?.pt ?? MIN_BODY_PT);
}

/** 块最小可排高度：低于它画出来就是压扁的字或看不见的图，不如省略 */
const MIN_BLOCK_H = 0.45;

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
  const dataBlocks = item.dataKeys.flatMap((k) => blocksForKey(k, b));
  const out: Block[] = [];
  const dropped: string[] = [];
  const notes: string[] = [];
  const bottom = body.y + body.h;

  if (frames.cols) {
    const [left, right] = frames.cols;
    if (bullets.length) out.push({ box: left, text: { content: bullets.join('\n'), pt: MIN_BODY_PT } });
    const colFrame: Box = { x: right.x, y: right.y, w: right.w, h: right.h };
    const boxes = stackY(right.y, dataBlocks.map((d) => ({ h: blockHeight(d, right.w) })), MIN_GAP, colFrame);
    dataBlocks.forEach((d, i) => {
      const avail = bottom - boxes[i].y;
      if (avail < MIN_BLOCK_H) {
        dropped.push(describe(d));
        return;
      }
      out.push({ box: { ...boxes[i], h: Math.min(boxes[i].h, avail) }, ...d });
    });
    return { blocks: out, dropped, notes, violations: [] };
  }

  let cursor = body.y;
  if (bullets.length) {
    const content = bullets.join('\n');
    const h = Math.min(textHeight(content, body.w, MIN_BODY_PT), bottom - cursor);
    out.push({ box: { x: body.x, y: cursor, w: body.w, h }, text: { content, pt: MIN_BODY_PT } });
    cursor += h + 0.3;
  }

  if (item.layout === 'timeline' && item.dataKeys.includes('timeline')) {
    const reason = timelineDegradeReason(b);
    const frame: Box = { x: body.x, y: cursor, w: body.w, h: bottom - cursor };
    if (!reason && frame.h >= TL_MIN_H) {
      const tl = timelineBlocks(b, frame);
      out.push(...tl.blocks);
      if (tl.undated) notes.push(`${tl.undated} 条计划缺起止日期，条形未绘制（起止日期补全后自动出现在时间线上）`);
      if (tl.overflow) notes.push(`${tl.overflow} 条计划超出本页可排行数，已折成页脚提示`);
      if (tl.mergedMilestones) notes.push(`${tl.mergedMilestones} 个里程碑与同日里程碑并成一枚菱形绘制（日期相同，逐个画会叠成一坨）`);
      for (const k of item.dataKeys.filter((x) => x !== 'timeline')) dropped.push(...blocksForKey(k, b).map(describe));
      return { blocks: out, dropped, notes, violations: tl.violations };
    }
    notes.push(`时间线回落列表版：${reason ?? `剩余高度 ${frame.h.toFixed(2)}" 排不下轴与 2 行条`}`);
  }

  const boxes = stackY(cursor, dataBlocks.map((d) => ({ h: blockHeight(d, body.w) })));
  dataBlocks.forEach((d, i) => {
    const avail = bottom - boxes[i].y;
    if (avail < MIN_BLOCK_H) {
      dropped.push(describe(d));
      return;
    }
    out.push({ box: { ...boxes[i], h: Math.min(boxes[i].h, avail) }, ...d });
  });
  return { blocks: out, dropped, notes, violations: [] };
}

function describe(src: Omit<Block, 'box'>): string {
  return src.chart ? `图表「${src.chart.name}」` : src.table ? `表格（${src.table.rows.length + 1} 行）` : src.shape ? `形状「${src.shape.kind}」` : '文本块';
}

/** 整页断言：标题与各块在内容框内、彼此不重叠（门禁 2 + 5 在此消费） */
export function pageViolations(title: Box, titleText: string, blocks: Block[], titlePt = 22): string[] {
  const issues: string[] = [];
  const titleReason = assertInBounds(title);
  if (titleReason) issues.push(`标题${titleReason}`);
  // 长标题排不进标题带是验收 7 点名的越界形态，必须在写盘前判出来
  const needH = textHeight(titleText, title.w, titlePt);
  if (needH > title.h + 1e-6) issues.push(`标题需 ${needH.toFixed(2)}" 高于标题带 ${title.h.toFixed(2)}"`);
  for (const blk of blocks) {
    // 轴线既非内容盒也不占高度（零高度参照线），越界与重叠两道都不算它
    if (blk.shape?.tone === 'axis') continue;
    const reason = assertInBounds(blk.box);
    if (reason) issues.push(`${blk.table ? '表格' : blk.chart ? '图表' : blk.shape ? '形状' : '文本'}${reason}`);
  }
  // 参照线（日期轴）不计入重叠集：里程碑菱形按设计骑在轴上，硬算就是每页都「假重叠」
  const overlaps = findOverlaps([title, ...blocks.filter((blk) => blk.shape?.tone !== 'axis').map((blk) => blk.box)]);
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

export function drawBlock(slide: any, block: Block): void {
  const geo = { x: +block.box.x.toFixed(3), y: +block.box.y.toFixed(3), w: +block.box.w.toFixed(3), h: +block.box.h.toFixed(3) };
  if (block.shape) {
    const tone = block.shape.tone;
    const color = tone === 'milestone' ? PALETTE.warn : tone === 'bar' ? PALETTE.accent : PALETTE.ink;
    if (block.shape.kind === 'line') {
      slide.addShape('line', { ...geo, line: { color, width: 1.5 } });
      return;
    }
    slide.addShape(block.shape.kind, { ...geo, fill: { color }, line: { type: 'none' } });
    return;
  }
  if (block.table) {
    const rows = [
      block.table.header.map((t) => ({ text: t, options: { bold: true, color: PALETTE.ink, fill: { color: PALETTE.headFill } } })),
      ...block.table.rows.map((r, i) => r.map((t) => ({ text: t, options: { color: PALETTE.ink, fill: { color: i % 2 === 1 ? PALETTE.zebraFill : PALETTE.paper } } }))),
    ];
    slide.addTable(rows, { ...geo, fontSize: 10, fontFace: FONT.face, border: { type: 'solid', pt: 0.5, color: PALETTE.border }, valign: 'middle' });
    return;
  }
  if (block.chart) {
    slide.addChart(block.chart.type, [{ name: block.chart.name, labels: block.chart.labels, values: block.chart.values }], {
      ...geo,
      chartColors: [PALETTE.accent, PALETTE.warn, PALETTE.headFill],
      showLegend: true,
      legendPos: 'r',
      showTitle: false,
      barDir: 'col',
      dataLabelFontSize: 9,
      showValue: block.chart.type === 'bar',
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

export async function buildKickoffPpt(bundle: KickoffBundle, outline: KickoffOutlineItem[]): Promise<KickoffBuildResult> {
  const warnings: string[] = [];
  const paletteIssues = auditPalette();
  if (paletteIssues.length) warnings.push(`配色对比度不达标：${paletteIssues.join('；')}`);

  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout(KICKOFF_LAYOUT_DEF); // 尺寸单源来自 T02098
  pptx.layout = KICKOFF_LAYOUT_DEF.name;
  pptx.title = `${bundle.project.name} 项目启动会`;
  pptx.author = 'MTask';
  pptx.company = bundle.project.name;

  const degradedPages: number[] = [];
  outline.forEach((item, idx) => {
    const pageNo = idx + 1;
    const bullets = sanitizeBullets(item.bullets, bundle, pageNo, warnings);
    const frames = framesFor(layoutFamilyOf(item.layout), item.layout, item.layout === 'twoCol' ? TEXT_SPLIT : undefined);
    const titlePt = item.layout === 'cover' ? 32 : 22;
    const { blocks, dropped, notes, violations } = layoutBody(item, bundle, frames, bullets);
    if (dropped.length) warnings.push(`第 ${pageNo} 页空间不足，已省略 ${dropped.join('、')}（内容未丢，页面上少排一块，可拆分该页）`);
    for (const n of notes) warnings.push(`第 ${pageNo} 页：${n}`);
    const issues = [...pageViolations(frames.title, item.title, blocks, titlePt), ...violations];
    let titleBox = frames.title;
    let bodyBlocks = blocks;
    if (issues.length) {
      degradedPages.push(pageNo);
      warnings.push(`第 ${pageNo} 页版式越界（${issues[0]}），已降级为「标题 + 正文」安全版式`);
      const safe = safeFrames();
      titleBox = safe.title;
      bodyBlocks = degradeToSafe(item, blocks, frames.body);
    } else {
      const textIssues = checkPageText({ title: item.title, bullets }, frames.body.w);
      if (textIssues.length) warnings.push(`第 ${pageNo} 页文本提示：${textIssues.join('；')}`);
    }

    const slide = pptx.addSlide();
    const centered = item.layout === 'cover' || item.layout === 'toc';
    const titleBlock: Block = {
      box: titleBox,
      text: { content: item.title, pt: titlePt, bold: true, align: centered ? 'center' : 'left' },
    };
    for (const block of [titleBlock, ...bodyBlocks]) {
      try {
        drawBlock(slide, block);
      } catch (e) {
        // 第三方库（R1）个别元素写崩不该拖垮整份稿：跳该元素并如实点名
        warnings.push(`第 ${pageNo} 页有元素写入失败（${e instanceof Error ? e.message : String(e)}），已跳过`);
      }
    }
    slide.addText(footerOf(item, bundle, pageNo, outline.length), {
      x: 0.5,
      y: KICKOFF_LAYOUT_DEF.height - FOOTER_H - 0.08,
      w: 9,
      h: FOOTER_H,
      fontSize: 9,
      color: PALETTE.ink,
      align: 'right',
      // 脚注只有一行预算：换行会顶出画布下缘，宁可让长口径向左溢出（右对齐，仍在画布内）
      wrap: false,
      fontFace: FONT.face,
    });
  });

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return { buffer: Buffer.from(out as unknown as ArrayBuffer), warnings, pageCount: outline.length, degradedPages };
}
