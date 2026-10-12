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
 *     四个调节系数的分项、σ 与置信区间、§6.1 备注三条、附加 sheet 名——不是渲染时涂黑。
 *     断言因此可以直接读 PDF 的文本层（pypdf 能取出嵌入子集字体的中文）。
 *  3. **数字只从 `layout.summary` 来**（同 §11.1 E6 红线 2）：本文件不重算 E、不重算人月换算，
 *     连「÷ 每人月工天标准」这句话里的除数都取 `layout.input.config.manDaysPerManMonth`，不写死 20.83。
 */
import { buildPrdPdf } from './prdExport';
import {
  TEMPLATE_PHASE_LABELS,
  TEMPLATE_REMARKS,
  TEMPLATE_TEXTS,
  type EstimateLayout,
} from './estimateExportXlsx';
import { ESTIMATE_COEF_LABELS } from './estimate-engine';
import type { EstimatePhase } from './EstimateService';

/** 件名（PDF 首页大标题，与 Excel 主 sheet 标题同源，§6.1 逐格表） */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function estimatePdfTitle(layout: EstimateLayout): string {
  return `${TEMPLATE_TEXTS.title}（${layout.input.audience === 'client' ? '客户版' : '内部版'}）`;
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
  const s = detail.replace(/\|/g, '/');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 阶段行标签：模板文案单源（`TEMPLATE_PHASE_LABELS`），面板标签不混进交付件 */
const phaseLabel = (p: EstimatePhase): string => TEMPLATE_PHASE_LABELS[p];

/**
 * `estimate-report.md`：§6.2 要求的中间文档（表格式汇总 + 阶段构成 + 置信区间说明 + 免责声明）。
 *
 * 抽成导出函数不是为了「先看看 Markdown」，而是**断言面**：PDF 是二进制、文字层依赖字体子集，
 * 把「哪一节对哪一受众出现」的判断放在 Markdown 这一层，可以逐字断言脱敏边界；
 * PDF 那一层再交叉验证「这份正文渲染出来的件里确实取得出/取不出这些词」。
 */
export function buildEstimateReportMd(layout: EstimateLayout): string {
  const { input, summary } = layout;
  const client = input.audience === 'client';
  const std = input.config.manDaysPerManMonth;
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);
  // 章节号按「实际出现的节」顺序自增，不写死：客户版少几节 / 阶段筛选把开发段筛空时，
  // 写死编号会跳号（一、二、五），件面看起来像漏了内容。
  let secNo = 0;
  const sec = (title: string) => push(`## ${CN_NUM[secNo++]}、${title}`);

  // ---- 基本信息（两版都给：这是件的抬头，不是内部依据）----
  push('| 项目 | 估算日期 | 估算人 | 生成时间 |');
  push('| --- | --- | --- | --- |');
  push(`| ${input.projectName} | ${input.estimateDate} | ${input.reviewer || '（待填写）'} | ${input.generatedAt.slice(0, 19).replace('T', ' ')} |`);
  push();
  push(`导出口径：范围 ${input.scope === 'estimated_only' ? '仅已估算行' : '全部计划行'}；`
    + `版本 ${client ? '客户版' : '内部版'}；`
    + `阶段 ${input.phases && input.phases.length > 0 ? input.phases.map(phaseLabel).join('、') : '全部六阶段'}。`);

  // ---- §6.3：待复核标注出现在首页，不放文末 ----
  if (layout.unreviewed > 0) {
    push();
    push(`> 注意：本次导出有 ${layout.unreviewed} 行为系统推导值，未人工复核。`);
  }

  // ---- 一、报价结论（两版同数：脱敏只藏依据，绝不改报价）----
  push();
  sec('报价结论');
  push();
  push('| 指标 | 数值 | 依据 |');
  push('| --- | --- | --- |');
  push(`| 直接投入人天 | ${num(summary.directManDays.expected)} | 三点加权 E=(O+4M+P)/6 求和 |`);
  push(`| 理想人月 | ${num(summary.idealManMonths.expected)} | 直接投入人天 ÷ 每人月工天标准 ${num(std)} |`);
  push(`| 实际预估人月 | ${num(summary.actualManMonths.expected)} | 理想人月 ×（1 + 综合调节系数 ${num(summary.coefSum)}） |`);

  // ---- 二、报价区间：内部版专属（§6.2 客户版隐藏 σ/置信区间）----
  if (!client) {
    push();
    sec('报价区间（内部依据）');
    push();
    push('| 口径 | 人天（直接投入，未含系数） | 人月（实际预估，含 Σ系数） |');
    push('| --- | --- | --- |');
    push(`| P50（中位） | ${num(summary.quote.p50ManDays)} | ${num(summary.quote.p50ManMonth)} |`);
    push(`| P84（对外报价口径，裁决 D2） | ${num(summary.quote.p84ManDays)} | ${num(summary.quote.p84ManMonth)} |`);
    push();
    push(`σ_total = ${num(summary.sigmaTotal)} 人天（独立假设，未计阶段间相关性）。`);
  }

  // ---- 阶段构成 ----
  push();
  sec('阶段构成');
  push();
  push('| 阶段 | 最小 | 最可能 | 最大 | 最终估算值（人天） | 占比 | 条目数 |');
  push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const p of summary.phases) {
    if (p.rowCount === 0) continue; // 本次筛选下该阶段无明细：空阶段不上件（写了 0 等于承诺「估过、结果是 0」）
    push(`| ${phaseLabel(p.phase)} | ${num(p.optimistic)} | ${num(p.likely)} | ${num(p.pessimistic)} | ${num(p.expected)} | ${pct(p.ratio)} | ${p.rowCount} |`);
  }
  push(`| 合计 | ${num(summary.directManDays.optimistic)} | ${num(summary.directManDays.likely)} | `
    + `${num(summary.directManDays.pessimistic)} | ${num(summary.directManDays.expected)} | — | ${summary.countedKeys.length} |`);

  // ---- 开发段明细 ----
  const devRows = layout.devRows;
  if (devRows.length > 0) {
    push();
    sec('开发段明细（预览）');
    push();
    push('| 中模块 | 小模块/功能单元 | 最可能 | 最终估算值 | 占比 |');
    push('| --- | --- | --- | --- | --- |');
    const ratioByKey = new Map(summary.rowRatios.map((r) => [r.key, r]));
    for (const d of devRows) {
      const r = ratioByKey.get(d.planId);
      push(`| ${previewDetail(d.milestone || '—', 20)} | ${previewDetail(d.detail)} | `
        + `${d.points ? num(d.points.likely) : '—'} | ${d.points ? num(r?.expected ?? null) : '未估算'} | ${r ? pct(r.ratio) : '—'} |`);
    }
    push();
    push(`明细正文在本件中做预览截断；完整正文${client ? '见 Excel 交付件' : '见 Excel 交付件的「估算明细（MTask）」sheet'}。`);
  }

  // ---- 调节系数：折叠态由 `layoutEstimate` 决定（fold 时只剩一行合计），本文件不再判一次 ----
  const coefs = layout.coefRows.filter((c) => c.label !== '');
  if (coefs.length > 0) {
    push();
    sec('调节系数');
    push();
    push('| 系数 | 值 | 占比 |');
    push('| --- | --- | --- |');
    for (const c of coefs) push(`| ${c.label} | ${num(c.value)} | ${pct(c.ratio)} |`);
  }

  // ---- 自检（内部版：§4.4 I40 自检 + §6.3 计数口径都是内部对账信息）----
  if (!client) {
    push();
    sec('自检与对账');
    push();
    const rc = summary.ratioCheck;
    push(`- 各阶段占比之和（I40）= ${pct(rc.sumRatio)}，偏差 ${num(rc.deviationPct)}%${rc.danger ? '（超过 1%，需复核阶段归集）' : ''}。`);
    push(`- 未计入合计的行：小计 ${rc.excluded.subtotal} 行、里程碑 ${rc.excluded.milestone} 行、未估算 ${rc.excluded.unEstimated} 行。`);
    push(`- 本次排除的里程碑行数（只做分组，不重复计）：${layout.milestoneSkipped}。`);
    push(`- 待人工复核行数（来源为规则/默认推导）：${layout.unreviewed}。`);
    if (rc.unassigned.length > 0) {
      push(`- 未归入阶段的行 ${rc.unassigned.length} 个：${rc.unassigned.slice(0, 5).map((u) => u.key).join('、')}`
        + `${rc.unassigned.length > 5 ? ' 等' : ''}。`);
    }
  }

  // ---- 备注三条：§6.1 明写客户版不写（其第 2 条本身就是「别把内部依据给客户」的指令）----
  if (!client) {
    push();
    sec('备注/说明');
    push();
    for (const r of TEMPLATE_REMARKS) push(`- ${r}`);
    push();
    push(`系数口径：${ESTIMATE_COEF_LABELS.collaboration} / ${ESTIMATE_COEF_LABELS.quality} / `
      + `${ESTIMATE_COEF_LABELS.scope} / ${ESTIMATE_COEF_LABELS.schedule}（取值见项目参数页）。`);
  }

  // ---- 免责声明（两版都给，§6.2 要求的四类内容之一）----
  push();
  sec('免责声明');
  push();
  push('- 本件为汇报/预览件，正式交付以 Excel《项目工作量估算表》为准（PRD 裁决 D4）。');
  push('- 本估算仅适用项目型工作量评估，不含产品/研发分摊与财务成本核算。');
  push('- 估算基于当前需求范围；范围或交付方式变更后需重新估算。');
  return lines.join('\n');
}

/** Markdown 中间文档 → PDF 字节（渲染链单源：`prdExport.buildPrdPdf`） */
export async function buildEstimatePdf(layout: EstimateLayout, md = buildEstimateReportMd(layout)): Promise<Buffer> {
  return await buildPrdPdf(md, estimatePdfTitle(layout));
}
