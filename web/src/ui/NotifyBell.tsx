import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, FileText, ListTodo, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';

/**
 * T01064-FR1.4：全局通知中心（顶栏铃铛）——聚合任务事件（状态/验证/AI 完成/失败/回传）。
 * 未读口径：created_at > localStorage lastSeen；打开面板即视为已读。
 * 轮询 30s 拉最近事件（轻量查询，≤200 条上限由服务端限制）。
 */

const LAST_SEEN_KEY = 'notify.events.lastSeen';
const EVENT_KINDS: Record<string, { icon: React.ReactNode; label: string }> = {
  status: { icon: <ListTodo size={13} />, label: '状态' },
  verified: { icon: <ShieldCheck size={13} />, label: '验证' },
  ai_state: { icon: <CheckCircle2 size={13} />, label: 'AI' },
  result: { icon: <FileText size={13} />, label: '结果' },
};

interface EventItem {
  id: string;
  task_no: string | null;
  task_id: string;
  kind: string;
  detail: string;
  title: string;
  created_at: string;
}

function readLastSeen(): string {
  try { return localStorage.getItem(LAST_SEEN_KEY) ?? ''; } catch { return ''; }
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

export function NotifyBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EventItem[]>([]);
  const [lastSeen, setLastSeen] = useState(readLastSeen);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.get<EventItem[]>('/events/recent?limit=30');
      setItems(Array.isArray(rows) ? rows : []);
    } catch { /* 服务未就绪等：保留上次数据 */ }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => void refresh(), 30000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const unreadCount = items.filter((it) => it.created_at > lastSeen).length;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      void refresh();
      // 打开即视为已读
      const nowIso = new Date().toISOString();
      try { localStorage.setItem(LAST_SEEN_KEY, nowIso); } catch { /* 忽略 */ }
      setLastSeen(nowIso);
    }
  }

  function gotoTask(it: EventItem) {
    if (it.task_no) {
      try { sessionStorage.setItem('tasks.focusId', JSON.stringify(it.task_no)); } catch { /* 忽略 */ }
    }
    globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } }));
    setOpen(false);
  }

  const unreadBadgeSuffix = unreadCount > 0 ? `，${unreadCount} 条未读` : '';
  return (
    <div style={{ position: 'relative', marginLeft: 8 }}>
      <button
        onClick={toggle}
        title={unreadCount ? `通知中心 — ${unreadCount} 条未读` : '通知中心'}
        aria-label={`通知中心${unreadBadgeSuffix}`}
        style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 7, borderRadius: 6, background: 'var(--card-bg)', color: unreadCount ? 'var(--accent)' : 'var(--text)', cursor: 'pointer', border: '1px solid var(--border)' }}
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span style={{ position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, background: 'var(--danger)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <>
          {/* 遮罩：点击外部关闭——纯装饰层（aria-hidden），键盘关闭走 Esc/关闭按钮 */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 998 }}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 380, maxHeight: 480, overflowY: 'auto', background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.15)', zIndex: 999 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Bell size={13} /> 通知中心
              <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>最近 30 条任务事件</span>
            </div>
            {items.length === 0 && (
              <div style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>暂无任务事件——AI 任务分发/回传/验证后自动记录。</div>
            )}
            {items.map((it) => {
              const meta = EVENT_KINDS[it.kind] ?? { icon: <FileText size={13} />, label: it.kind };
              const unread = it.created_at > lastSeen;
              const taskNoSuffix = it.task_no ? ` ${it.task_no}` : '';
              let iconColor = 'var(--accent)';
              if (it.kind === 'ai_state' && it.detail.includes('失败')) iconColor = 'var(--danger)';
              else if (it.kind === 'verified') iconColor = 'var(--success)';
              return (
                <button key={it.id} onClick={() => gotoTask(it)}
                  title={`${it.detail} — 点击前往任务${taskNoSuffix}`}
                  style={{ display: 'flex', gap: 8, width: '100%', textAlign: 'left', padding: '9px 14px', border: 'none', borderBottom: '1px solid var(--surface-2)', background: unread ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', alignItems: 'flex-start' }}
                >
                  <span style={{ marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4, color: iconColor, flexShrink: 0 }}>
                    {it.detail.includes('失败') ? <AlertTriangle size={13} /> : meta.icon}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.task_no ? <b style={{ color: 'var(--accent)' }}>{it.task_no}</b> : null} {it.title || it.detail}
                    </span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {meta.label} · {it.detail} · {relTime(it.created_at)}
                    </span>
                  </span>
                  {unread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', marginTop: 6, flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
