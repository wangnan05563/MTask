/**
 * 全局设置：主题（浅/深）、字体、字号。
 * - 通过 CSS 变量驱动，`:root` 定义浅色默认值，`[data-theme='dark']` 覆盖为深色值；
 * - 偏好持久化到 localStorage，刷新/重开应用后保留；
 * - 字号档位通过覆盖 `--fs-*` 变量实现，凡使用这些变量的字号都会随之变化。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';
export type FontKey = 'default' | 'mono' | 'kai' | 'song';
export type FontSizeKey = 's' | 'm' | 'l';
/** 备份导入时的冲突处理策略：合并/保留现有/覆盖全部 */
export type ImportMode = 'merge' | 'keep' | 'overwrite';

export interface SettingsPrefs {
  theme: Theme;
  font: FontKey;
  fontSize: FontSizeKey;
}

const PREF_KEY = 'settings.prefs';

const FONT_MAP: Record<FontKey, string> = {
  default: '"system-ui", -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  mono: '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, monospace',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", serif',
  song: '"Songti SC", "NSimSun", "SimSun", serif',
};

/** 各字号档位对 `--fs-*` 变量组的取值：应用内统一字号都在用这些变量 */
const FONT_SIZE_MAP: Record<FontSizeKey, Record<string, string>> = {
  s: { '--fs-s': '11px', '--fs-m': '12px', '--fs-l': '13px', '--fs-xl': '14px', '--fs-title': '18px' },
  m: { '--fs-s': '12px', '--fs-m': '13px', '--fs-l': '14px', '--fs-xl': '15px', '--fs-title': '20px' },
  l: { '--fs-s': '13px', '--fs-m': '14px', '--fs-l': '15px', '--fs-xl': '17px', '--fs-title': '22px' },
};

export const FONT_OPTIONS: { key: FontKey; label: string }[] = [
  { key: 'default', label: '系统默认' },
  { key: 'mono', label: '等宽' },
  { key: 'kai', label: '楷体' },
  { key: 'song', label: '宋体' },
];

export const FONT_SIZE_OPTIONS: { key: FontSizeKey; label: string }[] = [
  { key: 's', label: '小' },
  { key: 'm', label: '中' },
  { key: 'l', label: '大' },
];

const DEFAULTS: SettingsPrefs = { theme: 'light', font: 'default', fontSize: 'm' };

/** 全局 CSS 变量：浅/深两套主题 + 语义色板。所有页面改用这些变量即自动适配主题与字号 */
const themeCss = `
:root, [data-theme='light'] {
  --app-bg: #ffffff;
  --card-bg: #ffffff;
  --surface: #f9fafb;
  --surface-2: #f3f4f6;
  --text: #1f2937;
  --text-secondary: #6b7280;
  --text-muted: #9ca3af;
  --border: #e5e7eb;
  --border-strong: #d1d5db;
  --accent: #2563eb;
  --accent-text: #ffffff;
  --accent-soft: #eff6ff;
  --success: #16a34a;
  --danger: #dc2626;
  --warn: #f59e0b;
  --overlay: rgba(0, 0, 0, 0.35);
  --code-bg: #f1f5f9;
  --code-border: #e2e8f0;
  --markdown-quote: #cbd5e1;
  color-scheme: light;
}
[data-theme='dark'] {
  --app-bg: #18181b;
  --card-bg: #1e1e21;
  --surface: #2a2a2e;
  --surface-2: #27272a;
  --text: #e5e7eb;
  --text-secondary: #a1a1aa;
  --text-muted: #71717a;
  --border: #3f3f46;
  --border-strong: #52525b;
  --accent: #3b82f6;
  --accent-text: #ffffff;
  --accent-soft: #1e293b;
  --success: #22c55e;
  --danger: #ef4444;
  --warn: #fbbf24;
  --overlay: rgba(0, 0, 0, 0.55);
  --code-bg: #27272a;
  --code-border: #3f3f46;
  --markdown-quote: #4b5563;
  color-scheme: dark;
}
`;

function loadPrefs(): SettingsPrefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<SettingsPrefs>) };
    // 防脏数据：主题/字号/字体只在合法枚举内，否则回退默认
    if (!['light', 'dark'].includes(p.theme)) p.theme = DEFAULTS.theme;
    if (!(p.font in FONT_MAP)) p.font = DEFAULTS.font;
    if (!(p.fontSize in FONT_SIZE_MAP)) p.fontSize = DEFAULTS.fontSize;
    return p;
  } catch {
    return DEFAULTS;
  }
}

interface SettingsCtx {
  prefs: SettingsPrefs;
  update: <K extends keyof SettingsPrefs>(key: K, value: SettingsPrefs[K]) => void;
}

const Ctx = createContext<SettingsCtx>({
  prefs: DEFAULTS,
  update: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<SettingsPrefs>(loadPrefs);

  // 偏好变化即持久化 + 应用主题与字体
  useEffect(() => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 忽略配额等写入失败 */ }
    document.documentElement.setAttribute('data-theme', prefs.theme);
    document.documentElement.style.setProperty('--font-family', FONT_MAP[prefs.font]);
    const vars = FONT_SIZE_MAP[prefs.fontSize];
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  }, [prefs]);

  const update: SettingsCtx['update'] = (key, value) =>
    setPrefs((prev) => ({ ...prev, [key]: value }));

  return (
    <Ctx.Provider value={{ prefs, update }}>
      {/* 主题变量在应用根统一注入一次；Markdown 样式另由 MarkdownStyles 注入 */}
      <style>{themeCss}</style>
      {children}
    </Ctx.Provider>
  );
}

export function useSettings(): SettingsCtx {
  return useContext(Ctx);
}