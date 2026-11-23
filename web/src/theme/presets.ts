/**
 * T06290：主题/强调色预设的单源定义。
 *
 * 这些十六进制值是「可供用户选择的主题数据」，不是页面 UI 的硬编码色；
 * 从 SettingsPage 抽出后，核心页面扫描只检查页面内联样式，设计预设集中在此维护。
 */
export const DEFAULT_ACCENT = '#2563eb';

/** T01060-FR4.1：强调色预设色板（与主题内置 accent 同源的六色系） */
export const ACCENT_PRESETS = ['#2563eb', '#0891b2', '#16a34a', '#7c3aed', '#ea580c', '#dc2626'];

/** T01068-FR4.3：主题预设库——主题 + 强调色的开箱组合 */
export const THEME_PRESETS: Array<{ label: string; theme: 'light' | 'dark' | 'auto'; accent: string }> = [
  { label: '默认浅色', theme: 'light', accent: '' },
  { label: '默认深色', theme: 'dark', accent: '' },
  { label: '海洋', theme: 'dark', accent: '#0891b2' },
  { label: '北欧', theme: 'dark', accent: '#5eead4' },
  { label: '日暮', theme: 'light', accent: '#ea580c' },
  { label: '玫瑰', theme: 'light', accent: '#e11d48' },
];
