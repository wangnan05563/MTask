/**
 * 移动端：队列（只读视图，§5.3）。卡片列出队列与各 Job 状态徽标；
 * 不提供增删改排，操作区超链接「在桌面端编排」。
 */
import { pageStyle as page, tapCardStyle as card, cardStyle as jobCard, Badge, EmptyState, PullRefresh, Skeleton } from './ui';
import { useEffect, useRef, useState } from 'react';
import { api, type Queue, type QueueJob } from '../api/client';
import { fmtAsOf, loadStaleCache, saveStaleCache } from './offline';
import { ClipboardList, Clock, Copy, ExternalLink, FolderOpen, Pause, Play } from 'lucide-react'; // T03655：空态 + 暂停/继续按钮改 lucide，不再用 emoji/字符

interface Props { readonly notify: (msg: string, isErr?: boolean) => void; readonly openDesktop: () => void; }

const STATUS_LABEL: Record<string, string> = {
  queued: '排队', sending: '发送中', success: '成功', failed: '失败', timeout: '超时', draft: '草稿', running: '进行中', finished: '已完成',
};
const STATUS_COLOR: Record<string, string> = {
  queued: 'var(--text-muted)', sending: 'var(--accent)', success: 'var(--success)', failed: 'var(--danger)', timeout: '#d97706',
};

export function MobileQueue({ notify, openDesktop }: Props) {
  const [queues, setQueues] = useState<Queue[]>([]);
  // M7-7.1：移除 /tasks?archived=0 全量拉取——Job 标题主来源是 /queues/:id JOIN 出的 task_title，
  // 全量表只为极少数已删任务的兜底，代价却是一次全表扫描+全字段序列化
  const [active, setActive] = useState<Queue | null>(null);
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [staleAsOf, setStaleAsOf] = useState<string | null>(null); // T01425：缓存数据时间

  useEffect(() => {
    // T01425：stale-first 渲染缓存，再后台 revalidate
    const cachedQ = loadStaleCache<Queue[]>('queues');
    if (cachedQ) {
      setQueues(cachedQ.data);
      setStaleAsOf(cachedQ.asOf);
    }
    void (async () => {
      try {
        const qs = await api.get<Queue[]>('/queues');
        setQueues(qs);
        saveStaleCache('queues', qs);
        setStaleAsOf(null);
      } catch (e) {
        if (!(cachedQ)) notify(e instanceof Error ? e.message : String(e));
      }
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

  // T01434：队列级暂停/继续（评审修复：busy 防抖防连点双请求竞态）
  const pauseBusy = useRef(false);
  async function togglePause() {
    if (!active || pauseBusy.current) return;
    pauseBusy.current = true;
    try {
      await api.post(`/queues/${active.id}/pause`, { paused: !active.paused });
      const q = await api.get<Queue & { jobs: QueueJob[] }>(`/queues/${active.id}`);
      setActive(q);
      notify(active.paused ? '队列已继续' : '队列已暂停——发送/提交将被拒绝');
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); } finally { pauseBusy.current = false; }
  }

  // T01434：失败 Job 单条重试
  async function retryJob(j: QueueJob) {
    if (!active) return;
    try {
      await api.post(`/queues/${active.id}/jobs/${j.id}/retry`, {});
      notify('Job 已重置为排队中');
      await open(active.id);
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  }

  const taskTitle = (j: QueueJob) => j.task_title ?? j.task_id.slice(0, 8);

  async function copyJob(j: QueueJob) {
    if (!j.response_payload) return;
    try { await navigator.clipboard.writeText(j.response_payload); notify('已复制 AI 文本'); }
    catch { notify('复制失败，请手动选择'); }
  }

  return (
    <div style={page}>
      <header style={hdr}>队列</header>
      <PullRefresh onRefresh={() => { void (async () => { try { const qs = await api.get<Queue[]>('/queues'); setQueues(qs); saveStaleCache('queues', qs); setStaleAsOf(null); } catch { /* 离线刷新失败保留缓存 */ } })(); }}>
      <div style={body}>
        {staleAsOf && (
          <div style={{ marginBottom: 8, padding: '5px 10px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 'var(--fs-s)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={12} aria-hidden /> 数据截至 {fmtAsOf(staleAsOf)}（离线缓存，联网后自动更新）
          </div>
        )}
        {!active && (
          <>
            {queues.length === 0 && <EmptyState icon={<ClipboardList size={32} />} message="暂无队列" hint="在桌面端创建队列后可在此查看" />}
            {queues.map((q) => (
              <button key={q.id} onClick={() => void open(q.id)} style={card}>
                <div style={{ fontWeight: 600 }}>{q.name}</div>
                <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>状态：{STATUS_LABEL[q.status] || q.status}</div>
              </button>
            ))}
          </>
        )}
        {active && (
          <>
            <button onClick={() => { setActive(null); setJobs([]); }} style={back}>‹ 返回队列列表</button>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>
                {active.name}
                {!!active.paused && <Badge tone="danger" style={{ marginLeft: 6 }}>已暂停</Badge>}
              </div>
              <button onClick={() => void togglePause()} title={active.paused ? '继续 — 恢复队列发送/提交' : '暂停 — 暂停后发送/提交将被拒绝'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border-strong)', background: active.paused ? 'var(--accent)' : 'var(--surface-2)', color: active.paused ? 'var(--accent-text)' : 'var(--text)', cursor: 'pointer' }}>
                {active.paused ? <><Play size={11} aria-hidden /> 继续</> : <><Pause size={11} aria-hidden /> 暂停</>}
              </button>
            </div>
            {loading && <div style={{ padding: '8px 0' }}><Skeleton rows={3} card /></div>}
            {jobs.length === 0 && <EmptyState icon={<FolderOpen size={32} />} message="该队列暂无 Job" />}
            {jobs.map((j) => (
              <div key={j.id} style={jobCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 'var(--fs-l)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskTitle(j)}</span>
                  <span style={{ fontSize: 'var(--fs-s)', color: STATUS_COLOR[j.status] || 'var(--text-muted)', flexShrink: 0 }}>● {STATUS_LABEL[j.status] || j.status}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {j.response_payload && (
                    <button onClick={() => void copyJob(j)} style={copyRow}><Copy size={13} /> 复制 AI 文本</button>
                  )}
                  {(j.status === 'failed' || j.status === 'timeout') && (
                    <button onClick={() => void retryJob(j)} title="重试 — 重置该 Job 为排队中"
                      style={{ ...copyRow, color: 'var(--danger)' }}>↻ 重试</button>
                  )}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 8 }}><button onClick={openDesktop} style={deskLink}><ExternalLink size={14} /> 拖拽排序与编辑请在桌面端操作</button></div>
          </>
        )}
      </div>
      </PullRefresh>
    </div>
  );
}

const hdr: React.CSSProperties = { fontSize: 'var(--fs-2xl)', fontWeight: 700, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--card-bg)' };
const body: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: 12 };
const back: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 'var(--fs-m)', cursor: 'pointer', padding: '4px 0', marginBottom: 8 };
const copyRow: React.CSSProperties = { marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' };
const deskLink: React.CSSProperties = { marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-m)', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' };
