import { useCallback, useEffect, useState } from 'react';
import { api, type Project, type Task } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Undo2, Trash2 } from 'lucide-react';
import { relTime } from '../ui/format';

export function ArchivePage() {
  const [archived, setArchived] = useState<Task[]>([]);
  // 项目 id -> 名称 映射，用于标注归档任务所属项目（任务本身只带 project_id）
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setArchived(await api.get<Task[]>('/tasks?archived=1'));
    setProjectNames(Object.fromEntries((await api.get<Project[]>('/projects')).map((p) => [p.id, p.name])));
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function restore(task: Task) {
    await api.post('/archive/restore', { taskIds: [task.id] });
    void load();
  }

  async function remove(task: Task) {
    const ok = await askConfirm(`确认永久删除任务「${task.title}」？此操作不可恢复。`);
    if (!ok) return;
    await api.del('/archive', { taskIds: [task.id] });
    void load();
  }

  return (
    <section>
      {/* 悬浮操作按钮 + 行 hover 高亮 + 相对时间：类名与任务页体验一致，聚焦当前行减少视觉噪音 */}
      <style>{`
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
      `}</style>
      <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>归档任务（{archived.length}）</h3>
      {archived.length === 0 && <p style={{ color: 'var(--text-muted)' }}>暂无归档任务。待办/已完成任务归档后在此管理，归档任务可删除。</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {archived.map((t) => (
          <li key={t.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}（{projectNames[t.project_id] ?? '未知项目'} · {t.status === 'done' ? '已完成' : '待办'}）</span>
            <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${t.archived_at ?? ''}`}>{relTime(t.archived_at)}</span>
            <button className="abtn" onClick={() => void restore(t)} title="还原 — 将该归档任务还原到待办列表" aria-label="还原：将该归档任务还原到待办列表" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void remove(t)} title="删除 — 永久删除该任务，此操作不可恢复" aria-label="删除：永久删除该任务，此操作不可恢复" style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
    </section>
  );
}
