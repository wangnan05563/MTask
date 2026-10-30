/**
 * 移动端：提示词（取用 / 复制，§5.3）。分类 → 提示词列表；点击复制全文，Toast「已复制」，便于粘贴到他处。
 */
import { EmptyState, pageStyle as page, bodyStyle as body, cardStyle as card } from './ui';
import { useEffect, useState } from 'react';
import { api, type Prompt, type PromptCategory } from '../api/client';
import { Copy, ChevronDown, ChevronUp, MessageSquare, Star } from 'lucide-react'; // T03655：空态改 lucide，不再用 emoji
import { FavoriteToggle } from '../ui/FavoriteToggle'; // T03683：与桌面端共用同一收藏组件（size 传大一号做触摸目标）

interface Props { readonly notify: (msg: string) => void; }

export function MobilePrompts({ notify }: Props) {
  const [categories, setCategories] = useState<PromptCategory[]>([]);
  const [activeCat, setActiveCat] = useState('');
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  // T03683：移动端同步提供「全部 / 收藏」两态筛选（票面要求移动端也生效）
  const [favOnly, setFavOnly] = useState(false);

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

  /** T03683：收藏切换——与桌面端同口径的乐观更新，失败回滚并 Toast */
  async function toggleFavorite(p: Prompt) {
    const next = !Boolean(p.is_favorited);
    const withFlag = (favorited: boolean) => prompts.map((x) => (x.id === p.id ? { ...x, is_favorited: favorited } : x));
    setPrompts(withFlag(next));
    try { await api.patch(`/prompts/${p.id}`, { isFavorited: next }); }
    catch (e) {
      setPrompts(withFlag(!next));
      notify(`收藏失败，已还原：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const shownPrompts = favOnly ? prompts.filter((p) => Boolean(p.is_favorited)) : prompts;

  return (
    <div style={page}>
      <header style={hdr}>提示词</header>
      <div style={{ padding: '10px 12px 0' }}>
        <select value={activeCat} onChange={(e) => setActiveCat(e.target.value)} style={sel}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {/* T03683：显示范围切换（全部显示 / 只看收藏） */}
        <button onClick={() => setFavOnly((v) => !v)} style={scopeBtn}
          title={favOnly ? '当前只看收藏，点击查看全部' : '当前看全部，点击只看收藏'}
          aria-label={favOnly ? '显示范围：当前只看收藏，点击切回全部显示' : '显示范围：当前全部显示，点击只看收藏'}
          aria-pressed={favOnly}>
          <Star size={14} fill={favOnly ? 'currentColor' : 'none'} /> {favOnly ? `收藏（${shownPrompts.length}）` : '全部显示'}
        </button>
      </div>
      <div style={body}>
        {shownPrompts.length === 0 && (
          <EmptyState icon={<MessageSquare size={32} />}
            message={favOnly && prompts.length > 0 ? '该分类下暂无收藏，点标题左侧星标加入收藏' : '该分类下暂无提示词'} />
        )}
        {shownPrompts.map((p) => (
          <div key={p.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {/* T03683：星标放在标题按钮的兄弟位（HTML 不允许 button 套 button，同桌面端 T02146 约束） */}
              <FavoriteToggle favorited={Boolean(p.is_favorited)} onToggle={() => void toggleFavorite(p)} size={18} />
              <button onClick={() => setExpanded((cur) => (cur === p.id ? null : p.id))} style={cardHead}>
                <span style={{ flex: 1, textAlign: 'left', fontWeight: 600, fontSize: 'var(--fs-xl)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
                <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{expanded === p.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
              </button>
            </div>
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

const hdr: React.CSSProperties = { fontSize: 'var(--fs-2xl)', fontWeight: 700, padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--card-bg)' };
const sel: React.CSSProperties = { width: '100%', padding: 10, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 'var(--fs-l)', background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box' };
// T03683：显示范围切换按钮（分类下拉下方，与列表同宽的一枚 chip）
const scopeBtn: React.CSSProperties = { marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, background: 'var(--surface)', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 'var(--fs-m)' };
const cardHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)' };
const pre: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', background: 'var(--surface)', borderRadius: 8, padding: 10, margin: 0, maxHeight: 280, overflowY: 'auto' };
const copyBtn: React.CSSProperties = { marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px', borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 'var(--fs-l)' };
