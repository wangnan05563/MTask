import { Star, StarOff } from 'lucide-react';

/**
 * T03683：统一「收藏/取消收藏」切换组件，供提示词页与通用需求页的记录列表标题复用。
 * - 视觉与交互刻意与 PinToggle 保持一致（同尺寸、同动画节奏、同 tooltip/aria 语序），
 *   只把语义从「固定到顶部」换成「加入/移出产收藏」——用户对两枚图标的区分靠图形而非颜色。
 * - 未收藏：StarOff 灰色；已收藏：Star 实心（用 --warn 同系高亮色）。动画通过 button 上的
 *   key 变化触发重挂载播放（与 PinToggle 的 pin-pop / 任务页 verify-pop 同一模式）。
 * - 与置顶正交：置顶影响排序，收藏只影响筛选，因此这里不碰 sort_weight / pinned。
 */
interface FavoriteToggleProps {
  readonly favorited: boolean;
  readonly onToggle: () => void;
  /** 移动端传 18：图标与内边距同步放大到可点按的触摸目标（桌面端保持 13，与 PinToggle 对齐） */
  readonly size?: number;
}

export function FavoriteToggle({ favorited, onToggle, size = 13 }: FavoriteToggleProps) {
  return (
    <>
      <style>{`@keyframes fav-pop { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.3); } 100% { transform: scale(1); opacity: 1; } }`}</style>
      <button
        key={favorited ? 'fav-on' : 'fav-off'}
        data-favorite-toggle={favorited ? 'on' : 'off'}
        // 防止点击冒泡到祖先可点击容器（如标题展开按钮），收藏与展开互不干扰
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        title={favorited ? '取消收藏 — 从我的收藏移除' : '收藏 — 加入我的收藏，便于筛选'}
        aria-label={favorited ? '取消收藏：将该记录移出收藏' : '收藏：将该记录加入收藏'}
        aria-pressed={favorited}
        style={{
          fontSize: 'var(--fs-s)',
          display: 'inline-flex',
          alignItems: 'center',
          padding: size > 13 ? 6 : 2,
          cursor: 'pointer',
          border: 'none',
          background: 'transparent',
          color: favorited ? 'var(--warn)' : 'var(--text-muted)',
          animation: 'fav-pop 0.3s ease',
          flexShrink: 0,
        }}
      >
        {favorited ? <Star size={size} fill="currentColor" /> : <StarOff size={size} />}
      </button>
    </>
  );
}
