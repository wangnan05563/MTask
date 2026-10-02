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

export function FlowProgress({ value, className, style, 'aria-label': ariaLabel }: FlowProgressProps) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <>
      {/* M6-6.3：S6819——a11y 语义由原生 <progress> 承载；流光视觉层是纯装饰（aria-hidden），
          避免在 div 上挂 role="progressbar"（规则要求用原生元素）。视觉层对读屏隐藏，原生进度条 sr-only 暴露数值 */}
      <progress
        value={v}
        max={100}
        aria-label={ariaLabel}
        style={{ position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
      />
      <div
        className={['flow-progress', className].filter(Boolean).join(' ')}
        style={style}
        aria-hidden="true"
      >
        <div className="flow-progress-fill" style={{ width: `${v}%` }} />
      </div>
    </>
  );
}
