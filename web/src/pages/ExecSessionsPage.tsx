import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity, Info, Loader2, Pin, RefreshCw, RotateCcw, Route } from 'lucide-react';
import { api, type ExecSession } from '../api/client';
import { EmptyState } from '../ui/EmptyState';
import { focusTaskByNo } from '../ui/focusTask';
import { consumeExecSessionFocus } from '../ui/focusExecSession'; // T06296：全局搜索点 Run 后定位会话卡片
import { fullTime, relTime } from '../ui/format';
import { NotificationFeed } from '../ui/NotificationFeed';
import { PlatformLogo } from '../ui/PlatformLogo';
import { ScrollArrows } from '../ui/ScrollArrows';
import { desktopApi } from '../ui/desktop';
import { RunDetailPage } from './RunDetailPage'; // T06298（REQ-036 / PRD §B6）：Run 追踪详情页
import { PageHeader, PageShell } from '../ui/layout'; // T06327：核心页统一页面壳与页头

/**
 * T01271-FR1.4：「执行会话」面板——展示外部平台会话的存活 / 进度 / 阶段 / 停滞标记。
 *
 * T03175（AI-402）升级：活跃且可见时刷新 ≤2 秒（隐藏页降频 15 秒）、停滞/失败会话一键重派
 * （经服务端复用既有 RelayDispatch 链路）、任务 chip 点击直达任务详情（focusTaskByNo 定位高亮）。
 * 停滞标记仍完全由服务端写入，前端不做二次推断；重派动作也只在服务端校验后执行（单一口径）。
 *
 * T05766：由单列大留白列表改为「状态分列卡片看板」；每列按最新状态更新时间倒序，
 * 来源平台以统一尺寸 Logo 标识；状态变化时用 FLIP 动画从旧位置平滑冒泡到新列顶部。
 */

/** AI-402④：可见时 ≤2 秒刷新；隐藏页降频（与队列页 15 秒轮询同档） */
const ACTIVE_POLL_MS = 2000;
const HIDDEN_POLL_MS = 15000;

/** 可显示重派入口的会话状态；仍需至少一条未归档待办任务才会实际渲染按钮（PRD §8） */
const REDISPATCHABLE = new Set(['stalled', 'failed']);

/** T05767：左右分栏默认 4:1（左 80% / 右 20%），拖动范围留出两侧安全边界。
 *  换新键避免沿用旧版 75% 默认值，让已升级用户的初始比例也落到 4:1。 */
const SPLIT_KEY = 'mtask.execSessions.splitPct.v2';
const DEFAULT_LEFT_PCT = 80;
const MIN_LEFT_PCT = 55;
const MAX_LEFT_PCT = 85;

function readSplitPct(): number {
  try {
    const raw = Number(localStorage.getItem(SPLIT_KEY));
    if (Number.isFinite(raw) && raw >= MIN_LEFT_PCT && raw <= MAX_LEFT_PCT) return raw;
  } catch { /* 忽略 */ }
  return DEFAULT_LEFT_PCT;
}

/** 看板列定义：状态键 + 列标题 + 语义色。未知状态会动态追加，避免会话凭空消失。 */
const STATUS_COLUMNS: Array<{ key: string; label: string; color: string; tone: string }> = [
  { key: 'active', label: '进行中', color: 'var(--success)', tone: 'var(--accent-soft)' },
  { key: 'stalled', label: '已停滞', color: 'var(--warn)', tone: 'color-mix(in srgb, var(--warn) 10%, transparent)' },
  { key: 'failed', label: '失败', color: 'var(--danger)', tone: 'color-mix(in srgb, var(--danger) 10%, transparent)' },
  { key: 'done', label: '已完成', color: 'var(--text-muted)', tone: 'var(--surface-2)' },
  { key: 'aborted', label: '已中止', color: 'var(--text-muted)', tone: 'var(--surface-2)' },
];

/** `POST /exec-sessions/:id/redispatch` 响应（服务端 RedispatchSessionResult 镜像） */
interface RedispatchEntry {
  taskId: string;
  taskNo: string | null;
  dispatched: boolean;
  skipped?: 'not_found' | 'archived' | 'not_todo';
  state?: string;
  ok?: boolean;
  /** T06057：relay_not_configured=平台走中继但缺 supervisor.relayToolId，需引导到设置页配置 */
  reason?: 'relay_not_configured';
  detail?: string;
}
interface RedispatchResponse {
  ok: boolean;
  reason?: string;
  platform?: string;
  entries: RedispatchEntry[];
}

/** 会话状态展示口径（PRD §8 状态机）。列标题与卡片内徽标共用同一份语义。 */
const STATUS_META: Record<string, { label: string; color: string }> = Object.fromEntries(
  STATUS_COLUMNS.map((c) => [c.key, { label: c.label, color: c.color }]),
);

const card: CSSProperties = {
  background: 'var(--card-bg)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  padding: '8px 10px',
};

const chip: CSSProperties = {
  fontSize: 'var(--fs-xs)',
  color: 'var(--text-secondary)',
  background: 'var(--surface-2)',
  borderRadius: 6,
  padding: '1px 6px',
  maxWidth: 320,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** T04065：任务 chip 内的项目标签——轻量中性色，超长截断，完整名走 title 提示 */
const projectBadge: CSSProperties = {
  display: 'inline-block',
  flexShrink: 0,
  maxWidth: 108,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 'var(--fs-xs)',
  lineHeight: '16px',
  color: 'var(--text-muted)',
  background: 'var(--card-bg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '0 5px',
};

/** 会话的「最新状态更新时间」：终态取结束时间，运行态取最近心跳；用于列内倒序。 */
function sessionUpdatedAt(s: ExecSession): number {
  const candidates = [s.finished_at, s.last_heartbeat, s.started_at].filter(Boolean) as string[];
  return candidates.reduce((max, iso) => Math.max(max, Date.parse(iso) || 0), 0);
}

function statusColumns(rows: ExecSession[]) {
  const extra = Array.from(new Set(rows.map((r) => r.status).filter((st) => !STATUS_META[st])));
  return [
    ...STATUS_COLUMNS,
    ...extra.map((key) => ({ key, label: key || '未知', color: 'var(--text-muted)', tone: 'var(--surface-2)' })),
  ];
}

export function ExecSessionsPage({ standalone = false }: { readonly standalone?: boolean }) {
  const [rows, setRows] = useState<ExecSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** L3 丁档：最近一次摘要指纹——相同就跳过整行重取 */
  const sigRef = useRef('');
  /** T05767：左右分栏宽度（左栏百分比）与拖动状态；默认 4:1（左 80% / 右 20%）。 */
  const [leftPct, setLeftPct] = useState(readSplitPct);
  const [dragging, setDragging] = useState(false);
  /** T06298：当前追踪的执行会话；为空时显示看板，非空时整页切到 Run 详情。 */
  const [traceRunRef, setTraceRunRef] = useState<string | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  /** T05766：FLIP 冒泡动画的锚点：上一次渲染后的卡片矩形 + 每个会话的状态。 */
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRectsRef = useRef(new Map<string, DOMRect>());
  const prevStatusRef = useRef(new Map<string, string>());
  /** T06296：全局搜索点 Run 的待定位会话；列表尚未加载时先存着，渲染完成后再滚动。 */
  const pendingFocusRef = useRef<string | null>(null);
  /** T06296：目标会话可能早于「最近 100 条」首屏；记住 id，列表每次刷新都把它并回看板。 */
  const pinnedSessionIdRef = useRef<string | null>(null);
  const extraSessionsRef = useRef(new Map<string, ExecSession>());

  const load = useCallback(async () => {
    try {
      const list = await api.get<ExecSession[]>('/exec-sessions');
      const pinned = pinnedSessionIdRef.current;
      let merged = list;
      if (pinned) {
        const inList = list.some((s) => s.id === pinned);
        if (inList) extraSessionsRef.current.delete(pinned);
        else {
          let extra = extraSessionsRef.current.get(pinned);
          if (!extra) {
            try {
              extra = await api.get<ExecSession>(`/exec-sessions/${encodeURIComponent(pinned)}`);
              extraSessionsRef.current.set(pinned, extra);
            } catch {
              extra = undefined; // 会话已被清理：不伪造卡片，按首屏列表展示
            }
          }
          if (extra) merged = [extra, ...list.filter((s) => s.id !== pinned)];
        }
      }
      setRows(merged);
      setError('');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** T06296：滚动到目标会话并给一次高亮脉冲；卡片还没挂载就留给 rows 更新后的 effect。 */
  const applySessionFocus = useCallback((id: string) => {
    const el = cardRefs.current.get(id);
    if (!el) {
      pendingFocusRef.current = id;
      return;
    }
    pendingFocusRef.current = null;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('exec-card-focus');
    // 重新触发 CSS 动画：读一次布局属性即可重置 animation。
    void el.offsetWidth;
    el.classList.add('exec-card-focus');
    globalThis.setTimeout(() => el.classList.remove('exec-card-focus'), 1800);
  }, []);

  useEffect(() => {
    const id = consumeExecSessionFocus();
    if (id) {
      // T06296：先记 pin，load() 会判断是否在首屏 100 条内，不在则单取详情并回填。
      pinnedSessionIdRef.current = id;
      pendingFocusRef.current = id;
    }
  }, []);

  useEffect(() => {
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      pendingFocusRef.current = id;
      pinnedSessionIdRef.current = id;
      if (cardRefs.current.has(id)) applySessionFocus(id);
      else void load(); // 会话不在当前首屏：取详情后由 rows 更新 effect 定位
    };
    globalThis.addEventListener('mtaskFocusExecSession', onFocus);
    return () => globalThis.removeEventListener('mtaskFocusExecSession', onFocus);
  }, [applySessionFocus, load]);

  useEffect(() => {
    if (loading) return;
    const id = pendingFocusRef.current;
    if (id) applySessionFocus(id);
  }, [loading, rows, applySessionFocus]);

  // L3 丁档：2s 轮询只拉 `{sig}`（~100B），指纹变了才整行重取；
  // 原实现每 2s 拉 51,346B 的整行列表，重绘时机与本形态等价。
  const poll = useCallback(async () => {
    try {
      const d = await api.get<{ sig: string }>('/exec-sessions/digest');
      if (d.sig !== sigRef.current) {
        sigRef.current = d.sig;
        await load();
      }
    } catch {
      // 摘要端点不可用时不静默：退回整行拉取，保留原有的错误呈现
      await load();
    }
  }, [load]);

  // AI-402④：可见时 2 秒心跳级刷新，切到后台降频 15 秒；回到前台立即拉一次并恢复快档
  useEffect(() => {
    void poll();
    let timer = setInterval(() => void poll(), document.hidden ? HIDDEN_POLL_MS : ACTIVE_POLL_MS);
    const reschedule = () => {
      clearInterval(timer);
      timer = setInterval(() => void poll(), document.hidden ? HIDDEN_POLL_MS : ACTIVE_POLL_MS);
      // 回前台立即整行刷新（沿用原口径：不等摘要比对，直接把当前数据拉齐）
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', reschedule);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', reschedule);
    };
  }, [poll, load]);

  // T05767：分隔线拖动。监听挂在 window 上，指针移出分隔线/窗口边界仍可持续调整；
  // 限制 55%~85%，避免右栏被压成 0 或左栏把看板挤坏；松手才写 localStorage。
  useEffect(() => {
    if (!dragging) return;
    const resize = (ev: PointerEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, pct)));
    };
    const stop = () => {
      setDragging(false);
      setLeftPct((cur) => {
        try { localStorage.setItem(SPLIT_KEY, String(Math.round(cur))); } catch { /* 忽略 */ }
        return cur;
      });
    };
    const oldCursor = document.body.style.cursor;
    const oldSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelect;
    };
  }, [dragging]);

  const adjustSplit = (delta: number) => {
    setLeftPct((cur) => {
      const next = Math.max(MIN_LEFT_PCT, Math.min(MAX_LEFT_PCT, cur + delta));
      try { localStorage.setItem(SPLIT_KEY, String(Math.round(next))); } catch { /* 忽略 */ }
      return next;
    });
  };

  const openMonitor = async () => {
    const desktop = desktopApi();
    if (desktop?.openExecMonitor) {
      await desktop.openExecMonitor();
      return;
    }
    // 浏览器直连时无法设置 alwaysOnTop；退化为独立窗口，桌面壳内仍走 IPC 置顶窗口。
    const url = new URL(location.href);
    url.searchParams.set('view', 'exec-monitor');
    globalThis.open(url.toString(), 'mtask-exec-monitor', 'popup=yes,width=1100,height=760');
  };

  // T05766：状态变化后卡片会被 React 立即挪到新列；这里用 Web Animations API 先把它
  // 视觉上拉回旧位置，再过渡到新位置，形成「从原处冒泡到列顶」的 FLIP 效果。
  // 只在状态真的变化时触发，避免每 2 秒心跳轮询都抖动；尊重 prefers-reduced-motion。
  useLayoutEffect(() => {
    const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const nextRects = new Map<string, DOMRect>();
    for (const s of rows) {
      const el = cardRefs.current.get(s.id);
      if (el) nextRects.set(s.id, el.getBoundingClientRect());
    }

    if (!reduceMotion && prevStatusRef.current.size > 0) {
      for (const s of rows) {
        const oldStatus = prevStatusRef.current.get(s.id);
        if (!oldStatus || oldStatus === s.status) continue;
        const oldRect = prevRectsRef.current.get(s.id);
        const nextRect = nextRects.get(s.id);
        const el = cardRefs.current.get(s.id);
        if (!oldRect || !nextRect || !el) continue;
        const dx = oldRect.left - nextRect.left;
        const dy = oldRect.top - nextRect.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)`, boxShadow: '0 0 0 2px var(--accent)' },
            { transform: 'translate(0, 0)', boxShadow: '0 0 0 2px var(--accent)' },
            { transform: 'translate(0, 0)', boxShadow: '0 0 0 0 transparent' },
          ],
          { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      }
    }

    prevRectsRef.current = nextRects;
    prevStatusRef.current = new Map(rows.map((s) => [s.id, s.status]));
  }, [rows]);

  const columns = statusColumns(rows);
  const grouped = new Map<string, ExecSession[]>();
  for (const col of columns) grouped.set(col.key, []);
  for (const s of rows) {
    const key = grouped.has(s.status) ? s.status : 'active';
    grouped.get(key)?.push(s);
  }
  for (const [, list] of grouped) {
    list.sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a));
  }

  // S3358：嵌套三元展开为 if/else 语句
  let content: ReactNode;
  if (loading) {
    content = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-m)', color: 'var(--text-muted)' }}>
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
      <div className="exec-kanban-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${columns.length}, minmax(190px, 1fr))`, gap: 8, alignItems: 'stretch', height: '100%', minHeight: 0, paddingBottom: 0 }}>
        {columns.map((col) => (
          <KanbanColumn
            key={col.key}
            title={col.label}
            color={col.color}
            tone={col.tone}
            rows={grouped.get(col.key) ?? []}
            onCardRef={(id, el) => {
              if (el) cardRefs.current.set(id, el);
              else cardRefs.current.delete(id);
            }}
            onTrace={(id) => setTraceRunRef(`legacy:exec_session:${id}`)}
          />
        ))}
      </div>
    );
  }

  // T06298：进入 Run 追踪后整页切换到详情；返回恢复原看板，不新开顶级页签。
  if (traceRunRef) {
    return <RunDetailPage runRef={traceRunRef} onBack={() => setTraceRunRef(null)} />;
  }

  return (
    <PageShell className="mt-exec-page">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, minHeight: 0, height: standalone ? '100vh' : undefined }}>
      <style>{`
        @property --exec-flow-angle {
          syntax: '<angle>';
          inherits: false;
          initial-value: 0deg;
        }
        @keyframes exec-spin { to { transform: rotate(360deg) } }
        @keyframes exec-card-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
        @keyframes exec-running-flow { to { --exec-flow-angle: 360deg } }
        /* T06296：搜索命中定位——脉冲与运行流光分开，避免和 active 卡片的 ::before 抢视觉。 */
        @keyframes exec-card-focus {
          0%, 100% { outline-color: transparent; box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
          18% { outline-color: var(--accent); box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 16%, transparent); }
          55% { outline-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 10%, transparent); }
        }
        .exec-kanban-card.exec-card-focus {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
          animation: exec-card-focus 1.6s ease-out;
        }
        @media (prefers-reduced-motion: reduce) {
          .exec-kanban-card.exec-card-focus { animation: none; }
        }
        .exec-kanban-card { will-change: transform; }
        .exec-kanban-card:hover { border-color: var(--border-strong) !important; box-shadow: 0 4px 14px rgba(15,23,42,.08); }
        /* T05766：只有进行中的会话显示绿色旋转流光边框；已停滞/失败/完成保持静态边框。
           T06056：服务端已将「有关联任务 running 但心跳超时」的会话校准回 active，不再误报等待。 */
        .exec-card-running {
          position: relative;
          border-color: transparent !important;
          box-shadow: 0 0 0 1px rgba(34,197,94,.08), 0 4px 16px rgba(34,197,94,.10);
        }
        .exec-card-running::before {
          content: '';
          position: absolute;
          inset: -1px;
          border-radius: inherit;
          padding: 1px;
          background: conic-gradient(
            from var(--exec-flow-angle),
            transparent 0deg 58deg,
            rgba(34,197,94,.10) 74deg,
            rgba(34,197,94,.78) 92deg,
            var(--session-live-accent) 104deg,
            rgba(34,197,94,.16) 122deg,
            transparent 142deg 360deg
          );
          -webkit-mask: linear-gradient(currentColor 0 0) content-box, linear-gradient(currentColor 0 0);
          -webkit-mask-composite: xor;
          mask: linear-gradient(currentColor 0 0) content-box, linear-gradient(currentColor 0 0);
          mask-composite: exclude;
          animation: exec-running-flow 2.4s linear infinite;
          pointer-events: none;
        }
        .exec-card-running:hover { border-color: transparent !important; }
        @media (prefers-reduced-motion: reduce) {
          .exec-card-running::before { animation: none; }
        }
        .exec-column-scroll { scrollbar-width: none; -ms-overflow-style: none; }
        .exec-column-scroll::-webkit-scrollbar { display: none; }
        .exec-monitor-pane { scrollbar-width: thin; }
        .notify-feed-scroll { scrollbar-width: none; -ms-overflow-style: none; }
        .notify-feed-scroll::-webkit-scrollbar { display: none; }
        .exec-split-handle:hover span, .exec-split-handle:focus-visible span { background: var(--accent) !important; }
        /* T05792：无边框图标按钮——悬浮/聚焦给轻微底色反馈，功能靠 title/aria-label 识别 */
        .exec-icon-btn { transition: background .15s ease, color .15s ease; }
        .exec-icon-btn:hover, .exec-icon-btn:focus-visible { background: var(--surface-2) !important; }
        .exec-icon-btn:active { background: var(--accent-soft, var(--surface-2)) !important; }
      `}</style>

      <PageHeader
        title="执行会话"
        minimal
        description="按状态分列观测外部平台会话的存活、进度与停滞；支持重派、置顶监控与 Run 追踪。"
      />

      {/* T06007：置顶监控/刷新移入右侧通知区头部（通知中心图标之后、更新时间之前）；独立监控窗保留状态徽标 */}
      {standalone && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexShrink: 0, paddingTop: 12, paddingLeft: 16, paddingRight: 16 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-s)', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 999, padding: '4px 10px' }}>
            <Pin size={13} /> 置顶监控中
          </span>
        </div>
      )}

      {error && <div style={{ fontSize: 'var(--fs-m)', color: 'var(--danger)', flexShrink: 0 }}>加载失败：{error}</div>}

      {/* T06266：CodeBuddy 网关是任务级直推，不产生 exec_session；此处只保留外部会话观测与重派语义 */}
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <Info size={12} /> CodeBuddy 网关派发不在这里显示：请在任务详情「最近派发」或队列页「派发记录」查看；本页「重派」仍只针对外部执行会话。
      </div>

      <div
        ref={splitRef}
        style={{
          display: 'grid',
          gridTemplateColumns: `${leftPct}% 10px minmax(0, 1fr)`,
          gap: 0,
          minHeight: standalone ? 0 : 520,
          flex: standalone ? '1 1 0' : undefined,
          height: standalone ? undefined : 'calc(100vh - 260px)',
          padding: standalone ? '0 16px 12px' : 0,
          boxSizing: 'border-box',
          minWidth: 0,
        }}
      >
        <div data-lck="exec-monitor-column" className="exec-monitor-pane" style={{ minWidth: 0, minHeight: 0, height: '100%', overflowX: 'auto', overflowY: 'hidden', paddingRight: 10, paddingBottom: 2 }}>
          {content}
        </div>
        <div
          className="exec-split-handle"
          data-lck="exec-split-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整执行会话与通知中心宽度"
          aria-valuemin={MIN_LEFT_PCT}
          aria-valuemax={MAX_LEFT_PCT}
          aria-valuenow={Math.round(leftPct)}
          tabIndex={0}
          onPointerDown={(e) => { e.preventDefault(); setDragging(true); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); adjustSplit(-3); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); adjustSplit(3); }
            else if (e.key === 'Home') { e.preventDefault(); setLeftPct(DEFAULT_LEFT_PCT); try { localStorage.setItem(SPLIT_KEY, String(DEFAULT_LEFT_PCT)); } catch { /* 忽略 */ } }
          }}
          title="拖动调整左右栏宽度（默认 4:1，左 80%）；双击恢复 4:1"
          onDoubleClick={() => { setLeftPct(DEFAULT_LEFT_PCT); try { localStorage.setItem(SPLIT_KEY, String(DEFAULT_LEFT_PCT)); } catch { /* 忽略 */ } }}
          style={{ position: 'relative', cursor: 'col-resize', touchAction: 'none', userSelect: 'none', background: 'transparent', border: 'none', padding: 0, minWidth: 10 }}
        >
          <span style={{ position: 'absolute', left: 4, top: 8, bottom: 8, width: 2, borderRadius: 2, background: dragging ? 'var(--accent)' : 'var(--border-strong)', transition: 'background .15s ease' }} />
          <span aria-hidden="true" style={{ position: 'absolute', left: 2, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1 }}>⋮</span>
        </div>
        <div data-lck="notification-column" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', paddingLeft: 10 }}>
          <NotificationFeed limit={50} headerActions={standalone ? undefined : (
            <>
              <button
                className="tbtn-anim exec-icon-btn"
                onClick={() => void openMonitor()}
                title="弹出置顶监控窗口 — 独立于主应用运行，主应用最小化后仍可见"
                aria-label="弹出置顶监控窗口"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, padding: 0,
                  background: 'transparent', color: 'var(--accent)', border: 'none',
                  borderRadius: 6, cursor: 'pointer', flexShrink: 0,
                }}
              >
                <Pin size={15} />
              </button>
              <button
                className="tbtn-anim exec-icon-btn"
                onClick={() => void load()}
                title="刷新列表"
                aria-label="刷新：重新拉取执行会话列表"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, padding: 0,
                  background: 'transparent', color: 'var(--text-secondary)', border: 'none',
                  borderRadius: 6, cursor: 'pointer', flexShrink: 0,
                }}
              >
                <RefreshCw size={15} />
              </button>
            </>
          )} />
        </div>
      </div>
    </div>
    </PageShell>
  );
}

function KanbanColumn({
  title,
  color,
  tone,
  rows,
  onCardRef,
  onTrace,
}: {
  readonly title: string;
  readonly color: string;
  readonly tone: string;
  readonly rows: ExecSession[];
  readonly onCardRef: (id: string, el: HTMLDivElement | null) => void;
  readonly onTrace: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <section
      className="exec-column"
      aria-label={`${title}，${rows.length} 个会话`}
      style={{
        minWidth: 0, height: '100%', minHeight: 0, position: 'relative',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
        padding: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div
        ref={scrollRef}
        className="exec-column-scroll"
        data-lck="exec-column-scroll"
        aria-label={`${title}泳道内容`}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8, paddingRight: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '1px 2px', position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 0 3px ${tone}` }} />
          <span style={{ fontSize: 'calc(var(--fs-s) + 0.5px)', fontWeight: 600, color: 'var(--text)' }}>{title}</span>
          <span style={{ marginLeft: 'auto', minWidth: 22, height: 20, padding: '0 6px', borderRadius: 999, background: 'var(--card-bg)', border: '1px solid var(--border)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            {rows.length}
          </span>
        </div>
        {rows.length === 0 && (
          <div style={{ padding: '18px 8px', textAlign: 'center', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', border: '1px dashed var(--border)', borderRadius: 10 }}>
            暂无{title}会话
          </div>
        )}
        {rows.map((s) => (
          <SessionCard
            key={s.id}
            s={s}
            cardRef={(el) => onCardRef(s.id, el)}
            enterAnimation
            onTrace={() => onTrace(s.id)}
          />
        ))}
      </div>
      <ScrollArrows targetRef={scrollRef} label={`${title}泳道`} />
    </section>
  );
}

function SessionCard({ s, cardRef, enterAnimation = false, onTrace }: { readonly s: ExecSession; readonly cardRef?: (el: HTMLDivElement | null) => void; readonly enterAnimation?: boolean; readonly onTrace: () => void }) {
  const meta = STATUS_META[s.status] ?? { label: s.status || '未知', color: 'var(--text-muted)' };
  const pct = Math.max(0, Math.min(100, Math.round(s.progress ?? 0)));
  /** T06056：进度只在平台显式上报过、或已到终态时展示百分比；否则显示「待上报」，
   *  避免刚 progress start 的 0 被用户误读成真实进度 0%。 */
  const progressReported = s.progress_reported === 1 || pct > 0 || s.status === 'done';
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const needsAttention = REDISPATCHABLE.has(s.status);
  /** 新版服务端会返回任务状态；旧版返回缺少字段时退回原行为，不误报“无待办任务”。 */
  const taskStateKnown = s.tasks.every((t) => typeof t.status === 'string');
  /** 与服务端 redispatchSession 同口径：只有未归档的待办任务才会真正派发。 */
  const eligibleTasks = taskStateKnown ? s.tasks.filter((t) => t.status === 'todo' && !t.archived) : [];
  const redispatchable = needsAttention && (taskStateKnown ? eligibleTasks.length > 0 : s.tasks.length > 0);
  const noEligibleTask = needsAttention && taskStateKnown && eligibleTasks.length === 0;
  const projectLabels = Array.from(new Set(s.tasks.map((t) => t.project_name?.trim()).filter(Boolean))) as string[];

  const redispatch = async () => {
    setBusy(true);
    setNotice('');
    try {
      const r = await api.post<RedispatchResponse>(`/exec-sessions/${s.id}/redispatch`);
      if (r.reason) { setNotice(`不可重派：${r.reason === 'status_not_redispatchable' ? '会话当前状态不允许（仅停滞/失败可重派）' : '会话不存在'}`); } else {
        const done = r.entries.filter((e) => e.dispatched && e.ok).map((e) => e.taskNo ?? e.taskId.slice(0, 8));
        const failed = r.entries.filter((e) => e.dispatched && !e.ok);
        const configMissing = failed.filter((e) => e.reason === 'relay_not_configured');
        const otherFailed = failed.filter((e) => e.reason !== 'relay_not_configured');
        const skipped = r.entries.filter((e) => !e.dispatched);
        const skippedLabels = skipped.map((e) => {
          if (e.skipped === 'archived') return '已归档';
          if (e.skipped === 'not_todo') return '非待办';
          return '已删除';
        });
        setNotice([
          done.length ? `已重派 ${done.length} 条（${done.join('、')}）` : '',
          configMissing.length ? `${configMissing.length} 条待配置中继工具：请到「设置 → 监督与审计 → 中继通道」配置 supervisor.relayToolId；任务已保留在就绪池` : '',
          otherFailed.length ? `${otherFailed.length} 条派发未成：${otherFailed.map((e) => e.detail ?? e.state ?? '').join('；')}` : '',
          skipped.length ? `${skipped.length} 条跳过（${skippedLabels.join('、')}）` : '',
        ].filter(Boolean).join('｜') || '该会话没有可重派的任务');
      }
    } catch (e) {
      setNotice(`重派请求失败：${(e as Error).message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={cardRef}
      className={`exec-kanban-card${s.status === 'active' ? ' exec-card-running' : ''}`}
      data-lck="exec-session-card"
      data-session-id={s.id}
      data-status={s.status}
      style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6, animation: enterAnimation ? 'exec-card-in .24s ease-out' : undefined }}
    >
      {/* T05999：首行固定 Logo → 项目标签 → 处理时间；项目标签单行截断，时间永不被遮挡 */}
      <div data-t05999="card-head" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
        <PlatformLogo platform={s.platform} size={28} />
        {projectLabels.length > 0 ? (
          <div data-lck="session-project-tags" style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap' }}>
            <span data-lck="session-project-tag" title={`所属项目：${projectLabels[0]}`} style={{ ...projectBadge, maxWidth: '100%', flexShrink: 1 }}>
              {projectLabels[0]}
            </span>
            {projectLabels.length > 1 && (
              <span data-lck="session-project-tag-more" title={`全部项目：${projectLabels.join('、')}`} style={{ ...projectBadge, maxWidth: 36, flexShrink: 0 }}>
                +{projectLabels.length - 1}
              </span>
            )}
          </div>
        ) : (
          <span data-lck="session-project-tag" title="未分配项目" style={{ ...projectBadge, maxWidth: '100%', flex: 1 }}>未分配项目</span>
        )}
        <span data-t05999="handle-time" title={fullTime(s.last_heartbeat)} style={{ fontSize: 'var(--fs-xs)', color: needsAttention ? 'var(--danger)' : 'var(--text-muted)', flexShrink: 0 }}>
          {relTime(s.last_heartbeat)}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span data-lck="session-id" title={s.session_id ?? s.id} aria-label={`会话 ID ${s.session_id ?? s.id}`} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.session_id ?? '-'}
        </span>
        {redispatchable && (
          <button
            data-lck="redispatch-btn"
            className="tbtn-anim"
            onClick={() => void redispatch()}
            disabled={busy}
            aria-label={`重派会话 ${s.session_id ?? s.id} 的待办任务`}
            title="一键重派：仅把该会话关联的未归档待办任务经中继重新派发"
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', padding: '2px 8px',
              background: 'var(--surface-2)', color: 'var(--danger)', border: '1px solid var(--danger)',
              borderRadius: 7, cursor: 'pointer', flexShrink: 0,
            }}
          >
            <RotateCcw size={11} style={{ animation: busy ? 'exec-spin 1s linear infinite' : undefined }} /> {busy ? '重派中' : '重派'}
          </button>
        )}
        {noEligibleTask && (
          <span data-lck="redispatch-empty" title="该会话关联的任务均已完成、已归档或已删除，没有可重派的待办任务"
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', fontSize: 'var(--fs-xs)',
              color: 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 7, padding: '2px 8px', flexShrink: 0,
            }}>
            无待办任务
          </span>
        )}
        {/* T06298：Run 追踪入口——外部会话是旧执行记录，详情页会标注兼容来源与成本缺失。 */}
        <button
          data-lck="trace-run-btn"
          className="tbtn-anim"
          onClick={onTrace}
          aria-label={`追踪会话 ${s.session_id ?? s.id} 的 Run`}
          title="打开 Run 追踪：查看头部状态与步骤时间线"
          style={{
            marginLeft: redispatchable || noEligibleTask ? 0 : 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', padding: '2px 8px',
            color: 'var(--accent)', background: 'var(--accent-soft)', border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
            borderRadius: 7, cursor: 'pointer', flexShrink: 0, font: 'inherit',
          }}
        >
          <Route size={11} /> 追踪
        </button>
      </div>

      {notice && (
        <div data-lck="redispatch-notice" role="status"
          style={{
            fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', background: 'var(--surface-2)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px',
          }}>
          {notice}
        </div>
      )}

      {s.phase && <div title={s.phase} style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>阶段：{s.phase}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div title={progressReported ? `平台上报进度 ${pct}%` : '平台尚未上报进度（不按 0% 计）'} style={{ flex: 1, height: 5, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
          <div style={{ width: `${progressReported ? pct : 0}%`, height: '100%', background: progressReported ? meta.color : 'var(--border-strong)', transition: 'width .3s ease' }} />
        </div>
        <span data-t06056="progress" title={progressReported ? `${pct}%` : '外部平台尚未上报真实进度'} style={{ fontSize: 'var(--fs-xs)', color: progressReported ? 'var(--text-muted)' : 'var(--warn)', minWidth: 44, textAlign: 'right' }}>{progressReported ? `${pct}%` : '待上报'}</span>
      </div>

      {s.tasks.length > 0 && (
        <div data-t05999="task-labels" style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {s.tasks.map((t) => (
            <button
              key={t.id}
              data-lck="task-chip"
              data-task-id={t.id}
              onClick={() => void focusTaskByNo(t.task_no, 'notice')}
              title={`任务ID：${t.id}｜${t.project_name ?? '未分配项目'}｜${t.task_no ?? ''} ${t.title}——点击直达任务`}
              style={{
                ...chip, display: 'inline-flex', alignItems: 'center', gap: 4, lineHeight: '16px', maxWidth: '100%',
                border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)', textAlign: 'left', font: 'inherit',
              }}
            >
              {/* T05999：底部任务标签不再重复项目标签，只保留任务编号 + 主题（项目已在首行） */}
              <span data-t05999="task-no" style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {t.task_no ?? '—'}
              </span>
              <span data-t05999="task-title" style={{ fontSize: 'var(--fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {t.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
