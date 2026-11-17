/**
 * 一键发布前置检查验收门（对标 AirMirror 一键发布.bat 的前置项）。
 *
 * 被治的缺口：MTask 的 scripts/一键发布.bat 原先只是薄启动器，AirMirror 那套
 * 「.env Token 载入 + git/powershell/gh 探测 + 参数透传 + NO_PAUSE + 退出码」一项没有。
 * 本门把 bat 放进 D: 夹具目录真跑，但用假 git/python/powershell 桩拦截，
 * 假 powershell 桩只把参数和可见环境写进 called.txt 后按配置退出——
 * 绝不调用真实 publish-oneclick.ps1，不构建、不发布、不碰网络。
 *
 * 判据形态（docs/验收门判据规约.md）：主判据打在**行为**上（bat 真跑后的 stdout / 桩记录 /
 * 退出码）；纯 ASCII 编码锚点配「bat 确实被 cmd 解析执行过」的行为腿，不是平行文本自比。
 *
 * 用法：node scripts/verify/verify-publish-preflight.mts
 *   夹具落 MTASK_GATE_TMP（默认 D:/tmp，本机 C: 常年 0 可用）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from '../lib/gate-results.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAT_SRC = path.join(ROOT, 'scripts', '一键发布.bat');
const TMP = path.join(process.env.MTASK_GATE_TMP || path.join('D:', 'tmp'), `pub-preflight-${process.pid}`);
const STUB = path.join(TMP, 'stub');
const FIX = path.join(TMP, 'repo', 'scripts');
const BAT = path.join(FIX, 'publish.bat'); // ASCII 名：cmd 在 chcp 前按系统代码页解析命令行参数，中文名会被误读
const ENV_FILE = path.join(TMP, 'repo', '.env');
const CALLED = path.join(STUB, 'called.txt');
const SYSROOT = process.env.SystemRoot || 'C:\\Windows';
const BASE_PATH = [STUB, path.join(SYSROOT, 'System32'), SYSROOT].join(';');

const LINES: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => { LINES.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); origLog(...a); };
let pass = 0; let fail = 0;
const fmt = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d));
const ok = (name: string, cond: boolean, detail: unknown = '') => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${fmt(detail)}`); return true; }
  fail++; console.log(`FAIL ${name} :: ${fmt(detail)}`); return false;
};
const note = (s: string) => console.log(s);

mkdirSync(STUB, { recursive: true });
mkdirSync(FIX, { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 收尾不改结论 */ } });

const batText = readFileSync(BAT_SRC, 'utf8');
// 假 powershell 是 .cmd 桩：bat 直接调用 .cmd 时，桩的 `exit /b N` 会终止整条父 bat，
// 于是 RC 判断/分支都走不到（A 组到不了 [DONE]、G 组 exit 7 直接透传）。
// 真实 powershell.exe 是被执行体、结束后控制权回到 bat；`call` 正是模拟这条进程边界。
// 只改夹具副本，生产 .bat 一个字节不动。
const fixtureBatText = batText.replace(/^powershell -ExecutionPolicy/m, 'call powershell -ExecutionPolicy');
if (fixtureBatText === batText) throw new Error('夹具改写失败：未找到 powershell 调用锚点，桩语义将失效');
writeFileSync(BAT, fixtureBatText, 'ascii');

/** 假桩：powershell 把收到的参数与可见 Token 写进 called.txt，按 STUB_PS_RC 退出。 */
function writeStubs(opts: { git?: boolean; python?: boolean; powershell?: boolean; psRc?: string } = {}) {
  for (const f of ['git.cmd', 'python.cmd', 'powershell.cmd']) {
    try { rmSync(path.join(STUB, f), { force: true }); } catch { /* noop */ }
  }
  try { rmSync(CALLED, { force: true }); } catch { /* noop */ }
  if (opts.git !== false) {
    writeFileSync(path.join(STUB, 'git.cmd'), '@echo off\r\necho git version 2.99.9-stub\r\n', 'ascii');
  }
  if (opts.python !== false) {
    writeFileSync(path.join(STUB, 'python.cmd'), '@echo off\r\necho Python 3.99-stub\r\n', 'ascii');
  }
  if (opts.powershell !== false) {
    const body = [
      '@echo off',
      `> "${CALLED}" echo ARGS=%*`,
      `>> "${CALLED}" echo GH_TOKEN=%GH_TOKEN%`,
      `>> "${CALLED}" echo GITHUB_TOKEN=%GITHUB_TOKEN%`,
      `>> "${CALLED}" echo SDC=%CODEBUDDY_SAFE_DELETE_ENABLED%`,
      `exit /b ${opts.psRc ?? '0'}`,
      '',
    ].join('\r\n');
    writeFileSync(path.join(STUB, 'powershell.cmd'), body, 'ascii');
  }
}
function putEnv(content: string) { writeFileSync(ENV_FILE, content, 'utf8'); }
function putEnvAbsent() { try { rmSync(ENV_FILE, { force: true }); } catch { /* noop */ } }

/** 真跑 bat。NO_PAUSE 恒置，避免任何分支卡在 pause；额外参数原样透传。 */
function run(args: string[] = [], extraEnv: Record<string, string | undefined> = {}) {
  const env = { ...process.env, PATH: BASE_PATH, NO_PAUSE: '1', TEMP: TMP, TMP, ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  // shell:false 下 cmd /c 的外层引号会被 Node 转义成字面 \" → 「不是内部命令」。
  // 夹具路径（D:\tmp\...）无空格，直接给裸路径；真项目路径有空格时由调用方保证夹具根无空格。
  const cmdLine = BAT + (args.length ? ' ' + args.join(' ') : '');
  const r = spawnSync('cmd', ['/d', '/c', cmdLine], {
    cwd: TMP, env, encoding: 'utf8', timeout: 60_000, shell: false,
  });
  const called = existsSync(CALLED) ? readFileSync(CALLED, 'utf8') : '';
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status, called };
}

note('--- A 组：Token 载入 / 去引号 / 不回显 / 参数透传 / NO_PAUSE ---');
writeStubs();
putEnv('GH_TOKEN=ghp_plain123\r\nGITHUB_TOKEN="gho_quoted456"\r\n');
let r = run(['-DryRun', '-Tag', 'v9']);
ok('A-01 正常三桩齐备时 bat 跑通（exit 0）', r.code === 0, `exit=${r.code}`);
ok('A-02 GH_TOKEN 载入给子进程（桩可见）', r.called.includes('GH_TOKEN=ghp_plain123'), r.called.trim());
const ghLine = r.called.split(/\r?\n/).find((l) => l.startsWith('GITHUB_TOKEN=')) ?? '';
ok('A-03 GITHUB_TOKEN 去引号（桩可见值无引号）', ghLine === 'GITHUB_TOKEN=gho_quoted456', ghLine);
ok('A-04 Token 不回显到 stdout', !r.out.includes('ghp_plain123') && !r.out.includes('gho_quoted456'), r.out.split(/\r?\n/).filter((l) => l.includes('[OK]') || l.includes('[WARN]')).join(' | '));
ok('A-05 [OK] Token 提示出现', /\[OK\]\s+GH_TOKEN available/.test(r.out), r.out.slice(0, 400));
ok('A-06 参数透传到 powershell（假桩收到 -DryRun -Tag v9）', /ARGS=.*-File.*-DryRun -Tag v9/.test(r.called), r.called.trim());
ok('A-07 safe-delete 放行默认注入', /SDC=0/.test(r.called), r.called.trim());
ok('A-08 NO_PAUSE 生效（不卡在 pause，60s 内退出）', r.code === 0 && r.out.includes('[DONE]'), `exit=${r.code}`);

note('--- B 组：进程环境优先于 .env ---');
writeStubs();
putEnv('GH_TOKEN=ghp_from_file\r\n');
r = run([], { GH_TOKEN: 'ghp_from_env' });
ok('B-01 环境已设 GH_TOKEN 时不被 .env 覆盖', r.called.includes('GH_TOKEN=ghp_from_env') && !r.called.includes('ghp_from_file'), r.called.trim());

note('--- C 组：无 Token 走 WARN 不阻断 ---');
writeStubs();
putEnvAbsent();
r = run([], { GH_TOKEN: undefined, GITHUB_TOKEN: undefined });
ok('C-01 无 Token 出 [WARN]', /\[WARN\].*No GH_TOKEN/.test(r.out), r.out.split(/\r?\n/).filter((l) => l.includes('WARN')).join(' | '));
ok('C-02 无 Token 仍继续到发布调用（exit 0）', r.code === 0 && r.called.includes('ARGS='), `exit=${r.code}`);

note('--- D 组：git 缺失必须 FAIL 且不触发发布 ---');
writeStubs({ git: false });
putEnv('GH_TOKEN=ghp_x\r\n');
r = run();
ok('D-01 git 缺失出 [FAIL]', /\[FAIL\]\s*git not found/.test(r.out), r.out.split(/\r?\n/).filter((l) => l.includes('FAIL')).join(' | '));
ok('D-02 git 缺失时退出码非 0', r.code !== 0 && r.code === 1, `exit=${r.code}`);
ok('D-03 git 缺失时假 powershell 未被调用（called.txt 不存在）', !existsSync(CALLED), r.called || '<无>');

note('--- E 组：powershell 缺失必须 FAIL ---');
writeStubs({ powershell: false });
r = run();
ok('E-01 powershell 缺失出 [FAIL]', /\[FAIL\]\s*powershell not found/.test(r.out), r.out.split(/\r?\n/).filter((l) => l.includes('FAIL')).join(' | '));
ok('E-02 powershell 缺失时退出码非 0', r.code === 1, `exit=${r.code}`);

note('--- F 组：python 缺失只 WARN 不阻断（PS 侧有托管 python 兜底）---');
writeStubs({ python: false });
r = run();
ok('F-01 python 缺失出 [WARN]', /\[WARN\].*python not on PATH/.test(r.out), r.out.split(/\r?\n/).filter((l) => l.includes('WARN')).join(' | '));
ok('F-02 python 缺失仍继续发布（exit 0）', r.code === 0 && r.called.includes('ARGS='), `exit=${r.code}`);

note('--- G 组：发布脚本非零退出码向上传导 ---');
writeStubs({ psRc: '7' });
r = run();
ok('G-01 假 ps1 返回 7 时 bat 判定 [ERROR]', /\[ERROR\].*exited with code 7/.test(r.out), r.out.split(/\r?\n/).filter((l) => l.includes('ERROR')).join(' | '));
ok('G-02 失败转 exit 1（与 AirMirror 启动器同口径）', r.code === 1, `exit=${r.code}`);

note('--- H 组：编码与字面锚点（配行为腿：bat 已被 cmd 解析）---');
ok('H-01 bat 保持纯 ASCII（cmd GBK/UTF-8 代码页都不炸）', [...batText].every((c) => c.charCodeAt(0) < 128), `非 ASCII 字符数=${[...batText].filter((c) => c.charCodeAt(0) >= 128).length}`);
ok('H-02 无 BOM', !batText.startsWith('\uFEFF'), batText.slice(0, 4));
ok('H-03 前置检查锚点在文件里（且 A~G 已证明这些行被真执行）',
  ['findstr /i /b "GH_TOKEN="', 'where git', 'where powershell', 'where python', 'NO_PAUSE', '!EXTRA!'].every((s) => batText.includes(s)),
  ['findstr /i /b "GH_TOKEN="', 'where git', 'where powershell', 'where python', 'NO_PAUSE', '!EXTRA!'].filter((s) => !batText.includes(s)).join(',') || '全在');

const summary = `PASS=${pass} FAIL=${fail}\n门：verify-publish-preflight · 一键发布前置检查（对标 AirMirror）\n`;
const resultFile = writeGateResults(path.join(ROOT, '.workbuddy'), 'publish-preflight-gate-results.txt', summary);
note(`结果文件：${resultFile}`);
console.log = origLog;
process.exitCode = fail === 0 ? 0 : 1;
