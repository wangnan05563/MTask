/**
 * T06287：Card 原语。
 * 只提供容器、标题栏、额外操作位与三档内边距；不承载点击/选中业务逻辑。
 */
import type { HTMLAttributes, ReactNode } from 'react';

export type CardVariant = 'default' | 'muted' | 'accent';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  readonly variant?: CardVariant;
  readonly padding?: CardPadding;
  readonly title?: ReactNode;
  readonly extra?: ReactNode;
}

export function Card({
  variant = 'default',
  padding = 'md',
  title,
  extra,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <section
      {...rest}
      className={['mt-card', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-padding={padding}
    >
      {(title || extra) && (
        <div className="mt-card__head">
          {title && <div className="mt-card__title">{title}</div>}
          {extra && <div className="mt-card__extra">{extra}</div>}
        </div>
      )}
      <div className="mt-card__body">{children}</div>
    </section>
  );
}
