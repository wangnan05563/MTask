import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, type Project } from '../api/client';
import { Save, Sparkles, Upload, X } from 'lucide-react';
import { useSessionState } from '../ui/session';
import { aiImportStore, type AiImportDraftRow } from '../stores/aiImportStore';

/**
 * AI 项目计划导入面板（T00569 三轮：与 AI 控制台**深度整合去重**）。
 * - 模型统一：直接使用 AI 控制台当前选择的模型（toolId prop），面板内不再重复模型下拉；
 * - 日志统一：执行输出写入模块级 store，由 AI 控制台的「AI 项目计划导入」tab 滚动展示，面板内不再重复日志区；
 * - 状态保持：文件/草稿/日志均在模块级 store，页面切换返回后完整保留（解析中切页也不中断）。
 */
export function AiPlanImportPanel({ toolId, onClose, onSaved }: {
  readonly toolId: string;
  readonly onClose?: () => void;
  readonly onSaved?: (n: number) => void;
}) {
  const snap = useSyncExternalStore(aiImportStore.subscribe, aiImportStore.getSnapshot);
  const [projects, setProjects] = useSessionState<Project[]>('ai-import.projects.cache', []);
  const [projectId, setProjectId] = useSessionState<string>('ai-import.project', '');
  const { busy, fileName, error, rows } = snap;

  useEffect(() => {
    void api.get<Project[]>('/projects').then(setProjects).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 上传文件 → 后端解析（Excel 表格文本 + AI 识别；md/docx 走 WBS 拆分）→ 草稿预览 */
  const parse = useCallback(async (file: File) => {
    if (!projectId) { aiImportStore.patch({ error: '请先选择目标项目' }); aiImportStore.log('缺少目标项目，已中止', 'error'); return; }
    if (!toolId) { aiImportStore.patch({ error: '请先在 AI 控制台选择 AI 模型（工具栏模型下拉）' }); aiImportStore.log('缺少 AI 模型（AI 控制台未选择），已中止', 'error'); return; }
    aiImportStore.patch({ fileName: file.name, busy: true, error: '', rows: [] });
    aiImportStore.log(`已选择文件：${file.name}（${(file.size / 1024).toFixed(1)} KB）`);
    try {
      const buf = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      const isDoc = lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.docx');
      aiImportStore.log(isDoc ? '识别为需求文档 → 走 WBS 拆分解析' : '识别为表格文件 → 走表格字段解析');
      aiImportStore.log('调用 AI 解析中（使用 AI 控制台当前模型），请稍候…');
      const r = await api.postBinary<{ ok: boolean; drafts: Array<Omit<AiImportDraftRow, 'include' | 'rowKey'>> }>(
        `${isDoc ? '/plans/ai-parse-doc' : '/plans/ai-parse'}?projectId=${projectId}&toolId=${toolId}&filename=${encodeURIComponent(file.name)}`, buf);
      const list: AiImportDraftRow[] = r.drafts.map((d, i) => ({ ...d, include: true, startDate: d.startDate || '', rowKey: `ai-${Date.now()}-${i}` }));
      aiImportStore.setRows(list);
      if (list.length === 0) {
        aiImportStore.patch({ error: 'AI 未识别出计划条目' });
        aiImportStore.log('AI 未识别出计划条目——请检查文件内容或更换模型', 'error');
      } else {
        aiImportStore.log(`解析完成：识别到 ${list.length} 条计划草稿（默认全部勾选，可编辑后保存）`, 'ok');
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`解析失败：${msg}`, 'error');
    } finally {
      aiImportStore.patch({ busy: false });
    }
  }, [projectId, toolId]);

  /** 确认保存：勾选行批量创建，时间线统一重排 */
  async function save() {
    const items = rows.filter((r) => r.include && r.title.trim());
    if (items.length === 0) { aiImportStore.patch({ error: '请至少勾选一条要保存的条目' }); aiImportStore.log('未勾选任何条目，已中止保存', 'error'); return; }
    aiImportStore.patch({ busy: true, error: '' });
    aiImportStore.log(`保存中：向项目写入 ${items.length} 条计划…`);
    try {
      const r = await api.post<{ inserted: number }>('/plans/batch', {
        projectId,
        // 提交体剔除前端草稿态字段（include/rowKey 不落库），其余字段原样提交
        items: items.map((row) => {
          const rest = { ...row } as Omit<AiImportDraftRow, 'include' | 'rowKey'> & { include?: unknown; rowKey?: unknown };
          delete rest.include;
          delete rest.rowKey;
          return rest;
        }),
      });
      aiImportStore.log(`保存完成：已创建 ${r.inserted} 条计划，时间线已重排`, 'ok');
      aiImportStore.patch({ rows: [], lastSaved: r.inserted });
      onSaved?.(r.inserted);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`保存失败：${msg}`, 'error');
    } finally {
      aiImportStore.patch({ busy: false });
    }
  }

  function updateRow(idx: number, patch: Partial<AiImportDraftRow>): void {
    aiImportStore.setRows(rows.map((r, j) => (j === idx ? { ...r, ...patch } : r)));
  }

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <Sparkles size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>AI 项目计划导入</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          上传 Excel/需求文档 → AI 解析 → 预览确认 → 批量入库；执行输出见右侧 AI 控制台「AI 项目计划导入」tab，模型使用控制台当前选择
        </span>
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
        <label className="tbtn-anim" title="选择计划 Excel（.xlsx/.csv）或需求文档（.md/.docx）"
          style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 12 }}>
          <Upload size={13} /> 选择文件
          <input type="file" accept=".xlsx,.csv,.md,.markdown,.docx" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void parse(f); } e.target.value = ''; }} />
        </label>
        {fileName && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fileName}</span>}
        {busy && <span className="ai-shimmer" style={{ fontSize: 11, fontWeight: 600, ['--ai-shimmer-color' as never]: 'var(--accent)' }}>处理中…</span>}
        {/* 面板内仅保留一行状态提示：完整滚动输出统一在右侧控制台 tab */}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {snap.logs.length > 0 ? `控制台已输出 ${snap.logs.length} 条执行日志 →` : '执行过程将在右侧 AI 控制台逐行输出'}
        </span>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {rows.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            解析到 {rows.length} 条（已勾选 {rows.filter((r) => r.include).length} 条）——可编辑后保存：
            <button onClick={() => aiImportStore.setRows(rows.map((r) => ({ ...r, include: true })))} disabled={busy} title="全选" aria-label="全选草稿"
              style={{ marginLeft: 8, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 11, padding: '1px 6px', cursor: 'pointer' }}>全选</button>
            <button onClick={() => aiImportStore.setRows(rows.map((r) => ({ ...r, include: false })))} disabled={busy} title="全不选" aria-label="全不选草稿"
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
                        onChange={(e) => updateRow(i, { include: e.target.checked })} />
                    </td>
                    <td style={{ padding: 4 }}>
                      <input value={row.title} onChange={(e) => updateRow(i, { title: e.target.value })}
                        aria-label="草稿标题"
                        style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12 }} />
                    </td>
                    <td style={{ padding: 4, width: 80 }}>
                      <input type="number" min={1} value={row.durationDays}
                        onChange={(e) => updateRow(i, { durationDays: Number(e.target.value) || 1 })}
                        aria-label="草稿工期"
                        style={{ width: 56, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, padding: '1px 4px' }} />
                    </td>
                    <td style={{ padding: 4, width: 130 }}>
                      <input type="date" value={row.startDate} onChange={(e) => updateRow(i, { startDate: e.target.value })}
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
