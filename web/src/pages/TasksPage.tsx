import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent } from 'react';
import { api, imageUrl, fetchImage, imageDataURL, type AITool, type Project, type PromptCategory, type ReqCategory, type Task, type TaskCategory, type TaskImage } from '../api/client';
import { beautifyStore } from '../stores/beautifyStore';
import { askConfirm, askInput } from '../ui/dialogs';
import { MarkdownContent } from '../ui/Markdown';
import { PinToggle } from '../ui/PinToggle';
import { clearSessionState, usePersistentState, useSessionState } from '../ui/session';
import { useBusy, setBusy } from '../ui/busy';
import { AlignLeft, Archive, Check, ChevronDown, ChevronUp, ClipboardEdit, ClipboardList, Copy, CopyPlus, FolderPlus, ImagePlus, ListTodo, Loader2, Plus, Save, ScanSearch, Sparkles, SquarePen, Tags, Trash2, Wand2, X } from 'lucide-react';

/** 粘贴截图项：id 为入列时生成的稳定唯一标识，供列表 key 使用，删除中间项不会导致其余项身份错位 */
interface PastedImage {
  id: string;
  url: string;
}

/** 描述编辑中的图片草稿：added 为待上传的粘贴截图，removed 为待删除的已有图片 id */
interface ImageDraft {
  added: PastedImage[];
  removed: string[];
}

/** 剥离 AI 外层的 ```markdown ``` 代码围栏：仅当围栏包裹整段文本时去除，保留内部 Markdown 内容，异常情况原样返回 */
function stripCodeFence(text: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}

/** 为粘贴截图生成稳定唯一 id：时间戳 + 随机段，同一毫秒内多次粘贴也不冲突 */
function newPastedImageId(): string {
  return `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 从剪贴板读取图片；有图片时阻止默认粘贴并回调 dataURL，无图片则放行文本粘贴（纯函数，提到组件外避免闭包重创建） */
function readClipboardImages(e: ClipboardEvent<HTMLTextAreaElement>, onImages: (url: string) => void): boolean {
  const files = Array.from(e.clipboardData.items)
    .filter((i) => i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
  if (files.length === 0) return false;
  e.preventDefault();
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onImages(reader.result);
    };
    reader.readAsDataURL(file);
  }
  return true;
}

export function TasksPage() {
  // 新建任务表单字段：跨切换会话持久化，录入一半切页后可续写
  const [newTitle, setNewTitle] = useSessionState('tasks.new.title', '');
  const [newPriority, setNewPriority] = useSessionState<string>('tasks.new.priority', 'normal');
  const [newDescOpen, setNewDescOpen] = useSessionState('tasks.new.descOpen', false);
  const [newDesc, setNewDesc] = useSessionState('tasks.new.desc', '');
  const [newImages, setNewImages] = useSessionState<PastedImage[]>('tasks.new.images', []);
  const [projects, setProjects] = useState<Project[]>([]);
  // 复用（复制）任务弹窗状态：reuseOpen 存待复制任务 id（null 关闭）；projectId 为选中的目标项目
  const [reuseOpen, setReuseOpen] = useState<string | null>(null);
  const reusePanelRef = useRef<HTMLDivElement>(null);
  const [reuseProjectId, setReuseProjectId] = useState('');
  const [reuseSearch, setReuseSearch] = useState('');
  // 复用目标：project=复制到项目；prompt=打包为 JSON 资产复制到提示词页；req=打包为通用需求条目
  const [reuseTarget, setReuseTarget] = useState<'project' | 'prompt' | 'req'>('project');
  // 复制到提示词/通用需求时选中的目标分类；promptCats 为可选提示词分类、reqCats 为可选通用需求分类（均懒加载）
  const [reuseCategoryId, setReuseCategoryId] = useState('');
  const [promptCats, setPromptCats] = useState<PromptCategory[]>([]);
  const [reqCats, setReqCats] = useState<ReqCategory[]>([]);
  // 复用（创建副本）操作进行中：全局 busy store，切页不丢失，防止请求进行中重复提交
  const reuseBusy = useBusy('tasks.reuse');
  // 项目/模型为长期偏好，用 localStorage 持久化，切页与刷新后均保留；未选状态透传空串，不强制填充
  const [activeProject, setActiveProject] = usePersistentState('tasks.activeProject', '');
  const [todo, setTodo] = useState<Task[]>([]);
  const [done, setDone] = useState<Task[]>([]);
  const [search, setSearch] = useState('');
  // 主列表分页：后端按页拉取 + 加载更多；hasMore=true 表示当前页刚好满页、可能还有更多
  const PAGE_SIZE = 200;
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tools, setTools] = useState<AITool[]>([]);
  const [organizeToolId, setOrganizeToolId] = usePersistentState('tasks.organizeToolId', '');
  // 任务分类：分类列表 + 顶部筛选（会话级）+ 新建任务所选分类（会话级）
  const [taskCats, setTaskCats] = useState<TaskCategory[]>([]);
  const [catFilter, setCatFilter] = useSessionState('tasks.catFilter', '');
  const [newCategory, setNewCategory] = useSessionState<string>('tasks.new.category', '');
  // 智能分类：默认启用，根据标题智能匹配任务类型（应用于新建任务的自动分类）
  const [smartCat, setSmartCat] = usePersistentState('tasks.smartCat', true);
  // 新建任务进行中：全局 busy store，切页不丢失，防止请求进行中切页后再点重复插入
  const creating = useBusy('tasks.create');
  // 「AI 美化」按任务隔离的进行中集合：不同任务并行互不干扰，动画只作用于触发任务
  // 美化运行态/批量独占/标题草稿提升到模块级 store（T00396 路径2）：切页卸载不销毁，
  // in-flight 请求完成后回调照常写 store，回切页面即见最新运行指示与待确认草稿
  const beautifySnap = useSyncExternalStore(beautifyStore.subscribe, beautifyStore.getSnapshot);
  const beautifyBusy = beautifySnap.busy;
  // 「提示词优化」按任务隔离的进行中集合：作用域精准到单任务描述区，支持并行
  const [optimizingMap, setOptimizingMap] = useState<Record<string, boolean>>({});
  // 批量美化独占标识：批量进行期间不与单条并行，避免相互覆盖
  const batchBusy = beautifySnap.batchBusy;
  // 批量智能分类进行中标识：驱动工具条「批量分类」按钮的忙碌态
  const [classifyBusy, setClassifyBusy] = useState(false);
  // 进行中请求的取消控制器：美化已入 beautifyStore.aborts（模块级，切页存活）；提示词优化仍按页内隔离
  const optimizeAborts = useRef<Record<string, AbortController>>({});
  // 是否有美化类操作进行中（单条或批量）：驱动工具条「取消/批量美化」按钮
  const anyBeautify = batchBusy || Object.values(beautifyBusy).some(Boolean);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // taskId -> 待确认的梳理结果
  const [descDrafts, setDescDrafts] = useState<Record<string, string>>({}); // taskId -> 描述编辑草稿
  const titleDrafts = beautifySnap.drafts; // taskId -> 标题编辑草稿（美化结果/手动编辑共用，切页保留）
  const [imgDrafts, setImgDrafts] = useState<Record<string, ImageDraft>>({}); // taskId -> 图片增删草稿
  const [previewId, setPreviewId] = useState(''); // 当前放大预览的图片 id
  const [notice, setNotice] = useState('');
  // 刚完成"复制"的任务 id，用于按钮短暂显示"已复制✓"反馈
  const [copiedId, setCopiedId] = useState('');
  // 描述 展开/收起 状态：descExpanded 记录已展开的 taskId，默认收起不展示摘要，点标题行箭头展开看完整描述
  const [descExpanded, setDescExpanded] = useState<Record<string, boolean>>({});
  // AI 梳理摘要 展开/收起：与描述展开同风格（lucide 蓝色箭头），默认收起
  const [summaryExpanded, setSummaryExpanded] = useState<Record<string, boolean>>({});
  // 处理结果 草稿/展开状态：resultDrafts 存在即进入编辑态（有值时可点击「编辑」重新编辑）
  const [resultDrafts, setResultDrafts] = useState<Record<string, string>>({});
  // 处理结果 展开/收起：随任务行详情一起收起/展开，默认收起（有值也收起，点操作行图标展开）
  const [resultOpen, setResultOpen] = useState<Record<string, boolean>>({});
  // 「已完成」栏验证状态过滤：默认仅展示未验证，便于优先处理待核对的完成项；all=全部
  const [doneFilter, setDoneFilter] = useState<'all' | 'unverified' | 'verified'>('unverified');
  // AI 梳理工具下拉展开态：收起只显模型名收紧宽度，展开面板展示厂商名与厂商类型
  const [toolOpen, setToolOpen] = useState(false);
  // 待办/已完成区块排序：会话级偏好，默认保持后端顺序
  const [todoSort, setTodoSort] = useSessionState<'default' | 'timedesc' | 'timeasc' | 'pdesc' | 'pasc' | 'manual'>('tasks.todoSort', 'default');
  const [doneSort, setDoneSort] = useSessionState<'default' | 'timedesc' | 'timeasc' | 'pdesc' | 'pasc' | 'manual'>('tasks.doneSort', 'default');
  // T00456 / PRD UX-1：视图模式（列表/看板）会话级保持
  const [viewMode, setViewMode] = useSessionState<'list' | 'board'>('tasks.viewMode', 'list');
  // AI 美化工具下拉容器：焦点移出检测用（替代容器 tabIndex+onBlur，避免在非交互容器上挂交互属性）
  const toolSelectRef = useRef<HTMLDivElement>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  const loadProjects = useCallback(async () => {
    const list = await api.get<Project[]>('/projects');
    setProjects(list);
    if (list.length === 0) return;
    // 持久化的 activeProject 可能已失效（项目被删）：不在列表内则回退到首个有效项目并纠正持久化，避免反复踩空
    if (!activeProject || !list.some((p) => p.id === activeProject)) {
      setActiveProject(list[0].id);
    }
  }, [activeProject]);

  /**
   * 分页拉取任务。搜索/分类经后端过滤后再分页，保证分页下检索结果完整（而非只搜已加载页）；
   * offset=0 且 replace=true 为重置拉取（切项目/搜索/分类/操作后刷新），否则为追加下一页。
   */
  const fetchTasks = useCallback(async (projectId: string, offset: number, replace: boolean) => {
    if (!projectId) return;
    const p = new URLSearchParams({ projectId, limit: String(PAGE_SIZE) });
    if (offset > 0) p.set('offset', String(offset));
    const kw = search.trim();
    if (kw) p.set('keyword', kw);
    if (catFilter === 'none') p.set('categoryId', 'none');
    else if (catFilter) p.set('categoryId', catFilter);
    const list = await api.get<Task[]>(`/tasks?${p.toString()}`);
    const nextTodo = list.filter((t) => t.status === 'todo');
    const nextDone = list.filter((t) => t.status === 'done');
    setTodo((prev) => (replace ? nextTodo : [...prev, ...nextTodo]));
    setDone((prev) => (replace ? nextDone : [...prev, ...nextDone]));
    setHasMore(list.length === PAGE_SIZE);
  }, [search, catFilter]);

  const loadTasks = useCallback(async (projectId: string) => {
    if (!projectId) return;
    await fetchTasks(projectId, 0, true);
  }, [fetchTasks]);

  /** 加载更多：从已加载总数偏移处追加下一页（待办与已完成列表的最新长度在依赖中保证闭包最新） */
  const loadMore = useCallback(async () => {
    if (!activeProject || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      await fetchTasks(activeProject, todo.length + done.length, false);
    } finally {
      setLoadingMore(false);
    }
  }, [activeProject, loadingMore, hasMore, todo.length, done.length, fetchTasks]);

  const loadTools = useCallback(async () => {
    const list = await api.get<AITool[]>('/aitools');
    // 默认整理工具排最前，便于选择
    setTools([...list].sort((a, b) => Number(b.isDefaultOrganize) - Number(a.isDefaultOrganize)));
    // 持久化的 organizeToolId 可能已失效（工具被删）：不在列表内则回退默认整理工具，避免下拉空选
    const valid = list.some((t) => t.id === organizeToolId);
    if (!valid) {
      try {
        const defaults = await api.get<{ organize: string | null; develop: string | null }>('/aitools/defaults');
        const def = list.find((t) => t.id === defaults.organize) ?? list[0];
        if (def) setOrganizeToolId(def.id);
      } catch { /* 默认查询失败则保持空选 */ }
    }
  }, [organizeToolId]);

  const loadCategories = useCallback(async () => {
    // 分类下拉不因加载失败而阻塞任务页：失败时保持空列表，仅分类功能不可用
    try {
      setTaskCats(await api.get<TaskCategory[]>('/task-categories'));
    } catch { /* 忽略，任务页照常使用 */ }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  // 初始/切项目加载；搜索与分类变化会重建 loadTasks（经 fetchTasks 依赖透传），此处防抖 300ms 后重置分页拉取，
  // 避免搜索框逐击键都打后端
  useEffect(() => {
    if (!activeProject) return;
    const t = setTimeout(() => void loadTasks(activeProject), 300);
    return () => clearTimeout(t);
  }, [activeProject, loadTasks]);
  useEffect(() => { void loadTools(); }, [loadTools]);
  useEffect(() => { void loadCategories(); }, [loadCategories]);
  // T00433：MCP 回传 / 队列执行 / 其他窗口改任务状态时，前端无感知——轻量轮询对比签名，有变化才刷新。
  // 保护条件：任何未保存草稿或 AI 操作进行中时跳过本轮，避免打断用户编辑（变化留待下一轮干净窗口）。
  // T00457：批量操作——多选模式 + 选中任务集合（跨待办/已完成统一 id 集合）
  const [multiSelect, setMultiSelect] = useState(false);
  // T00446 / INT-6：CSV 导入预览状态
  const [csvPreview, setCsvPreview] = useState<{ items: Array<{ title: string; description: string; priority: string; status: string; categoryId: string | null; categoryName: string }>; errors: Array<{ row: number; message: string }> } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOpBusy, setBatchOpBusy] = useState(false);
  // T00446：任务列表拖拽排序（manual 排序模式下启用）
  const [dragTaskId, setDragTaskId] = useState('');
  const [overTaskId, setOverTaskId] = useState('');
  const externalSigRef = useRef('');
  useEffect(() => {
    if (!activeProject) return;
    const tick = async () => {
      const editing = Object.keys(titleDrafts).length > 0 || Object.keys(descDrafts).length > 0
        || Object.keys(resultDrafts).length > 0 || Object.keys(drafts).length > 0
        || Object.keys(imgDrafts).length > 0
        || anyBeautify || classifyBusy || Object.keys(optimizingMap).some(Boolean);
      if (editing) return;
      try {
        const list = await api.get<Task[]>(`/tasks?projectId=${activeProject}&archived=false`);
        const sig = list.map((t) => `${t.id}:${t.status}:${t.verified ? 1 : 0}:${t.updated_at}:${t.category_id ?? ''}:${t.priority}`).join('|');
        if (sig === externalSigRef.current) return;
        externalSigRef.current = sig;
        await loadTasks(activeProject);
      } catch { /* 后端瞬时不可达：忽略本轮 */ }
    };
    const id = setInterval(() => void tick(), 10000);
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [activeProject, loadTasks, titleDrafts, descDrafts, resultDrafts, drafts, imgDrafts, anyBeautify, classifyBusy, optimizingMap]);

  // T00444：SSE 实时变更通知——MCP 回传/队列自动回写/其他窗口的写库变更即时推送刷新，
  // 10s 轮询保留作断线兜底。React 渲染机制天然保护编辑态（行 key=id 稳定、受控草稿独立 state）
  useEffect(() => {
    if (!activeProject) return;
    return api.openChangeStream((kind) => {
      if (kind === 'tasks' || kind === 'queue' || kind === 'plans') {
        void loadTasks(activeProject);
        // 评审 P2-1 修复：选中项有效性校验移出 setState updater（原嵌套异步 setState 为反模式）；
        // 串行 SSE 通知下幂等：重复校验以 alive 集合为准，size 不变时返回原引用避免重渲染
        if (selectedIds.size > 0) {
          void api.get<Task[]>(`/tasks?projectId=${activeProject}&archived=false`).then((list) => {
            const alive = new Set(list.map((t) => t.id));
            setSelectedIds((prev) => {
              const next = new Set([...prev].filter((id) => alive.has(id)));
              return next.size === prev.size ? prev : next;
            });
          }).catch(() => undefined);
        }
      }
    });
  }, [activeProject, loadTasks, selectedIds]);
  // 工具下拉展开期间监听全局焦点移出：内部元素间切换时 relatedTarget 仍在容器内不收起，移出容器才收起。
  // 挂在 document 上而非容器 div，可避免为挂 onBlur 而给非交互容器加 tabIndex/role
  useEffect(() => {
    if (!toolOpen) return;
    const onDocFocusOut = (e: FocusEvent) => {
      if (toolSelectRef.current && !toolSelectRef.current.contains(e.relatedTarget as Node)) setToolOpen(false);
    };
    document.addEventListener('focusout', onDocFocusOut);
    return () => document.removeEventListener('focusout', onDocFocusOut);
  }, [toolOpen]);

  async function createProject() {
    const name = await askInput({ title: '新项目名称', placeholder: '请输入项目名称' });
    if (!name) return;
    await api.post('/projects', { name });
    setActiveProject('');
    void loadProjects();
  }

  /** 修改当前项目名称：弹输入框预填当前名称，确认后 PATCH 更新并刷新列表。
   *  项目 id 不变故不改 activeProject，仅由 loadProjects 反映到下拉框名称。 */
  async function renameProject() {
    if (!activeProject) return flash('请先选择要修改的项目');
    const proj = projects.find((p) => p.id === activeProject);
    if (!proj) return;
    const name = await askInput({ title: '修改项目名称', placeholder: '请输入项目名称', defaultValue: proj.name });
    if (!name || name.trim() === proj.name) return;
    try {
      await api.patch(`/projects/${proj.id}`, { name: name.trim() });
      void loadProjects();
      flash(`已修改项目名称为「${name.trim()}」`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 删除项目：风险操作。先弹确认框（说明不可恢复 + 任务将一并删除），确认后再删除。
   *  删除成功后当前项目已被移除：清空 activeProject 使 loadProjects 自动回退到首个有效项目，避免挂到不存在的项目上。 */
  async function deleteProject() {
    if (!activeProject) return flash('请先选择要删除的项目');
    const proj = projects.find((p) => p.id === activeProject);
    if (!proj) return;
    // 系统收件箱是移动端随手记默认归属，后端已禁止删除；前端提前拦截给出与后端一致的明确提示
    if (proj.id === 'sys-inbox') return flash('系统收件箱项目不可删除');
    const ok = await askConfirm(
      `确定要删除项目「${proj.name}」吗？\n\n⚠️ 风险提醒：\n该操作不可恢复，项目及其全部任务、截图将一并删除！\n建议先通过「任务 → 复用」将重要任务复制到其他项目再删除。`,
    );
    if (!ok) return;
    try {
      await api.del(`/projects/${proj.id}`);
    } catch (e) {
      return flash(e instanceof Error ? e.message : String(e));
    }
    setActiveProject('');
    void loadProjects();
    flash(`已删除项目「${proj.name}」`);
  }

  /** 拉取提示词分类供复用弹窗选择（懒加载：仅在需要展示时调用，失败不阻塞任务页） */
  const loadPromptCats = useCallback(async () => {
    try {
      setPromptCats(await api.get<PromptCategory[]>('/prompt-categories'));
    } catch { /* 提示词分类加载失败仅导致无法复制到提示词，不影响原有任务功能 */ }
  }, []);

  /** 拉取通用需求分类供复用弹窗选择（懒加载，打开弹窗时拉取；失败不阻塞任务页） */
  const loadReqCats = useCallback(async () => {
    try {
      setReqCats(await api.get<ReqCategory[]>('/req-categories'));
    } catch { /* 通用需求分类加载失败仅导致无法复制到通用需求 */ }
  }, []);

  /** 复用弹窗内新建提示词分类：建好后自动选中，便于把任务资产立即落入新分类 */
  async function addPromptCat() {
    const name = await askInput({ title: '新建提示词分类', placeholder: '请输入分类名称' });
    if (!name) return;
    try {
      const created = await api.post<PromptCategory>('/prompt-categories', { name });
      await loadPromptCats();
      setReuseCategoryId(created.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 复用弹窗内新建通用需求分类：建好后自动选中，便于把任务资产立即落入新分类 */
  async function addReqCat() {
    const name = await askInput({ title: '新建通用需求分类', placeholder: '请输入分类名称' });
    if (!name) return;
    try {
      const created = await api.post<ReqCategory>('/req-categories', { name });
      await loadReqCats();
      setReuseCategoryId(created.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function createTask() {
    if (!newTitle.trim() || !activeProject) return;
    // 全程置 creating，按钮转圈禁用，避免智能分类等耗时步骤看起来"卡住"
    setBusy('tasks.create', true);
    try {
      // 智能分类开启时：按标题自动匹配分类；未匹配/失败则回退用户手动选择的分类（不阻塞创建）
      const autoCat = smartCat ? await matchCategory(newTitle) : undefined;
      const created = await api.post<Task>('/tasks', {
        projectId: activeProject,
        title: newTitle.trim(),
        priority: newPriority,
        categoryId: (autoCat ?? newCategory) || undefined,
        description: newDesc.trim() || undefined,
      });
      // 创建时粘贴的截图随后上传到新任务
      for (const img of newImages) {
        await api.post(`/tasks/${created.id}/images`, { data: img.url });
      }
      setNewTitle('');
      setNewDesc('');
      setNewImages([]);
      setNewDescOpen(false);
      // 提交成功后清空持久化的表单缓存，避免残留旧录入内容
      clearSessionState('tasks.new.title');
      clearSessionState('tasks.new.priority');
      clearSessionState('tasks.new.desc');
      clearSessionState('tasks.new.images');
      clearSessionState('tasks.new.descOpen');
      clearSessionState('tasks.new.category');
      void loadTasks(activeProject);
    } finally {
      setBusy('tasks.create', false);
    }
  }

  /** 行内切换任务分类：立即保存；null 表示回到未分类 */
  async function setTaskCategory(task: Task, categoryId: string) {
    try {
      await api.patch(`/tasks/${task.id}`, { categoryId: categoryId || null });
      void loadTasks(activeProject);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 置顶/取消置顶：切换后重新拉取，置顶项紧随各自待办/已完成分组顶部；失败时静默，由列表重载兜底 */
  async function togglePin(task: Task) {
    try {
      await api.patch(`/tasks/${task.id}`, { pinned: !task.pinned });
      void loadTasks(activeProject);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function setStatus(task: Task, status: 'todo' | 'done') {
    await api.patch(`/tasks/${task.id}`, { status });
    // 切换完成后自动收起展开区（描述+AI 摘要）：仅当处于展开态才触发更新，避免无关任务行无谓重渲染
    setDescExpanded((prev) => (prev[task.id] ? { ...prev, [task.id]: false } : prev));
    setSummaryExpanded((prev) => (prev[task.id] ? { ...prev, [task.id]: false } : prev));
    void loadTasks(activeProject);
  }

  /** FR5 已完成任务：切换未验证/已验证。图标每次变化用起局部重挂载播放弹出动画 */
  async function toggleVerified(task: Task) {
    await api.patch(`/tasks/${task.id}`, { verified: !task.verified });
    void loadTasks(activeProject);
  }

  /** FR1.3 修改优先级 */
  async function setPriority(task: Task, priority: string) {
    await api.patch(`/tasks/${task.id}`, { priority });
    void loadTasks(activeProject);
  }

  async function archive(task: Task) {
    await api.post('/archive', { taskIds: [task.id] });
    void loadTasks(activeProject);
  }

  /** 智能分类（静默）：按标题从候选分类匹配最贴切分类 id；未配工具/未填标题/失败均返回 undefined，不打断创建流程 */
  async function matchCategory(title: string): Promise<string | undefined> {
    if (!organizeToolId || !title.trim() || taskCats.length === 0) return undefined;
    try {
      const r = await api.post<{ ok: boolean; categoryId?: string | null; error?: string }>('/tasks/classify', {
        title: title.trim(),
        toolId: organizeToolId,
        categories: taskCats.map((c) => ({ id: c.id, name: c.name })),
      });
      return r.ok && r.categoryId ? r.categoryId : undefined;
    } catch {
      return undefined;
    }
  }

  /** 单条标题美化：调 AI 润色该任务标题，结果写入标题编辑草稿，用户确认后保存。
   *  按任务隔离并发：不同任务各自独立进行，同一任务重复点击仅在批量中阻断；统一可经顶部「取消」中断。 */
  async function beautify(task: Task) {
    if (batchBusy) return flash('正在进行批量美化，请先在工具栏取消');
    if (beautifyBusy[task.id]) return flash('该任务正在美化，请稍候');
    if (!organizeToolId) return flash('请先在「模型管理」页添加并选择美化工具');
    if (!task.title.trim()) return flash('该任务无标题可美化');
    const ac = new AbortController();
    beautifyStore.aborts[task.id] = ac;
    beautifyStore.setBusy(task.id);
    try {
      const result = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/beautify', {
        toolId: organizeToolId, title: task.title,
      }, ac.signal);
      if (!result.ok) return flash(result.error ?? '美化失败');
      if (!result.content?.trim()) return flash('AI 未返回美化标题');
      // 进入标题编辑态，让用户确认后保存（复用 titleDrafts + saveTitle）；写模块级 store，切页后草稿仍保留
      beautifyStore.setDraft(task.id, result.content!.trim());
      flash('美化完成，可编辑后保存');
    } catch (e) {
      // 用户主动取消时静默，不弹错误
      if ((e as Error).name !== 'AbortError') flash(e instanceof Error ? e.message : String(e));
    } finally {
      beautifyStore.clearBusy(task.id);
      delete beautifyStore.aborts[task.id];
    }
  }

  /** 取消全部 AI 美化（单条 + 批量）：统一从工具栏入口调用，遍历各任务独立中止；已编辑草稿保留 */
  function cancelBeautify() {
    if (!anyBeautify) return;
    beautifyStore.cancelAll();
    flash('已取消美化');
  }

  /** 批量美化项目全部待办标题：逐条调用，结果分别写入各标题编辑草稿供逐条确认。
   *  批量独占：进行期间禁止新单条/新批量，避免各实例写草稿相互覆盖；统一经工具栏取消。 */
  async function beautifyAll() {
    if (anyBeautify) return flash('正在进行 AI 美化，请先在工具栏取消');
    if (!organizeToolId) return flash('请先在「模型管理」页添加并选择美化工具');
    if (todo.length === 0) return flash('当前项目没有待办任务');
    if (!(await askConfirm(`将对 ${todo.length} 个待办任务执行标题美化，确认？`))) return;
    const ac = new AbortController();
    beautifyStore.aborts['__batch__'] = ac;
    beautifyStore.setBatchBusy(true);
    try {
      const tasks = [...todo];
      const results = await Promise.all(tasks.map(async (t) => {
        const r = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/beautify', {
          toolId: organizeToolId, title: t.title,
        }, ac.signal);
        return { taskId: t.id, ok: r.ok, content: r.content };
      }));
      // 取消时 Promise.all 会随 signal 中断，进入 catch；正常完成才统计
      const ok = results.filter((r) => r.ok && r.content?.trim());
      const next: Record<string, string> = {};
      for (const r of ok) next[r.taskId] = r.content!.trim();
      beautifyStore.mergeDrafts(next);
      flash(`美化完成 ${ok.length}/${tasks.length} 条，请逐条确认保存`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') flash(e instanceof Error ? e.message : String(e));
    } finally {
      beautifyStore.setBatchBusy(false);
      delete beautifyStore.aborts['__batch__'];
    }
  }

  /** 工具栏美化按钮统一入口：进行中点击=取消全部，否则批量美化（独立函数保持 JSX 简洁且避免表达式内 void） */
  function handleBeautifyToggle() {
    if (anyBeautify) {
      cancelBeautify();
      return;
    }
    beautifyAll();
  }

  /** T00450：创建子任务——挂到父任务下，渲染时缩进紧随父行 */
  async function createSubTask(parent: Task) {
    const title = await askInput({ title: `为「${parent.title}」创建子任务`, placeholder: '子任务标题' });
    if (!title?.trim()) return;
    try {
      await api.post('/tasks', { projectId: parent.project_id, title: title.trim(), parentId: parent.id });
      void loadTasks(activeProject);
      flash('子任务已创建');
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  // ---------- T00457：批量操作（多选后批量改状态/分类/归档，单事务整体回滚） ----------

  function dropTaskReorder(kind: 'todo' | 'done', listIds: string[], targetId: string) {
    if (!dragTaskId || dragTaskId === targetId) { setDragTaskId(''); setOverTaskId(''); return; }
    const ids = [...listIds];
    const from = ids.indexOf(dragTaskId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragTaskId(''); setOverTaskId('');
    void api.post('/tasks/reorder', { orderedIds: ids }).then(() => {
      flash('顺序已保存（手动排序模式下持久生效）');
      void loadTasks(activeProject);
    }).catch((e) => flash(String((e as Error).message ?? e)));
  }

  // ---------- T00446 / INT-6：CSV 任务导入（预览 → 确认） ----------

  async function onCsvFile(file: File) {
    if (!activeProject) return flash('请先选择项目');
    setBatchOpBusy(true);
    try {
      const text = await file.text();
      const r = await api.post<{ items: Array<{ title: string; description: string; priority: string; status: string; categoryId: string | null; categoryName: string }>; errors: Array<{ row: number; message: string }> }>(`/tasks/import-csv/preview?projectId=${activeProject}`, { csvText: text });
      setCsvPreview(r);
      if (r.errors.length > 0) flash(`CSV 解析：${r.items.length} 条可导入，${r.errors.length} 行有问题——修正后重新上传`);
      else flash(`CSV 解析完成：${r.items.length} 条待确认导入`);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBatchOpBusy(false); }
  }

  async function confirmCsvImport() {
    if (!csvPreview || !activeProject) return;
    setBatchOpBusy(true);
    try {
      const r = await api.post<{ ok: boolean; count: number }>('/tasks/import-csv/confirm', { projectId: activeProject, items: csvPreview.items });
      setCsvPreview(null);
      void loadTasks(activeProject);
      flash(`CSV 导入完成：${r.count} 条任务已创建`);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBatchOpBusy(false); }
  }

  async function batchApply(action: 'status' | 'category' | 'archive', value?: string) {
    const ids = [...selectedIds];
    if (ids.length === 0) return flash('请先勾选任务');
    setBatchOpBusy(true);
    try {
      const r = await api.post<{ ok: boolean; affected: number }>('/tasks/batch', { ids, action, value });
      flash(`批量操作完成：${r.affected} 条已更新`);
      setSelectedIds(new Set());
      void loadTasks(activeProject);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally { setBatchOpBusy(false); }
  }

  async function batchSetCategory() {
    const cat = await askInput({ title: `为选中的 ${selectedIds.size} 个任务设置分类（输入分类名，留空=未分类）`, placeholder: '如：开发' });
    if (cat === null) return;
    const target = taskCats.find((c) => c.name.trim() === cat.trim());
    if (cat.trim() && !target) return flash(`分类「${cat}」不存在，请先在「任务分类」中创建`);
    await batchApply('category', target?.id ?? '');
  }

  /** T00456 / PRD UX-1：看板视图——按状态分列（待办/已完成），卡片拖拽流转状态。
   *  卡片为简化渲染（标题/优先级/分类/进度），编辑回列表视图；drop 到目标列即变更状态。 */
  function renderBoard() {
    const boardCols: Array<{ key: 'todo' | 'done'; label: string; items: Task[] }> = [
      { key: 'todo', label: `待办（${todo.length}）`, items: todo },
      { key: 'done', label: `已完成（${done.length}）`, items: done },
    ];
    const onDropTo = (target: 'todo' | 'done') => {
      if (!dragTaskId) return;
      const t = [...todo, ...done].find((x) => x.id === dragTaskId);
      if (!t) return;
      if (t.status !== target) void setStatus(t, target);
      setDragTaskId(''); setOverTaskId('');
    };
    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {boardCols.map((col) => (
          <div key={col.key}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDropTo(col.key)}
            style={{ flex: 1, minWidth: 280, background: 'var(--surface)', borderRadius: 8, padding: 10, minHeight: 200, border: overTaskId === col.key ? '2px dashed var(--accent)' : '1px solid var(--border-strong)', transition: 'border .15s ease' }}>
            <h4 style={{ fontSize: 13, margin: '0 0 8px', color: 'var(--text-secondary)' }}>{col.label}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {col.items.map((t) => (
                <div key={t.id}
                  draggable
                  onDragStart={() => setDragTaskId(t.id)}
                  onDragEnd={() => { setDragTaskId(''); setOverTaskId(''); }}
                  className={dragTaskId === t.id ? 'plan-dragging' : undefined}
                  style={{
                    border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', background: 'var(--card-bg)', cursor: 'grab',
                    borderLeft: `3px solid ${t.priority === 'high' ? 'var(--danger)' : t.priority === 'low' ? 'var(--border-strong)' : 'var(--accent)'}`,
                  }}
                  title={`${t.title}（${t.priority === 'high' ? '高优先级' : t.priority === 'low' ? '低优先级' : '普通优先级'}）——拖到另一列流转状态`}>
                  <div style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                  {t.category_id && taskCats.find((c) => c.id === t.category_id) && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{taskCats.find((c) => c.id === t.category_id)?.name}</div>
                  )}
                </div>
              ))}
              {col.items.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>拖任务卡片到此列</div>}
            </div>
          </div>
        ))}
      </div>
    );
  }

  /** 批量操作条：multiSelect 且有选中时浮出（样式与任务行一致） */
  function renderBatchBar() {
    if (!multiSelect || selectedIds.size === 0) return null;
    return (
      <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', margin: '8px 0', borderRadius: 8, background: 'var(--card-bg)', border: '1px solid var(--accent)', boxShadow: '0 4px 12px rgba(0,0,0,.12)', fontSize: 12 }}>
        <strong>已选 {selectedIds.size} 条</strong>
        <button onClick={() => void batchApply('status', 'done')} disabled={batchOpBusy} className="task-op" style={{ cursor: 'pointer', padding: '3px 8px' }}>✓ 完成</button>
        <button onClick={() => void batchApply('status', 'todo')} disabled={batchOpBusy} className="task-op" style={{ cursor: 'pointer', padding: '3px 8px' }}>↩ 重开</button>
        <button onClick={() => void batchSetCategory()} disabled={batchOpBusy} className="task-op" style={{ cursor: 'pointer', padding: '3px 8px' }}>设分类</button>
        <button onClick={() => void batchApply('archive')} disabled={batchOpBusy} className="task-op" style={{ cursor: 'pointer', padding: '3px 8px', color: 'var(--danger)' }}>归档</button>
        <button onClick={() => setSelectedIds(new Set())} disabled={batchOpBusy} className="task-op" style={{ cursor: 'pointer', padding: '3px 8px', marginLeft: 'auto' }}>取消选择</button>
      </div>
    );
  }

  /** 批量智能分类：一键对当前项目全部未分类任务（待办 + 已完成，T00432）做 AI 语义识别自动分到已有分类。
   *  逐个复用 matchCategory 得到最贴切分类，命中即写回 category_id；无工具/无未分类任务/全失败都给明确反馈。 */
  async function batchClassify() {
    if (classifyBusy) return flash('正在批量分类中，请稍候');
    if (!organizeToolId) return flash('请先在「模型管理」页添加并选择整理工具');
    // T00432：分类范围包含已完成任务——未分类的待办与已完成一并纳入
    const target = [...todo, ...done].filter((t) => !t.category_id && t.title.trim());
    if (target.length === 0) return flash('当前项目没有未分类的任务');
    if (!(await askConfirm(`将对 ${target.length} 个未分类任务（含已完成）执行批量智能分类，确认？`))) return;
    setClassifyBusy(true);
    let hit = 0;
    try {
      // 逐个识别并写回：命中才算成功，未命中保持未分类状态，不中断批量
      for (const t of target) {
        const catId = await matchCategory(t.title);
        if (!catId) continue;
        await api.patch(`/tasks/${t.id}`, { categoryId: catId });
        hit++;
      }
      flash(hit > 0 ? `批量分类完成 ${hit}/${target.length} 条` : '未能为这些任务匹配到合适分类');
      void loadTasks(activeProject);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setClassifyBusy(false);
    }
  }

  /** 提示词优化：调 AI 把当前描述草稿改写为结构化提示词，结果写回草稿供确认后保存。
   *  输入源判定：描述输入框为空时回退取用标题作为输入，并在反馈中标注本次来源。
   *  按任务隔离并支持并行；同一任务再次点击视为「取消」。 */
  async function optimizeDesc(task: Task) {
    if (optimizingMap[task.id]) return cancelOptimize(task.id);
    if (!organizeToolId) return flash('请先在「模型管理」页添加并选择工具');
    // 描述输入框有草稿用草稿，否则用已保存的描述；原样透传，不增删内容
    let text = descDrafts[task.id] ?? task.description ?? '';
    // 仅当描述输入框为空时回退到标题，作为本次优化输入；否则标题只作辅助展示
    const source = text.trim() ? '描述' : '标题';
    if (!text.trim()) text = task.title;
    if (!text.trim()) return flash('请先填写任务描述或标题再优化');
    const ac = new AbortController();
    optimizeAborts.current[task.id] = ac;
    setOptimizingMap((p) => ({ ...p, [task.id]: true }));
    try {
      const result = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/optimize', {
        toolId: organizeToolId, title: task.title, description: text,
      }, ac.signal);
      if (!result.ok) return flash(result.error ?? '优化失败');
      // 大模型常把结果包在 ```markdown ... ``` 代码围栏里，写回草稿前剥离，避免落库/渲染时多出围栏
      const content = stripCodeFence(result.content ?? '');
      setDescDrafts((prev) => ({ ...prev, [task.id]: content }));
      flash(`提示词优化完成（输入来源：${source}），可编辑后保存`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') flash(e instanceof Error ? e.message : String(e));
    } finally {
      setOptimizingMap((p) => { const n = { ...p }; delete n[task.id]; return n; });
      delete optimizeAborts.current[task.id];
    }
  }

  /** 取消指定任务的提示词优化：仅中止该任务，不影响其它并行优化 */
  function cancelOptimize(taskId: string) {
    if (!optimizingMap[taskId]) return;
    optimizeAborts.current[taskId]?.abort();
    setOptimizingMap((p) => { const n = { ...p }; delete n[taskId]; return n; });
    delete optimizeAborts.current[taskId];
    flash('已取消优化');
  }

  /** FR2.3 用户确认：把草稿回填为任务的 ai_summary */
  async function saveDraft(task: Task) {
    const content = drafts[task.id];
    if (!content) return;
    await api.patch(`/tasks/${task.id}`, { aiSummary: content });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    void loadTasks(activeProject);
    flash('梳理结果已保存到任务');
  }

  /** FR1.3 标题编辑：展开/收起标题编辑态（有草稿视为编辑中）；草稿入 beautifyStore，切页保留 */
  function toggleTitleEdit(task: Task) {
    const prev = beautifyStore.getSnapshot().drafts[task.id];
    beautifyStore.setDraft(task.id, prev === undefined ? task.title : undefined);
  }

  /** FR1.3 保存标题 */
  async function saveTitle(task: Task) {
    const content = titleDrafts[task.id];
    if (content === undefined) return;
    if (!content.trim()) return flash('标题不能为空');
    try {
      await api.patch(`/tasks/${task.id}`, { title: content.trim() });
    } catch (e) {
      return flash(e instanceof Error ? e.message : String(e));
    }
    beautifyStore.setDraft(task.id, undefined); // 保存成功即退出编辑态（清草稿）
    void loadTasks(activeProject);
    flash('任务标题已更新');
  }

  /** 复用任务到所选目标：项目=复制；提示词=打包为 JSON 资产写入提示词分类；需求=打包为通用需求条目 */
  async function reuseTask() {
    // 未选中目标任务或所选目标对应选择为空时直接返回，提前避免无效请求
    if (!reuseOpen || (reuseTarget === 'project' ? !reuseProjectId : !reuseCategoryId)) return;
    setBusy('tasks.reuse', true);
    try {
      if (reuseTarget === 'project') {
        await api.post(`/tasks/${reuseOpen}/reuse`, { projectId: reuseProjectId });
        const target = projects.find((p) => p.id === reuseProjectId)?.name ?? '';
        flash(`已复用任务到「${target || '目标项目'}」`);
      } else if (reuseTarget === 'prompt') {
        await api.post(`/tasks/${reuseOpen}/to-prompt`, { categoryId: reuseCategoryId });
        const cat = promptCats.find((c) => c.id === reuseCategoryId)?.name ?? '';
        flash(`已复制任务到提示词「${cat || '该分类'}」`);
      } else {
        await api.post(`/tasks/${reuseOpen}/to-req`, { categoryId: reuseCategoryId });
        const cat = reqCats.find((c) => c.id === reuseCategoryId)?.name ?? '';
        flash(`已复制任务到通用需求「${cat || '该分类'}」`);
      }
      setReuseOpen(null);
      setReuseProjectId('');
      setReuseSearch('');
      setReuseCategoryId('');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('tasks.reuse', false);
    }
  }

  /** 复制单张图片到剪贴板（渲染进程 fetch blob 后写入 ClipboardItem） */
  async function copyImage(img: TaskImage) {
    try {
      const blob = await fetchImage(img.id);
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      flash('图片已复制');
    } catch {
      flash('复制图片失败，请手动保存图片');
    }
  }

  /** 复制任务内容（标题 + 描述，含 AI 摘要）；连同任务全部截图以富文本 <img> 写入，粘贴到富文本编辑器会带图。
   *  clipboard API 写多类型受限时降级为仅复制纯文本。 */
  async function copyTaskContent(t: Task) {
    const parts = [`# ${t.title}`];
    if (t.description) parts.push(t.description);
    if (t.ai_summary) parts.push(`AI 梳理摘要：\n${t.ai_summary}`);
    const text = parts.join('\n\n');
    // 标题必有内容，但保留防御性判空，避免空字符串复制给出「已复制」误导
    if (!text.trim()) return flash('无内容可复制');
    const ok = () => {
      setCopiedId(t.id);
      // 1.8s 后复位「已复制」反馈：经独立函数按 id 比对，仅当仍展示本任务时才清空
      setTimeout(() => clearCopiedIfMatching(t.id), 1800);
      flash('任务内容已复制');
    };
    // 组装富文本 HTML（含任务截图 dataURL），便于在 Word/富文本编辑器粘贴时带上截图
    const buildHtml = async (): Promise<string> => {
      const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      // 内联 dataURL 体积上限：累计超过即跳过剩余图片，避免 ClipboardItem 写入超限使整份复制降级为纯文本
      const MAX_INLINED_BYTES = 12 * 1024 * 1024;
      let html = `<h1>${esc(t.title)}</h1>`;
      if (t.description) html += `<p>${esc(t.description).replaceAll('\n', '<br/>')}</p>`;
      if (t.ai_summary) html += `<p><b>AI 梳理摘要：</b><br/>${esc(t.ai_summary).replaceAll('\n', '<br/>')}</p>`;
      let inlinedBytes = 0;
      for (const img of t.images) {
        if (inlinedBytes >= MAX_INLINED_BYTES) break;   // 超限则放弃剩余截图，保持单次粘贴可行
        try {
          const dataUrl = await imageDataURL(img.id);
          // 用图片元数据 size（若缺则按 dataURL 长度近似）累计，逼近剪贴板可承载的真实体积
          inlinedBytes += img.size || Math.ceil((dataUrl.length * 3) / 4);
          html += `<div><img src="${dataUrl}" style="max-width:100%"/></div>`;
        } catch { /* 单图读取失败不阻塞整体复制 */ }
      }
      return html;
    };
    try {
      if (t.images.length > 0) {
        const html = await buildHtml();
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
        ok();
        return;
      }
      await navigator.clipboard.writeText(text);
      ok();
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        // Clipboard API 不可用时的降级复制：execCommand 虽已废弃，但仍是浏览器仅存的同步复制手段
        document.execCommand('copy'); // NOSONAR - 降级路径无未废弃替代 API
        ok();
      } catch {
        flash('复制失败，请手动选择文本复制');
      }
      ta.remove();
    }
  }

  /** 「已复制」反馈复位：仅当当前展示的仍是该任务时才清空，避免覆盖用户随后复制的其他任务 */
  function clearCopiedIfMatching(taskId: string) {
    setCopiedId((cur) => (cur === taskId ? '' : cur));
  }

  /** FR1.3 描述编辑：展开/收起描述编辑区（收起时丢弃图片草稿） */
  function toggleDescEdit(task: Task) {
    setDescDrafts((prev) => {
      const next = { ...prev };
      if (next[task.id] === undefined) {
        next[task.id] = task.description ?? '';
      } else {
        delete next[task.id];
        setImgDrafts((p) => {
          const n = { ...p };
          delete n[task.id];
          return n;
        });
      }
      return next;
    });
  }

  /** FR1.3 保存描述（含截图：新增的粘贴图上传、标记删除的图片移除） */
  async function saveDesc(task: Task) {
    const content = descDrafts[task.id];
    if (content === undefined) return;
    const imgDraft = imgDrafts[task.id];
    try {
      await api.patch(`/tasks/${task.id}`, { description: content });
      if (imgDraft) {
        for (const img of imgDraft.added) await api.post(`/tasks/${task.id}/images`, { data: img.url });
        for (const id of imgDraft.removed) await api.del(`/images/${id}`);
      }
    } catch (e) {
      return flash(e instanceof Error ? e.message : String(e));
    }
    setDescDrafts((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    setImgDrafts((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    void loadTasks(activeProject);
    flash('任务描述已保存');
  }

  /** 保存处理结果：PATCH handleResult 落库后清空草稿退出编辑态。
   *  支持空值保存（清空处理结果），故不判空；失败回显后端错误。 */
  async function saveResult(task: Task) {
    const content = resultDrafts[task.id];
    if (content === undefined) return;
    try {
      await api.patch(`/tasks/${task.id}`, { handleResult: content });
    } catch (e) {
      return flash(e instanceof Error ? e.message : String(e));
    }
    setResultDrafts((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    void loadTasks(activeProject);
    flash('处理结果已保存');
  }

  /** 进入处理结果编辑态：草稿预填现有值，便于基于原内容修改 */
  function startEditResult(task: Task) {
    setResultDrafts((prev) => ({ ...prev, [task.id]: task.handle_result ?? '' }));
  }

  /** 编辑态：标记删除已有图片（保存后生效，替换 = 删除后重新粘贴） */
  function markImageRemoved(taskId: string, imageId: string) {
    setImgDrafts((prev) => {
      const cur = prev[taskId] ?? { added: [], removed: [] };
      if (cur.removed.includes(imageId)) return prev;
      return { ...prev, [taskId]: { ...cur, removed: [...cur.removed, imageId] } };
    });
  }

  /** 编辑态：把粘贴截图加入待上传草稿（入列时生成稳定 id，供列表 key 使用） */
  function addPastedImage(taskId: string, url: string) {
    setImgDrafts((prev) => {
      const cur = prev[taskId] ?? { added: [], removed: [] };
      return { ...prev, [taskId]: { ...cur, added: [...cur.added, { id: newPastedImageId(), url }] } };
    });
  }

  /** 编辑态：移除尚未上传的粘贴截图（按稳定 id 而非下标定位，删除中间项不影响其余项身份） */
  function removeAddedImage(taskId: string, pasteId: string) {
    setImgDrafts((prev) => {
      const cur = prev[taskId];
      if (!cur) return prev;
      return { ...prev, [taskId]: { ...cur, added: cur.added.filter((p) => p.id !== pasteId) } };
    });
  }

  /** 新建任务区：把粘贴截图加入待上传列表 */
  function addNewImage(url: string) {
    setNewImages((prev) => [...prev, { id: newPastedImageId(), url }]);
  }

  /** 新建任务区：移除尚未上传的粘贴截图 */
  function removeNewImage(pasteId: string) {
    setNewImages((prev) => prev.filter((p) => p.id !== pasteId));
  }

  /** 紧凑时间：ISO → 'MM-DD HH:mm'，用于列表行内展示，减少同屏重复信息的视觉重量 */
  const fmtShort = (iso: string) => (iso ? iso.slice(5, 16).replace('T', ' ') : '');

  /** 任务行标题行：完成状态/验证/置顶/标题，标题独占剩余宽度以示强调 */
  function renderTaskTitleRow(t: Task, titleEditing: boolean) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {multiSelect && (
          <input type="checkbox" checked={selectedIds.has(t.id)} aria-label={`选中任务 ${t.title}`}
            onChange={(e) => setSelectedIds((prev) => { const n = new Set(prev); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })}
            style={{ cursor: 'pointer', flexShrink: 0 }} />
        )}
        <button title="切换任务完成状态" aria-label="切换任务完成状态" onClick={() => void setStatus(t, t.status === 'todo' ? 'done' : 'todo')} style={{ cursor: 'pointer' }}>
          {t.status === 'todo' ? '☐' : '☑'}
        </button>
        {/* 仅已完成任务展示验证状态 */}
        {t.status === 'done' && renderVerifyButton(t)}
        {/* AI 回写待审核图标：标题带【AI回写待审核】前缀的任务展示（视觉基准对齐验证图标），
            点击同时展开任务描述与处理结果，便于人工审核 AI 回写的修复建议 */}
        {t.title.startsWith('【AI回写待审核】') && (
          <button
            onClick={() => {
              setDescExpanded((p) => ({ ...p, [t.id]: true }));
              setResultOpen((p) => ({ ...p, [t.id]: true }));
              flash('已展开描述与处理结果，审核通过后请编辑标题移除「【AI回写待审核】」前缀');
            }}
            title="AI 回写待审核 — 点击展开该任务的描述与处理结果；审核通过后编辑标题移除前缀即可恢复正常展示"
            aria-label="AI 回写待审核：展开描述与处理结果供人工审核"
            className="verify-icon"
            style={{ cursor: 'pointer', fontSize: 16, lineHeight: 1, border: 'none', background: 'transparent', color: 'var(--accent)' }}
          >
            <ScanSearch size={13} style={{ verticalAlign: '-2px' }} />
          </button>
        )}
        {/* 置顶/取消置顶图标：置于标题最左侧 */}
        <span className="task-op" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <PinToggle pinned={t.pinned} onToggle={() => void togglePin(t)} />
        </span>
        {/* 任务编号徽标：全局唯一，供 AI Agent 通过 MCP 按编号定位任务（titletip 说明可复制） */}
        {t.task_no && (
          <span /* NOSONAR - 任务编号徽标「双击复制」为便捷操作，文本可选中复制，无需拉链为可聚焦交互控件 */
            title={`任务编号 ${t.task_no} — 供 MCP 按编号定位任务；双击复制`}
            aria-label={`任务编号 ${t.task_no}`}
            onDoubleClick={() => void navigator.clipboard.writeText(t.task_no!).then(() => flash(`已复制任务编号 ${t.task_no}`))}
            style={{ fontSize: 11, color: 'var(--accent)', background: 'var(--accent-soft)', padding: '0 5px', borderRadius: 4, lineHeight: '18px', whiteSpace: 'nowrap', cursor: 'default', userSelect: 'text' }}
          >
            {t.task_no}
          </span>
        )}
        {/* T00462/T00451：计划联动任务区分徽标——悬浮显示来源计划标题（反向引用） */}
        {t.fromPlanTitle && (
          <span title={`计划联动任务 — 来源计划：${t.fromPlanTitle}；完成状态与项目计划双向同步`}
            aria-label="计划联动任务"
            style={{ fontSize: 10, color: 'var(--text-muted)', border: '1px solid var(--border-strong)', padding: '0 4px', borderRadius: 4, lineHeight: '16px', whiteSpace: 'nowrap', cursor: 'default' }}>
            计划
          </span>
        )}
        {renderTaskTitle(t, titleEditing)}
      </div>
    );
  }

  /** 任务行元信息/操作行：优先级/分类/功能按钮组靠右，与记录时间同行。
   *  标题行的按钮与下拉整体从标题行下移到此，标题占满整行更醒目，功能按钮也获得更多横向空间。 */
  function renderTaskMetaRow(t: Task, titleEditing: boolean, descEditing: boolean) {
    // 处理结果按钮文案/无障碍标签：未编辑→(已录入=修改，未录入=添加)、编辑中→取消；顺序 if 避免嵌套三元与否定条件
    const resultBtnLbl = (() => {
      if (resultDrafts[t.id] === undefined) {
        return t.handle_result
          ? { title: '修改处理结果 — 编辑该任务已录入的处理结果（取消可恢复原内容）', aria: '修改处理结果：编辑该任务已录入的处理结果' }
          : { title: '添加处理结果 — 记录根因/解决方案等处理结论', aria: '添加处理结果：记录根因/解决方案等处理结论' };
      }
      return { title: '取消编辑处理结果 — 放弃未保存的修改', aria: '取消编辑处理结果：放弃未保存的修改' };
    })();
    return (
      <div className="task-op" style={{ marginLeft: 32, marginTop: 2, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        {/* 优先级三级（低/中/高）：置于 AI 梳理按钮之前，便于优先调整重要度 */}
        <select
          value={t.priority}
          onChange={(e) => void setPriority(t, e.target.value)}
          className="task-op"
          aria-label="切换任务优先级"
          style={{ fontSize: 12, padding: 2, border: '1px solid var(--border-strong)', borderRadius: 4 }}
        >
          <option value="low">低</option>
          <option value="normal">中</option>
          <option value="high">高</option>
        </select>
        {/* T00450：创建子任务——两级 epic→task 层级 */}
        <button onClick={() => void createSubTask(t)} title="创建子任务 — 在该任务下创建子任务（层级展示）" aria-label="创建子任务"
          className="task-op" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px', color: 'var(--text-muted)' }}>
          <ListTodo size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
        </button>
        {/* 行内切换任务分类：'none' 仅作展示用不可选；空串回到未分类 */}
        <select
          value={t.category_id ?? ''}
          onChange={(e) => void setTaskCategory(t, e.target.value)}
          title="分类 — 切换该任务所属分类"
          aria-label="切换任务分类"
          className="task-op"
          style={{ fontSize: 12, padding: 2, border: '1px solid var(--border-strong)', borderRadius: 4 }}
        >
          <option value="">未分类</option>
          {taskCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {/* 待办/已完成任务：AI 美化 + 重命名（编辑中保留保存/取消收尾） */}
        {renderTitleActions(t, titleEditing, true)}
        <button
          onClick={() => void copyTaskContent(t)}
          title="复制 — 复制该任务标题、描述与 AI 摘要到剪贴板"
          aria-label="复制：复制该任务内容到剪贴板"
          className="task-op"
          style={{ fontSize: 12, color: copiedId === t.id ? 'var(--success)' : undefined, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          {copiedId === t.id ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button onClick={() => toggleDescEdit(t)} title={descEditing ? '收起描述 — 收起描述编辑区' : '描述 — 编辑该任务描述'} aria-label={descEditing ? '收起描述' : '编辑该任务描述'} className="task-op" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>{descEditing ? <ChevronUp size={13} /> : <AlignLeft size={13} />}</button>
        {/* 处理结果编辑入口：与描述按钮保持一致的交互样式（点按展开编辑器，再点取消）。
        已录入（有 handle_result）→ 剪贴板编辑「修改」，未录入 → 剪贴板「添加」。
        仅做录入/修改；纯查看用标题区「处理结果展开图标」，此处不做收起，避免与查看态冲突 */}
        <button
          onClick={() => {
            // 未在编辑中：展开编辑器并读取已保存值；否则取消并丢弃草稿，无已保存值则收起零占位
            if (resultDrafts[t.id] === undefined) {
              setResultOpen((p) => ({ ...p, [t.id]: true }));
              startEditResult(t);
            } else {
              setResultDrafts((prev) => {
                const next = { ...prev };
                delete next[t.id];
                return next;
              });
              if (!t.handle_result) setResultOpen((p) => ({ ...p, [t.id]: false }));
            }
          }}
          title={resultBtnLbl.title}
          aria-label={resultBtnLbl.aria}
          className="task-op"
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          {t.handle_result ? <ClipboardEdit size={13} /> : <ClipboardList size={13} />}
        </button>
        <button
          onClick={() => { setReuseOpen(t.id); setReuseProjectId(''); setReuseSearch(''); setReuseCategoryId(''); void loadPromptCats(); void loadReqCats(); }}
          title="复用此任务 — 将该任务复制到其他项目，或打包为资产复制到提示词/通用需求页"
          aria-label="复用此任务：将该任务复制到其他项目或资产页"
          className="task-op"
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          <CopyPlus size={13} />
        </button>
        <button onClick={() => void archive(t)} title="归档 — 将该任务移入归档" aria-label="归档：将该任务移入归档" className="task-op" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Archive size={13} /></button>
        {/* 记录时间：与操作按钮同行的最右侧，紧凑格式，创建/编辑并排 */}
        <span style={{ display: 'inline-flex', gap: 10 }}>
          <span>{fmtShort(t.created_at)} 创建</span>
          <span>{fmtShort(t.updated_at)} 编辑</span>
        </span>
      </div>
    );
  }

  /** 已完成任务验证状态切换按钮：未验证=空心圆，已验证=打勾；key 变化触发重挂载以播放弹出动画 */
  function renderVerifyButton(t: Task) {
    return (
      <button
        onClick={() => void toggleVerified(t)}
        title={t.verified ? '已验证，点击取消验证' : '未验证，点击标记已验证'}
        aria-label={t.verified ? '取消验证' : '标记为已验证'}
        key={t.verified ? 'v-ok' : 'v-no'}
        className="verify-icon"
        style={{ cursor: 'pointer', fontSize: 16, lineHeight: 1, border: 'none', background: 'transparent', color: t.verified ? 'var(--success)' : 'var(--border-strong)' }}
      >
        {t.verified ? '✓' : '○'}
      </button>
    );
  }

  /** 标题区：编辑态输入框 / 展示态文本 + 描述展开按钮 */
  function renderTaskTitle(t: Task, titleEditing: boolean) {
    return (
      <>
        {titleEditing ? (
          <input
            value={titleDrafts[t.id]}
            onChange={(e) => beautifyStore.setDraft(t.id, e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveTitle(t)}
            placeholder="任务标题"
            autoFocus
            style={{ flex: 1, padding: '4px 6px', border: '1px solid var(--accent)', borderRadius: 4, fontSize: 13, boxSizing: 'border-box' }}
          />
        ) : (
          <span style={{ flex: 1, textDecoration: t.status === 'done' ? 'line-through' : 'none', color: 'var(--text)' }}>
            {t.title}
          </span>
        )}
        {/* 展开/收起按钮紧跟标题：有描述才显示，点击展开完整描述（默认收起不展示摘要，保持简洁） */}
        {t.description && (
          <button
            onClick={() => setDescExpanded((p) => ({ ...p, [t.id]: !p[t.id] }))}
            title={descExpanded[t.id] ? '收起 — 收起任务描述' : '展开 — 展开查看完整任务描述'}
            aria-label={descExpanded[t.id] ? '收起：收起任务描述' : '展开：展开查看完整任务描述'}
            className="task-op"
            style={{ fontSize: 12, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
          >
            {descExpanded[t.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
        {/* 处理结果展开图标：紧随任务详情（描述）展开图标之后，作为第二个交互图标。
            有已录入结果才显示；仅切换 resultOpen 的查看态（不进入编辑），与描述展开相互独立，
            两个面板可分别展开/收起，也可同时展开/收起。收起态用上箭头以区分展开态 */} 
        {t.handle_result && (
          <button
            onClick={() => setResultOpen((p) => ({ ...p, [t.id]: !p[t.id] }))}
            title={resultOpen[t.id] ? '收起处理结果 — 收起该任务的处理结果' : '展开处理结果 — 展开查看该任务的处理结果'}
            aria-label={resultOpen[t.id] ? '收起处理结果：收起该任务的处理结果' : '展开处理结果：展开查看该任务的处理结果'}
            className="task-op"
            style={{ fontSize: 12, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
          >
            {resultOpen[t.id] ? <ChevronUp size={13} /> : <ClipboardList size={13} />}
          </button>
        )}
      </>
    );
  }

  /** 标题操作：保存编辑中的标题 / AI 美化 + 重命名切换。
   *  待办与已完成任务均展示重命名；编辑中保留保存/取消以收尾美化或改名结果。 */
  function renderTitleActions(t: Task, titleEditing: boolean, includeRename = true) {
    return (
      <>
        {titleEditing ? (
          <button onClick={() => void saveTitle(t)} disabled={!titleDrafts[t.id]?.trim()} title="保存 — 保存修改后的任务标题" aria-label="保存：保存修改后的任务标题" className="task-op" style={{ fontSize: 12, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Save size={13} /></button>
        ) : (
          renderBeautifyButton(t)
        )}
        {includeRename && <button onClick={() => toggleTitleEdit(t)} title={titleEditing ? '取消 — 取消重命名' : '改名 — 重命名该任务标题'} aria-label={titleEditing ? '取消重命名' : '重命名该任务标题'} className="task-op" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>{titleEditing ? <X size={13} /> : <SquarePen size={13} />}</button>}
      </>
    );
  }

  /** AI 美化单条按钮：进行中高亮呼吸，批量独占期间禁用，提示文案区分状态 */
  function renderBeautifyButton(t: Task) {
    const busy = beautifyBusy[t.id];
    return (
      <button
        onClick={() => void beautify(t)}
        disabled={batchBusy && !busy}
        title={busy ? 'AI 美化进行中，请在工具栏点击「取消」' : 'AI 美化 — 润色该任务标题，使其语义更清晰表达更规范'}
        aria-label={busy ? 'AI 美化进行中' : 'AI 美化：润色该任务标题'}
        className={`task-op${busy ? ' task-breathe' : ''}`}
        style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px', background: busy ? 'var(--accent)' : 'transparent', color: busy ? 'var(--accent-text)' : 'var(--text)', opacity: batchBusy && !busy ? 0.4 : 1 }}
      >
        <Sparkles size={13} />
      </button>
    );
  }

  /** 描述展开区（查看态）：Markdown 正文在上、截图缩略图紧随其后显示在同一容器内，
   *  二者共同构成"描述区"；未展开/编辑时不展示，避免截图独立浮在标题栏 */
  function renderTaskDescView(t: Task) {
    return (
      <div style={{ marginLeft: 32, marginTop: 6 }}>
        {t.description && (
          // MarkdownContent 提供「渲染/源码」切换，样式与提示词管理页一致；
          // 外层不再设高度/滚动限制，避免渲染视图被截断而出现差异（滚动由组件内部处理）
          <MarkdownContent content={t.description} showCopy />
        )}
        {t.images.length > 0 && (
          <div style={{ marginTop: t.description ? 8 : 0, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {t.images.map((img) => (
              <div key={img.id} style={{ position: 'relative', display: 'inline-block' }}>
                {/* 截图缩略图用原生 button 包裹 img（S6819/S6842）：原生可交互元素自带键盘激活，无需 role/tabIndex */}
                <button
                  type="button"
                  title="放大预览 — 点击放大或收起截图"
                  aria-label="任务截图：点击放大预览"
                  onClick={() => setPreviewId(previewId === img.id ? '' : img.id)}
                  style={{ padding: 0, background: 'none', border: 'none', cursor: 'pointer', display: 'block', lineHeight: 0 }}
                >
                <img
                  src={imageUrl(img.id)}
                  alt="任务截图"
                  style={{
                    height: 64,
                    borderRadius: 4,
                    display: 'block',
                    border: previewId === img.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                  }}
                />
                </button>
                {/* 独立复制按钮：不干扰点击放大预览 */}
                <button
                  onClick={() => void copyImage(img)}
                  title="复制图片 — 复制该截图到剪贴板"
                  aria-label="复制图片：复制该截图到剪贴板"
                  className="task-op"
                  style={{ position: 'absolute', right: -6, bottom: -6, fontSize: 12, lineHeight: '16px', padding: '0 4px', display: 'inline-flex', alignItems: 'center', background: 'var(--surface-2)' }}
                >
                  <Copy size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /** 大图预览：点击缩略图后展示，附复制入口 */
  function renderTaskPreview(t: Task) {
    return (
      <div style={{ marginLeft: 32, marginTop: 6 }}>
        <img
          src={imageUrl(previewId)}
          alt="任务截图预览"
          style={{ maxWidth: '100%', maxHeight: 480, border: '1px solid var(--border-strong)', borderRadius: 6 }}
        />
        <div style={{ marginTop: 4 }}>
          <button onClick={() => void copyImage(t.images.find((i) => i.id === previewId)!)} title="复制图片 — 复制该截图到剪贴板" aria-label="复制图片：复制该截图到剪贴板" className="task-op" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px' }}><Copy size={13} />复制图片</button>
        </div>
      </div>
    );
  }

  /** 描述编辑区：已有/新增截图草稿 + 描述输入框 + 保存/优化/取消 */
  function renderTaskDescEditor(t: Task, descDraft: string) {
    const imgDraft = imgDrafts[t.id] ?? { added: [], removed: [] };
    const kept = t.images.filter((i) => !imgDraft.removed.includes(i.id));
    return (
      <div style={{ marginLeft: 32, marginTop: 6 }}>
        {(kept.length > 0 || imgDraft.added.length > 0) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            {kept.map((img) => (
              <div key={img.id} style={{ position: 'relative' }}>
                <img src={imageUrl(img.id)} alt="任务截图" style={{ height: 64, borderRadius: 4, border: '1px solid var(--border)' }} />
                <button
                  onClick={() => markImageRemoved(t.id, img.id)}
                  title="删除截图"
                  style={{ position: 'absolute', top: -6, right: -6, fontSize: 10, lineHeight: '16px', padding: '0 4px', cursor: 'pointer' }}
                >✕</button>
              </div>
            ))}
            {imgDraft.added.map((p) => (
              <div key={p.id} style={{ position: 'relative' }}>
                <img src={p.url} alt="待上传截图" style={{ height: 64, borderRadius: 4, border: '1px dashed var(--accent)' }} />
                <button
                  onClick={() => removeAddedImage(t.id, p.id)}
                  title="移除截图"
                  style={{ position: 'absolute', top: -6, right: -6, fontSize: 10, lineHeight: '16px', padding: '0 4px', cursor: 'pointer' }}
                >✕</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          value={descDraft}
          onChange={(e) => setDescDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
          onPaste={(e) => readClipboardImages(e, (url) => addPastedImage(t.id, url))}
          rows={3}
          placeholder="任务描述（支持 Markdown 风格纯文本，可在框内 Ctrl+V 粘贴截图）"
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }}
        />
        <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => void saveDesc(t)} title="保存描述 — 保存修改后的任务描述" aria-label="保存描述：保存修改后的任务描述" style={{ fontSize: 12, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Save size={13} /></button>
          <button onClick={() => void optimizeDesc(t)} title={optimizingMap[t.id] ? '取消 — 停止当前提示词优化' : '提示词优化 — 用选中工具把描述改写为结构化提示词'} aria-label={optimizingMap[t.id] ? '取消提示词优化' : '提示词优化：用选中工具优化描述草稿'} className={optimizingMap[t.id] ? 'task-breathe' : undefined} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px', background: optimizingMap[t.id] ? 'var(--accent)' : 'transparent', color: optimizingMap[t.id] ? 'var(--accent-text)' : 'var(--text)' }}><Wand2 size={13} /></button>
          <button onClick={() => toggleDescEdit(t)} title="取消 — 收起描述编辑区，放弃未保存的修改" aria-label="取消：收起描述编辑区" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><X size={13} /></button>
          {optimizingMap[t.id] && <span className="task-breathe" style={{ fontSize: 12, color: 'var(--accent)' }}>正在生成优化文案…</span>}
        </div>
      </div>
    );
  }

  /** AI 梳理摘要区：展开/收起查看（与描述展开同风格，默认收起） */
  function renderTaskSummary(t: Task) {
    return (
      <div style={{ marginLeft: 32, marginTop: 4 }}>
        <button
          onClick={() => setSummaryExpanded((p) => ({ ...p, [t.id]: !p[t.id] }))}
          title={summaryExpanded[t.id] ? '收起摘要 — 收起 AI 梳理摘要' : '展开摘要 — 展开查看 AI 梳理摘要'}
          aria-label={summaryExpanded[t.id] ? '收起：收起 AI 梳理摘要' : '展开：展开查看 AI 梳理摘要'}
          style={{ fontSize: 12, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 0', cursor: 'pointer' }}
        >
          {summaryExpanded[t.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          AI 梳理摘要
        </button>
        {summaryExpanded[t.id] && (
          <pre style={{ margin: '4px 0 0', padding: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {t.ai_summary}
          </pre>
        )}
      </div>
    );
  }

  /** 处理结果展开区：随任务行详情收起/展开（resultOpen 控制），展示态 Markdown + 编辑图标，
   *  编辑态 textarea + 纯图标保存/取消（悬浮提示）。由 MCP（mtask_update_task_result）同步的
   *  根因/解决方案直接落 handle_result，此处可人工改。 */
  function renderTaskResult(t: Task) {
    // 展开区仅在用户点开处理结果图标（或处于编辑态）时渲染，收起时零占位
    if (!resultOpen[t.id] && resultDrafts[t.id] === undefined) return null;
    const editing = resultDrafts[t.id] !== undefined;
    return (
      <div style={{ marginLeft: 32, marginTop: 4, border: '1px solid var(--border)', borderRadius: 6 }}>
        {/* 标题栏：左「处理结果」，右编辑/关闭图标（纯图标 + 悬浮提示） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 6px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', borderTopLeftRadius: 6, borderTopRightRadius: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>处理结果</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {!editing && (
              <button
                onClick={() => startEditResult(t)}
                title="编辑处理结果 — 修改该任务的处理结果"
                aria-label="编辑处理结果：修改该任务的处理结果"
                className="task-op"
                style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              >
                <ClipboardEdit size={12} />
              </button>
            )}
            <button
              onClick={() => {
                // 收起时同步丢弃未保存草稿：若有已完成录入则展示区回读已保存值 = 恢复原录入，无则收起为零占位
                setResultOpen((p) => ({ ...p, [t.id]: false }));
                setResultDrafts((prev) => {
                  const next = { ...prev };
                  delete next[t.id];
                  return next;
                });
              }}
              title="收起处理结果 — 收起该任务的处理结果（未保存修改将丢弃并恢复已保存录入）"
              aria-label="收起处理结果：收起该任务的处理结果"
              className="task-op"
              style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
            >
              <ChevronUp size={12} />
            </button>
          </span>
        </div>
        {editing ? (
          <div style={{ padding: 6 }}>
            <textarea
              value={resultDrafts[t.id]}
              onChange={(e) => setResultDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
              rows={6}
              placeholder="处理结果：记录根因分析、解决方案或结论（支持 Markdown）"
              style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }}
            />
            <div style={{ marginTop: 4, display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                onClick={() => void saveResult(t)}
                title="保存处理结果 — 保存修改后的处理结果"
                aria-label="保存处理结果：保存修改后的处理结果"
                className="task-op"
                style={{ fontSize: 12, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              >
                <Save size={13} />
              </button>
              <button
                onClick={() => {
                  // 放弃未保存修改：清草稿退出编辑态；若曾有已保存录入则留在展开态显示原值（恢复），否则收起空态
                  setResultDrafts((prev) => {
                    const next = { ...prev };
                    delete next[t.id];
                    return next;
                  });
                  if (!t.handle_result) setResultOpen((p) => ({ ...p, [t.id]: false }));
                }}
                title="放弃修改 — 放弃未保存的修改并恢复之前已保存的处理结果"
                aria-label="放弃修改：放弃未保存的修改并恢复之前已保存的处理结果"
                className="task-op"
                style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        ) : (
          // 有值展示 Markdown；无值且展开（理论上按钮点击即进入编辑，此处为收起按钮单独状态兜底）
          <div style={{ padding: 6 }}>
            {t.handle_result ? (
              <MarkdownContent content={t.handle_result} showCopy />
            ) : (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无处理结果</span>
            )}
          </div>
        )}
      </div>
    );
  }

  /** AI 梳理结果确认区：草稿可编辑，保存回填 ai_summary 或放弃 */
  function renderTaskDraft(t: Task, draft: string) {
    return (
      <div style={{ marginLeft: 32, marginTop: 6 }}>
        <textarea
          value={draft}
          onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
          rows={8}
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box' }}
        />
        <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
          <button onClick={() => void saveDraft(t)} title="保存到任务 — 将梳理结果回填为任务摘要" aria-label="保存到任务" style={{ fontSize: 12, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', gap: 4 }}><Check size={13} />保存到任务</button>
          <button onClick={() => setDrafts((prev) => {
            const next = { ...prev };
            delete next[t.id];
            return next;
          })} title="放弃 — 丢弃本次梳理草稿" aria-label="放弃梳理草稿" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><X size={13} /></button>
        </div>
      </div>
    );
  }

  /** 渲染单个任务行。
   *  注意：必须用普通函数调用（renderTaskItem(t)）而非组件，否则定义在渲染函数内会每次重渲染都生成新组件类型，
   *  导致整个任务项（含描述/梳理 textarea）反复卸载重建、光标焦点丢失。普通函数把 JSX 内联进父组件树，按位置复用 DOM，焦点稳定。
   *  同理，行内各区块也拆为普通渲染函数调用，保持单函数复杂度可控。 */
  function renderTaskItem(t: Task, kind: 'todo' | 'done', listIds: string[]) {
    const draft = drafts[t.id];
    const descDraft = descDrafts[t.id];
    const descEditing = descDraft !== undefined;
    const titleEditing = titleDrafts[t.id] !== undefined;
    return (
      <li
        className={`task-item${titleEditing || descEditing ? ' task-editing' : ''}${overTaskId === t.id ? ' plan-over' : dragTaskId === t.id ? ' plan-dragging' : ''}`}
        draggable={(kind === 'todo' ? todoSort : doneSort) === 'manual'}
        onDragStart={() => setDragTaskId(t.id)}
        onDragEnd={() => { setDragTaskId(''); setOverTaskId(''); }}
        onDragOver={(e) => { e.preventDefault(); if (t.id !== dragTaskId) setOverTaskId(t.id); }}
        onDrop={(e) => { e.preventDefault(); dropTaskReorder(kind, listIds, t.id); }}
        style={{ borderBottom: '1px solid var(--surface-2)', padding: '6px 0', marginLeft: t.parent_id ? 28 : 0, borderLeft: t.parent_id ? '2px solid var(--border-strong)' : undefined, paddingLeft: t.parent_id ? 10 : undefined, cursor: (kind === 'todo' ? todoSort : doneSort) === 'manual' ? 'grab' : undefined }}
      >
        {renderTaskTitleRow(t, titleEditing)}
        {/* 元信息/操作行：优先级/分类/功能按钮 + 记录时间，全部靠右同行 */}
        {renderTaskMetaRow(t, titleEditing, descEditing)}
        {/* 描述板块：描述展开时，Markdown 正文在上、截图缩略图紧随其后显示在同一容器内 */}
        {descExpanded[t.id] && !descEditing && (t.description || t.images.length > 0) && renderTaskDescView(t)}
        {/* 大图预览独立于查看态条件：编辑态下已打开的预览不因进入编辑而消失 */}
        {previewId && descExpanded[t.id] && t.images.some((i) => i.id === previewId) && renderTaskPreview(t)}
        {descEditing && renderTaskDescEditor(t, descDraft)}
        {t.ai_summary && !draft && renderTaskSummary(t)}
        {draft && renderTaskDraft(t, draft)}
        {renderTaskResult(t)}
      </li>
    );
  }

  /** AI 美化工具下拉：收起态只显示模型名（未配置则回退厂商名）以收紧宽度；
   *  展开面板展示"厂商名（厂商类型）+ 模型名"；焦点移出下拉区域即收起（见 focusout 监听） */
  function renderToolSelector() {
    const current = tools.find((x) => x.id === organizeToolId);
    return (
      <div ref={toolSelectRef} style={{ position: 'relative', marginLeft: 12 }}>
        <button
          onClick={() => setToolOpen((o) => !o)}
          title={current ? `当前工具：${current.name}（${current.type}）· ${current.model ?? '未配置模型'}` : '选择 AI 美化工具'}
          aria-label="选择 AI 美化工具"
          aria-haspopup="listbox"
          aria-expanded={toolOpen}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 8px', fontSize: 12, borderRadius: 4, background: 'var(--card-bg)', cursor: 'pointer' }}
        >
          {current ? (current.model ?? current.name) : '选择 AI 美化工具…'}
          <ChevronDown size={12} />
        </button>
        {toolOpen && (
          <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 30, minWidth: 240, maxHeight: 260, overflowY: 'auto', background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: 'var(--overlay)' }}>
            {tools.map((t) => (
              <button
                key={t.id}
                onClick={() => { setOrganizeToolId(t.id); setToolOpen(false); }}
                title={`选择 ${t.name}（${t.type}）· ${t.model ?? '未配置模型'}`}
                aria-label={`选择工具 ${t.name}`}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 'none', cursor: 'pointer', fontSize: 12, background: t.id === organizeToolId ? 'var(--accent-soft)' : 'transparent', color: t.id === organizeToolId ? 'var(--accent)' : 'var(--text)' }}
              >
                {/* 展开面板展示厂商名（厂商类型），模型名以浅色/告警色区分是否已配置 */}
                {t.name}（{t.type}）
                <span style={{ color: t.model ? 'var(--text-secondary)' : 'var(--danger)', marginLeft: 6 }}>{t.model ?? '未配置模型'}</span>
              </button>
            ))}
            {tools.length === 0 && <div style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 12 }}>暂无工具，请先在「模型管理」中添加</div>}
          </div>
        )}
      </div>
    );
  }

  /** 返显当前选中工具的模型；未配置模型时给出醒目提示，避免触发 AI 功能后才失败 */
  function renderModelHint() {
    const tool = tools.find((t) => t.id === organizeToolId);
    if (!tool) return null;
    return tool.model
      ? <span style={{ fontSize: 12, color: 'var(--accent)' }}>模型：{tool.model}</span>
      : <span style={{ fontSize: 12, color: 'var(--danger)' }}>⚠ 该工具未配置模型，AI 功能暂不可用</span>;
  }

  /** 工具条 AI 美化按钮：进行中变为「取消」，否则批量美化全部待办 */
  function renderBeautifyToolbarButton() {
    return (
      <>
        <button
          onClick={handleBeautifyToggle}
          disabled={!anyBeautify && todo.length === 0}
          title={anyBeautify ? '取消 — 停止当前批量美化' : 'AI 美化全部待办 — 批量润色所有待办任务标题'}
          aria-label={anyBeautify ? '取消批量美化' : 'AI 美化全部待办'}
          className={anyBeautify ? 'task-breathe' : undefined}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderRadius: 6, background: anyBeautify ? 'var(--accent)' : 'transparent', color: anyBeautify ? 'var(--accent-text)' : 'var(--text)' }}
        >
          <Wand2 size={13} />
          {anyBeautify ? '取消' : todo.length}
        </button>
        {/* 工具条整体连贯进度提示：单条/批量美化进行中展示（优化进行中文案在各任务描述区展示），完成/取消后清空 */}
        {anyBeautify && <span className="task-breathe" style={{ fontSize: 12, color: 'var(--accent)' }}>{batchBusy ? '正在批量美化标题…' : '正在美化标题…'}</span>}
      </>
    );
  }

  /** 顶部工具条：项目切换、工具选择、批量美化、分类筛选、搜索 */
  function renderToolbar() {
    return (
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={activeProject} onChange={(e) => setActiveProject(e.target.value)} style={{ padding: 6 }} aria-label="切换项目">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button
          onClick={() => void createProject()}
          title="新项目 — 新建一个任务项目"
          aria-label="新项目：新建一个任务项目"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}
        >
          <FolderPlus size={13} />
        </button>
        {/* 修改当前项目名称：轻量操作，弹输入框预填当前名称；置于删除按钮前，与删除同属「当前项目」操作区 */}
        <button
          onClick={() => void renameProject()}
          disabled={!activeProject}
          title="修改项目名称 — 重命名当前选中项目"
          aria-label="修改项目名称：重命名当前选中项目"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: activeProject ? 'pointer' : 'not-allowed', opacity: activeProject ? 1 : 0.5 }}
        >
          <SquarePen size={13} />
        </button>
        {/* 删除当前项目：风险操作，点击后弹确认框，确认才执行；危险色标示 */}
        <button
          onClick={() => void deleteProject()}
          disabled={!activeProject}
          title="删除项目 — 删除当前选中项目及其全部任务（不可恢复，需二次确认）"
          aria-label="删除项目：删除当前选中项目及其全部任务"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, color: 'var(--danger)', background: 'transparent', border: '1px solid var(--danger)', borderRadius: 6, cursor: activeProject ? 'pointer' : 'not-allowed', opacity: activeProject ? 1 : 0.5 }}
        >
          <Trash2 size={13} />
        </button>
        {renderToolSelector()}
        {renderModelHint()}
        {renderBeautifyToolbarButton()}
        {/* 一键批量分类：对当前项目全部未分类任务（待办 + 已完成，T00432）做 AI 语义识别自动分类，风格与批量美化按钮一致 */}
        <button
          onClick={() => void batchClassify()}
          disabled={classifyBusy || (todo.length === 0 && done.length === 0)}
          className={classifyBusy ? 'task-breathe' : undefined}
          title={classifyBusy ? '批量分类进行中…' : 'AI 批量分类 — 对未分类任务（含已完成）智能识别自动分到已有分类'}
          aria-label={classifyBusy ? '批量分类进行中' : 'AI 批量分类：对未分类任务（含已完成）自动分类'}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderRadius: 6, background: classifyBusy ? 'var(--accent)' : 'transparent', color: classifyBusy ? 'var(--accent-text)' : 'var(--text)' }}
        >
          <Tags size={13} />
          {classifyBusy ? '分类中' : '分类'}
        </button>
        {/* T00456 / PRD UX-1：视图切换（列表/看板） */}
        <span style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }} role="group" aria-label="视图切换">
          <button onClick={() => setViewMode('list')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: viewMode === 'list' ? 'var(--accent)' : 'transparent', color: viewMode === 'list' ? 'var(--accent-text)' : 'var(--text)' }} title="列表视图">列表</button>
          <button onClick={() => setViewMode('board')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: viewMode === 'board' ? 'var(--accent)' : 'transparent', color: viewMode === 'board' ? 'var(--accent-text)' : 'var(--text)' }} title="看板视图 — 按状态分列，拖拽卡片流转状态">看板</button>
        </span>
        <button
          onClick={() => { setMultiSelect((v) => !v); setSelectedIds(new Set()); }}
          style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: multiSelect ? 'var(--accent)' : 'transparent', color: multiSelect ? 'var(--accent-text)' : 'var(--text)' }}
          title={multiSelect ? '退出多选模式' : '多选模式 — 勾选任务后批量改状态/分类/归档'}
          aria-label={multiSelect ? '退出多选模式' : '进入多选模式'}
        >
          {multiSelect ? '✓ 多选中' : '多选'}
        </button>
        <label className="task-op" title="导入 CSV — 批量导入任务（预览确认后入库）"
          style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', display: 'inline-block' }}>
          导入 CSV
          <input type="file" accept=".csv" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onCsvFile(f); e.target.value = ''; }} />
        </label>
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          title="分类筛选 — 按任务分类筛选列表"
          aria-label="分类筛选：按任务分类筛选列表"
          style={{ padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6 }}
        >
          <option value="">全部分类</option>
          <option value="none">未分类</option>
          {taskCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索标题/描述…"
          style={{ padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, marginLeft: 'auto' }}
        />
        {notice && <span style={{ fontSize: 13, color: 'var(--accent)' }}>{notice}</span>}
      </div>
    );
  }

  /** 新建任务表单行 + 可选的描述/截图粘贴区 */
  function renderNewTaskForm() {
    return (
      <>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !creating) void createTask(); }}
            placeholder="输入任务标题，回车创建"
            style={{ flex: 1, padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6 }}
          />
          <select value={newPriority} onChange={(e) => setNewPriority(e.target.value)} style={{ padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6 }}>
            <option value="low">低</option>
            <option value="normal">中</option>
            <option value="high">高</option>
          </select>
          <select value={newCategory} onChange={(e) => setNewCategory(e.target.value)} title="分类" aria-label="新建任务分类选择" style={{ padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6 }}>
            <option value="">未分类</option>
            {taskCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label title="智能分类 — 按标题智能匹配任务类型（默认启用）" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
            {/* 间距用显式 margin 表达，不依赖源码换行空白（对渲染引擎不可靠） */}
            <input type="checkbox" checked={smartCat} onChange={(e) => setSmartCat(e.target.checked)} />
            <span style={{ marginLeft: 3 }}>智能分类</span>
          </label>
          <button onClick={() => setNewDescOpen(!newDescOpen)} title="描述/截图 — 展开或收起描述与截图上传区" aria-label={newDescOpen ? '收起描述与截图编辑区' : '展开描述与截图编辑区'} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>{newDescOpen ? <ChevronUp size={13} /> : <ImagePlus size={13} />}</button>
          <button onClick={() => void createTask()} disabled={creating} title={creating ? '添加中 — 正在智能分类并保存任务' : '添加任务 — 创建新任务并保存到当前项目'} aria-label={creating ? '添加中：正在智能分类并保存任务' : '添加任务：创建新任务并保存到当前项目'} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px', color: creating ? 'var(--text-muted)' : 'var(--text)' }}>
            {creating ? <Loader2 size={13} className="aispin" /> : <Plus size={13} />}
            {creating ? '分类中…' : '添加'}
          </button>
        </div>
        {/* 创建时可选的描述 + 截图粘贴区 */}
        {newDescOpen && (
          <div style={{ marginBottom: 16, marginLeft: 8 }}>
            {newImages.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                {newImages.map((img) => (
                  <div key={img.id} style={{ position: 'relative' }}>
                    <img src={img.url} alt="待上传截图" style={{ height: 64, borderRadius: 4, border: '1px dashed var(--accent)' }} />
                    <button
                      onClick={() => removeNewImage(img.id)}
                      title="移除截图 — 移除本次粘贴的待上传截图"
                      aria-label="移除截图"
                      style={{ position: 'absolute', top: -6, right: -6, fontSize: 10, lineHeight: '16px', padding: '0 4px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
                    ><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              onPaste={(e) => readClipboardImages(e, addNewImage)}
              rows={2}
              placeholder="任务描述（可在框内 Ctrl+V 粘贴截图）"
              style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }}
            />
          </div>
        )}
      </>
    );
  }

  /** 任务列表区块（FR1.4 检索 + 排序 + 验证状态过滤） */
  function renderTaskLists() {
    const kw = search.trim().toLowerCase();
    const batchBar = renderBatchBar();
    // T00446 / INT-6：CSV 导入预览确认块
    const csvBlock = csvPreview && (
      <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12, margin: '8px 0', background: 'var(--card-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>CSV 导入预览</strong>
          <span style={{ fontSize: 12, color: 'var(--success)' }}>可导入 {csvPreview.items.length} 条</span>
          {csvPreview.errors.length > 0 && <span style={{ fontSize: 12, color: 'var(--danger)' }}>问题 {csvPreview.errors.length} 行</span>}
          <span style={{ flex: 1 }} />
          <button onClick={() => setCsvPreview(null)} className="task-op" style={{ cursor: 'pointer', padding: '3px 8px' }}>取消</button>
          <button onClick={() => void confirmCsvImport()} disabled={batchOpBusy || csvPreview.items.length === 0}
            style={{ padding: '4px 12px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12 }}>
            确认导入
          </button>
        </div>
        {csvPreview.errors.length > 0 && (
          <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--danger)', maxHeight: 80, overflowY: 'auto' }}>
            {csvPreview.errors.map((e, i) => <div key={i}>第 {e.row} 行：{e.message}</div>)}
          </div>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr>{['标题', '描述', '优先级', '状态', '分类'].map((h) => <th key={h} style={{ padding: '4px 6px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'left', borderBottom: '1px solid var(--border-strong)' }}>{h}</th>)}</tr></thead>
          <tbody>
            {csvPreview.items.map((it, i) => (
              <tr key={i}>
                <td style={{ padding: '4px 6px' }}>{it.title}</td>
                <td style={{ padding: '4px 6px', color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.description}</td>
                <td style={{ padding: '4px 6px' }}>{it.priority}</td>
                <td style={{ padding: '4px 6px' }}>{it.status}</td>
                <td style={{ padding: '4px 6px' }}>{it.categoryName || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    const matches = (t: Task) => {
      // 分类筛选：'none' 表示未分类；指定分类则精确匹配；空串为全部
      if (catFilter === 'none') { if (t.category_id) return false; }
      else if (catFilter && t.category_id !== catFilter) return false;
      return !kw || t.title.toLowerCase().includes(kw) || (t.description ?? '').toLowerCase().includes(kw);
    };
    // 已完成栏验证状态过滤：all=全部，verified=仅已验证，unverified=仅未验证（拆出避免嵌套三元）
    const matchDoneFilter = (t: Task) => {
      if (doneFilter === 'all') return true;
      if (doneFilter === 'verified') return t.verified;
      return !t.verified;
    };
    // T00450：父子层级——子任务紧随父任务之后（缩进渲染），其余排序规则不变
    const arrange = (list: Task[]): Task[] => {
      const kids = new Map<string, Task[]>();
      const roots: Task[] = [];
      for (const t of list) {
        if (t.parent_id && list.some((x) => x.id === t.parent_id)) {
          const arr = kids.get(t.parent_id) ?? [];
          arr.push(t); kids.set(t.parent_id, arr);
        } else roots.push(t);
      }
      const out: Task[] = [];
      for (const t of roots) { out.push(t); const k = kids.get(t.id); if (k) out.push(...k); }
      return out;
    };
    const visibleTodo = arrange(sortTasks(todo.filter(matches), todoSort));
    const visibleDone = arrange(sortTasks(done.filter(matches).filter(matchDoneFilter), doneSort));
    return (
      <>
        {batchBar}
        {csvBlock}
        {viewMode === 'board' && renderBoard()}
        {viewMode === 'board' && <div style={{ height: 8 }} />}
        {viewMode === 'list' && (<>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>待办（{visibleTodo.length}/{todo.length}）</h3>
          {/* 按修改时间/优先级排序：会话级偏好，选项见 sortOptions */}
          <select
            value={todoSort}
            onChange={(e) => setTodoSort(e.target.value as SortKey)}
            title="待办排序 — 按修改时间或优先级排序"
            aria-label="待办排序：按修改时间或优先级排序"
            style={{ padding: 3, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4 }}
          >
            {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{visibleTodo.map((t) => <Fragment key={t.id}>{renderTaskItem(t, 'todo', visibleTodo.map((x) => x.id))}</Fragment>)}</ul>
        {visibleTodo.length === 0 && !multiSelect && (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, border: '1px dashed var(--border-strong)', borderRadius: 8, margin: '8px 0', lineHeight: 1.8 }}>
            当前项目暂无待办任务——在上方输入框输入标题回车即可创建；
            {tools.length === 0
              ? <>先到「模型」页添加 AI 模型，即可使用 AI 梳理 / 美化 / 分类等能力。</>
              : <>也可使用上方 AI 梳理、美化、批量分类等能力。</>}
          </div>
        )}
        </>)}

        {viewMode === 'list' && (<>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 8px' }}>
          {/* 提示未验证数量：默认过滤「仅未验证」时，让用户意识到已验证项只是被过滤而非丢失 */}
          <h3 style={{ fontSize: 15, margin: 0 }}>已完成（{visibleDone.length}/{done.length}，未验证 {done.filter((t) => !t.verified).length}）</h3>
          <select
            value={doneSort}
            onChange={(e) => setDoneSort(e.target.value as SortKey)}
            title="已完成排序 — 按修改时间或优先级排序"
            aria-label="已完成排序：按修改时间或优先级排序"
            style={{ padding: 3, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4 }}
          >
            {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select
            value={doneFilter}
            onChange={(e) => setDoneFilter(e.target.value as 'all' | 'unverified' | 'verified')}
            title="验证状态过滤 — 筛选已完成任务的验证状态显示范围"
            aria-label="验证状态过滤：筛选已完成任务的验证状态显示范围"
            style={{ padding: 3, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4 }}
          >
            <option value="unverified">仅未验证</option>
            <option value="verified">仅已验证</option>
            <option value="all">全部</option>
          </select>
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{visibleDone.map((t) => <Fragment key={t.id}>{renderTaskItem(t, 'done', visibleDone.map((x) => x.id))}</Fragment>)}</ul>
        {visibleDone.length === 0 && (
          <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>暂无已完成任务——完成任务后在此集中查看与验证。</div>
        )}
        </>)}
      </>
    );
  }

  /** 分页加载更多：当前页满页时追加下一页；hasMore=false 表示已到底 */
  function renderLoadMore() {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
        <button
          onClick={() => void loadMore()}
          disabled={loadingMore}
          title={loadingMore ? '加载中 — 正在拉取更多任务' : '加载更多 — 拉取下一页任务'}
          aria-label={loadingMore ? '加载更多：正在拉取更多任务' : '加载更多：拉取下一页任务'}
          style={{ padding: '6px 16px', fontSize: 12, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--surface-2)' }}
        >
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
      </div>
    );
  }

  /** 复用任务弹窗：项目=复制到其他项目；提示词=打包为 JSON 资产存入提示词分类 */
  function renderReuseDialog() {
    return (
      // 遮罩点击/Escape 关闭由组件层 document 委托处理（S6847/S6819）：
      // 容器为纯布局 div，不挂交互 handler 也不声明 dialog role
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      >
        <div ref={reusePanelRef} style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, width: 380, maxWidth: '90vw', boxShadow: '0 10px 30px rgba(0,0,0,.2)' }}>
          <div style={{ fontSize: 14, marginBottom: 10 }}>复用任务</div>
          {/* 目标切换：项目（原有能力）/ 提示词（打包为 JSON 资产） */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button
              onClick={() => setReuseTarget('project')}
              title="复制到项目 — 将任务原样复制到其他项目"
              aria-label="复制到项目：将任务原样复制到其他项目"
              style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid var(--border-strong)', background: reuseTarget === 'project' ? 'var(--accent)' : 'transparent', color: reuseTarget === 'project' ? 'var(--accent-text)' : 'var(--text)' }}
            >复制到项目</button>
            <button
              onClick={() => setReuseTarget('prompt')}
              title="复制到提示词 — 将任务打包为 JSON 资产存入提示词页分类"
              aria-label="复制到提示词：将任务打包为 JSON 资产存入提示词页分类"
              style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid var(--border-strong)', background: reuseTarget === 'prompt' ? 'var(--accent)' : 'transparent', color: reuseTarget === 'prompt' ? 'var(--accent-text)' : 'var(--text)' }}
            >复制到提示词</button>
            <button
              onClick={() => setReuseTarget('req')}
              title="复制到通用需求 — 将任务打包为通用需求条目存入需求页分类"
              aria-label="复制到通用需求：将任务打包为通用需求条目存入需求页分类"
              style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid var(--border-strong)', background: reuseTarget === 'req' ? 'var(--accent)' : 'transparent', color: reuseTarget === 'req' ? 'var(--accent-text)' : 'var(--text)' }}
            >复制到通用需求</button>
          </div>
          {reuseTarget === 'project' ? (
            <>
              <input
                autoFocus
                value={reuseSearch}
                onChange={(e) => setReuseSearch(e.target.value)}
                placeholder="搜索项目…"
                aria-label="搜索项目"
                style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }}
              />
              <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {projects.filter((p) => p.name.toLowerCase().includes(reuseSearch.trim().toLowerCase())).map((p) => (
                  <button key={p.id} onClick={() => setReuseProjectId(p.id)}
                    style={{ textAlign: 'left', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: reuseProjectId === p.id ? 'var(--accent)' : 'transparent', color: reuseProjectId === p.id ? 'var(--accent-text)' : 'var(--text)' }}>
                    {p.name}
                  </button>
                ))}
                {projects.filter((p) => p.name.toLowerCase().includes(reuseSearch.trim().toLowerCase())).length === 0 && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>无匹配项目</div>
                )}
              </div>
            </>
          ) : reuseTarget === 'req' ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                将任务打包为通用需求条目，存入所选需求分类（标题沿用任务名，内容含描述与 AI 摘要）。
              </div>
              {reqCats.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>暂无可用的通用需求分类，请先新建。</p>
              ) : (
                <select
                  autoFocus
                  value={reuseCategoryId}
                  onChange={(e) => setReuseCategoryId(e.target.value)}
                  aria-label="选择通用需求分类"
                  style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14 }}
                >
                  <option value="">请选择分类</option>
                  {reqCats.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.reqCount ?? 0}）</option>)}
                </select>
              )}
              <button onClick={() => void addReqCat()} title="新建分类 — 在通用需求页新建一个分类用于存放任务资产"
                aria-label="新建分类：在通用需求页新建一个分类用于存放任务资产"
                style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
                <Plus size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> 新建分类
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                将任务打包为 JSON 资产，存入所选提示词分类（标题沿用任务名，内容含描述与 AI 摘要）。
              </div>
              {promptCats.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>暂无可用的提示词分类，请先新建。</p>
              ) : (
                <select
                  autoFocus
                  value={reuseCategoryId}
                  onChange={(e) => setReuseCategoryId(e.target.value)}
                  aria-label="选择提示词分类"
                  style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14 }}
                >
                  <option value="">请选择分类</option>
                  {promptCats.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.promptCount ?? 0}）</option>)}
                </select>
              )}
              <button onClick={() => void addPromptCat()} title="新建分类 — 在提示词页新建一个分类用于存放任务资产"
                aria-label="新建分类：在提示词页新建一个分类用于存放任务资产"
                style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
                <Plus size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> 新建分类
              </button>
            </>
          )}
          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="ghost" onClick={() => setReuseOpen(null)} style={{ padding: '6px 14px' }}>取消</button>
            {reuseTarget === 'project' ? (
              <button onClick={() => void reuseTask()} disabled={!reuseProjectId || reuseBusy} style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)' }}>
                {reuseBusy ? '复用中…' : '复用'}
              </button>
            ) : (
              <button onClick={() => void reuseTask()} disabled={!reuseCategoryId || reuseBusy} style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)' }}>
                {reuseBusy ? '复制中…' : reuseTarget === 'req' ? '复制到通用需求' : '复制到提示词'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  /** 待办/已完成区块排序选择项：default 保持后端顺序，time* 按修改时间，p* 按优先级 */
  const sortOptions = [
    { value: 'default', label: '默认' },
    { value: 'timedesc', label: '修改时间（新→旧）' },
    { value: 'timeasc', label: '修改时间（旧→新）' },
    { value: 'pdesc', label: '优先级（高→低）' },
    { value: 'pasc', label: '优先级（低→高）' },
    { value: 'manual', label: '手动排序' },
  ] as const;
  type SortKey = (typeof sortOptions)[number]['value'] | 'manual';

  /** 对待办/已完成列表应用排序（返回新数组，不改动原数组） */
  const sortTasks = (list: Task[], sort: SortKey): Task[] => {
    if (sort === 'default' || list.length < 2) return list;
    const arr = [...list];
    // 优先级数值化：缺省/未知值按最低档对待，保证比较不产生 NaN
    const pr = (k: string) => ({ low: 0, normal: 1, high: 2 })[k] ?? 0;
    const ts = (t: Task) => new Date(t.updated_at).getTime() || 0;
    if (sort === 'timedesc') return arr.sort((a, b) => ts(b) - ts(a));
    if (sort === 'timeasc') return arr.sort((a, b) => ts(a) - ts(b));
    if (sort === 'pdesc') return arr.sort((a, b) => pr(b.priority) - pr(a.priority));
    if (sort === 'pasc') return arr.sort((a, b) => pr(a.priority) - pr(b.priority));
    // T00446：手动排序——pinned 优先，user_sort 空值排最后（与后端 sort=manual 一致）
    if (sort === 'manual') {
      return arr.sort((a, b) => {
        const pd = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
        if (pd !== 0) return pd;
        const ua = a.user_sort ?? Number.MAX_SAFE_INTEGER;
        const ub = b.user_sort ?? Number.MAX_SAFE_INTEGER;
        return ua - ub || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    }
    return arr.sort((a, b) => pr(a.priority) - pr(b.priority)); // pasc 低→高
  };

  return (
    <section>
      {/* 验证状态图标切换弹出的局部动画（key 重挂载时播放）；任务行悬停显隐操作区与背景灰显 */}
      <style>{`
        @keyframes verify-pop {
          0% { transform: scale(0.3); opacity: 0; }
          60% { transform: scale(1.4); }
          100% { transform: scale(1); opacity: 1; }
        }
        .verify-icon { animation: verify-pop 0.35s ease; }
        @keyframes aispin { to { transform: rotate(360deg); } }
        .aispin { animation: aispin 0.8s linear infinite; display: inline-block; }
        .task-item { border-radius: 4px; transition: background-color 0.15s ease; }
        .task-item:hover { background: var(--surface-2); }
        .task-op {
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.15s ease, visibility 0s linear 0.15s;
        }
        .task-item:hover .task-op,
        .task-item:focus-within .task-op,
        .task-item.task-editing .task-op {
          opacity: 1;
          visibility: visible;
          transition: opacity 0.15s ease, visibility 0s;
        }
        /* 请求进行中的呼吸反馈：缩放 + 外发光脉冲，与主题主色一致 */
        .task-breathe { animation: task-breathe 1.3s ease-in-out infinite; }
        @keyframes task-breathe {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.35); }
          50% { transform: scale(1.06); box-shadow: 0 0 0 5px rgba(37, 99, 235, 0); }
        }
      `}</style>
      {renderToolbar()}
      {renderNewTaskForm()}
      {renderTaskLists()}
      {hasMore && renderLoadMore()}
      {reuseOpen && renderReuseDialog()}
    </section>
  );
}
