/**
 * 移动端首页：任务（待办概览）。含项目切换、待办列表、完成切换、下拉刷新、空态引导。
 * 悬浮「+」随手记入口由 MobileShell 注入（见 MobileShell 的 FAB）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, imageUrl, type Project, type Task, type TaskCategory } from '../api/client';
import { Plus } from 'lucide-react';

interface Props {
  onQuickNote: () => void;
  notify: (msg: string) => void;
}

const PRIO_COLOR: Record<string, string> = {
  low: 'var(--text-muted)', normal: 'var(--border-strong)', high: 'var(--warn)', urgent: 'var(--danger)',
};
const PRIO_LABEL: Record<string, string> = { low: '低', normal: '中', high: '高', urgent: '紧急' };

export function MobileHome({ onQuickNote, notify }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pullY, setPullY] = useState(0);
  const startY = useRef<number | null>(null);

  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '';

  const load = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    try {
      const list = await api.get<Task[]>(`/tasks?projectId=${pid}`);
      setTasks(list.filter((t) => t.status === 'todo'));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void (async () => {
      try { setCategories(await api.get<TaskCategory[]>('/task-categories')); } catch { /* 忽略 */ }
      let list = await api.get<Project[]>('/projects').catch(() => [] as Project[]);
      setProjects(list);
      if (list.length === 0) return;
      let pid = '';
      try { pid = (await api.get<{ projectId: string }>('/settings/note-project')).projectId; } catch { /* 忽略 */ }
      if (!list.some((p) => p.id === pid)) pid = list[0].id;
      setProjectId(pid);
      await load(pid);
    })();
  }, [load]);

  async function toggleDone(t: Task) {
    try {
      await api.patch(`/tasks/${t.id}`, { status: t.status === 'todo' ? 'done' : 'todo' });
      void load(projectId);
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
  }

  // 下拉刷新：顶部下拉超过阈值触发
  function onTouchStart(e: React.TouchEvent) { startY.current = e.touches[0].clientY; }
  function onTouchMove(e: React.TouchEvent) {
    if (startY.current == null || (e.currentTarget as HTMLElement).scrollTop > 0) { setPullY(0); return; }
    const d = e.touches[0].clientY - startY.current;
    if (d > 0) setPullY(Math.min(d, 70));
  }
  function onTouchEnd() {
    if (pullY > 55) void load(projectId);
    startY.current = null;
    setPullY(0);
  }

  return (
    <div style={page}>
      <header style={headerBar}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>待办概览</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{tasks.length} 条待办</div>
        </div>
        <select value={projectId} onChange={(e) => { setProjectId(e.target.value); void load(e.target.value); }} style={projSelect}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </header>

      <div
        style={{ flex: 1, overflowY: 'auto', padding: '0 12px', position: 'relative', transition: pullY ? 'none' : 'transform .15s ease' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {pullY > 10 && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 6 }}>{pullY > 55 ? '释放刷新…' : '下拉刷新'}</div>}
        {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 10 }}>加载中…</div>}

        {tasks.length === 0 && !loading && (
          <div style={empty}>
            <div style={{ fontSize: 40 }}>📝</div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>还没有待办</div>
            <button onClick={onQuickNote} style={emptyBtn}><Plus size={14} /> 开始随手记</button>
          </div>
        )}

        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {tasks.map((t) => (
            <li key={t.id} style={row}>
              <button onClick={() => void toggleDone(t)} title="切换完成" aria-label="切换完成" style={checkBtn}>
                {t.status === 'todo' ? '☐' : '☑'}
              </button>
              <div style={{ flex: 1, minWidth: 0 }} onClick={() => setExpanded((cur) => (cur === t.id ? null : t.id))}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {t.pinned && <span style={{ fontSize: 11 }}>📌</span>}
                  <span style={{ flex: 1, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  <span style={{ fontSize: 11, color: PRIO_COLOR[t.priority] || 'var(--text-muted)' }}>●{PRIO_LABEL[t.priority] || ''}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                  {t.category_id && <span style={tag}>{catName(t.category_id)}</span>}
                  {t.images.length > 0 && <span style={tag}>🖼 {t.images.length}</span>}
                </div>
                {expanded === t.id && (t.description || t.images.length > 0) && (
                  <div style={{ marginTop: 6 }}>
                    {t.description && <div style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{t.description}</div>}
                    {t.images.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        {t.images.map((img) => (
                          <img key={img.id} src={imageUrl(img.id)} alt="截图" style={{ height: 72, borderRadius: 6, border: '1px solid var(--border)' }} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* 悬浮随手记按钮（拇指区） */}
      <button onClick={onQuickNote} title="随手记 — 快速新建任务" aria-label="随手记" style={fab}>
        <Plus size={26} />
      </button>
    </div>
  );
}

// ---------- 样式 ----------
const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--app-bg)', color: 'var(--text)', position: 'relative' };
const headerBar: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', borderBottom: '1px solid var(--border)', background: 'var(--card-bg)' };
const projSelect: React.CSSProperties = { padding: 6, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 13, background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 160 };
const row: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 2px', borderBottom: '1px solid var(--surface-2)' };
const checkBtn: React.CSSProperties = { fontSize: 20, lineHeight: 1, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)', flexShrink: 0, paddingTop: 2 };
const tag: React.CSSProperties = { fontSize: 11, color: 'var(--text-secondary)', background: 'var(--surface-2)', borderRadius: 6, padding: '2px 6px' };
const empty: React.CSSProperties = { textAlign: 'center', padding: '48px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 };
const emptyBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 16px', borderRadius: 20, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 14 };
const fab: React.CSSProperties = { position: 'absolute', right: 18, bottom: 18, width: 56, height: 56, borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', boxShadow: '0 6px 18px rgba(0,0,0,.22)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
