/**
 * 估算可视化图表（E11 阶段柱 + ±1σ 误差线 / E11 帕累托 / E14 龙卷风）。
 * 来源：T02041 §5.4 剩余 P1/P2 图表项（派生单 T02081 / T02083）。
 *
 * 红线（与区间条 `whiskerGeometries` 同源）：
 * ① **零计算**：E/σ/比例一律取服务端 `summary`（`phases[].expected/sigma/ratio`、
 *    `rowRatios[].expected/sigma`），几何层只做「值 ÷ 基数 → 百分比 + 钳制 [0,100]」，
 *    不含任何 E/σ 公式（参照 `whiskerGeometries` 的 C-07 源码守卫写法）。
 * ② **不引入图表库**：纯 SVG/CSS 手绘（沿用 `PlanTimeline` / 区间条同范式）；
 *    颜色只取 CSS 变量，明暗双验。
 * ③ **里程碑行不进图**（§4.6 红线一）：`rowRatios` 按调用方传入的 `milestoneIds` 过滤掉里程碑。
 * ④ **归一基数取全量参与行**，不随「只看未复核」筛选变化（§5.4 v2.0 口径）。
 * ⑤ **空态不画图例**：画不出一条柱/一条曲线时不解释不存在的图形。
 */
import type { ReactElement } from 'react';
import type { EstimatePhase, PhaseStat } from '../api/estimates';

const clamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v));

/** 6 类阶段在窄图槽里的短标签（2 字，避免溢出） */
const SHORT_PHASE: Record<EstimatePhase, string> = {
  req: '需求', design: '设计', dev: '开发', impl: '实施', common: '公共', onsite: '现场',
};

// ---------------------------------------------------------------------------
// 几何纯函数（导出供 verify 脚本直接断言，不经 DOM，与 `whiskerGeometries` 同范式）
// ---------------------------------------------------------------------------

export interface PhaseBarGeom {
  readonly phase: EstimatePhase;
  /** 柱高百分比（expected ÷ 归一基数） */
  readonly ePct: number;
  /** 误差线下端百分比（expected − σ） */
  readonly loPct: number;
  /** 误差线上端百分比（expected + σ） */
  readonly hiPct: number;
  /** 该阶段是否有纳入报价的行（无数据置灰、画占位） */
  readonly hasData: boolean;
}

/**
 * 阶段柱几何（E11）：归一基数取「全部 6 阶段 expected+σ 的最大值」（让 ±1σ 误差包络完整可见，
 * 不随筛选变化；6 类阶段是模板固定结构，无筛选问题）。无数据阶段 `hasData=false`、柱高 0。
 */
export function phaseBarGeometries(phases: readonly PhaseStat[]): PhaseBarGeom[] {
  const scaleMax = Math.max(1, ...phases.map((p) => p.expected + p.sigma));
  const toPct = (v: number): number => clamp((v / scaleMax) * 100);
  return phases.map((p) => ({
    phase: p.phase,
    ePct: toPct(p.expected),
    loPct: toPct(p.expected - p.sigma),
    hiPct: toPct(p.expected + p.sigma),
    hasData: p.rowCount > 0,
  }));
}

export interface ParetoGeom {
  readonly key: string;
  /** 单条柱高百分比（expected ÷ 同批最大 expected） */
  readonly ePct: number;
  /** 累计占比百分比（累计 expected ÷ 全批 expected 之和） */
  readonly cumPct: number;
}

/**
 * 帕累托几何（E11）：按 expected 降序；归一基数——
 *   柱高取「同批最大 expected」（行间可比）；
 *   累计百分比取「全批 expected 之和」（§5.4 v2.0：基数取全部参与行，不随筛选变化）。
 * 里程碑行不进图（调用方先按 `milestoneIds` 滤掉）。无有效行返回空（空态不画）。
 */
export function paretoGeometries(
  rows: ReadonlyArray<{ key: string; expected: number }>,
  milestoneIds: ReadonlySet<string>,
): ParetoGeom[] {
  const valid = rows.filter((r) => !milestoneIds.has(r.key) && r.expected > 0);
  if (valid.length === 0) return [];
  const sorted = [...valid].sort((a, b) => b.expected - a.expected);
  const maxE = Math.max(...sorted.map((r) => r.expected));
  const total = sorted.reduce((s, r) => s + r.expected, 0);
  let cum = 0;
  return sorted.map((r) => {
    cum += r.expected;
    return { key: r.key, ePct: (r.expected / maxE) * 100, cumPct: (cum / total) * 100 };
  });
}

export interface TornadoGeom {
  readonly key: string;
  readonly title: string;
  /** 横向条宽百分比（σ ÷ 同批最大 σ） */
  readonly sigmaPct: number;
  /** 实际 σ 值（人天），仅供条尾读数显示，不参与几何 */
  readonly sigma: number;
}

/**
 * 龙卷风几何（E14）：按 σ 降序；条宽取「σ ÷ 同批最大 σ」（最影响总价的行最长，置顶）。
 * 数据源 `rowRatios[].sigma`（v1.8 已定死：逐行 σ 唯一来源是引擎 additive 补出的该字段，
 * 面板不得自己写 `sigma()`）。里程碑行不进图。无有效 σ 返回空。
 */
export function tornadoGeometries(
  rows: ReadonlyArray<{ key: string; title: string; sigma: number }>,
  milestoneIds: ReadonlySet<string>,
): TornadoGeom[] {
  const valid = rows.filter((r) => !milestoneIds.has(r.key) && r.sigma > 0);
  const sorted = [...valid].sort((a, b) => b.sigma - a.sigma);
  if (sorted.length === 0) return [];
  const maxS = Math.max(1e-9, ...sorted.map((r) => r.sigma));
  return sorted.map((r) => ({ key: r.key, title: r.title, sigma: r.sigma, sigmaPct: (r.sigma / maxS) * 100 }));
}

// ---------------------------------------------------------------------------
// SVG 组件（纯手绘，颜色只取 CSS 变量，明暗双验）
// ---------------------------------------------------------------------------

const num = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '') || '0';

/** E11 阶段柱 + ±1σ 误差线（竖向柱，6 类阶段；无数据置灰占位） */
export function PhaseBarChart({ phases, phaseLabels }: {
  readonly phases: readonly PhaseStat[];
  readonly phaseLabels: Record<EstimatePhase, string>;
}): ReactElement {
  const geoms = phaseBarGeometries(phases);
  const L = 10, R = 270, BASE = 136, TOP = 14, H = BASE - TOP;
  const slot = (R - L) / geoms.length;
  const barW = Math.min(26, slot * 0.6);
  return (
    <svg viewBox={`0 0 280 158`} width="100%" role="img" aria-label="阶段柱与误差线（E11）" /* NOSONAR: 内联 SVG 复合图形，role=img 为 W3C 推荐无障碍写法，无等价原生元素 */
      style={{ display: 'block', maxWidth: 360 }}>
      {geoms.map((g, i) => {
        const cx = L + i * slot + slot / 2;
        const bx = cx - barW / 2;
        const barH = (g.ePct / 100) * H;
        const barTop = BASE - barH;
        const yHi = BASE - (g.hiPct / 100) * H;
        const yLo = BASE - (g.loPct / 100) * H;
        const label = SHORT_PHASE[g.phase] ?? phaseLabels[g.phase] ?? g.phase;
        if (!g.hasData) {
          return (
            <g key={g.phase}>
              <rect x={bx} y={BASE - 2} width={barW} height={2} fill="var(--border-strong)" opacity={0.5} />
              <text x={cx} y={150} textAnchor="middle" fontSize={9} fill="var(--text-muted)">{label}</text>
              <text x={cx} y={BASE - 6} textAnchor="middle" fontSize={8} fill="var(--text-muted)">未纳入</text>
            </g>
          );
        }
        return (
          <g key={g.phase}>
            <rect x={bx} y={barTop} width={barW} height={Math.max(1, barH)} rx={2} fill="var(--accent)" opacity={0.9} />
            {/* ±1σ 误差线（顶端细线，不填色，避免与柱高混淆） */}
            <line x1={cx} y1={yHi} x2={cx} y2={yLo} stroke="var(--text-muted)" strokeWidth={1.5} />
            <line x1={cx - 4} y1={yHi} x2={cx + 4} y2={yHi} stroke="var(--text-muted)" strokeWidth={1.5} />
            <line x1={cx - 4} y1={yLo} x2={cx + 4} y2={yLo} stroke="var(--text-muted)" strokeWidth={1.5} />
            <text x={cx} y={barTop - 3} textAnchor="middle" fontSize={9} fill="var(--text)">{num(phases[i].expected)}</text>
            <text x={cx} y={150} textAnchor="middle" fontSize={9} fill="var(--text-muted)">{label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** E11 帕累托：按行 E 降序的柱 + 累计占比折线 + 80% 参考线 */
export function ParetoChart({ geoms }: { readonly geoms: readonly ParetoGeom[] }): ReactElement {
  const n = geoms.length;
  const L = 36, R = 460, BASE = 164, TOP = 14, H = BASE - TOP;
  const slot = (R - L) / Math.max(1, n);
  const barW = Math.min(slot * 0.7, 14);
  const y80 = BASE - 0.8 * H;
  const pts = geoms.map((g, i) => {
    const cx = L + i * slot + slot / 2;
    return `${cx},${BASE - (g.cumPct / 100) * H}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 480 ${BASE + 24}`} width="100%" role="img" aria-label="帕累托图（E11）" /* NOSONAR: 内联 SVG 复合图形，role=img 为 W3C 推荐无障碍写法，无等价原生元素 */
      style={{ display: 'block' }}>
      {/* 80% 累计参考线 */}
      <line x1={L} y1={y80} x2={R} y2={y80} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="4 3" />
      <text x={R} y={y80 - 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">80%</text>
      {geoms.map((g, i) => {
        const cx = L + i * slot + (slot - barW) / 2;
        const barH = (g.ePct / 100) * H;
        return (
          <rect key={g.key} x={cx} y={BASE - barH} width={barW} height={Math.max(1, barH)} rx={1}
            fill="var(--accent)" opacity={0.85} />
        );
      })}
      {/* 累计占比折线（实心点，红线路语义过重，用主文本色） */}
      <polyline points={pts} fill="none" stroke="var(--text)" strokeWidth={1.5} />
      {geoms.map((g, i) => {
        const cx = L + i * slot + slot / 2;
        return <circle key={`c-${g.key}`} cx={cx} cy={BASE - (g.cumPct / 100) * H} r={1.6} fill="var(--text)" />;
      })}
      {n <= 14 && geoms.map((g, i) => {
        const cx = L + i * slot + slot / 2;
        return <text key={`t-${g.key}`} x={cx} y={BASE + 12} textAnchor="middle" fontSize={8} fill="var(--text-muted)">{i + 1}</text>;
      })}
    </svg>
  );
}

/** E14 龙卷风：各行 σ 降序的横向条，最长 = 最影响总价 */
export function TornadoChart({ geoms }: { readonly geoms: readonly TornadoGeom[] }): ReactElement {
  const n = geoms.length;
  const H = Math.max(70, n * 20 + 28);
  // T02083 实测修复：σ 数值画在条尾右侧（textAnchor 默认 start）。原来 X1 顶到 462，最长条
  // （= 该图唯一要人读的那一行）的数值从 x≈466 起画，直接越过 viewBox 宽 480 被 SVG 裁掉。
  // 故按「最长数值标签（如 108.5）」预留固定宽度，条区右界退到预留位之前，保证任何 σ 都画得下。
  const SIGMA_LABEL_RESERVE = 46;
  const LABEL_W = 132, X0 = 138, X1 = 480 - SIGMA_LABEL_RESERVE, barMaxW = X1 - X0;
  return (
    <svg viewBox={`0 0 480 ${H}`} width="100%" role="img" aria-label="龙卷风图（E14 敏感性）" /* NOSONAR: 内联 SVG 复合图形，role=img 为 W3C 推荐无障碍写法，无等价原生元素 */
      style={{ display: 'block' }}>
      {n > 0 && (
        <text x={X0} y={14} fontSize={9} fill="var(--text-muted)">条长 ∝ σ（降序）· 最长 = 最影响总价</text>
      )}
      {geoms.map((g, i) => {
        const y = 22 + i * 20;
        const w = (g.sigmaPct / 100) * barMaxW;
        const title = g.title.length > 9 ? `${g.title.slice(0, 8)}…` : g.title;
        return (
          <g key={g.key}>
            <text x={LABEL_W - 6} y={y + 12} textAnchor="end" fontSize={10} fill="var(--text-muted)">{title}</text>
            <rect x={X0} y={y + 3} width={Math.max(2, w)} height={14} rx={2} fill="var(--accent)" opacity={0.85} />
            <text x={X0 + Math.max(2, w) + 4} y={y + 13} fontSize={9} fill="var(--text-muted)">{num(g.sigma)}</text>
          </g>
        );
      })}
    </svg>
  );
}
