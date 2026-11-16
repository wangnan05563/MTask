import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * T05767：列表/泳道底部浮动滚动箭头。
 *
 * 隐藏原生滚动条后，用半透明浮动箭头保留“可滚动”的可见提示；滚轮仍由目标容器
 * 原生处理，箭头只负责点按滚动。内容未溢出或已到边界时自动禁用/隐藏。
 */
export function ScrollArrows({ targetRef, label }: { readonly targetRef: RefObject<HTMLElement | null>; readonly label: string }) {
  const [state, setState] = useState({ up: false, down: false });

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    const update = () => {
      setState({
        up: el.scrollTop > 2,
        down: el.scrollTop + el.clientHeight < el.scrollHeight - 2,
      });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [targetRef]);

  if (!state.up && !state.down) return null;

  const jump = (direction: -1 | 1) => {
    const el = targetRef.current;
    if (!el) return;
    el.scrollBy({ top: direction * Math.max(120, el.clientHeight * 0.62), behavior: 'smooth' });
  };

  const btn = (disabled: boolean): CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 26, height: 24, padding: 0, border: 'none', borderRadius: 999,
    background: 'transparent', color: disabled ? 'var(--text-muted)' : 'var(--text)',
    opacity: disabled ? 0.35 : 0.82, cursor: disabled ? 'default' : 'pointer',
  });

  return (
    <div
      data-lck="scroll-arrows"
      aria-label={`${label}滚动控制`}
      style={{
        position: 'absolute', left: '50%', bottom: 6, transform: 'translateX(-50%)',
        display: 'flex', gap: 2, zIndex: 3, padding: 3,
        borderRadius: 999, border: '1px solid var(--border)',
        background: 'color-mix(in srgb, var(--card-bg) 74%, transparent)',
        backdropFilter: 'blur(6px)', opacity: 0.72,
      }}
    >
      <button type="button" onClick={() => jump(-1)} disabled={!state.up} title={`${label}向上滚动`} aria-label={`${label}向上滚动`} style={btn(!state.up)}>
        <ChevronUp size={14} />
      </button>
      <button type="button" onClick={() => jump(1)} disabled={!state.down} title={`${label}向下滚动`} aria-label={`${label}向下滚动`} style={btn(!state.down)}>
        <ChevronDown size={14} />
      </button>
    </div>
  );
}
