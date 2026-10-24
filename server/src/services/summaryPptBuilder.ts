/**
 * T02855（六期 S4）：阶段性总结汇报 PPT 装配器（PRD §3.4 第 4/5 步、§6.3）。
 *
 * 职责边界与 kickoff 装配器同族：**本模块不查库、不调 AI**，只把 `summaryPptData` 采好的
 * `SummaryDeckData` 按大纲的 `dataKeys` 摆进版式并落成 pptxgenjs 原生对象（可编辑）。
 * 几何与色彩断言全部复用 `kickoff-layout.ts`；渲染原语复用 `kickoffBuilder.drawBlock`
 * （全仓唯一 import pptxgenjs 的仍是 kickoff 适配层，本文件只动态 import 其构造函数）。
 *
 * 本单的四条验收：
 *  1. **里程碑两态**（FR-5.5 / 验收 15）：有子项 → `done/total · progress%`；无子项 → 状态徽标 +
 *     「人工填报」，**不出现 0% 进度**；
 *  2. **工作量三口径**（FR-5.8 / A-5 / 验收 14）：默认「不报本期人天」，累计口径需显式开启并带
 *     「累计估算，非本期实测」；分摊口径在取数层即被禁用（抛错），本层只承认落库口径；
 *  3. **独立版式名**（§6.3 门禁 0）：`SUMMARY_LAYOUT_DEF`，deck 里不出现 KICKOFF 标识；
 *  4. **越界降级**（§6.3 门禁 2/5 + 验收 7）：整页断言不过 → 换安全版式「标题+正文」并留痕。
 *
 * 数字纪律：页面数字全部来自 DeckData；AI 的 bullets 只作措辞，不解析其中的数字。
 */
import {
  FONT,
  MIN_BODY_PT,
  MIN_GAP,
  PALETTE,
  TEXT_SPLIT,
  assertInBounds,
  auditPalette,
  checkPageText,
  framesFor,
  layoutFamilyOf,
  safeFrames,
  stackY,
  scaleBox,
  type Box,
  type LayoutFrames,
} from './kickoff-layout';
import { blockHeight as naturalBlockHeight, drawBlock, fitTableRows, pageViolations, type Block } from './kickoffBuilder';
import { SUMMARY_FOOTER_H, SUMMARY_FOOTER_Y, SUMMARY_LAYOUT_DEF } from './summaryPptLayout';
import type { SummaryDataKey, SummaryOutlineItem } from './summaryPptOutline';
import {
  ISSUE_LEVEL_LABEL,
  PLAN_STATUS_LABEL,
  projectOf,
  type SummaryDeckData,
  type SummaryMilestone,
  type SummaryPlanRow,
  type SummaryProjectData,
} from './summaryPptData';

// ---------- 结果与接缝 ----------

export interface SummaryBuildResult {
  buffer: Buffer;
  /** 降级/省略/口径提示全部落在 warnings（FR-3.2 面板可见），不静默 */
  warnings: string[];
  pageCount: number;
  /** 被降级为「标题 + 正文」的页码（1 起） */
  degradedPages: number[];
}

export interface SummaryBuildOptions {
  /** 逐页回调（S5 SSE 的 stage 单源） */
  onPage?: (pageNo: number, item: SummaryOutlineItem) => void;
  /** 客户端断开：每页开头检查，命中即抛错，绝不落半成品 */
  signal?: AbortSignal;
}

export const SUMMARY_ABORT_MSG = '总结汇报稿生成已取消';

/** 表格行数上限（信息密度上限；实际行数再由剩余高度二分收行） */
const MAX_TABLE_ROWS = 10;
/** 图表最小**可读**高（同 kickoff T02172 口径：再低刻度/图例叠成一团，宁可整块省略并留痕） */
const CHART_MIN_H = 1.2;
/** 风险页能力声明（FR-5.7 要求写入页脚） */
export const RISK_CAPABILITY = '风险为规则推导（系统无人工风险登记实体）';

const STATUS_MARK: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✕' };

// ---------- 小工具 ----------

/**
 * 表格按可用高度反推可排行数（T02855）：测高直接复用 `kickoffBuilder.blockHeight`，
 * 与 `drawBlock` 的绘制口径同源（此前本地公式漏了单元格 padding，表格少算约 0.1"/行）。
 * 二分找能放下的最大 `maxRows`（含表头/折行提示行的语义由 `fitTableRows` 定义），
 * 被收掉的行并进「其余 N 条」——少画但不谎称画全。
 */
function fitTableToHeight(
  table: NonNullable<Block['table']>,
  maxH: number,
  width: number,
): NonNullable<Block['table']> {
  const hardCap = Math.max(1, Math.min(table.rows.length, MAX_TABLE_ROWS));
  let lo = 1;
  let hi = hardCap;
  let best = 1;
  const fits = (rows: number) => naturalBlockHeight({ table: fitTableRows(table, rows) }, width) <= maxH + 1e-9;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (process.env.T02855_DEBUG) {
    console.error('FIT', { maxH, hardCap, best });
  }
  return fitTableRows(table, best);
}
function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

function shortDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '—';
}

function eventDay(iso: string): string {
  return iso ? iso.slice(5, 10) : '—';
}

// ---------- dataKeys → 数据块 ----------

/** 合并版（无 projectId）的 KPI 汇总：各项目求和/加权，数字仍全部来自库 */
function mergedKpi(deck: SummaryDeckData): {
  active: number;
  done: number;
  verified: number;
  avgProgress: number;
  milestones: number;
  milestonesDone: number;
  overdue: number;
  plans: number;
} {
  const ps = deck.projects;
  const plans = ps.reduce((a, p) => a + p.plans.total, 0);
  return {
    active: ps.reduce((a, p) => a + p.tasks.active, 0),
    done: ps.reduce((a, p) => a + p.tasks.done, 0),
    verified: ps.reduce((a, p) => a + p.tasks.verified, 0),
    avgProgress: plans === 0 ? 0 : Math.round(ps.reduce((a, p) => a + p.plans.avgProgress * p.plans.total, 0) / plans),
    milestones: ps.reduce((a, p) => a + p.milestones.length, 0),
    milestonesDone: ps.reduce((a, p) => a + p.milestones.filter((m) => m.status === 'done').length, 0),
    overdue: ps.reduce((a, p) => a + p.plans.overdue, 0),
    plans,
  };
}

function kpiBlocks(deck: SummaryDeckData, p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  const k = p
    ? {
        active: p.tasks.active,
        done: p.tasks.done,
        verified: p.tasks.verified,
        avgProgress: p.plans.avgProgress,
        milestones: p.milestones.length,
        milestonesDone: p.milestones.filter((m) => m.status === 'done').length,
        overdue: p.plans.overdue,
        plans: p.plans.total,
      }
    : mergedKpi(deck);
  return [{
    table: {
      header: ['指标', '数值'],
      colW: [1, 1.6],
      rows: [
        ['本期活动任务', `${k.active} 条（完成 ${k.done} · 已验证 ${k.verified}）`],
        ['计划平均进度', `${pct(k.avgProgress)}（${k.plans} 条计划）`],
        ['里程碑', `${k.milestonesDone}/${k.milestones} 个已达成`],
        ['逾期计划', `${k.overdue} 条`],
      ],
    },
  }];
}

function highlightsBlocks(deck: SummaryDeckData, p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  const lines: string[] = [];
  if (p) {
    lines.push(`本期有活动的任务 ${p.tasks.active} 条（活动≠完成，仅表示本期被改动过）`);
    lines.push(`当前计划：完成 ${p.plans.byStatus.done} · 进行中 ${p.plans.byStatus.doing} · 阻塞 ${p.plans.byStatus.blocked}`);
    const evs = p.events.slice(0, 5).map((e) => `${eventDay(e.at)} ${e.kind}：${e.title}${e.detail ? `（${e.detail}）` : ''}`);
    lines.push(...(evs.length ? evs : ['本期事件无记录（或早于事件保留期，见页脚覆盖声明）']));
  } else {
    for (const x of deck.projects) lines.push(`${x.name}：本期活动任务 ${x.tasks.active} 条 · 完成计划 ${x.plans.byStatus.done} 条`);
  }
  return [{ text: { content: lines.join('\n'), pt: MIN_BODY_PT } }];
}

/** FR-5.5 / 验收 15：两态渲染的唯一生产者 */
function milestoneRows(p: SummaryProjectData): string[][] {
  return p.milestones.map((m: SummaryMilestone) => [
    m.title,
    `${PLAN_STATUS_LABEL[m.status]}${m.hasChildren ? '' : ' · 人工填报'}`,
    m.hasChildren ? `${m.done}/${m.total} 子项 · ${m.progress}%` : '—（无子项，不显示进度条）',
  ]);
}

function milestonesBlocks(p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  if (!p) return [];
  if (p.milestones.length === 0) {
    const stages = p.plans.rows.filter((r) => r.title && r.status !== 'done').slice(0, 6).map((r) => `· ${r.title}`);
    return [{
      text: {
        content: ['无里程碑行，按阶段分组：', ...(stages.length ? stages : ['· 暂无可列阶段'])].join('\n'),
        pt: MIN_BODY_PT,
      },
    }];
  }
  return [{
    table: { header: ['里程碑', '状态', '聚合进度'], colW: [2.2, 1.4, 1.8], rows: milestoneRows(p) },
  }];
}

function planRowCells(r: SummaryPlanRow): string[] {
  return [
    `${r.overdue ? '逾期·' : ''}${r.title}`,
    PLAN_STATUS_LABEL[r.status],
    `${shortDate(r.startDate)}~${shortDate(r.endDate)}`,
    `${r.progress}%`,
  ];
}

function planRowsBlocks(p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  if (!p) return [];
  if (p.plans.rows.length === 0) return [{ text: { content: '暂无计划行。', pt: MIN_BODY_PT } }];
  const table: NonNullable<Block['table']> = { header: ['计划', '状态', '起止', '进度'], colW: [2.4, 0.8, 1.6, 0.6], rows: p.plans.rows.map(planRowCells) };
  const overdueNames = p.plans.rows.filter((r) => r.overdue).slice(0, 4).map((r) => r.title);
  const blockedNames = p.plans.rows.filter((r) => r.status === 'blocked').slice(0, 4).map((r) => r.title);
  const note = overdueNames.length === 0 && blockedNames.length === 0
    ? '本周期无延期与阻塞。'
    : `逾期：${overdueNames.length ? overdueNames.join('、') : '无'}；阻塞：${blockedNames.length ? blockedNames.join('、') : '无'}`;
  return [
    { table },
    { text: { content: note, pt: MIN_BODY_PT } },
  ];
}

function risksBlocks(p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  if (!p) return [];
  const rows: string[][] = [];
  for (const i of p.issues.slice(0, 4)) {
    const lv = ISSUE_LEVEL_LABEL[i.level] ?? (i.level || '待确认');
    rows.push([`需求待确认（${lv}）`, `${i.question}${i.answer ? ` → ${i.answer}` : ''}`]);
  }
  rows.push(
    ['执行风险', `逾期计划 ${p.risks.overdue} 条`],
    ['执行风险', `阻塞计划 ${p.risks.blocked} 条`],
    ['执行风险', `复杂度≥4 计划 ${p.risks.complex} 条`],
    ['执行风险', `未达成里程碑 ${p.risks.milestonesNotDone} 个`],
  );
  return [{
    table: { header: ['类别', '条目'], colW: [1.5, 3.9], rows },
  }];
}

function workloadBlocks(p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  if (!p) return [];
  const rows: string[][] = [
    ['完成计划', `${p.workload.donePlans} 条（工期 ${p.workload.doneDurationDays} 天 / 累计 ${p.workload.totalDurationDays} 天）`],
    ['估算口径', p.workload.caliber === 'cumulative' ? '累计估算（非本期实测）' : '不报本期人天（完成项数 + 工期消耗）'],
  ];
  if (p.workload.caliber === 'cumulative') {
    rows.push(['累计估算', `${p.workload.likelyDays} 人天 / ${p.workload.estimateItems} 行三点估算`]);
  }
  rows.push(['复杂度≥4', `${p.workload.complexRows} 条`]);
  rows.push(['用例覆盖', `${p.coverage.covered}/${p.coverage.total}（${pct(p.coverage.rate)}）`]);
  rows.push(['P0~P3 分布', p.coverage.byPriority.length ? p.coverage.byPriority.map((x) => `${x.priority} ${x.count}`).join(' · ') : '—']);
  const chart: NonNullable<Block['chart']> = p.workload.caliber === 'cumulative' && p.workload.byPhase.length > 0
    // 口径①：按阶段画人天柱图（标题已限定「累计」）
    ? { type: 'bar', name: '累计估算人天', labels: p.workload.byPhase.map((x) => x.phase), values: p.workload.byPhase.map((x) => x.likely) }
    // 口径③：不画人天，改画完成项数分布（PRD FR-5.8 明确要求）
    : {
        type: 'bar',
        name: '计划项数',
        labels: ['未开始', '进行中', '阻塞', '已完成'],
        values: [p.plans.byStatus.todo, p.plans.byStatus.doing, p.plans.byStatus.blocked, p.plans.byStatus.done],
      };
  return [{ table: { header: ['指标', '数值'], colW: [1.2, 3.2], rows } }, { chart }];
}

function deliverablesBlocks(p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  if (!p) return [];
  const rows: string[][] = [
    ...p.deliverables.docs.map((d) => ['PRD 文档', d.filename, `${d.status === 'confirmed' ? '确认版' : '评审中'} · ${shortDate(d.updatedAt)}`]),
    ...p.deliverables.snapshots.map((s) => ['估算导出', s.filename || '（未命名）', shortDate(s.createdAt)]),
    ...p.deliverables.donePlanTitles.map((t) => ['功能交付', t, '计划已完成']),
  ];
  if (rows.length === 0) return [{ text: { content: '本期无已记录交付物（PRD 文档 / 估算导出 / 完成计划均为空）。', pt: MIN_BODY_PT } }];
  return [
    { table: { header: ['类别', '名称', '状态/日期'], colW: [0.9, 2.8, 1.5], rows } },
    { text: { content: `完成计划 ${p.deliverables.donePlans} 条 · 本期完成待办 ${p.deliverables.doneTasks} 条。`, pt: MIN_BODY_PT } },
  ];
}

function nextStepsBlocks(p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  if (!p) return [];
  if (p.nextPlans.length === 0) return [{ text: { content: '全部计划已完成——项目已收尾。', pt: MIN_BODY_PT } }];
  const rows = p.nextPlans.map((r) => [r.title, shortDate(r.startDate), `${r.progress}%`]);
  const next = p.nextMilestone;
  return [
    { table: { header: ['待推进计划', '开始', '进度'], colW: [3.2, 1.2, 0.9], rows } },
    { text: { content: next ? `下一里程碑：${next.title}（${shortDate(next.endDate)}，${PLAN_STATUS_LABEL[next.status]}）` : '无未完成里程碑。', pt: MIN_BODY_PT } },
  ];
}

function appendixBlocks(deck: SummaryDeckData): Array<Omit<Block, 'box'>> {
  // FR-5.12「降级标记汇总」：fail/warn 排前面——附录放不下时先保住降级项，而不是按 S 序号截断
  const rank: Record<string, number> = { fail: 0, warn: 1, ok: 2 };
  const items = [...deck.preflight.items].sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
  const rows = items.map((i) => [`${i.key} ${i.label}`, String(i.count), STATUS_MARK[i.status] ?? i.status]);
  // 项目名与工作空间在页脚（FR-5.12）：附录只有 ~2.5" 正文高，再塞一段文字会把 S 项挤出 4 行
  return [{ table: { header: ['校验项', '条数', '状态'], colW: [2.6, 0.8, 0.6], rows } }];
}

/** FR-6.1 汇总对比页：各项目 KPI 横表（任务完成/计划进度/里程碑进度/逾期数/blocker 数），数字全部本地求和 */
function compareBlocks(deck: SummaryDeckData): Array<Omit<Block, 'box'>> {
  const rows = deck.projects.map((p) => [
    p.name,
    `${p.tasks.done}`,
    pct(p.plans.avgProgress),
    `${p.milestones.filter((m) => m.status === 'done').length}/${p.milestones.length}`,
    `${p.plans.overdue}`,
    `${p.plans.blocked}`,
  ]);
  return [{
    table: {
      header: ['项目', '任务完成', '计划进度', '里程碑进度', '逾期数', 'blocker 数'],
      colW: [1.8, 1.1, 1.1, 1.2, 0.9, 1.1],
      rows,
    },
  }];
}

/**
 * FR-6.1 横向对比页：进度柱图 + 工作量柱图。
 * 工作量单位必须全 deck 一致（A-5）：全体都有三点估算才画「累计估算人天」，
 * 否则统一画「完成工期（天）」（`duration_days` 口径），不与估算人天混轴。
 */
function horizontalBlocks(deck: SummaryDeckData): Array<Omit<Block, 'box'>> {
  const names = deck.projects.map((p) => p.name);
  const cumulative = deck.projects.every((p) => p.workload.caliber === 'cumulative');
  return [
    { chart: { type: 'bar', name: '计划平均进度（%）', labels: names, values: deck.projects.map((p) => p.plans.avgProgress) } },
    {
      chart: {
        type: 'bar',
        name: cumulative ? '工作量（累计估算人天）' : '工作量（完成工期，天）',
        labels: names,
        values: deck.projects.map((p) => (cumulative ? p.workload.likelyDays : p.workload.doneDurationDays)),
      },
    },
    {
      text: {
        content: deck.projects.map((p) => `${p.name}：完成计划 ${p.plans.byStatus.done} 条 · 完成待办 ${p.tasks.done} 条 · 逾期 ${p.plans.overdue} 条`).join('\n'),
        pt: MIN_BODY_PT,
      },
    },
  ];
}

/** dataKey → 数据块（每个 key 只在这里落地一次；合并版页面只出现 compare/horizontal） */
export function blocksForKey(key: SummaryDataKey, deck: SummaryDeckData, p?: SummaryProjectData): Array<Omit<Block, 'box'>> {
  switch (key) {
    case 'kpi':
      return kpiBlocks(deck, p);
    case 'highlights':
      return highlightsBlocks(deck, p);
    case 'milestones':
      return milestonesBlocks(p);
    case 'planRows':
      return planRowsBlocks(p);
    case 'risks':
      return risksBlocks(p);
    case 'workload':
      return workloadBlocks(p);
    case 'deliverables':
      return deliverablesBlocks(p);
    case 'nextSteps':
      return nextStepsBlocks(p);
    case 'summary':
      // FR-5.11：仅 AI 措辞——正文由本页 bullets 承载，不另造第二个数字块
      return [];
    case 'appendix':
      return appendixBlocks(deck);
    case 'compare':
      return compareBlocks(deck);
    case 'horizontal':
      return horizontalBlocks(deck);
    default:
      return [];
  }
}

// ---------- 版式装配 ----------

/** 页面主体：先要点、后数据块；表格按剩余高度收行、图表可压到最小可读高，仍放不下的整块省略并留痕 */
function layoutBody(
  item: SummaryOutlineItem,
  deck: SummaryDeckData,
  frames: LayoutFrames,
  warnings: string[],
  pageNo: number,
): { blocks: Block[]; dropped: string[] } {
  const p = projectOf(deck, item.projectId);
  const bullets = item.bullets.filter((b) => b.trim() !== '');
  const data: Array<{ key: SummaryDataKey; src: Omit<Block, 'box'> }> = [];
  for (const key of item.dataKeys) {
    for (const src of blocksForKey(key, deck, p)) data.push({ key, src });
  }
  const dropped: string[] = [];
  const placed: Block[] = [];
  const family = layoutFamilyOf(item.layout);

  /** 按给定栏框排一列块：表格按剩余高度收行，图表在剩余高度内压低到最小可读高 */
  const stackInto = (frame: Box, subset: Array<{ key: SummaryDataKey; src: Omit<Block, 'box'> }>) => {
    if (subset.length === 0) return;
    const heights = subset.map((d) => naturalBlockHeight(d.src, frame.w));
    const gaps = MIN_GAP * Math.max(0, subset.length - 1);
    const fixed = subset.reduce((a, d, i) => a + (d.src.table ? 0 : d.src.chart ? CHART_MIN_H : Math.min(heights[i], 0.5)), 0);
    const tables = subset.filter((d) => d.src.table).length;
    if (tables > 0) {
      const per = (frame.h - gaps - fixed) / tables;
      subset.forEach((d, i) => {
        if (!d.src.table) return;
        d.src = { ...d.src, table: fitTableToHeight(d.src.table!, per, frame.w) };
        heights[i] = naturalBlockHeight(d.src, frame.w);
      });
    }
    let over = heights.reduce((a, h) => a + h, 0) + gaps - frame.h;
    for (let i = 0; i < subset.length && over > 1e-9; i++) {
      if (!subset[i].src.chart) continue;
      const cut = Math.min(over, Math.max(0, heights[i] - CHART_MIN_H));
      heights[i] -= cut;
      over -= cut;
    }
    const boxes = stackY(frame.y, heights.map((h) => ({ h })), MIN_GAP, frame);
    const bottom = frame.y + frame.h;
    subset.forEach((d, i) => {
      if (boxes[i].y + heights[i] > bottom + 1e-6) {
        dropped.push(d.key);
        return;
      }
      placed.push({ box: { ...boxes[i], h: heights[i] }, ...d.src });
    });
  };

  if (family === 'twoCol' && frames.cols) {
    const [left, right] = frames.cols;
    if (bullets.length) {
      placed.push({ box: left, text: { content: bullets.join('\n'), pt: MIN_BODY_PT } });
    }
    stackInto(right, data);
  } else {
    let body = frames.body;
    if (bullets.length) {
      const natural = naturalBlockHeight({ text: { content: bullets.join('\n'), pt: MIN_BODY_PT } }, body.w);
      const h = Math.min(natural, body.h * 0.45);
      placed.push({ box: { ...body, h }, text: { content: bullets.join('\n'), pt: MIN_BODY_PT } });
      body = { x: body.x, y: body.y + h + MIN_GAP, w: body.w, h: body.h - h - MIN_GAP };
    }
    // FR-5.8「表格 + 柱图」同页：5.625" 画布纵向叠放（6 行表 1.9" + 柱图 1.2" + 要点）必然挤掉一块，
    // 改为左表右图——两块都保自然尺寸，才谈得上「表格/柱图都在」。
    const splittable = item.layout === 'chart'
      && data.length > 0 && data.every((d) => d.src.table || d.src.chart)
      && data.some((d) => d.src.table) && data.some((d) => d.src.chart);
    // FR-6.1「横向对比」同页要两张柱图（进度 + 工作量）：纵排时两图最小可读高之和
    // （1.2"×2 + 间距）已超正文区剩余高度，第二张图会被整块省略——改为左右并排。
    const chartRow = data.filter((d) => d.src.chart);
    const sideBySideCharts = item.layout === 'chart'
      && chartRow.length >= 2 && !data.some((d) => d.src.table);
    if (splittable) {
      const leftW = Math.round(body.w * 0.52 * 100) / 100;
      stackInto({ ...body, w: leftW }, data.filter((d) => d.src.table));
      stackInto({ x: body.x + leftW + MIN_GAP, y: body.y, w: body.w - leftW - MIN_GAP, h: body.h }, data.filter((d) => d.src.chart));
    } else if (sideBySideCharts) {
      const others = data.filter((d) => !d.src.chart);
      const othersH = others.reduce((a, d) => a + Math.min(naturalBlockHeight(d.src, body.w), 0.6), 0);
      const colW = (body.w - MIN_GAP * (chartRow.length - 1)) / chartRow.length;
      const room = body.h - (others.length ? othersH + MIN_GAP : 0);
      const chartH = Math.max(CHART_MIN_H, Math.min(naturalBlockHeight(chartRow[0].src, colW), room));
      chartRow.forEach((d, i) => {
        placed.push({ box: { x: body.x + i * (colW + MIN_GAP), y: body.y, w: colW, h: chartH }, ...d.src });
      });
      // 图下的说明文字：放不下就省略并留痕（柱图是 FR-6.1 的硬要求，文字让位）
      let cursorY = body.y + chartH + MIN_GAP;
      for (const d of others) {
        const h = Math.min(naturalBlockHeight(d.src, body.w), 0.6);
        if (cursorY + h > body.y + body.h + 1e-6) {
          dropped.push(d.key);
          continue;
        }
        placed.push({ box: { x: body.x, y: cursorY, w: body.w, h }, ...d.src });
        cursorY += h + MIN_GAP;
      }
    } else {
      stackInto(body, data);
    }
  }
  if (dropped.length) {
    warnings.push(`第 ${pageNo} 页空间不足，已省略数据块 ${[...new Set(dropped)].join('、')}（内容未丢，可拆分该页）`);
  }
  return { blocks: placed, dropped };
}

/** 降级页：换安全版式 = 缩放（门禁 4）；映射后仍越界就退回安全框本身 */
function degradeSummary(item: SummaryOutlineItem, blocks: Block[], fromBody: Box): Block[] {
  const safe = safeFrames();
  const text = blocks.find((b) => b.text && b.box.w > 1);
  const content = text?.text?.content || item.bullets.filter((b) => b.trim()).join('\n') || item.dataKeys.join(' / ');
  if (!text) return [{ box: safe.body, text: { content, pt: MIN_BODY_PT, shrink: true } }];
  const mapped = scaleBox(text.box, fromBody, safe.body);
  const reason = assertInBounds(mapped);
  return [{ box: reason ? safe.body : mapped, text: { ...text.text!, shrink: true } }];
}

/** 逐页脚注（FR-5.13 + FR-3.2 + FR-5.7/5.8 口径声明） */
export function summaryFooterOf(
  item: SummaryOutlineItem,
  deck: SummaryDeckData,
  label: string,
  pageNo: number,
  total: number,
): string {
  const parts = [label, item.section || '正文', `数据截至 ${deck.dataAsOf}`];
  const p = projectOf(deck, item.projectId);
  if (item.dataKeys.includes('workload') && p) parts.push(p.workload.footer);
  if (item.dataKeys.includes('highlights') && deck.coverage.degraded) parts.push(deck.coverage.footnote);
  if (item.dataKeys.includes('risks')) parts.push(RISK_CAPABILITY);
  if (item.dataKeys.includes('appendix')) {
    // FR-5.12：附录要带项目工作空间；放页脚比正文多一段更省版面（正文留给 S1~S9 表）
    const ws = deck.projects.filter((x) => x.workspace).map((x) => `${x.name}（${x.workspace}）`);
    if (ws.length) parts.push(`工作空间 ${ws.join('；')}`);
  }
  return `${parts.join(' · ')} · 第 ${pageNo}/${total} 页`;
}

function pageLabel(deck: SummaryDeckData, item: SummaryOutlineItem): string {
  const p = projectOf(deck, item.projectId);
  if (p) return p.name;
  return deck.projects.map((x) => x.name).join('、') || '全部项目';
}

/** 标题 + 数据块 + 页脚落成原生对象；越界整页降级并留痕 */
function appendPage(
  pptx: { addSlide(opts?: { masterName?: string }): any },
  deck: SummaryDeckData,
  item: SummaryOutlineItem,
  outline: SummaryOutlineItem[],
  pageNo: number,
  total: number,
  sectionNo: number,
  warnings: string[],
  degradedPages: number[],
): void {
  const isCover = item.layout === 'cover';
  const isToc = item.layout === 'toc';
  const isSection = item.layout === 'section';
  const isThanks = item.layout === 'thanks';
  const family = layoutFamilyOf(item.layout);
  const frames = framesFor(family, item.layout, item.layout === 'twoCol' ? TEXT_SPLIT : undefined);
  const titlePt = isCover ? 32 : isToc ? 22 : isSection ? 28 : 22;
  const centered = isCover || isToc || isSection || isThanks;

  let blocks: Block[] = [];
  if (isCover) {
    const lines = [deck.projects.map((p) => p.name).join('、') || '（未选择项目）', `${deck.periodLabel} · 数据截至 ${deck.dataAsOf}`];
    blocks = [{ box: frames.body, text: { content: lines.join('\n'), pt: 16, align: 'center' } }];
  } else if (isToc) {
    const sections = [...new Set(outline.filter((o) => o.layout !== 'cover' && o.layout !== 'toc').map((o) => o.section).filter(Boolean))];
    // 目录是本地生成（FR-5.2 不由 AI 写）；14pt 单行 10 条以内，超出折为「更多…」防顶出正文框
    const shown = sections.slice(0, 10);
    const lines = shown.map((s, i) => `${String(i + 1).padStart(2, '0')}  ${s}`);
    if (sections.length > shown.length) lines.push(`…另有 ${sections.length - shown.length} 个章节`);
    blocks = [{ box: frames.body, text: { content: lines.join('\n'), pt: 14 } }];
  } else if (isSection) {
    blocks = [{ box: frames.number!, text: { content: String(sectionNo).padStart(2, '0'), pt: 32, bold: true, align: 'center', color: PALETTE.brandDeep } }];
  } else if (isThanks) {
    blocks = [{ box: frames.body, text: { content: `${pageLabel(deck, item)} · ${deck.periodLabel} · 数据截至 ${deck.dataAsOf}`, pt: MIN_BODY_PT, align: 'center' } }];
  } else {
    const body = layoutBody(item, deck, frames, warnings, pageNo);
    blocks = body.blocks;
    if (blocks.length === 0) {
      blocks = [{ box: frames.body, text: { content: item.title, pt: MIN_BODY_PT, align: 'center', shrink: true } }];
      warnings.push(`第 ${pageNo} 页正文无可绘内容，已按「标题 + 章节式留白」承载`);
    }
    const textIssues = checkPageText({ title: item.title, bullets: item.bullets }, frames.body.w);
    if (textIssues.length) warnings.push(`第 ${pageNo} 页文本提示：${textIssues.join('；')}`);
  }

  let titleBox = frames.title;
  let bodyBlocks = blocks;
  const issues = pageViolations(frames.title, item.title, blocks, titlePt);
  if (issues.length) {
    degradedPages.push(pageNo);
    warnings.push(`第 ${pageNo} 页版式越界（${issues[0]}），已降级为「标题 + 正文」安全版式`);
    const safe = safeFrames();
    titleBox = safe.title;
    bodyBlocks = degradeSummary(item, blocks, frames.body);
  }

  const slide = pptx.addSlide();
  for (const block of [{ box: titleBox, text: { content: item.title, pt: titlePt, bold: true, align: centered ? ('center' as const) : ('left' as const), color: PALETTE.brandDeep } }, ...bodyBlocks]) {
    try {
      drawBlock(slide, block);
    } catch (e) {
      warnings.push(`第 ${pageNo} 页有元素写入失败（${e instanceof Error ? e.message : String(e)}），已跳过`);
    }
  }
  slide.addText(summaryFooterOf(item, deck, pageLabel(deck, item), pageNo, total), {
    x: 0.5,
    y: SUMMARY_FOOTER_Y,
    w: 9,
    h: SUMMARY_FOOTER_H,
    fontSize: 9,
    color: PALETTE.brandDeep,
    align: 'right',
    wrap: false,
    fontFace: FONT.face,
  });
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 装配入口：DeckData + 已确认大纲 → .pptx Buffer。
 * 页数即大纲长度（S3 已校验 12~16 / 6+4N）；本层不再增删页。
 */
export async function buildSummaryPpt(
  deck: SummaryDeckData,
  outline: SummaryOutlineItem[],
  opts: SummaryBuildOptions = {},
): Promise<SummaryBuildResult> {
  const warnings: string[] = [];
  const paletteIssues = auditPalette();
  if (paletteIssues.length) warnings.push(`配色对比度不达标：${paletteIssues.join('；')}`);

  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout(SUMMARY_LAYOUT_DEF); // §6.3 门禁 0：独立版式名，不复用 KICKOFF
  pptx.layout = SUMMARY_LAYOUT_DEF.name;
  pptx.title = `${deck.projects.map((p) => p.name).join('、') || '全部项目'} ${deck.periodLabel}阶段总结`;
  pptx.author = 'MTask';
  pptx.company = deck.projects.map((p) => p.name).join('、');

  const degradedPages: number[] = [];
  let sectionNo = 0;
  for (let i = 0; i < outline.length; i++) {
    if (opts.signal?.aborted) throw new Error(SUMMARY_ABORT_MSG);
    const item = outline[i];
    const pageNo = i + 1;
    if (item.layout === 'section') sectionNo += 1;
    appendPage(pptx, deck, item, outline, pageNo, outline.length, sectionNo, warnings, degradedPages);
    opts.onPage?.(pageNo, item);
    await yieldToLoop();
  }

  if (opts.signal?.aborted) throw new Error(SUMMARY_ABORT_MSG);
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return { buffer: Buffer.from(out as unknown as ArrayBuffer), warnings, pageCount: outline.length, degradedPages };
}
