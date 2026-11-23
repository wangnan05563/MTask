/**
 * 队列菜单（页面容器）：取数、调度、动作与提示；展示交给 queuePanels。
 *
 * 本轮重构要解决的四件事，逐一对应在下面的结构里：
 *   1) 「不知道怎么操作」→ 顶部三步引导 + 空态直达动作 + 条带化文案（选任务→选工具→加入→发送）；
 *   2) 「缺少队列消费监控」→ 队列消费监控面板（进度/成功率/耗时/吞吐/在途/分布），见 QueueMonitor；
 *   3) 「无法按项目选任务」→ 编排区项目筛选 + 任务多选批量加入（队列内已存在任务自动禁选防重复执行）；
 *   4) 「队列名称无法自定义」→ 新建时输入名称、建后 PATCH 重命名。
 *
 * 轮询口径（不要混用）：
 *   - 任务项（本队列）：执行中 2s，空闲 8s（T03272 既有「执行中 2s」验收不变）
 *   - 队列列表与汇总：15s（只为让下拉与总览不至于过期，不承担进度刷新）
 *   - 并行任务池：15s（T03272 既有口径）
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, ListOrdered, Pause, Pencil, Play, Plus, RotateCcw, Search, Send, Trash2 } from 'lucide-react';
import { api, type AITool, type Queue, type QueueJob, type QueueJobSummary, type Task } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { HoverCard } from '../ui/HoverCard';
import { NoticeToast, useNotice } from '../ui/notice';
import { useProjectList } from '../ui/projectList';
import { BTN_DANGER_OUTLINE, BTN_DISABLED, BTN_ICON, BTN_PRIMARY, BTN_SECONDARY_MD } from '../ui/primitives';
import { computeQueueMetrics, type JobFilter } from './queueMetrics';
import { DispatchRecordsPanel } from './DispatchRecordsPanel'; // T06266：内部派发队列只读视图
import { withContextCapacity } from '../utils/modelContext';
import {
  JobTable, PoolPanel, QueueComposer, QueueEmptyState, QueueHeadline, QueueMonitor,
  type PoolStatusView,
} from './queuePanels';

/** T03272（UX-12/D-10）：任务池 15s 自动刷新；队列任务项执行中 2s 刷新——两个口径分别验收 */
const POOL_POLL_MS = 15000;
const JOB_POLL_MS = 2000;
/** 空闲时把本队列刷新降频：没有在途任务时 2s 一次纯属浪费 */
const IDLE_POLL_MS = 8000;
/** 队列列表与消费汇总（下拉/总览用，不承担进度刷新） */
const LIST_POLL_MS = 15000;

/** 首次进入的引导条已读标记（与 guides.tsx 的弹窗向导互补：这里是常驻条带，不遮挡操作） */
const ONBOARD_KEY = 'mtask.queue.onboard.v1';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 发送按钮的禁用原因（按钮 title 与 aria-label 共用，避免两处文案漂移） */
function sendHintOf(queue: Queue | null, pending: number, total: number): string {
  if (!queue) return '先选择一个队列';
  if (queue.status === 'running') return '队列正在发送中，等本批收口后可再次发送';
  if (queue.paused) return '队列已暂停：先在工具条点「继续队列」';
  if (total === 0) return '队列还没有任务项：先在「编排队列」选任务和 AI 工具加入';
  if (pending === 0) return '没有待发送的任务项：全部已成功；可继续加入新任务';
  return `把 ${pending} 个未成功任务项按顺序提交给 AI 工具`;
}

/** T06079：队列工具条图标按钮——统一 HoverCard 气泡、点击缩放动效与禁用态。 */
interface QueueToolButtonProps {
  readonly label: string;
  readonly hint: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly style?: CSSProperties;
}

function QueueToolButton({ label, hint, icon, onClick, disabled, ariaLabel, style }: QueueToolButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const card = `${label} — ${hint}`;
  return (
    <HoverCard card={card} ariaLabel={`${label}：${hint}`} cardW={260} cardH={44} openDelay={150} style={{ flexShrink: 0 }}>
      <button
        onClick={onClick}
        disabled={disabled}
        title={card}
        aria-label={ariaLabel ?? `${label}：${hint}`}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => { setHovered(false); setPressed(false); }}
        onBlur={() => { setHovered(false); setPressed(false); }}
        style={{
          ...BTN_ICON, ...style, width: 32, height: 32, padding: 0, justifyContent: 'center',
          transition: 'transform 150ms ease, box-shadow 150ms ease, filter 150ms ease',
          transform: pressed ? 'scale(0.92)' : 'scale(1)',
          filter: hovered && !disabled ? 'brightness(0.96)' : undefined,
          boxShadow: hovered && !disabled ? '0 0 0 2px var(--accent-soft)' : undefined,
        }}
      >
        {icon}
      </button>
    </HoverCard>
  );
}

export function QueuePage() {
  // T06266：人工队列 / 派发记录二级视图；内部队列不参与人工发送/编辑动作
  const [view, setView] = useState<'queues' | 'dispatch'>('queues');
  const { notice, flash, dismiss } = useNotice();

  const [queues, setQueues] = useState<Queue[]>([]);
  const [summaryMap, setSummaryMap] = useState<Record<string, QueueJobSummary>>({});
  const [queuesError, setQueuesError] = useState('');
  const [loadingQueues, setLoadingQueues] = useState(true);

  const [active, setActive] = useState<Queue | null>(null);
  const [activeError, setActiveError] = useState('');
  const [refreshingActive, setRefreshingActive] = useState(false);
  const [activeUpdatedAt, setActiveUpdatedAt] = useState<number | null>(null);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState('');
  const [projectId, setProjectId] = useState('');
  const [taskKeyword, setTaskKeyword] = useState('');
  const [pickedTaskIds, setPickedTaskIds] = useState<string[]>([]);

  const [tools, setTools] = useState<AITool[]>([]);
  const [toolId, setToolId] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [jobFilter, setJobFilter] = useState<JobFilter>('all');
  const [jobKeyword, setJobKeyword] = useState('');
  const [selectedJobs, setSelectedJobs] = useState<string[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [pool, setPool] = useState<PoolStatusView | null>(null);
  const [poolUpdatedAt, setPoolUpdatedAt] = useState<number | null>(null);
  const [poolRefreshing, setPoolRefreshing] = useState(false);
  const [poolError, setPoolError] = useState('');
  const [poolOpen, setPoolOpen] = useState(false);

  const [onboardOpen, setOnboardOpen] = useState(() => {
    try { return localStorage.getItem(ONBOARD_KEY) !== '1'; } catch { return false; }
  });

  /** 队列成功后自动完成任务：默认关闭，回执只是候选结果，采纳后才算完成 */
  const [autoComplete, setAutoComplete] = useState(false);
  const [autoCompleteBusy, setAutoCompleteBusy] = useState(false);
  const [webSearchMode, setWebSearchMode] = useState<'off' | 'auto' | 'always'>('auto');
  const [webSearchBusy, setWebSearchBusy] = useState(false);

  const projectView = useProjectList();
  /** 轮询回调里读最新的选中 id：避免把 active 对象塞进定时器闭包导致「切队列后仍刷旧队列」 */
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => { activeIdRef.current = active?.id ?? null; }, [active?.id]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get<{ enabled: boolean }>('/settings/queue-auto-complete'),
      api.get<{ mode: 'off' | 'auto' | 'always' }>('/settings/queue-web-search'),
    ]).then(([auto, search]) => {
      if (!alive) return;
      setAutoComplete(Boolean(auto.enabled));
      if (search.mode === 'off' || search.mode === 'auto' || search.mode === 'always') setWebSearchMode(search.mode);
    }).catch(() => { /* 读取失败保持默认：自动完成关闭、检索 auto，不阻断队列页 */ });
    return () => { alive = false; };
  }, []);

  const activeJobs = active?.jobs ?? [];
  const metrics = useMemo(() => computeQueueMetrics(activeJobs, now), [activeJobs, now]);
  const inFlight = activeJobs.some((j) => j.status === 'sending' || j.status === 'queued');
  const failedCount = activeJobs.filter((j) => j.status === 'failed' || j.status === 'timeout').length;
  const pendingCount = activeJobs.filter((j) => j.status !== 'success').length;
  const queuedTaskIds = useMemo(() => new Set(activeJobs.map((j) => j.task_id)), [activeJobs]);

  // ───────── 取数 ─────────

  const loadQueues = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoadingQueues(true);
    try {
      const [list, summary] = await Promise.all([
        api.get<Queue[]>('/queues'),
        api.get<QueueJobSummary[]>('/queues/summary'),
      ]);
      setQueues(list);
      const map: Record<string, QueueJobSummary> = {};
      for (const s of summary) map[s.id] = s;
      setSummaryMap(map);
      setQueuesError('');
    } catch (e) {
      // 失败保留上次数据：空下拉与「真的没有队列」不能同形（用户会误以为数据丢了）
      setQueuesError(errText(e));
    } finally {
      if (!opts.silent) setLoadingQueues(false);
    }
  }, []);

  const open = useCallback(async (id: string) => {
    activeIdRef.current = id;
    try {
      const q = await api.get<Queue>(`/queues/${id}?t=${Date.now()}`);
      // 切队列期间旧请求可能后到：只接受与当前选中一致的响应
      if (activeIdRef.current !== id) return;
      setActive(q);
      setActiveError('');
      setActiveUpdatedAt(Date.now());
      setSelectedJobs([]);
      setExpandedJobId(null);
    } catch (e) {
      setActiveError(errText(e));
    }
  }, []);

  const refreshActive = useCallback(async (opts: { manual?: boolean } = {}) => {
    const id = activeIdRef.current;
    if (!id) return;
    if (opts.manual) setRefreshingActive(true);
    try {
      const q = await api.get<Queue>(`/queues/${id}?t=${Date.now()}`);
      if (activeIdRef.current !== id) return;
      setActive(q);
      setActiveError('');
      setActiveUpdatedAt(Date.now());
    } catch (e) {
      setActiveError(errText(e));
    } finally {
      if (opts.manual) setRefreshingActive(false);
    }
  }, []);

  const loadTasks = useCallback(async (pid: string) => {
    setTasksLoading(true);
    try {
      const qs = new URLSearchParams({ archived: '0', status: 'todo', limit: '500' });
      if (pid) qs.set('projectId', pid);
      const list = await api.get<Task[]>(`/tasks?${qs.toString()}`);
      setTasks(list);
      setTasksError('');
    } catch (e) {
      setTasksError(errText(e));
    } finally {
      setTasksLoading(false);
    }
  }, []);

  const loadPool = useCallback(async (opts: { manual?: boolean } = {}) => {
    if (opts.manual) setPoolRefreshing(true);
    try {
      const next = await api.get<PoolStatusView>('/pool/status');
      setPool(next);
      setPoolUpdatedAt(Date.now());
      setPoolError('');
    } catch (e) {
      setPoolError(errText(e));
    } finally {
      if (opts.manual) setPoolRefreshing(false);
    }
  }, []);

  // ───────── 首屏与自动选中 ─────────

  useEffect(() => {
    void loadQueues();
    void loadPool();
  }, [loadQueues, loadPool]);

  // 项目筛选一变就重取待办任务（后端 /tasks 支持 projectId；不重取会出现「下拉选了项目、列表还是全量」）
  useEffect(() => {
    void loadTasks(projectId);
  }, [loadTasks, projectId]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<AITool[]>('/aitools');
        setTools(list);
        // 默认选「开发默认工具」，少一步操作；没有默认就用第一个，仍可改
        setToolId((prev) => prev || list.find((t) => t.isDefaultDevelop)?.id || list[0]?.id || '');
      } catch (e) {
        flash(`AI 工具列表加载失败：${errText(e)}`, 'error');
      }
    })();
  }, [flash]);

  // 没有选中队列时自动落到第一个，避免「下拉有值但右侧空白」的错觉。
  // 只判断 active 是否为空、**不判断 active 是否在 list 里**：新建队列时 open() 与列表刷新是并行的，
  // 若以「不在列表」为条件，会在列表回来之前把刚建好的队列又切回第一个。
  useEffect(() => {
    if (queues.length === 0) {
      if (active) setActive(null);
      return;
    }
    if (!active) void open(queues[0].id);
  }, [queues, active, open]);

  // ───────── 轮询 ─────────

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void refreshActive(); }, inFlight ? JOB_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [active?.id, inFlight, refreshActive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => { void loadQueues({ silent: true }); }, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [loadQueues]);

  useEffect(() => {
    const timer = setInterval(() => { void loadPool(); }, POOL_POLL_MS);
    return () => clearInterval(timer);
  }, [loadPool]);

  // 有在途任务时本地每秒走表：让「已运行 0:42」持续跳动，而不必等下一次接口刷新
  useEffect(() => {
    if (!activeJobs.some((j) => j.status === 'sending')) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeJobs]);

  // ───────── 队列动作 ─────────

  async function createQueue() {
    const date = today();
    const name = await askInput({
      title: '新建队列',
      defaultValue: `${date} 开发队列`,
      placeholder: '例如：票据系统 P0 修复队列',
    });
    if (name == null) return;
    try {
      const q = await api.post<Queue>('/queues', { name, date });
      await Promise.all([open(q.id), loadQueues({ silent: true })]);
      flash(`已创建队列「${q.name}」：接着在编排区选任务与工具`);
    } catch (e) {
      flash(`新建队列失败：${errText(e)}`, 'error');
    }
  }

  async function renameQueue() {
    if (!active) return;
    const name = await askInput({ title: '重命名队列', defaultValue: active.name });
    if (name == null || name === active.name) return;
    try {
      const q = await api.patch<Queue>(`/queues/${active.id}`, { name });
      setActive((prev) => (prev && prev.id === q.id ? { ...prev, name: q.name } : prev));
      await loadQueues({ silent: true });
      flash('队列已重命名');
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  async function togglePause() {
    if (!active) return;
    const next = !active.paused;
    try {
      await api.post(`/queues/${active.id}/pause`, { paused: next });
      setActive((prev) => (prev ? { ...prev, paused: next ? 1 : 0 } : prev));
      flash(next ? '队列已暂停：发送会被拒绝' : '队列已继续：可以再次发送');
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  async function sendQueue() {
    if (!active) return;
    setBusy(true);
    try {
      // 异步提交：受理即返回，后台 poller 每 5s 收口，本页按 2s 刷新进度
      await api.post(`/queues/${active.id}/submit`);
      await Promise.all([open(active.id), loadQueues({ silent: true })]);
      flash('已提交队列：结果由后台轮询收口，监控区会自动刷新');
    } catch (e) {
      flash(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    if (!active) return;
    try {
      await api.post(`/queues/${active.id}/reset`);
      await open(active.id);
      flash('失败/超时项已重置为排队中，可再次发送');
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  async function deleteQueue() {
    if (!active) return;
    if (!(await askConfirm(`删除队列「${active.name}」？队列内 ${activeJobs.length} 个任务项将一并移除，不可恢复。`))) return;
    try {
      await api.del(`/queues/${active.id}`);
      setActive(null);
      await loadQueues({ silent: true });
      flash('队列已删除');
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  /** T06088：在模型选择旁切换上下文容量，原位更新列表并立即持久化到 model_notes。 */
  async function changeToolContext(targetId: string, capacity: string) {
    const target = tools.find((t) => t.id === targetId);
    if (!target) return;
    const previous = target.model_notes;
    const modelNotes = withContextCapacity(previous, capacity);
    setTools((prev) => prev.map((t) => (t.id === targetId ? { ...t, model_notes: modelNotes } : t)));
    try {
      await api.patch(`/aitools/${targetId}`, { modelNotes });
      flash(`已将「${target.name}」上下文容量切换为 ${capacity}`);
    } catch (e) {
      setTools((prev) => prev.map((t) => (t.id === targetId ? { ...t, model_notes: previous } : t)));
      flash(`上下文容量保存失败：${errText(e)}`, 'error');
    }
  }

  async function addJobs() {    if (!active || pickedTaskIds.length === 0 || !toolId) return;
    setAdding(true);
    try {
      await api.post(`/queues/${active.id}/jobs`, {
        items: pickedTaskIds.map((taskId) => ({ taskId, toolId })),
      });
      const n = pickedTaskIds.length;
      setPickedTaskIds([]);
      await Promise.all([open(active.id), loadQueues({ silent: true })]);
      flash(`已加入 ${n} 个任务项${active.status === 'finished' ? '，可直接再次发送（已成功的不会重复执行）' : ''}`);
    } catch (e) {
      flash(errText(e), 'error');
    } finally {
      setAdding(false);
    }
  }

  async function removeJob(job: QueueJob) {
    if (!active) return;
    const title = job.task_title ?? job.task_no ?? job.task_id.slice(0, 8);
    if (!(await askConfirm(`从队列移除「${title}」？移除后可重新加入。`))) return;
    try {
      await api.del(`/queues/${active.id}/jobs/${job.id}`);
      await Promise.all([open(active.id), loadQueues({ silent: true })]);
      flash('已从队列移除');
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  async function batchRemove() {
    if (!active || selectedJobs.length === 0) return;
    const removable = activeJobs.filter((j) => selectedJobs.includes(j.id) && j.status !== 'sending');
    if (removable.length === 0) { flash('选中的任务项都在执行中，暂不可移除', 'error'); return; }
    if (!(await askConfirm(`从队列移除选中的 ${removable.length} 个任务项？执行中的项会被跳过。`))) return;
    setBusy(true);
    try {
      for (const job of removable) await api.del(`/queues/${active.id}/jobs/${job.id}`);
      setSelectedJobs([]);
      await Promise.all([open(active.id), loadQueues({ silent: true })]);
      flash(`已移除 ${removable.length} 个任务项`);
    } catch (e) {
      flash(errText(e), 'error');
      await open(active.id);
    } finally {
      setBusy(false);
    }
  }

  async function retryJob(job: QueueJob) {
    if (!active) return;
    try {
      await api.post(`/queues/${active.id}/jobs/${job.id}/retry`);
      await open(active.id);
      flash(`「${job.task_title ?? job.task_no ?? '任务项'}」已重置为排队中`);
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  async function adopt(job: QueueJob) {
    if (!active || !job.response_payload) return;
    const warns = job.quality_warnings ?? [];
    if (warns.length > 0) {
      const detail = warns.map((w) => `· ${w.label}：${w.detail}`).join('\n');
      if (!window.confirm(`该回执有 ${warns.length} 项质量提示：\n${detail}\n\n仍要写入任务「处理结果」吗？`)) return;
    }
    try {
      const r = await api.post<{ already: boolean; task: { task_no?: string | null; handle_result?: string } }>(
        `/queues/${active.id}/jobs/${job.id}/adopt`,
        { force: warns.length > 0 },
      );
      if (activeIdRef.current) await open(activeIdRef.current);
      void loadQueues({ silent: true });
      const no = r.task?.task_no ?? job.task_no ?? '任务';
      flash(r.already ? `「${no}」的回执此前已采纳（处理结果未重复覆盖）` : `已采纳：回执写入「${no}」的处理结果，AI 状态已读`);
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  async function unadopt(job: QueueJob) {
    if (!active) return;
    if (!window.confirm(`撤回「${job.task_no ?? job.task_title ?? '该任务'}」的采纳？将恢复采纳前的处理结果与任务状态。`)) return;
    try {
      await api.post(`/queues/${active.id}/jobs/${job.id}/unadopt`, {});
      if (activeIdRef.current) await open(activeIdRef.current);
      void loadQueues({ silent: true });
      flash(`已撤回采纳：${job.task_no ?? '任务'} 的处理结果与状态已恢复`);
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  async function copy(job: QueueJob) {
    if (!job.response_payload) return;
    try {
      await navigator.clipboard.writeText(job.response_payload);
      flash('已复制 AI 回执，可粘贴到目标位置人工合并');
    } catch {
      flash('复制失败，请展开详情后手动选择文本', 'error');
    }
  }

  async function changePoolLimit(n: number) {
    if (n < 1 || n > 10) return;
    try {
      await api.put('/pool/limit', { limit: n });
      await loadPool();
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  async function pauseRunningTask(taskId: string) {
    try {
      await api.post(`/tasks/${taskId}/shelve`, { shelved: true });
      flash('已暂停：任务移出分发池（搁置），可在「任务」菜单搁置列表恢复');
      await loadPool();
    } catch (e) {
      flash(errText(e), 'error');
    }
  }

  function dismissOnboard() {
    setOnboardOpen(false);
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* 隐私模式：仅本次会话生效 */ }
  }

  async function toggleAutoComplete() {
    if (autoCompleteBusy) return;
    const next = !autoComplete;
    setAutoCompleteBusy(true);
    try {
      await api.post('/settings/queue-auto-complete', { enabled: next });
      setAutoComplete(next);
      flash(next
        ? '已开启：队列回执成功后会直接把任务标为完成（不再等待采纳）'
        : '已关闭：队列回执只标记「待采纳」，任务保持待办，采纳后才完成');
    } catch (e) {
      flash(errText(e), 'error');
    } finally {
      setAutoCompleteBusy(false);
    }
  }

  async function changeWebSearch(mode: 'off' | 'auto' | 'always') {
    if (webSearchBusy || mode === webSearchMode) return;
    setWebSearchBusy(true);
    try {
      await api.post('/settings/queue-web-search', { mode });
      setWebSearchMode(mode);
      flash(mode === 'off'
        ? '已关闭联网检索：队列回执只依据任务上下文'
        : mode === 'always'
          ? '已开启联网检索：每个队列任务发送前都会检索公开网页'
          : '联网检索已设为自动：只对最新/实时/资讯/政策/行情等时效性任务检索');
    } catch (e) {
      flash(errText(e), 'error');
    } finally {
      setWebSearchBusy(false);
    }
  }

  if (view === 'dispatch') {
    return <section><DispatchRecordsPanel onBack={() => setView('queues')} /></section>;
  }

  // ───────── 渲染 ─────────

  const sendDisabled = busy || !active || Boolean(active.paused) || active.status === 'running' || pendingCount === 0;
  const sendHint = sendHintOf(active, pendingCount, activeJobs.length);

  return (
    <section>
      {/* 标题行：一句话说清这个菜单是干什么的 + 当前队列的关键计数 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, fontSize: 'var(--fs-title)', fontWeight: 700 }}>
          <ListOrdered size={17} style={{ color: 'var(--accent)' }} /> 队列
        </h2>
        <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
          把「任务 + AI 工具」排成序列逐条交付，回执留档可采纳
        </span>
        <span style={{ flex: 1 }} />
        {active && <QueueHeadline queue={active} metrics={metrics} />}
        <QueueToolButton
          label="派发记录"
          hint="查看 B0/A 自动派发与监督中继的内部队列（只读）"
          icon={<Send size={14} />}
          onClick={() => setView('dispatch')}
          style={BTN_SECONDARY_MD}
        />
      </div>

      {/* 工具条 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <select
          value={active?.id ?? ''}
          onChange={(e) => { if (e.target.value) void open(e.target.value); }}
          aria-label="选择队列"
          title="切换当前队列"
          disabled={loadingQueues && queues.length === 0}
          style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', minWidth: 200, cursor: 'pointer' }}
        >
          <option value="">{loadingQueues && queues.length === 0 ? '加载中…' : queues.length === 0 ? '暂无队列' : '选择队列…'}</option>
          {queues.map((q) => {
            const s = summaryMap[q.id];
            const tail = s ? ` · ${s.job_success}/${s.job_total}${s.job_failed + s.job_timeout > 0 ? ` · 失败 ${s.job_failed + s.job_timeout}` : ''}${(s.job_unadopted ?? 0) > 0 ? ` · 待采纳 ${s.job_unadopted}` : ''}` : '';
            return <option key={q.id} value={q.id}>{q.name}{tail}</option>;
          })}
        </select>

        <QueueToolButton
          label="新建队列"
          hint="创建新的任务队列"
          icon={<Plus size={16} />}
          onClick={() => void createQueue()}
          style={BTN_PRIMARY}
        />

        {active && (
          <QueueToolButton
            label="重命名"
            hint="修改队列显示名称"
            icon={<Pencil size={15} />}
            onClick={() => void renameQueue()}
            style={BTN_SECONDARY_MD}
          />
        )}

        {active && (
          <QueueToolButton
            label={active.paused ? '继续队列' : '暂停队列'}
            hint={active.paused ? '恢复发送待执行任务' : '停止处理待执行任务'}
            icon={active.paused ? <Play size={15} /> : <Pause size={15} />}
            onClick={() => void togglePause()}
            style={{ ...BTN_SECONDARY_MD, color: active.paused ? 'var(--accent)' : 'var(--text)' }}
          />
        )}

        {active && (
          <QueueToolButton
            label="发送队列"
            hint="提交待执行任务"
            icon={<Send size={15} />}
            onClick={() => void sendQueue()}
            disabled={sendDisabled}
            ariaLabel={sendDisabled ? `发送队列不可用：${sendHint}` : '发送队列：提交待执行任务'}
            style={{ ...BTN_PRIMARY, background: 'var(--success)', ...(sendDisabled ? BTN_DISABLED : undefined) }}
          />
        )}

        {active && failedCount > 0 && (
          <button onClick={() => void retryFailed()} title={`重试失败 — 把 ${failedCount} 个失败/超时项重置为排队中`} aria-label="重试失败项" style={BTN_SECONDARY_MD}>
            <RotateCcw size={12} /> 重试失败（{failedCount}）
          </button>
        )}

        {active && (
          <QueueToolButton
            label="删除队列"
            hint={active.status === 'running' ? '发送中暂不可删除' : '永久删除队列及数据'}
            icon={<Trash2 size={15} />}
            onClick={() => void deleteQueue()}
            disabled={active.status === 'running'}
            ariaLabel={active.status === 'running' ? '删除队列不可用：队列正在发送中' : '删除队列：永久删除队列及数据'}
            style={{ ...BTN_DANGER_OUTLINE, ...(active.status === 'running' ? BTN_DISABLED : undefined) }}
          />
        )}

        <span style={{ flex: 1 }} />
        <NoticeToast notice={notice} onDismiss={dismiss} />
      </div>

      {/* 队列设置：两个会影响「回执如何产出/如何完成」的全局开关 */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)', fontSize: 'var(--fs-s)' }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>队列设置</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: autoCompleteBusy ? 'wait' : 'pointer' }} title="开启后，回执成功即把任务标为完成；默认关闭，采纳后才完成">
          <input type="checkbox" checked={autoComplete} disabled={autoCompleteBusy} onChange={() => void toggleAutoComplete()} />
          成功后自动完成任务
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="发送前检索公开网页并注入提示词；默认只对时效性任务检索">
          <Search size={12} style={{ color: 'var(--text-muted)' }} />
          联网检索
          <select
            value={webSearchMode}
            disabled={webSearchBusy}
            onChange={(e) => void changeWebSearch(e.target.value as 'off' | 'auto' | 'always')}
            style={{ padding: '3px 6px', fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text)' }}
          >
            <option value="auto">自动（时效性任务）</option>
            <option value="off">关闭</option>
            <option value="always">每次发送</option>
          </select>
        </label>
        <span style={{ color: 'var(--text-muted)' }}>默认只标「待采纳」，采纳后才写入处理结果</span>
      </div>

      {queuesError && (
        <output style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '6px 10px', border: '1px solid var(--danger)', borderRadius: 8, fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>
          <AlertTriangle size={13} /> 队列列表加载失败：{queuesError}
          <button onClick={() => void loadQueues()} style={{ ...BTN_SECONDARY_MD, borderColor: 'var(--danger)', color: 'var(--danger)' }}>重试</button>
        </output>
      )}

      {onboardOpen && (
        <div style={{ marginBottom: 10, padding: '8px 12px', border: '1px solid var(--accent)', borderRadius: 8, background: 'var(--accent-soft)', display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 420px', minWidth: 240 }}>
            <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 2 }}>三步上手</div>
            <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text)' }}>
              ① 新建队列（名称可自定义）→ ② 在「编排队列」勾选待办任务、选 AI 工具并加入 → ③ 点「发送队列」。发送后监控区实时显示进度、耗时与失败项；跑完点行内「采纳」把回执写入任务「处理结果」并置为已读。
            </div>
          </div>
          <button onClick={dismissOnboard} style={{ ...BTN_SECONDARY_MD, flexShrink: 0 }} title="知道了 — 关闭本提示（以后不再自动出现）" aria-label="关闭三步上手提示">
            知道了
          </button>
        </div>
      )}

      {loadingQueues && queues.length === 0 && (
        <div style={{ padding: 20, fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>队列加载中…</div>
      )}

      {!loadingQueues && queues.length === 0 && <QueueEmptyState onCreate={() => void createQueue()} />}

      {active && (
        <>
          {activeError && (
            <output style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>
              <AlertTriangle size={13} /> 队列详情刷新失败：{activeError}（保留上次数据）
              <button onClick={() => void refreshActive({ manual: true })} style={{ ...BTN_SECONDARY_MD, borderColor: 'var(--danger)', color: 'var(--danger)' }}>重试</button>
            </output>
          )}

          <QueueMonitor
            queue={active}
            jobs={activeJobs}
            now={now}
            onRefresh={() => void refreshActive({ manual: true })}
            refreshing={refreshingActive}
            refreshError=""
            updatedAt={activeUpdatedAt}
            onSend={() => void sendQueue()}
            sending={busy}
          />

          <div style={{ height: 10 }} />

          <QueueComposer
            queue={active}
            projects={projectView.projects}
            projectId={projectId}
            onProjectChange={setProjectId}
            tasks={tasks}
            tasksLoading={tasksLoading}
            tasksError={tasksError || (projectView.phase === 'error' ? projectView.error : '')}
            onRetryTasks={() => { void loadTasks(projectId); if (projectView.phase === 'error') projectView.retry(); }}
            taskKeyword={taskKeyword}
            onTaskKeywordChange={setTaskKeyword}
            pickedTaskIds={pickedTaskIds}
            onToggleTask={(id) => setPickedTaskIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
            onClearPicked={() => setPickedTaskIds([])}
            queuedTaskIds={queuedTaskIds}
            tools={tools}
            toolId={toolId}
            onToolChange={setToolId}
            onToolContextChange={(id, capacity) => void changeToolContext(id, capacity)}
            onAdd={() => void addJobs()}
            adding={adding}
          />

          <div style={{ height: 10 }} />

          <JobTable
            allJobs={activeJobs}
            filter={jobFilter}
            onFilterChange={setJobFilter}
            keyword={jobKeyword}
            onKeywordChange={setJobKeyword}
            selected={selectedJobs}
            onToggleSelect={(id) => setSelectedJobs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
            onSelectAll={(ids) => setSelectedJobs([...ids])}
            expandedJobId={expandedJobId}
            onToggleExpand={(id) => setExpandedJobId((prev) => (prev === id ? null : id))}
            onAdopt={(job) => void adopt(job)}
            onUnadopt={(job) => void unadopt(job)}
            onCopy={(job) => void copy(job)}
            onRemove={(job) => void removeJob(job)}
            onRetry={(job) => void retryJob(job)}
            onBatchRemove={() => void batchRemove()}
            busy={busy}
            now={now}
          />
        </>
      )}

      {/* 并行任务池：与队列是两套并发，放在页面底部并默认收起，避免与「队列监控」混淆 */}
      <PoolPanel
        pool={pool}
        updatedAt={poolUpdatedAt}
        refreshing={poolRefreshing}
        error={poolError}
        open={poolOpen}
        onToggle={() => setPoolOpen((v) => !v)}
        onRefresh={() => void loadPool({ manual: true })}
        onLimitChange={(n) => void changePoolLimit(n)}
        onPauseTask={(id) => void pauseRunningTask(id)}
        now={now}
      />
    </section>
  );
}
