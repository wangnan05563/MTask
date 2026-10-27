import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { CopyButton } from './CopyButton';

/**
 * T03214 / UX-02 ③：页面提示（toast）的显式分级。
 *
 * 旧实现只有一条 `flash(msg)`：所有提示一律 2.5 秒自动消失、不可关闭、不可复制。
 * 对「操作成功」够用，对「操作失败」不够——失败原因往往是一长句服务端报错，
 * 2.5 秒既读不完也没法带走排查，用户只能凭印象复述。这里把两类分开：
 * 成功/info 保持 2.5 秒短提示，error 至少停 6 秒并给出「复制全文 + 手动关闭」。
 */

export type NoticeKind = 'info' | 'error';

/** 各等级的驻留时长（毫秒）：error 的下限即验收里的「至少 6 秒」 */
export const NOTICE_MS: Record<NoticeKind, number> = { info: 2500, error: 6000 };

/**
 * 调用点没显式声明等级时按文案判定：报错/被拒/前置条件不满足的措辞按 error 处理。
 * 异常本身抛出的文案（如 `Failed to fetch`）不含这些词——那些调用点必须显式传 'error'。
 */
const ERROR_WORDING = /(失败|错误|无法|不可|不能|未出现|未找到|不存在|请先|没有|须为|超出|被筛掉|被删|无效|稍候)/;

export function deriveNoticeKind(msg: string): NoticeKind {
  return ERROR_WORDING.test(msg) ? 'error' : 'info';
}

export interface NoticeState {
  msg: string;
  kind: NoticeKind;
  /** 本次提示的时刻：同一句文案重复触发也要重新计时 */
  at: number;
}

export interface NoticeApi {
  notice: NoticeState | null;
  flash: (msg: string, kind?: NoticeKind) => void;
  dismiss: () => void;
}

export function useNotice(): NoticeApi {
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const timerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      globalThis.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flash = useCallback((msg: string, kind?: NoticeKind) => {
    const next: NoticeState = { msg, kind: kind ?? deriveNoticeKind(msg), at: Date.now() };
    clearTimer();
    setNotice(next);
    timerRef.current = globalThis.setTimeout(() => {
      timerRef.current = null;
      setNotice(null);
    }, NOTICE_MS[next.kind]);
  }, [clearTimer]);

  const dismiss = useCallback(() => {
    clearTimer();
    setNotice(null);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { notice, flash, dismiss };
}

/**
 * 提示条本体：`position: fixed`（样式在 App.tsx 的 `.flash-toast`），
 * 宿主把它放在任意非交互容器内即可——内部自带按钮，不能再套进按钮里（UX-01 同源约束）。
 */
export function NoticeToast({ notice, onDismiss }: {
  readonly notice: NoticeState | null;
  readonly onDismiss: () => void;
}) {
  if (!notice) return null;
  const isError = notice.kind === 'error';
  return (
    <output
      className={isError ? 'flash-toast is-error' : 'flash-toast'}
      role={isError ? 'alert' : 'status'}
      data-t03214="notice"
      data-kind={notice.kind}
      style={isError
        ? { display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '60vw', borderColor: 'var(--danger)', color: 'var(--danger)' }
        : undefined}
    >
      <span style={{ wordBreak: 'break-word' }}>{notice.msg}</span>
      {isError && (
        <>
          <CopyButton getText={() => notice.msg} title="复制提示全文" ariaLabel="复制错误提示" />
          <button
            onClick={onDismiss}
            className="abtn"
            title="关闭提示 — 不再等待自动消失"
            aria-label="关闭提示"
            style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 4px', border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}
          >
            <X size={13} />
          </button>
        </>
      )}
    </output>
  );
}
