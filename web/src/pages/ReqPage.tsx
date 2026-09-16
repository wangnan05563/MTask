import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarRange, ChevronDown, ChevronUp, Copy, FolderInput, FolderPlus, ListTodo, Loader2, Pencil, Plus, Save, SquarePen, Trash2, X, UnfoldVertical, FoldVertical } from 'lucide-react';
import { CopyButton } from '../ui/CopyButton';
import { FontColorButton } from '../ui/FontColorButton';
import { api, type Project, type ReqCategory, type ReqEntry } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { clearSessionState, useSessionState } from '../ui/session';
import { MarkdownContent } from '../ui/Markdown';
import { PinToggle } from '../ui/PinToggle';
import { relTime } from '../ui/format';

/** 通用需求仓库：按分类管理"通用优秀实现/解决方案"，支持增删改查与一键复制 */
export function ReqPage() {
  const [categories, setCategories] = useState<ReqCategory[]>([]);
  // 当前分类：跨切换会话记忆用户选择，便于切回后继续操作
  const [activeCat, setActiveCat] = useSessionState('req.activeCat', '');
  const [entries, setEntries] = useState<ReqEntry[]>([]);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');

  // T00629：复制到待办任务——目标项目选择弹窗（与提示词页一致）
  const [taskCopyEntry, setTaskCopyEntry] = useState<ReqEntry | null>(null);
  const [taskCopyProjectId, setTaskCopyProjectId] = useState('');
  const [taskCopyBusy, setTaskCopyBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  // 排序条件：sortKey 排序字段，sortDir 升降序（默认时间降序，与后端默认一致）
  const [sortKey, setSortKey] = useState<'updated_at' | 'created_at' | 'title' | 'manual'>('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // 新建条目表单：录入状态跨会话持久化，切页后可续写
  const [creating, setCreating] = useSessionState('req.new.creating', false);
  const [newTitle, setNewTitle] = useSessionState('req.new.title', '');
  const [newContent, setNewContent] = useSessionState('req.new.content', '');
  // 编辑草稿：entryId -> 草稿
  const [drafts, setDrafts] = useState<Record<string, { title: string; content: string; categoryId: string }>>({});
  // 内容 展开/收起：expandedIds 记录已展开的条目 id，默认全部收起（点击标题切换，降低信息密度）
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  // 记录高亮：保存/新增成功后对目标行打标记，flashAt 值变化触发行动画重放
  const [flashAt, setFlashAt] = useState<Record<string, number>>({});
  function dropReorder(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(''); setOverId(''); return; }
    const ids = sortedEntries.map((x) => x.id); // T00494 修正：按显示顺序计算拖拽映射（此前用原始数组顺序，与界面所见不一致导致拖拽错乱）
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragId(''); setOverId('');
    void api.post('/req-entries/reorder', { categoryId: activeCat, orderedIds: ids }).then(() => {
      flash('顺序已保存');
      void loadEntries(activeCat, search);
    }).catch((e) => flash(String((e as Error).message ?? e)));
  }

  // T00463：条目拖拽排序状态
  const [dragId, setDragId] = useState('');
  // T00489：按住行 200ms 才缩放（快速点击/点行内按钮不触发）
  const [pressId, setPressId] = useState('');
  const pressTimer = useRef<Record<string, number>>({}); // NOSONAR - dragId 供 dropReorder 读取，setDragId 用于拖拽态重渲染
  const [overId, setOverId] = useState(''); // NOSONAR - overId 供列表行接入拖拽高亮后读取，setOverId 用于拖拽悬停态重渲染
  // 调整分组：moveOpenId 记录当前展开分组选择器的条目 id（单开），'' 表示全部收起
  const [moveOpenId, setMoveOpenId] = useState('');
  // 分组选择器容器引用：用于判断点击是否落在菜单外部（点击外部收起）
  const moveRef = useRef<HTMLDivElement | null>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  const loadCategories = useCallback(async () => {
    const cats = await api.get<ReqCategory[]>('/req-categories');
    setCategories(cats);
    // 保持当前选中；选中项被删除或首次加载时回落到第一个分类
    setActiveCat((cur) => (cats.some((c) => c.id === cur) ? cur : cats[0]?.id ?? ''));
  }, []);

  const loadEntries = useCallback(async (categoryId: string, keyword: string) => {
    if (!categoryId) { setEntries([]); return; }
    const qs = new URLSearchParams({ categoryId });
    if (keyword.trim()) qs.set('keyword', keyword.trim());
    setEntries(await api.get<ReqEntry[]>(`/req-entries?${qs.toString()}`));
  }, []);

  useEffect(() => { void loadCategories(); }, [loadCategories]);
  useEffect(() => { void loadEntries(activeCat, search); }, [activeCat, search, loadEntries]);

  // ---------- 分类管理 ----------
  async function addCategory() {
    const name = await askInput({ title: '新建通用需求分类', placeholder: '请输入分类名称' });
    if (!name) return;
    try {
      const created = await api.post<ReqCategory>('/req-categories', { name });
      await loadCategories();
      setActiveCat(created.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function renameCategory(cat: ReqCategory) {
    const name = await askInput({ title: '重命名分类', defaultValue: cat.name });
    if (!name || name === cat.name) return;
    try {
      await api.patch(`/req-categories/${cat.id}`, { name });
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeCategory(cat: ReqCategory) {
    const cnt = cat.reqCount ?? 0;
    // 影响面文案先算好再插值：避免模板字面量嵌套（内层模板写在外层 ${} 里）
    const impact = cnt > 0 ? `其下 ${cnt} 条通用需求将一并删除，` : '';
    const ok = await askConfirm(`确认删除分类「${cat.name}」？${impact}此操作不可恢复。`);
    if (!ok) return;
    try {
      await api.del(`/req-categories/${cat.id}`);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------- 条目增删改查 ----------
  async function createEntry() {
    if (!newTitle.trim() || !activeCat) return;
    try {
      await api.post('/req-entries', { categoryId: activeCat, title: newTitle.trim(), content: newContent });
      setNewTitle('');
      setNewContent('');
      setCreating(false);
      // 提交成功后清空持久化缓存，避免下次继续显示旧录入内容
      clearSessionState('req.new.creating');
      clearSessionState('req.new.title');
      clearSessionState('req.new.content');
      void loadEntries(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveDraft(p: ReqEntry) {
    const d = drafts[p.id];
    // 可选链一步覆盖「无草稿」与「标题为空」两种返回条件
    if (!d?.title.trim()) return;
    try {
      await api.patch(`/req-entries/${p.id}`, { title: d.title.trim(), content: d.content, categoryId: d.categoryId });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
      setFlashAt((prev) => ({ ...prev, [p.id]: Date.now() }));
      void loadEntries(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeEntry(p: ReqEntry) {
    if (!(await askConfirm(`删除通用需求「${p.title}」？此操作不可恢复。`))) return;
    try {
      await api.del(`/req-entries/${p.id}`);
      void loadEntries(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 转计划草稿（T00456 / PRD INT-5）：把通用需求转为目标项目的计划任务（追加尾部自动排期） */
  async function toPlan(p: ReqEntry) {
    const pid = await askInput({ title: '转计划 — 输入目标项目名称', placeholder: '如：MTask' });
    if (!pid?.trim()) return;
    try {
      await api.post('/plans/from-req', { reqEntryId: p.id, projectId: pid.trim() });
      flash(`已将「${p.title}」转存到「${pid.trim()}」的项目计划`);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** T00629：复制到待办任务——支持**指定目标项目**（弹窗选择；不选则落默认记事项目/收件箱） */
  async function copyToTask(p: ReqEntry) {
    setTaskCopyEntry(p);
    setTaskCopyProjectId('');
    try {
      setProjects(await api.get<Project[]>('/projects'));
    } catch { /* 加载失败仍可用默认收件箱 */ }
  }

  /** T00629：确认复制到待办（目标项目可选） */
  async function confirmCopyToTask() {
    if (!taskCopyEntry) return;
    const p = taskCopyEntry;
    const targetName = taskCopyProjectId
      ? (projects.find((x) => x.id === taskCopyProjectId)?.name ?? '所选项目')
      : '默认记事项目（收件箱）';
    setTaskCopyBusy(true);
    try {
      const r = await api.post<{ ok: boolean; reused: boolean }>(`/req-entries/${p.id}/to-task`,
        taskCopyProjectId ? { projectId: taskCopyProjectId } : {});
      flash(r.reused
        ? `目标项目已有同标题待办，已复用（${targetName}）`
        : `已复制「${p.title}」到待办任务（${targetName}）`);
      setTaskCopyEntry(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskCopyBusy(false);
    }
  }

  /** 复制到剪贴板（Electron/file:// 下 clipboard API 可能受限，提供 execCommand 兜底） */
  async function copyEntry(p: ReqEntry) {
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
  async function togglePin(p: ReqEntry) {
    try {
      await api.patch(`/req-entries/${p.id}`, { pinned: !p.pinned });
      void loadEntries(activeCat, search);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 调整分组：切换条目所属分类；目标与当前相同则仅提示不发请求 */
  async function moveEntry(p: ReqEntry, targetId: string) {
    setMoveOpenId('');
    if (targetId === p.category_id) {
      flash('已在该分组');
      return;
    }
    try {
      await api.patch(`/req-entries/${p.id}`, { categoryId: targetId });
      const cat = categories.find((c) => c.id === targetId);
      flash('已调整至「' + (cat?.name ?? '未分类') + '」分组');
      void loadEntries(activeCat, search);
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

  /** 依据当前排序条件对条目排序（不改变原始 state）；置顶项始终排在最前 */
  const sortedEntries = [...entries].sort((a, b) => {
    // 置顶优先：置顶项固定在最前，组内再按用户字段/方向排序
    const pa = Boolean(a.pinned);
    const pb = Boolean(b.pinned);
    if (pa !== pb) return pa ? -1 : 1;
    // 时间字段为 ISO 字符串可直接比较；名称按中文语言规则比较（数字感知）
    if (sortKey === 'manual') {
      const wa = a.sort_weight || 0;
      const wb = b.sort_weight || 0;
      if (wa !== wb) return wa === 0 ? 1 : wb === 0 ? -1 : wa - wb;
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    }
    const cmp = sortKey === 'title'
      ? a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true })
      : a[sortKey].localeCompare(b[sortKey]);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <section>
      {/* 悬浮操作按钮 + 行 hover 高亮 + 记录高亮动画：类名与任务页体验一致 */}
      <style>{`
        .arena-row { transition: background-color .15s ease, transform .12s ease; }
        /* T00467/T00468：图标按钮 hover 动画 */
        .tbtn-anim svg { transition: transform .18s ease; }
        .tbtn-anim:hover svg { transform: scale(1.2) rotate(8deg); }
        .tbtn-anim:active svg { transform: scale(.88); }
        .arena-row.item-pressing { transform: scale(.985); } /* T00489：仅按住行触发 */
        .arena-row:hover { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        /* T00469：操作图标按钮 hover 动效（lucide 图标微缩放反馈） */
        .abtn svg { transition: transform .15s ease; }
        .abtn:hover svg { transform: scale(1.15); }
        .abtn:active svg { transform: scale(.9); }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
        @keyframes rowflush { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
        .arena-row.flush { animation: rowflush 1.4s ease; }
        .item-dragging { opacity: .5; box-shadow: 0 8px 20px rgba(0,0,0,.25); border-color: var(--accent) !important; }
        .item-over { box-shadow: inset 0 3px 0 var(--accent); border-color: var(--accent) !important; }
        .move-btn:hover { color: var(--accent); }
      `}</style>
      {/* 工具栏：分类切换与管理 */}
      <div className="op-host" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={activeCat} onChange={(e) => setActiveCat(e.target.value)} style={{ padding: 6, fontSize: 12, minWidth: 180, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.reqCount ?? 0}）</option>)}
        </select>
        {/* T00510 调整：分类管理三按钮与任务菜单项目按钮组同款——纯图标+边框、同组紧跟下拉、悬浮显示 */}
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => void addCategory()} title="新建分类 — 新增一个通用需求分类" aria-label="新建分类：新增一个通用需求分类"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}>
          <FolderPlus size={13} />
        </button>
        {activeCat && (
          <>
          <button onClick={() => { const c = categories.find((c) => c.id === activeCat); if (c) void renameCategory(c); }}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}
            title="重命名 — 修改当前分类名称" aria-label="重命名：修改当前分类名称">
            <SquarePen size={13} />
          </button>
          <button onClick={() => { const c = categories.find((c) => c.id === activeCat); if (c) void removeCategory(c); }}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, color: 'var(--danger)', background: 'transparent', border: '1px solid var(--danger)', borderRadius: 6, cursor: 'pointer' }}
            title="删除分类 — 删除当前分类及其下通用需求" aria-label="删除分类：删除当前分类及其下通用需求">
            <Trash2 size={13} />
          </button>
          </>
        )}
        </span>
        {activeCat && (
          <>
            <button className="tbtn-anim" onClick={() => {
              const ids = entries.map((x) => x.id);
              const allExpanded = ids.length > 0 && ids.every((id) => expandedIds[id]);
              setExpandedIds(allExpanded ? {} : Object.fromEntries(ids.map((id) => [id, true])));
            }} title={entries.length > 0 && entries.every((x) => expandedIds[x.id]) ? '全部收起 — 收起全部通用需求内容' : '全部展开 — 展开全部通用需求内容'} aria-label="全部展开或收起通用需求内容"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px', borderRadius: 6 }}>
              {entries.length > 0 && entries.every((x) => expandedIds[x.id]) ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
            </button>
          </>
        )}
        <button
          onClick={() => { setCreating(!creating); setNewTitle(''); setNewContent(''); }}
          disabled={!activeCat}
          // 无文字纯图标按钮：悬浮提示随状态切换（新建/收起），点击动画由全局 button:active 提供
          title={creating ? '收起 — 收起新建通用需求表单' : '新建通用需求 — 展开新建通用需求表单'}
          aria-label={creating ? '收起：收起新建通用需求表单' : '新建通用需求：展开新建通用需求表单'}
          style={{ marginLeft: 12, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', padding: '6px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
        >
          <Plus size={13} />
        </button>
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as 'updated_at' | 'created_at' | 'title')}
          title="排序字段"
          style={{ padding: 6, fontSize: 12 }}
        >
          <option value="manual">手动排序</option>
          <option value="updated_at">更新时间</option>
          <option value="created_at">创建时间</option>
          <option value="title">名称</option>
        </select>
        </span>
        </span>
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <select
          value={sortDir}
          onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
          title="排序方式"
          style={{ padding: 6, fontSize: 12 }}
        >
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
        </span>
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索标题/内容…"
          style={{ padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, marginLeft: 'auto' }}
        />
        {notice && <span className="flash-toast" role="status">{notice}</span>}
      </div>

      {/* 新建条目表单 */}
      {creating && (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="通用需求标题"
            style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', marginBottom: 8 }}
          />
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={6}
            placeholder="通用需求内容（描述该优秀实现/解决方案，可用 {占位符} 标记使用时需替换的部分）"
            style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' }}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button
              onClick={() => void createEntry()}
              disabled={!newTitle.trim()}
              title="保存 — 创建这条通用需求"
              aria-label="保存：创建这条通用需求"
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

      {/* 条目列表 */}
      {sortedEntries.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{categories.length === 0 ? '暂无分类，请先新建分类。' : '该分类下暂无通用需求。'}</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {sortedEntries.map((p) => {
          const draft = drafts[p.id];
          const editing = draft !== undefined;
          return (
            <li key={flashAt[p.id] ? `f${flashAt[p.id]}-${p.id}` : p.id}
              onMouseDown={(e) => { if ((e.target as HTMLElement).closest('button, input, select, a, textarea, label')) return; pressTimer.current[p.id] = window.setTimeout(() => setPressId(p.id), 200); }}
              onMouseUp={() => { clearTimeout(pressTimer.current[p.id]); if (pressId) setPressId(''); }}
              onMouseLeave={() => { clearTimeout(pressTimer.current[p.id]); if (pressId === p.id) setPressId(''); }}
              draggable={sortKey === 'manual'}
              onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { setDragId(''); setOverId(''); }}
              onDragOver={(e) => { e.preventDefault(); if (p.id !== dragId) setOverId(p.id); }}
              onDrop={(e) => { e.preventDefault(); dropReorder(p.id); }}
              className={`arena-row${flashAt[p.id] ? ' flush' : ''}${dragId === p.id ? ' item-dragging' : overId === p.id ? ' item-over' : ''}${pressId === p.id ? ' item-pressing' : ''}`}
              style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10, cursor: 'grab' }}>
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
                      title="保存 — 保存对这条通用需求的修改" aria-label="保存：保存对这条通用需求的修改">
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
                  {/* T00494 调整：去掉拖拽把手图标（整行即可拖拽） */}
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* 标题可点击，切换内容展开/收起（默认收起，降低信息密度） */}
                    <button
                      onClick={() => setExpandedIds((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                      title={expandedIds[p.id] ? '点击收起通用需求内容' : '点击展开通用需求内容'}
                      aria-label={expandedIds[p.id] ? '收起：收起通用需求内容' : '展开：展开通用需求内容'}
                      className="row-title-btn"
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', minWidth: 0 }}
                    >
                      <PinToggle pinned={Boolean(p.pinned)} onToggle={() => void togglePin(p)} />
                      <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' , color: p.color || undefined }}>{p.title}</span>
                      {/* 展开/收起箭头：与任务页统一使用 lucide 图标，蓝色 13px */}
                      <span style={{ color: 'var(--accent)', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>{expandedIds[p.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
                    </button>
                    <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }} title={`更新于 ${p.updated_at}`}>{relTime(p.updated_at)}</span>
                    <span className="abtn" style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <FontColorButton current={p.color ?? ''} onApply={(c) => { void api.patch(`/req-entries/${p.id}`, { color: c }).then(() => { void loadEntries(activeCat, search); }); }} />
                    </span>
                    <CopyButton getText={() => p.title + (p.content ? '\n' + p.content : '')} title="复制 — 复制通用需求内容到剪贴板" ariaLabel="复制：复制通用需求内容" />
                    {/* T00436：复制到待办任务 — 转成收件箱项目的待办，悬浮提示按任务规格 */}
                    <button className="abtn" onClick={() => void copyToTask(p)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="复制到待办任务 — 以该通用需求创建一条待办任务（收件箱项目）" aria-label="复制到待办任务">
                      <ListTodo size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    {/* T00456 / PRD INT-5：转计划 — 把通用需求转为目标项目的计划任务 */}
                    <button className="abtn" onClick={() => void toPlan(p)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="转计划 — 把该通用需求转为目标项目的计划任务（输入目标项目名）" aria-label="转计划：转为目标项目的计划任务">
                      <CalendarRange size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    <button
                      className="abtn"
                      onClick={() => setDrafts((prev) => ({ ...prev, [p.id]: { title: p.title, content: p.content, categoryId: p.category_id } }))}
                      style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="编辑 — 编辑这条通用需求" aria-label="编辑：编辑这条通用需求"
                    >
                      <Pencil size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    {/* 调整分组：行内浮层选择器，打开后点外部收起；当前分组高亮并标注（当前） */}
                    <div ref={moveOpenId === p.id ? moveRef : undefined} style={{ position: 'relative', display: 'inline-flex' }}>
                      <button className="abtn move-btn" onClick={() => setMoveOpenId(moveOpenId === p.id ? '' : p.id)}
                        title="调整分组 — 移动该通用需求到其他分组" aria-label="调整分组：移动该通用需求到其他分组"
                        style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
                        <FolderInput size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                      </button>
                      {moveOpenId === p.id && (
                        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.12)', padding: 4, zIndex: 10, minWidth: 140 }}>
                          {categories.map((c) => (
                            <button key={c.id} onClick={() => void moveEntry(p, c.id)}
                              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', fontSize: 12, borderRadius: 4, background: 'transparent', color: c.id === p.category_id ? 'var(--accent)' : 'var(--text)' }}>
                              {c.name}{c.id === p.category_id ? '（当前）' : ''}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button className="abtn" onClick={() => void removeEntry(p)} style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="删除 — 删除这条通用需求" aria-label="删除：删除这条通用需求">
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

      {/* T00629：复制到待办任务——目标项目选择弹窗（与提示词页一致） */}
      {taskCopyEntry && (
        <div /* NOSONAR - 遮罩点击为鼠标便捷关闭，取消按钮提供键盘可达通路 */
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget && !taskCopyBusy) setTaskCopyEntry(null); }}>
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(420px, 92vw)', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
              <ListTodo size={14} style={{ color: 'var(--accent)' }} /> 复制到待办任务
              <span style={{ flex: 1 }} />
              <button onClick={() => setTaskCopyEntry(null)} disabled={taskCopyBusy} title="关闭" aria-label="关闭复制到待办弹窗"
                style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 14, cursor: taskCopyBusy ? 'default' : 'pointer' }}>×</button>
            </div>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
              <div style={{ color: 'var(--text-muted)' }}>
                将通用需求「<strong style={{ color: 'var(--text)' }}>{taskCopyEntry.title}</strong>」复制为一条**待办任务**（内容写入任务描述，不改动需求本身）。
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>目标项目</div>
                <select value={taskCopyProjectId} onChange={(e) => setTaskCopyProjectId(e.target.value)} disabled={taskCopyBusy}
                  aria-label="目标项目" title="选择待办任务落到哪个项目"
                  style={{ width: '100%', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12 }}>
                  <option value="">默认记事项目（收件箱）</option>
                  {projects.map((pj) => <option key={pj.id} value={pj.id}>{pj.name}</option>)}
                </select>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  目标项目若已存在同标题待办，将自动复用（不重复创建）。
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setTaskCopyEntry(null)} disabled={taskCopyBusy} className="tbtn-anim"
                style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>取消</button>
              <button onClick={() => void confirmCopyToTask()} disabled={taskCopyBusy} className="tbtn-anim"
                title="确认复制到所选项目的待办任务" aria-label="确认复制到待办"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: taskCopyBusy ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12 }}>
                {taskCopyBusy ? <><Loader2 size={12} className="aispin" />复制中…</> : '复制到待办'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}