/**
 * T01423（mtask三期 2.2）：任务详情半屏抽屉。
 * 只读展示：标题/状态/优先级/分类/描述/图片附件；操作：完成（回退）、搁置（恢复）。
 * 基于 ui.tsx 的 HalfSheet 基元（T01422 组件规范化基础层）。
 */
import { useState } from 'react';
import { api, imageUrl, type Task, type TaskCategory } from '../api/client';
import { Badge, HalfSheet, type BadgeTone } from './ui';
import { TaskEventTimeline } from '../components/TaskEventTimeline';

const PRIO_LABEL: Record<string, string> = { urgent: '紧急', high: '高', normal: '普通', low: '低' };
const PRIO_TONE: Record<string, BadgeTone> = { urgent: 'danger', high: 'accent', normal: 'neutral', low: 'neutral' };
const STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成' };

export function MobileTaskDetail({ task, categories, onClose, onChanged, notify }: {
  readonly task: Task | null;
  readonly categories: TaskCategory[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
  readonly notify: (msg: string, isErr?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!task) return null;

  const catName = categories.find((c) => c.id === task.category_id)?.name ?? '';
  const done = task.status === 'done';

  async function act(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    try {
      await fn();
      notify(okMsg);
      onChanged();
      onClose();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    } finally { setBusy(false); }
  }

  const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' };
  const valueStyle: React.CSSProperties = { fontSize: 14, color: 'var(--text)' };
  const opBtn: React.CSSProperties = { flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '10px 0', borderRadius: 10, fontSize: 14, cursor: busy ? 'wait' : 'pointer', border: '1px solid var(--border-strong)' };

  return (
    <HalfSheet open title="任务详情" onClose={onClose}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>{task.title}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge tone={done ? 'success' : 'accent'}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
        <Badge tone={PRIO_TONE[task.priority] ?? 'neutral'}>{PRIO_LABEL[task.priority] ?? task.priority}</Badge>
        {catName && <Badge>{catName}</Badge>}
        {task.pinned && <Badge tone="accent">📌 置顶</Badge>}
      </div>
      {task.description && (
        <div style={{ marginTop: 10 }}>
          <div style={labelStyle}>描述</div>
          <div style={{ ...valueStyle, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 2 }}>{task.description}</div>
        </div>
      )}
      {/* T01442：状态流转时间线（最近事件自动记录，与桌面端同源） */}
      <TaskEventTimeline taskId={task.id} />
      {task.images.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={labelStyle}>附件（{task.images.length}）</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {task.images.map((img) => (
              <img key={img.id} src={imageUrl(img.id)} alt="任务截图" style={{ height: 88, borderRadius: 8, border: '1px solid var(--border)' }} />
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button disabled={busy} onClick={() => void act(() => api.patch(`/tasks/${task.id}`, { status: done ? 'todo' : 'done' }), done ? '已回退到待办' : '已完成')}
          style={{ ...opBtn, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none' }}>
          {done ? '↩ 回退待办' : '✓ 标记完成'}
        </button>
        <button disabled={busy} onClick={() => void act(() => api.post(`/tasks/${task.id}/shelve`, { shelved: !task.shelved }), task.shelved ? '已恢复' : '已搁置——AI 处理待办时自动忽略')}
          style={{ ...opBtn, background: 'var(--surface-2)', color: 'var(--text)' }}>
          {task.shelved ? '恢复' : '搁置'}
        </button>
      </div>
    </HalfSheet>
  );
}
