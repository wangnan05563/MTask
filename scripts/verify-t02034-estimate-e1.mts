/**
 * E1（T02034 · PRD-估算视图 §3.1/§3.2/§4.5）验证脚本。
 *
 * 用法：`<node22runtime> node_modules/tsx/dist/cli.mjs scripts/verify-t02034-estimate-e1.ts`
 *   ⚠ Node 版本必须与 node_modules/better-sqlite3 的预编译 ABI 对齐（本机 2026-10-11 实测：
 *     Node22 ABI127 可加载，仓库默认 node24 直跑报 ERR_DLOPEN_FAILED）——与同目录
 *     verify-t01875.mjs 等保持一致的「由调用方传 runtime」写法，不在 package.json 里硬编码绝对路径
 *     （本仓踩过 mcp-run 硬编码 node 路径失效的坑）。ABI 探测口径见 scripts/verify-abi-switch.mjs。
 *
 * 隔离纪律（skill 红线 8）：库是 `os.tmpdir()/t02034-e1-*` 下的**新建空文件**，不碰生产库；
 * 跑完回收临时目录。库内写入全是测试夹具（不经 REST/MCP，也不触碰生产数据）。
 *
 * 覆盖面：A 建表与索引口径 / B 三点校验 / C 服务 CRUD·归档过滤·脱离计划 /
 *   D 批量「任一行失败整体不入库」 / E 快照 20 条裁剪 / F addWorkdays
 *   （含**服务端与前端镜像逐日网格全等**——§9 单源诉求的正面对策，同 planDeps 双口径教训）/
 *   G 单源锚点的负对照（T02293 判据 3~4：改名模拟 + 破行为反证）。
 *
 * 断言口径（T02293 改判）：中文文案一律**不抄第二份**，改读产品的 `ESTIMATE_ERRORS` /
 *   `ESTIMATE_POINT_LABELS` 单源常量；且每条「拒绝」断言的行为侧是**抛错 + 该行零副作用**
 *   （调用前后比对行快照），只比对文案的断言已按判据 3 交给 okPair 配对。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：文案锚必须配行为断言

// ---- 隔离库：环境变量必须在任何 getDb() 落到磁盘之前设好 ----
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02034-e1-'));
process.env.MTask_DATA_DIR = DATA_DIR;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const { changeBus } = await import('../server/src/services/ChangeBus.ts');
const {
  EstimateService: S, pointsError, ESTIMATE_PHASES, ESTIMATE_SOURCES, SNAPSHOT_RETAIN, ESTIMATE_META,
  ESTIMATE_ERRORS, ESTIMATE_POINT_LABELS,
} = await import('../server/src/services/EstimateService.ts');
const { addWorkdays, buildCalendar, isWorkday } = await import('../server/src/util/workdays.ts');
const {
  addWorkdays: feAddWorkdays, buildWorkdayCtx, countWorkdays, calcEndDate: feCalcEndDate,
  isWorkday: feIsWorkday, fmtDate: feFmt,
} = await import('../web/src/utils/workday.ts');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  }
};
/**
 * 拒绝类断言的统一探针（T02293 判据 1/3）。
 * 行为侧 = **抛错且该计划行没被多出/被改写**（用调用前后的行快照比对）；
 * 字面侧 = 文案含产品单源词干（`ESTIMATE_ERRORS` / `ESTIMATE_POINT_LABELS`），改措辞不会让本门假红。
 * 只断言「抛了什么中文」会放行最危险的一种失守：文案照旧、但脏数据真的写进了库。
 */
interface Reject { threw: boolean; msg: string; dirty: boolean }
const rowSnap = (projectId: string, planId: string) => JSON.stringify(
  db.prepare('SELECT optimistic, likely, pessimistic, phase, unit, source, note FROM estimate_items WHERE project_id = ? AND plan_id = ?').get(projectId, planId) ?? null);
function probe(fn: () => unknown, snapshot: () => unknown): Reject {
  const before = JSON.stringify(snapshot());
  try {
    fn();
    return { threw: false, msg: '', dirty: JSON.stringify(snapshot()) !== before };
  } catch (e) {
    return { threw: true, msg: e instanceof Error ? e.message : String(e), dirty: JSON.stringify(snapshot()) !== before };
  }
}
function reject(fn: () => unknown, projectId: string, planId: string): Reject {
  return probe(fn, () => rowSnap(projectId, planId));
}
const refused = (r: Reject) => r.threw && !r.dirty;
const saysStem = (r: Reject, stem: string) => r.threw && r.msg.includes(stem);
const rejectedPair = (label: string, r: Reject, stem: string) => okPair(
  ok, label, () => refused(r), () => saysStem(r, stem), () => ({ 文案: r.msg.slice(0, 120), 行快照: r.dirty }));
const estRows = (projectId: string) => () =>
  (db.prepare('SELECT COUNT(*) AS n FROM estimate_items WHERE project_id = ?').get(projectId) as { n: number }).n;
const snapRows = (projectId: string) => () =>
  (db.prepare('SELECT COUNT(*) AS n FROM estimate_snapshots WHERE project_id = ?').get(projectId) as { n: number }).n;
const errOf = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
const group = (t: string) => console.log(`\n== ${t}`);
const dayAfter = (base: string, i: number) => {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + i);
  return feFmt(d);
};

// ================= 夹具 =================
const db = getDb();
initSchema();
const T = '2026-10-11T00:00:00.000Z';

db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run('P1', '估算测试项目', '', T, T);
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run('P2', '另一项目', '', T, T);

const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?)`,
);
const plan = (id: string, projectId: string, title: string, start: string, dur: number, sort: number, kind = 'normal', complexity: number | null = null) =>
  insPlan.run(id, projectId, title, start, start, dur, sort, T, T, kind, complexity);
plan('pl-a', 'P1', '开发甲', '2026-10-12', 3, 1, 'normal', 3);
plan('pl-b', 'P1', '开发乙', '2026-10-13', 5, 2, 'normal', null);
plan('pl-m', 'P1', '阶段里程碑', '2026-10-12', 10, 3, 'milestone', 2);
plan('pl-arch', 'P1', '已归档计划', '2026-10-14', 2, 4);
plan('pl-b1', 'P2', '别项目计划', '2026-10-15', 2, 1);
db.prepare('UPDATE plan_tasks SET archived = 1 WHERE id = ?').run('pl-arch');

const insHoliday = db.prepare('INSERT INTO holidays (date, name, kind) VALUES (?, ?, ?)');
insHoliday.run('2026-10-12', '测试放假日', 'holiday');
insHoliday.run('2026-10-17', '测试加班日', 'overtime');

let changeEvents: string[] = [];
changeBus.on('change', (k: string) => changeEvents.push(k));

// ================= A 建表 / 索引 / DDL 口径 =================
group('A 建表与索引（§3.1/§3.2 迁移落点）');
const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
ok('A-01 estimate_items / estimate_snapshots 两张新表就位', tables.has('estimate_items') && tables.has('estimate_snapshots'));

const idxList = db.prepare("PRAGMA index_list('estimate_items')").all() as Array<{ name: string; unique: number }>;
const uniq = idxList.find((i) => i.unique === 1);
const uniqCols = uniq ? (db.prepare(`PRAGMA index_info('${uniq.name}')`).all() as Array<{ name: string }>).map((c) => c.name) : [];
ok('A-02 唯一索引 (project_id, plan_id)：一条计划最多一条估算', uniqCols.join(',') === 'project_id,plan_id', uniqCols);
ok('A-03 项目维度索引就位（面板整项目取 + 快照按时间取）',
  idxList.some((i) => i.name === 'idx_estimate_items_project')
  && (db.prepare("PRAGMA index_list('estimate_snapshots')").all() as Array<{ name: string }>).some((i) => i.name === 'idx_estimate_snapshots_project'));

const ddlItems = (db.prepare("SELECT sql FROM sqlite_master WHERE name='estimate_items'").get() as { sql: string }).sql;
ok('A-04 plan_id **不建物理外键**——purge 已归档计划的 DELETE 不被约束打断（§7 估算行原样保留）',
  !/REFERENCES\s+plan_tasks/i.test(ddlItems));
ok('A-05 project_id 随项目级联删（与 tasks / prd_requirements 同写法，删项目不留孤儿）',
  /ON DELETE CASCADE/.test(ddlItems));
// 注：SQLite 的 ALTER TABLE ADD COLUMN **会**改写 sqlite_master.sql（把列并进建表语句文本），
// 所以「源码里是增量补列」不能靠读 master.sql 判断——改为直接校 schema.ts 源码 + 库内无迁移框架表。
const cols = (db.prepare('PRAGMA table_info(estimate_items)').all() as Array<{ name: string }>).map((c) => c.name);
ok('A-06 estimate_items 列集合恰为 §3.1 的 12 列（不私自加列、不漏列）',
  cols.join(',') === 'id,project_id,plan_id,phase,unit,optimistic,likely,pessimistic,source,note,created_at,updated_at', cols);
const schemaSrc = readFileSync(join(process.cwd(), 'server/src/db/schema.ts'), 'utf8');
ok('A-07 沿用既有 ensureColumn 幂等范式、未引入迁移框架（库里无 migrations/schema_version 类表，plan_tasks 增量列仍在 ensureColumn 清单）',
  !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%migration%' OR name LIKE '%schema_version%')").all().length
  && /ensureColumn\('plan_tasks', 'complexity'/.test(schemaSrc) && /CREATE TABLE IF NOT EXISTS estimate_items/.test(schemaSrc));
ok('A-07b initSchema 连跑两次幂等不报错（CREATE TABLE IF NOT EXISTS 范式）', (() => {
  try { initSchema(); initSchema(); return true; } catch { return false; }
})());

db.prepare(`INSERT INTO estimate_items (id, project_id, plan_id, optimistic, likely, pessimistic, created_at, updated_at)
  VALUES ('raw-1', 'P1', 'pl-b', 1, 2, 3.5, ?, ?)`).run(T, T);
const rawRow = db.prepare("SELECT * FROM estimate_items WHERE id='raw-1'").get() as Record<string, unknown>;
ok('A-08 列默认值：phase=dev / unit=man_day / source=manual（DDL DEFAULT 生效）',
  rawRow.phase === 'dev' && rawRow.unit === 'man_day' && rawRow.source === 'manual',
  { phase: rawRow.phase, unit: rawRow.unit, source: rawRow.source });
ok('A-09 REAL 精度：0.5 人天粒度原样读回（§4.1 输入精度 0.5）', rawRow.pessimistic === 3.5, rawRow.pessimistic);
db.prepare("DELETE FROM estimate_items WHERE id='raw-1'").run();

// ================= B 三点校验纯函数 =================
group('B 三点校验（§3.1 optimistic ≤ likely ≤ pessimistic）');
const bOgM = pointsError(5, 3, 8);
okPair(ok, 'B-01 O>M 被拒（行为：非法序拒、合法序放行）',
  () => bOgM !== null && pointsError(1, 2, 3) === null,
  () => (bOgM ?? '').includes(`${ESTIMATE_POINT_LABELS.optimistic}（5）`), () => ({ 文案: bOgM }));
const bMgP = pointsError(1, 8, 3);
okPair(ok, 'B-02 M>P 被拒且文案指到被拒的那个点',
  () => bMgP !== null && pointsError(1, 2, 3) === null,
  () => (bMgP ?? '').includes(`${ESTIMATE_POINT_LABELS.pessimistic}（3）`), () => ({ 文案: bMgP }));
const bNeg = pointsError(-1, 2, 3);
okPair(ok, 'B-03 负值被拒（0 是合法下界，不误伤全 0 行）',
  () => bNeg !== null && pointsError(0, 0, 0) === null,
  () => (bNeg ?? '').includes(ESTIMATE_ERRORS.negative), () => ({ 文案: bNeg }));
const bNaN = pointsError(NaN, 2, 3);
okPair(ok, 'B-04 非数字（NaN）被拒',
  () => bNaN !== null,
  () => (bNaN ?? '').includes(ESTIMATE_ERRORS.notNumber), () => ({ 文案: bNaN }));
ok('B-05 O=M=P 合法（模板实测形态即 O=M，§3.3 ratio 1:4:1.6）', pointsError(2, 2, 2) === null);
ok('B-06 小数合法', pointsError(0.5, 1.5, 2.5) === null);
ok('B-07 全 0 合法（未投入行可记 0/0/0）', pointsError(0, 0, 0) === null);
ok('B-08 阶段/来源/单位/快照格式枚举单源可下发（E3 meta 接口据此渲染下拉）',
  ESTIMATE_META.phases === ESTIMATE_PHASES && ESTIMATE_SOURCES.join(',') === 'manual,rule,default'
  && ESTIMATE_PHASES.length === 6 && ESTIMATE_META.snapshotRetain === SNAPSHOT_RETAIN
  && ESTIMATE_PHASES.every((p: string) => typeof ESTIMATE_META.phaseLabels[p] === 'string' && ESTIMATE_META.phaseLabels[p].length > 0)
  && new Set(ESTIMATE_PHASES.map((p: string) => ESTIMATE_META.phaseLabels[p])).size === ESTIMATE_PHASES.length
  && ESTIMATE_PHASES.every((p: string) => ESTIMATE_META.phaseLabels[p] !== p));

// ================= C 服务 CRUD / 归档过滤 / 脱离计划 =================
group('C EstimateService CRUD（§8 PATCH 语义 + §7 联动）');
changeEvents = [];
const v = S.upsert('P1', 'pl-a', { optimistic: 2, likely: 4, pessimistic: 9, note: ' 复杂度3  ' });
ok('C-01 新行写入并回视图（左联计划标题/工期/复杂度，§3.4 映射表）',
  v.planTitle === '开发甲' && v.durationDays === 3 && v.complexity === 3 && v.optimistic === 2,
  { title: v.planTitle, durationDays: v.durationDays, complexity: v.complexity });
ok('C-02 写库后广播 plans 变更（§6.7 新模块口径：不留「改完手动刷新」的老债）', changeEvents.includes('plans'), changeEvents);
ok('C-03 note 落库去首尾空白', v.note === '复杂度3', v.note);
ok('C-04 缺省 phase/unit/source 落默认 dev / man_day / manual',
  v.phase === 'dev' && v.unit === 'man_day' && v.source === 'manual');

const v2 = S.upsert('P1', 'pl-a', { likely: 5 });
ok('C-05 同计划重复 upsert 不新增行（走 UPDATE 路径）',
  S.listByProject('P1').filter((r) => r.plan_id === 'pl-a').length === 1);
ok('C-06 PATCH 缺省三点沿用原值，只改 M → 2/5/9',
  v2.optimistic === 2 && v2.likely === 5 && v2.pessimistic === 9, { o: v2.optimistic, m: v2.likely, p: v2.pessimistic });
ok('C-07 未传 note 不被清空', v2.note === '复杂度3', v2.note);
const rowA1 = db.prepare("SELECT * FROM estimate_items WHERE plan_id='pl-a'").get() as { id: string; created_at: string; updated_at: string };
S.upsert('P1', 'pl-a', { note: '同一行第二次 PATCH' });
const rowA2 = db.prepare("SELECT * FROM estimate_items WHERE plan_id='pl-a'").get() as { id: string; created_at: string; updated_at: string };
ok('C-08 PATCH 走 UPDATE：主键不变、created_at 不被重置、updated_at 不回退（同毫秒相等是允许的）',
  rowA2.id === rowA1.id && rowA2.created_at === rowA1.created_at && rowA2.updated_at >= rowA1.updated_at, rowA2);

rejectedPair('C-09 新行缺三点被拒（不落半行、不静默默认）',
  reject(() => S.upsert('P1', 'pl-b', { optimistic: 1 }), 'P1', 'pl-b'), ESTIMATE_ERRORS.pointsRequired);
rejectedPair('C-10 O>M 经服务层拒绝（不靠前端输入框兜）',
  reject(() => S.upsert('P1', 'pl-b', { optimistic: 9, likely: 1, pessimistic: 2 }), 'P1', 'pl-b'), ESTIMATE_ERRORS.ordering);
rejectedPair('C-11 非数字入参（字符串 abc）被拒',
  reject(() => S.upsert('P1', 'pl-b', { optimistic: 'abc', likely: 1, pessimistic: 2 }), 'P1', 'pl-b'), ESTIMATE_ERRORS.notNumber);
ok('C-12 字符串数字接受（JSON 传 "3" 不误拒）', S.upsert('P1', 'pl-b', { optimistic: '1', likely: '2', pessimistic: '3' }).likely === 2);
rejectedPair('C-13 未知阶段被拒（文案列可用值由单源枚举拼出）',
  reject(() => S.upsert('P1', 'pl-b', { optimistic: 1, likely: 2, pessimistic: 3, phase: 'qa' as never }), 'P1', 'pl-b'), ESTIMATE_ERRORS.unknownPhase);
rejectedPair('C-14 未知计量单位被拒',
  reject(() => S.upsert('P1', 'pl-b', { optimistic: 1, likely: 2, pessimistic: 3, unit: 'man_hour' as never }), 'P1', 'pl-b'), ESTIMATE_ERRORS.unknownUnit);
ok('C-15 非法 source 回落 manual（来自 AI/批量通道，纠正优于 500）',
  S.upsert('P1', 'pl-b', { optimistic: 1, likely: 2, pessimistic: 3, source: 'ai' as never }).source === 'manual');
rejectedPair('C-16 跨项目 planId 被拒（脏引用不是笔误）',
  reject(() => S.upsert('P1', 'pl-b1', { optimistic: 1, likely: 2, pessimistic: 3 }), 'P1', 'pl-b1'), ESTIMATE_ERRORS.planNotInProject);
rejectedPair('C-17 不存在的 planId 被拒',
  reject(() => S.upsert('P1', 'ghost', { optimistic: 1, likely: 2, pessimistic: 3 }), 'P1', 'ghost'), ESTIMATE_ERRORS.planMissing);
rejectedPair('C-18 不存在的项目被拒（不在别处留同名行）',
  reject(() => S.upsert('P0', 'pl-a', { optimistic: 1, likely: 2, pessimistic: 3 }), 'P0', 'pl-a'), ESTIMATE_ERRORS.projectNotFound);
const c19a = reject(() => S.upsert('', 'pl-a', { optimistic: 1, likely: 2, pessimistic: 3 }), '', 'pl-a');
const c19b = reject(() => S.upsert('P1', '', { optimistic: 1, likely: 2, pessimistic: 3 }), 'P1', '');
rejectedPair('C-19a projectId 空串被拒', c19a, ESTIMATE_ERRORS.projectIdRequired);
rejectedPair('C-19b planId 空串被拒', c19b, ESTIMATE_ERRORS.planIdRequired);

const vm = S.upsert('P1', 'pl-m', { optimistic: 4, likely: 8, pessimistic: 12, phase: 'dev', source: 'rule' });
ok('C-20 里程碑行可录入推导值供参考（Σ 侧才排除它，§4.6 v1.4 归 E3）',
  vm.planKind === 'milestone' && vm.source === 'rule');
ok('C-21 规则推导的 source=rule 落库保留（人工改一次即转 manual 的前提，§9 复核率出数）',
  (db.prepare("SELECT source FROM estimate_items WHERE plan_id='pl-m'").get() as { source: string }).source === 'rule');

const listed = S.listByProject('P1');
ok('C-22 面板取数默认排除已归档计划的行（§3.1 B5 视图层过滤）',
  listed.every((r) => r.plan_id !== 'pl-arch') && listed.length === 3, listed.map((r) => r.plan_id));
ok('C-23 排序沿用计划时间线次序（sort_order→起始日），不引入第二套次序',
  listed.map((r) => r.plan_id).join(',') === 'pl-a,pl-b,pl-m', listed.map((r) => r.plan_id));
S.upsert('P1', 'pl-arch', { optimistic: 1, likely: 1, pessimistic: 1 });
ok('C-24 includeArchived 可含归档行（清理提示与历史复核用）',
  S.listByProject('P1', { includeArchived: true }).filter((r) => r.plan_id === 'pl-arch').length === 1);
ok('C-25 complexity 为 NULL 的计划左联后仍是 null（区分「未填」与 0，§4.6 规则 1 的输入）',
  S.getForPlan('P1', 'pl-b')!.complexity === null);

ok('C-26 删除估算行：首次 true、重复 false', S.remove('P1', 'pl-arch') === true && S.remove('P1', 'pl-arch') === false);
const plansBefore = (db.prepare('SELECT COUNT(*) AS n FROM plan_tasks').get() as { n: number }).n;
S.remove('P1', 'pl-b');
ok('C-27 删除估算不影响 plan_tasks（§9 数据一致）',
  (db.prepare('SELECT COUNT(*) AS n FROM plan_tasks').get() as { n: number }).n === plansBefore);
ok('C-28 已删行 getForPlan 返回 null（区间条/偏差徽标按行取数不留脏引用）', S.getForPlan('P1', 'pl-b') === null);

const purgeErr = errOf(() => db.prepare('DELETE FROM plan_tasks WHERE id = ? AND archived = 0').run('pl-b'));
ok('C-29 物理删除计划不被外键约束打断（本条即 plan_id 不建 FK 的全部理由）', purgeErr === '' || !/CONSTRAINT/.test(purgeErr), purgeErr);
S.upsert('P1', 'pl-a', { optimistic: 2, likely: 4, pessimistic: 8 });
db.prepare('DELETE FROM plan_tasks WHERE id = ?').run('pl-a');
const detached = S.listDetached('P1');
ok('C-30 脱离计划的估算行原样保留并可计数（§7「有 N 条估算已脱离计划」）',
  detached.length === 1 && detached[0].plan_id === 'pl-a', detached.map((r) => r.plan_id));
ok('C-31 脱离行不进常规面板（INNER JOIN 天然过滤，不会渲染成无名行）',
  S.listByProject('P1').every((r) => r.plan_id !== 'pl-a'),
  { panel: S.listByProject('P1').map((r) => r.plan_id), detached: S.listDetached('P1').map((r) => r.plan_id) });
ok('C-32 显式清理只删脱离行；仍挂在计划上的行不被动（§7 清理为手动操作）',
  S.removeDetached('P1', ['ghost-id', detached[0].id, vm.id]) === 1
  && S.listDetached('P1').length === 0 && S.getForPlan('P1', 'pl-m') !== null);
rejectedPair('C-33 removeDetached 空选择报错（不当作静默 no-op，也不误删有主行）',
  probe(() => S.removeDetached('P1', []), estRows('P1')), ESTIMATE_ERRORS.nothingToClean);

// ================= D 批量写入：任一行失败整体不入库 =================
group('D 批量写入（§8 batch + §3.1 整体不入库口径）');
const cntBefore = (db.prepare("SELECT COUNT(*) AS n FROM estimate_items WHERE project_id='P1'").get() as { n: number }).n;
const badBatch = S.upsertBatch('P1', [
  { planId: 'pl-m', optimistic: 1, likely: 2, pessimistic: 3 },
  { planId: 'pl-m', optimistic: 9, likely: 2, pessimistic: 3 },
  { planId: 'pl-b1', optimistic: 1, likely: 2, pessimistic: 3 },
]);
const cntAfterBad = (db.prepare("SELECT COUNT(*) AS n FROM estimate_items WHERE project_id='P1'").get() as { n: number }).n;
ok('D-01 任一行不合格 → written=0 且零写入（不是「能写多少写多少」）',
  badBatch.written === 0 && cntAfterBad === cntBefore, { written: badBatch.written, before: cntBefore, after: cntAfterBad });
okPair(ok, 'D-02 行级错误逐条回传 index + planId（行为：定位到错的这两行）',
  () => badBatch.errors.length === 2 && badBatch.errors[0].index === 1 && badBatch.errors[1].index === 2
    && badBatch.errors[0].planId === 'pl-m' && badBatch.errors[1].planId === 'pl-b1',
  () => (badBatch.errors[0]?.message ?? '').includes(ESTIMATE_ERRORS.ordering)
    && (badBatch.errors[1]?.message ?? '').includes(ESTIMATE_ERRORS.planNotInProject),
  () => badBatch.errors);
ok('D-03 全合法批量落库 written=N 并只广播一次 plans', (() => {
  changeEvents = [];
  const r = S.upsertBatch('P1', [
    { planId: 'pl-m', optimistic: 1, likely: 2, pessimistic: 3, source: 'rule' },
    { planId: 'pl-arch', optimistic: 2, likely: 2, pessimistic: 2, source: 'default' },
  ]);
  return r.written === 2 && r.errors.length === 0 && changeEvents.filter((k) => k === 'plans').length === 1;
})());
rejectedPair('D-04 空数组直接报错（不是「写入 0 行」的成功假象）',
  probe(() => S.upsertBatch('P1', []), estRows('P1')), ESTIMATE_ERRORS.batchEmpty);
ok('D-05 批量里的非法阶段同样转行级错误（与单行同口径）',
  S.upsertBatch('P1', [{ planId: 'pl-arch', optimistic: 1, likely: 2, pessimistic: 3, phase: 'nope' as never }]).errors.length === 1);
ok('D-06 批量沿用 PATCH 语义（只给 P 时 O/M 沿用原值）', (() => {
  const r = S.upsertBatch('P1', [{ planId: 'pl-arch', pessimistic: 4 }]);
  const row = S.getForPlan('P1', 'pl-arch')!;
  return r.written === 1 && r.errors.length === 0 && row.optimistic === 2 && row.likely === 2 && row.pessimistic === 4;
})());

// ================= E 快照 20 条裁剪 =================
group('E 快照留档（§3.2 每项目保留最近 20 条）');
for (let i = 0; i < 25; i++) {
  S.createSnapshot('P1', { format: 'xlsx', filename: `s${String(i).padStart(3, '0')}.xlsx`, payload: { seq: i } });
}
const snapFiles = (db.prepare("SELECT filename FROM estimate_snapshots WHERE project_id='P1'").all() as Array<{ filename: string }>).map((r) => r.filename);
ok('E-01 超量后收敛到 SNAPSHOT_RETAIN=20（TaskService 历史裁剪范式的参数化）',
  snapFiles.length === SNAPSHOT_RETAIN, snapFiles.length);
ok('E-02 保留的是最新一批（s024 在列、s000 被裁）',
  snapFiles.includes('s024.xlsx') && !snapFiles.includes('s000.xlsx'), snapFiles.slice(0, 3));
S.createSnapshot('P2', { format: 'pdf', filename: 'p0.pdf', payload: {} });
S.createSnapshot('P2', { format: 'pdf', filename: 'p1.pdf', payload: {} });
ok('E-03 裁剪按项目独立（别项目 2 条不受牵连）',
  (db.prepare("SELECT COUNT(*) AS n FROM estimate_snapshots WHERE project_id='P2'").get() as { n: number }).n === 2);
const one = S.createSnapshot('P1', { format: 'xlsx', filename: 'latest.xlsx', payload: { phases: { dev: { e: 12.5, sigma: 1.2 } }, coefs: { quality: 0.06 } } });
ok('E-04 payload 落库原样读回（汇总结果 JSON，不存原始三点）',
  one.filename === 'latest.xlsx' && JSON.parse(one.payload).phases.dev.e === 12.5);
const e05 = probe(() => S.createSnapshot('P1', { format: 'docx' as never, payload: {} }), snapRows('P1'));
rejectedPair('E-05 未知导出格式被拒（不留一条记不出来的留档）', e05, ESTIMATE_ERRORS.unknownSnapshotFormat);
const circ: Record<string, unknown> = {};
circ.self = circ;
const e06 = probe(() => S.createSnapshot('P1', { format: 'xlsx', payload: circ }), snapRows('P1'));
okPair(ok, 'E-06 payload 不可序列化时报中文错（不外泄 RangeError、不留半条快照）',
  () => refused(e06) && !/RangeError|circular/i.test(e06.msg),
  () => saysStem(e06, ESTIMATE_ERRORS.payloadUnserializable),
  () => ({ 文案: e06.msg.slice(0, 120) }));
ok('E-07 列表按时间倒序、limit 可收窄且不超保留上限', (() => {
  const l = S.listSnapshots('P1', 3);
  return l.length === 3 && l[0].filename === 'latest.xlsx' && S.listSnapshots('P1', 999).length === SNAPSHOT_RETAIN;
})());
rejectedPair('E-08 项目不存在时快照被拒（不留孤儿留档）',
  probe(() => S.createSnapshot('PX', { format: 'xlsx', payload: {} }), snapRows('PX')), ESTIMATE_ERRORS.projectNotFound);
ok('E-09 快照 format 落库为给定值（xlsx/pdf 两态供 §9 导出次数度量出数）',
  (db.prepare("SELECT format FROM estimate_snapshots WHERE id=?").get(one.id) as { format: string }).format === 'xlsx');

// ================= F addWorkdays（§4.5 缺口 + 单源镜像） =================
group('F addWorkdays（§4.5：本仓此前只有含尾的 calcEndDate，缺正向函数）');
const holidayRows = db.prepare('SELECT date, kind FROM holidays').all() as Array<{ date: string; kind: string }>;
const cal = buildCalendar(holidayRows);
const feCal = buildWorkdayCtx(holidayRows);
ok('F-01 服务端 buildCalendar 与前端 buildWorkdayCtx 对同一批表行输出同构日历（口径单源）',
  [...cal.holidays].sort().join() === [...feCal.holidays].sort().join()
  && [...cal.overtime].sort().join() === [...feCal.overtime].sort().join()
  && cal.holidays.has('2026-10-12') && cal.overtime.has('2026-10-17'));
ok('F-02 kind 缺省/NULL 归放假日（与 PlanService.loadCalendar 同判据）',
  buildCalendar([{ date: '2026-12-24', kind: null }]).holidays.has('2026-12-24'));
ok('F-03 周五 +1 跨周末落到周一（无节假日日历）', addWorkdays('2026-10-09', 1, buildCalendar([])) === '2026-10-12');
ok('F-04 锚点当日不计入：n=1 落「其后」第一个工作日（与 calcEndDate 含尾语义差一个工作日，头注已记）',
  addWorkdays('2026-10-13', 1, buildCalendar([])) === '2026-10-14');
ok('F-05 放假日命中：10-09(周五) +1，10-12(周一)放假 → 10-13', addWorkdays('2026-10-09', 1, cal) === '2026-10-13');
ok('F-06 加班日优先视为工作日：10-16(周五) +1 → 10-17(周六加班)', addWorkdays('2026-10-16', 1, cal) === '2026-10-17');
ok('F-07 n=0：工作日锚点原样返回', addWorkdays('2026-10-13', 0, cal) === '2026-10-13');
ok('F-08 n=0：周末/假期锚点顺延到其后第一个工作日（吸附语义）',
  addWorkdays('2026-10-11', 0, cal) === '2026-10-13' && addWorkdays('2026-10-12', 0, cal) === '2026-10-13');
ok('F-09 n<0 与 n=0 同义（负数不造日期）', addWorkdays('2026-10-13', -3, cal) === '2026-10-13');
ok('F-10 非法/空锚点原样返回（缺排期日期的行不凭空造日期）',
  addWorkdays('', 3, cal) === '' && addWorkdays('2026/10/13', 3, cal) === '2026/10/13' && addWorkdays('2026-10-1', 2, cal) === '2026-10-1');
ok('F-11 n 非整数向下取整（3.7 → 3）', addWorkdays('2026-10-13', 3.7, buildCalendar([])) === '2026-10-16',
  addWorkdays('2026-10-13', 3.7, buildCalendar([])));
ok('F-12 长假连跳：09-30(周三) +1，10-01~10-08 全放假 → 10-09(周五)',
  addWorkdays('2026-09-30', 1, buildCalendar(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
    .map((d) => ({ date: d, kind: 'holiday' })))) === '2026-10-09');
ok('F-13 落点区间 (锚点, 结果] 内工作日数恰为 n（正向函数自洽，n=1..20）', (() => {
  const first = addWorkdays('2026-10-13', 1, cal);
  for (let n = 1; n <= 20; n++) {
    if (countWorkdays(first, addWorkdays('2026-10-13', n, cal), feCal) !== n) return false;
  }
  return true;
})());
ok('F-14 与含尾口径的差一关系成立：工作日锚点下 addWorkdays(a,n) === calcEndDate(a,n+1)（n=1..15）', (() => {
  const empty = buildWorkdayCtx([]);
  for (let n = 1; n <= 15; n++) {
    if (addWorkdays('2026-11-02', n, buildCalendar([])) !== feCalcEndDate('2026-11-02', n + 1, empty)) return false;
  }
  return true;
})());

const gridRows: Array<{ date: string; kind: string | null }> = [
  { date: '2026-11-03', kind: 'holiday' }, { date: '2026-11-06', kind: 'overtime' },
  { date: '2026-11-11', kind: 'holiday' }, { date: '2026-11-12', kind: 'holiday' },
  { date: '2026-11-13', kind: 'holiday' }, { date: '2026-11-20', kind: 'overtime' },
  { date: '2026-11-21', kind: 'overtime' }, { date: '2026-11-25', kind: null },
];
const gridCal = buildCalendar(gridRows);
const gridFe = buildWorkdayCtx(gridRows);
const mismatch: Array<Record<string, string>> = [];
for (let i = 0; i < 60; i++) {
  const anchor = dayAfter('2026-11-01', i);
  for (let n = 0; n <= 12; n++) {
    const a = addWorkdays(anchor, n, gridCal);
    const b = feAddWorkdays(anchor, n, gridFe);
    if (a !== b) mismatch.push({ anchor, n: String(n), server: a, front: b });
  }
}
ok('F-15 服务端 / 前端镜像 60 锚点 × n=0..12（720 格）逐格全等（§9 单源，杜绝第二套口径）',
  mismatch.length === 0, mismatch.slice(0, 3));
ok('F-16 两侧 isWorkday 同口径（同网格逐日比对）', (() => {
  for (let i = 0; i < 60; i++) {
    const s = dayAfter('2026-11-01', i);
    const d = new Date(`${s}T00:00:00`);
    if (isWorkday(d, gridCal) !== feIsWorkday(d, gridFe)) return false;
  }
  return true;
})());
ok('F-17 网格确覆盖工作日/周末/放假/加班四类日（防空转断言）', (() => {
  const kinds = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const s = dayAfter('2026-11-01', i);
    const d = new Date(`${s}T00:00:00`);
    kinds.add(isWorkday(d, gridCal) ? 'workday' : 'off');
    if (d.getDay() === 0 || d.getDay() === 6) kinds.add('weekend');
    if (gridCal.holidays.has(s)) kinds.add('holiday');
    if (gridCal.overtime.has(s)) kinds.add('overtime');
  }
  return kinds.size === 5;
})());
ok('F-18 前端 n<=0 与非法规式锚点行为与服务端一致（镜像不留边角差异）',
  feAddWorkdays('', 2, gridFe) === '' && feAddWorkdays('2026-11-01', 0, gridFe) === addWorkdays('2026-11-01', 0, gridCal));

// ================= G 单源锚点的负对照（T02293 判据 3~4） =================
group('G 单源锚点的负对照（改名模拟 + 破行为反证）');
plan('pl-g', 'P1', '反证计划', '2026-10-20', 1, 9);
plan('pl-gm', 'P1', '反证里程碑', '2026-10-20', 2, 10, 'milestone');
db.prepare("UPDATE plan_tasks SET status='done', progress=100 WHERE id='pl-gm'").run();

type StemKey = keyof typeof ESTIMATE_ERRORS;
const stemCases: Array<{ key: StemKey; run: () => Reject }> = [
  { key: 'projectIdRequired', run: () => probe(() => S.upsert('', 'pl-g', { optimistic: 1, likely: 2, pessimistic: 3 }), estRows('P1')) },
  { key: 'planIdRequired', run: () => probe(() => S.upsert('P1', '', { optimistic: 1, likely: 2, pessimistic: 3 }), estRows('P1')) },
  { key: 'planMissing', run: () => reject(() => S.upsert('P1', 'ghost-g', { optimistic: 1, likely: 2, pessimistic: 3 }), 'P1', 'ghost-g') },
  { key: 'planNotInProject', run: () => reject(() => S.upsert('P1', 'pl-b1', { optimistic: 1, likely: 2, pessimistic: 3 }), 'P1', 'pl-b1') },
  { key: 'projectNotFound', run: () => reject(() => S.upsert('P0', 'pl-g', { optimistic: 1, likely: 2, pessimistic: 3 }), 'P0', 'pl-g') },
  { key: 'milestoneReadonly', run: () => reject(() => S.upsert('P1', 'pl-gm', { optimistic: 1, likely: 2, pessimistic: 3 }), 'P1', 'pl-gm') },
  { key: 'pointsRequired', run: () => reject(() => S.upsert('P1', 'pl-g', {}), 'P1', 'pl-g') },
  { key: 'notNumber', run: () => reject(() => S.upsert('P1', 'pl-g', { optimistic: 'abc', likely: 2, pessimistic: 3 }), 'P1', 'pl-g') },
  { key: 'negative', run: () => reject(() => S.upsert('P1', 'pl-g', { optimistic: -1, likely: 2, pessimistic: 3 }), 'P1', 'pl-g') },
  { key: 'ordering', run: () => reject(() => S.upsert('P1', 'pl-g', { optimistic: 9, likely: 2, pessimistic: 3 }), 'P1', 'pl-g') },
  { key: 'unknownPhase', run: () => reject(() => S.upsert('P1', 'pl-g', { optimistic: 1, likely: 2, pessimistic: 3, phase: 'qa' as never }), 'P1', 'pl-g') },
  { key: 'unknownUnit', run: () => reject(() => S.upsert('P1', 'pl-g', { optimistic: 1, likely: 2, pessimistic: 3, unit: 'man_hour' as never }), 'P1', 'pl-g') },
  { key: 'batchEmpty', run: () => probe(() => S.upsertBatch('P1', []), estRows('P1')) },
  { key: 'nothingToClean', run: () => probe(() => S.removeDetached('P1', []), estRows('P1')) },
  { key: 'unknownSnapshotFormat', run: () => probe(() => S.createSnapshot('P1', { format: 'docx' as never, payload: {} }), snapRows('P1')) },
  { key: 'payloadUnserializable', run: () => probe(() => S.createSnapshot('P1', { format: 'xlsx', payload: circ }), snapRows('P1')) },
];
const moved: string[] = [];
const stuck: Array<{ 词干: string; 症结: string }> = [];
for (const c of stemCases) {
  const table = ESTIMATE_ERRORS as unknown as Record<StemKey, string>;
  const orig = table[c.key];
  const renamed = `ZZZ-${c.key}`;
  const before = c.run();
  table[c.key] = renamed;
  let after: Reject;
  try {
    after = c.run();
  } finally {
    table[c.key] = orig;
  }
  const back = c.run();
  if (!refused(before) || !saysStem(before, orig)) stuck.push({ 词干: c.key, 症结: '原始件就没拒绝或锚点不命中' });
  else if (!refused(after)) stuck.push({ 词干: c.key, 症结: '改名后连拒绝都没有了（行为被措辞绑架）' });
  else if (!after.msg.includes(renamed)) stuck.push({ 词干: c.key, 症结: '文案没随单源移动（产品里另有抄本）' });
  else if (after.msg.includes(orig)) stuck.push({ 词干: c.key, 症结: '改名后仍残留旧词干（同一句话有两处来源）' });
  else if (back.msg !== before.msg) stuck.push({ 词干: c.key, 症结: '还原后与初始文案不逐字符相同（模拟留了残渣）' });
  else moved.push(c.key);
}
ok(`G-01 改名模拟：${stemCases.length} 个词干逐一同源移动（门读常量、产品无第二份抄本、还原后逐字符相同）`,
  stuck.length === 0 && moved.length === stemCases.length, { stuck, 已通过: moved.length });

// G-02 反证「抄本会被改名模拟抓到」：故意留一份字面量当锚点，单源改名后它必然失配。
const copiedLiteral = '未知阶段';
const g02Table = ESTIMATE_ERRORS as unknown as Record<StemKey, string>;
const g02Orig = g02Table.unknownPhase;
const g02Renamed = 'ZZZ-假名';
g02Table.unknownPhase = g02Renamed;
const g02Msg = errOf(() => S.upsert('P1', 'pl-g', { optimistic: 1, likely: 2, pessimistic: 3, phase: 'qa' as never }));
g02Table.unknownPhase = g02Orig;
ok('G-02 抄本可被抓：拿字面量当锚点时，改名后锚点失配而单源仍命中（证明 G-01 的判据有牙）',
  !g02Msg.includes(copiedLiteral) && g02Msg.includes(g02Renamed) && g02Msg.includes('：qa（可用'),
  { 文案: g02Msg.slice(0, 80) });

const g03Real = reject(() => S.upsert('P1', 'pl-g', { optimistic: 9, likely: 2, pessimistic: 3 }), 'P1', 'pl-g');
const g03Fake: Reject = { threw: true, msg: g03Real.msg, dirty: true };
ok('G-03 破行为反证：文案逐字相同但脏数据真写进了库，行为侧判红；只看字面锚点会放行',
  refused(g03Real) && !refused(g03Fake) && saysStem(g03Fake, ESTIMATE_ERRORS.ordering),
  { 只看字面: saysStem(g03Fake, ESTIMATE_ERRORS.ordering), 配对判定: refused(g03Fake) });
const g04Silent: Reject = { threw: false, msg: '', dirty: false };
ok('G-04 破行为反证：静默放行（不抛错也不写行）同样判红——拒绝必须真的发生',
  !refused(g04Silent) && !saysStem(g04Silent, ESTIMATE_ERRORS.ordering));

const rec: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
const spy = (name: string, cond: boolean, extra?: unknown) => { rec.push({ name, cond, extra }); };
okPair(spy, '行为失守样', () => false, () => true);
okPair(spy, '锚点失配样', () => true, () => false);
okPair(spy, '双绿样', () => true, () => true);
ok('G-05 红因可区分：行为失守与字面锚点失配记成两条不同的红（等价重构不该被读成功能失守）',
  rec.length === 3 && rec[0].cond === false && JSON.stringify(rec[0].extra).includes('行为失守')
  && rec[1].cond === false && JSON.stringify(rec[1].extra).includes('字面锚点失配') && rec[2].cond === true, rec);

// ================= 汇总 =================
console.log(`\n== 合计 PASS=${pass} FAIL=${fail}（隔离库 ${DATA_DIR}）`);
closeDb(); // 不先关连接的话，Windows 上临时库句柄未释放，rmSync 直接 EBUSY
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {
  console.log(`  [WARN] 临时库回收失败（不影响断言结论）：${e instanceof Error ? e.message : String(e)}`);
}
process.exitCode = fail === 0 ? 0 : 1;
