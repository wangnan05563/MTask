/**
 * T06250/T06251/T06252/T06254（十期）：任务详情「派发」入口。
 *
 * 交互边界：
 * - 先做前端前置校验（归档/非 todo/running），服务端仍会再校验一次；
 * - 菜单只列当前状态可用的通道；CodeBuddy 网关未配置时禁用并直接显示原因；
 * - 自动通道会展示「CodeBuddy 网关 → MCP 就绪池 → 人工确认」三段 attempts；
 *   自动调度永不自动进入人工确认，手动人工确认必须二次确认；
 * - 提交中禁用按钮，防止重复点击；请求带 10 分钟桶的幂等键。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Loader2, Send, ShieldAlert, XCircle } from 'lucide-react';
import { api, type DispatchAttemptView, type DispatchChannel, type DispatchResultView, type DispatchStatusView, type Task } from '../api/client';
import {
  DISPATCH_CHANNEL_LEGEND,
  dispatchChannelName,
  dispatchErrorCodeLabel,
  humanizeDispatchText,
} from '../ui/dispatchChannel';
import { BADGE, BADGE_TONE, BTN_SECONDARY, FIELD } from '../ui/primitives';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Props {
  task: Task;
  onDispatched?: () => void;
}

function stateLabel(state: string): string {
  if (state === 'running') return '已受理，等待结果';
  if (state === 'done') return '同步完成';
  if (state === 'ready') return '已回就绪池';
  if (state === 'manual') return '待人工确认';
  return '失败';
}

function stateTone(state: string): { color: string; icon: ReactNode } {
  if (state === 'running' || state === 'done') return { color: 'var(--success)', icon: <CheckCircle2 size={13} /> };
  if (state === 'ready' || state === 'manual') return { color: 'var(--warn)', icon: <Clock size={13} /> };
  return { color: 'var(--danger)', icon: <XCircle size={13} /> };
}

function maskTicket(ticket?: string): string {
  if (!ticket) return '';
  return ticket.length <= 12 ? ticket : `${ticket.slice(0, 8)}…${ticket.slice(-3)}`;
}

function attemptLine(a: DispatchAttemptView) {
  const tone = stateTone(a.state);
  return (
    <div key={`${a.channel}-${a.state}-${a.attemptId ?? ''}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '3px 0', fontSize: 'var(--fs-xs)' }}>
      <span style={{ color: tone.color, flexShrink: 0, marginTop: 1 }}>{tone.icon}</span>
      <span style={{ fontWeight: 600, flexShrink: 0 }}>{dispatchChannelName(a.channel)}</span>
      <span style={{ color: tone.color, flexShrink: 0 }}>{stateLabel(a.state)}</span>
      {a.code && (
        <span title={`错误码：${a.code}`} style={{ color: 'var(--danger)', flexShrink: 0, fontSize: 'var(--fs-xs)' }}>
          {dispatchErrorCodeLabel(a.code)}
        </span>
      )}
      <span style={{ color: 'var(--text-secondary)', minWidth: 0, wordBreak: 'break-word' }}>{humanizeDispatchText(a.detail)}</span>
    </div>
  );
}

export function DispatchMenu({ task, onDispatched }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DispatchStatusView | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState<DispatchChannel | ''>('');
  const [gateBusy, setGateBusy] = useState(false);
  const [autoGate, setAutoGate] = useState<number | null>(task.dispatch_auto ?? null);
  const [result, setResult] = useState<DispatchResultView | null>(null);
  const [submitError, setSubmitError] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const blockedReason = useMemo(() => {
    if (task.archived) return '任务已归档，不能派发';
    if (task.status !== 'todo') return '仅待办任务可派发';
    if (task.ai_state === 'running') return '任务执行中，避免双跑';
    return '';
  }, [task.archived, task.status, task.ai_state]);

  useEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 360)),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 360)),
      });
    }
    let alive = true;
    setStatusError('');
    api.get<DispatchStatusView>('/dispatch/status')
      .then((s) => { if (alive) setStatus(s); })
      .catch((e) => { if (alive) setStatusError(errText(e)); });
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  async function submit(channel: DispatchChannel) {
    if (blockedReason || busy) return;
    if (channel === 'd' && !window.confirm('人工确认只做状态标记：会把任务标记为需人工确认，不会自动打开 GUI。继续？')) return;
    setBusy(channel);
    setSubmitError('');
    setResult(null);
    try {
      const bucket = Math.floor(Date.now() / 600_000);
      const r = await api.post<DispatchResultView>('/dispatch/task', {
        taskNo: task.task_no ?? task.id,
        channel,
        idempotencyKey: `${task.task_no ?? task.id}:${channel}:${bucket}`,
      });
      setResult(r);
      onDispatched?.();
    } catch (e) {
      setSubmitError(errText(e));
    } finally {
      setBusy('');
    }
  }

  async function toggleAutoGate(next: boolean) {
    if (gateBusy) return;
    setGateBusy(true);
    setSubmitError('');
    try {
      await api.patch<Task>(`/tasks/${encodeURIComponent(task.id)}`, { dispatchAuto: next ? null : 0 });
      setAutoGate(next ? null : 0);
      onDispatched?.();
    } catch (e) {
      setSubmitError(errText(e));
    } finally {
      setGateBusy(false);
    }
  }

  const b0Ready = Boolean(status?.b0.configured);
  const gatewayHint = status?.b0.reason ? humanizeDispatchText(status.b0.reason) : '未配置 CodeBuddy 网关工具';
  const channelOptions: Array<{ key: DispatchChannel; label: string; hint: string; disabled?: boolean }> = [
    {
      key: 'auto',
      label: '自动派发（网关 → 就绪池 → 人工）',
      hint: b0Ready
        ? 'CodeBuddy 网关失败先回 MCP 就绪池；均失败转人工确认（仅手动入口，不自动执行）'
        : 'CodeBuddy 网关未配置，将直接尝试 MCP 就绪池，必要时转人工确认',
    },
    { key: 'b0', label: 'CodeBuddy 网关', hint: b0Ready ? `直推 ${status?.b0.toolName ?? 'CodeBuddy 网关'}` : gatewayHint, disabled: !b0Ready },
    { key: 'a', label: 'MCP 就绪池', hint: '把任务放回就绪池，等外部 Agent 自己来领' },
    { key: 'd', label: '人工确认', hint: '只标记待人工确认，不自动打开 GUI' },
  ];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={Boolean(blockedReason)}
        title={blockedReason || '派发任务：自动 / CodeBuddy 网关 / MCP 就绪池 / 人工确认'}
        aria-label={blockedReason ? `派发不可用：${blockedReason}` : '派发任务'}
        style={{ ...BTN_SECONDARY, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: blockedReason ? 0.5 : 1, cursor: blockedReason ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
      >
        <Send size={13} /> 派发 <ChevronDown size={12} />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="任务派发"
          style={{
            position: 'fixed', top: position.top, left: position.left, zIndex: 3000, width: 344,
            background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 10,
            boxShadow: '0 12px 34px rgba(0,0,0,.22)', padding: 10, color: 'var(--text)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Send size={14} style={{ color: 'var(--accent)' }} />
            <b style={{ fontSize: 'var(--fs-s)' }}>派发 {task.task_no ?? ''}</b>
            <span style={{ flex: 1 }} />
            {task.dispatch_last_at && (
              <span style={{ ...BADGE, ...BADGE_TONE.neutral }} title={new Date(task.dispatch_last_at).toLocaleString('zh-CN', { hour12: false })}>
                最近 {stateLabel(task.dispatch_last_state ?? '')}
              </span>
            )}
          </div>
          {blockedReason ? (
            <div style={{ ...BADGE, ...BADGE_TONE.danger, display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px' }}>
              <ShieldAlert size={13} /> {blockedReason}
            </div>
          ) : (
            <>
              {statusError && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)', marginBottom: 6, display: 'flex', gap: 6 }}>
                  <AlertTriangle size={12} /> 派发状态加载失败：{statusError}
                </div>
              )}
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 6 }}>
                通道口径：{DISPATCH_CHANNEL_LEGEND}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {channelOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={Boolean(opt.disabled) || Boolean(busy)}
                    onClick={() => void submit(opt.key)}
                    title={opt.hint}
                    style={{
                      ...FIELD, textAlign: 'left', cursor: opt.disabled || busy ? 'not-allowed' : 'pointer',
                      opacity: opt.disabled ? 0.5 : 1, background: 'var(--surface-2)', borderColor: opt.key === 'd' ? 'var(--warn)' : 'var(--border)',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                      {busy === opt.key ? <Loader2 size={12} className="aispin" /> : <Send size={12} />}
                      {opt.label}
                    </span>
                    <span style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{opt.hint}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {submitError && (
            <div style={{ marginTop: 7, fontSize: 'var(--fs-xs)', color: 'var(--danger)', display: 'flex', gap: 5 }}>
              <AlertTriangle size={12} /> {humanizeDispatchText(submitError)}
            </div>
          )}
          {result && (
            <div style={{ marginTop: 8, paddingTop: 7, borderTop: '1px solid var(--border)', fontSize: 'var(--fs-xs)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                <b style={{ color: stateTone(result.state).color }}>{stateLabel(result.state)}</b>
                <span style={{ color: 'var(--text-muted)' }}>最终通道 {dispatchChannelName(result.channel)}</span>
                {result.attemptId && <span style={{ color: 'var(--text-muted)' }} title={result.attemptId}>审计 {result.attemptId.slice(0, 8)}</span>}
              </div>
              {result.attempts.map(attemptLine)}
              {result.fallbackReason && (
                <div style={{ marginTop: 4, color: 'var(--text-muted)', wordBreak: 'break-word' }}>
                  降级原因：{humanizeDispatchText(result.fallbackReason)}
                </div>
              )}
              {result.attempts.some((a) => a.ticket) && (
                <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
                  ticket：{result.attempts.filter((a) => a.ticket).map((a) => maskTicket(a.ticket)).join(' / ')}
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 8, paddingTop: 7, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)' }}>
            <input
              id={`dispatch-auto-gate-${task.id}`}
              type="checkbox"
              checked={autoGate !== 0}
              disabled={gateBusy}
              onChange={(e) => void toggleAutoGate(e.target.checked)}
            />
            <label htmlFor={`dispatch-auto-gate-${task.id}`} style={{ cursor: gateBusy ? 'wait' : 'pointer', color: 'var(--text-secondary)' }}>
              允许自动派发{gateBusy ? '（保存中…）' : ''}
            </label>
            <span style={{ color: 'var(--text-muted)' }}>{autoGate === 0 ? '仅手动/API' : '跟随全局策略'}</span>
          </div>
          <div style={{ marginTop: 7, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            自动调度的候选需同时满足：待办、未归档、未搁置、AI 状态为空、已就绪、未被显式指定给其他平台。
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
