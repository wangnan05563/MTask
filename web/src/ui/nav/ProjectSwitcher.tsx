/**
 * T06329 顶栏项目/工作区切换器：常驻显示当前作用域，键盘可选择，切换后各页面订阅同一全局值。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { INBOX_PROJECT_ID, INBOX_PROJECT_LABEL, refreshProjectList, useProjectList } from '../projectList';
import { sortProjects } from '../projectOrder';
import { useTasksProjectSort } from '../tasksProjectSort';
import { CopyButton } from '../CopyButton';
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

/** T06403：项目徽标沿用任务页口径——红=待办、蓝=未验证；仅数字，悬浮与读屏补全文。 */
function ProjectBadges({ todo, unverified, scopeName }: {
  readonly todo: number;
  readonly unverified: number;
  readonly scopeName: string;
}) {
  return (
    <span className="mt-project-badges" aria-hidden="true">
      <span className="mt-project-badge mt-project-badge--todo" title={`${scopeName}待办 ${todo} 条`}>{todo}</span>
      <span className="mt-project-badge mt-project-badge--unverified" title={`${scopeName}未验证 ${unverified} 条`}>{unverified}</span>
    </span>
  );
}

export function ProjectSwitcher() {
  // 收集箱从菜单承接后，顶栏仍保留一个常驻作用域；项目列表不把它当普通项目，
  // 但切换器需要它的计数与名称，故这里取全量列表后再做展示层改名/分流。
  const { projects, phase, error, retry } = useProjectList();
  const [projectId, setProjectId] = useActiveProject();
  const [sortMode] = useTasksProjectSort(); // T06408：顶栏项目排序与切换器列表共用同一偏好
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const displayProjects = useMemo(
    () => projects.map((p) => (p.id === INBOX_PROJECT_ID ? { ...p, name: INBOX_PROJECT_LABEL } : p)),
    [projects],
  );
  const sortedProjects = useMemo(
    () => sortProjects(displayProjects.filter((p) => p.id !== INBOX_PROJECT_ID), sortMode),
    [displayProjects, sortMode],
  );
  const options = useMemo(
    () => [
      { id: '', name: '全部项目' },
      { id: INBOX_PROJECT_ID, name: INBOX_PROJECT_LABEL },
      ...sortedProjects.map((p) => ({ id: p.id, name: p.name })),
    ],
    [sortedProjects],
  );
  // 首屏项目列表未返回时不要把仍未解析的 ID 误报为“项目已删除”。
  const label = projectId === INBOX_PROJECT_ID
    ? INBOX_PROJECT_LABEL
    : projectId && projects.length === 0
      ? (phase === 'loading' ? '项目列表加载中…' : phase === 'error' ? '项目列表加载失败' : activeProjectLabel(projectId, displayProjects))
      : activeProjectLabel(projectId, displayProjects);

  const currentProject = projectId ? displayProjects.find((p) => p.id === projectId) : undefined;
  const allTodo = useMemo(() => displayProjects.reduce((sum, p) => sum + (p.todo_count ?? 0), 0), [displayProjects]);
  const allUnverified = useMemo(() => displayProjects.reduce((sum, p) => sum + (p.unverified_count ?? 0), 0), [displayProjects]);
  // 全部项目取合计；具体项目取自身计数。列表尚未就绪时不展示 0/0，避免把“加载中”误报成空。
  const counts = projectId
    ? (currentProject ? { todo: currentProject.todo_count ?? 0, unverified: currentProject.unverified_count ?? 0 } : null)
    : (projects.length > 0 ? { todo: allTodo, unverified: allUnverified } : null);

  const refreshAtRef = useRef(0);
  const refreshCounts = useCallback(() => {
    const now = Date.now();
    if (now - refreshAtRef.current < 800) return;
    refreshAtRef.current = now;
    void refreshProjectList();
  }, []);

  const openMenu = useCallback(() => {
    setOpen(true);
    refreshCounts();
  }, [refreshCounts]);

  const toggleMenu = useCallback(() => {
    if (open) setOpen(false);
    else openMenu();
  }, [open, openMenu]);

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
  }, [open, projectId, projects.length, sortMode, close]);

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
        aria-label={`当前项目/工作区：${label}${counts ? `，待办 ${counts.todo} 条，未验证 ${counts.unverified} 条` : ''}`}
        title={`当前项目/工作区：${label}${counts ? `；待办 ${counts.todo} 条，未验证 ${counts.unverified} 条` : ''}；点击切换`}
        onClick={toggleMenu}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        <FolderIcon />
        <span className="mt-project-switcher-label">{label}</span>
        {counts && <ProjectBadges todo={counts.todo} unverified={counts.unverified} scopeName={label} />}
        <ChevronIcon open={open} />
      </button>
      {/* T06403：复制按钮与切换按钮做兄弟节点——HTML 不允许按钮套按钮；点击只复制，不展开下拉。 */}
      <span className="mt-project-copy" data-t06403="project-copy">
        <CopyButton
          getText={() => label}
          title="复制项目名称"
          ariaLabel={`复制项目名称：${label}`}
          size={12}
          style={{ padding: '4px 7px', borderRadius: '0 6px 6px 0', background: 'transparent', border: 'none', color: 'var(--text-muted)' }}
        />
      </span>
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
          {options.map((o, index) => {
            const optionProject = o.id ? displayProjects.find((p) => p.id === o.id) : undefined;
            const optionTodo = o.id ? (optionProject?.todo_count ?? 0) : allTodo;
            const optionUnverified = o.id ? (optionProject?.unverified_count ?? 0) : allUnverified;
            return (
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
                aria-label={`${o.name}，待办 ${optionTodo} 条，未验证 ${optionUnverified} 条`}
                title={`${o.name}：待办 ${optionTodo} 条，未验证 ${optionUnverified} 条`}
              >
                <span className="mt-project-option-name">{o.name}</span>
                <span className="mt-project-option-meta">
                  <ProjectBadges todo={optionTodo} unverified={optionUnverified} scopeName={o.name} />
                  {o.id === projectId && <CheckIcon />}
                </span>
              </button>
            );
          })}
          {projects.filter((p) => p.id !== INBOX_PROJECT_ID).length === 0 && phase === 'ready' && (
            <output className="mt-project-menu-hint">暂无项目；可直接使用收集箱，或在任务菜单新建项目。</output>
          )}
        </div>
      )}
    </div>
  );
}
