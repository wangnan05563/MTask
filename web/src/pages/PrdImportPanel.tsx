import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type Project } from '../api/client';
import { FileUp, Loader2, Save, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useSessionState } from '../ui/session';
import { aiImportStore } from '../stores/aiImportStore';

/** T00662：PRD 解析结果（需求项 + WBS 计划草稿） */
interface PrdReq { reqNo: string; title: string; content: string; sourceRef: string; priority: string; include: boolean; key: string; }
/** T01001：kind 可选——AI 解析出的里程碑/普通任务类型（后端可能未返回时缺省），编辑也是普通任务 */
interface PrdPlan { title: string; description: string; durationDays: number; reqNos: string[]; kind?: 'milestone' | 'normal' | 'daily'; include: boolean; key: string; }

/**
 * T01001 二轮：里程碑工期 = 其下明细任务工期之和。
 * 口径与项目管理页「里程碑汇总」一致：本里程碑之后、下一个里程碑之前的非里程碑行即其明细；
 * 只统计勾选（include）的明细，正好等于最终会导入的那些行（未勾选不入计划表）。
 * 里程碑自身工期不可手工调整，改任一明细即联动重算——修复「M1 工期 4、子任务合计 5 不相等」。
 */
function isMilestoneRow(p: Pick<PrdPlan, 'kind'>): boolean {
  return p.kind === 'milestone';
}

/** 重算全部里程碑工期（返回新数组；无明细的里程碑保留原值） */
function recalcMilestoneDurations(list: PrdPlan[]): PrdPlan[] {
  const out = list.map((p) => ({ ...p }));
  for (let i = 0; i < out.length; i++) {
    if (!isMilestoneRow(out[i])) continue;
    let sum = 0;
    for (let j = i + 1; j < out.length; j++) {
      if (isMilestoneRow(out[j])) break;
      if (out[j].include) sum += Math.max(1, Math.round(Number(out[j].durationDays) || 1));
    }
    if (sum > 0) out[i] = { ...out[i], durationDays: sum };
  }
  return out;
}

/** T00982：解析结果落盘键（与 useSessionState 同键）——切页恢复靠它们，改键名需同步改面板的读取键 */
const PERSIST_KEYS = {
  reqs: 'prd-import.reqs',
  plans: 'prd-import.plans',
  sources: 'prd-import.sources',
} as const;

/**
 * T00982：解析结果同步落盘。
 * 解析期间切页会让本面板卸载：React 会丢弃卸载后的 setState，而 useSessionState 的持久化写在
 * useEffect 里（卸载后不再执行）→ 解析出的需求/计划整批丢失，控制台却仍显示「解析完成」
 * （store 是模块级的，日志不受影响）。这里在解析完成时同步写一次会话存储，切回即可恢复。
 */
function persistParseResult(
  reqs: PrdReq[],
  plans: PrdPlan[],
  sources: { readonly name: string; readonly text: string }[],
): void {
  try {
    sessionStorage.setItem(PERSIST_KEYS.reqs, JSON.stringify(reqs));
    sessionStorage.setItem(PERSIST_KEYS.plans, JSON.stringify(plans));
    sessionStorage.setItem(PERSIST_KEYS.sources, JSON.stringify(sources));
  } catch {
    /* 配额不足等写入失败静默忽略，不阻塞解析流程 */
  }
}

/** T00662：单文件解析响应（/plans/ai-parse-prd） */
interface PrdParseResult {
  requirements: Array<{ reqNo: string; title: string; content: string; sourceRef: string; priority: string }>;
  drafts: Array<{ title: string; description: string; durationDays: number; reqNos: string[]; kind?: 'milestone' | 'normal' | 'daily' }>;
  coverageWarn?: string;
  /** T00908：后端随解析返回的 PRD 提取全文，供确认导入时落库到 PRD 管理视图 */
  textMd?: string;
}

/** T00824：多文件解析结果合并——统一重编号 REQ-001…（各文件 AI 都从 REQ-001 起号，直接拼接会重号），
 *  并把每份 WBS 草稿的 reqNos 经 old→new 映射转换，保证计划/需求关联在合并后仍指向正确的需求 */
function mergePrdResults(list: PrdParseResult[]): { requirements: PrdParseResult['requirements']; drafts: PrdParseResult['drafts'] } {
  const map = new Map<string, string>();
  const requirements: PrdParseResult['requirements'] = [];
  let n = 1;
  for (const r of list) {
    for (const x of r.requirements) {
      const nn = `REQ-${String(n++).padStart(3, '0')}`;
      map.set(x.reqNo, nn);
      requirements.push({ ...x, reqNo: nn });
    }
  }
  const drafts: PrdParseResult['drafts'] = [];
  for (const r of list) {
    for (const d of r.drafts) {
      drafts.push({ ...d, reqNos: d.reqNos.map((x) => map.get(x) ?? x) });
    }
  }
  return { requirements, drafts };
}

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
  // T00841：待解析的已选 PRD 文件——选择仅追加到列表，用户点「确认」才触发 parseAll；确认前可增删
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);

  // T00907：跳转自动带入标记——一次消费（读取即清），避免每次展开面板都重复触发
  const autoPullDone = useRef<boolean>(false);

  /** T00907：从 PRD 管理视图「从PRD导入项目计划」跳转而来时，自动读取所选 PRD 文档内容，
   *  构造为 File 填充「已选文件」确认栏（不自动触发 AI 解析，沿用 T00841「确认才解析」） */
  const autoPullDoc = useCallback(async (docId: string) => {
    try {
      const d = await api.get<{ filename: string; content_md: string }>(`/plans/prd-docs/${docId}`);
      const ext = (d.filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'md').toLowerCase();
      const file = new File([d.content_md], d.filename || `PRD-${docId}.md`,
        { type: ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain' });
      setPickedFiles((prev) => (prev.some((f) => f.name === file.name) ? prev : [...prev, file]));
      aiImportStore.log(`已自动带入所选 PRD：${file.name}——确认内容后点「确认」开始解析导入`, 'ok');
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: `自动带入所选 PRD 失败：${msg}` });
      aiImportStore.log(`自动带入所选 PRD 失败（已中止，可在面板内手动选择文件）：${msg}`, 'error');
    }
  }, []);

  // T00908：各源文件的 PRD 全文（解析时从 textMd 暂存）——确认导入时拼为 prdMd 落库 PRD 管理视图并关联需求矩阵
  // T00982：改会话级持久化——切页后回来仍要带着源文入库，否则会导入成"无 PRD 关联"的需求
  const [prdSources, setPrdSources] = useSessionState<{ name: string; text: string }[]>(PERSIST_KEYS.sources, []);

  // S2004：行字段更新回调下沉为组件级函数，避免 JSX 深层嵌套箭头
  const patchReq = (i: number, patch: Partial<PrdReq>) => setReqs((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // T01001 二轮：任何行变更（工期/勾选/类型）后都重算里程碑工期，保证"里程碑 = 其下明细之和"
  const patchPlan = (i: number, patch: Partial<PrdPlan>) =>
    setPlans((prev) => recalcMilestoneDurations(prev.map((x, j) => (j === i ? { ...x, ...patch } : x))));
  const { busy, fileName, error } = snap;

  useEffect(() => {
    aiImportStore.patch({ kind: 'prd' });
    void api.get<Project[]>('/projects').then(setProjects).catch(() => undefined);
    // T00907：消费「从 PRD 管理视图」跳转自动带入的文档标记（一次性，读取即清不重复触发）
    const docId = sessionStorage.getItem('prd-import.docId');
    if (docId && !autoPullDone.current) {
      autoPullDone.current = true;
      sessionStorage.removeItem('prd-import.docId');
      void autoPullDoc(docId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T00982：解析完成戳变化 → 重新从会话存储载入结果。
  // 覆盖两类切页时序：① 解析在卸载期间完成（切回来时挂载读取已在存储里）；
  // ② 已切回页面、解析随后完成（旧实例的 setState 被丢弃，靠本戳把结果拉回当前实例）。
  const parseStamp = snap.parseStamp ?? 0;
  useEffect(() => {
    if (!parseStamp) return;
    try {
      const r: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.reqs) ?? '[]');
      const p: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.plans) ?? '[]');
      const s: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.sources) ?? '[]');
      if (Array.isArray(r) && r.length > 0) setReqs(r as PrdReq[]);
      if (Array.isArray(p) && p.length > 0) setPlans(p as PrdPlan[]);
      if (Array.isArray(s) && s.length > 0) setPrdSources(s as { name: string; text: string }[]);
    } catch {
      /* 脏数据忽略：保留界面现有内容 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parseStamp]);

  /** T00824：多文件批量解析——逐文件调用单文件接口（串行避免激增 AI 并发），
   *  单文件失败记录日志并跳过其余继续；合并后统一重编号，供下方交互表格编辑/勾选 */
  const parseAll = useCallback(async (files: File[]) => {
    if (!projectId) { aiImportStore.patch({ error: '请先选择目标项目' }); aiImportStore.log('缺少目标项目，已中止', 'error'); return; }
    if (!toolId) { aiImportStore.patch({ error: '请先在控制台选择 AI 模型（顶部模型下拉）' }); aiImportStore.log('缺少 AI 模型（控制台未选择），已中止', 'error'); return; }
    if (files.length === 0) return;
    aiImportStore.reset('prd');
    setPrdSources([]); // T00908：重新解析即作废上一批暂存的 PRD 全文
    const total = files.length;
    aiImportStore.patch({ fileName: total > 1 ? `${total} 个文件` : files[0].name, busy: true });
    aiImportStore.log(`已选择 ${total} 个 PRD 文件：${files.map((f) => f.name).join('、')}`);
    const results: PrdParseResult[] = [];
    const sources: { name: string; text: string }[] = [];
    let firstError = '';
    for (let i = 0; i < total; i++) {
      const file = files[i];
      aiImportStore.log(`提取并解析（${i + 1}/${total}）：${file.name}…`);
      try {
        const buf = await file.arrayBuffer();
        const r = await api.postBinary<{ ok: boolean } & PrdParseResult>(
          `/plans/ai-parse-prd?projectId=${projectId}&toolId=${toolId}&filename=${encodeURIComponent(file.name)}`,
          buf,
        );
        results.push({ requirements: r.requirements ?? [], drafts: r.drafts ?? [], coverageWarn: r.coverageWarn });
        // T00908：暂存每份文件的 PRD 全文（供确认导入时落库 PRD 管理视图）
        if (r.textMd) sources.push({ name: file.name, text: r.textMd });
        aiImportStore.log(`✓ ${file.name}：需求 ${r.requirements?.length ?? 0} 条、WBS ${r.drafts?.length ?? 0} 条`, 'ok');
        if (r.coverageWarn) aiImportStore.log(r.coverageWarn, 'error');
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        firstError ||= msg;
        aiImportStore.log(`✗ ${file.name} 解析失败（已跳过，其余文件继续）：${msg}`, 'error');
      }
    }
    if (results.length === 0) {
      aiImportStore.patch({ error: firstError || '全部文件解析失败' });
      aiImportStore.log(`解析失败：${firstError || '全部文件解析失败'}`, 'error');
      aiImportStore.patch({ busy: false });
      return;
    }
    if (sources.length > 0) setPrdSources(sources);
    const { requirements, drafts } = mergePrdResults(results);
    const stamp = Date.now();
    const reqRows = requirements.map((x, i) => ({ ...x, include: true, key: `pr-${stamp}-${i}` }));
    // T01001 二轮：解析出来就先汇总一次里程碑工期（AI 给的里程碑工期与其明细合计常不相等）
    const planRows = recalcMilestoneDurations(drafts.map((x, i) => ({ ...x, include: true, key: `pp-${stamp}-${i}` })));
    setReqs(reqRows);
    setPlans(planRows);
    // T00982：同步落盘 + 递增完成戳（解析期间切页导致组件卸载时，这两处是结果不丢的关键）
    persistParseResult(reqRows, planRows, sources);
    aiImportStore.log(`解析完成（${results.length}/${total} 个文件）：合并需求 ${requirements.length} 条、WBS 计划 ${drafts.length} 条，编号已全局重排（REQ-001…），可编辑后导入`, 'ok');
    aiImportStore.patch({ busy: false, parseStamp: stamp });
  }, [projectId, toolId, setReqs, setPlans, setPrdSources]);

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
      // T00908：把暂存的源文件 PRD 全文拼为 prdMd 一并入库——后端落库 prd_docs（PRD 管理视图）并为需求行回填 prd_id 建立关联
      const prdMd = prdSources.map((s) => `# 来源：${s.name}\n\n${s.text}`).join('\n\n---\n\n');
      const prdFilename = prdSources.length > 1 ? `${prdSources.length} 个来源文件` : prdSources[0]?.name;
      const r = await api.post<{ requirements: number; plans: number; tasks: number; unlinkedReqNos?: string[]; prdId?: string }>('/plans/import-prd', {
        projectId,
        createTasks,
        requirements: rq.map(({ include: _inc, key: _key, ...rest }) => rest),
        plans: pl.map(({ include: _inc, key: _key, ...rest }) => ({ ...rest, reqNos: rest.reqNos.filter((n) => keptNos.has(n)) })),
        prdMd: prdMd || undefined,
        prdFilename: prdFilename || undefined,
      });
      const taskPart = r.tasks ? `、待办任务 ${r.tasks} 条` : '';
      const prdPart = r.prdId ? '；源 PRD 已录入「PRD 管理」并关联本次需求矩阵记录' : '';
      aiImportStore.log(`导入完成：需求 ${r.requirements} 条（已入需求跟踪矩阵）、计划 ${r.plans} 条${taskPart}${prdPart}`, 'ok');
      // T00712（D-5）：无效需求编号不再静默丢弃——服务端返回 unlinkedReqNos 时在控制台给出可感知告警
      if (r.unlinkedReqNos?.length) {
        aiImportStore.log(`告警：${r.unlinkedReqNos.length} 个需求编号未命中本次导入的需求（${r.unlinkedReqNos.join('、')}），其计划/待办关联已被忽略，请核对编号或先补导对应需求`, 'error');
      }
      // T00982：导入成功即清空完成戳，避免后续再按旧戳把已导入的结果拉回界面
      aiImportStore.patch({ lastSaved: r.plans, parseStamp: 0 });
      setReqs([]); setPlans([]); setPrdSources([]);
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
        <label className="tbtn-anim" title="选择 PRD 文件（可多选 .docx/.md/.markdown/.txt/.xlsx/.csv/.pdf，将合并分析为单一需求矩阵与项目计划）"
          style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 12 }}>
          <Upload size={13} /> 选择 PRD 文件{pickedFiles.length > 0 ? `（已选 ${pickedFiles.length}）` : ''}
          <input type="file" multiple accept=".docx,.md,.markdown,.txt,.xlsx,.csv,.pdf" style={{ display: 'none' }}
            onChange={(e) => {
              const fs = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = '';
              if (fs.length === 0) return;
              // 选择仅追加到待解析列表、不立即解析；确认后统一走 parseAll（T00841）
              setPickedFiles((prev) => [...prev, ...fs]);
            }} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}
          title="勾选后：WBS 节点同时生成待办任务（携带需求关联），便于 AI 推进执行">
          <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} style={{ cursor: 'pointer' }} />
          {' '}
          同步生成待办任务
        </label>
        {fileName && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fileName}</span>}
        {busy && <span style={{ fontSize: 11, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Loader2 size={12} className="aispin" />处理中…</span>}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {snap.logs.length > 0 ? `控制台已输出 ${snap.logs.length} 条执行日志 →` : '执行过程将在右侧 AI 控制台逐行输出'}
        </span>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {/* T00841：已选文件列表——选择仅入列表不解析，用户点「确认」才触发 parseAll；确认前可增删 */}
      {pickedFiles.length > 0 && (
        <div style={{ marginBottom: 10, border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <strong style={{ fontSize: 12 }}>已选文件（{pickedFiles.length}）</strong>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>确认后合并解析，可同步生成待办</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { const fs = pickedFiles; setPickedFiles([]); void parseAll(fs); }} disabled={busy} className="tbtn-anim"
              title="确认 — 用已选文件开始解析并导入项目计划" aria-label="确认：开始解析并导入"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, border: 'none', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)', cursor: busy ? 'default' : 'pointer', padding: '4px 10px' }}>
              <Sparkles size={12} /> 确认
            </button>
          </div>
          {pickedFiles.map((f, i) => (
            <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
              <FileUp size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={f.name}>{f.name}</span>
              <button onClick={() => setPickedFiles((prev) => prev.filter((_, j) => j !== i))} className="tbtn-anim"
                title="删除 — 从已选列表中移除该文件，不再参与解析" aria-label="删除：移除已选文件"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px' }}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

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
                          onChange={(e) => patchReq(i, { include: e.target.checked })} />
                      </td>
                      <td style={{ padding: 4, width: 88 }}>
                        <input value={r.reqNo} aria-label="需求编号" title={r.content || '（无详细描述）'}
                          onChange={(e) => patchReq(i, { reqNo: e.target.value })}
                          style={{ width: 80, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 11, padding: '1px 4px' }} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input value={r.title} aria-label="需求标题" title={r.content}
                          onChange={(e) => patchReq(i, { title: e.target.value })}
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
              WBS 计划 {plans.length} 条（勾选 {includedPlans}，其中里程碑 {plans.filter((x) => isMilestoneRow(x)).length} 条）——
              关联需求编号显示在标题后；里程碑工期为其下任务工期汇总，改任务即联动，不可手工调整
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>选</th>
                    <th style={{ padding: 4 }}>WBS 任务</th>
                    <th style={{ padding: 4 }}>类型</th>
                    <th style={{ padding: 4 }}>工期</th>
                    <th style={{ padding: 4 }}>关联需求</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p, i) => {
                    const ms = isMilestoneRow(p);
                    return (
                    <tr key={p.key} style={{ borderTop: '1px solid var(--border)', background: ms ? 'var(--border-weak, rgba(0,0,0,.03))' : undefined }}>
                      <td style={{ padding: 4 }}>
                        <input type="checkbox" checked={p.include} aria-label={`选中计划 ${p.title}`}
                          onChange={(e) => patchPlan(i, { include: e.target.checked })} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input value={p.title} aria-label="WBS 标题" title={p.description}
                          onChange={(e) => patchPlan(i, { title: e.target.value })}
                          style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, fontWeight: ms ? 700 : undefined }} />
                      </td>
                      {/* T01001 二轮：草稿表单标注任务类型（里程碑/任务），可手动纠正 AI 判定 */}
                      <td style={{ padding: 4, width: 78 }}>
                        <select value={p.kind ?? 'normal'} aria-label={`计划类型 ${p.title}`}
                          title={ms ? '里程碑 — 工期由其下任务汇总，不可手工调整' : '普通任务 — 工期可手工调整'}
                          onChange={(e) => patchPlan(i, { kind: e.target.value as PrdPlan['kind'] })}
                          style={{ width: 72, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: ms ? 'var(--accent)' : 'var(--text)', fontSize: 11, padding: '1px 2px' }}>
                          <option value="normal">任务</option>
                          <option value="milestone">里程碑</option>
                        </select>
                      </td>
                      <td style={{ padding: 4, width: 70 }}>
                        <input type="number" min={1} value={p.durationDays} aria-label="工期" readOnly={ms}
                          title={ms ? '里程碑工期 = 其下任务工期汇总（不可手工调整，改子任务即联动）' : '工期（天）'}
                          onChange={(e) => patchPlan(i, { durationDays: Number(e.target.value) || 1 })}
                          style={{ width: 50, border: '1px solid var(--border)', borderRadius: 4, background: ms ? 'transparent' : 'var(--card-bg)', color: ms ? 'var(--text-muted)' : 'var(--text)', fontSize: 12, padding: '1px 4px', fontWeight: ms ? 700 : undefined }} />
                      </td>
                      <td style={{ padding: 4, fontSize: 11, color: 'var(--accent)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.reqNos.join('、')}>
                        {p.reqNos.length > 0 ? p.reqNos.join('、') : '—'}
                      </td>
                    </tr>
                    );
                  })}
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
