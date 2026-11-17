/**
 * 任务事件时间线（T01064-FR1.5）：状态流转/回传/验证历史自动记录展示。
 * T01442：从 TasksPage 抽为共享组件——桌面任务行与移动端详情抽屉复用。
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';

export function TaskEventTimeline({ taskId }: { readonly taskId: string }) {
  const [events, setEvents] = useState<Array<{ kind: string; detail: string; created_at: string }> | null>(null);
  useEffect(() => {
    let alive = true;
    void api.get<Array<{ kind: string; detail: string; created_at: string }>>(`/events/by-task/${taskId}`)
      .then((d) => { if (alive) setEvents(Array.isArray(d) ? d : []); })
      .catch(() => { if (alive) setEvents([]); });
    return () => { alive = false; };
  }, [taskId]);
  if (!events || events.length === 0) return null;
  return (
    <div style={{ margin: '8px 0 0', padding: '8px 10px', border: '1px dashed var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>时间线 · 事件自动记录</div>
      {events.map((ev) => (
        <div key={`${ev.created_at}|${ev.kind}|${ev.detail}`} style={{ display: 'flex', gap: 8, fontSize: 'var(--fs-xs)', alignItems: 'baseline' }}>
          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>{ev.created_at.slice(5, 16).replace('T', ' ')}</span>
          <span style={{ color: ev.detail.includes('失败') ? 'var(--danger)' : 'var(--text-secondary)' }}>{ev.detail}</span>
        </div>
      ))}
    </div>
  );
}
