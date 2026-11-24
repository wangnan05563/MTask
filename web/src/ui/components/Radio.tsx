/**
 * T06326：Design System Radio 原语。
 * 单个单选项；组请用 fieldset/legend 包裹，错误信息由外层统一管理。
 */
import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

export type RadioSize = 'sm' | 'md';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly size?: RadioSize;
  readonly loading?: boolean;
  readonly containerClassName?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  {
    label,
    hint,
    error,
    size = 'md',
    loading = false,
    containerClassName,
    className,
    id,
    disabled,
    required,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? `mt-radio-${autoId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const isDisabled = Boolean(disabled || loading);

  return (
    <div className={['mt-choice', 'mt-radio', containerClassName].filter(Boolean).join(' ')} data-size={size}>
      <label className="mt-choice__row" htmlFor={inputId} data-disabled={isDisabled || undefined}>
        <span className="mt-choice__box mt-radio__box" aria-hidden="true">
          <input
            {...rest}
            ref={ref}
            id={inputId}
            type="radio"
            className={['mt-choice__input', className].filter(Boolean).join(' ')}
            disabled={isDisabled}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            aria-errormessage={errorId}
          />
          <span className="mt-choice__mark mt-radio__mark" />
          {loading && <span className="mt-btn__spinner mt-choice__spinner" />}
        </span>
        {label && <span className="mt-choice__label">{label}</span>}
      </label>
      {hint && <span className="mt-field__hint" id={hintId}>{hint}</span>}
      {error && <span className="mt-field__error" id={errorId} role="alert">{error}</span>}
    </div>
  );
});

Radio.displayName = 'Radio';
