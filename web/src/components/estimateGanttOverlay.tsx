/**
 * E8 · 甘特条叠加半透明 O~P 区间（T02041 §5.4 可视化图表，P1）
 * ---------------------------------------------------------------------------
 * 定位：本文件是【独立、未接入】组件。刻意不改动 `web/src/pages/PlanPage.tsx`，
 * 等两条硬前置同时满足后再由集成方挂入（见文件底部「集成接入点」）。
 *
 * 两条硬前置（来源 .t02041-d-e8.md，本单刻意不与区间条同批做）：
 *   1. 业主放行：E8 属 P1，不在 2026-10-11 D5 签字的先行批次（E0+E1~E4+E6）内。
 *   2. 并发改动：PlanPage.tsx 此刻有其它会话的未提交改动（时间线/甘特相关），
 *      在同批提交里叠加大改会让 hunk 归属不可辨——本组件单成文件、零侵入，
 *      集成方改 PlanPage 时只需新增 3 行（见底部），hunk 边界清晰。
 *
 * 几何与红线：
 *   - 坐标模型与 `renderGantt` 的依赖连线 SVG 完全一致：
 *       x = labelW + toIdx(d)·dayW；行高 rowH、条内 top:5/height:18 照搬。
 *     因此叠加层与甘特条逐像素对齐，叠加后【不产生横向滚动、条上文字不截断】。
 *   - 三点值只取服务端那一份（§9 零计算红线）：O/P 来自 EstimateItem（optimistic/
 *     pessimistic），E 来自 summary.rowRatios[key].expected（服务端已算好的 E）。
 *     本组件【不做第二次 PERT/E/σ 运算】，几何层只算 (E-O)/(P-O) 这一道比值并钳到
 *     [0,1]——属于「value÷base→% 钳位」白名单，不在禁算之列。
 *   - 颜色只走 CSS 变量 + 透明度（var(--accent) / var(--text-muted)），明暗双验。
 *   - 无估算行的任务、或 P≤O、或 O/P/E 任一非有限/≤0，一律【不画叠加层、不猜数】。
 *   - 与估算面板开关互相独立（§5.2）：叠加层由集成方自己的 gantt 估算开关控制，
 *     面板开合不改变甘特视图，故本组件不读面板开关状态。
 * ---------------------------------------------------------------------------
 */
import type { ReactElement } from 'react';

const DAY_MS = 86400000;

/** 单条甘特行的估算叠加输入（集成方按 planId 从服务端数据装配） */
export interface GanttEstimateRow {
  id: string;
  title: string;
  /** 计划开始日 YYYY-MM-DD（与 PlanPage 该行一致） */
  startDate: string;
  /** 计划结束日 YYYY-MM-DD */
  endDate: string;
  /** 0-based 行序，必须与甘特渲染行序一致，否则纵向错位 */
  rowIndex: number;
  /** 服务端三点值；缺失或非法则该行跳过（不猜数） */
  estimate?: { optimistic: number; pessimistic: number; expected: number };
}

export interface EstimateGanttOverlayProps {
  rows: ReadonlyArray<GanttEstimateRow>;
  /** 甘特 rangeStart（YYYY-MM-DD），与 PlanPage 同口径 */
  rangeStart: string;
  /** toIdx(rangeEnd)+1，决定 SVG 宽度（= 甘特网格宽，避免横向滚动） */
  totalDays: number;
  /** 每天列宽 px，默认 18（与 PlanPage DAY_W 一致） */
  dayW?: number;
  /** 标签列宽 px，默认 220（与 PlanPage 标签列一致） */
  labelW?: number;
  /** 行高 px，默认 30（与 PlanPage 行高一致） */
  rowHeight?: number;
  /** 条内顶部偏移 px，默认 5（与 PlanPage 任务条 top 一致） */
  barTop?: number;
  /** 条高 px，默认 18（与 PlanPage 任务条 height 一致） */
  barHeight?: number;
  /** 叠加层 zIndex，默认 3（高于依赖连线 SVG 的 2） */
  zIndex?: number;
  /** 集成方的甘特估算开关；false 时不渲染（与面板开关无关） */
  visible?: boolean;
}

/** 纯几何输出（供 verify 脚本断言，无 DOM） */
export interface GanttEstimateBand {
  id: string;
  rowIndex: number;
  /** 区间左缘 px（含 labelW 偏移，网格坐标） */
  barLeft: number;
  /** 区间宽 px（= 甘特条宽，O→左缘、P→右缘） */
  barWidth: number;
  /** 半透明 O~P 带顶部 px */
  bandTop: number;
  bandHeight: number;
  /** E 标记线 x px（区间内按 (E-O)/(P-O) 定位） */
  eLineX: number;
  /** 钳位后的 E 占比 [0,1] */
  eRatio: number;
}

function toIdx(d: string, rangeStart: string): number {
  // 与 PlanPage.renderGantt.toIdx 完全一致，保证逐像素对齐
  return Math.round(
    (new Date(d + 'T00:00:00').getTime() - new Date(rangeStart + 'T00:00:00').getTime()) / DAY_MS,
  );
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 计算每行叠加几何。仅做比值钳位，无任何 PERT/E/σ 运算。
 * 返回数组已剔除非法行（无估算 / P≤O / O·P·E 非有限或 ≤0 / 缺起止日）。
 */
export function ganttEstimateGeometries(
  rows: ReadonlyArray<GanttEstimateRow>,
  opts: { rangeStart: string; dayW?: number; labelW?: number; rowHeight?: number; barTop?: number; barHeight?: number },
): GanttEstimateBand[] {
  const dayW = opts.dayW ?? 18;
  const labelW = opts.labelW ?? 220;
  const rowH = opts.rowHeight ?? 30;
  const barTop = opts.barTop ?? 5;
  const barH = opts.barHeight ?? 18;
  const bandH = 8; // 区间内带高度，居中于任务条
  const out: GanttEstimateBand[] = [];

  for (const r of rows) {
    const est = r.estimate;
    if (!est) continue; // 无估算行：不画叠加层（不猜数）
    const { optimistic: O, pessimistic: P, expected: E } = est;
    // 非法数据：静默跳过，不猜测
    if (!r.startDate || !r.endDate) continue;
    if (!Number.isFinite(O) || !Number.isFinite(P) || !Number.isFinite(E)) continue;
    if (O <= 0 || P <= 0 || E <= 0) continue;
    if (P <= O) continue; // 退化区间，无法定位 E，跳过

    const left = toIdx(r.startDate, opts.rangeStart);
    const right = toIdx(r.endDate, opts.rangeStart);
    const barLeft = labelW + left * dayW;
    const barWidth = Math.max(dayW, (right - left + 1) * dayW); // 与 PlanPage 条宽公式一致

    const eRatio = clamp01((E - O) / (P - O)); // 纯比值，白名单内
    const eLineX = barLeft + eRatio * barWidth;

    out.push({
      id: r.id,
      rowIndex: r.rowIndex,
      barLeft,
      barWidth,
      bandTop: r.rowIndex * rowH + barTop + (barH / 2) - bandH / 2,
      bandHeight: bandH,
      eLineX,
      eRatio,
    });
  }
  return out;
}

/**
 * E8 叠加层 SVG：与依赖连线 SVG 同尺寸、同坐标、绝对定位覆盖在甘特行容器之上。
 * 半透明 O~P 带（铺满甘特条宽，表示区间）+ E 细线（区间内定位）+ O/P 两端刻度。
 */
export function EstimateGanttOverlay(props: Readonly<EstimateGanttOverlayProps>): ReactElement | null {
  const {
    rows,
    rangeStart,
    totalDays,
    dayW = 18,
    labelW = 220,
    rowHeight = 30,
    barTop = 5,
    barHeight = 18,
    zIndex = 3,
    visible = true,
  } = props;

  if (!visible) return null;

  const bands = ganttEstimateGeometries(rows, { rangeStart, dayW, labelW, rowHeight, barTop, barHeight });
  if (bands.length === 0) return null; // 无有效估算行：不渲染（不猜数）

  const width = labelW + totalDays * dayW;
  const height = rows.length * rowHeight;

  return (
    <svg
      width={width}
      height={height}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex }}
      aria-hidden
    >
      {bands.map((b) => {
        const eTop = b.rowIndex * rowHeight + barTop;
        return (
          <g key={b.id}>
            {/* O~P 半透明区间带：铺满甘特条宽，O→左缘、P→右缘 */}
            <rect
              x={b.barLeft}
              y={b.bandTop}
              width={b.barWidth}
              height={b.bandHeight}
              rx={2}
              fill="var(--accent)"
              fillOpacity={0.18}
              stroke="var(--accent)"
              strokeOpacity={0.35}
              strokeWidth={1}
            />
            {/* O / P 两端刻度，标出区间边界 */}
            <line x1={b.barLeft} y1={b.bandTop - 1} x2={b.barLeft} y2={b.bandTop + b.bandHeight + 1} stroke="var(--accent)" strokeOpacity={0.5} strokeWidth={1.5} />
            <line x1={b.barLeft + b.barWidth} y1={b.bandTop - 1} x2={b.barLeft + b.barWidth} y2={b.bandTop + b.bandHeight + 1} stroke="var(--accent)" strokeOpacity={0.5} strokeWidth={1.5} />
            {/* E 期望细线：区间内按 (E-O)/(P-O) 定位 */}
            <line x1={b.eLineX} y1={eTop} x2={b.eLineX} y2={eTop + barHeight} stroke="var(--accent)" strokeWidth={2} />
          </g>
        );
      })}
    </svg>
  );
}

/*
 * ┌─ 集成接入点（满足两条硬前置后由 PlanPage 集成方落地，无需改本文件）──────────┐
 * │ 在 web/src/pages/PlanPage.tsx 的 renderGantt 中：                          │
 * │                                                                            │
 * │ 1) import { EstimateGanttOverlay } from '../components/estimateGanttOverlay';│
 * │                                                                            │
 * │ 2) 新增本页开关态（与估算面板开关无关）：                                    │
 * │    const [showGanttEstimate, setShowGanttEstimate] = useState(false);       │
 * │    // 并在甘特工具栏加一个独立勾选 / 图标按钮绑定 setShowGanttEstimate       │
 * │                                                                            │
 * │ 3) 在 {renderDepsOverlay(...)} 的 <svg> 之后、同一 `position:relative`       │
 * │    行容器内，追加（按 planId 装配 O/P 自 EstimateItem、E 自 summary.rowRatios）：│
 * │    {showGanttEstimate && (                                                 │
 * │      <EstimateGanttOverlay                                                 │
 * │        rows={ganttPlans.map((p, i) => ({                                  │
 * │          id: p.id, title: p.title, startDate: p.start_date,               │
 * │          endDate: p.end_date, rowIndex: i,                                │
 * │          estimate: estByPlan.get(p.id)                                    │
 * │            ? { optimistic: estByPlan.get(p.id)!.optimistic,                │
 * │                pessimistic: estByPlan.get(p.id)!.pessimistic,             │
 * │                expected: rowRatiosByPlan.get(p.id)?.expected ?? 0 }       │
 * │            : undefined,                                                    │
 * │        }))}                                                                │
 * │        rangeStart={rangeStart} totalDays={totalDays}                       │
 * │        visible={showGanttEstimate}                                         │
 * │      />                                                                     │
 * │    )}                                                                       │
 * │                                                                            │
 * │ 注：estByPlan / rowRatiosByPlan 由 GET /api/estimates 的 items / summary    │
 * │ 按 planId 建 Map；E 取服务端 expected，O/P 取服务端 optimistic/pessimistic，  │
 * │ 本组件不做任何二次运算。dayW/labelW/rowHeight 用 PlanPage 当前常量即可对齐。  │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
