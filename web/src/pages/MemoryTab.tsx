import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Link2, List as ListIcon, Brain, Network, Pencil, Plus, Save, Tag, Trash2, Undo2, X } from 'lucide-react';
import { api } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { HoverCard } from '../ui/HoverCard';
import { SettingsHelpIcon } from '../ui/settingsHelp'; // T06019：子页说明文字改为语义图标
import { useSessionState } from '../ui/session'; // T05790：图谱/列表视图与产品选择跨页面保持
import { MemoryGraph } from './MemoryGraph';

/**
 * T04152（PRD MEM-501/502）：设置 → 数据 →「记忆管理」页签。
 *
 * 顶层维度是产品标签（product_key）：每页只展示一个产品的记忆，天然满足 MEM-503 的隔离可见性；
 * 产品切换即清空筛选，避免「上一个产品的筛选条件套到新产品」这种跨产品错觉。
 * 类型枚举与中文名与 server/src/util/memoryTypes.ts 保持同值（前端不能跨包 import，改动需两处同步）。
 */

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];
const TYPE_LABELS: Record<MemoryType, string> = {
  user: '用户偏好', feedback: '反馈纠正', project: '项目事实', reference: '外部参考',
};

// T06071：与 server/src/util/memoryLayers.ts 同值；前端不能跨包 import，改动需两处同步
const MEMORY_KINDS = ['semantic', 'episodic', 'procedural'] as const;
type MemoryKind = (typeof MEMORY_KINDS)[number];
const KIND_LABELS: Record<MemoryKind, string> = { semantic: '语义', episodic: '情景', procedural: '程序' };
const MEMORY_SCOPES = ['product', 'project', 'task'] as const;
type MemoryScope = (typeof MEMORY_SCOPES)[number];
const SCOPE_LABELS: Record<MemoryScope, string> = { product: '产品级', project: '项目级', task: '任务级' };
const MEMORY_AUTHORITIES = ['user', 'system', 'tool', 'inferred', 'external'] as const;
type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];
const AUTHORITY_LABELS: Record<MemoryAuthority, string> = {
  user: '用户', system: '系统', tool: '工具', inferred: '推断', external: '外部',
};

interface ProductTag { productKey: string; projectCount: number; memoryCount: number }
interface MemoryCoverage { total: number; zeroAccess: number; zeroAccessPct: number; expired: number; invalidated: number }
interface ProductProject { id: string; name: string; memory_auto_extract: number }
interface PendingRow {
  id: string; title: string; content: string; type: MemoryType;
  pii_kind: string | null; created_at: string;
}
interface OrphanTag { productKey: string; memoryCount: number }
interface SimpleProject { id: string; name: string }
interface MemoryRow {
  id: string;
  product_key: string;
  project_id: string | null;
  type: MemoryType;
  title: string;
  content: string;
  tags: string | null;
  source_task_id: string | null;
  source_kind: string;
  memory_kind?: MemoryKind;
  scope?: MemoryScope;
  authority?: MemoryAuthority;
  valid_at?: string | null;
  invalid_at?: string | null;
  expired_at?: string | null;
  revision?: number;
  invalidated_reason?: string | null;
  confidence: number | null;
  access_count: number;
  created_at: string;
  updated_at: string;
  need_review: boolean;
  invalidated_at?: string | null;
  superseded_by?: string | null;
}

const cell: React.CSSProperties = {
  padding: '8px 8px', borderBottom: '1px solid var(--surface-2)', fontSize: 'var(--fs-s)',
  verticalAlign: 'middle', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const th: React.CSSProperties = {
  padding: '8px 8px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-s)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const inputStyle: React.CSSProperties = {
  padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)',
  borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)',
};
const iconBtnStyle: React.CSSProperties = {
  width: 28, height: 28, minWidth: 28, padding: 0, border: '1px solid var(--border-strong)',
  borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text-secondary)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};
const truncateStyle: React.CSSProperties = {
  display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

type IconTone = 'default' | 'accent' | 'danger';

/**
 * T05765：记忆管理页统一图标按钮。
 * 图标全部来自开源 lucide-react（不自绘 SVG），Tooltip 走系统既有 HoverCard（Portal + Esc/滚动收起），
 * 不复用原生 title，避免与页面其它提示浮层样式冲突。
 */
function IconButton({
  action, label, hint, icon, onClick, disabled = false, tone = 'default', pressed,
}: {
  action: string;
  label: string;
  hint: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: IconTone;
  pressed?: boolean;
}) {
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'accent' ? 'var(--accent)' : 'var(--text-secondary)';
  const activeStyle: CSSProperties = pressed
    ? { background: 'var(--accent)', color: 'var(--accent-text)', borderColor: 'var(--accent)' }
    : {};
  return (
    <HoverCard card={`${label} | ${hint}`} ariaLabel={`${label}：${hint}`} openDelay={120} cardW={280} cardH={52}>
      <button
        type="button"
        className="memory-icon-btn"
        data-lck="memory-icon-btn"
        data-action={action}
        aria-label={`${label} | ${hint}`}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        style={{ ...iconBtnStyle, color, ...activeStyle }}
      >
        {icon}
      </button>
    </HoverCard>
  );
}

/** T05765：单行截断 + 悬浮显示完整原文；只有文本内容走 HoverCard，表格行本身不被包裹。 */
function CellText({ text, empty = '—', cardW = 420 }: { text?: string | null; empty?: string; cardW?: number }) {
  const full = text && text.trim() ? text : empty;
  return (
    <HoverCard card={full} ariaLabel="完整内容" openDelay={160} cardW={cardW} cardH={72} style={{ display: 'block', width: '100%' }}>
      <span style={truncateStyle}>{full}</span>
    </HoverCard>
  );
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

function brief(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function MemoryTab() {
  const [tags, setTags] = useState<ProductTag[]>([]);
  // T05790：产品选择与列表/图谱视图写入 sessionStorage——切设置页签或顶层页面再回来时保持原视图与产品，
  // 否则重新挂载会回到首产品 + 列表，看起来像“状态保持未生效”。
  const [productKey, setProductKey] = useSessionState<string>('mtask.memoryTab.productKey', '');
  const [type, setType] = useState<'' | MemoryType>('');
  const [kind, setKind] = useState<'' | MemoryKind>('');
  const [authority, setAuthority] = useState<'' | MemoryAuthority>('');
  const [keyword, setKeyword] = useState('');
  const [includeInvalidated, setIncludeInvalidated] = useState(false);
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [coverage, setCoverage] = useState<MemoryCoverage | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  // MEM-503/504：本产品下的项目（自动抽取开关）与待确认队列
  const [projects, setProjects] = useState<ProductProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [pending, setPending] = useState<PendingRow[]>([]);
  // MEM-505/107/108：标签维护（重命名 / 孤儿标签清理与挂回）
  const [orphans, setOrphans] = useState<OrphanTag[]>([]);
  const [allProjects, setAllProjects] = useState<SimpleProject[]>([]);
  const [reattachTarget, setReattachTarget] = useState<Record<string, string>>({});
  // 新增表单
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newType, setNewType] = useState<MemoryType>('project');
  const [newTags, setNewTags] = useState('');
  // 行内编辑：同时只编辑一条，避免多行草稿状态互相覆盖
  const [editing, setEditing] = useState<{ id: string; type: MemoryType; kind: MemoryKind; authority: MemoryAuthority; title: string; content: string; tags: string } | null>(null);
  // T05738：视图切换——列表（管理/编辑）与图谱（关系可视化）共用同一份产品筛选
  const [viewMode, setViewMode] = useSessionState<'list' | 'graph'>('mtask.memoryTab.viewMode', 'list');

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  const loadTags = useCallback(async () => {
    try {
      const list = await api.get<ProductTag[]>('/memories/product-tags');
      setTags(list);
      setProductKey((cur) => (list.some((t) => t.productKey === cur) ? cur : (list[0]?.productKey || '')));
    } catch { /* 标签清单失败不阻塞页面 */ }
  }, []);

  const loadRows = useCallback(async () => {
    if (!productKey) { setRows([]); setTotal(0); return; }
    setLoading(true);
    try {
      const q = new URLSearchParams({ productKey, limit: '100' });
      if (type) q.set('type', type);
      if (kind) q.set('memoryKind', kind);
      if (authority) q.set('authority', authority);
      if (keyword.trim()) q.set('query', keyword.trim());
      if (includeInvalidated) q.set('includeInvalidated', '1');
      const r = await api.get<{ total: number; memories: MemoryRow[] }>(`/memories?${q.toString()}`);
      setRows(r.memories ?? []);
      setTotal(r.total ?? 0);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [productKey, type, kind, authority, keyword, includeInvalidated]);

  // T06071：产品级 zero-access 评估只读展示；筛选不影响口径，避免把筛后列表当成全量健康度。
  const loadCoverage = useCallback(async () => {
    if (!productKey) { setCoverage(null); return; }
    try {
      const q = new URLSearchParams({ productKey });
      const r = await api.get<{ coverage: MemoryCoverage | null }>(`/memories/coverage?${q.toString()}`);
      setCoverage(r.coverage);
    } catch { setCoverage(null); }
  }, [productKey]);

  // MEM-503/504：只列本产品标签下的项目——跨产品项目不出现在下拉里，从入口上杜绝越权操作
  const loadProjects = useCallback(async () => {
    if (!productKey) { setProjects([]); setSelectedProjectId(''); return; }
    try {
      const r = await api.get<{ projects: ProductProject[] }>(`/memories/projects?productKey=${encodeURIComponent(productKey)}`);
      const list = r.projects ?? [];
      setProjects(list);
      setSelectedProjectId((cur) => (list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? '')));
    } catch { /* 项目清单失败不影响记忆列表 */ }
  }, [productKey]);

  const loadPending = useCallback(async () => {
    if (!productKey) { setPending([]); return; }
    try {
      const r = await api.get<{ memories: PendingRow[] }>(`/memories/pending?productKey=${encodeURIComponent(productKey)}`);
      setPending(r.memories ?? []);
    } catch { /* 待确认队列失败不阻塞页面 */ }
  }, [productKey]);

  /** 孤儿标签：已无项目引用但仍有记忆（MEM-108），可清理或挂回某项目 */
  const loadOrphans = useCallback(async () => {
    try {
      const r = await api.get<{ orphans: OrphanTag[] }>('/memories/product-tags/orphans');
      setOrphans(r.orphans ?? []);
    } catch { /* 孤儿清单失败不阻塞主页 */ }
  }, []);

  const loadAllProjects = useCallback(async () => {
    try {
      const list = await api.get<SimpleProject[]>('/projects');
      setAllProjects((list ?? []).map((p) => ({ id: p.id, name: p.name })));
    } catch { /* 挂回下拉降级为空 */ }
  }, []);

  useEffect(() => { void loadTags(); }, [loadTags]);
  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => { void loadCoverage(); }, [loadCoverage]);
  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadPending(); }, [loadPending]);
  useEffect(() => { void loadOrphans(); }, [loadOrphans]);
  useEffect(() => { void loadAllProjects(); }, [loadAllProjects]);
  // T04171（F11）：订阅记忆变更——MCP/Agent 写入、容量淘汰、月度整理后管理页即时刷新
  useEffect(() => api.openChangeStream((kind) => {
    if (kind !== 'memories') return;
    void loadRows();
    void loadPending();
    void loadCoverage();
    void loadTags();
    void loadOrphans();
  }), [loadRows, loadPending, loadCoverage, loadTags, loadOrphans]);

  /** MEM-107/F10：重命名（同事务三表齐改；新名已存在时为合并，后端会回 mergedIntoExisting） */
  async function renameTag(oldKey: string) {
    const next = await askInput({
      title: `重命名产品标签「${oldKey}」`,
      placeholder: '新标签名（留空不可；重命名到已有标签＝合并）',
      defaultValue: oldKey,
    });
    if (next === null) return;
    try {
      const r = await api.post<{ mergedIntoExisting: boolean; projectsUpdated: number; memoriesUpdated: number }>(
        '/memories/product-tags/rename', { oldKey, newKey: next },
      );
      flash(r.mergedIntoExisting
        ? `已合并到「${next.trim().toLowerCase()}」（项目 ${r.projectsUpdated} / 记忆 ${r.memoriesUpdated}）`
        : `已重命名（项目 ${r.projectsUpdated} / 记忆 ${r.memoriesUpdated}）`);
      if (productKey === oldKey) setProductKey(next.trim().toLowerCase());
      await Promise.all([loadTags(), loadRows(), loadOrphans(), loadProjects(), loadPending()]);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** MEM-108：清理孤儿标签下的全部记忆（仅对确无项目引用的标签放行，后端二次校验） */
  async function cleanupOrphan(key: string, count: number) {
    if (!await askConfirm(`清理孤立标签「${key}」下的 ${count} 条记忆？此操作不可恢复。`)) return;
    try {
      const r = await api.del<{ deleted: number }>(`/memories/product-tags/${encodeURIComponent(key)}`);
      flash(`已清理 ${r.deleted} 条记忆`);
      await Promise.all([loadTags(), loadRows(), loadOrphans()]);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** MEM-108：把孤儿标签挂回某个项目（目标项目已绑其它标签时后端会拒绝） */
  async function reattachOrphan(key: string) {
    const pid = reattachTarget[key];
    if (!pid) return flash('请选择要挂回的项目');
    try {
      await api.post(`/memories/product-tags/${encodeURIComponent(key)}/reattach`, { projectId: pid });
      flash(`已挂回项目`);
      await Promise.all([loadTags(), loadOrphans(), loadProjects()]);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** MEM-504：项目级自动抽取开关（跨产品由后端 403 兜底，前端只列本产品项目） */
  async function toggleAutoExtract(proj: ProductProject) {
    try {
      const r = await api.patch<{ enabled: boolean }>(`/memories/projects/${proj.id}`, {
        productKey, enabled: proj.memory_auto_extract === 0,
      });
      setProjects((list) => list.map((p) => (p.id === proj.id ? { ...p, memory_auto_extract: r.enabled ? 1 : 0 } : p)));
      flash(`「${proj.name}」自动抽取已${r.enabled ? '开启' : '关闭'}`);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** MEM-209/504：待确认候选的确认/驳回（确认才写 memories） */
  async function resolvePending(id: string, action: 'confirm' | 'reject') {
    try {
      await api.post(`/memories/pending/${id}/${action}`, { productKey });
      flash(action === 'confirm' ? '已确认入库' : '已驳回并删除候选');
      await Promise.all([loadPending(), loadRows(), loadTags()]);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function createMemory() {
    if (!productKey) return flash('请先选择产品标签');
    if (!newTitle.trim() || !newContent.trim()) return flash('标题与内容不能为空');
    try {
      const r = await api.post<{ ok: boolean; queued?: boolean }>('/memories', {
        productKey, type: newType, title: newTitle, content: newContent,
        tags: newTags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      });
      if (r.queued) flash('内容疑似个人敏感，已转「待确认」队列，不会自动入库');
      else flash('已保存');
      setNewTitle(''); setNewContent(''); setNewTags('');
      await Promise.all([loadRows(), loadTags()]);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editing.title.trim() || !editing.content.trim()) return flash('标题与内容不能为空');
    try {
      await api.patch(`/memories/${editing.id}`, {
        productKey, type: editing.type, memoryKind: editing.kind, authority: editing.authority,
        title: editing.title, content: editing.content,
        tags: editing.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      });
      flash('已更新');
      setEditing(null);
      await loadRows();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function removeMemory(row: MemoryRow) {
    if (!await askConfirm(`删除记忆「${row.title}」？此操作不可恢复。`)) return;
    try {
      await api.del(`/memories/${row.id}?productKey=${encodeURIComponent(productKey)}`);
      flash('已删除');
      await Promise.all([loadRows(), loadTags()]);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="memory-admin-page" style={{ maxWidth: 1180 }}>
      <style>{`
        .memory-admin-page .memory-icon-btn {
          transition: transform .18s ease, box-shadow .18s ease, background .18s ease, color .18s ease;
        }
        .memory-admin-page .memory-icon-btn:hover:not(:disabled) {
          transform: perspective(420px) rotateX(-8deg) rotateY(8deg) scale(1.08);
          box-shadow: 0 6px 14px var(--overlay);
        }
        .memory-admin-page .memory-icon-btn:active:not(:disabled) {
          transform: perspective(420px) rotateX(0deg) rotateY(0deg) scale(.94);
        }
        .memory-admin-page .memory-icon-btn:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 2px;
        }
        .memory-admin-page .memory-icon-btn:disabled { cursor: not-allowed; opacity: .45; }
        .memory-table th, .memory-table td { white-space: nowrap; }
        .memory-cell-text { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>
      <div style={{ marginBottom: 12 }}>
        <SettingsHelpIcon
          icon={Brain}
          label="记忆管理"
          ariaDescription="产品维度的 AI 长期记忆：同一产品下的多期项目共享记忆池，跨产品严格隔离。"
          description={<>产品维度的 AI 长期记忆：同一产品下的多期项目共享记忆池，跨产品严格隔离。{productKey && <span> <b>本页记忆仅属于产品「{productKey}」</b>，其它产品的记忆不会出现在此处。</span>}</>}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {/* T05738：视图切换——列表管编辑、图谱看关系，产品筛选两视图共享；T05765：改为图标按钮 */}
        <span role="group" aria-label="记忆视图切换" style={{ display: 'inline-flex', gap: 2, border: '1px solid var(--border-strong)', borderRadius: 6, padding: 2 }}>
          <IconButton action="view-list" label="列表" hint="以表格方式查看和编辑记忆" icon={<ListIcon size={15} />}
            pressed={viewMode === 'list'} onClick={() => setViewMode('list')} />
          <IconButton action="view-graph" label="图谱" hint="以关系图查看记忆与任务、项目的关联" icon={<Network size={15} />}
            pressed={viewMode === 'graph'} onClick={() => setViewMode('graph')} />
        </span>
        <select aria-label="产品标签" value={productKey}
          onChange={(e) => { setProductKey(e.target.value); setEditing(null); }}
          style={{ ...inputStyle, minWidth: 180 }}>
          {tags.length === 0 && <option value="">暂无产品标签</option>}
          {tags.map((t) => (
            <option key={t.productKey} value={t.productKey}>{t.productKey}（记忆 {t.memoryCount}）</option>
          ))}
        </select>
        {productKey && <IconButton action="rename-product-tag" label="重命名标签" hint="修改当前产品标签名称，目标已存在时合并"
          icon={<Tag size={15} />} onClick={() => void renameTag(productKey)} />}
        {viewMode === 'list' && (
          <>
            <select aria-label="记忆类型筛选" value={type} onChange={(e) => setType(e.target.value as '' | MemoryType)} style={inputStyle}>
              <option value="">全部类型</option>
              {MEMORY_TYPES.map((k) => <option key={k} value={k}>{TYPE_LABELS[k]}</option>)}
            </select>
            <select aria-label="记忆分层筛选" value={kind} onChange={(e) => setKind(e.target.value as '' | MemoryKind)} style={inputStyle}>
              <option value="">全部分层</option>
              {MEMORY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
            <select aria-label="记忆权威筛选" value={authority} onChange={(e) => setAuthority(e.target.value as '' | MemoryAuthority)} style={inputStyle}>
              <option value="">全部权威</option>
              {MEMORY_AUTHORITIES.map((k) => <option key={k} value={k}>{AUTHORITY_LABELS[k]}</option>)}
            </select>
            <input aria-label="关键词筛选" value={keyword} onChange={(e) => setKeyword(e.target.value)}
              placeholder="标题/内容关键词" style={{ ...inputStyle, minWidth: 200 }} />
            <label style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={includeInvalidated} onChange={(e) => setIncludeInvalidated(e.target.checked)} />
              含已失效
            </label>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{loading ? '加载中…' : `共 ${total} 条`}</span>
            {coverage && (
              <span title="产品内有效记忆的零访问评估；不随上方筛选变化"
                style={{ fontSize: 'var(--fs-xs)', color: coverage.zeroAccessPct > 30 ? 'var(--warning, #d97706)' : 'var(--text-muted)' }}>
                零访问 {coverage.zeroAccess}/{coverage.total}（{coverage.zeroAccessPct}%）
                {coverage.expired ? ` · 到期 ${coverage.expired}` : ''}
              </span>
            )}
          </>
        )}
      </div>
      {notice && <div style={{ marginBottom: 10, fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{notice}</div>}

      {/* T05738：图谱视图——力导向关系图（tag 共享/替代链/项目聚簇），编辑仍回列表视图 */}
      {viewMode === 'graph' && <MemoryGraph productKey={productKey} />}
      {viewMode === 'graph' && (
        <div style={{ marginTop: 16, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          图谱为只读视图；新增/编辑/删除请切回「列表」视图。
        </div>
      )}

      {/* 列表视图主体（自动抽取 / 待确认 / 新增 / 表格 / 孤立标签） */}
      {viewMode === 'list' && (<>
      {/* MEM-504：项目级自动抽取开关（只列本产品项目，跨产品入口不存在） */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', fontSize: 'var(--fs-s)' }}>
        <span style={{ color: 'var(--text-secondary)' }}>自动抽取（项目级）：</span>
        {projects.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>本产品暂无绑定项目</span>
        ) : (
          <>
            <select aria-label="自动抽取项目" value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)} style={inputStyle}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {(() => {
              const cur = projects.find((p) => p.id === selectedProjectId);
              return (
                <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={cur?.memory_auto_extract === 1} disabled={!cur}
                    onChange={() => { if (cur) void toggleAutoExtract(cur); }} />
                  {cur?.memory_auto_extract === 1 ? '自动抽取已开启' : '自动抽取已关闭'}
                </label>
              );
            })()}
          </>
        )}
      </div>

      {/* MEM-209/504：待确认队列——疑似个人敏感内容，确认后才入库 */}
      {pending.length > 0 && (
        <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: 12, marginBottom: 14, background: 'var(--accent-soft)' }}>
          <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 8 }}>
            待确认（{pending.length} 条疑似个人敏感内容，不会自动入库）
          </div>
          {pending.map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--surface-2)' }}>
              <div style={{ flex: 1, fontSize: 'var(--fs-s)' }}>
                <b>{p.title}</b>
                <span style={{ marginLeft: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                  {TYPE_LABELS[p.type] ?? p.type} · {p.pii_kind ?? '敏感'}
                </span>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{brief(p.content, 90)}</div>
              </div>
              <IconButton action="pending-confirm" label="确认入库" hint="把该候选写入长期记忆" tone="accent"
                icon={<Check size={15} />} onClick={() => void resolvePending(p.id, 'confirm')} />
              <IconButton action="pending-reject" label="驳回" hint="删除该候选，不写入记忆库" tone="danger"
                icon={<X size={15} />} onClick={() => void resolvePending(p.id, 'reject')} />
            </div>
          ))}
        </div>
      )}

      {/* 新增 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, alignItems: 'flex-start' }}>
        <select aria-label="新记忆类型" value={newType} onChange={(e) => setNewType(e.target.value as MemoryType)} style={inputStyle}>
          {MEMORY_TYPES.map((k) => <option key={k} value={k}>{TYPE_LABELS[k]}</option>)}
        </select>
        <input aria-label="新记忆标题" value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
          placeholder="标题（一句话结论）" style={{ ...inputStyle, minWidth: 220 }} />
        <input aria-label="新记忆内容" value={newContent} onChange={(e) => setNewContent(e.target.value)}
          placeholder="内容（声明式事实，≤400 字）" style={{ ...inputStyle, flex: 1, minWidth: 260 }} />
        <input aria-label="新记忆标签" value={newTags} onChange={(e) => setNewTags(e.target.value)}
          placeholder="标签，逗号分隔" style={{ ...inputStyle, width: 160 }} />
        <IconButton action="memory-create" label="新增记忆" hint="将标题、内容与标签保存为当前产品记忆" tone="accent"
          icon={<Plus size={15} />} disabled={!productKey} onClick={() => void createMemory()} />
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>
          {productKey ? '该产品暂无记忆（或筛选无命中）。' : '请先在项目上绑定产品标签，记忆才会有归属产品。'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
        <table className="memory-table" style={{ width: '100%', minWidth: 1100, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 100 }} />
            <col style={{ width: 300 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 116 }} />
            <col style={{ width: 160 }} />
            <col style={{ width: 66 }} />
            <col style={{ width: 138 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 'var(--fs-s)' }}>
              <th style={th}>类型</th>
              <th style={th}>标题 / 内容</th>
              <th style={th}>标签</th>
              <th style={th}>作用域</th>
              <th style={th}>来源 / 溯源</th>
              <th style={th}>访问</th>
              <th style={th}>更新时间</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => editing?.id === r.id ? (
              <tr key={r.id}>
                <td style={cell}>
                  <select aria-label="编辑类型" value={editing.type}
                    onChange={(e) => setEditing({ ...editing, type: e.target.value as MemoryType })} style={{ ...inputStyle, width: '100%', marginBottom: 4 }}>
                    {MEMORY_TYPES.map((k) => <option key={k} value={k}>{TYPE_LABELS[k]}</option>)}
                  </select>
                  <select aria-label="编辑分层" value={editing.kind}
                    onChange={(e) => setEditing({ ...editing, kind: e.target.value as MemoryKind })} style={{ ...inputStyle, width: '100%', marginBottom: 4 }}>
                    {MEMORY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </select>
                  <select aria-label="编辑权威" value={editing.authority}
                    onChange={(e) => setEditing({ ...editing, authority: e.target.value as MemoryAuthority })} style={{ ...inputStyle, width: '100%' }}>
                    {MEMORY_AUTHORITIES.map((k) => <option key={k} value={k}>{AUTHORITY_LABELS[k]}</option>)}
                  </select>
                </td>
                <td style={cell}>
                  <input aria-label="编辑标题" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                    style={{ ...inputStyle, width: '100%', marginBottom: 4 }} />
                  <textarea aria-label="编辑内容" value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                    rows={2} style={{ ...inputStyle, width: '100%' }} />
                </td>
                <td style={cell}>
                  <input aria-label="编辑标签" value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
                    placeholder="逗号分隔" style={{ ...inputStyle, width: '100%' }} />
                </td>
                <td style={cell} colSpan={4}>{r.project_id ? '本期特有' : '产品级共享'}</td>
                <td style={cell}>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <IconButton action="memory-save" label="保存" hint="保存本行修改" icon={<Save size={15} />} tone="accent"
                      onClick={() => void saveEdit()} />
                    <IconButton action="memory-edit-cancel" label="取消" hint="放弃本行修改" icon={<Undo2 size={15} />}
                      onClick={() => setEditing(null)} />
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={r.id} style={{ opacity: r.invalidated_at || r.expired_at ? 0.55 : 1 }}>
                <td style={cell}>
                  <div>{TYPE_LABELS[r.type] ?? r.type}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                    {KIND_LABELS[r.memory_kind ?? 'semantic']} · {AUTHORITY_LABELS[r.authority ?? 'system']}
                  </div>
                </td>
                <td style={cell}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, color: 'var(--text)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}><CellText text={r.title} cardW={420} /></div>
                    {r.need_review && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--warning, #d97706)' }}>需复核</span>}
                    {r.invalidated_at && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>已失效{r.superseded_by ? `（${r.superseded_by}）` : ''}</span>}
                    {!r.invalidated_at && r.expired_at && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--warning, #d97706)' }}>已到期</span>}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                    <CellText text={r.content} cardW={480} />
                  </div>
                </td>
                <td style={cell}><CellText text={parseTags(r.tags).join('、')} cardW={280} /></td>
                <td style={cell}>
                  <div>{SCOPE_LABELS[r.scope ?? (r.project_id ? 'project' : 'product')]}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>v{r.revision ?? 1}{r.invalidated_reason ? ` · ${r.invalidated_reason}` : ''}{!r.invalidated_reason && r.expired_at ? ' · expired' : ''}</div>
                </td>
                <td style={cell}><CellText text={`${r.source_task_id ?? '—'} · ${r.source_kind}`} cardW={320} /></td>
                <td style={cell}>{r.access_count}</td>
                <td style={cell}><CellText text={r.updated_at.slice(0, 16).replace('T', ' ')} empty="—" cardW={220} /></td>
                <td style={cell}>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <IconButton action="memory-edit" label="编辑" hint="在表格内修改这条记忆的类型、标题和内容"
                      icon={<Pencil size={15} />} onClick={() => setEditing({
                        id: r.id, type: r.type, kind: r.memory_kind ?? 'semantic',
                        authority: r.authority ?? 'system',
                        title: r.title, content: r.content, tags: parseTags(r.tags).join(','),
                      })} />
                    <IconButton action="memory-delete" label="删除" hint="移除该条记忆记录，此操作不可恢复" tone="danger"
                      icon={<Trash2 size={15} />} onClick={() => void removeMemory(r)} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* MEM-505/108：孤立标签维护——已无项目引用但仍有记忆，可挂回项目或清理 */}
      <div style={{ marginTop: 22, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, marginBottom: 6 }}>孤立标签</div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>
          项目已删除或改绑后，仍留有记忆但没有项目引用的产品标签。挂回会让目标项目绑定该标签；清理会删除这些记忆且不可恢复。
        </div>
        {orphans.length === 0 ? (
          <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>无孤立标签</div>
        ) : orphans.map((o) => (
          <div key={o.productKey} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 'var(--fs-s)', flexWrap: 'wrap' }}>
            <span style={{ minWidth: 170 }}>{o.productKey}（{o.memoryCount} 条记忆，无项目绑定）</span>
            <select aria-label={`挂回 ${o.productKey} 的项目`} value={reattachTarget[o.productKey] ?? ''}
              onChange={(e) => setReattachTarget({ ...reattachTarget, [o.productKey]: e.target.value })} style={inputStyle}>
              <option value="">选择要挂回的项目</option>
              {allProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <IconButton action="orphan-reattach" label="挂回" hint="把该孤立标签重新挂到选中的项目"
              icon={<Link2 size={15} />} onClick={() => void reattachOrphan(o.productKey)} />
            <IconButton action="orphan-cleanup" label="清理" hint="删除该孤立标签下的全部记忆，不可恢复" tone="danger"
              icon={<Trash2 size={15} />} onClick={() => void cleanupOrphan(o.productKey, o.memoryCount)} />
          </div>
        ))}
      </div>
      </>)}
    </div>
  );
}
