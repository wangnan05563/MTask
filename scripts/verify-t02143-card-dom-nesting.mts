/**
 * T02143 门（派生自 T02107：ReportCard 容器被改回原生 button → 卡片内嵌套按钮非法 DOM）。
 *
 * 这一单层此前没有门管：`validateDOMNesting` 只在 dev React 下报，生产构建剥掉告警，
 * `tsc --noEmit` 也不报——所以 fdc6090 那次「div role=button 转原生 button」的 a11y 批修
 * 把 T00908 的修复整个回退掉，跑了两年都没被任何检查发现（历史缺陷，见工单）。
 * 本门是**纯静态源码守卫**（零依赖、可在任何环境跑），钉住三件事：
 *   ① 容器形态：`ReportCard` 返回的容器不得是 `<button>`（它带 `action`/`onReset` 角标按钮）；
 *      必须是 `div role="button"` + `tabIndex={0}` + `onKeyDown`——键盘可达与 fdc6090 的目标等价。
 *   ② 键盘语义：容器 `onKeyDown` 必须先判 `e.target !== e.currentTarget` 早退——
 *      否则角标按钮的 Enter/Space 冒泡到容器会「弹确认框的同时把卡片收起」（T02143 实施时实测踩到）。
 *   ③ 观感不回退：容器改回 div 后不再命中全局 `button:hover/:active` 规则，
 *      `.card-btn` 必须自带 transition/hover/active 三条，否则 a11y 修复顺手回退 T00494 微交互体系。
 *   B 组跑一遍**全仓 tsx 的 `<button>` 深度扫描**（先剥注释，再按引号/大括号感知切分标签——
 *      朴素 `[^>]*` 会在 `onClick={() => x > 1}` 这类属性里断错，首轮误报 41 处；注释里的
 *      `<button>` 示例也会当开标签，PlanTimeline 的 T01576 注释再误报 2 处），
 *      同文件内「按钮套按钮」判红；已实测的两处同根因违规（TasksPage/PlanPage 项目切换行的
 *      置顶按钮）进登记清单，清单必须与实际命中逐文件相等——只准缩短，不准过期。
 *      跨文件形态（PinToggle 落在标题按钮内，提示词/通用需求两处实测 3+47 例）静态扫不到，
 *      已登记并派生单处理，不属本组断言范围。
 *
 * 运行时口径（工单验证 ②③：dev 控制台无 validateDOMNesting、键盘三步通路）为浏览器实测项，
 * 由 scripts/.t02143-ui-probe.mjs 一次性取证（本仓 UI 门历来不引浏览器依赖，与 t02142 同口径），
 * 证据落在 .workbuddy/t02143-{before,after}-report.json / -console.txt。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02143-card-dom-nesting.mts
 * 结果落 .workbuddy/t02143-gate-results-<运行标识>.txt。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'web', 'src');
let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};

// =====================================================================
// A 组：ReportCard 容器形态 + 键盘语义 + 观感不回退
// =====================================================================
const page = readFileSync(join(WEB_SRC, 'pages', 'ReportPage.tsx'), 'utf8');
const start = page.indexOf('function ReportCard(');
ok('A-01 ReportCard 组件存在（改名/挪走会让本门失明）', start >= 0);
const body = page.slice(start, page.indexOf('\nfunction ', start + 1) > 0 ? page.indexOf('\nfunction ', start + 1) : page.length);
const ret = body.slice(body.indexOf('return ('));

// 工单原话口径：hasCorner 分支存在时，`return (` 后直接跟 <button 即判红
const cornerBranch = /hasCorner\s*&&\s*\(/.test(body);
ok('A-02 角标分支仍在（本组断言的前提：容器里确实有交互子元素）', cornerBranch);
ok('A-03 容器不得是原生 button（`return (` 后紧跟 <button 即非法嵌套）',
  !/return\s*\(\s*<button\b/.test(ret), ret.slice(0, 120));
ok('A-04 容器是 div role="button"',
  /return\s*\(\s*<div\b[\s\S]{0,400}?role="button"/.test(ret));
ok('A-05 容器带 tabIndex={0}（键盘可达，保住 fdc6090 的原目标）',
  /return\s*\(\s*<div\b[\s\S]{0,400}?tabIndex=\{0\}/.test(ret));
ok('A-06 容器带 onKeyDown 且 Enter/Space 都能激活',
  /onKeyDown=\{[\s\S]{0,400}?e\.key === 'Enter' \|\| e\.key === ' '/.test(body));
ok('A-07 onKeyDown 判 e.target !== e.currentTarget 早退（角标按键冒泡不得触发展开/收起）',
  /onKeyDown=\{[\s\S]{0,300}?e\.target !== e\.currentTarget[\s\S]{0,200}?return/.test(body));
ok('A-08 容器闭合标签与开标签一致（div ↔ </div>，不能改一半）',
  /return\s*\(\s*<div\b/.test(ret) && /<\/div>\s*\)\s*;/.test(ret) && !/<\/button>\s*\)\s*;/.test(ret));
ok('A-09 角标按钮保持原生 <button>（合法性靠容器不是按钮，不靠把角标降级成 span）',
  /onReset\s*&&\s*\([\s\S]{0,400}?<button\b/.test(body));
ok('A-10 角标 onClick 仍 stopPropagation（鼠标通路不冒泡）',
  /stopPropagation\(\)[\s\S]{0,80}?handleReset/.test(body));

const app = readFileSync(join(WEB_SRC, 'App.tsx'), 'utf8');
ok('A-11 卡片容器挂 .card-btn 类（下面三条手感规则的作用域）',
  /className=\{`card-btn/.test(body));
ok('A-12 .card-btn 有 transition（div 不再命中全局 button 规则，需自带）',
  /\.card-btn\s*\{[^}]*transition:/.test(app));
ok('A-13 .card-btn:hover 倾斜 / :active 缩放两条手感规则齐备（对齐全局 button 基准）',
  /\.card-btn:hover\s*\{[^}]*rotate\(/.test(app) && /\.card-btn:active\s*\{[^}]*scale\(/.test(app));

// =====================================================================
// B 组：全仓 tsx 标签切分扫描——同文件内 <button> 套 <button>
// =====================================================================
/** 先剥注释（JSX 的 {/* *\/}、行注释、块注释），字符串态一并跟踪——注释里写的 `<button>` 示例
 *  会被当成开标签（PlanTimeline:350 的 T01576 注释首轮即误报两处）。 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let str: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (str) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === str) str = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; out += c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
/** 跳过属性里的引号串与 {} 表达式，返回标签结束位置；selfClosing 单独回传 */
function tagEnd(src: string, open: number): { end: number; selfClosing: boolean } {
  let i = open + 1; // 过 '<'
  let brace = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      i += 1;
      continue;
    }
    if (c === '{') { brace += 1; i += 1; continue; }
    if (c === '}') { brace -= 1; i += 1; continue; }
    if (c === '>' && brace === 0) return { end: i + 1, selfClosing: src[i - 1] === '/' };
    i += 1;
  }
  return { end: i, selfClosing: false };
}
/**
 * 线性扫描 `<button>` 开/闭标签深度：返回「按钮套按钮」命中数与收口后的残留深度（深度不归零=切分错位）。
 * `inButtonComponents`（T02146）：额外点名「自身渲染 button 的组件标签」——它们同文件扫不到，
 * 但出现在 button 内部就是同一个非法 DOM，故按 button 深度同样计 `componentHits`。
 */
function scanNested(src: string, inButtonComponents: string[] = []): { hits: number; componentHits: number; depth: number } {
  let depth = 0;
  let i = 0;
  let hits = 0;
  let componentHits = 0;
  while (i < src.length) {
    if (src[i] !== '<') { i += 1; continue; }
    if (src.startsWith('</', i)) {
      const isButton = /^<\/button\b/.test(src.slice(i));
      const { end } = tagEnd(src, i);
      if (isButton) depth = Math.max(0, depth - 1);
      i = end;
      continue;
    }
    const comp = inButtonComponents.find((c) => src.startsWith(`<${c}`, i) && !/^<\/|[\w]/.test(src[i + 1 + c.length] ?? ' '));
    if (comp) {
      const { end } = tagEnd(src, i);
      if (depth > 0) componentHits += 1;
      i = end;
      continue;
    }
    if (!/^<button\b/.test(src.slice(i))) { i += 1; continue; }
    const { end, selfClosing } = tagEnd(src, i);
    if (depth > 0 && !selfClosing) hits += 1;
    if (!selfClosing) depth += 1;
    i = end;
  }
  return { hits, componentHits, depth };
}
const files: string[] = [];
(function walk(dir: string) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.tsx')) files.push(p);
  }
})(WEB_SRC);
const byFile = new Map<string, number>();
const compByFile = new Map<string, number>();
let unbalanced = 0;
/** T02146：自身渲染原生 button、可被误放进标题 button 内部的共享组件 */
const IN_BUTTON_COMPONENTS = ['PinToggle'];
for (const f of files) {
  const { hits, componentHits, depth } = scanNested(stripComments(readFileSync(f, 'utf8')), IN_BUTTON_COMPONENTS);
  if (depth !== 0) unbalanced += 1;
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  if (hits > 0) byFile.set(rel, hits);
  if (componentHits > 0) compByFile.set(rel, componentHits);
}
/**
 * 登记在册的同根因违规（T02143 实测发现，当时按红线 7 派生单处理，不在本单顺手改）：
 *   - TasksPage 项目切换行的置顶图标按钮套在项目行 button 里；
 *   - PlanPage 同形态（项目弹出列表行）。
 * 两处都在下拉**打开时**才渲染，故运行时全站首屏扫描看不见——正是本组静态扫描的价值所在。
 * B-03 会钉住「清单必须与实际命中逐文件相等」：修好了不同步删条目，门同样判红。
 * T02146 已把两处行容器改为 `div role="button"` 并同步清空清单（口径 3）。
 */
const REGISTERED: Record<string, number> = {};
const found = Object.fromEntries([...byFile.entries()].sort());
const expected = Object.fromEntries(Object.entries(REGISTERED).sort());
const unregistered = [...byFile.entries()].filter(([f]) => !(f in REGISTERED));
ok('B-01 除登记清单外，全仓无「同文件 button 套 button」新增违规', unregistered.length === 0, unregistered);
ok('B-02 ReportPage 自身 0 命中（A 组改动的直接后果，单独点名便于失败定位）',
  !byFile.has(join('web/src/pages/ReportPage.tsx').replace(/\\/g, '/')), [...byFile.keys()]);
ok('B-03 登记清单与实际命中逐文件相等（清单只能缩短，不能过期失真）',
  JSON.stringify(found) === JSON.stringify(expected), { 实际: found, 登记: expected });
ok('B-04 扫描器自证：两类已知误报形态不误报（属性里的 `=>` 与 `>`、注释里的 `<button>` 示例）',
  (() => {
    const arrow = scanNested(stripComments(
      `<button onClick={() => (x > 1 ? 1 : 0)}\n  aria-label="a">x</button>`));
    const commented = scanNested(stripComments(
      `{/* 真实 <button>（键盘 Tab 可达）说明 */}\n<button>a</button>`));
    return arrow.hits === 0 && arrow.depth === 0 && commented.hits === 0 && commented.depth === 0;
  })());
ok('B-05 扫描器自证：真嵌套形态必须命中（守卫不是永远绿的摆设）',
  scanNested(`<button aria-label="card"><span><button aria-label="corner">x</button></span></button>`).hits === 1);
ok('B-06 全仓无「标签深度收不住」的文件（切分错位会让 B-01 假绿，必须先自证）',
  unbalanced === 0, { unbalanced });
// T02146：B 组原只对「同文件 button 套 button」有效，跨文件组件（PinToggle 自身是 button）天生失明——
// 提示词/通用需求两处 47+3 例就是这么漏掉的，故把组件点名进同一扫描器。
ok('B-07 组件 `<PinToggle` 不出现在任何 button 内部（跨文件同根因，运行时才可见的那一族）',
  compByFile.size === 0, [...compByFile.entries()]);
ok('B-08 扫描器自证：button 内的 `<PinToggle/>` 必须命中（B-07 不是永远绿的摆设）',
  scanNested('<button className="row-title-btn"><PinToggle pinned={false} onToggle={() => {}} /></button>',
    IN_BUTTON_COMPONENTS).componentHits === 1 &&
  scanNested('<div role="button"><PinToggle pinned onToggle={f} /></div>',
    IN_BUTTON_COMPONENTS).componentHits === 0);

const summary = `T02143 卡片 DOM 嵌套门：PASS ${pass} / FAIL ${fail}\n` + lines.join('\n');
writeGateResults(join(ROOT, '.workbuddy'), 't02143-gate-results.txt', summary);
console.log(summary);
process.exit(fail === 0 ? 0 : 1);
