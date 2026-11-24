/**
 * T06326：Design System Tabs 原语。
 * 方向键 / Home / End 切换，aria-selected + tabpanel；支持受控/非受控与禁用项。
 */
import { useId, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

export type TabsVariant = 'line' | 'pill';
export type TabsSize = 'sm' | 'md';

export interface TabItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly content: ReactNode;
  readonly disabled?: boolean;
  readonly badge?: ReactNode;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (key: string) => void;
  readonly variant?: TabsVariant;
  readonly size?: TabsSize;
  readonly fitted?: boolean;
  readonly ariaLabel?: string;
  readonly className?: string;
}

export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  variant = 'line',
  size = 'md',
  fitted = false,
  ariaLabel = '标签页',
  className,
}: TabsProps) {
  const autoId = useId();
  const firstEnabled = items.find((item) => !item.disabled)?.key ?? '';
  const [innerValue, setInnerValue] = useState(defaultValue ?? firstEnabled);
  const activeKey = value ?? innerValue;
  const active = items.find((item) => item.key === activeKey) ?? items.find((item) => !item.disabled);

  const choose = (key: string) => {
    if (value === undefined) setInnerValue(key);
    onValueChange?.(key);
  };

  const move = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const enabledIndexes = items.map((item, i) => (!item.disabled ? i : -1)).filter((i) => i >= 0);
    if (enabledIndexes.length === 0) return;
    let next = index;
    if (event.key === 'Home') next = enabledIndexes[0];
    else if (event.key === 'End') next = enabledIndexes[enabledIndexes.length - 1];
    else {
      const currentPos = enabledIndexes.indexOf(index);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      next = enabledIndexes[(currentPos + step + enabledIndexes.length) % enabledIndexes.length];
    }
    const key = items[next]?.key;
    if (key) {
      choose(key);
      document.getElementById(`mt-tab-${autoId}-${next}`)?.focus();
    }
  };

  return (
    <div
      className={['mt-tabs', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-size={size}
      data-fitted={fitted || undefined}
    >
      <div className="mt-tabs__list" role="tablist" aria-label={ariaLabel} aria-orientation="horizontal">
        {items.map((item, index) => {
          const selected = active?.key === item.key;
          return (
            <button
              key={item.key}
              id={`mt-tab-${autoId}-${index}`}
              type="button"
              role="tab"
              className="mt-tabs__tab"
              aria-selected={selected}
              aria-controls={`mt-tabpanel-${autoId}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => choose(item.key)}
              onKeyDown={(event) => move(event, index)}
            >
              <span className="mt-tabs__label">{item.label}</span>
              {item.badge !== undefined && <span className="mt-tabs__badge">{item.badge}</span>}
            </button>
          );
        })}
      </div>
      {active && (
        <div
          className="mt-tabs__panel"
          id={`mt-tabpanel-${autoId}`}
          role="tabpanel"
          aria-labelledby={`mt-tab-${autoId}-${items.findIndex((item) => item.key === active.key)}`}
        >
          {active.content}
        </div>
      )}
    </div>
  );
}
