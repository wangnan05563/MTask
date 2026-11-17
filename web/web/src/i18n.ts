/**
 * T01071-FR5.4：多语言（i18n）框架底座——渐进式接入。
 *
 * 设计（渐进式而非一次性全量抽取）：
 *  - `t(key, fallback)`：语言包命中则返回译文，未命中返回 fallback（调用处直接传中文字面量即可）；
 *  - `registerDict`：各页面/模块按需注册自己的键值对（增量接入，未接入页面零改动继续用中文）；
 *  - 语言偏好存 localStorage（settings.lang），设置页可切换；切换后需要刷新页面或重挂载组件生效。
 *
 * 现状：底座 + 术语表（web/src/i18n/terms.ts）+ 覆盖率 CI（scripts/i18n-coverage.mjs）；
 * 全站抽取按菜单逐页推进，当前仅「设置 → 循环任务 / API Token」页签完成迁移（试点页），
 * 其余页面仍是中文字面量（详见 T01071 回传的覆盖率报告）。
 */
import { useEffect, useState } from 'react';
import { TERMS } from './i18n/terms';

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

// T01071 后续：术语表是译法的唯一来源——启动时并入英文包，避免各页面各自造词。
// 术语表优先级低于上面手写的骨架？反之：后注册覆盖先注册，故术语表放在后面，保证「同词同译」。
for (const term of TERMS) {
  dicts.en[term.zh] = term.en;
  // 异形写法也指向同一译法：老页面不改文案也能整体切换，迁移期不会一半英文一半中文
  for (const alias of term.aliases ?? []) dicts.en[alias] = term.en;
}

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

/**
 * T01071 后续：迁移页面用它订阅语言变化并触发重渲染。
 * 没有它，页面内 `t()` 的结果只在首次渲染时求值，切到英文后必须刷新页面才生效——
 * 逐页迁移时每个页面加一行 `useLang()` 即可，比给每个组件套 Provider 轻得多。
 */
export function useLang(): Lang {
  // setter 取名 setLocal 是刻意的：对称的 setLang 会遮蔽模块级导出的 setLang（L50）
  const [lang, setLocal] = useState<Lang>(current); // NOSONAR: 误报，已解构
  useEffect(() => onLangChange(() => setLocal(current)), []);
  return lang;
}

/**
 * T01071 后续：标记「这一串中文是术语键，译文在调用处取」。
 *
 * 场景：表里的中文值（如 `FREQ_LABELS = { daily: '每天' }`）如果直接写字面量，
 * 覆盖率脚本看不到它最终会过 t()（渲染时 `t(FREQ_LABELS[k])`），会误判为未抽取。
 * 用 `term('每天')` 包一层既是给人的说明，也是给 CI 的标记——函数本身原样返回。
 */
export function term(key: string): string {
  return key;
}

/** 页面/模块按需注册语言包（增量接入入口） */
export function registerDict(l: Lang, map: Record<string, string>): void {
  Object.assign(dicts[l], map);
}

/** 取译文：语言包未命中时回退 fallback（中文调用处直接传中文字面量，零侵入渐进迁移） */
export function t(key: string, fallback?: string): string {
  return dicts[current][key] ?? fallback ?? key;
}
