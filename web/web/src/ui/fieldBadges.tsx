/**
 * T03231（PRD PM-203②）：自定义字段值的列表徽标（单源）。
 *
 * 服务端 `decorateRows` 已把非空值随行带出（`display` 已按字段类型翻译成给人看的文本），
 * 这里只做「最多显示 3 个 + 余量计数」的收敛，避免几十个字段把行撑成第二行；
 * 完整清单放 aria-label/title，读屏与悬浮都能拿到全部字段，不必点开抽屉逐条找。
 */
import type { Task } from '../api/client';

const MAX_VISIBLE = 3;

export function fieldBadgesNode(t: Task) {
  const list = t.field_values ?? [];
  if (list.length === 0) return null;
  const full = list.map((v) => `${v.name}：${v.display}`).join('；');
  const shown = list.slice(0, MAX_VISIBLE);
  const rest = list.length - shown.length;
  return (
    <span data-t03231="field-chips" title={`自定义字段：${full}`} aria-label={`自定义字段：${full}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden', flexShrink: 1 }}>
      {shown.map((v) => (
        <span key={v.field_id} data-t03231="field-chip"
          style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', lineHeight: '16px', whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>
          {v.name}：{v.display}
        </span>
      ))}
      {rest > 0 && (
        <span data-t03231="field-chip-rest" style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
          +{rest}
        </span>
      )}
    </span>
  );
}
