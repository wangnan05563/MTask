/**
 * 队列页的展示型面板（监控 / 编排 / 任务项 / 并行池）。
 *
 * 与 QueuePage 的分工：**本文件只渲染，不请求、不改数据**——所有动作以回调传入。
 * 这样监控口径、编排交互、表格筛选可以独立演进，容器只负责「取数 + 调度 + 提示」。
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, Braces, Check, ChevronDown, ChevronUp, Clock, Copy,
  Eye, FileText, FolderKanban, Gauge, Layers, ListPlus, Loader2, Pause, Plus, RefreshCw, RotateCcw,
  Search, Trash2,
} from 'lucide-react';
import type { AITool, Project, Queue, QueueJob, Task } from '../api/client';
import { Badge, type BadgeTone } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { HoverCard } from '../ui/HoverCard';
import { Markdown } from '../ui/Markdown';
import { BTN_DISABLED, BTN_ICON, BTN_PRIMARY, BTN_SECONDARY, BTN_SECONDARY_MD, FIELD_QUIET, FIELD_SM, PILL, PRIORITY_TOKEN } from '../ui/primitives';
import { fmtElapsed } from '../ui/runStatus';
import {
  computeQueueMetrics, filterJobs, fmtClock, fmtCost, jobCostMs, jobElapsedMs, matchesJobFilter,
  type JobFilter, type QueueMetrics,
} from './queueMetrics';

/** Job 状态的单源文案与配色（表格、监控、移动端文案口径都以这里为准） */
const JOB_STATUS_META: Record<string, { label: string; tone: BadgeTone; color: string }> = {
  queued: { label: '排队中', tone: 'neutral', color: 'var(--text-muted)' },
  sending: { label: '执行中', tone: 'accent', color: 'var(--accent)' },
  success: { label: '成功', tone: 'success', color: 'var(--success)' },
  failed: { label: '失败', tone: 'danger', color: 'var(--danger)' },
  timeout: { label: '超时', tone: 'warning', color: 'var(--warn)' },
};

const QUEUE_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', running: '发送中', finished: '已完成', failed: '异常结束',
};

/** 队列状态 → 徽标语气（嵌套三元会让 Sonar 告警，且三处复用） */
function queueStatusTone(status: string): BadgeTone {
  if (status === 'failed') return 'danger';
  if (status === 'finished') return 'success';
  if (status === 'running') return 'accent';
  return 'neutral';
}

function jobStatusMeta(status: string) {
  return JOB_STATUS_META[status] ?? { label: status, tone: 'neutral' as BadgeTone, color: 'var(--text)' };
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', padding: 12,
};
const sectionTitleStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-l)', fontWeight: 600, color: 'var(--text)',
};
const hintStyle: CSSProperties = { fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };

// ───────────────────────── 监控面板 ─────────────────────────

interface KpiProps {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly color?: string;
  readonly icon?: ReactNode;
}

function Kpi({ label, value, note, color, icon }: KpiProps) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--surface)', minWidth: 104, flex: '1 1 104px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
        {icon}
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: color ?? 'var(--text)', lineHeight: 1.2 }}>{value}</div>
      {note && <div style={hintStyle}>{note}</div>}
    </div>
  );
}

export interface QueueMonitorProps {
  readonly queue: Queue;
  readonly jobs: readonly QueueJob[];
  readonly now: number;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly refreshError: string;
  readonly updatedAt: number | null;
  readonly onSend: () => void;
  readonly sending: boolean;
}

export function QueueMonitor({ queue, jobs, now, onRefresh, refreshing, refreshError, updatedAt, onSend, sending }: QueueMonitorProps) {
  const metrics = computeQueueMetrics(jobs, now);
  const sendingJobs = jobs.filter((j) => j.status === 'sending');
  const paused = Boolean(queue.paused);

  if (metrics.total === 0) {
    return (
      <div style={cardStyle}>
        <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
          <div style={sectionTitleStyle}><Gauge size={15} style={{ color: 'var(--accent)' }} /> 队列消费监控</div>
          <span style={hintStyle}>队列为空，暂无消费数据</span>
        </div>
        <EmptyState
          icon={<Activity size={18} />}
          title="这个队列还没有任务项"
          hint="在下方「编排队列」里挑选待办任务与 AI 工具加入，然后点「发送队列」，这里会实时显示进度、耗时与失败情况。"
        />
      </div>
    );
  }

  return (
    <div style={cardStyle} data-queue-monitor="1">
      <div style={{ ...rowStyle, justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={sectionTitleStyle}>
          <Gauge size={15} style={{ color: 'var(--accent)' }} /> 队列消费监控
          <Badge tone={queue.status === 'finished' && metrics.failed > 0 ? 'warning' : queueStatusTone(queue.status)}>
            {queue.status === 'finished' && metrics.failed > 0 ? '已完成 · 含失败' : (QUEUE_STATUS_LABEL[queue.status] ?? queue.status)}
          </Badge>
          {paused && <Badge tone="warning">已暂停</Badge>}
        </div>
        <div style={{ ...rowStyle, gap: 6 }}>
          <span style={hintStyle} aria-live="polite">
            {updatedAt ? `刷新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未刷新'}
          </span>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            title="刷新监控数据 — 立即重新拉取本队列的任务项状态"
            aria-label="刷新监控数据"
            style={{ ...BTN_ICON, ...(refreshing ? BTN_DISABLED : undefined), fontSize: 'var(--fs-xs)' }}
          >
            <RefreshCw size={12} className={refreshing ? 'aispin' : undefined} /> {refreshing ? '刷新中' : '刷新'}
          </button>
        </div>
      </div>

      {refreshError && (
        <output style={{ display: 'block', marginBottom: 8, fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
          监控刷新失败：{refreshError}（保留上次数据）
        </output>
      )}

      {/* 总进度：一条主进度条 + 分段计数，先回答「跑到哪儿了」 */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--fs-m)', fontWeight: 600 }}>已收口 {metrics.settled}/{metrics.total}</span>
          <span style={hintStyle}>{Math.round(metrics.progress * 100)}%</span>
          {metrics.queued > 0 && <span style={{ ...PILL, color: 'var(--text-muted)' }}>排队 {metrics.queued}</span>}
          {metrics.sending > 0 && <span style={{ ...PILL, color: 'var(--accent)', borderColor: 'var(--accent)' }}>执行中 {metrics.sending}</span>}
        </div>
        <div
          title={`收口进度 ${Math.round(metrics.progress * 100)}%（成功 ${metrics.success} / 失败 ${metrics.failed}）`}
          style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden', display: 'flex' }}
        >
          <span style={{ width: `${(metrics.success / metrics.total) * 100}%`, background: 'var(--success)' }} />
          <span style={{ width: `${(metrics.failed / metrics.total) * 100}%`, background: 'var(--danger)' }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <Kpi label="任务项" value={String(metrics.total)} note={`${metrics.byTool.length} 个工具 · ${metrics.byProject.length} 个项目`} />
        <Kpi label="成功" value={String(metrics.success)} color="var(--success)" note={metrics.successRate == null ? '尚无收口' : `成功率 ${(metrics.successRate * 100).toFixed(0)}%`} />
        <Kpi label="失败" value={String(metrics.failed)} color={metrics.failed > 0 ? 'var(--danger)' : undefined} note={metrics.timeout > 0 ? `其中超时 ${metrics.timeout}` : '含超时'} />
        <Kpi label="平均耗时" value={fmtCost(metrics.avgCostMs)} note={metrics.maxCostMs == null ? '暂无完成样本' : `最长 ${fmtCost(metrics.maxCostMs)}`} />
        <Kpi label="近 5 分钟完成" value={String(metrics.completedLast5Min)} note={metrics.oldestSendingMs == null ? '无在途任务' : `最久在途 ${fmtElapsed(metrics.oldestSendingMs)}`} />
        <Kpi label="预计剩余" value={metrics.etaMs == null ? '—' : fmtElapsed(metrics.etaMs)} note={metrics.etaMs == null ? '等有耗时样本后估算' : `按平均耗时 × ${metrics.queued + metrics.sending} 项`} />
      </div>

      {/* 在途明细：回答「现在卡在哪条」 */}
      {sendingJobs.length > 0 && (
        <div style={{ marginBottom: 10, border: '1px solid var(--accent)', borderRadius: 8, background: 'var(--accent-soft)', padding: '8px 10px' }}>
          <div style={{ ...rowStyle, marginBottom: 4 }}>
            <Loader2 size={12} className="aispin" style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 'var(--fs-s)', fontWeight: 600, color: 'var(--text)' }}>执行中（{sendingJobs.length}）</span>
            {metrics.oldestSendingMs != null && metrics.oldestSendingMs > 10 * 60 * 1000 && (
              <Badge tone="warning"><AlertTriangle size={10} style={{ verticalAlign: '-1px' }} /> 最久已 {fmtElapsed(metrics.oldestSendingMs)}</Badge>
            )}
          </div>
          {sendingJobs.map((job) => {
            const elapsed = jobElapsedMs(job, now);
            return (
              <div key={job.id} style={{ ...rowStyle, gap: 8, fontSize: 'var(--fs-s)', padding: '2px 0' }}>
                {job.task_no && <span style={{ color: 'var(--accent)', flexShrink: 0 }}>{job.task_no}</span>}
                <span style={{ flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {job.task_title ?? job.task_id.slice(0, 8)}
                </span>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{job.tool_name ?? '未知工具'}</span>
                <span style={{ color: 'var(--accent)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{elapsed == null ? '—' : fmtElapsed(elapsed)}</span>
                {job.ticket && <span title={`回执 ${job.ticket}`} style={{ ...PILL, flexShrink: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>ticket</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* 分布：工具 / 项目（跨项目队列才显示项目维度） */}
      {(metrics.byTool.length > 0 || metrics.byProject.length > 1) && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {metrics.byTool.length > 0 && (
            <div style={{ flex: '1 1 260px', minWidth: 240 }}>
              <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 4 }}>按工具</div>
              {metrics.byTool.map((t) => (
                <DistRow key={t.id} name={t.name} total={t.total} success={t.success} failed={t.failed} avg={t.avgCostMs} />
              ))}
            </div>
          )}
          {metrics.byProject.length > 1 && (
            <div style={{ flex: '1 1 260px', minWidth: 240 }}>
              <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 4 }}>按项目</div>
              {metrics.byProject.map((p) => (
                <DistRow key={p.id || 'unknown'} name={p.name} total={p.total} success={p.success} failed={p.total - p.success} avg={null} />
              ))}
            </div>
          )}
        </div>
      )}

      {(queue.status === 'draft' || paused) && (
        <div style={{ ...rowStyle, marginTop: 10, justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <span style={{ ...hintStyle, color: paused ? 'var(--warn)' : 'var(--text-muted)' }}>
            {paused ? '队列已暂停：发送会被拒绝，点工具条「继续队列」后可再次发送。' : '队列还是草稿：继续加入任务，或直接点「发送队列」开始执行。'}
          </span>
          {!paused && (
            <button onClick={onSend} disabled={sending} style={{ ...BTN_SECONDARY_MD }} title="发送队列 — 按顺序把任务项交给 AI 工具">
              <ListPlus size={12} /> 发送队列
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 分布行：名称 + 迷你进度条 + 计数；进度条按「成功/失败」两段着色 */
function DistRow({ name, total, success, failed, avg }: Readonly<{ name: string; total: number; success: number; failed: number; avg: number | null }>) {
  const okRate = total === 0 ? 0 : (success / total) * 100;
  const failRate = total === 0 ? 0 : (failed / total) * 100;
  return (
    <div style={{ ...rowStyle, gap: 6, fontSize: 'var(--fs-xs)', padding: '2px 0' }} title={`${name}：共 ${total} 项，成功 ${success}，失败 ${failed}${avg == null ? '' : `，平均耗时 ${fmtCost(avg)}`}`}>
      <span style={{ flex: '0 1 110px', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <span style={{ flex: '1 1 80px', height: 5, borderRadius: 3, background: 'var(--surface-2)', display: 'flex', overflow: 'hidden' }}>
        <span style={{ width: `${okRate}%`, background: 'var(--success)' }} />
        <span style={{ width: `${failRate}%`, background: 'var(--danger)' }} />
      </span>
      <span style={{ flexShrink: 0, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {success}/{total}{failed > 0 ? ` · 失败 ${failed}` : ''}{avg == null ? '' : ` · ${fmtCost(avg)}`}
      </span>
    </div>
  );
}

// ───────────────────────── 编排面板 ─────────────────────────

export interface QueueComposerProps {
  readonly queue: Queue;
  readonly projects: readonly Project[];
  readonly projectId: string;
  readonly onProjectChange: (id: string) => void;
  readonly tasks: readonly Task[];
  readonly tasksLoading: boolean;
  readonly tasksError: string;
  readonly onRetryTasks: () => void;
  readonly taskKeyword: string;
  readonly onTaskKeywordChange: (v: string) => void;
  readonly pickedTaskIds: readonly string[];
  readonly onToggleTask: (id: string) => void;
  readonly onClearPicked: () => void;
  readonly queuedTaskIds: ReadonlySet<string>;
  readonly tools: readonly AITool[];
  readonly toolId: string;
  readonly onToolChange: (v: string) => void;
  readonly onAdd: () => void;
  readonly adding: boolean;
}

export function QueueComposer(props: QueueComposerProps) {
  const {
    queue, projects, projectId, onProjectChange, tasks, tasksLoading, tasksError, onRetryTasks,
    taskKeyword, onTaskKeywordChange, pickedTaskIds, onToggleTask, onClearPicked, queuedTaskIds,
    tools, toolId, onToolChange, onAdd, adding,
  } = props;
  const editable = queue.status !== 'running';

  const visibleTasks = tasks.filter((t) => {
    const kw = taskKeyword.trim().toLowerCase();
    if (!kw) return true;
    return `${t.task_no ?? ''} ${t.title}`.toLowerCase().includes(kw);
  });

  const canAdd = editable && pickedTaskIds.length > 0 && Boolean(toolId) && !adding;

  return (
    <div style={cardStyle} data-queue-composer="1">
      <div style={{ ...rowStyle, justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={sectionTitleStyle}><ListPlus size={15} style={{ color: 'var(--accent)' }} /> 编排队列</div>
        <div style={{ ...rowStyle, gap: 6 }} title="三步：选任务 → 选工具 → 加入队列，最后点工具条上的「发送队列」">
          <StepChip index={1} text="选任务" done={pickedTaskIds.length > 0} count={pickedTaskIds.length || undefined} />
          <StepChip index={2} text="选工具" done={Boolean(toolId)} />
          <StepChip index={3} text="加入队列" done={false} />
        </div>
      </div>

      {!editable && (
        <div style={{ ...hintStyle, color: 'var(--warn)', marginBottom: 8 }}>
          队列正在发送中，暂不可追加任务；等本批收口（或点任务池里的「暂停」把任务移出分发池）后再编辑。
        </div>
      )}

      <div style={{ ...rowStyle, marginBottom: 8, gap: 6, flexWrap: 'wrap' }}>
        <select
          value={projectId}
          onChange={(e) => onProjectChange(e.target.value)}
          aria-label="按项目筛选待办任务"
          title="按项目筛选：只列出该项目下的待办任务（切换项目不会清空已选，可跨项目编排同一队列）"
          style={{ ...FIELD_SM, minWidth: 138, flex: '0 1 150px', cursor: 'pointer' }}
        >
          <option value="">全部项目</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div style={{ ...rowStyle, flex: '1 1 190px', gap: 4, minWidth: 170, maxWidth: 300 }}>
          <Search size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            value={taskKeyword}
            onChange={(e) => onTaskKeywordChange(e.target.value)}
            placeholder="搜索任务编号 / 标题"
            aria-label="搜索待办任务"
            style={{ ...FIELD_QUIET, flex: '1 1 auto', minWidth: 0 }}
          />
        </div>
        <select
          value={toolId}
          onChange={(e) => onToolChange(e.target.value)}
          aria-label="选择要交付的 AI 工具"
          title="选择 AI 工具 — 队列会把每个任务连同上下文提交给该工具"
          style={{ ...FIELD_SM, flex: '1 1 220px', minWidth: 180, maxWidth: 260, cursor: 'pointer' }}
        >
          <option value="">选择 AI 工具…</option>
          {tools.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{t.type}）{t.model ? ` · ${t.model}` : ' · 未配模型'}
            </option>
          ))}
        </select>
        <HoverCard
          card={`加入队列 | ${canAdd ? `提交已选 ${pickedTaskIds.length} 条任务到当前队列` : '先勾选任务并选择 AI 工具'}`}
          ariaLabel="加入队列"
          cardW={280}
          cardH={44}
          openDelay={160}
          style={{ flexShrink: 0 }}
        >
          <button
            onClick={onAdd}
            disabled={!canAdd}
            title={canAdd ? `把已选的 ${pickedTaskIds.length} 条任务加入当前队列` : '请先勾选任务并选择 AI 工具'}
            aria-label={canAdd ? `加入队列，已选 ${pickedTaskIds.length} 条` : '加入队列不可用：请先勾选任务并选择 AI 工具'}
            style={{
              ...BTN_PRIMARY, ...(canAdd ? undefined : BTN_DISABLED), width: 34, height: 30,
              padding: 0, justifyContent: 'center', flexShrink: 0,
            }}
          >
            {adding ? <Loader2 size={14} className="aispin" /> : <Plus size={15} />}
          </button>
        </HoverCard>
        <span style={{ ...hintStyle, flexShrink: 0 }}>
          {tasksLoading ? '加载中…' : `待办 ${visibleTasks.length} 条`}
          {projectId && !tasksLoading ? ` · ${projects.find((p) => p.id === projectId)?.name ?? ''}` : ''}
        </span>
        {pickedTaskIds.length > 0 && (
          <button onClick={onClearPicked} style={{ ...BTN_SECONDARY, fontSize: 'var(--fs-xs)', flexShrink: 0 }} title="清空已选任务">
            清空已选（{pickedTaskIds.length}）
          </button>
        )}
      </div>

      {tasksError && (
        <output style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--danger)', marginBottom: 6 }}>
          待办任务加载失败：{tasksError}
          <button onClick={onRetryTasks} style={{ ...BTN_SECONDARY, borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 'var(--fs-xs)' }}>重试</button>
        </output>
      )}

      <div style={{ maxHeight: 208, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
        {visibleTasks.length === 0 && !tasksLoading && (
          <div style={{ padding: 14, fontSize: 'var(--fs-s)', color: 'var(--text-muted)', textAlign: 'center' }}>
            {taskKeyword.trim() ? '没有匹配的待办任务，换个关键词试试' : '该范围没有待办任务——可先在「任务」菜单新建待办'}
          </div>
        )}
        {visibleTasks.map((t) => {
          const picked = pickedTaskIds.includes(t.id);
          const inQueue = queuedTaskIds.has(t.id);
          const disabled = inQueue || !editable;
          const priorityColor = PRIORITY_TOKEN[(t.priority as keyof typeof PRIORITY_TOKEN)] ?? 'var(--text-muted)';
          return (
            <label
              key={t.id}
              title={inQueue ? '该任务已在当前队列中，避免同一任务被重复执行' : (t.description || t.title)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', cursor: disabled ? 'not-allowed' : 'pointer',
                borderBottom: '1px solid var(--border)', opacity: disabled && !picked ? 0.55 : 1, background: picked ? 'var(--accent-soft)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={picked}
                disabled={disabled}
                onChange={() => onToggleTask(t.id)}
                aria-label={`选择任务 ${t.task_no ?? t.title}`}
                style={{ flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
              />
              {(t.priority === 'urgent' || t.priority === 'high') && (
                <span title={`优先级 ${t.priority}`} style={{ width: 6, height: 6, borderRadius: '50%', background: priorityColor, flexShrink: 0 }} />
              )}
              {t.task_no && (
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{t.task_no}</span>
              )}
              <span style={{ fontSize: 'var(--fs-s)', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.title}
              </span>
              {inQueue && <Badge tone="accent" style={{ flexShrink: 0 }}>已在队列</Badge>}
            </label>
          );
        })}
      </div>
      {tools.length === 0 && (
        <div style={{ ...hintStyle, marginTop: 6 }}>还没有 AI 工具：先到「模型」菜单添加并配置模型，否则发送会因未配模型而失败。</div>
      )}
    </div>
  );
}

function StepChip({ index, text, done, count }: Readonly<{ index: number; text: string; done: boolean; count?: number }>) {
  const color = done ? 'var(--accent)' : 'var(--text-muted)';
  return (
    <span style={{ ...PILL, display: 'inline-flex', alignItems: 'center', gap: 4, color, borderColor: done ? 'var(--accent)' : 'var(--border)' }}>
      <span style={{
        width: 14, height: 14, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 'var(--fs-2xs)', background: done ? 'var(--accent)' : 'var(--surface-2)', color: done ? 'var(--accent-text)' : 'var(--text-muted)',
      }}>
        {done ? <Check size={9} /> : index}
      </span>
      {text}{count ? ` ${count}` : ''}
    </span>
  );
}

// ───────────────────────── 任务项表格 ─────────────────────────

export interface JobTableProps {
  readonly allJobs: readonly QueueJob[];
  readonly filter: JobFilter;
  readonly onFilterChange: (f: JobFilter) => void;
  readonly keyword: string;
  readonly onKeywordChange: (v: string) => void;
  readonly selected: readonly string[];
  readonly onToggleSelect: (id: string) => void;
  readonly onSelectAll: (ids: readonly string[]) => void;
  readonly expandedJobId: string | null;
  readonly onToggleExpand: (id: string) => void;
  readonly onAdopt: (job: QueueJob) => void;
  readonly onCopy: (job: QueueJob) => void;
  readonly onRemove: (job: QueueJob) => void;
  readonly onRetry: (job: QueueJob) => void;
  readonly onBatchRemove: () => void;
  readonly busy: boolean;
  readonly now: number;
}

const FILTERS: Array<{ key: JobFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'queued', label: '排队' },
  { key: 'running', label: '执行中' },
  { key: 'success', label: '成功' },
  { key: 'failed', label: '失败' },
];

export function JobTable(props: JobTableProps) {
  const {
    allJobs, filter, onFilterChange, keyword, onKeywordChange, selected, onToggleSelect, onSelectAll,
    expandedJobId, onToggleExpand, onAdopt, onCopy, onRemove, onRetry, onBatchRemove, busy, now,
  } = props;

  const visible = filterJobs(allJobs, filter, keyword);
  // 执行中的任务项不可勾选，全选也只在「可选子集」上判定，否则有在途项时表头复选框永远为未选
  const selectable = visible.filter((j) => j.status !== 'sending');
  const allChecked = selectable.length > 0 && selectable.every((j) => selected.includes(j.id));

  if (allJobs.length === 0) {
    return (
      <div style={cardStyle}>
        <div style={{ ...sectionTitleStyle, marginBottom: 6 }}><Layers size={15} style={{ color: 'var(--accent)' }} /> 任务项</div>
        <EmptyState
          icon={<ListPlus size={18} />}
          title="队列里还没有任务"
          hint="回到上方「编排队列」：选好待办任务与 AI 工具后点「加入队列」，这里会按执行顺序列出每一行及其回执。"
        />
      </div>
    );
  }

  return (
    <div style={cardStyle} data-queue-jobs="1">
      <div style={{ ...rowStyle, justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ ...rowStyle, gap: 4 }}>
          <Layers size={15} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 'var(--fs-l)', fontWeight: 600 }}>任务项</span>
          <span style={hintStyle}>{visible.length}/{allJobs.length}</span>
        </div>
        <div style={{ ...rowStyle, gap: 6 }}>
          <div role="tablist" aria-label="按状态筛选任务项" style={{ ...rowStyle, gap: 2 }}>
            {FILTERS.map((f) => {
              const count = allJobs.filter((j) => matchesJobFilter(j, f.key)).length;
              const activeTab = filter === f.key;
              return (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={activeTab}
                  onClick={() => onFilterChange(f.key)}
                  title={`只看${f.label}的任务项（${count}）`}
                  style={{
                    ...BTN_SECONDARY, padding: '2px 8px', borderRadius: 6, fontSize: 'var(--fs-xs)',
                    borderColor: activeTab ? 'var(--accent)' : 'var(--border)', color: activeTab ? 'var(--accent)' : 'var(--text-secondary)',
                    background: activeTab ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  {f.label}{count > 0 ? ` ${count}` : ''}
                </button>
              );
            })}
          </div>
          <div style={{ ...rowStyle, gap: 4, minWidth: 130 }}>
            <Search size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <input
              value={keyword}
              onChange={(e) => onKeywordChange(e.target.value)}
              placeholder="筛选任务项…"
              aria-label="按关键词筛选任务项"
              style={{ ...FIELD_QUIET, flex: '1 1 auto', minWidth: 0, width: 130 }}
            />
          </div>
          {selected.length > 0 && (
            <button
              onClick={onBatchRemove}
              disabled={busy}
              title={`把已选的 ${selected.length} 个任务项移出队列（执行中的不可移除）`}
              style={{ ...BTN_SECONDARY, borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 'var(--fs-xs)' }}
            >
              <Trash2 size={12} /> 移除选中（{selected.length}）
            </button>
          )}
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-m)' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 'var(--fs-s)' }}>
              <th style={{ padding: '6px 4px', width: 28 }}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => onSelectAll(allChecked ? [] : selectable.map((j) => j.id))}
                  aria-label="全选当前筛选的任务项"
                  title="全选当前筛选结果（执行中的不会被打勾）"
                  style={{ cursor: 'pointer' }}
                />
              </th>
              <th style={{ padding: '6px 4px', width: 36 }}>#</th>
              <th style={{ padding: '6px 4px' }}>任务</th>
              <th style={{ padding: '6px 4px', width: 120 }}>工具</th>
              <th style={{ padding: '6px 4px', width: 90 }}>状态</th>
              <th style={{ padding: '6px 4px', width: 76 }}>耗时</th>
              <th style={{ padding: '6px 4px', width: 130 }}>回执摘要</th>
              <th style={{ padding: '6px 4px', width: 150 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>
                  当前筛选没有任务项{keyword ? `（关键词「${keyword}」）` : ''}
                </td>
              </tr>
            )}
            {visible.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                now={now}
                checked={selected.includes(job.id)}
                expanded={expandedJobId === job.id}
                onToggleSelect={onToggleSelect}
                onToggleExpand={onToggleExpand}
                onAdopt={onAdopt}
                onCopy={onCopy}
                onRemove={onRemove}
                onRetry={onRetry}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface JobRowProps {
  readonly job: QueueJob;
  readonly now: number;
  readonly checked: boolean;
  readonly expanded: boolean;
  readonly onToggleSelect: (id: string) => void;
  readonly onToggleExpand: (id: string) => void;
  readonly onAdopt: (job: QueueJob) => void;
  readonly onCopy: (job: QueueJob) => void;
  readonly onRemove: (job: QueueJob) => void;
  readonly onRetry: (job: QueueJob) => void;
}

function JobRow(props: JobRowProps) {
  const { job, now, checked, expanded, onToggleSelect, onToggleExpand, onAdopt, onCopy, onRemove, onRetry } = props;
  const meta = jobStatusMeta(job.status);
  const canAdopt = job.status === 'success' && Boolean(job.response_payload);
  const canRemove = job.status !== 'sending';
  const canRetry = job.status === 'failed' || job.status === 'timeout';
  const elapsed = job.status === 'sending' ? jobElapsedMs(job, now) : null;
  const cost = jobCostMs(job);

  return (
    <>
      <tr
        onClick={() => onToggleExpand(job.id)}
        style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', background: expanded ? 'var(--surface)' : undefined }}
      >
        <td style={{ padding: '5px 4px' }} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={checked}
            disabled={!canRemove}
            onChange={() => onToggleSelect(job.id)}
            aria-label={`选择任务项 ${job.task_no ?? job.task_title ?? job.id.slice(0, 8)}`}
            title={canRemove ? '选择该任务项' : '执行中的任务项不可选择'}
            style={{ cursor: canRemove ? 'pointer' : 'not-allowed' }}
          />
        </td>
        <td style={{ padding: '5px 4px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{job.order_index + 1}</td>
        <td style={{ padding: '5px 4px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {job.task_no && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', flexShrink: 0 }}>{job.task_no}</span>}
            <span title={job.task_title ?? job.task_id} style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {job.task_title ?? `（任务已删除 ${job.task_id.slice(0, 8)}）`}
            </span>
          </div>
          {job.task_project_name && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <FolderKanban size={10} style={{ verticalAlign: '-1px' }} /> {job.task_project_name}
            </div>
          )}
        </td>
        <td style={{ padding: '5px 4px', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }} title={job.tool_name ?? job.tool_id}>
          {job.tool_name ?? '未知工具'}
        </td>
        <td style={{ padding: '5px 4px' }}>
          <Badge tone={meta.tone}>
            {job.status === 'sending' && <Loader2 size={9} className="aispin" style={{ verticalAlign: '-1px', marginRight: 3 }} />}
            {meta.label}
          </Badge>
          {job.error && (
            <div title={job.error} style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {job.error}
            </div>
          )}
        </td>
        <td style={{ padding: '5px 4px', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {job.status === 'sending' ? (elapsed == null ? '—' : `${fmtElapsed(elapsed)}…`) : fmtCost(cost)}
        </td>
        <td style={{ padding: '5px 4px', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
          {job.response_payload ? (
            <span title={job.response_payload}>{job.response_payload.replaceAll('\n', ' ').slice(0, 40)}…</span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>{job.status === 'queued' ? '待发送' : '—'}</span>
          )}
        </td>
        <td style={{ padding: '5px 4px' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button onClick={() => onToggleExpand(job.id)} style={{ ...BTN_ICON, padding: '2px 4px' }}
              title={expanded ? '收起详情' : '审阅 — 展开发送快照与 AI 回执'} aria-label={expanded ? '收起详情' : '审阅回执'}>
              {expanded ? <ChevronUp size={13} /> : <Eye size={13} />}
            </button>
            {canAdopt && (
              <button onClick={() => onAdopt(job)} style={{ ...BTN_ICON, padding: '2px 4px', color: 'var(--success)', borderColor: 'var(--success)' }}
                title="采纳 — 把回执写入任务摘要并把任务置为完成（仅保存文本，人工合并）" aria-label="采纳回执">
                <Check size={13} />
              </button>
            )}
            {canAdopt && (
              <button onClick={() => onCopy(job)} style={{ ...BTN_ICON, padding: '2px 4px' }} title="复制回执到剪贴板" aria-label="复制回执">
                <Copy size={13} />
              </button>
            )}
            {canRetry && (
              <button onClick={() => onRetry(job)} style={{ ...BTN_ICON, padding: '2px 4px', color: 'var(--warn)', borderColor: 'var(--warn)' }}
                title="重试 — 把这一条重置为排队中，下次发送会重新执行" aria-label="重试该任务项">
                <RotateCcw size={13} />
              </button>
            )}
            {canRemove && (
              <button onClick={() => onRemove(job)} style={{ ...BTN_ICON, padding: '2px 4px', color: 'var(--danger)', borderColor: 'var(--danger)' }}
                title="移除 — 从队列中删除该任务项" aria-label="移除该任务项">
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} style={{ padding: '8px 12px', background: 'var(--surface)' }}>
            <div style={{ ...rowStyle, gap: 14, marginBottom: 8 }}>
              <Meta label="发送时刻" value={fmtClock(job.sent_at)} />
              <Meta label="受理时刻" value={fmtClock(job.submitted_at)} />
              <Meta label="收口时刻" value={fmtClock(job.finished_at)} />
              {job.ticket && <Meta label="回执 ticket" value={job.ticket} mono />}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Snapshot title="发送内容快照（request_payload）" text={job.request_payload} mode="json" />
              <Snapshot title="AI 返回文本（response_payload，待人工合并）" text={job.response_payload} tall mode="markdown" />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Meta({ label, value, mono }: Readonly<{ label: string; value: string; mono?: boolean }>) {
  return (
    <span style={{ ...rowStyle, gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
      {label}
      <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined }}>{value}</span>
    </span>
  );
}

function Snapshot({
  title, text, tall, mode,
}: Readonly<{ title: string; text: string | null; tall?: boolean; mode: 'json' | 'markdown' }>) {
  const [view, setView] = useState<'raw' | 'format'>('format');
  const raw = text ?? '';
  const parsedJson = useMemo(() => {
    if (mode !== 'json' || !raw) return { ok: false, value: raw };
    try {
      return { ok: true, value: JSON.stringify(JSON.parse(raw), null, 2) };
    } catch {
      return { ok: false, value: raw };
    }
  }, [mode, raw]);
  const prettyJson = parsedJson.value;
  const jsonInvalid = mode === 'json' && raw.length > 0 && !parsedJson.ok;
  const bodyStyle: CSSProperties = {
    margin: 0, padding: 8, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 'var(--fs-s)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: tall ? 380 : 200, overflow: 'auto',
  };

  return (
    <div style={{ flex: '1 1 46%', minWidth: 260 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', flex: '1 1 auto' }}>{title}</div>
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden', flexShrink: 0 }}>
          <SnapshotViewButton active={view === 'raw'} onClick={() => setView('raw')} label="原文" icon={<FileText size={10} />} />
          <SnapshotViewButton
            active={view === 'format'}
            onClick={() => setView('format')}
            label="格式化"
            icon={mode === 'json' ? <Braces size={10} /> : <Eye size={10} />}
          />
        </div>
      </div>
      {view === 'format' && mode === 'markdown' ? (
        raw ? <Markdown content={raw} style={{ ...bodyStyle, lineHeight: 1.6 }} /> : <div style={{ ...bodyStyle, color: 'var(--text-muted)' }}>—</div>
      ) : (
        <pre style={bodyStyle}>
          {view === 'format' && mode === 'json' && raw
            ? (jsonInvalid ? <><span style={{ color: 'var(--warn)' }}>JSON 解析失败，已显示原文。 </span>{raw}</> : <JsonHighlight json={prettyJson} />)
            : (raw || '—')}
        </pre>
      )}
    </div>
  );
}

function SnapshotViewButton({
  active, onClick, label, icon,
}: Readonly<{ active: boolean; onClick: () => void; label: string; icon: ReactNode }>) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={`${label}视图 — ${label === '原文' ? '显示未经处理的内容' : '按语法格式化展示'}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 6px', border: 'none',
        cursor: 'pointer', fontSize: 'var(--fs-xs)', background: active ? 'var(--accent)' : 'var(--card-bg)',
        color: active ? 'var(--accent-text)' : 'var(--text)',
      }}
    >
      {icon}{label}
    </button>
  );
}

/** 轻量 JSON 语法着色：只处理键/字符串/布尔/null/数字，不引入额外依赖，也不使用 innerHTML。 */
function JsonHighlight({ json }: Readonly<{ json: string }>) {
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    if (m.index > last) parts.push(json.slice(last, m.index));
    const color = m[1] ? 'var(--accent)' : m[2] ? 'var(--success)' : m[3] ? 'var(--warn)' : 'var(--text)';
    parts.push(<span key={`${m.index}-${m[0]}`} style={{ color, fontWeight: m[1] ? 600 : undefined }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < json.length) parts.push(json.slice(last));
  return <>{parts}</>;
}

// ───────────────────────── 并行任务池（MCP 拉取） ─────────────────────────

export interface PoolRunSlotView {
  readonly id: string;
  readonly task_no: string | null;
  readonly title: string;
  readonly ai_state_at: string;
  readonly project_name: string;
}

export interface PoolStatusView {
  readonly limit: number;
  readonly queued: number;
  readonly running: readonly PoolRunSlotView[];
}

export interface PoolPanelProps {
  readonly pool: PoolStatusView | null;
  readonly updatedAt: number | null;
  readonly refreshing: boolean;
  readonly error: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onRefresh: () => void;
  readonly onLimitChange: (n: number) => void;
  readonly onPauseTask: (taskId: string) => void;
  readonly now: number;
}

export function PoolPanel(props: PoolPanelProps) {
  const { pool, updatedAt, refreshing, error, open, onToggle, onRefresh, onLimitChange, onPauseTask, now } = props;
  return (
    <div style={{ ...cardStyle, marginTop: 12 }} data-pool-panel="1">
      <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
        <button
          onClick={onToggle}
          aria-expanded={open}
          title="展开/收起并行任务池明细（与「队列」无关：这里观测的是外部 Agent 通过 MCP 自行领取任务的并发情况）"
          style={{ ...sectionTitleStyle, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          并行任务池（MCP 拉取）
          <span style={{ ...PILL, marginLeft: 4 }}>
            {pool ? `${pool.running.length}/${pool.limit} 运行 · ${pool.queued} 排队` : '未获取'}
          </span>
        </button>
        <div style={{ ...rowStyle, gap: 6 }}>
          <span style={hintStyle}>{updatedAt ? `刷新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</span>
          <button onClick={onRefresh} disabled={refreshing} style={{ ...BTN_ICON, fontSize: 'var(--fs-xs)' }} title="刷新并行任务池" aria-label="刷新并行任务池">
            <RefreshCw size={12} className={refreshing ? 'aispin' : undefined} />
          </button>
        </div>
      </div>
      {!open && <div style={{ ...hintStyle, marginTop: 4 }}>队列是 MTask 主动推送；任务池是外部 Agent 自己来领。两套并发互不影响。</div>}
      {open && (
        <>
          {error && <output style={{ display: 'block', marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>任务池刷新失败：{error}（保留上次数据）</output>}
          <div style={{ ...rowStyle, marginTop: 8, gap: 10 }}>
            <span style={{ ...rowStyle, gap: 4 }} title={pool ? `并行槽位：${pool.running.length}/${pool.limit}` : '尚未获取'}>
              {pool && Array.from({ length: pool.limit }, (_, i) => (
                <span key={i} style={{ width: 12, height: 12, borderRadius: '50%', border: '1px solid var(--accent)', background: i < pool.running.length ? 'var(--accent)' : 'transparent' }} />
              ))}
              <span style={{ fontSize: 'var(--fs-s)' }}>{pool ? `${pool.running.length}/${pool.limit} 运行中` : '—'}</span>
            </span>
            <span style={hintStyle}>排队就绪 {pool ? `${pool.queued} 条` : '—'}</span>
            <span style={{ flex: 1 }} />
            <span style={{ ...rowStyle, gap: 4, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
              并行上限
              <button onClick={() => onLimitChange((pool?.limit ?? 3) - 1)} disabled={!pool || pool.limit <= 1}
                title="下调并行上限" aria-label="下调并行上限"
                style={{ ...BTN_ICON, width: 22, height: 22, justifyContent: 'center', padding: 0 }}>−</button>
              <b style={{ color: 'var(--accent)' }}>{pool?.limit ?? '—'}</b>
              <button onClick={() => onLimitChange((pool?.limit ?? 3) + 1)} disabled={!pool || pool.limit >= 10}
                title="上调并行上限" aria-label="上调并行上限"
                style={{ ...BTN_ICON, width: 22, height: 22, justifyContent: 'center', padding: 0 }}>+</button>
            </span>
          </div>
          {(pool?.running.length ?? 0) > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(pool?.running ?? []).map((r) => (
                <div key={r.id} style={{ ...rowStyle, gap: 8, fontSize: 'var(--fs-s)' }}>
                  <Loader2 size={12} className="aispin" style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <span style={{ color: 'var(--accent)', flexShrink: 0 }}>{r.task_no ?? '—'}</span>
                  <span title={`${r.title}（${r.project_name}）`} style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </span>
                  <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.project_name} · {Math.max(1, Math.round((now - new Date(r.ai_state_at).getTime()) / 60000))} 分钟</span>
                  <button onClick={() => onPauseTask(r.id)} style={{ ...BTN_SECONDARY, fontSize: 'var(--fs-xs)', padding: '2px 8px', whiteSpace: 'nowrap' }}
                    title="暂停 — 把该任务移出分发池（转搁置）；Agent 侧已开始的动作无法强制中断" aria-label={`暂停任务 ${r.task_no ?? ''}`}>
                    <Pause size={11} /> 暂停
                  </button>
                </div>
              ))}
            </div>
          )}
          {pool && pool.running.length === 0 && <div style={{ ...hintStyle, marginTop: 6 }}>当前没有外部 Agent 领取任务。队列发送不占用这里的并发槽位。</div>}
          <div style={{ ...hintStyle, marginTop: 6 }}>
            暂停 = 移出分发池（转搁置，恢复请在「任务」菜单搁置列表操作）；MCP 领取是软引导，不阻断外部 Agent。
          </div>
        </>
      )}
    </div>
  );
}

/** 供容器复用的空态：无队列时的首屏引导 */
export function QueueEmptyState({ onCreate }: Readonly<{ onCreate: () => void }>) {
  return (
    <div style={cardStyle}>
      <EmptyState
        icon={<ListPlus size={18} />}
        title="还没有开发队列"
        hint="队列把「任务 + AI 工具」排成执行序列，由 MTask 逐条提交并留存回执。三步开始：① 新建队列（可自定义名称）② 选待办任务与工具加入 ③ 点「发送队列」。"
        action={{ label: '新建队列', onClick: onCreate }}
      />
    </div>
  );
}

/** 供容器复用的运行状态汇总（顶部工具条右侧），一眼看出「这队列还有多少没跑」 */
export function QueueHeadline({ queue, metrics }: Readonly<{ queue: Queue; metrics: QueueMetrics }>) {
  return (
    <div style={{ ...rowStyle, gap: 8, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
      <Clock size={12} style={{ color: 'var(--text-muted)' }} />
      <span>{QUEUE_STATUS_LABEL[queue.status] ?? queue.status}</span>
      <span style={hintStyle}>·</span>
      <span>成功 {metrics.success}</span>
      <span style={{ color: metrics.failed > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>失败 {metrics.failed}</span>
      <span style={{ color: metrics.sending > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>在途 {metrics.sending}</span>
      <span style={{ color: 'var(--text-muted)' }}>排队 {metrics.queued}</span>
      {metrics.successRate != null && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }} title="成功率 = 成功 / 已收口">
          <Gauge size={11} style={{ color: 'var(--text-muted)' }} />{(metrics.successRate * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}
