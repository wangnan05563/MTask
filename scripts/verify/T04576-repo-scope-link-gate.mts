/**
 * T04576 验收门：Git 回写/增量提取按 **仓库维度** 解析 SHA。
 *
 * 要钉住的两件事（本单正文原话）：
 *   1. 「勾子仓库 SHA → 关联后 `gitLinkCount` 不为 0 且 `missing` 为空」——子仓库的提交不能拿工作空间根
 *      的 cwd 去解析（目录内根本不是同一份提交图，会被整批判 missing）；
 *   2. 「同一 SHA 在两个仓库里不互相顶掉」——`task_git_links` 的唯一键与最终内容映射都必须带 `repo_sub`。
 *
 * 锚定词（R-318）：`scripts/verify/T04576-repo-scope-link-gate.mts`（本门自指）/ `repoSub` /
 * `task_git_links` / `gitLinkCount` / `missing` / `finalPathMap` / `planExtract` / `ambiguous-repo`。
 *
 * 分组：
 *   A 组（最终内容映射）：同一相对路径在两个仓库各有一份 → 两个键、两个产物路径，互不覆盖；
 *   B 组（关联/视图）：真实夹具仓库（根仓库 + 子仓库）走 `linkCommits` → `buildTaskGitView`，
 *      `gitLinkCount` 不为 0、`missing` 为空；同一 SHA 在两仓各一行；解绑不带仓库时必须 409；
 *   C 组（提取计划）：`planExtract` 逐仓库分组、缺失按仓库记、手动提交的来源仓库可提示/可发现/歧义即拒；
 *   D 组（执行）：`runExtract` 逐仓库 cat-file，产物 zip 里子仓库文件带仓库前缀。
 *
 * 用法（R-327）：在仓库根目录执行
 *   `D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/verify/T04576-repo-scope-link-gate.mts`
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const lines: string[] = [];
const group = (t: string) => lines.push(`\n—— ${t} ——`);
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const P = (...seg: string[]) => path.join(...seg);

/* 必须在任何 db 模块真正打开连接前改掉数据目录（dataDir() 每次调用都读 env） */
const dataRoot = mkdtempSync(P(os.tmpdir(), 't04576-data-'));
process.env.MTask_DATA_DIR = dataRoot;

const { initSchema } = await import('../../server/src/db/schema.ts');
const { getDb } = await import('../../server/src/db/connection.ts');
const TaskGit = await import('../../server/src/services/taskGitLinks.ts');
const Extract = await import('../../server/src/services/gitExtract.ts');
const { readAndDeleteReport } = await import('../../server/src/services/ReportService.ts');
const PizZip = (await import('pizzip')).default;

/* ------------------------------ 夹具：一个目录里两个仓库 ------------------------------ */
const FIXED_DATE = '2026-01-01T00:00:00+0000';
function runGit(cwd: string, args: string[], date = FIXED_DATE): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Gate', GIT_AUTHOR_EMAIL: 'gate@example.com', GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'Gate', GIT_COMMITTER_EMAIL: 'gate@example.com', GIT_COMMITTER_DATE: date,
    },
  }).trim();
}
function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, ['config', 'core.autocrlf', 'false']);
}
function commitFile(dir: string, rel: string, content: string, message: string, date = FIXED_DATE): string {
  const abs = P(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  runGit(dir, ['add', '-A']);
  runGit(dir, ['commit', '-q', '-m', message], date);
  return runGit(dir, ['rev-parse', 'HEAD']);
}

const fixtureRoot = mkdtempSync(P(os.tmpdir(), 't04576-ws-'));
const ws = P(fixtureRoot, 'ws');
const subDir = P(ws, 'sub');
let rootSha = '';
let subSha = '';
let sharedSha = '';
try {
  initRepo(ws);
  initRepo(subDir);
  // 根仓库不跟踪内嵌仓库目录（否则 add -A 会把 sub 当成 gitlink，报「does not have a commit checked out」）
  writeFileSync(P(ws, '.git', 'info', 'exclude'), '/sub/\n', 'utf8');
  // 两个仓库的初始提交做成逐字节一致（同树、同作者、同时间、同信息）→ 必然同 SHA
  sharedSha = commitFile(ws, 'shared.txt', 'shared\n', 'init shared');
  const subShared = commitFile(subDir, 'shared.txt', 'shared\n', 'init shared');
  rootSha = commitFile(ws, 'a.txt', 'root only\n', 'root second');
  subSha = commitFile(subDir, 'b.txt', 'sub only\n', 'sub second');
  if (sharedSha !== subShared) throw new Error(`夹具构造失败：共享提交 SHA 不一致 ${sharedSha} vs ${subShared}`);

  initSchema();
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, wip_limit, created_at, updated_at, workspace_path) VALUES (?,?,?,?,?,?,?,?)')
    .run('p-gate', 'Gate 项目', '', 0, 10, now, now, ws);
  db.prepare('INSERT INTO tasks (id, task_no, project_id, title, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('t-gate', 'T90076', 'p-gate', 'Gate 任务', 'normal', 'todo', now, now);
  const taskRef = { id: 't-gate' };

  /* ============================ A 组：最终内容映射按仓库分键 ============================ */
  group('A 组 · finalPathMap 仓库维度');
  const filesByCommit = [
    { sha: rootSha, shortSha: rootSha.slice(0, 7), repoSub: '', entries: [{ path: 'same.txt', status: 'A', additions: 1, deletions: 0, binary: false }] },
    { sha: subSha, shortSha: subSha.slice(0, 7), repoSub: 'sub', entries: [{ path: 'same.txt', status: 'A', additions: 1, deletions: 0, binary: false }] },
  ] as Parameters<typeof Extract.finalPathMap>[0];
  const finalPath = Extract.finalPathMap(filesByCommit);
  ok('A-01 同一相对路径在两个仓库 → 两个独立键（互不顶掉）', finalPath.size === 2, [...finalPath.keys()]);
  ok('A-02 根仓库产物路径不加前缀', finalPath.get(Extract.finalPathKey('', 'same.txt'))?.outPath === 'same.txt',
    finalPath.get(Extract.finalPathKey('', 'same.txt')));
  ok('A-03 子仓库产物路径带仓库前缀（如实标注来源仓库）', finalPath.get(Extract.finalPathKey('sub', 'same.txt'))?.outPath === 'sub/same.txt',
    finalPath.get(Extract.finalPathKey('sub', 'same.txt')));
  const renameFiles = [
    { sha: rootSha, shortSha: 'r', repoSub: '', entries: [{ path: 'old.csv', status: 'R', oldPath: 'old.csv', additions: 0, deletions: 0, binary: false }, { path: 'new.csv', status: 'R', oldPath: 'old.csv', additions: 0, deletions: 0, binary: false }] },
    { sha: subSha, shortSha: 's', repoSub: 'sub', entries: [{ path: 'old.csv', status: 'A', additions: 1, deletions: 0, binary: false }] },
  ] as Parameters<typeof Extract.finalPathMap>[0];
  const renamed = Extract.finalPathMap(renameFiles);
  ok('A-04 根仓库重命名撤旧名，但不误删子仓库同名文件', !renamed.has(Extract.finalPathKey('', 'old.csv'))
    && renamed.has(Extract.finalPathKey('sub', 'old.csv')), [...renamed.keys()]);
  const withDelete = [
    { sha: rootSha, shortSha: 'r', repoSub: '', entries: [{ path: 'gone.txt', status: 'A', additions: 1, deletions: 0, binary: false }] },
    { sha: subSha, shortSha: 's', repoSub: 'sub', entries: [{ path: 'gone.txt', status: 'D', additions: 0, deletions: 1, binary: false }] },
  ] as Parameters<typeof Extract.finalPathMap>[0];
  ok('A-05 子仓库删除只删自己的键，不连带根仓库同名文件',
    Extract.finalPathMap(withDelete).size === 1 && Extract.finalPathMap(withDelete).has(Extract.finalPathKey('', 'gone.txt')),
    [...Extract.finalPathMap(withDelete).keys()]);

  /* ============================ B 组：关联 / 视图 ============================ */
  group('B 组 · 关联与任务抽屉视图（真实仓库）');
  const idx = db.prepare('PRAGMA index_info(ux_task_git_links)').all() as { name: string }[];
  ok('B-01 唯一索引含 repo_sub（同任务同 SHA 可按仓库并存）',
    idx.map((c) => c.name).join(',') === 'task_id,sha,repo_sub', idx);

  const subLink = await TaskGit.linkCommits(taskRef, [subSha], 'manual', 'sub');
  ok('B-02 子仓库 SHA 关联成功（linked=1）', subLink.linked === 1 && subLink.errors.length === 0, subLink);
  const rowsAfterSub = TaskGit.listLinks('t-gate');
  ok('B-03 关联行落库时记下 repoSub', rowsAfterSub.length === 1 && rowsAfterSub[0].repoSub === 'sub', rowsAfterSub);

  const view = await TaskGit.buildTaskGitView(taskRef);
  ok('B-04 子仓库提交在抽屉视图里解析出来（gitLinkCount 不为 0）', view.commits.length === 1 && view.commits[0].sha === subSha, view.commits.map((c) => c.sha));
  ok('B-05 子仓库提交不判 missing', view.missing.length === 0, view.missing);
  ok('B-06 卡片带来源仓库标注', view.commits[0]?.repoSub === 'sub', view.commits[0]?.repoSub);

  const rootLink = await TaskGit.linkCommits(taskRef, [sharedSha], 'manual', '');
  const subSharedLink = await TaskGit.linkCommits(taskRef, [sharedSha], 'manual', 'sub');
  ok('B-07 同一 SHA 在两个仓库各写一行（不互相顶掉）',
    rootLink.linked === 1 && subSharedLink.linked === 1 && TaskGit.listLinks('t-gate').filter((l) => l.sha === sharedSha).length === 2,
    TaskGit.listLinks('t-gate'));
  const view2 = await TaskGit.buildTaskGitView(taskRef);
  const sharedCards = view2.commits.filter((c) => c.sha === sharedSha);
  ok('B-08 视图里同一 SHA 出两张卡（根仓库 + 子仓库各一张）', sharedCards.length === 2, sharedCards.map((c) => c.repoSub));
  ok('B-09 两张卡分别标注来源仓库', sharedCards.map((c) => c.repoSub ?? '').sort().join(',') === ',sub',
    sharedCards.map((c) => c.repoSub));
  ok('B-10 两张卡都不判 missing', view2.missing.length === 0, view2.missing);

  let ambiguousUnlink = '';
  try { TaskGit.unlinkCommit(taskRef, sharedSha); } catch (e) {
    ambiguousUnlink = e instanceof TaskGit.GitLinkError ? `${e.httpStatus}:${e.message}` : String(e);
  }
  ok('B-11 解绑不带 repoSub 且命中两行 → 409 点名要求指定仓库', ambiguousUnlink.startsWith('409:'), ambiguousUnlink);
  TaskGit.unlinkCommit(taskRef, sharedSha, 'sub');
  const afterUnlink = TaskGit.listLinks('t-gate').filter((l) => l.sha === sharedSha);
  ok('B-12 指定 repoSub 解绑只解子仓库那一行，根仓库行保留', afterUnlink.length === 1 && afterUnlink[0].repoSub === '', afterUnlink);

  const filesSub = await TaskGit.buildTaskGitFiles(taskRef, subSha, false);
  ok('B-13 懒加载文件清单按关联行自己的仓库取数', filesSub.files.some((f) => f.path === 'b.txt') && !filesSub.degraded, filesSub);
  // C/D 组要同时看到两个仓库：根仓库行（B-12 保留）之外再把子仓库行补回，并给根仓库再挂一条独有提交
  await TaskGit.linkCommits(taskRef, [sharedSha], 'manual', 'sub');
  await TaskGit.linkCommits(taskRef, [rootSha], 'manual', '');

  /* ============================ C 组：提取计划 ============================ */
  group('C 组 · planExtract 逐仓库分组');
  const plan = await Extract.planExtract(['t-gate']);
  ok('C-01 计划按仓库分组（根仓库在前）', plan.repos.map((r) => r.repoSub).join(',') === ',sub', plan.repos.map((r) => r.repoSub));
  ok('C-02 跨仓库缺失为空（子仓库 SHA 不再按根仓库判 missing）', plan.missingShas.length === 0, plan.missingShas);
  ok('C-03 每个提交都带来源仓库', plan.filesByCommit.every((f) => typeof f.repoSub === 'string'), plan.filesByCommit.map((f) => [f.sha.slice(0, 7), f.repoSub]));
  const planFinal = Extract.finalPathMap(plan.filesByCommit);
  ok('C-04 同一路径在两仓各留一份（最终内容映射键含仓库）',
    planFinal.has(Extract.finalPathKey('', 'shared.txt')) && planFinal.has(Extract.finalPathKey('sub', 'shared.txt')),
    [...planFinal.keys()]);
  ok('C-05 子仓库文件在产物里带仓库前缀', planFinal.get(Extract.finalPathKey('sub', 'b.txt'))?.outPath === 'sub/b.txt',
    planFinal.get(Extract.finalPathKey('sub', 'b.txt')));
  ok('C-06 uniquePaths 统计的是跨仓库去重后的文件数',
    plan.uniquePaths === new Set([...planFinal.values()].map((v) => v.outPath)).size, { unique: plan.uniquePaths, final: planFinal.size });

  const hinted = await Extract.planExtract([], [subSha], ['p-gate'], { [subSha]: 'sub' });
  ok('C-07 手动提交显式带 repoSub 时按子仓库取数', hinted.missingShas.length === 0 && hinted.uniquePaths > 0, {
    missing: hinted.missingShas, files: hinted.uniquePaths, repos: hinted.repos.map((r) => r.repoSub),
  });
  const discovered = await Extract.planExtract([], [subSha], ['p-gate']);
  ok('C-08 手动提交缺仓库提示时服务端逐仓库发现（子仓库能命中）',
    discovered.missingShas.length === 0 && discovered.repos.some((r) => r.repoSub === 'sub'),
    { missing: discovered.missingShas, repos: discovered.repos.map((r) => r.repoSub) });
  let ambiguousKind = '';
  try { await Extract.planExtract([], [sharedSha], ['p-gate']); } catch (e) {
    ambiguousKind = e instanceof Extract.ExtractError ? e.kind : String(e);
  }
  ok('C-09 同一 SHA 在两仓都存在且无提示 → 显式拒绝（不猜来源仓库）', ambiguousKind === 'ambiguous-repo', ambiguousKind);

  /* ============================ D 组：执行（逐仓库 cat-file + 打包） ============================ */
  group('D 组 · runExtract 逐仓库取数与产物路径');
  const result = await Extract.runExtract(plan, 'files', () => undefined);
  ok('D-01 提取完成且回执全部正常', result.receipts.length === 1 && result.receipts[0].ok === true, result.receipts);
  ok('D-02 根仓库与子仓库的文件都取到了内容', result.files === plan.uniquePaths && result.bytes > 0,
    { files: result.files, unique: plan.uniquePaths, bytes: result.bytes });
  const zipBuf = readAndDeleteReport(result.volumes[0].token);
  const zip = zipBuf ? new PizZip(zipBuf) : null;
  const names = zip ? Object.keys(zip.files).filter((n) => !zip.files[n].dir) : [];
  ok('D-03 产物里根仓库文件保持原路径', names.includes('shared.txt') && names.includes('a.txt'), names);
  ok('D-04 产物里子仓库文件带仓库前缀（来源可辨、不覆盖根仓库同名文件）',
    names.includes('sub/b.txt') && names.includes('sub/shared.txt'), names);
} finally {
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* 夹具清理失败不改变结论 */ }
  try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 同上 */ }
}

console.log(lines.join('\n'));
console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
