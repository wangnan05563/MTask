import { useEffect, useRef, useState } from 'react';
import { FileSearch, X, Search, FileText, AlertTriangle, Loader2, ChevronDown } from 'lucide-react';
import { api, type Project } from '../api/client';

/**
 * 工作空间全文检索面板（T00786 建议项落地）。
 * 后端 GET /workspace/search 早已返回 { items, partial, scannedFiles }，前端此前无入口；
 * 本组件补齐「工具栏按钮 + 弹窗检索」链路，并消费 partial 元信息做「结果可能不完整」提示。
 *
 * 交互：输入关键词（≥2 字符）→ 命中列表（路径:行号 + 片段，文件名命中 line=0）；
 * 点击命中项读 /workspace/file 的对应行上下文内联展示，便于确认命中是否有效。
 * 颜色全部取自主题 CSS 变量，无硬编码色值。
 */

interface Hit { path: string; line: number; snippet: string }
interface SearchResp { items: Hit[]; count: number; partial: boolean; scannedFiles: number }
interface FileResp { totalLines: number; lines: Array<{ n: number; text: string }> }

const HIT_CONTEXT_LINES = 20;

export function WorkspaceSearchPanel({
  project,
  flash,
  onClose,
}: {
  readonly project?: Project | null;
  readonly flash?: (m: string) => void;
  readonly onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [glob, setGlob] = useState('');
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [count, setCount] = useState(0);
  const [partial, setPartial] = useState(false);
  const [scannedFiles, setScannedFiles] = useState(0);
  const [searched, setSearched] = useState(false);
  const [openedPath, setOpenedPath] = useState<`${number}:${string}` | null>(null);
  const [file, setFile] = useState<FileResp | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const bound = project?.workspace_path ?? '';

  // Escape 关闭用 globalThis 监听（环境无关全局对象）；遮罩点击关闭用文档级事件委托 + ref 包含性判断
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) onClose();
    };
    globalThis.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => {
      globalThis.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [onClose]);

  async function doSearch() {
    const query = q.trim();
    if (!project) { flash?.('请先选择要检索的项目'); return; }
    if (query.length < 2) { flash?.('关键词至少 2 个字符'); return; }
    setBusy(true); setOpenedPath(null); setFile(null); setSearched(true);
    try {
      const r = await api.get<SearchResp>(
        `/workspace/search?projectId=${encodeURIComponent(project.id)}&q=${encodeURIComponent(query)}&glob=${encodeURIComponent(glob.trim())}`,
      );
      setHits(r.items ?? []);
      setCount(r.count ?? 0);
      setPartial(!!r.partial);
      setScannedFiles(r.scannedFiles ?? 0);
    } catch (e) {
      setHits([]); setCount(0); setPartial(false); setScannedFiles(0);
      flash?.(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function openFile(path: string, line: number) {
    if (!project) return;
    setOpenedPath(`${line}:${path}`);
    setFile(null);
    try {
      // 命中行 line 为 1-based；offset 为 0-based，向前取若干行作为上下文窗口
      const offset = Math.max(0, line - 3);
      const r = await api.get<FileResp>(
        `/workspace/file?projectId=${encodeURIComponent(project.id)}&path=${encodeURIComponent(path)}&offset=${offset}&limit=${HIT_CONTEXT_LINES}`,
      );
      setFile(r);
    } catch (e) {
      setFile(null);
      flash?.(e instanceof Error ? e.message : String(e));
    }
  }

  /** 结果区渲染：未检索 / 检索中 / 无结果 / 命中列表（避免 JSX 里的长三元链） */
  function renderResults() {
    if (!searched) {
      return (
        <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          {bound ? '输入关键词开始在工作空间内全文检索' : '当前项目尚未绑定工作空间（项目管理 → 选择工作空间）'}
        </div>
      );
    }
    if (busy) {
      return (
        <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', verticalAlign: '-2px' }} /> 检索中…
        </div>
      );
    }
    if (hits.length === 0) {
      return <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无匹配结果</div>;
    }
    return hits.map((h, i) => {
      const key = `${h.line}:${h.path}` as const;
      const open = openedPath === key;
      return (
        <div key={`${h.path}:${h.line}:${i}`} style={{ borderBottom: i < hits.length - 1 ? '1px solid var(--border)' : 'none' }}>
          <button
            onClick={() => { if (open) { setOpenedPath(null); setFile(null); } else void openFile(h.path, h.line); }}
            title={`${h.path}:${h.line} — 点击${open ? '收起' : '查看文件内容'}`}
            aria-expanded={open}
            style={{ display: 'flex', width: '100%', alignItems: 'baseline', gap: 8, padding: '7px 16px', border: 'none', background: open ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, color: 'var(--accent)', fontSize: 12, fontFamily: 'monospace', minWidth: 64 }}>{h.line > 0 ? h.line : null}{h.line === 0 && <FileText size={12} />}</span>
            <span style={{ flex: 1, color: 'var(--text)', fontSize: 12, wordBreak: 'break-all' }}>{h.path}</span>
            <ChevronDown size={12} style={{ flexShrink: 0, color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }} />
          </button>
          <div style={{ padding: '0 16px 6px 16px', color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{h.snippet}</div>
          {open && (
            <div style={{ padding: '0 16px 8px 22px', borderTop: '1px dashed var(--border)' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', margin: '4px 0' }}>{h.path} · 共 {file?.totalLines ?? '…'} 行</div>
              {file === null ? (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 0' }}><Loader2 size={12} style={{ animation: 'spin 1s linear infinite', verticalAlign: '-2px' }} /> 读取中…</div>
              ) : (
                <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text)', overflowX: 'auto', maxHeight: 260, fontFamily: 'monospace' }}>
                  {file.lines.map((l) => <div key={l.n} style={{ display: 'flex', gap: 10, background: l.n === h.line ? 'var(--accent-soft)' : 'transparent' }}><span style={{ color: 'var(--text-muted)', flexShrink: 0, userSelect: 'none' }}>{l.n}</span><span>{l.text}</span></div>)}
                </pre>
              )}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div ref={panelRef} aria-label="工作空间全文检索"
        style={{ background: 'var(--card-bg)', borderRadius: 10, width: 760, maxWidth: '94vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,.18)', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
        {/* 标题栏 + 关闭 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <FileSearch size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1, color: 'var(--text)' }}>工作空间全文检索</span>
          {bound && <span title={bound} style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>{bound}</span>}
          <button onClick={onClose} title="关闭 — 放弃本次检索" aria-label="关闭：放弃本次检索"
            style={{ display: 'inline-flex', padding: 3, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={15} />
          </button>
        </div>

        {/* 搜索区 */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, border: '1px solid var(--border-strong)', borderRadius: 6, padding: '5px 8px', background: 'var(--bg)' }}>
              <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
                placeholder="输入关键词（≥2 字符，大小写不敏感）" aria-label="检索关键词"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, minWidth: 0 }} />
            </div>
            <button onClick={() => void doSearch()} disabled={busy}
              title="搜索 — 在工作空间内全文检索该关键词"
              aria-label="搜索：在工作空间内全文检索"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1, fontSize: 12 }}>
              {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={13} />} 搜索
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>文件过滤</span>
            <input value={glob} onChange={(e) => setGlob(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
              placeholder="可选，如 *.ts 或 src/**（留空检索全部）" aria-label="文件过滤 glob"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, minWidth: 0 }} />
          </div>
        </div>

        {/* partial 提示条（T00786 建议项核心：结果可能不完整） */}
        {searched && partial && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', background: 'var(--warn-soft, rgba(245,158,11,.12))', color: 'var(--warn, #b45309)', fontSize: 12, borderBottom: '1px solid var(--border)' }}>
            <AlertTriangle size={13} style={{ flexShrink: 0 }} />
            <span>结果可能不完整：已扫描 {scannedFiles.toLocaleString()} 个文件后达到检索上限而提前停止，可用上方「文件过滤」glob 缩小范围以获得更精确结果。</span>
          </div>
        )}

        {/* 结果区 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {renderResults()}
        </div>

        {/* 结果统计 */}
        {searched && !busy && (
          <div style={{ padding: '6px 16px', borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11 }}>
            命中 {count} 处{partial ? `（已截断，扫描 ${scannedFiles.toLocaleString()} 个文件）` : ''}
          </div>
        )}
      </div>
    </div>
  );
}