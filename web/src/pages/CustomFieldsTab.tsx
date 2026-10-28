/**
 * T03231（PRD PM-203①）：设置页「自定义字段」——按项目管理字段定义（建 / 改 / 归档）。
 *
 * 为什么放在设置页而不是任务页：字段是**项目级**配置，改一次影响全项目的任务呈现；
 * 放在任务页会把一次性配置混进每次处理待办的高频路径。项目用原生下拉选择，
 * 与「任务分类」同一套列表/表单形态，键盘可直接抵达每个控件。
 *
 * 选项编辑不采用「逗号分隔文本」：那样每次保存都会重新生成选项 id，
 * 已落库的值全部变成指向空气的孤值。这里逐行编辑并保留 id，被引用的选项由服务端拒绝硬删（PM-203④）。
 */
import { useEffect, useState } from 'react';
import { api, type CustomField, type CustomFieldType, type Project } from '../api/client';
import { FIELD_SM, SELECT } from '../ui/primitives'; // PM-302 ① 单源 ui/primitives.ts

const TYPE_LABEL: Record<CustomFieldType, string> = { text: '文本', number: '数字', date: '日期', select: '单选' };
const PROJECT_KEY = 'mtask.customFields.projectId';

type OptDraft = { id?: string; label: string; archived: boolean };
type FormDraft = { id: string; name: string; type: CustomFieldType; opts: OptDraft[] };

const EMPTY_FORM: FormDraft = { id: '', name: '', type: 'text', opts: [] };

export function CustomFieldsTab() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(() => { try { return localStorage.getItem(PROJECT_KEY) ?? ''; } catch { return ''; } });
  const [fields, setFields] = useState<CustomField[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [form, setForm] = useState<FormDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<Project[]>('/projects')
      .then((ps) => {
        setProjects(ps);
        setProjectId((cur) => (ps.some((p) => p.id === cur) ? cur : (ps[0]?.id ?? '')));
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!projectId) { setFields([]); return; }
    try { localStorage.setItem(PROJECT_KEY, projectId); } catch { /* 隐私模式忽略 */ }
    api.get<CustomField[]>(`/projects/${projectId}/fields${includeArchived ? '?includeArchived=1' : ''}`)
      .then((fs) => { setFields(fs); setErr(''); })
      .catch((e: unknown) => { setFields([]); setErr(e instanceof Error ? e.message : String(e)); });
  }, [projectId, includeArchived]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  function startCreate() {
    setErr('');
    setForm({ ...EMPTY_FORM, type: 'text', opts: [] });
  }

  function startEdit(f: CustomField) {
    setErr('');
    setForm({ id: f.id, name: f.name, type: f.type, opts: f.options.map((o) => ({ id: o.id, label: o.label, archived: o.archived })) });
  }

  async function saveForm() {
    if (!form || busy) return;
    setBusy(true);
    setErr('');
    try {
      const body: Record<string, unknown> = { name: form.name, type: form.type };
      if (form.type === 'select') {
        body.options = form.opts
          .filter((o) => o.label.trim())
          .map((o) => ({ ...(o.id ? { id: o.id } : {}), label: o.label.trim(), archived: o.archived }));
      }
      if (form.id) await api.patch(`/fields/${form.id}`, body);
      else await api.post(`/projects/${projectId}/fields`, body);
      setForm(null);
      flash('字段已保存');
      setFields(await api.get<CustomField[]>(`/projects/${projectId}/fields${includeArchived ? '?includeArchived=1' : ''}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function archiveField(f: CustomField) {
    setBusy(true);
    setErr('');
    try {
      await api.post(`/fields/${f.id}/archive`, {});
      flash(`字段「${f.name}」已归档（历史值保留）`);
      setFields(await api.get<CustomField[]>(`/projects/${projectId}/fields${includeArchived ? '?includeArchived=1' : ''}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function setOpt(i: number, patch: Partial<OptDraft>) {
    setForm((prev) => (prev ? { ...prev, opts: prev.opts.map((o, j) => (j === i ? { ...o, ...patch } : o)) } : prev));
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
    border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)', marginBottom: 8,
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600 }}>自定义字段</div>
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
            为选中项目增加文本 / 数字 / 日期 / 单选字段；只描述任务，不改变任务的 todo / done 状态。
          </div>
        </div>
        <button onClick={startCreate} disabled={!projectId || busy}
          aria-label="新建自定义字段" title="在当前项目新建一个自定义字段"
          style={{ fontSize: 'var(--fs-m)', padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: projectId ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
          新建字段
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
          项目
          <select aria-label="选择项目" value={projectId} onChange={(e) => { setProjectId(e.target.value); setForm(null); }} style={{ ...SELECT, minWidth: 160 }}>
            {projects.length === 0 && <option value="">（暂无项目）</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          含已归档
        </label>
      </div>

      {err && <div data-t03231="admin-err" role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--fs-s)', marginBottom: 10 }}>{err}</div>}

      {form && (
        <div data-t03231="field-form" style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12, marginBottom: 14, background: 'var(--card-bg)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--fs-m)' }}>{form.id ? '编辑字段' : '新建字段'}</div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
            字段名称
            <input aria-label="字段名称" value={form.name} disabled={busy} maxLength={40}
              onChange={(e) => setForm({ ...form, name: e.target.value })} style={FIELD_SM} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
            字段类型
            <select aria-label="字段类型" value={form.type} disabled={busy}
              onChange={(e) => {
                const type = e.target.value as CustomFieldType;
                setForm({ ...form, type, opts: type === 'select' && form.opts.length === 0 ? [{ label: '', archived: false }, { label: '', archived: false }] : form.opts });
              }}
              style={SELECT}>
              {(Object.keys(TYPE_LABEL) as CustomFieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          {form.type === 'select' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>单选项（已被任务引用的选项只能停用，不能删除）</div>
              {form.opts.map((o, i) => (
                <div key={o.id ?? `new-${i}`} data-t03231="option-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input aria-label={`选项 ${i + 1} 名称`} value={o.label} disabled={busy} maxLength={40}
                    onChange={(e) => setOpt(i, { label: e.target.value })}
                    style={{ ...FIELD_SM, flex: 1, opacity: o.archived ? 0.6 : 1 }} />
                  {o.archived && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>已停用</span>}
                  <button type="button" aria-label={`${o.archived ? '启用' : '停用'}选项 ${o.label || i + 1}`} disabled={busy || !o.label.trim()}
                    onClick={() => setOpt(i, { archived: !o.archived })}
                    style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                    {o.archived ? '启用' : '停用'}
                  </button>
                  <button type="button" aria-label={`删除选项 ${o.label || i + 1}`} disabled={busy}
                    onClick={() => setForm({ ...form, opts: form.opts.filter((_, j) => j !== i) })}
                    style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
                    删除
                  </button>
                </div>
              ))}
              <button type="button" aria-label="添加选项" disabled={busy}
                onClick={() => setForm({ ...form, opts: [...form.opts, { label: '', archived: false }] })}
                style={{ alignSelf: 'flex-start', fontSize: 'var(--fs-xs)', padding: '3px 10px', borderRadius: 6, border: '1px dashed var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                添加选项
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => { void saveForm(); }} disabled={busy || !form.name.trim()}
              aria-label={form.id ? '保存字段' : '创建字段'}
              style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)', cursor: busy ? 'default' : 'pointer' }}>
              {form.id ? '保存' : '创建'}
            </button>
            <button type="button" onClick={() => setForm(null)} disabled={busy} aria-label="取消编辑字段"
              style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', cursor: 'pointer' }}>
              取消
            </button>
          </div>
        </div>
      )}

      {fields.length === 0 && !form && (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>该项目暂无自定义字段，点击「新建字段」创建。</p>
      )}

      {fields.map((f) => (
        <div key={f.id} data-t03231="field-admin-row" data-field-name={f.name} style={{ ...rowStyle, opacity: f.archived ? 0.65 : 1 }}>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{f.name}</span>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 5px' }}>{TYPE_LABEL[f.type] ?? f.type}</span>
          {f.type === 'select' && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.options.map((o) => (o.archived ? `${o.label}(停用)` : o.label)).join(' / ')}
            </span>
          )}
          <span style={{ flex: f.type === 'select' ? '0 0 auto' : 1 }} />
          {f.archived ? (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>已归档</span>
          ) : (
            <>
              <button type="button" onClick={() => startEdit(f)} disabled={busy} aria-label={`编辑字段 ${f.name}`} title="编辑字段名称与选项"
                style={{ fontSize: 'var(--fs-s)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                编辑
              </button>
              <button type="button" onClick={() => { void archiveField(f); }} disabled={busy} aria-label={`归档字段 ${f.name}`} title="归档字段——历史值保留，列表与详情不再展示"
                style={{ fontSize: 'var(--fs-s)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                归档
              </button>
            </>
          )}
        </div>
      ))}

      {msg && <output className="flash-toast">{msg}</output>}
    </div>
  );
}
