import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent } from 'react';
import { FILE_INPUT_SR_ONLY } from '../ui/fileInput'; // T01674：file input 视觉隐藏但保留键盘焦点
import { createPortal } from 'react-dom';
import { api, imageUrl, fetchImage, imageDataURL, type AITool, type CustomField, type CustomFieldType, type Project, type PromptCategory, type ReqCategory, type Task, type TaskCategory, type TaskImage } from '../api/client';
import { ResultDiffPanel } from '../ui/ResultDiff'; // T01072-FR1.9：结果历史 diff 与回滚
import { beautifyStore } from '../stores/beautifyStore';
import { askConfirm, askInput } from '../ui/dialogs';
import { MarkdownContent } from '../ui/Markdown';
import { TaskEventTimeline } from '../components/TaskEventTimeline';
import { TaskDetailDrawer, type TaskDetailTab, type TaskPatch } from '../components/TaskDetailDrawer'; // T01562：真抽屉详情
import { focusPlanNode, focusTaskByNo, type FocusTaskIntent } from '../ui/focusTask'; // T01568：外部跳转定位意图（通知/铃铛/就绪条）；T02196：徽标点击定位
import { ProjectListHint, getProjectListSnapshot, patchProject, refreshProjectList, useProjectList } from '../ui/projectList'; // T02201：项目列表取数容错层
import { ResourceHint, useResource } from '../ui/resourceState'; // T02213：选中项有效性校验失败态提示；T02257：AI 工具列表同层接入
import { PinToggle } from '../ui/PinToggle';
import { priorityAriaLabel, priorityColor } from '../ui/priority'; // PM-302 ③：优先级 → 颜色/文案单源（列表/看板/矩阵/移动端共用）
import { blockBadgeNames, blockBadgeNode } from '../ui/blockBadge'; // T03229（PM-202②）：阻塞徽标单源（列表行与看板卡共用）
import { fieldBadgesNode } from '../ui/fieldBadges'; // T03231（PM-203②）：自定义字段值徽标（列表行展示）
import { clearSessionState, usePersistentState, useSessionState } from '../ui/session';
import { NoticeToast, useNotice } from '../ui/notice'; // T03214（UX-02 ③）：提示分级——成功短驻、错误长驻且可关闭/复制
import { paginationStatus, type PaginationView } from '../utils/taskPagination'; // T03214（UX-02 ①）：剩余条数与「已加载全部」判据
import { isValidIanaTz, tzOptions } from '../utils/timezone'; // T03268（PRD 4.2）：项目时区候选与本地校验
import { buildImportFailureReceipt, buildImportReceipt } from '../utils/importReceipt'; // T03214（UX-02 ④）：导入结果分列成功/跳过/失败
import { arrangeTaskTree, makeTaskMatcher, matchVerified, sortOptions, sortTasks, type SortKey } from '../utils/taskListQuery'; // T03215（PM-304）：列表派生计算提为模块级纯函数，供 useMemo 稳定缓存
import { useTaskListWindow } from '../utils/taskListWindow'; // T03215（PM-304）：文档滚动 + 变高行的窗口化
import { PROJ_SORT_OPTIONS, PROJ_SORT_LABEL, isProjectPinned, sortProjects, toggleProjectPin as togglePinShared, type ProjectSortMode } from '../ui/projectOrder'; // T00663：排序/置顶共享模块
import { useBusy, setBusy } from '../ui/busy';
import { AlertTriangle, AlignLeft, Archive, ArrowUpDown, Check, CheckCheck, ChevronDown, ChevronUp, Circle, CirclePause, ClipboardEdit, ClipboardList, Copy, CopyPlus, Download, FolderPlus, ImagePlus, LayoutGrid, ListChecks, ListTodo, Loader2, Minimize2, PanelRightOpen, Pin, Plus, Save, ScanSearch, Sparkle, Sparkles, SquarePen, Tags, Trash2, Wand2, X, UnfoldVertical, FoldVertical, RotateCcw } from 'lucide-react';
import { FontColorButton } from '../ui/FontColorButton';
import { WorkspaceSelect } from '../ui/WorkspaceSelect'; // T00771：工作空间选择器（项目上下文根路径）
import { WorkspaceSearchPanel } from '../ui/WorkspaceSearchPanel'; // T00786：工作空间全文检索面板（partial 提示）
import { AiPolishButton } from '../ui/AiPolishButton'; // T00796 二轮：正文 AI 美化（反馈/处理结果共用）
import { AiUnavailableHint, aiBlocked, aiBlockedTitle, useAiReadiness } from '../ui/aiReadiness'; // T03176（D-14）：AI 不可用入口可见但禁用 + 原因/修复动作
import { classifyResultMessage, createClassifyStore, runClassifyBatch, type ClassifyResponse, type ClassifyStoreState } from './tasksClassifyBatch'; // T02307：批量分类三态分流 + 账户级门禁/连续失败熔断

/** 顶部 tab 三态：待办 / 已完成 / 搁置（S4323：具名类型别名替代内联联合类型） */
type ActiveTab = 'todo' | 'done' | 'shelved';

/** T02291：`total=1` 加性通道的分页信封（与 server/src/util/list-page.ts 的 Paged、ArchivePage 同形状） */
interface Paged<T> {
  items: T[];
  total: number;
}

/** T01568：详情抽屉合法标签页（会话键 focusDrawerTab 的白名单校验口径，与 TaskDetailDrawer 标签页一致） */
const DRAWER_TABS: readonly TaskDetailTab[] = ['desc', 'result', 'summary', 'timeline', 'plans', 'blocks'];

// ---------- T00552：批量分类运行态模块级化——切页后循环继续、返回不卡死 ----------
// T02365：补「没命中」的原因分桶——AI 判定无匹配、调用失败、分类候选为空要分得开，
// 否则一律显示「未能为这些任务匹配到合适分类」，用户既不知道是配置问题还是模型没选中。
// T02307：三态判定与熔断（账户级门禁首次即停 / 连续 K 次失败）收敛在 tasksClassifyBatch.ts，门可直接驱动。
export const classifyStore: ClassifyStoreState = createClassifyStore();

async function runBatchClassifyModule(target: Array<{ id: string; title: string; priority: string }>, toolId: string, cats: Array<{ id: string; name: string }>): Promise<void> {
  if (classifyStore.busy) return;
  classifyStore.busy = true;
  try {
    await runClassifyBatch({
      target, toolId, categories: cats, store: classifyStore,
      post: (path, body) => api.post<ClassifyResponse>(path, body),
      patch: (path, body) => api.patch(path, body),
      isActive: () => classifyStore.busy, // 防御：外部复位即中止
    });
  } finally {
    classifyStore.busy = false;
  }
}

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

/** T00658：三态复选框（支持半选态）——原生 indeterminate 只能经属性设置，封装为受控组件。
 *  用于多选模式标题旁的「全选框」：全选=checked、部分选中=indeterminate、未选=空。 */
/** T01064-FR1.5：任务事件时间线——状态流转/回传/验证历史（/api/events/by-task/:id，正序；无事件不渲染） */
/** T01065-FR1.6：批量操作动作的中文名（撤销按钮提示用） */
const ACTION_LABEL: Record<'status' | 'category' | 'priority' | 'color' | 'archive' | 'verified', string> = {
  status: '批量改状态', category: '批量设分类', priority: '批量设优先级', color: '批量字体颜色', archive: '批量归档',
  verified: '批量验收结果',
};

/**
 * T01065 后续：一级撤销快照（一次批量操作 = 一步）。
 * entries 为操作前旧值；还原时逐条 PATCH 回去。字段按动作取用——验收结果只回填 verified，
 * 避免撤销时把期间被他人改过的状态/优先级一并覆盖。
 */
interface BatchUndoPatch {
  status?: string;
  priority?: string;
  category_id?: string | null;
  color?: string;
  verified?: boolean;
}
interface BatchSnapshot {
  entries: Array<{ id: string; patch: BatchUndoPatch }>;
  label: string;
  /** 操作时刻（ISO），步骤列表里按时间展示，便于辨认「要撤到哪一步」 */
  at: string;
}
/** T03211（PM-105）：批量操作逐条回执——成功/失败计数与每条失败原因，常驻到手动关闭 */
interface BatchReceipt {
  label: string;
  okCount: number;
  failed: Array<{ id: string; title: string; reason: string }>;
  /** T03214（UX-02 ④）：跳过项与原因（导入预览的问题行、服务端未创建的条目） */
  skipped?: Array<{ ref: string; reason: string }>;
  at: string;
}
/** 撤销栈上限：再深的历史用户基本不会翻，且每条快照都占内存（含逐条旧值） */
const MAX_UNDO_STEPS = 10;

/** T03267（PM-402①）：CSV 来源识别结果的中文名——只影响提示，解析口径由服务端单源决定 */
const CSV_SOURCE_LABEL: Record<'github' | 'jira' | 'generic', string> = {
  github: 'GitHub Issues CSV（自动识别）',
  jira: 'Jira CSV（自动识别）',
  generic: '通用 CSV（自动识别）',
};
/** T03267（PM-402②）：预览里可人工调整的字段；标题必选，其余留空即不导入该字段 */
const CSV_MAP_FIELDS: Array<{ field: 'title' | 'description' | 'priority' | 'status' | 'category'; label: string; required?: boolean }> = [
  { field: 'title', label: '标题', required: true },
  { field: 'description', label: '描述' },
  { field: 'priority', label: '优先级' },
  { field: 'status', label: '状态' },
  { field: 'category', label: '分类' },
];

/** T03211（PM-105）：全部项目视图的哨兵值——任务查询不带 projectId，选中集合可跨项目 */
const ALL_PROJECTS = '__all__';

/** 视图作用域 → 请求参数：全部项目不带 projectId（后端缺省即全量），其余照常传 */
function scopeParams(projectId: string): URLSearchParams {
  const p = new URLSearchParams();
  if (projectId !== ALL_PROJECTS) p.set('projectId', projectId);
  return p;
}

/**
 * T03232（PM-203③）：字段类型 → 可选筛选算子。
 * 与服务端 TaskService.FIELD_OPS 对齐——前端只负责不给用户端出无效算子，服务端仍按字段定义再校验一次。
 */
const FIELD_FILTER_OPS: Record<CustomFieldType, Array<{ value: string; label: string }>> = {
  text: [{ value: 'contains', label: '包含' }, { value: 'eq', label: '等于' }, { value: 'empty', label: '未填' }, { value: 'notEmpty', label: '已填' }],
  number: [
    { value: 'eq', label: '等于' }, { value: 'gt', label: '大于' }, { value: 'gte', label: '大于等于' },
    { value: 'lt', label: '小于' }, { value: 'lte', label: '小于等于' }, { value: 'empty', label: '未填' }, { value: 'notEmpty', label: '已填' },
  ],
  date: [
    { value: 'eq', label: '等于' }, { value: 'gt', label: '晚于' }, { value: 'gte', label: '不早于' },
    { value: 'lt', label: '早于' }, { value: 'lte', label: '不晚于' }, { value: 'empty', label: '未填' }, { value: 'notEmpty', label: '已填' },
  ],
  select: [{ value: 'eq', label: '选择' }, { value: 'empty', label: '未填' }, { value: 'notEmpty', label: '已填' }],
};

/** 需要填值的算子（empty/notEmpty 只看有没有值） */
const FIELD_OP_NEEDS_VALUE = new Set(['eq', 'contains', 'gt', 'gte', 'lt', 'lte']);

function defaultFieldOp(type: CustomFieldType): string {
  return type === 'text' ? 'contains' : 'eq';
}

function TriCheckbox({ checked, indeterminate, onChange, title, label, style }: {
  readonly checked: boolean;
  readonly indeterminate: boolean;
  readonly onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  readonly title: string;
  readonly label: string;
  readonly style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !checked && indeterminate;
  }, [checked, indeterminate]);
  return (
    <input ref={ref} type="checkbox" checked={checked} onChange={onChange}
      title={title} aria-label={label} style={style} />
  );
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

/* PM-302 ③：优先级 → 颜色/文案的定义已收进 ui/priority.ts（看板、列表、矩阵、移动端共用同一映射）。
   本地包装保留只为不动调用点；实现在单源文件里。 */
const priorityBorderColor = priorityColor;
const priorityLabel = priorityAriaLabel;

export function TasksPage() {
  // 新建任务表单字段：跨切换会话持久化，录入一半切页后可续写
  const [newTitle, setNewTitle] = useSessionState('tasks.new.title', '');
  const [wsPickForNew, setWsPickForNew] = useState<Project | null>(null); // T00771：新建项目后的工作空间绑定弹窗（可跳过）
  const [newPriority, setNewPriority] = useSessionState<string>('tasks.new.priority', 'normal');
  const [newDescOpen, setNewDescOpen] = useSessionState('tasks.new.descOpen', false);
  const [newDesc, setNewDesc] = useSessionState('tasks.new.desc', '');
  const [newImages, setNewImages] = useSessionState<PastedImage[]>('tasks.new.images', []);
  // T02201：项目列表取数交统一容错层（加载中/失败可见 + 重试，失败不缓存冒充正常数据）
  const projectList = useProjectList();
  const { projects } = projectList;
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
  // T00786：工作空间全文检索面板显隐（建议相对工作空间选择器就近放置）
  const [wsSearchOpen, setWsSearchOpen] = useState(false);
  const [todo, setTodo] = useState<Task[]>([]);
  const [done, setDone] = useState<Task[]>([]);
  // T00719：搁置任务列表（页面最下方独立区块，与待办/已完成隔离；MCP 处理待办时自动忽略）
  const [shelvedTasks, setShelvedTasks] = useState<Task[]>([]);
  const [shelvedSort, setShelvedSort] = usePersistentState<SortKey>('shelvedSort', 'default'); // T01697：原为裸 useState（切页即丢）——升级持久化
  // T01533：标题区按下选中守卫——manual 排序时行 draggable 会劫持鼠标拖拽致标题无法选择复制；
  // 自标题按下起临时对该行禁用行拖拽（改从行内其他区域仍可拖动排序），松开指针即恢复。
  const [titleSelId, setTitleSelId] = useState('');
  // T00566：本地静默清空某任务 ai_state（已读）——不打断列表，不触发全表刷新
  const setTasksStateRead = (id: string) => {
    const clear = (arr: Task[]) => arr.map((x) => (x.id === id && x.ai_state ? { ...x, ai_state: '' } : x));
    setTodo(clear); setDone(clear);
  };
  const [search, setSearch] = useSessionState<string>('tasks.search', ''); // T00560：命令面板跳转写入搜索词
  const searchInputRef = useRef<HTMLInputElement>(null); // T02952：清空按钮点击后把光标还回搜索框
  // T02949：派生单裁决面板态（预设选项由服务端单源拉取；提交后结果由服务端追加到详情末尾）
  const [rulingTask, setRulingTask] = useState<Task | null>(null);
  const [rulingOptions, setRulingOptions] = useState<string[]>([]);
  const [rulingDraft, setRulingDraft] = useState('');
  const [rulingBusy, setRulingBusy] = useState(false);
  // T00836：命令面板点击任务后下发的「定位」意图——滚动到该行并高亮 + 展开记录，定位完成即消费清空
  const [focusTaskId, setFocusTaskId] = useSessionState<string>('tasks.focusId', '');
  const [focusTab, setFocusTab] = useSessionState<string>('tasks.focusTab', '');
  // T00836 二轮：聚焦任务所属项目——任务可能属于非当前 activeProject 的项目，
  // 若不下发此 id，切换列表后会因「目标行不在当前项目列表」而定位失败。
  const [focusProjectId, setFocusProjectId] = useSessionState<string>('tasks.focusProjectId', '');
  // T02206：定位意图的放弃时刻（0=无在途）。原一次性 DOM 检查会在首轮（列表尚未按新项目重载完、
  // 目标行还不存在）就清键，高亮静默丢失；改为带截止时间的重试收口——列表每次变化都重认目标行，
  // 到点仍未命中才清空并给一次明示提示（与 T02196 徽标通道同口径）。
  const [focusDeadline, setFocusDeadline] = useState(0);
  // T01562：真抽屉详情——当前打开抽屉的任务（按 task.id 作 key，切换任务即重挂载）；focusDrawerId 由 focusTaskByNo 写入
  const [drawerTask, setDrawerTask] = useState<Task | null>(null);
  // T01568：抽屉落位标签页——外部跳转（focusTaskByNo 传 'result' 等）写入 focusDrawerTab，开抽屉即落该页；
  // 手动开抽屉不写（保持 null → 抽屉默认「描述」），两套入口互不污染。
  const [drawerTab, setDrawerTab] = useState<TaskDetailTab | null>(null);
  const [focusDrawerId, setFocusDrawerId] = useSessionState<string>('tasks.focusDrawerId', '');
  const [focusDrawerTab, setFocusDrawerTab] = useSessionState<string>('tasks.focusDrawerTab', '');
  // T02196：标题区「派生自」徽标点击定位——badgeLocate 承载待定位的父任务，locateFlashId 驱动高亮动画。
  // 高亮用 state 加类而非 locateTaskRow 那套命令式改 style：定位期间列表会随任意状态重渲染，
  // 内联样式会被 React 按 props 覆写回原值，动画一闪即没。
  // id 为空表示只有编号可用（父任务不在当前已加载列表里）；retrieved=已发起编号检索；until 是该意图的放弃时刻。
  const [badgeLocate, setBadgeLocate] = useState<{ taskNo: string; id: string; tab: ActiveTab; retrieved: boolean; until: number } | null>(null);
  const [locateFlashId, setLocateFlashId] = useState('');
  // T00757：列表 tab——待办/已完成/搁置三个列表标题并排为 tab，仅渲染激活 tab 的列表（会话级保持）
  const [activeTab, setActiveTab] = useSessionState<ActiveTab>('tasks.activeTab', 'todo');
  // 主列表分页：后端按页拉取 + 加载更多；hasMore=true 表示当前页刚好满页、可能还有更多
  const PAGE_SIZE = 200;
  const [hasMore, setHasMore] = useState(false);
  // T03214（UX-02 ①）：页脚状态（剩余条数 / 已加载全部）——随每轮取数更新，拿不到服务端总数时保持 null 不猜数
  const [pageStatus, setPageStatus] = useState<PaginationView | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [organizeToolId, setOrganizeToolId] = usePersistentState('tasks.organizeToolId', '');
  // T02257：/aitools 接入 T02213 共享失败态层——此前首个 await 在 try 之外，
  // /aitools 失败时 void loadTools() 不接拒绝（unhandled rejection），工具列表还静默为空，
  // AI 按钮点开只提示「先添加模型」，把取数故障误导成未配置。
  const toolsRes = useResource<AITool[]>(async () => {
    const list = await api.get<AITool[]>('/aitools');
    // T00534：统一以模型菜单配置为准——始终使用默认整理工具，不再由本页下拉选择
    try {
      const defaults = await api.get<{ organize: string | null; develop: string | null }>('/aitools/defaults');
      const def = list.find((t) => t.id === defaults.organize) ?? list[0];
      if (def) setOrganizeToolId(def.id);
    } catch { /* 默认查询失败则保持空选 */ }
    return list;
  });
  // 默认整理工具排最前，便于选择
  const tools = useMemo(
    () => [...(toolsRes.data ?? [])].sort((a, b) => Number(b.isDefaultOrganize) - Number(a.isDefaultOrganize)),
    [toolsRes.data],
  );
  // T03176（D-14）：AI 可用性单源诊断（与后端 runtimeWithModel 同口径）——不可用时工具条 AI 按钮可见但禁用，
  // 点击只回显具体原因；页面不隐藏入口，避免「先关掉再说」。
  const readiness = useAiReadiness();
  const aiDown = aiBlocked(readiness);
  /** 前置提示统一口径：诊断有具体缺失项（未配置/全停用/未填模型/配置不符）时说原文，否则说调用方文案 */
  const aiBlockedFlash = (fallback: string) => (aiDown && readiness ? `AI 暂不可用：${readiness.reason}` : fallback);

  // 任务分类：分类列表 + 顶部筛选（会话级）+ 新建任务所选分类（会话级）
  const [taskCats, setTaskCats] = useState<TaskCategory[]>([]);
  const [catFilter, setCatFilter] = useSessionState('tasks.catFilter', '');
  // T02283：主列表取数的显式状态。分页装载结构（todo/done/hasMore）保持不变，只把失败显式化，
  // 形态与 T02213 的 ResourceHintView 同构（loading|ready|error + reload），可直接喂 ResourceHint。
  const [tasksPhase, setTasksPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tasksError, setTasksError] = useState('');
  // T02291：筛选命中的服务端总条数（走 `total=1` 通道；null=本会话还没成功取过数，页脚不猜数）
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  // T02290：搁置列表此前是裸吞 catch——失败后 shelvedTasks 保持旧值/空数组，页面既无失败态也无重试入口，
  // 「暂无搁置任务」空态会把取数故障冒充成「本来就没数据」。补一份与主列表同形的显式状态喂 ResourceHint。
  const [shelvedPhase, setShelvedPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [shelvedError, setShelvedError] = useState('');
  // T00474：优先级筛选（urgent/high/normal/low，会话级保持；空=全部）
  const [priorityFilter, setPriorityFilter] = useSessionState('tasks.priorityFilter', '');
  // T03232（PM-203③）：自定义字段筛选/排序。字段定义挂项目，取值随项目切换重新拉取；
  // 筛选走服务端（WHERE EXISTS），排序也走服务端（ORDER BY 字段值），分页前后口径一致。
  const [projectFields, setProjectFields] = useState<CustomField[]>([]);
  const [fieldFilterField, setFieldFilterField] = useSessionState('tasks.fieldFilterField', '');
  const [fieldFilterOp, setFieldFilterOp] = useSessionState('tasks.fieldFilterOp', '');
  const [fieldFilterValue, setFieldFilterValue] = useSessionState('tasks.fieldFilterValue', '');
  // 形如 `<fieldId>|asc`；默认空=不按字段排序（保持后端既有排序）
  const [fieldSort, setFieldSort] = usePersistentState('tasks.fieldSort', '');
  const activeField = projectFields.find((f) => f.id === fieldFilterField);
  const fieldsDisabled = !activeProject || activeProject === ALL_PROJECTS || projectFields.length === 0;
  const fieldFilterNeedsValue = !!fieldFilterOp && FIELD_OP_NEEDS_VALUE.has(fieldFilterOp);
  const onFieldFilterField = (id: string) => {
    // 换字段时把算子重置成该类型的默认值（文本→包含、其余→等于），旧值清空——跨类型沿用旧算子会立刻变成无效参数
    setFieldFilterField(id);
    const f = projectFields.find((x) => x.id === id);
    setFieldFilterOp(f ? defaultFieldOp(f.type) : '');
    setFieldFilterValue('');
  };
  const clearFieldFilter = () => { setFieldFilterField(''); setFieldFilterOp(''); setFieldFilterValue(''); };
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
  // T00535：改会话级持久化——切页后回来按钮忙碌态不丢失
  const [classifyBusy, setClassifyBusy] = useSessionState<boolean>('tasks.classifyBusy', false);
  // T00552：classifyBusy 与模块级 store 同步——运行中保持显示，完成自动复位并提示
  useEffect(() => {
    if (classifyBusy && !classifyStore.busy) { setClassifyBusy(false); return; }
    if (!classifyBusy) return;
    const timer = globalThis.setInterval(() => {
      if (!classifyStore.busy) {
        setClassifyBusy(false);
        // T02365：结论按「成功 / AI 无匹配 / 调用失败」分桶说清，失败时带上首条错误原文，
        // 不再用一句「未能匹配」把配置故障和模型未选中混为一谈。
        // T02307：熔断中止时改说「中止 + 额度/限流」，与「无合适分类」彻底分开。
        flash(classifyResultMessage(classifyStore, taskCats.map((c) => c.name)));
        void loadTasks(activeProject);
      }
    }, 1500);
    return () => globalThis.clearInterval(timer);
  }, [classifyBusy, activeProject, taskCats]);
  // 进行中请求的取消控制器：美化已入 beautifyStore.aborts（模块级，切页存活）；提示词优化仍按页内隔离
  const optimizeAborts = useRef<Record<string, AbortController>>({});
  // 是否有美化类操作进行中（单条或批量）：驱动工具条「取消/批量美化」按钮
  const anyBeautify = batchBusy || Object.values(beautifyBusy).some(Boolean);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // taskId -> 待确认的梳理结果
  const [descDrafts, setDescDrafts] = useState<Record<string, string>>({}); // taskId -> 描述编辑草稿
  const titleDrafts = beautifySnap.drafts; // taskId -> 标题编辑草稿（美化结果/手动编辑共用，切页保留）
  const [imgDrafts, setImgDrafts] = useState<Record<string, ImageDraft>>({}); // taskId -> 图片增删草稿
  const [previewId, setPreviewId] = useState(''); // 当前放大预览的图片 id
  // T03214（UX-02 ③）：提示改走分级通道——info 2.5 秒、error ≥6 秒且可关闭/复制
  const { notice, flash, dismiss: dismissNotice } = useNotice();
  // 刚完成"复制"的任务 id，用于按钮短暂显示"已复制✓"反馈
  const [copiedId, setCopiedId] = useState('');
  // 描述 展开/收起 状态：descExpanded 记录已展开的 taskId，默认收起不展示摘要，点标题行箭头展开看完整描述
  const [descExpanded, setDescExpanded] = useState<Record<string, boolean>>({});
  // T01384：描述动画可见态——收起时保留挂载以播放收起过渡，transitionEnd 后卸载（内容重，避免常驻渲染）
  const [descVis, setDescVis] = useState<Record<string, boolean>>({});
  // AI 梳理摘要 展开/收起：与描述展开同风格（lucide 蓝色箭头），默认收起
  const [summaryExpanded, setSummaryExpanded] = useState<Record<string, boolean>>({});
  // 处理结果 草稿/展开状态：resultDrafts 存在即进入编辑态（有值时可点击「编辑」重新编辑）
  const [resultDrafts, setResultDrafts] = useState<Record<string, string>>({});
  // 处理结果 展开/收起：随任务行详情一起收起/展开，默认收起（有值也收起，点操作行图标展开）
  const [resultOpen, setResultOpen] = useState<Record<string, boolean>>({});
  // T00521 调整：验证失败反馈展开态（查看/修改窗口与处理结果同款，展示态聚焦【验证失败】段）
  const [failbackOpen, setFailbackOpen] = useState<Record<string, boolean>>({});

  // T00610：验证失败反馈录入弹窗（文本 + 截图）与提交忙碌态
  const [failDialog, setFailDialog] = useState<{ taskId: string; title: string; text: string; images: PastedImage[] } | null>(null);
  /** 移除反馈弹窗内待上传截图（S2004：从 JSX 深层嵌套箭头下沉为组件级回调） */
  const removeFailImage = (imgId: string) => setFailDialog((d) => (d ? { ...d, images: d.images.filter((x) => x.id !== imgId) } : d));
  const [failBusy, setFailBusy] = useState(false);
  // 验证失败反馈编辑草稿：存在即编辑态，保存写回 handle_result 全文
  const [fbDrafts, setFbDrafts] = useState<Record<string, string>>({});
  // 「已完成」栏验证状态过滤：默认仅展示未验证，便于优先处理待核对的完成项；all=全部
  // T03214（UX-02 ②）：此前是裸 useState——切到别的页再回来就回到默认值，与搜索/分类/优先级筛选不一致。
  // 升级为会话级：切页返回保持，重开应用清空。
  const [doneFilter, setDoneFilter] = useSessionState<'all' | 'unverified' | 'verified'>('tasks.doneFilter', 'unverified');
  // 待办/已完成区块排序：会话级偏好，默认保持后端顺序
  const [todoSort, setTodoSort] = usePersistentState<'default' | 'timedesc' | 'timeasc' | 'pdesc' | 'pasc' | 'manual'>('tasks.todoSort', 'default'); // T01697：排序偏好持久化（重启保持）
  const [doneSort, setDoneSort] = usePersistentState<'default' | 'timedesc' | 'timeasc' | 'pdesc' | 'pasc' | 'manual'>('tasks.doneSort', 'default'); // T01697
  // T00456 / PRD UX-1：视图模式（列表/看板）会话级保持
  const [viewMode, setViewMode] = useSessionState<'list' | 'board'>('tasks.viewMode', 'list');
  // T03209（PM-101）：看板隐藏空列——会话级保持，切换页签/窗口期间保持
  const [boardHideEmpty, setBoardHideEmpty] = useSessionState<boolean>('tasks.board.hideEmpty', false);
  // T03209（PM-101）：WIP 上限输入草稿（按项目存放，提交成功后清理）
  const [wipDrafts, setWipDrafts] = useState<Record<string, string>>({});
  const [wipBusy, setWipBusy] = useState(false);
  // T03268（PRD 4.2）：项目时区输入草稿（按项目存放，提交成功后清理）
  const [tzDrafts, setTzDrafts] = useState<Record<string, string>>({});
  const [tzBusy, setTzBusy] = useState(false);

  // T00466：数据刷新时间戳——刷新后 updated_at 晚于该值的行闪烁一次（与提示词页 flush 动效统一）
  const [refreshFlash, setRefreshFlash] = useState(0);
  // T00489：按住行 200ms 才触发缩放（快速点击不缩放，点行内按钮不触发——消除按钮点击漂移感）
  const [pressId, setPressId] = useState('');
  // T00496：项目自绘下拉展开态（项目名后动态徽标：橙=待办数、黄=未验证数）
  const [projOpen, setProjOpen] = useState(false);

  // T00655：项目排序与置顶——排序方式会话级持久（下次进入恢复）；置顶经项目 sort_weight 持久到后端
  const [projSortMode, setProjSortMode] = usePersistentState<ProjectSortMode>('tasks.projectSort', 'default'); // T01697
  const [projSortOpen, setProjSortOpen] = useState(false);
  const projSortRef = useRef<HTMLSpanElement | null>(null); // T00655：排序菜单外部点击收起
  const sortedProjects = useMemo(() => sortProjects(projects, projSortMode), [projects, projSortMode]); // T00663：排序逻辑复用共享模块

  /** T00655：置顶/取消置顶——置顶写入较大 sort_weight（默认序下排最前），取消归零 */
  async function toggleProjectPin(pj: Project) {
    try {
      const nowPinned = await togglePinShared(pj); // T00663：置顶逻辑复用共享模块
      flash(nowPinned ? `已置顶「${pj.name}」（默认排序下排最前）` : `已取消置顶「${pj.name}」`);
      void loadProjects();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  }
  const projDropRef = useRef<HTMLDivElement | null>(null);
  // T01584：上次「点击刷新项目计数」的时间戳——连点只按节流窗口拉一次，不打爆后端
  const projCountsAtRef = useRef(0);
  const pressTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const loadProjects = useCallback(async () => {
    await refreshProjectList();
    const list = getProjectListSnapshot();
    if (list.length === 0) return;
    // T03211（PM-105）：全部项目是显式视图，不参与「回退到首个项目」的失效纠正
    if (activeProject === ALL_PROJECTS) return;
    // 持久化的 activeProject 可能已失效（项目被删）：不在列表内则回退到首个有效项目并纠正持久化，避免反复踩空
    if (!activeProject || !list.some((p) => p.id === activeProject)) {
      setActiveProject(list[0].id);
    }
  }, [activeProject]);

  /** T01584：展开项目下拉时按需刷新徽标计数（待办/未验证）。
   *  既有刷新链路是「SSE 变更推送 + 10s 外部变更轮询」，两者都只保证最终一致——
   *  用户点开下拉那一刻看到的仍可能是旧值（断线兜底期间、或别的窗口刚改完）。
   *  这里把「点击」变成主动拉取：800ms 节流窗口内的连点不重复发请求（约束 3）。 */
  const refreshProjCounts = useCallback(() => {
    const now = Date.now();
    if (now - projCountsAtRef.current < 800) return;
    projCountsAtRef.current = now;
    void loadProjects();
  }, [loadProjects]);

  /**
   * 分页拉取任务。搜索/分类经后端过滤后再分页，保证分页下检索结果完整（而非只搜已加载页）；
   * offset=0 且 replace=true 为重置拉取（切项目/搜索/分类/操作后刷新），否则为追加下一页。
   */
  const fetchTasks = useCallback(async (projectId: string, offset: number, replace: boolean) => {
    if (!projectId) return;
    // T03211：全部项目视图不带 projectId，拿跨项目任务集
    const p = scopeParams(projectId);
    p.set('limit', String(PAGE_SIZE));
    if (offset > 0) p.set('offset', String(offset));
    const kw = search.trim();
    if (kw) p.set('keyword', kw);
    if (catFilter === 'none') p.set('categoryId', 'none');
    else if (catFilter) p.set('categoryId', catFilter);
    if (priorityFilter) p.set('priority', priorityFilter);
    // T03232（PM-203③）：自定义字段筛选/排序——服务端执行，翻页后仍是同一套谓词与序。
    // 「需要填值」的算子没填值时不下发（等同于未启用），避免用户刚选中字段就把列表筛空。
    if (projectId !== ALL_PROJECTS && fieldFilterField && fieldFilterOp
      && (!FIELD_OP_NEEDS_VALUE.has(fieldFilterOp) || fieldFilterValue.trim())) {
      p.set('fieldFilters', JSON.stringify([{ fieldId: fieldFilterField, op: fieldFilterOp, value: fieldFilterValue }]));
    }
    if (projectId !== ALL_PROJECTS && fieldSort) {
      const [fid, dir] = fieldSort.split('|');
      if (fid) p.set('fieldSort', JSON.stringify({ fieldId: fid, dir: dir === 'desc' ? 'desc' : 'asc' }));
    }
    // T02283：主列表拉取失败此前一路冒泡——`void loadTasks(activeProject)`（约 30 处调用点）不接拒绝，
    // 断供时既刷出 unhandled rejection，界面又停在「暂无待办任务」空态冒充正常。
    // 改为就地收下：失败只置 error 态，绝不覆盖上次成功数据（与 T02213 同口径）。
    let list: Task[];
    // T03214（UX-02 ①）：本轮信封里的服务端总数——hasMore 判据要用它，不能等 setState 后再读（异步）
    let fetchedTotal: number | null = null;
    try {
      const pTotal = new URLSearchParams(p);
      pTotal.set('total', '1');
      // T02284 通道在旧安装包后端上不存在（实测装机 39877 带 total=1 仍回裸数组），
      // 故按可空信封解析：拿不到 total 时页脚不显示总数，主列表不受影响。
      const res = await api.get<Paged<Task> | Task[]>(`/tasks?${pTotal.toString()}`);
      const page = Array.isArray(res) ? { items: res, total: null as number | null } : { items: res.items, total: res.total };
      list = page.items;
      fetchedTotal = page.total;
      setServerTotal(page.total);
      setTasksPhase('ready'); setTasksError('');
    } catch (e) {
      setTasksPhase('error');
      setTasksError(e instanceof Error ? e.message : String(e));
      return;
    }
    const nextTodo = list.filter((t) => t.status === 'todo');
    const nextDone = list.filter((t) => t.status === 'done');
    setTodo((prev) => (replace ? nextTodo : [...prev, ...nextTodo]));
    setDone((prev) => (replace ? nextDone : [...prev, ...nextDone]));
    // T03214（UX-02 ①）：满页只是「可能有下一页」；拿到服务端总数时以「已取回数 < 总数」为准，正好一页不再多点一次空页
    const pageView = paginationStatus(fetchedTotal, offset + list.length, list.length === PAGE_SIZE);
    setHasMore(pageView.canLoadMore);
    setPageStatus(pageView);
    // T01570：两套查看态共用同一份数据快照——整表刷新后把抽屉持有的任务对象换成新快照，
    // 否则行内编辑保存 / MCP 回传后，已开着的抽屉仍是打开那一刻的旧对象（要关开才更新），
    // 用户在旧文本上再保存就会覆盖掉刚写入的新内容（丢更新）。
    // T01700：版本守卫——快照 updated_at 比抽屉当前值旧（applyTaskPatch 定点补丁已把时间戳抬为本地写入时刻）
    // 说明本次 fetch 在本地 PATCH 落库前发出、内容不含最新写入，覆盖即回退 → 跳过，等下一次新鲜快照。
    // 编辑态不在这里跳过：抽屉自身 useEffect（editing 非空时不同步草稿）已保护草稿，
    // 而取消编辑后要「展示最新」恰恰依赖新快照继续流入 task prop——跳过反而会卡在旧值（探针 S6c 实证）。
    setDrawerTask((cur) => {
      if (!cur) return cur;
      const next = nextTodo.find((x) => x.id === cur.id) ?? nextDone.find((x) => x.id === cur.id);
      if (!next) return cur;
      if ((next.updated_at ?? '') < (cur.updated_at ?? '')) return cur;
      return next;
    });
    // T00719：搁置列表随同一套查询条件（关键词/分类/优先级）刷新；搁置量通常较少，直接全量拉取（无 offset）
    try {
      const ps = new URLSearchParams(p);
      ps.set('shelved', '1');
      ps.delete('offset');
      const nextShelved = await api.get<Task[]>(`/tasks?${ps.toString()}`);
      setShelvedTasks(nextShelved);
      setShelvedPhase('ready');
      setShelvedError('');
      setDrawerTask((cur) => {
        if (!cur) return cur;
        const next = nextShelved.find((x) => x.id === cur.id);
        if (!next) return cur;
        if ((next.updated_at ?? '') < (cur.updated_at ?? '')) return cur;
        return next;
      });
    } catch (e) {
      // T02290：保留「搁置拉取失败不打断主列表」的既有取舍，只是不再无声——置 error 让搁置 tab 给出原因与重试，
      // 旧数据仍在 shelvedTasks 里，由 ResourceHint 的 stale 语义标成「上次成功的数据，可能过期」。
      setShelvedPhase('error');
      setShelvedError(e instanceof Error ? e.message : String(e));
    }
  }, [search, catFilter, priorityFilter, fieldFilterField, fieldFilterOp, fieldFilterValue, fieldSort]);

  const loadTasks = useCallback(async (projectId: string) => {
    if (!projectId) return;
    await fetchTasks(projectId, 0, true);
    // T00466：刷新后打时间戳，updated_at 晚于该值的行播 flush 动画（与提示词页统一）
    setRefreshFlash(Date.now());
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

  // ===== T03215（PM-304）：可见列表派生上提 + 窗口化 =====
  // 窗口化后滚动会驱动本组件重渲染；派生计算（过滤/排序/父子装配）必须留在组件级 useMemo 里，
  // 否则每帧重跑一遍 5000 条的 filter+sort+O(n²) 装配，等于把省下来的渲染成本又还回去。
  const kw = search.trim().toLowerCase();
  const matches = useMemo(() => makeTaskMatcher(kw, catFilter), [kw, catFilter]);
  const visibleTodo = useMemo(() => arrangeTaskTree(sortTasks(todo.filter(matches), todoSort)), [todo, matches, todoSort]);
  const visibleDone = useMemo(() => arrangeTaskTree(sortTasks(done.filter(matches).filter((t) => matchVerified(t, doneFilter)), doneSort)), [done, matches, doneSort, doneFilter]);
  const visibleShelved = useMemo(() => arrangeTaskTree(sortTasks(shelvedTasks.filter(matches), shelvedSort)), [shelvedTasks, matches, shelvedSort]);
  // 行内拖拽重排需要整表 id 顺序：原实现让每个渲染行都重算一次整表 id（O(n²)），这里一次算好传下去
  const todoIds = useMemo(() => visibleTodo.map((t) => t.id), [visibleTodo]);
  const doneIds = useMemo(() => visibleDone.map((t) => t.id), [visibleDone]);
  const shelvedIds = useMemo(() => visibleShelved.map((t) => t.id), [visibleShelved]);
  // 一次只挂载一个 tab 的列表，故整块共用一个窗口实例（看板视图不参与窗口化）
  const activeVisible = activeTab === 'done' ? visibleDone : activeTab === 'shelved' ? visibleShelved : visibleTodo;
  const activeVisibleIds = activeTab === 'done' ? doneIds : activeTab === 'shelved' ? shelvedIds : todoIds;
  // 搁置列表是全量拉取（不分页），触底续取只对带分页的待办/已完成生效，否则会在看不见的列表上白取一页
  const listWin = useTaskListWindow(
    viewMode === 'list' ? activeVisible.length : 0,
    hasMore && viewMode === 'list' && activeTab !== 'shelved',
    loadMore,
    !loadingMore,
  );
  const revealedForRef = useRef('');
  /** 目标行没渲染在 DOM 里（被窗口切掉）时按索引把它滚进窗口；同一目标只强制一次，避免定位与窗口互相打转 */
  const revealTaskRow = useMemo(() => (id: string, taskNo = ''): boolean => {
    const idx = id ? activeVisibleIds.indexOf(id) : activeVisible.findIndex((t) => t.task_no === taskNo);
    const key = id || `no:${taskNo}`;
    if (idx < 0 || revealedForRef.current === key) return false;
    revealedForRef.current = key;
    listWin.revealIndex(idx);
    return true;
  }, [activeVisibleIds, activeVisible, listWin.revealIndex]);
  useEffect(() => {
    // 换目标即解除「已强制入窗过一次」的锁，否则回到同一任务时不再滚动定位
    if (!focusTaskId && revealedForRef.current) revealedForRef.current = '';
  }, [focusTaskId]);

  // T00496：项目下拉点击外部关闭
  useEffect(() => {
    if (!projOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (projDropRef.current && !projDropRef.current.contains(e.target as Node)) setProjOpen(false);
      // T00655：排序菜单与项目下拉共用外部点击收起（保守：点击非排序区即收起）
      if (projSortRef.current && !projSortRef.current.contains(e.target as Node)) setProjSortOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [projOpen]);

  // T00521 调整：验证结果选择面板（通过/失败合一入口）点击外部关闭
  const [verifyMenuId, setVerifyMenuId] = useState('');
  const [verifyMenuPos, setVerifyMenuPos] = useState<{ top: number; left: number } | null>(null);
  const verifyMenuRef = useRef<HTMLSpanElement | null>(null);
  // T01299：面板经 Portal 挂到 body（逃出 .cv-auto 的 paint containment）——外点收起需同时放行面板内点击，
  // 否则 mousedown 命中 body 上的面板即被收起，菜单项 click 永远不会触发。
  const verifyMenuPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!verifyMenuId) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (verifyMenuRef.current?.contains(target)) return;
      if (verifyMenuPanelRef.current?.contains(target)) return;
      setVerifyMenuId('');
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [verifyMenuId]);

  const loadCategories = useCallback(async () => {
    // 分类下拉不因加载失败而阻塞任务页：失败时保持空列表，仅分类功能不可用
    try {
      setTaskCats(await api.get<TaskCategory[]>('/task-categories'));
    } catch { /* 忽略，任务页照常使用 */ }
  }, []);

  /** SSE 变更后校验选中项是否仍存活：剔除已删除任务的选中态，size 不变时返回原引用避免重渲染。
   *  提取为具名函数，避免在 openChangeStream 回调内层层嵌套箭头函数。 */
  const pruneSelectedIds = useCallback((list: Task[]) => {
    setSelectedIds((prev) => {
      const alive = new Set(list.map((t) => t.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  // T02213：选中项有效性校验的失败态。此前取数异常被 `.catch(() => undefined)` 吞掉——
  // 校验没跑成，选中集合里可能留着已被他人删除/归档的任务，后续批量操作就作用在用户看不见的行上。
  const [pruneError, setPruneError] = useState('');
  const validateSelected = useCallback(() => {
    if (!activeProject) return;
    // T03211：全部项目视图校验跨项目选中集；limit 取上限，避免把第 200 条之后的选中项误判为已删除
    const q = scopeParams(activeProject);
    q.set('archived', 'false');
    q.set('limit', '500');
    void api.get<Task[]>(`/tasks?${q.toString()}`)
      .then((list) => { setPruneError(''); pruneSelectedIds(list); })
      .catch((e) => setPruneError(e instanceof Error ? e.message : String(e)));
  }, [activeProject, pruneSelectedIds]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  // 初始/切项目加载；搜索与分类变化会重建 loadTasks（经 fetchTasks 依赖透传），此处防抖 300ms 后重置分页拉取，
  // 避免搜索框逐击键都打后端
  useEffect(() => {
    if (!activeProject) return;
    const t = setTimeout(() => void loadTasks(activeProject), 300);
    return () => clearTimeout(t);
  }, [activeProject, loadTasks]);
  useEffect(() => { void loadCategories(); }, [loadCategories]);

  // T03232（PM-203③）：项目字段随 activeProject 重取；失败不阻塞任务页——控件退化为「无字段」，列表照常
  useEffect(() => {
    if (!activeProject || activeProject === ALL_PROJECTS) { setProjectFields([]); return; }
    let alive = true;
    api.get<CustomField[]>(`/projects/${activeProject}/fields`)
      .then((list) => { if (alive) setProjectFields(list); })
      .catch(() => { if (alive) setProjectFields([]); });
    return () => { alive = false; };
  }, [activeProject]);

  // T03232：切项目/字段被归档后持久化的字段 id 可能已失效——清掉，否则列表被筛成 0 行而控件看着「没筛」
  useEffect(() => {
    const ids = new Set(projectFields.map((f) => f.id));
    if (fieldFilterField && !ids.has(fieldFilterField)) { setFieldFilterField(''); setFieldFilterOp(''); setFieldFilterValue(''); }
    if (fieldSort && !ids.has(fieldSort.split('|')[0])) setFieldSort('');
  }, [projectFields, fieldFilterField, fieldSort, setFieldFilterField, setFieldFilterOp, setFieldFilterValue, setFieldSort]);

  // T00836：命令面板定位意图处理——若目标 tab 与当前不一致先切 tab（等该列表渲染后再定位）；
  // 命中行则滚动居中 + 高亮 + 展开描述与处理结果（“显示当前记录信息”），定位完成即消费清空，避免重复触发
  // M6-6.1：聚焦任务前的预处理（切项目 / 清过滤 / 切 tab）；返回 true 表示已执行动作、本轮定位中断
  const runFocusPreCheck = (focusTaskId: string): boolean => {
    // T00836 二轮：任务所属项目与当前 activeProject 不一致时，先切项目（会触发 loadTasks 重新加载该任务列表）
    if (focusProjectId && activeProject !== focusProjectId) {
      setActiveProject(focusProjectId);
      setFocusProjectId('');
      return true;
    }
    // T00836 二轮：分类/优先级/自定义字段过滤会把目标任务过滤出列表——定位前先清空，保证目标行在全量结果里可见
    if (catFilter || priorityFilter || fieldFilterField) {
      if (catFilter) setCatFilter('');
      if (priorityFilter) setPriorityFilter('');
      if (fieldFilterField) { setFieldFilterField(''); setFieldFilterOp(''); setFieldFilterValue(''); }
      setFocusProjectId('__fetch_filter__');
      return true;
    }
    if (focusTab && (focusTab === 'todo' || focusTab === 'done') && focusTab !== activeTab) {
      setActiveTab(focusTab);
      return true;
    }
    return false;
  };

  // M6-6.1：在已渲染列表中定位目标任务行并高亮。T02206：返回是否命中——未命中不再就地清键，
  // 交由调用方按截止时间重试收口（跨项目跳转必然经历「换项目→重载列表→再渲染」，首轮检查基本都落空）。
  const locateTaskRow = (focusTaskId: string): boolean => {
    const el = document.querySelector(`[data-ttask-id="${focusTaskId}"]`);
    // T03215（PM-304）：窗口化后「该行确实在结果集里但没渲染」成了常态——按索引把它强制入窗，
    // nonce 变化会重跑本定位流程，下一轮即可命中；仍未命中才交给 8s 收口定时器明示失败。
    if (!(el instanceof HTMLElement)) { revealTaskRow(focusTaskId); return false; }
    try { el.scrollIntoView({ block: 'center' }); } catch { /* 忽略滚动异常 */ }
    const prevOutline = el.style.outline;
    const prevBg = el.style.background;
    el.style.outline = '2px solid var(--accent)';
    el.style.outlineOffset = '2px';
    el.style.background = 'var(--accent-soft)';
    setDescExpanded((p) => ({ ...p, [focusTaskId]: true }));
    setResultOpen((p) => ({ ...p, [focusTaskId]: true }));
    setFocusDeadline(0); // 命中即撤收口定时器，不让它在高亮窗口期内误清聚焦态
    const restore = () => { el.style.outline = prevOutline; el.style.background = prevBg; setFocusTaskId(''); setFocusTab(''); };
    globalThis.setTimeout(restore, 3000);
    return true;
  };

  useEffect(() => {
    if (!focusTaskId) { if (focusDeadline) setFocusDeadline(0); return; }
    // 上一节清空过滤后列表重载完成、projectId 无实际目标，进入正式定位流程
    if (focusProjectId === '__fetch_filter__') setFocusProjectId('');
    if (runFocusPreCheck(focusTaskId)) return;
    if (locateTaskRow(focusTaskId)) return;
    // 目标行尚未渲染：保留定位意图（focusTaskId 不清），列表每次变化都会重跑本 effect 再认一次
    if (!focusDeadline) setFocusDeadline(Date.now() + 8000);
  }, [focusTaskId, todo, done, activeTab, activeProject, focusProjectId, catFilter, priorityFilter, fieldFilterField, focusDeadline, listWin.nonce, revealTaskRow]);

  // T02206：到点收口。列表若一直不再变化，重试等不到下一次触发，故用定时器兜底放弃并**明示**一次
  //（原实现在此处静默清键，用户只看到视图变了却不知定位到哪）。
  useEffect(() => {
    if (!focusTaskId || !focusDeadline) return;
    const timer = globalThis.setTimeout(() => {
      setFocusDeadline(0);
      setFocusTaskId('');
      setFocusTab('');
      flash('定位目标行未出现在渲染结果中（可能被当前筛选条件筛掉，或在分页之外）');
    }, Math.max(0, focusDeadline - Date.now()));
    return () => clearTimeout(timer);
  }, [focusTaskId, focusDeadline]);

  /** T02196：按编号在「已渲染」的标题行里认目标——回落通道此时只有编号、没有 id */
  const findRowElByNo = (no: string): HTMLElement | null => {
    const label = `任务编号 ${no}`;
    return [...document.querySelectorAll<HTMLElement>('[data-ttask-id]')]
      .find((el) => el.querySelector(`[aria-label="${label}"]`) != null) ?? null;
  };

  // T02196：标题区「派生自」徽标点击的落地——目标行就在当前已加载列表里时，只做
  // 「必要时切 tab + 滚动居中 + 短暂高亮」，不写搜索词、不清筛选、不动排序
  // （任务原文约束「不得重置用户的其他筛选或排序条件」）。
  // 列表里没有该行，或有但视图没呈现（分页之外、被当前筛选条件筛掉）时，才退回 focusTaskByNo
  // 的编号检索通道，并先给出提示——让「视图被改变」始终是明示而非静默发生。
  // 回落时定位意图不丢：检索是异步的（换项目→重载列表→渲染），故意图带截止时间留在 state 里，
  // 列表每次变化都按编号再认一次目标行，命中后同样给 .locate-flash 高亮。
  useEffect(() => {
    if (!badgeLocate) return;
    if (badgeLocate.id && badgeLocate.tab !== activeTab) { setActiveTab(badgeLocate.tab); return; }
    const el = badgeLocate.id
      ? document.querySelector<HTMLElement>(`[data-ttask-id="${badgeLocate.id}"]`)
      : findRowElByNo(badgeLocate.taskNo);
    if (el instanceof HTMLElement) {
      const flashId = el.getAttribute('data-ttask-id') ?? '';
      setBadgeLocate(null);
      try { el.scrollIntoView({ block: 'center' }); } catch { /* 忽略滚动异常 */ }
      if (flashId) {
        setLocateFlashId(flashId);
        globalThis.setTimeout(() => setLocateFlashId((cur) => (cur === flashId ? '' : cur)), 1500);
      }
      return;
    }
    if (badgeLocate.retrieved) {
      if (Date.now() > badgeLocate.until) setBadgeLocate(null); // 检索也没带来该行（编号不可达/被筛掉）即放弃，不让意图滞留
      return;
    }
    // T03215（PM-304）：该行可能已在列表里但被窗口切掉——先按索引强制入窗，nonce 重跑后再认一次
    if (revealTaskRow(badgeLocate.id, badgeLocate.taskNo)) return;
    flash(`原任务 ${badgeLocate.taskNo} 不在当前列表（视图未呈现该行），已按编号检索定位`);
    setBadgeLocate({ ...badgeLocate, id: '', retrieved: true, until: Date.now() + 8000 });
    void focusTaskByNo(badgeLocate.taskNo);
  }, [badgeLocate, activeTab, todo, done, shelvedTasks, listWin.nonce, revealTaskRow]);

  /** T02196：「派生自 xxx」徽标点击——按编号在当前已加载列表里找父任务，命中即原地定位（零视图状态变更）。
   *  派生单与原任务同项目是常态，故绝大多数点击走的是这条通道；只有列表里确实没有该行
   *  （跨项目、分页之外、被当前筛选条件筛掉）才退回 focusTaskByNo 的编号检索定位。 */
  const locateDerivedTask = (taskNo: string | null | undefined): void => {
    const no = taskNo?.trim();
    if (!no) return;
    const hit = [...todo, ...done, ...shelvedTasks].find((x) => x.task_no === no);
    let tab: ActiveTab = 'todo';
    if (hit) {
      if (shelvedTasks.includes(hit)) tab = 'shelved';
      else if (done.includes(hit)) tab = 'done';
    }
    setBadgeLocate({ taskNo: no, id: hit?.id ?? '', tab: hit ? tab : activeTab, retrieved: false, until: Date.now() + 8000 });
  };

  // T01562：外部跳转（focusTaskByNo openDrawer=true）写入 focusDrawerId 后，自动唤起右侧真抽屉；
  // 与行内展开（快速预览）并存，抽屉=完整操作台。解析到任务即唤起并清空会话键。
  // 列表尚未就绪时保留会话键（外部跳转后任务数据晚于会话键到达，过早清空会导致抽屉不弹），
  // 仅在「已加载到数据却找不到该任务」（已删/不可见）时清空，避免会话键长期滞留。
  // T01568：focusDrawerTab 与 focusDrawerId 成对消费——决定抽屉落在哪个标签页（非法值回落 desc），
  // 且无论命中与否都清空，防止残留的 tab 键影响下一次手动开抽屉。
  useEffect(() => {
    if (!focusDrawerId) return;
    const t = [...todo, ...done, ...shelvedTasks].find((x) => x.id === focusDrawerId);
    const tab: TaskDetailTab | null = (DRAWER_TABS as string[]).includes(focusDrawerTab)
      ? (focusDrawerTab as TaskDetailTab)
      : (focusDrawerTab ? 'desc' : null);
    if (t) {
      setDrawerTask(t);
      setDrawerTab(tab);
      setFocusDrawerId('');
      setFocusDrawerTab('');
      return;
    }
    if (todo.length + done.length + shelvedTasks.length > 0) {
      setFocusDrawerId('');
      setFocusDrawerTab('');
    }
  }, [focusDrawerId, focusDrawerTab, todo, done, shelvedTasks]);

  // T01568：外部跳转的「定位意图」事件——会话键只在本页挂载那一刻被 useSessionState 读取一次，
  // 而 OS 通知/铃铛/就绪条常在用户已停在任务页时触发（不重新挂载），只写 sessionStorage 会「点了没反应」。
  // 事件把同一份意图直写本页状态；未挂载时没有监听者，仍由会话键在挂载时接管，两条路径落点一致。
  // 抽屉优先用事件携带的完整任务直接打开：列表此刻可能仍筛着上一条通知的编号，按列表查找会静默丢失本次跳转。
  useEffect(() => {
    const onFocusIntent = (e: Event) => {
      const d = (e as CustomEvent<FocusTaskIntent | undefined>).detail;
      if (!d || !d.taskNo) return;
      setSearch(d.taskNo);
      if (!d.id) return; // 解析失败：仅带编号搜索词落到任务页，由用户自行检索
      setFocusTaskId(d.id);
      if (d.projectId) setFocusProjectId(d.projectId);
      if (d.tab) { setFocusTab(d.tab); setActiveTab(d.tab); }
      if (d.drawerTab && d.task) {
        setDrawerTask(d.task);
        setDrawerTab(d.drawerTab);
        // 本页已直接接管本次跳转：清掉刚写入的会话键，否则任务页下次挂载（切页/刷新）会再弹一次旧抽屉
        clearSessionState('tasks.focusDrawerId');
        clearSessionState('tasks.focusDrawerTab');
      } else if (d.drawerTab) {
        setFocusDrawerId(d.id);
        setFocusDrawerTab(d.drawerTab);
      }
    };
    globalThis.addEventListener('mtaskFocusTask', onFocusIntent);
    return () => globalThis.removeEventListener('mtaskFocusTask', onFocusIntent);
    // 订阅只需一次：回调内全部是 useState 的 setter（身份稳定）
  }, []);

  /**
   * T01570：行内三块展开态 → 抽屉落位（减少两套查看态各自的困惑）。
   * 用户在列表里点开哪一块，就说明他正在看那块内容，抽屉打开即落对应标签页；
   * 优先级取「正在处理的内容」在上：处理结果（含未保存草稿）> AI 摘要 > 描述；
   * 三块都没展开过则返回 null，抽屉保持自身默认「描述」页（T01562 原行为不变）。
   * 注：验证失败反馈（failbackOpen）在抽屉里没有对应标签页，故不参与映射。
   */
  const drawerTabFromInline = (t: Task): TaskDetailTab | null => {
    if (resultOpen[t.id] || resultDrafts[t.id] !== undefined) return 'result';
    if (summaryExpanded[t.id]) return 'summary';
    if (descExpanded[t.id]) return 'desc';
    return null;
  };

  // T01568：行内按钮开抽屉的统一入口；T01570：tab 省略=按行内已展开区块推断，显式传 null=强制走默认「描述」。
  // 外部跳转（通知/就绪条）走 focusDrawerId 会话键 / mtaskFocusTask 事件并显式指定落位，不受推断影响。
  const openDetailDrawer = (t: Task, tab?: TaskDetailTab | null): void => {
    setDrawerTab(tab === undefined ? drawerTabFromInline(t) : tab);
    setDrawerTask(t);
  };

  /**
   * T01570：抽屉保存后的定点同步——把本次改写的字段就地合并进待办/已完成/搁置列表与抽屉自身，
   * 行内对应区块立刻显示新文本，不再依赖 loadTasks 整表重载才更新（重载仍由 SSE/轮询作兜底，二者幂等）。
   * 行内未保存草稿（resultDrafts/descDrafts）不动：那是用户正敲的内容，不能被抽屉的保存覆盖。
   */
  const applyTaskPatch = (taskId: string, patch: TaskPatch): void => {
    const splice = (list: Task[]): Task[] => list.map((t) => (t.id === taskId ? { ...t, ...patch } : t));
    setTodo(splice);
    setDone(splice);
    setShelvedTasks(splice);
    // T01700：抽屉镜像合并时把 updated_at 抬为本地写入时刻——比任何「PATCH 落库前发出」的在途列表快照都新，
    // fetchTasks 的版本守卫（见下）据此跳过旧快照，杜绝「外部 PATCH→立即保存/回滚→被旧快照打回」的丢更新竞态。
    // 列表行不抬时间戳：其自愈由轮询签名（updated_at 入 sig）触发整表重载兜底，无需在客户端伪造。
    const stamp = new Date().toISOString();
    setDrawerTask((cur) => (cur && cur.id === taskId ? { ...cur, ...patch, updated_at: stamp } : cur));
  };

  // T00433：MCP 回传 / 队列执行 / 其他窗口改任务状态时，前端无感知——轻量轮询对比签名，有变化才刷新。
  // 保护条件：任何未保存草稿或 AI 操作进行中时跳过本轮，避免打断用户编辑（变化留待下一轮干净窗口）。
  // T00457：批量操作——多选模式 + 选中任务集合（跨待办/已完成统一 id 集合）
  const [multiSelect, setMultiSelect] = useState(false);
  // T00446 / INT-6：CSV 导入预览状态
  const [csvPreview, setCsvPreview] = useState<{ items: Array<{ title: string; description: string; priority: string; status: string; categoryId: string | null; categoryName: string }>; errors: Array<{ row: number; message: string }> } | null>(null);
  const [csvImportKind, setCsvImportKind] = useState<'csv' | 'json'>('csv'); // T00556：导入类型分流
  // T03267（PM-402②）：CSV 来源识别与字段映射——改映射要按原文件重解析，故保留原始字节
  const [csvMeta, setCsvMeta] = useState<{ source: 'github' | 'jira' | 'generic'; headers: string[]; mapping: Record<string, string> } | null>(null);
  const [csvRaw, setCsvRaw] = useState<ArrayBuffer | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // T02213：选中集清空后撤掉校验失败提示——否则下次勾选会把上一次的失败原因原样带出来
  useEffect(() => { if (selectedIds.size === 0) setPruneError(''); }, [selectedIds]);
  // T01065-FR1.6：批量操作撤销快照栈（操作前旧值；栈顶=最近一次；归档类不入栈，归档页可自行恢复）
  // T01065 后续：由「只留最近一次」改为最多 MAX_UNDO_STEPS 级的栈——连续多次批量操作可逐级回退，
  // 也可以从步骤列表直接回到中间某一步（撤销该步及其之后的所有步）。
  const [batchStack, setBatchStack] = useState<BatchSnapshot[]>([]);
  const [batchReceipt, setBatchReceipt] = useState<BatchReceipt | null>(null);
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
        // T03211：外部变更签名轮询同样支持全部项目视图
        const sigQ = scopeParams(activeProject);
        sigQ.set('archived', 'false');
        sigQ.set('limit', '500');
        const list = await api.get<Task[]>(`/tasks?${sigQ.toString()}`);
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
        // T00657：项目下拉的待办/未验证计数随任务变化 → 实时刷新项目列表
        void loadProjects();
        // 评审 P2-1 修复：选中项有效性校验移出 setState updater（原嵌套异步 setState 为反模式）；
        // 串行 SSE 通知下幂等：重复校验以 alive 集合为准，size 不变时返回原引用避免重渲染
        if (selectedIds.size > 0) validateSelected();
      }
    });
  }, [activeProject, loadTasks, selectedIds, validateSelected]);
  // 工具下拉展开期间监听全局焦点移出：内部元素间切换时 relatedTarget 仍在容器内不收起，移出容器才收起。
  // 挂在 document 上而非容器 div，可避免为挂 onBlur 而给非交互容器加 tabIndex/role

  async function createProject() {
    const name = await askInput({ title: '新项目名称', placeholder: '请输入项目名称' });
    if (!name) return;
    let created: Project | undefined;
    try {
      created = await api.post<Project>('/projects', { name });
    } catch (e) {
      // T02481：重名（含历史资产/归档区占用）后端会回 400，以前这里没有 catch，
      // 点击后既不建项目也不提示，看起来像按钮没反应。与改名/删除保持一致，把原文提示出来。
      return flash(e instanceof Error ? e.message : String(e), 'error');
    }
    setActiveProject('');
    void loadProjects();
    // T00771：新建项目后顺带弹出工作空间绑定（可跳过）——建立项目名与工作空间路径的绑定关系
    if (created?.id) setWsPickForNew(created);
  }

  /** T00771：绑定工作空间到项目（PATCH + 本地状态同步，项目切换时下拉条自动联动回显） */
  async function bindWorkspace(projectId: string, path: string) {
    const updated = await api.patch<Project>(`/projects/${projectId}`, { workspacePath: path });
    patchProject(projectId, { workspace_path: updated?.workspace_path ?? path });
    flash(`已绑定工作空间：${path}`);
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
      flash(e instanceof Error ? e.message : String(e), 'error');
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
      return flash(e instanceof Error ? e.message : String(e), 'error');
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
      flash(e instanceof Error ? e.message : String(e), 'error');
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
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  async function createTask() {
    if (!newTitle.trim() || !activeProject) return;
    // T03211：新建任务必须落到具体项目——全部项目视图没有默认归属，先要求选项目
    if (activeProject === ALL_PROJECTS) return flash('全部项目视图下请先选择具体项目再新建任务');
    const creatingTitle = newTitle.trim();
    // 全程置 creating，按钮转圈禁用，避免智能分类等耗时步骤看起来"卡住"
    setBusy('tasks.create', true);
    try {
      // 智能分类开启时：按标题自动匹配分类；未匹配/失败则回退用户手动选择的分类（不阻塞创建）
      // T00473：AI 自动标注优先级——仅当用户未显式调整（默认 normal）时采用 AI 建议，用户可手动覆盖
      const autoCat = smartCat ? await matchCategory(newTitle) : undefined;
      const aiPriority = autoCat?.priority;
      const finalPriority = newPriority === 'normal' && aiPriority ? aiPriority : newPriority;
      const created = await api.post<Task>('/tasks', {
        projectId: activeProject,
        title: newTitle.trim(),
        priority: finalPriority,
        categoryId: (autoCat?.catId ?? newCategory) || undefined,
        description: newDesc.trim() || undefined,
      });
      // 创建时粘贴的截图随后上传到新任务
      for (const img of newImages) {
        await api.post(`/tasks/${created.id}/images`, { data: img.url });
      }
      // T03209（PM-101）：新建即计入待办列头数
      bumpProjectCounts(activeProject, 1, 0);
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
      flash(`已创建：${creatingTitle}`, 'info'); // T03214（UX-02③）：成功走短提示，行本身由列表重载呈现
      void loadTasks(activeProject);
    } catch (e) {
      // T03214（UX-02③）：原先只有 finally，创建失败冒泡成未捕获 rejection——用户看不到任何反馈，输入框内容也留着像没反应
      flash(`新建任务失败：${e instanceof Error ? e.message : String(e)}`, 'error');
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
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /** 置顶/取消置顶：切换后重新拉取，置顶项紧随各自待办/已完成分组顶部；失败时静默，由列表重载兜底 */
  async function togglePin(task: Task) {
    try {
      await api.patch(`/tasks/${task.id}`, { pinned: !task.pinned });
      void loadTasks(activeProject);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  /** T03209（PM-101）：项目待办/已完成计数乐观增减——项目列表缓存 60s，状态流转/新建后看板列头需即时反映 */
  function bumpProjectCounts(projectId: string, deltaTodo: number, deltaDone: number) {
    if (!projectId) return;
    const cur = getProjectListSnapshot().find((p) => p.id === projectId);
    if (!cur) return;
    patchProject(projectId, {
      todo_count: Math.max(0, (cur.todo_count ?? 0) + deltaTodo),
      done_count: Math.max(0, (cur.done_count ?? 0) + deltaDone),
    });
  }

  async function setStatus(task: Task, status: 'todo' | 'done') {
    await api.patch(`/tasks/${task.id}`, { status });
    // T03209：列头实时任务数——状态实际变化时才推进项目计数（重复点同一状态不计数）
    if (task.status !== status) {
      bumpProjectCounts(task.project_id, status === 'todo' ? 1 : -1, status === 'done' ? 1 : -1);
    }
    // 切换完成后自动收起展开区（描述+AI 摘要）：仅当处于展开态才触发更新，避免无关任务行无谓重渲染
    setDescExpanded((prev) => (prev[task.id] ? { ...prev, [task.id]: false } : prev));
    setSummaryExpanded((prev) => (prev[task.id] ? { ...prev, [task.id]: false } : prev));
    void loadTasks(activeProject);
  }

  /** FR5 已完成任务：标记验证通过（T00521 调整：验证失败路径统一走 markVerifyFailed，由验证选择面板入口触发） */
  async function toggleVerified(task: Task) {
    await api.patch(`/tasks/${task.id}`, { verified: true });
    // T00623：验证通过后收起该任务的「验证失败反馈」展开区（徽标随 verified 隐藏，展开区不应残留）
    setFailbackOpen((p) => ({ ...p, [task.id]: false }));
    setFbDrafts((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    void loadTasks(activeProject);
  }

  /** T00521/T00610：手动标记验证失败——打开专属录入弹窗（支持截图上传/粘贴）→ 提交后回退待办 */
  function markVerifyFailed(task: Task) {
    setFailDialog({ taskId: task.id, title: task.title, text: '', images: [] });
  }

  /** T00610：提交验证失败反馈——文本追加【验证失败】段 + 截图逐张上传到任务（MCP 可读取识别） */
  async function submitVerifyFailed() {
    if (!failDialog) return;
    const fb = failDialog.text.trim();
    if (!fb && failDialog.images.length === 0) { flash('请填写失败原因或上传截图'); return; }
    const task = [...todo, ...done].find((x) => x.id === failDialog.taskId);
    if (!task) { setFailDialog(null); return; }
    setFailBusy(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const tail = fb ? `\n\n【验证失败 ${stamp}】${fb}` : `\n\n【验证失败 ${stamp}】（附截图）`;
      const merged = `${task.handle_result ?? ''}${tail}`.trim();
      // T00531：服务端 PATCH 只认 camelCase handleResult
      await api.patch(`/tasks/${task.id}`, { verified: false, status: 'todo', handleResult: merged });
      // T00610：截图随反馈一并落库（复用任务图片通道，MCP/前端均可读取）
      for (const img of failDialog.images) {
        await api.post(`/tasks/${task.id}/images`, { data: img.url });
      }
      const imgNote = failDialog.images.length > 0 ? `（附 ${failDialog.images.length} 张截图）` : '';
      flash(`已标记验证失败并回退待办${imgNote}`);
      setFailDialog(null);
      void loadTasks(activeProject);
    } catch (e) {
      flash(String((e as Error).message ?? e), 'error');
    } finally {
      setFailBusy(false);
    }
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

  /** T00719：搁置 / 恢复——搁置后任务从待办/已完成列表隔离进搁置列表，恢复回到原列表 */
  async function toggleShelve(task: Task) {
    await api.post(`/tasks/${task.id}/shelve`, { shelved: !task.shelved });
    flash(task.shelved ? '任务已恢复到原列表' : '任务已搁置——AI 处理待办时将自动忽略');
    void loadTasks(activeProject);
    void loadProjects();
  }

  /** T02949 方案 A：打开派生单裁决面板——候选按该单结论动态抽取（GET ruling-options 带任务 id），
   *  拉取失败不阻断（仍可输入自定义结果） */
  async function openRulingPanel(task: Task) {
    setRulingTask(task);
    setRulingDraft('');
    try {
      const r = await api.get<{ options: string[] }>(`/tasks/${task.id}/ruling-options`);
      setRulingOptions(r.options ?? []);
    } catch {
      setRulingOptions([]);
      flash('裁决候选拉取失败——可直接输入自定义裁决结果');
    }
  }

  /** T02949：提交裁决——服务端把 ruling_state 翻「已裁决」并把结果**追加**到任务详情末尾（不覆盖），成功后刷新列表 */
  async function submitRuling() {
    if (!rulingTask || !rulingDraft.trim() || rulingBusy) return;
    setRulingBusy(true);
    try {
      await api.post(`/tasks/${rulingTask.id}/ruling`, { result: rulingDraft.trim() });
      flash(`裁决已提交：「${rulingTask.task_no ?? rulingTask.id}」→ 已裁决`);
      setRulingTask(null);
      setRulingDraft('');
      void loadTasks(activeProject);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setRulingBusy(false);
    }
  }

  /** 智能分类（静默）：按标题从候选分类匹配最贴切分类 id；未配工具/未填标题/失败均返回 undefined，不打断创建流程 */
  async function matchCategory(title: string): Promise<{ catId: string; priority?: string } | undefined> {
    if (!organizeToolId || !title.trim() || taskCats.length === 0) return undefined;
    try {
      const r = await api.post<{ ok: boolean; categoryId?: string | null; priority?: string | null; error?: string }>('/tasks/classify', {
        title: title.trim(),
        toolId: organizeToolId,
        categories: taskCats.map((c) => ({ id: c.id, name: c.name })),
      });
      // T00473：返回 { catId, priority }——priority 为 AI 自动标注（urgent/high/normal/low 或 undefined）
      return r.ok && r.categoryId ? { catId: r.categoryId, priority: r.priority ?? undefined } : undefined;
    } catch {
      return undefined;
    }
  }

  /** 单条标题美化：调 AI 润色该任务标题，结果写入标题编辑草稿，用户确认后保存。
   *  按任务隔离并发：不同任务各自独立进行，同一任务重复点击仅在批量中阻断；统一可经顶部「取消」中断。 */
  async function beautify(task: Task) {
    if (batchBusy) return flash('正在进行批量美化，请先在工具栏取消');
    if (beautifyBusy[task.id]) return flash('该任务正在美化，请稍候');
    if (!organizeToolId) return flash(aiBlockedFlash('请先在「模型管理」页添加并选择美化工具'));
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
      beautifyStore.setDraft(task.id, result.content.trim());
      flash('美化完成，可编辑后保存');
    } catch (e) {
      // 用户主动取消时静默，不弹错误
      if ((e as Error).name !== 'AbortError') flash(e instanceof Error ? e.message : String(e), 'error');
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

  /** T00597：AI 简化标题——依据任务详情高度总结（限 40 字），结果写入标题草稿待用户确认保存。
   *  前置校验：任务须有详情内容（description 非空），否则友好提示不触发（避免无来源的语义丢失）。 */
  async function simplify(task: Task) {
    if (batchBusy) return flash('正在进行批量处理，请先在工具栏取消');
    if (beautifyBusy[task.id]) return flash('该任务正在处理，请稍候');
    if (!organizeToolId) return flash(aiBlockedFlash('请先在「模型管理」页添加并选择工具'));
    if (!task.title.trim()) return flash('该任务无标题可简化');
    if (!(task.description ?? '').trim()) {
      return flash('AI 简化需依据任务详情总结标题——请先补充该任务的详情内容，避免语义丢失');
    }
    const ac = new AbortController();
    beautifyStore.aborts[task.id] = ac;
    beautifyStore.setBusy(task.id);
    try {
      const result = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/simplify', {
        toolId: organizeToolId, title: task.title, description: task.description ?? '',
      }, ac.signal);
      if (!result.ok) return flash(result.error ?? '简化失败');
      if (!result.content?.trim()) return flash('AI 未返回简化标题');
      beautifyStore.setDraft(task.id, result.content.trim());
      flash('已简化（限 40 字），可编辑后保存');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') flash(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      beautifyStore.clearBusy(task.id);
      delete beautifyStore.aborts[task.id];
    }
  }

  /** 批量美化项目全部待办标题：逐条调用，结果分别写入各标题编辑草稿供逐条确认。
   *  批量独占：进行期间禁止新单条/新批量，避免各实例写草稿相互覆盖；统一经工具栏取消。 */
  async function beautifyAll() {
    if (anyBeautify) return flash('正在进行 AI 美化，请先在工具栏取消');
    if (!organizeToolId) return flash(aiBlockedFlash('请先在「模型管理」页添加并选择美化工具'));
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
      if ((e as Error).name !== 'AbortError') flash(e instanceof Error ? e.message : String(e), 'error');
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
    } catch (e) { flash(e instanceof Error ? e.message : String(e), 'error'); }
  }

  /** T00658：分区全选/全不选（半选态由 checked/indeterminate 双属性表达） */
  function toggleSelectAll(items: Task[], on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const t of items) { if (on) next.add(t.id); else next.delete(t.id); }
      return next;
    });
  }

  // ---------- T00457：批量操作（多选后批量改状态/分类/归档，单事务整体回滚） ----------

  function dropTaskReorder(kind: 'todo' | 'done' | 'shelved', listIds: string[], targetId: string) {
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
    }).catch((e) => flash(String((e as Error).message ?? e), 'error'));
  }

  // ---------- T00446 / INT-6：CSV 任务导入（预览 → 确认） ----------

  type CsvPreviewPayload = {
    source?: 'github' | 'jira' | 'generic';
    headers?: string[];
    mapping?: Record<string, string>;
    items: Array<{ title: string; description: string; priority: string; status: string; categoryId: string | null; categoryName: string }>;
    errors: Array<{ row: number; message: string }>;
  };

  /** 同一份 CSV 的预览可重复发起：人工改映射后按原字节重解析（不入库，预览本身幂等） */
  async function previewCsv(buf: ArrayBuffer, mapping?: Record<string, string>) {
    if (!activeProject || activeProject === ALL_PROJECTS) return;
    const q = new URLSearchParams({ projectId: activeProject });
    // 空串要保留：它表示「这一列不导入」，滤掉会让取消映射失效
    if (mapping && Object.keys(mapping).length > 0) q.set('mapping', JSON.stringify(mapping));
    const r = await api.postBinary<CsvPreviewPayload>(`/tasks/import-csv/preview?${q.toString()}`, buf);
    setCsvPreview(r);
    setCsvImportKind('csv');
    setCsvMeta({ source: r.source ?? 'generic', headers: r.headers ?? [], mapping: r.mapping ?? {} });
    if (r.errors.length > 0) flash(`CSV 解析：${r.items.length} 条可导入，${r.errors.length} 行有问题——修正后重新上传`);
    else flash(`CSV 解析完成：${r.items.length} 条待确认导入`);
  }

  async function changeCsvMapping(field: string, header: string) {
    if (!csvRaw || !csvMeta || !csvPreview) return;
    if (batchOpBusy) return flash('上一批操作仍在进行中，请稍候');
    if (field === 'title' && !header) return flash('标题列不能留空', 'error');
    setBatchOpBusy(true);
    try {
      await previewCsv(csvRaw, { ...csvMeta.mapping, [field]: header });
    } catch (e) { flash(String((e as Error).message ?? e), 'error'); } finally { setBatchOpBusy(false); }
  }

  async function onCsvFile(file: File) {
    if (!activeProject) return flash('请先选择项目');
    // T03211：导入需要落到具体项目
    if (activeProject === ALL_PROJECTS) return flash('全部项目视图下请先选择具体项目再导入');
    // T03214（UX-02 ⑤）：预览请求在途时挡掉再次选文件，避免两轮预览相互覆盖
    if (batchOpBusy) return flash('上一批操作仍在进行中，请稍候');
    setBatchOpBusy(true);
    try {
      // T00556 / PRD INT-6：按扩展名分流——.json 走 JSON 导入（Trello 导出/JSON 数组），其余走 CSV
      const isJson = /\.json$/i.test(file.name);
      if (isJson) {
        const buf = await file.arrayBuffer();
        const r = await api.postBinary<CsvPreviewPayload>(`/tasks/import-json/preview?projectId=${activeProject}`, buf);
        setCsvPreview(r);
        setCsvImportKind('json');
        setCsvMeta(null);
        setCsvRaw(null);
        if (r.errors.length > 0) flash(`JSON 解析：${r.items.length} 条可导入，${r.errors.length} 条有问题——修正后重新上传`);
        else flash(`JSON 解析完成：${r.items.length} 条待确认导入`);
      } else {
        // T03214 真机实测发现：该路由用 raw() 收体，JSON 上传会被全局 express.json 先解析成对象而恒 400——与 JSON 导入一致改发原始字节
        const buf = await file.arrayBuffer();
        setCsvRaw(buf);
        await previewCsv(buf);
      }
    } catch (e) { flash(String((e as Error).message ?? e), 'error'); } finally { setBatchOpBusy(false); }
  }

  async function confirmCsvImport() {
    if (!csvPreview || !activeProject) return;
    // T03214（UX-02 ⑤）：确认导入是异步写库，忙时再点会把同一批预览重复入库
    if (batchOpBusy) return flash('导入仍在进行中，请稍候');
    const preview = csvPreview;
    setBatchOpBusy(true);
    try {
      const path = csvImportKind === 'json' ? '/tasks/import-json/confirm' : '/tasks/import-csv/confirm';
      const r = await api.post<{ ok: boolean; count: number }>(path, { projectId: activeProject, items: preview.items });
      setCsvPreview(null);
      void loadTasks(activeProject);
      // T03214（UX-02 ④）：导入结果落常驻回执——成功/跳过/失败分列带原因，短提示消失后仍可回看
      setBatchReceipt({ ...buildImportReceipt({ kind: csvImportKind, items: preview.items, errors: preview.errors, created: r.count }), at: new Date().toISOString() });
      flash(`${csvImportKind === 'json' ? 'JSON' : 'CSV'} 导入完成：${r.count} 条任务已创建`, 'info');
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setBatchReceipt({ ...buildImportFailureReceipt(csvImportKind, reason), at: new Date().toISOString() });
      flash(reason, 'error');
    } finally { setBatchOpBusy(false); }
  }

  async function batchApply(action: 'status' | 'category' | 'priority' | 'color' | 'archive' | 'verified', value?: string) {
    const ids = [...selectedIds];
    if (ids.length === 0) return flash('请先勾选任务');
    setBatchOpBusy(true);
    try {
      // T03211（PM-105）：服务端逐条回执——失败项带原因，前端常驻展示且保留其选中便于重试
      const r = await api.post<{
        ok: boolean; affected: number; failed?: number; skipped?: number;
        results?: Array<{ id: string; title?: string; ok: boolean; reason?: string }>;
      }>('/tasks/batch', { ids, action, value });
      const results: Array<{ id: string; title?: string; ok: boolean; reason?: string }> =
        r.results ?? ids.map((id) => ({ id, ok: true }));
      const failedItems = results
        .filter((x) => !x.ok)
        .map((x) => ({ id: x.id, title: x.title ?? '', reason: x.reason ?? '未说明原因' }));
      setBatchReceipt({ label: ACTION_LABEL[action], okCount: r.affected, failed: failedItems, at: new Date().toISOString() });
      if (r.affected === 0) {
        flash(action === 'verified' ? '选中任务中没有已完成任务，验收状态未变更（原因见回执）' : '没有可更新的任务（原因见回执）');
        setSelectedIds(new Set(failedItems.map((f) => f.id)));
        void loadTasks(activeProject);
        return;
      }
      flash(`批量操作完成：成功 ${r.affected} 条${failedItems.length > 0 ? `，失败 ${failedItems.length} 条（原因见回执）` : ''}`);
      // T00623 同口径：批量验证通过后收起这些任务的「验证失败反馈」展开区（徽标与入口随 verified 隐藏）
      if (action === 'verified' && value === 'true') {
        setFailbackOpen((prev) => {
          const next = { ...prev };
          for (const id of ids) delete next[id];
          return next;
        });
        setFbDrafts((prev) => {
          const next = { ...prev };
          for (const id of ids) delete next[id];
          return next;
        });
      }
      // T01065-FR1.6：批量操作撤销快照——操作前抓旧值（status/priority/category/color），
      // 工具栏出现「撤销」按钮逐条还原；归档类不入栈（归档页可恢复）
      // T01065 后续：改为入栈（最多 MAX_UNDO_STEPS 级），连续多次批量操作可逐级回退
      if (action !== 'archive') {
        const all = [...todo, ...done, ...shelvedTasks];
        // T03211：只有真正成功的条目入撤销栈——失败项没有改动，回填会制造无意义的「还原」
        const okIds = new Set(results.filter((x) => x.ok).map((x) => x.id));
        const entries = ids
          .filter((id) => okIds.has(id))
          .map((id) => {
            const t = all.find((x) => x.id === id);
            if (!t) return null;
            // T02980：验收结果只回填 verified；待办任务服务端本就不改，不入栈
            if (action === 'verified') return t.status === 'done' ? { id, patch: { verified: t.verified } } : null;
            return { id, patch: { status: t.status, priority: t.priority, category_id: t.category_id, color: t.color || '' } };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        const valueSuffix = action === 'verified'
          ? `（${value === 'true' ? '验证通过' : '未验证'}）`
          : value ? `（${value}）` : '';
        if (entries.length > 0) {
          // 超出上限时丢最旧的一步：撤销栈是「最近操作的后悔药」，最旧的一步价值最低
          setBatchStack((prev) => [...prev, { entries, label: `${ACTION_LABEL[action]}${valueSuffix}`, at: new Date().toISOString() }].slice(-MAX_UNDO_STEPS));
        }
      }
      // T03211：失败项保留选中，用户可修正/重试；全部成功则同既有行为清空选中
      setSelectedIds(new Set(failedItems.map((f) => f.id)));
      void loadTasks(activeProject);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBatchOpBusy(false); }
  }

  /** T01065-FR1.6：批量移动到项目——选中任务整体迁移（moveProject 已有，补批量入口） */
  async function batchMoveTo(projectId: string) {
    const ids = [...selectedIds];
    if (ids.length === 0) return flash('请先勾选任务');
    const target = projects.find((p) => p.id === projectId);
    if (!(await askConfirm(`将选中的 ${ids.length} 条任务移动到「${target?.name ?? projectId}」？`))) return;
    setBatchOpBusy(true);
    try {
      await api.post('/tasks/move', { taskIds: ids, projectId });
      flash(`批量移动完成：${ids.length} 条已迁移到「${target?.name ?? projectId}」`);
      setSelectedIds(new Set());
      void loadTasks(activeProject);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBatchOpBusy(false); }
  }

  /**
   * T01065 后续：撤销 `steps` 步（默认 1 = 只撤最近一次）。
   *
   * 多步撤销必须**从新到旧**依次还原：后一步的旧值里可能包含前一步改动后的字段，
   * 若按从旧到新回放，前一步的旧值会把后一步的还原结果再覆盖回去。
   *
   * @param steps 撤销步数（1~栈深）；越界自动夹到栈深
   */
  async function undoLastBatch(steps = 1) {
    const depth = batchStack.length;
    if (depth === 0 || batchOpBusy) return;
    const n = Math.min(depth, Math.max(1, steps));
    const undoing = batchStack.slice(depth - n); // 末尾 n 步，保持从旧到新
    setBatchOpBusy(true);
    try {
      for (const snap of [...undoing].reverse()) {
        for (const { id, patch } of snap.entries) {
          await api.patch(`/tasks/${id}`, patch);
        }
      }
      const labels = [...undoing].reverse().map((s) => s.label).join('、');
      const restored = undoing.reduce((sum, s) => sum + s.entries.length, 0);
      flash(n === 1 ? `已撤销上次批量操作（${restored} 条已还原：${labels}）` : `已撤销 ${n} 步批量操作（共 ${restored} 次还原：${labels}）`);
      setBatchStack((prev) => prev.slice(0, depth - n));
      void loadTasks(activeProject);
    } catch (e) {
      // 中途失败仍清空这 n 步：库里已是「部分还原」的中间态，再把快照留在栈上会诱使用户重复撤销，
      // 产生更难解释的结果。已还原的部分保持现状，用户可据当前列表重新操作。
      flash(`撤销失败：${e instanceof Error ? e.message : String(e)}（已还原的部分保持当前状态，可重试）`);
      setBatchStack((prev) => prev.slice(0, depth - n));
      void loadTasks(activeProject);
    } finally { setBatchOpBusy(false); }
  }

  async function batchSetCategory() {
    const cat = await askInput({ title: `为选中的 ${selectedIds.size} 个任务设置分类（输入分类名，留空=未分类）`, placeholder: '如：开发' });
    if (cat === null) return;
    const target = taskCats.find((c) => c.name.trim() === cat.trim());
    if (cat.trim() && !target) return flash(`分类「${cat}」不存在，请先在「任务分类」中创建`);
    await batchApply('category', target?.id ?? '');
  }

  /** 看板卡片：可拖拽流转状态（提取为具名函数，降低 JSX 内函数嵌套层级，渲染结果不变）。
   *  T03222（PM-303④）：拖拽是 HTML5 专属交互、键盘无法触发，故同一动作补一份 Enter/Space 键盘等价——
   *  卡片本身即状态切换控件（在待办列按回车=标记完成，在已完成列按回车=转回待办），不改观感。 */
  function renderBoardCard(t: Task) {
    const cat = taskCats.find((c) => c.id === t.category_id);
    const target: 'todo' | 'done' = t.status === 'done' ? 'todo' : 'done';
    // T03229（PM-202②）：卡面徽标之外的可访问名补充——卡片本身是 role=button，
    // 内层 span 的 aria-label 不参与按钮命名，故把阻塞读数并进卡片自身的 aria-label。
    const blockedN = (t.blocked_by ?? []).length;
    return (
      <div key={t.id} /* NOSONAR - HTML5 draggable 卡片：拖拽流转状态无原生等价元素，改 button 会破坏原生拖拽 */
        draggable
        onDragStart={() => setDragTaskId(t.id)}
        onDragEnd={() => { setDragTaskId(''); setOverTaskId(''); }}
        className={dragTaskId === t.id ? 'plan-dragging' : undefined}
        role="button"
        tabIndex={0}
        aria-label={`${t.title}（${priorityLabel(t.priority)}）${blockedN > 0 ? `，被 ${blockedN} 条任务阻塞：${blockBadgeNames(t)}` : ''}— 回车或空格${t.status === 'done' ? '转回待办' : '标记为已完成'}`}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          void setStatus(t, target);
        }}
        style={{
          border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', background: 'var(--card-bg)', cursor: 'grab',
          borderLeft: `3px solid ${priorityBorderColor(t.priority)}`,
        }}
        title={`${t.title}（${priorityLabel(t.priority)}）——拖到另一列，或聚焦后按回车流转状态`}>
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
        {blockedN > 0 && (
          <div style={{ marginTop: 4 }}>{blockBadgeNode(t)}</div>
        )}
        {cat && (
          <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', marginTop: 2 }}>{cat.name}</div>
        )}
      </div>
    );
  }

  /** T03209（PM-101）：保存项目级 WIP 软上限——1~50 整数，即时生效；同值不重复提交 */
  async function saveWipLimit(projectId: string, raw: string) {
    if (!projectId) return;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 1 || n > 50) { flash('WIP 上限须为 1~50 的整数'); return; }
    const cur = getProjectListSnapshot().find((p) => p.id === projectId);
    if ((cur?.wip_limit ?? 10) === n) {
      setWipDrafts((prev) => { const next = { ...prev }; delete next[projectId]; return next; });
      return;
    }
    setWipBusy(true);
    try {
      await api.patch(`/projects/${projectId}`, { wipLimit: n });
      patchProject(projectId, { wip_limit: n });
      setWipDrafts((prev) => { const next = { ...prev }; delete next[projectId]; return next; });
      flash(`WIP 上限已设为 ${n}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    } finally { setWipBusy(false); }
  }

  /** T03268（PRD 4.2）：保存项目时区——空串＝跟随系统；非法 IANA 名本地先拦（服务端同法校验） */
  async function saveProjectTz(projectId: string, raw: string) {
    if (!projectId) return;
    const tz = raw.trim();
    const cur = getProjectListSnapshot().find((p) => p.id === projectId);
    if ((cur?.timezone ?? '') === tz) {
      setTzDrafts((prev) => { const next = { ...prev }; delete next[projectId]; return next; });
      return;
    }
    if (tz && !isValidIanaTz(tz)) { flash(`时区非法：${tz}（需 IANA 时区名，如 Asia/Shanghai）`, 'error'); return; }
    setTzBusy(true);
    try {
      await api.patch(`/projects/${projectId}`, { timezone: tz });
      patchProject(projectId, { timezone: tz });
      setTzDrafts((prev) => { const next = { ...prev }; delete next[projectId]; return next; });
      flash(tz ? `项目时区已设为 ${tz}` : '项目时区已恢复为跟随系统');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    } finally { setTzBusy(false); }
  }

  /** T00456 / PRD UX-1：看板视图——按状态分列（待办/已完成），卡片拖拽流转状态。
   *  卡片为简化渲染（标题/优先级/分类/进度），编辑回列表视图；drop 到目标列即变更状态。 */
  function renderBoard() {
    // T00922：看板标题统计改取项目级全量计数（项目对象上的待办/已完成计数字段），首屏即显示该项目全部待办/已完成，
    // 不再受分页已加载条目数影响（原 done.length 仅覆盖当前已加载页，需「加载更多」后才趋近真实值）
    const curProj = projects.find((p) => p.id === activeProject);
    // T03211：全部项目视图按各项目计数之和展示，口径与列表页页签一致
    const aggTodoBoard = projects.reduce((s, p) => s + (p.todo_count ?? 0), 0);
    const aggDoneBoard = projects.reduce((s, p) => s + (p.done_count ?? 0), 0);
    const todoTotal = curProj?.todo_count ?? (activeProject === ALL_PROJECTS ? aggTodoBoard : todo.length);
    const doneTotal = curProj?.done_count ?? (activeProject === ALL_PROJECTS ? aggDoneBoard : done.length);
    // T03209（PM-101）：WIP 软上限只对具体项目生效——全部项目混合视图无单一项目口径，仅显示数量
    const wipLimit = curProj?.wip_limit ?? 10;
    const wipOver = curProj ? todoTotal - wipLimit : 0;
    const totals: Record<'todo' | 'done', number> = { todo: todoTotal, done: doneTotal };
    const allCols: Array<{ key: 'todo' | 'done'; label: string; items: Task[] }> = [
      { key: 'todo', label: `待办（${todoTotal}）`, items: todo },
      { key: 'done', label: `已完成（${doneTotal}）`, items: done },
    ];
    // 隐藏空列：拖拽进行中临时全显，避免空列被隐藏后无处落下（不阻断拖入）
    const boardCols = boardHideEmpty && !dragTaskId ? allCols.filter((c) => totals[c.key] > 0) : allCols;
    const onDropTo = (target: 'todo' | 'done') => {
      if (!dragTaskId) return;
      const t = [...todo, ...done].find((x) => x.id === dragTaskId);
      if (!t) return;
      if (t.status !== target) void setStatus(t, target);
      setDragTaskId(''); setOverTaskId('');
    };
    const wipDraftVal = wipDrafts[curProj?.id ?? ''] ?? String(wipLimit);
    const tzDraftVal = tzDrafts[curProj?.id ?? ''] ?? (curProj?.timezone ?? '');
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap', fontSize: 'var(--fs-s)' }}>
          <button type="button" aria-pressed={boardHideEmpty} aria-label="隐藏空列"
            title={boardHideEmpty ? '隐藏空列（已开启）— 点击显示全部列；会话内保持' : '隐藏空列（已关闭）— 点击隐藏任务数为 0 的列；会话内保持'}
            onClick={() => setBoardHideEmpty((v) => !v)} className="tbtn-anim"
            style={{ cursor: 'pointer', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: boardHideEmpty ? 'var(--accent-soft)' : 'var(--card-bg)', color: boardHideEmpty ? 'var(--accent)' : 'var(--text-secondary)' }}>
            隐藏空列
          </button>
          {curProj && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
              WIP 上限
              <input type="number" min={1} max={50} step={1} value={wipDraftVal} disabled={wipBusy}
                aria-label="项目 WIP 上限"
                title="项目级 WIP 软上限（1~50，默认 10）——仅统计未完成卡片，超限只做橙色提示、不阻断拖入"
                onChange={(e) => setWipDrafts((prev) => ({ ...prev, [curProj.id]: e.target.value }))}
                onBlur={() => void saveWipLimit(curProj.id, wipDraftVal)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ width: 64, padding: '2px 6px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
            </label>
          )}
          {curProj && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
              时区
              <input list="mtask-tz-options" value={tzDraftVal} disabled={tzBusy}
                aria-label="项目时区"
                placeholder="跟随系统"
                title="项目时区（IANA 名，如 Asia/Shanghai；留空＝跟随系统时区）——报告与计划预测的业务日按此时区计算"
                onChange={(e) => setTzDrafts((prev) => ({ ...prev, [curProj.id]: e.target.value }))}
                onBlur={() => void saveProjectTz(curProj.id, tzDraftVal)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ width: 150, padding: '2px 6px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }} />
              <datalist id="mtask-tz-options">{tzOptions().map((z) => <option key={z} value={z} />)}</datalist>
              {!(curProj.timezone ?? '') && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>系统</span>}
            </label>
          )}
          {wipOver > 0 && (
            <span role="status" style={{ color: 'var(--warn)', fontWeight: 600 }}>超出建议上限 {wipOver}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {boardCols.map((col) => (
            <div key={col.key} /* NOSONAR - 看板列作为 HTML5 拖拽放置区：无原生等价元素，button 不接收 drop */
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDropTo(col.key)}
              style={{ flex: 1, minWidth: 280, background: 'var(--surface)', borderRadius: 8, padding: 10, minHeight: 200, border: overTaskId === col.key ? '2px dashed var(--accent)' : '1px solid var(--border-strong)', transition: 'border .15s ease' }}>
              <h4 style={{ fontSize: 'var(--fs-m)', margin: '0 0 8px', color: col.key === 'todo' && wipOver > 0 ? 'var(--warn)' : 'var(--text-secondary)' }}>
                {col.label}
                {col.key === 'todo' && curProj && (
                  <span style={{ marginLeft: 6, fontWeight: 400, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>WIP 建议 ≤ {wipLimit}</span>
                )}
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {col.items.map((t) => renderBoardCard(t))}
                {col.items.length === 0 && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>拖任务卡片到此列</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // T01480：任务导出——md/xlsx/docx 三格式，单条与批量共用同一装配
  const [exportMenu, setExportMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  async function exportTasks(ids: string[], fmt: 'md' | 'xlsx' | 'docx') {
    setExportBusy(true);
    try {
      const { blob, filename } = await api.postDownload('/tasks/export', { taskIds: ids, format: fmt });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      flash(`已导出 ${filename}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    } finally { setExportBusy(false); setExportMenu(null); }
  }
  const EXPORT_ITEMS: { fmt: 'docx' | 'md' | 'xlsx'; label: string; desc: string }[] = [
    { fmt: 'docx', label: 'Word 文档', desc: '导出为 .docx' },
    { fmt: 'md', label: 'Markdown', desc: '导出为 .md' },
    { fmt: 'xlsx', label: 'Excel 表格', desc: '导出为 .xlsx' },
  ];

  /** T03267（PM-402④）：项目级导出——任务/计划 × Markdown/JSON，任务树与计划树由服务端单源装配 */
  async function exportProject(scope: 'tasks' | 'plans', format: 'md' | 'json') {
    if (!activeProject) return flash('请先选择项目');
    if (activeProject === ALL_PROJECTS) return flash('全部项目视图下请先选择具体项目再导出');
    setExportBusy(true);
    try {
      const { blob, filename } = await api.getDownload(`/projects/${encodeURIComponent(activeProject)}/export?scope=${scope}&format=${format}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      flash(`已导出 ${filename}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    } finally { setExportBusy(false); }
  }

  /**
   * T03211（PM-105）：批量操作回执——成功 n / 失败 m + 逐条失败原因。
   * 与撤销条同级常驻（不挂在批量条上）：批量完成会清空/缩减选中，回执仍要可回看。
   */
  function renderBatchReceipt() {
    if (!batchReceipt) return null;
    const { label, okCount, failed } = batchReceipt;
    // T03214（UX-02 ④）：跳过列（导入预览的问题行等）与失败列分列，各自带原因
    const skipped = batchReceipt.skipped ?? [];
    return (
      <div role="status" aria-label="批量操作回执"
        style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 12px', margin: '8px 0', borderRadius: 8, background: 'var(--card-bg)', border: `1px solid ${failed.length > 0 || skipped.length > 0 ? 'var(--warn)' : 'var(--border-strong)'}`, fontSize: 'var(--fs-s)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--text)' }}>{label}回执：成功 {okCount} 条</strong>
          <span data-t03214="receipt-skipped" style={{ color: skipped.length > 0 ? 'var(--text-secondary)' : 'var(--text-muted)' }}>跳过 {skipped.length} 条</span>
          <span style={{ color: failed.length > 0 ? 'var(--warn)' : 'var(--text-muted)' }}>失败 {failed.length} 条</span>
          <button onClick={() => setBatchReceipt(null)} aria-label="关闭批量操作回执" title="关闭回执"
            style={{ marginLeft: 'auto', cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>
            <X size={13} />
          </button>
        </div>
        {skipped.length > 0 && (
          <ul aria-label="操作跳过明细" data-t03214="skipped-list" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {skipped.map((s, i) => (
              <li key={`${s.ref}|${s.reason}|${i}`} style={{ wordBreak: 'break-all' }}>
                <span style={{ color: 'var(--text)' }}>{s.ref}</span> — {s.reason}
              </li>
            ))}
          </ul>
        )}
        {failed.length > 0 && (
          <ul aria-label="批量操作失败明细" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {failed.map((f) => (
              <li key={f.id} style={{ wordBreak: 'break-all' }}>
                <span style={{ color: 'var(--text)' }}>{f.title || f.id}</span> — {f.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  /**
   * T01065 后续：多级撤销条（快照栈非空时常驻，与选中态无关）。
   *
   * 必须独立于批量条：批量操作完成即清空选中 → 批量条收起，若撤销挂在其中，
   * 用户刚做完操作就找不到撤销入口（等于多级撤销白做）。
   */
  function renderUndoBar() {
    const undoTop: BatchSnapshot | undefined = batchStack[batchStack.length - 1];
    if (!undoTop) return null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 12px', margin: '8px 0', borderRadius: 8, background: 'var(--accent-soft)', border: '1px solid var(--accent)', fontSize: 'var(--fs-s)' }}>
        <button onClick={() => void undoLastBatch(1)} disabled={batchOpBusy} className="tbtn-anim"
          title={`撤销最近一次批量操作 — ${undoTop.label}，${undoTop.entries.length} 条将还原为操作前的状态${batchStack.length > 1 ? `（共 ${batchStack.length} 步可逐级回退）` : ''}`}
          aria-label={`撤销最近一次批量操作（${undoTop.entries.length} 条）`}
          style={{ cursor: 'pointer', padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--accent)' }}>
          <RotateCcw size={13} /> 撤销批量（{undoTop.entries.length}）{batchStack.length > 1 ? ` · 共 ${batchStack.length} 步` : ''}
        </button>
        {batchStack.length > 1 && (
          <select value="" disabled={batchOpBusy} aria-label="撤销多步批量操作"
            title="撤销多步 — 选择要回退到的那一步，该步及其之后的全部批量操作都会被撤销"
            onChange={(e) => { const n = Number(e.target.value); if (n > 0) void undoLastBatch(n); }}
            style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
            <option value="">撤销多步…</option>
            {batchStack.map((s, i) => {
              const steps = batchStack.length - i; // 撤销第 i 步及其之后 → 共 steps 步
              return <option key={`${s.at}-${i}`} value={steps}>撤销 {steps} 步：{s.label}（{s.entries.length} 条 · {s.at.slice(11, 16)}）</option>;
            })}
          </select>
        )}
        <button onClick={() => setBatchStack([])} disabled={batchOpBusy} title="清空撤销历史 — 丢弃全部快照（已发生的批量操作不会被撤销）" aria-label="清空撤销历史"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>
          <X size={13} />
        </button>
      </div>
    );
  }

  /** 批量操作条：multiSelect 且有选中时浮出（样式与任务行一致） */
  function renderBatchBar() {
    if (!multiSelect || selectedIds.size === 0) return null;
    return (
      <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', margin: '8px 0', borderRadius: 8, background: 'var(--card-bg)', border: '1px solid var(--accent)', boxShadow: '0 4px 12px rgba(0,0,0,.12)', fontSize: 'var(--fs-s)' }}>
        <strong style={{ color: 'var(--accent)' }}>已选 {selectedIds.size} 条</strong>
        {/* T02213：选中项有效性校验取数失败时如实提示——此刻选中集里可能留着已删除/归档的任务 */}
        {pruneError && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <ResourceHint view={{ phase: 'error', error: pruneError, stale: false, reload: validateSelected }} label="选中项有效性" />
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>选中列表可能含已删除/归档的任务，执行批量操作前请先重试</span>
          </span>
        )}
        {/* T00588：批量操作对齐计划页风格——纯图标 + 下拉相邻 + 悬浮提示。
            T00704：批量条按钮**移除 task-op**（悬浮显隐依赖任务行 hover，批量条浮于列表上方无 hover 触发，
            导致归档等按钮不可见、被误判「缺少」）——批量条出现即全部常显。 */}
        <button onClick={() => void batchApply('status', 'done')} disabled={batchOpBusy} className="tbtn-anim"
          title="批量完成 — 选中任务标记为已完成" aria-label="批量完成"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', color: 'var(--success, var(--text))' }}>
          <Check size={14} />
        </button>
        <button onClick={() => void batchApply('status', 'todo')} disabled={batchOpBusy} className="tbtn-anim"
          title="批量重开 — 选中任务退回待办" aria-label="批量重开"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center' }}>
          <RotateCcw size={14} />
        </button>
        {/* T02980：批量验收结果——只作用于已完成任务（待办自动跳过并提示）；
            「验证失败」需逐条录入反馈，仍走单条验证面板，不做批量。 */}
        <button onClick={() => void batchApply('verified', 'true')} disabled={batchOpBusy} className="tbtn-anim"
          title="批量验证通过 — 选中任务中已完成的标记为已验证（未完成任务自动跳过）" aria-label="批量验证通过"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', color: 'var(--success, var(--text))' }}>
          <CheckCheck size={14} />
        </button>
        <button onClick={() => void batchApply('verified', 'false')} disabled={batchOpBusy} className="tbtn-anim"
          title="批量置为未验证 — 选中任务中已完成的退回未验证（未完成任务自动跳过）" aria-label="批量置为未验证"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', color: 'var(--text-muted)' }}>
          <Circle size={14} />
        </button>
        <select value="" disabled={batchOpBusy} aria-label="批量设置优先级" title="批量设置优先级"
          onChange={(e) => { const v = e.target.value; if (v) void batchApply('priority', v); }}
          style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">批量优先级…</option>
          <option value="urgent">紧急</option>
          <option value="high">高</option>
          <option value="normal">普通</option>
          <option value="low">低</option>
        </select>
        <select value="" disabled={batchOpBusy} aria-label="批量设置分类" title="批量设置分类"
          onChange={(e) => { const v = e.target.value; if (v !== '') void batchApply('category', v === '__none__' ? '' : v); }}
          style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">批量分类…</option>
          {taskCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="__none__">（清除分类）</option>
        </select>
        <span style={{ display: 'inline-flex', alignItems: 'center' }} title="批量字体颜色 — 选色后应用到全部选中任务">
          <FontColorButton current="" onApply={(col) => { void batchApply('color', col); }} label="批量字体颜色" />
        </span>
        {/* T01480：批量导出——md/xlsx/docx 三格式 */}
        <select value="" disabled={exportBusy} aria-label="批量导出任务" title="批量导出 — 选中任务导出为 Word / Markdown / Excel"
          onChange={(e) => { const v = e.target.value as 'md' | 'xlsx' | 'docx' | ''; if (v) void exportTasks([...selectedIds], v); }}
          style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">批量导出…</option>
          {EXPORT_ITEMS.map((it) => <option key={it.fmt} value={it.fmt}>{it.label}</option>)}
        </select>
        {/* T00704：批量归档——位于批量字体颜色之后（功能已存在，本次修复其可见性） */}
        <button onClick={() => void batchApply('archive')} disabled={batchOpBusy} className="tbtn-anim"
          title="批量归档 — 选中任务移入归档（可恢复）" aria-label="批量归档"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', color: 'var(--danger)' }}>
          <Archive size={14} />
        </button>
        {/* T01065-FR1.6：批量移动到项目（moveProject 批量入口） */}
        <select value="" disabled={batchOpBusy || projects.length === 0} aria-label="批量移动到项目" title="批量移动到项目 — 选中任务整体迁移到目标项目"
          onChange={(e) => { const v = e.target.value; if (v) void batchMoveTo(v); }}
          style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">移动到项目…</option>
          {projects.filter((p) => p.id !== 'sys-inbox' && p.id !== activeProject).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {/* T01065 后续：撤销入口已移出批量条——见 renderUndoBar。
            原因：批量操作完成后会清空选中（selectedIds → 空），批量条随之收起，
            挂在批量条里的撤销按钮也就一并消失，等于「刚做完就撤不了」。 */}
        <button onClick={() => setSelectedIds(new Set())} disabled={batchOpBusy} className="tbtn-anim"
          title="取消选择" aria-label="取消选择"
          style={{ cursor: 'pointer', padding: '2px 4px', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  /** 批量智能分类：一键对当前项目全部未分类任务（待办 + 已完成，T00432）做 AI 语义识别自动分到已有分类。
   *  逐个复用 matchCategory 得到最贴切分类，命中即写回 category_id；无工具/无未分类任务/全失败都给明确反馈。 */
  async function batchClassify() {
    if (classifyBusy) return flash('正在批量分类中，请稍候');
    if (!organizeToolId) return flash(aiBlockedFlash('请先在「模型管理」页添加并选择整理工具'));
    // T02365：无候选分类时逐条请求会全部回 categoryId=null，最终被笼统说成「未能匹配」——
    // 这里直接点名是分类没建/分类列表没加载成功，并顺手重拉一次
    if (taskCats.length === 0) {
      void loadCategories();
      return flash('当前没有可用任务分类——请先在任务分类中新建分类，再执行批量分类');
    }
    // T00432：分类范围包含已完成任务——未分类的待办与已完成一并纳入
    const target = [...todo, ...done].filter((t) => !t.category_id && t.title.trim());
    if (target.length === 0) return flash('当前项目没有未分类的任务');
    if (!(await askConfirm(`将对 ${target.length} 个未分类任务（含已完成）执行批量智能分类，确认？`))) return;
    // T00552：循环移入模块级 runner——切页后继续执行，返回时自动同步状态（不再卡在运行中动画）
    setClassifyBusy(true);
    void runBatchClassifyModule(target.map((t) => ({ id: t.id, title: t.title, priority: t.priority })), organizeToolId, taskCats.map((c) => ({ id: c.id, name: c.name })));
  }

  /** 提示词优化：调 AI 把当前描述草稿改写为结构化提示词，结果写回草稿供确认后保存。
   *  输入源判定：描述输入框为空时回退取用标题作为输入，并在反馈中标注本次来源。
   *  按任务隔离并支持并行；同一任务再次点击视为「取消」。 */
  async function optimizeDesc(task: Task) {
    if (optimizingMap[task.id]) return cancelOptimize(task.id);
    if (!organizeToolId) return flash(aiBlockedFlash('请先在「模型管理」页添加并选择工具'));
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
      if ((e as Error).name !== 'AbortError') flash(e instanceof Error ? e.message : String(e), 'error');
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
      return flash(e instanceof Error ? e.message : String(e), 'error');
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
      flash(e instanceof Error ? e.message : String(e), 'error');
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
      return flash(e instanceof Error ? e.message : String(e), 'error');
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
      return flash(e instanceof Error ? e.message : String(e), 'error');
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

  /** 任务行标题行：置顶/编号/徽标/标题（T00547：完成状态/验证按钮移至下方元信息行左侧，不独立占行） */
  // T01057-FR1.2：失败一键重试——ai_state=failed 的任务回待办，retry_count+1，历史结果保留（handle_result 追加段）
  const [retryingNo, setRetryingNo] = useState('');
  async function handleRetryTask(taskNo: string) {
    if (retryingNo) return;
    if (!(await askConfirm(`重试任务 ${taskNo}？将回到待办并等待 AI 重新领取执行，历次处理结果保留。`))) return;
    setRetryingNo(taskNo);
    try {
      await api.post(`/tasks/by-no/${taskNo}/retry`, {});
      await loadTasks(activeProject);
    } catch (e) {
      flash(`重试失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setRetryingNo('');
    }
  }
  function renderTaskTitleRow(t: Task, titleEditing: boolean) {
    return (
      <div data-ttask-id={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {multiSelect && (
          <input type="checkbox" checked={selectedIds.has(t.id)} aria-label={`选中任务 ${t.title}`}
            onChange={(e) => setSelectedIds((prev) => { const n = new Set(prev); if (e.target.checked) { n.add(t.id); } else { n.delete(t.id); } return n; })}
            style={{ cursor: 'pointer', flexShrink: 0 }} />
        )}
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
            style={{ cursor: 'pointer', fontSize: 'var(--fs-2xl)', lineHeight: 1, border: 'none', background: 'transparent', color: 'var(--accent)' }}
          >
            <ScanSearch size={13} style={{ verticalAlign: '-2px' }} />
          </button>
        )}
        {/* 置顶/取消置顶图标：置于标题最左侧 */}
        <span className="task-op" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <PinToggle pinned={t.pinned} onToggle={() => void togglePin(t)} />
        </span>
        {/* T00566：AI 处理状态动画（编号前）——running 转圈 / failed 红色警示脉动 / unread 未读圆点呼吸 / 已读或无状态不渲染 */}
        {t.ai_state === 'running' && (
          <span title="AI 正在处理此任务" aria-label="AI 处理中" style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--accent)' }}>
            <Loader2 size={13} className="aispin" />
          </span>
        )}
        {t.ai_state === 'failed' && (
          <span className="ai-failed-pulse" title="AI 处理中断/失败 — 可重新处理或查看处理结果" aria-label="AI 处理失败" style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--danger)' }}>
            <AlertTriangle size={13} />
          </span>
        )}
        {/* T01057-FR1.2：失败一键重试——回待办等待 AI 重新领取，历次结果保留；重试过显示次数徽标 */}
        {t.ai_state === 'failed' && (
          <button
            onClick={() => t.task_no && void handleRetryTask(t.task_no)}
            disabled={retryingNo === t.task_no}
            title={retryingNo === t.task_no ? '重试中…' : '重试 — 回到待办，等待 AI 重新领取执行（历次结果保留）'}
            aria-label={`重试任务 ${t.task_no ?? ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', padding: '1px 6px', borderRadius: 5, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text-secondary)', cursor: retryingNo === t.task_no ? 'wait' : 'pointer' }}
          >
            {retryingNo === t.task_no ? <Loader2 size={11} className="aispin" /> : <RotateCcw size={11} />} 重试
          </button>
        )}
        {(t.retry_count ?? 0) > 0 && (
          <span title={`该任务已手动重试 ${t.retry_count} 次（历次结果见处理结果）`} aria-label={`已重试 ${t.retry_count} 次`} style={{ display: 'inline-flex', alignItems: 'center', fontSize: 'var(--fs-2xs)', padding: '0 5px', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
            重试×{t.retry_count}
          </span>
        )}
        {t.ai_state === 'unread' && (
          <span className="ai-unread-breathe" title="AI 处理完成 — 点击展开任务详情查看结果" aria-label="AI 处理完成未读" style={{ display: 'inline-flex', alignItems: 'center' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} />
          </span>
        )}
        {/* 任务编号徽标：全局唯一，供 AI Agent 通过 MCP 按编号定位任务（titletip 说明可复制） */}
        {t.task_no && (
          <span /* NOSONAR - 任务编号徽标「双击复制」为便捷操作，文本可选中复制，无需拉链为可聚焦交互控件 */
            title={`任务编号 ${t.task_no} — 供 MCP 按编号定位任务；双击复制`}
            aria-label={`任务编号 ${t.task_no}`}
            onDoubleClick={() => void navigator.clipboard.writeText(t.task_no!).then(() => flash(`已复制任务编号 ${t.task_no}`))}
            style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', background: 'var(--accent-soft)', padding: '0 5px', borderRadius: 4, lineHeight: '18px', whiteSpace: 'nowrap', cursor: 'default', userSelect: 'text' }}
          >
            {t.task_no}
          </span>
        )}
        {/* T00502/T00521 调整：验证失败徽标——点击展开「验证失败反馈」窗口（聚焦失败段查看/修改）
            T00623：验证通过（verified=true）后隐藏该标签——历史【验证失败】段仍在 handle_result（供追溯），但不再作为当前状态提示 */}
        {t.handle_result?.includes('【验证失败') && !t.verified && (
          <button type="button" title="验证失败 — 点击查看/修改失败反馈" aria-label="验证失败"
            onClick={() => setFailbackOpen((p) => ({ ...p, [t.id]: true }))}
            style={{ fontSize: 'var(--fs-2xs)', color: 'var(--danger)', border: '1px solid var(--danger)', padding: '0 4px', borderRadius: 4, lineHeight: '16px', whiteSpace: 'nowrap', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit' }}>
            验证失败
          </button>
        )}
        {/* T03229（PM-202②）：阻塞徽标——在途阻塞数与阻塞方点名见 blockBadgeNode */}
        {blockBadgeNode(t)}
        {/* T03231（PM-203②）：自定义字段值——前 3 个上徽标，完整清单在 aria-label/title */}
        {fieldBadgesNode(t)}
        {/* T00462/T00451：计划联动任务区分徽标——悬浮显示来源计划标题（反向引用）
            T01037：来源计划是里程碑时徽标显示「里程碑」，不再一律显示「计划」（里程碑≠普通计划条目）
            T02196：徽标改为可点击——跳「项目管理」并在计划 WBS 视图中定位/高亮来源节点（滚动到位由计划页完成） */}
        {t.fromPlanTitle && (() => {
          const isMs = t.fromPlanKind === 'milestone';
          const noun = isMs ? '里程碑' : '计划';
          return (
            <button type="button" title={isMs
              ? `里程碑联动任务 — 来源里程碑：${t.fromPlanTitle}；请先处理其下子任务，全部完成后由里程碑汇总状态。点击定位到该里程碑节点`
              : `计划联动任务 — 来源计划：${t.fromPlanTitle}；完成状态与项目计划双向同步。点击定位到该计划节点`}
              aria-label={isMs ? '里程碑联动任务：点击定位来源里程碑节点' : '计划联动任务：点击定位来源计划节点'}
              onClick={() => {
                if (!focusPlanNode(t.fromPlanId, t.project_id ?? '')) flash(`未取到${noun}节点标识，无法定位（来源${noun}：${t.fromPlanTitle}）`);
              }}
              style={{ fontSize: 'var(--fs-2xs)', color: isMs ? 'var(--accent)' : 'var(--text-muted)', border: `1px solid ${isMs ? 'var(--accent)' : 'var(--border-strong)'}`, padding: '0 4px', borderRadius: 4, lineHeight: '16px', whiteSpace: 'nowrap', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', fontWeight: isMs ? 600 : undefined }}>
              {noun}
            </button>
          );
        })()}
        {/* T00577：派生单溯源徽标——AI 处理完成后结论自动整合回原任务
            T02196：点击定位并高亮原任务（当前列表内命中则零视图变更，否则退回编号检索定位） */}
        {t.derived_from && (
          <button type="button" title={`派生自原任务 ${t.derived_from} — 处理完成后结论自动整合回原任务；点击定位并高亮该原任务`}
            aria-label={`派生自 ${t.derived_from}：点击定位原任务`}
            onClick={() => locateDerivedTask(t.derived_from)}
            style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', lineHeight: '16px', flexShrink: 0, cursor: 'pointer', background: 'transparent', fontFamily: 'inherit' }}>
            派生自 {t.derived_from}
          </button>
        )}
        {/* T02949：派生单裁决徽标——待裁决（ accent 实底，点击弹裁决面板）/ 已裁决（灰底点名结果） */}
        {t.derived_from && t.ruling_state === '待裁决' && (
          <button type="button" className="tbtn-anim" onClick={() => void openRulingPanel(t)}
            title="待裁决 — 点击打开裁决面板（预设选项或自定义结果）"
            aria-label="待裁决：点击打开裁决面板"
            style={{ fontSize: 'var(--fs-2xs)', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 4, padding: '0 4px', lineHeight: '16px', flexShrink: 0, cursor: 'pointer', background: 'var(--accent-soft)', fontFamily: 'inherit' }}>
            待裁决
          </button>
        )}
        {t.derived_from && t.ruling_state === '已裁决' && (
          <span title={`已裁决：${t.ruling_result ?? ''}${t.ruling_at ? `（${t.ruling_at.slice(0, 10)}）` : ''}`}
            style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', lineHeight: '16px', flexShrink: 0 }}>
            已裁决
          </span>
        )}
        {/* T02949 方案 A：不再给所有派生单挂手动挂牌入口——
            是否待裁决由服务端按结论自动识别（TaskService.autoRuling），前端只负责展示与交互 */}
        {/* T03211（PM-105）：全部项目视图下标注任务所属项目——跨项目多选时能辨认每条任务归属 */}
        {activeProject === ALL_PROJECTS && (() => {
          const pname = projects.find((p) => p.id === t.project_id)?.name;
          return pname ? (
            <span title={`所属项目：${pname}`} aria-label={`所属项目 ${pname}`}
              style={{ flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 5px', lineHeight: '16px' }}>
              {pname}
            </span>
          ) : null;
        })()}
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
      <div className="task-op task-toolbar" style={{ marginLeft: 32, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {/* T00547：完成状态/验证结果控件——与工具栏同行、靠左显示（marginRight auto 分隔左右两组） */}
        <span style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <button className="title-op" title="切换任务完成状态" aria-label="切换任务完成状态" onClick={() => void setStatus(t, t.status === 'todo' ? 'done' : 'todo')} style={{ cursor: 'pointer', fontSize: 'var(--fs-l)', lineHeight: 1 }}>
            {t.status === 'todo' ? '☐' : '☑'}
          </button>
          {t.status === 'done' && renderVerifyButton(t)}
        </span>
        {/* 优先级四级（T00495：与筛选/录入对齐）：置于 AI 梳理按钮之前，便于优先调整重要度 */}
        <select
          value={t.priority}
          onChange={(e) => void setPriority(t, e.target.value)}
          className="task-op"
          aria-label="切换任务优先级"
          style={{ fontSize: 'var(--fs-s)', padding: 2, border: '1px solid var(--border-strong)', borderRadius: 4, color: priorityColor(t.priority) }}
        >
          <option value="low">低</option>
          <option value="normal">中</option>
          <option value="high">高</option>
          <option value="urgent">极高</option>
        </select>
        {/* 行内切换任务分类：'none' 仅作展示用不可选；空串回到未分类 */}
        <select
          value={t.category_id ?? ''}
          onChange={(e) => void setTaskCategory(t, e.target.value)}
          title="分类 — 切换该任务所属分类"
          aria-label="切换任务分类"
          className="task-op"
          style={{ fontSize: 'var(--fs-s)', padding: 2, border: '1px solid var(--border-strong)', borderRadius: 4 }}
        >
          <option value="">未分类</option>
          {taskCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {/* T00450/T00512：创建子任务——移到分类下拉条之后 */}
        <button onClick={() => void createSubTask(t)} title="创建子任务 — 在该任务下创建子任务（层级展示）" aria-label="创建子任务"
          className="task-op" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', color: 'var(--text-muted)' }}>
          <ListTodo size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
        </button>
        {/* 待办/已完成任务：AI 美化 + 重命名（编辑中保留保存/取消收尾） */}
        {renderTitleActions(t, titleEditing, true)}
        <button
          onClick={() => void copyTaskContent(t)}
          title="复制 — 复制该任务标题、描述与 AI 摘要到剪贴板"
          aria-label="复制：复制该任务内容到剪贴板"
          className="task-op"
          style={{ fontSize: 'var(--fs-s)', color: copiedId === t.id ? 'var(--success)' : undefined, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          {copiedId === t.id ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button onClick={() => toggleDescEdit(t)} title={descEditing ? '收起描述 — 收起描述编辑区' : '描述 — 编辑该任务描述'} aria-label={descEditing ? '收起描述' : '编辑该任务描述'} className="task-op" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>{descEditing ? <ChevronUp size={13} /> : <AlignLeft size={13} />}</button>
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
          style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          {t.handle_result ? <ClipboardEdit size={13} /> : <ClipboardList size={13} />}
        </button>
        {/* T01480：单条导出——点击弹出三格式菜单（Word/Markdown/Excel），动效与 Tooltip 内建 */}
        <button
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setExportMenu({ taskId: t.id, x: r.left, y: r.bottom + 4 }); }}
          disabled={exportBusy}
          title="文件导出 — 将该任务导出为 Word / Markdown / Excel"
          aria-label={`文件导出：${t.title}`}
          className="task-op export-anim"
          style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          <Download size={13} />
        </button>
        <button
          onClick={() => { setReuseOpen(t.id); setReuseProjectId(''); setReuseSearch(''); setReuseCategoryId(''); void loadPromptCats(); void loadReqCats(); }}
          title="复用此任务 — 将该任务复制到其他项目，或打包为资产复制到提示词/通用需求页"
          aria-label="复用此任务：将该任务复制到其他项目或资产页"
          className="task-op"
          style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          <CopyPlus size={13} />
        </button>
        {/* T00531 布局调整：验证失败反馈按钮已移至标题行「展开处理结果」图标后方 */}
        {/* T00501：字体颜色按钮置于按钮栏最前 */}
        <span className="task-op" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <FontColorButton current={t.color ?? ''} onApply={(c) => { void api.patch(`/tasks/${t.id}`, { color: c }).then(() => { flash(c ? '字体颜色已应用' : '已恢复默认颜色'); void loadTasks(activeProject); }); }} />
        </span>
        {/* T00719：搁置/恢复按钮——位于归档按钮之前；搁置后任务进搁置列表（MCP 处理待办自动忽略） */}
        <button onClick={() => void toggleShelve(t)}
          title={t.shelved ? '恢复 — 将该任务恢复到待办/已完成列表' : '搁置 — 将该任务移入搁置列表（AI 处理待办时自动忽略）'}
          aria-label={t.shelved ? '恢复任务' : '搁置任务'}
          className="task-op" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
          {t.shelved ? <RotateCcw size={13} /> : <CirclePause size={13} />}
        </button>
        <button onClick={() => void archive(t)} title="归档 — 将该任务移入归档" aria-label="归档：将该任务移入归档" className="task-op" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Archive size={13} /></button>
        {/* 记录时间：与操作按钮同行的最右侧，紧凑格式，创建/编辑并排 */}
        <span style={{ display: 'inline-flex', gap: 10 }}>
          <span>{fmtShort(t.created_at)} 创建</span>
          <span>{fmtShort(t.updated_at)} 编辑</span>
        </span>
      </div>
    );
  }

  /** 已完成任务验证入口（合一）：单按钮展开动画选择面板——✓ 验证通过 / ✗ 验证失败（T00521 调整，用户 19:33 反馈）。
   *  面板 fixed 定位 + 弹出动画；外点收起。
   *  T01299：面板改经 Portal 挂 body——任务行 .cv-auto（content-visibility:auto，T01067）会使其成为
   *  fixed 后代的包含块并按行裁剪（等价 contain:paint），fixed 视口坐标被错按行内坐标解析，
   *  收起行（≈64px）时面板整体被裁掉不可见，展开详情后才「露出」，表现为严重错位。 */
  function renderVerifyButton(t: Task) {
    const open = verifyMenuId === t.id;
    return (
      <span ref={open ? verifyMenuRef : undefined} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <button
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            // T00565：接近视口底部时向上弹出，避免最后一个任务处截断（面板约 110px 高）
            const up = r.bottom + 130 > window.innerHeight;
            setVerifyMenuPos({ top: up ? Math.max(8, r.top - 114) : r.bottom + 4, left: r.left });
            setVerifyMenuId(open ? '' : t.id);
          }}
          title="验证结果 — 选择验证通过或标记验证失败"
          aria-label="验证结果" aria-haspopup="menu" aria-expanded={open}
          key={t.verified ? 'v-ok' : 'v-no'}
          className="verify-icon title-op" /* T00487：悬浮显示替代常显 */

          style={{ cursor: 'pointer', fontSize: 'var(--fs-l)', lineHeight: 1, border: 'none', background: 'transparent', color: t.verified ? 'var(--success)' : 'var(--border-strong)', display: 'inline-flex', alignItems: 'center', gap: 2 }}
        >
          {t.verified ? '✓' : '○'}<ChevronDown size={10} />
        </button>
        {open && verifyMenuPos && createPortal(
          <div ref={verifyMenuPanelRef} role="menu" aria-label="验证结果选择"
            style={{ position: 'fixed', top: verifyMenuPos.top, left: verifyMenuPos.left, zIndex: 70, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 6px 16px rgba(0,0,0,.16)', padding: 4, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 128, animation: 'verify-pop .18s ease' }}>
            <button role="menuitem"
              onClick={() => { setVerifyMenuId(''); void toggleVerified(t); }}
              title="标记验证通过"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 'var(--fs-s)', border: 'none', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--success)' }}>
              <Check size={14} /> 验证通过
            </button>
            <button role="menuitem"
              onClick={() => { setVerifyMenuId(''); void api.patch(`/tasks/${t.id}`, { verified: false }).then(() => { flash('已置为未验证'); void loadTasks(activeProject); }); }}
              title="置为未验证 — 保持在已完成列表，等待再次核对"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 'var(--fs-s)', border: 'none', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)' }}>
              ○ 未验证
            </button>
            <button role="menuitem"
              onClick={() => { setVerifyMenuId(''); markVerifyFailed(t); }}
              title="标记验证失败 — 录入失败反馈，任务将回退到待办列表"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 'var(--fs-s)', border: 'none', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--danger)' }}>
              <X size={14} /> 验证失败
            </button>
          </div>,
          document.body,
        )}
      </span>
    );
  }

  /** M6-6.1：描述展开/收起图标（自 renderTaskTitle 提取） */
  function renderDescToggleButton(t: Task, toggleDesc: () => void) {
    return (
      <button
        onClick={toggleDesc}
        title={descExpanded[t.id] ? '收起 — 收起任务描述' : '展开 — 展开查看完整任务描述'}
        aria-label={descExpanded[t.id] ? '收起：收起任务描述' : '展开：展开查看完整任务描述'}
        className="task-op"
        style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
      >
        {descExpanded[t.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
    );
  }

  /** M6-6.1：处理结果展开图标（自 renderTaskTitle 提取；unread 时顺路消除未读） */
  function renderResultToggleButton(t: Task) {
    return (
      <button
        onClick={() => { setResultOpen((p) => ({ ...p, [t.id]: !p[t.id] })); if (t.ai_state === 'unread') { void api.patch(`/tasks/${t.id}`, { aiState: '' }).then(() => setTasksStateRead(t.id)); } }}
        title={resultOpen[t.id] ? '收起处理结果 — 收起该任务的处理结果' : '展开处理结果 — 展开查看该任务的处理结果'}
        aria-label={resultOpen[t.id] ? '收起处理结果：收起该任务的处理结果' : '展开处理结果：展开查看该任务的处理结果'}
        className="task-op"
        style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
      >
        {resultOpen[t.id] ? <ChevronUp size={13} /> : <ClipboardList size={13} />}
      </button>
    );
  }

  /** M6-6.1：验证失败反馈图标（自 renderTaskTitle 提取；verified=true 后隐藏） */
  function renderFailbackToggleButton(t: Task) {
    return (
      <button
        onClick={() => setFailbackOpen((p) => ({ ...p, [t.id]: !p[t.id] }))}
        title="验证失败反馈 — 展开查看/修改该任务的验证失败反馈"
        aria-label="验证失败反馈：展开查看或修改"
        className="task-op"
        style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', color: 'var(--danger)' }}
      >
        {failbackOpen[t.id] ? <ChevronUp size={13} /> : <AlertTriangle size={13} />}
      </button>
    );
  }

  /** M6-6.1：展示态标题按钮（自 renderTaskTitle 提取——三重三元与 cursor 判定是复杂度大头） */
  function renderTitleDisplayButton(t: Task, descToggleable: boolean, toggleDesc: () => void, markTitleRead: () => void) {
    const unreadDone = t.status === 'done' && !t.handle_result && t.ai_state === 'unread';
    // M6-6.4：title 提示文案判定改为平铺分支（消除嵌套三元 S3358）
    const descTitle = descExpanded[t.id] ? '收起 — 再次点击收起任务描述' : '展开 — 点击查看完整任务描述';
    let titleAttr: string | undefined;
    if (descToggleable) titleAttr = descTitle;
    else if (unreadDone) titleAttr = '点击消除未读状态';
    return (
      // T00918：已完成且无处理结果反馈的任务，其标题行常无「描述/处理结果」展开入口可点，
      // 未读红点无处置除；故点击标题本身即视为「已查看」，清除该任务未读状态（仅覆盖此场景，不影响已填反馈任务）
      // T01384：有描述时点击标题即展开/收起描述（键盘 Enter/Space 同效），aria-expanded 同步可展开状态
      // T01533：button → span[role=button]——Chromium 不允许鼠标框选 button 内文字，且全局
      //   `button:hover` 倾斜规则（App.tsx）让悬浮时文字位移、更难选中复制；改 span 后倾斜随之消失，
      //   userSelect 显式放开可正常框选；点击展开/键盘操作语义原样保留（选中文字松手不误触折叠）。
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return; // 正在框选复制，不触发折叠
          if (descToggleable) toggleDesc(); else markTitleRead();
        }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (descToggleable) toggleDesc(); else markTitleRead(); } }}
        onMouseDown={() => setTitleSelId(t.id)}
        aria-expanded={descToggleable ? descExpanded[t.id] ?? false : undefined}
        aria-controls={descToggleable ? `task-desc-${t.id}` : undefined}
        title={titleAttr}
        style={{ flex: 1, background: 'none', border: 'none', padding: 0, font: 'inherit', textAlign: 'left', textDecoration: t.status === 'done' ? 'line-through' : 'none', color: t.color || 'var(--text)', cursor: descToggleable || unreadDone ? 'pointer' : 'default', userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        {t.title}
      </span>
    );
  }

  /** 标题区：编辑态输入框 / 展示态文本 + 描述展开按钮（M6-6.1：图标组拆分至上方三个助手） */
  function renderTaskTitle(t: Task, titleEditing: boolean) {
    const markTitleRead = () => { if (t.status === 'done' && !t.handle_result && t.ai_state === 'unread') { void api.patch(`/tasks/${t.id}`, { aiState: '' }).then(() => setTasksStateRead(t.id)); } };
    // T01384：点标题切换描述展开/收起（与箭头按钮同口径）；markTitleRead 顺路执行
    const descToggleable = Boolean(t.description) && !titleEditing;
    const toggleDesc = () => {
      setDescExpanded((p) => ({ ...p, [t.id]: !p[t.id] }));
      setDescVis((p) => ({ ...p, [t.id]: true }));
      if (t.ai_state === 'unread') { void api.patch(`/tasks/${t.id}`, { aiState: '' }).then(() => setTasksStateRead(t.id)); }
      markTitleRead();
    };
    return (
      <>
        {titleEditing ? (
          <input
            value={titleDrafts[t.id]}
            onChange={(e) => beautifyStore.setDraft(t.id, e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveTitle(t)}
            placeholder="任务标题"
            autoFocus
            style={{ flex: 1, padding: '4px 6px', border: '1px solid var(--accent)', borderRadius: 4, fontSize: 'var(--fs-m)', boxSizing: 'border-box' }}
          />
        ) : (
          renderTitleDisplayButton(t, descToggleable, toggleDesc, markTitleRead)
        )}
        {/* 展开/收起按钮紧跟标题：有描述才显示，点击展开完整描述（默认收起不展示摘要，保持简洁）——T01384 与标题点击同口径 */}
        {t.description && renderDescToggleButton(t, toggleDesc)}
        {/* 处理结果展开图标：紧随任务详情（描述）展开图标之后，作为第二个交互图标。
            有已录入结果才显示；仅切换 resultOpen 的查看态（不进入编辑），与描述展开相互独立，
            两个面板可分别展开/收起，也可同时展开/收起。收起态用上箭头以区分展开态 */}
        {t.handle_result && renderResultToggleButton(t)}
        {/* T00531 布局调整：验证失败反馈按钮移至「展开处理结果」图标后方（标题行）——点击展开反馈窗口
            T00623：验证通过（verified=true）后同样隐藏该入口（与失败徽标一致，避免残留入口） */}
        {t.handle_result?.includes('【验证失败') && !t.verified && renderFailbackToggleButton(t)}
      </>
    );
  }

  /** 标题操作：保存编辑中的标题 / AI 美化 + 重命名切换。
   *  待办与已完成任务均展示重命名；编辑中保留保存/取消以收尾美化或改名结果。 */
  function renderTitleActions(t: Task, titleEditing: boolean, includeRename = true) {
    return (
      <>
        {titleEditing ? (
          <button onClick={() => void saveTitle(t)} disabled={!titleDrafts[t.id]?.trim()} title="保存 — 保存修改后的任务标题" aria-label="保存：保存修改后的任务标题" className="task-op" style={{ fontSize: 'var(--fs-s)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Save size={13} /></button>
        ) : (
          <>
            {renderBeautifyButton(t)}
            {/* T00597：AI 简化置于 AI 美化图标之后 */}
            {renderSimplifyButton(t)}
          </>
        )}
        {includeRename && <button onClick={() => toggleTitleEdit(t)} title={titleEditing ? '取消 — 取消重命名' : '改名 — 重命名该任务标题'} aria-label={titleEditing ? '取消重命名' : '重命名该任务标题'} className="task-op" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>{titleEditing ? <X size={13} /> : <SquarePen size={13} />}</button>}
        {/* T01562：真抽屉——右侧滑入完整操作台（描述/结果/摘要/时间线/关联计划），与行内展开互补 */}
        <button onClick={() => openDetailDrawer(t)} title="展开详情抽屉 — 在右侧抽屉中查看并编辑任务完整详情" aria-label="展开详情抽屉 — 在右侧抽屉中查看并编辑任务完整详情" className="task-op" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><PanelRightOpen size={13} /></button>
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
        style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', background: busy ? 'var(--accent)' : 'transparent', color: busy ? 'var(--accent-text)' : 'var(--text)', opacity: batchBusy && !busy ? 0.4 : 1 }}
      >
        <Sparkles size={13} />
      </button>
    );
  }

  /** T00597：AI 简化单条按钮——置于 AI 美化之后；图标 Minimize2（收缩）与美化的 Sparkles 区分度高。
   *  简化会压缩语义（限 40 字），必须依据任务详情内容，无详情时友好提示不触发。 */
  function renderSimplifyButton(t: Task) {
    const busy = beautifyBusy[t.id];
    const hasDesc = Boolean((t.description ?? '').trim());
    let simplifyTitle: string;
    if (busy) simplifyTitle = 'AI 处理进行中，请在工具栏点击「取消」';
    else if (hasDesc) simplifyTitle = 'AI 简化 — 依据任务详情高度总结为简洁标题（限 40 字，细节会精简）';
    else simplifyTitle = 'AI 简化不可用 — 该任务暂无详情内容，请先补充详情后再简化（避免语义丢失）';
    return (
      <button
        onClick={() => void simplify(t)}
        disabled={(batchBusy && !busy) || busy}
        title={simplifyTitle}
        aria-label={busy ? 'AI 处理进行中' : 'AI 简化：依据任务详情总结为简洁标题'}
        className={`task-op${busy ? ' task-breathe' : ''}`}
        style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', background: busy ? 'var(--accent)' : 'transparent', color: busy ? 'var(--accent-text)' : 'var(--text)', opacity: (!hasDesc || (batchBusy && !busy)) ? 0.45 : 1 }}
      >
        <Minimize2 size={13} />
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
          <MarkdownContent
            content={t.description}
            showCopy
          />
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
                  style={{ position: 'absolute', right: -6, bottom: -6, fontSize: 'var(--fs-s)', lineHeight: '16px', padding: '0 4px', display: 'inline-flex', alignItems: 'center', background: 'var(--surface-2)' }}
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
          <button onClick={() => void copyImage(t.images.find((i) => i.id === previewId)!)} title="复制图片 — 复制该截图到剪贴板" aria-label="复制图片：复制该截图到剪贴板" className="task-op" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px' }}><Copy size={13} />复制图片</button>
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
                  aria-label="删除该截图"
                  style={{ position: 'absolute', top: -6, right: -6, fontSize: 'var(--fs-2xs)', lineHeight: '16px', padding: '0 4px', cursor: 'pointer' }}
                >✕</button>
              </div>
            ))}
            {imgDraft.added.map((p) => (
              <div key={p.id} style={{ position: 'relative' }}>
                <img src={p.url} alt="待上传截图" style={{ height: 64, borderRadius: 4, border: '1px dashed var(--accent)' }} />
                <button
                  onClick={() => removeAddedImage(t.id, p.id)}
                  title="移除截图"
                  aria-label="移除该待上传截图"
                  style={{ position: 'absolute', top: -6, right: -6, fontSize: 'var(--fs-2xs)', lineHeight: '16px', padding: '0 4px', cursor: 'pointer' }}
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
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-s)', boxSizing: 'border-box' }}
        />
        <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => void saveDesc(t)} title="保存描述 — 保存修改后的任务描述" aria-label="保存描述：保存修改后的任务描述" style={{ fontSize: 'var(--fs-s)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Save size={13} /></button>
          <button onClick={() => void optimizeDesc(t)} title={optimizingMap[t.id] ? '取消 — 停止当前提示词优化' : '提示词优化 — 用选中工具把描述改写为结构化提示词'} aria-label={optimizingMap[t.id] ? '取消提示词优化' : '提示词优化：用选中工具优化描述草稿'} className={optimizingMap[t.id] ? 'task-breathe' : undefined} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', background: optimizingMap[t.id] ? 'var(--accent)' : 'transparent', color: optimizingMap[t.id] ? 'var(--accent-text)' : 'var(--text)' }}><Wand2 size={13} /></button>
          <button onClick={() => toggleDescEdit(t)} title="取消 — 收起描述编辑区，放弃未保存的修改" aria-label="取消：收起描述编辑区" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><X size={13} /></button>
          {optimizingMap[t.id] && <span className="task-breathe" style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>正在生成优化文案…</span>}
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
          style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 0', cursor: 'pointer' }}
        >
          {summaryExpanded[t.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          AI 梳理摘要
        </button>
        {summaryExpanded[t.id] && (
          <pre style={{ margin: '4px 0 0', padding: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--fs-s)', whiteSpace: 'pre-wrap' }}>
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
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>处理结果</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {!editing && (
              <button
                onClick={() => startEditResult(t)}
                title="编辑处理结果 — 修改该任务的处理结果"
                aria-label="编辑处理结果：修改该任务的处理结果"
                className="task-op"
                style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
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
              style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
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
              style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-s)', boxSizing: 'border-box' }}
            />
            <div style={{ marginTop: 4, display: 'flex', gap: 4, alignItems: 'center' }}>
              {/* T00796 二轮：处理结果正文同样接入 AI 美化（AI 回写的根因/方案常口语化），
                  结果回填草稿，仍需点保存才落库 */}
              <AiPolishButton
                value={resultDrafts[t.id] ?? ''}
                onPolished={(text) => setResultDrafts((prev) => ({ ...prev, [t.id]: text }))}
                toolId={organizeToolId}
                flash={flash}
                title="AI 美化 — 润色这份处理结果（保留根因/方案全部事实要素，仅规范表达），结果回填后请核对再保存"
              />
              <button
                onClick={() => void saveResult(t)}
                title="保存处理结果 — 保存修改后的处理结果"
                aria-label="保存处理结果：保存修改后的处理结果"
                className="task-op"
                style={{ fontSize: 'var(--fs-s)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
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
                style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        ) : (
          // 有值展示 Markdown；无值且展开（理论上按钮点击即进入编辑，此处为收起按钮单独状态兜底）
          <div style={{ padding: 6 }}>
            {t.handle_result ? (
              <MarkdownContent
                content={t.handle_result}
                showCopy
              />
            ) : (
              <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>暂无处理结果</span>
            )}
          </div>
        )}
        {/* T01072-FR1.9：结果历史 diff 与回滚（handle_result 被覆盖前留档；无历史时组件自身返回 null）。
            T01607：渲染条件不再要求「当前有正文」——回滚到空正文那一版后仍需保留再滚回来的入口。 */}
        {!editing && t.task_no && (
          <ResultDiffPanel
            taskNo={t.task_no}
            current={t.handle_result ?? ''}
            onRollback={() => { void loadTasks(activeProject); }}
          />
        )}
      </div>
    );
  }

  /** T00521 调整：从 handle_result 提取【验证失败 …】反馈段（支持多段，段止于下一个【开头行） */
  function getFailbackText(t: Task): string {
    const out: string[] = [];
    let cap = false;
    for (const ln of (t.handle_result ?? '').split('\n')) {
      if (ln.includes('【验证失败')) { cap = true; out.push(ln); continue; }
      if (cap) {
        if (ln.trim().startsWith('【')) break; // 下一段标记开始，失败反馈段结束
        out.push(ln);
      }
    }
    return out.join('\n').trim();
  }

  /** 保存验证失败反馈编辑（草稿为 handle_result 全文，写回全文——失败段与处理结果同窗维护） */
  async function saveFailback(task: Task) {
    const content = fbDrafts[task.id];
    if (content === undefined) return;
    try {
      await api.patch(`/tasks/${task.id}`, { handleResult: content });
    } catch (e) {
      return flash(e instanceof Error ? e.message : String(e), 'error');
    }
    setFbDrafts((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    void loadTasks(activeProject);
    flash('验证失败反馈已保存');
  }

  /** T00521 调整：验证失败反馈展开区——与处理结果同款交互窗口（展示态聚焦失败反馈段，编辑态全文可改写回） */
  function renderTaskFailback(t: Task) {
    if (!failbackOpen[t.id] && fbDrafts[t.id] === undefined) return null; // 收起零占位
    const editing = fbDrafts[t.id] !== undefined;
    const fbText = getFailbackText(t);
    return (
      // T01385：修「窗口边缘过窄/内容截断」——右侧留出与左缩进对称的边距、min-width:0 允许收缩、
      // 内容区 overflowX:auto + overflowWrap:anywhere，长代码块/长 URL 横向滚动而非溢出截断
      <div style={{ marginLeft: 32, marginRight: 8, marginTop: 4, border: '1px solid var(--danger)', borderRadius: 6, minWidth: 0, overflow: 'hidden', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 6px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', borderTopLeftRadius: 6, borderTopRightRadius: 6 }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>验证失败反馈</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {!editing && (
              <button
                onClick={() => setFbDrafts((prev) => ({ ...prev, [t.id]: t.handle_result ?? '' }))}
                title="编辑反馈 — 修改该任务的处理结果全文（含验证失败反馈）"
                aria-label="编辑验证失败反馈：修改处理结果全文"
                className="task-op"
                style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              >
                <ClipboardEdit size={12} />
              </button>
            )}
            <button
              onClick={() => {
                setFailbackOpen((p) => ({ ...p, [t.id]: false }));
                setFbDrafts((prev) => {
                  const next = { ...prev };
                  delete next[t.id];
                  return next;
                });
              }}
              title="收起验证失败反馈 — 未保存修改将丢弃"
              aria-label="收起验证失败反馈"
              className="task-op"
              style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
            >
              <ChevronUp size={12} />
            </button>
          </span>
        </div>
        {editing ? (
          <div style={{ padding: 6, overflowX: 'auto' }}>
            <textarea
              value={fbDrafts[t.id]}
              onChange={(e) => setFbDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
              rows={6}
              placeholder="处理结果全文（含【验证失败】反馈段，支持 Markdown）"
              style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-s)', boxSizing: 'border-box' }}
            />
            <div style={{ marginTop: 4, display: 'flex', gap: 4, alignItems: 'center' }}>
              {/* T00796 二轮补：反馈「修改」入口同样要有 AI 美化（与录入弹窗/处理结果/通用需求同一组件），
                  结果只回填草稿，仍需点保存落库 */}
              <AiPolishButton
                value={fbDrafts[t.id] ?? ''}
                onPolished={(text) => setFbDrafts((prev) => ({ ...prev, [t.id]: text }))}
                toolId={organizeToolId}
                flash={flash}
                title="AI 美化 — 润色这份验证失败反馈（保留现象/环境/期望等全部事实要素，仅规范表达），结果回填后请核对再保存"
              />
              <button
                onClick={() => void saveFailback(t)}
                title="保存 — 保存修改后的处理结果（含验证失败反馈）"
                aria-label="保存验证失败反馈"
                className="task-op"
                style={{ fontSize: 'var(--fs-s)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              >
                <Save size={13} />
              </button>
              <button
                onClick={() => setFbDrafts((prev) => {
                  const next = { ...prev };
                  delete next[t.id];
                  return next;
                })}
                title="放弃修改 — 恢复已保存内容"
                aria-label="放弃修改：恢复已保存内容"
                className="task-op"
                style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        ) : (
          <div style={{ padding: 6, overflowX: 'auto', overflowWrap: 'anywhere' }}>
            {fbText ? (
              <MarkdownContent content={fbText} showCopy />
            ) : (
              <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>未找到验证失败反馈段</span>
            )}
            {/* T00610：反馈窗口内直接查看随反馈提交的截图（点击放大） */}
            {t.images.length > 0 && (
              <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>反馈截图（{t.images.length}）— 点击放大；AI 可经 MCP 读取识别</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {t.images.map((img) => (
                    <button key={img.id} type="button" onClick={() => setPreviewId(img.id)}
                      title="放大预览该反馈截图" aria-label="放大预览反馈截图"
                      style={{ padding: 0, background: 'none', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', lineHeight: 0 }}>
                      <img src={imageUrl(img.id)} alt="反馈截图" style={{ height: 64, borderRadius: 3, display: 'block' }} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
  function renderTaskDraft(t: Task, draft: string) {
    return (
      <div style={{ marginLeft: 32, marginTop: 6 }}>
        <textarea
          value={draft}
          onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
          rows={8}
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-s)', fontFamily: 'monospace', boxSizing: 'border-box' }}
        />
        <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
          <button onClick={() => void saveDraft(t)} title="保存到任务 — 将梳理结果回填为任务摘要" aria-label="保存到任务" style={{ fontSize: 'var(--fs-s)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', gap: 4 }}><Check size={13} />保存到任务</button>
          <button onClick={() => setDrafts((prev) => {
            const next = { ...prev };
            delete next[t.id];
            return next;
          })} title="放弃 — 丢弃本次梳理草稿" aria-label="放弃梳理草稿" style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><X size={13} /></button>
        </div>
      </div>
    );
  }

  /** 渲染单个任务行。
   *  注意：必须用普通函数调用（renderTaskItem(t)）而非组件，否则定义在渲染函数内会每次重渲染都生成新组件类型，
   *  导致整个任务项（含描述/梳理 textarea）反复卸载重建、光标焦点丢失。普通函数把 JSX 内联进父组件树，按位置复用 DOM，焦点稳定。
   *  同理，行内各区块也拆为普通渲染函数调用，保持单函数复杂度可控。 */

  /** M6-6.1：任务行 className 预计算（避免 JSX 内联嵌套三元） */
  function buildTaskItemClass(t: Task, titleEditing: boolean, descEditing: boolean, dragCls: string): string {
    const editing = titleEditing || descEditing ? ' task-editing' : '';
    const flush = refreshFlash && t.updated_at && Date.parse(t.updated_at) >= refreshFlash ? ' flush' : '';
    const press = pressId === t.id ? ' item-pressing' : '';
    // T02196：徽标定位成功反馈——目标行短暂高亮（动画定义在全局样式 .locate-flash）
    const locate = locateFlashId === t.id ? ' locate-flash' : '';
    return `task-item cv-auto${editing}${dragCls}${flush}${press}${locate}${drawerTask?.id === t.id ? ' task-drawer-open' : ''}`;
  }

  /** M6-6.1：任务行 style 预计算（避免 JSX 内联三元） */
  function buildTaskItemStyle(t: Task, sortMode: SortKey): React.CSSProperties {
    return {
      borderBottom: '1px solid var(--surface-2)', padding: '6px 0', marginLeft: t.parent_id ? 28 : 0,
      borderLeft: t.parent_id ? '2px solid var(--border-strong)' : undefined,
      paddingLeft: t.parent_id ? 10 : undefined,
      cursor: sortMode === 'manual' ? 'grab' : undefined,
    };
  }

  /** M6-6.1：描述板块（grid 展开动画 + 时间线/预览，仅展开态渲染重内容） */
  function renderDescSection(t: Task): React.ReactNode {
    // M6-6.4：aria-label 拼接提取为独立变量（消除嵌套模板字符串 S4624）
    const descAriaLabel = t.task_no ? `任务描述（${t.task_no}）` : '任务描述';
    return (
      <section
        id={`task-desc-${t.id}`}
        aria-label={descAriaLabel}
        onTransitionEnd={(e) => { if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows' && !descExpanded[t.id]) setDescVis((p) => { const n = { ...p }; delete n[t.id]; return n; }); }}
        style={{ display: 'grid', gridTemplateRows: descExpanded[t.id] ? '1fr' : '0fr', opacity: descExpanded[t.id] ? 1 : 0, transition: 'grid-template-rows 240ms ease-in-out, opacity 200ms ease-in-out', overflow: 'hidden' }}
      >
        <div style={{ minHeight: 0, overflow: 'hidden' }}>
          {descExpanded[t.id] && renderTaskDescView(t)}
          {descExpanded[t.id] && <TaskEventTimeline taskId={t.id} />}
          {previewId && descExpanded[t.id] && t.images.some((i) => i.id === previewId) && renderTaskPreview(t)}
        </div>
      </section>
    );
  }

  function renderTaskItem(t: Task, kind: 'todo' | 'done' | 'shelved', listIds: string[]) {
    const draft = drafts[t.id];
    const descDraft = descDrafts[t.id];
    const descEditing = descDraft !== undefined;
    const titleEditing = titleDrafts[t.id] !== undefined;
    // T00719：shelved 列表拖拽重排沿用 manual 排序链路（dropTaskReorder 按列表 id 序写 user_sort）
    let sortMode: SortKey;
    if (kind === 'todo') sortMode = todoSort;
    else if (kind === 'shelved') sortMode = shelvedSort;
    else sortMode = doneSort;
    let dragCls = '';
    if (overTaskId === t.id) dragCls = ' plan-over';
    else if (dragTaskId === t.id) dragCls = ' plan-dragging';
    return (
      <li
        className={buildTaskItemClass(t, titleEditing, descEditing, dragCls)}
        onPointerDown={(e) => {
          // T00489：交互元素上按下不触发行缩放；非交互区按住 200ms 才缩放（快速点击不缩放）
          // T01533：标题 span[role=button] 属交互元素，纳入排除
          if ((e.target as HTMLElement).closest('button, input, select, a, textarea, label, [role="button"]')) return;
          pressTimer.current[t.id] = globalThis.setTimeout(() => setPressId(t.id), 200);
        }}
        onPointerUp={() => { clearTimeout(pressTimer.current[t.id]); if (pressId) setPressId(''); setTitleSelId(''); }}
        onPointerLeave={() => { clearTimeout(pressTimer.current[t.id]); if (pressId === t.id) setPressId(''); setTitleSelId(''); }}
        draggable={sortMode === 'manual' && titleSelId !== t.id}
        onDragStart={() => setDragTaskId(t.id)}
        onDragEnd={() => { setDragTaskId(''); setOverTaskId(''); }}
        onDragOver={(e) => { e.preventDefault(); if (t.id !== dragTaskId) setOverTaskId(t.id); }}
        onDrop={(e) => { e.preventDefault(); dropTaskReorder(kind, listIds, t.id); }}
        style={buildTaskItemStyle(t, sortMode)}
      >
        {renderTaskTitleRow(t, titleEditing)}
        {/* 元信息/操作行：优先级/分类/功能按钮 + 记录时间，全部靠右同行 */}
        {renderTaskMetaRow(t, titleEditing, descEditing)}
        {/* 描述板块：T01384 grid-rows 0fr→1fr 过渡；重内容仅展开态渲染 */}
        {!descEditing && (t.description || t.images.length > 0) && (descExpanded[t.id] || descVis[t.id]) && renderDescSection(t)}
        {descEditing && renderTaskDescEditor(t, descDraft)}
        {t.ai_summary && !draft && renderTaskSummary(t)}
        {draft && renderTaskDraft(t, draft)}
        {renderTaskResult(t)}
        {renderTaskFailback(t)}
      </li>
    );
  }

  /** 工具条 AI 美化按钮：进行中变为「取消」，否则批量美化全部待办 */
  function renderBeautifyToolbarButton() {
    return (
      <>
        <button
          onClick={handleBeautifyToggle}
          disabled={!anyBeautify && (todo.length === 0 || aiDown)}
          title={aiDown && !anyBeautify ? aiBlockedTitle(readiness, 'AI 美化全部待办 — 批量润色所有待办任务标题') : (anyBeautify ? '取消 — 停止当前批量美化' : 'AI 美化全部待办 — 批量润色所有待办任务标题')}
          aria-label={anyBeautify ? '取消批量美化' : 'AI 美化全部待办'}
          className={anyBeautify ? 'task-breathe' : 'op-hidden'} // T00759：默认隐藏悬浮显示；批量进行中保持可见
          style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderRadius: 6, background: anyBeautify ? 'var(--accent)' : 'transparent', color: anyBeautify ? 'var(--accent-text)' : 'var(--text)' }}
        >
          <Wand2 size={13} />
          {anyBeautify ? '取消' : todo.length}
        </button>
        {/* 工具条整体连贯进度提示：单条/批量美化进行中展示（优化进行中文案在各任务描述区展示），完成/取消后清空 */}
        {anyBeautify && <output className="flash-toast" style={{ top: 48 }}><span className="task-breathe" style={{ color: 'var(--accent)' }}>{batchBusy ? '正在批量美化标题…' : '正在美化标题…'}</span></output>}
      </>
    );
  }

  /** 项目操作按钮组：新建/改名/删除当前项目（提取以降低工具条函数复杂度，渲染不变） */
  function renderProjectActionButtons() {
    return (
      <>
        <button
          onClick={() => void createProject()}
          title="新项目 — 新建一个任务项目"
          aria-label="新项目：新建一个任务项目"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}
        >
          <FolderPlus size={13} />
        </button>
        {/* 修改当前项目名称：轻量操作，弹输入框预填当前名称；置于删除按钮前，与删除同属「当前项目」操作区 */}
        <button
          onClick={() => void renameProject()}
          disabled={!activeProject}
          title="修改项目名称 — 重命名当前选中项目"
          aria-label="修改项目名称：重命名当前选中项目"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: activeProject ? 'pointer' : 'not-allowed', opacity: activeProject ? 1 : 0.5 }}
        >
          <SquarePen size={13} />
        </button>
        {/* 删除当前项目：风险操作，点击后弹确认框，确认才执行；危险色标示 */}
        <button
          onClick={() => void deleteProject()}
          disabled={!activeProject}
          title="删除项目 — 删除当前选中项目及其全部任务（不可恢复，需二次确认）"
          aria-label="删除项目：删除当前选中项目及其全部任务"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', color: 'var(--danger)', background: 'transparent', border: '1px solid var(--danger)', borderRadius: 6, cursor: activeProject ? 'pointer' : 'not-allowed', opacity: activeProject ? 1 : 0.5 }}
        >
          <Trash2 size={13} />
        </button>
      </>
    );
  }

  /** 一键批量分类按钮（提取以降低工具条函数复杂度，渲染不变） */
  function renderClassifyButton() {
    // T01618：数量显示对齐「AI 美化全部待办」范式——本按钮作用域是未分类任务（含已完成），展示其条数
    const unclassified = [...todo, ...done].filter((t) => !t.category_id).length;
    return (
      <button
        onClick={() => void batchClassify()}
        disabled={classifyBusy || aiDown || (todo.length === 0 && done.length === 0)}
        className={`tbtn-anim op-hidden${classifyBusy ? ' task-breathe' : ''}`} // T00759：默认隐藏悬浮显示；批量进行中保持可见
        title={aiDown && !classifyBusy ? aiBlockedTitle(readiness, 'AI 批量分类 — 对未分类任务（含已完成）智能识别自动分到已有分类') : (classifyBusy ? '批量分类进行中…' : 'AI 批量分类 — 对未分类任务（含已完成）智能识别自动分到已有分类')}
        aria-label={classifyBusy ? '批量分类进行中' : 'AI 批量分类：对未分类任务（含已完成）自动分类'}
        style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderRadius: 6, background: classifyBusy ? 'var(--accent)' : 'transparent', color: classifyBusy ? 'var(--accent-text)' : 'var(--text)' }}
      >
        {classifyBusy ? <Loader2 size={13} className="aispin" /> : <Tags size={13} />}
        {!classifyBusy && unclassified > 0 ? unclassified : ''}
      </button>
    );
  }

  /** T00456 / PRD UX-1：视图切换（列表/看板）。纯布局分组，两个按钮各带无障碍名称，
   *  故不在容器上声明 role="group"（S6819），渲染不变。 */
  function renderViewToggle() {
    return (
      <span className={`op-host${viewMode === 'board' ? '' : ' op-hidden'}`} style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }}>
        <button className="tbtn-anim" onClick={() => setViewMode('list')} aria-label="列表视图" style={{ padding: '5px 9px', border: 'none', cursor: 'pointer', display: 'inline-flex', background: viewMode === 'list' ? 'var(--accent)' : 'transparent', color: viewMode === 'list' ? 'var(--accent-text)' : 'var(--text)' }} title="列表视图"><ListTodo size={13} /></button>
        <button className="tbtn-anim" onClick={() => setViewMode('board')} aria-label="看板视图" style={{ padding: '5px 9px', border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', display: 'inline-flex', background: viewMode === 'board' ? 'var(--accent)' : 'transparent', color: viewMode === 'board' ? 'var(--accent-text)' : 'var(--text)' }} title="看板视图 — 按状态分列，拖拽卡片流转状态"><LayoutGrid size={13} /></button>
      </span>
    );
  }

  /** 多选模式切换按钮（提取以降低工具条函数复杂度，渲染不变） */
  function renderMultiSelectButton() {
    return (
      <button
        onClick={() => { setMultiSelect((v) => !v); setSelectedIds(new Set()); }}
        className={`tbtn-anim${multiSelect ? '' : ' op-hidden'}`} // T00759：默认隐藏悬浮显示；多选模式下保持可见（退出入口）
        style={{ fontSize: 'var(--fs-s)', padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', border: '1px solid var(--border-strong)', background: multiSelect ? 'var(--accent)' : 'transparent', color: multiSelect ? 'var(--accent-text)' : 'var(--text)' }}
        title={multiSelect ? '退出多选模式' : '多选模式 — 勾选任务后批量改状态/分类/归档'}
        aria-label={multiSelect ? '退出多选模式' : '进入多选模式'}
      >
        {multiSelect ? <Check size={13} /> : <ListChecks size={13} />}
      </button>
    );
  }

  /**
   * T00797：一键收起/展开的作用域与判定（单一来源，避免按钮 onClick 与图标两次各算一遍而漂移）。
   * 覆盖待办 / 已完成 / 搁置三个列表 —— 三者共用同一套折叠状态；展开时只对有内容的分组展开
   * （处理结果要有 handle_result、验证失败反馈要满足与失败徽标同条件）。
   */
  function foldScope() {
    const all = [...todo, ...done, ...shelvedTasks];
    return {
      ids: all.map((t) => t.id),
      resultIds: all.filter((t) => t.handle_result).map((t) => t.id),
      failbackIds: all.filter((t) => t.handle_result?.includes('【验证失败') && !t.verified).map((t) => t.id),
    };
  }

  /** 是否存在任一展开中的任务详情分组（描述 / AI 摘要 / 处理结果 / 验证失败反馈） */
  function anyFoldOpen() {
    return foldScope().ids.some((id) => descExpanded[id] || summaryExpanded[id] || resultOpen[id] || failbackOpen[id]);
  }

  /** 顶部工具条：项目切换、工具选择、批量美化、分类筛选、搜索（T00522 修正：顶层补 op-host 宿主，筛选/搜索默认隐藏悬浮显示才生效） */
  function renderToolbar() {
    // T03211：全部项目视图的合计徽标（各项目计数之和）；具体项目视图仍用单项目计数
    const allTodo = projects.reduce((s, p) => s + (p.todo_count ?? 0), 0);
    const allUnv = projects.reduce((s, p) => s + (p.unverified_count ?? 0), 0);
    return (
      <div className="op-host" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* T02167 二轮：宿主组改可换行——窄窗（≤430px）时行内容纳不下整组（项目条+工作空间+图标钮），
            原 nowrap 会把压缩全部转嫁给 minWidth:0 的项目条（它当时是唯一可压缩项），实测 380px 宽
            按钮被压到 40px、两枚统计徽标越出按钮边框 29px。改换行后由换行让位，项目条保住 min-content。 */}
        <span className="op-host" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
        <div ref={projDropRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <button onClick={() => { setProjOpen((o) => { if (!o) { refreshProjCounts(); } return !o; }); }} aria-haspopup="listbox" aria-expanded={projOpen}
            title="切换项目 — 项目名后徽标：红=待办数、黄=未验证数（悬浮查看详情）"
            aria-label="切换项目"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)', cursor: 'pointer', maxWidth: 220 }}>
            {/* T02167：项目名改为可收缩的单行省略项（与 WorkspaceSelect 同口径）。
                原来是裸文本节点——CJK 无空格可断，min-content 只有 1 字宽，工具条变窄时按钮被压到
                比内容还小，右侧统计徽标溢出边框。徽标与箭头一律 flexShrink:0，只让名称让步。
                二轮：按钮/容器不再 minWidth:0——它会让弹性压缩把按钮压到低于「徽标+箭头」的
                min-content（约 88px），徽标照样越出边框；去掉后 min-width:auto 以 min-content 兜底。 */}
            <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeProject === ALL_PROJECTS ? '全部项目' : projects.find((p) => p.id === activeProject)?.name ?? '选择项目'}
            </span>
            {activeProject === ALL_PROJECTS ? (
              <>
                <span title={`全部项目待办合计 ${allTodo} 条`} style={{ flexShrink: 0, minWidth: 16, textAlign: 'center', fontSize: 'var(--fs-2xs)', borderRadius: 8, padding: '0 4px', background: 'var(--danger-soft, rgba(220,38,38,.12))', color: 'var(--danger)' }}>{allTodo}</span>
                <span title={`全部项目未验证合计 ${allUnv} 条`} style={{ flexShrink: 0, minWidth: 16, textAlign: 'center', fontSize: 'var(--fs-2xs)', borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{allUnv}</span>
              </>
            ) : (() => { const cur = projects.find((p) => p.id === activeProject); return cur ? (
              <>
                <span title={`待办 ${cur.todo_count ?? 0} 条`} style={{ flexShrink: 0, minWidth: 16, textAlign: 'center', fontSize: 'var(--fs-2xs)', borderRadius: 8, padding: '0 4px', background: 'var(--danger-soft, rgba(220,38,38,.12))', color: 'var(--danger)' }}>{cur.todo_count ?? 0}</span>
                <span title={`未验证 ${cur.unverified_count ?? 0} 条`} style={{ flexShrink: 0, minWidth: 16, textAlign: 'center', fontSize: 'var(--fs-2xs)', borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{cur.unverified_count ?? 0}</span>
              </>
            ) : null; })()}
            <ChevronDown size={12} style={{ flexShrink: 0 }} />
          </button>
          {projOpen && (
            // T02167 二轮：右缘预算 24px→48px——面板左缩进约 26px，原「100vw−24px」公式按 0 缩进
            // 推算，380px 窗口下面板右缘越出窗口 2px；预留 48px 后右缘恒留 ~22px 余量
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.14)', zIndex: 30, minWidth: 220, maxWidth: 'min(360px, calc(100vw - 48px))', overflowX: 'hidden' }}>
              {/* T02201：面板顶部显式承载加载/失败态——取数失败时点开项目切换不再是一片空白，且带重试入口 */}
              {projectList.phase !== 'ready' && (
                <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}><ProjectListHint view={projectList} /></div>
              )}
              {/* T03211（PM-105）：全部项目混合视图——跨项目任务集，可在同一多选集内跨项目勾选后批量操作 */}
              <div role="button" tabIndex={0} className="card-btn" aria-pressed={activeProject === ALL_PROJECTS} aria-label="全部项目" /* NOSONAR: S6819 豁免——与项目行同构，键盘支持在 onKeyDown 保留 */
                onClick={() => { setActiveProject(ALL_PROJECTS); setProjOpen(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveProject(ALL_PROJECTS); setProjOpen(false); } }}
                title={`全部项目 — 跨项目混合视图（待办合计 ${allTodo} 条，未验证合计 ${allUnv} 条）；可跨项目多选后批量操作`}
                style={{ display: 'flex', width: '100%', boxSizing: 'border-box', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 'var(--fs-s)', background: activeProject === ALL_PROJECTS ? 'var(--accent-soft)' : 'transparent', color: 'var(--text)', border: 'none', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>全部项目</span>
                <span title={`待办合计 ${allTodo} 条`} style={{ flexShrink: 0, minWidth: 16, textAlign: 'center', fontSize: 'var(--fs-2xs)', borderRadius: 8, padding: '0 4px', background: 'var(--danger-soft, rgba(220,38,38,.12))', color: 'var(--danger)' }}>{allTodo}</span>
                <span title={`未验证合计 ${allUnv} 条`} style={{ flexShrink: 0, minWidth: 16, textAlign: 'center', fontSize: 'var(--fs-2xs)', borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{allUnv}</span>
              </div>
              {sortedProjects.map((p) => (
                // T02146：行容器由原生 button 改 div role=button——行内的置顶图标本身是 button，
                // HTML 不允许按钮套按钮（fdc6090 的 a11y 批修把「div→button」规则套到了含交互子元素的
                // 容器上，同 T02143 根因）。手感靠 .card-btn 补回（T02143 已在 App.tsx 落该类）。
                <div key={p.id} role="button" tabIndex={0} className="card-btn" aria-pressed={p.id === activeProject} aria-label={`切换到项目 ${p.name}`} /* NOSONAR: S6819 豁免——T02146：行内含原生置顶button，HTML禁止按钮套按钮；键盘支持已在onKeyDown保留 */
                  onClick={() => { setActiveProject(p.id); setProjOpen(false); }}
                  onKeyDown={(e) => {
                    // 只认行容器自身的按键：角标按钮的 Enter/Space 会冒泡到这里，不判 target 会
                    // 「切置顶」与「选项目」一次按两下（T02143 实测踩到）
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveProject(p.id); setProjOpen(false); }
                  }}
                  title={`${p.name}：待办 ${p.todo_count ?? 0} 条，未验证 ${p.unverified_count ?? 0} 条`}
                  style={{ display: 'flex', width: '100%', boxSizing: 'border-box', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 'var(--fs-s)', background: p.id === activeProject ? 'var(--accent-soft)' : 'transparent', color: 'var(--text)', border: 'none', cursor: 'pointer' }}>
                  {/* T00655：置顶图标——位于项目名称之前，点击切换置顶（已置顶=实心 accent + 弹入动画） */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void toggleProjectPin(p); }}
                    title={isProjectPinned(p) ? `已置顶「${p.name}」— 点击取消置顶` : `置顶「${p.name}」— 点击后在默认排序下排最前`}
                    aria-label={isProjectPinned(p) ? `取消置顶 ${p.name}` : `置顶 ${p.name}`}
                    className={isProjectPinned(p) ? 'pin-pop tbtn-anim' : 'tbtn-anim'}
                    style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: isProjectPinned(p) ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', border: 'none', background: 'transparent', padding: 0 }}
                  >
                    <Pin size={12} style={{ transform: isProjectPinned(p) ? 'rotate(-45deg)' : 'none', transition: 'transform .18s ease, color .18s ease', fill: isProjectPinned(p) ? 'currentColor' : 'none' }} />
                  </button>
                  {/* T02167：flex:1 不足以收缩——裸 flex 项 min-width:auto 会卡在 nowrap 文本的
                      min-content（整行名称宽）上，长名把右侧徽标顶出面板边框；minWidth:0 才真正让名称省略 */}
                  <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span title={`待办 ${p.todo_count ?? 0} 条`} style={{ flexShrink: 0, minWidth: 16, textAlign: 'center', fontSize: 'var(--fs-2xs)', borderRadius: 8, padding: '0 4px', background: 'var(--danger-soft, rgba(220,38,38,.12))', color: 'var(--danger)' }}>{p.todo_count ?? 0}</span>
                  <span title={`未验证 ${p.unverified_count ?? 0} 条`} style={{ flexShrink: 0, minWidth: 16, textAlign: 'center', fontSize: 'var(--fs-2xs)', borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{p.unverified_count ?? 0}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* T00771：工作空间下拉条——紧接「项目」下拉条之后（无框样式）；绑定项目上下文根路径，切换项目自动联动回显 */}
        <WorkspaceSelect
          project={projects.find((p) => p.id === activeProject) ?? null}
          onBind={(path) => {
            if (!activeProject) { flash('请先选择要绑定工作空间的项目'); return Promise.resolve(); }
            if (activeProject === ALL_PROJECTS) { flash('全部项目视图下请先选择具体项目再绑定工作空间'); return Promise.resolve(); }
            return bindWorkspace(activeProject, path);
          }}
          flash={flash}
        />
        {/* T00786：工作空间全文检索入口——语义紧跟工作空间，键入关键词全文检索并展示 partial 提示 */}
        <button
          onClick={() => {
            if (activeProject === ALL_PROJECTS) { flash('全部项目视图下请先选择具体项目再检索工作空间'); return; }
            setWsSearchOpen(true);
          }}
          className="tbtn-anim"
          disabled={!activeProject}
          title={activeProject ? '工作空间全文检索 — 在绑定工作空间内检索关键词，结果可能不完整的 partial 状态会提示' : '请先选择项目再检索工作空间'}
          aria-label="工作空间全文检索"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: 'transparent', color: 'var(--text-muted)', border: 'none', borderRadius: 6, cursor: activeProject ? 'pointer' : 'not-allowed', opacity: activeProject ? 1 : 0.4 }}
        >
          <ScanSearch size={13} style={{ flexShrink: 0 }} />
        </button>
        {/* T00655：项目排序图标——位于项目选择框之后、新建项目图标之前（悬浮/点击交互动画由 tbtn-anim 提供） */}
        <span ref={projSortRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            onClick={() => setProjSortOpen((v) => !v)}
            className="op-hidden tbtn-anim"
            title={`项目排序 — 当前：${PROJ_SORT_LABEL(projSortMode)}（默认隐藏，悬浮工具栏显示）`}
            aria-label="项目排序" aria-haspopup="menu" aria-expanded={projSortOpen}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 'var(--fs-s)', background: projSortOpen ? 'var(--accent)' : 'transparent', color: projSortOpen ? 'var(--accent-text)' : 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}
          >
            <ArrowUpDown size={13} />
          </button>
          {projSortOpen && (
            <div role="menu" aria-label="项目排序方式"
              style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.14)', zIndex: 40, minWidth: 200, padding: 4 }}>
              {PROJ_SORT_OPTIONS.map((o) => (
                <button key={o.key} role="menuitemradio" aria-checked={projSortMode === o.key}
                  onClick={() => { setProjSortMode(o.key); setProjSortOpen(false); }}
                  title={o.hint}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '6px 8px', fontSize: 'var(--fs-s)', textAlign: 'left', border: 'none', borderRadius: 4, cursor: 'pointer', background: projSortMode === o.key ? 'var(--accent-soft)' : 'transparent', color: 'var(--text)' }}>
                  <span style={{ width: 14, display: 'inline-flex', flexShrink: 0 }}>{projSortMode === o.key ? <Check size={12} style={{ color: 'var(--accent)' }} /> : null}</span>
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        {renderProjectActionButtons()}
        </span>
        </span>
        {renderBeautifyToolbarButton()}
        {renderClassifyButton()}
        {/* T02257：AI 工具列表取数失败时在工具条给出可见失败态与重试入口（此前静默为空） */}
        <ResourceHint view={toolsRes} label="AI 工具列表" />
        {/* T03176（D-14）：AI 不可用时工具条给一次原因 + 「去模型管理」，AI 按钮保留可见但禁用 */}
        {aiDown && readiness && <AiUnavailableHint r={readiness} compact />}
        {renderViewToggle()}
        {renderMultiSelectButton()}
        {/* T00481/T00720/T00728：全部收起/展开——描述、AI 摘要、处理结果三组折叠状态联动，覆盖待办+已完成全部列表；
            T00728：收起为高频操作优先——有展开内容时点击一律收起，全部收起后点击才展开；
            T00728 二轮（用户反馈）：按钮去掉中文名字，仅保留图标简化显示（语义由 title/aria 承载） */}
        <button className="tbtn-anim op-hidden" onClick={() => {
          const { ids, resultIds, failbackIds } = foldScope();
          if (anyFoldOpen()) {
            // 收起（高频优先）：验证失败反馈的未保存草稿一并丢弃——与单个反馈窗口「收起（未保存修改将丢弃）」
            // 同语义，否则草稿存在时反馈窗口仍会渲染，收起就"没生效"
            setDescExpanded({}); setSummaryExpanded({}); setResultOpen({}); setFailbackOpen({});
            setFbDrafts({});
          } else {
            // 展开：处理结果仅对有内容的任务展开、验证失败反馈仅对有失败反馈的任务展开
            // （无对应内容时展开会渲染出空块）
            const v = Object.fromEntries(ids.map((id) => [id, true]));
            setDescExpanded(v); setSummaryExpanded(v);
            setResultOpen(Object.fromEntries(resultIds.map((id) => [id, true])));
            setFailbackOpen(Object.fromEntries(failbackIds.map((id) => [id, true])));
          }
        }} title="一键收起或展开全部任务的描述、AI 摘要、处理结果与验证失败反馈（收起为高频操作优先）" aria-label="一键收起或展开全部任务详情"
          style={{ fontSize: 'var(--fs-s)', padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)' }}>
          {/* 图标指示下一步动作：有展开内容 → 将收起（折叠图标）；全部收起 → 将展开（展开图标） */}
          {anyFoldOpen() ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
        </button>
        {/* T02283：主列表断供时给出原因与重试入口；失败态下不再渲染「暂无待办任务」空态。
            T03203（U01 回归）：资源提示含「重试」按钮，必须与折叠按钮同级——放进按钮内会形成 button 嵌套（validateDOMNesting）。 */}
        <ResourceHint
          view={{ phase: tasksPhase, error: tasksError, stale: tasksPhase === 'error' && (todo.length > 0 || done.length > 0), reload: () => void loadTasks(activeProject) }}
          label="任务列表"
        />
        <label className="task-op" title={batchOpBusy ? '导入数据 — 上一批操作进行中，完成后恢复可选' : '导入数据 — CSV/JSON（JSON 支持 Trello 导出与 JSON 数组），预览确认后入库'}
          aria-disabled={batchOpBusy || undefined}
          style={{ fontSize: 'var(--fs-s)', padding: '5px 8px', borderRadius: 6, cursor: batchOpBusy ? 'not-allowed' : 'pointer', border: '1px solid var(--border-strong)', display: 'inline-block', opacity: batchOpBusy ? 0.55 : 1 }}>
          <span>导入数据</span>
          {/* T00556：扩展为 CSV/JSON 双格式导入（Trello 导出 / JSON 数组） */}
          {/* T03214（UX-02 ⑤）：预览/写库在途时禁用文件框——键盘 Tab + Enter 也走不到重复选文件 */}
          <input type="file" accept=".csv,.json" style={FILE_INPUT_SR_ONLY} data-t03214="import-file-input" disabled={batchOpBusy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void onCsvFile(f); } e.target.value = ''; }} />
        </label>
        {/* T03267（PM-402）：项目级导出——任务/计划 × Markdown/JSON；全部项目视图下不可用（导出必须落到具体项目） */}
        <select value="" disabled={exportBusy || !activeProject || activeProject === ALL_PROJECTS}
          data-t03267="project-export" aria-label="导出项目任务或计划"
          title={activeProject === ALL_PROJECTS ? '导出项目 — 请先选择具体项目' : '导出项目 — 任务/计划导出为 Markdown 或 JSON（含层级/状态/优先级）'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'tasks:md') void exportProject('tasks', 'md');
            else if (v === 'tasks:json') void exportProject('tasks', 'json');
            else if (v === 'plans:md') void exportProject('plans', 'md');
            else if (v === 'plans:json') void exportProject('plans', 'json');
            e.target.value = '';
          }}
          style={{ fontSize: 'var(--fs-s)', padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: exportBusy || !activeProject || activeProject === ALL_PROJECTS ? 0.55 : 1 }}>
          <option value="">{exportBusy ? '导出中…' : '导出项目…'}</option>
          <option value="tasks:md">任务 Markdown</option>
          <option value="tasks:json">任务 JSON</option>
          <option value="plans:md">计划 Markdown</option>
          <option value="plans:json">计划 JSON</option>
        </select>
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            title="分类筛选 — 按任务分类筛选列表"
            aria-label="分类筛选：按任务分类筛选列表"
            style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6 }}
          >
            <option value="">全部分类</option>
            <option value="none">未分类</option>
            {taskCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            title="优先级筛选 — 按任务优先级筛选列表"
            aria-label="优先级筛选：按任务优先级筛选列表"
            style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6 }}
          >
            <option value="">全部优先级</option>
            <option value="urgent">极高</option>
            <option value="high">高</option>
            <option value="normal">普通</option>
            <option value="low">低</option>
          </select>
          {/* T03232（PM-203③）：自定义字段筛选/排序——由服务端在整表上执行（EXISTS / ORDER BY），
              不是「先取一页再本地筛」，所以翻页后的结果集与顺序都与第一页一致。
              字段挂项目：全部项目视图或项目尚无字段时禁用，并把原因写进 title。 */}
          <select
            value={fieldFilterField}
            onChange={(e) => onFieldFilterField(e.target.value)}
            disabled={fieldsDisabled}
            data-t03232="field-filter"
            title={fieldsDisabled
              ? (projectFields.length === 0 && activeProject !== ALL_PROJECTS ? '当前项目还没有自定义字段——可到「设置 → 自定义字段」创建' : '自定义字段按项目定义，请先在项目下拉里选择具体项目')
              : '自定义字段筛选 — 在服务端按字段值筛选（翻页后条件仍生效）'}
            aria-label="自定义字段筛选：选择要筛选的自定义字段"
            style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, opacity: fieldsDisabled ? 0.55 : 1, cursor: fieldsDisabled ? 'not-allowed' : 'pointer' }}
          >
            <option value="">自定义字段筛选</option>
            {projectFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {activeField && (
            <>
              <select
                value={fieldFilterOp}
                onChange={(e) => setFieldFilterOp(e.target.value)}
                data-t03232="field-op"
                title="筛选条件 — 按字段类型可选的比较方式"
                aria-label="自定义字段筛选条件：选择比较方式"
                style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6 }}
              >
                {FIELD_FILTER_OPS[activeField.type].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {fieldFilterNeedsValue && (activeField.type === 'select' ? (
                <select
                  value={fieldFilterValue}
                  onChange={(e) => setFieldFilterValue(e.target.value)}
                  data-t03232="field-value"
                  title="筛选值 — 选择要匹配的选项"
                  aria-label="自定义字段筛选值：选择要匹配的选项"
                  style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6 }}
                >
                  <option value="">选择选项…</option>
                  {activeField.options.map((o) => <option key={o.id} value={o.id}>{o.archived ? `${o.label}（已停用）` : o.label}</option>)}
                </select>
              ) : (
                <input
                  value={fieldFilterValue}
                  onChange={(e) => setFieldFilterValue(e.target.value)}
                  data-t03232="field-value"
                  placeholder={activeField.type === 'number' ? '输入数字' : activeField.type === 'date' ? 'YYYY-MM-DD' : '输入筛选文本'}
                  title="筛选值 — 文本按包含/等于匹配，数字与日期按大小比较；留空表示暂不筛选"
                  aria-label="自定义字段筛选值：填写筛选值"
                  style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, width: 120 }}
                />
              ))}
              <button
                type="button"
                onClick={clearFieldFilter}
                data-t03232="field-clear"
                title="清除自定义字段筛选 — 回到未按字段筛选的列表"
                aria-label="清除自定义字段筛选"
                style={{ fontSize: 'var(--fs-s)', padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)' }}
              >
                <X size={12} /><span>清除字段筛选</span>
              </button>
            </>
          )}
          <select
            value={fieldSort}
            onChange={(e) => setFieldSort(e.target.value)}
            disabled={fieldsDisabled}
            data-t03232="field-sort"
            title={fieldsDisabled
              ? (projectFields.length === 0 && activeProject !== ALL_PROJECTS ? '当前项目还没有自定义字段——可到「设置 → 自定义字段」创建' : '自定义字段按项目定义，请先在项目下拉里选择具体项目')
              : '自定义字段排序 — 未填值的任务排在最后'}
            aria-label="自定义字段排序：按自定义字段排序列表"
            style={{ padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, opacity: fieldsDisabled ? 0.55 : 1, cursor: fieldsDisabled ? 'not-allowed' : 'pointer' }}
          >
            <option value="">自定义字段排序</option>
            {projectFields.map((f) => (
              <Fragment key={f.id}>
                <option value={`${f.id}|asc`}>{`按「${f.name}」升序`}</option>
                <option value={`${f.id}|desc`}>{`按「${f.name}」降序`}</option>
              </Fragment>
            ))}
          </select>
        </span>
        {/* T02952：搜索框 + 框内左侧清空按钮（有内容才显示；悬浮倾斜 5°~10° 由 .ws-clear-btn 提供；点击清空且光标留框内） */}
        <span style={{ position: 'relative', display: 'inline-flex', marginLeft: 'auto' }}>
          <input
            ref={searchInputRef}
            className="op-hidden"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标题/描述/编号…" data-page-search
            style={{ padding: '6px 8px 6px 26px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-s)' }}
          />
          {search && (
            <button
              type="button"
              className="op-hidden tbtn-anim ws-clear-btn"
              onClick={() => { setSearch(''); searchInputRef.current?.focus(); }}
              title="清空搜索内容 — 点击清空搜索框，光标保留在框内"
              aria-label="清空搜索内容"
              style={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              <X size={12} />
            </button>
          )}
        </span>
        <NoticeToast notice={notice} onDismiss={dismissNotice} />
      </div>
    );
  }

  /** 新建任务表单行 + 可选的描述/截图粘贴区 */
  function renderNewTaskForm() {
    return (
      <>
        <div className="op-host" style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', rowGap: 8 }}>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !creating) void createTask(); }}
            placeholder="输入任务标题，回车创建"
            aria-label="新建任务标题"
            // T02277：min-width 给到 80 而非 0——0 时本项可缩到零，行内永不触发换行，
            // 容器 flexWrap 兜底形同虚设（极窄窗口下输入框塌成一条）；80 让 ≤340px 时按钮换行回视口
            style={{ flex: 1, minWidth: 80, padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6 }}
          />
          <span className="op-hidden" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <select value={newPriority} onChange={(e) => setNewPriority(e.target.value)} title="优先级" aria-label="新建任务优先级" style={{ padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6 }}>
            <option value="low">低</option>
            <option value="normal">中</option>
            <option value="high">高</option>
            <option value="urgent">极高</option>
          </select>
          <select value={newCategory} onChange={(e) => setNewCategory(e.target.value)} title="分类" aria-label="新建任务分类选择" style={{ padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6 }}>
            <option value="">未分类</option>
            {taskCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {/* T00758：智能分类由「勾选框+中文」改为无中文动画图标按钮——开启=Sparkles 高亮呼吸动画，关闭=Sparkle 灰显静态；
              语义由 title/aria-pressed 承载 */}
          <button
            onClick={() => setSmartCat(!smartCat)}
            aria-pressed={smartCat}
            title={smartCat ? '智能分类（已开启）— 新建任务按标题智能匹配分类，点击关闭' : '智能分类（已关闭）— 点击开启新建任务的标题智能分类'}
            aria-label={smartCat ? '智能分类：已开启，点击关闭' : '智能分类：已关闭，点击开启'}
            style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', border: 'none', background: 'transparent', cursor: 'pointer', color: smartCat ? 'var(--accent)' : 'var(--text-muted)' }}
          >
            {smartCat ? <Sparkles size={13} className="task-breathe" /> : <Sparkle size={13} />}
          </button>
          <button onClick={() => setNewDescOpen(!newDescOpen)} title="描述/截图 — 展开或收起描述与截图上传区" aria-label={newDescOpen ? '收起描述与截图编辑区' : '展开描述与截图编辑区'} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>{newDescOpen ? <ChevronUp size={13} /> : <ImagePlus size={13} />}</button>
          </span>
          <button className="tbtn-anim" onClick={() => void createTask()} disabled={creating} title={creating ? '添加中 — 正在智能分类并保存任务' : '添加任务 — 创建新任务并保存到当前项目'} aria-label={creating ? '添加中：正在智能分类并保存任务' : '添加任务：创建新任务并保存到当前项目'} style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px', color: creating ? 'var(--text-muted)' : 'var(--text)' }}>
            {creating ? <Loader2 size={13} className="aispin" /> : <Plus size={13} />}
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
                      style={{ position: 'absolute', top: -6, right: -6, fontSize: 'var(--fs-2xs)', lineHeight: '16px', padding: '0 4px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
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
              aria-label="新建任务描述"
              style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-s)', boxSizing: 'border-box' }}
            />
          </div>
        )}
      </>
    );
  }

  /** 任务列表区块（FR1.4 检索 + 排序 + 验证状态过滤） */
  function renderTaskLists() {
    const batchBar = renderBatchBar();
    // T00446 / INT-6：CSV 导入预览确认块
    const csvBlock = csvPreview && (
      <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12, margin: '8px 0', background: 'var(--card-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 'var(--fs-m)' }}>{csvImportKind === 'json' ? 'JSON' : 'CSV'} 导入预览</strong>
          {csvMeta && (
            <span data-t03267="source" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              来源：{CSV_SOURCE_LABEL[csvMeta.source]}
            </span>
          )}
          <span style={{ fontSize: 'var(--fs-s)', color: 'var(--success)' }}>可导入 {csvPreview.items.length} 条</span>
          {csvPreview.errors.length > 0 && <span style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>问题 {csvPreview.errors.length} 行</span>}
          <span style={{ flex: 1 }} />
          <button onClick={() => { setCsvPreview(null); setCsvMeta(null); setCsvRaw(null); }} className="task-op" style={{ cursor: 'pointer', padding: '3px 8px' }}>取消</button>
          <button onClick={() => void confirmCsvImport()} disabled={batchOpBusy || csvPreview.items.length === 0}
            style={{ padding: '4px 12px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)' }}>
            确认导入
          </button>
        </div>
        {/* T03267（PM-402②）：字段映射可人工调整——改一项即按原文件重解析，标题列必选 */}
        {csvMeta && (
          <div data-t03267="mapping" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            <span>字段映射：</span>
            {CSV_MAP_FIELDS.map((f) => (
              <label key={f.field} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {f.label}{f.required ? ' *' : ''}
                <select value={csvMeta.mapping[f.field] ?? ''} disabled={batchOpBusy}
                  data-t03267={`map-${f.field}`} aria-label={`映射${f.label}列`}
                  onChange={(e) => void changeCsvMapping(f.field, e.target.value)}
                  style={{ padding: '2px 4px', fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4 }}>
                  <option value="">{f.required ? '（必选）' : '未映射'}</option>
                  {csvMeta.headers.map((h, i) => <option key={`${h}-${i}`} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        {csvPreview.errors.length > 0 && (
          <div style={{ marginBottom: 8, fontSize: 'var(--fs-xs)', color: 'var(--danger)', maxHeight: 80, overflowY: 'auto' }}>
            {csvPreview.errors.map((e) => <div key={`${e.row}-${e.message}`}>第 {e.row} 行：{e.message}</div>)}
          </div>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)' }}>
          <thead><tr>{['标题', '描述', '优先级', '状态', '分类'].map((h) => <th key={h} style={{ padding: '4px 6px', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textAlign: 'left', borderBottom: '1px solid var(--border-strong)' }}>{h}</th>)}</tr></thead>
          <tbody>
            {csvPreview.items.map((it) => (
              <tr key={`${it.title}|${it.description}|${it.priority}|${it.status}|${it.categoryId ?? ''}`}>
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
    // T03215（PM-304）：过滤/排序/父子装配（matches、sortTasks、arrangeTaskTree）与三份可见列表
    // 已上移到组件级 useMemo（见 listWin 所在块）——窗口化后滚动会重渲染本组件，
    // 这些派生计算若仍留在渲染体内，每帧都要重跑 filter+sort+O(n²) 装配，虚拟滚动就白做了。
    // T00922：tab 标题已完成/待办统计改取项目级全量计数——原列表长度仅覆盖当前已加载页，
    // 首屏需「加载更多」后才趋近真实总量；改用项目级全量计数字段后首屏即显示全量。未验证数保持原语义（已完成中未验证）
    const curProj = projects.find((p) => p.id === activeProject);
    // T03211：全部项目视图没有单项目对象——用各项目计数之和，仍保持「首屏即全量」口径
    const aggTodo = projects.reduce((s, p) => s + (p.todo_count ?? 0), 0);
    const aggDone = projects.reduce((s, p) => s + (p.done_count ?? 0), 0);
    const aggregate = activeProject === ALL_PROJECTS;
    const todoTotal = curProj?.todo_count ?? (aggregate ? aggTodo : todo.length);
    const doneTotal = curProj?.done_count ?? (aggregate ? aggDone : done.length);
    return (
      <>
        {batchBar}
        {/* T01065 后续：多级撤销条——独立于批量条常驻（批量操作后选中被清空，批量条会收起） */}
        {renderUndoBar()}
        {/* T03211：批量回执——成功/失败计数与逐条原因，常驻到手动关闭 */}
        {renderBatchReceipt()}
        {/* T01480：导出格式选择菜单（fixed 覆盖层，点外关闭） */}
        {exportMenu && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1300 }}>
            {/* M6-6.3：遮罩即原生 button（S6848/S1082——div onClick 触发规则），菜单为兄弟层置于其上，无需阻断冒泡 */}
            <button type="button" aria-label="关闭导出菜单" onClick={() => setExportMenu(null)}
              style={{ position: 'absolute', inset: 0, background: 'transparent', border: 'none', cursor: 'default' }} />
            <div style={{ position: 'absolute', left: Math.min(exportMenu.x, window.innerWidth - 190), top: Math.min(exportMenu.y, window.innerHeight - 150), background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,.18)', padding: 4, minWidth: 170 }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', padding: '4px 8px' }}>导出为…</div>
              {EXPORT_ITEMS.map((it) => (
                <button key={it.fmt} onClick={() => void exportTasks([exportMenu.taskId], it.fmt)} disabled={exportBusy}
                  className="export-anim"
                  title={`文件导出 - ${it.desc}`}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 'var(--fs-m)', border: 'none', background: 'transparent', color: 'var(--text)', cursor: exportBusy ? 'wait' : 'pointer', textAlign: 'left', borderRadius: 6 }}>
                  <Download size={14} style={{ color: 'var(--accent)' }} /> {it.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {csvBlock}
        {viewMode === 'board' && renderBoard()}
        {viewMode === 'board' && <div style={{ height: 8 }} />}
        {viewMode === 'list' && (<>
        {/* T00757：待办/已完成/搁置 三个标题并排为 tab——激活项加粗+下方横线，未激活常规字重；仅渲染激活 tab 的列表 */}
        <div className="op-host" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-strong)', marginBottom: 8 }}>
          {([['todo', `待办（${visibleTodo.length}/${todoTotal}）`],
             ['done', `已完成（${visibleDone.length}/${doneTotal}，未验证 ${done.filter((t) => !t.verified).length}）`],
             ['shelved', `搁置（${visibleShelved.length}）`]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key)} aria-pressed={activeTab === key}
              title={`${label} — 点击切换到该列表`}
              style={{ fontSize: 'var(--fs-l)', padding: '6px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
                fontWeight: activeTab === key ? 700 : 400,
                color: activeTab === key ? 'var(--text)' : 'var(--text-muted)',
                borderBottom: activeTab === key ? '2px solid var(--accent)' : '2px solid transparent' }}>
              {label}
            </button>
          ))}
        </div>
        {activeTab === 'todo' && (<>
        <div className="op-host" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
          {multiSelect && (
            <TriCheckbox
              checked={visibleTodo.length > 0 && visibleTodo.every((t) => selectedIds.has(t.id))}
              indeterminate={visibleTodo.some((t) => selectedIds.has(t.id))}
              onChange={(e) => toggleSelectAll(visibleTodo, e.target.checked)}
              title="全选/全不选待办列表" label="全选待办任务"
              style={{ cursor: 'pointer' }} />
          )}
          {/* 按修改时间/优先级排序：会话级偏好，选项见 sortOptions */}
          <select
            className="op-hidden"
            value={todoSort}
            onChange={(e) => setTodoSort(e.target.value as SortKey)}
            title="待办排序 — 按修改时间或优先级排序"
            aria-label="待办排序：按修改时间或优先级排序"
            style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4 }}
          >
            {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {/* T03215（PM-304）：窗口化渲染——只渲染视口±overscan 行，其余用 ul 上下内边距占位撑出等总高的滚动区间 */}
        <ul ref={listWin.setListEl} data-t03215-window={listWin.virtualized ? 'on' : 'off'} style={{ listStyle: 'none', padding: 0, margin: 0, paddingTop: listWin.win.padTop, paddingBottom: listWin.win.padBottom }}>{visibleTodo.slice(listWin.win.start, listWin.win.end).map((t) => <Fragment key={t.id}>{renderTaskItem(t, 'todo', todoIds)}</Fragment>)}</ul>
        {/* T02283：取数失败时不渲染空态——「暂无待办任务」会把后端故障说成没活干（项目列表失败导致
            连 activeProject 都拿不到时同理） */}
        {visibleTodo.length === 0 && !multiSelect && tasksPhase !== 'error' && projectList.phase !== 'error' && (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-s)', border: '1px dashed var(--border-strong)', borderRadius: 8, margin: '8px 0', lineHeight: 1.8 }}>
            当前项目暂无待办任务——在上方输入框输入标题回车即可创建；
            {tools.length === 0
              ? <>先到「模型」页添加 AI 模型，即可使用 AI 梳理 / 美化 / 分类等能力。</>
              : <>也可使用上方 AI 梳理、美化、批量分类等能力。</>}
          </div>
        )}
        </>)}

        {activeTab === 'done' && (<>
        <div className="op-host" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
          {/* 提示未验证数量：默认过滤「仅未验证」时，让用户意识到已验证项只是被过滤而非丢失 */}
          {multiSelect && (
            <TriCheckbox
              checked={visibleDone.length > 0 && visibleDone.every((t) => selectedIds.has(t.id))}
              indeterminate={visibleDone.some((t) => selectedIds.has(t.id))}
              onChange={(e) => toggleSelectAll(visibleDone, e.target.checked)}
              title="全选/全不选已完成列表" label="全选已完成任务"
              style={{ cursor: 'pointer' }} />
          )}
          <select
            className="op-hidden"
            value={doneSort}
            onChange={(e) => setDoneSort(e.target.value as SortKey)}
            title="已完成排序 — 按修改时间或优先级排序"
            aria-label="已完成排序：按修改时间或优先级排序"
            style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4 }}
          >
            {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select
            className="op-hidden"
            value={doneFilter}
            onChange={(e) => setDoneFilter(e.target.value as 'all' | 'unverified' | 'verified')}
            title="验证状态过滤 — 筛选已完成任务的验证状态显示范围"
            aria-label="验证状态过滤：筛选已完成任务的验证状态显示范围"
            style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4 }}
          >
            <option value="unverified">仅未验证</option>
            <option value="verified">仅已验证</option>
            <option value="all">全部</option>
          </select>
        </div>
        <ul ref={listWin.setListEl} data-t03215-window={listWin.virtualized ? 'on' : 'off'} style={{ listStyle: 'none', padding: 0, margin: 0, paddingTop: listWin.win.padTop, paddingBottom: listWin.win.padBottom }}>{visibleDone.slice(listWin.win.start, listWin.win.end).map((t) => <Fragment key={t.id}>{renderTaskItem(t, 'done', doneIds)}</Fragment>)}</ul>
        {visibleDone.length === 0 && tasksPhase !== 'error' && (
          <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>暂无已完成任务——完成任务后在此集中查看与验证。</div>
        )}
        </>)}

        {/* T00719：搁置任务列表——页面最下方独立区块，与待办/已完成隔离（MCP 处理待办时自动忽略搁置任务）；
            工具条与查询条件对齐待办/已完成（多选全选 + 排序 + 同一套关键词/分类/优先级过滤） */}
        {activeTab === 'shelved' && (<>
        <div className="op-host" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
          {multiSelect && (
            <TriCheckbox
              checked={visibleShelved.length > 0 && visibleShelved.every((t) => selectedIds.has(t.id))}
              indeterminate={visibleShelved.some((t) => selectedIds.has(t.id))}
              onChange={(e) => toggleSelectAll(visibleShelved, e.target.checked)}
              title="全选/全不选搁置列表" label="全选搁置任务"
              style={{ cursor: 'pointer' }} />
          )}
          <select
            className="op-hidden"
            value={shelvedSort}
            onChange={(e) => setShelvedSort(e.target.value as SortKey)}
            title="搁置排序 — 按修改时间或优先级排序"
            aria-label="搁置排序：按修改时间或优先级排序"
            style={{ padding: 3, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4 }}
          >
            {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {/* T02290：搁置列表取数失败此前无任何出口——挂共享失败态层，给出原因/重试，并在旧数据在位时标「可能过期」 */}
        <div style={{ margin: '4px 0' }}>
          <ResourceHint
            view={{ phase: shelvedPhase, error: shelvedError, stale: shelvedPhase === 'error' && visibleShelved.length > 0, reload: () => void loadTasks(activeProject) }}
            label="搁置列表"
          />
        </div>
        <ul ref={listWin.setListEl} data-t03215-window={listWin.virtualized ? 'on' : 'off'} style={{ listStyle: 'none', padding: 0, margin: 0, paddingTop: listWin.win.padTop, paddingBottom: listWin.win.padBottom }}>{visibleShelved.slice(listWin.win.start, listWin.win.end).map((t) => <Fragment key={t.id}>{renderTaskItem(t, 'shelved', shelvedIds)}</Fragment>)}</ul>
        {visibleShelved.length === 0 && shelvedPhase !== 'error' && (
          <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>暂无搁置任务——点击任务行的「搁置」按钮（归档按钮前）可把任务移到这里，AI 处理待办时自动忽略。</div>
        )}
        </>)}
        </>)}
      </>
    );
  }

  /** 分页加载更多：当前页满页时追加下一页；hasMore=false 表示已到底 */
  function renderLoadMore() {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, margin: '12px 0' }}>
        {serverTotal != null && (
          <span data-t02291="task-total" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>共 {serverTotal} 条</span>
        )}
        {hasMore && (
        <button
          onClick={() => void loadMore()}
          disabled={loadingMore}
          title={loadingMore ? '加载中 — 正在拉取更多任务' : '加载更多 — 拉取下一页任务'}
          aria-label={loadingMore ? '加载更多：正在拉取更多任务' : '加载更多：拉取下一页任务'}
          style={{ padding: '6px 16px', fontSize: 'var(--fs-s)', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--surface-2)' }}
        >
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
        )}
        {/* T03214（UX-02 ①）：剩余条数常驻告知；取完即消失并换成「已加载全部」，与「共 N 条」区分本页/全量 */}
        {pageStatus?.remaining != null && pageStatus.remaining > 0 && (
          <span data-t03214="task-remaining" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>剩余 {pageStatus.remaining} 条</span>
        )}
        {pageStatus?.allLoaded && (
          <span data-t03214="all-loaded" role="status" style={{ fontSize: 'var(--fs-s)', color: 'var(--success)' }}>已加载全部</span>
        )}
      </div>
    );
  }

  /** 复用弹窗目标切换按钮组（提取以降低弹窗函数复杂度，渲染不变） */
  function renderReuseTargetButtons() {
    return (
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button
          onClick={() => setReuseTarget('project')}
          title="复制到项目 — 将任务原样复制到其他项目"
          aria-label="复制到项目：将任务原样复制到其他项目"
          style={{ padding: '4px 12px', borderRadius: 6, fontSize: 'var(--fs-s)', cursor: 'pointer', border: '1px solid var(--border-strong)', background: reuseTarget === 'project' ? 'var(--accent)' : 'transparent', color: reuseTarget === 'project' ? 'var(--accent-text)' : 'var(--text)' }}
        >复制到项目</button>
        <button
          onClick={() => setReuseTarget('prompt')}
          title="复制到提示词 — 将任务打包为 JSON 资产存入提示词页分类"
          aria-label="复制到提示词：将任务打包为 JSON 资产存入提示词页分类"
          style={{ padding: '4px 12px', borderRadius: 6, fontSize: 'var(--fs-s)', cursor: 'pointer', border: '1px solid var(--border-strong)', background: reuseTarget === 'prompt' ? 'var(--accent)' : 'transparent', color: reuseTarget === 'prompt' ? 'var(--accent-text)' : 'var(--text)' }}
        >复制到提示词</button>
        <button
          onClick={() => setReuseTarget('req')}
          title="复制到通用需求 — 将任务打包为通用需求条目存入需求页分类"
          aria-label="复制到通用需求：将任务打包为通用需求条目存入需求页分类"
          style={{ padding: '4px 12px', borderRadius: 6, fontSize: 'var(--fs-s)', cursor: 'pointer', border: '1px solid var(--border-strong)', background: reuseTarget === 'req' ? 'var(--accent)' : 'transparent', color: reuseTarget === 'req' ? 'var(--accent-text)' : 'var(--text)' }}
        >复制到通用需求</button>
      </div>
    );
  }

  /** 复用目标=项目：搜索框 + 项目列表（提取以降低弹窗函数复杂度，渲染不变） */
  function renderReuseProjectPicker() {
    const matched = projects.filter((p) => p.name.toLowerCase().includes(reuseSearch.trim().toLowerCase()));
    return (
      <>
        <input
          autoFocus
          value={reuseSearch}
          onChange={(e) => setReuseSearch(e.target.value)}
          placeholder="搜索项目…"
          aria-label="搜索项目"
          style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)', boxSizing: 'border-box' }}
        />
        <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {matched.map((p) => (
            <button key={p.id} onClick={() => setReuseProjectId(p.id)}
              style={{ textAlign: 'left', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: reuseProjectId === p.id ? 'var(--accent)' : 'transparent', color: reuseProjectId === p.id ? 'var(--accent-text)' : 'var(--text)' }}>
              {p.name}
            </button>
          ))}
          {matched.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>无匹配项目</div>
          )}
        </div>
      </>
    );
  }

  /** 复用目标=通用需求：说明 + 分类选择 + 新建分类（提取以降低弹窗函数复杂度，渲染不变） */
  function renderReuseReqPicker() {
    return (
      <>
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 8 }}>
          将任务打包为通用需求条目，存入所选需求分类（标题沿用任务名，内容含描述与 AI 摘要）。
        </div>
        {reqCats.length === 0 ? (
          <p style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 8 }}>暂无可用的通用需求分类，请先新建。</p>
        ) : (
          <select
            autoFocus
            value={reuseCategoryId}
            onChange={(e) => setReuseCategoryId(e.target.value)}
            aria-label="选择通用需求分类"
            style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)' }}
          >
            <option value="">请选择分类</option>
            {reqCats.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.reqCount ?? 0}）</option>)}
          </select>
        )}
        <button onClick={() => void addReqCat()} title="新建分类 — 在通用需求页新建一个分类用于存放任务资产"
          aria-label="新建分类：在通用需求页新建一个分类用于存放任务资产"
          style={{ marginTop: 8, fontSize: 'var(--fs-s)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
          <Plus size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> 新建分类
        </button>
      </>
    );
  }

  /** 复用目标=提示词：说明 + 分类选择 + 新建分类（提取以降低弹窗函数复杂度，渲染不变） */
  function renderReusePromptPicker() {
    return (
      <>
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 8 }}>
          将任务打包为 JSON 资产，存入所选提示词分类（标题沿用任务名，内容含描述与 AI 摘要）。
        </div>
        {promptCats.length === 0 ? (
          <p style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 8 }}>暂无可用的提示词分类，请先新建。</p>
        ) : (
          <select
            autoFocus
            value={reuseCategoryId}
            onChange={(e) => setReuseCategoryId(e.target.value)}
            aria-label="选择提示词分类"
            style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 'var(--fs-l)' }}
          >
            <option value="">请选择分类</option>
            {promptCats.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.promptCount ?? 0}）</option>)}
          </select>
        )}
        <button onClick={() => void addPromptCat()} title="新建分类 — 在提示词页新建一个分类用于存放任务资产"
          aria-label="新建分类：在提示词页新建一个分类用于存放任务资产"
          style={{ marginTop: 8, fontSize: 'var(--fs-s)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
          <Plus size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} /> 新建分类
        </button>
      </>
    );
  }

  /** 复用弹窗底部：取消 + 提交（按目标切换文案与禁用条件；用 if/else 避免嵌套三元，行为不变） */
  function renderReuseFooter() {
    const disabled = (reuseTarget === 'project' ? !reuseProjectId : !reuseCategoryId) || reuseBusy;
    let label: string;
    if (reuseTarget === 'project') label = reuseBusy ? '复用中…' : '复用';
    else if (reuseBusy) label = '复制中…';
    else if (reuseTarget === 'req') label = '复制到通用需求';
    else label = '复制到提示词';
    return (
      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="ghost" onClick={() => setReuseOpen(null)} style={{ padding: '6px 14px' }}>取消</button>
        <button onClick={() => void reuseTask()} disabled={disabled} style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)' }}>
          {label}
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
          <div style={{ fontSize: 'var(--fs-l)', marginBottom: 10 }}>复用任务</div>
          {renderReuseTargetButtons()}
          {reuseTarget === 'project' && renderReuseProjectPicker()}
          {reuseTarget === 'req' && renderReuseReqPicker()}
          {reuseTarget === 'prompt' && renderReusePromptPicker()}
          {renderReuseFooter()}
        </div>
      </div>
    );
  }

  // T03215（PM-304）：sortOptions / SortKey / sortTasks 上提为 ../utils/taskListQuery 的模块级导出——
  // 可见列表要用 useMemo 缓存，缓存依赖的函数标识必须稳定，留在渲染体里每帧都是新函数。

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
        /* T00466：与提示词页 arena-row 特效统一——边框、刷新 flush、点击微缩放 */
        .task-item { border: 1px solid var(--border); border-radius: 8px; margin: 6px 0; transition: background-color 0.15s ease, transform .12s ease; }
        .task-item:hover { background: var(--surface-2); }
        .task-item.item-pressing { transform: scale(.985); } /* T00489：仅按住行（非交互区 200ms）时缩放 */
        /* T00521 调整：验证结果选择面板弹出动画（缩放+下移淡入，与 toast-in 同族节奏） */
        @keyframes verify-pop { from { opacity: 0; transform: translateY(-6px) scale(.92); } to { opacity: 1; transform: none; } }
        @keyframes taskflush { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
        /* T00655：项目置顶图标状态切换弹入动画（未置顶 → 已置顶） */
        @keyframes pin-pop { 0% { transform: scale(.6) rotate(-45deg); opacity: .5; } 60% { transform: scale(1.25) rotate(-45deg); } 100% { transform: scale(1) rotate(-45deg); opacity: 1; } }
        .pin-pop { animation: pin-pop .28s ease-out; }
        .task-item.flush { animation: taskflush 1.4s ease; }
        /* T00467：工具栏图标按钮 hover 动画（开源 lucide 图标 + 缩放旋转反馈） */
        .tbtn-anim svg { transition: transform .18s ease; }
        .tbtn-anim:hover svg { transform: scale(1.2) rotate(8deg); }
        .tbtn-anim:active svg { transform: scale(.88); }
        /* T00474：筛选条件悬浮展示——默认淡化降权重，工具栏悬浮/键盘聚焦时完全显示 */
        /* T00487：悬浮显示替代灰显——默认完全隐藏（占位不抖动），宿主悬浮/键盘聚焦时 200ms 平滑显示 */
        .task-item .title-op { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        /* T01562：抽屉打开时保持该行操作区显形——关闭抽屉后焦点要归还给触发按钮，
           而 visibility:hidden 的元素无法接收 focus()，否则键盘用户关闭后焦点掉回 body */
        .task-item:hover .title-op, .task-item:focus-within .title-op, .task-item.task-drawer-open .title-op { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
        .task-op {
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.15s ease, visibility 0s linear 0.15s;
        }
        .task-item:hover .task-op,
        .task-item:focus-within .task-op,
        .task-item.task-drawer-open .task-op,
        .task-item.task-editing .task-op {
          opacity: 1;
          visibility: visible;
          transition: opacity 0.15s ease, visibility 0s;
        }
        /* T00591：任务标题下方工具栏默认自动收起（高度折叠使标题更紧凑），鼠标悬浮任务标题/行后平滑展开 */
        .task-toolbar {
          max-height: 0;
          margin-top: 0;
          overflow: hidden;
          transition: max-height 0.18s ease, margin-top 0.18s ease;
        }
        .task-item:hover .task-toolbar,
        .task-item:focus-within .task-toolbar,
        .task-item.task-drawer-open .task-toolbar,
        .task-item.task-editing .task-toolbar {
          max-height: 96px;
          margin-top: 2px;
        }
        /* 请求进行中的呼吸反馈：缩放 + 外发光脉冲，与主题主色一致 */
        .task-breathe { animation: task-breathe 1.3s ease-in-out infinite; }
        @keyframes task-breathe {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.35); }
          50% { transform: scale(1.06); box-shadow: 0 0 0 5px rgba(37, 99, 235, 0); }
        }
      `}</style>
      {renderToolbar()}
      {/* T00771：新建项目后的工作空间绑定弹窗——内嵌同款选择面板（历史/新建/打开本地文件夹），可跳过 */}
      {wsPickForNew && (
        <dialog open
          aria-label="绑定工作空间"
          style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '18vh' }}>
          <div
            style={{ width: 300, background: 'var(--card-bg)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,.25)', padding: 12 }}>
            <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, marginBottom: 2 }}>为「{wsPickForNew.name}」选择工作空间</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>工作空间是项目的上下文根路径，AI 功能将以此路径加载上下文；可跳过稍后在任务菜单绑定。</div>
            <div style={{ position: 'relative' }}>
              <WorkspaceSelect
                variant="bare"
                project={wsPickForNew}
                onBind={async (path) => { await bindWorkspace(wsPickForNew.id, path); setWsPickForNew(null); }}
                flash={flash}
              />
            </div>
            <button onClick={() => setWsPickForNew(null)}
              style={{ marginTop: 8, width: '100%', fontSize: 'var(--fs-s)', padding: '5px 0', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
              跳过，稍后绑定
            </button>
          </div>
        </dialog>
      )}
      {renderNewTaskForm()}
      {renderTaskLists()}
      {renderLoadMore()}
      {reuseOpen && renderReuseDialog()}
      {/* T00610：验证失败反馈录入弹窗——支持截图（粘贴/选择文件），截图随反馈落库供 MCP 读取识别 */}
      {failDialog && (
        <div /* NOSONAR - 弹窗遮罩为鼠标便捷关闭，Esc/取消按钮提供键盘可达通路 */
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget && !failBusy) setFailDialog(null); }}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(560px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-m)', fontWeight: 600 }}>
              <AlertTriangle size={14} style={{ color: 'var(--danger)' }} /> 验证失败反馈
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>{failDialog.title}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setFailDialog(null)} disabled={failBusy} title="关闭" aria-label="关闭验证失败反馈弹窗"
                style={{ display: 'inline-flex', alignItems: 'center', cursor: failBusy ? 'default' : 'pointer', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 'var(--fs-l)' }}>×</button>
            </div>
            <div style={{ padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 'var(--fs-s)' }}>
              <div style={{ color: 'var(--text-muted)' }}>
                请描述验证失败的原因（可粘贴或选择截图辅助说明）；提交后任务将回退待办，截图可由 AI 通过 MCP 读取识别。
              </div>
              <textarea
                autoFocus
                value={failDialog.text}
                onChange={(e) => setFailDialog((d) => (d ? { ...d, text: e.target.value } : d))}
                onPaste={(e) => readClipboardImages(e, (url) => setFailDialog((d) => (d ? { ...d, images: [...d.images, { id: newPastedImageId(), url }] } : d)))}
                placeholder="请描述验证失败的原因…（可直接 Ctrl+V 粘贴截图）"
                aria-label="验证失败反馈内容"
                rows={5}
                style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)', resize: 'vertical' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <label className="tbtn-anim" title="选择截图文件（可多选）"
                  style={{ cursor: failBusy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-strong)', fontSize: 'var(--fs-s)', color: 'var(--text)' }}>
                  <ImagePlus size={13} /> 选择截图
                  <input type="file" accept="image/*" multiple style={FILE_INPUT_SR_ONLY}
                    onChange={(e) => {
                      const fs = [...(e.target.files ?? [])];
                      for (const f of fs) {
                        const reader = new FileReader();
                        reader.onload = () => {
                          if (typeof reader.result === 'string') {
                            setFailDialog((d) => (d ? { ...d, images: [...d.images, { id: newPastedImageId(), url: reader.result as string }] } : d));
                          }
                        };
                        reader.readAsDataURL(f);
                      }
                      e.target.value = '';
                    }} />
                </label>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>已附 {failDialog.images.length} 张截图</span>
                <span style={{ flex: 1 }} />
                {/* T00796 二轮：改用公共 AiPolishButton（与处理结果/通用需求同一组件），
                    仅作用于反馈正文，回填输入框后仍需用户确认提交 */}
                <AiPolishButton
                  value={failDialog.text}
                  onPolished={(t) => setFailDialog((d) => (d ? { ...d, text: t } : d))}
                  toolId={organizeToolId}
                  disabled={failBusy}
                  flash={flash}
                  title="AI 美化 — 润色这段失败反馈（保留全部事实要素，仅规范表达），结果回填后请核对再提交"
                />
              </div>
              {failDialog.images.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {failDialog.images.map((img) => (
                    <span key={img.id} style={{ position: 'relative', display: 'inline-flex' }}>
                      <img src={img.url} alt="待上传截图预览" style={{ height: 64, borderRadius: 4, border: '1px solid var(--border)' }} />
                      <button onClick={() => removeFailImage(img.id)}
                        title="移除该截图" aria-label="移除该截图"
                        style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 'var(--fs-xs)', lineHeight: '16px', cursor: 'pointer', padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setFailDialog(null)} disabled={failBusy} className="tbtn-anim"
                style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>取消</button>
              <button onClick={() => void submitVerifyFailed()} disabled={failBusy} className="tbtn-anim"
                title="提交反馈并回退待办" aria-label="提交验证失败反馈"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: failBusy ? 'default' : 'pointer', border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 'var(--fs-s)' }}>
                {failBusy ? <><Loader2 size={12} className="aispin" />提交中…</> : '提交并回退待办'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* T00786：工作空间全文检索面板（挂载于页面级，随主 section 渲染；floating overlay 关闭即卸载） */}
      {wsSearchOpen && (
        <WorkspaceSearchPanel
          project={projects.find((p) => p.id === activeProject) ?? null}
          flash={flash}
          onClose={() => setWsSearchOpen(false)}
        />
      )}

      {/* T01562：真抽屉详情——自包含操作台（描述/结果/摘要/时间线/关联计划），与行内展开并存；
          按 task.id 作 key 重挂载，切换任务即重置编辑态（降低与逐行展开态的耦合回归风险）。
          T01570：落位标签页由行内已展开区块推断（openDetailDrawer）/外部跳转显式指定；
          保存后走 applyTaskPatch 定点同步，行内对应区块即时更新，不再整表重载。 */}
      {drawerTask && (
        <TaskDetailDrawer
          key={drawerTask.id}
          task={drawerTask}
          projectId={activeProject}
          initialTab={drawerTab ?? undefined}
          onClose={() => { setDrawerTask(null); setDrawerTab(null); }}
          onChanged={(patch) => applyTaskPatch(drawerTask.id, patch)}
        />
      )}

      {/* T02949：派生单裁决面板——Trae/WorkBuddy 气泡选项样式（候选胶囊按钮 + 自定义输入）；
          候选由服务端按该单结论动态抽取（T02949 方案 A），不是固定四枚；
          提交由服务端把结果追加到任务详情末尾（不覆盖），本面板只负责收集与展示 */}
      {rulingTask && (
        <div role="dialog" aria-label="裁决派生单"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setRulingTask(null); setRulingDraft(''); } }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: '0 10px 28px rgba(0,0,0,.22)', width: 380, maxWidth: '92vw', padding: 14, color: 'var(--text)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600 }}>裁决派生单 {rulingTask.task_no ?? rulingTask.id}</div>
              <button type="button" className="tbtn-anim" onClick={() => { setRulingTask(null); setRulingDraft(''); }} aria-label="关闭裁决面板"
                style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                <X size={14} />
              </button>
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 10 }}>{rulingTask.title}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {rulingOptions.map((o) => (
                <button key={o} type="button" className="tbtn-anim" disabled={rulingBusy}
                  onClick={() => setRulingDraft(o)}
                  style={{ fontSize: 'var(--fs-s)', padding: '5px 10px', borderRadius: 999, cursor: rulingBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${rulingDraft === o ? 'var(--accent)' : 'var(--border-strong)'}`,
                    background: rulingDraft === o ? 'var(--accent-soft)' : 'transparent',
                    color: rulingDraft === o ? 'var(--accent)' : 'var(--text)' }}>
                  {o}
                </button>
              ))}
            </div>
            {rulingOptions.length === 0 && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>本条结论未抽到候选选项，可直接输入裁决结果</div>
            )}
            <textarea value={rulingDraft} onChange={(e) => setRulingDraft(e.target.value)} rows={3}
              placeholder="自定义裁决结果（或点选上方候选选项）" aria-label="裁决结果"
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 'var(--fs-s)', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--input-bg, transparent)', color: 'var(--text)', resize: 'vertical' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button type="button" onClick={() => { setRulingTask(null); setRulingDraft(''); }}
                style={{ fontSize: 'var(--fs-s)', padding: '6px 12px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>取消</button>
              <button type="button" className="tbtn-anim" disabled={!rulingDraft.trim() || rulingBusy} onClick={() => void submitRuling()}
                style={{ fontSize: 'var(--fs-s)', padding: '6px 14px', border: 'none', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)', cursor: rulingDraft.trim() && !rulingBusy ? 'pointer' : 'not-allowed', opacity: rulingDraft.trim() && !rulingBusy ? 1 : 0.5 }}>
                {rulingBusy ? '提交中…' : '提交裁决'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
