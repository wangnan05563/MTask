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
  /**
   * T00982：解析结果完成戳（ms）——解析结果写入会话存储后递增。
   * 解析期间切换页面会让面板组件卸载，若解析在卸载之后才完成，已挂载的实例看不到那次 setState；
   * 面板据此戳重新从会话存储载入结果，避免"控制台显示解析完成、结果却一条都没有"。
   */
  parseStamp?: number;
}

const initial: AiImportState = { kind: 'plan', busy: false, fileName: '', error: '', logs: [], rows: [], lastSaved: 0 };

let state: AiImportState = { ...initial };
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
    state = { ...state, ...p };
    emit();
  },
  setRows(rows: AiImportDraftRow[]): void {
    state = { ...state, rows };
    emit();
  },
  /** 重置执行区（保留面板选择态，如项目由会话级状态承载）。T00662：可指定导入类型。 */
  reset(kind: AiImportState['kind'] = 'plan'): void {
    state = { ...initial, kind };
    emit();
  },
  /** T00662：控制台 tab 标题（随导入类型变化） */
  label(): string {
    return state.kind === 'prd' ? 'PRD 导入' : 'AI 项目计划导入';
  },
};
