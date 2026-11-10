/*
 * T04912 门：多仓库「按时间顺序混合显示」——排序/去重/标签/确认口径纯函数 + 组件消费链源码锚。
 *
 * 背景：T04586 只让默认平铺视图「能选到」子仓库，一次仍只看一个仓库；本单要求把工作空间内
 * 所有仓库的提交按作者时间交织成一条时间线，并给每行标来源仓库。红线仍是「一次确认只回传
 * 一个仓库」（分组视图 resolveRepoConfirmation 同口径），不得把跨仓库 SHA 假合并。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04912-mixed-timeline-gate.mts
 * 无需后端、无需浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  mergeRepoTimelines,
  repoLabelOf,
  resolveMixedConfirmation,
  sortCommitsByDateDesc,
} from '../../web/src/utils/gitTimelineMerge';
import type { GitTreeCommit } from '../../web/src/utils/gitTreeSelect';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const c = (sha: string, date: string, subject = sha): GitTreeCommit => ({
  sha, short: sha.slice(0, 8), parents: [], refs: [], head: false,
  author: 'tester', date, subject,
});
const input = (repoSub: string, repoLabel: string, commits: GitTreeCommit[]) => ({ repoSub, repoLabel, commits });

console.log('—— A 组 · 跨仓库按作者时间严格降序 ——');
const banks = input('banks', 'banks', [
  c('b1'.repeat(20), '2026-01-01T09:00:00+08:00', 'banks-old'),
  c('b3'.repeat(20), '2026-01-03T09:00:00+08:00', 'banks-new'),
]);
const deploy = input('deploy', 'deploy', [
  c('d2'.repeat(20), '2026-01-02T09:00:00+08:00', 'deploy-old'),
  c('d4'.repeat(20), '2026-01-04T09:00:00+08:00', 'deploy-new'),
]);
const deep = input('grp/sub/deep', 'grp/sub/deep', [
  c('e5'.repeat(20), '2026-01-05T09:00:00+08:00', 'deep-new'),
]);
const merged = mergeRepoTimelines([banks, deploy, deep]);
ok('A-01 三个仓库 5 条提交按时间交织（不是按仓库分块堆叠）',
  merged.map((x) => x.subject).join(',') === 'deep-new,deploy-new,banks-new,deploy-old,banks-old',
  merged.map((x) => x.subject).join(','));
ok('A-02 每行都带正确的来源仓库坐标与展示名',
  merged.every((x) => x.repoLabel && typeof x.repoSub === 'string')
  && merged[0].repoSub === 'grp/sub/deep' && merged[2].repoSub === 'banks');
ok('A-03 原 GitTreeCommit 字段逐字保留（不丢 sha/refs/author/date）',
  merged[2].sha === 'b3'.repeat(20) && merged[2].date === '2026-01-03T09:00:00+08:00' && merged[2].author === 'tester');

const tzA = c('a'.repeat(40), '2026-01-02T10:00:00+08:00', 'plus8');   // 02:00Z
const tzB = c('b'.repeat(40), '2026-01-02T03:00:00+00:00', 'utc');     // 03:00Z（更晚）
ok('A-04 带时区的 %aI 作者时间按绝对时刻比较，不做字符串字典序',
  sortCommitsByDateDesc([tzA, tzB]).map((x) => x.subject).join(',') === 'utc,plus8');

const dirty = c('f'.repeat(40), 'not-a-date', 'dirty');
ok('A-05 时间不可解析的提交排末尾且不打断其它行排序',
  sortCommitsByDateDesc([tzA, dirty, tzB]).map((x) => x.subject).join(',') === 'utc,plus8,dirty');

const tie1 = mergeRepoTimelines([
  input('banks', 'banks', [c('11'.repeat(20), '2026-01-01T00:00:00Z')]),
  input('deploy', 'deploy', [c('22'.repeat(20), '2026-01-01T00:00:00Z')]),
]);
const tie2 = mergeRepoTimelines([
  input('deploy', 'deploy', [c('22'.repeat(20), '2026-01-01T00:00:00Z')]),
  input('banks', 'banks', [c('11'.repeat(20), '2026-01-01T00:00:00Z')]),
]);
ok('A-06 同一时刻按 repoSub → sha 稳定兜底（输入顺序不同结果一致，渲染确定性）',
  tie1.map((x) => x.sha).join(',') === tie2.map((x) => x.sha).join(',') && tie1[0].repoSub === 'banks');

console.log('—— B 组 · 合并去重与标签 ——');
ok('B-01 同仓库同 SHA 只保留一行（翻页/搜索窗口重叠不重复渲染）',
  mergeRepoTimelines([banks, banks]).length === banks.commits.length);
ok('B-02 不同仓库出现同一 SHA 时是两个实体，不误删',
  mergeRepoTimelines([input('banks', 'banks', [tzA]), input('deploy', 'deploy', [tzA])]).length === 2);
ok('B-03 空输入 / 空 commits / 无 sha 脏数据不抛异常且回空数组',
  mergeRepoTimelines([]).length === 0
  && mergeRepoTimelines([input('banks', 'banks', [])]).length === 0
  && mergeRepoTimelines([input('banks', 'banks', [{ ...tzA, sha: '' }])]).length === 0);
ok('B-04 根仓库标签带项目名，子仓库标签用相对路径（长名由 UI title 显示全称）',
  repoLabelOf('', 'ws', '我的项目').includes('根目录仓库')
  && repoLabelOf('', '', '我的项目') === '根目录仓库 · 我的项目'
  && repoLabelOf('grp/sub/deep', 'deep', '我的项目') === 'grp/sub/deep');
ok('B-05 缺标签时按仓库坐标兜底，绝不出现空来源',
  mergeRepoTimelines([input('banks', '', [tzA])])[0].repoLabel === 'banks'
  && mergeRepoTimelines([input('', '', [tzA])])[0].repoLabel === '根目录仓库');

console.log('—— C 组 · 一次确认只回传一个仓库（红线） ——');
const rows = mergeRepoTimelines([banks, deploy]);
ok('C-00 夹具可视集含 2 个仓库 4 条提交', rows.length === 4);
ok('C-01 未勾选 → none（不误报其它错误）',
  resolveMixedConfirmation(rows, []).ok === false && resolveMixedConfirmation(rows, []).code === 'none');
const one = resolveMixedConfirmation(rows, [rows[1].sha]);
ok('C-02 只勾一个仓库 → ok 且回传该仓库的 repoSub（不是当前选中的下拉值）',
  one.ok === true && one.ok && one.repoSub === rows[1].repoSub, JSON.stringify(one));
// 交织后顺序是 deploy-new / banks-new / deploy-old / banks-old；取前两行才真正跨仓库
const multi = resolveMixedConfirmation(rows, [rows[0].sha, rows[1].sha]);
ok('C-03 跨仓库勾选 → multi 明确拒绝，不允许假合并',
  multi.ok === false && multi.code === 'multi' && multi.repoSubs.length === 2, JSON.stringify(multi));
const missing = resolveMixedConfirmation(rows, [rows[0].sha, 'deadbeef']);
ok('C-04 所选 SHA 已不在当前可视集 → missing（防幽灵提交回传）',
  missing.ok === false && missing.code === 'missing' && missing.missing.length === 1, JSON.stringify(missing));
ok('C-05 单仓库可视集全部勾选仍可确认（兼容性：单仓库工作空间不被红线误伤）',
  resolveMixedConfirmation(mergeRepoTimelines([banks]), banks.commits.map((x) => x.sha)).ok === true);

console.log('—— D 组 · 组件消费链源码锚（数据计算 → 渲染消费整链） ——');
const modal = src('web/src/ui/GitTreePickerModal.tsx');
const util = src('web/src/utils/gitTimelineMerge.ts');
const treeSelect = src('web/src/utils/gitTreeSelect.ts');
ok('D-01 组件 import 纯函数层并把它接进 load 入口（不是算了不用）',
  /from '\.\.\/utils\/gitTimelineMerge'/.test(modal)
  && /mergeRepoTimelines\(inputs\)/.test(modal)
  && /if \(mixActive\) \{ await loadMixed\(\); return; \}/.test(modal));
ok('D-02 默认开启混合，且只在 ≥2 个仓库的平铺视图启用（单仓库逐字走旧逻辑）',
  /useState\(true\)/.test(modal)
  && /const mixActive = !repoView && mixRepos && repoChoices\.length > 1/.test(modal));
ok('D-03 逐仓库并发取数带 search / head / repoSub，且有限流与晚到响应守卫',
  /mapSettledWithLimit\(choices/.test(modal) && /REPO_SCAN_CONCURRENCY\)/.test(modal)
  && /buildLogQuery\(projectId, head, allBranches, search, 0, choice\.subPath\)/.test(modal)
  && /if \(seq !== loadSeq\.current\) return/.test(modal));
ok('D-04 取数 effect 依赖含混合开关与仓库清单长度（清单回来要重取）',
  /\[projectId, head, allBranches, repoView, flatRepoSub, mixRepos, repoChoices\.length\]/.test(modal));
ok('D-05 确认走混合红线，单仓库路径仍按 flatRepoSub 回传',
  /resolveMixedConfirmation\(commits, selected\)/.test(modal)
  && /onConfirm\(projectId, orderSelected\(commits, selected\), out\.repoSub\)/.test(modal)
  && /onConfirm\(projectId, orderSelected\(commits, selected\), flatRepoSub\)/.test(modal));
ok('D-06 每行渲染来源仓库标签：单行省略 + title 全称 + data-repo-sub',
  /data-lck="git-tree-repo-tag"/.test(modal) && /data-repo-sub=\{c\.repoSub \?\? ''\}/.test(modal)
  && /title=\{`来源仓库：\$\{c\.repoLabel\}`\}/.test(modal)
  && /textOverflow: 'ellipsis', whiteSpace: 'nowrap'/.test(modal));
ok('D-07 混合视图不画跨仓库车道（否则画出不存在的父子连线）',
  /const hasRepoTags = commits\.some\(\(c\) => !!c\.repoLabel\)/.test(modal)
  && /\{!hasRepoTags && \(/.test(modal));
ok('D-08 混合视图禁用跨仓库分页，且有「每仓库各取一页」的可见说明',
  /!mixActive && hasMore/.test(modal) && /setHasMore\(false\)/.test(modal)
  && /data-lck="git-tree-mixed-hint"/.test(modal));
ok('D-09 部分仓库失败只降级提示，其余仓库照常混入',
  /data-lck="git-tree-mixed-warning"/.test(modal) && /setMixedWarnings\(warnings\)/.test(modal));
ok('D-10 选中具体仓库即退出混合（下拉不会看着像没生效）',
  /setMixRepos\(false\)/.test(modal) && /data-lck="git-tree-mix-repos"/.test(modal));
ok('D-11 GitTreeCommit 新增可选来源字段（向后兼容，分组视图不带也能编译）',
  /repoSub\?: string/.test(treeSelect) && /repoLabel\?: string/.test(treeSelect));
ok('D-12 纯函数层不依赖 api / DOM（可 node 直跑单测）',
  !/from '\.\.\/api|document\.|window\./.test(util) && /import type \{ GitTreeCommit \}/.test(util));
ok('D-13 排序口径写明 %aI 作者时间与确定性兜底（防止后人改回字符串字典序）',
  /%aI/.test(util) && /Date\.parse/.test(util) && /return a\.i - b\.i/.test(util));
ok('D-14 确认类错误在重新点选后过期，且不把确认按钮锁死（C-02 实测缺陷回归）',
  /prev\.includes\('一次确认只能回传一个仓库'\)/.test(modal) && /!error \|\| mixActive/.test(modal));

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
