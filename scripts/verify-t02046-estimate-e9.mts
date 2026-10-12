/**
 * T02046（PRD-估算视图 §7 + E9「变更影响分析」）验证脚本：偏差徽标 / 收口只读 / 重导提示 / 影响试算。
 *
 * 用法（Node 版本必须与 node_modules/better-sqlite3 的预编译 ABI 对齐；与 E4a/E4b 同写法）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02046-estimate-e9.mts
 *
 * 两段结构（沿用 E4b/E6 的取证范式）：
 *   S 段（同进程·纯函数 + 源码守卫）：
 *     1) `countWorkdaysBetween` 的**算术改写**与逐日推进参照实现全等（含节假日/加班日/同日期两集
 *        命中/长跨度）——§7 剩余排期是逐行调用的，成本不能再跟日期跨度挂钩；
 *     2) `rowDriftCheck` 的阈值边界、未估算行、过期排期、只读判定（与 `EstimateService.isClosedMilestone`
 *        同语义 = 写路径闸门与面板读数同一份定义）；
 *     3) 红线守卫：面板源码不得出现 1.5 / 0.67 字面量与任何比值/剩余排期算式（判定与阈值只在服务端）。
 *   R 段（隔离实例·REST）：
 *     `GET /api/estimates` 每行 drift 与 checks.drift 计数同源；已收口里程碑的 PATCH/DELETE/batch
 *     三条写通道一律 400 且零写入，显式 `unlock` 才放行；`POST /what-if` 前后对比 + `written=0`
 *     且改完参数面读数不动（真·不落库）；试算的参数校验与 `PUT /params` 同一把尺子；
 *     `changedSinceExport` 无快照/有快照/改计划/改估算/导出后归零的完整一圈；
 *     `holidays` 表真值进日历（插一条放假日 → 该行剩余排期少 1）。
 *
 * 隔离纪律（skill 红线 8）：库与端口都是临时的，不碰生产数据目录，跑完 kill + 回收临时目录。
 * 真机 UI 走查（§7 徽标/解锁/试算/重导提示）不在本脚本内，见 scripts/verify-t02046-ui.mjs。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02046-e9-'));
const PORT = Number(process.env.T02046_PORT ?? 39947);
process.env.MTask_DATA_DIR = DATA_DIR;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const { isClosedMilestone } = await import('../server/src/services/EstimateService.ts');
const {
  rowDriftCheck, DURATION_RATIO_HIGH, DURATION_RATIO_LOW, ESTIMATE_COEF_KEYS,
} = await import('../server/src/services/estimate-engine.ts');
const {
  countWorkdaysBetween, isWorkday, fmtDate, parseYmd, buildCalendar,
} = await import('../server/src/util/workdays.ts');
/** 与 `server/src/util/workdays.ts` 同形状（动态 import 的解构里不能带 `type` 修饰符，故本地重写一份类型） */
type WorkdayCal = { holidays: Set<string>; overtime: Set<string> };

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 260)}` : ''}`);
  }
};
const near = (a: number, b: number, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;
const T = '2026-10-11T00:00:00.000Z';
const PID = 'p-e9';
const PANEL_SRC = readFileSync(join(ROOT, 'web', 'src', 'components', 'EstimatePanel.tsx'), 'utf8');
const API_SRC = readFileSync(join(ROOT, 'web', 'src', 'api', 'estimates.ts'), 'utf8');
const ROUTE_SRC = readFileSync(join(ROOT, 'server', 'src', 'routes', 'estimates.ts'), 'utf8');

/** 参照实现：§7 之前的逐日推进口径（正确但成本与日期跨度挂钩），只在本脚本里当尺子用 */
function refCount(from: string, to: string, cal: WorkdayCal): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 0;
  if (to < from) return 0;
  let n = 0;
  const d = parseYmd(from);
  for (;;) {
    const cur = fmtDate(d);
    if (cur > to) break;
    if (isWorkday(d, cal)) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

console.log('\n=== S 段：剩余排期/偏差判据的纯函数与红线守卫（同进程·不碰磁盘） ===');

// S-01 算术实现 vs 逐日参照：全周起点 × 0..40 天 × 7 种日历 全等
{
  const cals: Array<[string, WorkdayCal]> = [
    ['空日历', buildCalendar([])],
    ['工作日放假', buildCalendar([{ date: '2026-10-07', kind: 'holiday' }])],
    ['周末放假（本就非工作日）', buildCalendar([{ date: '2026-10-10', kind: 'holiday' }])],
    ['周末加班', buildCalendar([{ date: '2026-10-10', kind: 'overtime' }])],
    ['工作日加班（无假日可减）', buildCalendar([{ date: '2026-10-07', kind: 'overtime' }])],
    ['同日期既假又加班（加班优先）', buildCalendar([
      { date: '2026-10-10', kind: 'holiday' }, { date: '2026-10-10', kind: 'overtime' },
    ])],
    ['跨月长假 + 加班', buildCalendar([
      { date: '2026-10-01', kind: 'holiday' }, { date: '2026-10-02', kind: null },
      { date: '2026-10-03', kind: undefined }, { date: '2026-11-07', kind: 'overtime' },
    ])],
  ];
  const starts = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
  let cases = 0;
  const bad: string[] = [];
  for (const [label, cal] of cals) {
    for (const s of starts) {
      for (let k = 0; k <= 40; k++) {
        const d = parseYmd(s);
        d.setDate(d.getDate() + k);
        const e = fmtDate(d);
        cases += 1;
        if (countWorkdaysBetween(s, e, cal) !== refCount(s, e, cal)) bad.push(`${label} ${s}~${e}`);
      }
    }
  }
  ok(`S-01 剩余排期算术实现与逐日参照全等（${cases} 格：${starts.length} 个周起点 × 0..40 天 × ${cals.length} 种日历）`,
    bad.length === 0, bad.slice(0, 6));
}

// S-02 成本与日期跨度解耦（§7 逐行调用；一条 2099 年的排期不该把请求拖住）
{
  const cal = buildCalendar([{ date: '2030-05-06', kind: 'holiday' }, { date: '2031-05-10', kind: 'overtime' }]);
  const from = '2026-10-12';
  const to = '2099-12-31';
  const ref = refCount(from, to, cal);
  const t0 = Date.now();
  let v = -1;
  for (let i = 0; i < 2000; i++) v = countWorkdaysBetween(from, to, cal);
  const ms = Date.now() - t0;
  ok(`S-02 73 年跨度：值与参照全等（${ref}）且 2000 次调用 ${ms}ms（参照实现单次即需 ${ref > 0 ? Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / 86400000) : 0} 次日推进）`,
    v === ref && ms < 400, { v, ref, ms });
}

// S-03 边界契约：to<from→0、非法→0、单日含两端
{
  const cal = buildCalendar([]);
  ok('S-03 排期已过期（to<from）→ 0 而不是负数（负数会把「E>剩余」算成通过）',
    countWorkdaysBetween('2026-10-20', '2026-10-12', cal) === 0);
  ok('S-03b 非法/空日期 → 0（缺排期由调用方按「无排期」跳过，不凭空造冲突）',
    countWorkdaysBetween('', '2026-10-20', cal) === 0
    && countWorkdaysBetween('2026-10-20', null as unknown as string, cal) === 0
    && countWorkdaysBetween('2026/10/20', '2026-13-45', cal) === 0);
  const mon = countWorkdaysBetween('2026-10-05', '2026-10-05', cal);
  const sat = countWorkdaysBetween('2026-10-10', '2026-10-10', cal);
  ok('S-03c 区间含两端：周一单日=1、周六单日=0', mon === 1 && sat === 0, { mon, sat });
}

// S-04 rowDriftCheck 阈值边界（>1.5 / <0.67，等号不算偏差）
{
  const cal = buildCalendar([]);
  const mk = (e: number | null, dur: number | null) => rowDriftCheck(
    { expected: e, durationDays: dur, endDate: '2026-12-31', planKind: 'normal', planStatus: 'todo', planProgress: 0 },
    cal, '2026-10-12');
  const atHigh = mk(3, 2);   // 1.5 恰好
  const overHigh = mk(3.1, 2);
  const atLow = mk(1.34, 2); // 0.67 恰好
  const underLow = mk(1.3, 2);
  ok(`S-04 比值取 E÷排期工作日并保留两位；边界按「>」/「<」判，等号不标黄（高=${DURATION_RATIO_HIGH} 低=${DURATION_RATIO_LOW}）`,
    atHigh.ratio === 1.5 && atHigh.flag === null && overHigh.flag === 'high'
    && atLow.ratio === 0.67 && atLow.flag === null && underLow.flag === 'low',
    { atHigh, overHigh, atLow, underLow });
  const noEst = mk(null, 5);
  const noDur = mk(5, null);
  const zeroDur = mk(5, 0);
  ok('S-04b 未估算 / 无工期 / 工期 0 → 比值 null（未录入的行不标黄，也不被标成偏差）',
    noEst.ratio === null && noEst.flag === null && noDur.ratio === null && zeroDur.ratio === null,
    { noEst, noDur, zeroDur });
}

// S-05 只读判定与写路径闸门同一份定义（§7 v2.3：范围只含已收口里程碑）
{
  const cal = buildCalendar([]);
  const v = (kind: string, status: string, progress: number) =>
    ({ expected: 5, durationDays: 5, endDate: '2026-12-31', planKind: kind, planStatus: status, planProgress: progress });
  const cases: Array<[string, ReturnType<typeof v>, boolean]> = [
    ['里程碑 done', v('milestone', 'done', 60), true],
    ['里程碑 progress=100（status 未同步）', v('milestone', 'doing', 100), true],
    ['里程碑未收口', v('milestone', 'doing', 40), false],
    ['普通任务 done（四期 34/37 已收口行是里程碑，普通行完成不代表报价封板）', v('normal', 'done', 100), false],
  ];
  const bad = cases.filter(([_, input, want]) => {
    const got = rowDriftCheck(input, cal, '2026-10-12').locked;
    return got !== want || got !== isClosedMilestone(input);
  }).map(([n]) => n);
  ok(`S-05 locked 四项口径全对，且与 EstimateService.isClosedMilestone 逐条同值（引擎与闸门共用一份定义）`,
    bad.length === 0, bad);
}

// S-06 排期压力：E 人天 > 剩余排期工作日（含过期=0、无日期不参与）
{
  const hol = buildCalendar([{ date: '2026-10-14', kind: 'holiday' }, { date: '2026-10-17', kind: 'overtime' }]);
  const mk = (e: number | null, endDate: string) => rowDriftCheck(
    { expected: e, durationDays: 3, endDate, planKind: 'normal', planStatus: 'todo', planProgress: 0 }, hol, '2026-10-12');
  const tight = mk(10, '2026-10-16');
  const loose = mk(2, '2026-10-16');
  const expired = mk(5, '2026-10-01');
  const none = mk(5, '');
  // 2026-10-12(一)~10-16(五)：5 个工作日，扣 10-14 放假 = 4
  ok('S-06 剩余排期按日历真值扣假日：10-12~10-16 = 4 个工作日',
    tight.remainingWorkdays === 4 && loose.remainingWorkdays === 4, { remaining: tight.remainingWorkdays });
  ok('S-06b E > 剩余 → pressure；E ≤ 剩余 → 不报（同一行只差三点值，判据不含系数）',
    tight.pressure === true && loose.pressure === false, { tight, loose });
  ok('S-06c 排期过期 → 剩余 0 且 E>0 即压力（不是负数）；无排期日期 → null 且不参与压力判定',
    expired.remainingWorkdays === 0 && expired.pressure === true
    && none.remainingWorkdays === null && none.pressure === false, { expired, none });
  ok('S-06d 加班日计入剩余（10-17 周六上班）：10-12~10-17 = 5 个正常工作日 - 1 放假 + 1 加班',
    rowDriftCheck({ expected: 1, durationDays: 3, endDate: '2026-10-17', planKind: 'normal', planStatus: 'todo', planProgress: 0 },
      hol, '2026-10-12').remainingWorkdays === 5);
}

// S-07 红线守卫：判定与阈值只在服务端，面板只排版
{
  const CODE = PANEL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('S-07 面板代码体不含 1.5 / 0.67 字面量（阈值只能来自 `checks.drift.thresholds`）',
    !/1\.5/.test(CODE) && !/0\.67/.test(CODE),
    { hit15: /1\.5/.test(CODE), hit067: /0\.67/.test(CODE) });
  const calc = [
    /expected\s*\/\s*duration/,        // 比值自算
    /remainingWorkdays\s*[<>]/,        // 剩余排期自判
    /countWorkdays|addWorkdays/,       // 工作日算式镜像到面板
    /\boptimistic\s*\+\s*likely/,      // PERT 式子
    /likely\s*\*\s*4/,
  ].map((re) => re.source).filter((s) => new RegExp(s).test(CODE));
  ok('S-07b 面板不重算比值/剩余排期（§5.2 零计算红线在 §7 落地后仍然成立）', calc.length === 0, calc);
  ok('S-07c 只读解锁只传一个显式标志给服务端（真值判定在服务端 `unlockFlag`，面板不做静默放行）',
    /input\.unlock\s*=\s*true/.test(CODE) && /removeItem\([^)]*unlock:/.test(CODE),
    /unlock[^,\n]{0,40}/.exec(CODE)?.[0]);
  const ui: Array<[string, string]> = [
    ['§7 提示条（重导/压力/偏差/只读四行）', 'aria-label="估算变更影响提示"'],
    ['偏差徽标', '偏差 '],
    ['超排期徽标', '超排期'],
    ['只读徽标', '已收口·只读'],
    ['解锁改写入口', '解锁改写'],
    ['影响试算按钮', '影响试算'],
    ['试算零写入声明', '未写入任何数据'],
  ];
  const miss = ui.filter(([, s]) => !PANEL_SRC.includes(s)).map(([n]) => n);
  ok(`S-07d §7 承诺的界面要素全部存在（${ui.length} 项）`, miss.length === 0, miss);
  ok('S-07e API 层仍只有类型与请求收口（不含比值/剩余排期算式，也无第二次阈值）',
    !/1\.5|0\.67/.test(API_SRC.replace(/^\s*\*.*$/gm, '')) && !/countWorkdays/.test(API_SRC)
    && /drift:\s*RowDrift/.test(API_SRC) && /whatIf:/.test(API_SRC));
  ok('S-07f 服务端侧：判定在引擎、闸门在服务层、路由只喂数（三处各一份，无重复定义）',
    /rowDriftCheck\(/.test(ROUTE_SRC) && !/DURATION_RATIO_HIGH\s*=/.test(ROUTE_SRC)
    && /isClosedMilestone\(/.test(readFileSync(join(ROOT, 'server', 'src', 'services', 'EstimateService.ts'), 'utf8')));
  ok('S-07g what-if 与参数写入口共用同一份配置解析（试算能过的值真写不会被拒）',
    (ROUTE_SRC.match(/resolveEstimateConfig\(/g) ?? []).length >= 3
    && /written: 0/.test(ROUTE_SRC) && ROUTE_SRC.indexOf("'/what-if'") < ROUTE_SRC.indexOf("'/params'") + ROUTE_SRC.length);
  // S-07h 「可达性」守卫：`groupTimelinePhases`（T01621）把里程碑放在 `milestone` 字段而不是 `items`，
  // 而 §7 的只读判定**只对里程碑成立**——明细段如果只 map `group.items`，「已收口·只读」徽标与
  // 「解锁改写」按钮就成了永不渲染的死码（源码里字符串都在、S-07d 照过，界面却一点都摸不到）。
  // 这条断言把「渲染列表里含里程碑自己的行」钉住，是 S-07d 的唯一有效补强。
  ok('S-07h 里程碑自身的估算行进入明细渲染列表（否则 §7 只读徽标/解锁在面板里不可达）',
    /\[\s*msRow\s*,\s*\.\.\.group\.items\.map/.test(CODE) && !/!collapsed && group\.items\.map/.test(CODE),
    { msRowFirst: /\[\s*msRow\s*,\s*\.\.\.group\.items\.map/.test(CODE), oldItemsOnly: /!collapsed && group\.items\.map/.test(CODE) });
  ok('S-07h2 解锁后的里程碑行仍不参与批量填充（§4.6 红线一：勾选框对里程碑恒禁用，与只读态无关）',
    /disabled=\{r\.kind === 'milestone' \|\| !editable\}/.test(CODE));
}

console.log('\n=== R 段：隔离实例 REST（三条写通道 + 试算 + 重导提示） ===');

// 夹具：直接写隔离测试库（不经 REST，也不碰生产）
initSchema();
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, 'T02046-变更影响分析', '', T, T);

const TODAY = fmtDate(new Date());
const dayOffset = (n: number): string => {
  const d = parseYmd(TODAY);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
};

const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids)
   VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, NULL, NULL)`,
);
type Seed = [id: string, title: string, dur: number, kind: string, status: string, progress: number, end: string];
const seeds: Seed[] = [
  ['ms-done', 'M9 收口里程碑', 10, 'milestone', 'done', 100, dayOffset(30)],
  ['ms-open', 'M10 未收口里程碑', 6, 'milestone', 'doing', 40, dayOffset(20)],
  ['pl-high', '偏差-偏高', 2, 'normal', 'todo', 0, dayOffset(40)],
  ['pl-low', '偏差-偏低', 20, 'normal', 'todo', 0, dayOffset(40)],
  ['pl-ok', '偏差-正常', 5, 'normal', 'todo', 0, dayOffset(40)],
  ['pl-tight', '排期吃紧', 3, 'normal', 'todo', 0, dayOffset(2)],
  ['pl-expired', '排期已过期', 3, 'normal', 'doing', 50, dayOffset(-3)],
  ['pl-nodate', '无排期日期', 3, 'normal', 'todo', 0, ''],
  ['pl-unest', '未估算的行', 4, 'normal', 'todo', 0, dayOffset(15)],
];
seeds.forEach(([id, title, dur, kind, status, progress, end], i) => {
  // start_date 是 NOT NULL 列，无排期日期的夹具用「今天 + 空 end_date」表达（§7 关心的是 end_date 缺失）
  insPlan.run(id, PID, title, end || TODAY, end, dur, progress, status, String(10 + i), T, T, kind);
});

const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, ?, ?, ?)`,
);
// (O + 4M + P) / 6 → E：15 / 2 / 4 / 10 / 10 / 4 / —
insEst.run('e-ms', PID, 'ms-done', 'impl', 3, 5, 9, 'manual', '收口里程碑的报价行', T, T);
insEst.run('e-ms-open', PID, 'ms-open', 'req', 2, 3, 4, 'manual', '未收口里程碑的行（§7 不该锁它）', T, T);
insEst.run('e-high', PID, 'pl-high', 'dev', 10, 15, 20, 'rule', 'E=15 / 工期 2', T, T);
insEst.run('e-low', PID, 'pl-low', 'design', 1, 2, 3, 'rule', 'E=2 / 工期 20', T, T);
insEst.run('e-ok', PID, 'pl-ok', 'dev', 3, 4, 5, 'rule', 'E=4 / 工期 5', T, T);
insEst.run('e-tight', PID, 'pl-tight', 'dev', 8, 10, 12, 'rule', 'E=10，排期只剩几天', T, T);
insEst.run('e-expired', PID, 'pl-expired', 'dev', 3, 4, 5, 'rule', 'E=4，排期已过', T, T);

closeDb();
const tsxPath = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child: ChildProcess = spawn(process.execPath, [tsxPath, join(ROOT, 'server', 'src', 'index.ts')], {
  cwd: ROOT,
  env: { ...process.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

const BASE = `http://127.0.0.1:${PORT}`;
async function waitForServer(ms = 45_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as Record<string, any> };
}
const qs = `projectId=${PID}`;
type Item = Record<string, any> & { drift: Record<string, any> };
const get = async (): Promise<Record<string, any>> => (await api('GET', `/estimates?${qs}`)).json;
const itemOf = (data: Record<string, any>, planId: string): Item | undefined =>
  (data.items as Item[]).find((i) => i.plan_id === planId);

if (!(await waitForServer())) {
  ok('R-00 隔离服务启动', false, serverLog.join('').slice(-400));
  child.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
ok('R-00 隔离服务启动（临时端口 + 临时库）', true);

// R-01 行级 drift 随 items 下发，checks.drift 的四个计数与逐行统计同源
{
  const data = await get();
  const items = data.items as Item[];
  const allHaveDrift = items.every((i) => i.drift && typeof i.drift.locked === 'boolean' && 'ratio' in i.drift
    && 'remainingWorkdays' in i.drift && 'pressure' in i.drift);
  ok('R-01 GET /api/estimates 每行都带 drift 四字段（面板零计算的正面条件）', allHaveDrift,
    items.find((i) => !i.drift)?.plan_id);
  const c = data.checks.drift;
  const count = (f: (i: Item) => boolean) => items.filter(f).length;
  ok('R-01b checks.drift 的 high/low/locked/pressure = 逐行统计（同一个数，不是第二套口径）',
    c.high === count((i) => i.drift.flag === 'high') && c.low === count((i) => i.drift.flag === 'low')
    && c.locked === count((i) => i.drift.locked) && c.pressure === count((i) => i.drift.pressure)
    && c.today === TODAY && c.thresholds.high === DURATION_RATIO_HIGH && c.thresholds.low === DURATION_RATIO_LOW,
    { c, high: count((i) => i.drift.flag === 'high'), locked: count((i) => i.drift.locked) });
  const high = itemOf(data, 'pl-high')!, low = itemOf(data, 'pl-low')!, mid = itemOf(data, 'pl-ok')!;
  ok('R-01c 偏差徽标逐行对号：E=15/工期2 → 7.5 偏高；E=2/工期20 → 0.1 偏低；E=4/工期5 → 0.8 不标',
    high.drift.ratio === 7.5 && high.drift.flag === 'high'
    && low.drift.ratio === 0.1 && low.drift.flag === 'low'
    && mid.drift.ratio === 0.8 && mid.drift.flag === null,
    { high: high.drift, low: low.drift, mid: mid.drift });
  const unest = itemOf(data, 'pl-unest');
  ok('R-01d 未估算的行根本不进 items（左联以估算表为主表），也就不会被标成偏差',
    unest === undefined, unest?.plan_id);
  const noDate = itemOf(data, 'pl-nodate');
  ok('R-01e 无排期日期行不在估算表里（同上），有过期行则剩余排期给 0 而不是负数',
    noDate === undefined || (noDate.drift.remainingWorkdays === null && noDate.drift.pressure === false),
    noDate?.drift);
  const exp = itemOf(data, 'pl-expired')!;
  ok('R-01f 排期已过期 → 剩余 0 个工作日 + 计入压力行',
    exp.drift.remainingWorkdays === 0 && exp.drift.pressure === true, exp.drift);
  const tight = itemOf(data, 'pl-tight')!;
  ok('R-01g 排期吃紧行 E=10 > 剩余工作日 → pressure',
    tight.drift.pressure === true && tight.drift.remainingWorkdays !== null
    && 10 > (tight.drift.remainingWorkdays as number), tight.drift);
}

// R-02/R-03/R-04 只读闸门：PATCH / DELETE / batch 三条写通道
{
  const data = await get();
  const msDone = itemOf(data, 'ms-done')!;
  const msOpen = itemOf(data, 'ms-open')!;
  ok('R-02 只有「已收口里程碑」被置只读，未收口里程碑不因 §7 锁定（§4.6 的里程碑不重复计是另一条规则）',
    msDone.drift.locked === true && (msOpen.drift?.locked ?? false) === false,
    { done: msDone.drift.locked, open: msOpen.drift?.locked });

  const locked = await api('PATCH', `/estimates/ms-done?${qs}`, { likely: 99 });
  ok('R-03 收口里程碑 PATCH → 400，错误文案点名「已收口/只读/§7」',
    locked.status === 400 && /已收口/.test(locked.json.error ?? '') && /只读/.test(locked.json.error ?? ''),
    locked.json);
  const afterLocked = await get();
  ok('R-03b 被拒的 PATCH 零写入（三点仍是 3/5/9，不是把 99 写进去再报错）',
    (() => {
      const it = itemOf(afterLocked, 'ms-done')!;
      return it.optimistic === 3 && it.likely === 5 && it.pessimistic === 9 && it.source === 'manual';
    })(), itemOf(afterLocked, 'ms-done'));

  const del = await api('DELETE', `/estimates/ms-done?${qs}`);
  ok('R-04 删除同受闸门管（「改不动就删了重建」会让只读化形同虚设）',
    del.status === 400 && /只读/.test(del.json.error ?? ''), del.json);
}

// R-05 显式解锁：unlock 的假值不放行，真值才放行，且只放行这一条请求
{
  const falsyCases: Array<[string, unknown]> = [
    ['未给 unlock', undefined], ['unlock=false', false], ['unlock=0', 0], ['unlock=""', ''], ['unlock="false"', 'false'],
  ];
  const bad: string[] = [];
  for (const [label, value] of falsyCases) {
    const r = await api('PATCH', `/estimates/ms-done?${qs}`,
      value === undefined ? { likely: 7 } : { likely: 7, unlock: value });
    if (r.status === 200) bad.push(label);
  }
  ok('R-05 unlock 假值（未给/false/0/空串/字符串 false）一律不放行——只有显式真值才改写',
    bad.length === 0, bad);
  const on = await api('PATCH', `/estimates/ms-done?${qs}`, { likely: 7, unlock: true });
  ok('R-05b unlock:true（body）放行并落库——面板「解锁改写」就是走这条通道',
    on.status === 200 && on.json.item?.likely === 7, on.json);
  await api('PATCH', `/estimates/ms-done?${qs}`, { likely: 7, unlock: true });
  const again = await api('PATCH', `/estimates/ms-done?${qs}`, { likely: 6 });
  ok('R-05c 下一条不带 unlock 的请求仍然被拒（服务端不保存「已解锁」状态，解锁是一次性的）',
    again.status === 400 && (itemOf(await get(), 'ms-done'))?.likely === 7, again.json);
  const qUnlock = await api('PATCH', `/estimates/ms-done?${qs}&unlock=1`, { likely: 8 });
  ok('R-05d PATCH 的 unlock 只认 body（query 上的 `unlock=1` 不算放行——写意图必须显式在请求体里，不能被 URL 侧信道带上）',
    qUnlock.status === 400 && (itemOf(await get(), 'ms-done'))?.likely === 7, qUnlock.json);
  const delOk = await api('DELETE', `/estimates/ms-done?${qs}&unlock=1`);
  ok('R-05e DELETE 没有 body 约定，`unlock=1` 走 query 同样被 `unlockFlag` 认真值并回传 removed=true',
    delOk.status === 200 && delOk.json.removed === true, delOk.json);
  const gone = itemOf(await get(), 'ms-done');
  ok('R-05f 删除后该行整条从明细消失（不是留一行 0/0/0 的假数据）',
    gone === undefined, gone);
  // 恢复：后续断言还要用这条收口行
  await api('PATCH', `/estimates/ms-done?${qs}`, { optimistic: 3, likely: 5, pessimistic: 9, source: 'manual', unlock: true });
}

// R-06 batch 三条腿：混入锁定行零写入；全 unlock 才整批落；derive 不碰里程碑
{
  const mixed = await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set',
    items: [{ planId: 'pl-ok', likely: 4.5 }, { planId: 'ms-done', likely: 8 }],
  });
  const mixedErr = (mixed.json.errors as Array<Record<string, any>>) ?? [];
  ok('R-06 batch mode=set 混入收口里程碑 → written=0 + 行级错误点名 index/planId（其余行也不写）',
    mixed.json.written === 0 && mixedErr.length === 1 && mixedErr[0].planId === 'ms-done'
    && mixedErr[0].index === 1 && /只读/.test(mixedErr[0].message)
    && (itemOf(await get(), 'pl-ok'))?.likely === 4,
    mixed.json);
  const allUnlock = await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set',
    items: [{ planId: 'pl-ok', likely: 4.5 }, { planId: 'ms-done', likely: 8, unlock: true }],
  });
  ok('R-06b 逐行 unlock 后整批写入（批量通道不引入「全局解锁」这种绕过态）',
    allUnlock.json.written === 2 && (allUnlock.json.errors as unknown[])?.length === 0
    && (itemOf(await get(), 'ms-done'))?.likely === 8, allUnlock.json);
  await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set', items: [{ planId: 'pl-ok', likely: 4 }, { planId: 'ms-done', likely: 5, unlock: true }],
  });
  const derive = await api('POST', '/estimates/derive', { projectId: PID, dryRun: true, scope: 'all' });
  const msItems = (derive.json.items as Array<Record<string, any>>).filter((i) => i.kind === 'milestone');
  const msSkip = (derive.json.skipped as Array<Record<string, any>>).filter((s) => s.skip === 'milestone');
  ok('R-06c 推导预览不写里程碑行（§4.6 红线在前，§7 闸门不会误伤批量推导）',
    msItems.every((i) => i.writable === false) && msSkip.length >= 2,
    { items: msItems.map((i) => [i.planId, i.skip, i.writable]), skipped: msSkip.map((i) => i.planId) });
}

// R-07/R-08/R-09 影响试算：零写入、Δ% 自洽、参数校验同尺子
{
  const before = await get();
  const beforeActual = before.summary.actualManMonths.expected as number;
  const r = await api('POST', '/estimates/what-if', { projectId: PID, coefs: { schedule: 1 } });
  const j = r.json;
  ok('R-07 试算返回 before/after/delta/applied 四段且 written=0',
    r.status === 200 && j.before && j.after && j.delta && j.applied && j.written === 0
    && JSON.stringify(j.applied.coefs) === JSON.stringify(['schedule']), j.applied);
  ok('R-07b 系数只放大「实际预估人月」，不改「直接投入人天」（试算不会把 ΣE 洗掉）',
    j.delta.directManDays === 0 && near(j.before.directManDays, j.after.directManDays)
    && j.after.actualManMonths > beforeActual, { delta: j.delta, before: j.before.actualManMonths });
  ok('R-07c delta.pct 与 delta/before 自洽（面板显示「X → Y（Δ·%）」时不用自己再除一次）',
    near(j.delta.pct as number, (j.delta.actualManMonths / j.before.actualManMonths) * 100, 0.02),
    { pct: j.delta.pct, delta: j.delta.actualManMonths, before: j.before.actualManMonths });
  ok('R-07d 逐阶段 delta 与合计同向（phases 里非零项之和 = directManDays 变化）',
    (j.delta.phases as Array<Record<string, any>>).every((p) => near(p.delta, p.after - p.before, 1e-6))
    && (j.delta.phases as Array<Record<string, any>>).filter((p) => p.delta !== 0).length === 0,
    j.delta.phases);

  const rowsReq = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'pl-high', optimistic: 100, likely: 120, pessimistic: 200 }],
  });
  ok('R-08 行级三点覆盖走同一份汇总（改一行 → ΣE 变、系数放大后的人月也变）',
    rowsReq.status === 200 && rowsReq.json.delta.directManDays > 0
    && rowsReq.json.after.directManDays > rowsReq.json.before.directManDays
    && JSON.stringify(rowsReq.json.applied.rows) === JSON.stringify(['pl-high']),
    { delta: rowsReq.json.delta, applied: rowsReq.json.applied });

  const afterTry = await get();
  ok('R-08b 两次试算后库里的汇总与试算前逐字相同（「不落库」不是文案而是事实）',
    afterTry.summary.actualManMonths.expected === beforeActual
    && (itemOf(afterTry, 'pl-high'))?.likely === 15,
    { after: afterTry.summary.actualManMonths.expected, before: beforeActual });

  const badCoef = await api('POST', '/estimates/what-if', { projectId: PID, coefs: { whatever: 0.5 } });
  ok('R-09 未知系数名 → 400 并列出可用档（不静默忽略）',
    badCoef.status === 400 && /未知调节系数/.test(badCoef.json.error ?? '') && /schedule/.test(badCoef.json.error ?? ''),
    badCoef.json);
  const badRange = await api('POST', '/estimates/what-if', { projectId: PID, coefs: { schedule: 9 } });
  const badRange2 = await api('PUT', '/estimates/params', { projectId: PID, settings: { 'estimate.coef.schedule': '9' } });
  ok('R-09b 试算的参数范围与 PUT /params 同一把尺子（同一个越界值两边都拒、文案同源）',
    badRange.status === 400 && badRange2.status === 400
    && /不得大于 1/.test(badRange.json.error ?? '')
    && /不得大于 1/.test(badRange2.json.error ?? ''),
    { whatIf: badRange.json, params: badRange2.json });
  const badPts = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'pl-high', optimistic: 20, likely: 10, pessimistic: 30 }],
  });
  ok('R-09c 试算行也过 pointsError（O>M 在 PATCH 里怎么拒，在试算里就怎么拒）',
    badPts.status === 400 && /pl-high/.test(badPts.json.error ?? ''), badPts.json);
  const badRow = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'no-such-plan', optimistic: 1, likely: 2, pessimistic: 3 }],
  });
  ok('R-09d 试算行必须属于该项目在架计划（不认任意 planId，避免拿别的项目的数试算）',
    badRow.status === 400 && /不属于该项目/.test(badRow.json.error ?? ''), badRow.json);
  const lockedTry = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'ms-done', optimistic: 3, likely: 400, pessimistic: 900 }],
  });
  ok('R-09e 收口里程碑可以「试算」但不能落库——试算通道写 0 条，闸门不因此放宽',
    lockedTry.status === 200 && lockedTry.json.written === 0
    && (itemOf(await get(), 'ms-done'))?.likely === 5, { status: lockedTry.status });
}

// R-10 §7 的剩余排期读的是 holidays 表真值（而不是「日历日 × 5/7」的近似）
// 注意：改日历会触发 PlanService.rescheduleFromDate 顺延排期，所以这里不能拿「同一天少 1」当判据——
// 判据是「服务端报的剩余排期 = 以当前 end_date + 当前日历逐日推进的参照值」，对全表逐行成立。
{
  const listEmpty = await api('GET', '/plans/holidays');
  ok('R-10a 隔离库初始无日历记录（下面的对照不受外部数据干扰）',
    listEmpty.status === 200 && Array.isArray(listEmpty.json) && (listEmpty.json as unknown[]).length === 0,
    listEmpty.json);

  const calOf = async (): Promise<WorkdayCal> => {
    const rows = (await api('GET', '/plans/holidays')).json as unknown as Array<{ date: string; kind?: string | null }>;
    return buildCalendar(rows);
  };
  /** 全表交叉核对：服务端报的剩余排期与「当前 end_date + 当前日历」的逐日参照逐行相等 */
  const crossCheck = async (): Promise<{ n: number; bad: string[] }> => {
    const cal = await calOf();
    const items = (await get()).items as Item[];
    const bad: string[] = [];
    let n = 0;
    for (const i of items) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.endDate || ''))) continue;
      n += 1;
      const want = refCount(TODAY, String(i.endDate), cal); // 过期区间在参照里同样是 0
      if (i.drift.remainingWorkdays !== want) bad.push(`${i.plan_id}: ${i.drift.remainingWorkdays} ≠ ${want}`);
    }
    return { n, bad };
  };
  const first = await crossCheck();
  ok(`R-10b 空日历下全表 ${first.n} 行的剩余排期与逐日参照全等`, first.bad.length === 0, first.bad.slice(0, 5));

  const tightBefore = itemOf(await get(), 'pl-tight')!;
  const add = await api('POST', '/plans/holidays', { date: tightBefore.endDate, name: '§7 日历真值取证', kind: 'holiday' });
  const second = await crossCheck();
  const tightAfter = itemOf(await get(), 'pl-tight')!;
  ok(`R-10c 把「今天之后第一个工作日」置为放假日后：接口收下、全表逐行仍与参照全等（服务端每次请求重读日历，无缓存态）`,
    add.status === 200 && second.n === first.n && second.bad.length === 0
    && tightAfter.drift.remainingWorkdays === refCount(TODAY, String(tightAfter.endDate), await calOf()),
    { bad: second.bad.slice(0, 5), before: tightBefore.drift.remainingWorkdays, after: tightAfter.drift.remainingWorkdays });
  ok('R-10d 日历改动的连带效应被 §7 如实反映（end_date 被 rescheduleFromDate 顺延 → 剩余排期按新排期报，不是按旧日期）',
    tightAfter.endDate !== tightBefore.endDate || tightAfter.drift.remainingWorkdays !== tightBefore.drift.remainingWorkdays,
    { endBefore: tightBefore.endDate, endAfter: tightAfter.endDate });

  const ot = await api('POST', '/plans/holidays', { date: dayOffset(6), name: '§7 加班日取证', kind: 'overtime' });
  const third = await crossCheck();
  ok('R-10e 加班日(kind=overtime)进同一张表后仍全等（周末加班被算进剩余排期，与放假日两条语义互不干扰）',
    ot.status === 200 && third.bad.length === 0, third.bad.slice(0, 5));
  // 清理按「表里还有什么」逐条删，而不是按「我以为写了哪两条」——排期顺延会让被记下的日期已经不是当初那条
  const left = (await api('GET', '/plans/holidays')).json as unknown as Array<{ date: string }>;
  for (const r of left) await api('DELETE', `/plans/holidays/${encodeURIComponent(r.date)}`);
  const fourth = await crossCheck();
  const cleared = (await api('GET', '/plans/holidays')).json as unknown[];
  ok('R-10f 撤掉全部日历记录后回到空日历，全表参照仍然全等',
    cleared.length === 0 && fourth.bad.length === 0, { cleared: cleared.length, bad: fourth.bad.slice(0, 5) });
}

// R-11 重导提示：无快照 → 空；导出后归零；改计划/改估算分别点名；再导出取最近一条
{
  const none = (await get()).checks.changedSinceExport;
  ok('R-11 无快照时 changedSinceExport 给空结构（count=0 / snapshotId=null），而不是报错',
    none.count === 0 && none.snapshotId === null && none.at === '' && (none.rows as unknown[]).length === 0, none);

  const exp1 = await fetch(`${BASE}/api/estimates/export-xlsx?${qs}`);
  const s1 = exp1.headers.get('x-estimate-snapshot') ?? '';
  const fresh = (await get()).checks.changedSinceExport;
  ok('R-11b 刚导完 → 重导提示归零（count=0），面板那条提示随之消失而不是长亮',
    exp1.status === 200 && s1 !== '' && fresh.snapshotId === s1 && fresh.count === 0,
    { status: exp1.status, s1, fresh });

  const touched = await api('PATCH', `/estimates/pl-low?${qs}`, { pessimistic: 3.5 });
  const afterEst = (await get()).checks.changedSinceExport;
  const lowRow = (afterEst.rows as Array<Record<string, any>>).find((r) => r.planId === 'pl-low');
  ok('R-11c 只改估算（O/M/P）也被点名 changed 含 estimate——只查计划会漏掉最该重导的情况',
    touched.status === 200 && afterEst.count === 1 && lowRow !== undefined
    && JSON.stringify(lowRow.changed) === JSON.stringify(['estimate']) && lowRow.estimateUpdatedAt > fresh.at,
    { count: afterEst.count, lowRow });

  const planTouched = await api('PATCH', '/plans/pl-ok', { title: '偏差-正常（导出后改的标题）' });
  const afterPlan = (await get()).checks.changedSinceExport;
  const okRow = (afterPlan.rows as Array<Record<string, any>>).find((r) => r.planId === 'pl-ok');
  ok('R-11d 只改计划侧字段也被点名 changed 含 plan（连同上一轮共 2 行）',
    planTouched.status === 200 && afterPlan.count === 2 && okRow !== undefined
    && JSON.stringify(okRow.changed) === JSON.stringify(['plan']) && typeof okRow.estimateUpdatedAt === 'string',
    { count: afterPlan.count, okRow });

  // 「导出后又排了期、还没录估算」是最常见的一类变更，`plansForDrift` 用 LEFT JOIN 就是为它开的
  await api('PATCH', '/plans/pl-unest', { title: '未估算的行（导出后排期改动）' });
  const afterUnest = (await get()).checks.changedSinceExport;
  const unestRow = (afterUnest.rows as Array<Record<string, any>>).find((r) => r.planId === 'pl-unest');
  ok('R-11d2 尚无估算行的计划也被点名（estimateUpdatedAt=null 不参与比较，而不是被整行漏掉）',
    afterUnest.count === 3 && unestRow !== undefined && unestRow.estimateUpdatedAt === null
    && JSON.stringify(unestRow.changed) === JSON.stringify(['plan']),
    { count: afterUnest.count, unestRow });

  const exp2 = await fetch(`${BASE}/api/estimates/export-xlsx?${qs}&scope=estimated_only`);
  const s2 = exp2.headers.get('x-estimate-snapshot') ?? '';
  const again = (await get()).checks.changedSinceExport;
  ok('R-11e 第二次导出后「上次导出」取最近一条而不是最早一条，提示再次归零',
    exp2.status === 200 && s2 !== '' && s2 !== s1 && again.snapshotId === s2 && again.count === 0,
    { s1, s2, snapshotId: again.snapshotId, count: again.count });

  const both = await api('PATCH', '/plans/pl-high', { title: '偏差-偏高（同名双改）' });
  await api('PATCH', `/estimates/pl-high?${qs}`, { optimistic: 9 });
  const bothRow = ((await get()).checks.changedSinceExport.rows as Array<Record<string, any>>)
    .find((r) => r.planId === 'pl-high');
  ok('R-11f 两侧都改过的行 changed 同时含 plan 与 estimate（提示文案能点名「改了哪一侧」）',
    both.status === 200 && JSON.stringify(bothRow?.changed) === JSON.stringify(['plan', 'estimate']), bothRow);

  const snaps = await api('GET', `/estimates/snapshots?${qs}&limit=5`);
  const ids = (snaps.json.snapshots as Array<Record<string, any>>).map((s) => s.id);
  ok('R-11g 点名所依据的「最近一条」与快照列表首条同 id（同一份数据，不是提示与列表各查各的）',
    ids.length >= 2 && ids[0] === s2 && ids[1] === s1, ids);
}

// R-12 归档计划不进 drift 统计（§3.1 B5 视图层过滤在 §7 落地后仍然成立）
{
  const arc = await api('POST', '/plans/pl-expired/archive', {});
  const data = await get();
  const visible = (data.items as Item[]).filter((i) => i.plan_id === 'pl-expired');
  const arch = await api('GET', `/estimates?${qs}&includeArchived=1`);
  const withArchived = (arch.json.items as Item[]).filter((i) => i.plan_id === 'pl-expired');
  ok('R-12 归档计划的估算行默认不出现在明细里，includeArchived=1 才带出来（且仍带 drift 字段）',
    arc.status === 200 && visible.length === 0 && withArchived.length === 1
    && typeof withArchived[0].drift.remainingWorkdays === 'number',
    { visible: visible.length, withArchived: withArchived.length, drift: withArchived[0]?.drift });
  /** checks.drift 的四个计数必须等于「同一视图 items」的逐行统计（默认视图与含归档视图都成立） */
  const countsMatch = (payload: Record<string, any>): boolean => {
    const its = payload.items as Item[];
    const c = payload.checks.drift;
    const n = (f: (i: Item) => boolean) => its.filter(f).length;
    return c.high === n((i) => i.drift.flag === 'high') && c.low === n((i) => i.drift.flag === 'low')
      && c.locked === n((i) => i.drift.locked) && c.pressure === n((i) => i.drift.pressure);
  };
  ok('R-12b checks.drift 与 items 同筛选范围：两个视图各自的计数都对得上自己的逐行统计',
    countsMatch(data) && countsMatch(arch.json),
    { now: data.checks.drift, all: arch.json.checks.drift });
  await api('POST', '/plans/pl-expired/restore', {});
}

const logText = serverLog.join('');
ok('R-13 服务日志无 §7/试算相关异常',
  !/estimates[\s\S]{0,200}(Error|异常|unhandled|TypeError)/i.test(logText) && !/UnhandledPromiseRejection/.test(logText),
  logText.split('\n').filter((l) => /error|异常|typeerror/i.test(l)).slice(0, 3));

child.kill();
await new Promise((r) => setTimeout(r, 600));
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nPASS=${pass} FAIL=${fail}`);
console.log(`（系数档清单：${ESTIMATE_COEF_KEYS.join(' / ')}）`);
process.exit(fail === 0 ? 0 : 1);
