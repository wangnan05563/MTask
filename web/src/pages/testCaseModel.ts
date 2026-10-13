/**
 * T01485：测试用例面板的共享类型与展示常量（PRD-测试用例管理 §7.3 / §9.1）。
 *
 * 单源理由：`TestCasePanel` / `TestCaseToolbar` / `TestCaseTable` / `TestCaseFilterBar` 四个文件
 * 都要用同一份行结构与列样式，拆文件的同时不希望出现第二套字段名或宽度。
 * 枚举值与中文标签一律来自服务端 `GET /plans/test-cases/meta`（`util/testCaseEnums.ts` 单源），
 * 本文件只描述"它的形状"，绝不重复列出取值——否则就是 PRD §5.4 明令杜绝的口径漂移。
 */
import type { CSSProperties } from 'react';

/** 步骤行（服务端 `case_steps` 原样字段名，snake_case 与全站一致） */
export interface CaseStep {
  id: string;
  case_id: string;
  step_no: number;
  action: string;
  expected: string;
}

/** 用例行 + 步骤 + 关联需求摘要（§6.2 `TestCaseWithSteps`） */
export interface CaseRow {
  id: string;
  project_id: string;
  /** null = 孤儿用例（未关联需求，准则 P4） */
  req_id: string | null;
  case_no: string;
  module: string;
  title: string;
  preconditions: string;
  expected: string;
  test_data: string;
  postconditions: string;
  priority: string;
  type: string;
  method: string;
  status: string;
  last_result: string;
  tags: string;
  source_key: string;
  source_hash: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  steps: CaseStep[];
  reqNo: string | null;
  reqTitle: string | null;
}

/** `GET /plans/test-cases/meta` 响应：五组枚举 + 标签 + 默认值 + 项目内已有模块 */
export interface CaseMeta {
  priority: string[];
  priorityLabel: Record<string, string>;
  type: string[];
  typeLabel: Record<string, string>;
  method: string[];
  methodLabel: Record<string, string>;
  status: string[];
  statusLabel: Record<string, string>;
  result: string[];
  resultLabel: Record<string, string>;
  defaults: { priority: string; type: string; method: string; status: string; lastResult: string };
  modules: string[];
}

/** 工具条统计（§7.2 第一行「共 N 条 · 已关联需求 M 条 · 孤儿 K 条」） */
export interface CaseStats {
  total: number;
  linked: number;
  orphan: number;
}

/** 覆盖度（§6.2 coverage：「仅未覆盖的需求」视图数据源） */
export interface CaseCoverage {
  total: number;
  covered: number;
  uncovered: number;
  rate: number;
  byReq: Array<{ reqId: string; reqNo: string; title: string; caseCount: number }>;
}

/** 项目内需求精简行（关联需求 chip / 下拉用） */
export interface ReqLite {
  id: string;
  req_no: string;
  title: string;
}

/** 筛选条状态（§7.1 `tc.filters`）；空串=不过滤 */
export interface CaseFilters {
  module: string;
  priority: string;
  type: string;
  status: string;
  result: string;
  orphanOnly: boolean;
}

export const EMPTY_FILTERS: CaseFilters = {
  module: '', priority: '', type: '', status: '', result: '', orphanOnly: false,
};

/** PATCH 入参（camelCase，服务端 §6.2 定义）：省略=不改；字符串传 ''=清空；`reqId` 传 '' 解除关联 */
export interface CasePatchBody {
  title?: string;
  caseNo?: string;
  module?: string;
  preconditions?: string;
  expected?: string;
  testData?: string;
  postconditions?: string;
  tags?: string;
  priority?: string;
  type?: string;
  method?: string;
  status?: string;
  lastResult?: string;
  reqId?: string | null;
  steps?: Array<{ action: string; expected: string }>;
}

/** 批量 patch 可改字段（§6.3 `PATCH /test-cases/batch` 的 `patch` 体）：`reqId` 传 `null` = 解除关联 */
export interface CaseBatchFields {
  priority?: string;
  type?: string;
  method?: string;
  status?: string;
  lastResult?: string;
  module?: string;
  reqId?: string | null;
}

/** 分页档位：0 表示「全部」模式（服务端 `limit≤0` 取全量，§7.3） */
export const PAGE_SIZE_OPTIONS = [200, 500, 0] as const;
export const PAGE_SIZE_LABELS: Record<number, string> = { 200: '200/页', 500: '500/页', 0: '全部' };

/**
 * T01495（PRD §11 性能）：全部模式一次性取全量，>1000 条时上千行「输入框 + 下拉」控件会把主线程压死。
 * 仅对「全部」模式（`pageSize===0`）且已载入行数 `>1000` 窗口化渲染——**分页档位（200/500）恒不触发**（每页本就 ≤500 行，
 * 加虚拟滚动是 PRD 明令避免的过度设计）。窗口计算与触发判定都是纯函数，脱离 DOM 可单测（见 t01495 探针）。
 */
export const VIRTUAL_THRESHOLD = 1000;
/** 折叠行固定行高（行内输入框单行 + 上下 padding，主 `<tr>` 显式设高保证窗口数学不漂） */
export const VIRTUAL_ROW_H = 32;
/** 虚拟滚动视口高度（约 20 行；决定一次实际渲染的 DOM 行数上界，与总条数无关） */
export const VIRTUAL_VIEWPORT_H = 640;
/** 视口上下各多渲染的行数，缓冲快速滚动时的空白 */
export const VIRTUAL_OVERSCAN = 8;

/** 是否进入虚拟滚动：仅「全部」模式且 >1000 行（分页模式恒 false，勿过度设计） */
export function shouldVirtualize(pageSize: number, rowCount: number): boolean {
  return pageSize === 0 && rowCount > VIRTUAL_THRESHOLD;
}

/** 窗口切片结果：`[start,end)` 渲染，`padTop/padBottom` 用等高占位撑出真实滚动区间 */
export interface VWindow { start: number; end: number; padTop: number; padBottom: number; }

/**
 * 固定行高窗口计算。渲染行数上界 = 视口行 + 2×overscan，与 `rowCount` 无关——
 * 这正是本单唯一要证的「大列表 DOM 行数不再随条数线性增长」；总占位高度恒等于 `rowCount*rowH`，
 * 故滚动条长度与全量渲染一致，不会出现「滚到底发现还有一截」的错位。
 */
export function computeWindow(
  scrollTop: number, rowCount: number,
  rowH: number = VIRTUAL_ROW_H, viewportH: number = VIRTUAL_VIEWPORT_H, overscan: number = VIRTUAL_OVERSCAN,
): VWindow {
  if (rowCount <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowH));
  const visible = Math.ceil(viewportH / rowH);
  const start = Math.min(rowCount, Math.max(0, first - overscan));
  const end = Math.min(rowCount, first + visible + overscan);
  return { start, end, padTop: start * rowH, padBottom: Math.max(0, (rowCount - end) * rowH) };
}

/**
 * 变高窗口计算（T02121 估算明细段：里程碑表头 + 任务行高度不同）。
 * `offsets` 为累计顶偏移数组（长度 n+1，offsets[0]=0, offsets[n]=总高），由调用方按各 entry 实际高度累加。
 * 返回 [start,end) 渲染区间 + 顶/底占位高，与 `computeWindow` 同 `VWindow` 契约：
 * 渲染行数上界 = 视口行 + 2×overscan，与 `rowCount` 无关；总占位恒等于 `offsets[n]`，滚动条长度与全量一致。
 * 纯函数、脱离 DOM，可单测（见 .workbuddy/t02121-verify.mts）。
 */
export function computeWindowVar(
  scrollTop: number, offsets: number[], viewportH: number, overscan = VIRTUAL_OVERSCAN,
): VWindow {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const total = offsets[n];
  // 视口内首条：最大的 i 使 offsets[i] <= scrollTop（该 entry 顶在视口上沿或上方）
  const first = lastLE(offsets, scrollTop);
  // 视口内末条之后：最小的 i 使 offsets[i] >= scrollTop + viewportH
  const past = firstGE(offsets, scrollTop + viewportH);
  const start = Math.max(0, first - overscan);
  const end = Math.min(n, past + overscan);
  return { start, end, padTop: offsets[start], padBottom: Math.max(0, total - offsets[end]) };
}

/** 最大下标 i 使 offsets[i] <= x（offsets 升序；x<offsets[0] 返回 0） */
function lastLE(offsets: number[], x: number): number {
  let lo = 0, hi = offsets.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= x) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
/** 最小下标 i 使 offsets[i] >= x（offsets 升序；x>offsets[末] 返回 offsets.length） */
function firstGE(offsets: number[], x: number): number {
  let lo = 0, hi = offsets.length - 1, ans = offsets.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] >= x) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}

/** 执行结果着色（§7.3 列 8）：pass→success，fail→danger，blocked/skip→muted */
export const RESULT_COLOR: Record<string, string> = {
  pass: 'var(--success)',
  fail: 'var(--danger)',
  blocked: 'var(--text-muted)',
  skip: 'var(--text-muted)',
  untested: 'var(--text)',
};

/** 「仅显示」下拉三态（§7.2 第二行） */
export type CaseScope = 'all' | 'orphan' | 'uncovered';

export function scopeOf(filters: CaseFilters, uncoveredOnly: boolean): CaseScope {
  if (uncoveredOnly) return 'uncovered';
  return filters.orphanOnly ? 'orphan' : 'all';
}

/** 是否处于「有内容被过滤」状态——空态文案要区分「没有用例」与「筛选无结果」（§7.7） */
export function hasActiveFilter(filters: CaseFilters, keyword: string, reqFilter: string): boolean {
  return Boolean(filters.module || filters.priority || filters.type || filters.status || filters.result
    || filters.orphanOnly || keyword.trim() || reqFilter);
}

/**
 * 拼列表 query。`pageSize=0` 传 `limit=0`（服务端「全部」模式），
 * 其余按 `limit/offset` 翻页；空值一律不拼，避免服务端把 `''` 当筛选值匹配不到。
 */
export function buildListQuery(input: {
  projectId: string;
  reqId: string;
  keyword: string;
  filters: CaseFilters;
  pageSize: number;
  page: number;
}): string {
  const p = new URLSearchParams();
  p.set('projectId', input.projectId);
  if (input.reqId) p.set('reqId', input.reqId);
  if (input.keyword.trim()) p.set('q', input.keyword.trim());
  if (input.filters.module) p.set('module', input.filters.module);
  if (input.filters.priority) p.set('priority', input.filters.priority);
  if (input.filters.type) p.set('type', input.filters.type);
  if (input.filters.status) p.set('status', input.filters.status);
  if (input.filters.result) p.set('result', input.filters.result);
  if (input.filters.orphanOnly) p.set('orphanOnly', 'true');
  p.set('limit', String(input.pageSize));
  p.set('offset', String(input.pageSize > 0 ? input.page * input.pageSize : 0));
  return `/plans/test-cases?${p.toString()}`;
}

/**
 * 拼导出请求体（§6.4）。字段集合与 `buildListQuery` 一一对应，所以成对放在本文件：
 * 两处各写一遍筛选字段，就是「界面筛的是一套、导出的是另一套」这类漂移的源头。
 * `ids` 非空时只看选择集（§7.6 优先级最高），其余条件不下发——否则服务端两套条件取交集，
 * 导出行数会比用户勾的条数少，而界面提示的偏偏是「选中的 N 条」。
 */
export function buildExportBody(input: {
  projectId: string;
  reqId: string;
  keyword: string;
  filters: CaseFilters;
  ids: string[];
  format: string;
}): Record<string, unknown> {
  const { projectId, reqId, keyword, filters, ids, format } = input;
  if (ids.length > 0) return { projectId, format, ids };
  const kw = keyword.trim();
  return {
    projectId,
    format,
    ...(reqId ? { reqId } : {}),
    ...(kw ? { q: kw } : {}),
    ...(filters.module ? { module: filters.module } : {}),
    ...(filters.priority ? { priority: filters.priority } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.result ? { result: filters.result } : {}),
    ...(filters.orphanOnly ? { orphanOnly: true } : {}),
  };
}

/** 标签取值：meta 未就绪（首屏）时回落原值，避免 select 闪空白 */
export type CaseLabelGroup = 'priorityLabel' | 'typeLabel' | 'methodLabel' | 'statusLabel' | 'resultLabel';

export function enumLabel(meta: CaseMeta | null, group: CaseLabelGroup, value: string): string {
  return meta?.[group]?.[value] ?? value;
}

// ---------- 样式常量：与 ReqMatrixPanel 完全同构（§9.1 基线） ----------
export const TH_TD: CSSProperties = { padding: '4px 6px' };
export const TH: CSSProperties = { padding: '5px 6px' };
/** 行内编辑输入框：默认透明边框呈文本观感（§9.1 表格基线） */
export const CELL_INPUT: CSSProperties = {
  border: '1px solid transparent', borderRadius: 4, background: 'transparent',
  color: 'var(--text)', fontSize: 12, padding: '1px 4px',
};
/** 关联 chip（§9.1「fs 11 / border-strong / radius 4 / padding 0 4px」） */
export const CHIP: CSSProperties = {
  fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px', color: 'var(--text)',
};
/** 图标-only 按钮 */
export const ICON_BTN: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)',
  borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 6px',
};
/** 带文字的次要按钮（§9.1 btnStyle 基线：fs 12 / padding 3px 8px / radius 4） */
export const BTN: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12,
  padding: '3px 8px', border: '1px solid var(--border-strong)', borderRadius: 4,
  background: 'transparent', color: 'var(--text)',
};
/** 批量条内下拉（§7.5：padding 2 / fs 11 / radius 4） */
export const BATCH_SELECT: CSSProperties = {
  padding: 2, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 4,
  background: 'var(--card-bg)', color: 'var(--text)',
};
