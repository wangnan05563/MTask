import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AITool, type Project } from '../api/client';
import { Loader2, Save, Sparkles, Upload, X } from 'lucide-react';
import { useSessionState } from '../ui/session';

/** AI 解析出的计划草稿行（与后端 /plans/ai-parse* 返回对齐） */
interface PlanDraft {
  title: string;
  description: string;
  durationDays: number;
  assignee: string;
  status: string;
  startDate: string;
  include: boolean;
}
type AiRow = PlanDraft & { rowKey: string };

function updateAiRow(rows: AiRow[], idx: number, patch: Partial<PlanDraft>): AiRow[] {
  const next = [...rows];
  next[idx] = { ...next[idx], ...patch };
  return next;
}

function toPlanDraft(r: AiRow): Omit<PlanDraft, 'include'> {
  return {
    title: r.title,
    description: r.description,
    durationDays: r.durationDays,
    assignee: r.assignee,
    status: r.status,
    startDate: r.startDate,
  };
}

type LogLevel = 'info' | 'ok' | 'error';

/**
 * AI 项目计划导入面板（T00569 二轮：从项目计划页**完整迁移**至 AI 工作台，功能直接可用）。
 * 流程：选择项目 → 上传文件（.xlsx/.csv/.md/.docx）→ AI 解析 → 草稿预览可编辑 → 批量入库；
 * 「执行输出」为控制台式滚动日志区（各阶段实时输出，自动滚底），执行过程可见。
 */
export function AiPlanImportPanel({ onClose, onSaved }: { readonly onClose?: () => void; readonly onSaved?: (n: number) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tools, setTools] = useState<AITool[]>([]);
  const [projectId, setProjectId] = useSessionState<string>('ai-import.project', '');
  const [toolId, setToolId] = useSessionState<string>('ai-import.tool', '');
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<AiRow[]>([]);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<Array<{ t: string; level: LogLevel; msg: string }>>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const log = useCallback((msg: string, level: LogLevel = 'info') => {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs((prev) => [...prev, { t, level, msg }]);
  }, []);

  // 执行输出自动滚底（控制台滚动输出）
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(() => {
    void (async () => {
      try {
        const [ps, ts] = await Promise.all([api.get<Project[]>('/projects'), api.get<AITool[]>('/aitools').catch(() => [] as AITool[])]);
        setProjects(ps);
        setTools(ts);
        // T00534：统一以模型菜单默认配置为准——优先默认整理工具
        const def = ts.find((t) => t.isDefaultOrganize) ?? ts[0];
        if (def && !toolId) setToolId(def.id);
      } catch (e) {
        log(`初始化失败：${String((e as Error).message ?? e)}`, 'error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 上传文件 → 后端解析（Excel 表格文本 + AI 识别；md/docx 走 WBS 拆分）→ 草稿预览 */
  async function parse(file: File) {
    if (!projectId) { setError('请先选择目标项目'); log('缺少目标项目，已中止', 'error'); return; }
    if (!toolId) { setError('请先在「模型菜单」添加并选择 AI 模型'); log('缺少 AI 模型，已中止', 'error'); return; }
    setFileName(file.name);
    setBusy(true);
    setError('');
    setRows([]);
    log(`已选择文件：${file.name}（${(file.size / 1024).toFixed(1)} KB）`);
    try {
      const buf = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      const isDoc = lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.docx');
      log(isDoc ? '识别为需求文档 → 走 WBS 拆分解析' : '识别为表格文件 → 走表格字段解析');
      log('调用 AI 解析中，请稍候…');
      const r = await api.postBinary<{ ok: boolean; drafts: Array<Omit<PlanDraft, 'include'>> }>(
        `${isDoc ? '/plans/ai-parse-doc' : '/plans/ai-parse'}?projectId=${projectId}&toolId=${toolId}&filename=${encodeURIComponent(file.name)}`, buf);
      const list = r.drafts.map((d, i) => ({ ...d, include: true, startDate: d.startDate || '', rowKey: `ai-${Date.now()}-${i}` }));
      setRows(list);
      if (list.length === 0) {
        setError('AI 未识别出计划条目');
        log('AI 未识别出计划条目——请检查文件内容或更换模型', 'error');
      } else {
        log(`解析完成：识别到 ${list.length} 条计划草稿（默认全部勾选，可编辑后保存）`, 'ok');
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(msg);
      log(`解析失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 确认保存：勾选行批量创建，时间线统一重排 */
  async function save() {
    const items = rows.filter((r) => r.include && r.title.trim()).map(toPlanDraft);
    if (items.length === 0) { setError('请至少勾选一条要保存的条目'); log('未勾选任何条目，已中止保存', 'error'); return; }
    setBusy(true);
    setError('');
    log(`保存中：向项目写入 ${items.length} 条计划…`);
    try {
      const r = await api.post<{ inserted: number }>('/plans/batch', { projectId, items });
      log(`保存完成：已创建 ${r.inserted} 条计划，时间线已重排`, 'ok');
      setRows([]);
      onSaved?.(r.inserted);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(msg);
      log(`保存失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  const levelColor = (lv: LogLevel) => (lv === 'ok' ? 'var(--success, #16a34a)' : lv === 'error' ? 'var(--danger)' : 'var(--text-secondary)');

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Sparkles size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>AI 项目计划导入</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>上传 Excel/需求文档 → AI 解析 → 预览确认 → 批量入库（执行过程见下方控制台输出）</span>
        <span style={{ flex: 1 }} />
        {onClose && (
          <button onClick={onClose} className="tbtn-anim" title="收起面板" aria-label="收起 AI 导入面板"
            style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 6px' }}>
            <X size={13} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy}
          aria-label="目标项目" title="计划将导入到该项目"
          style={{ padding: 4, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">选择目标项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {tools.length > 1 && (
          <select value={toolId} onChange={(e) => setToolId(e.target.value)} disabled={busy}
            aria-label="AI 模型" title="解析所用 AI 模型（默认取模型菜单默认整理工具）"
            style={{ padding: 4, fontSize: 12, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
            {tools.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.model ?? t.type}）</option>)}
          </select>
        )}
        <label className="tbtn-anim" title="选择计划 Excel（.xlsx/.csv）或需求文档（.md/.docx）"
          style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 12 }}>
          <Upload size={13} /> 选择文件
          <input type="file" accept=".xlsx,.csv,.md,.markdown,.docx" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void parse(f); } e.target.value = ''; }} />
        </label>
        {fileName && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fileName}</span>}
        {busy && <span style={{ fontSize: 11, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Loader2 size={12} className="aispin" />处理中…</span>}
      </div>

      {/* 执行输出（控制台滚动日志） */}
      <div ref={logRef} role="log" aria-label="AI 导入执行输出"
        style={{ maxHeight: 170, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2, rgba(0,0,0,.03))', padding: '6px 8px', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.7 }}>
        {logs.length === 0
          ? <span style={{ color: 'var(--text-muted)' }}>等待执行…（选择项目与文件后，解析与入库过程将在此实时输出）</span>
          : logs.map((l, i) => (
            <div key={`${l.t}-${i}`} style={{ color: levelColor(l.level) }}>
              [{l.t}] {l.msg}
            </div>
          ))}
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{error}</div>}

      {rows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            解析到 {rows.length} 条（已勾选 {rows.filter((r) => r.include).length} 条）——可编辑后保存：
            <button onClick={() => setRows((prev) => prev.map((r) => ({ ...r, include: true })))} disabled={busy} title="全选" aria-label="全选草稿"
              style={{ marginLeft: 8, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 11, padding: '1px 6px', cursor: 'pointer' }}>全选</button>
            <button onClick={() => setRows((prev) => prev.map((r) => ({ ...r, include: false })))} disabled={busy} title="全不选" aria-label="全不选草稿"
              style={{ marginLeft: 4, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 11, padding: '1px 6px', cursor: 'pointer' }}>全不选</button>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: 4 }}>选</th>
                  <th style={{ padding: 4 }}>标题</th>
                  <th style={{ padding: 4 }}>工期(天)</th>
                  <th style={{ padding: 4 }}>开始日期</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.rowKey} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: 4 }}>
                      <input type="checkbox" checked={row.include} aria-label={`选中草稿 ${row.title}`}
                        onChange={(e) => setRows((prev) => updateAiRow(prev, i, { include: e.target.checked }))} />
                    </td>
                    <td style={{ padding: 4 }}>
                      <input value={row.title} onChange={(e) => setRows((prev) => updateAiRow(prev, i, { title: e.target.value }))}
                        aria-label="草稿标题"
                        style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12 }} />
                    </td>
                    <td style={{ padding: 4, width: 80 }}>
                      <input type="number" min={1} value={row.durationDays}
                        onChange={(e) => setRows((prev) => updateAiRow(prev, i, { durationDays: Number(e.target.value) || 1 }))}
                        aria-label="草稿工期"
                        style={{ width: 56, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, padding: '1px 4px' }} />
                    </td>
                    <td style={{ padding: 4, width: 130 }}>
                      <input type="date" value={row.startDate} onChange={(e) => setRows((prev) => updateAiRow(prev, i, { startDate: e.target.value }))}
                        aria-label="草稿开始日期"
                        style={{ border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, padding: '1px 4px' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={() => void save()} disabled={busy} className="tbtn-anim"
            title="保存勾选的草稿——批量创建到目标项目并重排时间线" aria-label="保存 AI 导入草稿"
            style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12, cursor: busy ? 'default' : 'pointer' }}>
            <Save size={13} /> 保存（{rows.filter((r) => r.include && r.title.trim()).length} 条）
          </button>
        </div>
      )}
    </div>
  );
}
