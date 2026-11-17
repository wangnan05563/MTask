/**
 * T05790 记忆图谱：可测纯函数（回弹数学 + 标签可见性决策）。
 *
 * 抽出的目的：门禁 `verify-t05790-memory-graph.mts` 能在无 WebGL 环境下断言真实行为，
 * 而不是只对 `MemoryGraph.tsx` 做源码正则匹配（那种门会固化成错误公式，例如把
 * 「节点间初始间距」当成「拖拽位移」）。
 */

/** 拖拽牵引位移：按被拖节点相对按下点的真实位移计算邻居偏移，并按 maxPull 限幅。 */
export function dragPullOffset(
  dx: number,
  dy: number,
  originX: number,
  originY: number,
  pull: number,
  maxPull: number,
): { x: number; y: number } {
  let tx = (dx - originX) * pull;
  let ty = (dy - originY) * pull;
  const dist = Math.hypot(tx, ty);
  if (dist > maxPull) {
    tx = (tx / dist) * maxPull;
    ty = (ty / dist) * maxPull;
  }
  return { x: tx, y: ty };
}

/** 欠阻尼弹簧单步：v' = (v - k·off)·damping，off' = off + v'。 */
export function springStep(
  off: number,
  v: number,
  stiffness: number,
  damping: number,
): { off: number; v: number } {
  const nv = (v - stiffness * off) * damping;
  return { off: off + nv, v: nv };
}

/** 标签可见性决策：选中或悬停自身恒可见；放大态（labelsAll）下所有节点恒可见。 */
export function resolveLabelVisibility(opts: {
  labelsAll: boolean;
  selected: boolean;
  hoveredSelf: boolean;
}): 'visible' | 'hidden' {
  if (opts.selected || opts.hoveredSelf) return 'visible';
  if (opts.labelsAll) return 'visible';
  return 'hidden';
}
