/**
 * T03231（PRD PM-203①）：设置页「自定义字段」——按项目管理字段定义（建 / 改 / 归档 / 恢复）。
 *
 * 为什么放在设置页而不是任务页：字段是**项目级**配置，改一次影响全项目的任务呈现；
 * 放在任务页会把一次性配置混进每次处理待办的高频路径。项目用原生下拉选择，
 * 与「任务分类」同一套列表/表单形态，键盘可直接抵达每个控件。
 *
 * 选项编辑不采用「逗号分隔文本」：那样每次保存都会重新生成选项 id，
 * 已落库的值全部变成指向空气的孤值。这里逐行编辑并保留 id，被引用的选项由服务端拒绝硬删（PM-203④）；
 * 设置页再用 `usage_count` 直接把「已引用」标在选项上并禁用删除，避免用户保存后才试错。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ListPlus } from 'lucide-react';
import { api, type CustomField, type CustomFieldType, type Project } from '../api/client';
import { FIELD_SM, SELECT } from '../ui/primitives'; // PM-302 ① 单源 ui/primitives.ts
import { SettingsHelpIcon } from '../ui/settingsHelp'; // T06019：子页说明文字改为语义图标
import { askConfirm } from '../ui/dialogs'; // 归档/丢弃草稿确认：Electron 下 window.confirm 不可用

const TYPE_LABEL: Record<CustomFieldType, string> = { text: '文本', number: '数字', date: '日期', select: '单选' };
const PROJECT_KEY = 'mtask.customFields.projectId';

type OptDraft = { id?: string; label: string; archived: boolean; usage_count: number };
type FormDraft = { id: string; name: string; type: CustomFieldType; opts: OptDraft[]; usage: number };

const EMPTY_FORM: FormDraft = { id: '', name: '', type: 'text', opts: [], usage: 0 };

/** 保留当前选中的项目（不存在则回退第一个）——提到模块级，避免 effect 里再嵌回调（S2004） */
function resolveProjectId(ps: Project[], cur: string): string {
  const keep = ps.some((p) => p.id === cur);
  return keep ? cur : (ps[0]?.id ?? '');
}

/** 表单本地校验：先挡掉明显错误，错误显示在选项区/表单内，不让用户等一次 400 */
function validateDraft(f: FormDraft): string {
  const name = f.name.trim();
  if (!name) return '字段名称必填';
  if (name.length > 40) return '字段名称不能超过 40 个字符';
  if (f.type !== 'select') return '';
  const labels = f.opts.map((o) => o.label.trim()).filter(Boolean);
  if (labels.length === 0) return '单选字段至少需要一个有效选项';
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) return `选项「${label}」重复`;
    seen.add(label);
  }
  return '';
}

function snapshot(f: FormDraft): string {
  return JSON.stringify(f);
}

export function CustomFieldsTab() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(() => { try { return localStorage.getItem(PROJECT_KEY) ?? ''; } catch { return ''; } });
  const [fields, setFields] = useState<CustomField[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [form, setForm] = useState<FormDraft | null>(null);
  const [formBase, setFormBase] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const requestSeq = useRef(0);

  useEffect(() => {
    api.get<Project[]>('/projects')
      .then((ps) => {
        setProjects(ps);
        setProjectId((cur) => resolveProjectId(ps, cur));
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setProjectsLoading(false));
  }, []);

  /** 统一取列表：请求序号保证快速切项目/切含已归档时，晚到的旧响应不会覆盖新项目 */
  const loadFields = useCallback(async (pid: string, withArchived: boolean) => {
    const seq = ++requestSeq.current;
    setFieldsLoading(true);
    setFields([]);
    setErr('');
    try {
      const fs = await api.get<CustomField[]>(`/projects/${pid}/fields${withArchived ? '?includeArchived=1' : ''}`);
      if (seq === requestSeq.current) setFields(fs);
    } catch (e) {
      if (seq === requestSeq.current) {
        setFields([]);
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (seq === requestSeq.current) setFieldsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!projectId) {
      requestSeq.current += 1;
      setFields([]);
      setFieldsLoading(false);
      return;
    }
    try { localStorage.setItem(PROJECT_KEY, projectId); } catch { /* 隐私模式忽略 */ }
    void loadFields(projectId, includeArchived);
  }, [projectId, includeArchived, loadFields]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  function isDirty(): boolean {
    return !!form && snapshot(form) !== formBase;
  }

  async function confirmDiscard(action: string): Promise<boolean> {
    if (!isDirty()) return true;
    return askConfirm(`当前字段表单有未保存的修改，${action}将丢失这些修改。继续？`);
  }

  function openDraft(draft: FormDraft) {
    setErr('');
    setFormErr('');
    setForm(draft);
    setFormBase(snapshot(draft));
  }

  async function startCreate() {
    if (!(await confirmDiscard('新建字段'))) return;
    openDraft({ ...EMPTY_FORM, type: 'text', opts: [] });
  }

  async function startEdit(f: CustomField) {
    if (!(await confirmDiscard('编辑其他字段'))) return;
    openDraft({
      id: f.id,
      name: f.name,
      type: f.type,
      opts: f.options.map((o) => ({ id: o.id, label: o.label, archived: o.archived, usage_count: o.usage_count })),
      usage: f.usage_count,
    });
  }

  async function cancelEdit() {
    if (!(await confirmDiscard('取消编辑'))) return;
    setForm(null);
    setFormErr('');
  }

  async function changeProject(next: string, selectEl: HTMLSelectElement) {
    if (next === projectId) return;
    if (!(await confirmDiscard('切换项目'))) {
      selectEl.value = projectId; // controlled select 的 DOM 已先行改值，取消时必须手动回退
      return;
    }
    setForm(null);
    setFormErr('');
    setProjectId(next);
  }

  async function saveForm() {
    if (!form || busy) return;
    const localErr = validateDraft(form);
    if (localErr) {
      setFormErr(localErr);
      return;
    }
    setBusy(true);
    setErr('');
    setFormErr('');
    const targetProject = projectId;
    try {
      const body: Record<string, unknown> = { name: form.name.trim(), type: form.type };
      if (form.type === 'select') {
        body.options = form.opts
          .filter((o) => o.label.trim())
          .map((o) => ({ ...(o.id ? { id: o.id } : {}), label: o.label.trim(), archived: o.archived }));
      }
      if (form.id) await api.patch(`/fields/${form.id}`, body);
      else await api.post(`/projects/${targetProject}/fields`, body);
      setForm(null);
      flash('字段已保存');
      await loadFields(targetProject, includeArchived);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function archiveField(f: CustomField) {
    const ok = await askConfirm(
      `归档字段「${f.name}」？\n\n归档后该字段会从任务列表和任务详情的「自定义字段」中撤下；历史填写值保留，可在「含已归档」中恢复。`,
    );
    if (!ok) return;
    setBusy(true);
    setErr('');
    try {
      await api.post(`/fields/${f.id}/archive`, {});
      flash(`字段「${f.name}」已归档（历史值保留）`);
      await loadFields(projectId, includeArchived);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restoreField(f: CustomField) {
    setBusy(true);
    setErr('');
    try {
      await api.post(`/fields/${f.id}/restore`, {});
      flash(`字段「${f.name}」已恢复`);
      await loadFields(projectId, includeArchived);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function setOpt(i: number, patch: Partial<OptDraft>) {
    setForm((prev) => (prev ? { ...prev, opts: prev.opts.map((o, j) => (j === i ? { ...o, ...patch } : o)) } : prev));
  }

  const loading = projectsLoading || fieldsLoading;
  const activeFields = fields.filter((f) => !f.archived);
  const archivedFields = fields.filter((f) => f.archived);
  const nameOk = !!form?.name.trim();
  const optionLabels = form?.type === 'select' ? form.opts.map((o) => o.label.trim()).filter(Boolean) : [];
  const duplicateLabel = optionLabels.find((label, i) => optionLabels.indexOf(label) !== i) ?? '';
  const optionsOk = form?.type !== 'select' || (optionLabels.length > 0 && !duplicateLabel);
  const saveDisabled = busy || !nameOk || !optionsOk;
  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
    border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)', marginBottom: 8,
    flexWrap: 'wrap',
  };
  const actionWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flex: '0 0 auto' };
  const fieldNameStyle: React.CSSProperties = { fontWeight: 600, flex: '0 1 auto', minWidth: 0, overflowWrap: 'anywhere' };

  function renderField(f: CustomField) {
    const usage = f.usage_count ?? 0;
    return (
      <div key={f.id} data-t03231="field-admin-row" data-field-name={f.name} style={{ ...rowStyle, opacity: f.archived ? 0.68 : 1 }}>
        <span data-t03231="field-name" style={fieldNameStyle}>{f.name}</span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 5px', flex: '0 0 auto' }}>{TYPE_LABEL[f.type] ?? f.type}</span>
        {f.type === 'select' && (
          <span data-t03231="field-options" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {f.options.map((o) => (o.archived ? `${o.label}(停用)` : o.label)).join(' / ')}
          </span>
        )}
        <span data-t03231="field-usage" title={`当前有 ${usage} 条任务填写值`}
          style={{ fontSize: 'var(--fs-xs)', color: usage > 0 ? 'var(--text-secondary)' : 'var(--text-muted)', flex: '0 0 auto' }}>
          {usage > 0 ? `${usage} 个任务在用` : '未被任务使用'}
        </span>
        {f.archived ? (
          <div style={actionWrap}>
            <span data-t03231="field-archived" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>已归档</span>
            <button type="button" onClick={() => { void restoreField(f); }} disabled={busy} aria-label={`恢复字段 ${f.name}`} title="恢复字段——历史填写值仍在库中，恢复后重新在任务列表/详情展示"
              style={{ fontSize: 'var(--fs-s)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: busy ? 'default' : 'pointer' }}>
              恢复
            </button>
          </div>
        ) : (
          <div style={actionWrap}>
            <button type="button" onClick={() => { void startEdit(f); }} disabled={busy} aria-label={`编辑字段 ${f.name}`} title="编辑字段名称与选项"
              style={{ fontSize: 'var(--fs-s)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: busy ? 'default' : 'pointer' }}>
              编辑
            </button>
            <button type="button" onClick={() => { void archiveField(f); }} disabled={busy} aria-label={`归档字段 ${f.name}`} title="归档字段——历史值保留，列表与详情不再展示，可在「含已归档」中恢复"
              style={{ fontSize: 'var(--fs-s)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-secondary)', cursor: busy ? 'default' : 'pointer' }}>
              归档
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <SettingsHelpIcon icon={ListPlus} label="自定义字段" ariaDescription="为选中项目增加文本 / 数字 / 日期 / 单选字段；只描述任务，不改变任务的 todo / done 状态。" description="为选中项目增加文本 / 数字 / 日期 / 单选字段；只描述任务，不改变任务的 todo / done 状态。" />
        <button type="button" onClick={() => { void startCreate(); }} disabled={!projectId || loading || busy}
          aria-label="新建自定义字段" title="在当前项目新建一个自定义字段"
          style={{ fontSize: 'var(--fs-m)', padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: projectId && !loading ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
          新建字段
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
          项目{' '}
          <select aria-label="选择项目" value={projectId} disabled={busy}
            onChange={(e) => { const el = e.currentTarget; void changeProject(e.target.value, el); }}
            style={{ ...SELECT, minWidth: 160, maxWidth: '100%' }}>
            {projects.length === 0 && <option value="">{projectsLoading ? '加载项目…' : '（暂无项目）'}</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={includeArchived} disabled={busy || loading}
            onChange={(e) => setIncludeArchived(e.target.checked)} />
          {' '}含已归档{archivedFields.length > 0 ? `（${archivedFields.length}）` : ''}
        </label>
        {!loading && fields.length > 0 && (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            共 {activeFields.length} 个字段{archivedFields.length > 0 ? `，${archivedFields.length} 个已归档` : ''}
          </span>
        )}
      </div>

      {err && <div data-t03231="admin-err" role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-s)', marginBottom: 10 }}>{err}</div>}

      {form && (
        <div data-t03231="field-form" role="group" aria-label={form.id ? '编辑自定义字段' : '新建自定义字段'} style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12, marginBottom: 14, background: 'var(--card-bg)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--fs-m)' }}>{form.id ? '编辑字段' : '新建字段'}</div>
          {formErr && <div data-t03231="form-err" role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-s)', border: '1px solid var(--danger)', borderRadius: 6, padding: '5px 8px' }}>{formErr}</div>}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
            <span>字段名称<span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span></span>
            <input aria-label="字段名称" value={form.name} disabled={busy} maxLength={40} autoFocus aria-required="true"
              onChange={(e) => setForm({ ...form, name: e.target.value })} style={FIELD_SM} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
            字段类型{' '}
            <select aria-label="字段类型" value={form.type} disabled={busy || form.usage > 0}
              title={form.usage > 0 ? `已有 ${form.usage} 个任务填写值，不能改类型；请先在任务中清空该字段` : undefined}
              onChange={(e) => {
                const type = e.target.value as CustomFieldType;
                setForm({ ...form, type, opts: type === 'select' && form.opts.length === 0 ? [{ label: '', archived: false, usage_count: 0 }, { label: '', archived: false, usage_count: 0 }] : form.opts });
              }}
              style={{ ...SELECT, opacity: form.usage > 0 ? 0.65 : 1 }}>
              {(Object.keys(TYPE_LABEL) as CustomFieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          {form.usage > 0 && (
            <div data-t03231="type-lock" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: -4 }}>
              已有 {form.usage} 个任务填写值，字段类型已锁定；如需改类型，请先在任务详情中清空该字段。
            </div>
          )}
          {form.type === 'select' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>单选项（已被任务引用的选项只能停用，不能删除）</div>
              {form.opts.map((o, i) => {
                const usage = o.usage_count ?? 0;
                return (
                  <div key={o.id ?? `new-${i}`} data-t03231="option-row" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <input aria-label={`选项 ${i + 1} 名称`} value={o.label} disabled={busy} maxLength={40}
                      onChange={(e) => setOpt(i, { label: e.target.value })}
                      style={{ ...FIELD_SM, flex: '1 1 200px', minWidth: 0, opacity: o.archived ? 0.6 : 1 }} />
                    {o.archived && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>已停用</span>}
                    {usage > 0 && (
                      <span data-t03231="option-usage" title={`当前有 ${usage} 条任务填写值指向该选项`}
                        style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn)', flex: '0 0 auto' }}>
                        已引用 {usage}
                      </span>
                    )}
                    <button type="button" aria-label={`${o.archived ? '启用' : '停用'}选项 ${o.label || i + 1}`} disabled={busy || !o.label.trim()}
                      onClick={() => setOpt(i, { archived: !o.archived })}
                      style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', flex: '0 0 auto' }}>
                      {o.archived ? '启用' : '停用'}
                    </button>
                    <button type="button" aria-label={`删除选项 ${o.label || i + 1}`} disabled={busy || usage > 0}
                      title={usage > 0 ? `已被 ${usage} 个任务引用，只能停用不能删除` : '删除该选项'}
                      onClick={() => setForm({ ...form, opts: form.opts.filter((_, j) => j !== i) })}
                      style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: usage > 0 ? 'not-allowed' : 'pointer', opacity: usage > 0 ? 0.45 : 1, flex: '0 0 auto' }}>
                      删除
                    </button>
                  </div>
                );
              })}
              {form.type === 'select' && !optionsOk && (
                <div data-t03231="option-error" role="alert" style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
                  {optionLabels.length === 0 ? '至少填写一个选项名称' : `选项「${duplicateLabel}」重复`}
                </div>
              )}
              <button type="button" aria-label="添加选项" disabled={busy}
                onClick={() => setForm({ ...form, opts: [...form.opts, { label: '', archived: false, usage_count: 0 }] })}
                style={{ alignSelf: 'flex-start', fontSize: 'var(--fs-xs)', padding: '3px 10px', borderRadius: 6, border: '1px dashed var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                添加选项
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => { void saveForm(); }} disabled={saveDisabled}
              aria-label={form.id ? '保存字段' : '创建字段'}
              style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)', cursor: saveDisabled ? 'default' : 'pointer', opacity: saveDisabled ? 0.6 : 1 }}>
              {busy ? '保存中…' : form.id ? '保存' : '创建'}
            </button>
            <button type="button" onClick={() => { void cancelEdit(); }} disabled={busy} aria-label="取消编辑字段"
              style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', cursor: 'pointer' }}>
              取消
            </button>
          </div>
        </div>
      )}

      {loading && (
        <p data-t03231="fields-loading" role="status" style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>
          {projectsLoading ? '加载项目…' : '加载自定义字段…'}
        </p>
      )}

      {!loading && !err && fields.length === 0 && !form && (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>
          {projectId ? '该项目暂无自定义字段，点击「新建字段」创建。' : '暂无项目；创建项目后可在此添加自定义字段。'}
        </p>
      )}

      {!loading && activeFields.map(renderField)}

      {!loading && archivedFields.length > 0 && (
        <>
          <div data-t03231="archived-heading" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', margin: '12px 0 8px' }}>
            已归档（{archivedFields.length}）· 仅历史值保留，恢复后重新参与展示
          </div>
          {archivedFields.map(renderField)}
        </>
      )}

      {msg && <output className="flash-toast">{msg}</output>}
    </div>
  );
}
