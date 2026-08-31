import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, FolderInput, Pencil, Plus, Save, SquarePen, Trash2, X } from 'lucide-react';
import { api, type Prompt, type PromptCategory } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { clearSessionState, useSessionState } from '../ui/session';
import { MarkdownContent } from '../ui/Markdown';
import { PinToggle } from '../ui/PinToggle';
import { relTime } from '../ui/format';

/** 提示词仓库：按分类管理提示词，支持增删改查与一键复制 */
export function PromptsPage() {
  const [categories, setCategories] = useState<PromptCategory[]>([]);
  // 当前分类：跨切换会话记忆用户选择，便于切回后继续操作
  const [activeCat, setActiveCat] = useSessionState('prompts.activeCat', '');
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  // 排序条件：sortKey 排序字段，sortDir 升降序（默认时间降序，与后端默认一致）
  const [sortKey, setSortKey] = useState<'updated_at' | 'created_at' | 'title'>('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // 新建提示词表单：录入状态跨会话持久化，切页后可续写
  const [creating, setCreating] = useSessionState('prompts.new.creating', false);
  const [newTitle, setNewTitle] = useSessionState('prompts.new.title', '');
  const [newContent, setNewContent] = useSessionState('prompts.new.content', '');
  // 编辑草稿：promptId -> 草稿
  const [drafts, setDrafts] = useState<Record<string, { title: string; content: string; categoryId: string }>>({});
  // 内容 展开/收起：expandedIds 记录已展开的提示词 id，默认全部收起（点击标题切换，降低信息密度）
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  // 记录高亮：保存/新增成功后对目标行打标记，flashAt 值变化触发行动画重放
  const [flashAt, setFlashAt] = useState<Record<string, number>>({});
  // 调整分组：moveOpenId 记录当前展开分组选择器的提示词 id（单开），'' 表示全部收起
  const [moveOpenId, setMoveOpenId] = useState('');
  // 分组选择器容器引用：用于判断点击是否落在菜单外部（点击外部收起）
  const moveRef = useRef<HTMLDivElement | null>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  const loadCategories = useCallback(async () => {
    const cats = await api.get<PromptCategory[]>('/prompt-categories');
    setCategories(cats);
    // 保持当前选中；选中项被删除或首次加载时回落到第一个分类
    setActiveCat((cur) => (cats.some((c) => c.id === cur) ? cur : cats[0]?.id ?? ''));
  }, []);

  const loadPrompts = useCallback(async (categoryId: string, keyword: string) => {
    if (!categoryId) { setPrompts([]); return; }
    const qs = new URLSearchParams({ categoryId });
    if (keyword.trim()) qs.set('keyword', keyword.trim());
    setPrompts(await api.get<Prompt[]>(`/prompts?${qs.toString()}`));
  }, []);

  useEffect(() => { void loadCategories(); }, [loadCategories]);
  useEffect(() => { void loadPrompts(activeCat, search); }, [activeCat, search, loadPrompts]);

  // ---------- 分类管理 ----------
  async function addCategory() {
    const name = await askInput({ title: '新建提示词分类', placeholder: '请输入分类名称' });
    if (!name) return;
    try {
      const created = await api.post<PromptCategory>('/prompt-categories', { name });
      await loadCategories();
      setActiveCat(created.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function renameCategory(cat: PromptCategory) {
    const name = await askInput({ title: '重命名分类', defaultValue: cat.name });
    if (!name || name === cat.name) return;
    try {
      await api.patch(`/prompt-categories/${cat.id}`, { name });
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeCategory(cat: PromptCategory) {
    const cnt = cat.promptCount ?? 0;
    // 影响面文案先算好再插值：避免模板字面量嵌套（内层模板写在外层 ${} 里）
    const impact = cnt > 0 ? `其下 ${cnt} 条提示词将一并删除，` : '';
    const ok = await askConfirm(`确认删除分类「${cat.name}」？${impact}此操作不可恢复。`);
    if (!ok) return;
    try {
      await api.del(`/prompt-categories/${cat.id}`);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------- 提示词增删改查 ----------
  async function createPrompt() {
    if (!newTitle.trim() || !activeCat) return;
    try {
      await api.post('/prompts', { categoryId: activeCat, title: newTitle.trim(), content: newContent });
      setNewTitle('');
      setNewContent('');
      setCreating(false);
      // 提交成功后清空持久化缓存，避免下次继续显示旧录入内容
      clearSessionState('prompts.new.creating');
      clearSessionState('prompts.new.title');
      clearSessionState('prompts.new.content');
      void loadPrompts(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveDraft(p: Prompt) {
    const d = drafts[p.id];
    // 可选链一步覆盖「无草稿」与「标题为空」两种返回条件
    if (!d?.title.trim()) return;
    try {
      await api.patch(`/prompts/${p.id}`, { title: d.title.trim(), content: d.content, categoryId: d.categoryId });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
      setFlashAt((prev) => ({ ...prev, [p.id]: Date.now() }));
      void loadPrompts(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function removePrompt(p: Prompt) {
    if (!(await askConfirm(`删除提示词「${p.title}」？此操作不可恢复。`))) return;
    try {
      await api.del(`/prompts/${p.id}`);
      void loadPrompts(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 复制到剪贴板（Electron/file:// 下 clipboard API 可能受限，提供 execCommand 兜底） */
  async function copyPrompt(p: Prompt) {
    try {
      await navigator.clipboard.writeText(p.content);
      flash('已复制到剪贴板');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = p.content;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy'); // NOSONAR - Clipboard API 受限环境（Electron/file://）的降级路径无未废弃替代 API
        flash('已复制到剪贴板');
      } catch {
        flash('复制失败，请手动选择文本复制');
      }
      ta.remove();
    }
  }

  /** 置顶/取消置顶：切换后重新拉取，置顶项经前端排序始终排在最前 */
  async function togglePin(p: Prompt) {
    try {
      await api.patch(`/prompts/${p.id}`, { pinned: !p.pinned });
      void loadPrompts(activeCat, search);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 调整分组：切换提示词所属分类；目标与当前相同则仅提示不发请求 */
  async function movePrompt(p: Prompt, targetId: string) {
    setMoveOpenId('');
    if (targetId === p.category_id) {
      flash('已在该分组');
      return;
    }
    try {
      await api.patch(`/prompts/${p.id}`, { categoryId: targetId });
      const cat = categories.find((c) => c.id === targetId);
      flash('已调整至「' + (cat?.name ?? '未分类') + '」分组');
      void loadPrompts(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  // 分组选择器：点击外部区域自动收起（仅在打开时挂载监听，避免全局事件常驻）
  useEffect(() => {
    if (!moveOpenId) return;
    const onDocClick = (e: MouseEvent) => {
      if (moveRef.current && !moveRef.current.contains(e.target as Node)) setMoveOpenId('');
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [moveOpenId]);

  const activeCatObj = categories.find((c) => c.id === activeCat);

  /** 依据当前排序条件对提示词排序（不改变原始 state）；置顶项始终排在最前 */
  const sortedPrompts = [...prompts].sort((a, b) => {
    // 置顶优先：置顶项固定在最前，组内再按用户字段/方向排序
    const pa = Boolean(a.pinned);
    const pb = Boolean(b.pinned);
    if (pa !== pb) return pa ? -1 : 1;
    // 时间字段为 ISO 字符串可直接比较；名称按中文语言规则比较（数字感知）
    const cmp = sortKey === 'title'
      ? a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true })
      : a[sortKey].localeCompare(b[sortKey]);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <section>
      {/* 悬浮操作按钮 + 行 hover 高亮 + 记录高亮动画：类名与任务页体验一致 */}
      <style>{`
        .arena-row { transition: background-color .15s ease; }
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
        @keyframes rowflush { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
        .arena-row.flush { animation: rowflush 1.4s ease; }
        .move-btn:hover { color: var(--accent); }
      `}</style>
      {/* 工具栏：分类切换与管理 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={activeCat} onChange={(e) => setActiveCat(e.target.value)} style={{ padding: 6, minWidth: 180 }}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.promptCount ?? 0}）</option>)}
        </select>
        <button onClick={() => void addCategory()} title="新建分类 — 新增一个提示词分类" aria-label="新建分类：新增一个提示词分类"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}>
          <Plus size={13} style={{ verticalAlign: '-2px' }} /> 新建分类
        </button>
        {activeCatObj && (
          <>
            <button onClick={() => void renameCategory(activeCatObj)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              title="重命名 — 修改当前分类名称" aria-label="重命名：修改当前分类名称">
              <SquarePen size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            </button>
            <button onClick={() => void removeCategory(activeCatObj)} style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
              title="删除分类 — 删除当前分类及其下提示词" aria-label="删除分类：删除当前分类及其下提示词">
              <Trash2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            </button>
          </>
        )}
        <button
          onClick={() => { setCreating(!creating); setNewTitle(''); setNewContent(''); }}
          disabled={!activeCat}
          // 无文字纯图标按钮：悬浮提示随状态切换（新建/收起），点击动画由全局 button:active 提供
          title={creating ? '收起 — 收起新建提示词表单' : '新建提示词 — 展开新建提示词表单'}
          aria-label={creating ? '收起：收起新建提示词表单' : '新建提示词：展开新建提示词表单'}
          style={{ marginLeft: 12, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', padding: '6px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
        >
          <Plus size={13} />
        </button>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as 'updated_at' | 'created_at' | 'title')}
          title="排序字段"
          style={{ padding: 6, fontSize: 12 }}
        >
          <option value="updated_at">更新时间</option>
          <option value="created_at">创建时间</option>
          <option value="title">名称</option>
        </select>
        <select
          value={sortDir}
          onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
          title="排序方式"
          style={{ padding: 6, fontSize: 12 }}
        >
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索标题/内容…"
          style={{ padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, marginLeft: 'auto' }}
        />
        {notice && <span style={{ fontSize: 13, color: 'var(--accent)' }}>{notice}</span>}
      </div>

      {activeCatObj?.description && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{activeCatObj.description}</div>
      )}

      {/* 新建提示词表单 */}
      {creating && (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="提示词标题"
            style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', marginBottom: 8 }}
          />
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={6}
            placeholder="提示词内容（可用 {占位符} 标记使用时需替换的部分）"
            style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' }}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button
              onClick={() => void createPrompt()}
              disabled={!newTitle.trim()}
              title="保存 — 创建这条提示词"
              aria-label="保存：创建这条提示词"
              style={{ background: 'var(--success)', color: '#fff', border: 'none', padding: '6px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            >
              <Save size={13} />
            </button>
            <button onClick={() => setCreating(false)} title="取消 — 放弃新建并收起表单" aria-label="取消：放弃新建并收起表单"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
              <X size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            </button>
          </div>
        </div>
      )}

      {/* 提示词列表 */}
      {sortedPrompts.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{categories.length === 0 ? '暂无分类，请先新建分类。' : '该分类下暂无提示词。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {sortedPrompts.map((p) => {
          const draft = drafts[p.id];
          const editing = draft !== undefined;
          return (
            <li key={flashAt[p.id] ? `f${flashAt[p.id]}-${p.id}` : p.id} className={`arena-row${flashAt[p.id] ? ' flush' : ''}`} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
              {editing ? (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      value={draft.title}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: { ...draft, title: e.target.value } }))}
                      style={{ flex: 1, padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14 }}
                    />
                    <select
                      value={draft.categoryId}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: { ...draft, categoryId: e.target.value } }))}
                      style={{ padding: 6 }}
                    >
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <textarea
                    value={draft.content}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: { ...draft, content: e.target.value } }))}
                    rows={6}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' }}
                  />
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button onClick={() => void saveDraft(p)} disabled={!draft.title.trim()} style={{ fontSize: 12, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="保存 — 保存对这条提示词的修改" aria-label="保存：保存对这条提示词的修改">
                      <Save size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    <button onClick={() => setDrafts((prev) => {
                      const next = { ...prev };
                      delete next[p.id];
                      return next;
                    })} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }} title="取消 — 放弃编辑修改"
                      aria-label="取消：放弃编辑修改">
                      <X size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* 标题可点击，切换内容展开/收起（默认收起，降低信息密度） */}
                    <button
                      onClick={() => setExpandedIds((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                      title={expandedIds[p.id] ? '点击收起提示词内容' : '点击展开提示词内容'}
                      aria-label={expandedIds[p.id] ? '收起：收起提示词内容' : '展开：展开提示词内容'}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', minWidth: 0 }}
                    >
                      <PinToggle pinned={Boolean(p.pinned)} onToggle={() => void togglePin(p)} />
                      <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
                      {/* 展开/收起箭头：与任务页统一使用 lucide 图标，蓝色 13px */}
                      <span style={{ color: 'var(--accent)', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>{expandedIds[p.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
                    </button>
                    <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }} title={`更新于 ${p.updated_at}`}>{relTime(p.updated_at)}</span>
                    <button className="abtn" onClick={() => void copyPrompt(p)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="复制 — 复制提示词内容到剪贴板" aria-label="复制：复制提示词内容到剪贴板">
                      <Copy size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    <button
                      className="abtn"
                      onClick={() => setDrafts((prev) => ({ ...prev, [p.id]: { title: p.title, content: p.content, categoryId: p.category_id } }))}
                      style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="编辑 — 编辑这条提示词" aria-label="编辑：编辑这条提示词"
                    >
                      <Pencil size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    {/* 调整分组：行内浮层选择器，打开后点外部收起；当前分组高亮并标注（当前） */}
                    <div ref={moveOpenId === p.id ? moveRef : undefined} style={{ position: 'relative', display: 'inline-flex' }}>
                      <button className="abtn move-btn" onClick={() => setMoveOpenId(moveOpenId === p.id ? '' : p.id)}
                        title="调整分组 — 移动该提示词到其他分组" aria-label="调整分组：移动该提示词到其他分组"
                        style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
                        <FolderInput size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                      </button>
                      {moveOpenId === p.id && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.12)', padding: 4, zIndex: 10, minWidth: 140 }}>
                          {categories.map((c) => (
                            <button key={c.id} onClick={() => void movePrompt(p, c.id)}
                              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', fontSize: 12, borderRadius: 4, background: 'transparent', color: c.id === p.category_id ? 'var(--accent)' : 'var(--text)' }}>
                              {c.name}{c.id === p.category_id ? '（当前）' : ''}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button className="abtn" onClick={() => void removePrompt(p)} style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="删除 — 删除这条提示词" aria-label="删除：删除这条提示词">
                      <Trash2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                  </div>
                  {expandedIds[p.id] && (
                    // MarkdownContent 默认渲染富文本、可切源码视图，右上角切换/复制按钮悬浮于内容之上
                    <div style={{ marginTop: 6 }}>
                      <MarkdownContent content={p.content} showCopy />
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
