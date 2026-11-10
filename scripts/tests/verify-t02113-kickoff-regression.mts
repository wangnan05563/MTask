/**
 * T02113 门（PRD §8 验收 1/10 + §6.3「回归测试：验证周报导出与并发闸不受影响」）。
 *
 * 与已有机门的分工：
 *   verify-t02105 证的是**接线**（启动会与周报共用同一闸名 REPORT_GATE、429 形态、defer）；
 *   T02108 的 UI 实测证的是**交互**（卡片点击开面板、互斥、深链落位）。
 *   本门补两层它们都没覆盖的回归事实：
 *     ① 验收 10 的原话主语是「周报四格式导出」——启动会接入之后，周报自己那条路
 *        必须逐格式出**内容正确的二进制**（不是只回 200），且并发上限在周报侧仍真的生效；
 *     ② 验收 1 的「第 7 位 / 复用 ReportCard / 全量互斥」是可回归的结构事实，
 *        UI 实测一次就过期，源码守卫才守得住后续改动（新卡片漏进互斥集是历史真坑，见 togglePanel 注释）。
 *
 * 断言组：
 *   R 组 周报四格式：xlsx/docx/pdf/pptx 逐个出正确魔数 + 体积达标 + 下载名合规（零 AI，纯离线生成）。
 *   G 组 并发闸：4 路并发周报恰好 2 接受 2 拒（上限默认 2）；批次跑完闸位归还；
 *              app_settings 调 1 后 2 路只放 1 路；混跑（1 路启动会在途 + 3 路周报）总并发不超上限。
 *   C 组 验收 1：启动会卡居第 7 位、前 6 卡顺序未被挤掉、同用 ReportCard、
 *              启动会进互斥全量派生、深链走「确保展开」而非卡片 toggle。
 *              **断言对象是真实 ReportPage 的渲染产物与真实 handler**（T02293 判据 1/3/4）：
 *              esbuild 编译期追加私有组件导出 → 门内最小 hooks 调度器调用真实页面函数拿元素树，
 *              再按卡片位次真按 onToggle / 真调 openCard / 真读 sessionStorage 写点。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02113-kickoff-regression.mts
 * 环境变量：`T02113_PORT`（默认随机 39700+rand300）。
 * 隔离纪律（skill 红线 8）：门内夹具库（initSchema 自建 + 自造业务行，零读生产库，T02940），设置项只写夹具库，端口临时，收尾删目录。
 * 结果落 .workbuddy/t02113-gate-results-<运行标识>.txt。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { waitIsolatedServer, bootEvidence } from '../lib/gate-boot.mts'; // T02965：就绪判据单源
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGateResults } from '../lib/gate-results.mts';
import { okPair } from '../lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.T02113_PORT ?? 39_700 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02113-reg-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// C 组：验收 1 —— 断言真实 ReportPage 的渲染产物与真实交互（T02293 判据 1/3/4）
//
// 取产物通道与 verify-t02143 同源：
//  - esbuild 的 onLoad 钩子在**编译期**给 ReportPage.tsx 尾巴追加 `export { X as __gate_X }`，
//    产物落在 .workbuddy/ 的本轮临时目录，跑完即删——产品工作树零写入；
//  - 门内最小 hooks 调度器调用**真实 ReportPage 函数**，拿它自己产出的元素树（卡片顺序、
//    面板开关 props、openCard 都是真的），再按位次真按卡片的 onToggle、真调 openCard；
//  - react-dom/server 渲染**真实 ReportCard** 的产物，量标题/描述与容器形态。
// 取不到追加导出（组件改名/挪走）时 esbuild 只给 warning，本门显式判红（红因「真实组件取不到」）。
// 仅 C-03/C-04 保留源码正则作 okPair 的**字面腿**（文案/组件名漂移信号），行为腿读渲染产物。
// =====================================================================
const C_SCRATCH = join(OUT_DIR, `t02113-c-${process.pid}-${Date.now()}`);
mkdirSync(C_SCRATCH, { recursive: true });

interface HNode { tag: string; attrs: Record<string, string>; children: HNode[]; text: string; }
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** 把渲染出来的 HTML 串解析成节点树（与 t02143 同款最小解析器，认引号内 > / 自闭合 / void / 原始文本） */
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
    if (tag === 'style' || tag === 'script') {
      const close = `</${tag}>`; const end = src.indexOf(close, i);
      node.text = src.slice(i, end < 0 ? src.length : end); i = end < 0 ? src.length : end + close.length; continue;
    }
    stack.push(node);
  }
  return root;
}
function textOfHtml(html: string): string {
  const walk = (list: HNode[]): string => list.map((n) => n.text + walk(n.children)).join(' ');
  return walk(parseHtml(html)).replace(/\s+/g, ' ').trim();
}
/** 元素树遍历（数组/元素两种节点；只走 props.children，不看 HTML） */
/**
 * 收集元素树里满足条件的元素。
 *
 * `expand`：需要额外「调用一次拿返回树」的 props-only 展示组件名。
 * 为什么需要：`OfflineWorkPanel` / `AiLiveWorkPanel` 是独立函数组件，父级 children 里只有
 * `<OfflineWorkPanel …/>` 这个元素本身，内部的「收起 …工作面板」按钮不在父元素树上，
 * 不展开就永远采不到（T05074 实测 C-02 的 closeLabels 恒为空数组）。
 * 只在渲染期无 hooks 的展示组件上展开；抛错（含 hook 调用）就跳过，绝不影响其它采集。
 */
function collectEls(node: any, pred: (el: any) => boolean, out: any[] = [], expand?: Set<string>): any[] {
  if (Array.isArray(node)) { node.forEach((n) => collectEls(n, pred, out, expand)); return out; }
  if (!node || typeof node !== 'object' || node.$$typeof === undefined) return out;
  if (pred(node)) out.push(node);
  const type = node.type;
  if (expand && typeof type === 'function' && expand.has(type.name ?? '')) {
    try { collectEls(type(node.props), pred, out, expand); } catch { /* 含 hooks 的组件不展开 */ }
  }
  collectEls(node.props?.children, pred, out, expand);
  return out;
}
/** 只把「数组里的元素」摊平（卡片 map 的输出），不深入元素自身的 children */
function flattenElements(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) { node.forEach((n) => flattenElements(n, out)); return out; }
  if (node && typeof node === 'object' && node.$$typeof !== undefined) out.push(node);
  return out;
}

/** 编译真实产品模块并把模块私有组件暴露出来（编译期追加导出，产品文件不动；照 t02143） */
async function buildProduct(productFile: string, expose: string[], tag: string): Promise<Record<string, any>> {
  const esbuild = (await import('esbuild')).default as any;
  const outfile = join(C_SCRATCH, `${tag}.mjs`);
  await esbuild.build({
    absWorkingDir: ROOT, entryPoints: [productFile], bundle: true, format: 'esm', keepNames: true,
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
  for (const n of expose) {
    if (mod[`__gate_${n}`] === undefined) throw new Error(`产品里取不到私有组件 ${n}（改名或挪走了 → 本门失明）`);
  }
  return mod;
}

/** 最小 hooks 调度器：调用真实组件函数拿它自己产出的元素树（照 t02143，React 18 语义最小子集） */
function mount(Comp: any, props: any) {
  const React = (globalThis as any).__gateReact ?? null;
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
  return { render, runEffects: () => eff.splice(0).forEach((f) => { try { f(); } catch { /* 无 DOM 宿主的异步副作用不参与判定 */ } }) };
}

/** 门内存储桩：Map 后端 + 写点记账（C-09 的判据对象是真实 setItem 写点） */
function storageStub() {
  const m = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  return {
    m, writes,
    st: {
      get length() { return m.size; },
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, String(v)); writes.push({ key: k, value: String(v) }); },
      removeItem: (k: string) => { m.delete(k); },
      clear: () => m.clear(),
    },
  };
}

async function probeCGroup(React: any, renderToStaticMarkup: (el: any) => string) {
  const PAGE = readFileSync(join(ROOT, 'web', 'src', 'pages', 'ReportPage.tsx'), 'utf8');
  const cardsSrc = PAGE.slice(PAGE.indexOf('const reportCards: ReportCardCfg[] = ['));
  const cardsBody = cardsSrc.slice(0, cardsSrc.indexOf('\n  ];'));
  const RP = await buildProduct(join(ROOT, 'web', 'src', 'pages', 'ReportPage.tsx'), ['ReportPage', 'ReportCard', 'ReportWorkPanels'], 'reportpage');
  const ReportPage = RP.__gate_ReportPage;
  const ReportCard = RP.__gate_ReportCard;
  const ReportWorkPanels = RP.__gate_ReportWorkPanels;

  // 卡片网格与面板容器都按**渲染产物**定位：网格是页面自己渲染的 grid 容器，卡片顺序即其子元素顺序
  const findGrid = (tree: any) => collectEls(tree, (e: any) => !!e.props?.style
    && e.props.style.display === 'grid' && String(e.props.style.gridTemplateColumns ?? '').includes('auto-fit'))[0];
  const cardsOf = (tree: any) => {
    const grid = findGrid(tree);
    return grid ? flattenElements(grid.props?.children).filter((e: any) => typeof e.type === 'function') : [];
  };
  const findPanels = (tree: any) => collectEls(tree, (e: any) => e.type === ReportWorkPanels)[0];
  const showFlags = (props: any) => Object.keys(props).filter((k) => k.startsWith('show') && typeof props[k] === 'boolean');
  const openOf = (tree: any) => {
    const p = findPanels(tree);
    return p ? showFlags(p.props).filter((k) => p.props[k] === true) : [];
  };
  /** 卡片自身 open prop 的读数：offline / ai-live 面板不走 ReportWorkPanels，只有卡片 open 能统一覆盖全部 8 张 */
  const openIdxOf = (tree: any) => cardsOf(tree).map((c: any, i: number) => (c.props.open === true ? i : -1)).filter((i: number) => i >= 0);

  const SESSION = (globalThis as any).__gateSession;
  const fresh = (seed?: Record<string, string>) => {
    SESSION.m.clear(); SESSION.writes.length = 0;
    if (seed) for (const [k, v] of Object.entries(seed)) SESSION.m.set(k, v);
    const inst = mount(ReportPage, {});
    const render = () => {
      const tree = inst.render();
      // offline / ai-live 面板就地渲染在页面里，用它们真实渲染出的「收起 …工作面板」按钮 aria-label 认身份
      // T05074：离线 / AI 周报两张卡的面板是独立展示组件，需展开后才能采到关闭钮的 aria-label；
      // 其余内联面板照旧（expand 只对白名单组件生效）。
      const closeLabels = collectEls(tree, (e: any) => typeof e.props?.['aria-label'] === 'string'
        && /^收起 .*工作面板$/.test(e.props['aria-label']), [], new Set(['OfflineWorkPanel', 'AiLiveWorkPanel']))
        .map((e: any) => e.props['aria-label'] as string);
      return { tree, cards: cardsOf(tree), open: openIdxOf(tree), flags: openOf(tree), closeLabels, panels: findPanels(tree) };
    };
    return { inst, render };
  };

  const first = fresh().render();
  const cardCount = first.cards.length;
  // 逐卡真按 onToggle：位次 → 真正展开的卡片位次 + 真渲染出来的面板身份（容器 flag / 直挂面板关闭钮标签）
  const singleOpen: Array<{ title: string; aria: string; open: number[]; flags: string[]; closeLabels: string[] }> = [];
  for (let i = 0; i < cardCount; i++) {
    const f = fresh(); const r = f.render();
    const card = r.cards[i];
    card.props.onToggle();
    const r2 = f.render();
    singleOpen.push({ title: card.props.title, aria: card.props.aria, open: r2.open, flags: r2.flags, closeLabels: r2.closeLabels });
  }
  const kickoffHits = singleOpen.map((c, i) => (c.flags.includes('showKickoffPpt') ? i : -1)).filter((i) => i >= 0);
  const kickoffIdx = kickoffHits[0] ?? -1;
  const prdImportIdx = singleOpen.findIndex((c) => c.flags.includes('showPrdImport'));
  const tcGenIdx = singleOpen.findIndex((c) => c.flags.includes('showTcGen'));

  // C-03 料：真实启动会卡片（按行为位次取出）经 react-dom/server 渲染出的文本
  let kickoffHtml = '';
  let kickoffText = '';
  let kickoffTitle = '';
  if (kickoffIdx >= 0) {
    const card = fresh().render().cards[kickoffIdx];
    kickoffTitle = card.props.title;
    kickoffHtml = renderToStaticMarkup(React.createElement(ReportCard, card.props));
    kickoffText = textOfHtml(kickoffHtml);
  }
  // C-04 料：首张卡的真实产物容器形态 + 网格里有没有非 ReportCard 的卡片
  let c04Container: HNode | undefined;
  let c04Html = '';
  if (first.cards[0]) {
    c04Html = renderToStaticMarkup(React.createElement(ReportCard, first.cards[0].props));
    c04Container = parseHtml(c04Html)[0];
  }
  const foreignCards = first.cards.filter((c: any) => c.type !== ReportCard).length;

  // C-05：互斥含启动会（先开 A 再开 B，只剩 B；反向亦然）
  const c05 = { kickoffThenPrd: [] as string[], prdThenKickoff: [] as string[] };
  if (kickoffIdx >= 0 && prdImportIdx >= 0) {
    const fa = fresh(); let ra = fa.render();
    ra.cards[kickoffIdx].props.onToggle(); ra = fa.render();
    ra.cards[prdImportIdx].props.onToggle(); ra = fa.render();
    c05.kickoffThenPrd = ra.open;
    const fb = fresh(); let rb = fb.render();
    rb.cards[prdImportIdx].props.onToggle(); rb = fb.render();
    rb.cards[kickoffIdx].props.onToggle(); rb = fb.render();
    c05.prdThenKickoff = rb.open;
  }

  // C-06：任意两张卡交替按 → 只剩后按的那一张（全量互斥；漏登记 setter 必有对子失守）
  const badPairs: any[] = [];
  let pairChecks = 0;
  if (cardCount > 0) {
    // 每个 i 用独立挂载：若复用同一实例，上一轮内层最后一次点击留下的展开态会让下一轮 i 的首次点击变成「收起」
    for (let i = 0; i < cardCount; i++) {
      const f = fresh(); let r = f.render();
      r.cards[i].props.onToggle(); r = f.render();
      if (!(r.open.length === 1 && r.open[0] === i)) badPairs.push({ 阶段: '打开', i, open: r.open });
      for (let j = 0; j < cardCount; j++) {
        if (j === i) continue;
        r.cards[j].props.onToggle(); r = f.render(); pairChecks += 1;
        if (!(r.open.length === 1 && r.open[0] === j)) badPairs.push({ i, j, open: r.open });
      }
    }
  }

  // C-07：启动会面板只由 ReportWorkPanels 挂载一次（页面树里不得另挂一份）
  let containerKickoff = -1;
  let pageDirectKickoff = -1;
  let panelSiblings: string[] = [];
  if (kickoffIdx >= 0) {
    const f = fresh(); let r = f.render();
    r.cards[kickoffIdx].props.onToggle(); r = f.render();
    pageDirectKickoff = collectEls(r.tree, (e: any) => typeof e.type === 'function' && e.type.name === 'KickoffPptPanel').length;
    if (r.panels) {
      const frag = mount(ReportWorkPanels, r.panels.props).render();
      containerKickoff = collectEls(frag, (e: any) => typeof e.type === 'function' && e.type.name === 'KickoffPptPanel').length;
      panelSiblings = collectEls(frag, (e: any) => typeof e.type === 'function' && /Panel$/.test(e.type.name ?? '')).map((e: any) => e.type.name);
    }
  }

  // C-08：openCard 是「确保展开」（已展开再调不收起），与卡片 toggle 的收起语义相反
  const c08 = { alreadyOpen: [] as string[], afterOpenCard: [] as string[], afterCardToggle: [] as string[], fromClosed: [] as string[] };
  if (prdImportIdx >= 0 && tcGenIdx >= 0) {
    const f = fresh(); let r = f.render();
    r.cards[prdImportIdx].props.onToggle(); r = f.render();
    c08.alreadyOpen = r.open;
    (r.panels.props.openCard as any)('prd-import'); r = f.render();
    c08.afterOpenCard = r.open;
    r.cards[prdImportIdx].props.onToggle(); r = f.render();
    c08.afterCardToggle = r.open;
    (r.panels.props.openCard as any)('tc-gen'); r = f.render();
    c08.fromClosed = r.open;
  }

  // C-09：会话持久化读+写（预置 kickoff 键 → 卡片打开；effects 跑完 → 真实 setItem 写点）
  const fa = fresh({ 'report.showKickoffPpt': 'true' });
  const ra = fa.render();
  const c09KickoffOpen = ra.open;
  const c09KickoffCardOpen = kickoffIdx >= 0 ? ra.cards[kickoffIdx].props.open : null;
  fa.inst.runEffects();
  const c09Writes = SESSION.writes.filter((w) => w.key.startsWith('report.show')).map((w) => `${w.key}=${w.value}`);
  const fb = fresh({ 'report.showTcGen': 'true' });
  const c09PeerOpen = fb.render().open;

  return {
    PAGE, cardsBody, cardCount, singleOpen, kickoffHits, foreignCards, c04Container, c04Html,
    kickoffText, kickoffHtml, kickoffTitle,
    c05, badPairs, pairChecks, kickoffIdx, prdImportIdx, tcGenIdx,
    containerKickoff, pageDirectKickoff, panelSiblings,
    c08, c09KickoffOpen, c09KickoffCardOpen, c09Writes, c09PeerOpen,
  };
}

// 渲染环境：只补真实页面在 Node 下会读到的浏览器全局（照 t02143；fetch 改成失败桩，跑完还原）
const realFetch = (globalThis as any).fetch;
const SESSION_STUB = storageStub();
const LOCAL_STUB = storageStub();
const g = globalThis as any;
g.sessionStorage = SESSION_STUB.st;
g.localStorage = LOCAL_STUB.st;
g.__gateSession = SESSION_STUB;
g.document ??= { baseURI: 'http://127.0.0.1:39901/', body: { nodeType: 1, appendChild() {} }, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: () => ({ nodeType: 1, style: {} }) };
g.window ??= { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1280, innerHeight: 800 };
g.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) });

let C: any = null;
let cError = '';
try {
  const React = (await import('react')).default as any;
  (globalThis as any).__gateReact = React;
  const { renderToStaticMarkup } = await import('react-dom/server');
  C = await probeCGroup(React, renderToStaticMarkup);
} catch (e) {
  cError = `真实组件取不到：${String((e as Error)?.message ?? e).slice(0, 260)}`;
} finally {
  (globalThis as any).fetch = realFetch;
  try { rmSync(C_SCRATCH, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }
}
const cCtx = (extra: any) => (cError ? { 红因: cError, ...extra } : extra);
/** C 组读数留痕：不参与 PASS/FAIL 计数，但绿的时候也能复核「量到什么」（判据 4 的可复核性） */
const evid = (name: string, value: unknown) => lines.push(`[EVID] ${name} → ${JSON.stringify(value).slice(0, 500)}`);

ok('C-01 工作卡片「启动会 PPT 生成」居第 7 位（其后只允许尾部追加，不得插队）',
  !!C && C.cardCount >= 7 && C.kickoffHits.length === 1 && C.kickoffHits[0] === 6
  && C.singleOpen[6].open.length === 1 && C.singleOpen[6].open[0] === 6
  && C.singleOpen[6].flags.includes('showKickoffPpt'),
  cCtx({ 卡片数: C?.cardCount, 第7位卡标题: C?.singleOpen[6]?.title, 打开启动会面板的卡片位次: C?.kickoffHits, 第7位按下后展开的卡片: C?.singleOpen[6]?.open }));
evid('C-01 读数', { 卡片数: C?.cardCount, 第7位卡标题: C?.singleOpen[6]?.title, 打开启动会面板的卡片位次: C?.kickoffHits, 第7位按下后展开的卡片: C?.singleOpen[6]?.open });
ok('C-02 前 6 张卡顺序未被挤掉（新卡只能尾部追加——历史坑：插中间会让既有深链/持久化错位）',
  !!C && C.cardCount >= 7
  && JSON.stringify(C.singleOpen.slice(0, 6).map((c: any) => c.title))
    === JSON.stringify(['AI 项目计划导入', '离线周报生成', 'AI 周报生成', '原始需求生成 PRD', '从 PRD 导入项目计划', '从 PRD 生成测试用例'])
  && C.singleOpen.slice(0, 6).every((c: any, i: number) => c.open.length === 1 && c.open[0] === i)
  && C.singleOpen[0].flags.join() === 'showAiImport'
  && C.singleOpen[1].closeLabels.includes('收起 离线周报生成工作面板')
  && C.singleOpen[2].closeLabels.includes('收起 AI 周报生成工作面板')
  && C.singleOpen[3].flags.join() === 'showPrdGen'
  && C.singleOpen[4].flags.join() === 'showPrdImport'
  && C.singleOpen[5].flags.join() === 'showTcGen',
  cCtx({ 前6卡标题: C?.singleOpen.slice(0, 6).map((c: any) => c.title), 前6卡按下后展开的卡片: C?.singleOpen.slice(0, 6).map((c: any) => c.open), 前6卡面板身份: C?.singleOpen.slice(0, 6).map((c: any) => [...c.flags, ...c.closeLabels]) }));
evid('C-02 读数', { 前6卡标题: C?.singleOpen.slice(0, 6).map((c: any) => c.title), 前6卡按下后展开的卡片: C?.singleOpen.slice(0, 6).map((c: any) => c.open), 前6卡面板身份: C?.singleOpen.slice(0, 6).map((c: any) => [...c.flags, ...c.closeLabels]) });
okPair(ok, 'C-03 启动会卡片标题与描述逐字守 PRD 口径（FR-1.1 文案漂移会让验收 1 的「样式同源」失去参照）',
  () => {
    if (cError) throw new Error(cError);
    return C.kickoffText.includes('启动会 PPT 生成') && /原生可编辑\s*\.pptx/.test(C.kickoffText);
  },
  () => /title: '启动会 PPT 生成'/.test(C.cardsBody) && /原生可编辑 \.pptx/.test(C.cardsBody),
  () => ({ 渲染标题: C?.kickoffTitle, 渲染文本: String(C?.kickoffText ?? '').slice(0, 160), 红因: cError || undefined }));
evid('C-03 读数', { 渲染标题: C?.kickoffTitle, 渲染文本: String(C?.kickoffText ?? '').slice(0, 200) });
okPair(ok, 'C-04 卡片仍由同一个 ReportCard 渲染（没有为启动会另造卡片组件——样式同源的定义就是同组件）',
  () => {
    if (cError) throw new Error(cError);
    // T05074：T02143 起外框有意是 div（HTML 不允许按钮套按钮），可点击/可聚焦的部分改由
    // 「铺满卡片的原生 button」承担——无障碍语义没有丢，判据改看这个内层按钮而非外框 role。
    const innerButton = (C?.c04Container?.children ?? []).find((n: any) => n.tag === 'button');
    return C.cardCount >= 7 && C.foreignCards === 0
      && C.c04Container?.tag === 'div'
      && !!innerButton && typeof innerButton.attrs['aria-label'] === 'string' && innerButton.attrs['aria-label'].length > 0;
  },
  () => /function ReportCard\(/.test(C.PAGE) && /<ReportCard\b/.test(C.PAGE) && !/function KickoffPptCard|<KickoffPptCard/.test(C.PAGE),
  () => {
    const innerButton = (C?.c04Container?.children ?? []).find((n: any) => n.tag === 'button');
    return {
      卡片数: C?.cardCount, 非ReportCard卡数: C?.foreignCards,
      卡片产物容器: { tag: C?.c04Container?.tag, role: C?.c04Container?.attrs?.role },
      内层原生按钮: innerButton ? { ariaLabel: innerButton.attrs['aria-label'], title: innerButton.attrs['title'] } : null,
      红因: cError || undefined,
    };
  });
evid('C-04 读数', {
  卡片数: C?.cardCount, 非ReportCard卡数: C?.foreignCards,
  卡片产物容器: { tag: C?.c04Container?.tag, role: C?.c04Container?.attrs?.role },
  产物首行: String(C?.c04Html ?? '').slice(0, 120),
});
ok('C-05 互斥集含 kickoffPpt（新增面板进同一套 setters，不再手挑 setX(false)）',
  !!C && JSON.stringify(C.c05.kickoffThenPrd) === JSON.stringify([C.prdImportIdx])
  && JSON.stringify(C.c05.prdThenKickoff) === JSON.stringify([C.kickoffIdx]),
  cCtx({ ...C?.c05, 启动会卡位次: C?.kickoffIdx, PRD导入卡位次: C?.prdImportIdx }));
evid('C-05 读数', { 先启动会再PRD导入的展开: C?.c05.kickoffThenPrd, 先PRD导入再启动会的展开: C?.c05.prdThenKickoff, 启动会卡位次: C?.kickoffIdx, PRD导入卡位次: C?.prdImportIdx });
ok('C-06 互斥全量派生（任意两张卡交替按，永远只剩后按的那一张；漏关任何面板必有对子失守）',
  !!C && C.pairChecks > 0 && C.badPairs.length === 0 && C.singleOpen.every((c: any) => c.open.length === 1),
  cCtx({ 对子检查数: C?.pairChecks, 失守对子: C?.badPairs }));
evid('C-06 读数', { 对子检查数: C?.pairChecks, 失守对子: C?.badPairs, 逐卡自展开的卡片: C?.singleOpen.map((c: any) => c.open) });
ok('C-07 启动会面板只有一个挂载点，且与其余面板同在 ReportWorkPanels 内（互斥与重置都走同一容器）',
  !!C && C.pageDirectKickoff === 0 && C.containerKickoff === 1
  && C.panelSiblings.length === 1 && C.panelSiblings[0] === 'KickoffPptPanel',
  cCtx({ 页面直挂命中: C?.pageDirectKickoff, 容器内命中: C?.containerKickoff, 同容器面板: C?.panelSiblings }));
evid('C-07 读数', { 页面直挂命中: C?.pageDirectKickoff, 容器内命中: C?.containerKickoff, 同容器面板: C?.panelSiblings });
ok('C-08 校验清单深链走「确保展开」而非卡片 toggle（面板已展开时 toggle 会收起——用户点「去补充」反而没了）',
  !!C && JSON.stringify(C.c08.alreadyOpen) === JSON.stringify([C.prdImportIdx])
  && JSON.stringify(C.c08.afterOpenCard) === JSON.stringify([C.prdImportIdx])
  && C.c08.afterCardToggle.length === 0
  && JSON.stringify(C.c08.fromClosed) === JSON.stringify([C.tcGenIdx]),
  cCtx({ ...C?.c08, PRD导入卡位次: C?.prdImportIdx, TC生成卡位次: C?.tcGenIdx }));
evid('C-08 读数', { ...C?.c08, PRD导入卡位次: C?.prdImportIdx, TC生成卡位次: C?.tcGenIdx });
ok('C-09 面板开关态走会话持久化（report.showKickoffPpt 与其余卡片同一 useSessionState 口径）',
  !!C && JSON.stringify(C.c09KickoffOpen) === JSON.stringify([C.kickoffIdx])
  && C.c09KickoffCardOpen === true
  && C.c09Writes.includes('report.showKickoffPpt=true')
  && C.c09Writes.includes('report.showTcGen=false')
  && JSON.stringify(C.c09PeerOpen) === JSON.stringify([C.tcGenIdx]),
  cCtx({ 预置kickoff后的开面板: C?.c09KickoffOpen, 卡片open: C?.c09KickoffCardOpen, 'report.show写点': C?.c09Writes, 预置tcGen后的开面板: C?.c09PeerOpen }));
evid('C-09 读数', { 预置kickoff后的开面板: C?.c09KickoffOpen, 卡片open: C?.c09KickoffCardOpen, 'report.show写点': C?.c09Writes, 预置tcGen后的开面板: C?.c09PeerOpen });

// =====================================================================
// mock AI（只给 G 组混跑时占用启动会那一路用；周报四格式全程零 AI）
// =====================================================================
let mockDelayMs = 0;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ risks: [], comms: [] }) } }] }));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 隔离实例：门内夹具库（T02940，照 t02144 批83 口径）——initSchema 自建表 + 自造最小业务行，零读生产库
// =====================================================================
const { resolveServerLauncher } = await import('../isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const Database = (await import('better-sqlite3')).default;
{
  // 先把 DATA_DIR 写进本进程环境再动态 import connection——连接单例按它定位库文件（t02144 同款）
  process.env.MTask_DATA_DIR = DATA_DIR;
  const conn = (await import('../../server/src/db/connection.ts')) as Record<string, any>;
  const { initSchema } = (await import('../../server/src/db/schema.ts')) as Record<string, any>;
  const db = conn.getDb();
  initSchema(); // 由产品自己建表（含自带种子行），门不复制任何生产业务行
  const NOW = new Date().toISOString();
  const PID = 't02113-fixture-project';
  // 回归样本项目沿用历史项目名（X-01 按名定位），内容是门内自造夹具，不含任何生产业务数据
  db.prepare('INSERT INTO projects (id,name,description,sort_weight,created_at,updated_at,workspace_path) VALUES (?,?,?,?,?,?,?)')
    .run(PID, 'mtask四期', 'T02940 门内夹具项目（改判前由生产库副本的 mtask四期满足）', 0, NOW, NOW, ROOT);
  // 周报聚合（gatherReportData）读 tasks + plan_tasks：按报告周期（本周）自造足量行，
  // 保证四格式产物稳过 R-02 的 >10KB 非空壳阈值
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const summaryText = '已完成该夹具任务的实现与自测：覆盖入口接线、参数校验、导出链路与回归项；实现要点与边界条件已记录，遗留事项无。'
    + '本段摘要用于让周报四格式（xlsx/docx/pdf/pptx）的聚合产物达到非空壳体积阈值。'.repeat(6);
  const insTask = db.prepare(
    `INSERT INTO tasks (id,task_no,project_id,title,description,priority,status,verified,archived,ai_summary,pinned,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'done',1,0,?,0,?,?)`,
  );
  // 数量与标题长度按 R-02（>10KB）实测定：tasks 只渲一行「[状态/优先级] 标题（项目） 时间」，
  // 夹具靠足量任务行把四格式产物顶过非空壳阈值（200×~60字标题；docx 压缩率最高，实测是最后一个过线的格式）
  for (let i = 0; i < 200; i++) {
    insTask.run(
      `${PID}-t${i}`, `T02940-${100 + i}`, PID,
      `夹具任务 ${i + 1}：交付验收项——入口接线 / 参数校验 / 导出链路 / 回归清单 / 遗留事项归档`,
      '本门自造夹具任务，供周报聚合取数；不含任何生产业务数据。'.repeat(3),
      i % 3 === 0 ? 'high' : 'normal',
      summaryText, NOW, NOW,
    );
  }
  const insPlan = db.prepare(
    `INSERT INTO plan_tasks (id,project_id,title,description,start_date,end_date,duration_days,progress,status,assignee,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,?,3,?,'doing','夹具责任人',?,?,?)`,
  );
  for (let i = 0; i < 20; i++) {
    insPlan.run(`${PID}-p${i}`, PID, `夹具阶段 ${i + 1}：需求澄清 / 方案设计 / 编码实现 / 联调验收`,
      '本门自造夹具计划行（日期覆盖报告周期）', day(i - 3), day(i), (i % 5) + 2, i, NOW, NOW);
  }
}
ok('R-00 门内夹具库已建（initSchema 自建表 + 自造夹具项目 mtask四期，零读生产库——改判前这里是 94MB 生产库只读副本）',
  existsSync(join(DATA_DIR, 'mtask.db')));

const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

async function waitUp(): Promise<boolean> {
  // T02965：原实现只判 service，未就绪时无 upMs/预算/轮询次数读数——读者分不清「环境慢」与「判据失守」（判据 4）
  const b = await waitIsolatedServer({ base: BASE.replace(/\/api$/, ''), budgetMs: 180_000, envName: 'T02113_BOOT_BUDGET' });
  if (!b.up) console.log(`  · 就绪失败读数：${bootEvidence(b)}`);
  return b.up;
}
async function genReport(format: string, projectId: string) {
  const res = await fetch(BASE + '/report/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: 'week', format, projectId }),
  });
  const ctype = res.headers.get('content-type') ?? '';
  const disp = res.headers.get('content-disposition') ?? '';
  const buf = ctype.includes('json') ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
  const json = ctype.includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, ctype, disp, buf, json };
}
/** 启动会那一路只用来「占住闸位」，不需要读到完整产物 */
async function kickoffStreamPending(toolId: string, projectId: string, outline: any[]) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4_000);
  try {
    const res = await fetch(BASE + `/plans/kickoff-ppt-stream?projectId=${projectId}&toolId=${toolId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, toolId, outline }), signal: ac.signal,
    });
    return { status: res.status, ctype: res.headers.get('content-type') ?? '' };
  } catch {
    return { status: 0, ctype: 'aborted' };
  } finally {
    clearTimeout(timer);
  }
}

if (!(await waitUp())) {
  ok('X-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('X-00 隔离实例启动', true);
  const rdb = new Database(join(DATA_DIR, 'mtask.db'), { readonly: true });
  const rq = <T,>(sql: string, ...a: unknown[]) => rdb.prepare(sql).all(...a) as T[];
  const pid = rq<{ id: string; name: string }>('SELECT id, name FROM projects WHERE archived = 0 AND name = ?', 'mtask四期')[0];
  ok('X-01 回归样本项目存在（mtask四期，真实资料）', !!pid?.id, pid);

  // ---------------- R 组：周报四格式导出仍是「内容正确」而非只回 200 ----------------
  const MAGIC: Record<string, (b: Buffer) => boolean> = {
    xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b,
    docx: (b) => b[0] === 0x50 && b[1] === 0x4b,
    pptx: (b) => b[0] === 0x50 && b[1] === 0x4b,
    pdf: (b) => b.slice(0, 4).toString('latin1') === '%PDF',
  };
  for (const fmt of ['xlsx', 'docx', 'pdf', 'pptx']) {
    const r = await genReport(fmt, pid.id);
    ok(`R-01.${fmt} 周报 ${fmt} 导出 200 且魔数正确（OOXML=PK / PDF=%PDF，不是 JSON 错误体）`,
      r.status === 200 && MAGIC[fmt](r.buf), { status: r.status, bytes: r.buf.length, err: r.json?.error });
    ok(`R-02.${fmt} 周报 ${fmt} 产物非空壳（>10KB）`, r.buf.length > 10_000, { bytes: r.buf.length });
    ok(`R-03.${fmt} 下载名走 RFC5987 且后缀对（中文名不被退回 xlsx 名）`,
      /filename\*=UTF-8''[^;]+/.test(r.disp) && decodeURIComponent(r.disp).includes(`.${fmt}`), r.disp.slice(0, 120));
  }
  const bad = await fetch(BASE + '/report/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: 'week', format: 'md', projectId: pid.id }),
  });
  ok('R-04 非法格式仍被 400 拦（枚举校验没被启动会接入带松）', bad.status === 400, bad.status);

  // ---------------- G 组：并发上限在周报侧仍真的生效 ----------------
  const batch = await Promise.all(['xlsx', 'docx', 'pdf', 'pptx'].map((f) => genReport(f, pid.id)));
  const accepted = batch.filter((r) => r.status === 200).length;
  const rejected = batch.filter((r) => r.status === 429).length;
  ok('G-01 4 路并发周报 → 恰好 2 接受 + 2 拒（上限默认 2，超限拒绝而不是排队）',
    accepted === 2 && rejected === 2, batch.map((r) => r.status));
  ok('G-02 被拒的两路是结构化中文 429（前端可读文案重试，不是一片空白）',
    batch.filter((r) => r.status === 429).every((r) => typeof (r.json?.error ?? r.json?.message) === 'string' && (r.json?.error ?? r.json?.message).length > 0),
    batch.filter((r) => r.status === 429).map((r) => r.json));
  await sleep(1_500);
  // 单发一次确认闸位已彻底归零——上一批若有在途残留，这里就会被误判成「永久锁死」
  await genReport('pptx', pid.id);
  const after = await Promise.all([genReport('xlsx', pid.id), genReport('pdf', pid.id)]);
  ok('G-03 批次跑完闸位归还（再发 2 路全接受，不锁死）',
    after.every((r) => r.status === 200), after.map((r) => r.status));

  const tool = await fetch(BASE + '/aitools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 't02113-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', model: 'mock-wording', timeoutMs: 20000 }),
  });
  const toolId = ((await tool.json().catch(() => null)) as any)?.id as string | undefined;
  ok('X-02 mock AI 工具已建（混跑只占闸位，零真实配额）', !!toolId, toolId);
  // 混跑：1 路启动会（措辞在途，闸位被占）+ 3 路周报 → 总计 ≤2 在途
  mockDelayMs = 3_000;
  const mixOutline = Array.from({ length: 12 }, (_, i) => ({
    section: i === 0 ? '封面' : i === 6 ? '项目计划' : i === 7 ? '工作量评估' : '项目需求',
    title: i === 0 ? '项目启动会' : `回归占位页 ${i + 1}`,
    bullets: i === 0 ? [] : ['范围与交付物'],
    dataKeys: i === 6 ? ['timeline'] : i === 7 ? ['workload'] : ['reqStats'],
    layout: i === 0 ? 'cover' : i === 6 ? 'timeline' : i === 7 ? 'chart' : 'table',
  }));
  const mix = await Promise.all([
    kickoffStreamPending(String(toolId), pid.id, mixOutline),
    genReport('xlsx', pid.id), genReport('docx', pid.id), genReport('pptx', pid.id),
  ]);
  mockDelayMs = 0;
  const mixOk = mix.filter((r: any) => r.status === 200).length;
  const mix429 = mix.filter((r: any) => r.status === 429).length;
  ok('G-04 混跑同闸生效：启动会在途 + 3 路周报 → 总接受数不超上限 2 且确有请求被拒（两处共用一闸的行为证据，不只是同名）',
    mixOk >= 1 && mixOk <= 2 && mix429 >= 1, mix.map((r: any) => r.status));
  await sleep(2_000);

  {
    const wdb = new Database(join(DATA_DIR, 'mtask.db'));
    wdb.prepare("insert into app_settings(key,value) values('exportGateLimit.report-generate','1') " +
      'on conflict(key) do update set value=excluded.value').run();
    wdb.close();
  }
  await sleep(300);
  const pair = await Promise.all([genReport('xlsx', pid.id), genReport('pdf', pid.id)]);
  ok('G-05 上限经 app_settings 即时生效（副本库调 report-generate=1 → 2 路只放 1 路；只写副本不碰生产）',
    pair.filter((r) => r.status === 200).length === 1 && pair.filter((r) => r.status === 429).length === 1,
    pair.map((r) => r.status));
  {
    const wdb = new Database(join(DATA_DIR, 'mtask.db'));
    wdb.prepare("delete from app_settings where key = 'exportGateLimit.report-generate'").run();
    wdb.close();
  }
  await sleep(300);
  await genReport('pdf', pid.id); // 同上：先单发把上一批的在途计数放干，再验默认上限
  const back = await Promise.all([genReport('xlsx', pid.id), genReport('docx', pid.id)]);
  ok('G-06 删键回落默认 2（配置读取是逐请求的，没有缓存住旧上限）',
    back.every((r) => r.status === 200), back.map((r) => r.status));

  ok('G-07 回归全程服务端无未捕获异常（闸与 worker 池没被并发打挂）',
    !/unhandledRejection|uncaughtException/.test(serverLog.join('')),
    (serverLog.join('').match(/unhandledRejection|uncaughtException[^\n]{0,120}/) ?? []).slice(0, 2));
  rdb.close();
}

// =====================================================================
// 收口
// =====================================================================
child.kill();
mock.close();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }

const summary = `T02113 回归门：PASS ${pass} / FAIL ${fail}\n` + lines.join('\n');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't02113-gate-results.txt'), summary, 'utf8');
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
