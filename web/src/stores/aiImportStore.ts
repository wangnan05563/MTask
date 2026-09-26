/**
 * AI 项目计划导入模块级 store（T00569 三轮）：
 * 导入过程状态（文件/草稿/日志/忙碌）提升到模块级——**页面切换不中断、切回即恢复**，
 * 并由 AI 控制台（ReportConsole）以独立 tab 统一输出执行日志（与周报/分析任务并列）。
 *
 * 设计要点：
 * - 状态常驻模块（不随组件卸载销毁）：解析中切页 → 返回后日志与结果仍在；
 * - 日志与草稿仅存内存（会话级语义）——图片/大文本不入 sessionStorage，避免配额问题；
 * - ReportConsole 通过 subscribe 订阅变更并渲染「AI 项目计划导入」tab。
 */
import { loadRun, persistRun, clearRun, type RunStatus } from '../ui/runStatus';

export interface AiImportLog {
  t: string;
  level: 'info' | 'ok' | 'error';
  msg: string;
}

export interface AiImportDraftRow {
  title: string;
  description: string;
  durationDays: number;
  assignee: string;
  status: string;
  startDate: string;
  include: boolean;
  rowKey: string;
}

interface AiImportState {
  /** T00662：当前导入类型——控制台 tab 标题随类型变化（plan=AI 项目计划导入 / prd=从 PRD 导入） */
  kind: 'plan' | 'prd';
  busy: boolean;
  fileName: string;
  error: string;
  logs: AiImportLog[];
  rows: AiImportDraftRow[];
  /** 最近一次保存成功条数（用于控制台摘要展示） */
  lastSaved: number;
  /** T00839：本次执行开始时间戳（ms），供控制台 tab 展示实时耗时与悬停进度；非 busy 时为 undefined */
  startedAt?: number;
  /** T01038：结束后保留的最终耗时（ms） */
  finalElapsed?: number;
  /**
   * T00982：解析结果完成戳（ms）——解析结果写入会话存储后递增。
   * 解析期间切换页面会让面板组件卸载，若解析在卸载之后才完成，已挂载的实例看不到那次 setState；
   * 面板据此戳重新从会话存储载入结果，避免"控制台显示解析完成、结果却一条都没有"。
   */
  parseStamp?: number;
}

const initial: AiImportState = { kind: 'plan', busy: false, fileName: '', error: '', logs: [], rows: [], lastSaved: 0, startedAt: undefined };

// T01038+：kind 随运行态持久化——刷新水合 finalElapsed 后成功徽标才能挂对卡片（plan/prd 两卡片共用本 store）
const KIND_KEY = 'mtask.run.aiimport.kind';
const persistKind = (k: AiImportState['kind']): void => { try { sessionStorage.setItem(KIND_KEY, k); } catch { /* ignore */ } };
const loadKind = (): AiImportState['kind'] | null => { try { return sessionStorage.getItem(KIND_KEY) as AiImportState['kind'] | null; } catch { return null; } };

// T01038：模块初始化时水合刷新前持久化的最终耗时
let state: AiImportState = (() => {
  const base: AiImportState = { ...initial };
  const h = loadRun('aiimport');
  if (h && h.finalElapsed != null) {
    base.finalElapsed = h.finalElapsed;
    const k = loadKind();
    if (k === 'prd' || k === 'plan') base.kind = k;
  }
  return base;
})();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const aiImportStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): AiImportState {
    return state;
  },
  /** 追加一行执行日志（控制台滚动输出） */
  log(msg: string, level: AiImportLog['level'] = 'info'): void {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    state = { ...state, logs: [...state.logs, { t, level, msg }] };
    emit();
  },
  patch(p: Partial<AiImportState>): void {
    const next = { ...state, ...p };
    // T00839：仅在「非忙 → 忙」的瞬时记录起始（同一次执行内的再次置忙不重置）；离开忙态即清空，tab 不再残留时长
    if (p.busy === true && !state.busy) {
      next.startedAt = Date.now();
      next.finalElapsed = undefined;
      persistKind(next.kind);
      persistRun('aiimport', { status: 'running' as RunStatus, startedAt: next.startedAt });
    } else if (p.busy === false) {
      // T01038：离开忙态时由 startedAt 算最终耗时并保留（停止计时但保留最终耗时）
      const finalElapsed = next.startedAt ? Date.now() - next.startedAt : next.finalElapsed;
      next.startedAt = undefined;
      next.finalElapsed = finalElapsed;
      persistRun('aiimport', { status: 'success' as RunStatus, finalElapsed });
    }
    state = next;
    emit();
  },
  setRows(rows: AiImportDraftRow[]): void {
    state = { ...state, rows };
    emit();
  },
  /** 重置执行区（保留面板选择态，如项目由会话级状态承载）。T00662：可指定导入类型。 */
  reset(kind: AiImportState['kind'] = 'plan'): void {
    state = { ...initial, kind };
    persistKind(kind);
    clearRun('aiimport');
    emit();
  },
  /** T00662：控制台 tab 标题（随导入类型变化） */
  label(): string {
    return state.kind === 'prd' ? 'PRD 导入' : 'AI 项目计划导入';
  },
};
