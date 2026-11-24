/**
 * T06302（REQ-009 / PRD B1）：任务日历视图。
 *
 * 口径：
 * - 只做「日程展示」：按任务到期日（`Task.due_date`，YYYY-MM-DD）排布，支持月/周切换；
 * - 拖拽卡片改期（日历格 ↔ 日历格、未排期 ↔ 日历格），也可用 Alt+←/→ 键盘改期；
 * - 未排期任务单独分组，不与任何日期格混排；
 * - 不包含甘特图，甘特仍归项目计划（本任务边界）。
 *
 * 组件不直接发请求：改期由页面注入 `onReschedule`，便于复用既有 PATCH 与错误提示。
 */
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, CircleCheck, GripVertical } from 'lucide-react';
import type { Task } from '../api/client';
import { priorityBadgeLabel, priorityColor } from '../ui/priority';
import { useSessionState } from '../ui/session';
import { addDays, fmtDate, parseYmd } from '../utils/workday';
import './taskCalendar.css';

export type CalendarViewMode = 'month' | 'week';

interface TaskCalendarProps {
  tasks: Task[];
  loading?: boolean;
  /** 全部项目视图下在卡片上补项目名；单项目视图不传，避免重复信息 */
  projectNameById?: Map<string, string>;
  showProject?: boolean;
  onOpenTask: (task: Task) => void;
  /** 改期：date=YYYY-MM-DD；null=移入未排期 */
  onReschedule: (taskId: string, date: string | null) => Promise<void>;
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MAX_CARDS_PER_WEEK = 8;
const MAX_CARDS_PER_MONTH = 3;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function startOfWeek(d: Date): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (copy.getDay() + 6) % 7; // 周一为一周起点
  copy.setDate(copy.getDate() - offset);
  return copy;
}

function monthCells(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function weekCells(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function taskDue(task: Task): string | null {
  const raw = task.due_date ?? '';
  return YMD_RE.test(raw) ? raw : null;
}

const PRIORITY_WEIGHT: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function taskOrder(a: Task, b: Task): number {
  const pa = PRIORITY_WEIGHT[a.priority] ?? 9;
  const pb = PRIORITY_WEIGHT[b.priority] ?? 9;
  if (pa !== pb) return pa - pb;
  return (a.task_no || '').localeCompare(b.task_no || '');
}

export function TaskCalendar({ tasks, loading = false, projectNameById, showProject = false, onOpenTask, onReschedule }: TaskCalendarProps) {
  const [modeRaw, setMode] = useSessionState<CalendarViewMode>('tasks.calendarMode', 'month');
  const mode: CalendarViewMode = modeRaw === 'week' ? 'week' : 'month';
  const [anchorYmd, setAnchorYmd] = useSessionState<string>('tasks.calendarAnchor', fmtDate(new Date()));
  const [dragTaskId, setDragTaskId] = useState('');
  const [overDate, setOverDate] = useState('');
  const dragTaskRef = useRef<string>('');

  const anchor = useMemo(() => {
    const parsed = YMD_RE.test(anchorYmd) ? parseYmd(anchorYmd) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }, [anchorYmd]);
  const today = fmtDate(new Date());
  const cells = useMemo(() => (mode === 'month' ? monthCells(anchor) : weekCells(anchor)), [mode, anchor]);

  const byDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const due = taskDue(t);
      if (!due) continue;
      const list = map.get(due);
      if (list) list.push(t);
      else map.set(due, [t]);
    }
    for (const list of map.values()) list.sort(taskOrder);
    return map;
  }, [tasks]);

  const unscheduled = useMemo(() => tasks.filter((t) => !taskDue(t)).sort(taskOrder), [tasks]);

  const rangeLabel = useMemo(() => {
    if (mode === 'month') return `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;
    const start = startOfWeek(anchor);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return `${fmtDate(start)} ～ ${fmtDate(end)}`;
  }, [mode, anchor]);

  const visibleTaskCount = useMemo(() => tasks.filter((t) => taskDue(t)).length, [tasks]);

  // 键盘改期后焦点恢复到同一张卡片（卡片跨日期格移动会换 DOM 节点）
  const restoreFocus = (taskId: string): void => {
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-t06302="task-card"][data-task-id="${taskId}"]`);
      el?.focus();
    }, 0);
  };

  const shiftAnchor = (direction: number): void => {
    if (mode === 'month') {
      const next = new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
      setAnchorYmd(fmtDate(next));
      return;
    }
    setAnchorYmd(addDays(fmtDate(anchor), direction * 7));
  };

  const startDrag = (event: DragEvent<HTMLButtonElement>, task: Task): void => {
    dragTaskRef.current = task.id;
    setDragTaskId(task.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
    event.dataTransfer.setData('application/x-mtask-task-id', task.id);
  };

  const endDrag = (): void => {
    dragTaskRef.current = '';
    setDragTaskId('');
    setOverDate('');
  };

  const allowDrop = (event: DragEvent<HTMLElement>, date: string): void => {
    if (!dragTaskRef.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (overDate !== date) setOverDate(date);
  };

  const dropOn = (event: DragEvent<HTMLElement>, date: string): void => {
    const id = event.dataTransfer.getData('application/x-mtask-task-id') || event.dataTransfer.getData('text/plain') || dragTaskRef.current;
    event.preventDefault();
    setOverDate('');
    setDragTaskId('');
    dragTaskRef.current = '';
    const task = tasks.find((t) => t.id === id);
    if (!id || !task || taskDue(task) === date) return;
    void onReschedule(id, date).then(() => restoreFocus(id)).catch(() => undefined);
  };

  const dropUnscheduled = (event: DragEvent<HTMLElement>): void => {
    const id = event.dataTransfer.getData('application/x-mtask-task-id') || event.dataTransfer.getData('text/plain') || dragTaskRef.current;
    event.preventDefault();
    setOverDate('');
    setDragTaskId('');
    dragTaskRef.current = '';
    const task = tasks.find((t) => t.id === id);
    if (!id || !task || taskDue(task) === null) return;
    void onReschedule(id, null).then(() => restoreFocus(id)).catch(() => undefined);
  };

  const moveByKeyboard = (event: KeyboardEvent<HTMLButtonElement>, task: Task): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpenTask(task);
      return;
    }
    if (!event.altKey) return;
    const due = taskDue(task);
    if (event.key === 'Backspace' && due) {
      event.preventDefault();
      event.stopPropagation();
      void onReschedule(task.id, null).then(() => restoreFocus(task.id)).catch(() => undefined);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const base = due ?? today;
    const next = addDays(base, event.key === 'ArrowLeft' ? -1 : 1);
    void onReschedule(task.id, next).then(() => restoreFocus(task.id)).catch(() => undefined);
  };

  const renderTaskCard = (task: Task, date: string | null): ReactElement => {
    const done = task.status === 'done';
    const due = date ?? '未排期';
    const projectName = showProject ? projectNameById?.get(task.project_id) : '';
    return (
      <button
        type="button"
        key={task.id}
        className="mt-cal__task"
        data-t06302="task-card"
        data-task-id={task.id}
        data-done={done ? 'true' : 'false'}
        draggable
        onClick={() => onOpenTask(task)}
        onDragStart={(event) => startDrag(event, task)}
        onDragEnd={endDrag}
        onKeyDown={(event) => moveByKeyboard(event, task)}
        aria-label={`${task.task_no ? `${task.task_no} ` : ''}${task.title}，到期 ${due}。拖拽或 Alt+左右方向键改期，回车打开详情`}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+Backspace"
        title={`${task.title} · ${due} · ${priorityBadgeLabel(task.priority)}优先级（拖拽改期；Alt+←/→ 前后一天，Alt+Backspace 移入未排期）`}
        style={{ borderLeftColor: priorityColor(task.priority) }}
      >
        <span className="mt-cal__task-head">
          {done ? <CircleCheck size={11} className="mt-cal__done-icon" aria-hidden /> : <GripVertical size={11} className="mt-cal__grip" aria-hidden />}
          <span className="mt-cal__task-title">{task.title}</span>
        </span>
        <span className="mt-cal__task-meta">
          {task.task_no && <span>{task.task_no}</span>}
          {projectName && <span className="mt-cal__task-project">{projectName}</span>}
          <span className="mt-cal__task-prio">{priorityBadgeLabel(task.priority)}</span>
        </span>
      </button>
    );
  };

  return (
    <section className="mt-cal" data-t06302="calendar" aria-label="任务日历视图">
      <header className="mt-cal__toolbar">
        <div className="mt-cal__title-block">
          <h2 className="mt-cal__title">
            <CalendarDays size={16} aria-hidden /> 日历
          </h2>
          <div className="mt-cal__subtitle">
            <span data-t06302="range-label">{rangeLabel}</span>
            <span className="mt-cal__count" data-t06302="scheduled-count">已排期 {visibleTaskCount} · 未排期 {unscheduled.length}</span>
          </div>
        </div>
        <div className="mt-cal__controls">
          <span className="mt-cal__nav">
            <button type="button" className="mt-cal__icon-btn" data-t06302="prev" aria-label={mode === 'month' ? '上一月' : '上一周'} title={mode === 'month' ? '上一月' : '上一周'} onClick={() => shiftAnchor(-1)}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="mt-cal__today-btn" data-t06302="today" aria-label="回到今天" onClick={() => setAnchorYmd(today)}>今天</button>
            <button type="button" className="mt-cal__icon-btn" data-t06302="next" aria-label={mode === 'month' ? '下一月' : '下一周'} title={mode === 'month' ? '下一月' : '下一周'} onClick={() => shiftAnchor(1)}>
              <ChevronRight size={16} />
            </button>
          </span>
          <span className="mt-cal__mode-toggle" data-t06302="mode-toggle">
            <button type="button" data-t06302="mode-month" aria-label="月视图" aria-pressed={mode === 'month'} className={mode === 'month' ? 'is-active' : ''} onClick={() => setMode('month')}>月</button>
            <button type="button" data-t06302="mode-week" aria-label="周视图" aria-pressed={mode === 'week'} className={mode === 'week' ? 'is-active' : ''} onClick={() => setMode('week')}>周</button>
          </span>
        </div>
      </header>

      <p className="mt-cal__hint">按任务到期日排布；拖拽卡片改期，或聚焦卡片后用 Alt+←/→ 前后挪一天、Alt+Backspace 移入未排期。</p>

     {loading && tasks.length === 0 ? (
        <div className="mt-cal__loading" data-t06302="loading">日历加载中…</div>
      ) : (
        <div className={`mt-cal__grid mt-cal__grid--${mode}`} data-t06302="grid" data-mode={mode}>
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="mt-cal__weekday" data-t06302="weekday">{label}</div>
          ))}
          {cells.map((cell) => {
            const date = fmtDate(cell);
            const dayTasks = byDate.get(date) ?? [];
            const inMonth = mode === 'week' || cell.getMonth() === anchor.getMonth();
            const maxCards = mode === 'month' ? MAX_CARDS_PER_MONTH : MAX_CARDS_PER_WEEK;
            const extra = Math.max(0, dayTasks.length - maxCards);
            return (
              <div
                key={date}
                className="mt-cal__cell"
                data-t06302="day-cell"
                data-date={date}
                data-outside={inMonth ? 'false' : 'true'}
                data-today={date === today ? 'true' : 'false'}
                data-over={overDate === date ? 'true' : 'false'}
                onDragOver={(event) => allowDrop(event, date)}
                onDrop={(event) => dropOn(event, date)}
              >
                <div className="mt-cal__cell-head">
                  <span className="mt-cal__day">{cell.getDate()}</span>
                  {date === today && <span className="mt-cal__today-tag">今天</span>}
                  {mode === 'week' && <span className="mt-cal__week-month">{cell.getMonth() + 1}月</span>}
                  {dayTasks.length > 0 && <span className="mt-cal__day-count">{dayTasks.length}</span>}
                </div>
                <div className="mt-cal__cell-body">
                  {dayTasks.slice(0, maxCards).map((task) => renderTaskCard(task, date))}
                  {extra > 0 && <span className="mt-cal__more" data-t06302="day-more">另有 {extra} 项</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-cal__unscheduled" data-t06302="unscheduled" data-over={overDate === 'unscheduled' ? 'true' : 'false'}
        onDragOver={(event) => allowDrop(event, 'unscheduled')}
        onDrop={dropUnscheduled}>
        <div className="mt-cal__unscheduled-head">
          <strong>未排期</strong>
          <span className="mt-cal__count" data-t06302="unscheduled-count">{unscheduled.length} 项</span>
          {unscheduled.length > 0 && <span className="mt-cal__unscheduled-tip">拖到左侧任意日期格即可排期；把已排期卡片拖回此处可清空排期</span>}
        </div>
        {unscheduled.length === 0 ? (
          <div className="mt-cal__unscheduled-empty" data-t06302="unscheduled-empty">全部任务都已排期</div>
        ) : (
          <div className="mt-cal__unscheduled-list">
            {unscheduled.map((task) => renderTaskCard(task, null))}
          </div>
        )}
      </div>
      {tasks.length === 0 && !loading && (
        <div className="mt-cal__empty" data-t06302="empty">当前视图暂无任务；切到其他页签或先创建任务后再排期。</div>
      )}
      {dragTaskId && <div className="mt-cal__drag-tip" role="status">正在拖拽，松开到日期格即可改期</div>}
    </section>
  );
}
