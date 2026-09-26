import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Project, type Prompt, type PromptCategory, type Task, type TaskCategory } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Check, ListChecks, Search, Trash2, Undo2, X } from 'lucide-react';
import { relTime } from '../ui/format';
import { useSessionState } from '../ui/session';

/** 项目计划归档条目（T00442 扩展：计划「删除」改归档后，在此恢复或彻底删除） */
interface ArchivedPlan {
  id: string;
  project_id: string;
  title: string;
  status: string;
  archived_at: string | null;
  project_name: string;
}

const PAGE_SIZE = 20;

/**
 * 归档管理页（T00442 扩展 / T00586）：任务与计划两个归档区。
 * T00586：参考项目计划页——多选 + 批量工具条（风格/布局一致）+ 搜索 + 分类/项目查询 + 分页。
 */
export function ArchivePage() {
  const [archived, setArchived] = useState<Task[]>([]);
  // 项目 id -> 名称 映射，用于标注归档任务所属项目（任务本身只带 project_id）
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  // T00442 扩展：项目计划归档列表
  const [archivedPlans, setArchivedPlans] = useState<ArchivedPlan[]>([]);
  const [cats, setCats] = useState<TaskCategory[]>([]);
  // T00872：归档提示词列表 + 分类名映射（后端 /prompts?archived=1 返回软删数据，可在此还原/彻底删除）
  const [archivedPrompts, setArchivedPrompts] = useState<Prompt[]>([]);
  const [promptCatNames, setPromptCatNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  // T00586：多选模式 + 搜索 + 分类/项目筛选 + 分页（会话级保持，切页不丢）
  const [multi, setMulti] = useSessionState<boolean>('archive.multi', false);
  const [selTaskIds, setSelTaskIds] = useSessionState<string[]>('archive.selTasks', []);
  const [selPlanIds, setSelPlanIds] = useSessionState<string[]>('archive.selPlans', []);
  const [kw, setKw] = useSessionState<string>('archive.kw', '');
  const [catFilter, setCatFilter] = useSessionState<string>('archive.catFilter', '');
  const [projFilter, setProjFilter] = useSessionState<string>('archive.projFilter', '');
  const [page, setPage] = useState(1);
  const [planPage, setPlanPage] = useState(1);
  const [promptPage, setPromptPage] = useState(1); // T00872：归档提示词分页页脚

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  const load = useCallback(async () => {
    setArchived(await api.get<Task[]>('/tasks?archived=1'));
    setProjectNames(Object.fromEntries((await api.get<Project[]>('/projects')).map((p) => [p.id, p.name])));
    try { setCats(await api.get<TaskCategory[]>('/tasks/categories')); } catch { /* 旧版后端忽略 */ }
    try {
      // 归档计划接口走 plans 路由（T00442 扩展），后端未升级时静默降级不阻塞任务归档区
      setArchivedPlans(await api.get<ArchivedPlan[]>('/plans/archived'));
    } catch { /* 后端为旧版时忽略 */ }
    try {
      // T00872：归档提示词——/prompts?archived=1 返回软删提示词；还原走 PATCH archived=false，删除走 DELETE
      setArchivedPrompts(await api.get<Prompt[]>('/prompts?archived=1'));
      const pcs = await api.get<PromptCategory[]>('/prompt-categories');
      setPromptCatNames(Object.fromEntries(pcs.map((c) => [c.id, c.name])));
    } catch { /* 后端为旧版时忽略 */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ---------- 过滤 + 分页（T00586） ----------

  const filteredTasks = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return archived.filter((t) => {
      if (k && !`${t.title} ${t.task_no ?? ''}`.toLowerCase().includes(k)) return false;
      if (catFilter && (t.category_id ?? '') !== catFilter) return false;
      return true;
    });
  }, [archived, kw, catFilter]);

  const filteredPlans = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return archivedPlans.filter((p) => {
      if (k && !`${p.title} ${p.project_name}`.toLowerCase().includes(k)) return false;
      if (projFilter && p.project_id !== projFilter) return false;
      return true;
    });
  }, [archivedPlans, kw, projFilter]);

  // T00872：归档提示词——支持关键词过滤（标题），与任务/计划区共用 kw
  const filteredPrompts = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return archivedPrompts.filter((p) => !k || p.title.toLowerCase().includes(k));
  }, [archivedPrompts, kw]);

  const promptPages = Math.max(1, Math.ceil(filteredPrompts.length / PAGE_SIZE));

  const taskPages = Math.max(1, Math.ceil(filteredTasks.length / PAGE_SIZE));
  const planPages = Math.max(1, Math.ceil(filteredPlans.length / PAGE_SIZE));
  const curTaskPage = Math.min(page, taskPages);
  const curPlanPage = Math.min(planPage, planPages);
  const pageTasks = filteredTasks.slice((curTaskPage - 1) * PAGE_SIZE, curTaskPage * PAGE_SIZE);
  const pagePlans = filteredPlans.slice((curPlanPage - 1) * PAGE_SIZE, curPlanPage * PAGE_SIZE);
  const curPromptPage = Math.min(promptPage, promptPages);
  const pagePrompts = filteredPrompts.slice((curPromptPage - 1) * PAGE_SIZE, curPromptPage * PAGE_SIZE);

  // ---------- 单条操作（原有） ----------

  async function restore(task: Task) {
    await api.post('/archive/restore', { taskIds: [task.id] });
    void load();
  }

  async function remove(task: Task) {
    const ok = await askConfirm(`确认永久删除任务「${task.title}」？此操作不可恢复。`);
    if (!ok) return;
    await api.del('/archive', { taskIds: [task.id] });
    void load();
  }

  async function restorePlan(p: ArchivedPlan) {
    await api.post(`/plans/${p.id}/restore`);
    void load();
  }

  async function purgePlan(p: ArchivedPlan) {
    const ok = await askConfirm(`确认彻底删除计划「${p.title}」？此操作不可恢复（归档后仅剩此副本）。`);
    if (!ok) return;
    await api.del(`/plans/${p.id}`);
    void load();
  }

  // T00872：归档提示词还原（PATCH archived=false）与彻底删除（DELETE /prompts/:id）
  async function restorePrompt(p: Prompt) {
    await api.patch(`/prompts/${p.id}`, { archived: false });
    void load();
  }

  async function removePrompt(p: Prompt) {
    const ok = await askConfirm(`确认彻底删除提示词「${p.title}」？此操作不可恢复。`);
    if (!ok) return;
    await api.del(`/prompts/${p.id}`);
    void load();
  }

  // ---------- T00586：批量操作（参考计划页批量工具条） ----------

  function toggleTask(id: string) {
    setSelTaskIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function togglePlan(id: string) {
    setSelPlanIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function selectAllTasks() {
    setSelTaskIds((prev) => (prev.length === pageTasks.length ? [] : pageTasks.map((t) => t.id)));
  }
  function selectAllPlans() {
    setSelPlanIds((prev) => (prev.length === pagePlans.length ? [] : pagePlans.map((p) => p.id)));
  }

  async function batchRestoreTasks() {
    if (selTaskIds.length === 0) return;
    setBusy(true);
    try {
      await api.post('/archive/restore', { taskIds: selTaskIds });
      flash(`已还原 ${selTaskIds.length} 条归档任务`);
      setSelTaskIds([]);
      void load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function batchPurgeTasks() {
    if (selTaskIds.length === 0) return;
    if (!(await askConfirm(`永久删除选中的 ${selTaskIds.length} 条归档任务？此操作不可恢复。`))) return;
    setBusy(true);
    try {
      await api.del('/archive', { taskIds: selTaskIds });
      flash(`已永久删除 ${selTaskIds.length} 条任务`);
      setSelTaskIds([]);
      void load();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function batchRestorePlans() {
    if (selPlanIds.length === 0) return;
    setBusy(true);
    let n = 0;
    try {
      for (const id of selPlanIds) {
        try { await api.post(`/plans/${id}/restore`); n += 1; } catch { /* 单条失败继续 */ }
      }
      flash(`已恢复 ${n} 条归档计划`);
      setSelPlanIds([]);
      void load();
    } finally { setBusy(false); }
  }

  async function batchPurgePlans() {
    if (selPlanIds.length === 0) return;
    if (!(await askConfirm(`彻底删除选中的 ${selPlanIds.length} 条归档计划？此操作不可恢复。`))) return;
    setBusy(true);
    let n = 0;
    try {
      for (const id of selPlanIds) {
        try { await api.del(`/plans/${id}`); n += 1; } catch { /* 单条失败继续 */ }
      }
      flash(`已彻底删除 ${n} 条计划`);
      setSelPlanIds([]);
      void load();
    } finally { setBusy(false); }
  }

  /** 批量工具条（T00586）：风格与计划页一致——accent 边框 + 已选计数 + 纯图标按钮 */
  function renderBatchBar(kind: 'task' | 'plan') {
    const ids = kind === 'task' ? selTaskIds : selPlanIds;
    if (ids.length === 0) return null;
    // S3358：将嵌套三元拆为独立变量，避免嵌套条件表达式
    const pageCount = kind === 'task' ? pageTasks.length : pagePlans.length;
    const selectAllTitle = ids.length === pageCount ? '取消全选本页' : '全选本页';
    return (
      <div style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 10px', margin: '8px 0', borderRadius: 8, background: 'var(--card-bg)', border: '1px solid var(--accent)', boxShadow: '0 4px 12px rgba(0,0,0,.12)', fontSize: 12 }}>
        <strong style={{ color: 'var(--accent)' }}>已选 {ids.length} 条</strong>
        <button onClick={kind === 'task' ? selectAllTasks : selectAllPlans} disabled={busy} className="tbtn-anim"
          title={selectAllTitle}
          aria-label="全选本页"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text)' }}>
          <ListChecks size={14} />
        </button>
        <button onClick={() => void (kind === 'task' ? batchRestoreTasks() : batchRestorePlans())} disabled={busy} className="tbtn-anim"
          title="批量还原 — 将选中条目还原到原列表" aria-label="批量还原"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--accent)' }}>
          <Undo2 size={14} />
        </button>
        <button onClick={() => void (kind === 'task' ? batchPurgeTasks() : batchPurgePlans())} disabled={busy} className="tbtn-anim"
          title="批量彻底删除 — 不可恢复" aria-label="批量彻底删除"
          style={{ cursor: 'pointer', padding: '2px 4px', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--danger)' }}>
          <Trash2 size={14} />
        </button>
        <button onClick={() => (kind === 'task' ? setSelTaskIds([]) : setSelPlanIds([]))} disabled={busy} className="tbtn-anim"
          title="取消选择" aria-label="取消选择"
          style={{ cursor: 'pointer', padding: '2px 4px', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text)' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  /** 分页控件（T00586） */
  function renderPager(cur: number, total: number, set: (n: number) => void) {
    if (total <= 1) return null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', fontSize: 12, color: 'var(--text-muted)' }}>
        <button onClick={() => set(Math.max(1, cur - 1))} disabled={cur <= 1} className="tbtn-anim"
          title="上一页" aria-label="上一页"
          style={{ cursor: cur <= 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: cur <= 1 ? 0.5 : 1 }}>上一页</button>
        <span>第 {cur} / {total} 页</span>
        <button onClick={() => set(Math.min(total, cur + 1))} disabled={cur >= total} className="tbtn-anim"
          title="下一页" aria-label="下一页"
          style={{ cursor: cur >= total ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', opacity: cur >= total ? 0.5 : 1 }}>下一页</button>
      </div>
    );
  }

  return (
    <section>
      {/* 悬浮操作按钮 + 行 hover 高亮 + 相对时间：类名与任务页体验一致，聚焦当前行减少视觉噪音 */}
      <style>{`
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
      `}</style>

      {notice && <div style={{ position: 'fixed', top: 12, right: 16, zIndex: 200, padding: '6px 12px', borderRadius: 6, background: 'var(--card-bg)', border: '1px solid var(--accent)', fontSize: 12, color: 'var(--text)' }}>{notice}</div>}

      {/* T00586：顶部工具区——多选开关 + 搜索 + 分类/项目筛选（对齐计划页工具栏风格） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>归档管理</h3>
        <span style={{ flex: 1 }} />
        {/* 多选模式（参考计划页：ListChecks/Check 图标切换） */}
        <button onClick={() => { setMulti((m) => !m); setSelTaskIds([]); setSelPlanIds([]); }}
          className="tbtn-anim"
          title={multi ? '退出多选模式' : '多选模式 — 勾选归档条目后批量还原/删除'}
          aria-label={multi ? '退出多选模式' : '进入多选模式'}
          style={{ fontSize: 12, padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', border: '1px solid var(--border-strong)', background: multi ? 'var(--accent)' : 'transparent', color: multi ? 'var(--accent-text)' : 'var(--text)' }}>
          {multi ? <Check size={13} /> : <ListChecks size={13} />}
        </button>
        {/* 搜索（标题/编号/项目名） */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 8px', background: 'var(--card-bg)' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input value={kw} onChange={(e) => { setKw(e.target.value); setPage(1); setPlanPage(1); setPromptPage(1); }}
            placeholder="搜索归档标题…" aria-label="搜索归档内容"
            style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, width: 150 }} />
          {kw && <button onClick={() => setKw('')} title="清除搜索" aria-label="清除搜索" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}><X size={12} /></button>}
        </span>
      </div>

      <h4 style={{ fontSize: 14, margin: '0 0 8px' }}>归档任务（{filteredTasks.length}）</h4>
      {/* 任务区筛选：分类 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <select value={catFilter} onChange={(e) => { setCatFilter(e.target.value); setPage(1); }}
          aria-label="按分类筛选归档任务" title="按分类筛选归档任务"
          style={{ padding: 3, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">全部分类</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {renderBatchBar('task')}
      {filteredTasks.length === 0 && <p style={{ color: 'var(--text-muted)' }}>暂无归档任务（或当前筛选无结果）。待办/已完成任务归档后在此管理。</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pageTasks.map((t) => (
          <li key={t.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selTaskIds.includes(t.id)} aria-label={`选中归档任务 ${t.title}`}
                onChange={() => toggleTask(t.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.task_no ? `${t.task_no} ` : ''}{t.title}（{projectNames[t.project_id] ?? '未知项目'} · {t.status === 'done' ? '已完成' : '待办'}
              {t.category_id ? ` · ${cats.find((c) => c.id === t.category_id)?.name ?? ''}` : ''}）
            </span>
            <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${t.archived_at ?? ''}`}>{relTime(t.archived_at)}</span>
            <button className="abtn" onClick={() => void restore(t)} title="还原 — 将该归档任务还原到待办列表" aria-label="还原：将该归档任务还原到待办列表" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void remove(t)} title="删除 — 永久删除该任务，此操作不可恢复" aria-label="删除：永久删除该任务，此操作不可恢复" style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {renderPager(curTaskPage, taskPages, (n) => setPage(n))}

      {/* T00442 扩展：项目计划归档区——计划「删除」改归档后在此恢复或彻底删除 */}
      <h4 style={{ fontSize: 14, margin: '20px 0 8px' }}>归档项目计划（{filteredPlans.length}）</h4>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <select value={projFilter} onChange={(e) => { setProjFilter(e.target.value); setPlanPage(1); }}
          aria-label="按项目筛选归档计划" title="按项目筛选归档计划"
          style={{ padding: 3, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">全部项目</option>
          {Object.entries(projectNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      {renderBatchBar('plan')}
      {filteredPlans.length === 0 && <p style={{ color: 'var(--text-muted)' }}>暂无归档的项目计划（或当前筛选无结果）。</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pagePlans.map((p) => (
          <li key={p.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            {multi && (
              <input type="checkbox" checked={selPlanIds.includes(p.id)} aria-label={`选中归档计划 ${p.title}`}
                onChange={() => togglePlan(p.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}（{p.project_name}）</span>
            <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${p.archived_at ?? ''}`}>{relTime(p.archived_at)}</span>
            <button className="abtn" onClick={() => void restorePlan(p)} title="恢复 — 将该计划还原到「项目计划」时间线并自动衔接排期" aria-label="恢复：将该计划还原到项目计划时间线" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void purgePlan(p)} title="删除 — 彻底删除该计划，此操作不可恢复" aria-label="删除：彻底删除该计划，此操作不可恢复" style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {renderPager(curPlanPage, planPages, (n) => setPlanPage(n))}

      {/* T00872：归档提示词区——提示词「归档」（软删）后在此还原或彻底删除 */}
      <h4 style={{ fontSize: 14, margin: '20px 0 8px' }}>归档提示词（{filteredPrompts.length}）</h4>
      {filteredPrompts.length === 0 && <p style={{ color: 'var(--text-muted)' }}>暂无归档提示词（或当前筛选无结果）。提示词页归档后的条目会出现在这里。</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pagePrompts.map((p) => (
          <li key={p.id} className="arena-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 4, borderBottom: '1px solid var(--surface-2)' }}>
            <span style={{ flex: 1, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.title}（{promptCatNames[p.category_id] ?? '未知分类'}）
            </span>
            <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={`归档时间：${p.archived_at ?? ''}`}>{relTime(p.archived_at)}</span>
            <button className="abtn" onClick={() => void restorePrompt(p)} title="还原 — 将该提示词还原到提示词页原分类" aria-label="还原：将该提示词还原到提示词页原分类" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Undo2 size={13} /></button>
            <button className="abtn" onClick={() => void removePrompt(p)} title="删除 — 彻底删除该提示词，此操作不可恢复" aria-label="删除：彻底删除该提示词，此操作不可恢复" style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      {renderPager(curPromptPage, promptPages, (n) => setPromptPage(n))}
    </section>
  );
}
