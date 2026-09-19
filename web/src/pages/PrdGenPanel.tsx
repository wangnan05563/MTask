import { useEffect, useState } from 'react';
import { api, type Project } from '../api/client';
import { streamEvents } from '../api/sse';
import { useSessionState } from '../ui/session';
import { MarkdownContent } from '../ui/Markdown';
import { prdGenStore, usePrdGen, type PrdGenIssue } from '../stores/prdGenStore';
import { CircleCheck, FileText, Loader2, Plus, Save, Sparkles, Trash2, Upload, X } from 'lucide-react';

/** T00769：交互确认表格行（AI 生成问题 + 用户自定义），answer 非空视为已确认 */
interface IssueRow extends PrdGenIssue { answer: string; key: string; }

const LEVEL_META: Record<string, { label: string; color: string }> = {
  blocker: { label: '🔴 阻塞', color: 'var(--danger, #c22)' },
  suggested: { label: '🟡 建议', color: 'var(--warning, #c80)' },
  info: { label: '🟢 提示', color: 'var(--success)' },
  custom: { label: '自定义', color: 'var(--accent)' },
};

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
  const { streaming, result } = snap;

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };
  useEffect(() => {
    void api.get<Project[]>('/projects').then(setProjects).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 生成完成 → 问题清单填充交互表格 */
  useEffect(() => {
    if (result) {
      const stamp = Date.now();
      setRows(result.issues.map((x, i) => ({ ...x, answer: '', key: `gi-${stamp}-${i}` })));
    }
  }, [result]);

  /** 上传并流式生成：base64 进 JSON 走 streamEvents（SSE：stage/chunk/done/error） */
  async function generate(file: File) {
    if (!projectId) { flash('请先选择目标项目'); prdGenStore.pushLog('缺少目标项目，已中止'); return; }
    if (!toolId) { flash('请先在控制台选择 AI 模型（顶部模型下拉）'); prdGenStore.pushLog('缺少 AI 模型，已中止', ); return; }
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.doc')) { flash('老式 .doc 请先用 Word 另存为 .docx'); return; }
    if (lower.endsWith('.xls')) { flash('老式 .xls 请先用 Excel 另存为 .xlsx'); return; }
    if (!/\.(docx|xlsx|csv|md|markdown|txt)$/i.test(lower)) { flash('支持的格式：.docx/.xlsx/.csv/.md/.txt'); return; }
    prdGenStore.begin();
    prdGenStore.pushLog(`已选择原始需求文件：${file.name}（${(file.size / 1024).toFixed(1)} KB）`);
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
      );
      if (errMsg) throw new Error(errMsg);
      prdGenStore.finish();
      prdGenStore.pushLog('生成完成：请在下方交互表格确认问题（结论将回写 PRD）');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      prdGenStore.finish(`生成失败：${msg}`);
    }
  }

  /** 回写并录入 PRD 管理视图：结论合入正文 → prd_docs + prd_issues 批量入库 */
  async function saveToPrdView(status: 'prd' | 'confirmed') {
    if (!result || !projectId) return;
    setSaving(true);
    try {
      const merged = mergeAnswers(result.prdMd, rows);
      // M-3：同日多份生成时自动加序号，避免 PRD 管理视图出现同名条目难以区分版本
      const base = `PRD-${new Date().toISOString().slice(0, 10)}`;
      const existing = await api.get<Array<{ filename: string }>>(`/plans/prd-docs?projectId=${projectId}`).catch(() => []);
      const taken = new Set((existing ?? []).map((d) => d.filename));
      let docName = `${base}.md`;
      let seq = 2;
      while (taken.has(docName)) { docName = `${base}(${seq}).md`; seq += 1; }
      const doc = await api.post<{ id: string }>('/plans/prd-docs', { projectId, filename: docName, contentMd: merged, status });
      const answered = rows.filter((r) => r.answer.trim());
      if (answered.length > 0) {
        await api.post('/plans/prd-issues/batch', {
          projectId, prdId: doc.id,
          items: answered.map((r) => ({ question: r.question, answer: r.answer, level: r.level || 'custom' })),
        });
      }
      flash(`已录入 PRD 管理视图：${docName}（${status === 'confirmed' ? '确认版' : 'PRD'}，含问题 ${answered.length} 条）`);
      prdGenStore.pushLog(`已录入 PRD 管理视图：${docName}（${status === 'confirmed' ? '确认版' : '草稿 PRD'}；问题 ${answered.length} 条同步入库）`);
      onSaved?.({ docs: 1, issues: answered.length });
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
        <label className="tbtn-anim" title="上传原始需求（.docx/.xlsx/.csv/.md/.txt；老式 .doc/.xls 请先另存）"
          style={{ ...opBtn, display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
          <Upload size={12} /> 上传原始需求
          <input type="file" accept=".doc,.docx,.xls,.xlsx,.csv,.md,.markdown,.txt" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void generate(f); } e.target.value = ''; }} />
        </label>
        {streaming && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--accent)' }}><Loader2 size={13} className="task-breathe" /> 生成中…（正文实时滚动至右侧控制台）</span>}
      </div>

      {/* 交互确认表格：AI 生成的待确认问题 + 用户自定义 */}
      {result && (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 12 }}>待确认问题（{rows.length} 条）</strong>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>填写结论即视为确认；结论将回写 PRD 并随问题入库</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { setRows([...rows, { level: 'custom', question: '', context: '', answer: '', key: `uc-${Date.now()}` }]); }}
              className="tbtn-anim" title="新增自定义问题" style={opBtn}><Plus size={11} /> 自定义问题</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-strong)', width: 70 }}>级别</th>
                <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-strong)' }}>问题</th>
                <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-strong)', width: '34%' }}>结论（填写即确认）</th>
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
              {rows.length === 0 && <tr><td colSpan={4} style={{ padding: 8, color: 'var(--text-muted)', fontSize: 11 }}>AI 未生成待确认问题——可直接新增自定义问题后录入。</td></tr>}
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
