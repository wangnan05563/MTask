import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, type Project } from '../api/client';
import { FileUp, Loader2, Save, Sparkles, Upload, X } from 'lucide-react';
import { useSessionState } from '../ui/session';
import { aiImportStore } from '../stores/aiImportStore';

/** T00662：PRD 解析结果（需求项 + WBS 计划草稿） */
interface PrdReq { reqNo: string; title: string; content: string; sourceRef: string; priority: string; include: boolean; key: string; }
interface PrdPlan { title: string; description: string; durationDays: number; reqNos: string[]; include: boolean; key: string; }

/**
 * 从 PRD 导入项目计划面板（T00662）：上传 PRD → AI 拆 WBS + 逐条提取需求 →
 * 预览确认（需求清单 + 计划草稿，可编辑/勾选）→ 导入（需求进矩阵、计划进甘特、可选同步待办）。
 * 与「AI 项目计划导入」共用控制台日志通道（tab 标题随导入类型切换）。
 */
export function PrdImportPanel({ toolId, onClose, onSaved }: {
  readonly toolId: string;
  readonly onClose?: () => void;
  readonly onSaved?: (n: { requirements: number; plans: number; tasks: number }) => void;
}) {
  const snap = useSyncExternalStore(aiImportStore.subscribe, aiImportStore.getSnapshot);
  const [projects, setProjects] = useSessionState<Project[]>('prd-import.projects.cache', []);
  const [projectId, setProjectId] = useSessionState<string>('prd-import.project', '');
  const [createTasks, setCreateTasks] = useSessionState<boolean>('prd-import.createTasks', true);
  const [reqs, setReqs] = useSessionState<PrdReq[]>('prd-import.reqs', []);
  const [plans, setPlans] = useSessionState<PrdPlan[]>('prd-import.plans', []);
  const { busy, fileName, error } = snap;

  useEffect(() => {
    aiImportStore.patch({ kind: 'prd' });
    void api.get<Project[]>('/projects').then(setProjects).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 上传 PRD → 文本提取（服务端多格式）→ AI 解析（需求 + WBS） */
  const parse = useCallback(async (file: File) => {
    if (!projectId) { aiImportStore.patch({ error: '请先选择目标项目' }); aiImportStore.log('缺少目标项目，已中止', 'error'); return; }
    if (!toolId) { aiImportStore.patch({ error: '请先在控制台选择 AI 模型（顶部模型下拉）' }); aiImportStore.log('缺少 AI 模型（控制台未选择），已中止', 'error'); return; }
    aiImportStore.reset('prd');
    aiImportStore.patch({ fileName: file.name, busy: true });
    aiImportStore.log(`已选择 PRD 文件：${file.name}（${(file.size / 1024).toFixed(1)} KB）`);
    try {
      const buf = await file.arrayBuffer();
      aiImportStore.log('提取文档文本（支持 docx/md/txt/xlsx/csv/pdf）…');
      aiImportStore.log('调用 AI 拆分 WBS 并逐条提取需求，请稍候…');
      const r = await api.postBinary<{
        ok: boolean;
        requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }>;
        drafts: Array<{ title: string; description: string; durationDays: number; reqNos: string[] }>;
        coverageWarn?: string;
      }>(`/plans/ai-parse-prd?projectId=${projectId}&toolId=${toolId}&filename=${encodeURIComponent(file.name)}`, buf);
      const stamp = Date.now();
      setReqs(r.requirements.map((x, i) => ({ ...x, include: true, key: `pr-${stamp}-${i}` })));
      setPlans(r.drafts.map((x, i) => ({ ...x, include: true, key: `pp-${stamp}-${i}` })));
      aiImportStore.log(`解析完成：需求 ${r.requirements.length} 条、WBS 计划 ${r.drafts.length} 条（可编辑后导入）`, 'ok');
      if (r.coverageWarn) { aiImportStore.log(r.coverageWarn, 'error'); }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`解析失败：${msg}`, 'error');
    } finally {
      aiImportStore.patch({ busy: false });
    }
  }, [projectId, toolId, setReqs, setPlans]);

  /** 确认导入：事务创建需求项（矩阵）+ 计划（关联需求）+ 可选待办任务 */
  async function doImport() {
    const rq = reqs.filter((x) => x.include && x.title.trim());
    const pl = plans.filter((x) => x.include && x.title.trim());
    if (rq.length === 0 && pl.length === 0) { aiImportStore.patch({ error: '请至少勾选一条需求或计划' }); aiImportStore.log('未勾选任何条目，已中止导入', 'error'); return; }
    aiImportStore.patch({ busy: true, error: '' });
    aiImportStore.log(`导入中：需求 ${rq.length} 条、计划 ${pl.length} 条${createTasks ? '，并同步生成待办任务' : ''}…`);
    try {
      // 勾选过滤：仅提交勾选项；reqNos 需与提交的需求编号保持一致（未勾选需求的引用自动丢弃）
      const keptNos = new Set(rq.map((x) => x.reqNo));
      const r = await api.post<{ requirements: number; plans: number; tasks: number; unlinkedReqNos?: string[] }>('/plans/import-prd', {
        projectId,
        createTasks,
        requirements: rq.map(({ include, key, ...rest }) => { void include; void key; return rest; }),
        plans: pl.map(({ include, key, ...rest }) => { void include; void key; return { ...rest, reqNos: rest.reqNos.filter((n) => keptNos.has(n)) }; }),
      });
      aiImportStore.log(`导入完成：需求 ${r.requirements} 条（已入需求跟踪矩阵）、计划 ${r.plans} 条${r.tasks ? `、待办任务 ${r.tasks} 条` : ''}`, 'ok');
      // T00712（D-5）：无效需求编号不再静默丢弃——服务端返回 unlinkedReqNos 时在控制台给出可感知告警
      if (r.unlinkedReqNos?.length) {
        aiImportStore.log(`告警：${r.unlinkedReqNos.length} 个需求编号未命中本次导入的需求（${r.unlinkedReqNos.join('、')}），其计划/待办关联已被忽略，请核对编号或先补导对应需求`, 'error');
      }
      aiImportStore.patch({ lastSaved: r.plans });
      setReqs([]); setPlans([]);
      onSaved?.(r);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`导入失败：${msg}`, 'error');
    } finally {
      aiImportStore.patch({ busy: false });
    }
  }

  const includedPlans = useMemo(() => plans.filter((x) => x.include).length, [plans]);
  const includedReqs = useMemo(() => reqs.filter((x) => x.include).length, [reqs]);

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <FileUp size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>从 PRD 导入项目计划</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          上传 PRD（Word/Excel/Markdown/文本/PDF）→ AI 拆分 WBS 并逐条提取需求 → 预览确认 → 导入（需求进矩阵、计划进甘特，可同步生成待办）；执行输出见右侧控制台
        </span>
        <span style={{ flex: 1 }} />
        {onClose && (
          <button onClick={onClose} className="tbtn-anim" title="收起面板" aria-label="收起 PRD 导入面板"
            style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 6px' }}>
            <X size={13} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy}
          aria-label="目标项目" title="PRD 将导入到该项目（计划 + 需求矩阵 + 可选待办）"
          style={{ padding: 4, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">选择目标项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="tbtn-anim" title="选择 PRD 文件（.docx/.md/.markdown/.txt/.xlsx/.csv/.pdf）"
          style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 12 }}>
          <Upload size={13} /> 选择 PRD 文件
          <input type="file" accept=".docx,.md,.markdown,.txt,.xlsx,.csv,.pdf" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void parse(f); } e.target.value = ''; }} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}
          title="勾选后：WBS 节点同时生成待办任务（携带需求关联），便于 AI 推进执行">
          <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} style={{ cursor: 'pointer' }} />
          同步生成待办任务
        </label>
        {fileName && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fileName}</span>}
        {busy && <span style={{ fontSize: 11, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Loader2 size={12} className="aispin" />处理中…</span>}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {snap.logs.length > 0 ? `控制台已输出 ${snap.logs.length} 条执行日志 →` : '执行过程将在右侧 AI 控制台逐行输出'}
        </span>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {(reqs.length > 0 || plans.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          {/* 需求清单（矩阵行） */}
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={12} style={{ color: 'var(--accent)' }} />
              需求清单 {reqs.length} 条（勾选 {includedReqs}）
              <button onClick={() => setReqs((p) => p.map((x) => ({ ...x, include: true })))} disabled={busy} title="全选需求" aria-label="全选需求"
                style={{ border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 11, padding: '1px 6px', cursor: 'pointer' }}>全选</button>
              <button onClick={() => setReqs((p) => p.map((x) => ({ ...x, include: false })))} disabled={busy} title="全不选需求" aria-label="全不选需求"
                style={{ border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 11, padding: '1px 6px', cursor: 'pointer' }}>全不选</button>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>选</th>
                    <th style={{ padding: 4 }}>编号</th>
                    <th style={{ padding: 4 }}>需求标题</th>
                    <th style={{ padding: 4 }}>原文定位</th>
                  </tr>
                </thead>
                <tbody>
                  {reqs.map((r, i) => (
                    <tr key={r.key} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: 4 }}>
                        <input type="checkbox" checked={r.include} aria-label={`选中需求 ${r.title}`}
                          onChange={(e) => setReqs((p) => p.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} />
                      </td>
                      <td style={{ padding: 4, width: 88 }}>
                        <input value={r.reqNo} aria-label="需求编号" title={r.content || '（无详细描述）'}
                          onChange={(e) => setReqs((p) => p.map((x, j) => (j === i ? { ...x, reqNo: e.target.value } : x)))}
                          style={{ width: 80, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 11, padding: '1px 4px' }} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input value={r.title} aria-label="需求标题" title={r.content}
                          onChange={(e) => setReqs((p) => p.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                          style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12 }} />
                      </td>
                      <td style={{ padding: 4, fontSize: 11, color: 'var(--text-muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.sourceRef}>{r.sourceRef || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* WBS 计划草稿（含需求关联） */}
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              WBS 计划 {plans.length} 条（勾选 {includedPlans}）——关联需求编号显示在标题后
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>选</th>
                    <th style={{ padding: 4 }}>WBS 任务</th>
                    <th style={{ padding: 4 }}>工期</th>
                    <th style={{ padding: 4 }}>关联需求</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p, i) => (
                    <tr key={p.key} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: 4 }}>
                        <input type="checkbox" checked={p.include} aria-label={`选中计划 ${p.title}`}
                          onChange={(e) => setPlans((prev) => prev.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input value={p.title} aria-label="WBS 标题" title={p.description}
                          onChange={(e) => setPlans((prev) => prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                          style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12 }} />
                      </td>
                      <td style={{ padding: 4, width: 70 }}>
                        <input type="number" min={1} value={p.durationDays} aria-label="工期"
                          onChange={(e) => setPlans((prev) => prev.map((x, j) => (j === i ? { ...x, durationDays: Number(e.target.value) || 1 } : x)))}
                          style={{ width: 50, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, padding: '1px 4px' }} />
                      </td>
                      <td style={{ padding: 4, fontSize: 11, color: 'var(--accent)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.reqNos.join('、')}>
                        {p.reqNos.length > 0 ? p.reqNos.join('、') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {(reqs.length > 0 || plans.length > 0) && (
        <button onClick={() => void doImport()} disabled={busy} className="tbtn-anim"
          title="导入勾选的条目——需求进矩阵、计划进甘特（含需求关联）、可选生成待办任务"
          aria-label="导入 PRD 解析结果"
          style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12, cursor: busy ? 'default' : 'pointer' }}>
          <Save size={13} /> 导入（需求 {includedReqs} 条 / 计划 {includedPlans} 条{createTasks ? ' + 待办' : ''}）
        </button>
      )}
    </div>
  );
}
