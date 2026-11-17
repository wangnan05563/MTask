import { normalizeProductKey } from './productKey';

/**
 * T04134（PRD §3.1 作用域解析规则 / C4 / MEM-301 / MEM-302）：记忆查询作用域单源。
 *
 * 两种语义**不可混淆**，这是 v1.2·F4 修订的核心判据：
 *  ① 完全未提供 `productKey` 参数 ⇒ C4 报错，拒绝无作用域的全局检索（防跨产品串扰）；
 *  ② 解析后 `product_key` 为空串（项目未绑产品）⇒ 返回空集 + hint，调用方回 HTTP 200，
 *     **不报错**——Agent 拿到报错会误判为故障；空串是「显式绑定到无产品」，不是「缺省无作用域」。
 */

/** ① 完全未提供作用域参数 */
export const MEMORY_SCOPE_MISSING_ERROR = 'C4：缺少 productKey / projectId，拒绝无作用域全局检索';
/** ② 项目未绑定产品标签时的提示文案（MEM-302 的 hint 字段值） */
export const MEMORY_UNBOUND_HINT = '该项目未绑定产品标签';

export interface MemoryScopeInput {
  /** 显式产品标签；undefined＝参数完全未提供（与空串语义不同） */
  productKey?: unknown;
  /** 可选项目子作用域；只传它时经 lookupProductKey 解析产品标签 */
  projectId?: string;
  /** 项目 id → projects.product_key；null＝项目不存在。由调用方注入（MCP 侧先走 resolveProjectIdOf） */
  lookupProductKey?: (projectId: string) => string | null;
}

export type MemoryScope =
  | { kind: 'ok'; productKey: string; projectId?: string }
  | { kind: 'empty'; hint: string }
  | { kind: 'error'; error: string };

/** 解析记忆查询作用域。纯函数，不碰 DB；查库能力由 lookupProductKey 注入，便于 MCP/REST 共用与单测。 */
export function resolveMemoryScope(input: MemoryScopeInput): MemoryScope {
  const { productKey, projectId, lookupProductKey } = input;
  if (productKey === undefined && !projectId) {
    return { kind: 'error', error: MEMORY_SCOPE_MISSING_ERROR };
  }
  let raw: unknown = productKey;
  if (raw === undefined) {
    if (!lookupProductKey) return { kind: 'error', error: MEMORY_SCOPE_MISSING_ERROR };
    const found = lookupProductKey(projectId as string);
    if (found === null) return { kind: 'error', error: `项目 id 不存在：${projectId}` };
    raw = found;
  }
  if (raw !== null && typeof raw !== 'string') {
    return { kind: 'error', error: 'productKey 必须是字符串或 null' };
  }
  const normalized = normalizeProductKey(raw as string | null | undefined);
  if (!normalized) return { kind: 'empty', hint: MEMORY_UNBOUND_HINT };
  return { kind: 'ok', productKey: normalized, projectId };
}

export type ActiveMemoryScope = Extract<MemoryScope, { kind: 'ok' }>;

/**
 * MEM-301：所有记忆查询**必须**经此函数拼 WHERE，保证 `product_key = ?` 永远在场；
 * 有项目子作用域时合并「产品级共享（NULL）+ 本期特有」；已失效行（INVALIDATE）默认不召回。
 */
export function buildMemoryScopeWhere(
  scope: ActiveMemoryScope,
  opts: { includeInvalidated?: boolean } = {},
): { sql: string; params: unknown[] } {
  const clauses = ['product_key = ?'];
  const params: unknown[] = [scope.productKey];
  if (scope.projectId) {
    clauses.push('(project_id IS NULL OR project_id = ?)');
    params.push(scope.projectId);
  }
  if (!opts.includeInvalidated) clauses.push('invalidated_at IS NULL');
  return { sql: clauses.join(' AND '), params };
}
