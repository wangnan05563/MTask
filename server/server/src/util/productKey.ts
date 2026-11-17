/**
 * T04132（PRD §3.1 / MEM-101②）：产品标签归一化单源。
 *
 * `product_key` 是记忆的**唯一**隔离边界，「同值即同一产品」，因此任何写入路径都必须
 * 统一 trim + 小写；'' 表示未绑定产品（MEM-302 的空串语义，不是「缺省无作用域」）。
 * 禁止各写入点各自 String()/toLowerCase()，否则 'Wiki' 与 'wiki' 会分裂成两个产品。
 */
export function normalizeProductKey(input: string | null | undefined): string {
  return (input ?? '').trim().toLowerCase();
}

/**
 * 接口入参守卫：允许字符串或 null（清空绑定），其余类型拒绝而非静默转换——
 * 静默转换会把 {} 变成 '[object Object]' 这样的产品标签，污染隔离边界且难以排查。
 */
export function parseProductKeyInput(input: unknown):
  { ok: true; value: string } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, error: 'product_key 必须是字符串或 null' };
  return { ok: true, value: normalizeProductKey(input) };
}
