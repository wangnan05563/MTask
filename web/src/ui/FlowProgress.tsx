/**
 * T01068-FR4.4：流光进度条组件。
 *
 * 复用全局 .flow-progress / .flow-progress-fill（background 扫光动画，keyframes = flow-sweep），
 * 与骨架屏 / 按钮 loading 同源，满足「三类组件使用同一 keyframes」。
 * prefers-reduced-motion 下由全局 @media 自动关闭动画，回退为静态填充。
 */
import { type CSSProperties } from 'react';

interface FlowProgressProps {
  /** 进度 0-100 */
  readonly value: number;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly 'aria-label'?: string;
}

export function FlowProgress({ value, className, style, ...rest }: FlowProgressProps) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className={['flow-progress', className].filter(Boolean).join(' ')}
      style={style}
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      {...rest}
    >
      <div className="flow-progress-fill" style={{ width: `${v}%` }} />
    </div>
  );
}
