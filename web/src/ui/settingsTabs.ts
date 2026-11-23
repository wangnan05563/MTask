/**
 * T03271（PRD UX-09 / 5.1 设置信息架构）：设置页签单源。
 *
 * 设置页导航与命令面板的「设置」条目都从这里生成——名称只写一次，避免两处各自维护后
 * 出现「导航叫数据维护、面板叫数据库」这类同名不同物的入口（UX-09②）。
 * 分组固定三组（偏好 / 数据 / 运维与诊断），顺序即展示顺序；`keywords` 只用于搜索，
 * 不参与展示，覆盖用户常说但不在标题里的词（如「主题」「备份」「穿透」）。
 *
 * T05771：为分组与页签补开源 lucide 图标；名称按「简短、无歧义、名词性」统一，
 * 对外 key 保持不变，避免深链、持久化页签和命令面板入口失效。
 */
import {
  Archive, ArrowLeftRight, Brain, CircleHelp, Database, History, Info, KeyRound,
  LayoutDashboard, ListPlus, Network, Repeat, ScanLine, ScrollText, Send, Settings2,
  ShieldCheck, SlidersHorizontal, Tags, Wrench, type LucideIcon,
} from 'lucide-react';

export type SettingsTabKey =
  | 'general' | 'help' | 'about'
  | 'dashboard' | 'categories' | 'fields' | 'recurring' | 'history' | 'archive' | 'memory' | 'migration' | 'dbadmin' | 'apitokens' | 'sonar'
  | 'supervisor' | 'dispatch' | 'tunnel' | 'logs';

export interface SettingsTab {
  readonly key: SettingsTabKey;
  readonly label: string;
  /** 开源 lucide 图标；同一套图标库保证尺寸/描边一致 */
  readonly icon: LucideIcon;
  /** 搜索补充词：只影响命中，不影响展示与排序 */
  readonly keywords: readonly string[];
}

export interface SettingsGroup {
  readonly key: 'preference' | 'data' | 'ops';
  readonly label: string;
  readonly icon: LucideIcon;
  readonly tabs: readonly SettingsTab[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    key: 'preference', label: '偏好', icon: SlidersHorizontal,
    tabs: [
      { key: 'general', label: '通用', icon: Settings2, keywords: ['主题', '字号', '语言', '外观', '强调色', '通用设置'] },
      { key: 'help', label: '帮助文档', icon: CircleHelp, keywords: ['文档', '说明', '指南', '帮助'] },
      { key: 'about', label: '关于', icon: Info, keywords: ['版本', '许可', '应用信息', '产品信息'] },
    ],
  },
  {
    key: 'data', label: '数据', icon: Database,
    tabs: [
      { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard, keywords: ['概览', '统计', '指标'] },
      { key: 'categories', label: '任务分类', icon: Tags, keywords: ['分类', '标签', '归类'] },
      { key: 'fields', label: '自定义字段', icon: ListPlus, keywords: ['字段', '属性', '自定义'] },
      { key: 'recurring', label: '循环任务', icon: Repeat, keywords: ['周期', '自动生成'] },
      { key: 'history', label: '历史版本', icon: History, keywords: ['快照', '历史', '版本', '历史资产'] },
      { key: 'archive', label: '归档', icon: Archive, keywords: ['归档', '已归档'] },
      // T04152（PRD MEM-502）：产品维度长期记忆的浏览/编辑/待确认入口
      { key: 'memory', label: '记忆管理', icon: Brain, keywords: ['记忆', 'memory', '产品标签', '待确认', '长期记忆'] },
      { key: 'migration', label: '数据迁移', icon: ArrowLeftRight, keywords: ['导入', '导出', '迁移', '备份'] },
      { key: 'dbadmin', label: '数据库维护', icon: Database, keywords: ['数据库', '清理', '维护', '备份', '数据维护'] },
      { key: 'apitokens', label: 'API 令牌', icon: KeyRound, keywords: ['令牌', '凭据', '接口', 'token', 'API Token'] },
      // T03371（八期 §3.4.1）：SonarQube 环境配置页，PRD 要求紧接「API Token」之后
      { key: 'sonar', label: 'SonarQube', icon: ScanLine, keywords: ['sonar', '质量扫描', '扫描器', '服务器地址', 'projectKey', 'java', 'token'] },
    ],
  },
  {
    key: 'ops', label: '运维与诊断', icon: Wrench,
    tabs: [
      { key: 'supervisor', label: '监督与审计', icon: ShieldCheck, keywords: ['监督', '审计', '熔断', '队列', '监督审计'] },
      { key: 'dispatch', label: '派发策略', icon: Send, keywords: ['派发', '推送', '自动派发', 'B0', 'CodeBuddy', '网关', '冷却', '候选'] },
      { key: 'tunnel', label: '内网穿透', icon: Network, keywords: ['穿透', '隧道', '外网'] },
      { key: 'logs', label: '日志', icon: ScrollText, keywords: ['日志', '排障', '诊断'] },
    ],
  },
];

export const SETTINGS_TABS: readonly SettingsTab[] = SETTINGS_GROUPS.flatMap((g) => g.tabs);

export const SETTINGS_TAB_LABELS: Readonly<Record<SettingsTabKey, string>> = Object.fromEntries(
  SETTINGS_TABS.map((t) => [t.key, t.label]),
) as Record<SettingsTabKey, string>;

export const SETTINGS_TAB_KEYS: readonly SettingsTabKey[] = SETTINGS_TABS.map((t) => t.key);

/** 脏值兜底：老版本遗留的 key（已被删除的页签）不能让设置页渲染成空白 */
export function normalizeSettingsTab(raw: string | null | undefined): SettingsTabKey {
  return SETTINGS_TAB_KEYS.includes(raw as SettingsTabKey) ? (raw as SettingsTabKey) : 'general';
}

/** 按「标题 + 搜索补充词」过滤；大小写不敏感（API Token 这类英文标题也能用小写命中） */
export function matchesSettingsTab(tab: SettingsTab, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return tab.label.toLowerCase().includes(q) || tab.keywords.some((k) => k.toLowerCase().includes(q));
}

/** 过滤后仍保序、保留分组；空分组不返回（导航不出现只有标题的空组） */
export function filterSettingsGroups(query: string): Array<{ key: SettingsGroup['key']; label: string; icon: LucideIcon; tabs: SettingsTab[] }> {
  return SETTINGS_GROUPS
    .map((g) => ({ ...g, tabs: g.tabs.filter((t) => matchesSettingsTab(t, query)) }))
    .filter((g) => g.tabs.length > 0);
}

/** 设置页签的写入口径单源：与 usePersistentState('settings.tab') 同键同格式（JSON） */
export const SETTINGS_TAB_STORAGE_KEY = 'settings.tab';

/** 命令面板直达：写持久层 + 派发事件——面板点选时设置页可能已挂载，只写存储不会重渲染 */
export function focusSettingsTab(key: SettingsTabKey): void {
  const tab = normalizeSettingsTab(key);
  try { localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, JSON.stringify(tab)); } catch { /* 配额异常静默 */ }
  globalThis.dispatchEvent(new CustomEvent('mtaskSettingsTab', { detail: { key: tab } }));
}
