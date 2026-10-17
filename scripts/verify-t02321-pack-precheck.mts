/**
 * T02321 验收门：HEAD 自洽性预检是不是**真的挡在发布链路上**。
 *
 * 拦的是这条已实测过的静默路径：`scripts/打包.mjs` 的 server typecheck 跑的是**工作树**
 * （= HEAD + 并发会话未提交 hunk 的叠加态），于是「引用已入库、定义没入库」的缺口被别人的 WIP
 * 恰好补齐 → 打包全绿、安装包照出，但按那个 commit 重新 checkout 编译不出来（发布件不可复现）。
 * 本单把 T02295 门接成打包第 [3] 步，判红即中止，`--skip-head-check` 显式逃生。
 *
 * 用法（不读生产数据、不写真实分支；产物只在 D: 上的临时 worktree 里）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02321-pack-precheck.mts
 *   环境变量：T02321_TMP_ROOT（夹具根，默认 D:/code/tmp/t02321-pack-precheck，**勿指 C:**）、
 *             T02321_KEEP=1 保留夹具便于排障（默认整轮跑完删夹具 + worktree prune）。
 *
 * 判据写法服从 T02293：夹具自造（不依赖仓库存量数据）、断言打在**行为**上（子进程退出码、
 * 产物目录是否出现、结果文件内容），不锁实现字面量；每条改法配负对照：
 *   - 「预检失败 → 打包中止、且什么都没构建」的正断言，由 V-09（绿夹具同样跑一遍、照样放行到
 *     构建末段）反向配对——否则「什么都没构建」可能只是夹具里根本跑不起来；
 *   - 「跳过开关 → 放行」由 V-08 的第二半（跳过时预检子门**一个结果文件都不该新增**）配对，
 *     证明放行走的确实是跳过分支，而不是预检自己判了个绿；
 *   - V-11 是本门对自身破坏力的看守：夹具靠 junction 挂真实仓库根 node_modules，若打包真跑到
 *     ABI 切换，覆写的就是本机工作区的原生二进制——桩（stub）挡住后按字节校验。
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
ok('P-02 红/绿两个夹具 worktree 建成（提交只落在临时副本，真实分支未动）',
  !!RED.shaShort && !!GREEN.shaShort && !RED.err && !GREEN.err && git('rev-parse', 'HEAD').trim() === HEAD_SHA,
  `红=${RED.shaShort || '失败'} 绿=${GREEN.shaShort || '失败'} ${RED.err}${GREEN.err}`);

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
  const r = spawnSync(NODE, [join(copy, 'scripts', '打包.mjs'), ...args], {
    cwd: copy, encoding: 'utf8', shell: false, timeout: 1_500_000, maxBuffer: 80 * 1024 * 1024,
    env: { ...process.env, T02295_TMP_ROOT: NESTED, TEMP: TMP_ROOT, TMP: TMP_ROOT },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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
  `exit=${runC.code} 子门结果=${subC.file || '缺失'}｜${(subC.text.match(/FAIL H-\d\d/g) ?? []).join('、') || '无 FAIL'}`);
ok('V-11 放行轮的预检步在日志里点名了自己检的是哪个 commit（绿夹具短号可见）',
  runC.out.includes(GREEN.shaShort), `期望含 ${GREEN.shaShort}`);

// ---------- 收口：夹具删除（junction 必须先解除）+ 真实仓库零污染 ----------
const removed: string[] = [];
for (const copy of [WT_RED, WT_GREEN]) {
  if (!existsSync(copy)) { removed.push(copy); continue; }
  try { rmSync(join(copy, 'node_modules'), { force: true }); } catch { /* 交给 worktree remove 失败后兜底 */ }
  if (existsSync(join(copy, 'node_modules'))) continue; // junction 没解除就别往下删（会顺链删根依赖）
  try { git('worktree', 'remove', '--force', copy); removed.push(copy); } catch {
    try { rmSync(copy, { recursive: true, force: true }); git('worktree', 'prune'); removed.push(copy); } catch { /* 记入断言 */ }
  }
}
if (!KEEP) rmSync(NESTED, { recursive: true, force: true });
const wtList = git('worktree', 'list');
const rootSqliteAfter = hashOf(SQLITE_NODE);
ok('V-12 清理：两个夹具 worktree 已移除（junction 先解除），worktree 注册表无残留且不指向临时根',
  removed.length === 2 && !wtList.includes(TMP_ROOT.replace(/\\/g, '/')) && wtList.trim().split(/\r?\n/).length <= WT_COUNT_BEFORE,
  `已移除 ${removed.length}/2｜注册表 ${wtList.trim().split(/\r?\n/).length} 条（起始 ${WT_COUNT_BEFORE}）`);
ok('V-13 真实仓库零污染：HEAD 未移动、根 node_modules 原生二进制逐字节未变、夹具文件名没漏进真实工作树',
  git('rev-parse', 'HEAD').trim() === HEAD_SHA && rootSqliteAfter === SQLITE_HASH_BEFORE
  && !git('status', '--porcelain').includes('t02321packprobe'),
  `HEAD=${git('rev-parse', 'HEAD').trim().slice(0, 7)} better_sqlite3=${SQLITE_HASH_BEFORE}→${rootSqliteAfter}`);

const summary = `PASS=${pass} FAIL=${fail}\n门：verify-t02321-pack-precheck · 基线 HEAD ${HEAD_SHA.slice(0, 7)} · 夹具红 ${RED.shaShort} / 绿 ${GREEN.shaShort}\n`
  + `打包脚本在夹具副本内实跑 3 轮（红拦下 / 红跳过 / 绿放行），桩边界 exit=${STUB_EXIT} 之前的步骤全部真跑\n${LINES.join('\n')}\n`;
console.log(`\nPASS=${pass} FAIL=${fail}`);
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02321-pack-precheck-gate-results.txt', summary,
  { note: `基线 HEAD ${HEAD_SHA.slice(0, 7)}；夹具红 ${RED.shaShort} / 绿 ${GREEN.shaShort}` });
console.log(`结果文件：${resultsFile}`);
process.exit(fail > 0 ? 1 : 0);
