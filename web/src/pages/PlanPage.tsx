import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CalendarPlus, Download, FileSpreadsheet, Link2, Link2Off, Loader2, Plus, RefreshCw, Sparkles, Trash2, Upload, Zap, ChevronDown, ChevronRight } from 'lucide-react';
import { FontColorButton } from '../ui/FontColorButton';
import { api, type AITool } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { usePersistentState, useSessionState } from '../ui/session';

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
  /** T00490：记录字体颜色，空串=默认色 */
  color?: string;
  /** T00499：前置依赖 JSON [{id,type:'serial'|'parallel'}]，空=无依赖 */
  deps?: string;
  /** T00506：任务类型 normal=普通、milestone=阶段里程碑、daily=日常任务 */
  kind?: string;
}

interface ProjectRow {
  id: string;
  name: string;
  /** T00505：计划任务统计（下拉徽标） */
  plan_done?: number;
  plan_doing?: number;
  plan_open?: number;
}

/** AI 导入解析出的标准计划草稿（可编辑行，include 控制是否保存） */
interface PlanDraft {
  title: string;
  description: string;
  startDate: string;
  durationDays: number;
  assignee: string;
  status: PlanTask['status'];
  include: boolean;
}

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
const inputStyle: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 6, padding: '3px 6px', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 };
const btnStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12, padding: '3px 8px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)' };

/** T00471：计划行「默认只读展示 + 悬浮编辑」交互——CSS 驱动不改数据流：
 *  默认 input 边框透明呈文本观感，行 hover/focus-within 时显示编辑框边框背景；
 *  行操作按钮（关联/插入/归档等 task-op）默认隐藏，悬浮或键盘聚焦时显示（保键盘可访问）。 */
const planTableCss = `
  .plan-table input { border-color: transparent; background: transparent; }
  .plan-table tr:hover input, .plan-table tr:focus-within input { border-color: var(--border-strong); background: var(--bg); }
  .plan-table .task-op { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
  .plan-table tr:hover .task-op, .plan-table tr:focus-within .task-op { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
`;

/** AI 草稿行：附加仅用于 React key 的稳定行键（提交时剥离） */
type AiRow = PlanDraft & { rowKey: string };

/** 按行打补丁的不可变更新（提取到模块作用域，避免 JSX 内多层嵌套闭包） */
function updateAiRow(rows: AiRow[], idx: number, patch: Partial<PlanDraft>): AiRow[] {
  return rows.map((r, j) => (j === idx ? { ...r, ...patch } : r));
}

/** 剥离 rowKey，保持提交请求体与既有协议字段完全一致 */
function toPlanDraft(r: AiRow): PlanDraft {
  return {
    title: r.title, description: r.description, startDate: r.startDate,
    durationDays: r.durationDays, assignee: r.assignee, status: r.status, include: r.include,
  };
}

/** AI 模型默认整理工具优先排序 */
function compareOrganize(a: AITool, b: AITool): number {
  return Number(b.isDefaultOrganize) - Number(a.isDefaultOrganize);
}

/** 保持当前选中工具（若仍存在），否则回退到首个 */
function pickToolId(sorted: AITool[], cur: string): string {
  return sorted.some((t) => t.id === cur) ? cur : (sorted[0]?.id ?? '');
}

/** 计划行拖拽/高亮类名（原嵌套三元等价改写） */
function planRowClass(dragId: string, overId: string, newRowId: string, id: string): string | undefined {
  if (dragId === id) return 'plan-dragging';
  if (overId === id) return 'plan-over';
  if (newRowId === id) return 'plan-new';
  return undefined;
}

/** 浏览器下载 ArrayBuffer 为 xlsx（原为组件内函数，不依赖组件闭包，上提到模块作用域） */
function downloadBlob(buf: ArrayBuffer, name: string) {
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** 下载空白计划模板（不依赖组件闭包，模块作用域） */
async function downloadTemplate() {
  const buf = await api.getBinary('/plans/template');
  downloadBlob(buf, 'plan-template.xlsx');
}

/** T00508：取记录挂接的里程碑（deps 中 type=child），无则 null */
function childMilestoneOf(p: PlanTask, plans: PlanTask[]): PlanTask | null {
  try {
    const deps = p.deps ? JSON.parse(p.deps) as Array<{ id: string; type: string }> : [];
    const hit = deps.find((d) => d.type === 'child');
    return hit ? plans.find((x) => x.id === hit.id) ?? null : null;
  } catch { return null; }
}

export function PlanPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  // T00460：切页保状态——项目选择会话级持久化，切回不重置
  const [projectId, setProjectId] = useSessionState('plan.projectId', '');
  const [plans, setPlans] = useState<PlanTask[]>([]);
  const [holidays, setHolidays] = useState<Array<{ date: string; name: string }>>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // T00438 AI 导入：模型列表与选中工具（持久化）、解析弹窗状态、可编辑草稿行
  const [tools, setTools] = useState<AITool[]>([]);
  const [aiToolId, setAiToolId] = usePersistentState('plan.aiToolId', '');
  // T00526 调整：AI 模型下拉展开态（与任务菜单一致——收起只显模型名，展开显示厂商+模型）
  const [aiToolOpen, setAiToolOpen] = useState(false);
  // T00472：AI 评估状态（批量进度动态计数，单条/批量共用）
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalLabel, setEvalLabel] = useState('');
  // T00499：前置依赖配置弹窗（depEditor=正在编辑的记录；depSel=选择集 {任务id: 依赖类型}）
  // T00506：新建任务类型（normal=普通、milestone=阶段里程碑、daily=日常）
  const [newKind, setNewKind] = useSessionState<'normal' | 'milestone' | 'daily'>('plan.newKind', 'normal');
  // T00505：项目自绘下拉（三色徽标：绿=已完成、蓝=进行中、灰=待开始）
  const [projOpen, setProjOpen] = useState(false);
  const projDropRef = useRef<HTMLDivElement | null>(null);
  // T00520：项目下拉面板 fixed 定位坐标（脱离父容器 overflow 裁剪，不受窗口大小限制）
  const [projDropPos, setProjDropPos] = useState<{ top: number; left: number } | null>(null);
  const [depEditor, setDepEditor] = useState<{ id: string; seq: number } | null>(null);
  // T00508：里程碑收起状态（记录其下子任务是否折叠）
  const [collapsedMs, setCollapsedMs] = useState<Record<string, boolean>>({});
  const [depSel, setDepSel] = useState<Record<string, 'serial' | 'parallel'>>({});
  // T00449：视图模式（列表/甘特）会话级保持
  const [viewMode, setViewMode] = useSessionState<'list' | 'gantt'>('plan.viewMode', 'list');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiFileName, setAiFileName] = useState('');
  const [aiRows, setAiRows] = useState<AiRow[]>([]);
  const [aiError, setAiError] = useState('');

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 3000); };

  useEffect(() => { void api.get<ProjectRow[]>('/projects').then((ps) => { setProjects(ps); if (ps.length > 0) setProjectId((cur) => cur || ps[0].id); }); }, []);
  // T00438：AI 模型列表（默认整理工具排最前，与任务页模型选择一致）
  useEffect(() => { void api.get<AITool[]>('/aitools').then((list) => { const sorted = [...list].sort(compareOrganize); setTools(sorted); setAiToolId((cur) => pickToolId(sorted, cur)); }); }, []);

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
      await api.post('/plans', { projectId, title: title.trim(), startDate: todayStr(), durationDays: 1, kind: newKind });
      reload();
      flash('已创建，时间线已自动重排');
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function updatePlan(p: PlanTask, patch: Partial<Pick<PlanTask, 'title' | 'description' | 'duration_days' | 'assignee' | 'progress' | 'status' | 'start_date' | 'color' | 'deps'>>) {
    setBusy(true);
    try {
      await api.patch(`/plans/${p.id}`, {
        title: patch.title, description: patch.description, assignee: patch.assignee, status: patch.status,
        progress: patch.progress, durationDays: patch.duration_days, startDate: patch.start_date, color: patch.color, deps: patch.deps,
      });
      reload();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  // T00505：项目下拉点击外部关闭
  useEffect(() => {
    if (!projOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (projDropRef.current && !projDropRef.current.contains(e.target as Node)) setProjOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [projOpen]);

  // ---------- T00499：前置依赖配置 ----------
  /** 打开依赖配置弹窗：预填该记录既有依赖（排除自身） */
  function openDepEditor(p: PlanTask) {
    let cur: Array<{ id: string; type: 'serial' | 'parallel' }> = [];
    try { cur = p.deps ? JSON.parse(p.deps) : []; } catch { cur = []; }
    const sel: Record<string, 'serial' | 'parallel'> = {};
    cur.forEach((d) => { if (d.id !== p.id) sel[d.id] = d.type === 'parallel' ? 'parallel' : 'serial'; });
    setDepSel(sel);
    setDepEditor({ id: p.id, seq: plans.findIndex((x) => x.id === p.id) + 1 });
  }

  /** 保存依赖：写 deps；存在串行依赖时自动把开始日调到最晚串行前置结束日的次工作日（自动调整工期/时间线，后端串行重排） */
  function saveDeps() {
    if (!depEditor) return;
    const p = plans.find((x) => x.id === depEditor.id);
    if (!p) { setDepEditor(null); return; }
    const deps = Object.entries(depSel).map(([id, type]) => ({ id, type }));
    const serialEnds = deps
      .filter((d) => d.type === 'serial')
      .map((d) => plans.find((x) => x.id === d.id)?.end_date)
      .filter(Boolean) as string[];
    let startDate: string | undefined;
    if (serialEnds.length > 0) {
      const maxEnd = serialEnds.sort().at(-1)!;
      const next = new Date(maxEnd);
      do { next.setDate(next.getDate() + 1); } while ([0, 6].includes(next.getDay()));
      startDate = next.toISOString().slice(0, 10);
    }
    void updatePlan(p, { deps: JSON.stringify(deps), ...(startDate && startDate !== p.start_date ? { startDate } : {}) });
    setDepEditor(null);
    flash(startDate ? `依赖已保存：串行前置后开始日自动调整为 ${startDate}` : '依赖已保存');
  }

  // ---------- T00472：AI 评估 ----------
  /** 单条评估：调 AI 生成评估文本，追加到该行描述（[AI评估 日期] 前缀），返回是否成功 */
  async function evaluateOnePlan(p: PlanTask): Promise<boolean> {
    try {
      const r = await api.post<{ ok: boolean; results: Array<{ id: string; ok: boolean; evaluation?: string; error?: string }> }>(
        '/plans/ai-evaluate',
        { toolId: aiToolId, items: [{ id: p.id, title: p.title, duration_days: p.duration_days, progress: p.progress, assignee: p.assignee }] },
      );
      const first = r.results?.[0];
      if (!first?.ok || !first.evaluation) {
        const rawErr = first?.error ?? '';
        // T00515：HTTP 402 = AI 服务余额不足/欠费——给出可操作的提示
        const hint = rawErr.includes('402') ? '（AI 服务返回 402：余额不足或欠费，请检查「模型管理」中该工具配置的服务商账户余额）' : '';
        flash(`AI 评估失败：${rawErr}${hint}`);
        return false;
      }
      const stamp = new Date().toISOString().slice(5, 10).replace('-', '/');
      const merged = p.description ? p.description + '\n' + `[AI评估 ${stamp}] ${first.evaluation}` : `[AI评估 ${stamp}] ${first.evaluation}`;
      await updatePlan(p, { description: merged });
      return true;
    } catch (e) { flash(String((e as Error).message ?? e)); return false; }
  }

  /** T00526 调整：AI 模型下拉——与任务菜单（TasksPage renderToolSelector）同款：
   *  收起只显示模型名（未配置回退厂商名）收紧宽度；展开面板显示「厂商名（厂商类型）+ 模型名」；
   *  焦点移出下拉区域即收起。工具栏与 AI 导入弹窗复用同一份状态。 */
  function renderAiToolDropdown(styleOverride?: React.CSSProperties) {
    const current = tools.find((x) => x.id === aiToolId);
    return (
      <div style={{ position: 'relative' }}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setAiToolOpen(false); }}>
        <button onClick={() => setAiToolOpen((o) => !o)} className="tbtn-anim"
          title={current ? `当前工具：${current.name}（${current.type}）· ${current.model ?? '未配置模型'}` : 'AI 模型选择 — AI 导入与 AI 评估使用该工具配置的模型'}
          aria-label="AI 模型选择" aria-haspopup="listbox" aria-expanded={aiToolOpen}
          style={{ ...btnStyle, display: 'inline-flex', alignItems: 'center', gap: 4, ...(styleOverride ?? {}) }}>
          {current ? (current.model ?? current.name) : 'AI 模型…'}
          <ChevronDown size={12} />
        </button>
        {aiToolOpen && (
          <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 40, minWidth: 240, maxHeight: 260, overflowY: 'auto', background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: 'var(--overlay)' }}>
            {tools.map((t) => (
              <button key={t.id} onClick={() => { setAiToolId(t.id); setAiToolOpen(false); }}
                title={`选择 ${t.name}（${t.type}）· ${t.model ?? '未配置模型'}`} aria-label={`选择 AI 模型 ${t.name}`}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 'none', cursor: 'pointer', fontSize: 12, background: t.id === aiToolId ? 'var(--accent-soft)' : 'transparent', color: t.id === aiToolId ? 'var(--accent)' : 'var(--text)' }}>
                {t.name}（{t.type}）
                <span style={{ color: t.model ? 'var(--text-secondary)' : 'var(--danger)', marginLeft: 6 }}>{t.model ?? '未配置模型'}</span>
              </button>
            ))}
            {tools.length === 0 && <div style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 12 }}>暂无工具，请先在「模型管理」中添加</div>}
          </div>
        )}
      </div>
    );
  }

  /** 批量评估：确认后逐条串行评估并自动录入描述，进度动态计数（k/N） */
  function batchEvaluatePlans() {
    if (evalBusy) return;
    if (!aiToolId) { flash('请先选择 AI 模型（AI 导入旁的模型下拉）'); return; }
    const target = plans;
    if (target.length === 0) { flash('当前项目暂无计划条目'); return; }
    setEvalLabel(`0/${target.length}`);
    const msg = `将对 ${target.length} 条计划逐条 AI 评估（工期合理性/风险/建议），结果自动录入各条描述（可后续手动编辑或删除），确认开始？`;
    void askConfirm(msg).then(async (go) => {
      if (!go) { setEvalLabel(''); return; }
      setEvalBusy(true);
      let done = 0;
      for (const p of target) {
        await evaluateOnePlan(p);
        done += 1;
        setEvalLabel(`${done}/${target.length}`);
      }
      setEvalBusy(false);
      setTimeout(() => setEvalLabel(''), 2500);
      flash(`AI 评估完成：${done} 条结果已写入描述`);
    });
  }

  // ---------- T00459：拖拽排序（HTML5 DnD，drop 后整体重写顺序并重排时间线） ----------

  const [dragId, setDragId] = useState('');
  const [overId, setOverId] = useState('');

  function onDropReorder(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(''); setOverId(''); return; }
    const ids = plans.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragId(''); setOverId('');
    setBusy(true);
    void api.post<{ reordered: number }>('/plans/reorder', { projectId, orderedIds: ids })
      .then(() => { reload(); flash('顺序已调整，时间线已自动重排'); })
      .catch((e) => flash(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  }

  // ---------- T00459：任意位置插入（在该行后插入新计划任务，后续排期自动重排） ----------

  const [newRowId, setNewRowId] = useState('');

  async function insertAfter(p: PlanTask) {
    const title = await askInput({ title: `在「${p.title}」后插入新任务`, placeholder: '新任务标题' });
    if (!title?.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ plan: { id: string } }>(`/plans/${p.id}/insert-after`, { title: title.trim() });
      setNewRowId(r.plan.id);
      reload();
      flash('已插入，排期时间已自动重排');
      setTimeout(() => setNewRowId((cur) => (cur === r.plan.id ? '' : cur)), 3000);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  /** 归档计划任务（T00442：删除改归档）——从时间线移除但可在「归档」菜单恢复，后续时间线自动重排 */
  async function archivePlan(p: PlanTask) {
    if (!(await askConfirm(`归档计划任务「${p.title}」？将自动从时间线移除并重排；可在「归档」菜单恢复或彻底删除。`))) return;
    setBusy(true);
    try { await api.post(`/plans/${p.id}/archive`); reload(); flash('已归档，可在「归档」菜单恢复'); } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
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

  async function exportExcel() {
    if (!projectId) return flash('请先选择项目');
    const buf = await api.getBinary(`/plans/export?projectId=${projectId}`);
    const ts = todayStr().replaceAll('-', '');
    downloadBlob(buf, `项目计划-${ts}.xlsx`);
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

  // ---------- T00449：甘特图视图（纯 CSS/SVG 零依赖） ----------

  const DAY_W = 18; // 每天列宽 px
  const STATUS_BAR: Record<PlanTask['status'], string> = {
    todo: 'var(--accent)', doing: 'var(--success)', done: 'var(--text-muted)', blocked: 'var(--danger)',
  };

  /** 甘特主视图：横向日轴 + 串行任务条 + 周末/节假日底纹 + 今日线 + 进度内嵌 */
  function renderGantt() {
    if (plans.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 16 }}>暂无计划任务，先创建或导入。</div>;
    const dates = plans.flatMap((p) => [p.start_date, p.end_date]).filter(Boolean).sort((a, b) => a.localeCompare(b));
    // 评审 P2-3：边界防护——全部计划无日期（如批量导入未带排期）时避免 NaN 渲染异常
    if (!dates[0]) {
      return (
        <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12, border: '1px dashed var(--border-strong)', borderRadius: 8 }}>
          计划任务尚未生成排期——在列表视图编辑任意任务后自动生成，或导入含日期的 Excel。
        </div>
      );
    }
    const rangeStart = dates[0];
    const rangeEnd = dates.at(-1) ?? '';
    const dayMs = 86400000;
    const toIdx = (d: string) => Math.round((new Date(d + 'T00:00:00').getTime() - new Date(rangeStart + 'T00:00:00').getTime()) / dayMs);
    const totalDays = toIdx(rangeEnd) + 1;
    const todayIdx = toIdx(todayStr());
    const holSet = new Set(holidays.map((h) => h.date));

    // 顶部月份刻度
    const monthTicks: Array<{ label: string; left: number }> = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(new Date(rangeStart + 'T00:00:00').getTime() + i * dayMs);
      if (d.getDate() === 1) monthTicks.push({ label: `${d.getMonth() + 1}月`, left: i * DAY_W });
    }

    return (
      <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ width: 220 + totalDays * DAY_W, minWidth: '100%' }}>
            {/* 月份刻度 */}
            <div style={{ display: 'flex', marginLeft: 220, height: 22, position: 'relative', borderBottom: '1px solid var(--border-strong)', fontSize: 11, color: 'var(--text-muted)' }}>
              {monthTicks.map((m) => (
                <span key={`${m.label}-${m.left}`} style={{ position: 'absolute', left: m.left + 4 }}>{m.label}</span>
              ))}
            </div>
            {/* 任务行 */}
            {plans.map((p, i) => {
              if (!p.start_date || !p.end_date) return null;
              const left = toIdx(p.start_date) * DAY_W;
              const width = Math.max(DAY_W, (toIdx(p.end_date) - toIdx(p.start_date) + 1) * DAY_W);
              return (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', height: 30, borderBottom: '1px solid var(--surface-2)', fontSize: 12 }}>
                  <div style={{ width: 220, flexShrink: 0, padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }} title={p.title}>
                    {i + 1}. {p.title}
                  </div>
                  <div style={{ position: 'relative', height: '100%', flex: 1 }}>
                    {/* 日历底纹：周末/节假日 */}
                    {Array.from({ length: totalDays }, (_, di) => {
                      const d = new Date(new Date(rangeStart + 'T00:00:00').getTime() + di * dayMs);
                      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                      const weekend = d.getDay() === 0 || d.getDay() === 6;
                      const hol = holSet.has(ds);
                      if (!weekend && !hol) return null;
                      return <div key={di} style={{ position: 'absolute', left: di * DAY_W, width: DAY_W, height: '100%', background: hol ? 'var(--danger-soft, rgba(220,38,38,.10))' : 'var(--surface-2)' }} />;
                    })}
                    {/* 今日线 */}
                    {todayIdx >= 0 && todayIdx < totalDays && (
                      <div style={{ position: 'absolute', left: todayIdx * DAY_W + DAY_W / 2, top: 0, bottom: 0, width: 1, background: 'var(--accent)', opacity: 0.6 }} />
                    )}
                    {/* 任务条 */}
                    <div title={`${p.title}
${p.start_date} ~ ${p.end_date}（${p.duration_days} 工作日）· 进度 ${p.progress}% · ${p.assignee || '未分配'}`}
                      style={{
                        position: 'absolute', left, width, top: 5, height: 18, borderRadius: 4,
                        background: STATUS_BAR[p.status], opacity: 0.85, cursor: 'default', overflow: 'hidden',
                      }}>
                      <div style={{ width: `${p.progress}%`, height: '100%', background: 'rgba(255,255,255,.35)' }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 10px', borderTop: '1px solid var(--border)', display: 'flex', gap: 14 }}>
          {Object.entries(STATUS_BAR).map(([k, c]) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
              {{ todo: '待开始', doing: '进行中', done: '已完成', blocked: '受阻' }[k as PlanTask['status']]}
            </span>
          ))}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 1, height: 10, background: 'var(--accent)', display: 'inline-block' }} />今天</span>
          <span>灰底=周末　红底=节假日</span>
        </div>
      </div>
    );
  }

  // ---------- T00438：AI 导入
  // ---------- T00438：AI 导入（任意格式 Excel → AI 解析 → 预览确认 → 批量创建） ----------

  function openAiImport() {
    if (!projectId) return flash('请先选择项目');
    if (tools.length === 0) return flash('请先在「模型」页添加 AI 模型工具');
    setAiOpen(true);
    setAiRows([]);
    setAiError('');
    setAiFileName('');
  }

  /** 上传文件 → 后端解析（Excel 走表格文本+AI 识别；md/docx 走 WBS 拆分）→ 返回标准草稿行（可编辑预览） */
  async function aiParse(file: File) {
    if (!aiToolId) return setAiError('请先选择 AI 模型');
    setAiFileName(file.name);
    setAiBusy(true);
    setAiError('');
    setAiRows([]);
    try {
      const buf = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      // T00439：需求文档（md/docx）走 WBS 拆分端点；其余（xlsx/csv）走 Excel 表格解析端点
      const isDoc = lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.docx');
      const endpoint = isDoc ? `/plans/ai-parse-doc` : `/plans/ai-parse`;
      const r = await api.postBinary<{ ok: boolean; drafts: Array<Omit<PlanDraft, 'include'>> }>(
        `${endpoint}?projectId=${projectId}&toolId=${aiToolId}&filename=${encodeURIComponent(file.name)}`, buf);
      setAiRows(r.drafts.map((d, i) => ({ ...d, include: true, startDate: d.startDate || '', rowKey: `ai-${Date.now()}-${i}` })));
      if (r.drafts.length === 0) setAiError('AI 未识别出计划条目');
    } catch (e) {
      setAiError(String((e as Error).message ?? e));
    } finally {
      setAiBusy(false);
    }
  }

  /** 确认保存：勾选行批量创建，时间线统一重排 */
  async function aiSave() {
    const items = aiRows.filter((r) => r.include && r.title.trim()).map(toPlanDraft);
    if (items.length === 0) return setAiError('请至少勾选一条要保存的条目');
    setAiBusy(true);
    setAiError('');
    try {
      const r = await api.post<{ inserted: number }>('/plans/batch', { projectId, items });
      setAiOpen(false);
      reload();
      flash(`AI 导入完成：已创建 ${r.inserted} 条计划，时间线已重排`);
    } catch (e) {
      setAiError(String((e as Error).message ?? e));
    } finally {
      setAiBusy(false);
    }
  }

  // ---------- 节假日 ----------
  // ---------- T00442：节假日多功能弹窗（手动维护 / 联网导入法定节假日 / 万年历视图） ----------

  const [holiOpen, setHoliOpen] = useState(false);
  const [holiTab, setHoliTab] = useState<'manage' | 'national' | 'calendar'>('manage');
  const [holiNewDate, setHoliNewDate] = useState('');
  const [holiNewName, setHoliNewName] = useState('');
  const [holiBusy, setHoliBusy] = useState(false);
  const [natYear, setNatYear] = useState(new Date().getFullYear());
  const [natMsg, setNatMsg] = useState('');
  const [calYear, setCalYear] = useState(new Date().getFullYear());

  const holidayMap = useMemo(() => new Map(holidays.map((h) => [h.date, h.name])), [holidays]);

  function openHolidayManager() {
    setHoliOpen(true);
    setHoliTab('manage');
    setHoliNewDate('');
    setHoliNewName('');
    setNatMsg('');
  }

  async function addHolidayInModal() {
    if (!holiNewDate) return flash('请先选择节假日日期');
    setHoliBusy(true);
    try {
      await api.post('/plans/holidays', { date: holiNewDate, name: holiNewName });
      setHolidays(await api.get('/plans/holidays'));
      reload();
      flash('节假日已添加，相关时间线已重排');
      setHoliNewDate(''); setHoliNewName('');
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setHoliBusy(false); }
  }

  async function removeHoliday(date: string) {
    if (!(await askConfirm(`移除节假日 ${date}？受影响时间线将自动重排。`))) return;
    setHoliBusy(true);
    try {
      await api.del(`/plans/holidays/${date}`);
      setHolidays(await api.get('/plans/holidays'));
      reload();
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setHoliBusy(false); }
  }

  /** 联网导入国家法定节假日（后端代理 timor.tech 数据源，upsert 幂等） */
  async function importNational() {
    setHoliBusy(true);
    setNatMsg('');
    try {
      const r = await api.post<{ imported: number; items: Array<{ date: string; name: string }> }>('/plans/holidays/import-national', { year: natYear });
      setHolidays(await api.get('/plans/holidays'));
      reload();
      setNatMsg(`✓ 已导入 ${r.imported} 条 ${natYear} 年法定节假日（重复日期自动合并），时间线已重排`);
    } catch (e) {
      setNatMsg(`✗ ${String((e as Error).message ?? e)}`);
    } finally { setHoliBusy(false); }
  }

  /** 万年历月网格：法定节假日（红）与周末（灰）着色区分 */
  function renderMonthGrid(year: number, month: number) {
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startWd = first.getDay(); // 0=周日
    const cells: Array<{ day: number | null; hol: string | null; weekend: boolean }> = [];
    for (let i = 0; i < startWd; i++) cells.push({ day: null, hol: null, weekend: false });
    for (let d = 1; d <= daysInMonth; d++) {
      const p = (n: number) => String(n).padStart(2, '0');
      const ds = `${year}-${p(month + 1)}-${p(d)}`;
      const wd = new Date(year, month, d).getDay();
      cells.push({ day: d, hol: holidayMap.get(ds) ?? null, weekend: wd === 0 || wd === 6 });
    }
    return (
      <div key={month} style={{ minWidth: 190, flex: '1 1 190px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, textAlign: 'center', marginBottom: 4 }}>{month + 1} 月</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, fontSize: 10, textAlign: 'center' }}>
          {['日', '一', '二', '三', '四', '五', '六'].map((w) => <span key={w} style={{ color: 'var(--text-muted)' }}>{w}</span>)}
          {cells.map((c, i) => {
            let color = 'var(--text)';
            if (c.hol) color = 'var(--danger)';
            else if (c.weekend) color = 'var(--text-muted)';
            return (
              <span key={c.day ?? `pad-${i}`} title={c.hol ? `节假日：${c.hol}` : undefined}
                style={{
                  padding: '2px 0', borderRadius: 3,
                  color,
                  background: c.hol ? 'var(--danger-soft, rgba(220,38,38,.12))' : 'transparent',
                  fontWeight: c.hol ? 600 : 400,
                }}>
                {c.day ?? ''}
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  // T00460：滚动位置保活（离开页时保存，切回恢复）
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const saved = sessionStorage.getItem('plan.scrollY');
    if (saved && scrollRef.current) scrollRef.current.scrollTop = Number(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时恢复一次
  }, []);
  const onScrollSave = () => {
    if (scrollSaveTimer.current) return;
    scrollSaveTimer.current = globalThis.setTimeout(() => {
      scrollSaveTimer.current = undefined;
      if (scrollRef.current) sessionStorage.setItem('plan.scrollY', String(scrollRef.current.scrollTop));
    }, 300);
  };

  return (
    <div ref={scrollRef} onScroll={onScrollSave} style={{ padding: 16, color: 'var(--text)', maxHeight: 'calc(100vh - 60px)', overflowY: 'auto' }}>
      <style>{`
        .plan-dragging { opacity: .55; transform: scale(1.01) rotate(.4deg); box-shadow: 0 6px 18px rgba(0,0,0,.22); background: var(--surface-2); }
        .plan-over { box-shadow: inset 0 3px 0 var(--accent); background: var(--accent-soft, rgba(9,105,218,.08)); }
        @keyframes plan-new-pop { 0% { background: var(--accent-soft, rgba(9,105,218,.15)); box-shadow: 0 0 0 3px var(--accent-soft, rgba(9,105,218,.2)); } 100% { background: transparent; box-shadow: none; } }
        .plan-new { animation: plan-new-pop 2.4s ease; }
      `}</style>
      <style>{planTableCss}</style>
      {/* T00519：描述为空时提示信息调浅 + 倾斜 */}
      <style>{`.plan-desc-ph::placeholder { color: var(--text-muted); opacity: .55; font-style: italic; }`}</style>
      {/* 工具条：项目选择 + 增删导入导出（T00491：操作控件/下拉默认隐藏，悬浮工具条显示） */}
      <div className="op-host" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div ref={projDropRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <button onClick={(e) => {
            // T00520：展开时以按钮视口坐标 fixed 定位面板——脱离父容器 overflow 裁剪，不受窗口/容器大小限制
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setProjDropPos({ top: r.bottom + 4, left: r.left });
            setProjOpen((o) => !o);
          }} aria-haspopup="listbox" aria-expanded={projOpen}
            title="选择项目 — 项目名后徽标：绿=已完成、蓝=进行中、灰=待开始（悬浮查看详情）"
            aria-label="选择项目"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 8px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' }}>
            {projects.find((p) => p.id === projectId)?.name ?? '选择项目'}
            {(() => { const cur = projects.find((p) => p.id === projectId); return cur ? (
              <>
                <span title={`已完成 ${cur.plan_done ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--success-soft, rgba(22,163,74,.12))', color: 'var(--success)' }}>{cur.plan_done ?? 0}</span>
                <span title={`进行中 ${cur.plan_doing ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{cur.plan_doing ?? 0}</span>
                <span title={`待开始 ${cur.plan_open ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{cur.plan_open ?? 0}</span>
              </>
            ) : null; })()}
            <ChevronDown size={12} />
          </button>
          {projOpen && projDropPos && (
            <div role="listbox" style={{ position: 'fixed', top: projDropPos.top, left: projDropPos.left, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.14)', zIndex: 60, minWidth: 240, maxHeight: `calc(100vh - ${projDropPos.top + 12}px)`, overflowY: 'auto' }}>
              {projects.map((p) => (
                <button key={p.id} role="option" aria-selected={p.id === projectId}
                  onClick={() => { setProjectId(p.id); setProjOpen(false); }}
                  title={`${p.name}：已完成 ${p.plan_done ?? 0}，进行中 ${p.plan_doing ?? 0}，待开始 ${p.plan_open ?? 0}`}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 12, background: p.id === projectId ? 'var(--accent-soft)' : 'transparent', color: 'var(--text)', border: 'none', cursor: 'pointer' }}>
                  <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span title={`已完成 ${p.plan_done ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--success-soft, rgba(22,163,74,.12))', color: 'var(--success)' }}>{p.plan_done ?? 0}</span>
                  <span title={`进行中 ${p.plan_doing ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{p.plan_doing ?? 0}</span>
                  <span title={`待开始 ${p.plan_open ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{p.plan_open ?? 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* T00506：新建任务类型选择（普通/阶段里程碑/日常任务） */}
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as 'normal' | 'milestone' | 'daily')}
          title="新建任务类型 — 普通=标准计划项；里程碑=阶段节点（汇总其下任务）；日常=日常事务"
          aria-label="新建任务类型" style={{ ...inputStyle, minWidth: 96 }}>
          <option value="normal">普通任务</option>
          <option value="milestone">阶段里程碑</option>
          <option value="daily">日常任务</option>
        </select>
        <button className="tbtn-anim" onClick={() => void createPlan()} disabled={busy} title={`新建${newKind === 'milestone' ? '里程碑' : newKind === 'daily' ? '日常任务' : '任务'} — 按上方所选类型创建`} aria-label="新建计划任务" style={{ ...btnStyle, padding: '6px 8px' }}><CalendarPlus size={13} /></button>
        <label className="tbtn-anim" style={{ ...btnStyle, cursor: busy ? 'default' : 'pointer', padding: '6px 8px' }} title="导入 Excel — 批量导入计划任务（任一行校验失败则整体不入库）" aria-label="导入 Excel">
          <Upload size={13} />
          <input type="file" accept=".xlsx" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void importExcel(f); e.target.value = ''; } }} />
        </label>
        <button className="tbtn-anim" onClick={() => void exportExcel()} title="导出 Excel — 导出当前项目全部计划" aria-label="导出 Excel" style={{ ...btnStyle, padding: '6px 8px' }}><Download size={13} /></button>
        <button className="tbtn-anim" onClick={() => void downloadTemplate()} title="下载模板 — 获取导入用 Excel 模板" aria-label="下载导入模板" style={{ ...btnStyle, padding: '6px 8px' }}><FileSpreadsheet size={13} /></button>
        {/* T00526 调整：模型选择与任务菜单同款——收起只显模型名，展开显示厂商+模型 */}
        {renderAiToolDropdown({ minWidth: 110 })}
        <button className="tbtn-anim" onClick={openAiImport} title="AI 导入 — 上传任意格式计划 Excel，AI 自动识别字段并重组为标准计划" aria-label="AI 导入" style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)', padding: '6px 8px' }}><Sparkles size={13} /></button>
        <button onClick={() => batchEvaluatePlans()} disabled={evalBusy || busy} title="AI 评估 — 对全部计划条目评估工期合理性/风险与建议，结果自动录入各条描述（确认后执行）" aria-label="批量 AI 评估" style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
          {evalBusy ? <Loader2 size={13} className="aispin" /> : <Zap size={13} />}AI 评估{evalLabel && plans.length > 0 ? `（${evalLabel}）` : ''}
        </button>
        <fieldset style={{ display: 'inline-flex', margin: 0, padding: 0, minWidth: 0, border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }} aria-label="视图切换">
          <button onClick={() => setViewMode('list')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: viewMode === 'list' ? 'var(--accent)' : 'transparent', color: viewMode === 'list' ? 'var(--accent-text)' : 'var(--text)' }} title="列表视图">列表</button>
          <button onClick={() => setViewMode('gantt')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: viewMode === 'gantt' ? 'var(--accent)' : 'transparent', color: viewMode === 'gantt' ? 'var(--accent-text)' : 'var(--text)' }} title="甘特图视图 — 按串行瀑布时间线可视化">甘特</button>
        </fieldset>
        <button onClick={openHolidayManager} style={btnStyle} title="节假日管理 — 手动维护 / 联网导入法定节假日 / 万年历视图">节假日（{holidays.length}）</button>
        <button onClick={reload} style={btnStyle} title="刷新"><RefreshCw size={13} /></button>
        {notice && <span className="flash-toast" role="status">{notice}</span>}
      </div>

      {/* T00507：项目整体统计（原节假日摘要栏位置；节假日管理保留按钮弹窗） */}
      {plans.length > 0 && (() => {
        const starts = plans.map((p) => p.start_date).filter(Boolean).sort();
        const ends = plans.map((p) => p.end_date).filter(Boolean).sort();
        const totalDays = plans.reduce((acc, p) => acc + (p.duration_days || 0), 0);
        const doneCount = plans.filter((p) => p.status === 'done').length;
        const doingCount = plans.filter((p) => p.status === 'doing').length;
        const milestoneCount = plans.filter((p) => (p as PlanTask & { kind?: string }).kind === 'milestone').length;
        return (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span title={`起 ${starts[0] ?? '—'} · 止 ${ends.at(-1) ?? '—'}`}>项目周期：{starts[0] ?? '—'} ~ {ends.at(-1) ?? '—'}</span>
            <span title="全部任务工期（工作日）合计">工作量：{totalDays} 人天</span>
            <span title={`共 ${plans.length} 条计划任务`}>任务：{plans.length} 条</span>
            <span title={`已完成 ${doneCount} · 进行中 ${doingCount}`} style={{ color: doneCount === plans.length ? 'var(--success)' : undefined }}>完成 {doneCount}/{plans.length}</span>
            {milestoneCount > 0 && <span title={`里程碑 ${milestoneCount} 个`}>里程碑：{milestoneCount}</span>}
          </div>
        );
      })()}

      {/* 计划表格：串行瀑布，起止由服务端按工作日推算 */}
      {viewMode === 'gantt' ? renderGantt() : (
      <table className="plan-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-strong)' }}>
            <th style={{ padding: 6, minWidth: 64 }}>前置依赖</th>
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
          {(() => {
            // T00527：层次显示序号——顶层任务序号顺延（里程碑占一个序号，子任务 N.x 不占顶层计数）
            const seqs = new Map<string, string>();
            const childCounts = new Map<string, number>();
            let top = 0;
            for (const p of plans) {
              const pm = childMilestoneOf(p, plans);
              if (pm) {
                const c = (childCounts.get(pm.id) ?? 0) + 1;
                childCounts.set(pm.id, c);
                seqs.set(p.id, `${seqs.get(pm.id) ?? ''}.${c}`);
              } else {
                top += 1;
                seqs.set(p.id, String(top));
              }
            }
            return plans.map((p, i) => {
            // T00506：里程碑汇总——本里程碑到下一里程碑之间的普通/日常任务（count/Σ工期/平均进度）
            const isMilestone = p.kind === 'milestone';
            let mEnd = plans.length;
            for (let j = i + 1; j < plans.length; j++) { if (plans[j].kind === 'milestone') { mEnd = j; break; } }
            const inner = isMilestone ? plans.slice(i + 1, mEnd).filter((x) => x.kind !== 'milestone') : [];
            const innerCount = inner.length;
            const innerDays = inner.reduce((acc, x) => acc + (x.duration_days || 0), 0);
            const innerAvg = innerCount ? Math.round(inner.reduce((acc, x) => acc + (x.progress || 0), 0) / innerCount) : 0;
            const innerLatestEnd = inner.map((x) => x.end_date).filter(Boolean).sort().at(-1) ?? ''; // T00514：里程碑结束=子任务最晚结束
            // T00508：挂接里程碑的子任务——父里程碑收起时整行隐藏
            const parentMs = childMilestoneOf(p, plans);
            if (parentMs && collapsedMs[parentMs.id]) return null;
            return (
            <tr key={p.id}
              draggable
              onDragStart={() => setDragId(p.id)}
              onDragEnd={() => { setDragId(''); setOverId(''); }}
              onDragOver={(e) => { e.preventDefault(); if (p.id !== dragId) setOverId(p.id); }}
              onDrop={(e) => {
                e.preventDefault();
                // T00508：拖到里程碑行上 = 挂接为子任务；拖到普通行 = 排序
                // T00527：挂接目标=里程碑行 或 里程碑的子任务行（挂到其父里程碑）
                const attachTarget = p.kind === 'milestone' ? p : childMilestoneOf(p, plans);
                if (attachTarget && dragId && dragId !== p.id) {
                  const dragged = plans.find((x) => x.id === dragId);
                  if (!dragged || dragged.kind === 'milestone') { setDragId(''); setOverId(''); return; }
                  let oldDeps: Array<{ id: string; type: string }> = [];
                  try { oldDeps = dragged.deps ? JSON.parse(dragged.deps) : []; } catch { oldDeps = []; }
                  const kept = oldDeps.filter((d) => d.type !== 'child');
                  void updatePlan(dragged, { deps: JSON.stringify([...kept, { id: attachTarget.id, type: 'child' }]) });
                  flash(`已挂到里程碑「${attachTarget.title}」下`);
                  setDragId(''); setOverId('');
                  return;
                }
                onDropReorder(p.id);
              }}
              className={planRowClass(dragId, overId, newRowId, p.id)}
              style={{ borderBottom: '1px solid var(--border)', transition: 'box-shadow .15s ease, transform .15s ease, background .15s ease' }}>
              {/* T00499：前置依赖列——显示前置任务序号（可点配置），serial=串行 predecessor 之后自动排期 */}
              <td style={{ padding: 6, fontSize: 11 }}>
                {(() => {
                  let depList: Array<{ id: string; type: string }> = [];
                  try { depList = p.deps ? JSON.parse(p.deps) : []; } catch { depList = []; }
                  // T00518：挂接里程碑的记录（deps 仅含 child）也保留管理入口
                  const hasOnlyChild = depList.length > 0 && depList.every((d) => d.type === 'child');
                  if (hasOnlyChild) return (
                    <button onClick={() => openDepEditor(p)} title="已挂接里程碑 — 点击维护依赖/挂接关系" aria-label="已挂接里程碑：维护依赖"
                      style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, padding: '0 4px', borderRadius: 4 }}>◈ 维护</button>
                  );
                  if (depList.length === 0) return (
                    <button onClick={() => openDepEditor(p)} title="配置前置依赖 — 选择前置任务并标记串行/并行" aria-label="配置前置依赖"
                      style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: 0 }}>＋</button>
                  );
                  return (
                    <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                      {depList.filter((d) => d.type !== 'child').map((d) => {
                        // T00527 修正：依赖序号也用顺延 seqs，与序号列一致
                        const seqStr = seqs.get(d.id);
                        const seq = seqStr ? parseInt(seqStr, 10) : 0;
                        return (
                          <button key={d.id} onClick={() => openDepEditor(p)}
                            title={`${d.type === 'serial' ? '串行' : '并行'}依赖：${plans.find((x) => x.id === d.id)?.title ?? '已删除'}（点击调整）`}
                            style={{ border: '1px solid var(--border-strong)', background: d.type === 'serial' ? 'var(--accent-soft)' : 'transparent', color: d.type === 'serial' ? 'var(--accent)' : 'var(--text-muted)', borderRadius: 4, fontSize: 10, padding: '0 4px', cursor: 'pointer' }}>
                            {seq > 0 ? `#${seq}` : '?'}{d.type === 'serial' ? '串' : '并'}
                          </button>
                        );
                      })}
                    </span>
                  );
                })()}
              </td>
              <td style={{ padding: 6, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {p.kind === 'milestone' ? (
                  <span title="阶段里程碑 — 汇总其下普通/日常任务，不可手动调整；点击标题旁箭头收起/展开子任务" style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 13 }}>◆ {seqs.get(p.id) ?? i + 1}</span>
                ) : childMilestoneOf(p, plans) ? (
                  // T00527 修正：子任务序号直接用预计算 seqs（N.c 格式，N=父里程碑顺延序号），修复外面普通任务被 index 顶到 6 的显示 bug
                  <span style={{ marginLeft: 16 }}>{seqs.get(p.id) ?? ''}</span>
                ) : p.kind === 'daily' ? <span title="日常任务" style={{ color: 'var(--text-muted)' }}>◇ {seqs.get(p.id) ?? i + 1}</span> : seqs.get(p.id) ?? i + 1}
              </td>
              <td style={{ padding: 6, minWidth: 220, paddingLeft: childMilestoneOf(p, plans) ? 24 : 6 }}>
                {p.kind === 'milestone' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', marginRight: 4 }}>
                    <button onClick={() => setCollapsedMs((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                      title={collapsedMs[p.id] ? '展开子任务' : '收起子任务'} aria-label={collapsedMs[p.id] ? '展开子任务' : '收起子任务'}
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--accent)', padding: 0, display: 'inline-flex' }}>
                      {collapsedMs[p.id] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </button>
                  </span>
                )}
                <input defaultValue={p.title} title={`全量标题：${p.title}`} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== p.title) void updatePlan(p, { title: e.target.value.trim() }); }}
                  style={{ ...inputStyle, width: '100%', color: p.color || 'var(--text)', fontWeight: p.kind === 'milestone' ? 700 : undefined, fontSize: p.kind === 'milestone' ? 14 : 12 }} aria-label="计划标题" />
                <input defaultValue={p.description} title={`全量描述：${p.description || '（无描述）'}`} placeholder="描述（可空）" className="plan-desc-ph" onBlur={(e) => { if (e.target.value !== p.description) void updatePlan(p, { description: e.target.value }); }}
                  style={{ ...inputStyle, width: '100%', marginTop: 2, color: 'var(--text-muted)' }} aria-label="计划描述" />
              </td>
              <td style={{ padding: 6 }}>
                {isMilestone ? <span style={{ color: 'var(--text-muted)' }}>{p.start_date}</span> : (
                <input type="date" defaultValue={p.start_date} onBlur={(e) => { if (e.target.value && e.target.value !== p.start_date) void updatePlan(p, { start_date: e.target.value }); }}
                  style={inputStyle} aria-label="开始日期" />)}
              </td>
              <td style={{ padding: 6 }}>
                {(() => {
                  // T00514：里程碑结束时间 = 关联子任务最晚结束（只读）；普通任务可编辑（自然日差换算工期）
                  if (isMilestone) {
                    const latest = inner.map((x) => x.end_date).filter(Boolean).sort().at(-1) ?? p.end_date;
                    return <span title={`关联任务最晚结束：${latest}`} style={{ color: 'var(--text-muted)' }}>{latest}</span>;
                  }
                  return (
                    <input type="date" defaultValue={p.end_date} onBlur={(e) => {
                      const v = e.target.value;
                      if (!v || v === p.end_date) return;
                      const days = Math.max(1, Math.round((new Date(v).getTime() - new Date(p.start_date).getTime()) / 86400000));
                      void updatePlan(p, { duration_days: days });
                    }} style={{ ...inputStyle, width: 108 }} aria-label="结束日期" />
                  );
                })()}
              </td>
              <td style={{ padding: 6 }}>
                {isMilestone ? <span title={`汇总：${innerCount} 项普通/日常任务，合计 ${innerDays} 工作日`} style={{ color: 'var(--accent)', fontWeight: 600 }}>Σ {innerCount} 项 · {innerDays} 天</span> : (
                <input type="number" min={1} defaultValue={p.duration_days} onBlur={(e) => { const v = Number(e.target.value); if (v >= 1 && v !== p.duration_days) void updatePlan(p, { duration_days: v }); }}
                  style={{ ...inputStyle, width: 40 }} aria-label="工期（工作日）" />)}
              </td>
              <td style={{ padding: 6 }}>
                {isMilestone ? <span title={`汇总：${innerCount} 项平均进度 ${innerAvg}%`} style={{ color: 'var(--accent)', fontWeight: 600 }}>{innerAvg}%</span> : (
                <input type="number" min={0} max={100} defaultValue={p.progress} onBlur={(e) => { const v = Number(e.target.value); if (v >= 0 && v <= 100 && v !== p.progress) void updatePlan(p, { progress: v }); }}
                  style={{ ...inputStyle, width: 40 }} aria-label="进度百分比" />)}
              </td>
              <td style={{ padding: 6 }}>
                {isMilestone ? <span style={{ color: 'var(--text-muted)' }}>—</span> : (<>
                {/* 点击状态徽标流转到下一状态：待办→进行中→已完成→待办；blocked 经已完成 后回待办 */}
                <button onClick={() => void updatePlan(p, { status: NEXT_STATUS[p.status] })}
                  title="点击流转到下一状态" aria-label={`状态：${STATUS_META[p.status].label}，点击流转`}
                  style={{ ...btnStyle, color: STATUS_META[p.status].color, borderColor: STATUS_META[p.status].color }}>
                  {STATUS_META[p.status].label}
                </button></>)}
              </td>
              <td style={{ padding: 6 }}>
                {isMilestone ? <span style={{ color: 'var(--text-muted)' }}>—</span> : (
                <input defaultValue={p.assignee} placeholder="—" onBlur={(e) => { if (e.target.value !== p.assignee) void updatePlan(p, { assignee: e.target.value }); }}
                  style={{ ...inputStyle, width: 80 }} aria-label="负责人" />)}
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
                <button onClick={() => void insertAfter(p)} title="在此行后插入新任务 — 后续排期自动重排" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-muted)', padding: 2 }}><Plus size={13} /></button>
                                {/* T00501：字体颜色按钮置于按钮栏最前 */}
                <span className="task-op" style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <FontColorButton current={p.color ?? ''} onApply={(c) => { void updatePlan(p, { color: c }); }} />
                </span>
<button onClick={() => void archivePlan(p)} title="归档计划任务 — 从时间线移除，可在「归档」菜单恢复或彻底删除" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--danger)', padding: 2 }}><Archive size={13} /></button>
                {/* T00472：单条 AI 评估——结果自动录入该行描述（保存）或取消不写 */}
                <button onClick={() => { if (evalBusy) return; if (!aiToolId) { flash('请先选择 AI 模型'); return; } void evaluateOnePlan(p).then((okk) => { if (okk) flash('AI 评估已写入该行描述'); }); }} disabled={evalBusy || busy} title="AI 评估 — 评估该条工期合理性/风险与建议，结果自动录入描述" aria-label="AI 评估该条" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--accent)', padding: 2 }}>
                  {evalBusy ? <Loader2 size={13} className="aispin" /> : <Zap size={13} />}
                </button>
              </td>
            </tr>
          );
          });
          })()}
          {plans.length === 0 && (
            <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>当前项目暂无计划任务：可「新建任务」或「导入 Excel」批量创建</td></tr>
          )}
        </tbody>
      </table>
      )}

      {/* T00438 AI 导入弹窗：模型选择 + 文件上传 → AI 解析草稿表格（可编辑/勾选）→ 批量保存 */}
      {aiOpen && (
        <div /* NOSONAR - 弹窗外层全屏遮罩需保持 div 布局；点击遮罩仅为鼠标便捷操作，弹窗内原生关闭按钮提供键盘可达通路 */
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget && !aiBusy) setAiOpen(false); }}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(720px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
              <Sparkles size={14} style={{ color: 'var(--accent)' }} /> AI 导入计划
              <span style={{ flex: 1 }} />
              <button onClick={() => setAiOpen(false)} disabled={aiBusy} title="关闭" aria-label="关闭 AI 导入弹窗"
                style={{ display: 'inline-flex', alignItems: 'center', cursor: aiBusy ? 'default' : 'pointer', background: 'transparent', border: 'none', color: 'var(--text)' }}>×</button>
            </div>
            <div style={{ padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>AI 模型：</label>
                {renderAiToolDropdown()}
                <label style={{ ...btnStyle, cursor: aiBusy ? 'default' : 'pointer' }} title="选择计划 Excel（.xlsx/.csv）或需求文档（.md/.docx）">
                  <Upload size={13} />选择文件
                  <input type="file" accept=".xlsx,.csv,.md,.markdown,.docx" style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) { void aiParse(f); e.target.value = ''; } }} />
                </label>
                {aiFileName && <span style={{ color: 'var(--text-muted)' }}>{aiFileName}</span>}
                {aiBusy && <span style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sparkles size={12} />AI 解析中…</span>}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>
                上传任意格式的计划 Excel，AI 自动识别任务名称、起止日期、工期、负责人与状态并重组为标准格式；或上传 Markdown / Word 需求文档（.md/.docx），AI 按 WBS 规范自动拆分任务并估算工期。解析结果先在此预览，可编辑后勾选保存；保存后时间线统一重排。
              </div>
              {aiError && <div style={{ color: 'var(--danger)' }}>{aiError}</div>}
              {aiRows.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    解析到 {aiRows.length} 条（已勾选 {aiRows.filter((r) => r.include).length} 条）——可编辑后保存：
                  </div>
                  <div style={{ maxHeight: '42vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {aiRows.map((row, i) => (
                      <div key={row.rowKey} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <input type="checkbox" checked={row.include} aria-label={`勾选第 ${i + 1} 条`}
                            onChange={(e) => setAiRows((prev) => updateAiRow(prev, i, { include: e.target.checked }))} />
                          <input value={row.title} aria-label={`第 ${i + 1} 条标题`}
                            onChange={(e) => setAiRows((prev) => updateAiRow(prev, i, { title: e.target.value }))}
                            style={{ ...inputStyle, flex: 1, minWidth: 160, fontWeight: 600 }} />
                          <input type="date" value={row.startDate} aria-label={`第 ${i + 1} 条开始日期`}
                            onChange={(e) => setAiRows((prev) => updateAiRow(prev, i, { startDate: e.target.value }))}
                            style={inputStyle} />
                          <input type="number" min={1} value={row.durationDays} aria-label={`第 ${i + 1} 条工期`}
                            onChange={(e) => setAiRows((prev) => updateAiRow(prev, i, { durationDays: Math.max(1, Number(e.target.value) || 1) }))}
                            style={{ ...inputStyle, width: 60 }} />
                          <input value={row.assignee} placeholder="负责人" aria-label={`第 ${i + 1} 条负责人`}
                            onChange={(e) => setAiRows((prev) => updateAiRow(prev, i, { assignee: e.target.value }))}
                            style={{ ...inputStyle, width: 80 }} />
                          <select value={row.status} aria-label={`第 ${i + 1} 条状态`}
                            onChange={(e) => setAiRows((prev) => updateAiRow(prev, i, { status: e.target.value as PlanDraft['status'] }))}
                            style={inputStyle}>
                            <option value="todo">待开始</option>
                            <option value="doing">进行中</option>
                            <option value="done">已完成</option>
                            <option value="blocked">受阻</option>
                          </select>
                        </div>
                        <input value={row.description} placeholder="描述（可空）" className="plan-desc-ph" aria-label={`第 ${i + 1} 条描述`}
                          onChange={(e) => setAiRows((prev) => updateAiRow(prev, i, { description: e.target.value }))}
                          style={{ ...inputStyle, color: 'var(--text-muted)' }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setAiOpen(false)} disabled={aiBusy} title="取消"
                style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)' }}>取消</button>
              <button onClick={() => void aiSave()} disabled={aiBusy || aiRows.length === 0} title="保存勾选的条目为项目计划"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, cursor: aiRows.length === 0 ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', opacity: aiRows.length === 0 ? 0.5 : 1 }}>
                <Sparkles size={12} />保存 {aiRows.filter((r) => r.include).length} 条
              </button>
            </div>
          </div>
        </div>
      )}
      {/* T00442 节假日多功能弹窗：手动维护 / 联网导入法定节假日 / 万年历 */}
      {holiOpen && (
        <div /* NOSONAR - 弹窗外层全屏遮罩需保持 div 布局；点击遮罩仅为鼠标便捷操作，弹窗内原生关闭按钮提供键盘可达通路 */
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget && !holiBusy) setHoliOpen(false); }}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(760px, 94vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
              <span>节假日管理</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setHoliOpen(false)} disabled={holiBusy} title="关闭" aria-label="关闭节假日管理"
                style={{ display: 'inline-flex', alignItems: 'center', cursor: holiBusy ? 'default' : 'pointer', background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 14 }}>×</button>
            </div>
            <div style={{ display: 'flex', gap: 4, padding: '8px 14px 0' }}>
              {([['manage', '手动维护'], ['national', '联网导入'], ['calendar', '万年历']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setHoliTab(k)}
                  style={{ padding: '5px 12px', borderRadius: '6px 6px 0 0', cursor: 'pointer', border: '1px solid var(--border-strong)', borderBottom: holiTab === k ? 'none' : '1px solid var(--border-strong)', background: holiTab === k ? 'var(--surface)' : 'var(--card-bg)', color: holiTab === k ? 'var(--accent)' : 'var(--text)', fontSize: 12 }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
              {holiTab === 'manage' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <input type="date" value={holiNewDate} onChange={(e) => setHoliNewDate(e.target.value)} style={inputStyle} aria-label="节假日日期" />
                    <input value={holiNewName} placeholder="名称（如：国庆节）" onChange={(e) => setHoliNewName(e.target.value)} style={{ ...inputStyle, width: 140 }} aria-label="节假日名称" />
                    <button onClick={() => void addHolidayInModal()} disabled={holiBusy} style={btnStyle}>添加</button>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>共 {holidays.length} 条</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '44vh', overflowY: 'auto' }}>
                    {holidays.length === 0 && <div style={{ color: 'var(--text-muted)' }}>暂无节假日。可手动添加，或在「联网导入」页签拉取国家法定节假日。</div>}
                    {holidays.map((h) => (
                      <div key={h.date} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px' }}>
                        <span style={{ fontWeight: 600, minWidth: 90 }}>{h.date}</span>
                        <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{h.name || '—'}</span>
                        <button onClick={() => void removeHoliday(h.date)} disabled={holiBusy} title="移除该节假日"
                          style={{ border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', display: 'inline-flex' }}><Trash2 size={13} /></button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {holiTab === 'national' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <label htmlFor="plan-nat-year" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>导入年份：</label>
                    <input id="plan-nat-year" type="number" min={2000} max={2100} value={natYear} onChange={(e) => setNatYear(Number(e.target.value) || new Date().getFullYear())} style={{ ...inputStyle, width: 90 }} aria-label="导入年份" />
                    <button onClick={() => void importNational()} disabled={holiBusy} style={btnStyle}>导入 {natYear} 年法定节假日</button>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>
                    从国家法定节假日公开数据源拉取全年放假安排（元旦/春节/清明/劳动/端午/中秋/国庆等）。导入为 upsert 幂等——重复导入自动合并；仅导入法定放假日，调休补班日暂不处理。导入后所有项目计划时间线自动重排。
                  </div>
                  {natMsg && <div style={{ color: natMsg.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>{natMsg}</div>}
                </>
              )}
              {holiTab === 'calendar' && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => setCalYear((y) => y - 1)} disabled={holiBusy} style={btnStyle}>←</button>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{calYear} 年万年历</span>
                    <button onClick={() => setCalYear((y) => y + 1)} disabled={holiBusy} style={btnStyle}>→</button>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}><span style={{ color: 'var(--danger)', fontWeight: 600 }}>■</span> 法定节假日　<span style={{ color: 'var(--text-muted)' }}>■</span> 周末</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {Array.from({ length: 12 }, (_, m) => renderMonthGrid(calYear, m))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* T00499 前置依赖配置弹窗：任务列表多选 + 串行/并行标记 */}
      {depEditor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onMouseDown={(e) => { if (e.target === e.currentTarget) setDepEditor(null); }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: 16, width: 460, maxHeight: '72vh', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, boxShadow: '0 8px 28px rgba(0,0,0,.2)' }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>配置前置依赖 —— #{depEditor.seq} {plans.find((x) => x.id === depEditor.id)?.title}</div>
            <div style={{ color: 'var(--text-muted)' }}>
              勾选前置任务并标记依赖类型：<span style={{ color: 'var(--accent)' }}>串行</span> = 前置完成后自动接续开始；<span style={{ color: 'var(--text)' }}>并行</span> = 仅标记关系，不自动调整开始日。
            </div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
              {plans.filter((x) => x.id !== depEditor.id).map((x) => {
                const seq = plans.findIndex((y) => y.id === x.id) + 1;
                const selType = depSel[x.id];
                return (
                  <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, background: selType ? 'var(--accent-soft)' : 'transparent' }}>
                    <input type="checkbox" checked={Boolean(selType)} aria-label={`选择前置任务 ${x.title}`}
                      onChange={(e) => setDepSel((prev) => { const n = { ...prev }; if (e.target.checked) { n[x.id] = 'serial'; } else { delete n[x.id]; } return n; })}
                      style={{ cursor: 'pointer', flexShrink: 0 }} />
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>#{seq}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.title}>{x.title}</span>
                    {selType && (
                      <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
                        {(['serial', 'parallel'] as const).map((tp) => (
                          <button key={tp} onClick={() => setDepSel((prev) => ({ ...prev, [x.id]: tp }))}
                            title={tp === 'serial' ? '串行：前置完成后自动接续' : '并行：仅标记关系'}
                            style={{ padding: '1px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', border: '1px solid var(--border-strong)', background: selType === tp ? 'var(--accent)' : 'transparent', color: selType === tp ? 'var(--accent-text)' : 'var(--text)' }}>
                            {tp === 'serial' ? '串行' : '并行'}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setDepEditor(null)} title="取消 — 不保存本次调整" aria-label="取消配置依赖" style={{ ...btnStyle }}>取消</button>
              <button onClick={() => saveDeps()} title="保存 — 写入依赖并按串行前置自动调整开始日" aria-label="保存依赖配置" style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
