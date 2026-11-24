import { AlertTriangle, CheckCircle2, Clock3, FileDiff, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RunRiskApproval, RunRiskLevel } from '../api/client';
import { fullTime } from '../ui/format';
import './approvalModal.css';

const RISK_LABEL: Record<RunRiskLevel, string> = {
  R0: 'R0 只读',
  R1: 'R1 可逆写',
  R2: 'R2 覆盖/删除',
  R3: 'R3 不可逆',
};

/** 审批是未来时点：relTime 只算「过去」，会把 24h 后的超时误显示成「刚刚」。 */
function expiryLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '-';
  if (ms <= 0) return '已超时';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.floor(hours / 24)} 天后`;
}

function DiffView({ diff }: { readonly diff: string }) {
  const lines = diff.split(/\r?\n/);
  if (!diff.trim()) {
    return <div className="approval-empty" data-lck="approval-diff-empty">未提供 diff，请结合动作与影响范围判断。</div>;
  }
  return (
    <pre className="approval-diff" data-lck="approval-diff" aria-label="变更 diff 预览">
      {lines.map((line, index) => {
        const cls = line.startsWith('+++') || line.startsWith('---')
          ? 'approval-diff-meta'
          : line.startsWith('@@')
            ? 'approval-diff-hunk'
            : line.startsWith('+')
              ? 'approval-diff-add'
              : line.startsWith('-')
                ? 'approval-diff-del'
                : '';
        return <span className={cls} key={`${index}-${line.slice(0, 8)}`}>{line || ' '}{'\n'}</span>;
      })}
    </pre>
  );
}

/**
 * T06300（REQ-007 / PRD §B7）：人工审批弹窗。
 *
 * 只展示服务端已落库的审批实体：动作、影响范围、diff、预览、请求者与超时；
 * 决策仅调用 /api/run-risk/approvals/:id/decision，不在前端推断风险或伪造批准。
 */
export function ApprovalModal({
  approval, submitting, error, onApprove, onReject, onClose,
}: {
  readonly approval: RunRiskApproval;
  readonly submitting: boolean;
  readonly error: string;
  readonly onApprove: (reason: string) => void;
  readonly onReject: (reason: string) => void;
  readonly onClose: () => void;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!submitting) onClose();
    };
    globalThis.addEventListener('keydown', onKey, true);
    return () => globalThis.removeEventListener('keydown', onKey, true);
  }, [onClose, submitting]);

  return (
    <div
      className="approval-overlay"
      data-lck="approval-modal"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <header className="approval-head">
          <div className="approval-head-title">
            <span className={`approval-risk approval-risk-${approval.riskLevel}`} data-lck="approval-risk">
              <ShieldAlert size={14} />{RISK_LABEL[approval.riskLevel]}
            </span>
            <div>
              <h2 id="approval-title">人工审批</h2>
              <p>高风险动作已暂停，确认影响范围后再决定是否继续。</p>
            </div>
          </div>
          <button className="approval-close" onClick={onClose} disabled={submitting} aria-label="关闭审批弹窗" title="关闭（Esc）">
            <XCircle size={18} />
          </button>
        </header>

        <div className="approval-meta">
          <span><strong>动作</strong>{approval.action || '未命名动作'}</span>
          <span><strong>请求者</strong>{approval.requester || '—'}</span>
          <span><strong>Run</strong><code title={approval.runId}>{approval.runId}</code></span>
          <span><strong>创建</strong>{fullTime(approval.createdAt)}</span>
          <span className="approval-expiry" title={`超时：${fullTime(approval.expiresAt)}`}>
            <Clock3 size={13} />
            <strong>剩余</strong>{expiryLabel(approval.expiresAt)}
          </span>
        </div>

        <div className="approval-section">
          <h3>影响范围</h3>
          <p className="approval-impact" data-lck="approval-impact">{approval.impact || '未提供影响范围。'}</p>
        </div>

        <div className="approval-section approval-diff-section">
          <h3><FileDiff size={15} />变更预览</h3>
          <DiffView diff={approval.diff} />
        </div>

        {approval.preview.trim() && (
          <div className="approval-section">
            <h3>执行预览</h3>
            <pre className="approval-preview" data-lck="approval-preview">{approval.preview}</pre>
          </div>
        )}

        <div className="approval-decision">
          <label htmlFor="approval-reason">决策备注（可选，会写入审计）</label>
          <textarea
            id="approval-reason"
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：影响范围已确认；或说明拒绝原因"
            disabled={submitting}
            data-lck="approval-reason"
          />
          {error && <div className="approval-error" role="alert" data-lck="approval-error"><AlertTriangle size={14} />{error}</div>}
          <div className="approval-actions">
            <button className="approval-btn approval-btn-reject" onClick={() => onReject(reason)} disabled={submitting} data-lck="approval-reject">
              {submitting ? <span className="approval-spinner" /> : <XCircle size={15} />}拒绝并终止
            </button>
            <button className="approval-btn approval-btn-approve" onClick={() => onApprove(reason)} disabled={submitting} data-lck="approval-approve">
              {submitting ? <span className="approval-spinner" /> : <CheckCircle2 size={15} />}批准并继续
            </button>
          </div>
          <p className="approval-foot"><ShieldCheck size={13} />决策会写入不可篡改审计；拒绝在动作执行前生效。</p>
        </div>
      </section>
    </div>
  );
}
