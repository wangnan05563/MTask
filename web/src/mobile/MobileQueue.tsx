/**
 * 移动端：队列（只读视图，§5.3）。卡片列出队列与各 Job 状态徽标；
 * 不提供增删改排，操作区超链接「在桌面端编排」。
 */
import { useEffect, useState } from 'react';
import { api, type Queue, type QueueJob, type Task } from '../api/client';
import { Copy, ExternalLink } from 'lucide-react';

interface Props { notify: (msg: string) => void; openDesktop: () => void; }

const STATUS_LABEL: Record<string, string> = {
  queued: '排队', sending: '发送中', success: '成功', failed: '失败', timeout: '超时', draft: '草稿', running: '进行中', finished: '已完成',
};
const STATUS_COLOR: Record<string, string> = {
  queued: 'var(--text-muted)', sending: 'var(--accent)', success: 'var(--success)', failed: 'var(--danger)', timeout: '#d97706',
};

export function MobileQueue({ notify, openDesktop }: Props) {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [active, setActive] = useState<Queue | null>(null);
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setQueues(await api.get<Queue[]>('/queues'));
        setTasks(await api.get<Task[]>('/tasks?archived=0'));
      } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
    })();
  }, [notify]);

  async function open(id: string) {
    setLoading(true);
    try {
      const q = await api.get<Queue & { jobs: QueueJob[] }>(`/queues/${id}`);
      setActive(q);
      setJobs(q.jobs ?? []);
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }

  const taskTitle = (j: QueueJob) => j.task_title ?? tasks.find((t) => t.id === j.task_id)?.title ?? j.task_id.slice(0, 8);

  async function copyJob(j: QueueJob) {
    if (!j.response_payload) return;
    try { await navigator.clipboard.writeText(j.response_payload); notify('已复制 AI 文本'); }
    catch { notify('复制失败，请手动选择'); }
  }

  return (
    <div style={page}>
      <header style={hdr}>队列</header>
      <div style={body}>
        {!active && (
          <>
            {queues.length === 0 && <div style={muted}>暂无队列</div>}
            {queues.map((q) => (
              <button key={q.id} onClick={() => void open(q.id)} style={card}>
                <div style={{ fontWeight: 600 }}>{q.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>状态：{STATUS_LABEL[q.status] || q.status}</div>
              </button>
            ))}
          </>
        )}
        {active && (
          <>
            <button onClick={() => { setActive(null); setJobs([]); }} style={back}>‹ 返回队列列表</button>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{active.name}</div>
            {loading && <div style={muted}>加载中…</div>}
            {jobs.length === 0 && <div style={muted}>该队列暂无 Job</div>}
            {jobs.map((j) => (
              <div key={j.id} style={jobCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskTitle(j)}</span>
                  <span style={{ fontSize: 12, color: STATUS_COLOR[j.status] || 'var(--text-muted)', flexShrink: 0 }}>● {STATUS_LABEL[j.status] || j.status}</span>
                </div>
                {j.response_payload && (
                  <button onClick={() => void copyJob(j)} style={copyRow}><Copy size={13} /> 复制 AI 文本</button>
                )}
              </div>
            ))}
            <button onClick={openDesktop} style={deskLink}><ExternalLink size={14} /> 在桌面端编排队列</button>
          </>
        )}
      </div>
    </div>
  );
}

const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--app-bg)', color: 'var(--text)' };
const hdr: React.CSSProperties = { fontSize: 16, fontWeight: 700, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--card-bg)' };
const body: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: 12 };
const card: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: 14, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10, cursor: 'pointer', color: 'var(--text)' };
const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 13, padding: 10 };
const back: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: '4px 0', marginBottom: 8 };
const jobCard: React.CSSProperties = { padding: 12, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10 };
const copyRow: React.CSSProperties = { marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' };
const deskLink: React.CSSProperties = { marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' };
