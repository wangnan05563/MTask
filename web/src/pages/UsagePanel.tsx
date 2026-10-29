import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { relTime } from '../ui/format';

/** AI 用量统计面板（T00448 / PRD AI-1）：近 N 天调用概览 + 按工具分组 + 最近明细。 */

interface UsageSummaryRow { day: string; calls: number; okCalls: number; failCalls: number; avgMs: number; contentChars: number }
interface UsageToolRow { tool_name: string; model: string; kind: string; calls: number; okCalls: number; failCalls: number; avgMs: number; contentChars: number }
interface UsageRecent { tool_name: string; model: string; kind: string; ok: number; duration_ms: number; content_chars: number; error: string | null; created_at: string }
/** T03296（G-2）：卡片覆盖率——与服务端 AiCardStats.cardCoverage 同构 */
interface CoverageCard { key: string; title: string; group: string; available: boolean; metered: boolean; okCount: number; failCount: number }
interface CoverageBaseline { instrumentedFrom: string | null; firstCompleteMonth: string | null; established: boolean; note: string }
interface Coverage { month: string; totalAvailable: number; coveredCount: number; ratio: number; unmeteredKeys: string[]; cards: CoverageCard[]; baseline: CoverageBaseline }

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

export function UsagePanel() {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<UsageSummaryRow[]>([]);
  const [byTool, setByTool] = useState<UsageToolRow[]>([]);
  const [recent, setRecent] = useState<UsageRecent[]>([]);
  // T02308：取数口径随窗口与采样参数回传，面板标题如实标注，消除「汇总近 N 天 + 明细不受 N 天约束」两口径同屏
  const [recentMeta, setRecentMeta] = useState<{ days: number; perTool: number }>({ days: 7, perTool: 5 });
  const [loading, setLoading] = useState(false);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [coverageError, setCoverageError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ summary: UsageSummaryRow[]; byTool: UsageToolRow[]; recent: UsageRecent[]; days: number; perTool: number }>(`/ai/usage?days=${days}`);
      setSummary(r.summary); setByTool(r.byTool); setRecent(r.recent);
      setRecentMeta({ days: r.days ?? days, perTool: r.perTool ?? 5 });
    } catch { /* 后端不可用静默 */ } finally { setLoading(false); }
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

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 'var(--fs-xl)', margin: 0 }}>AI 用量统计</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="统计周期"
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

      {/* 概览卡 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        {[
          { label: '总调用', value: totalCalls },
          { label: '成功', value: totalCalls - totalFail },
          { label: '失败', value: totalFail },
          { label: '平均耗时', value: `${(avgMsAll / 1000).toFixed(1)}s` },
          { label: '输出字符', value: totalChars.toLocaleString() },
        ].map((c): React.ReactElement => (
          <div key={c.label} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', minWidth: 96 }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{c.label}</div>
            <div style={{ fontSize: 'var(--fs-title)', fontWeight: 600, color: c.label === '失败' && Number(c.value) > 0 ? 'var(--danger)' : 'var(--text)' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* 按天趋势 */}
      {summary.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>按天</div>
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
      )}

      {/* 按工具/类型分组 */}
      {byTool.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>按工具与调用类型</div>
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
      )}

      {/* T03296（G-2）：可用卡片覆盖情况——分母=注册表可用卡，分子=当月 ok=1 去重的卡 */}
      <div data-t03296="coverage" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>
          可用卡片覆盖（{coverage?.month ?? '本月'}{coverage ? `，${coverage.coveredCount}/${coverage.totalAvailable} 张有成功生成` : ''}
          {coverage ? `，覆盖率 ${(coverage.ratio * 100).toFixed(0)}%` : ''}）
        </div>
        {coverageError && <p style={{ color: 'var(--danger)', fontSize: 'var(--fs-s)', margin: 0 }}>覆盖率取数失败：{coverageError}</p>}
        {!coverage && !coverageError && <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-s)', margin: 0 }}>加载中…</p>}
        {coverage && (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', margin: '0 0 6px' }} data-t03296="baseline">{coverage.baseline.note}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6, fontSize: 'var(--fs-xs)' }}>
              <span data-t03296="legend" style={{ color: 'var(--success)' }}>已采用 = 当月有成功生成</span>
              <span data-t03296="legend" style={{ color: 'var(--warn)' }}>没人用 = 埋点已接、当月零调用</span>
              <span data-t03296="legend" style={{ color: 'var(--danger)' }}>没接埋点 = 写入点尚未写 card_key（{coverage.unmeteredKeys.length} 张）</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['卡片', '分组', '状态', '成功', '失败'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {coverage.cards.filter((c) => c.available).map((c) => {
                  const state = !c.metered ? '没接埋点' : c.okCount > 0 ? '已采用' : '没人用';
                  const color = !c.metered ? 'var(--danger)' : c.okCount > 0 ? 'var(--success)' : 'var(--warn)';
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
          </>
        )}
      </div>

      {/* 最近调用明细 */}
      {recent.length > 0 && (
        <div>
          <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 4 }}>最近调用（近 {recentMeta.days} 天，每厂商≤{recentMeta.perTool} 条，{recent.length}）</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['时间', '工具', '类型', '状态', '耗时', '输出', '错误'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={`${r.created_at}|${r.tool_name}|${r.kind}|${r.duration_ms}|${r.content_chars}`}>
                  <td style={{ ...cellStyle, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{relTime(r.created_at)}</td>
                  <td style={cellStyle}>{r.tool_name}</td>
                  <td style={{ ...cellStyle, color: KIND_COLOR[r.kind] ?? 'var(--text)' }}>{KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td style={{ ...cellStyle, color: r.ok ? 'var(--success)' : 'var(--danger)' }}>{r.ok ? '成功' : '失败'}</td>
                  <td style={cellStyle}>{(r.duration_ms / 1000).toFixed(1)}s</td>
                  <td style={cellStyle}>{r.content_chars.toLocaleString()}</td>
                  <td style={{ ...cellStyle, color: 'var(--danger)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {summary.length === 0 && !loading && <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>所选周期内暂无 AI 调用记录。</p>}
    </div>
  );
}
