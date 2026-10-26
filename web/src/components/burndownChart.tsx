/**
 * 燃尽图（T03186 / PRD PM-201④）：实际剩余线 + 理想线，两个口径各一张
 * （剩余计划行数 / 剩余工作日）。
 *
 * 沿用估算视图的自绘 SVG 红线——不引入图表库（见 `estimateCharts.tsx` 头注「② 不引入图表库」）：
 * 本应用是 Electron 离线分发，多一个运行时依赖就多一份打包与审计成本，而这里只需要两条折线。
 *
 * 口径由服务端单点给出（`IterationService.burndown`），本组件只画不算：
 * `missingDays` 与「未来日不预判」由调用方以文字说明呈现，图里不插值、不补点。
 */
import type { ReactElement } from 'react';

/** 与 `BurndownPoint` 对齐的最小绘图入参（前端不再复制一份计算，只做形状转换） */
export interface BurnPointView {
  day: string;
  remainingCount: number;
  remainingWorkdays: number;
  idealCount: number;
  idealWorkdays: number;
}

const L = 34;
const R = 470;
const TOP = 12;
const BASE = 128;

/** 折线坐标（纯函数，供验收门直接断言形状而不必驱动浏览器） */
export function burndownLine(values: readonly number[], max: number): string {
  const n = values.length;
  if (n === 0) return '';
  const span = Math.max(1, n - 1);
  return values
    .map((v, i) => `${L + (i * (R - L)) / span},${BASE - (Math.max(0, v) / max) * (BASE - TOP)}`)
    .join(' ');
}

/** 纵轴刻度：取 0 与最大值的整洁上界，避免 7、13 这种读不出来的标尺 */
export function burndownAxisMax(values: readonly number[]): number {
  const raw = Math.max(1, ...values);
  const step = raw <= 5 ? 1 : raw <= 20 ? 5 : raw <= 100 ? 10 : 50;
  return Math.ceil(raw / step) * step;
}

/** 单口径折线图：实线=实际剩余，虚线=理想递减 */
export function BurndownChart({ points, field, idealField, unit, label }: {
  readonly points: readonly BurnPointView[];
  readonly field: 'remainingCount' | 'remainingWorkdays';
  readonly idealField: 'idealCount' | 'idealWorkdays';
  readonly unit: string;
  readonly label: string;
}): ReactElement {
  if (points.length === 0) {
    return (
      <div role="status" data-t03186={`burn-empty-${field}`} style={{ padding: '14px 10px', fontSize: 'var(--fs-s)', color: 'var(--text-muted)', border: '1px dashed var(--border-strong)', borderRadius: 6 }}>
        {label}：暂无可回溯的业务日（范围尚未开始，或窗口内没有在册计划行）。
      </div>
    );
  }
  const actual = points.map((p) => p[field]);
  const ideal = points.map((p) => p[idealField]);
  const max = burndownAxisMax([...actual, ...ideal]);
  const span = Math.max(1, points.length - 1);
  const first = points[0].day;
  const last = points[points.length - 1].day;
  return (
    <svg viewBox={`0 0 480 ${BASE + 30}`} width="100%" role="img" aria-label={`${label}：${points.length} 个业务日，剩余 ${actual[actual.length - 1]} ${unit}，理想 ${ideal[ideal.length - 1]} ${unit}`} /* NOSONAR: 内联 SVG 复合图形，role=img 为 W3C 推荐无障碍写法，无等价原生元素 */
      style={{ display: 'block', maxWidth: 520 }} data-t03186={`burn-${field}`}>
      {/* 纵轴三档参考线（0 / 半程 / 峰值），只作读数辅助，不做数据 */}
      {[0, 0.5, 1].map((f) => {
        const y = BASE - f * (BASE - TOP);
        return (
          <g key={f}>
            <line x1={L} y1={y} x2={R} y2={y} stroke="var(--border)" strokeWidth={1} />
            <text x={L - 6} y={y + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">{Math.round(max * f)}</text>
          </g>
        );
      })}
      <polyline points={burndownLine(ideal, max)} fill="none" stroke="var(--text-muted)" strokeWidth={1.5} strokeDasharray="5 4" />
      <polyline points={burndownLine(actual, max)} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {points.map((p, i) => (
        <circle key={p.day} cx={L + (i * (R - L)) / span} cy={BASE - (Math.max(0, p[field]) / max) * (BASE - TOP)} r={2.8} fill="var(--accent)">
          <title>{`${p.day} · 剩余 ${p[field]} ${unit}（理想 ${p[idealField]}）`}</title>
        </circle>
      ))}
      <text x={L} y={BASE + 16} fontSize={9} fill="var(--text-muted)">{first}</text>
      <text x={R} y={BASE + 16} textAnchor="end" fontSize={9} fill="var(--text-muted)">{last}</text>
      <text x={L} y={10} fontSize={9} fill="var(--text)">{label}</text>
    </svg>
  );
}

/** 图例（两条线口径不同，颜色含义必须就近说明，不能只靠读图猜） */
export function BurndownLegend({ unit }: { readonly unit: string }): ReactElement {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
      <span><span style={{ display: 'inline-block', width: 14, height: 2, background: 'var(--accent)', verticalAlign: 'middle', marginRight: 4 }} />实际剩余（{unit}）</span>
      <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed var(--text-muted)', verticalAlign: 'middle', marginRight: 4 }} />理想递减</span>
    </div>
  );
}
