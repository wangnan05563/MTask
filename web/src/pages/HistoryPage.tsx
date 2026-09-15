import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Project, type Task } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Archive, Check, History, ListChecks, RotateCcw, Search, Trash2, Undo2, X } from 'lucide-react';
import { relTime } from '../ui/format';
import { useSessionState } from '../ui/session';

/** 项目计划归档条目 */
interface ArchivedPlan {
  id: string;
  project_id: string;
  title: string;
  status: string;
  archived_at: string | null;
  project_name: string;
}

/** 历史资产统计（/history/summary） */
interface HistorySummary {
  transferableTasks: number;
  transferablePlans: number;
  archivedTasks: number;
  archivedPlans: number;
  archivedProjects: number;
  firstArchivedAt: string | null;
  lastArchivedAt: string | null;
}

const PAGE_SIZE = 20;

/**
 * 历史资产页（T00589）：把指定项目的已完结内容（已完成任务 + 已完结计划）整体转移至历史区，
 * 供查看、沉淀与追溯查询，避免长期使用历史完结内容堆积。
 * 设计参考 GitHub 仓库视图：统计卡片 + 分区列表 + 搜索/筛选/分页 + 批量操作。
 */
export function HistoryPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [archived, setArchived] = useState<Task[]>([]);
  const [plans, setPlans] = useState<ArchivedPlan[]>([]);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
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

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3200); };

  const load = useCallback(async () => {
    const [ps, tasks, pls] = await Promise.all([
      api.get<Project[]>('/projects'),
      api.get<Task[]>('/tasks?archived=1'),
      api.get<ArchivedPlan[]>('/plans/archived').catch(() => [] as ArchivedPlan[]),
    ]);
    setProjects(ps);
    setProjectNames(Object.fromEntries(ps.map((p) => [p.id, p.name])));
    setArchived(tasks);
    setPlans(pls);
    try {
      const q = projetQuery(transferProject);
      setSummary(await api.get<HistorySummary>(`/history/summary${q}`));
    } catch { setSummary(null); }
  }, [transferProject]);

  useEffect(() => { void load(); }, [load]);

  function projetQuery(projectId: string): string {
    return projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  }

  // ---------- 过滤 + 分页 ----------

  const filteredTasks = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return archived.filter((t) => {
      if (projFilter && t.project_id !== projFilter) return false;
      if (k && !`${t.title} ${t.task_no ?? ''}`.toLowerCase().includes(k)) return false;
      return true;
    });
  }, [archived, kw, projFilter]);

  const filteredPlans = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return plans.filter((p) => {
      if (projFilter && p.project_id !== projFilter) return false;
      if (k && !`${p.title} ${p.project_name}`.toLowerCase().includes(k)) return false;
      return true;
    });
  }, [plans, kw, projFilter]);

  const taskPages = Math.max(1, Math.ceil(filteredTasks.length / PAGE_SIZE));
  const planPages = Math.max(1, Math.ceil(filteredPlans.length / PAGE_SIZE));
  const pageTasks = filteredTasks.slice((Math.min(page, taskPages) - 1) * PAGE_SIZE, Math.min(page, taskPages) * PAGE_SIZE);
  const pagePlans = filteredPlans.slice((Math.min(planPage, planPages) - 1) * PAGE_SIZE, Math.min(planPage, planPages) * PAGE_SIZE);

  // ---------- 转移（核心动作） ----------

  async function transfer() {
    if (!transferProject) return flash('请先选择要转移的项目');
    const name = projectNames[transferProject] ?? transferProject;
    const t = summary?.transferableTasks ?? 0;
    const p = summary?.transferablePlans ?? 0;
    if (t + p === 0) return flash('该项目没有可转移的已完结内容（已完成任务 / 已完结计划）');
    if (!(await askConfirm(`将项目「${name}」的已完结内容整体转移至历史资产？\n· 已完成任务 ${t} 条\n· 已完结计划 ${p} 条\n转移后可在本页查看、还原或彻底删除。`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; tasks: number; plans: number }>('/history/transfer', { projectId: transferProject });
      flash(`转移完成：任务 ${r.tasks} 条、计划 ${r.plans} 条已进入历史资产`);
      setSelTaskIds([]); setSelPlanIds([]);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  // ---------- 单条 / 批量操作（与归档管理一致） ----------

  async function restoreTask(id: string) {
    await api.post('/archive/restore', { taskIds: [id] });
    void load();
  }
  async function purgeTask(id: string, title: string) {
    if (!(await askConfirm(`永久删除历史任务「${title}」？此操作不可恢复。`))) return;
    await api.del('/archive', { taskIds: [id] });
    void load();
  }
  async function restorePlan(id: string) {
    await api.post(`/plans/${id}/restore`);
    void load();
  }
  async function purgePlan(id: string, title: string) {
    if (!(await askConfirm(`彻底删除历史计划「${title}」？此操作不可恢复。`))) return;
    await api.del(`/plans/${id}`);
    void load();
  }

  function toggleTask(id: string) {
    setSelTaskIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function togglePlan(id: string) {
    setSelPlanIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function batchRestore(kind: 'task' | 'plan') {
    const ids = kind === 'task' ? selTaskIds : selPlanIds;
    if (ids.length === 0) return;
    setBusy(true);
    let n = 0;
    try {
      if (kind === 'task') {
        await api.post('/archive/restore', { taskIds: ids });
        n = ids.length;
      } else {
        for (const id of ids) { try { await api.post(`/plans/${id}/restore`); n += 1; } catch { /* 继续 */ } }
      }
      flash(`已还原 ${n} 条`);
      setSelTaskIds([]); setSelPlanIds([]);
      await load();
    } finally { setBusy(false); }
  }

  async function batchPurge(kind: 'task' | 'plan') {
    const ids = kind === 'task' ? selTaskIds : selPlanIds;
    if (ids.length === 0) return;
    if (!(await askConfirm(`永久删除选中的 ${ids.length} 条历史${kind === 'task' ? '任务' : '计划'}？此操作不可恢复。`))) return;
    setBusy(true);
    let n = 0;
    try {
      if (kind === 'task') {
        await api.del('/archive', { taskIds: ids });
        n = ids.length;
      } else {
        for (const id of ids) { try { await api.del(`/plans/${id}`); n += 1; } catch { /* 继续 */ } }
      }
      flash(`已永久删除 ${n} 条`);
      setSelTaskIds([]); setSelPlanIds([]);
      await load();
    } finally { setBusy(false); }
  }

  const statCards: Array<{ label: string; value: string; hint: string }> = [
    { label: '可转移任务', value: String(summary?.transferableTasks ?? 0), hint: '所选项目中已完成的活跃任务' },
    { label: '可转移计划', value: String(summary?.transferablePlans ?? 0), hint: '所选项目中已完结的计划条目' },
    { label: '历史任务', value: String(summary?.archivedTasks ?? 0), hint: '已进入历史资产的任务总数' },
    { label: '历史计划', value: String(summary?.archivedPlans ?? 0), hint: '已进入历史资产的计划总数' },
  ];

  return (
    <section>
      <style>{`
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
      `}</style>

      {notice && <div style={{ position: 'fixed', top: 12, right: 16, zIndex: 200, padding: '6px 12px', borderRadius: 6, background: 'var(--card-bg)', border: '1px solid var(--accent)', fontSize: 12, color: 'var(--text)' }}>{notice}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <History size={16} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 16, margin: 0 }}>历史资产</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>已完结内容的沉淀与追溯——按项目整体转移，可随时还原</span>
      </div>

      {/* 统计卡片（参考 GitHub 仓库概览） */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10, margin: '12px 0' }}>
        {statCards.map((c) => (
          <div key={c.label} title={c.hint} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>{c.value}</div>
          </div>
        ))}
      </div>
      {(summary?.firstArchivedAt || summary?.lastArchivedAt) && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          历史时间跨度：{summary.firstArchivedAt ? relTime(summary.firstArchivedAt) : '—'} ~ {summary.lastArchivedAt ? relTime(summary.lastArchivedAt) : '—'}（覆盖 {summary.archivedProjects} 个项目）
        </div>
      )}

      {/* 转移区 + 工具条 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', marginBottom: 10 }}>
        <select value={transferProject} onChange={(e) => { setTransferProject(e.target.value); setPage(1); setPlanPage(1); }}
          aria-label="选择转移项目" title="选择要转移已完结内容的项目"
          style={{ padding: 4, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">选择项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={() => void transfer()} disabled={busy || !transferProject} className="tbtn-anim"
          title="把所选项目的已完成任务与已完结计划整体转移至历史资产"
          aria-label="转移至历史资产"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, cursor: transferProject ? 'pointer' : 'not-allowed', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 12, opacity: transferProject ? 1 : 0.5 }}>
          <Archive size={13} /> 转移至历史资产
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={() => { setMulti((m) => !m); setSelTaskIds([]); setSelPlanIds([]); }}
          className="tbtn-anim"
          title={multi ? '退出多选模式' : '多选模式 — 勾选历史条目后批量还原/删除'}
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

      {/* 批量工具条 */}
      {(selTaskIds.length > 0 || selPlanIds.length > 0) && (
        <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 10px', marginBottom: 10, borderRadius: 8, background: 'var(--card-bg)', border: '1px solid var(--accent)', fontSize: 12 }}>
          <strong style={{ color: 'var(--accent)' }}>已选 任务 {selTaskIds.length} / 计划 {selPlanIds.length}</strong>
          <button onClick={() => void batchRestore('task')} disabled={busy || selTaskIds.length === 0} className="tbtn-anim"
            title="批量还原选中任务" aria-label="批量还原任务"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '2px 4px' }}>
            <RotateCcw size={14} /> 还原任务
          </button>
          <button onClick={() => void batchPurge('task')} disabled={busy || selTaskIds.length === 0} className="tbtn-anim"
            title="批量彻底删除选中任务" aria-label="批量删除任务"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', padding: '2px 4px' }}>
            <Trash2 size={14} /> 删除任务
          </button>
          <button onClick={() => void batchRestore('plan')} disabled={busy || selPlanIds.length === 0} className="tbtn-anim"
            title="批量恢复选中计划" aria-label="批量恢复计划"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '2px 4px' }}>
            <RotateCcw size={14} /> 恢复计划
          </button>
          <button onClick={() => void batchPurge('plan')} disabled={busy || selPlanIds.length === 0} className="tbtn-anim"
            title="批量彻底删除选中计划" aria-label="批量删除计划"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', padding: '2px 4px' }}>
            <Trash2 size={14} /> 删除计划
          </button>
          <button onClick={() => { setSelTaskIds([]); setSelPlanIds([]); }} disabled={busy} className="tbtn-anim"
            title="取消选择" aria-label="取消选择"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '2px 4px' }}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* 历史任务区 */}
      <h4 style={{ fontSize: 14, margin: '0 0 8px' }}>历史任务（{filteredTasks.length}）</h4>
      {filteredTasks.length === 0 && <p style={{ color: 'var(--text-muted)' }}>暂无历史任务。选择项目点击「转移至历史资产」把已完成内容沉淀到这里。</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pageTasks.map((t) => (
          <li key={t.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selTaskIds.includes(t.id)} aria-label={`选中历史任务 ${t.title}`}
                onChange={() => toggleTask(t.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.task_no ? `${t.task_no} ` : ''}{t.title}（{projectNames[t.project_id] ?? '未知项目'}）
            </span>
            <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${t.archived_at ?? ''}`}>{relTime(t.archived_at)}</span>
            <button className="abtn" onClick={() => void restoreTask(t.id)} title="还原 — 恢复该任务到原项目列表" aria-label="还原该历史任务" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void purgeTask(t.id, t.title)} title="彻底删除 — 不可恢复" aria-label="彻底删除该历史任务" style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {taskPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} title="上一页" aria-label="上一页"
            style={{ cursor: page <= 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: page <= 1 ? 0.5 : 1 }}>上一页</button>
          <span>第 {Math.min(page, taskPages)} / {taskPages} 页</span>
          <button onClick={() => setPage(Math.min(taskPages, page + 1))} disabled={page >= taskPages} title="下一页" aria-label="下一页"
            style={{ cursor: page >= taskPages ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: page >= taskPages ? 0.5 : 1 }}>下一页</button>
        </div>
      )}

      {/* 历史计划区 */}
      <h4 style={{ fontSize: 14, margin: '20px 0 8px' }}>历史计划（{filteredPlans.length}）</h4>
      {filteredPlans.length === 0 && <p style={{ color: 'var(--text-muted)' }}>暂无历史计划。</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pagePlans.map((p) => (
          <li key={p.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selPlanIds.includes(p.id)} aria-label={`选中历史计划 ${p.title}`}
                onChange={() => togglePlan(p.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}（{p.project_name}）</span>
            <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${p.archived_at ?? ''}`}>{relTime(p.archived_at)}</span>
            <button className="abtn" onClick={() => void restorePlan(p.id)} title="恢复 — 还原到项目计划时间线" aria-label="恢复该历史计划" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void purgePlan(p.id, p.title)} title="彻底删除 — 不可恢复" aria-label="彻底删除该历史计划" style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {planPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
          <button onClick={() => setPlanPage(Math.max(1, planPage - 1))} disabled={planPage <= 1} title="上一页" aria-label="上一页（计划）"
            style={{ cursor: planPage <= 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: planPage <= 1 ? 0.5 : 1 }}>上一页</button>
          <span>第 {Math.min(planPage, planPages)} / {planPages} 页</span>
          <button onClick={() => setPlanPage(Math.min(planPages, planPage + 1))} disabled={planPage >= planPages} title="下一页" aria-label="下一页（计划）"
            style={{ cursor: planPage >= planPages ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: planPage >= planPages ? 0.5 : 1 }}>下一页</button>
        </div>
      )}
    </section>
  );
}
