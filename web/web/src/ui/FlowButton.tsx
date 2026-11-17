/**
 * T01068-FR4.4：流光按钮（loading 态）组件。
 *
 * loading 时附加 .flow-btn（背景扫光动画，keyframes = flow-sweep），与进度条 / 骨架屏同源；
 * 标签沿用 .ai-shimmer 流光文字，整体呈现「流动」质感。
 * 注意：底色用 background-color 长写法，避免覆盖 .flow-btn 的 background-image（内联 background 简写会重置它）。
 * prefers-reduced-motion 下由全局 @media 自动关闭动画。
 */
import { type ButtonHTMLAttributes, type ReactNode } from 'react';

interface FlowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly loading?: boolean;
  readonly loadingText?: string;
  readonly children: ReactNode;
}

export function FlowButton({ loading, loadingText = '处理中…', children, className, style, disabled, ...rest }: FlowButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={[loading ? 'flow-btn' : '', className].filter(Boolean).join(' ')}
      style={{
        padding: '6px 16px',
        backgroundColor: 'var(--accent)',
        color: 'var(--accent-text)',
        borderRadius: 6,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        border: 'none',
        ...style,
      }}
    >
      {loading ? (
        <span className="ai-shimmer" style={{ fontWeight: 600, ['--ai-shimmer-color' as never]: 'var(--accent-text)' }}>{loadingText}</span>
      ) : (
        children
      )}
    </button>
  );
}
