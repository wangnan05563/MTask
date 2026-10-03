/**
 * 测试用例枚举单源（T01482 · PRD-测试用例管理 §5.4）。
 *
 * 背景：现项目同类枚举已出现两处口径漂移——`routes/plans.ts` 用 `high/medium/normal/low`，
 * MCP `mtask_update_matrix` 用 `high/urgent/normal/low`。测试用例模块**只允许这一处定义**，
 * service / HTTP 路由 / MCP zod schema / 前端下拉（经 `GET /api/plans/test-cases/meta` 下发）
 * 全部引用本文件，杜绝第三次漂移。
 *
 * 设计要点：
 * - 值数组用 `as const` 派生字面量联合类型，写入前用 {@link pickEnum} 收窄，非法值回落默认项
 *   （不抛错：用例字段来自 AI 生成/批量导入，静默纠正比 500 更可用）。
 * - 中文标签与值同处定义，导出与界面展示共用，避免像 `STATUS_LABEL` 那样在路由里重复硬编码。
 * - 本文件只放常量与纯函数，不 import 数据库层，保证前端可经 meta 接口拿到同一份 JSON。
 */

/** 用例优先级（准则 P3）：P0 最高，按风险驱动分配 */
export const CASE_PRIORITY = ['P0', 'P1', 'P2', 'P3'] as const;
/** 用例类型（准则 P3）：功能/接口/性能/安全/兼容/界面/回归/冒烟 */
export const CASE_TYPE = ['functional', 'api', 'performance', 'security', 'compat', 'ui', 'regression', 'smoke'] as const;
/** 执行方式：手工 / 自动化（本期仅记录方式，不接执行引擎，见 §1.2 非目标） */
export const CASE_METHOD = ['manual', 'automation'] as const;
/** 用例生命周期状态（与 last_result 分离，准则 P1「用例 ≠ 执行结果」） */
export const CASE_STATUS = ['draft', 'review', 'approved', 'deprecated'] as const;
/** 最近一次执行结论（TestRail Passed/Failed/Blocked/Skipped + 未执行） */
export const CASE_RESULT = ['untested', 'pass', 'fail', 'blocked', 'skip'] as const;

export type CasePriority = (typeof CASE_PRIORITY)[number];
export type CaseType = (typeof CASE_TYPE)[number];
export type CaseMethod = (typeof CASE_METHOD)[number];
export type CaseStatus = (typeof CASE_STATUS)[number];
export type CaseResult = (typeof CASE_RESULT)[number];

/** 优先级中文标签：界面下拉、导出表头与 AI prompt 共用 */
export const CASE_PRIORITY_LABEL: Record<CasePriority, string> = {
  P0: 'P0 关键',
  P1: 'P1 高',
  P2: 'P2 中',
  P3: 'P3 低',
};

/** 类型中文标签 */
export const CASE_TYPE_LABEL: Record<CaseType, string> = {
  functional: '功能',
  api: '接口',
  performance: '性能',
  security: '安全',
  compat: '兼容',
  ui: '界面',
  regression: '回归',
  smoke: '冒烟',
};

/** 执行方式中文标签 */
export const CASE_METHOD_LABEL: Record<CaseMethod, string> = {
  manual: '手工',
  automation: '自动化',
};

/** 生命周期状态中文标签 */
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  draft: '草稿',
  review: '待评审',
  approved: '已批准',
  deprecated: '已废弃',
};

/** 执行结果中文标签 */
export const CASE_RESULT_LABEL: Record<CaseResult, string> = {
  untested: '未执行',
  pass: '通过',
  fail: '失败',
  blocked: '阻塞',
  skip: '跳过',
};

/** 各字段默认值（DDL 与新建用例未传字段时保持一致口径） */
export const CASE_DEFAULTS = {
  priority: 'P1' as CasePriority,
  type: 'functional' as CaseType,
  method: 'manual' as CaseMethod,
  status: 'draft' as CaseStatus,
  lastResult: 'untested' as CaseResult,
};

/**
 * `GET /api/plans/test-cases/meta` 的枚举部分：值 + 中文标签成对下发，
 * 前端 select 与导出格式化不再各自硬编码（§6.1，标签映射同源于此）。
 */
export function caseEnumMeta() {
  return {
    priority: CASE_PRIORITY,
    priorityLabel: CASE_PRIORITY_LABEL,
    type: CASE_TYPE,
    typeLabel: CASE_TYPE_LABEL,
    method: CASE_METHOD,
    methodLabel: CASE_METHOD_LABEL,
    status: CASE_STATUS,
    statusLabel: CASE_STATUS_LABEL,
    result: CASE_RESULT,
    resultLabel: CASE_RESULT_LABEL,
    defaults: CASE_DEFAULTS,
  };
}

/**
 * 枚举值收窄：命中取值本身，否则回落 `fallback`（再缺省取该枚举默认值）。
 *
 * 用于 HTTP 层手写校验（§9.1「路由层校验不引入 zod」）与 MCP zod 之外的服务层兜底，
 * 保证脏输入（AI 生成的 `type: 'integration'` 之类）不会写进库形成第四套口径。
 */
export function pickEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}
