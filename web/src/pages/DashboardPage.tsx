import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Clock3, ListTodo, ShieldCheck } from 'lucide-react';
import { api, type TodayView } from '../api/client';
import { Button } from '../ui/components';
import { FlowProgress } from '../ui/FlowProgress'; // T01068-FR4.4：流光进度条
import { PageHeader, PageShell } from '../ui/layout';
import { useActiveProject } from '../ui/activeProject'; // T06395：项目范围统一由顶栏切换器驱动，页面不再保留独立下拉
import { priorityBadgeLabel, priorityColor } from '../ui/priority'; // T05777：优先级分布沿用单源文案/颜色
import { TODAY_REFRESH_ICON, TodayBoard } from './TodayBoard';

/** T01059-FR2.2：统计仪表盘——周吞吐/AI 成功率/AI 平均耗时/验证通过率四指标 + 吞吐趋势条形图。
 *  数据源 /api/stats/dashboard；纯 CSS 条形图（无图表库依赖）；项目/时间窗筛选。 */

interface DashboardData {
  days: number;
  throughput: Array<{ date: string; count: number }>;
  ai: { total: number; ok: number; rate: number; avgMs: number };
  verify: { total: number; verified: number; rate: number };
  totals: { todo: number; done: number; other: number };
  /** T05777：新增维度聚合；旧服务端可能不返回，前端按可选处理 */
  breakdown?: {
    priorities: Array<{ priority: string; count: number }>;
    categories: Array<{ name: string; count: number }>;
    plans: { total: number; todo: number; doing: number; done: number; avgProgress: number };
    workload: Array<{ id: string; name: string; total: number; todo: number; done: number; other: number }>;
  };
}

const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
];

function StatCard({ icon, label, value, sub, accent }: { readonly icon: React.ReactNode; readonly label: string; readonly value: string; readonly sub: string; readonly accent?: boolean }) {
  return (
    <div style={{ flex: '1 1 200px', padding: 14, border: `1px solid ${accent ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10, background: 'var(--card-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>{icon}{label}</div>
      <div style={{ fontSize: 'var(--fs-display)', fontWeight: 700, color: accent ? 'var(--accent)' : 'var(--text)', marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}

/** T05777：统一的分组条形明细——用于优先级/分类/项目工作量，空数据给明确空态。 */
function BarList({ items, empty }: { readonly items: Array<{ label: string; count: number; color?: string; title?: string }>; readonly empty: string }) {
  const total = items.reduce((s, x) => s + x.count, 0);
  const max = Math.max(1, ...items.map((x) => x.count));
  if (items.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-s)', padding: '6px 0' }}>{empty}</div>;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {items.map((x) => (
        <div key={x.label} title={x.title ?? `${x.label}：${x.count} 条`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-s)', marginBottom: 3 }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{x.label}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{x.count}{total ? `（${Math.round((x.count / total) * 100)}%）` : ''}</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(2, Math.round((x.count / max) * 100))}%`, height: '100%', borderRadius: 3, background: x.color ?? 'var(--accent)', transition: 'width .2s ease' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function InsightCard({ title, sub, children }: { readonly title: string; readonly sub: string; readonly children: React.ReactNode }) {
  return (
    <div data-t05777="insight-card" style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', minWidth: 0 }}>
      <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 10 }}>{sub}</div>
      {children}
    </div>
  );
}

/** T06294：统计下沉为可折叠的「项目统计」区——默认不拉 /stats/dashboard，把首屏让给 Today 三组。 */
function StatsSection({ projectId }: { readonly projectId: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = new URLSearchParams({ days: String(days) });
    if (projectId) q.set('projectId', projectId);
    setData(null); setError('');
    void api.get<DashboardData>(`/stats/dashboard?${q.toString()}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [projectId, days]);

  const maxCount = Math.max(1, ...(data?.throughput ?? []).map((t) => t.count));

  return (
    <section className="mt-dashboard-stats" aria-label="项目统计">
      <div className="mt-dashboard-stats-head">
        <div>
          <h2>项目统计</h2>
          <p>吞吐、AI 成功率与任务结构；只在展开时取数，不阻塞今日首屏。</p>
        </div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }}>
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} type="button"
              style={{ padding: '5px 12px', fontSize: 'var(--fs-s)', border: 'none', cursor: 'pointer', background: days === r.days ? 'var(--accent)' : 'var(--card-bg)', color: days === r.days ? 'var(--accent-text)' : 'var(--text)' }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-m)', padding: 12 }}>加载失败：{error}</div>}
      {!data && !error && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} style={{ flex: '1 1 200px', padding: 14, border: '1px solid var(--border)', borderRadius: 10 }}>
                <div className="skel" style={{ width: 90, height: 12 }} />
                <div className="skel" style={{ width: 120, height: 26, marginTop: 8 }} />
                <div className="skel" style={{ width: 160, height: 11, marginTop: 6 }} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16, padding: 14, border: '1px solid var(--border)', borderRadius: 10 }}>
            <div className="skel" style={{ width: 140, height: 13 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end', height: 90 }}>
              {[60, 34, 80, 45, 70, 25, 88].map((h) => (
                <div key={h} className="skel" style={{ width: 26, height: `${h}%` }} />
              ))}
            </div>
          </div>
        </>
      )}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatCard icon={<ListTodo size={14} />} label="待办 / 已完成" value={`${data.totals.todo} / ${data.totals.done}`} sub={`另有 ${data.totals.other} 条进行中或搁置`} />
            <StatCard icon={<Activity size={14} />} label={`吞吐（${data.days} 天完成）`} value={String(data.throughput.reduce((s, t) => s + t.count, 0))} sub={`日均 ${Math.round(data.throughput.reduce((s, t) => s + t.count, 0) / data.days * 10) / 10} 条`} accent />
            <StatCard icon={<ShieldCheck size={14} />} label={`AI 成功率（${data.days} 天）`} value={`${data.ai.rate}%`} sub={`${data.ai.ok}/${data.ai.total} 次调用成功`} />
            <StatCard icon={<Clock3 size={14} />} label="AI 平均耗时" value={data.ai.avgMs >= 1000 ? `${Math.round(data.ai.avgMs / 100) / 10}s` : `${data.ai.avgMs}ms`} sub={`验证通过率 ${data.verify.rate}%（${data.verify.verified}/${data.verify.total} done 已验证）`} />
          </div>

          {(() => {
            const total = data.totals.done + data.totals.todo + data.totals.other;
            const completion = total ? Math.round((data.totals.done / total) * 100) : 0;
            return (
              <div style={{ marginTop: 12, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-m)', fontWeight: 600, marginBottom: 10 }}>
                  <CheckCircle2 size={14} style={{ color: 'var(--accent)' }} /> 总完成度 {completion}%
                </div>
                <FlowProgress value={completion} aria-label={`总完成度 ${completion}%`} />
              </div>
            );
          })()}

          <div style={{ marginTop: 16, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-m)', fontWeight: 600, marginBottom: 10 }}>
              <CheckCircle2 size={14} style={{ color: 'var(--accent)' }} /> 完成趋势（按完成日，近 {data.days} 天）
            </div>
            {(data.throughput.length === 0) ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-s)', padding: '8px 0' }}>所选范围内暂无完成任务。</div>
            ) : (
              <div role="region" aria-label="完成趋势图表（可横向滚动）" tabIndex={0} style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, overflowX: 'auto' }}>
                {data.throughput.map((t) => (
                  <div key={t.date} title={`${t.date}：完成 ${t.count} 条`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', minWidth: 22, flex: '0 0 auto', height: '100%' }}>
                    <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-secondary)', marginBottom: 2 }}>{t.count}</span>
                    <div style={{ width: 16, height: `${Math.max(4, Math.round((t.count / maxCount) * 96))}px`, background: 'var(--accent)', borderRadius: '3px 3px 0 0', opacity: 0.85 }} />
                    <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap' }}>{t.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.breakdown ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginTop: 16 }}>
              <InsightCard title="任务结构" sub="当前未归档任务的待办 / 完成 / 进行中或搁置构成">
                <BarList
                  items={[
                    { label: '待办', count: data.totals.todo, color: 'var(--text-secondary)' },
                    { label: '已完成', count: data.totals.done, color: 'var(--accent)' },
                    { label: '进行中 / 搁置', count: data.totals.other, color: 'var(--warning)' },
                  ]}
                  empty="暂无任务数据"
                />
              </InsightCard>

              <InsightCard title="优先级分布" sub="按任务优先级统计当前未归档任务">
                <BarList
                  items={data.breakdown.priorities.map((p) => ({
                    label: priorityBadgeLabel(p.priority),
                    count: p.count,
                    color: priorityColor(p.priority),
                    title: `${priorityBadgeLabel(p.priority)}：${p.count} 条`,
                  }))}
                  empty="暂无优先级数据"
                />
              </InsightCard>

              <InsightCard title="分类分布" sub="按任务分类统计，最多展示前 8 类">
                <BarList
                  items={data.breakdown.categories.map((c) => ({ label: c.name, count: c.count, title: `${c.name}：${c.count} 条` }))}
                  empty="暂无分类数据"
                />
              </InsightCard>

              <InsightCard title="计划推进" sub="按未归档计划行统计（含历史快照项目）状态计数与平均进度">
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10, fontSize: 'var(--fs-s)' }}>
                  <span>全部 <strong>{data.breakdown.plans.total}</strong></span>
                  <span style={{ color: 'var(--text-secondary)' }}>待办 {data.breakdown.plans.todo}</span>
                  <span style={{ color: 'var(--accent)' }}>进行中 {data.breakdown.plans.doing}</span>
                  <span style={{ color: 'var(--text-muted)' }}>已完成 {data.breakdown.plans.done}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 4 }}>
                  <span>平均进度</span>
                  <span>{data.breakdown.plans.avgProgress}%</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.max(0, Math.min(100, data.breakdown.plans.avgProgress))}%`, height: '100%', borderRadius: 4, background: 'var(--accent)' }} />
                </div>
                {data.breakdown.plans.total === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-s)', marginTop: 8 }}>暂无项目计划数据</div>}
              </InsightCard>

              <InsightCard title="项目工作量 Top 8" sub={projectId ? '当前筛选项目的未归档任务构成' : '全部项目按未归档任务总量排序（含历史快照项目）'}>
                <BarList
                  items={data.breakdown.workload.map((p) => ({
                    label: p.name,
                    count: p.total,
                    title: `${p.name}：任务 ${p.total}（待办 ${p.todo} · 完成 ${p.done} · 其他 ${p.other}）`,
                  }))}
                  empty="暂无项目工作量数据"
                />
              </InsightCard>
            </div>
          ) : (
            <div style={{ marginTop: 16, padding: 12, border: '1px dashed var(--border-strong)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>
              当前服务端未返回新增统计维度；请更新后端后刷新。
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function DashboardPage() {
  // T06395：首页不再维护独立的项目筛选状态——与顶栏切换器、任务、计划共用同一份全局上下文。
  const [projectId] = useActiveProject();
  const [view, setView] = useState<TodayView | null>(null);
  const [todayLoading, setTodayLoading] = useState(true);
  const [todayError, setTodayError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    let alive = true;
    setView(null);
    setTodayLoading(true);
    setTodayError('');
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    void api.get<TodayView>(`/stats/today${q}`)
      .then((data) => { if (alive) setView(data); })
      .catch((e) => { if (alive) setTodayError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setTodayLoading(false); });
    return () => { alive = false; };
  }, [projectId, reloadKey]);

  const generatedAt = useMemo(() => {
    if (!view?.generated_at) return '';
    const d = new Date(view.generated_at);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  }, [view]);

  const dateLabel = useMemo(
    () => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()),
    [],
  );

  return (
    <PageShell>
      <PageHeader
        title="今日"
        minimal
        description={`${dateLabel} · 先做最要紧的事；一屏看完待办、需要你处理的积压和 AI 进度。`}
        secondaryActions={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setReloadKey((n) => n + 1)} loading={todayLoading} leftIcon={TODAY_REFRESH_ICON}>
              刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowStats((v) => !v)}>
              {showStats ? '收起项目统计' : '项目统计'}
            </Button>
          </>
        )}
      />

      <TodayBoard
        data={view}
        loading={todayLoading}
        error={todayError}
        onRetry={() => setReloadKey((n) => n + 1)}
        generatedAt={generatedAt}
      />

      {showStats && <StatsSection projectId={projectId} />}
    </PageShell>
  );
}
