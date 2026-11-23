/**
 * T06287：Design System Input 原语。
 *
 * 支持 label / hint / error / prefix / suffix / size / disabled / readOnly。
 * 错误态与焦点态由 aria-invalid / :focus-within 驱动；组件不持有业务校验逻辑。
 */
import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly prefix?: ReactNode;
  readonly suffix?: ReactNode;
  readonly size?: InputSize;
  readonly containerClassName?: string;
  readonly inputClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    prefix,
    suffix,
    size = 'md',
    containerClassName,
    inputClassName,
    className,
    id,
    disabled,
    readOnly,
    required,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? `mt-input-${autoId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const classes = ['mt-field__shell', inputClassName].filter(Boolean).join(' ');

  return (
    <div className={['mt-field', containerClassName].filter(Boolean).join(' ')}>
      {label && (
        <label className="mt-field__label" htmlFor={inputId}>
          {label}
          {required && <span className="mt-field__required" aria-hidden="true">*</span>}
        </label>
      )}
      <div
        className="mt-field__control"
        data-size={size}
        data-invalid={error ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-readonly={readOnly ? 'true' : undefined}
      >
        {prefix && <span className="mt-field__affix" aria-hidden="true">{prefix}</span>}
        <input
          {...rest}
          ref={ref}
          id={inputId}
          className={classes}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          aria-errormessage={errorId}
        />
        {suffix && <span className="mt-field__affix" aria-hidden="true">{suffix}</span>}
      </div>
      {hint && <span className="mt-field__hint" id={hintId}>{hint}</span>}
      {error && <span className="mt-field__error" id={errorId} role="alert">{error}</span>}
    </div>
  );
});

Input.displayName = 'Input';
