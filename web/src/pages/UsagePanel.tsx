import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { relTime } from '../ui/format';

/** AI 用量统计面板（T00448 / PRD AI-1）：近 N 天调用概览 + 按工具分组 + 最近明细。 */

interface UsageSummaryRow { day: string; calls: number; okCalls: number; failCalls: number; avgMs: number; contentChars: number }
interface UsageToolRow { tool_name: string; model: string; kind: string; calls: number; okCalls: number; failCalls: number; avgMs: number; contentChars: number }
interface UsageRecent { tool_name: string; model: string; kind: string; ok: number; duration_ms: number; content_chars: number; error: string | null; created_at: string }

const KIND_LABELS: Record<string, string> = {
  optimize: '提示词优化', beautify: '标题美化', ask: '通用对话', stream: '流式生成',
  organize: '任务梳理', classify: '智能分类', send: '队列发送', wbs: 'WBS 拆分',
  'parse-doc': '文档解析', report: '周报生成',
  // T00796：验证失败反馈等正文的 AI 美化（与 beautify 的「标题美化」区分）
  polish: '正文美化',
};

const KIND_COLOR: Record<string, string> = {
  optimize: 'var(--accent)', beautify: 'var(--accent)', ask: 'var(--text)', stream: 'var(--accent)',
  organize: 'var(--text)', classify: 'var(--text)', send: 'var(--text)', wbs: 'var(--accent)',
  'parse-doc': 'var(--accent)', report: 'var(--accent)', polish: 'var(--accent)',
};

const cellStyle: React.CSSProperties = { padding: '5px 8px', borderBottom: '1px solid var(--surface-2)', fontSize: 12 };
const thStyle: React.CSSProperties = { padding: '5px 8px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'left', borderBottom: '1px solid var(--border-strong)' };

export function UsagePanel() {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<UsageSummaryRow[]>([]);
  const [byTool, setByTool] = useState<UsageToolRow[]>([]);
  const [recent, setRecent] = useState<UsageRecent[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ summary: UsageSummaryRow[]; byTool: UsageToolRow[]; recent: UsageRecent[] }>(`/ai/usage?days=${days}`);
      setSummary(r.summary); setByTool(r.byTool); setRecent(r.recent);
    } catch { /* 后端不可用静默 */ } finally { setLoading(false); }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const totalCalls = summary.reduce((a, s) => a + s.calls, 0);
  const totalFail = summary.reduce((a, s) => a + s.failCalls, 0);
  const totalChars = summary.reduce((a, s) => a + s.contentChars, 0);
  const avgMsAll = totalCalls > 0 ? Math.round(summary.reduce((a, s) => a + s.avgMs * s.calls, 0) / totalCalls) : 0;

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>AI 用量统计</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="统计周期"
          style={{ padding: '4px 6px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12 }}>
          <option value={7}>近 7 天</option>
          <option value={14}>近 14 天</option>
          <option value={30}>近 30 天</option>
          <option value={90}>近 90 天</option>
        </select>
        <button onClick={() => void load()} disabled={loading} title="刷新用量统计"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>
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
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: c.label === '失败' && Number(c.value) > 0 ? 'var(--danger)' : 'var(--text)' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* 按天趋势 */}
      {summary.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>按天</div>
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
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>按工具与调用类型</div>
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

      {/* 最近调用明细 */}
      {recent.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>最近调用（{recent.length}）</div>
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
      {summary.length === 0 && !loading && <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>所选周期内暂无 AI 调用记录。</p>}
    </div>
  );
}
