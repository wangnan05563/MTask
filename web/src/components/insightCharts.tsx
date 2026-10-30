/**
 * 项目洞察四图（T03236 / PRD PM-205）：CFD、周期时间、逾期趋势、吞吐。
 *
 * 沿用估算视图/燃尽图的自绘 SVG 路线（`estimateCharts.tsx`「不引入图表库」）：Electron 离线分发，
 * 多一个运行时依赖就多一份打包与审计成本；这里四张图都只需要轴 + 折线/面积/柱。
 *
 * 数据口径单源在服务端 `GET /metrics/day-snapshots`（T03237 日快照）：前端只做形状转换，
 * 缺失日 `missing=true` 且读数为 null —— **不插值、不补零**，以空档 + 「数据积累中」色带呈现。
 */
import type { ReactElement } from 'react';

export interface InsightDay {
  date: string;
  missing: boolean;
  todo: number | null;
  done: number | null;
  created: number | null;
  completed: number | null;
  dueTotal: number | null;
  overdue: number | null;
  cycleP50Hours: number | null;
  cycleP90Hours: number | null;
}

const W = 520;
const H = 190;
const L = 46;
const R = 506;
const TOP = 16;
const BASE = 152;
/** 缺失区间底色：只做视觉空档提示，不承载数据 */
const GAP_FILL = '#94a3b8';
const C_DONE = '#10b981';
const C_TODO = '#f59e0b';
const C_P50 = '#3b82f6';
const C_P90 = '#8b5cf6';
const C_BAD = '#ef4444';
const C_CREATED = '#0ea5e9';

export function xAt(index: number, total: number): number {
  if (total <= 1) return (L + R) / 2;
  return L + (index * (R - L)) / (total - 1);
}

/** 整刻度上界（计数与 0..1 比率都适用）：0 值也给出 1，避免除零与压扁 */
export function niceMax(values: ReadonlyArray<number | null | undefined>): number {
  const raw = Math.max(0, ...values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / pow;
  let step: number;
  if (norm <= 1) {
    step = 1;
  } else if (norm <= 2) {
    step = 2;
  } else if (norm <= 5) {
    step = 5;
  } else {
    step = 10;
  }
  return step * pow;
}

export function yAt(value: number, max: number): number {
  const clamped = Math.max(0, Math.min(value, max));
  return BASE - (clamped / max) * (BASE - TOP);
}

/** 连续非空段：缺失日把折线断开（不插值），每段一条 path */
export function lineSegments(values: ReadonlyArray<number | null>, max: number): string[] {
  const segs: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 0) segs.push(cur.join(' '));
      cur = [];
      return;
    }
    cur.push(`${cur.length === 0 ? 'M' : 'L'}${xAt(i, values.length).toFixed(1)},${yAt(v, max).toFixed(1)}`);
  });
  if (cur.length > 0) segs.push(cur.join(' '));
  return segs;
}

/** 两条累计线之间的面积（CFD 的堆叠带）；任一侧缺失即断段，分段仍按原始下标定位 */
export function areaBetweenSegments(upper: ReadonlyArray<number | null>, lower: ReadonlyArray<number | null>, max: number): string[] {
  const segs: string[] = [];
  const n = upper.length;
  let up: number[] = [];
  let lo: number[] = [];
  let idx: number[] = [];
  const flush = () => {
    if (up.length >= 2) {
      const forward = up.map((v, k) => `${k === 0 ? 'M' : 'L'}${xAt(idx[k], n).toFixed(1)},${yAt(v, max).toFixed(1)}`);
      const back = [...idx].reverse().map((dayIdx, k) => `L${xAt(dayIdx, n).toFixed(1)},${yAt(lo[lo.length - 1 - k], max).toFixed(1)}`);
      segs.push([...forward, ...back, 'Z'].join(' '));
    }
    up = [];
    lo = [];
    idx = [];
  };
  upper.forEach((v, i) => {
    const lv = lower[i];
    if (v === null || lv === null) { flush(); return; }
    up.push(v);
    lo.push(lv);
    idx.push(i);
  });
  flush();
  return segs;
}

/** 缺失区间（连续 missing=true 的下标段） */
export function missingRuns(days: ReadonlyArray<{ missing: boolean }>): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  days.forEach((d, i) => {
    if (d.missing && start < 0) start = i;
    if (!d.missing && start >= 0) { runs.push({ start, end: i - 1 }); start = -1; }
  });
  if (start >= 0) runs.push({ start, end: days.length - 1 });
  return runs;
}

function GapBands({ days }: { readonly days: readonly InsightDay[] }): ReactElement {
  const n = days.length;
  const half = n <= 1 ? (R - L) / 2 : (R - L) / (n - 1) / 2;
  return (
    <g data-t03236-gaps={missingRuns(days).length}>
      {missingRuns(days).map((r) => {
        const x1 = xAt(r.start, n) - half;
        const x2 = xAt(r.end, n) + half;
        const wide = x2 - x1 >= 52;
        return (
          <g key={`${r.start}-${r.end}`}>
            <rect x={x1} y={TOP - 4} width={x2 - x1} height={BASE - TOP + 4} fill={GAP_FILL} opacity={0.16} />
            {wide && (
              <text x={(x1 + x2) / 2} y={(TOP + BASE) / 2} textAnchor="middle" fontSize={8} fill="#64748b">数据积累中</text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** PM-205③：每张图内标注可回溯起点（虚线 + 日期），导出 PNG 时随图带走 */
function TraceableMark({ days }: { readonly days: readonly InsightDay[] }): ReactElement | null {
  const idx = days.findIndex((d) => !d.missing);
  if (idx < 0) return null;
  const x = xAt(idx, days.length);
  return (
    <g data-t03236-traceable={days[idx].date}>
      <line x1={x} y1={TOP - 2} x2={x} y2={BASE} stroke={GAP_FILL} strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
      <text x={R} y={10} textAnchor="end" fontSize={8} fill="#64748b">{`可回溯起点 ${days[idx].date}`}</text>
    </g>
  );
}

function Axes({ days, max, format }: { readonly days: readonly InsightDay[]; readonly max: number; readonly format: (v: number) => string }): ReactElement {
  const n = days.length;
  return (
    <g>
      {[0, 0.5, 1].map((f) => {
        const y = BASE - f * (BASE - TOP);
        return (
          <g key={f}>
            <line x1={L} y1={y} x2={R} y2={y} stroke="#cbd5e1" strokeWidth={1} />
            <text x={L - 5} y={y + 3} textAnchor="end" fontSize={8} fill="#64748b">{format(max * f)}</text>
          </g>
        );
      })}
      {n > 0 && <text x={L} y={BASE + 14} fontSize={8} fill="#64748b">{days[0].date}</text>}
      {n > 1 && <text x={R} y={BASE + 14} textAnchor="end" fontSize={8} fill="#64748b">{days[n - 1].date}</text>}
    </g>
  );
}

function SvgShell({ label, days, svgRef, testId, children }: {
  readonly label: string; readonly days: readonly InsightDay[]; readonly svgRef?: (el: SVGSVGElement | null) => void;
  readonly testId: string; readonly children: React.ReactNode;
}): ReactElement {
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}
      data-t03236={testId} style={{ display: 'block', background: 'var(--card-bg)', borderRadius: 6 }}>
      <TraceableMark days={days} />
      {children}
    </svg>
  );
}

function Empty({ text }: { readonly text: string }): ReactElement {
  return (
    <div style={{ padding: '14px 10px', fontSize: 'var(--fs-s)', color: 'var(--text-muted)', border: '1px dashed var(--border-strong)', borderRadius: 6 }}>
      {text}
    </div>
  );
}

/** ① 累计流图：已完成累计（下带）+ 待办累计（上带） */
export function CfdChart({ days, svgRef }: { readonly days: readonly InsightDay[]; readonly svgRef?: (el: SVGSVGElement | null) => void }): ReactElement {
  if (days.filter((d) => !d.missing).length === 0) return <Empty text="CFD：暂无可回溯的统计日（日快照尚未积累）。" />;
  const totals = days.map((d) => (d.todo === null || d.done === null ? null : d.todo + d.done));
  const max = niceMax([...totals, ...days.map((d) => d.done)]);
  const doneVals = days.map((d) => d.done);
  const totalVals = totals;
  return (
    <SvgShell days={days} label={`累计流图：${days.length} 天，最新待办 ${days.at(-1)?.todo ?? '缺失'}，已完成 ${days.at(-1)?.done ?? '缺失'}`} svgRef={svgRef} testId="cfd">
      <Axes days={days} max={max} format={(v) => String(Math.round(v))} />
      <GapBands days={days} />
      {areaBetweenSegments(doneVals, days.map(() => 0), max).map((p, i) => <path key={`d${i}`} /* NOSONAR - 面积段由连续可采样区间切分而来，位置即身份，无稳定业务 id */ d={p} fill={C_DONE} opacity={0.75} />)}
      {areaBetweenSegments(totalVals, doneVals, max).map((p, i) => <path key={`t${i}`} /* NOSONAR - 面积段由连续可采样区间切分而来，位置即身份，无稳定业务 id */ d={p} fill={C_TODO} opacity={0.6} />)}
      {days.map((d, i) => (d.missing ? null : (
        <circle key={d.date} cx={xAt(i, days.length)} cy={yAt((d.todo ?? 0) + (d.done ?? 0), max)} r={2.2} fill={C_TODO}>
          <title>{`${d.date} · 待办 ${d.todo ?? '—'} · 已完成 ${d.done ?? '—'}`}</title>
        </circle>
      )))}
      <text x={L} y={10} fontSize={9} fill="var(--text)">CFD 累计流</text>
    </SvgShell>
  );
}

/** ② 周期时间：按完成日的 P50/P90（小时） */
export function CycleChart({ days, svgRef }: { readonly days: readonly InsightDay[]; readonly svgRef?: (el: SVGSVGElement | null) => void }): ReactElement {
  const present = days.filter((d) => !d.missing);
  if (present.length === 0) return <Empty text="周期时间：暂无可回溯的统计日（日快照尚未积累）。" />;
  const max = niceMax([...days.map((d) => d.cycleP50Hours), ...days.map((d) => d.cycleP90Hours)]);
  const fmt = (v: number) => (max <= 2 ? `${Math.round(v * 100) / 100}h` : `${Math.round(v)}h`);
  return (
    <SvgShell days={days} label={`周期时间：${present.length} 个统计日，P50/P90 折线`} svgRef={svgRef} testId="cycle">
      <Axes days={days} max={max} format={fmt} />
      <GapBands days={days} />
      {lineSegments(days.map((d) => d.cycleP90Hours), max).map((p, i) => (
        <path key={`p90-${i}`} /* NOSONAR - 折线段按缺失日切分，位置即身份，无稳定业务 id */ d={p} fill="none" stroke={C_P90} strokeWidth={1.6} strokeDasharray="5 4" />
      ))}
      {lineSegments(days.map((d) => d.cycleP50Hours), max).map((p, i) => (
        <path key={`p50-${i}`} /* NOSONAR - 折线段按缺失日切分，位置即身份，无稳定业务 id */ d={p} fill="none" stroke={C_P50} strokeWidth={2} />
      ))}
      {days.map((d, i) => (d.cycleP50Hours === null || d.missing ? null : (
        <circle key={d.date} cx={xAt(i, days.length)} cy={yAt(d.cycleP50Hours, max)} r={2.2} fill={C_P50}>
          <title>{`${d.date} · P50 ${d.cycleP50Hours}h · P90 ${d.cycleP90Hours ?? '—'}h`}</title>
        </circle>
      )))}
      <text x={L} y={10} fontSize={9} fill="var(--text)">周期时间（完成日）</text>
    </SvgShell>
  );
}

/** ③ 逾期趋势：逾期数量柱 + 逾期率线（右轴 0..100%）；分母 0 的当天不给率 */
export function OverdueTrendChart({ days, svgRef }: { readonly days: readonly InsightDay[]; readonly svgRef?: (el: SVGSVGElement | null) => void }): ReactElement {
  const present = days.filter((d) => !d.missing);
  if (present.length === 0) return <Empty text="逾期趋势：暂无可回溯的统计日（日快照尚未积累）。" />;
  const countMax = niceMax(days.map((d) => d.overdue));
  const n = days.length;
  const bw = n <= 1 ? 16 : Math.max(2, Math.min(14, ((R - L) / (n - 1)) * 0.55));
  const rateAt = (d: InsightDay): number | null => (d.dueTotal && d.overdue !== null ? d.overdue / d.dueTotal : null);
  const rates = days.map(rateAt);
  const hasRate = rates.some((v) => v !== null);
  return (
    <SvgShell days={days} label={`逾期趋势：${present.length} 个统计日，${hasRate ? '含逾期率' : '暂无可比计划'}`} svgRef={svgRef} testId="overdue">
      <Axes days={days} max={countMax} format={(v) => String(Math.round(v))} />
      <GapBands days={days} />
      {days.map((d, i) => {
        if (d.missing || d.overdue === null) return null;
        const x = xAt(i, n) - bw / 2;
        const y = yAt(d.overdue, countMax);
        const rateLabel = d.dueTotal ? `${Math.round((d.overdue / d.dueTotal) * 1000) / 10}%` : '暂无可比计划';
        return (
          <rect key={d.date} x={x} y={y} width={bw} height={BASE - y} fill={C_BAD} opacity={0.75}>
            <title>{`${d.date} · 逾期 ${d.overdue}/${d.dueTotal ?? '—'}（${rateLabel}）`}</title>
          </rect>
        );
      })}
      {lineSegments(rates, 1).map((p, i) => (
        <path key={`r${i}`} /* NOSONAR - 折线段按缺失日切分，位置即身份，无稳定业务 id */ d={p} fill="none" stroke={C_TODO} strokeWidth={2} />
      ))}
      {rates.map((v, i) => (v === null || days[i].missing ? null : (
        <circle key={days[i].date} cx={xAt(i, n)} cy={yAt(v, 1)} r={2.2} fill={C_TODO}>
          <title>{`${days[i].date} · 逾期率 ${Math.round(v * 1000) / 10}%（${days[i].overdue}/${days[i].dueTotal}）`}</title>
        </circle>
      )))}
      <text x={L} y={10} fontSize={9} fill="var(--text)">逾期趋势（柱=数量，线=逾期率）</text>
      {!hasRate && <text x={R} y={TOP + 22} textAnchor="end" fontSize={8} fill="#64748b">暂无可比计划</text>}
    </SvgShell>
  );
}

/** ④ 吞吐：当日完成柱 + 当日新增线 */
export function ThroughputChart({ days, svgRef }: { readonly days: readonly InsightDay[]; readonly svgRef?: (el: SVGSVGElement | null) => void }): ReactElement {
  const present = days.filter((d) => !d.missing);
  if (present.length === 0) return <Empty text="吞吐：暂无可回溯的统计日（日快照尚未积累）。" />;
  const max = niceMax([...days.map((d) => d.completed), ...days.map((d) => d.created)]);
  const n = days.length;
  const bw = n <= 1 ? 16 : Math.max(2, Math.min(14, ((R - L) / (n - 1)) * 0.55));
  return (
    <SvgShell days={days} label={`吞吐：${present.length} 个统计日，最新完成 ${days[n - 1].completed ?? '缺失'}`} svgRef={svgRef} testId="throughput">
      <Axes days={days} max={max} format={(v) => String(Math.round(v))} />
      <GapBands days={days} />
      {days.map((d, i) => {
        if (d.missing || d.completed === null) return null;
        const x = xAt(i, n) - bw / 2;
        const y = yAt(d.completed, max);
        return (
          <rect key={d.date} x={x} y={y} width={bw} height={BASE - y} fill={C_DONE} opacity={0.8}>
            <title>{`${d.date} · 完成 ${d.completed} · 新增 ${d.created ?? '—'}`}</title>
          </rect>
        );
      })}
      {lineSegments(days.map((d) => d.created), max).map((p, i) => (
        <path key={`c${i}`} /* NOSONAR - 折线段按缺失日切分，位置即身份，无稳定业务 id */ d={p} fill="none" stroke={C_CREATED} strokeWidth={1.8} strokeDasharray="4 3" />
      ))}
      <text x={L} y={10} fontSize={9} fill="var(--text)">吞吐（柱=完成，虚线=新增）</text>
    </SvgShell>
  );
}

/**
 * SVG → PNG 导出（PM-205⑤）。主题色都是 CSS 变量，序列化后的独立 SVG 文档拿不到页面样式，
 * 故把用到的变量值快照到克隆根节点；2x 缩放 + 底色填充，保证图表在深/浅环境下都能看清。
 */
export async function exportSvgAsPng(svg: SVGSVGElement, filename: string): Promise<void> {
  const vb = svg.viewBox.baseVal;
  const ratio = vb.height > 0 ? vb.height / vb.width : H / W;
  const width = 1040;
  const height = Math.round(width * ratio);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  const rootCss = getComputedStyle(document.documentElement);
  const vars = ['--card-bg', '--text', '--text-muted', '--border', '--border-strong', '--accent', '--danger', '--success'];
  const bg = rootCss.getPropertyValue('--card-bg').trim() || '#ffffff';
  clone.setAttribute('style', vars.map((v) => `${v}:${rootCss.getPropertyValue(v).trim()};`).join('') + `background:${bg};`);
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图表导出失败：SVG 渲染错误'));
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图表导出失败：无法创建画布');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('图表导出失败：PNG 编码失败');
    const link = document.createElement('a');
    const pngUrl = URL.createObjectURL(blob);
    link.href = pngUrl;
    link.download = filename.endsWith('.png') ? filename : `${filename}.png`;
    link.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
