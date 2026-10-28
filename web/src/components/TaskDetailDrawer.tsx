/**
 * T01562 / T01563（FR-3.2 真抽屉）：任务详情抽屉内容（完整操作台）。
 * 与现有「行内展开」并存——行内=列表内快速预览，本抽屉=完整查看 + 编辑。
 * 自包含：用底层原语（MarkdownContent / TaskEventTimeline / api.patch）与自身编辑态，
 * 不耦合 TasksPage 的逐行展开状态，降低回归风险（R2/R3）。
 * 标签页：描述 / 处理结果 / AI 摘要 / 时间线 / 关联计划 / 阻塞关系 / 自定义字段。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, imageUrl, type CustomField, type Project, type Task, type TaskFieldValuesPayload } from '../api/client';
import { GitCommitTab } from '../components/GitCommitTab'; // 八期 §3.2：任务详情抽屉「Git」页
import { MarkdownContent } from '../ui/Markdown';
import { ResultDiffPanel } from '../ui/ResultDiff'; // T01607：结果历史 diff/回滚——与行内共用同一组件
import { TaskEventTimeline } from '../components/TaskEventTimeline';
import { SlideOver } from './SlideOver';
import { Badge } from '../ui/Badge'; // PM-302 ①：徽标单源（原为抽屉私有 Badge，borderRadius/padding 与她处各异）
import { priorityBadgeLabel, priorityTone } from '../ui/priority'; // PM-302 ③：优先级文案/色调单源
import { Ban, ClipboardList, FileText, GitBranch, History, Link2, Loader2, Pencil, Save, Sparkles, Tag, X } from 'lucide-react';
import { AiUnavailableHint, aiBlocked, aiBlockedTitle, useAiReadiness } from '../ui/aiReadiness'; // T03176（D-14）：AI 不可用入口可见但禁用 + 原因/修复动作
import { FIELD_SM_BLOCK, SELECT_BLOCK } from '../ui/primitives'; // PM-302 ① 单源 ui/primitives.ts（T03231 字段表单复用同一形态）

/** T01568：标签页键对外导出——外部跳转（focusTaskByNo）按名称指定落位标签页 */
export type TaskDetailTab = 'desc' | 'result' | 'summary' | 'timeline' | 'plans' | 'git' | 'blocks' | 'fields';

/** T03229（PM-202①）：阻塞关系行（服务端 `TaskBlockerView` 的同形投影，字段名保持 snake_case 与接口一致） */
type BlockerRow = {
  id: string;
  blocked_id: string;
  blocker_id: string;
  blocker_no: string | null;
  blocker_title: string;
  blocker_status: string;
  created_at: string;
  released_at: string | null;
  released_reason: string | null;
};

/**
 * T01570：抽屉保存后向父级回报的「定点补丁」——只带本次真正改写的字段。
 * 父页据此把新值就地合并进列表与抽屉自身，行内区块即时同步，不必再靠整表重载才看到变化。
 */
export type TaskPatch = Partial<Pick<Task, 'description' | 'handle_result'>>;

const STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成' };

/** T03231（PM-203）：字段类型的中文名——抽屉里与编辑态的控件形态一一对应，不做隐式猜测 */
const FIELD_TYPE_LABEL: Record<string, string> = { text: '文本', number: '数字', date: '日期', select: '单选' };

/** T02164：摘要生成时刻按本地时区渲染成 `YYYY-MM-DD HH:mm`（库内为 ISO/UTC）。
 *  早期采纳（FR5.1）写入的摘要没有时间标注，如实显示「未标注」而不是拿 updated_at 冒充。 */
function fmtSummaryTime(iso: string): string {
  if (!iso) return '未标注';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未标注';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function TaskDetailDrawer({ task, projectId, initialTab, onClose, onChanged, projects, onBindWorkspace, onGitLinksChanged, flash }: {
  readonly task: Task;
  readonly projectId: string;
  /** T01568：外部跳转指定的默认落位标签页（缺省 desc）——抽屉按 task.id 重挂载，故仅取初始值 */
  readonly initialTab?: TaskDetailTab;
  readonly onClose: () => void;
  readonly onChanged: (patch: TaskPatch) => void;
  /** 八期 §3.2：Git 页未绑定工作空间时要给出项目上下文（WorkspaceSelect 需要项目列表） */
  readonly projects?: Project[];
  /** 绑定工作空间走父级既有通道（含服务端绝对路径校验），抽屉不另起写接口 */
  readonly onBindWorkspace?: (projectId: string, path: string) => Promise<void>;
  /** 绑定/解绑后回报父级：列表行的 gitLinks/gitLinkCount 需要跟着刷新 */
  readonly onGitLinksChanged?: () => void;
  /** 操作反馈沿用父页提示通道（抽屉无独立 toast） */
  readonly flash?: (m: string) => void;
}) {
  const [tab, setTab] = useState<TaskDetailTab>(initialTab ?? 'desc');
  const [editing, setEditing] = useState<null | 'desc' | 'result'>(null);
  const [busy, setBusy] = useState(false);
  // 本地镜像可编辑字段，避免父级刷新覆盖未保存草稿（抽屉按 task.id 作 key，切换任务即重挂载）
  const [desc, setDesc] = useState(task.description);
  const [descDraft, setDescDraft] = useState(task.description);
  const [result, setResult] = useState(task.handle_result ?? '');
  const [resultDraft, setResultDraft] = useState(task.handle_result ?? '');
  // T02164：摘要视图从「只读展示」升级为「可触发梳理」——正文/生成时间随服务端写回更新，
  // busy 与 err 支撑按钮态与失败原因回显（抽屉无全局 toast 通道，就地提示）。
  const [summary, setSummary] = useState(task.ai_summary ?? '');
  const [summaryAt, setSummaryAt] = useState(task.ai_summary_at ?? '');
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryErr, setSummaryErr] = useState('');
  // T03176（D-14）：AI 摘要依赖默认 AI 工具——不可用时按钮保留可见但禁用，并在正文区给出原因与修复动作
  const readiness = useAiReadiness();
  const aiDown = aiBlocked(readiness);
  const [plans, setPlans] = useState<Array<{ id: string; title: string; kind: string; start_date: string }>>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  // T03229（PM-202①）：阻塞关系编辑态。列表/历史两档取数共用一条通道（includeReleased 决定），
  // 失败原因就地回显（抽屉没有全局 toast 通道，与摘要的 summaryErr 同一做法）。
  const [blockers, setBlockers] = useState<BlockerRow[]>([]);
  const [blockersLoading, setBlockersLoading] = useState(false);
  const [showReleased, setShowReleased] = useState(false);
  const [blockPickId, setBlockPickId] = useState('');
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockErr, setBlockErr] = useState('');
  const [pickCandidates, setPickCandidates] = useState<Task[]>([]);
  // T03231（PM-203①②）：自定义字段——进入标签页才取数（字段定义 + 当前值一次给全），
  // 保存走 PUT 整体提交；错误就地回显，与阻塞关系的 blockErr 同一做法。
  const [fields, setFields] = useState<CustomField[]>([]);
  const [fieldVals, setFieldVals] = useState<Record<string, string>>({});
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldBusy, setFieldBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState('');
  const [fieldSaved, setFieldSaved] = useState(false);
  const [previewId, setPreviewId] = useState(''); // T01563：附件放大预览（点同图收起）

  // T01568：同一任务被再次跳转（如重复点同一条通知）时组件不重挂载，initialTab 变化仍需把视图切回约定标签页；
  // 用户手动切页后 initialTab 未变，故不会被反复拽回——只在「外部指定的落位发生变化」时生效。
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  // T01570：两套查看态互通（行内 → 抽屉方向）——行内编辑保存 / MCP 回传经列表刷新把新快照带进来后，
  // 非编辑态跟随 props 更新展示镜像；正处于编辑态（有未保存草稿）时不打断，避免吞掉用户正在敲的字。
  // 抽屉不再因 props 变化重挂载（key=task.id 稳定），故必须显式同步，否则关抽屉重开前一直是旧文本。
  useEffect(() => {
    if (editing === 'desc') return;
    setDesc(task.description);
    setDescDraft(task.description);
  }, [task.description, editing]);
  useEffect(() => {
    if (editing === 'result') return;
    const next = task.handle_result ?? '';
    setResult(next);
    setResultDraft(next);
  }, [task.handle_result, editing]);

  // T02164：摘要没有草稿态（点了就是落库），故父级快照变化即跟随——
  // 生成成功后本地下过同一值，重复赋值不产生额外渲染；列表随后刷新也只是同文覆盖。
  useEffect(() => {
    setSummary(task.ai_summary ?? '');
    setSummaryAt(task.ai_summary_at ?? '');
  }, [task.ai_summary, task.ai_summary_at]);

  useEffect(() => {
    if (tab !== 'plans') return;
    setPlansLoading(true);
    api.get<Array<{ id: string; title: string; kind: string; start_date: string; linked_task_id: string | null }>>(`/plans?projectId=${projectId}`)
      .then((ps) => setPlans(ps.filter((p) => p.linked_task_id === task.id).map((p) => ({ id: p.id, title: p.title, kind: p.kind, start_date: p.start_date }))))
      .catch(() => setPlans([]))
      .finally(() => setPlansLoading(false));
  }, [tab, projectId, task.id]);

  // T03229（PM-202①）：阻塞关系取数——只在进入该标签页时拉，切「含历史」档重拉一次
  const reloadBlockers = useCallback(() => {
    setBlockersLoading(true);
    return api.get<BlockerRow[]>(`/tasks/${task.id}/blocked-by${showReleased ? '?includeReleased=1' : ''}`)
      .then((rows) => { setBlockers(rows); setBlockErr(''); })
      .catch((e: unknown) => { setBlockers([]); setBlockErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => setBlockersLoading(false));
  }, [task.id, showReleased]);

  useEffect(() => {
    if (tab !== 'blocks') return;
    void reloadBlockers();
  }, [tab, reloadBlockers]);

  // T03231：自定义字段取数——与阻塞关系同一节奏（只在进入该标签页时拉），避免每开一次抽屉都多两个请求
  useEffect(() => {
    if (tab !== 'fields') return;
    setFieldsLoading(true);
    setFieldSaved(false);
    api.get<TaskFieldValuesPayload>(`/tasks/${task.id}/field-values`)
      .then((p) => { setFields(p.fields); setFieldVals(p.values); setFieldErr(''); })
      .catch((e: unknown) => { setFields([]); setFieldVals({}); setFieldErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => setFieldsLoading(false));
  }, [tab, task.id]);

  /** T03231：保存字段值——服务端整批校验（类型/选项归属/字段仍属本项目），前端只回显被拒原因 */
  async function saveFieldValues() {
    if (fieldBusy) return;
    setFieldBusy(true);
    setFieldErr('');
    try {
      const p = await api.put<TaskFieldValuesPayload>(`/tasks/${task.id}/field-values`, { values: fieldVals });
      setFields(p.fields);
      setFieldVals(p.values);
      setFieldSaved(true);
    } catch (e) {
      setFieldErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFieldBusy(false);
    }
  }

  // 候选池：同项目的待办任务（已完成/已归档/搁置的不进候选——服务端在写入口也会拒，
  // 但把选择器与拒收口径对齐，用户不会先选后碰壁）。自身排除在外。
  useEffect(() => {
    if (tab !== 'blocks') return;
    api.get<Task[]>(`/tasks?projectId=${projectId}&status=todo&limit=500`)
      .then((ts) => setPickCandidates(ts.filter((x) => x.id !== task.id)))
      .catch(() => setPickCandidates([]));
  }, [tab, projectId, task.id]);

  /** T03229①：添加阻塞——成功后原地重拉（徽标数与列表由 SSE 刷新，本抽屉只需关系表本身） */
  async function addBlocker() {
    if (!blockPickId || blockBusy) return;
    setBlockBusy(true);
    try {
      await api.post(`/tasks/${task.id}/blocked-by`, { blockerId: blockPickId });
      setBlockPickId('');
      await reloadBlockers();
    } catch (e) {
      setBlockErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBlockBusy(false);
    }
  }

  /** T03229①：解除阻塞——服务端封口不删行，故「含历史」档下这条记录仍在，只是带上解除时间与原因 */
  async function removeBlocker(blockerId: string) {
    if (blockBusy) return;
    setBlockBusy(true);
    try {
      await api.del(`/tasks/${task.id}/blocked-by/${blockerId}`);
      await reloadBlockers();
    } catch (e) {
      setBlockErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBlockBusy(false);
    }
  }

  async function save(kind: 'desc' | 'result') {
    setBusy(true);
    try {
      // T01570：回报本次改写的字段（定点补丁），父页据此即时同步行内对应区块
      let patch: TaskPatch;
      if (kind === 'desc') {
        await api.patch(`/tasks/${task.id}`, { description: descDraft });
        setDesc(descDraft);
        patch = { description: descDraft };
      } else {
        await api.patch(`/tasks/${task.id}`, { handleResult: resultDraft });
        setResult(resultDraft);
        patch = { handle_result: resultDraft };
      }
      onChanged(patch);
      setEditing(null);
    } finally {
      setBusy(false);
    }
  }

  /** T02164：按任务全量信息生成总结摘要（服务端落库 ai_summary + 生成时刻后回传整行）。
   *  失败只回显原因、不动已有摘要——旧摘要仍是用户能看到的最新有效内容。 */
  async function generateSummary() {
    if (summaryBusy) return;
    setSummaryBusy(true);
    setSummaryErr('');
    try {
      const next = await api.post<Task>(`/tasks/${task.id}/ai-summary`, {});
      setSummary(next.ai_summary ?? '');
      setSummaryAt(next.ai_summary_at ?? '');
    } catch (e) {
      setSummaryErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSummaryBusy(false);
    }
  }

  const tabs: Array<{ key: TaskDetailTab; label: string; icon: React.ReactNode }> = [
    { key: 'desc', label: '描述', icon: <FileText size={13} /> },
    { key: 'result', label: '处理结果', icon: <ClipboardList size={13} /> },
    { key: 'summary', label: 'AI 摘要', icon: <Sparkles size={13} /> },
    { key: 'timeline', label: '时间线', icon: <History size={13} /> },
    { key: 'plans', label: '关联计划', icon: <Link2 size={13} /> },
    { key: 'git', label: 'Git', icon: <GitBranch size={13} /> },
    { key: 'blocks', label: '阻塞关系', icon: <Ban size={13} /> },
    { key: 'fields', label: '自定义字段', icon: <Tag size={13} /> },
  ];

  // 各标签页正文抽成局部函数，render 体仅留 `{tab === 'x' && renderX()}` 一层判断：
  // 把成串的嵌套三元/逻辑与移入各自函数（S3776 认知复杂度、S3358 嵌套三元），渲染结果逐字不变。
  function renderDescTab() {
    return (
      <div>
        {editing === 'desc' ? (
          <div>
            <textarea
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              rows={10}
              aria-label="编辑任务描述"
              style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setDescDraft(desc); setEditing(null); }} disabled={busy} className="tbtn-anim" style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
                <X size={12} style={{ verticalAlign: '-2px' }} /> 取消
              </button>
              <button onClick={() => void save('desc')} disabled={busy} className="tbtn-anim" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)' }}>
                {busy ? '保存中…' : <><Save size={12} /> 保存</>}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {desc ? <MarkdownContent content={desc} /> : <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>（无描述）</div>}
            <button onClick={() => { setDescDraft(desc); setEditing('desc'); }} className="tbtn-anim" style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
              <Pencil size={12} /> 编辑描述
            </button>
          </div>
        )}
        {task.images.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 4 }}>附件（{task.images.length}）</div>
            {/* T01563：缩略图点击放大——沿用列表内 previewId  toggle 范式（点同图收起），大图仍附复制无关的纯预览 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {task.images.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setPreviewId(previewId === img.id ? '' : img.id)}
                  title="放大预览 — 点击放大或收起截图"
                  aria-label={previewId === img.id ? '收起截图：点击收起放大预览' : '任务截图：点击放大预览'}
                  // 放大态必须把按钮自身撑满一行：它在外层 display:flex 容器里是 flex 项（基准宽度=内容宽），
                  // 而 img 的 width:'100%' 相对的是这个不确定的父宽 → 百分比失效、退回原始尺寸（实测 8px 图放大后仅 16px）。
                  style={{ padding: 0, background: 'none', border: 'none', cursor: 'pointer', display: 'block', lineHeight: 0, ...(previewId === img.id ? { width: '100%' } : {}) }}
                >
                  <img
                    src={imageUrl(img.id)}
                    alt="任务截图"
                    style={{
                      // 放大态按宽度铺满抽屉、高度自适应（height:'100%' 在 auto 高度父级下会退回原始尺寸，小图放大无效）
                      ...(previewId === img.id
                        ? { width: '100%', height: 'auto', maxWidth: '100%', objectFit: 'contain' as const }
                        : { height: 84, width: 'auto', maxWidth: '100%', objectFit: 'contain' as const }),
                      borderRadius: 8,
                      border: previewId === img.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                      display: 'block',
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderResultTab() {
    return (
      <div>
        {editing === 'result' ? (
          <div>
            <textarea
              value={resultDraft}
              onChange={(e) => setResultDraft(e.target.value)}
              rows={10}
              aria-label="编辑处理结果"
              style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setResultDraft(result); setEditing(null); }} disabled={busy} className="tbtn-anim" style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
                <X size={12} style={{ verticalAlign: '-2px' }} /> 取消
              </button>
              <button onClick={() => void save('result')} disabled={busy} className="tbtn-anim" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)' }}>
                {busy ? '保存中…' : <><Save size={12} /> 保存</>}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {result ? <MarkdownContent content={result} /> : <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>（暂无处理结果，AI 分析结论将回写于此）</div>}
            <button onClick={() => { setResultDraft(result); setEditing('result'); }} className="tbtn-anim" style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
              <Pencil size={12} /> 编辑 / 回传结果
            </button>
            {/* T01607：结果历史 diff/回滚——与行内区块同一组件、同一数据源（task_result_history）。
                回滚成功走 T01570 定点补丁通道：抽屉正文与行内结果区同时回到旧文本，无需收起抽屉回列表。
                渲染条件只看 task_no 不看正文：回滚到「空正文」那一版时面板必须仍在，否则失去再滚回来的入口
                （无留档时组件自身返回 null，不会多出空框）。 */}
            {task.task_no && (
              <ResultDiffPanel
                taskNo={task.task_no}
                current={result}
                indent={0}
                onRollback={(next) => {
                  // 回滚后旧正文进了历史、当前文本被替换：先就地同步两端，再由父页计数触发面板重拉
                  const text = typeof next === 'string' ? next : result;
                  setResult(text);
                  setResultDraft(text);
                  onChanged({ handle_result: text });
                }}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // 关联计划正文：早返回代替 `加载 → 有数据 → 空态` 的嵌套三元（S3358），外层 `<div>` 保留在调用处以维持 DOM 结构。
  function renderPlansBody() {
    if (plansLoading) {
      return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>加载关联计划…</div>;
    }
    if (plans.length === 0) {
      return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>（该任务未关联任何计划）</div>;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {plans.map((p) => (
          <div key={p.id} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 'var(--fs-m)' }}>
            <div style={{ fontWeight: 600 }}>{p.title}</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
              {p.kind === 'milestone' ? '阶段里程碑' : '计划任务'} · {p.start_date || '未排期'}
            </div>
          </div>
        ))}
      </div>
    );
  }

  /**
   * T03229（PM-202①②）：阻塞关系正文——在途列表 + 添加/解除 + 「含已解除」历史档。
   * 添加与解除都走服务端写入口校验（同项目 / 非自身 / 阻塞方未完成未归档 / 在途唯一），
   * 这里只负责把被拒的原因原样回显，不在前端重复一套判定。
   */
  function renderBlocksTab() {
    const open = blockers.filter((b) => !b.released_at);
    const released = blockers.filter((b) => b.released_at);
    const taken = new Set(open.map((b) => b.blocker_id));
    const options = pickCandidates.filter((c) => !taken.has(c.id));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div data-t03229="block-add" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            aria-label="选择阻塞方任务"
            value={blockPickId}
            onChange={(e) => setBlockPickId(e.target.value)}
            disabled={blockBusy || options.length === 0}
            style={{ flex: '1 1 180px', minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
            <option value="">{options.length === 0 ? '（本项目的待办都不可选）' : '（选择阻塞方任务）'}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>{c.task_no ? `${c.task_no} · ` : ''}{c.title}</option>
            ))}
          </select>
          <button type="button" onClick={() => { void addBlocker(); }} disabled={!blockPickId || blockBusy}
            aria-label="添加阻塞" title="把选中的待办设为本任务的阻塞方"
            style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 'var(--fs-s)', cursor: blockBusy || !blockPickId ? 'default' : 'pointer', opacity: !blockPickId || blockBusy ? 0.55 : 1 }}>
            添加阻塞
          </button>
          <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={showReleased} onChange={(e) => setShowReleased(e.target.checked)} />
            含已解除
          </label>
        </div>
        {blockErr && (
          <div data-t03229="block-err" style={{ color: 'var(--danger)', fontSize: 'var(--fs-xs)' }}>{blockErr}</div>
        )}
        {blockersLoading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>加载阻塞关系…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div data-t03229="block-count" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>在途阻塞：{open.length} 条</div>
            {open.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>（该任务当前未被任何任务阻塞）</div>
            )}
            {open.map((b) => (
              <div key={b.id} data-t03229="block-row" style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 'var(--fs-m)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.blocker_no ? `${b.blocker_no} · ` : ''}{b.blocker_title}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                    建立于 {b.created_at.slice(0, 16).replace('T', ' ')} · 阻塞方状态：{STATUS_LABEL[b.blocker_status] ?? b.blocker_status}
                  </div>
                </div>
                <button type="button" onClick={() => { void removeBlocker(b.blocker_id); }} disabled={blockBusy}
                  aria-label={`解除阻塞：${b.blocker_no ?? b.blocker_title}`} title="解除这条阻塞关系（历史记录保留）"
                  style={{ flexShrink: 0, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-xs)', cursor: blockBusy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                  解除
                </button>
              </div>
            ))}
            {showReleased && released.map((b) => (
              <div key={b.id} data-t03229="block-released" style={{ padding: '8px 10px', border: '1px dashed var(--border)', borderRadius: 8, fontSize: 'var(--fs-m)', opacity: 0.75 }}>
                <div style={{ fontWeight: 600 }}>
                  {b.blocker_no ? `${b.blocker_no} · ` : ''}{b.blocker_title}
                  <span style={{ marginLeft: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>已解除</span>
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                  解除于 {b.released_at ? b.released_at.slice(0, 16).replace('T', ' ') : ''} · 原因：{b.released_reason || '未标注'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /**
   * T03231（PM-203①②）：自定义字段正文——每个字段一个原生控件（文本/数字/日期/单选），
   * 控件外面包 <label> 让读屏拿到字段名（与看板复选框同一套可访问名口径）；
   * 已归档的选项不出现在候选里，但当前值若指向它仍按原 label 显示（不静默清空用户数据）。
   */
  function renderFieldsTab() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {fieldErr && <div data-t03231="fields-err" style={{ color: 'var(--danger)', fontSize: 'var(--fs-xs)' }}>{fieldErr}</div>}
        {fieldsLoading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>加载自定义字段…</div>
        ) : fields.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>（该项目还没有自定义字段——可在「设置 → 自定义字段」创建）</div>
        ) : (
          <>
            {fields.map((f) => {
              const v = fieldVals[f.id] ?? '';
              const staleOption = f.type === 'select' && v && !f.options.some((o) => o.id === v && !o.archived)
                ? f.options.find((o) => o.id === v) : undefined;
              return (
                <label key={f.id} data-t03231="field-row" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
                    {f.name}<span style={{ color: 'var(--text-muted)' }}>（{FIELD_TYPE_LABEL[f.type] ?? f.type}）</span>
                  </span>
                  {f.type === 'select' ? (
                    <select aria-label={`字段 ${f.name}`} value={v} disabled={fieldBusy}
                      onChange={(e) => { setFieldVals((prev) => ({ ...prev, [f.id]: e.target.value })); setFieldSaved(false); }}
                      style={SELECT_BLOCK}>
                      <option value="">（未填）</option>
                      {f.options.filter((o) => !o.archived).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      {staleOption && <option value={staleOption.id} disabled>{staleOption.label}（已停用）</option>}
                    </select>
                  ) : (
                    <input
                      aria-label={`字段 ${f.name}`}
                      type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                      step={f.type === 'number' ? 'any' : undefined}
                      value={v}
                      disabled={fieldBusy}
                      onChange={(e) => { setFieldVals((prev) => ({ ...prev, [f.id]: e.target.value })); setFieldSaved(false); }}
                      style={FIELD_SM_BLOCK}
                    />
                  )}
                </label>
              );
            })}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" data-t03231="field-save" onClick={() => { void saveFieldValues(); }} disabled={fieldBusy}
                aria-label="保存自定义字段值" title="保存本任务的自定义字段值（留空=清除该项）"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)', cursor: fieldBusy ? 'default' : 'pointer' }}>
                {fieldBusy ? <Loader2 size={12} className="aispin" /> : <Save size={12} />} 保存字段值
              </button>
              {fieldSaved && <span role="status" style={{ fontSize: 'var(--fs-xs)', color: 'var(--success)' }}>已保存</span>}
            </div>
          </>
        )}
      </div>
    );
  }

  // T02164：AI 摘要视图正文——顶部操作栏固定「更新时间 + 生成总结摘要」（约束 1 要求的入口位置），
  // 下面是摘要正文或空态引导。时间取服务端记录的真实生成时刻，而非模型输出：模型无从知道此刻几点。
  function renderSummaryTab() {
    // 定宽 ISO 串字典序即时间序，直接比出「摘要后又改了任务」
    const stale = summary.length > 0 && summaryAt.length > 0 && task.updated_at > summaryAt;
    const actionLabel = summary ? '重新生成总结摘要' : '生成总结摘要';
    const emptyHint = '（暂无摘要——点击下方按钮，按该任务的全部信息生成全面总结）';
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            更新时间：{fmtSummaryTime(summaryAt)}
            {stale && <span style={{ color: 'var(--warn)', marginLeft: 6 }}>· 摘要生成后任务又有更新，建议重新生成</span>}
          </span>
          <button
            onClick={() => { void generateSummary(); }}
            disabled={summaryBusy || aiDown}
            aria-label={actionLabel}
            title={aiBlockedTitle(readiness, '调用 AI 汇总该任务的描述、处理结果、关联计划/需求与时间线，生成全面总结并标注更新时间')}
            className="tbtn-anim"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6,
              cursor: summaryBusy ? 'default' : 'pointer', border: 'none',
              background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)', opacity: summaryBusy ? 0.7 : 1,
            }}
          >
            {summaryBusy && <Loader2 size={12} className="aispin" />}
            {summaryBusy ? '生成中…' : <><Sparkles size={12} /> {actionLabel}</>}
          </button>
        </div>
        {aiDown && readiness && <AiUnavailableHint r={readiness} compact style={{ marginBottom: 10 }} />}
        {summaryErr && (
          <div style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 6, padding: '6px 8px', marginBottom: 10 }}>
            生成失败：{summaryErr}
          </div>
        )}
        {summary ? <MarkdownContent content={summary} /> : <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>{emptyHint}</div>}
      </div>
    );
  }

  return (
    <SlideOver open title={task.title} onClose={onClose} width={480}>
      {/* 头部徽标 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <Badge tone={task.status === 'done' ? 'success' : 'accent'}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
        <Badge tone={priorityTone(task.priority)}>{priorityBadgeLabel(task.priority)}</Badge>
        {task.verified && <Badge tone="success">已验证</Badge>}
        {task.pinned && <Badge tone="accent">📌 置顶</Badge>}
        {task.task_no && <Badge>{task.task_no}</Badge>}
      </div>

      {/* 标签页 */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 12, flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            aria-label={t.label}
            className="tbtn-anim"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 9px', fontSize: 'var(--fs-s)', cursor: 'pointer',
              border: 'none', borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent', color: tab === t.key ? 'var(--accent)' : 'var(--text)', fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* 描述 */}
      {tab === 'desc' && renderDescTab()}

      {/* 处理结果 */}
      {tab === 'result' && renderResultTab()}

      {/* AI 摘要 */}
      {tab === 'summary' && renderSummaryTab()}

      {/* 时间线 */}
      {tab === 'timeline' && <TaskEventTimeline taskId={task.id} />}

      {/* 自定义字段（T03231 / PM-203） */}
      {tab === 'fields' && renderFieldsTab()}

      {/* 关联计划 */}
      {tab === 'plans' && (
        <div>
          {renderPlansBody()}
        </div>
      )}

      {/* 八期 §3.2：Git 提交信息（实时查询 + 懒加载文件清单 + 手动绑定/解绑 + 子任务区） */}
      {tab === 'git' && (
        <GitCommitTab
          task={task}
          projectId={projectId}
          projects={projects ?? []}
          onBindChange={() => onGitLinksChanged?.()}
          onBindWorkspace={onBindWorkspace ? (path) => onBindWorkspace(projectId, path) : undefined}
          flash={(m) => flash?.(m)}
        />
      )}

      {/* T03229（PM-202①）：阻塞关系 */}
      {tab === 'blocks' && renderBlocksTab()}
    </SlideOver>
  );
}
