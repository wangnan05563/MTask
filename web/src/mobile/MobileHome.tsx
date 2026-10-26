/**
 * 移动端首页：任务（待办概览）。含项目切换、待办列表、完成切换、下拉刷新、空态引导。
 * 随手记入口为底栏中央「随手记」Plus（T01388：首页悬浮 FAB 已移除，避免同屏双加号）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Project, type Task, type TaskCategory } from '../api/client';
import { Badge, EmptyState, headerStyle, pageStyle, PullRefresh, rowStyle, Skeleton, wideHintStyle } from './ui';
import { ProjectListHint, getProjectListSnapshot, loadProjectList, projectListPlaceholder, useProjectList } from '../ui/projectList'; // T02212：项目取数接入 T02201 统一容错层
import { MobileTaskDetail } from './MobileTaskDetail';
import { fmtAsOf, loadStaleCache, saveStaleCache } from './offline';

interface Props {
  readonly onQuickNote: () => void;
  readonly notify: (msg: string) => void;
  /** PM-104 ③：通知点按后的定位意图（按 task_no 拉任务，切到所属项目并展开详情） */
  readonly focus?: { taskNo: string; nonce: number } | null;
}

const PRIO_COLOR: Record<string, string> = {
  low: 'var(--text-muted)', normal: 'var(--border-strong)', high: 'var(--warn)', urgent: 'var(--danger)',
};
const PRIO_LABEL: Record<string, string> = { low: '低', normal: '中', high: '高', urgent: '紧急' };

/**
 * 启动项目定位（从首页 useEffect 抽出，S3776 降复杂度；调用顺序与副作用完全不变）。
 * T01663：`lastProject` 是用户偏好（首页上次浏览项目），`note-project` 只是系统默认归属。
 * 原先正条件分支用后者无条件覆写缓存 → 用户手选项目开机即被抹掉。改「偏好优先」，
 * 仅在偏好缺失/项目已删时回落；离线（list 空）与空项目时都不写缓存，保住 T01425 缓存降级。
 * T02212：`list` 改由统一容错层给出——取数失败时它是「上次成功的项目列表」（可能为空），
 * 本函数的降级链（偏好优先 / 空列表不写缓存）不变，故离线仍能落到上次项目。
 * 同批记一条 `lastProjectName`：冷启动遇后端不可用时列表是空的，光有 id 下拉只能显示空白，
 * 有了名字才能把「仍在用上次项目，只是列表没取到」这句话讲圆。
 */
async function resolveStartupProject(list: Project[]): Promise<string> {
  let pref = '';
  try { pref = localStorage.getItem('mtask.mobile.lastProject') ?? ''; } catch { /* 忽略 */ }
  let pid = list.some((p) => p.id === pref) ? pref : '';
  if (!pid && list.length > 0) {
    try { pid = (await api.get<{ projectId: string }>('/settings/note-project')).projectId; } catch { /* 忽略 */ }
    if (!list.some((p) => p.id === pid)) pid = list[0]?.id ?? '';
  }
  if (!pid) pid = pref;
  if (pid && list.length > 0) {
    try {
      localStorage.setItem('mtask.mobile.lastProject', pid);
      const name = list.find((p) => p.id === pid)?.name ?? '';
      if (name) localStorage.setItem('mtask.mobile.lastProjectName', name);
    } catch { /* 忽略 */ }
  }
  return pid;
}

/** T02212：读上次项目名（冷启动取数失败时的下拉回退文案用） */
function readLastProjectName(): string {
  try { return localStorage.getItem('mtask.mobile.lastProjectName') ?? ''; } catch { return ''; }
}

export function MobileHome({ onQuickNote, notify, focus }: Props) {
  // T02212：项目列表改由统一容错层供给（加载中/失败可见 + 重试，失败时仍有上次成功数据）
  const projectList = useProjectList();
  const projects = projectList.projects;
  const [projectId, setProjectId] = useState('');
  const [lastProjectName, setLastProjectName] = useState(''); // T02212：上次项目名，取数失败时下拉回退文案用
  const bootedRef = useRef(false); // 首轮项目定位是否已拿到项目（决定重取成功后要不要补一次定位）
  const [tasks, setTasks] = useState<Task[]>([]);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [detailTask, setDetailTask] = useState<Task | null>(null); // T01423：详情半屏抽屉
  // M7-7.1：需关注改为服务端精确拉取（attention=failed/unread，小响应），替代全量 allTasks 本地筛
  const [failedTasks, setFailedTasks] = useState<Task[]>([]);
  const [unreadTasks, setUnreadTasks] = useState<Task[]>([]);
  // 待办列表分页：服务端 limit=100 + 加载更多；待办总数用 dashboard totals（精确、含未加载页）
  const [todoTotal, setTodoTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [alertFilter, setAlertFilter] = useState(false);
  const [staleAsOf, setStaleAsOf] = useState<string | null>(null); // T01425：离线缓存数据的拉取时间
  // T01432：任务行横滑手势——左滑完成 / 右滑详情；touch-action:pan-y 防纵向滚动冲突
  const [swipe, setSwipe] = useState<{ id: string; dx: number } | null>(null); // 仅视觉反馈
  const swipeRef = useRef<{ id: string; dx: number } | null>(null); // T01432：判定用 ref（touchend 同步可读，不受 setState 批处理影响）
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_THRESHOLD = 72;
  const [loading, setLoading] = useState(false);

  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '';

  // T01424：失败/AI 待读语义由服务端 attention 过滤保证（与原客户端谓词一致），
  // alertFilter 视图直接渲染两组小列表的并集
  const attentionTasks = [...failedTasks, ...unreadTasks];
  const shownTasks = alertFilter ? attentionTasks : tasks;


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

  const PAGE = 100;
  const load = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    // T01425：stale-first——先渲染缓存兜底（弱网/无网立即可见），再后台 revalidate。
    // M7-7.1：缓存改为「待办首页 + 需关注两组小列表」（原全量列表缓存随之废弃）。
    const cached = loadStaleCache<{ tasks: Task[]; failed: Task[]; unread: Task[] }>(`home.${pid}`);
    if (cached) {
      setTasks(cached.data.tasks);
      setFailedTasks(cached.data.failed);
      setUnreadTasks(cached.data.unread);
      setStaleAsOf(cached.asOf);
    }
    try {
      const [list, failed, unread, dash] = await Promise.all([
        api.get<Task[]>(`/tasks?projectId=${pid}&status=todo&limit=${PAGE}`),
        api.get<Task[]>(`/tasks?projectId=${pid}&attention=failed`),
        api.get<Task[]>(`/tasks?projectId=${pid}&attention=unread`),
        api.get<{ totals: { todo: number } }>(`/stats/dashboard?projectId=${pid}`),
      ]);
      setTasks(list);
      setFailedTasks(failed);
      setUnreadTasks(unread);
      setTodoTotal(dash?.totals?.todo ?? list.length);
      setOffset(list.length);
      setHasMore(list.length === PAGE);
      saveStaleCache(`home.${pid}`, { tasks: list, failed, unread });
      setStaleAsOf(null);
    } catch (e) {
      if (!cached) notify(e instanceof Error ? e.message : String(e)); // 有缓存兜底时不重复弹错
    } finally {
      setLoading(false);
    }
  }, [notify]);

  // M7-7.1：加载更多——追加下一页待办（chips 用精确 total，不受分页影响）
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || !projectId) return;
    setLoadingMore(true);
    try {
      const list = await api.get<Task[]>(`/tasks?projectId=${projectId}&status=todo&limit=${PAGE}&offset=${offset}`);
      setTasks((cur) => [...cur, ...list]);
      setOffset((o) => o + list.length);
      setHasMore(list.length === PAGE);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, projectId, offset, notify]);

  const focusNonce = focus?.nonce ?? 0;
  const focusTaskNo = focus?.taskNo ?? '';
  const focusConsumedRef = useRef(0); // 已消费的定位意图（同一 nonce 不重复展开）

  useEffect(() => {
    // 已开机后：focus 被清除（nonce→0）或同一意图重跑时不再重走启动链
    if (bootedRef.current && (focusNonce === 0 || focusNonce === focusConsumedRef.current)) return;
    void (async () => {
      setLastProjectName(readLastProjectName());
      try { setCategories(await api.get<TaskCategory[]>('/task-categories')); } catch { /* 离线时分类缺失可接受 */ }
      await loadProjectList(); // T02212：取数交统一容错层（与 useProjectList 单飞合流，失败不再静默）
      const list = getProjectListSnapshot();
      let pid = '';
      let focused: Task | null = null;
      // PM-104 ③：通知定位优先于「上次项目」——先解析目标任务，落到它所属项目
      if (focusTaskNo && focusNonce !== focusConsumedRef.current) {
        try {
          focused = await api.get<Task>(`/tasks/by-no/${encodeURIComponent(focusTaskNo)}`);
          pid = focused.project_id;
        } catch {
          notify(`通知对应的任务 ${focusTaskNo} 已不存在或已归档`);
        }
        focusConsumedRef.current = focusNonce;
      }
      if (!pid) pid = await resolveStartupProject(list);
      if (!pid) return;
      bootedRef.current = true;
      if (focused) {
        // 通知落位也要更新「上次项目」，避免下次冷启动又跳回旧项目
        try { localStorage.setItem('mtask.mobile.lastProject', pid); } catch { /* 忽略 */ }
        const name = list.find((p) => p.id === pid)?.name ?? '';
        if (name) setLastProjectName(name);
      } else {
        setLastProjectName(readLastProjectName()); // 定位过程可能刚写入新名字，回读一次
      }
      setProjectId(pid);
      await load(pid);
      if (focused) setDetailTask(focused);
    })();
  }, [load, focusNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * T02212：首轮取数失败（list 空、也没上次项目偏好）时上面会直接 return，
   * 下拉在此时被「重试」或窗口重新可见兜底救回来后，项目定位得补做一次——
   * 否则「失败→重试成功」仍停在无任务态，与治的静默失败同族。
   */
  useEffect(() => {
    if (bootedRef.current || projectList.phase !== 'ready' || projectList.projects.length === 0) return;
    bootedRef.current = true;
    void (async () => {
      const pid = await resolveStartupProject(projectList.projects);
      if (!pid) { bootedRef.current = false; return; }
      setProjectId(pid);
      setLastProjectName(readLastProjectName());
      await load(pid);
    })();
  }, [projectList.phase, projectList.projects, load]);

  async function toggleDone(t: Task) {
    try {
      await api.patch(`/tasks/${t.id}`, { status: t.status === 'todo' ? 'done' : 'todo' });
      void load(projectId);
    } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
  }

  /**
   * T02212：切换项目同时落 id + 名。
   * 名字是给「冷启动时后端取不到、列表为空」那次渲染用的回退文案——只存 id 的话
   * 下拉只能显示空白，看上去和「一个项目都没有」同形，正是本单要治的形态。
   */
  function selectProject(pid: string) {
    setProjectId(pid);
    const name = projects.find((p) => p.id === pid)?.name ?? '';
    if (name) setLastProjectName(name);
    try {
      localStorage.setItem('mtask.mobile.lastProject', pid);
      if (name) localStorage.setItem('mtask.mobile.lastProjectName', name);
    } catch { /* 忽略 */ }
    void load(pid);
  }

  /** M6-6.4：行滑动视觉样式。抽出以消除 JSX 中的嵌套三元（S3358）。 */
  function rowVisualStyle(id: string): React.CSSProperties {
    const base: React.CSSProperties = {
      ...rowStyle,
      touchAction: 'pan-y',
      position: 'relative',
      overflow: 'hidden',
    };
    if (swipe?.id !== id) {
      return { ...base, transition: 'transform .18s ease' };
    }
    // 左滑（dx<0）表示「完成」意图 → success 色；右滑 → accent 色
    const bg = swipe.dx < 0
      ? 'color-mix(in srgb, var(--success) 12%, transparent)'
      : 'color-mix(in srgb, var(--accent) 12%, transparent)';
    return { ...base, transform: `translateX(${swipe.dx * 0.35}px)`, transition: 'none', background: bg };
  }

  /** T01563：详情抽屉传入「最新快照」。
   *  detailTask 只是打开抽屉那一刻的副本；就地编辑（描述/处理结果）保存后 load() 刷新的是 tasks，
   *  若继续把旧副本传下去，会出现「保存成功却仍显示旧文本」。列表里没有该任务时（被搁置/完成而移出待办）
   *  沿用副本，避免抽屉因取不到任务而闪退。 */
  const freshDetail = detailTask ? tasks.find((t) => t.id === detailTask.id) : undefined;
  const activeDetail = freshDetail ?? detailTask;

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700 }}>待办概览</div>
          {/* T01435：统计 chips 化——待办/需关注两级信息层级，需关注与告警条同一过滤语义 */}
          <div className="zen-hide" style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button onClick={() => setAlertFilter(false)} aria-pressed={!alertFilter}
              style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', borderRadius: 10, cursor: 'pointer', border: '1px solid ' + (alertFilter ? 'var(--border-strong)' : 'var(--accent)'), background: alertFilter ? 'transparent' : 'var(--accent-soft)', color: 'var(--text)' }}>
              待办 {todoTotal}
            </button>
            <button onClick={() => setAlertFilter(true)} aria-pressed={alertFilter}
              style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', borderRadius: 10, cursor: 'pointer', border: '1px solid ' + (alertFilter ? 'var(--danger)' : 'var(--border-strong)'), background: alertFilter ? 'color-mix(in srgb, var(--danger) 12%, transparent)' : 'transparent', color: failedTasks.length + unreadTasks.length > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
              需关注 {failedTasks.length + unreadTasks.length}
            </button>
          </div>
        </div>
        <select value={projectId} onChange={(e) => selectProject(e.target.value)} style={projSelect}>
          {projects.length === 0 && (
            <option value={projectId || ''}>
              {projectId ? `上次项目：${lastProjectName || projectId}（列表未加载）` : projectListPlaceholder(projectList)}
            </option>
          )}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </header>

      {/* T02212：取数失败/加载中的可见提示（含「上次数据可能过期」标注与重试入口），窄屏整行换行 */}
      <ProjectListHint view={projectList} style={{ ...wideHintStyle, padding: '0 12px', margin: '6px 0 -4px' }} />

      {/* T01424：失败/AI 待读聚合告警条——有告警才渲染，红点常驻，点击切换过滤视图 */}
      {(failedTasks.length > 0 || unreadTasks.length > 0) && (
        <style>{'@keyframes alert-dot-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }'}</style>
      )}
      {(failedTasks.length > 0 || unreadTasks.length > 0) && (
        <button
          onClick={() => setAlertFilter((v) => !v)}
          aria-pressed={alertFilter}
          title="点击查看/退出告警任务列表"
          style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 12px 0', padding: '8px 12px', borderRadius: 10, border: '1px solid var(--danger)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 'var(--fs-m)', textAlign: 'left' }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', flexShrink: 0, animation: 'alert-dot-pulse 1.6s ease-in-out infinite' }} />
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>失败 {failedTasks.length}</span>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>AI 待读 {unreadTasks.length}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>{alertFilter ? '显示全部' : '点击过滤'}</span>
        </button>
      )}

      <PullRefresh onRefresh={() => load(projectId)}>
        <div style={{ padding: '0 12px' }}>
        {/* T01425：缓存数据截至角标——stale 视图时展示 */}
        {staleAsOf && (
          <div style={{ margin: '6px 0 0', padding: '5px 10px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 'var(--fs-s)', display: 'flex', alignItems: 'center', gap: 6 }}>
            ⏱ 数据截至 {fmtAsOf(staleAsOf)}（离线缓存，联网后自动更新）
          </div>
        )}
        {loading && !staleAsOf && <div style={{ padding: '8px 0' }}><Skeleton rows={4} /></div>}

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
              onTouchCancel={() => { swipeRef.current = null; swipeStart.current = null; setSwipe(null); }}
              style={rowVisualStyle(t.id)}
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
                  {t.pinned && <span style={{ fontSize: 'var(--fs-xs)' }}>📌</span>}
                  <span className="zen-zoom" style={{ flex: 1, fontSize: 'var(--fs-xl)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  <span style={{ fontSize: 'var(--fs-xs)', color: PRIO_COLOR[t.priority] || 'var(--text-muted)' }}>●{PRIO_LABEL[t.priority] || ''}</span>
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
          <div style={{ padding: '10px 2px', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textAlign: 'center' }}>
            左滑任务 = 标记完成 · 右滑 = 查看详情
          </div>
          {hasMore && !loading && (
            <button onClick={() => void loadMore()} disabled={loadingMore}
              style={{ width: '100%', padding: 10, marginBottom: 8, borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 'var(--fs-m)', cursor: 'pointer' }}>
              {loadingMore ? '加载中…' : `加载更多（已加载 ${tasks.length}/${todoTotal}）`}
            </button>
          )}
        </div>
      </PullRefresh>
      {/* T01388：悬浮「+」FAB 已移除——底栏中央「随手记」Plus 是唯一入口，避免同屏双加号 */}
      {/* T01563：详情半屏改为「条件渲染 + task.id 作 key」。
       *  原先常驻挂载（仅靠 task=null 提前 return）会让编辑态跨任务残留——实测：在 Alpha 里点「编辑描述」
       *  输入草稿后 ESC 关闭，再打开 Beta 仍停在编辑器且草稿是 Alpha 的内容，Beta 描述被顶掉。
       *  条件渲染负责关闭即卸载，key 负责「打开中切换任务」也重挂载（与桌面抽屉同口径）。 */}
      {activeDetail && (
        <MobileTaskDetail key={activeDetail.id} task={activeDetail} categories={categories} onClose={() => setDetailTask(null)} onChanged={() => void load(projectId)} notify={notify} />
      )}
    </div>
  );
}

// ---------- 样式 ----------
// T01422：页面骨架/卡片/列表行/徽标统一取自 mobile/ui 基础层，页面仅保留特有样式
const projSelect: React.CSSProperties = { padding: 6, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 'var(--fs-m)', background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 160 };
const checkBtn: React.CSSProperties = { fontSize: 'var(--fs-title)', lineHeight: 1, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)', flexShrink: 0, paddingTop: 2, width: 44, height: 44 }; // T01432：热区 ≥44×44
const empty: React.CSSProperties = { textAlign: 'center', padding: '48px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 };
const emptyBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 16px', borderRadius: 20, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 'var(--fs-l)' };
