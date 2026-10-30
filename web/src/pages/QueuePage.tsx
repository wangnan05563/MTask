import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Queue, type QueueJob, type Task, type AITool } from '../api/client';
import { Plus, Minus, Pause, ListPlus, RotateCcw, Send, Eye, ChevronUp, Check, Copy, Layers, Loader2, Trash2, RefreshCw } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState'; // T01072-FR1.10：统一空态组件
import { askConfirm } from '../ui/dialogs'; // T01298：删除队列/移除任务前确认

/** T01066-FR1.8：并行任务池状态（running 槽位 + 上限 + 排队计数） */
interface PoolStatus {
  limit: number;
  queued: number;
  running: Array<{ id: string; task_no: string | null; title: string; ai_state_at: string; project_name: string }>;
}

/** T03272（UX-12/D-10）：任务池 15s 自动刷新；队列任务项执行中 2s 刷新——两个口径分别验收 */
const POOL_POLL_MS = 15000;
const JOB_POLL_MS = 2000;

export function QueuePage() {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [active, setActive] = useState<Queue | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tools, setTools] = useState<AITool[]>([]);
  const [selectedTask, setSelectedTask] = useState('');
  const [selectedTool, setSelectedTool] = useState('');
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  // T01066-FR1.8：任务池状态轮询 + 上限调整 + 单任务暂停（移出分发池 = 搁置）
  // T03272（UX-12）：任务池 15s 轮询口径与执行会话 ≤2s 口径分开定义，不混用同一常量
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [poolUpdatedAt, setPoolUpdatedAt] = useState<number | null>(null);
  const [poolRefreshing, setPoolRefreshing] = useState(false);
  const [poolError, setPoolError] = useState('');
  const loadPool = useCallback(async (opts: { manual?: boolean } = {}) => {
    const manual = Boolean(opts.manual);
    if (manual) setPoolRefreshing(true);
    try {
      const next = await api.get<PoolStatus>('/pool/status');
      setPool(next);
      setPoolUpdatedAt(Date.now());
      setPoolError('');
    } catch (e) {
      // T03272③：失败保留上次成功数据（不 setPool(null)、不清 updatedAt），只明确报失败
      setPoolError(e instanceof Error ? e.message : String(e));
    } finally {
      if (manual) setPoolRefreshing(false);
    }
  }, []);
  useEffect(() => {
    void loadPool();
    const t = setInterval(() => void loadPool(), POOL_POLL_MS);
    return () => clearInterval(t);
  }, [loadPool]);
  async function changePoolLimit(n: number) {
    if (n < 1 || n > 10) return;
    try { await api.put('/pool/limit', { limit: n }); await loadPool(); } catch (e) { flash(String((e as Error).message ?? e)); }
  }
  async function pauseRunning(taskId: string) {
    try {
      await api.post(`/tasks/${taskId}/shelve`, { shelved: true });
      flash('已暂停：任务移出分发池（搁置），可在任务菜单搁置列表恢复');
      void loadPool();
    } catch (e) { flash(String((e as Error).message ?? e)); }
  }

  const load = useCallback(async () => {
    setQueues(await api.get<Queue[]>('/queues'));
    // M7-7.2：status=待办 服务端过滤 + 显式 limit=500（提交选单取最近 500 条待办；原为全量拉取后本地筛）
    setTasks((await api.get<Task[]>('/tasks?archived=0&status=todo&limit=500')));
    setTools(await api.get<AITool[]>('/aitools'));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const taskTitle = (job: QueueJob) => job.task_title ?? tasks.find((t) => t.id === job.task_id)?.title ?? job.task_id.slice(0, 8);
  const toolName = (job: QueueJob) => job.tool_name ?? tools.find((t) => t.id === job.tool_id)?.name ?? job.tool_id.slice(0, 8);

  async function open(id: string) {
    setActive(await api.get<Queue>(`/queues/${id}`));
  }

  // 定时器句柄类型跟随 globalThis.setInterval 返回值：浏览器为 number、Node 类型环境为 Timeout，两者都兼容
  const refreshTimer = useRef<ReturnType<typeof globalThis.setInterval> | null>(null);
  /** 异步提交后定时刷新当前队列，直至无在途（sending/queued）Job，再提示完成 */
  function startPolling(queueId: string) {
    stopPolling();
    refreshTimer.current = globalThis.setInterval(async () => {
      try {
        const q = await api.get<Queue>(`/queues/${queueId}`);
        setActive(q);
        if (!q.jobs?.some((j) => j.status === 'sending' || j.status === 'queued')) {
          stopPolling();
          flash('队列已全部执行完成');
        }
      } catch {
        stopPolling();
      }
    }, JOB_POLL_MS);
  }
  function stopPolling() {
    if (refreshTimer.current != null) {
      globalThis.clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
  }
  // 卸载时清理轮询定时器，避免切换页面后残留刷新
  useEffect(() => () => stopPolling(), []);

  async function createQueue() {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const q = await api.post<Queue>('/queues', { name: `${date} 开发队列`, date });
    await open(q.id);
    void load();
  }

  async function addJob() {
    if (!active || !selectedTask || !selectedTool) return;
    await api.post(`/queues/${active.id}/jobs`, { items: [{ taskId: selectedTask, toolId: selectedTool }] });
    await open(active.id);
    setSelectedTask(''); setSelectedTool('');
  }

  async function send() {
    if (!active) return;
    setBusy(true);
    try {
      // 异步提交：受理即返回，后台 poller 收敛结果，前端定时刷新进度
      await api.post<QueueJob[]>(`/queues/${active.id}/submit`);
      await open(active.id);
      flash('已提交队列（异步结果将自动刷新）');
      startPolling(active.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** 重试失败：将队列中 failed/timeout 的 Job 重置为 queued，供用户修改后可重新发送 */
  async function retryFailed() {
    if (!active) return;
    try {
      await api.post(`/queues/${active.id}/reset`);
      await open(active.id);
      flash('已重置失败项，可重新发送队列');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** T01298：从队列移除单个任务项（sending 在途项由后端拒绝，前端也不展示入口） */
  async function removeJob(job: QueueJob) {
    if (!active) return;
    if (!(await askConfirm(`从队列移除「${taskTitle(job)}」？移除后可重新加入。`))) return;
    try {
      await api.del(`/queues/${active.id}/jobs/${job.id}`);
      await open(active.id);
      flash('已从队列移除');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** T01298：删除整个队列（任务项随级联清理）；删除后回到未选中态 */
  async function deleteQueue() {
    if (!active) return;
    if (!(await askConfirm(`删除队列「${active.name}」？队列内全部任务项将一并移除，不可恢复。`))) return;
    try {
      await api.del(`/queues/${active.id}`);
      stopPolling();
      setActive(null);
      setExpandedJob(null);
      void load();
      flash('队列已删除');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** FR5.1 采纳：保存 AI 文本到任务并置 done（仅保存文本，人工合并） */
  async function adopt(job: QueueJob) {
    if (!job.response_payload) return;
    try {
      await api.post(`/tasks/${job.task_id}/adopt`, { content: job.response_payload });
      await open(active!.id);
      void load();
      flash(`已采纳「${taskTitle(job)}」，任务置为完成`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function copy(job: QueueJob) {
    if (!job.response_payload) return;
    try {
      await navigator.clipboard.writeText(job.response_payload);
      flash('已复制 AI 文本，请粘贴到目标位置人工合并');
    } catch {
      flash('复制失败，请手动选择文本');
    }
  }

  const STATUS_COLOR: Record<string, string> = {
    queued: 'var(--text-muted)', sending: 'var(--accent)', success: 'var(--success)', failed: 'var(--danger)', timeout: '#d97706',
  };

  return (
    <section>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <select value={active?.id ?? ''} onChange={(e) => e.target.value && void open(e.target.value)} aria-label="选择队列" style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">选择队列…</option>
          {queues.map((q) => <option key={q.id} value={q.id}>{q.name}（{q.status}）</option>)}
        </select>
        <button
          onClick={() => void createQueue()}
          title="新建今日队列 — 创建今天的开发队列并打开"
          aria-label="新建今日队列：创建今天的开发队列并打开"
        >
          + <Plus size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> 新建今日队列
        </button>
        {active && active.status !== 'running' && (
          <button
            onClick={() => void send()}
            disabled={busy}
            title={busy ? '发送中 — 正在发送队列到 AI 工具' : '发送队列 — 将队列交付 AI 处理并保存回执'}
            aria-label={busy ? '发送中：正在发送队列到 AI 工具' : '发送队列：将队列交付 AI 处理并保存回执'}
            style={{ background: 'var(--success)', color: 'var(--on-solid)', border: 'none', padding: '6px 14px', borderRadius: 6, cursor: 'pointer' }}
          >
            {busy ? '发送中…' : <><Send size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> 发送队列</>}
          </button>
        )}
        {active && active.status !== 'running' && (
          <button
            onClick={() => void retryFailed()}
            title="重试失败 — 将队列中失败/超时的任务重置为待发送"
            aria-label="重试失败：将队列中失败/超时的任务重置为待发送"
            style={{ background: 'transparent', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <RotateCcw size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> 重试失败
          </button>
        )}
        {active && active.status !== 'running' && (
          <button
            onClick={() => void deleteQueue()}
            title="删除队列 — 删除当前队列及其全部任务项（不可恢复）"
            aria-label="删除队列：删除当前队列及其全部任务项"
            style={{ background: 'transparent', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--danger)' }}
          >
            <Trash2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> 删除队列
          </button>
        )}
        {notice && <output className="flash-toast">{notice}</output>}
      </div>

      {/* T01066-FR1.8：并行任务池——运行中槽位可视化（running/上限）+ 排队计数 + 单任务暂停（移出分发池=搁置） */}
      <div style={{ border: '1px solid var(--accent)', borderRadius: 10, padding: 12, margin: '12px 0', background: 'var(--accent-soft)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Layers size={14} style={{ color: 'var(--accent)' }} /> 任务池
          </div>
          {/* 槽位格：实心=占用（running），空心=空闲 */}
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} title={pool ? `并行槽位：${pool.running.length}/${pool.limit}` : '并行槽位：尚未获取'}>
            {pool && Array.from({ length: pool.limit }, (_, i) => (
              <span key={i} style={{ width: 12, height: 12, borderRadius: '50%', border: '1px solid var(--accent)', background: i < pool.running.length ? 'var(--accent)' : 'transparent', display: 'inline-block' }} />
            ))}
            <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text)', marginLeft: 4 }}>{pool ? `${pool.running.length}/${pool.limit} 运行中` : '— 运行中'}</span>
          </span>
          <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>排队就绪 {pool ? `${pool.queued} 条` : '—'}</span>
          <span style={{ flex: 1 }} />
          {/* T03272（UX-12）：最后成功更新时间 + 手动刷新（立即发起、带加载态） */}
          <span aria-live="polite" title="任务池最后一次成功刷新的时间（自动刷新 15 秒）" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {poolUpdatedAt ? `最后更新 ${new Date(poolUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未获取'}
          </span>
          <button
            onClick={() => void loadPool({ manual: true })}
            disabled={poolRefreshing}
            title="刷新任务池 — 立即重新获取（自动刷新 15 秒）"
            aria-label={poolRefreshing ? '刷新中：正在重新获取任务池数据' : '刷新任务池：立即重新获取任务池数据'}
            style={{ fontSize: 'var(--fs-xs)', padding: '3px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text-secondary)', cursor: poolRefreshing ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <RefreshCw size={12} className={poolRefreshing ? 'aispin' : undefined} />
            {poolRefreshing ? '刷新中…' : '刷新'}
          </button>
          {/* 并发上限调整（1~10，存 app_settings） */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
            {'并行上限'}
            <button onClick={() => void changePoolLimit((pool?.limit ?? 3) - 1)} disabled={!pool || pool.limit <= 1}
              title="下调并行上限" aria-label="下调并行上限"
              style={{ width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' }}><Minus size={12} aria-hidden /></button>
            <b style={{ color: 'var(--accent)' }}>{pool?.limit ?? '—'}</b>
            <button onClick={() => void changePoolLimit((pool?.limit ?? 3) + 1)} disabled={!pool || pool.limit >= 10}
              title="上调并行上限" aria-label="上调并行上限"
              style={{ width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' }}><Plus size={12} aria-hidden /></button>
          </span>
        </div>
        {(pool?.running.length ?? 0) > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(pool?.running ?? []).map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--fs-s)' }}>
                <Loader2 size={12} className="aispin" style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <span style={{ color: 'var(--accent)', flexShrink: 0 }}>{r.task_no ?? '—'}</span>
                <span style={{ color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${r.title}（${r.project_name}）`}>{r.title}</span>
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.project_name} · 运行 {Math.max(1, Math.round((Date.now() - new Date(r.ai_state_at).getTime()) / 60000))} 分钟</span>
                <button onClick={() => void pauseRunning(r.id)} title="暂停 — 将任务移出分发池（转为搁置）；已在 Agent 侧执行的动作无法强制中断"
                  aria-label={`暂停任务 ${r.task_no ?? ''}`}
                  style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Pause size={12} aria-hidden /> 暂停
                </button>
              </div>
            ))}
          </div>
        )}
        {poolError && (
          <div role="status" style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
            任务池刷新失败：{poolError}（保留{poolUpdatedAt ? '上次成功数据' : '上次获取结果'}，未清空）
          </div>
        )}
        <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          暂停 = 移出分发池（转搁置，恢复请在任务菜单搁置列表操作）；Agent 侧已开始执行的动作不受影响。
        </div>
      </div>

      {/* T01072-FR1.10：统一空态——无队列时动作直达新建 */}
      {queues.length === 0 && (
        <EmptyState
          icon={<ListPlus size={18} />}
          title="暂无开发队列"
          hint="队列用于把任务批量交付 AI 工具并留存回执；新建今日队列后选择任务与 AI 工具即可加入。"
          action={{ label: '新建今日队列', onClick: () => void createQueue() }}
        />
      )}

      {active && (
        <>
          <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
            <select value={selectedTask} onChange={(e) => setSelectedTask(e.target.value)} aria-label="选择待办任务" style={{ flex: 1, padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
              <option value="">选择待办任务…</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <select value={selectedTool} onChange={(e) => setSelectedTool(e.target.value)} aria-label="选择 AI 工具" style={{ flex: 1, padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
              <option value="">选择 AI 工具…</option>
              {tools.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.type}）</option>)}
            </select>
            <button
              onClick={() => void addJob()}
              title="加入队列 — 将选中的任务与 AI 工具加入当前队列"
              aria-label="加入队列：将选中的任务与 AI 工具加入当前队列"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 4px', gap: 4 }}
            >
              <ListPlus size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            </button>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-m)' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>#</th>
                <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>任务</th>
                <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>工具</th>
                <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>状态</th>
                <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>回执摘要</th>
                <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {(active.jobs ?? []).map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  taskTitle={taskTitle(j)}
                  toolName={toolName(j)}
                  statusColor={STATUS_COLOR[j.status] ?? 'var(--text)'}
                  expanded={expandedJob === j.id}
                  onToggle={() => setExpandedJob(expandedJob === j.id ? null : j.id)}
                  onAdopt={() => void adopt(j)}
                  onCopy={() => void copy(j)}
                  onDelete={() => void removeJob(j)}
                />
              ))}
              {(active.jobs ?? []).length === 0 && (
                <tr><td colSpan={6} style={{ padding: 16, color: 'var(--text-muted)', textAlign: 'center' }}>队列为空，从上方选择待办任务与 AI 工具加入</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function JobRow(props: {
  readonly job: QueueJob;
  readonly taskTitle: string;
  readonly toolName: string;
  readonly statusColor: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onAdopt: () => void;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
}) {
  const { job, taskTitle, toolName, statusColor, expanded, onToggle, onAdopt, onCopy, onDelete } = props;
  const canAdopt = job.status === 'success' && !!job.response_payload;
  const canRemove = job.status !== 'sending'; // T01298：在途项不可移除（后端同样拒绝）
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td style={{ padding: 8, borderBottom: '1px solid var(--surface-2)' }}>{job.order_index}</td>
        <td style={{ padding: 8, borderBottom: '1px solid var(--surface-2)' }}>{taskTitle}</td>
        <td style={{ padding: 8, borderBottom: '1px solid var(--surface-2)' }}>{toolName}</td>
        <td style={{ padding: 8, borderBottom: '1px solid var(--surface-2)' }}>
          <span style={{ color: statusColor }}>{job.status}</span>
          {job.error && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>{job.error}</div>}
        </td>
        <td style={{ padding: 8, borderBottom: '1px solid var(--surface-2)', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          {job.response_payload ? job.response_payload.slice(0, 60) : '-'}
        </td>
        <td style={{ padding: 8, borderBottom: '1px solid var(--surface-2)' }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onToggle}
            title={expanded ? '收起 — 收起该回执的展开详情' : '审阅 — 展开查看 AI 返回文本详情'}
            aria-label={expanded ? '收起：收起该回执的展开详情' : '审阅：展开查看 AI 返回文本详情'}
            style={{ fontSize: 'var(--fs-s)', marginRight: 6 }}
          >
            {expanded ? <ChevronUp size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> : <Eye size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
          </button>
          {canAdopt && (
            <button
              onClick={onAdopt}
              title="采纳 — 采纳该 AI 结果并应用到任务"
              aria-label="采纳：采纳该 AI 结果并应用到任务"
              style={{ fontSize: 'var(--fs-s)', marginRight: 6, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
            >
              <Check size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            </button>
          )}
          {canAdopt && (
            <button
              onClick={onCopy}
              title="复制 — 复制任务内容到剪贴板"
              aria-label="复制：复制任务内容到剪贴板"
              style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
            >
              <Copy size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            </button>
          )}
          {canRemove && (
            <button
              onClick={onDelete}
              title="移除 — 将该任务项从队列中移除（可重新加入）"
              aria-label="移除：将该任务项从队列中移除"
              style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', color: 'var(--danger)' }}
            >
              <Trash2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: '8px 12px', background: 'var(--surface)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 40%', minWidth: 260 }}>
                <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 4 }}>发送内容快照（request_payload）</div>
                <pre style={{ margin: 0, padding: 8, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--fs-s)', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                  {job.request_payload ?? '-'}
                </pre>
              </div>
              <div style={{ flex: '1 1 40%', minWidth: 260 }}>
                <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 4 }}>AI 返回文本（response_payload，待人工合并）</div>
                <pre style={{ margin: 0, padding: 8, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--fs-s)', whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>
                  {job.response_payload ?? '-'}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
