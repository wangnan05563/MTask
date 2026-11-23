/**
 * T06266（十期）：队列页「派发记录」只读视图。
 *
 * 与人工队列分开：这里只读 kind=dispatch/relay 的内部队列，展示 CodeBuddy 网关 / MCP 就绪池单条或自动派发、
 * 监督中继产生的 job；不提供发送/编辑/删除，避免用户把内部执行链路当人工队列操作。
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, RotateCcw, Send } from 'lucide-react';
import { api, type Queue, type QueueJob, type QueueJobSummary } from '../api/client';
import { BADGE, BADGE_TONE, BTN_SECONDARY_MD, FIELD_SM } from '../ui/primitives';

const KIND_LABEL: Record<string, string> = { dispatch: '网关/就绪池派发', relay: '监督中继' };
const JOB_STATUS: Record<string, string> = {
  queued: '排队', sending: '发送中', success: '成功', failed: '失败', timeout: '超时', draft: '草稿',
};

function fmt(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function DispatchRecordsPanel({ onBack }: { readonly onBack: () => void }) {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [summary, setSummary] = useState<Record<string, QueueJobSummary>>({});
  const [active, setActive] = useState<Queue | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeLoading, setActiveLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [retryBusy, setRetryBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [all, sums] = await Promise.all([
        api.get<Queue[]>('/queues?kind=all'),
        api.get<QueueJobSummary[]>('/queues/summary'),
      ]);
      const internal = all.filter((q) => (q.kind ?? 'manual') !== 'manual');
      setQueues(internal);
      const map: Record<string, QueueJobSummary> = {};
      for (const s of sums) map[s.id] = s;
      setSummary(map);
      setUpdatedAt(Date.now());
      setActive((prev) => {
        if (!prev) return null;
        // 轮询只更新队列卡片字段，必须保留当前详情的 jobs；否则 5s 后会把已加载的 job 列表清空
        const found = internal.find((q) => q.id === prev.id);
        return found ? { ...found, jobs: prev.jobs } : null;
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const openQueue = async (id: string) => {
    setActiveLoading(true);
    setError('');
    try {
      setActive(await api.get<Queue>(`/queues/${id}?t=${Date.now()}`));
    } catch (e) {
      setError(errText(e));
    } finally {
      setActiveLoading(false);
    }
  };

  const activeJobs: QueueJob[] = active?.jobs ?? [];
  const q = query.trim().toLowerCase();
  const visibleQueues = queues.filter((item) => {
    const text = `${item.name} ${item.kind ?? ''} ${item.date}`.toLowerCase();
    return (!q || text.includes(q)) && (statusFilter === 'all' || item.status === statusFilter);
  });
  const visibleJobs = activeJobs.filter((j) => {
    const text = `${j.task_no ?? ''} ${j.task_title ?? ''} ${j.tool_name ?? ''}`.toLowerCase();
    return (!q || text.includes(q)) && (statusFilter === 'all' || j.status === statusFilter);
  });

  const retryJob = async (job: QueueJob) => {
    if (!active || retryBusy) return;
    setRetryBusy(job.id);
    setError('');
    try {
      await api.post(`/queues/${encodeURIComponent(active.id)}/jobs/${encodeURIComponent(job.id)}/retry`, {});
      // 内部派发队列只读，没有「发送队列」入口；重试必须由本按钮完成 reset + 重新提交，
      // 否则 job 只会停在 queued，用户看不到任何重新执行动作。
      await api.post(`/queues/${encodeURIComponent(active.id)}/submit`, {});
      await openQueue(active.id);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setRetryBusy('');
    }
  };

  return (
    <div data-dispatch-records="1">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <button onClick={onBack} style={BTN_SECONDARY_MD}><ArrowLeft size={13} /> 返回人工队列</button>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontSize: 'var(--fs-title)', fontWeight: 700 }}>
          <Send size={17} style={{ color: 'var(--accent)' }} /> 派发记录
        </h2>
        <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>内部队列只读展示；失败 job 可重试，不提供人工编排队列动作</span>
        <span style={{ flex: 1 }} />
        {updatedAt && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>刷新于 {new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
        <button onClick={() => void load()} disabled={loading} style={BTN_SECONDARY_MD} title="刷新派发记录">
          {loading ? <Loader2 size={12} className="aispin" /> : <RefreshCw size={12} />} 刷新
        </button>
      </div>
      <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 8 }}>
        任务的跨通道审计在任务详情「最近派发」；这里看的是内部队列 job 的执行状态（queue_jobs 权威）。
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="过滤任务号 / 队列名 / 工具"
          aria-label="过滤派发记录"
          style={{ ...FIELD_SM, width: 240 }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="按状态过滤" style={{ ...FIELD_SM, width: 130 }}>
          <option value="all">全部状态</option>
          {Object.entries(JOB_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{active ? `${visibleJobs.length}/${activeJobs.length} job` : `${visibleQueues.length}/${queues.length} 队列`}</span>
      </div>
      {error && <output style={{ padding: '6px 10px', border: '1px solid var(--danger)', borderRadius: 8, color: 'var(--danger)', fontSize: 'var(--fs-s)', marginBottom: 8 }}><AlertTriangle size={13} /> {error}</output>}

      {active ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <button onClick={() => setActive(null)} style={BTN_SECONDARY_MD}><ArrowLeft size={12} /> 全部记录</button>
            <b style={{ fontSize: 'var(--fs-m)' }}>{active.name}</b>
            <span style={{ ...BADGE, ...BADGE_TONE.accent }}>{KIND_LABEL[active.kind ?? 'dispatch'] ?? active.kind}</span>
            <span style={{ ...BADGE, ...BADGE_TONE.neutral }}>{active.status}</span>
            {activeLoading && <Loader2 size={12} className="aispin" />}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{active.date}</span>
          </div>
          {visibleJobs.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>{activeJobs.length ? '没有符合筛选条件的 job。' : '这个内部队列没有 job 记录。'}</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                    <th style={{ padding: '5px 6px' }}>任务</th>
                    <th style={{ padding: '5px 6px' }}>工具</th>
                    <th style={{ padding: '5px 6px' }}>状态</th>
                    <th style={{ padding: '5px 6px' }}>ticket</th>
                    <th style={{ padding: '5px 6px' }}>开始</th>
                    <th style={{ padding: '5px 6px' }}>结束</th>
                    <th style={{ padding: '5px 6px' }}>错误</th>
                    <th style={{ padding: '5px 6px' }}>动作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map((j) => (
                    <tr key={j.id} style={{ borderTop: '1px solid var(--border)', verticalAlign: 'top' }}>
                      <td style={{ padding: '5px 6px' }}><span style={{ color: 'var(--accent)' }}>{j.task_no ?? '—'}</span> {j.task_title ?? j.task_id.slice(0, 8)}</td>
                      <td style={{ padding: '5px 6px' }}>{j.tool_name ?? j.tool_id.slice(0, 8)}</td>
                      <td style={{ padding: '5px 6px', color: j.status === 'failed' || j.status === 'timeout' ? 'var(--danger)' : j.status === 'success' ? 'var(--success)' : 'var(--text-secondary)' }}>{JOB_STATUS[j.status] ?? j.status}</td>
                      <td style={{ padding: '5px 6px', color: 'var(--text-muted)' }}>{j.ticket ? j.ticket.slice(0, 12) : '—'}</td>
                      <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>{fmt(j.sent_at)}</td>
                      <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>{fmt(j.finished_at)}</td>
                      <td style={{ padding: '5px 6px', color: 'var(--danger)', maxWidth: 260, wordBreak: 'break-word' }}>{j.error ?? ''}</td>
                      <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>
                        {(j.status === 'failed' || j.status === 'timeout') ? (
                          <button
                            onClick={() => void retryJob(j)}
                            disabled={Boolean(retryBusy)}
                            title="重试失败 job：重新提交同一任务与工具"
                            style={{ ...BTN_SECONDARY_MD, padding: '2px 7px', fontSize: 'var(--fs-xs)' }}
                          >
                            {retryBusy === j.id ? <Loader2 size={11} className="aispin" /> : <RotateCcw size={11} />} 重试
                          </button>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {activeJobs.some((j) => j.response_payload) && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>查看回执文本（只读）</summary>
              {activeJobs.filter((j) => j.response_payload).map((j) => (
                <pre key={j.id} style={{ ...FIELD_SM, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', marginTop: 6 }}>{j.response_payload}</pre>
              ))}
            </details>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 8 }}>
          {visibleQueues.length === 0 && !loading && (
            <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: 24, color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>
              {queues.length ? '没有符合筛选条件的内部队列。' : '暂无内部派发记录。任务详情手动派发或自动调度产生内部队列后，这里会出现记录。'}
            </div>
          )}
          {visibleQueues.map((q) => {
            const s = summary[q.id];
            return (
              <button
                key={q.id}
                onClick={() => void openQueue(q.id)}
                style={{ textAlign: 'left', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', padding: 10, cursor: 'pointer', color: 'var(--text)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 'var(--fs-s)' }}>{q.name}</b>
                  <span style={{ ...BADGE, ...BADGE_TONE.accent }}>{KIND_LABEL[q.kind ?? 'dispatch'] ?? q.kind}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ ...BADGE, ...BADGE_TONE.neutral }}>{q.status}</span>
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 5 }}>{q.date}</div>
                <div style={{ fontSize: 'var(--fs-s)', marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span>总量 {s?.job_total ?? 0}</span>
                  <span style={{ color: 'var(--success)' }}>成功 {s?.job_success ?? 0}</span>
                  <span style={{ color: (s?.job_failed ?? 0) + (s?.job_timeout ?? 0) > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>失败 {(s?.job_failed ?? 0) + (s?.job_timeout ?? 0)}</span>
                  <span style={{ color: 'var(--text-muted)' }}>最近 {fmt(s?.last_activity_at)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
