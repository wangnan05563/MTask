/**
 * T02617 验收门（秒级静态门，独立于 `verify-t02321-pack-precheck.mts`）：
 * 守的是「**守卫还在不在**」——四条发布入口对 `scripts/lib/head-precheck.mjs` 的**调用形态引用**，
 * 在三个面上都必须成立：工作树（现在跑的）、`git show HEAD:<path>`（重新 checkout 复现的）、
 * `git show :<path>`（下一次不带路径的 `git commit` 会写进提交的那份）。
 * 那条重的行为门守「守卫管不管用」，两者不混成一团。
 *
 * 现场动因（工单描述，2026-10-19 实测）：索引里躺着一份摘掉预检的旧 `scripts/打包.mjs`
 * （`git show :scripts/打包.mjs` 无 head-precheck、步骤计数还停在 `/6`，HEAD 是 `/7` 带第 [3] 步）。
 * 本单把索引这一面钉死：索引态丢引用 = 红。
 *
 * 约束（工单「约束」条）：
 *   - 只读判定：不建 worktree、不跑 tsc、不对真实工作区做任何构建/ABI 切换；
 *     门自己断言跑完前后看守文件字节级不变（Z-01）。
 *   - 负对照的「索引态被 stage 了无守卫版本」只在 `GIT_INDEX_FILE` 临时副本 + 独立
 *     `GIT_OBJECT_DIRECTORY` 里造；真实索引与真实对象库都断言未被写（N-06 自带反证）。
 *   - 判定实现只有一份（`scripts/lib/guard-reference.mjs`）；本门与 `head-precheck.mjs` 共用它。
 *
 * 用法：node scripts/verify-t02617-guard-reference.mjs
 *   夹具落 `MTASK_GATE_TMP`（未设时用系统 tmpdir）——本项目 C: 常年 0 可用，实测请指 D:/code/tmp。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_LIB = 'scripts/lib/guard-reference.mjs';
const gmod = await import(pathToFileURL(path.join(ROOT, GUARD_LIB)).href);
const { RELEASE_ENTRIES, GUARD_REL, hasGuardCall, isCommentLine, readFace, readFacesBatch, withoutGuardCall,
  inspectGuardReferences, scanReleaseEntries, summarize } = gmod;
const hpmod = await import(pathToFileURL(path.join(ROOT, GUARD_REL)).href);

const T0 = Date.now();
const TMP = path.join(process.env.MTASK_GATE_TMP || tmpdir(), `t02617-${process.pid}`);
mkdirSync(TMP, { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 收尾失败不影响结论 */ } });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond === true) { pass++; console.log(`PASS ${name} :: ${detail}`); return true; }
  fail++; console.log(`FAIL ${name} :: ${detail}`); return false;
};
const okPair = (name, behavior, literal, ctx = '') => {
  let bRes, bErr = '';
  try { bRes = typeof behavior === 'function' ? behavior() === true : behavior; } catch (e) { bRes = false; bErr = String(e && e.message); }
  if (bErr) return ok(`${name} —— 行为断言抛错，判红不判过`, false, bErr);
  if (!bRes) return ok(`${name} —— 行为失守（功能未达成，与文案无关）`, false, ctx);
  let lRes, lErr = '';
  try { lRes = typeof literal === 'function' ? literal() === true : literal; } catch (e) { lRes = false; lErr = String(e && e.message); }
  if (lErr) return ok(`${name} —— 字面锚点抛错`, false, lErr);
  if (!lRes) return ok(`${name} —— 字面锚点失配（行为在）：等价重构或文案变更，请改锚而不是改产品`, false, ctx);
  return ok(name, true, ctx);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const gitRaw = (args, env) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false, env: env ? { ...process.env, ...env } : undefined });
const gitOut = (...args) => { const r = gitRaw(args); return r.status === 0 ? r.stdout : ''; };

const WATCHED = [GUARD_REL, GUARD_LIB].concat(RELEASE_ENTRIES);
const before = Object.fromEntries(WATCHED.map((rel) => [rel, sha256(readFileSync(path.join(ROOT, rel)))]));
const realIndexHash = () => sha256(readFileSync(path.join(ROOT, '.git', 'index')));
const indexHashBefore = realIndexHash();
const wtCount = () => { try { return readdirSync(path.join(ROOT, '.git', 'worktrees')).length; } catch { return 0; } };
const wtBefore = wtCount();

// ---- G-01/G-02 判定模块与守卫都在（否则整门会对着不存在的守卫判绿）----
const libShape = ['GUARD_REL', 'RELEASE_ENTRIES', 'hasGuardCall', 'isCommentLine', 'readFace', 'readFacesBatch',
  'withoutGuardCall', 'inspectGuardReferences', 'scanReleaseEntries', 'summarize'].every((k) => k in gmod);
ok('G-01 判定模块导出齐备，必查名单与守卫路径是模块常量（入口名单不在门里各自抄一份）',
  libShape && RELEASE_ENTRIES.length === 4 && GUARD_REL === 'scripts/lib/head-precheck.mjs',
  `导出 ${Object.keys(gmod).filter((k) => !k.startsWith('_')).length} 个｜名单=${RELEASE_ENTRIES.join('、')}`);
ok('G-02 守卫实现与接线自检都在位：head-precheck.mjs 导出 checkGuardReference/runHeadPrecheck（缺一个就等于「无人可跑」）',
  existsSync(path.join(ROOT, GUARD_REL)) && existsSync(path.join(ROOT, GUARD_LIB))
  && typeof hpmod.checkGuardReference === 'function' && typeof hpmod.runHeadPrecheck === 'function',
  `checkGuardReference=${typeof hpmod.checkGuardReference} runHeadPrecheck=${typeof hpmod.runHeadPrecheck}`);

// ---- G-03..G-05 三条面逐入口（各面一条断言：合并成一条会让「三面里丢一面」只显示一次红、也难定位）----
const batch = readFacesBatch(ROOT, RELEASE_ENTRIES);
const faceRow = (face) => RELEASE_ENTRIES.map((rel) => ({ rel, f: batch.find((b) => b.rel === rel).faces.find((x) => x.face === face) }));
for (const [i, face] of ['worktree', 'head', 'index'].entries()) {
  const rows = faceRow(face);
  ok(`G-0${3 + i} 「${face}」面：四条发布入口都还**调用**守卫（注释里提到不算，读不到按红算）`,
    rows.every((r) => r.f.has === true),
    rows.map((r) => `${r.rel}=${r.f.has ? 'G' : r.f.read ? '调用形态缺失' : `读不到(${r.f.why})`}`).join(' '));
}
const faceDerived = RELEASE_ENTRIES.every((rel) => {
  const b = batch.find((x) => x.rel === rel);
  return b.faces.find((f) => f.face === 'head').has === hasGuardCall(gitOut('show', `HEAD:${rel}`), rel)
    && b.faces.find((f) => f.face === 'index').has === hasGuardCall(gitOut('show', `:${rel}`), rel)
    && b.faces.find((f) => f.face === 'worktree').has === hasGuardCall(readFileSync(path.join(ROOT, rel), 'utf8'), rel);
});
ok('G-06 两条读法互证（防「把同一面读三遍当三面绿」）：批量 git grep 的三面结论与逐条 git show / 工作树字节的结论逐条相等',
  faceDerived, `${RELEASE_ENTRIES.length} 条入口 × 3 面共 ${RELEASE_ENTRIES.length * 3} 组对照一致`);

// ---- G-07/G-08 入口矩阵与 npm 扇出：没有第四条旁路 ----
const matrix = scanReleaseEntries(ROOT);
const res = inspectGuardReferences(ROOT);
ok('G-07 入口矩阵完整且无旁路：每条会产出安装包的入口要么直接调用守卫，要么委托给已调用的目标',
  matrix.length >= 4 && RELEASE_ENTRIES.every((rel) => matrix.some((m) => m.rel === rel)) && res.bypass.length === 0,
  `矩阵=${matrix.map((m) => `${m.rel}${m.called ? '(直调)' : `(经 ${m.delegated || '无'})`}`).join('、')}｜旁路=${res.bypass.map((b) => b.rel).join(',') || '无'}`);
ok('G-08 npm 发布脚本扇出全部落到被守卫的目标（package.json 只读解析，本门不改它）',
  res.npmEntries.length >= 1 && res.npmUnguarded.length === 0 && res.ok === true,
  `npm=${res.npmEntries.map(([k, v]) => `${k}=${v}`).join(' / ')}｜汇总=${summarize(res)}`);

// ---- G-09..G-11 接线：预检入口跑之前先自检（行为腿在夹具微型仓库里，绝不碰真实重门）----
okPair('G-09 预检入口已接线到引用自检：runHeadPrecheck 在 spawn 重门之前先查引用',
  () => {
    const fx = buildFixture('strip');
    const red = spawnSync(process.execPath, [path.join(fx, 'scripts', 'lib', 'head-precheck.mjs'), '--check-only'], { cwd: fx, encoding: 'utf8', shell: false });
    const green = spawnSync(process.execPath, [path.join(ROOT, GUARD_REL), '--check-only'], { cwd: ROOT, encoding: 'utf8', shell: false });
    return red.status === 1 && /blocked=true/.test(red.stdout) && green.status === 0 && /blocked=false/.test(green.stdout);
  },
  () => {
    const src = readFileSync(path.join(ROOT, GUARD_REL), 'utf8');
    const atCall = src.indexOf('checkGuardReference(root)');
    const atSpawn = src.indexOf('spawnSync(process.execPath, [TSX, GATE]');
    return atCall > 0 && atSpawn > 0 && atCall < atSpawn;
  },
  '夹具仓库（摘掉引用）--check-only 退出码 1、真实仓库退出码 0，两条腿配对');

/** 在子进程里调夹具那份 head-precheck 的 runHeadPrecheck——绝不能在真实 ROOT 上调它，否则会 spawn 几分钟的重门。 */
const fxProbe = () => {
  const fx = buildFixture('strip');
  const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(fx, 'scripts/lib/head-precheck.mjs')).href)});
let banner = ''; const log = console.log; console.log = (...a) => { banner += a.join(' ') + '\\n'; };
let a, b; try { a = m.runHeadPrecheck({ skip: false, tag: '[fx]' }); b = m.runHeadPrecheck({ skip: true, tag: '[fx]' }); } finally { console.log = log; }
console.log(JSON.stringify({ blocked: { status: a.status, skipped: !!a.skipped, ref: a.guardRef && a.guardRef.blocked }, skip: { status: b.status, skipped: b.skipped, ref: b.guardRef && b.guardRef.blocked }, banner }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fx, encoding: 'utf8', shell: false });
  try { return JSON.parse(r.stdout); } catch { return { parseError: (r.stderr || r.stdout).slice(0, 300) }; }
};
const probe = fxProbe();
ok('G-10 摘掉引用后 runHeadPrecheck 真拦（夹具仓库）：状态非 0、打出 GUARD-REFERENCE-BLOCKED 横幅、且没往下跑重门',
  probe.blocked && probe.blocked.status === 1 && probe.blocked.ref === true && probe.blocked.skipped === false
  && /GUARD-REFERENCE-BLOCKED/.test(probe.banner || '') && /补回来再发包/.test(probe.banner || ''),
  `status=${probe.blocked && probe.blocked.status} 横幅命中=${/GUARD-REFERENCE-BLOCKED/.test(probe.banner || '')}${probe.parseError ? ' 解析失败:' + probe.parseError : ''}`);
ok('G-11 显式跳过时不拦但留痕（夹具仓库）：退出码 0 + 引用缺失告警与 SKIP 横幅同框——静默跳过等于没这道门',
  probe.skip && probe.skip.status === 0 && probe.skip.skipped === true && probe.skip.ref === true
  && /GUARD-REFERENCE-WARNED/.test(probe.banner || '') && /SKIP-HEAD-CHECK/.test(probe.banner || ''),
  `status=${probe.skip && probe.skip.status} 两横幅都在=${/GUARD-REFERENCE-WARNED/.test(probe.banner || '') && /SKIP-HEAD-CHECK/.test(probe.banner || '')}`);

// ---- Z-01/Z-02 只读与秒级自证（工单「约束」）----
const after = Object.fromEntries(WATCHED.map((rel) => [rel, sha256(readFileSync(path.join(ROOT, rel)))]));
ok('Z-01 全程只读：四条入口 + 守卫 + 判定模块的字节哈希与开跑前逐位相同，真实索引与 .git/worktrees 数不变',
  WATCHED.every((rel) => before[rel] === after[rel]) && realIndexHash() === indexHashBefore && wtCount() === wtBefore,
  `看守 ${WATCHED.length} 文件｜索引 ${indexHashBefore.slice(0, 12)}→${realIndexHash().slice(0, 12)}｜worktrees ${wtBefore}→${wtCount()}`);
const secs = (Date.now() - T0) / 1000;
ok('Z-02 秒级门成立：含夹具仓库与全部负对照在内总耗时 < 30s，且全程未调用 tsc / electron-builder / 打包脚本',
  secs < 30, `耗时 ${secs.toFixed(2)}s`);

// ================= 负对照（规约判据 ④）=================
ok('N-01 空源码判红：空串与 undefined 转串都 false（「没内容」不等于「引用在」）',
  hasGuardCall('') === false && hasGuardCall(String(undefined)) === false, '两种入参都 false');
const decoys = [
  ['scripts/x.bat', 'REM node "scripts\\lib\\head-precheck.mjs" %*'],
  ['scripts/x.bat', ':: node "scripts\\lib\\head-precheck.mjs" %*'],
  ['scripts/x.mjs', '// await import(\'./lib/head-precheck.mjs\');'],
  ['scripts/x.mjs', ' * 与 scripts/lib/head-precheck.mjs 共用同一份守卫'],
];
ok('N-02 注释诱饵判红：REM / :: / // / 块注释续行四种形态——即便字面写着调用也不认（「摘掉调用行只留注释」是最像没出事的一种退化）',
  decoys.every(([rel, line]) => isCommentLine(rel, line) === true && hasGuardCall(line, rel) === false),
  decoys.map(([, l]) => `"${l.trim().slice(0, 20)}…"`).join(' '));
ok('N-03 调用形态识别不误伤也不放过：echo/裸字符串里的守卫名判红，.bat 直跑与 ESM import 两种真调用判绿',
  hasGuardCall('echo "scripts\\lib\\head-precheck.mjs" done', 'scripts/x.bat') === false
  && hasGuardCall('const s = "scripts/lib/head-precheck.mjs";', 'scripts/x.mjs') === false
  && hasGuardCall('node "scripts\\lib\\head-precheck.mjs" %*\r\n', 'scripts/x.bat') === true
  && hasGuardCall("const { runHeadPrecheck } = await import('./lib/head-precheck.mjs');", 'scripts/x.mjs') === true,
  '2 种假引用 false + 2 种真调用 true');

const tamper = RELEASE_ENTRIES.map((rel) => {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  return { rel, keep: hasGuardCall(src, rel), cut: hasGuardCall(withoutGuardCall(src, rel), rel) };
});
ok('N-04 摘除对照（内存里改工作树源码，零写入）：逐条删掉调用行后必须 false，且删除前逐条 true（配对，防「本来就 false」的假红）',
  tamper.every((t) => t.keep === true && t.cut === false),
  tamper.map((t) => `${t.rel}:${t.keep ? '原绿' : '原本已红'}→${t.cut ? '仍绿(漏判!)' : '转红'}`).join(' '));

// N-05/N-06/N-07 索引态对照：只动临时副本索引与临时对象库
const realObjDir = path.join(ROOT, '.git', 'objects');
const fxObj = path.join(TMP, 'obj');
mkdirSync(fxObj, { recursive: true });
const fxIdx = path.join(TMP, 'index.copy');
const env2 = { GIT_INDEX_FILE: fxIdx, GIT_OBJECT_DIRECTORY: fxObj, GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjDir };
const cutDist = withoutGuardCall(readFileSync(path.join(ROOT, 'scripts/dist.js'), 'utf8'), 'scripts/dist.js');
const blobRes = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: ROOT, encoding: 'utf8', shell: false, input: cutDist, env: { ...process.env, ...env2 } });
const blobSha = (blobRes.stdout || '').trim();
const rt = spawnSync('git', ['read-tree', 'HEAD'], { cwd: ROOT, encoding: 'utf8', shell: false, env: { ...process.env, ...env2 } });
const ui = spawnSync('git', ['update-index', '--cacheinfo', `100644,${blobSha},scripts/dist.js`], { cwd: ROOT, encoding: 'utf8', shell: false, env: { ...process.env, ...env2 } });
const b2 = readFacesBatch(ROOT, RELEASE_ENTRIES, { env: env2 });
const distFaces = b2.find((x) => x.rel === 'scripts/dist.js').faces;
const idxCut = distFaces.find((f) => f.face === 'index');
const wtFace = distFaces.find((f) => f.face === 'worktree');
const headFace = distFaces.find((f) => f.face === 'head');
ok('N-05 索引态对照：副本索引里把 scripts/dist.js 换成无守卫 blob → 索引面转红，工作树面与 HEAD 面照旧绿（三面互不污染）',
  blobRes.status === 0 && blobSha.length >= 40 && rt.status === 0 && ui.status === 0
  && idxCut.read === true && idxCut.has === false && wtFace.has === true && headFace.has === true,
  `hash-object=${blobRes.status} read-tree=${rt.status} update-index=${ui.status}｜副本索引=${idxCut.has ? '仍绿(漏判!)' : '转红'} 工作树=${wtFace.has} HEAD=${headFace.has}`);
const realHasBlob = gitRaw(['cat-file', '-e', blobSha]).status === 0;
ok('N-06 对照不污染真实仓库（工单「禁止污染真实索引」）：真实索引字节哈希前后一致，且夹具 blob 不在真实对象库',
  realIndexHash() === indexHashBefore && realHasBlob === false
  && existsSync(path.join(realObjDir, blobSha.slice(0, 2), blobSha.slice(2))) === false,
  `索引 ${indexHashBefore.slice(0, 12)}→${realIndexHash().slice(0, 12)}｜夹具 blob ${blobSha.slice(0, 10)} 落真实库=${realHasBlob}`);
const cutRels = b2.filter((e) => !e.faces.every((f) => f.has)).map((e) => e.rel);
ok('N-07 汇总判定随索引面转红并点名：批量判定在副本索引环境下只有 scripts/dist.js 不 ok（不是笼统一句「不 ok」）',
  cutRels.length === 1 && cutRels[0] === 'scripts/dist.js',
  `被点名=${cutRels.join(',') || '无(漏判!)'}`);

const ghostHead = readFace(ROOT, 'head', 'scripts/打包.mjs.bak-not-exist');
const ghostIdx = readFace(ROOT, 'index', 'scripts/verify-t02617-ghost-not-staged.mjs');
ok('N-08 「读不到」判红：HEAD 里没有、索引里没有的文件都 read=false 且 has=false（缺面必红，不把 git 失败当通过）',
  ghostHead.read === false && ghostHead.has === false && ghostIdx.read === false && ghostIdx.has === false,
  `HEAD 缺=${ghostHead.why}｜索引缺=${ghostIdx.why}`);

// N-09/N-10 委托旁路：合成夹具（判据 ②——门自己造夹具，不拿真实发布入口做破坏性实验）
const fxB = buildBypassFixture();
const mB = scanReleaseEntries(fxB);
const rB = inspectGuardReferences(fxB);
ok('N-09 委托旁路对照（夹具）：入口只「委托」给一个并不调用守卫的包装脚本时，矩阵把它列为旁路且整体 ok=false（防 delegated 字符串永远命中）',
  mB.some((m) => m.rel === 'scripts/pack-ghost.mjs') && mB.some((m) => m.rel === 'scripts/pack-via-dist.mjs')
  && rB.bypass.some((b) => b.rel === 'scripts/pack-ghost.mjs')
  && !rB.bypass.some((b) => b.rel === 'scripts/pack-via-dist.mjs')
  && rB.ok === false,
  `夹具矩阵=${mB.map((m) => `${m.rel}${m.called ? '(直调)' : `(经 ${m.delegated || '无'})`}`).join(' ')}｜旁路=${rB.bypass.map((b) => b.rel).join(',')}`);
rmSync(path.join(fxB, 'scripts/pack-ghost.mjs'), { force: true });
rmSync(path.join(fxB, 'scripts/wrapper-unguarded.mjs'), { force: true });
const rB2 = inspectGuardReferences(fxB);
ok('N-10 夹具正向对照：把那条无守卫的旁路（连同它的委托目标）删掉，同一套判定立刻转绿——证明 N-09 的红来自「委托目标无守卫」而不是夹具本身残缺',
  rB2.ok === true && rB2.bypass.length === 0 && rB2.entries.every((e) => e.ok),
  summarize(rB2));

console.log(`\nverify-t02617: PASS=${pass} FAIL=${fail}（共 ${pass + fail} 条，${((Date.now() - T0) / 1000).toFixed(2)}s）`);
if (fail > 0) process.exitCode = 1;

/**
 * 夹具微型 git 仓库：只含发布面（四条入口 + 两份 lib + package.json），不建 worktree、
 * 不复制 node_modules——引用判定只需要这三条面。`mode==='strip'` 时把调用行摘掉。
 */
function buildFixture(mode) {
  const fx = path.join(TMP, `fx-${mode}`);
  if (existsSync(path.join(fx, '.git'))) return fx;
  mkdirSync(path.join(fx, 'scripts/lib'), { recursive: true });
  for (const rel of [GUARD_REL, GUARD_LIB]) writeFileSync(path.join(fx, rel.replace(/\//g, path.sep)), readFileSync(path.join(ROOT, rel), 'utf8'));
  for (const rel of RELEASE_ENTRIES) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    writeFileSync(path.join(fx, rel.replace(/\//g, path.sep)), mode === 'strip' ? withoutGuardCall(src, rel) : src);
  }
  writeFileSync(path.join(fx, 'package.json'), JSON.stringify({ name: 'fx', scripts: { dist: 'node scripts/dist.js' } }, null, 2));
  return commitFixture(fx);
}

/** 「看起来接好了」的旁路夹具：四条入口原样（全绿），另加两条合成入口——一条委托给无守卫包装、一条委托给已守卫的 dist.js。 */
function buildBypassFixture() {
  const fx = buildFixture('clean');
  writeFileSync(path.join(fx, 'scripts/pack-via-dist.mjs'), "import { spawnSync } from 'node:child_process';\nspawnSync('npx', ['electron-builder', '--win']); // 复用 scripts/dist.js 的守卫链路\n");
  writeFileSync(path.join(fx, 'scripts/pack-ghost.mjs'), "import { spawnSync } from 'node:child_process';\nspawnSync('npx', ['electron-builder', '--win']);\nimport('./wrapper-unguarded.mjs');\n");
  writeFileSync(path.join(fx, 'scripts/wrapper-unguarded.mjs'), "import { spawnSync } from 'node:child_process';\nspawnSync('npx', ['electron-builder', '--win']);\n");
  return commitFixture(fx);
}
function commitFixture(fx) {
  const g = (...a) => spawnSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@local', ...a], { cwd: fx, encoding: 'utf8', shell: false });
  if (!existsSync(path.join(fx, '.git'))) { if (g('init', '-q').status !== 0) throw new Error('夹具 git init 失败'); }
  g('add', '-A');
  if (g('commit', '-q', '-m', 'fixture').status !== 0) throw new Error('夹具 commit 失败');
  return fx;
}
