import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AITool } from '../api/client';
import { MarkdownContent } from '../ui/Markdown';
import { useSessionState } from '../ui/session';
import { Terminal, Sparkles, Plus, X, Loader2, CheckCircle2, AlertTriangle, RotateCw, RefreshCw, FileText, Download, Eye, ChevronDown } from 'lucide-react';

const CATEGORIES = [
  { key: 'summary', label: '周期要点汇总' },
  { key: 'risk', label: '风险与阻塞分析' },
  { key: 'suggestion', label: '改进建议与优先级' },
  { key: 'lessons', label: '经验教训提炼' },
  { key: 'generalize', label: '提炼通用需求' },
  { key: 'custom', label: '自定义提问…' },
] as const;

/** 周期 key → 中文名：与左侧报表周期（日报/周报/月报）一一对应，供预设提示词与选项文案引用 */
const PERIOD_LABEL: Record<string, string> = { day: '日报', week: '周报', month: '月报' };

/** 报表周期取值集合（与左侧日报/周报/月报及 PERIOD_LABEL 一一对应） */
type ReportPeriod = 'day' | 'week' | 'month';

/**
 * 分析类别预设提示词（改为按所选报表周期动态拼装，使分析内容与周期强关联）：
 * 结论以 {pl}(日报/周报/月报) 为落点，小结在提示词中标注所依据周期，避免「周报」「月报」互串。
 */
function presetPrompt(key: (typeof CATEGORIES)[number]['key'], periodLabel = '周期'): string {
  switch (key) {
    case 'summary': return `请根据当前任务信息，汇总本周期各项目的进展概况、完成情况与重点待办，输出为一则清晰的${periodLabel}要点（Markdown）。`;
    case 'risk': return `请基于当前任务信息（${periodLabel}），分析可能存在的风险、阻塞与积压问题，并按严重程度排序，给出简短说明（Markdown）。`;
    case 'suggestion': return `请基于当前任务信息（${periodLabel}），给出下一个周期的改进建议、优先级安排与资源投入建议（Markdown）。`;
    case 'lessons': return `请基于当前任务的「处理结果」与 AI 摘要（${periodLabel}），提炼本周期可复用的经验教训：按问题类型归纳根因与解法、识别成功实践与踩坑点，输出为准 QA/经验教训知识文档（Markdown，含「经验」「教训」「可复用方法」分节）。`;
    case 'generalize': return `请筛选当前${periodLabel}任务中属于「优化/改进」类型的任务（尤其含处理结果或 AI 摘要的），提炼其诉求与方案为不绑定具体项目的通用需求：归纳共性、剥离项目特有细节，识别具备跨项目复用价值的优秀功能与优化点，输出为通用需求清单（Markdown，含「需求标题」「适用场景」「实现要点」「复用价值」）。`;
    default: return '';
  }
}

interface AnalysisTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly category: (typeof CATEGORIES)[number]['key'];
  /** 发起时捕获的周期：周期类预设据此让后端注入该周期的真实数据（自定义问答不附加以保持纯对话） */
  readonly period?: ReportPeriod;
  status: 'busy' | 'done' | 'error';
  answer: string;
  error: string;
}

/** 内置「AI 周报」tab 固定 id：始终存在，内容由父级传入的 SSE 流式状态驱动 */
const REPORT_TAB = '__report__';

/**
 * 自定义 AI 工具选择器：收拢时仅显示已选工具的「模型名」（节省单行空间），
 * 展开下拉列表时展示每个工具的完整信息「名称（类型）· 模型名」。
 * 原生 <select> 选中值与下拉项文案共用同一文本，无法两态区分，故自绘。
 */
function ToolSelect({
  tools,
  toolId,
  onChange,
}: {
  readonly tools: AITool[];
  readonly toolId: string;
  readonly onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = tools.find((t) => t.id === toolId) ?? null;

  // 收拢态文案与完整提示：先判断是否配置了可用工具，再区分是否已选中，避免用嵌套三元表达三重分支
  let modelLabel = '选择工具';
  let fullTitle = '选择 AI 工具';
  if (tools.length === 0) {
    modelLabel = '未配置工具';
    fullTitle = '未配置可用工具';
  } else if (selected) {
    modelLabel = selected.model ?? '';
    fullTitle = `${selected.name}（${selected.type}）· ${selected.model ?? ''}`;
  }

  // 展开时点击外部关闭（文档级事件委托 + 容器包含性判断）
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: '0 1 150px', minWidth: 120 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={fullTitle}
        aria-label={selected ? `AI 工具：${selected.name}（${selected.type}）· ${selected.model}` : 'AI 工具：选择用于分析的工具'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 8px', width: '100%',
          border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, cursor: 'pointer',
          background: 'var(--card-bg)', color: 'var(--text)',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
          {selected ? selected.model : modelLabel}
        </span>
        <ChevronDown size={12} style={{ flex: '0 0 auto' }} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 30,
            background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.12)', minWidth: 230, maxHeight: 240, overflowY: 'auto',
          }}
        >
          {tools.length === 0 && <div style={{ padding: 8, fontSize: 12, color: 'var(--text-muted)' }}>（未配置可用工具）</div>}
          {tools.map((t) => (
            <button
              key={t.id}
              onClick={() => { onChange(t.id); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 'none',
                background: t.id === toolId ? 'var(--surface-2)' : 'transparent', color: 'var(--text)', fontSize: 12, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = t.id === toolId ? 'var(--surface-2)' : 'transparent'; }}
            >
              {t.name}（{t.type}）· {t.model}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 右侧 AI 控制台：受控组件，AI 工具列表/选中项由父级（ReportPage）统一持有。
 * 参考 18_comparePakage 的 AI 分析栏实现：普通手动分析采用「并行多任务 tab」模型，
 * 每次「开始分析」生成一个独立任务 tab，各请求互不阻塞并行执行；内置「AI 周报」tab
 * 承载父级传进的 SSE 流式生成（阶段日志 + 实时洞察）。选中任务的内容在下方滚动窗口展示，
 * 底部右下角提供「打开预览」「下载」两个操作按钮。
 */
export function ReportConsole({
  tools,
  toolId,
  onToolIdChange,
  period,
  streaming = false,
  logs = [],
  streamText = '',
}: {
  readonly tools: AITool[];
  readonly toolId: string;
  readonly onToolIdChange: (id: string) => void;
  /** 当前分析周期；周期类预设（汇总/风险/建议）据此附带周期让后端注入真实数据 */
  readonly period?: ReportPeriod;
  readonly streaming?: boolean;
  readonly logs?: string[];
  readonly streamText?: string;
}) {
  // 分析选项与自定义问题改为会话级持久化（useSessionState）：切换页面返回保留输入选择
  const [category, setCategory] = useSessionState<(typeof CATEGORIES)[number]['key']>('rptconsole.category', 'summary');
  const [custom, setCustom] = useSessionState('rptconsole.custom', '');
  // 并行任务与聚焦 tab 为内存态：与参考实现的 in-memory 模型一致，避免大量分析结果写入 sessionStorage 触发配额告警
  const [tasks, setTasks] = useState<AnalysisTask[]>([]);
  const [activeId, setActiveId] = useState<string>(REPORT_TAB);
  // 「打开预览」临时正文与开关：全屏遮罩，仅承载当前聚焦任务的 Markdown 结论
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewMd, setPreviewMd] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  const activeTask = tasks.find((t) => t.id === activeId) ?? null;
  const onReportTab = activeId === REPORT_TAB;
  const runningCount = tasks.filter((t) => t.status === 'busy').length;
  const noTool = !toolId;
  const customInvalid = category === 'custom' && !custom.trim();

  // 阶段日志没有天然 id，按「内容 + 同内容出现序号」派生稳定 key：
  // 追加式日志的前缀条目 key 不变，避免用数组索引作 key 在重排时错误复用 DOM
  const logItems = useMemo(() => {
    const seen = new Map<string, number>();
    return logs.map((log) => {
      const n = (seen.get(log) ?? 0) + 1;
      seen.set(log, n);
      return { id: n > 1 ? `${log}#${n}` : log, log };
    });
  }, [logs]);

  // 正在生成（AI 周报流式或手动任务进行中）时随内容滚到底部，保证流式输出始终跟随最新内容
  const live = onReportTab ? (streaming || (streamText?.length ?? 0) > 0) : activeTask?.status === 'busy';
  useEffect(() => {
    if (live) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [live, streamText, streamsLen(activeTask)]);

  // 统一按 id 局部更新任务字段，避免在并发更新中因闭包持有旧 tasks 而互相覆盖
  const updateTask = useCallback((id: string, patch: Partial<AnalysisTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  /** 发起一次 /ai/chat 请求并回写到对应任务（独立异步，可并行；互不阻塞其它任务） */
  const runQuery = useCallback(async (id: string, prompt: string, cat: (typeof CATEGORIES)[number]['key'], per?: ReportPeriod) => {
    updateTask(id, { status: 'busy', answer: '', error: '' });
    const body: Record<string, unknown> = {
      toolId,
      system: '你是 MTask 的 AI 助手，基于任务与报表背景，用简洁专业的中文回答，并使用 Markdown 组织输出。',
      user: prompt,
    };
    // 周期类预设（非自定义）附带当前周期，后端据此聚合真实任务数据注入；自定义问答不附带以保持纯对话
    if (cat !== 'custom' && per) body.period = per;
    try {
      const r = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/chat', body);
      if (r.ok && r.content) updateTask(id, { status: 'done', answer: r.content });
      else updateTask(id, { status: 'error', error: r.error ?? 'AI 未返回结果' });
    } catch (e) {
      updateTask(id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, [toolId, updateTask]);

  /** 新建一个并行分析任务并聚焦它。发起时固化 prompt 与周期，供「重新分析」复用。 */
  function newAnalysis() {
    const user = category === 'custom' ? custom.trim() : presetPrompt(category, periodLabel);
    seqRef.current += 1;
    const id = 'ai-' + seqRef.current;
    const cat = category;
    const per = cat === 'custom' ? undefined : period;
    const title = cat === 'custom' ? `自定义：${user.slice(0, 18)}` : (CATEGORIES.find((c) => c.key === cat)?.label ?? cat);
    const task: AnalysisTask = { id, title, prompt: user, category: cat, period: per, status: 'busy', answer: '', error: '' };
    setTasks((prev) => [...prev, task]);
    setActiveId(id);
    void runQuery(id, user, cat, per);
  }

  /** 重新分析某任务：复用其固化 prompt 与周期重置后重跑 */
  function restart(id: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    setActiveId(id);
    void runQuery(t.id, t.prompt, t.category, t.period);
  }

  /** 关闭某任务 tab：若关的是当前聚焦则激活邻居（优先前一个，否则后一个），没有其它任务则回到 AI 周报 tab */
  function closeTask(id: string) {
    const idx = tasks.findIndex((t) => t.id === id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (activeId === id) {
      const prevT = idx > 0 ? tasks[idx - 1] : tasks[idx + 1];
      setActiveId(prevT ? prevT.id : REPORT_TAB);
    }
  }

  /** 重置控制台：清空全部分析任务、回到 AI 周报 tab，并恢复默认类别与自定义提问 */
  function resetConsole() {
    setTasks([]);
    setActiveId(REPORT_TAB);
    setCategory('summary');
    setCustom('');
  }

  /** 打开预览：全屏遮罩渲染当前聚焦内容（AI 周报流式正文或手动任务结论） */
  function openPreview() {
    const md = onReportTab ? streamText : activeTask?.answer;
    if (!md) return;
    setPreviewMd(md);
    setPreviewOpen(true);
  }

  /** 下载当前聚焦内容为 .md 文件（本地 Blob，不经后端） */
  function downloadActive() {
    const md = onReportTab ? streamText : activeTask?.answer;
    if (!md) return;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const name = onReportTab ? 'AI周报' : (activeTask?.title || 'analysis');
    const a = document.createElement('a');
    a.href = url;
    a.download = `mtask-ai-${name.replace(/[\\/:*?"<>|]/g, '_')}.md`; // NOSONAR - 需按非法文件名字符集合替换，replaceAll 只能替换字面字符串无法表达集合
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function statusIcon(s: AnalysisTask['status']) {
    switch (s) {
      case 'busy': return <Loader2 size={12} style={{ animation: 'mconsole-spin 1s linear infinite' }} />;
      case 'done': return <CheckCircle2 size={12} style={{ color: 'var(--accent)' }} />;
      default: return <AlertTriangle size={12} style={{ color: 'var(--danger)' }} />;
    }
  }

  /** 结果区内容：AI 周报流或聚焦任务按 tab 分支渲染 */
  function renderBody() {
    if (onReportTab) {
      const hasStream = streaming || logs.length > 0 || !!streamText;
      if (!hasStream) {
        return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>选择分析内容后点击「开始分析」，AI 结果会在下方以 Markdown 展示；点击左侧「AI 周报生成」此处会实时滚动生成全过程。</span>;
      }
      return (
        <div>
          {/* 生成中提示 + 阶段进度日志 */}
          <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Sparkles size={13} style={{ color: 'var(--accent)' }} /> AI 周报生成
            {streaming && <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 400 }}>生成中…</span>}
          </div>
          {logItems.map(({ id, log }) => (
            <div key={id} style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '2px 0' }}>• {log}</div>
          ))}
          {/* AI 洞察正文：流式增量实时渲染 */}
          {!!streamText && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>AI 洞察（实时）</div>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>
                <MarkdownContent content={streamText} />
              </div>
            </div>
          )}
          {!streaming && !!streamText && (
            <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6 }}>✓ 洞察生成完成，可在左侧下载文件。</div>
          )}
        </div>
      );
    }
    if (!activeTask) return null;
    return (
      <div>
        {activeTask.status === 'busy' && (
          <div style={{ fontSize: 12, color: activeTask.answer ? 'var(--text)' : 'var(--text-muted)' }}>
            {activeTask.answer ? <MarkdownContent content={activeTask.answer} /> : 'AI 正在分析…'}
          </div>
        )}
        {activeTask.status === 'done' && <MarkdownContent content={activeTask.answer} />}
        {activeTask.status === 'error' && (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>
            {activeTask.error || '分析失败'}
          </div>
        )}
      </div>
    );
  }

  /** 底部状态文案 */
  function statusText() {
    if (onReportTab) {
      if (streaming) return <><Loader2 size={12} style={{ animation: 'mconsole-spin 1s linear infinite', verticalAlign: '-2px', marginRight: 4 }} />AI 周报生成中…</>;
      if (logs.length > 0 || (streamText?.length ?? 0) > 0) return <span style={{ color: 'var(--accent)' }}>✓ 生成完成</span>;
      return <span>就绪</span>;
    }
    switch (activeTask?.status) {
      case 'busy': return <><Loader2 size={12} style={{ animation: 'mconsole-spin 1s linear infinite', verticalAlign: '-2px', marginRight: 4 }} />分析中…</>;
      case 'done': return <span style={{ color: 'var(--accent)' }}>✓ 分析完成</span>;
      case 'error': return <span style={{ color: 'var(--danger)' }}>失败</span>;
      default: return <span>就绪</span>;
    }
  }

  const periodLabel = (period && PERIOD_LABEL[period]) || undefined;
  // 当前聚焦内容是否有正文：AI 周报 tab 看流式洞察正文，手动任务看其 answer；驱动预览/下载按钮可用性
  const hasAnswer = onReportTab ? !!streamText : !!activeTask?.answer;
  // 「开始分析」按钮文案：无工具 / 自定义问题为空 / 正常三种状态，顺序判断避免嵌套三元
  let startBtnTitle = '开始分析 — 发起一个并行分析任务（不会阻塞其它任务）';
  if (noTool) startBtnTitle = '开始分析 — 请先选择 AI 工具';
  else if (customInvalid) startBtnTitle = '开始分析 — 请先输入分析问题';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--card-bg)', height: '100%', minHeight: 420 }}>
      <style>{'@keyframes mconsole-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }'}</style>

      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
        <Terminal size={14} /> AI 控制台
        {runningCount > 0 && (
          <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 400 }}>{runningCount} 进行中</span>
        )}
      </div>

      {/* 操作栏：AI 工具 / 分析内容 / 开始分析 / 重置 合并为一行；自定义提问时文本框另起一行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <ToolSelect tools={tools} toolId={toolId} onChange={onToolIdChange} />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as typeof category)}
          title="分析内容 — 选择本次分析的问题类型"
          aria-label="分析内容：选择本次分析的问题类型"
          style={{ flex: '0 1 auto', padding: '5px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 150 }}
        >
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {/* 汇总类选项文案随所选报表周期联动：日报→「日报要点汇总」、周报→「周报要点汇总」、月报→「月报要点汇总」 */}
              {c.key === 'summary' && periodLabel ? `${periodLabel}要点汇总` : c.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => newAnalysis()}
          disabled={noTool || customInvalid}
          title={startBtnTitle}
          aria-label="开始分析：发起并行分析任务"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px', background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: 6, cursor: 'pointer', border: 'none', flex: '0 0 auto' }}
        >
          <Plus size={13} />
        </button>
        <button
          onClick={resetConsole}
          title="重置 — 清空全部分析任务并恢复默认设置"
          aria-label="重置：清空全部分析任务并恢复默认设置"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', flex: '0 0 auto' }}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {category === 'custom' && (
        <textarea
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          rows={2}
          placeholder="输入你的分析问题…"
          style={{ width: '100%', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, boxSizing: 'border-box', background: 'var(--card-bg)', color: 'var(--text)' }}
        />
      )}

      {/* 并行任务 tab 栏：AI 周报固定 + 各分析任务（可关闭），超出换行 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <button
          onClick={() => setActiveId(REPORT_TAB)}
          title="AI 周报 — 左侧生成触发的流式过程在此展示"
          aria-label="AI 周报 tab"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
            border: '1px solid var(--border-strong)', background: onReportTab ? 'var(--accent)' : 'var(--card-bg)',
            color: onReportTab ? 'var(--accent-text)' : 'var(--text)', maxWidth: 120,
          }}
        >
          <Sparkles size={11} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>AI 周报</span>
        </button>
        {tasks.map((t) => (
          <div
            key={t.id}
            title={t.title}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 4px', borderRadius: 6,
              border: '1px solid var(--border-strong)', background: activeId === t.id ? 'var(--accent)' : 'var(--card-bg)',
              color: activeId === t.id ? 'var(--accent-text)' : 'var(--text)', maxWidth: 150,
            }}
          >
            {/* 切换 tab 与关闭拆成两个并列原生 button：避免 button 嵌套 button 的非法 DOM，也满足可访问性要求 */}
            <button
              type="button"
              onClick={() => setActiveId(t.id)}
              aria-label={`${t.title} tab`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'inherit', fontSize: 11, cursor: 'pointer', padding: 0, maxWidth: 110 }}
            >
              {statusIcon(t.status)}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); closeTask(t.id); }}
              title="关闭此分析"
              aria-label={`关闭${t.title}`}
              style={{ fontSize: 12, opacity: 0.7, cursor: 'pointer', marginLeft: 2, background: 'transparent', border: 'none', color: 'inherit', padding: 0, display: 'inline-flex' }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>

      {/* 结果区：当前聚焦任务/流式滚动展示 */}
      <div
        ref={bodyRef}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: 'var(--surface)' }}
      >
        {renderBody()}
      </div>

      {/* 底部：状态在左，预览/下载/重跑在右 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, fontSize: 11 }}>
        <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' }}>{statusText()}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {!onReportTab && activeTask?.status === 'done' && (
            <button
              onClick={() => restart(activeTask.id)}
              title="重新分析 — 复用相同问题与周期重新发起"
              aria-label="重新分析"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)' }}
            >
              <RotateCw size={12} /> 重跑
            </button>
          )}
          <button
            onClick={openPreview}
            disabled={!hasAnswer}
            title="打开预览 — 新窗口查看完整 Markdown 报告"
            aria-label="打开预览"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--accent)' }}
          >
            <Eye size={12} /> 打开预览
          </button>
          <button
            onClick={downloadActive}
            disabled={!hasAnswer}
            title="下载 — 导出分析结果为 Markdown 文件"
            aria-label="下载"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--accent)' }}
          >
            <Download size={12} /> 下载
          </button>
        </span>
      </div>

      {/* 预览遮罩：渲染当前任务 Markdown 结论 */}
      {previewOpen && (
        <div /* NOSONAR - 遮罩点击空白关闭为便捷辅助，正式关闭入口为原生 X 按钮，无需对背景遮罩聚焦键盘 */
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setPreviewOpen(false)}
        >
          <div /* NOSONAR - 阻断点击冒泡属事件传递逻辑而非独立交互控件，可访问关闭入口仍为原生 X 按钮 */
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(800px, 90vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,0.18)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
              <FileText size={14} /> AI 分析预览
              <span style={{ flex: 1 }} />
              <button
                onClick={() => setPreviewOpen(false)}
                title="关闭预览 — 关闭当前 Markdown 预览窗口"
                aria-label="关闭预览"
                style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text)' }}
              >
                <X size={15} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 14, background: 'var(--surface)' }}>
              <MarkdownContent content={previewMd} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 供 useEffect 依赖计算活跃手动任务的内容长度；仅作用依赖值，避免流式时每次整数组重建触发额外滚动 */
function streamsLen(t: AnalysisTask | null): string {
  return t ? (t.answer.length + '|' + t.status) : '';
}