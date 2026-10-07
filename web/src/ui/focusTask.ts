import { api } from '../api/client';

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

/** 解析后需要落地的最小任务信息 */
interface FocusableTask {
  id: string;
  project_id: string;
  status: string;
}

/**
 * 按 task_no 定位任务：拉取该任务的 id/项目/状态，写齐 focusId(uuid)/focusProjectId/focusTab/activeTab/search
 * 五个会话键后切到任务页；任务页据此先切到所属项目、清过滤、切 tab，再滚动高亮目标行。
 * 解析失败（任务已删/网络异常）时退化为「仅带搜索编号跳转」，至少让用户落到任务页可自行检索。
 */
export async function focusTaskByNo(taskNo: string | null | undefined): Promise<void> {
  if (!taskNo) { navigateToTasks(); return; }
  try {
    const t = await api.get<FocusableTask>(`/tasks/by-no/${encodeURIComponent(taskNo)}`);
    if (!t || !t.id) throw new Error('empty');
    const tab = t.status === 'done' ? 'done' : 'todo';
    setSessionState('tasks.focusId', t.id);
    setSessionState('tasks.focusProjectId', t.project_id ?? '');
    setSessionState('tasks.focusTab', tab);
    setSessionState('tasks.activeTab', tab); // tab 与目标行所在列表对齐，保证该行渲染可见
    setSessionState('tasks.search', taskNo);
  } catch {
    setSessionState('tasks.search', taskNo);
  }
  navigateToTasks();
}
