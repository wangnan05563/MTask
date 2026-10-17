/**
 * T02295 回归门：HEAD 自洽性判据——对 **HEAD 的 worktree 副本**跑 `tsc --noEmit`（server + web）。
 *
 * 拦的是本仓的常态缺陷：**工作树 typecheck 全绿不代表 HEAD 能编译**。本仓常年有并发会话 WIP，
 * 工作树是「HEAD + 所有未提交 hunk」的叠加态，一个提交漏带的依赖（引用入库了、定义没入库）
 * 会被另一个会话的 WIP 恰好补齐，于是只看工作树永远看不出来。已实测两例：
 *   - `140a88d`（T02284）把注释插进文档注释块中间 → HEAD 上 `TaskService.ts` 不可解析；
 *   - `kickoff-layout.ts` 引 `exportStyle` 的 BRAND_* 四导出，而那 18 行导出留在工作树未提交
 *     → HEAD 副本 `tsc` 报 4×TS2305（由 T02310/d678d79 补提收口）。
 * 门侧之所以抓不到：`scripts/verify-*` 一律 tsx 直载 `src/`，而 **tsx 是 transpile-only 不做类型检查**。
 * 判发布真正的硬前置是 `scripts/打包.mjs` 第 [3] 步 `tsc --noEmit -p server/tsconfig.json`——
 * 本门把它前置成一条可随时复跑的判据，且不看工作树一眼。
 *
 * 用法（不需要起服务、不读生产数据；只在 D: 上建临时 worktree 副本）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02295-head-selfconsistency.mts
 *   环境变量：T02295_TMP_ROOT（副本根，默认 D:/code/tmp，**勿指 C:**——常年 0 可用会假性失败）、
 *             T02295_KEEP=1 保留副本便于排障（默认跑完 `git worktree remove` + prune）。
 *
 * 纪律：`git worktree add --detach` 只读 HEAD 建副本，不动工作树、不动别人的 WIP；
 * 副本的 `node_modules` 是**指向仓库根的 junction**，清理时必须**先 unlink 再删目录**
 * （否则会顺着 junction 删掉仓库根真实依赖——H-08 就是这条自伤的看守断言）。
 * H-07 是反证：在副本里把一处导出名删掉，tsc 必须报 TS2305——证明本门不是恒绿摆设。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = process.env.T02295_TMP_ROOT || 'D:/code/tmp';
const COPY = join(TMP_ROOT, `t02295-headwt-${process.pid}`);
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
mkdirSync(TMP_ROOT, { recursive: true });

// 前置：仓库根 node_modules 必须在（副本靠 junction 挂它跑 tsc，见 mcp-run-node-path-stale 踩坑）
const HEAD_SHA = (() => { try { return git('rev-parse', 'HEAD').trim(); } catch { return ''; } })();
ok('H-01 前置：HEAD 可解析且仓库根 node_modules 在位（副本 tsc 依赖它）',
  !!HEAD_SHA && existsSync(join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')),
  `HEAD=${HEAD_SHA || '取不到'} typescript=${existsSync(join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'))}`);

let worktreeAdded = false;
if (HEAD_SHA && existsSync(join(ROOT, 'node_modules'))) {
  try {
    rmSync(COPY, { recursive: true, force: true });
    git('worktree', 'add', '--detach', COPY, HEAD_SHA);
    worktreeAdded = true;
  } catch (e) {
    note(`     ↳ worktree add 失败：${String(e).slice(0, 200)}`);
  }
}
ok('H-02 对 HEAD 建分离 worktree 副本成功（判据打在提交上，不是工作树叠加态）', worktreeAdded, `副本路径 ${COPY}`);

let cleanCopy = false;
let junctionOk = false;
if (worktreeAdded) {
  try { cleanCopy = git('-C', COPY, 'status', '--porcelain').trim() === ''; } catch { cleanCopy = false; }
  try {
    symlinkSync(join(ROOT, 'node_modules'), join(COPY, 'node_modules'), 'junction');
    junctionOk = existsSync(join(COPY, 'node_modules', 'typescript', 'bin', 'tsc'));
  } catch (e) {
    note(`     ↳ junction 失败：${String(e).slice(0, 200)}`);
  }
}
ok('H-03 副本工作区干净（--porcelain 无输出，证明测的就是 HEAD 内容）', cleanCopy);
ok('H-04 副本已挂上仓库根 node_modules（junction，未复制依赖）', junctionOk,
  `typescript 可见=${junctionOk}`);

/** 在副本里跑一次 tsc；返回 {code, text}。TEMP/TMP 指 D: 防 C: 满导致的假失败。 */
function tscInCopy(project: string): { code: number; text: string } {
  const r = spawnSync(process.execPath,
    [join(COPY, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', join(COPY, project, 'tsconfig.json')],
    { cwd: COPY, encoding: 'utf8', env: { ...process.env, TEMP: TMP_ROOT, TMP: TMP_ROOT }, maxBuffer: 40 * 1024 * 1024, timeout: 900_000 });
  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

let serverRun: { code: number; text: string } = { code: -1, text: '未执行（前置未过）' };
let webRun: { code: number; text: string } = { code: -1, text: '未执行（前置未过）' };
if (junctionOk) {
  serverRun = tscInCopy('server');
  webRun = tscInCopy('web');
}
const errOf = (t: string): string[] => t.split(/\r?\n/).filter((l) => /error TS\d/.test(l));
ok('H-05 HEAD 副本 `tsc --noEmit -p server/tsconfig.json` 零错误（重打包第 [3] 步的硬前置）',
  serverRun.code === 0, `exit=${serverRun.code}｜${errOf(serverRun.text).slice(0, 3).join(' ⏎ ').slice(0, 400)}`);
ok('H-06 HEAD 副本 `tsc --noEmit -p web/tsconfig.json` 零错误',
  webRun.code === 0, `exit=${webRun.code}｜${errOf(webRun.text).slice(0, 3).join(' ⏎ ').slice(0, 400)}`);

// 反证：只破坏副本（工作树不动），证明「引用入库、定义没入库」这类破损能被本判据拓出来
let neg: { code: number; text: string } = { code: 0, text: '未执行' };
if (junctionOk) {
  const target = join(COPY, 'server', 'src', 'util', 'exportStyle.ts');
  if (existsSync(target)) {
    const orig = readFileSync(target, 'utf8');
    // 挑一处导出名删掉「定义」但保留引用侧——正是 T02295 记录的那类不自洽形态
    const m = /export const (BRAND_[A-Z]+|ON_BRAND)/.exec(orig);
    if (m) {
      writeFileSync(target, orig.replace(m[0], `// const ${m[1]} = 已被本反证移除（仅副本）`), 'utf8');
      neg = tscInCopy('server');
      writeFileSync(target, orig, 'utf8');
    } else {
      neg = { code: 0, text: '副本里没找到可移除的 BRAND_* 导出（改判据时需换靶子）' };
    }
  } else {
    neg = { code: 0, text: '副本缺少 server/src/util/exportStyle.ts（改判据时需换靶子）' };
  }
}
ok('H-07 反证（只破坏副本）：抽掉一个被引用的导出后 tsc 必须报错——本判据不是恒绿摆设',
  neg.code !== 0 && /TS2305|TS2304|Cannot find/.test(neg.text),
  `exit=${neg.code}｜${errOf(neg.text).slice(0, 2).join(' ⏎ ').slice(0, 300) || neg.text.slice(0, 200)}`);

// 清理：必须先 unlink junction 再删目录，否则会顺着 junction 删掉仓库根真实依赖
const KEEP = !!process.env.T02295_KEEP;
let removed = false;
let unlinked = true;
let rootIntact = false;
if (worktreeAdded) {
  if (KEEP) {
    note(`     ↳ T02295_KEEP=1：副本保留在 ${COPY}（junction 未解除，排障后须先 rmdir 掉 node_modules 再 worktree remove）`);
  } else {
    try {
      rmSync(join(COPY, 'node_modules'), { force: true });
      unlinked = !existsSync(join(COPY, 'node_modules'));
    } catch { unlinked = false; }
    if (unlinked) {
      try {
        git('worktree', 'remove', '--force', COPY);
        removed = true;
      } catch {
        try { rmSync(COPY, { recursive: true, force: true }); git('worktree', 'prune'); removed = true; } catch { removed = false; }
      }
    }
  }
  rootIntact = existsSync(join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'));
}
ok(`H-08 清理${KEEP ? '（T02295_KEEP=1：只确认仓库根依赖未被波及）' : '：junction 先解除、临时 worktree 已移除'}，仓库根 node_modules 完好`,
  KEEP ? rootIntact : unlinked && removed && rootIntact,
  `junction 已解除=${unlinked} worktree 移除=${removed} 根依赖在位=${rootIntact}`);
const registry = (() => { try { return git('worktree', 'list').trim().split(/\r?\n/).length; } catch { return -1; } })();
ok('H-09 worktree 注册表无残留（本门跑完不污染并发会话的 worktree 列表）',
  registry >= 0 && (KEEP || !git('worktree', 'list').includes(COPY.replace(/\\/g, '/'))),
  `注册表条目 ${registry}`);

const summary = `PASS=${pass} FAIL=${fail}\n门：verify-t02295-head-selfconsistency · HEAD ${HEAD_SHA.slice(0, 7)} · 副本 ${COPY}\n${LINES.join('\n')}\n`;
console.log(`\nPASS=${pass} FAIL=${fail}`);
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02295-head-selfconsistency-gate-results.txt', summary, { note: `HEAD ${HEAD_SHA.slice(0, 7)}` });
console.log(`结果文件：${resultsFile}`);
process.exit(fail > 0 ? 1 : 0);
