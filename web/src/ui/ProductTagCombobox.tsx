/**
 * T06407：产品标签输入框——带键盘导航的 combobox。
 *
 * 数据源由调用方传入（MTask 没有独立标签字典表，产品标签来自项目 `product_key` 去重）。
 * 输入为空聚焦时展示前 N 个标签；输入后按子串过滤；没有完全匹配时展示“创建”入口。
 * 选择已有标签只回填输入框；创建回调由调用方决定是否立即持久化。
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, Plus } from 'lucide-react';

const SEARCH_DEBOUNCE_MS = 150;
const DEFAULT_MAX_VISIBLE = 8;

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export interface ProductTagComboboxProps {
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
  /** 选中已有标签或创建成功后触发；source 便于“弹窗选择即提交”区分是否已由 onCreate 持久化。 */
  readonly onSelect?: (value: string, source: 'select' | 'create') => void;
  /** 返回 false 表示创建失败，下拉保持打开；不传则不展示创建入口。 */
  readonly onCreate?: (value: string) => boolean | Promise<boolean>;
  readonly inputId?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly maxVisible?: number;
}

export function ProductTagCombobox({
  value,
  options,
  onChange,
  onSelect,
  onCreate,
  inputId,
  placeholder = '如：wiki / mtask',
  ariaLabel = '产品标签',
  disabled = false,
  autoFocus = false,
  maxVisible = DEFAULT_MAX_VISIBLE,
}: ProductTagComboboxProps) {
  const autoId = useId();
  const baseId = inputId ?? `product-tag-${autoId.replace(/:/g, '')}`;
  const listId = `${baseId}-listbox`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const query = normalized(value);
  const trimmed = value.trim();
  const exactMatch = options.some((option) => normalized(option) === query);
  const showCreate = Boolean(onCreate && trimmed && !exactMatch);

  useEffect(() => {
    if (!open) return;
    const timer = globalThis.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    // 统一浮层栈在 document capture 上处理 Esc；dropdown 开在弹窗里时，先于它关闭下拉，
    // 避免一次 Esc 直接把整个产品标签弹窗关掉。
    const onWindowEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onWindowEscape, true);
    return () => window.removeEventListener('keydown', onWindowEscape, true);
  }, [open]);

  useEffect(() => {
    setCursor(0);
    setError('');
  }, [value, debouncedQuery]);

  const matching = useMemo(() => {
    const q = debouncedQuery;
    return options
      .filter((option) => !q || option.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = q && a.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = q && b.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || a.localeCompare(b, 'zh-CN');
      });
  }, [debouncedQuery, options]);
  const visible = matching.slice(0, maxVisible);
  const hiddenCount = Math.max(0, matching.length - visible.length);
  const itemCount = visible.length + (showCreate ? 1 : 0);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) inputRef.current?.focus();
  };

  /** 展开时先用当前值立即过滤，避免聚焦后短暂闪出全部候选；后续键入仍走防抖。 */
  const openMenu = () => {
    setDebouncedQuery(normalized(value));
    setOpen(true);
  };

  const select = (option: string) => {
    onChange(option);
    setOpen(false);
    onSelect?.(option, 'select');
    inputRef.current?.focus();
  };

  const create = async () => {
    if (!onCreate || !trimmed || creating) return;
    setCreating(true);
    setError('');
    try {
      const success = await onCreate(trimmed);
      if (success === false) {
        setError(`创建「${trimmed}」失败，请重试`);
        return;
      }
      onChange(trimmed);
      setOpen(false);
      onSelect?.(trimmed, 'create');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreating(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      if (itemCount === 0) return;
      setCursor((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        return (next + itemCount) % itemCount;
      });
      return;
    }
    if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      if (cursor < visible.length) select(visible[cursor]);
      else if (showCreate) void create();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open || itemCount === 0) return;
      event.preventDefault();
      setCursor(event.key === 'Home' ? 0 : itemCount - 1);
    }
  };

  const optionId = (index: number) => `${baseId}-option-${index}`;

  return (
    <div className="mt-product-tag-combobox" ref={rootRef} data-t06407="product-tag-combobox">
      <div className="mt-product-tag-combobox__field">
        <input
          ref={inputRef}
          id={baseId}
          className="mt-product-tag-combobox__input"
          value={value}
          onChange={(event) => { onChange(event.target.value); setOpen(true); }}
          onFocus={() => openMenu()}
          onClick={() => openMenu()}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && itemCount > 0 ? optionId(cursor) : undefined}
          autoFocus={autoFocus}
          autoComplete="off"
          disabled={disabled}
        />
        <ChevronDown size={13} className="mt-product-tag-combobox__chevron" aria-hidden="true" />
      </div>
      {open && (
        <div className="mt-product-tag-combobox__menu" id={listId} role="listbox" aria-label="产品标签候选">
          {visible.map((option, index) => (
            <button
              key={option}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={normalized(value) === normalized(option)}
              data-active={cursor === index ? 'true' : undefined}
              className="mt-product-tag-combobox__option"
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCursor(index)}
              onClick={() => select(option)}
            >
              <span>{option}</span>
              {normalized(value) === normalized(option) && <span className="mt-product-tag-combobox__check" aria-hidden="true">✓</span>}
            </button>
          ))}
          {showCreate && (
            <button
              id={optionId(visible.length)}
              type="button"
              role="option"
              aria-selected={false}
              data-active={cursor === visible.length ? 'true' : undefined}
              className="mt-product-tag-combobox__option mt-product-tag-combobox__create"
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCursor(visible.length)}
              onClick={() => void create()}
              disabled={creating}
            >
              <Plus size={12} aria-hidden="true" />
              <span>{creating ? `创建「${trimmed}」中…` : `创建「${trimmed}」`}</span>
            </button>
          )}
          {visible.length === 0 && !showCreate && (
            <div className="mt-product-tag-combobox__empty">无匹配标签</div>
          )}
          {hiddenCount > 0 && <div className="mt-product-tag-combobox__hint">还有 {hiddenCount} 个标签，继续输入可缩小范围</div>}
          {error && <div className="mt-product-tag-combobox__error" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
