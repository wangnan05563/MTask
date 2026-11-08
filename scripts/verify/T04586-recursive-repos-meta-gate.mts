/*
 * T04586 验收门：递归查询工作空间内多 git 仓库（含每仓 branch/commit/remote 元数据）。
 *
 * 工单锚定词（R-318）：
 *   scripts/verify/T04586-recursive-repos-meta-gate.mts
 *   server/src/services/nestedRepos.ts  server/src/services/lectureGitLog.ts  server/src/services/gitCollect.ts
 *   discoverNestedRepos  collectRepoBasicMeta  enrichReposWithMeta  --abbrev-ref  maxDepth
 *
 * 前置：隔离后端 MTask_PORT=39911 MTask_DATA_DIR=<tmp>/t04586/data（REST 取数）。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04586-recursive-repos-meta-gate.mts
 *
 * A 组 递归发现 + 元数据（根非仓库不阻塞 / 任意层级 / 过滤非 git / 每项 branch+commit+remote）
 * B 组 向后兼容（discoverNestedRepos 缺省深度2 不变 / 单仓库 git-log 仍可用）
 * C 组 源码锚
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverNestedRepos } from '../../server/src/services/nestedRepos';

const BASE = process.env.MTASK_API_BASE || 'http://127.0.0.1:39911';
const REPO = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`[FAIL] ${name} :: ${detail}`); }
};

/* ---------- 夹具：根目录「不是」仓库；depth1 三仓 + depth3 一仓 + 一个非 git 目录 ---------- */
const WS = path.join(os.tmpdir(), `t04586-gate-ws-${Date.now()}`);
fs.mkdirSync(WS, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const makeRepo = (rel: string, branch: string) => {
  const dir = rel ? path.join(WS, rel) : WS;
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 't04586@test.local');
  git(dir, 'config', 'user.name', 'T04586');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'f.txt'), `T04586 ${rel || 'root'}\n`);
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-q', '-m', `T04586-${rel || 'root'}`);
  git(dir, 'remote', 'add', 'origin', `https://example.com/${(rel || 'root').replace(/\//g, '-')}.git`);
  return { dir, sha: git(dir, 'rev-parse', 'HEAD'), branch };
};
const banks = makeRepo('banks', 'dev');
const deploy = makeRepo('deploy', 'main');
const adapter = makeRepo('adapter', 'master');
const deep = makeRepo('grp/sub/deep', 'feat');
fs.mkdirSync(path.join(WS, 'docs'), { recursive: true }); // 非 git 普通目录，应被过滤
fs.writeFileSync(path.join(WS, 'docs', 'x.md'), 'not a repo\n');

const post = (u: string, b: any) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const patch = (u: string, b: any) => fetch(BASE + u, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (u: string) => fetch(BASE + u).then((r) => r.json());

try {
  const proj = await post('/api/projects', { name: `T04586 递归门项目-${Date.now()}`, description: '递归多仓库元数据门夹具' });
  await patch(`/api/projects/${proj.id}`, { workspacePath: WS });
  const res = await get(`/api/git/repos?projectId=${proj.id}`);

  console.log('—— A 组 · 递归发现 + 元数据 ——');
  ok('A-01 /git/repos 回 ok=true', res.ok === true, `error=${JSON.stringify(res.error ?? null)}`);
  const repos: any[] = res.repos ?? [];
  const bySub = (s: string) => repos.find((r) => r.subPath === s);
  ok('A-02 depth1 三仓 banks/deploy/adapter 都在清单', !!bySub('banks') && !!bySub('deploy') && !!bySub('adapter'), repos.map((r) => r.subPath).join(','));
  ok('A-03 depth3 嵌套 grp/sub/deep 不遗漏（任意层级）', !!bySub('grp/sub/deep'), `deep=${JSON.stringify(bySub('grp/sub/deep') ?? null)}`);
  ok('A-04 每项含 40 位 commit 且 branch 与夹具一致',
    [bySub('banks'), bySub('deploy'), bySub('adapter'), bySub('grp/sub/deep')].every((r) => r && /^[0-9a-f]{40}$/.test(r.commit || '')) &&
    bySub('banks')?.branch === 'dev' && bySub('deploy')?.branch === 'main' && bySub('adapter')?.branch === 'master' && bySub('grp/sub/deep')?.branch === 'feat',
    `banks=${bySub('banks')?.branch}@${(bySub('banks')?.commit || '').slice(0, 8)} deep=${bySub('grp/sub/deep')?.branch}`);
  ok('A-05 commit 与夹具真实 HEAD 逐字一致（banks）', bySub('banks')?.commit === banks.sha, `resp=${(bySub('banks')?.commit || '').slice(0, 8)} fixture=${banks.sha.slice(0, 8)}`);
  ok('A-06 origin remoteUrl 结构化返回', (bySub('banks')?.remoteUrl || '').includes('example.com/banks.git'), `remote=${bySub('banks')?.remoteUrl}`);
  ok('A-07 非 git 目录 docs 被过滤（不误报）', !bySub('docs'), repos.map((r) => r.subPath).join(','));
  ok('A-08 根非仓库不阻塞：无 isRoot 项仍发现子仓库', repos.length >= 4 && !repos.some((r) => r.isRoot === true), `count=${repos.length}`);
  ok('A-09 小夹具未触性能上限 truncated=false', res.truncated === false, `scannedDirs=${res.scannedDirs}`);

  console.log('\n—— B 组 · 向后兼容 ——');
  const defaultDepth = await discoverNestedRepos(WS);
  ok('B-01 discoverNestedRepos 缺省深度2 不含 depth3（旧调用方行为不变）', !defaultDepth.repos.some((r) => r.subPath === 'grp/sub/deep'), defaultDepth.repos.map((r) => r.subPath).join(','));
  ok('B-02 discoverNestedRepos 缺省仍含 depth1 banks（旧发现逻辑仍在）', defaultDepth.repos.some((r) => r.subPath === 'banks'));
  const log = await get(`/api/git/log?projectId=${proj.id}&repoSub=banks&limit=10`);
  ok('B-03 单仓库 git-log（repoSub=banks）仍 ok 且有提交（单仓库逻辑未改）', log.ok === true && (log.commits ?? []).length > 0, `commits=${(log.commits ?? []).length}`);

  console.log('\n—— C 组 · 源码锚 ——');
  const src = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
  const gc = src('server/src/services/gitCollect.ts');
  const nr = src('server/src/services/nestedRepos.ts');
  const lg = src('server/src/services/lectureGitLog.ts');
  ok('C-01 rev-parse 白名单含只读 --abbrev-ref', /'rev-parse': \[[^\]]*--abbrev-ref/.test(gc));
  ok('C-02 gitCollect 导出 collectRepoBasicMeta', /export async function collectRepoBasicMeta\(/.test(gc));
  ok('C-03 NestedRepo 增可选 branch/commit/remoteUrl', /branch\?: string;/.test(nr) && /commit\?: string;/.test(nr) && /remoteUrl\?: string;/.test(nr));
  ok('C-04 queryGitRepos 全深度 + 元数据富化', /maxDepth: Number\.POSITIVE_INFINITY/.test(lg) && /enrichReposWithMeta\(found\.repos\)/.test(lg));
  ok('C-05 元数据取数有并发上限（性能可控）', /const REPO_META_CONCURRENCY = 4;/.test(lg));
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;