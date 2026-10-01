/**
 * 移动端首页：任务（待办概览）。含项目切换、待办列表、完成切换、下拉刷新、空态引导。
 * 随手记入口为底栏中央「随手记」Plus（T01388：首页悬浮 FAB 已移除，避免同屏双加号）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, imageUrl, type Project, type Task, type TaskCategory } from '../api/client';
import { Plus } from 'lucide-react';
import { Badge, EmptyState, headerStyle, pageStyle, PullRefresh, rowStyle, Skeleton } from './ui';
import { MobileTaskDetail } from './MobileTaskDetail';
import { fmtAsOf, loadStaleCache, saveStaleCache } from './offline';

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
  const [staleAsOf, setStaleAsOf] = useState<string | null>(null); // T01425：离线缓存数据的拉取时间
  // T01432：任务行横滑手势——左滑完成 / 右滑详情；touch-action:pan-y 防纵向滚动冲突
  const [swipe, setSwipe] = useState<{ id: string; dx: number } | null>(null); // 仅视觉反馈
  const swipeRef = useRef<{ id: string; dx: number } | null>(null); // T01432：判定用 ref（touchend 同步可读，不受 setState 批处理影响）
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_THRESHOLD = 72;
  const [loading, setLoading] = useState(false);

  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '';

  // T01424：失败 = AI 处理失败 或 验证失败未复核；AI 待读 = 处理完成未读
  const failedTasks = allTasks.filter((t) => t.ai_state === 'failed' || (Boolean(t.handle_result?.includes('【验证失败')) && !t.verified));
  const unreadTasks = allTasks.filter((t) => t.ai_state === 'unread');
  const attentionIds = new Set([...failedTasks, ...unreadTasks].map((t) => t.id));
  const shownTasks = alertFilter ? allTasks.filter((t) => attentionIds.has(t.id)) : tasks;


  // T01432：横滑手势处理（仅横向位移占优时介入，纵向滚动不受影响）
  function onRowTouchStart(e: React.TouchEvent, id: string) {
    swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onRowTouchMove(e: React.TouchEvent, id: string) {
    if (!swipeStart.current) return;
    const dx = e.touches[0].clientX - swipeStart.current.x;
    const dy = e.touches[0].clientY - swipeStart.current.y;
    if (Math.abs(dx) > Math.abs(dy) + 6) {
      const clamped = { id, dx: Math.max(-96, Math.min(96, dx)) };
      swipeRef.current = clamped;
      setSwipe(clamped);
    } else if (Math.abs(dy) > 8) {
      swipeRef.current = null;
      setSwipe((cur) => (cur?.id === id ? null : cur));
    }
  }
  function onRowTouchEnd(t: Task) {
    const cur = swipeRef.current;
    swipeRef.current = null;
    swipeStart.current = null;
    setSwipe(null);
    if (!cur || cur.id !== t.id) return;
    if (cur.dx <= -SWIPE_THRESHOLD) void toggleDone(t);       // 左滑 → 完成/回退
    else if (cur.dx >= SWIPE_THRESHOLD) setDetailTask(t);     // 右滑 → 详情
  }

  const load = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    // T01425：stale-first——先渲染缓存兜底（弱网/无网立即可见），再后台 revalidate
    const cached = loadStaleCache<Task[]>(`tasks.${pid}`);
    if (cached) {
      setAllTasks(cached.data);
      setTasks(cached.data.filter((t) => t.status === 'todo'));
      setStaleAsOf(cached.asOf);
    }
    try {
      const list = await api.get<Task[]>(`/tasks?projectId=${pid}`);
      setAllTasks(list);
      setTasks(list.filter((t) => t.status === 'todo'));
      saveStaleCache(`tasks.${pid}`, list);
      setStaleAsOf(null);
    } catch (e) {
      if (!cached) notify(e instanceof Error ? e.message : String(e)); // 有缓存兜底时不重复弹错
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void (async () => {
      try { setCategories(await api.get<TaskCategory[]>('/task-categories')); } catch { /* 离线时分类缺失可接受 */ }
      let list: Project[] = [];
      try { list = await api.get<Project[]>('/projects'); setProjects(list); } catch { /* T01425：离线降级，用上次项目走缓存 */ }
      let pid = '';
      try { pid = (await api.get<{ projectId: string }>('/settings/note-project')).projectId; } catch { /* 忽略 */ }
      if (!list.some((p) => p.id === pid)) pid = list[0]?.id ?? '';
      if (!pid) {
        try { pid = localStorage.getItem('mtask.mobile.lastProject') ?? ''; } catch { /* 忽略 */ }
      } else {
        try { localStorage.setItem('mtask.mobile.lastProject', pid); } catch { /* 忽略 */ }
      }
      if (!pid) return;
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


  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>待办概览</div>
          {/* T01435：统计 chips 化——待办/需关注两级信息层级，需关注与告警条同一过滤语义 */}
          <div className="zen-hide" style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button onClick={() => setAlertFilter(false)} aria-pressed={!alertFilter}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', border: '1px solid ' + (!alertFilter ? 'var(--accent)' : 'var(--border-strong)'), background: !alertFilter ? 'var(--accent-soft)' : 'transparent', color: 'var(--text)' }}>
              待办 {tasks.length}
            </button>
            <button onClick={() => setAlertFilter(true)} aria-pressed={alertFilter}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', border: '1px solid ' + (alertFilter ? 'var(--danger)' : 'var(--border-strong)'), background: alertFilter ? 'color-mix(in srgb, var(--danger) 12%, transparent)' : 'transparent', color: failedTasks.length + unreadTasks.length > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
              需关注 {failedTasks.length + unreadTasks.length}
            </button>
          </div>
        </div>
        <select value={projectId} onChange={(e) => { setProjectId(e.target.value); try { localStorage.setItem('mtask.mobile.lastProject', e.target.value); } catch { /* 忽略 */ } void load(e.target.value); }} style={projSelect}>
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

      <PullRefresh onRefresh={() => load(projectId)}>
        <div style={{ padding: '0 12px' }}>
        {/* T01425：缓存数据截至角标——stale 视图时展示 */}
        {staleAsOf && (
          <div style={{ margin: '6px 0 0', padding: '5px 10px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            ⏱ 数据截至 {fmtAsOf(staleAsOf)}（离线缓存，联网后自动更新）
          </div>
        )}
        {loading && <div style={{ padding: '8px 0' }}><Skeleton rows={4} /></div>}

        {shownTasks.length === 0 && !loading && alertFilter && (
          <EmptyState icon="✅" message="没有需要关注的任务了" />
        )}
        {tasks.length === 0 && !loading && !alertFilter && (
          <EmptyState icon="📝" message="还没有待办" actionLabel="开始随手记" onAction={onQuickNote} />
        )}

        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {shownTasks.map((t) => (
            <li
              key={t.id}
              onTouchStart={(e) => onRowTouchStart(e, t.id)}
              onTouchMove={(e) => onRowTouchMove(e, t.id)}
              onTouchEnd={() => onRowTouchEnd(t)}
              style={{ ...rowStyle, touchAction: 'pan-y', position: 'relative', overflow: 'hidden', transform: swipe?.id === t.id ? `translateX(${swipe.dx * 0.35}px)` : undefined, transition: swipe?.id === t.id ? 'none' : 'transform .18s ease', background: swipe?.id === t.id ? (swipe.dx < 0 ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--accent) 12%, transparent)') : undefined }}
            >
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
                <div className="zen-hide" style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                  {t.category_id && <Badge>{catName(t.category_id)}</Badge>}
                  {t.images.length > 0 && <Badge>🖼 {t.images.length}</Badge>}
                </div>
                {/* T01423：详情/附件展示移入 MobileTaskDetail 半屏抽屉 */}
              </button>
            </li>
          ))}
        </ul>
          <div style={{ padding: '10px 2px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            左滑任务 = 标记完成 · 右滑 = 查看详情
          </div>
        </div>
      </PullRefresh>
      {/* T01388：悬浮「+」FAB 已移除——底栏中央「随手记」Plus 是唯一入口，避免同屏双加号 */}
      <MobileTaskDetail task={detailTask} categories={categories} onClose={() => setDetailTask(null)} onChanged={() => void load(projectId)} notify={notify} />
    </div>
  );
}

// ---------- 样式 ----------
// T01422：页面骨架/卡片/列表行/徽标统一取自 mobile/ui 基础层，页面仅保留特有样式
const projSelect: React.CSSProperties = { padding: 6, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 13, background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 160 };
const checkBtn: React.CSSProperties = { fontSize: 20, lineHeight: 1, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)', flexShrink: 0, paddingTop: 2, width: 44, height: 44 }; // T01432：热区 ≥44×44
const empty: React.CSSProperties = { textAlign: 'center', padding: '48px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 };
const emptyBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 16px', borderRadius: 20, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 14 };
