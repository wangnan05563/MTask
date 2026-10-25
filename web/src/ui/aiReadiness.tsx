import { useEffect, useState, type CSSProperties } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { api } from '../api/client';

/**
 * T03176（PRD D-14）：AI 不可用入口的单源展示原语。
 *
 * 统一口径：主入口一律「可见但禁用 + 原因 + 修复动作（去模型管理）」；
 * 判据全部来自服务端 /ai/readiness（与运行时 AIService 同口径），前端不自造第二套。
 * 只有「从未启用过的上下文建议」允许隐藏——该策略由调用方按自身启用态决定，
 * 一旦启用过就必须用本原语的 reason 展示不可用原因，不得隐藏。
 */

export interface AiReadiness {
  ready: boolean;
  code?: 'no_tool' | 'all_disabled' | 'missing_model' | 'config_issue';
  reason: string;
  fix: { label: string; tab: string } | null;
  toolId?: string;
  toolName?: string;
  counts: { total: number; enabled: number; usable: number };
  warnings?: { field: string; message: string }[];
  checkedAt: string;
}

const UNKNOWN: AiReadiness = {
  ready: false, code: 'no_tool', reason: 'AI 可用性检测中…', fix: null,
  counts: { total: 0, enabled: 0, usable: 0 }, checkedAt: '',
};

let cache: AiReadiness | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void { for (const fn of listeners) fn(); }

async function fetchReadiness(): Promise<void> {
  pending ??= api.get<AiReadiness>('/ai/readiness')
    .then((r) => { cache = r; })
    .catch(() => { cache = { ...UNKNOWN, reason: 'AI 可用性检测失败（后端未就绪），可稍后重试' }; })
    .finally(() => { pending = null; emit(); });
  await pending;
}

/** 主动失效（保存/删除/启停模型后调用），下次挂载或 refresh 重新取 */
export function refreshAiReadiness(): void {
  cache = null;
  emit();
  void fetchReadiness();
}

/** 统一跳「模型」页（App.tsx 的 mtaskNavigate 监听切换 tab，不硬编码 URL） */
export function navigateToAiTools(): void {
  globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'aitools' } }));
}

/** 订阅可用性：返回 null 表示尚未取到（调用方按「未知」处理，不因加载态隐藏入口） */
export function useAiReadiness(): AiReadiness | null {
  const [value, setValue] = useState<AiReadiness | null>(cache);
  useEffect(() => {
    const sync = () => setValue(cache);
    listeners.add(sync);
    if (!cache) void fetchReadiness();
    sync();
    return () => { listeners.delete(sync); };
  }, []);
  return value;
}

/** 不可用判定：null（加载中）一律视为「不阻断」，避免入口在首帧被误禁用 */
export function aiBlocked(r: AiReadiness | null): boolean {
  return !!r && !r.ready;
}

/** 禁用态 title：把原因与修复动作写进悬浮提示，按钮本身保持可见 */
export function aiBlockedTitle(r: AiReadiness | null, base: string): string {
  if (!aiBlocked(r)) return base;
  const fix = r?.fix ? `（点击「${r.fix.label}」修复）` : '';
  return `${base} — 暂不可用：${r?.reason ?? ''}${fix}`;
}

/**
 * 页面级原因条：主入口所在区域挂一条即可满足「可见原因」。
 * ready 或加载中返回 null（不占空间，避免空态抖动）。
 */
export function AiUnavailableHint({ r, style, compact }: {
  readonly r: AiReadiness | null;
  readonly style?: CSSProperties;
  readonly compact?: boolean;
}) {
  if (!r || r.ready) return null;
  return (
    <div
      data-lck="ai-unavailable-hint"
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: compact ? '4px 8px' : '6px 10px', borderRadius: 8,
        border: '1px solid var(--warn)', background: 'var(--surface-2)',
        fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', ...style,
      }}
    >
      <AlertTriangle size={13} style={{ color: 'var(--warn)', flexShrink: 0 }} />
      <span>AI 功能暂不可用：{r.reason}</span>
      {r.fix && (
        <button
          type="button"
          onClick={navigateToAiTools}
          data-lck="ai-unavailable-fix"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid var(--border)',
            background: 'var(--card-bg)', color: 'var(--text)', borderRadius: 6,
            padding: '1px 6px', fontSize: 'calc(var(--fs-xs) + 0.5px)', cursor: 'pointer',
          }}
        >
          {r.fix.label}<ArrowRight size={11} />
        </button>
      )}
    </div>
  );
}
