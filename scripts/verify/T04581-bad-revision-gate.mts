/**
 * T04581 验收门：Git 分支查询 bad revision 不再误报成「无法连接到本机服务或取数被拒绝」。
 *
 * 缺陷形态（2026-11-08 实测）：`feature/hnnxbank/dev` 只在 BEMP5.0DEV 工作空间的子仓库
 * （adapter/banks/bom/deploy/framework/frontend/served），根仓库只有 master。单仓库分支输入框
 * 对根仓库查询 → `git log … feature/hnnxbank/dev --` 回 `fatal: bad revision` → classifyExecError
 * 归为通用 failed → queryGitLog 抛出 → 路由 HTTP 400 → 前端 catch 显示「无法连接到本机服务或取数被拒绝：Git 采集失败」。
 *
 * work order 锚定词（R-318：本组断言引用的路径/词形与本单正文一致）：
 *   `scripts/verify/T04581-bad-revision-gate.mts`（本门自指）
 *   `bad revision` / `feature/hnnxbank/dev` / `classifyExecError` / `bad-revision` / `queryGitLog`
 *   `无法连接到本机服务或取数被拒绝` / `多仓库选范围` / `子仓库` / `git fetch`
 *
 * 分组：
 *   A 组（真仓库）：collectGitGraph 对不存在的分支抛 GitCollectError 且 kind='bad-revision'、
 *      文案点名分支并给「子仓库 / git fetch」指引；存在的分支正常取数（负控制，不是全报错全绿）；
 *   B 组（服务端口径，本进程 + 临时库）：queryGitLog 对 bad revision 回结构化 ok:false（不抛出），
 *      路由因此回 200 而非 400；子仓库同名分支取数成功；根仓库 master 成功（负控制）；
 *   C 组（接线锚点）：分类与结构化收口真的落在源码里，前端误导文案路径仍只在网络异常时触发。
 *
 * 用法（R-327：绝对 Node 路径 + 明确工作目录）：
 *   cd /d/code/otherProjects/MTask
 *   D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/verify/T04581-bad-revision-gate.mts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
const { GitCollectError, collectGitGraph } = G;

/** 造一份「根仓库只有 master、子仓库才有 feature/hnnxbank/dev」的夹具——正是 BEMP5.0DEV 的形状 */
function makeRepoFixture(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(path.join(os.tmpdir(), 't04581-'));
  const git = (cwd: string, ...args: string[]): string => execFileSync(
    'git',
    ['-c', 'user.name=gate', '-c', 'user.email=gate@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: ws, GIT_TERMINAL_PROMPT: '0' } },
  ).trim();
  const commit = (cwd: string, msg: string) => {
    writeFileSync(path.join(cwd, 'a.txt'), `${msg}\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-q', '-m', msg);
  };
  const root = path.join(ws, 'root');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'master');
  commit(root, 'root c1');
  const sub = path.join(root, 'served');
  mkdirSync(sub);
  git(sub, 'init', '-q', '-b', 'feature/hnnxbank/dev');
  commit(sub, 'sub c1');
  return { ws: root, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

const fixture = makeRepoFixture();
try {
  /* ============================ A 组：分类与真仓库 ============================ */
  group('A 组 · bad revision 归类与可处置文案');
  let thrown: unknown;
  try {
    await collectGitGraph(fixture.ws, { head: 'feature/hnnxbank/dev', limit: 50 });
  } catch (e) {
    thrown = e;
  }
  ok('A-01 不存在的分支抛 GitCollectError（不是裸 Error / 不是返回空表）',
    thrown instanceof GitCollectError, thrown instanceof Error ? thrown.message : thrown);
  const err = thrown as InstanceType<typeof GitCollectError>;
  ok('A-02 错误 kind 是 bad-revision（与通用 failed 区分，前端/路由据此给指引）',
    err?.kind === 'bad-revision', err?.kind);
  ok('A-03 文案点名该分支并给「子仓库 / git fetch」可处置指引（不再是 git 原生报错一行）',
    /feature\/hnnxbank\/dev/.test(err?.message ?? '') && /子仓库/.test(err?.message ?? '') && /fetch/.test(err?.message ?? ''),
    err?.message);
  ok('A-04 文案不再含误导性的「无法连接到本机服务」（那是网络异常专用，不该出现在分支不存在时）',
    !/无法连接到本机服务/.test(err?.message ?? ''), err?.message);

  const rootPage = await collectGitGraph(fixture.ws, { head: 'master', limit: 50 });
  ok('A-05 负控制：根仓库存在的 master 正常取到提交（A 组不是「全都报错所以全绿」）',
    rootPage.commits.length > 0, { n: rootPage.commits.length });
  const subPage = await collectGitGraph(path.join(fixture.ws, 'served'), { head: 'feature/hnnxbank/dev', limit: 50 });
  ok('A-06 负控制：同名分支在子仓库里真实存在并可取数（证明 bad revision 是「这个仓库没有」而非分支非法）',
    subPage.commits.length > 0, { n: subPage.commits.length });

  /* ============================ B 组：服务端结构化收口（本进程 + 临时库） ============================ */
  group('B 组 · queryGitLog 回结构化 ok:false（路由因此 200 而非 400）');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 't04581-b'));
  process.env.MTask_DATA_DIR = path.join(scratch, 'data');
  try {
    const { initSchema } = await import(pathToFileURL(path.join(ROOT, 'server/src/db/schema.ts')).href);
    const { getDb, closeDb } = await import(pathToFileURL(path.join(ROOT, 'server/src/db/connection.ts')).href);
    initSchema();
    const now = new Date().toISOString();
    getDb().prepare('INSERT INTO projects (id, name, created_at, updated_at, workspace_path) VALUES (?, ?, ?, ?, ?)')
      .run('b-probe', 'B 组临时项目', now, now, fixture.ws);
    const { queryGitLog } = await import(pathToFileURL(path.join(ROOT, 'server/src/services/lectureGitLog.ts')).href);

    // 关键回归：修复前这里会**抛出**（路由 catch → HTTP 400 → 前端误导文案）；修复后回结构化 ok:false。
    let bad: Awaited<ReturnType<typeof queryGitLog>> | undefined;
    let didThrow = false;
    try {
      bad = await queryGitLog({ projectId: 'b-probe', head: 'feature/hnnxbank/dev', limit: 50 });
    } catch {
      didThrow = true;
    }
    ok('B-01 根仓库查不存在的分支不再抛出（结构化返回，路由不会落到 400 catch）',
      didThrow === false && bad !== undefined, { didThrow });
    ok('B-02 返回 ok:false 且 error.kind=bad-revision、文案点名分支（前端走 r.ok=false 显示真因）',
      bad?.ok === false && bad?.error?.kind === 'bad-revision' && /feature\/hnnxbank\/dev/.test(bad?.error?.message ?? ''),
      { ok: bad?.ok, error: bad?.error });
    ok('B-03 失败回包仍是完整形状（commits 空数组、repoSub 回显），不是半截对象',
      Array.isArray(bad?.commits) && bad?.commits.length === 0 && bad?.repoSub === '',
      { commits: bad?.commits, repoSub: bad?.repoSub });

    const subLog = await queryGitLog({ projectId: 'b-probe', repoSub: 'served', head: 'feature/hnnxbank/dev', limit: 50 });
    ok('B-04 负控制：同一分支在子仓库 served 取数成功（多仓库选范围按子仓库查即可用）',
      subLog.ok === true && subLog.commits.length > 0 && subLog.repoSub === 'served',
      { ok: subLog.ok, n: subLog.commits.length, repoSub: subLog.repoSub, error: subLog.error });
    const rootLog = await queryGitLog({ projectId: 'b-probe', head: 'master', limit: 50 });
    ok('B-05 负控制：根仓库 master 取数成功（B 组不是「全都报错所以全绿」）',
      rootLog.ok === true && rootLog.commits.length > 0, { ok: rootLog.ok, n: rootLog.commits.length, error: rootLog.error });
    closeDb();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} finally {
  fixture.cleanup();
}

/* ============================ C 组：接线锚点 ============================ */
group('C 组 · 修复真的落在源码里');
const collectSrc = readFileSync(path.join(ROOT, 'server/src/services/gitCollect.ts'), 'utf8');
const logSrc = readFileSync(path.join(ROOT, 'server/src/services/lectureGitLog.ts'), 'utf8');
const modalSrc = readFileSync(path.join(ROOT, 'web/src/ui/GitTreePickerModal.tsx'), 'utf8');
ok('C-01 GitErrorKind 含 bad-revision 且 classifyExecError 有对应分类',
  /'bad-revision'/.test(collectSrc) && /BAD_REVISION_RE\.test\(hay\)/.test(collectSrc));
ok('C-02 queryGitLog 用 try/catch 收口取数失败并回 fail(...)（不再让 collectGitGraph 裸抛到路由）',
  /catch \(e\) \{[\s\S]{0,200}return fail\(project, req, kind/.test(logSrc));
ok('C-03 前端误导文案「无法连接到本机服务或取数被拒绝」仍只在 catch（网络/5xx）分支，结构化 error 走 r.ok=false',
  /if \(!r\.ok\) \{[\s\S]{0,120}setError\(r\.error\?\.message/.test(modalSrc)
  && /catch \(e\) \{[\s\S]{0,160}无法连接到本机服务或取数被拒绝/.test(modalSrc));

if (fail > 0) {
  console.error(lines.join('\n'));
  console.error(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
console.log(lines.join('\n'));
console.log(`\nPASS=${pass} FAIL=${fail}`);