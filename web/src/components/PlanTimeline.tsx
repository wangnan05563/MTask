/**
 * T01564 / T01565（FR-3.1 时间线）：纵向时间轴组件。
 * 与甘特（横向排期 + 依赖线 + 关键路径）互补：本视图强调「里程碑脉络 + 阶段进展叙事」。
 * 复用 plan_tasks（start_date/end_date/duration_days/kind/progress/status/assignee），零后端改动。
 * 节点按 start_date 升序；里程碑（菱形）切分阶段，阶段内聚合普通/日常任务并给出汇总。
 * 粒度（日/周/月/季）同时决定**轴上刻度密度**与标签格式：桶键变化处插入刻度标签，
 * 日粒度最密、季粒度最疏（T01565）。
 * 节点点击 → onSelect 由父级用 SlideOver 展示详情。
 * T01576：阶段可折叠——折叠只摘掉「阶段内任务节点 + 其刻度」，里程碑菱形与阶段汇总摘要（任务数/
 * 平均进度）仍留在轴上；折叠态由父级传入的 collapsedMs 承载，与列表/甘特共用 `plan.collapsedMs` 同一键。
 * 时间轴为均匀间距（非严格按时间比例），重在脉络可读性；比例间距为后续增强。
 */
import { useMemo, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react'; // T01576：阶段折叠控件（与列表视图 PlanTitleCell 同一套图标语言）

/** 结构类型：PlanPage 的 PlanTask 经结构化赋值传入（额外字段不影响兼容性）。
 *  字段以 PlanTask 为准：kind/color 在 PlanTask 中为可选 → 此处同样声明为可选，保证 PlanTask[] 可整体赋值。 */
export interface TlPlan {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly kind?: string; // 'normal' | 'milestone' | 'daily'
  readonly start_date: string;
  readonly end_date: string;
  readonly duration_days: number;
  readonly progress: number;
  readonly status: string;
  readonly assignee: string | null;
  readonly color?: string | null;
  readonly linked_task_id: string | null;
  readonly linked_task_title?: string | null;
}

export type TlGranularity = 'day' | 'week' | 'month' | 'quarter';

function fmtDate(d: string, g: TlGranularity): string {
  if (!d) return '未排期';
  const dt = new Date(d + (d.length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(dt.getTime())) return d;
  const y = dt.getFullYear();
  const m = dt.getMonth() + 1;
  const day = dt.getDate();
  if (g === 'day') return `${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (g === 'week') {
    const wkStart = new Date(dt); wkStart.setDate(day - ((wkStart.getDay() + 6) % 7)); // 周一开始
    return `${String(wkStart.getMonth() + 1).padStart(2, '0')}/${String(wkStart.getDate()).padStart(2, '0')} 周`;
  }
  if (g === 'month') return `${y}-${String(m).padStart(2, '0')}`;
  // quarter
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** 桶键：同一粒度下落在同一刻度内的节点共享一个键（未排期返回空串 → 不参与刻度） */
function bucketKey(d: string, g: TlGranularity): string {
  if (!d) return '';
  const dt = new Date(d + (d.length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = dt.getMonth() + 1;
  if (g === 'day') return `${y}-${m}-${dt.getDate()}`;
  if (g === 'week') {
    const ws = new Date(dt); ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7));
    return `${ws.getFullYear()}-${ws.getMonth() + 1}-${ws.getDate()}`;
  }
  if (g === 'month') return `${y}-${m}`;
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** 状态 → 文案 + 状态色（T01565：阶段内任务显示状态色；与 PlanPage 列表口径一致） */
const STATUS_META: Record<string, { label: string; color: string }> = {
  todo: { label: '待开始', color: 'var(--text-muted)' },
  doing: { label: '进行中', color: 'var(--accent)' },
  done: { label: '已完成', color: 'var(--success)' },
  blocked: { label: '受阻', color: 'var(--danger)' },
};

function phaseStats(items: TlPlan[]) {
  const days = items.reduce((s, p) => s + (p.duration_days || 0), 0);
  const avg = items.length ? Math.round(items.reduce((s, p) => s + (p.progress || 0), 0) / items.length) : 0;
  return { count: items.length, days, avg };
}

/** 扁平渲染行：刻度 → 里程碑 → 阶段汇总 → 任务，刻度由粒度决定密度。
 *  sum 行多带 msId：折叠时汇总行要标注「已收起」并可点击展开（T01576）。 */
type TlRow =
  | { readonly type: 'tick'; readonly key: string; readonly label: string }
  | { readonly type: 'ms'; readonly key: string; readonly p: TlPlan; readonly collapsed: boolean; readonly itemCount: number }
  | { readonly type: 'sum'; readonly key: string; readonly text: string; readonly msId: string | null; readonly collapsed: boolean }
  | { readonly type: 'item'; readonly key: string; readonly p: TlPlan };

export function PlanTimeline({ plans, granularity, onSelect, collapsedMs = {}, onToggleMsCollapse, onJumpToLinked }: {
  readonly plans: ReadonlyArray<TlPlan>;
  readonly granularity: TlGranularity;
  readonly onSelect: (p: TlPlan) => void;
  /** T01576：里程碑折叠态——与列表/甘特视图共用 `plan.collapsedMs` 会话键（同一里程碑 id，口径一致） */
  readonly collapsedMs?: Record<string, boolean>;
  /** T01576：切换某里程碑阶段的折叠态；缺省时不渲染折叠控件（保证组件可独立使用） */
  readonly onToggleMsCollapse?: (id: string) => void;
  /** T01577：跳转到该计划项关联的待办（focusTaskByNo/ById 那套跨视图定位）；缺省时关联仍是纯文本 */
  readonly onJumpToLinked?: (p: TlPlan) => void;
}) {
  const phases = useMemo(() => {
    const sorted = [...plans].sort((a, b) => {
      if (!a.start_date) return 1;
      if (!b.start_date) return -1;
      return a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0;
    });
    const result: Array<{ milestone: TlPlan | null; items: TlPlan[] }> = [];
    let cur: { milestone: TlPlan | null; items: TlPlan[] } = { milestone: null, items: [] };
    for (const p of sorted) {
      if (p.kind === 'milestone') {
        if (cur.milestone || cur.items.length) { result.push(cur); cur = { milestone: p, items: [] }; }
        else cur.milestone = p;
      } else {
        cur.items.push(p);
      }
    }
    if (cur.milestone || cur.items.length) result.push(cur);
    return result;
  }, [plans]);

  const rows = useMemo<TlRow[]>(() => {
    const out: TlRow[] = [];
    let lastBucket = '';
    const tick = (p: TlPlan, k: string) => {
      const bk = bucketKey(p.start_date, granularity);
      if (bk && bk !== lastBucket) {
        lastBucket = bk;
        out.push({ type: 'tick', key: `${k}-t-${bk}`, label: fmtDate(p.start_date, granularity) });
      }
    };
    phases.forEach((ph, i) => {
      // T01576：折叠态只影响「阶段内任务节点 + 其刻度」——里程碑菱形与阶段汇总摘要保留，脉络不失焦。
      const collapsed = !!ph.milestone && !!collapsedMs[ph.milestone.id];
      if (ph.milestone) {
        const ms = ph.milestone;
        tick(ms, `p${i}`);
        out.push({ type: 'ms', key: ms.id, p: ms, collapsed, itemCount: ph.items.length });
      }
      if (ph.items.length > 0) {
        const st = phaseStats(ph.items);
        out.push({
          type: 'sum',
          key: `p${i}-sum`,
          text: `${ph.milestone ? '本阶段' : '阶段'}：${st.count} 个任务 · 共 ${st.days} 天 · 平均进度 ${st.avg}%`
            + (collapsed ? ' · 已收起，点里程碑卡右侧箭头展开' : ''),
          msId: ph.milestone?.id ?? null,
          collapsed,
        });
      }
      if (collapsed) return;
      for (const p of ph.items) {
        tick(p, `p${i}`);
        out.push({ type: 'item', key: p.id, p });
      }
    });
    return out;
  }, [phases, granularity, collapsedMs]);

  if (plans.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16, textAlign: 'center' }}>（暂无计划任务，无法生成时间线）</div>;
  }

  function nodeCard(p: TlPlan, isMs: boolean): ReactNode {
    const st = STATUS_META[p.status] ?? { label: p.status, color: 'var(--text-muted)' };
    // T01577：可跳转时在卡右上角留白（跳转控件是卡的兄弟节点，见下方 row 渲染）；
    // 里程碑卡右上角还有折叠控件，两者并存时留白要再让出一个角标位。
    const badge = !!p.linked_task_id && !!onJumpToLinked;
    const padRight = !badge ? (isMs ? 34 : 11) : isMs ? 92 : 84;
    return (
      <button
        onClick={() => onSelect(p)}
        aria-label={`查看 ${p.title} 详情`}
        style={{
          display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
          padding: `9px ${padRight}px 9px 11px`, borderRadius: 8,
          border: `1px solid ${isMs ? 'var(--accent)' : 'var(--border)'}`,
          background: 'var(--card-bg)', color: 'var(--text)',
        }}
      >
        <div style={{ fontWeight: isMs ? 700 : 500, fontSize: isMs ? 14 : 13, color: p.color || 'var(--text)' }}>
          {isMs && <span aria-hidden="true" style={{ color: 'var(--accent)', marginRight: 4 }}>◆</span>}{p.title}
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginTop: 3, flexWrap: 'wrap' }}>
          <span>{fmtDate(p.start_date, granularity)} → {fmtDate(p.end_date, granularity)}</span>
          {p.assignee && <span>负责人：{p.assignee}</span>}
          <span style={{ color: st.color }}>{st.label}</span>
          {p.linked_task_id && <span style={{ color: 'var(--success)' }}>✓ 已关联</span>}
        </div>
        {!isMs && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(0, Math.min(100, p.progress || 0))}%`, height: '100%', background: st.color }} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.progress || 0}%</span>
          </div>
        )}
      </button>
    );
  }

  return (
    <div role="list" aria-label="计划时间线" style={{ padding: '2px 2px 2px 24px', marginLeft: 8, borderLeft: '2px solid var(--border-strong)', position: 'relative' }}>
      {rows.map((r) => {
        if (r.type === 'tick') {
          return (
            <div key={r.key} role="listitem" data-tl="tick" aria-label={`时间刻度 ${r.label}`} style={{ position: 'relative', margin: '12px 0 6px' }}>
              <span aria-hidden="true" style={{ position: 'absolute', left: -31, top: 2, width: 12, height: 12, borderRadius: '50%', background: 'var(--surface-2)', border: '2px solid var(--accent)' }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', letterSpacing: .3 }}>{r.label}</span>
            </div>
          );
        }
        if (r.type === 'sum') {
          return (
            <div key={r.key} role="listitem" data-tl="sum" data-tl-collapsed={r.collapsed ? '1' : '0'}
              aria-label={`阶段汇总 ${r.text}`}
              style={{ fontSize: 12, color: r.collapsed ? 'var(--accent)' : 'var(--text-muted)', margin: '4px 0 8px' }}>{r.text}</div>
          );
        }
        const msRow = r.type === 'ms' ? r : null;
        const isMs = msRow !== null;
        const collapsed = msRow?.collapsed === true;
        return (
          <div key={r.key} role="listitem" data-tl={isMs ? 'ms' : 'item'} data-tl-collapsed={isMs ? (collapsed ? '1' : '0') : undefined} aria-label={`${isMs ? '里程碑' : '计划任务'} ${r.p.title}`} style={{ position: 'relative', marginBottom: 8 }}>
            <span
              aria-hidden="true"
              style={
                isMs
                  ? { position: 'absolute', left: -31, top: 12, width: 14, height: 14, transform: 'rotate(45deg)', background: 'var(--accent)', border: '2px solid var(--card-bg)', borderRadius: 3 }
                  : { position: 'absolute', left: -28, top: 14, width: 10, height: 10, borderRadius: '50%', background: STATUS_META[r.p.status]?.color ?? 'var(--accent)', border: '2px solid var(--card-bg)' }
              }
            />
            {nodeCard(r.p, isMs)}
            {/* T01576：折叠控件——真实 <button>（键盘 Tab 可达、Enter/Space 触发），带 aria-expanded。
                不能嵌进节点卡（卡本身是 button，HTML 不允许按钮套按钮），故作为兄弟节点绝对定位在卡右上角。 */}
            {msRow && onToggleMsCollapse && msRow.itemCount > 0 && (
              <button
                type="button"
                data-tl="collapse"
                onClick={() => onToggleMsCollapse(msRow.p.id)}
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? '展开' : '收起'}阶段：${msRow.p.title}（${msRow.itemCount} 个任务）`}
                title={`${collapsed ? '展开' : '收起'}该阶段内的 ${msRow.itemCount} 个任务节点（与列表视图折叠态同源）`}
                style={{
                  position: 'absolute', right: 6, top: 8, zIndex: 1, padding: 2,
                  border: '1px solid var(--accent)', borderRadius: 5, background: 'var(--card-bg)',
                  color: 'var(--accent)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', lineHeight: 0,
                }}
              >
                {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <span style={{ fontSize: 10, marginLeft: 1 }}>{msRow.itemCount}</span>
              </button>
            )}
            {/* T01577：关联待办跳转角标——节点卡本身是 button（不能嵌套按钮），故与折叠控件同法，
                作为卡的兄弟节点绝对定位在右上角；里程碑卡的右上角已被折叠控件占用，角标让位到其左侧。 */}
            {r.p.linked_task_id && onJumpToLinked && (
              <button
                type="button"
                data-tl="jump-linked"
                className="tl-chip"
                onClick={() => onJumpToLinked(r.p)}
                aria-label={`打开关联待办：${r.p.linked_task_title || r.p.title}`}
                title={`跳转到该计划关联的待办${r.p.linked_task_title ? `「${r.p.linked_task_title}」` : ''}`}
                style={{
                  position: 'absolute', right: isMs ? 38 : 6, top: 8, zIndex: 1,
                  padding: '2px 7px', fontSize: 11, whiteSpace: 'nowrap',
                  border: '1px solid var(--success)', borderRadius: 5,
                  background: 'var(--card-bg)', color: 'var(--success)', cursor: 'pointer',
                }}
              >↗ 待办</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
