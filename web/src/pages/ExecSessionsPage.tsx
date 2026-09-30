import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { api, type ExecSession } from '../api/client';
import { EmptyState } from '../ui/EmptyState';
import { fullTime, relTime } from '../ui/format';

/**
 * T01271-FR1.4：「执行会话」面板——展示外部平台会话的存活 / 进度 / 阶段 / 停滞标记。
 *
 * M1 阶段仅观测（P0）：面板只读，不提供任何会触发外部平台动作的操作；
 * 停滞标记完全由服务端写入（FR-1.3 定时判定 + 读取路径惰性判定），前端不做二次推断，
 * 避免「前端自己算超时」与服务端口径不一致导致的状态打架。
 */

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

  // 15s 轮询（与队列页任务池同频）：无人操作时也能看到心跳推进与停滞标记出现
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
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
            外部 AI 平台（WorkBuddy / Trae / 中继）执行任务期间上报的会话存活与进度，每 15 秒自动刷新
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
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: meta.color, border: `1px solid ${meta.color}`, borderRadius: 999, padding: '1px 8px' }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{s.platform}</span>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--text-muted)' }}>{s.session_id ?? '-'}</span>
        <span style={{ flex: 1 }} />
        <span title={fullTime(s.last_heartbeat)} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          心跳 {relTime(s.last_heartbeat)}
        </span>
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
            <span key={t.id} style={chip} title={`${t.task_no ?? ''} ${t.title}`}>
              {t.task_no ? `${t.task_no} · ` : ''}{t.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}