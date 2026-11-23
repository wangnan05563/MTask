import { Activity, Boxes, CalendarRange, Home, Lightbulb, ListOrdered, ListTodo, ScrollText, Settings, Sparkles, type LucideIcon } from 'lucide-react';

/**
 * T03184（PM-102）：页面路由单源。
 *
 * 命令面板的页面直达列表、深链合法页签都从这里生成。
 * T06289 起一级导航收敛为 5 个入口，分组关系见 `ui/nav/primaryNav.ts`；
 * 本表保留全部页面键，确保旧链接、命令面板与深链仍能逐页直达。
 */

export type Tab = 'dashboard' | 'tasks' | 'aitools' | 'prompts' | 'req' | 'plan' | 'queue' | 'report' | 'exec-sessions' | 'settings';

export const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'dashboard', label: '首页', icon: Home },
  { key: 'tasks', label: '任务', icon: ListTodo },
  { key: 'aitools', label: '模型', icon: Boxes },
  { key: 'prompts', label: '提示词', icon: ScrollText },
  { key: 'req', label: '通用需求', icon: Lightbulb },
  { key: 'plan', label: '项目管理', icon: CalendarRange }, // T00664：更名——后续定位为项目管理模块
  // T01154：仪表盘入口提升为「首页」；T06289：原 AI 工作台归入「项目 / 报表」
  { key: 'report', label: '报表', icon: Sparkles },
  { key: 'queue', label: '队列', icon: ListOrdered },
  { key: 'exec-sessions', label: '执行会话', icon: Activity }, // T01271-FR1.4：外部平台执行会话观测面板
  { key: 'settings', label: '设置', icon: Settings },
];
