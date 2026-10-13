/**
 * 估算视图路由（E3 · PRD-估算视图与工作量评估导出 §8）。
 *
 * 沿用 `planApi` 的约定（`wrap` / `pid` / 静态路径先于 `:id`，见 `routes/plans.ts:13-44`），
 * 不另起一套错误口径。本文件**不含任何计算**：三点校验与 CRUD 在 `EstimateService`，
 * PERT/汇总/参数解析在 `estimate-engine.ts`，三档推导在 `EstimateDerive`——
 * 路由只做参数收口与响应组装（§9「枚举与计算单源」）。
 *
 * 导出端点：`export-xlsx`（§6.1，逐格复刻在 `services/estimateExportXlsx.ts`）与 `export-pdf`
 * （§6.2，中间文档与渲染在 `services/estimateExportPdf.ts`）都已落地，两者共用本文件的
 * `buildEstimateArtifact()`——取数、参数解析、件名与快照 payload 只有一份实现。
 */
import { Router } from 'express';
import { getSetting, setSetting } from '../services/AppSettings';
import { PlanService } from '../services/PlanService';
import type { PlanTaskRow } from '../services/PlanService';
import { exportGate } from '../util/export-gate';
import { EstimateService, ESTIMATE_META, pointsError, unlockFlag, workdayCalendar, type EstimateInput, type EstimateView } from '../services/EstimateService';
import {
  DEFAULT_ESTIMATE_CONFIG,
  DURATION_RATIO_HIGH,
  DURATION_RATIO_LOW,
  ESTIMATE_COEF_LABELS,
  ESTIMATE_COEF_SETTING_KEYS,
  ESTIMATE_COEF_KEYS,
  ESTIMATE_SETTING_KEYS,
  buildSummary,
  resolveEstimateConfig,
  rowDriftCheck,
  toEngineRow,
  type EstimateCoefKey,
  type EstimateEngineRow,
  type EstimateSummary,
  type RowDriftResult,
  type ThreePoints,
} from '../services/estimate-engine';
import { fmtDate, type WorkdayCal } from '../util/workdays';
import {
  CASE_PRIORITY_WEIGHTS,
  CASE_WEIGHT_K_DEFAULT,
  COMPLEXITY_BASE_DAYS,
  DERIVE_RULES,
  DERIVE_SKIPS,
  DURATION_O_MUL,
  DURATION_P_MUL,
  SETTINGS_KEY_CASE_K,
  SETTINGS_KEY_CASE_K_PROJECT,
  coverage,
  deriveEstimates,
  inferPhase,
  listPlanSkeletons,
  resolveCaseWeightK,
  writeDerives,
  type DeriveRule,
} from '../services/EstimateDerive';
import type { EstimatePhase } from '../services/EstimateService';
import { safeExportName } from './plans';
import {
  ESTIMATE_EXPORT_SCOPES,
  cleanDetail,
  layoutEstimate,
  type EstimateAudience,
  type EstimateExportRow,
  type EstimateExportScope,
  type EstimateLayout,
} from '../services/estimateExportXlsx';

export const estimateApi = Router();

/** 统一错误包装：业务错误 → 400 + { error }（与 plans.ts 同文案口径） */
function wrap(res: import('express').Response, fn: () => unknown): void {
  try {
    res.json(fn());
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** projectId：查询串优先，POST/PUT 允许放请求体（`planApi` 只认查询串，这里两者都收，避免 E4/E10 两侧各猜一套） */
function pid(req: import('express').Request): string {
  const q = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
  const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).projectId : undefined;
  const s = q || (typeof b === 'string' ? b.trim() : '');
  if (!s) throw new Error('projectId 必填');
  return s;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function truthy(v: unknown): boolean {
  return /^(1|true|on|yes)$/i.test(str(v));
}

/** 请求体兜空（express 在无 body 时给 undefined，`{...} as X` 会在 undefined 上抛 TypeError） */
function body(req: import('express').Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/** §3.3 全量 KV（含规则 2 的 k 两支）——params 读写与引擎配置都从这一个读取口出 */
function readKv(projectId: string): Record<string, string | null> {
  const keys = Object.values(ESTIMATE_SETTING_KEYS);
  const kv: Record<string, string | null> = {};
  for (const k of keys) kv[k] = getSetting(k);
  kv[SETTINGS_KEY_CASE_K] = getSetting(SETTINGS_KEY_CASE_K);
  kv[`${SETTINGS_KEY_CASE_K_PROJECT}${projectId}`] = getSetting(`${SETTINGS_KEY_CASE_K_PROJECT}${projectId}`);
  return kv;
}

function effectiveCaseK(projectId: string, override?: number) {
  return resolveCaseWeightK(projectId, override);
}

/**
 * §5.3 批量填充的档位入口（T02040）：只收三档名，空=不过滤。
 * 传了不认识的值要报错而不是静默当作没传——静默会让「按复杂度填」变成「按引擎择档填」，
 * 用户以为选中的是复杂度，实际写进去的是工期回退值。
 */
function parseOnlyRule(v: unknown): DeriveRule | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!(DERIVE_RULES as readonly string[]).includes(s)) {
    throw new Error(`未知推导档位：${s}（可用 ${DERIVE_RULES.join(' / ')}）`);
  }
  return s as DeriveRule;
}

/**
 * Σ 的输入集合：**恒取未归档计划**（§3.1「归档行留在库里供历史报价复核，但不进面板、不进 Σ」）——
 * `includeArchived` 只影响明细列表，不影响汇总，否则审计视角一开就会把归档工作量重新计入报价。
 * 集合要连**未估算**的计划一起给：§4.4 的分配比例自检只喂已有估算行的话恒等于 1，自检空转。
 */
function engineRows(projectId: string): { rows: EstimateEngineRow[]; estimated: number } {
  const byPlan = new Map(EstimateService.listByProject(projectId, { includeArchived: false }).map((v) => [v.plan_id, v]));
  const rows: EstimateEngineRow[] = [];
  for (const s of listPlanSkeletons(projectId)) {
    const v = byPlan.get(s.planId);
    rows.push(v ? toEngineRow(v) : { key: s.planId, phase: inferPhase(s.title), points: null, role: 'detail', planKind: s.kind });
  }
  return { rows, estimated: rows.filter((r) => r.points !== null).length };
}

// ---------- 枚举/标签单源（§9：前端不硬编码阶段与系数标签） ----------
estimateApi.get('/meta', (_req, res) =>
  wrap(res, () => ({
    ...ESTIMATE_META,
    settingKeys: ESTIMATE_SETTING_KEYS,
    coefSettingKeys: ESTIMATE_COEF_SETTING_KEYS,
    coefLabels: ESTIMATE_COEF_LABELS,
    defaults: DEFAULT_ESTIMATE_CONFIG,
    caseWeightKDefault: CASE_WEIGHT_K_DEFAULT,
    caseWeightKKeys: { global: SETTINGS_KEY_CASE_K, projectPrefix: SETTINGS_KEY_CASE_K_PROJECT },
    complexityBaseDays: COMPLEXITY_BASE_DAYS,
    casePriorityWeights: CASE_PRIORITY_WEIGHTS,
    durationMul: { oMul: DURATION_O_MUL, pMul: DURATION_P_MUL },
    // T02040：批量填充的三档入口与跳过原因枚举从这里出，面板不再各写一份名单
    deriveRules: DERIVE_RULES,
    deriveSkips: DERIVE_SKIPS,
  })),
);

// ---------- 参数（§3.3 / §8 GET·PUT params） ----------
estimateApi.get('/params', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const kv = readKv(projectId);
    return {
      projectId,
      settings: kv,
      config: resolveEstimateConfig(kv),
      defaults: DEFAULT_ESTIMATE_CONFIG,
      caseWeightK: effectiveCaseK(projectId),
    };
  }),
);

estimateApi.put('/params', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const incoming = body(req).settings as Record<string, unknown> | undefined;
    if (!incoming || typeof incoming !== 'object') throw new Error('settings 必填（键值对象）');
    const allowed = new Set([
      ...Object.values(ESTIMATE_SETTING_KEYS),
      // 署名项（T02086 裁决「不进」，口径见 PRD §6.1 署名行 + §11-E13）：不是 §3.3 的八键
      // （不进 `settingKeys` 面、不参与生效值试算），E13 参数页也**不出现**「估算人」输入框；
      // 保留的只有这条 API 写入通道（E7/v2.2 起）——PDF 件要印「估算人」，没有这一键就恒为空。
      // 未配置时导出件 H2 留空由用户手填（§6.1「或留空」分支），不写假名。
      ESTIMATE_REVIEWER_KEY,
      SETTINGS_KEY_CASE_K,
      `${SETTINGS_KEY_CASE_K_PROJECT}${projectId}`,
    ]);
    const entries: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(incoming)) {
      if (!allowed.has(k)) throw new Error(`未知估算参数键：${k}`);
      if (v === null || v === undefined || String(v).trim() === '') continue; // 显式清空=回落默认
      entries.push([k, String(v).trim()]);
    }
    // 先全量试算再落库：一位小数写歪就是钱（与 EstimateService 批量通道同口径）
    const merged: Record<string, string | null> = { ...readKv(projectId) };
    for (const [k, v] of entries) merged[k] = v;
    resolveEstimateConfig(merged); // 只做校验，生效值在写后回读
    for (const [k, v] of entries) {
      // k 不在 §3.3 的八键里，resolveEstimateConfig 看不到它——单独用同一把尺子（正数）校验
      if (k === SETTINGS_KEY_CASE_K || k.startsWith(SETTINGS_KEY_CASE_K_PROJECT)) resolveCaseWeightK(projectId, Number(v));
    }
    for (const [k, v] of entries) setSetting(k, v);
    const cleared = Object.keys(incoming).filter((k) => !entries.some(([e]) => e === k));
    for (const k of cleared) setSetting(k, '');
    // 回读**写后**的生效值：拿试算时的 merged 当响应的话，清空类操作会显示成「没生效」
    const after = readKv(projectId);
    return { saved: Object.fromEntries(entries), cleared, config: resolveEstimateConfig(after), caseWeightK: effectiveCaseK(projectId) };
  }),
);

// ---------- 快照（§3.2 / §8 snapshots·compare） ----------
estimateApi.get('/snapshots', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    const rows = EstimateService.listSnapshots(projectId, Number.isFinite(limit) ? limit : undefined);
    const compare = str(req.query.compare);
    if (!compare) return { projectId, snapshots: rows, compare: null };
    const ids = compare.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length !== 2) throw new Error('compare 需要两个快照 id（形如 ?compare=idA,idB）');
    const find = (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`快照不存在或不在最近 ${rows.length} 条内：${id}`);
      return row;
    };
    const [a, b] = ids.map(find);
    return { projectId, snapshots: rows, compare: { a, b, diff: diffSnapshots(a.payload, b.payload) } };
  }),
);

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    throw new Error('');
  } catch {
    throw new Error('快照 payload 不是可解析的 JSON 对象（历史快照可能由旧版本写入）');
  }
}

/** 两版汇总差异：按 phase 的 E/人月逐项做差，另出合计（§7「上次导出后计划已变化」的数据底） */
function diffSnapshots(pa: string, pb: string): Record<string, unknown> {
  const A = parsePayload(pa);
  const B = parsePayload(pb);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const phases = (o: Record<string, unknown>): Record<string, Record<string, number>> => {
    const src = (o as { phases?: unknown }).phases;
    const out: Record<string, Record<string, number>> = {};
    if (Array.isArray(src)) {
      for (const p of src) {
        const rec = p as Record<string, unknown>;
        const key = str(rec.phase ?? rec.key);
        if (key) out[key] = { expected: num(rec.expected) ?? 0, manMonth: num(rec.manMonth ?? rec.idealManMonth) ?? 0 };
      }
    } else if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        const rec = (v ?? {}) as Record<string, unknown>;
        out[k] = { expected: num(rec.expected) ?? 0, manMonth: num(rec.manMonth ?? rec.idealManMonth) ?? 0 };
      }
    }
    return out;
  };
  const A2 = phases(A);
  const B2 = phases(B);
  const keys = [...new Set([...Object.keys(A2), ...Object.keys(B2)])];
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  /** 汇总字段既可能是裸数字（历史 payload）也可能是 ColumnSum（现行 `{optimistic,likely,pessimistic,expected}`）——都取 E 口径 */
  const eOf = (o: Record<string, unknown>, field: string): number => {
    const v = o[field];
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') return num((v as Record<string, unknown>).expected) ?? 0;
    return 0;
  };
  return {
    phases: keys.map((k) => ({
      phase: k,
      expected: { a: A2[k]?.expected ?? 0, b: B2[k]?.expected ?? 0, delta: round((B2[k]?.expected ?? 0) - (A2[k]?.expected ?? 0)) },
      manMonth: { a: A2[k]?.manMonth ?? 0, b: B2[k]?.manMonth ?? 0, delta: round((B2[k]?.manMonth ?? 0) - (A2[k]?.manMonth ?? 0)) },
    })),
    totals: {
      directManDays: round(eOf(B, 'directManDays') - eOf(A, 'directManDays')),
      actualManMonths: round(eOf(B, 'actualManMonths') - eOf(A, 'actualManMonths')),
    },
  };
}

// ---------- 推导（§4.6 三档 / §8 derive·batch mode=derive） ----------
estimateApi.post('/derive', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const b = body(req);
    const dryRun = b.dryRun === undefined ? true : truthy(b.dryRun); // 默认预览，落库要显式 dryRun:false
    const planIds = Array.isArray(b.planIds) ? (b.planIds as unknown[]).map(str).filter(Boolean) : undefined;
    const kOverride = b.caseWeightK === undefined || b.caseWeightK === null ? undefined : Number(b.caseWeightK);
    const onlyRule = parseOnlyRule(b.onlyRule);
    const r = deriveEstimates(projectId, {
      planIds,
      scope: b.scope === 'all' ? 'all' : 'missing',
      includeManual: truthy(b.includeManual),
      config: resolveEstimateConfig(readKv(projectId)),
      caseWeightK: kOverride,
      onlyRule,
    });
    if (dryRun) return { projectId, dryRun: true, written: 0, onlyRule, ...r };
    const write = writeDerives(projectId, r.items);
    return { projectId, dryRun: false, ...r, ...write };
  }),
);

// ---------- 批量写入（§8 batch：mode='set' | 'derive'，任一行失败零写入） ----------
estimateApi.post('/batch', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const b = body(req);
    const mode = str(b.mode) || 'set';
    if (mode !== 'set' && mode !== 'derive') throw new Error(`未知批量模式：${mode}（可用 set / derive）`);
    if (mode === 'derive') {
      const onlyRule = parseOnlyRule(b.onlyRule);
      const r = deriveEstimates(projectId, {
        planIds: Array.isArray(b.planIds) ? (b.planIds as unknown[]).map(str).filter(Boolean) : undefined,
        scope: b.scope === 'all' ? 'all' : 'missing',
        includeManual: truthy(b.includeManual),
        config: resolveEstimateConfig(readKv(projectId)),
        caseWeightK: b.caseWeightK === undefined || b.caseWeightK === null ? undefined : Number(b.caseWeightK),
        onlyRule,
      });
      if (truthy(b.dryRun)) return { projectId, mode, dryRun: true, written: 0, errors: [], writtenPlanIds: [], onlyRule, ...r };
      const write = writeDerives(projectId, r.items);
      return { projectId, mode, dryRun: false, onlyRule, ...r, ...write };
    }
    const items = b.items;
    if (!Array.isArray(items) || items.length === 0) throw new Error('批量写入内容为空（items 需为非空数组）');
    const list = items as Array<{ planId?: unknown } & EstimateInput>;
    const r = EstimateService.upsertBatch(
      projectId,
      list.map((it) => ({ ...it, planId: str(it.planId) })),
    );
    return { projectId, mode, ...r };
  }),
);

// ---------- 脱离计划的估算行（§7 显式清理） ----------
estimateApi.get('/detach', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    return { projectId, rows: EstimateService.listDetached(projectId) };
  }),
);

estimateApi.post('/detach/cleanup', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const ids = Array.isArray(body(req).ids) ? (body(req).ids as unknown[]).map(str).filter(Boolean) : [];
    return { projectId, removed: EstimateService.removeDetached(projectId, ids) };
  }),
);

// ---------- §7 影响试算（E9：改系数/改行 → 实际预估人月 X → Y，零写入） ----------

/** 试算响应里的「一侧」读数：只取面板与报价需要的四项，不整份 `EstimateSummary` 回传（响应体一半是公式中间量） */
function whatIfSide(s: EstimateSummary) {
  return {
    directManDays: s.directManDays.expected,
    idealManMonths: s.idealManMonths.expected,
    actualManMonths: s.actualManMonths.expected,
    coefSum: s.coefSum,
    quote: s.quote,
    phases: s.phases.map((p) => ({ phase: p.phase, expected: p.expected, idealManMonth: p.idealManMonth, ratio: p.ratio })),
  };
}

/**
 * §7「影响试算」通道：`coefs` / `manDaysPerManMonth` 覆盖 + 逐行三点覆盖 → 前后对比，**一条写入都没有**。
 * 先例是 E4 的推导预览（`POST /derive` 的 `dryRun` 与 `caseWeightK` 覆盖）——「不落库先看数」的语义已经成立，
 * E9 不再发明第二种试算态。校验复用 `resolveEstimateConfig`：与 `PUT /params` 同一把尺子（范围、非法值文案），
 * 否则试算能过的值真写参数时会被拒，用户看到的就是一致性 bug。
 */
estimateApi.post('/what-if', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const b = body(req);
    const kv = readKv(projectId);
    const config = resolveEstimateConfig(kv);
    const { rows } = engineRows(projectId);

    const merged: Record<string, string | null> = { ...kv };
    const coefsIn = (b.coefs ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(coefsIn)) {
      if (!(ESTIMATE_COEF_KEYS as readonly string[]).includes(k)) {
        throw new Error(`未知调节系数：${k}（可用 ${ESTIMATE_COEF_KEYS.join(' / ')}）`);
      }
      merged[ESTIMATE_COEF_SETTING_KEYS[k as EstimateCoefKey]] = String(v);
    }
    if (b.manDaysPerManMonth !== undefined && b.manDaysPerManMonth !== null && String(b.manDaysPerManMonth).trim() !== '') {
      merged[ESTIMATE_SETTING_KEYS.manDaysPerManMonth] = String(b.manDaysPerManMonth);
    }
    const configAfter = resolveEstimateConfig(merged);

    const rowsIn = Array.isArray(b.rows) ? (b.rows as Array<Record<string, unknown>>) : [];
    const overrides = new Map<string, ThreePoints>();
    for (const r of rowsIn) {
      const planId = str(r.planId);
      if (!planId) throw new Error('试算行缺 planId');
      if (!rows.some((x) => x.key === planId)) throw new Error(`试算行不属于该项目的在架计划：${planId}`);
      const pts: ThreePoints = { optimistic: Number(r.optimistic), likely: Number(r.likely), pessimistic: Number(r.pessimistic) };
      const err = pointsError(pts.optimistic, pts.likely, pts.pessimistic);
      if (err) throw new Error(`试算行「${planId}」：${err}`);
      overrides.set(planId, pts);
    }

    const before = buildSummary(rows, config);
    const after = buildSummary(
      rows.map((r) => (overrides.has(r.key) ? { ...r, points: overrides.get(r.key) as ThreePoints } : r)),
      configAfter,
    );
    const round = (n: number) => Math.round(n * 1e4) / 1e4;
    const diff = round(after.actualManMonths.expected - before.actualManMonths.expected);
    return {
      projectId,
      before: whatIfSide(before),
      after: whatIfSide(after),
      delta: {
        actualManMonths: diff,
        // 基数为 0（一条估算都没有）时百分比无意义——返回 null 让面板显示「—」，不编造 100%
        pct: before.actualManMonths.expected === 0 ? null : round((diff / before.actualManMonths.expected) * 100),
        directManDays: round(after.directManDays.expected - before.directManDays.expected),
        phases: after.phases.map((p) => ({
          phase: p.phase,
          before: before.phases.find((x) => x.phase === p.phase)?.expected ?? 0,
          after: p.expected,
          delta: round(p.expected - (before.phases.find((x) => x.phase === p.phase)?.expected ?? 0)),
        })),
      },
      applied: {
        coefs: Object.keys(coefsIn),
        manDaysPerManMonth: configAfter.manDaysPerManMonth !== config.manDaysPerManMonth,
        rows: [...overrides.keys()],
      },
      written: 0,
    };
  }),
);

// ---------- 全量估算（§8 GET /api/estimates：明细 + 汇总 + 参数 + 校验结果） ----------

/**
 * §7 行级变更影响（偏差徽标 / 收口只读 / 排期压力）随 `items` 下发。
 * 判定全在引擎 `rowDriftCheck`（纯函数，日历与「今天」由调用方注入），路由只负责喂数——
 * 面板的「零计算红线」（§5.2）意味着阈值和式子都不能出现在前端，否则面板读数与导出/试算读数
 * 迟早分成两套（`util/planDeps` 双口径的教训）。E 值取 `summary.rowRatios`（含里程碑行），这里不重算 PERT。
 */
function attachDrift(
  items: EstimateView[],
  expectedByPlan: Map<string, number>,
  cal: WorkdayCal,
  today: string,
): Array<EstimateView & { drift: RowDriftResult }> {
  return items.map((it) => ({
    ...it,
    drift: rowDriftCheck(
      {
        expected: expectedByPlan.get(it.plan_id) ?? null,
        durationDays: it.durationDays,
        endDate: it.endDate,
        planKind: it.planKind,
        planStatus: it.planStatus,
        planProgress: it.planProgress,
      },
      cal,
      today,
    ),
  }));
}

/**
 * §7「上次导出后 N 条计划已变化 → 建议重导」：与**最近一条快照**的 `created_at` 比时间戳。
 * 两侧时间戳都由服务层 `new Date().toISOString()` 写入（`EstimateService.now()` / `PlanService.now()`
 * 同格式才可比），故用字符串比较而不 `Date.parse`——历史脏值被解析成 NaN 会静默当成「没变」。
 * 计划侧与估算侧都查：只查计划会漏掉「导出后又改了 O/M/P」这种最该重导的情况。
 */
function changedSinceExport(projectId: string) {
  const last = EstimateService.listSnapshots(projectId, 1)[0];
  if (!last) return { snapshotId: null, at: '', count: 0, rows: [] };
  const cutoff = last.created_at;
  const rows = EstimateService.plansForDrift(projectId)
    .filter((p) => p.planUpdatedAt > cutoff || p.estimateUpdatedAt > cutoff)
    .map((p) => ({
      planId: p.planId,
      title: p.title,
      kind: p.kind,
      planUpdatedAt: p.planUpdatedAt,
      estimateUpdatedAt: p.estimateUpdatedAt,
      // 点名「改了排期还是改了估算」，两者都改就都列
      changed: [p.planUpdatedAt > cutoff ? 'plan' : null, p.estimateUpdatedAt > cutoff ? 'estimate' : null].filter(Boolean),
    }));
  return { snapshotId: last.id, at: cutoff, count: rows.length, rows };
}

/**
 * GET / 的取数体，抽成导出函数是给 MCP `mtask_get_estimates` 用的（E10）：
 * 外部 Agent 取估算汇总如果另走一套组装，`includeArchived` 只影响 `items` 不影响 `summary`
 * 这类实测校正就会在两处各自漂移（§3.1 口径）。
 */
export function estimatesSnapshot(projectId: string, opts: { includeArchived?: boolean } = {}) {
  const includeArchived = opts.includeArchived === true;
  const kv = readKv(projectId);
  const config = resolveEstimateConfig(kv);
  const items = EstimateService.listByProject(projectId, { includeArchived });
  const { rows, estimated } = engineRows(projectId);
  const summary = buildSummary(rows, config);
  const cov = coverage(projectId);
  const cal = workdayCalendar();
  const today = fmtDate(new Date());
  const withDrift = attachDrift(items, new Map(summary.rowRatios.map((r) => [r.key, r.expected])), cal, today);
  return {
    projectId,
    items: withDrift,
    summary,
    params: { config, caseWeightK: effectiveCaseK(projectId), settings: kv },
    meta: ESTIMATE_META,
    checks: {
      ratioCheck: summary.ratioCheck,
      coverage: cov,
      estimated,
      visiblePlans: rows.length,
      // 「脱离计划」是 INNER JOIN 看不见的那批，只能由库里反查给出（§7）
      detached: cov.detached,
      drift: {
        today,
        thresholds: { high: DURATION_RATIO_HIGH, low: DURATION_RATIO_LOW },
        high: withDrift.filter((i) => i.drift.flag === 'high').length,
        low: withDrift.filter((i) => i.drift.flag === 'low').length,
        locked: withDrift.filter((i) => i.drift.locked).length,
        pressure: withDrift.filter((i) => i.drift.pressure).length,
      },
      changedSinceExport: changedSinceExport(projectId),
    },
  };
}

estimateApi.get('/', (req, res) =>
  wrap(res, () => estimatesSnapshot(pid(req), { includeArchived: truthy(req.query.includeArchived) })),
);

// ---------- Excel 导出（§6.1 · E6）----------

/**
 * 估算人取值键。
 * ⚠ PRD §6.1 原文写的是 `estimate_settings.reviewer`，但库里没有这张表——估算参数全部走
 * `app_settings` 的扁平 KV，§3.3 的八键里也不含署名项。这里按「单键读取、不进 §3.3 的生效值
 * 试算与 `settingKeys` 面」落地（无值即留空由用户手填，正是 §6.1 给的「或留空」分支）；
 * E7 的 PDF 件要印这一署名，所以 `PUT /params` 放行这一个键作为写入通道（T02044）。
 * **T02086 裁决「不进」**（口径：PRD §6.1 署名行 + §11-E13 裁决条）：E13 参数页**不出现**
 * 「估算人」输入框——本键保留的只有这条 API 级写入通道，不进参数页、不进生效值试算；
 * 未配置时导出件 H2 留空由用户手填，不写「（待填写）」这类假名。
 */
const ESTIMATE_REVIEWER_KEY = 'estimate.reviewer';

/** 导出文件名时间戳 `YYYYMMDD-HHmmss`（§6.3 命名口径；用本地时钟而非 ISO 切片，避免报价件上的时间比客户所在时区早 8 小时） */
function exportStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * `phases` 查询串（§6.1「一个参数只表一件事」）。
 * 未知阶段必须报错而不是忽略——静默吞掉会让「只导开发段」实际导出全部，报价件的范围悄悄变了。
 */
export function parsePhases(raw: unknown): EstimatePhase[] {
  const s = str(raw);
  if (!s) return [...ESTIMATE_META.phases];
  const list: EstimatePhase[] = [];
  for (const piece of s.split(',')) {
    const x = piece.trim();
    if (!x) continue;
    if (!(ESTIMATE_META.phases as readonly string[]).includes(x)) {
      throw new Error(`未知阶段：${x}（可用 ${ESTIMATE_META.phases.join(' / ')}）`);
    }
    const p = x as EstimatePhase;
    if (!list.includes(p)) list.push(p);
  }
  if (list.length === 0) throw new Error('phases 不能为空（不传即导全部阶段）');
  return list;
}

export function parseScope(raw: unknown): EstimateExportScope {
  const s = str(raw);
  if (!s) return 'all';
  if (!(ESTIMATE_EXPORT_SCOPES as readonly string[]).includes(s)) {
    throw new Error(`未知导出范围：${s}（可用 ${ESTIMATE_EXPORT_SCOPES.join(' / ')}）`);
  }
  return s as EstimateExportScope;
}

export function parseAudience(raw: unknown): EstimateAudience {
  const s = str(raw);
  if (!s) return 'internal';
  if (s !== 'internal' && s !== 'client') throw new Error(`未知导出版本：${s}（可用 internal / client）`);
  return s;
}

/** `req_ids` 是 JSON 数组文本（与 `EstimateDerive` 的私有解析器同一语义） */
function parseReqIds(json: string | null | undefined): string[] {
  try {
    const a = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && !!x) : [];
  } catch {
    return [];
  }
}

/**
 * C 列（中模块）= 明细行归属的里程碑标题。
 * ⚠ 归属判定**不能**用 `util/planDeps.parsePlanDeps`：它把 type 收窄成 `serial | parallel`
 *   （排水语义），`child` 会被并成 `serial`（PRD §6.1 原文「按 util/planDeps 单源」在实测中不成立）。
 *   与 `PlanService.recalcMilestoneEnvelope`（`PlanService.ts:305`）同一做法——读原始 JSON。
 * 无 child 归属的行留空不合并（§6.1）。
 */
function milestoneTitleByChild(rows: PlanTaskRow[]): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string>();
  for (const r of rows) {
    let deps: unknown;
    try {
      deps = JSON.parse(r.deps || '[]');
    } catch {
      continue; // 脏 deps：跳过归属，不做第二套宽容解析
    }
    if (!Array.isArray(deps)) continue;
    for (const d of deps as Array<{ id?: unknown; type?: unknown }>) {
      if (!d || typeof d.id !== 'string' || d.type !== 'child') continue;
      const ms = byId.get(d.id);
      if (ms && ms.kind === 'milestone') {
        out.set(r.id, ms.title);
        break; // 多个里程碑归属只认第一个（模板 C 列是一行一个模块，不表达多重归属）
      }
    }
  }
  return out;
}

/** 需求编号（附加 sheet 的追溯列）：`req_ids` → `prd_requirements.req_no` */
function reqNoById(projectId: string): Map<string, string> {
  const rows = PlanService.listRequirements(projectId) as Array<{ id?: unknown; req_no?: unknown }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    const id = str(r.id);
    if (id) out.set(id, str(r.req_no));
  }
  return out;
}

/**
 * 导出明细行：次序取 `listPlanSkeletons`（面板/时间线同一份，不引入第二套排序），
 * 三点取 `estimate_items`，描述/复杂度/需求锚点取 `plan_tasks`。
 * 本函数**不过滤**（scope/phases 由 `layoutEstimate` 统一处理），因为附加 sheet 要的是全量行。
 */
function collectExportRows(projectId: string): EstimateExportRow[] {
  const views = new Map(EstimateService.listByProject(projectId, { includeArchived: false }).map((v) => [v.plan_id, v]));
  const plans = PlanService.list(projectId);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const msTitle = milestoneTitleByChild(plans);
  const reqNo = reqNoById(projectId);
  return listPlanSkeletons(projectId).map((s) => {
    const p = planById.get(s.planId);
    const v = views.get(s.planId);
    const nos = parseReqIds(p?.req_ids).map((id) => reqNo.get(id) ?? '').filter(Boolean);
    return {
      planId: s.planId,
      title: s.title,
      detail: cleanDetail(p?.description ?? '', s.title, nos),
      // 没有估算行的计划也要出现在 `scope=all` 的导出里：阶段按标题推断（§4.6 同一函数），
      // 三点留空——留空与「估过 0 天」在报价件上是两回事。
      phase: v ? v.phase : inferPhase(s.title),
      planKind: s.kind,
      milestone: msTitle.get(s.planId) ?? '',
      optimistic: v ? v.optimistic : null,
      likely: v ? v.likely : null,
      pessimistic: v ? v.pessimistic : null,
      source: v ? v.source : '',
      complexity: v ? v.complexity : p?.complexity ?? null,
      reqNos: nos,
    };
  });
}

/**
 * §6.1 / §6.2 的两种交付格式。词表与 `ESTIMATE_SNAPSHOT_FORMATS`（`EstimateService.ts:31`）一致——
 * 快照表从 E1 起就留了 `pdf`，本次只是终于有人往里写。
 */
export const ESTIMATE_ARTIFACT_FORMATS = ['xlsx', 'pdf'] as const;
export type EstimateArtifactFormat = (typeof ESTIMATE_ARTIFACT_FORMATS)[number];

export interface EstimateArtifactOptions {
  scope: EstimateExportScope;
  audience: EstimateAudience;
  phases: EstimatePhase[];
}

/** 导出产物：件名与快照 id 由服务端一次定死（§6.3 响应头契约），前端与 MCP 都不再拼第二套 */
export interface EstimateArtifact extends EstimateArtifactOptions {
  projectId: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
  snapshotId: string;
  /** 出数用的行落位（断言与 MCP 摘要读它，不在别处重算） */
  layout: EstimateLayout;
}

const ARTIFACT_CONTENT_TYPES: Record<EstimateArtifactFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/**
 * **导出流水线唯一实现处**：取明细行 → 解析参数 → `layoutEstimate` → 按格式出字节 → 写快照。
 *
 * 为什么是 `async`（与本页其余 `wrap()` 同步约定不同）：xlsx/pdf 构建器都按既有惯例动态 import
 * （重依赖不进首屏），`buildEstimateXlsx` / `buildPrdPdf` 本身也是 `Promise<Buffer>`。
 * 三个调用方（`/export-xlsx`、`/export-pdf`、MCP `mtask_export_estimate_workload`）走同一条，
 * 于是「预览件与交付件数字不一致」「MCP 取到的件名与界面下载的不是一个」这类问题在结构上不会发生。
 */
export async function buildEstimateArtifact(
  projectId: string,
  format: EstimateArtifactFormat,
  opts: EstimateArtifactOptions,
): Promise<EstimateArtifact> {
  const { scope, audience, phases } = opts;
  const rows = collectExportRows(projectId);
  const config = resolveEstimateConfig(readKv(projectId));
  const project = PlanService.getProjectBrief(projectId);
  const nowDate = new Date();
  const layout = layoutEstimate({
    projectId,
    projectName: project.name,
    estimateDate: nowDate.toISOString().slice(0, 10),
    reviewer: str(getSetting(ESTIMATE_REVIEWER_KEY)),
    rows,
    config,
    scope,
    phases,
    audience,
    generatedAt: nowDate.toISOString(),
  });
  // 两种格式都只在「拿到 layout 之后」分叉：分叉点之前没有任何按格式改数据的余地
  const buffer = format === 'pdf'
    ? await (await import('../services/estimateExportPdf')).buildEstimatePdf(layout)
    : await (await import('../services/estimateExportXlsx')).buildEstimateXlsx(layout);
  const fname =
    safeExportName(
      `工作量评估${audience === 'client' ? '-客户版' : ''}-${project.name}-${exportStamp(nowDate)}`,
      '工作量评估',
    ) + `.${format}`;
  // §6.3：全部导出写快照（payload 存汇总结果，供「上次导出后计划已变化」比对）
  const snapshot = EstimateService.createSnapshot(projectId, {
    format,
    filename: fname,
    payload: {
      projectId,
      projectName: project.name,
      scope,
      audience,
      // §7 比对器 `diffSnapshots` 读的是**顶层** `phases`（逐阶段 E/人月）与顶层
      // `directManDays` / `actualManMonths`（E3 起的既成契约，见 verify-t02037 的 payloadOf）。
      // 导出用的阶段筛选因此改名 `phaseFilter`——同名字段两种含义正是比对器静默出空表的成因。
      phaseFilter: phases,
      phases: layout.summary.phases,
      directManDays: layout.summary.directManDays,
      actualManMonths: layout.summary.actualManMonths,
      estimateDate: layout.input.estimateDate,
      generatedAt: layout.input.generatedAt,
      detailRows: rows.length,
      mainRows: layout.devRows.length + layout.phaseRows.filter((p) => p.points).length,
      unreviewed: layout.unreviewed,
      milestoneSkipped: layout.milestoneSkipped,
      merges: layout.merges.length,
      summary: layout.summary,
    },
  });
  return {
    projectId, scope, audience, phases, filename: fname,
    contentType: ARTIFACT_CONTENT_TYPES[format], buffer, snapshotId: snapshot.id, layout,
  };
}

/** 导出端点公共收尾：§6.3 的两个响应头由这里写，两个端点都不许自己 `setHeader` */
function sendArtifact(res: import('express').Response, a: EstimateArtifact): void {
  res.setHeader('Content-Type', a.contentType);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.setHeader('X-Estimate-Snapshot', a.snapshotId);
  res.send(a.buffer);
}

/**
 * §6.1 导出端点。并发闸用 `defer:true`（`export-gate.ts:50` 的实测教训：处理器里有 await 让出点
 * 之外还要保证计数真的反映并发），闸名独立，不与 `plans-export` 顶号。
 * 客户版脱敏发生在**服务端**（§9 安全项：前端隐藏不算脱敏）——不产附加 sheet、不写备注三条，
 * 并按 `estimate.hideCoefsForClient` 把四个系数折叠成一行合计（R40 的 `SUM(X36:X39)` 结果不变，
 * 报价数一分不差，分项依据不再出现在交付件里）。
 */
estimateApi.get(
  '/export-xlsx',
  exportGate('estimates-export-xlsx', undefined, { defer: true }),
  async (req, res) => {
    try {
      sendArtifact(res, await buildEstimateArtifact(pid(req), 'xlsx', {
        scope: parseScope(req.query.scope),
        audience: parseAudience(req.query.audience),
        phases: parsePhases(req.query.phases),
      }));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

/**
 * §6.2 PDF 端点（E7）。参数词表、并发闸形态、响应头与 `/export-xlsx` 完全一致——
 * E6 的实测补充明写「E7 的 PDF 端点请沿用同一对响应头，别再开第三种取件名通道」。
 * PDF 定位为汇报/预览件（裁决 D4，正式交付以 Excel 为准），脱敏同样发生在服务端组装的
 * `estimate-report.md` 阶段：客户版正文里根本不出现系数分项、σ/置信区间、备注三条与附加 sheet 名。
 */
estimateApi.get(
  '/export-pdf',
  exportGate('estimates-export-pdf', undefined, { defer: true }),
  async (req, res) => {
    try {
      sendArtifact(res, await buildEstimateArtifact(pid(req), 'pdf', {
        scope: parseScope(req.query.scope),
        audience: parseAudience(req.query.audience),
        phases: parsePhases(req.query.phases),
      }));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// ---------- 单行（须最后注册，避免吃掉静态路径） ----------
estimateApi.patch('/:planId', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const b = body(req);
    const input: EstimateInput = {
      phase: b.phase as EstimateInput['phase'],
      unit: b.unit as EstimateInput['unit'],
      optimistic: b.optimistic as EstimateInput['optimistic'],
      likely: b.likely as EstimateInput['likely'],
      pessimistic: b.pessimistic as EstimateInput['pessimistic'],
      source: (() => {
        const s = b.source as EstimateInput['source'];
        if (s !== undefined) return s;
        // §4.6「人工改过即转 manual」：PATCH 就是人工录入通道，规则/默认行被改后必须转 manual，
        // 否则复核率（§9 上线度量）会把「人已改过」的行继续算成「未复核的机器值」。
        // 缺省沿用原值的语义仍归 `EstimateService`（E1），这里只补路由层的来源标注。
        const prev = EstimateService.getForPlan(projectId, req.params.planId);
        return prev && prev.source !== 'manual' ? 'manual' : undefined;
      })(),
      note: b.note as EstimateInput['note'],
      // §7 收口里程碑只读行的显式解锁：真值判定在 `EstimateService`（写路径唯一闸门），
      // 路由只将原始入参透传——在这里 `truthy()` 一次、服务里再判一次就会分叉。
      unlock: b.unlock,
    };
    return { projectId, planId: req.params.planId, item: EstimateService.upsert(projectId, req.params.planId, input) };
  }),
);

estimateApi.delete('/:planId', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    // 删除同样受 §7 只读闸门管——「改不动就删了重建」会让只读化形同虚设
    const unlock = unlockFlag(req.query.unlock ?? body(req).unlock);
    return { projectId, planId: req.params.planId, removed: EstimateService.remove(projectId, req.params.planId, { unlock }) };
  }),
);
