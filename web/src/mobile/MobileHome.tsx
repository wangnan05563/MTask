/**
 * 移动端首页：任务（待办概览）。含项目切换、待办列表、完成切换、下拉刷新、空态引导。
 * 随手记入口为底栏中央「随手记」Plus（T01388：首页悬浮 FAB 已移除，避免同屏双加号）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, imageUrl, type Project, type Task, type TaskCategory } from '../api/client';
import { Plus } from 'lucide-react';
import { Badge, headerStyle, pageStyle, rowStyle } from './ui';
import { MobileTaskDetail } from './MobileTaskDetail';

interface Props {
  readonly onQuickNote: () => void;
  readonly notify: (msg: string) => void;
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
  const [detailTask, setDetailTask] = useState<Task | null>(null); // T01423：详情半屏抽屉
  // T01424：失败/AI 待读聚合告警——allTasks 保底全量（含 done 的验证失败复核源），点击聚合条切换过滤
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [alertFilter, setAlertFilter] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pullY, setPullY] = useState(0);
  const startY = useRef<number | null>(null);

  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '';

  // T01424：失败 = AI 处理失败 或 验证失败未复核；AI 待读 = 处理完成未读
  const failedTasks = allTasks.filter((t) => t.ai_state === 'failed' || (Boolean(t.handle_result?.includes('【验证失败')) && !t.verified));
  const unreadTasks = allTasks.filter((t) => t.ai_state === 'unread');
  const attentionIds = new Set([...failedTasks, ...unreadTasks].map((t) => t.id));
  const shownTasks = alertFilter ? allTasks.filter((t) => attentionIds.has(t.id)) : tasks;


  const load = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    try {
      const list = await api.get<Task[]>(`/tasks?projectId=${pid}`);
      setAllTasks(list);
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
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>待办概览</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{tasks.length} 条待办</div>
        </div>
        <select value={projectId} onChange={(e) => { setProjectId(e.target.value); void load(e.target.value); }} style={projSelect}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </header>

      {/* T01424：失败/AI 待读聚合告警条——有告警才渲染，红点常驻，点击切换过滤视图 */}
      {(failedTasks.length > 0 || unreadTasks.length > 0) && (
        <style>{'@keyframes alert-dot-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }'}</style>
      )}
      {(failedTasks.length > 0 || unreadTasks.length > 0) && (
        <button
          onClick={() => setAlertFilter((v) => !v)}
          aria-pressed={alertFilter}
          title="点击查看/退出告警任务列表"
          style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 12px 0', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--danger)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13, textAlign: 'left' }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', flexShrink: 0, animation: 'alert-dot-pulse 1.6s ease-in-out infinite' }} />
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>失败 {failedTasks.length}</span>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>AI 待读 {unreadTasks.length}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 12 }}>{alertFilter ? '显示全部' : '点击过滤'}</span>
        </button>
      )}

      <div
        style={{ flex: 1, overflowY: 'auto', padding: '0 12px', position: 'relative', transition: pullY ? 'none' : 'transform .15s ease' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {pullY > 10 && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 6 }}>{pullY > 55 ? '释放刷新…' : '下拉刷新'}</div>}
        {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 10 }}>加载中…</div>}

        {shownTasks.length === 0 && !loading && alertFilter && (
          <div style={empty}><div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>没有需要关注的任务了</div></div>
        )}
        {tasks.length === 0 && !loading && !alertFilter && (
          <div style={empty}>
            <div style={{ fontSize: 40 }}>📝</div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>还没有待办</div>
            <button onClick={onQuickNote} style={emptyBtn}><Plus size={14} /> 开始随手记</button>
          </div>
        )}

        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {shownTasks.map((t) => (
            <li key={t.id} style={rowStyle}>
              <button onClick={() => void toggleDone(t)} title="切换完成" aria-label="切换完成" style={checkBtn}>
                {t.status === 'todo' ? '☐' : '☑'}
              </button>
              {/* 用原生 button 并重置默认样式：既保留行内排版，又天然满足可交互性（S6819） */}
              <button
                type="button"
                aria-label={`任务详情：${t.title}，点按查看详情与操作`}
                style={{ flex: 1, minWidth: 0, cursor: 'pointer', background: 'none', border: 'none', padding: 0, textAlign: 'left', font: 'inherit', color: 'inherit' }}
                onClick={() => setDetailTask(t)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {t.pinned && <span style={{ fontSize: 11 }}>📌</span>}
                  <span style={{ flex: 1, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  <span style={{ fontSize: 11, color: PRIO_COLOR[t.priority] || 'var(--text-muted)' }}>●{PRIO_LABEL[t.priority] || ''}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                  {t.category_id && <Badge>{catName(t.category_id)}</Badge>}
                  {t.images.length > 0 && <Badge>🖼 {t.images.length}</Badge>}
                </div>
                {/* T01423：详情/附件展示移入 MobileTaskDetail 半屏抽屉 */}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {/* T01388：悬浮「+」FAB 已移除——底栏中央「随手记」Plus 是唯一入口，避免同屏双加号 */}
      <MobileTaskDetail task={detailTask} categories={categories} onClose={() => setDetailTask(null)} onChanged={() => void load(projectId)} notify={notify} />
    </div>
  );
}

// ---------- 样式 ----------
// T01422：页面骨架/卡片/列表行/徽标统一取自 mobile/ui 基础层，页面仅保留特有样式
const projSelect: React.CSSProperties = { padding: 6, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 13, background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 160 };
const checkBtn: React.CSSProperties = { fontSize: 20, lineHeight: 1, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)', flexShrink: 0, paddingTop: 2 };
const empty: React.CSSProperties = { textAlign: 'center', padding: '48px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 };
const emptyBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 16px', borderRadius: 20, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 14 };
