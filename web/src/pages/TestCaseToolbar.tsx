/**
 * T01485：测试用例面板第一行工具栏 + 批量操作条 + 导出格式菜单（PRD-测试用例管理 §7.2 / §7.5 / §7.6）。
 *
 * 拆出去的理由：主体文件要同时容纳取数、状态与行内编辑回调，工具栏这一坨密集 JSX 若留在
 * 同一文件会顶破「单文件 ≤600 行」的硬约束；本文件是纯展示层，所有动作经 props 下发。
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Download, FileSpreadsheet, FileText, FileType, Filter, ListChecks, Loader2, RefreshCw, TestTubes, Trash2, X } from 'lucide-react';
import { askConfirm } from '../ui/dialogs';
import { BATCH_SELECT, BTN, ICON_BTN, type CaseBatchFields, type CaseMeta, type CaseStats, enumLabel, type ReqLite } from './testCaseModel';

/** 导出三格式（§7.6：顺序 xlsx / docx / md，图标 + 两行中文浮层） */
const CASE_EXPORT_FORMATS = [
  { key: 'xlsx', label: 'Excel（.xlsx）', desc: '浅色表头 + 斑马纹表格，含步骤明细与需求覆盖率子表', Icon: FileSpreadsheet },
  { key: 'docx', label: 'Word（.docx）', desc: '按需求分组的结构化文档，可直接评审打印', Icon: FileType },
  { key: 'md', label: 'Markdown（.md）', desc: '纯文本渲染，便于纳入版本管理与 Wiki', Icon: FileText },
] as const;

/** 批量下拉的字段组别（值 → 服务端批量 patch 字段名 + 取值来源） */
const BATCH_FIELDS: Array<{ group: 'priorityLabel' | 'typeLabel' | 'statusLabel'; field: 'priority' | 'type' | 'status'; title: string; valuesKey: 'priority' | 'type' | 'status' }> = [
  { group: 'priorityLabel', field: 'priority', title: '批量优先级', valuesKey: 'priority' },
  { group: 'typeLabel', field: 'type', title: '批量类型', valuesKey: 'type' },
  { group: 'statusLabel', field: 'status', title: '批量状态', valuesKey: 'status' },
];

export function TestCaseToolbar({ meta, stats, multi, selIds, total, filterOpen, loading, exporting, exportScope, reqs,
  onToggleMulti, onToggleFilter, onRefresh, onClose, onExport, onBatch, onBatchDelete, onDuplicate, onSelectAll }: {
  readonly meta: CaseMeta | null;
  readonly stats: CaseStats;
  readonly multi: boolean;
  readonly selIds: string[];
  /** 当前筛选结果总数（全选作用于筛选范围而非当页，§7.5） */
  readonly total: number;
  readonly filterOpen: boolean;
  readonly loading: boolean;
  readonly exporting: boolean;
  /**
   * 导出范围文案（§7.6）。由父级 `TestCasePanel` 算好递进来，本组件不再从 `reqFilter`/`keyword`
   * 自己推一份：那句文案必须与真正下发的导出条件逐字对应，两处各自判断就一定会有说一套做一套。
   */
  readonly exportScope: string;
  /** 项目内需求（批量关联下拉的候选，§7.5） */
  readonly reqs: ReqLite[];
  readonly onToggleMulti: () => void;
  readonly onToggleFilter: () => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
  readonly onExport: (format: string) => void;
  readonly onBatch: (fields: CaseBatchFields, label: string) => void;
  readonly onBatchDelete: () => void;
  readonly onDuplicate: () => void;
  readonly onSelectAll: () => void;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLSpanElement>(null);
  // 导出菜单是轻量浮层，点击外部关闭（结构与 PrdPanel 的下载按钮一致，不叠遮罩）
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [exportOpen]);

  /** 批量条里的导出：菜单太窄不值得弹，直接按 Excel 导出选中项（删除/复制之外的第三个高频动作） */
  async function exportSelected(): Promise<void> {
    if (!(await askConfirm('导出选中的用例为 Excel？\n\nExcel 含步骤明细与需求覆盖率子表。'))) return;
    onExport('xlsx');
  }

  // 批量操作条整段抽成函数：render 体只留 `{renderBatchBar()}`，把成串三元/逻辑与移入本函数（S3776）。
  // 早返回等价于原先的 `multi && selIds.length > 0 && (...)`——条件不满足时同样什么都不渲染。
  function renderBatchBar() {
    if (!multi || selIds.length === 0) return null;
    return (
      <span className="op-host" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px solid var(--accent)', borderRadius: 6, padding: '2px 8px', background: 'var(--card-bg)' }}>
        <span style={{ fontSize: 11, color: 'var(--accent)' }}>已选 {selIds.length}</span>
        <button onClick={onSelectAll} className="task-op"
          title={selIds.length >= total && total > 0 ? '取消全选' : `全选当前筛选结果（共 ${total} 条，跨分页）`}
          style={{ fontSize: 11, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}>
          {selIds.length >= total && total > 0 ? '取消全选' : '全选'}
        </button>
        {/* §9.1：次要控件用 op-host + op-hidden，默认收起、悬浮或键盘聚焦时展开，避免工具条被下拉堆淹没 */}
        <span className="op-hidden" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {BATCH_FIELDS.map((b) => (
            <select key={b.field} value="" onChange={(e) => { const v = e.target.value; if (v) onBatch({ [b.field]: v } as CaseBatchFields, enumLabel(meta, b.group, v)); }}
              title={b.title} aria-label={b.title} style={BATCH_SELECT}>
              <option value="">{b.title}…</option>
              {(meta?.[b.valuesKey] ?? []).map((v) => <option key={v} value={v}>{enumLabel(meta, b.group, v)}</option>)}
            </select>
          ))}
          <select value="" onChange={(e) => { const v = e.target.value; if (v) onBatch({ module: v }, `模块「${v}」`); }}
            title="批量改所属模块（候选来自项目内已出现过的模块）" aria-label="批量改所属模块" style={BATCH_SELECT}>
            <option value="">批量模块…</option>
            {(meta?.modules ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {/* 关联需求：守卫 return（拦空值）与解除/关联分支各占一行——原先挤在同一行时，后两句看着像也在 if 内，
              实则无条件执行（S2681）。意图明确：空值直接返回，否则按 __none 分支处理，行为不变。 */}
          <select value="" onChange={(e) => {
            const v = e.target.value;
            if (!v) { return; }
            if (v === '__none') { onBatch({ reqId: null }, '解除关联'); } else { onBatch({ reqId: v }, `关联到 ${reqs.find((r) => r.id === v)?.req_no ?? ''}`.trim()); }
          }}
            title="批量关联需求 — 把勾选用例挂到某条需求，或解除关联" aria-label="批量关联需求" style={{ ...BATCH_SELECT, maxWidth: 150 }}>
            <option value="">批量关联需求…</option>
            <option value="__none">（解除关联）</option>
            {reqs.map((r) => <option key={r.id} value={r.id}>{`${r.req_no} ${r.title}`.trim()}</option>)}
          </select>
          <button onClick={onDuplicate} className="task-op" title="复制选中用例（编号自动重排，执行结论重置）"
            aria-label="复制选中用例" style={{ ...BTN, fontSize: 11, padding: '2px 6px' }}>复制</button>
          <button onClick={() => void exportSelected()} className="task-op" title="导出选中用例" aria-label="导出选中用例"
            style={{ ...BTN, fontSize: 11, padding: '2px 6px' }} disabled={exporting}>
            {exporting ? <Loader2 size={12} className="aispin" /> : <Download size={12} />}
          </button>
          <button onClick={() => onBatchDelete()} disabled={loading} className="task-op"
            title={`删除选中的 ${selIds.length} 条测试用例及其步骤？此操作不可撤销。`} aria-label="批量删除选中用例"
            style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)', padding: 2 }}>
            <Trash2 size={13} />
          </button>
        </span>
      </span>
    );
  }

  // 导出按钮 + 三格式浮层整段抽成函数：render 体只留 `{renderExportMenu()}`（S3776），行为不变。
  function renderExportMenu() {
    return (
      <span ref={exportRef} style={{ position: 'relative', display: 'inline-flex' }}>
        <button onClick={() => setExportOpen((v) => !v)} disabled={exporting || stats.total === 0} className="tbtn-anim prd-tilt-btn"
          title={stats.total === 0 ? '导出测试用例\n当前项目没有用例可导出' : `导出测试用例\n范围：${exportScope}`}
          aria-label="导出测试用例" aria-expanded={exportOpen}
          style={{ ...ICON_BTN, cursor: (exporting || stats.total === 0) ? 'default' : 'pointer', opacity: stats.total === 0 ? 0.45 : 1 }}>
          {exporting ? <Loader2 size={13} className="aispin" /> : <Download size={13} />}
        </button>
        {exportOpen && (
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60, minWidth: 232, padding: 4, background: 'var(--card-bg)', border: '1px solid var(--border-strong)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.16)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 8px' }}>导出范围：{exportScope}</div>
            {CASE_EXPORT_FORMATS.map((f) => (
              <button key={f.key} onClick={() => { setExportOpen(false); onExport(f.key); }} disabled={exporting}
                title={`${f.label}\n${f.desc}`} aria-label={`导出 ${f.label}`}
                style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '6px 8px', fontSize: 12, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: exporting ? 'default' : 'pointer' }}>
                <f.Icon size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                {f.label}
              </button>
            ))}
          </div>
        )}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
      <TestTubes size={15} style={{ color: 'var(--accent)' }} />
      <strong style={{ fontSize: 14 }}>测试用例</strong>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        共 {stats.total} 条 · 已关联需求 {stats.linked} 条
        {stats.orphan > 0 ? ` · 其中 ${stats.orphan} 条未关联需求` : ''}
      </span>
      <span style={{ flex: 1 }} />
      <button onClick={onToggleMulti} className="tbtn-anim"
        title={multi ? '退出多选模式' : '多选模式 — 勾选用例后批量改优先级/类型/状态/模块/关联需求、复制、删除、导出'}
        aria-label={multi ? '退出多选模式' : '进入多选模式'} aria-expanded={multi}
        style={{ ...ICON_BTN, background: multi ? 'var(--accent)' : 'transparent', color: multi ? 'var(--accent-text)' : 'var(--text)' }}>
        {multi ? <Check size={12} /> : <ListChecks size={12} />}
      </button>

      {renderBatchBar()}

      <button onClick={onToggleFilter} className="tbtn-anim"
        title={filterOpen ? '收起筛选条' : '筛选 — 按关键词/模块/优先级/类型/状态/执行结果过滤'} aria-label="筛选" aria-expanded={filterOpen}
        style={{ ...ICON_BTN, background: filterOpen ? 'var(--accent)' : 'transparent', color: filterOpen ? 'var(--accent-text)' : 'var(--text)', borderColor: filterOpen ? 'var(--accent)' : 'var(--border-strong)' }}>
        <Filter size={13} />
      </button>

      {renderExportMenu()}

      <button onClick={onRefresh} className="tbtn-anim" title="刷新用例列表" aria-label="刷新用例列表" style={ICON_BTN}>
        {loading ? <Loader2 size={13} className="aispin" /> : <RefreshCw size={13} />}
      </button>
      <button onClick={onClose} className="tbtn-anim" title="收起测试用例面板" aria-label="收起测试用例面板" style={ICON_BTN}>
        <X size={13} />
      </button>
    </div>
  );
}
