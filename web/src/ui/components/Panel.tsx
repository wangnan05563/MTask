/**
 * T06326：Design System Panel 原语。
 * 带标题/副标题/工具区/页脚的页面区块；可选折叠，与 Card 的区别是面向页面级分组。
 */
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

export type PanelVariant = 'default' | 'muted' | 'outline';
export type PanelPadding = 'none' | 'sm' | 'md' | 'lg';

export interface PanelProps {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly extra?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly variant?: PanelVariant;
  readonly padding?: PanelPadding;
  readonly collapsible?: boolean;
  readonly defaultCollapsed?: boolean;
  readonly className?: string;
  readonly ariaLabel?: string;
}

export function Panel({
  title,
  subtitle,
  extra,
  footer,
  children,
  variant = 'default',
  padding = 'md',
  collapsible = false,
  defaultCollapsed = false,
  className,
  ariaLabel,
}: PanelProps) {
  const autoId = useId();
  const bodyId = `mt-panel-body-${autoId}`;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const hasHead = title !== undefined || subtitle !== undefined || extra !== undefined || collapsible;

  return (
    <section
      className={['mt-panel', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-padding={padding}
      aria-label={ariaLabel}
    >
      {hasHead && (
        <header className="mt-panel__head">
          <div className="mt-panel__heading">
            {title !== undefined && <h2 className="mt-panel__title">{title}</h2>}
            {subtitle !== undefined && <div className="mt-panel__subtitle">{subtitle}</div>}
          </div>
          {extra !== undefined && <div className="mt-panel__extra">{extra}</div>}
          {collapsible && (
            <button
              type="button"
              className="mt-panel__toggle"
              aria-expanded={!collapsed}
              aria-controls={bodyId}
              aria-label={collapsed ? '展开面板' : '收起面板'}
              onClick={() => setCollapsed((value) => !value)}
            >
              <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            </button>
          )}
        </header>
      )}
      <div className="mt-panel__body" id={bodyId} hidden={collapsed}>{children}</div>
      {footer !== undefined && <footer className="mt-panel__foot" hidden={collapsed}>{footer}</footer>}
    </section>
  );
}
