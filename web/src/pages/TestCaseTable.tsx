/**
 * T01485：测试用例表格（PRD-测试用例管理 §7.3 列定义 / §7.4 步骤行内展开 / §7.7 空态）。
 *
 * 与 `ReqMatrixPanel` 同构的取数后渲染层：本文件不持有任何用户可感知状态（§7.1 明令），
 * 展开行、选中项、分页、每页档位全部由 `TestCasePanel` 经 `useSessionState` 下发。
 * 行内编辑沿用「`defaultValue` + `onBlur` 保存」范式；保存失败时 Panel 递增 `syncNonce`
 * 触发 `tbody` 重挂载，让输入框回落到库里真实值（避免出现「界面显示 TC-001、库里是 TC-005」的假状态）。
 */
import type { RefObject } from 'react';
import { Fragment, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import {
  BTN, CELL_INPUT, CHIP, ICON_BTN, PAGE_SIZE_LABELS, PAGE_SIZE_OPTIONS, RESULT_COLOR, TH, TH_TD,
  VIRTUAL_ROW_H, VIRTUAL_THRESHOLD, VIRTUAL_VIEWPORT_H, computeWindow, enumLabel, shouldVirtualize,
  type CaseMeta, type CasePatchBody, type CaseRow, type CaseScope, type ReqLite,
} from './testCaseModel';

/** chip 文本截断（§9.1 关联 chip：>14 字截断） */
function chipText(s: string): string {
  return s.length > 14 ? `${s.slice(0, 14)}…` : s;
}

/** 步骤数组 → PATCH 入参（整表重写，§7.4 推荐项；stepNo 由服务端按数组下标 +1 落库） */
function stepsBody(steps: ReadonlyArray<{ action: string; expected: string }>): CasePatchBody {
  return { steps: steps.map((s) => ({ action: s.action, expected: s.expected })) };
}

export function TestCaseTable({ meta, reqs, rows, total, page, pageSize, multi, selIds, expandedId, scope,
  uncovered, filtered, busy, syncNonce, allRef, onToggleExpand, onToggleSel, onToggleAll, onPatch,
  onRemove, onDuplicate, onLocateReq, onCoverReq, onClearFilter, onPage, onPageSize }: {
  readonly meta: CaseMeta | null;
  readonly reqs: readonly ReqLite[];
  readonly rows: readonly CaseRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly multi: boolean;
  readonly selIds: readonly string[];
  readonly expandedId: string;
  readonly scope: CaseScope;
  /** 「未覆盖的需求」视图数据（coverage.byReq 中 caseCount=0 的行） */
  readonly uncovered: readonly { reqId: string; reqNo: string; title: string }[];
  /** 是否存在生效筛选——区分「没有用例」与「筛选无结果」两种空态（§7.7） */
  readonly filtered: boolean;
  readonly busy: boolean;
  readonly syncNonce: number;
  readonly allRef: RefObject<HTMLInputElement>;
  readonly onToggleExpand: (id: string) => void;
  readonly onToggleSel: (id: string) => void;
  readonly onToggleAll: () => void;
  readonly onPatch: (id: string, patch: CasePatchBody, label: string) => void;
  readonly onRemove: (row: CaseRow) => void;
  readonly onDuplicate: (row: CaseRow) => void;
  readonly onLocateReq: (reqId: string) => void;
  readonly onCoverReq: (reqId: string) => void;
  readonly onClearFilter: () => void;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (size: number) => void;
}) {
  // 拖拽起点只在一次 DOM 交互内有效（松手即失效），不属于「切页后要恢复」的用户可感知状态，故用 useState
  const [dragFrom, setDragFrom] = useState(-1);
  // T01495：滚动位置是瞬时视图态（不进会话态，刷新回顶部即可），仅「全部 >1000」虚拟模式读取它算窗口
  const [scrollTop, setScrollTop] = useState(0);
  const colSpan = multi ? 11 : 10;
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  // 仅「全部」模式（pageSize=0）且载入 >1000 行才窗口化；分页档位恒为 false（勿过度设计）
  const virtual = shouldVirtualize(pageSize, rows.length);
  const win = virtual ? computeWindow(scrollTop, rows.length) : null;

  /** 关联需求单元格：chip（点击下钻矩阵）+「换」（改关联/解除） */
  const renderReqCell = (row: CaseRow) => {
    const rid = row.req_id;
    return (
      <td style={{ ...TH_TD, width: 160 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {rid ? (
            <button onClick={() => onLocateReq(rid)} className="tbtn-anim"
              title={`下钻需求跟踪矩阵\n${row.reqNo ?? ''} ${row.reqTitle ?? ''}`.trim()}
              aria-label={`查看需求 ${row.reqNo ?? ''} 的矩阵关联`}
              style={{ ...CHIP, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {chipText(`${row.reqNo ?? ''} ${row.reqTitle ?? ''}`.trim()) || '已关联'}
            </button>
          ) : (
            <span title="孤儿用例：未关联任何需求条目（准则 P4）" style={{ ...CHIP, color: 'var(--text-muted)', borderStyle: 'dashed' }}>未关联</span>
          )}
          <select value={rid ?? ''} disabled={busy}
            onChange={(e) => { const v = e.target.value; onPatch(row.id, { reqId: v === '__none' ? null : v }, v === '__none' ? '已解除关联' : '已改关联需求'); }}
            title={rid ? '换关联需求 — 改成别的需求，或解除关联' : '关联需求 — 把该用例挂到某条需求上'}
            aria-label={`设置用例 ${row.case_no} 的关联需求`}
            style={{ ...CELL_INPUT, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text-muted)', fontSize: 11, padding: '1px 2px', maxWidth: 44 }}>
            <option value="">{rid ? '换' : '关联…'}</option>
            {rid && <option value="__none">（解除）</option>}
            {reqs.map((r) => <option key={r.id} value={r.id}>{chipText(`${r.req_no} ${r.title}`)}</option>)}
          </select>
        </div>
      </td>
    );
  };

  /** 枚举下拉列（优先级/类型/状态/执行结果共用，change 即存） */
  const renderEnumCell = (row: CaseRow, field: 'priority' | 'type' | 'status' | 'lastResult', values: string[], group: 'priorityLabel' | 'typeLabel' | 'statusLabel' | 'resultLabel', width: number, colName: string, color?: string) => (
    <td style={{ ...TH_TD, width }}>
      <select value={row[field === 'lastResult' ? 'last_result' : field]} disabled={busy}
        onChange={(e) => onPatch(row.id, { [field]: e.target.value } as CasePatchBody, `已改${enumLabel(meta, group, e.target.value)}`)}
        title={`${colName}：改动即保存`}
        aria-label={`用例 ${row.case_no} 的${colName}`}
        style={{ ...CELL_INPUT, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: color ?? 'var(--text)', fontSize: 12, padding: '1px 2px', width: width - 12 }}>
        {values.map((v) => <option key={v} value={v}>{enumLabel(meta, group, v)}</option>)}
      </select>
    </td>
  );

  const renderRow = (row: CaseRow) => {
    const opened = !virtual && expandedId === row.id; // T01495：>1000 虚拟模式下关闭行内展开（步骤编辑请切分页/按需求筛选后进行）
    // 每行渲染「主行 + 可选展开行」两个 <tr>，故用 Fragment 包一层；key 必须挂在 Fragment 上，
    // 否则列表缺 key 会让 React 按下标复用节点——排序/分页变动时行内输入框的脏值会串到别的用例上
    return (
      <Fragment key={row.id}>
        <tr style={{ borderTop: '1px solid var(--border)', ...(virtual ? { height: VIRTUAL_ROW_H } : {}) }}>
          {multi && (
            <td style={TH_TD}>
              <input type="checkbox" checked={selIds.includes(row.id)} onChange={() => onToggleSel(row.id)}
                title={`选中 ${row.case_no}`} aria-label={`选中用例 ${row.title}`} style={{ cursor: 'pointer' }} />
            </td>
          )}
          <td style={{ ...TH_TD, width: 100 }}>
            <input defaultValue={row.case_no} disabled={busy} aria-label="用例编号" title="用例编号（失焦保存，项目内唯一）"
              onBlur={(e) => { if (e.target.value.trim() !== row.case_no) onPatch(row.id, { caseNo: e.target.value }, '已改用例编号'); }}
              style={{ ...CELL_INPUT, width: 88, color: 'var(--accent)' }} />
          </td>
          <td style={{ ...TH_TD, minWidth: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <input defaultValue={row.title} disabled={busy} aria-label="用例标题" title="用例标题（失焦保存）；点右侧箭头展开详情与步骤"
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== row.title) onPatch(row.id, { title: v }, '已改标题'); }}
                style={{ ...CELL_INPUT, flex: 1, minWidth: 150 }} />
              <button onClick={virtual ? undefined : () => onToggleExpand(row.id)} disabled={virtual} className="tbtn-anim"
                title={virtual ? '全部模式(>1000)为性能关闭行内展开——编辑步骤请切 200/500 分页或按需求筛选' : opened ? '收起详情与步骤' : '展开详情与步骤\n（前置/数据/预期/后置 + 步骤增删排序）'}
                aria-label={`展开用例 ${row.case_no} 详情`} aria-expanded={opened}
                style={{ border: 'none', background: 'transparent', cursor: virtual ? 'default' : 'pointer', color: opened ? 'var(--accent)' : 'var(--text-muted)', padding: 2, display: 'inline-flex', flexShrink: 0, opacity: virtual ? 0.4 : 1 }}>
                {opened ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            </div>
            {row.module === '' && row.tags === '' && <div style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 4 }}>（未填模块与标签）</div>}
          </td>
          <td style={{ ...TH_TD, width: 120 }}>
            <input defaultValue={row.module} list="tc-module-options" disabled={busy} aria-label="所属模块"
              title="所属模块（失焦保存，可下拉选已有模块）"
              onBlur={(e) => { if (e.target.value.trim() !== row.module) onPatch(row.id, { module: e.target.value }, '已改所属模块'); }}
              style={{ ...CELL_INPUT, width: 108 }} />
          </td>
          {renderReqCell(row)}
          {renderEnumCell(row, 'priority', meta?.priority ?? [], 'priorityLabel', 88, '优先级')}
          {renderEnumCell(row, 'type', meta?.type ?? [], 'typeLabel', 96, '类型')}
          {renderEnumCell(row, 'status', meta?.status ?? [], 'statusLabel', 96, '状态')}
          {renderEnumCell(row, 'lastResult', meta?.result ?? [], 'resultLabel', 96, '执行结果', RESULT_COLOR[row.last_result] ?? 'var(--text)')}
          <td style={{ ...TH_TD, width: 70, textAlign: 'center' }}>
            <button onClick={virtual ? undefined : () => onToggleExpand(row.id)} disabled={virtual} className="tbtn-anim"
              title={virtual ? `步骤 ${row.steps.length} 条 — 全部模式(>1000)已关闭行内展开，请切分页/筛选后编辑` : `步骤 ${row.steps.length} 条 — 点击${opened ? '收起' : '展开'}行内编辑`}
              aria-label={`编辑用例 ${row.case_no} 的步骤`} aria-expanded={opened}
              style={{ ...CHIP, cursor: virtual ? 'default' : 'pointer', background: opened ? 'var(--accent)' : 'transparent', color: opened ? 'var(--accent-text)' : 'var(--text)', borderColor: opened ? 'var(--accent)' : 'var(--border-strong)', opacity: virtual ? 0.7 : 1 }}>
              {row.steps.length}
            </button>
          </td>
          <td style={{ ...TH_TD, whiteSpace: 'nowrap' }}>
            <button onClick={() => onDuplicate(row)} disabled={busy} className="tbtn-anim" style={ICON_BTN}
              title="复制用例 — 编号自动重排，副本状态回到草稿、执行结论重置" aria-label={`复制用例 ${row.case_no}`}>
              <Copy size={12} />
            </button>
            <button onClick={() => onRemove(row)} disabled={busy} className="tbtn-anim" style={{ ...ICON_BTN, color: 'var(--danger)', marginLeft: 4 }}
              title="删除用例 — 连带删除其步骤，此操作不可撤销" aria-label={`删除用例 ${row.case_no}`}>
              <Trash2 size={12} />
            </button>
          </td>
        </tr>
        {opened && renderExpanded(row, colSpan)}
      </Fragment>
    );
  };

  /** 行内展开区（§7.4）：整行跨列，前置/数据/预期/后置 + 步骤编辑 */
  const renderExpanded = (row: CaseRow, span: number) => {
    // 保留 id 就是为了做 key：步骤行如果按下标 key，重排/删除后 React 会按位置复用同一 DOM 节点，
    // 而未受控输入框的 value 已被用户写过（dirty 位已置），`defaultValue` 变更不会回写界面——
    // 最终变成「库里已重排、屏幕上仍是旧顺序」的假象；用 id 做 key 让节点跟着数据走
    const steps = row.steps.map((s) => ({ id: s.id, action: s.action, expected: s.expected }));
    /** 步骤整体重写提交（新增/删除/改文本/拖拽位都是「算出新数组再 PATCH」，端点只有一个） */
    const save = (next: Array<{ action: string; expected: string }>, label: string): void => onPatch(row.id, stepsBody(next), label);
    const moved = (from: number, to: number): Array<{ action: string; expected: string }> | null => {
      if (to < 0 || to >= steps.length || from === to) return null;
      const next = [...steps];
      const [hit] = next.splice(from, 1);
      next.splice(to, 0, hit);
      return next;
    };
    return (
      <tr>
        <td colSpan={span} style={{ padding: '6px 8px', background: 'var(--surface-2)', fontSize: 11, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, marginBottom: 6 }}>
            {([['preconditions', '前置条件'], ['testData', '测试数据'], ['expected', '预期结果'], ['postconditions', '后置条件'], ['tags', '标签']] as const).map(([key, label]) => (
              <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 2, color: 'var(--text-muted)' }}>
                {label}
                <textarea defaultValue={row[key === 'testData' ? 'test_data' : key]} disabled={busy} rows={2} aria-label={label}
                  onBlur={(e) => { if (e.target.value.trim() !== row[key === 'testData' ? 'test_data' : key]) onPatch(row.id, { [key]: e.target.value } as CasePatchBody, `已改${label}`); }}
                  style={{ ...CELL_INPUT, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 11, resize: 'vertical' }} />
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, color: 'var(--text-muted)' }}>
            <strong style={{ fontSize: 11 }}>步骤</strong>
            <span>操作 → 预期结果；改动即时保存，手柄可拖拽排序（键盘可用上下箭头）</span>
          </div>
          {steps.map((s, i) => (
            <div key={s.id || i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragFrom >= 0 && dragFrom !== i) { const next = moved(dragFrom, i); if (next) save(next, `已把步骤排到第 ${i + 1} 位`); } setDragFrom(-1); }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 16, textAlign: 'right' }}>{i + 1}.</span>
              <span draggable role="button" aria-label={`拖拽排序步骤 ${i + 1}`} title="拖拽调整步骤顺序"
                onDragStart={() => setDragFrom(i)} onDragEnd={() => setDragFrom(-1)}
                style={{ cursor: 'grab', display: 'inline-flex', color: 'var(--text-muted)' }}>
                <GripVertical size={12} />
              </span>
              <input defaultValue={s.action} disabled={busy} placeholder="操作描述" aria-label={`步骤 ${i + 1} 操作`}
                onBlur={(e) => { if (e.target.value !== s.action) save(steps.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)), `已改步骤 ${i + 1} 操作`); }}
                style={{ ...CELL_INPUT, flex: 1, minWidth: 120, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 11, padding: '2px 4px' }} />
              <input defaultValue={s.expected} disabled={busy} placeholder="预期结果" aria-label={`步骤 ${i + 1} 预期`}
                onBlur={(e) => { if (e.target.value !== s.expected) save(steps.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)), `已改步骤 ${i + 1} 预期`); }}
                style={{ ...CELL_INPUT, flex: 1, minWidth: 120, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 11, padding: '2px 4px' }} />
              <button onClick={() => { const up = moved(i, i - 1); if (up) save(up, `步骤 ${i + 1} 上移`); }} disabled={busy || i === 0} className="tbtn-anim"
                title="上移该步骤" aria-label={`上移步骤 ${i + 1}`} style={{ ...ICON_BTN, padding: '1px 4px' }}><ChevronUp size={11} /></button>
              <button onClick={() => { const dn = moved(i, i + 1); if (dn) save(dn, `步骤 ${i + 1} 下移`); }} disabled={busy || i === steps.length - 1} className="tbtn-anim"
                title="下移该步骤" aria-label={`下移步骤 ${i + 1}`} style={{ ...ICON_BTN, padding: '1px 4px' }}><ChevronDown size={11} /></button>
              <button onClick={() => save(steps.filter((_, j) => j !== i), `已删除步骤 ${i + 1}`)} disabled={busy} className="tbtn-anim"
                title="删除该步骤（其后步骤自动前移编号）" aria-label={`删除步骤 ${i + 1}`}
                style={{ ...ICON_BTN, padding: '1px 4px', color: 'var(--danger)' }}><Trash2 size={11} /></button>
            </div>
          ))}
          <button onClick={() => save([...steps, { action: '', expected: '' }], '已添加步骤')} disabled={busy} className="tbtn-anim"
            title="在末尾追加一个步骤" aria-label="添加步骤"
            style={{ ...ICON_BTN, marginTop: steps.length > 0 ? 2 : 0, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
            <Plus size={11} /> 添加步骤
          </button>
          {row.steps.length === 0 && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>（暂无步骤——点「添加步骤」补一条）</div>}
        </td>
      </tr>
    );
  };

  const renderHead = () => {
    // 虚拟模式表头 sticky（滚动时列名常驻）；非虚拟保持原样，不动既有观感
    const hb = virtual ? { ...TH, position: 'sticky' as const, top: 0, zIndex: 2, background: 'var(--surface-2)' } : TH;
    return (
      <thead>
        <tr style={{ color: 'var(--text-muted)', textAlign: 'left', background: 'var(--surface-2, transparent)' }}>
          {multi && (
            <th style={{ ...hb, width: 30 }}>
              <input ref={allRef} type="checkbox" checked={rows.length > 0 && selIds.length >= total}
                onChange={onToggleAll} title="全选/全不选当前筛选结果（跨分页）" aria-label="全选用例" style={{ cursor: 'pointer' }} />
            </th>
          )}
          <th style={hb}>用例编号</th>
          <th style={hb}>用例标题</th>
          <th style={hb}>所属模块</th>
          <th style={hb}>关联需求</th>
          <th style={hb}>优先级</th>
          <th style={hb}>类型</th>
          <th style={hb}>状态</th>
          <th style={hb}>执行结果</th>
          <th style={{ ...hb, textAlign: 'center' }}>步骤</th>
          <th style={hb}>操作</th>
        </tr>
      </thead>
    );
  };

  /** 「未覆盖的需求」视图：覆盖度里 caseCount=0 的行，出口是「为该需求补用例」（§7.2 [仅显示]） */
  const renderUncovered = () => (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', textAlign: 'left', background: 'var(--surface-2, transparent)' }}>
            <th style={TH}>需求编号</th>
            <th style={TH}>需求标题</th>
            <th style={{ ...TH, width: 90 }}>用例数</th>
            <th style={TH}>操作</th>
          </tr>
        </thead>
        <tbody>
          {uncovered.map((r) => (
            <tr key={r.reqId} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ ...TH_TD, color: 'var(--accent)', width: 100 }}>{r.reqNo || '—'}</td>
              <td style={TH_TD}>{r.title}</td>
              <td style={{ ...TH_TD, color: 'var(--danger)' }}>0</td>
              <td style={{ ...TH_TD, whiteSpace: 'nowrap' }}>
                <button onClick={() => onCoverReq(r.reqId)} className="tbtn-anim" style={{ ...ICON_BTN, color: 'var(--accent)', borderColor: 'var(--accent)' }}
                  title={`为该需求新增用例\n筛选切到 ${r.reqNo}，在上方输入框回车即可`} aria-label={`为需求 ${r.reqNo} 新增用例`}>
                  <Plus size={12} /> 补用例
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {uncovered.length === 0 && (
        <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--text-muted)' }}>
          所有需求都已有用例覆盖——覆盖度 100%。如需补充边界/异常场景，切回「全部用例」新增。
        </div>
      )}
    </div>
  );

  const renderEmpty = () => (
    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 4px' }}>
      {filtered ? (
        <>
          无匹配结果。
          <button onClick={onClearFilter} className="tbtn-anim" style={{ ...BTN, marginLeft: 6 }}
            title="清除全部筛选条件，回到完整列表" aria-label="清除筛选">清除筛选</button>
        </>
      ) : (
        '该项目暂无测试用例——可在上方手动新增，或前往 AI 工作台「从 PRD 生成测试用例」。'
      )}
    </div>
  );

  const renderPager = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
      <span>共 {total} 条{pageSize > 0 ? ` · 第 ${Math.min(page + 1, pageCount)}/${pageCount} 页` : ' · 全部模式'}</span>
      {pageSize > 0 && (
        <>
          <button onClick={() => onPage(page - 1)} disabled={busy || page <= 0} className="tbtn-anim" style={BTN}
            title="上一页" aria-label="上一页">上一页</button>
          <button onClick={() => onPage(page + 1)} disabled={busy || page + 1 >= pageCount} className="tbtn-anim" style={BTN}
            title="下一页" aria-label="下一页">下一页</button>
        </>
      )}
      <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}
        title="每页条数\n「全部」一次性取完（>1000 条时建议保持分页）" aria-label="每页条数"
        style={{ ...CELL_INPUT, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 11, padding: '2px 4px' }}>
        {PAGE_SIZE_OPTIONS.map((s) => <option key={s} value={s}>{PAGE_SIZE_LABELS[s]}</option>)}
      </select>
    </div>
  );

  if (scope === 'uncovered') return <>{renderUncovered()}</>;
  if (rows.length === 0) return <>{renderEmpty()}{total > 0 ? renderPager() : null}</>;

  // T01495：虚拟模式只切窗内行；上下各用一行等高占位 <tr> 撑出与全量一致的滚动区间（总高=start*rowH+窗口高+(count-end)*rowH=count*rowH）
  const bodyRows = win ? rows.slice(win.start, win.end) : rows;

  return (
    <>
      <datalist id="tc-module-options">
        {(meta?.modules ?? []).map((m) => <option key={m} value={m} />)}
      </datalist>
      <div
        style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6, ...(virtual ? { maxHeight: VIRTUAL_VIEWPORT_H, overflowY: 'auto' } : {}) }}
        onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          {renderHead()}
          <tbody key={`body-${syncNonce}${virtual ? '-v' : ''}`}>
            {win && win.padTop > 0 && <tr aria-hidden style={{ height: win.padTop }}><td colSpan={colSpan} style={{ padding: 0, border: 'none' }} /></tr>}
            {bodyRows.map((row) => renderRow(row))}
            {win && win.padBottom > 0 && <tr aria-hidden style={{ height: win.padBottom }}><td colSpan={colSpan} style={{ padding: 0, border: 'none' }} /></tr>}
          </tbody>
        </table>
      </div>
      {virtual && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          全部模式已载入 {rows.length} 条，超过 {VIRTUAL_THRESHOLD} 条自动启用虚拟滚动（仅渲染视口附近 {bodyRows.length} 行）；行内编辑/步骤展开请切 200/500 分页或按需求筛选。
        </div>
      )}
      {renderPager()}
    </>
  );
}
