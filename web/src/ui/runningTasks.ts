/**
 * T00840：应用关闭前的「运行中任务」查询与清理桥。
 *
 * 桌面壳（Electron 主进程）在用户关闭窗口时，通过 executeJavaScript 调用这里暴露到
 * window 的两个函数，获取/清理当前运行中的任务。因为 AI 周报/PRD 生成/PRD 导入这类
 * 运行态只存在于渲染进程的内存 store（不在 DB），后端无法感知，必须由渲染进程汇总：
 *   内存流（reportStream / prdGenStore / aiImportStore） + 后端持久化运行态
 *   （console_jobs busy / queue_jobs 在途）。
 */
import { reportStream } from '../reportStream';
import { prdGenStore } from '../stores/prdGenStore';
import { aiImportStore } from '../stores/aiImportStore';
import { api } from '../api/client';

/** 一个「正在运行」的任务（用于弹框列出名称） */
export interface RunningTask {
  id?: string;
  name: string;
  kind: 'stream' | 'console' | 'queue';
}

/** 汇总当前所有运行中任务：内存流优先，后端持久化运行态兜底。取不到后端时仅返回内存流。 */
export async function snapshotRunningTasks(): Promise<RunningTask[]> {
  const out: RunningTask[] = [];
  const seen = new Set<string>();
  const push = (t: RunningTask) => {
    if (seen.has(t.name)) return;
    seen.add(t.name);
    out.push(t);
  };

  // 内存流运行态（只在渲染进程内存，后端无记录）
  const rs = reportStream.get();
  if (rs.streaming) push({ name: 'AI 周报（生成中）', kind: 'stream' });
  const ps = prdGenStore.get();
  if (ps.streaming) push({ name: '原始需求生成 PRD（生成中）', kind: 'stream' });
  const as = aiImportStore.getSnapshot();
  if (as.busy) push({ name: `${aiImportStore.label()}（执行中）`, kind: 'stream' });

  // 后端持久化运行态：AI 控制台手动分析 + 后台队列任务
  try {
    const { tasks } = await api.get<{ tasks: RunningTask[] }>('/runtime/running-tasks');
    for (const t of tasks) push({ id: t.id, name: t.name, kind: t.kind });
  } catch {
    // 后端不可用：仅返回内存流；此时列表可能不全，但关闭提示仍尽力而为
  }
  return out;
}

/** 强制关闭前的运行态清理：请后端删除 busy 记录、复位在途队列，避免下次启动遗留“挂起”任务。 */
export async function cleanupRunningTasks(): Promise<void> {
  try {
    await api.post('/runtime/running-tasks/cleanup');
  } catch {
    // 尽力清理；失败不阻塞关闭（应用即将退出，由后端兜底）
  }
}

// 暴露给桌面主进程：启动一次即挂载全局，供关闭前 executeJavaScript 调用。
// 仅在 Electron 壳（api:// 协议）下需要；浏览器直接关闭无此机制。
if (typeof window !== 'undefined' && !/^https?:$/.test(window.location.protocol)) {
  (window as unknown as { __mtaskRunningSnapshot?: typeof snapshotRunningTasks }).__mtaskRunningSnapshot = snapshotRunningTasks;
  (window as unknown as { __mtaskCleanupRunning?: typeof cleanupRunningTasks }).__mtaskCleanupRunning = cleanupRunningTasks;
}