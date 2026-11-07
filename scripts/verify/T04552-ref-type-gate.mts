/**
 * T04552 验收门：ref 类型改由 `for-each-ref` 的真实 refname 前缀定性（不再从 `%D` 文本猜斜杠）。
 *
 * work order 锚定词（R-318：本组断言引用的路径/词形与本单正文一致）：
 *   `scripts/verify/T04552-ref-type-gate.mts`（本门自指）
 *   `for-each-ref` / `refs/heads` / `refs/remotes` / `refs/tags` / `parseRefNameList` / `collectRefTypes`
 *   `branchNameOf` / `origin/x`（字面名叫 origin/x 的本地分支）/ `release/2.3`（本地与远端同名）
 *
 * 守的行为判据：
 *   A 组：白名单真的只放行只读取数形态（`--format` 限定字符集、位置参数限定三个命名空间）；
 *   B 组：解析按 refname 前缀定性、按指向提交 SHA 索引（注解标签要剥壳、未知命名空间丢弃）；
 *   C 组：真仓库端到端——本地 `release/2.3` 与远端 `origin/release/2.3` 同时存在时两个 ref 都在，
 *        同一个名字在不同命名空间互不覆盖，字面名叫 `origin/x` 的本地分支判 branch；
 *   D 组：前端归一化只看 `ref.type`（branch 原样 / remote 只削首段 / tag 不参与）；
 *   E 组：接线锚点——服务端图采集真的用上了新类型源，旧的斜杠猜测已删除。
 *
 * 用法（R-327：绝对 Node 路径 + 明确工作目录）：
 *   cd /d/code/otherProjects/MTask
 *   D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/verify/T04552-ref-type-gate.mts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const group = (t: string) => lines.push(`\n—— ${t} ——`);
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const G = await import(pathToFileURL(path.join(ROOT, 'server/src/services/gitCollect.ts')).href);
const { GIT_OUTPUT_CONFIG, GitCollectError, buildGitArgv, collectGitGraph, parseRefNameList } = G;
const U = await import(pathToFileURL(path.join(ROOT, 'web/src/utils/gitRepoBranchGroups.ts')).href);
const { branchNameOf } = U;

const rejected = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch (e) { return e instanceof GitCollectError && e.kind === 'denied'; }
};

// ---------------------------------------------------------------------------
group('A 组 · 白名单只放行只读取数形态');
// ---------------------------------------------------------------------------
const FORMAT = '--format=%(refname)%09%(objectname)%09%(*objectname)';
const argv = buildGitArgv('for-each-ref', [FORMAT], ['refs/heads', 'refs/remotes', 'refs/tags']);
ok('A-01 只读取数形态被接受，且注入的输出配置仍在最前',
  argv.slice(0, GIT_OUTPUT_CONFIG.length).join('\u0000') === GIT_OUTPUT_CONFIG.join('\u0000') && argv[GIT_OUTPUT_CONFIG.length] === 'for-each-ref',
  argv);
ok('A-02 三个命名空间位置参数原样进入 argv',
  argv.slice(-3).join(',') === 'refs/heads,refs/remotes,refs/tags', argv.slice(-3));
ok('A-03 拒绝不带 refs/ 前缀的位置参数（通配/单段一律不放行）',
  rejected(() => buildGitArgv('for-each-ref', [FORMAT], ['--all']))
  && rejected(() => buildGitArgv('for-each-ref', [FORMAT], ['heads'])));
ok('A-04 拒绝含换行/空白/引号的 --format（值只能是本文件常量）',
  rejected(() => buildGitArgv('for-each-ref', ['--format=%(refname)\n%(objectname)'], ['refs/heads']))
  && rejected(() => buildGitArgv('for-each-ref', ['--format=%(refname) --output=x'], ['refs/heads'])));
ok('A-05 拒绝写盘/排序类选项（白名单外）',
  rejected(() => buildGitArgv('for-each-ref', ['--sort=-committerdate'], ['refs/heads']))
  && rejected(() => buildGitArgv('for-each-ref', ['--points-at=HEAD'], ['refs/heads'])));

// ---------------------------------------------------------------------------
group('B 组 · parseRefNameList：按 refname 前缀定性、按提交 SHA 索引');
// ---------------------------------------------------------------------------
const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const T2 = 'c'.repeat(40);
const parsed = parseRefNameList([
  `refs/heads/release/2.3\t${C1}\t`,
  `refs/heads/origin/x\t${C1}\t`,
  `refs/remotes/origin/release/2.3\t${C1}\t`,
  `refs/tags/v1.0\t${C2}\t`,
  `refs/tags/v2.0\t${T2}\t${C2}`,
  `refs/notes/commits\t${C2}\t`,
  '',
].join('\n'));
const at = (sha: string) => parsed.get(sha) ?? [];
const has = (sha: string, type: string, name: string) => at(sha).some((r: any) => r.type === type && r.name === name);
ok('B-01 本地 `release/2.3` 与远端 `origin/release/2.3` 各自成条、类型不同、名字互不覆盖',
  has(C1, 'branch', 'release/2.3') && has(C1, 'remote', 'origin/release/2.3')
  && at(C1).filter((r: any) => r.name.includes('release/2.3')).length === 2,
  at(C1));
ok('B-02 字面名叫 `origin/x` 的本地分支是 branch，不是 remote',
  has(C1, 'branch', 'origin/x') && !has(C1, 'remote', 'origin/x'), at(C1));
ok('B-03 轻量标签用 objectname 直接落提交', has(C2, 'tag', 'v1.0'), at(C2));
ok('B-04 注解标签用 %(*objectname) 剥壳后落提交（不是标签对象 SHA）',
  has(C2, 'tag', 'v2.0') && parsed.get(T2) === undefined, { C2: at(C2), T2: parsed.get(T2) });
ok('B-05 三个命名空间之外的引用不参与展示（refs/notes 丢弃）',
  !at(C2).some((r: any) => r.name.includes('commits')), at(C2));
ok('B-06 空/畸形行不产生条目（SHA 非 40 位十六进制）',
  parseRefNameList(`refs/heads/main\tabc\t\nrefs/heads/main\t${C1}\t`).size === 1);

// ---------------------------------------------------------------------------
group('C 组 · 真仓库端到端：类型来自实际 refname');
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), 't04552-gate-'));
const repo = path.join(tmp, 'repo');
mkdirSync(repo);
const git = (...args: string[]): string => execFileSync(
  'git',
  ['-c', 'user.name=gate', '-c', 'user.email=gate@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tmp, GIT_TERMINAL_PROMPT: '0' } },
).trim();
try {
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'c1');
  const c1 = git('rev-parse', 'HEAD');
  git('branch', 'release/2.3');
  git('branch', 'origin/x');
  git('update-ref', 'refs/remotes/origin/release/2.3', c1);
  git('tag', 'v1.0');
  git('tag', '-a', 'v2.0', '-m', 'annotated');
  const page = await collectGitGraph(repo, { all: true, limit: 50 });
  const entry = page.commits.find((e: any) => e.sha === c1);
  const types = (entry?.refs ?? []).map((r: any) => `${r.type}:${r.name}`);
  ok('C-01 同一提交上本地与远端同名引用都在（旧实现会因名字含斜杠把本地也标成 remote）',
    types.includes('branch:release/2.3') && types.includes('remote:origin/release/2.3'), types);
  ok('C-02 远端名 `origin` 没有被当成本地分支名的前缀吃掉（两条都保留）',
    (entry?.refs ?? []).filter((r: any) => r.name.endsWith('release/2.3')).length === 2, types);
  ok('C-03 字面名叫 `origin/x` 的本地分支判 branch', types.includes('branch:origin/x'), types);
  ok('C-04 轻量标签与注解标签都挂在被指向的提交上且类型为 tag',
    types.includes('tag:v1.0') && types.includes('tag:v2.0'), types);
  ok('C-05 HEAD 仍然由装饰文本识别（当前分支 main 所在提交 head=true）', entry?.head === true, entry?.head);
  ok('C-06 非引用指向的提交不会凭空带 refs（空数组而不是继承别的提交）',
    page.commits.every((e: any) => e.sha === c1 || e.refs.length === 0), page.commits.map((e: any) => [e.sha.slice(0, 7), e.refs.length]));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
group('D 组 · 前端归一化只看 ref.type');
// ---------------------------------------------------------------------------
const ref = (type: string, name: string) => ({ type, name });
ok('D-01 本地带斜杠分支原样（不再削成 `2.3`）', branchNameOf(ref('branch', 'release/2.3')) === 'release/2.3');
ok('D-02 远端跟踪引用只削首段', branchNameOf(ref('remote', 'origin/release/2.3')) === 'release/2.3');
ok('D-03 字面名叫 origin/x 的本地分支原样返回（原「已知残余误差」转为正向断言）',
  branchNameOf(ref('branch', 'origin/x')) === 'origin/x', String(branchNameOf(ref('branch', 'origin/x'))));
ok('D-04 同名不同命名空间互不影响', branchNameOf(ref('remote', 'origin/x')) === 'x');
ok('D-05 tag 不参与聚合、origin/HEAD 不成组',
  branchNameOf(ref('tag', 'v1.0')) === null && branchNameOf(ref('remote', 'origin/HEAD')) === null);

// ---------------------------------------------------------------------------
group('E 组 · 接线锚点（新类型源真的用上、旧猜测已删除）');
// ---------------------------------------------------------------------------
const { readFileSync } = await import('node:fs');
const srcNow = readFileSync(path.join(ROOT, 'server/src/services/gitCollect.ts'), 'utf8');
ok('E-01 旧的「含斜杠即 remote」猜测已从源码删除',
  !srcNow.includes("token.includes('/') ? 'remote'"));
ok('E-02 图采集调用 `collectRefTypes` 并按 SHA 回填 refs',
  /const refsBySha = await collectRefTypes\(cwd, opts\);[\s\S]{0,120}e\.refs = refsBySha\.get\(e\.sha\)/.test(srcNow));
ok('E-03 讲稿卡与 Git 树共用同一图采集（refs 仍经 collectGitGraph 产出）',
  readFileSync(path.join(ROOT, 'server/src/services/lectureGitLog.ts'), 'utf8').includes('collectGitGraph('));

if (fail > 0) {
  console.error(lines.join('\n'));
  console.error(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
console.log(lines.join('\n'));
console.log(`\nPASS=${pass} FAIL=${fail}`);
