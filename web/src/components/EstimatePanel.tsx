/**
 * 估算面板（T02039 · PRD-估算视图与工作量评估导出 §5.1/§5.2，交付拆解 E4 首段）。
 *
 * 三条口径红线：
 * ① **零计算**：本文件不做任何三点运算（E/σ/汇总/比例一律读服务端 `summary`，
 *    逐行 σ 由 `rowRatios` 下发）。前端自算一次，「面板汇总 = 模板 H35」（§10-14）
 *    就从断言退化成两套实现的巧合一致——这正是本仓 planDeps 双口径踩过的坑。
 * ② **分组单源**：明细行的里程碑分组直接复用时间线的 `groupTimelinePhases`，
 *    折叠态与列表/甘特共用同一份 `plan.collapsedMs`（T01576 口径），面板不自造第三套分组。
 * ③ **只读首段**：行内录入/批量填充是 T02040（§5.3），区间条与图是 T02041（§5.4），
 *    导出区随 E6/E7——本文件不预留空壳按钮。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { groupTimelinePhases, type TlPlan } from './PlanTimeline';
import { api } from '../api/client';
import { estimatesApi, type DeriveItem, type EstimateItem, type EstimateSource, type EstimatesResponse } from '../api/estimates';
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
export const RULE_LABEL: Record<DeriveItem['rule'], string> = {
  complexity: '默认·复杂度',
  caseWeight: '默认·用例',
  duration: '默认·工期',
};

const num = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
/** `ratioCheck.deviationPct` 服务端已是「百分数」本身（2.3 = 2.3%），不能再过一遍 pct */
const devPct = (v: number): string => `${(Math.round(v * 10) / 10).toFixed(1)}%`;

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
        tip: dv.skip ? `不落库：${dv.skip}` : dv.note,
      };
    }
    return {
      ...base, optimistic: null, likely: null, pessimistic: null, expected: null, sigma: null,
      badge: SOURCE_BADGE.none, suggestion: false, tip: '无估算行，也没有可用的推导依据',
    };
  });
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

export function EstimatePanel({ projectId, plans, collapsedMs, onToggleMsCollapse, onToast, hideHeading = false }: EstimatePanelProps) {
  const [data, setData] = useState<EstimatesResponse | null>(null);
  const [derives, setDerives] = useState<DeriveItem[]>([]);
  const [reqNosByPlan, setReqNosByPlan] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deriveBusy, setDeriveBusy] = useState(false);

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

  const rows = useMemo(
    () => buildPanelRows(plans, data?.items ?? [], derives, data?.summary.rowRatios ?? [], reqNosByPlan),
    [plans, data, derives, reqNosByPlan],
  );
  const rowById = useMemo(() => new Map(rows.map((r) => [r.planId, r])), [rows]);
  const phases = useMemo(() => groupTimelinePhases(plans), [plans]);

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

        {/* 3) 明细行（§5.2-3）：分组与折叠与时间线同源 */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '14px 0 6px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>明细（O / M / P / E / σ）</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            已计入 Σ {s.countedKeys.length} 行 · 未录入 {rc.excluded.unEstimated} 行
          </div>
        </div>

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
                const badge = (
                  <span title={r.tip} style={{ fontSize: 10, padding: '0 4px', borderRadius: 3, border: `1px solid ${r.badge.color}`, color: r.badge.color, whiteSpace: 'nowrap' }}>
                    {r.badge.label}
                  </span>
                );
                return (
                  <div key={r.planId} style={{ borderBottom: '1px solid var(--border)', padding: '4px 0 4px 12px', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.suggestion ? 'var(--text-muted)' : 'var(--text)' }} title={r.title}>
                        {r.reqNos.length > 0 && <span style={{ color: 'var(--text-muted)', marginRight: 4, fontFamily: MONO, fontSize: 11 }}>{r.reqNos.join('、')}</span>}
                        {r.title}
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                        {badge}
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>复杂度 {r.complexity ?? '—'}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, fontFamily: MONO, textAlign: 'right' }}>
                      <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)' }} title="乐观（人天）">{num(r.optimistic)}</span>
                      <span style={{ width: 34, textAlign: 'right' }} title="最可能（人天）">{num(r.likely)}</span>
                      <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)' }} title="悲观（人天）">{num(r.pessimistic)}</span>
                      <span style={{ width: 38, textAlign: 'right' }} title="期望值 E（服务端算）">{num(r.expected)}</span>
                      <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)' }} title="σ（未落库行不计算）">{num(r.sigma)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* 4) 告警条（§5.2 状态要求里「比例自检」那一档；行内录入错误随 T02040 落地） */}
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
              <div style={{ color: 'var(--text-muted)' }}>另有 {data.checks.detached} 条估算行已脱离计划（清理入口随 E5 提供）</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
