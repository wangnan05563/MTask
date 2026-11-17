import type { ReactNode } from 'react';
import { BTN_PRIMARY, EMPTY_HINT, EMPTY_ICON_PLATE, EMPTY_TITLE, EMPTY_WRAP } from './primitives';

/**
 * T01072-FR1.10：统一空态组件——图标 + 标题 + 提示 + 可选动作按钮。
 * 各列表空数据时统一观感与引导动作（动作直达新建/导入等入口，替代纯文字提示）。
 * PM-302 ①：六类组件里「空态」的单源实现；外壳与动作按钮的样式常量在 ui/primitives.ts。
 */
export function EmptyState({ icon, title, hint, action }: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly hint?: string;
  readonly action?: { label: string; onClick: () => void };
}) {
  return (
    <div style={EMPTY_WRAP}>
      {icon && <div style={EMPTY_ICON_PLATE}>{icon}</div>}
      <div style={EMPTY_TITLE}>{title}</div>
      {hint && <div style={EMPTY_HINT}>{hint}</div>}
      {action && (
        <button
          onClick={action.onClick}
          title={action.label}
          aria-label={action.label}
          style={{ ...BTN_PRIMARY, marginTop: 12 }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
