import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';

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

interface ProductTag { productKey: string; projectCount: number; memoryCount: number }
interface ProductProject { id: string; name: string; memory_auto_extract: number }
interface PendingRow {
  id: string; title: string; content: string; type: MemoryType;
  pii_kind: string | null; created_at: string;
}
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
  confidence: number | null;
  access_count: number;
  created_at: string;
  updated_at: string;
  need_review: boolean;
  invalidated_at?: string | null;
  superseded_by?: string | null;
}

const cell: React.CSSProperties = {
  padding: 8, borderBottom: '1px solid var(--surface-2)', fontSize: 'var(--fs-s)', verticalAlign: 'top',
};
const inputStyle: React.CSSProperties = {
  padding: 6, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)',
  borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)',
};
const btnStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)', padding: '3px 9px', border: '1px solid var(--border-strong)',
  borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text-secondary)', cursor: 'pointer',
};

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
  const [productKey, setProductKey] = useState('');
  const [type, setType] = useState<'' | MemoryType>('');
  const [keyword, setKeyword] = useState('');
  const [includeInvalidated, setIncludeInvalidated] = useState(false);
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  // MEM-503/504：本产品下的项目（自动抽取开关）与待确认队列
  const [projects, setProjects] = useState<ProductProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [pending, setPending] = useState<PendingRow[]>([]);
  // 新增表单
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newType, setNewType] = useState<MemoryType>('project');
  const [newTags, setNewTags] = useState('');
  // 行内编辑：同时只编辑一条，避免多行草稿状态互相覆盖
  const [editing, setEditing] = useState<{ id: string; type: MemoryType; title: string; content: string; tags: string } | null>(null);

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  const loadTags = useCallback(async () => {
    try {
      const list = await api.get<ProductTag[]>('/memories/product-tags');
      setTags(list);
      setProductKey((cur) => cur || list[0]?.productKey || '');
    } catch { /* 标签清单失败不阻塞页面 */ }
  }, []);

  const loadRows = useCallback(async () => {
    if (!productKey) { setRows([]); setTotal(0); return; }
    setLoading(true);
    try {
      const q = new URLSearchParams({ productKey, limit: '100' });
      if (type) q.set('type', type);
      if (keyword.trim()) q.set('query', keyword.trim());
      if (includeInvalidated) q.set('includeInvalidated', '1');
      const r = await api.get<{ total: number; memories: MemoryRow[] }>(`/memories?${q.toString()}`);
      setRows(r.memories ?? []);
      setTotal(r.total ?? 0);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [productKey, type, keyword, includeInvalidated]);

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

  useEffect(() => { void loadTags(); }, [loadTags]);
  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadPending(); }, [loadPending]);

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
        productKey, type: editing.type, title: editing.title, content: editing.content,
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
    <div style={{ maxWidth: 980 }}>
      <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 4 }}>记忆管理</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        产品维度的 AI 长期记忆：同一产品下的多期项目共享记忆池，跨产品严格隔离。
        {productKey && <span> <b>本页记忆仅属于产品「{productKey}」</b>，其它产品的记忆不会出现在此处。</span>}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <select aria-label="产品标签" value={productKey}
          onChange={(e) => { setProductKey(e.target.value); setEditing(null); }}
          style={{ ...inputStyle, minWidth: 180 }}>
          {tags.length === 0 && <option value="">暂无产品标签</option>}
          {tags.map((t) => (
            <option key={t.productKey} value={t.productKey}>{t.productKey}（记忆 {t.memoryCount}）</option>
          ))}
        </select>
        <select aria-label="记忆类型筛选" value={type} onChange={(e) => setType(e.target.value as '' | MemoryType)} style={inputStyle}>
          <option value="">全部类型</option>
          {MEMORY_TYPES.map((k) => <option key={k} value={k}>{TYPE_LABELS[k]}</option>)}
        </select>
        <input aria-label="关键词筛选" value={keyword} onChange={(e) => setKeyword(e.target.value)}
          placeholder="标题/内容关键词" style={{ ...inputStyle, minWidth: 200 }} />
        <label style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={includeInvalidated} onChange={(e) => setIncludeInvalidated(e.target.checked)} />
          含已失效
        </label>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{loading ? '加载中…' : `共 ${total} 条`}</span>
      </div>
      {notice && <div style={{ marginBottom: 10, fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{notice}</div>}

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
              <button style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}
                onClick={() => void resolvePending(p.id, 'confirm')}>确认入库</button>
              <button style={{ ...btnStyle, color: 'var(--danger)' }}
                onClick={() => void resolvePending(p.id, 'reject')}>驳回</button>
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
        <button onClick={() => void createMemory()} disabled={!productKey}
          style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>新增</button>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>
          {productKey ? '该产品暂无记忆（或筛选无命中）。' : '请先在项目上绑定产品标签，记忆才会有归属产品。'}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 'var(--fs-s)' }}>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>类型</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>标题 / 内容</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>标签</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>作用域</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>来源 / 溯源</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>访问</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>更新时间</th>
              <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => editing?.id === r.id ? (
              <tr key={r.id}>
                <td style={cell}>
                  <select aria-label="编辑类型" value={editing.type}
                    onChange={(e) => setEditing({ ...editing, type: e.target.value as MemoryType })} style={inputStyle}>
                    {MEMORY_TYPES.map((k) => <option key={k} value={k}>{TYPE_LABELS[k]}</option>)}
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
                    placeholder="逗号分隔" style={{ ...inputStyle, width: 140 }} />
                </td>
                <td style={cell} colSpan={4}>{r.project_id ? '本期特有' : '产品级共享'}</td>
                <td style={cell}>
                  <button onClick={() => void saveEdit()} style={{ ...btnStyle, color: 'var(--accent)', marginRight: 4 }}>保存</button>
                  <button onClick={() => setEditing(null)} style={btnStyle}>取消</button>
                </td>
              </tr>
            ) : (
              <tr key={r.id} style={{ opacity: r.invalidated_at ? 0.55 : 1 }}>
                <td style={cell}>{TYPE_LABELS[r.type] ?? r.type}</td>
                <td style={cell}>
                  <div style={{ color: 'var(--text)' }}>
                    {r.title}
                    {r.need_review && <span style={{ marginLeft: 6, fontSize: 'var(--fs-xs)', color: 'var(--warning, #d97706)' }}>需复核</span>}
                    {r.invalidated_at && <span style={{ marginLeft: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>已失效{r.superseded_by ? `（${r.superseded_by}）` : ''}</span>}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{brief(r.content, 70)}</div>
                </td>
                <td style={cell}>{parseTags(r.tags).join('、') || '—'}</td>
                <td style={cell}>{r.project_id ? '本期特有' : '产品级共享'}</td>
                <td style={cell}>{r.source_task_id ?? '—'}<div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{r.source_kind}</div></td>
                <td style={cell}>{r.access_count}</td>
                <td style={cell}>{r.updated_at.slice(0, 16).replace('T', ' ')}</td>
                <td style={cell}>
                  <button style={{ ...btnStyle, marginRight: 4 }} onClick={() => setEditing({
                    id: r.id, type: r.type, title: r.title, content: r.content, tags: parseTags(r.tags).join(','),
                  })}>编辑</button>
                  <button style={{ ...btnStyle, color: 'var(--danger)' }} onClick={() => void removeMemory(r)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
