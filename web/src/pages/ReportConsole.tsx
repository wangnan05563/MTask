import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type AITool, type ReqCategory } from '../api/client';
import { MarkdownContent } from '../ui/Markdown';
import { useSessionState } from '../ui/session';
import { Terminal, Sparkles, Plus, X, Loader2, CheckCircle2, AlertTriangle, RotateCw, RefreshCw, FileText, Download, Eye, ChevronDown, FolderInput, GitCompare, FileUp } from 'lucide-react';
import { aiImportStore } from '../stores/aiImportStore';

const CATEGORIES = [
  { key: 'summary', label: '周期要点汇总' },
  { key: 'risk', label: '风险与阻塞分析' },
  { key: 'suggestion', label: '改进建议与优先级' },
  { key: 'lessons', label: '经验教训提炼' },
  { key: 'generalize', label: '提炼通用需求' },
  { key: 'clean', label: '数据清洗（去重合并）' },
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
    case 'clean': return [
      '请基于随附的「已完成任务」数据做数据清洗：仅在同一项目内识别语义重复或高度相似的任务（含措辞不同但目标相同的同类改写）。要求：',
      '1. 先输出一个 ```json 代码块，内容为数组，每元素形如 {"project":"项目名","keep":"保留的代表任务号","merge":["被合并任务号"],"reason":"判定重复的理由"}；',
      '2. 只在同一个项目内合并，跨项目的相似任务一律不要合并；同一目标的多步迭代（同一功能的不同阶段）可合并为一组，保留更完整的那条作为代表；',
      '3. 无法确定重复时不要勉强成组，宁缺毋滥；keep 必须是组内真实存在的任务号；',
      '4. 分组 JSON 之后，再用 Markdown 简要说明：共发现多少组、涉及多少条任务、合并后预计减少多少条，以及各组的一句话理由。',
    ].join('\n');
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

/** T00569 三轮：内置「AI 项目计划导入」tab 固定 id——导入执行日志统一在此滚动输出（与周报/分析并列） */
const AI_IMPORT_TAB = '__aiimport__';

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
 * T00652 数据清洗弹窗：列出 AI 判定的重复分组，勾选确认后合并（保留代表任务、把关键信息并入其处理结果）
 * 并归档被合并任务。归档可逆（归档菜单可还原），故此处不做二次危险确认，仅展示影响条数。
 */
function CleanModal({
  rows,
  onPatch,
  cleanMsg,
  cleanError,
  cleaning,
  cleanDone,
  onClean,
  onClose,
}: {
  readonly rows: CleanRow[];
  readonly onPatch: (i: number, patch: Partial<CleanRow>) => void;
  readonly cleanMsg: string;
  readonly cleanError: string;
  readonly cleaning: boolean;
  readonly cleanDone: boolean;
  readonly onClean: () => void;
  readonly onClose: () => void;
}) {
  const picked = rows.filter((r) => r.include);
  const archiveCount = picked.reduce((n, r) => n + r.merge.length, 0);
  return (
    <div /* NOSONAR - 遮罩点击空白关闭为便捷辅助，正式关闭入口为弹窗内原生按钮 */
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={() => { if (!cleaning) onClose(); }}>
      <div /* NOSONAR - 阻断点击冒泡属事件传递逻辑而非独立交互控件，可访问关闭入口仍为原生按钮 */
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(680px, 92vw)', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
          <Sparkles size={14} style={{ color: 'var(--accent)' }} /> 数据清洗 — 合并重复任务
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            disabled={cleaning}
            title="关闭 — 取消本次清洗"
            aria-label="关闭清洗弹窗"
            style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text)' }}
          >
            <X size={15} />
          </button>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {rows.length === 0 ? (
            <div style={{ color: 'var(--text-muted)' }}>
              未从 AI 结论中解析到可执行的合并分组（需要含 keep 与非空 merge 的 JSON 数组）。可重跑分析，或改用自定义提问让模型严格按格式输出。
            </div>
          ) : (
            rows.map((row, i) => (
              <div key={row.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={row.include} aria-label={`勾选第 ${i + 1} 组`}
                    onChange={(e) => onPatch(i, { include: e.target.checked })} />
                  <span style={{ fontWeight: 600 }}>保留 {row.keep}</span>
                  {row.project && <span style={{ color: 'var(--text-muted)' }}>（{row.project}）</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ color: 'var(--text-muted)' }}>归档 {row.merge.length} 条</span>
                </div>
                <div style={{ color: 'var(--text-secondary)' }}>合并归档：{row.merge.join('、')}</div>
                {row.reason && <div style={{ color: 'var(--text-muted)' }}>理由：{row.reason}</div>}
              </div>
            ))
          )}
          {cleanMsg && <div style={{ color: 'var(--success)' }}>✓ {cleanMsg}</div>}
          {cleanError && <div style={{ color: 'var(--danger)' }}>{cleanError}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <span style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>
            共 {rows.length} 组，已选 {picked.length} 组（将归档 {archiveCount} 条重复任务，可在归档菜单还原）
          </span>
          <button
            onClick={onClose}
            disabled={cleaning}
            title="取消 — 放弃本次清洗"
            aria-label="取消清洗"
            style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)' }}
          >
            取消
          </button>
          <button
            onClick={onClean}
            disabled={cleaning || cleanDone || picked.length === 0}
            title={cleanDone ? '本次清洗已执行' : '确认合并 — 归档被合并任务并把关键信息并入代表任务'}
            aria-label="确认合并"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)' }}
          >
            {cleaning && <Loader2 size={12} style={{ animation: 'mconsole-spin 1s linear infinite' }} />}
            确认合并
          </button>
        </div>
      </div>
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
/**
 * 把「提炼通用需求」清单按 Markdown 二级以上标题切分为若干条 {title, content}。
 * generalize 预设的输出以“需求标题/适用场景/实现要点/复用价值”分节组织；若清单不含任何标题分节，
 * 则整份退回为单条（title 取首个非空行），保证手动分组在任何输出形态下都可用。
 */
function parseAnswerItems(md: string): { title: string; content: string }[] {
  const lines = md.split('\n');
  const items: { title: string; content: string }[] = [];
  let cur: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = /^\s*(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) items.push({ title: cur.title, content: cur.body.join('\n').trim() });
      cur = { title: m[2].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) items.push({ title: cur.title, content: cur.body.join('\n').trim() });
  if (items.some((i) => i.title) && items.some((i) => i.content)) return items.filter((i) => i.title && i.content);
  // 无有效标题分节：整份作为单条转存，标题取首个非空行兜底
  const first = lines.find((l) => l.trim()) ?? '通用需求清单';
  return [{ title: first.replace(/^\s*#+\s*/, '').slice(0, 40), content: md }];
}

/** T00652 数据清洗：AI 结论中的一个合并分组（keep=保留的代表任务号，merge=被判定重复、将归档的任务号） */
interface CleanRow {
  id: string;
  project: string;
  keep: string;
  merge: string[];
  reason: string;
  include: boolean;
}

/**
 * T00652 数据清洗：从 AI 结论中解析合并分组。
 * 兼容 ```json 代码围栏与裸 JSON 数组：先剥围栏，再取首个 '[' 到末尾 ']' 之间解析；
 * 逐组校验 keep 非空且 merge 非空（AI 输出不可靠，宁缺毋滥）。
 */
function parseCleanGroups(md: string): CleanRow[] {
  const bare = md.replaceAll(/```json/gi, '').replaceAll(/```/gi, '').trim();
  const start = bare.indexOf('[');
  const end = bare.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(bare.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: CleanRow[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const keep = typeof o.keep === 'string' ? o.keep.trim() : '';
    const merge = (Array.isArray(o.merge) ? o.merge : [])
      .filter((x): x is string => typeof x === 'string' && !!x.trim())
      .map((x) => x.trim())
      .filter((x) => x !== keep);
    if (!keep || merge.length === 0) continue;
    out.push({
      id: `clean-${out.length}`,
      project: typeof o.project === 'string' ? o.project.trim() : '',
      keep,
      merge: Array.from(new Set(merge)),
      reason: typeof o.reason === 'string' ? o.reason.trim() : '',
      include: true,
    });
  }
  return out;
}

/** 后端持久化任务行 → 前端任务快照：字段一一对应，仅做空值归一（answer/error 为 null 时置空串） */
function rowToTask(r: {
  id: string;
  title: string;
  prompt: string;
  category: string;
  period: string | null;
  status: 'busy' | 'done' | 'error';
  answer: string | null;
  error: string | null;
}): AnalysisTask {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    category: r.category as AnalysisTask['category'],
    period: r.period ? (r.period as ReportPeriod) : undefined,
    status: r.status,
    answer: r.answer ?? '',
    error: r.error ?? '',
  };
}

/** 是否正在生成内容（AI 周报流式或手动任务进行中）：驱动结果区自动滚动 */
function isLive(onReportTab: boolean, streaming: boolean, streamText: string, activeTask: AnalysisTask | null): boolean {
  if (onReportTab) return streaming || (streamText?.length ?? 0) > 0;
  return activeTask?.status === 'busy';
}

/** 周期 key → 中文名（未选周期时返回 undefined，供预设提示词与选项文案引用） */
function periodLabelOf(period?: ReportPeriod): string | undefined {
  return period ? PERIOD_LABEL[period] : undefined;
}

/** 手动分组表格行：id 为列表内稳定唯一键（避免用数组索引作 React key） */
interface SaveRow {
  id: string;
  title: string;
  content: string;
  include: boolean;
}

/** 手动模式的目标分类选择：加载中 / 无分类 / 正常三态；label 通过 htmlFor 与 select 关联 */
function CategoryPicker({
  loading,
  cats,
  value,
  onChange,
}: {
  readonly loading: boolean;
  readonly cats: ReqCategory[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  let control: React.ReactNode;
  if (loading) {
    control = (
      <div style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Loader2 size={12} style={{ animation: 'mconsole-spin 1s linear infinite' }} /> 加载分类…
      </div>
    );
  } else if (cats.length === 0) {
    control = <div style={{ color: 'var(--danger)' }}>暂无分类，请先在「通用需求」菜单新建分类。</div>;
  } else {
    control = (
      <select
        id="rpt-save-category"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ flex: 1, padding: 6, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12 }}
      >
        {cats.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.reqCount ?? 0}）</option>)}
      </select>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label htmlFor="rpt-save-category" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>目标分类：</label>
      {control}
    </div>
  );
}

/** 「转存到通用需求」弹窗：AI 智能分组 / 手动分组两模式；手动模式为可交互条目表格 */
function SaveReqModal({
  saveMode,
  onSaveModeChange,
  saveLoading,
  reqCats,
  saveCategoryId,
  onCategoryChange,
  saveRows,
  onPatchRow,
  saveMsg,
  saveError,
  saving,
  saveDone,
  onSave,
  onClose,
}: {
  readonly saveMode: 'ai' | 'manual';
  readonly onSaveModeChange: (mode: 'ai' | 'manual') => void;
  readonly saveLoading: boolean;
  readonly reqCats: ReqCategory[];
  readonly saveCategoryId: string;
  readonly onCategoryChange: (id: string) => void;
  readonly saveRows: SaveRow[];
  readonly onPatchRow: (i: number, patch: Partial<SaveRow>) => void;
  readonly saveMsg: string;
  readonly saveError: string;
  readonly saving: boolean;
  readonly saveDone: boolean;
  readonly onSave: () => void;
  readonly onClose: () => void;
}) {
  return (
    <div /* NOSONAR - 遮罩点击空白关闭为便捷辅助，正式关闭入口为弹窗内原生按钮，无需对背景遮罩聚焦键盘 */
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={() => { if (!saving) onClose(); }}>
      <div /* NOSONAR - 阻断点击冒泡属事件传递逻辑而非独立交互控件，可访问关闭入口仍为原生按钮 */
        onClick={(e) => e.stopPropagation()} style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(640px, 92vw)', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
          <FolderInput size={14} style={{ color: 'var(--accent)' }} /> 转存到通用需求
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            disabled={saving}
            title="关闭 — 取消转存"
            aria-label="关闭转存弹窗"
            style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text)' }}
          >
            <X size={15} />
          </button>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {/* 分组模式选择 */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => onSaveModeChange('ai')}
              style={{ flex: '40%', padding: '6px 0', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: saveMode === 'ai' ? 'var(--accent)' : 'var(--card-bg)', color: saveMode === 'ai' ? 'var(--accent-text)' : 'var(--text)' }}
              title="AI 智能分组 — 由 AI 自动把清单拆成多条并归入最贴切分类"
            >
              AI 智能分组
            </button>
            <button
              onClick={() => onSaveModeChange('manual')}
              style={{ flex: '60%', padding: '6px 0', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: saveMode === 'manual' ? 'var(--accent)' : 'var(--card-bg)', color: saveMode === 'manual' ? 'var(--accent-text)' : 'var(--text)' }}
              title="手动分组 — 选择目标分类，把清单按标题分节批量写入"
            >
              手动分组
            </button>
          </div>
          {saveMode === 'ai' ? (
            <div style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              由 AI 解析当前清单，抽取其中的通用需求，为每条自动归入最贴切分类（必要时自动新建分类），批量写入「通用需求」菜单。需使用当前已选 AI 工具。内容重复的条目会被自动跳过。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <CategoryPicker loading={saveLoading} cats={reqCats} value={saveCategoryId} onChange={onCategoryChange} />
              {/* T00437：可交互条目表格——勾选控制是否转存，标题/内容可在线编辑 */}
              {saveRows.map((row, i) => (
                <div key={row.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={row.include} aria-label={`勾选第 ${i + 1} 条`}
                      onChange={(e) => onPatchRow(i, { include: e.target.checked })} />
                    <input value={row.title} aria-label={`第 ${i + 1} 条标题`}
                      onChange={(e) => onPatchRow(i, { title: e.target.value })}
                      style={{ flex: 1, padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, fontWeight: 600 }} />
                  </div>
                  <textarea value={row.content} rows={3} aria-label={`第 ${i + 1} 条内容`}
                    onChange={(e) => onPatchRow(i, { content: e.target.value })}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--text-secondary)', fontSize: 11, resize: 'vertical' }} />
                </div>
              ))}
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                勾选要转存的条目（共 {saveRows.filter((r) => r.include).length}/{saveRows.length} 条）；内容重复的条目转存时会被自动跳过。
              </div>
            </div>
          )}
          {saveMsg && <div style={{ color: 'var(--success)' }}>✓ {saveMsg}</div>}
          {saveError && <div style={{ color: 'var(--danger)' }}>{saveError}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={onClose}
            disabled={saving}
            title="取消 — 放弃本次转存"
            aria-label="取消转存"
            style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)' }}
          >
            取消
          </button>
          <button
            onClick={onSave}
            disabled={saving || saveDone || (saveMode === 'manual' && (!saveCategoryId || reqCats.length === 0))}
            title={saveDone ? '已转存完成' : '确认转存 — 写入通用需求菜单'}
            aria-label="确认转存"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)' }}
          >
            {saving && <Loader2 size={12} style={{ animation: 'mconsole-spin 1s linear infinite' }} />}
            确认转存
          </button>
        </div>
      </div>
    </div>
  );
}

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
  // 「转存到通用需求」弹窗状态：打开时懒加载 req 分类，支持 AI 智能分组 / 手动选分组两种模式
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveMode, setSaveMode] = useState<'ai' | 'manual'>('ai');
  const [reqCats, setReqCats] = useState<ReqCategory[]>([]);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveCategoryId, setSaveCategoryId] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveError, setSaveError] = useState('');
  // T00443 / PRD AI-6：多模型对比模式——勾选的对比模型与主模型并行运行同一分析，结果 tab 并列对比
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  // T00437：手动模式的可交互条目表格（标题/内容可编辑、勾选控制是否转存）与「本次已转存」标记
  const [saveRows, setSaveRows] = useState<SaveRow[]>([]);
  const [saveDone, setSaveDone] = useState(false);
  // T00652：数据清洗弹窗状态（AI 判定重复分组 → 勾选确认 → 合并并归档）
  const [cleanOpen, setCleanOpen] = useState(false);
  const [cleanRows, setCleanRows] = useState<CleanRow[]>([]);
  const [cleanMsg, setCleanMsg] = useState('');
  const [cleanError, setCleanError] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [cleanDone, setCleanDone] = useState(false);

  // T00569 三轮：AI 项目计划导入——模块级 store 订阅（切页保持，日志统一在本控制台 tab 输出）
  const aiSnap = useSyncExternalStore(aiImportStore.subscribe, aiImportStore.getSnapshot);
  const onAiImportTab = activeId === AI_IMPORT_TAB;
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

  // T00569 三轮：AI 导入首次产生日志时自动切到该 tab（保证执行过程可见）
  const aiLogCount = aiSnap.logs.length;
  const prevAiLogCount = useRef(0);
  useEffect(() => {
    if (aiLogCount > 0 && prevAiLogCount.current === 0) setActiveId(AI_IMPORT_TAB);
    prevAiLogCount.current = aiLogCount;
  }, [aiLogCount]);

  // 正在生成（AI 周报流式或手动任务进行中）时随内容滚到底部，保证流式输出始终跟随最新内容
  const live = isLive(onReportTab, streaming, streamText, activeTask) || onAiImportTab;
  useEffect(() => {
    if (live) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [live, streamText, streamsLen(activeTask)]);

  // 统一按 id 局部更新任务字段，避免在并发更新中因闭包持有旧 tasks 而互相覆盖
  const updateTask = useCallback((id: string, patch: Partial<AnalysisTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // 后端持久化任务快照：任务存服务器，本地 tasks 仅作为「已展示的 job 快照」。
  // 切换/刷新页面后运行中的任务后端照常继续，挂载时重新拉取即可恢复
  const refreshJobs = useCallback(async () => {
    try {
      const jobs = await api.get<Parameters<typeof rowToTask>[0][]>('/console-jobs');
      setTasks(jobs.map(rowToTask));
    } catch {
      // 后端暂不可用：静默，等待下次轮询再试，不打断既有展示
    }
  }, []);

  // 挂载即恢复全部任务；此后每 2s 轮询一次，让运行中任务的 status/answer/error 实时收敛为完成态。
  // 组件卸载会取消本定时器，但任务已在后端持久化并继续运行——这正是「切页不中断」的落点
  useEffect(() => {
    void refreshJobs();
    const timer = setInterval(() => void refreshJobs(), 2000);
    return () => clearInterval(timer);
  }, [refreshJobs]);

  /** 新建一个并行分析任务：创建持久化 job 并聚焦它。发起时固化 prompt 与周期，供「重新分析」复用 */
  async function newAnalysis() {
    const user = category === 'custom' ? custom.trim() : presetPrompt(category, periodLabel);
    const cat = category;
    // T00652：数据清洗不依赖报表周期，后端改按「全量已完成任务」注入数据，故不附带 period
    const per = cat === 'custom' || cat === 'clean' ? undefined : period;
    const title = cat === 'custom' ? `自定义：${user.slice(0, 18)}` : (CATEGORIES.find((c) => c.key === cat)?.label ?? cat);
    const body: Record<string, unknown> = { title, prompt: user, category: cat };
    // 周期类预设（非自定义）附带当前周期，后端据此聚合真实任务数据注入；自定义问答不附带以保持纯对话；
    // T00652 数据清洗同理不附带周期（改用全量已完成任务数据）
    if (cat !== 'custom' && cat !== 'clean' && per) body.period = per;
    if (toolId) body.toolId = toolId;
    try {
      // 后端受理即创建 busy job 并后台异步运行；本地仅持有其 id 作为展示快照
      const r = await api.post<{ id: string }>('/console-jobs', body);
      const task: AnalysisTask = { id: r.id, title, prompt: user, category: cat, period: per, status: 'busy', answer: '', error: '' };
      setTasks((prev) => [...prev, task]);
      setActiveId(r.id);
      // T00443 / PRD AI-6：对比模式——为每个勾选的对比模型创建同 prompt 任务并行运行（结果 tab 并列对比）
      for (const ct of compareIds) {
        if (ct === toolId) continue;
        const ctool = tools.find((x) => x.id === ct);
        if (!ctool) continue;
        const cbody = { ...body, title: `${title}【对比·${ctool.name}】`, toolId: ct };
        void api.post<{ id: string }>('/console-jobs', cbody).then((cr) => {
          setTasks((prev) => [...prev, { id: cr.id, title: cbody.title, prompt: user, category: cat, period: per, status: 'busy', answer: '', error: '' }]);
        }).catch(() => undefined);
      }
    } catch {
      // 创建失败（如后端未就绪）：不写入本地视图，避免出现无后端实体的假任务，等待用户重试
    }
  }

  /** 重新分析某任务：后端将该 job 复位并异步重跑（复用其固化 prompt 与周期） */
  async function restart(id: string) {
    // 先把本地重置为 busy 即时反馈，最终结果由轮询收敛
    updateTask(id, { status: 'busy', answer: '', error: '' });
    setActiveId(id);
    try {
      await api.post(`/console-jobs/${id}/restart`, { toolId });
    } catch {
      // 重跑受理失败：本地保持 busy 交由后端兜底，不做回滚以免闪跳
    }
  }

  /** 关闭某任务 tab：若关的是当前聚焦则激活邻居（优先前一个，否则后一个），没有其它任务则回到 AI 周报 tab */
  function closeTask(id: string) {
    const idx = tasks.findIndex((t) => t.id === id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (activeId === id) {
      const prevT = idx > 0 ? tasks[idx - 1] : tasks[idx + 1];
      setActiveId(prevT ? prevT.id : REPORT_TAB);
    }
    void api.del(`/console-jobs/${id}`).catch(() => { /* 删除失败：本地先移除，残留由下次轮询/重置兜底 */ });
  }

  /** 重置控制台：清空后端全部持久化任务、回到 AI 周报 tab，并恢复默认类别与自定义提问 */
  function resetConsole() {
    void api.del('/console-jobs').catch(() => { /* 清空失败：本地已清，残留由用户再次重置兜底 */ });
    setTasks([]);
    setActiveId(REPORT_TAB);
    setCategory('summary');
    setCustom('');
  }

  /** 对比模型勾选切换：已选则移除，未选则追加 */
  function toggleCompareModel(id: string) {
    setCompareIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** 更新手动分组表格中的某一行：仅替换目标行，保持其余行对象引用不变 */
  function patchSaveRow(i: number, patch: Partial<SaveRow>) {
    setSaveRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
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

  /** 打开「转存到通用需求」弹窗：懒加载 req 分类（每次打开重拉保证分类新鲜）；
   *  同时预解析清单条目供手动模式的可交互表格使用（T00437） */
  async function openSave() {
    if (!activeTask?.answer) return;
    setSaveOpen(true);
    setSaveMode('ai');
    setSaveMsg('');
    setSaveError('');
    setSaving(false);
    setSaveDone(false);
    setSaveLoading(true);
    setSaveRows(parseAnswerItems(activeTask.answer).map((it, i) => ({ ...it, id: `rpt-row-${i}`, include: true })));
    try {
      const cats = await api.get<ReqCategory[]>('/req-categories');
      setReqCats(cats);
      setSaveCategoryId((cur) => (cats.some((c) => c.id === cur) ? cur : (cats[0]?.id ?? '')));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveLoading(false);
    }
  }

  /** 提交转存：AI 模式走后端智能分组解析+归类；手动模式提交表格中勾选的条目（可编辑标题/内容）。
   *  成功后短暂展示结果并自动关闭弹窗（T00434：防重复点击二次转存）；后端按内容指纹跳过重复条目（T00435）。 */
  async function doSave() {
    if (!activeTask?.answer || saving || saveDone) return;
    setSaving(true);
    setSaveMsg('');
    setSaveError('');
    try {
      let r: { ok: boolean; count: number; skipped?: string[]; error?: string };
      if (saveMode === 'ai') {
        r = await api.post<{ ok: boolean; count: number; skipped?: string[]; error?: string }>('/ai/generalize-to-req', { mode: 'ai', toolId, answer: activeTask.answer });
      } else {
        if (!saveCategoryId) {
          setSaveError('请先选择目标分类');
          setSaving(false);
          return;
        }
        const items = saveRows.filter((row) => row.include && row.title.trim());
        if (items.length === 0) {
          setSaveError('请至少勾选一条要转存的条目');
          setSaving(false);
          return;
        }
        r = await api.post<{ ok: boolean; count: number; skipped?: string[]; error?: string }>('/ai/generalize-to-req', { mode: 'manual', categoryId: saveCategoryId, items });
      }
      if (r.ok) {
        const skipN = r.skipped?.length ?? 0;
        const dupHint = skipN > 0 ? `，跳过重复 ${skipN} 条` : '';
        setSaveMsg(`已转存 ${r.count} 条通用需求${dupHint}到「通用需求」菜单`);
        setSaveDone(true);
        // T00434：成功后延迟自动关闭（留出结果可见时间），杜绝未关弹窗导致的重复点击二次转存
        setTimeout(() => setSaveOpen(false), 1500);
      } else {
        setSaveError(r.error ?? '转存失败');
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /** T00652：打开「数据清洗」弹窗——解析 AI 结论中的合并分组，供勾选确认后执行 */
  function openClean() {
    if (!activeTask?.answer) return;
    setCleanRows(parseCleanGroups(activeTask.answer));
    setCleanOpen(true);
    setCleanMsg('');
    setCleanError('');
    setCleaning(false);
    setCleanDone(false);
  }

  /** T00652：更新清洗分组某一行（仅勾选状态需要变更） */
  function patchCleanRow(i: number, patch: Partial<CleanRow>) {
    setCleanRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  /**
   * T00652：提交数据清洗——按勾选分组调用 /ai/clean-tasks 合并并归档。
   * 后端写入走 TaskService.update（合并内容）+ ArchiveService.archive（归档，可还原），前端仅展示结果计数。
   */
  async function doClean() {
    const picked = cleanRows.filter((r) => r.include);
    if (picked.length === 0) {
      setCleanError('请至少勾选一个合并分组');
      return;
    }
    setCleaning(true);
    setCleanMsg('');
    setCleanError('');
    try {
      const r = await api.post<{ ok: boolean; merged: number; archived: number; missing?: string[] }>('/ai/clean-tasks', {
        groups: picked.map(({ keep, merge, reason }) => ({ keep, merge, reason })),
      });
      const skipHint = r.missing?.length ? `，${r.missing.length} 个任务号未匹配已跳过` : '';
      setCleanMsg(`已合并 ${r.merged} 组，归档重复任务 ${r.archived} 条${skipHint}`);
      setCleanDone(true);
      // 成功后延迟自动关闭，留出结果可见时间（与转存需求弹窗一致）
      setTimeout(() => setCleanOpen(false), 2000);
    } catch (e) {
      setCleanError(e instanceof Error ? e.message : String(e));
    } finally {
      setCleaning(false);
    }
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
    // T00569 三轮：AI 项目计划导入 tab——控制台式滚动输出执行日志（与导入面板深度整合）
    if (onAiImportTab) {
      const lv = (level: string) => (level === 'ok' ? 'var(--success, #16a34a)' : level === 'error' ? 'var(--danger)' : 'var(--text-secondary)');
      return (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <FileUp size={13} style={{ color: 'var(--accent)' }} /> AI 项目计划导入
            {aiSnap.busy && <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 400 }}>执行中…</span>}
            {aiSnap.fileName && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{aiSnap.fileName}</span>}
            {aiSnap.rows.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>草稿 {aiSnap.rows.length} 条</span>}
            {aiSnap.lastSaved > 0 && <span style={{ fontSize: 11, color: 'var(--success, var(--accent))', fontWeight: 400 }}>最近保存 {aiSnap.lastSaved} 条</span>}
          </div>
          {aiSnap.logs.length === 0
            ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>在「AI 工作台」展开「AI 项目计划导入」卡片并选择文件后，解析与入库过程将在此逐行滚动输出。</span>
            : aiSnap.logs.map((l, i) => (
              <div key={`${l.t}-${i}`} style={{ fontSize: 11, color: lv(l.level), padding: '2px 0', fontFamily: 'monospace' }}>
                [{l.t}] {l.msg}
              </div>
            ))}
        </div>
      );
    }
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

  const periodLabel = periodLabelOf(period);
  // 当前聚焦内容是否有正文：AI 周报 tab 看流式洞察正文，手动任务看其 answer；驱动预览/下载按钮可用性
  const hasAnswer = onReportTab ? !!streamText : !!activeTask?.answer;
  // 「开始分析」按钮文案：无工具 / 自定义问题为空 / 正常三种状态，顺序判断避免嵌套三元
  let startBtnTitle = '开始分析 — 发起一个并行分析任务（不会阻塞其它任务）';
  if (noTool) startBtnTitle = '开始分析 — 请先选择 AI 工具';
  else if (customInvalid) startBtnTitle = '开始分析 — 请先输入分析问题';

  /** 头部与操作栏：AI 工具 / 分析内容 / 开始分析 / 对比 / 重置；自定义提问时文本框另起一行 */
  function renderToolbar() {
    return (
      <>
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
            onClick={() => void newAnalysis()}
            disabled={noTool || customInvalid}
            title={startBtnTitle}
            aria-label="开始分析：发起并行分析任务"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px', background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: 6, cursor: 'pointer', border: 'none', flex: '0 0 auto' }}
          >
            <Plus size={13} />
          </button>
          {compareMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', flex: '1 1 auto' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>对比模型：</span>
              {tools.filter((t) => t.id !== toolId).map((t) => {
                const on = compareIds.includes(t.id);
                return (
                  <button key={t.id}
                    onClick={() => toggleCompareModel(t.id)}
                    title={on ? `取消对比：${t.name}` : `加入对比：${t.name}`}
                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`, background: on ? 'var(--accent)' : 'transparent', color: on ? 'var(--accent-text)' : 'var(--text)' }}>
                    {t.name}
                  </button>
                );
              })}
              {compareIds.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>点击模型名加入对比</span>}
            </div>
          )}
          <button
            onClick={resetConsole}
            title="重置 — 清空全部分析任务并恢复默认设置"
            aria-label="重置：清空全部分析任务并恢复默认设置"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', flex: '0 0 auto' }}
          >
            <RefreshCw size={13} />
          </button>
          {/* T00443 / PRD AI-6：多模型对比模式开关 */}
          <button
            onClick={() => { setCompareMode((v) => !v); setCompareIds([]); }}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 5, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: compareMode ? 'var(--accent-soft, rgba(9,105,218,.10))' : 'var(--card-bg)', color: compareMode ? 'var(--accent)' : 'var(--text)', flex: '0 0 auto' }}
            title="多模型对比 — 同一问题并行发给多个模型，结果并列对比"
            aria-label="多模型对比模式"
          >
            <GitCompare size={13} />
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
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--card-bg)', height: '100%', minHeight: 420 }}>
      <style>{'@keyframes mconsole-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }'}</style>

      {renderToolbar()}

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
        {/* T00569 三轮：AI 项目计划导入 tab——有执行记录或进行中时显示 */}
        {(aiSnap.logs.length > 0 || aiSnap.busy) && (
          <button
            onClick={() => setActiveId(AI_IMPORT_TAB)}
            title="AI 项目计划导入 — 导入执行日志在此滚动输出"
            aria-label="AI 项目计划导入 tab"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--border-strong)', background: onAiImportTab ? 'var(--accent)' : 'var(--card-bg)',
              color: onAiImportTab ? 'var(--accent-text)' : 'var(--text)', maxWidth: 150,
            }}
          >
            <FileUp size={11} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>AI 项目计划导入</span>
            {aiSnap.busy && <Loader2 size={10} className="aispin" />}
          </button>
        )}
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
            <>
              {/* T00652：仅「数据清洗」分析完成后提供执行入口——按 AI 分组合并重复任务 */}
              {activeTask.category === 'clean' && (
                <button
                  onClick={() => openClean()}
                  title="执行清洗 — 按 AI 判定的重复分组合并，归档重复任务（可在归档菜单还原）"
                  aria-label="执行清洗"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--accent)' }}
                >
                  <Sparkles size={12} /> 执行清洗
                </button>
              )}
              <button
                onClick={() => void openSave()}
                title="转存到通用需求 — 把这份通用需求清单写入「通用需求」菜单的指定分组"
                aria-label="转存到通用需求"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--accent)' }}
              >
                <FolderInput size={12} /> 转存需求
              </button>
              <button
                onClick={() => void restart(activeTask.id)}
                title="重新分析 — 复用相同问题与周期重新发起"
                aria-label="重新分析"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)' }}
              >
                <RotateCw size={12} /> 重跑
              </button>
            </>
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

      {/* 转存到通用需求弹窗：AI 智能分组 / 手动分组，确认后写入 req_entries */}
      {saveOpen && (
        <SaveReqModal
          saveMode={saveMode}
          onSaveModeChange={setSaveMode}
          saveLoading={saveLoading}
          reqCats={reqCats}
          saveCategoryId={saveCategoryId}
          onCategoryChange={setSaveCategoryId}
          saveRows={saveRows}
          onPatchRow={patchSaveRow}
          saveMsg={saveMsg}
          saveError={saveError}
          saving={saving}
          saveDone={saveDone}
          onSave={() => void doSave()}
          onClose={() => setSaveOpen(false)}
        />
      )}

      {/* T00652：数据清洗弹窗——AI 判定的重复分组，勾选确认后合并并归档 */}
      {cleanOpen && (
        <CleanModal
          rows={cleanRows}
          onPatch={patchCleanRow}
          cleanMsg={cleanMsg}
          cleanError={cleanError}
          cleaning={cleaning}
          cleanDone={cleanDone}
          onClean={() => void doClean()}
          onClose={() => setCleanOpen(false)}
        />
      )}
    </div>
  );
}

/** 供 useEffect 依赖计算活跃手动任务的内容长度；仅作用依赖值，避免流式时每次整数组重建触发额外滚动 */
function streamsLen(t: AnalysisTask | null): string {
  return t ? (t.answer.length + '|' + t.status) : '';
}