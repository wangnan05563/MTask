import type { HTMLAttributes, ReactNode } from 'react';

export interface PageBreadcrumb {
  readonly label: string;
  readonly href?: string;
  readonly onClick?: () => void;
}

export interface PageShellProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
}

/** 统一页面容器：外层导航仍可铺满宽屏，页面内容收口到 1440px 阅读宽度。 */
export function PageShell({ children, className, ...rest }: PageShellProps) {
  return (
    <section className={`mt-page-shell${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </section>
  );
}

export interface PageHeaderProps {
  readonly title: string;
  readonly titleId?: string;
  readonly description?: string;
  readonly breadcrumbs?: readonly PageBreadcrumb[];
  /** 每屏最多一个主操作；次操作放 secondaryActions，由调用方保证不重复主操作。 */
  readonly primaryAction?: ReactNode;
  readonly secondaryActions?: ReactNode;
  readonly viewSwitch?: ReactNode;
  readonly className?: string;
  /**
   * T06342：页面外壳的顶部标签已经显示页面名，核心页不再重复渲染面包屑/可见大标题/说明。
   * 仍保留隐藏的 h1 维护读屏与 SEO 语义，只把操作槽留在页头。
   * minimal 下 description/breadcrumbs 会被忽略（保留参数仅为兼容既有调用方）。
   */
  readonly minimal?: boolean;
}

function BreadcrumbItem({ item }: { readonly item: PageBreadcrumb }) {
  if (item.href) {
    return <a className="mt-page-breadcrumb-link" href={item.href}>{item.label}</a>;
  }
  if (item.onClick) {
    return <button type="button" className="mt-page-breadcrumb-link" onClick={item.onClick}>{item.label}</button>;
  }
  return <span className="mt-page-breadcrumb-text">{item.label}</span>;
}

/** 页头规范：面包屑、唯一标题、说明、主/次操作与视图切换同一落位。 */
export function PageHeader({
  title, titleId, description, breadcrumbs = [], primaryAction, secondaryActions, viewSwitch, className, minimal = false,
}: PageHeaderProps) {
  const hasActions = Boolean(primaryAction || secondaryActions || viewSwitch);
  const actions = hasActions ? (
    <div className="mt-page-header-actions">
      {viewSwitch && <div className="mt-page-view-switch">{viewSwitch}</div>}
      {secondaryActions && <div className="mt-page-secondary-actions">{secondaryActions}</div>}
      {primaryAction && <div className="mt-page-primary-action" data-page-primary-action="true">{primaryAction}</div>}
    </div>
  ) : null;

  if (minimal) {
    // T06342：无操作槽时不再渲染空的 header（8px 上内边距 + 8px 下外边距），只保留读屏 h1。
    if (!actions) {
      return <h1 id={titleId} className="mt-page-title-visually-hidden">{title}</h1>;
    }
    return (
      <header className={`mt-page-header mt-page-header--minimal${className ? ` ${className}` : ''}`}>
        <h1 id={titleId} className="mt-page-title-visually-hidden">{title}</h1>
        {actions}
      </header>
    );
  }

  return (
    <header className={`mt-page-header${className ? ` ${className}` : ''}`}>
      <div className="mt-page-header-main">
        {breadcrumbs.length > 0 && (
          <nav className="mt-page-breadcrumbs" aria-label="面包屑">
            {breadcrumbs.map((item, index) => (
              <span key={`${item.label}-${index}`} className="mt-page-breadcrumb-item">
                {index > 0 && <span className="mt-page-breadcrumb-sep" aria-hidden="true">/</span>}
                <BreadcrumbItem item={item} />
              </span>
            ))}
          </nav>
        )}
        <h1 id={titleId} className="mt-page-title">{title}</h1>
        {description && <p className="mt-page-description">{description}</p>}
      </div>
      {actions}
    </header>
  );
}

export interface FilterBarProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  readonly ariaLabel?: string;
  readonly sticky?: boolean;
}

/** 筛选条规范：48px 基线高度、吸顶、窄屏横向滚动，避免挤掉筛选入口。 */
export function FilterBar({ children, ariaLabel = '筛选条', sticky = true, className, ...rest }: FilterBarProps) {
  return (
    <div
      role="search"
      aria-label={ariaLabel}
      className={`mt-page-filter${sticky ? ' mt-page-filter-sticky' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </div>
  );
}
