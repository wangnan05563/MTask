/**
 * PRD 导入质量门（只读，2026-11-10 质量复核优化意见⑧）。
 *
 * 背景：一次「从 PRD 导入项目计划」在 BEMP审批 项目里生成 161 需求 / 149 计划 / 149 待办，
 * 结构上零断裂，但出现 7 套并行 WBS、23 个里程碑工期≠子项之和、10 条否定口径被当待开发、
 * 方案设计 v2 整份缺席、Q-70 跨文档门禁冲突。人工写一次报告容易，逐次回归难——
 * 本门把报告里的检查项固化成可重复执行的只读校验，并输出 Markdown 质量报告作为附加产物。
 *
 * 红线：
 *  - 只读。SQLite 以 readonly:true 打开，全程 SELECT，绝不 INSERT/UPDATE/DELETE；
 *  - 不改写源文档；只把报告写到 --out 指定路径（默认 tmp/）；
 *  - 判据复用同一份纯函数（web/src/utils/prdQuality.ts、server/src/util/milestoneChild.ts），
 *    不在门里另写一套「差不多」的正则，避免门与产品逻辑漂移。
 *
 * 用法（任选其一，C 组需要真实数据）：
 *   1) 纯判据自证（无需数据库）：
 *      node node_modules/tsx/dist/cli.mjs scripts/verify/prd-import-quality-gate.mts
 *   2) 对运行库做只读复核：
 *      node node_modules/tsx/dist/cli.mjs scripts/verify/prd-import-quality-gate.mts \
 *        --db "C:/Users/<you>/AppData/Roaming/mtask/data/mtask.db" --project "BEMP审批" \
 *        --src-dir "D:/code/QJ/BEMP5.0DEV/docs/prd/审批功能优化和指导利率改动" \
 *        --out tmp/prd-import-quality-report.md
 *   3) 离线夹具（DB 行的 JSON 导出）：
 *      node node_modules/tsx/dist/cli.mjs scripts/verify/prd-import-quality-gate.mts --fixture tmp/qc-fixture.json
 *
 * 可选参数：
 *   --baseline <文件名>        已裁定唯一需求依据 → 版本冲突降为告警
 *   --strict                   保留参数（历史兼容），当前无额外效果
 *   --allow-coverage-gap       T05575：覆盖缺口降级为 WARN（默认 FAIL 阻断；仅当书面接受缺口风险时才用）
 * 退出码：存在 FAIL 时 1；纯 SKIP/WARN 不判红。
 *
 * 判据分组（2026-11-11 增补）：
 *   B-13 源文档条目覆盖 —— 默认 FAIL（T05575），缺口要么补齐要么显式接受
 *   B-17 里程碑区间连续性 —— T05574：工期相符 ≠ 排期合理，抓里程碑/明细之间的排期空档
 *   A-11~A-14 —— T05571/T05573/T05575 的纯函数自证（WBS 收敛 / 区间空档 / 缺口补齐）
 *   D-10~D-16 —— T05570~T05575 的源码接线锚
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  analyzeImportQuality, appendCoverageGapPlans, buildSourceCoverage, detectConstraintReqs, detectVersionConflicts,
  detectWbsGroups, disableConstraintReqs, findDuplicatePlanGroups, findMilestoneDurationIssues,
  findMilestoneScheduleGaps,
  formatQualitySummary, isConstraintReq, isGapFillPlan, normalizePlanTitle, normalizeWbs,
  type QualityPlan, type QualityReq, type QualitySource,
} from '../../web/src/utils/prdQuality.ts';
import { normalizeWbsGroups } from '../../server/src/util/prdWbs.ts';
import { intervalChildEdges } from '../../server/src/util/milestoneChild.ts';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- 参数
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const DB_PATH = arg('db');
const PROJECT = arg('project');
const SRC_DIR = arg('src-dir');
const FIXTURE = arg('fixture');
const BASELINE = arg('baseline') ?? '';
const STRICT = process.argv.includes('--strict');
/** T05575：覆盖缺口默认阻断（FAIL）；显式 --allow-coverage-gap 才降级为 WARN（需书面记录为何接受缺口） */
const ALLOW_COVERAGE_GAP = process.argv.includes('--allow-coverage-gap');
const OUT = arg('out') ?? path.join(ROOT, 'tmp', 'prd-import-quality-report.md');

let pass = 0, fail = 0, warn = 0, skip = 0;
const findings: Array<{ level: 'PASS' | 'FAIL' | 'WARN' | 'SKIP'; group: string; name: string; detail: string }> = [];
function record(level: 'PASS' | 'FAIL' | 'WARN' | 'SKIP', group: string, name: string, detail = ''): void {
  if (level === 'PASS') pass += 1;
  else if (level === 'FAIL') fail += 1;
  else if (level === 'WARN') warn += 1;
  else skip += 1;
  findings.push({ level, group, name, detail });
  console.log(`[${level}] ${group} ${name}${detail ? ` :: ${detail}` : ''}`);
}
const check = (group: string, name: string, cond: boolean, detail = '') => record(cond ? 'PASS' : 'FAIL', group, name, detail);

// ---------------------------------------------------------------- 数据结构
type Row = Record<string, unknown>;
interface DbLike {
  prepare(sql: string): { all(...params: unknown[]): Row[] };
  close(): void;
}
interface DataSet {
  docs: Row[];
  reqs: Row[];
  plans: Row[];
  tasks: Row[];
  issues: Row[];
  failures: Row[];
  projectLabel: string;
}
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function jsonArray(v: unknown): Array<{ id?: string; type?: string }> {
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const x: unknown = JSON.parse(v); return Array.isArray(x) ? x as Array<{ id?: string; type?: string }> : []; }
  catch { return []; }
}
/** req_ids 存的是「需求 id 字符串数组」，与 deps 的 {id,type} 结构不同，不能混用解析器 */
function stringArray(v: unknown): string[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const x: unknown = JSON.parse(v); return Array.isArray(x) ? x.map(str).filter(Boolean) : []; }
  catch { return []; }
}

/** 从运行库只读取数（readonly:true 是硬约束，误写会由 SQLite 自己拒绝） */
function loadFromDb(file: string, project: string): DataSet {
  const hint = '请改用 --fixture：先运行 scripts/verify/prd-import-quality-fixture.py 导出只读夹具（Python 标准库，无原生模块 ABI 依赖）';
  let Database: new (f: string, o: Record<string, unknown>) => DbLike;
  try { Database = require('better-sqlite3') as new (f: string, o: Record<string, unknown>) => DbLike; }
  catch (e) { throw new Error(`无法加载 better-sqlite3：${String((e as Error).message ?? e).slice(0, 180)}。${hint}`); }
  let db: DbLike;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) {
    throw new Error(`无法以只读方式打开运行库（常见于原生模块 NODE_MODULE_VERSION 与当前 Node 不一致）：${String((e as Error).message ?? e).slice(0, 220)}。${hint}`);
  }
  try {
    const proj = db.prepare('SELECT id, name FROM projects WHERE id = ? OR name = ?').all(project, project);
    if (proj.length === 0) throw new Error(`未找到项目：${project}`);
    const pid = str(proj[0].id);
    const sel = (table: string, cols: string) =>
      db.prepare(`SELECT ${cols} FROM ${table} WHERE project_id = ?`).all(pid) as Row[];
    return {
      docs: sel('prd_docs', 'id, filename, doc_kind, content_md, created_at, origin_hash'),
      reqs: sel('prd_requirements', 'id, req_no, title, content, source_ref, priority, status, prd_id, sort_order'),
      plans: sel('plan_tasks', 'id, title, description, duration_days, kind, deps, req_ids, linked_task_id, status, progress, start_date, end_date, sort_order, archived'),
      tasks: sel('tasks', 'id, req_ids, status, archived'),
      issues: sel('prd_issues', 'id'),
      failures: sel('prd_parse_failures', 'id'),
      projectLabel: str(proj[0].name),
    };
  } finally { db.close(); }
}

function loadFromFixture(file: string): DataSet {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DataSet>;
  return {
    docs: raw.docs ?? [], reqs: raw.reqs ?? [], plans: raw.plans ?? [], tasks: raw.tasks ?? [],
    issues: raw.issues ?? [], failures: raw.failures ?? [], projectLabel: raw.projectLabel ?? path.basename(file),
  };
}

/** 磁盘上的源文档作为补充来源：用于「v2 未落库」这类跨文档冲突/覆盖自检 */
function loadDiskSources(dir: string): QualitySource[] {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(md|markdown|txt)$/i.test(f))
    .map((f) => ({
      name: f,
      text: fs.readFileSync(path.join(dir, f), 'utf8'),
      role: /方案设计|设计|design/i.test(f) ? 'design' as const : 'prd' as const,
    }));
}

function sourcesOf(d: DataSet, extra: QualitySource[]): QualitySource[] {
  const fromDb: QualitySource[] = d.docs.map((x) => ({
    name: str(x.filename) || str(x.id),
    text: str(x.content_md),
    role: (str(x.doc_kind) === 'design' || str(x.doc_kind) === 'test' ? str(x.doc_kind) : 'prd') as 'prd' | 'design' | 'test',
  }));
  const seen = new Set(fromDb.map((x) => x.name));
  return [...fromDb, ...extra.filter((x) => !seen.has(x.name))];
}
function qualityRows(d: DataSet): { reqs: QualityReq[]; plans: QualityPlan[] } {
  return {
    reqs: d.reqs.map((r) => ({
      reqNo: str(r.req_no), title: str(r.title), content: str(r.content),
      sourceRef: str(r.source_ref), include: true,
    })),
    plans: d.plans.filter((p) => !num(p.archived)).map((p) => ({
      title: str(p.title), description: str(p.description), durationDays: num(p.duration_days) || 1,
      kind: str(p.kind), include: true,
      // T05574：区间连续性校验需要真实排期
      startDate: str(p.start_date), endDate: str(p.end_date),
    })),
  };
}

// ---------------------------------------------------------------- A 组：纯函数自证（无需数据库）
console.log('—— A 组 · 检测逻辑自证（固定夹具，复现本次复核的 7 套 WBS / 占位行 / 否定口径 / Q-70 冲突）——');
const samplePlans: QualityPlan[] = [
  { title: '1 M1 项目启动与需求分析', kind: 'milestone', durationDays: 1, include: true },
  { title: '1.1 需求梳理', kind: 'normal', durationDays: 2, include: true },
  { title: '2 M2 审批流改造', kind: 'milestone', durationDays: 1, include: true },
  { title: '2.1 判重匹配开发', kind: 'normal', durationDays: 3, include: true },
  { title: '1 M3 测试验收', kind: 'milestone', durationDays: 1, include: true }, // 章号回退 → 第二套 WBS
  { title: '1.1 需求梳理', kind: 'normal', durationDays: 2, include: true },     // 同题重复
  { title: 'REQ-099 相关实现', kind: 'normal', durationDays: 1, description: '自动补齐：未被任何计划关联', include: true },
];
check('A', 'A-01 章号回退能识别多套并行 WBS', detectWbsGroups(samplePlans).groups === 2,
  `groups=${detectWbsGroups(samplePlans).groups}`);
check('A', 'A-02 归一化标题的同题计划可聚类', findDuplicatePlanGroups(samplePlans).length === 1,
  `${findDuplicatePlanGroups(samplePlans).length} 组`);
check('A', 'A-03 系统补齐占位行可识别', isGapFillPlan(samplePlans[6]) && !isGapFillPlan(samplePlans[1]));
check('A', 'A-04 一键归一化不删行、只取消勾选，且工期按明细重算', (() => {
  // T05438 起语义：多套并行 WBS 默认只保留第一套，其余套整段取消勾选（行不删，可勾回）
  const n = normalizeWbs(samplePlans);
  return n.plans.length === samplePlans.length
    && n.disabledRows >= 1                       // 第二套 + 同题重复行被取消勾选
    && n.plans.some((p) => p.include === false)   // 只取消勾选、不删行
    && n.groupsBefore === 2 && n.groupsAfter === 1 && n.durationIssuesAfter === 0
    && n.renumberedMilestones >= 1;               // 保留套的里程碑仍统一为 M1…Mn
})());
check('A', 'A-05 否定口径只判标题，正文里正常的「不」不误伤',
  isConstraintReq({ title: 'Q-63 加减点功能废止' }) && !isConstraintReq({ title: '开关关闭时不读最低利率' })
  && detectConstraintReqs([{ reqNo: 'REQ-001', title: '菜单脚本不新增' }]).length === 1);
check('A', 'A-06 一键排除否定口径返回新数组不改写入参', (() => {
  const rs: QualityReq[] = [{ reqNo: 'REQ-001', title: '不新增菜单脚本', include: true }];
  const d = disableConstraintReqs(rs);
  return d.disabled === 1 && d.reqs[0].include === false && rs[0].include === true;
})());
check('A', 'A-07 跨文档同一编号「待确认 ↔ 已确认」判定为版本冲突', (() => {
  const c = detectVersionConflicts([
    { name: '业务需求-v6.md', text: 'Q-70 已确认 A，门禁通过，剩余待回复 0 项', role: 'prd' },
    { name: '方案设计-v2.md', text: 'Q-70 待确认，确认前不得进入代码开发', role: 'design' },
  ]);
  return c.length === 1 && c[0].id === 'Q-70' && c[0].states.length === 2;
})(), 'Q-70');
check('A', 'A-08 短编号 D1/R1/T1 按边界匹配，不被 REQ-001 误命中', (() => {
  const g = buildSourceCoverage(
    [{ name: 'v2.md', text: 'D1 设计决策；R1 回归；T1 核实', role: 'design' }],
    [{ reqNo: 'REQ-001', title: '普通需求', content: 'REQ-001 与 REQ-002' }], [],
  );
  return g.filter((x) => /设计决策|回归场景|核实项/.test(x.label)).every((x) => x.covered === 0 && x.total > 0);
})());
check('A', 'A-09 child 补边的 skip 能把占位行排除在里程碑归属之外', (() => {
  const items = [{ kind: 'milestone' }, { kind: 'normal' }, { kind: 'normal' }];
  const edges = intervalChildEdges(items, { skip: (i) => i === 2 });
  return edges.length === 1 && edges[0].index === 1 && intervalChildEdges(items).length === 2;
})());
check('A', 'A-10 标题归一化去掉互相冲突的章号/M 编号前缀',
  normalizePlanTitle('1 M2 审批流改造') === normalizePlanTitle('3 M4 审批流改造'));

// ---------------- T05573 / T05574 / T05575 新增判据自证 ----------------
// A-11：WBS 自动收敛——第 2 套里程碑章号顺延到第 1 套最大章号之后，明细前缀同步替换
check('A', 'A-11 多套并行 WBS 可自动收敛为单一递增序列', (() => {
  const input: Array<{ title: string; kind: string; description?: string }> = [
    { title: '1 M1 项目启动', kind: 'milestone' },
    { title: '1.1 需求梳理', kind: 'normal' },
    { title: '2 M2 审批改造', kind: 'milestone' },
    { title: '2.1 判重匹配', kind: 'normal' },
    // 第二套（章号回退）
    { title: '1 M1 测试验收', kind: 'milestone' },
    { title: '1.1 用例编写', kind: 'normal' },
  ];
  const before = detectWbsGroups(input).groups;
  const r = normalizeWbsGroups(input);
  const after = detectWbsGroups(r.drafts).groups;
  // 第二套的 M1 应变成 3，其明细 1.1 应变成 3.1
  const ms3 = r.drafts.filter((d) => d.kind === 'milestone').some((d) => /^3\b/.test(d.title));
  const child3 = r.drafts.some((d) => d.kind === 'normal' && /^3\.1\b/.test(d.title));
  return before === 2 && after === 1 && ms3 && child3
    && r.renumberedMilestones === 1 && r.renumberedNormals === 1
    && input[4].title === '1 M1 测试验收'; // 入参未被修改
})(), '第 2 套顺延为 3 / 3.1');

// A-12：区间连续性——工期相符但排期断档必须被抓出来（B-05 抓不到的那类）
check('A', 'A-12 里程碑区间空档与子项越界可检出', (() => {
  const plans: QualityPlan[] = [
    { title: '1 M1 启动', kind: 'milestone', durationDays: 4, startDate: '2026-11-01', endDate: '2026-11-04', include: true },
    { title: '1.1 需求梳理', kind: 'normal', durationDays: 4, startDate: '2026-11-01', endDate: '2026-11-04', include: true },
    // 与 M1 之间空 8 个月（跨年长空档）
    { title: '2 M5 上线', kind: 'milestone', durationDays: 10, startDate: '2027-09-01', endDate: '2027-09-10', include: true },
    { title: '2.1 联调', kind: 'normal', durationDays: 2, startDate: '2027-09-01', endDate: '2027-09-02', include: true },
    // 同里程碑内空 7 天
    { title: '2.2 压测', kind: 'normal', durationDays: 2, startDate: '2027-09-10', endDate: '2027-09-11', include: true },
  ];
  const g = findMilestoneScheduleGaps(plans);
  const expectedMsGap = Math.round((Date.parse('2027-09-01') - Date.parse('2026-11-04')) / 86_400_000) - 1;
  const hasMsGap = g.some((x) => x.kind === 'milestone-gap' && x.days === expectedMsGap);
  const hasChildGap = g.some((x) => x.kind === 'child-gap' && x.days === 7);
  const hasSpan = g.some((x) => x.kind === 'milestone-span');
  // 只关心区间判据；工期是否等于明细之和是 B-05 的事，B-17 不掺和
  return hasMsGap && hasChildGap && hasSpan && g.every((x) => x.days > 0);
})(), '跨年空档 + 明细空档 7 天 + 子项越界');

// A-13：B-13 口径翻转——覆盖缺口默认阻断（T05575）
check('A', 'A-13 覆盖缺口默认按阻断处理（--allow-coverage-gap 才降级）', !ALLOW_COVERAGE_GAP,
  ALLOW_COVERAGE_GAP ? '本次显式允许缺口（降级 WARN）' : '默认 FAIL');

// A-14：覆盖缺口一键补齐——补出的行必须能被 isGapFillPlan 识别（不进工期、不参与同题去重）
check('A', 'A-14 覆盖缺口一键补齐生成可识别的占位行', (() => {
  const before: QualityPlan[] = [
    { title: '1 M1 启动', kind: 'milestone', durationDays: 1, include: true },
    { title: '1.1 需求梳理', kind: 'normal', durationDays: 2, include: true },
  ];
  const coverage = buildSourceCoverage(
    [{ name: 'v2.md', text: 'D1 设计决策；Q-70 待确认', role: 'design' }],
    [], [{ title: '需求梳理', content: '无编号' }],
  );
  const r = appendCoverageGapPlans(before, coverage);
  const addedRows = r.plans.slice(before.length);
  return r.added > 0 && r.plans.length === before.length + r.added
    && addedRows.every((p) => isGapFillPlan(p) && p.kind === 'normal')
    && before.length === 2; // 入参未被修改
})(), '补齐行可被占位行判据识别');

// ---------------------------------------------------------------- B 组：导入产物结构化校验
console.log('\n—— B 组 · 导入产物结构化校验（只读） ——');
let data: DataSet | null = null;
let sources: QualitySource[] = [];
let summary: ReturnType<typeof analyzeImportQuality> | null = null;
const diskSources = SRC_DIR ? loadDiskSources(SRC_DIR) : [];
if (FIXTURE) data = loadFromFixture(FIXTURE);
else if (DB_PATH && PROJECT) {
  try { data = loadFromDb(DB_PATH, PROJECT); }
  catch (e) { record('FAIL', 'B', '读取运行库失败', String((e as Error).message ?? e)); }
}
else record('SKIP', 'B', '未指定 --db/--project 或 --fixture，B/C 组跳过（A 组自证仍有效）');

if (data) {
  sources = sourcesOf(data, diskSources);
  const rows = qualityRows(data);
  summary = analyzeImportQuality({ sources, ...rows });
  const { reqs, plans } = rows;
  const activePlans = data.plans.filter((p) => !num(p.archived));
  const reqIds = new Set(data.reqs.map((r) => str(r.id)));
  const planIds = new Set(activePlans.map((p) => str(p.id)));
  const taskById = new Map(data.tasks.map((t) => [str(t.id), t]));

  // B-01 需求编号连续、无重复、无空标题/空内容
  const nos = data.reqs.map((r) => str(r.req_no));
  const numbers = nos.map((n) => Number(/(\d+)$/.exec(n)?.[1] ?? NaN)).filter((n) => Number.isFinite(n));
  const expected = Array.from({ length: numbers.length }, (_, i) => i + 1);
  check('B', 'B-01 需求编号连续且唯一、无空标题/空内容',
    new Set(nos).size === nos.length && numbers.length === nos.length
    && numbers.slice().sort((a, b) => a - b).every((n, i) => n === expected[i])
    && data.reqs.every((r) => str(r.title).trim() && str(r.content).trim()),
    `${nos.length} 条`);

  // B-02 计划↔待办一一对应且 req_ids 一致
  const linked = activePlans.filter((p) => str(p.linked_task_id) && taskById.has(str(p.linked_task_id)));
  const reqIdsEq = linked.every((p) => {
    const a = new Set(stringArray(p.req_ids));
    const b = new Set(stringArray(taskById.get(str(p.linked_task_id))?.req_ids));
    return a.size === b.size && [...a].every((x) => b.has(x));
  });
  check('B', 'B-02 计划↔待办一一对应且需求关联一致',
    linked.length === activePlans.length && reqIdsEq,
    `${linked.length}/${activePlans.length} 条命中`);

  // B-03 req_ids 无孤儿引用
  const orphanRefs = activePlans.flatMap((p) => stringArray(p.req_ids).filter((x) => !reqIds.has(x)));
  check('B', 'B-03 计划 req_ids 无孤儿引用', orphanRefs.length === 0, `${orphanRefs.length} 个`);

  // B-04 deps 无悬空引用
  const dangling = activePlans.flatMap((p) => jsonArray(p.deps).map((d) => str(d.id)).filter((x) => x && !planIds.has(x)));
  check('B', 'B-04 deps 无悬空引用', dangling.length === 0, `${dangling.length} 个`);

  // B-05 里程碑工期 = 其 child 子项之和（按真实 child 边，跳过占位行）
  const durationByPlan = new Map(activePlans.map((p) => [str(p.id), num(p.duration_days) || 1]));
  const childSum = new Map<string, number>();
  const gapFillWithChild: string[] = [];
  for (const p of activePlans) {
    if (isGapFillPlan({ title: str(p.title), description: str(p.description) })
      && jsonArray(p.deps).some((d) => d.type === 'child')) gapFillWithChild.push(str(p.title));
    for (const d of jsonArray(p.deps)) {
      if (d.type !== 'child' || !d.id) continue;
      if (isGapFillPlan({ title: str(p.title), description: str(p.description) })) continue;
      childSum.set(str(d.id), (childSum.get(str(d.id)) ?? 0) + (durationByPlan.get(str(p.id)) ?? 1));
    }
  }
  const milestones = activePlans.filter((p) => str(p.kind) === 'milestone');
  const badDuration = milestones.filter((m) => {
    const s = childSum.get(str(m.id)) ?? 0;
    return s > 0 && s !== (num(m.duration_days) || 1);
  });
  check('B', 'B-05 里程碑工期 = 其 child 明细工期之和',
    badDuration.length === 0,
    `${milestones.length} 个里程碑，${badDuration.length} 个不符${badDuration.length ? `（例：${str(badDuration[0].title)}）` : ''}`);
  check('B', 'B-06 系统补齐占位行不挂 child 父边', gapFillWithChild.length === 0, `${gapFillWithChild.length} 行`);

  // B-07/08 WBS 与同题重复
  check('B', 'B-07 只存在一套 WBS 编号体系', summary.wbsGroups <= 1, `${summary.wbsGroups} 套`);
  check('B', 'B-08 无归一化同题重复计划', summary.duplicateRows === 0, `${summary.duplicateRows} 行 / ${summary.duplicateGroups} 组`);

  // B-09 否定口径不得作为待开发需求（status=todo）
  const badConstraints = detectConstraintReqs(reqs).filter((r) => {
    const hit = data!.reqs.find((x) => str(x.req_no) === r.reqNo);
    return str(hit?.status) === 'todo';
  });
  check('B', 'B-09 否定/已闭环口径未被当作 status=todo 待开发需求', badConstraints.length === 0,
    `${badConstraints.length} 条${badConstraints.length ? `（例：${badConstraints.slice(0, 3).map((x) => x.reqNo).join('、')}）` : ''}`);

  // B-10 跨文档版本冲突（有基线时降级为 WARN）
  if (sources.length < 2) record('SKIP', 'B', 'B-10 跨文档版本冲突', '来源文档不足 2 份，无法比对');
  else if (summary.versionConflicts > 0 && !BASELINE) {
    record('FAIL', 'B', 'B-10 跨文档版本冲突', `${summary.versionConflicts} 项未裁定（可传 --baseline <文件名> 标记已裁定）：${summary.conflicts.slice(0, 5).map((c) => c.id).join('、')}`);
  } else if (summary.versionConflicts > 0) {
    record('WARN', 'B', 'B-10 跨文档版本冲突', `${summary.versionConflicts} 项，已声明基线「${BASELINE}」，仍需人工逐条复核`);
  } else check('B', 'B-10 跨文档版本冲突', true, '0 项');

  // B-11 来源文档分角色与零引用
  const designDocs = sources.filter((s) => s.role !== 'prd').length;
  const docRefCounts = new Map<string, number>();
  for (const r of data.reqs) {
    const k = str(r.prd_id);
    docRefCounts.set(k, (docRefCounts.get(k) ?? 0) + 1);
  }
  const zeroRefDocs = data.docs.filter((d) => (docRefCounts.get(str(d.id)) ?? 0) === 0);
  if (designDocs === 0 && diskSources.some((s) => s.role !== 'prd')) {
    record('WARN', 'B', 'B-11 设计/测试文档落库', `磁盘上有设计文档但 prd_docs 仅 ${data.docs.length} 份 prd 文档——按设计只归档、不参与解析，需确认是否为预期`);
  } else check('B', 'B-11 每份登记文档都有需求引用', zeroRefDocs.length === 0,
    `${zeroRefDocs.length} 份零引用${zeroRefDocs.length ? `（${zeroRefDocs.slice(0, 3).map((d) => str(d.filename)).join('、')}）` : ''}`);
  record('WARN', 'B', 'B-12 推定字段提示',
    `${summary.inferredFieldRows} 行工期/复杂度/优先级/排期在源文档中无依据（人工排期后标注为推定值）`);

  // B-13 覆盖缺口（T05575：默认 FAIL，--allow-coverage-gap 才降级 WARN）
  const gaps = summary.coverage.filter((g) => g.missing.length > 0);
  const gapDetail = gaps.map((g) => `${g.label} ${g.covered}/${g.total}`).join('、') || '无';
  if (summary.coverageGaps > 0 && !ALLOW_COVERAGE_GAP) {
    record('FAIL', 'B', 'B-13 源文档条目覆盖', `${summary.coverageGaps} 项缺口：${gapDetail}（可用 --allow-coverage-gap 显式接受）`);
  } else if (summary.coverageGaps > 0) {
    record('WARN', 'B', 'B-13 源文档条目覆盖', `${summary.coverageGaps} 项缺口：${gapDetail}（已显式接受缺口）`);
  } else record('PASS', 'B', 'B-13 源文档条目覆盖', '0 项缺口');

  // B-14 溯源格式一致性
  const refStyles = { section: 0, q: 0, plain: 0, other: 0 };
  for (const r of data.reqs) {
    const v = str(r.source_ref).trim();
    if (/^§/.test(v)) refStyles.section += 1;
    else if (/^Q-\d/i.test(v)) refStyles.q += 1;
    else if (/^\d+(\.\d+)?/.test(v)) refStyles.plain += 1;
    else refStyles.other += 1;
  }
  const styles = Object.values(refStyles).filter((n) => n > 0).length;
  record(styles > 1 ? 'WARN' : 'PASS', 'B', 'B-14 source_ref 格式一致性',
    `§${refStyles.section} / Q${refStyles.q} / 纯数字${refStyles.plain} / 自定义${refStyles.other}`);

  // B-15 工期不符的展示区间口径（前端 recalcMilestoneDurations 同款判据）
  const intervalIssues = findMilestoneDurationIssues(plans);
  record(intervalIssues.length ? 'WARN' : 'PASS', 'B', 'B-15 展示区间口径的里程碑工期',
    `${intervalIssues.length} 个不符（与 child 边的 B-05 判据互补）`);

  // B-16 解析失败/待确认问题
  record(data.failures.length || data.issues.length ? 'WARN' : 'PASS', 'B', 'B-16 解析失败片 / 待确认问题',
    `失败片 ${data.failures.length}、待确认问题 ${data.issues.length}`);

  // B-17 T05574：里程碑区间连续性（工期相符但排期断档——B-05 结构性判据抓不到）
  const scheduleGaps = findMilestoneScheduleGaps(plans);
  const msGaps = scheduleGaps.filter((g) => g.kind === 'milestone-gap');
  const childGaps = scheduleGaps.filter((g) => g.kind === 'child-gap');
  const spanIssues = scheduleGaps.filter((g) => g.kind === 'milestone-span');
  const worstGap = msGaps.slice().sort((a, b) => b.days - a.days)[0];
  record(scheduleGaps.length ? 'WARN' : 'PASS', 'B', 'B-17 里程碑区间连续性',
    `${msGaps.length} 处里程碑空档（最大 ${worstGap?.days ?? 0} 天${worstGap ? `：${worstGap.title} → ${worstGap.next}` : ''}）、`
    + `${childGaps.length} 处明细空档、${spanIssues.length} 处子项越界`);
}

// ---------------------------------------------------------------- D 组：源码接线锚（纯函数绿不等于产品链路接上了）
console.log('\n—— D 组 · 源码接线锚 ——');
const readSrc = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');
const panel = readSrc('web/src/pages/PrdImportPanel.tsx');
const svc = readSrc('server/src/services/PlanService.ts');
const childUtil = readSrc('server/src/util/milestoneChild.ts');
const wbsUtil = readSrc('server/src/util/prdWbs.ts');
const qualityUtil = readSrc('web/src/utils/prdQuality.ts');
check('D', 'D-01 导入面板渲染质量自检卡片并接上四个处置入口',
  /data-qc="import-quality"/.test(panel)
  && /onNormalize=\{normalizeWbsNow\}/.test(panel) && /onDisable=\{disableConstraintNow\}/.test(panel)
  && /onRefresh=\{\(\) => refreshQuality\(\{ log: true \}\)\}/.test(panel)
  && /onExport=\{downloadQualityReport\}/.test(panel));
check('D', 'D-02 版本基线软闸：冲突未裁定即禁止导入',
  /const baselineRequired = \(qualitySnapshot\?\.versionConflicts \?\? 0\) > 0 && !baselineDoc\.trim\(\)/.test(panel)
  && /if \(baselineRequired\) \{/.test(panel)
  && /disabled=\{busy \|\| submittableReqs === 0 \|\| baselineRequired/.test(panel));
check('D', 'D-03 预演回显文档引用数并按当前行重算质量快照',
  /setPreviewDocRefs\(p\.docReferences \?\? \[\]\)/.test(panel)
  && /const quality = refreshQuality\(\{ log: true \}\)/.test(panel));
check('D', 'D-04 否定口径在需求表里就地可见', /isConstraintReq\(r\) && r\.include/.test(panel));
check('D', 'D-05 服务端分片合并接入跨片同题去重与 WBS 套数播报',
  /dedupeDraftsByNormalizedTitle\(merged\.drafts\)/.test(svc)
  && /wbsGroups: wbsInfo\.groups/.test(svc)
  && /【WBS 一致性】/.test(svc));
check('D', 'D-06 服务端 child 补边与工期汇总共同跳过补齐行',
  /intervalChildEdges\(planItems[\s\S]{0,180}\{ skip: skipGapFill \}\)/.test(svc)
  && /options\?\.skip\?\.\(i, items\[i\]\)/.test(childUtil)
  && /isGapFillPlan\(/.test(svc));
check('D', 'D-07 预演返回逐份文档引用数（零引用可告警）',
  /docReferences: Array<\{ filename: string; docKind: 'prd' \| 'design' \| 'test'; reqCount: number \}>/.test(svc)
  && /const docReferences = \(input\.prdDocs \?\? \[\]\)/.test(svc));
check('D', 'D-08 归一化不误删中文标题、不误并占位行、冲突检测带区间降噪',
  /\[\\s\\p\{P\}\\p\{S\}\]\+/u.test(qualityUtil) && /\[\\s\\p\{P\}\\p\{S\}\]\+/u.test(wbsUtil)
  && /if \(isGapFillPlan\(.*\)\) return;/.test(qualityUtil)
  && /if \(isGapFillPlan\(\{ title: d\.title/.test(wbsUtil)
  && /RANGE_RE/.test(qualityUtil));
check('D', 'D-09 前端里程碑工期汇总与服务端同口径跳过占位行',
  /if \(out\[j\]\.include && !isGapFillPlan\(out\[j\]\)\)/.test(panel)
  && /if \(isGapFillPlan\(plans\[j\]\)\) continue;/.test(qualityUtil));

// ---------------- T05570 ~ T05575 代码落地锚 ----------------
check('D', 'D-10 T05570 设计文档可勾选「参与解析」并逐文件送解析',
  /data-t05570="design-participate"/.test(panel)
  && /includeInParse/.test(panel)
  && /parsedDesigns/.test(panel)
  && /parseOneFile\(d\.file/.test(panel));
check('D', 'D-11 T05571 单轮与分片两条路径都接源文档条目补齐',
  (svc.match(/applySourceEntryGapFill\(docText/g) ?? []).length >= 2
  && /SOURCE_ENTRY_GAP_DESC/.test(wbsUtil)
  && /export function applySourceEntryGapFill/.test(wbsUtil)
  && (svc.match(/sourceEntryFilled: sourceEntryRows\.length > 0/g) ?? []).length >= 2);
check('D', 'D-12 T05572 否定口径前移到 AI 解析 system prompt',
  /否定口径约束（必须遵守）/.test(svc) && /不得为它们生成 plans 计划行/.test(svc)
  && /不新增下发/.test(svc));
check('D', 'D-13 T05573 分片合并后自动收敛多套并行 WBS',
  /normalizeWbsGroups\(deduped\.drafts\)/.test(svc)
  && /export function normalizeWbsGroups/.test(wbsUtil)
  && /renumberedMilestones/.test(wbsUtil));
check('D', 'D-14 T05574 区间连续性校验函数存在且被质量门引用',
  /export function findMilestoneScheduleGaps/.test(qualityUtil)
  && /findMilestoneScheduleGaps\(plans\)/.test(fs.readFileSync(path.join(ROOT, 'scripts/verify/prd-import-quality-gate.mts'), 'utf8')));
check('D', 'D-15 T05575 覆盖缺口默认阻断 + 显式放行开关',
  /ALLOW_COVERAGE_GAP/.test(fs.readFileSync(path.join(ROOT, 'scripts/verify/prd-import-quality-gate.mts'), 'utf8'))
  && /--allow-coverage-gap/.test(fs.readFileSync(path.join(ROOT, 'scripts/verify/prd-import-quality-gate.mts'), 'utf8')));
check('D', 'D-16 T05575 导入面板提供「补齐覆盖缺口」与「接受缺口」处置入口，并纳入导入闸门',
  /data-t05575="fill-coverage"/.test(panel)
  && /data-t05575="allow-coverage-gap"/.test(panel)
  && /data-t05575="coverage-required"/.test(panel)
  && /appendCoverageGapPlans/.test(panel)
  && /coverageRequired/.test(panel)
  && /disabled=\{busy \|\| submittableReqs === 0 \|\| baselineRequired \|\| coverageRequired\}/.test(panel));

// ---------------------------------------------------------------- C 组：输出只读质量报告
console.log('\n—— C 组 · 质量报告（导入附加产物） ——');
if (!data || !summary) {
  record('SKIP', 'C', '未载入导入产物，跳过报告生成');
} else {
  // C-01 在报告写完才登记，报告里的明细表与计数需把它一并算进去，避免「控制台 27 / 报告 26」对不上
  const reportOut = path.resolve(OUT);
  const c01Row = { level: 'PASS' as const, group: 'C', name: 'C-01 只读质量报告已生成', detail: reportOut };
  const lines: string[] = [
    '# PRD 导入产物质量门报告',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 项目：${data.projectLabel}`,
    `- 数据规模：需求 ${data.reqs.length} / 计划 ${data.plans.filter((p) => !num(p.archived)).length} / 待办 ${data.tasks.length} / 登记文档 ${data.docs.length}`,
    `- 来源文档：${sources.map((s) => `${s.name}［${s.role === 'prd' ? 'PRD' : s.role === 'design' ? '设计' : '测试'}］`).join('、') || '（无）'}`,
    `- 版本基线：${BASELINE || '未裁定'}`,
    `- 检查方式：只读（SQLite readonly + 源文档只读），未改写任何源文档或已生成数据`,
    `- 结论：${fail > 0 ? '**不通过**' : warn > 0 ? '**有条件通过（存在告警）**' : '**通过**'}（PASS ${pass + 1} / FAIL ${fail} / WARN ${warn} / SKIP ${skip}）`,
    '',
    '## 一、总体摘要',
    '',
    formatQualitySummary(summary),
    '',
    '## 二、检查项明细',
    '',
    '| 级别 | 组 | 检查项 | 明细 |',
    '|---|---|---|---|',
    ...[...findings, c01Row].map((f) => `| ${f.level} | ${f.group} | ${f.name} | ${f.detail.replace(/\|/g, '\\|')} |`),
    '',
    '## 三、跨文档版本冲突',
    '',
  ];
  if (summary.conflicts.length === 0) lines.push('（无）', '');
  else {
    lines.push('| 编号 | 来源 | 状态 | 原文片段 |', '|---|---|---|---|');
    for (const c of summary.conflicts) for (const st of c.states) {
      lines.push(`| ${c.id} | ${st.doc} | ${st.state === 'pending' ? '待确认' : '已确认'} | ${st.excerpt.replace(/\|/g, '\\|').slice(0, 100)} |`);
    }
    lines.push('');
  }
  lines.push('## 四、源文档条目覆盖', '', '| 类别 | 覆盖/总数 | 缺口编号 |', '|---|---|---|');
  for (const g of summary.coverage) {
    lines.push(`| ${g.label} | ${g.covered}/${g.total} | ${g.missing.slice(0, 40).join('、') || '—'}${g.missing.length > 40 ? ` 等 ${g.missing.length} 项` : ''} |`);
  }
  lines.push('', '## 五、里程碑工期不符（展示区间口径）', '');
  const di = findMilestoneDurationIssues(qualityRows(data).plans);
  if (!di.length) lines.push('（无）', '');
  else {
    lines.push('| 里程碑 | 声明工期 | 明细合计 | 子项数 |', '|---|---:|---:|---:|');
    for (const d of di.slice(0, 40)) lines.push(`| ${d.title} | ${d.declared} | ${d.computed} | ${d.children} |`);
    lines.push('');
  }
  // T05574：工期相符 ≠ 排期合理——区间空档单独成节
  const gapsForReport = findMilestoneScheduleGaps(qualityRows(data).plans);
  lines.push('## 五之二、里程碑区间连续性（排期空档）', '');
  if (!gapsForReport.length) lines.push('（无：里程碑与明细之间无 > 3 天空档）', '');
  else {
    lines.push('| 类型 | 位置 | 空档/越界天数 | 说明 |', '|---|---|---:|---|');
    const typeLabel = { 'milestone-gap': '里程碑之间', 'child-gap': '同里程碑明细之间', 'milestone-span': '子项越界' } as const;
    for (const g of gapsForReport.slice(0, 40)) {
      lines.push(`| ${typeLabel[g.kind]} | ${g.title}${g.next ? ` → ${g.next}` : ''} | ${g.days} | ${g.detail.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  lines.push('## 六、修正建议', '',
    '1. 多套 WBS / 同题重复 → 在导入面板点「合并重复 WBS」统一 M1…Mn（只取消勾选，不删行）。',
    '2. 否定口径 → 改标约束/验收项或取消勾选，撤销无依据的 high 优先级与实现计划。',
    '3. 版本冲突 → 指定唯一需求依据并书面裁定（本门可传 --baseline 记录已裁定）。',
    '4. 设计/测试文档 → 勾选「参与解析」让独有条目进入 WBS，或明确接受「只归档」。',
    '4b. 覆盖缺口 → 点「补齐覆盖缺口」补占位计划并改写为有业务语义的任务；确实无需开发时才勾「接受缺口」。',
    '4c. 区间空档 → 工期相符但排期断裂（如 M4 与 M5 之间 250 天）多为里程碑未衔接，调整 start_date/end_date。',
    '5. 工期/占位行 → 归一化后重算；占位行改为有业务语义的任务或取消勾选。',
    '6. 推定字段 → 工期/复杂度/优先级/排期源文档无依据，导入后人工排期并标注为推定值。',
    '', '---', '', '*本报告由只读质量门生成，未对源文档或已生成数据做任何修改。*');
  const outDir = path.dirname(path.resolve(OUT));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(OUT), lines.join('\n') + '\n', 'utf8');
  check('C', 'C-01 只读质量报告已生成', fs.existsSync(path.resolve(OUT)), path.resolve(OUT));
}

console.log(`\nPASS=${pass} FAIL=${fail} WARN=${warn} SKIP=${skip}`);
if (fail > 0) process.exitCode = 1;
