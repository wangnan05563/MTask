import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderKanban, LayoutTemplate, ListTodo, Undo2, X } from 'lucide-react';
import { api } from '../api/client';
import type {
  ProjectTemplateBody, Template, TemplateInstanceResult, TemplateTaskBody, TemplateUndoResult,
} from '../api/client';

/**
 * T06305（REQ-010 / PRD §B2）：任务/项目模板的一键实例化入口。
 *
 * 设计取舍：
 * - 无宏变量：模板体直接展示可落库字段，不弹变量表单；
 * - 预览：列表行展示类型、描述、任务数/优先级，应用前可见将创建什么；
 * - 撤销：实例化成功后留在面板内给「撤销」按钮，撤销失败（项目已被继续编辑）原样回显原因；
 * - 任务模板必须绑定具体项目，项目模板会新建项目并回调页面切换。
 */
export function TemplateMenu({
  projectId, disabled, onTaskInstanced, onProjectInstanced, onProjectUndone, onError,
}: {
  readonly projectId?: string;
  readonly disabled?: boolean;
  readonly onTaskInstanced?: (result: TemplateInstanceResult) => void;
  readonly onProjectInstanced?: (result: TemplateInstanceResult) => void;
  readonly onProjectUndone?: (projectId: string) => void;
  readonly onError?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<TemplateInstanceResult | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoMessage, setUndoMessage] = useState('');
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setResult(null);
    setUndoMessage('');
    api.get<{ rows: Template[] }>('/templates')
      .then((r) => { if (!cancelled) setRows(r.rows ?? []); })
      .catch((e) => { if (!cancelled) setError(String((e as Error).message ?? e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const apply = async (tpl: Template) => {
    if (busyId) return;
    if (tpl.type === 'task' && !projectId) {
      const msg = '请先选择具体项目，再应用任务模板';
      setError(msg);
      onError?.(msg);
      return;
    }
    setBusyId(tpl.id);
    setError('');
    setUndoMessage('');
    try {
      const r = await api.post<TemplateInstanceResult>(`/templates/${tpl.id}/instantiate`, tpl.type === 'task' ? { projectId } : {});
      setResult(r);
      if (r.type === 'task') onTaskInstanced?.(r);
      else onProjectInstanced?.(r);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(msg);
      onError?.(msg);
    } finally {
      setBusyId('');
    }
  };

  const undo = async () => {
    if (!result || undoing) return;
    setUndoing(true);
    setError('');
    try {
      const r = await api.post<TemplateUndoResult>(`/templates/instances/${result.instanceId}/undo`, {});
      setUndoMessage(r.deletedProjectId ? '已撤销：项目及其模板任务已删除' : '已撤销：本次创建的任务已归档');
      setResult(null);
      if (r.deletedProjectId) onProjectUndone?.(r.deletedProjectId);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(msg);
      onError?.(msg);
    } finally {
      setUndoing(false);
    }
  };

  const taskTemplate = (tpl: Template) => tpl.type === 'task' ? tpl.schema as TemplateTaskBody : null;
  const projectTemplate = (tpl: Template) => tpl.type === 'project' ? tpl.schema as ProjectTemplateBody : null;

  return (
    <span ref={rootRef} data-t06305="template-menu" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button type="button" className="tbtn-anim" disabled={disabled} aria-label="从模板新建" aria-expanded={open}
        title={disabled ? '当前忙，稍后再试' : '从任务/项目模板一键创建'}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 6,
          cursor: disabled ? 'not-allowed' : 'pointer', border: '1px solid var(--border-strong)',
          background: open ? 'var(--accent-soft, var(--card-bg))' : 'var(--card-bg)',
          color: 'var(--text)', fontSize: 'var(--fs-s)', opacity: disabled ? 0.55 : 1,
        }}>
        <LayoutTemplate size={14} />
        模板
        <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>

      {open && (
        <div data-t06305="template-panel" role="dialog" aria-label="从模板新建"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 80,
            width: 'min(380px, calc(100vw - 20px))', maxHeight: 'min(70vh, 520px)', overflowY: 'auto',
            background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,.18)', padding: 10,
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 'var(--fs-m)' }}>从模板新建</strong>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>无变量 · 一键实例化</span>
            <span style={{ flex: 1 }} />
            <button type="button" aria-label="关闭模板面板" className="task-op" onClick={() => setOpen(false)}
              style={{ display: 'inline-flex', alignItems: 'center', padding: 3, cursor: 'pointer' }}><X size={14} /></button>
          </div>

          {result ? (
            <div data-t06305="template-result" style={{ border: '1px solid var(--success)', borderRadius: 8, padding: 10, background: 'var(--card-bg)' }}>
              <div style={{ fontSize: 'var(--fs-s)', color: 'var(--success)', marginBottom: 4 }}>
                {result.type === 'task' ? `已创建 ${result.tasks.length} 条任务` : `已创建项目「${result.projectName}」`}
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>
                {result.type === 'project' ? `${result.tasks.length} 条模板任务已入项目` : `项目：${result.projectName}`}
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginBottom: 8 }}>
                {result.tasks.map((t) => t.title).join('、')}
              </div>
              {result.type === 'project' && result.projectId ? (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>撤销将删除新项目及其任务；项目里加过任务后不可整体撤销。</div>
              ) : null}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" data-t06305="undo" disabled={undoing} onClick={() => void undo()}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, cursor: undoing ? 'wait' : 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
                  <Undo2 size={13} />{undoing ? '撤销中…' : '撤销'}
                </button>
                <button type="button" onClick={() => setOpen(false)}
                  style={{ padding: '5px 10px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)' }}>
                  完成
                </button>
              </div>
            </div>
          ) : (
            <>
              {undoMessage && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--success)', marginBottom: 8 }}>{undoMessage}</div>}
              {error && <div role="alert" style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)', marginBottom: 8 }}>{error}</div>}
              {loading ? <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 8 }}>加载模板…</div> : null}
              {!loading && rows.length === 0 ? <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 8 }}>暂无模板</div> : null}
              {rows.map((tpl) => {
                const isTask = tpl.type === 'task';
                const task = taskTemplate(tpl);
                const proj = projectTemplate(tpl);
                const blocked = isTask && !projectId;
                const count = proj?.tasks?.length ?? 0;
                return (
                  <div key={tpl.id} data-t06305={`template-row-${tpl.type}`}
                    style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: 9, marginBottom: 8, background: 'var(--card-bg)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      {isTask ? <ListTodo size={14} /> : <FolderKanban size={14} />}
                      <strong style={{ fontSize: 'var(--fs-s)' }}>{tpl.name}</strong>
                      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{isTask ? '任务模板' : '项目模板'}{tpl.builtin ? ' · 内置' : ''}</span>
                      <span style={{ flex: 1 }} />
                      <button type="button" data-t06305={`apply-${tpl.type}`} disabled={Boolean(busyId) || blocked}
                        title={blocked ? '请先选择具体项目' : `应用「${tpl.name}」`}
                        onClick={() => void apply(tpl)}
                        style={{ padding: '4px 10px', borderRadius: 6, cursor: busyId || blocked ? 'not-allowed' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-xs)', opacity: blocked ? 0.5 : 1 }}>
                        {busyId === tpl.id ? '创建中…' : '应用'}
                      </button>
                    </div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 3 }}>{tpl.description || '—'}</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
                      {isTask
                        ? `将创建：${task?.title || '—'}（${task?.priority || 'normal'} / ${task?.status || 'todo'}）`
                        : `将创建：项目 + ${count} 条任务`}
                    </div>
                    {proj?.tasks?.length ? (
                      <ul style={{ margin: '4px 0 0 0', paddingLeft: 16, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                        {proj.tasks.slice(0, 4).map((t, i) => (
                          <li key={`${t.title}-${i}`}>{t.title}{t.priority && t.priority !== 'normal' ? `（${t.priority}）` : ''}</li>
                        ))}
                        {count > 4 ? <li>…另 {count - 4} 条</li> : null}
                      </ul>
                    ) : null}
                    {isTask && task?.description ? (
                      <div style={{ marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', maxHeight: 42, overflow: 'hidden' }}>
                        {task.description}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {!projectId && rows.some((t) => t.type === 'task') && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>任务模板需先在工具栏选择具体项目；项目模板可独立创建。</div>
              )}
            </>
          )}
        </div>
      )}
    </span>
  );
}
