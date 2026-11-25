/**
 * T06329 顶栏项目/工作区切换器：常驻显示当前作用域，键盘可选择，切换后各页面订阅同一全局值。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useProjectList } from '../projectList';
import { activeProjectLabel, useActiveProject } from '../activeProject';

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={open ? 'is-open' : undefined}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function ProjectSwitcher() {
  const { projects, phase, error, retry } = useProjectList({ excludeInbox: true });
  const [projectId, setProjectId] = useActiveProject();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const options = [{ id: '', name: '全部项目' }, ...projects.map((p) => ({ id: p.id, name: p.name }))];
  // 首屏项目列表未返回时不要把仍未解析的 ID 误报为“项目已删除”。
  const label = projectId && projects.length === 0
    ? (phase === 'loading' ? '项目列表加载中…' : phase === 'error' ? '项目列表加载失败' : activeProjectLabel(projectId, projects))
    : activeProjectLabel(projectId, projects);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    setCursor(Math.max(0, options.findIndex((o) => o.id === projectId)));
    return () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, projectId, projects.length, close]);

  useEffect(() => {
    if (open) optionRefs.current[cursor]?.focus();
  }, [open, cursor]);

  const select = (id: string) => {
    setProjectId(id);
    close();
  };

  const onListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? Math.min(options.length - 1, cursor + 1)
        : Math.max(0, cursor - 1);
      setCursor(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const option = options[cursor];
      if (option) select(option.id);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setCursor(e.key === 'Home' ? 0 : options.length - 1);
    }
  };

  return (
    <div className="mt-project-switcher" ref={rootRef} data-project-switcher>
      <button
        ref={buttonRef}
        type="button"
        className="mt-project-switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`当前项目/工作区：${label}`}
        title={`当前项目/工作区：${label}；点击切换`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <FolderIcon />
        <span className="mt-project-switcher-label">{label}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div
          className="mt-project-menu"
          role="listbox"
          aria-label="选择项目/工作区"
          onKeyDown={onListKeyDown}
        >
          {phase === 'loading' && projects.length === 0 && (
            <output className="mt-project-menu-hint">项目列表加载中…</output>
          )}
          {phase === 'error' && (
            <div className="mt-project-menu-hint">
              <span>项目列表加载失败：{error}</span>
              <button type="button" onClick={() => retry()}>重试</button>
            </div>
          )}
          {options.map((o, index) => (
            <button
              key={o.id || '__all__'}
              ref={(el) => { optionRefs.current[index] = el; }}
              type="button"
              role="option"
              aria-selected={o.id === projectId}
              tabIndex={-1}
              className="mt-project-option"
              onMouseEnter={() => setCursor(index)}
              onClick={() => select(o.id)}
            >
              <span className="mt-project-option-name">{o.name}</span>
              {o.id === projectId && <CheckIcon />}
            </button>
          ))}
          {projects.length === 0 && phase === 'ready' && (
            <output className="mt-project-menu-hint">暂无项目；可在任务菜单新建项目。</output>
          )}
        </div>
      )}
    </div>
  );
}
