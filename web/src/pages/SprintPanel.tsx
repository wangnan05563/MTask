/**
 * 迭代面板（T03186 / PRD PM-201）：迭代增删改档 + 计划行挂载 + 燃尽双口径图 + 结束小结 + 变更留痕。
 *
 * 口径说明（与 `IterationService` 一致，展示层不重算）：
 *  - 迭代是**项目下计划行的带时间集合**（整合版 D-02）：这里挂载的对象是计划行，不是待办任务；
 *    任务通过既有的「计划→待办」关系间接参与，故本面板不提供任务级排期。
 *  - 归档迭代（PM-201①）只读且退出有效分母：列表默认不显示，勾选「含已归档」才出现，且所有写操作被禁用。
 *  - 剩余工期/剩余计划数与理想线全部由服务端给出；未来日不预判、缺失日不插值，只以文字说明呈现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BTN_SECONDARY_MD, FIELD_SM_BLOCK } from '../ui/primitives'; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
import type { ReactElement } from 'react';
import { Archive, CalendarRange, Layers, RefreshCw, RotateCcw, Sparkles, Trash2, Unlink } from 'lucide-react';
import { api } from '../api/client';
import { BurndownChart, BurndownLegend } from '../components/burndownChart';
import type { BurnPointView } from '../components/burndownChart';
import { askConfirm } from '../ui/dialogs';
import { CopyButton } from '../ui/CopyButton';

interface Iteration {
  id: string;
  name: string;
  goal: string;
  dod: string;
  start_date: string;
  end_date: string;
  status: string;
  archived: number;
  memberCount?: number;
  doneCount?: number;
}

interface MemberRow {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  status: string;
  progress: number;
}

interface PlanLite { id: string; title: string; start_date: string; end_date: string; status: string; archived?: number; iteration_id?: string | null }

interface Burndown {
  scope: { kind: string; name: string; startDate: string; endDate: string };
  points: BurnPointView[];
  dataFrom: string | null;
  missingDays: string[];
  tz: string;
  notes: string[];
  totals: { plans: number; done: number; undone: number; overdue: number; unknownCompleted: number };
}

interface Summary {
  totals: { plans: number; done: number; undone: number; overdue: number };
  done: MemberRow[];
  undone: MemberRow[];
  overdue: MemberRow[];
  notes: string[];
}

interface MemberEvent { id: string; plan_task_id: string; title: string | null; kind: string; detail: string; created_at: string }

/** 周报卡（PM-201⑥ / T03227）：服务端固化的结束小结快照，一迭代一份 */
interface WeeklyCardItem { id: string; title: string; start_date: string; end_date: string; status: string; progress: number; duration_days: number }
interface WeeklyCard {
  cardId: string;
  iterationId: string;
  name: string;
  period: { start: string; end: string };
  goal: string;
  dod: string;
  generatedAt: string;
  trigger: 'manual' | 'backfill';
  totals: { plans: number; done: number; undone: number; overdue: number };
  lists: { done: WeeklyCardItem[]; undone: WeeklyCardItem[]; overdue: WeeklyCardItem[] };
  notes: string[];
  markdown: string;
}

interface AttachResult {
  attached: string[];
  moved: Array<{ planTaskId: string; fromIteration: string; fromName: string }>;
  skipped: Array<{ planTaskId: string; reason: string }>;
  outsideWindow: Array<{ planTaskId: string; reason: string }>;
}

const STATUS_LABEL: Record<string, string> = { todo: '未开始', doing: '进行中', done: '已结束' };

const CARD = { border: '1px solid var(--border)', borderRadius: 8, padding: 10 } as const;
const BTN = BTN_SECONDARY_MD; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
const FIELD = FIELD_SM_BLOCK; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
const today = (): string => new Date().toISOString().slice(0, 10);

/** 新建/编辑迭代的表单态（空串=新建） */
interface Draft { editingId: string; name: string; goal: string; dod: string; startDate: string; endDate: string; status: string }
const emptyDraft = (): Draft => ({ editingId: '', name: '', goal: '', dod: '', startDate: today(), endDate: today(), status: 'doing' });

export function SprintPanel({ projectId, onClose, onPlansChanged }: {
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onPlansChanged?: () => void;
}): ReactElement {
  const [msg, setMsg] = useState('');
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [plans, setPlans] = useState<PlanLite[]>([]);
  const [pickIds, setPickIds] = useState<string[]>([]);
  const [selMemberIds, setSelMemberIds] = useState<string[]>([]);
  const [burn, setBurn] = useState<Burndown | null>(null);
  const [projectBurn, setProjectBurn] = useState<Burndown | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [card, setCard] = useState<WeeklyCard | null>(null);
  const [events, setEvents] = useState<MemberEvent[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 单一定时器：连续两次操作（如「创建」紧接「删除」）时，上一条的 4s 定时器会把下一条提前清掉（真机实测 1.2s 消失）
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setMsg(m);
    if (msgTimer.current) globalThis.clearTimeout(msgTimer.current);
    msgTimer.current = globalThis.setTimeout(() => { setMsg(''); msgTimer.current = null; }, 4000);
  }, []);
  useEffect(() => () => { if (msgTimer.current) globalThis.clearTimeout(msgTimer.current); }, []);

  const loadIterations = useCallback(async () => {
    const rows = await api.get<Iteration[]>(`/projects/${projectId}/iterations?includeArchived=${showArchived ? 1 : 0}`);
    setIterations(rows);
    // 选择态自愈：选中的迭代被删/被筛掉时回落第一条，避免面板停在空引用上
    setSelectedId((cur) => (rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? ''));
  }, [projectId, showArchived]);

  const loadPlans = useCallback(async () => {
    setPlans(await api.get<PlanLite[]>(`/plans?projectId=${projectId}`));
  }, [projectId]);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setMembers([]); setBurn(null); setSummary(null); setCard(null); setEvents([]); return; }
    const [detail, b, s, c, e] = await Promise.all([
      api.get<{ planTasks: MemberRow[] }>(`/iterations/${id}`),
      api.get<Burndown>(`/iterations/${id}/burndown`),
      api.get<Summary>(`/iterations/${id}/summary`),
      api.get<{ card: WeeklyCard | null }>(`/iterations/${id}/weekly-card`),
      api.get<MemberEvent[]>(`/iterations/${id}/events`),
    ]);
    setMembers(detail.planTasks ?? []);
    setBurn(b);
    setSummary(s);
    setCard(c.card);
    setEvents(e);
    setSelMemberIds([]);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadIterations(), loadPlans()]);
      } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    })();
  }, [loadIterations, loadPlans, flash]);

  useEffect(() => { void loadDetail(selectedId).catch((e) => flash(e instanceof Error ? e.message : String(e))); }, [selectedId, loadDetail, flash]);

  useEffect(() => {
    (async () => {
      try { setProjectBurn(await api.get<Burndown>(`/projects/${projectId}/burndown`)); }
      catch { setProjectBurn(null); } // 项目燃尽只是补充口径（无迭代时的整体视图），失败不阻断主流程
    })();
  }, [projectId, burn]);

  /** PM-201②③：挂载后由后端裁决跨项目/改绑/窗外，四个出口都可见（不静默） */
  async function doAttach(mode: 'add' | 'replace'): Promise<void> {
    if (!selectedId || pickIds.length === 0) { flash('请先勾选要加入迭代的计划行'); return; }
    setBusy(true);
    try {
      const r = await api.post<AttachResult>(`/iterations/${selectedId}/attach`, { planTaskIds: pickIds, mode });
      const parts = [`挂载 ${r.attached.length} 条`];
      if (r.moved.length) parts.push(`从其它迭代改绑 ${r.moved.length} 条（${r.moved.map((m) => m.fromName).join('、')}）`);
      if (r.outsideWindow.length) parts.push(`排期在窗外仍已挂载 ${r.outsideWindow.length} 条`);
      if (r.skipped.length) parts.push(`未挂载 ${r.skipped.length} 条：${r.skipped.map((s) => s.reason).join('；')}`);
      flash(parts.join(' · '));
      setPickIds([]);
      await Promise.all([loadIterations(), loadPlans(), loadDetail(selectedId)]);
      onPlansChanged?.();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function doDetach(): Promise<void> {
    if (!selectedId || selMemberIds.length === 0) { flash('请先勾选要移出的计划行'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ detached: string[]; skipped: Array<{ reason: string }> }>(`/iterations/${selectedId}/detach`, { planTaskIds: selMemberIds });
      const skippedNote = r.skipped.length ? `；${r.skipped.length} 条未动：${r.skipped[0].reason}` : '';
      flash(`已移出 ${r.detached.length} 条${skippedNote}`);
      await Promise.all([loadIterations(), loadPlans(), loadDetail(selectedId)]);
      onPlansChanged?.();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /**
   * 发周报卡（PM-201⑥ / T03227）：把当下的结束小结固化成一份可复制的卡片。
   * 「仅一份」是服务端裁决，前端只做回执呈现：已存在时原样返回既有卡，不伪造「已发布」，也不改写触发方。
   */
  async function publishCard(): Promise<void> {
    if (!selectedId) { flash('请先选择迭代'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ card: WeeklyCard; created: boolean }>(`/iterations/${selectedId}/weekly-card`, {});
      setCard(r.card);
      flash(r.created
        ? `已发布周报卡：完成 ${r.card.totals.done} · 未完成 ${r.card.totals.undone} · 逾期 ${r.card.totals.overdue}`
        : '该迭代已有周报卡，展示的是首份（重复发布不生成第二张）');
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function submitDraft(): Promise<void> {
    if (!draft.name.trim()) { flash('迭代名称必填'); return; }
    setBusy(true);
    try {
      const payload = {
        name: draft.name.trim(), goal: draft.goal, dod: draft.dod,
        startDate: draft.startDate, endDate: draft.endDate, status: draft.status,
      };
      const saved = draft.editingId
        ? await api.put<Iteration>(`/iterations/${draft.editingId}`, payload)
        : await api.post<Iteration>(`/projects/${projectId}/iterations`, payload);
      flash(draft.editingId ? `已更新迭代「${saved.name}」` : `已创建迭代「${saved.name}」`);
      setDraft(emptyDraft());
      setFormOpen(false);
      await loadIterations();
      setSelectedId(saved.id);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /** PM-201①：归档=只读且退出有效分母；删除=仅解绑（计划行保留） */
  async function act(id: string, kind: 'archive' | 'unarchive' | 'delete'): Promise<void> {
    const target = iterations.find((i) => i.id === id);
    if (kind === 'delete') {
      // 删除不可撤销（goal/dod 无法找回，计划行只是解绑），走 App 级确认框而非一键执行
      const ok = await askConfirm(`删除迭代「${target?.name ?? id}」？成员计划行会回到「未规划」（计划本身不删），迭代目标与完成定义将不可找回。`);
      if (!ok) return;
    }
    setBusy(true);
    try {
      if (kind === 'delete') {
        const r = await api.del<{ detached: number }>(`/iterations/${id}`);
        flash(`迭代已删除，${r.detached} 条计划行回到未规划（计划本身不删）`);
      } else {
        await api.post<{ archived: boolean }>(`/iterations/${id}/${kind}`, {});
        flash(kind === 'archive' ? '迭代已归档：转为只读并退出有效分母，成员归属保留以便回溯' : '迭代已恢复为可编辑');
      }
      // 删除后该 id 已不存在：只刷列表与计划行，详情交给选择态自愈后的 useEffect 去拉，
      // 否则会对着已删迭代发 详情/燃尽/小结 三个请求（真机实测 404+400+400）
      await Promise.all(kind === 'delete'
        ? [loadIterations(), loadPlans()]
        : [loadIterations(), loadPlans(), loadDetail(id)]);
      onPlansChanged?.();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const unassigned = useMemo(() => plans.filter((p) => !p.iteration_id), [plans]);
  const selected = iterations.find((i) => i.id === selectedId) ?? null;
  const readOnly = !!selected && !!selected.archived;

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-m)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Layers size={14} style={{ color: 'var(--accent)' }} /> 迭代与燃尽
        </span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>迭代=项目下带起止日期的计划行集合（PM-201）</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} aria-label="含已归档迭代" />
          含已归档
        </label>
        <button onClick={() => { setDraft(emptyDraft()); setFormOpen((v) => !v); }} className="tbtn-anim" style={BTN}
          title="新建迭代 — 起始终止日期、目标与完成定义" aria-label="新建迭代"><Sparkles size={12} />新建</button>
        <button onClick={() => { void Promise.all([loadIterations(), loadPlans(), loadDetail(selectedId)]).catch((e) => flash(String(e))); }}
          className="tbtn-anim" style={BTN} title="刷新" aria-label="刷新迭代数据"><RefreshCw size={12} /></button>
        <button onClick={onClose} style={{ ...BTN, color: 'var(--text-muted)' }} title="关闭迭代面板" aria-label="关闭迭代面板">×</button>
      </div>
      {msg && <div role="status" data-t03186="toast" style={{ marginTop: 8, fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{msg}</div>}

      {formOpen && <IterationForm draft={draft} setDraft={setDraft} busy={busy} onSubmit={() => void submitDraft()}
        onCancel={() => { setFormOpen(false); setDraft(emptyDraft()); }} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 12, marginTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {iterations.length === 0 && (
            <div data-t03186="no-iteration" style={{ ...CARD, color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>
              还没有迭代。点「新建」建一个带起止日期的迭代，再把下面的计划行挂进去。
            </div>
          )}
          {iterations.map((it) => (
            <button key={it.id} onClick={() => setSelectedId(it.id)} aria-pressed={it.id === selectedId}
              data-t03186="iteration-card"
              style={{ ...CARD, textAlign: 'left', cursor: 'pointer', background: it.id === selectedId ? 'var(--accent-soft, rgba(128,128,128,.14))' : 'transparent', borderColor: it.id === selectedId ? 'var(--accent)' : 'var(--border)', opacity: it.archived ? 0.7 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <strong style={{ fontSize: 'var(--fs-s)' }}>{it.name}</strong>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 'var(--fs-2xs, 10px)', color: it.status === 'done' ? 'var(--success)' : 'var(--text-muted)' }}>
                  {it.archived ? '已归档' : STATUS_LABEL[it.status] ?? it.status}
                </span>
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                {it.start_date} ~ {it.end_date} · 计划 {it.memberCount ?? 0} 条 · 完成 {it.doneCount ?? 0} 条
              </div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!selected && (
            <ProjectBurnView burn={projectBurn} />
          )}
          {selected && (
            <>
              <div style={CARD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 'var(--fs-s)' }}>{selected.name}</strong>
                  <select value={selected.status} disabled={readOnly || busy} aria-label="迭代状态"
                    onChange={async (e) => {
                      try { await api.put(`/iterations/${selected.id}`, { status: e.target.value }); await loadIterations(); await loadDetail(selected.id); }
                      catch (err) { flash(err instanceof Error ? err.message : String(err)); }
                    }}
                    style={{ ...FIELD, width: 96 }}>
                    {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <span style={{ flex: 1 }} />
                  <button disabled={readOnly || busy} onClick={() => { setDraft({ editingId: selected.id, name: selected.name, goal: selected.goal, dod: selected.dod, startDate: selected.start_date, endDate: selected.end_date, status: selected.status }); setFormOpen(true); }}
                    style={{ ...BTN, opacity: readOnly ? 0.5 : 1, cursor: readOnly ? 'default' : 'pointer' }}
                    title={readOnly ? '迭代已归档，只读不可编辑' : '编辑迭代 — 名称/目标/完成定义/起止日期'} aria-label="编辑迭代">编辑</button>
                  <button disabled={busy} onClick={() => void act(selected.id, selected.archived ? 'unarchive' : 'archive')}
                    className="tbtn-anim" style={BTN} aria-label={selected.archived ? '取消归档迭代' : '归档迭代'}
                    title={selected.archived ? '取消归档 — 恢复可编辑' : '归档 — 转只读并退出有效分母（PM-201①）'}>
                    {selected.archived ? <><RotateCcw size={12} />恢复</> : <><Archive size={12} />归档</>}
                  </button>
                  <button disabled={busy} onClick={() => void act(selected.id, 'delete')} className="tbtn-anim"
                    style={{ ...BTN, color: 'var(--danger)' }} aria-label="删除迭代（仅解绑）"
                    title="删除 — 仅解绑成员，计划行本身保留（PM-201 详细设计 §3.3）"><Trash2 size={12} />删除</button>
                </div>
                {(selected.goal || selected.dod) && (
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>
                    {selected.goal && <div>目标：{selected.goal}</div>}
                    {selected.dod && <div>完成定义：{selected.dod}</div>}
                  </div>
                )}
                {readOnly && (
                  <div role="status" data-t03186="readonly" style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--warn, var(--text-muted))' }}>
                    该迭代已归档：只读，成员不可变更，统计已退出有效分母。需要继续编辑请点「恢复」。
                  </div>
                )}
              </div>

              <MemberTable members={members} selIds={selMemberIds} setSelIds={setSelMemberIds} readOnly={readOnly} busy={busy}
                onDetach={() => void doDetach()} />

              <AddPlans unassigned={unassigned} pickIds={pickIds} setPickIds={setPickIds} readOnly={readOnly} busy={busy}
                onAttach={() => void doAttach('add')} onReplace={() => void doAttach('replace')} />

              <BurndownView burn={burn} />

              {summary && <SummaryView summary={summary} card={card} busy={busy} onPublish={() => void publishCard()} />}

              <EventsView events={events} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 迭代新建/编辑表单（S3776：从主组件里拆出） */
function IterationForm({ draft, setDraft, busy, onSubmit, onCancel }: {
  readonly draft: Draft;
  readonly setDraft: (d: Draft) => void;
  readonly busy: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const set = (k: keyof Draft, v: string): void => setDraft({ ...draft, [k]: v });
  const bad = !!draft.startDate && !!draft.endDate && draft.endDate < draft.startDate;
  const saveOrCreateLabel = draft.editingId ? '保存迭代' : '创建迭代';
  return (
    <div data-t03186="iter-form" style={{ ...CARD, marginTop: 10, borderColor: 'var(--accent)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 'var(--fs-s)' }}>
        <input placeholder="迭代名称（如 S1）" value={draft.name} onChange={(e) => set('name', e.target.value)} aria-label="迭代名称" style={{ ...FIELD, flex: '1 1 160px' }} />
        <input type="date" value={draft.startDate} onChange={(e) => set('startDate', e.target.value)} aria-label="开始日期" style={{ ...FIELD, width: 150 }} />
        <input type="date" value={draft.endDate} onChange={(e) => set('endDate', e.target.value)} aria-label="结束日期" style={{ ...FIELD, width: 150 }} />
        <select value={draft.status} onChange={(e) => set('status', e.target.value)} aria-label="迭代状态" style={{ ...FIELD, width: 110 }}>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <input placeholder="目标（本迭代要回答的问题）" value={draft.goal} onChange={(e) => set('goal', e.target.value)} aria-label="迭代目标" style={FIELD} />
      <input placeholder="完成定义 DoD（怎样才算做完）" value={draft.dod} onChange={(e) => set('dod', e.target.value)} aria-label="完成定义" style={FIELD} />
      {bad && <div role="alert" style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>结束日不能早于开始日，服务端会拒收。</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} disabled={busy} style={BTN} aria-label="取消编辑迭代">取消</button>
        <button onClick={onSubmit} disabled={busy || bad || !draft.name.trim()} className="tbtn-anim"
          style={{ ...BTN, background: 'var(--accent)', color: 'var(--accent-text)', borderColor: 'var(--accent)', opacity: busy || bad || !draft.name.trim() ? 0.6 : 1 }}
          title={bad ? '请先修正起止日期' : saveOrCreateLabel} aria-label={saveOrCreateLabel}>
          {draft.editingId ? '保存' : '创建'}
        </button>
      </div>
    </div>
  );
}

/** 成员计划表：勾选后可批量移出（PM-201②） */
function MemberTable({ members, selIds, setSelIds, readOnly, busy, onDetach }: {
  readonly members: readonly MemberRow[];
  readonly selIds: readonly string[];
  readonly setSelIds: (ids: string[]) => void;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onDetach: () => void;
}): ReactElement {
  const toggle = (id: string): void => setSelIds(selIds.includes(id) ? selIds.filter((x) => x !== id) : [...selIds, id]);
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-s)' }}>
        <strong>在册计划行</strong>
        <span style={{ color: 'var(--text-muted)' }}>{members.length} 条</span>
        <span style={{ flex: 1 }} />
        <button disabled={readOnly || busy || selIds.length === 0} onClick={onDetach} className="tbtn-anim"
          style={{ ...BTN, opacity: readOnly || selIds.length === 0 ? 0.5 : 1, cursor: readOnly ? 'default' : 'pointer' }}
          title={readOnly ? '迭代已归档，只读不可变更成员' : '移出所选计划行（记录移出事件，不删计划）'} aria-label="移出所选计划行">
          <Unlink size={12} />移出{selIds.length ? ` ${selIds.length} 条` : ''}
        </button>
      </div>
      {members.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>还没有挂进来的计划行，从下方清单勾选加入。</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)', marginTop: 6 }}>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} data-t03186="member-row">
                <td style={{ width: 22, padding: '3px 4px' }}>
                  <input type="checkbox" checked={selIds.includes(m.id)} onChange={() => toggle(m.id)} disabled={readOnly} aria-label={`选择 ${m.title}`} />
                </td>
                <td style={{ padding: '3px 4px' }}>{m.title}</td>
                <td style={{ padding: '3px 4px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{m.start_date}~{m.end_date}</td>
                <td style={{ padding: '3px 4px', whiteSpace: 'nowrap', color: m.status === 'done' ? 'var(--success)' : 'var(--text-muted)' }}>
                  {m.status === 'done' ? `完成 ${m.progress}%` : `进行中 ${m.progress}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 加入区：只列未归属任何迭代的计划行（PM-201③ 单归属在列表层面就成立） */
function AddPlans({ unassigned, pickIds, setPickIds, readOnly, busy, onAttach, onReplace }: {
  readonly unassigned: readonly PlanLite[];
  readonly pickIds: readonly string[];
  readonly setPickIds: (ids: string[]) => void;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onAttach: () => void;
  readonly onReplace: () => void;
}): ReactElement {
  const toggle = (id: string): void => setPickIds(pickIds.includes(id) ? pickIds.filter((x) => x !== id) : [...pickIds, id]);
  const disabled = readOnly || busy || pickIds.length === 0;
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-s)' }}>
        <strong>未规划计划行</strong>
        <span style={{ color: 'var(--text-muted)' }}>{unassigned.length} 条可选</span>
        <span style={{ flex: 1 }} />
        <button disabled={disabled} onClick={onAttach} className="tbtn-anim" style={{ ...BTN, opacity: disabled ? 0.5 : 1 }}
          title={readOnly ? '迭代已归档，只读不可变更成员' : '加入迭代（保留原在册成员）'} aria-label="加入迭代">加入迭代</button>
        <button disabled={disabled} onClick={onReplace} style={{ ...BTN, opacity: disabled ? 0.5 : 1 }}
          title="整批替换：在册但未勾选的计划行会被移出（逐条留痕）" aria-label="以所选整批替换成员">整批替换</button>
      </div>
      {unassigned.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6 }}>本项目的计划行都已归属迭代。</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {unassigned.map((p) => (
            <label key={p.id} data-t03186="unassigned-chip"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 6, border: `1px solid ${pickIds.includes(p.id) ? 'var(--accent)' : 'var(--border)'}`, background: pickIds.includes(p.id) ? 'var(--accent-soft, rgba(128,128,128,.14))' : 'transparent', fontSize: 'var(--fs-xs)', cursor: readOnly ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={pickIds.includes(p.id)} onChange={() => toggle(p.id)} disabled={readOnly} aria-label={`选择计划 ${p.title}`} />
              {p.title}
              <span style={{ color: 'var(--text-muted)' }}>{p.start_date}~{p.end_date}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** 燃尽双口径图（PM-201④）：数据全部来自服务端，这里只呈现口径说明 */
function BurndownView({ burn }: { readonly burn: Burndown | null }): ReactElement {
  if (!burn) return <div style={{ ...CARD, fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>燃尽数据加载中…</div>;
  return (
    <div style={CARD} data-t03186="burndown">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-s)', flexWrap: 'wrap' }}>
        <strong>燃尽（按业务日）</strong>
        <span style={{ color: 'var(--text-muted)' }}>{burn.scope.startDate} ~ {burn.scope.endDate} · 时区 {burn.tz}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          在册 {burn.totals.plans} · 完成 {burn.totals.done} · 未完成 {burn.totals.undone} · 逾期 {burn.totals.overdue}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
        <div>
          <BurndownChart points={burn.points} field="remainingCount" idealField="idealCount" unit="条" label="剩余计划行数" />
          <BurndownLegend unit="条" />
        </div>
        <div>
          <BurndownChart points={burn.points} field="remainingWorkdays" idealField="idealWorkdays" unit="工作日" label="剩余工期（工作日）" />
          <BurndownLegend unit="工作日" />
        </div>
      </div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {burn.notes.map((n) => <li key={n}>{n}</li>)}
        {burn.dataFrom && <li>可回溯窗口自 {burn.dataFrom} 起</li>}
      </ul>
    </div>
  );
}

/** 无迭代选中时的项目整体燃尽（同口径，范围=项目未归档计划行） */
function ProjectBurnView({ burn }: { readonly burn: Burndown | null }): ReactElement {
  if (!burn) return <div style={{ ...CARD, fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>项目燃尽数据加载中…</div>;
  return (
    <div style={CARD} data-t03186="project-burndown">
      <div style={{ fontSize: 'var(--fs-s)' }}><strong>项目整体燃尽</strong> <span style={{ color: 'var(--text-muted)' }}>{burn.scope.startDate} ~ {burn.scope.endDate}</span></div>
      <BurndownChart points={burn.points} field="remainingCount" idealField="idealCount" unit="条" label="剩余计划行数" />
      <BurndownLegend unit="条" />
      <ul style={{ margin: 6, paddingLeft: 18, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {burn.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>左侧选择一个迭代可看迭代级燃尽。</div>
    </div>
  );
}

/** 结束小结（PM-201⑥ 取数段）：完成 / 未完成 / 逾期三份清单 + 周报卡发布入口 */
function SummaryView({ summary, card, busy, onPublish }: {
  readonly summary: Summary;
  readonly card: WeeklyCard | null;
  readonly busy: boolean;
  readonly onPublish: () => void;
}): ReactElement {
  return (
    <div style={CARD} data-t03186="summary">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-s)' }}>
        <strong>迭代小结</strong>
        <span style={{ color: 'var(--text-muted)' }}>
          完成 {summary.totals.done} · 未完成 {summary.totals.undone} · 逾期 {summary.totals.overdue}
        </span>
        <button type="button" onClick={onPublish} disabled={busy} style={{ ...BTN, marginLeft: 'auto' }}
          title={card ? '该迭代已有周报卡，再点只会展示首份，不会生成第二张' : '把当前小结固化为一份可复制的周报卡（一迭代仅一份）'}>
          发周报卡
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 8, fontSize: 'var(--fs-xs)' }}>
        <SummaryCol title="已完成" rows={summary.done} color="var(--success)" />
        <SummaryCol title="未完成" rows={summary.undone} color="var(--text-muted)" />
        <SummaryCol title="逾期（结束日已过仍未完成）" rows={summary.overdue} color="var(--danger)" />
      </div>
      {summary.notes.map((n) => <div key={n} style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{n}</div>)}
      {card ? <WeeklyCardView card={card} /> : (
        <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          还没有周报卡。点「发周报卡」生成，或由启动补生成在本迭代结束日跨过后自动产出（一迭代仅一份）。
        </div>
      )}
    </div>
  );
}

/** 周报卡呈现（T03227）：服务端生成的纯文本快照原样展示，展示层不重算、不补字段 */
function WeeklyCardView({ card }: { readonly card: WeeklyCard }): ReactElement {
  return (
    <div data-t03227="weekly-card" style={{ marginTop: 10, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xs)' }}>
        <strong>周报卡</strong>
        <span style={{ color: 'var(--text-muted)' }}>
          {card.trigger === 'backfill' ? '启动补生成' : '手动发布'} · {card.generatedAt.slice(0, 19).replace('T', ' ')} ·
          完成 {card.totals.done} / 未完成 {card.totals.undone} / 逾期 {card.totals.overdue}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <CopyButton getText={() => card.markdown} title="复制周报卡全文" ariaLabel="复制周报卡全文" />
        </span>
      </div>
      <pre style={{ ...FIELD, marginTop: 6, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 'var(--fs-xs)' }}>
        {card.markdown}
      </pre>
    </div>
  );
}

function SummaryCol({ title, rows, color }: { readonly title: string; readonly rows: readonly MemberRow[]; readonly color: string }): ReactElement {
  return (
    <div>
      <div style={{ color, marginBottom: 2 }}>{title}（{rows.length}）</div>
      {rows.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>—</div> : (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {rows.map((r) => <li key={r.id} title={`${r.start_date} ~ ${r.end_date}`}>{r.title}</li>)}
        </ul>
      )}
    </div>
  );
}

/** 成员变更留痕（PM-201⑤）：加入/移出逐条可查，历史不被重写 */
function EventsView({ events }: { readonly events: readonly MemberEvent[] }): ReactElement {
  if (events.length === 0) return <div style={{ ...CARD, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>还没有成员变更事件。</div>;
  return (
    <div style={{ ...CARD, borderColor: 'var(--border)' }} data-t03186="events">
      <div style={{ fontSize: 'var(--fs-s)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <CalendarRange size={12} style={{ color: 'var(--text-muted)' }} /> 成员变更留痕（{events.length} 条，倒序）
      </div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {events.slice(0, 30).map((e) => (
          <li key={e.id}>{e.created_at.slice(0, 19).replace('T', ' ')} · {e.kind === 'attach' ? '加入' : '移出'} · {e.title ?? '（计划行已删除）'}{e.detail ? ` · ${e.detail}` : ''}</li>
        ))}
      </ul>
    </div>
  );
}
