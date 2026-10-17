/**
 * T02312 回归门：UI 门截图落盘隔离命名（仓库根固定名目录 → 每轮一个带运行标识的子目录）。
 *
 * 钉住工单三条判据：
 *  1. 并发跑门互不覆盖——同名步骤的两轮各写各的目录，两份证据同时存在且内容各自正确；
 *  2. 仓库根固定名目录写法归零 + 既有 `.t0*-shots/` 残留清零；
 *  3. 7 道门的断言名一字不改（与 HEAD 版本逐门比对），`verify-t02205-guard-selfcheck.mts` 保持 8/0。
 *
 * 全程静态 + 纯临时目录子进程，不启服务、不碰库、不开浏览器（真机走查由被改的 7 道门自己负责）。
 * 用法：`node_modules/tsx/dist/cli.mjs scripts/verify-t02312-shots-isolation.mts`
 * 环境变量：T02312_TMP_ROOT（临时根，默认 D:/code/tmp/gate-tmp/t02312-<pid>；本机 C: 常年 0 可用）
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const ok = (id: string, name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`  [PASS] ${id} ${name}${detail ? ' :: ' + detail : ''}`); } else {
    fail += 1; console.log(`  [FAIL] ${id} ${name}${detail ? ' :: ' + detail : ''}`);
  }
};
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

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

// ---------- 判据 2：仓库根固定名目录写法归零（口径与工单机检一致，且补上 .mjs 盲区） ----------
const LEGAL = /join\(ROOT,\s*'\.t\d{5}-shots'\)/;
const hits = GATES.filter((g) => LEGAL.test(read(`scripts/${g}`)));
const allMjs = readdirSync(join(ROOT, 'scripts')).filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'));
const hitsAll = allMjs.filter((g) => LEGAL.test(read(`scripts/${g}`)));
ok('S-01', '7 道门不再用 join(ROOT, ".tXXXXX-shots") 固定名目录', hits.length === 0, `命中 ${hits.length}：${hits.join('、') || '无'}`);
ok('S-02', '全量 .mjs 门同样归零（T02309 只扫 .mts 的盲区已补）', hitsAll.length === 0,
  `扫 ${allMjs.length} 个 .mjs，命中 ${hitsAll.length}：${hitsAll.join('、') || '无'}`);

// ---------- 判据 1（机制）：改为每轮一个带运行标识的子目录 + 打印全路径 ----------
const rewired = GATES.filter((g) => /const SHOTS = gateShotsDir\('t\d{5}'\);/.test(read(`scripts/${g}`)));
ok('S-03', '7 道门全部改用 gateShotsDir（缺一即回归）', rewired.length === GATES.length, `${rewired.length}/7`);
const usesLib = GATES.filter((g) => read(`scripts/${g}`).includes('scripts/lib/gate-results.mts'));
ok('S-04', '7 道门共用同一份命名逻辑（不各写一遍）', usesLib.length === GATES.length, `${usesLib.length}/7`);
const barePush = GATES.filter((g) => /shotFiles\.push\(`\$\{name\}\.png`\)/.test(read(`scripts/${g}`)));
ok('S-05', 'shotFiles 记的是实际写盘全路径（打印路径 == 落盘路径）', barePush.length === 0, `仍推裸文件名：${barePush.join('、') || '无'}`);
const keepMkdir = GATES.filter((g) => /mkdirSync\(SHOTS, \{ recursive: true \}\)/.test(read(`scripts/${g}`)));
ok('S-06', '目录自建（recursive）与 shot() 结构保留——子目录可变的两个前提', keepMkdir.length === GATES.length, `${keepMkdir.length}/7`);

// ---------- 判据 3：断言名一字不改（与 HEAD 逐门比对标签多重集，门内自证不靠人眼） ----------
function labels(src: string) {
  return (src.match(/\bok\(\s*'([^']+)'/g) ?? []).map((s => s.replace(/^ok\(\s*'/, '').replace(/'$/, ''))).sort();
}
const renamed: string[] = [];
for (const g of GATES) {
  const head = spawnSync('git', ['show', `HEAD:scripts/${g}`], { cwd: ROOT, encoding: 'utf8' });
  if (head.status !== 0) { renamed.push(`${g}(取不到 HEAD)`); continue; }
  const a = labels(head.stdout); const b = labels(read(`scripts/${g}`));
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) renamed.push(`${g}:${a.length}->${b.length}`);
}
ok('S-07', '7 道门断言标签多重集与 HEAD 逐字一致（只改写盘点，不动产品侧判据）', renamed.length === 0, renamed.join('、'));

// ---------- 判据 1（运行时）：两进程各写同名步骤文件，互不覆盖 ----------
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
ok('S-08', '两轮 gateShotsDir 目录互异（并发不可能互覆）',
  e1.status === 0 && e2.status === 0 && !!dir1 && !!dir2 && dir1 !== dir2, `${dir1} vs ${dir2}｜${e1.out.slice(0, 120)}`);
ok('S-09', '同一步骤名 01-step.png 两份证据同时存在且内容各自正确',
  readOr(file1) === 'RUN-A' && readOr(file2) === 'RUN-B', `A=${readOr(file1)} B=${readOr(file2)}`);
ok('S-10', '子目录名带运行标识（门名-PID-时刻，可按标识核对归属）',
  /t02312-probe-\d+-\d{8}-\d{6}$/.test(dir1), dir1);

// ---------- 同一次运行内：截图目录与文本结果同标识 ----------
const same = runProbe(`
const { gateShotsDir, gateResultsPath } = await import(${JSON.stringify(LIB_URL)});
console.log('SHOTS=' + gateShotsDir('t02312-probe'));
console.log('SHOTS2=' + gateShotsDir('t02312-probe'));
console.log('TXT=' + gateResultsPath('out', 't02312-gate-results.txt'));
`, 'same', { MTASK_GATE_ARTIFACT_DIR: ART });
const sh = field(same.out, 'SHOTS'); const sh2 = field(same.out, 'SHOTS2'); const tx = field(same.out, 'TXT');
const tagOf = (p: string) => (p.match(/(\d+-\d{8}-\d{6})/) ?? [])[1] ?? '';
ok('S-11', '同进程内 gateShotsDir 幂等（同门名同目录，截图不散落成多目录）',
  same.status === 0 && !!sh && sh === sh2, `${sh} / ${sh2}`);
ok('S-12', '一轮的截图与文本结果共用同一运行标识（可按标识配对复核）',
  !!tagOf(sh) && tagOf(sh) === tagOf(tx), `shots=${tagOf(sh)} txt=${tagOf(tx)}`);

// ---------- 根目录可重定向（本机 C: 常年 0 可用，验证门产物应落 D:） ----------
ok('S-13', 'MTASK_GATE_ARTIFACT_DIR 生效：截图根落在指定隔离根下', !!dir1 && dir1.startsWith(ART), `${ART} <- ${dir1}`);
const defProbe = `
const { gateShotsDir } = await import(${JSON.stringify(LIB_URL)});
console.log('DIR=' + gateShotsDir('t02312-default'));
`;
const def = runProbe(defProbe, 'def', { MTASK_GATE_ARTIFACT_DIR: '' });
const defDir = field(def.out, 'DIR');
ok('S-14', '未设环境变量时回落 os.tmpdir()/mtask-gate-shots（且不写进仓库根）',
  defDir.startsWith(join(tmpdir(), 'mtask-gate-shots')) && !defDir.startsWith(ROOT), defDir);

// ---------- 反证：旧口径确实互覆（证明 S-09 是区分性断言，不是空转） ----------
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
ok('S-15', '反证成立：旧口径两轮同一路径，先写者被整图覆盖（只剩 RUN-B）',
  !!ofile && ofile === field(o2.out, 'FILE') && readOr(ofile) === 'RUN-B', ofile);

// ---------- 仓库根残留清零 + 忽略规则 ----------
const leftovers = readdirSync(ROOT).filter((n) => /^\.t\d{5}-shots$/.test(n));
ok('S-16', '仓库根不再有 .tXXXXX-shots 残留目录', leftovers.length === 0, leftovers.join('、'));
const gi = read('.gitignore');
ok('S-17', '.gitignore 忽略截图产物（含历史固定名目录）', gi.includes('.t0*-shots/'),
  gi.includes('.t0*-shots/') ? '规则已就位' : '缺少 .t0*-shots/ 规则');

// ---------- 既有守卫门不受影响（工单判据 3） ----------
const guard = spawnSync(process.execPath, [TSX, join(ROOT, 'scripts', 'verify-t02205-guard-selfcheck.mts')],
  { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
const gm = (guard.stdout ?? '').match(/PASS=(\d+) FAIL=(\d+)/);
ok('G-01', 'verify-t02205-guard-selfcheck.mts 保持 8/0', !!gm && gm[1] === '8' && gm[2] === '0',
  gm ? `PASS=${gm[1]} FAIL=${gm[2]}` : (guard.stdout ?? '').slice(-200) + (guard.stderr ?? '').slice(-200));

rmSync(TMP_ROOT, { recursive: true, force: true });
console.log(`\nT02312 截图隔离命名门：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
