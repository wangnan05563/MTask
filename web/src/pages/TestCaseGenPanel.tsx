/**
 * T01492（PRD-测试用例管理 §8.1/§8.5/§8.7）：AI 工作台「从 PRD 生成测试用例」卡片面板。
 *
 * 职责：输入区（目标项目 + 内部 PRD 选择 / 外部上传双通道 + 生成偏好）→ 调 T01491 的 SSE 路由
 * 流式生成（过程写右侧控制台，可中断）→ 草稿视图（覆盖率条 / 勾选 / 就地编辑 / 删除 / 补生成）→
 * 确认导入调 `POST /plans/test-cases/import-draft`（服务端单事务 + source_key 幂等）。
 *
 * 与 `PrdGenPanel.tsx` 逐字同构的三点：streamEvents 调用范式、AbortController 登记进 store、
 * 生成完成回调里同步写一次 sessionStorage（§8.7：组件卸载会让 useSessionState 的持久化 effect 不再执行）。
 * 草稿字段口径以 `stores/testCaseGenStore.ts` 的 `Draft*`（镜像后端 testCaseGenParse）为单源，此处不二次运算。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILE_INPUT_SR_ONLY } from '../ui/fileInput'; // T01674：file input 视觉隐藏但保留键盘焦点
import { api, type Project } from '../api/client';
import { streamEvents } from '../api/sse';
import { useSessionState } from '../ui/session';
import {
  testCaseGenStore, useTestCaseGen,
  type TestCaseGenResult, type DraftCase, type DraftRequirement,
} from '../stores/testCaseGenStore';
import { askConfirm } from '../ui/dialogs';
import { enumLabel, type CaseMeta } from './testCaseModel';
import { CircleCheck, FileText, ListChecks, Loader2, RefreshCw, Sparkles, Trash2, Upload, X } from 'lucide-react';

/** 目标项目 + 来源 + 偏好之外的草稿快照（§8.7 sessionStorage 结构） */
interface DraftSnapshot {
  projectId: string;
  requirements: DraftRequirement[];
  cases: DraftCase[];
  coverage: TestCaseGenResult['coverage'];
  notes: string[];
  truncated: boolean;
  source: string;
}

const DRAFT_SESSION_KEY = 'tcgen.draft';

/** 分块读文件为 base64（避免大文件 String.fromCodePoint 展开爆栈，与 PrdGenPanel 同款） */
function fileToBase64(f: File): Promise<string> {
  return f.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
}

const opBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 8px' } as const;

export function TestCaseGenPanel({ toolId, onClose, onImported }: {
  readonly toolId: string;
  readonly onClose?: () => void;
  readonly onImported?: (r: { imported: number; skipped: number; requirementsCreated: number }) => void;
}) {
  const snap = useTestCaseGen();
  const { streaming } = snap;
  const [projects, setProjects] = useSessionState<Project[]>('tcgen.projects.cache', []);
  const [projectId, setProjectId] = useSessionState<string>('tcgen.project', '');
  const [docs, setDocs] = useState<Array<{ id: string; filename: string }>>([]);
  const [docId, setDocId] = useSessionState<string>('tcgen.docId', '');
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  // 生成偏好（GenPrefs §8.1）
  const [perReq, setPerReq] = useSessionState<string>('tcgen.perReq', '3');
  const [granularity, setGranularity] = useSessionState<'steps' | 'points'>('tcgen.granularity', 'steps');
  const [includeNegative, setIncludeNegative] = useSessionState<boolean>('tcgen.includeNegative', true);
  const [priorityStrategy, setPriorityStrategy] = useSessionState<string>('tcgen.priorityStrategy', '风险驱动');
  const [writeRequirements, setWriteRequirements] = useSessionState<boolean>('tcgen.writeReq', true);
  const [resplit, setResplit] = useSessionState<boolean>('tcgen.resplit', false);
  // 草稿视图本地可编辑态（以 store.result 为初始来源，勾选/就地编辑只改本地副本）
  const [draftCases, setDraftCases] = useState<DraftCase[]>([]);
  const [draftReqs, setDraftReqs] = useState<DraftRequirement[]>([]);
  const [coverage, setCoverage] = useState<TestCaseGenResult['coverage'] | null>(null);
  const [draftSource, setDraftSource] = useState('');
  const [meta, setMeta] = useState<CaseMeta | null>(null);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  // 上一次已并入本地态的 store.result 引用——避免每次快照变化都重置用户编辑
  const syncedResult = useRef<TestCaseGenResult | null>(null);

  const flash = useCallback((m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3500); }, []);

  useEffect(() => { void api.get<Project[]>('/projects').then(setProjects).catch(() => undefined); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // 项目变更 → 拉该项目的 PRD 文档列表与用例枚举 meta（meta 供草稿视图 priority/type 下拉）
  useEffect(() => {
    if (!projectId) { setDocs([]); return; }
    void api.get<Array<{ id: string; filename: string }>>(`/plans/prd-docs?projectId=${encodeURIComponent(projectId)}`)
      .then((v) => setDocs(Array.isArray(v) ? v.map((d) => ({ id: d.id, filename: d.filename })) : [])).catch(() => setDocs([]));
    void api.get<CaseMeta>(`/plans/test-cases/meta?projectId=${encodeURIComponent(projectId)}`).then(setMeta).catch(() => setMeta(null));
  }, [projectId]);

  // 生成完成 → store.result 落到本地可编辑草稿（仅当 result 变化时同步一次，保留用户已做的编辑）
  useEffect(() => {
    const r = snap.result;
    if (!r || r === syncedResult.current) return;
    syncedResult.current = r;
    setDraftCases(r.cases.map((c) => ({ ...c, steps: [...c.steps] })));
    setDraftReqs(r.requirements);
    setCoverage(r.coverage);
    setDraftSource((prev) => prev || '');
  }, [snap.result]);

  // §8.7：草稿每次变化都同步写一次 sessionStorage（生成完成回调 + 编辑），组件卸载后仍能恢复
  useEffect(() => {
    if (draftCases.length === 0 && draftReqs.length === 0) return;
    const snapshot: DraftSnapshot = { projectId, requirements: draftReqs, cases: draftCases, coverage: coverage ?? { total: 0, covered: 0, uncovered: 0, rate: 0, byReq: [] }, notes: snap.result?.notes ?? [], truncated: snap.result?.truncated ?? false, source: draftSource };
    try { sessionStorage.setItem(DRAFT_SESSION_KEY, JSON.stringify(snapshot)); } catch { /* 忽略存储异常 */ }
  }, [draftCases, draftReqs, coverage, draftSource, projectId, snap.result]);

  // 挂载恢复：store 无结果但 sessionStorage 有本项目的草稿 → 灌回本地态并写回 store（右侧控制台同步可见）
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_SESSION_KEY);
      if (!raw || snap.result) return;
      const s = JSON.parse(raw) as DraftSnapshot;
      if (!s || !Array.isArray(s.cases) || s.cases.length === 0) return;
      if (s.projectId && s.projectId !== projectId) return;
      const result: TestCaseGenResult = { requirements: s.requirements ?? [], cases: s.cases, coverage: s.coverage, notes: s.notes ?? [], truncated: s.truncated ?? false };
      syncedResult.current = result;
      testCaseGenStore.setResult(result);
      setDraftCases(s.cases);
      setDraftReqs(s.requirements ?? []);
      setCoverage(s.coverage ?? null);
      setDraftSource(s.source ?? '');
      if (s.projectId) setProjectId(s.projectId);
    } catch { /* 恢复失败静默，不影响新生成 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasDraft = draftCases.length > 0;
  const selectedCount = useMemo(() => draftCases.filter((c) => c.include !== false && c.title.trim()).length, [draftCases]);
  const pendingCount = useMemo(() => draftCases.filter((c) => c.include !== false && c.title.trim() && !c.alreadyImported).length, [draftCases]);
  const uncovered = useMemo(() => (coverage?.byReq ?? []).filter((r) => r.caseCount === 0), [coverage]);

  /** 发起流式生成：来源二选一（内部文档优先，否则上传文件），过程写右侧控制台 */
  async function generate(): Promise<void> {
    if (!projectId) { flash('请先选择目标项目'); testCaseGenStore.pushLog('缺少目标项目，已中止'); return; }
    if (!toolId) { flash('请先在控制台选择 AI 模型（顶部模型下拉）'); return; }
    const useDoc = !!docId;
    if (!useDoc && !pickedFile) { flash('请选择内部 PRD 文档，或上传外部文档'); return; }
    if (pickedFile) {
      const lower = pickedFile.name.toLowerCase();
      if (lower.endsWith('.doc') || lower.endsWith('.xls')) { flash('老式 .doc/.xls 请先另存为 .docx/.xlsx'); return; }
      if (!/\.(docx|xlsx|csv|md|markdown|txt)$/i.test(lower)) { flash('支持 .docx/.xlsx/.csv/.md/.txt'); return; }
    }
    const sourceLabel = useDoc ? (docs.find((d) => d.id === docId)?.filename ?? '内部 PRD 文档') : (pickedFile?.name ?? '');
    const ac = new AbortController();
    testCaseGenStore.setAbortCtrl(ac);
    testCaseGenStore.begin();
    testCaseGenStore.pushLog(`来源：${sourceLabel}（${useDoc ? '内部文档' : '外部上传'}）；开始生成…`);
    const body: Record<string, unknown> = {
      source: sourceLabel, resplit,
      prefs: { perReq: Number(perReq) || undefined, granularity, includeNegative, priorityStrategy },
    };
    if (useDoc) body.prdDocId = docId;
    else if (pickedFile) { body.contentBase64 = await fileToBase64(pickedFile); body.filename = pickedFile.name; }
    let errMsg = '';
    try {
      await streamEvents(
        `/plans/testcase-generate-stream?projectId=${encodeURIComponent(projectId)}&toolId=${encodeURIComponent(toolId)}`,
        body,
        (name, payload) => {
          if (name === 'stage') testCaseGenStore.pushLog((payload as { msg: string }).msg);
          else if (name === 'chunk') testCaseGenStore.appendText((payload as { text: string }).text);
          else if (name === 'done') testCaseGenStore.setResult(payload as TestCaseGenResult);
          else if (name === 'error') errMsg = (payload as { error: string }).error;
        },
        ac.signal,
      );
      if (errMsg) throw new Error(errMsg);
      const done = testCaseGenStore.get().result;
      if (done) {
        syncedResult.current = done;
        setDraftCases(done.cases.map((c) => ({ ...c, steps: [...c.steps] })));
        setDraftReqs(done.requirements);
        setCoverage(done.coverage);
        setDraftSource(sourceLabel);
      }
      testCaseGenStore.finish();
      testCaseGenStore.pushLog('生成完成：请在草稿视图勾选 / 编辑后确认导入');
    } catch (e) {
      if (ac.signal.aborted) return; // 用户主动「停止」：store 已清空，不再补失败日志
      testCaseGenStore.finish(`生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      testCaseGenStore.setAbortCtrl(null);
    }
  }

  const updateCase = (idx: number, patch: Partial<DraftCase>) =>
    setDraftCases((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  const removeCase = (idx: number) => setDraftCases((prev) => prev.filter((_, i) => i !== idx));
  const setAllInclude = (val: boolean) => setDraftCases((prev) => prev.map((c) => ({ ...c, include: val })));
  const invertInclude = () => setDraftCases((prev) => prev.map((c) => ({ ...c, include: c.include === false })));

  /** 按 reqNo 分组渲染（保留全局下标用于编辑） */
  const groups = useMemo(() => {
    const reqNos = draftReqs.map((r) => r.reqNo);
    const byReq = new Map<string, number[]>();
    draftCases.forEach((c, idx) => {
      const arr = byReq.get(c.reqNo);
      if (arr) arr.push(idx); else byReq.set(c.reqNo, [idx]);
    });
    const ordered: Array<{ req: DraftRequirement | null; reqNo: string; idxs: number[] }> = [];
    for (const r of draftReqs) { const idxs = byReq.get(r.reqNo) ?? []; byReq.delete(r.reqNo); ordered.push({ req: r, reqNo: r.reqNo, idxs }); }
    for (const [reqNo, idxs] of byReq) ordered.push({ req: null, reqNo, idxs });
    void reqNos;
    return ordered;
  }, [draftCases, draftReqs]);

  /** 确认导入：把勾选且未入库的草稿提交 import-draft（服务端按 source_key 幂等） */
  async function doImport(): Promise<void> {
    if (!projectId) return flash('请先选择目标项目');
    const chosen = draftCases.filter((c) => c.include !== false && c.title.trim() && !c.alreadyImported);
    if (chosen.length === 0) return flash('没有待导入的用例（请勾选，或它们均已入库）');
    if (!(await askConfirm(`确认导入 ${chosen.length} 条测试用例？\n\n已入库的同来源用例会自动跳过（幂等）。`))) return;
    setImporting(true);
    try {
      const r = await api.post<{ imported: number; skipped: number; requirementsCreated: number }>('/plans/test-cases/import-draft', {
        projectId,
        writeRequirements,
        requirements: draftReqs.map((q) => ({ reqNo: q.reqNo, title: q.title, content: q.content, sourceRef: q.sourceRef, priority: q.priority, isNew: q.isNew })),
        cases: chosen.map((c) => ({
          reqNo: c.reqNo, title: c.title, module: c.module, preconditions: c.preconditions, expected: c.expected,
          testData: c.testData, postconditions: c.postconditions, priority: c.priority, type: c.type, method: c.method,
          tags: c.tags, steps: c.steps.map((s) => ({ action: s.action, expected: s.expected })), include: true,
        })),
      });
      const reqPart = r.requirementsCreated > 0 ? `，新建需求 ${r.requirementsCreated} 条` : '';
      const skipPart = r.skipped > 0 ? `，跳过已入库 ${r.skipped} 条` : '';
      flash(`已导入 ${r.imported} 条测试用例${reqPart}${skipPart}——可在「项目管理 → 测试用例视图」查看`);
      testCaseGenStore.pushLog(`确认导入：入库 ${r.imported} 条${reqPart}${skipPart}`);
      // 标记已入库并从草稿移除，保留未选行以便再次导入
      const importedKeys = new Set(chosen.map((c) => c.sourceKey));
      setDraftCases((prev) => prev.filter((c) => !importedKeys.has(c.sourceKey)));
      onImported?.({ imported: r.imported, skipped: r.skipped, requirementsCreated: r.requirementsCreated });
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  /** 补生成：对未覆盖需求再跑一轮（后端已内部补生成 + source_key 幂等，重复项不会二次入库） */
  const regenerate = () => { void generate(); };
  const clearDraft = () => {
    setDraftCases([]); setDraftReqs([]); setCoverage(null); setDraftSource('');
    syncedResult.current = null;
    try { sessionStorage.removeItem(DRAFT_SESSION_KEY); } catch { /* 忽略 */ }
  };

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <ListChecks size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>从 PRD 生成测试用例</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          内置技能（testcase-generate）+ 项目源码上下文 → 拆分需求 + 生成用例 + 覆盖校验；确认后入库，过程见右侧控制台
        </span>
        <span style={{ flex: 1 }} />
        {onClose && <button onClick={onClose} className="tbtn-anim" title="收起面板" aria-label="收起测试用例生成面板" style={opBtn}><X size={13} /></button>}
      </div>

      {/* 输入区 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setDocId(''); }} disabled={streaming}
          title="目标项目 — 用例与需求将挂到该项目" aria-label="选择目标项目"
          style={{ padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', minWidth: 160 }}>
          <option value="">选择项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <select value={docId} onChange={(e) => { setDocId(e.target.value); if (e.target.value) setPickedFile(null); }} disabled={streaming || !projectId}
          title="① 内部选择：已录入的 PRD 文档" aria-label="选择内部 PRD 文档"
          style={{ padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', minWidth: 160 }}>
          <option value="">内部 PRD 文档…{docs.length ? '' : '（无）'}</option>
          {docs.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
        </select>

        <label className="tbtn-anim" title="② 外部导入：上传需求文档（.docx/.xlsx/.csv/.md/.txt）" style={{ ...opBtn, cursor: 'pointer' }}>
          <Upload size={12} /> 选择文件
          <input type="file" accept=".doc,.docx,.xls,.xlsx,.csv,.md,.markdown,.txt" style={FILE_INPUT_SR_ONLY}
            onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; if (f) { setPickedFile(f); setDocId(''); } }} />
        </label>
        {pickedFile && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
            <FileText size={12} /> {pickedFile.name}
            <button onClick={() => setPickedFile(null)} className="tbtn-anim" title="移除已选文件" aria-label="移除已选文件" style={{ border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', display: 'inline-flex' }}><X size={12} /></button>
          </span>
        )}
        {streaming && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--accent)' }}><Loader2 size={13} className="task-breathe" /> 生成中…（阶段日志滚动至右侧控制台）</span>}
      </div>

      {/* 生成偏好 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>每需求用例数
          <select value={perReq} onChange={(e) => setPerReq(e.target.value)} disabled={streaming} style={{ padding: '2px 4px', fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
            {['2', '3', '5', '8'].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>粒度
          <select value={granularity} onChange={(e) => setGranularity(e.target.value as 'steps' | 'points')} disabled={streaming} style={{ padding: '2px 4px', fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
            <option value="steps">包含步骤</option>
            <option value="points">仅要点</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>负向用例
          <select value={includeNegative ? 'yes' : 'no'} onChange={(e) => setIncludeNegative(e.target.value === 'yes')} disabled={streaming} style={{ padding: '2px 4px', fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
            <option value="yes">包含</option>
            <option value="no">不含</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>优先级策略
          <select value={priorityStrategy} onChange={(e) => setPriorityStrategy(e.target.value)} disabled={streaming} style={{ padding: '2px 4px', fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
            {['风险驱动', '均衡分布', '核心优先'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="把新拆分的需求一并写入需求跟踪矩阵">
          <input type="checkbox" checked={writeRequirements} onChange={(e) => setWriteRequirements(e.target.checked)} disabled={streaming} />写入矩阵
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="忽略项目已有需求，按 PRD 重新拆分">
          <input type="checkbox" checked={resplit} onChange={(e) => setResplit(e.target.checked)} disabled={streaming} />重新拆分需求
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button onClick={() => void generate()} disabled={streaming} className="tbtn-anim"
          title="开始生成测试用例（过程在右侧控制台，可随时停止）" aria-label="开始生成测试用例"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, border: 'none', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)', cursor: streaming ? 'default' : 'pointer', padding: '5px 12px' }}>
          {streaming ? <Loader2 size={12} className="task-breathe" /> : <Sparkles size={12} />} {hasDraft ? '重新生成' : '开始生成'}
        </button>
        {streaming && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>点右侧控制台「停止」可中断</span>}
      </div>

      {/* 草稿视图 */}
      {hasDraft && (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: 10 }}>
          {/* 覆盖率条 */}
          {coverage && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
                <strong>覆盖度 {coverage.rate}%</strong>
                <span style={{ color: 'var(--text-muted)' }}>{coverage.covered}/{coverage.total} 需求已覆盖 · 共 {draftCases.length} 条用例</span>
                {snap.result?.truncated && <span style={{ color: 'var(--warning, #c80)', fontSize: 11 }}>⚠ 部分输出被截断，已保留成功部分</span>}
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2, var(--border))', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, coverage.rate))}%`, background: 'var(--accent)' }} />
              </div>
              {uncovered.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 11, color: 'var(--warning, #c80)' }}>
                  ⚠ {uncovered.length} 条需求未生成用例：{uncovered.slice(0, 6).map((u) => u.reqNo).join('、')}{uncovered.length > 6 ? '…' : ''}
                  <button onClick={regenerate} disabled={streaming} className="tbtn-anim" title="对未覆盖需求再补生成一轮" aria-label="补生成" style={opBtn}>
                    <RefreshCw size={11} /> 补生成
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 分组用例 */}
          <div style={{ maxHeight: 380, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            {groups.map((g) => {
              const reqTitle = g.req?.title ?? '';
              return (
                <div key={g.reqNo} style={{ borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'var(--surface-2, var(--card-bg))', fontSize: 12 }}>
                    <span style={{ fontWeight: 600 }}>{g.reqNo}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={reqTitle}>{reqTitle}</span>
                    {g.req?.isNew
                      ? <span style={{ fontSize: 10, color: 'var(--accent)' }}>🆕 将新建</span>
                      : <span style={{ fontSize: 10, color: 'var(--success)' }}><CircleCheck size={10} style={{ verticalAlign: 'middle' }} /> 已存在</span>}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>用例 {g.idxs.length} 条</span>
                  </div>
                  {g.idxs.map((idx) => {
                    const c = draftCases[idx];
                    return (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 18px', borderTop: '1px dashed var(--border)', fontSize: 12, opacity: c.alreadyImported ? 0.6 : 1 }}>
                        <input type="checkbox" checked={c.include !== false} disabled={c.alreadyImported}
                          onChange={(e) => updateCase(idx, { include: e.target.checked })} aria-label={`是否导入用例 ${idx + 1}`} />
                        <input value={c.title} disabled={c.alreadyImported}
                          onChange={(e) => updateCase(idx, { title: e.target.value })}
                          style={{ flex: 1, minWidth: 120, fontSize: 12, padding: '3px 6px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }} />
                        <input value={c.module} disabled={c.alreadyImported} placeholder="模块"
                          onChange={(e) => updateCase(idx, { module: e.target.value })}
                          style={{ width: 88, fontSize: 11, padding: '3px 6px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }} />
                        <select value={c.priority} disabled={c.alreadyImported} onChange={(e) => updateCase(idx, { priority: e.target.value })}
                          title="优先级" aria-label="用例优先级" style={{ fontSize: 11, padding: '2px 3px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
                          {(meta?.priority ?? [c.priority]).map((p) => <option key={p} value={p}>{enumLabel(meta, 'priorityLabel', p)}</option>)}
                        </select>
                        <select value={c.type} disabled={c.alreadyImported} onChange={(e) => updateCase(idx, { type: e.target.value })}
                          title="类型" aria-label="用例类型" style={{ fontSize: 11, padding: '2px 3px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
                          {(meta?.type ?? [c.type]).map((tp) => <option key={tp} value={tp}>{enumLabel(meta, 'typeLabel', tp)}</option>)}
                        </select>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 46, textAlign: 'right' }}>{c.steps.length} 步</span>
                        {c.alreadyImported
                          ? <span style={{ fontSize: 10, color: 'var(--success)' }}>已入库</span>
                          : <button onClick={() => removeCase(idx)} className="tbtn-anim" title="从草稿删除该用例" aria-label="删除用例" style={{ border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', display: 'inline-flex' }}><Trash2 size={12} /></button>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* 底部批量条 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button onClick={() => setAllInclude(true)} disabled={streaming} className="tbtn-anim" title="全选" style={opBtn}>全选</button>
            <button onClick={invertInclude} disabled={streaming} className="tbtn-anim" title="反选" style={opBtn}>反选</button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>选中 {selectedCount} / {draftCases.length} 条{pendingCount !== selectedCount ? `（待入库 ${pendingCount}）` : ''}</span>
            <span style={{ flex: 1 }} />
            <button onClick={clearDraft} disabled={streaming} className="tbtn-anim" title="清空草稿" style={opBtn}><X size={11} /> 清空</button>
            <button onClick={() => void doImport()} disabled={streaming || importing || pendingCount === 0} className="tbtn-anim"
              title="把勾选且未入库的用例导入项目（服务端单事务 + 幂等）" aria-label="确认导入"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, border: 'none', borderRadius: 6, background: pendingCount === 0 ? 'var(--border-strong)' : 'var(--accent)', color: pendingCount === 0 ? 'var(--text-muted)' : 'var(--accent-text)', cursor: streaming || importing || pendingCount === 0 ? 'default' : 'pointer', padding: '5px 12px' }}>
              {importing ? <Loader2 size={12} className="task-breathe" /> : <ListChecks size={12} />} 确认导入 {pendingCount} 条
            </button>
          </div>
        </div>
      )}

      {!hasDraft && !streaming && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 0' }}>
          选择目标项目与 PRD 来源后点「开始生成」；生成结果会进入下方草稿视图，勾选确认后入库。
        </div>
      )}

      {notice && <output className="flash-toast">{notice}</output>}
    </div>
  );
}
