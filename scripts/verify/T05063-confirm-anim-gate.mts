/*
 * T05063 门：「Git 树选范围」确认选择按钮的点击动画 + 防连点守卫（源码锚）。
 *
 * 需求要点：点击后必须有可见动画（缩放/透明度等，200-300ms、流畅）；动画期间保持可交互或置灰，
 * 但不得重复触发业务逻辑；只改这个按钮，不影响其它按钮与流程；不引入重型依赖。
 *
 * 关键约束（代码里已写死的原因）：四个入口中 `gitScopePicker` 与讲稿卡在确认后**同步卸载**弹窗，
 * 若同步 confirm 则动画来不及绘制——所以提交被推迟一个动画时长，卸载时必须清定时器。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T05063-confirm-anim-gate.mts
 * 无需后端、无需浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const modal = src('web/src/ui/GitTreePickerModal.tsx');
const animMs = Number((modal.match(/CONFIRM_ANIM_MS = (\d+)/) ?? [])[1] ?? 0);

console.log('—— A 组 · 动画实现 ——');
ok('A-01 动画时长常量落在需求区间 200-300ms', animMs >= 200 && animMs <= 300, `CONFIRM_ANIM_MS=${animMs}`);
ok('A-02 关键帧同时含缩放与透明度变化，并在 100% 回到初始态（不留常驻形变）',
  /@keyframes git-tree-confirm-pop/.test(modal)
  && /scale\(\.93\)/.test(modal) && /opacity: \.72/.test(modal)
  && /100% \{ transform: scale\(1\); opacity: 1; \}/.test(modal));
ok('A-03 动画只在点击后的动画窗口内挂上，结束即移除',
  /animation: confirming \? `git-tree-confirm-pop \$\{CONFIRM_ANIM_MS\}ms/.test(modal));
ok('A-04 缓动函数显式指定（不是默认 ease，保证流畅稳定）',
  /cubic-bezier\(\.4,0,\.2,1\)/.test(modal));
ok('A-05 关键帧只定义一次、命名带组件前缀（不污染全局样式与其它按钮）',
  (modal.match(/@keyframes git-tree-confirm-pop/g) ?? []).length === 1
  && !/git-tree-cancel[^\n]*animation/.test(modal));
ok('A-06 未引入额外依赖（无新包、无动画库 import）',
  !/from 'framer-motion'|from 'react-transition-group'|from 'gsap'/.test(modal));

console.log('—— B 组 · 防连点与提交安全 ——');
ok('B-01 确认按钮改用带守卫的 onConfirmClick',
  /data-lck="git-tree-confirm" onClick=\{onConfirmClick\}/.test(modal));
ok('B-02 不可确认或动画进行中直接 return（同一帧被连发也只走一次）',
  /function onConfirmClick\(\) \{[\s\S]{0,120}if \(!confirmEnabled\) return;/.test(modal));
ok('B-03 动画期间置灰（disabled 绑定 !confirmEnabled，浏览器不再派发 click）',
  /disabled=\{!confirmEnabled\}/.test(modal) && /const confirmEnabled = canConfirm && !confirming;/.test(modal));
ok('B-04 重复触发会清掉前一个定时器，最终只提交一次',
  /if \(confirmTimer\.current != null\) window\.clearTimeout\(confirmTimer\.current\);/.test(modal));
ok('B-05 卸载时清理定时器（动画窗口内 Esc/取消不会把提交漏到关闭之后）',
  /useEffect\(\(\) => \(\) => \{[\s\S]{0,300}?clearTimeout\(confirmTimer\.current\)/.test(modal)
  && /confirmTimer\.current = null;\s*\}\s*, \[\]\);/.test(modal));
ok('B-06 延迟到动画结束才调用原 confirm()，业务分支一行未改',
  /setConfirming\(false\);\s*\n\s*confirm\(\);/.test(modal)
  && /function confirm\(\) \{/.test(modal));
ok('B-07 动画状态可被无障碍与自动化读取（aria-busy）',
  /aria-busy=\{confirming \|\| undefined\}/.test(modal));
ok('B-08 延迟时长复用同一常量（不出现第二处魔法数字）',
  (modal.match(/\b250\b/g) ?? []).length <= 2);

console.log('—— C 组 · 改动范围 ——');
ok('C-01 只改了确认按钮：取消按钮仍是原样 boxStyle，搜索/视图切换未动',
  /data-lck="git-tree-cancel" onClick=\{onClose\} style=\{boxStyle\}/.test(modal)
  && /data-lck="git-tree-search-btn" onClick=\{\(\) => triggerSearch\(\)\}/.test(modal));
ok('C-02 四个入口复用同一组件（单一按钮源，改一处全站生效）',
  ['web/src/ui/gitScopePicker.tsx', 'web/src/pages/TasksPage.tsx',
    'web/src/components/GitCommitTab.tsx', 'web/src/pages/CodeReviewLecturePanel.tsx']
    .every((p) => src(p).includes('<GitTreePickerModal')));
ok('C-03 相邻链路红线未动（T04911 搜索分派 / T04912 混合确认 / T04913 标题组件）',
  /function triggerSearch\(\)/.test(modal) && /runGroupedSearch\(\)/.test(modal)
  && /resolveMixedConfirmation\(commits, selected\)/.test(modal)
  && /<CommitSubject text=\{c\.subject\} \/>/.test(modal));

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
