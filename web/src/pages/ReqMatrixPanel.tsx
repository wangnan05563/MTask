import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { MarkdownContent } from '../ui/Markdown'; // T00763：PRD 原文 Markdown 渲染弹窗
import { Check, ChevronDown, ChevronUp, Archive, FileSpreadsheet, FileText, Link2, ListChecks, Loader2, Minimize2, Plus, RefreshCw, Sparkles, Table2, Trash2, Upload, X } from 'lucide-react'; // T00765：标题点击查询详情；T00763：查看PRD；T00773：多选模式；T00824：跳转导入入口；T00825：关联PRD；T00842：需求标题栏 AI 美化/简化/归档；T00959：导出 Excel
import { EXPORT_MIME, safeExportName, saveBinary } from '../utils/download'; // T00959：导出下载

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
  /** T00763：需求关联的 PRD 原文文档摘要（null=该需求未挂 PRD） */
  prdDoc: { id: string; filename: string } | null;
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
  // T00959：导出 Excel 的进行态（与 busy 分开，避免导出时禁用新增/批量等其它操作）
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [linkFor, setLinkFor] = useState<string>('');       // 正在调整关联的需求 id
  const [linkKind, setLinkKind] = useState<'plan' | 'task' | 'prd'>('plan');
  const [queryId, setQueryId] = useState<string>(''); // T00765：正在查看详情的需求 id（点击标题旁 chevron 切换）
  // T00763：undefined=关闭，null=加载中，对象=展示中；T00825：locate 字段承载定位关键词（需求标题/编号）
  const [prdModal, setPrdModal] = useState<{ filename: string; content: string; locateTitle?: string; locateNo?: string } | null | undefined>(undefined);
  // T00825：项目内 PRD 文档列表——「关联调整·PRD」选项卡可选对象
  const [prdDocs, setPrdDocs] = useState<Array<{ id: string; filename: string }>>([]);
  const [newTitle, setNewTitle] = useState('');
  // T00773：多选模式（参考项目计划 T00564）——批量更改状态 / 批量删除
  const [multi, setMulti] = useState(false);
  const [selIds, setSelIds] = useState<string[]>([]);
  const allRef = useRef<HTMLInputElement>(null);
  // T00825：PRD 原文弹窗内容容器——渲染后按定位关键词 scrollIntoView + 高亮
  const prdBodyRef = useRef<HTMLDivElement>(null);

  /** T00763/T00825：查看 PRD 原文——拉取完整 Markdown 后弹窗渲染；可带定位关键词（需求标题/编号）滚动高亮 */
  async function openPrd(doc: { id: string; filename: string }, locate?: { title: string; reqNo: string }) {
    setPrdModal(null); // null = 加载中
    try {
      const d = await api.get<{ filename: string; content_md: string }>(`/plans/prd-docs/${doc.id}`);
      setPrdModal({ filename: d.filename || doc.filename || '未命名 PRD', content: d.content_md, locateTitle: locate?.title, locateNo: locate?.reqNo });
    } catch (e) {
      setPrdModal(undefined);
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };

  /**
   * T00959：导出当前项目的需求跟踪矩阵为 Excel。
   * 数据由服务端按同一 service 重新取（与界面同源，避免用前端过滤后的子集导出），
   * 列序/中文标签由服务端 prdExport.buildMatrixXlsx 统一，客户端只负责下载落盘。
   */
  async function exportMatrix() {
    if (exporting || rows.length === 0) return;
    setExporting(true);
    try {
      const buf = await api.getBinary(`/plans/prd-requirements/export?projectId=${encodeURIComponent(projectId)}`);
      const ts = new Date().toISOString().slice(0, 10);
      const baseName = `需求跟踪矩阵-${ts}`;
      saveBinary(buf, `${safeExportName(baseName, '需求跟踪矩阵')}.xlsx`, EXPORT_MIME.xlsx);
      flash(`已导出需求跟踪矩阵（${rows.length} 条需求）`);
    } catch (e) {
      flash(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  const load = useCallback(async () => {
    if (!projectId) return;
    const [r, p, t, d] = await Promise.all([
      api.get<MatrixReq[]>(`/plans/prd-requirements?projectId=${projectId}`),
      api.get<PlanLite[]>(`/plans?projectId=${projectId}`).catch(() => []),
      api.get<Array<{ id: string; task_no: string | null; title: string }>>(`/tasks?projectId=${projectId}&archived=false`).catch(() => []),
      api.get<Array<{ id: string; filename: string }>>(`/plans/prd-docs?projectId=${projectId}`).catch(() => []),
    ]);
    setRows(r);
    setPlans(p);
    setTasks(t.map((x) => ({ id: x.id, taskNo: x.task_no, title: x.title })));
    setPrdDocs(d);
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // T00825：PRD 原文弹窗渲染完成后定位高亮——优先按需求标题匹配标题行，其次编号；
  // 命中 → scrollIntoView + 加高亮 class（2.5s 后移除）；未命中标题退化到任意含标题的段落；仍无则滚动顶部，不报错
  useEffect(() => {
    if (!prdModal?.content || !prdBodyRef.current) return;
    const locate = prdModal.locateTitle || prdModal.locateNo;
    if (!locate) return;
    const root = prdBodyRef.current;
    const targets: Array<[Element, number]> = [];
    root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
      const txt = (el.textContent ?? '').trim();
      if (!txt) return;
      let score = 0;
      if (prdModal.locateTitle && txt.includes(prdModal.locateTitle)) score = 2;
      else if (prdModal.locateNo && txt.includes(prdModal.locateNo)) score = 1;
      if (score > 0) targets.push([el, score]);
    });
    targets.sort((a, b) => b[1] - a[1]);
    let hit: Element | null = targets[0]?.[0] ?? null;
    const locateTitle = prdModal.locateTitle ?? '';
    if (!hit && locateTitle) {
      hit = Array.from(root.querySelectorAll('p,li,td')).find((el) => (el.textContent ?? '').includes(locateTitle)) ?? null;
    }
    const container = root;
    if (hit) {
      try { hit.scrollIntoView({ block: 'center' }); } catch { /* 忽略滚动异常 */ }
      hit.classList.add('prd-hl');
      globalThis.setTimeout(() => hit?.classList.remove('prd-hl'), 2500);
    } else {
      container.scrollTop = 0;
    }
  }, [prdModal]);

  /** T00824：从本视图跳转 AI 工作台并自动展开「从 PRD 导入项目计划」面板，目标项目随跳转带出 */
  function goImportPrd() {
    try {
      sessionStorage.setItem('report.showPrdImport', JSON.stringify(true));
      sessionStorage.setItem('prd-import.project', JSON.stringify(projectId));
      globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'report' } }));
    } catch { /* 跳转异常静默，不影响当前视图 */ }
  }

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

  /** T00825：设置/解除需求↔PRD 关联（单选，传空串解除） */
  async function setPrdLink(reqId: string, docId: string, linked: boolean) {
    try {
      await api.patch(`/plans/prd-requirements/${reqId}`, { prdId: linked ? docId : '' });
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  /** T00773：批量更改选中需求的状态（复用单条 PATCH，循环提交） */
  async function batchSetStatus(st: string) {
    const ids = [...selIds];
    if (ids.length === 0 || !st) return;
    setBusy(true);
    try {
      for (const id of ids) await api.patch(`/plans/prd-requirements/${id}`, { status: st });
      setSelIds([]);
      flash(`已把 ${ids.length} 条需求状态设为 ${STATUS_OPTIONS.find((s) => s.key === st)?.label ?? st}`);
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  /** T00773：批量删除选中需求（逐条清理关联，与单条删除同语义） */
  async function batchDeleteReqs() {
    const ids = [...selIds];
    if (ids.length === 0) return;
    if (!(await askConfirm(`删除选中的 ${ids.length} 条需求？\n\n其与计划/待办的关联将一并清理（计划与任务本身不受影响）。`))) return;
    setBusy(true);
    try {
      for (const id of ids) await api.del(`/plans/prd-requirements/${id}`);
      setSelIds([]);
      flash(`已删除 ${ids.length} 条需求并清理关联`);
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const covered = rows.filter((r) => r.linkedPlans.length > 0 || r.linkedTasks.length > 0).length;
  // T00773：全选框半选态（部分选中时显示短横线）
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selIds.length > 0 && selIds.length < rows.length;
  }, [selIds, rows]);

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <Table2 size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>需求跟踪矩阵</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          共 {rows.length} 条需求，已关联计划/待办 {covered} 条；可增删改与调整关联
        </span>
        <span style={{ flex: 1 }} />
        {/* T00773：多选模式开关（参考项目计划 T00564）——勾选需求后批量改状态/删除 */}
        <button onClick={() => { setMulti((m) => !m); setSelIds([]); }} className="tbtn-anim"
          title={multi ? '退出多选模式' : '多选模式 — 勾选需求后批量更改状态/删除'} aria-label={multi ? '退出多选模式' : '进入多选模式'}
          style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, background: multi ? 'var(--accent)' : 'transparent', color: multi ? 'var(--accent-text)' : 'var(--text)', cursor: 'pointer', padding: '3px 7px' }}>
          {multi ? <Check size={12} /> : <ListChecks size={12} />}
        </button>
        {multi && selIds.length > 0 && (
          <span className="op-host" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px solid var(--accent)', borderRadius: 6, padding: '2px 8px', background: 'var(--card-bg)' }}>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>已选 {selIds.length}</span>
            <button onClick={() => setSelIds(selIds.length === rows.length ? [] : rows.map((r) => r.id))} className="task-op"
              title={selIds.length === rows.length ? '取消全选' : '全选当前需求'} style={{ fontSize: 11, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}>
              {selIds.length === rows.length ? '取消全选' : '全选'}
            </button>
            <select value="" onChange={(e) => { const v = e.target.value; if (v) void batchSetStatus(v); }}
              title="批量设置状态" aria-label="批量设置需求状态"
              style={{ padding: 2, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
              <option value="">批量状态…</option>
              {STATUS_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <button onClick={() => void batchDeleteReqs()} disabled={busy} className="task-op"
              title="删除选中需求 — 一并清理其与计划/待办的关联" aria-label="批量删除选中需求"
              style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)', padding: 2 }}>
              <Trash2 size={13} />
            </button>
          </span>
        )}
        {/* T00824：跳转 AI 工作台导入入口——文件多选在导入面板内完成 */}
        <button onClick={goImportPrd} className="tbtn-anim"
          title="选择PRD导入 — 跳转 AI 工作台，从 PRD 批量导入需求矩阵与项目计划"
          aria-label="选择PRD导入"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--accent)', borderRadius: 6, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: '2px 8px' }}>
          <Upload size={12} />
        </button>
        {/* T00959：导出 Excel——无文字图标按钮 + 悬浮倾斜 + 两行中文浮层；导出当前项目矩阵（与界面同源数据） */}
        <button onClick={() => void exportMatrix()} disabled={exporting || rows.length === 0} className="tbtn-anim prd-tilt-btn"
          title={rows.length === 0 ? '导出 Excel\n当前项目没有需求可导出' : '导出 Excel\n下载需求跟踪矩阵表格（含关联计划/待办）'}
          aria-label="导出需求跟踪矩阵 Excel"
          style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: (exporting || rows.length === 0) ? 'default' : 'pointer', padding: '3px 6px', opacity: rows.length === 0 ? 0.45 : 1 }}>
          {exporting ? <Loader2 size={13} className="aispin" /> : <FileSpreadsheet size={13} />}
        </button>
        <button onClick={() => void load()} className="tbtn-anim" title="刷新矩阵" aria-label="刷新矩阵"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 11, padding: '2px 8px' }}>
          <RefreshCw size={12} />
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
          <Plus size={13} />
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
                  {/* T00773：多选模式勾选列——表头全选（含半选态） */}
                  {multi && (
                    <th style={{ padding: '5px 6px', width: 30 }}>
                      <input ref={allRef} type="checkbox"
                        checked={rows.length > 0 && selIds.length === rows.length}
                        onChange={(e) => setSelIds(e.target.checked ? rows.map((r) => r.id) : [])}
                        title="全选/全不选当前需求" aria-label="全选需求"
                        style={{ cursor: 'pointer' }} />
                    </th>
                  )}
                  <th style={{ padding: '5px 6px' }}>需求编号</th>
                  <th style={{ padding: '5px 6px' }}>需求标题</th>
                  <th style={{ padding: '5px 6px' }}>状态</th>
                  <th style={{ padding: '5px 6px' }}>关联计划</th>
                  {/* T00825：关联PRD 列——显示可点击的 PRD 名称，点击打开原文并定位高亮 */}
                  <th style={{ padding: '5px 6px' }}>关联PRD</th>
                  <th style={{ padding: '5px 6px' }}>关联待办</th>
                  <th style={{ padding: '5px 6px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                    {/* T00773：行内勾选框（多选模式下出现） */}
                    {multi && (
                      <td style={{ padding: '4px 6px' }}>
                        <input type="checkbox" checked={selIds.includes(r.id)}
                          onChange={(e) => setSelIds(e.target.checked ? [...selIds, r.id] : selIds.filter((x) => x !== r.id))}
                          aria-label={`选中需求 ${r.title}`} title={`选中 ${r.req_no || ''} ${r.title}`}
                          style={{ cursor: 'pointer' }} />
                      </td>
                    )}
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
                        {/* T00842 位置3「参考任务菜单」：样式对齐任务菜单已有同名按钮（task-op 同款尺寸/间距/圆角，图标同源） */}
                        <button onClick={() => flash('AI 美化功能开发中')} className="tbtn-anim"
                          title="AI 美化 — 润色该需求标题，使其语义更清晰表达更规范" aria-label="AI 美化：润色该需求标题"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'inline-flex', flexShrink: 0 }}>
                          <Sparkles size={12} />
                        </button>
                        <button onClick={() => flash('AI 简化功能开发中')} className="tbtn-anim"
                          title="AI 简化 — 依据需求详情高度总结为简洁标题（限 40 字，细节会精简）" aria-label="AI 简化：依据需求详情总结为简洁标题"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'inline-flex', flexShrink: 0 }}>
                          <Minimize2 size={12} />
                        </button>
                        <button onClick={() => flash('归档功能开发中')} className="tbtn-anim"
                          title="归档 — 将该需求移入归档" aria-label="归档：将该需求移入归档"
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'inline-flex', flexShrink: 0 }}>
                          <Archive size={12} />
                        </button>
                      </div>
                      {r.source_ref && <div style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 4 }}>{r.source_ref}</div>}
                      {queryId === r.id && (
                        <div style={{ marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', fontSize: 11, color: 'var(--text)' }}>
                          <div style={{ whiteSpace: 'pre-wrap' }}>{r.content ? r.content : '（无内容）'}</div>
                          <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>来源：{r.source_ref || '—'} · 优先级：{r.priority || 'normal'} · 状态：{r.status || 'todo'}</div>
                          {/* T00763：需求关联了 PRD 原文文档 → 提供弹窗查看完整 Markdown */}
                          {r.prdDoc && (
                            <div style={{ marginTop: 6 }}>
                              <button onClick={() => void openPrd(r.prdDoc!)} className="tbtn-anim"
                                title={`查看 PRD 原文：${r.prdDoc.filename || '未命名'}`}
                                aria-label={`查看需求 ${r.title} 关联的 PRD 原文`}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, border: '1px solid var(--accent)', borderRadius: 5, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '2px 8px' }}>
                                <FileText size={11} /> 查看PRD
                              </button>
                            </div>
                          )}
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
                    {/* T00825：关联PRD 单元格——有 PRD 时显示可点击名称（打开原文并定位该需求章节高亮），无则占位 */}
                    <td style={{ padding: '4px 6px', maxWidth: 180 }}>
                      {r.prdDoc ? (
                        <button onClick={() => void openPrd(r.prdDoc!, { title: r.title, reqNo: r.req_no })} className="tbtn-anim"
                          title={`打开 PRD 原文：${r.prdDoc.filename}（定位到「${r.title}」章节）`}
                          aria-label={`打开关联 PRD ${r.prdDoc.filename}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: 0, maxWidth: '100%', textAlign: 'left' }}>
                          <FileText size={11} style={{ flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.prdDoc.filename}</span>
                        </button>
                      ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
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
              {/* T00825：PRD 选项卡——单选关联一份 PRD 文档（取消=解除） */}
              <button onClick={() => setLinkKind('prd')} title="关联到 PRD 文档" aria-label="关联到 PRD"
                style={{ padding: '2px 10px', fontSize: 11, border: 'none', borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: linkKind === 'prd' ? 'var(--accent)' : 'transparent', color: linkKind === 'prd' ? 'var(--accent-text)' : 'var(--text)' }}>PRD</button>
            </fieldset>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>勾选即建立关联，取消勾选解除</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setLinkFor('')} title="收起关联调整" aria-label="收起关联调整"
              style={{ border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 11, padding: '2px 8px' }}>收起</button>
          </div>
          {(() => {
            const cur = rows.find((x) => x.id === linkFor);
            if (!cur) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{busy ? <Loader2 size={12} className="aispin" /> : '需求已变更，请刷新'}</div>;
            // T00825：PRD 为单值关联（radio 风格），计划/待办保持多选勾选
            if (linkKind === 'prd') {
              if (prdDocs.length === 0) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>该项目暂无 PRD 文档可选。</div>;
              return (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 180, overflowY: 'auto' }}>
                  {prdDocs.map((x) => {
                    const on = cur.prdDoc?.id === x.id;
                    return (
                      <button key={x.id} onClick={() => void setPrdLink(cur.id, x.id, !on)} className="tbtn-anim"
                        title={on ? `解除与「${x.filename}」的关联` : `关联到「${x.filename}」`}
                        aria-label={on ? `解除关联 PRD ${x.filename}` : `关联 PRD ${x.filename}`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, padding: '2px 8px', background: on ? 'var(--accent-soft, transparent)' : 'transparent', color: on ? 'var(--accent)' : 'var(--text)', maxWidth: 260 }}>
                        {on && <Check size={11} />}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.filename || '未命名 PRD'}</span>
                      </button>
                    );
                  })}
                </div>
              );
            }
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
      {/* T00763：PRD 原文弹窗——模态覆盖层，Markdown 渲染 + 滚动查看长文档 */}
      {prdModal !== undefined && (
        <dialog open
          aria-label={`PRD 原文：${prdModal === null ? '加载中' : prdModal.filename}`}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          {/* T00825：定位章节高亮样式（accent 柔和底 + 左强调条，随主题变量） */}
          <style>{'.prd-hl { background: var(--accent-soft); box-shadow: 0 0 0 3px var(--accent-soft); border-radius: 4px; transition: background .3s ease; }'}</style>
          <div
            style={{ width: 'min(860px, 100%)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: 'var(--card-bg)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <FileText size={15} style={{ color: 'var(--accent)' }} />
              <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                PRD 原文：{prdModal === null ? '加载中…' : prdModal.filename}
              </strong>
              <span style={{ flex: 1 }} />
              <button onClick={() => setPrdModal(undefined)} className="tbtn-anim" title="关闭" aria-label="关闭 PRD 原文弹窗"
                style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 6px' }}>
                <X size={13} />
              </button>
            </div>
            <div ref={prdBodyRef} style={{ padding: '12px 16px', overflowY: 'auto', fontSize: 13 }}>
              {prdModal === null
                ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}><Loader2 size={14} className="aispin" /> 加载 PRD 原文…</div>
                : <MarkdownContent content={prdModal.content} />}
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}
