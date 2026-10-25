import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from './dialogs'; // T01607：回滚二次确认改走项目对话框——Electron 下原生 confirm 不可靠（同 T01042 口径）

/**
 * T01072-FR1.9：回传结果 diff 视图与一键回滚。
 * - 数据源 task_result_history（TaskService.update 在 handle_result 被覆盖前留档，每任务保留 10 条）；
 * - 行级 diff：LCS 对齐，del=红底 −（旧版有新版无）、add=绿底 +（新版新增）；
 * - 回滚：当前结果先入历史（可再滚回来），handle_result 置为选中历史版本。
 */
interface HistoryEntry { id: string; prev_result: string; replaced_at: string }
type DiffRow = { t: 'same' | 'del' | 'add'; s: string };

function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ t: 'same', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: a[i] }); i++; }
    else { out.push({ t: 'add', s: b[j] }); j++; }
  }
  while (i < m) out.push({ t: 'del', s: a[i++] });
  while (j < n) out.push({ t: 'add', s: b[j++] });
  return out;
}

/** 回传结果历史 + diff 面板：lazy 拉取，无历史时不渲染由调用方控制 */
export function ResultDiffPanel({ taskNo, current, onRollback, indent = 32 }: {
  readonly taskNo: string;
  readonly current: string;
  /** 回滚成功后的回调；nextResult 为服务端回写后的正文，调用方据此就地刷新（省略则需自行重载） */
  readonly onRollback: (nextResult?: string) => void;
  /** 左缩进（px）：行内区块跟随列表缩进，抽屉等无缩进容器传 0 */
  readonly indent?: number;
}) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [diffWith, setDiffWith] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // 留档只在 handle_result 被覆盖时增长，故跟随 current 重拉即等价于「正文有变化」——
  // 抽屉保存、行内保存、MCP 外部回传、回滚四条路径都会带来自身列表的即时更新（T01607）。
  useEffect(() => {
    let alive = true;
    void api.get<HistoryEntry[]>(`/tasks/by-no/${taskNo}/result-history`)
      .then((d) => { if (alive) setHistory(Array.isArray(d) ? d : []); })
      .catch(() => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, [taskNo, current]);

  if (!history) return <div className="skel" style={{ height: 32, margin: `8px 0 0 ${indent}px` }} />;
  if (history.length === 0) return null; // 无历史（首次回传）不渲染

  async function rollback(entry: HistoryEntry) {
    if (busy) return;
    if (!(await askConfirm(`回滚到 ${entry.replaced_at.slice(0, 19).replace('T', ' ')} 的版本？\n当前结果会先存入历史（可再滚回来）。`))) return;
    setBusy(true);
    try {
      const res = await api.post<{ handle_result?: string | null }>(`/tasks/by-no/${taskNo}/result-rollback`, { historyId: entry.id });
      setMsg('已回滚');
      setDiffWith(null);
      onRollback(typeof res?.handle_result === 'string' ? res.handle_result : undefined);
    } catch (e) {
      setMsg(`回滚失败：${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  }

  const diffRows = diffWith ? lineDiff(diffWith.prev_result, current) : null;
  const delCount = diffRows?.filter((r) => r.t === 'del').length ?? 0;
  const addCount = diffRows?.filter((r) => r.t === 'add').length ?? 0;

  return (
    <div style={{ margin: `6px 0 0 ${indent}px`, border: '1px dashed var(--border-strong)', borderRadius: 8, padding: 8, background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>结果历史（{history.length}）</span>
        <select
          value={diffWith?.id ?? ''}
          onChange={(e) => setDiffWith(history.find((h) => h.id === e.target.value) ?? null)}
          aria-label="选择历史版本对比"
          style={{ fontSize: 'var(--fs-xs)', padding: '2px 6px', border: '1px solid var(--border-strong)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 220 }}
        >
          <option value="">对比上一版…</option>
          {history.map((h) => (
            <option key={h.id} value={h.id}>{h.replaced_at.slice(5, 16).replace('T', ' ')} 被覆盖前的版本</option>
          ))}
        </select>
        {diffWith && (
          <span style={{ fontSize: 'var(--fs-xs)' }}>
            <span style={{ color: 'var(--danger)' }}>−{delCount}</span> <span style={{ color: 'var(--success)' }}>＋{addCount}</span>
          </span>
        )}
        {diffWith && (
          <button onClick={() => void rollback(diffWith)} disabled={busy}
            title="回滚到该版本 — 当前结果会先存入历史（可再滚回来）"
            style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--accent)', borderRadius: 5, background: 'var(--card-bg)', color: 'var(--accent)', cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? '回滚中…' : '⟲ 回滚到该版本'}
          </button>
        )}
        {msg && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{msg}</span>}
      </div>
      {diffRows && (
        <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)' }}>
          {diffRows.map((r, i) => {
            let rowBg = 'transparent';
            let markerColor = 'transparent';
            let marker = '·';
            if (r.t === 'del') {
              rowBg = 'color-mix(in srgb, var(--danger) 12%, transparent)';
              markerColor = 'var(--danger)';
              marker = '−';
            } else if (r.t === 'add') {
              rowBg = 'color-mix(in srgb, var(--success) 12%, transparent)';
              markerColor = 'var(--success)';
              marker = '＋';
            }
            return (
              <div key={`${r.t}:${i}:${r.s ?? ''}`} style={{
                display: 'flex', gap: 6, padding: '1px 6px',
                background: rowBg,
                color: r.t === 'same' ? 'var(--text-muted)' : 'var(--text)',
              }}>
                <span style={{ flexShrink: 0, width: 10, color: markerColor }}>
                  {marker}
                </span>
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{r.s || ' '}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const FONT_MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, monospace';
