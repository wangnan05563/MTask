/**
 * T02069 回归自测：better-sqlite3 ABI 切换的三条不变量（快照先于切换、按字节还原、缓存缺失 fail-fast），
 * 以及 scripts/dist.js / scripts/打包.mjs 的接线守卫。
 *
 * 背景：package.json 的 build.npmRebuild = false，包内原生模块就是打包时工作区那一份，谁忘了切
 * Electron ABI 就会打出「装机即废」的包（0.1.1011.193 实测 NODE_MODULE_VERSION 127 vs 130），
 * 而顺序写反（切换后取快照）会让工作区永久留在工作区 Electron ABI，本地 node 直跑 server/dist 反而坏掉。
 *
 * **T02293 批㉙ 改判（原第 5 段四条源码字面锚整体重写）**
 * 原写法：`distSrc.includes("import('./lib/abi-switch.mjs')")` 锁死「动态 import」这一种写法
 * （打包.mjs 用的是静态 import，同一语义两种拼法，门里为此写了两条不同的字面串）；
 * `indexOf('snapshotWorkspaceAbi(') < indexOf('switchAbi(ROOT')` 与
 * `match(/restoreWorkspaceAbi\(ROOT, prevAbi, abiOpts\)/g).length === 2` 锁死变量名与实参拼写；
 * 取数面还是**工作树**——并发会话的半成品会被本门当成失配红因。净效果：改名/换引号/换 import 形式即恒红，
 * 而「把还原调用整行删掉」这种真失守反倒与「改了个名」共用同一条红，红因不可区分。
 *
 * 改判后：
 *   · 「入口复用共享实现」+「先快照后切换」由**真跑一次 dist.js** 的行为腿承担——在临时副本里把
 *     `lib/abi-switch.mjs` 换成只记录调用的桩、`lib/head-precheck.mjs` 换成「已跳过」的桩，
 *     桩在 `switchAbi` 里立即 `process.exit(0)`：既看到入口的实际调用序列，又不会走到 electron-builder，
 *     也不会覆写任何真实原生二进制（发布链路未放行，本门全程不碰）。
 *   · 「exit/error 两个出口都还原」由**结构腿**承担：按处理器块取回调体（括号配平）再数调用，不认变量名。
 *   · 字面锚降级为 `pair()` 的配对腿（红时能分「行为失守／等价重构换了写法」）。
 *   · 反证齐备：调换顺序、把共享实现换成内联副本、删掉一处还原——三样都必须让对应腿转红；
 *     再钉一条**容忍反证**：把 prevAbi/abiOpts 改名、换引号、拆解构之后所有腿必须照旧为真
 *     ——这才是 T02293 要解决的东西：他人重构不得把门打红。
 *   · 打包.mjs 一条**没有行为腿**（发布入口未放行，不得执行），故显式降级为「结构判据 + 变异反证」，
 *     红因只能人工判定，这点在标签与证据里写明白，不假装是实测。
 *
 * 用法：`node scripts/verify-abi-switch.mjs`（纯 JS，不必走 tsx）。临时根取 `os.tmpdir()`——
 * 本机 C: 常年 0 可用，跑之前请把 TMP 指到 D:，否则会造出假的写入失败。
 * 取数面统一 `git show HEAD:`，不读并发工作树。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 房内约定：判据取产品源码一律走 HEAD，不读并发工作树（T02293 反模式 11/34） */
const headSrc = (rel) => execFileSync('git', ['show', `HEAD:${rel}`],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

let PASS = 0, FAIL = 0;
/** 原来用 assert 串到底：一处红就把后面的判据连同证据一起炸掉（与 t02144 的 `catch {}` 同族），改判据收集器 */
const showEv = (extra) => {
  try {
    const v = typeof extra === 'function' ? extra() : extra;   // 允许把证据写成 thunk（pair 的 ctx 同形），别一序列化就炸
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s.slice(0, 400) : '(证据不可序列化)';
  } catch (e) { return `(证据打印失败：${e.message})`; }
};
const ok = (name, cond, extra) => {
  const c = cond === true;
  if (c) PASS += 1; else FAIL += 1;
  console.log(`[${c ? 'PASS' : 'FAIL'}] ${name}${c || extra === undefined ? '' : ` → ${showEv(extra)}`}`);
  // PASS 轮也得能看到「守卫到底说了什么」——否则「反证通过」只是断言，看不出它真的咬到了（同 t02321 口径）
  if (c && extra !== undefined && process.env.ABI_VERBOSE) console.log(`    证据: ${showEv(extra)}`);
  return c;
};
/** 与 scripts/lib/anchor-pair.mts 同口径的本地实现——本门保持 `node` 直跑，不引 .mts 以免必须走 tsx */
const pair = (name, behavior, literal, ctx) => {
  const probe = (fn) => { try { return { passed: fn() === true }; } catch (e) { return { passed: false, threw: e instanceof Error ? e.message : String(e) }; } };
  const b = probe(behavior);
  if (!b.passed) return ok(name, false, { 红因: b.threw ? `行为断言抛错：${b.threw}` : '行为失守（功能未达成，与写法无关）', ...(ctx ? { 证据: ctx() } : {}) });
  const l = probe(literal);
  return ok(name, l.passed, l.passed
    ? (process.env.ABI_VERBOSE && ctx ? (() => { try { return ctx(); } catch { return undefined; } })() : undefined)
    : {
      红因: l.threw ? `字面锚点抛错：${l.threw}` : '字面锚点失配（行为在）——等价重构或文案变更，需人工判定改锚还是改码',
      ...(ctx ? { 证据: ctx() } : {}),
    });
};

// ── A 段：ABI 切换的三条不变量（行为腿；跑的是 **HEAD 的那份实现**，不是并发工作树的半成品）──
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-switch-'));
// 中途抛错也要收掉临时根（本轮实测：证据行崩过一次，留下 `abi-switch-gs8Mr1/` 残骸——
// 正常路径末尾的 rmSync 到不了，就得由 exit 兜底；与批㉘ t02144 的「门不留残留」同口径）
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });
const r = path.join(root, 'ws');
fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
fs.writeFileSync(path.join(root, 'scripts', 'lib', 'abi-switch.mjs'), headSrc('scripts/lib/abi-switch.mjs'));
const { switchAbi, snapshotWorkspaceAbi, restoreWorkspaceAbi } = await import(
  pathToFileURL(path.join(root, 'scripts', 'lib', 'abi-switch.mjs')).href);
const ws = path.join(r, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const put = (p, buf) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };
const opts = { fail: (m) => { throw new Error('FAIL:' + m); }, log: () => {} };
const at = () => fs.readFileSync(ws).toString();
put(ws, Buffer.from('WS'));
put(path.join(r, 'build', 'native', 'electron', 'better_sqlite3.node'), Buffer.from('EL'));
put(path.join(r, 'build', 'native', 'dev', 'better_sqlite3.node'), Buffer.from('DV'));

const snap = snapshotWorkspaceAbi(r);
switchAbi(r, 'electron', opts);
ok('A-01 快照→切换：工作区拿到 Electron 那份', at() === 'EL', { 内容: at() });
restoreWorkspaceAbi(r, snap, opts);
ok('A-02 按字节还原：工作区回到打包前内容', at() === 'WS', { 内容: at() });

switchAbi(r, 'electron', opts);
restoreWorkspaceAbi(r, snapshotWorkspaceAbi(r), opts);
ok('A-03 反证：切换后才取快照＝还原等于没做（Electron ABI 留在工作区）', at() === 'EL', { 内容: at() });
put(ws, Buffer.from('WS'));

const thrown = (() => { try { switchAbi(r, 'nonexistent', opts); return '(没抛)'; } catch (e) { return String(e.message); } })();
ok('A-04 缓存缺失 fail-fast 且未污染工作区', /ABI 缓存缺失/.test(thrown) && at() === 'WS', { 报错: thrown.slice(0, 60), 内容: at() });

fs.rmSync(ws);
const nullSnap = snapshotWorkspaceAbi(r) === null;
switchAbi(r, 'electron', opts);
restoreWorkspaceAbi(r, null, opts);
ok('A-05 工作区本就没有 .node（快照为 null）→ 还原回落 dev 缓存', nullSnap && at() === 'DV', { 快照为空: nullSnap, 内容: at() });

// ── W 段：接线守卫（本批改判段）────────────────────────────────────────────────────────
/**
 * 在临时副本里真跑一次入口。桩在 switchAbi 里 process.exit(0)，所以 electron-builder 不会被启动、
 * 工作区的原生二进制也不会被覆写；调用序列落进 calls.jsonl 供判据读。
 * entryName 只支持 dist.js——打包.mjs 属发布入口、未放行不得执行（见 W-06 的显式降级）。
 */
function spyRun(entryText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-wiring-'));
  const logFile = path.join(dir, 'calls.jsonl');
  try {
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'abi-wiring-fixture', version: '0.0.0-spy' }));
    fs.writeFileSync(path.join(dir, 'scripts', 'dist.js'), entryText);
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'head-precheck.mjs'),
      'export const runHeadPrecheck = () => ({ skipped: true, status: 0 });\n'
      + 'export const isRequestedSkip = () => true;\nexport const shortHead = () => "spy";\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'abi-switch.mjs'),
      `import fs from 'node:fs';\nconst LOG = ${JSON.stringify(logFile)};\n`
      + `const rec = (n, extra = {}) => fs.appendFileSync(LOG, JSON.stringify({ n, ...extra }) + '\\n');\n`
      + `export const snapshotWorkspaceAbi = () => { rec('snapshotWorkspaceAbi'); return 'SPY-SNAP'; };\n`
      + `export const switchAbi = (_root, mode) => { rec('switchAbi', { mode }); process.exit(0); };\n`
      + `export const restoreWorkspaceAbi = (_root, snap) => { rec('restoreWorkspaceAbi', { snap: String(snap) }); };\n`
      + `export const resolveOutputDir = () => { rec('resolveOutputDir'); return 'out'; };\n`
      + `export const buildChildEnv = () => { rec('buildChildEnv'); return {}; };\n`);
    fs.writeFileSync(logFile, '');
    const res = spawnSync(process.execPath, [path.join(dir, 'scripts', 'dist.js'), '--skip-head-check'],
      { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    return { calls: fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), code: res.status, out: ((res.stdout ?? '') + (res.stderr ?? '')).slice(-240) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const DIST = 'scripts/dist.js', PKG = 'scripts/打包.mjs';
const distHead = headSrc(DIST), pkgHead = headSrc(PKG);
/** 两种 import 写法都认（dist.js 动态、打包.mjs 静态）——原门为此写了两条互不相容的字面串 */
const reusesShared = (src) => /from\s+['"]\.\/lib\/abi-switch\.mjs['"]/.test(src)
  || /import\(\s*['"]\.\/lib\/abi-switch\.mjs['"]\s*\)/.test(src);
/** 结构腿：取 `child.on('exit'|'error', …)` 的回调体（大括号配平），块内数还原调用——不认变量名 */
function restoresInHandler(src, ev) {
  const h = src.search(new RegExp(`\\.on\\(\\s*['"]${ev}['"]`));
  if (h < 0) return null;
  const open = src.indexOf('{', h);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}' && (depth -= 1) === 0) {
      return ((src.slice(open, j + 1)).match(/restoreWorkspaceAbi\s*\(/g) || []).length;
    }
  }
  return null;
}
const delRestoreIn = (src, ev) => {
  const h = src.search(new RegExp(`\\.on\\(\\s*['"]${ev}['"]`));
  const open = src.indexOf('{', h);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}' && (depth -= 1) === 0) {
      return src.slice(0, open) + src.slice(open, j + 1).replace(/restoreWorkspaceAbi\s*\([^)]*\);/, '') + src.slice(j + 1);
    }
  }
  return src;
};
/** 首个「调用位」而不是首个出现位：import 行里也有这两个名字 */
const firstCall = (src, fn) => src.search(new RegExp(`${fn}\\s*\\(`));

// W-01 行为腿＝真跑入口看调用序列；字面腿＝引用共享模块（两种写法都认）
const spy = spyRun(distHead);
pair('W-01 dist.js 复用共享实现且**先快照后切换**（行为腿＝真跑一次入口读调用序列）',
  () => spy.calls.length >= 2 && spy.calls[0].n === 'snapshotWorkspaceAbi'
    && spy.calls[1].n === 'switchAbi' && spy.calls[1].mode === 'electron',
  () => reusesShared(distHead),
  () => ({ 调用序列: spy.calls.map((c) => c.n + (c.mode ? `(${c.mode})` : '')).join(' → '), 退出码: spy.code, 输出尾: spy.out }));

// W-02 反证：调换「快照/切换」两行——行为腿必须转假（证明它测的是顺序这件事，不是文本长相）
const swapped = distHead.replace(
  /(const prevAbi = snapshotWorkspaceAbi\(ROOT\);)(\s*)(switchAbi\(ROOT, 'electron', abiOpts\);)/, '$3$2$1');
const spySwap = swapped === distHead ? { calls: [{ n: '变异点未命中' }] } : spyRun(swapped);
ok('W-02 反证：副本里调换「快照/切换」两行，调用序列判据必须转假',
  swapped !== distHead && !(spySwap.calls[0]?.n === 'snapshotWorkspaceAbi' && spySwap.calls[1]?.n === 'switchAbi'),
  { 变异命中: swapped !== distHead, 调用序列: spySwap.calls.map((c) => c.n).join(' → ') });

// W-03 反证：把共享实现换成内联副本——复用判据与调用序列判据必须同时转假
const inlined = distHead.replace(/await import\('\.\/lib\/abi-switch\.mjs'\)/g,
  '({ switchAbi: () => ({ on: () => {} }), snapshotWorkspaceAbi: () => null, restoreWorkspaceAbi: () => {}, resolveOutputDir: () => "out", buildChildEnv: () => ({}) })');
const spyInline = inlined === distHead ? { calls: [] } : spyRun(inlined);
ok('W-03 反证：入口不再引共享实现（换内联副本）→ 复用判据转假、桩一次也没被调到',
  inlined !== distHead && !reusesShared(inlined) && spyInline.calls.length === 0,
  { 变异命中: inlined !== distHead, 字面腿: reusesShared(inlined), 调用序列: spyInline.calls.map((c) => c.n).join(' → ') || '(空)' });

// W-04 结构腿：exit / error 两条出口都得还原（删掉任一处由 W-05 证明这腿有牙）
const distExit = restoresInHandler(distHead, 'exit'), distErr = restoresInHandler(distHead, 'error');
ok('W-04 dist.js 的 exit / error 两条出口都调用了还原（按处理器块取体，不认变量名）',
  distExit >= 1 && distErr >= 1, { exit: distExit, error: distErr });
ok('W-05 反证：删掉 error 出口里的还原调用，W-04 判据必须转红（另一处不受牵连）',
  (() => { const m = delRestoreIn(distHead, 'error'); return m !== distHead && restoresInHandler(m, 'error') === 0 && restoresInHandler(m, 'exit') >= 1; })(),
  { 删后: { exit: restoresInHandler(delRestoreIn(distHead, 'error'), 'exit'), error: restoresInHandler(delRestoreIn(distHead, 'error'), 'error') } });

// W-06 打包.mjs：发布入口未放行、**不得执行**，故显式降级为结构判据 + 变异反证（红因只能人工判定，不假装有行为实测）
const pkgMut1 = pkgHead.replace(/(const prevAbi = snapshotWorkspaceAbi\(ROOT\);)(\s*)(switchAbi\(ROOT, 'electron', abiOpts\);)/, '$3$2$1');
const pkgMut2 = pkgHead.replace(/restoreWorkspaceAbi\(ROOT, prevAbi, abiOpts\);/, '');
ok('W-06 打包.mjs 与 dist.js 共用同一实现、快照行在切换行之前、且还原调用在位（取数面 git show HEAD；无行为腿——发布入口未放行）',
  reusesShared(pkgHead) && firstCall(pkgHead, 'snapshotWorkspaceAbi') >= 0
  && firstCall(pkgHead, 'snapshotWorkspaceAbi') < firstCall(pkgHead, 'switchAbi')
  && (pkgHead.match(/restoreWorkspaceAbi\s*\(/g) || []).length >= 1,
  () => ({ 复用: reusesShared(pkgHead), 快照位: firstCall(pkgHead, 'snapshotWorkspaceAbi'), 切换位: firstCall(pkgHead, 'switchAbi'), 还原处数: (pkgHead.match(/restoreWorkspaceAbi\s*\(/g) || []).length }));
ok('W-07 反证：打包.mjs 副本里调换顺序 / 删掉唯一还原，W-06 的两个子判据必须分别转假',
  pkgMut1 !== pkgHead && !(firstCall(pkgMut1, 'snapshotWorkspaceAbi') < firstCall(pkgMut1, 'switchAbi'))
  && pkgMut2 !== pkgHead && (pkgMut2.match(/restoreWorkspaceAbi\s*\(/g) || []).length === 0 && reusesShared(pkgMut2),
  { 调换后顺序: `${firstCall(pkgMut1, 'snapshotWorkspaceAbi')} < ${firstCall(pkgMut1, 'switchAbi')}`, 删后还原: (pkgMut2.match(/restoreWorkspaceAbi\s*\(/g) || []).length });

// W-08 容忍反证（本批真正要钉的东西）：同义重构后所有判据必须照旧为真
const renamed = distHead
  .replace(/const \{ switchAbi, snapshotWorkspaceAbi, restoreWorkspaceAbi \} = await import\('\.\/lib\/abi-switch\.mjs'\);/,
    "const _abi = await import('./lib/abi-switch.mjs');\n  const { switchAbi, snapshotWorkspaceAbi, restoreWorkspaceAbi } = _abi;")
  .replace(/prevAbi/g, 'snapBefore').replace(/abiOpts/g, 'switchOpts')
  .replace(/switchAbi\(ROOT, 'electron', switchOpts\)/, 'switchAbi(ROOT, "electron", switchOpts)')
  .replace(/snapshotWorkspaceAbi\(ROOT\)/g, 'snapshotWorkspaceAbi( ROOT )')
  .replace(/restoreWorkspaceAbi\(ROOT, snapBefore, switchOpts\)/g, 'restoreWorkspaceAbi(ROOT, snapBefore , switchOpts)');
ok('W-08 容忍反证：拆开解构、改名 prevAbi/abiOpts、换引号、加空格——所有判据必须照旧为真（他人重构不得把门打红）',
  renamed !== distHead && reusesShared(renamed)
  && restoresInHandler(renamed, 'exit') === distExit && restoresInHandler(renamed, 'error') === distErr
  && firstCall(renamed, 'snapshotWorkspaceAbi') < firstCall(renamed, 'switchAbi'),
  { 变异命中: renamed !== distHead, 复用: reusesShared(renamed), exit: restoresInHandler(renamed, 'exit'), error: restoresInHandler(renamed, 'error') });
ok('W-09 留痕：同一份同义重构拿去喂旧门的三条字面锚，旧门会红几条（记录本批改判的净收益，不判成败）',
  true, { 旧锚_动态import串: renamed.includes("import('./lib/abi-switch.mjs')"), 旧锚_整串还原调用: (renamed.match(/restoreWorkspaceAbi\(ROOT, prevAbi, abiOpts\)/g) || []).length, 旧锚_switchAbi前缀: renamed.indexOf('switchAbi(ROOT') >= 0 });

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nverify-abi-switch: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) process.exit(1);
