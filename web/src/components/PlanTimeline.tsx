/**
 * T01564（FR-3.1 时间线基元）：PlanPage 第三模式（list / gantt / timeline）下的纵向时间轴。
 * 与甘特互补而非替代：甘特是「横向排期 + 依赖线 + 关键路径」，本视图纵向铺开「里程碑脉络 + 进展」。
 * 数据全部复用 plan_tasks（start_date / end_date / duration_days / kind / progress / status / assignee），
 * 零后端字段改动；milestone 的标题与汇总仍由 PlanPage 既有逻辑产出，时间线只展示、不编辑。
 * 节点按 start_date 升序；milestone 用菱形强调，normal / daily 用圆点；
 * 信息卡含标题 / 起止 / 负责人 / 进度% / 状态。
 * 时间轴为均匀间距（不严格按时间比例），重在脉络可读性；
 * 粒度缩放（日/周/月/季）、阶段分组、节点详情交互属 T01565。
 */
import { useMemo } from 'react';

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

/** 状态文案（与 PlanPage 列表口径一致）。状态「颜色语义」属 T01565，本单先中性呈现 */
const STATUS_LABEL: Record<string, string> = {
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  blocked: '受阻',
};

function fmtDate(d: string): string {
  if (!d) return '未排期';
  const dt = new Date(d + (d.length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(dt.getTime())) return d;
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function PlanTimeline({ plans }: { readonly plans: ReadonlyArray<TlPlan> }) {
  // 未排期（无 start_date）沉底，其余按 start_date 升序。
  // 数据是父级同一份 plans（与甘特同源），本组件不另取接口、不排序回写。
  const sorted = useMemo(() => [...plans].sort((a, b) => {
    if (!a.start_date) return 1;
    if (!b.start_date) return -1;
    if (a.start_date !== b.start_date) return a.start_date < b.start_date ? -1 : 1;
    return a.end_date < b.end_date ? -1 : 1;
  }), [plans]);

  if (plans.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16, textAlign: 'center' }}>（暂无计划任务，无法生成时间线）</div>;
  }

  return (
    <div role="list" aria-label="计划时间线" style={{ padding: '2px 2px 2px 24px', marginLeft: 8, borderLeft: '2px solid var(--border-strong)', position: 'relative' }}>
      {sorted.map((p) => {
        const isMs = p.kind === 'milestone';
        const statusText = STATUS_LABEL[p.status] ?? p.status;
        return (
          <div key={p.id} style={{ position: 'relative', marginBottom: 8 }}>
            {/* 里程碑=菱形（强调色实心）；普通/日常=圆点（描边空心）。形状差异保证不依赖颜色也可区分 */}
            <span
              aria-hidden="true"
              style={
                isMs
                  ? { position: 'absolute', left: -31, top: 12, width: 14, height: 14, transform: 'rotate(45deg)', background: 'var(--accent)', border: '2px solid var(--card-bg)', borderRadius: 3 }
                  : { position: 'absolute', left: -28, top: 14, width: 10, height: 10, borderRadius: '50%', background: 'var(--card-bg)', border: '2px solid var(--accent)' }
              }
            />
            <div
              role="listitem"
              aria-label={`${isMs ? '里程碑' : '计划任务'} ${p.title}`}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '9px 11px', borderRadius: 8,
                border: `1px solid ${isMs ? 'var(--accent)' : 'var(--border)'}`,
                background: 'var(--card-bg)', color: 'var(--text)',
              }}
            >
              <div style={{ fontWeight: isMs ? 700 : 500, fontSize: isMs ? 14 : 13, color: p.color || 'var(--text)' }}>
                {isMs && <span aria-hidden="true" style={{ color: 'var(--accent)', marginRight: 4 }}>◆</span>}{p.title}
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginTop: 3, flexWrap: 'wrap' }}>
                <span>{fmtDate(p.start_date)} → {fmtDate(p.end_date)}</span>
                {p.assignee && <span>负责人：{p.assignee}</span>}
                <span>{statusText}</span>
                {p.linked_task_id && <span style={{ color: 'var(--success)' }}>✓ 已关联</span>}
              </div>
              {/* 里程碑是汇总节点：不显示自身进度条（其进度由 PlanPage 汇总在其下任务上，节点只表里程碑本身） */}
              {!isMs && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                  <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(0, Math.min(100, p.progress || 0))}%`, height: '100%', background: 'var(--accent)' }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.progress || 0}%</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
