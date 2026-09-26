/**
 * T01042：AI 工作台「重置」共享逻辑——控制台侧与卡片侧复用同一清空核心（DRY）。
 *
 * 覆盖范围（与 AI 控制台重置按钮等效）：
 *  1. 后端持久化分析任务全清（DELETE /console-jobs）
 *  2. 各能力运行态/产物 store：AI 周报流（reportStream）、原始需求生成 PRD（prdGenStore）、
 *     项目/PRD 导入（aiImportStore）——运行中先中止再重置
 *  3. 关联草稿产物（sessionStorage 产物键；用户偏好如模型选择/周期/格式保留）
 *  4. 广播 CONSOLE_RESET_EVENT——挂载中的 AI 控制台据此同步重置本地状态（任务列表/聚焦 tab/类别）
 *
 * 组件本地 state 不在本模块操作（由调用方/事件监听方自理）；二次确认与加载态属 UI 层，由调用方实现。
 */
import { api } from '../api/client';
import { reportStream } from '../reportStream';
import { prdGenStore } from '../stores/prdGenStore';
import { aiImportStore } from '../stores/aiImportStore';

/** 重置广播事件名：AI 控制台挂载时监听，收到后重置本地 state */
export const CONSOLE_RESET_EVENT = 'mtask:console-reset';

/** 关联草稿产物键（sessionStorage）——仅产物/结论类；用户偏好（模型/周期/格式/模板）不清 */
const ARTIFACT_SESSION_KEYS = [
  'prd-import.project',
  'prd-import.docId',
  'prd-import.reqs', // PrdImportPanel PERSIST_KEYS.reqs
  'prd-import.plans', // PERSIST_KEYS.plans
  'prd-import.sources', // PERSIST_KEYS.sources
  'prdGen.conclusion', // PrdGenPanel PRD_CONCL_KEY
  'plan.showPrd', // PrdGenPanel 联动的 PRD 管理视图开关
] as const;

/** 清空 sessionStorage 产物键（逐键 try/catch，隐私模式等异常不影响其余清理） */
function clearArtifactSession(): void {
  for (const k of ARTIFACT_SESSION_KEYS) {
    try { sessionStorage.removeItem(k); } catch { /* 忽略 */ }
  }
}

/**
 * 重置 AI 工作台产物（控制台任务 + 三能力运行态 + 草稿产物），并广播重置事件。
 * 幂等：无产物时重复调用安全；后端清理失败不阻断本地清理（残留由下次重置兜底，与既有 resetConsole 口径一致）。
 */
export async function resetWorkbenchArtifacts(): Promise<{ ok: boolean; error?: string }> {
  try {
    // 1. 后端持久化分析任务全清（失败不阻断：本地状态照清，残留由下次重置兜底）
    await api.del('/console-jobs').catch(() => { /* 清空失败兜底 */ });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // 2. 各能力 store：运行中先中止（停止进行中的请求/流），再重置为初始态
  try { reportStream.abort(); } catch { /* 幂等 */ }
  try { prdGenStore.abort(); } catch { /* 幂等 */ }
  try { aiImportStore.reset('plan'); } catch { /* 幂等 */ }
  // 3. 草稿产物
  clearArtifactSession();
  // 4. 广播：挂载中的 AI 控制台同步重置本地 state
  try { window.dispatchEvent(new CustomEvent(CONSOLE_RESET_EVENT)); } catch { /* 忽略 */ }
  return { ok: true };
}

/** 二次确认统一文案（控制台侧 / 卡片侧共用基调） */
export const RESET_CONFIRM_CONSOLE = '重置控制台将清空全部分析任务、各能力运行状态与关联草稿产物，不可恢复。确定继续？';
export const RESET_CONFIRM_CARD = '重置将清空控制台任务、该能力的运行状态与关联草稿产物，不可恢复。确定继续？';
