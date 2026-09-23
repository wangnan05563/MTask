import { useEffect, useState } from 'react';
import { api, type Project } from '../api/client';
import { streamEvents } from '../api/sse';
import { useSessionState } from '../ui/session';
import { MarkdownContent } from '../ui/Markdown';
import { prdGenStore, usePrdGen, type PrdGenIssue } from '../stores/prdGenStore';
import { WorkspaceSelect } from '../ui/WorkspaceSelect'; // T00769 二轮：未绑定工作空间时原位提供绑定入口
import { CircleCheck, FileText, FolderOpen, Loader2, Plus, Save, Sparkles, Trash2, Upload, X } from 'lucide-react';

/** T00769：交互确认表格行（AI 生成问题 + 用户自定义），answer 非空视为已确认 */
interface IssueRow extends PrdGenIssue { answer: string; key: string; }

const LEVEL_META: Record<string, { label: string; color: string }> = {
  blocker: { label: '🔴 阻塞', color: 'var(--danger, #c22)' },
  suggested: { label: '🟡 建议', color: 'var(--warning, #c80)' },
  info: { label: '🟢 提示', color: 'var(--success)' },
  custom: { label: '自定义', color: 'var(--accent)' },
};

/** T00819：从 PRD 正文提取第一条一级标题作为文件名来源；无 `# ` 标题时返回空（走日期兜底） */
function extractPrdTitle(prdMd: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(prdMd.trim());
  return m ? m[1].trim() : '';
}

/** T00819：文件名安全化——替换操作系统非法字符与控制符，剔除首尾点；清空返回 ''（调用方回退兜底命名） */
function safeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/^\.+|\.+$/g, '');
}

// T00820：结论(填写即确认)的会话持久化键——存「正文指纹 → {问题:结论}」映射。
// 用 sessionStorage（非 localStorage）：只求切页/Tab 往返保留，新开会话或刷新后面板回到初始态、需重新生成。
const PRD_CONCL_KEY = 'prdGen.conclusion';

/** T00820：稳定字符串指纹（djb2），用正文 prdMd 区分"批"，同一批切换页可恢复、不同批不串 */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** T00820：读取某一批（按正文指纹）已填结论；无则返回空映射 */
function readConclusionBatch(prdMd: string): Record<string, string> {
  try {
    const m = JSON.parse(sessionStorage.getItem(PRD_CONCL_KEY) || '{}');
    return (m[hashStr(prdMd)] as Record<string, string>) || {};
  } catch { return {}; }
}

/** T00820：清理全部旧批结论——每次重新生成新 PRD 时调用，避免跨代数据残留与无限累积 */
function clearConclusionBatches(): void {
  try { sessionStorage.removeItem(PRD_CONCL_KEY); } catch { /* 忽略存储异常 */ }
}

/** 把已确认结论合入 PRD 正文（与 T00770 回写格式一致：文末「## 待确认问题结论」节） */
function mergeAnswers(prdMd: string, rows: IssueRow[]): string {
  const answered = rows.filter((r) => r.answer.trim());
  if (answered.length === 0) return prdMd;
  const SECTION = '## 待确认问题结论';
  const entries = answered
    .map((r) => `\n### Q：${r.question}\n\n**结论**：${r.answer.trim()}\n`)
    .join('\n');
  if (prdMd.includes(`\n${SECTION}\n`)) {
    const idx = prdMd.indexOf(`\n${SECTION}\n`);
    const insertAt = idx + 1 + SECTION.length + 1;
    return prdMd.slice(0, insertAt) + entries + '\n' + prdMd.slice(insertAt);
  }
  return `${prdMd.replace(/\n*$/, '\n\n')}${SECTION}\n${entries}\n`;
}

/**
 * 原始需求生成 PRD 面板（T00769）：上传原始需求（.docx/.xlsx/.csv/.md/.txt；老式 .doc/.xls 引导另存）→
 * 内置技能（原 bemp-generate-prd）+ 项目源码上下文 → SSE 流式生成 → 交互确认表格（AI 问题 + 自定义）→
 * 回写结论并录入「PRD 管理视图」（需求跟踪矩阵上方，T00770）。
 */
export function PrdGenPanel({ toolId, onClose, onSaved }: {
  readonly toolId: string;
  readonly onClose?: () => void;
  readonly onSaved?: (r: { docs: number; issues: number }) => void;
}) {
  const snap = usePrdGen();
  const [projects, setProjects] = useSessionState<Project[]>('prd-gen.projects.cache', []);
  const [projectId, setProjectId] = useSessionState<string>('prd-gen.project', '');
  const [rows, setRows] = useState<IssueRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  // T00841/T00891：待确认/待执行的已选原始需求文件列表——支持多选（multiple），选择仅入列表，
  // 用户点「确认」才逐份触发 generate；确认前每份可单独删除。多选是 T00891 的交互目标。
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  // T00933：批次里"当前正在查看/录入"的那一份（多选会产出多份 PRD，需可逐份切换，否则只能碰到最后一份）
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const { streaming } = snap;
  const activeItem = activeBatchId ? snap.batch.find((b) => b.id === activeBatchId) ?? null : null;
  const result = activeItem && !activeItem.failed
    ? { prdMd: activeItem.prdMd, issues: activeItem.issues }
    : snap.result;

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };
  useEffect(() => {
    void api.get<Project[]>('/projects').then(setProjects).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T00769 二轮：工作空间绑定状态——未绑定时缺少项目源码上下文，待确认问题识别质量显著下降
  const activeProject = projects.find((p) => p.id === projectId) ?? null;
  const wsPath = activeProject?.workspace_path ?? '';
  const wsMissing = !!projectId && !wsPath;

  /** 绑定工作空间（PATCH 持久化 + 本地列表回显，与任务菜单同语义） */
  async function bindWorkspace(path: string) {
    if (!projectId) { flash('请先选择目标项目'); return; }
    try {
      const updated = await api.patch<Project>(`/projects/${projectId}`, { workspacePath: path });
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, workspace_path: updated?.workspace_path ?? path } : p)));
      flash(`已绑定工作空间：${path} —— 重新生成即可带上项目源码上下文`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** T00933：批次跑完自动选中第一份成功结果——否则交互表格会停在"最后一份"或空白 */
  useEffect(() => {
    if (streaming) return;
    if (activeBatchId && snap.batch.some((b) => b.id === activeBatchId && !b.failed)) return;
    const first = snap.batch.find((b) => !b.failed);
    if (first) setActiveBatchId(first.id);
  }, [streaming, snap.batch, activeBatchId]);

  /** 生成完成 → 问题清单填充交互表格；若该批已有会话内暂存的结论则一并恢复（T00820 切页不丢） */
  useEffect(() => {
    if (result) {
      const batch = readConclusionBatch(result.prdMd);
      const stamp = Date.now();
      setRows(result.issues.map((x, i) => ({ ...x, answer: batch[x.question] ?? '', key: `gi-${stamp}-${i}` })));
    }
  }, [result]);

  // T00820：结论输入实时写入会话快照（按正文指纹分代存：{问题:结论}），切页返回据此恢复。
  // 只在填写非空结论时落盘，且同一批只保留最新值；rows 变化即同步，卸载前无需额外收尾。
  useEffect(() => {
    if (!result) return;
    const key = hashStr(result.prdMd);
    const collected: Record<string, string> = {};
    for (const r of rows) {
      if (r.answer.trim() && r.question.trim()) collected[r.question] = r.answer.trim();
    }
    try {
      const m = JSON.parse(sessionStorage.getItem(PRD_CONCL_KEY) || '{}');
      if (Object.keys(collected).length === 0) delete m[key];
      else m[key] = collected;
      sessionStorage.setItem(PRD_CONCL_KEY, JSON.stringify(m));
    } catch { /* 忽略存储异常 */ }
  }, [rows, result]);

  /**
   * 上传并流式生成：base64 进 JSON 走 streamEvents（SSE：stage/chunk/done/error）。
   * T00933：`batchCtx` 非空时表示处于多选批次中——不重建整批状态（否则会把前一份的结果与日志清掉），
   * 只重置本份的流式正文/结果，完成后把本份结果入册 `pushBatchItem`。
   * @returns 本份结果（批次由调用方汇总），单份流程仍按老语义返回
   */
  async function generate(file: File, batchCtx?: { index: number; total: number }): Promise<{ prdMd: string; issues: PrdGenIssue[] } | null> {
    if (!projectId) { flash('请先选择目标项目'); prdGenStore.pushLog('缺少目标项目，已中止'); return null; }
    if (!toolId) { flash('请先在控制台选择 AI 模型（顶部模型下拉）'); prdGenStore.pushLog('缺少 AI 模型，已中止', ); return null; }
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.doc')) { flash('老式 .doc 请先用 Word 另存为 .docx'); return null; }
    if (lower.endsWith('.xls')) { flash('老式 .xls 请先用 Excel 另存为 .xlsx'); return null; }
    if (!/\.(docx|xlsx|csv|md|markdown|txt)$/i.test(lower)) { flash('支持的格式：.docx/.xlsx/.csv/.md/.txt'); return null; }
    // T00820：重新生成即新批——清掉上一代结论快照，避免跨代串数据
    clearConclusionBatches();
    // T00933：批次内不重建整批状态（会清掉前一份结果与日志），单份流程仍走 begin
    if (batchCtx) prdGenStore.beginFile(batchCtx.index, file.name);
    else prdGenStore.begin();
    // T00838：登记本次生成的 AbortController，供控制台「停止」按钮跨组件中止
    const ac = new AbortController();
    prdGenStore.setAbortCtrl(ac);
    prdGenStore.pushLog(`已选择原始需求文件：${file.name}（${(file.size / 1024).toFixed(1)} KB）`);
    // 未绑定工作空间时把影响写进控制台，避免用户事后才发现"上下文没加载"
    if (!wsPath) prdGenStore.pushLog('⚠ 当前项目未绑定工作空间 —— 本次缺少项目源码上下文，待确认问题识别质量会下降（建议先在上方绑定工作空间）');
    let errMsg = '';
    try {
      const buf = await file.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
      const contentBase64 = btoa(bin);
      await streamEvents(
        `/plans/prd-generate-stream?projectId=${projectId}&toolId=${toolId}&filename=${encodeURIComponent(file.name)}`,
        { contentBase64 },
        (name, payload) => {
          if (name === 'stage') prdGenStore.pushLog((payload as { msg: string }).msg);
          else if (name === 'chunk') prdGenStore.appendText((payload as { text: string }).text);
          else if (name === 'done') prdGenStore.setResult(payload as { prdMd: string; issues: PrdGenIssue[] });
          else if (name === 'error') errMsg = (payload as { error: string }).error;
        },
        ac.signal,
      );
      if (errMsg) throw new Error(errMsg);
      const done = prdGenStore.get().result ?? null;
      // T00933：批次内本份结果入册（失败也记一条占位，面板可看出哪份没出结果）
      if (batchCtx) {
        prdGenStore.pushBatchItem({
          id: `${Date.now()}-${batchCtx.index}-${file.name}`,
          filename: file.name,
          prdMd: done?.prdMd ?? '',
          issues: done?.issues ?? [],
          failed: !done,
        });
        prdGenStore.pushLog(`「${file.name}」生成完成（第 ${batchCtx.index}/${batchCtx.total} 份）：PRD ${done?.prdMd.length ?? 0} 字符、待确认问题 ${done?.issues.length ?? 0} 条`);
      } else {
        prdGenStore.finish();
        prdGenStore.pushLog('生成完成：请在下方交互表格确认问题（结论将回写 PRD）');
      }
      return done;
    } catch (e) {
      // 用户「停止」主动中止：状态已由 prdGenStore.abort() 清空，不再追加失败日志
      if (ac.signal.aborted) return null;
      const msg = e instanceof Error ? e.message : String(e);
      if (batchCtx) {
        prdGenStore.pushBatchItem({
          id: `${Date.now()}-${batchCtx.index}-${file.name}`,
          filename: file.name, prdMd: '', issues: [], failed: true,
        });
        prdGenStore.pushLog(`「${file.name}」生成失败（第 ${batchCtx.index}/${batchCtx.total} 份）：${msg}`);
      } else {
        prdGenStore.finish(`生成失败：${msg}`);
      }
      return null;
    } finally {
      prdGenStore.setAbortCtrl(null);
    }
  }

  /** T00891：对整个批次串行生成——每个文件各自调 generate（后端按单文件产出 PRD/问题），
   *  逐份 await 避免并发覆盖流状态；任一份失败不中断后续，全部完成后统一提示。
   *  T00933：批次状态只在开头建一次（beginBatch），每份结果 pushBatchItem 入册——
   *  修正原先「每份都 begin()」导致前序文档结果被覆盖、多选只剩最后一份的缺陷。 */
  async function runBatchGenerate(files: File[]) {
    prdGenStore.beginBatch(files.length);
    let okCount = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const done = await generate(f, { index: i + 1, total: files.length });
        if (done) okCount += 1;
      } catch (e) {
        // generate 内部已捕获并落控制台；这里仅兜底入口主动抛出的异常
        prdGenStore.pushBatchItem({
          id: `${Date.now()}-${i + 1}-${f.name}`, filename: f.name, prdMd: '', issues: [], failed: true,
        });
        prdGenStore.pushLog(`「${f.name}」生成中止：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    prdGenStore.finishBatch(okCount);
  }

  /** 回写并录入 PRD 管理视图：结论合入正文 → prd_docs + prd_issues 批量入库 */
  async function saveToPrdView(status: 'prd' | 'confirmed') {
    if (!result || !projectId) return;
    setSaving(true);
    try {
      const merged = mergeAnswers(result.prdMd, rows);
      // M-3：同日多份生成时自动加序号，避免 PRD 管理视图出现同名条目难以区分版本
      // T00819：文件名优先取正文第一条一级标题（安全化后）；正文无标题或标题仅含非法字符时回退「PRD-日期」
      const titled = extractPrdTitle(merged);
      const base = titled ? safeFilename(titled) : `PRD-${new Date().toISOString().slice(0, 10)}`;
      // T00821：确认版录入走覆盖模式——按同源批次(originHash=正文指纹)识别已录入 PRD 覆盖、不重复新建；
      // 覆盖场景用基准文件名（不做加序号去重），命中同源由后端更新同一条；草稿录入保持原「加序号上新」逻辑。
      const overwrite = status === 'confirmed';
      const originHash = overwrite ? hashStr(result.prdMd) : '';
      let docName = `${base}.md`;
      if (!overwrite) {
        const existing = await api.get<Array<{ filename: string }>>(`/plans/prd-docs?projectId=${projectId}`).catch(() => []);
        const taken = new Set((existing ?? []).map((d) => d.filename));
        let seq = 2;
        while (taken.has(docName)) { docName = `${base}(${seq}).md`; seq += 1; }
      }
      const doc = await api.post<{ id: string }>('/plans/prd-docs', { projectId, filename: docName, contentMd: merged, status, originHash });
      // T00822：结转全部待确认问题（含未填结论的）——后端按 answer 是否非空自动定 status(已确认/待确认)。
      // 此前只结转 answer 非空的（rows.filter(trim)），未填结论的问题被丢弃不进 PRD 管理视图；现已全量提交。
      if (rows.length > 0) {
        await api.post('/plans/prd-issues/batch', {
          projectId, prdId: doc.id,
          items: rows.map((r) => ({ question: r.question, answer: r.answer, level: r.level || 'custom', suggestion: r.suggestion })),
        });
      }
      flash(`已录入 PRD 管理视图：${docName}（${status === 'confirmed' ? '确认版' : 'PRD'}，含问题 ${rows.length} 条）`);
      prdGenStore.pushLog(`已录入 PRD 管理视图：${docName}（${status === 'confirmed' ? '确认版' : '草稿 PRD'}；问题 ${rows.length} 条同步入库）`);
      // T00821：确认版录入成功 → 自动切到「项目管理」并打开当前项目的 PRD 管理视图。
      // 只在成功返回后执行；写入 PlanPage 的会话态(plan.projectId/plan.showPrd)并触发全局 Tab 切换，异常不阻断已完成的录入。
      if (overwrite) {
        try {
          sessionStorage.setItem('plan.projectId', JSON.stringify(projectId));
          sessionStorage.setItem('plan.showPrd', JSON.stringify(true));
          globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } }));
        } catch { /* 跳转异常静默，录入已成功 */ }
      }
      onSaved?.({ docs: 1, issues: rows.length });
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const opBtn = { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 7px' } as const;

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <Sparkles size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>原始需求生成 PRD</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          内置技能（bemp-generate-prd）+ 项目源码上下文 → 生成标准化 PRD + 待确认问题；确认后录入 PRD 管理视图；过程见右侧控制台
        </span>
        <span style={{ flex: 1 }} />
        {onClose && (
          <button onClick={onClose} className="tbtn-anim" title="收起面板" aria-label="收起原始需求生成 PRD 面板" style={opBtn}><X size={13} /></button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={streaming}
          title="目标项目 — 生成的 PRD 将挂到该项目" aria-label="选择目标项目"
          style={{ padding: 6, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', minWidth: 180 }}>
          <option value="">选择项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label className="tbtn-anim" title="选择原始需求（.docx/.xlsx/.csv/.md/.txt；老式 .doc/.xls 请先另存）——支持一次选择多个"
          style={{ ...opBtn, display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
          <Upload size={12} /> 选择原始需求
          <input type="file" multiple accept=".doc,.docx,.xls,.xlsx,.csv,.md,.markdown,.txt" style={{ display: 'none' }}
            onChange={(e) => {
              // T00891：多选——逐个校验合法格式，非法的即时拒绝、合法者全部入列表；
              // 校验规则与 generate 内一致（T00841），保证入列即可用、避免确认时才报错
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length === 0) return;
              const valid: File[] = [];
              for (const f of files) {
                const lower = f.name.toLowerCase();
                if (lower.endsWith('.doc')) { flash(`「${f.name}」老式 .doc 请先用 Word 另存为 .docx`); continue; }
                if (lower.endsWith('.xls')) { flash(`「${f.name}」老式 .xls 请先用 Excel 另存为 .xlsx`); continue; }
                if (!/\.(docx|xlsx|csv|md|markdown|txt)$/i.test(lower)) { flash(`「${f.name}」不支持的格式（支持 .docx/.xlsx/.csv/.md/.txt）`); continue; }
                valid.push(f);
              }
              if (valid.length === 0) return;
              // 列表式追加（不去重）：同一批选同名的不同路径文件也应各自保留
              setPickedFiles((prev) => [...prev, ...valid]);
            }} />
        </label>
        {/* T00769 二轮：未绑定工作空间 → 原位警示 + 绑定入口（不阻断生成，但明确告知质量影响） */}
        {wsMissing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', width: '100%', padding: '6px 8px', marginBottom: 4, border: '1px solid var(--warning, #c80)', borderRadius: 6, background: 'var(--card-bg)', fontSize: 11, color: 'var(--warning, #c80)' }}>
            <FolderOpen size={13} style={{ flexShrink: 0 }} />
            <span>当前项目未绑定工作空间 —— 缺少项目源码上下文，待确认问题的识别质量会明显下降。</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: 'var(--text-muted)' }}>绑定后再生成：</span>
            <WorkspaceSelect project={activeProject} onBind={bindWorkspace} flash={flash} />
          </div>
        )}
        {streaming && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--accent)' }}><Loader2 size={13} className="task-breathe" /> 生成中…（正文实时滚动至右侧控制台）</span>}
      </div>

      {/* T00841/T00891：已选文件列表——支持多选，选择仅入列表不执行，用户点「确认」才逐份触发 generate；每份确认前可单独删除 */}
      {pickedFiles.length > 0 && (
        <div style={{ marginBottom: 10, border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>
            <FileText size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            已选 {pickedFiles.length} 个原始需求文件（确认后将逐个生成 PRD）
          </div>
          {pickedFiles.map((f, idx) => (
            <div key={`${f.name}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderTop: '1px solid var(--border-weak, var(--border-strong))' }}>
              <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={f.name}>{f.name}</span>
              <button onClick={() => setPickedFiles((prev) => prev.filter((_, i) => i !== idx))} className="tbtn-anim"
                title="删除 — 从已选列表中移除该文件，不再参与生成" aria-label="删除：移除已选文件"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px' }}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '6px 10px', borderTop: '1px solid var(--border-weak, var(--border-strong))' }}>
            <span style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>{streaming ? '生成中…' : ''}</span>
            <button onClick={() => { if (pickedFiles.length === 0) return; const files = pickedFiles; setPickedFiles([]); void runBatchGenerate(files); }} disabled={streaming} className="tbtn-anim"
              title="确认 — 对已选的全部原始需求文件逐个开始生成 PRD" aria-label="确认：对全部已选文件生成 PRD"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, border: 'none', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)', cursor: streaming ? 'default' : 'pointer', padding: '4px 10px' }}>
              <Sparkles size={12} /> 确认（{pickedFiles.length}）
            </button>
          </div>
        </div>
      )}

      {/* T00933：批次结果列表——多选时每份 PRD 都留在这里，可逐份切换查看/录入（原先只有最后一份能碰到） */}
      {snap.batch.length > 0 && (
        <div style={{ marginBottom: 10, border: '1px solid var(--border-strong)', borderRadius: 8, background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>
            <FileText size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            批次结果 {snap.batch.filter((b) => !b.failed).length}/{snap.batch.length} 份（点某一行切换当前查看与录入的对象）
          </div>
          {snap.batch.map((b, i) => {
            const active = b.id === activeBatchId;
            return (
              <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderTop: '1px solid var(--border-weak, var(--border-strong))', background: active ? 'var(--surface-2, var(--card-bg))' : undefined }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>第 {i + 1} 份</span>
                <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={b.filename}>{b.filename}</span>
                {b.failed
                  ? <span style={{ fontSize: 11, color: 'var(--danger)', flexShrink: 0 }}>生成失败</span>
                  : <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>PRD {b.prdMd.length} 字 / 问题 {b.issues.length} 条</span>}
                <button onClick={() => setActiveBatchId(b.id)} disabled={b.failed} className="tbtn-anim"
                  title={b.failed ? '该份生成失败，无法查看' : `载入 — 查看并录入「${b.filename}」的 PRD 与待确认问题`}
                  aria-label={b.failed ? `载入第${i + 1}份结果：${b.filename}（不可用）` : `载入第${i + 1}份结果：${b.filename}`}
                  style={{ fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, background: active ? 'var(--accent)' : 'transparent', color: active ? 'var(--accent-text)' : 'var(--text)', cursor: b.failed ? 'default' : 'pointer', padding: '2px 8px' }}>
                  {active ? '当前' : '载入'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 交互确认表格：AI 生成的待确认问题 + 用户自定义 */}
      {result && (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 12 }}>待确认问题（{rows.length} 条）</strong>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>填写结论即视为确认；结论将回写 PRD 并随问题入库</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { setRows([...rows, { level: 'custom', question: '', context: '', suggestion: '', answer: '', key: `uc-${Date.now()}` }]); }}
              className="tbtn-anim" title="新增自定义问题" style={opBtn}><Plus size={11} /> 自定义问题</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-strong)', width: 70 }}>级别</th>
                <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-strong)' }}>问题</th>
                {/* T00817：AI 建议列——展示 AI 为每条问题生成的建议选项，辅助决策 */}
                <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-strong)', width: '34%' }}>AI建议（可编辑）</th>
                <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-strong)', width: '30%' }}>结论（填写即确认）</th>
                <th style={{ width: 36 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ padding: '4px 6px', borderBottom: '1px dashed var(--border-strong)' }}>
                    <span style={{ fontSize: 10, color: LEVEL_META[r.level]?.color }}>{LEVEL_META[r.level]?.label ?? r.level}</span>
                  </td>
                  <td style={{ padding: '4px 6px', borderBottom: '1px dashed var(--border-strong)' }}>
                    {r.level === 'custom'
                      ? <input value={r.question} onChange={(e) => setRows(rows.map((x) => x.key === r.key ? { ...x, question: e.target.value } : x))}
                          placeholder="自定义问题描述" style={{ width: '100%', fontSize: 12, padding: '3px 6px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box' }} />
                      : <span title={r.context}>{r.question}</span>}
                  </td>
                  <td style={{ padding: '4px 6px', borderBottom: '1px dashed var(--border-strong)' }}>
                    <textarea value={r.suggestion} onChange={(e) => setRows(rows.map((x) => x.key === r.key ? { ...x, suggestion: e.target.value } : x))}
                      rows={2} placeholder="（无 AI 建议，可手动填写）"
                      style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text-secondary)', resize: 'vertical' }} />
                  </td>
                  <td style={{ padding: '4px 6px', borderBottom: '1px dashed var(--border-strong)' }}>
                    <input value={r.answer} onChange={(e) => setRows(rows.map((x) => x.key === r.key ? { ...x, answer: e.target.value } : x))}
                      placeholder="填写结论…"
                      style={{ width: '100%', fontSize: 12, padding: '3px 6px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box' }} />
                  </td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px dashed var(--border-strong)', textAlign: 'center' }}>
                    <button onClick={() => setRows(rows.filter((x) => x.key !== r.key))} className="tbtn-anim"
                      title="移除该问题" aria-label="移除问题" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)' }}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} style={{ padding: 8, color: 'var(--text-muted)', fontSize: 11 }}>AI 未生成待确认问题——可直接新增自定义问题后录入。</td></tr>}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={() => { void saveToPrdView('prd'); }} disabled={saving} className="tbtn-anim"
              title="回写结论并录入 PRD 管理视图（草稿）" style={{ ...opBtn, borderColor: 'var(--accent)', color: 'var(--accent)' }}>
              {saving ? <Loader2 size={11} className="task-breathe" /> : <Save size={11} />} 录入 PRD 管理视图（草稿）
            </button>
            <button onClick={() => { void saveToPrdView('confirmed'); }} disabled={saving} className="tbtn-anim"
              title="确认问题完毕后，以确认版状态录入（PRD 管理视图中标绿）" style={opBtn}>
              <CircleCheck size={11} /> 确认为确认版并录入
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>录入后可在「项目管理」→ 需求跟踪矩阵旁的 PRD 管理视图中查看与编辑</span>
          </div>
          {/* PRD 预览（渲染视图，折叠入口） */}
          <PrdPreview prdMd={result.prdMd} />
        </div>
      )}

      {notice && <output className="flash-toast">{notice}</output>}
    </div>
  );
}

/** PRD 渲染预览（默认收起，点击展开 MarkdownContent 渲染） */
function PrdPreview({ prdMd }: { readonly prdMd: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <button onClick={() => setOpen((v) => !v)} className="tbtn-anim"
        title={open ? '收起 PRD 预览' : '展开 PRD 渲染预览'} aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 7px' }}>
        <FileText size={11} /> {open ? '收起 PRD 预览' : '展开 PRD 预览（渲染视图）'}
      </button>
      {open && (
        <div style={{ marginTop: 8, border: '1px solid var(--border-strong)', borderRadius: 6, padding: 8, maxHeight: 360, overflow: 'auto' }}>
          <MarkdownContent content={prdMd} style={{ fontSize: 12 }} />
        </div>
      )}
    </div>
  );
}
