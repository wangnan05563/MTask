import { useEffect, useMemo, useState } from 'react';
import { api, type Prompt, type PromptCategory, type Task, type TaskCategory } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Check, ListChecks, Search, Trash2, Undo2, X } from 'lucide-react';
import { relTime } from '../ui/format';
import { useSessionState, usePersistentState } from '../ui/session';
import { ProjectListHint, useProjectList } from '../ui/projectList'; // T02201：项目列表取数容错层
import { ResourceHint, useResource } from '../ui/resourceState'; // T02284：分页列表取数走同一可见失败态层

/** 项目计划归档条目（T00442 扩展：计划「删除」改归档后，在此恢复或彻底删除） */
interface ArchivedPlan {
  id: string;
  project_id: string;
  title: string;
  status: string;
  archived_at: string | null;
  project_name: string;
}

/** T02284：服务端分页信封（与 server/src/util/list-page.ts 的 Paged 同形状，由 `total=1` 加性通道返回） */
interface Paged<T> {
  items: T[];
  total: number;
}

// T02258：每页条数选择器档位；默认 20 与既有分页默认一致
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

/**
 * T02284：越界页码收敛。服务端分页后 total 会随操作变化（如批量删完整末页），
 * 停在越界页会得到「0 条 / 第 N 页」的空页——拉回最后一页由调用方的取数 effect 再取一次。
 */
function clampPage(total: number | undefined, page: number, pageSize: number, set: (n: number) => void): void {
  if (total == null) return;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page > pages) set(pages);
}

/**
 * T02284：「全选本页」的页域切换。
 * 服务端分页后选中集跨页保留，故全选/取消只作用于本页 id，其他页的已选原样保留
 * （旧实现 `prev.length === pageTasks.length ? [] : …` 在跨页场景会把别的页一并清空）。
 */
function togglePageSelection(prev: string[], pageIds: string[]): string[] {
  const onPage = new Set(pageIds);
  const others = prev.filter((id) => !onPage.has(id));
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => prev.includes(id));
  return allOnPage ? others : [...others, ...pageIds];
}

/** 彻底删除计划的连带影响（T01874，DELETE /plans/:id 与 /plans/:id/purge-impact 同口径） */
interface PurgeImpact {
  strippedTasksArchived: number;
  strippedReqLinks: number;
}

/** T01874：计划删除不可逆（物理删行），其派生待办会被一并归档、矩阵「已关联计划」会少一条——
 *  条数必须在点「确定」之前看见，不再是删完才发现的静默变化。 */
function purgeImpactText(i: PurgeImpact | null): string {
  if (!i) return '';
  const parts: string[] = [];
  if (i.strippedTasksArchived > 0) parts.push(`其派生待办 ${i.strippedTasksArchived} 条将一并归档（数据不删，可在本页「归档任务」区还原）`);
  if (i.strippedReqLinks > 0) parts.push(`需求矩阵中 ${i.strippedReqLinks} 条需求的「已关联计划」将失去该计划`);
  return parts.length > 0 ? `\n连带影响：${parts.join('；')}。` : '\n连带影响：无（该计划没有派生待办，也没有需求关联）。';
}

/**
 * 归档管理页（T00442 扩展 / T00586）：任务与计划两个归档区。
 * T00586：参考项目计划页——多选 + 批量工具条（风格/布局一致）+ 搜索 + 分类/项目查询 + 分页。
 */
export function ArchivePage() {
  // 项目 id -> 名称 映射，用于标注归档任务所属项目（任务本身只带 project_id）
  // T02201：改由统一容错层派生——取数失败不再让整页 load() 抛断（原先项目名缺失会让归档列表显示「未知项目」）
  const projectList = useProjectList();
  const projectNames = useMemo(
    () => Object.fromEntries(projectList.projects.map((p) => [p.id, p.name])),
    [projectList.projects],
  );
  // 引用数据（下拉/名称映射，非分页列表）：任务分类、提示词分类名
  const [cats, setCats] = useState<TaskCategory[]>([]);
  const [promptCatNames, setPromptCatNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  // T00586：多选模式 + 搜索 + 分类/项目筛选 + 分页（会话级保持，切页不丢）
  const [multi, setMulti] = useSessionState<boolean>('archive.multi', false);
  const [selTaskIds, setSelTaskIds] = useSessionState<string[]>('archive.selTasks', []);
  const [selPlanIds, setSelPlanIds] = useSessionState<string[]>('archive.selPlans', []);
  const [kw, setKw] = useSessionState<string>('archive.kw', '');
  const [catFilter, setCatFilter] = useSessionState<string>('archive.catFilter', '');
  const [projFilter, setProjFilter] = useSessionState<string>('archive.projFilter', '');
  const [page, setPage] = useState(1);
  const [planPage, setPlanPage] = useState(1);
  const [promptPage, setPromptPage] = useState(1); // T00872：归档提示词分页页脚
  // T02258：每页条数——三个列表区共用一值；localStorage 持久化，刷新后保持上次选择。
  // 存储值做档位白名单收敛：localStorage 被手工改脏（如 999）时回退默认档，不出现异常页长
  const [pageSizeStored, setPageSize] = usePersistentState<number>('archive.pageSize', DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSizeStored) ? pageSizeStored : DEFAULT_PAGE_SIZE;

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  // T02284：筛选/关键词下推服务端后不再逐字符打接口——300ms 防抖（与移动端归档视图 T01442 同口径）
  const [kwQuery, setKwQuery] = useState(() => kw.trim());
  useEffect(() => {
    const next = kw.trim();
    if (next === kwQuery) return;
    const t = setTimeout(() => setKwQuery(next), 300);
    return () => clearTimeout(t);
  }, [kw, kwQuery]);

  // T02284：三个归档列表切**服务端分页**——limit/offset + 关键词/分类/项目全部走查询参数，
  // 不再一次拉 500 条本地过滤。取数复用 T02213 的 useResource：请求令牌防竞态（迟到的上一轮响应
  // 不覆盖新一轮，等价于移动端归档视图的 seqRef）、失败保留上次数据并给出原因与重试入口。
  const tasksView = useResource<Paged<Task>>(async () => {
    const q = new URLSearchParams({ archived: '1', total: '1', limit: String(pageSize), offset: String((page - 1) * pageSize) });
    if (kwQuery) q.set('keyword', kwQuery);
    if (catFilter) q.set('categoryId', catFilter);
    return api.get<Paged<Task>>(`/tasks?${q.toString()}`);
  }, { enabled: false });
  const plansView = useResource<Paged<ArchivedPlan>>(async () => {
    const q = new URLSearchParams({ total: '1', limit: String(pageSize), offset: String((planPage - 1) * pageSize) });
    if (kwQuery) q.set('keyword', kwQuery);
    if (projFilter) q.set('projectId', projFilter);
    return api.get<Paged<ArchivedPlan>>(`/plans/archived?${q.toString()}`);
  }, { enabled: false });
  const promptsView = useResource<Paged<Prompt>>(async () => {
    const q = new URLSearchParams({ archived: '1', total: '1', limit: String(pageSize), offset: String((promptPage - 1) * pageSize) });
    if (kwQuery) q.set('keyword', kwQuery);
    return api.get<Paged<Prompt>>(`/prompts?${q.toString()}`);
  }, { enabled: false });

  // 引用数据只在挂载时取一次（失败沿用旧口径静默降级：仅影响名称显示，不影响列表数据）
  useEffect(() => {
    // T01722 修复：端点误写为 /tasks/categories（404 被吞、归档任务分类名恒缺失）——与 TasksPage 同口径走 /task-categories
    void api.get<TaskCategory[]>('/task-categories').then(setCats).catch(() => { /* 旧版后端忽略 */ });
    // T00872：归档提示词的分类名映射（/prompts?archived=1 返回软删数据，可在此还原/彻底删除）
    void api.get<PromptCategory[]>('/prompt-categories')
      .then((pcs) => setPromptCatNames(Object.fromEntries(pcs.map((c) => [c.id, c.name]))))
      .catch(() => { /* 旧版后端忽略 */ });
  }, []);

  // 首屏与「页码 / 每页条数 / 关键词 / 筛选」变化时重取**当前页**（enabled:false 关掉挂载自跑，统一由这里触发）
  useEffect(() => { tasksView.reload(); }, [page, pageSize, kwQuery, catFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { plansView.reload(); }, [planPage, pageSize, kwQuery, projFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { promptsView.reload(); }, [promptPage, pageSize, kwQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // T02258：切换条数后各列表重置到第 1 页
  useEffect(() => { setPage(1); setPlanPage(1); setPromptPage(1); }, [pageSize]);

  // T02284：写操作后 total 变化 → 越界页码收敛到最后一页（避免停在空页）
  useEffect(() => { clampPage(tasksView.data?.total, page, pageSize, setPage); }, [tasksView.data, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { clampPage(plansView.data?.total, planPage, pageSize, setPlanPage); }, [plansView.data, planPage, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { clampPage(promptsView.data?.total, promptPage, pageSize, setPromptPage); }, [promptsView.data, promptPage, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 派生视图数据（T02284：条数/页数由服务端 total 派生，不再本地过滤） ----------

  const pageTasks = tasksView.data?.items ?? [];
  const pagePlans = plansView.data?.items ?? [];
  const pagePrompts = promptsView.data?.items ?? [];
  const taskTotal = tasksView.data?.total ?? 0;
  const planTotal = plansView.data?.total ?? 0;
  const promptTotal = promptsView.data?.total ?? 0;
  const taskPages = Math.max(1, Math.ceil(taskTotal / pageSize));
  const planPages = Math.max(1, Math.ceil(planTotal / pageSize));
  const promptPages = Math.max(1, Math.ceil(promptTotal / pageSize));
  const curTaskPage = Math.min(page, taskPages);
  const curPlanPage = Math.min(planPage, planPages);
  const curPromptPage = Math.min(promptPage, promptPages);

  // ---------- 单条操作（T02284：只刷新所属列表的当前页，不再整页三端点全量重拉） ----------

  async function restore(task: Task) {
    await api.post('/archive/restore', { taskIds: [task.id] });
    tasksView.reload();
  }

  async function remove(task: Task) {
    const ok = await askConfirm(`确认永久删除任务「${task.title}」？此操作不可恢复。`);
    if (!ok) return;
    await api.del('/archive', { taskIds: [task.id] });
    tasksView.reload();
  }

  async function restorePlan(p: ArchivedPlan) {
    await api.post(`/plans/${p.id}/restore`);
    plansView.reload();
  }

  async function purgePlan(p: ArchivedPlan) {
    // T01874：先取连带影响再弹确认（预览失败退回原文案，不阻塞删除）
    const impact = await api.get<PurgeImpact>(`/plans/${p.id}/purge-impact`).catch(() => null);
    const ok = await askConfirm(`确认彻底删除计划「${p.title}」？此操作不可恢复（归档后仅剩此副本）。${purgeImpactText(impact)}`);
    if (!ok) return;
    const r = await api.del<{ deleted: boolean } & PurgeImpact>(`/plans/${p.id}`);
    if (r.deleted && r.strippedTasksArchived > 0) flash(`已彻底删除计划「${p.title}」，连带归档 ${r.strippedTasksArchived} 条派生待办`);
    plansView.reload();
    // 彻底删除计划会连带归档其派生待办——归档任务区的数据确实变了，一并只刷当前页
    if (r.deleted && r.strippedTasksArchived > 0) tasksView.reload();
  }

  // T00872：归档提示词还原（PATCH archived=false）与彻底删除（DELETE /prompts/:id）
  async function restorePrompt(p: Prompt) {
    await api.patch(`/prompts/${p.id}`, { archived: false });
    promptsView.reload();
  }

  async function removePrompt(p: Prompt) {
    const ok = await askConfirm(`确认彻底删除提示词「${p.title}」？此操作不可恢复。`);
    if (!ok) return;
    await api.del(`/prompts/${p.id}`);
    promptsView.reload();
  }

  // ---------- T00586：批量操作（参考计划页批量工具条） ----------

  function toggleTask(id: string) {
    setSelTaskIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function togglePlan(id: string) {
    setSelPlanIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function selectAllTasks() {
    setSelTaskIds((prev) => togglePageSelection(prev, pageTasks.map((t) => t.id)));
  }
  function selectAllPlans() {
    setSelPlanIds((prev) => togglePageSelection(prev, pagePlans.map((p) => p.id)));
  }

  async function batchRestoreTasks() {
    if (selTaskIds.length === 0) return;
    setBusy(true);
    try {
      await api.post('/archive/restore', { taskIds: selTaskIds });
      flash(`已还原 ${selTaskIds.length} 条归档任务`);
      setSelTaskIds([]);
      tasksView.reload();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function batchPurgeTasks() {
    if (selTaskIds.length === 0) return;
    if (!(await askConfirm(`永久删除选中的 ${selTaskIds.length} 条归档任务？此操作不可恢复。`))) return;
    setBusy(true);
    try {
      await api.del('/archive', { taskIds: selTaskIds });
      flash(`已永久删除 ${selTaskIds.length} 条任务`);
      setSelTaskIds([]);
      tasksView.reload();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function batchRestorePlans() {
    if (selPlanIds.length === 0) return;
    setBusy(true);
    let n = 0;
    try {
      for (const id of selPlanIds) {
        try { await api.post(`/plans/${id}/restore`); n += 1; } catch { /* 单条失败继续 */ }
      }
      flash(`已恢复 ${n} 条归档计划`);
      setSelPlanIds([]);
      plansView.reload();
    } finally { setBusy(false); }
  }

  async function batchPurgePlans() {
    if (selPlanIds.length === 0) return;
    // T01874：批量删除前合计各条的连带影响（单条预览失败按 0 计，不阻塞批量操作）
    const impacts = await Promise.all(selPlanIds.map((id) => api.get<PurgeImpact>(`/plans/${id}/purge-impact`).catch(() => null)));
    const sum = (pick: (i: PurgeImpact) => number) => impacts.reduce((n, i) => n + (i ? pick(i) : 0), 0);
    const preview: PurgeImpact = { strippedTasksArchived: sum((i) => i.strippedTasksArchived), strippedReqLinks: sum((i) => i.strippedReqLinks) };
    if (!(await askConfirm(`彻底删除选中的 ${selPlanIds.length} 条归档计划？此操作不可恢复。${purgeImpactText(preview)}`))) return;
    setBusy(true);
    let n = 0;
    let strippedTasks = 0;
    try {
      for (const id of selPlanIds) {
        try {
          const r = await api.del<{ deleted: boolean; strippedTasksArchived: number }>(`/plans/${id}`);
          if (r.deleted) { n += 1; strippedTasks += r.strippedTasksArchived; }
        } catch { /* 单条失败继续 */ }
      }
      // S4624：内层模板先赋值再插值，文案逐字不变
      const strippedNote = strippedTasks > 0 ? `，连带归档 ${strippedTasks} 条派生待办` : '';
      flash(`已彻底删除 ${n} 条计划${strippedNote}`);
      setSelPlanIds([]);
      plansView.reload();
      // 同 purgePlan：连带归档了派生待办，归档任务区也要重取当前页
      if (strippedTasks > 0) tasksView.reload();
    } finally { setBusy(false); }
  }

  /** 批量工具条（T00586）：风格与计划页一致——accent 边框 + 已选计数 + 纯图标按钮 */
  function renderBatchBar(kind: 'task' | 'plan') {
    const ids = kind === 'task' ? selTaskIds : selPlanIds;
    if (ids.length === 0) return null;
    // S3358：将嵌套三元拆为独立变量，避免嵌套条件表达式
    const pageIds = (kind === 'task' ? pageTasks : pagePlans).map((x) => x.id);
    const onPage = pageIds.filter((id) => ids.includes(id)).length;
    const selectAllTitle = pageIds.length > 0 && onPage === pageIds.length ? '取消全选本页' : '全选本页';
    // T02284：跨页选中保留——计数显式标注「含其他页 N 条」，避免「已选 25 条」被误读成本页全选
    const offPage = ids.length - onPage;
    const offPageNote = offPage > 0 ? `（含其他页 ${offPage} 条）` : '';
    return (
      <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 10px', margin: '8px 0', borderRadius: 8, background: 'var(--card-bg)', border: '1px solid var(--accent)', boxShadow: '0 4px 12px rgba(0,0,0,.12)', fontSize: 'var(--fs-s)' }}>
        <strong style={{ color: 'var(--accent)' }}>已选 {ids.length} 条{offPageNote}</strong>
        <button onClick={kind === 'task' ? selectAllTasks : selectAllPlans} disabled={busy} className="tbtn-anim"
          title={selectAllTitle}
          aria-label="全选本页"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text)' }}>
          <ListChecks size={14} />
        </button>
        <button onClick={() => void (kind === 'task' ? batchRestoreTasks() : batchRestorePlans())} disabled={busy} className="tbtn-anim"
          title="批量还原 — 将选中条目还原到原列表" aria-label="批量还原"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--accent)' }}>
          <Undo2 size={14} />
        </button>
        <button onClick={() => void (kind === 'task' ? batchPurgeTasks() : batchPurgePlans())} disabled={busy} className="tbtn-anim"
          title="批量彻底删除 — 不可恢复" aria-label="批量彻底删除"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--danger)' }}>
          <Trash2 size={14} />
        </button>
        <button onClick={() => (kind === 'task' ? setSelTaskIds([]) : setSelPlanIds([]))} disabled={busy} className="tbtn-anim"
          title="取消选择" aria-label="取消选择"
          style={{ cursor: 'pointer', padding: '2px 4px', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text)' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  /** 分页控件（T00586；T02258：右侧附「每页条数」选择器——切换立即生效并回到第 1 页，窄屏随行换行不遮挡） */
  function renderPager(cur: number, total: number, set: (n: number) => void, listLabel: string) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 'var(--fs-s)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <button onClick={() => set(Math.max(1, cur - 1))} disabled={cur <= 1} className="tbtn-anim"
          title="上一页" aria-label="上一页"
          style={{ cursor: cur <= 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: cur <= 1 ? 0.5 : 1 }}>上一页</button>
        <span>第 {cur} / {total} 页</span>
        <button onClick={() => set(Math.min(total, cur + 1))} disabled={cur >= total} className="tbtn-anim"
          title="下一页" aria-label="下一页"
          style={{ cursor: cur >= total ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: cur >= total ? 0.5 : 1 }}>下一页</button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          每页
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
            title={`每页条数（${listLabel}）— 切换后立即生效并回到第 1 页`} aria-label={`每页条数（${listLabel}）`}
            style={{ padding: '2px 4px', fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
            {PAGE_SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          条
        </label>
      </div>
    );
  }

  return (
    <section>
      {/* 悬浮操作按钮 + 行 hover 高亮 + 相对时间：类名与任务页体验一致，聚焦当前行减少视觉噪音 */}
      <style>{`
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
      `}</style>

      {notice && <div style={{ position: 'fixed', top: 12, right: 16, zIndex: 200, padding: '6px 12px', borderRadius: 6, background: 'var(--card-bg)', border: '1px solid var(--accent)', fontSize: 'var(--fs-s)', color: 'var(--text)' }}>{notice}</div>}

      {/* T00586：顶部工具区——多选开关 + 搜索 + 分类/项目筛选（对齐计划页工具栏风格） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ fontSize: 'var(--fs-xl)', margin: 0 }}>归档管理</h3>
        <span style={{ flex: 1 }} />
        {/* 多选模式（参考计划页：ListChecks/Check 图标切换） */}
        <button onClick={() => { setMulti((m) => !m); setSelTaskIds([]); setSelPlanIds([]); }}
          className="tbtn-anim"
          title={multi ? '退出多选模式' : '多选模式 — 勾选归档条目后批量还原/删除'}
          aria-label={multi ? '退出多选模式' : '进入多选模式'}
          style={{ fontSize: 'var(--fs-s)', padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', border: '1px solid var(--border-strong)', background: multi ? 'var(--accent)' : 'transparent', color: multi ? 'var(--accent-text)' : 'var(--text)' }}>
          {multi ? <Check size={13} /> : <ListChecks size={13} />}
        </button>
        {/* 搜索（标题/编号/项目名） */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 8px', background: 'var(--card-bg)' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input value={kw} onChange={(e) => { setKw(e.target.value); setPage(1); setPlanPage(1); setPromptPage(1); }}
            placeholder="搜索归档标题…" aria-label="搜索归档内容" data-page-search
            style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', width: 150 }} />
          {kw && <button onClick={() => setKw('')} title="清除搜索" aria-label="清除搜索" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}><X size={12} /></button>}
        </span>
      </div>

      {/* T02284：条数来自服务端 total（跨全部页），不再是本地过滤后的长度；500 条截断警告随服务端分页撤销 */}
      <h4 style={{ fontSize: 'var(--fs-l)', margin: '0 0 8px' }}>归档任务（共 {taskTotal} 条）</h4>
      <ResourceHint view={tasksView} label="归档任务列表" />
      {/* 任务区筛选：分类 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <select value={catFilter} onChange={(e) => { setCatFilter(e.target.value); setPage(1); }}
          aria-label="按分类筛选归档任务" title="按分类筛选归档任务"
          style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">全部分类</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {renderBatchBar('task')}
      {/* 空态只在「取数成功且本页为空」时出现——失败态由上方 ResourceHint 承载，两者不再同形 */}
      {tasksView.phase === 'ready' && pageTasks.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>暂无归档任务（或当前筛选无结果）。待办/已完成任务归档后在此管理。</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pageTasks.map((t) => (
          <li key={t.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selTaskIds.includes(t.id)} aria-label={`选中归档任务 ${t.title}`}
                onChange={() => toggleTask(t.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.task_no ? `${t.task_no} ` : ''}{t.title}（{projectNames[t.project_id] ?? '未知项目'} · {t.status === 'done' ? '已完成' : '待办'}
              {t.category_id ? ` · ${cats.find((c) => c.id === t.category_id)?.name ?? ''}` : ''}）
            </span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${t.archived_at ?? ''}`}>{relTime(t.archived_at)}</span>
            <button className="abtn" onClick={() => void restore(t)} title="还原 — 将该归档任务还原到待办列表" aria-label="还原：将该归档任务还原到待办列表" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void remove(t)} title="删除 — 永久删除该任务，此操作不可恢复" aria-label="删除：永久删除该任务，此操作不可恢复" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {renderPager(curTaskPage, taskPages, (n) => setPage(n), '归档任务')}

      {/* T00442 扩展：项目计划归档区——计划「删除」改归档后在此恢复或彻底删除 */}
      <h4 style={{ fontSize: 'var(--fs-l)', margin: '20px 0 8px' }}>归档项目计划（共 {planTotal} 条）</h4>
      <ResourceHint view={plansView} label="归档计划列表" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <select value={projFilter} onChange={(e) => { setProjFilter(e.target.value); setPlanPage(1); }}
          aria-label="按项目筛选归档计划" title="按项目筛选归档计划"
          style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">全部项目</option>
          {Object.entries(projectNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        {/* T02201：项目名取数失败时筛选器只剩「全部项目」，此处显式给出原因与重试入口 */}
        <ProjectListHint view={projectList} />
      </div>
      {renderBatchBar('plan')}
      {plansView.phase === 'ready' && pagePlans.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>暂无归档的项目计划（或当前筛选无结果）。</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pagePlans.map((p) => (
          <li key={p.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selPlanIds.includes(p.id)} aria-label={`选中归档计划 ${p.title}`}
                onChange={() => togglePlan(p.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}（{p.project_name}）</span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${p.archived_at ?? ''}`}>{relTime(p.archived_at)}</span>
            <button className="abtn" onClick={() => void restorePlan(p)} title="恢复 — 将该计划还原到「项目计划」时间线并自动衔接排期" aria-label="恢复：将该计划还原到项目计划时间线" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void purgePlan(p)} title="删除 — 彻底删除该计划，此操作不可恢复" aria-label="删除：彻底删除该计划，此操作不可恢复" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {renderPager(curPlanPage, planPages, (n) => setPlanPage(n), '归档项目计划')}

      {/* T00872：归档提示词区——提示词「归档」（软删）后在此还原或彻底删除 */}
      <h4 style={{ fontSize: 'var(--fs-l)', margin: '20px 0 8px' }}>归档提示词（共 {promptTotal} 条）</h4>
      <ResourceHint view={promptsView} label="归档提示词列表" />
      {promptsView.phase === 'ready' && pagePrompts.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>暂无归档提示词（或当前筛选无结果）。提示词页归档后的条目会出现在这里。</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pagePrompts.map((p) => (
          <li key={p.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.title}（{promptCatNames[p.category_id] ?? '未知分类'}）
            </span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${p.archived_at ?? ''}`}>{relTime(p.archived_at)}</span>
            <button className="abtn" onClick={() => void restorePrompt(p)} title="还原 — 将该提示词还原到提示词页原分类" aria-label="还原：将该提示词还原到提示词页原分类" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void removePrompt(p)} title="删除 — 彻底删除该提示词，此操作不可恢复" aria-label="删除：彻底删除该提示词，此操作不可恢复" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {renderPager(curPromptPage, promptPages, (n) => setPromptPage(n), '归档提示词')}
    </section>
  );
}
