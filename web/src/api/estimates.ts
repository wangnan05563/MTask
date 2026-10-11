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
}

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

/** `GET /api/estimates` 响应（§8：明细 + 汇总 + 参数 + 校验结果） */
export interface EstimatesResponse {
  projectId: string;
  items: EstimateItem[];
  summary: EstimateSummary;
  params: { config: EstimateConfigView; caseWeightK: number; settings: Record<string, string | null> };
  meta: EstimatesMeta;
  checks: {
    ratioCheck: RatioCheck;
    coverage: { normal: number; milestone: number; estimated: number; missing: number; bySource: Record<string, number>; detached: number };
    estimated: number;
    visiblePlans: number;
    detached: number;
  };
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
  /** 撤销单行录入时若原态是「无估算行」，删除才等价于回滚 */
  removeItem: (projectId: string, planId: string) =>
    api.del<{ projectId: string; planId: string; removed: boolean }>(
      `/estimates/${encodeURIComponent(planId)}?projectId=${encodeURIComponent(projectId)}`),
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
  /** 脱离计划的估算行（§7：计划被彻底删除后估算原样保留，面板给显式清理入口） */
  listDetached: (projectId: string) =>
    api.get<{ projectId: string; rows: DetachedRow[] }>(`/estimates/detach?projectId=${encodeURIComponent(projectId)}`),
  /** 显式清理脱离行（服务端只删确属该项目且仍脱离的 id，其余跳过并如实计数） */
  cleanupDetached: (projectId: string, ids: string[]) =>
    api.post<{ projectId: string; removed: number }>('/estimates/detach/cleanup', { projectId, ids }),
};
