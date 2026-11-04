/**
 * T04140（PRD §3.1 / MEM-102）：四型记忆分类单源。
 *
 * 对齐 Claude 的 user / feedback / project / reference 分类。DDL 的 CHECK 约束、
 * 抽取提示词、前端徽标与筛选都必须引用本模块，避免各处各写一份字面量导致漂移。
 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 管理页/筛选器的中文展示名（单源，避免各页面自行翻译） */
export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  user: '用户偏好',
  feedback: '反馈纠正',
  project: '项目事实',
  reference: '外部参考',
};

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}
