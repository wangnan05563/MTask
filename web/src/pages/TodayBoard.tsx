import {
  AlertTriangle, ArrowRight, Bot, CalendarDays, CheckCircle2, Clock3, Inbox, ListTodo,
  Pin, Play, RefreshCw, ShieldAlert,
} from 'lucide-react';
import type { TodayAlert, TodayRunningItem, TodayTaskItem, TodayView, TodayWaitReason } from '../api/client';
import { Badge, Button, Card, EmptyState, Skeleton } from '../ui/components';
import { focusTaskByNo } from '../ui/focusTask';
import { platformLabel } from '../ui/platformLabel';
import { priorityBadgeLabel, priorityColor, priorityTone } from '../ui/priority';
import './todayBoard.css';

/**
 * T06294（REQ-001 / AC-01）：首页 Today View 三组行动卡片。
 *
 * 只消费 /stats/today 的服务端聚合结果：今天做（当前最该动的待办）、等我处理（失败/未读/待验证/待裁决）、
 * AI 正在跑（活跃会话 + 无会话兜底）；顶部告警条只列需要立即知道的操作信号。
 * 所有点击都落到既有的任务抽屉或 AI 控制台，不在首页复制任务操作。
 */

type TabTarget = 'tasks' | 'exec-sessions';

function navigate(tab: TabTarget): void {
  globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab } }));
}

function openTask(task: TodayTaskItem): void {
  void focusTaskByNo(task.task_no, 'notice');
}

function whenLabel(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  return sameDay ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const WAIT_REASON_LABEL: Record<TodayWaitReason, string> = {
  ai_failed: 'AI 失败',
  ai_unread: '结果未读',
  verify_pending: '待验证',
  ruling_pending: '待裁决',
};

const WAIT_REASON_TONE: Record<TodayWaitReason, 'danger' | 'accent' | 'warning'> = {
  ai_failed: 'danger',
  ai_unread: 'accent',
  verify_pending: 'warning',
  ruling_pending: 'warning',
};

function GroupCard({
  icon, title, hint, count, countTone = 'neutral', children, footer,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly hint: string;
  readonly count: number;
  readonly countTone?: 'neutral' | 'accent' | 'warning' | 'danger';
  readonly children: React.ReactNode;
  readonly footer?: React.ReactNode;
}) {
  return (
    <Card
      className="mt-today-group"
      padding="none"
      title={<span className="mt-today-group-title"><span className="mt-today-group-icon">{icon}</span>{title}</span>}
      extra={<Badge tone={countTone} size="sm">{count}</Badge>}
    >
      <p className="mt-today-group-hint">{hint}</p>
      <div className="mt-today-group-list">{children}</div>
      {footer && <div className="mt-today-group-foot">{footer}</div>}
    </Card>
  );
}

function TaskRow({ task }: { readonly task: TodayTaskItem }) {
  return (
    <button
      type="button"
      className="mt-today-task"
      onClick={() => openTask(task)}
      title={`${task.task_no ?? ''} ${task.title}`.trim()}
      aria-label={`打开任务 ${task.task_no ?? ''}：${task.title}`}
    >
      <span className="mt-today-task-dot" style={{ background: priorityColor(task.priority) }} aria-hidden="true" />
      <span className="mt-today-task-main">
        <span className="mt-today-task-title">{task.title}</span>
        <span className="mt-today-task-meta">
          <span className="mt-today-task-no">{task.task_no ?? '无编号'}</span>
          {task.project_name && <span className="mt-today-task-project">{task.project_name}</span>}
          {task.reason && <Badge tone={WAIT_REASON_TONE[task.reason]} size="sm">{WAIT_REASON_LABEL[task.reason]}</Badge>}
          {task.pinned === 1 && <span className="mt-today-pin" title="置顶任务"><Pin size={11} aria-hidden="true" />置顶</span>}
          <span className="mt-today-when">{whenLabel(task.updated_at)}</span>
        </span>
      </span>
      <span className="mt-today-priority" style={{ color: priorityColor(task.priority) }}>{priorityBadgeLabel(task.priority)}</span>
      <ArrowRight size={14} className="mt-today-arrow" aria-hidden="true" />
    </button>
  );
}

function RunningRow({ item }: { readonly item: TodayRunningItem }) {
  return (
    <div className="mt-today-run">
      <div className="mt-today-run-head">
        <button
          type="button"
          className="mt-today-run-title"
          onClick={() => void focusTaskByNo(item.task_no, 'notice')}
          title={item.title}
          aria-label={`打开任务 ${item.task_no ?? ''}：${item.title}`}
        >
          {item.title}
        </button>
        {item.kind === 'session'
          ? <Badge tone="accent" size="sm" dot>{platformLabel(item.platform)}</Badge>
          : <Badge tone="warning" size="sm" dot>无会话</Badge>}
      </div>
      <div className="mt-today-run-meta">
        <span>{item.task_no ?? '无编号'}</span>
        {item.project_name && <span>{item.project_name}</span>}
        <span>{item.phase}</span>
      </div>
      <div className="mt-today-progress" role="progressbar" aria-label={`${item.title} 进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress_reported ? item.progress : 0}>
        <span style={{ width: `${Math.max(2, Math.min(100, item.progress))}%` }} />
      </div>
      <div className="mt-today-run-foot">
        <span>{item.progress_reported ? `${Math.round(item.progress)}%` : '待上报'}</span>
        <span>{item.started_at ? `${whenLabel(item.started_at)} 开始` : ''}</span>
        {item.other_tasks > 0 && <span>同会话另有 {item.other_tasks} 个任务</span>}
        <Button variant="ghost" size="sm" onClick={() => navigate('exec-sessions')} rightIcon={<ArrowRight size={12} aria-hidden="true" />}>
          AI 控制台
        </Button>
      </div>
    </div>
  );
}

function AlertBar({ alerts }: { readonly alerts: TodayAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="mt-today-alerts" role="status" aria-label="今日告警">
      {alerts.map((alert) => (
        <button
          key={alert.id}
          type="button"
          className="mt-today-alert"
          data-level={alert.level}
          onClick={() => navigate(alert.id.startsWith('session-') ? 'exec-sessions' : 'tasks')}
          title={alert.detail}
        >
          {alert.level === 'danger' ? <ShieldAlert size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
          <span className="mt-today-alert-title">{alert.title}</span>
          <span className="mt-today-alert-detail">{alert.detail}</span>
        </button>
      ))}
    </div>
  );
}

function SummaryStrip({ summary }: { readonly summary: TodayView['summary'] }) {
  const items = [
    { icon: <CalendarDays size={13} />, label: '今天做', value: summary.today, tab: 'tasks' as TabTarget },
    { icon: <Inbox size={13} />, label: '等我处理', value: summary.waiting, tab: 'tasks' as TabTarget },
    { icon: <Bot size={13} />, label: 'AI 正在跑', value: summary.running, tab: 'exec-sessions' as TabTarget },
    { icon: <AlertTriangle size={13} />, label: '告警', value: summary.alerts, tab: 'tasks' as TabTarget },
  ];
  return (
    <div className="mt-today-summary" aria-label="今日看板摘要">
      {items.map((item) => (
        <button key={item.label} type="button" className="mt-today-summary-item" onClick={() => navigate(item.tab)}>
          <span className="mt-today-summary-label">{item.icon}{item.label}</span>
          <span className="mt-today-summary-value">{item.value}</span>
        </button>
      ))}
    </div>
  );
}

function LoadingBoard() {
  return (
    <>
      <div className="mt-today-summary mt-today-summary-skeleton">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={52} rounded />)}
      </div>
      <div className="mt-today-grid">
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i} className="mt-today-group" padding="none">
            <div className="mt-today-skeleton-head">
              <Skeleton width={152} height={18} />
              <Skeleton width={28} height={18} rounded />
            </div>
            {Array.from({ length: 3 }, (_, j) => (
              <div key={j} className="mt-today-skeleton-row">
                <Skeleton width="72%" height={14} />
                <Skeleton width="46%" height={11} />
              </div>
            ))}
          </Card>
        ))}
      </div>
    </>
  );
}

export function TodayBoard({
  data, loading, error, onRetry, generatedAt,
}: {
  readonly data: TodayView | null;
  readonly loading: boolean;
  readonly error: string;
  readonly onRetry: () => void;
  readonly generatedAt: string;
}) {
  if (loading) return <LoadingBoard />;
  if (error && !data) {
    return (
      <Card className="mt-today-error" padding="md">
        <EmptyState
          icon={<AlertTriangle size={22} />}
          title="今日看板加载失败"
          hint={error}
          action={{ label: '重试', onClick: onRetry }}
        />
      </Card>
    );
  }
  if (!data) return null;

  const emptyAll = data.summary.today === 0 && data.summary.waiting === 0 && data.summary.running === 0;
  return (
    <>
      <div className="mt-today-toolbar">
        <span className="mt-today-generated">
          <Clock3 size={12} aria-hidden="true" /> 数据更新于 {generatedAt || whenLabel(data.generated_at)}
        </span>
      </div>
      <SummaryStrip summary={data.summary} />
      <AlertBar alerts={data.alerts} />

      {emptyAll ? (
        <Card className="mt-today-empty-all" padding="md">
          <EmptyState
            icon={<ListTodo size={22} />}
            title="今天还没有需要你出手的事"
            hint="可以去任务页挑一件最重要的事，或者新建一个待办开始。"
            action={{ label: '去任务页', onClick: () => navigate('tasks') }}
          />
        </Card>
      ) : (
        <div className="mt-today-grid">
          <GroupCard
            icon={<CalendarDays size={15} />}
            title="今天做"
            hint={data.summary.today_candidates > data.today.length
              ? `从 ${data.summary.today_candidates} 条高优先级待办中按置顶与优先级取前 ${data.today.length} 条`
              : '置顶与紧急 / 高优先级待办，按优先级和最近更新排序'}
            count={data.summary.today}
            countTone="accent"
            footer={<Button variant="ghost" size="sm" onClick={() => navigate('tasks')} rightIcon={<ArrowRight size={12} />}>查看全部任务</Button>}
          >
            {data.today.length === 0
              ? <EmptyState icon={<CheckCircle2 size={18} />} title="没有高优先级待办" hint="从任务页挑一件今天要推进的事。" />
              : data.today.map((task) => <TaskRow key={task.id} task={task} />)}
          </GroupCard>

          <GroupCard
            icon={<Inbox size={15} />}
            title="等我处理"
            hint={`AI 失败 ${data.waiting.counts.ai_failed} · 未读 ${data.waiting.counts.ai_unread} · 待验证 ${data.waiting.counts.verify_pending} · 待裁决 ${data.waiting.counts.ruling_pending}`}
            count={data.summary.waiting}
            countTone={data.waiting.counts.ai_failed > 0 ? 'danger' : 'warning'}
            footer={<Button variant="ghost" size="sm" onClick={() => navigate('tasks')} rightIcon={<ArrowRight size={12} />}>去处理</Button>}
          >
            {data.waiting.items.length === 0
              ? <EmptyState icon={<CheckCircle2 size={18} />} title="没有等你处理的事" hint="AI 结果已读、待办已验证。" />
              : data.waiting.items.map((task) => <TaskRow key={task.id} task={task} />)}
          </GroupCard>

          <GroupCard
            icon={<Play size={15} />}
            title="AI 正在跑"
            hint="活跃执行会话优先，未被会话覆盖的运行任务也会列出"
            count={data.summary.running}
            countTone="accent"
            footer={<Button variant="ghost" size="sm" onClick={() => navigate('exec-sessions')} rightIcon={<ArrowRight size={12} />}>打开 AI 控制台</Button>}
          >
            {data.running.items.length === 0
              ? <EmptyState icon={<Bot size={18} />} title="AI 当前空闲" hint="有待办派发后会在这里显示执行进度。" />
              : data.running.items.map((item) => <RunningRow key={item.id} item={item} />)}
          </GroupCard>
        </div>
      )}
    </>
  );
}

/** 首页刷新按钮在页头复用：与 onRetry 同一入口，避免出现两套“刷新”语义 */
export const TODAY_REFRESH_ICON = <RefreshCw size={14} aria-hidden="true" />;
