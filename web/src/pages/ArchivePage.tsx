import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Prompt, type PromptCategory, type ReqCategory, type ReqEntry, type Task, type TaskCategory } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Check, ListChecks, Search, Trash2, Undo2, X } from 'lucide-react';
import { relTime } from '../ui/format';
import { useSessionState, usePersistentState } from '../ui/session';
import { SETTINGS_SEARCH_EVENT, peekSettingsSearchIntent, takeSettingsSearchIntent, type SettingsSearchIntentEventDetail } from '../ui/settingsSearch'; // T04099：命令面板跳转带关键词
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

/** T05080：归档 PRD 文档条目（归档菜单「归档 PRD 文档」区） */
interface ArchivedPrdDoc {
  id: string;
  project_id: string;
  filename: string;
  status: string;
  doc_kind: string;
  archived_at: string | null;
}

/** T05080：归档需求跟踪矩阵行（归档菜单「归档需求跟踪矩阵」区） */
interface ArchivedReqRow {
  id: string;
  project_id: string;
  req_no: string;
  title: string;
  priority: string;
  status: string;
  archived_at: string | null;
}

/** T05080：归档测试用例行（归档菜单「归档测试用例」区） */
interface ArchivedCaseRow {
  id: string;
  project_id: string;
  case_no: string;
  title: string;
  archived_at: string | null;
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
  const [reqCatNames, setReqCatNames] = useState<Record<string, string>>({}); // T03685：归档通用需求的分类名标注
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState<'info' | 'error'>('info');
  const noticeTimer = useRef<number | null>(null);

  // T00586：多选模式 + 搜索 + 分类/项目筛选 + 分页（会话级保持，切页不丢）
  const [multi, setMulti] = useSessionState<boolean>('archive.multi', false);
  const [selTaskIds, setSelTaskIds] = useSessionState<string[]>('archive.selTasks', []);
  const [selPlanIds, setSelPlanIds] = useSessionState<string[]>('archive.selPlans', []);
  // T06096：PRD 文档 / 需求跟踪矩阵页签也要支持多选，选中集按归档类型独立保存
  const [selPrdIds, setSelPrdIds] = useSessionState<string[]>('archive.selPrdDocs', []);
  const [selMatrixIds, setSelMatrixIds] = useSessionState<string[]>('archive.selMatrixReqs', []);
  const [kw, setKw] = useSessionState<string>('archive.kw', '');
  const [catFilter, setCatFilter] = useSessionState<string>('archive.catFilter', '');
  const [projFilter, setProjFilter] = useSessionState<string>('archive.projFilter', '');
  const [page, setPage] = useState(1);
  const [planPage, setPlanPage] = useState(1);
  const [promptPage, setPromptPage] = useState(1); // T00872：归档提示词分页页脚
  // T05775：归档类型 sheet 页签（任务/计划/提示词/通用需求/PRD/矩阵/测试用例）
  const [archiveTab, setArchiveTab] = useSessionState<string>('archive.tab', 'tasks');

  // T04099：命令面板「归档中另有 N 条」带过来的关键词——挂载时消费一次（读到即删）。
  // 意图只做一次性覆盖（searchKw），不写回 `archive.kw`：否则下次不经面板进入页面还会看到上次的关键词。
  // 初始化器只读（StrictMode 双跑，不能在这里删键）；真正的消费与聚焦放在 effect 里
  const [intentKw, setIntentKw] = useState<string | null>(() => peekSettingsSearchIntent('archive') || null);
  const searchKw = intentKw ?? kw;
  const setSearchKw = (v: string) => { setIntentKw(null); setKw(v); };
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!intentKw) return;
    takeSettingsSearchIntent('archive');
    setPage(1);
    setPlanPage(1);
    setPromptPage(1);
    searchRef.current?.focus();
  }, [intentKw]);
  // 面板点击时本页可能已挂载：只写会话键不会重渲染，事件路径即时覆盖；同样消费意图键，避免下次直接进入残留
  useEffect(() => {
    const onSearch = (e: Event) => {
      const detail = (e as CustomEvent<SettingsSearchIntentEventDetail>).detail;
      if (detail?.key !== 'archive') return;
      takeSettingsSearchIntent('archive');
      setIntentKw(detail.kw);
      setPage(1);
      setPlanPage(1);
      setPromptPage(1);
      searchRef.current?.focus();
    };
    globalThis.addEventListener(SETTINGS_SEARCH_EVENT, onSearch);
    return () => globalThis.removeEventListener(SETTINGS_SEARCH_EVENT, onSearch);
  }, []);
  // T02258：每页条数——三个列表区共用一值；localStorage 持久化，刷新后保持上次选择。
  // 存储值做档位白名单收敛：localStorage 被手工改脏（如 999）时回退默认档，不出现异常页长
  const [pageSizeStored, setPageSize] = usePersistentState<number>('archive.pageSize', DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSizeStored) ? pageSizeStored : DEFAULT_PAGE_SIZE;

  const flash = (m: string, kind: 'info' | 'error' = 'info') => {
    setNotice(m);
    setNoticeKind(kind);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3000);
  };
  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);
  // 单条写操作的统一兜底：失败必须可见，且不能把 Promise rejection 丢给 window
  async function perform(work: () => Promise<void>, successText: string): Promise<void> {
    try {
      await work();
      flash(successText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? '');
      flash(`操作失败：${msg.replace(/^Error:\s*/, '').trim() || '未知错误'}`, 'error');
    }
  }

  // T02284：筛选/关键词下推服务端后不再逐字符打接口——300ms 防抖（与移动端归档视图 T01442 同口径）
  const [kwQuery, setKwQuery] = useState(() => searchKw.trim());
  useEffect(() => {
    const next = searchKw.trim();
    if (next === kwQuery) return;
    const t = setTimeout(() => setKwQuery(next), 300);
    return () => clearTimeout(t);
  }, [searchKw, kwQuery]);

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
  // T03685：归档通用需求区——/req-entries?archived=1 暂无服务端分页通道（该端点未实现 limit/offset），
  // 归档条目量级小，先整表取回 + 本地关键词过滤；分页与提示词区一致留待端点补齐后统一接入
  const reqsView = useResource<ReqEntry[]>(async () => api.get<ReqEntry[]>('/req-entries?archived=1'), { enabled: false });

  // T05080：归档 PRD 文档 / 需求跟踪矩阵 / 测试用例三区——整表取回（归档量级小），本地关键词过滤，与归档通用需求同构
  const prdDocsArchivedView = useResource<ArchivedPrdDoc[]>(async () => api.get<ArchivedPrdDoc[]>('/plans/prd-docs/archived'), { enabled: false });
  const reqMatrixArchivedView = useResource<ArchivedReqRow[]>(async () => api.get<ArchivedReqRow[]>('/plans/prd-requirements/archived'), { enabled: false });
  const casesArchivedView = useResource<{ total: number; items: ArchivedCaseRow[] }>(async () => api.get<{ total: number; items: ArchivedCaseRow[] }>('/plans/test-cases/archived'), { enabled: false });

  // 引用数据只在挂载时取一次（失败沿用旧口径静默降级：仅影响名称显示，不影响列表数据）
  useEffect(() => {
    // T01722 修复：端点误写为 /tasks/categories（404 被吞、归档任务分类名恒缺失）——与 TasksPage 同口径走 /task-categories
    void api.get<TaskCategory[]>('/task-categories').then(setCats).catch(() => { /* 旧版后端忽略 */ });
    // T00872：归档提示词的分类名映射（/prompts?archived=1 返回软删数据，可在此还原/彻底删除）
    void api.get<PromptCategory[]>('/prompt-categories')
      .then((pcs) => setPromptCatNames(Object.fromEntries(pcs.map((c) => [c.id, c.name]))))
      .catch(() => { /* 旧版后端忽略 */ });
    // T03685：归档通用需求的分类名映射（同口径：只影响标注，不影响列表取数）
    void api.get<ReqCategory[]>('/req-categories')
      .then((rcs) => setReqCatNames(Object.fromEntries(rcs.map((c) => [c.id, c.name]))))
      .catch(() => { /* 旧版后端忽略 */ });
  }, []);

  // 首屏与「页码 / 每页条数 / 关键词 / 筛选」变化时重取**当前页**（enabled:false 关掉挂载自跑，统一由这里触发）
  useEffect(() => { tasksView.reload(); }, [page, pageSize, kwQuery, catFilter, tasksView.reload]);
  useEffect(() => { plansView.reload(); }, [planPage, pageSize, kwQuery, projFilter, plansView.reload]);
  useEffect(() => { promptsView.reload(); }, [promptPage, pageSize, kwQuery, promptsView.reload]);
  // T03685：归档通用需求区随关键词重取（整表取回，本地过滤见 pageReqs）
  useEffect(() => { reqsView.reload(); }, [kwQuery, reqsView.reload]);
  // T05080：三区归档列表随关键词重取（整表取回，本地过滤见下方派生数组）
  useEffect(() => { prdDocsArchivedView.reload(); }, [kwQuery, prdDocsArchivedView.reload]);
  useEffect(() => { reqMatrixArchivedView.reload(); }, [kwQuery, reqMatrixArchivedView.reload]);
  useEffect(() => { casesArchivedView.reload(); }, [kwQuery, casesArchivedView.reload]);

  // T02258：切换条数后各列表重置到第 1 页
  useEffect(() => { setPage(1); setPlanPage(1); setPromptPage(1); }, [pageSize]);

  // T02284：写操作后 total 变化 → 越界页码收敛到最后一页（避免停在空页）
  useEffect(() => { clampPage(tasksView.data?.total, page, pageSize, setPage); }, [tasksView.data, page, pageSize]);
  useEffect(() => { clampPage(plansView.data?.total, planPage, pageSize, setPlanPage); }, [plansView.data, planPage, pageSize]);
  useEffect(() => { clampPage(promptsView.data?.total, promptPage, pageSize, setPromptPage); }, [promptsView.data, promptPage, pageSize]);

  // ---------- 派生视图数据（T02284：条数/页数由服务端 total 派生，不再本地过滤） ----------

  const pageTasks = tasksView.data?.items ?? [];
  const pagePlans = plansView.data?.items ?? [];
  const pagePrompts = promptsView.data?.items ?? [];
  // T03685：归档通用需求——整表取回后本地按关键词过滤（标题/正文），与其余区的服务端过滤口径不同已在上方注明
  const archivedReqs = (reqsView.data ?? []).filter((e) => !kwQuery
    || e.title.toLowerCase().includes(kwQuery.toLowerCase())
    || (e.content ?? '').toLowerCase().includes(kwQuery.toLowerCase()));
  // T05080：三区归档条目——整表取回后本地按关键词过滤（文件名/编号/标题），与归档通用需求同构
  const archivedPrdDocs = (prdDocsArchivedView.data ?? []).filter((d) => !kwQuery || d.filename.toLowerCase().includes(kwQuery.toLowerCase()));
  const archivedMatrixReqs = (reqMatrixArchivedView.data ?? []).filter((r) => !kwQuery
    || r.title.toLowerCase().includes(kwQuery.toLowerCase())
    || r.req_no.toLowerCase().includes(kwQuery.toLowerCase()));
  const archivedCases = (casesArchivedView.data?.items ?? []).filter((c) => !kwQuery
    || (c.case_no ?? '').toLowerCase().includes(kwQuery.toLowerCase())
    || c.title.toLowerCase().includes(kwQuery.toLowerCase()));
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
    await perform(async () => {
      await api.post('/archive/restore', { taskIds: [task.id] });
      tasksView.reload();
    }, `已还原任务「${task.title}」到待办列表`);
  }

  async function remove(task: Task) {
    const ok = await askConfirm(`确认永久删除任务「${task.title}」？此操作不可恢复。`);
    if (!ok) return;
    await perform(async () => {
      await api.del('/archive', { taskIds: [task.id] });
      tasksView.reload();
    }, `已永久删除任务「${task.title}」`);
  }

  async function restorePlan(p: ArchivedPlan) {
    await perform(async () => {
      await api.post(`/plans/${p.id}/restore`);
      plansView.reload();
    }, `已恢复计划「${p.title}」到项目计划时间线`);
  }

  async function purgePlan(p: ArchivedPlan) {
    // T01874：先取连带影响再弹确认（预览失败退回原文案，不阻塞删除）
    const impact = await api.get<PurgeImpact>(`/plans/${p.id}/purge-impact`).catch(() => null);
    const ok = await askConfirm(`确认彻底删除计划「${p.title}」？此操作不可恢复（归档后仅剩此副本）。${purgeImpactText(impact)}`);
    if (!ok) return;
    try {
      const r = await api.del<{ deleted: boolean } & PurgeImpact>(`/plans/${p.id}`);
      plansView.reload();
      // 彻底删除计划会连带归档其派生待办——归档任务区的数据确实变了，一并只刷当前页
      if (r.deleted && r.strippedTasksArchived > 0) tasksView.reload();
      flash(r.deleted && r.strippedTasksArchived > 0
        ? `已彻底删除计划「${p.title}」，连带归档 ${r.strippedTasksArchived} 条派生待办`
        : `已彻底删除计划「${p.title}」`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? '');
      flash(`操作失败：${msg.replace(/^Error:\s*/, '').trim() || '未知错误'}`, 'error');
    }
  }

  // T00872：归档提示词还原（PATCH archived=false）与彻底删除（DELETE /prompts/:id）
  async function restorePrompt(p: Prompt) {
    await perform(async () => {
      await api.patch(`/prompts/${p.id}`, { archived: false });
      promptsView.reload();
    }, `已还原提示词「${p.title}」到原分类`);
  }

  async function removePrompt(p: Prompt) {
    const ok = await askConfirm(`确认彻底删除提示词「${p.title}」？此操作不可恢复。`);
    if (!ok) return;
    await perform(async () => {
      await api.del(`/prompts/${p.id}`);
      promptsView.reload();
    }, `已彻底删除提示词「${p.title}」`);
  }

  // T03685：归档通用需求还原（PATCH archived=false）与彻底删除（DELETE /req-entries/:id）——
  // 与提示词区同一套动作，还原后条目回到原分类的通用需求页
  async function restoreReq(e: ReqEntry) {
    await perform(async () => {
      await api.patch(`/req-entries/${e.id}`, { archived: false });
      reqsView.reload();
    }, `已还原通用需求「${e.title}」到原分类`);
  }

  async function removeReq(e: ReqEntry) {
    const ok = await askConfirm(`确认彻底删除通用需求「${e.title}」？此操作不可恢复。`);
    if (!ok) return;
    await perform(async () => {
      await api.del(`/req-entries/${e.id}`);
      reqsView.reload();
    }, `已彻底删除通用需求「${e.title}」`);
  }

  // T05080：归档 PRD 文档 / 需求跟踪矩阵 / 测试用例三区的还原与彻底删除（与归档通用需求同构）
  async function restorePrdDoc(d: ArchivedPrdDoc) {
    await perform(async () => {
      await api.post(`/plans/prd-docs/${d.id}/restore`);
      prdDocsArchivedView.reload();
    }, `已还原 PRD 文档「${d.filename}」`);
  }
  async function purgePrdDoc(d: ArchivedPrdDoc) {
    const ok = await askConfirm(`确认彻底删除 PRD 文档「${d.filename}」？此操作不可恢复。`);
    if (!ok) return;
    await perform(async () => {
      await api.post(`/plans/prd-docs/${d.id}/purge`);
      prdDocsArchivedView.reload();
    }, `已彻底删除 PRD 文档「${d.filename}」`);
  }
  async function restoreMatrixReq(r: ArchivedReqRow) {
    await perform(async () => {
      await api.post(`/plans/prd-requirements/${r.id}/restore`);
      reqMatrixArchivedView.reload();
    }, `已还原需求「${r.req_no} ${r.title}」`);
  }
  async function purgeMatrixReq(r: ArchivedReqRow) {
    const ok = await askConfirm(`确认彻底删除需求「${r.req_no} ${r.title}」？此操作不可恢复；其下已归档的测试用例将因外键级联一并彻底删除。`);
    if (!ok) return;
    await perform(async () => {
      await api.post(`/plans/prd-requirements/${r.id}/purge`);
      reqMatrixArchivedView.reload();
    }, `已彻底删除需求「${r.req_no} ${r.title}」`);
  }
  async function restoreCase(c: ArchivedCaseRow) {
    await perform(async () => {
      await api.post(`/plans/test-cases/${c.id}/restore`);
      casesArchivedView.reload();
    }, `已还原测试用例「${c.case_no} ${c.title}」`);
  }
  async function purgeCase(c: ArchivedCaseRow) {
    const ok = await askConfirm(`确认彻底删除测试用例「${c.case_no} ${c.title}」？此操作不可恢复。`);
    if (!ok) return;
    await perform(async () => {
      await api.post(`/plans/test-cases/${c.id}/purge`);
      casesArchivedView.reload();
    }, `已彻底删除测试用例「${c.case_no} ${c.title}」`);
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? '');
      flash(`操作失败：${msg.replace(/^Error:\s*/, '').trim() || '未知错误'}`, 'error');
    } finally { setBusy(false); }
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? '');
      flash(`操作失败：${msg.replace(/^Error:\s*/, '').trim() || '未知错误'}`, 'error');
    } finally { setBusy(false); }
  }

  async function batchRestorePlans() {
    if (selPlanIds.length === 0) return;
    setBusy(true);
    let n = 0;
    let failed = 0;
    try {
      for (const id of selPlanIds) {
        try { await api.post(`/plans/${id}/restore`); n += 1; } catch { failed += 1; }
      }
      flash(failed > 0
        ? `已恢复 ${n} 条归档计划，${failed} 条恢复失败`
        : `已恢复 ${n} 条归档计划`, failed > 0 ? 'error' : 'info');
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
    let failed = 0;
    let strippedTasks = 0;
    try {
      for (const id of selPlanIds) {
        try {
          const r = await api.del<{ deleted: boolean; strippedTasksArchived: number }>(`/plans/${id}`);
          if (r.deleted) { n += 1; strippedTasks += r.strippedTasksArchived; } else failed += 1;
        } catch { failed += 1; }
      }
      // S4624：内层模板先赋值再插值，文案逐字不变
      const strippedNote = strippedTasks > 0 ? `，连带归档 ${strippedTasks} 条派生待办` : '';
      const failedNote = failed > 0 ? `，${failed} 条失败` : '';
      flash(`已彻底删除 ${n} 条计划${strippedNote}${failedNote}`, failed > 0 ? 'error' : 'info');
      setSelPlanIds([]);
      plansView.reload();
      // 同 purgePlan：连带归档了派生待办，归档任务区也要重取当前页
      if (strippedTasks > 0) tasksView.reload();
    } finally { setBusy(false); }
  }

  // T06096：PRD 文档与需求跟踪矩阵的批量选择/批量动作——补齐多选模式在这两个页签的缺口
  function togglePrdDoc(id: string) {
    setSelPrdIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function toggleMatrixReq(id: string) {
    setSelMatrixIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function selectAllPrdDocs() {
    setSelPrdIds((prev) => togglePageSelection(prev, archivedPrdDocs.map((d) => d.id)));
  }
  function selectAllMatrixReqs() {
    setSelMatrixIds((prev) => togglePageSelection(prev, archivedMatrixReqs.map((r) => r.id)));
  }

  async function batchRestorePrdDocs() {
    if (selPrdIds.length === 0) return;
    setBusy(true);
    let n = 0;
    let failed = 0;
    try {
      for (const id of selPrdIds) {
        try { await api.post(`/plans/prd-docs/${id}/restore`); n += 1; } catch { failed += 1; }
      }
      flash(failed > 0 ? `已还原 ${n} 条 PRD 文档，${failed} 条失败` : `已还原 ${n} 条 PRD 文档`, failed > 0 ? 'error' : 'info');
      setSelPrdIds([]);
      prdDocsArchivedView.reload();
    } finally { setBusy(false); }
  }

  async function batchPurgePrdDocs() {
    if (selPrdIds.length === 0) return;
    if (!(await askConfirm(`永久删除选中的 ${selPrdIds.length} 条归档 PRD 文档？此操作不可恢复。`))) return;
    setBusy(true);
    let n = 0;
    let failed = 0;
    try {
      for (const id of selPrdIds) {
        try { await api.post(`/plans/prd-docs/${id}/purge`); n += 1; } catch { failed += 1; }
      }
      flash(failed > 0 ? `已彻底删除 ${n} 条 PRD 文档，${failed} 条失败` : `已彻底删除 ${n} 条 PRD 文档`, failed > 0 ? 'error' : 'info');
      setSelPrdIds([]);
      prdDocsArchivedView.reload();
    } finally { setBusy(false); }
  }

  async function batchRestoreMatrixReqs() {
    if (selMatrixIds.length === 0) return;
    setBusy(true);
    let n = 0;
    let failed = 0;
    try {
      for (const id of selMatrixIds) {
        try { await api.post(`/plans/prd-requirements/${id}/restore`); n += 1; } catch { failed += 1; }
      }
      flash(failed > 0 ? `已还原 ${n} 条需求，${failed} 条失败` : `已还原 ${n} 条需求`, failed > 0 ? 'error' : 'info');
      setSelMatrixIds([]);
      reqMatrixArchivedView.reload();
    } finally { setBusy(false); }
  }

  async function batchPurgeMatrixReqs() {
    if (selMatrixIds.length === 0) return;
    if (!(await askConfirm(`彻底删除选中的 ${selMatrixIds.length} 条归档需求？此操作不可恢复；其下已归档的测试用例将因外键级联一并彻底删除。`))) return;
    setBusy(true);
    let n = 0;
    let failed = 0;
    try {
      for (const id of selMatrixIds) {
        try { await api.post(`/plans/prd-requirements/${id}/purge`); n += 1; } catch { failed += 1; }
      }
      flash(failed > 0 ? `已彻底删除 ${n} 条需求，${failed} 条失败` : `已彻底删除 ${n} 条需求`, failed > 0 ? 'error' : 'info');
      setSelMatrixIds([]);
      reqMatrixArchivedView.reload();
      // 需求被彻底删除会级联清掉其已归档测试用例，用例区一并刷新
      casesArchivedView.reload();
    } finally { setBusy(false); }
  }

  /** 批量工具条（T00586）：风格与计划页一致——accent 边框 + 已选计数 + 纯图标按钮；T06096 扩展到 PRD/矩阵 */
  function renderBatchBar(kind: 'task' | 'plan' | 'prd' | 'matrix') {
    const configs: Record<'task' | 'plan' | 'prd' | 'matrix', { ids: string[]; pageIds: string[]; clear: () => void; selectAll: () => void; restore: () => Promise<void>; purge: () => Promise<void> }> = {
      task: { ids: selTaskIds, pageIds: pageTasks.map((t) => t.id), clear: () => setSelTaskIds([]), selectAll: selectAllTasks, restore: batchRestoreTasks, purge: batchPurgeTasks },
      plan: { ids: selPlanIds, pageIds: pagePlans.map((p) => p.id), clear: () => setSelPlanIds([]), selectAll: selectAllPlans, restore: batchRestorePlans, purge: batchPurgePlans },
      prd: { ids: selPrdIds, pageIds: archivedPrdDocs.map((d) => d.id), clear: () => setSelPrdIds([]), selectAll: selectAllPrdDocs, restore: batchRestorePrdDocs, purge: batchPurgePrdDocs },
      matrix: { ids: selMatrixIds, pageIds: archivedMatrixReqs.map((r) => r.id), clear: () => setSelMatrixIds([]), selectAll: selectAllMatrixReqs, restore: batchRestoreMatrixReqs, purge: batchPurgeMatrixReqs },
    };
    const cfg = configs[kind];
    if (cfg.ids.length === 0) return null;
    // S3358：将嵌套三元拆为独立变量，避免嵌套条件表达式
    const onPage = cfg.pageIds.filter((id) => cfg.ids.includes(id)).length;
    const selectAllTitle = cfg.pageIds.length > 0 && onPage === cfg.pageIds.length ? '取消全选本页' : '全选本页';
    // T02284：跨页选中保留——计数显式标注「含其他页 N 条」，避免「已选 25 条」被误读成本页全选
    const offPage = cfg.ids.length - onPage;
    const offPageNote = offPage > 0 ? `（含其他页 ${offPage} 条）` : '';
    return (
      <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 10px', margin: '8px 0', borderRadius: 8, background: 'var(--card-bg)', border: '1px solid var(--accent)', boxShadow: '0 4px 12px rgba(0,0,0,.12)', fontSize: 'var(--fs-s)' }}>
        <strong style={{ color: 'var(--accent)' }}>已选 {cfg.ids.length} 条{offPageNote}</strong>
        <button onClick={cfg.selectAll} disabled={busy} className="tbtn-anim"
          title={selectAllTitle}
          aria-label={selectAllTitle}
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text)' }}>
          <ListChecks size={14} />
        </button>
        <button onClick={() => void cfg.restore()} disabled={busy} className="tbtn-anim"
          title="批量还原 — 将选中条目还原到原列表" aria-label="批量还原"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--accent)' }}>
          <Undo2 size={14} />
        </button>
        <button onClick={() => void cfg.purge()} disabled={busy} className="tbtn-anim"
          title="批量彻底删除 — 不可恢复" aria-label="批量彻底删除"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--danger)' }}>
          <Trash2 size={14} />
        </button>
        <button onClick={cfg.clear} disabled={busy} className="tbtn-anim"
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
          <span>每页</span>
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
            title={`每页条数（${listLabel}）— 切换后立即生效并回到第 1 页`} aria-label={`每页条数（${listLabel}）`}
            style={{ padding: '2px 4px', fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
            {PAGE_SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span>条</span>
        </label>
      </div>
    );
  }

  // T05808：归档类型页签统一「去归档前缀 + 数量」；数量与列表 total/过滤后条目实时联动。
  const archiveTabs = [
    { key: 'tasks', label: '任务', count: tasksView.phase === 'error' ? '—' : taskTotal },
    { key: 'plans', label: '计划', count: plansView.phase === 'error' ? '—' : planTotal },
    { key: 'prompts', label: '提示词', count: promptsView.phase === 'error' ? '—' : promptTotal },
    { key: 'reqs', label: '通用需求', count: reqsView.phase === 'error' ? '—' : archivedReqs.length },
    { key: 'prd', label: 'PRD 文档', count: prdDocsArchivedView.phase === 'error' ? '—' : archivedPrdDocs.length },
    { key: 'matrix', label: '需求跟踪矩阵', count: reqMatrixArchivedView.phase === 'error' ? '—' : archivedMatrixReqs.length },
    { key: 'cases', label: '测试用例', count: casesArchivedView.phase === 'error' ? '—' : archivedCases.length },
  ];
  // T05775 复审：archive.tab 是持久化自由字符串；旧版本/手工写入的未知 key 会让所有 sheet 同时 display:none。
  // 渲染前收敛到已知页签，未知值按「任务」兜底，保证至少有一个可见内容区。
  const archiveTabSafe = archiveTabs.some((t) => t.key === archiveTab) ? archiveTab : 'tasks';

  // T06000：页签切换联动筛选——隐藏的筛选项回默认值；分页与多选选择一并复位，避免跨页签残留。
  const switchArchiveTab = (key: string) => {
    setArchiveTab(key);
    if (key !== 'tasks') setCatFilter('');
    if (key !== 'plans') setProjFilter('');
    setPage(1); setPlanPage(1); setPromptPage(1);
    setSelTaskIds([]); setSelPlanIds([]); setSelPrdIds([]); setSelMatrixIds([]);
  };
  const resetArchiveFilters = () => {
    setSearchKw('');
    setCatFilter('');
    setProjFilter('');
    setPage(1); setPlanPage(1); setPromptPage(1);
  };
  const hasActiveFilters = Boolean(kwQuery || catFilter || projFilter);
  const handleTabKeyDown = (event: { key: string; preventDefault: () => void }, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % archiveTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + archiveTabs.length) % archiveTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = archiveTabs.length - 1;
    else return;
    event.preventDefault();
    const target = archiveTabs[nextIndex];
    switchArchiveTab(target.key);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-t05775="archive-type-${target.key}"]`)?.focus();
    });
  };

  return (
    <section>
      {/* 行内操作默认低对比可见：hover 只做强调、不再隐藏——触屏与键盘用户不会失去还原/删除入口 */}
      <style>{`
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: .72; visibility: visible; transition: opacity .15s ease; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; }
        @media (hover: none), (pointer: coarse) { .abtn { opacity: 1; } }
      `}</style>
      {notice && <div data-t05775="archive-notice" role={noticeKind === 'error' ? 'alert' : 'status'} aria-live={noticeKind === 'error' ? 'assertive' : 'polite'} aria-atomic="true"
        style={{ position: 'fixed', top: 12, right: 16, zIndex: 200, maxWidth: 'min(420px, calc(100vw - 32px))', padding: '6px 12px', borderRadius: 6, background: 'var(--card-bg)', border: `1px solid ${noticeKind === 'error' ? 'var(--danger)' : 'var(--accent)'}`, fontSize: 'var(--fs-s)', color: 'var(--text)', boxShadow: '0 4px 12px rgba(0,0,0,.14)' }}>{notice}</div>}

      {/* T06000：页签 + 多选 + 搜索 + 分类/项目筛选合并为同一排；窄屏横向滚动，不挤压主操作区 */}
      <div data-t06000="archive-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', overflowX: 'auto', borderBottom: '1px solid var(--border-strong)', marginBottom: 10, paddingBottom: 6 }}>
        <div role="tablist" aria-label="归档类型切换" data-t05775="archive-type-tabs" style={{ display: 'flex', gap: 2, alignItems: 'center', flex: '0 0 auto' }}>
          {archiveTabs.map((t, index) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`archive-tab-${t.key}`}
              aria-controls={`archive-panel-${t.key}`}
              aria-selected={archiveTabSafe === t.key}
              tabIndex={archiveTabSafe === t.key ? 0 : -1}
              data-t05775={`archive-type-${t.key}`}
              onClick={() => switchArchiveTab(t.key)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              title={`${t.label} (${t.count}) — 点击切换归档类型`}
              style={{
                fontSize: 'var(--fs-s)', padding: '5px 8px', border: 'none', background: archiveTabSafe === t.key ? 'var(--accent-soft)' : 'transparent',
                cursor: 'pointer', whiteSpace: 'nowrap', flex: '0 0 auto', borderRadius: 6,
                fontWeight: archiveTabSafe === t.key ? 700 : 400,
                color: archiveTabSafe === t.key ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: archiveTabSafe === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>
        <span aria-hidden="true" style={{ width: 1, height: 24, background: 'var(--border)', flex: '0 0 auto' }} />
        {/* 多选模式（参考计划页：ListChecks/Check 图标切换） */}
        <button onClick={() => { setMulti((m) => !m); setSelTaskIds([]); setSelPlanIds([]); setSelPrdIds([]); setSelMatrixIds([]); }}
          className="tbtn-anim"
          title={multi ? '退出多选模式' : '多选模式 — 勾选归档条目后批量还原/删除'}
          aria-label={multi ? '退出多选模式' : '进入多选模式'}
          style={{ fontSize: 'var(--fs-s)', padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', flex: '0 0 auto', border: '1px solid var(--border-strong)', background: multi ? 'var(--accent)' : 'transparent', color: multi ? 'var(--accent-text)' : 'var(--text)' }}>
          {multi ? <Check size={13} /> : <ListChecks size={13} />}
        </button>
        {/* 搜索（标题/编号/项目名） */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 8px', background: 'var(--card-bg)', flex: '0 1 230px', minWidth: 170 }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input ref={searchRef} value={searchKw} onChange={(e) => { setSearchKw(e.target.value); setPage(1); setPlanPage(1); setPromptPage(1); }}
            placeholder="搜索归档标题…" aria-label="搜索归档内容" data-page-search
            style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', width: '100%', minWidth: 100 }} />
          {searchKw && <button onClick={() => { setSearchKw(''); setPage(1); setPlanPage(1); setPromptPage(1); }} title="清除搜索" aria-label="清除搜索" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}><X size={12} /></button>}
        </span>
        {archiveTabSafe === 'tasks' && (
          <select value={catFilter} onChange={(e) => { setCatFilter(e.target.value); setPage(1); }}
            aria-label="按分类筛选归档任务" title="按分类筛选归档任务"
            style={{ padding: '4px 6px', fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', flex: '0 0 auto', minWidth: 110, maxWidth: 200 }}>
            <option value="">全部分类</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="none">未分类</option>
          </select>
        )}
        {archiveTabSafe === 'plans' && (
          <select value={projFilter} onChange={(e) => { setProjFilter(e.target.value); setPlanPage(1); }}
            aria-label="按项目筛选归档计划" title="按项目筛选归档计划"
            style={{ padding: '4px 6px', fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', flex: '0 0 auto', minWidth: 140, maxWidth: 260 }}>
            <option value="">全部项目</option>
            {Object.entries(projectNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
      </div>
      {/* 项目名用于任务/计划/PRD/矩阵/用例五行；失败提示不再只在计划页签出现 */}
      {archiveTabSafe !== 'prompts' && archiveTabSafe !== 'reqs' && <ProjectListHint view={projectList} style={{ marginBottom: 8, flexWrap: 'wrap', maxWidth: '100%' }} />}
      {hasActiveFilters && (
        <div data-t06000="filter-reset" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
          <span>当前筛选{kwQuery ? `：关键词「${kwQuery}」` : ''}{catFilter ? ' · 指定分类' : ''}{projFilter ? ' · 指定项目' : ''}</span>
          <button type="button" onClick={resetArchiveFilters} title="重置搜索与筛选" aria-label="重置搜索与筛选"
            style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' }}>
            重置筛选
          </button>
        </div>
      )}

      <div id="archive-panel-tasks" role="tabpanel" aria-labelledby="archive-tab-tasks" data-t05775="archive-section" data-archive-type="tasks" style={{ display: archiveTabSafe === 'tasks' ? 'block' : 'none' }}>
      <ResourceHint view={tasksView} label="归档任务列表" showLoading />
      {renderBatchBar('task')}
      {/* 空态只在「取数成功且本页为空」时出现——失败态由上方 ResourceHint 承载，两者不再同形 */}
      {tasksView.phase === 'ready' && pageTasks.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{hasActiveFilters ? '未找到相关归档。请调整搜索/筛选条件，或点上方「重置筛选」。' : '暂无归档任务。待办/已完成任务归档后在此管理。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pageTasks.map((t) => (
          <li key={t.id} className="arena-row" data-archive-row data-archive-id={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selTaskIds.includes(t.id)} aria-label={`选中归档任务 ${t.title}`}
                onChange={() => toggleTask(t.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.task_no ? `${t.task_no} ` : ''}{t.title}（{projectNames[t.project_id] ?? '未知项目'} · {t.status === 'done' ? '已完成' : '待办'}
              {t.category_id ? ` · ${cats.find((c) => c.id === t.category_id)?.name ?? ''}` : ''}）
            </span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${t.archived_at ?? ''}`}>{relTime(t.archived_at)}</span>
            <button className="abtn" onClick={() => void restore(t)} title={`还原 — 将任务「${t.title}」还原到待办列表`} aria-label={`还原任务 ${t.task_no ? `${t.task_no} ` : ''}${t.title}`} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void remove(t)} title={`删除 — 永久删除任务「${t.title}」，此操作不可恢复`} aria-label={`彻底删除任务 ${t.task_no ? `${t.task_no} ` : ''}${t.title}`} style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {tasksView.phase === 'ready' && renderPager(curTaskPage, taskPages, (n) => setPage(n), '归档任务')}
      </div>

      <div id="archive-panel-plans" role="tabpanel" aria-labelledby="archive-tab-plans" data-t05775="archive-section" data-archive-type="plans" style={{ display: archiveTabSafe === 'plans' ? 'block' : 'none' }}>
      {/* T00442 扩展：项目计划归档区——计划「删除」改归档后在此恢复或彻底删除 */}
      <ResourceHint view={plansView} label="归档计划列表" showLoading />
      {renderBatchBar('plan')}
      {plansView.phase === 'ready' && pagePlans.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{hasActiveFilters ? '未找到相关归档。请调整搜索/筛选条件，或点上方「重置筛选」。' : '暂无归档的项目计划。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pagePlans.map((p) => (
          <li key={p.id} className="arena-row" data-archive-row data-archive-id={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selPlanIds.includes(p.id)} aria-label={`选中归档计划 ${p.title}`}
                onChange={() => togglePlan(p.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}（{p.project_name}）</span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${p.archived_at ?? ''}`}>{relTime(p.archived_at)}</span>
            <button className="abtn" onClick={() => void restorePlan(p)} title={`恢复 — 将计划「${p.title}」还原到「项目计划」时间线并自动衔接排期`} aria-label={`还原计划 ${p.title}`} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void purgePlan(p)} title={`删除 — 彻底删除计划「${p.title}」，此操作不可恢复`} aria-label={`彻底删除计划 ${p.title}`} style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {plansView.phase === 'ready' && renderPager(curPlanPage, planPages, (n) => setPlanPage(n), '归档项目计划')}
      </div>

      <div id="archive-panel-prompts" role="tabpanel" aria-labelledby="archive-tab-prompts" data-t05775="archive-section" data-archive-type="prompts" style={{ display: archiveTabSafe === 'prompts' ? 'block' : 'none' }}>
      {/* T00872：归档提示词区——提示词「归档」（软删）后在此还原或彻底删除 */}
      <ResourceHint view={promptsView} label="归档提示词列表" showLoading />
      {promptsView.phase === 'ready' && pagePrompts.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{hasActiveFilters ? '未找到相关归档。请调整搜索/筛选条件，或点上方「重置筛选」。' : '暂无归档提示词。提示词页归档后的条目会出现在这里。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pagePrompts.map((p) => (
          <li key={p.id} className="arena-row" data-archive-row data-archive-id={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.title}（{promptCatNames[p.category_id] ?? '未知分类'}）
            </span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${p.archived_at ?? ''}`}>{relTime(p.archived_at)}</span>
            <button className="abtn" onClick={() => void restorePrompt(p)} title={`还原 — 将提示词「${p.title}」还原到提示词页原分类`} aria-label={`还原提示词 ${p.title}`} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void removePrompt(p)} title={`删除 — 彻底删除提示词「${p.title}」，此操作不可恢复`} aria-label={`彻底删除提示词 ${p.title}`} style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {promptsView.phase === 'ready' && renderPager(curPromptPage, promptPages, (n) => setPromptPage(n), '归档提示词')}
      </div>

      <div id="archive-panel-reqs" role="tabpanel" aria-labelledby="archive-tab-reqs" data-t05775="archive-section" data-archive-type="reqs" style={{ display: archiveTabSafe === 'reqs' ? 'block' : 'none' }}>
      {/* T03685：归档通用需求区——通用需求条目「归档」（软删）后在此还原或彻底删除，
          与提示词区同构；入口来自通用需求菜单的行内归档按钮 */}
      <ResourceHint view={reqsView} label="归档通用需求列表" showLoading />
      {reqsView.phase === 'ready' && archivedReqs.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{hasActiveFilters ? '未找到相关归档。请调整搜索/筛选条件，或点上方「重置筛选」。' : '暂无归档通用需求。通用需求页归档后的条目会出现在这里。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {archivedReqs.map((e) => (
          <li key={e.id} data-t03685="archived-req-row" data-archive-row data-archive-id={e.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {e.title}（{reqCatNames[e.category_id] ?? '未知分类'}）
            </span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${e.archived_at ?? ''}`}>{relTime(e.archived_at)}</span>
            <button className="abtn" onClick={() => void restoreReq(e)} title={`还原 — 将通用需求「${e.title}」还原到通用需求页原分类`} aria-label={`还原通用需求 ${e.title}`} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void removeReq(e)} title={`删除 — 彻底删除通用需求「${e.title}」，此操作不可恢复`} aria-label={`彻底删除通用需求 ${e.title}`} style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      </div>

      <div id="archive-panel-prd" role="tabpanel" aria-labelledby="archive-tab-prd" data-t05775="archive-section" data-archive-type="prd" style={{ display: archiveTabSafe === 'prd' ? 'block' : 'none' }}>
      {/* T05080：归档 PRD 文档区——PRD 管理视图「归档」后在此还原或彻底删除 */}
      <ResourceHint view={prdDocsArchivedView} label="归档 PRD 文档列表" showLoading />
      {/* T06096：多选模式下提供与任务/计划一致的批量工具条 */}
      {renderBatchBar('prd')}
      {prdDocsArchivedView.phase === 'ready' && archivedPrdDocs.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{hasActiveFilters ? '未找到相关归档。请调整搜索/筛选条件，或点上方「重置筛选」。' : '暂无归档 PRD 文档。PRD 管理页归档后的文档会出现在这里。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {archivedPrdDocs.map((d) => (
          <li key={d.id} className="arena-row" data-archive-row data-archive-id={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selPrdIds.includes(d.id)} aria-label={`选中归档 PRD 文档 ${d.filename}`}
                onChange={() => togglePrdDoc(d.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.filename}（{projectNames[d.project_id] ?? '未知项目'}）
            </span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${d.archived_at ?? ''}`}>{relTime(d.archived_at)}</span>
            <button className="abtn" onClick={() => void restorePrdDoc(d)} title={`还原 — 将 PRD 文档「${d.filename}」还原到 PRD 管理页`} aria-label={`还原 PRD 文档 ${d.filename}`} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void purgePrdDoc(d)} title={`删除 — 彻底删除 PRD 文档「${d.filename}」，此操作不可恢复`} aria-label={`彻底删除 PRD 文档 ${d.filename}`} style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      </div>

      <div id="archive-panel-matrix" role="tabpanel" aria-labelledby="archive-tab-matrix" data-t05775="archive-section" data-archive-type="matrix" style={{ display: archiveTabSafe === 'matrix' ? 'block' : 'none' }}>
      {/* T05080：归档需求跟踪矩阵区——需求跟踪矩阵视图「归档」后在此还原或彻底删除 */}
      <ResourceHint view={reqMatrixArchivedView} label="归档需求跟踪矩阵列表" showLoading />
      {/* T06096：多选模式下提供与任务/计划一致的批量工具条 */}
      {renderBatchBar('matrix')}
      {reqMatrixArchivedView.phase === 'ready' && archivedMatrixReqs.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{hasActiveFilters ? '未找到相关归档。请调整搜索/筛选条件，或点上方「重置筛选」。' : '暂无归档需求跟踪矩阵行。需求跟踪矩阵页归档后的行会出现在这里。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {archivedMatrixReqs.map((r) => (
          <li key={r.id} className="arena-row" data-archive-row data-archive-id={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selMatrixIds.includes(r.id)} aria-label={`选中归档需求 ${r.req_no} ${r.title}`}
                onChange={() => toggleMatrixReq(r.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.req_no} {r.title}（{projectNames[r.project_id] ?? '未知项目'}）
            </span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${r.archived_at ?? ''}`}>{relTime(r.archived_at)}</span>
            <button className="abtn" onClick={() => void restoreMatrixReq(r)} title={`还原 — 将需求「${r.req_no} ${r.title}」还原到需求跟踪矩阵`} aria-label={`还原需求 ${r.req_no} ${r.title}`} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void purgeMatrixReq(r)} title={`删除 — 彻底删除需求「${r.req_no} ${r.title}」，此操作不可恢复`} aria-label={`彻底删除需求 ${r.req_no} ${r.title}`} style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      </div>

      <div id="archive-panel-cases" role="tabpanel" aria-labelledby="archive-tab-cases" data-t05775="archive-section" data-archive-type="cases" style={{ display: archiveTabSafe === 'cases' ? 'block' : 'none' }}>
      {/* T05080：归档测试用例区——测试用例视图「归档」后在此还原或彻底删除 */}
      <ResourceHint view={casesArchivedView} label="归档测试用例列表" showLoading />
      {casesArchivedView.phase === 'ready' && archivedCases.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{hasActiveFilters ? '未找到相关归档。请调整搜索/筛选条件，或点上方「重置筛选」。' : '暂无归档测试用例。测试用例页归档后的用例会出现在这里。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {archivedCases.map((c) => (
          <li key={c.id} className="arena-row" data-archive-row data-archive-id={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.case_no} {c.title}（{projectNames[c.project_id] ?? '未知项目'}）
            </span>
            <span className="abtn" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${c.archived_at ?? ''}`}>{relTime(c.archived_at)}</span>
            <button className="abtn" onClick={() => void restoreCase(c)} title={`还原 — 将测试用例「${c.case_no} ${c.title}」还原到测试用例页`} aria-label={`还原测试用例 ${c.case_no} ${c.title}`} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void purgeCase(c)} title={`删除 — 彻底删除测试用例「${c.case_no} ${c.title}」，此操作不可恢复`} aria-label={`彻底删除测试用例 ${c.case_no} ${c.title}`} style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      </div>
    </section>
  );
}
