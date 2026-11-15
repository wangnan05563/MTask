import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { relTime } from '../ui/format';

/**
 * AI 用量统计面板（T00448 / PRD AI-1；T05780 改主题 Sheet 页签）。
 * 主题配置与渲染分离：USAGE_THEMES 只负责页签元数据，各主题的取数/表格由下方 render 分支承担。
 * 全局筛选（统计周期）留在页签外，切换主题时保留当前周期；数据只随周期/刷新重新拉取，页签切换走内存缓存。
 */

interface UsageSummaryRow { day: string; calls: number; okCalls: number; failCalls: number; avgMs: number; contentChars: number }
interface UsageToolRow { tool_name: string; model: string; kind: string; calls: number; okCalls: number; failCalls: number; avgMs: number; contentChars: number }
interface UsageRecent { tool_name: string; model: string; kind: string; ok: number; duration_ms: number; content_chars: number; error: string | null; created_at: string; stage?: string; job_id?: string }
/** T04085：按 job 展开的段明细——label 来自 ai_gen_segments（AiGenJournal 单源），无该段时为空串 */
interface UsageSegment { stage: string; label: string; calls: number; okCalls: number; failCalls: number; avgMs: number; totalMs: number; contentChars: number; lastError: string | null; lastAt: string }
interface UsageJob { jobId: string; cardKey: string | null; calls: number; okCalls: number; failCalls: number; avgMs: number; totalMs: number; contentChars: number; firstAt: string; lastAt: string; segments: UsageSegment[] }
interface UsageUnassigned { calls: number; okCalls: number; failCalls: number; contentChars: number; lastAt: string | null }
/** T03296（G-2）：卡片覆盖率——与服务端 AiCardStats.cardCoverage 同构 */
interface CoverageCard { key: string; title: string; group: string; available: boolean; metered: boolean; okCount: number; failCount: number }
interface CoverageBaseline { instrumentedFrom: string | null; firstCompleteMonth: string | null; established: boolean; note: string }
interface Coverage { month: string; totalAvailable: number; coveredCount: number; ratio: number; unmeteredKeys: string[]; cards: CoverageCard[]; baseline: CoverageBaseline }
interface UsagePayload { summary: UsageSummaryRow[]; byTool: UsageToolRow[]; recent: UsageRecent[]; jobs?: UsageJob[]; unassigned?: UsageUnassigned; jobLimit?: number; days: number; perTool: number }
interface ModelUsageRow { model: string; toolCount: number; calls: number; okCalls: number; failCalls: number; avgMs: number; contentChars: number }

type UsageThemeKey = 'overview' | 'model' | 'tool' | 'jobs' | 'coverage' | 'recent';
interface UsageThemeDef { key: UsageThemeKey; label: string }
const USAGE_THEMES: readonly UsageThemeDef[] = [
  { key: 'overview', label: '概览' },
  { key: 'model', label: '按模型' },
  { key: 'tool', label: '按工具与类型' },
  { key: 'jobs', label: '按 job / 段' },
  { key: 'coverage', label: '卡片覆盖' },
  { key: 'recent', label: '最近调用' },
];

const KIND_LABELS: Record<string, string> = {
  optimize: '提示词优化', beautify: '标题美化', ask: '通用对话', stream: '流式生成',
  organize: '任务梳理', classify: '智能分类', send: '队列发送', wbs: 'WBS 拆分',
  'parse-doc': '文档解析', report: '周报生成',
  // T00796：验证失败反馈等正文的 AI 美化（与 beautify 的「标题美化」区分）
  polish: '正文美化',
  // T02208：最小实调探测——真实调用通道的一次极小请求，会消耗额度，只有用户显式点击才会出现
  probe: '实调探测',
};

const KIND_COLOR: Record<string, string> = {
  optimize: 'var(--accent)', beautify: 'var(--accent)', ask: 'var(--text)', stream: 'var(--accent)',
  organize: 'var(--text)', classify: 'var(--text)', send: 'var(--text)', wbs: 'var(--accent)',
  'parse-doc': 'var(--accent)', report: 'var(--accent)', polish: 'var(--accent)',
  probe: 'var(--warn)',
};

const cellStyle: React.CSSProperties = { padding: '5px 8px', borderBottom: '1px solid var(--surface-2)', fontSize: 'var(--fs-s)' };
const thStyle: React.CSSProperties = { padding: '5px 8px', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textAlign: 'left', borderBottom: '1px solid var(--border-strong)' };
const emptyStyle: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 'var(--fs-s)', margin: '6px 0 10px' };

function UsageEmpty({ text }: { readonly text: string }) {
  return <p data-t05780="usage-empty" style={emptyStyle}>{text}</p>;
}

export function UsagePanel() {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<UsageSummaryRow[]>([]);
  const [byTool, setByTool] = useState<UsageToolRow[]>([]);
  const [recent, setRecent] = useState<UsageRecent[]>([]);
  // T04085：job/段维度（历史空归属行单独汇总，不进段统计）
  const [jobs, setJobs] = useState<UsageJob[]>([]);
  const [unassigned, setUnassigned] = useState<UsageUnassigned | null>(null);
  const [jobLimit, setJobLimit] = useState(30);
  // T02308：取数口径随窗口与采样参数回传，面板标题如实标注，消除「汇总近 N 天 + 明细不受 N 天约束」两口径同屏
  const [recentMeta, setRecentMeta] = useState<{ days: number; perTool: number }>({ days: 7, perTool: 5 });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [coverageError, setCoverageError] = useState('');
  // T05780：主题页签；默认第一个（概览），切换只换渲染分支，不重新请求
  const [activeTheme, setActiveTheme] = useState<UsageThemeKey>('overview');
  const contentRef = useRef<HTMLDivElement | null>(null);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<UsageThemeKey, HTMLButtonElement | null>>>({});
  const touchStartX = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const r = await api.get<UsagePayload>(`/ai/usage?days=${days}`);
      setSummary(r.summary); setByTool(r.byTool); setRecent(r.recent);
      setJobs(r.jobs ?? []); setUnassigned(r.unassigned ?? null); setJobLimit(r.jobLimit ?? 30);
      setRecentMeta({ days: r.days ?? days, perTool: r.perTool ?? 5 });
    } catch (e) {
      // T05780：不再静默——空面板无法区分「无用量」与「接口失败」
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
    // T03296（G-2）：覆盖率按月出数，与「近 N 天」窗口是两个口径，单独取、单独标注
    try {
      setCoverage(await api.get<Coverage>('/ai/coverage'));
      setCoverageError('');
    } catch (e) { setCoverageError(e instanceof Error ? e.message : String(e)); }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const totalCalls = summary.reduce((a, s) => a + s.calls, 0);
  const totalFail = summary.reduce((a, s) => a + s.failCalls, 0);
  const totalChars = summary.reduce((a, s) => a + s.contentChars, 0);
  const avgMsAll = totalCalls > 0 ? Math.round(summary.reduce((a, s) => a + s.avgMs * s.calls, 0) / totalCalls) : 0;

  // 「按模型」主题是 byTool 的聚合视图：调用数加权平均耗时，避免把多个工具的均值再简单平均。
  const byModel = useMemo<ModelUsageRow[]>(() => {
    const map = new Map<string, ModelUsageRow>();
    const toolSets = new Map<string, Set<string>>();
    for (const r of byTool) {
      const key = r.model || '未标注模型';
      const cur = map.get(key) ?? { model: key, toolCount: 0, calls: 0, okCalls: 0, failCalls: 0, avgMs: 0, contentChars: 0 };
      const tools = toolSets.get(key) ?? new Set<string>();
      tools.add(r.tool_name);
      toolSets.set(key, tools);
      cur.toolCount = tools.size;
      cur.calls += r.calls;
      cur.okCalls += r.okCalls;
      cur.failCalls += r.failCalls;
      cur.avgMs += r.avgMs * r.calls;
      cur.contentChars += r.contentChars;
      map.set(key, cur);
    }
    return [...map.values()].map((r) => ({ ...r, avgMs: r.calls > 0 ? Math.round(r.avgMs / r.calls) : 0 }))
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
  }, [byTool]);

  const coverageCards = coverage ? coverage.cards.filter((c) => c.available) : [];
  const themeBadges: Record<UsageThemeKey, string> = {
    overview: summary.length > 0 ? `${summary.length} 天` : '0',
    model: String(byModel.length),
    tool: String(byTool.length),
    jobs: String(jobs.length),
    coverage: coverage ? `${coverage.coveredCount}/${coverage.totalAvailable}` : '—',
    recent: String(recent.length),
  };

  const selectTheme = useCallback((key: UsageThemeKey) => {
    setActiveTheme(key);
    contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    tabRefs.current[key]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);
  // T05780：接口失败且没有任何可用数据时只显示错误与重试，避免把「取数失败」误读成「无用量」。
  const showLoadErrorOnly = loadError !== '' && summary.length === 0;

  const scrollTabs = (dir: -1 | 1) => {
    tabBarRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' });
  };

  const renderOverview = () => {
    if (summary.length === 0) return <UsageEmpty text="所选周期内暂无 AI 调用记录。" />;
    return (
      <>
        {/* 概览卡 */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {[
            { label: '总调用', value: totalCalls },
            { label: '成功', value: totalCalls - totalFail },
            { label: '失败', value: totalFail },
            { label: '平均耗时', value: `${(avgMsAll / 1000).toFixed(1)}s` },
            { label: '输出字符', value: totalChars.toLocaleString() },
          ].map((c): React.ReactElement => (
            <div key={c.label} data-t05780="overview-card" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', minWidth: 96 }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{c.label}</div>
              <div style={{ fontSize: 'var(--fs-title)', fontWeight: 600, color: c.label === '失败' && Number(c.value) > 0 ? 'var(--danger)' : 'var(--text)' }}>{c.value}</div>
            </div>
          ))}
        </div>
        {/* 按天趋势 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>按天</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['日期', '调用', '成功', '失败', '平均耗时', '输出字符'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.day}>
                    <td style={cellStyle}>{s.day}</td><td style={cellStyle}>{s.calls}</td>
                    <td style={{ ...cellStyle, color: 'var(--success)' }}>{s.okCalls}</td>
                    <td style={{ ...cellStyle, color: s.failCalls > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{s.failCalls}</td>
                    <td style={cellStyle}>{(s.avgMs / 1000).toFixed(1)}s</td><td style={cellStyle}>{s.contentChars.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  const renderModel = () => {
    if (byModel.length === 0) return <UsageEmpty text="所选周期内暂无按模型聚合的调用记录。" />;
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>按模型（由工具调用聚合，耗时按调用数加权）</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['模型', '工具数', '调用', '成功', '失败', '平均耗时', '输出字符'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
            <tbody>
              {byModel.map((r) => (
                <tr key={r.model} data-t05780="model-row">
                  <td style={cellStyle}>{r.model}</td>
                  <td style={cellStyle}>{r.toolCount}</td>
                  <td style={cellStyle}>{r.calls}</td>
                  <td style={{ ...cellStyle, color: 'var(--success)' }}>{r.okCalls}</td>
                  <td style={{ ...cellStyle, color: r.failCalls > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{r.failCalls}</td>
                  <td style={cellStyle}>{(r.avgMs / 1000).toFixed(1)}s</td>
                  <td style={cellStyle}>{r.contentChars.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderTool = () => {
    if (byTool.length === 0) return <UsageEmpty text="所选周期内暂无按工具/类型分组的调用记录。" />;
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>按工具与调用类型</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['工具', '模型', '类型', '调用', '成功', '失败', '平均耗时', '输出字符'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
            <tbody>
              {byTool.map((r) => (
                <tr key={`${r.tool_name}|${r.model}|${r.kind}`}>
                  <td style={cellStyle}>{r.tool_name}</td><td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{r.model || '—'}</td>
                  <td style={{ ...cellStyle, color: KIND_COLOR[r.kind] ?? 'var(--text)' }}>{KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td style={cellStyle}>{r.calls}</td><td style={cellStyle}>{r.okCalls}</td>
                  <td style={{ ...cellStyle, color: r.failCalls > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{r.failCalls}</td>
                  <td style={cellStyle}>{(r.avgMs / 1000).toFixed(1)}s</td><td style={cellStyle}>{r.contentChars.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderJobs = () => (
    <div data-t04085="jobs" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>
        按 job / 按段（近 {recentMeta.days} 天，最多 {jobLimit} 个 job）
      </div>
      {unassigned && unassigned.calls > 0 && (
        <p data-t04085="unassigned" style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-s)', margin: '0 0 6px' }}>
          无段归属（历史数据）：{unassigned.calls} 次调用、{unassigned.contentChars.toLocaleString()} 字符，未计入按段统计
          {unassigned.lastAt ? `（最近 ${relTime(unassigned.lastAt)}）` : ''}
        </p>
      )}
      {jobs.length === 0 ? (
        <UsageEmpty text="所选周期内暂无带 job/段归属的调用；段的展示名取自生成台账（无台账时回落段标识）。" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['job / 段', '调用', '成功', '失败', '平均耗时', '合计耗时', '输出字符', '最近错误'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
            <tbody>
              {jobs.map((j) => (
                <Fragment key={j.jobId}>
                  <tr data-t04085="job" data-job-id={j.jobId} style={{ background: 'var(--surface-2)' }}>
                    <td style={{ ...cellStyle, fontWeight: 600 }} title={j.jobId}>
                      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 'var(--fs-xs)' }}>{j.jobId.length > 14 ? `${j.jobId.slice(0, 14)}…` : j.jobId}</span>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>{j.cardKey ?? '—'}</span>
                    </td>
                    <td style={cellStyle}>{j.calls}</td>
                    <td style={{ ...cellStyle, color: 'var(--success)' }}>{j.okCalls}</td>
                    <td style={{ ...cellStyle, color: j.failCalls > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{j.failCalls}</td>
                    <td style={cellStyle}>{(j.avgMs / 1000).toFixed(1)}s</td>
                    <td style={cellStyle}>{(j.totalMs / 1000).toFixed(1)}s</td>
                    <td style={cellStyle}>{j.contentChars.toLocaleString()}</td>
                    <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>—</td>
                  </tr>
                  {j.segments.map((s) => (
                    <tr key={s.stage} data-t04085="segment" data-stage={s.stage}>
                      <td style={{ ...cellStyle, paddingLeft: 24 }} title={s.stage}>
                        <span data-t04085="stage-label">{s.label || s.stage}</span>
                        {s.label && s.label !== s.stage && <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 'var(--fs-xs)' }}>{s.stage}</span>}
                      </td>
                      <td style={cellStyle}>{s.calls}</td>
                      <td style={{ ...cellStyle, color: 'var(--success)' }}>{s.okCalls}</td>
                      <td style={{ ...cellStyle, color: s.failCalls > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{s.failCalls}</td>
                      <td style={cellStyle}>{(s.avgMs / 1000).toFixed(1)}s</td>
                      <td style={cellStyle}>{(s.totalMs / 1000).toFixed(1)}s</td>
                      <td style={cellStyle}>{s.contentChars.toLocaleString()}</td>
                      <td style={{ ...cellStyle, color: 'var(--danger)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.lastError ?? undefined}>{s.lastError || ''}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderCoverage = () => {
    if (coverageError) return <p style={{ color: 'var(--danger)', fontSize: 'var(--fs-s)', margin: 0 }}>覆盖率取数失败：{coverageError}</p>;
    if (!coverage) return <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-s)', margin: 0 }}>覆盖率加载中…</p>;
    if (coverageCards.length === 0) return <UsageEmpty text="本月暂无可用卡片。" />;
    return (
      <div data-t03296="coverage" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>
          可用卡片覆盖（{coverage.month}，{coverage.coveredCount}/{coverage.totalAvailable} 张有成功生成，覆盖率 {(coverage.ratio * 100).toFixed(0)}%）
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', margin: '0 0 6px' }} data-t03296="baseline">{coverage.baseline.note}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6, fontSize: 'var(--fs-xs)' }}>
          <span data-t03296="legend" style={{ color: 'var(--success)' }}>已采用 = 当月有成功生成</span>
          <span data-t03296="legend" style={{ color: 'var(--warn)' }}>没人用 = 埋点已接、当月零调用</span>
          <span data-t03296="legend" style={{ color: 'var(--danger)' }}>没接埋点 = 写入点尚未写 card_key（{coverage.unmeteredKeys.length} 张）</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['卡片', '分组', '状态', '成功', '失败'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
            <tbody>
              {coverageCards.map((c) => {
                let state: string;
                let color: string;
                if (c.metered) {
                  if (c.okCount > 0) { state = '已采用'; color = 'var(--success)'; }
                  else { state = '没人用'; color = 'var(--warn)'; }
                } else {
                  state = '没接埋点'; color = 'var(--danger)';
                }
                return (
                  <tr key={c.key} data-t03296="card">
                    <td style={cellStyle}>{c.title}<span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{c.key}</span></td>
                    <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{c.group}</td>
                    <td style={{ ...cellStyle, color }} data-t03296="state">{state}</td>
                    <td style={cellStyle}>{c.okCount}</td>
                    <td style={{ ...cellStyle, color: c.failCount > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{c.failCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderRecent = () => {
    if (recent.length === 0) return <UsageEmpty text={`近 ${recentMeta.days} 天暂无最近调用明细。`} />;
    return (
      <div>
        <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>最近调用（近 {recentMeta.days} 天，每厂商≤{recentMeta.perTool} 条，{recent.length}）</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['时间', '工具', '类型', '段', '状态', '耗时', '输出', '错误'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={`${r.created_at}|${r.tool_name}|${r.kind}|${r.duration_ms}|${r.content_chars}|${r.stage ?? ''}|${r.job_id ?? ''}`}>
                  <td style={{ ...cellStyle, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{relTime(r.created_at)}</td>
                  <td style={cellStyle}>{r.tool_name}</td>
                  <td style={{ ...cellStyle, color: KIND_COLOR[r.kind] ?? 'var(--text)' }}>{KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td style={{ ...cellStyle, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.job_id || undefined}>
                    {r.stage || <span data-t04085="recent-unassigned" style={{ color: 'var(--text-muted)' }}>无段归属（历史数据）</span>}
                  </td>
                  <td style={{ ...cellStyle, color: r.ok ? 'var(--success)' : 'var(--danger)' }}>{r.ok ? '成功' : '失败'}</td>
                  <td style={cellStyle}>{(r.duration_ms / 1000).toFixed(1)}s</td>
                  <td style={cellStyle}>{r.content_chars.toLocaleString()}</td>
                  <td style={{ ...cellStyle, color: 'var(--danger)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderTheme = (): React.ReactNode => {
    switch (activeTheme) {
      case 'model': return renderModel();
      case 'tool': return renderTool();
      case 'jobs': return renderJobs();
      case 'coverage': return renderCoverage();
      case 'recent': return renderRecent();
      default: return renderOverview();
    }
  };

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 'var(--fs-xl)', margin: 0 }}>AI 用量统计</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="统计周期"
          data-t05780="usage-days"
          style={{ padding: '4px 6px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
          <option value={7}>近 7 天</option>
          <option value={14}>近 14 天</option>
          <option value={30}>近 30 天</option>
          <option value={90}>近 90 天</option>
        </select>
        <button onClick={() => void load()} disabled={loading} title="刷新用量统计"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }}>
          <RefreshCw size={12} className={loading ? 'aispin' : undefined} />刷新
        </button>
      </div>

      {/* T05780：主题页签——横向滚动 + scroll-snap；点击切换只换内容分支，不重新请求 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid var(--border-strong)', marginBottom: 10 }}>
        <button type="button" onClick={() => scrollTabs(-1)} aria-label="向左滚动统计主题" title="向左滚动统计主题"
          style={{ display: 'inline-flex', padding: 3, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <ChevronLeft size={14} />
        </button>
        <div ref={tabBarRef} role="tablist" aria-label="AI 用量统计主题" data-t05780="usage-tabs"
          onWheel={(e) => {
            const el = e.currentTarget;
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
              el.scrollLeft += e.deltaY;
              e.preventDefault();
            }
          }}
          onTouchStart={(e) => { touchStartX.current = e.touches[0]?.clientX ?? null; }}
          onTouchEnd={(e) => {
            const start = touchStartX.current;
            touchStartX.current = null;
            const end = e.changedTouches[0]?.clientX;
            const bar = tabBarRef.current;
            if (start == null || end == null || !bar || Math.abs(end - start) < 40) return;
            // T05780：横向滑动结束吸附到离视口中心最近的页签并切换，避免滑完停在第二个页签的一半。
            const center = bar.scrollLeft + bar.clientWidth / 2;
            let best: UsageThemeKey | null = null;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const t of USAGE_THEMES) {
              const el = tabRefs.current[t.key];
              if (!el) continue;
              const tabCenter = el.offsetLeft + el.offsetWidth / 2;
              const distance = Math.abs(tabCenter - center);
              if (distance < bestDistance) { bestDistance = distance; best = t.key; }
            }
            if (best) selectTheme(best);
          }}
          style={{ display: 'flex', gap: 4, overflowX: 'auto', flex: 1, scrollSnapType: 'x proximity', whiteSpace: 'nowrap' }}>
          {USAGE_THEMES.map((t) => {
            const active = activeTheme === t.key;
            return (
              <button key={t.key} type="button" role="tab" aria-selected={active}
                tabIndex={active ? 0 : -1}
                ref={(el) => { tabRefs.current[t.key] = el; }}
                onClick={() => selectTheme(t.key)}
                data-t05780="usage-tab" data-theme={t.key}
                title={`${t.label} — 点击切换到该统计主题`}
                style={{ fontSize: 'var(--fs-l)', padding: '6px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
                  whiteSpace: 'nowrap', scrollSnapAlign: 'start',
                  fontWeight: active ? 700 : 400,
                  color: active ? 'var(--text)' : 'var(--text-muted)',
                  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent' }}>
                {t.label}
                <span aria-hidden="true" style={{ marginLeft: 6, fontSize: 'var(--fs-xs)', color: active ? 'var(--accent)' : 'var(--text-muted)' }}>{themeBadges[t.key]}</span>
              </button>
            );
          })}
        </div>
        <button type="button" onClick={() => scrollTabs(1)} aria-label="向右滚动统计主题" title="向右滚动统计主题"
          style={{ display: 'inline-flex', padding: 3, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <ChevronRight size={14} />
        </button>
      </div>

      {loadError && (
        <div data-t05780="load-error" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px', fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>
          <span>用量统计取数失败：{loadError}</span>
          <button type="button" onClick={() => void load()} style={{ padding: '2px 8px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>重试</button>
        </div>
      )}

      {showLoadErrorOnly ? null : loading && summary.length === 0 ? (
        <div data-t05780="usage-loading" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 'var(--fs-s)', padding: '10px 0' }}>
          <RefreshCw size={14} className="aispin" />正在加载 AI 用量统计…
        </div>
      ) : (
        <div ref={contentRef} data-t05780="usage-content" data-active-theme={activeTheme} style={{ overflowX: 'hidden' }}>
          {renderTheme()}
        </div>
      )}
    </div>
  );
}
