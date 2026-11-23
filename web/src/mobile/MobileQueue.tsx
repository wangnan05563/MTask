/**
 * 移动端：队列（消费监控 + 回执采纳/撤回）。卡片列出队列与各 Job 状态徽标；
 * 编排（增删改排）仍在桌面端，但「采纳/撤回」已可在手机上闭环。
 */
import { pageStyle as page, tapCardStyle as card, cardStyle as jobCard, Badge, EmptyState, PullRefresh, Skeleton } from './ui';
import { useEffect, useRef, useState } from 'react';
import { api, type Queue, type QueueJob, type QueueJobSummary } from '../api/client';
import { computeQueueMetrics, fmtCost } from '../pages/queueMetrics';
import { fmtAsOf, loadStaleCache, saveStaleCache } from './offline';
import { AlertTriangle, Check, ClipboardList, Clock, Copy, ExternalLink, FolderOpen, Pause, Play, Undo2 } from 'lucide-react'; // T03655：空态 + 暂停/继续按钮改 lucide，不再用 emoji/字符

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
  const [summary, setSummary] = useState<Record<string, QueueJobSummary>>({}); // 列表进度尾巴：同名队列靠日期 + 进度区分
  const [loading, setLoading] = useState(false);
  const [staleAsOf, setStaleAsOf] = useState<string | null>(null); // T01425：缓存数据时间

  // 队列消费汇总：一次性取全量，失败不阻断列表
  const loadSummary = async () => {
    try {
      const rows = await api.get<QueueJobSummary[]>('/queues/summary');
      const map: Record<string, QueueJobSummary> = {};
      for (const r of rows) map[r.id] = r;
      setSummary(map);
    } catch { /* 汇总不可用时列表照常展示 */ }
  };

  const tailOf = (id: string): string => {
    const s = summary[id];
    if (!s || s.job_total === 0) return '';
    const failed = s.job_failed + s.job_timeout;
    return ` · ${s.job_success}/${s.job_total}${failed > 0 ? ` · 失败 ${failed}` : ''}${(s.job_unadopted ?? 0) > 0 ? ` · 待采纳 ${s.job_unadopted}` : ''}`;
  };

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
        void loadSummary();
      } catch (e) {
        if (!(cachedQ)) notify(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [notify]); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(id: string) {
    setLoading(true);
    try {
      const q = await api.get<Queue & { jobs: QueueJob[] }>(`/queues/${id}?t=${Date.now()}`);
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
      const q = await api.get<Queue & { jobs: QueueJob[] }>(`/queues/${active.id}?t=${Date.now()}`);
      setActive(q);
      // 列表态同步：否则返回列表后仍显示旧的「未暂停」状态，用户以为没生效
      setQueues((prev) => prev.map((x) => (x.id === q.id ? { ...x, paused: q.paused, status: q.status } : x)));
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
      void loadSummary(); // 失败→排队会改变列表进度尾巴
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  }

  const taskTitle = (j: QueueJob) => j.task_title ?? j.task_id.slice(0, 8);

  // 在途项每 2s 重算一次（「在途/已等待」不冻结）；无在途时不跑定时器
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'sending')) return;
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, [jobs]);
  const metrics = computeQueueMetrics(jobs);

  async function copyJob(j: QueueJob) {
    if (!j.response_payload) return;
    try { await navigator.clipboard.writeText(j.response_payload); notify('已复制 AI 文本'); }
    catch { notify('复制失败，请手动选择'); }
  }

  // T06076：移动端也能闭环——采纳把回执写入任务「处理结果」，撤回恢复采纳前状态
  async function adoptJob(j: QueueJob) {
    if (!active || !j.response_payload) return;
    const warns = j.quality_warnings ?? [];
    if (warns.length > 0) {
      const detail = warns.map((w) => `· ${w.label}：${w.detail}`).join('\n');
      if (!window.confirm(`该回执有 ${warns.length} 项质量提示：\n${detail}\n\n仍要写入任务「处理结果」吗？`)) return;
    }
    try {
      await api.post(`/queues/${active.id}/jobs/${j.id}/adopt`, { force: warns.length > 0 });
      notify(`已采纳：${taskTitle(j)} 的处理结果已写入`);
      await open(active.id);
      void loadSummary();
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  }

  async function unadoptJob(j: QueueJob) {
    if (!active) return;
    if (!window.confirm(`撤回「${taskTitle(j)}」的采纳？将恢复采纳前的处理结果与任务状态。`)) return;
    try {
      await api.post(`/queues/${active.id}/jobs/${j.id}/unadopt`, {});
      notify(`已撤回采纳：${taskTitle(j)} 的处理结果与状态已恢复`);
      await open(active.id);
      void loadSummary();
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
  }

  return (
    <div style={page}>
      <header style={hdr}>队列</header>
      <PullRefresh onRefresh={() => { void (async () => { try { const qs = await api.get<Queue[]>('/queues'); setQueues(qs); saveStaleCache('queues', qs); setStaleAsOf(null); void loadSummary(); } catch { /* 离线刷新失败保留缓存 */ } })(); }}>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.name}</span>
                  {!!q.paused && <Badge tone="danger" style={{ flexShrink: 0 }}>已暂停</Badge>}
                </div>
                <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
                  {q.date} · 状态：{STATUS_LABEL[q.status] || q.status}{tailOf(q.id)}
                </div>
              </button>
            ))}
          </>
        )}
        {active && (
          <>
            <button onClick={() => { setActive(null); setJobs([]); }} style={back}>‹ 返回队列列表</button>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ fontWeight: 600, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {active.name}
                  {!!active.paused && <Badge tone="danger" style={{ marginLeft: 6 }}>已暂停</Badge>}
                </div>
                <div style={{ fontSize: 'var(--fs-s)', fontWeight: 400, color: 'var(--text-muted)' }}>
                  {active.date} · {STATUS_LABEL[active.status] || active.status}{tailOf(active.id)}
                </div>
              </div>
              <button onClick={() => void togglePause()} title={active.paused ? '继续 — 恢复队列发送/提交' : '暂停 — 暂停后发送/提交将被拒绝'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', padding: '8px 14px', minHeight: 40, borderRadius: 6, border: '1px solid var(--border-strong)', background: active.paused ? 'var(--accent)' : 'var(--surface-2)', color: active.paused ? 'var(--accent-text)' : 'var(--text)', cursor: 'pointer' }}>
                {active.paused ? <><Play size={11} aria-hidden /> 继续</> : <><Pause size={11} aria-hidden /> 暂停</>}
              </button>
            </div>
            {loading && <div style={{ padding: '8px 0' }}><Skeleton rows={3} card /></div>}
            {/* 只读消费监控：口径与桌面端 queueMetrics 完全一致，避免两端成功率/耗时算法漂移 */}
            {jobs.length > 0 && (
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
                  <span>消费监控（只读）</span>
                  <span>已收口 {metrics.settled}/{metrics.total} · 成功率 {metrics.successRate === null ? '—' : `${Math.round(metrics.successRate * 100)}%`}</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', margin: '8px 0' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.round(metrics.progress * 100)}%`, background: metrics.failed > 0 ? 'var(--danger)' : 'var(--success)', transition: 'width .2s ease' }} />
                </div>
                <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
                  成功 {metrics.success} · 失败 {metrics.failed} · 在途 {metrics.sending} · 排队 {metrics.queued}
                </div>
                <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginTop: 2 }}>
                  平均耗时 {fmtCost(metrics.avgCostMs)} · 最长 {fmtCost(metrics.maxCostMs)}
                </div>
              </div>
            )}
            {jobs.length === 0 && <EmptyState icon={<FolderOpen size={32} />} message="该队列暂无 Job" />}
            {jobs.map((j) => (
              <div key={j.id} style={jobCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 'var(--fs-l)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskTitle(j)}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {!!j.adopted_at && <Badge tone="success">已采纳</Badge>}
                    {(j.quality_warnings?.length ?? 0) > 0 && (
                      <span title={(j.quality_warnings ?? []).map((w) => `${w.label}：${w.detail}`).join('\n')} style={{ color: 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        <AlertTriangle size={13} aria-hidden /> 质量待核 {j.quality_warnings!.length}
                      </span>
                    )}
                    <span style={{ fontSize: 'var(--fs-s)', color: STATUS_COLOR[j.status] || 'var(--text-muted)' }}>● {STATUS_LABEL[j.status] || j.status}</span>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {j.response_payload && (
                    <button onClick={() => void copyJob(j)} style={copyRow}><Copy size={13} /> 复制 AI 文本</button>
                  )}
                  {j.status === 'success' && !!j.response_payload && !j.adopted_at && (
                    <button onClick={() => void adoptJob(j)} style={{ ...copyRow, color: 'var(--success)' }} title="采纳 — 写入任务处理结果并把任务置为完成">
                      <Check size={13} /> 采纳
                    </button>
                  )}
                  {!!j.adopted_at && (
                    <button onClick={() => void unadoptJob(j)} style={{ ...copyRow, color: 'var(--text-secondary)' }} title="撤回采纳 — 恢复采纳前的处理结果与任务状态">
                      <Undo2 size={13} /> 撤回
                    </button>
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
// 移动端点击区域按 40px 高度给足（原 19~27px 太小，手指点不准）
const back: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 'var(--fs-m)', cursor: 'pointer', padding: '10px 0', marginBottom: 8, minHeight: 40, display: 'inline-flex', alignItems: 'center' };
const copyRow: React.CSSProperties = { marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer', minHeight: 40, padding: '8px 10px', marginLeft: -10 };
const deskLink: React.CSSProperties = { marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-m)', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer', minHeight: 40, padding: '8px 0' };
