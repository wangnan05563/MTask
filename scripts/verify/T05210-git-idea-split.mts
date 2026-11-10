/**
 * T05210 验收门（node 侧）：IDEA 风格双栏「右栏变更文件树」的纯逻辑 + 真实 git 取数。
 *
 * 为什么分两层：
 *  - **纯逻辑层**（`utils/gitFileTree.ts`）承载四条最容易撒谎的边界：层级合并、多提交聚合的
 *    last-wins、Base 对比的三组分栏、虚拟滚动切片（切错就出现「滚到底空白」）。这些不需要浏览器，
 *    在 node 里跑得快、还能配负对照；
 *  - **服务层**（`services/gitCommitFiles.ts`）必须用真仓库真 git 验：文件状态字母来自 `--raw`+`--numstat`
 *    的真实输出，任何「我以为是 A 其实是 M」的偏差只有真跑一次才暴露。这里自造临时仓库，
 *    `MTask_DATA_DIR` 指到临时目录，产品工作树零写入。
 *
 * 断言全打在**行为/产物**上（函数返回值、真实 git 输出），不打在源码文本上（见 `docs/验收门判据规约.md`）。
 *
 * 用法：node ./node_modules/tsx/dist/cli.mjs scripts/verify/T05210-git-idea-split.mts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from '../lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP = mkdtempSync('D:/tmp/t05210-');
const DATA_DIR = join(TMP, 'data');
process.env.MTask_DATA_DIR = DATA_DIR;

const {
  buildFileTree, flattenFileTree, allDirPaths, leavesOfCommit, aggregateCommitFiles,
  groupCommitFilesByRepo, compareFileSets, fileStatsOf, statusMeta, windowSlice, ellipsisPath,
  FILE_TREE_ROW_H, FILE_TREE_VIRTUAL_THRESHOLD,
} = await import('../../web/src/utils/gitFileTree.ts');
const { repoColorMap, repoColorVar, REPO_COLOR_COUNT, GIT_TREE_ROW_H } = await import('../../web/src/ui/gitTreeTheme.ts');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
  console.log(lines[lines.length - 1]);
};

/* ================================================================== *
 * A 组：文件树构建（层级 / 排序 / 汇总）
 * ================================================================== */
const entry = (path: string, status: 'A' | 'M' | 'D' | 'R' | 'T', add: number | null, del: number | null, oldPath?: string) =>
  ({ path, status, additions: add, deletions: del, binary: add === null, ...(oldPath ? { oldPath } : {}) });

const leavesA = leavesOfCommit('c1', [
  entry('src/main/a.ts', 'M', 10, 2),
  entry('src/main/deep/b.ts', 'A', 5, 0),
  entry('README.md', 'M', 1, 1),
  entry('docs/guide.md', 'D', 0, 20),
]);
const treeA = buildFileTree(leavesA);

ok('A-01 顶层节点按「目录优先、再字典序」排（docs/src 在 README 之前）',
  treeA.map((n) => n.name).join(',') === 'docs,src,README.md', treeA.map((n) => n.name));
ok('A-02 目录层级按路径段逐层建立（src/main/deep 三层）',
  treeA[1].kind === 'dir' && treeA[1].children[0].kind === 'dir'
  && (treeA[1].children[0] as any).children[0].kind === 'dir'
  && (treeA[1].children[0] as any).children[0].children[0].name === 'b.ts');
ok('A-03 目录的文件数含深层（src = 2，不是 0）',
  treeA[1].kind === 'dir' && (treeA[1] as any).fileCount === 2, (treeA[1] as any).fileCount);
ok('A-04 目录增删行数自底向上汇总（src = +15 −2）',
  treeA[1].kind === 'dir' && (treeA[1] as any).additions === 15 && (treeA[1] as any).deletions === 2,
  { add: (treeA[1] as any).additions, del: (treeA[1] as any).deletions });

const allDirs = allDirPaths(treeA);
const fullRows = flattenFileTree(treeA, new Set(allDirs));
ok('A-05 全展开时行数 = 文件 4 + 目录 4（docs/src/main/deep）', fullRows.length === 8, fullRows.length);
ok('A-06 折叠 src 后其 3 个后代整段消失（8 → 4 行：docs/guide.md + src + README.md + docs）',
  flattenFileTree(treeA, new Set(allDirs.filter((p) => p !== 'src'))).length === 4,
  flattenFileTree(treeA, new Set(allDirs.filter((p) => p !== 'src'))).map((r) => r.node.path));
ok('A-07 折叠所有目录只剩 3 个顶层节点', flattenFileTree(treeA, new Set()).length === 3);
ok('A-08 空路径段不造空名目录（a//b.txt 仍是 a/b.txt）',
  buildFileTree(leavesOfCommit('x', [entry('a//b.txt', 'A', 1, 0)]))[0].kind === 'dir'
  && (buildFileTree(leavesOfCommit('x', [entry('a//b.txt', 'A', 1, 0)]))[0] as any).children[0].name === 'b.txt');
ok('A-09 同路径重复条目只出一行',
  flattenFileTree(buildFileTree(leavesOfCommit('x', [entry('a.txt', 'M', 1, 0), entry('a.txt', 'M', 2, 0)])), new Set()).length === 1);

/* ================================================================== *
 * B 组：多提交聚合（去重 + last-wins + 不虚假求和）
 * ================================================================== */
const agg = aggregateCommitFiles([
  { sha: 'new', date: '2026-11-10', files: [entry('a.txt', 'D', 0, 9), entry('b.txt', 'M', 3, 1)] },
  { sha: 'old', date: '2026-11-01', files: [entry('a.txt', 'A', 40, 0), entry('c.txt', 'A', 2, 0)] },
]);
const aggA = agg.find((l) => l.path === 'a.txt')!;
ok('B-01 同一路径只出一行（3 个文件条目 → 3 行，不是 4 行）', agg.length === 3, agg.map((l) => l.path));
ok('B-02 last-wins：a.txt 取**最新**那条的状态 D（先新增后删除）', aggA.status === 'D', aggA.status);
ok('B-03 shas 累积两个提交且保持入参顺序（new→old）', aggA.shas.join(',') === 'new,old', aggA.shas);
ok('B-04 statuses 记下两种历史状态', aggA.statuses.join(',') === 'D,A', aggA.statuses);
ok('B-05 聚合不求和增删行数（a.txt 保留最新那条的 0/−9，不是 +40/−9）',
  aggA.additions === 0 && aggA.deletions === 9, { add: aggA.additions, del: aggA.deletions });
ok('B-06 只被一个提交改过的文件 shas 长度为 1', agg.find((l) => l.path === 'c.txt')!.shas.length === 1);

const groups = groupCommitFilesByRepo([
  { sha: 's1', date: 'd1', repoKey: 'k-root', repoLabel: '根目录仓库', files: [entry('x.txt', 'A', 1, 0)] },
  { sha: 's2', date: 'd2', repoKey: 'k-banks', repoLabel: 'banks', files: [entry('y.txt', 'M', 2, 2)] },
  { sha: 's3', date: 'd3', repoKey: 'k-root', repoLabel: '根目录仓库', files: [entry('x.txt', 'M', 3, 0)] },
]);
ok('B-07 按仓库分组并保持首次出现顺序（根仓库在前）', groups.map((g) => g.repoKey).join(',') === 'k-root,k-banks', groups.map((g) => g.repoKey));
ok('B-08 根仓库内两条提交聚合后仍是 1 个文件', groups[0].leaves.length === 1 && groups[0].leaves[0].shas.length === 2);
ok('B-09 跨仓库不合并同名文件（banks 独立成组）', groups[1].leaves[0].path === 'y.txt');

/* ================================================================== *
 * C 组：Base 对比（集合比对，不是内容 diff）
 * ================================================================== */
const cmp = compareFileSets(
  [entry('same.txt', 'M', 1, 1), entry('only-base.txt', 'M', 1, 1), entry('diff.txt', 'A', 5, 0)],
  [entry('same.txt', 'M', 2, 2), entry('only-other.txt', 'A', 3, 0), entry('diff.txt', 'M', 1, 1)],
);
const kindOf = (p: string) => cmp.find((r) => r.path === p)?.kind;
ok('C-01 只在基准里有 → only-base', kindOf('only-base.txt') === 'only-base');
ok('C-02 只在其余记录里有 → only-others', kindOf('only-other.txt') === 'only-others');
ok('C-03 两边状态不同 → both-different', kindOf('diff.txt') === 'both-different');
ok('C-04 两边状态相同 → both-same', kindOf('same.txt') === 'both-same');
ok('C-05 基准侧没有的文件 baseStatus 为 null', cmp.find((r) => r.path === 'only-other.txt')!.baseStatus === null);
ok('C-06 结果按路径字典序稳定', cmp.map((r) => r.path).join(',') === 'diff.txt,only-base.txt,only-other.txt,same.txt', cmp.map((r) => r.path));

/* ================================================================== *
 * D 组：虚拟滚动切片（1000+ 文件的正确性）
 * ================================================================== */
ok('D-01 空列表返回空窗口', JSON.stringify(windowSlice(0, 0, 400)) === JSON.stringify({ start: 0, end: 0, padTop: 0, padBottom: 0 }));
ok('D-02 视口未测量（0）时退化为全量，避免「永远空白」', windowSlice(50, 0, 0).end === 50);
const top = windowSlice(1000, 0, 220);
ok('D-03 顶部：start=0、padTop=0、end 覆盖一屏+overscan', top.start === 0 && top.padTop === 0 && top.end > 0 && top.end < 1000);
const mid = windowSlice(1000, 8800, 220); // 第 400 行附近
ok('D-04 中部：padTop = start×行高，padBottom = 余下×行高', mid.padTop === mid.start * FILE_TREE_ROW_H && mid.padBottom === (1000 - mid.end) * FILE_TREE_ROW_H);
ok('D-05 三段高度之和恒等于总高（滚动条不跳）',
  mid.padTop + (mid.end - mid.start) * FILE_TREE_ROW_H + mid.padBottom === 1000 * FILE_TREE_ROW_H);
const bottom = windowSlice(1000, 1000 * FILE_TREE_ROW_H, 220);
ok('D-06 滚到底：end 钳到 total、padBottom=0', bottom.end === 1000 && bottom.padBottom === 0);
ok('D-07 阈值与行高与样式单源一致（400 / 22px）',
  FILE_TREE_VIRTUAL_THRESHOLD === 400 && FILE_TREE_ROW_H === 22 && GIT_TREE_ROW_H === 22);
ok('D-08 超长路径中间省略但保留文件名', ellipsisPath('a/very/deep/path/with/many/segments/final-name.ts', 30).endsWith('final-name.ts'),
  ellipsisPath('a/very/deep/path/with/many/segments/final-name.ts', 30));

/* ================================================================== *
 * E 组：状态与仓库色（左→右同源）
 * ================================================================== */
ok('E-01 五个状态字母映射齐全且中文可观', ['A', 'M', 'D', 'R', 'T'].every((s) => typeof statusMeta(s as any).label === 'string' && statusMeta(s as any).label.length > 0));
ok('E-02 状态色走 CSS 变量（随主题切换，不硬编码 hex）', ['A', 'M', 'D', 'R', 'T'].every((s) => statusMeta(s as any).color.startsWith('var(--gt-status-')));
const colorMap = repoColorMap(['p\u0000banks', 'p\u0000', 'p\u0000frontend', 'p\u0000deploy']);
ok('E-03 视图内每个仓库分到不同颜色', new Set(Object.values(colorMap.index)).size === 4, colorMap.index);
const reversed = repoColorMap(['p\u0000deploy', 'p\u0000frontend', 'p\u0000', 'p\u0000banks']);
ok('E-04 颜色映射与入参顺序无关（左栏与右栏各算一次也同色）',
  JSON.stringify(reversed.index) === JSON.stringify(colorMap.index));
ok('E-05 仓库数超过色板容量时标记复用（不静默撞色）',
  repoColorMap(Array.from({ length: REPO_COLOR_COUNT + 1 }, (_, i) => `k${i}`)).reused === true);
ok('E-06 未知仓库回落到中性色而不是透明', repoColorVar(undefined) === 'var(--gt-repo-none)');

/* ================================================================== *
 * F 组：真实 git 仓库 + 真实 service（状态字母/毒丸 SHA/降级口径）
 * ================================================================== */
const { initSchema } = await import('../../server/src/db/schema.ts');
const { getDb } = await import('../../server/src/db/connection.ts');
const { queryCommitFiles, clearCommitFilesCache, MAX_COMMIT_FILES_BATCH } = await import('../../server/src/services/gitCommitFiles.ts');
initSchema();
const db = getDb();
const now = new Date().toISOString();

const REPO = join(TMP, 'repo');
mkdirSync(REPO, { recursive: true });
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', env: gitEnv });
git(['init', '-q', '-b', 'main']);
mkdirSync(join(REPO, 'src', 'main'), { recursive: true });
writeFileSync(join(REPO, 'src', 'main', 'a.ts'), 'line1\nline2\n');
writeFileSync(join(REPO, 'README.md'), 'hello\n');
git(['add', '.']);
git(['commit', '-q', '-m', '初始提交：新增 a.ts 与 README']);
const sha1 = git(['rev-parse', 'HEAD']).trim();

writeFileSync(join(REPO, 'src', 'main', 'a.ts'), 'line1\nline2 changed\nline3\n');
writeFileSync(join(REPO, 'src', 'main', 'b.ts'), 'export const b = 1;\n');
rmSync(join(REPO, 'README.md'));
git(['add', '-A']);
git(['commit', '-q', '-m', 'feat: 改 a.ts、加 b.ts、删 README']);
const sha2 = git(['rev-parse', 'HEAD']).trim();

git(['mv', 'src/main/b.ts', 'src/main/c.ts']);
git(['commit', '-q', '-m', 'refactor: b.ts 重命名为 c.ts']);
const sha3 = git(['rev-parse', 'HEAD']).trim();

const newProject = (name: string, workspace: string): string => {
  const id = `p-${Math.random().toString(36).slice(2, 9)}`;
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, name, '', now, now);
  db.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(workspace, id);
  return id;
};
const pid = newProject('T05210 门项目', REPO);

const r2 = await queryCommitFiles({ projectId: pid, repoSub: '', shas: [sha2] });
const files2 = r2.files[sha2] ?? [];
const byPath = new Map(files2.map((f) => [f.path, f]));
ok('F-01 ok=true 且回传该提交的变更清单', r2.ok === true && files2.length === 3, { ok: r2.ok, n: files2.length, err: r2.error });
ok('F-02 修改 → M（并把 a.ts 归到 M 而不是 A）', byPath.get('src/main/a.ts')?.status === 'M', byPath.get('src/main/a.ts'));
ok('F-03 新增 → A', byPath.get('src/main/b.ts')?.status === 'A', byPath.get('src/main/b.ts'));
ok('F-04 删除 → D', byPath.get('README.md')?.status === 'D', byPath.get('README.md'));
ok('F-05 增删行数与 git 输出一致（a.ts +2 −1）',
  byPath.get('src/main/a.ts')?.additions === 2 && byPath.get('src/main/a.ts')?.deletions === 1,
  { add: byPath.get('src/main/a.ts')?.additions, del: byPath.get('src/main/a.ts')?.deletions });

const r3 = await queryCommitFiles({ projectId: pid, repoSub: '', shas: [sha3] });
const ren = (r3.files[sha3] ?? []).find((f) => f.path === 'src/main/c.ts');
ok('F-06 重命名 → R 且带 oldPath（右栏据此显示来源名）', ren?.status === 'R' && ren?.oldPath === 'src/main/b.ts', ren);

ok('F-07 首提交（无父）以空树为基线：全部 A', (await queryCommitFiles({ projectId: pid, shas: [sha1] })).files[sha1]?.every((f) => f.status === 'A') === true);

// 毒丸：一个仓库里不存在的 SHA 混在有效 SHA 中间，不得毒掉整批
const ghost = 'f'.repeat(40);
const poisoned = await queryCommitFiles({ projectId: pid, shas: [sha2, ghost] });
ok('F-08 失效 SHA 只进 missing，同批的有效提交仍取到清单',
  poisoned.ok === true && (poisoned.files[sha2]?.length ?? 0) === 3 && poisoned.missing.includes(ghost),
  { ok: poisoned.ok, n: poisoned.files[sha2]?.length, missing: poisoned.missing });
ok('F-09 missing 不冒充「没改文件」：ghost 的键不存在于 files',
  Object.prototype.hasOwnProperty.call(poisoned.files, ghost) === false);

// 缓存：同一提交第二次取数结果逐字节相同（不可变数据，且热路径不再 spawn）
clearCommitFilesCache();
const first = await queryCommitFiles({ projectId: pid, shas: [sha2] });
const second = await queryCommitFiles({ projectId: pid, shas: [sha2] });
ok('F-10 重复取数结果一致（缓存不影响内容）', JSON.stringify(first.files) === JSON.stringify(second.files));
ok('F-11 单次上限与前端分片口径一致（40）', MAX_COMMIT_FILES_BATCH === 40 && r2.limit === 40, { limit: r2.limit });

const noWs = newProject('T05210 无工作空间', '');
const rNoWs = await queryCommitFiles({ projectId: noWs, shas: [sha2] });
ok('F-12 未配工作空间回 ok=false + no-workspace（不谎报空清单）',
  rNoWs.ok === false && rNoWs.error?.kind === 'no-workspace', rNoWs.error);

const rBadSub = await queryCommitFiles({ projectId: pid, repoSub: 'not/exists', shas: [sha2] });
ok('F-13 越界 repoSub 被拒（bad-repo/not-a-repo，不回落根仓库）',
  rBadSub.ok === false && ['bad-repo', 'not-a-repo'].includes(rBadSub.error?.kind ?? ''), rBadSub.error);

const rUnknownProject = await queryCommitFiles({ projectId: 'no-such-project', shas: [sha2] });
ok('F-14 未知项目回 denied（不静默返回空）', rUnknownProject.ok === false && rUnknownProject.error?.kind === 'denied');

/* ================================================================== *
 * G 组：汇总与清理
 * ================================================================== */
ok('G-01 目录统计口径与文件集合一致（含重命名）',
  fileStatsOf(leavesOfCommit(sha3, r3.files[sha3] ?? [])).byStatus.R === 1);

const summary = `PASS=${pass} FAIL=${fail}`;
writeGateResults(OUT_DIR, 't05210-git-idea-split-results.txt', summary, { dataDir: DATA_DIR });
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 门内临时目录清理失败不影响判据 */ }
console.log(summary);
if (fail > 0) process.exitCode = 1;
