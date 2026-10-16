import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILE_INPUT_SR_ONLY } from '../ui/fileInput'; // T01674：file input 视觉隐藏但保留键盘焦点
import { childParentIdOf } from '../util/planDeps'; // T01621：里程碑显式挂接判定单源（与时间线分组共用）
import { Archive, ArrowUpDown, CalendarPlus, Check, Download, Gauge, ListChecks, GitBranch, MoreHorizontal, FileSpreadsheet, FileText, FilePenLine, Link2, Link2Off, Loader2, Pin, Plus, RefreshCw, Table2, TestTubes, Trash2, Upload, Zap, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState'; // T01072-FR1.10：统一空态组件
import { ReqMatrixPanel } from './ReqMatrixPanel'; // T00662：需求跟踪矩阵
import { TestCasePanel } from './TestCasePanel'; // T01485：测试用例视图
import { PrdPanel } from './PrdPanel'; // T00770：PRD 管理视图（文档生命周期 + 待确认问题）
import { EstimateGanttOverlay } from '../components/estimateGanttOverlay'; // T02082：E8 甘特估算区间叠加层（O~P 带 + E 标记，纯几何零二次计算）
import { estimatesApi, type EstimatesResponse } from '../api/estimates'; // T02082：叠加层数据源——只读服务端三点值（§9 零计算红线）
import { ProjectGuideDialog, hasSeenProjectGuide, markProjectGuideSeen } from './ProjectGuide'; // T00665：项目管理向导（T00706：已看状态改由调用方在关闭时记录）
import { PROJ_SORT_OPTIONS, PROJ_SORT_LABEL, isProjectPinned, sortProjects, toggleProjectPin, reorderProjects, type ProjectSortMode } from '../ui/projectOrder'; // T00663：排序/置顶共享模块
import { ProjectListHint, getProjectListSnapshot, refreshProjectList, useProjectList } from '../ui/projectList'; // T02201：项目列表取数容错层
import { ResourceHint, useResource } from '../ui/resourceState'; // T02213：节假日取数改走可见失败态层（工期换算依赖）
import { FontColorButton } from '../ui/FontColorButton';
import { api, type AITool } from '../api/client';
import { askConfirm, askInput, askInputEx } from '../ui/dialogs';
import { clearSessionState, usePersistentState, useSessionState } from '../ui/session';
import { buildWorkdayCtx } from '../utils/workday'; // T01059 后续：甘特拖动
import { deltaDaysFromPx, ganttDragResult, newGanttDrag, type GanttDragMode, type GanttDragState } from '../utils/ganttDrag'; // T01059 后续
import { PlanTimeline, type TlGranularity, type TlPlan, type TlSpacing } from '../components/PlanTimeline'; // T01564：纵向时间轴
import { SlideOver } from '../components/SlideOver'; // T01565：时间线节点详情复用 FR-3.2 抽屉基元
import { focusTaskById } from '../ui/focusTask'; // T01577：时间线节点跳转关联待办，复用跨视图定位公共 helper
import { EstimatePanel, ESTIMATE_PANEL_WIDTH, useEstimatePanelMode } from '../components/EstimatePanel'; // T02039（估算视图 E4）：时间线右侧停靠面板，<1200px 转覆盖式

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

/** T00508：取记录挂接的里程碑（deps 中 type=child），无则 null。
 *  T01621：解析逻辑收敛到 web/src/util/planDeps.ts 单源——时间线阶段分组（PlanTimeline.phases）
 *  与本判定共用同一实现，保证「里程碑成员集合」两视图一致（折叠隐藏集合差集为空）。 */
function childMilestoneOf(p: PlanTask, plans: PlanTask[]): PlanTask | null {
  const id = childParentIdOf(p.deps);
  return id ? plans.find((x) => x.id === id) ?? null : null;
}

/** 计划行补丁类型（与 updatePlan 第二参对齐，提取单元格组件复用） */
type PlanPatch = Partial<Pick<PlanTask, 'title' | 'description' | 'duration_days' | 'assignee' | 'progress' | 'status' | 'start_date' | 'color' | 'deps'>>;

type HolidayTab = 'manage' | 'national' | 'calendar';

/** 节假日/加班日行（T00764）：kind= holiday 放假日 | overtime 加班日 */
type Holiday = { date: string; name: string; kind: string };
/** 取数未成功时的空列表用常驻引用，避免每次渲染现造新数组让 workdayCtx 等 useMemo 整表重算 */
const NO_HOLIDAYS: Holiday[] = [];

/** 甘特页项目选择器：触发按钮 + 排序菜单 + 项目下拉（T00663，S3776 抽取） */
function PlanProjectPicker({ projects, sortedProjects, projectId, setProjectId, projDropRef, sortDropRef, projOpen, setProjOpen, projDropPos, setProjDropPos, projSortOpen, setProjSortOpen, projSortMode, setProjSortMode, dragProjId, setDragProjId, overProjId, setOverProjId, dropReorder, togglePin, isProjectPinned, onExpand }: {
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
  /** T01679：下拉展开时的按需重拉回调（T01584 同款 800ms 节流在父级实现）——连点不重复发请求 */
  readonly onExpand?: () => void;
}) {
  const cur = projects.find((p) => p.id === projectId);
  return (
    <div ref={projDropRef} style={{ position: 'relative', display: 'inline-flex', minWidth: 0 }}>
      <button onClick={(e) => {
        // T00520：展开时以按钮视口坐标 fixed 定位面板——脱离父容器 overflow 裁剪，不受窗口/容器大小限制
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setProjDropPos({ top: r.bottom + 4, left: r.left });
        if (!projOpen) onExpand?.(); // T01679：展开即重拉项目行（三枚计划徽标取最新），收起不拉
        setProjOpen((o) => !o);
      }} aria-haspopup="listbox" aria-expanded={projOpen}
        title="选择项目 — 项目名后徽标：绿=已完成、蓝=进行中、灰=待开始（悬浮查看详情）"
        aria-label="选择项目"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 8px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, cursor: 'pointer', maxWidth: 220, minWidth: 0 }}>
        {/* T02167：与任务页项目下拉条同修——名称让步（单行省略），徽标与箭头 flexShrink:0 不让步，
            否则窄窗口下裸文本节点被压到 1 字宽、统计徽标溢出按钮边框 */}
        <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cur?.name ?? '选择项目'}
        </span>
        {cur ? (
          <>
            <span title={`已完成 ${cur.plan_done ?? 0}`} style={{ flexShrink: 0, minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--success-soft, rgba(22,163,74,.12))', color: 'var(--success)' }}>{cur.plan_done ?? 0}</span>
            <span title={`进行中 ${cur.plan_doing ?? 0}`} style={{ flexShrink: 0, minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{cur.plan_doing ?? 0}</span>
            <span title={`待开始 ${cur.plan_open ?? 0}`} style={{ flexShrink: 0, minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{cur.plan_open ?? 0}</span>
          </>
        ) : null}
        <ChevronDown size={12} style={{ flexShrink: 0 }} />
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
        <div style={{ position: 'fixed', top: projDropPos.top, left: projDropPos.left, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.14)', zIndex: 60, minWidth: 240, maxWidth: `min(360px, calc(100vw - ${projDropPos.left + 12}px))`, overflowX: 'hidden', maxHeight: `calc(100vh - ${projDropPos.top + 12}px)`, overflowY: 'auto' }}>
          {/* T00663：项目下拉项——置顶图标在名称前；默认序下支持拖拽排序（持久化到服务端） */}
          {sortedProjects.map((p) => (
            // T02146：行容器由原生 button 改 div role=button——行内的置顶图标本身是 button，
            // HTML 不允许按钮套按钮（同 T02143 根因：a11y 批修把规则套到了含交互子元素的容器上）。
            // 拖拽属性在 div 上等价可用；手感靠 .card-btn 补回（App.tsx 已落该类）。
            <div key={p.id} role="button" tabIndex={0} className="card-btn" aria-pressed={p.id === projectId} /* NOSONAR: S6819 豁免——T02146：行内含原生置顶button，HTML禁止按钮套按钮；键盘支持已在onKeyDown保留 */
              draggable={projSortMode === 'default'}
              onDragStart={() => setDragProjId(p.id)}
              onDragOver={(e) => { if (projSortMode === 'default' && dragProjId) { e.preventDefault(); setOverProjId(p.id); } }}
              onDragLeave={() => setOverProjId((curId) => (curId === p.id ? '' : curId))}
              onDrop={(e) => { e.preventDefault(); runAsync(dropReorder(p.id)); }}
              onDragEnd={() => { setDragProjId(''); setOverProjId(''); }}
              onClick={() => { setProjectId(p.id); setProjOpen(false); }}
              onKeyDown={(e) => {
                // 只认行容器自身的按键：角标按钮 Enter 冒泡会「切置顶 + 选项目」一并触发（T02143 实测口径）
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setProjectId(p.id); setProjOpen(false); }
              }}
              title={projSortMode === 'default'
                ? `${p.name}：已完成 ${p.plan_done ?? 0}，进行中 ${p.plan_doing ?? 0}，待开始 ${p.plan_open ?? 0}（可拖拽调整顺序）`
                : `${p.name}：已完成 ${p.plan_done ?? 0}，进行中 ${p.plan_doing ?? 0}，待开始 ${p.plan_open ?? 0}（拖拽排序请切换到「默认（置顶优先）」）`}
              style={{ display: 'flex', width: '100%', boxSizing: 'border-box', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 12, opacity: dragProjId === p.id ? 0.5 : 1, borderTop: overProjId === p.id ? '2px solid var(--accent)' : '2px solid transparent', background: p.id === projectId ? 'var(--accent-soft)' : 'transparent', color: 'var(--text)', cursor: projSortMode === 'default' ? 'grab' : 'pointer' }}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); runAsync(togglePin(p)); }}
                title={isProjectPinned(p) ? `已置顶「${p.name}」— 点击取消置顶` : `置顶「${p.name}」— 点击后在默认排序下排最前`}
                aria-label={isProjectPinned(p) ? `取消置顶 ${p.name}` : `置顶 ${p.name}`}
                style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, color: isProjectPinned(p) ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', border: 'none', background: 'transparent', padding: 0 }}
              >
                <Pin size={12} style={{ transform: isProjectPinned(p) ? 'rotate(-45deg)' : 'none', transition: 'transform .18s ease, color .18s ease', fill: isProjectPinned(p) ? 'currentColor' : 'none' }} />
              </button>
              {/* T02167：同任务页——名称 flex:1 + minWidth:0 才能收缩省略，三枚计划徽标 flexShrink:0 不让步 */}
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span title={`已完成 ${p.plan_done ?? 0}`} style={{ flexShrink: 0, minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--success-soft, rgba(22,163,74,.12))', color: 'var(--success)' }}>{p.plan_done ?? 0}</span>
              <span title={`进行中 ${p.plan_doing ?? 0}`} style={{ flexShrink: 0, minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--accent-soft)', color: 'var(--accent)' }}>{p.plan_doing ?? 0}</span>
              <span title={`待开始 ${p.plan_open ?? 0}`} style={{ flexShrink: 0, minWidth: 14, textAlign: 'center', fontSize: 10, borderRadius: 8, padding: '0 4px', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{p.plan_open ?? 0}</span>
            </div>
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
      {/* T01619：工具栏七个操作按钮默认隐藏、悬浮整条工具栏（.op-host）时淡入——
          沿用 .op-hidden 口径（opacity + visibility，保留占位不跳版，且不做灰显禁用） */}
      <button className="tbtn-anim op-hidden" onClick={() => void createPlan()} disabled={busy} title="新建计划任务 — 弹窗中选择任务类型（普通/里程碑/日常）" aria-label="新建计划任务" style={{ ...btnStyle, padding: '6px 8px' }}><CalendarPlus size={13} /></button>
      <label className="tbtn-anim op-hidden" style={{ ...btnStyle, cursor: busy ? 'default' : 'pointer', padding: '6px 8px' }} title="导入 Excel — 批量导入计划任务（任一行校验失败则整体不入库）" aria-label="导入 Excel">
        <Upload size={13} />
        <input type="file" accept=".xlsx" style={FILE_INPUT_SR_ONLY}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { void importExcel(f); e.target.value = ''; } }} />
      </label>
      <button className="tbtn-anim op-hidden" onClick={() => void exportExcel()} title="导出 Excel — 导出当前项目全部计划" aria-label="导出 Excel" style={{ ...btnStyle, padding: '6px 8px' }}><Download size={13} /></button>
      {/* T01071-FR5.3：项目全量 Markdown 导出（任务清单 + WBS + 需求矩阵单文档） */}
      <button className="tbtn-anim op-hidden" onClick={() => void exportMarkdown()} title="导出 Markdown — 任务清单 + 计划 + 需求矩阵单文档" aria-label="导出 Markdown" style={{ ...btnStyle, padding: '6px 8px' }}><FileText size={13} /></button>
      <button className="tbtn-anim op-hidden" onClick={() => void downloadTemplate()} title="下载模板 — 获取导入用 Excel 模板" aria-label="下载导入模板" style={{ ...btnStyle, padding: '6px 8px' }}><FileSpreadsheet size={13} /></button>
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
    <button onClick={() => runAsync(batchEvaluatePlans())} disabled={evalBusy || busy} title="AI 评估 — 对全部计划条目评估工期合理性/风险与建议，结果自动录入各条描述（确认后执行）" aria-label="批量 AI 评估" className={'op-hidden' + (evalBusy ? ' task-breathe' : '')} style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
      {evalBusy ? <Loader2 size={13} className="aispin" /> : <Zap size={13} />}AI 评估{evalBusy
        ? (evalLabel && plans.length > 0 ? `（${evalLabel}）` : '') // T01618：评估中保持进度标签口径不变
        : (plans.length > 0 ? ` ${plans.length}` : '')} {/* T01618：待评估计划条数，对齐「AI 美化全部待办」数量范式 */}
    </button>
  );
}

/** 工具栏：复杂度批量补算按钮（T01058 后续，S3776 抽取） */
function PlanComplexityButton({ backfill, evalBusy, busy }: {
  readonly backfill: (force: boolean) => Promise<void>; readonly evalBusy: boolean; readonly busy: boolean;
}) {
  return (
    <button
      onClick={(e) => runAsync(backfill(e.shiftKey))}
      disabled={evalBusy || busy}
      title="补算复杂度 — 为尚无复杂度评级（1~5）的计划行批量补算，AI 按批评定；按住 Shift 点击 = 连同已评级的行一起重算"
      aria-label="批量补算复杂度"
      className={evalBusy ? 'task-breathe' : undefined}
      style={{ ...btnStyle, color: 'var(--text-secondary)' }}
    >
      {evalBusy ? <Loader2 size={13} className="aispin" /> : <Gauge size={13} />}补算复杂度
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
      className="tbtn-anim op-hidden"
      style={{ fontSize: 12, padding: '5px 7px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', border: '1px solid var(--border-strong)', background: planMulti ? 'var(--accent)' : 'transparent', color: planMulti ? 'var(--accent-text)' : 'var(--text)' }}>
      {planMulti ? <Check size={13} /> : <ListChecks size={13} />}
    </button>
  );
}

/** 工具栏：列表/甘特视图切换（S3776 抽取） */
function PlanViewModeToggle({ viewMode, setViewMode }: {
  readonly viewMode: 'list' | 'gantt' | 'timeline'; readonly setViewMode: React.Dispatch<React.SetStateAction<'list' | 'gantt' | 'timeline'>>;
}) {
  return (
    <fieldset style={{ display: 'inline-flex', margin: 0, padding: 0, minWidth: 0, border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }} aria-label="视图切换">
      <button onClick={() => setViewMode('list')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: viewMode === 'list' ? 'var(--accent)' : 'transparent', color: viewMode === 'list' ? 'var(--accent-text)' : 'var(--text)' }} title="列表视图">列表</button>
      <button onClick={() => setViewMode('gantt')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: viewMode === 'gantt' ? 'var(--accent)' : 'transparent', color: viewMode === 'gantt' ? 'var(--accent-text)' : 'var(--text)' }} title="甘特图视图 — 按串行瀑布时间线可视化">甘特</button>
      <button onClick={() => setViewMode('timeline')} style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: viewMode === 'timeline' ? 'var(--accent)' : 'transparent', color: viewMode === 'timeline' ? 'var(--accent-text)' : 'var(--text)' }} title="时间线视图 — 纵向里程碑脉络，与甘特（横向排期+依赖线+关键路径）互补">时间线</button>
    </fieldset>
  );
}

/** T01565：时间线粒度切换（日 / 周 / 月 / 季）。
 *  与甘特的 durationUnit（day/hour）是两套口径：本控件决定**轴上刻度密度**与标签格式，
 *  不改任何排期数据，故与会话态一起独立存储（S3776 抽取）。 */
function PlanTimelineGranularityToggle({ granularity, setGranularity }: {
  readonly granularity: TlGranularity; readonly setGranularity: React.Dispatch<React.SetStateAction<TlGranularity>>;
}) {
  const granules: ReadonlyArray<{ readonly k: TlGranularity; readonly label: string; readonly tip: string }> = [
    { k: 'day', label: '日', tip: '按日刻度：轴上最密，适合短周期冲刺' },
    { k: 'week', label: '周', tip: '按周刻度（周一起算）：适合迭代级脉络' },
    { k: 'month', label: '月', tip: '按月刻度：默认，适合里程碑级脉络' },
    { k: 'quarter', label: '季', tip: '按季刻度：轴上最疏，适合跨季度总览' },
  ];
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }} role="group" aria-label="时间线粒度">
      {granules.map((g, i) => (
        <button
          key={g.k}
          title={g.tip}
          aria-pressed={granularity === g.k}
          onClick={() => setGranularity(g.k)}
          style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderLeft: i > 0 ? '1px solid var(--border-strong)' : 'none', cursor: 'pointer', background: granularity === g.k ? 'var(--accent)' : 'transparent', color: granularity === g.k ? 'var(--accent-text)' : 'var(--text)' }}
        >{g.label}</button>
      ))}
    </div>
  );
}

/** T01575：时间线间距模式切换（等距 / 按比例）。
 *  与粒度控件同排、同为呈现偏好：按比例时长空档按 start_date 差值真实拉开，
 *  组件内已做「最小间距护栏 + 超长空档压缩并给断裂提示」，故不会推出不可读的空白（S3776 抽取）。 */
function PlanTimelineSpacingToggle({ spacing, setSpacing }: {
  readonly spacing: TlSpacing; readonly setSpacing: React.Dispatch<React.SetStateAction<TlSpacing>>;
}) {
  const modes: ReadonlyArray<{ readonly k: TlSpacing; readonly label: string; readonly tip: string }> = [
    { k: 'uniform', label: '等距', tip: '等距排布：每个节点固定一行，重在脉络可读（默认）' },
    { k: 'proportional', label: '按比例', tip: '按比例排布：节点纵向距离 ∝ 起始日期差（按自然日；甘特/工期为工作日口径，两者不可直接对照），跨月空档会真实拉开（超长空档压缩绘制并标注「空档 N 天」）' },
  ];
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }} role="group" aria-label="时间线间距模式">
      {modes.map((m, i) => (
        <button
          key={m.k}
          type="button"
          data-tl-spacing={m.k}
          title={m.tip}
          aria-pressed={spacing === m.k}
          onClick={() => setSpacing(m.k)}
          style={{ padding: '4px 10px', fontSize: 12, border: 'none', borderLeft: i > 0 ? '1px solid var(--border-strong)' : 'none', cursor: 'pointer', background: spacing === m.k ? 'var(--accent)' : 'transparent', color: spacing === m.k ? 'var(--accent-text)' : 'var(--text)' }}
        >{m.label}</button>
      ))}
    </div>
  );
}

/** T01576：时间线「全部收起 / 全部展开」快捷按钮（仅时间线视图内）。 *  写的仍是 `plan.collapsedMs` 同一份会话态——这里一键收起，列表/甘特视图同步收起，
 *  不另建第二套折叠记忆。 */
function PlanTimelineCollapseAll({ allCollapsed, phaseCount, onToggle }: {
  readonly allCollapsed: boolean; readonly phaseCount: number; readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-tl="collapse-all"
      onClick={onToggle}
      disabled={phaseCount === 0}
      aria-pressed={allCollapsed}
      aria-label={allCollapsed ? '展开全部阶段的任务节点' : '全部收起：隐藏各阶段内的任务节点'}
      title={allCollapsed
        ? `展开全部 ${phaseCount} 个阶段的节点`
        : `全部收起 ${phaseCount} 个阶段的任务节点（里程碑脉络与阶段汇总仍保留）`}
      style={{
        padding: '4px 10px', fontSize: 12, cursor: phaseCount === 0 ? 'not-allowed' : 'pointer',
        border: '1px solid var(--border-strong)', borderRadius: 6, opacity: phaseCount === 0 ? .5 : 1,
        background: allCollapsed ? 'var(--accent)' : 'transparent',
        color: allCollapsed ? 'var(--accent-text)' : 'var(--text)',
      }}
    >{allCollapsed ? '全部展开' : '全部收起'}</button>
  );
}

/** T01565：时间线节点详情（SlideOver 正文）。只读展示——编辑仍走列表/甘特既有入口，
 *  本抽屉不复制一套编辑逻辑（S3776 抽取，保持 renderTimeline 只做编排）。 */
function PlanTimelineDetail({ plan, onJump }: {
  readonly plan: TlPlan;
  /** T01577：点击「已关联待办」跳到该待办并打开抽屉；缺省时保持纯文本（组件仍可在只读场景复用） */
  readonly onJump?: (p: TlPlan) => void;
}) {
  const badge = (children: React.ReactNode, color?: string) => (
    <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, border: '1px solid var(--border-strong)', color: color ?? 'var(--text-muted)', whiteSpace: 'nowrap' }}>{children}</span>
  );
  const isMs = plan.kind === 'milestone';
  const statusLabel: Record<string, string> = { todo: '待开始', doing: '进行中', done: '已完成', blocked: '受阻' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {badge(isMs ? '阶段里程碑' : plan.kind === 'daily' ? '日常任务' : '计划任务', 'var(--accent)')}
        {plan.assignee && badge(`负责人：${plan.assignee}`)}
        <span>{statusLabel[plan.status] ?? plan.status}</span>
        {!isMs && badge(`进度 ${plan.progress || 0}%`)}
      </div>
      <div>
        <b>起止：</b>{plan.start_date || '未排期'} → {plan.end_date || '未排期'}
        <span style={{ color: 'var(--text-muted)' }}>（{plan.duration_days || 0} 天）</span>
      </div>
      {plan.description && (
        <div>
          <b>描述：</b>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 4, color: 'var(--text-muted)' }}>{plan.description}</div>
        </div>
      )}
      {plan.linked_task_id && (onJump ? (
        // T01577：抽屉里的关联待办改为可点击（键盘可达 + hover/焦点态），点击即切到待办页并打开该任务抽屉
        <button type="button" data-tl="drawer-jump-linked" className="tl-chip"
          onClick={() => onJump(plan)}
          aria-label={`打开关联待办：${plan.linked_task_title || plan.title}`}
          title="跳转到该计划关联的待办 — 切到待办页并打开详情抽屉"
          style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 9px', fontSize: 12, border: '1px solid var(--success)', borderRadius: 6,
            background: 'var(--card-bg)', color: 'var(--success)', cursor: 'pointer' }}>
          ✓ 已关联待办{plan.linked_task_title ? `：${plan.linked_task_title}` : ''} <span aria-hidden="true">↗</span>
        </button>
      ) : (
        <div style={{ color: 'var(--success)' }}>✓ 已关联待办{plan.linked_task_title ? `：${plan.linked_task_title}` : ''}</div>
      ))}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        详情为只读快照；要改排期/进度请回列表或甘特视图编辑。
      </div>
    </div>
  );
}

/** 工具栏：PRD 管理 / 需求跟踪矩阵 / 测试用例入口（S3776 抽取） */
function PlanPanelToggles({ showPrd, setShowPrd, showMatrix, setShowMatrix, showTestCases, setShowTestCases }: {
  readonly showPrd: boolean; readonly setShowPrd: React.Dispatch<React.SetStateAction<boolean>>;
  readonly showMatrix: boolean; readonly setShowMatrix: React.Dispatch<React.SetStateAction<boolean>>;
  readonly showTestCases: boolean; readonly setShowTestCases: React.Dispatch<React.SetStateAction<boolean>>;
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
      {/* T01485：测试用例入口——紧随需求跟踪矩阵（PRD §4.1：矩阵是用例的上游，顺序即操作动线）；图标-only，样式与相邻两个入口完全一致 */}
      <button onClick={() => setShowTestCases((v) => !v)} className="tbtn-anim"
        title="测试用例 — 用例增删改查、步骤行内编辑、批量维护、覆盖度与导出"
        aria-label="测试用例" aria-expanded={showTestCases}
        style={{ ...btnStyle, background: showTestCases ? 'var(--accent)' : 'transparent', color: showTestCases ? 'var(--accent-text)' : 'var(--text)', borderColor: showTestCases ? 'var(--accent)' : 'var(--border-strong)' }}>
        <TestTubes size={13} />
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

/** 异步动作触发（S3735：以 catch 兜底替代 void 运算符，忽略 Promise 拒绝）。
 *  T02213 登记：**这里吞异常是有意的**——它是写操作（保存/删除/重排等）的 fire-and-forget 收口，
 *  失败提示由各动作函数内部 flash/弹窗自行给出，此处再挂一套失败态只会重复报同一件事。
 *  本单只收敛「取数被吞成无数据」，故此处不改，避免后续把它误判为漏改。 */
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
      data-plan-id={p.id}
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
function HolidayModal({ holiBusy, setHoliOpen, holiTab, setHoliTab, holiNewKind, setHoliNewKind, holiNewDate, setHoliNewDate, holiNewName, setHoliNewName, holidays, holidaysHint, addHolidayInModal, removeHoliday, natYear, setNatYear, importNational, natMsg, calYear, setCalYear, renderMonthGrid }: {
  readonly holiBusy: boolean; readonly setHoliOpen: (v: boolean) => void;
  readonly holiTab: HolidayTab; readonly setHoliTab: React.Dispatch<React.SetStateAction<HolidayTab>>;
  readonly holiNewKind: 'holiday' | 'overtime'; readonly setHoliNewKind: React.Dispatch<React.SetStateAction<'holiday' | 'overtime'>>;
  readonly holiNewDate: string; readonly setHoliNewDate: React.Dispatch<React.SetStateAction<string>>;
  readonly holiNewName: string; readonly setHoliNewName: React.Dispatch<React.SetStateAction<string>>;
  readonly holidays: Array<{ date: string; name: string; kind: string }>;
  readonly holidaysHint?: React.ReactNode;
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
                {/* T02213：弹窗内同样给出取数失败原因与重试入口——遮罩盖住工具条，只放外面等于看不见 */}
                {holidaysHint}
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

/** 里程碑汇总（T00506）：本里程碑到下一里程碑之间的普通/日常任务统计。
 *  ⚠ 口径（T01621）：此处汇总**按位置切片**（T00506 既有语义，显示维度不收窄），
 *  而折叠隐藏（planRowHidden）与时间线阶段成员**按显式 child 依赖**——两套口径并存：
 *  汇总数字可能包含未显式挂接的位置后继，属预期行为，勿据此外推折叠集合。 */
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

/**
 * T01620：批量 AI 循环活在组件实例之外（切页卸载后旧循环仍在跑并继续写描述），
 * 组件级 busy 随实例一起消失，故用模块级标记兜住重复启动——刷新会自然归零。
 */
let planAiBatchRunning = false;

export function PlanPage() {
  // T02201：项目列表取数交统一容错层（加载中/失败可见 + 重试，失败不缓存冒充正常数据）
  const projectList = useProjectList();
  const { projects } = projectList;
  // T00460：切页保状态——项目选择会话级持久化，切回不重置
  const [projectId, setProjectId] = useSessionState('plan.projectId', '');
  const [plans, setPlans] = useState<PlanTask[]>([]);
  // T00764：kind= holiday 放假日 | overtime 加班日
  // T02213：节假日是**工期换算的输入**（buildWorkdayCtx / 甘特着色 / 汇总天数都吃它），
  // 此前取数失败被 `.catch(() => undefined)` 吞成空数组，工期就按「无节假日」口径静默算错。
  const holidaysView = useResource<Holiday[]>(() => api.get<Holiday[]>('/plans/holidays'));
  const setHolidays = holidaysView.setData;
  const holidays = holidaysView.data ?? NO_HOLIDAYS;
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // T00438 AI 导入：模型列表与选中工具（持久化）、解析弹窗状态、可编辑草稿行
  const [aiToolId, setAiToolId] = usePersistentState('plan.aiToolId', '');
  // T00472：AI 评估状态（批量进度动态计数，单条/批量共用）。
  // T01620：这两个状态**必须留在组件内**，不能再走 useSessionState——持久化靠 effect 落盘，
  // 而 PlanPage 是 `{tab==='plan' && <PlanPage/>}` 条件挂载，切页/刷新即卸载：
  // 在跑的循环对已卸载组件 setState 是空操作，sessionStorage 里最后一次落盘的
  // `evalBusy=true` + `evalLabel='0/20'`（首条 AI 调用要几十秒，正是最容易落盘的窗口）
  // 就再没人能清掉 → 计数永久冻结、评估按钮永久禁用。
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalLabel, setEvalLabel] = useState('');
  // 存量僵尸键自愈：修复前卡住的用户，回到本页即清一次（此后不再有写入方）
  useEffect(() => { clearSessionState('plan.evalBusy'); clearSessionState('plan.evalLabel'); }, []);
  // ---- 行级交互回调（S2004/S3776：从 JSX 内联箭头下沉到组件级，降低嵌套与复杂度） ----
  const toggleMsCollapsed = (id: string) => setCollapsedMs((prev) => ({ ...prev, [id]: !prev[id] }));
  const evaluateRow = (row: PlanTask) => {
    if (evalBusy || planAiBatchRunning) { flash('批量 AI 任务进行中，请等待其完成'); return; }
    // T02283：工具列表没加载出来是后端问题，不能报成用户的配置问题
    if (!aiToolId) { flash(aiToolsView.phase === 'error' ? 'AI 工具列表加载失败，请点工具条的「重试」后再评估' : '请先在模型菜单配置默认 AI 工具'); return; }
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
  const [viewMode, setViewMode] = useSessionState<'list' | 'gantt' | 'timeline'>('plan.viewMode', 'list');
  // T01565：时间线粒度（日/周/月/季）——独立于甘特的 durationUnit（day/hour），会话级保持
  const [tlGranularity, setTlGranularity] = useSessionState<TlGranularity>('plan.tlGranularity', 'month');
  // T01575：时间线间距模式（等距/按比例）——与粒度同属视图呈现偏好，会话级保持，不改排期数据
  const [tlSpacing, setTlSpacing] = useSessionState<TlSpacing>('plan.tlSpacing', 'uniform');
  // T01565：时间线节点点击详情（复用 FR-3.2 SlideOver，不新造抽屉）
  const [selectedPlan, setSelectedPlan] = useState<TlPlan | null>(null);
  // T02039（估算视图 E4 / 裁决 D3）：估算面板只挂在时间线视图，开合态与 plan.viewMode、plan.collapsedMs
  // 同套会话级持久化口径（§10-1「刷新后保持」）；改 viewMode 不受影响——面板不是第四段视图。
  const [estimateOpen, setEstimateOpen] = useSessionState<boolean>('plan.estimatePanelOpen', false);
  const estimateMode = useEstimatePanelMode(); // docked（≥1200px）/ overlay（<1200px 转覆盖式抽屉）

  // T02082：甘特估算区间叠加开关与数据源——与估算面板开关互相独立（§5.2：面板打开时甘特视图不变）。
  // 数据懒加载：首次打开才取 GET /api/estimates（O/P 取 items 三点，E 取 summary.rowRatios 服务端期望值，
  // 本页零 PERT 二次运算）；失败静默降级为无叠加 + toast，不阻塞甘特本体。
  const [showGanttEstimate, setShowGanttEstimate] = useState(false);
  const [ganttEst, setGanttEst] = useState<EstimatesResponse | null>(null);
  const toggleGanttEstimate = (): void => {
    const next = !showGanttEstimate;
    setShowGanttEstimate(next);
    if (next && projectId && !ganttEst) {
      estimatesApi.getAll(projectId)
        .then((r) => setGanttEst(r))
        .catch(() => flash('估算数据加载失败，本次不叠加区间'));
    }
  };

  // ---------- T01059 后续：甘特条拖动（move / 左右边缘 resize → 联动 start_date 与 duration_days）----------
  // 拖动期间只改本地预览态，松手才落库（走既有 updatePlan → PATCH /plans/:id，服务端按工作日历重算 end_date
  // 并沿显式 deps 传播）。这样一次拖动只发一个请求，也不会在拖动过程中被 reload 打断。
  const [ganttDrag, setGanttDrag] = useState<GanttDragState | null>(null);
  const ganttDragRef = useRef<GanttDragState | null>(null);
  // 与服务端同口径的工作日历上下文（放假日/加班日）
  const workdayCtx = useMemo(() => buildWorkdayCtx(holidays), [holidays]);
  // T00665：使用向导——首次进入模块自动弹出（依据 localStorage 标记），常驻按钮可随时重看
  const [guideOpen, setGuideOpen] = useState(false);
  useEffect(() => { if (!hasSeenProjectGuide()) setGuideOpen(true); }, []);

  // T00663：项目排序与置顶（复用共享模块）——排序方式会话级持久；拖拽排序仅在默认序下启用
  const [projSortMode, setProjSortMode] = usePersistentState<ProjectSortMode>('plan.projectSort', 'default'); // T01697：排序偏好持久化（重启保持）
  const [projSortOpen, setProjSortOpen] = useState(false);
  const sortDropRef = useRef<HTMLSpanElement | null>(null);
  const [dragProjId, setDragProjId] = useState('');
  const [overProjId, setOverProjId] = useState('');

  // T00662：需求跟踪矩阵面板展开态（甘特按钮旁入口）
  const [showMatrix, setShowMatrix] = useSessionState<boolean>('plan.showMatrix', false);

  // T00770：PRD 管理视图展开态（矩阵入口前方按钮；面板在矩阵面板上方展开）
  const [showPrd, setShowPrd] = useSessionState<boolean>('plan.showPrd', false);

  // T01485：测试用例视图展开态（PRD §7.1 会话键 `plan.showTestCases`）
  const [showTestCases, setShowTestCases] = useSessionState<boolean>('plan.showTestCases', false);

  // T01486 §4.3：矩阵 ⇄ 用例 双向跳转的两个瞬时意图，与会话态同机制落 sessionStorage
  // （刷新/切页返回后不丢）：下钻带来的是“筛哪个需求”，回跳带来的是“定位哪一行”。
  // 两者不新建第三套筛选状态，分别复用 `tc.reqFilter` 与矩阵行高亮。
  const [tcFocusReqId, setTcFocusReqId] = useSessionState<string>('plan.tcFocusReqId', '');
  const [matrixLocateReqId, setMatrixLocateReqId] = useSessionState<string>('plan.matrixLocateReqId', '');
  // T02196：任务徽标「计划/里程碑」点击带来的定位意图（值=plan_tasks 行 id）——与会话键同机制，
  // 本页按 tab 条件挂载，未挂载时由挂载读取、挂载后由本 effect 消费即清。
  const [locateNodeId, setLocateNodeId] = useSessionState<string>('plan.locateNodeId', '');
  // T01486 A4：下钻序号（不入会话：它只是「刚刚点了一下」这种瞬时信号，跨刷新保持它反而会让面板重复应用筛选）
  const [tcDrillSeq, setTcDrillSeq] = useState(0);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 3000); };

  /** T00657：项目列表（下拉徽标含待办/未验证与计划计数）——取数交 T02201 统一容错层，本函数保留「首个项目兜底选中」语义 */
  const loadProjects = useCallback(async () => {
    await refreshProjectList();
    const ps = getProjectListSnapshot();
    if (ps.length > 0) setProjectId((cur) => cur || ps[0].id);
  }, []);
  useEffect(() => { void loadProjects(); }, [loadProjects]);
  // T00657：任务与计划变更会改变项目下拉计数 → 订阅变更实时刷新（服务端同步失效项目列表缓存）
  useEffect(() => api.openChangeStream((kind) => {
    if (kind === 'tasks' || kind === 'plans') void loadProjects();
  }), [loadProjects]);

  // T01679：展开项目下拉时按需重拉项目行（plan_done/plan_doing/plan_open 三徽标取最新）——
  // 与任务菜单 T01584 同款 800ms 节流口径（窗口内连点不重复发请求），节流窗口不各定一个数。
  // SSE 订阅只保最终一致：别的窗口刚改完计划任务时，点开下拉那一刻仍可能是旧值，「点击」变成主动拉取。
  const projCountsAtRef = useRef(0);
  const refreshProjCounts = useCallback(() => {
    const now = Date.now();
    if (now - projCountsAtRef.current < 800) return;
    projCountsAtRef.current = now;
    void loadProjects();
  }, [loadProjects]);

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
  // T02283：/aitools 接入共享失败态层（T02213 口径）。此前 `void api.get(...).then(...)` 无 catch——
  // 断供时既是 unhandled rejection，又让 aiToolId 保持空，点「AI 评估」只会把后端故障说成
  // 「请先在模型菜单配置默认 AI 工具」。
  const aiToolsView = useResource<AITool[]>(async () => {
    const list = await api.get<AITool[]>('/aitools');
    const sorted = [...list].sort(compareOrganize);
    setAiToolId(sorted[0]?.id ?? '');
    return list;
  });
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

  // T02196：按「计划行 id」定位来源节点并高亮（任务标题旁「计划/里程碑」徽标点击）。
  // 口径：只有「不看这一屏就看不到目标行」的状态才允许改变——父里程碑处于收起态时展开它；
  // 标题/列筛选、排序、视图模式一律不动（任务原文约束「不得重置用户的其他筛选或排序条件」），
  // 因此三种视图（列表/甘特/时间线）各自只要该行在 DOM 里就原地滚动定位，被筛掉时如实提示而非偷偷清筛。
  useEffect(() => {
    if (!locateNodeId) return;
    if (!projectId) { setLocateNodeId(''); return; }
    if (plans.length === 0) return; // 该项目计划尚未加载完：plans 变更后重跑本 effect
    const target = plans.find((p) => p.id === locateNodeId);
    if (!target) {
      setLocateNodeId('');
      flash('未找到对应的计划节点（可能已归档或删除）');
      return;
    }
    const parentMs = childMilestoneOf(target, plans);
    if (parentMs && collapsedMs[parentMs.id]) {
      setCollapsedMs((prev) => ({ ...prev, [parentMs.id]: false }));
      return; // 展开后重渲染，下一轮再定位
    }
    const el = document.querySelector(`[data-plan-id="${locateNodeId}"]`);
    setLocateNodeId('');
    if (!(el instanceof HTMLElement)) {
      flash('目标计划节点在当前视图中不可见（被筛选条件筛掉，或该视图未呈现无排期行）');
      return;
    }
    try { el.scrollIntoView({ block: 'center' }); } catch { /* 忽略滚动异常 */ }
    // 高亮走临时加类（动画 .locate-flash）：行 className 由 props 计算且本轮不变，
    // React 不会覆写命令式加的类（与任务页 locateTaskRow 同一口径）
    el.classList.add('locate-flash');
    globalThis.setTimeout(() => el.classList.remove('locate-flash'), 1500);
  }, [locateNodeId, plans, projectId, collapsedMs, viewMode]);

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
    if (evalBusy || planAiBatchRunning) { flash('已有批量 AI 任务在进行中，请等待其完成'); return; }
    if (!aiToolId) { flash(aiToolsView.phase === 'error' ? 'AI 工具列表加载失败，请点工具条的「重试」后再试' : '请先选择 AI 模型（AI 导入旁的模型下拉）'); return; }
    const target = targetIds ? plans.filter((p) => targetIds.includes(p.id)) : plans;
    if (target.length === 0) { flash('当前项目暂无计划条目'); return; }
    const msg = `将对 ${target.length} 条计划逐条 AI 评估（工期合理性/风险/建议），结果自动录入各条描述（可后续手动编辑或删除），确认开始？`;
    // T01620：计数在确认后才置位（原先在确认前置 0/N，取消/刷新都会留下无人清理的残计数），
    // 且收口放 finally——中途抛异常也要把 busy 归位，否则按钮永久禁用。
    void askConfirm(msg).then(async (go) => {
      if (!go) return;
      if (planAiBatchRunning) { flash('已有批量 AI 任务在进行中，请等待其完成'); return; }
      planAiBatchRunning = true;
      setEvalBusy(true);
      let done = 0;
      try {
        setEvalLabel(`0/${target.length}`);
        for (const p of target) {
          await evaluateOnePlan(p);
          done += 1;
          setEvalLabel(`${done}/${target.length}`);
        }
      } finally {
        planAiBatchRunning = false;
        setEvalBusy(false);
        setTimeout(() => setEvalLabel(''), 2500);
        flash(`AI 评估完成：${done} 条结果已写入描述`);
      }
    });
  }

  // ---------- T01058 后续：复杂度批量补算 ----------
  /**
   * 复杂度只在 PRD 导入时由 AI 给出，手工/Excel 导入与存量行恒为空，
   * 「复杂度 ≥4 建议拆分」的提示对它们不生效。此处按批（20 行/次）补算缺失评级。
   * 与「AI 评估」分开：评估改的是描述文本且逐条调用，补算只写 complexity 且批量调用。
   */
  async function backfillComplexity(force: boolean) {
    if (evalBusy || planAiBatchRunning) { flash('已有批量 AI 任务在进行中，请等待其完成'); return; }
    if (!aiToolId) { flash(aiToolsView.phase === 'error' ? 'AI 工具列表加载失败，请点工具条的「重试」后再试' : '请先选择 AI 模型（AI 导入旁的模型下拉）'); return; }
    if (!projectId) { flash('请先选择项目'); return; }
    planAiBatchRunning = true;
    setEvalBusy(true);
    setEvalLabel('补算中');
    try {
      const r = await api.post<{ scanned: number; updated: number; batches: Array<{ offset: number; size: number; updated: number; error?: string }> }>(
        '/plans/complexity/backfill',
        { toolId: aiToolId, projectId, force },
      );
      const failed = r.batches.filter((b) => b.error).length;
      if (r.scanned === 0) flash(force ? '本项目没有可补算的计划行' : '本项目计划行的复杂度均已评定（无需补算）');
      else if (r.updated === 0 && failed > 0) flash(`复杂度补算失败：${r.batches.find((b) => b.error)?.error ?? 'AI 调用失败'}`);
      else flash(`复杂度补算完成：扫描 ${r.scanned} 行，写入 ${r.updated} 行${failed > 0 ? `（${failed} 批失败，可重跑）` : ''}`);
      reload();
    } catch (e) {
      flash(String((e as Error).message ?? e));
    } finally {
      planAiBatchRunning = false;
      setEvalBusy(false);
      setEvalLabel('');
    }
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

  // M6-6.1：关键路径计算（自 renderGantt 提取，独立计复杂度）——串行依赖 DAG 上以 duration 为权重的最长链
  function computeCriticalPath(input: PlanTask[]) {
    const planById = new Map(input.map((p) => [p.id, p]));
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
    for (const p of input) longestEnd(p.id, new Set());
    const criticalEdges = new Set<string>(); // `${fromId}->${toId}`
    const criticalNodes = new Set<string>();
    for (const p of input) {
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
    return { planById, depsOfPlan, criticalEdges, criticalNodes };
  }

  // M6-6.1：月份刻度生成（自 renderGantt 提取）
  function buildMonthTicks(rangeStart: string, totalDays: number, dayMs: number, dayW: number): Array<{ label: string; left: number }> {
    const ticks: Array<{ label: string; left: number }> = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(new Date(rangeStart + 'T00:00:00').getTime() + i * dayMs);
      if (d.getDate() === 1) ticks.push({ label: `${d.getMonth() + 1}月`, left: i * dayW });
    }
    return ticks;
  }

  /** T01059 后续：开始拖动甘特条（条体=平移，左右 6px 手柄=伸缩工期）；仅左键触发 */
  function startGanttDrag(e: React.MouseEvent, p: PlanTask, mode: GanttDragMode): void {
    if (e.button !== 0 || !p.start_date || !p.end_date) return;
    e.preventDefault();
    e.stopPropagation();
    const dur = Math.max(1, p.duration_days || 1);
    const st = newGanttDrag(p.id, mode, e.clientX, p.start_date, p.end_date, dur);
    ganttDragRef.current = st;
    setGanttDrag(st);
  }

  /** T01059 后续：拖动结束落库——只发一次 PATCH，同时带上新的开始日与工期 */
  function commitGanttDrag(): void {
    const cur = ganttDragRef.current;
    ganttDragRef.current = null;
    setGanttDrag(null);
    if (!cur || !cur.moved) return;
    const p = plans.find((x) => x.id === cur.id);
    if (!p) return;
    if (cur.nextStart === p.start_date && cur.nextDur === p.duration_days) return;
    const what = cur.mode === 'move' ? '平移' : '调整工期';
    void updatePlan(p, { start_date: cur.nextStart, duration_days: cur.nextDur });
    flash(`${what}：${p.title} → ${cur.nextStart} ~ ${cur.nextEnd}（${cur.nextDur} 工作日）`);
  }

  // T01059 后续：拖动期间的全局鼠标监听。依赖只取「哪条·哪种」——每次 mousemove 都重建监听既浪费也会丢事件。
  const ganttDragKey = ganttDrag ? `${ganttDrag.id}:${ganttDrag.mode}` : '';
  useEffect(() => {
    if (!ganttDragKey) return;
    const onMove = (ev: MouseEvent): void => {
      const cur = ganttDragRef.current;
      if (!cur) return;
      const deltaDays = deltaDaysFromPx(ev.clientX - cur.startX, DAY_W);
      const next = ganttDragResult(cur.mode, cur.origStart, cur.origEnd, cur.origDur, deltaDays, workdayCtx);
      const st: GanttDragState = { ...cur, nextStart: next.start, nextEnd: next.end, nextDur: next.dur, moved: cur.moved || deltaDays !== 0 };
      ganttDragRef.current = st;
      setGanttDrag(st);
    };
    const onUp = (): void => { commitGanttDrag(); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 拖动的原点数据都在 ref 里，回调无需随预览态重建
  }, [ganttDragKey]);

  /** T01564 / T01565：时间线视图——纵向里程碑脉络，与甘特互补（非替代）。
   *  数据仍是甘特同一份 plans（plan_tasks），本视图只展示与开详情，编辑留在列表/甘特入口。
   *  编排三件事：与甘特区分的微型说明 + 粒度切换（T01565）+ 节点详情抽屉（复用 FR-3.2 SlideOver）。 */
  function renderTimeline() {
    // T01576：阶段折叠——与列表/甘特共用同一份 `plan.collapsedMs`（键=里程碑 id），
    // 故此处一键收起/展开会与列表视图互相影响，这是刻意口径（避免两套折叠记忆互不相认）。
    const tlMsIds = plans.filter((p) => p.kind === 'milestone').map((p) => p.id);
    const tlAllCollapsed = tlMsIds.length > 0 && tlMsIds.every((id) => !!collapsedMs[id]);
    const setAllTlCollapsed = (v: boolean): void => {
      setCollapsedMs(() => {
        if (!v) return {};
        const next: Record<string, boolean> = {};
        for (const id of tlMsIds) next[id] = true;
        return next;
      });
    };
    /** T01577：时间线节点 → 关联待办的一键跳转（时间线本身仍只读，跳转是本视图唯一新增交互）。
     *  先关时间线抽屉，再按 linked_task_id 定位并打开待办详情抽屉（'desc' 沿用 T01562 外部跳转子页口径）；
     *  解析不到（待办已删/归档/网络异常）给出可见提示，绝不静默。 */
    const jumpToLinked = (p: TlPlan): void => {
      setSelectedPlan(null);
      void focusTaskById(p.linked_task_id, projectId, 'desc', p.linked_task_title).then((hit) => {
        if (!hit) flash(`未找到对应待办：${p.linked_task_title || p.title}（可能已删除或归档）`);
      });
    };
    return (
      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            时间线 = 纵向里程碑脉络（阶段进展）；甘特 = 横向排期 + 依赖线 + 关键路径。两者同源同一条计划，视角互补。
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <PlanTimelineGranularityToggle granularity={tlGranularity} setGranularity={setTlGranularity} />
            <PlanTimelineSpacingToggle spacing={tlSpacing} setSpacing={setTlSpacing} />
            <PlanTimelineCollapseAll allCollapsed={tlAllCollapsed} phaseCount={tlMsIds.length} onToggle={() => setAllTlCollapsed(!tlAllCollapsed)} />
            {/* T02039（§5.1）：面板开关与三枚 toggle 同排。用文案 + 箭头字形而非 lucide 图标，
                免得为多一个图标去动 lucide 导入行（那行正被并发会话的 T01673 改动占着）。 */}
            <button
              type="button"
              className="tbtn-anim"
              onClick={() => setEstimateOpen(!estimateOpen)}
              title={estimateOpen ? '收起估算面板' : '打开估算面板（右侧停靠；窄屏转为覆盖式抽屉）'}
              style={{ fontSize: 12, padding: '3px 8px', border: `1px solid ${estimateOpen ? 'var(--accent)' : 'var(--border-strong)'}`, borderRadius: 6, background: estimateOpen ? 'var(--accent-soft)' : 'var(--card-bg)', color: estimateOpen ? 'var(--accent)' : 'var(--text)', cursor: 'pointer' }}
            >
              估算面板 {estimateOpen ? '⤡' : '⤢'}
            </button>
          </div>
        </div>
        {/* T02039：docked 分栏——左列 flex:1 + minWidth:0 让时间线自然被 420px 挤压（§10-13 走查项），
            右列 sticky 使面板在长脉络滚动时始终可见；overlay 形态复用 FR-3.2 SlideOver，不新造抽屉。 */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <PlanTimeline plans={plans} granularity={tlGranularity} spacing={tlSpacing} onSelect={(p) => setSelectedPlan(p)}
              collapsedMs={collapsedMs} onToggleMsCollapse={toggleMsCollapsed} onJumpToLinked={jumpToLinked} />
          </div>
          {estimateOpen && estimateMode === 'docked' && (
            <aside
              aria-label="估算面板"
              style={{ flex: `0 0 ${ESTIMATE_PANEL_WIDTH}px`, maxWidth: '50vw', position: 'sticky', top: 0, height: 'calc(100vh - 150px)', minHeight: 320, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}
            >
              <EstimatePanel projectId={projectId} plans={plans} collapsedMs={collapsedMs} onToggleMsCollapse={toggleMsCollapsed} onToast={flash} />
            </aside>
          )}
        </div>
        {estimateOpen && estimateMode === 'overlay' && (
          <SlideOver open title="估算面板" onClose={() => setEstimateOpen(false)} width={ESTIMATE_PANEL_WIDTH}>
            <EstimatePanel projectId={projectId} plans={plans} collapsedMs={collapsedMs} onToggleMsCollapse={toggleMsCollapsed} onToast={flash} hideHeading />
          </SlideOver>
        )}
        {selectedPlan && (
          <SlideOver open title={selectedPlan.title} onClose={() => setSelectedPlan(null)} width={420}>
            <PlanTimelineDetail plan={selectedPlan} onJump={jumpToLinked} />
          </SlideOver>
        )}
      </div>
    );
  }

  /** T01564：非列表模式的视图分派。
   *  用 if/else 而非 JSX 里的三层嵌套三元（S3358：三元不应嵌套）。 */
  function renderNonListView() {
    if (viewMode === 'timeline') return renderTimeline();
    return renderGantt();
  }

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
    // M6-6.1：关键路径计算 + 月份刻度下沉为独立辅助函数（详见 renderGantt 上方定义），本函数仅编排
    const { planById, depsOfPlan, criticalEdges, criticalNodes } = computeCriticalPath(plans);
    const monthTicks = buildMonthTicks(rangeStart, totalDays, dayMs, DAY_W);

    // M6-6.1：日历底纹（周末/节假日）单格渲染——抽离避免甘特主渲染嵌套 Array.from+if
    const renderCalShade = (di: number, weekend: boolean, hol: boolean): React.ReactNode => {
      if (!weekend && !hol) return null;
      return <div key={di} style={{ position: 'absolute', left: di * DAY_W, width: DAY_W, height: '100%', background: hol ? 'var(--danger-soft, rgba(220,38,38,.10))' : 'var(--surface-2)' }} />;
    };
    // M6-6.1：今日线（仅当 todayIdx 落在范围内）
    const renderTodayLine = (): React.ReactNode =>
      todayIdx >= 0 && todayIdx < totalDays
        ? <div style={{ position: 'absolute', left: todayIdx * DAY_W + DAY_W / 2, top: 0, bottom: 0, width: 1, background: 'var(--accent)', opacity: 0.6 }} />
        : null;
    // M6-6.1：状态色图例（T01059-FR2.3：周末/节假日/今日/四态说明）
    const renderStatusLegend = (): React.ReactNode => (
      <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 10px', borderTop: '1px solid var(--border)', display: 'flex', gap: 14 }}>
        {Object.entries(STATUS_BAR).map(([k, c]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
            {{ todo: '待开始', doing: '进行中', done: '已完成', blocked: '受阻' }[k as PlanTask['status']]}
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 1, height: 10, background: 'var(--accent)', display: 'inline-block' }} />今天</span>
        <span>灰底=周末　红底=节假日</span>
        {/* T01059 后续：拖动能力提示——甘特此前是纯只读可视化，交互入口要能被发现 */}
        <span style={{ color: 'var(--accent)' }}>拖条体=平移　拖两端=改工期</span>
      </div>
    );

    // T01059 后续：拖动实时预览气泡——显示松手后将落库的开始/结束/工期
    const renderDragBadge = (d: GanttDragState): React.ReactNode => (
      <span style={{
        position: 'absolute', left: 0, top: -14, zIndex: 6, whiteSpace: 'nowrap', fontSize: 10, lineHeight: '14px',
        padding: '0 4px', borderRadius: 3, background: 'var(--surface)', color: 'var(--accent)',
        border: '1px solid var(--border-strong)', pointerEvents: 'none',
      }}>
        {d.nextStart} ~ {d.nextEnd} · {d.nextDur} 工作日
      </span>
    );

    // T01059 后续：拖动行的预览副本（只覆盖日期字段），行渲染与依赖连线共用同一份数据
    const ganttPlans = ganttDrag
      ? plans.map((x) => (x.id === ganttDrag.id ? { ...x, start_date: ganttDrag.nextStart, end_date: ganttDrag.nextEnd } : x))
      : plans;

    return (
      <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, overflow: 'hidden' }}>
        {/* T02082：甘特估算叠加开关——独立于估算面板开关（§5.2 口径）；懒加载失败时仍可看甘特本体 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--text)' }}>
            <input type="checkbox" checked={showGanttEstimate} onChange={toggleGanttEstimate} aria-label="甘特估算区间叠加开关" />
            估算区间叠加
          </label>
          <span style={{ color: 'var(--text-muted)' }}>
            {showGanttEstimate
              ? (ganttEst ? '半透明带 = 服务端 O~P 三点区间，竖线 = 服务端期望值 E（里程碑行无估算不叠加）' : '估算数据加载中…')
              : '勾选后在甘特条上叠加服务端估算区间（不影响面板）'}
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ width: 220 + totalDays * DAY_W, minWidth: '100%' }}>
            {/* 月份刻度 */}
            <div style={{ display: 'flex', marginLeft: 220, height: 22, position: 'relative', borderBottom: '1px solid var(--border-strong)', fontSize: 11, color: 'var(--text-muted)' }}>
              {monthTicks.map((m) => (
                <span key={`${m.label}-${m.left}`} style={{ position: 'absolute', left: m.left + 4 }}>{m.label}</span>
              ))}
            </div>
            {/* 任务行（T01059-FR2.3：relative 容器 + SVG 依赖连线叠加层；T01059 后续：拖动时禁选中以免拖出蓝色选区） */}
            <div style={{ position: 'relative', userSelect: ganttDrag ? 'none' : undefined }}>
            {ganttPlans.map((p, i) => {
              if (!p.start_date || !p.end_date) return null;
              // T01059 后续：拖动中的行用预览日期渲染（松手才落库），保证拖动过程所见即所得；
              // 依赖连线层同样吃这份「预览版 plans」，避免拖动时连线停在旧位置产生跳变。
              const drag = ganttDrag && ganttDrag.id === p.id ? ganttDrag : null;
              const effStart = p.start_date;
              const effEnd = p.end_date;
              const left = toIdx(effStart) * DAY_W;
              const width = Math.max(DAY_W, (toIdx(effEnd) - toIdx(effStart) + 1) * DAY_W);
              return (
                <div key={p.id} data-plan-id={p.id} style={{ display: 'flex', alignItems: 'center', height: 30, borderBottom: '1px solid var(--surface-2)', fontSize: 12 }}>
                  <div style={{ width: 220, flexShrink: 0, padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }} title={p.title}>
                    {i + 1}. {p.title}
                  </div>
                  <div style={{ position: 'relative', height: '100%', flex: 1 }}>
                    {/* 日历底纹：周末/节假日 */}
                    {Array.from({ length: totalDays }, (_, di) => {
                      const d = new Date(new Date(rangeStart + 'T00:00:00').getTime() + di * dayMs);
                      const weekend = d.getDay() === 0 || d.getDay() === 6;
                      const hol = holSet.has(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
                      return renderCalShade(di, weekend, hol);
                    })}
                    {renderTodayLine()}
                    {/* 任务条（T01059-FR2.3：关键路径红色描边；T01059 后续：拖条体平移、拖两端改工期） */}
                    <div title={`${p.title}
${p.start_date} ~ ${p.end_date}（${p.duration_days} 工作日）· 进度 ${p.progress}% · ${p.assignee || '未分配'}${criticalNodes.has(p.id) ? ' · ★ 关键路径' : ''}
拖动条体=平移排期；拖左右两端=伸缩工期（松手保存）`}
                      onMouseDown={(e) => startGanttDrag(e, p, 'move')}
                      style={{
                        position: 'absolute', left, width, top: 5, height: 18, borderRadius: 4,
                        background: STATUS_BAR[p.status], opacity: drag ? 1 : 0.85, cursor: drag ? 'grabbing' : 'grab',
                        outline: criticalNodes.has(p.id) ? '2px solid var(--danger)' : undefined, outlineOffset: -1,
                      }}>
                      <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${p.progress}%`, height: '100%', background: 'rgba(255,255,255,.35)' }} />
                      </div>
                      {/* 左/右 resize 手柄：6px 命中区，stopPropagation 避免触发条体平移 */}
                      <span onMouseDown={(e) => startGanttDrag(e, p, 'resize-l')} title="拖动改开始日（工期随之变化）"
                        style={{ position: 'absolute', left: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize', background: 'rgba(255,255,255,.55)', borderRadius: '4px 0 0 4px' }} />
                      <span onMouseDown={(e) => startGanttDrag(e, p, 'resize-r')} title="拖动改结束日（工期随之变化）"
                        style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize', background: 'rgba(255,255,255,.55)', borderRadius: '0 4px 4px 0' }} />
                      {drag ? renderDragBadge(drag) : null}
                    </div>
                  </div>
                </div>
              );
            })}
            {/* T01059-FR2.3：deps 依赖连线 SVG 叠加层（serial 边画折线箭头；关键路径红色加粗）——M6-6.1 提取为 renderDepsOverlay */}
            <svg width={220 + totalDays * DAY_W} height={plans.length * 30} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 2 }}>
              {renderDepsOverlay({ plans: ganttPlans, toIdx, totalDays, DAY_W, depsOfPlan, planById, criticalEdges })}
            </svg>
            {/* T02082：E8 估算区间叠加层——同一 relative 容器内、依赖连线 SVG 之上（zIndex 3>2）。
                O/P 取 items 三点、E 取 summary.rowRatios 服务端期望值，此处只装配 Map 不做任何运算（§9 红线）；
                里程碑/daily 行无估算条目，经组件内非法行剔除自然不叠加（§4.6 红线一）。 */}
            {showGanttEstimate && ganttEst && (() => {
              const itByPlan = new Map(ganttEst.items.map((x) => [x.plan_id, x] as const));
              const rrByPlan = new Map(ganttEst.summary.rowRatios.map((x) => [x.key, x] as const));
              return (
                <EstimateGanttOverlay
                  rows={ganttPlans.map((p, i) => {
                    const it = itByPlan.get(p.id);
                    const rr = rrByPlan.get(p.id);
                    return {
                      id: p.id,
                      title: p.title,
                      startDate: p.start_date,
                      endDate: p.end_date,
                      rowIndex: i,
                      estimate: it && rr
                        ? { optimistic: it.optimistic, pessimistic: it.pessimistic, expected: rr.expected }
                        : undefined,
                    };
                  })}
                  rangeStart={rangeStart}
                  totalDays={totalDays}
                  visible={showGanttEstimate}
                />
              );
            })()}
            </div>
          </div>
        </div>
        {renderStatusLegend()}
      </div>
    );
  }

  /** M6-6.1：deps 依赖连线 SVG 元素构建（自甘特渲染 IIFE 提取；甘特局部量经参数传入） */
  function renderDepsOverlay(g: {
    plans: PlanTask[];
    toIdx: (d: string) => number;
    totalDays: number;
    DAY_W: number;
    depsOfPlan: (p: PlanTask) => Array<{ id?: string; type?: string }>;
    planById: Map<string, PlanTask>;
    criticalEdges: Set<string>;
  }): React.ReactNode[] {
    const rowIdx = new Map(g.plans.map((p, i) => [p.id, i] as const));
    const els: React.ReactNode[] = [];
    for (const p of g.plans) {
      if (!p.start_date || !p.end_date) continue;
      const j = rowIdx.get(p.id);
      if (j === undefined) continue;
      const tx = 220 + g.toIdx(p.start_date) * g.DAY_W;
      const ty = j * 30 + 15;
      els.push(...buildDepEdgesForPlan(g, p, rowIdx, tx, ty));
    }
    return els;
  }

  /** M6-6.1：单计划依赖边构建（自 renderDepsOverlay 内层循环提取，承载 its 复杂度） */
  function buildDepEdgesForPlan(
    g: {
      toIdx: (d: string) => number;
      DAY_W: number;
      depsOfPlan: (p: PlanTask) => Array<{ id?: string; type?: string }>;
      planById: Map<string, PlanTask>;
      criticalEdges: Set<string>;
    },
    p: PlanTask,
    rowIdx: Map<string, number>,
    tx: number,
    ty: number,
  ): React.ReactNode[] {
    const els: React.ReactNode[] = [];
    for (const d of g.depsOfPlan(p)) {
      if (!d?.id || d.type === 'child') continue;
      const u = g.planById.get(d.id);
      if (!u?.start_date || !u.end_date) continue;
      const i2 = rowIdx.get(u.id);
      if (i2 === undefined) continue;
      const fx = 220 + (g.toIdx(u.end_date) + 1) * g.DAY_W;
      const fy = i2 * 30 + 15;
      const crit = g.criticalEdges.has(`${u.id}->${p.id}`);
      els.push(...buildDepEdge(p.id, u.id, tx, ty, fx, fy, crit));
    }
    return els;
  }

  /** M6-6.1：单条依赖边（折线箭头 + 关键路径加粗描红）；依赖边密集的三元/条件抽离，降低 renderDepsOverlay 复杂度 */
  function buildDepEdge(pId: string, uId: string, tx: number, ty: number, fx: number, fy: number, crit: boolean): React.ReactNode[] {
    const color = crit ? 'var(--danger)' : 'var(--accent)';
    const dAttr = tx > fx + 8
      ? `M ${fx} ${fy} H ${(fx + tx) / 2} V ${ty} H ${tx - 5}`
      : `M ${fx} ${fy} L ${tx - 5} ${ty}`;
    return [
      <path key={`${uId}-${pId}`} d={dAttr} fill="none" stroke={color} strokeWidth={crit ? 2 : 1.2} opacity={crit ? 0.9 : 0.55} />,
      <polygon key={`arr-${uId}-${pId}`} points={`${tx - 5},${ty - 3.5} ${tx - 5},${ty + 3.5} ${tx},${ty}`} fill={color} />,
    ];
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
          onExpand={refreshProjCounts}
          projDropRef={projDropRef} sortDropRef={sortDropRef} projOpen={projOpen} setProjOpen={setProjOpen} projDropPos={projDropPos} setProjDropPos={setProjDropPos}
          projSortOpen={projSortOpen} setProjSortOpen={setProjSortOpen} projSortMode={projSortMode} setProjSortMode={setProjSortMode}
          dragProjId={dragProjId} setDragProjId={setDragProjId} overProjId={overProjId} setOverProjId={setOverProjId}
          dropReorder={dropReorder} togglePin={togglePin} isProjectPinned={isProjectPinned} />
        {/* T02201：项目取数失败/加载中在工具条显式给出原因与重试入口（此前空下拉与真无项目同形） */}
        <ProjectListHint view={projectList} />
        {/* T00506 调整：任务类型选择移入「新建计划任务」弹窗（默认普通任务），工具栏不再展示 */}
        <PlanCreateImportButtons busy={busy} createPlan={createPlan} importExcel={importExcel} exportExcel={exportExcel} exportMarkdown={exportMarkdown} downloadTemplate={downloadTemplate} />
        <PlanEvalButton batchEvaluatePlans={batchEvaluatePlans} evalBusy={evalBusy} busy={busy} evalLabel={evalLabel} plans={plans} />
        <PlanComplexityButton backfill={backfillComplexity} evalBusy={evalBusy} busy={busy} />
        <PlanMultiToggle planMulti={planMulti} setPlanMulti={setPlanMulti} setPlanSelIds={setPlanSelIds} />
        {planMulti && planSelIds.length > 0 && (
          <PlanBatchBar planSelIds={planSelIds} plans={plans} selectAllPlans={selectAllPlans}
            planBatchStatus={planBatchStatus} planBatchAttach={planBatchAttach} batchSetStatus={batchSetStatus} batchEvaluateSelected={batchEvaluateSelected}
            batchArchivePlans={batchArchivePlans} batchAttach={batchAttach} batchCreateLinkedTodos={batchCreateLinkedTodos}
            batchApplyColor={batchApplyColor} evalBusy={evalBusy} busy={busy} />
        )}
        {evalBusy && <output className="flash-toast"><span className="task-breathe" style={{ color: 'var(--accent)' }}>AI 评估中{evalLabel ? `（${evalLabel}）` : ''}…</span></output>}
        <PlanViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        <PlanPanelToggles showPrd={showPrd} setShowPrd={setShowPrd} showMatrix={showMatrix} setShowMatrix={setShowMatrix}
          showTestCases={showTestCases} setShowTestCases={setShowTestCases} />
        <button onClick={openHolidayManager} style={btnStyle} title="节假日管理 — 手动维护 / 联网导入法定节假日 / 万年历视图">节假日（{holidays.length}）</button>
        {/* T02213：节假日取数失败/过期时显式提示——它是工期换算的输入，静默为空会让天数按自然日口径算错 */}
        <ResourceHint view={holidaysView} label="节假日数据（工期换算依赖）" />
        {holidaysView.phase === 'error' && holidays.length === 0 && (
          <span data-t02213="holidays-math-warning" style={{ fontSize: 11, color: 'var(--danger)' }}>当前工期按「无节假日」口径计算</span>
        )}
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
      {/* T01486：「用例」列 chip 下钻用例视图；locateReqId 是用例侧回跳时要定位高亮的行 */}
      {showMatrix && projectId && (
        <ReqMatrixPanel projectId={projectId} onClose={() => setShowMatrix(false)}
          locateReqId={matrixLocateReqId} onLocateHandled={() => setMatrixLocateReqId('')}
          onDrillCases={(reqId) => {
            setTcFocusReqId(reqId);
            setTcDrillSeq((n) => n + 1); // 同一个需求重复下钻也要生效，靠序号而非值变更识别新意图
            setShowTestCases(true);
            // 筛选写入由面板自己的 focus effect 完成（它同时清掉孤儿/未覆盖视图等互斥态），
            // 父级只递意图，不在 PlanPage 再抢写 `tc.reqFilter`，避免同一个筛选两个写入方
          }} />
      )}

      {/* T01485：测试用例面板（矩阵之后展开，保持 PRD → 矩阵 → 用例 的自上而下动线，§4.1） */}
      {showTestCases && projectId && (
        <TestCasePanel projectId={projectId} focusReqId={tcFocusReqId} focusSeq={tcDrillSeq} onClose={() => setShowTestCases(false)}
          onLocateReq={(reqId) => {
            setShowMatrix(true);
            setMatrixLocateReqId(reqId);
            flash('已展开需求跟踪矩阵并定位该需求行');
          }} />
      )}
        {/* T02283：AI 工具列表断供时给出原因与重试入口，与上面的评估误报文案改动配对 */}
        <ResourceHint view={aiToolsView} label="AI 工具列表" />

      {/* T01564：三模式分派——timeline / gantt 走视图函数，list 仍是下方表格（原为两层嵌套三元，S3358） */}
      {viewMode === 'list' ? (
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
      ) : renderNonListView()}

      {/* T00438 AI 导入弹窗：模型选择 + 文件上传 → AI 解析草稿表格（可编辑/勾选）→ 批量保存 */}
      {/* T00442 节假日多功能弹窗：手动维护 / 联网导入法定节假日 / 万年历 */}
      {holiOpen && (
        <HolidayModal holiBusy={holiBusy} setHoliOpen={setHoliOpen} holiTab={holiTab} setHoliTab={setHoliTab}
          holiNewKind={holiNewKind} setHoliNewKind={setHoliNewKind} holiNewDate={holiNewDate} setHoliNewDate={setHoliNewDate}
          holiNewName={holiNewName} setHoliNewName={setHoliNewName} holidays={holidays}
          holidaysHint={<ResourceHint view={holidaysView} label="节假日数据（工期换算依赖）" />}
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
