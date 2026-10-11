/**
 * 估算视图路由（E3 · PRD-估算视图与工作量评估导出 §8）。
 *
 * 沿用 `planApi` 的约定（`wrap` / `pid` / 静态路径先于 `:id`，见 `routes/plans.ts:13-44`），
 * 不另起一套错误口径。本文件**不含任何计算**：三点校验与 CRUD 在 `EstimateService`，
 * PERT/汇总/参数解析在 `estimate-engine.ts`，三档推导在 `EstimateDerive`——
 * 路由只做参数收口与响应组装（§9「枚举与计算单源」）。
 *
 * 导出端点（export-xlsx / export-pdf）属 E6/E7，本文件不留占位路由。
 */
import { Router } from 'express';
import { getSetting, setSetting } from '../services/AppSettings';
import { EstimateService, ESTIMATE_META, type EstimateInput } from '../services/EstimateService';
import {
  DEFAULT_ESTIMATE_CONFIG,
  ESTIMATE_COEF_LABELS,
  ESTIMATE_COEF_SETTING_KEYS,
  ESTIMATE_SETTING_KEYS,
  buildSummary,
  resolveEstimateConfig,
  toEngineRow,
  type EstimateEngineRow,
} from '../services/estimate-engine';
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
    const allowed = new Set([...Object.values(ESTIMATE_SETTING_KEYS), SETTINGS_KEY_CASE_K, `${SETTINGS_KEY_CASE_K_PROJECT}${projectId}`]);
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

// ---------- 全量估算（§8 GET /api/estimates：明细 + 汇总 + 参数 + 校验结果） ----------
estimateApi.get('/', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    const includeArchived = truthy(req.query.includeArchived);
    const kv = readKv(projectId);
    const config = resolveEstimateConfig(kv);
    const items = EstimateService.listByProject(projectId, { includeArchived });
    const { rows, estimated } = engineRows(projectId);
    const summary = buildSummary(rows, config);
    const cov = coverage(projectId);
    return {
      projectId,
      items,
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
      },
    };
  }),
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
    };
    return { projectId, planId: req.params.planId, item: EstimateService.upsert(projectId, req.params.planId, input) };
  }),
);

estimateApi.delete('/:planId', (req, res) =>
  wrap(res, () => {
    const projectId = pid(req);
    return { projectId, planId: req.params.planId, removed: EstimateService.remove(projectId, req.params.planId) };
  }),
);
