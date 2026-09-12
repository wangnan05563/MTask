import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CalendarPlus, Download, FileSpreadsheet, Link2, Link2Off, Loader2, Plus, RefreshCw, Sparkles, Trash2, Upload, Zap } from 'lucide-react';
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
}

interface ProjectRow { id: string; name: string }

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
const inputStyle: React.CSSProperties = { border: '1px solid var(--border-strong)', borderRadius: 4, padding: '3px 6px', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 };
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
  // T00472：AI 评估状态（批量进度动态计数，单条/批量共用）
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalLabel, setEvalLabel] = useState('');
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

  // ---------- T00472：AI 评估 ----------
  /** 单条评估：调 AI 生成评估文本，追加到该行描述（[AI评估 日期] 前缀），返回是否成功 */
  async function evaluateOnePlan(p: PlanTask): Promise<boolean> {
    try {
      const r = await api.post<{ ok: boolean; results: Array<{ id: string; ok: boolean; evaluation?: string; error?: string }> }>(
        '/plans/ai-evaluate',
        { toolId: aiToolId, items: [{ id: p.id, title: p.title, duration_days: p.duration_days, progress: p.progress, assignee: p.assignee }] },
      );
      const first = r.results?.[0];
      if (!first?.ok || !first.evaluation) { flash(first?.error ?? 'AI 评估失败'); return false; }
      const stamp = new Date().toISOString().slice(5, 10).replace('-', '/');
      const merged = p.description ? p.description + '\n' + `[AI评估 ${stamp}] ${first.evaluation}` : `[AI评估 ${stamp}] ${first.evaluation}`;
      await updatePlan(p, { description: merged });
      return true;
    } catch (e) { flash(String((e as Error).message ?? e)); return false; }
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
      <style>{planTableCss}</style>
      {/* 工具条：项目选择 + 增删导入导出 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="toolbar-reveal" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span className="toolbar-reveal" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ ...inputStyle, minWidth: 140 }} aria-label="选择项目">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        </span>
        </span>
        <button onClick={() => void createPlan()} disabled={busy} style={btnStyle}><CalendarPlus size={13} />新建任务</button>
        <label style={{ ...btnStyle, cursor: busy ? 'default' : 'pointer' }} title="导入 Excel（任一行校验失败则整体不入库）">
          <Upload size={13} />导入 Excel
          <input type="file" accept=".xlsx" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void importExcel(f); e.target.value = ''; } }} />
        </label>
        <button onClick={() => void exportExcel()} style={btnStyle}><Download size={13} />导出 Excel</button>
        <button onClick={() => void downloadTemplate()} style={btnStyle}><FileSpreadsheet size={13} />下载模板</button>
        <button onClick={openAiImport} style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }} title="AI 导入 — 上传任意格式计划 Excel，AI 自动识别字段并重组为标准计划"><Sparkles size={13} />AI 导入</button>
        <button onClick={() => batchEvaluatePlans()} disabled={evalBusy || busy} title="AI 评估 — 对全部计划条目评估工期合理性/风险与建议，结果自动录入各条描述（确认后执行）" aria-label="批量 AI 评估" style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
          {evalBusy ? <Loader2 size={13} className="aispin" /> : <Zap size={13} />}AI 评估{evalLabel && plans.length > 0 ? `（${evalLabel}）` : ''}
        </button>
        <fieldset style={{ display: 'inline-flex', margin: 0, padding: 0, minWidth: 0, border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }} aria-label="视图切换">
          <button onClick={() => setViewMode('list')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: viewMode === 'list' ? 'var(--accent)' : 'transparent', color: viewMode === 'list' ? 'var(--accent-text)' : 'var(--text)' }} title="列表视图">列表</button>
          <button onClick={() => setViewMode('gantt')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: viewMode === 'gantt' ? 'var(--accent)' : 'transparent', color: viewMode === 'gantt' ? 'var(--accent-text)' : 'var(--text)' }} title="甘特图视图 — 按串行瀑布时间线可视化">甘特</button>
        </fieldset>
        <button onClick={openHolidayManager} style={btnStyle} title="节假日管理 — 手动维护 / 联网导入法定节假日 / 万年历视图">节假日（{holidays.length}）</button>
        <button onClick={reload} style={btnStyle} title="刷新"><RefreshCw size={13} /></button>
        {notice && <span style={{ fontSize: 12, color: 'var(--accent)' }}>{notice}</span>}
      </div>

      {/* 节假日摘要（快速可见；完整管理进弹窗） */}
      {holidays.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>节假日（时间线自动避开）：</span>
          {holidays.slice(0, 6).map((h) => (
            <span key={h.date} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '0 6px' }}>{h.date} {h.name}</span>
          ))}
          {holidays.length > 6 && <span>… 共 {holidays.length} 条</span>}
          <button onClick={openHolidayManager} style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>管理…</button>
        </div>
      )}

      {/* 计划表格：串行瀑布，起止由服务端按工作日推算 */}
      {viewMode === 'gantt' ? renderGantt() : (
      <table className="plan-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
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
            <tr key={p.id}
              draggable
              onDragStart={() => setDragId(p.id)}
              onDragEnd={() => { setDragId(''); setOverId(''); }}
              onDragOver={(e) => { e.preventDefault(); if (p.id !== dragId) setOverId(p.id); }}
              onDrop={() => onDropReorder(p.id)}
              className={planRowClass(dragId, overId, newRowId, p.id)}
              style={{ borderBottom: '1px solid var(--border)', transition: 'box-shadow .15s ease, transform .15s ease, background .15s ease' }}>
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
                {/* 点击状态徽标流转到下一状态：待办→进行中→已完成→待办；blocked 经已完成 后回待办 */}
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
                <button onClick={() => void insertAfter(p)} title="在此行后插入新任务 — 后续排期自动重排" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-muted)', padding: 2 }}><Plus size={13} /></button>
                <button onClick={() => void archivePlan(p)} title="归档计划任务 — 从时间线移除，可在「归档」菜单恢复或彻底删除" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--danger)', padding: 2 }}><Archive size={13} /></button>
                {/* T00472：单条 AI 评估——结果自动录入该行描述（保存）或取消不写 */}
                <button onClick={() => { if (evalBusy) return; if (!aiToolId) { flash('请先选择 AI 模型'); return; } void evaluateOnePlan(p).then((okk) => { if (okk) flash('AI 评估已写入该行描述'); }); }} disabled={evalBusy || busy} title="AI 评估 — 评估该条工期合理性/风险与建议，结果自动录入描述" aria-label="AI 评估该条" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--accent)', padding: 2 }}>
                  {evalBusy ? <Loader2 size={13} className="aispin" /> : <Zap size={13} />}
                </button>
              </td>
            </tr>
          ))}
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
                <label htmlFor="plan-ai-tool" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>AI 模型：</label>
                <select id="plan-ai-tool" value={aiToolId} onChange={(e) => setAiToolId(e.target.value)} style={inputStyle} aria-label="选择 AI 模型">
                  {tools.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
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
                        <input value={row.description} placeholder="描述（可空）" aria-label={`第 ${i + 1} 条描述`}
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
    </div>
  );
}
