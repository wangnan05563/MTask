/**
 * T01485：测试用例面板第二行（PRD-测试用例管理 §7.2 第二行 / §7.7）。
 *
 * 行结构与 `ReqMatrixPanel.renderNewReqRow` 完全同构——顶部输入 + 回车提交 + `Plus` 按钮，
 * 同一页操作两个面板时不需要重新学习。筛选控件只在 `filterOpen` 时出现，
 * 否则第二行退化成「新增 + 仅显示」两个控件，保持工具栏高度稳定。
 */
import { FilterX, Plus } from 'lucide-react';
import { BTN, CELL_INPUT, enumLabel, type CaseFilters, type CaseMeta, type CaseScope, type ReqLite } from './testCaseModel';

const SCOPE_OPTIONS: Array<{ key: CaseScope; label: string; hint: string }> = [
  { key: 'all', label: '全部用例', hint: '显示项目内所有测试用例' },
  { key: 'orphan', label: '孤儿用例', hint: '仅显示未关联需求用例条目的用例\n（准则 P4：孤儿用例允许存在，但要能被找出来）' },
  { key: 'uncovered', label: '未覆盖的需求', hint: '列出还没有任何用例的需求\n（覆盖度视图，用于安排补测）' },
];

const SELECT_STYLE = { ...CELL_INPUT, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12, padding: '3px 4px' };

export function TestCaseFilterBar({ meta, reqs, reqFilter, scope, newTitle, keyword, filters, filterOpen, busy, notice,
  onNewTitle, onAdd, onScope, onKeyword, onFilter, onClear }: {
  readonly meta: CaseMeta | null;
  readonly reqs: ReqLite[];
  /** 关联需求筛选（§7.1 `tc.reqFilter`，独立于 `tc.filters`——矩阵下钻与 chip 点击都写这一处） */
  readonly reqFilter: string;
  readonly scope: CaseScope;
  readonly newTitle: string;
  readonly keyword: string;
  readonly filters: CaseFilters;
  readonly filterOpen: boolean;
  readonly busy: boolean;
  readonly notice: string;
  readonly onNewTitle: (value: string) => void;
  readonly onAdd: () => void;
  readonly onScope: (value: CaseScope) => void;
  readonly onKeyword: (value: string) => void;
  readonly onFilter: (patch: Partial<CaseFilters>) => void;
  readonly onClear: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
      <input value={newTitle} onChange={(e) => onNewTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }}
        placeholder="新增用例标题（回车提交）" aria-label="新增用例标题"
        title="新增测试用例\n只需标题，其余字段（编号/优先级/类型）自动取默认值，落库后行内补全"
        style={{ flex: 1, maxWidth: 320, padding: '5px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 12 }} />
      <button onClick={onAdd} disabled={busy || newTitle.trim() === ''} className="tbtn-anim"
        title="新增一条测试用例（编号按项目内 TC-xxx 自动递增）" aria-label="新增测试用例"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 12, cursor: busy ? 'wait' : 'pointer' }}>
        <Plus size={13} />
      </button>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
        仅显示
        <select value={scope} onChange={(e) => onScope(e.target.value as CaseScope)}
          title="视图范围切换" aria-label="视图范围"
          style={{ ...SELECT_STYLE, maxWidth: 150 }}>
          {SCOPE_OPTIONS.map((o) => <option key={o.key} value={o.key} title={o.hint}>{o.label}</option>)}
        </select>
      </label>

      {filterOpen && (
        <>
          <input value={keyword} onChange={(e) => onKeyword(e.target.value)}
            placeholder="关键词：编号/标题/模块/标签" aria-label="用例关键词筛选"
            style={{ ...SELECT_STYLE, width: 180 }} />
          <select value={filters.module} onChange={(e) => onFilter({ module: e.target.value })}
            title="按所属模块筛选\n候选来自项目内已出现过的模块" aria-label="按模块筛选"
            style={{ ...SELECT_STYLE, maxWidth: 140 }}>
            <option value="">模块：全部</option>
            {(meta?.modules ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={filters.priority} onChange={(e) => onFilter({ priority: e.target.value })}
            title="按优先级筛选" aria-label="按优先级筛选" style={SELECT_STYLE}>
            <option value="">优先级：全部</option>
            {(meta?.priority ?? []).map((v) => <option key={v} value={v}>{enumLabel(meta, 'priorityLabel', v)}</option>)}
          </select>
          <select value={filters.type} onChange={(e) => onFilter({ type: e.target.value })}
            title="按用例类型筛选" aria-label="按类型筛选" style={SELECT_STYLE}>
            <option value="">类型：全部</option>
            {(meta?.type ?? []).map((v) => <option key={v} value={v}>{enumLabel(meta, 'typeLabel', v)}</option>)}
          </select>
          <select value={filters.status} onChange={(e) => onFilter({ status: e.target.value })}
            title="按用例状态筛选（草稿/评审中/已批准/已废弃）" aria-label="按状态筛选" style={SELECT_STYLE}>
            <option value="">状态：全部</option>
            {(meta?.status ?? []).map((v) => <option key={v} value={v}>{enumLabel(meta, 'statusLabel', v)}</option>)}
          </select>
          <select value={filters.result} onChange={(e) => onFilter({ result: e.target.value })}
            title="按最近执行结果筛选\n准则 P1：用例是资产，执行结果只是最近一次的观测" aria-label="按执行结果筛选" style={SELECT_STYLE}>
            <option value="">结果：全部</option>
            {(meta?.result ?? []).map((v) => <option key={v} value={v}>{enumLabel(meta, 'resultLabel', v)}</option>)}
          </select>
          {/* 关联需求筛选由 chip 点击 / 矩阵下钻写入（§4.3），这里只把当前值显性化，避免出现第二个写入口 */}
          {(() => {
            const hit = reqs.find((r) => r.id === reqFilter);
            return hit ? (
              <span title="当前只看这条需求下的用例\n点 [清除筛选] 回到完整列表" style={{ fontSize: 11, color: 'var(--accent)' }}>需求：{`${hit.req_no} ${hit.title}`.trim()}</span>
            ) : null;
          })()}
          <button onClick={onClear} className="tbtn-anim" style={BTN}
            title="清除全部筛选条件，回到完整列表" aria-label="清除筛选">
            <FilterX size={12} /> 清除筛选
          </button>
        </>
      )}

      <span style={{ flex: 1 }} />
      {/* role=status 让提示文本对辅助技术即时播报（与全站内联 notice 同位置，同时便于自动化断言取当前提示） */}
      {notice && <span role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--accent)' }}>{notice}</span>}
    </div>
  );
}
