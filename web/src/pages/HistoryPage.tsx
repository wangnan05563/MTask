import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, imageUrl, type Project, type Task } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Archive, Check, ChevronDown, ChevronUp, History, ListChecks, RotateCcw, Search, X } from 'lucide-react';
import { relTime } from '../ui/format';
import { useSessionState } from '../ui/session';

/** 历史资产中的计划条目（plan_tasks 完整行 + 项目名） */
interface HistoryPlan {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  description?: string | null;
  kind?: string;
  status: string;
  progress?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  duration_days?: number | null;
  history_at?: string | null;
}

/** 历史资产任务（TaskView + 项目名） */
type HistoryTask = Task & { project_name: string };

interface HistorySummary {
  transferableTasks: number;
  transferablePlans: number;
  historyTasks: number;
  historyPlans: number;
  historyProjects: number;
  firstHistoryAt: string | null;
  lastHistoryAt: string | null;
}

const PAGE_SIZE = 20;

/**
 * 历史资产页（T00589，按验证反馈重设计）：
 * 「归档」= 软删除区（保留待恢复/清理）；「历史资产」= **组织过程资产沉淀**（完结内容的只读留存视图）。
 * 本页提供：按项目沉淀 → 查看完整内容（任务/计划只读视图，较原页面有所取舍）→ 恢复回原视图 / 转为归档。
 */
export function HistoryPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [plans, setPlans] = useState<HistoryPlan[]>([]);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [transferProject, setTransferProject] = useSessionState<string>('history.transferProject', '');
  const [multi, setMulti] = useSessionState<boolean>('history.multi', false);
  const [selTaskIds, setSelTaskIds] = useSessionState<string[]>('history.selTasks', []);
  const [selPlanIds, setSelPlanIds] = useSessionState<string[]>('history.selPlans', []);
  const [kw, setKw] = useSessionState<string>('history.kw', '');
  const [projFilter, setProjFilter] = useSessionState<string>('history.projFilter', '');
  const [page, setPage] = useState(1);
  const [planPage, setPlanPage] = useState(1);
  // 查看视图：行内展开的只读详情
  const [openTaskId, setOpenTaskId] = useState('');
  const [openPlanId, setOpenPlanId] = useState('');

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3200); };

  const load = useCallback(async () => {
    const q = transferProject ? `?projectId=${encodeURIComponent(transferProject)}` : '';
    const [ps, data, sum] = await Promise.all([
      api.get<Project[]>('/projects'),
      api.get<{ tasks: HistoryTask[]; plans: HistoryPlan[] }>(`/history/list${q}`),
      api.get<HistorySummary>(`/history/summary${q}`).catch(() => null),
    ]);
    setProjects(ps);
    setTasks(data.tasks);
    setPlans(data.plans);
    setSummary(sum);
  }, [transferProject]);

  useEffect(() => { void load(); }, [load]);

  const projectNames = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);

  // ---------- 过滤 + 分页 ----------

  const filteredTasks = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return tasks.filter((t) => {
      if (projFilter && t.project_id !== projFilter) return false;
      if (k && !`${t.title} ${t.task_no ?? ''} ${t.description ?? ''}`.toLowerCase().includes(k)) return false;
      return true;
    });
  }, [tasks, kw, projFilter]);

  const filteredPlans = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return plans.filter((p) => {
      if (projFilter && p.project_id !== projFilter) return false;
      if (k && !`${p.title} ${p.description ?? ''}`.toLowerCase().includes(k)) return false;
      return true;
    });
  }, [plans, kw, projFilter]);

  const taskPages = Math.max(1, Math.ceil(filteredTasks.length / PAGE_SIZE));
  const planPages = Math.max(1, Math.ceil(filteredPlans.length / PAGE_SIZE));
  const curTaskPage = Math.min(page, taskPages);
  const curPlanPage = Math.min(planPage, planPages);
  const pageTasks = filteredTasks.slice((curTaskPage - 1) * PAGE_SIZE, curTaskPage * PAGE_SIZE);
  const pagePlans = filteredPlans.slice((curPlanPage - 1) * PAGE_SIZE, curPlanPage * PAGE_SIZE);

  // ---------- 沉淀 / 恢复 / 转归档 ----------

  async function transfer() {
    if (!transferProject) return flash('请先选择要沉淀的项目');
    const name = projectNames[transferProject] ?? transferProject;
    const t = summary?.transferableTasks ?? 0;
    const p = summary?.transferablePlans ?? 0;
    if (t + p === 0) return flash('该项目没有可沉淀的已完结内容（已完成任务 / 已完结计划）');
    if (!(await askConfirm(`将项目「${name}」的已完结内容沉淀至历史资产？\n· 已完成任务 ${t} 条\n· 已完结计划 ${p} 条\n说明：历史资产为组织过程资产沉淀区（与「归档=软删除」不同），可随时恢复回原视图或转为归档。`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; tasks: number; plans: number }>('/history/transfer', { projectId: transferProject });
      flash(`沉淀完成：任务 ${r.tasks} 条、计划 ${r.plans} 条已进入历史资产`);
      setSelTaskIds([]); setSelPlanIds([]);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function restore(kind: 'task' | 'plan', ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const r = await api.post<{ tasks: number; plans: number }>('/history/restore', kind === 'task' ? { taskIds: ids } : { planIds: ids });
      flash(`已恢复回原视图：${kind === 'task' ? `${r.tasks} 条任务` : `${r.plans} 条计划`}`);
      setSelTaskIds([]); setSelPlanIds([]);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function toArchive(kind: 'task' | 'plan', ids: string[]) {
    if (ids.length === 0) return;
    if (!(await askConfirm(`将选中的 ${ids.length} 条转为归档？（归档区可恢复或彻底删除）`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ tasks: number; plans: number }>('/history/to-archive', kind === 'task' ? { taskIds: ids } : { planIds: ids });
      flash(`已转为归档：${kind === 'task' ? `${r.tasks} 条任务` : `${r.plans} 条计划`}`);
      setSelTaskIds([]); setSelPlanIds([]);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  function toggleTask(id: string) {
    setSelTaskIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function togglePlan(id: string) {
    setSelPlanIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const statCards = [
    { label: '可沉淀任务', value: summary?.transferableTasks ?? 0, hint: '所选项目中已完成且未沉淀的任务' },
    { label: '可沉淀计划', value: summary?.transferablePlans ?? 0, hint: '所选项目中已完结且未沉淀的计划' },
    { label: '历史任务', value: summary?.historyTasks ?? 0, hint: '已沉淀至历史资产的任务' },
    { label: '历史计划', value: summary?.historyPlans ?? 0, hint: '已沉淀至历史资产的计划' },
  ];

  return (
    <section>
      <style>{`
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
      `}</style>

      {notice && <div style={{ position: 'fixed', top: 12, right: 16, zIndex: 200, padding: '6px 12px', borderRadius: 6, background: 'var(--card-bg)', border: '1px solid var(--accent)', fontSize: 12, color: 'var(--text)' }}>{notice}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <History size={16} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 16, margin: 0 }}>历史资产</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          组织过程资产沉淀——已完结内容只读留存与追溯；<strong style={{ color: 'var(--text)' }}>归档</strong>为软删除区（保留待恢复/清理），二者独立
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10, margin: '12px 0' }}>
        {statCards.map((c) => (
          <div key={c.label} title={c.hint} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>{c.value}</div>
          </div>
        ))}
      </div>
      {(summary?.firstHistoryAt || summary?.lastHistoryAt) && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          沉淀时间跨度：{summary.firstHistoryAt ? relTime(summary.firstHistoryAt) : '—'} ~ {summary.lastHistoryAt ? relTime(summary.lastHistoryAt) : '—'}（覆盖 {summary.historyProjects} 个项目）
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', marginBottom: 10 }}>
        <select value={transferProject} onChange={(e) => { setTransferProject(e.target.value); setPage(1); setPlanPage(1); }}
          aria-label="选择沉淀项目" title="选择要沉淀已完结内容的项目"
          style={{ padding: 4, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">选择项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={() => void transfer()} disabled={busy || !transferProject} className="tbtn-anim"
          title="把所选项目的已完成任务与已完结计划沉淀至历史资产"
          aria-label="沉淀至历史资产"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, cursor: transferProject ? 'pointer' : 'not-allowed', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 12, opacity: transferProject ? 1 : 0.5 }}>
          <Archive size={13} /> 沉淀至历史资产
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={() => { setMulti((m) => !m); setSelTaskIds([]); setSelPlanIds([]); }}
          className="tbtn-anim"
          title={multi ? '退出多选模式' : '多选模式 — 勾选后批量恢复/转归档'}
          aria-label={multi ? '退出多选模式' : '进入多选模式'}
          style={{ fontSize: 12, padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', border: '1px solid var(--border-strong)', background: multi ? 'var(--accent)' : 'transparent', color: multi ? 'var(--accent-text)' : 'var(--text)' }}>
          {multi ? <Check size={13} /> : <ListChecks size={13} />}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 8px' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input value={kw} onChange={(e) => { setKw(e.target.value); setPage(1); setPlanPage(1); }}
            placeholder="搜索历史内容…" aria-label="搜索历史资产"
            style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, width: 150 }} />
          {kw && <button onClick={() => setKw('')} title="清除搜索" aria-label="清除搜索" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}><X size={12} /></button>}
        </span>
        <select value={projFilter} onChange={(e) => { setProjFilter(e.target.value); setPage(1); setPlanPage(1); }}
          aria-label="按项目筛选" title="按项目筛选历史资产"
          style={{ padding: 4, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">全部项目</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {(selTaskIds.length > 0 || selPlanIds.length > 0) && (
        <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 10px', marginBottom: 10, borderRadius: 8, background: 'var(--card-bg)', border: '1px solid var(--accent)', fontSize: 12 }}>
          <strong style={{ color: 'var(--accent)' }}>已选 任务 {selTaskIds.length} / 计划 {selPlanIds.length}</strong>
          <button onClick={() => void restore('task', selTaskIds)} disabled={busy || selTaskIds.length === 0} className="tbtn-anim"
            title="恢复回原视图 — 选中的任务回到任务列表" aria-label="批量恢复任务"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '2px 4px' }}>
            <RotateCcw size={14} /> 恢复任务
          </button>
          <button onClick={() => void toArchive('task', selTaskIds)} disabled={busy || selTaskIds.length === 0} className="tbtn-anim"
            title="转为归档 — 选中的任务进入归档（软删除）区" aria-label="批量转归档任务"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px' }}>
            <Archive size={14} /> 转归档
          </button>
          <button onClick={() => void restore('plan', selPlanIds)} disabled={busy || selPlanIds.length === 0} className="tbtn-anim"
            title="恢复回原视图 — 选中的计划回到项目计划时间线" aria-label="批量恢复计划"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '2px 4px' }}>
            <RotateCcw size={14} /> 恢复计划
          </button>
          <button onClick={() => void toArchive('plan', selPlanIds)} disabled={busy || selPlanIds.length === 0} className="tbtn-anim"
            title="转为归档 — 选中的计划进入归档区" aria-label="批量转归档计划"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px' }}>
            <Archive size={14} /> 计划转归档
          </button>
          <button onClick={() => { setSelTaskIds([]); setSelPlanIds([]); }} disabled={busy} className="tbtn-anim"
            title="取消选择" aria-label="取消选择"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '2px 4px' }}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* ---------- 历史任务区（行内展开只读查看视图） ---------- */}
      <h4 style={{ fontSize: 14, margin: '0 0 8px' }}>历史任务（{filteredTasks.length}）</h4>
      {filteredTasks.length === 0 && <p style={{ color: 'var(--text-muted)' }}>暂无历史任务。选择项目点击「沉淀至历史资产」把已完结内容留存到这里。</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pageTasks.map((t) => {
          const open = openTaskId === t.id;
          return (
            <li key={t.id} style={{ borderBottom: '1px solid var(--surface-2)' }}>
              <div className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4 }}>
                {multi && (
                  <input type="checkbox" checked={selTaskIds.includes(t.id)} aria-label={`选中历史任务 ${t.title}`}
                    onChange={() => toggleTask(t.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
                )}
                <button onClick={() => setOpenTaskId(open ? '' : t.id)} title={open ? '收起查看视图' : '查看历史任务完整内容（只读）'}
                  aria-label={open ? '收起历史任务详情' : '展开历史任务详情'}
                  className="tbtn-anim"
                  style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex', padding: 0, flexShrink: 0 }}>
                  {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                <span style={{ flex: 1, color: open ? 'var(--accent)' : 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  onClick={() => setOpenTaskId(open ? '' : t.id)}>
                  {t.task_no ? `${t.task_no} ` : ''}{t.title}（{t.project_name || projectNames[t.project_id] || '未知项目'}）
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`沉淀时间：${t.history_at ?? ''}`}>{relTime(t.history_at ?? null)}</span>
              </div>
              {open && (
                <div style={{ margin: '2px 0 10px 24px', padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)', fontSize: 12, color: 'var(--text)' }}>
                  {/* 只读查看视图（较原任务页有所取舍：无编辑/拖拽/操作按钮） */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    {t.task_no && <span style={{ fontSize: 11, color: 'var(--accent)', background: 'var(--accent-soft)', padding: '0 5px', borderRadius: 4, lineHeight: '18px' }}>{t.task_no}</span>}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>状态：{t.status === 'done' ? '已完成' : '待办'}{t.verified ? ' · 已验证' : ''}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>优先级：{t.priority}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>创建：{relTime(t.created_at)}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>沉淀：{relTime(t.history_at ?? null)}</span>
                  </div>
                  {t.description && (
                    <div style={{ whiteSpace: 'pre-wrap', marginBottom: 6 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>任务详情</div>
                      {t.description}
                    </div>
                  )}
                  {t.handle_result && (
                    <div style={{ whiteSpace: 'pre-wrap', marginBottom: 6, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>处理结果</div>
                      {t.handle_result}
                    </div>
                  )}
                  {t.images && t.images.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                      {t.images.map((img) => (
                        <img key={img.id} src={imageUrl(img.id)} alt="历史任务截图" style={{ height: 72, borderRadius: 4, border: '1px solid var(--border)' }} />
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button onClick={() => void restore('task', [t.id])} disabled={busy} className="tbtn-anim"
                      title="恢复回原视图 — 该任务回到任务列表" aria-label="恢复该历史任务"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>
                      <RotateCcw size={12} /> 恢复回原视图
                    </button>
                    <button onClick={() => void toArchive('task', [t.id])} disabled={busy} className="tbtn-anim"
                      title="转为归档 — 进入归档（软删除）区" aria-label="将该任务转为归档"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                      <Archive size={12} /> 转为归档
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {taskPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} title="上一页" aria-label="上一页"
            style={{ cursor: page <= 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: page <= 1 ? 0.5 : 1 }}>上一页</button>
          <span>第 {curTaskPage} / {taskPages} 页</span>
          <button onClick={() => setPage(Math.min(taskPages, page + 1))} disabled={page >= taskPages} title="下一页" aria-label="下一页"
            style={{ cursor: page >= taskPages ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: page >= taskPages ? 0.5 : 1 }}>下一页</button>
        </div>
      )}

      {/* ---------- 历史计划区（行内展开只读查看视图） ---------- */}
      <h4 style={{ fontSize: 14, margin: '20px 0 8px' }}>历史计划（{filteredPlans.length}）</h4>
      {filteredPlans.length === 0 && <p style={{ color: 'var(--text-muted)' }}>暂无历史计划。</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pagePlans.map((p) => {
          const open = openPlanId === p.id;
          return (
            <li key={p.id} style={{ borderBottom: '1px solid var(--surface-2)' }}>
              <div className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4 }}>
                {multi && (
                  <input type="checkbox" checked={selPlanIds.includes(p.id)} aria-label={`选中历史计划 ${p.title}`}
                    onChange={() => togglePlan(p.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
                )}
                <button onClick={() => setOpenPlanId(open ? '' : p.id)} title={open ? '收起查看视图' : '查看历史计划完整内容（只读）'}
                  aria-label={open ? '收起历史计划详情' : '展开历史计划详情'}
                  className="tbtn-anim"
                  style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex', padding: 0, flexShrink: 0 }}>
                  {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                <span style={{ flex: 1, color: open ? 'var(--accent)' : 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  onClick={() => setOpenPlanId(open ? '' : p.id)}>
                  {p.title}（{p.project_name || projectNames[p.project_id] || '未知项目'}）
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`沉淀时间：${p.history_at ?? ''}`}>{relTime(p.history_at ?? null)}</span>
              </div>
              {open && (
                <div style={{ margin: '2px 0 10px 24px', padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)', fontSize: 12, color: 'var(--text)' }}>
                  {/* 只读查看视图（较项目计划页有所取舍：无拖拽/编辑/依赖配置等操作） */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>类型：{p.kind === 'milestone' ? '里程碑' : p.kind === 'daily' ? '日常任务' : '普通任务'}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>状态：{p.status}</span>
                    {typeof p.progress === 'number' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>进度：{p.progress}%</span>}
                    {p.duration_days != null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>工期：{p.duration_days} 天</span>}
                    {(p.start_date || p.end_date) && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>时间：{p.start_date ?? '—'} ~ {p.end_date ?? '—'}</span>}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>沉淀：{relTime(p.history_at ?? null)}</span>
                  </div>
                  {p.description && (
                    <div style={{ whiteSpace: 'pre-wrap', marginBottom: 6 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>计划描述</div>
                      {p.description}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button onClick={() => void restore('plan', [p.id])} disabled={busy} className="tbtn-anim"
                      title="恢复回原视图 — 该计划回到项目计划时间线" aria-label="恢复该历史计划"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>
                      <RotateCcw size={12} /> 恢复回原视图
                    </button>
                    <button onClick={() => void toArchive('plan', [p.id])} disabled={busy} className="tbtn-anim"
                      title="转为归档 — 进入归档区" aria-label="将该计划转为归档"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                      <Archive size={12} /> 转为归档
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {planPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
          <button onClick={() => setPlanPage(Math.max(1, planPage - 1))} disabled={planPage <= 1} title="上一页" aria-label="上一页（计划）"
            style={{ cursor: planPage <= 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: planPage <= 1 ? 0.5 : 1 }}>上一页</button>
          <span>第 {curPlanPage} / {planPages} 页</span>
          <button onClick={() => setPlanPage(Math.min(planPages, planPage + 1))} disabled={planPage >= planPages} title="下一页" aria-label="下一页（计划）"
            style={{ cursor: planPage >= planPages ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: planPage >= planPages ? 0.5 : 1 }}>下一页</button>
        </div>
      )}
    </section>
  );
}
