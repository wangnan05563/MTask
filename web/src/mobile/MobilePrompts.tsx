/**
 * 移动端：提示词（取用 / 复制，§5.3）。分类 → 提示词列表；点击复制全文，Toast「已复制」，便于粘贴到他处。
 */
import { useEffect, useState } from 'react';
import { api, type Prompt, type PromptCategory } from '../api/client';
import { Copy, ChevronDown, ChevronUp } from 'lucide-react';

interface Props { readonly notify: (msg: string) => void; }

export function MobilePrompts({ notify }: Props) {
  const [categories, setCategories] = useState<PromptCategory[]>([]);
  const [activeCat, setActiveCat] = useState('');
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const cats = await api.get<PromptCategory[]>('/prompt-categories');
        setCategories(cats);
        setActiveCat(cats[0]?.id ?? '');
      } catch (e) { notify(e instanceof Error ? e.message : String(e)); }
    })();
  }, [notify]);

  useEffect(() => {
    if (!activeCat) { setPrompts([]); return; }
    void api.get<Prompt[]>(`/prompts?categoryId=${activeCat}`).then(setPrompts).catch((e) => notify(e instanceof Error ? e.message : String(e)));
  }, [activeCat, notify]);

  async function copy(p: Prompt) {
    // 剪贴板 API 仅在安全上下文（HTTPS / localhost）可用；不可用时直接提示失败，
    // 不回退已弃用的 document.execCommand('copy')（S1874），移动端非安全上下文剪贴板本就受限
    try { await navigator.clipboard.writeText(p.content); notify('已复制'); }
    catch { notify('复制失败'); }
  }

  return (
    <div style={page}>
      <header style={hdr}>提示词</header>
      <div style={{ padding: '10px 12px 0' }}>
        <select value={activeCat} onChange={(e) => setActiveCat(e.target.value)} style={sel}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div style={body}>
        {prompts.length === 0 && <div style={muted}>该分类下暂无提示词</div>}
        {prompts.map((p) => (
          <div key={p.id} style={card}>
            <button onClick={() => setExpanded((cur) => (cur === p.id ? null : p.id))} style={cardHead}>
              <span style={{ flex: 1, textAlign: 'left', fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
              <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{expanded === p.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
            </button>
            {expanded === p.id && (
              <div style={{ marginTop: 8 }}>
                <pre style={pre}>{p.content}</pre>
                <button onClick={() => void copy(p)} style={copyBtn}><Copy size={14} /> 复制全文</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--app-bg)', color: 'var(--text)' };
const hdr: React.CSSProperties = { fontSize: 16, fontWeight: 700, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--card-bg)' };
const sel: React.CSSProperties = { width: '100%', padding: 10, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 14, background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box' };
const body: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: 12 };
const card: React.CSSProperties = { padding: 12, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 10 };
const cardHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)' };
const pre: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, color: 'var(--text-secondary)', background: 'var(--surface)', borderRadius: 8, padding: 10, margin: 0, maxHeight: 280, overflowY: 'auto' };
const copyBtn: React.CSSProperties = { marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px', borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 14 };
const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 13, padding: 10 };
