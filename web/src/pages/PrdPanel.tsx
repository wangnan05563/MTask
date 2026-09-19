import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { askConfirm, askInput } from '../ui/dialogs';
import { MarkdownContent } from '../ui/Markdown';
import { Check, FilePenLine, FilePlus2, Loader2, Pencil, Plus, RefreshCw, SendToBack, Trash2, Undo2, Upload, X } from 'lucide-react'; // T00770：PRD 管理视图

/** PRD 文档行（列表轻量；T00770 增加 status 流转） */
interface PrdDoc {
  id: string;
  filename: string;
  /** 'prd'=草稿/评审中 | 'confirmed'=确认版 */
  status: string;
  content_chars: number;
  updated_at: string;
}
/** 待确认问题（T00770） */
interface PrdIssue {
  id: string;
  prd_id: string | null;
  question: string;
  answer: string;
  /** 'open'=待确认 | 'resolved'=已确认 */
  status: string;
  updated_at: string;
}

/**
 * PRD 管理视图（T00770）：项目内 PRD 文档全生命周期（导入/新建/编辑/查看/删除/状态流转）
 * + 待确认问题记录（新增/编辑/确认/回写 PRD）。位于需求跟踪矩阵面板上方展开，与其同风格。
 */
export function PrdPanel({ projectId, onClose }: {
  readonly projectId: string;
  readonly onClose: () => void;
}) {
  const [docs, setDocs] = useState<PrdDoc[]>([]);
  const [issues, setIssues] = useState<PrdIssue[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [detail, setDetail] = useState<{ filename: string; content_md: string } | null>(null);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [editMd, setEditMd] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };
  const selected = docs.find((d) => d.id === selectedId) ?? null;
  const confirmedCount = docs.filter((d) => d.status === 'confirmed').length;
  const openIssues = issues.filter((i) => i.status === 'open').length;

  const load = useCallback(async () => {
    const [ds, is] = await Promise.all([
      api.get<PrdDoc[]>(`/plans/prd-docs?projectId=${projectId}`),
      api.get<PrdIssue[]>(`/plans/prd-issues?projectId=${projectId}`).catch(() => []),
    ]);
    setDocs(ds);
    setIssues(is);
    return ds;
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  /** 选中/切换文档：拉详情，进入查看态 */
  async function openDoc(id: string) {
    if (id === selectedId && mode === 'view') { setSelectedId(''); setDetail(null); return; }
    // T00783-L4：编辑态点击同一文档行会重新拉详情覆盖 editMd，静默丢弃未保存编辑——直接忽略本次点击
    if (id === selectedId && mode === 'edit') return;
    setSelectedId(id);
    setMode('view');
    setDetail(null); // null = 加载中
    try {
      const d = await api.get<{ filename: string; content_md: string }>(`/plans/prd-docs/${id}`);
      setDetail({ filename: d.filename, content_md: d.content_md });
    } catch (e) {
      setDetail(null);
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function createDoc() {
    const name = await askInput({ title: '新建 PRD 文档', placeholder: '文档名（如：订单中心 PRD v1）' });
    if (name === null) return;
    if (!name.trim()) return flash('文档名不能为空');
    try {
      const d = await api.post<PrdDoc>('/plans/prd-docs', { projectId, filename: name.trim(), contentMd: `# ${name.trim()}\n\n` });
      flash('已新建 PRD 文档');
      await load();
      await openDoc(d.id);
      setMode('edit');
      setEditMd(`# ${name.trim()}\n\n`);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** 导入 Markdown 文档（.md/.markdown/.txt 纯文本直读；.docx 请走「AI PRD 导入」流程提取正文） */
  async function importFile(file: File) {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      flash('仅支持 .md / .markdown / .txt 纯文本导入；.docx 请用「AI PRD 导入」解析后落库');
      return;
    }
    const name = await askInput({ title: '导入 PRD 文档', placeholder: '文档名（默认取文件名）' });
    if (name === null) return;
    try {
      const text = await file.text();
      const d = await api.post<PrdDoc>('/plans/prd-docs', { projectId, filename: name.trim() || file.name, contentMd: text });
      flash(`已导入「${d.filename}」`);
      await load();
      await openDoc(d.id);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function toggleStatus(d: PrdDoc) {
    const target = d.status === 'confirmed' ? 'prd' : 'confirmed';
    if (target === 'confirmed' && !(await askConfirm(`确认把「${d.filename}」流转为确认版？\n\n确认版 PRD 是进入需求跟踪矩阵的正式基线。`))) return;
    try {
      await api.patch(`/plans/prd-docs/${d.id}/status`, { status: target });
      flash(target === 'confirmed' ? '已确认为确认版 PRD' : '已转回草稿（PRD）');
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function removeDoc(d: PrdDoc) {
    if (!(await askConfirm(`删除 PRD 文档「${d.filename}」？\n\n其下待确认问题将一并删除，正文不可恢复。`))) return;
    try {
      await api.del(`/plans/prd-docs/${d.id}`);
      if (selectedId === d.id) { setSelectedId(''); setDetail(null); }
      flash('已删除 PRD 文档');
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  function startEdit() {
    if (!detail) return;
    setEditMd(detail.content_md);
    setMode('edit');
  }

  async function saveEdit() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api.put(`/plans/prd-docs/${selectedId}`, { contentMd: editMd });
      const d = await api.get<{ filename: string; content_md: string }>(`/plans/prd-docs/${selectedId}`);
      setDetail({ filename: d.filename, content_md: d.content_md });
      setMode('view');
      flash('PRD 内容已保存');
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  // ---- 待确认问题 ----

  async function addIssue() {
    const q = await askInput({
      title: selected ? `新增待确认问题（挂到「${selected.filename}」）` : '新增待确认问题（项目级）',
      placeholder: '待确认的问题描述',
    });
    if (q === null) return;
    if (!q.trim()) return flash('问题描述不能为空');
    try {
      await api.post('/plans/prd-issues', { projectId, prdId: selected?.id, question: q.trim() });
      flash('已新增待确认问题');
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function editIssue(i: PrdIssue) {
    const q = await askInput({ title: '编辑待确认问题', placeholder: '问题描述', defaultValue: i.question });
    if (!q?.trim()) return;
    try {
      await api.patch(`/plans/prd-issues/${i.id}`, { question: q.trim() });
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** 确认：填写结论并把状态置 resolved */
  async function resolveIssue(i: PrdIssue) {
    const a = await askInput({ title: `确认问题 — ${i.question}`, placeholder: '确认结论（将可回写 PRD）' });
    if (a === null) return;
    if (!a.trim()) return flash('结论不能为空');
    try {
      await api.patch(`/plans/prd-issues/${i.id}`, { answer: a.trim(), status: 'resolved' });
      flash('问题已确认，可回写 PRD');
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function reopenIssue(i: PrdIssue) {
    try {
      await api.patch(`/plans/prd-issues/${i.id}`, { status: 'open' });
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function writeback(i: PrdIssue) {
    const docName = docs.find((d) => d.id === i.prd_id)?.filename ?? '对应 PRD';
    if (!(await askConfirm(`把「${i.question}」的结论回写到「${docName}」？\n\n将写入文档的「待确认问题结论」节。`))) return;
    try {
      await api.post(`/plans/prd-issues/${i.id}/writeback`);
      flash('结论已回写 PRD');
      await load();
      if (selectedId === i.prd_id) {
        const d = await api.get<{ filename: string; content_md: string }>(`/plans/prd-docs/${selectedId}`);
        setDetail({ filename: d.filename, content_md: d.content_md });
        setMode('view');
      }
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function removeIssue(i: PrdIssue) {
    if (!(await askConfirm(`删除待确认问题「${i.question}」？`))) return;
    try {
      await api.del(`/plans/prd-issues/${i.id}`);
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  const opBtn = { display: 'inline-flex', alignItems: 'center', fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 7px' } as const;

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <FilePenLine size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>PRD 管理</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          共 {docs.length} 份文档（确认版 {confirmedCount} 份），待确认问题 {openIssues} 个；PRD → 确认版 → 需求跟踪矩阵
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => { void createDoc(); }} className="tbtn-anim" title="新建 PRD 文档" style={opBtn}><FilePlus2 size={12} /> 新建</button>
        <label className="tbtn-anim" title="导入 PRD 文档（.md / .markdown / .txt；.docx 请用 AI PRD 导入）"
          style={{ ...opBtn, display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
          <Upload size={12} /> 导入
          <input type="file" accept=".md,.markdown,.txt" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void importFile(f); } e.target.value = ''; }} />
        </label>
        <button onClick={() => { void load(); }} className="tbtn-anim" title="刷新" style={opBtn}><RefreshCw size={12} /></button>
        <button onClick={onClose} className="tbtn-anim" title="关闭" aria-label="关闭 PRD 管理" style={opBtn}><X size={12} /></button>
      </div>

      {/* 文档列表 */}
      {docs.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>当前项目还没有 PRD 文档——新建一份或导入 Markdown 文件开始。</div>}
      {docs.map((d) => (
        <div key={d.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 6, flexWrap: 'wrap',
            background: selectedId === d.id ? 'var(--accent-weak, rgba(0,0,0,.04))' : 'transparent',
            border: selectedId === d.id ? '1px solid var(--accent)' : '1px solid transparent' }}>
          <button type="button" onClick={() => { void openDoc(d.id); }}
            title="点击展开/收起文档内容"
            style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, flexWrap: 'wrap', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textAlign: 'left', color: 'inherit', font: 'inherit' }}>
            <FilePenLine size={13} style={{ color: d.status === 'confirmed' ? 'var(--success)' : 'var(--text-muted)', flex: 'none' }} />
            <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename || '未命名'}</span>
            <span title={d.status === 'confirmed' ? '确认版 PRD' : 'PRD（草稿/评审中）'}
              style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, flex: 'none',
                border: `1px solid ${d.status === 'confirmed' ? 'var(--success)' : 'var(--border-strong)'}`,
                color: d.status === 'confirmed' ? 'var(--success)' : 'var(--text-muted)' }}>
              {d.status === 'confirmed' ? '确认版' : 'PRD'}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{d.content_chars} 字 · {d.updated_at.slice(0, 10)}</span>
          </button>
          <span style={{ display: 'inline-flex', gap: 5 }}>
            <button onClick={() => { void toggleStatus(d); }} className="tbtn-anim" title={d.status === 'confirmed' ? '转回草稿（PRD）' : '确认为确认版 PRD'} style={opBtn}>
              {d.status === 'confirmed' ? <Undo2 size={11} /> : <Check size={11} />}
            </button>
            <button onClick={() => { void removeDoc(d); }} className="tbtn-anim" title="删除文档" style={{ ...opBtn, color: 'var(--danger)' }}><Trash2 size={11} /></button>
          </span>
        </div>
      ))}

      {/* 文档详情：查看（渲染）/ 编辑（Markdown 源码） */}
      {selectedId && (
        <div style={{ marginTop: 10, border: '1px solid var(--border-strong)', borderRadius: 8, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 12 }}>{detail?.filename || selected?.filename}</strong>
            <span style={{ flex: 1 }} />
            {mode === 'view' && (
              <button onClick={startEdit} className="tbtn-anim" title="编辑 Markdown 原文" style={opBtn} disabled={!detail}><Pencil size={11} /> 编辑</button>
            )}
            {mode === 'edit' && (
              <>
                <button onClick={() => { void saveEdit(); }} className="tbtn-anim" title="保存（全量覆盖）" style={{ ...opBtn, borderColor: 'var(--accent)', color: 'var(--accent)' }} disabled={busy}>
                  {busy ? <Loader2 size={11} className="task-breathe" /> : <Check size={11} />} 保存
                </button>
                <button onClick={() => { setMode('view'); }} title="取消编辑" style={opBtn}>取消</button>
              </>
            )}
          </div>
          {mode === 'view' && (
            detail
              ? <MarkdownContent content={detail.content_md} style={{ fontSize: 12, maxHeight: 360, overflow: 'auto', padding: '2px 4px' }} />
              : <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={12} className="task-breathe" /> 加载中…</div>
          )}
          {mode === 'edit' && (
            <textarea value={editMd} onChange={(e) => setEditMd(e.target.value)} spellCheck={false}
              placeholder="Markdown 原文（# 标题 / - 列表 / **加粗** …）"
              style={{ width: '100%', minHeight: 260, fontSize: 12, lineHeight: 1.6, padding: 8, borderRadius: 6,
                border: '1px solid var(--border-strong)', background: 'var(--card-bg)', color: 'var(--text)', resize: 'vertical', boxSizing: 'border-box' }} />
          )}
        </div>
      )}

      {/* 待确认问题区 */}
      <div style={{ marginTop: 10, border: '1px solid var(--border-strong)', borderRadius: 8, padding: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 12 }}>待确认问题</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>确认后可把结论回写到对应 PRD</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => { void addIssue(); }} className="tbtn-anim" title={selected ? '新增问题（挂到当前选中文档）' : '新增项目级问题（先选中文档可自动挂靠）'} style={opBtn}>
            <Plus size={11} /> 新增
          </button>
        </div>
        {issues.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>暂无待确认问题。</div>}
        {issues.map((i) => {
          const docName = docs.find((d) => d.id === i.prd_id)?.filename ?? '';
          return (
            <div key={i.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 2px', flexWrap: 'wrap', borderBottom: '1px dashed var(--border-weak, var(--border-strong))' }}>
              <span title={i.status === 'resolved' ? '已确认' : '待确认'}
                style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, flex: 'none', marginTop: 1,
                  border: `1px solid ${i.status === 'resolved' ? 'var(--success)' : 'var(--warning, #c80)'}`,
                  color: i.status === 'resolved' ? 'var(--success)' : 'var(--warning, #c80)' }}>
                {i.status === 'resolved' ? '已确认' : '待确认'}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text)', minWidth: 0, flex: '1 1 260px' }}>
                {i.question}
                {i.status === 'resolved' && i.answer && (
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>结论：{i.answer}</span>
                )}
              </span>
              {docName && <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 'none' }} title="问题挂靠的 PRD 文档">📄 {docName}</span>}
              <span style={{ display: 'inline-flex', gap: 5, flex: 'none' }}>
                <button onClick={() => { void editIssue(i); }} className="tbtn-anim" title="编辑问题" style={opBtn}><Pencil size={11} /></button>
                {i.status === 'open'
                  ? <button onClick={() => { void resolveIssue(i); }} className="tbtn-anim" title="填写结论并确认" style={opBtn}><Check size={11} /></button>
                  : <>
                      {i.prd_id && <button onClick={() => { void writeback(i); }} className="tbtn-anim" title="把结论回写 PRD" style={opBtn}><SendToBack size={11} /></button>}
                      <button onClick={() => { void reopenIssue(i); }} className="tbtn-anim" title="重开（转回待确认）" style={opBtn}><Undo2 size={11} /></button>
                    </>}
                <button onClick={() => { void removeIssue(i); }} className="tbtn-anim" title="删除问题" style={{ ...opBtn, color: 'var(--danger)' }}><Trash2 size={11} /></button>
              </span>
            </div>
          );
        })}
      </div>

      {notice && <output className="flash-toast">{notice}</output>}
    </div>
  );
}
