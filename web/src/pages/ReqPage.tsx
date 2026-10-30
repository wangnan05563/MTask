import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, CalendarRange, ChevronDown, ChevronUp, FolderInput, FolderPlus, ListTodo, Loader2, Minimize2, Pencil, Plus, Save, Sparkles, SquarePen, Trash2, Wand2, X, UnfoldVertical, FoldVertical } from 'lucide-react';
import { CopyButton } from '../ui/CopyButton';
import { FontColorButton } from '../ui/FontColorButton';
import { api, type ReqCategory, type ReqEntry } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { clearSessionState, usePersistentState, useSessionState } from '../ui/session';
import { ProjectListHint, loadProjectList, projectListPlaceholder, useProjectList } from '../ui/projectList'; // T02201
import { NotOpenButton } from '../ui/notOpen'; // T03185（UX-05⑤）：未开放入口=可见但禁用+范围说明
import { MarkdownContent } from '../ui/Markdown';
import { PinToggle } from '../ui/PinToggle';
import { FavoriteToggle } from '../ui/FavoriteToggle'; // T03683：收藏切换（与提示词页共用同一组件）
import { focusSettingsTab } from '../ui/settingsTabs'; // T03685：工具条「归档」直达归档管理页
import { applyDeepLink } from '../ui/deepLink'; // T03685：focusSettingsTab 只落页签，切一级菜单要靠 deepLink（与 SonarScanPanel.goSettings 同口径）
import { AiPolishButton } from '../ui/AiPolishButton'; // T00796 二轮：通用需求正文 AI 美化
import { PromptOptimizeButton } from '../ui/PromptOptimizeButton'; // T00842 二轮：正文改写为结构化提示词
import { OPTIMIZE_SCOPE_REQ, useOptimizeStore } from '../stores/optimizeStore'; // T03684：优化运行态切页保持
import { relTime } from '../ui/format';

/** 通用需求仓库：按分类管理"通用优秀实现/解决方案"，支持增删改查与一键复制 */
export function ReqPage() {
  const [categories, setCategories] = useState<ReqCategory[]>([]);
  // 当前分类：跨切换会话记忆用户选择，便于切回后继续操作
  const [activeCat, setActiveCat] = useSessionState('req.activeCat', '');
  const [entries, setEntries] = useState<ReqEntry[]>([]);
  // T03684：搜索词/排序条件/显示范围跨页面切换保持——此前是组件级 useState，
  // App.tsx 切 tab 会卸载整页，回到本页即被重置（用户报「切页面后筛选/排序全丢」）
  const [search, setSearch] = useSessionState('req.search', '');
  const [notice, setNotice] = useState('');

  // T00629：复制到待办任务——目标项目选择弹窗（与提示词页一致）
  const [taskCopyEntry, setTaskCopyEntry] = useState<ReqEntry | null>(null);
  const [taskCopyProjectId, setTaskCopyProjectId] = useState('');
  const [taskCopyBusy, setTaskCopyBusy] = useState(false);
  // T03185（UX-05①②③④）：转计划的目标项目——同样只走「下拉 + 携带 ID」，不再让用户手输项目名。
  // 手输项目名会把名称送进 projectId 槽位，后端按 ID 校验直接报「目标项目不存在」（U13）。
  const [planEntry, setPlanEntry] = useState<ReqEntry | null>(null);
  const [planProjectId, setPlanProjectId] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [noteProject, setNoteProject] = useState<{ projectId: string; inboxId: string } | null>(null);
  const [currentProject] = usePersistentState('tasks.activeProject', ''); // 当前正在看的项目，作转计划的默认预选
  const projectList = useProjectList(); // T02201：项目列表统一走容错层
  const { projects } = projectList;
  // 排序条件：sortKey 排序字段，sortDir 升降序（默认时间降序，与后端默认一致）
  // T03684：同 search，升为会话级持久（切菜单回来保持上次的排序选择）
  const [sortKey, setSortKey] = useSessionState<'updated_at' | 'created_at' | 'title' | 'manual'>('req.sortKey', 'updated_at');
  const [sortDir, setSortDir] = useSessionState<'asc' | 'desc'>('req.sortDir', 'desc');
  // T03683：显示范围（'all' 全部显示 | 'fav' 只看收藏），与提示词页同键格式、同语义
  const [viewScope, setViewScope] = useSessionState<'all' | 'fav'>('req.viewScope', 'all');
  // 新建条目表单：录入状态跨会话持久化，切页后可续写
  const [creating, setCreating] = useSessionState('req.new.creating', false);
  const [newTitle, setNewTitle] = useSessionState('req.new.title', '');
  const [newContent, setNewContent] = useSessionState('req.new.content', '');
  // 编辑草稿：entryId -> 草稿
  // T03684：草稿与展开态升为会话级——切到别的菜单再回来，编辑到一半的正文和展开的行都还在
  // （此前是组件级 useState，页面卸载即丢；这是用户报「状态保持失效」的主症状）
  const [drafts, setDrafts] = useSessionState<Record<string, { title: string; content: string; categoryId: string }>>('req.drafts', {});
  // 内容 展开/收起：expandedIds 记录已展开的条目 id，默认全部收起（点击标题切换，降低信息密度）
  const [expandedIds, setExpandedIds] = useSessionState<Record<string, boolean>>('req.expandedIds', {});
  // T03684：「提示词优化」的运行态与结果提升到模块级 store（键域 `req:`）。
  // 此前按钮的忙碌态在组件内、结果经 onOptimized 闭包回填：切一级菜单整页卸载后，
  // 呼吸态消失且 AI 回来时回填打在已卸载组件上被丢弃——用户等了半天「什么都没发生」。
  // 现在结果先 park 在 store，本页挂载即排入对应条目的编辑草稿（等价当场回填）。
  useOptimizeStore(OPTIMIZE_SCOPE_REQ, (id, result) => {
    const draft = drafts[id];
    // 编辑态已关闭（草稿不在）时不凭空造一条空标题草稿——那会把行渲染成「标题空着」的编辑态
    if (!draft) { flash('提示词优化已完成，但该条的编辑态已关闭，请重新进入编辑后再优化'); return; }
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? draft), content: result.text } }));
    flash('已生成结构化提示词，请核对后保存');
  });
  // 记录高亮：保存/新增成功后对目标行打标记，flashAt 值变化触发行动画重放
  const [flashAt, setFlashAt] = useState<Record<string, number>>({});
  function dropReorder(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(''); setOverId(''); return; }
    const ids = sortedEntries.map((x) => x.id); // T00494 修正：按显示顺序计算拖拽映射（此前用原始数组顺序，与界面所见不一致导致拖拽错乱）
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragId(''); setOverId('');
    void api.post('/req-entries/reorder', { categoryId: activeCat, orderedIds: ids }).then(() => {
      flash('顺序已保存');
      void loadEntries(activeCat, search);
    }).catch((e) => flash(String((e as Error).message ?? e)));
  }

  // T00463：条目拖拽排序状态
  const [dragId, setDragId] = useState('');
  // T00489：按住行 200ms 才缩放（快速点击/点行内按钮不触发）
  const [pressId, setPressId] = useState('');
  const pressTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({}); // NOSONAR - dragId 供 dropReorder 读取，setDragId 用于拖拽态重渲染
  const [overId, setOverId] = useState(''); // NOSONAR - overId 供列表行接入拖拽高亮后读取，setOverId 用于拖拽悬停态重渲染
  // 调整分组：moveOpenId 记录当前展开分组选择器的条目 id（单开），'' 表示全部收起
  const [moveOpenId, setMoveOpenId] = useState('');
  // 分组选择器容器引用：用于判断点击是否落在菜单外部（点击外部收起）
  const moveRef = useRef<HTMLDivElement | null>(null);

  // T03683：提示条计时器单例——每次 flash 新建 setTimeout 会让「上一条提示的定时器」提前清掉下一条提示，
  // 收藏失败回滚那条正好撞上（真机门实测：回滚提示 200ms 内就消失了，等于没有反馈）
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (msg: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(msg);
    noticeTimer.current = setTimeout(() => setNotice(''), 2500);
  };
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const loadCategories = useCallback(async () => {
    const cats = await api.get<ReqCategory[]>('/req-categories');
    setCategories(cats);
    // 保持当前选中；选中项被删除或首次加载时回落到第一个分类
    setActiveCat((cur) => (cats.some((c) => c.id === cur) ? cur : cats[0]?.id ?? ''));
  }, []);

  const loadEntries = useCallback(async (categoryId: string, keyword: string) => {
    if (!categoryId) { setEntries([]); return; }
    const qs = new URLSearchParams({ categoryId });
    if (keyword.trim()) qs.set('keyword', keyword.trim());
    setEntries(await api.get<ReqEntry[]>(`/req-entries?${qs.toString()}`));
  }, []);

  useEffect(() => { void loadCategories(); }, [loadCategories]);
  useEffect(() => { void loadEntries(activeCat, search); }, [activeCat, search, loadEntries]);

  // ---------- 分类管理 ----------
  async function addCategory() {
    const name = await askInput({ title: '新建通用需求分类', placeholder: '请输入分类名称' });
    if (!name) return;
    try {
      const created = await api.post<ReqCategory>('/req-categories', { name });
      await loadCategories();
      setActiveCat(created.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function renameCategory(cat: ReqCategory) {
    const name = await askInput({ title: '重命名分类', defaultValue: cat.name });
    if (!name || name === cat.name) return;
    try {
      await api.patch(`/req-categories/${cat.id}`, { name });
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeCategory(cat: ReqCategory) {
    const cnt = cat.reqCount ?? 0;
    // 影响面文案先算好再插值：避免模板字面量嵌套（内层模板写在外层 ${} 里）
    const impact = cnt > 0 ? `其下 ${cnt} 条通用需求将一并删除，` : '';
    const ok = await askConfirm(`确认删除分类「${cat.name}」？${impact}此操作不可恢复。`);
    if (!ok) return;
    try {
      await api.del(`/req-categories/${cat.id}`);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------- 条目增删改查 ----------
  async function createEntry() {
    if (!newTitle.trim() || !activeCat) return;
    try {
      await api.post('/req-entries', { categoryId: activeCat, title: newTitle.trim(), content: newContent });
      setNewTitle('');
      setNewContent('');
      setCreating(false);
      // 提交成功后清空持久化缓存，避免下次继续显示旧录入内容
      clearSessionState('req.new.creating');
      clearSessionState('req.new.title');
      clearSessionState('req.new.content');
      void loadEntries(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveDraft(p: ReqEntry) {
    const d = drafts[p.id];
    // 可选链一步覆盖「无草稿」与「标题为空」两种返回条件
    if (!d?.title.trim()) return;
    try {
      await api.patch(`/req-entries/${p.id}`, { title: d.title.trim(), content: d.content, categoryId: d.categoryId });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
      setFlashAt((prev) => ({ ...prev, [p.id]: Date.now() }));
      void loadEntries(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeEntry(p: ReqEntry) {
    if (!(await askConfirm(`删除通用需求「${p.title}」？此操作不可恢复。`))) return;
    try {
      await api.del(`/req-entries/${p.id}`);
      void loadEntries(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * T03185（UX-05①②④）：转计划——打开目标项目选择弹窗。
   * 此前是「输入项目名称」的文本框，名称被直接塞进 projectId 字段，后端 `WHERE id = ?` 必然落空，
   * 用户看到「目标项目不存在」却不知道为什么；同名项目更无从区分。改为下拉携带 ID 后由构造消除。
   */
  function toPlan(p: ReqEntry) {
    setPlanEntry(p);
    setPlanProjectId('');
    setNoteProject(null);
    void loadProjectList(true);
    void api.get<{ projectId: string; inboxId: string }>('/settings/note-project')
      .then(setNoteProject)
      .catch(() => setNoteProject(null)); // 读不到默认项目不影响：仍可手选
  }

  /**
   * 默认项目预选（UX-05①）：弹窗打开且项目列表就绪后，按「当前正在看的项目 → 默认记事项目 → 收件箱」
   * 依次取第一个仍然有效的 ID。合法性以列表为准，持久化的项目指针可能已随项目删除而失效。
   */
  useEffect(() => {
    if (!planEntry || planProjectId || projects.length === 0) return;
    const valid = (id: string) => (id && projects.some((x) => x.id === id) ? id : '');
    const fallback = valid(currentProject) || valid(noteProject?.projectId ?? '') || valid(noteProject?.inboxId ?? '');
    if (fallback) setPlanProjectId(fallback);
  }, [planEntry, planProjectId, projects, currentProject, noteProject]);

  /** T03185：确认转计划（项目必选——计划必须挂在具体项目下，无项目时按钮禁用并给出出口） */
  async function confirmToPlan() {
    if (!planEntry || !planProjectId) return;
    const p = planEntry;
    const targetName = projects.find((x) => x.id === planProjectId)?.name ?? '所选项目';
    setPlanBusy(true);
    try {
      await api.post('/plans/from-req', { reqEntryId: p.id, projectId: planProjectId });
      flash(`已将「${p.title}」转存到「${targetName}」的项目计划`);
      setPlanEntry(null);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setPlanBusy(false); }
  }

  /** T00629：复制到待办任务——支持**指定目标项目**（弹窗选择；不选则落默认记事项目/收件箱） */
  async function copyToTask(p: ReqEntry) {
    setTaskCopyEntry(p);
    setTaskCopyProjectId('');
    // T02201：弹窗打开时强制刷新一次（单飞 + 超时 + 重试由容错层承担），
    // 失败不再静默——下拉显示占位文案并可点重试；不选项目仍落默认收件箱。
    void loadProjectList(true);
  }

  /** T00629：确认复制到待办（目标项目可选） */
  async function confirmCopyToTask() {
    if (!taskCopyEntry) return;
    const p = taskCopyEntry;
    const targetName = taskCopyProjectId
      ? (projects.find((x) => x.id === taskCopyProjectId)?.name ?? '所选项目')
      : '默认记事项目（收件箱）';
    setTaskCopyBusy(true);
    try {
      const r = await api.post<{ ok: boolean; reused: boolean }>(`/req-entries/${p.id}/to-task`,
        taskCopyProjectId ? { projectId: taskCopyProjectId } : {});
      flash(r.reused
        ? `目标项目已有同标题待办，已复用（${targetName}）`
        : `已复制「${p.title}」到待办任务（${targetName}）`);
      setTaskCopyEntry(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskCopyBusy(false);
    }
  }

  /** 复制到剪贴板（Electron/file:// 下 clipboard API 可能受限，提供 execCommand 兜底） */
  async function copyEntry(p: ReqEntry) {
    try {
      await navigator.clipboard.writeText(p.content);
      flash('已复制到剪贴板');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = p.content;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy'); // NOSONAR - Clipboard API 受限环境（Electron/file://）的降级路径无未废弃替代 API
        flash('已复制到剪贴板');
      } catch {
        flash('复制失败，请手动选择文本复制');
      }
      ta.remove();
    }
  }

  /** 置顶/取消置顶：切换后重新拉取，置顶项经前端排序始终排在最前 */
  async function togglePin(p: ReqEntry) {
    try {
      await api.patch(`/req-entries/${p.id}`, { pinned: !p.pinned });
      void loadEntries(activeCat, search);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** T03683：收藏/取消收藏——乐观改本地行，失败回滚并提示（与提示词页 toggleFavorite 同口径）。
   *  条目列表是本页自持的 useState（非 useResource），直接 setEntries 即可，无需整表 reload。 */
  async function toggleFavorite(p: ReqEntry) {
    const next = !Boolean(p.is_favorited);
    const withFlag = (favorited: boolean) => entries.map((x) => (x.id === p.id ? { ...x, is_favorited: favorited } : x));
    setEntries(withFlag(next));
    try {
      await api.patch(`/req-entries/${p.id}`, { isFavorited: next });
      flash(next ? `已收藏「${p.title}」` : `已取消收藏「${p.title}」`);
    } catch (e) {
      setEntries(withFlag(!next));
      flash(`收藏失败，已还原：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** T03685：归档条目（删除改归档）——与提示词页 T00525 同语义：列表不再显示、数据保留，
   *  可在「设置 → 归档 → 归档通用需求」区还原或彻底删除。 */
  async function archiveEntry(p: ReqEntry) {
    if (!(await askConfirm(`归档通用需求「${p.title}」？归档后列表不再显示（数据保留），可在「设置 → 归档」还原。`))) return;
    try {
      await api.patch(`/req-entries/${p.id}`, { archived: true });
      flash('已归档');
      void loadEntries(activeCat, search);
      void loadCategories(); // 分类计数随归档变化
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 调整分组：切换条目所属分类；目标与当前相同则仅提示不发请求 */
  async function moveEntry(p: ReqEntry, targetId: string) {
    setMoveOpenId('');
    if (targetId === p.category_id) {
      flash('已在该分组');
      return;
    }
    try {
      await api.patch(`/req-entries/${p.id}`, { categoryId: targetId });
      const cat = categories.find((c) => c.id === targetId);
      flash('已调整至「' + (cat?.name ?? '未分类') + '」分组');
      void loadEntries(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  // 分组选择器：点击外部区域自动收起（仅在打开时挂载监听，避免全局事件常驻）
  useEffect(() => {
    if (!moveOpenId) return;
    const onDocClick = (e: MouseEvent) => {
      if (moveRef.current && !moveRef.current.contains(e.target as Node)) setMoveOpenId('');
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [moveOpenId]);

  // ---- 行级交互回调（S3776/S6847：从 JSX 内联箭头下沉；指针事件统一走 pointer 系列，兼容触屏长按） ----
  const startPress = (id: string, target: EventTarget | null) => {
    if ((target as HTMLElement).closest('button, input, select, a, textarea, label')) return;
    pressTimer.current[id] = globalThis.setTimeout(() => setPressId(id), 200);
  };
  const endPress = (id: string) => {
    clearTimeout(pressTimer.current[id]);
    if (pressId) setPressId('');
  };
  const endPressRow = (id: string) => {
    clearTimeout(pressTimer.current[id]);
    if (pressId === id) setPressId('');
  };
  const rowCls = (id: string) => {
    let cls = 'arena-row';
    if (flashAt[id]) cls += ' flush';
    if (dragId === id) cls += ' item-dragging';
    else if (overId === id) cls += ' item-over';
    if (pressId === id) cls += ' item-pressing';
    return cls;
  };
  const dragStartRow = (id: string, e: React.DragEvent) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; };
  const dragEndRow = () => { setDragId(''); setOverId(''); };
  const dragOverRow = (id: string, e: React.DragEvent) => { e.preventDefault(); if (id !== dragId) setOverId(id); };

  /** 依据当前排序条件对条目排序（不改变原始 state）；置顶项始终排在最前 */
  const sortedEntries = [...entries].sort((a, b) => {
    // 置顶优先：置顶项固定在最前，组内再按用户字段/方向排序
    const pa = Boolean(a.pinned);
    const pb = Boolean(b.pinned);
    if (pa !== pb) return pa ? -1 : 1;
    // 时间字段为 ISO 字符串可直接比较；名称按中文语言规则比较（数字感知）
    if (sortKey === 'manual') {
      const wa = a.sort_weight || 0;
      const wb = b.sort_weight || 0;
      if (wa !== wb) {
        if (wa === 0) return 1;
        if (wb === 0) return -1;
        return wa - wb;
      }
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    }
    const cmp = sortKey === 'title'
      ? a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true })
      : a[sortKey].localeCompare(b[sortKey]);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  /** T03683：显示范围「收藏」= 只看已收藏的行。
   *  收藏视图下禁用拖拽（draggable 判定见列表行）：拖拽提交的 orderedIds 只覆盖子集，
   *  重排语义会作用不到未显示的兄弟条目，容易把权重写得与用户所见不符。 */
  const visibleEntries = viewScope === 'fav' ? sortedEntries.filter((p) => Boolean(p.is_favorited)) : sortedEntries;

  return (
    <section>
      {/* 悬浮操作按钮 + 行 hover 高亮 + 记录高亮动画：类名与任务页体验一致 */}
      <style>{`
        .arena-row { transition: background-color .15s ease, transform .12s ease; }
        /* T00467/T00468：图标按钮 hover 动画 */
        .tbtn-anim svg { transition: transform .18s ease; }
        .tbtn-anim:hover svg { transform: scale(1.2) rotate(8deg); }
        .tbtn-anim:active svg { transform: scale(.88); }
        .arena-row.item-pressing { transform: scale(.985); } /* T00489：仅按住行触发 */
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        /* T00469：操作图标按钮 hover 动效（lucide 图标微缩放反馈） */
        .abtn svg { transition: transform .15s ease; }
        .abtn:hover svg { transform: scale(1.15); }
        .abtn:active svg { transform: scale(.9); }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
        @keyframes rowflush { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
        .arena-row.flush { animation: rowflush 1.4s ease; }
        .item-dragging { opacity: .5; box-shadow: 0 8px 20px rgba(0,0,0,.25); border-color: var(--accent) !important; }
        .item-over { box-shadow: inset 0 3px 0 var(--accent); border-color: var(--accent) !important; }
        .move-btn:hover { color: var(--accent); }
      `}</style>
      {/* 工具栏：分类切换与管理 */}
      <div className="op-host" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={activeCat} aria-label="需求分类筛选" onChange={(e) => setActiveCat(e.target.value)} style={{ padding: 6, fontSize: 'var(--fs-s)', minWidth: 180, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.reqCount ?? 0}）</option>)}
        </select>
        {/* T00510 调整：分类管理三按钮与任务菜单项目按钮组同款——纯图标+边框、同组紧跟下拉、悬浮显示 */}
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => void addCategory()} title="新建分类 — 新增一个通用需求分类" aria-label="新建分类：新增一个通用需求分类"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}>
          <FolderPlus size={13} />
        </button>
        {activeCat && (
          <>
          <button onClick={() => { const c = categories.find((c) => c.id === activeCat); if (c) void renameCategory(c); }}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}
            title="重命名 — 修改当前分类名称" aria-label="重命名：修改当前分类名称">
            <SquarePen size={13} />
          </button>
          <button onClick={() => { const c = categories.find((c) => c.id === activeCat); if (c) void removeCategory(c); }}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', color: 'var(--danger)', background: 'transparent', border: '1px solid var(--danger)', borderRadius: 6, cursor: 'pointer' }}
            title="删除分类 — 删除当前分类及其下通用需求" aria-label="删除分类：删除当前分类及其下通用需求">
            <Trash2 size={13} />
          </button>
          </>
        )}
        </span>
        {activeCat && (
            <button className="tbtn-anim op-hidden" onClick={() => { // T00760：默认隐藏悬浮显示
              const ids = entries.map((x) => x.id);
              const allExpanded = ids.length > 0 && ids.every((id) => expandedIds[id]);
              setExpandedIds(allExpanded ? {} : Object.fromEntries(ids.map((id) => [id, true])));
            }} title={entries.length > 0 && entries.every((x) => expandedIds[x.id]) ? '全部收起 — 收起全部通用需求内容' : '全部展开 — 展开全部通用需求内容'} aria-label="全部展开或收起通用需求内容"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px', borderRadius: 6 }}>
              {entries.length > 0 && entries.every((x) => expandedIds[x.id]) ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
            </button>
        )}
        <button
          onClick={() => { setCreating(!creating); setNewTitle(''); setNewContent(''); }}
          disabled={!activeCat}
          // 无文字纯图标按钮：悬浮提示随状态切换（新建/收起），点击动画由全局 button:active 提供
          // T00760：默认隐藏悬浮显示
          title={creating ? '收起 — 收起新建通用需求表单' : '新建通用需求 — 展开新建通用需求表单'}
          aria-label={creating ? '收起：收起新建通用需求表单' : '新建通用需求：展开新建通用需求表单'}
          className="op-hidden"
          style={{ marginLeft: 12, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', padding: '6px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
        >
          <Plus size={13} />
        </button>
        {/* T00842 位置2「需求标题栏」→ T03185（UX-05⑤）：三个未开放入口改为「可见但禁用 + 范围说明」，
            不再点击后只弹一句「开发中」 */}
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <NotOpenButton label="AI 美化" scope="polishTitle" icon={<Sparkles size={13} />}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6 }} />
          <NotOpenButton label="AI 简化" scope="summarizeTitle" icon={<Minimize2 size={13} />}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6 }} />
          {/* T03685：工具条「归档」由未开放占位转为真实入口——进入归档管理页（还原/彻底删除都在那里），
              行内归档按钮负责把条目送进来，两者构成完整闭环 */}
          <button className="tbtn-anim" data-t03685="archive-hub"
            onClick={() => { focusSettingsTab('archive'); applyDeepLink({ projectId: '', tab: 'settings' }); }}
            title="归档管理 — 打开「设置 → 归档」查看并还原/彻底删除已归档的通用需求"
            aria-label="归档管理：打开归档管理页"
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}>
            <Archive size={13} />
          </button>
        </span>
        {/* T03683：显示范围（全部显示 / 收藏）——与提示词页同位置同口径的筛选控件 */}
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <select
            data-t03683="view-scope"
            value={viewScope}
            onChange={(e) => setViewScope(e.target.value as 'all' | 'fav')}
            title="显示范围 — 全部通用需求或只看已收藏"
            aria-label="显示范围：选择显示全部通用需求还是只看已收藏"
            style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}
          >
            <option value="all">全部显示</option>
            <option value="fav">收藏</option>
          </select>
        </span>
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as 'updated_at' | 'created_at' | 'title')}
          title="排序字段" aria-label="排序字段"
          style={{ padding: 6, fontSize: 'var(--fs-s)' }}
        >
          <option value="manual">手动排序</option>
          <option value="updated_at">更新时间</option>
          <option value="created_at">创建时间</option>
          <option value="title">名称</option>
        </select>
        </span>
        </span>
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <select
          value={sortDir}
          onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
          title="排序方式" aria-label="排序方式"
          style={{ padding: 6, fontSize: 'var(--fs-s)' }}
        >
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
        </span>
        </span>
        <input
          className="op-hidden" // T00893：搜索框对齐其它工具栏控件的「默认隐藏、悬浮宿主区显示」约定
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="搜索需求（标题或内容）" placeholder="搜索标题/内容…" data-page-search
          style={{ padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-s)', marginLeft: 'auto' }}
        />
        {notice && <output className="flash-toast">{notice}</output>}
      </div>

      {/* 新建条目表单 */}
      {creating && (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <input
            value={newTitle}
            aria-label="新需求的标题"
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="通用需求标题"
            style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)', boxSizing: 'border-box', marginBottom: 8 }}
          />
          <textarea
            value={newContent}
            aria-label="新需求的内容"
            onChange={(e) => setNewContent(e.target.value)}
            rows={6}
            placeholder="通用需求内容（描述该优秀实现/解决方案，可用 {占位符} 标记使用时需替换的部分）"
            style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-m)', boxSizing: 'border-box', fontFamily: 'inherit' }}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            {/* T00796 二轮：新建内容接入正文美化（工具缺省时自动取模型管理首个已配置工具） */}
            <AiPolishButton
              value={newContent}
              onPolished={setNewContent}
              flash={flash}
              title="AI 美化 — 润色这段通用需求正文（保留全部实现要点，仅规范表达），结果回填后请核对再保存"
            />
            <button
              onClick={() => void createEntry()}
              disabled={!newTitle.trim()}
              title="保存 — 创建这条通用需求"
              aria-label="保存：创建这条通用需求"
              style={{ background: 'var(--success)', color: 'var(--on-solid)', border: 'none', padding: '6px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            >
              <Save size={13} />
            </button>
            <button onClick={() => setCreating(false)} title="取消 — 放弃新建并收起表单" aria-label="取消：放弃新建并收起表单"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
              <X size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            </button>
          </div>
        </div>
      )}

      {/* 条目列表 */}
      {visibleEntries.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          {categories.length === 0
            ? '暂无分类，请先新建分类。'
            : viewScope === 'fav' && sortedEntries.length > 0
              // T03683：收藏视图空态要说清「不是没数据，是没收藏」，避免被读成数据丢失
              ? `该分类下有 ${sortedEntries.length} 条通用需求，但都未收藏 —— 点标题左侧星标加入收藏，或把「显示范围」切回「全部显示」。`
              : '该分类下暂无通用需求。'}
        </p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {visibleEntries.map((p) => {
          const draft = drafts[p.id];
          const editing = draft !== undefined;
          return (
            <li key={flashAt[p.id] ? `f${flashAt[p.id]}-${p.id}` : p.id}
              onPointerDown={(e) => startPress(p.id, e.target)}
              onPointerUp={() => endPress(p.id)}
              onPointerLeave={() => endPressRow(p.id)}
              draggable={sortKey === 'manual' && viewScope !== 'fav'} // T03683：收藏视图（子集）下禁用拖拽重排
              onDragStart={(e) => dragStartRow(p.id, e)}
              onDragEnd={dragEndRow}
              onDragOver={(e) => dragOverRow(p.id, e)}
              onDrop={(e) => { e.preventDefault(); dropReorder(p.id); }}
              className={rowCls(p.id)}
              style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10, cursor: 'grab' }}>
              {editing ? (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      value={draft.title}
                      aria-label="编辑需求标题"
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: { ...draft, title: e.target.value } }))}
                      style={{ flex: 1, padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)' }}
                    />
                    <select
                      value={draft.categoryId}
                      aria-label="编辑需求分类"
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: { ...draft, categoryId: e.target.value } }))}
                      style={{ padding: 6 }}
                    >
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <textarea
                    value={draft.content}
                    aria-label="编辑需求内容"
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: { ...draft, content: e.target.value } }))}
                    rows={6}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-m)', boxSizing: 'border-box', fontFamily: 'inherit' }}
                  />
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    {/* T00796 二轮：编辑态同样接入正文美化，结果只回填草稿不直接落库 */}
                    <AiPolishButton
                      value={draft.content}
                      onPolished={(text) => setDrafts((prev) => ({ ...prev, [p.id]: { ...draft, content: text } }))}
                      flash={flash}
                      title="AI 美化 — 润色这段通用需求正文（保留全部实现要点，仅规范表达），结果回填后请核对再保存"
                    />
                    {/* T00842 二轮：编辑态详情输入框下方「提示词优化」——把正文改写为结构化提示词，功能对齐任务菜单同名操作。
                        T03684：给出 storeKey 后结果由本页挂载时排干落进 drafts，不再经当场回填闭包 */}
                    <PromptOptimizeButton
                      title={draft.title}
                      content={draft.content}
                      storeKey={p.id}
                      flash={flash}
                    />
                    <button onClick={() => void saveDraft(p)} disabled={!draft.title.trim()} style={{ fontSize: 'var(--fs-s)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="保存 — 保存对这条通用需求的修改" aria-label="保存：保存对这条通用需求的修改">
                      <Save size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    <button onClick={() => setDrafts((prev) => {
                      const next = { ...prev };
                      delete next[p.id];
                      return next;
                    })} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }} title="取消 — 放弃编辑修改"
                      aria-label="取消：放弃编辑修改">
                      <X size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* T00494 调整：去掉拖拽把手图标（整行即可拖拽） */}
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* 标题可点击，切换内容展开/收起（默认收起，降低信息密度） */}
                    {/* T02146：置顶图标提到标题按钮的**兄弟位**——HTML 不允许 button 套 button
                        （dev React 报 validateDOMNesting，生产构建只是剥掉告警，DOM 依旧非法）。
                        PinToggle 自带 stopPropagation，提到外面后「置顶」与「展开」互不干扰的行为不变，
                        视觉位置仍是标题左侧。 */}
                    {/* T03683：收藏星标与置顶图标并列标题左侧（同 T02146 约束：button 不能套 button），
                        星标在前；两者都自带 stopPropagation，与「展开/收起」互不干扰 */}
                    <FavoriteToggle favorited={Boolean(p.is_favorited)} onToggle={() => void toggleFavorite(p)} />
                    <PinToggle pinned={Boolean(p.pinned)} onToggle={() => void togglePin(p)} />
                    <button
                      onClick={() => setExpandedIds((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                      title={expandedIds[p.id] ? '点击收起通用需求内容' : '点击展开通用需求内容'}
                      aria-label={expandedIds[p.id] ? '收起：收起通用需求内容' : '展开：展开通用需求内容'}
                      className="row-title-btn"
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', minWidth: 0 }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 'var(--fs-l)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' , color: p.color || undefined }}>{p.title}</span>
                      {/* 展开/收起箭头：与任务页统一使用 lucide 图标，蓝色 13px */}
                      <span style={{ color: 'var(--accent)', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>{expandedIds[p.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
                    </button>
                    <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flexShrink: 0 }} title={`更新于 ${p.updated_at}`}>{relTime(p.updated_at)}</span>
                    <span className="abtn" style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <FontColorButton current={p.color ?? ''} onApply={(c) => { void api.patch(`/req-entries/${p.id}`, { color: c }).then(() => { void loadEntries(activeCat, search); }); }} />
                    </span>
                    <CopyButton getText={() => p.title + (p.content ? '\n' + p.content : '')} title="复制 — 复制通用需求内容到剪贴板" ariaLabel="复制：复制通用需求内容" />
                    {/* T00436：复制到待办任务 — 转成收件箱项目的待办，悬浮提示按任务规格 */}
                    <button className="abtn" onClick={() => void copyToTask(p)} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="复制到待办任务 — 以该通用需求创建一条待办任务（收件箱项目）" aria-label="复制到待办任务">
                      <ListTodo size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    {/* T00456 / PRD INT-5：转计划 — 把通用需求转为目标项目的计划任务（T03185 改为项目下拉选择） */}
                    <button className="abtn" onClick={() => toPlan(p)} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="转计划 — 把该通用需求转为目标项目的计划任务（下拉选择项目）" aria-label="转计划：转为目标项目的计划任务">
                      <CalendarRange size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    <button
                      className="abtn"
                      onClick={() => setDrafts((prev) => ({ ...prev, [p.id]: { title: p.title, content: p.content, categoryId: p.category_id } }))}
                      style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="编辑 — 编辑这条通用需求" aria-label="编辑：编辑这条通用需求"
                    >
                      <Pencil size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    {/* 调整分组：行内浮层选择器，打开后点外部收起；当前分组高亮并标注（当前） */}
                    <div ref={moveOpenId === p.id ? moveRef : undefined} style={{ position: 'relative', display: 'inline-flex' }}>
                      <button className="abtn move-btn" onClick={() => setMoveOpenId(moveOpenId === p.id ? '' : p.id)}
                        title="调整分组 — 移动该通用需求到其他分组" aria-label="调整分组：移动该通用需求到其他分组"
                        style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
                        <FolderInput size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                      </button>
                      {moveOpenId === p.id && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.12)', padding: 4, zIndex: 10, minWidth: 140 }}>
                          {categories.map((c) => (
                            <button key={c.id} onClick={() => void moveEntry(p, c.id)}
                              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', fontSize: 'var(--fs-s)', borderRadius: 4, background: 'transparent', color: c.id === p.category_id ? 'var(--accent)' : 'var(--text)' }}>
                              {c.name}{c.id === p.category_id ? '（当前）' : ''}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* T00842 位置1「通用需求菜单」→ T03185（UX-05⑤）：同上，未开放入口不再做成能点的占位按钮 */}
                    <NotOpenButton className="abtn" label="AI 美化" scope="polishTitle" icon={<Sparkles size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
                      style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }} />
                    <NotOpenButton className="abtn" label="AI 简化" scope="summarizeTitle" icon={<Minimize2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
                      style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }} />
                    {/* T03685：归档由「未开放」转真实可用——需求侧补齐 archived/archived_at 列后，
                        与提示词页 T00525 同语义（软删、可在归档管理页还原） */}
                    <button className="abtn" data-t03685="archive-entry" onClick={() => void archiveEntry(p)}
                      style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="归档 — 归档这条通用需求（数据保留，列表不再显示，可在「设置 → 归档」还原）" aria-label="归档：归档这条通用需求">
                      <Archive size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    <button className="abtn" onClick={() => void removeEntry(p)} style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="删除 — 删除这条通用需求" aria-label="删除：删除这条通用需求">
                      <Trash2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                  </div>
                  {expandedIds[p.id] && (
                    // MarkdownContent 默认渲染富文本、可切源码视图，右上角切换/复制按钮悬浮于内容之上
                    <div style={{ marginTop: 6 }}>
                      <MarkdownContent content={p.content} showCopy />
                      {/* T00842 位置4「详细信息框下方」：展示区为只读，点击进入编辑态可对正文做提示词优化 */}
                      <div style={{ marginTop: 6, display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button onClick={() => {
                          // 编辑态继承当前已存的数据，进入后下方出现真实优化按钮可改写正文
                          setDrafts((prev) => (prev[p.id] ? prev : { ...prev, [p.id]: { title: p.title, content: p.content, categoryId: p.category_id } }));
                        }} className="abtn"
                          title="提示词优化 — 进入编辑并把需求内容改写为结构化提示词" aria-label="提示词优化：把需求内容改写为结构化提示词"
                          style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
                          <Wand2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>

      {/* T00629：复制到待办任务——目标项目选择弹窗（与提示词页一致） */}
      {taskCopyEntry && (
        <div /* NOSONAR - 遮罩点击为鼠标便捷关闭，取消按钮提供键盘可达通路 */
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget && !taskCopyBusy) setTaskCopyEntry(null); }}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(420px, 92vw)', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-m)', fontWeight: 600 }}>
              <ListTodo size={14} style={{ color: 'var(--accent)' }} /> 复制到待办任务
              <span style={{ flex: 1 }} />
              <button onClick={() => setTaskCopyEntry(null)} disabled={taskCopyBusy} title="关闭" aria-label="关闭复制到待办弹窗"
                style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 'var(--fs-l)', cursor: taskCopyBusy ? 'default' : 'pointer' }}>×</button>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 'var(--fs-s)' }}>
              <div style={{ color: 'var(--text-muted)' }}>
                将通用需求「<strong style={{ color: 'var(--text)' }}>{taskCopyEntry.title}</strong>」复制为一条**待办任务**（内容写入任务描述，不改动需求本身）。
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>目标项目</div>
                <select value={taskCopyProjectId} onChange={(e) => setTaskCopyProjectId(e.target.value)} disabled={taskCopyBusy}
                  aria-label="目标项目" title="选择待办任务落到哪个项目"
                  style={{ width: '100%', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
                  <option value="">默认记事项目（收件箱）</option>
                  {projects.map((pj) => <option key={pj.id} value={pj.id}>{pj.name}</option>)}
                </select>
                <div style={{ marginTop: 4 }}>
                  <ProjectListHint view={projectList} />
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                  目标项目若已存在同标题待办，将自动复用（不重复创建）。
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setTaskCopyEntry(null)} disabled={taskCopyBusy} className="tbtn-anim"
                style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>取消</button>
              <button onClick={() => void confirmCopyToTask()} disabled={taskCopyBusy} className="tbtn-anim"
                title="确认复制到所选项目的待办任务" aria-label="确认复制到待办"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: taskCopyBusy ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)' }}>
                {taskCopyBusy ? <><Loader2 size={12} className="aispin" />复制中…</> : '复制到待办'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* T03185（UX-05①②③④）：转计划的目标项目选择弹窗——下拉携带 ID，默认项目合法即可直接提交 */}
      {planEntry && (
        <div /* NOSONAR - 遮罩点击为鼠标便捷关闭，取消按钮提供键盘可达通路 */
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget && !planBusy) setPlanEntry(null); }}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(420px, 92vw)', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-m)', fontWeight: 600 }}>
              <CalendarRange size={14} style={{ color: 'var(--accent)' }} /> 转计划 — 选择目标项目
              <span style={{ flex: 1 }} />
              <button onClick={() => setPlanEntry(null)} disabled={planBusy} title="关闭" aria-label="关闭转计划弹窗"
                style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 'var(--fs-l)', cursor: planBusy ? 'default' : 'pointer' }}>×</button>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 'var(--fs-s)' }}>
              <div style={{ color: 'var(--text-muted)' }}>
                将通用需求「<strong style={{ color: 'var(--text)' }}>{planEntry.title}</strong>」转为所选项目的计划任务（追加到计划尾部自动排期，不改动需求本身）。
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>目标项目</div>
                <select value={planProjectId} onChange={(e) => setPlanProjectId(e.target.value)} disabled={planBusy}
                  aria-label="目标项目" title="选择计划任务落到哪个项目"
                  style={{ width: '100%', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
                  <option value="">{projectListPlaceholder(projectList, '请选择所属项目')}</option>
                  {projects.map((pj) => <option key={pj.id} value={pj.id}>{pj.name}</option>)}
                </select>
                <div style={{ marginTop: 4 }}>
                  <ProjectListHint view={projectList} />
                </div>
                {/* UX-05③：没有可选项目时给出口，而不是让提交按钮静默失败 */}
                {projectList.phase === 'ready' && projects.length === 0 && (
                  <div role="status" data-t03185="no-project" style={{ marginTop: 6, color: 'var(--danger)' }}>
                    请选择/创建所属项目 —— 当前没有可用项目，请先到「项目管理」或「任务」菜单新建项目，再回来转计划。
                  </div>
                )}
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                  同名项目按 ID 区分，不会串单；若该需求已转过，会提示重复而不是再生成一条。
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setPlanEntry(null)} disabled={planBusy} className="tbtn-anim"
                style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>取消</button>
              <button onClick={() => void confirmToPlan()} disabled={planBusy || !planProjectId} className="tbtn-anim"
                title={planProjectId ? '确认转为所选项目的计划任务' : '请先选择所属项目'}
                aria-label={planProjectId ? '确认转计划' : '确认转计划（需先选择项目）'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: (planBusy || !planProjectId) ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)' }}>
                {planBusy ? <><Loader2 size={12} className="aispin" />转计划中…</> : '转为计划'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}