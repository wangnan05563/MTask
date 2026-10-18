/**
 * T02162 门：Ctrl+F 命令面板任务项点击对齐通知中心定位逻辑。
 *
 * 根因（不变）：原任务项点击只写过次会话键 + onNavigate('tasks')=setTab。用户本就停在任务页时
 * setTab 同值不触发重挂载，useSessionState 仅在挂载时读一次键 → React 状态无感知 → 点击后无反应 /
 * 定位到上一条（T01568 同一个坑）。且从不写 focusDrawerId → 抽屉不弹。
 * 修复：任务项点击改走 `focusTaskByNo(taskNo, 'notice')`——与通知中心 `gotoTask` 同一入口。
 *
 * T02293 改判（`docs/验收门判据规约.md` 判据 1/2/3/4）——原 S-01~S-05 是五条源码文本锚，现在换成产物/行为：
 *
 *  渲染通道（本机可用的最便宜通道是 (a)：仓库自带 React 18；node_modules 里没有 jsdom/happy-dom，
 *  也不允许装依赖，故不引浏览器）。面板组件用了 `createPortal`，`react-dom/server` 不渲染 portal，
 *  所以本门的「产物」是**真实组件函数自己产出的 React 元素树**：门内挂一个最小 hooks 调度器
 *  （useState 带可变槽位 + 重渲染、useRef 稳定槽、useEffect 按依赖跑并回收 cleanup、
 *  useMemo/useCallback/useSyncExternalStore 的等价最小语义），**调用真实的 `CommandPalette` /
 *  `NotifyBell`**，从它们返回的树上取出真实的行元素与 `onClick`/`onKeyDown`，用合成事件真的点一遍、
 *  真的按一遍，再观测这些真实代码留下的**外部可观测产物**：
 *   - `sessionStorage` 写入的会话键值（门内自造的 Map 存储，逐键比对值）；
 *   - `globalThis.dispatchEvent` 收到的 `mtaskFocusTask` / `mtaskNavigate` 事件载荷；
 *   - 对后端的 `fetch` 请求序列（门内自造的夹具任务/提示词/项目/事件，绝不读生产数据）；
 *   - 渲染出来的 `<input>` 所挂 ref 上有没有被调用 `focus()`（「打开面板焦点进搜索框」这条
 *     行为判据的落点是组件真正聚焦的那个节点对象，不是源码里有没有 `.focus()`）。
 *
 *  「面板与通知中心同一入口」这条不再靠「两边源码都写着 focusTaskByNo」来判：
 *  改成**同一份夹具任务**分别经「面板任务行点击」与「通知中心条目点击」两条真实入口触发，
 *  要求两次的会话键集合、事件载荷、后端请求序列**逐项相等**（产物同一性）。
 *  面板若自己另写一套定位（旧实现），键集/事件/请求必然不同 ⇒ 该条立刻红。
 *
 *  保留的字面锚点（判据 3，一律 `okPair`，行为侧失守则该条必红）：S 组五条源码锚，行为侧全部改成
 *  「真实入口留下的产物」（会话键集合 / 事件载荷 / 请求序列 / 落位随状态移动），不再引用 P 组的计数器。
 *  负对照（判据 4）：N 组在内存里现造旧实现夹具（只写 focusId=编号 + onNavigate，不发事件）、
 *  打开不聚焦的夹具与**会聚焦的夹具**（量具双向都必须有效，否则是瞎的）、不传 'notice' 的 seam、
 *  老坑键集合、以及同一性量具的一侧换成老实现——要求同一套量具判红、真实产物判绿；
 *  okPair 自身也配了「失守判红 + 真实产物判绿」两条互逆对照（反模式 5/12）。
 *  未做的事如实说明：本机没有 jsdom/happy-dom 且禁止装依赖，故「焦点落在输入框」只能量到
 *  「组件对它渲染出的那个 input 元素自己的 ref 调了 focus()」，量不到浏览器真正的高亮环；
 *  真实浏览器口径由 t02162 的 UI 探针与 Playwright 门（另一路）承担。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02162-cmdpalette-focus.mts
 * 结果落 .workbuddy/t02162-gate-results-<运行标识>.txt（编译中间产物落同目录本轮子目录，结束时删除）。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'web', 'src');
const RUN_ID = `t02162-${process.pid}-${Date.now()}`;
const SCRATCH = join(ROOT, '.workbuddy', RUN_ID);

let pass = 0;
let fail = 0;
let skippedCount = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
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
// 0) 宿主环境 + 门内夹具数据（判据 2：门自造数据，零生产依赖）
// =====================================================================
mkdirSync(SCRATCH, { recursive: true });
const g = globalThis as any;
g.document ??= { baseURI: 'http://127.0.0.1:39902/', body: { nodeType: 1, appendChild() {} }, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: () => ({ nodeType: 1, style: {} }) };
const lsStore = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => lsStore.get(k) ?? null, setItem: (k: string, v: string) => { lsStore.set(k, v); }, removeItem: (k: string) => { lsStore.delete(k); } };
const ssStore = new Map<string, string>();
g.sessionStorage ??= { getItem: (k: string) => ssStore.get(k) ?? null, setItem: (k: string, v: string) => { ssStore.set(k, v); }, removeItem: (k: string) => { ssStore.delete(k); }, clear: () => ssStore.clear() };
g.window ??= { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1280, innerHeight: 800, location: 'http://127.0.0.1:39902/' };
/** 事件与请求都是「外部可观测产物」，这里原样收下供逐字段比对 */
const events: Array<{ type: string; detail: unknown }> = [];
const nativeDispatch = typeof g.dispatchEvent === 'function' ? g.dispatchEvent.bind(g) : undefined;
g.dispatchEvent = (ev: any) => { events.push({ type: String(ev?.type), detail: ev?.detail }); if (nativeDispatch) nativeDispatch(ev); return true; };
const fetchSeq: string[] = [];
const asyncErrors: string[] = [];
const rejectSink = (e: unknown) => asyncErrors.push(String((e as any)?.message ?? e).slice(0, 140));
process.on('unhandledRejection', rejectSink);

/** 门内夹具：两条任务（一有一无回传，用来量 'notice' 落位语义）+ 一条提示词 + 一个项目 + 一条通知事件 */
const TASK_DONE_OK = { id: 'uuid-T02162-A', task_no: 'T00001', title: '门内夹具任务甲', status: 'doing', project_id: 'proj-A', ai_state: 'success', handle_result: '已回传结论' };
const TASK_FAILED = { id: 'uuid-T02162-B', task_no: 'T00002', title: '门内夹具任务乙', status: 'done', project_id: 'proj-B', ai_state: 'failed', handle_result: '' };
const TASK_MISSING = { task_no: 'T00009', title: '门内夹具任务丙', status: 'todo', project_id: 'proj-A' };
const FIXTURES: Record<string, unknown> = {
  '/tasks/by-no/T00001': TASK_DONE_OK,
  '/tasks/by-no/T00002': TASK_FAILED,
  '/tasks/by-no/T00009': { __status: 404, error: '任务不存在（门内夹具）' },
  '/tasks?archived=0&limit=500': [TASK_DONE_OK, TASK_FAILED],
  '/prompts': [{ id: 'p1', title: '门内夹具提示词' }],
  '/projects': [{ id: 'proj-A', name: '门内夹具项目' }],
  '/events/recent?limit=30': [{ id: 'ev-1', task_no: 'T00001', task_id: 'uuid-T02162-A', project_id: 'proj-A', project_name: '门内夹具项目', kind: 'result', detail: '门内夹具：结论已回传', title: '门内夹具任务甲', created_at: '2026-01-01T00:00:00.000Z' }],
};
g.fetch = async (url: string) => {
  const u = String(url);
  fetchSeq.push(u);
  const key = Object.keys(FIXTURES).find((k) => u.endsWith(k));
  const body = key ? FIXTURES[key] : { __status: 404, error: `门内夹具未覆盖的请求：${u}` };
  const anyBody = body as any;
  const status = anyBody?.__status ?? 200;
  const json = status === 200 ? body : { error: anyBody.error };
  return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) };
};
const settle = async (ms = 30) => { await new Promise((r) => setTimeout(r, ms)); };

const React = (await import('react')).default as any;
const esbuild = (await import('esbuild')).default as any;

/** 用仓库自己的 React 18 编译真实产品模块（tsx 走的是 classic JSX 运行时，web 源码没有 React 全局） */
async function buildProduct(productFile: string, tag: string, exposePrivate: string[] = [], reexport: Array<[string, string]> = []): Promise<Record<string, any>> {
  const outfile = join(SCRATCH, `${tag}.mjs`);
  const tail = [
    ...exposePrivate.map((n) => `export { ${n} as __gate_${n} };`),
    ...reexport.map(([n, from]) => `export { ${n} as __gate_${n} } from '${from}';`),
  ].join('\n');
  await esbuild.build({
    absWorkingDir: ROOT, entryPoints: [productFile], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', jsx: 'automatic', outfile, logLevel: 'silent',
    plugins: [{
      name: 'gate-product-host',
      setup(b: any) {
        b.onResolve({ filter: /.*/ }, (a: any) => (
          !a.path.startsWith('.') && !/^([a-zA-Z]:[\\/]|[\\/])/.test(a.path) && !a.path.startsWith('api:')
            ? { path: a.path, external: true } : undefined));
        b.onLoad({ filter: new RegExp(productFile.replace(/[\\\/]/g, '[\\\\/]') + '$') }, (a: any) => ({
          loader: 'tsx' as const,
          contents: readFileSync(a.path, 'utf8') + (tail ? `\n${tail}\n` : ''),
        }));
      },
    }],
  });
  const mod = await import(pathToFileURL(outfile).href);
  const wanted = [...exposePrivate, ...reexport.map(([n]) => n)].map((n) => `__gate_${n}`);
  // 追加的导出必须真取到（esbuild 对不存在的本地导出只给 warning）：取不到就是产品形态变了，如实判红
  for (const k of wanted) if (mod[k] === undefined) throw new Error(`编译产物里取不到 ${k}（组件/函数改名或挪走 → 本门失明）`);
  return mod;
}

/** 最小 hooks 调度器：真实组件函数体跑起来，槽位可变 ⇒ 能重渲染，effect 能跑能回收 */
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
  const cleanups: Array<() => void> = [];
  const runEffects = () => {
    for (const f of eff.splice(0)) {
      try { const c = f(); if (typeof c === 'function') cleanups.push(c); }
      catch (e) { asyncErrors.push(`effect:${String((e as any)?.message ?? e).slice(0, 100)}`); }
    }
  };
  return { render, runEffects, cleanups, hooks };
}

function walkEl(node: any, visit: (el: any) => void): void {
  if (Array.isArray(node)) { node.forEach((n) => walkEl(n, visit)); return; }
  if (!node || typeof node !== 'object' || node.$$typeof === undefined) return;
  visit(node);
  walkEl((node as any).children ?? node.props?.children, visit);
}
const elsWhere = (tree: any, pred: (el: any) => boolean) => { const out: any[] = []; walkEl(tree, (el) => { if (pred(el)) out.push(el); }); return out; };
/** 行元素：面板里可点击的条目（渲染产物上的 onClick，不是源码里的写法） */
const rowsOf = (tree: any) => elsWhere(tree, (el) => el.type === 'div' && typeof el.props?.onClick === 'function' && el.props?.style?.cursor === 'pointer');
const textOf = (el: any) => elsWhere(el, (n) => typeof n.props?.children === 'string').map((n) => String(n.props.children)).join('|');
/** 外部可观测产物的快照：会话键 + 事件载荷 + 本轮请求序列 */
const snapshot = (reqFrom: number) => ({
  keys: Object.fromEntries([...ssStore.entries()].sort()),
  events: events.map((e) => ({ type: e.type, detail: e.detail })),
  requests: fetchSeq.slice(reqFrom).map((u) => u.replace(/^http:\/\/127\.0\.0\.1:39902\/api/, '')),
});
const clearArtifacts = () => { ssStore.clear(); events.length = 0; };

// =====================================================================
// 1) 驱动真实面板：打开 → 跑 effect → 等门内夹具数据回来 → 重渲染
// =====================================================================
type Palette = ReturnType<typeof makePalette>;
function makePalette(PaletteComp: any) {
  const spy = { closed: 0, navigations: [] as string[] };
  const inst = mount(PaletteComp, { open: true, onClose: () => { spy.closed += 1; }, onNavigate: (t: string) => { spy.navigations.push(t); } });
  let tree = inst.render();
  const focusCalls: string[] = [];
  const inputEl = () => elsWhere(tree, (el) => el.type === 'input')[0] ?? null;
  // 把「渲染出来的输入框」挂到它自己的 ref 上（等价于浏览器把 DOM 节点交给 ref），再跑 open effect
  const input0 = inputEl();
  if (input0?.ref) input0.ref.current = { focus: () => focusCalls.push('focus'), blur: () => {}, select: () => {} };
  inst.runEffects();
  const rerender = () => { tree = inst.render(); return tree; };
  return {
    spy, focusCalls, tree: () => tree, rerender, inputEl, inst,
    /** 取当前渲染的 onKeyDown（useCallback 每轮重算，按键后必须重新取） */
    press: async (key: string) => {
      const el = inputEl();
      const kd = el?.props?.onKeyDown;
      if (typeof kd !== 'function') return false;
      kd({ key, preventDefault: () => {}, target: { value: '' } });
      rerender();
      await settle(5);
      return true;
    },
    clickRow: async (el: any) => { el.props.onClick({ stopPropagation: () => {}, preventDefault: () => {}, target: {}, currentTarget: {} }); await settle(40); },
  };
}

lines.push('== P 组：真实 CommandPalette / NotifyBell 的点击与键盘行为产物');
let palette: Palette | null = null;
let seamDirect: (() => Promise<void>) | null = null;
let bellComp: any = null;
let channelReady = false;
/** 供 S 组复用的行为侧事实（都来自真实入口留下的产物，不是源码文案） */
const arts: {
  taskRow: ReturnType<typeof snapshot> | null;   // 面板任务行点击
  failedRow: ReturnType<typeof snapshot> | null; // 失败任务行点击（'notice' 的另一侧）
  bellRow: ReturnType<typeof snapshot> | null;   // 通知中心条目点击
  seamCall: ReturnType<typeof snapshot> | null;  // 直接调用同一 seam
  navOnTaskRow: string[];                        // 面板任务行点击期间 onNavigate 的调用
  closedOnTaskRow: number;                       // 同一次点击触发的 onClose 次数
} = { taskRow: null, failedRow: null, bellRow: null, seamCall: null, navOnTaskRow: [], closedOnTaskRow: -1 };
try {
  const CP = await buildProduct(join(WEB_SRC, 'pages', 'CommandPalette.tsx'), 'palette', [],
    [['focusTaskByNo', '../ui/focusTask'], ['drawerTabForNotice', '../ui/focusTask']]);
  const NB = await buildProduct(join(WEB_SRC, 'ui', 'NotifyBell.tsx'), 'bell');
  palette = makePalette(CP.CommandPalette);
  seamDirect = async () => { await (CP.__gate_focusTaskByNo as (n: string, m?: unknown) => Promise<void>)('T00001', 'notice'); };
  bellComp = NB.NotifyBell;
  channelReady = true;

  await settle(60);
  const tree = palette.rerender();

  // ---- 打开态产物 ----
  ok('P-01 面板打开后渲染出搜索输入框与结果行（真实组件的产物在场）',
    !!palette.inputEl() && rowsOf(tree).length >= 4, { 行数: rowsOf(tree).length, 输入框: !!palette.inputEl() });
  ok('P-02 打开面板后焦点落在渲染出来的那个输入框上（focus() 打在该元素自己的 ref 节点上）',
    palette.focusCalls.length === 1 && !!palette.inputEl()?.ref?.current,
    { focusCalls: palette.focusCalls.length, ref已挂载: !!palette.inputEl()?.ref?.current });
  ok('P-03 结果行由门内夹具驱动：夹具任务/提示词/项目行都出现在产物里（零生产数据依赖）',
    (() => {
      const all = rowsOf(tree).map(textOf).join('\n');
      return all.includes('T00001') && all.includes('门内夹具提示词') && all.includes('门内夹具项目');
    })(), { 行样本: rowsOf(tree).slice(0, 12).map((r) => textOf(r).slice(0, 40)) });
  ok('P-04 取数走的是门内打桩的后端接口（面板不直连生产实例）',
    fetchSeq.some((u) => u.endsWith('/tasks?archived=0&limit=500')) && fetchSeq.some((u) => u.endsWith('/projects')),
    { 请求: fetchSeq.slice(0, 4) });

  // ---- 键盘通路 ----
  const beforeClose = palette.spy.closed;
  ok('P-05 Esc 关闭面板（真实 onKeyDown → onClose 计数 +1）',
    await (async () => { await palette!.press('Escape'); return palette!.spy.closed === beforeClose + 1; })(),
    { closed: `${beforeClose} → ${palette.spy.closed}` });

  // ↑↓ 高亮移动的量具：真实面板把「确认角标」组件只渲染在高亮行上（产物结构事实），
  // 于是「哪一行是高亮行」= 「哪一行的子树里出现 CornerDownLeft」，不用读内联样式字符串。
  const GLYPH = (await import('lucide-react')).CornerDownLeft;
  const hasGlyph = (el: any) => { let hit = false; walkEl(el, (n) => { if (n.type === GLYPH || n.type?.displayName === 'CornerDownLeft') hit = true; }); return hit; };
  const activeIdx = () => rowsOf(palette!.tree()).findIndex(hasGlyph);
  const glyphMap = () => rowsOf(palette!.tree()).map(hasGlyph);
  ok('P-06a 高亮标记形态：产物里恰有一行带确认角标，其余行显示的是提示文案（角标不是恒在场）',
    glyphMap().filter(Boolean).length === 1 && rowsOf(palette.tree()).length > 3,
    { 角标分布: glyphMap(), 行数: rowsOf(palette.tree()).length });
  const a0 = activeIdx();
  await palette.press('ArrowDown');
  const a1 = activeIdx();
  await palette.press('ArrowUp');
  const a2 = activeIdx();
  ok('P-06b ↑↓ 在真实 onKeyDown 上移动高亮行（角标随按键下移一行、再回退到位）',
    a0 === 0 && a1 === 1 && a2 === 0, { a0, a1, a2 });
  ok('P-07 面板条目本身不是原生交互元素（键盘通路集中在输入框；与 t02143 同一条 HTML 口径）',
    elsWhere(palette.tree(), (el) => ['button', 'select', 'textarea'].includes(el.type)).length === 0
    && !!palette.inputEl(), { 交互标签数: elsWhere(palette.tree(), (el) => ['button', 'select', 'textarea'].includes(el.type)).length });

  // ---- 任务行点击：定位产物 ----
  clearArtifacts();
  const reqBase = fetchSeq.length;
  const navBase = palette.spy.navigations.length;
  const closedBase = palette.spy.closed;
  const taskRow = rowsOf(palette.tree()).find((r) => textOf(r).includes('T00001'));
  ok('P-08 取到夹具任务所在行（按门内造的数据定位，不靠源码文案）', !!taskRow, { 行文本: taskRow ? textOf(taskRow).slice(0, 60) : null });
  if (taskRow) await palette.clickRow(taskRow);
  arts.navOnTaskRow = palette.spy.navigations.slice(navBase);
  arts.closedOnTaskRow = palette.spy.closed - closedBase;
  const art = snapshot(reqBase);
  arts.taskRow = art;
  const d: any = art.events.find((e) => e.type === 'mtaskFocusTask')?.detail;
  ok('P-09 点击任务行 → 派发 mtaskFocusTask 定位意图（已挂载页据此直接吃意图，不等重挂载）',
    !!d && d.id === TASK_DONE_OK.id && d.taskNo === 'T00001' && d.projectId === 'proj-A', { detail: d });
  ok('P-10 会话键写齐且 focusId 是解析出的 uuid（不是编号——旧逻辑命不中行的根因）',
    art.keys['tasks.focusId'] === JSON.stringify(TASK_DONE_OK.id)
    && art.keys['tasks.focusProjectId'] === JSON.stringify('proj-A')
    && art.keys['tasks.focusTab'] === JSON.stringify('todo')
    && art.keys['tasks.activeTab'] === JSON.stringify('todo')
    && art.keys['tasks.search'] === JSON.stringify('T00001'), { keys: art.keys });
  ok('P-11 抽屉自动弹出：focusDrawerId 与 focusDrawerTab 成对写入且落位非空',
    art.keys['tasks.focusDrawerId'] === JSON.stringify(TASK_DONE_OK.id)
    && typeof art.keys['tasks.focusDrawerTab'] === 'string'
    && JSON.parse(art.keys['tasks.focusDrawerTab']) === 'result'
    && d?.drawerTab === 'result', { drawerId: art.keys['tasks.focusDrawerId'], drawerTab: art.keys['tasks.focusDrawerTab'] });
  ok('P-12 同时派发 mtaskNavigate(tab=tasks)：任务定位不依赖 onNavigate(\'tasks\')',
    art.events.some((e) => e.type === 'mtaskNavigate' && (e.detail as any)?.tab === 'tasks')
    && arts.navOnTaskRow.length === 0, { 事件: art.events.map((e) => e.type), 本次点击的onNavigate: arts.navOnTaskRow });
  ok('P-13 任务行解析走 by-no 接口（门内打桩），解析到的状态决定目标 tab',
    art.requests.some((u) => u === '/tasks/by-no/T00001'), { requests: art.requests });
  ok('P-14 点击任务行恰好关闭一次面板（执行一次 = 关闭一次，不漏关也不双关）',
    arts.closedOnTaskRow === 1, { closedDelta: arts.closedOnTaskRow });

  // ---- 'notice' 语义随任务状态移动（同一入口，两种产物）----
  clearArtifacts();
  const reqBase2 = fetchSeq.length;
  const failRow = rowsOf(palette.tree()).find((r) => textOf(r).includes('T00002'));
  if (failRow) await palette.clickRow(failRow);
  const art2 = snapshot(reqBase2);
  arts.failedRow = art2;
  const d2: any = art2.events.find((e) => e.type === 'mtaskFocusTask')?.detail;
  ok("P-15 'notice' 落位随任务实际状态移动：有回传→结果页、失败→描述页（同一入口两种产物）",
    JSON.parse(art.keys['tasks.focusDrawerTab']) === 'result'
    && d2?.drawerTab === 'desc' && art2.keys['tasks.focusDrawerTab'] === JSON.stringify('desc')
    && art2.keys['tasks.focusTab'] === JSON.stringify('done') && d2?.tab === 'done',
    { 甲: art.keys['tasks.focusDrawerTab'], 乙: art2.keys['tasks.focusDrawerTab'], tab: art2.keys['tasks.focusTab'] });

  // ---- 两入口同一性：面板点击 vs 通知中心点击 ----
  const bInst = mount(bellComp, {});
  let bTree = bInst.render();
  bInst.runEffects();
  await settle(50);
  bTree = bInst.render();
  const bellBtn = elsWhere(bTree, (el) => el.type === 'button' && String(el.props?.['aria-label'] ?? '').includes('通知中心'))[0];
  ok('P-16 通知中心可驱动：铃铛渲染出原生 button 条目入口（作为对照入口的前提）',
    !!bellBtn && typeof bellBtn.props.onClick === 'function', { found: !!bellBtn });
  if (bellBtn) {
    bellBtn.props.onClick({ stopPropagation: () => {}, preventDefault: () => {} });
    bInst.render();
    bInst.runEffects();
    await settle(40);
    const bTree2 = bInst.render();
    const item = elsWhere(bTree2, (el) => el.type === 'button' && String(el.props?.title ?? '').includes('门内夹具'))[0];
    ok('P-16b 铃铛面板里的夹具通知条目已渲染成可点按钮（对照入口的条目在场）', !!item, { 条目: !!item });
    // 请求基准只取「点击那一刻」——铃铛自身开面板的取数不该混进同一条比对里
    clearArtifacts();
    const reqBaseB = fetchSeq.length;
    if (item) { item.props.onClick({ stopPropagation: () => {}, preventDefault: () => {} }); await settle(50); }
    const artB = snapshot(reqBaseB);
    arts.bellRow = artB;
    ok('P-17 面板任务行点击与通知中心条目点击的产物逐项相等（会话键 / 事件载荷 / 后端请求序列）',
      !!item && JSON.stringify(artB.keys) === JSON.stringify(art.keys)
      && JSON.stringify(artB.events) === JSON.stringify(art.events)
      && JSON.stringify(artB.requests) === JSON.stringify(art.requests),
      { 铃铛键: Object.keys(artB.keys), 面板键: Object.keys(art.keys), 铃铛事件: artB.events.map((e) => e.type), 请求: [artB.requests, art.requests] });
    bInst.cleanups.forEach((c) => { try { c(); } catch { /* 定时器回收失败不影响判定 */ } });
  } else {
    skipped('P-17 面板 vs 通知中心产物同一性', '通知中心条目按钮没渲染出来（夹具事件数据没落上）');
  }

  // ---- 与直接调用共用同一 seam ----
  clearArtifacts();
  const reqBase3 = fetchSeq.length;
  if (seamDirect) { await seamDirect(); await settle(30); }
  const art3 = snapshot(reqBase3);
  arts.seamCall = art3;
  ok('P-18 面板点击产物 == 直接调用同一 seam 的产物（面板没有第二条定位通路）',
    JSON.stringify(art3.keys) === JSON.stringify(art.keys) && JSON.stringify(art3.events) === JSON.stringify(art.events)
    && JSON.stringify(art3.requests) === JSON.stringify(art.requests),
    { seam键: Object.keys(art3.keys), 面板键: Object.keys(art.keys), 请求: [art3.requests, art.requests] });

  // ---- 解析失败的退化通路（不静默）----
  clearArtifacts();
  const reqBase4 = fetchSeq.length;
  const CP2 = await buildProduct(join(WEB_SRC, 'ui', 'focusTask.ts'), 'seam');
  await (CP2.focusTaskByNo as (n: string, m?: unknown) => Promise<void>)('T00009', 'notice');
  await settle(30);
  const art4 = snapshot(reqBase4);
  const d4: any = art4.events.find((e) => e.type === 'mtaskFocusTask')?.detail;
  ok('P-19 编号解析不到时如实退化：仍带编号搜索 + 仍派发意图 + 仍导航（不静默什么也不做）',
    art4.keys['tasks.search'] === JSON.stringify('T00009') && !!d4 && d4.taskNo === 'T00009' && d4.id === undefined
    && art4.events.some((e) => e.type === 'mtaskNavigate') && art4.keys['tasks.focusDrawerId'] === undefined,
    { keys: art4.keys, detail: d4, 事件: art4.events.map((e) => e.type) });

  // ---- 对照：非任务行仍走 onNavigate（证明判据能区分两类行，不是恒绿）----
  clearArtifacts();
  const navBase2 = palette.spy.navigations.length;
  const promptRow = rowsOf(palette.tree()).find((r) => textOf(r).includes('门内夹具提示词'));
  // 页面直达行取「设置」——「任务」那一行的 onNavigate('tasks') 是它的正当产物，不能拿来当反例
  const pageRow = rowsOf(palette.tree()).find((r) => textOf(r).includes('设置'));
  if (promptRow) await palette.clickRow(promptRow);
  if (pageRow) await palette.clickRow(pageRow);
  const navs = palette.spy.navigations.slice(navBase2);
  ok('P-20 对照有牙：提示词/页面直达行仍经 onNavigate 导航、且不经定位 seam（与任务行两类产物分得开）',
    navs.includes('prompts') && navs.includes('settings')
    && events.length === 0 && !navs.includes('tasks'),
    { navigations: navs, 事件: events.map((e) => e.type) });

  ok('P-21 通道自检：真实面板、铃铛、seam 三者都从编译产物里取到了（不是门自己造的替身）',
    channelReady && typeof palette === 'object' && typeof bellComp === 'function' && typeof seamDirect === 'function',
    { channelReady });
} catch (e) {
  ok('P-00 渲染通道可用（真实面板/铃铛编译取物）', false, { 红因: String((e as Error)?.message ?? e).slice(0, 300) });
}

// =====================================================================
// S 组：保留的字面锚点（判据 3：行为侧失守则该条必红）
// =====================================================================
lines.push('== S 组：源码锚点降级为字面侧（配同义行为断言）');
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
// 反模式 11：字面腿一律取**已提交树**（工作树可能躺着别的路径留下的过期产品文件，读它会判红误报）
function headSource(rel: string): string {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' }); }
  catch { return ''; }
}
const CP_SRC = strip(headSource('web/src/pages/CommandPalette.tsx'));
const FT_SRC = strip(headSource('web/src/ui/focusTask.ts'));
okPair(ok, 'S-00 字面腿取证对象非空（HEAD 树里这两个文件确实在，S-01~S-05 的字面侧不是拿空串比空串）',
  () => CP_SRC.length > 400 && FT_SRC.length > 400 && arts.taskRow !== null,
  () => CP_SRC.length > 400 && FT_SRC.length > 400,
  () => ({ CP_SRC长度: CP_SRC.length, FT_SRC长度: FT_SRC.length, 面板产物: arts.taskRow !== null }));
/** 行为侧公共料：P 组真实入口留下的产物（通道跑不起来时这些为 null，S 组随之判红） */
const A = arts;
okPair(ok, 'S-01 面板导入并走 focusTaskByNo 单 seam（行为侧：点击任务行留下了完整定位意图与五个会话键）',
  () => !!A.taskRow && A.taskRow.events.some((e) => e.type === 'mtaskFocusTask')
    && Object.keys(A.taskRow.keys).length >= 5 && !!A.taskRow.keys['tasks.search'],
  () => /import \{ focusTaskByNo \}/.test(CP_SRC) && /void focusTaskByNo\(/.test(CP_SRC),
  () => ({ 会话键: A.taskRow ? Object.keys(A.taskRow.keys) : null, 事件: A.taskRow ? A.taskRow.events.map((e) => e.type) : null }));
okPair(ok, 'S-02 面板不再手写过次会话键（行为侧：面板点击的键集合与直接调用同一 seam 逐项相等，面板侧没有第二写手）',
  () => !!A.taskRow && !!A.seamCall && JSON.stringify(A.taskRow.keys) === JSON.stringify(A.seamCall.keys),
  () => !/setSessionState\('tasks\.focusId', t\.id\)/.test(CP_SRC) && !/setSessionState\('tasks\.focusTab'/.test(CP_SRC),
  () => ({ 面板键: A.taskRow ? Object.keys(A.taskRow.keys) : null, seam键: A.seamCall ? Object.keys(A.seamCall.keys) : null }));
okPair(ok, "S-03 面板传 'notice'（行为侧：抽屉落位随任务实际状态在 result/desc 之间移动）",
  () => !!A.taskRow && !!A.failedRow
    && A.taskRow.keys['tasks.focusDrawerTab'] === JSON.stringify('result')
    && A.failedRow.keys['tasks.focusDrawerTab'] === JSON.stringify('desc'),
  () => /void focusTaskByNo\(t\.task_no \?\? t\.title, 'notice'\)/.test(CP_SRC),
  () => ({ 甲: A.taskRow?.keys['tasks.focusDrawerTab'], 乙: A.failedRow?.keys['tasks.focusDrawerTab'] }));
okPair(ok, 'S-04 任务定位不再依赖 onNavigate（行为侧：那一次点击没调用 onNavigate，却派发了 mtaskNavigate）',
  () => !!A.taskRow && A.navOnTaskRow.length === 0
    && A.taskRow.events.some((e) => e.type === 'mtaskNavigate' && (e.detail as any)?.tab === 'tasks'),
  () => !/focusTaskByNo[\s\S]*?onNavigate\('tasks'\)/.test(CP_SRC) || /void focusTaskByNo\(t\.task_no/.test(CP_SRC),
  () => ({ 本次点击的onNavigate: A.navOnTaskRow, 事件: A.taskRow ? A.taskRow.events.map((e) => e.type) : null }));
okPair(ok, 'S-05 通知中心与命令面板共用同一 seam（行为侧：两入口的会话键/事件/请求序列逐项相等）',
  () => !!A.taskRow && !!A.bellRow
    && JSON.stringify(A.bellRow.keys) === JSON.stringify(A.taskRow.keys)
    && JSON.stringify(A.bellRow.events) === JSON.stringify(A.taskRow.events)
    && JSON.stringify(A.bellRow.requests) === JSON.stringify(A.taskRow.requests),
  () => /export async function focusTaskByNo\(/.test(FT_SRC)
    && /function dispatchFocus\(intent: FocusTaskIntent\)/.test(FT_SRC)
    && /globalThis\.dispatchEvent\(new CustomEvent\('mtaskFocusTask'/.test(FT_SRC),
  () => ({ 铃铛键: A.bellRow ? Object.keys(A.bellRow.keys) : null, 面板键: A.taskRow ? Object.keys(A.taskRow.keys) : null }));

// =====================================================================
// N 组：负对照（判据 4）
// =====================================================================
lines.push('== N 组：负对照（旧实现与破坏形态在内存里现造，同一量具必须判红）');
{
  // N-01 旧实现夹具：只写过次会话键 + onNavigate('tasks')，不发定位意图（T02162 修前的原样）
  const oldKeys = new Map<string, string>();
  const oldEvents: Array<{ type: string }> = [];
  const oldNav: string[] = [];
  const legacyTaskAction = () => {
    oldKeys.set('tasks.focusId', JSON.stringify('T00001')); // 编号当 id：永远命不中行 uuid
    oldKeys.set('tasks.focusTab', JSON.stringify('todo'));
    oldNav.push('tasks');
  };
  legacyTaskAction();
  const judgeOn = (keys: Map<string, string> | Record<string, string>, evs: Array<{ type: string }>, nav: string[]) => {
    const k = keys instanceof Map ? Object.fromEntries(keys) : keys;
    return !!k['tasks.focusId'] && k['tasks.focusId'] !== JSON.stringify('T00001')
      && evs.some((e) => e.type === 'mtaskFocusTask') && !nav.includes('tasks');
  };
  okN('N-01 负对照：旧实现夹具（focusId=编号 + 只靠 onNavigate、不发意图事件）被同一量具判红',
    judgeOn(oldKeys, oldEvents, oldNav) === false && judgeOn({ 'tasks.focusId': JSON.stringify(TASK_DONE_OK.id) }, [{ type: 'mtaskFocusTask' }], []) === true,
    { 夹具: { focusId: oldKeys.get('tasks.focusId'), 事件: oldEvents.map((e) => e.type), nav: oldNav } });

  // N-02 焦点量具的双向可验：不聚焦的夹具必须读 0、会聚焦的夹具必须读 1（否则量具本身是瞎的），
  //      真实面板在同一量具下读 1（真实面板的 focus() 走 30ms setTimeout，故 P 组先 settle 再取）。
  const focusProbe = (Comp: any, props: any) => {
    const calls: string[] = [];
    const inst = mount(Comp, props);
    const t = inst.render();
    const input = elsWhere(t, (el) => el.type === 'input')[0];
    if (input?.ref) input.ref.current = { focus: () => calls.push('focus') };
    inst.runEffects();
    return calls.length;
  };
  const NoFocusPalette = () => {
    const ref = React.useRef(null);
    React.useEffect(() => { /* 旧实现：打开面板不聚焦搜索框 */ }, []);
    return React.createElement('div', null, React.createElement('input', { ref, 'aria-label': '门内不聚焦夹具' }));
  };
  const WithFocusPalette = () => {
    const ref = React.useRef(null);
    React.useEffect(() => { (ref.current as any)?.focus(); }, []);
    return React.createElement('div', null, React.createElement('input', { ref, 'aria-label': '门内会聚焦夹具' }));
  };
  const badFocus = focusProbe(NoFocusPalette, {});
  const goodFocus = focusProbe(WithFocusPalette, {});
  const realFocus = palette ? palette.focusCalls.length : -1;
  okN('N-02 负对照：焦点量具双向有效（不聚焦夹具=0、会聚焦夹具=1），真实面板同量具为 1',
    badFocus === 0 && goodFocus === 1 && realFocus === 1, { 不聚焦夹具: badFocus, 会聚焦夹具: goodFocus, 真实面板: realFocus });

  // N-03 不传 'notice' 的 seam 调用 → 抽屉成对键不该出现（传了才该出现）
  clearArtifacts();
  const CP3 = await buildProduct(join(WEB_SRC, 'ui', 'focusTask.ts'), 'seam2');
  await (CP3.focusTaskByNo as (n: string, m?: unknown) => Promise<void>)('T00001');
  await settle(30);
  const noMode = Object.fromEntries(ssStore.entries());
  clearArtifacts();
  await (CP3.focusTaskByNo as (n: string, m?: unknown) => Promise<void>)('T00001', 'notice');
  await settle(30);
  const withMode = Object.fromEntries(ssStore.entries());
  okN("N-03 负对照：同一个 seam，不传 'notice' 时抽屉成对键不出现、传了才出现（抽屉弹出这条判据有牙）",
    noMode['tasks.focusDrawerId'] === undefined && noMode['tasks.focusDrawerTab'] === undefined
    && withMode['tasks.focusDrawerId'] !== undefined && withMode['tasks.focusDrawerTab'] !== undefined,
    { 不传: Object.keys(noMode), 传了: Object.keys(withMode) });

  // N-04 focusId 写成编号（T01057 的老坑）+ 少写三键 → 与真实点击产物共用同一个量具，必须一红一绿
  const judgeFocusKeys = (k: Record<string, string | undefined>) =>
    k['tasks.focusId'] === JSON.stringify(TASK_DONE_OK.id)
    && k['tasks.focusProjectId'] === JSON.stringify('proj-A')
    && k['tasks.focusTab'] === JSON.stringify('todo') && k['tasks.activeTab'] === JSON.stringify('todo')
    && k['tasks.search'] === JSON.stringify('T00001');
  const legacyKeys: Record<string, string> = {
    'tasks.focusId': JSON.stringify('T00001'), // 编号当 id：列表按 uuid 匹配，永远命不中该行
    'tasks.focusTab': JSON.stringify('todo'),
  };
  okN('N-04 负对照：老坑键集合（focusId=编号、缺 project/activeTab/search）被量具判红，真实点击产物判绿',
    judgeFocusKeys(legacyKeys) === false && judgeFocusKeys(A.taskRow?.keys ?? {}) === true,
    { 老坑: legacyKeys, 真实: A.taskRow?.keys ?? null });

  // N-05 okPair 契约有牙：行为失守 + 字面绿灯 ⇒ 记红且红因写「行为失守」
  const spyBad: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  okPair((n, c, e) => spyBad.push({ name: n, cond: c, extra: e }), 'N-05 假夹具：源码写着 seam 但点击没留下定位产物',
    () => legacyKeys['tasks.focusId'] === JSON.stringify(TASK_DONE_OK.id),
    () => /void focusTaskByNo\(/.test(CP_SRC),
    () => ({ 说明: '旧实现夹具态：只有文案没有产物' }));
  okN('N-05 okPair 落地：行为侧失守即判红，红因是「行为失守」而不是「锚点失配」',
    spyBad.length === 1 && spyBad[0].cond === false && JSON.stringify(spyBad[0].extra).includes('行为失守'),
    { 红因: (spyBad[0]?.extra as any)?.红因 });
  // 同一配对器换成真实产物必须转绿——否则 N-05 的红是恒红，不构成对照（反模式 5/12）
  const spyGood: Array<{ name: string; cond: boolean }> = [];
  okPair((n, c) => spyGood.push({ name: n, cond: c }), 'N-05b 真实产物 + 字面锚点齐全 ⇒ 判绿',
    () => !!A.taskRow && A.taskRow.events.some((e) => e.type === 'mtaskFocusTask'),
    () => /void focusTaskByNo\(/.test(CP_SRC));
  okN('N-05b 负对照可逆：同一条字面锚配上真实行为产物后 okPair 转绿（配对器不是恒红）',
    spyGood.length === 1 && spyGood[0].cond === true, spyGood);

  // N-08 同一性量具自身的牙：两入口真产物判等，任一侧换成老实现夹具立刻判不等
  const sameArt = (x: typeof A.taskRow, y: typeof A.taskRow) =>
    !!x && !!y && JSON.stringify(x.keys) === JSON.stringify(y.keys)
    && JSON.stringify(x.events) === JSON.stringify(y.events) && JSON.stringify(x.requests) === JSON.stringify(y.requests);
  okN('N-08 同一性量具有牙：面板 vs 铃铛判等，把铃铛一侧换成「只写编号键+onNavigate」的老实现即判不等',
    sameArt(A.taskRow, A.bellRow) === true
    && sameArt(A.taskRow, { keys: legacyKeys, events: [{ type: 'mtaskNavigate' }], requests: [] }) === false,
    { 面板键: A.taskRow ? Object.keys(A.taskRow.keys) : null, 老实现键: Object.keys(legacyKeys) });

  // N-06 通道自身的牙齿：追加不存在的组件/函数导出时，取物必须失败（改名后本门不假绿）
  let neg = 'succeeded';
  try { await buildProduct(join(WEB_SRC, 'pages', 'CommandPalette.tsx'), 'negative', ['NoSuchGateComponent']); }
  catch { neg = 'failed'; }
  okN('N-06 反证：编译入口对不存在的真实组件如实失败（面板改名/拆走后本门亮红而非静默放行）',
    neg === 'failed', { 结果: neg });

  // N-09 字面腿量具有牙（反模式 11 的正面交代）：把 HEAD 副本里的 seam 标识符改名后，
  //      S-05 的同一条字面判据必须转假；真 HEAD 文本必须为真（否则字面腿是空串恒真）
  const renamed = FT_SRC.replace('export async function focusTaskByNo(', 'export async function gateRenamedSeam(');
  const literalJudge = (t: string) => t.includes('export async function focusTaskByNo(')
    && t.includes('function dispatchFocus(intent: FocusTaskIntent)')
    && t.includes("globalThis.dispatchEvent(new CustomEvent('mtaskFocusTask'");
  okN('N-09 字面腿有牙齿：HEAD 文本改名 seam 后 S-05 的字面判据转假、原文为真（不是拿空串比空串）',
    literalJudge(FT_SRC) === true && literalJudge(renamed) === false,
    { 原文: literalJudge(FT_SRC), 改名副本: literalJudge(renamed), FT_SRC长度: FT_SRC.length });
}

// =====================================================================
// 收口：删除本轮编译中间产物（只删本门自己建的目录）
// =====================================================================
process.off('unhandledRejection', rejectSink);
try {
  rmSync(SCRATCH, { recursive: true, force: true });
  okN('N-07 清理：本轮编译中间产物目录已删除，产品工作树零写入',
    !readdirSync(join(ROOT, '.workbuddy')).includes(RUN_ID), { RUN_ID });
} catch (e) {
  okN('N-07 清理：本轮编译中间产物目录已删除', false, { 红因: String((e as Error)?.message ?? e).slice(0, 160) });
}
if (asyncErrors.length) lines.push(`[NOTE] 宿主环境下的异步红字（不参与判定，仅留痕）：${JSON.stringify(asyncErrors).slice(0, 300)}`);

const summary = `PASS=${pass} FAIL=${fail} SKIP=${skippedCount}\n`
  + `T02162 命令面板点击定位对齐通知中心门（T02293 改判：判据对象＝真实面板/铃铛点击与按键留下的产物）\n`
  + `${lines.join('\n')}\n`;
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't02162-gate-results.txt', summary,
  { note: `渲染通道＝真实组件元素树 + 门内 fetch/sessionStorage/dispatchEvent 桩；SKIP ${skippedCount} 条` });
console.log(`PASS=${pass} FAIL=${fail} SKIP=${skippedCount}`);
console.log(lines.join('\n'));
console.log(`结果文件：${resultsFile}`);
process.exit(fail === 0 ? 0 : 1);
