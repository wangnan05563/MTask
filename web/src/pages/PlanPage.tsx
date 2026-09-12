import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, Download, FileSpreadsheet, Link2, Link2Off, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';

/** 项目计划页（T00431，菜单位于周报前）：串行瀑布时间线 + Excel 导入导出 + 待办联动。 */

interface PlanTask {
  id: string;
  project_id: string;
  title: string;
  description: string;
  start_date: string;
  end_date: string;
  duration_days: number;
  progress: number;
  status: 'todo' | 'doing' | 'done' | 'blocked';
  assignee: string;
  linked_task_id: string | null;
  linked_task_title?: string | null;
  linked_task_missing?: boolean;
}

interface ProjectRow { id: string; name: string }

const STATUS_META: Record<PlanTask['status'], { label: string; color: string }> = {
  todo: { label: '待开始', color: 'var(--text-muted)' },
  doing: { label: '进行中', color: 'var(--accent)' },
  done: { label: '已完成', color: 'var(--success)' },
  blocked: { label: '受阻', color: 'var(--danger)' },
};

const NEXT_STATUS: Record<PlanTask['status'], PlanTask['status']> = {
  todo: 'doing', doing: 'done', done: 'todo', blocked: 'todo',
};

/** 本地日期 YYYY-MM-DD（避免 toISOString 时区偏移） */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 通用行内输入样式（与全站 task-op 风格一致） */
const inputStyle: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 4, padding: '3px 6px', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 };
const btnStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12, padding: '3px 8px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)' };

export function PlanPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState('');
  const [plans, setPlans] = useState<PlanTask[]>([]);
  const [holidays, setHolidays] = useState<Array<{ date: string; name: string }>>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 3000); };

  useEffect(() => { void api.get<ProjectRow[]>('/projects').then((ps) => { setProjects(ps); if (ps.length > 0) setProjectId((cur) => cur || ps[0].id); }); }, []);

  const reload = useCallback(() => {
    if (!projectId) return;
    void api.get<PlanTask[]>(`/plans?projectId=${projectId}`).then(setPlans).catch((e) => flash(String(e.message ?? e)));
  }, [projectId]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { void api.get<Array<{ date: string; name: string }>>('/plans/holidays').then(setHolidays).catch(() => undefined); }, []);

  // ---------- 计划任务操作 ----------

  async function createPlan() {
    if (!projectId) return flash('请先选择项目');
    const title = await askInput({ title: '新计划任务', placeholder: '任务标题' });
    if (!title?.trim()) return;
    setBusy(true);
    try {
      await api.post('/plans', { projectId, title: title.trim(), startDate: todayStr(), durationDays: 1 });
      reload();
      flash('已创建，时间线已自动重排');
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function updatePlan(p: PlanTask, patch: Partial<Pick<PlanTask, 'title' | 'description' | 'duration_days' | 'assignee' | 'progress' | 'status' | 'start_date'>>) {
    setBusy(true);
    try {
      await api.patch(`/plans/${p.id}`, {
        title: patch.title, description: patch.description, assignee: patch.assignee, status: patch.status,
        progress: patch.progress, durationDays: patch.duration_days, startDate: patch.start_date,
      });
      reload();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function removePlan(p: PlanTask) {
    if (!(await askConfirm(`删除计划任务「${p.title}」？关联待办不受影响，后续时间线将自动重排。`))) return;
    setBusy(true);
    try { await api.del(`/plans/${p.id}`); reload(); } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  // ---------- 待办联动 ----------

  async function linkTodo(p: PlanTask) {
    const taskId = await askInput({ title: '关联待办：输入同项目待办的任务编号（如 T00035）', placeholder: 'Txxxxx' });
    if (!taskId?.trim()) return;
    setBusy(true);
    try {
      const t = await api.get<{ id: string }>(`/tasks/by-no/${taskId.trim()}`);
      await api.post(`/plans/${p.id}/link`, { taskId: t.id });
      reload();
      flash('已关联，待办状态已按计划状态同步');
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function createLinkedTodo(p: PlanTask) {
    if (!(await askConfirm(`由计划「${p.title}」创建新待办并关联？`))) return;
    setBusy(true);
    try { await api.post(`/plans/${p.id}/create-todo`); reload(); flash('待办已创建并关联'); } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function unlinkTodo(p: PlanTask) {
    if (!(await askConfirm('解除与待办的关联？（待办本身保留）'))) return;
    setBusy(true);
    try { await api.post(`/plans/${p.id}/link`, { taskId: null }); reload(); } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  // ---------- Excel ----------

  async function downloadTemplate() {
    const buf = await api.getBinary('/plans/template');
    downloadBlob(buf, 'plan-template.xlsx');
  }

  async function exportExcel() {
    if (!projectId) return flash('请先选择项目');
    const buf = await api.getBinary(`/plans/export?projectId=${projectId}`);
    const ts = todayStr().replace(/-/g, '');
    downloadBlob(buf, `项目计划-${ts}.xlsx`);
  }

  function downloadBlob(buf: ArrayBuffer, name: string) {
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  async function importExcel(file: File) {
    if (!projectId) return flash('请先选择项目');
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const r = await api.postBinary<{ inserted: number; errors: Array<{ row: number; message: string }> }>(`/plans/import?projectId=${projectId}`, buf);
      if (r.errors.length > 0) {
        flash(`导入失败（整体未入库）：${r.errors.length} 行有问题，首条 → 第 ${r.errors[0].row} 行：${r.errors[0].message}`);
      } else {
        flash(`导入成功 ${r.inserted} 条，时间线已重排`);
      }
      reload();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  // ---------- 节假日 ----------

  async function addHoliday() {
    const date = await askInput({ title: '添加节假日（YYYY-MM-DD）', placeholder: todayStr() });
    if (!date?.trim()) return;
    const name = await askInput({ title: '节假日名称（可空）', placeholder: '如：国庆节' });
    setBusy(true);
    try {
      await api.post('/plans/holidays', { date: date.trim(), name: name?.trim() ?? '' });
      setHolidays(await api.get('/plans/holidays'));
      reload();
      flash('节假日已添加，相关时间线已重排');
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function removeHoliday(date: string) {
    if (!(await askConfirm(`移除节假日 ${date}？受影响时间线将自动重排。`))) return;
    setBusy(true);
    try {
      await api.del(`/plans/holidays/${date}`);
      setHolidays(await api.get('/plans/holidays'));
      reload();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 16, color: 'var(--text)' }}>
      {/* 工具条：项目选择 + 增删导入导出 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ ...inputStyle, minWidth: 140 }} aria-label="选择项目">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={() => void createPlan()} disabled={busy} style={btnStyle}><CalendarPlus size={13} />新建任务</button>
        <label style={{ ...btnStyle, cursor: busy ? 'default' : 'pointer' }} title="导入 Excel（任一行校验失败则整体不入库）">
          <Upload size={13} />导入 Excel
          <input type="file" accept=".xlsx" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importExcel(f); e.target.value = ''; }} />
        </label>
        <button onClick={() => void exportExcel()} style={btnStyle}><Download size={13} />导出 Excel</button>
        <button onClick={() => void downloadTemplate()} style={btnStyle}><FileSpreadsheet size={13} />下载模板</button>
        <button onClick={() => void addHoliday()} style={btnStyle} title="维护节假日：时间线自动避开">+节假日</button>
        <button onClick={reload} style={btnStyle} title="刷新"><RefreshCw size={13} /></button>
        {notice && <span style={{ fontSize: 12, color: 'var(--accent)' }}>{notice}</span>}
      </div>

      {/* 节假日摘要 */}
      {holidays.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>节假日（时间线自动避开）：</span>
          {holidays.map((h) => (
            <span key={h.date} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '0 6px' }}>
              {h.date} {h.name}
              <button onClick={() => void removeHoliday(h.date)} title="移除该节假日" style={{ border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', marginLeft: 4 }}>×</button>
            </span>
          ))}
        </div>
      )}

      {/* 计划表格：串行瀑布，起止由服务端按工作日推算 */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-strong)' }}>
            <th style={{ padding: 6 }}>#</th>
            <th style={{ padding: 6 }}>标题 / 描述</th>
            <th style={{ padding: 6 }}>开始</th>
            <th style={{ padding: 6 }}>结束</th>
            <th style={{ padding: 6 }}>工期</th>
            <th style={{ padding: 6 }}>进度</th>
            <th style={{ padding: 6 }}>状态</th>
            <th style={{ padding: 6 }}>负责人</th>
            <th style={{ padding: 6 }}>待办联动</th>
            <th style={{ padding: 6 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p, i) => (
            <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: 6, color: 'var(--text-muted)' }}>{i + 1}</td>
              <td style={{ padding: 6, minWidth: 220 }}>
                <input defaultValue={p.title} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== p.title) void updatePlan(p, { title: e.target.value.trim() }); }}
                  style={{ ...inputStyle, width: '100%' }} aria-label="计划标题" />
                <input defaultValue={p.description} placeholder="描述（可空）" onBlur={(e) => { if (e.target.value !== p.description) void updatePlan(p, { description: e.target.value }); }}
                  style={{ ...inputStyle, width: '100%', marginTop: 2, color: 'var(--text-muted)' }} aria-label="计划描述" />
              </td>
              <td style={{ padding: 6 }}>
                <input type="date" defaultValue={p.start_date} onBlur={(e) => { if (e.target.value && e.target.value !== p.start_date) void updatePlan(p, { start_date: e.target.value }); }}
                  style={inputStyle} aria-label="开始日期" />
              </td>
              <td style={{ padding: 6, color: 'var(--text-muted)' }}>{p.end_date}</td>
              <td style={{ padding: 6 }}>
                <input type="number" min={1} defaultValue={p.duration_days} onBlur={(e) => { const v = Number(e.target.value); if (v >= 1 && v !== p.duration_days) void updatePlan(p, { duration_days: v }); }}
                  style={{ ...inputStyle, width: 56 }} aria-label="工期（工作日）" />
              </td>
              <td style={{ padding: 6 }}>
                <input type="number" min={0} max={100} defaultValue={p.progress} onBlur={(e) => { const v = Number(e.target.value); if (v >= 0 && v <= 100 && v !== p.progress) void updatePlan(p, { progress: v }); }}
                  style={{ ...inputStyle, width: 56 }} aria-label="进度百分比" />
              </td>
              <td style={{ padding: 6 }}>
                {/* 点击状态徽标流转到下一状态：todo→doing→done→todo；blocked 经 done 后回 todo */}
                <button onClick={() => void updatePlan(p, { status: NEXT_STATUS[p.status] })}
                  title="点击流转到下一状态" aria-label={`状态：${STATUS_META[p.status].label}，点击流转`}
                  style={{ ...btnStyle, color: STATUS_META[p.status].color, borderColor: STATUS_META[p.status].color }}>
                  {STATUS_META[p.status].label}
                </button>
              </td>
              <td style={{ padding: 6 }}>
                <input defaultValue={p.assignee} placeholder="—" onBlur={(e) => { if (e.target.value !== p.assignee) void updatePlan(p, { assignee: e.target.value }); }}
                  style={{ ...inputStyle, width: 80 }} aria-label="负责人" />
              </td>
              <td style={{ padding: 6, minWidth: 150 }}>
                {p.linked_task_id && !p.linked_task_missing && <span style={{ color: 'var(--success)' }}>✓ {p.linked_task_title}</span>}
                {p.linked_task_missing && <span style={{ color: 'var(--danger)' }}>待办已删除</span>}
                {!p.linked_task_id && <span style={{ color: 'var(--text-muted)' }}>未关联</span>}
              </td>
              <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
                {p.linked_task_id
                  ? <button onClick={() => void unlinkTodo(p)} title="解除关联" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', padding: 2 }}><Link2Off size={13} /></button>
                  : (
                    <>
                      <button onClick={() => void linkTodo(p)} title="关联既有待办" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', padding: 2 }}><Link2 size={13} /></button>
                      <button onClick={() => void createLinkedTodo(p)} title="由本计划创建新待办并关联" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', padding: 2 }}><CalendarPlus size={13} /></button>
                    </>
                  )}
                <button onClick={() => void removePlan(p)} title="删除计划任务" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--danger)', padding: 2 }}><Trash2 size={13} /></button>
              </td>
            </tr>
          ))}
          {plans.length === 0 && (
            <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>当前项目暂无计划任务：可「新建任务」或「导入 Excel」批量创建</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
