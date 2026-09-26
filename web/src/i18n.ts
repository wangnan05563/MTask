/**
 * T01071-FR5.4：多语言（i18n）框架底座——渐进式接入。
 *
 * 设计（渐进式而非一次性全量抽取）：
 *  - `t(key, fallback)`：语言包命中则返回译文，未命中返回 fallback（调用处直接传中文字面量即可）；
 *  - `registerDict`：各页面/模块按需注册自己的键值对（增量接入，未接入页面零改动继续用中文）；
 *  - 语言偏好存 localStorage（settings.lang），设置页可切换；切换后需要刷新页面或重挂载组件生效。
 *
 * 现状：底座 + 英文包骨架（常用动作词）；全站字符串抽取未完成（覆盖率远低于 95% 验收线），
 * 按页面模块逐步迁移（见 T01071 回传「处置说明」）。
 */
export type Lang = 'zh' | 'en';
const LANG_KEY = 'settings.lang';

let current: Lang = (() => {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'en' ? 'en' : 'zh';
  } catch { return 'zh'; }
})();

const listeners = new Set<() => void>();
const dicts: Record<Lang, Record<string, string>> = {
  zh: {},
  en: {
    // 英文包骨架：常用动作/状态词（渐进补充）
    '任务': 'Tasks', '状态': 'Status', '优先级': 'Priority', '分类': 'Category',
    '保存': 'Save', '删除': 'Delete', '编辑': 'Edit', '复制': 'Copy', '归档': 'Archive',
    '导出': 'Export', '导入': 'Import', '刷新': 'Refresh', '重置': 'Reset', '搜索': 'Search',
    '待办': 'To-do', '已完成': 'Done', '搁置': 'Shelved', '项目': 'Project', '设置': 'Settings',
  },
};

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* 忽略 */ }
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 页面/模块按需注册语言包（增量接入入口） */
export function registerDict(l: Lang, map: Record<string, string>): void {
  Object.assign(dicts[l], map);
}

/** 取译文：语言包未命中时回退 fallback（中文调用处直接传中文字面量，零侵入渐进迁移） */
export function t(key: string, fallback?: string): string {
  return dicts[current][key] ?? fallback ?? key;
}
