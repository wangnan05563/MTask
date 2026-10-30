import { useEffect, useRef, useState } from 'react';
import { MessageSquareText, X, Send, Loader2, AlertTriangle, FileCode2, ShieldCheck, ThumbsUp, ThumbsDown } from 'lucide-react';
import { api, type Project } from '../api/client';
import { OVERLAY_MASK } from './primitives';

/**
 * T03250（PRD 5.1）：工作空间只读问答面板。
 *
 * 后端 POST /workspace/ask 的证据收集与引用校验都在服务端完成（见 services/workspaceQa.ts），
 * 前端只负责「提问 → 渲染回答 + 引用 chips → 点引用看原文」。引用 chip 的 path:line 是服务端
 * 校验过的（必须在证据集合里），点击走既有 GET /workspace/file 读上下文，与全文检索面板一致。
 *
 * 只读：本组件除 /workspace/file 与 /workspace/ask 外不调任何写接口。
 */

interface Citation { path: string; line: number; symbol?: string }
interface AskResp {
  ok: boolean;
  answer?: string;
  citations: Citation[];
  evidenceCount: number;
  keywords: string[];
  truncated: boolean;
  contextChars: number;
  kind?: string;
  message?: string;
  error?: string;
  eventId?: string;
}
interface QaStats { asks: number; answered: number; successRate: number; citationClicks: number; citationRate: number; useful: number; useless: number }
interface FileResp { totalLines: number; lines: Array<{ n: number; text: string }> }

const CITE_CONTEXT_LINES = 12;

export function WorkspaceAskPanel({
  project,
  toolId,
  flash,
  onClose,
}: {
  readonly project?: Project | null;
  readonly toolId: string;
  readonly flash?: (m: string) => void;
  readonly onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<AskResp | null>(null);
  const [asked, setAsked] = useState('');
  const [opened, setOpened] = useState<string | null>(null);
  const [file, setFile] = useState<FileResp | null>(null);
  const [stats, setStats] = useState<QaStats | null>(null);
  const [fbSent, setFbSent] = useState<'' | 'useful' | 'useless'>('');
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const bound = project?.workspace_path ?? '';
  const canAsk = !!project && !!bound && !!toolId && !busy;

  useEffect(() => { void refreshStats(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [project?.id]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) onClose();
    };
    globalThis.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => {
      globalThis.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [onClose]);

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  async function refreshStats() {
    if (!project) return;
    try { setStats(await api.get<QaStats>(`/workspace/ask/stats?projectId=${encodeURIComponent(project.id)}`)); } catch { /* 统计不影响问答 */ }
  }
  async function feedback(useful: boolean) {
    if (!project || !resp?.eventId) return;
    try {
      await api.post('/workspace/ask/feedback', { projectId: project.id, eventId: resp.eventId, useful });
      setFbSent(useful ? 'useful' : 'useless');
      void refreshStats();
    } catch (e) { flash?.(e instanceof Error ? e.message : String(e)); }
  }

  async function ask() {
    const question = q.trim();
    if (!project) { flash?.('请先选择要提问的项目'); return; }
    if (!bound) { flash?.('当前项目尚未绑定工作空间'); return; }
    if (!toolId) { flash?.('请先在「模型管理」页添加并选择整理工具'); return; }
    if (question.length < 2) { flash?.('问题至少 2 个字符'); return; }
    setBusy(true); setOpened(null); setFile(null); setAsked(question);
    try {
      const r = await api.post<AskResp>('/workspace/ask', { projectId: project.id, question, toolId });
      setResp(r);
      setFbSent('');
      void refreshStats();
    } catch (e) {
      setResp(null);
      flash?.(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function openCitation(c: Citation) {
    if (!project) return;
    const key = `${c.path}:${c.line}`;
    if (opened === key) { setOpened(null); setFile(null); return; }
    setOpened(key); setFile(null);
    if (resp?.eventId) {
      void api.post('/workspace/ask/citation-click', { projectId: project.id, eventId: resp.eventId, path: c.path, line: c.line })
        .then(() => refreshStats()).catch(() => { /* 埋点失败不挡看原文 */ });
    }
    try {
      const offset = Math.max(0, c.line - 3);
      const r = await api.get<FileResp>(
        `/workspace/file?projectId=${encodeURIComponent(project.id)}&path=${encodeURIComponent(c.path)}&offset=${offset}&limit=${CITE_CONTEXT_LINES}`,
      );
      setFile(r);
    } catch (e) {
      setFile(null);
      flash?.(e instanceof Error ? e.message : String(e));
    }
  }

  function renderBody() {
    if (!project || !bound) {
      return (
        <div data-t03250="blocked" style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>
          当前项目尚未绑定工作空间（项目管理 → 选择工作空间），只读问答不可用。
        </div>
      );
    }
    if (busy) {
      return (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', verticalAlign: '-2px' }} /> 正在检索工作空间并组织回答…
        </div>
      );
    }
    if (!resp) {
      return (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>
          就工作空间里的代码/文档提问，回答只依据检索到的片段并给出可跳转的 file:line 引用。
        </div>
      );
    }
    if (!resp.ok) {
      return (
        <div data-t03250="error" style={{ display: 'flex', gap: 6, padding: '14px 16px', color: 'var(--danger)', fontSize: 'var(--fs-s)' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{resp.message || resp.error || '问答失败'}</span>
        </div>
      );
    }
    const openedCite = opened ? resp.citations.find((c) => `${c.path}:${c.line}` === opened) ?? null : null;
    return (
      <>
        {resp.truncated && (
          <div data-t03250="truncated" style={{ display: 'flex', gap: 6, padding: '7px 16px', background: 'var(--warn-soft, rgba(245,158,11,.12))', color: 'var(--warn, #b45309)', fontSize: 'var(--fs-s)', borderBottom: '1px solid var(--border)' }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>上下文超出预算已截断：仅送入 {resp.contextChars.toLocaleString()} 字符证据，回答可能漏掉部分代码。</span>
          </div>
        )}
        <div data-t03250="answer" style={{ padding: '12px 16px', fontSize: 'var(--fs-m)', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65 }}>
          {resp.answer || '（模型未返回内容）'}
        </div>
        {resp.citations.length > 0 && (
          <div data-t03250="citations" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 16px 10px 16px' }}>
            {resp.citations.map((c) => {
              const key = `${c.path}:${c.line}`;
              const open = opened === key;
              return (
                <button key={key} onClick={() => void openCitation(c)}
                  data-t03250="cite"
                  title={`${c.path}:${c.line} — 点击${open ? '收起' : '查看原文'}`}
                  aria-expanded={open}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 999, background: open ? 'var(--accent-soft)' : 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--fs-xs)', fontFamily: 'monospace' }}>
                  <FileCode2 size={11} style={{ flexShrink: 0 }} />
                  {c.path}:{c.line}
                </button>
              );
            })}
          </div>
        )}
        {opened && openedCite && (
          <div data-t03250="file" style={{ margin: '0 16px 10px 16px', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', background: 'var(--card-bg)' }}>
            <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', margin: '0 0 4px 0' }}>{openedCite.path} · 共 {file?.totalLines ?? '…'} 行</div>
            {file === null ? (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}><Loader2 size={12} style={{ animation: 'spin 1s linear infinite', verticalAlign: '-2px' }} /> 读取中…</div>
            ) : (
              <pre style={{ margin: 0, fontSize: 'var(--fs-xs)', lineHeight: 1.55, color: 'var(--text)', overflowX: 'auto', maxHeight: 240, fontFamily: 'monospace' }}>
                {file.lines.map((l) => (
                  <div key={l.n} style={{ display: 'flex', gap: 10, background: l.n === openedCite.line ? 'var(--accent-soft)' : 'transparent' }}>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0, userSelect: 'none' }}>{l.n}</span>
                    <span>{l.text}</span>
                  </div>
                ))}
              </pre>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div style={{ ...OVERLAY_MASK, position: 'fixed', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div ref={panelRef} aria-label="工作空间只读问答" data-t03250="panel"
        style={{ background: 'var(--card-bg)', borderRadius: 10, width: 780, maxWidth: '94vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,.18)', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <MessageSquareText size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--fs-m)', fontWeight: 600, flex: 1, color: 'var(--text)' }}>工作空间只读问答</span>
          <span title="问答全程只读：不修改任何文件、不写任务数据" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)' }}>
            <ShieldCheck size={11} /> 只读
          </span>
          {bound && <span title={bound} style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{bound}</span>}
          <button onClick={onClose} title="关闭 — 放弃本次问答" aria-label="关闭：放弃本次问答"
            style={{ display: 'inline-flex', padding: 3, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={15} />
          </button>
        </div>

        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }}
            placeholder="例如：任务完成时状态是怎么回写的？（Enter 提问，Shift+Enter 换行）" aria-label="提问内容" rows={2}
            style={{ flex: 1, resize: 'vertical', minHeight: 44, maxHeight: 120, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-m)', fontFamily: 'inherit', boxSizing: 'border-box' }} />
          <button onClick={() => void ask()} disabled={!canAsk}
            data-t03250="ask"
            title={toolId ? '提问 — 只依据工作空间检索片段作答并给出引用' : '请先在「模型管理」页添加并选择整理工具'}
            aria-label="提问"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: canAsk ? 'pointer' : 'not-allowed', opacity: canAsk ? 1 : 0.5, fontSize: 'var(--fs-s)' }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />} 提问
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>{renderBody()}</div>

        {resp?.ok && !busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              问题「{asked}」· 证据 {resp.evidenceCount} 条 / 引用 {resp.citations.length} 处
              {resp.keywords.length > 0 ? ` · 关键词：${resp.keywords.join('、')}` : ''}
              {stats ? ` · 本项目提问 ${stats.asks} 次、成功率 ${pct(stats.successRate)}、引用点击率 ${pct(stats.citationRate)}` : ''}
            </span>
            {resp.eventId && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <span>{fbSent ? '已反馈' : '回答有用吗'}</span>
                <button type="button" onClick={() => void feedback(true)} disabled={!!fbSent}
                  data-t03252="useful" title="有用 — 记一条正反馈（只统计，不改变回答）" aria-label="回答有用"
                  style={{ display: 'inline-flex', padding: 2, border: 'none', background: fbSent === 'useful' ? 'var(--accent-soft)' : 'transparent', color: fbSent === 'useful' ? 'var(--accent)' : 'var(--text-muted)', cursor: fbSent ? 'default' : 'pointer', borderRadius: 4 }}>
                  <ThumbsUp size={12} />
                </button>
                <button type="button" onClick={() => void feedback(false)} disabled={!!fbSent}
                  data-t03252="useless" title="没用 — 记一条负反馈（只统计，不改变回答）" aria-label="回答没用"
                  style={{ display: 'inline-flex', padding: 2, border: 'none', background: fbSent === 'useless' ? 'var(--accent-soft)' : 'transparent', color: fbSent === 'useless' ? 'var(--accent)' : 'var(--text-muted)', cursor: fbSent ? 'default' : 'pointer', borderRadius: 4 }}>
                  <ThumbsDown size={12} />
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
