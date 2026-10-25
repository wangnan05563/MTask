import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { api, type ExecSession } from '../api/client';
import { EmptyState } from '../ui/EmptyState';
import { focusTaskByNo } from '../ui/focusTask';
import { fullTime, relTime } from '../ui/format';
import { platformLabel } from '../ui/platformLabel';

/**
 * T01271-FR1.4：「执行会话」面板——展示外部平台会话的存活 / 进度 / 阶段 / 停滞标记。
 *
 * T03175（AI-402）升级：活跃且可见时刷新 ≤2 秒（隐藏页降频 15 秒）、停滞/失败会话一键重派
 * （经服务端复用既有 RelayDispatch 链路）、任务 chip 点击直达任务详情（focusTaskByNo 定位高亮）。
 * 停滞标记仍完全由服务端写入，前端不做二次推断；重派动作也只在服务端校验后执行（单一口径）。
 */

/** AI-402④：可见时 ≤2 秒刷新；隐藏页降频（与队列页 15 秒轮询同档） */
const ACTIVE_POLL_MS = 2000;
const HIDDEN_POLL_MS = 15000;

/** 可重派状态（PRD §8：心跳超时→stalled、平台报错→failed 才有一键重派；其余状态服务端整单拒绝） */
const REDISPATCHABLE = new Set(['stalled', 'failed']);

/** `POST /exec-sessions/:id/redispatch` 响应（服务端 RedispatchSessionResult 镜像） */
interface RedispatchEntry {
  taskId: string;
  taskNo: string | null;
  dispatched: boolean;
  skipped?: 'not_found' | 'archived' | 'not_todo';
  state?: string;
  ok?: boolean;
  detail?: string;
}
interface RedispatchResponse {
  ok: boolean;
  reason?: string;
  platform?: string;
  entries: RedispatchEntry[];
}

/** 会话状态展示口径（PRD §8 状态机） */
const STATUS_META: Record<string, { label: string; color: string }> = {
  active: { label: '存活', color: 'var(--success)' },
  stalled: { label: '停滞', color: 'var(--danger)' },
  done: { label: '已完成', color: 'var(--text-muted)' },
  failed: { label: '失败', color: 'var(--danger)' },
  aborted: { label: '已中止', color: 'var(--text-muted)' },
};

const card: CSSProperties = {
  background: 'var(--card-bg)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: '12px 14px',
};

const chip: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-secondary)',
  background: 'var(--surface-2)',
  borderRadius: 6,
  padding: '2px 8px',
  maxWidth: 320,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function ExecSessionsPage() {
  const [rows, setRows] = useState<ExecSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await api.get<ExecSession[]>('/exec-sessions'));
      setError('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  // AI-402④：可见时 2 秒心跳级刷新，切到后台降频 15 秒；回到前台立即拉一次并恢复快档
  useEffect(() => {
    void load();
    let timer = setInterval(() => void load(), document.hidden ? HIDDEN_POLL_MS : ACTIVE_POLL_MS);
    const reschedule = () => {
      clearInterval(timer);
      timer = setInterval(() => void load(), document.hidden ? HIDDEN_POLL_MS : ACTIVE_POLL_MS);
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', reschedule);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', reschedule);
    };
  }, [load]);

  const alive = rows.filter((r) => r.status === 'active').length;
  const stalled = rows.filter((r) => r.status === 'stalled').length;
  const finished = rows.filter((r) => r.status === 'done').length;

  // S3358：嵌套三元展开为 if/else 语句
  let content: ReactNode;
  if (loading) {
    content = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)' }}>
        <Loader2 size={14} style={{ animation: 'exec-spin 1s linear infinite' }} /> 加载中…
      </div>
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={<Activity size={22} />}
        title="暂无执行会话"
        hint="外部平台接入 mtask_report_progress 周期上报后，会话将在此展示存活、进度、阶段与停滞标记。"
      />
    );
  } else {
    content = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((s) => <SessionCard key={s.id} s={s} />)}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{'@keyframes exec-spin { to { transform: rotate(360deg) } }'}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Activity size={20} style={{ color: 'var(--accent)' }} />
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 17, color: 'var(--text)' }}>执行会话</h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            外部 AI 平台（qcoder / WorkBuddy / 中继）执行任务期间上报的会话存活与进度；页面可见时每 2 秒刷新，隐藏时降为 15 秒
          </div>
        </div>
        <button
          className="tbtn-anim"
          onClick={() => void load()}
          title="刷新列表"
          aria-label="刷新：重新拉取执行会话列表"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '6px 12px',
            background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)',
            borderRadius: 8, cursor: 'pointer',
          }}
        >
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <Stat label="存活" value={alive} color="var(--success)" />
        <Stat label="停滞" value={stalled} color="var(--danger)" />
        <Stat label="已完成" value={finished} color="var(--text-muted)" />
      </div>

      {error && <div style={{ fontSize: 13, color: 'var(--danger)' }}>加载失败：{error}</div>}

      {content}
    </div>
  );
}

function Stat({ label, value, color }: { readonly label: string; readonly value: number; readonly color: string }) {
  return (
    <div style={{ ...card, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 600, color }}>{value}</span>
    </div>
  );
}

function SessionCard({ s }: { readonly s: ExecSession }) {
  const meta = STATUS_META[s.status] ?? { label: s.status || '未知', color: 'var(--text-muted)' };
  const pct = Math.max(0, Math.min(100, Math.round(s.progress ?? 0)));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const redispatchable = REDISPATCHABLE.has(s.status);

  const redispatch = async () => {
    setBusy(true);
    setNotice('');
    try {
      const r = await api.post<RedispatchResponse>(`/exec-sessions/${s.id}/redispatch`);
      if (r.reason) { setNotice(`不可重派：${r.reason === 'status_not_redispatchable' ? '会话当前状态不允许（仅停滞/失败可重派）' : '会话不存在'}`); } else {
        const done = r.entries.filter((e) => e.dispatched && e.ok).map((e) => e.taskNo ?? e.taskId.slice(0, 8));
        const failed = r.entries.filter((e) => e.dispatched && !e.ok);
        const skipped = r.entries.filter((e) => !e.dispatched);
        setNotice([
          done.length ? `已重派 ${done.length} 条（${done.join('、')}）` : '',
          failed.length ? `${failed.length} 条派发未成：${failed.map((e) => e.detail ?? e.state ?? '').join('；')}` : '',
          skipped.length ? `${skipped.length} 条跳过（${skipped.map((e) => e.skipped === 'archived' ? '已归档' : e.skipped === 'not_todo' ? '非待办' : '已删除').join('、')}）` : '',
        ].filter(Boolean).join('｜') || '该会话没有可重派的任务');
      }
    } catch (e) {
      setNotice(`重派请求失败：${(e as Error).message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: meta.color, border: `1px solid ${meta.color}`, borderRadius: 999, padding: '1px 8px' }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{platformLabel(s.platform)}</span>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--text-muted)' }}>{s.session_id ?? '-'}</span>
        <span style={{ flex: 1 }} />
        <span title={fullTime(s.last_heartbeat)} style={{ fontSize: 12, color: redispatchable ? 'var(--danger)' : 'var(--text-muted)' }}>
          心跳 {relTime(s.last_heartbeat)}
        </span>
        {redispatchable && (
          <button
            data-lck="redispatch-btn"
            className="tbtn-anim"
            onClick={() => void redispatch()}
            disabled={busy}
            aria-label={`重派会话 ${s.session_id ?? s.id} 的停滞任务`}
            title="一键重派：经中继把该会话关联的待办任务重新派发（复用既有派发链路）"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '3px 10px',
              background: 'var(--surface-2)', color: 'var(--danger)', border: '1px solid var(--danger)',
              borderRadius: 8, cursor: 'pointer',
            }}
          >
            <RotateCcw size={12} style={{ animation: busy ? 'exec-spin 1s linear infinite' : undefined }} /> {busy ? '重派中' : '重派'}
          </button>
        )}
      </div>

      {s.phase && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>阶段：{s.phase}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: meta.color, transition: 'width .3s ease' }} />
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 34, textAlign: 'right' }}>{pct}%</span>
      </div>

      {s.tasks.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {s.tasks.map((t) => (
            <button
              key={t.id}
              data-lck="task-chip"
              onClick={() => void focusTaskByNo(t.task_no, 'notice')}
              title={`${t.task_no ?? ''} ${t.title}——点击直达任务`}
              style={{ ...chip, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)', textAlign: 'left', font: 'inherit' }}
            >
              {t.task_no ? `${t.task_no} · ` : ''}{t.title}
            </button>
          ))}
        </div>
      )}

      {notice && <div data-lck="redispatch-notice" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{notice}</div>}
    </div>
  );
}