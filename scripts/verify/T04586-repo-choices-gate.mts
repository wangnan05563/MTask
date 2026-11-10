/*
 * T04586 复验门：默认（平铺）视图的仓库选择器——纯函数 + 源码锚 + 旧普查口径回归。
 *
 * 背景（【验证失败 2026-11-10】）：上一轮只把「递归发现多仓库」落在服务端 /git/repos，
 * 而「从 Git 树选范围」默认视图是平铺（T04595 裁决），恒定 repoSub='' 且从不问 /git/repos，
 * 于是用户第一屏永远只有根目录那一个仓库。本门钉住修复后的取数/折算/兼容三层口径。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04586-repo-choices-gate.mts
 * 无需后端、无需浏览器（纯函数 + 静态源码锚）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  censusTargetsFromRepoLists,
  defaultRepoSub,
  repoChoicesFromRepoList,
  type RepoListResult,
} from '../../web/src/utils/gitRepoBranchGroups';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const list: RepoListResult = {
  ok: true,
  workspacePath: 'D:/ws',
  truncated: false,
  repos: [
    { subPath: '', displayName: 'ws', isRoot: true, branch: 'main', commit: 'a'.repeat(40), remoteUrl: 'https://example.com/ws.git' },
    { subPath: 'banks', displayName: 'banks', isRoot: false, branch: 'dev', commit: 'b'.repeat(40), remoteUrl: '' },
    { subPath: 'grp/sub/deep', displayName: 'deep', isRoot: false, branch: 'feat', commit: 'c'.repeat(40), remoteUrl: '' },
  ],
};

console.log('—— A 组 · 仓库清单折算（纯函数）——');
const empty = repoChoicesFromRepoList(undefined);
ok('A-01 无回包 / ok:false / 空 repos 一律回空数组（不发明第二套仓库口径）',
  empty.length === 0 && repoChoicesFromRepoList({ ok: false }).length === 0 && repoChoicesFromRepoList({ ok: true, repos: [] }).length === 0);
const choices = repoChoicesFromRepoList(list);
ok('A-02 根 + 一级 + 三级嵌套仓库全进选择器（任意层级不遗漏）',
  choices.length === 3 && choices[2].subPath === 'grp/sub/deep', choices.map((c) => c.subPath).join(','));
ok('A-03 每项保留展示名与结构化元数据（branch / 40 位 commit / remoteUrl）',
  choices[1].displayName === 'banks' && choices[1].branch === 'dev' && choices[1].commit === 'b'.repeat(40)
  && choices[0].remoteUrl === 'https://example.com/ws.git');
ok('A-04 isRoot 判据：显式 true 与空 subPath 都算根，子仓库不算根',
  choices[0].isRoot && !choices[1].isRoot && !choices[2].isRoot);
ok('A-05 displayName 缺失时按相对路径末段兜底',
  repoChoicesFromRepoList({ ok: true, repos: [{ subPath: 'grp/sub/deep' }] })[0].displayName === 'deep');

console.log('\n—— B 组 · 默认仓库坐标（向后兼容的核心）——');
ok('B-01 清单含根仓库 → 保持 repoSub=""（旧单仓库逻辑逐字不变）', defaultRepoSub(choices) === '');
ok('B-02 清单不含根（只是装仓库的目录）→ 落到第一个子仓库，不再对非 git 根报错',
  defaultRepoSub(choices.slice(1)) === 'banks');
ok('B-03 当前值仍在清单 → 原样保留（手动切过仓库后刷新清单不被拽回默认）',
  defaultRepoSub(choices, 'grp/sub/deep') === 'grp/sub/deep');
ok('B-04 当前值已失效 → 回退到根/首个仓库', defaultRepoSub(choices, 'gone') === '' && defaultRepoSub(choices.slice(1), 'gone') === 'banks');
ok('B-05 空清单 → 维持旧口径 ""（取数失败由 /git/log 给真实原因）', defaultRepoSub([]) === '');
ok('B-06 三级嵌套仓库可被直接选为默认', defaultRepoSub(choices.slice(2), '') === 'grp/sub/deep');

console.log('\n—— C 组 · 旧普查口径回归（不得被本轮改动带偏）——');
const projects = [{ id: 'p1', name: 'P1', workspacePath: 'D:/ws' }];
ok('C-01 /git/repos 成功时 census 仍按每个 subPath 展开（根 + 子 + 三级）',
  JSON.stringify(censusTargetsFromRepoLists(projects, [{ status: 'fulfilled', value: list }]).map((t) => t.repoSub))
  === JSON.stringify(['', 'banks', 'grp/sub/deep']));
ok('C-02 /git/repos 失败或空清单仍回落到「根仓库一条」',
  censusTargetsFromRepoLists(projects, [{ status: 'rejected', reason: new Error('x') }]).map((t) => t.repoSub).join(',') === ''
  && censusTargetsFromRepoLists(projects, [{ status: 'fulfilled', value: { ok: true, repos: [] } }]).length === 1);

console.log('\n—— D 组 · 源码锚（数据计算 → 渲染消费全链）——');
const modal = src('web/src/ui/GitTreePickerModal.tsx');
const picker = src('web/src/ui/gitScopePicker.tsx');
const utils = src('web/src/utils/gitRepoBranchGroups.ts');
ok('D-01 弹窗打开即按当前项目取 /git/repos（不再只在分组视图普查）',
  /api\.get<RepoListResult>\(`\/git\/repos\?/.test(modal) && /setRepoChoices\(choices\)/.test(modal));
ok('D-02 清单回来即按 defaultRepoSub 校正平铺取数坐标', /setFlatRepoSub\(\(prev\) => defaultRepoSub\(choices, prev\)\)/.test(modal));
ok('D-03 默认视图渲染仓库选择器且带结构化元数据',
  /data-lck="git-tree-repo-select"/.test(modal) && /c\.branch/.test(modal) && /c\.commit\.slice\(0, 8\)/.test(modal));
ok('D-04 选择仓库驱动 load 的 repoSub + 确认回传同一坐标（不串仓库）',
  /buildLogQuery\(projectId, head, allBranches, search, nextSkip, flatRepoSub\)/.test(modal)
  && /onConfirm\(projectId, orderSelected\(commits, selected\), flatRepoSub\)/.test(modal));
ok('D-05 切仓库清空旧仓库的勾选/起点条件', /setSelected\(\[\]\)/.test(modal) && /setFlatRepoSub\(e\.target\.value\)/.test(modal));
ok('D-06 底部仓库标注跟随当前子仓库（不再一律写项目名）', /flatRepoLabel/.test(modal) && /仓库 \$\{flatRepoLabel\}/.test(modal));
ok('D-07 分组视图普查及入口仍在（本轮未反转 T04595 默认平铺裁决）',
  /if \(repoView && !census && !scanning && projects\.length > 0\) void runCensus\(projects\)/.test(modal)
  && /void runCensus\(projects\)/.test(modal) && /initialRepoView=\{false\}/.test(picker));
ok('D-08 新口径落在 utils 纯函数（可独立断言，不靠真浏览器）',
  /export function repoChoicesFromRepoList\(/.test(utils) && /export function defaultRepoSub\(/.test(utils));

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
