import { useEffect, useState } from 'react';
import { Activity, BarChart3, CheckCircle2, Clock3, ListTodo, ShieldCheck } from 'lucide-react';
import { api, type Project } from '../api/client';

/** T01059-FR2.2：统计仪表盘——周吞吐/AI 成功率/AI 平均耗时/验证通过率四指标 + 吞吐趋势条形图。
 *  数据源 /api/stats/dashboard；纯 CSS 条形图（无图表库依赖）；项目/时间窗筛选。 */

interface DashboardData {
  days: number;
  throughput: Array<{ date: string; count: number }>;
  ai: { total: number; ok: number; rate: number; avgMs: number };
  verify: { total: number; verified: number; rate: number };
  totals: { todo: number; done: number; other: number };
}

const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
];

function StatCard({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div style={{ flex: '1 1 200px', padding: 14, border: `1px solid ${accent ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10, background: 'var(--card-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>{icon}{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent ? 'var(--accent)' : 'var(--text)', marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}

export function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<Project[]>('/projects').then((ps) => setProjects(ps.filter((p) => p.id !== 'sys-inbox'))).catch(() => {});
  }, []);
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
    <div style={{ padding: 16, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <BarChart3 size={18} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>统计仪表盘</span>
        <span style={{ flex: 1 }} />
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="统计项目筛选"
          style={{ fontSize: 12, padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}
        >
          <option value="">全部项目</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }}>
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)}
              style={{ padding: '5px 12px', fontSize: 12, border: 'none', cursor: 'pointer', background: days === r.days ? 'var(--accent)' : 'var(--card-bg)', color: days === r.days ? 'var(--accent-text)' : 'var(--text)' }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 13, padding: 12 }}>加载失败：{error}</div>}
      {/* T01067-FR3.3：加载骨架屏——四指标卡 + 趋势条占位微光 */}
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
              {[60, 34, 80, 45, 70, 25, 88].map((h, i) => (
                <div key={i} className="skel" style={{ width: 26, height: `${h}%` }} />
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

          <div style={{ marginTop: 16, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              <CheckCircle2 size={14} style={{ color: 'var(--accent)' }} /> 完成趋势（按完成日，近 {data.days} 天）
            </div>
            {(data.throughput.length === 0) ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>所选范围内暂无完成任务。</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, overflowX: 'auto' }}>
                {data.throughput.map((t) => (
                  <div key={t.date} title={`${t.date}：完成 ${t.count} 条`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', minWidth: 22, flex: '0 0 auto', height: '100%' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>{t.count}</span>
                    <div style={{ width: 16, height: `${Math.max(4, Math.round((t.count / maxCount) * 96))}px`, background: 'var(--accent)', borderRadius: '3px 3px 0 0', opacity: 0.85 }} />
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap' }}>{t.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
