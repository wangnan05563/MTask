/**
 * 估算冷启动推导（E3 · PRD-估算视图与工作量评估导出 §4.6）。
 *
 * 只做「读既有事实 → 出三点建议值」，落库全部走 `EstimateService.upsertBatch`，
 * 计算口径（E/σ/汇总/人月）全部走 `estimate-engine.ts`——本文件不出现第二套公式，
 * 也不改排期（§7「三点改动只改估算，不动排期」）。
 *
 * 三档规则按 §4.6 优先级择一，命中即停：
 *   1. `complexity` 非空 → `M = base_days(complexity)`，`O = M×rO`、`P = M×rP`（比例串由
 *      `parseRuleRatio` 解析，读法已在 v1.6 定死：中段 4 是 PERT 权重不是 M 的倍率）；
 *   2. 该计划关联需求存在用例 → `M = clamp(Σ权重 × k, 0.5, 20)`（权重 P0=3/P1=2/P2=1/P3=0.5，
 *      与 §3.4 规模代理同源；O/P 沿用规则 1 的比例配置）；
 *   3. 只有 `duration_days` → `M = duration_days`、`O = 0.8M`、`P = 1.4M`，
 *      note 固定写「由排期工期推导，建议复核」（§4.6 规则 3 的面板提示语，不能各写一套）。
 *
 * 三条红线（都是 PRD 明确项）：
 *  - **里程碑不进 Σ，也不落库**（§4.6 v1.4「里程碑不重复计」）：milestone 行是明细的包络，
 *    逐行推导后再求和会把一个阶段算两遍。本模块仍给出「参考推导值」并把 `writable=false`
 *    标出来，面板可显示但不写估算行——E6 导出与 §4.4 汇总按 `kind` 排除。
 *  - **人工行不可被规则覆盖**（§4.6「人工改过即转 manual」）：默认只补「未估算」的行，
 *    `scope='all'` 才碰已有行，且 manual 行还需显式 `includeManual`。
 *  - **精度 0.5 人天**（§4.1）：推导值落到 0.5 网格上，面板与 Excel 看到的是同一个数。
 */
import { getDb } from '../db/connection';
import { getSetting } from './AppSettings';
import { EstimateService, type EstimatePhase } from './EstimateService';
import { expected, type EstimateConfig, type ThreePoints } from './estimate-engine';

/** 三档规则标识（面板/导出按它标注来源，`source` 统一写 'rule'） */
export const DERIVE_RULES = ['complexity', 'caseWeight', 'duration'] as const;
export type DeriveRule = (typeof DERIVE_RULES)[number];

/** §4.6 规则 1 的复杂度基准人天（1~5 档，与 `plan_tasks.complexity` 同一套档位） */
export const COMPLEXITY_BASE_DAYS: Record<number, number> = { 1: 1, 2: 2, 3: 3.5, 4: 5, 5: 8 };

/** §4.6 规则 2 的用例权重（P0=3/P1=2/P2=1/P3=0.5，键为大写；其它优先级权重记 0 并计数上报） */
export const CASE_PRIORITY_WEIGHTS: Record<string, number> = { P0: 3, P1: 2, P2: 1, P3: 0.5 };

/** §4.6 规则 2 的 k（用例权重 → 人天）：全局默认 + 项目级覆盖，都走 `app_settings` */
export const CASE_WEIGHT_K_DEFAULT = 0.5;
export const SETTINGS_KEY_CASE_K = 'estimate.caseWeightK';
/** 项目级覆盖键前缀（§3.3 表未列项目级键，规则 2 的「项目级可配」只能新起这一支；显式前缀避免与全局键混读） */
export const SETTINGS_KEY_CASE_K_PROJECT = 'estimate.caseWeightK.';
/** §4.6 规则 2 的 M 上下限（clamp 0.5~20 人天） */
export const CASE_M_MIN = 0.5;
export const CASE_M_MAX = 20;

/** §4.6 规则 3 的固定倍率（与比例配置无关——工期回退是经验值，不跟 1:4:1.6 漂移） */
export const DURATION_O_MUL = 0.8;
export const DURATION_P_MUL = 1.4;
export const DURATION_NOTE = '由排期工期推导，建议复核';

/** 跳过落库的原因（面板据此分色显示，空串=可落库） */
export const DERIVE_SKIPS = ['milestone', 'exists', 'manual'] as const;
export type DeriveSkip = (typeof DERIVE_SKIPS)[number] | '';

export interface DeriveItem {
  planId: string;
  title: string;
  kind: string;
  phase: EstimatePhase;
  rule: DeriveRule;
  optimistic: number;
  likely: number;
  pessimistic: number;
  /** 推导出的期望值（引擎单源算出，面板直接显示，不再各算一遍 PERT） */
  expected: number;
  source: 'rule';
  note: string;
  /** 推导依据的原始事实（复杂度档/用例数与权重/k/工期），供面板 tooltip 与 §10 抽查 */
  basis: Record<string, number>;
  /** 该行是否已有估算行及其来源（无则 null）——落库前保护人工行用 */
  existing: 'manual' | 'rule' | 'default' | null;
  writable: boolean;
  skip: DeriveSkip;
}

export interface DeriveOptions {
  /** 只推这些计划（缺省=项目全部未归档计划） */
  planIds?: string[];
  /** 'missing'（默认）只补未估算行；'all' 连已有行一起重推 */
  scope?: 'missing' | 'all';
  /** scope='all' 时是否覆盖 manual 行（默认不覆盖） */
  includeManual?: boolean;
  config: EstimateConfig;
  /** 覆盖 k（面板「影响试算」与单测用；缺省读 `app_settings`） */
  caseWeightK?: number;
}

/** §4.1 输入精度 0.5 人天 */
function toGrid(v: number): number {
  return Math.round(v * 2) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function points(ratio: { oMul: number; pMul: number }, m: number): ThreePoints {
  const likely = toGrid(m);
  return { optimistic: toGrid(m * ratio.oMul), likely, pessimistic: toGrid(m * ratio.pMul) };
}

/** 标题关键字 → 阶段（§3.4：milestone 与明细的阶段归属都按这张表；未命中归 dev，与 `EstimateService` 缺省一致） */
const PHASE_KEYWORDS: Array<[RegExp, EstimatePhase]> = [
  [/需求|调研|PRD|评审/, 'req'],
  [/设计|架构|方案/, 'design'],
  [/实施|部署|上线|交付/, 'impl'],
  [/维护|现场|运维|支持/, 'onsite'],
  [/测试|培训|文档|公共|通用/, 'common'],
  [/开发|研发|编码|联调/, 'dev'],
];

export function inferPhase(title: string): EstimatePhase {
  const s = (title ?? '').trim();
  for (const [re, phase] of PHASE_KEYWORDS) if (re.test(s)) return phase;
  return 'dev';
}

interface PlanFact {
  planId: string;
  title: string;
  kind: string;
  complexity: number | null;
  durationDays: number;
  reqIds: string[];
}

/** req_ids 是 JSON 数组文本（`PlanService.ts:558` 的私有解析器同一语义，这里不复用以免改到并发中的文件） */
function parseIds(json: string | null): string[] {
  try {
    const a = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 项目内未归档计划的推导输入（sort_order 顺序与面板/导出一致，不引入第二套次序） */function readPlans(projectId: string, planIds?: string[]): PlanFact[] {
  const db = getDb();
  const where: string[] = ['p.project_id = ?', 'COALESCE(p.archived, 0) = 0'];
  const args: unknown[] = [projectId];
  const ids = (planIds ?? []).filter((x) => typeof x === 'string' && x);
  if (ids.length > 0) {
    where.push(`p.id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  const rows = db
    .prepare(
      `SELECT p.id AS planId, p.title, p.kind, p.complexity, p.duration_days AS durationDays, p.req_ids AS reqIds
         FROM plan_tasks p WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(p.sort_order, 0) ASC, p.start_date ASC, p.id ASC`,
    )
    .all(...args) as Array<Omit<PlanFact, 'reqIds'> & { reqIds: string | null }>;
  return rows.map((r) => ({ ...r, reqIds: parseIds(r.reqIds) }));
}

export interface PlanSkeleton {
  planId: string;
  title: string;
  kind: string;
}

/**
 * 未归档计划的骨架（含里程碑行）。GET 用它拼「可见行全集」引擎输入——
 * §4.4 的分配比例自检必须连**未估算**的计划一起算，只喂已有估算行的话
 * 比例恒等于 1，自检就成了空转。
 */
export function listPlanSkeletons(projectId: string): PlanSkeleton[] {
  if (!projectId?.trim()) throw new Error('projectId 必填');
  return getDb()
    .prepare(
      `SELECT p.id AS planId, p.title, p.kind FROM plan_tasks p
        WHERE p.project_id = ? AND COALESCE(p.archived, 0) = 0
        ORDER BY COALESCE(p.sort_order, 0) ASC, p.start_date ASC, p.id ASC`,
    )
    .all(projectId) as PlanSkeleton[];
}

/** req_id → {用例数, Σ权重}；未知优先级计入 unknown 并给权重 0（不猜档位） */
function readCaseWeights(projectId: string): Map<string, { count: number; weight: number; unknown: number }> {
  const rows = getDb()
    .prepare(
      `SELECT req_id AS reqId, priority FROM test_cases
        WHERE project_id = ? AND req_id IS NOT NULL AND req_id != ''`,
    )
    .all(projectId) as Array<{ reqId: string; priority: string }>;
  const map = new Map<string, { count: number; weight: number; unknown: number }>();
  for (const r of rows) {
    const cur = map.get(r.reqId) ?? { count: 0, weight: 0, unknown: 0 };
    const w = CASE_PRIORITY_WEIGHTS[String(r.priority ?? '').trim().toUpperCase()];
    cur.count += 1;
    if (w === undefined) cur.unknown += 1;
    else cur.weight += w;
    map.set(r.reqId, cur);
  }
  return map;
}

/** k 的解析：显式覆盖 → 项目级 → 全局 → 默认 0.5；非正数/非数字报错（参数页写错 k 会整体推歪） */
export type CaseWeightKSource = 'override' | 'project' | 'global' | 'default';

export function resolveCaseWeightK(projectId: string, override?: number): { k: number; from: CaseWeightKSource } {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override <= 0) throw new Error(`用例权重系数 k 必须是正数，当前值「${override}」`);
    return { k: override, from: 'override' };
  }
  const rawP = getSetting(`${SETTINGS_KEY_CASE_K_PROJECT}${projectId}`);
  const rawG = getSetting(SETTINGS_KEY_CASE_K);
  const pick = (raw: string | null, from: 'project' | 'global') => {
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`用例权重系数 k（${from}）必须是正数，当前值「${raw}」`);
    return { k: n, from };
  };
  return pick(rawP, 'project') ?? pick(rawG, 'global') ?? { k: CASE_WEIGHT_K_DEFAULT, from: 'default' };
}

function buildItem(
  plan: PlanFact,
  opts: {
    config: EstimateConfig;
    k: number;
    cases: { count: number; weight: number; unknown: number } | null;
    existing: DeriveItem['existing'];
  },
): DeriveItem {
  const { config } = opts;
  const base: Omit<DeriveItem, 'rule' | 'optimistic' | 'likely' | 'pessimistic' | 'expected' | 'note' | 'basis'> = {
    planId: plan.planId,
    title: plan.title,
    kind: plan.kind,
    phase: inferPhase(plan.title),
    source: 'rule',
    existing: opts.existing,
    writable: false,
    skip: '',
  };
  const attach = (rule: DeriveRule, p: ThreePoints, note: string, basis: Record<string, number>): DeriveItem => ({
    ...base,
    rule,
    ...p,
    expected: expected(p),
    note,
    basis,
  });

  const c = plan.complexity;
  if (c !== null && COMPLEXITY_BASE_DAYS[c] !== undefined) {
    const m = COMPLEXITY_BASE_DAYS[c];
    const p = points(config.ruleRatio, m);
    return attach(
      'complexity',
      p,
      `按复杂度 ${c} 档推导（基准 ${m} 人天，三点倍率 ${config.ruleRatio.oMul}:4:${config.ruleRatio.pMul}）`,
      { complexity: c, baseDays: m, caseCount: opts.cases?.count ?? 0 },
    );
  }
  if (opts.cases && opts.cases.count > 0) {
    const m = clamp(opts.cases.weight * opts.k, CASE_M_MIN, CASE_M_MAX);
    const p = points(config.ruleRatio, m);
    return attach('caseWeight', p, `按关联用例加权推导（${opts.cases.count} 条用例、Σ权重 ${round2(opts.cases.weight)}、k=${opts.k}）`, {
      caseCount: opts.cases.count,
      caseWeight: round2(opts.cases.weight),
      caseWeightUnknown: opts.cases.unknown,
      k: opts.k,
      baseDays: m,
    });
  }
  const m = plan.durationDays > 0 ? plan.durationDays : 1;
  const p = points({ oMul: DURATION_O_MUL, pMul: DURATION_P_MUL }, m);
  return attach('duration', p, DURATION_NOTE, { durationDays: plan.durationDays, baseDays: m });
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 项目（或指定计划集）的三档推导结果。顺序与面板一致；milestone 行只出参考值。
 */
export function deriveEstimates(projectId: string, opts: DeriveOptions): {
  items: DeriveItem[];
  caseWeightK: number;
  caseWeightKFrom: CaseWeightKSource;
  skipped: Array<{ planId: string; title: string; skip: Exclude<DeriveSkip, ''> }>;
  writableCount: number;
} {
  if (!projectId?.trim()) throw new Error('projectId 必填');
  const db = getDb();
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');

  const scope = opts.scope === 'all' ? 'all' : 'missing';
  const includeManual = opts.includeManual === true;
  const { k, from } = resolveCaseWeightK(projectId, opts.caseWeightK);
  const plans = readPlans(projectId, opts.planIds);
  const cases = readCaseWeights(projectId);
  const existingRows = db
    .prepare('SELECT plan_id, source FROM estimate_items WHERE project_id = ?')
    .all(projectId) as Array<{ plan_id: string; source: string }>;
  const existingMap = new Map(existingRows.map((r) => [r.plan_id, r.source as DeriveItem['existing']]));

  const items: DeriveItem[] = [];
  const skipped: Array<{ planId: string; title: string; skip: Exclude<DeriveSkip, ''> }> = [];
  for (const plan of plans) {
    const existing = existingMap.get(plan.planId) ?? null;
    const item = buildItem(plan, {
      config: opts.config,
      k,
      cases: plan.reqIds.length > 0 ? sumCases(plan.reqIds, cases) : null,
      existing,
    });
    let skip: DeriveSkip = '';
    if (plan.kind === 'milestone') skip = 'milestone';
    else if (existing && (scope === 'missing' || (existing === 'manual' && !includeManual))) skip = existing === 'manual' ? 'manual' : 'exists';
    item.skip = skip;
    item.writable = skip === '';
    if (skip) skipped.push({ planId: item.planId, title: item.title, skip });
    items.push(item);
  }
  return { items, caseWeightK: k, caseWeightKFrom: from, skipped, writableCount: items.filter((i) => i.writable).length };
}

function sumCases(reqIds: string[], cases: Map<string, { count: number; weight: number; unknown: number }>) {
  let count = 0;
  let weight = 0;
  let unknown = 0;
  for (const id of reqIds) {
    const c = cases.get(id);
    if (!c) continue;
    count += c.count;
    weight += c.weight;
    unknown += c.unknown;
  }
  return count > 0 ? { count, weight: round2(weight), unknown } : null;
}

/** 把「可落库」的推导结果写入估算行（走 EstimateService 批量通道：任一行不合格零写入 + 行级错误） */
export function writeDerives(
  projectId: string,
  items: DeriveItem[],
): { written: number; errors: Array<{ index: number; planId: string; message: string }>; writtenPlanIds: string[] } {
  const writable = items.filter((i) => i.writable);
  if (writable.length === 0) return { written: 0, errors: [], writtenPlanIds: [] };
  const r = EstimateService.upsertBatch(
    projectId,
    writable.map((i) => ({
      planId: i.planId,
      phase: i.phase,
      optimistic: i.optimistic,
      likely: i.likely,
      pessimistic: i.pessimistic,
      source: 'rule' as const,
      note: i.note,
    })),
  );
  return {
    written: r.written,
    errors: r.errors,
    writtenPlanIds: r.written === writable.length ? writable.map((i) => i.planId) : [],
  };
}

/**
 * 覆盖面统计（GET 的「校验结果」与 §9 上线度量取数口）。
 * `estimated/missing` 只数**未归档的非里程碑计划**——脱离计划的估算行与归档行都不算覆盖面，
 * 否则「补了几条估算」会被历史行虚高。
 */
export function coverage(projectId: string): {
  normal: number;
  milestone: number;
  estimated: number;
  missing: number;
  bySource: Record<string, number>;
  detached: number;
} {
  const db = getDb();
  const plans = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM plan_tasks
        WHERE project_id = ? AND COALESCE(archived, 0) = 0 GROUP BY kind`,
    )
    .all(projectId) as Array<{ kind: string; n: number }>;
  const estimated = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM estimate_items e
         JOIN plan_tasks p ON p.id = e.plan_id
        WHERE e.project_id = ? AND COALESCE(p.archived, 0) = 0 AND p.kind != 'milestone'`,
    )
    .get(projectId) as { n: number }).n;
  const src = db
    .prepare('SELECT source, COUNT(*) AS n FROM estimate_items WHERE project_id = ? GROUP BY source')
    .all(projectId) as Array<{ source: string; n: number }>;
  const bySource: Record<string, number> = {};
  for (const r of src) bySource[r.source] = r.n;
  const normal = plans.filter((p) => p.kind !== 'milestone').reduce((a, b) => a + b.n, 0);
  const milestone = plans.filter((p) => p.kind === 'milestone').reduce((a, b) => a + b.n, 0);
  const detached = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM estimate_items e
         LEFT JOIN plan_tasks p ON p.id = e.plan_id
        WHERE e.project_id = ? AND p.id IS NULL`,
    )
    .get(projectId) as { n: number }).n;
  return { normal, milestone, estimated, missing: Math.max(0, normal - estimated), bySource, detached };
}
