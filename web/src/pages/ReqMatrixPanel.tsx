import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Check, ChevronDown, ChevronUp, Link2, Loader2, Plus, RefreshCw, Table2, Trash2, X } from 'lucide-react'; // T00765：标题点击查询详情

/** 矩阵行：需求 + 其关联的计划与待办（T00662） */
interface MatrixReq {
  id: string;
  project_id: string;
  req_no: string;
  title: string;
  content: string;
  source_ref: string;
  priority: string;
  status: string;
  linkedPlans: Array<{ id: string; title: string; status: string }>;
  linkedTasks: Array<{ id: string; taskNo: string | null; title: string; status: string; verified: boolean }>;
}
interface PlanLite { id: string; title: string; status: string; }

const STATUS_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'todo', label: '待开始' },
  { key: 'doing', label: '进行中' },
  { key: 'done', label: '已完成' },
  { key: 'changed', label: '已变更' },
];

/**
 * 需求跟踪矩阵面板（T00662）：按项目展示 PRD 需求 → 计划/待办 的关联与状态；
 * 支持增（新增需求）/ 删 / 改（标题、编号、状态行内编辑）/ 关联调整（勾选计划或待办建立/解除关联）。
 */
export function ReqMatrixPanel({ projectId, onClose }: {
  readonly projectId: string;
  readonly onClose: () => void;
}) {
  const [rows, setRows] = useState<MatrixReq[]>([]);
  const [plans, setPlans] = useState<PlanLite[]>([]);
  const [tasks, setTasks] = useState<Array<{ id: string; taskNo: string | null; title: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [linkFor, setLinkFor] = useState<string>('');       // 正在调整关联的需求 id
  const [linkKind, setLinkKind] = useState<'plan' | 'task'>('plan');
  const [queryId, setQueryId] = useState<string>(''); // T00765：正在查看详情的需求 id（点击标题旁 chevron 切换）
  const [newTitle, setNewTitle] = useState('');

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  const load = useCallback(async () => {
    if (!projectId) return;
    const [r, p, t] = await Promise.all([
      api.get<MatrixReq[]>(`/plans/prd-requirements?projectId=${projectId}`),
      api.get<PlanLite[]>(`/plans?projectId=${projectId}`).catch(() => []),
      api.get<Array<{ id: string; task_no: string | null; title: string }>>(`/tasks?projectId=${projectId}&archived=false`).catch(() => []),
    ]);
    setRows(r);
    setPlans(p);
    setTasks(t.map((x) => ({ id: x.id, taskNo: x.task_no, title: x.title })));
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function addReq() {
    if (!newTitle.trim()) return flash('请输入需求标题');
    setBusy(true);
    try {
      await api.post('/plans/prd-requirements', { projectId, title: newTitle.trim() });
      setNewTitle('');
      flash('已新增需求');
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function updateReq(id: string, patch: Partial<Pick<MatrixReq, 'title' | 'req_no' | 'status' | 'priority'>>) {
    try {
      await api.patch(`/plans/prd-requirements/${id}`, patch);
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function removeReq(r: MatrixReq) {
    if (!(await askConfirm(`删除需求「${r.title}」？\n\n其与计划/待办的关联将一并清理（计划与任务本身不受影响）。`))) return;
    try {
      await api.del(`/plans/prd-requirements/${r.id}`);
      flash('已删除需求并清理关联');
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** 关联调整：勾选 = 建立关联；取消勾选 = 解除关联 */
  async function toggleLink(reqId: string, kind: 'plan' | 'task', targetId: string, linked: boolean) {
    try {
      await api.post(`/plans/prd-requirements/${reqId}/link`, { kind, targetId, linked });
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  const covered = rows.filter((r) => r.linkedPlans.length > 0 || r.linkedTasks.length > 0).length;

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <Table2 size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>需求跟踪矩阵</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          共 {rows.length} 条需求，已关联计划/待办 {covered} 条；可增删改与调整关联
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => void load()} className="tbtn-anim" title="刷新矩阵" aria-label="刷新矩阵"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 11, padding: '2px 8px' }}>
          <RefreshCw size={12} /> 刷新
        </button>
        <button onClick={onClose} className="tbtn-anim" title="收起矩阵面板" aria-label="收起需求跟踪矩阵"
          style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 6px' }}>
          <X size={13} />
        </button>
      </div>

      {/* 新增需求 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void addReq(); }}
          placeholder="新增需求标题（回车提交）" aria-label="新增需求标题"
          style={{ flex: 1, maxWidth: 320, padding: '5px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12 }} />
        <button onClick={() => void addReq()} disabled={busy} className="tbtn-anim"
          title="新增一条需求（编号自动生成）" aria-label="新增需求"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }}>
          <Plus size={13} /> 新增需求
        </button>
        {notice && <span style={{ fontSize: 11, color: 'var(--accent)' }}>{notice}</span>}
      </div>

      {rows.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>该项目暂无需求记录——可用「从 PRD 导入项目计划」生成，或在上方手动新增。</div>
        : (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left', background: 'var(--surface-2, transparent)' }}>
                  <th style={{ padding: '5px 6px' }}>需求编号</th>
                  <th style={{ padding: '5px 6px' }}>需求标题</th>
                  <th style={{ padding: '5px 6px' }}>状态</th>
                  <th style={{ padding: '5px 6px' }}>关联计划</th>
                  <th style={{ padding: '5px 6px' }}>关联待办</th>
                  <th style={{ padding: '5px 6px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '4px 6px', width: 100 }}>
                      <input defaultValue={r.req_no} aria-label="需求编号" title="需求编号（失焦保存）"
                        onBlur={(e) => { if (e.target.value !== r.req_no) void updateReq(r.id, { req_no: e.target.value }); }}
                        style={{ width: 88, border: '1px solid transparent', borderRadius: 4, background: 'transparent', color: 'var(--accent)', fontSize: 12, padding: '1px 4px' }} />
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      {/* T00765：标题字段带交互点击查询——chevron 展开需求详情（内容/来源/优先级），标题输入框编辑能力不变 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <input defaultValue={r.title} aria-label="需求标题" title={r.content || r.source_ref || '（无详情）'}
                          onBlur={(e) => { if (e.target.value !== r.title) void updateReq(r.id, { title: e.target.value }); }}
                          style={{ flex: 1, minWidth: 150, border: '1px solid transparent', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 12, padding: '1px 4px' }} />
                        <button onClick={() => setQueryId(queryId === r.id ? '' : r.id)} className="tbtn-anim"
                          title={queryId === r.id ? '收起需求详情' : '查询需求详情（内容/来源/优先级）'}
                          aria-label={`查询需求 ${r.title} 详情`} aria-expanded={queryId === r.id}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: queryId === r.id ? 'var(--accent)' : 'var(--text-muted)', padding: 2, display: 'inline-flex', flexShrink: 0 }}>
                          {queryId === r.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      </div>
                      {r.source_ref && <div style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 4 }}>{r.source_ref}</div>}
                      {queryId === r.id && (
                        <div style={{ marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', fontSize: 11, color: 'var(--text)' }}>
                          <div style={{ whiteSpace: 'pre-wrap' }}>{r.content ? r.content : '（无内容）'}</div>
                          <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>来源：{r.source_ref || '—'} · 优先级：{r.priority || 'normal'} · 状态：{r.status || 'todo'}</div>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '4px 6px', width: 96 }}>
                      <select value={r.status} onChange={(e) => void updateReq(r.id, { status: e.target.value })}
                        aria-label="需求状态" title="需求状态"
                        style={{ border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, padding: '1px 4px' }}>
                        {STATUS_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '4px 6px', maxWidth: 200 }}>
                      {r.linkedPlans.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>—</span> : (
                        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 3 }}>
                          {r.linkedPlans.map((p) => (
                            <span key={p.id} title={`计划：${p.title}（${p.status}）`}
                              style={{ fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', color: 'var(--text)' }}>
                              {p.title.length > 14 ? `${p.title.slice(0, 14)}…` : p.title}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '4px 6px', maxWidth: 200 }}>
                      {r.linkedTasks.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>—</span> : (
                        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 3 }}>
                          {r.linkedTasks.map((t) => (
                            <span key={t.id} title={`待办：${t.title}（${t.status === 'done' ? '已完成' : '待办'}${t.verified ? '·已验证' : ''}）`}
                              style={{ fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', color: t.status === 'done' ? 'var(--success)' : 'var(--text)' }}>
                              {t.taskNo ?? '—'}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => { setLinkFor(linkFor === r.id ? '' : r.id); setLinkKind('plan'); }}
                        className="tbtn-anim" title="关联调整 — 勾选计划或待办建立/解除关联" aria-label={`调整 ${r.title} 的关联`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, background: linkFor === r.id ? 'var(--accent)' : 'transparent', color: linkFor === r.id ? 'var(--accent-text)' : 'var(--text)', cursor: 'pointer', padding: '1px 6px', marginRight: 4 }}>
                        <Link2 size={11} /> 关联
                      </button>
                      <button onClick={() => void removeReq(r)} className="tbtn-anim" title="删除需求（清理关联）" aria-label={`删除需求 ${r.title}`}
                        style={{ display: 'inline-flex', border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', padding: 2 }}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {/* 关联调整弹层：列出该项目的计划与待办，勾选即建立关联 */}
      {linkFor && (
        <div style={{ marginTop: 10, border: '1px solid var(--border-strong)', borderRadius: 8, padding: 10, background: 'var(--surface-2, transparent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>关联调整</span>
            <fieldset style={{ display: 'inline-flex', margin: 0, padding: 0, minWidth: 0, border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }}>
              <button onClick={() => setLinkKind('plan')} title="关联到项目计划" aria-label="关联到计划"
                style={{ padding: '2px 10px', fontSize: 11, border: 'none', cursor: 'pointer', background: linkKind === 'plan' ? 'var(--accent)' : 'transparent', color: linkKind === 'plan' ? 'var(--accent-text)' : 'var(--text)' }}>计划</button>
              <button onClick={() => setLinkKind('task')} title="关联到待办任务" aria-label="关联到待办"
                style={{ padding: '2px 10px', fontSize: 11, border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: linkKind === 'task' ? 'var(--accent)' : 'transparent', color: linkKind === 'task' ? 'var(--accent-text)' : 'var(--text)' }}>待办</button>
            </fieldset>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>勾选即建立关联，取消勾选解除</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setLinkFor('')} title="收起关联调整" aria-label="收起关联调整"
              style={{ border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 11, padding: '2px 8px' }}>收起</button>
          </div>
          {(() => {
            const cur = rows.find((x) => x.id === linkFor);
            if (!cur) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{busy ? <Loader2 size={12} className="aispin" /> : '需求已变更，请刷新'}</div>;
            const linkedIds = linkKind === 'plan' ? cur.linkedPlans.map((x) => x.id) : cur.linkedTasks.map((x) => x.id);
            const list = linkKind === 'plan'
              ? plans.map((p) => ({ id: p.id, label: p.title }))
              : tasks.map((t) => ({ id: t.id, label: `${t.taskNo ?? '—'} ${t.title}` }));
            if (list.length === 0) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>该项目暂无{linkKind === 'plan' ? '计划' : '待办任务'}可选。</div>;
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 180, overflowY: 'auto' }}>
                {list.map((x) => {
                  const on = linkedIds.includes(x.id);
                  return (
                    <label key={x.id} title={x.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text)', cursor: 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, padding: '2px 8px', maxWidth: 260 }}>
                      <input type="checkbox" checked={on} onChange={(e) => void toggleLink(cur.id, linkKind, x.id, e.target.checked)} style={{ cursor: 'pointer' }} />
                      {on && <Check size={11} style={{ color: 'var(--accent)' }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.label}</span>
                    </label>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
