import type { ReactNode } from 'react';

/**
 * T01072-FR1.10：统一空态组件——图标 + 标题 + 提示 + 可选动作按钮。
 * 各列表空数据时统一观感与引导动作（动作直达新建/导入等入口，替代纯文字提示）。
 */
export function EmptyState({ icon, title, hint, action }: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly hint?: string;
  readonly action?: { label: string; onClick: () => void };
}) {
  return (
    <div style={{ padding: 28, textAlign: 'center' }}>
      {icon && (
        <div style={{ marginBottom: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          {icon}
        </div>
      )}
      <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 420, margin: '0 auto' }}>{hint}</div>}
      {action && (
        <button
          onClick={action.onClick}
          title={action.label}
          aria-label={action.label}
          style={{ marginTop: 12, fontSize: 12, padding: '6px 16px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
