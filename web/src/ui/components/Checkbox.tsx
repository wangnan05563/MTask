/**
 * T06326：Design System Checkbox 原语。
 * 原生 input 驱动状态，视觉层只做盒子/勾选；支持 indeterminate、label、hint、error。
 */
import { forwardRef, useEffect, useId, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

export type CheckboxSize = 'sm' | 'md';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly indeterminate?: boolean;
  readonly size?: CheckboxSize;
  readonly loading?: boolean;
  readonly containerClassName?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    label,
    hint,
    error,
    indeterminate = false,
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
  const inputId = id ?? `mt-checkbox-${autoId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const innerRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const setRefs = (node: HTMLInputElement | null) => {
    innerRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  const isDisabled = Boolean(disabled || loading);

  return (
    <div className={['mt-choice', containerClassName].filter(Boolean).join(' ')} data-size={size}>
      <label className="mt-choice__row" htmlFor={inputId} data-disabled={isDisabled || undefined}>
        <span className="mt-choice__box" aria-hidden="true">
          <input
            {...rest}
            ref={setRefs}
            id={inputId}
            type="checkbox"
            className={['mt-choice__input', className].filter(Boolean).join(' ')}
            disabled={isDisabled}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            aria-errormessage={errorId}
          />
          <span className="mt-choice__mark" />
          {loading && <span className="mt-btn__spinner mt-choice__spinner" />}
        </span>
        {label && <span className="mt-choice__label">{label}</span>}
      </label>
      {hint && <span className="mt-field__hint" id={hintId}>{hint}</span>}
      {error && <span className="mt-field__error" id={errorId} role="alert">{error}</span>}
    </div>
  );
});

Checkbox.displayName = 'Checkbox';
