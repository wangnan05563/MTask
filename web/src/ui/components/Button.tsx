/**
 * T06287：Design System Button 原语。
 *
 * 只负责展示与交互状态（variant / size / loading / disabled），不承载任何业务动作。
 * 颜色只消费 ui/components.css 中的 --mt-component-* / --mt-semantic-*，不直接引用 primitive。
 */
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly loadingText?: ReactNode;
  readonly leftIcon?: ReactNode;
  readonly rightIcon?: ReactNode;
  readonly fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingText,
    leftIcon,
    rightIcon,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const classes = ['mt-btn', className].filter(Boolean).join(' ');

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={classes}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      data-full-width={fullWidth || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="mt-btn__spinner" aria-hidden="true" />}
      {!loading && leftIcon && <span className="mt-btn__icon" aria-hidden="true">{leftIcon}</span>}
      <span className="mt-btn__label">{loading ? (loadingText ?? children) : children}</span>
      {!loading && rightIcon && <span className="mt-btn__icon" aria-hidden="true">{rightIcon}</span>}
    </button>
  );
});

Button.displayName = 'Button';
