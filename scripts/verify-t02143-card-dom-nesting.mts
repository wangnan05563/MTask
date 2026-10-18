/**
 * T02143 门（派生自 T02107：ReportCard 容器被改回原生 button → 卡片内嵌套按钮非法 DOM）。
 *
 * 本门守的三件事没变：
 *   ① 容器形态：带交互子元素（角标动作/重置）的卡片容器不得是原生 `<button>`；
 *   ② 键盘语义：容器键盘激活只认自身焦点（`e.target !== e.currentTarget` 早退），
 *      角标的 Enter/Space 冒泡不得顺带收起卡片；
 *   ③ 观感不回退：容器是 div 后不再命中全局 `button:hover/:active`，`.card-btn` 必须自带那三条手感。
 *
 * T02293 改判（`docs/验收门判据规约.md` 判据 1/3/4）——**断言对象从源码文本换成渲染产物**：
 *
 *  渲染通道（本机能用的最便宜通道是 (a)：仓库自带的 React 18 + `react-dom/server`；
 *  node_modules 里没有 jsdom/happy-dom/Playwright，也不允许装，故不引浏览器依赖）：
 *   - **结构类判据**：把**真实产品组件**（`web/src/pages/ReportPage.tsx` 的私有 `ReportCard`、
 *     `web/src/ui/PinToggle.tsx`）用 `react-dom/server.renderToStaticMarkup` 渲染成 HTML 产物，
 *     再用门内的 HTML 解析器 + 「交互元素嵌套判据」在**产物**上量嵌套关系、role/tabindex/class；
 *   - **行为类判据**：用门内最小 hooks 调度器（useState/useRef/useEffect/useMemo/useCallback/
 *     useSyncExternalStore 的 React 语义最小子集）**调用真实组件函数**拿到它自己产出的 React 元素树，
 *     再从树上取出真实的 `onKeyDown` / 角标 `onClick`，用合成事件**真的按一遍**，
 *     看回调有没有被触发——「角标冒泡不收起卡片」由「调用冒泡事件后 onToggle 计数不变」判定，
 *     而不是「源码里有没有 `e.target !== e.currentTarget`」；
 *   - **样式类判据**：从真实 `Shell` 渲染出来的 `<style>` 元素里取它**注入的样式表文本**（产物），
 *     按规则解析成「选择器 → 声明」，再用门内的简单选择器匹配器去匹配**渲染出来的卡片元素**，
 *     要求「命中该元素的规则里确有 transition / hover 倾斜 / active 缩放」三条，
 *     并同时要求「全局 `button{}` 规则匹配不到这个 div 卡片」——这正是当初要补 `.card-btn` 的原因。
 *
 *  取产物的唯一源码耦合：`ReportCard`/`Shell` 是模块私有组件，门用 esbuild 的 onLoad 钩子
 *  在**编译期**给源文件尾巴追加 `export { X as __gate_X }`（产物落在 `.workbuddy/` 的本轮临时子目录，
 *  跑完即删，产品工作树零写入）。追加失败＝组件改名/挪走 ⇒ 本门如实判红（红因「真实组件取不到」），
 *  不会静默放行（规约反模式 12「变体没打上就亮红」）。
 *
 *  保留的静态红线（判据 3 的字面侧，一律走 `okPair`，行为侧失守则该条必红）：
 *  B 组「全仓 tsx 同文件 button 套 button」扫描。它本质是对**全部**页面做结构扫描，
 *  而页面组件需要真实 DOM/浏览器才能渲染（本机无 jsdom/Playwright），故按规约把它降级为
 *  「只在行为断言通过时才算绿」的字面锚点，行为侧换成真实卡片 + 真实 PinToggle 组合的渲染产物判据。
 *
 *  负对照（判据 4）：N 组在内存里造出四种破坏形态（容器改回 button、去掉 target 早退、
 *  角标不 stopPropagation、样式表缺那三条），要求**同一套判据**逐一判红，并配对要求真实产物判绿。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02143-card-dom-nesting.mts
 * 结果落 .workbuddy/t02143-gate-results-<运行标识>.txt（渲染中间产物落同目录的本轮子目录并在结束时删除）。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'web', 'src');
const RUN_ID = `t02143-${process.pid}-${Date.now()}`;
const SCRATCH = join(ROOT, '.workbuddy', RUN_ID);

let pass = 0;
let fail = 0;
let skippedCount = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};
/** 环境真取不出产物时如实留痕，不冒充 PASS（规约判据 2） */
const skipped = (name: string, why: string) => {
  skippedCount += 1;
  lines.push(`[SKIP] ${name}（${why}）——不计 PASS`);
};
/** 负对照专用：无论红绿都把量到的数字落进结果，判据 4 要求「同一量具确实会翻脸」可复核 */
const okN = (name: string, cond: boolean, extra?: unknown) => {
  ok(name, cond, extra);
  lines.push(`[EVID] ${JSON.stringify(extra ?? {})}`.slice(0, 340));
};

// =====================================================================
// 0) 渲染环境：给真实 web 组件一个最小可跑的 Node 宿主（只补被真实读到的字段）
// =====================================================================
mkdirSync(SCRATCH, { recursive: true });
const g = globalThis as any;
// api/client.ts 顶层从 document.baseURI 推 apiBase（内网穿透前缀修复），与 lib/web-dom-shim.mts 同口径
g.document ??= { baseURI: 'http://127.0.0.1:39901/', body: { nodeType: 1, appendChild() {} }, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: () => ({ nodeType: 1, style: {} }) };
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.window ??= { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1280, innerHeight: 800 };
// 卡片重置走 askConfirm → createRoot，本机无真 DOM 时它会 reject；本门只断言同步可观测的部分，
// 该 rejection 由下面的 sink 记账（不吞掉，打进证据）
const asyncErrors: string[] = [];
const rejectSink = (e: unknown) => asyncErrors.push(String((e as any)?.message ?? e).slice(0, 120));
process.on('unhandledRejection', rejectSink);

const React = (await import('react')).default as any;
const { renderToStaticMarkup } = await import('react-dom/server');
const esbuild = (await import('esbuild')).default as any;

/** 编译真实产品模块并把模块私有组件暴露出来（只在编译期追加导出，产品文件不动） */
async function buildProduct(productFile: string, expose: string[], tag: string): Promise<Record<string, any>> {
  const outfile = join(SCRATCH, `${tag}.mjs`);
  await esbuild.build({
    absWorkingDir: ROOT, entryPoints: [productFile], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', jsx: 'automatic', outfile, logLevel: 'silent',
    plugins: [{
      name: 'expose-private-component',
      setup(b: any) {
        b.onResolve({ filter: /.*/ }, (a: any) => (
          !a.path.startsWith('.') && !/^([a-zA-Z]:[\\/]|[\\/])/.test(a.path) && !a.path.startsWith('api:')
            ? { path: a.path, external: true } : undefined));
        b.onLoad({ filter: new RegExp(productFile.replace(/[\\\/]/g, '[\\\\/]') + '$') }, (a: any) => ({
          loader: 'tsx' as const,
          contents: readFileSync(a.path, 'utf8') + '\n' + expose.map((n) => `export { ${n} as __gate_${n} };`).join('\n') + '\n',
        }));
      },
    }],
  });
  const mod = await import(pathToFileURL(outfile).href);
  // 两条腿都在场才算拿到了真实组件：追加的导出若指向不存在的名字，esbuild 只给 warning（会被静默放行），
  // 这里显式要求取到——组件改名/挪走时本门如实判红，不静默变绿（规约反模式 12）
  for (const n of expose) {
    if (mod[`__gate_${n}`] === undefined) throw new Error(`产品里取不到私有组件 ${n}（改名或挪走了 → 本门失明）`);
  }
  return mod;
}

/** 最小 hooks 调度器：跑真实组件函数体拿它自己产出的 React 元素树（handler/effect 都取真的） */
function mount(Comp: any, props: any) {
  const hooks: any[] = [];
  let idx = 0;
  const eff: Array<() => any> = [];
  const depKey = (deps: any) => JSON.stringify(deps ?? null);
  const dispatcher: any = {
    useState: (init: any) => {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [hooks[i], (v: any) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
    },
    useReducer: (red: any, init: any) => { const i = idx++; if (!(i in hooks)) hooks[i] = init; return [hooks[i], (a: any) => { hooks[i] = red(hooks[i], a); }]; },
    useRef: (init: any) => { const i = idx++; if (!(i in hooks)) hooks[i] = { current: init === undefined ? null : init }; return hooks[i]; },
    useEffect: (fn: any, deps: any) => {
      const i = idx++;
      const h = (hooks[i] ??= { dep: undefined as unknown });
      if (h.dep === undefined || depKey(h.dep) !== depKey(deps)) { h.dep = deps; eff.push(fn); }
    },
    useLayoutEffect: (fn: any, deps: any) => dispatcher.useEffect(fn, deps),
    useMemo: (fn: any) => fn(),
    useCallback: (fn: any) => fn,
    useSyncExternalStore: (_sub: any, get: any) => get(),
    useContext: (ctx: any) => ctx?._currentValue,
    useId: () => 'gate-id', useDebugValue: () => {}, useTransition: () => [false, (f: any) => f()],
    useDeferredValue: (v: any) => v, useImperativeHandle: () => {}, useInsertionEffect: () => {},
  };
  const render = (p: any = props) => {
    idx = 0;
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher;
    try { return Comp(p); } finally { React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = null; }
  };
  return { render, runEffects: () => eff.splice(0).forEach((f) => { try { f(); } catch (e) { asyncErrors.push(`effect:${String((e as any)?.message ?? e).slice(0, 80)}`); } }), hooks };
}

/** 走 React 元素树（children / portal 两种挂载点都认） */
function walkEl(node: any, visit: (el: any) => void): void {
  if (Array.isArray(node)) { node.forEach((n) => walkEl(n, visit)); return; }
  if (!node || typeof node !== 'object' || node.$$typeof === undefined) return;
  visit(node);
  walkEl((node as any).children ?? node.props?.children, visit);
}

// =====================================================================
// 1) 产物判据料：HTML 解析 + 交互嵌套判据 + 简单 CSS 选择器匹配
// =====================================================================
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
interface HNode { tag: string; attrs: Record<string, string>; children: HNode[]; text: string; }
/** 把渲染出来的 HTML 串解析成节点树（认引号内的 >、自闭合、void 标签、style 原始文本） */
function parseHtml(src: string): HNode[] {
  const root: HNode[] = [];
  const stack: HNode[] = [];
  const push = (n: HNode) => (stack.length ? stack[stack.length - 1].children.push(n) : root.push(n));
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') { const t = /[^<]*/.exec(src.slice(i))![0]; i += t.length; if (t.trim() && stack.length) stack[stack.length - 1].text += t; continue; }
    if (src.startsWith('</', i)) { const gt = src.indexOf('>', i); const tag = src.slice(i + 2, gt).trim(); i = gt + 1; for (let k = stack.length - 1; k >= 0; k--) if (stack[k].tag === tag) { stack.length = k; break; } continue; }
    let j = i + 1; let q = '';
    while (j < src.length) { const c = src[j]; if (q) { if (c === '\\') j += 1; else if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; j += 1; }
    const raw = src.slice(i + 1, j); i = j + 1;
    if (raw.startsWith('!')) continue;
    const selfClosed = raw.endsWith('/');
    const body = selfClosed ? raw.slice(0, -1).trim() : raw.trim();
    const tag = (/^[\w:-]+/.exec(body)?.[0] ?? '').toLowerCase();
    if (!tag) continue;
    const attrs: Record<string, string> = {};
    for (const m of body.slice(tag.length).matchAll(/([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[m[1].toLowerCase()] = (m[3] ?? m[4] ?? m[5] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }
    const node: HNode = { tag, attrs, children: [], text: '' };
    push(node);
    if (selfClosed || VOID_TAGS.has(tag)) continue;
    if (tag === 'style' || tag === 'script') { // 原始文本元素：内容直到闭合标签，不当标签解析
      const close = `</${tag}>`; const end = src.indexOf(close, i);
      node.text = src.slice(i, end < 0 ? src.length : end); i = end < 0 ? src.length : end + close.length; continue;
    }
    stack.push(node);
  }
  return root;
}
/** HTML 规范里的「交互内容」：原生 button/a[href]/input/select/textarea（div role=button 不在此列——卡片正是靠这个形态合规的） */
const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const isInteractive = (n: HNode) => INTERACTIVE_TAGS.has(n.tag) || (n.tag === 'a' && 'href' in n.attrs);
/** 核心判据：渲染产物里「交互元素套在另一个交互元素内部」的清单 */
function interactiveNesting(nodes: HNode[]): Array<{ 外层: string; 内层: string; 内层标签: string }> {
  const hits: Array<{ 外层: string; 内层: string; 内层标签: string }> = [];
  const dive = (list: HNode[], chain: HNode[]) => {
    for (const n of list) {
      if (isInteractive(n)) {
        const host = chain[chain.length - 1];
        if (host) hits.push({ 外层: `${host.tag}${host.attrs['aria-label'] ? `[${host.attrs['aria-label']}]` : ''}`, 内层: `${n.tag}${n.attrs['aria-label'] ? `[${n.attrs['aria-label']}]` : ''}`, 内层标签: n.tag });
      }
      dive(n.children, isInteractive(n) ? [...chain, n] : chain);
    }
  };
  dive(nodes, []);
  return hits;
}
/** 产物里的后代查询：给定根，找满足谓词的元素（不打源码文本） */
function findInHtml(nodes: HNode[], pred: (n: HNode) => boolean): HNode[] {
  const out: HNode[] = [];
  const dive = (list: HNode[]) => { for (const n of list) { if (pred(n)) out.push(n); dive(n.children); } };
  dive(nodes);
  return out;
}
/** 样式表产物解析：注释剥掉，按大括号配对切成「选择器 → 声明」，@media/@keyframes 只取其中的规则 */
function parseCss(css: string): Array<{ selector: string; decls: Record<string, string> }> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<{ selector: string; decls: Record<string, string> }> = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i); if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1; let j = open + 1;
    while (j < src.length && depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    const block = src.slice(open + 1, j - 1);
    if (head.startsWith('@keyframes')) { /* 帧选择器（from/50%/to）不是元素选择器，不参与匹配 */ }
    else if (head.startsWith('@')) { for (const inner of parseCss(block)) rules.push(inner); }
    else {
      const decls: Record<string, string> = {};
      for (const d of block.split(';')) { const k = d.indexOf(':'); if (k > 0) decls[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim(); }
      head.split(',').map((s) => s.trim()).filter(Boolean).forEach((selector) => rules.push({ selector, decls }));
    }
    i = j;
  }
  return rules;
}
/** 简单选择器匹配（tag / .class / :pseudo）——只认「末段复合选择器 + 无后代关系」，卡片类判据够用且不会误配 */
function selectorMatches(sel: string, el: HNode): { base: boolean; pseudo: string } | null {
  const parts = sel.trim().split(/\s+/); if (parts.length !== 1) return null; // 后代/子选择器不在本判据范围
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?::[\w-]+(?:\([^)]*\))?)*)$/.exec(parts[0]);
  if (!m) return null;
  const [, tag, classes, pseudos] = m;
  if (tag && tag.toLowerCase() !== el.tag) return null;
  const own = (el.attrs['class'] ?? '').split(/\s+/).filter(Boolean);
  for (const c of (classes ?? '').split('.').filter(Boolean)) if (!own.includes(c)) return null;
  return { base: true, pseudo: (pseudos ?? '').toLowerCase() };
}
const rulesFor = (css: string, el: HNode, pseudo: '' | ':hover' | ':active') =>
  parseCss(css).filter((r) => { const m = selectorMatches(r.selector, el); return !!m && m.pseudo === pseudo; });

// =====================================================================
// 2) 门内夹具（自建 props，不读生产数据）
// =====================================================================
const FIX = { title: '门内夹具卡片', aria: '门内夹具卡片', hint: '门内提示', desc: '门内描述' };
/** 卡片 props：带 action 角标 + onReset，正是「容器里有交互子元素」那一形态 */
function cardProps(spy: { toggles: number; resets: number }) {
  return {
    icon: React.createElement('svg', { 'data-gate': 'icon' }),
    title: FIX.title, desc: FIX.desc, hint: FIX.hint, aria: FIX.aria,
    open: false, glow: false,
    onToggle: () => { spy.toggles += 1; },
    action: React.createElement('button', { 'aria-label': '门内动作角标' }, '动作'),
    onReset: () => { spy.resets += 1; },
  } as any;
}
const keyEv = (key: string, target: unknown, currentTarget: unknown) => {
  let prevented = 0;
  return { key, target, currentTarget, preventDefault: () => { prevented += 1; }, get prevented() { return prevented; } };
};

// =====================================================================
// R 组：真实卡片渲染产物（结构 + 键盘 + 角标 + 样式）
// =====================================================================
lines.push('== R 组：真实 ReportCard 的渲染产物（react-dom/server + 门内元素树）');
let cardHtml = '';
let cardTree: any = null;
let shellCss = '';
let ReportCardRef: any = null;
try {
  const RP = await buildProduct(join(WEB_SRC, 'pages', 'ReportPage.tsx'), ['ReportCard'], 'reportpage');
  const ReportCard = RP.__gate_ReportCard;
  ReportCardRef = ReportCard;
  ok('R-01 真实 ReportCard 组件可从产品模块取出（改名/挪走即失明，此处如实判红）', typeof ReportCard === 'function', { got: typeof ReportCard });

  const spy = { toggles: 0, resets: 0 };
  cardHtml = renderToStaticMarkup(React.createElement(ReportCard, cardProps(spy)));
  const nodes = parseHtml(cardHtml);
  const container = nodes[0];
  ok('R-02 渲染产物容器不是原生交互元素（HTML 层面没有 button 外壳）',
    !!container && !isInteractive(container), { 外层标签: container?.tag, 产物头部: cardHtml.slice(0, 160) });
  ok('R-03 产物容器带 role=button + tabindex=0（键盘可达，保住 fdc6090 的原目标）',
    container?.attrs['role'] === 'button' && container?.attrs['tabindex'] === '0',
    { role: container?.attrs['role'], tabindex: container?.attrs['tabindex'] });
  ok('R-04 产物容器带 aria-label（读屏拿到的是卡片名，不是一串描述）',
    container?.attrs['aria-label'] === FIX.aria, { aria: container?.attrs['aria-label'] });
  const nested = interactiveNesting(nodes);
  const innerButtons = findInHtml(nodes, (n) => n.tag === 'button');
  ok('R-05 产物里确有交互后代（本组判据的前提：容器里真的嵌着角标按钮）',
    innerButtons.length >= 2, { 按钮数: innerButtons.length, 清单: innerButtons.map((b) => b.attrs['aria-label'] ?? '(无名)') });
  ok('R-06 渲染产物零「交互套交互」违规（历史缺陷的正面判据：产物不出现非法 DOM）',
    nested.length === 0, nested);
  ok('R-07 角标重置保持原生 <button>（合法性靠容器不是按钮，不靠把角标降级成 span）',
    innerButtons.some((b) => (b.attrs['aria-label'] ?? '').includes(FIX.title) && (b.attrs['title'] ?? '').length > 0),
    innerButtons.map((b) => b.attrs['aria-label']));
  ok('R-08 产物容器类名被样式表命中（观感规则的落点在产物上，不在源码里）',
    (container?.attrs['class'] ?? '').split(/\s+/).some((c) => /^card-btn$/.test(c)), { class: container?.attrs['class'] });

  // ---- 键盘语义：真的把 handler 按一遍 ----
  cardTree = mount(ReportCard, cardProps(spy)).render();
  const kd = cardTree.props.onKeyDown;
  const self = { gateSelf: true };
  const before = spy.toggles;
  const evEnter = keyEv('Enter', self, self);
  kd(evEnter);
  ok('R-09 容器自身按 Enter → 卡片激活（onToggle 计数 +1）', spy.toggles === before + 1, { before, after: spy.toggles });
  const evSpace = keyEv(' ', self, self);
  kd(evSpace);
  ok('R-10 容器自身按 Space → 同样激活（Enter/Space 两条键盘通路都在）', spy.toggles === before + 2, { after: spy.toggles });
  const before2 = spy.toggles;
  kd(keyEv('Enter', { gateChild: true }, self));
  ok('R-11 角标冒泡上来的 Enter 不触发容器激活（T02143 实测踩到的那条：弹确认框同时收起卡片）',
    spy.toggles === before2, { before: before2, after: spy.toggles });
  const before3 = spy.toggles;
  kd(keyEv('Tab', self, self));
  kd(keyEv('a', self, self));
  ok('R-12 非激活键（Tab/字符键）不触发容器激活', spy.toggles === before3, { before: before3, after: spy.toggles });
  ok('R-13 激活那两次确实 preventDefault（浏览器默认滚动/重复提交被吃掉）',
    evEnter.prevented === 1 && evSpace.prevented === 1, { enter: evEnter.prevented, space: evSpace.prevented });

  // ---- 角标鼠标通路 ----
  let corner: any = null;
  walkEl(cardTree, (el) => { if (el.type === 'button' && String(el.props?.['aria-label'] ?? '').includes(FIX.title)) corner = el; });
  ok('R-14 元素树上取到真实角标按钮的 onClick（判据对象是产物里的处理器，不是源码字符串）',
    !!corner && typeof corner.props.onClick === 'function', { found: !!corner });
  if (corner) {
    let stopped = 0;
    const before4 = spy.toggles;
    corner.props.onClick({ stopPropagation: () => { stopped += 1; }, preventDefault: () => {} });
    ok('R-15 角标点击调用 stopPropagation（鼠标通路不冒泡到容器）', stopped === 1, { stopped });
    ok('R-16 角标点击不直接执行容器 onToggle，也不绕过二次确认直接重置',
      spy.toggles === before4 && spy.resets === 0, { toggles: spy.toggles, resets: spy.resets });
    const containerClick = cardTree.props.onClick;
    ok('R-17 容器 onClick 就是展开回调（说明 stopPropagation 是有牙的必需项，不是装饰）',
      typeof containerClick === 'function' && (() => { const b = spy.toggles; containerClick(); return spy.toggles === b + 1; })(),
      { 类型: typeof containerClick });
  } else {
    skipped('R-15/R-16/R-17 角标鼠标通路', '渲染元素树里没找到原生 button 角标（形态变了，判据无从下手）');
  }

  // ---- 样式表产物：从真实 Shell 渲染出的 <style> 里取注入的 CSS ----
  const APP = await buildProduct(join(WEB_SRC, 'App.tsx'), ['Shell'], 'app');
  const shellTree = mount(APP.__gate_Shell, {}).render();
  shellCss = '';
  walkEl(shellTree, (el) => { if (el.type === 'style') shellCss += String(el.props?.children ?? ''); });
  ok('R-18 真实 Shell 渲染出注入样式表（CSS 判据的产物来源）', shellCss.length > 500, { 长度: shellCss.length });
  const cardEl = parseHtml(renderToStaticMarkup(React.createElement(ReportCard, cardProps(spy))))[0];
  const tRules = rulesFor(shellCss, cardEl, '');
  ok('R-19 命中卡片元素的规则里确有 transition（div 不命中全局 button 规则，手感必须自带）',
    tRules.some((r) => /transform/.test(r.decls['transition'] ?? '')), { 命中选择器: tRules.map((r) => r.selector) });
  ok('R-20 hover 倾斜与 active 缩放两条都在（对齐全局 button 基准）',
    rulesFor(shellCss, cardEl, ':hover').some((r) => /rotate\(/.test(r.decls['transform'] ?? ''))
    && rulesFor(shellCss, cardEl, ':active').some((r) => /scale\(/.test(r.decls['transform'] ?? '')),
    { hover: rulesFor(shellCss, cardEl, ':hover').map((r) => r.decls['transform']), active: rulesFor(shellCss, cardEl, ':active').map((r) => r.decls['transform']) });
  const globalButtonRules = parseCss(shellCss).filter((r) => /^button(?![-.\w])/.test(r.selector) && !r.selector.includes(':hover'));
  const globalMatchesCard = globalButtonRules.filter((r) => selectorMatches(r.selector, cardEl));
  ok('R-21 全局 `button{}` 规则匹配不到这个 div 卡片（正是必须补 .card-btn 的原因，判据打在产物匹配关系上）',
    globalButtonRules.length > 0 && globalMatchesCard.length === 0, { 全局规则数: globalButtonRules.length });
  const cornerEl = findInHtml(parseHtml(cardHtml), (n) => n.tag === 'button')[0];
  ok('R-22 同一套匹配器对原生角标 button 判「命中全局规则」（匹配器不是恒不命中的摆设）',
    !!cornerEl && globalButtonRules.filter((r) => selectorMatches(r.selector, cornerEl!)).length > 0,
    { 角标标签: cornerEl?.tag });
} catch (e) {
  const msg = String((e as Error)?.message ?? e).slice(0, 300);
  ok('R-00 真实组件渲染通道可用（esbuild/react-dom-server 取产物）', false, { 红因: `取不到渲染产物：${msg}` });
  skipped('R 组其余条目', '渲染产物不可得');
}

// =====================================================================
// C 组：跨文件形态——真实 PinToggle 组合进渲染产物
// =====================================================================
lines.push('== C 组：真实 PinToggle 的组合产物（原 B-07 静态扫不到的那一族）');
let pinIsButton = false;
let pinInButtonViolations: number = -1;
let pinInCardViolations: number = -1;
try {
  const PT = await buildProduct(join(WEB_SRC, 'ui', 'PinToggle.tsx'), ['PinToggle'], 'pintoggle');
  const PinToggle = PT.__gate_PinToggle ?? PT.PinToggle;
  const pinHtml = renderToStaticMarkup(React.createElement(PinToggle, { pinned: true, onToggle: () => {} } as any));
  const pinNodes = parseHtml(pinHtml);
  pinIsButton = findInHtml(pinNodes, (n) => n.tag === 'button').length === 1;
  ok('C-01 真实 PinToggle 渲染出来就是一个原生 <button>（它进任何交互容器都必然非法，与原运行时缺陷同源）',
    pinIsButton, { 产物: pinHtml.slice(0, 120) });

  // 把真实 PinToggle 放进原生 button 里渲染 → 产物必须被同一判据认出
  const Bad = () => React.createElement('button', { 'aria-label': '门内标题按钮' },
    React.createElement('span', null, React.createElement(PinToggle, { pinned: false, onToggle: () => {} })));
  pinInButtonViolations = interactiveNesting(parseHtml(renderToStaticMarkup(React.createElement(Bad)))).length;
  ok('C-02 真实 PinToggle 组合进 button 后渲染产物有违规（跨文件形态在产物层可见，无需靠组件名单）',
    pinInButtonViolations === 1, { 命中: pinInButtonViolations });

  // 同一组件放进真实卡片（div role=button）→ 产物无违规
  if (cardTree) {
    const html = renderToStaticMarkup(React.createElement(ReportCardRef,
      { ...cardProps({ toggles: 0, resets: 0 }), action: React.createElement(PinToggle, { pinned: false, onToggle: () => {} }) } as any));
    pinInCardViolations = interactiveNesting(parseHtml(html)).length;
    ok('C-03 真实 PinToggle 落进真实卡片容器（div role=button）后产物零违规（修法方向正确）',
      pinInCardViolations === 0, { 命中: pinInCardViolations, 头部: html.slice(0, 120) });
  } else {
    skipped('C-03 PinToggle 落进真实卡片', '真实卡片元素树不可得');
  }
} catch (e) {
  ok('C-00 真实 PinToggle 渲染通道可用', false, { 红因: String((e as Error)?.message ?? e).slice(0, 200) });
}

// =====================================================================
// B 组：全仓静态结构红线（保留，但一律 okPair——行为侧失守则该条必红）
// =====================================================================
lines.push('== B 组：全仓 tsx「同文件 button 套 button」静态扫描（字面侧，配渲染产物行为侧）');
function stripComments(src: string): string {
  let out = ''; let i = 0; let str: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (str) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === str) str = null;
      i += 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; out += c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    out += c; i += 1;
  }
  return out;
}
function tagEnd(src: string, open: number): { end: number; selfClosing: boolean } {
  let i = open + 1; let brace = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const q = c; i += 1; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; } i += 1; continue; }
    if (c === '{') { brace += 1; i += 1; continue; }
    if (c === '}') { brace -= 1; i += 1; continue; }
    if (c === '>' && brace === 0) return { end: i + 1, selfClosing: src[i - 1] === '/' };
    i += 1;
  }
  return { end: i, selfClosing: false };
}
function scanNested(src: string, inButtonComponents: string[] = []): { hits: number; componentHits: number; depth: number } {
  let depth = 0; let i = 0; let hits = 0; let componentHits = 0;
  while (i < src.length) {
    if (src[i] !== '<') { i += 1; continue; }
    if (src.startsWith('</', i)) {
      const isButton = /^<\/button\b/.test(src.slice(i));
      const { end } = tagEnd(src, i);
      if (isButton) depth = Math.max(0, depth - 1);
      i = end; continue;
    }
    const comp = inButtonComponents.find((c) => src.startsWith(`<${c}`, i) && !/^<\/|[\w]/.test(src[i + 1 + c.length] ?? ' '));
    if (comp) { const { end } = tagEnd(src, i); if (depth > 0) componentHits += 1; i = end; continue; }
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
    if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.tsx')) files.push(p);
  }
})(WEB_SRC);
const byFile = new Map<string, number>();
const compByFile = new Map<string, number>();
let unbalanced = 0;
const IN_BUTTON_COMPONENTS = ['PinToggle'];
for (const f of files) {
  const { hits, componentHits, depth } = scanNested(stripComments(readFileSync(f, 'utf8')), IN_BUTTON_COMPONENTS);
  if (depth !== 0) unbalanced += 1;
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  if (hits > 0) byFile.set(rel, hits);
  if (componentHits > 0) compByFile.set(rel, componentHits);
}
const REGISTERED: Record<string, number> = {};
const foundLedger = Object.fromEntries([...byFile.entries()].sort());
const expectedLedger = Object.fromEntries(Object.entries(REGISTERED).sort());
const unregistered = [...byFile.entries()].filter(([f]) => !(f in REGISTERED));
/** 行为侧公共料：真实卡片产物 + 真实 PinToggle 组合产物的渲染层结论 */
const renderNestingOk = () => cardHtml.length > 0
  && interactiveNesting(parseHtml(cardHtml)).length === 0
  && pinIsButton && pinInButtonViolations === 1 && pinInCardViolations === 0;

okPair(ok, 'B-01 除登记清单外全仓无「同文件 button 套 button」新增违规（静态红线；行为侧＝渲染产物判据在真实卡片与两种 PinToggle 组合上结论全对）',
  renderNestingOk,
  () => unregistered.length === 0,
  () => ({ 未登记命中: unregistered, 产物违规: interactiveNesting(parseHtml(cardHtml || '<div/>')).length, 组合命中: [pinInButtonViolations, pinInCardViolations] }));
okPair(ok, 'B-02 报表页卡片自身零命中（A/R 组改动的直接后果，单独点名便于失败定位）',
  () => cardHtml.length > 0 && interactiveNesting(parseHtml(cardHtml)).length === 0,
  () => !byFile.has('web/src/pages/ReportPage.tsx'),
  () => ({ 命中文件: [...byFile.keys()] }));
ok('B-03 登记清单与实际命中逐文件相等（清单只能缩短，不能过期失真）',
  JSON.stringify(foundLedger) === JSON.stringify(expectedLedger), { 实际: foundLedger, 登记: expectedLedger });
ok('B-04 扫描器自证：两类已知误报形态不误报（属性里的 `=>` 与 `>`、注释里的 `<button>` 示例）',
  (() => {
    const arrow = scanNested(stripComments(`<button onClick={() => (x > 1 ? 1 : 0)}\n  aria-label="a">x</button>`));
    const commented = scanNested(stripComments(`{/* 真实 <button>（键盘 Tab 可达）说明 */}\n<button>a</button>`));
    return arrow.hits === 0 && arrow.depth === 0 && commented.hits === 0 && commented.depth === 0;
  })());
ok('B-05 扫描器自证：真嵌套形态必须命中（守卫不是永远绿的摆设）',
  scanNested(`<button aria-label="card"><span><button aria-label="corner">x</button></span></button>`).hits === 1);
ok('B-06 全仓无「标签深度收不住」的文件（切分错位会让 B-01 假绿，必须先自证）',
  unbalanced === 0, { unbalanced });
okPair(ok, 'B-07 组件 `<PinToggle` 不出现在任何 button 内部（跨文件同根因；行为侧＝真实 PinToggle 的组合渲染产物）',
  () => pinIsButton && pinInButtonViolations === 1 && pinInCardViolations === 0,
  () => compByFile.size === 0,
  () => ({ 静态命中: [...compByFile.entries()], 组合命中: [pinInButtonViolations, pinInCardViolations] }));
ok('B-08 扫描器自证：button 内的 `<PinToggle/>` 必须命中（B-07 不是永远绿的摆设）',
  scanNested('<button className="row-title-btn"><PinToggle pinned={false} onToggle={() => {}} /></button>', IN_BUTTON_COMPONENTS).componentHits === 1
  && scanNested('<div role="button"><PinToggle pinned onToggle={f} /></div>', IN_BUTTON_COMPONENTS).componentHits === 0);
ok('B-09 渲染产物判据与静态扫描器口径一致：同一份「button 套 button」两种通道都认得出（防止两套判据互相掩盖）',
  (() => {
    const brokenHtml = renderToStaticMarkup(React.createElement('button', { 'aria-label': 'x' }, React.createElement('span', null, React.createElement('button', null, 'y'))));
    const src = '<button aria-label="x"><span><button>y</button></span></button>';
    return interactiveNesting(parseHtml(brokenHtml)).length === 1 && scanNested(src).hits === 1;
  })());

// =====================================================================
// N 组：负对照（判据 4）——同一套判据必须在内存造出的破坏形态上变红
// =====================================================================
lines.push('== N 组：负对照（破坏形态在内存里现造，同一判据必须判红）');
{
  // N-01 容器改回原生 button（历史缺陷 fdc6090 的那次回退）
  const BrokenContainer = () => React.createElement('button', { 'aria-label': FIX.aria, className: 'card-btn ln' },
    React.createElement('span', null, '正文'),
    React.createElement('button', { 'aria-label': '门内角标' }, '角标'));
  const brokenHits = interactiveNesting(parseHtml(renderToStaticMarkup(React.createElement(BrokenContainer))));
  const goodHits = cardHtml ? interactiveNesting(parseHtml(cardHtml)) : [{ x: '产物不可得' } as any];
  okN('N-01 负对照：容器改回原生 button 的夹具被同一判据认出违规（真实卡片同判据为绿）',
    brokenHits.length === 1 && /button\[门内角标\]/.test(brokenHits[0].内层) && goodHits.length === 0,
    { 夹具命中: brokenHits, 真实命中: goodHits.length });

  // N-02 键盘 handler 去掉 target 早退（等价重构最容易顺手丢掉的一条）
  let fired = 0;
  const noGuardKeyDown = (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fired += 1; } };
  const self = { s: 1 };
  noGuardKeyDown(keyEv('Enter', { c: 2 }, self)); // 夹具：子元素冒泡上来的 Enter 也照样激活
  const realNoFire = (() => {
    if (!ReportCardRef) return null;
    const spy = { toggles: 0, resets: 0 };
    const t = mount(ReportCardRef, cardProps(spy)).render();
    t.props.onKeyDown(keyEv('Enter', { c: 2 }, self)); // 同一场景打在真实卡片上
    return spy.toggles === 0;
  })();
  okN('N-02 负对照：没有 target 早退的夹具 handler 一冒泡就激活；真实卡片同场景不激活 ⇒ 判据有牙',
    fired === 1 && realNoFire === true, { 夹具触发: fired, 真实卡片不触发: realNoFire });

  // N-03 角标不 stopPropagation：坏夹具与真实角标过同一个「事件有没有被阻止冒泡」量具
  const mkClickEvent = () => { const box = { stopped: 0 }; return { box, ev: { stopPropagation: () => { box.stopped += 1; }, preventDefault: () => {} } }; };
  const badCorner = (_e: any) => { /* 坏写法：直接执行动作，不阻止冒泡 ⇒ 容器会顺带收起卡片 */ };
  const e1 = mkClickEvent(); badCorner(e1.ev);
  const realCorner: any = (() => { if (!cardTree) return null; let c: any = null; walkEl(cardTree, (el) => { if (el.type === 'button' && String(el.props?.['aria-label'] ?? '').includes(FIX.title)) c = el; }); return c; })();
  const e2 = mkClickEvent(); if (realCorner) realCorner.props.onClick(e2.ev);
  okN('N-03 负对照：同一个「阻止冒泡」量具在坏角标夹具上得 0、在真实角标上得 1（判据能红也能绿）',
    e1.box.stopped === 0 && realCorner !== null && e2.box.stopped === 1,
    { 坏夹具: e1.box.stopped, 真实角标: e2.box.stopped });

  // N-04 样式表缺那三条（只留全局 button 规则）
  const BAD_CSS = 'button { border: none; cursor: pointer; transition: transform .12s ease; } button:hover { transform: rotate(-1.5deg); }';
  const probeCard = cardHtml ? parseHtml(cardHtml)[0] : null;
  const badCssHits = probeCard ? { t: rulesFor(BAD_CSS, probeCard, '').length, h: rulesFor(BAD_CSS, probeCard, ':hover').length, a: rulesFor(BAD_CSS, probeCard, ':active').length } : null;
  const goodCssHits = probeCard && shellCss ? {
    t: rulesFor(shellCss, probeCard, '').filter((r) => /transform/.test(r.decls['transition'] ?? '')).length,
    h: rulesFor(shellCss, probeCard, ':hover').filter((r) => /rotate\(/.test(r.decls['transform'] ?? '')).length,
    a: rulesFor(shellCss, probeCard, ':active').filter((r) => /scale\(/.test(r.decls['transform'] ?? '')).length,
  } : null;
  okN('N-04 负对照：把卡片丢进「只有全局 button 规则」的样式表，三条手感判据全部落空；真实样式表三条都命中',
    !!badCssHits && badCssHits.t === 0 && badCssHits.h === 0 && badCssHits.a === 0
    && !!goodCssHits && goodCssHits.t >= 1 && goodCssHits.h >= 1 && goodCssHits.a >= 1,
    { 坏样式表: badCssHits, 真实样式表: goodCssHits });

  // N-05 okPair 契约有牙：行为失守时字面侧再绿也判红，红因落在「行为失守」
  const spyOk: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  okPair((n, c, e) => spyOk.push({ name: n, cond: c, extra: e }), 'N-05 假夹具：静态扫描干净但渲染产物有违规',
    () => interactiveNesting(parseHtml(renderToStaticMarkup(React.createElement(BrokenContainer)))).length === 0,
    () => true,
    () => ({ 说明: '字面侧绿灯、行为侧红灯 → 必须记红且红因是行为失守' }));
  okN('N-05 okPair 落地：行为失守即判红，红因写「行为失守」而非「锚点失配」',
    spyOk.length === 1 && spyOk[0].cond === false && JSON.stringify(spyOk[0].extra).includes('行为失守'), spyOk);

  // N-06 渲染通道自身的牙齿：产物里没有的东西不能被认成存在
  const n06Plain = parseHtml('<div>门内随手写的 role=button tabindex=0 aria-label=门内夹具卡片</div>')[0];
  okN('N-06 反证：产物判据不是「文本里随便找」——把卡片 HTML 换成正文片段时 role/tabindex 判据必须落空',
    n06Plain.attrs['role'] === undefined && n06Plain.attrs['tabindex'] === undefined,
    { 正文片段属性: n06Plain.attrs, 真实卡片属性: cardHtml ? parseHtml(cardHtml)[0].attrs : null });

  // N-07 渲染通道的失败面：追加不存在的导出必须让编译失败（组件改名后本门亮红而非静默绿）
  let negativeBuild: 'failed' | 'succeeded' = 'succeeded';
  try {
    await buildProduct(join(WEB_SRC, 'pages', 'ReportPage.tsx'), ['NoSuchGateComponent'], 'negative');
  } catch { negativeBuild = 'failed'; }
  okN('N-07 反证：esbuild 通道对不存在的私有组件如实失败（组件改名/挪走后本门不会假绿）',
    negativeBuild === 'failed', { 结果: negativeBuild });
}

// =====================================================================
// 收口：删除本轮渲染中间产物（只删本门自己建的目录）
// =====================================================================
process.off('unhandledRejection', rejectSink);
try {
  rmSync(SCRATCH, { recursive: true, force: true });
  ok(`N-08 清理：本轮渲染中间产物目录已删除（${RUN_ID}），产品工作树零写入`,
    !readdirSync(join(ROOT, '.workbuddy')).includes(RUN_ID) && !readdirSync(WEB_SRC).includes(RUN_ID));
} catch (e) {
  okN('N-08 清理：本轮渲染中间产物目录已删除', false, { 红因: String((e as Error)?.message ?? e).slice(0, 160) });
}
if (asyncErrors.length) lines.push(`[NOTE] 无 DOM 宿主下的异步红字（不参与判定，仅留痕）：${JSON.stringify(asyncErrors).slice(0, 300)}`);

const summary = `PASS=${pass} FAIL=${fail} SKIP=${skippedCount}\n`
  + `T02143 卡片 DOM 嵌套门（T02293 改判：断言对象＝真实组件的渲染产物 + 真实 handler 行为）\n`
  + `${lines.join('\n')}\n`;
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02143-gate-results.txt', summary,
  { note: `渲染通道 react-dom/server 18.3.1；SKIP ${skippedCount} 条` });
console.log(`PASS=${pass} FAIL=${fail} SKIP=${skippedCount}`);
console.log(lines.join('\n'));
console.log(`结果文件：${resultsFile}`);
process.exit(fail === 0 ? 0 : 1);
