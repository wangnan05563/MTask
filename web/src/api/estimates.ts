/**
 * 估算视图客户端（T02039 · PRD-估算视图与工作量评估导出 §5/§8）。
 *
 * 本文件**只有类型与请求收口，不含任何三点运算**：三点校验、E/σ、汇总、系数、比例自检的口径
 * 全在服务端（`server/src/services/estimate-engine.ts` + `EstimateService`），前端拿到什么读数
 * 就显示什么读数——§9「计算单源」的正面对策（同 planDeps 双口径的教训：一旦前端自算 Σ，
 * 「面板汇总 = 模板 H35」就退化成两套实现的巧合一致）。
 * 唯一的例外是 `toGrid`（0.5 网格对齐，非运算）：它不参与 E/σ，只把「统一值 + 相对幅度」
 * 批量填充的输入对到与服务端同一把尺子上，且有逐格对照断言（见文件内注释）。
 *
 * 类型与服务端导出逐字段对齐（`EstimateView` / `EstimateSummary` / `DeriveItem`），
 * 命名保持服务端下发的 snake→camel 现状：`items` 里计划左联字段是 camelCase（planTitle 等），
 * 估算行本身沿用表列名（plan_id/optimistic…），不在前端再改一层名。
 */
import { api } from './client';

export type EstimatePhase = 'req' | 'design' | 'dev' | 'impl' | 'common' | 'onsite';
export type EstimateSource = 'manual' | 'rule' | 'default';

/**
 * §7 行级变更影响（E9）：判定式与阈值全在服务端引擎（`estimate-engine.rowDriftCheck`），
 * 这里只有类型。面板「零计算红线」在 E9 的延伸——阈值 1.5/0.67 一旦在前端出现第二次，
 * 调阈值就会变成只改一处的 bug（`util/planDeps` 双口径教训）。
 */
export interface RowDrift {
  /** E ÷ 排期工作日 */
  ratio: number | null;
  flag: 'high' | 'low' | null;
  /** 里程碑已收口 → 该行只读（写路径由服务端 `requirePlan` 拦住，不只是置灰） */
  locked: boolean;
  remainingWorkdays: number | null;
  /** E 人天 > 剩余排期工作日 */
  pressure: boolean;
}

/** `EstimateService.EstimateView`：估算行 + 计划左联 */
export interface EstimateItem {
  id: string;
  project_id: string;
  plan_id: string;
  phase: EstimatePhase;
  unit: string;
  optimistic: number;
  likely: number;
  pessimistic: number;
  source: EstimateSource;
  note: string;
  created_at: string;
  updated_at: string;
  planTitle: string;
  planKind: string;
  planArchived: number;
  planStatus: string;
  planProgress: number;
  startDate: string;
  endDate: string;
  durationDays: number;
  complexity: number | null;
  planUpdatedAt: string;
}

/**
 * `GET /api/estimates` 的 `items` 行 = 视图行 + §7 行级判定。
 * 单列一个类型而不是并进 `EstimateItem`：PATCH 的响应体是 `EstimateService.upsert` 的视图行，
 * 没有 `drift`——写成一个类型会让「编辑后回读」拿到缺字段的对象还自称完整。
 */
export type EstimateListItem = EstimateItem & { drift: RowDrift };

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
  idealManMonth: number;
  ratio: number;
}

export interface CoefRow {
  key: string;
  label: string;
  points: { optimistic: number; likely: number; pessimistic: number };
  expected: number;
  ratio: number;
}

export interface RatioCheck {
  sumRatio: number;
  deviationPct: number;
  danger: boolean;
  unassigned: Array<{ key: string; phase: string }>;
  excluded: { subtotal: number; milestone: number; unEstimated: number };
}

/** `estimate-engine.EstimateSummary`（服务端算好，面板直接读） */
export interface EstimateSummary {
  phases: PhaseStat[];
  directManDays: ColumnSum;
  idealManMonths: ColumnSum;
  sigmaTotal: number;
  coefSum: number;
  actualManMonths: ColumnSum;
  coefRows: CoefRow[];
  quote: { p50ManDays: number; p84ManDays: number; p50ManMonth: number; p84ManMonth: number; sigma: number };
  rowRatios: Array<{ key: string; phase: string; expected: number; sigma: number; ratio: number }>;
  ratioCheck: RatioCheck;
  countedKeys: string[];
}

export interface EstimateConfigView {
  manDaysPerManMonth: number;
  hoursPerManDay: number;
  coefs: Record<string, number>;
  ruleRatio: { oMul: number; pMul: number };
  hideCoefsForClient: boolean;
}

export interface EstimatesMeta {
  phases: EstimatePhase[];
  phaseLabels: Record<EstimatePhase, string>;
  sources: EstimateSource[];
}

/** §7「上次导出后 N 条计划已变化」的单行（`changed` 点名改的是排期还是估算） */
export interface ChangedPlan {
  planId: string;
  title: string;
  kind: string;
  planUpdatedAt: string;
  estimateUpdatedAt: string;
  changed: Array<'plan' | 'estimate'>;
}

/** `GET /api/estimates` 响应（§8：明细 + 汇总 + 参数 + 校验结果） */
export interface EstimatesResponse {
  projectId: string;
  items: EstimateListItem[];
  summary: EstimateSummary;
  params: { config: EstimateConfigView; caseWeightK: number; settings: Record<string, string | null> };
  meta: EstimatesMeta;
  checks: {
    ratioCheck: RatioCheck;
    coverage: { normal: number; milestone: number; estimated: number; missing: number; bySource: Record<string, number>; detached: number };
    estimated: number;
    visiblePlans: number;
    detached: number;
    drift: {
      today: string;
      thresholds: { high: number; low: number };
      high: number;
      low: number;
      locked: number;
      pressure: number;
    };
    changedSinceExport: { snapshotId: string | null; at: string; count: number; rows: ChangedPlan[] };
  };
}

/** §7 影响试算（`POST /api/estimates/what-if`）：前后两侧只回四项读数 + 逐阶段 E，不做第二次汇总 */
export interface WhatIfSide {
  directManDays: number;
  idealManMonths: number;
  actualManMonths: number;
  coefSum: number;
  quote: EstimateSummary['quote'];
  phases: Array<{ phase: EstimatePhase; expected: number; idealManMonth: number; ratio: number }>;
}

export interface WhatIfResponse {
  projectId: string;
  before: WhatIfSide;
  after: WhatIfSide;
  delta: {
    actualManMonths: number;
    /** 基数为 0（尚无估算）时百分比无意义，服务端给 null，面板显示「—」 */
    pct: number | null;
    directManDays: number;
    phases: Array<{ phase: EstimatePhase; before: number; after: number; delta: number }>;
  };
  applied: { coefs: string[]; manDaysPerManMonth: boolean; rows: string[] };
  written: number;
}

export interface WhatIfRequest {
  coefs?: Record<string, number>;
  manDaysPerManMonth?: number;
  rows?: Array<{ planId: string; optimistic: number | string; likely: number | string; pessimistic: number | string }>;
}

/** `EstimateDerive.DeriveItem`：三档推导的单行结果（未落库时即面板的「建议值」） */
export type DeriveRule = 'complexity' | 'caseWeight' | 'duration';
/** 推导响应里每行的跳过原因（`offRule`=该行不属于所选档位，T02040 批量填充用） */
export type DeriveSkip = '' | 'milestone' | 'exists' | 'manual' | 'offRule';

export interface DeriveItem {
  planId: string;
  title: string;
  kind: string;
  phase: EstimatePhase;
  rule: DeriveRule;
  optimistic: number;
  likely: number;
  pessimistic: number;
  expected: number;
  source: EstimateSource;
  note: string;
  basis: Record<string, number>;
  existing: EstimateSource | null;
  writable: boolean;
  skip: DeriveSkip;
}

export interface DeriveResponse {
  projectId: string;
  dryRun: boolean;
  items: DeriveItem[];
  caseWeightK: number;
  caseWeightKFrom: string;
  skipped: Array<{ planId: string; title: string; skip: string }>;
  writableCount: number;
  written?: number;
  errors?: Array<{ index: number; planId: string; message: string }>;
  writtenPlanIds?: string[];
}

/** `POST /api/estimates/batch` mode='set' 的响应（服务端「任一行不合格零写入」，前端只转录行级错误） */
export interface BatchSetResponse {
  projectId: string;
  mode: 'set';
  written: number;
  errors: Array<{ index: number; planId: string; message: string }>;
}

/**
 * 单行录入入参（PATCH 语义：三点缺省时服务端沿用原值，人工改过即转 manual 也在服务端）。
 * 三点收 `number | string` 是刻意的：行内编辑框里就是字符串，「是不是数」交给服务端
 * `pointsError` 判（它会回「乐观值 O 必须是数字」），前端不先判一遍——判据有两套就迟早会分家。
 */
export interface EstimateInput {
  phase?: EstimatePhase;
  unit?: string;
  optimistic?: number | string;
  likely?: number | string;
  pessimistic?: number | string;
  source?: EstimateSource;
  note?: string;
  /** §7 收口里程碑只读行的显式解锁：真值判定与拦截都在服务端 `requirePlan`，这里只是把用户意图带到 */
  unlock?: boolean;
}

const q = (projectId: string, extra = ''): string =>
  `/estimates?projectId=${encodeURIComponent(projectId)}${extra}`;

/** 脱离计划的估算行（`EstimateService.listDetached`：INNER JOIN 看不见的那批，§7 显式清理） */
export interface DetachedRow {
  id: string;
  project_id: string;
  plan_id: string;
  phase: EstimatePhase;
  optimistic: number;
  likely: number;
  pessimistic: number;
  source: EstimateSource;
  note: string;
  updated_at: string;
}

/** 项目维度的批量/推导请求公共选项 */
export interface BatchDeriveOptions {
  planIds?: string[];
  scope?: 'missing' | 'all';
  includeManual?: boolean;
  onlyRule?: DeriveRule;
  dryRun?: boolean;
}

/**
 * §4.1 输入精度 0.5 人天的**前端镜像**（唯一实现仍在服务端 `EstimateDerive.toGrid`）。
 * 镜像而不是导入：`server/tsconfig` 与 `web/tsconfig` 互不 include（v1.6 已记），跨包引不到。
 * 用途只有一处——「统一值 + 相对幅度」批量填充时把 `M×倍率` 对到 .5 网格上，
 * 让面板与 Excel 是同一套数；由 `scripts/verify-t02040-*.mts` 与服务端逐格对照断言钉住同语义
 * （同 E1 工作日镜像 `workdays.ts` ↔ `utils/workday.ts` 的取证范式）。
 */
export function toGrid(v: number): number {
  return Math.round(v * 2) / 2;
}

/** 导出区（§5.2 第 4 段 / §6.1）——版本与范围词表与服务端 `ESTIMATE_EXPORT_SCOPES`、`parseAudience` 同字面 */
export type EstimateExportAudience = 'internal' | 'client';
export type EstimateExportScope = 'all' | 'estimated_only';

export interface EstimateExportOptions {
  audience?: EstimateExportAudience;
  scope?: EstimateExportScope;
  /** 阶段子集（不传=全部六阶段）；服务端按此重排行号，件内公式区间同步收窄 */
  phases?: EstimatePhase[];
}

/** §6.3 快照 payload（服务端导出时写入，仅存汇总与结构计数，非全量明细） */
export interface EstimateSnapshotPayload {
  projectId: string;
  projectName: string;
  scope: EstimateExportScope;
  audience: EstimateExportAudience;
  /** 本次导出的阶段筛选（与 §7 比对用的逐阶段汇总区分开） */
  phaseFilter: EstimatePhase[];
  /** §7 比对契约字段：逐阶段 E/人月 + 两个合计（服务端 `diffSnapshots` 读顶层这一份） */
  phases: PhaseStat[];
  directManDays: ColumnSum;
  actualManMonths: ColumnSum;
  estimateDate: string;
  generatedAt: string;
  detailRows: number;
  mainRows: number;
  unreviewed: number;
  milestoneSkipped: number;
  merges: number;
  summary: EstimateSummary;
}

/** §7 两版差异（服务端 `diffSnapshots` 出数，前端只排版） */
export interface SnapshotDiff {
  phases: Array<{
    phase: string;
    expected: { a: number; b: number; delta: number };
    manMonth: { a: number; b: number; delta: number };
  }>;
  totals: { directManDays: number; actualManMonths: number };
}

export interface EstimateSnapshot {
  id: string;
  project_id: string;
  format: string;
  filename: string;
  /** 服务端 `SELECT *` 直接下发，payload 列是 JSON 文本 */
  payload: string | EstimateSnapshotPayload;
  created_at: string;
}

/** 两种交付格式共用的 query 组装（服务端 `parseScope` / `parseAudience` / `parsePhases` 词表） */
function exportQuery(projectId: string, opts: EstimateExportOptions): string {
  const sp = new URLSearchParams({ projectId });
  if (opts.audience) sp.set('audience', opts.audience);
  if (opts.scope) sp.set('scope', opts.scope);
  if (opts.phases?.length) sp.set('phases', opts.phases.join(','));
  return sp.toString();
}

export const estimatesApi = {
  /** 面板首屏：明细 + 汇总 + 参数 + 校验（一次请求取全，避免前端拼接多套口径） */
  getAll: (projectId: string) => api.get<EstimatesResponse>(q(projectId)),
  /** 三档推导：默认 dryRun 预览（§4.6 红线「人工行不可被规则覆盖」由服务端判定，前端只转录） */
  derivePreview: (projectId: string, opts: BatchDeriveOptions = {}) =>
    api.post<DeriveResponse>('/estimates/derive', {
      projectId,
      dryRun: true,
      scope: opts.scope ?? 'all',
      ...(opts.planIds ? { planIds: opts.planIds } : {}),
      ...(opts.includeManual ? { includeManual: true } : {}),
      ...(opts.onlyRule ? { onlyRule: opts.onlyRule } : {}),
    }),
  deriveWrite: (projectId: string, planIds?: string[]) =>
    api.post<DeriveResponse>('/estimates/derive', { projectId, dryRun: false, scope: 'missing', ...(planIds ? { planIds } : {}) }),
  /** 单行录入（§5.3 行内编辑：Enter/失焦即落库，校验失败由服务端 400 抛中文文案） */
  patchItem: (projectId: string, planId: string, input: EstimateInput) =>
    api.patch<{ projectId: string; planId: string; item: EstimateItem }>(
      `/estimates/${encodeURIComponent(planId)}?projectId=${encodeURIComponent(projectId)}`, input),
  /** 撤销单行录入时若原态是「无估算行」，删除才等价于回滚；§7 只读行需带 `unlock`（删除同样受闸门管） */
  removeItem: (projectId: string, planId: string, opts: { unlock?: boolean } = {}) =>
    api.del<{ projectId: string; planId: string; removed: boolean }>(
      `/estimates/${encodeURIComponent(planId)}?projectId=${encodeURIComponent(projectId)}`
      + (opts.unlock ? '&unlock=1' : '')),
  /** 批量统一值写入（§5.3 模式 ③）：`source` 由调用方显式给，撤销回写时要能还原原来源 */
  batchSet: (projectId: string, items: Array<{ planId: string } & EstimateInput>) =>
    api.post<BatchSetResponse>('/estimates/batch', { projectId, mode: 'set', items }),
  /** 批量按规则推导（§5.3 模式 ①②，档位由 `onlyRule` 收口；`dryRun:true` 出预览行数） */
  batchDerive: (projectId: string, opts: BatchDeriveOptions) =>
    api.post<DeriveResponse>('/estimates/batch', {
      projectId,
      mode: 'derive',
      scope: opts.scope ?? 'all',
      dryRun: opts.dryRun === true,
      ...(opts.planIds ? { planIds: opts.planIds } : {}),
      ...(opts.includeManual ? { includeManual: true } : {}),
      ...(opts.onlyRule ? { onlyRule: opts.onlyRule } : {}),
    }),
  /**
   * §7 影响试算（E9）：改系数或改某几行三点，看实际预估人月 X → Y（Δ Z%）。
   * 服务端零写入（`written` 恒为 0），试算态不落在库里——面板显示的永远是「当前库里的数 + 本次试算的差」，
   * 不会出现「试算值看起来像已保存」。校验与 `PUT /params` 共用 `resolveEstimateConfig`。
   */
  whatIf: (projectId: string, req: WhatIfRequest) =>
    api.post<WhatIfResponse>('/estimates/what-if', { projectId, ...req }),
  /** 脱离计划的估算行（§7：计划被彻底删除后估算原样保留，面板给显式清理入口） */
  listDetached: (projectId: string) =>
    api.get<{ projectId: string; rows: DetachedRow[] }>(`/estimates/detach?projectId=${encodeURIComponent(projectId)}`),
  /** 显式清理脱离行（服务端只删确属该项目且仍脱离的 id，其余跳过并如实计数） */
  cleanupDetached: (projectId: string, ids: string[]) =>
    api.post<{ projectId: string; removed: number }>('/estimates/detach/cleanup', { projectId, ids }),
  /**
   * §6.1 导出 xlsx（E6）。文件名与快照 id 一律取自服务端响应头：
   * 件名规则（`工作量评估-客户版-项目-日期`）已在服务端，前端再拼一套就是 §6.1 反对的第二口径。
   */
  exportXlsx: async (projectId: string, opts: EstimateExportOptions = {}) => {
    const r = await api.getDownload(`/estimates/export-xlsx?${exportQuery(projectId, opts)}`);
    return { blob: r.blob, filename: r.filename, snapshotId: r.headers.get('x-estimate-snapshot') ?? '' };
  },
  /**
   * §6.2 导出 PDF（E7）：与 xlsx 同一个参数词表、同一对响应头（服务端 `buildEstimateArtifact`
   * 把两条流水线并成了一份），所以这里除路径之外没有任何 PDF 专属逻辑。
   */
  exportPdf: async (projectId: string, opts: EstimateExportOptions = {}) => {
    const r = await api.getDownload(`/estimates/export-pdf?${exportQuery(projectId, opts)}`);
    return { blob: r.blob, filename: r.filename, snapshotId: r.headers.get('x-estimate-snapshot') ?? '' };
  },
  /** §6.3 导出快照列表（最近 N 次，服务端按 created_at 倒序） */
  listSnapshots: (projectId: string, limit = 5) =>
    api.get<{ projectId: string; snapshots: EstimateSnapshot[] }>(
      `/estimates/snapshots?projectId=${encodeURIComponent(projectId)}&limit=${limit}`),
  /** §7 两版快照差异（服务端算差值，前端只排版；id 必须都在返回的最近 N 条内） */
  compareSnapshots: (projectId: string, a: string, b: string, limit = 5) =>
    api.get<{ projectId: string; snapshots: EstimateSnapshot[]; compare: { a: EstimateSnapshot; b: EstimateSnapshot; diff: SnapshotDiff } | null }>(
      `/estimates/snapshots?projectId=${encodeURIComponent(projectId)}&limit=${limit}`
      + `&compare=${encodeURIComponent(`${a},${b}`)}`),
};

/** 快照 payload 在服务端是 JSON 文本列（`SELECT *` 原样下发），解析失败交调用方如实显示 */
export function parseSnapshotPayload(raw: string | EstimateSnapshotPayload): EstimateSnapshotPayload | null {
  if (typeof raw !== 'string') return raw;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as EstimateSnapshotPayload) : null;
  } catch {
    return null;
  }
}
