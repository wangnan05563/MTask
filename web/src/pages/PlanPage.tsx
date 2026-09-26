import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowUpDown, CalendarPlus, Check, Download, ListChecks, GitBranch, MoreHorizontal, FileSpreadsheet, FileText, FilePenLine, Link2, Link2Off, Loader2, Pin, Plus, RefreshCw, Table2, Trash2, Upload, Zap, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState'; // T01072-FR1.10：统一空态组件
import { ReqMatrixPanel } from './ReqMatrixPanel'; // T00662：需求跟踪矩阵
import { PrdPanel } from './PrdPanel'; // T00770：PRD 管理视图（文档生命周期 + 待确认问题）
import { ProjectGuideDialog, hasSeenProjectGuide, markProjectGuideSeen } from './ProjectGuide'; // T00665：项目管理向导（T00706：已看状态改由调用方在关闭时记录）
import { PROJ_SORT_OPTIONS, PROJ_SORT_LABEL, isProjectPinned, sortProjects, toggleProjectPin, reorderProjects, type ProjectSortMode } from '../ui/projectOrder'; // T00663：排序/置顶共享模块
import { FontColorButton } from '../ui/FontColorButton';
import { api, type AITool } from '../api/client';
import { askConfirm, askInput, askInputEx } from '../ui/dialogs';
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
  /** T01058-FR2.1：AI 复杂度评级（1~5，≥4 标红提示建议拆分）；PRD 导入时 AI 输出 */
  complexity?: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  /** T00505：计划任务统计（下拉徽标） */
  plan_done?: number;
  plan_doing?: number;
  plan_open?: number;
  /** T00663：排序/置顶所需字段（与服务端 GET /projects 返回对齐） */
  sort_weight?: number;
  created_at?: string;
  todo_count?: number;
  unverified_count?: number;
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

/** AI 模型默认整理工具优先排序 */
function compareOrganize(a: AITool, b: AITool): number {
  return Number(b.isDefaultOrganize) - Number(a.isDefaultOrganize);
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

/** 计划行补丁类型（与 updatePlan 第二参对齐，提取单元格组件复用） */
type PlanPatch = Partial<Pick<PlanTask, 'title' | 'description' | 'duration_days' | 'assignee' | 'progress' | 'status' | 'start_date' | 'color' | 'deps'>>;

type HolidayTab = 'manage' | 'national' | 'calendar';

/** 甘特页项目选择器：触发按钮 + 排序菜单 + 项目下拉（T00663，S3776 抽取） */
function PlanProjectPicker({ projects, sortedProjects, projectId, setProjectId, projDropRef, sortDropRef, projOpen, setProjOpen, projDropPos, setProjDropPos, projSortOpen, setProjSortOpen, projSortMode, setProjSortMode, dragProjId, setDragProjId, overProjId, setOverProjId, dropReorder, togglePin, isProjectPinned }: {
  readonly projects: ProjectRow[]; readonly sortedProjects: ProjectRow[]; readonly projectId: string; readonly setProjectId: (id: string) => void;
  readonly projDropRef: React.MutableRefObject<HTMLDivElement | null>;
  readonly sortDropRef: React.MutableRefObject<HTMLSpanElement | null>;
  readonly projOpen: boolean; readonly setProjOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly projDropPos: { top: number; left: number } | null; readonly setProjDropPos: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>;
  readonly projSortOpen: boolean; readonly setProjSortOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly projSortMode: ProjectSortMode; readonly setProjSortMode: React.Dispatch<React.SetStateAction<ProjectSortMode>>;
  readonly dragProjId: string; readonly setDragProjId: (id: string) => void;
  readonly overProjId: string; readonly setOverProjId: React.Dispatch<React.SetStateAction<string>>;
  readonly dropReorder: (id: string) => Promise<void> | void;
  readonly togglePin: (p: ProjectRow) => Promise<void> | void;
  readonly isProjectPinned: (p: ProjectRow) => boolean;
}) {
  const cur = projects.find((p) => p.id === projectId);
  return (
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
        {cur?.name ?? '选择项目'}
        {cur ? (
          <>
            <span title={`已完成 ${cur.plan_done ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--success-soft, rgba(22,163,74,.12))', color: 'var(--success)' }}>{cur.plan_done ?? 0}</span>
            <span title={`进行中 ${cur.plan_doing ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{cur.plan_doing ?? 0}</span>
            <span title={`待开始 ${cur.plan_open ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{cur.plan_open ?? 0}</span>
          </>
        ) : null}
        <ChevronDown size={12} />
      </button>
      {/* T00663：项目排序按钮（复用任务菜单同款排序方式与逻辑；默认隐藏、悬浮工具条显示） */}
      <span ref={sortDropRef} style={{ position: 'relative', display: 'inline-flex' }}>
        <button onClick={() => setProjSortOpen((v) => !v)} className="op-hidden tbtn-anim"
          title={`项目排序 — 当前：${PROJ_SORT_LABEL(projSortMode)}（拖拽排序需切到「默认（置顶优先）」）`}
          aria-label="项目排序" aria-haspopup="menu" aria-expanded={projSortOpen}
          style={{ display: 'inline-flex', alignItems: 'center', padding: '5px 8px', fontSize: 12, background: projSortOpen ? 'var(--accent)' : 'transparent', color: projSortOpen ? 'var(--accent-text)' : 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 4, cursor: 'pointer' }}>
          <ArrowUpDown size={13} />
        </button>
        {projSortOpen && (
          <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.14)', zIndex: 40, minWidth: 180 }}>
            {PROJ_SORT_OPTIONS.map((o) => (
              <button key={o.key} onClick={() => { setProjSortMode(o.key); setProjSortOpen(false); }}
                role="menuitemradio" aria-checked={projSortMode === o.key}
                title={o.hint}
                style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '5px 10px', fontSize: 12, border: 'none', background: projSortMode === o.key ? 'var(--accent-soft)' : 'transparent', color: projSortMode === o.key ? 'var(--accent)' : 'var(--text)', cursor: 'pointer' }}>
                <span style={{ width: 14, display: 'inline-flex', flexShrink: 0 }}>{projSortMode === o.key ? <Check size={12} style={{ color: 'var(--accent)' }} /> : null}</span>
                {o.label}
              </button>
            ))}
          </div>
        )}
      </span>
      {projOpen && projDropPos && (
        <div style={{ position: 'fixed', top: projDropPos.top, left: projDropPos.left, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.14)', zIndex: 60, minWidth: 240, maxHeight: `calc(100vh - ${projDropPos.top + 12}px)`, overflowY: 'auto' }}>
          {/* T00663：项目下拉项——置顶图标在名称前；默认序下支持拖拽排序（持久化到服务端） */}
          {sortedProjects.map((p) => (
            <button key={p.id} aria-pressed={p.id === projectId}
              draggable={projSortMode === 'default'}
              onDragStart={() => setDragProjId(p.id)}
              onDragOver={(e) => { if (projSortMode === 'default' && dragProjId) { e.preventDefault(); setOverProjId(p.id); } }}
              onDragLeave={() => setOverProjId((curId) => (curId === p.id ? '' : curId))}
              onDrop={(e) => { e.preventDefault(); runAsync(dropReorder(p.id)); }}
              onDragEnd={() => { setDragProjId(''); setOverProjId(''); }}
              onClick={() => { setProjectId(p.id); setProjOpen(false); }}
              title={projSortMode === 'default'
                ? `${p.name}：已完成 ${p.plan_done ?? 0}，进行中 ${p.plan_doing ?? 0}，待开始 ${p.plan_open ?? 0}（可拖拽调整顺序）`
                : `${p.name}：已完成 ${p.plan_done ?? 0}，进行中 ${p.plan_doing ?? 0}，待开始 ${p.plan_open ?? 0}（拖拽排序请切换到「默认（置顶优先）」）`}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 12, opacity: dragProjId === p.id ? 0.5 : 1, borderTop: overProjId === p.id ? '2px solid var(--accent)' : '2px solid transparent', background: p.id === projectId ? 'var(--accent-soft)' : 'transparent', color: 'var(--text)', cursor: projSortMode === 'default' ? 'grab' : 'pointer' }}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); runAsync(togglePin(p)); }}
                title={isProjectPinned(p) ? `已置顶「${p.name}」— 点击取消置顶` : `置顶「${p.name}」— 点击后在默认排序下排最前`}
                aria-label={isProjectPinned(p) ? `取消置顶 ${p.name}` : `置顶 ${p.name}`}
                style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: isProjectPinned(p) ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', border: 'none', background: 'transparent', padding: 0 }}
              >
                <Pin size={12} style={{ transform: isProjectPinned(p) ? 'rotate(-45deg)' : 'none', transition: 'transform .18s ease, color .18s ease', fill: isProjectPinned(p) ? 'currentColor' : 'none' }} />
              </button>
              <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span title={`已完成 ${p.plan_done ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--success-soft, rgba(22,163,74,.12))', color: 'var(--success)' }}>{p.plan_done ?? 0}</span>
              <span title={`进行中 ${p.plan_doing ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{p.plan_doing ?? 0}</span>
              <span title={`待开始 ${p.plan_open ?? 0}`} style={{ minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{p.plan_open ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 多选批量操作条（T00564，S3776 抽取） */
function PlanBatchBar({ planSelIds, plans, selectAllPlans, planBatchStatus, planBatchAttach, batchSetStatus, batchEvaluateSelected, batchArchivePlans, batchAttach, batchCreateLinkedTodos, batchApplyColor, evalBusy, busy }: {
  readonly planSelIds: string[]; readonly plans: PlanTask[]; readonly selectAllPlans: () => void;
  readonly planBatchStatus: string; readonly planBatchAttach: string; readonly batchSetStatus: (s: PlanTask['status']) => Promise<void> | void;
  readonly batchEvaluateSelected: () => Promise<void> | void; readonly batchArchivePlans: () => Promise<void> | void;
  readonly batchAttach: (id: string) => Promise<void> | void; readonly batchCreateLinkedTodos: () => Promise<void> | void;
  readonly batchApplyColor: (c: string) => Promise<void> | void;
  readonly evalBusy: boolean; readonly busy: boolean;
}) {
  const milestones = plans.filter((x) => x.kind === 'milestone');
  return (
    <span className="op-host" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px solid var(--accent)', borderRadius: 6, padding: '3px 8px', background: 'var(--card-bg)' }}>
      <span style={{ fontSize: 12, color: 'var(--accent)' }}>已选 {planSelIds.length}</span>
      <button onClick={selectAllPlans} className="task-op" title={planSelIds.length === plans.length ? '取消全选' : '全选本页计划'} style={{ fontSize: 12, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}>{planSelIds.length === plans.length ? '取消全选' : '全选'}</button>
      <select value={planBatchStatus} onChange={(e) => { const v = e.target.value; if (v) { runAsync(batchSetStatus(v as PlanTask['status'])); } }} title="批量设置状态" aria-label="批量设置状态" style={{ padding: 3, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
        <option value="">批量状态…</option>
        <option value="todo">待开始</option>
        <option value="doing">进行中</option>
        <option value="done">已完成</option>
        <option value="blocked">阻塞</option>
      </select>
      <button onClick={() => batchEvaluateSelected()} disabled={evalBusy || busy} title="AI 评估选中条目 — 结果自动录入各条描述" className="task-op"
        style={{ display: 'inline-flex', alignItems: 'center', fontSize: 12, border: 'none', background: 'transparent', cursor: evalBusy ? 'not-allowed' : 'pointer', color: 'var(--accent)', padding: 2 }}>
        {evalBusy ? <Loader2 size={14} className="aispin" /> : <Zap size={14} />}
      </button>
      <button onClick={() => runAsync(batchArchivePlans())} disabled={busy} title="归档选中计划 — 可在「归档」菜单恢复" className="task-op"
        style={{ display: 'inline-flex', alignItems: 'center', fontSize: 12, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)', padding: 2 }}>
        <Archive size={14} />
      </button>
      {milestones.length > 0 && (
        <select value={planBatchAttach} onChange={(e) => { const v = e.target.value; if (v) { runAsync(batchAttach(v)); } }} title="批量挂接到里程碑 — 选中计划统一挂到所选里程碑下"
          aria-label="批量挂接到里程碑" style={{ padding: 3, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">批量挂接…</option>
          {milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
      )}
      <button onClick={() => runAsync(batchCreateLinkedTodos())} disabled={busy} title="新建待办关联 — 为每条选中计划各创建一条新待办并关联" className="task-op"
        style={{ display: 'inline-flex', alignItems: 'center', fontSize: 12, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)', padding: 2 }}>
        <CalendarPlus size={14} />
      </button>
      <span style={{ display: 'inline-flex', alignItems: 'center' }} title="批量字体颜色 — 选色后应用到全部选中计划">
        <FontColorButton current="" onApply={(c) => runAsync(batchApplyColor(c))} label="批量字体颜色" />
      </span>
    </span>
  );
}

/** 工具栏：新建 / 导入 / 导出 / 模板（S3776 抽取） */
function PlanCreateImportButtons({ busy, createPlan, importExcel, exportExcel, exportMarkdown, downloadTemplate }: {
  readonly busy: boolean; readonly createPlan: () => Promise<void>;
  readonly importExcel: (f: File) => Promise<void>; readonly exportExcel: () => Promise<void>;
  readonly exportMarkdown: () => Promise<void>;
  readonly downloadTemplate: () => Promise<void>;
}) {
  return (
    <>
      <button className="tbtn-anim" onClick={() => void createPlan()} disabled={busy} title="新建计划任务 — 弹窗中选择任务类型（普通/里程碑/日常）" aria-label="新建计划任务" style={{ ...btnStyle, padding: '6px 8px' }}><CalendarPlus size={13} /></button>
      <label className="tbtn-anim" style={{ ...btnStyle, cursor: busy ? 'default' : 'pointer', padding: '6px 8px' }} title="导入 Excel — 批量导入计划任务（任一行校验失败则整体不入库）" aria-label="导入 Excel">
        <Upload size={13} />
        <input type="file" accept=".xlsx" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { void importExcel(f); e.target.value = ''; } }} />
      </label>
      <button className="tbtn-anim" onClick={() => void exportExcel()} title="导出 Excel — 导出当前项目全部计划" aria-label="导出 Excel" style={{ ...btnStyle, padding: '6px 8px' }}><Download size={13} /></button>
      {/* T01071-FR5.3：项目全量 Markdown 导出（任务清单 + WBS + 需求矩阵单文档） */}
      <button className="tbtn-anim" onClick={() => void exportMarkdown()} title="导出 Markdown — 任务清单 + 计划 + 需求矩阵单文档" aria-label="导出 Markdown" style={{ ...btnStyle, padding: '6px 8px' }}><FileText size={13} /></button>
      <button className="tbtn-anim" onClick={() => void downloadTemplate()} title="下载模板 — 获取导入用 Excel 模板" aria-label="下载导入模板" style={{ ...btnStyle, padding: '6px 8px' }}><FileSpreadsheet size={13} /></button>
      {/* T00569：AI 导入入口已迁移至 AI 工作台「AI 项目计划导入」卡片（本页经跨页信号自动打开弹窗） */}
    </>
  );
}

/** 工具栏：批量 AI 评估按钮（S3776 抽取） */
function PlanEvalButton({ batchEvaluatePlans, evalBusy, busy, evalLabel, plans }: {
  readonly batchEvaluatePlans: () => Promise<void> | void; readonly evalBusy: boolean; readonly busy: boolean;
  readonly evalLabel: string; readonly plans: PlanTask[];
}) {
  return (
    <button onClick={() => runAsync(batchEvaluatePlans())} disabled={evalBusy || busy} title="AI 评估 — 对全部计划条目评估工期合理性/风险与建议，结果自动录入各条描述（确认后执行）" aria-label="批量 AI 评估" className={evalBusy ? 'task-breathe' : undefined} style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
      {evalBusy ? <Loader2 size={13} className="aispin" /> : <Zap size={13} />}AI 评估{evalLabel && plans.length > 0 ? `（${evalLabel}）` : ''}
    </button>
  );
}

/** 工具栏：多选模式开关（T00564，S3776 抽取） */
function PlanMultiToggle({ planMulti, setPlanMulti, setPlanSelIds }: {
  readonly planMulti: boolean; readonly setPlanMulti: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setPlanSelIds: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  return (
    <button onClick={() => { setPlanMulti((m) => !m); setPlanSelIds([]); }} title={planMulti ? '退出多选模式' : '多选模式 — 勾选计划后批量改状态/挂接/归档/评估'} aria-label={planMulti ? '退出多选模式' : '进入多选模式'}
      className="tbtn-anim"
      style={{ fontSize: 12, padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', border: '1px solid var(--border-strong)', background: planMulti ? 'var(--accent)' : 'transparent', color: planMulti ? 'var(--accent-text)' : 'var(--text)' }}>
      {planMulti ? <Check size={13} /> : <ListChecks size={13} />}
    </button>
  );
}

/** 工具栏：列表/甘特视图切换（S3776 抽取） */
function PlanViewModeToggle({ viewMode, setViewMode }: {
  readonly viewMode: 'list' | 'gantt'; readonly setViewMode: React.Dispatch<React.SetStateAction<'list' | 'gantt'>>;
}) {
  return (
    <fieldset style={{ display: 'inline-flex', margin: 0, padding: 0, minWidth: 0, border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }} aria-label="视图切换">
      <button onClick={() => setViewMode('list')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: viewMode === 'list' ? 'var(--accent)' : 'transparent', color: viewMode === 'list' ? 'var(--accent-text)' : 'var(--text)' }} title="列表视图">列表</button>
      <button onClick={() => setViewMode('gantt')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: viewMode === 'gantt' ? 'var(--accent)' : 'transparent', color: viewMode === 'gantt' ? 'var(--accent-text)' : 'var(--text)' }} title="甘特图视图 — 按串行瀑布时间线可视化">甘特</button>
    </fieldset>
  );
}

/** 工具栏：PRD 管理 / 需求跟踪矩阵入口（S3776 抽取） */
function PlanPanelToggles({ showPrd, setShowPrd, showMatrix, setShowMatrix }: {
  readonly showPrd: boolean; readonly setShowPrd: React.Dispatch<React.SetStateAction<boolean>>;
  readonly showMatrix: boolean; readonly setShowMatrix: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <>
      {/* T00770：PRD 管理入口——位于需求跟踪矩阵按钮前方；开源 SVG 笔迹流动动画图标，无文字标签（title/aria 保留语义） */}
      <button onClick={() => setShowPrd((v) => !v)} className="tbtn-anim prd-ico-anim"
        title="PRD 管理 — 文档导入/新建/编辑/查看/删除、PRD↔确认版状态流转、待确认问题与结论回写"
        aria-label="PRD 管理" aria-expanded={showPrd}
        style={{ ...btnStyle, background: showPrd ? 'var(--accent)' : 'transparent', color: showPrd ? 'var(--accent-text)' : 'var(--text)', borderColor: showPrd ? 'var(--accent)' : 'var(--border-strong)' }}>
        <FilePenLine size={13} />
      </button>
      {/* T00662：需求跟踪矩阵入口——位于甘特图按钮旁；T00705：去中文名称，仅图标简洁显示（悬浮 title 与无障碍标签保留完整语义） */}
      <button onClick={() => setShowMatrix((v) => !v)} className="tbtn-anim"
        title="需求跟踪矩阵 — 展示 PRD 需求与计划/待办的关联及状态，支持增删改与关联调整"
        aria-label="需求跟踪矩阵" aria-expanded={showMatrix}
        style={{ ...btnStyle, background: showMatrix ? 'var(--accent)' : 'transparent', color: showMatrix ? 'var(--accent-text)' : 'var(--text)', borderColor: showMatrix ? 'var(--accent)' : 'var(--border-strong)' }}>
        <Table2 size={13} />
      </button>
    </>
  );
}

/** 列表表头「标题/描述」单元格：全选框 + 过滤输入（T00658/T00590，S3776 抽取） */
function PlanTitleFilterHeader({ planMulti, plans, planSelIds, setPlanSelIds, allPlansRef, titleFilter, setTitleFilter, titleFilterOpen, setTitleFilterOpen }: {
  readonly planMulti: boolean; readonly plans: PlanTask[]; readonly planSelIds: string[];
  readonly setPlanSelIds: React.Dispatch<React.SetStateAction<string[]>>;
  readonly allPlansRef: React.MutableRefObject<HTMLInputElement | null>;
  readonly titleFilter: string; readonly setTitleFilter: React.Dispatch<React.SetStateAction<string>>;
  readonly titleFilterOpen: boolean; readonly setTitleFilterOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const allSelected = plans.length > 0 && plans.every((x) => planSelIds.includes(x.id));
  return (
    <th style={{ padding: 6 }}>
      {/* T00658：多选模式下标题字段旁「全选框」——全选/全不选当前列表（含半选态） */}
      {planMulti && (
        <input ref={allPlansRef} type="checkbox"
          checked={allSelected}
          onChange={(e) => setPlanSelIds(e.target.checked ? plans.map((x) => x.id) : [])}
          title="全选/全不选当前计划列表" aria-label="全选计划任务"
          style={{ cursor: 'pointer', marginRight: 4, verticalAlign: 'middle' }} />
      )}
      {/* T00590：列字段名可交互——点击展开过滤输入框，输入即过滤标题/描述 */}
      {titleFilterOpen ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            autoFocus
            value={titleFilter}
            onChange={(e) => setTitleFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setTitleFilter(''); setTitleFilterOpen(false); } }}
            placeholder="过滤标题/描述…"
            aria-label="按标题或描述过滤计划"
            style={{ width: 130, padding: '2px 6px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}
          />
          <button onClick={() => { setTitleFilter(''); setTitleFilterOpen(false); }}
            title="清除过滤并收起" aria-label="清除标题过滤"
            style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}>×</button>
        </span>
      ) : (
        <button onClick={() => setTitleFilterOpen(true)}
          className="tbtn-anim"
          title="点击输入搜索/过滤标题与描述（Esc 清除，× 收起）"
          aria-label="过滤标题或描述"
          style={{ border: '1px solid transparent', borderRadius: 4, background: 'transparent', color: titleFilter ? 'var(--accent)' : 'var(--text)', fontSize: 13, padding: '1px 4px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          标题 / 描述
          <Search size={11} />
          {titleFilter && <span style={{ fontSize: 10, color: 'var(--accent)' }}>已过滤</span>}
        </button>
      )}
    </th>
  );
}

/** 列表表头「工期」单元格：日/时显示模式切换（S3776 抽取） */
function PlanDurationHeader({ durationUnit, setDurationUnit }: {
  readonly durationUnit: 'day' | 'hour'; readonly setDurationUnit: React.Dispatch<React.SetStateAction<'day' | 'hour'>>;
}) {
  const hour = durationUnit === 'hour';
  return (
    <th style={{ padding: 6 }}>
      <button onClick={() => setDurationUnit((u) => (u === 'day' ? 'hour' : 'day'))}
        title="点击切换工期显示模式：工期/日（工作日）与 工期/时（按 8 小时/天换算持久化）"
        className="task-op"
        style={{ border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 11, padding: '1px 6px', cursor: 'pointer' }}>
        {hour ? '工期/时' : '工期/日'}
      </button>
    </th>
  );
}

/** 异步动作触发（S3735：以 catch 兜底替代 void 运算符，忽略 Promise 拒绝） */
function runAsync(action: Promise<void> | void): void {
  if (action instanceof Promise) action.catch(() => undefined);
}

/** 进度分桶（原嵌套三元等价改写，避免 S3358） */
function progressBucket(pg: number): 'done' | 'doing' | 'none' {
  if (pg >= 100) return 'done';
  if (pg > 0) return 'doing';
  return 'none';
}

/** 计划行「序号」单元格（原嵌套三元链等价改写，避免 S3358 / 深层嵌套） */
function renderSeqCell(p: PlanTask, plans: PlanTask[], seq: string | undefined, i: number): React.ReactNode {
  if (p.kind === 'milestone') {
    return <span title="阶段里程碑 — 汇总其下普通/日常任务，不可手动调整；点击标题旁箭头收起/展开子任务" style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 13 }}>◆ {seq ?? i + 1}</span>;
  }
  if (childMilestoneOf(p, plans)) {
    return <span style={{ marginLeft: 16 }}>{seq ?? ''}</span>;
  }
  if (p.kind === 'daily') {
    return <span title="日常任务" style={{ color: 'var(--text-muted)' }}>◇ {seq ?? i + 1}</span>;
  }
  return seq ?? i + 1;
}

/** 依赖列单元格（原嵌套 IIFE + deps.map，提取为组件降低函数嵌套深度） */
function PlanDepCell({ p, plans, seqs, openDepEditor }: { readonly p: PlanTask; readonly plans: PlanTask[]; readonly seqs: Map<string, string>; readonly openDepEditor: (p: PlanTask) => void }) {
  let depList: Array<{ id: string; type: string }> = [];
  try { depList = p.deps ? JSON.parse(p.deps) as Array<{ id: string; type: string }> : []; } catch { depList = []; }
  const deps = depList.filter((d) => d.type !== 'child');
  if (deps.length === 0) {
    return (
      <button onClick={() => openDepEditor(p)} title="配置依赖 — 无前置依赖，点击添加前置任务"
        className="task-op" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, display: 'inline-flex', fontSize: 11 }}>
        <Plus size={12} />
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
      {deps.map((d) => {
        const seqStr = seqs.get(d.id);
        const pre = plans.find((x) => x.id === d.id);
        const tail = pre?.end_date ? `（其结束 ${pre.end_date}）` : '';
        return (
          <button key={d.id} onClick={() => openDepEditor(p)}
            title={`${d.type === 'serial' ? '串行' : '并行'}依赖：${pre?.title ?? '已删除'}${tail} — 点击调整`}
            style={{ border: '1px solid var(--border-strong)', background: d.type === 'serial' ? 'var(--accent-soft)' : 'transparent', color: d.type === 'serial' ? 'var(--accent)' : 'var(--text-muted)', borderRadius: 4, fontSize: 10, padding: '0 4px', cursor: 'pointer' }}>
            {seqStr ? `#${seqStr}` : '?'}{d.type === 'serial' ? '串' : '并'}
          </button>
        );
      })}
    </span>
  );
}

/** 开始日期单元格（原 onBlur 内嵌 find 回调，提取为组件降低嵌套） */
function PlanStartCell({ p, plans, flash, updatePlan }: { readonly p: PlanTask; readonly plans: PlanTask[]; readonly flash: (m: string) => void; readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void> }) {
  if (p.kind === 'milestone') return <span style={{ color: 'var(--text-muted)' }}>{p.start_date}</span>;
  return (
    <input key={'s' + p.start_date} type="date" defaultValue={p.start_date} onBlur={(e) => {
      if (!e.target.value || e.target.value === p.start_date) return;
      let depList: Array<{ id: string; type: string }> = [];
      try { depList = p.deps ? JSON.parse(p.deps) as Array<{ id: string; type: string }> : []; } catch { depList = []; }
      const serialDep = depList.find((d) => d.type === 'serial');
      if (serialDep) {
        const pre = plans.find((x) => x.id === serialDep.id);
        if (pre?.end_date && e.target.value < pre.end_date) {
          flash(`串行依赖约束：开始日期不能早于前置任务「${pre.title}」的结束日期（${pre.end_date}）`);
          e.target.value = p.start_date;
          return;
        }
      }
      void updatePlan(p, { start_date: e.target.value });
    }}
      style={{ ...inputStyle, color: p.status === 'todo' && p.start_date && p.start_date < todayStr() ? 'var(--danger, #dc2626)' : inputStyle.color }} aria-label="开始日期（超期未开始标红）" />
  );
}

/** 结束日期单元格（原嵌套 IIFE，提取为组件降低嵌套） */
function PlanEndCell({ p, isMilestone, inner, updatePlan }: { readonly p: PlanTask; readonly isMilestone: boolean; readonly inner: PlanTask[]; readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void> }) {
  if (isMilestone) {
    const latest = inner.map((x) => x.end_date).filter(Boolean).sort((a, b) => a.localeCompare(b)).at(-1) ?? p.end_date;
    return <span title={`关联任务最晚结束：${latest}`} style={{ color: 'var(--text-muted)' }}>{latest}</span>;
  }
  return (
    <input key={'e' + p.end_date} type="date" defaultValue={p.end_date} onBlur={(e) => {
      const v = e.target.value;
      if (!v || v === p.end_date) return;
      const days = Math.max(1, Math.round((new Date(v).getTime() - new Date(p.start_date).getTime()) / 86400000));
      void updatePlan(p, { duration_days: days });
    }} style={{ ...inputStyle, width: 108 }} aria-label="结束日期" />
  );
}

/** 依赖配置弹窗中单条的串/并切换按钮组（提取为组件，避免 .map 内层嵌套） */
function DepTypeToggles({ xId, selType, setDepSel }: { readonly xId: string; readonly selType: 'serial' | 'parallel'; readonly setDepSel: React.Dispatch<React.SetStateAction<Record<string, 'serial' | 'parallel'>>> }) {
  return (
    <>
      {(['serial', 'parallel'] as const).map((tp) => (
        <button key={tp} onClick={() => setDepSel((prev) => ({ ...prev, [xId]: tp }))}
          title={tp === 'serial' ? '串行：前置完成后自动接续' : '并行：仅标记关系'}
          style={{ padding: '1px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', border: '1px solid var(--border-strong)', background: selType === tp ? 'var(--accent)' : 'transparent', color: selType === tp ? 'var(--accent-text)' : 'var(--text)' }}>
          {tp === 'serial' ? '串行' : '并行'}
        </button>
      ))}
    </>
  );
}

/** 甘特行「更多操作」固定菜单（T00529/T00550）：依赖维护/插入/关联待办/颜色/归档 */
function PlanRowMenu({ p, setDepMenuId, depMenuPos, openDepEditor, insertAfter, linkTodo, createLinkedTodo, archivePlan, updatePlan }: {
  readonly p: PlanTask; readonly setDepMenuId: (id: string) => void; readonly depMenuPos: { top: number; right: number } | null;
  readonly openDepEditor: (p: PlanTask) => void; readonly insertAfter: (p: PlanTask) => Promise<void> | void;
  readonly linkTodo: (p: PlanTask) => Promise<void> | void; readonly createLinkedTodo: (p: PlanTask) => Promise<void> | void;
  readonly archivePlan: (p: PlanTask) => Promise<void> | void; readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>;
}) {
  return (
    <div role="menu" style={{ position: 'fixed', top: depMenuPos!.top, right: depMenuPos!.right, zIndex: 70, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 6px 16px rgba(0,0,0,.16)', padding: 4, display: 'flex', flexDirection: 'row', gap: 2, alignItems: 'center' }}>
      <button role="menuitem" onClick={() => { setDepMenuId(''); openDepEditor(p); }}
        title="维护依赖/挂接 — 选择前置任务并标记串行/并行（GitBranch 图标与关联待办 Link 图标区分）"
        className="task-op"
        style={{ display: 'inline-flex', alignItems: 'center', padding: 4, fontSize: 12, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--text)' }}>
        <GitBranch size={14} />
      </button>
      <button role="menuitem" onClick={() => { setDepMenuId(''); runAsync(insertAfter(p)); }}
        title="在此行后插入新任务 — 插入行从今天起 1 天，不影响其他任务日期"
        className="task-op"
        style={{ display: 'inline-flex', alignItems: 'center', padding: 4, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)' }}>
        <Plus size={14} />
      </button>
      {!p.linked_task_id && <button role="menuitem" onClick={() => { setDepMenuId(''); runAsync(linkTodo(p)); }}
        title="关联既有待办 — 选择本项目的待办与该计划互相关联"
        className="task-op"
        style={{ display: 'inline-flex', alignItems: 'center', padding: 4, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--text)' }}>
        <Link2 size={14} />
      </button>}
      {!p.linked_task_id && <button role="menuitem" onClick={() => { setDepMenuId(''); runAsync(createLinkedTodo(p)); }}
        title="新建待办关联 — 由本计划创建新待办并关联"
        className="task-op"
        style={{ display: 'inline-flex', alignItems: 'center', padding: 4, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--text)' }}>
        <CalendarPlus size={14} />
      </button>}
      <span className="task-op" style={{ display: 'inline-flex', alignItems: 'center' }}>
        <FontColorButton current={p.color ?? ''} onApply={(c) => { void updatePlan(p, { color: c }); }} />
      </span>
      <button role="menuitem" onClick={() => { setDepMenuId(''); runAsync(archivePlan(p)); }}
        title="归档计划任务 — 从时间线移除，可在「归档」菜单恢复"
        className="task-op"
        style={{ display: 'inline-flex', alignItems: 'center', padding: 4, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--danger)' }}>
        <Archive size={14} />
      </button>
    </div>
  );
}

/** 甘特行操作列：解除关联 + ⋯ 菜单 + 单条 AI 评估 */
function PlanActionsCell({ p, depMenuId, depMenuRef, depMenuPos, evalBusy, busy, setDepMenuId, setDepMenuPos, evaluateRow, openDepEditor, insertAfter, linkTodo, createLinkedTodo, archivePlan, updatePlan }: {
  readonly p: PlanTask; readonly depMenuId: string; readonly depMenuRef: React.MutableRefObject<HTMLSpanElement | null>;
  readonly depMenuPos: { top: number; right: number } | null; readonly evalBusy: boolean; readonly busy: boolean;
  readonly setDepMenuId: (id: string) => void; readonly setDepMenuPos: React.Dispatch<React.SetStateAction<{ top: number; right: number } | null>>;
  readonly evaluateRow: (p: PlanTask) => void; readonly openDepEditor: (p: PlanTask) => void;
  readonly insertAfter: (p: PlanTask) => Promise<void> | void; readonly linkTodo: (p: PlanTask) => Promise<void> | void;
  readonly createLinkedTodo: (p: PlanTask) => Promise<void> | void; readonly archivePlan: (p: PlanTask) => Promise<void> | void;
  readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>;
}) {
  const openRowMenu = (e: React.MouseEvent<HTMLElement>) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDepMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right }); // T00549：右缘与 ⋯ 对齐靠左展开
    setDepMenuId(depMenuId === p.id ? '' : p.id);
  };
  return (
    <>
      <button onClick={(e) => openRowMenu(e)}
        title="更多操作 — 依赖维护等" aria-label="更多操作" aria-haspopup="menu" aria-expanded={depMenuId === p.id}
        className="task-op"
        style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-muted)', padding: 2, display: 'inline-flex' }}>
        <MoreHorizontal size={13} />
      </button>
      {/* T00550：单条 AI 评估——挪出 ⋯ 菜单，置于 ⋯ 前常显 */}
      <button onClick={() => evaluateRow(p)} disabled={evalBusy || busy} title="AI 评估 — 评估该条工期合理性/风险与建议，结果自动录入描述" aria-label="AI 评估该条" className={"task-op" + (evalBusy ? " task-breathe" : "")} style={{ cursor: evalBusy ? "not-allowed" : "pointer", border: "none", background: "transparent", color: "var(--accent)", padding: 2, display: "inline-flex" }}>
        {evalBusy ? <Loader2 size={13} className="aispin" /> : <Zap size={13} />}
      </button>
      {depMenuId === p.id && depMenuPos && (
        /* T00529 二轮：交互图标工具栏——一行并列、无中文、悬浮提示保留 */
        <PlanRowMenu p={p} setDepMenuId={setDepMenuId} depMenuPos={depMenuPos} openDepEditor={openDepEditor}
          insertAfter={insertAfter} linkTodo={linkTodo} createLinkedTodo={createLinkedTodo} archivePlan={archivePlan} updatePlan={updatePlan} />
      )}
    </>
  );
}

/** 甘特行标题列：里程碑收起按钮 + 标题/描述行内编辑 */
function PlanTitleCell({ p, collapsedMs, toggleMsCollapsed, updatePlan }: {
  readonly p: PlanTask; readonly collapsedMs: Record<string, boolean>;
  readonly toggleMsCollapsed: (id: string) => void; readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>;
}) {
  return (
    <>
      {p.kind === 'milestone' && (
        <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', marginRight: 4 }}>
          <button onClick={() => toggleMsCollapsed(p.id)}
            title={collapsedMs[p.id] ? '展开子任务' : '收起子任务'} aria-label={collapsedMs[p.id] ? '展开子任务' : '收起子任务'}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--accent)', padding: 0, display: 'inline-flex' }}>
            {collapsedMs[p.id] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        </span>
      )}
      {/* T01058-FR2.1：高复杂度标红徽标——提示该行不确定性高/跨模块耦合，建议再拆分 */}
      {(p.complexity ?? 0) >= 4 && (
        <span title={`AI 评估复杂度 ${p.complexity}/5 — 不确定性高或跨模块耦合，建议拆分为更小的任务`} aria-label={`复杂度 ${p.complexity}，建议拆分`}
          style={{ flexShrink: 0, fontSize: 10, padding: '0 5px', borderRadius: 4, color: 'var(--danger)', border: '1px solid var(--danger)', whiteSpace: 'nowrap' }}>
          复杂度 {p.complexity}
        </span>
      )}
      <input key={'t' + p.title} defaultValue={p.title} readOnly={p.kind === 'milestone'} title={p.kind === 'milestone' ? '里程碑标题 — 由系统汇总其下任务，不可手动编辑' : `全量标题：${p.title}`} onBlur={(e) => { if (p.kind !== 'milestone' && e.target.value.trim() && e.target.value !== p.title) void updatePlan(p, { title: e.target.value.trim() }); }}
        style={{ ...inputStyle, width: '100%', color: p.color || 'var(--text)', fontWeight: p.kind === 'milestone' ? 700 : undefined, fontSize: p.kind === 'milestone' ? 14 : 12, cursor: p.kind === 'milestone' ? 'default' : undefined }} aria-label="计划标题" />
      <input key={'d' + (p.description ?? '')} defaultValue={p.description} readOnly={p.kind === 'milestone'} title={p.kind === 'milestone' ? '里程碑描述 — 不可手动编辑' : `全量描述：${p.description || '（无描述）'}`} placeholder="描述（可空）" className="plan-desc-ph" onBlur={(e) => { if (p.kind !== 'milestone' && e.target.value !== p.description) void updatePlan(p, { description: e.target.value }); }}
        style={{ ...inputStyle, width: '100%', marginTop: 2, color: 'var(--text-muted)', cursor: p.kind === 'milestone' ? 'default' : undefined }} aria-label="计划描述" />
    </>
  );
}

/** 工期输入换算（T00544）：小时模式按 8 时/日换算持久化；日常任务必须 ≥1 工作日 */
function applyDurationInput(p: PlanTask, raw: string, input: HTMLInputElement, hour: boolean, updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>, flash: (m: string) => void): void {
  const v = Number(raw);
  if (hour) {
    // T00544：工期/时模式——按 8 小时/天换算为工作日持久化
    const days = Math.max(1, Math.round(v / 8));
    if (days === p.duration_days) input.value = String(p.duration_days * 8);
    else void updatePlan(p, { duration_days: days });
    return;
  }
  if (v >= 1 && v !== p.duration_days) {
    void updatePlan(p, { duration_days: v });
  } else if (p.kind === 'daily' && v < 1) {
    flash('日常任务必须填写工时估算（≥1 工作日）');
  }
}

/** 甘特行工期列 */
function PlanDurationCell({ p, isMilestone, innerCount, innerDays, durationUnit, updatePlan, flash }: {
  readonly p: PlanTask; readonly isMilestone: boolean; readonly innerCount: number; readonly innerDays: number;
  readonly durationUnit: 'day' | 'hour'; readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>;
  readonly flash: (m: string) => void;
}) {
  const hour = durationUnit === 'hour';
  if (isMilestone) {
    return <span title={`汇总：${innerCount} 项普通/日常任务，合计 ${innerDays} 工作日`} style={{ color: 'var(--accent)', fontWeight: 600 }}>Σ {innerCount} 项 · {hour ? `${innerDays * 8} 时` : `${innerDays} 天`}</span>;
  }
  return (
    <input type="number" min={hour ? 8 : 1} key={durationUnit + p.duration_days} defaultValue={hour ? p.duration_days * 8 : p.duration_days}
      onBlur={(e) => applyDurationInput(p, e.target.value, e.target as HTMLInputElement, hour, updatePlan, flash)}
      title={hour ? '按小时填写（8 小时 = 1 工作日，自动换算持久化）' : '按工作日填写'}
      style={{ ...inputStyle, width: hour ? 56 : 40 }} aria-label={hour ? '工期（小时）' : '工期（工作日）'} />
  );
}

/** 甘特行进度列 */
function PlanProgressCell({ p, isMilestone, innerCount, innerAvg, updatePlan }: {
  readonly p: PlanTask; readonly isMilestone: boolean; readonly innerCount: number; readonly innerAvg: number;
  readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>;
}) {
  if (isMilestone) {
    return <span title={`汇总：${innerCount} 项平均进度 ${innerAvg}%`} style={{ color: 'var(--accent)', fontWeight: 600 }}>{innerAvg}%</span>;
  }
  return (
    <input key={'p' + p.progress} type="number" min={0} max={100} defaultValue={p.progress} onBlur={(e) => { const v = Number(e.target.value); if (v >= 0 && v <= 100 && v !== p.progress) void updatePlan(p, { progress: v }); }}
      style={{ ...inputStyle, width: 40 }} aria-label="进度百分比" />
  );
}

/** 甘特行状态列：点击徽标流转到下一状态（待办→进行中→已完成→待办） */
function PlanStatusCell({ p, isMilestone, updatePlan }: {
  readonly p: PlanTask; readonly isMilestone: boolean; readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>;
}) {
  if (isMilestone) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <button onClick={() => void updatePlan(p, { status: NEXT_STATUS[p.status] })}
      title="点击流转到下一状态" aria-label={`状态：${STATUS_META[p.status].label}，点击流转`}
      style={{ ...btnStyle, color: STATUS_META[p.status].color, borderColor: STATUS_META[p.status].color, whiteSpace: 'nowrap' }}>
      {STATUS_META[p.status].label}
    </button>
  );
}

/** 甘特行负责人列 */
function PlanAssigneeCell({ p, isMilestone, updatePlan }: {
  readonly p: PlanTask; readonly isMilestone: boolean; readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>;
}) {
  if (isMilestone) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <input key={'a' + (p.assignee ?? '')} defaultValue={p.assignee} placeholder="—" onBlur={(e) => { if (e.target.value !== p.assignee) void updatePlan(p, { assignee: e.target.value }); }}
      style={{ ...inputStyle, width: 80 }} aria-label="负责人" />
  );
}

/** 甘特行（T00590 过滤后单行渲染）：拖拽 + 各列单元格组件化（S2004/S3776 拆分） */
function PlanGanttRow({ p, i, plans, seqs, isMilestone, inner, innerCount, innerDays, innerAvg, dragId, overId, newRowId, planMulti, planSelIds, collapsedMs, durationUnit, depMenuId, depMenuRef, depMenuPos, evalBusy, busy, setDragId, setOverId, togglePlanSel, toggleMsCollapsed, updatePlan, flash, openDepEditor, makeRowDrop, setDepMenuId, setDepMenuPos, evaluateRow, insertAfter, linkTodo, createLinkedTodo, archivePlan, unlinkTodo }: {
  readonly p: PlanTask; readonly i: number; readonly plans: PlanTask[]; readonly seqs: Map<string, string>;
  readonly isMilestone: boolean; readonly inner: PlanTask[]; readonly innerCount: number; readonly innerDays: number; readonly innerAvg: number;
  readonly dragId: string; readonly overId: string; readonly newRowId: string; readonly planMulti: boolean; readonly planSelIds: string[];
  readonly collapsedMs: Record<string, boolean>; readonly durationUnit: 'day' | 'hour'; readonly depMenuId: string;
  readonly depMenuRef: React.MutableRefObject<HTMLSpanElement | null>; readonly depMenuPos: { top: number; right: number } | null;
  readonly evalBusy: boolean; readonly busy: boolean;
  readonly setDragId: (id: string) => void; readonly setOverId: (id: string) => void; readonly togglePlanSel: (id: string) => void;
  readonly toggleMsCollapsed: (id: string) => void; readonly updatePlan: (p: PlanTask, patch: PlanPatch) => Promise<void>;
  readonly flash: (m: string) => void;
  readonly openDepEditor: (p: PlanTask) => void; readonly makeRowDrop: (p: PlanTask) => (e: React.DragEvent<HTMLTableRowElement>) => void;
  readonly setDepMenuId: (id: string) => void; readonly setDepMenuPos: React.Dispatch<React.SetStateAction<{ top: number; right: number } | null>>;
  readonly evaluateRow: (p: PlanTask) => void; readonly insertAfter: (p: PlanTask) => Promise<void> | void;
  readonly linkTodo: (p: PlanTask) => Promise<void> | void; readonly createLinkedTodo: (p: PlanTask) => Promise<void> | void;
  readonly archivePlan: (p: PlanTask) => Promise<void> | void; readonly unlinkTodo: (p: PlanTask) => Promise<void> | void;
}) {
  return (
    <tr
      draggable
      onDragStart={() => setDragId(p.id)}
      onDragEnd={() => { setDragId(''); setOverId(''); }}
      onDragOver={(e) => { e.preventDefault(); if (p.id !== dragId) setOverId(p.id); }}
      onDrop={makeRowDrop(p)}
      className={planRowClass(dragId, overId, newRowId, p.id)}
      style={{ borderBottom: '1px solid var(--border)', transition: 'box-shadow .15s ease, transform .15s ease, background .15s ease' }}>
      <td style={{ padding: 6, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {planMulti && (
          <input type="checkbox" checked={planSelIds.includes(p.id)} aria-label={`选中计划 ${p.title}`}
            onChange={() => togglePlanSel(p.id)}
            style={{ cursor: 'pointer', marginRight: 4, verticalAlign: 'middle' }} />
        )}
        {renderSeqCell(p, plans, seqs.get(p.id), i)}
      </td>
      <td style={{ padding: 6, minWidth: 220, paddingLeft: childMilestoneOf(p, plans) ? 24 : 6 }}>
        <PlanTitleCell p={p} collapsedMs={collapsedMs} toggleMsCollapsed={toggleMsCollapsed} updatePlan={updatePlan} />
      </td>
      {/* T00545：依赖列——前置任务序号 + 串/并徽标，点击维护；空依赖显示快捷添加 */}
      <td style={{ padding: 6, fontSize: 11 }}>
        <PlanDepCell p={p} plans={plans} seqs={seqs} openDepEditor={openDepEditor} />
      </td>
      <td style={{ padding: 6 }}>
        <PlanStartCell p={p} plans={plans} flash={flash} updatePlan={updatePlan} />
      </td>
      <td style={{ padding: 6 }}>
        <PlanEndCell p={p} isMilestone={isMilestone} inner={inner} updatePlan={updatePlan} />
      </td>
      <td style={{ padding: 6 }}>
        <PlanDurationCell p={p} isMilestone={isMilestone} innerCount={innerCount} innerDays={innerDays} durationUnit={durationUnit} updatePlan={updatePlan} flash={flash} />
      </td>
      <td style={{ padding: 6 }}>
        <PlanProgressCell p={p} isMilestone={isMilestone} innerCount={innerCount} innerAvg={innerAvg} updatePlan={updatePlan} />
      </td>
      {/* T00768：状态列默认宽度 + 不换行——笔记本屏幕下状态徽标保持一行显示 */}
      <td style={{ padding: 6, minWidth: 70, whiteSpace: 'nowrap' }}>
        <PlanStatusCell p={p} isMilestone={isMilestone} updatePlan={updatePlan} />
      </td>
      <td style={{ padding: 6 }}>
        <PlanAssigneeCell p={p} isMilestone={isMilestone} updatePlan={updatePlan} />
      </td>
      <td style={{ padding: 6, minWidth: 150 }}>
        {p.linked_task_id && !p.linked_task_missing && <span style={{ color: 'var(--success)' }}>✓ {p.linked_task_title}</span>}
        {p.linked_task_missing && <span style={{ color: 'var(--danger)' }}>待办已删除</span>}
        {!p.linked_task_id && <span style={{ color: 'var(--text-muted)' }}>未关联</span>}
      </td>
      <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
        {p.linked_task_id && <button onClick={() => runAsync(unlinkTodo(p))} title="解除关联" className="task-op" style={{ cursor: 'pointer', border: 'none', background: 'transparent', padding: 2 }}><Link2Off size={13} /></button>}
        <PlanActionsCell p={p} depMenuId={depMenuId} depMenuRef={depMenuRef} depMenuPos={depMenuPos} evalBusy={evalBusy} busy={busy}
          setDepMenuId={setDepMenuId} setDepMenuPos={setDepMenuPos} evaluateRow={evaluateRow} openDepEditor={openDepEditor}
          insertAfter={insertAfter} linkTodo={linkTodo} createLinkedTodo={createLinkedTodo} archivePlan={archivePlan} updatePlan={updatePlan} />
      </td>
    </tr>
  );
}

/** 节假日万年历视图（T00764）：月份网格 + 加班日/节假日着色 */
function HolidayCalendar({ calYear, setCalYear, holiBusy, renderMonthGrid }: {
  readonly calYear: number; readonly setCalYear: React.Dispatch<React.SetStateAction<number>>;
  readonly holiBusy: boolean;
  readonly renderMonthGrid: (year: number, month: number) => React.ReactNode;
}) {
  return (
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
  );
}

/** 节假日多功能弹窗：手动维护 / 联网导入法定节假日 / 万年历 */
function HolidayModal({ holiBusy, setHoliOpen, holiTab, setHoliTab, holiNewKind, setHoliNewKind, holiNewDate, setHoliNewDate, holiNewName, setHoliNewName, holidays, addHolidayInModal, removeHoliday, natYear, setNatYear, importNational, natMsg, calYear, setCalYear, renderMonthGrid }: {
  readonly holiBusy: boolean; readonly setHoliOpen: (v: boolean) => void;
  readonly holiTab: HolidayTab; readonly setHoliTab: React.Dispatch<React.SetStateAction<HolidayTab>>;
  readonly holiNewKind: 'holiday' | 'overtime'; readonly setHoliNewKind: React.Dispatch<React.SetStateAction<'holiday' | 'overtime'>>;
  readonly holiNewDate: string; readonly setHoliNewDate: React.Dispatch<React.SetStateAction<string>>;
  readonly holiNewName: string; readonly setHoliNewName: React.Dispatch<React.SetStateAction<string>>;
  readonly holidays: Array<{ date: string; name: string; kind: string }>;
  readonly addHolidayInModal: () => Promise<void> | void; readonly removeHoliday: (date: string) => Promise<void> | void;
  readonly natYear: number; readonly setNatYear: React.Dispatch<React.SetStateAction<number>>;
  readonly importNational: () => Promise<void> | void; readonly natMsg: string;
  readonly calYear: number; readonly setCalYear: React.Dispatch<React.SetStateAction<number>>;
  readonly renderMonthGrid: (year: number, month: number) => React.ReactNode;
}) {
  return (
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
              {/* T00764：类型下拉（节假日/加班日）——加班日按工作日参与排期 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <select value={holiNewKind} onChange={(e) => setHoliNewKind(e.target.value as 'holiday' | 'overtime')}
                  aria-label="维护类型" title="节假日=放假日；加班日=周末/节假日调来上班，排期按工作日处理"
                  style={{ ...inputStyle, width: 96 }}>
                  <option value="holiday">节假日</option>
                  <option value="overtime">加班日</option>
                </select>
                <input type="date" value={holiNewDate} onChange={(e) => setHoliNewDate(e.target.value)} style={inputStyle} aria-label="日期" />
                <input value={holiNewName} placeholder={holiNewKind === 'overtime' ? '备注（如：项目冲刺加班）' : '名称（如：国庆节）'} onChange={(e) => setHoliNewName(e.target.value)} style={{ ...inputStyle, width: 140 }} aria-label="名称" />
                <button onClick={() => runAsync(addHolidayInModal())} disabled={holiBusy} style={btnStyle}>添加</button>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>共 {holidays.length} 条（加班日 {holidays.filter((h) => h.kind === 'overtime').length}）</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '44vh', overflowY: 'auto' }}>
                {holidays.length === 0 && <div style={{ color: 'var(--text-muted)' }}>暂无节假日/加班日。可手动添加，或在「联网导入」页签拉取国家法定节假日。</div>}
                {holidays.map((h) => (
                  <div key={h.date} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px' }}>
                    <span style={{ fontWeight: 600, minWidth: 90 }}>{h.date}</span>
                    <span style={{ fontSize: 10, border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', color: h.kind === 'overtime' ? 'var(--success, #16a34a)' : 'var(--danger)', flexShrink: 0 }}>
                      {h.kind === 'overtime' ? '加班日' : '节假日'}
                    </span>
                    <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{h.name || '—'}</span>
                    <button onClick={() => runAsync(removeHoliday(h.date))} disabled={holiBusy} title={h.kind === 'overtime' ? '移除该加班日' : '移除该节假日'}
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
                <button onClick={() => runAsync(importNational())} disabled={holiBusy} style={btnStyle}>导入 {natYear} 年法定节假日</button>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>
                从国家法定节假日公开数据源拉取全年放假安排（元旦/春节/清明/劳动/端午/中秋/国庆等）。导入为 upsert 幂等——重复导入自动合并；仅导入法定放假日，调休补班日暂不处理。导入后所有项目计划时间线自动重排。
              </div>
              {natMsg && <div style={{ color: natMsg.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>{natMsg}</div>}
            </>
          )}
          {holiTab === 'calendar' && (
            <HolidayCalendar calYear={calYear} setCalYear={setCalYear} holiBusy={holiBusy} renderMonthGrid={renderMonthGrid} />
          )}
        </div>
      </div>
    </div>
  );
}

/** 前置依赖配置弹窗：任务列表多选 + 串行/并行标记 */
function DepEditorModal({ depEditor, setDepEditor, plans, depSel, setDepSel, saveDeps }: {
  readonly depEditor: { id: string; seq: number }; readonly setDepEditor: (v: { id: string; seq: number } | null) => void;
  readonly plans: PlanTask[]; readonly depSel: Record<string, 'serial' | 'parallel'>;
  readonly setDepSel: React.Dispatch<React.SetStateAction<Record<string, 'serial' | 'parallel'>>>;
  readonly saveDeps: () => void;
}) {
  return (
    <dialog open style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
                    <DepTypeToggles xId={x.id} selType={selType} setDepSel={setDepSel} />
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
    </dialog>
  );
}

/** 列过滤（T00590 扩展：开始/结束/负责人=包含匹配；状态=精确；进度=三档）——命中返回 true 表示隐藏该行 */
function colFilterHidden(colFilters: Record<string, string>, p: PlanTask): boolean {
  const cf = colFilters;
  if (cf.start && !(p.start_date ?? '').includes(cf.start)) return true;
  if (cf.end && !(p.end_date ?? '').includes(cf.end)) return true;
  if (cf.assignee && !(p.assignee ?? '').toLowerCase().includes(cf.assignee.toLowerCase())) return true;
  if (cf.status && p.status !== cf.status) return true;
  if (cf.progress && progressBucket(p.progress ?? 0) !== cf.progress) return true;
  return false;
}

/** 行过滤（T00590）：标题/列过滤 + 父里程碑收起时整行隐藏（返回 true 表示隐藏该行） */
function planRowHidden(p: PlanTask, i: number, plans: PlanTask[], titleFilter: string, colFilters: Record<string, string>, collapsedMs: Record<string, boolean>): boolean {
  if (titleFilter && !(`${p.title} ${p.description ?? ''}`.toLowerCase().includes(titleFilter.toLowerCase()))) return true;
  if (colFilterHidden(colFilters, p)) return true;
  const parentMs = childMilestoneOf(p, plans);
  if (parentMs && collapsedMs[parentMs.id]) return true;
  return false;
}

/** 里程碑汇总（T00506）：本里程碑到下一里程碑之间的普通/日常任务统计 */
function milestoneMeta(plans: PlanTask[], i: number): { isMilestone: boolean; inner: PlanTask[]; innerCount: number; innerDays: number; innerAvg: number } {
  const isMilestone = plans[i].kind === 'milestone';
  let mEnd = plans.length;
  for (let j = i + 1; j < plans.length; j++) { if (plans[j].kind === 'milestone') { mEnd = j; break; } }
  const inner = isMilestone ? plans.slice(i + 1, mEnd).filter((x) => x.kind !== 'milestone') : [];
  const innerCount = inner.length;
  const innerDays = inner.reduce((acc, x) => acc + (x.duration_days || 0), 0);
  const innerAvg = innerCount ? Math.round(inner.reduce((acc, x) => acc + (x.progress || 0), 0) / innerCount) : 0;
  return { isMilestone, inner, innerCount, innerDays, innerAvg };
}

export function PlanPage() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  // T00460：切页保状态——项目选择会话级持久化，切回不重置
  const [projectId, setProjectId] = useSessionState('plan.projectId', '');
  const [plans, setPlans] = useState<PlanTask[]>([]);
  const [holidays, setHolidays] = useState<Array<{ date: string; name: string; kind: string }>>([]); // T00764：kind= holiday 放假日 | overtime 加班日
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // T00438 AI 导入：模型列表与选中工具（持久化）、解析弹窗状态、可编辑草稿行
  const [aiToolId, setAiToolId] = usePersistentState('plan.aiToolId', '');
  // T00472：AI 评估状态（批量进度动态计数，单条/批量共用）
  const [evalBusy, setEvalBusy] = useSessionState<boolean>('plan.evalBusy', false); // T00550：切页保持
  const [evalLabel, setEvalLabel] = useSessionState<string>('plan.evalLabel', '');
  // ---- 行级交互回调（S2004/S3776：从 JSX 内联箭头下沉到组件级，降低嵌套与复杂度） ----
  const toggleMsCollapsed = (id: string) => setCollapsedMs((prev) => ({ ...prev, [id]: !prev[id] }));
  const evaluateRow = (row: PlanTask) => {
    if (evalBusy) return;
    if (!aiToolId) { flash('请先在模型菜单配置默认 AI 工具'); return; }
    void evaluateOnePlan(row).then((okk) => { if (okk) flash('AI 评估已写入该行描述'); });
  };

  // T00564：多选模式（参考任务菜单）——批量勾选后执行归档/状态/AI 评估等批量操作
  const [planMulti, setPlanMulti] = useSessionState<boolean>('plan.multi', false); // T00570：切页保持
  const [planSelIds, setPlanSelIds] = useSessionState<string[]>('plan.selIds', []); // T00570：切页保持（数组形态便于序列化）
  // T00658：标题旁全选框（半选态用 indeterminate 属性表达）
  const allPlansRef = useRef<HTMLInputElement | null>(null);
  const [planBatchStatus, setPlanBatchStatus] = useState('');
  const [planBatchAttach, setPlanBatchAttach] = useState(''); // T00550：切页保持
  // T00590：列字段名可交互过滤——标题/描述列点击列名展开输入框，输入即过滤（会话级保持）
  const [titleFilter, setTitleFilter] = useSessionState<string>('plan.titleFilter', '');
  const [titleFilterOpen, setTitleFilterOpen] = useSessionState<boolean>('plan.titleFilterOpen', false);
  // T00590 扩展：开始/结束/状态/进度/负责人列的可交互过滤（会话级保持；openCol 记录当前展开的列）
  const [colFilters, setColFilters] = useSessionState<Record<string, string>>('plan.colFilters', {});
  const [openCol, setOpenCol] = useSessionState<string>('plan.openCol', '');

  /** T00590：通用列头过滤控件——点击列名展开（文本输入或下拉），选中即过滤，× / Esc 清除并收起 */
  function renderColFilter(key: string, label: string, type: 'text' | 'select', options?: Array<{ v: string; l: string }>) {
    const val = colFilters[key] ?? '';
    const open = openCol === key;
    const setVal = (v: string) => setColFilters((prev) => ({ ...prev, [key]: v }));
    const clear = () => { setVal(''); setOpenCol(''); };
    if (open) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {type === 'text' ? (
            <input
              autoFocus
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') clear(); }}
              placeholder={`过滤${label}…`}
              aria-label={`按${label}过滤计划`}
              style={{ width: 92, padding: '2px 6px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}
            />
          ) : (
            <select
              autoFocus
              value={val}
              onChange={(e) => setVal(e.target.value)}
              aria-label={`按${label}过滤计划`}
              style={{ padding: 2, fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}
            >
              <option value="">全部</option>
              {(options ?? []).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          )}
          <button onClick={clear} title="清除过滤并收起" aria-label={`清除${label}过滤`}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}>×</button>
        </span>
      );
    }
    return (
      <button onClick={() => setOpenCol(key)}
        className="tbtn-anim"
        title={`点击输入过滤${label}`}
        aria-label={`过滤${label}`}
        style={{ border: '1px solid transparent', borderRadius: 4, background: 'transparent', color: val ? 'var(--accent)' : 'var(--text)', fontSize: 13, padding: '1px 4px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        {label}
        <Search size={11} />
        {val && <span style={{ fontSize: 10, color: 'var(--accent)' }}>已过滤</span>}
      </button>
    );
  }
  // T00544：工期显示模式——「工期/日」与「工期/时」切换（会话级保持；持久化仍为工作日，8 小时/天换算）
  const [durationUnit, setDurationUnit] = useSessionState<'day' | 'hour'>('plan.durationUnit', 'day');
  // T00529：操作列省略号菜单（依赖维护等）——展开任务 id 与 fixed 坐标
  const [depMenuId, setDepMenuId] = useState('');
  const [depMenuPos, setDepMenuPos] = useState<{ top: number; right: number } | null>(null);
  const depMenuRef = useRef<HTMLSpanElement | null>(null);
  // T00499：前置依赖配置弹窗（depEditor=正在编辑的记录；depSel=选择集 {任务id: 依赖类型}）
  // T00505：项目自绘下拉（三色徽标：绿=已完成、蓝=进行中、灰=待开始）
  const [projOpen, setProjOpen] = useState(false);
  const projDropRef = useRef<HTMLDivElement | null>(null);
  // T00520：项目下拉面板 fixed 定位坐标（脱离父容器 overflow 裁剪，不受窗口大小限制）
  const [projDropPos, setProjDropPos] = useState<{ top: number; left: number } | null>(null);
  const [depEditor, setDepEditor] = useState<{ id: string; seq: number } | null>(null);
  // T00508：里程碑收起状态（记录其下子任务是否折叠）
  const [collapsedMs, setCollapsedMs] = useSessionState<Record<string, boolean>>('plan.collapsedMs', {}); // T00570：里程碑收起态切页保持
  const [depSel, setDepSel] = useState<Record<string, 'serial' | 'parallel'>>({});
  // T00449：视图模式（列表/甘特）会话级保持
  const [viewMode, setViewMode] = useSessionState<'list' | 'gantt'>('plan.viewMode', 'list');
  // T00665：使用向导——首次进入模块自动弹出（依据 localStorage 标记），常驻按钮可随时重看
  const [guideOpen, setGuideOpen] = useState(false);
  useEffect(() => { if (!hasSeenProjectGuide()) setGuideOpen(true); }, []);

  // T00663：项目排序与置顶（复用共享模块）——排序方式会话级持久；拖拽排序仅在默认序下启用
  const [projSortMode, setProjSortMode] = useSessionState<ProjectSortMode>('plan.projectSort', 'default');
  const [projSortOpen, setProjSortOpen] = useState(false);
  const sortDropRef = useRef<HTMLSpanElement | null>(null);
  const [dragProjId, setDragProjId] = useState('');
  const [overProjId, setOverProjId] = useState('');

  // T00662：需求跟踪矩阵面板展开态（甘特按钮旁入口）
  const [showMatrix, setShowMatrix] = useSessionState<boolean>('plan.showMatrix', false);

  // T00770：PRD 管理视图展开态（矩阵入口前方按钮；面板在矩阵面板上方展开）
  const [showPrd, setShowPrd] = useSessionState<boolean>('plan.showPrd', false);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 3000); };

  /** T00657：项目列表（下拉徽标含待办/未验证与计划计数）——抽为可重复调用的加载函数 */
  const loadProjects = useCallback(async () => {
    const ps = await api.get<ProjectRow[]>('/projects');
    setProjects(ps);
    if (ps.length > 0) setProjectId((cur) => cur || ps[0].id);
  }, []);
  useEffect(() => { void loadProjects(); }, [loadProjects]);
  // T00657：任务与计划变更会改变项目下拉计数 → 订阅变更实时刷新（服务端同步失效项目列表缓存）
  useEffect(() => api.openChangeStream((kind) => {
    if (kind === 'tasks' || kind === 'plans') void loadProjects();
  }), [loadProjects]);

  /** T00663：按所选排序方式排列项目（默认序=后端顺序，置顶权重优先生效） */
  const sortedProjects = useMemo(() => sortProjects(projects, projSortMode), [projects, projSortMode]);

  /** T00663：置顶/取消置顶（复用共享模块；默认序下置顶项目排最前） */
  async function togglePin(p: ProjectRow) {
    try {
      const pinned = await toggleProjectPin(p);
      flash(pinned ? `已置顶「${p.name}」（默认排序下排最前）` : `已取消置顶「${p.name}」`);
      await loadProjects();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** T00663：拖拽排序落库（仅默认序启用；置顶项由服务端跳过保持置顶） */
  async function dropReorder(targetId: string) {
    if (!dragProjId || dragProjId === targetId) { setDragProjId(''); setOverProjId(''); return; }
    const ids = sortedProjects.map((x) => x.id);
    const from = ids.indexOf(dragProjId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) { setDragProjId(''); setOverProjId(''); return; }
    ids.splice(to, 0, ...ids.splice(from, 1));
    setDragProjId(''); setOverProjId('');
    try {
      await reorderProjects(ids);
      flash('项目顺序已保存');
      await loadProjects();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }
  // T00658：全选框半选态（部分勾选）
  useEffect(() => {
    if (!allPlansRef.current) return;
    const sel = plans.filter((x) => planSelIds.includes(x.id)).length;
    allPlansRef.current.indeterminate = sel > 0 && sel < plans.length;
  }, [planSelIds, plans]);
  // T00438：AI 模型列表（默认整理工具排最前，与任务页模型选择一致）
  // T00534：统一以模型菜单配置为准——AI 导入/评估固定使用默认整理工具，不再由本页选择
  useEffect(() => { void api.get<AITool[]>('/aitools').then((list) => { const sorted = [...list].sort(compareOrganize); setAiToolId(sorted[0]?.id ?? ''); }); }, []);
  useEffect(() => {
    if (!depMenuId) return;
    const onDoc = (e: MouseEvent) => {
      if (depMenuRef.current && !depMenuRef.current.contains(e.target as Node)) setDepMenuId('');
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [depMenuId]);

  const reload = useCallback(() => {
    if (!projectId) return;
    void api.get<PlanTask[]>(`/plans?projectId=${projectId}`).then(setPlans).catch((e) => flash(String(e.message ?? e)));
  }, [projectId]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { void api.get<Array<{ date: string; name: string; kind: string }>>('/plans/holidays').then(setHolidays).catch(() => undefined); }, []);

  // ---------- 计划任务操作 ----------

  async function createPlan() {
    if (!projectId) return flash('请先选择项目');
    // T00506 调整：类型选择移入新建弹窗（默认普通任务）；日常任务为周期性任务，弹窗内强制填写工时估算
    const r = await askInputEx({
      title: '新建计划任务',
      placeholder: '任务标题',
      select: {
        label: '任务类型',
        defaultValue: 'normal',
        options: [
          { value: 'normal', label: '普通任务' },
          { value: 'milestone', label: '阶段里程碑' },
          { value: 'daily', label: '日常任务' },
        ],
      },
      numberField: {
        // T00750：工期字段**默认可见**（原先 showIf 只在「日常任务」时显示，用户反馈默认被隐藏）；
        // 文案与必填随类型变化：日常任务=「工时估算」（必填），普通/里程碑=「工期」（选填，空则默认 1 天）
        label: (sv) => (sv === 'daily' ? '工时估算（工作日）' : '工期（工作日）'),
        placeholder: '如 3（留空按 1 天）',
        min: 1,
        required: (sv) => sv === 'daily',
      },
    });
    if (!r) return;
    setBusy(true);
    try {
      await api.post('/plans', { projectId, title: r.text, startDate: todayStr(), durationDays: r.numberValue ?? 1, kind: r.selectValue });
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
      serialEnds.sort((a, b) => a.localeCompare(b));
      const maxEnd = serialEnds.at(-1)!;
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

  /** 批量评估：确认后逐条串行评估并自动录入描述，进度动态计数（k/N） */
  function batchEvaluatePlans(targetIds?: string[]) {
    if (evalBusy) return;
    if (!aiToolId) { flash('请先选择 AI 模型（AI 导入旁的模型下拉）'); return; }
    const target = targetIds ? plans.filter((p) => targetIds.includes(p.id)) : plans;
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

  // ---------- T00564：多选批量操作 ----------
  function togglePlanSel(id: string) {
    setPlanSelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function selectAllPlans() {
    setPlanSelIds((prev) => (prev.length === plans.length ? [] : plans.map((p) => p.id)));
  }
  async function batchArchivePlans() {
    const ids = [...planSelIds];
    if (ids.length === 0) return;
    if (!(await askConfirm(`归档选中的 ${ids.length} 条计划？（可在「归档」菜单恢复）`))) return;
    setBusy(true);
    try {
      for (const id of ids) await api.post(`/plans/${id}/archive`);
      setPlanSelIds([]);
      reload();
      flash(`已归档 ${ids.length} 条计划`);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }
  async function batchSetStatus(st: PlanTask['status']) {
    const ids = [...planSelIds];
    if (ids.length === 0 || !st) return;
    setBusy(true);
    try {
      for (const id of ids) await api.patch(`/plans/${id}`, { status: st });
      setPlanSelIds([]);
      setPlanBatchStatus('');
      reload();
      flash(`已把 ${ids.length} 条计划状态设为 ${st}`);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }
  function batchEvaluateSelected() {
    if (planSelIds.length === 0) return;
    batchEvaluatePlans(planSelIds);
    setPlanSelIds([]);
  }
  // T00564 扩展：批量挂接到里程碑（deps child 统一替换，已挂其他里程碑的会被覆盖）
  async function batchAttach(msId: string) {
    const ids = [...planSelIds].filter((id) => id !== msId);
    if (!msId || ids.length === 0) { setPlanBatchAttach(''); return; }
    const ms = plans.find((x) => x.id === msId);
    setBusy(true);
    try {
      for (const id of ids) {
        const row = plans.find((x) => x.id === id);
        let deps: Array<{ id: string; type: string }> = [];
        try { deps = JSON.parse(row?.deps || '[]') as Array<{ id: string; type: string }>; } catch { deps = []; }
        const kept = deps.filter((d) => d.type !== 'child');
        kept.push({ id: msId, type: 'child' });
        await api.patch(`/plans/${id}`, { deps: JSON.stringify(kept) });
      }
      setPlanSelIds([]);
      setPlanBatchAttach('');
      reload();
      flash(`已把 ${ids.length} 条计划挂到里程碑「${ms?.title ?? '?'}」下`);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }
  // T00564 扩展：批量新建待办关联（逐条创建待办，整体确认一次）
  async function batchCreateLinkedTodos() {
    const ids = [...planSelIds];
    if (ids.length === 0) return;
    const titles = plans.filter((p) => ids.includes(p.id) && !p.linked_task_id).map((p) => p.title);
    if (titles.length === 0) { flash('选中计划均已关联待办'); return; }
    if (!(await askConfirm(`为选中的 ${titles.length} 条计划各创建一条新待办并关联？`))) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const id of ids) {
        const row = plans.find((x) => x.id === id);
        if (!row || row.linked_task_id) continue;
        try { await api.post(`/plans/${id}/create-todo`); ok += 1; } catch { /* 单条失败继续 */ }
      }
      setPlanSelIds([]);
      reload();
      flash(`已创建并关联 ${ok} 条待办`);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }
  // T00564 扩展：批量字体颜色（色板选一次应用到全部选中）
  async function batchApplyColor(color: string) {
    const ids = [...planSelIds];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      for (const id of ids) await api.patch(`/plans/${id}`, { color });
      setPlanSelIds([]);
      reload();
      flash(`已为 ${ids.length} 条计划应用字体颜色`);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  // ---------- T00459：拖拽排序（HTML5 DnD，drop 后整体重写顺序并重排时间线） ----------

  const [dragId, setDragId] = useState('');
  const [overId, setOverId] = useState('');

  /** 计算里程碑拖入后是否落入另一里程碑的子任务区间，落入则返回其标题，否则 null */
  function milestoneConflictOwner(ids: string[], seq: number): string | null {
    let msIdx = -1;
    for (let k = 0; k < seq; k++) { if (plans.find((x) => x.id === ids[k])?.kind === 'milestone') msIdx = k; }
    for (let k = msIdx + 1; k < seq; k++) {
      if (plans.find((x) => x.id === ids[k])?.kind === 'milestone') { msIdx = k; break; }
    }
    if (msIdx >= 0 && msIdx < seq) return plans.find((x) => x.id === ids[msIdx])?.title ?? '?';
    return null;
  }
  /** 按落点同步 deps child（挂接/解除挂接），fire-and-forget + 即时提示（保持原行为） */
  function attachToMilestone(dragged: PlanTask, newOwnerId: string, targetTitle: string) {
    let depList: Array<{ id: string; type: string }> = [];
    try { depList = JSON.parse(dragged.deps || '[]') as Array<{ id: string; type: string }>; } catch { depList = []; }
    const kept = depList.filter((d) => d.type !== 'child');
    if (newOwnerId) kept.push({ id: newOwnerId, type: 'child' });
    void api.patch(`/plans/${dragged.id}`, { deps: JSON.stringify(kept) });
    flash(newOwnerId ? `已挂到里程碑「${targetTitle}」下` : '已解除里程碑挂接，恢复为普通任务');
  }

  function onDropReorder(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(''); setOverId(''); return; }
    const dragged = plans.find((x) => x.id === dragId);
    const target = plans.find((x) => x.id === targetId);
    if (!dragged || !target) return;
    const dragIsMs = dragged.kind === 'milestone';
    // T00554：里程碑只能排在里程碑之间的顶层位置——拖到普通/日常任务行上会被判定为子任务，导致层级卡死，统一拦截。
    if (dragIsMs && target.kind !== 'milestone') {
      flash('里程碑不能拖到任务行上——请拖到两个里程碑之间的位置排序');
      setDragId(''); setOverId('');
      return;
    }
    const ids = plans.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    // 排序后校验：里程碑的新位置若落在另一里程碑的子任务区间内 → 回退提示
    if (dragIsMs) {
      const conflict = milestoneConflictOwner(ids, ids.indexOf(dragId));
      if (conflict) {
        flash(`里程碑不能放入里程碑「${conflict}」的任务区间内——请拖到两个里程碑之间`);
        setDragId(''); setOverId('');
        return;
      }
    }
    // T00563：拖拽落点决定挂接状态——拖到里程碑/其子任务后 = 挂接该里程碑；拖到顶层任务后 = 解除挂接。
    if (!dragIsMs) {
      const targetOwner = target.kind === 'milestone' ? target : childMilestoneOf(target, plans);
      const curOwner = childMilestoneOf(dragged, plans);
      const newOwnerId = targetOwner?.id ?? '';
      if ((curOwner?.id ?? '') !== newOwnerId) {
        attachToMilestone(dragged, newOwnerId, targetOwner?.title ?? '');
      }
    }
    setDragId(''); setOverId('');
    setBusy(true);
    void api.post<{ reordered: number }>('/plans/reorder', { projectId, orderedIds: ids })
      .then(() => { reload(); flash('顺序已调整'); })
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

  // ---------- Excel / Markdown ----------

  async function exportExcel() {
    if (!projectId) return flash('请先选择项目');
    const buf = await api.getBinary(`/plans/export?projectId=${projectId}`);
    const ts = todayStr().replaceAll('-', '');
    downloadBlob(buf, `项目计划-${ts}.xlsx`);
  }

  /** T01071-FR5.3：项目全量 Markdown 导出（任务清单 + WBS + 需求矩阵单文档） */
  async function exportMarkdown() {
    if (!projectId) return flash('请先选择项目');
    setBusy(true);
    try {
      const buf = await api.getBinary(`/plans/export-md?projectId=${projectId}`);
      const ts = todayStr().replaceAll('-', '');
      downloadBlob(buf, `项目全量导出-${ts}.md`);
    } catch (e) { flash(String((e as Error).message ?? e)); } finally { setBusy(false); }
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
    const holSet = new Set(holidays.filter((h) => h.kind !== 'overtime').map((h) => h.date)); // T00764：加班日不标休

    // T01059-FR2.3：deps 连线与关键路径——serial 依赖边；关键路径 = 以 duration 为权重、deps DAG 上的最长链
    // （判据：endLen(v) === endLen(u) + dur(v) 的边即关键边；并列最长链都会高亮，符合可视化目的）
    const planById = new Map(plans.map((p) => [p.id, p]));
    const depsOfPlan = (p: PlanTask): Array<{ id?: string; type?: string }> => {
      try { return p.deps ? JSON.parse(p.deps) : []; } catch { return []; }
    };
    const endLen = new Map<string, number>();
    const longestEnd = (id: string, seen: Set<string>): number => {
      const memo = endLen.get(id);
      if (memo !== undefined) return memo;
      const p = planById.get(id);
      if (!p || seen.has(id)) return 0; // 环防护
      seen.add(id);
      let best = 0;
      for (const d of depsOfPlan(p)) {
        if (d?.id && d.type !== 'child') best = Math.max(best, longestEnd(d.id, seen));
      }
      seen.delete(id);
      const v = best + (p.duration_days || 0);
      endLen.set(id, v);
      return v;
    };
    for (const p of plans) longestEnd(p.id, new Set());
    const criticalEdges = new Set<string>(); // `${fromId}->${toId}`
    const criticalNodes = new Set<string>();
    for (const p of plans) {
      for (const d of depsOfPlan(p)) {
        if (!d?.id || d.type === 'child') continue;
        const u = planById.get(d.id);
        if (!u) continue;
        const ev = endLen.get(p.id) ?? 0;
        const eu = endLen.get(u.id) ?? 0;
        if (ev > 0 && ev === eu + (p.duration_days || 0)) {
          criticalEdges.add(`${u.id}->${p.id}`);
          criticalNodes.add(u.id);
          criticalNodes.add(p.id);
        }
      }
    }

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
            {/* 任务行（T01059-FR2.3：relative 容器 + SVG 依赖连线叠加层） */}
            <div style={{ position: 'relative' }}>
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
                    {/* 任务条（T01059-FR2.3：关键路径节点红色描边） */}
                    <div title={`${p.title}
${p.start_date} ~ ${p.end_date}（${p.duration_days} 工作日）· 进度 ${p.progress}% · ${p.assignee || '未分配'}${criticalNodes.has(p.id) ? ' · ★ 关键路径' : ''}`}
                      style={{
                        position: 'absolute', left, width, top: 5, height: 18, borderRadius: 4,
                        background: STATUS_BAR[p.status], opacity: 0.85, cursor: 'default', overflow: 'hidden',
                        outline: criticalNodes.has(p.id) ? '2px solid var(--danger)' : undefined, outlineOffset: -1,
                      }}>
                      <div style={{ width: `${p.progress}%`, height: '100%', background: 'rgba(255,255,255,.35)' }} />
                    </div>
                  </div>
                </div>
              );
            })}
            {/* T01059-FR2.3：deps 依赖连线 SVG 叠加层（serial 边画折线箭头；关键路径红色加粗） */}
            <svg width={220 + totalDays * DAY_W} height={plans.length * 30} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 2 }}>
              {(() => {
                const rowIdx = new Map(plans.map((p, i) => [p.id, i] as const));
                const els: React.ReactNode[] = [];
                for (const p of plans) {
                  if (!p.start_date || !p.end_date) continue;
                  const j = rowIdx.get(p.id);
                  if (j === undefined) continue;
                  const tx = 220 + toIdx(p.start_date) * DAY_W;
                  const ty = j * 30 + 15;
                  for (const d of depsOfPlan(p)) {
                    if (!d?.id || d.type === 'child') continue;
                    const u = planById.get(d.id);
                    if (!u || !u.start_date || !u.end_date) continue;
                    const i2 = rowIdx.get(u.id);
                    if (i2 === undefined) continue;
                    const fx = 220 + (toIdx(u.end_date) + 1) * DAY_W;
                    const fy = i2 * 30 + 15;
                    const crit = criticalEdges.has(`${u.id}->${p.id}`);
                    const color = crit ? 'var(--danger)' : 'var(--accent)';
                    const dAttr = tx > fx + 8
                      ? `M ${fx} ${fy} H ${(fx + tx) / 2} V ${ty} H ${tx - 5}`
                      : `M ${fx} ${fy} L ${tx - 5} ${ty}`;
                    els.push(<path key={`${u.id}-${p.id}`} d={dAttr} fill="none" stroke={color} strokeWidth={crit ? 2 : 1.2} opacity={crit ? 0.9 : 0.55} />);
                    els.push(<polygon key={`arr-${u.id}-${p.id}`} points={`${tx - 5},${ty - 3.5} ${tx - 5},${ty + 3.5} ${tx},${ty}`} fill={color} />);
                  }
                }
                return els;
              })()}
            </svg>
            </div>
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

  // ---------- 节假日 ----------
  // ---------- T00442：节假日多功能弹窗（手动维护 / 联网导入法定节假日 / 万年历视图） ----------

  const [holiOpen, setHoliOpen] = useSessionState<boolean>('plan.holiOpen', false); // T00570：切页保持
  const [holiTab, setHoliTab] = useSessionState<'manage' | 'national' | 'calendar'>('plan.holiTab', 'manage'); // T00570：切页保持
  const [holiNewDate, setHoliNewDate] = useState('');
  const [holiNewKind, setHoliNewKind] = useState<'holiday' | 'overtime'>('holiday'); // T00764
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
    if (!holiNewDate) return flash('请先选择日期');
    setHoliBusy(true);
    try {
      // T00764：kind= holiday 节假日 | overtime 加班日（周末/节假日调来上班，排期按工作日处理）
      await api.post('/plans/holidays', { date: holiNewDate, name: holiNewName, kind: holiNewKind });
      setHolidays(await api.get('/plans/holidays'));
      reload();
      flash(holiNewKind === 'overtime' ? '加班日已添加，排期时按工作日处理' : '节假日已添加，相关时间线已重排');
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
            // T00764：加班日（kind=overtime）绿色标记——排期按工作日处理
            const ot = c.day != null && holidays.some((h) => h.date === `${year}-${String(month + 1).padStart(2, '0')}-${String(c.day).padStart(2, '0')}` && h.kind === 'overtime');
            let color = 'var(--text)';
            if (ot) color = 'var(--success, #16a34a)';
            else if (c.hol) color = 'var(--danger)';
            else if (c.weekend) color = 'var(--text-muted)';
            let titleStr: string | undefined;
            if (ot) titleStr = '加班日 — 排期按工作日处理';
            else if (c.hol) titleStr = `节假日：${c.hol}`;
            let bg = 'transparent';
            if (ot) bg = 'var(--success-soft, rgba(22,163,74,.12))';
            else if (c.hol) bg = 'var(--danger-soft, rgba(220,38,38,.12))';
            return (
              <span key={c.day ?? `pad-${i}`} title={titleStr}
                style={{
                  padding: '2px 0', borderRadius: 3,
                  color,
                  background: bg,
                  fontWeight: c.hol || ot ? 600 : 400,
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

  /** 计划行拖放处理（提取为命名函数，降低 JSX 内联箭头嵌套深度，对应 S2004） */
  const makeRowDrop = (p: PlanTask) => (e: React.DragEvent<HTMLTableRowElement>) => {
    e.preventDefault();
    // T00508：拖到里程碑行上 = 挂接为子任务；拖到普通行 = 排序
    // T00527：挂接目标=里程碑行 或 里程碑的子任务行（挂到其父里程碑）
    const attachTarget = p.kind === 'milestone' ? p : childMilestoneOf(p, plans);
    if (attachTarget && dragId && dragId !== p.id) {
      const dragged = plans.find((x) => x.id === dragId);
      if (!dragged || dragged.kind === 'milestone') { setDragId(''); setOverId(''); return; }
      // T00563 反馈修正：拖拽物已挂接同一里程碑（区间内自有顺序调整）→ 走排序，不走挂接分支
      const draggedOwner = childMilestoneOf(dragged, plans);
      if (draggedOwner?.id === attachTarget.id) { onDropReorder(p.id); return; }
      let oldDeps: Array<{ id: string; type: string }> = [];
      try { oldDeps = dragged.deps ? JSON.parse(dragged.deps) : []; } catch { oldDeps = []; }
      const kept = oldDeps.filter((d) => d.type !== 'child');
      void updatePlan(dragged, { deps: JSON.stringify([...kept, { id: attachTarget.id, type: 'child' }]) });
      flash(`已挂到里程碑「${attachTarget.title}」下`);
      setDragId(''); setOverId('');
      return;
    }
    onDropReorder(p.id);
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
        <PlanProjectPicker projects={projects} sortedProjects={sortedProjects} projectId={projectId} setProjectId={setProjectId}
          projDropRef={projDropRef} sortDropRef={sortDropRef} projOpen={projOpen} setProjOpen={setProjOpen} projDropPos={projDropPos} setProjDropPos={setProjDropPos}
          projSortOpen={projSortOpen} setProjSortOpen={setProjSortOpen} projSortMode={projSortMode} setProjSortMode={setProjSortMode}
          dragProjId={dragProjId} setDragProjId={setDragProjId} overProjId={overProjId} setOverProjId={setOverProjId}
          dropReorder={dropReorder} togglePin={togglePin} isProjectPinned={isProjectPinned} />
        {/* T00506 调整：任务类型选择移入「新建计划任务」弹窗（默认普通任务），工具栏不再展示 */}
        <PlanCreateImportButtons busy={busy} createPlan={createPlan} importExcel={importExcel} exportExcel={exportExcel} exportMarkdown={exportMarkdown} downloadTemplate={downloadTemplate} />
        <PlanEvalButton batchEvaluatePlans={batchEvaluatePlans} evalBusy={evalBusy} busy={busy} evalLabel={evalLabel} plans={plans} />
        <PlanMultiToggle planMulti={planMulti} setPlanMulti={setPlanMulti} setPlanSelIds={setPlanSelIds} />
        {planMulti && planSelIds.length > 0 && (
          <PlanBatchBar planSelIds={planSelIds} plans={plans} selectAllPlans={selectAllPlans}
            planBatchStatus={planBatchStatus} planBatchAttach={planBatchAttach} batchSetStatus={batchSetStatus} batchEvaluateSelected={batchEvaluateSelected}
            batchArchivePlans={batchArchivePlans} batchAttach={batchAttach} batchCreateLinkedTodos={batchCreateLinkedTodos}
            batchApplyColor={batchApplyColor} evalBusy={evalBusy} busy={busy} />
        )}
        {evalBusy && <output className="flash-toast"><span className="task-breathe" style={{ color: 'var(--accent)' }}>AI 评估中{evalLabel ? `（${evalLabel}）` : ''}…</span></output>}
        <PlanViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        <PlanPanelToggles showPrd={showPrd} setShowPrd={setShowPrd} showMatrix={showMatrix} setShowMatrix={setShowMatrix} />
        <button onClick={openHolidayManager} style={btnStyle} title="节假日管理 — 手动维护 / 联网导入法定节假日 / 万年历视图">节假日（{holidays.length}）</button>
        <button onClick={reload} style={btnStyle} title="刷新"><RefreshCw size={13} /></button>
        {/* T00735：移除本页原有的「向导」按钮——与全局导航右上角常驻按钮重复（两者打开同一份项目管理向导内容），
            统一保留全局那个（已改为静态图标、无呼吸动画） */}
        {notice && <output className="flash-toast">{notice}</output>}
      </div>

      {/* T00507：项目整体统计（原节假日摘要栏位置；节假日管理保留按钮弹窗） */}
      {plans.length > 0 && (() => {
        const starts = plans.map((p) => p.start_date).filter(Boolean).sort((a, b) => a.localeCompare(b));
        const ends = plans.map((p) => p.end_date).filter(Boolean).sort((a, b) => a.localeCompare(b));
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
      {/* T00665：项目管理使用向导（首次自动弹出 / 右上角常驻按钮唤起） */}
      <ProjectGuideDialog open={guideOpen} onClose={() => { markProjectGuideSeen(); setGuideOpen(false); }} />

      {/* T00770：PRD 管理视图（矩阵面板上方展开；衔接 PRD → 确认版 → 需求跟踪矩阵流程） */}
      {showPrd && projectId && <PrdPanel projectId={projectId} onClose={() => setShowPrd(false)} />}

      {/* T00662：需求跟踪矩阵面板（甘特按钮旁入口展开） */}
      {showMatrix && projectId && <ReqMatrixPanel projectId={projectId} onClose={() => setShowMatrix(false)} />}

      {viewMode === 'gantt' ? renderGantt() : (
      <table className="plan-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-strong)' }}>
            <th style={{ padding: 6 }}>#</th>
            <PlanTitleFilterHeader planMulti={planMulti} plans={plans} planSelIds={planSelIds} setPlanSelIds={setPlanSelIds}
              allPlansRef={allPlansRef} titleFilter={titleFilter} setTitleFilter={setTitleFilter}
              titleFilterOpen={titleFilterOpen} setTitleFilterOpen={setTitleFilterOpen} />
            <th style={{ padding: 6, fontSize: 11 }}>依赖</th>
            <th style={{ padding: 6 }}>{renderColFilter('start', '开始', 'text')}</th>
            <th style={{ padding: 6 }}>{renderColFilter('end', '结束', 'text')}</th>
            <PlanDurationHeader durationUnit={durationUnit} setDurationUnit={setDurationUnit} />
            <th style={{ padding: 6 }}>{renderColFilter('progress', '进度', 'select', [
              { v: 'none', l: '未开始' }, { v: 'doing', l: '进行中' }, { v: 'done', l: '已完成' },
            ])}</th>
            <th style={{ padding: 6, minWidth: 70, whiteSpace: 'nowrap' }}>{renderColFilter('status', '状态', 'select', [
              { v: 'todo', l: '待开始' }, { v: 'doing', l: '进行中' }, { v: 'done', l: '已完成' }, { v: 'blocked', l: '阻塞' },
            ])}</th>
            <th style={{ padding: 6 }}>{renderColFilter('assignee', '负责人', 'text')}</th>
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
            // T00590：标题/列过滤 + T00508 父里程碑收起隐藏——判定逻辑下沉到模块级 planRowHidden
            if (planRowHidden(p, i, plans, titleFilter, colFilters, collapsedMs)) return null;
            // T00506：里程碑汇总——统计逻辑下沉到模块级 milestoneMeta
            const { isMilestone, inner, innerCount, innerDays, innerAvg } = milestoneMeta(plans, i);
            return (
              <PlanGanttRow key={p.id} p={p} i={i} plans={plans} seqs={seqs}
                isMilestone={isMilestone} inner={inner} innerCount={innerCount} innerDays={innerDays} innerAvg={innerAvg}
                dragId={dragId} overId={overId} newRowId={newRowId} planMulti={planMulti} planSelIds={planSelIds}
                collapsedMs={collapsedMs} durationUnit={durationUnit} depMenuId={depMenuId} depMenuRef={depMenuRef} depMenuPos={depMenuPos}
                evalBusy={evalBusy} busy={busy}
                setDragId={setDragId} setOverId={setOverId} togglePlanSel={togglePlanSel} toggleMsCollapsed={toggleMsCollapsed}
                updatePlan={updatePlan} flash={flash} openDepEditor={openDepEditor} makeRowDrop={makeRowDrop}
                setDepMenuId={setDepMenuId} setDepMenuPos={setDepMenuPos} evaluateRow={evaluateRow}
                insertAfter={insertAfter} linkTodo={linkTodo} createLinkedTodo={createLinkedTodo} archivePlan={archivePlan} unlinkTodo={unlinkTodo} />
            );
          });
          })()}
          {plans.length === 0 && (
            <tr><td colSpan={10} style={{ padding: 0 }}>
              {/* T01072-FR1.10：统一空态——动作直达新建入口 */}
              <EmptyState
                icon={<CalendarPlus size={18} />}
                title="当前项目暂无计划任务"
                hint="可「新建任务」逐条创建，或「导入 Excel」批量导入；也可在 AI 工作台用「AI 项目计划导入」从 PRD 自动拆解。"
                action={{ label: '新建计划任务', onClick: () => void createPlan() }}
              />
            </td></tr>
          )}
        </tbody>
      </table>
      )}

      {/* T00438 AI 导入弹窗：模型选择 + 文件上传 → AI 解析草稿表格（可编辑/勾选）→ 批量保存 */}
      {/* T00442 节假日多功能弹窗：手动维护 / 联网导入法定节假日 / 万年历 */}
      {holiOpen && (
        <HolidayModal holiBusy={holiBusy} setHoliOpen={setHoliOpen} holiTab={holiTab} setHoliTab={setHoliTab}
          holiNewKind={holiNewKind} setHoliNewKind={setHoliNewKind} holiNewDate={holiNewDate} setHoliNewDate={setHoliNewDate}
          holiNewName={holiNewName} setHoliNewName={setHoliNewName} holidays={holidays}
          addHolidayInModal={addHolidayInModal} removeHoliday={removeHoliday}
          natYear={natYear} setNatYear={setNatYear} importNational={importNational} natMsg={natMsg}
          calYear={calYear} setCalYear={setCalYear} renderMonthGrid={renderMonthGrid} />
      )}

      {/* T00499 前置依赖配置弹窗：任务列表多选 + 串行/并行标记 */}
      {depEditor && (
        <DepEditorModal depEditor={depEditor} setDepEditor={setDepEditor} plans={plans}
          depSel={depSel} setDepSel={setDepSel} saveDeps={saveDeps} />
      )}
    </div>
  );
}
