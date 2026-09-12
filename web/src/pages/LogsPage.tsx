import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { Eraser, Pause, Play, RefreshCw, Search } from 'lucide-react';

/** 后台日志条目（对应后端 GET /logs 返回结构） */
interface LogEntry {
  seq: number;
  time: string;
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  source: string;
  message: string;
}

type LevelFilter = 'all' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/** 已知来源的显示名；未列出的来源直接以来源名显示（来源→标签的映射可按需补充） */
const SOURCE_LABELS: Record<string, string> = {
  server: '服务',
  ai: 'AI 使用',
  queue: '队列',
};

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  ERROR: 'var(--danger)',
  WARN: 'var(--warn)',
  INFO: 'var(--accent)',
  DEBUG: 'var(--text-muted)',
};

const POLL_OPTIONS: { ms: number; label: string }[] = [
  { ms: 1000, label: '1s' },
  { ms: 2000, label: '2s' },
  { ms: 3000, label: '3s' },
  { ms: 0, label: '停' },
];

/** 显示上限：超出的最旧日志被丢弃，控制内存与渲染量，防止大量日志卡顿 */
const MAX_DISPLAY = 1000;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-Hans-CN', { hour12: false });
}

/** 日志页面：轮询后端增量拉取 /logs，按级别着色、支持暂停/筛选/搜索，新日志自动滚动到底 */
export function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<LevelFilter>('all');
  const [source, setSource] = useState<string>('all');
  const [keyword, setKeyword] = useState('');
  const [pollMs, setPollMs] = useState(2000);

  // 增量游标：仅在非暂停时推进会重置到服务端最新 seq，避免游标错位
  const lastSeqRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const fetchLogs = async () => {
    try {
      const r = await api.get<{ latestSeq: number; items: LogEntry[] }>(`/logs?since=${lastSeqRef.current}`);
      if (r.items.length === 0) return;
      lastSeqRef.current = r.latestSeq;
      setLogs((prev) => {
        const next = [...prev, ...r.items];
        return next.length > MAX_DISPLAY ? next.slice(next.length - MAX_DISPLAY) : next;
      });
    } catch { /* 后端暂不可用时静默，下一轮重试 */ }
  };

  // 首次拉取全量 + 定时轮询；暂停仅停止自动滚动跟随，日志仍会追加（符合“暂停滚动”语义）
  useEffect(() => {
    void fetchLogs();
    if (pollMs === 0) return;
    const timer = setInterval(() => { void fetchLogs(); }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs]);

  // 新日志到来且此前贴底（或未暂停）时，自动滚动到底部
  useEffect(() => {
    if (paused) return;
    if (atBottomRef.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [logs, paused]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  };

  // 可见日志 = 级别筛选 ∩ 来源筛选 ∩ 关键词搜索（内存中过滤，不重新请求）
  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return logs.filter((e) => {
      if (level !== 'all' && e.level !== level) return false;
      if (source !== 'all' && e.source !== source) return false;
      return !kw || e.message.toLowerCase().includes(kw) || e.source.toLowerCase().includes(kw);
    });
  }, [logs, level, source, keyword]);

  // T00440：从当前日志数据动态聚合来源清单（新来源写入后自动出现在筛选下拉，无需改代码）
  const sourceOptions = useMemo(() => {
    const set = new Set<string>(['server', 'ai', 'queue']);
    for (const e of logs) if (e.source) set.add(e.source);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [logs]);

  const clear = () => { setLogs([]); lastSeqRef.current = 0; };

  const controlStyle: React.CSSProperties = {
    fontSize: 'var(--fs-m)',
    padding: '4px 8px',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    background: 'var(--card-bg)',
    color: 'var(--text)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  };

  return (
    <section>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
          <Search size={14} style={{ color: 'var(--text-muted)' }} /> 后台日志
        </span>
        <button onClick={() => setPaused((p) => !p)} style={controlStyle} title={paused ? '恢复 — 继续自动滚动到底部' : '暂停 — 停止自动滚动跟随'} aria-label={paused ? '恢复自动滚动' : '暂停自动滚动'}>
          {paused ? <Play size={13} /> : <Pause size={13} />}{paused ? '恢复' : '暂停'}
        </button>
        <select value={level} onChange={(e) => setLevel(e.target.value as LevelFilter)} title="级别筛选 — 按日志级别过滤显示" aria-label="级别筛选" style={controlStyle}>
          <option value="all">全部级别</option>
          <option value="ERROR">ERROR</option>
          <option value="WARN">WARN</option>
          <option value="INFO">INFO</option>
          <option value="DEBUG">DEBUG</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} title="来源筛选 — 按日志来源过滤显示（AI 使用/队列等便于排错）" aria-label="来源筛选" style={controlStyle}>
          <option value="all">全部来源</option>
          {sourceOptions.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s] ?? s}</option>)}
        </select>
        <select value={pollMs} onChange={(e) => setPollMs(Number(e.target.value))} title="刷新间隔 — 自动拉取新日志的间隔" aria-label="刷新间隔" style={controlStyle}>
          {POLL_OPTIONS.map((o) => <option key={o.ms} value={o.ms}>刷新 {o.label}</option>)}
        </select>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索日志内容…"
          style={{ padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12 }}
        />
        <button onClick={() => void fetchLogs()} style={controlStyle} title="刷新 — 立即拉取一次新日志" aria-label="立即刷新"><RefreshCw size={13} /></button>
        <button onClick={clear} style={{ ...controlStyle, color: 'var(--danger)' }} title="清空 — 清空当前日志显示与缓存" aria-label="清空日志"><Eraser size={13} /></button>
        <span style={{ fontSize: 'var(--fs-m)', color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {paused ? '已暂停滚动' : `· 共 ${logs.length} 条 · 显示 ${visible.length}`}
        </span>
      </div>

      <div
        ref={containerRef}
        onScroll={onScroll}
        style={{
          height: '62vh',
          overflowY: 'auto',
          background: 'var(--card-bg)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '8px 10px',
          fontFamily: 'Consolas, Menlo, monospace',
          fontSize: 'var(--fs-m)',
          lineHeight: 1.5,
        }}
      >
        {visible.length === 0 && <div style={{ color: 'var(--text-muted)' }}>暂无日志{logs.length ? '（当前筛选无匹配）' : '，等待后端输出…'}</div>}
        {visible.map((e) => (
          <div
            key={e.seq}
            style={{ display: 'flex', gap: 8, padding: '1px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{fmtTime(e.time)}</span>
            <span style={{ color: LEVEL_COLOR[e.level], fontWeight: 600, flexShrink: 0, width: 46 }}>{e.level}</span>
            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{e.source}</span>
            <span style={{ color: 'var(--text)' }}>{e.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}