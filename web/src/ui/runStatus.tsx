/**
 * T01038：卡片运行状态统一系统。
 *
 * 把散落在各页面的「生成中… / 处理中… / 旋转图标 + 耗时」收敛为一套统一的状态枚举、文案、
 * 配色与计时逻辑，供 AI 工作台卡片、AI 控制台各 Tab、导航栏 Tab 共用，实现：
 *   - 统一状态提示样式与文案（loading/running/success/error）
 *   - 运行中动画图标（复用 lucide-react Loader2 + 全局 .aispin 旋转，成熟开源图标库，零新增依赖）
 *   - 运行时实时秒数 + 结束后保留最终耗时
 *   - 状态与计时跨 Tab 切换 / 页面刷新保持（模块级 store 已天然跨 Tab；刷新由 localStorage 兜底）
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';

/** 统一运行状态枚举 */
export type RunStatus = 'idle' | 'loading' | 'running' | 'success' | 'error';

interface StatusMeta {
  label: string;
  color: string;
}

/** 统一文案与配色（与全局 CSS 变量对齐：--accent / --success / --danger / --text-muted） */
export const STATUS_META: Record<RunStatus, StatusMeta> = {
  idle: { label: '', color: 'var(--text-muted)' },
  loading: { label: '加载中', color: 'var(--text-muted)' },
  running: { label: '运行中', color: 'var(--accent)' },
  success: { label: '完成', color: 'var(--success)' },
  error: { label: '失败', color: 'var(--danger)' },
};

/**
 * 运行耗时短格式——45s / 1m05s / 2h03m，秒精度、不展示毫秒（T01038 约束）。
 * 与 ReportConsole.fmtElapsed 保持一致口径。
 */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m${String(rs).padStart(2, '0')}s` : `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * 实时计时钩子：运行中每秒刷新显示已运行秒数；结束后（active=false 且传入 finalElapsed）固定显示最终耗时。
 * 仅用于展示层，不侵入业务逻辑。
 */
export function useElapsed(startedAt?: number, active = false, finalElapsed?: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active && finalElapsed != null) return; // 已结束：静态展示 finalElapsed，无需计时
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, active, finalElapsed]);
  if (!active && finalElapsed != null) return fmtElapsed(finalElapsed);
  if (!startedAt) return '';
  return fmtElapsed(now - startedAt);
}

interface RunStatusBadgeProps {
  readonly status: RunStatus;
  /** 运行中起始时间戳（ms），用于实时计时 */
  readonly startedAt?: number;
  /** 结束后保留的最终耗时（ms）；优先于实时计时展示 */
  readonly finalElapsed?: number;
  /** 是否显示状态文字（图标始终显示） */
  readonly showLabel?: boolean;
  /** 图标尺寸 */
  readonly size?: number;
  readonly style?: CSSProperties;
}

/**
 * 统一运行状态徽标：运行中/加载中=「流光文字」动画（.ai-shimmer，对齐 WorkBuddy 会话运行态样式，
 * 不再使用旋转图标）+ 实时秒数；成功/失败=对应图标 + 最终耗时。
 */
export function RunStatusBadge({
  status,
  startedAt,
  finalElapsed,
  showLabel = true,
  size = 12,
  style,
}: RunStatusBadgeProps): ReactNode {
  // 注意：必须先无条件调用 hooks（useElapsed），再 early-return，否则 idle↔非idle 切换会违反 Hooks 规则。
  const meta = STATUS_META[status];
  const active = status === 'running' || status === 'loading';
  const elapsed = useElapsed(startedAt, active, finalElapsed);
  if (status === 'idle') return null;
  if (active) {
    const text = [showLabel ? meta.label : '', elapsed].filter(Boolean).join(' ') || meta.label;
    const elapsedSuffix = elapsed ? ` · 耗时 ${elapsed}` : '';
    const elapsedSuffixAria = elapsed ? `，耗时 ${elapsed}` : '';
    return (
      <span
        title={`运行状态：${meta.label}${elapsedSuffix}`}
        aria-label={`运行状态：${meta.label}${elapsedSuffixAria}`}
        style={{ display: 'inline-flex', alignItems: 'center', fontSize: size, lineHeight: 1.3, whiteSpace: 'nowrap', ...style }}
      >
        <span className="ai-shimmer" style={{ fontWeight: 600 }}>{text}</span>
      </span>
    );
  }
  const Icon = status === 'success' ? CheckCircle2 : XCircle;
  const elapsedSuffix = elapsed ? ` · 耗时 ${elapsed}` : '';
  const elapsedSuffixAria = elapsed ? `，耗时 ${elapsed}` : '';
  return (
    <span
      title={`运行状态：${meta.label}${elapsedSuffix}`}
      aria-label={`运行状态：${meta.label}${elapsedSuffixAria}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: meta.color, whiteSpace: 'nowrap', ...style }}
    >
      <Icon size={size} style={{ flexShrink: 0 }} />
      {showLabel && <span>{meta.label}</span>}
      {elapsed && <span style={{ opacity: 0.85 }}>{elapsed}</span>}
    </span>
  );
}

// ───────────────────────── 刷新保持（localStorage 兜底） ─────────────────────────
// 模块级 store 已天然跨 Tab 切换保持；此处仅兜底「页面刷新」场景：把运行/结束态落盘，
// 模块初始化时水合，使刷新后状态与最终耗时不丢失。读写均 try/catch 防御（隐私/配额/SSR）。

const PREFIX = 'mtask.run.';

export interface PersistedRun {
  status: RunStatus;
  startedAt?: number;
  finalElapsed?: number;
}

export function loadRun(key: string): PersistedRun | null {
  try {
    const s = localStorage.getItem(PREFIX + key);
    return s ? (JSON.parse(s) as PersistedRun) : null;
  } catch {
    return null;
  }
}

export function persistRun(key: string, data: PersistedRun): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {
    /* 隐私模式/配额超限时静默，不影响运行态本身 */
  }
}

export function clearRun(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* 忽略 */
  }
}
