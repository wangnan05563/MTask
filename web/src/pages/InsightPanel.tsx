/**
 * 项目洞察面板（T03236 / PRD PM-205）：累计流、周期时间、逾期趋势、吞吐四图。
 *
 * 取数单源在 `GET /metrics/day-snapshots`（T03237 日快照）：面板只选时间范围、不改口径；
 * 缺失日以服务端 `missing=true` 为准，图上断线 + 空档色带 + 「数据积累中」，**不插值不补零**（PM-205⑧）。
 * 逾期率的分子/分母与 G-4 一致（分母 0 当天服务端给 null，这里显示「暂无可比计划」），前端不重算。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BTN_SECONDARY_MD, FIELD_SM } from '../ui/primitives'; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
import type { ReactElement } from 'react';
import { Download, LineChart, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { CfdChart, CycleChart, OverdueTrendChart, ThroughputChart, exportSvgAsPng } from '../components/insightCharts';
import type { InsightDay } from '../components/insightCharts';

interface SnapshotRangeReport {
  projectId: string;
  projectName: string;
  tz: string;
  today: string;
  from: string;
  to: string;
  traceableFrom: string | null;
  lastSnapshot: string | null;
  days: InsightDay[];
  missingDates: string[];
  cycle: { sampleCount: number; p50Hours: number | null; p90Hours: number | null };
  note: string;
}

interface InsightSummary {
  projectId: string;
  projectName: string;
  tz: string;
  today: string;
  from: string;
  to: string;
  sampleSize: number;
  traceableFrom: string | null;
  lastSnapshot: string | null;
  overdue: { at: string | null; count: number | null; valid: number | null; rate: number | null; label: string };
  throughput: { completed: number; perWeek: number | null };
  aiUsage: { calls: number; cards: number; scope: 'global' };
  notes: string[];
}

const BTN = BTN_SECONDARY_MD; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
const FIELD = FIELD_SM; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
const CARD = { border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 } as const;

const PRESETS = [7, 30, 90] as const;
/** 导出文件名里的图名（四图同名会互相覆盖下载文件） */
const CHART_TITLE: Record<string, string> = { cfd: '累计流', cycle: '周期时间', overdue: '逾期趋势', throughput: '吞吐' };

/** 本地时区的 YMD（不用 toISOString：UTC 换算会在午夜前后差一天） */
const ymdLocal = (d: Date = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const shiftYmd = (ymd: string, delta: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  return ymdLocal(new Date(y, m - 1, d + delta));
};

const fmtHours = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 10) / 10} 小时`);

function ChartCard({ title, hint, testId, busy, onExport, children }: {
  readonly title: string;
  readonly hint: string;
  readonly testId: string;
  readonly busy: boolean;
  readonly onExport: () => void;
  readonly children: React.ReactNode;
}): ReactElement {
  return (
    <div style={CARD} data-t03236={`card-${testId}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 'var(--fs-s)' }}>{title}</strong>
        <span style={{ flex: 1 }} />
        <button onClick={onExport} disabled={busy} className="tbtn-anim"
          style={{ ...BTN, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
          data-t03236={`export-${testId}`} title={`导出「${title}」为 PNG`} aria-label={`导出${title}PNG`}>
          <Download size={12} />{busy ? '导出中…' : '导出 PNG'}
        </button>
      </div>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{hint}</span>
      {children}
    </div>
  );
}

export function InsightPanel({ projectId, onClose }: {
  readonly projectId: string;
  readonly onClose: () => void;
}): ReactElement {
  const today = ymdLocal();
  const [preset, setPreset] = useState<number>(30);
  const [from, setFrom] = useState(() => shiftYmd(today, -29));
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<SnapshotRangeReport | null>(null);
  const [summary, setSummary] = useState<InsightSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [summaryErr, setSummaryErr] = useState('');
  const [msg, setMsg] = useState('');
  const [exporting, setExporting] = useState('');

  const cfdRef = useRef<SVGSVGElement | null>(null);
  const cycleRef = useRef<SVGSVGElement | null>(null);
  const overdueRef = useRef<SVGSVGElement | null>(null);
  const throughputRef = useRef<SVGSVGElement | null>(null);
  const setCfd = useCallback((el: SVGSVGElement | null) => { cfdRef.current = el; }, []);
  const setCycle = useCallback((el: SVGSVGElement | null) => { cycleRef.current = el; }, []);
  const setOverdue = useCallback((el: SVGSVGElement | null) => { overdueRef.current = el; }, []);
  const setThroughput = useCallback((el: SVGSVGElement | null) => { throughputRef.current = el; }, []);

  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((m: string) => {
    setMsg(m);
    if (msgTimer.current) globalThis.clearTimeout(msgTimer.current);
    msgTimer.current = globalThis.setTimeout(() => { setMsg(''); msgTimer.current = null; }, 4000);
  }, []);
  useEffect(() => () => { if (msgTimer.current) globalThis.clearTimeout(msgTimer.current); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = `projectId=${encodeURIComponent(projectId)}&from=${from}&to=${to}`;
    // 摘要与四图并行取数：任一侧失败只影响自己（摘要失败不得清空图表，反之亦然）
    const [rangeRes, summaryRes] = await Promise.allSettled([
      api.get<SnapshotRangeReport>(`/metrics/day-snapshots?${qs}`),
      api.get<InsightSummary>(`/projects/${encodeURIComponent(projectId)}/insights?from=${from}&to=${to}`),
    ]);
    if (rangeRes.status === 'fulfilled') {
      setReport(rangeRes.value);
      setErr('');
    } else {
      setReport(null);
      setErr(rangeRes.reason instanceof Error ? rangeRes.reason.message : String(rangeRes.reason));
    }
    if (summaryRes.status === 'fulfilled') {
      setSummary(summaryRes.value);
      setSummaryErr('');
    } else {
      setSummary(null);
      setSummaryErr(summaryRes.reason instanceof Error ? summaryRes.reason.message : String(summaryRes.reason));
    }
    setLoading(false);
  }, [projectId, from, to]);
  useEffect(() => { void load(); }, [load]);

  const pickPreset = (days: number) => {
    const t = ymdLocal();
    setPreset(days);
    setFrom(shiftYmd(t, -(days - 1)));
    setTo(t);
  };

  const doExport = async (key: string, svg: SVGSVGElement | null) => {
    if (!svg) { flash('图表尚未渲染，暂无内容可导出'); return; }
    setExporting(key);
    try {
      await exportSvgAsPng(svg, `项目洞察-${CHART_TITLE[key] ?? key}-${report?.projectName ?? projectId}-${from}_${to}.png`);
      flash('已导出 PNG');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting('');
    }
  };

  const missing = report?.missingDates ?? [];
  const dataDays = report ? report.days.filter((d) => !d.missing).length : 0;
  const cycle = report?.cycle ?? null;

  return (
    <div data-t03236="panel" style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-m)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <LineChart size={14} style={{ color: 'var(--accent)' }} /> 项目洞察
        </span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>CFD / 周期时间 / 逾期趋势 / 吞吐 · 按项目与时间范围（PM-205）</span>
        <span style={{ flex: 1 }} />
        {PRESETS.map((d) => (
          <button key={d} onClick={() => pickPreset(d)} className="tbtn-anim" data-t03236={`range-${d}`}
            aria-pressed={preset === d} title={`最近 ${d} 天`}
            style={{ ...BTN, background: preset === d ? 'var(--accent)' : 'transparent', color: preset === d ? 'var(--accent-text)' : 'var(--text)', borderColor: preset === d ? 'var(--accent)' : 'var(--border-strong)' }}>
            近 {d} 天
          </button>
        ))}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          起始
          <input type="date" value={from} max={to} data-t03236="from" style={FIELD}
            onChange={(e) => { setPreset(0); setFrom(e.target.value); }} aria-label="统计起始日期" />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          截止
          <input type="date" value={to} min={from} data-t03236="to" style={FIELD}
            onChange={(e) => { setPreset(0); setTo(e.target.value); }} aria-label="统计截止日期" />
        </label>
        <button onClick={() => void load()} className="tbtn-anim" style={BTN} title="重新取数" aria-label="刷新洞察数据" data-t03236="refresh">
          <RefreshCw size={12} />
        </button>
        <button onClick={onClose} style={{ ...BTN, color: 'var(--text-muted)' }} title="关闭洞察面板" aria-label="关闭洞察面板">×</button>
      </div>

      {msg && <div role="status" data-t03236="toast" style={{ marginTop: 8, fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{msg}</div>}
      {err && (
        <div role="alert" data-t03236="error" style={{ marginTop: 8, fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>洞察取数失败：{err}</div>
      )}

      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        <span data-t03236="traceable">可回溯起点：{report?.traceableFrom ?? '尚无快照（数据积累中）'}</span>
        <span data-t03236="coverage">统计日：{dataDays} / {report?.days.length ?? 0}（{from} ~ {to}）</span>
        <span data-t03236="tz">时区：{report?.tz ?? '—'}</span>
        <span data-t03236="cycle-headline">
          周期：P50 {fmtHours(cycle?.p50Hours ?? null)} · P90 {fmtHours(cycle?.p90Hours ?? null)}
          {cycle ? `（样本 ${cycle.sampleCount}）` : ''}
        </span>
      </div>

      {summaryErr && (
        <div role="alert" data-t03261="summary-error" style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
          洞察摘要取数失败：{summaryErr}（四图仍按日快照展示）
        </div>
      )}
      {summary && (
        <div data-t03261="summary" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 'var(--fs-xs)', color: 'var(--text)' }}>
          <span data-t03261="sample">样本日：{summary.sampleSize} 天</span>
          <span data-t03261="overdue">
            逾期：{summary.overdue.valid === null ? '—' : `${summary.overdue.count ?? 0} / ${summary.overdue.valid}`}
            {' · '}{summary.overdue.label}
            {summary.overdue.at ? `（${summary.overdue.at}）` : ''}
          </span>
          <span data-t03261="throughput">周吞吐：{summary.throughput.perWeek ?? '—'}</span>
          <span data-t03261="ai-usage" title="ai_usage 无项目字段，只能给全局口径">
            AI 用量（全局）：调用 {summary.aiUsage.calls} · 卡片 {summary.aiUsage.cards}
          </span>
        </div>
      )}
      {summary && summary.notes.length > 0 && (
        <ul data-t03261="notes" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 'var(--fs-2xs, var(--fs-xs))', color: 'var(--text-muted)' }}>
          {summary.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}

      {missing.length > 0 && (
        <div data-t03236="missing" style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--warn, var(--text-muted))' }}>
          有 {missing.length} 天没有快照：{missing.slice(0, 8).join('、')}{missing.length > 8 ? ` 等` : ''}——图上以空档呈现（不插值、不补零），即「数据积累中」。
        </div>
      )}
      {report?.note && <div style={{ marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{report.note}</div>}

      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, opacity: loading ? 0.55 : 1 }}>
        <ChartCard title="累计流（CFD）" testId="cfd" busy={exporting === 'cfd'}
          hint="下带=已完成累计，上带=待办累计；逐日快照，空档不插值" onExport={() => void doExport('cfd', cfdRef.current)}>
          <CfdChart days={report?.days ?? []} svgRef={setCfd} />
        </ChartCard>
        <ChartCard title="周期时间" testId="cycle" busy={exporting === 'cycle'}
          hint="按完成日的 P50/P90（小时）；跨日样本在服务端合并取分位" onExport={() => void doExport('cycle', cycleRef.current)}>
          <CycleChart days={report?.days ?? []} svgRef={setCycle} />
        </ChartCard>
        <ChartCard title="逾期趋势" testId="overdue" busy={exporting === 'overdue'}
          hint="柱=逾期数量，线=逾期率（与 G-4 同口径；分母 0 当天不给率）" onExport={() => void doExport('overdue', overdueRef.current)}>
          <OverdueTrendChart days={report?.days ?? []} svgRef={setOverdue} />
        </ChartCard>
        <ChartCard title="吞吐" testId="throughput" busy={exporting === 'throughput'}
          hint="柱=当日完成，虚线=当日新增；缺失日同样断线" onExport={() => void doExport('throughput', throughputRef.current)}>
          <ThroughputChart days={report?.days ?? []} svgRef={setThroughput} />
        </ChartCard>
      </div>
      {loading && <div data-t03236="loading" style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>取数中…</div>}
    </div>
  );
}
