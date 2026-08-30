import { Pin, PinOff } from 'lucide-react';

/**
 * 统一「置顶/取消置顶」切换组件，供任务/配置/提示词三页面的记录列表标题复用。
 * - 未置顶：PinOff 灰色；已置顶：Pin 金色实心，点击以旋转+缩放动画切换。
 * - 动画通过 button 上的 key 变化触发重挂载来播放（与任务页 verify-pop 同一模式）。
 * - tooltip 与 aria-label 遵循项目统一格式「按钮名称 — 用途说明」/「按钮名称：用途说明」。
 */
interface PinToggleProps {
  pinned: boolean;
  onToggle: () => void;
}

export function PinToggle({ pinned, onToggle }: PinToggleProps) {
  return (
    <>
      <style>{`@keyframes pin-pop { 0% { transform: rotate(-180deg) scale(0.4); opacity: 0; } 60% { transform: rotate(0) scale(1.3); } 100% { transform: rotate(0) scale(1); opacity: 1; } }`}</style>
      <button
        key={pinned ? 'pin-on' : 'pin-off'}
        // 防止点击冒泡到祖先可点击容器（如提示词标题展开按钮），置顶与展开互不干扰
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        title={pinned ? '取消置顶 — 取消固定，恢复原有排序' : '置顶 — 将该记录固定到列表顶部'}
        aria-label={pinned ? '取消置顶：取消固定该记录' : '置顶：将该记录固定到列表顶部'}
        style={{
          fontSize: 12,
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px',
          cursor: 'pointer',
          border: 'none',
          background: 'transparent',
          color: pinned ? 'var(--warn)' : 'var(--text-muted)',
          animation: 'pin-pop 0.35s ease',
          flexShrink: 0,
        }}
      >
        {pinned ? <Pin size={13} fill="currentColor" /> : <PinOff size={13} />}
      </button>
    </>
  );
}