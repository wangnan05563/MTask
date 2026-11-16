import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, FileText, ListTodo, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { focusTaskByNo, type FocusOpenMode } from './focusTask';
import { relTime } from './format';
import { ScrollArrows } from './ScrollArrows';

/**
 * T05767：执行会话页右栏通知流。
 *
 * 与顶栏 NotifyBell 共用同一组 `/events/recent` / `/events/unread` 接口，但这里是常驻列表：
 * 页面可见时 5 秒刷新、后台 15 秒；刷新后按 created_at 倒序直接替换，新事件自然出现在顶部。
 * 不复制一套事件语义：kind 图标、系统告警哨兵、点击分流均与 NotifyBell 保持一致。
 */
const LAST_SEEN_KEY = 'notify.events.lastSeen';
const SYSTEM_TASK_ID = 'system';
/** SSE 为主动推送主通道；轮询只做断线兜底，避免 EventSource 被代理断开后列表停更。 */
const VISIBLE_POLL_MS = 30000;
const HIDDEN_POLL_MS = 60000;

const EVENT_KINDS: Record<string, { icon: React.ReactNode; label: string }> = {
  status: { icon: <ListTodo size={13} />, label: '状态' },
  verified: { icon: <ShieldCheck size={13} />, label: '验证' },
  ai_state: { icon: <CheckCircle2 size={13} />, label: 'AI' },
  result: { icon: <FileText size={13} />, label: '结果' },
  system: { icon: <AlertTriangle size={13} />, label: '系统' },
};

export interface EventItem {
  id: string;
  task_no: string | null;
  task_id: string;
  project_id: string;
  project_name: string | null;
  kind: string;
  detail: string;
  title: string;
  created_at: string;
}

function readLastSeen(): string {
  try { return localStorage.getItem(LAST_SEEN_KEY) ?? ''; } catch { return ''; }
}

function drawerTabForEvent(it: EventItem): FocusOpenMode | false {
  if (it.kind === 'result' || it.kind === 'ai_state') return 'notice';
  return false;
}

export function NotificationFeed({ limit = 50 }: { readonly limit?: number }) {
  const [items, setItems] = useState<EventItem[]>([]);
  const [lastSeen] = useState(readLastSeen);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.get<EventItem[]>(`/events/recent?limit=${limit}`);
      // 服务端已按时间倒序；前端再做一次稳定排序，避免不同接口实现把新消息塞到中部。
      setItems((Array.isArray(rows) ? rows : []).slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
      setError('');
      setUpdatedAt(new Date());
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
    // T05767：优先走服务端 SSE（/api/events）——后端写入事件后立即触发刷新；
    // 30s/60s 轮询只是断线兜底，避免代理掐断长连接后右栏停更。
    const offSse = api.openChangeStream?.(() => void refresh());
    let timer = setInterval(() => void refresh(), document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
    const reschedule = () => {
      clearInterval(timer);
      timer = setInterval(() => void refresh(), document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', reschedule);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', reschedule);
      offSse?.();
    };
  }, [refresh]);

  function gotoTask(it: EventItem) {
    const isSystem = it.task_id === SYSTEM_TASK_ID;
    if (!isSystem) void focusTaskByNo(it.task_no, drawerTabForEvent(it));
  }

  const unreadCount = items.filter((it) => it.created_at > lastSeen).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <style>{`
        .notify-feed-scroll { scrollbar-width: none; -ms-overflow-style: none; }
        .notify-feed-scroll::-webkit-scrollbar { display: none; }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px 10px', flexShrink: 0 }}>
        <Bell size={15} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 'calc(var(--fs-m) + 0.5px)', fontWeight: 600, color: 'var(--text)' }}>通知中心</span>
        {unreadCount > 0 && (
          <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: 'var(--danger)', color: 'var(--on-solid)', fontSize: 'var(--fs-2xs)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)' }}>
          {updatedAt ? `更新于 ${relTime(updatedAt.toISOString())}` : '等待刷新'}
        </span>
      </div>

      {error && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)', padding: '0 2px 8px', flexShrink: 0 }}>通知加载失败：{error}</div>}

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={feedRef}
          data-lck="notification-feed"
          className="notify-feed-scroll"
          aria-label={`通知消息列表，共 ${items.length} 条`}
          style={{ height: '100%', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--card-bg)', paddingBottom: 28 }}
        >
        {items.length === 0 && (
          <div style={{ padding: 22, fontSize: 'var(--fs-s)', color: 'var(--text-muted)', textAlign: 'center' }}>暂无通知消息</div>
        )}
        {items.map((it) => {
          const meta = EVENT_KINDS[it.kind] ?? { icon: <FileText size={13} />, label: it.kind };
          const unread = it.created_at > lastSeen;
          const isSystem = it.task_id === SYSTEM_TASK_ID;
          let iconColor = 'var(--accent)';
          if (isSystem || (it.kind === 'ai_state' && it.detail.includes('失败'))) iconColor = 'var(--danger)';
          else if (it.kind === 'verified') iconColor = 'var(--success)';
          return (
            <button
              key={it.id}
              className="row-title-btn"
              onClick={() => gotoTask(it)}
              title={isSystem ? `${it.detail} — 系统告警，无需跳转` : `${it.detail} — 点击前往任务${it.task_no ? ` ${it.task_no}` : ''}`}
              style={{
                display: 'flex', gap: 7, width: '100%', textAlign: 'left', padding: '9px 10px',
                border: 'none', borderBottom: '1px solid var(--surface-2)',
                background: unread ? 'var(--accent-soft)' : 'transparent',
                cursor: isSystem ? 'default' : 'pointer', alignItems: 'flex-start',
              }}
            >
              <span style={{ marginTop: 2, display: 'inline-flex', alignItems: 'center', color: iconColor, flexShrink: 0 }}>
                {it.detail.includes('失败') ? <AlertTriangle size={13} /> : meta.icon}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-s)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.task_no ? <b style={{ color: 'var(--accent)' }}>{it.task_no}</b> : null} {isSystem ? '系统告警' : (it.title || it.detail)}
                </span>
                <span style={{ display: 'flex', fontSize: 'var(--fs-2xs)', color: 'var(--text-secondary)', marginTop: 2, alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  {it.project_name && (
                    <span title={`所属项目：${it.project_name}`} style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-2xs)', padding: '0 5px', borderRadius: 8, border: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}>
                      {it.project_name}
                    </span>
                  )}
                  <span>{meta.label} · {it.detail} · {relTime(it.created_at)}</span>
                </span>
              </span>
              {unread && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', marginTop: 6, flexShrink: 0 }} />}
            </button>
          );
        })}
        </div>
        <ScrollArrows targetRef={feedRef} label="通知消息" />
      </div>
    </div>
  );
}
