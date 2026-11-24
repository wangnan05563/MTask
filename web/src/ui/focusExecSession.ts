/**
 * T06296（PRD §A3）：全局搜索结果点击 Run 后，直达执行会话面板并定位到对应卡片。
 *
 * 与 focusTaskByNo 同口径：会话存储负责「页面尚未挂载」的情况，自定义事件负责
 * 「用户本来就停在执行会话页」的情况（setTab 同值不会触发重挂载）。
 */
const KEY = 'execSessions.focusId';

export interface ExecSessionFocusIntent {
  readonly id: string;
  readonly at: number;
}

export function focusExecSession(id: string): void {
  if (!id) return;
  const intent: ExecSessionFocusIntent = { id, at: Date.now() };
  try { sessionStorage.setItem(KEY, JSON.stringify(intent)); } catch { /* 配额异常静默 */ }
  globalThis.dispatchEvent(new CustomEvent('mtaskFocusExecSession', { detail: intent }));
}

/** 页面挂载时消费一次意图；消费后删除，避免刷新反复抢焦点。 */
export function consumeExecSessionFocus(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<ExecSessionFocusIntent>;
    return typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}
