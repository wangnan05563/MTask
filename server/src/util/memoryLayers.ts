/**
 * T06071（T06068 §9 Phase 0）：记忆分层与权威枚举单源。
 *
 * 旧模型只有 `type/source_kind` 两个维度，无法区分「语义事实 / 情景结论 / 程序规则」，
 * 也无法表达「谁有权改写」。本模块只做枚举、默认映射与合法性校验；落库/查询在
 * MemoryService / MemoryRulesService 内使用，避免三处各写一份字面量。
 */
import type { MemoryType } from './memoryTypes';

export const MEMORY_KINDS = ['semantic', 'episodic', 'procedural'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  semantic: '语义',
  episodic: '情景',
  procedural: '程序',
};

export const MEMORY_SCOPES = ['product', 'project', 'task'] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPES)[number];

export const MEMORY_SCOPE_LABELS: Record<MemoryScopeKind, string> = {
  product: '产品级',
  project: '项目级',
  task: '任务级',
};

export const MEMORY_AUTHORITIES = ['user', 'system', 'tool', 'inferred', 'external'] as const;
export type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];

export const MEMORY_AUTHORITY_LABELS: Record<MemoryAuthority, string> = {
  user: '用户',
  system: '系统',
  tool: '工具',
  inferred: '推断',
  external: '外部',
};

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryScopeKind(value: unknown): value is MemoryScopeKind {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value);
}

export function isMemoryAuthority(value: unknown): value is MemoryAuthority {
  return typeof value === 'string' && (MEMORY_AUTHORITIES as readonly string[]).includes(value);
}

/** 旧 type → 新分层默认映射：reference 是外部语义，project 是任务情景，feedback 是纠正程序。 */
export function defaultMemoryKind(type: MemoryType): MemoryKind {
  if (type === 'project') return 'episodic';
  if (type === 'feedback') return 'procedural';
  return 'semantic';
}

/** 作用域默认：有项目即项目级，否则产品级；task 级只在显式传入时使用。 */
export function defaultMemoryScope(projectId?: string | null): MemoryScopeKind {
  return projectId ? 'project' : 'product';
}

/** 权威默认：用户明说/人工录入 > 工具输出 > 自动抽取 > 推断。 */
export function defaultMemoryAuthority(sourceKind?: string): MemoryAuthority {
  if (sourceKind === 'user_said' || sourceKind === 'manual') return 'user';
  if (sourceKind === 'tool_output') return 'tool';
  if (sourceKind === 'inferred') return 'inferred';
  return 'system';
}

/** 统一收口：非法/缺失值回退默认，绝不把脏值落库。 */
export function normalizeMemoryKind(value: unknown, type: MemoryType): MemoryKind {
  return isMemoryKind(value) ? value : defaultMemoryKind(type);
}

export function normalizeMemoryScope(value: unknown, projectId?: string | null): MemoryScopeKind {
  return isMemoryScopeKind(value) ? value : defaultMemoryScope(projectId);
}

export function normalizeMemoryAuthority(value: unknown, sourceKind?: string): MemoryAuthority {
  return isMemoryAuthority(value) ? value : defaultMemoryAuthority(sourceKind);
}
