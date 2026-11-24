/**
 * T06326：Design System Switch 原语。
 * role=switch + aria-checked；支持受控/非受控、label、hint、error、loading。
 */
import { forwardRef, useId, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type SwitchSize = 'sm' | 'md';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onChange' | 'value'> {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly size?: SwitchSize;
  readonly loading?: boolean;
  readonly name?: string;
  readonly value?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    label,
    hint,
    error,
    checked,
    defaultChecked = false,
    onCheckedChange,
    size = 'md',
    loading = false,
    disabled,
    className,
    id,
    name,
    value = 'on',
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const switchId = id ?? `mt-switch-${autoId}`;
  const hintId = hint ? `${switchId}-hint` : undefined;
  const errorId = error ? `${switchId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const [innerChecked, setInnerChecked] = useState(defaultChecked);
  const isChecked = checked ?? innerChecked;
  const isDisabled = Boolean(disabled || loading);

  const toggle = () => {
    if (isDisabled) return;
    const next = !isChecked;
    if (checked === undefined) setInnerChecked(next);
    onCheckedChange?.(next);
  };

  return (
    <div className={['mt-switch', className].filter(Boolean).join(' ')} data-size={size}>
      <button
        {...rest}
        ref={ref}
        id={switchId}
        type="button"
        role="switch"
        className="mt-switch__control"
        aria-checked={isChecked}
        aria-busy={loading || undefined}
        aria-describedby={describedBy}
        aria-errormessage={errorId}
        aria-invalid={error ? true : undefined}
        disabled={isDisabled}
        onClick={toggle}
      >
        <span className="mt-switch__track" aria-hidden="true">
          {loading
            ? <span className="mt-btn__spinner mt-switch__spinner" />
            : <span className="mt-switch__thumb" />}
        </span>
        {label && <span className="mt-switch__label">{label}</span>}
      </button>
      {name && <input type="hidden" name={name} value={isChecked ? value : ''} />}
      {hint && <span className="mt-field__hint" id={hintId}>{hint}</span>}
      {error && <span className="mt-field__error" id={errorId} role="alert">{error}</span>}
    </div>
  );
});

Switch.displayName = 'Switch';
