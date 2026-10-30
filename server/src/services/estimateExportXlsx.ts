/**
 * 估算工作量 Excel 导出（E6 · PRD-估算视图与工作量评估导出 §6.1）。
 *
 * **纯计算模块**：输入是明细行 + 已解析参数，输出是 xlsx 字节。不碰 DB、不做路由编排
 * （与 `prdExport.ts` / `testCaseExport.ts` 同分层），这样「行号怎么排」这件事只有一份实现，
 * 断言脚本可以直接 import 本文件的 `layoutEstimate()` 与渲染结果对账，而不是靠 HTTP 反推。
 *
 * 本文件的写法受 §11.1 五条 E6 实现红线约束（E0 Spike 实测得出，改动前逐条重读）：
 *  1. **公式串一律去前导 `=`**：exceljs 把 `value.formula` 原样落进 `<f>`，带 `=` 会得到
 *     `<f>=SUM(...)</f>` 这种非规范形态，两次独立读取结果不一致（一次算得出、一次 `#NAME?`）。
 *     去等号只发生在 `writeFormula()` 一处，渲染层不许各自拼。
 *  2. **缓存值只能来自估算引擎**：每个公式格的 `<v>` 都由 `estimate-engine` 的 `expected()`/
 *     `buildSummary()` 产出，禁止在此手填数字——只断言「有缓存值」会放行错数（E0 用故意写错的
 *     缓存值验证过：缓存轨过、Excel 重算轨才抓到偏差）。
 *  3. **openpyxl 只能读不能写**：它是断言侧的工具，`load→save` 会把公式格缓存值清空。本文件不依赖它。
 *  4. **从零构建，不复制客户模板**：exceljs 的 `readFile→writeFile` 往返会**丢掉常量型命名区域**
 *     （客户模板的 `每人月工天标准 => 20.83`），丢了这个名，H/I/R35/R40 全部 `#NAME?`。
 *  5. **命名区域的注释一起注入**：exceljs 的 `DefinedNamesXform.render` 只透传 `name`/`localSheetId`
 *     两个属性（读 `node_modules/exceljs/lib/xlsx/xform/book/defined-name-xform.js` 实测确认，
 *     **并不支持 PRD v1.3 所述的「属性透传」**），所以注释走写后补丁：`writeBuffer()` 完成后用
 *     PizZip 重写 `xl/workbook.xml`，把 `comment="…"` 补进 `<definedName>`。这段注释是 D1 取值
 *     20.83 的客户侧依据，导出件丢掉它，客户复核时就只剩一个孤零零的数。
 *
 * 结构与文案的权威来源是 §6.1 的逐格对齐表 + 附录 A（实测自客户模板），不是这里凭空写的样式。
 */
import { ESTIMATE_PHASES, type EstimatePhase } from './EstimateService';
import {
  ESTIMATE_COEF_KEYS,
  buildSummary,
  expected,
  sigma,
  type EstimateConfig,
  type EstimateEngineRow,
  type EstimateSummary,
} from './estimate-engine';

/** 主 sheet 名固定（§6.1）——客户拿到的文件名可以改，sheet 名不能改 */
export const SHEET_MAIN = '项目工作量估算表';
export const SHEET_DETAIL = '估算明细（MTask）';
export const SHEET_PARAMS = '参数';
/** 全表唯一命名区域：常量形态（不是单元格引用），公式里直接引用它 */
export const NAMED_RANGE_STD = '每人月工天标准';
/** 命名区域缺失错误文案单源（T02293 规约判据 1） */
export const NAMED_RANGE_MISSING_ERROR = '未在 workbook.xml 中找到';
/** 参数页行标签单源（门断言行存在性时同源取词） */
export const PARAM_SHEET_TEXTS = { conflictHint: '口径冲突提示', p84: '对外报价 P84 人天' } as const;
/** 「待人工复核」这句话的措辞单源：Excel 明细 sheet 注与 PDF 首页标注共用一条口径 */
export const UNREVIEWED_PHRASE = '行为系统推导值，未人工复核';
/** 聚合阶段行的「含 N 项」注记模板（B 列文案，门按同一模板拼期望值） */
export const AGG_NOTE = { lead: '（含 ', mid: ' 项，详见内部导出版）' } as const;
/** 明细 sheet 尾部注的引导词（计数走 UNREVIEWED_PHRASE 同一口径） */
export const DETAIL_NOTE_LEAD = '注：';

/** 命名区域注释里「240 工作日」那一小句（T02293 判据 1：门断言注释存在时取这一句，不再抄第二份） */
export const STD_WORKDAY_CLAUSE = '每人年平均预估约 240 工作日';
/** 命名区域原文注释（附录 A 实测自客户模板 `xl/workbook.xml`）——红线 5 */
export const NAMED_RANGE_STD_COMMENT =
  `去除法定休息日、节假日、年休假、日常基本培训和会议保障后，${STD_WORKDAY_CLAUSE}（即每月平均约 20 工作日），每工作日标准工作时间为 8 工时。`;

/** B 列阶段文案：**逐字符复制客户模板**（§6.1）。与面板用的 `ESTIMATE_META.phaseLabels` 是两套口径——
 *  模板文案给客户看、面板标签给内部看，混用会让导出件长出客户没见过的词 */
export const TEMPLATE_PHASE_LABELS: Record<EstimatePhase, string> = {
  req: '需求分析',
  design: '系统设计（概设&详设、数据库设计）',
  dev: '开发/研发（编码，单元测试，联调，评审等）',
  impl: '实施（含安装部署、调测、验收、投产变更、跟踪优化、收尾结项及合理范围的空耗等）',
  common: '公共&远程投入（如项目管理、质量管理、远程开发和技术支持、产品研发分摊等）',
  onsite: '现场维护（对于客户要求或我方拟计划项目交付后仍需安排人员现场驻员技术服务的）',
};

/** 系数行标签：**逐字符复制客户模板** B36~B39（T02084：模板带「系数」后缀，此前误用引擎短标签
 *  `ESTIMATE_COEF_LABELS`（无后缀，面板口径）——交付件与客户模板并排看会对不上名，遂按
 *  TEMPLATE_PHASE_LABELS 同款立一套模板侧标签；引擎标签保持不动（面板/内部用语另用） */
export const TEMPLATE_COEF_LABELS: Record<'collaboration' | 'quality' | 'scope' | 'schedule', string> = {
  collaboration: '客户协作配合/磨合调节系数',
  quality: '项目质量要求调节系数',
  scope: '项目范围/需求变更调节系数',
  schedule: '项目进度变更调节系数',
};

/** 表头与汇总行文案（§6.1 逐字符，含原文里那个「缺右括号」的全角拼写） */
export const TEMPLATE_TEXTS = {
  title: '项目工作量估算表',
  estimateDate: '估算日期',
  approver: '审批人',
  estimator: '估算人',
  projectName: '项目名称',
  taskBreakdown: '项目任务分解',
  resultHeader: '估算结果(单位：人天，1人天=8人时）',
  ratioHeader: '估算比例',
  colBig: '产品/子系统/大模块',
  colSmall: '小模块/功能单元/业务单元',
  likely: '最可能',
  min: '最小',
  max: '最大',
  final: '最终\n估算值',
  subtotal: '小计：',
  ideal: '项目总投入直接成本（单位：工作人月）最理想值：',
  actual: '项目总投入直接成本（单位：工作人月）实际预估值：',
  remarks: '备注/说明：',
  /** 客户版折叠四个系数时的合计行标签（§6.2 备注第 2 条要求的「屏蔽调节系数」形态） */
  foldedCoef: '综合调节系数（内部明细略）',
} as const;

/** R42 备注原文（内部版必带；客户版按 §6.1 不写）。
 *  T02084：客户模板原件已在场并**逐字符对齐**——原件 `C:\Users\hspcadmin\Desktop\工作量评估\阜新银行-票据系统优化-工作量评估V2.0.xlsx`
 *  的 B42（合并 B42:I42，`\n` 分隔的「备注/说明：」标签 + 四条正文）。⚠ 原文是**四条**不是三条：
 *  PRD 附录 A 的二手转述漏掉了第 4 条（人月/工天/工时换算），且前三条是改写不是原文（本轮已按原件订正）。
 *  含全角引号“”、全角等号＝等拼写，逐字符保留不「修正」。
 *  回归保护：`scripts/verify-t02043-estimate-e6.mts` G10 组从原件重新提取与本常量逐字符比对——
 *  期望值来自原件而非抄进断言的第二份口径。 */
export const TEMPLATE_REMARKS: readonly string[] = [
  '1.本表格仅适用项目型工作量评估，不含产品/研发分摊。实际报价时，产品价格/研发分摊/远程开发工作量评估也应另外算上。',
  '2.本报价单最好仅作为项目成本估算和最终提供给客户的按产品/业务/子系统/子项目综合报价的明细参考和内部依据，人月单价按公司当年度的实际人均成本费用参考和每年据实浮动调整，提供给客户的报价单非万不得已尽量不要直接使用本表格直接展现（若直接提交客户还应考虑是否需要屏蔽各调节系数，提交给客户的需删除/隐藏本备注说明章节内容），以引导客户及我们自己从关注成本到关注价值，引导和实现从成本定价转向价值定价。',
  '3.请估算人估算完后仔细检查一下第I列“估算比例”字段各阶段、各模块的工作量占比，根据经验看看是否在合理区间，并据经验和软件工程理论、客户特性要求（比如对某个环节、某个阶段、某个模块特别重视等）反过来适当调整原始估算值到恰当比例。',
  '4.按劳动合同法及国家规定的制度工作时间（261天-法定节假日11天=250天，每天法定工时8小时）要求，标准工作人月与标准工天、工时的换算标准为：1标准工作人月=20.83标准工作人天＝166.64人时。如实在需要提交客户并强制要求按客户另行标准进行评估提交的，请提交前更改调整“名称管理器”中的宏变量“每人月工天标准”，并删除/隐藏本备注说明章节内容。',
];

/** 列宽（附录 A 实测；D 列 63.125 是关键——长描述不折行成糊墙） */
export const TEMPLATE_COLUMN_WIDTHS: readonly number[] = [2, 6.5, 15.625, 63.125, 8.25, 8.375, 8.125, 6.5, 5.5];

/** 表头占 R1~R5，数据区从 R6 起（模板形态） */
export const FIRST_DATA_ROW = 6;

/** 汇总/实际/理想列（模板 D 列右侧的四段数值列） */
export type XlsxSumCol = 'E' | 'F' | 'G' | 'H';

export type EstimateAudience = 'internal' | 'client';
/** 三点（人天）。null 表示「该行还没有估算」——主 sheet 里留空而非写 0 */
interface Points {
  optimistic: number;
  likely: number;
  pessimistic: number;
}
export const ESTIMATE_EXPORT_SCOPES = ['all', 'estimated_only'] as const;
export type EstimateExportScope = (typeof ESTIMATE_EXPORT_SCOPES)[number];

/** 一条明细（route 侧从 `estimate_items` × `plan_tasks` 拼好，本文件不再查库） */
export interface EstimateExportRow {
  planId: string;
  /** 计划标题（附加 sheet 用，主 sheet 的 D 列用 `detail`） */
  title: string;
  /** D 列正文：`description || title`，换行已压平、超长已截断（§6.1 列映射表） */
  detail: string;
  phase: EstimatePhase;
  /** `plan_tasks.kind`：`milestone` 行只做 C 列分组，绝不作为明细行出现（§4.6 里程碑不重复计） */
  planKind: string;
  /** C 列（中模块）= 归属里程碑标题；空串 = 无 child 归属（留空不合并，§6.1） */
  milestone: string;
  optimistic: number | null;
  likely: number | null;
  pessimistic: number | null;
  /** `manual` / `rule` / `default` / `''`（无估算行） */
  source: string;
  complexity: number | null;
  reqNos: readonly string[];
}

export interface EstimateExportInput {
  projectId: string;
  projectName: string;
  /** 导出日 `YYYY-MM-DD`（D2） */
  estimateDate: string;
  /** 估算人（H2:I2）；无来源时留空由用户填写 */
  reviewer: string;
  rows: readonly EstimateExportRow[];
  config: EstimateConfig;
  scope: EstimateExportScope;
  /** 阶段筛选（§6.1 的 `phases` 参数）；缺省 = 全部六阶段 */
  phases?: readonly EstimatePhase[];
  audience: EstimateAudience;
  /** 生成时间（ISO，进快照与附加 sheet） */
  generatedAt: string;
}

export interface LayoutPhaseRow {
  kind: 'phase';
  rowNo: number;
  phase: EstimatePhase;
  label: string;
  /** null = 该阶段无已估算明细（E/F/G/H 留空，见 §6.1 实施校正「空估算行不写 0」） */
  points: Points | null;
  /** 聚合进该行的明细条数（>1 时 D 列加「含 N 项」注记） */
  mergedCount: number;
  source: string;
  /** 阶段行 I 列缓存值 = H/std/H40 */
  ratio: number;
}

export interface LayoutDevRow {
  kind: 'dev';
  rowNo: number;
  planId: string;
  milestone: string;
  detail: string;
  points: Points | null;
}

export interface LayoutSubtotalRow {
  kind: 'subtotal';
  rowNo: number;
}

export interface LayoutCoefRow {
  kind: 'coef';
  rowNo: number;
  label: string;
  value: number;
  expected: number;
  ratio: number;
}

export interface EstimateLayout {
  input: EstimateExportInput;
  phaseRows: LayoutPhaseRow[];
  devRows: LayoutDevRow[];
  subtotalRow: LayoutSubtotalRow | null;
  coefRows: LayoutCoefRow[];
  /** 数据区最后一行（小计行或最后一条明细）——R35 的 SUBTOTAL 区间上界 */
  lastDataRow: number;
  totalRow: number;
  actualRow: number;
  /** 备注行；客户版为 null（§6.1） */
  remarkRow: number | null;
  /** 进引擎的行（阶段行 + 开发明细行；小计行标 `subtotal` 由引擎排除） */
  engineRows: EstimateEngineRow[];
  summary: EstimateSummary;
  merges: string[];
  /** 有值但来源非人工（`rule`/`default`）的明细行数——§6.3「N 行为系统推导值，未人工复核」的计数 */
  unreviewed: number;
  /** 被排除出主 sheet 的里程碑行数（只做 C 列分组） */
  milestoneSkipped: number;
}

const COL = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9 } as const;
const ref = (col: keyof typeof COL, row: number): string => `${col}${row}`;
const isPoint = (r: EstimateExportRow): boolean =>
  r.optimistic !== null && r.likely !== null && r.pessimistic !== null;

/** D 列清洗（§6.1 列映射表）：换行压平、>500 字截断并标注出处 */
export function cleanDetail(description: string, title: string, reqNos: readonly string[] = []): string {
  const src = (description || title || '').replaceAll(/\r?\n/g, ' ').replaceAll(/\s+/g, ' ').trim();
  if (src.length <= 500) return src;
  const hint = reqNos.length > 0 ? `…（见需求 ${reqNos.join('、')}）` : '…（见需求原文）';
  return `${src.slice(0, 500)}${hint}`;
}

/** 三点求和（非 dev 阶段聚合成 1 行时用）；无任何已估算明细返回 null */
function sumPoints(rows: EstimateExportRow[]): Points | null {
  const withPts = rows.filter(isPoint);
  if (withPts.length === 0) return null;
  return {
    optimistic: withPts.reduce((a, r) => a + (r.optimistic as number), 0),
    likely: withPts.reduce((a, r) => a + (r.likely as number), 0),
    pessimistic: withPts.reduce((a, r) => a + (r.pessimistic as number), 0),
  };
}

/**
 * 行落位 + 汇总（§6.1「行结构还原」）。
 * 顺序恒为 `req → design → 开发明细… → 小计 → impl → common → onsite`，
 * 其后紧跟 R35 / 四条系数行 / R40 / 空行 / 备注行——**行号一律由本函数算**，
 * 渲染层与断言层共用同一个 `EstimateLayout`，不存在「渲染时再数一遍行」的第二套口径。
 */
export function layoutEstimate(input: EstimateExportInput): EstimateLayout {
  const wanted = input.phases && input.phases.length > 0 ? input.phases : ESTIMATE_PHASES;
  const phases = ESTIMATE_PHASES.filter((p) => wanted.includes(p));
  const devEnabled = phases.includes('dev');

  const pool = input.rows.filter((r) => r.planKind !== 'milestone' && phases.includes(r.phase));
  const milestoneSkipped = input.rows.filter((r) => r.planKind === 'milestone').length;
  const kept = input.scope === 'estimated_only' ? pool.filter(isPoint) : pool;

  const devAll = kept.filter((r) => r.phase === 'dev');
  // 未复核 = 有值且来源非人工（`rule` 与 `default` 都是机器推导值）：§5.2「只看未复核」与 §9 复核率
  // 用的都是 `source !== 'manual'`，件上标注只数 `default` 会让客户版少报一半待复核行。
  const unreviewed = kept.filter((r) => isPoint(r) && (r.source === 'rule' || r.source === 'default')).length;

  // 开发段：逐条明细行；非 dev 阶段：各聚合为 1 行（模板是阶段行，无明细）
  const before = new Map<EstimatePhase, EstimateExportRow[]>();
  const after = new Map<EstimatePhase, EstimateExportRow[]>();
  for (const p of phases) {
    if (p === 'dev') continue;
    const list = kept.filter((r) => r.phase === p);
    (p === 'req' || p === 'design' ? before : after).set(p, list);
  }

  const phaseRows: LayoutPhaseRow[] = [];
  const devRows: LayoutDevRow[] = [];
  let rowNo = FIRST_DATA_ROW;
  for (const p of ['req', 'design'] as EstimatePhase[]) {
    if (!phases.includes(p)) continue;
    const list = before.get(p) ?? [];
    phaseRows.push({
      kind: 'phase', rowNo: rowNo++, phase: p, label: TEMPLATE_PHASE_LABELS[p],
      points: sumPoints(list), mergedCount: list.length, source: mergeSource(list), ratio: 0,
    });
  }
  let subtotalRow: LayoutSubtotalRow | null = null;
  if (devEnabled) {
    for (const r of devAll) {
      devRows.push({
        kind: 'dev', rowNo: rowNo++, planId: r.planId, milestone: r.milestone,
        detail: r.detail, points: isPoint(r) ? { optimistic: r.optimistic as number, likely: r.likely as number, pessimistic: r.pessimistic as number } : null,
      });
    }
    // 模板形态：明细区末行是「小计：」行（`E31=SUBTOTAL(9,E8:E30)`），不是数据行
    if (devRows.length > 0) subtotalRow = { kind: 'subtotal', rowNo: rowNo++ };
  }
  for (const p of ['impl', 'common', 'onsite'] as EstimatePhase[]) {
    if (!phases.includes(p)) continue;
    const list = after.get(p) ?? [];
    phaseRows.push({
      kind: 'phase', rowNo: rowNo++, phase: p, label: TEMPLATE_PHASE_LABELS[p],
      points: sumPoints(list), mergedCount: list.length, source: mergeSource(list), ratio: 0,
    });
  }

  const lastDataRow = rowNo - 1;
  const totalRow = lastDataRow + 1;
  const coefRows: LayoutCoefRow[] = [];
  const fold = input.audience === 'client' && input.config.hideCoefsForClient;
  const coefSum = ESTIMATE_COEF_KEYS.reduce((a, k) => a + input.config.coefs[k], 0);
  // 客户版折叠：四个系数并成 1 行（值取 Σ系数）+ 3 行写 0 ——R40 的 `SUM(X36:X39)` 结果不变，
  // 报价数一分不差，但内部的分项依据不再出现在交付件里（§6.2 备注第 2 条要求的形态）
  const coefValues: Array<{ label: string; value: number }> = fold
    ? [{ label: TEMPLATE_TEXTS.foldedCoef, value: coefSum }, { label: '', value: 0 }, { label: '', value: 0 }, { label: '', value: 0 }]
    : ESTIMATE_COEF_KEYS.map((k) => ({ label: TEMPLATE_COEF_LABELS[k], value: input.config.coefs[k] })); // T02084：交付件用模板标签（带「系数」后缀），与面板的引擎短标签是两套口径
  let r = totalRow + 1;
  for (const c of coefValues) {
    coefRows.push({ kind: 'coef', rowNo: r++, label: c.label, value: c.value, expected: c.value, ratio: 0 });
  }
  const actualRow = r;
  const remarkRow = input.audience === 'client' ? null : actualRow + 2;

  // ---- 引擎出数（红线 2：缓存值只来自这里）----
  const engineRows: EstimateEngineRow[] = [];
  for (const p of phaseRows) {
    engineRows.push({ key: `phase:${p.phase}`, phase: p.phase, points: p.points, role: 'detail' });
  }
  for (const d of devRows) {
    engineRows.push({ key: d.planId, phase: 'dev', points: d.points, role: 'detail' });
  }
  if (subtotalRow) engineRows.push({ key: `subtotal:dev`, phase: 'dev', points: null, role: 'subtotal' });
  // T02304 口径甲：里程碑行照样喂进引擎并带 `planKind`——buildSummary 先按 planKind 判为结构性
  // 排除（不进 Σ、图里也被 milestoneIds 滤掉），所以报价数不变，但 §4.4 备注的「里程碑 M 行」
  // 从导出侧恒 0 变成与面板 excluded.milestone 同值。
  for (const m of input.rows.filter((r) => r.planKind === 'milestone')) {
    engineRows.push({
      key: m.planId, phase: m.phase,
      points: isPoint(m)
        ? { optimistic: m.optimistic as number, likely: m.likely as number, pessimistic: m.pessimistic as number }
        : null,
      role: 'detail', planKind: 'milestone',
    });
  }
  const summary = buildSummary(engineRows, input.config);

  const denom = summary.actualManMonths.expected;
  const phaseRatio = new Map(summary.phases.map((p) => [p.phase, p.ratio]));
  for (const p of phaseRows) p.ratio = phaseRatio.get(p.phase) ?? 0;
  for (const c of coefRows) c.ratio = denom === 0 ? 0 : (summary.idealManMonths.expected * c.value) / denom;

  return {
    input, phaseRows, devRows, subtotalRow, coefRows, lastDataRow, totalRow, actualRow, remarkRow,
    engineRows, summary, merges: layoutMerges({ phaseRows, devRows, subtotalRow, coefRows, totalRow, actualRow, remarkRow }),
    unreviewed, milestoneSkipped,
  };
}

/** 聚合行的来源标注：任一明细是 default 就整体标 default（复核口径宁可偏严，不能把未复核说成已复核） */
function mergeSource(list: EstimateExportRow[]): string {
  if (list.length === 0) return '';
  if (list.some((r) => r.source === 'default')) return 'default';
  if (list.some((r) => r.source === 'rule')) return 'rule';
  return 'manual';
}

interface MergeInput {
  phaseRows: LayoutPhaseRow[];
  devRows: LayoutDevRow[];
  subtotalRow: LayoutSubtotalRow | null;
  coefRows: LayoutCoefRow[];
  totalRow: number;
  actualRow: number;
  remarkRow: number | null;
}

/**
 * 合并区清单（§6.1 实测 28 处的结构版）。
 * 固定结构 22 处：表头 8（`B1:I1`/`H2:I2`/`B3:C3`/`D3:I3`/`B4:D4`/`E4:H4`/`I4:I5`/`B5:C5`）
 * + 阶段行 B:D 5 + 开发段 2（B 列纵向、I 列纵向）+ 汇总与系数 B:D 6 + 备注 1；
 * 变化的是 C 列模块合并数量与「阶段是否被筛掉/是否空数据」。
 * 备注：模板的 `B8:B31` 覆盖到小计行，`I8:I31` 同理——开发段的 B/I 纵向合并下界是**小计行**不是最后一条明细。
 */
export function layoutMerges(m: MergeInput): string[] {
  const out: string[] = ['B1:I1', 'H2:I2', 'B3:C3', 'D3:I3', 'B4:D4', 'E4:H4', 'I4:I5', 'B5:C5'];
  for (const p of m.phaseRows) out.push(`B${p.rowNo}:D${p.rowNo}`);
  if (m.devRows.length > 0) {
    const first = m.devRows[0].rowNo;
    const bottom = (m.subtotalRow ?? m.devRows.at(-1)!).rowNo;
    out.push(`B${first}:B${bottom}`, `I${first}:I${bottom}`);
    // C 列同模块连续行合并（模板 C8:C11 式）；无里程碑归属的行不合并
    let i = 0;
    while (i < m.devRows.length) {
      const title = m.devRows[i].milestone;
      let j = i;
      while (title && j + 1 < m.devRows.length && m.devRows[j + 1].milestone === title) j++;
      if (title && j > i) out.push(`C${m.devRows[i].rowNo}:C${m.devRows[j].rowNo}`);
      i = j + 1;
    }
  }
  for (const rowNo of [m.totalRow, ...m.coefRows.map((c) => c.rowNo), m.actualRow]) out.push(`B${rowNo}:D${rowNo}`);
  if (m.remarkRow) out.push(`B${m.remarkRow}:I${m.remarkRow}`);
  return out;
}

/**
 * 模板 H 列原式（§4.2：`=(MIN+MAX+4*((SUM-MIN-MAX)/(COUNTA-2)))/6`，列序 E=最可能、F=最小、G=最大）。
 * 与 `expected()` 在 O≤M≤P 下逐值相等（引擎里那个 `expectedByTemplateFormula` 就是这条等价断言的实现），
 * 客户改列序时导出件的行为跟着模板走，而不是跟着我们的标准式走（§12-R2）。
 */
export function templateHFormula(rowNo: number): string {
  const a = ref('E', rowNo);
  const b = ref('G', rowNo);
  const rng = `${a}:${b}`;
  return `(MIN(${rng})+MAX(${rng})+4*((SUM(${rng})-MIN(${rng})-MAX(${rng}))/(COUNTA(${rng})-2)))/6`;
}

/** I 列：明细/阶段行单行比例；开发段小计取 `H{subtotal}`（模板 `I8` 引用 `H31` 的那条例外） */
export function templateIRowFormula(rowNo: number, actualRow: number): string {
  return `IFERROR(H${rowNo}/${NAMED_RANGE_STD}/$H$${actualRow},"")`;
}
export function templateICoefFormula(coefRowNo: number, totalRow: number, actualRow: number): string {
  return `IFERROR($H$${totalRow}*H${coefRowNo}/$H$${actualRow},"")`;
}
export function templateTotalFormula(col: XlsxSumCol, firstDataRow: number, lastDataRow: number): string {
  return `SUBTOTAL(9,${col}${firstDataRow}:${col}${lastDataRow})/${NAMED_RANGE_STD}`;
}
export function templateActualFormula(col: XlsxSumCol, totalRow: number, coefFirst: number, coefLast: number): string {
  return `${col}${totalRow}*(1+SUM(${col}${coefFirst}:${col}${coefLast}))`;
}

// ---------- 渲染 ----------

interface FormulaCell {
  formula: string;
  result: number;
}

/** 红线 1 的唯一收口处：全文件只有这一个函数写公式格 */
function formulaCell(cell: import('exceljs').Cell, f: FormulaCell): void {
  cell.value = { formula: f.formula.replace(/^=/, ''), result: f.result } as never;
}

const num = (cell: import('exceljs').Cell, v: number | null): void => {
  if (v === null || !Number.isFinite(v)) return;
  cell.value = v;
};

/**
 * 产出 xlsx 字节。
 * ⚠ 命名区域的注入点：`Object.defineProperty(wb.definedNames, 'model', { get })`——
 * exceljs 的原生 `definedNames.add(loc, name)` 只认区域型地址，常量形态（`=20.83`）无法表达（E0 实测）。
 * 覆盖 getter 只影响写侧出模型，不改 node_modules。
 */
export async function buildEstimateXlsx(layout: EstimateLayout): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const { input } = layout;
  const std = input.config.manDaysPerManMonth;

  // 红线 5：常量命名区域 + 原文注释（注释由 exceljs 之外的写后补丁补，见 attachDefinedNameComment）
  Object.defineProperty(wb.definedNames, 'model', {
    configurable: true,
    get: () => [{ name: NAMED_RANGE_STD, ranges: [String(std)] }],
  });
  // 打开即重算：预览类查看器读缓存值，真正的 Excel 会重算并覆盖成同源结果（§12-R8 的加固）
  wb.calcProperties.fullCalcOnLoad = true;

  const ws = wb.addWorksheet(SHEET_MAIN);
  TEMPLATE_COLUMN_WIDTHS.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  // ---- 表头 R1~R5 ----
  ws.getCell('B1').value = TEMPLATE_TEXTS.title;
  ws.getCell('B1').font = { bold: true, size: 14 };
  ws.getCell('B1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('C2').value = TEMPLATE_TEXTS.estimateDate;
  ws.getCell('D2').value = input.estimateDate;
  ws.getCell('E2').value = TEMPLATE_TEXTS.approver;
  ws.getCell('F2').value = '';
  ws.getCell('G2').value = TEMPLATE_TEXTS.estimator;
  ws.getCell('H2').value = input.reviewer;
  ws.getCell('B3').value = TEMPLATE_TEXTS.projectName;
  ws.getCell('D3').value = input.projectName;
  ws.getCell('B4').value = TEMPLATE_TEXTS.taskBreakdown;
  ws.getCell('E4').value = TEMPLATE_TEXTS.resultHeader;
  ws.getCell('I4').value = TEMPLATE_TEXTS.ratioHeader;
  ws.getCell('B5').value = TEMPLATE_TEXTS.colBig;
  ws.getCell('D5').value = TEMPLATE_TEXTS.colSmall;
  ws.getCell('E5').value = TEMPLATE_TEXTS.likely;
  ws.getCell('F5').value = TEMPLATE_TEXTS.min;
  ws.getCell('G5').value = TEMPLATE_TEXTS.max;
  ws.getCell('H5').value = TEMPLATE_TEXTS.final;
  for (const a of ['B4', 'E4', 'I4', 'B5', 'D5', 'E5', 'F5', 'G5', 'H5']) {
    ws.getCell(a).font = { bold: true };
    ws.getCell(a).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  }

  const head = (rowNo: number, label: string) => {
    ws.getCell(`B${rowNo}`).value = label;
    ws.getCell(`B${rowNo}`).alignment = { wrapText: true, vertical: 'middle' };
  };

  // ---- 阶段行（req/design/impl/common/onsite）----
  for (const p of layout.phaseRows) {
    head(p.rowNo, p.mergedCount > 1 ? `${p.label}${AGG_NOTE.lead}${p.mergedCount}${AGG_NOTE.mid}` : p.label);
    if (!p.points) continue; // 空数据阶段：E/F/G/H/I 全留空，不写 0
    num(ws.getCell(`E${p.rowNo}`), p.points.likely);
    num(ws.getCell(`F${p.rowNo}`), p.points.optimistic);
    num(ws.getCell(`G${p.rowNo}`), p.points.pessimistic);
    formulaCell(ws.getCell(`H${p.rowNo}`), { formula: templateHFormula(p.rowNo), result: expected(p.points) });
    formulaCell(ws.getCell(`I${p.rowNo}`), { formula: templateIRowFormula(p.rowNo, layout.actualRow), result: p.ratio });
  }

  // ---- 开发段明细行 ----
  if (layout.devRows.length > 0) {
    head(layout.devRows[0].rowNo, TEMPLATE_PHASE_LABELS.dev);
  }
  for (const d of layout.devRows) {
    ws.getCell(`C${d.rowNo}`).value = d.milestone;
    ws.getCell(`D${d.rowNo}`).value = d.detail;
    ws.getCell(`D${d.rowNo}`).alignment = { wrapText: false, vertical: 'middle' };
    if (!d.points) continue;
    num(ws.getCell(`E${d.rowNo}`), d.points.likely);
    num(ws.getCell(`F${d.rowNo}`), d.points.optimistic);
    num(ws.getCell(`G${d.rowNo}`), d.points.pessimistic);
    formulaCell(ws.getCell(`H${d.rowNo}`), { formula: templateHFormula(d.rowNo), result: expected(d.points) });
  }

  // ---- 小计行 R31 形态：E..H 各一条 SUBTOTAL，I 列在合并首格写整体比例 ----
  if (layout.subtotalRow) {
    const s = layout.subtotalRow.rowNo;
    const first = layout.devRows[0].rowNo;
    const last = layout.devRows.at(-1)!.rowNo;
    ws.getCell(`D${s}`).value = TEMPLATE_TEXTS.subtotal;
    const dev = layout.summary.phases.find((p) => p.phase === 'dev');
    const cols: Array<[XlsxSumCol, number]> = [
      ['E', dev ? dev.likely : 0],
      ['F', dev ? dev.optimistic : 0],
      ['G', dev ? dev.pessimistic : 0],
      ['H', dev ? dev.expected : 0],
    ];
    for (const [col, result] of cols) {
      const cell = ws.getCell(`${col}${s}`);
      // 小计区间是「明细行自身」（模板 `E31=SUBTOTAL(9,E8:E30)`），不含本行
      formulaCell(cell, { formula: `SUBTOTAL(9,${col}${first}:${col}${last})`, result });
    }
    formulaCell(ws.getCell(`I${first}`), {
      formula: `IFERROR(H${s}/${NAMED_RANGE_STD}/$H$${layout.actualRow},"")`,
      result: dev ? dev.ratio : 0,
    });
  }

  // ---- R35 最理想值 ----
  ws.getCell(`B${layout.totalRow}`).value = TEMPLATE_TEXTS.ideal;
  ws.getCell(`B${layout.totalRow}`).font = { bold: true };
  ws.getCell(`B${layout.totalRow}`).alignment = { wrapText: true, vertical: 'middle' };
  const ideal: Array<[XlsxSumCol, number]> = [
    ['E', layout.summary.idealManMonths.likely],
    ['F', layout.summary.idealManMonths.optimistic],
    ['G', layout.summary.idealManMonths.pessimistic],
    ['H', layout.summary.idealManMonths.expected],
  ];
  for (const [col, result] of ideal) {
    formulaCell(ws.getCell(`${col}${layout.totalRow}`), {
      formula: templateTotalFormula(col, FIRST_DATA_ROW, layout.lastDataRow),
      result,
    });
  }
  const i35 = layout.summary.phases.reduce((a, p) => a + p.ratio, 0);
  formulaCell(ws.getCell(`I${layout.totalRow}`), {
    formula: `SUBTOTAL(9,I${FIRST_DATA_ROW}:I${layout.lastDataRow})`,
    result: i35,
  });

  // ---- 系数行 R36~R39 ----
  for (const c of layout.coefRows) {
    if (c.label) {
      ws.getCell(`B${c.rowNo}`).value = c.label;
      ws.getCell(`B${c.rowNo}`).alignment = { wrapText: true, vertical: 'middle' };
    }
    for (const col of ['E', 'F', 'G'] as const) num(ws.getCell(`${col}${c.rowNo}`), c.value);
    // 模板把系数行也当三点行处理（E=F=G=系数），H 仍是原式；只写 E 列会让 H36~H39 空、R40 求和失真
    formulaCell(ws.getCell(`H${c.rowNo}`), { formula: templateHFormula(c.rowNo), result: c.expected });
    formulaCell(ws.getCell(`I${c.rowNo}`), {
      formula: templateICoefFormula(c.rowNo, layout.totalRow, layout.actualRow),
      result: c.ratio,
    });
  }

  // ---- R40 实际预估值 ----
  ws.getCell(`B${layout.actualRow}`).value = TEMPLATE_TEXTS.actual;
  ws.getCell(`B${layout.actualRow}`).font = { bold: true };
  ws.getCell(`B${layout.actualRow}`).alignment = { wrapText: true, vertical: 'middle' };
  const coefFirst = layout.coefRows[0].rowNo;
  const coefLast = layout.coefRows.at(-1)!.rowNo;
  const actualCols: Array<[XlsxSumCol, number]> = [
    ['E', layout.summary.actualManMonths.likely],
    ['F', layout.summary.actualManMonths.optimistic],
    ['G', layout.summary.actualManMonths.pessimistic],
    ['H', layout.summary.actualManMonths.expected],
  ];
  for (const [col, result] of actualCols) {
    formulaCell(ws.getCell(`${col}${layout.actualRow}`), {
      formula: templateActualFormula(col, layout.totalRow, coefFirst, coefLast),
      result,
    });
  }
  // 自检格（模板 I40）不用模板原式 `SUBTOTAL(9,I35:I39)`：Excel 16.0 实测（T02047 ③轨）只算出 0.187——
  // I35 自身是嵌套 SUBTOTAL，会被同区间求和排除，而备注第 3 条要求这一格就是「I 列比例之和 = 100%」。
  formulaCell(ws.getCell(`I${layout.actualRow}`), {
    formula: `SUM(I${layout.totalRow}:I${coefLast})`,
    result: i35 + layout.coefRows.reduce((a, c) => a + c.ratio, 0),
  });

  // ---- 备注（客户版不写，§6.1）----
  if (layout.remarkRow) {
    const cell = ws.getCell(`B${layout.remarkRow}`);
    cell.value = `${TEMPLATE_TEXTS.remarks}\n${TEMPLATE_REMARKS.join('\n')}`;
    cell.alignment = { wrapText: true, vertical: 'top' };
    cell.font = { size: 9 };
  }

  // ---- 合并区 + 边框 ----
  for (const range of layout.merges) ws.mergeCells(range);
  for (let rowNo = FIRST_DATA_ROW; rowNo <= layout.actualRow; rowNo++) {
    for (const col of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const) {
      ws.getCell(`${col}${rowNo}`).border = {
        top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' },
      };
    }
  }
  ws.getRow(1).height = 24;
  ws.getRow(5).height = 30;

  // ---- 附加 sheet（客户版不产出，§6.2「隐藏内部 sheet 引用」）----
  if (input.audience === 'internal') {
    addDetailSheet(wb, layout);
    addParamsSheet(wb, layout);
  }

  const raw = await wb.xlsx.writeBuffer();
  return attachDefinedNameComment(Buffer.from(raw as ArrayBuffer), NAMED_RANGE_STD, NAMED_RANGE_STD_COMMENT);
}

/**
 * 红线 5 的写后补丁：把命名区域的原文注释补进 `xl/workbook.xml`。
 * exceljs 的 `DefinedNamesXform.render` 只写 `name`/`localSheetId` 两个属性，注释无处安放；
 * PizZip 只重写这一个 entry，其余条目原样保留（docxtemplater 在本仓已趟过同一条通道）。
 */
export async function attachDefinedNameComment(buf: Buffer, name: string, comment: string): Promise<Buffer> {
  const PizZip = (await import('pizzip')).default;
  const zip = new PizZip(buf as unknown as ArrayBuffer);
  const entry = zip.file('xl/workbook.xml');
  if (!entry) throw new Error('导出件缺少 xl/workbook.xml（不应发生）');
  const xml = entry.asText();
  const patched = injectComment(xml, name, comment);
  if (patched === xml) throw new Error(`命名区域「${name}」${NAMED_RANGE_MISSING_ERROR}，注释注入失败`);
  zip.file('xl/workbook.xml', patched);
  return zip.generate({ type: 'nodebuffer' }) as unknown as Buffer;
}

/** 纯字符串注入（单独拆出来是为了能被断言脚本直接测，不必真跑一遍 exceljs） */
export function injectComment(xml: string, name: string, comment: string): string {
  const tag = `<definedName name="${escapeAttr(name)}">`;
  const open = xml.indexOf(tag);
  if (open < 0) return xml;
  const withComment = `<definedName name="${escapeAttr(name)}" comment="${escapeAttr(comment)}">`;
  return xml.slice(0, open) + withComment + xml.slice(open + tag.length);
}

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** 附加 sheet ①：全量明细（内部复核用，客户版不产出） */
function addDetailSheet(wb: import('exceljs').Workbook, layout: EstimateLayout): void {
  const ws = wb.addWorksheet(SHEET_DETAIL);
  ws.columns = [
    { header: '需求编号', key: 'reqNo', width: 14 },
    { header: '阶段', key: 'phase', width: 10 },
    { header: '中模块', key: 'milestone', width: 22 },
    { header: '功能点描述', key: 'detail', width: 60 },
    { header: '计划标题', key: 'title', width: 34 },
    { header: '最小 O', key: 'o', width: 9 },
    { header: '最可能 M', key: 'm', width: 10 },
    { header: '最大 P', key: 'p', width: 9 },
    { header: '期望值 E', key: 'e', width: 10 },
    { header: '标准差 σ', key: 'sigma', width: 10 },
    { header: '来源', key: 'source', width: 10 },
    { header: '复杂度', key: 'complexity', width: 8 },
    { header: 'plan_id', key: 'planId', width: 38 },
  ];
  ws.getRow(1).font = { bold: true };
  // 逐行给全（含主 sheet 里被聚合成阶段行的非 dev 明细），供内部对账
  for (const r of layout.input.rows) {
    if (r.planKind === 'milestone') continue;
    const pts = isPoint(r)
      ? { optimistic: r.optimistic as number, likely: r.likely as number, pessimistic: r.pessimistic as number }
      : null;
    ws.addRow({
      reqNo: r.reqNos.join('、'),
      phase: r.phase,
      milestone: r.milestone,
      detail: r.detail,
      title: r.title,
      o: r.optimistic, m: r.likely, p: r.pessimistic,
      e: pts ? round6(expected(pts)) : null,
      sigma: pts ? round6(sigma(pts)) : null,
      source: r.source, complexity: r.complexity, planId: r.planId,
    });
  }
  const tail = ws.addRow({ detail: `生成时间：${layout.input.generatedAt}` });
  tail.font = { italic: true };
  if (layout.unreviewed > 0) {
    ws.addRow({ detail: `${DETAIL_NOTE_LEAD}${layout.unreviewed} ${UNREVIEWED_PHRASE}` }).font = { italic: true };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/** 附加 sheet ②：换算参数与系数（含 §3.3-D1 的「20 vs 20.83」口径冲突提示） */
function addParamsSheet(wb: import('exceljs').Workbook, layout: EstimateLayout): void {
  const ws = wb.addWorksheet(SHEET_PARAMS);
  ws.columns = [
    { header: '参数', key: 'k', width: 34 },
    { header: '取值', key: 'v', width: 16 },
    { header: '说明', key: 'd', width: 76 },
  ];
  ws.getRow(1).font = { bold: true };
  const cfg = layout.input.config;
  ws.addRow({ k: NAMED_RANGE_STD, v: cfg.manDaysPerManMonth, d: `命名区域常量，公式直接引用它。${NAMED_RANGE_STD_COMMENT}` });
  ws.addRow({ k: PARAM_SHEET_TEXTS.conflictHint, v: '', d: '客户模板正文另处按 20 工作日/月描述，取值却是 20.83（=250/12）；裁决 D1 采 20.83，改值需在参数页显式操作并留痕。' });
  ws.addRow({ k: '每工作日工时', v: cfg.hoursPerManDay, d: '模板 E4 文案：1 人天 = 8 人时' });
  for (const c of layout.coefRows) ws.addRow({ k: `调节系数 ${c.label || '（折叠）'}`, v: c.value, d: '模板 R36~R39 按三点行处理：E=F=G=系数' });
  ws.addRow({ k: 'Σ调节系数', v: round6(layout.summary.coefSum), d: 'R40 = R35 × (1 + Σ系数)' });
  ws.addRow({ k: '直接投入人天 ΣE', v: round6(layout.summary.directManDays.expected), d: '不含小计行与里程碑行（§4.4）' });
  ws.addRow({ k: '实际预估人月 ΣE', v: round6(layout.summary.actualManMonths.expected), d: '对应导出件 R40 的 H 列' });
  ws.addRow({ k: PARAM_SHEET_TEXTS.p84, v: round6(layout.summary.quote.p84ManDays), d: 'E + 1σ（裁决 D2；未计行间相关性）' });
  ws.addRow({ k: '导出范围', v: layout.input.scope, d: `阶段筛选：${(layout.input.phases ?? ESTIMATE_PHASES).join(',')}｜版本：${layout.input.audience}` });
  ws.addRow({ k: '生成时间', v: layout.input.generatedAt, d: '' });
  ws.getRow(2).font = { color: { argb: 'B42318' } };
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
