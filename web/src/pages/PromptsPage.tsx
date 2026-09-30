import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, FolderPlus, ListTodo, Loader2, Move, Pencil, Plus, Save, SquarePen, Trash2, UnfoldVertical, FoldVertical, Wand2, X, Archive, Layers } from 'lucide-react';
import { CopyButton } from '../ui/CopyButton';
import { FontColorButton } from '../ui/FontColorButton';
import { api, type Project, type Prompt, type PromptCategory, type ReqCategory } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { clearSessionState, useSessionState } from '../ui/session';
import { MarkdownContent } from '../ui/Markdown';
import { PinToggle } from '../ui/PinToggle';
import { relTime } from '../ui/format';

/** T00636：剥离大模型常见 ``` 代码围栏（仅整段包裹时），供提示词优化结果回写前清洗 */
function stripFence(text: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}

/** 提示词优化按钮（T00636，S3776 抽取） */
function PromptOptimizeButton({ busy, onClick }: {
  readonly busy: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={busy ? '提示词优化进行中…' : '提示词优化 — 用默认模型把当前内容改写为结构化提示词（结果回填草稿）'}
      aria-label={busy ? '提示词优化进行中' : '提示词优化：改写为结构化提示词'}
      style={{ fontSize: 12, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 4px', background: 'transparent', border: 'none', cursor: busy ? 'default' : 'pointer' }}
      className={busy ? 'task-breathe' : undefined}
    >
      {busy ? <Loader2 size={13} className="aispin" /> : <Wand2 size={13} />}
    </button>
  );
}

/** T00873：移动提示词分组弹窗——样式对齐任务页「复用此任务」弹窗（复用对话框布局：描边面板 + 说明 + 目标下拉 + 取消/主按钮）。
 *  语义为「移动」：把条目从当前提示词分组迁出、整体归到目标分组（覆盖 category_id，原分组不再包含）；
 *  通用需求分类为 T00837 保留的归属切换（归入/解除），一并沉淀在同一弹窗以免功能缺失。 */
function MovePromptModal({ p, categories, reqCats, catId, reqId, setCatId, setReqId, onCancel, onConfirm }: {
  readonly p: Prompt; readonly categories: PromptCategory[]; readonly reqCats: ReqCategory[];
  readonly catId: string; readonly reqId: string;
  readonly setCatId: (v: string) => void; readonly setReqId: (v: string) => void;
  readonly onCancel: () => void; readonly onConfirm: () => void;
}) {
  return (
    // T01361：遮罩为纯装饰层（aria-hidden），点击关闭是鼠标便捷通路，键盘取消走「取消」按钮
    <div
      aria-hidden="true"
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      {/* T00873 四轮：样式严格对齐任务页「复用此任务」（同 width/圆角/阴影 + 标题栏 + 底栏按钮），
          此前是自绘面板（无标题栏、无关闭按钮、遮罩色与全局不一致） */}
      <div style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(420px, 92vw)', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
          <Move size={14} style={{ color: 'var(--accent)' }} /> 移动提示词
          <span style={{ flex: 1 }} />
          <button onClick={onCancel} title="关闭" aria-label="关闭移动提示词弹窗"
            style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 14, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
          <div style={{ color: 'var(--text-muted)' }}>
            <strong style={{ color: 'var(--text)' }}>{p.title}</strong> 可整体移动到另一个提示词分组（原分组不再包含此条目），
            或仅归入某个通用需求分类。两个维度可独立改动：只改下方通用需求分类、提示词分组保持当前值也是合法的。
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>目标分组（提示词分组）</div>
            <select autoFocus value={catId} onChange={(e) => setCatId(e.target.value)} aria-label="选择目标提示词分组"
              title="选择该提示词整体迁入的目标分组"
              style={{ width: '100%', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12 }}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.id === p.category_id ? '（当前）' : ''}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>通用需求分类（归入/解除，可留空；标「（当前）」即已归入）</div>
            <select value={reqId} onChange={(e) => setReqId(e.target.value)} aria-label="选择通用需求分类归属"
              title="把该提示词归入某个通用需求分类；不改动时保持原值"
              style={{ width: '100%', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12 }}>
              <option value="">未归属</option>
              {reqCats.map((c) => <option key={c.id} value={c.id}>{c.name}{c.id === p.req_category_id ? '（当前）' : ''}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <button onClick={onCancel} className="tbtn-anim"
            style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>取消</button>
          <button onClick={onConfirm} title="确认移动 — 按所选项更新提示词分组/通用需求分类（仅提交实际改动项）" aria-label="确认移动提示词分组" className="tbtn-anim"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12 }}>
            移动
          </button>
        </div>
      </div>
    </div>
  );
}

/** 新建提示词表单（S3776：条件块下沉为独立组件） */
function NewPromptForm({ newTitle, setNewTitle, newContent, setNewContent, createPrompt, optimizing, optimizeContent, setCreating }: {
  readonly newTitle: string; readonly setNewTitle: React.Dispatch<React.SetStateAction<string>>;
  readonly newContent: string; readonly setNewContent: React.Dispatch<React.SetStateAction<string>>;
  readonly createPrompt: () => Promise<void>;
  readonly optimizing: Record<string, boolean>;
  readonly optimizeContent: (key: string, title: string, content: string, apply: (v: string) => void) => Promise<void>;
  readonly setCreating: (v: boolean) => void;
}) {
  const busy = optimizing['new'];
  return (
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
        {/* T00636：提示词优化（与任务页同款）——置于保存按钮旁 */}
        <button
          onClick={() => void optimizeContent('new', newTitle, newContent, setNewContent)}
          disabled={busy}
          className={busy ? 'task-breathe' : undefined}
          title={busy ? '提示词优化进行中…' : '提示词优化 — 用默认模型把当前内容改写为结构化提示词（结果回填，可编辑后保存）'}
          aria-label={busy ? '提示词优化进行中' : '提示词优化：改写为结构化提示词'}
          style={{ background: busy ? 'var(--accent)' : 'transparent', color: busy ? 'var(--accent-text)' : 'var(--accent)', border: '1px solid var(--accent)', padding: '5px 8px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
        >
          {busy ? <Loader2 size={13} className="aispin" /> : <Wand2 size={13} />} 提示词优化
        </button>
        <button onClick={() => setCreating(false)} title="取消 — 放弃新建并收起表单" aria-label="取消：放弃新建并收起表单"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}>
          <X size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
        </button>
      </div>
    </div>
  );
}

/** T00494：手动排序权重比较（0/空=默认序排最后）——抽出避免嵌套三元 */
function cmpSortWeight(wa: number, wb: number): number {
  if (wa === wb) return 0;
  if (wa === 0) return 1;
  if (wb === 0) return -1;
  return wa - wb;
}

/** 依据当前排序条件对两条提示词比较；置顶项始终排在最前（供 sort 回调使用） */
function comparePrompts(
  a: Prompt,
  b: Prompt,
  sortKey: 'updated_at' | 'created_at' | 'title' | 'manual',
  sortDir: 'asc' | 'desc',
): number {
  // 置顶优先：置顶项固定在最前，组内再按用户字段/方向排序
  const pa = Boolean(a.pinned);
  const pb = Boolean(b.pinned);
  if (pa !== pb) return pa ? -1 : 1;
  // T00494：手动排序——按拖拽保存的 sort_weight（0/空=默认序，排最后按更新时间）
  if (sortKey === 'manual') {
    const w = cmpSortWeight(a.sort_weight || 0, b.sort_weight || 0);
    if (w !== 0) return w;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  }
  // 时间字段为 ISO 字符串可直接比较；名称按中文语言规则比较（数字感知）
  const cmp = sortKey === 'title'
    ? a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true })
    : a[sortKey].localeCompare(b[sortKey]);
  return sortDir === 'asc' ? cmp : -cmp;
}

/** T00629：复制到待办任务——目标项目选择弹窗（不选则落默认记事项目/收件箱） */
function TaskCopyModal({ taskCopyPrompt, taskCopyBusy, setTaskCopyPrompt, taskCopyProjectId, setTaskCopyProjectId, projects, confirmCopyToTask }: {
  readonly taskCopyPrompt: Prompt; readonly taskCopyBusy: boolean; readonly setTaskCopyPrompt: (v: Prompt | null) => void;
  readonly taskCopyProjectId: string; readonly setTaskCopyProjectId: React.Dispatch<React.SetStateAction<string>>;
  readonly projects: Project[]; readonly confirmCopyToTask: () => Promise<void> | void;
}) {
  return (
    <div /* NOSONAR - 遮罩点击为鼠标便捷关闭，取消按钮提供键盘可达通路 */
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget && !taskCopyBusy) setTaskCopyPrompt(null); }}>
      <div style={{ background: 'var(--card-bg)', borderRadius: 8, width: 'min(420px, 92vw)', boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
          <ListTodo size={14} style={{ color: 'var(--accent)' }} /> 复制到待办任务
          <span style={{ flex: 1 }} />
          <button onClick={() => setTaskCopyPrompt(null)} disabled={taskCopyBusy} title="关闭" aria-label="关闭复制到待办弹窗"
            style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 14, cursor: taskCopyBusy ? 'default' : 'pointer' }}>×</button>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
          <div style={{ color: 'var(--text-muted)' }}>
            将提示词「<strong style={{ color: 'var(--text)' }}>{taskCopyPrompt.title}</strong>」复制为一条**待办任务**（内容写入任务描述，不改动提示词本身）。
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
          <button onClick={() => setTaskCopyPrompt(null)} disabled={taskCopyBusy} className="tbtn-anim"
            style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>取消</button>
          <button onClick={() => confirmCopyToTask()} disabled={taskCopyBusy} className="tbtn-anim"
            title="确认复制到所选项目的待办任务" aria-label="确认复制到待办"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 14px', borderRadius: 6, cursor: taskCopyBusy ? 'default' : 'pointer', border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12 }}>
            {taskCopyBusy ? <><Loader2 size={12} className="aispin" />复制中…</> : '复制到待办'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 提示词仓库：按分类管理提示词，支持增删改查与一键复制 */
export function PromptsPage() {
  const [categories, setCategories] = useState<PromptCategory[]>([]);
  // T00837：通用需求分类列表（调整分组浮层第二区数据源，实时同步 req_categories）
  const [reqCats, setReqCats] = useState<ReqCategory[]>([]);
  // T00873 四轮：按「通用需求分类」过滤列表——归入某分类后要能在该维度检索到（T00837「组织与检索效率」）；
  // '' = 全部，'__none__' = 未归属，其余为具体分类 id
  const [reqFilter, setReqFilter] = useState('');
  // T00837：撤销快照——最近一次分组/通用需求分类调整前的归属，用于一键还原
  const [lastMove, setLastMove] = useState<{ id: string; prevCategoryId: string; prevReqCategoryId: string } | null>(null);
  // 当前分类：跨切换会话记忆用户选择，便于切回后继续操作
  const [activeCat, setActiveCat] = useSessionState('prompts.activeCat', '');
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [search, setSearch] = useSessionState<string>('prompts.search', ''); // T00560：命令面板跳转写入搜索词
  const [notice, setNotice] = useState('');
  // 排序条件：sortKey 排序字段，sortDir 升降序（默认时间降序，与后端默认一致）
  const [sortKey, setSortKey] = useState<'updated_at' | 'created_at' | 'title' | 'manual'>('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // 新建提示词表单：录入状态跨会话持久化，切页后可续写
  const [creating, setCreating] = useSessionState('prompts.new.creating', false);
  const [newTitle, setNewTitle] = useSessionState('prompts.new.title', '');
  const [newContent, setNewContent] = useSessionState('prompts.new.content', '');
  // 编辑草稿：promptId -> 草稿
  const [drafts, setDrafts] = useState<Record<string, { title: string; content: string; categoryId: string }>>({});

  // T00636：提示词优化——与任务页「提示词优化」同款能力（复用 AI 整理工具把内容改写为结构化提示词）
  const [organizeToolId, setOrganizeToolId] = useState('');
  const [optimizing, setOptimizing] = useState<Record<string, boolean>>({}); // key: 'new' 或 提示词 id

  // T00629：复制到待办任务——目标项目选择弹窗（不选则落默认记事项目/收件箱）
  const [taskCopyPrompt, setTaskCopyPrompt] = useState<Prompt | null>(null);
  const [taskCopyProjectId, setTaskCopyProjectId] = useState('');
  const [taskCopyBusy, setTaskCopyBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  // 内容 展开/收起：expandedIds 记录已展开的提示词 id，默认全部收起（点击标题切换，降低信息密度）
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  // 记录高亮：保存/新增成功后对目标行打标记，flashAt 值变化触发行动画重放
  const [flashAt, setFlashAt] = useState<Record<string, number>>({});
  function dropReorder(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(''); setOverId(''); return; }
    const ids = sortedPrompts.map((x) => x.id); // T00494 修正：按显示顺序计算拖拽映射（此前用原始数组顺序，与界面所见不一致导致拖拽错乱）
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragId(''); setOverId('');
    void api.post('/prompts/reorder', { categoryId: activeCat, orderedIds: ids }).then(() => {
      flash('顺序已保存');
      void loadPrompts(activeCat, search);
    }).catch((e) => flash(String((e as Error).message ?? e)));
  }

  // T00463：条目拖拽排序状态
  const [dragId, setDragId] = useState('');
  // T00489：按住行 200ms 才缩放（快速点击/点行内按钮不触发）
  const [pressId, setPressId] = useState('');
  const pressTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({}); // NOSONAR - dragId 供 dropReorder 读取，setDragId 用于拖拽态重渲染
  const [overId, setOverId] = useState(''); // NOSONAR - overId 供列表行接入拖拽高亮后读取，setOverId 用于拖拽悬停态重渲染
  // T00873：移动提示词分组弹窗——moveTarget 记录待移动的提示词及弹窗内选好的目标归属（catId=目标分组，reqId=通用需求分类）；null 关闭
  const [moveTarget, setMoveTarget] = useState<{ p: Prompt; catId: string; reqId: string } | null>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  // T00636：加载 AI 整理工具（模型菜单默认配置优先）——提示词优化使用
  useEffect(() => {
    void api.get<Array<{ id: string; isDefaultOrganize?: boolean }>>('/aitools')
      .then((ts) => {
        const def = ts.find((t) => t.isDefaultOrganize) ?? ts[0];
        if (def) setOrganizeToolId(def.id);
      })
      .catch(() => undefined);
  }, []);

  /** T00636：提示词优化——把标题/内容交给 AI 改写为结构化提示词，结果回写草稿供确认后保存。
   *  与任务页「提示词优化」同款：内容为空时回退用标题作输入；结果剥离代码围栏。 */
  async function optimizeContent(key: string, title: string, content: string, apply: (v: string) => void) {
    if (optimizing[key]) return;
    if (!organizeToolId) return flash('请先在「模型菜单」添加并选择工具');
    let text = content.trim();
    const source = text ? '内容' : '标题';
    if (!text) text = title.trim();
    if (!text) return flash('请先填写标题或内容再优化');
    setOptimizing((p) => ({ ...p, [key]: true }));
    try {
      const r = await api.post<{ ok: boolean; content?: string; error?: string }>('/ai/optimize', {
        toolId: organizeToolId, title, description: text,
      });
      if (!r.ok) return flash(r.error ?? '优化失败');
      apply(stripFence(r.content ?? ''));
      flash(`提示词优化完成（输入来源：${source}），可编辑后保存`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setOptimizing((p) => { const n = { ...p }; delete n[key]; return n; });
    }
  }

  const loadCategories = useCallback(async () => {
    const cats = await api.get<PromptCategory[]>('/prompt-categories');
    setCategories(cats);
    // 保持当前选中；选中项被删除或首次加载时回落到第一个分类
    setActiveCat((cur) => (cats.some((c) => c.id === cur) ? cur : cats[0]?.id ?? ''));
  }, []);

  // T00837：拉取通用需求分类，供「调整分组」第二区选择（通用需求菜单分类变更后输入此处同步）
  const loadReqCats = useCallback(async () => {
    try { setReqCats(await api.get<ReqCategory[]>('/req-categories')); } catch { /* 忽略 */ }
  }, []);

  const loadPrompts = useCallback(async (categoryId: string, keyword: string) => {
    if (!categoryId) { setPrompts([]); return; }
    const qs = new URLSearchParams({ categoryId });
    if (keyword.trim()) qs.set('keyword', keyword.trim());
    setPrompts(await api.get<Prompt[]>(`/prompts?${qs.toString()}`));
  }, []);

  useEffect(() => { void loadCategories(); }, [loadCategories]);
  useEffect(() => { void loadReqCats(); }, [loadReqCats]);
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

  // T00525：删除改归档——数据保留，可后续恢复
  async function archivePrompt(p: Prompt) {
    if (!(await askConfirm(`归档提示词「${p.title}」？归档后列表不再显示（数据保留）。`))) return;
    try {
      await api.patch(`/prompts/${p.id}`, { archived: true });
      flash('已归档');
      void loadPrompts(activeCat, search);
      void loadCategories();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** T00629：复制到待办任务——支持**指定目标项目**（弹窗选择；不选则落默认记事项目/收件箱） */
  async function copyToTask(p: Prompt) {
    setTaskCopyPrompt(p);
    setTaskCopyProjectId('');
    try {
      setProjects(await api.get<Project[]>('/projects'));
    } catch { /* 项目列表加载失败时仍可用默认收件箱 */ }
  }

  /** T00629：确认复制到待办（目标项目可选） */
  async function confirmCopyToTask() {
    if (!taskCopyPrompt) return;
    const p = taskCopyPrompt;
    const targetName = taskCopyProjectId
      ? (projects.find((x) => x.id === taskCopyProjectId)?.name ?? '所选项目')
      : '默认记事项目（收件箱）';
    setTaskCopyBusy(true);
    try {
      const r = await api.post<{ ok: boolean; reused: boolean }>(`/prompts/${p.id}/to-task`,
        taskCopyProjectId ? { projectId: taskCopyProjectId } : {});
      flash(r.reused
        ? `目标项目已有同标题待办，已复用（${targetName}）`
        : `已复制「${p.title}」到待办任务（${targetName}）`);
      setTaskCopyPrompt(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskCopyBusy(false);
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

  /** T00873：打开「移动提示词」弹窗——预填当前目标分组与通用需求分类归属 */
  const openMove = (p: Prompt) => setMoveTarget({ p, catId: p.category_id, reqId: p.req_category_id ?? '' });

  /** T00873：确认移动——把提示词整体迁到目标分组（覆盖 category_id，原分组不再包含），并同步通用需求分类归属。
   *  只对实际变更的字段发 PATCH（避免无意义写库）；变更前记录撤销快照供 toolbar「撤销」还原。 */
  async function confirmMove() {
    const t = moveTarget;
    if (!t) return;
    const patch: Record<string, string> = {};
    if (t.catId !== t.p.category_id) patch.categoryId = t.catId;
    if (t.reqId !== (t.p.req_category_id ?? '')) patch.reqCategoryId = t.reqId;
    if (Object.keys(patch).length === 0) {
      // T00873 四轮：两份下拉都维持原值才算"无改动"。原文案「未选择变更项，未做改动」让"只想归入通用需求分类"
      // 的用户误以为被拦截——这里区分两种真实情形并给出可操作指引：
      // ① 已经归入所选分类（常见：卡片上看不到归属，用户以为没归入）→ 明说已归入；
      // ② 确实什么都没改 → 指明两个下拉各自的作用。
      const curReqName = t.reqId ? reqCats.find((c) => c.id === t.reqId)?.name : '';
      const curCatName = categories.find((c) => c.id === t.catId)?.name;
      if (t.reqId && t.reqId === (t.p.req_category_id ?? '')) {
        flash(`该提示词已归入通用需求分类「${curReqName ?? t.reqId}」，无需重复操作；如需换分类请选择其它项，如需换提示词分组请在上方「目标分组」中选择`);
      } else {
        flash(`提示词分组与通用需求分类均未改动 —— 换分组请用上方「目标分组」（当前「${curCatName ?? '未分类'}」），归入通用需求分类请用下方下拉后点「移动」`);
      }
      setMoveTarget(null);
      return;
    }
    const prev = { prevCategoryId: t.p.category_id, prevReqCategoryId: t.p.req_category_id ?? '' };
    setMoveTarget(null);
    try {
      await api.patch(`/prompts/${t.p.id}`, patch);
      setLastMove({ id: t.p.id, ...prev });
      void loadPrompts(activeCat, search);
      void loadCategories();
      // 反馈文案按实际变更项给出：只切通用需求分类时就提示通用需求归属，避免误导成"移动了提示词分组"
      const movedCat = patch.categoryId ? categories.find((c) => c.id === t.catId)?.name : undefined;
      const movedReq = patch.reqCategoryId ? reqCats.find((c) => c.id === t.reqId)?.name : undefined;
      if (movedCat && movedReq) flash(`已将「${t.p.title}」移动到「${movedCat}」并归入通用需求分类「${movedReq}」`);
      else if (movedReq) flash(`已将「${t.p.title}」归入通用需求分类「${movedReq}」（提示词分组保持不变）`);
      else if (movedCat) flash(`已移动至「${movedCat}」分组`);
      else flash('已更新该提示词的归属');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** T00837：撤销最近一次分组/通用需求分类调整，还原到调整前归属 */
  async function undoMove() {
    if (!lastMove) return;
    const patch: Record<string, string> = {};
    if (lastMove.prevCategoryId) patch.categoryId = lastMove.prevCategoryId;
    if (lastMove.prevReqCategoryId) patch.reqCategoryId = lastMove.prevReqCategoryId;
    try {
      await api.patch(`/prompts/${lastMove.id}`, patch);
      setLastMove(null);
      void loadPrompts(activeCat, search);
      void loadCategories();
      flash('已撤销最近一次分组调整');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  const activeCatObj = categories.find((c) => c.id === activeCat);

  // ---- 行级交互回调（S3776/S2004：从 JSX 内联箭头下沉到组件级，降低嵌套与复杂度） ----
  /** 长按行按压反馈：按下 200ms 记为 pressing（行内按钮/输入框不触发；统一用 pointer 事件，兼容触屏长按） */
  const startPress = (id: string, target: EventTarget | null) => {
    if ((target as HTMLElement).closest('button, input, select, a, textarea, label')) return;
    pressTimer.current[id] = globalThis.setTimeout(() => setPressId(id), 200);
  };
  const endPress = (id: string) => {
    clearTimeout(pressTimer.current[id]);
    if (pressId) setPressId('');
  };
  const endPressRow = (id: string) => {
    clearTimeout(pressTimer.current[id]);
    if (pressId === id) setPressId('');
  };
  const rowCls = (id: string) => {
    let cls = 'arena-row';
    if (flashAt[id]) cls += ' flush';
    if (dragId === id) cls += ' item-dragging';
    else if (overId === id) cls += ' item-over';
    if (pressId === id) cls += ' item-pressing';
    return cls;
  };
  /** 全部展开/收起（T00760 按钮回调下沉） */
  const allRowsExpanded = prompts.length > 0 && prompts.every((x) => expandedIds[x.id]);
  const toggleAllRows = () => setExpandedIds(allRowsExpanded ? {} : Object.fromEntries(prompts.map((x) => [x.id, true])));
  /** 编辑草稿字段更新（S3776：从 JSX 内联箭头下沉） */
  const patchDraft = (id: string, draft: { title: string; content: string; categoryId: string }, field: 'title' | 'content' | 'categoryId', v: string) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? draft), [field]: v } }));
  const cancelEdit = (id: string) => setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
  const startEdit = (p: Prompt) => setDrafts((prev) => ({ ...prev, [p.id]: { title: p.title, content: p.content, categoryId: p.category_id } }));
  const startPressFor = (id: string) => (e: React.PointerEvent) => startPress(id, e.target);
  const endPressFor = (id: string) => () => endPress(id);
  const endPressRowFor = (id: string) => () => endPressRow(id);
  const dragOverRowFor = (id: string) => (e: React.DragEvent) => dragOverRow(id, e);
  const dropRowFor = (id: string) => (e: React.DragEvent) => { e.preventDefault(); dropReorder(id); };
  const dragStartRow = (id: string, e: React.DragEvent) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; };
  const dragEndRow = () => { setDragId(''); setOverId(''); };
  const dragOverRow = (id: string, e: React.DragEvent) => { e.preventDefault(); if (id !== dragId) setOverId(id); };
  /** 提示词优化：结果回填当前编辑草稿（S2004：抽出避免 JSX 深层嵌套箭头） */
  const optimizeRow = (id: string, draft: { title: string; content: string; categoryId: string }) => {
    void optimizeContent(id, draft.title, draft.content, (v) => setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? draft), content: v } })));
  };
  const applyColor = (id: string, c: string) => {
    void api.patch(`/prompts/${id}`, { color: c }).then(() => { void loadPrompts(activeCat, search); });
  };

  /**
   * 依据当前排序条件对提示词排序（不改变原始 state）；置顶项始终排在最前。
   * T00873 四轮：先按「通用需求分类」过滤——让「归入通用需求分类」有可检索的落点。
   */
  let reqScopedPrompts: typeof prompts;
  if (reqFilter === '') {
    reqScopedPrompts = prompts;
  } else if (reqFilter === '__none__') {
    reqScopedPrompts = prompts.filter((p) => !p.req_category_id);
  } else {
    reqScopedPrompts = prompts.filter((p) => p.req_category_id === reqFilter);
  }
  const sortedPrompts = [...reqScopedPrompts].sort((a, b) => comparePrompts(a, b, sortKey, sortDir));
  let emptyListHint: string;
  if (categories.length === 0) {
    emptyListHint = '暂无分类，请先新建分类。';
  } else if (reqFilter === '') {
    emptyListHint = '该分类下暂无提示词。';
  } else {
    emptyListHint = '当前筛选条件下没有提示词 —— 可把「通用需求分类」筛选切回「全部通用需求分类」。';
  }
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
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.promptCount ?? 0}）</option>)}
        </select>
        {/* T00510 调整：分类管理三按钮与任务菜单项目按钮组同款——纯图标+边框、同组紧跟下拉、悬浮显示 */}
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => void addCategory()} title="新建分类 — 新增一个提示词分类" aria-label="新建分类：新增一个提示词分类"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}>
          <FolderPlus size={13} />
        </button>
        {activeCatObj && (
          <>
          <button onClick={() => void renameCategory(activeCatObj)}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer' }}
            title="重命名 — 修改当前分类名称" aria-label="重命名：修改当前分类名称">
            <SquarePen size={13} />
          </button>
          <button onClick={() => void removeCategory(activeCatObj)}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px', fontSize: 12, color: 'var(--danger)', background: 'transparent', border: '1px solid var(--danger)', borderRadius: 6, cursor: 'pointer' }}
            title="删除分类 — 删除当前分类及其下提示词" aria-label="删除分类：删除当前分类及其下提示词">
            <Trash2 size={13} />
          </button>
          </>
        )}
        </span>
        {activeCatObj && (
            <button className="tbtn-anim op-hidden" onClick={toggleAllRows} // T00760：默认隐藏悬浮显示
              title={allRowsExpanded ? '全部收起 — 收起全部提示词内容' : '全部展开 — 展开全部提示词内容'} aria-label="全部展开或收起提示词内容"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px', borderRadius: 6 }}>
              {allRowsExpanded ? <FoldVertical size={13} /> : <UnfoldVertical size={13} />}
            </button>
        )}
        <button
          onClick={() => { setCreating(!creating); setNewTitle(''); setNewContent(''); }}
          disabled={!activeCat}
          // 无文字纯图标按钮：悬浮提示随状态切换（新建/收起），点击动画由全局 button:active 提供
          // T00760：默认隐藏悬浮显示
          title={creating ? '收起 — 收起新建提示词表单' : '新建提示词 — 展开新建提示词表单'}
          aria-label={creating ? '收起：收起新建提示词表单' : '新建提示词：展开新建提示词表单'}
          className="op-hidden"
          style={{ marginLeft: 12, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', padding: '6px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
        >
          <Plus size={13} />
        </button>
        {/* T00837：撤销最近一次分组/通用需求分类调整（仅在有快照时显示） */}
        {lastMove && (
          <button onClick={() => void undoMove()} title="撤销 — 还原最近一次分组/通用需求分类调整" aria-label="撤销分组调整"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', fontSize: 12, background: 'var(--card-bg)', border: '1px solid var(--accent)', color: 'var(--accent)', borderRadius: 6, cursor: 'pointer' }}>
            <UnfoldVertical size={13} /> 撤销
          </button>
        )}
        {/* T00873 四轮：通用需求分类过滤——归入分类后可在此维度检索（T00837「组织与检索效率」）。
            仅在通用需求菜单确有分类时显示，避免空下拉占位 */}
        {reqCats.length > 0 && (
          <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <select
              value={reqFilter}
              onChange={(e) => setReqFilter(e.target.value)}
              title="通用需求分类筛选 — 按提示词归属的通用需求分类过滤列表"
              aria-label="通用需求分类筛选：按通用需求归属过滤提示词列表"
              style={{ padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)' }}
            >
              <option value="">全部通用需求分类</option>
              <option value="__none__">未归入</option>
              {reqCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </span>
        )}
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
          className="op-hidden" // T00760：默认隐藏悬浮显示
          style={{ padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, marginLeft: 'auto' }}
        />
        {notice && <output className="flash-toast">{notice}</output>}
      </div>

      {activeCatObj?.description && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{activeCatObj.description}</div>
      )}

      {/* 新建提示词表单 */}
      {creating && (
        <NewPromptForm newTitle={newTitle} setNewTitle={setNewTitle} newContent={newContent} setNewContent={setNewContent}
          createPrompt={createPrompt} optimizing={optimizing} optimizeContent={optimizeContent} setCreating={setCreating} />
      )}

      {/* 提示词列表 */}
      {sortedPrompts.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          {emptyListHint}
        </p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {sortedPrompts.map((p) => {
          const draft = drafts[p.id];
          const editing = draft !== undefined;
          return (
            <li key={`${flashAt[p.id] ?? ''}|${p.id}`}
              onPointerDown={startPressFor(p.id)}
              onPointerUp={endPressFor(p.id)}
              onPointerLeave={endPressRowFor(p.id)}
              draggable={sortKey === 'manual'}
              onDragStart={(e) => dragStartRow(p.id, e)}
              onDragEnd={dragEndRow}
              onDragOver={dragOverRowFor(p.id)}
              onDrop={dropRowFor(p.id)}
              className={rowCls(p.id)}
              style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10, cursor: 'grab' }}>
              {editing ? (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      value={draft.title}
                      onChange={(e) => patchDraft(p.id, draft, 'title', e.target.value)}
                      style={{ flex: 1, padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 14 }}
                    />
                    <select
                      value={draft.categoryId}
                      onChange={(e) => patchDraft(p.id, draft, 'categoryId', e.target.value)}
                      style={{ padding: 6 }}
                    >
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <textarea
                    value={draft.content}
                    onChange={(e) => patchDraft(p.id, draft, 'content', e.target.value)}
                    rows={6}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' }}
                  />
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button onClick={() => void saveDraft(p)} disabled={!draft.title.trim()} style={{ fontSize: 12, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="保存 — 保存对这条提示词的修改" aria-label="保存：保存对这条提示词的修改">
                      <Save size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    {/* T00636：提示词优化（与任务页同款）——置于保存按钮旁，结果回填当前编辑草稿 */}
                    <PromptOptimizeButton busy={Boolean(optimizing[p.id])} onClick={() => optimizeRow(p.id, draft)} />
                    <button onClick={() => cancelEdit(p.id)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }} title="取消 — 放弃编辑修改"
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
                      title={expandedIds[p.id] ? '点击收起提示词内容' : '点击展开提示词内容'}
                      aria-label={expandedIds[p.id] ? '收起：收起提示词内容' : '展开：展开提示词内容'}
                      className="row-title-btn"
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', minWidth: 0 }}
                    >
                      <PinToggle pinned={Boolean(p.pinned)} onToggle={() => void togglePin(p)} />
                      <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: p.color || undefined }}>{p.title}</span>
                      {/* 展开/收起箭头：与任务页统一使用 lucide 图标，蓝色 13px */}
                      <span style={{ color: 'var(--accent)', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>{expandedIds[p.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
                    </button>
                    <span className="abtn" style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }} title={`更新于 ${p.updated_at}`}>{relTime(p.updated_at)}</span>
                    {/* T00873 四轮：通用需求归属徽标——此前归属只存在于弹窗下拉里，卡片上完全看不到，
                        用户"归入后无任何变化"、也看不出是否已归入（误判为被拦截的直接诱因） */}
                    {p.req_category_id && (
                      <span className="abtn" title={`通用需求归属：${reqCats.find((c) => c.id === p.req_category_id)?.name ?? p.req_category_id}`}
                        style={{ fontSize: 11, flexShrink: 0, padding: '1px 6px', borderRadius: 10, border: '1px solid var(--accent)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Layers size={11} />{reqCats.find((c) => c.id === p.req_category_id)?.name ?? '通用需求分类'}
                      </span>
                    )}
                    <span className="abtn" style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <FontColorButton current={p.color ?? ''} onApply={(c) => applyColor(p.id, c)} />
                    </span>
                    <CopyButton getText={() => p.title + (p.content ? '\n' + p.content : '')} title="复制 — 复制提示词内容到剪贴板" ariaLabel="复制：复制提示词内容" />
                    {/* T00436：复制到待办任务 — 转成收件箱项目的待办，悬浮提示按任务规格 */}
                    <button className="abtn" onClick={() => void copyToTask(p)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="复制到待办任务 — 以该提示词创建一条待办任务（收件箱项目）" aria-label="复制到待办任务">
                      <ListTodo size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    <button
                      className="abtn"
                      onClick={() => startEdit(p)}
                      style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="编辑 — 编辑这条提示词" aria-label="编辑：编辑这条提示词"
                    >
                      <Pencil size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    {/* T00873：移动到其他分组——整体迁移（覆盖 category_id，原分组不再包含）；点击打开移动弹窗 */}
                    <button className="abtn" onClick={() => openMove(p)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="移动 — 将该提示词整体移动到其他提示词分组（原分组不再包含）" aria-label="移动：将该提示词整体移动到其他分组">
                      <Move size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                    </button>
                    <button className="abtn" onClick={() => void archivePrompt(p)} style={{ fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                      title="归档 — 归档这条提示词（数据保留，列表不再显示）" aria-label="归档：归档这条提示词">
                      <Archive size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
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

      {/* T00629：复制到待办任务——目标项目选择弹窗（不选则落默认记事项目/收件箱） */}
      {taskCopyPrompt && (
        <TaskCopyModal taskCopyPrompt={taskCopyPrompt} taskCopyBusy={taskCopyBusy} setTaskCopyPrompt={setTaskCopyPrompt}
          taskCopyProjectId={taskCopyProjectId} setTaskCopyProjectId={setTaskCopyProjectId}
          projects={projects} confirmCopyToTask={confirmCopyToTask} />
      )}

      {/* T00873：移动提示词分组弹窗（目标分组 + 通用需求分类归属；取消/移动确认） */}
      {moveTarget && (
        <MovePromptModal p={moveTarget.p} categories={categories} reqCats={reqCats} catId={moveTarget.catId} reqId={moveTarget.reqId}
          setCatId={(v) => setMoveTarget((t) => (t ? { ...t, catId: v } : t))}
          setReqId={(v) => setMoveTarget((t) => (t ? { ...t, reqId: v } : t))}
          onCancel={() => setMoveTarget(null)} onConfirm={() => void confirmMove()} />
      )}
    </section>
  );
}
