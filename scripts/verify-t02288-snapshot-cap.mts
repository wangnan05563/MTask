/**
 * T02288 门：大树符号索引快照帽（方案 A 20000 → 50000）+ 撞帽可观测性（capHit 告警）。
 *
 * 用法：`TMP=<D 盘目录> TEMP=<D 盘目录> node node_modules/tsx/dist/cli.mjs scripts/verify-t02288-snapshot-cap.mts`
 *   ⚠ 临时目录必须在 D 盘：C 盘常年 0 可用，DATA_DIR 落 C: 会得到 SQLITE_FULL 假性失败。
 *   ⚠ better-sqlite3 预编译产物须与当前 Node ABI 匹配（本机 node24/ABI137 可直跑 src），
 *     与 verify-t02034-estimate-e1.mts 同族写法：本门**不起服务实例**，全部走同进程生产实现。
 *
 * 覆盖面（与任务单「必须一起做的验证」逐条对齐）：
 *   W-A 帽值单一来源与生效帽（默认为 50000、env 可注入小帽、非法值回落）
 *   W-B 深扫登记 + 热刷短路收益（不撞帽时 shortCircuited=true、skipped 如实等于上次候选文件数、零撞帽告警）
 *   W-C 撞帽 → 快照不登记 → 短路对该树永久失效，且 capHit 告警**恰出现一次**（去重生效）
 *   W-D 帽恢复后重新登记 → 短路复活（证明去重位会复位，不是一条日志永久静音）
 *   W-E 结构变化（新增目录）→ 短路失效退回深扫，下一轮再复活（防止提帽把正确性藏起来）
 *   W-F 真树（bemp 24,866 目录）帽差异复测：50000 不撞帽、20000 必撞帽——方案 A 的必要性证据；
 *       树不在位则如实 SKIP 并在末行计入未覆盖面。
 *   W-G 负对照（判据 4）：告警计数器自身的牙齿（哨兵必被数到）+ 同一棵树换帽即换结论
 *
 * 断言口径（docs/验收门判据规约.md）：产品中文文案不抄第二份——撞帽告警的**词干**读自
 *   生产源码里的那一条模板串（用正则从 `noteCapHit` 的实现里取），门只断言「告警存在、
 *   按 projectId 计数恰一次、且带 dirs/cap/workspace 三个字段」；文案改写由 okPair 的
 *   「字面锚点失配（行为在）」红因承接，不由本门擅自判红。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { okPair } from './lib/anchor-pair.mts';
import { gateShotsDir, writeGateResults } from './lib/gate-results.mts'; // T02287 命名口径：结果文件带运行标识，并发跑门不互覆

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---- 隔离纪律：环境变量必须早于任何 getDb() 落盘 ----
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02288-cap-'));
const TREE_ROOT = join(DATA_DIR, 'trees');
process.env.MTask_DATA_DIR = DATA_DIR;
delete process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS; // 门自己管帽，不吃调用环境的注入值

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const WS = await import('../server/src/services/WorkspaceService.ts');
const { WorkspaceService, SYMBOL_SNAPSHOT_MAX_DIRS, snapshotMaxDirs, buildDirSnapshot, loadIgnoreRules } = WS;

initSchema();

let pass = 0;
let fail = 0;
let skip = 0;
const lines: string[] = []; // 逐条落进结果文件（T02287：stdout 空/被覆写时仍有可复核证据）
const ok = (name: string, cond: boolean, extra?: unknown) => {
  const detail = extra !== undefined ? ` → ${JSON.stringify(extra).slice(0, 400)}` : '';
  lines.push(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : detail}`);
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else {
    fail += 1;
    console.log(`  [FAIL] ${name}${detail}`);
  }
};
const sk = (name: string, why: string) => { skip += 1; lines.push(`SKIP ${name} → ${why}`); console.log(`  [SKIP] ${name} → ${why}`); };

/** 告警捕获：产品用 console.warn 落日志（LogService 环形缓冲同源），门替装计数，不改行为 */
const warns: string[] = [];
const realWarn = console.warn.bind(console);
console.warn = (...a: unknown[]) => { warns.push(a.map((x) => String(x)).join(' ')); };
const say = (...a: unknown[]) => realWarn(...a);
process.on('exit', () => { console.warn = realWarn; });
/** 某项目的撞帽告警条数——按 projectId 归集，跨项目互不掩盖 */
const capHitsFor = (projectId: string) =>
  warns.filter((w) => /dirs=\d+[^\n]*cap=\d+/.test(w) && w.includes(`project=${projectId}`)).length;
/** 取一条该产品告警里的字段值（不抄文案词干，只验「字段在位」） */
const fieldsOf = (projectId: string) => {
  const line = warns.find((w) => w.includes(`project=${projectId}`) && /cap=\d+/.test(w)) ?? '';
  const num = (k: string) => {
    const m = line.match(new RegExp(`${k}=(\\d+)`));
    return m ? Number(m[1]) : NaN;
  };
  return { dirs: num('dirs'), cap: num('cap'), hasWorkspace: line.includes('workspace=') };
};

// ---- 夹具树：N 个目录 × 每目录 M 个 .ts（每文件 1 个 function 符号）----
function makeTree(name: string, dirs: number, filesPerDir: number): string {
  const root = join(TREE_ROOT, name);
  mkdirSync(root, { recursive: true });
  for (let d = 0; d < dirs; d++) {
    const dir = join(root, `mod${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < filesPerDir; f++) {
      writeFileSync(join(dir, `f${f}.ts`), `export function fn_${d}_${f}(x: number) { return x + ${d}; }\n`);
    }
  }
  return root;
}
const ALL_PIDS: string[] = []; // 收口时逐个 clearSymbols：关监视器 + 撤快照，避免句柄拖住临时目录
function newProject(name: string, workspace: string): string {
  const id = `${name}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run(id, name, 'T02288 门夹具', now, now);
  db.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(workspace, id);
  ALL_PIDS.push(id);
  return id;
}
/** 走完一整轮（小树给足内联预算，避免 deferred 后台续跑把断言时序拖成不确定） */
const INL: number = 120_000;
const round = (pid: string) => WorkspaceService.refreshSymbols(pid, INL);
/** 本轮走到的候选文件数：mtime 未变的文件计入 skipped 而非 files，两轮之间必须按合计比 */
const walked = (r: { files: number; skipped: number }) => r.files + r.skipped;

// 目录数 = 根 + dirs。帽注入值按此算：撞帽只需 dirs+1 > cap
const DIRS_A = 10, FILES_A = 24; // 240 文件 ≥ SYMBOL_FAST_PATH_MIN_FILES(200)，短路才有资格
const DIRS_C = 10, FILES_C = 24;

// ================= W-A 帽值单一来源与生效帽 =================
const srcWs = readFileSync(join(ROOT, 'server', 'src', 'services', 'WorkspaceService.ts'), 'utf8');
ok('W-A01 生效帽默认值即方案 A 的 50000（env 未注入）', snapshotMaxDirs() === 50000 && SYMBOL_SNAPSHOT_MAX_DIRS === 50000,
  { got: snapshotMaxDirs(), constVal: SYMBOL_SNAPSHOT_MAX_DIRS });
process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS = '7';
ok('W-A02 env 注入小帽生效（门靠这条复现撞帽分支，不必造 2 万个目录）', snapshotMaxDirs() === 7, { got: snapshotMaxDirs() });
ok('W-A03 env=0 / 负数 / 非数一律回落默认（一个笔误不许关掉护栏）',
  (() => {
    const back: number[] = [];
    for (const bad of ['0', '-5', 'abc', '']) { process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS = bad; back.push(snapshotMaxDirs()); }
    return back.every((v) => v === 50000);
  })(), { fallbacks: ['0', '-5', 'abc', ''].map((b) => { process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS = b; return snapshotMaxDirs(); }) });
delete process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS;
okPair(ok,
  'W-A04 帽值单一来源：常量只定义一次，且旧的 20000 不再作为帽出现在源码里',
  // 行为侧：所有读取点都经生效帽——把 env 注入成 7 后，同一段判定必然撞帽（见 W-C），
  // 即「帽可被单点改变」这一事实本身就是单一来源的行为证明
  () => { process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS = '7'; const v = snapshotMaxDirs(); delete process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS; return v === 7 && snapshotMaxDirs() === 50000; },
  () => {
    const defs = srcWs.match(/const SYMBOL_SNAPSHOT_MAX_DIRS\s*=\s*(\d+)/g) ?? [];
    const capUseInsideWalk = /if \(dirs\.size >= SYMBOL_SNAPSHOT_MAX_DIRS\)/.test(srcWs);
    const oldCapAsCap = /=\s*20000\b/.test(srcWs);
    return defs.length === 1 && !capUseInsideWalk && !oldCapAsCap;
  },
  () => ({ 定义处: (srcWs.match(/const SYMBOL_SNAPSHOT_MAX_DIRS\s*=\s*\d+/g) ?? []), 旧值仍在: /=\s*20000\b/.test(srcWs) }));

// ================= W-B 不撞帽：深扫登记 → 热刷短路 =================
const treeA = makeTree('a', DIRS_A, FILES_A);
const pidA = newProject('t02288-A', treeA);
const r1 = await round(pidA);
const deepFiles = r1.files;
ok('W-B01 首轮深扫建索引（shortCircuited=false 且候选文件数达标）', r1.shortCircuited === false && walked(r1) >= 200,
  { files: r1.files, symbols: r1.symbols, skipped: r1.skipped, deferred: r1.deferred });
ok('W-B02 首轮零撞帽告警（10 目录 ≪ 50000 帽）', capHitsFor(pidA) === 0, { 告警数: capHitsFor(pidA) });
const r2 = await round(pidA);
ok('W-B03 同状态热刷整轮短路（提帽后该树才第一次拿到这资格——旧帽下此断言恒假）', r2.shortCircuited === true,
  { r2, 首轮: { files: r1.files } });
ok('W-B04 短路轮的 skipped 如实等于上次候选文件数（不把规模抹成 0）',
  r2.skipped === r1.files + r1.skipped && r2.oversized === r1.oversized && r2.files === 0,
  { skippedNow: r2.skipped, 上次候选: r1.files + r1.skipped });
ok('W-B05 短路仍如实回报清库变化（cleared 字段不因短路而失真）', r2.cleared === 0 && r2.deferred === false, { cleared: r2.cleared, deferred: r2.deferred });

// ================= W-C 撞帽：快照不登记 → 短路永久失效 + 告警恰一次 =================
const treeC = makeTree('c', DIRS_C, FILES_C);
const pidC = newProject('t02288-C', treeC);
process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS = String(DIRS_C); // 帽 = 目录数 → 必然撞
const c1 = await round(pidC);
const c2 = await round(pidC);
const c3 = await round(pidC);
delete process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS;
ok('W-C01 撞帽时索引照常建成（护栏只取消短路，不取消深扫——否则提帽会引出漏建）',
  c1.shortCircuited === false && walked(c1) >= 200 && walked(c2) >= 200,
  { c1walked: walked(c1), c2walked: walked(c2), c1files: c1.files, c2files: c2.files });
ok('W-C02 撞帽时热刷不短路（快照缺失即无基线，行为与修复前的 20000 帽对 bemp 一致）',
  c2.shortCircuited === false && c3.shortCircuited === false, { c2: c2.shortCircuited, c3: c3.shortCircuited });
okPair(ok, 'W-C03 撞帽告警按 projectId 恰出现一次（三轮深扫只记一条=去重生效），且带 dirs/cap/workspace 三字段',
  () => capHitsFor(pidC) === 1 && fieldsOf(pidC).dirs >= DIRS_C && fieldsOf(pidC).cap === DIRS_C && fieldsOf(pidC).hasWorkspace,
  () => warns.some((w) => w.includes(`project=${pidC}`) && /快照撞帽/.test(w)),
  () => ({ 条数: capHitsFor(pidC), 字段: fieldsOf(pidC), 样本: (warns.find((w) => w.includes(`project=${pidC}`)) ?? '').slice(0, 240) }));

// ================= W-D 帽复位：换回大帽后重新登记并复活短路 =================
const c4 = await round(pidC); // 帽已恢复默认 → 本轮登记快照
ok('W-D01 帽恢复后同一轮深扫即登记快照（不需要额外动作）', c4.shortCircuited === false && walked(c4) >= 200, { files: c4.files, walked: walked(c4) });
const c5 = await round(pidC);
ok('W-D02 快照登记后短路复活（证明告警去重位随快照建成复位，而非永久静音）', c5.shortCircuited === true, { c5: c5.shortCircuited });
ok('W-D03 帽恢复后不再新增撞帽告警（累计仍为一条）', capHitsFor(pidC) === 1, { 条数: capHitsFor(pidC) });

// ================= W-E 结构变化退回深扫 =================
const extraDir = join(treeA, 'mod_extra');
mkdirSync(extraDir, { recursive: true });
writeFileSync(join(extraDir, 'g0.ts'), 'export function fn_extra(x: number) { return x; }\n');
const e1 = await round(pidA);
ok('W-E01 新增目录后短路失效退回深扫（提帽不会把结构变化藏进短路里）', e1.shortCircuited === false, { e1: e1.shortCircuited });
const e2 = await round(pidA);
ok('W-E02 结构变化被吸收后下一轮重新短路', e2.shortCircuited === true && e2.skipped >= 200, { e2: e2.shortCircuited, skipped: e2.skipped });
const renamed = join(treeA, 'mod_renamed');
mkdirSync(renamed, { recursive: true });
writeFileSync(join(renamed, 'h0.ts'), 'export function fn_renamed(x: number) { return x; }\n');
rmSync(extraDir, { recursive: true, force: true });
const e3 = await round(pidA);
ok('W-E03 目录改名（增+删）同样退回深扫', e3.shortCircuited === false, { e3: e3.shortCircuited });

// ================= W-F 真树帽差异（方案 A 的必要性证据） =================
const BEMP = 'D:\\code\\QJ\\BEMP5.0DEV';
let realDirs = 0;
if (!existsSync(BEMP)) {
  sk('W-F 真树（bemp）帽差异复测', `工作空间 ${BEMP} 不在位——该段是收益/必要性证据，缺树时不判红也不判绿`);
} else {
  const rules = loadIgnoreRules(BEMP);
  const t0 = Date.now();
  const at50k = buildDirSnapshot(BEMP, rules, 't02288-real-50k');
  const ms50 = Date.now() - t0;
  const t1 = Date.now();
  process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS = '20000'; // 注入旧帽，在同一段生产走查代码上复现「必撞」
  const at20k = buildDirSnapshot(BEMP, rules, 't02288-real-20k');
  const ms20 = Date.now() - t1;
  delete process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS;
  realDirs = at50k ? at50k.size : 0;
  ok('W-F01 真树在 50000 帽下建成快照（不撞帽）', at50k !== null, { dirs: realDirs, ms: ms50 });
  ok('W-F02 真树目录数确实越过旧帽（20000 < dirs ≤ 50000：旧帽必撞、新帽有余量）', realDirs > 20000 && realDirs <= 50000, { dirs: realDirs });
  ok('W-F03 同一棵树注入旧帽 20000 后必然撞帽（旧行为复现，不是推测）', at20k === null, { ms: ms20, 告警: capHitsFor('t02288-real-20k') });
  ok('W-F04 真树撞帽同样只记一条告警，且 dirs/cap 如实（cap=20000）',
    capHitsFor('t02288-real-20k') === 1 && fieldsOf('t02288-real-20k').cap === 20000 && fieldsOf('t02288-real-20k').dirs >= 20000,
    { 条数: capHitsFor('t02288-real-20k'), 字段: fieldsOf('t02288-real-20k') });
  ok('W-F05 提帽的边际成本量级可接受（50000 帽一趟目录走查 < 60s，不改变深扫主导地位）', ms50 > 0 && ms50 < 60_000, { ms50, ms20 });
  say(`  [MEASURE] bemp 真树：dirs=${realDirs} 走查 50000 帽 ${ms50}ms / 20000 帽 ${ms20}ms`);
}

// ================= W-G 负对照（判据 4） =================
// G01 计数器牙齿：同形态行必须被数到、缺字段行必须不被数到——否则「恰出现一次」的绿是空转出来的
const SENT = 't02288-sentinel';
console.warn(`[workspace] 符号快照撞帽（哨兵） project=${SENT} dirs=999 cap=999 workspace=/sentinel`); // 走产品同一条通道（被替装的 console.warn 捕获）
ok('W-G01a 计数器有牙齿：与产品同形态的哨兵行必被 capHitsFor 数到（否则 W-C03/W-F04 是空断言）', capHitsFor(SENT) === 1, { 条数: capHitsFor(SENT) });
console.warn(`[workspace] 符号快照撞帽（哨兵·缺 dirs/cap） project=${SENT} workspace=/sentinel`);
ok('W-G01b 计数器不宽松：缺 dirs/cap 的同前缀行不计入（无关日志不得冒充撞帽告警）', capHitsFor(SENT) === 1, { 条数: capHitsFor(SENT) });
ok('W-G01c 归集按 projectId 隔离：全程不撞帽的 A 树计数恒为 0（跨项目串味即失去定位能力）', capHitsFor(pidA) === 0, { 条数: capHitsFor(pidA) });
// G02 同树同码只差帽值：帽小→不短路，帽默认→短路。这是「帽值确实驱动结论」的因果对照
const treeG = makeTree('g', 8, 26); // 8×26=208 文件 ≥ SYMBOL_FAST_PATH_MIN_FILES(200)，短路才有资格
const pidG = newProject('t02288-G', treeG);
process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS = '2';
await round(pidG); const g2 = await round(pidG);
delete process.env.MTASK_SYMBOL_SNAPSHOT_MAX_DIRS;
await round(pidG); const g3 = await round(pidG);
ok('W-G02 负对照：注入小于树目录数的帽 → 该树不短路；换回默认帽 → 短路恢复（同树同码，只差帽值）',
  g2.shortCircuited === false && g3.shortCircuited === true && capHitsFor(pidG) === 1,
  { g2: g2.shortCircuited, g3: g3.shortCircuited, walkedG: walked(g3), 撞帽告警: capHitsFor(pidG) });

// ================= 收口 =================
for (const pid of ALL_PIDS) { try { WorkspaceService.clearSymbols(pid); } catch { /* 夹具库随后整体删除 */ } }
console.warn = realWarn;
closeDb();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄未放时留痕即可 */ }

say(`\nT02288（快照帽 + capHit 埋点）验证结果：PASS=${pass} FAIL=${fail} SKIP=${skip}`);
say(`  隔离库与夹具树：${DATA_DIR}（已回收）`);
if (realDirs) say(`  真树目录数：${realDirs}`);
const RESULT_FILE = writeGateResults(gateShotsDir('t02288'), 't02288-gate-results.txt',
  `T02288（快照帽 + capHit 埋点）验证结果：PASS=${pass} FAIL=${fail} SKIP=${skip}\n${lines.join('\n')}\n`,
  { dataDir: DATA_DIR, note: realDirs ? `真树目录数 ${realDirs}` : '真树不在位' });
say(`  结果文件：${RESULT_FILE}`);
process.exit(fail > 0 ? 1 : 0);
