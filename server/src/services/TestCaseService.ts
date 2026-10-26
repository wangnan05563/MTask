/**
 * 测试用例服务（T01483 · PRD-测试用例管理 §6.2/§6.3）。
 *
 * 与 `PlanService` 的需求矩阵 CRUD 同构（snake_case 行 + camelCase 入参 + uuid 主键），
 * 但有四点刻意不同，都是 PRD 明确项：
 *  1. 过滤与分页全部在服务端做——用例数量级远大于矩阵行，`listRequirements` 的全量返回不可照抄（§6.2）；
 *  2. 步骤一次 `WHERE case_id IN (...)` 取全、覆盖度一次 `GROUP BY`，杜绝 N+1（§11）；
 *  3. 所有写操作末尾 `notifyChange('plans')`：矩阵侧历史上没广播，改完必须手动刷新，新模块修正这一点（§6.7）；
 *  4. 删除一律走 `db.transaction()`，步骤与用例同事务收口（§11 数据一致）。
 *
 * 错误语义：业务错误 `throw new Error(中文文案)`，由 `routes/plans.ts` 的 `wrap()` 统一转 400。
 * 枚举口径：见 `util/testCaseEnums.ts`——写入脏值回落默认值，筛选非法值直接报错（差异原因见 `filterEnum`）。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { notifyChange } from './ChangeBus';
import {
  CASE_DEFAULTS,
  CASE_METHOD,
  CASE_PRIORITY,
  CASE_RESULT,
  CASE_STATUS,
  CASE_TYPE,
  caseEnumMeta,
  pickEnum,
} from '../util/testCaseEnums';
import type { CaseMethod, CasePriority, CaseResult, CaseStatus, CaseType } from '../util/testCaseEnums';
// T01492：幂等去重键与内容指纹的单源——写库必须逐字复现生成期口径，否则「生成期判已入库」与「写库期查重」分裂（§2.2 P6）
import { caseSourceKey, caseContentHash } from './testCaseGenParse';
import { reqNoKey } from '../util/reqNo';

/** 默认每页条数（§7.3 分页档位 200 / 500 / 全部） */
const DEFAULT_PAGE_SIZE = 200;
/** 「全部」模式的硬上限：取全量也要有护栏，防极端行数把事件循环占死（§11 性能） */
const MAX_PAGE_SIZE = 5000;

export interface CaseStepRow {
  id: string;
  case_id: string;
  step_no: number;
  action: string;
  expected: string;
  created_at: string;
  updated_at: string;
}

export interface TestCaseRow {
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
  priority: CasePriority;
  type: CaseType;
  method: CaseMethod;
  status: CaseStatus;
  last_result: CaseResult;
  tags: string;
  source_key: string;
  source_hash: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 列表/详情返回体：DB 行 + 步骤数组 + 关联需求摘要（矩阵 chip 与双向跳转要用，§4.3） */
export interface TestCaseWithSteps extends TestCaseRow {
  steps: CaseStepRow[];
  reqNo: string | null;
  reqTitle: string | null;
}

export interface CaseStepInput {
  action?: string;
  expected?: string;
  /** 省略时按数组下标 +1 落库 */
  stepNo?: number;
}

export interface CaseQuery {
  projectId: string;
  reqId?: string;
  q?: string;
  module?: string;
  priority?: string;
  type?: string;
  status?: string;
  result?: string;
  orphanOnly?: boolean;
  /** 省略=默认 200；≤0=「全部」模式（取到 MAX_PAGE_SIZE 为止） */
  limit?: number;
  offset?: number;
}

export interface CaseInput {
  projectId: string;
  reqId?: string | null;
  title: string;
  caseNo?: string;
  module?: string;
  preconditions?: string;
  expected?: string;
  testData?: string;
  postconditions?: string;
  priority?: string;
  type?: string;
  method?: string;
  status?: string;
  lastResult?: string;
  tags?: string;
  sourceKey?: string;
  sourceHash?: string;
  sortOrder?: number;
  steps?: CaseStepInput[];
}

/** PATCH 入参：字段省略=不改；字符串字段传 ''=清空；`reqId` 传 '' 或 null=解除关联（§6.2） */
export type CasePatch = Partial<Omit<CaseInput, 'projectId'>>;

/** 批量 PATCH 允许的字段（§6.3，不含 title/case_no——编号与标题必须逐条改） */
export interface CaseBatchPatch {
  priority?: string;
  type?: string;
  method?: string;
  status?: string;
  lastResult?: string;
  reqId?: string | null;
  module?: string;
}

/**
 * T01492（§8.5）：草稿确认导入的单条用例入参。
 * 前端草稿可就地编辑，故 `source_key`/`source_hash` 一律由服务端按单源公式**重算**、绝不信任客户端携带值——
 * 用户改了标题就应产出新的去重键（改后视为另一条用例），未改则与生成期命中同键、触发幂等跳过。
 */
export interface DraftCaseImport {
  reqNo?: string;
  title?: string;
  module?: string;
  preconditions?: string;
  expected?: string;
  testData?: string;
  postconditions?: string;
  priority?: string;
  type?: string;
  method?: string;
  tags?: string;
  steps?: CaseStepInput[];
  /** 草稿视图勾选态：显式 false 才排除（缺省视为勾选，§8.5「不勾选不入库」） */
  include?: boolean;
}

/** 草稿拆分需求条目（仅 writeRequirements 时把 isNew 项写入矩阵，§8.1 勾选） */
export interface DraftReqImport {
  reqNo?: string;
  title?: string;
  content?: string;
  sourceRef?: string;
  priority?: string;
  isNew?: boolean;
}

/** `POST /test-cases/import-draft` 入参（单事务：建需求→reqNo→id 映射→用例落库→步骤落库→source_key 幂等） */
export interface DraftImportInput {
  projectId: string;
  requirements?: DraftReqImport[];
  cases: DraftCaseImport[];
  /** 是否把本次新拆分的需求写入需求跟踪矩阵；false 时新需求下的用例落孤儿（req_id=NULL） */
  writeRequirements?: boolean;
}

/** 联表查询行（DB 列 + LEFT JOIN 附带的需求摘要） */
type JoinedCase = Omit<TestCaseRow, 'priority' | 'type' | 'method' | 'status' | 'last_result'> & {
  priority: string;
  type: string;
  method: string;
  status: string;
  last_result: string;
  reqNo: string | null;
  reqTitle: string | null;
};

/** 列表与详情共用：用例 LEFT JOIN 需求（矩阵行被删时摘要为 null，孤儿用例本就该显示空） */
const CASE_SELECT = `SELECT c.*, r.req_no AS reqNo, r.title AS reqTitle
   FROM test_cases c
   LEFT JOIN prd_requirements r ON r.id = c.req_id`;

/** PATCH 里的纯文本字段 → 列名映射（枚举/关联/排序各有专属处理，不混在此表） */
const CASE_TEXT_FIELDS: Array<[keyof CasePatch, string]> = [
  ['caseNo', 'case_no'],
  ['module', 'module'],
  ['title', 'title'],
  ['preconditions', 'preconditions'],
  ['expected', 'expected'],
  ['testData', 'test_data'],
  ['postconditions', 'postconditions'],
  ['tags', 'tags'],
];

function now(): string {
  return new Date().toISOString();
}

/** 文本列取值：null/undefined → 空串（这些列 DDL 均 NOT NULL DEFAULT ''），并去首尾空白 */
function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v).trim();
  // 入参偶发是对象/数组（AI 生成链路脏值），直接 String() 会得到 [object Object]，序列化保留内容
  return JSON.stringify(v) ?? '';
}

/** 动态 IN 占位符（值一律参数绑定，不拼字面量） */
function inHolders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

/**
 * 写入路径的枚举取值：脏值回落默认。
 * 用例字段大量来自 AI 生成与批量导入，单字段非法不该让整条写操作 500（`pickEnum` 的既定语义）。
 */
function enumVal<T extends string>(raw: unknown, allowed: readonly T[], dft: T): T {
  return pickEnum(raw, allowed, dft) ?? dft;
}

/**
 * 筛选路径的枚举取值：非法值直接报错。
 * 与 `TaskService:222`（非法优先级忽略、保持全量）刻意不同——用例枚举是 §5.4 的单源封闭集合，
 * UI 下拉只会下发合法值，能传进非法值的必是调用方缺陷；静默忽略会把「筛 P9」变成「不筛」，
 * 返回比预期更多的行，比一次 400 更难被发现。
 */
function filterEnum<T extends string>(raw: string | undefined, allowed: readonly T[], label: string): T | undefined {
  const v = str(raw);
  if (!v) return undefined;
  if (!allowed.includes(v as T)) throw new Error(`非法${label}：${v}`);
  return v as T;
}

function requireProject(db: ReturnType<typeof getDb>, projectId: string): void {
  if (!str(projectId)) throw new Error('projectId 必填');
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new Error('项目不存在');
}

/**
 * req_id 归一：''/null/undefined 一律落 NULL（可空即「孤儿用例」，准则 P4）。
 * 传了值就必须存在且属于同一项目——FK 也会拦，但 `FOREIGN KEY constraint failed`
 * 这种文案移动端与 UI 都读不懂，本层先换成人话。
 */
function resolveReqId(db: ReturnType<typeof getDb>, raw: unknown, projectId?: string): string | null {
  const id = str(raw);
  if (!id) return null;
  const req = db.prepare('SELECT project_id FROM prd_requirements WHERE id = ?').get(id) as { project_id: string } | undefined;
  if (!req) throw new Error(`关联的需求不存在：${id}`);
  if (projectId && req.project_id !== projectId) throw new Error('仅可关联同项目的需求');
  return id;
}

/** 一次取回多个用例的步骤并按 case_id 分桶（§11：禁 N+1），桶内保持 step_no 升序 */
function stepsByCase(db: ReturnType<typeof getDb>, ids: readonly string[]): Map<string, CaseStepRow[]> {
  const map = new Map<string, CaseStepRow[]>();
  if (ids.length === 0) return map;
  const rows = db
    .prepare(`SELECT * FROM case_steps WHERE case_id IN (${inHolders(ids.length)}) ORDER BY step_no, created_at`)
    .all(...ids) as CaseStepRow[];
  for (const s of rows) {
    const bucket = map.get(s.case_id);
    if (bucket) bucket.push(s);
    else map.set(s.case_id, [s]); // 幂等分桶：同 case_id 首行建桶，后续只 push
  }
  return map;
}

/** 联表行 → 返回体：DB 的字符串列收窄为枚举类型（历史脏数据回落默认值，不整行报错） */
function withSteps(row: JoinedCase, steps: CaseStepRow[]): TestCaseWithSteps {
  return {
    ...row,
    priority: enumVal(row.priority, CASE_PRIORITY, CASE_DEFAULTS.priority),
    type: enumVal(row.type, CASE_TYPE, CASE_DEFAULTS.type),
    method: enumVal(row.method, CASE_METHOD, CASE_DEFAULTS.method),
    status: enumVal(row.status, CASE_STATUS, CASE_DEFAULTS.status),
    last_result: enumVal(row.last_result, CASE_RESULT, CASE_DEFAULTS.lastResult),
    steps,
  };
}

function loadCase(db: ReturnType<typeof getDb>, id: string): TestCaseWithSteps {
  const row = db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id) as JoinedCase | undefined;
  if (!row) throw new Error('用例不存在');
  return withSteps(row, stepsByCase(db, [id]).get(id) ?? []);
}

/** 项目内当前最大步骤序号的下一个值（新建用例默认排到末尾，与 `createRequirement` 同口径） */
function nextSortOrder(db: ReturnType<typeof getDb>, projectId: string): number {
  const r = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM test_cases WHERE project_id = ?').get(projectId) as { m: number };
  return r.m + 1;
}

/**
 * 用例编号：`TC-001` 起按项目内递增（§5.1）。
 * 扫描现有 `case_no` 取最大序号而非 COUNT+1——删除中间用例后 COUNT 会回退并撞唯一索引。
 */
function maxCaseNoSeq(db: ReturnType<typeof getDb>, projectId: string): number {
  const rows = db.prepare('SELECT case_no FROM test_cases WHERE project_id = ?').all(projectId) as Array<{ case_no: string }>;
  let max = 0;
  for (const r of rows) {
    const m = /^TC-(\d+)$/.exec(r.case_no ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function caseNoOf(seq: number): string {
  return `TC-${String(seq).padStart(3, '0')}`;
}

/** 唯一索引撞车（手工改重号 / 并发插入）→ 人话文案；其它错误原样抛出 */
function runGuardingUnique(write: () => void, caseNo: string): void {
  try {
    write();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed.*case_no/.test(msg)) throw new Error(`用例编号已存在：${caseNo}`);
    throw e;
  }
}

function insertSteps(db: ReturnType<typeof getDb>, caseId: string, steps: readonly CaseStepInput[], t: string): void {
  if (steps.length === 0) return;
  const ins = db.prepare(
    `INSERT INTO case_steps (id, case_id, step_no, action, expected, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  steps.forEach((s, i) => {
    const no = s.stepNo === undefined || !Number.isFinite(Number(s.stepNo)) ? i + 1 : Math.trunc(Number(s.stepNo));
    ins.run(uuid(), caseId, no, str(s.action), str(s.expected), t, t);
  });
}

/** 批量入参校验：去空白去重、必须全部存在、且属于同一项目（跨项目混选基本是选中态串了） */
function resolveCaseIds(db: ReturnType<typeof getDb>, ids: readonly string[]): { ids: string[]; projectId: string } {
  const uniq = [...new Set(ids.map((x) => str(x)).filter(Boolean))];
  if (uniq.length === 0) throw new Error('未选择用例');
  const rows = db
    .prepare(`SELECT id, project_id FROM test_cases WHERE id IN (${inHolders(uniq.length)})`)
    .all(...uniq) as Array<{ id: string; project_id: string }>;
  if (rows.length !== uniq.length) throw new Error('部分用例不存在（可能已被删除）');
  const projects = new Set(rows.map((r) => r.project_id));
  if (projects.size > 1) throw new Error('批量操作仅限同一项目');
  return { ids: uniq, projectId: String(rows[0].project_id) };
}

/** update() 文本列片段：省略=不改；title 空值=报错（其余列允许 '' 清空） */
function addCaseTextAssignments(patch: CasePatch, add: (col: string, v: unknown) => void): void {
  for (const [key, col] of CASE_TEXT_FIELDS) {
    const raw = patch[key];
    if (raw === undefined) continue;
    const v = str(raw);
    if (col === 'title' && !v) throw new Error('用例标题不能为空');
    add(col, v);
  }
}

/** update() 枚举/外键/数值列片段：脏枚举回落默认，与 `create` 同口径 */
function addCaseColumnAssignments(
  db: ReturnType<typeof getDb>,
  patch: CasePatch,
  projectId: string,
  add: (col: string, v: unknown) => void,
): void {
  if (patch.reqId !== undefined) add('req_id', resolveReqId(db, patch.reqId, projectId));
  if (patch.priority !== undefined) add('priority', enumVal(patch.priority, CASE_PRIORITY, CASE_DEFAULTS.priority));
  if (patch.type !== undefined) add('type', enumVal(patch.type, CASE_TYPE, CASE_DEFAULTS.type));
  if (patch.method !== undefined) add('method', enumVal(patch.method, CASE_METHOD, CASE_DEFAULTS.method));
  if (patch.status !== undefined) add('status', enumVal(patch.status, CASE_STATUS, CASE_DEFAULTS.status));
  if (patch.lastResult !== undefined) add('last_result', enumVal(patch.lastResult, CASE_RESULT, CASE_DEFAULTS.lastResult));
  if (patch.sortOrder !== undefined && Number.isFinite(Number(patch.sortOrder))) add('sort_order', Math.trunc(Number(patch.sortOrder)));
  if (patch.sourceKey !== undefined) add('source_key', str(patch.sourceKey));
  if (patch.sourceHash !== undefined) add('source_hash', str(patch.sourceHash));
}

/** 列表 WHERE 构造（供计数与取页共用，保证 total 与 items 同一套条件） */
function buildCaseWhere(q: CaseQuery): { where: string; vals: unknown[] } {
  const parts: string[] = ['c.project_id = ?'];
  const vals: unknown[] = [q.projectId];
  if (q.orphanOnly) parts.push('c.req_id IS NULL');
  const rid = str(q.reqId);
  if (rid) {
    parts.push('c.req_id = ?');
    vals.push(rid);
  }
  const mod = str(q.module);
  if (mod) {
    parts.push('c.module = ?');
    vals.push(mod);
  }
  const eq: Array<[string | undefined, string]> = [
    [filterEnum(q.priority, CASE_PRIORITY, '优先级'), 'c.priority = ?'],
    [filterEnum(q.type, CASE_TYPE, '类型'), 'c.type = ?'],
    [filterEnum(q.status, CASE_STATUS, '状态'), 'c.status = ?'],
    [filterEnum(q.result, CASE_RESULT, '执行结果'), 'c.last_result = ?'],
  ];
  for (const [v, sql] of eq) {
    if (v) {
      parts.push(sql);
      vals.push(v);
    }
  }
  const kw = str(q.q);
  if (kw) {
    // 转义 LIKE 通配符（%/_），让关键词按字面匹配（对齐 TaskService:216）
    const like = `%${kw.replaceAll(/[%_]/g, (m) => '\\' + m)}%`;
    parts.push(String.raw`(c.case_no LIKE ? ESCAPE '\' OR c.title LIKE ? ESCAPE '\' OR c.module LIKE ? ESCAPE '\' OR c.tags LIKE ? ESCAPE '\')`);
    vals.push(like, like, like, like);
  }
  return { where: parts.join(' AND '), vals };
}

/** 覆盖度聚合（§6.2：一次 GROUP BY，禁 N+1） */
function coverageRows(db: ReturnType<typeof getDb>, projectId: string) {
  const reqs = db
    .prepare('SELECT id, req_no, title FROM prd_requirements WHERE project_id = ? ORDER BY sort_order, created_at')
    .all(projectId) as Array<{ id: string; req_no: string | null; title: string | null }>;
  const counts = db
    .prepare('SELECT req_id, COUNT(*) AS c FROM test_cases WHERE project_id = ? AND req_id IS NOT NULL GROUP BY req_id')
    .all(projectId) as Array<{ req_id: string; c: number }>;
  const byId = new Map(counts.map((r) => [String(r.req_id), r.c]));
  // byReq 保留 caseCount=0 的需求行：§7.2「仅显示未覆盖的需求」靠它取候选，
  // 只返回有用例的需求会让该筛选永远算不出结果
  const byReq = reqs.map((r) => ({
    reqId: String(r.id),
    reqNo: r.req_no ?? '',
    title: r.title ?? '',
    caseCount: byId.get(String(r.id)) ?? 0,
  }));
  const total = byReq.length;
  const covered = byReq.filter((r) => r.caseCount > 0).length;
  // 用例数单独取：`total` 是需求数（覆盖率分母），被 `covered/total` 这类「x/N 需求已覆盖」
  // 的既有口径共用；把它当「测试用例 N 条」用会让零用例项目的占位分支永不触发（T02969）。
  const caseTotal = (db
    .prepare('SELECT COUNT(*) AS c FROM test_cases WHERE project_id = ?')
    .get(projectId) as { c: number }).c;
  return {
    total,
    caseTotal,
    covered,
    uncovered: total - covered,
    rate: total === 0 ? 0 : Math.round((covered / total) * 1000) / 10,
    byReq,
  };
}

export const TestCaseService = {
  /**
   * `GET /api/plans/test-cases/meta` 数据源（§6.1）：枚举 + 中文标签单源下发，
   * 外加项目内已有模块名（§7.3 列 3 的 `datalist` 提示），前端 select 不再各自硬编码。
   */
  meta(projectId: string): ReturnType<typeof caseEnumMeta> & { modules: string[] } {
    const db = getDb();
    const modules = db
      .prepare("SELECT DISTINCT module FROM test_cases WHERE project_id = ? AND module != '' ORDER BY module")
      .all(projectId) as Array<{ module: string }>;
    return { ...caseEnumMeta(), modules: modules.map((m) => m.module) };
  },

  /** 工具条统计文案（§7.2 第一行「共 N 条 · 已关联需求 M 条 · 孤儿 K 条」） */
  stats(projectId: string): { total: number; linked: number; orphan: number } {
    const r = getDb()
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN req_id IS NULL THEN 0 ELSE 1 END) AS linked,
                SUM(CASE WHEN req_id IS NULL THEN 1 ELSE 0 END) AS orphan
         FROM test_cases WHERE project_id = ?`,
      )
      .get(projectId) as { total: number; linked: number | null; orphan: number | null };
    return { total: r.total ?? 0, linked: r.linked ?? 0, orphan: r.orphan ?? 0 };
  },

  /** 列表：过滤 + 分页全在服务端，步骤一次取全（§6.2/§11） */
  list(q: CaseQuery): { total: number; items: TestCaseWithSteps[] } {
    const db = getDb();
    if (!str(q.projectId)) throw new Error('projectId 必填');
    const { where, vals } = buildCaseWhere(q);
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM test_cases c WHERE ${where}`).get(...vals) as { c: number }).c;
    const raw = q.limit === undefined ? DEFAULT_PAGE_SIZE : Math.trunc(Number(q.limit));
    const size = !Number.isFinite(raw) || raw <= 0 ? MAX_PAGE_SIZE : Math.min(raw, MAX_PAGE_SIZE);
    const offset = Math.max(0, Number.isFinite(Number(q.offset)) ? Math.trunc(Number(q.offset)) : 0);
    const rows = db
      .prepare(`${CASE_SELECT} WHERE ${where} ORDER BY c.sort_order, c.created_at LIMIT ? OFFSET ?`)
      .all(...vals, size, offset) as JoinedCase[];
    const byCase = stepsByCase(db, rows.map((r) => r.id));
    return { total, items: rows.map((r) => withSteps(r, byCase.get(r.id) ?? [])) };
  },

  get(id: string): TestCaseWithSteps {
    return loadCase(getDb(), id);
  },

  /**
   * T01487：按显式选择集取数（导出用）。与 `list` 同构地一次取回全部步骤，
   * 不得逐条 `get(id)`——§11 明令禁 N+1，导出选中上百条时那就是上百次查询。
   * 不存 id 一律拒（而不是静默少返几行）：选择集跨会话残留时，静默少行会让用户
   * 以为「导出件就这么点」，永远发现不了丢数据。
   */
  byIds(ids: readonly string[]): TestCaseWithSteps[] {
    const db = getDb();
    const target = resolveCaseIds(db, ids);
    const rows = db
      .prepare(`${CASE_SELECT} WHERE c.id IN (${inHolders(target.ids.length)}) ORDER BY c.sort_order, c.created_at`)
      .all(...target.ids) as JoinedCase[];
    const byCase = stepsByCase(db, rows.map((r) => r.id));
    return rows.map((r) => withSteps(r, byCase.get(r.id) ?? []));
  },

  /** 新建用例（含步骤）。未传 `caseNo` 时按项目内 `TC-xxx` 自动编号（§6.2） */
  create(input: CaseInput): TestCaseWithSteps {
    const db = getDb();
    requireProject(db, input.projectId);
    const title = str(input.title);
    if (!title) throw new Error('用例标题不能为空');
    const reqId = resolveReqId(db, input.reqId, input.projectId);
    const caseNo = str(input.caseNo) || caseNoOf(maxCaseNoSeq(db, input.projectId) + 1);
    const sortOrder = input.sortOrder !== undefined && Number.isFinite(Number(input.sortOrder))
      ? Math.trunc(Number(input.sortOrder))
      : nextSortOrder(db, input.projectId);
    const t = now();
    const id = uuid();
    db.transaction(() => {
      runGuardingUnique(() => {
        db.prepare(
          `INSERT INTO test_cases (id, project_id, req_id, case_no, module, title, preconditions, expected,
             test_data, postconditions, priority, type, method, status, last_result, tags,
             source_key, source_hash, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, input.projectId, reqId, caseNo, str(input.module), title,
          str(input.preconditions), str(input.expected), str(input.testData), str(input.postconditions),
          enumVal(input.priority, CASE_PRIORITY, CASE_DEFAULTS.priority),
          enumVal(input.type, CASE_TYPE, CASE_DEFAULTS.type),
          enumVal(input.method, CASE_METHOD, CASE_DEFAULTS.method),
          enumVal(input.status, CASE_STATUS, CASE_DEFAULTS.status),
          enumVal(input.lastResult, CASE_RESULT, CASE_DEFAULTS.lastResult),
          str(input.tags), str(input.sourceKey), str(input.sourceHash), sortOrder, t, t,
        );
      }, caseNo);
      insertSteps(db, id, input.steps ?? [], t);
    })();
    notifyChange('plans');
    return loadCase(db, id);
  },

  /**
   * 更新用例（§6.2 PATCH）。步骤按「随用例整体提交」实现（§7.4 推荐项）：
   * 传 `steps` 即整表重写，不传则保持原步骤不动——少一套 steps 子端点，前端也不用维护增量 diff。
   */
  update(id: string, patch: CasePatch): TestCaseWithSteps {
    const db = getDb();
    const cur = db.prepare('SELECT project_id FROM test_cases WHERE id = ?').get(id) as { project_id: string } | undefined;
    if (!cur) throw new Error('用例不存在');
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown): void => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    addCaseTextAssignments(patch, add);
    addCaseColumnAssignments(db, patch, cur.project_id, add);
    if (sets.length > 0) add('updated_at', now());
    const caseNo = patch.caseNo === undefined ? '' : str(patch.caseNo);
    db.transaction(() => {
      if (sets.length > 0) {
        runGuardingUnique(() => db.prepare(`UPDATE test_cases SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id), caseNo);
      }
      if (patch.steps !== undefined) {
        db.prepare('DELETE FROM case_steps WHERE case_id = ?').run(id);
        insertSteps(db, id, patch.steps, now());
      }
    })();
    notifyChange('plans');
    return loadCase(db, id);
  },

  /** 删除用例：步骤同事务显式删除（不依赖 pragma 是否开着，§11 数据一致） */
  remove(id: string): { ok: true } {
    const db = getDb();
    if (!db.prepare('SELECT id FROM test_cases WHERE id = ?').get(id)) throw new Error('用例不存在');
    db.transaction(() => {
      db.prepare('DELETE FROM case_steps WHERE case_id = ?').run(id);
      db.prepare('DELETE FROM test_cases WHERE id = ?').run(id);
    })();
    notifyChange('plans');
    return { ok: true };
  },

  /** 批量改字段（§6.3）：一次事务一条 UPDATE；不含 title/case_no，见 `CaseBatchPatch` */
  batchPatch(ids: readonly string[], patch: CaseBatchPatch): { updated: number } {
    const db = getDb();
    const target = resolveCaseIds(db, ids);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown): void => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.module !== undefined) add('module', str(patch.module));
    if (patch.reqId !== undefined) add('req_id', resolveReqId(db, patch.reqId, target.projectId));
    if (patch.priority !== undefined) add('priority', enumVal(patch.priority, CASE_PRIORITY, CASE_DEFAULTS.priority));
    if (patch.type !== undefined) add('type', enumVal(patch.type, CASE_TYPE, CASE_DEFAULTS.type));
    if (patch.method !== undefined) add('method', enumVal(patch.method, CASE_METHOD, CASE_DEFAULTS.method));
    if (patch.status !== undefined) add('status', enumVal(patch.status, CASE_STATUS, CASE_DEFAULTS.status));
    if (patch.lastResult !== undefined) add('last_result', enumVal(patch.lastResult, CASE_RESULT, CASE_DEFAULTS.lastResult));
    if (sets.length === 0) return { updated: target.ids.length }; // 空 patch 不动库，也不制造 updated_at 抖动
    add('updated_at', now());
    db.transaction(() => {
      db.prepare(`UPDATE test_cases SET ${sets.join(', ')} WHERE id IN (${inHolders(target.ids.length)})`).run(...vals, ...target.ids);
    })();
    notifyChange('plans');
    return { updated: target.ids.length };
  },

  /** 批量删除：步骤与用例同事务，一条 IN 收口（§6.3） */
  batchRemove(ids: readonly string[]): { deleted: number } {
    const db = getDb();
    const target = resolveCaseIds(db, ids);
    db.transaction(() => {
      db.prepare(`DELETE FROM case_steps WHERE case_id IN (${inHolders(target.ids.length)})`).run(...target.ids);
      db.prepare(`DELETE FROM test_cases WHERE id IN (${inHolders(target.ids.length)})`).run(...target.ids);
    })();
    notifyChange('plans');
    return { deleted: target.ids.length };
  },

  /**
   * 复制用例（§6.3）：编号重排、步骤连带复制，整批一个事务。
   * 副本 `status=draft` / `last_result=untested`：复制的是用例资产，不是执行结论（准则 P1）；
   * `source_key/source_hash` 清空：幂等去重键不随复制传播，否则重跑同一份 PRD 会命中副本、
   * 把真新增的用例静默跳过（准则 P6）。
   */
  duplicate(ids: readonly string[]): { ids: string[] } {
    const db = getDb();
    const target = resolveCaseIds(db, ids);
    const srcs = db
      .prepare(`SELECT * FROM test_cases WHERE id IN (${inHolders(target.ids.length)}) ORDER BY sort_order, case_no`)
      .all(...target.ids) as TestCaseRow[];
    const stepMap = stepsByCase(db, target.ids);
    const t = now();
    const baseOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM test_cases WHERE project_id = ?').get(target.projectId) as { m: number }).m;
    let seq = maxCaseNoSeq(db, target.projectId);
    const created: string[] = [];
    db.transaction(() => {
      srcs.forEach((s, i) => {
        seq += 1;
        const id = uuid();
        db.prepare(
          `INSERT INTO test_cases (id, project_id, req_id, case_no, module, title, preconditions, expected,
             test_data, postconditions, priority, type, method, status, last_result, tags,
             source_key, source_hash, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)`,
        ).run(
          id, s.project_id, s.req_id, caseNoOf(seq), s.module, s.title, s.preconditions, s.expected,
          s.test_data, s.postconditions, s.priority, s.type, s.method,
          CASE_DEFAULTS.status, CASE_DEFAULTS.lastResult, s.tags,
          baseOrder + i + 1, t, t,
        );
        insertSteps(
          db,
          id,
          (stepMap.get(s.id) ?? []).map((st) => ({ action: st.action, expected: st.expected, stepNo: st.step_no })),
          t,
        );
        created.push(id);
      });
    })();
    notifyChange('plans');
    return { ids: created };
  },

  /**
   * 拖拽排序（§6.3）：`ids` 为本步拖动后「筛选范围内被挪动的行」的新顺序（可以只是当前页的子集）。
   * `reqId` 为筛选范围：undefined=全项目、null=仅孤儿用例、字符串=仅该需求。
   * 做法是「把 `ids` 依次回填到原范围中这些行原本占据的位置」，未选中行按原序占位，
   * 最后整范围重写 0..n-1——只改被拖动那几行的话，同范围会出现重复 sort_order，翻页顺序就乱了。
   */
  reorder(projectId: string, ids: readonly string[], reqId?: string | null): { reordered: number } {
    const db = getDb();
    requireProject(db, projectId);
    const conds: string[] = ['project_id = ?'];
    const scopeVals: unknown[] = [projectId];
    if (reqId === null) conds.push('req_id IS NULL');
    else if (str(reqId)) {
      conds.push('req_id = ?');
      scopeVals.push(resolveReqId(db, reqId, projectId));
    }
    const scoped = (db
      .prepare(`SELECT id FROM test_cases WHERE ${conds.join(' AND ')} ORDER BY sort_order, created_at`)
      .all(...scopeVals) as Array<{ id: string }>).map((r) => String(r.id));
    const wanted = [...new Set(ids.map((x) => str(x)).filter(Boolean))];
    if (wanted.length === 0) throw new Error('未选择用例');
    const inScope = new Set(scoped);
    if (!wanted.every((id) => inScope.has(id))) throw new Error('存在不属于当前排序范围的用例（请刷新后重试）');
    const moved = new Set(wanted);
    const queue = [...wanted];
    const merged = scoped.map((id) => (moved.has(id) ? (queue.shift() as string) : id));
    const t = now();
    db.transaction(() => {
      const upd = db.prepare('UPDATE test_cases SET sort_order = ?, updated_at = ? WHERE id = ?');
      merged.forEach((id, i) => upd.run(i, t, id));
    })();
    notifyChange('plans');
    return { reordered: merged.length };
  },

  /** 覆盖度（§6.2）：一次 GROUP BY，`byReq` 含 0 用例需求行（供「未覆盖」筛选与矩阵列 chip） */
  coverage(projectId: string): ReturnType<typeof coverageRows> {
    const db = getDb();
    if (!str(projectId)) throw new Error('projectId 必填');
    return coverageRows(db, projectId);
  },

  /**
   * T01492（§8.5）：草稿确认导入——单个 `db.transaction()` 收口（对齐 WBS 导入的 reqNo→id 映射范式）。
   *
   * 口径要点：
   *  - **幂等**：逐条按单源 `caseSourceKey(reqNo,title)` 重算去重键，命中库内已有 `source_key` 即跳过（重复导入同 PRD 不产生重复用例，§2.2 P6）；
   *  - **不信任客户端 source_key**：一律服务端按（可能被就地编辑过的）标题重算，与 `TestCaseGenService` 生成期逐字同源；
   *  - **只处理勾选行**：`include===false` 或标题为空的草稿行不入库；
   *  - **需求映射**：`writeRequirements` 时把矩阵中尚不存在的新拆分需求写入并回填 reqNo→id；否则新需求下的用例落孤儿（req_id=NULL）。
   */
  importDraft(input: DraftImportInput): { imported: number; skipped: number; requirementsCreated: number } {
    const db = getDb();
    requireProject(db, input.projectId);
    const wanted = (Array.isArray(input.cases) ? input.cases : []).filter((c) => c && c.include !== false && str(c.title));

    // 已有需求 req_no → id（同 WBS 导入：先建映射，用例落库时按 reqNo 挂需求）
    // T01867 复验修正：键用编号同一性（REQ-01 与 REQ-001 视为同一个号），
    // 否则草稿里的 REQ-001 会绕开已有 REQ-01 另建一行，矩阵里两种写法并存、按号定位再次不确定。
    const reqNoToId = new Map<string, string>();
    for (const r of db.prepare('SELECT id, req_no FROM prd_requirements WHERE project_id = ? ORDER BY sort_order').all(input.projectId) as Array<{ id: string; req_no: string | null }>) {
      if (!r.req_no) continue;
      const key = reqNoKey(String(r.req_no));
      if (!reqNoToId.has(key)) reqNoToId.set(key, String(r.id)); // 存量混写同号时取矩阵靠前的原行，避免命中随遍历顺序漂移
    }
    // 已入库 source_key 集合：与 `TestCaseGenService` 生成期完全同一条 SQL，判重口径不错位
    const existingKeys = new Set(
      (db.prepare("SELECT source_key FROM test_cases WHERE project_id = ? AND source_key <> ''").all(input.projectId) as Array<{ source_key: string }>).map((r) => r.source_key),
    );

    const t = now();
    let seq = maxCaseNoSeq(db, input.projectId);
    let order = nextSortOrder(db, input.projectId);
    let reqOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prd_requirements WHERE project_id = ?').get(input.projectId) as { m: number }).m;
    let created = 0;
    let imported = 0;
    let skipped = 0;

    const insReq = db.prepare(
      `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
    );
    const insCase = db.prepare(
      `INSERT INTO test_cases (id, project_id, req_id, case_no, module, title, preconditions, expected,
         test_data, postconditions, priority, type, method, status, last_result, tags,
         source_key, source_hash, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // 事务体的两段写入抽为局部闭包（计数器等经外层 let 闭包共享，行为逐字不变）
    const writeNewRequirements = (): void => {
      for (const rq of (Array.isArray(input.requirements) ? input.requirements : [])) {
        const no = str(rq.reqNo);
        const title = str(rq.title);
        if (!no || !title) continue;
        if (reqNoToId.has(reqNoKey(no))) continue; // 矩阵已有同编号（含 REQ-01/REQ-001 混写）：复用不重复建（幂等）
        reqOrder += 1;
        const id = uuid();
        insReq.run(id, input.projectId, no, title, str(rq.content), str(rq.sourceRef), str(rq.priority) || 'normal', reqOrder, t, t);
        reqNoToId.set(reqNoKey(no), id);
        created += 1;
      }
    };
    const importCaseRow = (c: DraftCaseImport): void => {
      const reqNo = str(c.reqNo);
      const title = str(c.title);
      const sourceKey = caseSourceKey(reqNo, title);
      if (existingKeys.has(sourceKey)) { skipped += 1; return; } // 幂等跳过：同去重键已入库
      seq += 1;
      order += 1;
      const caseId = uuid();
      const sourceHash = caseContentHash({
        reqNo, module: str(c.module), preconditions: str(c.preconditions), expected: str(c.expected), testData: str(c.testData),
        steps: (Array.isArray(c.steps) ? c.steps : []).map((s) => ({ action: str(s.action), expected: str(s.expected) })),
      });
      insCase.run(
        caseId, input.projectId, reqNoToId.get(reqNoKey(reqNo)) ?? null, caseNoOf(seq), str(c.module), title,
        str(c.preconditions), str(c.expected), str(c.testData), str(c.postconditions),
        enumVal(c.priority, CASE_PRIORITY, CASE_DEFAULTS.priority),
        enumVal(c.type, CASE_TYPE, CASE_DEFAULTS.type),
        enumVal(c.method, CASE_METHOD, CASE_DEFAULTS.method),
        CASE_DEFAULTS.status,
        CASE_DEFAULTS.lastResult, str(c.tags),
        sourceKey, sourceHash, order, t, t,
      );
      insertSteps(db, caseId, Array.isArray(c.steps) ? c.steps : [], t);
      existingKeys.add(sourceKey); // 同批内也防重（同 source_key 两次只入一条）
      imported += 1;
    };

    db.transaction(() => {
      if (input.writeRequirements) writeNewRequirements();
      for (const c of wanted) importCaseRow(c);
    })();

    if (imported > 0 || created > 0) notifyChange('plans');
    return { imported, skipped, requirementsCreated: created };
  },
};
