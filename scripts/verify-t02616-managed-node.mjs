/**
 * T02616 验收门：两枚发布 `.bat` 的「托管 Node 按可用性解析」是不是真的在跑，而不是又一行注释。
 *
 * 被治的缺陷（工单现场，2026-10-19 实测）：`scripts/构建打包.bat` 与 `scripts/build-pack-t.bat`
 * 把 WorkBuddy 托管 Node 目录写死成 `...versions\22.22.2-3` / `...versions\22.22.2`，两个目录都
 * 已不存在（现在只有 `22.22.2-6` 与 `current`）。`if exist` 判假 → PATH 不改 → 全程用 PATH 上的
 * node（本机 v24 / NODE_MODULE_VERSION 137），而 `build/native/dev` 缓存是 ABI 127——「用托管 Node
 * 匹配原生模块 ABI」这条设计意图静默失效，一声不响，直到 `ERR_DLOPEN_FAILED` 才看得见。
 *
 * 判据形态（服从 `docs/验收门判据规约.md`）：
 *  - 主判据打在**行为**上：夹具版本目录喂给 `scripts/lib/resolve-managed-node.ps1`，看它返回哪个目录
 *    （R 组）；把 `.bat` 在 `REM [1/7]` 之前截断后交给 cmd 真跑，看它把哪个 exe 顶到了 PATH 前面、
 *    回落时有没有出声（B 组）；`scripts/lib/abi-hint.mjs` 从二进制符号读出的三个 ABI 数值与 warn 位（A 组）。
 *  - 字面锚点（纯 ASCII 且行尾不混用、不再有写死的版本目录、块内 echo 无未转义圆括号）一律 `okPair` 配同义行为腿，
 *    行为腿就是这些 `.bat` 文本已被 cmd 真解析执行过（不是我又抄了一份平行文本）。行尾只判「不混用」：
 *    本仓 `core.autocrlf=true`，锚成「必须 LF」会在 HEAD 副本 checkout（CRLF）里假红——实测踩过，见 P-02 注释。
 *  - 取证面按**改判前**定位（不硬写 HEAD，否则入库即恒红）：HEAD 还写着死路径时反证面就是 HEAD；本单入库后再跑，
 *    用 `git log -S` 定位「摘掉写死路径那次提交」的父提交。P-03 要求改判前两枚仍写着、工作树与入库后的 HEAD 都不再写；
 *    N-01 把**改判前那版 .bat**做成同款截断夹具跑一遍，复现「静默」——证明新判据不是恒红，也证明缺陷确实在改判前。
 *  - 每条改动配变异负对照（N-02~N-05）：摘掉 current 指针的存在性校验、把版本序改回字典序、
 *    把回落分支的两行 WARN 换成合法的空 echo、把 ABI 比对条件改成恒告警——各自必须让对应那条腿失去绿。
 *
 * 安全边界（工单「约束」条）：门不跑构建。B-06 用 `MTASK_SKIP_HEAD_CHECK=1` +
 * `MTASK_BUILD_STOP_AFTER_PRECHECK=1` 让真入口停在第 [3/7] 步之后，既不调 `native-switch.bat`
 * 也不碰 `node_modules/better-sqlite3` 的原生二进制（P-05 按字节校验它没被改）。
 * 夹具只在 D: 临时根里；托管 Node 候选目录用 junction 指到「本门自己的 node.exe 所在目录」，
 * 不需要复制 70MB，也不需要机器上真装了某个版本。
 *
 * 用法：node scripts/verify-t02616-managed-node.mjs
 *   夹具落 `MTASK_GATE_TMP`（默认系统 tmpdir；本项目 C: 常年 0 可用，实测请指 D:/code/tmp）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const BATS = ['构建打包.bat', 'build-pack-t.bat'];
const PS_REL = path.join('scripts', 'lib', 'resolve-managed-node.ps1');
const HINT_REL = path.join('scripts', 'lib', 'abi-hint.mjs');
const CUT_MARK = 'T02616-CUT-OK';
const TMP = path.join(process.env.MTASK_GATE_TMP || tmpdir(), `t02616-${process.pid}`);
const MG_REAL = path.dirname(NODE); // 任何能跑本门的机器都有：node.exe 就住在这里

const LINES = [];
const origLog = console.log;
console.log = (...a) => { LINES.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); origLog(...a); };
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond === true) { pass++; console.log(`PASS ${name} :: ${detail}`); return true; }
  fail++; console.log(`FAIL ${name} :: ${detail}`); return false;
};
const { okPair } = await import(new URL('./lib/anchor-pair.mts', import.meta.url).href);
const note = (s) => console.log(s);

const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : '<无>');
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return r.stdout;
};
const HEAD_SHA = git('rev-parse', 'HEAD').trim();
const SQLITE_NODE = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const SQLITE_BEFORE = sha(SQLITE_NODE);
const BAT_BEFORE = new Map(BATS.map((b) => [b, sha(path.join(ROOT, 'scripts', b))]));
const WT_BEFORE = git('worktree', 'list').trim().split(/\r?\n/).length;

mkdirSync(TMP, { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 收尾失败不改结论 */ } });

const envFor = (extra = {}) => ({ ...process.env, TEMP: TMP, TMP, ...extra });
const hasLine = (out, needle) => out.split(/\r?\n/).some((l) => l.includes(needle));
/** 从 [INFO] 行里取 cmd 实际选中的那个 node.exe。 */
const exeOf = (out) => (/exe=(.+)\s*$/m.exec(out.split(/\r?\n/).find((l) => l.includes('build interpreter:')) ?? '') ?? [, ''])[1].trim();

/** 跑一次解析器（真件或变异件）。mgRoot=undefined 时不设环境变量（走 .bat 给的默认根）。 */
function runResolver(psFile, mgRoot) {
  const env = envFor();
  if (mgRoot === undefined) delete env.MTASK_MG_NODE_ROOT; else env.MTASK_MG_NODE_ROOT = mgRoot;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { encoding: 'utf8', env });
  return { code: r.status ?? -1, out: (r.stdout ?? '').replace(/\r/g, '').trim(), err: (r.stderr ?? '').trim() };
}

/**
 * 造托管 Node 夹具根。specs 每项：{name, real?} —— real 用 junction 指到 MG_REAL（目录里就有真 node.exe，
 * B 组要 cmd 真执行它）；否则只建目录（R 组只验「有没有 node.exe」，放一个 1 字节占位即可）。
 * pointer !== undefined 时写 current 指针文件。
 */
function makeMgRoot(label, specs, pointer) {
  const root = path.join(TMP, `mg-${label}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const s of specs) {
    const dir = path.join(root, s.name);
    if (s.real) { symlinkSync(MG_REAL, dir, 'junction'); continue; }
    mkdirSync(dir, { recursive: true });
    if (s.hasNode !== false) writeFileSync(path.join(dir, 'node.exe'), Buffer.from('placeholder'), 'ascii');
  }
  if (pointer !== undefined) writeFileSync(path.join(root, 'current'), pointer, 'ascii');
  return root;
}

/** 截断版 .bat 夹具：产品文本一字不动地取到 `REM [1/7]` 之前，后接切断标记——cmd 执行完解释器接线就收。 */
function makeBatFixture(label, batName, body) {
  const fx = path.join(TMP, `fx-${label}`);
  rmSync(fx, { recursive: true, force: true });
  mkdirSync(path.join(fx, 'scripts', 'lib'), { recursive: true });
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => /^REM \[1\/7\]/.test(l));
  if (idx < 0) throw new Error(`${batName} 里找不到 REM [1/7] 截断锚（入口结构变了，门要跟着改）`);
  const head = lines.slice(0, idx).join('\n');
  writeFileSync(path.join(fx, 'scripts', batName), `${head}\r\necho ${CUT_MARK}\r\nexit /b 0\r\n`, 'ascii');
  for (const rel of [PS_REL, HINT_REL]) writeFileSync(path.join(fx, rel), readFileSync(path.join(ROOT, rel)), 'utf8');
  return { fx, bat: path.join(fx, 'scripts', batName), head };
}

/** cmd 里跑一枚 .bat（路径含中文，引号必须交给 cmd 自己解析 → windowsVerbatimArguments）。 */
function runBat(absBat, cwd, extraEnv = {}) {
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `call "${absBat}"`], {
    cwd, encoding: 'utf8', shell: false, timeout: 240_000, windowsVerbatimArguments: true, env: envFor(extraEnv),
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, err: r.error ? r.error.message : '' };
}

const batBodies = new Map(BATS.map((b) => [b, readFileSync(path.join(ROOT, 'scripts', b), 'utf8')]));

/**
 * 反证面（「改判前那版 .bat」）不能硬写 HEAD：本门在提交前跑时 HEAD 恰好就是改判前，
 * 提交后再跑，HEAD 已含修复，硬写 HEAD 会让 P-03/N-01 变成「入库即恒红」的自杀式判据。
 * 这里按事实定位——HEAD 还写着死路径就用 HEAD；否则用 pickaxe 找出「摘掉写死路径那次提交」的父提交。
 */
const PINNED_LIT = 'binaries\\node\\versions\\22.22.2';
const PINNED_RE = /binaries\\node\\versions\\[^\s"']+/;
const pinnedIn = (ref) => BATS.filter((b) => PINNED_RE.test(git('show', `${ref}:scripts/${b}`)));
const PRE_REF = pinnedIn('HEAD').length === 2 ? 'HEAD' : (() => {
  const h = git('log', '--format=%H', '-S', PINNED_LIT, '--', `scripts/${BATS[0]}`).trim().split(/\r?\n/)[0];
  if (!h) throw new Error(`改判前反证面无从建立：HEAD 无死路径，且按 -S '${PINNED_LIT}' 定位不到摘掉它的提交`);
  return `${h}^`;
})();
const preBodies = new Map(BATS.map((b) => [b, git('show', `${PRE_REF}:scripts/${b}`)]));
note(`[取证面] 反证面=${PRE_REF}（HEAD ${HEAD_SHA.slice(0, 7)} 是否仍写死=${pinnedIn('HEAD').length === 2}）`);

// 一次跑完所有需要的场景，后面各组只读这些结果（每轮 cmd ≈ 秒级，别重复起）。
const ABSENT = path.join(TMP, 'mg-absent');
const MG_LIVE = makeMgRoot('live', [{ name: '1.0.0-1', real: true }, { name: '22.9.9-7', real: true }]);
const MG_LIVE_CHOSEN = path.join(MG_LIVE, '22.9.9-7');
const MG_LIVE_EXE = path.join(MG_LIVE_CHOSEN, 'node.exe');
const runs = {};
for (const b of BATS) {
  const f = makeBatFixture(`run-${b}`, b, batBodies.get(b));
  runs[b] = { f, absent: runBat(f.bat, f.fx, { MTASK_MG_NODE_ROOT: ABSENT }), live: runBat(f.bat, f.fx, { MTASK_MG_NODE_ROOT: MG_LIVE }) };
}
// 对照组：同一 env 下 PATH 上第一个 node 是谁（B-奇数条用它证明「回落真的落到了 PATH」）
const pathWinRes = spawnSync('cmd.exe', ['/d', '/s', '/c', 'where node'], { encoding: 'utf8', shell: false, windowsVerbatimArguments: true, cwd: ROOT, env: envFor({ MTASK_MG_NODE_ROOT: ABSENT }) });
const pathWin = (pathWinRes.stdout ?? '').split(/\r?\n/)[0].trim();

// ---------- P 组：前置与卫生（含改判前面配对取证） ----------
const chanPs = spawnSync('powershell.exe', ['-NoProfile', '-Command', '1+1'], { encoding: 'utf8' });
ok('P-01 前置：两枚入口 / 解析器 / ABI 提示都在位，powershell 与 cmd→node 两条通道起得来',
  BATS.every((b) => existsSync(path.join(ROOT, 'scripts', b))) && existsSync(path.join(ROOT, PS_REL)) && existsSync(path.join(ROOT, HINT_REL))
  && chanPs.status === 0 && runs[BATS[0]].absent.code !== undefined && runs[BATS[0]].absent.err === '',
  `ps=${chanPs.status}｜cmd 通道首枚 exit=${runs[BATS[0]].absent.code} error=${runs[BATS[0]].absent.err || '(无)'}`);

const batBytes = BATS.map((b) => ({ b, buf: readFileSync(path.join(ROOT, 'scripts', b)) }));
const isAscii = (buf) => !buf.some((x) => x > 0x7f);
/**
 * 行尾只判「不混用」，不判「必须是 LF」。原判锚写成「无 CR」，HEAD 副本 worktree 里当场假红：
 * 本仓 `core.autocrlf=true`，跟踪的 blob 是 LF，但 checkout 落盘就是 CRLF——锚住的是我手改那次的
 * 工作树字节形态，不是仓库形态；行为腿（cmd 真解析执行）两边都绿，正是规约判据 3 说的「字面锚点失配（行为在）」。
 * cmd 真正怕的是非 ASCII 字节在 ANSI 代码页下被误解，与行尾无关。
 */
const oneEnding = (buf) => buf.includes(0x0d) === /\r\n/.test(buf.toString('latin1')) && !buf.toString('latin1').includes('\n\r');
okPair(ok, 'P-02 两枚 .bat 仍是纯 ASCII、行尾不混用（cmd 在 ANSI 代码页下可靠解析的前提；LF/CRLF 由 autocrlf 决定，门不锚死其中一种）——行为腿：同一份文本已被 cmd 解析执行到切断点',
  () => BATS.every((b) => runs[b].absent.code === 0 && hasLine(runs[b].absent.out, CUT_MARK) && hasLine(runs[b].live.out, CUT_MARK)),
  () => batBytes.every(({ buf }) => isAscii(buf) && oneEnding(buf)),
  () => ({ 非ASCII: batBytes.filter(({ buf }) => !isAscii(buf)).map((x) => x.b), 行尾混用: batBytes.filter(({ buf }) => !oneEnding(buf)).map((x) => x.b), 行尾形态: batBytes.map(({ b, buf }) => `${b}:${buf.includes(0x0d) ? 'CRLF' : 'LF'}`) }));

const worktreePinned = BATS.filter((b) => PINNED_RE.test(batBodies.get(b)));
const prePinned = BATS.filter((b) => PINNED_RE.test(preBodies.get(b)));
okPair(ok, 'P-03 死路径换成按可用性解析：工作树两枚 .bat 都不再写 versions\\<版本> 字面量，改判前反面（P-03 自己定位的那个面）上两枚仍写着（配对证明是本单换掉的）',
  () => worktreePinned.length === 0 && BATS.every((b) => hasLine(runs[b].absent.out, 'no usable managed node')),
  () => prePinned.length === 2 && worktreePinned.length === 0 && (PRE_REF === 'HEAD' || pinnedIn('HEAD').length === 0),
  () => ({ 反证面: PRE_REF, 工作树仍写死: worktreePinned, 改判前写死: prePinned.map((b) => `${b}:${(PINNED_RE.exec(preBodies.get(b)) ?? [''])[0]}`) }));

/** 历史坑：0.1.0913.63 那次构建在解析期 abort，因为 ( ... ) 块内 echo 文本有未转义圆括号。 */
const parenRisk = BATS.flatMap((b) => {
  const out = [];
  let depth = 0;
  batBodies.get(b).split(/\r?\n/).forEach((l, i) => {
    const t = l.trim();
    if (depth > 0 && /^echo\b/i.test(t) && /\)/.test(t.replace(/^echo\s\.?/i, ''))) out.push(`${b}:${i + 1}:${t.slice(0, 70)}`);
    depth += (l.match(/\(/g) ?? []).length - (l.match(/\)/g) ?? []).length;
    if (depth < 0) depth = 0;
  });
  return out;
});
okPair(ok, 'P-04 块内 echo 没有未转义右括号（守 cmd 提前终止块那条实测坑）——行为腿：含新块的夹具整段被 cmd 执行到切断点',
  () => BATS.every((b) => runs[b].live.code === 0 && hasLine(runs[b].live.out, CUT_MARK)),
  () => parenRisk.length === 0,
  () => ({ 风险行: parenRisk }));

// ---------- R 组：解析器行为（夹具自造版本目录，不依赖本机装了什么） ----------
const PS = path.join(ROOT, PS_REL);
const r01 = runResolver(PS, path.join(TMP, 'mg-does-not-exist'));
ok('R-01 根不存在 → 不输出任何候选路径（宁可空，也不猜一个目录出来）',
  r01.code === 0 && r01.out === '', `exit=${r01.code} stdout=${JSON.stringify(r01.out)} stderr=${JSON.stringify(r01.err.slice(0, 120))}`);

const MG_POINTER_OK = makeMgRoot('pointer-ok', [{ name: '1.2.3-1' }, { name: '9.9.9-9' }], '1.2.3-1');
const r02 = runResolver(PS, MG_POINTER_OK);
ok('R-02 current 指针可用时优先于「版本号最大者」（指针是权威，枚举只是兜底）',
  r02.out === path.join(MG_POINTER_OK, '1.2.3-1'), `实际返回=${r02.out}`);

const MG_POINTER_BAD = makeMgRoot('pointer-bad', [{ name: 'broken', hasNode: false }, { name: '1.0.0-1' }], 'broken');
const r03 = runResolver(PS, MG_POINTER_BAD);
ok('R-03 current 指向的目录没有 node.exe → 不许选它，必须落到枚举并返回可用者',
  r03.out === path.join(MG_POINTER_BAD, '1.0.0-1'), `实际返回=${r03.out}（选到 broken 即为「假可用」）`);

const MG_ENUM = makeMgRoot('enum', [{ name: '1.2.3-9' }, { name: '1.2.3-10' }, { name: '1.2.10-1' }, { name: '2.0.0-0' }, { name: 'zzz-not-a-version' }, { name: 'no-node-dir', hasNode: false }]);
const r04 = runResolver(PS, MG_ENUM);
ok('R-04 无 current → 枚举取版本号最高的可用目录（2.0.0-0；无 node.exe 与被版本解析拒掉的目录都不进候选）',
  r04.out === path.join(MG_ENUM, '2.0.0-0'), `实际返回=${r04.out}`);

const MG_SUFFIX = makeMgRoot('suffix', [{ name: '1.2.3-9' }, { name: '1.2.3-10' }]);
const r05 = runResolver(PS, MG_SUFFIX);
ok('R-05 同版本号不同后缀按数值比（1.2.3-10 > 1.2.3-9）：字典序会选 -9，这条是「按版本序」而非「按字符串」的判别力',
  r05.out === path.join(MG_SUFFIX, '1.2.3-10'), `实际返回=${r05.out}`);

const MG_EMPTY = makeMgRoot('empty', []);
const r06 = runResolver(PS, MG_EMPTY);
ok('R-06 根存在但没有任何可用版本目录 → 空输出（不把根目录自己当答案）',
  r06.code === 0 && r06.out === '', `exit=${r06.code} stdout=${JSON.stringify(r06.out)}`);

// 敌意指针：current 里是非法路径字符 → 必须走异常通道（stderr 出声、stdout 保持空、exit 0），
// 既不能崩了构建，也绝不能把一段错误文本当成路径吐给 .bat 的 for /f。
const MG_HOSTILE = makeMgRoot('hostile', [{ name: '1.0.0-1' }], 'bad*?<>');
const r08 = runResolver(PS, MG_HOSTILE);
ok('R-08 敌意 current 指针（非法路径字符）→ 异常被接住走 stderr，stdout 仍为空、exit 仍为 0（提示件不拦路、也不吐假路径）',
  r08.code === 0 && r08.out === '' && r08.err.includes('resolve-managed-node'),
  `exit=${r08.code} stdout=${JSON.stringify(r08.out)} stderr=${JSON.stringify(r08.err.slice(0, 140))}`);

/** `.bat` 是本机默认根的唯一持有者；门从产品文本里把它抠出来，不另抄一份常量。 */
const DEFAULT_MG_ROOT = (/set "MTASK_MG_NODE_ROOT=([^"]+)"/.exec(batBodies.get(BATS[0])) ?? [, ''])[1];
const r07 = runResolver(PS, DEFAULT_MG_ROOT);
const legacyDirs = BATS.map((b) => (PINNED_RE.exec(preBodies.get(b)) ?? [''])[0]).filter(Boolean);
const realHasManaged = r07.out !== '' && existsSync(path.join(r07.out, 'node.exe'));
ok('R-07 真实机器面：用 .bat 里的默认根解析 → 要么给出一个真有 node.exe 的目录，要么如实给空；而改判前写死的那两个目录都已不存在',
  DEFAULT_MG_ROOT !== '' && legacyDirs.length === 2 && legacyDirs.every((d) => !existsSync(d))
  && (realHasManaged || r07.out === ''),
  `默认根=${DEFAULT_MG_ROOT}｜解析=${r07.out || '(空，本机无托管 Node)'}｜HEAD 死路径存在性=${legacyDirs.map((d) => `${d}:${existsSync(d)}`).join(' ')}`);

// ---------- B 组：.bat 入口行为（截断夹具，cmd 真跑） ----------
BATS.forEach((b, i) => {
  const a = runs[b].absent;
  const l = runs[b].live;
  ok(`B-0${i * 2 + 1} ${b}：托管根缺失时**出声回落**——打 WARN、点名根目录、[INFO] 里的 exe 就是 PATH 上的那个（不是静默继续）`,
    a.code === 0 && hasLine(a.out, 'no usable managed node') && hasLine(a.out, ABSENT)
    && !hasLine(a.out, 'managed node: ') && exeOf(a.out) === pathWin && hasLine(a.out, CUT_MARK),
    `exit=${a.code}｜exe=${exeOf(a.out) || '(无)'} PATH 首个=${pathWin}`);
  ok(`B-0${i * 2 + 2} ${b}：托管根可用时选中的那个 node.exe 真被顶到 PATH 前面（[INFO] 的 exe 就是它，不只是打印了一行路径）`,
    l.code === 0 && hasLine(l.out, `managed node: ${MG_LIVE_CHOSEN}`) && exeOf(l.out) === MG_LIVE_EXE && hasLine(l.out, CUT_MARK),
    `exit=${l.code}｜exe=${exeOf(l.out) || '(无)'} 期望=${MG_LIVE_EXE}`);
});
ok('B-05 夹具诚实性：两个截断夹具的头部逐字是对应真实 .bat 的前缀（跑的就是产品那段文本，不是门里另写的平行版本）',
  BATS.every((b) => batBodies.get(b).startsWith(runs[b].f.head) && runs[b].f.head.includes('resolve-managed-node.ps1')),
  BATS.map((b) => `${b}:${runs[b].f.head.length}/${batBodies.get(b).length}`).join(' '));

const fullRuns = {};
for (const b of BATS) {
  fullRuns[b] = runBat(path.join(ROOT, 'scripts', b), ROOT, { MTASK_MG_NODE_ROOT: MG_LIVE, MTASK_SKIP_HEAD_CHECK: '1', MTASK_BUILD_STOP_AFTER_PRECHECK: '1' });
}
ok('B-06 真入口端到端实跑（不截断、停在第 [3/7] 步之后）：exit 0、走到 [3/7]、没进 [4/7]，且 [INFO] 与 [ABI] 两段都打出来了',
  BATS.every((b) => fullRuns[b].code === 0 && hasLine(fullRuns[b].out, '[3/7]') && !hasLine(fullRuns[b].out, '[4/7]')
  && hasLine(fullRuns[b].out, 'build interpreter:') && hasLine(fullRuns[b].out, '[ABI] interpreter:') && hasLine(fullRuns[b].out, MG_LIVE_CHOSEN)),
  BATS.map((b) => `${b}:exit=${fullRuns[b].code}`).join(' ')
  + `｜[INFO]=${exeOf(fullRuns[BATS[0]].out)}`);
note(`[证据] 真入口只跑到第 [3/7] 步即停；选中的托管 exe=${MG_LIVE_EXE}；[ABI] 行=${(fullRuns[BATS[0]].out.split(/\r?\n/).find((x) => x.includes('[ABI] interpreter')) ?? '').trim()}`);

// ---------- A 组：ABI 提示（数值读自二进制注册符号，不写常量） ----------
const hint = await import(pathToFileURL(path.join(ROOT, HINT_REL)).href);
const collect = (root) => { const lines = []; return { lines, res: hint.report(root, { log: (m) => lines.push(String(m)) }) }; };
const nodeAbi = Number(process.versions.modules);
const real = collect(ROOT);
ok('A-01 工作区现场：三处 ABI 都是从二进制读出的数字，本机解释器与 dev 缓存不一致时确实点名',
  typeof real.res.dev === 'number' && typeof real.res.electron === 'number' && typeof real.res.workspace === 'number'
  && real.res.warn === true && real.res.nodeAbi === nodeAbi,
  `dev=${real.res.dev} electron=${real.res.electron} workspace=${real.res.workspace} 解释器=${nodeAbi} warn=${real.res.warn}`);
const ABI_OF_DEV = real.res.dev;

const FX_MATCH = path.join(TMP, 'fx-match');
mkdirSync(path.join(FX_MATCH, 'build', 'native', 'dev'), { recursive: true });
mkdirSync(path.join(FX_MATCH, 'build', 'native', 'electron'), { recursive: true });
writeFileSync(path.join(FX_MATCH, 'build', 'native', 'dev', 'better_sqlite3.node'), Buffer.from(`prefix node_register_module_v${nodeAbi} suffix`), 'ascii');
writeFileSync(path.join(FX_MATCH, 'build', 'native', 'electron', 'better_sqlite3.node'), Buffer.from('node_register_module_v999'), 'ascii');
const matched = collect(FX_MATCH);
ok('A-02 WARN 由数字比对驱动（不是恒发）：dev 缓存与解释器同 ABI 的夹具必须判「一致」、不告警',
  matched.res.warn === false && matched.res.dev === nodeAbi && hasLine(matched.lines.join('\n'), 'dev 缓存与构建解释器一致'),
  `warn=${matched.res.warn} dev=${matched.res.dev} 解释器=${nodeAbi}｜electron 夹具=${matched.res.electron}`);

const FX_MISS = path.join(TMP, 'fx-miss');
mkdirSync(FX_MISS, { recursive: true });
const missing = collect(FX_MISS);
const cliMissing = spawnSync(NODE, [path.join(ROOT, HINT_REL), FX_MISS], { encoding: 'utf8' });
ok('A-03 缓存缺失只提示不拦路：读不到就说读不到，CLI 退出码恒 0（ABI 提示不能变成新的构建拦路点）',
  missing.res.dev === '缺失' && missing.res.warn === true && hasLine(missing.lines.join('\n'), '缓存不存在') && cliMissing.status === 0,
  `dev=${missing.res.dev} cli exit=${cliMissing.status}`);

const FX_NAPI = path.join(TMP, 'fx-napi.node');
writeFileSync(FX_NAPI, Buffer.from('x napi_register_module_v1 x'), 'ascii');
const FX_PLAIN = path.join(TMP, 'fx-plain.node');
writeFileSync(FX_PLAIN, Buffer.from('no symbols here'), 'ascii');
ok('A-04 符号读取判别力：napi 构件读作 napi（与解释器 ABI 无关，不参与不一致判定）、无符号文件读作 null、不存在的文件也读作 null',
  hint.abiOf(FX_NAPI) === 'napi' && hint.abiOf(FX_PLAIN) === null && hint.abiOf(path.join(TMP, 'no-such.node')) === null
  && hint.abiOf(path.join(ROOT, 'build', 'native', 'electron', 'better_sqlite3.node')) === real.res.electron,
  `napi=${hint.abiOf(FX_NAPI)} 无符号=${String(hint.abiOf(FX_PLAIN))} 真件electron=${hint.abiOf(path.join(ROOT, 'build', 'native', 'electron', 'better_sqlite3.node'))}`);

const managedExe = path.join(r07.out, 'node.exe');
const managedCli = realHasManaged
  ? spawnSync(managedExe, [path.join(ROOT, HINT_REL)], { encoding: 'utf8' })
  : { status: -1, stdout: '' };
const managedOut = `${managedCli.stdout ?? ''}${managedCli.stderr ?? ''}`;
const fallbackRun = runs[BATS[0]].absent;
// 两支都必须由实测证据决定，不给「环境不满足就跳过」留口子：本机有托管 Node 就验正面（设计意图恢复），
// 确实没有就验入口有没有替它出声（那才是缺陷的本体——静默）。
ok('A-05 设计意图恢复的可证伪形式：解析器给出托管 Node 时，用它跑同一份提示必须「解释器 ABI == dev 缓存 ABI 且零 WARN」；本机确实没有托管 Node 时，必须看到入口在第 [1/7] 步之前就出声回落——两支都不成立即判红，不静默跳过',
  realHasManaged
    ? managedCli.status === 0 && hasLine(managedOut, `NODE_MODULE_VERSION=${ABI_OF_DEV}`) && !hasLine(managedOut, '[ABI][WARN]')
    : fallbackRun.code === 0 && hasLine(fallbackRun.out, 'no usable managed node'),
  `本机托管 Node=${realHasManaged}｜exe=${managedExe} exit=${managedCli.status}｜${(managedOut.split(/\r?\n/).find((x) => x.includes('interpreter')) ?? (realHasManaged ? '(无)' : `回落分支 exit=${fallbackRun.code}`)).trim()}`);

// ---------- N 组：负对照（逐条把承重点真破坏一次） ----------
const headFx = makeBatFixture('n01', BATS[1], preBodies.get(BATS[1]));
const headRun = runBat(path.join(headFx.fx, 'scripts', BATS[1]), headFx.fx, { MTASK_MG_NODE_ROOT: ABSENT });
ok('N-01 改判前面反证（新判据不是恒红）：同一场景喂改判前那版 .bat → 一声不响（无 WARN、无 managed node 行、无 [INFO] 行）却照样 exit 0，那就是「静默退化」本身',
  headRun.code === 0 && !hasLine(headRun.out, 'no usable managed node') && !hasLine(headRun.out, 'managed node: ')
  && !hasLine(headRun.out, 'build interpreter:') && hasLine(headRun.out, CUT_MARK),
  `exit=${headRun.code}｜[INFO]=${exeOf(headRun.out) || '(无)'}｜WARN=${hasLine(headRun.out, 'no usable')}`);

const psSrc = readFileSync(PS, 'utf8');
const MUT_NOCHECK = path.join(TMP, 'mut-nocheck.ps1');
const mutNoCheck = psSrc.replace('if ($name -and (Test-NodeDir $name)) { $chosen = $name }', 'if ($name) { $chosen = $name }');
writeFileSync(MUT_NOCHECK, mutNoCheck, 'utf8');
const m02 = runResolver(MUT_NOCHECK, MG_POINTER_BAD);
ok('N-02 变异：摘掉 current 指针的 node.exe 存在性校验 → 当场选中没有 node.exe 的目录（R-03 那条腿有牙齿）',
  mutNoCheck !== psSrc && m02.out === path.join(MG_POINTER_BAD, 'broken'), `变异件返回=${m02.out}`);

const MUT_SORT = path.join(TMP, 'mut-sort.ps1');
const mutSort = psSrc.replace(/Sort-Object -Property \{[\s\S]*?\}, \{[\s\S]*?\} \|/, 'Sort-Object -Property Name |');
writeFileSync(MUT_SORT, mutSort, 'utf8');
const m03 = runResolver(MUT_SORT, MG_SUFFIX);
ok('N-03 变异：把版本序换成字典序 → 同后缀场景选回 1.2.3-9（R-05 的判别力确实来自那段排序）',
  mutSort !== psSrc && m03.out === path.join(MG_SUFFIX, '1.2.3-9'), `变异件返回=${m03.out}`);

const mutBatName = BATS[0];
// 变异必须只摘掉「出声」这件事，不能顺手把 `else ( )` 掏空——空块是 cmd 语法错误（exit 255），
// 那样红的是语法而不是「静默」，负对照就失去了指认对象。这里换成合法的 `echo.`（打一个空行）。
const mutBatSrc = batBodies.get(mutBatName).replace(
  / {4}echo   \[WARN\] no usable managed node[^\n]*\n {4}echo   \[WARN\] this build runs on the node[^\n]*/,
  '    echo.');
const mutFx = makeBatFixture('n04', mutBatName, mutBatSrc);
const m04 = runBat(mutFx.bat, mutFx.fx, { MTASK_MG_NODE_ROOT: ABSENT });
ok('N-04 变异：把回落分支的两行 WARN 换成合法的空 echo（块还在、语法没错）→ 同一场景重新变回静默却仍 exit 0（B-01/B-03 守的就是「不许静默」这一条）',
  mutBatSrc !== batBodies.get(mutBatName) && m04.code === 0 && hasLine(m04.out, CUT_MARK)
  && !hasLine(m04.out, 'no usable managed node'),
  `exit=${m04.code}｜切断点到达=${hasLine(m04.out, CUT_MARK)}｜仍有 [INFO]=${hasLine(m04.out, 'build interpreter:')}`);

const MUT_HINT = path.join(TMP, 'mut-hint.mjs');
const hintSrc = readFileSync(path.join(ROOT, HINT_REL), 'utf8');
const mutHintSrc = hintSrc.replace("typeof found.dev === 'number' && found.dev !== nodeAbi", "typeof found.dev === 'number'");
writeFileSync(MUT_HINT, mutHintSrc, 'utf8');
const mutHint = await import(pathToFileURL(MUT_HINT).href);
const m05Lines = [];
const m05 = mutHint.report(FX_MATCH, { log: (m) => m05Lines.push(String(m)) });
ok('N-05 变异：把 ABI 比对条件改成「读得到就告警」→ 一致夹具也被判红（A-02 的绿是比出来的，不是没跑）',
  mutHintSrc !== hintSrc && m05.warn === true, `warn=${m05.warn}｜首行=${m05Lines[0] ?? '(无)'}`);

// okPair 契约自证**故意**是红的（它验的就是「红因能不能区分」），所以走独立落账通道：
// 只留证据行、不进 pass/fail 计数——否则本门永远 FAIL=2，把真正的红埋掉。
// 判定权交给 N-07：两条自证必须都红且红因各指一方，任一不合 N-07 判红。
const pairCalls = [];
const rec = (name, cond, extra) => { pairCalls.push({ name, cond, extra }); note(`PROBE ${name} :: cond=${cond} extra=${JSON.stringify(extra ?? '')}`); };
okPair(rec, 'N-06a okPair 契约：行为腿 false 必须判红（锚点绿也救不回来）', () => false, () => true);
okPair(rec, 'N-06b okPair 契约：行为腿 true 而锚点 false → 判红，红因是「字面锚点失配」', () => true, () => false);
const redReasons = pairCalls.map((c) => (typeof c.extra === 'string' ? c.extra : JSON.stringify(c.extra ?? '')));
ok('N-07 空根反证 + 红因可区分：解析器对空根返回空输出而不是根目录本身；两条 okPair 自证都红且红因分别指向「行为失守」与「字面锚点失配」',
  r06.out === '' && pairCalls.length === 2 && pairCalls.every((c) => c.cond === false)
  && /行为失守/.test(redReasons[0]) && /字面锚点失配/.test(redReasons[1]),
  `红因0=${redReasons[0].slice(0, 60)}｜红因1=${redReasons[1].slice(0, 60)}`);

// ---------- 收口：真实仓库零污染 ----------
const SQLITE_AFTER = sha(SQLITE_NODE);
const drifted = BATS.filter((b) => sha(path.join(ROOT, 'scripts', b)) !== BAT_BEFORE.get(b));
const WT_AFTER = git('worktree', 'list').trim().split(/\r?\n/).length;
ok('P-05 真实仓库零污染：两枚 .bat 与 node_modules 原生二进制逐字节未变、HEAD 未动、worktree 数量不增',
  drifted.length === 0 && SQLITE_AFTER === SQLITE_BEFORE && git('rev-parse', 'HEAD').trim() === HEAD_SHA && WT_AFTER <= WT_BEFORE,
  `漂移=${drifted.join('、') || '(无)'} better_sqlite3=${SQLITE_BEFORE}→${SQLITE_AFTER} worktree ${WT_BEFORE}→${WT_AFTER}`);
const junctionAlive = existsSync(path.join(MG_REAL, 'node.exe'));
const linksLeft = [];
for (const b of BATS) { for (const k of ['absent', 'live']) { const p = runs[b][k].out; if (/ERR_DLOPEN|CreateProcess|SPAWN-FAILED/.test(p)) linksLeft.push(`${b}/${k}`); } }
ok('P-06 夹具没伤到本体：junction 目标目录仍可执行（node.exe 在位），且没有任何一轮 .bat 输出里出现原生模块加载失败或起不来',
  junctionAlive && linksLeft.length === 0, `目标在位=${junctionAlive} 异常轮=${linksLeft.join('、') || '(无)'}`);

const summary = `PASS=${pass} FAIL=${fail}\n门：verify-t02616-managed-node · 基线 HEAD ${HEAD_SHA.slice(0, 7)} · 断言 ${pass + fail} 条\n`
  + `R 组 8 条（解析器，夹具版本目录 + 敌意指针 + 真实机器面）+ B 组 6 条（两枚 .bat 截断夹具 cmd 真跑 + 真入口停在第 [3/7] 步的端到端）\n`
  + `+ A 组 5 条（ABI 读二进制注册符号）+ N 组 6 条（改判前面静默反证 + 四件变异 + 空根反证与 okPair 红因可区分）+ P 组 6 条（前置/卫生/零污染）\n`
  + `okPair 契约自证两条走 PROBE 通道（故意红，只落证据不进计数）；门自身计数只由真判据决定\n`
  + `字面锚点全部走 okPair 配行为腿；全程不调 native-switch、不跑 electron-builder、不读生产实例\n${LINES.join('\n')}\n`;
origLog(`\nPASS=${pass} FAIL=${fail}`);
const resultsFile = writeGateResults(path.join(ROOT, '.workbuddy'), 't02616-managed-node-gate-results.txt', summary,
  { note: `基线 HEAD ${HEAD_SHA.slice(0, 7)}；托管根夹具 ${MG_LIVE}` });
origLog(`结果文件：${resultsFile}`);
process.exit(fail > 0 ? 1 : 0);
