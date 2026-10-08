import { api, type Task } from '../api/client';
import type { TaskDetailTab } from '../components/TaskDetailDrawer';

/**
 * T01057「下一步建议」：统一「按任务编号定位到任务页」的入口。
 *
 * 背景：通知点击定位复用 T00836 的 `tasks.focusId` 会话键，而任务页行定位用 `data-ttask-id={t.id}`（uuid）匹配。
 * 此前 OS 通知（App.tsx）、通知中心铃铛（NotifyBell）、就绪任务跳转（ReportPage）三处都只写
 * `tasks.focusId = task_no`（编号≠uuid，永远命中不到行），且不下发 `focusProjectId`，
 * 于是「目标任务属于非当前项目」时列表根本不含该行 → 定位失败。本 helper 对齐命令面板（T00836 基准）：
 * 按 task_no 解析出 id/project_id/status 后写齐全部定位键，再派发 `mtaskNavigate` 切到任务页，
 * 使三条入口共用同一套「跨项目可定位」逻辑（DRY）。
 */

/** 与 useSessionState 同格式写入 sessionStorage（JSON 编码），供任务页读取初始值 */
function setSessionState(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额异常静默忽略 */ }
}

/** 派发全局导航事件：App.tsx 的 mtaskNavigate 监听据此切到任务页（浏览器/桌面壳通用） */
function navigateToTasks(): void {
  globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } }));
}

/** 解析后需要落地的最小任务信息：直接用完整 Task 视图（by-no 接口本就返回全量，无需另造窄类型） */

/**
 * T01568：外部跳转的「定位意图」载荷。
 *
 * 会话键（tasks.focusId / focusDrawerId …）只在任务页**挂载那一刻**被 useSessionState 读取一次，
 * 而 OS 通知 / 铃铛 / 就绪条常在用户已停在任务页时触发——此时只写 sessionStorage，
 * React 状态感知不到，表现为「点了通知什么也没发生」。故在写键的同时派发 `mtaskFocusTask`，
 * 已挂载的任务页据此把同一份意图写进自己的状态；两条路径（挂载读键 / 事件直写）落点一致且互斥。
 */
export interface FocusTaskIntent {
  /** 目标任务 id；解析失败时为空（仅带编号搜索词跳转） */
  id?: string;
  taskNo: string;
  /** 目标行所在列表 tab（待办/已完成） */
  tab?: 'todo' | 'done';
  projectId?: string;
  /** 非空即要求展开详情抽屉，并落在该标签页 */
  drawerTab?: TaskDetailTab | '';
  /**
   * 解析到的完整任务视图：已挂载路径直接据此开抽屉。
   * 抽屉是「完整操作台」，不应被列表当前的搜索/筛选态左右——列表正筛着上一条通知的编号时，
   * 只靠列表查找会把本条任务判为「不存在」而静默吞掉跳转（T01568 CDP 实测复现）。
   */
  task?: Task;
}

/** 派发定位意图事件（任务页已挂载时直写其状态；未挂载时由会话键在挂载时接管） */
function dispatchFocus(intent: FocusTaskIntent): void {
  globalThis.dispatchEvent(new CustomEvent('mtaskFocusTask', { detail: intent }));
}

/**
 * 通知类入口的统一落位口径（T01568）：
 * 「任务处理完成」→ 用户要看的是 AI 回传的结论 → 处理结果页；
 * 「处理失败 / 还没有回传结果」→ 结果页是空的，直接把任务正文摊开更有用 → 描述页。
 * OS 通知与铃铛 ai_state/result 事件共用此判断，避免同一件事在两条入口里落两个位置。
 */
export function drawerTabForNotice(t: Pick<Task, 'ai_state' | 'handle_result'>): TaskDetailTab {
  return t.ai_state === 'failed' || !t.handle_result ? 'desc' : 'result';
}

/** focusTaskByNo 第二形参：true=抽屉落描述页；传具体标签页名=直接落该页；'notice'=按通知语义自动落位 */
export type FocusOpenMode = TaskDetailTab | 'notice';

/** 落位口径：open=true→描述页；'notice'→按通知语义；具体页名→该页；falsy→仅定位行 */
function resolveDrawerTab(t: Task, open?: boolean | FocusOpenMode): TaskDetailTab | '' {
  if (!open) return '';
  if (open === 'notice') return drawerTabForNotice(t);
  return open === true ? 'desc' : open;
}

/**
 * 把「已解析到的任务」写成定位意图并切到任务页（focusTaskByNo / focusTaskById 共用）。
 * searchKey 用任务编号：任务页据此把列表筛到该行（编号已纳入服务端与本地搜索，T01568）。
 */
function applyFocus(t: Task, searchKey: string, open?: boolean | FocusOpenMode): void {
  const tab = t.status === 'done' ? 'done' : 'todo';
  const drawerTab = resolveDrawerTab(t, open);
  setSessionState('tasks.focusId', t.id);
  setSessionState('tasks.focusProjectId', t.project_id ?? '');
  setSessionState('tasks.focusTab', tab);
  setSessionState('tasks.activeTab', tab); // tab 与目标行所在列表对齐，保证该行渲染可见
  setSessionState('tasks.search', searchKey);
  if (drawerTab) {
    setSessionState('tasks.focusDrawerId', t.id);
    setSessionState('tasks.focusDrawerTab', drawerTab);
  }
  dispatchFocus({ id: t.id, taskNo: searchKey, tab, projectId: t.project_id ?? '', drawerTab, task: t });
  navigateToTasks();
}

/**
 * 按任务 id 定位（T01577：计划行只有 `linked_task_id`，没有编号，且本单口径禁止新增后端接口）。
 * 用既有的项目任务列表接口解析出该任务后复用同一套落位逻辑（关联受后端「同项目」约束，项目内必查得到）；
 * 解析不到（待办已删/归档/搁置）返回 false，由调用方给「未找到对应待办」提示而非静默。
 *
 * 先带 keyword=关联标题 查：大项目未筛的全量前 500 条未必含目标行，只靠全量本地筛会误报「未找到」。
 */
export async function focusTaskById(
  taskId: string | null | undefined,
  projectId: string | null | undefined,
  open?: boolean | FocusOpenMode,
  titleHint?: string | null,
): Promise<boolean> {
  if (!taskId) return false;
  const base = `/tasks?projectId=${encodeURIComponent(projectId ?? '')}&archived=false&limit=500`;
  const urls = titleHint ? [`${base}&keyword=${encodeURIComponent(titleHint)}`, base] : [base];
  for (const url of urls) {
    try {
      const list = await api.get<Task[]>(url);
      const hit = Array.isArray(list) ? list.find((t) => t.id === taskId) : undefined;
      if (hit) {
        applyFocus(hit, hit.task_no ?? '', open);
        return true;
      }
    } catch { /* 单条查询失败换下一条兜底，全部失败返回 false 由调用方提示 */ }
  }
  return false;
}

/**
 * 按 task_no 定位任务：拉取该任务的 id/项目/状态，写齐 focusId(uuid)/focusProjectId/focusTab/activeTab/search
 * 五个会话键后切到任务页；任务页据此先切到所属项目、清过滤、切 tab，再滚动高亮目标行。
 * 解析失败（任务已删/网络异常）时退化为「仅带搜索编号跳转」，至少让用户落到任务页可自行检索。
 *
 * T01568：第二形参从 `openDrawer: boolean` 扩展为 `boolean | FocusOpenMode`——
 * 传标签页名（就绪条传 'desc'）或 'notice'（通知类入口自动落位）时，抽屉打开即落在该页；
 * 传 true 沿用 T01562 行为落 'desc'；传 falsy（默认）时保持「仅定位行 + 行内高亮」，旧口径不受影响。
 * 注意 focusDrawerTab 与 focusDrawerId 成对写入：只清 id 不清 tab 会让下一次手动开抽屉读到上次的落位。
 */
export async function focusTaskByNo(
  taskNo: string | null | undefined,
  open?: boolean | FocusOpenMode,
): Promise<void> {
  if (!taskNo) { navigateToTasks(); return; }
  try {
    const t = await api.get<Task>(`/tasks/by-no/${encodeURIComponent(taskNo)}`);
    if (!t || !t.id) throw new Error('empty');
    applyFocus(t, taskNo, open);
  } catch {
    setSessionState('tasks.search', taskNo);
    dispatchFocus({ taskNo });
    navigateToTasks();
  }
}
