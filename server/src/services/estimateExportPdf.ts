/**
 * 估算工作量 PDF 导出（E7 · PRD-估算视图与工作量评估导出 §6.2）。
 *
 * 分层与 `estimateExportXlsx.ts` 一致：**纯计算模块**，输入 `EstimateLayout`（E6 的行落位 + 引擎汇总），
 * 输出 Markdown 中间文档与 PDF 字节。不碰 DB、不做路由编排——这样 PDF 与 Excel 读的是同一份
 * `layoutEstimate()` 结果，「预览件与交付件数字不一致」这件事在结构上就不可能发生。
 *
 * 三条来自 §6.2 的硬约束（改动前先重读）：
 *  1. **渲染链复用 `prdExport.buildPrdPdf`**：pdfkit 中文依赖系统黑体
 *     （`prdExport.ts:13` 的 `C:/Windows/Fonts/simhei.ttf`，`:147` 仅 win32 且文件存在才加载），
 *     非 Windows 或字体缺失时中文为方框。裁决 D4：PDF 仅预览、Excel 为正式交付，
 *     **不为 PDF 中文版式追加字体依赖**。
 *  2. **脱敏发生在 Markdown 组装阶段**（§9：前端隐藏不算脱敏）：客户版的正文里根本不出现
 *     四个调节系数的分项、σ 与置信区间、§6.1 备注四条、附加 sheet 名——不是渲染时涂黑。
 *     断言因此可以直接读 PDF 的文本层（pypdf 能取出嵌入子集字体的中文）。
 *  3. **数字只从 `layout.summary` 来**（同 §11.1 E6 红线 2）：本文件不重算 E、不重算人月换算，
 *     连「÷ 每人月工天标准」这句话里的除数都取 `layout.input.config.manDaysPerManMonth`，不写死 20.83。
 */
import { newPdfDoc, renderMdPdf, drawBarChart, drawParetoChart, drawTornadoChart } from './prdExport';
import {
  NAMED_RANGE_STD as NAMED_RANGE_STD_LABEL,
  TEMPLATE_COEF_LABELS,
  TEMPLATE_PHASE_LABELS,
  TEMPLATE_REMARKS,
  TEMPLATE_TEXTS,
  UNREVIEWED_PHRASE,
  type EstimateLayout,
} from './estimateExportXlsx';
import type { EstimatePhase } from './EstimateService';

/** 件名（PDF 首页大标题，与 Excel 主 sheet 标题同源，§6.1 逐格表） */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * PDF 交付件文案单源（T02293 规约判据 1）：正文在这里长出，门（`scripts/verify-t0204*`）也从这里取期望值。
 * 此前门在断言里抄第二份中文口径，改一次文案就打红一次与功能无关的红；
 * 现在文案变动只需改本表，门随同源移动，行为断言（位置/结构/数值）仍在门里独立成立。
 */
export const PDF_TEXTS = {
  audienceInternal: '内部版',
  audienceClient: '客户版',
  pendingReviewer: '（待填写）',
  scopeEstimatedOnly: '仅已估算行',
  scopeAll: '全部计划行',
  allPhases: '全部六阶段',
  secQuote: '报价结论',
  secRange: '报价区间（内部依据）',
  secPhases: '阶段构成',
  secDev: '开发段明细（预览）',
  secCoefs: '调节系数',
  secSelfCheck: '自检与对账',
  secRemarks: '备注/说明',
  secDisclaimer: '免责声明',
  unreviewedTail: UNREVIEWED_PHRASE,
  quoteDirect: '直接投入人天',
  quoteIdeal: '理想人月',
  quoteActual: '实际预估人月',
  exportScopeLead: '导出口径：范围',
  unEstimatedCell: '未估算',
  totalRow: '合计',
  disclaimerDelivery: '正式交付以 Excel',
} as const;

export function estimatePdfTitle(layout: EstimateLayout): string {
  return `${TEMPLATE_TEXTS.title}（${layout.input.audience === 'client' ? PDF_TEXTS.audienceClient : PDF_TEXTS.audienceInternal}）`;
}

/** 两位小数、去掉尾零（100.50 → 100.5）：报价件上 `0.23000000001` 这种写法只会引出对账疑问 */
function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return String(Number(v.toFixed(digits)));
}

/** I 列口径的比例（引擎给的是小数）→ 百分比文本 */
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * 明细正文的预览截断（仅 PDF）：pdfkit 的表格是「一行一条 `a | b` 文本」（`prdExport.ts:157-160`），
 * 500 字的 D 列正文会把一页吃满。Excel 交付件里是全文，这里明确写出「完整正文见 Excel」而不是装作没有。
 */
function previewDetail(detail: string, max = 46): string {
  const s = detail.replaceAll('|', '/');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 阶段行标签：模板文案单源（`TEMPLATE_PHASE_LABELS`），面板标签不混进交付件 */
const phaseLabel = (p: EstimatePhase): string => TEMPLATE_PHASE_LABELS[p];

/** 章节写入器：sec 出的编号按「实际出现的节」自增，计数器只能由组装函数一处持有 */
interface MdWriter {
  emit(text?: string): void;
  sec(title: string): void;
}

/** 基本信息（两版都给：这是件的抬头，不是内部依据） */
function appendBasicInfo(w: MdWriter, layout: EstimateLayout, client: boolean): void {
  const { input } = layout;
  w.emit('| 项目 | 估算日期 | 估算人 | 生成时间 |');
  w.emit('| --- | --- | --- | --- |');
  w.emit(`| ${input.projectName} | ${input.estimateDate} | ${input.reviewer || PDF_TEXTS.pendingReviewer} | ${input.generatedAt.slice(0, 19).replace('T', ' ')} |`);
  w.emit();
  w.emit(`${PDF_TEXTS.exportScopeLead} ${input.scope === 'estimated_only' ? PDF_TEXTS.scopeEstimatedOnly : PDF_TEXTS.scopeAll}；`
    + `版本 ${client ? PDF_TEXTS.audienceClient : PDF_TEXTS.audienceInternal}；`
    + `阶段 ${input.phases && input.phases.length > 0 ? input.phases.map(phaseLabel).join('、') : PDF_TEXTS.allPhases}。`);
  // §6.3：待复核标注出现在首页，不放文末
  if (layout.unreviewed > 0) {
    w.emit();
    w.emit(`> 注意：本次导出有 ${layout.unreviewed} ${PDF_TEXTS.unreviewedTail}。`);
  }
}

/** 报价结论（两版同数：脱敏只藏依据，绝不改报价）+ 报价区间（内部版专属，§6.2 客户版隐藏 σ/置信区间） */
function appendQuote(w: MdWriter, layout: EstimateLayout, client: boolean): void {
  const { input, summary } = layout;
  const std = input.config.manDaysPerManMonth;
  w.emit();
  w.sec(PDF_TEXTS.secQuote);
  w.emit();
  w.emit('| 指标 | 数值 | 依据 |');
  w.emit('| --- | --- | --- |');
  w.emit(`| ${PDF_TEXTS.quoteDirect} | ${num(summary.directManDays.expected)} | 三点加权 E=(O+4M+P)/6 求和 |`);
  w.emit(`| ${PDF_TEXTS.quoteIdeal} | ${num(summary.idealManMonths.expected)} | ${PDF_TEXTS.quoteDirect} ÷ ${NAMED_RANGE_STD_LABEL} ${num(std)} |`);
  w.emit(`| ${PDF_TEXTS.quoteActual} | ${num(summary.actualManMonths.expected)} | ${PDF_TEXTS.quoteIdeal} ×（1 + 综合调节系数 ${num(summary.coefSum)}） |`);
  if (client) return;
  w.emit();
  w.sec(PDF_TEXTS.secRange);
  w.emit();
  w.emit('| 口径 | 人天（直接投入，未含系数） | 人月（实际预估，含 Σ系数） |');
  w.emit('| --- | --- | --- |');
  w.emit(`| P50（中位） | ${num(summary.quote.p50ManDays)} | ${num(summary.quote.p50ManMonth)} |`);
  w.emit(`| P84（对外报价口径，裁决 D2） | ${num(summary.quote.p84ManDays)} | ${num(summary.quote.p84ManMonth)} |`);
  w.emit();
  w.emit(`σ_total = ${num(summary.sigmaTotal)} 人天（独立假设，未计阶段间相关性）。`);
}

/** 阶段构成 */
function appendPhases(w: MdWriter, layout: EstimateLayout): void {
  const { summary } = layout;
  w.emit();
  w.sec(PDF_TEXTS.secPhases);
  w.emit();
  w.emit('| 阶段 | 最小 | 最可能 | 最大 | 最终估算值（人天） | 占比 | 条目数 |');
  w.emit('| --- | --- | --- | --- | --- | --- | --- |');
  for (const p of summary.phases) {
    if (p.rowCount === 0) continue; // 本次筛选下该阶段无明细：空阶段不上件（写了 0 等于承诺「估过、结果是 0」）
    w.emit(`| ${phaseLabel(p.phase)} | ${num(p.optimistic)} | ${num(p.likely)} | ${num(p.pessimistic)} | ${num(p.expected)} | ${pct(p.ratio)} | ${p.rowCount} |`);
  }
  w.emit(`| ${PDF_TEXTS.totalRow} | ${num(summary.directManDays.optimistic)} | ${num(summary.directManDays.likely)} | `
    + `${num(summary.directManDays.pessimistic)} | ${num(summary.directManDays.expected)} | — | ${summary.countedKeys.length} |`);
}

/** 开发段明细（预览截断，全文见 Excel 交付件） */
function appendDevRows(w: MdWriter, layout: EstimateLayout, client: boolean): void {
  const devRows = layout.devRows;
  if (devRows.length === 0) return;
  const { summary } = layout;
  w.emit();
  w.sec(PDF_TEXTS.secDev);
  w.emit();
  w.emit('| 中模块 | 小模块/功能单元 | 最可能 | 最终估算值 | 占比 |');
  w.emit('| --- | --- | --- | --- | --- |');
  const ratioByKey = new Map(summary.rowRatios.map((r) => [r.key, r]));
  for (const d of devRows) {
    const r = ratioByKey.get(d.planId);
    w.emit(`| ${previewDetail(d.milestone || '—', 20)} | ${previewDetail(d.detail)} | `
      + `${d.points ? num(d.points.likely) : '—'} | ${d.points ? num(r?.expected ?? null) : PDF_TEXTS.unEstimatedCell} | ${r ? pct(r.ratio) : '—'} |`);
  }
  w.emit();
  w.emit(`明细正文在本件中做预览截断；完整正文${client ? '见 Excel 交付件' : '见 Excel 交付件的「估算明细（MTask）」sheet'}。`);
}

/** 调节系数：折叠态由 `layoutEstimate` 决定（fold 时只剩一行合计），本文件不再判一次 */
function appendCoefs(w: MdWriter, layout: EstimateLayout): void {
  const coefs = layout.coefRows.filter((c) => c.label !== '');
  if (coefs.length === 0) return;
  w.emit();
  w.sec(PDF_TEXTS.secCoefs);
  w.emit();
  w.emit('| 系数 | 值 | 占比 |');
  w.emit('| --- | --- | --- |');
  for (const c of coefs) w.emit(`| ${c.label} | ${num(c.value)} | ${pct(c.ratio)} |`);
}

/** 自检与对账（内部版：§4.4 I40 自检 + §6.3 计数口径都是内部对账信息） */
function appendSelfCheck(w: MdWriter, layout: EstimateLayout): void {
  const { summary } = layout;
  const rc = summary.ratioCheck;
  w.emit();
  w.sec(PDF_TEXTS.secSelfCheck);
  w.emit();
  w.emit(`- 各阶段占比之和（I40）= ${pct(rc.sumRatio)}，偏差 ${num(rc.deviationPct)}%${rc.danger ? '（超过 1%，需复核阶段归集）' : ''}。`);
  w.emit(`- 未计入合计的行：小计 ${rc.excluded.subtotal} 行、里程碑 ${rc.excluded.milestone} 行、未估算 ${rc.excluded.unEstimated} 行。`);
  w.emit(`- 本次排除的里程碑行数（只做分组，不重复计）：${layout.milestoneSkipped}。`);
  w.emit(`- 待人工复核行数（来源为规则/默认推导）：${layout.unreviewed}。`);
  if (rc.unassigned.length > 0) {
    w.emit(`- 未归入阶段的行 ${rc.unassigned.length} 个：${rc.unassigned.slice(0, 5).map((u) => u.key).join('、')}`
      + `${rc.unassigned.length > 5 ? ' 等' : ''}。`);
  }
}

/** 备注四条（T02084 起与原件逐字符一致）：§6.1 明写客户版不写（其第 2 条本身就是「别把内部依据给客户」的指令） */
function appendRemarks(w: MdWriter): void {
  w.emit();
  w.sec(PDF_TEXTS.secRemarks);
  w.emit();
  for (const r of TEMPLATE_REMARKS) w.emit(`- ${r}`);
  w.emit();
  // T02084：脚注与件内系数表同一套模板标签（带「系数」后缀）——同件里两个名字指同一行会读不通
  w.emit(`系数口径：${TEMPLATE_COEF_LABELS.collaboration} / ${TEMPLATE_COEF_LABELS.quality} / `
    + `${TEMPLATE_COEF_LABELS.scope} / ${TEMPLATE_COEF_LABELS.schedule}（取值见项目参数页）。`);
}

/** 免责声明（两版都给，§6.2 要求的四类内容之一） */
function appendDisclaimer(w: MdWriter): void {
  w.emit();
  w.sec(PDF_TEXTS.secDisclaimer);
  w.emit();
  w.emit(`- 本件为汇报/预览件，${PDF_TEXTS.disclaimerDelivery}《${TEMPLATE_TEXTS.title}》为准（PRD 裁决 D4）。`);
  w.emit('- 本估算仅适用项目型工作量评估，不含产品/研发分摊与财务成本核算。');
  w.emit('- 估算基于当前需求范围；范围或交付方式变更后需重新估算。');
}

/**
 * `estimate-report.md`：§6.2 要求的中间文档（表格式汇总 + 阶段构成 + 置信区间说明 + 免责声明）。
 *
 * 抽成导出函数不是为了「先看看 Markdown」，而是**断言面**：PDF 是二进制、文字层依赖字体子集，
 * 把「哪一节对哪一受众出现」的判断放在 Markdown 这一层，可以逐字断言脱敏边界；
 * PDF 那一层再交叉验证「这份正文渲染出来的件里确实取得出/取不出这些词」。
 *
 * 正文按节拆进 append* 局部函数（各自单独计认知复杂度），本函数只管节序与受众门控。
 */
export function buildEstimateReportMd(layout: EstimateLayout): string {
  const client = layout.input.audience === 'client';
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);
  // 章节号按「实际出现的节」顺序自增，不写死：客户版少几节 / 阶段筛选把开发段筛空时，
  // 写死编号会跳号（一、二、五），件面看起来像漏了内容。
  let secNo = 0;
  const sec = (title: string) => push(`## ${CN_NUM[secNo++]}、${title}`);
  const w: MdWriter = { emit: push, sec };

  appendBasicInfo(w, layout, client);
  appendQuote(w, layout, client);
  appendPhases(w, layout);
  appendDevRows(w, layout, client);
  appendCoefs(w, layout);
  if (!client) {
    appendSelfCheck(w, layout);
    appendRemarks(w);
  }
  appendDisclaimer(w);
  return lines.join('\n');
}

/**
 * 图表数据（T02155 图表补全）：与面板 E11/E14 同一口径，取数只从 `layout.summary` 来。
 *  - 帕累托：按行 E 降序、柱高按同批最大 E 归一、累计占比基数取全批之和；里程碑行不进图。
 *  - 龙卷风：按 σ 降序、条长按同批最大 σ 归一；σ 属内部依据，客户版不出此图（§6.2 脱敏四项之一）。
 * 页面上限：帕累托 12 柱、龙卷风 10 条——再密就读不出来了，且图必须整块落在一页内。
 */
const PARETO_TOP = 12;
const TORNADO_TOP = 10;

interface ChartData {
  phases: Array<{ label: string; value: number }>;
  phasePct: Array<{ label: string; value: number }>;
  pareto: Array<{ label: string; value: number; cumPct: number }>;
  tornado: Array<{ label: string; sigma: number; pct: number }>;
}

/** 行标题取计划标题，压到 16 字以内（图上标签位宽有限，长标题会挤成一团） */
function shortLabel(title: string): string {
  const s = (title || '').replaceAll(/\s+/g, ' ').trim();
  return s.length <= 16 ? s : `${s.slice(0, 15)}…`;
}

/**
 * 图表类别名：`summary.rowRatios` 的键有两种来源——计划行是 `planId`，非 dev 阶段的聚合行是
 * `phase:<阶段>`。后者不在 `titleByKey` 里，直接兜底原键会把内部标识画到图上（真实生产数据出件时，
 * 客户版帕累托第 4 柱写的是 `phase:common`）。阶段名走 `TEMPLATE_PHASE_LABELS` 单源，
 * 与「阶段构成」表同一套文案。
 */
function chartRowLabel(key: string, titleByKey: Map<string, string>): string {
  const phase = /^phase:(.+)$/.exec(key)?.[1];
  if (phase && phase in TEMPLATE_PHASE_LABELS) return TEMPLATE_PHASE_LABELS[phase as EstimatePhase];
  return titleByKey.get(key) ?? key;
}

function buildChartData(layout: EstimateLayout): ChartData {
  const { summary } = layout;
  const phases = summary.phases.filter((p) => p.rowCount > 0);
  const titleByKey = new Map(layout.input.rows.map((r) => [r.planId, r.title]));
  const milestoneIds = new Set(layout.input.rows.filter((r) => r.planKind === 'milestone').map((r) => r.planId));
  const valid = summary.rowRatios
    .filter((r) => !milestoneIds.has(r.key) && r.expected > 0)
    .sort((a, b) => b.expected - a.expected);
  const totalE = valid.reduce((s, r) => s + r.expected, 0);
  let cum = 0;
  const pareto = valid.slice(0, PARETO_TOP).map((r) => {
    cum += r.expected;
    return { label: shortLabel(chartRowLabel(r.key, titleByKey)), value: r.expected, cumPct: totalE > 0 ? (cum / totalE) * 100 : 0 };
  });
  const sig = summary.rowRatios
    .filter((r) => !milestoneIds.has(r.key) && r.sigma > 0)
    .sort((a, b) => b.sigma - a.sigma)
    .slice(0, TORNADO_TOP);
  const maxS = Math.max(...sig.map((r) => r.sigma), 1e-9);
  const tornado = sig.map((r) => ({
    label: shortLabel(chartRowLabel(r.key, titleByKey)),
    sigma: r.sigma,
    pct: (r.sigma / maxS) * 100,
  }));
  return {
    phases: phases.map((p) => ({ label: phaseLabel(p.phase), value: p.expected })),
    phasePct: phases.map((p) => ({ label: phaseLabel(p.phase), value: p.ratio * 100 })),
    pareto,
    tornado,
  };
}

/** Markdown 中间文档 → PDF 字节；在 MD 渲染后再追加图表（T02155 图表补全） */
export async function buildEstimatePdf(layout: EstimateLayout, md = buildEstimateReportMd(layout)): Promise<Buffer> {
  const client = layout.input.audience === 'client';
  const { doc, done, finish } = await newPdfDoc(estimatePdfTitle(layout));
  renderMdPdf(doc, md);
  const c = buildChartData(layout);
  if (c.phases.length > 0) {
    drawBarChart(doc, '各阶段最终估算值（人天）', c.phases);
    drawBarChart(doc, '各阶段占比（%）', c.phasePct);
  }
  if (c.pareto.length > 0) {
    drawParetoChart(doc, `帕累托（按行最终估算值降序 · 累计占比 · 前 ${c.pareto.length} 行）`, c.pareto);
  }
  // 客户版不含 σ（§6.2）：龙卷风图整体不画，连标题文字也不进文本层
  if (!client && c.tornado.length > 0) {
    drawTornadoChart(doc, `龙卷风（敏感性 σ 降序 · 人天 · 前 ${c.tornado.length} 行）`, c.tornado);
  }
  doc.end();
  await done;
  return finish();
}
