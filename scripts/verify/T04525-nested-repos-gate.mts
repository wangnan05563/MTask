/**
 * T04525 验收门：Git 视图要能看见**同一工作空间目录下的多个仓库**（需求修订，上一轮实现存在偏差被验收打回）。
 *
 * 上一轮的偏差（母单【验证失败 2026-11-07】原话）：
 *   「当前是看到了多个工作空间下的不同分支 git 记录，原需求是希望能看到同一工作空间目录下的分支和多个仓库，
 *     如 `D:\code\QJ\BEMP5.0DEV` 下存在 master 和 feature/hnnxbank/dev 分支和 …served.git、…deploy.git、
 *     …adapter.git、…banks.git 等多个仓库」
 * 也就是：把「一个 MTask 项目 = 一个仓库」当成了事实。本门钉的就是**去掉这个假设**之后的行为。
 *
 * work order 锚定词（R-318：本组断言引用的路径/词形与本单正文一致）：
 *   `scripts/verify/T04525-nested-repos-gate.mts`（本门自指）
 *   `discoverNestedRepos` / `resolveRepoSubPath` / `repoSub` / `git/repos` / `censusTargetsFromRepoLists`
 *   `同一工作空间目录` / `多仓库` / `master` / `feature/hnnxbank/dev` / `BEMP5.0DEV`
 *
 * 分组：
 *   A 组（服务端发现）：`.git` 是唯一判据、命中即边界、跳过 node_modules/隐藏目录、深度与条数有界；
 *   B 组（路径包含校验）：`repoSub` 越界必须拒——这是拼接 git cwd 的入参，回落根仓库会把「子仓库的提交」
 *      读成「没有这些提交」，比报错更难查；
 *   C 组（前端视图判据）：仓库身份是 `项目 + 相对路径`，窗口键/勾选/确认/默认展开全部按它算，
 *      漏掉任何一处都会让根仓库与子仓库互相顶掉；
 *   D 组（真实夹具 LIVE）：真的读 `D:\code\QJ\BEMP5.0DEV`——根仓库 `master`、子仓库 `feature/hnnxbank/dev`，
 *      并断言两者引用清单**互不包含**（这才是「确实是两个仓库」的证据，而不是页面看起来多了几行）。
 *
 * 用法：
 *   1) 纯判据（A/B/C）：`node node_modules/tsx/dist/cli.mjs scripts/verify/T04525-nested-repos-gate.mts`
 *   2) 加 D 组：先起隔离后端
 *      `MTask_DATA_DIR=D:/tmp/t04525/data MTask_PORT=39907 MTASK_STATIC_DIR=<repo>/web/dist node node_modules/tsx/dist/cli.mjs server/src/index.ts`
 *      再带 `MTASK_LIVE_BASE=http://127.0.0.1:39907 MTASK_LIVE_REPO=D:/code/QJ/BEMP5.0DEV` 跑同一条命令。
 *      未传这两个环境变量时 D 组打 `[SKIP]`（不计绿也不计红），避免门在没夹具的机器上假失败。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { discoverNestedRepos, isRepositoryRoot, resolveRepoSubPath } from '../../server/src/services/nestedRepos.ts';
import {
  applyCommitCounts,
  blockedRepoRows,
  buildRepoBranchGroups,
  censusTargetsFromRepoLists,
  DEFAULT_OPEN_BRANCH_GROUPS,
  defaultExpandedBranches,
  defaultExpandedRepos,
  mergePaneSelections,
  paneKeyOf,
  repoInputFromScan,
  repoKeyOf,
  repoPathOf,
  resolveRepoConfirmation,
  sharedBranchGroups,
  type RepoBranchInput,
  type RepoListResult,
} from '../../web/src/utils/gitRepoBranchGroups.ts';

let pass = 0;
let fail = 0;
let skipped = 0;
const lines: string[] = [];
const group = (t: string) => lines.push(`\n—— ${t} ——`);
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const skip = (name: string, why: string) => {
  skipped += 1;
  lines.push(`[SKIP] ${name} :: ${why}`);
};

const P = (...seg: string[]) => path.join(...seg);
const touch = (file: string) => writeFileSync(file, '', 'utf8');

/** 造一份「一个目录里装着多个仓库」的夹具：正是需求里 BEMP5.0DEV 的形状 */
function makeFixture(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(P(os.tmpdir(), 't04525'));
  mkdirSync(P(ws, '.git'), { recursive: true });                 // 根仓库
  mkdirSync(P(ws, 'sub1', '.git'), { recursive: true });         // 第 1 层仓库
  mkdirSync(P(ws, 'sub2', '.git'), { recursive: true });         // 第 1 层仓库
  mkdirSync(P(ws, 'sub2', 'deeper', '.git'), { recursive: true });// 仓库内再嵌仓库：命中即边界，不该出现在清单
  mkdirSync(P(ws, 'node_modules', 'pkg', '.git'), { recursive: true });// 依赖目录里的 .git：必须跳过
  mkdirSync(P(ws, '.hidden-tool', 'x', '.git'), { recursive: true });   // 隐藏目录：必须跳过
  mkdirSync(P(ws, 'plain', 'nested', '.git'), { recursive: true });      // 第 2 层仓库：应被发现
  mkdirSync(P(ws, 'gitfile'));
  touch(P(ws, 'gitfile', '.git'));                              // gitfile（worktree/子模块形态）：同样是仓库
  mkdirSync(P(ws, 'docs'));                                     // 普通目录，无 .git
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

const fixture = makeFixture();
try {
  /* ============================ A 组：服务端发现 ============================ */
  group('A 组 · 同一工作空间目录的多仓库发现');
  const found = await discoverNestedRepos(fixture.ws);
  const subs = found.repos.map((r) => r.subPath);
  ok('A-01 工作空间根目录本身是仓库时进清单（subPath 空串且排第一）',
    found.repos[0]?.isRoot === true && found.repos[0]?.subPath === '', found.repos[0]);
  ok('A-02 第 1 层子仓库被发现（sub1/sub2）', subs.includes('sub1') && subs.includes('sub2'), subs);
  ok('A-03 第 2 层子仓库也被发现（plain/nested）', subs.includes('plain/nested'), subs);
  ok('A-04 `.git` 是文件（worktree/子模块的 gitfile）同样算仓库', subs.includes('gitfile'), subs);
  ok('A-05 node_modules 里的 .git 不算用户的仓库（否则每个依赖都冒充仓库）',
    !subs.some((s) => s.startsWith('node_modules')), subs);
  ok('A-06 隐藏目录（.开头）里的 .git 被跳过', !subs.some((s) => s.startsWith('.hidden-tool')), subs);
  ok('A-07 命中即边界：仓库内再嵌的仓库不下钻（sub2/deeper 不列）',
    !subs.includes('sub2/deeper'), subs);
  ok('A-08 无 .git 的普通目录（docs）自己不出现，但会往里看一层', !subs.includes('docs'), subs);
  ok('A-09 根仓库排第一，其余按相对路径字典序',
    subs.join('|') === [...subs].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))).join('|'), subs);
  ok('A-10 展示名：子仓库取目录名、根仓库取工作空间目录名',
    found.repos.find((r) => r.subPath === 'sub1')?.displayName === 'sub1'
    && found.repos[0]?.displayName === path.basename(fixture.ws), found.repos.map((r) => r.displayName));
  ok('A-11 子仓库 absPath 落在工作空间内（可当 git cwd）',
    found.repos.every((r) => path.resolve(r.absPath).startsWith(path.resolve(fixture.ws))), found.repos.map((r) => r.absPath));

  const capped = await discoverNestedRepos(fixture.ws, { maxCount: 3 });
  ok('A-12 条数上限生效且如实置 truncated（清单不许装作是全集）',
    capped.repos.length === 3 && capped.truncated === true, { n: capped.repos.length, truncated: capped.truncated });
  const shallow = await discoverNestedRepos(fixture.ws, { maxDepth: 1 });
  ok('A-13 深度上限生效：只看第 1 层（plain/nested 不在清单里）',
    !shallow.repos.some((r) => r.subPath === 'plain/nested') && shallow.truncated === true,
    shallow.repos.map((r) => r.subPath));
  const noRepo = await discoverNestedRepos(P(fixture.ws, 'docs'));
  ok('A-14 目录里一个仓库都没有 → 空清单（不抛错，由调用方给一句话）', noRepo.repos.length === 0, noRepo);
  const missing = await discoverNestedRepos(P(os.tmpdir(), 't04525-不存在-目录'));
  ok('A-15 工作空间不存在/无权限 → 空清单而不是崩', missing.repos.length === 0, missing);
  // 「仓库根」与「在某个工作树里」必须是两件事：D-06 实测发现只判后者时，根仓库内的 docs/ 会冒充子仓库
  ok('A-16 仓库根判定按 `.git` 实体：真正的子仓库判真', await isRepositoryRoot(P(fixture.ws, 'sub1')) === true);
  ok('A-17 工作树内的普通目录（docs，无 .git）判假——不许被当成独立仓库读成根仓库的历史',
    await isRepositoryRoot(P(fixture.ws, 'docs')) === false);
  ok('A-18 gitfile（worktree/子模块）同样判真', await isRepositoryRoot(P(fixture.ws, 'gitfile')) === true);

  /* ============================ B 组：路径包含校验 ============================ */
  group('B 组 · repoSub 必须落在工作空间之内');
  ok('B-01 空 repoSub = 工作空间根', resolveRepoSubPath(fixture.ws, '') === path.resolve(fixture.ws));
  ok('B-02 相对子路径解析为工作空间内的绝对路径',
    resolveRepoSubPath(fixture.ws, 'sub1') === P(path.resolve(fixture.ws), 'sub1'));
  ok('B-03 两段相对路径（POSIX 写法）也能解析',
    resolveRepoSubPath(fixture.ws, 'plain/nested') === P(path.resolve(fixture.ws), 'plain', 'nested'));
  /**
   * 只判「有没有抛」是不够的：M2 实测把 `throw` 换成一个未导入的 `resolve(...)`，
   * 抛的是 ReferenceError，B-04~B-07 照样全绿，62 项门一项没红——等于这条门从来没守住过。
   * 所以这里连**错误那句**一起核：拒必须点名「越出工作空间」。
   */
  const rejects = (fn: () => unknown): [boolean, string] => {
    try {
      const v = fn();
      return [false, `没抛错，返回 ${JSON.stringify(v)}`];
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      return [/越出工作空间/.test(msg), msg];
    }
  };
  const escCases: [string, () => unknown][] = [
    ['B-04 `../` 逃逸被拒', () => resolveRepoSubPath(fixture.ws, '../evil')],
    ['B-05 深层 `../../` 逃逸被拒', () => resolveRepoSubPath(fixture.ws, 'sub1/../../evil')],
    ['B-06 工作空间之外的绝对路径被拒', () => resolveRepoSubPath(fixture.ws, path.resolve(os.tmpdir()))],
    ['B-07 「前缀同名兄弟目录」陷阱被拒（/tmp/ws vs /tmp/ws2）',
      () => resolveRepoSubPath(fixture.ws, path.resolve(`${fixture.ws}2`))],
  ];
  for (const [name, fn] of escCases) {
    const [pass_, why] = rejects(fn);
    ok(name, pass_, why);
  }
  ok('B-08 工作空间内的绝对路径允许（同一目录的第二种写法，不该误拒）',
    resolveRepoSubPath(fixture.ws, P(path.resolve(fixture.ws), 'sub2')) === P(path.resolve(fixture.ws), 'sub2'));
  ok('B-09 指向工作空间自身的 `.`, 判为根仓库', resolveRepoSubPath(fixture.ws, '.') === path.resolve(fixture.ws));

  /* ============================ C 组：前端视图判据 ============================ */
  group('C 组 · 仓库身份 = 项目 + 目录内相对路径');
  const WS = 'D:/code/QJ/BEMP5.0DEV';
  const rootInput: RepoBranchInput = {
    projectId: 'p1', projectName: 'BEMP 5.0', workspacePath: WS, repoSub: '',
    refs: [{ name: 'master', type: 'branch' }, { name: 'HEAD', type: 'head' }], available: true,
  };
  const nestedBranches = (sub: string): RepoBranchInput => ({
    projectId: 'p1', projectName: 'BEMP 5.0', workspacePath: WS, repoSub: sub,
    refs: [{ name: 'feature/hnnxbank/dev', type: 'branch' }], available: true,
  });
  const inputs: RepoBranchInput[] = [rootInput, nestedBranches('served'), nestedBranches('adapter'), nestedBranches('banks')];
  const groups = buildRepoBranchGroups(inputs, 'p1');
  const devGroup = groups.find((g) => g.branchName === 'feature/hnnxbank/dev');
  ok('C-01 同一工作空间目录里的多个子仓库按分支名聚成一组',
    devGroup?.repos.length === 3, devGroup?.repos.map((r) => r.repoLabel));
  ok('C-02 根仓库的分支自成一组（master 只 1 个仓库，仍然可见而不是被过滤掉）',
    groups.some((g) => g.branchName === 'master' && g.repoCount === 1), groups.map((g) => [g.branchName, g.repoCount]));
  ok('C-03 仓库行身份含相对路径：同一项目的 4 个仓库 4 个不同 repoKey',
    new Set([...devGroup!.repos, ...groups.find((g) => g.branchName === 'master')!.repos].map((r) => r.repoKey)).size === 4,
    inputs.map((i) => repoKeyOf(i.projectId, i.repoSub)));
  ok('C-04 子仓库展示名带相对路径（一眼能判断这一行是哪个仓库——需求原话要消灭的正是分不清）',
    devGroup!.repos.every((r) => r.repoLabel.includes('·') && r.repoLabel.includes(r.repoSub)),
    devGroup!.repos.map((r) => r.repoLabel));
  ok('C-05 根仓库展示名仍是项目名（8 个子仓库不许让项目名被判成「同名项目」而多出目录尾缀）',
    groups.find((g) => g.branchName === 'master')!.repos[0]?.repoLabel === 'BEMP 5.0',
    groups.find((g) => g.branchName === 'master')!.repos[0]?.repoLabel);
  ok('C-06 展示路径带相对段', repoPathOf(WS, 'served') === `${WS}/served` && repoPathOf(WS, '') === WS,
    repoPathOf(WS, 'served'));
  ok('C-07 窗口键按仓库分开：根仓库与子仓库同分支不同键（否则会共用一份提交数）',
    paneKeyOf(repoKeyOf('p1', ''), 'x') !== paneKeyOf(repoKeyOf('p1', 'served'), 'x'));
  const counted = applyCommitCounts(groups, {
    [paneKeyOf(repoKeyOf('p1', 'served'), 'feature/hnnxbank/dev')]: 7,
    [paneKeyOf(repoKeyOf('p1', 'adapter'), 'feature/hnnxbank/dev')]: 3,
  });
  const countedDev = counted.find((g) => g.branchName === 'feature/hnnxbank/dev')!;
  ok('C-08 懒加载提交数写回各自仓库行，不串到别的仓库',
    countedDev.repos.find((r) => r.repoSub === 'served')?.commitCount === 7
    && countedDev.repos.find((r) => r.repoSub === 'adapter')?.commitCount === 3
    && countedDev.repos.find((r) => r.repoSub === 'banks')?.commitCount === null,
    countedDev.repos.map((r) => [r.repoSub, r.commitCount]));
  ok('C-09 组内总数只累加已加载的仓库', countedDev.totalCommits === 10, countedDev.totalCommits);
  ok('C-10 默认展开当前项目的**全部**仓库（根 + 子仓库），不是只展开根仓库',
    defaultExpandedRepos(countedDev, 'p1').length === 3 && defaultExpandedRepos(countedDev, 'p1').every((k) => k.startsWith('p1')),
    defaultExpandedRepos(countedDev, 'p1'));
  ok('C-11 其它项目的分支组不默认展开（上下文只跟当前项目）',
    defaultExpandedRepos(countedDev, 'other').length === 0);
  ok('C-12 同名跨仓库的分支才算「需要多一层折叠」的组',
    sharedBranchGroups(counted).map((g) => g.branchName).join() === 'feature/hnnxbank/dev',
    sharedBranchGroups(counted).map((g) => g.branchName));

  const merged = mergePaneSelections([
    { repoKey: repoKeyOf('p1', 'served'), projectId: 'p1', repoSub: 'served', shas: ['aaa', 'bbb'] },
    { repoKey: repoKeyOf('p1', 'served'), projectId: 'p1', repoSub: 'served', shas: ['bbb', 'ccc'] },
    { repoKey: repoKeyOf('p1', 'adapter'), projectId: 'p1', repoSub: 'adapter', shas: ['ddd'] },
  ]);
  ok('C-13 同一仓库两条分支的勾选按仓库去重合并',
    merged[repoKeyOf('p1', 'served')].shas.join(',') === 'aaa,bbb,ccc', merged[repoKeyOf('p1', 'served')].shas);
  const single = resolveRepoConfirmation({ [repoKeyOf('p1', 'served')]: merged[repoKeyOf('p1', 'served')] });
  ok('C-14 只勾一个仓库时确认回传该仓库的 SHA **并带上它的相对路径**（漏了下游会当根仓库取数）',
    single.ok === true && single.repoSub === 'served' && single.projectId === 'p1' && single.shas.join(',') === 'aaa,bbb,ccc', single);
  const multi = resolveRepoConfirmation(merged);
  ok('C-15 两个仓库都有勾选 → 拒绝伪合并并点名仓库数',
    multi.ok === false && multi.code === 'multi' && multi.repoKeys.length === 2, multi);
  ok('C-16 一个都没勾 → empty（不是 multi，文案不能骗人）',
    resolveRepoConfirmation({}).ok === false && resolveRepoConfirmation({}).code === 'empty');

  const mixedInputs: RepoBranchInput[] = [
    rootInput,
    repoInputFromScan({ id: 'p2', name: '另一个项目', workspacePath: WS, repoSub: 'served' }, { status: 'fulfilled', value: { refs: [], workspacePath: WS } }),
    repoInputFromScan({ id: 'p3', name: '未绑定项目', workspacePath: '', repoSub: '' }, { status: 'rejected', reason: '该项目未绑定工作空间，无法取 Git 数据' }),
    repoInputFromScan({ id: 'p4', name: '取数失败项目', workspacePath: WS, repoSub: 'deploy' }, { status: 'rejected', reason: 'git 崩溃了' }),
  ];
  const blocked = blockedRepoRows(mixedInputs, 'p1');
  ok('C-17 未绑定/取数失败的仓库保留可见行并带一句话原因（不许静默丢行）',
    blocked.length === 2 && blocked.every((r) => r.unavailableReason.length > 3), blocked.map((r) => [r.repoLabel, r.unavailableReason]));
  ok('C-18 失败行的身份也带相对路径（p4/deploy 与 p4/根 不能顶掉彼此）',
    blocked.some((r) => r.repoKey === repoKeyOf('p4', 'deploy')), blocked.map((r) => r.repoKey));
  ok('C-19 失败仓库仍出现在分支组之外但仍在视图里（组里不含不可用行时由 blocked 兜住）',
    buildRepoBranchGroups(mixedInputs, 'p1').every((g) => g.repoCount > 0));

  group('C 组 · 普查目标折算（/git/repos → 扫描清单）');
  const projects = [
    { id: 'p1', name: '多仓库项目', workspacePath: WS },
    { id: 'p2', name: '单仓库项目', workspacePath: 'D:/code/single' },
    { id: 'p3', name: '未绑定项目', workspacePath: '' },
    { id: 'p4', name: '取数失败项目', workspacePath: 'D:/code/broken' },
  ];
  const reposOk: PromiseSettledResult<RepoListResult> = {
    status: 'fulfilled',
    value: { ok: true, projectId: 'p1', projectName: '多仓库项目', workspacePath: WS, truncated: false, scannedDirs: 12,
      repos: [{ subPath: '' }, { subPath: 'served' }, { subPath: 'adapter' }, { subPath: 'banks' }] },
  };
  const reposSingle: PromiseSettledResult<RepoListResult> = {
    status: 'fulfilled',
    value: { ok: true, projectId: 'p2', projectName: '单仓库项目', workspacePath: 'D:/code/single', truncated: false, scannedDirs: 3,
      repos: [{ subPath: '' }] },
  };
  const reposRejected: PromiseSettledResult<RepoListResult> = { status: 'rejected', reason: '网络异常' };
  const reposEmptyOk: PromiseSettledResult<RepoListResult> = {
    status: 'fulfilled',
    value: { ok: false, projectId: 'p4', projectName: '取数失败项目', workspacePath: 'D:/code/broken', truncated: false, scannedDirs: 0,
      repos: [], error: { kind: 'not-a-repo', message: '没有 Git 仓库' } },
  };
  const targets = censusTargetsFromRepoLists(projects, [reposOk, reposSingle, reposRejected, reposEmptyOk]);
  ok('C-20 一个项目展开成它目录内的多个扫描目标（根仓库不重复补一条）',
    targets.filter((t) => t.projectId === 'p1').map((t) => t.repoSub).join('|') === '|served|adapter|banks',
    targets.filter((t) => t.projectId === 'p1').map((t) => t.repoSub));
  ok('C-21 单仓库项目仍然是 1 个目标（改造前后逐字一致，不引入多余请求）',
    targets.filter((t) => t.projectId === 'p2').length === 1 && targets.find((t) => t.projectId === 'p2')?.repoSub === '');
  ok('C-22 `/git/repos` 失败的项目回落到「根仓库一条」，把真正的错误文案留给 /git/log（不发明第二套错误）',
    targets.filter((t) => t.projectId === 'p4').length === 1 && targets.find((t) => t.projectId === 'p4')?.repoSub === '',
    targets.filter((t) => t.projectId === 'p4'));
  ok('C-23 未绑定工作空间的项目仍占一行（不许静默丢，验收点 5）',
    targets.some((t) => t.projectId === 'p3' && t.workspacePath === ''), targets.filter((t) => t.projectId === 'p3'));
  ok('C-24 目标总数 = 各项目仓库数之和（顺序与项目一致，不会把 A 的提交挂到 B）',
    targets.length === 7 && targets[0].projectId === 'p1' && targets[6].projectId === 'p4', targets.map((t) => [t.projectId, t.repoSub]));

  // 取数次数 = 展开组数 × 组内仓库数：组数不设上限时，8 仓库 × 30 分支组会一次铺出 200 多个 git 取数
  const sharedBranchRefs = Array.from({ length: 6 }, (_, i) => ({ name: `shared/branch-${i}`, type: 'branch' as const }));
  const manyInputs: RepoBranchInput[] = [
    { projectId: 'p1', projectName: 'BEMP 5.0', workspacePath: WS, repoSub: '', refs: sharedBranchRefs, available: true },
    ...['served', 'adapter'].map((sub): RepoBranchInput => ({
      projectId: 'p1', projectName: 'BEMP 5.0', workspacePath: WS, repoSub: sub, refs: sharedBranchRefs, available: true,
    })),
  ];
  const manyGroups = buildRepoBranchGroups(manyInputs, 'p1');
  ok('C-25 默认展开的分支组有上限（组数 × 仓库数就是取数次数，铺满会把弹窗打死）',
    sharedBranchGroups(manyGroups).length > DEFAULT_OPEN_BRANCH_GROUPS
    && defaultExpandedBranches(manyGroups, 'p1').length === DEFAULT_OPEN_BRANCH_GROUPS,
    { shared: sharedBranchGroups(manyGroups).length, opened: defaultExpandedBranches(manyGroups, 'p1').length });
  ok('C-26 截断保留的是同名仓库最多的那几组（排序即优先级，不许把主分支截掉留下冷分支）',
    defaultExpandedBranches(manyGroups, 'p1').every((k) => sharedBranchGroups(manyGroups)
      .slice(0, DEFAULT_OPEN_BRANCH_GROUPS).some((g) => g.branchKey === k)),
    sharedBranchGroups(manyGroups).map((g) => [g.branchName, g.repoCount]));
} finally {
  fixture.cleanup();
}

/* ============================ D 组：真实夹具 LIVE ============================ */
const BASE = (process.env.MTASK_LIVE_BASE ?? '').trim();
const REPO = (process.env.MTASK_LIVE_REPO ?? 'D:/code/QJ/BEMP5.0DEV').trim();
if (!BASE) {
  group('D 组 · 真实工作空间（BEMP5.0DEV）');
  for (const n of ['D-01 /git/repos 列出根仓库与全部子仓库', 'D-02 子仓库取到 feature/hnnxbank/dev',
    'D-03 根仓库取到 master', 'D-04 根与子的引用清单互不包含', 'D-05 repoSub 越界被服务端拒',
    'D-06 repoSub 指向非仓库目录给一句话', 'D-07 缺 projectId 是 400']) {
    skip(n, '未提供 MTASK_LIVE_BASE（隔离后端未启动）');
  }
} else {
  group('D 组 · 真实工作空间（BEMP5.0DEV）');
  const json = async (url: string, init?: RequestInit) => {
    const r = await fetch(`${BASE}${url}`, init);
    return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
  };
  const projectName = `T04525 同一工作空间多仓库-${new Date().toISOString().slice(0, 10)}`;
  const listRes = await json('/api/projects');
  const list = Array.isArray(listRes.body) ? listRes.body as { id: string; name: string }[] : [];
  let project = list.find((p) => p.name.startsWith('T04525'));
  if (!project) {
    const created = await json('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projectName, description: 'T04525 验收门夹具：同一工作空间目录内的多仓库' }),
    });
    project = created.body as { id: string };
  }
  await json(`/api/projects/${(project as { id: string }).id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspacePath: REPO }),
  });
  const pid = (project as { id: string }).id;
  ok('D-00 夹具项目已绑定真实工作空间（门自己准备数据，不依赖手工状态）', !!pid, pid);

  const repos = (await json(`/api/git/repos?projectId=${encodeURIComponent(pid)}`)).body as {
    ok: boolean; repos?: { subPath: string; isRoot: boolean; displayName: string }[]; truncated?: boolean; error?: { message: string };
  };
  const repoSubs = (repos.repos ?? []).map((r) => r.subPath);
  ok('D-01 `/git/repos` 在同一工作空间目录里发现多个仓库（≥2，且含需求点名的 served/adapter/banks/deploy）',
    repos.ok === true && repoSubs.length >= 2
    && ['served', 'adapter', 'banks', 'deploy'].every((s) => repoSubs.includes(s)), { n: repoSubs.length, repoSubs });
  ok('D-01b 根仓库在清单里且只出现一次（重复会让根仓库在视图里显示两行）',
    repoSubs.filter((s) => s === '').length === 1 && repos.repos?.[0]?.isRoot === true, repoSubs);

  const refsOf = async (repoSub: string) => {
    const qs = new URLSearchParams({ projectId: pid, all: '1', skip: '0', limit: '1' });
    if (repoSub) qs.set('repoSub', repoSub);
    const r = (await json(`/api/git/log?${qs.toString()}`)).body as {
      ok: boolean; refs?: { name: string; type: string }[]; repoSub?: string; error?: { kind: string; message: string };
    };
    return r;
  };
  const rootRefs = await refsOf('');
  const servedRefs = await refsOf('served');
  const rootNames = new Set((rootRefs.refs ?? []).map((r) => r.name));
  const servedNames = new Set((servedRefs.refs ?? []).map((r) => r.name));
  ok('D-02 子仓库 served 取数成功且回显 repoSub（取数真的换了 cwd）',
    servedRefs.ok === true && servedRefs.repoSub === 'served', { ok: servedRefs.ok, repoSub: servedRefs.repoSub, error: servedRefs.error });
  ok('D-03 需求点名的两条分支各归其位：根仓库有 master、子仓库有 feature/hnnxbank/dev',
    rootNames.has('master') && (servedNames.has('feature/hnnxbank/dev') || servedNames.has('dev')),
    { root: [...rootNames].slice(0, 8), served: [...servedNames].slice(0, 8) });
  const shared = [...servedNames].filter((n) => rootNames.has(n));
  ok('D-04 两个仓库的引用清单不是同一份（证明「多个仓库」不是把根仓库的清单复制了几遍）',
    servedNames.size > 0 && shared.length < servedNames.size, { shared, served: servedNames.size });

  const escape = (await json(`/api/git/log?projectId=${pid}&repoSub=${encodeURIComponent('../../../../../../Windows')}`)).body as {
    ok: boolean; error?: { kind: string; message: string };
  };
  ok('D-05 repoSub 越界被拒且错误口径是 bad-repo（不许回落根仓库）',
    escape.ok === false && escape.error?.kind === 'bad-repo', escape.error);
  const notRepo = (await json(`/api/git/log?projectId=${pid}&repoSub=docs`)).body as {
    ok: boolean; error?: { kind: string; message: string };
  };
  ok('D-06 repoSub 指向非仓库目录给一句话并点名该目录（不许静默返回根仓库的历史）',
    notRepo.ok === false && /docs/.test(notRepo.error?.message ?? ''), { ok: notRepo.ok, error: notRepo.error });
  const badReq = await fetch(`${BASE}/api/git/repos`, { headers: {} });
  ok('D-07 `/git/repos` 缺 projectId 是 400（参数错误与「取不到」不是一回事）', badReq.status === 400, badReq.status);
}

/* ============================ E 组：服务端口径（本进程 + 临时库） ============================ */
/**
 * 为什么 D 组之外还要 E 组：D 组走 HTTP，打的是**已经在跑的隔离后端**——那个进程早就把源码读进内存，
 * 改源码（变异探针）咬不到它。M6 实测就是这样：把服务端的 `isRepositoryRoot` 核卡整段关掉，
 * D-05/D-06 依然全绿，因为跑的是旧进程。E 组把 `queryGitLog` 在**本进程**里用临时库跑一遍，
 * 「服务端到底核不核 repoSub」这条口径由源码本身负责，不依赖谁有没有重启。
 *
 * 隔离纪律：`MTask_DATA_DIR` 指到本次新建的临时目录（绝不指用户库），跑完关连接、删目录。
 */
group('E 组 · queryGitLog 的 repoSub 收口（本进程 + 临时库，不依赖隔离后端）');
if (!existsSync(REPO)) {
  for (const n of ['E-01 repoSub 指向根仓库工作树内的普通目录 → 拒并点名该目录',
    'E-02 repoSub 越界 → 在起 git 之前就拒（bad-repo + 点名越出工作空间）',
    'E-03 空 repoSub = 根仓库且真取到提交（E 组不是「全都报错所以全绿」）',
    'E-04 子仓库 served 取到的是它自己的历史（成功且回显 repoSub）']) {
    skip(n, `真实夹具目录不存在：${REPO}`);
  }
} else {
  const scratch = mkdtempSync(P(os.tmpdir(), 't04525-e'));
  process.env.MTask_DATA_DIR = P(scratch, 'data');
  try {
    const { initSchema } = await import('../../server/src/db/schema.ts');
    const { getDb, closeDb } = await import('../../server/src/db/connection.ts');
    initSchema();
    const now = new Date().toISOString();
    getDb().prepare('INSERT INTO projects (id, name, created_at, updated_at, workspace_path) VALUES (?, ?, ?, ?, ?)')
      .run('e-probe', 'E 组临时项目', now, now, REPO);
    const { queryGitLog } = await import('../../server/src/services/lectureGitLog.ts');

    const notRepo = await queryGitLog({ projectId: 'e-probe', repoSub: 'docs' });
    ok('E-01 repoSub 指向根仓库工作树内的普通目录 → 拒并点名该目录（不许读成根仓库的历史）',
      notRepo.ok === false && notRepo.error?.kind === 'not-a-repo' && /docs/.test(notRepo.error?.message ?? ''),
      { ok: notRepo.ok, commits: notRepo.commits.length, error: notRepo.error });

    const escape = await queryGitLog({ projectId: 'e-probe', repoSub: '../../evil' });
    ok('E-02 repoSub 越界 → 在起 git 之前就拒（bad-repo + 点名越出工作空间）',
      escape.ok === false && escape.error?.kind === 'bad-repo' && /越出工作空间/.test(escape.error?.message ?? ''),
      { ok: escape.ok, error: escape.error });

    const rootLog = await queryGitLog({ projectId: 'e-probe', all: true, limit: 5 });
    ok('E-03 空 repoSub = 根仓库且真取到提交（证明 E 组不是「全都报错所以全绿」）',
      rootLog.ok === true && rootLog.commits.length > 0 && rootLog.repoSub === '',
      { ok: rootLog.ok, n: rootLog.commits.length, error: rootLog.error });

    // 子仓库名从真实目录现取（需求点名的 served 在，就用它；哪天目录变了门不该跟着变红）
    const discovered = await discoverNestedRepos(REPO);
    const sub = (discovered.repos.find((r) => !r.isRoot && r.subPath === 'served')
      ?? discovered.repos.find((r) => !r.isRoot))?.subPath ?? '';
    const subLog = await queryGitLog({ projectId: 'e-probe', repoSub: sub, all: true, limit: 5 });
    ok('E-04 子仓库取到的是它自己的历史（成功且回显 repoSub，不是把根仓库再读一遍）',
      sub !== '' && subLog.ok === true && subLog.repoSub === sub
      && subLog.workspacePath.replace(/\\/g, '/') === REPO.replace(/\\/g, '/'),
      { sub, ok: subLog.ok, repoSub: subLog.repoSub, n: subLog.commits.length, error: subLog.error });

    closeDb();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(lines.join('\n'));
console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skipped}`);
if (fail > 0) process.exitCode = 1;
