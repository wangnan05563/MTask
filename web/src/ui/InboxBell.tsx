import { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';
import { api, type InboxSummary } from '../api/client';

/**
 * T06295（REQ-032）：顶栏收件箱入口。
 *
 * 角标数字 = open 条目数（与 PRD §A2 验收「角标数与 open 数一致」对齐）；
 * unread 只作为右下角小圆点提示，页面打开清零后角标数字不变。
 * 数据由 /inbox/summary 提供（列表读取同源同步），不复制通知中心的轮询。
 */

const REFRESH_MS = 60_000;

export function InboxBell() {
  const [counts, setCounts] = useState<InboxSummary['counts']>({
    open: 0, unread: 0, decision: 0, ai_failed: 0, verify_pending: 0, system: 0,
  });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const r = await api.get<InboxSummary>('/inbox/summary');
      if (r?.counts) setCounts(r.counts);
    } catch { /* 服务未就绪：保留上次读数，不伪造 0 */ }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => void refresh(), REFRESH_MS);
    const onChanged = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    globalThis.addEventListener('mtaskInboxChanged', onChanged);
    globalThis.addEventListener('mtaskNavigate', onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer.current) clearInterval(timer.current);
      globalThis.removeEventListener('mtaskInboxChanged', onChanged);
      globalThis.removeEventListener('mtaskNavigate', onChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const open = counts.open;
  const unread = counts.unread;
  const label = `收件箱 — ${open} 条待处理${unread ? `，${unread} 条未读` : ''}`;

  return (
    <button
      type="button"
      onClick={() => globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'inbox' } }))}
      title={label}
      aria-label={label}
      data-open-count={open}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 7,
        borderRadius: 6,
        background: 'var(--card-bg)',
        color: open ? 'var(--accent)' : 'var(--text)',
        cursor: 'pointer',
        border: '1px solid var(--border)',
      }}
    >
      <Inbox size={16} />
      {open > 0 && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8,
            background: 'var(--accent)', color: 'var(--on-solid)', fontSize: 'var(--fs-2xs)', fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {open > 99 ? '99+' : open}
        </span>
      )}
      {unread > 0 && (
        <span
          aria-hidden="true"
          title={`${unread} 条未读`}
          style={{
            position: 'absolute', bottom: -2, right: -2, width: 7, height: 7, borderRadius: '50%',
            background: 'var(--warning, #b45309)', border: '1px solid var(--card-bg)',
          }}
        />
      )}
    </button>
  );
}
