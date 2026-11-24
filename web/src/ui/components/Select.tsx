/**
 * T06326：Design System Select 原语。
 * 原生 select 的可访问外壳，支持 label / hint / error / size / loading / disabled。
 */
import { forwardRef, useId } from 'react';
import type { ReactNode, SelectHTMLAttributes } from 'react';

export type SelectSize = 'sm' | 'md' | 'lg';

export interface SelectOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly size?: SelectSize;
  readonly loading?: boolean;
  readonly containerClassName?: string;
  readonly selectClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hint,
    error,
    options,
    placeholder,
    size = 'md',
    loading = false,
    containerClassName,
    selectClassName,
    className,
    id,
    disabled,
    required,
    value,
    defaultValue,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? `mt-select-${autoId}`;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const hasPlaceholder = placeholder !== undefined;
  const isDisabled = Boolean(disabled || loading);

  return (
    <div className={['mt-field', containerClassName].filter(Boolean).join(' ')}>
      {label && (
        <label className="mt-field__label" htmlFor={selectId}>
          {label}
          {required && <span className="mt-field__required" aria-hidden="true">*</span>}
        </label>
      )}
      <div
        className="mt-field__control mt-select__control"
        data-size={size}
        data-invalid={error ? 'true' : undefined}
        data-disabled={isDisabled ? 'true' : undefined}
        data-loading={loading ? 'true' : undefined}
      >
        {loading && <span className="mt-btn__spinner" aria-hidden="true" />}
        <select
          {...rest}
          ref={ref}
          id={selectId}
          className={['mt-field__shell', 'mt-select__input', selectClassName, className].filter(Boolean).join(' ')}
          disabled={isDisabled}
          required={required}
          value={value}
          defaultValue={defaultValue ?? (hasPlaceholder ? '' : undefined)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          aria-errormessage={errorId}
          aria-busy={loading || undefined}
        >
          {placeholder !== undefined && (
            <option value="" disabled={required}>{placeholder}</option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="mt-select__chevron" aria-hidden="true" />
      </div>
      {hint && <span className="mt-field__hint" id={hintId}>{hint}</span>}
      {error && <span className="mt-field__error" id={errorId} role="alert">{error}</span>}
    </div>
  );
});

Select.displayName = 'Select';
