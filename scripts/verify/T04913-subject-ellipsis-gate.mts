/*
 * T04913 门：Git 记录标题「单行省略 + 悬浮全量显示」——浮层坐标纯函数 + 组件消费链源码锚。
 *
 * 现状核对：改造前 `CommitRows` 已有 CSS 单行省略与原生 `title`，故本单不是「从无到有」，
 * 而是补上三件真正缺的东西：显式收敛字号、可控且跨浏览器一致的 Tooltip、仅截断时触发。
 * 交互（点选 / Shift 框选 / 展开详情）必须逐字不变。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04913-subject-ellipsis-gate.mts
 * 无需后端、无需浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SUBJECT_TOOLTIP_EDGE,
  SUBJECT_TOOLTIP_EST_HEIGHT,
  SUBJECT_TOOLTIP_GAP,
  SUBJECT_TOOLTIP_MAX_WIDTH,
  shouldShowSubjectTooltip,
  subjectTooltipBox,
} from '../../web/src/utils/gitSubjectTooltip';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const rect = (left: number, top: number, bottom = top + 18, right = left + 300) => ({ left, top, bottom, right });
const vp = (width: number, height: number) => ({ width, height });

console.log('—— A 组 · 截断判据与浮层坐标（纯函数） ——');
ok('A-01 只有真截断才弹浮层，短标题不打扰',
  shouldShowSubjectTooltip(100, 100) === false && shouldShowSubjectTooltip(101, 100) === false
  && shouldShowSubjectTooltip(102, 100) === true);
ok('A-02 +1 容差覆盖亚像素渲染（clientWidth 为 0 的隐藏元素不算截断）',
  shouldShowSubjectTooltip(0, 0) === false && shouldShowSubjectTooltip(2, 0) === true);
const wide = subjectTooltipBox(rect(200, 300), vp(1600, 1000));
ok('A-03 宽屏：宽度取上限、左边跟随标题、浮层放标题下方',
  wide.maxWidth === SUBJECT_TOOLTIP_MAX_WIDTH && wide.left === 200
  && wide.top === 300 + 18 + SUBJECT_TOOLTIP_GAP, JSON.stringify(wide));
const nearRight = subjectTooltipBox(rect(1500, 300), vp(1600, 1000));
ok('A-04 靠右：向左钳制到「视口 - 宽度 - 安全边距」，不溢出屏幕',
  nearRight.left === 1600 - SUBJECT_TOOLTIP_MAX_WIDTH - SUBJECT_TOOLTIP_EDGE
  && nearRight.left + nearRight.maxWidth <= 1600 - SUBJECT_TOOLTIP_EDGE, JSON.stringify(nearRight));
const nearBottom = subjectTooltipBox(rect(200, 900, 918), vp(1600, 1000));
ok('A-05 靠底：下方放不下时翻到标题上方',
  nearBottom.top === 900 - SUBJECT_TOOLTIP_GAP - SUBJECT_TOOLTIP_EST_HEIGHT,
  JSON.stringify(nearBottom));
const cramped = subjectTooltipBox(rect(20, 20, 38), vp(1600, 100));
ok('A-06 上下都放不下：钳到顶部安全边距，不出现负坐标',
  cramped.top === SUBJECT_TOOLTIP_EDGE, JSON.stringify(cramped));
const narrow = subjectTooltipBox(rect(280, 300), vp(320, 800));
ok('A-07 窄屏（320px）：宽度按视口收缩，左右各留安全边距',
  narrow.maxWidth === 320 - SUBJECT_TOOLTIP_EDGE * 2
  && narrow.left === SUBJECT_TOOLTIP_EDGE
  && narrow.left + narrow.maxWidth <= 320 - SUBJECT_TOOLTIP_EDGE, JSON.stringify(narrow));
const tiny = subjectTooltipBox(rect(100, 300), vp(200, 800));
ok('A-08 极窄屏（200px）也不溢出（不强设最小宽度）',
  tiny.maxWidth <= 200 - SUBJECT_TOOLTIP_EDGE * 2 && tiny.left === SUBJECT_TOOLTIP_EDGE,
  JSON.stringify(tiny));

console.log('—— B 组 · 组件消费链源码锚 ——');
const modal = src('web/src/ui/GitTreePickerModal.tsx');
const util = src('web/src/utils/gitSubjectTooltip.ts');
ok('B-01 新增纯函数层被组件真实 import 并消费（不是算了不用）',
  /from '\.\.\/utils\/gitSubjectTooltip'/.test(modal)
  && /shouldShowSubjectTooltip\(el\.scrollWidth, el\.clientWidth\)/.test(modal)
  && /subjectTooltipBox\(/.test(modal));
ok('B-02 CommitRows 已换用 CommitSubject（平铺与分组视图共用同一段 JSX）',
  /<CommitSubject text=\{c\.subject\} \/>/.test(modal)
  && (modal.match(/<CommitSubject text=\{c\.subject\} \/>/g) ?? []).length === 1);
ok('B-03 单行省略三件套 CSS 齐备且显式降低字号到 --fs-s',
  /textOverflow: 'ellipsis', whiteSpace: 'nowrap'/.test(modal)
  && /flex: '1 1 auto', minWidth: 0, overflow: 'hidden'/.test(modal)
  && /fontSize: 'var\(--fs-s\)', lineHeight: 1\.3/.test(modal));
ok('B-04 行内边距由 3px 收到 2px（提高垂直密度，一屏多看几行）',
  /data-lck="git-tree-row"[\s\S]{0,220}padding: '2px 8px'/.test(modal)
  && !/padding: '3px 8px'/.test(modal));
ok('B-05 受控 Tooltip：portal 到 body + fixed 定位（绕开列表 overflow:auto 裁剪）',
  /createPortal\(/.test(modal) && /, document\.body\)/.test(modal)
  && /position: 'fixed', left: box\.left, top: box\.top/.test(modal));
ok('B-06 Tooltip 不拦截点击、带 role 与取证属性，交互逻辑不变',
  /data-lck="git-tree-subject-tooltip" role="tooltip"/.test(modal)
  && /pointerEvents: 'none'/.test(modal)
  && /data-lck="git-tree-subject" data-full-subject=\{text\} aria-label=\{text\}/.test(modal));
ok('B-07 去掉会与自定义浮层叠出两份提示的原生 title',
  !/title=\{c\.subject\}/.test(modal) && /aria-label=\{text\}/.test(modal));
ok('B-08 悬浮进出与滚动/视口变化都会收起浮层（不留半空残影）',
  /onMouseEnter=\{show\} onMouseLeave=\{\(\) => setBox\(null\)\}/.test(modal)
  && /window\.addEventListener\('scroll', hide, true\)/.test(modal)
  && /window\.addEventListener\('resize', hide\)/.test(modal));
ok('B-09 浮层文本可完整换行显示长标题',
  /whiteSpace: 'normal', overflowWrap: 'anywhere'/.test(modal)
  && /\{text\}/.test(modal));
ok('B-10 纯函数层不依赖 DOM / api（可 node 直跑单测）',
  !/document\.|window\.|from '\.\.\/api/.test(util) && /export function subjectTooltipBox/.test(util));

console.log('—— C 组 · 相邻链路回归锚 ——');
ok('C-01 T04912 来源仓库标签仍带单行省略与全称 title',
  /data-lck="git-tree-repo-tag"/.test(modal) && /title=\{`来源仓库：\$\{c\.repoLabel\}`\}/.test(modal));
ok('C-02 T04911 分组搜索分派与 T04912 混合确认红线未被改动',
  /function triggerSearch\(\)/.test(modal) && /runGroupedSearch\(\)/.test(modal)
  && /resolveMixedConfirmation\(commits, selected\)/.test(modal));
ok('C-03 车道/勾选/展开详情逻辑仍在（只改展示样式与悬浮行为）',
  /assignLanes\(commits\)/.test(modal) && /onRowClick=\{onRowClick\}/.test(modal)
  && /data-lck="git-tree-expand"/.test(modal));

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
