import { CalendarRange, Home, ListTodo, Settings, Sparkles, type LucideIcon } from 'lucide-react';
import type { Tab } from '../tabs';

/**
 * T06289：一级导航单源——按 PRD §C1 从 9 个页签收敛为 5 个入口。
 *
 * 页面路由仍由 `tabs.ts` 的 TABS 维护（命令面板 / 深链需要逐页可直达），
 * 这里只负责“一级入口 + 入口下二级页签”的分组与默认落点。
 */
export type NavGroupKey = 'home' | 'tasks' | 'project' | 'ai' | 'settings';

export interface NavTab {
  readonly key: Tab;
  readonly label: string;
}

export interface NavGroup {
  readonly key: NavGroupKey;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly defaultTab: Tab;
  readonly tabs: readonly NavTab[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'home',
    label: '首页',
    icon: Home,
    defaultTab: 'dashboard',
    tabs: [{ key: 'dashboard', label: '概览' }],
  },
  {
    key: 'tasks',
    label: '任务',
    icon: ListTodo,
    defaultTab: 'tasks',
    tabs: [{ key: 'tasks', label: '任务' }],
  },
  {
    key: 'project',
    label: '项目',
    icon: CalendarRange,
    defaultTab: 'plan',
    tabs: [
      { key: 'plan', label: '计划' },
      { key: 'req', label: '需求' },
      { key: 'report', label: '报表' },
    ],
  },
  {
    key: 'ai',
    label: 'AI 控制台',
    icon: Sparkles,
    defaultTab: 'queue',
    tabs: [
      { key: 'queue', label: '队列' },
      { key: 'exec-sessions', label: '执行会话' },
      { key: 'prompts', label: '提示词' },
      { key: 'aitools', label: '模型' },
    ],
  },
  {
    key: 'settings',
    label: '设置',
    icon: Settings,
    defaultTab: 'settings',
    tabs: [{ key: 'settings', label: '设置' }],
  },
];

/** 当前页面所属的一级入口；未知页签回落到「任务」，避免侧栏无高亮。 */
export function navGroupForTab(tab: Tab): NavGroup {
  return NAV_GROUPS.find((g) => g.tabs.some((t) => t.key === tab)) ?? NAV_GROUPS[1];
}
