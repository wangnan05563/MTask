/**
 * T06408：项目排序入口从任务工具条迁移到框架顶栏，紧跟「当前项目/工作区」切换器。
 * 复用 projectOrder 的排序模式与排序逻辑，菜单键盘可达，点击外部/Esc 收起。
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUpDown, Check } from 'lucide-react';
import { PROJ_SORT_LABEL, PROJ_SORT_OPTIONS } from '../projectOrder';
import { useTasksProjectSort } from '../tasksProjectSort';

export function ProjectSortButton() {
  const [mode, setMode] = useTasksProjectSort();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

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

  const currentLabel = PROJ_SORT_LABEL(mode);

  return (
    <div className="mt-project-sort" ref={rootRef} data-t06408-sort="topbar">
      <button
        ref={triggerRef}
        type="button"
        className="mt-project-sort-button"
        onClick={() => setOpen((value) => !value)}
        aria-label="项目排序"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`项目排序 — 当前：${currentLabel}`}
        data-t06408-sort-trigger
      >
        <ArrowUpDown size={15} />
      </button>
      {open && (
        <div className="mt-project-sort-menu" role="menu" aria-label="项目排序方式">
          {PROJ_SORT_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={mode === option.key}
              className="mt-project-sort-item"
              title={option.hint}
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
