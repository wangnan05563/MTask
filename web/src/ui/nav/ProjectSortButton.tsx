/**
 * T06408：项目排序入口从任务工具条迁移到框架顶栏，紧跟「当前项目/工作区」切换器。
 * 复用 projectOrder 的排序模式与排序逻辑，菜单键盘可达，点击外部/Esc 收起。
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUpDown, Check } from 'lucide-react';
import { PROJ_SORT_LABEL, PROJ_SORT_OPTIONS } from '../projectOrder';
import { useTasksProjectSort } from '../tasksProjectSort';

const MENU_ID = 'mt-project-sort-menu';

export function ProjectSortButton() {
  const [mode, setMode] = useTasksProjectSort();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = Math.max(0, PROJ_SORT_OPTIONS.findIndex((option) => option.key === mode));

  const focusItem = (index: number) => {
    const next = Math.max(0, Math.min(PROJ_SORT_OPTIONS.length - 1, index));
    setCursor(next);
    itemRefs.current[next]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // 打开菜单即把焦点放到当前选中项；排序被其他标签页改掉时也跟着重定位，避免焦点停在过期项上。
  useEffect(() => {
    if (!open) return;
    setCursor(selectedIndex);
    itemRefs.current[selectedIndex]?.focus();
  }, [open, selectedIndex]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = PROJ_SORT_OPTIONS.length - 1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(cursor === last ? 0 : cursor + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(cursor === 0 ? last : cursor - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(last);
    } else if (event.key === 'Tab') {
      // 菜单是临时弹层；Tab 离开前先收起，避免弹层失去焦点后仍悬空。
      setOpen(false);
    }
  };

  const currentLabel = PROJ_SORT_LABEL(mode);

  return (
    <div className="mt-project-sort" ref={rootRef} data-t06408-sort="topbar">
      <button
        ref={triggerRef}
        type="button"
        className="mt-project-sort-button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) setOpen(true);
            else focusItem(selectedIndex);
          }
        }}
        aria-label="项目排序"
        aria-haspopup="menu"
        aria-controls={open ? MENU_ID : undefined}
        aria-expanded={open}
        title={`项目排序 — 当前：${currentLabel}`}
        data-t06408-sort-trigger
      >
        <ArrowUpDown size={15} />
      </button>
      {open && (
        <div
          id={MENU_ID}
          className="mt-project-sort-menu"
          role="menu"
          aria-label="项目排序方式"
          onKeyDown={onMenuKeyDown}
        >
          {PROJ_SORT_OPTIONS.map((option, index) => (
            <button
              key={option.key}
              ref={(element) => { itemRefs.current[index] = element; }}
              type="button"
              role="menuitemradio"
              aria-checked={mode === option.key}
              tabIndex={index === cursor ? 0 : -1}
              className="mt-project-sort-item"
              title={option.hint}
              onFocus={() => setCursor(index)}
              onClick={() => {
                setMode(option.key);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span className="mt-project-sort-check" aria-hidden="true">
                {mode === option.key ? <Check size={13} /> : null}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
