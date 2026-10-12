/**
 * 估算面板（T02039 · PRD-估算视图与工作量评估导出 §5.1/§5.2，交付拆解 E4 首段）。
 *
 * 三条口径红线：
 * ① **零计算**：本文件不做任何三点运算（E/σ/汇总/比例一律读服务端 `summary`，
 *    逐行 σ 由 `rowRatios` 下发）。前端自算一次，「面板汇总 = 模板 H35」（§10-14）
 *    就从断言退化成两套实现的巧合一致——这正是本仓 planDeps 双口径踩过的坑。
 * ② **分组单源**：明细行的里程碑分组直接复用时间线的 `groupTimelinePhases`，
 *    折叠态与列表/甘特共用同一份 `plan.collapsedMs`（T01576 口径），面板不自造第三套分组。
 * ③ **三点运算零本地实现**（T02040 起本面板可写，但写路径仍不含运算）：行内录入走 PATCH、
 *    批量填充走 `mode=derive` / `mode=set`，`O>M` 之类的不合格值**由服务端拒**（400 + 中文文案），
 *    面板只是把那行标红——前端不复写一份 `pointsError`，否则「谁被拒」会变成两套判据。
 *    改完即时重取 `GET /api/estimates`：E/σ/汇总卡的新值仍由服务端算（§10-3 的「即时刷新」）。
 * ④ 区间条（§5.4 P0，T02041）只做**排版几何**：O/P/E 三个数一律取服务端那一份，
 *    `whiskerGeometries()` 里唯一的除法是「按明细行最大 P 归一成百分比宽度」，不含任何 E/σ 公式。
 *    导出区（§5.2 第 4 段）Excel 侧随 E6/T02043 交付；PDF 属 E7，本文件不预留空壳按钮。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { groupTimelinePhases, type TlPlan } from './PlanTimeline';
import { api } from '../api/client';
import {
  estimatesApi, parseSnapshotPayload, toGrid,
  type DeriveItem, type DeriveRule, type EstimateExportAudience, type EstimateExportOptions, type EstimateExportScope, type EstimateItem, type EstimateInput,
  type EstimateSnapshot, type EstimateSource, type EstimatesResponse, type SnapshotDiff,
} from '../api/estimates';
import { saveBlob } from '../utils/download';
import { askConfirm } from '../ui/dialogs';

/** PRD §5.1：docked 分栏宽 420；<1200px 转 SlideOver 时沿用同宽（两处共用一个常量） */
export const ESTIMATE_PANEL_WIDTH = 420;

/** 明细列的数字字体与右对齐口径（与 ResultDiff/时间线同一套 11~12px 阶梯） */
const MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, monospace';

/** 来源徽标：人工=已复核，规则/默认=机器值待复核（§9 上线度量「复核率」的界面读数） */
export const SOURCE_BADGE: Record<EstimateSource | 'none', { label: string; color: string }> = {
  manual: { label: '人工', color: 'var(--success)' },
  rule: { label: '规则', color: 'var(--accent)' },
  default: { label: '默认', color: 'var(--text-muted)' },
  none: { label: '未录入', color: 'var(--border-strong)' },
};

/** §10-2：未落库的行走三档推导给「默认」值，徽标要能看出是哪一档推出来的 */
export const RULE_LABEL: Record<DeriveRule, string> = {
  complexity: '默认·复杂度',
  caseWeight: '默认·用例',
  duration: '默认·工期',
};

/** §5.3 批量填充的档位入口文案（与 `RULE_LABEL` 同一批档名，不另起一套叫法） */
export const BATCH_RULE_LABEL: Record<DeriveRule, string> = {
  complexity: '按复杂度重推',
  caseWeight: '按用例加权重推',
  duration: '按工期重推',
};

/** 服务端 `DERIVE_SKIPS` 的中文说明：跳过原因由服务端判定，面板只翻译，不第二次判定 */
export const SKIP_LABEL: Record<string, string> = {
  milestone: '里程碑行不落估算',
  exists: '已有估算行（scope=missing 只补空的）',
  manual: '人工复核过的行不覆盖',
  offRule: '不属于所选推导档',
};

const num = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
/** `ratioCheck.deviationPct` 服务端已是「百分数」本身（2.3 = 2.3%），不能再过一遍 pct */
const devPct = (v: number): string => `${(Math.round(v * 10) / 10).toFixed(1)}%`;

/** 服务端 400 的中文文案直接上屏（`wrap()` 统一 `{ error }`，`api` 客户端已抛成 Error.message） */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 按跳过原因计数（响应里的 `skipped` 是唯一来源，面板不再判一次该不该跳） */
const countSkip = (resp: { skipped: Array<{ skip: string }> }, kind: string): number =>
  resp.skipped.filter((s) => s.skip === kind).length;

/** 面板明细行（服务端三份数据合成一张表：估算行 / 推导建议 / 逐行期望值） */
export interface PanelRow {
  planId: string;
  title: string;
  kind: string;
  complexity: number | null;
  reqNos: string[];
  phase: string;
  optimistic: number | null;
  likely: number | null;
  pessimistic: number | null;
  expected: number | null;
  sigma: number | null;
  badge: { label: string; color: string };
  /** true=未落库的推导建议（灰显 + 不可当报价依据） */
  suggestion: boolean;
  /** 有估算行落库（T02040 行内录入要区分「改已有行」与「把建议值变成行」——后者 PATCH 得给全三点+阶段） */
  persisted: boolean;
  /** 估算行的来源；未落库为 'none'（「只看未复核」筛选与撤销都按它判，不靠徽标文案猜） */
  source: EstimateSource | 'none';
  /** 徽标/数值的悬停说明：已落库行取 note，建议行取推导依据 */
  tip: string;
  /** 里程碑行：值照样显示但不进 Σ（§4.6 红线一） */
  inSigma: boolean;
}

/**
 * 三份来源 → 明细行（纯函数，供 verify 脚本直接断言，不经 DOM）。
 * 取值优先级：已落库估算行 > 推导建议 > 空；逐行 E/σ 只认服务端 `rowRatios`，
 * 建议行的 E 用推导响应里自带的 expected（同样是服务端算的），σ 则无（未落库不算不确定度）。
 */
export function buildPanelRows(
  plans: ReadonlyArray<TlPlan>,
  items: ReadonlyArray<EstimateItem>,
  derives: ReadonlyArray<DeriveItem>,
  rowRatios: ReadonlyArray<{ key: string; expected: number; sigma: number }>,
  reqNosByPlan: Readonly<Record<string, string[]>>,
): PanelRow[] {
  const byPlan = new Map(items.map((i) => [i.plan_id, i]));
  const byDerive = new Map(derives.map((d) => [d.planId, d]));
  const byRatio = new Map(rowRatios.map((r) => [r.key, r]));
  return plans.map((p) => {
    const it = byPlan.get(p.id);
    const dv = byDerive.get(p.id);
    const rr = byRatio.get(p.id);
    const base = {
      planId: p.id,
      title: p.title,
      kind: p.kind ?? 'normal',
      complexity: p.complexity ?? null,
      reqNos: reqNosByPlan[p.id] ?? [],
      phase: it?.phase ?? dv?.phase ?? '',
      inSigma: (p.kind ?? 'normal') !== 'milestone',
    };
    if (it) {
      return {
        ...base,
        optimistic: it.optimistic,
        likely: it.likely,
        pessimistic: it.pessimistic,
        expected: rr?.expected ?? null,
        sigma: rr?.sigma ?? null,
        badge: SOURCE_BADGE[it.source] ?? SOURCE_BADGE.none,
        suggestion: false,
        persisted: true,
        source: it.source,
        tip: it.note || `已落库估算行（${SOURCE_BADGE[it.source]?.label ?? it.source}）`,
      };
    }
    if (dv) {
      return {
        ...base,
        optimistic: dv.optimistic,
        likely: dv.likely,
        pessimistic: dv.pessimistic,
        expected: dv.expected,
        sigma: null,
        badge: { label: RULE_LABEL[dv.rule], color: SOURCE_BADGE.default.color },
        suggestion: true,
        persisted: false,
        source: 'none',
        tip: dv.skip ? `不落库：${SKIP_LABEL[dv.skip] ?? dv.skip}` : dv.note,
      };
    }
    return {
      ...base, optimistic: null, likely: null, pessimistic: null, expected: null, sigma: null,
      badge: SOURCE_BADGE.none, suggestion: false, persisted: false, source: 'none',
      tip: '无估算行，也没有可用的推导依据',
    };
  });
}

/**
 * §5.4 区间条几何（P0，T02041）：把「O——P，中间竖线标 E」换算成容器内百分比。
 *
 * 这是**排版几何**不是估算运算——O/P/E 三个数全部来自服务端那一份，本函数只做「除以参与归一的明细行里最大的 P」
 * 这一处除法（等价于 `left:${x}%` 的宽度换算），不含 E/σ 公式：零计算红线管的是「算式不许有两份」，
 * 这里没有算式。**调用方传全量明细行而非筛后可见行**：换一次筛选就改刻度，同一行的条长会凭空变化（§5.4 v2.0 ②，真机 U-20）。
 * 写成纯函数导出，是为了让 verify 脚本能直接断言归一口径与单调性，不必经 DOM。
 */
export interface WhiskerGeom {
  readonly planId: string;
  /** 归一基数：参与渲染的行里最大的 P（同屏各行长度才可比；至少为 1 防除零） */
  readonly scaleMax: number;
  readonly loPct: number;
  readonly hiPct: number;
  readonly ePct: number;
}

export function whiskerGeometries(rows: readonly PanelRow[]): Map<string, WhiskerGeom> {
  const pts = rows.filter((r) => r.optimistic !== null && r.pessimistic !== null && r.expected !== null);
  const scaleMax = Math.max(1, ...pts.map((r) => r.pessimistic as number));
  const pctOf = (v: number): number => Math.min(100, Math.max(0, (v / scaleMax) * 100));
  return new Map(pts.map((r) => [r.planId, {
    planId: r.planId,
    scaleMax,
    loPct: pctOf(r.optimistic as number),
    hiPct: pctOf(r.pessimistic as number),
    ePct: pctOf(r.expected as number),
  }]));
}

/** PRD §5.1 的形态阈值：视口 <1200px 转覆盖式。写成纯函数是为了让 verify 脚本能断言边界，
 *  而不是把 1199/1200 这两个数只留在 matchMedia 字符串里（§10-13 走查 1200/1440/1920 三档）。 */
export function estimatePanelModeForWidth(width: number): 'docked' | 'overlay' {
  return width < 1200 ? 'overlay' : 'docked';
}

const currentMode = (): 'docked' | 'overlay' =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? 'docked' : estimatePanelModeForWidth(window.innerWidth);

/** 面板挂载形态：<1200px 覆盖式抽屉（PRD §5.1）。监听 resize 而非挂载时读一次——拖动窗口要即时切换。 */
export function useEstimatePanelMode(): 'docked' | 'overlay' {
  const [mode, setMode] = useState<'docked' | 'overlay'>(currentMode);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChange = (): void => setMode(currentMode());
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
  }, []);
  return mode;
}

export interface EstimatePanelProps {
  readonly projectId: string;
  /** 与时间线同源的计划集（未归档）；分组/折叠口径也同源 */
  readonly plans: ReadonlyArray<TlPlan>;
  readonly collapsedMs: Readonly<Record<string, boolean>>;
  readonly onToggleMsCollapse: (id: string) => void;
  readonly onToast: (msg: string) => void;
  /** 覆盖式抽屉自带标题栏，此时隐去面板内标题（同一屏出现两个「估算面板」是噪声） */
  readonly hideHeading?: boolean;
}

/** §5.3 行内编辑的三列（顺序即列顺序；面板与 verify 脚本共用这一份名单） */
export const POINT_FIELDS = ['optimistic', 'likely', 'pessimistic'] as const;
export type PointField = (typeof POINT_FIELDS)[number];
export const POINT_LABEL: Record<PointField, string> = { optimistic: '乐观 O', likely: '最可能 M', pessimistic: '悲观 P' };

/** 正在编辑的单元格（值原样存字符串，交给服务端判「是不是数 / O≤M≤P」） */
interface Draft { planId: string; field: PointField; value: string }

/** 一次批量写入的可撤销记录：写入前每行的原貌（null=当时没有估算行，撤销等价于删行） */
export interface UndoEntry {
  /** 人话标签（进撤销 toast 与提示条 title，如「统一值填充 4 行」） */
  label: string;
  /** 本次实际写入的行数——顶部提示「已填充 N 行 · 撤销」按它出数，与服务端 `written` 同源 */
  count: number;
  before: Array<{ planId: string; snapshot: EstimateInput | null }>;
}

/** 批量填充的三种模式（§5.3）：两档走服务端推导，一档走服务端批量写 */
export type BatchMode = DeriveRule | 'uniform';

/** 已落库行的原貌快照（撤销时按它回写，`source` 一起带上——否则规则行会被「转 manual」洗成人工行） */
export function snapshotRow(r: PanelRow): EstimateInput | null {
  if (!r.persisted) return null;
  const s: EstimateInput = {
    optimistic: r.optimistic ?? undefined,
    likely: r.likely ?? undefined,
    pessimistic: r.pessimistic ?? undefined,
    source: r.source === 'none' ? undefined : r.source,
  };
  if (r.phase) s.phase = r.phase as EstimateInput['phase'];
  return s;
}

/**
 * 「统一值 + 相对幅度」模式的三点生成（§5.3 模式 ③）。
 * 只算 `M×倍率` 这一件输入侧的事，落 0.5 网格用 `toGrid`（服务端同语义镜像）；
 * 不碰 E/σ——那仍是服务端 `expected()` 的独占口径。倍率缺省取服务端下发的 `ruleRatio`。
 */
export function uniformPoints(m: number, oMul: number, pMul: number): { optimistic: number; likely: number; pessimistic: number } {
  return { optimistic: toGrid(m * oMul), likely: toGrid(m), pessimistic: toGrid(m * pMul) };
}

export function EstimatePanel({ projectId, plans, collapsedMs, onToggleMsCollapse, onToast, hideHeading = false }: EstimatePanelProps) {
  const [data, setData] = useState<EstimatesResponse | null>(null);
  const [derives, setDerives] = useState<DeriveItem[]>([]);
  const [reqNosByPlan, setReqNosByPlan] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deriveBusy, setDeriveBusy] = useState(false);
  // ---------- T02040（§5.3）：行内录入 / 批量填充 / 撤销 / 只看未复核 ----------
  const [draft, setDraft] = useState<Draft | null>(null);
  /** planId → 服务端拒绝文案。判定权在服务端：面板不复写 `pointsError`，只把被拒的行标红 */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [selIds, setSelIds] = useState<string[]>([]);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [uniformOpen, setUniformOpen] = useState(false);
  const [uniform, setUniform] = useState<{ m: string; oMul: string; pMul: string }>({ m: '', oMul: '', pMul: '' });
  // ---------- T02043（§5.2 第 4 段）：导出区 ----------
  const [audience, setAudience] = useState<EstimateExportAudience>('internal');
  /** §6.1 的 `scope` 只管「是否仅已估算行」，阶段筛选另有 `phases` 参数（面板暂不暴露，导出即全六阶段） */
  const [estimatedOnly, setEstimatedOnly] = useState(false);
  // 三种出件（Excel / PDF 内部版 / PDF 客户版）共用一条并发闸，但「导出中…」只标在被点的那枚上——
  // 三枚按钮同时亮同一个词等于让界面说不清此刻在出哪份件
  const [exportingKind, setExportingKind] = useState<'xlsx' | 'pdf' | null>(null);
  const exporting = exportingKind !== null;
  const [snapshots, setSnapshots] = useState<EstimateSnapshot[]>([]);
  const [snapshotError, setSnapshotError] = useState('');
  const [cmpIds, setCmpIds] = useState<string[]>([]);
  const [cmpDiff, setCmpDiff] = useState<{ a: EstimateSnapshot; b: EstimateSnapshot; diff: SnapshotDiff } | null>(null);
  const [lastExport, setLastExport] = useState<{ filename: string; unreviewed: number } | null>(null);
  /** 同一格同一个被拒值不重复打接口（失焦是常态，否则一次错误输入会刷 N 次 400） */
  const rejectedSent = useRef<Set<string>>(new Set());

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [all, dv, matrix] = await Promise.all([
        estimatesApi.getAll(projectId),
        estimatesApi.derivePreview(projectId),
        // 需求编号列（§5.2）取需求矩阵现成接口，不为其加服务端字段
        api.get<Array<{ req_no: string; linkedPlans: Array<{ id: string }> }>>(
          `/plans/prd-requirements?projectId=${encodeURIComponent(projectId)}`,
        ),
      ]);
      setData(all);
      setDerives(dv.items);
      const map: Record<string, string[]> = {};
      for (const r of matrix) for (const lp of r.linkedPlans ?? []) (map[lp.id] ??= []).push(r.req_no);
      setReqNosByPlan(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  /** §6.3 快照列表（导出区下方「最近 5 次」）：失败只影响这一小块，不连带整面板进错误态 */
  const loadSnapshots = useCallback(async (): Promise<void> => {
    try {
      const r = await estimatesApi.listSnapshots(projectId);
      setSnapshots(r.snapshots);
      setSnapshotError('');
    } catch (e) {
      setSnapshots([]);
      setSnapshotError(errMsg(e));
    }
  }, [projectId]);
  useEffect(() => { void loadSnapshots(); }, [loadSnapshots]);

  const rows = useMemo(
    () => buildPanelRows(plans, data?.items ?? [], derives, data?.summary.rowRatios ?? [], reqNosByPlan),
    [plans, data, derives, reqNosByPlan],
  );
  const rowById = useMemo(() => new Map(rows.map((r) => [r.planId, r])), [rows]);
  const phases = useMemo(() => groupTimelinePhases(plans), [plans]);
  // §5.4 区间条按**全部明细行**归一，不按「只看未复核」筛后的可见行：换一次筛选就改刻度，
  // 同一行的条长会凭空变化，读者以为是估算变了——实际变的只是谁被遮住。
  const whisker = useMemo(() => whiskerGeometries(rows), [rows]);

  /** 空态：一条估算都没落库（未录入 ≠ 全为 default——default 行也要先经「按规则推导」写入才存在） */
  const isEmpty = !loading && !error && (data?.items.length ?? 0) === 0;

  async function fillByRules(): Promise<void> {
    setDeriveBusy(true);
    try {
      const preview = await estimatesApi.derivePreview(projectId);
      const n = preview.writableCount;
      if (n === 0) { onToast('没有可推导的行（可能全部已录入或均为里程碑）'); return; }
      const go = await askConfirm(
        `将按 §4.6 三档规则写入 ${n} 行初始估算值（里程碑与人工行不动）。\n`
        + `用例加权档的 k=${preview.caseWeightK}（来源：${preview.caseWeightKFrom}）。\n预览行数与写入行数同源，确认即写入？`,
      );
      if (!go) return;
      const w = await estimatesApi.deriveWrite(projectId);
      onToast(`已按规则推导写入 ${w.written ?? 0} 行${(w.errors?.length ?? 0) > 0 ? `，${w.errors?.length} 行被拒` : ''}`);
      await load();
    } catch (e) {
      onToast(`推导失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeriveBusy(false);
    }
  }

  /** 可见行（「只看未复核」= source≠manual：规则/默认/未录入都算待复核，§5.2 状态要求） */
  const visibleRows = useMemo(
    () => rows.filter((r) => !onlyUnreviewed || r.source !== 'manual'),
    [rows, onlyUnreviewed],
  );
  /** 批量填充的作用域：可见 + 非里程碑（里程碑行服务端也不落估算，红线下不放进候选） */
  const batchableIds = useMemo(
    () => visibleRows.filter((r) => r.kind !== 'milestone').map((r) => r.planId),
    [visibleRows],
  );
  const selRows = useMemo(
    () => selIds.map((id) => rowById.get(id)).filter((r): r is PanelRow => !!r && r.kind !== 'milestone'),
    [selIds, rowById],
  );

  const toggleSel = (id: string): void =>
    setSelIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const selectAllVisible = (): void => setSelIds(batchableIds);

  /** 一次批量写入的可撤销记录（原值取**写入前**的行快照，连 `source` 一起带上才谈得上还原） */
  function pushUndo(label: string, count: number, before: Array<{ planId: string; snapshot: EstimateInput | null }>): void {
    if (before.length === 0) return;
    setUndoStack((p) => [...p, { label, count, before }]);
  }

  /**
   * 单格保存（§5.3：Enter / 失焦即 PATCH）。
   * 值的合法性一律交服务端：`O>M`、负数、非数字都由 400 中文文案回，面板只把该行标红——
   * 前端再判一遍就是两套判据（同 §9 计算单源，也同 E4 首段的零计算红线）。
   */
  async function commitDraft(d: Draft | null): Promise<void> {
    setDraft(null);
    if (!d) return;
    const r = rowById.get(d.planId);
    if (!r) return;
    const raw = d.value.trim();
    // 清空 = 取消这次编辑：0 人天是一条真实报价，不该由误触落库
    if (raw === '') return;
    const key = `${d.planId}|${d.field}|${raw}`;
    if (rejectedSent.current.has(key)) return; // 同一个被拒值不重打接口（失焦会连着触发）
    if (r.persisted && String(r[d.field] ?? '') === raw) {
      setRowErrors((p) => {
        if (!(d.planId in p)) return p;
        const n = { ...p };
        delete n[d.planId];
        return n;
      });
      return;
    }

    const input: EstimateInput = {};
    if (r.persisted) {
      input[d.field] = raw; // 单字段 PATCH：另外两点由服务端沿用原值（§8 PATCH 语义）
    } else {
      // 建议行落库=新建估算行，三点必填才过得了服务端校验；未编辑的两点继承推导值
      for (const f of POINT_FIELDS) {
        const v = f === d.field ? raw : r[f];
        if (v === null || v === undefined) {
          onToast(`该行没有可继承的推导值，请把「${POINT_LABEL[f]}」一起填上`);
          return;
        }
        input[f] = v;
      }
      if (r.phase) input.phase = r.phase as EstimateInput['phase'];
    }

    setBusy(true);
    try {
      await estimatesApi.patchItem(projectId, d.planId, input);
      rejectedSent.current.delete(key);
      setRowErrors((p) => {
        if (!(d.planId in p)) return p;
        const n = { ...p };
        delete n[d.planId];
        return n;
      });
      await load(); // E/σ/汇总卡的新值仍由服务端算（§10-3「即时刷新」的实现方式）
    } catch (e) {
      rejectedSent.current.add(key);
      setRowErrors((p) => ({ ...p, [d.planId]: errMsg(e) }));
      // 被拒的值留在格子里：清掉它就逼用户重打一遍，而红框+行内文案已经说明了为什么没进去。
      // 连着触发的失焦不会重打接口——`rejectedSent` 按 planId|field|value 拦。
      setDraft(d);
    } finally {
      setBusy(false);
    }
  }

  /** 打开「统一值 + 相对幅度」表单：倍率预填服务端下发的 `ruleRatio`，面板不自带一套经验值 */
  function openUniform(): void {
    const ratio = data?.params.config.ruleRatio;
    setUniform({ m: '', oMul: ratio ? String(ratio.oMul) : '', pMul: ratio ? String(ratio.pMul) : '' });
    setUniformOpen(true);
  }

  /**
   * 批量填充（§5.3 三模式）：预览 → `askConfirm` → 写入 → 压撤销栈。
   * 模式 ①② 走 `mode=derive` + `onlyRule`：**过滤不是强制改算式**——某行的自然择档不是它时
   * 服务端整行跳过（`skip='offRule'`），面板如实报「N 行不属于该档」。没有复杂度档的行被
   * 「按复杂度」硬填出数来就是假数据，这条是本次实施给服务端补的口径。
   */
  async function runBatch(mode: BatchMode): Promise<void> {
    if (selRows.length === 0) { onToast('先勾选要批量填充的行（里程碑行不参与）'); return; }
    setBusy(true);
    try {
      if (mode === 'uniform') {
        const nums = [uniform.m, uniform.oMul, uniform.pMul].map((v) => v.trim());
        if (nums.some((v) => v === '' || !Number.isFinite(Number(v)))) {
          onToast('统一值模式需要「最可能 M」与两个倍率都填数字');
          return;
        }
        const [m, oMul, pMul] = nums.map(Number);
        if (m <= 0 || oMul <= 0 || pMul <= 0) { onToast('统一值与倍率必须是正数'); return; }
        const pts = uniformPoints(m, oMul, pMul);
        const items = selRows.map((r) => ({
          planId: r.planId,
          ...pts,
          source: 'manual' as const, // 人给的统一值就是人工复核，不能让批量通道把徽标留在「规则」
          ...(r.phase ? { phase: r.phase as EstimateInput['phase'] } : {}),
        }));
        const go = await askConfirm(
          `将把 ${items.length} 行的三点设为 O ${num(pts.optimistic)} / M ${num(pts.likely)} / P ${num(pts.pessimistic)} 人天`
          + `（M=${num(m)}，倍率 ${num(oMul)} / ${num(pMul)}，落 0.5 网格）。\n`
          + '已有估算的行会被覆盖并转「人工」，确认写入？',
        );
        if (!go) return;
        const before = selRows.map((r) => ({ planId: r.planId, snapshot: snapshotRow(r) }));
        const w = await estimatesApi.batchSet(projectId, items);
        if (w.written === 0) {
          // 服务端「任一行不合格零写入」：把行级错误摊到对应行上，一行都不动
          const next: Record<string, string> = {};
          w.errors.forEach((e) => { next[e.planId] = e.message; });
          setRowErrors((p) => ({ ...p, ...next }));
          onToast(`批量填充被拒绝：${w.errors.length > 0 ? w.errors[0].message : '未写入任何行'}`);
          return;
        }
        pushUndo(`统一值填充 ${w.written} 行`, w.written, before);
        onToast(`已填充 ${w.written} 行${w.errors.length > 0 ? `，${w.errors.length} 行被拒` : ''}`);
        await load();
        return;
      }

      // includeManual 缺省 false：§4.6 红线二在批量通道同样生效——人工复核过的行由服务端跳过
      // （skip='manual'），面板如实报数，而不是替用户决定「覆盖你复核过的值」。
      // `onlyRule` 是这三个按钮的全部区别：不带它，「按用例加权重推」会和「按复杂度重推」做同一件事。
      const deriveOpts = { planIds: selRows.map((r) => r.planId), scope: 'all' as const, onlyRule: mode as DeriveRule };
      const preview = await estimatesApi.batchDerive(projectId, { ...deriveOpts, dryRun: true });
      const n = preview.writableCount;
      if (n === 0) {
        onToast(`没有可${BATCH_RULE_LABEL[mode]}的行（${preview.skipped.length} 行全部被跳过，原因见明细 tooltip）`);
        return;
      }
      const skipped = preview.skipped.length;
      const go = await askConfirm(
        `${BATCH_RULE_LABEL[mode]}：选中 ${selRows.length} 行中 ${n} 行可写入`
        + `${skipped > 0 ? `，${skipped} 行跳过（其中 ${countSkip(preview, 'offRule')} 行不属于该档、${countSkip(preview, 'manual')} 行为人工复核过的行）` : ''}。\n`
        + `用例加权档的 k=${preview.caseWeightK}（来源：${preview.caseWeightKFrom}）。\n预览行数与写入行数同源，确认即写入？`,
      );
      if (!go) return;
      const before = new Map(selRows.map((r) => [r.planId, snapshotRow(r)]));
      const w = await estimatesApi.batchDerive(projectId, deriveOpts);
      // 撤销快照只覆盖**真正被写入**的行：优先取服务端回传的 `writtenPlanIds`（等长才非空），
      // 拿不到时按本次选中的可写行兜底——绝不拿「全选可见」当作用域，否则会碰到没写过的行。
      const ids = w.writtenPlanIds && w.writtenPlanIds.length > 0
        ? w.writtenPlanIds
        : ((w.written ?? 0) > 0 ? selRows.filter((r) => preview.items.some((it) => it.planId === r.planId && it.writable)).map((r) => r.planId) : []);
      pushUndo(`${BATCH_RULE_LABEL[mode]} ${w.written ?? 0} 行`, w.written ?? 0, ids.map((id) => ({ planId: id, snapshot: before.get(id) ?? null })));
      onToast(`已${BATCH_RULE_LABEL[mode]}写入 ${w.written ?? 0} 行${(w.errors?.length ?? 0) > 0 ? `，${w.errors?.length} 行被拒` : ''}`);
      await load();
    } catch (e) {
      onToast(`批量填充失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 撤销最近一次批量写入（§5.3：会话内存栈；原态是「无估算行」的，删除才等价于回滚） */
  async function undoLast(): Promise<void> {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    setBusy(true);
    try {
      const restore = entry.before.filter((b) => b.snapshot !== null).map((b) => ({ planId: b.planId, ...b.snapshot as EstimateInput }));
      const drop = entry.before.filter((b) => b.snapshot === null).map((b) => b.planId);
      let restored = 0, removed = 0;
      if (restore.length > 0) {
        const r = await estimatesApi.batchSet(projectId, restore);
        if (r.written === 0) {
          onToast(`撤销失败：${r.errors[0]?.message ?? '未写入任何行'}`);
          return;
        }
        restored = r.written;
      }
      for (const id of drop) {
        const r = await estimatesApi.removeItem(projectId, id);
        if (r.removed) removed += 1;
      }
      setUndoStack((p) => p.slice(0, -1));
      setSelIds([]);
      onToast(`已撤销「${entry.label}」：还原 ${restored} 行${removed > 0 ? `，删除 ${removed} 行新建估算` : ''}`);
      await load();
    } catch (e) {
      onToast(`撤销失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * §6.1 / §6.2 导出：件名与快照 id 都取自服务端响应头（`api.exportXlsx` / `api.exportPdf`），
   * 面板不拼第二套命名口径；「未人工复核 N 行」取的是**这份件**写进快照的那个数（§6.3 留痕侧），
   * 不是面板另算一遍的筛选计数。两种格式在客户端只是路径不同——服务端 `buildEstimateArtifact`
   * 保证同一份行落位、同一个件名规则、同一条快照留痕。
   *
   * `aud` 缺省跟随受众 radio（Excel 用），PDF 两枚按钮各带各的受众（§5.2 第 4 段：
   * 「导出 PDF（内部版）」「导出 PDF（客户版）」——§10-9 要一次出两版对照，radio 只能表达一个）。
   */
  async function runExport(
    fmt: 'xlsx' | 'pdf' = 'xlsx',
    aud: EstimateExportAudience = audience,
  ): Promise<void> {
    setExportingKind(fmt);
    const opts: EstimateExportOptions = {
      audience: aud,
      scope: (estimatedOnly ? 'estimated_only' : 'all') as EstimateExportScope,
    };
    try {
      const r = fmt === 'pdf'
        ? await estimatesApi.exportPdf(projectId, opts)
        : await estimatesApi.exportXlsx(projectId, opts);
      saveBlob(r.blob, r.filename);
      onToast(`已导出 ${r.filename}`);
      const list = await estimatesApi.listSnapshots(projectId);
      setSnapshots(list.snapshots);
      setSnapshotError('');
      const row = list.snapshots.find((x) => x.id === r.snapshotId);
      const pl = row ? parseSnapshotPayload(row.payload) : null;
      setLastExport(pl ? { filename: r.filename, unreviewed: pl.unreviewed } : null);
      setCmpIds([]);
      setCmpDiff(null);
    } catch (e) {
      onToast(`导出失败：${errMsg(e)}`);
    } finally {
      setExportingKind(null);
    }
  }

  /** 对比至多选两条（§5.2 第 4 段）：第三条进来时挤掉最早的一条，不给「先取消再选」的额外步骤 */
  const toggleCmp = (id: string): void => {
    setCmpIds((p) => {
      const next = p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2);
      return next;
    });
    setCmpDiff(null);
  };

  async function runCompare(): Promise<void> {
    if (cmpIds.length !== 2) return;
    try {
      const r = await estimatesApi.compareSnapshots(projectId, cmpIds[0], cmpIds[1]);
      if (!r.compare) { onToast('两次快照无法比对（可能已不在最近 20 条内）'); setCmpDiff(null); return; }
      setCmpDiff(r.compare);
    } catch (e) {
      onToast(`比对失败：${errMsg(e)}`);
    }
  }

  /** §7 的显式清理入口：脱离计划的估算行——先列清单再确认，绝不做成自动清理 */
  async function cleanupDetached(): Promise<void> {
    setBusy(true);
    try {
      const list = await estimatesApi.listDetached(projectId);
      const ids = list.rows.map((r) => r.id);
      if (ids.length === 0) { onToast('当前没有脱离计划的估算行（可能刚被其他入口清理过）'); await load(); return; }
      const sample = list.rows.slice(0, 3).map((r) => `${num(r.optimistic)}/${num(r.likely)}/${num(r.pessimistic)}`).join('、');
      const go = await askConfirm(
        `有 ${ids.length} 条估算已脱离计划（计划被彻底删除后估算按 §7 原样保留）。\n`
        + `三点值：${sample}${ids.length > 3 ? ' 等' : ''} 人天。\n`
        + '删除后不进撤销栈、无法恢复，确认清理？',
      );
      if (!go) return;
      const r = await estimatesApi.cleanupDetached(projectId, ids);
      onToast(`已清理 ${r.removed} 条脱离计划的估算行${r.removed !== ids.length ? `，${ids.length - r.removed} 条未删（已不满足脱离条件）` : ''}`);
      await load();
    } catch (e) {
      onToast(`清理失败：${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 12 }}>
        <div className="skel" style={{ width: 150, height: 14 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ flex: 1, height: 58 }} />)}
        </div>
        <div className="skel" style={{ width: '60%', height: 12, marginTop: 14 }} />
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 22, marginTop: 8 }} />)}
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 8 }}>估算数据加载失败</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, wordBreak: 'break-all' }}>{error}</div>
        <button type="button" className="tbtn-anim" onClick={() => void load()}
          style={{ border: '1px solid var(--border-strong)', borderRadius: 6, padding: '4px 10px', background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
          重试
        </button>
      </div>
    );
  }
  if (!data) return null;

  const s = data.summary;
  const cfg = data.params.config;
  const rc = s.ratioCheck;

  const card = (title: string, main: string, sub?: string, danger = false) => (
    <div style={{ flex: 1, minWidth: 0, padding: 8, background: 'var(--card-bg)', border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`, borderRadius: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 16, fontFamily: MONO, color: danger ? 'var(--danger)' : 'var(--text)' }}>{main}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{sub}</div>}
    </div>
  );

  /** 工具条小按钮（11px 档，同 §5.5 字号阶梯；禁用态只降色不改形，避免按钮跳动） */
  const toolBtn = (tone: 'default' | 'accent' | 'danger' = 'default', disabled = false): CSSProperties => ({
    border: `1px solid ${tone === 'danger' ? 'var(--danger)' : tone === 'accent' ? 'var(--accent)' : 'var(--border-strong)'}`,
    borderRadius: 6,
    padding: '3px 8px',
    background: 'var(--card-bg)',
    color: disabled ? 'var(--text-muted)' : tone === 'danger' ? 'var(--danger)' : tone === 'accent' ? 'var(--accent)' : 'var(--text)',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 11,
  });

  /** 行内录入的数字输入框（40px 定宽 = 原 span 列宽，面板 420 的账不变；appearance 只去箭头不改 step 语义） */
  const pointInput = (err: string | undefined): CSSProperties => ({
    width: 40,
    textAlign: 'right',
    fontFamily: MONO,
    fontSize: 12,
    padding: '1px 2px',
    borderRadius: 4,
    border: `1px solid ${err ? 'var(--danger)' : 'var(--border)'}`,
    background: 'var(--card-bg)',
    color: 'var(--text)',
    WebkitAppearance: 'textfield',
    appearance: 'textfield',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>
      {/* 1) 汇总卡（sticky，§5.2-1）——读数全部来自服务端 summary */}
      <div style={{ position: 'sticky', top: 0, zIndex: 2, padding: 10, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, visibility: hideHeading ? 'hidden' : 'visible' }}>估算面板</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: MONO }}>
            {cfg.manDaysPerManMonth} 人天/人月 · 系数和 {num(s.coefSum)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {card('实际预估人月 P50 / P84', `${num(s.quote.p50ManMonth)} / ${num(s.quote.p84ManMonth)}`, `σ_total ${num(s.quote.sigma)} 人天`)}
          {card('理想人月（ΣE）', num(s.idealManMonths.expected), `直接投入 ${num(s.directManDays.expected)} 人天`)}
          {card('Σ估算比例（I40）', pct(rc.sumRatio), `偏差 ${devPct(rc.deviationPct)}`, rc.danger)}
        </div>
        {/* §5.3 撤销：本会话内存栈顶（批量写入前抓的原值）；空栈不占位 */}
        {undoStack.length > 0 && (() => {
          const last = undoStack[undoStack.length - 1];
          return (
            <div role="status" aria-label="批量填充撤销条" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              <span>已填充 {last.count} 行 · 撤销</span>
              <button type="button" className="tbtn-anim" style={toolBtn('accent', busy)} disabled={busy}
                title={`${last.label}（本会话第 ${undoStack.length} 步，仅还原最近一次批量写入）`}
                onClick={() => void undoLast()}>
                撤销{undoStack.length > 1 ? `（剩 ${undoStack.length - 1} 步）` : ''}
              </button>
            </div>
          );
        })()}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {/* 2) 阶段视图（§5.2-2）：固定 6 类阶段，无数据置灰且不删行 */}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 6px' }}>阶段（人天 / σ / 比例）</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {s.phases.map((ph) => {
              const empty = ph.rowCount === 0;
              return (
                <tr key={ph.phase} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '4px 2px', color: empty ? 'var(--text-muted)' : 'var(--text)' }}>
                    {data.meta.phaseLabels[ph.phase] ?? ph.phase}
                  </td>
                  <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: empty ? 'var(--text-muted)' : 'var(--text)' }}>{num(ph.expected)}</td>
                  <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>{num(ph.sigma)}</td>
                  <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>{empty ? '未纳入本次报价' : pct(ph.ratio)}</td>
                </tr>
              );
            })}
            {s.coefRows.map((c) => (
              <tr key={c.key} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '4px 2px', color: 'var(--text-muted)' }}>{c.label}（系数）</td>
                <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>{num(c.points.likely)}</td>
                <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>—</td>
                <td style={{ padding: '4px 2px', textAlign: 'right', fontFamily: MONO, color: 'var(--text-muted)' }}>{pct(c.ratio)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 3) 明细工具条（§5.3 批量填充 + 只看未复核）：作用域=可见且非里程碑的行，里程碑由服务端红线排除 */}
        <div role="toolbar" aria-label="估算批量填充工具条" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '14px 0 6px' }}>
          <label
            title="隐藏已复核（source=manual）的行——规则/默认/未录入都算待复核（§5.2 状态要求）"
            style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            <input type="checkbox" checked={onlyUnreviewed} onChange={(e) => setOnlyUnreviewed(e.target.checked)} />
            只看未复核
          </label>
          <button type="button" className="tbtn-anim" style={toolBtn()} onClick={selectAllVisible}
            title={`选中当前可见的 ${batchableIds.length} 行（里程碑行不参与批量填充）`}>
            全选可见
          </button>
          <button type="button" className="tbtn-anim" style={toolBtn('default', selIds.length === 0)} disabled={selIds.length === 0}
            onClick={() => setSelIds([])}>
            清空
          </button>
          {(Object.keys(BATCH_RULE_LABEL) as DeriveRule[]).map((rule) => (
            <button key={rule} type="button" className="tbtn-anim" style={toolBtn('accent', busy || selRows.length === 0)}
              disabled={busy || selRows.length === 0} onClick={() => void runBatch(rule)}
              title={`把选中行里自然择档为「${RULE_LABEL[rule]}」的那些按 §4.6 该档重推；不属于该档的行由服务端整行跳过（offRule），不硬凑假数据`}>
              {BATCH_RULE_LABEL[rule]}
            </button>
          ))}
          <button type="button" className="tbtn-anim" style={toolBtn('accent', busy || selRows.length === 0)}
            disabled={busy || selRows.length === 0} onClick={openUniform}
            title={`给选中的 ${selRows.length} 行写同一组三点（M + O/P 倍率，落 0.5 网格）`}>
            统一值…
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>已选 {selRows.length} 行</span>
        </div>

        {uniformOpen && (
          <div role="group" aria-label="统一值批量填充表单"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 6, background: 'var(--card-bg)', fontSize: 11 }}>
            <span style={{ color: 'var(--text-muted)' }}>统一值 + 相对幅度</span>
            {([['m', '最可能 M', '人天'], ['oMul', 'O 倍率', '如 0.8'], ['pMul', 'P 倍率', '如 1.4']] as const).map(([key, label, hint]) => (
              <label key={key} title={`${label}（${hint}）`} style={{ display: 'flex', gap: 3, alignItems: 'center', color: 'var(--text-muted)' }}>
                {label}
                <input type="number" step={key === 'm' ? 0.5 : 0.1} min={0} value={uniform[key]}
                  onChange={(e) => setUniform((p) => ({ ...p, [key]: e.target.value }))}
                  style={{ width: 52, textAlign: 'right', fontFamily: MONO, fontSize: 12, padding: '1px 2px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                />
              </label>
            ))}
            <span style={{ color: 'var(--text-muted)' }}>→ {(() => {
              const m = Number(uniform.m), o = Number(uniform.oMul), p = Number(uniform.pMul);
              return uniform.m.trim() !== '' && Number.isFinite(m) && Number.isFinite(o) && Number.isFinite(p) && m > 0 && o > 0 && p > 0
                ? `O ${num(uniformPoints(m, o, p).optimistic)} / M ${num(uniformPoints(m, o, p).likely)} / P ${num(uniformPoints(m, o, p).pessimistic)}`
                : '待填';
            })()}</span>
            <button type="button" className="tbtn-anim" style={toolBtn('accent', busy || selRows.length === 0)}
              disabled={busy || selRows.length === 0} onClick={() => void runBatch('uniform')}>
              写入 {selRows.length} 行
            </button>
            <button type="button" className="tbtn-anim" style={toolBtn()} onClick={() => setUniformOpen(false)}>取消</button>
          </div>
        )}

        {/* 4) 明细行（§5.2-3）：分组与折叠与时间线同源 */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '14px 0 2px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>明细（O / M / P / E / σ）</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            已计入 Σ {s.countedKeys.length} 行 · 未录入 {rc.excluded.unEstimated} 行
          </div>
        </div>
        {/* §5.4 区间条图例：没有它，那条短线就是一个没人能自证含义的图形。
            空态（一条区间都画不出来）时不渲染——图例解释的是一个当前并不存在的图形。 */}
        {whisker.size > 0 && (
        <div aria-label="区间条图例" style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 6px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--accent)' }}>
            <span style={{ width: 1, height: 7, background: 'currentColor', display: 'inline-block' }} />
            <span style={{ width: 18, height: 1, background: 'currentColor', display: 'inline-block' }} />
            <span style={{ width: 2, height: 9, background: 'currentColor', display: 'inline-block' }} />
            <span style={{ width: 18, height: 1, background: 'currentColor', display: 'inline-block' }} />
            <span style={{ width: 1, height: 7, background: 'currentColor', display: 'inline-block' }} />
          </span>
          <span>区间条：端点 O / P，粗竖线 E（横向按最大 P 归一，行间可比）</span>
        </div>
        )}

        {isEmpty && (
          <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 8, padding: 10, marginBottom: 8, background: 'var(--card-bg)' }}>
            <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 6 }}>尚未录入估算——点「按规则推导」用复杂度/用例/工期生成初始值。</div>
            <button type="button" className="tbtn-anim" disabled={deriveBusy} onClick={() => void fillByRules()}
              style={{ border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 10px', background: 'var(--card-bg)', color: 'var(--accent)', cursor: deriveBusy ? 'default' : 'pointer', fontSize: 12 }}>
              {deriveBusy ? '推导中…' : '按规则推导'}
            </button>
          </div>
        )}

        {phases.map((group) => {
          const ms = group.milestone;
          const msRow = ms ? rowById.get(ms.id) : null;
          // 折叠语义与 T01576 一致：折叠只摘掉段内任务行，里程碑行本身常驻；
          // 折叠态是父级的 `plan.collapsedMs`，面板翻转它之后由父级重渲染回传，本组件不另存一份。
          const collapsed = ms ? !!collapsedMs[ms.id] : false;
          const toggle = (): void => { if (ms) onToggleMsCollapse(ms.id); };
          return (
            <div key={ms?.id ?? 'prelude'} style={{ marginBottom: 6 }}>
              {ms && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={toggle}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', borderTop: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                  title={collapsed ? '展开该阶段明细' : '收起该阶段明细（与列表/甘特共用折叠态）'}
                >
                  <span style={{ color: 'var(--text-muted)' }}>{collapsed ? '▸' : '▾'}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ms.title}</span>
                  {msRow && <span style={{ fontFamily: MONO, color: 'var(--text-muted)', fontWeight: 400 }}>E {num(msRow.expected)}</span>}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>不进 Σ</span>
                </div>
              )}
              {!collapsed && group.items.map((p) => {
                const r = rowById.get(p.id);
                if (!r) return null;
                if (onlyUnreviewed && r.source === 'manual') return null;
                const err = rowErrors[r.planId];
                const editable = r.kind !== 'milestone';
                const cellValue = (f: PointField): string =>
                  draft && draft.planId === r.planId && draft.field === f
                    ? draft.value
                    : (r[f] === null ? '' : String(r[f]));
                const badge = (
                  <span title={r.tip} style={{ fontSize: 10, padding: '0 4px', borderRadius: 3, border: `1px solid ${r.badge.color}`, color: r.badge.color, whiteSpace: 'nowrap' }}>
                    {r.badge.label}
                  </span>
                );
                // §5.4 区间条：建议行（未落库）用次级色，与「建议值不进 Σ」的灰显口径一致——
                // 一根同样长的 --accent 条会让读者把没落库的猜测当成已复核的报价依据。
                const g = whisker.get(r.planId);
                const wColor = r.suggestion ? 'var(--text-muted)' : 'var(--accent)';
                return (
                  <div key={r.planId} style={{ borderBottom: '1px solid var(--border)', padding: '4px 0 4px 4px', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={selIds.includes(r.planId)}
                      disabled={!editable}
                      onChange={() => toggleSel(r.planId)}
                      title={editable ? '勾选后参与批量填充' : '里程碑行不参与批量填充（§4.6 红线一）'}
                      style={{ margin: 0, flex: '0 0 auto' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.suggestion ? 'var(--text-muted)' : 'var(--text)' }} title={r.title}>
                        {r.reqNos.length > 0 && <span style={{ color: 'var(--text-muted)', marginRight: 4, fontFamily: MONO, fontSize: 11 }}>{r.reqNos.join('、')}</span>}
                        {r.title}
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                        {badge}
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>复杂度 {r.complexity ?? '—'}</span>
                        {err && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{err}</span>}
                      </div>
                      {g && (
                        <div
                          role="img"
                          aria-label={`区间条 ${r.title}`}
                          title={`O ${num(r.optimistic)} —— P ${num(r.pessimistic)}，竖线为 E ${num(r.expected)} 人天`
                            + `${r.suggestion ? '（推导建议值，未落库、不进 Σ）' : ''}\n`
                            + `横向刻度按明细行最大 P=${num(g.scaleMax)} 归一，行间长度可比`}
                          style={{ position: 'relative', height: 8, marginTop: 3 }}
                        >
                          {/* 横线宽度：0.4% 是相对下限，minWidth 2px 是绝对下限——面板窄到 130px 时 0.4% 只有 0.5px，
                              亚像素会让 O=P 的退化区间直接消失，读者误以为这一行没有估算。 */}
                          <span aria-hidden style={{ position: 'absolute', top: 3, left: `${g.loPct}%`, width: `${Math.max(g.hiPct - g.loPct, 0.4)}%`, minWidth: 2, height: 1, background: wColor }} />
                          <span aria-hidden style={{ position: 'absolute', top: 1, left: `${g.loPct}%`, width: 1, height: 6, background: wColor }} />
                          <span aria-hidden style={{ position: 'absolute', top: 1, left: `${g.hiPct}%`, width: 1, height: 6, background: wColor }} />
                          <span aria-hidden style={{ position: 'absolute', top: 0, left: `${g.ePct}%`, width: 2, height: 8, background: wColor, opacity: 0.85 }} />
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4, fontFamily: MONO, textAlign: 'right', alignItems: 'center' }}>
                      {POINT_FIELDS.map((f) => (
                        <input
                          key={f}
                          type="number"
                          step={0.5}
                          min={0}
                          disabled={!editable || busy}
                          value={cellValue(f)}
                          placeholder="—"
                          aria-label={`${r.title} ${POINT_LABEL[f]}（人天）`}
                          title={editable
                            ? `${POINT_LABEL[f]}（人天，0.5 步进）：Enter 或失焦即落库，Esc 还原${err ? `\n${err}` : ''}`
                            : '里程碑行不落估算（§4.6 红线一），值只作参考'}
                          onChange={(e) => setDraft({ planId: r.planId, field: f, value: e.target.value })}
                          onFocus={() => setDraft({ planId: r.planId, field: f, value: cellValue(f) })}
                          onBlur={() => void commitDraft(draft)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void commitDraft(draft); }
                            else if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
                          }}
                          style={{ ...pointInput(err), color: f === 'likely' ? 'var(--text)' : 'var(--text-muted)' }}
                        />
                      ))}
                      <span style={{ width: 38, textAlign: 'right' }} title="期望值 E（服务端算，只读）">{num(r.expected)}</span>
                      <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)' }} title="σ（未落库行不计算）">{num(r.sigma)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* 5) 告警条（§5.2 状态要求里「比例自检」那一档 + §7 脱离计划行） */}
        {(rc.danger || rc.unassigned.length > 0 || data.checks.detached > 0) && (
          <div style={{ marginTop: 10, border: `1px solid ${rc.danger ? 'var(--danger)' : 'var(--border-strong)'}`, borderRadius: 8, padding: 8, background: 'var(--card-bg)', fontSize: 12 }}>
            <div style={{ color: rc.danger ? 'var(--danger)' : 'var(--text)', marginBottom: 4 }}>
              Σ估算比例 {pct(rc.sumRatio)} 偏离 100%（{devPct(rc.deviationPct)}）
              {rc.danger ? ' —— 导出前须核对未归阶段的行' : ''}
            </div>
            {rc.unassigned.length > 0 && (
              <div style={{ color: 'var(--text-muted)' }}>
                未归入六阶段的行：{rc.unassigned.map((u) => rowById.get(u.key)?.title ?? u.key).join('、')}
              </div>
            )}
            {data.checks.detached > 0 && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)' }}>另有 {data.checks.detached} 条估算行已脱离计划</span>
                <button type="button" className="tbtn-anim" style={toolBtn('danger', busy)} disabled={busy}
                  title="§7：计划被彻底删除后估算行原样保留（历史报价依据）；清理是显式手动操作，不进撤销栈"
                  onClick={() => void cleanupDetached()}>
                  清理脱离行
                </button>
              </div>
            )}
          </div>
        )}

        {/* 6) 行内录入错误条（§5.2 状态要求：被拒的行逐行点名 + 底部计数；判据全在服务端，面板只转录 400 文案） */}
        {Object.keys(rowErrors).length > 0 && (
          <div role="alert" aria-label="行内录入错误提示"
            style={{ marginTop: 10, border: '1px solid var(--danger)', borderRadius: 8, padding: 8, background: 'var(--card-bg)', fontSize: 12, color: 'var(--danger)' }}>
            <div>{Object.keys(rowErrors).length} 行不满足录入校验（O≤M≤P），导出前须修正</div>
            {Object.entries(rowErrors).map(([id, msg]) => (
              <div key={id} style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                {rowById.get(id)?.title ?? id}：{msg}
              </div>
            ))}
          </div>
        )}

        {/* 7) 导出区（§5.2 第 4 段 · E6 Excel + E7 PDF）：Excel 内部版/客户版 + PDF 两枚 + 最近快照与对比。
            件名、未复核行数、合并区数一律取自服务端响应头与快照 payload——面板不拼第二套口径。
            PDF 两枚按钮各自定受众（§5.2 原文形态），因为 §10-9 的验收是「一次出两版对照脱敏」。 */}
        <div role="region" aria-label="估算导出区" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>导出（Excel 复刻客户模板）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <label title="客户版不含「估算明细/参数」两个附加 sheet，也不写备注三条；开折叠后系数分项并进一行合计（报价数不变）"
              style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="radio" name="estimate-audience" checked={audience === 'client'} onChange={() => setAudience('client')} />
              客户版
            </label>
            <label title="内部版含全量明细 sheet（plan_id / 来源 / σ）与参数 sheet，供内部复核"
              style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="radio" name="estimate-audience" checked={audience === 'internal'} onChange={() => setAudience('internal')} />
              内部版
            </label>
            <label title={`scope=estimated_only：只有落了估算的行进件；不勾=全部计划（未估算行成行但三点留空，不把「没估」写成 0）`}
              style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={estimatedOnly} onChange={(e) => setEstimatedOnly(e.target.checked)} />
              只导已估算行
            </label>
            <button type="button" className="tbtn-anim" style={toolBtn('accent', exporting || Object.keys(rowErrors).length > 0)}
              disabled={exporting || Object.keys(rowErrors).length > 0} onClick={() => void runExport('xlsx')}
              aria-label="导出 Excel 文件"
              title={Object.keys(rowErrors).length > 0 ? '有行未通过录入校验（§5.2：导出禁用），先修正' : `按当前选择出件（${audience === 'client' ? '客户版' : '内部版'}）`}>
              {exportingKind === 'xlsx' ? '导出中…' : '导出 Excel'}
            </button>
            {audience === 'client' && cfg.hideCoefsForClient && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>系数分项将折叠（参数页开关）</span>
            )}
          </div>
          {/* §5.2 第 4 段的 PDF 两枚（E7）。裁决 D4：PDF 仅预览、Excel 为正式交付——这句要印在按钮旁边，
              不能只在 PRD 里；脱敏由服务端在中间文档阶段完成，按钮标题里说清各版不含什么 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <button type="button" className="tbtn-anim" style={toolBtn('default', exporting || Object.keys(rowErrors).length > 0)}
              disabled={exporting || Object.keys(rowErrors).length > 0} onClick={() => void runExport('pdf', 'internal')}
              aria-label="导出 PDF 内部版"
              title={Object.keys(rowErrors).length > 0 ? '有行未通过录入校验（§5.2：导出禁用），先修正'
                : 'PDF 内部版：含系数分项、σ/P50/P84 区间、自检与备注三条（汇报/预览用，正式交付以 Excel 为准）'}>
              {exportingKind === 'pdf' ? '导出中…' : '导出 PDF（内部版）'}
            </button>
            <button type="button" className="tbtn-anim" style={toolBtn('default', exporting || Object.keys(rowErrors).length > 0)}
              disabled={exporting || Object.keys(rowErrors).length > 0} onClick={() => void runExport('pdf', 'client')}
              aria-label="导出 PDF 客户版"
              title={Object.keys(rowErrors).length > 0 ? '有行未通过录入校验（§5.2：导出禁用），先修正'
                : 'PDF 客户版：服务端组装阶段就不写系数分项、σ/置信区间、备注三条与附加 sheet 名，报价数与内部版一致'}>
              导出 PDF（客户版）
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>PDF 为预览件，正式交付以 Excel 为准（裁决 D4）</span>
          </div>
          {lastExport && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              本次件：{lastExport.filename}
              {lastExport.unreviewed > 0 ? ` · 内含「${lastExport.unreviewed} 行为系统推导值，未人工复核」标注` : ' · 全部行为人工复核值'}
            </div>
          )}

          {/* §5.2 第 4 段下半：最近 5 次快照 + 两条对比（§7「上次导出后计划已变化」的界面侧） */}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '10px 0 4px' }}>
            最近导出（{snapshots.length}）
            {cmpIds.length === 2 && (
              <button type="button" className="tbtn-anim" style={{ ...toolBtn(), marginLeft: 6 }} onClick={() => void runCompare()}>
                对比所选两条
              </button>
            )}
          </div>
          {snapshotError && <div style={{ fontSize: 11, color: 'var(--danger)' }}>快照记录读取失败：{snapshotError}</div>}
          {snapshots.length === 0 && !snapshotError && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>还没有导出记录（§6.3：每次导出写一条快照留痕）</div>
          )}
          {snapshots.map((sn) => {
            const pl = parseSnapshotPayload(sn.payload);
            const picked = cmpIds.includes(sn.id);
            return (
              <div key={sn.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 11, borderBottom: '1px solid var(--border)', padding: '3px 0' }}>
                <input type="checkbox" checked={picked} onChange={() => toggleCmp(sn.id)} title="勾选两条可对比（§7 版本差异）" />
                <span style={{ fontFamily: MONO }}>{(sn.created_at ?? '').slice(0, 16).replace('T', ' ')}</span>
                <span style={{ fontFamily: MONO, color: 'var(--text-muted)' }}>{sn.format.toUpperCase()}</span>
                <span style={{ color: pl?.audience === 'client' ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {pl?.audience === 'client' ? '客户版' : pl?.audience === 'internal' ? '内部版' : sn.format}
                </span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontFamily: MONO }} title="该次导出的实际预估人月（ΣE）">
                  {pl ? `${num(pl.actualManMonths?.expected)} 人月` : ''}
                </span>
              </div>
            );
          })}
          {cmpDiff && (
            <div role="group" aria-label="两次导出差异" style={{ marginTop: 6, border: '1px solid var(--border-strong)', borderRadius: 8, padding: 6, background: 'var(--card-bg)', fontSize: 11 }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
                对比：{(cmpDiff.a.created_at ?? '').slice(0, 16).replace('T', ' ')} → {(cmpDiff.b.created_at ?? '').slice(0, 16).replace('T', ' ')}
              </div>
              {cmpDiff.diff.phases.map((p) => (
                <div key={p.phase} style={{ display: 'flex', gap: 6 }}>
                  <span>{data.meta.phaseLabels[p.phase as keyof typeof data.meta.phaseLabels] ?? p.phase}</span>
                  <span style={{ fontFamily: MONO, marginLeft: 'auto', color: p.expected.delta === 0 ? 'var(--text-muted)' : p.expected.delta > 0 ? 'var(--danger)' : 'var(--success)' }}>
                    {p.expected.delta > 0 ? '+' : ''}{num(p.expected.delta)} 人天
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
                <span>实际预估人月</span>
                <span style={{ fontFamily: MONO, marginLeft: 'auto', color: cmpDiff.diff.totals.actualManMonths === 0 ? 'var(--text-muted)' : 'var(--danger)' }}>
                  {cmpDiff.diff.totals.actualManMonths > 0 ? '+' : ''}{num(cmpDiff.diff.totals.actualManMonths)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
