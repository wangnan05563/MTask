/**
 * T02321 / T02355 验收门：HEAD 自洽性预检是不是**真的挡在发布链路上**。
 *
 * 拦的是这条已实测过的静默路径：`scripts/打包.mjs` 的 server typecheck 跑的是**工作树**
 * （= HEAD + 并发会话未提交 hunk 的叠加态），于是「引用已入库、定义没入库」的缺口被别人的 WIP
 * 恰好补齐 → 打包全绿、安装包照出，但按那个 commit 重新 checkout 编译不出来（发布件不可复现）。
 * T02321 把 T02295 门接成打包第 [3] 步，T02355 把它扩成四条入口共用的一份实现。
 *
 * 入口矩阵（T02355）——本门覆盖的是**全部**会产出安装包的入口，不是只挑一条：
 *   `scripts/打包.mjs`、`scripts/dist.js`（`npm run dist` / `dist:dir`）、
 *   `scripts/构建打包.bat`（`scripts/一键发布.bat` → `publish-oneclick.ps1` 走的这条）、
 *   `scripts/build-pack-t.bat`（与上一条同源的孪生入口）。四条入口共用 `scripts/lib/head-precheck.mjs`：
 *   W-01 枚举矩阵（有入口没走到守卫即 FAIL）、W-02 用 `git show HEAD:` 配对证明守卫是本单新增、
 *   W-03 订正工单前提（根目录 `打包.bat` 本仓不存在）、W-04…W-11 实跑两枚 `.bat`、
 *   W-12…W-15 实跑 `dist.js`、W-10 是 load-bearing 对照（把守卫那一行摘掉，红 HEAD 立刻放行）。
 *   V-xx 保持 T02321 原有的 `打包.mjs` 三组断言不变。
 *
 * 用法（不读生产数据、不写真实分支；产物只在 D: 上的临时 worktree 里）：
 *   <node> node_modules/tsx/dist/cli.mjs scripts/verify-t02321-pack-precheck.mts
 *   环境变量：T02321_TMP_ROOT（夹具根，默认 D:/code/tmp/t02321-pack-precheck，**勿指 C:**）、
 *             T02321_KEEP=1 保留夹具便于排障（默认整轮跑完删夹具 + worktree prune）。
 *
 * 判据写法服从 T02293：夹具自造（不依赖仓库存量数据）、断言打在**行为**上（子进程退出码、
 * 步骤标记、产物/release 目录是否出现、结果文件条数、假件记账），不锁实现字面量；每条改法配负对照：
 *   - 「预检失败 → 打包中止、且什么都没构建」的正断言，由 V-09 / W-09 / W-15（绿夹具同样跑一遍、
 *     照样放行到构建末段）反向配对——否则「什么都没构建」可能只是夹具里根本跑不起来；
 *   - 「跳过开关 → 放行」由 V-08 / W-07 的第二半（跳过时预检子门**一个结果文件都不该新增**）配对，
 *     证明放行走的确实是跳过分支，而不是预检自己判了个绿；
 *   - V-11 / W-13 看守本门自身的破坏力：夹具靠 junction 挂真实仓库根 node_modules，若打包真跑到
 *     ABI 切换，覆写的就是本机工作区的原生二进制——桩（stub）挡住后按字节校验；
 *   - 实跑 `.bat` 需要三道兜底：`MTASK_BUILD_STOP_AFTER_PRECHECK` 停车阀、夹具内 `native-switch.bat`
 *     换成只报错的桩、PATH 前置假 `electron-builder.cmd`（只记账）。W-17 断言这整轮兜底桩始终安静。
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const TMP_ROOT = process.env.T02321_TMP_ROOT || 'D:/code/tmp/t02321-pack-precheck';
const NESTED = join(TMP_ROOT, 'nested'); // 打包内预检子门自己的 worktree 副本根
const WT_RED = join(TMP_ROOT, 'wt-red');
const WT_GREEN = join(TMP_ROOT, 'wt-green');
const KEEP = !!process.env.T02321_KEEP;
/** 到达「构建末段、ABI 切换前」的安全边界即退出——桩替换只在夹具 worktree 里生效。 */
const STUB_EXIT = 99;
const CONSUMER = join('server', 'src', 't02321packprobe_consumer.ts');
const DEF = join('server', 'src', 'util', 't02321packprobe_def.ts');
const LINES: string[] = [];
let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  LINES.push(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  console.log(LINES[LINES.length - 1]);
  if (cond) pass += 1; else fail += 1;
};
const note = (s: string): void => {
  LINES.push(s);
  console.log(s);
};
const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
/** 行为轮的输出尾巴留证：`ok()` 只在 FAIL 时带 detail，PASS 轮也得能看到「守卫到底说没说」。 */
const tail = (s: string): string => s.replace(/\r?\n+/g, ' ⏎ ').trim().slice(-320) || '(空输出)';

rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const HEAD_SHA = (() => { try { return git('rev-parse', 'HEAD').trim(); } catch { return ''; } })();
const SQLITE_NODE = join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const hashOf = (p: string): string => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : '<无>');
const SQLITE_HASH_BEFORE = hashOf(SQLITE_NODE);
const WT_COUNT_BEFORE = git('worktree', 'list').trim().split(/\r?\n/).length;
const toolchainReady = ['typescript', 'tsx', 'vite'].every((m) => existsSync(join(ROOT, 'node_modules', m)));
ok('P-01 前置：HEAD 可解析、打包脚本与预检门在位、根依赖（typescript/tsx/vite）可见',
  !!HEAD_SHA && existsSync(join(ROOT, 'scripts', '打包.mjs')) && existsSync(join(ROOT, 'scripts', 'verify-t02295-head-selfconsistency.mts')) && toolchainReady,
  `HEAD=${HEAD_SHA.slice(0, 7) || '取不到'} 依赖=${toolchainReady}`);

/**
 * 造一个「引用入库、定义没入库」的夹具：
 *   commit 只收 consumer（`import` 一个未提交的定义文件）→ 该 commit 单独 checkout 必红；
 *   定义文件留在夹具工作树（未跟踪）→ 工作树 tsc 全绿。这正是本单要拦的形态。
 * withDefInCommit=true 时定义一起入库 → HEAD 自洽（负对照用）。
 */
function makeFixture(copy: string, withDefInCommit: boolean): { shaShort: string; err: string } {
  let shaShort = '';
  let err = '';
  try {
    git('worktree', 'add', '--detach', copy, HEAD_SHA);
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'junction');
    mkdirSync(join(copy, dirname(DEF)), { recursive: true });
    writeFileSync(join(copy, CONSUMER),
      '// T02321 门内夹具：只提交引用侧，定义留在工作树未入库\nimport { probeValue } from '
      + `'./util/t02321packprobe_def';\nexport const consumed = probeValue();\n`, 'utf8');
    writeFileSync(join(copy, DEF), 'export const probeValue = (): string => "t02321-pack-probe";\n', 'utf8');
    git('-C', copy, 'add', '--', CONSUMER.replace(/\\/g, '/'));
    if (withDefInCommit) git('-C', copy, 'add', '--', DEF.replace(/\\/g, '/'));
    git('-C', copy, 'commit', '--quiet', '-m', 'T02321 门内夹具：HEAD 自洽性预检靶子（仅存在于临时 worktree）');
    shaShort = git('-C', copy, 'rev-parse', '--short', 'HEAD').trim();
    // 桩：把 ABI 切换/还原换成「到此为止」的退出——夹具的 node_modules 是真实仓库根的 junction，
    // 真跑 switchAbi 会覆写本机工作区的原生二进制（并发会话立刻 ERR_DLOPEN_FAILED）。
    writeFileSync(join(copy, 'scripts', 'lib', 'abi-switch.mjs'),
      `export function snapshotWorkspaceAbi() { return null; }\n`
      + `export function switchAbi() { console.log('T02321-BOUNDARY-REACHED'); process.exit(${STUB_EXIT}); }\n`
      + `export function restoreWorkspaceAbi() {}\n`
      + `export function resolveOutputDir() { return 'release'; }\n`
      + `export function buildChildEnv() { return { ...process.env }; }\n`, 'utf8');
  } catch (e) {
    err = String(e).slice(0, 220);
  }
  return { shaShort, err };
}

const RED = makeFixture(WT_RED, false);
const GREEN = makeFixture(WT_GREEN, true);
/**
 * 第三个夹具：红 HEAD + **记账式** ABI 桩（不退出）+ 假 electron-builder。
 * dist.js 的守卫必须在切 ABI 之前，所以这里要能同时观测「有没有走到 switchAbi」和
 * 「传给 electron-builder 的参数里有没有混进我们自己的开关」。
 */
const WT_DIST = join(TMP_ROOT, 'wt-dist');
const DIST_STUB = [
  'export function snapshotWorkspaceAbi() { console.log("T02355-ABI-SNAPSHOT"); return null; }',
  'export function switchAbi() { console.log("T02355-ABI-CALLED"); }',
  'export function restoreWorkspaceAbi() { console.log("T02355-ABI-RESTORE"); }',
  'export function resolveOutputDir() { return "release"; }',
  'export function buildChildEnv() { return { ...process.env }; }',
  '',
].join('\n');
const DIST = makeFixture(WT_DIST, false);
ok('P-02 三个夹具 worktree 建成（红 / 绿 / 红+记账式桩；提交只落在临时副本，真实分支未动）',
  !!RED.shaShort && !!GREEN.shaShort && !!DIST.shaShort && !RED.err && !GREEN.err && !DIST.err
  && git('rev-parse', 'HEAD').trim() === HEAD_SHA,
  `红=${RED.shaShort || '失败'} 绿=${GREEN.shaShort || '失败'} 桩=${DIST.shaShort || '失败'} ${RED.err}${GREEN.err}${DIST.err}`);

/**
 * 工作树里改过的发布入口（本单的实施对象）盖进夹具：夹具检出的是 HEAD，
 * HEAD 上既没有 `scripts/lib/head-precheck.mjs`，`.bat` 也还是旧的六步版——
 * 不覆盖就等于在测「上一版实现」，本单改的东西一条都没被判到。
 * 覆盖清单同时就是入口矩阵（少一个即漏测一个入口），由 W-01 对着仓库全量核对。
 */
const OVERLAY = ['scripts/打包.mjs', 'scripts/dist.js', 'scripts/lib/head-precheck.mjs', 'scripts/构建打包.bat', 'scripts/build-pack-t.bat'];
function overlayWorktreeEntries(copies: string[]): { rel: string; hits: number }[] {
  return OVERLAY.map((rel) => {
    const src = join(ROOT, ...rel.split('/'));
    const body = existsSync(src) ? readFileSync(src, 'utf8') : '';
    let hits = 0;
    for (const copy of copies) {
      const dst = join(copy, ...rel.split('/'));
      if (!body || !existsSync(dirname(dst))) continue;
      copyFileSync(src, dst);
      if (readFileSync(dst, 'utf8') === body) hits += 1;
    }
    return { rel, hits };
  });
}
const overlaid = overlayWorktreeEntries([WT_RED, WT_GREEN, WT_DIST]);
// 第三个夹具改用「记账式」桩：dist.js 的放行路径要能走到 electron-builder 调用点（假件只记账、不打包）
if (DIST.shaShort) writeFileSync(join(WT_DIST, 'scripts', 'lib', 'abi-switch.mjs'), DIST_STUB, 'utf8');
/** 真实工作区这五份入口在门跑完必须一字不变（夹具盖的是它们的副本，不是原件）。 */
const ENTRY_HASH_BEFORE = new Map<string, string>(OVERLAY.map((rel) => [rel, hashOf(join(ROOT, ...rel.split('/')))]));
const FAKE_BIN = join(TMP_ROOT, 'fakebin');
const FAKE_LOG = join(TMP_ROOT, 'fake-builder.log');
mkdirSync(FAKE_BIN, { recursive: true });
// 重定向目标必须是反斜杠路径：cmd 会把「D:/…」里的 / 当参数分隔，正斜杠会让记账写不进文件（假件静默失联）
writeFileSync(join(FAKE_BIN, 'electron-builder.cmd'),
  `@echo off\r\necho FAKE-BUILDER %*\r\n>>"${FAKE_LOG.replace(/\//g, '\\')}" echo FAKE-BUILDER %*\r\nexit /b 0\r\n`, 'ascii');
ok('P-03 工作树改过的四条发布入口已盖进三个夹具（假 electron-builder 就位）',
  overlaid.length === OVERLAY.length && overlaid.every((o) => o.hits === 3)
  && existsSync(join(WT_RED, 'scripts', 'lib', 'head-precheck.mjs'))
  && readFileSync(join(WT_DIST, 'scripts', 'lib', 'abi-switch.mjs'), 'utf8').includes('T02355-ABI-CALLED'),
  overlaid.map((o) => `${o.rel}:${o.hits}/3`).join(' '));

/**
 * 统一的入口调用：把「子进程根本没起来」（CreateProcess 被拒 / 超时）与「起来了、判了红」分开记。
 * 上一轮实测：并发会话把机器压满时，本轮后半段连着 6 条 exit=-1 且输出为空——若只记 `status ?? -1`，
 * 环境抖动会伪装成产品行为，红/绿都无从解释。起不来时重试一次（并在日志里点名），仍失败就打 SPAWN-FAILED。
 */
function spawnEntry(argv0: string, args: string[], copy: string, extraEnv: Record<string, string> = {}): { code: number; out: string } {
  const opt = {
    cwd: copy, encoding: 'utf8' as const, shell: false, timeout: 1_500_000, maxBuffer: 80 * 1024 * 1024,
    windowsVerbatimArguments: argv0 === 'cmd.exe',
    env: { ...process.env, PATH: `${FAKE_BIN};${process.env.PATH ?? ''}`, T02295_TMP_ROOT: NESTED, TEMP: TMP_ROOT, TMP: TMP_ROOT, ...extraEnv },
  };
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(argv0, args, opt);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status !== null) return { code: r.status, out };
    last = r.error ? `未能启动（${r.error.message}）` : `被信号终止（${r.signal}）`;
    if (r.error && attempt === 1) { note(`[环境重试] ${argv0} ${args[0] ?? ''} ${last}，重试一次`); continue; }
    break;
  }
  return { code: -1, out: `${last} SPAWN-FAILED` };
}

/**
 * spawn 通道预检：所有行为断言都靠「起得来子进程」。上一轮实测后半段连着 6 条 exit=-1 空输出
 * （并发会话把机器压满时 CreateProcess 会被拒绝），那种红与产品无关，必须先把通道自证出来。
 * 两条通道分别探：直接 node（dist.js / 打包.mjs 走这条）、cmd→node（.bat 入口走这条）。
 */
const chanNode = spawnSync(NODE, ['-p', 'process.versions.node'], { encoding: 'utf8', shell: false, cwd: ROOT });
const chanCmd = spawnSync('cmd.exe', ['/d', '/s', '/c', 'node -p "process.versions.node"'],
  { encoding: 'utf8', shell: false, cwd: ROOT, windowsVerbatimArguments: true });
const chanVer = /^(\d+\.\d+\.\d+|v\d+\.\d+\.\d+)$/;
ok('P-04 spawn 通道可用（环境前置：node 直调与 cmd→node 两条都起得来，先自证再判产品）',
  chanNode.status === 0 && chanVer.test((chanNode.stdout ?? '').trim())
  && chanCmd.status === 0 && chanVer.test((chanCmd.stdout ?? '').trim()),
  `node 直调 status=${chanNode.status} out=${JSON.stringify((chanNode.stdout ?? '').trim())} error=${chanNode.error?.message ?? '(无)'}｜cmd→node status=${chanCmd.status} out=${JSON.stringify((chanCmd.stdout ?? '').trim())} error=${chanCmd.error?.message ?? '(无)'}`);

/** 在夹具里直接跑一次 server tsc（判据打在 HEAD/工作树的真实差异上，不借子门的措辞）。 */
function tscServer(copy: string): { code: number; text: string } {
  const r = spawnSync(NODE, [join(copy, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit',
    '-p', join(copy, 'server', 'tsconfig.json')],
  { cwd: copy, encoding: 'utf8', env: { ...process.env, TEMP: TMP_ROOT, TMP: TMP_ROOT }, maxBuffer: 40 * 1024 * 1024, timeout: 900_000 });
  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------- V-01 夹具本身成立（否则后面全是空判） ----------
const worktreeGreen = RED.shaShort ? tscServer(WT_RED) : { code: -1, text: '未执行' };
const defBackedUp = join(WT_RED, `${DEF}.bak`);
let headRed: { code: number; text: string } = { code: -1, text: '未执行' };
if (RED.shaShort) {
  renameSync(join(WT_RED, DEF), defBackedUp); // 撤掉「未入库的定义」≈ 单独 checkout 该 commit
  headRed = tscServer(WT_RED);
  renameSync(defBackedUp, join(WT_RED, DEF));
}
ok('V-01 夹具判别力：同一夹具「定义在位」tsc 全绿、「定义不在」必须报错（缺定义形态真实可检出）',
  worktreeGreen.code === 0 && headRed.code !== 0 && /TS230[0-9]|Cannot find module/.test(headRed.text),
  `工作树 exit=${worktreeGreen.code}${worktreeGreen.code ? `｜${worktreeGreen.text.replace(/\r?\n/g, ' ').slice(0, 220)}` : ''} · 撤定义 exit=${headRed.code}`);

/** 跑一次打包脚本（夹具副本内，桩保证到不了 electron-builder）。 */
function runPack(copy: string, args: string[] = []): { code: number; out: string } {
  return spawnEntry(NODE, [join(copy, 'scripts', '打包.mjs'), ...args], copy);
}
const subResults = (copy: string): string[] => {
  const dir = join(copy, '.workbuddy');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('t02295-head-selfconsistency-gate-results')) : [];
};
const newestSub = (copy: string): { file: string; text: string } => {
  const files = subResults(copy).sort();
  const file = files[files.length - 1] ?? '';
  return { file, text: file ? readFileSync(join(copy, '.workbuddy', file), 'utf8') : '' };
};
const builtArtifacts = (copy: string): string[] =>
  ['server/dist', 'web/dist'].map((p) => join(copy, ...p.split('/'))).filter((p) => existsSync(p));
const releaseDirs = (copy: string): string[] =>
  readdirSync(copy).filter((d) => /^release\d*$/.test(d) && statSync(join(copy, d)).isDirectory());

// ---------- 正例：红 HEAD、不带开关 → 预检把打包拦下来 ----------
const runA = RED.shaShort ? runPack(WT_RED) : { code: -1, out: '未执行' };
const subA = RED.shaShort ? newestSub(WT_RED) : { file: '', text: '' };
ok('V-02 红 HEAD 打包被拦下：预检步非零退出（实测 exit=' + runA.code + '）',
  runA.code !== 0 && runA.code !== STUB_EXIT, `夹具 HEAD ${RED.shaShort}｜输出尾：${runA.out.replace(/\r?\n/g, ' ').slice(-260)}`);
ok('V-03 中止时回显是哪个 commit 不自洽（不让人回头猜）',
  runA.out.includes(RED.shaShort),
  `期望含 ${RED.shaShort}｜实际输出 ${runA.out.length} 字符`);
ok('V-04 拦在构建之前：夹具里既无 server/dist 也无 web/dist（预检失败后一步都没往下走）',
  builtArtifacts(WT_RED).length === 0, `已存在产物：${builtArtifacts(WT_RED).join('、') || '(无)'}`);
ok('V-05 未产出任何 release 目录（安装包没被生成）', releaseDirs(WT_RED).length === 0, releaseDirs(WT_RED).join('、'));
ok('V-06 拦截归因正确：预检子门确实跑了，并判红在「HEAD 副本 server tsc」这条上（非前置误伤）',
  !!subA.file && /FAIL H-05/.test(subA.text) && !/FAIL H-0[1-4]/.test(subA.text),
  `子门结果=${subA.file || '缺失'}｜${(subA.text.match(/FAIL H-\d\d/g) ?? []).join('、') || '无 FAIL 行'}`);

// ---------- 跳过开关：红 HEAD + --skip-head-check → 放行，且预检子门没跑 ----------
const subCountBefore = subResults(WT_RED).length;
const runB = RED.shaShort ? runPack(WT_RED, ['--skip-head-check']) : { code: -1, out: '未执行' };
ok('V-07 跳过开关按预期放行：红 HEAD + --skip-head-check 一路跑到构建末段边界（exit='
  + runB.code + '，桩退出码=' + STUB_EXIT + '）', runB.code === STUB_EXIT && runB.out.includes('T02321-BOUNDARY-REACHED'),
  `exit=${runB.code}｜尾：${runB.out.replace(/\r?\n/g, ' ').slice(-200)}`);
ok('V-08 放行是「显式跳过」而非「预检自己判绿」：输出有醒目 SKIP-HEAD-CHECK 行，且预检子门结果文件零新增',
  runB.out.includes('SKIP-HEAD-CHECK') && subResults(WT_RED).length === subCountBefore,
  `标记=${runB.out.includes('SKIP-HEAD-CHECK')} 结果文件 ${subCountBefore} → ${subResults(WT_RED).length}`);
ok('V-09 跳过轮真把构建做完了：server/dist 与 web/dist 都出现（与 V-04 配对，证明「什么都没构建」是拦下的结果而非夹具常态）',
  builtArtifacts(WT_RED).length === 2, builtArtifacts(WT_RED).join('、'));

// ---------- 负对照：绿 HEAD、不带开关 → 预检放行（本步不是逢跑必红） ----------
const runC = GREEN.shaShort ? runPack(WT_GREEN) : { code: -1, out: '未执行' };
const subC = GREEN.shaShort ? newestSub(WT_GREEN) : { file: '', text: '' };
ok('V-10 负对照（防止这一步变成恒红/摆设）：自洽 HEAD + 不带开关同样放行到构建末段边界，且预检子门零 FAIL',
  runC.code === STUB_EXIT && runC.out.includes('T02321-BOUNDARY-REACHED') && !!subC.file && !/FAIL H-/.test(subC.text),
  `exit=${runC.code} 子门结果=${subC.file || '缺失'}｜${(subC.text.match(/FAIL H-\d\d/g) ?? []).join('、') || '无 FAIL'}｜尾：${tail(runC.out)}`);
ok('V-11 放行轮的预检步在日志里点名了自己检的是哪个 commit（绿夹具短号可见）',
  runC.out.includes(GREEN.shaShort), `期望含 ${GREEN.shaShort}`);

// ---------- 收口前：T02355 新增入口的行为断言（.bat 与 dist.js 原先都是旁路） ----------

/** 实跑一次 .bat 入口（`echo. |` 满足脚本里的 pause；FAKE_BIN 保证任何一路走到构建都只打到假件）。 */
function runBat(copy: string, bat: string, extraEnv: Record<string, string> = {}): { code: number; out: string } {
  // windowsVerbatimArguments：路径里的引号必须交给 cmd 自己解析。默认写法会让 node 把内嵌引号
  // 转义成 \"，cmd 收到的是字面量 `\"…bat\"` → 「不是内部或外部命令」，七条 .bat 断言全成假红。
  return spawnEntry('cmd.exe', ['/d', '/s', '/c', `echo. | call "${join(copy, 'scripts', bat)}"`], copy, extraEnv);
}
/** 实跑一次 `npm run dist` 背后的 scripts/dist.js（同目录参数，假 electron-builder 记账）。 */
function runDist(copy: string, args: string[] = [], extraEnv: Record<string, string> = {}): { code: number; out: string } {
  return spawnEntry(NODE, [join(copy, 'scripts', 'dist.js'), ...args], copy, extraEnv);
}
const versionOf = (copy: string): string => {
  try { return String(JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).version); } catch { return ''; }
};
const BATS = ['构建打包.bat', 'build-pack-t.bat'];

// 入口普查（只读真实工作区 + HEAD 取证）：先把「谁会产出安装包」列全，再逐条断言。
const stripComment = (rel: string, line: string): boolean => {
  const t = line.trim();
  if (/\.bat$|\.cmd$/i.test(rel)) return /^rem\b/i.test(t) || t.startsWith('::');
  if (/\.ps1$/i.test(rel)) return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};
const INVOKE_RE = [/npx\s+electron-builder|electron-builder\s+--win|['"]electron-builder['"]/,
  /\bnpm run build:|\bvite build\b|\btsc -p\b/, /打包\.mjs|dist\.js|bump-version\.js/];
const scanned = ['.', 'scripts'].flatMap((d) => {
  try {
    return readdirSync(join(ROOT, d)).filter((f) => /\.(bat|cmd|ps1|mjs|js)$/.test(f)).map((f) => (d === '.' ? f : join(d, f)));
  } catch { return []; }
}).filter((rel) => {
  const base = rel.split(/[\\/]/).pop() ?? '';
  return !/^verify-/.test(base) && !/-test\.(mjs|js)$/.test(base); // 验收门不是发布入口（它们真跑也会被子门拦下）
});
const matrix: { rel: string; guarded: boolean; delegated: string }[] = [];
for (const rel of scanned) {
  const abs = join(ROOT, rel.replace(/\\/g, '/'));
  if (!statSync(abs).isFile()) continue;
  const body = readFileSync(abs, 'utf8');
  const acts = body.split(/\r?\n/).filter((l) => !stripComment(rel, l));
  if (!acts.some((l) => INVOKE_RE.some((re) => re.test(l)))) continue;
  const delegated = BATS.concat(['打包.mjs', 'dist.js', 'publish-oneclick.ps1']).filter((t) => body.includes(t)).join('/');
  matrix.push({ rel: rel.replace(/\\/g, '/'), guarded: /head-precheck/.test(body), delegated });
}
const npmEntries = Object.entries(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>)
  .filter(([, v]) => /dist\.js|打包\.mjs|electron-builder/.test(v));
note(`[矩阵] 发布入口 ${matrix.length} 条：${matrix.map((m) => `${m.rel}${m.guarded ? '(直接含守卫)' : `(经 ${m.delegated || '无'} 间接)`}`).join('、')}`
  + `；npm 脚本 ${npmEntries.map(([k, v]) => `${k}=${v}`).join(' / ')}`);
const guardedTargets = new Set(matrix.filter((m) => m.guarded).map((m) => m.rel.split(/[\\/]/).pop()));
ok('W-01 入口矩阵完整：每条会产出安装包的入口都走到同一份守卫（没有第四条旁路）',
  matrix.length >= 4
  && matrix.every((m) => m.guarded || m.delegated.split('/').some((t) => guardedTargets.has(t)))
  && ['scripts/打包.mjs', 'scripts/dist.js'].every((rel) => matrix.some((m) => m.rel === rel && m.guarded))
  && BATS.every((b) => matrix.some((m) => m.rel.endsWith(b) && m.guarded))
  && npmEntries.length >= 1 && npmEntries.every(([, v]) => guardedTargets.has((v.match(/([\w.-]+\.(?:mjs|js))/)?.[1] ?? ''))),
  `入口=${matrix.map((m) => `${m.rel}:${m.guarded ? 'G' : `D(${m.delegated || '无'})`}`).join(' ') || '空'}｜npm=${npmEntries.map(([k]) => k).join(',')}`);
const headHasGuard = (rel: string): boolean => {
  try { return /head-precheck/.test(git('show', `HEAD:${rel}`)); } catch { return false; }
};
ok('W-02 配对取证（反模式 11：锚点取 HEAD 而非工作树）：三条新入口在 HEAD 里都还没有守卫（守卫确为本单新增，不是既有事实的复读）',
  ['scripts/构建打包.bat', 'scripts/build-pack-t.bat', 'scripts/dist.js'].every((rel) => !headHasGuard(rel)),
  `HEAD 已含 head-precheck 的=${['scripts/构建打包.bat', 'scripts/build-pack-t.bat', 'scripts/dist.js'].filter(headHasGuard).join('、') || '(无)'}`);
ok('W-03 工单前提订正：单面点名的「根目录 打包.bat」在本仓不存在（工作树与 HEAD 都查无）——真实旁路是 scripts/ 下两枚 .bat 与 npm run dist',
  !existsSync(join(ROOT, '打包.bat'))
  && !(git('ls-tree', '--name-only', 'HEAD').split(/\r?\n/).includes('打包.bat'))
  && BATS.every((b) => existsSync(join(ROOT, 'scripts', b))),
  `根目录 打包.bat（工作树）=${existsSync(join(ROOT, '打包.bat'))}｜scripts 两枚 .bat 在位=${BATS.join('、')}`);
// 兜底：夹具里的 native-switch.bat 一律换成「只报错不干活」——万一守卫和停车阀同时失效，
// 也到不了 electron-builder，绝不会去覆写 junction 另一端的真实原生二进制。
for (const copy of [WT_RED, WT_GREEN, WT_DIST]) {
  if (existsSync(join(copy, 'scripts', 'native-switch.bat'))) {
    writeFileSync(join(copy, 'scripts', 'native-switch.bat'),
      '@echo off\r\necho T02355-NATIVE-SWITCH-BLOCKED\r\nexit /b 97\r\n', 'ascii');
  }
}

// ---------- W-04…W-11：.bat 入口（本单之前完全没有预检的那条路） ----------
// 注：WT_RED 在 V-07/V-09 已被「跳过」轮构建过（那是打包.mjs 的既有断言），所以这里
// 「拦在构建之前」的信号取 [4/7] 缺席 + release 目录为空 + 版本号未递增，而不是产物目录为空。
const VER_RED_BEFORE = versionOf(WT_RED);
const subBeforeBat = subResults(WT_RED).length;
const batA = RED.shaShort ? runBat(WT_RED, BATS[0]) : { code: -1, out: '未执行' };
note(`[证据] ${BATS[0]} @ 红 HEAD ${RED.shaShort} exit=${batA.code} 子门结果 ${subBeforeBat} → ${subResults(WT_RED).length}｜${tail(batA.out)}`);
const subBatA = RED.shaShort ? newestSub(WT_RED) : { file: '', text: '' };
ok(`W-04 红 HEAD 走 ${BATS[0]} 被拦下：非零退出（实测 exit=${batA.code}），回显点名夹具 commit`,
  batA.code !== 0 && batA.out.includes(RED.shaShort), `HEAD ${RED.shaShort}｜尾：${batA.out.replace(/\r?\n/g, ' ').slice(-240)}`);
ok('W-05 拦在构建之前：输出有 [3/7] 但没有 [4/7]，没有 release 目录（安装包没被生成），夹具版本号也没递增',
  /\[3\/7\]/.test(batA.out) && !/\[4\/7\]/.test(batA.out) && releaseDirs(WT_RED).length === 0 && versionOf(WT_RED) === VER_RED_BEFORE,
  `[4/7]=${/\[4\/7\]/.test(batA.out)} release=${releaseDirs(WT_RED).join('、') || '(无)'} 版本=${VER_RED_BEFORE}→${versionOf(WT_RED)}`);
ok('W-06 拦截归因正确：子门结果文件新增一条，且红在「HEAD 副本 server tsc」上（不是 .bat 自己的语法/前置问题）',
  subResults(WT_RED).length === subBeforeBat + 1 && !!subBatA.file && /FAIL H-05/.test(subBatA.text) && !/FAIL H-0[1-4]/.test(subBatA.text),
  `结果文件 ${subBeforeBat} → ${subResults(WT_RED).length}｜${(subBatA.text.match(/FAIL H-\d\d/g) ?? []).join('、') || '无 FAIL 行'}`);
const subBeforeSkip = subResults(WT_RED).length;
const batSkip = RED.shaShort
  ? runBat(WT_RED, BATS[0], { MTASK_SKIP_HEAD_CHECK: '1', MTASK_BUILD_STOP_AFTER_PRECHECK: '1' })
  : { code: -1, out: '未执行' };
note(`[证据] ${BATS[0]} @ 红 HEAD + SKIP+停车阀 exit=${batSkip.code}｜${tail(batSkip.out)}`);
ok('W-07 .bat 侧逃生开关按预期放行：红 HEAD + MTASK_SKIP_HEAD_CHECK=1 → 打出 SKIP-HEAD-CHECK 且停在预检后（子门结果文件零新增）',
  batSkip.code === 0 && batSkip.out.includes('SKIP-HEAD-CHECK') && subResults(WT_RED).length === subBeforeSkip && !/\[4\/7\]/.test(batSkip.out),
  `exit=${batSkip.code} 标记=${batSkip.out.includes('SKIP-HEAD-CHECK')} 结果文件 ${subBeforeSkip} → ${subResults(WT_RED).length}`);
ok('W-08 放行走的是「跳过分支」而不是「预检自己判了个绿」：同一红夹具，拦停轮有子门结果、跳过轮一条都不新增',
  subBatA.file !== '' && subResults(WT_RED).length === subBeforeSkip && !/SKIP-HEAD-CHECK/.test(batA.out),
  `拦停轮子门=${subBatA.file || '(无)'}｜跳过轮新增=${subResults(WT_RED).length - subBeforeSkip}`);
const batGreen = GREEN.shaShort
  ? runBat(WT_GREEN, BATS[0], { MTASK_BUILD_STOP_AFTER_PRECHECK: '1' })
  : { code: -1, out: '未执行' };
const subBatGreen = GREEN.shaShort ? newestSub(WT_GREEN) : { file: '', text: '' };
note(`[证据] ${BATS[0]} @ 绿 HEAD ${GREEN.shaShort} + 停车阀 exit=${batGreen.code} 子门=${subBatGreen.file || '缺失'}｜${tail(batGreen.out)}`);
ok('W-09 负对照（本单改动真的实跑过 .bat，不是只看脚本文本）：绿 HEAD + 停车阀 → exit 0、子门跑过且零 FAIL、日志点名绿夹具 commit',
  batGreen.code === 0 && /\[3\/7\]/.test(batGreen.out) && !/\[4\/7\]/.test(batGreen.out) && !/SKIP-HEAD-CHECK/.test(batGreen.out)
  && !!subBatGreen.file && !/FAIL H-/.test(subBatGreen.text) && batGreen.out.includes(GREEN.shaShort),
  `exit=${batGreen.code} 子门=${subBatGreen.file || '缺失'}｜${(subBatGreen.text.match(/FAIL H-\d\d/g) ?? []).join('、') || '无 FAIL'}｜尾：${batGreen.out.replace(/\r?\n/g, ' ').slice(-160)}`);
// 承重对照：只摘掉 .bat 里那一行守卫调用，其余一字不动 → 红 HEAD 必须变成「放行到停车阀」
const batPath = join(WT_RED, 'scripts', BATS[0]);
const batBody = readFileSync(batPath, 'utf8');
const guardLine = batBody.split(/\r?\n/).find((l) => l.includes('head-precheck.mjs') && !/^\s*REM/i.test(l)) ?? '';
writeFileSync(batPath, batBody.replace(guardLine, 'node -e "process.exit(0)"'), 'utf8');
const subBeforeN = subResults(WT_RED).length;
const batN = runBat(WT_RED, BATS[0], { MTASK_BUILD_STOP_AFTER_PRECHECK: '1' });
writeFileSync(batPath, batBody, 'utf8');
note(`[证据] ${BATS[0]} @ 红 HEAD + 守卫摘除 + 停车阀 exit=${batN.code}｜${tail(batN.out)}`);
ok('W-10 守卫是承重的（不是摆设）：同一红夹具只摘掉 .bat 那一行守卫调用 → 立刻放行（exit 0、子门零新增、没打跳过标记）',
  batN.code === 0 && !/SKIP-HEAD-CHECK/.test(batN.out) && subResults(WT_RED).length === subBeforeN && !!guardLine,
  `exit=${batN.code} 守卫行=${guardLine.trim().slice(0, 60) || '没找到'}｜结果文件 ${subBeforeN} → ${subResults(WT_RED).length}`);
const batAlt = RED.shaShort ? runBat(WT_RED, BATS[1]) : { code: -1, out: '未执行' };
note(`[证据] ${BATS[1]} @ 红 HEAD ${RED.shaShort} exit=${batAlt.code}｜${tail(batAlt.out)}`);
ok(`W-11 孪生入口 ${BATS[1]}（与 ${BATS[0]} 只差托管 Node 路径）同样被拦下——没有漏改第二枚 .bat`,
  batAlt.code !== 0 && batAlt.out.includes(RED.shaShort) && !/\[4\/7\]/.test(batAlt.out)
  && releaseDirs(WT_RED).length === 0 && versionOf(WT_RED) === VER_RED_BEFORE,
  `exit=${batAlt.code}｜尾：${batAlt.out.replace(/\r?\n/g, ' ').slice(-180)}`);

// ---------- W-12…W-15：npm run dist 背后的 scripts/dist.js ----------
if (GREEN.shaShort) writeFileSync(join(WT_GREEN, 'scripts', 'lib', 'abi-switch.mjs'), DIST_STUB, 'utf8');
const subBeforeDist = subResults(WT_DIST).length;
const distA = DIST.shaShort ? runDist(WT_DIST) : { code: -1, out: '未执行' };
note(`[证据] dist.js @ 红 HEAD ${DIST.shaShort} exit=${distA.code} 子门 ${subBeforeDist} → ${subResults(WT_DIST).length}｜${tail(distA.out)}`);
ok(`W-12 红 HEAD 走 npm run dist（scripts/dist.js）被拦下：非零退出（实测 exit=${distA.code}）并点名夹具 commit`,
  distA.code !== 0 && distA.out.includes(DIST.shaShort), `HEAD ${DIST.shaShort}｜尾：${distA.out.replace(/\r?\n/g, ' ').slice(-240)}`);
ok('W-13 拦在 ABI 切换之前：没有出现 ABI 快照/切换标记，没调用过（假）electron-builder，夹具里也没有 release*——原生二进制一根字节没被碰',
  !distA.out.includes('T02355-ABI-SNAPSHOT') && !distA.out.includes('T02355-ABI-CALLED')
  && !distA.out.includes('FAKE-BUILDER') && releaseDirs(WT_DIST).length === 0 && builtArtifacts(WT_DIST).length === 0
  && subResults(WT_DIST).length === subBeforeDist + 1,
  `快照=${distA.out.includes('T02355-ABI-SNAPSHOT')} 切换=${distA.out.includes('T02355-ABI-CALLED')} builder=${distA.out.includes('FAKE-BUILDER')} 子门结果 ${subBeforeDist} → ${subResults(WT_DIST).length}`);
const distSkip = DIST.shaShort ? runDist(WT_DIST, ['--skip-head-check', '--dir']) : { code: -1, out: '未执行' };
const fakeArgs = existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8') : '';
note(`[证据] dist.js @ 红 HEAD + --skip-head-check --dir exit=${distSkip.code}｜builder 记账：${fakeArgs.replace(/\r?\n/g, ' ⏎ ').trim() || '(没调用)'}`);
ok('W-14 显式跳过时 dist 入口照常放行：SKIP-HEAD-CHECK 在、走到 electron-builder 调用点、参数原样透传，而开关本身不漏进 builder 命令行',
  distSkip.out.includes('SKIP-HEAD-CHECK') && distSkip.out.includes('FAKE-BUILDER')
  && subResults(WT_DIST).length === subBeforeDist + 1 // 「+1」是 W-12 拦停轮留下的那一条：跳过轮不该再新增
  && fakeArgs.includes('--dir') && fakeArgs.includes('-c.buildVersion=') && !fakeArgs.includes('--skip-head-check'),
  `exit=${distSkip.code} 子门结果 ${subBeforeDist} → ${subResults(WT_DIST).length}（预期 ${subBeforeDist + 1}）builder 实收参数=${fakeArgs.trim().slice(0, 200) || '(没调用)'}`);
const distGreen = GREEN.shaShort ? runDist(WT_GREEN) : { code: -1, out: '未执行' };
const subDistGreen = GREEN.shaShort ? newestSub(WT_GREEN) : { file: '', text: '' };
note(`[证据] dist.js @ 绿 HEAD ${GREEN.shaShort} exit=${distGreen.code} 子门=${subDistGreen.file || '缺失'}｜${tail(distGreen.out)}`);
ok('W-15 负对照（dist 侧不是逢跑必红）：绿 HEAD + 不带开关 → 预检跑过且零 FAIL，一路放行到 electron-builder 调用点',
  distGreen.code === 0 && distGreen.out.includes('FAKE-BUILDER') && !!subDistGreen.file && !/FAIL H-/.test(subDistGreen.text)
  && distGreen.out.includes(GREEN.shaShort) && !/SKIP-HEAD-CHECK/.test(distGreen.out),
  `exit=${distGreen.code} 子门=${subDistGreen.file || '缺失'}｜${(subDistGreen.text.match(/FAIL H-\d\d/g) ?? []).join('、') || '无 FAIL'}`);

// ---------- 收口：夹具删除（junction 必须先解除）+ 真实仓库零污染 ----------
const removed: string[] = [];
for (const copy of [WT_RED, WT_GREEN, WT_DIST]) {
  if (!existsSync(copy)) { removed.push(copy); continue; }
  try { rmSync(join(copy, 'node_modules'), { force: true }); } catch { /* 交给 worktree remove 失败后兜底 */ }
  if (existsSync(join(copy, 'node_modules'))) continue; // junction 没解除就别往下删（会顺链删根依赖）
  try { git('worktree', 'remove', '--force', copy); removed.push(copy); } catch {
    try { rmSync(copy, { recursive: true, force: true }); git('worktree', 'prune'); removed.push(copy); } catch { /* 记入断言 */ }
  }
}
if (!KEEP) rmSync(NESTED, { recursive: true, force: true });
git('worktree', 'prune'); // 无论上面删掉几个，都让注册表与磁盘对齐（残留登记会污染下一轮 WT_COUNT_BEFORE）
const wtList = git('worktree', 'list');
const wtGone = [WT_RED, WT_GREEN, WT_DIST].filter((c) => !existsSync(c)).length;
const rootSqliteAfter = hashOf(SQLITE_NODE);
ok('V-12 清理：三个夹具目录都已消失（junction 先解除），worktree 注册表无残留且不指向临时根',
  wtGone === 3 && !wtList.includes(TMP_ROOT.replace(/\\/g, '/')) && wtList.trim().split(/\r?\n/).length <= WT_COUNT_BEFORE,
  `目录已消失 ${wtGone}/3（worktree remove 成功：${removed.length}/3）｜注册表 ${wtList.trim().split(/\r?\n/).length} 条（起始 ${WT_COUNT_BEFORE}）`);
ok('V-13 真实仓库零污染：HEAD 未移动、根 node_modules 原生二进制逐字节未变、夹具文件名没漏进真实工作树',
  git('rev-parse', 'HEAD').trim() === HEAD_SHA && rootSqliteAfter === SQLITE_HASH_BEFORE
  && !git('status', '--porcelain').includes('t02321packprobe'),
  `HEAD=${git('rev-parse', 'HEAD').trim().slice(0, 7)} better_sqlite3=${SQLITE_HASH_BEFORE}→${rootSqliteAfter}`);
// 夹具跑的是「工作树版本的入口」——必须确认真实工作区那五份文件没被反向写回（含被摘掉的守卫）
const entryDrift = OVERLAY.filter((rel) => {
  const now = hashOf(join(ROOT, ...rel.split('/')));
  return now !== (ENTRY_HASH_BEFORE.get(rel) ?? '<缺>');
}).map((rel) => rel.split('/').pop());
ok('W-16 入口文件本身没被跑脏：五份入口（含被摘过守卫又还原的那份）逐字节与本轮开始一致',
  entryDrift.length === 0, `发生变化=${entryDrift.join('、') || '(无)'}`);
const ALL_OUT = [runA.out, runB.out, runC.out, batA.out, batSkip.out, batGreen.out, batN.out, batAlt.out, distA.out, distSkip.out, distGreen.out].join('\n');
ok('W-17 兜底桩没被触发：整轮没有任何一路走到 native-switch（原生 ABI 切换的最后一道保险始终安静），真 builder 也从未被调用',
  !ALL_OUT.includes('T02355-NATIVE-SWITCH-BLOCKED')
  && (existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').split(/\r?\n/).filter(Boolean).every((l) => l.includes('FAKE-BUILDER')) : true)
  && !ALL_OUT.includes('npmRebuild') && !/  •\s*executing /i.test(ALL_OUT),
  `假件记账 ${existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').split(/\r?\n/).filter(Boolean).length : 0} 条`);

const summary = `PASS=${pass} FAIL=${fail}\n门：verify-t02321-pack-precheck · 基线 HEAD ${HEAD_SHA.slice(0, 7)} · 夹具红 ${RED.shaShort} / 绿 ${GREEN.shaShort} / 记账桩 ${DIST.shaShort}\n`
  + `四条发布入口在夹具副本内共实跑 11 轮（打包.mjs 3 轮 + .bat 5 轮 + dist.js 3 轮），断言 ${pass + fail} 条；`
  + `桩边界 exit=${STUB_EXIT} 之前的步骤全部真跑，构建末段由 native-switch 兜底桩与假 electron-builder 挡在仓库之外\n${LINES.join('\n')}\n`;
console.log(`\nPASS=${pass} FAIL=${fail}`);
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02321-pack-precheck-gate-results.txt', summary,
  { note: `基线 HEAD ${HEAD_SHA.slice(0, 7)}；夹具红 ${RED.shaShort} / 绿 ${GREEN.shaShort}` });
console.log(`结果文件：${resultsFile}`);
process.exit(fail > 0 ? 1 : 0);
