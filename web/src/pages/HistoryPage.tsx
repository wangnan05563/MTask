import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Project } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Archive, ChevronDown, ChevronUp, FolderInput, History, RotateCcw, Search, X } from 'lucide-react';
import { relTime } from '../ui/format';
import { useSessionState } from '../ui/session';

/** 快照内任务（只读） */
interface SnapTask {
  id: string;
  task_no: string | null;
  title: string;
  description: string;
  status: string;
  verified: number;
  priority: string;
  handle_result: string | null;
  created_at: string;
}
/** 快照内计划（只读） */
interface SnapPlan {
  id: string;
  title: string;
  description: string | null;
  kind: string | null;
  status: string;
  progress: number | null;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
}
/** 项目快照 */
interface Snapshot {
  id: string;
  name: string;
  description: string;
  history_at: string;
  stats: { tasks: number; doneTasks: number; plans: number; donePlans: number };
  tasks: SnapTask[];
  plans: SnapPlan[];
}

interface HistorySummary {
  activeProjects: number;
  snapshotProjects: number;
  snapshotTasks: number;
  snapshotPlans: number;
  firstHistoryAt: string | null;
  lastHistoryAt: string | null;
}

const PAGE_SIZE = 10;

/**
 * 历史资产页（T00589 二轮：**项目级快照**）。
 * 「归档」= 软删除区；「历史资产」= 项目整体沉淀为快照——沉淀后该项目在任务/计划菜单的项目列表中不再出现，
 * 本页以**项目为单位**查看快照全量内容，并支持整体恢复（回活跃）或归档删除（转归档区）。
 */
export function HistoryPage() {
  const [activeProjects, setActiveProjects] = useState<Project[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [transferProject, setTransferProject] = useSessionState<string>('history.transferProject', '');
  const [kw, setKw] = useSessionState<string>('history.kw', '');
  const [openIds, setOpenIds] = useSessionState<string[]>('history.openSnaps', []);
  const [page, setPage] = useState(1);

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3200); };

  const load = useCallback(async () => {
    const [ps, data, sum] = await Promise.all([
      api.get<Project[]>('/projects'),                       // 默认仅活跃项目（沉淀后自动不在其中）
      api.get<{ snapshots: Snapshot[] }>('/history/list'),
      api.get<HistorySummary>('/history/summary').catch(() => null),
    ]);
    setActiveProjects(ps);
    setSnapshots(data.snapshots);
    setSummary(sum);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return snapshots.filter((s) => !k || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(k));
  }, [snapshots, kw]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const pageSnaps = filtered.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

  function toggleOpen(id: string) {
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** 沉淀：整个项目转为历史快照 */
  async function transfer() {
    if (!transferProject) return flash('请先选择要沉淀的项目');
    const name = activeProjects.find((p) => p.id === transferProject)?.name ?? transferProject;
    if (!(await askConfirm(`将项目「${name}」整体沉淀为历史资产快照？\n\n沉淀后：\n· 该项目在任务菜单/项目计划菜单的项目列表中不再出现\n· 全部任务与计划以快照形式保留在本页，可整体恢复或归档删除\n· 项目名将被占用（新建同名项目会被拒绝）`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; tasks: number; plans: number; projectName: string }>('/history/transfer', { projectId: transferProject });
      flash(`已沉淀快照「${r.projectName}」：任务 ${r.tasks} 条、计划 ${r.plans} 条`);
      setTransferProject('');
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  /** 恢复：整个快照回到活跃项目 */
  async function restore(s: Snapshot) {
    if (!(await askConfirm(`将快照「${s.name}」整体恢复为活跃项目？\n恢复后该项目重新出现在任务/计划菜单的项目列表。`))) return;
    setBusy(true);
    try {
      await api.post('/history/restore', { projectId: s.id });
      flash(`快照「${s.name}」已恢复为活跃项目`);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  /** 归档删除：整个快照转归档区（软删除，可经归档菜单恢复） */
  async function toArchive(s: Snapshot) {
    if (!(await askConfirm(`将快照「${s.name}」整体归档删除？\n\n· 该项目的 ${s.stats.tasks} 条任务与 ${s.stats.plans} 条计划将转入「归档」区（软删除）\n· 项目本身标记为已归档`))) return;
    setBusy(true);
    try {
      const r = await api.post<{ tasks: number; plans: number }>('/history/to-archive', { projectId: s.id });
      flash(`已归档删除「${s.name}」：任务 ${r.tasks} 条、计划 ${r.plans} 条已转入归档区`);
      await load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  const statCards = [
    { label: '活跃项目', value: summary?.activeProjects ?? 0, hint: '当前任务/计划菜单可见的项目' },
    { label: '历史快照', value: summary?.snapshotProjects ?? 0, hint: '已整体沉淀的项目快照' },
    { label: '快照任务', value: summary?.snapshotTasks ?? 0, hint: '快照内保留的任务总数' },
    { label: '快照计划', value: summary?.snapshotPlans ?? 0, hint: '快照内保留的计划总数' },
  ];

  return (
    <section>
      <style>{`
        .snap-card:hover { border-color: var(--accent) !important; }
      `}</style>

      {notice && <div style={{ position: 'fixed', top: 12, right: 16, zIndex: 200, padding: '6px 12px', borderRadius: 6, background: 'var(--card-bg)', border: '1px solid var(--accent)', fontSize: 12, color: 'var(--text)' }}>{notice}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <History size={16} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 16, margin: 0 }}>历史资产</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          项目级组织过程资产沉淀——项目整体转为快照后从任务/计划菜单隐去；<strong style={{ color: 'var(--text)' }}>归档</strong>为软删除区，二者独立
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
          沉淀时间跨度：{summary.firstHistoryAt ? relTime(summary.firstHistoryAt) : '—'} ~ {summary.lastHistoryAt ? relTime(summary.lastHistoryAt) : '—'}
        </div>
      )}

      {/* 沉淀操作 + 搜索 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', marginBottom: 12 }}>
        <select value={transferProject} onChange={(e) => setTransferProject(e.target.value)}
          aria-label="选择要沉淀的项目" title="选择一个活跃项目整体沉淀为历史快照"
          style={{ padding: 4, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">选择项目…</option>
          {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={() => void transfer()} disabled={busy || !transferProject} className="tbtn-anim"
          title="把所选项目整体沉淀为历史资产快照" aria-label="沉淀为历史快照"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, cursor: transferProject ? 'pointer' : 'not-allowed', border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 12, opacity: transferProject ? 1 : 0.5 }}>
          <FolderInput size={13} /> 沉淀为历史快照
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 8px' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input value={kw} onChange={(e) => { setKw(e.target.value); setPage(1); }}
            placeholder="搜索快照项目…" aria-label="搜索历史快照"
            style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, width: 160 }} />
          {kw && <button onClick={() => setKw('')} title="清除搜索" aria-label="清除搜索" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}><X size={12} /></button>}
        </span>
      </div>

      {filtered.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          暂无历史快照。选择一个活跃项目点击「沉淀为历史快照」——沉淀后该项目从任务/计划菜单隐去，内容以快照形式在此留存。
        </p>
      )}

      {/* 项目快照列表（每项为一个项目快照） */}
      {pageSnaps.map((s) => {
        const open = openIds.includes(s.id);
        return (
          <div key={s.id} className="snap-card"
            style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', marginBottom: 10, transition: 'border-color .15s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', flexWrap: 'wrap' }}>
              <button onClick={() => toggleOpen(s.id)} className="tbtn-anim"
                title={open ? '收起快照内容' : '展开快照内容（任务与计划）'}
                aria-label={open ? '收起快照内容' : '展开快照内容'}
                style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex', padding: 0 }}>
                {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
              <strong style={{ fontSize: 14, color: 'var(--text)' }}>{s.name}</strong>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                任务 {s.stats.tasks}（完成 {s.stats.doneTasks}）· 计划 {s.stats.plans}（完结 {s.stats.donePlans}）· 沉淀于 {relTime(s.history_at)}
              </span>
              <span style={{ flex: 1 }} />
              <button onClick={() => void restore(s)} disabled={busy} className="tbtn-anim"
                title="恢复 — 该快照整体恢复为活跃项目（重新出现在任务/计划菜单）" aria-label="恢复该快照"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }}>
                <RotateCcw size={12} /> 恢复
              </button>
              <button onClick={() => void toArchive(s)} disabled={busy} className="tbtn-anim"
                title="归档删除 — 整个项目内容转入归档区（软删除，可恢复）" aria-label="归档删除该快照"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--danger)', fontSize: 12, cursor: 'pointer' }}>
                <Archive size={12} /> 归档删除
              </button>
            </div>

            {open && (
              <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>任务快照（{s.tasks.length}）</div>
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                    {s.tasks.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>无任务</div>}
                    {s.tasks.map((t) => (
                      <div key={t.id} title={t.description || t.handle_result || ''} style={{ fontSize: 12, color: 'var(--text)', padding: '3px 0', borderBottom: '1px solid var(--surface-2)', display: 'flex', gap: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--accent)', flexShrink: 0 }}>{t.task_no ?? '—'}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                        <span style={{ fontSize: 11, color: t.status === 'done' ? 'var(--success, #16a34a)' : 'var(--text-muted)', flexShrink: 0 }}>{t.status === 'done' ? '已完成' : '待办'}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>计划快照（{s.plans.length}）</div>
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                    {s.plans.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>无计划</div>}
                    {s.plans.map((p) => (
                      <div key={p.id} title={p.description ?? ''} style={{ fontSize: 12, color: 'var(--text)', padding: '3px 0', borderBottom: '1px solid var(--surface-2)', display: 'flex', gap: 6 }}>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                          {p.kind === 'milestone' ? '里程碑 · ' : ''}{p.status}{typeof p.progress === 'number' ? ` · ${p.progress}%` : ''}{p.duration_days !== null && p.duration_days !== undefined ? ` · ${p.duration_days}天` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} title="上一页" aria-label="上一页"
            style={{ cursor: page <= 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: page <= 1 ? 0.5 : 1 }}>上一页</button>
          <span>第 {cur} / {pages} 页</span>
          <button onClick={() => setPage(Math.min(pages, page + 1))} disabled={page >= pages} title="下一页" aria-label="下一页"
            style={{ cursor: page >= pages ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: page >= pages ? 0.5 : 1 }}>下一页</button>
        </div>
      )}
    </section>
  );
}
