// T02210：符号索引热刷「未变更短路」断言（真实临时目录树 + 内存假库，跑生产 dist 实现）
// 运行：node scripts/t02210-hot-refresh-shortcircuit-test.mjs
// 背景（承接 T02200 让路）：让路只解决「谁在跑」，判定「哪些文件变了」仍需 stat 全量候选文件
//   （bemp 实测 7,233 次 stat ≈ 1.3s，仍超 300ms 内联预算）。本单加两条正交前提把整轮 stat 省掉：
//   ① 目录条目结构指纹一致（即时捕捉增删改名）；② 该工作空间递归监视器自上次深扫零事件（捕捉内容写入）。
// 本用例锁的是短路的**收益**与**不漏**：热刷 stat 降一个量级、改文件立刻被感知、
//   监视器不可用/小树/索引清空/符号上限截断一律退回原深扫语义。
// 为什么用假库而不是隔离实例：本机 better-sqlite3 预编译产物与当前 Node ABI 不匹配（服务起不来），
//   这里顶掉 db/connection，文件系统用真实临时目录（监视器语义只有真 fs 能证），被测对象仍是生产实现。
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const DIST = join(ROOT, 'server', 'dist');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 记账桩：把 stat/readFile/readdir 的调用次数暴露出来（降本唯一可量化口径） ----------
const fsMod = require('node:fs');
const origStat = fsMod.statSync;
const origRead = fsMod.readFileSync;
const origReaddir = fsMod.readdirSync;
const origWatch = fsMod.watch;
let statCalls = 0;
let readCalls = 0;
let readdirCalls = 0;
/** 监视器替身：默认真实实现（递归监视语义只有真 fs 能证），「不可用」场景由用例替换成抛错 */
const watchLog = []; // 临时诊断：投递到生产回调的事件序列
let watchImpl = (p, o, cb) => origWatch(p, o, (ev, name) => { watchLog.push(String(name)); return cb(ev, name); });
fsMod.statSync = (...a) => { statCalls++; return origStat(...a); };
fsMod.readFileSync = (...a) => { readCalls++; return origRead(...a); };
fsMod.readdirSync = (...a) => { readdirCalls++; return origReaddir(...a); };
fsMod.watch = (...a) => watchImpl(...a);

// ---------- 内存假库：只实现 WorkspaceService 实际用到的 5 类语句 ----------
const projects = new Map(); // projectId → workspace_path
const symRows = []; // { id, project_id, path, symbol, line, kind, file_mtime, workspace }

const fakeDb = {
  prepare(sql) {
    const s = sql.trim();
    return {
      run: (...p) => {
        if (/^INSERT INTO workspace_symbols/i.test(s)) {
          symRows.push({ id: p[0], project_id: p[1], path: p[2], symbol: p[3], line: p[4], kind: p[5], file_mtime: p[6], workspace: p[7] });
          return { changes: 1 };
        }
        if (/^DELETE FROM workspace_symbols WHERE project_id = \? AND workspace <> \?/i.test(s)) {
          const before = symRows.length;
          for (let i = symRows.length - 1; i >= 0; i--) if (symRows[i].project_id === p[0] && symRows[i].workspace !== p[1]) symRows.splice(i, 1);
          return { changes: before - symRows.length };
        }
        if (/^DELETE FROM workspace_symbols WHERE project_id = \? AND path = \?/i.test(s)) {
          const before = symRows.length;
          for (let i = symRows.length - 1; i >= 0; i--) if (symRows[i].project_id === p[0] && symRows[i].path === p[1]) symRows.splice(i, 1);
          return { changes: before - symRows.length };
        }
        if (/^DELETE FROM workspace_symbols WHERE project_id = \?\s*$/i.test(s)) {
          const before = symRows.length;
          for (let i = symRows.length - 1; i >= 0; i--) if (symRows[i].project_id === p[0]) symRows.splice(i, 1);
          return { changes: before - symRows.length };
        }
        return { changes: 0 };
      },
      get: (id) => (/^SELECT workspace_path FROM projects WHERE id = \?/i.test(s) ? { workspace_path: projects.get(id) ?? null } : undefined),
      all: (...p) => {
        if (/^SELECT path, MAX\(file_mtime\) AS m FROM workspace_symbols/i.test(s)) {
          const agg = new Map();
          for (const r of symRows) if (r.project_id === p[0]) agg.set(r.path, Math.max(agg.get(r.path) ?? -1, r.file_mtime));
          return [...agg.entries()].map(([path, m]) => ({ path, m }));
        }
        if (/^SELECT path, symbol, line, kind FROM workspace_symbols/i.test(s)) {
          const [pid, ws, like, limit] = p;
          const needle = String(like).replace(/^%|%$/g, '');
          return symRows
            .filter((r) => r.project_id === pid && r.workspace === ws && r.symbol.includes(needle))
            .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
            .slice(0, limit)
            .map((r) => ({ path: r.path, symbol: r.symbol, line: r.line, kind: r.kind }));
        }
        return [];
      },
    };
  },
  transaction: (fn) => fn,
};

const connPath = require.resolve(join(DIST, 'db', 'connection.js'));
require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: { getDb: () => fakeDb, reopenDb: () => {}, getDbFile: () => ':memory:' } };

const { WorkspaceService } = require(join(DIST, 'services', 'WorkspaceService.js'));

// ---------- 真实临时目录树（**必须落 D:**：C: 盘常年 0 可用，写树会假性失败） ----------
const BASE = 'D:/code/tmp/gate-tmp';
const WS = join(BASE, `t02210-ws-${Date.now().toString(36)}`);
const CANDIDATES = 260; // > SYMBOL_FAST_PATH_MIN_FILES，才够触发短路

function makeTree(root, dirs, perDir, markerPrefix) {
  let k = 0;
  for (let d = 0; d < dirs; d++) {
    const dir = join(root, `d${String(d).padStart(2, '0')}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < perDir; f++) {
      writeFileSync(join(dir, `f${String(f).padStart(3, '0')}.ts`), `export function ${markerPrefix}_${k++}() {}\nexport class ${markerPrefix}C${k} {}\n`);
    }
  }
  return k;
}

mkdirSync(WS, { recursive: true });
makeTree(WS, 13, 20, 'hot'); // 260 个候选文件
// 忽略目录：内置规则应把它挡在索引与结构指纹之外
mkdirSync(join(WS, 'node_modules', 'pkg'), { recursive: true });
for (let i = 0; i < 30; i++) writeFileSync(join(WS, 'node_modules', 'pkg', `n${i}.ts`), `export function nm_${i}() {}\n`);
// .git 预先建好（监视器挂在首轮刷新时才建立）：目录本身的「新增」事件按叶子路径是判不出忽略的，
// 真实仓库里 git 操作改的是 .git/objects/xx 这类多级路径，才是过滤要兜住的场景
mkdirSync(join(WS, '.git', 'objects'), { recursive: true });

const pid = 'p-big';
projects.set(pid, WS);

/**
 * 回到「稳态」：反复刷新直到命中短路。
 * 监视器是在首轮刷新时才挂上的，此前建树的批量事件还在 libuv 队列里积压，
 * 只有经过几次 await（深扫分片/检索 memo 构建都会让出事件循环）才会投递进来。
 * 这些迟到事件只会让判定更保守（多走一次深扫），但要断言「短路的持续收益」必须先排空。
 */
async function settleStable(project, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await WorkspaceService.refreshSymbols(project, 60000);
    if (r?.shortCircuited === true) {
      await sleep(400); // 再等一个投递窗口：确认积压真的排空了
      const again = await WorkspaceService.refreshSymbols(project, 60000);
      if (again?.shortCircuited === true) return again;
    }
    await sleep(100);
  }
  return null;
}

console.log('--- 1. 深扫基线：候选文件全覆盖，忽略目录不入索引 ---');
statCalls = readCalls = readdirCalls = 0;
const r1 = await WorkspaceService.refreshSymbols(pid, 60000);
const deep1 = { stat: statCalls, read: readCalls, readdir: readdirCalls };
check('A-01 首轮深扫建全 260 个候选文件', r1?.files === CANDIDATES, `files=${r1?.files} symbols=${r1?.symbols}`);
check('A-02 首轮不短路且未 deferred', r1?.shortCircuited === false && r1?.deferred === false, JSON.stringify({ sc: r1?.shortCircuited, deferred: r1?.deferred }));
check('A-03 符号条目确实入库（含 class 与 function）', symRows.length > CANDIDATES, `rows=${symRows.length}`);
check('A-04 node_modules 不入索引', !symRows.some((r) => r.path.includes('node_modules')) && WorkspaceService.querySymbols(pid, 'nm_0').length === 0, `nm 命中=0`);
check('A-05 深扫的 stat 调用量与候选文件同量级', deep1.stat >= CANDIDATES, `stat=${deep1.stat}`);

console.log('--- 2. 热刷短路：整轮不进逐文件 stat（本单主诉求） ---');
statCalls = readCalls = readdirCalls = 0;
const r2 = await WorkspaceService.refreshSymbols(pid, 60000);
const hot2 = { stat: statCalls, read: readCalls, readdir: readdirCalls };
check('B-01 未变更热刷命中短路', r2?.shortCircuited === true && r2?.files === 0, JSON.stringify({ sc: r2?.shortCircuited, files: r2?.files }));
check('B-02 skipped 如实等于上次 stat 到的候选文件数', r2?.skipped === CANDIDATES, `skipped=${r2?.skipped}`);
check('B-03 stat 工作量下降一个量级以上', hot2.stat * 10 < deep1.stat, `深扫 ${deep1.stat} 次 → 热刷 ${hot2.stat} 次`);
check('B-04 短路不读任何文件正文（仅剩 .mtaskignore 一条探测读）', hot2.read <= 1, `read=${hot2.read}`);
check('B-05 短路仍在内联预算内完成（deferred=false）', r2?.deferred === false, '不再需要后台续跑兜底');
const r3 = await WorkspaceService.refreshSymbols(pid, 60000);
check('B-06 连续热刷持续命中', r3?.shortCircuited === true && r3?.skipped === CANDIDATES, `skipped=${r3?.skipped}`);

console.log('--- 3. 检索 memo 不因短路被作废（否则省了 stat 却赔上重扫全文） ---');
const stable3 = await settleStable(pid);
check('C-00 排空积压事件后回到稳态（迟到事件只让判定更保守，不会漏）', Boolean(stable3), 'settleStable 命中短路');
const ctx1 = await WorkspaceService.autoContext(pid, ['hot_1']);
watchLog.length = 0;
readCalls = 0;
const rc = await WorkspaceService.refreshSymbols(pid, 60000);
const readsDuringRefresh = readCalls;
readCalls = 0;
const ctx2 = await WorkspaceService.autoContext(pid, ['hot_1']);
check('C-01 短路刷新不失效检索 memo（再次检索零读取）', rc?.shortCircuited === true && readCalls === 0,
  `刷新 read=${readsDuringRefresh}（仅 .mtaskignore），再检索 sc=${rc?.shortCircuited} read=${readCalls} 事件=[${watchLog.slice(-8).join('|')}] n=${watchLog.length}`);
check('C-02 短路前后检索结果一致', ctx1.length > 0 && ctx2.includes('hot_1'), `ctx1=${ctx1.length}字 ctx2=${ctx2.length}字`);

console.log('--- 4. 不漏：内容改动必须即时感知（监视器事件是唯一依据） ---');
const editedRel = join('d00', 'f000.ts');
writeFileSync(join(WS, editedRel), 'export function editedMarkerT02210() {}\n');
let rEdit = null;
for (let i = 0; i < 40 && !rEdit; i++) {
  await sleep(100);
  const r = await WorkspaceService.refreshSymbols(pid, 60000);
  if (r?.shortCircuited === false) rEdit = r; // 事件到达即走深扫
}
check('C-03 改一个文件后热刷立即走深扫（不滞）', Boolean(rEdit) && rEdit?.files === 1, JSON.stringify(rEdit));
check('C-04 只重建该文件的符号，其余仍跳过', Boolean(rEdit) && rEdit?.skipped === CANDIDATES - 1, `skipped=${rEdit?.skipped}`);
const hitEdit = WorkspaceService.querySymbols(pid, 'editedMarkerT02210');
check('C-05 新符号即时可查', hitEdit.length === 1 && hitEdit[0].path.replace(/\\/g, '/') === 'd00/f000.ts', JSON.stringify(hitEdit[0] ?? null));
const rAfterEdit = await WorkspaceService.refreshSymbols(pid, 60000);
check('C-06 深扫后重新登记快照，下一轮恢复短路', rAfterEdit?.shortCircuited === true, JSON.stringify({ sc: rAfterEdit?.shortCircuited }));

console.log('--- 5. 不漏：增删改名由结构指纹即时捕捉（不依赖事件） ---');
writeFileSync(join(WS, 'd01', 'addedT02210.ts'), 'export function addedMarkerT02210() {}\n');
const rAdd = await WorkspaceService.refreshSymbols(pid, 60000);
check('C-07 新增文件当轮即深扫（结构指纹差异）', rAdd?.shortCircuited === false && rAdd?.files === 1, JSON.stringify(rAdd));
check('C-08 新增文件符号可查', WorkspaceService.querySymbols(pid, 'addedMarkerT02210').length === 1, 'query=addedMarkerT02210');
mkdirSync(join(WS, 'newdirT02210'), { recursive: true });
writeFileSync(join(WS, 'newdirT02210', 'x.ts'), 'export function dirMarkerT02210() {}\n');
const rDir = await WorkspaceService.refreshSymbols(pid, 60000);
check('C-09 新增目录当轮即深扫', rDir?.shortCircuited === false && WorkspaceService.querySymbols(pid, 'dirMarkerT02210').length === 1, JSON.stringify(rDir));
unlinkSync(join(WS, 'newdirT02210', 'x.ts'));
const rDel = await WorkspaceService.refreshSymbols(pid, 60000);
check('C-10 删除文件当轮即深扫', rDel?.shortCircuited === false, JSON.stringify(rDel));
check('C-11 删除后符号查询不再返回该路径（孤儿过滤）', WorkspaceService.querySymbols(pid, 'dirMarkerT02210').length === 0, 'query=dirMarkerT02210 → 0');

console.log('--- 6. 忽略路径的事件不作废短路（.git/node_modules 频繁写，但永不入索引） ---');
const stable6 = await settleStable(pid);
check('C-11b 稳态可达（上一节的删改不留残余迟到事件）', Boolean(stable6), 'settleStable 命中短路');
watchLog.length = 0;
writeFileSync(join(WS, '.git', 'objects', 'abcT02210'), 'x');
writeFileSync(join(WS, 'node_modules', 'pkg', 'n0.ts'), 'export function nm_0() {}\nexport function nm_0b() {}\n');
await sleep(400); // 与 C-03 同一量级的投递窗口
const rIgn = await WorkspaceService.refreshSymbols(pid, 60000);
check('C-12 忽略目录的写入事件不触发深扫', rIgn?.shortCircuited === true,
  JSON.stringify({ sc: rIgn?.shortCircuited, files: rIgn?.files }) + ` 事件=[${watchLog.join('|')}]`);

console.log('--- 7. 护栏：监视器不可用 / 小树 / 索引清空 / 符号上限截断 ---');
const pid2 = 'p-nowatch';
projects.set(pid2, WS);
watchImpl = () => { throw new Error('recursive watch unsupported'); };
const w1 = await WorkspaceService.refreshSymbols(pid2, 60000);
const w2 = await WorkspaceService.refreshSymbols(pid2, 60000);
check('D-01 监视器建立失败 → 一律深扫（宁慢不漏）', w1?.shortCircuited === false && w2?.shortCircuited === false, JSON.stringify({ w1: w1?.shortCircuited, w2: w2?.shortCircuited }));
check('D-02 深扫仍然增量（mtime 命中，files=0）', w2?.files === 0 && w2?.skipped >= CANDIDATES, `skipped=${w2?.skipped}`);
watchImpl = (...a) => origWatch(...a);

const WS2 = join(BASE, `t02210-small-${Date.now().toString(36)}`);
mkdirSync(join(WS2, 'src'), { recursive: true });
writeFileSync(join(WS2, 'src', 'a.ts'), 'export function alphaOnly() {}\n');
writeFileSync(join(WS2, 'src', 'b.ts'), 'export function betaOnly() {}\nclass B {}\n');
writeFileSync(join(WS2, 'src', 'c.ts'), 'export function gammaOnly() {}\n');
const pid3 = 'p-small';
projects.set(pid3, WS2);
const s1 = await WorkspaceService.refreshSymbols(pid3, 60000);
const s2 = await WorkspaceService.refreshSymbols(pid3, 60000);
check('D-03 小树不短路（既有 API 测试 X-5 口径原样保持）', s2?.shortCircuited === false && s2?.files === 0 && s2?.skipped === 3, JSON.stringify(s2));
check('D-04 小树首轮正常建索引', s1?.files === 3 && s1?.symbols >= 4, `files=${s1?.files} symbols=${s1?.symbols}`);

WorkspaceService.clearSymbols(pid);
const afterClear = await WorkspaceService.refreshSymbols(pid, 60000);
check('D-05 索引清空后首轮必深扫（快照同步作废）', afterClear?.shortCircuited === false && afterClear?.files >= CANDIDATES, JSON.stringify({ sc: afterClear?.shortCircuited, files: afterClear?.files }));

const WS3 = join(BASE, `t02210-trunc-${Date.now().toString(36)}`);
mkdirSync(WS3, { recursive: true });
// 260 文件 × ≥20 符号 > SYMBOL_LIMIT(5000)：达上限收摊的那一轮树没走完，不许登记快照
for (let d = 0; d < 13; d++) {
  const dir = join(WS3, `t${d}`);
  mkdirSync(dir, { recursive: true });
  for (let f = 0; f < 20; f++) {
    const body = Array.from({ length: 20 }, (_, i) => `export function tr_${d}_${f}_${i}() {}`).join('\n');
    writeFileSync(join(dir, `t${d}_${f}.ts`), `${body}\n`);
  }
}
const pid4 = 'p-trunc';
projects.set(pid4, WS3);
const t1 = await WorkspaceService.refreshSymbols(pid4, 120000);
const t2 = await WorkspaceService.refreshSymbols(pid4, 120000);
check('D-06 达符号上限截断 → 不登记快照（否则半棵树被当成已扫完）', t1?.deferred === false && t2?.shortCircuited === false, JSON.stringify({ t1done: t1?.deferred, t2sc: t2?.shortCircuited, symbols: t1?.symbols }));
check('D-07 截断轮次的索引确实按上限收口', t1?.symbols <= 5000 + 200, `symbols=${t1?.symbols}`);

console.log('--- 8. 接线静态核对 ---');
const src = origRead(join(ROOT, 'server', 'src', 'services', 'WorkspaceService.ts'), 'utf8');
check('E-01 短路条件含监视器不可用护栏', /!watchState\.unsupported && watchState\.watcher/.test(src), 'unsupported → 退回深扫');
check('E-02 深扫间隔上限（静默失效最坏收敛时间）', /Date\.now\(\) - snap\.deepVerifiedAt < SYMBOL_DEEP_VERIFY_MS/.test(src), `SYMBOL_DEEP_VERIFY_MS = ${5 * 60}000ms`);
check('E-03 快照只在非截断轮次登记', src.includes('else if (!state.truncated)') && src.includes('if (!job.state.truncated) commitTreeSnapshot'), '内联完成与后台续跑完成两处都受截断护栏');
check('E-04 索引清空/换绑同时作废快照与监视器', src.includes('treeSnapshots.delete(projectId); // T02210') && src.includes('dropWorkspaceWatch(projectId)'), 'clearSymbols 双失效');
check('E-05 短路返回发生在 memo 失效之前（不赔上全文重扫）', src.indexOf('shortCircuited: true }') < src.indexOf('invalidateSearchMemo(projectId); // T00782：索引刷新后'), '短路分支先返回，深扫路径才失效 memo');
const routesSrc = origRead(join(ROOT, 'server', 'src', 'routes', 'index.ts'), 'utf8');
const delRoute = routesSrc.slice(routesSrc.indexOf("api.delete('/projects/:id'"), routesSrc.indexOf("api.delete('/projects/:id'") + 900);
check('E-06 删除项目同路回收监视器与快照（内存态随 projectId 存活）', /WorkspaceService\.clearSymbols\(req\.params\.id\)/.test(delRoute), 'delete /projects/:id → clearSymbols');

// ---------- 收尾：关掉全部监视器（否则句柄挂到进程退出），清理临时目录 ----------
for (const p of [pid, pid2, pid3, pid4]) WorkspaceService.clearSymbols(p);
fsMod.statSync = origStat;
fsMod.readFileSync = origRead;
fsMod.readdirSync = origReaddir;
rmSync(WS, { recursive: true, force: true });
rmSync(WS2, { recursive: true, force: true });
rmSync(WS3, { recursive: true, force: true });
console.log(`\nT02210 热刷短路：PASS=${pass} FAIL=${fail}`);
process.exitCode = fail > 0 ? 1 : 0;
