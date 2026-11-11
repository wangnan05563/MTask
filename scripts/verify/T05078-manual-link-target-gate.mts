/*
 * T05078 门（源码锚）：手动关联批量入口的目标可见 + 目标切换不继承勾选。
 *
 * 背景（T05064 实测）：`renderManualGitLinkQueue` 的目标是 `gitLinkQueue[0]` 但弹窗不显示；
 * `confirmManualGitLink` 只 `slice(1)`，队列非空时弹窗不卸载、`selected` 不清空，
 * 用户再点一次确认就把同一批 SHA 写进下一个任务（T00004/T00005 同拿 97a034a）。
 *
 * 修复口径：① 弹窗显示「本次确认将关联到：T00005 · 标题」；② `key={head.id}` 让目标切换
 * 重挂载、勾选自然清空；③ flash 报出「还有 N 条未回写」并用函数式更新防止队列复活。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T05078-manual-link-target-gate.mts
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
const tasks = src('web/src/pages/TasksPage.tsx');
const queueFn = (tasks.match(/function renderManualGitLinkQueue\(\)[\s\S]*?\n  \}/) ?? [''])[0];
const confirmFn = (tasks.match(/async function confirmManualGitLink\([\s\S]*?\n  \}/) ?? [''])[0];

console.log('—— A 组 · 目标可见 ——');
ok('A-01 弹窗新增可选 targetLabel，且不传时不渲染（其余三入口零影响）',
  /readonly targetLabel\?: string;/.test(modal) && /\{targetLabel && \(/.test(modal));
ok('A-02 提示条明确写出「本次确认将关联到」，并带取证锚',
  /data-lck="git-tree-target"/.test(modal) && /本次确认将关联到：/.test(modal));
ok('A-03 提示条对长标题换行而不是省略（目标不能被藏掉）',
  /overflowWrap: 'anywhere', wordBreak: 'break-word'/.test(modal));
ok('A-04 批量入口真的把目标任务传下来（不是只加了个 prop 没用）',
  /targetLabel=\{`\$\{head\.task_no \?\? head\.id\} · \$\{head\.title\}/.test(queueFn), queueFn.slice(0, 160));

console.log('—— B 组 · 目标切换不继承勾选（防串任务） ——');
ok('B-01 弹窗按目标任务 id 重挂载（勾选/取数态不跨任务继承）',
  /<GitTreePickerModal[\s\S]{0,160}key=\{head\.id\}/.test(queueFn));
ok('B-02 队列推进用函数式更新（异步期间被 onClose 清空后不会把旧队列写回）',
  /setGitLinkQueue\(\(prev\) => \(prev\.length <= 1 \? \[\] : prev\.slice\(1\)\)\)/.test(confirmFn),
  confirmFn.slice(-260).replace(/\s+/g, ' '));
ok('B-03 确认后如实报出「还有 N 条未回写」（用户知道后面还有任务）',
  /还有 \$\{remaining\} 条未回写/.test(confirmFn) && /const remaining = Math\.max\(0, gitLinkQueue\.length - 1\)/.test(confirmFn));
ok('B-04 目标仍严格取队列头，一次只写一个任务（没有改成批量混写）',
  /const head = gitLinkQueue\[0\];/.test(confirmFn) && /head\.id/.test(confirmFn));
ok('B-05 队列号只用于展示当前进度，不参与写入目标判断',
  // T05556 前：队列号内嵌在 targetLabel 字符串（第 1/N 条）；T05556 起：改用 targetQueue prop 展示，targetLabel 只含 任务号·标题。
  // 两种写法都满足「队列号不写入目标」：关键判据是 confirmFn 仍严格按 head（队列头）写入，不读队列号判断目标。
  (!/第 1\/\$\{gitLinkQueue\.length\} 条/.test(queueFn) ? !/targetQueue/.test(queueFn) || !/targetLabel=\{`[^`]*第 1/.test(queueFn) : true)
  && !/slice\(0, 1\)/.test(confirmFn));

console.log('—— C 组 · 改动范围与既有能力 ——');
ok('C-01 只有 TasksPage 的批量入口传 targetLabel，其余三个入口未传',
  ['web/src/ui/gitScopePicker.tsx', 'web/src/components/GitCommitTab.tsx', 'web/src/pages/CodeReviewLecturePanel.tsx']
    .every((p) => !src(p).includes('targetLabel'))
  && tasks.includes('targetLabel='));
ok('C-02 目标提示条不是新增按钮（未改任何交互控件与确认判据）',
  !/git-tree-target[\s\S]{0,200}<button/.test(modal));
ok('C-03 弹窗既有能力未被改动（T05063 动画 / T04912 混合 / T04913 标题 / T04911 搜索）',
  /git-tree-confirm-pop/.test(modal) && /resolveMixedConfirmation\(commits, selected\)/.test(modal)
  && /<CommitSubject text=\{c\.subject\} \/>/.test(modal) && /function triggerSearch\(\)/.test(modal));

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
