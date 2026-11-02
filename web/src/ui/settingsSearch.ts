import { focusSettingsTab } from './settingsTabs';

/**
 * T04099：命令面板「范围外」跳转的搜索意图键。
 * 与页面自身的搜索键（`archive.kw` / `history.kw`）分开：那是「用户在本页上一次的输入」，
 * 这里只是「这一次跳转要预填什么」——读到即删，下次直接进入页面不会残留面板的关键词。
 */
export const SETTINGS_SEARCH_INTENT_KEYS = {
  history: 'history.search',
  archive: 'archive.search',
} as const;

export type SettingsSearchIntentTab = keyof typeof SETTINGS_SEARCH_INTENT_KEYS;

export const SETTINGS_SEARCH_EVENT = 'mtaskSettingsSearch';

export interface SettingsSearchIntentEventDetail {
  readonly key: SettingsSearchIntentTab;
  readonly kw: string;
}

/** 纯读取（不删）：只允许在 useState 初始化器里用——StrictMode 会双跑初始化器，副作用会被执行两次 */
export function peekSettingsSearchIntent(
  tab: SettingsSearchIntentTab,
  storage: Pick<Storage, 'getItem'> | null = safeSession(),
): string {
  if (!storage) return '';
  try {
    const raw = storage.getItem(SETTINGS_SEARCH_INTENT_KEYS[tab]);
    if (raw == null) return '';
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** 读取并消费一次跳转意图：读到即删（放在 effect / 事件回调里，别放进初始化器） */
export function takeSettingsSearchIntent(
  tab: SettingsSearchIntentTab,
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null = safeSession(),
): string {
  if (!storage) return '';
  try {
    const raw = storage.getItem(SETTINGS_SEARCH_INTENT_KEYS[tab]);
    if (raw == null) return '';
    storage.removeItem(SETTINGS_SEARCH_INTENT_KEYS[tab]);
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** 命令面板入口：写意图键（供页面挂载时读取）+ 切页签 + 派发事件（页面已挂载时即时生效） */
export function focusSettingsSearch(tab: SettingsSearchIntentTab, kw: string): void {
  const text = kw.trim();
  try {
    sessionStorage.setItem(SETTINGS_SEARCH_INTENT_KEYS[tab], JSON.stringify(text));
  } catch {
    /* 配额异常静默 */
  }
  focusSettingsTab(tab);
  try {
    globalThis.dispatchEvent(
      new CustomEvent<SettingsSearchIntentEventDetail>(SETTINGS_SEARCH_EVENT, { detail: { key: tab, kw: text } }),
    );
  } catch {
    /* 无 CustomEvent 的运行环境静默 */
  }
}

function safeSession(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
