/**
 * 移动端通知中心（PM-104 ③）：聚合任务事件（状态/验证/AI/结果/系统）。
 * 数据与桌面通知中心同源（GET /events/recent），未读口径共用 notify.events.lastSeen。
 * 点按事件 → 按 task_no 拉任务 → 回任务页切到所属项目并展开详情。
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, FileText, ListTodo, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { EmptyState, Skeleton, mutedStyle } from './ui';

export interface MobileEventItem {
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

const LAST_SEEN_KEY = 'notify.events.lastSeen';
const SYSTEM_TASK_ID = 'system';
const KIND_META: Record<string, { label: string; icon: React.ReactNode }> = {
  status: { label: '状态', icon: <ListTodo size={15} /> },
  verified: { label: '验证', icon: <ShieldCheck size={15} /> },
  ai_state: { label: 'AI', icon: <CheckCircle2 size={15} /> },
  result: { label: '结果', icon: <FileText size={15} /> },
  system: { label: '系统', icon: <AlertTriangle size={15} /> },
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function eventIcon(it: MobileEventItem): React.ReactNode {
  if (it.detail.includes('失败')) return <AlertTriangle size={15} />;
  return (KIND_META[it.kind] ?? { icon: <FileText size={15} /> }).icon;
}

export function MobileNotifications({ notify, onOpenTask }: Readonly<{
  notify: (msg: string, isErr?: boolean) => void;
  onOpenTask: (taskNo: string) => void;
}>) {
  const [items, setItems] = useState<MobileEventItem[] | null>(null);
  // 打开前的已读水位：本次列表仍按它标注未读，打开即把水位推到现在（与桌面同口径）
  const [lastSeen] = useState(() => {
    try { return localStorage.getItem(LAST_SEEN_KEY) ?? ''; } catch { return ''; }
  });

  useEffect(() => {
    void (async () => {
      try {
        const rows = await api.get<MobileEventItem[]>('/events/recent?limit=30');
        setItems(Array.isArray(rows) ? rows : []);
      } catch (e) {
        setItems([]);
        notify(e instanceof Error ? e.message : String(e));
      }
      try { localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString()); } catch { /* 忽略 */ }
    })();
  }, [notify]);

  if (items === null) return <Skeleton rows={5} card />;
  if (items.length === 0) return <EmptyState icon="🔔" message="暂无任务事件" hint="AI 分发 / 回传 / 状态变更后会自动记录。" />;

  return (
    <>
      {items.map((it) => {
        const unread = it.created_at > lastSeen;
        const system = !it.task_no || it.task_id === SYSTEM_TASK_ID;
        const meta = KIND_META[it.kind];
        const failed = it.detail.includes('失败');
        const color = system || failed ? 'var(--danger)' : it.kind === 'verified' ? 'var(--success)' : 'var(--accent)';
        const content = (
          <>
            <span style={{ ...iconWrap, color }}>{eventIcon(it)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 'var(--fs-l)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.task_no && <b style={{ color: 'var(--accent)', fontWeight: 600 }}>{it.task_no} </b>}
                {system ? '系统告警' : it.title}
              </span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginTop: 2 }}>
                {it.project_name && <span style={projectChip} title={`所属项目：${it.project_name}`}>{it.project_name}</span>}
                <span>{meta?.label ?? it.kind} · {it.detail} · {relTime(it.created_at)}</span>
              </span>
            </span>
            {unread && <span style={unreadDot} aria-label="未读" />}
          </>
        );
        if (system) {
          return <div key={it.id} style={rowStyle} title={`${it.detail} — 系统告警，无需跳转`}>{content}</div>;
        }
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onOpenTask(it.task_no as string)}
            title={`${it.detail} — 点击查看任务 ${it.task_no}`}
            aria-label={`通知：${it.task_no} ${it.title}，${it.detail}，点击查看任务`}
            style={{ ...rowStyle, width: '100%', textAlign: 'left', cursor: 'pointer', color: 'var(--text)', background: unread ? 'var(--accent-soft)' : 'transparent', border: 'none', borderBottom: '1px solid var(--surface-2)' }}
          >
            {content}
          </button>
        );
      })}
      <div style={mutedStyle}>打开通知即视为已读；仅展示最近 30 条任务事件。</div>
    </>
  );
}

const rowStyle: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 2px', borderBottom: '1px solid var(--surface-2)' };
const iconWrap: React.CSSProperties = { marginTop: 2, flexShrink: 0, display: 'inline-flex' };
const projectChip: React.CSSProperties = { fontSize: 'var(--fs-2xs)', padding: '0 5px', borderRadius: 8, border: '1px solid var(--border-strong)', color: 'var(--text-muted)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const unreadDot: React.CSSProperties = { width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', marginTop: 6, flexShrink: 0 };
