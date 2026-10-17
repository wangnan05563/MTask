/**
 * T02277/T02286 门：把「任务页新建行窄窗几何」的一次性取证探针固化为可复跑的 UI 回归门。
 *
 * 缺陷本体（T02277 已修，commit 2cf3dce）：`web/src/pages/TasksPage.tsx` 的新建任务行里，
 * 标题输入框 `flex:1` 却没有 `min-width` 下限 → 窗口收窄时它一路缩到 0，同行按钮被推出视口；
 * 行容器 `flexWrap` 因为「还能缩」而永远不触发换行，兜底形同虚设。表现为 ≤456px 时
 * 「添加任务」按钮跑出右边界、整页出现横向可滚区（与 T02167 窄窗溢出同族）。
 * 修复是给输入框 `minWidth: 80`（见 TasksPage renderNewTaskForm 的 T02277 注释）——
 * 80 而非 0 的意义正是「让容器有机会换行」，所以本门把「按钮在视口内」「行内不越界」「无横向滚动」
 * 与「输入框宽度下限」四条钉死在 456/380/320/280/1100 五个宽度档上。
 *
 * 这类缺陷是**纯几何**的：`tsc --noEmit` 不报错、生产构建不留警告、单元测试看不到，
 * 只有把真实视口压到窄档并量 `getBoundingClientRect()` 才能暴露——所以本门走无头 Chrome + CDP。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02277-narrow-newrow.mts
 *   npm run verify:narrow-newrow（登记归 T02317：本仓 package.json 正被并发会话占用，门不代改）
 * 负对照（证明门拦得住）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02277-narrow-newrow.mts --negative-control
 *   用一段 `<style>` 把修复前样式回放回去（`input{min-width:auto}` + 行容器 `{flex-wrap:nowrap;row-gap:0}`），
 *   要求 456/380/320/280 四个窄档**必须出现几何 FAIL**、1100 档保持绿、且未注入态（B 组）仍全绿
 *   ——「注入才红」才算门拦得住；把源码改回缺陷形态再重建 dist 的老办法（T02192 门）在这里不需要：
 *   本缺陷的判据完全由样式决定，改样式回放既更快又不动工作区源码。
 *
 * 环境变量：
 *   T02277_GATE_PORT（默认 39971）、T02277_GATE_CDP（默认 39972）、T02277_GATE_CHROME、
 *   T02277_GATE_TMP_ROOT（默认 D:/code/tmp，**勿指 C:**——C: 常年 0 可用会假性失败）、
 *   T02277_GATE_SKIP_BUILD=1 复用现有 web/dist（此时用 E-03 比对 dist 与 web/src 的 mtime，dist 落后即拒绝跑），
 *   T02277_GATE_DIST=<目录> 指向自备产物，
 *   T02277_GATE_DBG=1 打印每档原始量测（门的失败信息必须自解释，绿时也别把现场丢掉）。
 *
 * 与蓝本门 verify-t02192-prdgen-pointer.mts 的两处刻意不同（都为了「不碰别人的东西」）：
 *   1. **默认把 dist 构建进临时目录**（`vite build --outDir <tmp>`），绝不覆写共享的 `web/dist`——
 *      本仓常有并发会话同时在跑 UI 门，重建共享产物会把对方的判据换成本轮工作树的 WIP；
 *      自建产物也让 E-03 天然成立（判据必然来自当前源码）。SKIP_BUILD=1 才复用 web/dist 并启用 mtime 比对。
 *   2. 负对照只注入样式、不改源码、不重建（见上），跑完自动移除，工作区零残留。
 *
 * 前置（照搬蓝本门踩过的坑）：启动前用 addScriptToEvaluateOnNewDocument 种好
 *   各菜单「使用向导」seen 标记（native <dialog open> 在 top-layer 会吃掉真实指针事件）、
 *   `mtask.uiMode=desktop`（否则窄视口被判定成移动态、量不到桌面新建行）、
 *   `tasks.activeProject`（任务页要先有项目才会渲染工具条与新建行）。
 *
 * 结果同时打 stdout 与写 `.workbuddy/t02277-newrow-gate-results-<运行标识>.txt`（口径见 scripts/lib/gate-results.mts）。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const REPO_DIST = join(WEB, 'dist');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02277-newrow-gate-results.txt';

const NEGATIVE = process.argv.includes('--negative-control');
const PORT = Number(process.env.T02277_GATE_PORT ?? 39971);
const CDP_PORT = Number(process.env.T02277_GATE_CDP ?? 39972);
const CHROME = process.env.T02277_GATE_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const DBG = process.env.T02277_GATE_DBG === '1';

/** 宽度档：456/380/320/280 为修复前会溢出的窄档，1100 为宽窗对照（缺陷态/修复态都该绿） */
const WIDTHS = [456, 380, 320, 280, 1100];
const NARROW = [456, 380, 320, 280];
/** 输入框宽度下限（T02277 修复给的正是 80；有人把它调回 0 就让换行兜底失效） */
const MIN_INPUT_W = 80;
/** 几何比较容差（子像素/滚动条取整噪声） */
const EPS = 0.5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const lines: string[] = [];
const pageErrors: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1; else fail += 1;
  const tail = cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
};
const note = (s: string) => { lines.push(`[INFO] ${s}`); console.log(`  · ${s}`); };

// ---------------- 桩服 ----------------
const PID = 'gate-t02277-project';
const PROJECTS = [{
  id: PID, name: 'T02277 门禁项目', description: '', sort_weight: 0,
  created_at: '2026-10-16T00:00:00.000Z', todo_count: 0, done_count: 0, unverified_count: 0,
  plan_done: 0, plan_doing: 0, plan_open: 0, workspace_path: '',
}];
const TOOLS = [{
  id: 'gate-tool', name: '门禁桩工具', type: 'openai-compat', purpose: 'task-organize',
  endpoint: `${BASE}/api/stub-completions`, model: 'gate-model', model_notes: '',
  temperature: 0.2, max_tokens: 4096, timeout_ms: 60000, enabled: true,
  isDefaultOrganize: false, isDefaultDevelop: false, pinned: false, remark: '',
}];
const GUIDE_SEEN_KEYS = [
  'mtask.guide.seen.tasks', 'mtask.guide.seen.aitools', 'mtask.guide.seen.prompts',
  'mtask.guide.seen.req', 'mtask.guide.seen.report', 'mtask.guide.seen.history',
  'mtask.guide.seen.queue', 'mtask.guide.seen.exec-sessions', 'mtask.guide.seen.settings',
  'mtask.projectGuide.seen',
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
};

function startStubServer(distDir: string): { close: () => Promise<void> } {
  const server = createServer((req, res) => {
    const p = new URL(req.url ?? '/', BASE).pathname;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/health') return json(200, { ok: true, gate: 't02277' });
    if (p === '/api/projects') return json(200, PROJECTS);
    if (p === '/api/aitools') return json(200, TOOLS);
    if (p === '/api/aitools/defaults') return json(200, { organize: null, develop: null });
    if (p === '/api/task-categories') return json(200, []);
    if (p.startsWith('/api/events/')) return json(200, []);
    // 其余 /api/* 给中性空值：本门不起后端进程，多余接口不该把门带红。
    // GET 默认回 `[]`（本仓取数接口绝大多数是列表；回 `{}` 会让 `.map` 直接炸首屏），写操作回 `{}`。
    if (p.startsWith('/api/')) return json(200, (req.method ?? 'GET') === 'GET' ? [] : {});
    const rel = decodeURIComponent(p).replace(/^\/+/, '');
    const file = rel ? join(distDir, rel) : join(distDir, 'index.html');
    const candidate = existsSync(file) && statSync(file).isFile() ? file : join(distDir, 'index.html');
    if (!existsSync(candidate)) return json(404, { error: `产物缺失：${distDir}` });
    res.writeHead(200, { 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' });
    res.end(readFileSync(candidate));
    return undefined;
  });
  server.listen(PORT, '127.0.0.1');
  return { close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) };
}

/** 构建进临时目录（默认）——不覆写共享 web/dist */
function buildInto(outDir: string): void {
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
    '--outDir', outDir, '--emptyOutDir'], { cwd: WEB, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(String(r.stdout ?? '').slice(-2000));
    console.error(String(r.stderr ?? '').slice(-2000));
    throw new Error('vite build 失败——源码不可构建时门不给结论');
  }
}

/** 递归取目录下匹配文件的最新 mtime（附路径）；空目录返回 {at:0,path:''} */
function newest(dir: string, re: RegExp): { at: number; path: string } {
  let best = { at: 0, path: '' };
  if (!existsSync(dir)) return best;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const got = e.isDirectory() ? newest(p, re) : re.test(e.name) ? { at: statSync(p).mtimeMs, path: p } : null;
    if (got && got.at > best.at) best = got;
  }
  return best;
}
const stamp = (ms: number): string => (ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : '无');

// ---------------- CDP 客户端（Node 18+ 全局 WebSocket，无外部依赖） ----------------
type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<any>; close: () => void };
type Eval = (expr: string) => Promise<any>;

async function connectCdp(): Promise<Cdp> {
  let wsUrl = '';
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (r.ok) {
        const targets = (await r.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        wsUrl = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? '';
      }
    } catch { /* Chrome 还没起好 */ }
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) throw new Error(`CDP 端口 ${CDP_PORT} 拿不到 page target`);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('CDP 连接失败')); });
  let seq = 0;
  const waiting = new Map<number, (v: any) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      pageErrors.push(String(d?.exception?.description ?? d?.text ?? '').slice(0, 300));
    }
    if (msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)!(msg);
      waiting.delete(msg.id);
    }
  };
  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolvePromise) => {
        waiting.set(id, (msg) => {
          if (msg.error) resolvePromise({ __cdpError: msg.error.message });
          else resolvePromise(msg.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => { try { ws.close(); } catch { /* */ } },
  };
}

/** 页面求值统一套 IIFE（裸 return 交给 Runtime.evaluate 是语法错误） */
function makeEval(cdp: Cdp): Eval {
  return async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r?.__cdpError) throw new Error(r.__cdpError);
    return r?.result?.value;
  };
}

async function until(ev: Eval, expr: string, ms = 25_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    let v: unknown = null;
    try { v = await ev(`return (${expr});`); } catch { /* 导航/挂载未完成 */ }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
}

// ---------------- 量测 ----------------
const INPUT_SEL = 'input[placeholder="输入任务标题，回车创建"]';
/** 工单口径的行容器选择器（:has 直选）——同时用作「量的是不是这一行」的自证 */
const ROW_SEL = `div.op-host:has(> ${INPUT_SEL})`;
/** 修复前样式回放（蓝本探针 PRE_CSS 原文）：min-width 归零 + 行容器不换行 */
const PRE_CSS = `${INPUT_SEL}{min-width:auto !important}${ROW_SEL}{flex-wrap:nowrap !important;row-gap:0px !important}`;

/** 一次性量齐五档共用的几何现场；行不在场返回 null */
const MEASURE = `
  const input = document.querySelector('${INPUT_SEL}');
  if (!input) return null;
  const row = input.closest('div.op-host');
  if (!row) return null;
  const btn = [...row.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('添加任务'));
  const de = document.documentElement;
  const rc = (el) => { const b = el.getBoundingClientRect(); return { left: +b.left.toFixed(1), right: +b.right.toFixed(1), w: +b.width.toFixed(1) }; };
  const rowRect = rc(row);
  const kids = [...row.children].map((c) => {
    const b = rc(c);
    return { tag: c.tagName, cls: String(c.className ?? '').slice(0, 20), ...b,
      over: +Math.max(0, rowRect.left - b.left, b.right - rowRect.right).toFixed(1) };
  });
  return {
    vw: de.clientWidth, scrollWidth: de.scrollWidth,
    row: rowRect,
    rowStyle: { flexWrap: getComputedStyle(row).flexWrap, rowGap: getComputedStyle(row).rowGap },
    input: rc(input), inputMinWidth: getComputedStyle(input).minWidth,
    btn: btn ? rc(btn) : null,
    hasSelMatches: row === document.querySelector('${ROW_SEL}'),
    kids,
  };`;

type Geo = null | {
  vw: number; scrollWidth: number;
  row: { left: number; right: number; w: number };
  rowStyle: { flexWrap: string; rowGap: string };
  input: { left: number; right: number; w: number };
  inputMinWidth: string;
  btn: null | { left: number; right: number; w: number };
  hasSelMatches: boolean;
  kids: Array<{ tag: string; cls: string; left: number; right: number; w: number; over: number }>;
};

async function setWidth(cdp: Cdp, w: number): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(450);
}

async function injectPre(ev: Eval): Promise<void> {
  await ev(`document.getElementById('__t02277_pre')?.remove();
    const s = document.createElement('style');
    s.id = '__t02277_pre';
    s.textContent = ${JSON.stringify(PRE_CSS)};
    document.head.appendChild(s);
    return 1;`);
  await sleep(250);
}
async function removePre(ev: Eval): Promise<void> {
  await ev(`document.getElementById('__t02277_pre')?.remove(); return 1;`);
  await sleep(250);
}

/** 单档三条几何断言 + 一条输入框下限断言 */
function assertWidth(prefix: string, w: number, d: Geo): void {
  if (!d) {
    ok(`${prefix}-${w}-0 新建任务行在场`, false, '量测返回 null：行不在 DOM');
    return;
  }
  const btnRight = d.btn?.right ?? Number.NaN;
  ok(`${prefix}-${w}-1「添加任务」按钮右边界 ≤ 视口宽 +${EPS}（实测 right=${btnRight} / clientWidth=${d.vw}，越界 ${(btnRight - d.vw).toFixed(1)}px）`,
    !!d.btn && d.btn.right <= d.vw + EPS, { btn: d.btn, vw: d.vw });
  const offenders = d.kids.filter((k) => k.over > EPS);
  ok(`${prefix}-${w}-2 行容器子元素不越出行边框 ±${EPS}（${d.kids.length} 个子元素，越界 ${offenders.length} 个）`,
    d.kids.length > 0 && offenders.length === 0, { offenders, row: d.row, rowStyle: d.rowStyle });
  ok(`${prefix}-${w}-3 整页无横向可滚区 scrollWidth ≤ clientWidth +${EPS}（实测 ${d.scrollWidth}/${d.vw}）`,
    d.scrollWidth <= d.vw + EPS, { scrollWidth: d.scrollWidth, vw: d.vw });
  ok(`${prefix}-W-${w} 输入框宽度 ≥ ${MIN_INPUT_W}px（实测 ${d.input.w}，min-width=${d.inputMinWidth}，行 flexWrap=${d.rowStyle.flexWrap}/rowGap=${d.rowStyle.rowGap}）`,
    d.input.w >= MIN_INPUT_W, { input: d.input, minWidth: d.inputMinWidth });
  if (DBG) note(`DBG @${w}：${JSON.stringify(d)}`);
}

async function runUiChecks(distDir: string): Promise<void> {
  ok('E-01 Chrome 可执行文件在场（可用 T02277_GATE_CHROME 覆盖）', existsSync(CHROME), CHROME);
  ok('E-02 门禁产物 index.html 在场', existsSync(join(distDir, 'index.html')), distDir);
  if (!existsSync(CHROME) || !existsSync(join(distDir, 'index.html'))) return;

  const TMP = mkdtempSync(join(process.env.T02277_GATE_TMP_ROOT && existsSync(process.env.T02277_GATE_TMP_ROOT)
    ? process.env.T02277_GATE_TMP_ROOT : (existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir()), 't02277-gate-'));
  const profile = join(TMP, 'chrome');
  mkdirSync(profile, { recursive: true });
  const stub = startStubServer(distDir);
  let chrome: ReturnType<typeof spawn> | null = null;
  let cdp: Cdp | null = null;
  try {
    chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
      '--hide-scrollbars', '--window-size=1500,1000', 'about:blank',
    ], { stdio: 'ignore' });
    cdp = await connectCdp();
    const ev = makeEval(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        for (const k of ${JSON.stringify(GUIDE_SEEN_KEYS)}) localStorage.setItem(k, '1');
        localStorage.setItem('mtask.uiMode', 'desktop');
        localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(PID))});
      } catch { /* 隐私模式忽略 */ }`,
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${BASE}/?gate=t02277` });

    ok('U-01 应用首屏挂载（#root 有子节点，桩服 /api 通道可用）',
      await until(ev, `document.querySelector('#root')?.children.length > 0`, 30_000));
    await ev(`window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); return 1;`);
    const rowOk = await until(ev, `!!document.querySelector('${INPUT_SEL}')`, 20_000);
    ok('U-02 任务页新建行在场（标题输入框可达）', rowOk);
    if (!rowOk) {
      const state = await ev(`return { rootChildren: document.querySelector('#root')?.children.length ?? -1,
        inputs: [...document.querySelectorAll('input')].map(e => e.placeholder).slice(0, 8),
        dialogs: document.querySelectorAll('dialog[open]').length };`);
      note(`现场：${JSON.stringify(state)}${pageErrors.length ? ` 页面异常：${pageErrors.slice(-2).join(' || ')}` : ''}`);
      return;
    }
    await setWidth(cdp, 1440);
    const first = await ev(MEASURE) as Geo;
    ok('U-03 行容器与工单选择器 :has 命中同一节点（断言对象就是这一行）', first?.hasSelMatches === true, first && { hasSelMatches: first.hasSelMatches });

    if (NEGATIVE) {
      // B 组：未注入态必须仍然全绿——否则「注入才红」不成立，负对照判不了。
      for (const w of WIDTHS) {
        await setWidth(cdp, w);
        assertWidth('B', w, await ev(MEASURE) as Geo);
      }
      await setWidth(cdp, 1440);
      for (const w of WIDTHS) {
        await setWidth(cdp, w);
        await injectPre(ev);
        assertWidth('G', w, await ev(MEASURE) as Geo);
        await removePre(ev);
      }
      await shot(cdp, join(OUT_DIR, 't02277-newrow-negative.png'));
    } else {
      for (const w of WIDTHS) {
        await setWidth(cdp, w);
        assertWidth('N', w, await ev(MEASURE) as Geo);
      }
      await shot(cdp, join(OUT_DIR, 't02277-newrow-positive.png'));
    }
  } finally {
    cdp?.close();
    if (chrome?.pid) {
      try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
    }
    await stub.close();
    await removeTree(TMP);
  }
}

/** Chrome 进程被 taskkill 后释放 profile 目录有延迟，Windows 上首删常 EPERM——重试而不是把门带崩 */
async function removeTree(dir: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(600); }
  }
  console.log(`  ⚠ 临时目录未能即时删除（Chrome 仍占用），请手动清理：${dir}`);
}

async function shot(cdp: Cdp, path: string): Promise<void> {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (r?.data) writeFileSync(path, Buffer.from(String(r.data), 'base64'));
}

// ---------------- 主流程 ----------------
mkdirSync(OUT_DIR, { recursive: true });
const tmpRoot = process.env.T02277_GATE_TMP_ROOT && existsSync(process.env.T02277_GATE_TMP_ROOT)
  ? process.env.T02277_GATE_TMP_ROOT : 'D:/code/tmp';
console.log(`T02277 窄窗新建行门${NEGATIVE ? '【负对照】' : ''} · 桩服 ${BASE} · CDP ${CDP_PORT}`);

let distDir = process.env.T02277_GATE_DIST ?? REPO_DIST;
try {
  if (process.env.T02277_GATE_DIST) {
    note(`使用自备产物 T02277_GATE_DIST=${distDir}（不重建）`);
  } else if (process.env.T02277_GATE_SKIP_BUILD === '1') {
    // 复用共享 web/dist：判据可能来自旧源码，必须比对 mtime（蓝本门 E-03 同一条坑）
    const d = newest(REPO_DIST, /\.(html|js|css)$/);
    const s = newest(join(WEB, 'src'), /\.(tsx?|css)$/);
    const fresh = d.at > 0 && d.at >= s.at;
    ok('E-03 复用 web/dist 时其产物不早于 web/src 最新源码（门的判据来自当前源码）', fresh,
      `dist=${stamp(d.at)} 源码=${stamp(s.at)} 最新源码=${s.path.replace(/\\/g, '/')}`);
    distDir = REPO_DIST;
    if (!fresh) throw new Error('web/dist 比源码旧——去掉 SKIP_BUILD 让门自建产物后复跑');
  } else {
    const buildDir = mkdtempSync(join(existsSync(tmpRoot) ? tmpRoot : tmpdir(), 't02277-dist-'));
    console.log(`  · vite build → ${buildDir}（不覆写共享 web/dist）`);
    buildInto(buildDir);
    distDir = buildDir;
    note(`本轮判据来自当前工作树源码的自建产物 ${buildDir}`);
  }
  await runUiChecks(distDir);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`  ⚠ 门执行异常：${msg}`);
  lines.push(`[CRASH] 门自身执行抛异常（崩溃即门失效，不得当成通过）→ ${msg}`);
  fail += 1;
} finally {
  if (distDir !== REPO_DIST && !process.env.T02277_GATE_DIST) await removeTree(distDir);
}

if (NEGATIVE) {
  // 负对照判定：注入旧样式后，四个窄档必须各自至少一条几何断言转红；1100 档与 B 组（未注入）必须全绿。
  const geo = (prefix: string, w: number) => lines.filter((l) => l.startsWith('[') && l.includes(`] ${prefix}-${w}-`));
  const redAt = (w: number) => geo('G', w).some((l) => l.startsWith('[FAIL]'));
  const greenAt = (w: number) => geo('G', w).every((l) => l.startsWith('[PASS]'));
  const narrowMissing = NARROW.filter((w) => !redAt(w));
  const baselineBad = WIDTHS.some((w) => geo('B', w).some((l) => l.startsWith('[FAIL]')));
  const wideBad = greenAt(1100) === false;
  const caught = narrowMissing.length === 0 && !baselineBad && !wideBad;
  const detail = `窄档红：${NARROW.filter(redAt).join('/')}${narrowMissing.length ? `｜未拦住 ${narrowMissing.join('/')}` : ''}；1100 绿=${!wideBad}；未注入基线绿=${!baselineBad}`;
  lines.unshift(`[NEG] 负对照判定：${detail} —— ${caught ? '门拦得住（合格）' : '门拦不住或基线已红（失效，必须修门）'}`);
  console.log(`\n${lines[0]}`);
  pass = caught ? 1 : 0;
  fail = caught ? 0 : 1;
}

const resultsFile = writeGateResults(OUT_DIR, OUT_BASE,
  `T02277 窄窗新建行门${NEGATIVE ? '（负对照）' : ''}：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, { port: PORT, note: `widths=${WIDTHS.join(',')}` });
console.log(`\nPASS=${pass} FAIL=${fail} → ${resultsFile}`);
process.exit(fail === 0 ? 0 : 1);
