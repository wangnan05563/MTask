import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, FileText, ListTodo, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { focusTaskByNo, type FocusOpenMode } from './focusTask'; // T01057 建议：通知点击跨项目定位；T01568：按需直达抽屉并指定落位

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
  // T01061 后续：系统级告警（如数据库备份失败）——不关联任务，哨兵 task_id='system'
  system: { icon: <AlertTriangle size={13} />, label: '系统' },
};

/** T01061 后续：系统级告警的哨兵 task_id（与服务端 SystemEvent.SYSTEM_TASK_ID 对齐） */
const SYSTEM_TASK_ID = 'system';

interface EventItem {
  id: string;
  task_no: string | null;
  task_id: string;
  project_id: string;
  project_name: string | null; // T01616：项目归属（服务端 JOIN projects 随行带出）
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

  // T01568：铃铛按事件语义分流——「结果回传 / AI 处理完成或失败」是待查看内容，直达抽屉
  // （落位由 drawerTabForNotice 按任务实际状态决定，与 OS 通知同一口径）；
  // 「状态变更 / 验证」只是提醒该任务发生了什么，保持既有的「仅定位行 + 高亮」，不把抽屉糊到脸上。
  // 系统告警无对应任务，沿用不可跳转（见 gotoTask 调用处）。
  function drawerTabForEvent(it: EventItem): FocusOpenMode | false {
    if (it.kind === 'result' || it.kind === 'ai_state') return 'notice';
    return false;
  }

  function gotoTask(it: EventItem) {
    // T01057 建议：按编号定位（解析 id/项目/tab，跨项目可命中），替代此前只写 focusId=task_no 无法命中行 uuid 的旧逻辑
    void focusTaskByNo(it.task_no, drawerTabForEvent(it));
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
              // T01061 后续：系统告警无对应任务——点击不应跳转（focusTaskByNo(null) 只会空跑一次导航）
              const isSystem = it.task_id === SYSTEM_TASK_ID;
              let iconColor = 'var(--accent)';
              if (isSystem || (it.kind === 'ai_state' && it.detail.includes('失败'))) iconColor = 'var(--danger)';
              else if (it.kind === 'verified') iconColor = 'var(--success)';
              return (
                <button key={it.id} onClick={() => (isSystem ? setOpen(false) : gotoTask(it))}
                  title={isSystem ? `${it.detail} — 系统告警，无需跳转` : `${it.detail} — 点击前往任务${taskNoSuffix}`}
                  style={{ display: 'flex', gap: 8, width: '100%', textAlign: 'left', padding: '9px 14px', border: 'none', borderBottom: '1px solid var(--surface-2)', background: unread ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', alignItems: 'flex-start' }}
                >
                  <span style={{ marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4, color: iconColor, flexShrink: 0 }}>
                    {it.detail.includes('失败') ? <AlertTriangle size={13} /> : meta.icon}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.task_no ? <b style={{ color: 'var(--accent)' }}>{it.task_no}</b> : null} {isSystem ? '系统告警' : (it.title || it.detail)}
                    </span>
                    {/* T01616：项目归属标注——放在元信息行首，与 kind/detail/时间同排不增行高；
                        行点击本就跳往该任务（任务所属项目即此项目），徽标只作快速识别不做二次跳转 */}
                    <span style={{ display: 'flex', fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {it.project_name && (
                        <span title={`所属项目：${it.project_name}`}
                          style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, padding: '0 5px', borderRadius: 8, border: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}>
                          {it.project_name}
                        </span>
                      )}
                      <span>{meta.label} · {it.detail} · {relTime(it.created_at)}</span>
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
