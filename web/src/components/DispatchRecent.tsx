/**
 * T06267（十期）：任务详情「最近派发」折叠区。
 * 只读 dispatch_attempts，最多 10 条；队列/回执的权威状态仍在 queue_jobs。
 */
import { useEffect, useState } from 'react';
import { ChevronDown, Clock } from 'lucide-react';
import { api, type DispatchAttemptRow } from '../api/client';
import { dispatchChannelName, dispatchChannelTone, humanizeDispatchText } from '../ui/dispatchChannel';

const STATE_LABEL: Record<string, string> = { running: '已受理', done: '已完成', ready: '已回就绪池', manual: '待人工确认', failed: '失败' };

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function DispatchRecent({ taskId, taskNo, refreshToken = 0 }: { readonly taskId: string; readonly taskNo: string | null; readonly refreshToken?: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DispatchAttemptRow[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const q = taskNo ? `taskNo=${encodeURIComponent(taskNo)}` : `taskId=${encodeURIComponent(taskId)}`;
      const r = await api.get<{ items: DispatchAttemptRow[] }>(`/dispatch/attempts?${q}&limit=10`);
      setItems(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // 派发成功后由抽屉抬版本号：已展开时立即刷新，未展开则保留“展开时再读”的惰性
  useEffect(() => {
    if (open && refreshToken > 0) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  return (
    <details
      data-dispatch-recent="1"
      style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}
      onToggle={(e) => {
        const opened = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(opened);
        if (opened && items === null) void load();
      }}
    >
      <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', listStyle: 'none' }}>
        <ChevronDown size={12} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
        <Clock size={12} /> 最近派发
        {items && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>{items.length ? `${items.length} 条` : '尚未派发'}</span>}
        {loading && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>加载中…</span>}
      </summary>
      {error && <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>派发历史加载失败：{error} <button onClick={() => void load()} style={{ border: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>重试</button></div>}
      {items && items.length === 0 && <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>尚未派发。派发后可在这里核对通道、ticket 与降级原因。</div>}
      {items && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 6 }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 'var(--fs-xs)', lineHeight: 1.55 }}>
              <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmt(it.created_at)}</span>
              <span style={{ color: dispatchChannelTone(it.channel), fontWeight: 600, flexShrink: 0 }}>{dispatchChannelName(it.channel)}</span>
              <span style={{ color: it.state === 'failed' ? 'var(--danger)' : it.state === 'running' || it.state === 'done' ? 'var(--success)' : 'var(--text)', flexShrink: 0 }}>{STATE_LABEL[it.state] ?? it.state}</span>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                {humanizeDispatchText(it.detail)}
                {(it.queue_id || it.job_id || it.ticket) && (
                  <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {it.queue_id ? `队列 ${it.queue_id.slice(0, 8)}` : ''}{it.job_id ? ` · job ${it.job_id.slice(0, 8)}` : ''}{it.ticket ? ` · ticket ${it.ticket.slice(0, 10)}` : ''}
                  </span>
                )}
                {it.fallback_reason && <span style={{ display: 'block', color: 'var(--warn)' }}>降级：{humanizeDispatchText(it.fallback_reason)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
