/**
 * 估算引擎（E2 · PRD-估算视图与工作量评估导出 §4）。
 *
 * **纯计算模块**：不碰数据库、不读配置、不发请求——输入是三点行 + 一份已解析好的参数，
 * 输出是汇总结果。这样 E3（REST）、E4（面板）、E6（Excel 导出）三个消费者拿到的是同一套数，
 * 而不是各自再算一遍（§9 可维护项；T01621 planDeps 双口径的教训是「同语义必须只有一份实现」）。
 * §9 原文把引擎位置写成 `web/src/util/estimate-engine.ts`，按 E2 实施校正到服务端单源：
 * `server/tsconfig.json` 有 `rootDir: "src"`、web 只 include `src`，两侧都没有跨包 alias，
 * 让 web 持有唯一实现会让服务端（E6 导出的缓存值只能来自引擎输出，§11.1 红线 2）无法复用；
 * 因此前端经 E3 的汇总接口取数展示，不重写公式。
 *
 * 三条容易写错、写错了直接进报价的口径（都有实测依据，改动前请先读 PRD 对应小节）：
 *  1. **期望值是标准 PERT**（§4.2）：`(O + 4M + P)/6`，与客户模板 `=(MIN+MAX+4*中值)/6` 在
 *     `COUNTA=3` 下逐值相等（模板列序 E=最可能 M、F=最小 O、G=最大 P，靠 MIN/MAX 自动定位极值）；
 *  2. **求和必须排除小计行与里程碑行**（§4.4 / §4.6）：模板 R31 是 `SUBTOTAL(9,X8:X30)`，
 *     落在 R35 的求和区间 `X6:X34` 内，Excel 靠「SUBTOTAL 忽略嵌套 SUBTOTAL」不重复计；
 *     里程碑行是其明细的包络，`complexity` 推导值同样会重复计——两者一律不进 Σ；
 *  3. **比例自检 I40 恒等于 1 的前提是「每行都归入了阶段」**（§4.4）：
 *     `I35 = 1/(1+Σ系数)`、系数行 `I_r = 系数/(1+Σ系数)`，所以偏差 >1% 只可能是四舍五入或
 *     存在未归入阶段的行——面板据此告警并列出具体行，而不是只显示一个不等于 100% 的数。
 */
import { ESTIMATE_PHASES, isClosedMilestone, type EstimatePhase } from './EstimateService';
import { ESTIMATE_ERRORS } from './estimateCopy';
import { addWorkdays, countWorkdaysBetween, type WorkdayCal } from '../util/workdays';

/** 三点（人天，输入精度 0.5，§4.1） */
export interface ThreePoints {
  optimistic: number;
  likely: number;
  pessimistic: number;
}

/** 行角色：`detail`=明细行、`phase`=阶段汇总行（模板 R6/R7/R32~R34）、`subtotal`=小计行（模板 R31，不进 Σ）、`coef`=调节系数行（模板 R36~R39） */
export type EstimateRowRole = 'detail' | 'phase' | 'subtotal' | 'coef';

/** 引擎输入行（E3 从 `estimate_items` + `plan_tasks` 左联结果映射而来） */
export interface EstimateEngineRow {
  /** 面板/导出定位用行标识（一般是 planId；小计行可用 `subtotal:<phase>`） */
  key: string;
  /** 阶段——允许传非枚举值，引擎不抛错而是把它计入 `unassigned` 供面板定位（§4.4 自检口径） */
  phase: string;
  /** null=未估算（不参与 Σ，也不进比例） */
  points: ThreePoints | null;
  role?: EstimateRowRole;
  /** `plan_tasks.kind`：milestone 行不进 Σ（§4.6 里程碑不重复计） */
  planKind?: string;
}

/** §3.3 配置键（**单源**：E3 读写 `app_settings`、E13 参数 UI 都用这张表，键名散落两处必然漂移） */
export const ESTIMATE_SETTING_KEYS = {
  manDaysPerManMonth: 'estimate.manDaysPerManMonth',
  hoursPerManDay: 'estimate.hoursPerManDay',
  coefCollaboration: 'estimate.coef.collaboration',
  coefQuality: 'estimate.coef.quality',
  coefScope: 'estimate.coef.scope',
  coefSchedule: 'estimate.coef.schedule',
  ruleDefaultRatio: 'estimate.rule.default.ratio',
  hideCoefsForClient: 'estimate.hideCoefsForClient',
} as const;

/** 四个调节系数（模板 R36~R39 顺序与标签，导出与面板共用） */
export const ESTIMATE_COEF_KEYS = ['collaboration', 'quality', 'scope', 'schedule'] as const;
export type EstimateCoefKey = (typeof ESTIMATE_COEF_KEYS)[number];
export const ESTIMATE_COEF_LABELS: Record<EstimateCoefKey, string> = {
  collaboration: '客户协作配合/磨合调节',
  quality: '项目质量要求调节',
  scope: '项目范围/需求变更调节',
  schedule: '项目进度变更调节',
};

/** 系数 → 配置键（显式表，避免模板字符串拼键名时打错到别的 KV 上） */
export const ESTIMATE_COEF_SETTING_KEYS: Record<EstimateCoefKey, string> = {
  collaboration: ESTIMATE_SETTING_KEYS.coefCollaboration,
  quality: ESTIMATE_SETTING_KEYS.coefQuality,
  scope: ESTIMATE_SETTING_KEYS.coefScope,
  schedule: ESTIMATE_SETTING_KEYS.coefSchedule,
};

/**
 * §3.3 八键的中文标签（单源：文案取自 PRD §3.3 的「含义」列）。
 * 四个系数键的标签**不在这里重写**，从 `ESTIMATE_COEF_LABELS` 派生——同一条红线：
 * 「E13 参数页不得再抄一份」（§9 可维护行）。系数标签若在前端出现第二次，
 * 改标签就会变成只改一处的 bug。
 */
export const ESTIMATE_SETTING_LABELS: Record<string, string> = {
  [ESTIMATE_SETTING_KEYS.manDaysPerManMonth]: '每人月工天标准',
  [ESTIMATE_SETTING_KEYS.hoursPerManDay]: '1 人天 = 几人时',
  [ESTIMATE_SETTING_KEYS.ruleDefaultRatio]: '规则推导的 O:M:P 比例',
  [ESTIMATE_SETTING_KEYS.hideCoefsForClient]: '客户版隐藏系数分项与备注',
  ...Object.fromEntries(
    ESTIMATE_COEF_KEYS.map((k) => [ESTIMATE_COEF_SETTING_KEYS[k], ESTIMATE_COEF_LABELS[k]]),
  ),
};

/**
 * §3.3 八键的 UI 类型（单源：与 `ESTIMATE_SETTING_LABELS` 同一条「前端不抄名单」红线）。
 * 数字键走 number 输入、布尔键走勾选、`ruleDefaultRatio` 是「O:4:P」文本串走 text 输入。
 * 面板只按这个表决定怎么渲染，不知道任何具体键名。
 */
export const ESTIMATE_SETTING_TYPES: Record<string, 'number' | 'boolean' | 'text'> = {
  [ESTIMATE_SETTING_KEYS.manDaysPerManMonth]: 'number',
  [ESTIMATE_SETTING_KEYS.hoursPerManDay]: 'number',
  [ESTIMATE_SETTING_KEYS.ruleDefaultRatio]: 'text',
  [ESTIMATE_SETTING_KEYS.hideCoefsForClient]: 'boolean',
  ...Object.fromEntries(ESTIMATE_COEF_KEYS.map((k) => [ESTIMATE_COEF_SETTING_KEYS[k], 'number'])),
};

/**
 * §3.3 八键的「当前可编辑字符串值」（单源：前端只渲染，不反推 `EstimateConfig`）。
 * 数字/布尔键取自 `cfg`（已回落默认、恒非空）；规则比例串从 `cfg.ruleRatio` 重建「O:4:P」
 * （中间段恒为 4，由 `parseRuleRatio` 强制；与原始存储等价，不会丢精度）。
 * **按 dbKey 索引**（即 `ESTIMATE_SETTING_KEYS` 的值），与 `PUT /params` 的入参键一致——前端不用二次翻译。
 */
export function estimateSettingDisplayValues(
  cfg: EstimateConfig,
  kv: Record<string, string | null>,
): Record<string, string> {
  const k = ESTIMATE_SETTING_KEYS;
  const v: Record<string, string> = {};
  v[k.manDaysPerManMonth] = String(cfg.manDaysPerManMonth);
  v[k.hoursPerManDay] = String(cfg.hoursPerManDay);
  v[k.coefCollaboration] = String(cfg.coefs.collaboration);
  v[k.coefQuality] = String(cfg.coefs.quality);
  v[k.coefScope] = String(cfg.coefs.scope);
  v[k.coefSchedule] = String(cfg.coefs.schedule);
  const ratioRaw = kv[k.ruleDefaultRatio];
  v[k.ruleDefaultRatio] =
    ratioRaw !== null && ratioRaw !== undefined && String(ratioRaw).trim() !== ''
      ? String(ratioRaw)
      : `${cfg.ruleRatio.oMul}:4:${cfg.ruleRatio.pMul}`;
  v[k.hideCoefsForClient] = cfg.hideCoefsForClient ? '1' : '0';
  return v;
}

export interface EstimateConfig {
  manDaysPerManMonth: number;
  hoursPerManDay: number;
  coefs: Record<EstimateCoefKey, number>;
  /** §4.6 规则 1 的三点倍率（相对 M）：O=M×oMul、P=M×pMul */
  ruleRatio: { oMul: number; pMul: number };
  hideCoefsForClient: boolean;
}

/** §3.3 默认值 + 裁决 D1（20.83 而非 20，客户模板命名区域的取值） */
export const DEFAULT_ESTIMATE_CONFIG: EstimateConfig = {
  manDaysPerManMonth: 20.83,
  hoursPerManDay: 8,
  coefs: { collaboration: 0.06, quality: 0.06, scope: 0.05, schedule: 0.06 },
  ruleRatio: { oMul: 1, pMul: 1.6 },
  hideCoefsForClient: false,
};

/**
 * §4.6 的 `estimate.rule.default.ratio` 读法（v1.0 字符串「1:4:1.6」有两种解释，
 * 按 §4.6 正文的显式式子 `O = M × rO`、`P = M × rP` 与「即 O=M、P=1.6M」定死）：
 * 首末两段是 O、P 相对 M 的倍率，**中间那段的 4 是 PERT 权重而不是 M 的倍率**——
 * 所以 1:4:1.6 得到 O=M、P=1.6M，与模板实测形态（12/12/16、20/20/24、30/30/35）一致。
 * 中间值不是 4 视为配置写错，直接报错而不是猜。
 */
export function parseRuleRatio(raw: string | number | boolean | null | undefined): { oMul: number; pMul: number } {
  const s = String(raw ?? '').trim();
  if (!s) return { ...DEFAULT_ESTIMATE_CONFIG.ruleRatio };
  const parts = s.split(':').map((x) => Number(x.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error(`${ESTIMATE_ERRORS.ratioFormat}，当前值「${raw}」`);
  }
  if (parts[1] !== 4) {
    throw new Error(`${ESTIMATE_ERRORS.ratioMidPert}，当前值「${raw}」`);
  }
  return { oMul: parts[0], pMul: parts[2] };
}

/** `app_settings` 原始 KV → 配置（缺省回落默认值；非法值报错，不静默吞掉——报价参数错一位就是钱） */
export function resolveEstimateConfig(
  kv: Record<string, string | number | boolean | null | undefined>
): EstimateConfig {
  const num = (key: string, def: number, opts: { min?: number; max?: number } = {}): number => {
    const raw = kv[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${ESTIMATE_ERRORS.paramLabel}「${key}」${ESTIMATE_ERRORS.notNumber}，当前值「${raw}」`);
    if (opts.min !== undefined && n < opts.min) throw new Error(`${ESTIMATE_ERRORS.paramLabel}「${key}」${ESTIMATE_ERRORS.paramMin} ${opts.min}，当前值 ${n}`);
    if (opts.max !== undefined && n > opts.max) throw new Error(`${ESTIMATE_ERRORS.paramLabel}「${key}」${ESTIMATE_ERRORS.paramMax} ${opts.max}，当前值 ${n}`);
    return n;
  };
  const coefs = {} as Record<EstimateCoefKey, number>;
  for (const k of ESTIMATE_COEF_KEYS) {
    coefs[k] = num(ESTIMATE_COEF_SETTING_KEYS[k], DEFAULT_ESTIMATE_CONFIG.coefs[k], { min: 0, max: 1 });
  }
  const hideRaw = kv[ESTIMATE_SETTING_KEYS.hideCoefsForClient];
  return {
    // 20 vs 20.83 是本 PRD 的已知口径冲突（§3.3-D1），只校范围、不改值，改值由 owner 在参数页显式操作
    manDaysPerManMonth: num(ESTIMATE_SETTING_KEYS.manDaysPerManMonth, DEFAULT_ESTIMATE_CONFIG.manDaysPerManMonth, { min: 1, max: 30 }),
    hoursPerManDay: num(ESTIMATE_SETTING_KEYS.hoursPerManDay, DEFAULT_ESTIMATE_CONFIG.hoursPerManDay, { min: 1, max: 24 }),
    coefs,
    ruleRatio: parseRuleRatio(kv[ESTIMATE_SETTING_KEYS.ruleDefaultRatio]),
    hideCoefsForClient: hideRaw === undefined ? DEFAULT_ESTIMATE_CONFIG.hideCoefsForClient : /^(1|true|on|yes)$/i.test(String(hideRaw).trim()),
  };
}

/** 期望值 E（§4.2 标准 PERT） */
export function expected(p: ThreePoints): number {
  return (p.optimistic + 4 * p.likely + p.pessimistic) / 6;
}

/** 标准差 σ（§4.3） */
export function sigma(p: ThreePoints): number {
  return (p.pessimistic - p.optimistic) / 6;
}

/**
 * 模板原式的语义复刻（§4.2：`=(MIN+MAX+4*((SUM-MIN-MAX)/(COUNTA-2)))/6`，列序 E=M、F=O、G=P）。
 * 生产计算走 `expected()`，本函数只用于断言两者逐值相等——留在这儿是因为「等价」这件事
 * 不写成可执行断言就等于没说过。
 * ⚠ 等价前提是 **O≤M≤P**：模板式靠 MIN/MAX 定位中值再按位次加权，三点乱序时两式必然分叉
 *   （反例 0/5/1：标准式 3.5、模板式 1.5）。该前提由 E1 服务层的 `pointsError` 校验守住，
 *   引擎不重复设第二道校验——两道校验迟早漂移成两套报价数。
 */
export function expectedByTemplateFormula(p: ThreePoints): number {
  const vals = [p.likely, p.optimistic, p.pessimistic];
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const mid = (vals.reduce((a, b) => a + b, 0) - mn - mx) / (vals.length - 2);
  return (mn + mx + 4 * mid) / 6;
}

/** 置信区间（§4.3）：P84 = E+1σ（精确 84.13%，裁决 D2 对外报价口径） */
export function confidence(e: number, s: number): { p68: [number, number]; p84: number; p95: [number, number]; p99: [number, number] } {
  return { p68: [e - s, e + s], p84: e + s, p95: [e - 2 * s, e + 2 * s], p99: [e - 3 * s, e + 3 * s] };
}

/** 人天 → 人月（§4.5） */
export function toManMonth(manDays: number, cfg: EstimateConfig = DEFAULT_ESTIMATE_CONFIG): number {
  return manDays / cfg.manDaysPerManMonth;
}

/** 人天 → 人时（模板 E4 文案：1 人天 = 8 人时） */
export function toHours(manDays: number, cfg: EstimateConfig = DEFAULT_ESTIMATE_CONFIG): number {
  return manDays * cfg.hoursPerManDay;
}

/**
 * 人天 E 值 → 日历天落点（§4.5 展示换算，与 `plan_tasks.duration_days` 对比用）：
 * 从锚点日（一般是项目/计划起始日）向后走 ⌈E⌉ 个工作日。不进任何汇总，只做展示。
 */
export function expectedEndWorkday(anchor: string, manDays: number, cal: WorkdayCal): string {
  return addWorkdays(anchor, Math.ceil(manDays), cal);
}

/**
 * §7「数据联动与变更影响」的行级判据（E9）。全部计算留在这里、由路由下发，面板只做展示——
 * 「零计算红线」不是风格偏好：徽标阈值一旦在两侧各写一遍，就会出现「界面标黄、导出件不认」的两套报价数。
 *
 *  1. **偏差徽标**：`E(人天) / duration_days` 越过 `1.5`（估算远重于排期）或低于 `0.67`（排期比估算松得多）
 *     才提示，阈值成对写死在此（§7 原文），改一处即两侧同步。
 *  2. **收口只读**：判据与 `EstimateService.requirePlan` 的写路径闸门共用 `isClosedMilestone`，
 *     范围只含里程碑行——口径见 §7 v2.3。
 *  3. **排期压力**：`E 人天 > 剩余排期工作日`（`[今天, endDate]` 区间，含加班日、去放假日）。
 */
export const DURATION_RATIO_HIGH = 1.5;
export const DURATION_RATIO_LOW = 0.67;

export interface RowDriftInput {
  /** E 人天；该行未估算时传 null（未估算不参与偏差判定，也不该被标黄） */
  expected: number | null;
  durationDays: number | null;
  endDate: string;
  planKind: string;
  planStatus: string;
  planProgress: number;
}

export interface RowDriftResult {
  ratio: number | null;
  flag: 'high' | 'low' | null;
  /** 里程碑已收口 → 估算行只读（§7） */
  locked: boolean;
  /** 剩余排期工作日；无排期日期时为 null（不参与压力判定） */
  remainingWorkdays: number | null;
  /** E 人天 > 剩余排期 */
  pressure: boolean;
}

/** 单行判据（纯函数，日历与「今天」由调用方注入，便于断言） */
export function rowDriftCheck(input: RowDriftInput, cal: WorkdayCal, today: string): RowDriftResult {
  const e = typeof input.expected === 'number' && Number.isFinite(input.expected) ? input.expected : null;
  const d = typeof input.durationDays === 'number' && Number.isFinite(input.durationDays) ? input.durationDays : null;
  let ratio: number | null = null;
  let flag: 'high' | 'low' | null = null;
  if (e !== null && d !== null && d > 0) {
    ratio = Math.round((e / d) * 100) / 100;
    if (ratio > DURATION_RATIO_HIGH) flag = 'high';
    else if (ratio < DURATION_RATIO_LOW) flag = 'low';
  }
  const hasEnd = /^\d{4}-\d{2}-\d{2}$/.test(input.endDate || '');
  const remaining = hasEnd ? countWorkdaysBetween(today, input.endDate, cal) : null;
  return {
    ratio,
    flag,
    locked: isClosedMilestone(input),
    remainingWorkdays: remaining,
    pressure: e !== null && remaining !== null && e > remaining,
  };
}

/** 里程碑收口只读判据复用 `EstimateService.isClosedMilestone`（写路径闸门与面板读数同一份定义，见 §7 v2.3） */

/** 四列（O/M/P/E）形态的段汇总，对应模板 R35/R40 的 E/F/G/H 四列都要写公式 */
export interface ColumnSum {
  optimistic: number;
  likely: number;
  pessimistic: number;
  expected: number;
}

export interface PhaseStat extends ColumnSum {
  phase: EstimatePhase;
  rowCount: number;
  sigma: number;
  /** 理想人月（该阶段 E ÷ 每人月工天标准） */
  idealManMonth: number;
  /** 模板 I 列：阶段行 `=IFERROR(H{r}/每人月工天标准/$H$40,"")`；开发段是 `I8:I31` 合并的整体比例 */
  ratio: number;
}

export interface CoefRow {
  key: EstimateCoefKey;
  label: string;
  /** 模板里系数行也被当三点行处理：E=F=G=系数 */
  points: ThreePoints;
  expected: number;
  /** `=IFERROR($H$35*H{r}/$H$40,"")` */
  ratio: number;
}

export interface RatioCheck {
  /** 面板「Σ估算比例」读数，对应导出文件的 I40（§4.4） */
  sumRatio: number;
  /** |sumRatio − 1| 百分比 */
  deviationPct: number;
  /** 偏差 >1% → `--danger` 标注（模板备注第 3 条的自动版） */
  danger: boolean;
  /** 未归入阶段的行：偏差的真实来源，面板要点名到行 */
  unassigned: Array<{ key: string; phase: string }>;
  /** 被排除出 Σ 的行数，对账用 */
  excluded: { subtotal: number; milestone: number; unEstimated: number };
}

export interface EstimateSummary {
  config: EstimateConfig;
  phases: PhaseStat[];
  /** 直接投入人天（R35 求和区间排除小计行后的四列） */
  directManDays: ColumnSum;
  /** R35：理想人月四列 */
  idealManMonths: ColumnSum;
  /** σ_total = √(Σσ_i²)（独立假设，UI 需注明「未计相关性」） */
  sigmaTotal: number;
  /** Σ四个调节系数 */
  coefSum: number;
  /** R40：实际预估人月四列 = R35 × (1 + Σ系数) */
  actualManMonths: ColumnSum;
  coefRows: CoefRow[];
  /**
   * 报价口径（§4.3 + 裁决 D2：对外 P84，内部同时看 P50）。
   * 人天列是**直接投入**（未含系数），人月列是**实际预估**（含 Σ系数）——P50 人月逐字等于 `actualManMonths.expected`，
   * 与交付件 R40、PDF「实际预估人月」同一份数（T02047 真机走查抓到旧口径把理想人月当报价读数，差 1/(1+Σ系数)≈19%）。
   */
  quote: { p50ManDays: number; p84ManDays: number; p50ManMonth: number; p84ManMonth: number; sigma: number };
  /**
   * 逐行期望值 / σ / 人天占比（开发段整体比例见 `phases` 里的 dev 项）。
   * σ 也在这里给（T02039/E4）：面板明细列要显示 σ，而 §9 计算单源禁止前端自算三点——
   * 缺这一个字段，前端要么不算、要么重算一遍 `sigma()`。
   */
  rowRatios: Array<{ key: string; phase: string; expected: number; sigma: number; ratio: number }>;
  ratioCheck: RatioCheck;
  /** 进入 Σ 的行标识（面板「已计入 N 行」与调试对账） */
  countedKeys: string[];
}

const isPhase = (p: string): p is EstimatePhase => (ESTIMATE_PHASES as readonly string[]).includes(p);
const sumCols = (): ColumnSum => ({ optimistic: 0, likely: 0, pessimistic: 0, expected: 0 });
const addCol = (t: ColumnSum, p: ThreePoints): void => {
  t.optimistic += p.optimistic;
  t.likely += p.likely;
  t.pessimistic += p.pessimistic;
  t.expected += expected(p);
};

/**
 * 主入口：明细/阶段行 + 配置 → 汇总（§4.3/§4.4）。
 * 求和集合 = 归入六阶段、`points` 非空、`role ≠ 'subtotal'`、`planKind ≠ 'milestone'` 的行；
 * 其余行的期望值照样返回在 `rowRatios` 里供展示，只是不进 Σ。
 *
 * ⚠ 分类顺序即口径（T02123）：`subtotal` / `milestone` 是**结构性排除**——与行有没有三点无关，
 *   必须先于 `!points` 判定。旧顺序把无点值的小计行/里程碑误计进 `unEstimated`：
 *   面板「未录入 N 行」把里程碑算成待录入（mtask四期 49 行里 14 行是里程碑，虚报 14 行待录入），
 *   PDF 备注把导出小计行算成未估算（wiki二期 35 行未录入只报 1 行）。
 */
export function buildSummary(rows: EstimateEngineRow[], config: EstimateConfig = DEFAULT_ESTIMATE_CONFIG): EstimateSummary {
  const excluded = { subtotal: 0, milestone: 0, unEstimated: 0 };
  const unassigned: Array<{ key: string; phase: string }> = [];
  const counted: EstimateEngineRow[] = [];
  for (const r of rows) {
    if (r.role === 'subtotal') {
      excluded.subtotal += 1;
      continue;
    }
    if (r.planKind === 'milestone') {
      excluded.milestone += 1;
      continue;
    }
    if (!r.points) {
      excluded.unEstimated += 1;
      continue;
    }
    if (!isPhase(r.phase)) {
      unassigned.push({ key: r.key, phase: r.phase });
      continue;
    }
    counted.push(r);
  }

  const byPhase = new Map<EstimatePhase, { col: ColumnSum; varSum: number; n: number }>();
  for (const ph of ESTIMATE_PHASES) byPhase.set(ph, { col: sumCols(), varSum: 0, n: 0 });
  for (const r of counted) {
    const p = r.points as ThreePoints;
    const b = byPhase.get(r.phase as EstimatePhase)!;
    addCol(b.col, p);
    b.varSum += sigma(p) ** 2;
    b.n += 1;
  }

  const directManDays = sumCols();
  for (const r of counted) addCol(directManDays, r.points as ThreePoints);
  const idealManMonths: ColumnSum = {
    optimistic: toManMonth(directManDays.optimistic, config),
    likely: toManMonth(directManDays.likely, config),
    pessimistic: toManMonth(directManDays.pessimistic, config),
    expected: toManMonth(directManDays.expected, config),
  };
  const coefSum = ESTIMATE_COEF_KEYS.reduce((a, k) => a + config.coefs[k], 0);
  const coefMul = 1 + coefSum;
  const actualManMonths: ColumnSum = {
    optimistic: idealManMonths.optimistic * coefMul,
    likely: idealManMonths.likely * coefMul,
    pessimistic: idealManMonths.pessimistic * coefMul,
    expected: idealManMonths.expected * coefMul,
  };

  // 模板 I 列分母统一取 $H$40（E 列的实际预估人月）
  const denom = actualManMonths.expected;
  const phases: PhaseStat[] = ESTIMATE_PHASES.map((phase) => {
    const b = byPhase.get(phase)!;
    const s = Math.sqrt(b.varSum);
    return {
      phase,
      rowCount: b.n,
      optimistic: b.col.optimistic,
      likely: b.col.likely,
      pessimistic: b.col.pessimistic,
      expected: b.col.expected,
      sigma: s,
      idealManMonth: toManMonth(b.col.expected, config),
      ratio: denom === 0 ? 0 : toManMonth(b.col.expected, config) / denom,
    };
  });

  const coefRows: CoefRow[] = ESTIMATE_COEF_KEYS.map((key) => {
    const v = config.coefs[key];
    const pts: ThreePoints = { optimistic: v, likely: v, pessimistic: v };
    return { key, label: ESTIMATE_COEF_LABELS[key], points: pts, expected: expected(pts), ratio: denom === 0 ? 0 : (idealManMonths.expected * v) / denom };
  });

  const sigmaTotal = Math.sqrt(counted.reduce((a, r) => a + sigma(r.points as ThreePoints) ** 2, 0));
  const rowRatios = rows
    .filter((r): r is EstimateEngineRow & { points: ThreePoints } => !!r.points && r.role !== 'coef')
    .map((r) => ({
      key: r.key,
      phase: r.phase,
      expected: expected(r.points),
      sigma: sigma(r.points),
      ratio: denom === 0 ? 0 : toManMonth(expected(r.points), config) / denom,
    }));

  // I40 自检 = Σ阶段比例 + Σ系数比例；面板读数的偏差把未归阶段行也算进去
  // （那些行在面板里有占比读数、却不在 H35 的分子里，正是 §4.4 要告警的场景）。
  // 导出件里这一格写 `SUM(I35:I39)` 而非模板原式 `SUBTOTAL(9,I35:I39)`——嵌套排除会让它只剩系数侧（T02047 ③轨实测）
  const sumRatio =
    phases.reduce((a, p) => a + p.ratio, 0) +
    coefRows.reduce((a, c) => a + c.ratio, 0) +
    unassigned.reduce((a, u) => {
      const r = rows.find((x) => x.key === u.key);
      if (!r?.points || denom === 0) return a;
      return a + toManMonth(expected(r.points), config) / denom;
    }, 0);
  const deviationPct = Math.abs(sumRatio - 1) * 100;

  return {
    config,
    phases,
    directManDays,
    idealManMonths,
    sigmaTotal,
    coefSum,
    actualManMonths,
    coefRows,
    quote: {
      p50ManDays: directManDays.expected,
      p84ManDays: directManDays.expected + sigmaTotal,
      p50ManMonth: actualManMonths.expected,
      p84ManMonth: toManMonth(directManDays.expected + sigmaTotal, config) * coefMul,
      sigma: sigmaTotal,
    },
    rowRatios,
    ratioCheck: { sumRatio, deviationPct, danger: deviationPct > 1, unassigned, excluded },
    countedKeys: counted.map((r) => r.key),
  };
}

/**
 * `estimate_items` 视图行 → 引擎行的映射（§3.4：阶段取估算行自身，`kind` 取计划行）。
 * 单独导出是为了让 E3 的路由和 E4 的对账用同一个映射，而不是各写一遍字段名。
 */
export function toEngineRow(v: {
  plan_id: string;
  phase: string;
  optimistic: number;
  likely: number;
  pessimistic: number;
  planKind?: string;
}): EstimateEngineRow {
  return {
    key: v.plan_id,
    phase: v.phase,
    points: { optimistic: v.optimistic, likely: v.likely, pessimistic: v.pessimistic },
    role: 'detail',
    planKind: v.planKind ?? 'normal',
  };
}

/** 开发段整体比例对应模板 `I8:I31` 单格合并（分子取 R31 小计） */
export function devSectionRatio(s: EstimateSummary): number {
  return s.phases.find((p) => p.phase === 'dev')?.ratio ?? 0;
}
