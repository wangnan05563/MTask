import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AITool } from '../api/client';
import { MarkdownContent } from '../ui/Markdown';
import { useSessionState } from '../ui/session';
import { RefreshCw, Send, Terminal, Sparkles } from 'lucide-react';

const CATEGORIES = [
  { key: 'summary', label: '周期要点汇总' },
  { key: 'risk', label: '风险与阻塞分析' },
  { key: 'suggestion', label: '改进建议与优先级' },
  { key: 'custom', label: '自定义提问…' },
] as const;

const PRESET_PROMPTS: Record<string, string> = {
  summary: '请根据当前任务信息，汇总本周期各项目的进展概况、完成情况与重点待办，输出为一则清晰的周报要点（Markdown）。',
  risk: '请基于当前任务信息，分析可能存在的风险、阻塞与积压问题，并按严重程度排序，给出简短说明（Markdown）。',
  suggestion: '请基于当前任务信息，给出下一个周期的改进建议、优先级安排与资源投入建议（Markdown）。',
};

/**
 * 右侧 AI 控制台：受控组件，AI 工具列表/选中项由父级（ReportPage）统一持有，与 AI 周报生成共享同一模型选择。
 * AI 周报生成采用流式（SSE），父级把阶段日志与洞察增量传入，这里滚动展示，实现"按钮联动控制台 + 流式滚动输出"。
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
  readonly period?: 'day' | 'week' | 'month';
  readonly streaming?: boolean;
  readonly logs?: string[];
  readonly streamText?: string;
}) {
  // 分析选项与已产生答案改为会话级持久化（useSessionState）：切换页面返回保留输入选择与上次分析结果
  const [category, setCategory] = useSessionState<(typeof CATEGORIES)[number]['key']>('rptconsole.category', 'summary');
  const [custom, setCustom] = useSessionState('rptconsole.custom', '');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useSessionState<{ content: string; error?: string } | null>('rptconsole.answer', null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 结果或流式内容更新时滚到底部，保证"流式滚动输出"始终跟随最新内容
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [answer, logs, streamText]);

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

  const ask = useCallback(async () => {
    if (!toolId) {
      setAnswer({ content: '', error: '请先在「模型管理」页配置并选择 AI 工具' });
      return;
    }
    const user = category === 'custom' ? custom.trim() : PRESET_PROMPTS[category];
    if (!user) {
      setAnswer({ content: '', error: '请输入分析问题' });
      return;
    }
    setBusy(true);
    setAnswer(null);
    try {
      // 周期类预设（非自定义）附带当前周期，后端据此聚合真实任务数据注入；自定义问答不附带以保持纯对话
      const body: Record<string, unknown> = {
        toolId,
        system: '你是 MTask 的 AI 助手，基于任务与报表背景，用简洁专业的中文回答，并使用 Markdown 组织输出。',
        user,
      };
      if (category !== 'custom' && period) body.period = period;
      const r = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/chat', body);
      if (r.ok && r.content) setAnswer({ content: r.content });
      else setAnswer({ content: '', error: r.error ?? 'AI 未返回结果' });
    } catch (e) {
      setAnswer({ content: '', error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [toolId, category, custom, period]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--card-bg)', height: '100%', minHeight: 420 }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
        <Terminal size={14} /> AI 控制台
        {busy && <span style={{ fontSize: 11, color: 'var(--accent)' }}>分析中…</span>}
      </div>

      {/* 工具选择 */}
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>AI 工具</div>
        <select value={toolId} onChange={(e) => onToolIdChange(e.target.value)} style={{ width: '100%', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, background: 'var(--card-bg)', color: 'var(--text)' }}>
          {tools.length === 0 && <option value="">（未配置可用工具）</option>}
          {tools.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.type}）· {t.model}</option>)}
        </select>
      </div>

      {/* 分析类别 / 自定义 */}
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>分析内容</div>
        <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} style={{ width: '100%', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, background: 'var(--card-bg)', color: 'var(--text)' }}>
          {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        {category === 'custom' && (
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            rows={3}
            placeholder="输入你的分析问题…"
            style={{ width: '100%', marginTop: 6, padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, boxSizing: 'border-box', background: 'var(--card-bg)', color: 'var(--text)' }}
          />
        )}
      </div>

      <button
        onClick={() => void ask()}
        disabled={busy}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: 6, cursor: 'pointer', border: 'none', justifyContent: 'center' }}
      >
        <Send size={13} /> {busy ? '分析中…' : '开始分析'}
      </button>

      {toolId && (
        <button
          onClick={() => { setAnswer(null); setCustom(''); }}
          title="清空并重置控制台"
          style={{ alignSelf: 'flex-end', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', background: 'transparent', border: 'none' }}
        >
          <RefreshCw size={12} /> 重置
        </button>
      )}

      {/* 结果区：AI 周报生成阶段日志 + 洞察流式滚动在上，手动分析结果在下 */}
      <div
        ref={bodyRef}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: 'var(--surface)' }}
      >
        {(streaming || logs.length > 0 || streamText) && (
          <div style={{ marginBottom: 10 }}>
            {/* 生成中提示 + 阶段进度日志 */}
            <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <Sparkles size={13} style={{ color: 'var(--accent)' }} /> AI 周报生成
              {streaming && <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 400 }}>生成中…</span>}
            </div>
            {logItems.map(({ id, log }) => (
              <div key={id} style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '2px 0' }}>• {log}</div>
            ))}
            {/* AI 洞察正文：流式增量实时渲染 */}
            {streamText && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>AI 洞察（实时）</div>
                <div style={{ fontSize: 12, color: 'var(--text)' }}>
                  <MarkdownContent content={streamText} />
                </div>
              </div>
            )}
            {!streaming && streamText && (
              <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6 }}>✓ 洞察生成完成，可在左侧下载文件。</div>
            )}
          </div>
        )}
        {!answer && !busy && !streaming && logs.length === 0 && !streamText && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>选择分析内容后点击「开始分析」，AI 结果会在下方以 Markdown 展示；点击左侧「AI 周报生成」此处会实时滚动生成全过程。</div>
        )}
        {!answer && busy && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI 正在分析…</div>}
        {answer?.error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{answer.error}</div>}
        {answer?.content && <MarkdownContent content={answer.content} />}
      </div>
    </div>
  );
}