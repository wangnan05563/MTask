/**
 * T01486：需求跟踪矩阵表格子组件（从 `ReqMatrixPanel` 拆出）。
 *
 * 拆出动因：矩阵面板原本 577 行，本次要新增「用例」列（§4.3 下钻入口）、覆盖度取数、
 * 反向跳转的行定位与高亮，继续留在主文件会突破 §14 风险表立的「单文件 ≤600 行」红线。
 * 本文件是**纯搬迁**——列结构、行内编辑、详情展开、关联调整的 DOM 与交互与拆分前一致，
 * 只新增第 5 列「用例」；父组件通过 `data-req-id` 定位行做跳转高亮。
 */
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { FIELD_INLINE } from '../ui/primitives'; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
import { Archive, ChevronDown, ChevronUp, FileText, Link2, Minimize2, Sparkles, Trash2 } from 'lucide-react';
import type { MatrixReq } from './ReqMatrixPanel';
import { MatrixCaseCell } from './MatrixCaseCell';
import { NotOpenButton } from '../ui/notOpen'; // T03185（UX-05⑤）：未开放入口=可见但禁用+范围说明
import { priorityColor, priorityWithP } from '../ui/priority'; // PM-302 ③：优先级 P 档换算与配色单源
import { STATUS_OPTIONS } from './ReqMatrixPanel';

/** 表格渲染所需的全部状态与动作（由父组件持有，本组件不碰任何数据源） */
export interface MatrixTableProps {
  readonly rows: MatrixReq[];
  readonly multi: boolean;
  readonly selIds: string[];
  readonly caseCounts: Record<string, number>;
  readonly queryId: string;
  readonly linkFor: string;
  /** 用例侧反向跳转带来的需求 id（命中行加底色高亮，§4.3） */
  readonly locateReqId: string;
  /** T01873：重复编号命中行 → 悬浮说明文案；空对象表示本项目无重复编号，行内不产生任何标记 */
  readonly dupInfo: Record<string, string>;
  readonly allRef: RefObject<HTMLInputElement>;
  readonly setSelIds: Dispatch<SetStateAction<string[]>>;
  readonly setQueryId: Dispatch<SetStateAction<string>>;
  readonly onUpdate: (id: string, patch: Partial<Pick<MatrixReq, 'title' | 'req_no' | 'status' | 'priority'>>) => void;
  readonly onToggleLink: (reqId: string, kind: 'plan' | 'task', targetId: string, linked: boolean) => void;
  readonly onSetLinkFor: (reqId: string) => void;
  readonly onRemove: (r: MatrixReq) => void;
  readonly onOpenPrd: (doc: { id: string; filename: string }, locate?: { title: string; reqNo: string }) => void;
  readonly onDrillCases: (reqId: string) => void;
}

const TD_STYLE = { padding: '4px 6px' } as const;

/** T01703：矩阵优先级 ↔ 用例 P 档同屏换算标注（urgent↔P0 / high↔P1 / normal↔P2 / low↔P3），
 *  与测试用例列表（P0~P3 词表）同屏时无需人工换算；存量矩阵值即存储枚举，标注为只读换算。
 *  PM-302 ③：换算表与配色一并收进 ui/priority.ts，矩阵与列表/看板/移动端共用同一映射。 */
const PLAIN_INPUT = FIELD_INLINE; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
/** 标题栏里的「开发中」占位按钮（T00842 位置3：样式对齐任务菜单同名按钮） */
const TODO_BTN_STYLE = {
  border: 'none', background: 'transparent', cursor: 'pointer',
  color: 'var(--text-muted)', padding: 2, display: 'inline-flex', flexShrink: 0,
} as const;

/**
 * 行定位高亮底色：内联而不是加 class —— 全站样式集中在 `App.tsx` 的内联 `<style>`，
 * 为一个临时态再开一份 CSS 资产不划算；内联值同时能被 `getComputedStyle` 直接断言。
 */
const LOCATE_BG = 'var(--accent-soft, rgba(128,128,128,.16))';

/**
 * T00842 位置3 → T03185（UX-05⑤）：标题栏的三个未开放入口。
 * 此前是「点了只弹一句开发中」的可用态按钮；PRD 要求主界面不存在这类入口，
 * 统一改成「可见但禁用 + 范围说明」（`NotOpenButton`，沿用 D-14 的口径）。
 * 仍提取为局部常量以压住 renderMatrixTable 的认知复杂度（S3776）。
 */
const renderTitleTodoActions = (): ReactNode => (
  <>
    <NotOpenButton className="tbtn-anim" label="AI 美化" scope="polishTitle" icon={<Sparkles size={12} />} style={TODO_BTN_STYLE} />
    <NotOpenButton className="tbtn-anim" label="AI 简化" scope="summarizeTitle" icon={<Minimize2 size={12} />} style={TODO_BTN_STYLE} />
    <NotOpenButton className="tbtn-anim" label="归档" scope="archiveReq" icon={<Archive size={12} />} style={TODO_BTN_STYLE} />
  </>
);

/** 需求跟踪矩阵主表（含空态）；`x` 形参为 TS 收窄后的惯用命名，勿误读为闭包 x */
// T03185（UX-05⑤）：占位按钮改禁用后不再需要 `flash`，形参一并摘掉（父级调用点同步）
export function MatrixTable({ p }: { readonly p: MatrixTableProps }) {
  const { rows, multi, selIds, caseCounts, queryId, linkFor, allRef } = p;

  if (rows.length === 0) {
    return <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>该项目暂无需求记录——可用「从 PRD 导入项目计划」生成，或在上方手动新增。</div>;
  }

  /** 多选模式的行内勾选单元格（M6-6.4：提取以消除 S2004 深嵌套） */
  const renderSelectCell = (r: MatrixReq) => (
    <td style={TD_STYLE}>
      <input type="checkbox" checked={selIds.includes(r.id)}
        onChange={(e) => p.setSelIds(e.target.checked ? [...selIds, r.id] : selIds.filter((x) => x !== r.id))}
        aria-label={`选中需求 ${r.title}`} title={`选中 ${r.req_no || ''} ${r.title}`}
        style={{ cursor: 'pointer' }} />
    </td>
  );

  /** 标题单元格：行内编辑 + 详情展开 + 三个占位 AI 按钮（T00765 / T00842） */
  const renderTitleCell = (r: MatrixReq) => (
    <td style={{ padding: '4px 6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <input defaultValue={r.title} aria-label="需求标题" title={r.content || r.source_ref || '（无详情）'}
          onBlur={(e) => { if (e.target.value !== r.title) p.onUpdate(r.id, { title: e.target.value }); }}
          style={{ ...PLAIN_INPUT, flex: 1, minWidth: 150, color: 'var(--text)' }} />
        <button onClick={() => p.setQueryId(queryId === r.id ? '' : r.id)} className="tbtn-anim"
          title={queryId === r.id ? '收起需求详情' : '查询需求详情（内容/来源/优先级）'}
          aria-label={`查询需求 ${r.title} 详情`} aria-expanded={queryId === r.id}
          style={{ ...TODO_BTN_STYLE, color: queryId === r.id ? 'var(--accent)' : 'var(--text-muted)' }}>
          {queryId === r.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {renderTitleTodoActions()}
      </div>
      {r.source_ref && <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', paddingLeft: 4 }}>{r.source_ref}</div>}
      {queryId === r.id && renderDetail(r)}
    </td>
  );

  /** 详情展开区（T00765 内容/来源/优先级 + T00763 PRD 原文入口） */
  const renderDetail = (r: MatrixReq) => (
    <div style={{ marginTop: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', fontSize: 'var(--fs-xs)', color: 'var(--text)' }}>
      <div style={{ whiteSpace: 'pre-wrap' }}>{r.content ? r.content : '（无内容）'}</div>
      <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>来源：{r.source_ref || '—'} · 优先级：<span style={{ color: priorityColor(r.priority) }}>{priorityWithP(r.priority)}</span> · 状态：{r.status || 'todo'}</div>
      {r.prdDoc && (
        <div style={{ marginTop: 6 }}>
          <button onClick={() => p.onOpenPrd(r.prdDoc!)} className="tbtn-anim"
            title={`查看 PRD 原文：${r.prdDoc.filename || '未命名'}`}
            aria-label={`查看需求 ${r.title} 关联的 PRD 原文`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', border: '1px solid var(--accent)', borderRadius: 5, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '2px 8px' }}>
            <FileText size={11} /> 查看PRD
          </button>
        </div>
      )}
    </div>
  );

  /** 关联计划 chip：标题超 14 字截断（与拆分前一致） */
  const renderPlanChips = (items: MatrixReq['linkedPlans']) => (
    items.length === 0
      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
      : (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 3 }}>
          {items.map((x) => (
            <span key={x.id} title={`计划：${x.title}（${x.status}）`}
              style={{ fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', color: 'var(--text)' }}>
              {x.title.length > 14 ? `${x.title.slice(0, 14)}…` : x.title}
            </span>
          ))}
        </span>
      )
  );

  /** 关联待办 chip：显示任务号，已完成转 success 色 */
  const renderTaskChips = (items: MatrixReq['linkedTasks']) => (
    items.length === 0
      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
      : (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 3 }}>
          {items.map((x) => (
            <span key={x.id} title={`待办：${x.title}（${x.status === 'done' ? '已完成' : '待办'}${x.verified ? '·已验证' : ''}）`}
              style={{ fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', color: x.status === 'done' ? 'var(--success)' : 'var(--text)' }}>
              {x.taskNo ?? '—'}
            </span>
          ))}
        </span>
      )
  );

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)' }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', textAlign: 'left', background: 'var(--surface-2, transparent)' }}>
            {/* 多选模式勾选列——表头全选含半选态（T00773） */}
            {multi && (
              <th style={{ padding: '5px 6px', width: 30 }}>
                <input ref={allRef} type="checkbox"
                  checked={rows.length > 0 && selIds.length === rows.length}
                  onChange={(e) => p.setSelIds(e.target.checked ? rows.map((r) => r.id) : [])}
                  title="全选/全不选当前需求" aria-label="全选需求"
                  style={{ cursor: 'pointer' }} />
              </th>
            )}
            <th style={{ padding: '5px 6px' }}>需求编号</th>
            <th style={{ padding: '5px 6px' }}>需求标题</th>
            <th style={{ padding: '5px 6px' }}>状态</th>
            <th style={{ padding: '5px 6px' }}>关联计划</th>
            {/* T01486：「用例」列——覆盖度指标（准则 P5）+ 矩阵下钻用例视图的唯一入口 */}
            <th style={{ padding: '5px 6px' }} title="该需求关联的测试用例条数；点击在测试用例视图中只看该需求">用例</th>
            <th style={{ padding: '5px 6px' }}>关联PRD</th>
            <th style={{ padding: '5px 6px' }}>关联待办</th>
            <th style={{ padding: '5px 6px' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-req-id={r.id} data-locate={p.locateReqId === r.id ? '1' : undefined}
              style={{ borderTop: '1px solid var(--border)', background: p.locateReqId === r.id ? LOCATE_BG : undefined }}>
              {multi && renderSelectCell(r)}
              <td style={{ padding: '4px 6px', width: 100 }}>
                {/* T01873：与本行同号的其他行存在时，编号按 --danger 口径标红（与工具条 banner 同色），
                    悬浮说明点名「另一行是谁」；无重复编号的行渲染与之前完全一致 */}
                <input defaultValue={r.req_no} aria-label="需求编号" title={p.dupInfo[r.id] ?? '需求编号（失焦保存）'}
                  data-dup={p.dupInfo[r.id] ? '1' : undefined}
                  onBlur={(e) => { if (e.target.value !== r.req_no) p.onUpdate(r.id, { req_no: e.target.value }); }}
                  style={{ ...PLAIN_INPUT, width: 88, color: p.dupInfo[r.id] ? 'var(--danger)' : 'var(--accent)', border: p.dupInfo[r.id] ? '1px solid var(--danger)' : PLAIN_INPUT.border }} />
              </td>
              {renderTitleCell(r)}
              <td style={{ padding: '4px 6px', width: 96 }}>
                <select value={r.status} onChange={(e) => p.onUpdate(r.id, { status: e.target.value })}
                  aria-label="需求状态" title="需求状态"
                  style={{ border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)', padding: '1px 4px' }}>
                  {STATUS_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </td>
              <td style={{ padding: '4px 6px', maxWidth: 200 }}>
                {renderPlanChips(r.linkedPlans)}
              </td>
              <MatrixCaseCell reqId={r.id} reqNo={r.req_no} title={r.title}
                count={caseCounts[r.id] ?? 0} onDrill={p.onDrillCases} />
              <td style={{ padding: '4px 6px', maxWidth: 180 }}>
                {r.prdDoc ? (
                  <button onClick={() => p.onOpenPrd(r.prdDoc!, { title: r.title, reqNo: r.req_no })} className="tbtn-anim"
                    title={`打开 PRD 原文：${r.prdDoc.filename}（定位到「${r.title}」章节）`}
                    aria-label={`打开关联 PRD ${r.prdDoc.filename}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: 0, maxWidth: '100%', textAlign: 'left' }}>
                    <FileText size={11} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.prdDoc.filename}</span>
                  </button>
                ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
              </td>
              <td style={{ padding: '4px 6px', maxWidth: 200 }}>
                {renderTaskChips(r.linkedTasks)}
              </td>
              <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                <button onClick={() => p.onSetLinkFor(r.id)} className="tbtn-anim"
                  title="关联调整 — 勾选计划或待办建立/解除关联" aria-label={`调整 ${r.title} 的关联`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4, background: linkFor === r.id ? 'var(--accent)' : 'transparent', color: linkFor === r.id ? 'var(--accent-text)' : 'var(--text)', cursor: 'pointer', padding: '1px 6px', marginRight: 4 }}>
                  <Link2 size={11} /> 关联
                </button>
                <button onClick={() => p.onRemove(r)} className="tbtn-anim" title="删除需求（清理关联）" aria-label={`删除需求 ${r.title}`}
                  style={{ display: 'inline-flex', border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', padding: 2 }}>
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
