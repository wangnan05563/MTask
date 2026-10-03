/**
 * T01433（mtask三期 3.4）：执行会话监控页（移动端）。
 * 会话列表徽标 + 心跳相对时间 + phase 摘要 + 进度条；10s 轮询；
 * failed 会话一键重派（复用任务 retry API，回待办等待重新领取）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { fmtAsOf, loadStaleCache, saveStaleCache } from './offline';
import { Badge, bodyStyle, cardStyle, EmptyState, type BadgeTone } from './ui';

interface ExecSessionView {
  id: string;
  platform: string;
  session_id: string | null;
  status: string;
  progress: number;
  phase: string;
  last_heartbeat: string;
  started_at: string;
  finished_at: string | null;
  tasks: { id: string; task_no: string | null; title: string }[];
}

const STATUS_LABEL: Record<string, string> = { active: '运行中', failed: '失败', stalled: '停滞', done: '已完成' };
const STATUS_TONE: Record<string, BadgeTone> = { active: 'accent', failed: 'danger', stalled: 'danger', done: 'success' };

/** 心跳相对时间（分钟粒度；超 10 分钟告警色语义由调用方判断） */
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  return `${h} 小时前`;
}

export function MobileExecSessions({ notify }: { readonly notify: (msg: string, isErr?: boolean) => void }) {
  const [sessions, setSessions] = useState<ExecSessionView[]>([]);
  const [staleAsOf, setStaleAsOf] = useState<string | null>(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const list = await api.get<ExecSessionView[]>('/exec-sessions');
      setSessions(list);
      saveStaleCache('exec.sessions', list);
      setStaleAsOf(null);
    } catch {
      const cached = loadStaleCache<ExecSessionView[]>('exec.sessions');
      if (cached) { setSessions(cached.data); setStaleAsOf(cached.asOf); }
      // 无缓存且离线：静默（横幅已全局提示）
    }
  }, []);

  useEffect(() => {
    const cached = loadStaleCache<ExecSessionView[]>('exec.sessions');
    if (cached) { setSessions(cached.data); setStaleAsOf(cached.asOf); }
    void load();
    // 评审修复：页面不可见时暂停轮询（省电省流量），恢复可见立即刷新
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { timer ??= setInterval(() => void load(), 10000); void load(); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    start();
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  async function redispatch(s: ExecSessionView) {
    const target = s.tasks.find((t) => t.task_no);
    if (!target?.task_no) { notify('该会话无关联任务编号，请到桌面端处理', true); return; }
    setBusyId(s.id);
    try {
      await api.post(`/tasks/by-no/${target.task_no}/retry`, {});
      notify(`已重派：${target.task_no} 回到待办，等待 AI 重新领取`);
      void load();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    } finally { setBusyId(''); }
  }

  return (
    <div style={bodyStyle}>
      {staleAsOf && (
        <div style={{ marginBottom: 8, padding: '5px 10px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 12 }}>
          ⏱ 数据截至 {fmtAsOf(staleAsOf)}（离线缓存，联网后自动更新）
        </div>
      )}
      {sessions.length === 0 && <EmptyState icon="🛰️" message="暂无执行会话" hint="AI 开始执行任务后会话会出现在这里" />}
      {sessions.map((s) => {
        const heartbeatStale = s.status === 'active' && Date.now() - new Date(s.last_heartbeat).getTime() > 10 * 60 * 1000;
        return (
          <div key={s.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{s.platform}</span>
              {s.session_id && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.session_id.slice(0, 8)}</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: heartbeatStale ? 'var(--danger)' : 'var(--text-muted)' }}>
                心跳 {relTime(s.last_heartbeat)}{heartbeatStale ? '（停滞?）' : ''}
              </span>
            </div>
            {s.phase && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>phase：{s.phase}</div>}
            {s.tasks.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                {s.tasks.slice(0, 3).map((t) => (
                  <div key={t.id} style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.task_no ? `${t.task_no} · ` : ''}{t.title}
                  </div>
                ))}
                {s.tasks.length > 3 && <div style={{ color: 'var(--text-muted)' }}>…共 {s.tasks.length} 条</div>}
              </div>
            )}
            <div style={{ marginTop: 8, height: 6, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
              <div style={{ width: `${s.progress}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 4, gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>进度 {s.progress}%</span>
              {s.status === 'failed' && (
                <button
                  onClick={() => void redispatch(s)}
                  disabled={busyId === s.id}
                  title="重派 — 将该会话关联任务回待办，等待 AI 重新领取（历次结果保留）"
                  style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--danger)', color: 'var(--danger)', background: 'transparent', cursor: busyId === s.id ? 'wait' : 'pointer' }}
                >
                  {busyId === s.id ? '重派中…' : '一键重派'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 供「更多」入口徽标：active/failed 会话数（失败优先提示） */
export async function fetchExecSessionBadge(): Promise<{ failed: number; active: number }> {
  try {
    const list = await api.get<ExecSessionView[]>('/exec-sessions');
    return { failed: list.filter((s) => s.status === 'failed' || s.status === 'stalled').length, active: list.filter((s) => s.status === 'active').length };
  } catch { return { failed: 0, active: 0 }; }
}

export type { ExecSessionView };
export type { Task } from '../api/client';
