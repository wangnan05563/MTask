/*
 * T04911 源码锚门：分组视图搜索链路（数据输入 → 取数 → 重取数 → 反馈）与平铺回归。
 *
 * 背景：「按仓库分组」模式下点搜索毫无反应——搜索按钮调 load(false)，而 load 开头
 * `if (!projectId || repoView) return` 直接吞掉；窗口取数 buildLogQuery 的 search 又写死空串。
 * 本门把这条链路的每一环钉在源码上（真浏览器交互另见 T04911-grouped-search-ui.mts）。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04911-grouped-search-gate.mts
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const src = fs.readFileSync(path.join(ROOT, 'web/src/ui/GitTreePickerModal.tsx'), 'utf8');

console.log('—— A 组 · 分组视图搜索链路 ——');
ok('A-01 新增搜索词 ref，懒加载窗口读最新值而非闭包旧值',
  /const searchRef = useRef\(search\)/.test(src) && /searchRef\.current = search;/.test(src));
ok('A-02 搜索按钮按视图模式分派（不再无条件 load(false)）',
  /function triggerSearch\(\)[\s\S]{0,180}if \(repoView\) runGroupedSearch\(\);[\s\S]{0,120}else void load\(false\)/.test(src)
  && /data-lck="git-tree-search-btn" onClick=\{\(\) => triggerSearch\(\)\}/.test(src));
ok('A-03 回车搜索同样分派（键盘路径不漏）', /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter'\) triggerSearch\(\); \}\}/.test(src));
ok('A-04 重新取数按钮也分派（分组模式下不再是死按钮）',
  /onClick=\{\(\) => triggerSearch\(\)\}[\s\S]{0,180}aria-label="重新取数"/.test(src));
ok('A-05 分组窗口取数带上当前搜索词（修复前写死空串）',
  /buildLogQuery\(target\.projectId, refName \?\? target\.branchName, false, searchRef\.current,/.test(src));
ok('A-06 分组搜索对已加载/在途窗口按 skip=0 重取数，且不清空已勾选',
  /function runGroupedSearch\(\)/.test(src)
  && /Object\.values\(panes\)\.filter\(\(p\) => p\.loaded \|\| p\.loading\)/.test(src)
  && /void loadPane\(\{ repoKey: pane\.repoKey, projectId: pane\.projectId, repoSub: pane\.repoSub, branchName: pane\.branchName \}, false, true\)/.test(src));
ok('A-07 无已加载窗口时给一句明确提示，不静默无响应', /请先展开一个「仓库 × 分支」窗口再搜索/.test(src));
ok('A-08 搜索有可见反馈且只在分组模式显示', /data-lck="git-tree-grouped-search"/.test(src) && /repoView && groupedSearchTerm/.test(src));
ok('A-09 连续搜索有取数序号守卫（旧请求晚到不覆盖新结果）',
  /const paneSeq = useRef<Record<string, number>>\(\{\}\)/.test(src)
  && /const isStale = \(\) => paneSeq\.current\[key\] !== seq/.test(src)
  && /if \(isStale\(\)\) return prev;/.test(src));

console.log('\n—— B 组 · 平铺回归与分组布局不变 ——');
ok('B-01 平铺取数仍走原 load 且带 search（既有搜索能力未改）',
  /async function load\(append: boolean\)/.test(src)
  && /if \(!projectId \|\| repoView\) return;/.test(src)
  && /const qs = buildLogQuery\(projectId, head, allBranches, search, nextSkip, flatRepoSub\)/.test(src));
ok('B-02 分组视图守卫仍在（平铺取数不会误跑进分组）', /if \(!projectId \|\| repoView\) return;/.test(src));
ok('B-03 分组三层列表组件与分组头样式原样保留（不改视觉布局）',
  /function RepoBranchGroupList\(/.test(src) && /const groupHeadStyle: React\.CSSProperties/.test(src)
  && /data-lck="git-repo-group"/.test(src) && /data-lck="git-repo-repo"/.test(src));
ok('B-04 分组搜索不新增/删除分组结构状态（只复用既有 panes）',
  /const \[panes, setPanes\]/.test(src) && !/setGroupedGroups\(/.test(src));
ok('B-05 搜索按钮在分组模式按 scanning 禁用、平铺按 loading 禁用（不误灰）',
  /disabled=\{repoView \? scanning : loading\}/.test(src));

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
