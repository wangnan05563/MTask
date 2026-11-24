/**
 * T06297（PRD §A5 / REQ-034）：全局快速捕获浮层。
 *
 * 入口：App 顶栏按钮 + Ctrl/Cmd+Shift+Space（任意页，输入态也可唤起）。
 * 交互：自然语言标记实时解析成可编辑 chips；Enter 保存为任务；保存后 toast 提供一次撤销。
 * 边界：撤销走归档（可恢复、不物理删除）；离线不落本地草稿（本单明确不支持离线保存）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Undo2, X, Zap } from 'lucide-react';
import { api, type Task, type TaskCategory } from '../api/client';
import { loadProjectList, ProjectListHint, useProjectList } from './projectList';
import {
  dueLabelForYmd,
  parseQuickCapture,
  type QuickCapturePriority,
} from './quickCaptureParse';
import './quickCapture.css';

type CaptureToast =
  | { kind: 'saved'; task: Task; message: string }
  | { kind: 'undoing'; task: Task; message: string }
  | { kind: 'undone'; message: string }
  | { kind: 'error'; task?: Task; message: string }
  | null;

const PRIORITIES: Array<{ value: QuickCapturePriority; label: string }> = [
  { value: 'urgent', label: '紧急' },
  { value: 'high', label: '高' },
  { value: 'normal', label: '普通' },
  { value: 'low', label: '低' },
];

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function QuickCapture({ open, onClose }: Props) {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<QuickCapturePriority>('normal');
  const [projectId, setProjectId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [toast, setToast] = useState<CaptureToast>(null);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [categoryError, setCategoryError] = useState('');
  const [defaultProjectId, setDefaultProjectId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const projectList = useProjectList();
  const projects = projectList.projects;

  const parsed = useMemo(
    () => parseQuickCapture(text, { projects, categories }),
    [text, projects, categories],
  );
  const parsedTitle = parsed.title.trim();
  const tokenKinds = useMemo(() => new Set(parsed.tokens.map((t) => t.kind)), [parsed.tokens]);
  const defaultProjectName = projects.find((p) => p.id === defaultProjectId)?.name ?? '';
  const dirty = Boolean(
    text.trim()
    || categoryId
    || dueDate
    || (projectId && projectId !== defaultProjectId)
    || priority !== 'normal',
  );

  async function loadCategories(): Promise<void> {
    setCategoryError('');
    try {
      const list = await api.get<TaskCategory[]>('/task-categories');
      setCategories(Array.isArray(list) ? list : []);
    } catch (e) {
      setCategories([]);
      setCategoryError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    api.get<{ projectId: string }>('/settings/note-project')
      .then((r) => setDefaultProjectId(r.projectId || ''))
      .catch(() => setDefaultProjectId(''));
    void loadCategories();
  }, []);

  // 打开时重置草稿与字段；关闭后把焦点还给唤起前的控件（顶栏按钮/页面输入框）。
  useEffect(() => {
    if (!open) {
      prevFocusRef.current?.focus?.();
      return;
    }
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setText('');
    setPriority('normal');
    setProjectId(defaultProjectId);
    setCategoryId('');
    setDueDate('');
    setError('');
    setDiscardConfirm(false);
    setBusy(false);
    void loadProjectList();
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 默认记事项目可能在浮层打开后才返回；只在当前为空时补入，不覆盖用户手选。
  useEffect(() => {
    if (open && defaultProjectId) setProjectId((cur) => cur || defaultProjectId);
  }, [open, defaultProjectId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (discardConfirm) {
        setDiscardConfirm(false);
        onClose();
      } else if (dirty) {
        setDiscardConfirm(true);
      } else {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dirty, discardConfirm, onClose]);

  useEffect(() => {
    if (!toast || toast.kind === 'undoing') return;
    const ms = toast.kind === 'saved' ? 5500 : 3500;
    const timer = setTimeout(() => setToast(null), ms);
    return () => clearTimeout(timer);
  }, [toast]);

  function applyText(next: string): void {
    setText(next);
    const r = parseQuickCapture(next, { projects, categories });
    if (r.priority) setPriority(r.priority);
    if (r.projectId) setProjectId(r.projectId);
    if (r.categoryId) setCategoryId(r.categoryId);
    if (r.dueDate) setDueDate(r.dueDate);
  }

  /** chip 手工改值：把对应标记从原文摘除，避免下一次输入又把 chip 改回旧解析值。 */
  function stripTokens(kind: 'priority' | 'project' | 'type' | 'date'): void {
    let next = text;
    for (const t of parsed.tokens) {
      if (t.kind === kind) next = next.split(t.raw).join('');
    }
    setText(next.replace(/\s{2,}/g, ' ').trim());
  }

  function changePriority(value: QuickCapturePriority): void {
    stripTokens('priority');
    setPriority(value);
  }

  function changeProject(value: string): void {
    stripTokens('project');
    setProjectId(value);
  }

  function changeCategory(value: string): void {
    stripTokens('type');
    setCategoryId(value);
  }

  function changeDue(value: string): void {
    stripTokens('date');
    setDueDate(value);
  }

  function requestClose(): void {
    if (busy) return;
    if (dirty) {
      setDiscardConfirm(true);
      return;
    }
    onClose();
  }

  function discardAndClose(): void {
    setDiscardConfirm(false);
    setText('');
    setCategoryId('');
    setDueDate('');
    setError('');
    onClose();
  }

  async function save(): Promise<void> {
    if (!parsedTitle || busy) return;
    setBusy(true);
    setError('');
    const description = dueDate ? `⏰ ${dueLabelForYmd(dueDate)}` : undefined;
    try {
      const task = await api.post<Task>('/tasks', {
        title: parsedTitle,
        description,
        priority,
        categoryId: categoryId || undefined,
        projectId: projectId || undefined,
      });
      setToast({ kind: 'saved', task, message: `已捕获 ${task.task_no ?? '任务'}` });
      setText('');
      setCategoryId('');
      setDueDate('');
      setPriority('normal');
      setProjectId(defaultProjectId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo(): Promise<void> {
    if (!toast || !('task' in toast) || !toast.task) return;
    const task = toast.task;
    setToast({ kind: 'undoing', task, message: `正在撤销 ${task.task_no ?? '捕获'}…` });
    try {
      await api.post('/archive', { taskIds: [task.id] });
      setToast({ kind: 'undone', message: `已撤销 ${task.task_no ?? '捕获'}（已移入归档）` });
    } catch (e) {
      setToast({ kind: 'error', task, message: `撤销失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void save();
  }

  if (!open && !toast) return null;

  const canUndo = Boolean(toast && toast.kind !== 'undone' && toast.kind !== 'undoing' && 'task' in toast && toast.task);
  return createPortal(
    <>
      {open && (
        <div
          className="qc-overlay"
          data-capture-root
          role="dialog"
          aria-modal="true"
          aria-label="快速捕获"
          onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}
        >
          <div className="qc-panel" data-capture-panel>
            <header className="qc-head">
              <Zap size={16} style={{ color: 'var(--accent)' }} aria-hidden />
              <span className="qc-title">快速捕获</span>
              <span className="qc-key" title="任意页面唤起">Ctrl/Cmd+Shift+Space</span>
              <button type="button" className="qc-close" onClick={requestClose} aria-label="关闭快速捕获">
                <X size={16} />
              </button>
            </header>

            <div className="qc-body">
              <div className="qc-input-wrap">
                <input
                  ref={inputRef}
                  className="qc-input"
                  data-capture-input
                  value={text}
                  onChange={(e) => applyText(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  aria-label="快速捕获内容"
                  aria-describedby="qc-parse-hint"
                  placeholder="记下一个想法… 支持 @明天 #项目 !紧急 /类型"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {(parsed.tokens.length > 0 || parsed.unresolved.length > 0) && (
                <div className="qc-preview" data-capture-title>
                  将创建：<strong>{parsedTitle || '（还需要一个标题）'}</strong>
                </div>
              )}

              <div className="qc-chips" data-capture-chips>
                <label className="qc-chip" data-capture-chip="priority" data-parsed={tokenKinds.has('priority') ? 'true' : 'false'}>
                  <span className="qc-chip-mark" aria-hidden>!</span>
                  <select value={priority} onChange={(e) => changePriority(e.target.value as QuickCapturePriority)} aria-label="优先级">
                    {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </label>

                <label className="qc-chip" data-capture-chip="project" data-parsed={tokenKinds.has('project') ? 'true' : 'false'}>
                  <span className="qc-chip-mark" aria-hidden>#</span>
                  <select value={projectId} onChange={(e) => changeProject(e.target.value)} aria-label="归属项目">
                    <option value="">默认项目{defaultProjectName ? `（${defaultProjectName}）` : ''}</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    {projectId && !projects.some((p) => p.id === projectId) && <option value={projectId}>当前项目</option>}
                  </select>
                </label>

                <label className="qc-chip" data-capture-chip="type" data-parsed={tokenKinds.has('type') ? 'true' : 'false'}>
                  <span className="qc-chip-mark" aria-hidden>/</span>
                  <select value={categoryId} onChange={(e) => changeCategory(e.target.value)} aria-label="任务类型">
                    <option value="">未设类型</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    {categoryId && !categories.some((c) => c.id === categoryId) && <option value={categoryId}>当前类型</option>}
                  </select>
                </label>

                <label className="qc-chip" data-capture-chip="due" data-parsed={tokenKinds.has('date') ? 'true' : 'false'}>
                  <span className="qc-chip-mark" aria-hidden>@</span>
                  <input type="date" value={dueDate} onChange={(e) => changeDue(e.target.value)} aria-label="截止日期" />
                </label>
              </div>

              <div id="qc-parse-hint" className="qc-parse-line" data-capture-hint data-capture-count={parsed.tokens.length}>
                {parsed.tokens.length > 0 ? (
                  <>
                    <span>已解析 {parsed.tokens.length} 个标记：</span>
                    {parsed.tokens.map((t, i) => (
                      <span key={`${t.kind}-${t.raw}-${i}`} className="qc-token">
                        {t.kind === 'priority' ? '优先级' : t.kind === 'project' ? '项目' : t.kind === 'type' ? '类型' : '日期'}
                      </span>
                    ))}
                  </>
                ) : (
                  <span>支持 @日期、!优先级、#项目、/类型；保存前可直接改下方字段</span>
                )}
                {parsed.unresolved.length > 0 && (
                  <span className="qc-unresolved">
                    未识别：{parsed.unresolved.map((u) => u.raw).join(' ')}（请检查名称）
                  </span>
                )}
                {dueDate && <span className="qc-token">{dueLabelForYmd(dueDate)}</span>}
              </div>

              {categoryError && (
                <div className="qc-error" data-capture-category-error>
                  类型列表加载失败：{categoryError}
                  <button type="button" onClick={() => void loadCategories()} style={{ marginLeft: 8, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>重试</button>
                </div>
              )}

              {projectList.phase === 'error' && (
                <ProjectListHint view={projectList} style={{ marginTop: 8 }} />
              )}

              {error && <div className="qc-error" role="alert" data-capture-error>{error}</div>}

              {discardConfirm && (
                <div className="qc-discard" data-capture-discard>
                  <span>有未保存内容，确定丢弃这次捕获？</span>
                  <button type="button" onClick={() => setDiscardConfirm(false)}>继续编辑</button>
                  <button type="button" className="danger" onClick={discardAndClose} data-capture-discard-confirm>丢弃</button>
                </div>
              )}
            </div>

            <footer className="qc-foot">
              <span className="qc-foot-hint">Enter 保存 · Esc 关闭{parsed.unresolved.length > 0 ? ' · 未识别标记保留在标题' : ''}</span>
              <button type="button" className="qc-save" data-capture-save onClick={() => void save()} disabled={!parsedTitle || busy}>
                {busy ? <Loader2 size={14} className="aispin" /> : <Check size={14} />}
                {busy ? '保存中…' : '保存捕获'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {toast && (
        <output className="qc-toast" data-capture-toast data-kind={toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span>{toast.message}</span>
          {canUndo && (
            <button type="button" data-capture-undo onClick={() => void undo()} disabled={toast.kind === 'undoing'}>
              <Undo2 size={12} />撤销
            </button>
          )}
        </output>
      )}
    </>,
    document.body,
  );
}
