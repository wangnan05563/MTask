/**
 * T02312 回归门（T02293 改判版）：UI 门截图落盘隔离命名（固定名目录 → 每轮一个带运行标识的子目录）。
 *
 * 本轮改判口径（`docs/验收门判据规约.md` 四条硬判据 + 反模式 11/14，样板 verify-t02104/2105）：
 *  ① 旧版 S-01..S-06、S-17 全部是「读工作树源码做正则匹配」的字面锚。本版一律降级为 `okPair` 的
 *    **字面腿**，行为腿取本门 B 组探针的**实测结果**（gateShotsDir 两轮目录互异、两份证据并存、
 *    旧口径真互覆……），且配对项声明成惰性数组、实测组跑完统一发射（反模式 14）。
 *  ② 字面腿与被比对的门源码一律取 `git show HEAD:<path>` / `git ls-tree HEAD`（反模式 11：
 *    工作树可能躺着并发会话的过期 WIP，读工作树会把「别人没提交」判成本门失守）。
 *  ③ 旧版 S-07「断言标签与 HEAD 逐字一致」在改造入库之后就是 HEAD 比 HEAD——**恒真的空判据**；
 *    本版改成历史产物断言 H-01：取 T02312 落地 commit（按提交信息检索，不写死哈希）与其父提交，
 *    逐门比对两版标签多重集一致（「只改盘点没改判据名」这条工单判据的真实形态），
 *    并配牙齿 H-02：人为改名一个标签，同一比对器必须报出差异。
 *  旧版 G-01「verify-t02205-guard-selfcheck.mts 保持 8/0」是对**移动靶**的现状断言：t02205 扫的是
 *    全仓门锚点，任何并发会话的 WIP 都能让它非 8/0（本轮实测：工作树 5/3、HEAD 副本 6/2、
 *    T02312 落地当时也只有 7/1——工单写下「8/0」后该状态就再未在任何稳定树上复现，按判据 2
 *    属「门不得断言外部现状」）。本版拆成三条：
 *    G-01 行为腿：t02205 在当前树**跑得起来、裁决可解析、判定点 ≥8**（审计器存活，不断言全绿）；
 *    G-02 不变性：t02205 在 T02312 commit 与其父 commit 两份 detached worktree 副本里裁决一致
 *          （「本次改造没动到守卫门的结论」的真实含义；共享 lib 若被改坏，两副本都会崩、这里就红）；
 *    G-03 负对照（判据 4）：往 T02312 副本里**破坏守卫门 import 的共享 lib**（gate-results.mts 顶层抛错），
 *          同一「一致性」判据必须因此转红（植入后裁决不再与父本相等/跑崩 ⇒ G-02 的相等不是两份
 *          相同崩溃的巧合）。实测回补：植入「未提交的假门文件」不会被点名——t02205 的门文本取自
 *          该 worktree 的已提交树，未提交文件根本不进它的视野（反模式 12 的近亲：负对照要破坏
 *          行为本身，不能给旧世界补零件）。
 *  环境缺口（副本建不起、t02205 跑崩）记 skipped()，不冒充 PASS/FAIL。
 *
 * 全程静态 + 临时目录子进程 + 只读 worktree 副本，不启服务、不碰生产库、不开浏览器
 * （真机走查由被改的 7 道门自己负责）；主仓工作树零写入（植入只发生在副本里，用后即删）。
 * 用法：`node_modules/tsx/dist/cli.mjs scripts/verify-t02312-shots-isolation.mts`
 * 环境变量：T02312_TMP_ROOT（临时根，默认 D:/code/tmp/gate-tmp/t02312-<pid>；本机 C: 常年 0 可用）、
 *           T02312_MAIN_REPO_ROOT（node_modules junction 源，默认本仓根）
 */
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { okPair } from './lib/anchor-pair.mts';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TMP_ROOT = process.env.T02312_TMP_ROOT ?? join('D:/code/tmp/gate-tmp', `t02312-${process.pid}`);
mkdirSync(TMP_ROOT, { recursive: true });

const GATES = [
  'verify-t02039-e4-ui.mjs', 'verify-t02040-ui.mjs', 'verify-t02041-ui.mjs', 'verify-t02043-ui.mjs',
  'verify-t02044-ui.mjs', 'verify-t02046-ui.mjs', 'verify-t02047-ui.mjs',
];
const LIB = join(ROOT, 'scripts', 'lib', 'gate-results.mts');
const LIB_URL = pathToFileURL(LIB).href;

let pass = 0;
let fail = 0;
const skippedList: string[] = [];
const lines: string[] = [];
const ok = (id: string, name: string, cond: boolean, detail = '') => {
  const line = `[${cond ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ' :: ' + detail : ''}`;
  lines.push(line);
  if (cond) { pass += 1; } else { fail += 1; }
  console.log(`  ${line}`);
};
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  const line = `  [SKIP] ${range} —— ${why}（不计 PASS）`;
  lines.push(line.trim());
  console.log(line);
};
/** okPair 需要 (label, cond, extra) 三参口径的 ok（anchor-pair 的 OkFn 约定），套到本门四参 ok 上：
 *  标签首词就是编号（"L-01 …"），拆出来当 id，其余当判据名 */
const okP = (name: string, cond: boolean, extra?: unknown) => {
  const sp = name.indexOf(' ');
  ok(sp > 0 && /^[A-Z]+-\d/.test(name) ? name.slice(0, sp) : 'L', sp > 0 ? name.slice(sp + 1) : name, cond,
    extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
};

/** 字面腿一律取已提交树（反模式 11）；工作树里同一文件可能是并发会话的过期 WIP */
const headCache = new Map<string, string | null>();
function headText(rel: string): string | null {
  if (headCache.has(rel)) return headCache.get(rel);
  let out: string | null = null;
  try { out = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch { out = null; }
  headCache.set(rel, out);
  return out;
}
function headTextAt(rev: string, rel: string): string | null {
  try { return execFileSync('git', ['show', `${rev}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch { return null; }
}
/** HEAD 树里 scripts/ 下全部 .mjs 门名（扫描清单也取已提交树，不随并发新增文件漂移） */
function headMjsGates(): string[] {
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', 'scripts/'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').map((s) => s.replace(/^scripts\//, '')).filter((n) => n.startsWith('verify-') && n.endsWith('.mjs'));
  } catch { return []; }
}

/** 子进程跑真代码（与门侧同款 tsx 通道），确保 .mts 导入形态与真实 UI 门一致。 */
function runProbe(src: string, tag: string, env: Record<string, string> = {}) {
  const file = join(TMP_ROOT, `probe-${tag}.mts`);
  writeFileSync(file, src, 'utf8');
  const r = spawnSync(process.execPath, [TSX, file], {
    cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000,
  });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const field = (out: string, key: string) => (out.match(new RegExp(key + '=(.+)')) ?? [])[1]?.trim() ?? '';

// =====================================================================
// B 组：运行时行为探针（判据 1 的行为腿；先实测，字面配对项在文件尾部统一发射）
// =====================================================================
const writeProbe = (marker: string) => `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { gateShotsDir } = await import(${JSON.stringify(LIB_URL)});
const SHOTS = gateShotsDir('t02312-probe');
mkdirSync(SHOTS, { recursive: true });
const file = join(SHOTS, '01-step.png');
writeFileSync(file, ${JSON.stringify(marker)});
console.log('DIR=' + SHOTS); console.log('FILE=' + file);
`;
const ART = join(TMP_ROOT, 'artifacts');
const e1 = runProbe(writeProbe('RUN-A'), 'a', { MTASK_GATE_ARTIFACT_DIR: ART });
const e2 = runProbe(writeProbe('RUN-B'), 'b', { MTASK_GATE_ARTIFACT_DIR: ART });
const dir1 = field(e1.out, 'DIR'); const dir2 = field(e2.out, 'DIR');
const file1 = field(e1.out, 'FILE'); const file2 = field(e2.out, 'FILE');
const readOr = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
ok('B-01', '两轮 gateShotsDir 目录互异（并发不可能互覆）',
  e1.status === 0 && e2.status === 0 && !!dir1 && !!dir2 && dir1 !== dir2, `${dir1} vs ${dir2}｜${e1.out.slice(0, 120)}`);
ok('B-02', '同一步骤名 01-step.png 两份证据同时存在且内容各自正确',
  readOr(file1) === 'RUN-A' && readOr(file2) === 'RUN-B', `A=${readOr(file1)} B=${readOr(file2)}`);
ok('B-03', '子目录名带运行标识（门名-PID-时刻，可按标识核对归属）',
  /t02312-probe-\d+-\d{8}-\d{6}$/.test(dir1), dir1);

const same = runProbe(`
const { gateShotsDir, gateResultsPath } = await import(${JSON.stringify(LIB_URL)});
console.log('SHOTS=' + gateShotsDir('t02312-probe'));
console.log('SHOTS2=' + gateShotsDir('t02312-probe'));
console.log('TXT=' + gateResultsPath('out', 't02312-gate-results.txt'));
`, 'same', { MTASK_GATE_ARTIFACT_DIR: ART });
const sh = field(same.out, 'SHOTS'); const sh2 = field(same.out, 'SHOTS2'); const tx = field(same.out, 'TXT');
const tagOf = (p: string) => (p.match(/(\d+-\d{8}-\d{6})/) ?? [])[1] ?? '';
ok('B-04', '同进程内 gateShotsDir 幂等（同门名同目录，截图不散落成多目录）',
  same.status === 0 && !!sh && sh === sh2, `${sh} / ${sh2}`);
ok('B-05', '一轮的截图与文本结果共用同一运行标识（可按标识配对复核）',
  !!tagOf(sh) && tagOf(sh) === tagOf(tx), `shots=${tagOf(sh)} txt=${tagOf(tx)}`);

ok('B-06', 'MTASK_GATE_ARTIFACT_DIR 生效：截图根落在指定隔离根下', !!dir1 && dir1.startsWith(ART), `${ART} <- ${dir1}`);
const defProbe = `
const { gateShotsDir } = await import(${JSON.stringify(LIB_URL)});
console.log('DIR=' + gateShotsDir('t02312-default'));
`;
const def = runProbe(defProbe, 'def', { MTASK_GATE_ARTIFACT_DIR: '' });
const defDir = field(def.out, 'DIR');
ok('B-07', '未设环境变量时回落 os.tmpdir()/mtask-gate-shots（且不写进仓库根）',
  defDir.startsWith(join(tmpdir(), 'mtask-gate-shots')) && !defDir.startsWith(ROOT), defDir);

// 反证：旧口径确实互覆（证明 B-02 是区分性断言而不是「两份都存在」的空判据）
const oldProbe = (marker: string) => `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const SHOTS = join(${JSON.stringify(TMP_ROOT)}, 'legacy-fixed-name-shots');
mkdirSync(SHOTS, { recursive: true });
const file = join(SHOTS, '01-step.png');
writeFileSync(file, ${JSON.stringify(marker)});
console.log('FILE=' + file);
`;
const o1 = runProbe(oldProbe('RUN-A'), 'old-a');
const o2 = runProbe(oldProbe('RUN-B'), 'old-b');
const ofile = field(o1.out, 'FILE');
ok('B-08', '反证成立：旧口径两轮同一路径，先写者被整图覆盖（只剩 RUN-B）',
  !!ofile && ofile === field(o2.out, 'FILE') && readOr(ofile) === 'RUN-B', ofile);

// 仓库根残留清零（判据对象就是当前仓库根的文件系统状态，属行为面而非文本锚）
const leftovers = readdirSync(ROOT).filter((n) => /^\.t\d{5}-shots$/.test(n));
ok('R-01', '仓库根不再有 .tXXXXX-shots 残留目录', leftovers.length === 0, leftovers.join('、'));

// =====================================================================
// H 组：历史产物断言（T02312 改造前后标签逐字一致）+ 牙齿
// =====================================================================
/** 标签抽取：判据名只来自 ok('ID', 'name' 形态调用 */
function labels(src: string) {
  return (src.match(/\bok\(\s*'([^']+)'/g) ?? []).map((s => s.replace(/^ok\(\s*'/, '').replace(/'$/, ''))).sort();
}
/** 两版标签多重集比对（正判与牙齿共用同一实现） */
const labelsDiffer = (a: string[], b: string[]) => a.length !== b.length || a.some((x, i) => x !== b[i]);
// 落地 commit 按提交信息检索，不写死哈希；找不到就整组 skipped（环境缺口不冒充结论）
const revInfo = spawnSync('git', ['log', '--grep=T02312', '-1', '--format=%H', '--', 'scripts/verify-t02312-shots-isolation.mts'],
  { cwd: ROOT, encoding: 'utf8' });
const REV = (revInfo.stdout ?? '').trim();
const revParent = REV ? (spawnSync('git', ['rev-parse', `${REV}^`], { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim() : '';
if (!REV || !revParent) {
  skipped('H/G 组', `检索不到 T02312 落地 commit 或其父提交（REV=${REV || '无'} PARENT=${revParent || '无'}）——历史比对判据无法取数`);
} else {
  const histRenamed: string[] = [];
  for (const g of GATES) {
    const a = headTextAt(REV, `scripts/${g}`); const b = headTextAt(revParent, `scripts/${g}`);
    if (a === null || b === null) { histRenamed.push(`${g}(取不到 ${a === null ? REV : revParent} 版)`); continue; }
    if (labelsDiffer(labels(a), labels(b))) histRenamed.push(`${g}:${labels(b).length}->${labels(a).length}`);
  }
  ok('H-01', '7 道门断言标签在 T02312 改造前后逐字一致（工单判据 3 的稳定形态：历史比对而非 HEAD 比 HEAD）',
    histRenamed.length === 0, histRenamed.join('、'));
  ok('H-02', 'H-01 有牙齿：给任一门的标签人为改一个字后，同一比对器必须报出差异（且原样比对为真）',
    (() => {
      const base = headTextAt(REV, `scripts/${GATES[0]}`) ?? '';
      const l = labels(base);
      if (!l.length) return false;
      const tampered = labels(base.replace(`ok('${l[0]}'`, `ok('${l[0]}·改名'`));
      return !labelsDiffer(l, labels(base)) && labelsDiffer(l, tampered);
    })(), '改名后比对必须非空、原样比对必须为空');
}

// =====================================================================
// G 组：守卫门存活 + 「T02312 不受影响」不变性 + 植入负对照
// =====================================================================
interface Verdict { sum: string; fails: string[]; crashed: boolean }
function runGuard(root: string): Verdict {
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(root, 'scripts', 'verify-t02205-guard-selfcheck.mts')],
    { cwd: root, encoding: 'utf8', timeout: 300_000, env: { ...process.env, TMP: 'D:/code/tmp', TEMP: 'D:/code/tmp' } });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const m = out.match(/PASS=(\d+) FAIL=(\d+)/);
  return {
    sum: m ? `PASS=${m[1]} FAIL=${m[2]}` : '(裁决不可解析)',
    fails: out.split('\n').filter((l) => l.startsWith('[FAIL]')).map((l) => l.split('：')[0].slice(0, 60)).sort(),
    crashed: !m,
  };
}
const norm = (v: Verdict) => `${v.sum}|${v.fails.join(',')}`;
// G-01：t02205 在当前树可运行、裁决可解析、判定点 ≥8（不断言全绿——它审的是全仓锚点，
// 并发会话 WIP 让全绿成为移动靶；旧版「保持 8/0」正是被此判红的假判据）
const cur = runGuard(ROOT);
ok('G-01', '守卫门在本树跑得起来且给出可解析裁决（判定点 ≥8；不断言 8/0——外部现状属移动靶，见顶部改判口径）',
  !cur.crashed && Number(cur.sum.match(/\d+/g)!.reduce((a, b) => a + Number(b), 0)) >= 8, cur.sum);

// G-02/G-03：两份只读 worktree 副本（T02312 commit 与其父），比对 t02205 裁决是否一致
const WT_A = join(TMP_ROOT, 'wt-rev'); const WT_B = join(TMP_ROOT, 'wt-parent');
function addWt(dir: string, rev: string): boolean {
  try {
    execFileSync('git', ['worktree', 'add', '--detach', dir, rev], { cwd: ROOT, stdio: 'pipe', timeout: 300_000 });
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
    return existsSync(join(dir, 'scripts', 'verify-t02205-guard-selfcheck.mts'));
  } catch { return false; }
}
function dropWt(dir: string): void {
  try { rmSync(join(dir, 'node_modules'), { recursive: true, force: true }); } catch { /* 未建成 */ }
  try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'ignore', timeout: 180_000 }); }
  catch { rmSync(dir, { recursive: true, force: true }); }
}
if (!REV) {
  skipped('G-02/G-03', '无 T02312 commit 可定位，一致性判据无法取数');
} else if (!addWt(WT_A, REV) || !addWt(WT_B, revParent)) {
  dropWt(WT_A); dropWt(WT_B);
  skipped('G-02/G-03', 'HEAD 副本 worktree 建不起（git worktree/junction 环境缺口），一致性判据无法取数（不冒充 PASS）');
} else {
  try {
    const vA = runGuard(WT_A); const vB = runGuard(WT_B);
    const consistent = !vA.crashed && !vB.crashed && norm(vA) === norm(vB);
    ok('G-02', `T02312 改造未改变守卫门裁决（${REV.slice(0, 7)} 与父 ${revParent.slice(0, 7)} 两份副本归一化裁决一致：${vA.sum}）`,
      consistent, `${norm(vA)} vs ${norm(vB)}`);
    // G-03 负对照（判据 4）：往 T02312 副本里**破坏共享 lib**（gate-results.mts 顶层抛错——
    // 守卫门 import 它，这正是「若 T02312 把 lib 改坏，一致性判据必须当场转红」的真实形态）。
    // 注：植入不能是「新增一份未提交的假门」——t02205 的门文本取自该 worktree 的**已提交树**
    // （git show HEAD:），未提交文件它根本扫不到（本轮实测），那种植入等于没植入。
    const libInCopy = join(WT_A, 'scripts', 'lib', 'gate-results.mts');
    writeFileSync(libInCopy, readFileSync(libInCopy, 'utf8') + "\nthrow new Error('T02312 G-03 植入：共享 lib 被改坏');\n", 'utf8');
    const vT = runGuard(WT_A);
    ok('G-03', '一致性判据有牙齿：植入「共享 lib 顶层抛错」后守卫门在副本里跑崩、归一化比对必须不再相等（证明 G-02 不是两份相同崩溃、也不是恒真放行）',
      (vT.crashed || norm(vT) !== norm(vB)) && consistent,
      `植入后=${norm(vT)}（crashed=${vT.crashed}） vs 父本=${norm(vB)}`);
  } finally {
    dropWt(WT_A); dropWt(WT_B);
  }
}

// =====================================================================
// L 组：字面锚降级为 okPair 字面腿（惰性数组——行为腿取值必须早于发射，反模式 14）
// 全部扫描源 = git show HEAD:<path>（反模式 11）；行为腿 = 上面 B 组的实测事实。
// =====================================================================
const LEGAL = /join\(ROOT,\s*'\.t\d{5}-shots'\)/;
const B = {
  isolated: () => e1.status === 0 && e2.status === 0 && !!dir1 && !!dir2 && dir1 !== dir2,
  bothEvidence: () => readOr(file1) === 'RUN-A' && readOr(file2) === 'RUN-B',
  legacyOverwrite: () => !!ofile && ofile === field(o2.out, 'FILE') && readOr(ofile) === 'RUN-B',
  tagAndPaths: () => !!dir1 && /t02312-probe-\d+-\d{8}-\d{6}$/.test(dir1) && file1 === join(dir1, '01-step.png'),
  fullRunTag: () => same.status === 0 && !!sh && sh === sh2 && !!tagOf(sh) && tagOf(sh) === tagOf(tx),
  noRepoWrite: () => !!defDir && !defDir.startsWith(ROOT),
};
const literalPairs: Array<() => void> = [];

literalPairs.push(() => okPair(okP,
  'L-01 7 道门不再用 join(ROOT, ".tXXXXX-shots") 固定名目录（字面腿=HEAD 树扫描；行为腿=本轮实测：新口径两轮互异+旧口径两轮互覆）',
  () => B.isolated() && B.bothEvidence() && B.legacyOverwrite(),
  () => {
    const srcs = GATES.map((g) => headText(`scripts/${g}`));
    return srcs.every((s) => s !== null) && srcs.filter((s) => LEGAL.test(s ?? '')).length === 0;
  },
  () => ({ 命中: GATES.filter((g) => LEGAL.test(headText(`scripts/${g}`) ?? '')) })));

literalPairs.push(() => okPair(okP,
  'L-02 全量 .mjs 门同样归零（T02309 只扫 .mts 的盲区已补；清单取 git ls-tree HEAD，不随并发新增漂移）',
  () => B.isolated() && B.legacyOverwrite(),
  () => {
    const allMjs = headMjsGates();
    return allMjs.length >= 20 && allMjs.filter((g) => LEGAL.test(headText(`scripts/${g}`) ?? '')).length === 0;
  },
  () => ({ 扫: headMjsGates().length, 命中: headMjsGates().filter((g) => LEGAL.test(headText(`scripts/${g}`) ?? '')) })));

literalPairs.push(() => okPair(okP,
  'L-03 7 道门全部改用 gateShotsDir（缺一即回归）（行为腿=目录派生/命名/幂等三项实测在位）',
  () => B.isolated() && B.tagAndPaths() && B.fullRunTag(),
  () => GATES.every((g) => /const SHOTS = gateShotsDir\('t\d{5}'\);/.test(headText(`scripts/${g}`) ?? '')),
  () => ({ 未改用: GATES.filter((g) => !/const SHOTS = gateShotsDir\(/.test(headText(`scripts/${g}`) ?? '')) })));

literalPairs.push(() => okPair(okP,
  'L-04 7 道门共用同一份命名逻辑（都 import scripts/lib/gate-results.mts，不各写一遍）',
  () => B.isolated() && B.tagAndPaths(),
  () => GATES.every((g) => (headText(`scripts/${g}`) ?? '').includes('scripts/lib/gate-results.mts')),
  () => ({ 未引用: GATES.filter((g) => !(headText(`scripts/${g}`) ?? '').includes('scripts/lib/gate-results.mts')) })));

literalPairs.push(() => okPair(okP,
  'L-05 shotFiles 记的是实际写盘全路径（打印路径 == 落盘路径；行为腿=探针 FILE 就是 DIR 下的实际文件且读得回内容）',
  () => B.bothEvidence() && B.tagAndPaths(),
  () => GATES.every((g) => !/shotFiles\.push\(`\$\{name\}\.png`\)/.test(headText(`scripts/${g}`) ?? '')),
  () => ({ 仍推裸文件名: GATES.filter((g) => /shotFiles\.push\(`\$\{name\}\.png`\)/.test(headText(`scripts/${g}`) ?? '')) })));

literalPairs.push(() => okPair(okP,
  'L-06 目录自建（recursive）与 shot() 结构保留——子目录可变的两个前提（行为腿=探针确实建出多级新目录并写盘成功）',
  () => B.isolated() && existsSync(dir1) && existsSync(dir2),
  () => GATES.every((g) => /mkdirSync\(SHOTS, \{ recursive: true \}\)/.test(headText(`scripts/${g}`) ?? '')),
  () => ({ 缺结构: GATES.filter((g) => !/mkdirSync\(SHOTS, \{ recursive: true \}\)/.test(headText(`scripts/${g}`) ?? '')) })));

literalPairs.push(() => okPair(okP,
  'L-07 .gitignore 忽略截图产物（含历史固定名目录）（行为腿=默认回落目录在 os.tmpdir 下、仓库根零写入）',
  () => B.noRepoWrite(),
  () => (headText('.gitignore') ?? '').includes('.t0*-shots/'),
  () => ({ HEADgitignore: ((headText('.gitignore') ?? '').match(/\.t0\*[^\n]*/g) ?? []).slice(0, 3) })));

// 发射点：全部实测已完成后统一发射（反模式 14）
for (const emit of literalPairs) emit();

// =====================================================================
// N 组：字面判别有牙齿（判据 4）——把 HEAD 文本在内存里改坏，同一判据必须转假
// =====================================================================
ok('N-01', 'L-01/L-02 的固定名扫描有牙齿：同一段文本植入 join(ROOT, \'.tXXXXX-shots\') 后 LEGAL 必命中、原文必不命中',
  LEGAL.test("const SHOTS = join(ROOT, '.t02039-shots');") && !LEGAL.test("const SHOTS = gateShotsDir('t02039');"));
ok('N-02', 'L-03/L-06 的接线扫描有牙齿：从 HEAD 文本里剥掉 gateShotsDir/mkdirSync 后同一判据转假（真接线为真）',
  (() => {
    const src = headText(`scripts/${GATES[0]}`) ?? '';
    const legA = (s: string) => /const SHOTS = gateShotsDir\('t\d{5}'\);/.test(s);
    const legB = (s: string) => /mkdirSync\(SHOTS, \{ recursive: true \}\)/.test(s);
    return legA(src) && legB(src) && !legA(src.replace(/gateShotsDir\(/, 'legacyShotsDir(')) && !legB(src.replace('mkdirSync(SHOTS,', 'noop(SHOTS,'));
  })(), '剥掉接线后判据必须转假');
ok('N-03', 'B-01 的目录互异判据有牙齿：拿同一次运行的两个目录比必须相等（防「恒不等」类空转），跨运行才不等',
  (() => {
    const s = runProbe(`
const { gateShotsDir } = await import(${JSON.stringify(LIB_URL)});
console.log('D1=' + gateShotsDir('t02312-teeth')); console.log('D2=' + gateShotsDir('t02312-teeth'));
`, 'teeth', { MTASK_GATE_ARTIFACT_DIR: ART });
    const d1 = field(s.out, 'D1'); const d2 = field(s.out, 'D2');
    return !!d1 && d1 === d2 && d1 !== dir1;
  })(), '同轮两取必相等、与另一轮必不等');

const summary = `T02312 截图隔离命名门（T02293 改判版）：PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`;
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02312-shots-gate-results.txt',
  `${summary}\n${lines.join('\n')}\n${skippedList.length ? `跳过项：\n${skippedList.join('\n')}\n` : ''}`,
  { dataDir: TMP_ROOT, note: 'static+probes+HEAD副本' });
console.log(`\n${summary} → ${resultsFile}`);
rmSync(TMP_ROOT, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
