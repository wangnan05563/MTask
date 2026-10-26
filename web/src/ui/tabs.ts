import { Activity, Boxes, CalendarRange, Lightbulb, ListOrdered, ListTodo, ScrollText, Settings, Sparkles, type LucideIcon } from 'lucide-react';

/**
 * T03184（PM-102）：一级导航单源。
 *
 * 顶部导航（App.tsx）与命令面板的页面直达列表都从这里生成——此前面板各自维护一份
 * 8 项列表，漏了「执行会话」且把「项目管理」写成「项目计划」，用户按导航名称搜不到。
 */

export type Tab = 'tasks' | 'aitools' | 'prompts' | 'req' | 'plan' | 'queue' | 'report' | 'exec-sessions' | 'settings';

export const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'tasks', label: '任务', icon: ListTodo },
  { key: 'aitools', label: '模型', icon: Boxes },
  { key: 'prompts', label: '提示词', icon: ScrollText },
  { key: 'req', label: '通用需求', icon: Lightbulb },
  { key: 'plan', label: '项目管理', icon: CalendarRange }, // T00664：更名——后续定位为项目管理模块
  // T01154：仪表盘入口迁至「设置 → 仪表盘」（通用设置之后），顶部菜单不再占位
  { key: 'report', label: 'AI 工作台', icon: Sparkles }, // T00569：周报改名 AI 工作台（卡片化入口）
  { key: 'queue', label: '队列', icon: ListOrdered },
  { key: 'exec-sessions', label: '执行会话', icon: Activity }, // T01271-FR1.4：外部平台执行会话观测面板
  { key: 'settings', label: '设置', icon: Settings },
];
