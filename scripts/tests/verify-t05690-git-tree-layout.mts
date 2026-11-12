/**
 * T05690 门：Git 树选范围的全屏布局 / 已选提交列表 / 悬停无倾斜。
 *
 * 现场三件事：
 *   1. 全屏后标题与说明文字重叠——说明原来与标题、按钮挤在同一 flex 行，宽度不足时叠字；
 *   2. 「未回写提交 ID」说明区摊开了一整张任务清单，把提示条撑高；
 *   3. 悬停记录时出现倾斜/旋转（全站 `.tbtn-anim` 的 rotate 会漏进记录行）。
 *
 * 判据：
 *   A 组 布局——说明单独成行（flex-basis 100% + order 3）；容器裁溢出；全屏铺满仍成立。
 *   B 组 内容——已选提交 ID 列表在范围确认区（≥1 时渲染、超 8 个折叠）；未回写任务清单不再渲染。
 *   C 组 交互——`.gt-row:hover` 及其子元素一律 transform: none。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05690-git-tree-layout.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

const MODAL = readFileSync(join(ROOT, 'web/src/ui/GitTreePickerModal.tsx'), 'utf8');
const THEME = readFileSync(join(ROOT, 'web/src/ui/gitTreeTheme.ts'), 'utf8');
const TASKS = readFileSync(join(ROOT, 'web/src/pages/TasksPage.tsx'), 'utf8');

ok('A-01 说明文字单独成行（flex-basis 100% + order 3），不再与标题争宽叠字',
  /flex: '1 1 100%', order: 3/.test(MODAL)
  && /单击=勾选\/取消多个提交/.test(MODAL));
ok('A-02 容器裁溢出（全屏内容高于视口时不会压住顶栏）',
  /display: 'flex', flexDirection: 'column',[\s\S]{0,160}overflow: 'hidden'/.test(MODAL));
ok('A-03 全屏仍铺满视口（修复不牺牲 T05556 的全屏语义）',
  /width: fullscreen \? '100%'/.test(MODAL) && /height: fullscreen \? '100%'/.test(MODAL));

ok('B-01 已选提交 ID 列表渲染在范围确认区，且只展示前 8 个 + 折叠计数',
  /data-lck="git-tree-picked-ids"/.test(MODAL)
  && /selected\.slice\(0, 8\)\.map/.test(MODAL)
  && /另 \{selected\.length - 8\} 个/.test(MODAL));
ok('B-02 列表随勾选实时变化（直接用 selected，不是快照副本）',
  /selected\.length > 0 && \(/.test(MODAL));
ok('B-03 「未回写提交 ID」区不再摊开任务清单（提示条只留计数与三个操作）',
  !/unlinked-task-list/.test(TASKS) && /条未回写提交 ID/.test(TASKS));

ok('C-01 悬停记录不应用任何倾斜/旋转（含子元素）',
  /\.gt-row:hover, \.gt-row:hover \* \{ transform: none !important; \}/.test(THEME));

const body = [`T05690 Git 树布局门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05690-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05690-gate-results.txt')}`);
