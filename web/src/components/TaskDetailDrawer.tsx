/**
 * T01562 / T01563（FR-3.2 真抽屉）：任务详情抽屉内容（完整操作台）。
 * 与现有「行内展开」并存——行内=列表内快速预览，本抽屉=完整查看 + 编辑。
 * 自包含：用底层原语（MarkdownContent / TaskEventTimeline / api.patch）与自身编辑态，
 * 不耦合 TasksPage 的逐行展开状态，降低回归风险（R2/R3）。
 * 标签页：描述 / 处理结果 / AI 摘要 / 时间线 / 关联计划。
 */
import { useEffect, useState } from 'react';
import { api, imageUrl, type Task } from '../api/client';
import { MarkdownContent } from '../ui/Markdown';
import { ResultDiffPanel } from '../ui/ResultDiff'; // T01607：结果历史 diff/回滚——与行内共用同一组件
import { TaskEventTimeline } from '../components/TaskEventTimeline';
import { SlideOver } from './SlideOver';
import { FilePreviewDrawer } from './FilePreviewDrawer'; // T02389：正文文件超链接在嵌套抽屉中预览
import { ClipboardList, FileText, History, Link2, Loader2, Pencil, Save, Sparkles, X } from 'lucide-react';

/** T01568：标签页键对外导出——外部跳转（focusTaskByNo）按名称指定落位标签页 */
export type TaskDetailTab = 'desc' | 'result' | 'summary' | 'timeline' | 'plans';

/**
 * T01570：抽屉保存后向父级回报的「定点补丁」——只带本次真正改写的字段。
 * 父页据此把新值就地合并进列表与抽屉自身，行内区块即时同步，不必再靠整表重载才看到变化。
 */
export type TaskPatch = Partial<Pick<Task, 'description' | 'handle_result'>>;

const PRIO_LABEL: Record<string, string> = { urgent: '紧急', high: '高', normal: '普通', low: '低' };
const STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成' };

function Badge({ children, color }: { readonly children: React.ReactNode; readonly color?: string }) {
  return (
    <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, border: '1px solid var(--border-strong)', color: color ?? 'var(--text-muted)', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

/** T02164：摘要生成时刻按本地时区渲染成 `YYYY-MM-DD HH:mm`（库内为 ISO/UTC）。
 *  早期采纳（FR5.1）写入的摘要没有时间标注，如实显示「未标注」而不是拿 updated_at 冒充。 */
function fmtSummaryTime(iso: string): string {
  if (!iso) return '未标注';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未标注';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function TaskDetailDrawer({ task, projectId, initialTab, onClose, onChanged }: {
  readonly task: Task;
  readonly projectId: string;
  /** T01568：外部跳转指定的默认落位标签页（缺省 desc）——抽屉按 task.id 重挂载，故仅取初始值 */
  readonly initialTab?: TaskDetailTab;
  readonly onClose: () => void;
  readonly onChanged: (patch: TaskPatch) => void;
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
  const [plans, setPlans] = useState<Array<{ id: string; title: string; kind: string; start_date: string }>>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [previewId, setPreviewId] = useState(''); // T01563：附件放大预览（点同图收起）
  // T02389：正文文件链接 → 嵌套文件预览抽屉（同一时刻仅一个文件；再次点击替换）
  const [filePreview, setFilePreview] = useState('');

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
              style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 13, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setDescDraft(desc); setEditing(null); }} disabled={busy} className="tbtn-anim" style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>
                <X size={12} style={{ verticalAlign: '-2px' }} /> 取消
              </button>
              <button onClick={() => void save('desc')} disabled={busy} className="tbtn-anim" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12 }}>
                {busy ? '保存中…' : <><Save size={12} /> 保存</>}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {desc ? <MarkdownContent content={desc} onFileClick={setFilePreview} /> : <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>（无描述）</div>}
            <button onClick={() => { setDescDraft(desc); setEditing('desc'); }} className="tbtn-anim" style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>
              <Pencil size={12} /> 编辑描述
            </button>
          </div>
        )}
        {task.images.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>附件（{task.images.length}）</div>
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
              style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 13, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setResultDraft(result); setEditing(null); }} disabled={busy} className="tbtn-anim" style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>
                <X size={12} style={{ verticalAlign: '-2px' }} /> 取消
              </button>
              <button onClick={() => void save('result')} disabled={busy} className="tbtn-anim" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12 }}>
                {busy ? '保存中…' : <><Save size={12} /> 保存</>}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {result ? <MarkdownContent content={result} onFileClick={setFilePreview} /> : <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>（暂无处理结果，AI 分析结论将回写于此）</div>}
            <button onClick={() => { setResultDraft(result); setEditing('result'); }} className="tbtn-anim" style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>
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
      return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>加载关联计划…</div>;
    }
    if (plans.length === 0) {
      return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>（该任务未关联任何计划）</div>;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {plans.map((p) => (
          <div key={p.id} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}>
            <div style={{ fontWeight: 600 }}>{p.title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {p.kind === 'milestone' ? '阶段里程碑' : '计划任务'} · {p.start_date || '未排期'}
            </div>
          </div>
        ))}
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
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            更新时间：{fmtSummaryTime(summaryAt)}
            {stale && <span style={{ color: 'var(--warn)', marginLeft: 6 }}>· 摘要生成后任务又有更新，建议重新生成</span>}
          </span>
          <button
            onClick={() => { void generateSummary(); }}
            disabled={summaryBusy}
            aria-label={actionLabel}
            title="调用 AI 汇总该任务的描述、处理结果、关联计划/需求与时间线，生成全面总结并标注更新时间"
            className="tbtn-anim"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6,
              cursor: summaryBusy ? 'default' : 'pointer', border: 'none',
              background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12, opacity: summaryBusy ? 0.7 : 1,
            }}
          >
            {summaryBusy && <Loader2 size={12} className="aispin" />}
            {summaryBusy ? '生成中…' : <><Sparkles size={12} /> {actionLabel}</>}
          </button>
        </div>
        {summaryErr && (
          <div style={{ fontSize: 12, color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 6, padding: '6px 8px', marginBottom: 10 }}>
            生成失败：{summaryErr}
          </div>
        )}
        {summary ? <MarkdownContent content={summary} onFileClick={setFilePreview} /> : <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{emptyHint}</div>}
      </div>
    );
  }

  return (
    <>
    <SlideOver open title={task.title} onClose={onClose} width={480}>
      {/* 头部徽标 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <Badge color={task.status === 'done' ? 'var(--success)' : 'var(--accent)'}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
        <Badge>{PRIO_LABEL[task.priority] ?? task.priority}</Badge>
        {task.verified && <Badge color="var(--success)">已验证</Badge>}
        {task.pinned && <Badge color="var(--accent)">📌 置顶</Badge>}
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
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 9px', fontSize: 12, cursor: 'pointer',
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

      {/* 关联计划 */}
      {tab === 'plans' && (
        <div>
          {renderPlansBody()}
        </div>
      )}
    </SlideOver>
    <FilePreviewDrawer
      open={filePreview !== ''}
      projectId={projectId}
      path={filePreview}
      onClose={() => setFilePreview('')}
    />
    </>
  );
}
