/**
 * 无类型来源（HTTP query/body、AI 回包、库里的 JSON 列）取文本的统一口径。
 *
 * `String(obj)` 会得到 `[object Object]`：后续比对既不报错也不命中，问题被静默吞掉。
 * 这里对象/函数一律返回 fallback；标量与标量数组（`?ids=a&ids=b` 形态）保持与原
 * `String()` 完全一致的结果，只收窄「不可能被读成文本」的那一类。
 */
export function scalarText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.map((v) => scalarText(v)).join(',');
  const t = typeof value;
  if (t === 'object' || t === 'function') return fallback;
  return String(value);
}
