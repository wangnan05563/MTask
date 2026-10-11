/**
 * 估算视图客户端（T02039 · PRD-估算视图与工作量评估导出 §5/§8）。
 *
 * 本文件**只有类型与请求收口，不含任何计算**：三点校验、E/σ、汇总、系数、比例自检的口径
 * 全在服务端（`server/src/services/estimate-engine.ts` + `EstimateService`），前端拿到什么读数
 * 就显示什么读数——§9「计算单源」的正面对策（同 planDeps 双口径的教训：一旦前端自算 Σ，
 * 「面板汇总 = 模板 H35」就退化成两套实现的巧合一致）。
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
export interface DeriveItem {
  planId: string;
  title: string;
  kind: string;
  phase: EstimatePhase;
  rule: 'complexity' | 'caseWeight' | 'duration';
  optimistic: number;
  likely: number;
  pessimistic: number;
  expected: number;
  source: EstimateSource;
  note: string;
  basis: Record<string, number>;
  existing: EstimateSource | null;
  writable: boolean;
  skip: '' | 'milestone' | 'exists' | 'manual';
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
}

const q = (projectId: string, extra = ''): string =>
  `/estimates?projectId=${encodeURIComponent(projectId)}${extra}`;

export const estimatesApi = {
  /** 面板首屏：明细 + 汇总 + 参数 + 校验（一次请求取全，避免前端拼接多套口径） */
  getAll: (projectId: string) => api.get<EstimatesResponse>(q(projectId)),
  /** 三档推导：默认 dryRun 预览（§4.6 红线「人工行不可被规则覆盖」由服务端判定，前端只转录） */
  derivePreview: (projectId: string) =>
    api.post<DeriveResponse>('/estimates/derive', { projectId, dryRun: true, scope: 'all' }),
  deriveWrite: (projectId: string, planIds?: string[]) =>
    api.post<DeriveResponse>('/estimates/derive', { projectId, dryRun: false, scope: 'missing', ...(planIds ? { planIds } : {}) }),
};
