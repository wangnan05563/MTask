/**
 * T02192/T02203 门：把「真实指针事件 + DOM 变更计数」的取证手段固化为可复跑的 UI 回归门。
 *
 * 拦的缺陷族：渲染期新建对象/数组字面量作为 useEffect 依赖值 → 无限重渲染 → 受控 UI 节点被反复重挂载。
 * 这类缺陷编译器不报错、`tsc --noEmit` 不报错、生产构建连控制台警告都不留（React 开发期警告被构建剥掉），
 * 只有**真实指针交互**能暴露——DOM 级 `el.click()` 会掩盖它，所以本门一律走 CDP `Input.dispatchMouseEvent`。
 *
 * 缺陷本体（T02192 已修，commit f33e3b2）：`web/src/pages/PrdGenPanel.tsx` 渲染期写
 * `const result = activeItem ? { prdMd, issues } : snap.result`（每次渲染新引用），填充 rows 的
 * `useEffect([result])` 每帧触发 `setRows`，且行键用 `Date.now()` → 待确认问题表每次提交整表重挂载，
 * 表现为点击无法聚焦、拖拽无法圈选、「自定义问题」行一闪即被重置。
 *
 * 四步实现（与 T02192 取证探针一致）：
 *   1. 静态伺服 `web/dist` + 最小 API 桩（/health、/projects、/aitools、/plans/prd-generate-stream 回合法 SSE），
 *      不依赖真实模型与真实库（不起后端进程、不碰生产实例与生产数据目录）；
 *   2. 无头 Chrome + 原生 CDP 真实 mousedown / mousemove / mouseup；
 *   3. 断言重渲染计数 / 聚焦 / 输入留存 / 圈选 / 自定义行留存；
 *   4. 同页放一段对照文本（面板标题），确认「选不中」是区域缺陷而非探针坐标问题。
 *
 * 用法（系统 Chrome；本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02192-prdgen-pointer.mts
 *   npm run verify:prdgen-pointer
 * 环境变量：
 *   T02192_GATE_PORT（默认 39941）、T02192_GATE_CDP（默认 39942）、T02192_GATE_CHROME、
 *   T02192_GATE_TMP_ROOT（默认 D:/code/tmp，**勿指 C:**——C: 常年 0 可用会假性失败）、
 *   T02192_GATE_DBG=1 打印点击坐标/圈选矩形/断言失败现场（门的失败信息必须自解释）、
 *   T02192_GATE_SKIP_BUILD=1 复用现有 web/dist（改过前端源码时别用：门的判据必须来自当前源码；
 *     E-03 会比对 dist 与 web/src 的最新 mtime，dist 落后即拒绝跑交互组——本轮实测就是靠这条
 *     拦住了「负对照把 dist 重建成缺陷态后，SKIP_BUILD 复跑报出缺陷签名被误读成修复回退」）
 * 前置：探针启动前用 addScriptToEvaluateOnNewDocument 把各菜单「使用向导」的 seen 标记种好——
 *   PageGuideDialog 是 native <dialog open>（top-layer 模态），DOM 与 elementFromPoint 看起来一切正常，
 *   但真实指针事件全被它吃掉；首轮实测就是被这条挡住，误判成「卡片点了没反应」。
 * 负对照（T02203 验收标准第 2 条，证明门真的拦得住）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02192-prdgen-pointer.mts --negative-control
 *   把 PrdGenPanel.tsx 临时改回「渲染期新建字面量 + Date.now() 行键」，重建 dist 后跑同一组断言，
 *   要求交互组（U/R/F/C/Q/X/G 前缀）**必须出现 FAIL**；原文按字节备份，finally 与 exit 钩子双重回写，
 *   残留备份在下次启动时先回写（自愈）；收尾会按还原后的源码再重建一次 web/dist，不把缺陷产物留给下一次跑。
 *
 * 结果同时打 stdout 与写 `.workbuddy/t02192-pointer-gate-results.txt`（首行 `PASS=… FAIL=…`）。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const DIST = join(WEB, 'dist');
const PANEL_SRC = join(WEB, 'src', 'pages', 'PrdGenPanel.tsx');
const OUT_DIR = join(ROOT, '.workbuddy');
const RESULTS = join(OUT_DIR, 't02192-pointer-gate-results.txt');
const BACKUP = join(OUT_DIR, 't02192-pointer-source-backup.tsx');

const NEGATIVE = process.argv.includes('--negative-control');
const PORT = Number(process.env.T02192_GATE_PORT ?? 39941);
const CDP_PORT = Number(process.env.T02192_GATE_CDP ?? 39942);
const CHROME = process.env.T02192_GATE_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_REMOVAL_WINDOW_MS = 1500;
/** 缺陷态实测 2684 个被移除节点 / 修复态 0——阈值钉死 0，任何整表重挂载都算回归 */
const MAX_IDLE_REMOVALS = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const lines: string[] = [];
/** 页面未捕获异常（CDP Runtime.exceptionThrown）——断言红时用来直接给出原因 */
const pageErrors: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1; else fail += 1;
  const tail = cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
};

// ---------------- 桩服数据（形状对齐 web/src/api/client.ts 的 Project / AITool） ----------------
const PID = 'gate-t02192-project';
const PRD_MD = [
  '# 门禁验证 PRD',
  '',
  '## 1 背景',
  '本文正文由验证门桩服产出，仅用于拦截渲染期重渲染缺陷，不含业务语义。',
  '',
  '## 2 范围',
  '范围覆盖待确认问题交互表格的聚焦、圈选与自定义行留存；不覆盖真实模型调用与真实库写入。',
  '',
  '## 3 验收',
  '真实指针点击后输入框可获得焦点，输入内容在 800 毫秒后仍留在原节点，拖拽可选中目标区域文字。',
].join('\n');
const ISSUES = [
  { level: 'blocker', question: '门禁验证问题一：范围边界是否覆盖移动端', context: '原始需求未说明移动端', suggestion: '建议明确移动端不在本期范围' },
  { level: 'suggested', question: '门禁验证问题二：结论回写是否需要二次确认', context: '回写会覆盖既有 PRD 正文', suggestion: '建议保留覆盖模式并给出提示' },
  { level: 'info', question: '门禁验证问题三：待确认问题的级别取值口径', context: '级别枚举来自技能契约', suggestion: '建议沿用 blocker/suggested/info' },
];
const PROJECTS = [{
  id: PID, name: 'T02192 门禁项目', description: '', sort_weight: 0,
  created_at: '2026-10-16T00:00:00.000Z', todo_count: 0, done_count: 0, unverified_count: 0,
  plan_done: 0, plan_doing: 0, plan_open: 0, workspace_path: '',
}];
const TOOLS = [{
  id: 'gate-tool', name: '门禁桩工具', type: 'openai-compat', purpose: 'prd-generate',
  endpoint: `${BASE}/api/stub-completions`, model: 'gate-model', model_notes: '',
  temperature: 0.2, max_tokens: 4096, timeout_ms: 60000, enabled: true,
  isDefaultOrganize: false, isDefaultDevelop: false, pinned: false, remark: '',
}];
const TYPED_ANSWER = '门禁结论A';
const TYPED_CUSTOM = '自定义：门禁校验项';
/** 各菜单「使用向导」的已读标记键（web/src/pages/guides.tsx + ProjectGuide.tsx 的 seenKey 口径） */
const GUIDE_SEEN_KEYS = [
  'mtask.guide.seen.tasks', 'mtask.guide.seen.aitools', 'mtask.guide.seen.prompts',
  'mtask.guide.seen.req', 'mtask.guide.seen.report', 'mtask.guide.seen.history',
  'mtask.guide.seen.queue', 'mtask.guide.seen.exec-sessions', 'mtask.guide.seen.settings',
  'mtask.projectGuide.seen',
];

/** 一个 SSE 事件块（`event:` + `data:`，空行分隔——与 web/src/api/sse.ts 的解析口径一致） */
const sseBlock = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
};

function startStubServer(): { close: () => Promise<void> } {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', BASE);
    const p = url.pathname;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/health') return json(200, { ok: true, gate: 't02192' });
    if (p === '/api/projects') return json(200, PROJECTS);
    if (p === '/api/aitools') return json(200, TOOLS);
    if (p === '/api/aitools/defaults') return json(200, { organize: null, develop: null });
    if (p === '/api/task-categories') return json(200, []);
    if (p.startsWith('/api/events/')) return json(200, []);
    if (p === '/api/plans/prd-docs') return json(200, []);
    if (p === '/api/plans/prd-generate-stream') {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache', Connection: 'close',
        });
        res.write(sseBlock('stage', { msg: '已接收原始需求，正在解析正文' }));
        res.write(sseBlock('chunk', { text: PRD_MD.slice(0, 40) }));
        res.write(sseBlock('chunk', { text: PRD_MD.slice(40) }));
        res.write(sseBlock('stage', { msg: '正在识别待确认问题' }));
        res.write(sseBlock('done', { prdMd: PRD_MD, issues: ISSUES }));
        res.end();
      });
      return undefined;
    }
    // 其余 /api/* 给中性空值：本门不依赖真实后端，多余接口不该把门带红。
    // GET 默认回 `[]`（本仓取数接口绝大多数是列表；回 `{}` 会让 `.map` 直接炸首屏），写操作回 `{}`。
    if (p.startsWith('/api/')) return json(200, (req.method ?? 'GET') === 'GET' ? [] : {});
    // 静态伺服 web/dist（带 SPA 兜底）
    const rel = decodeURIComponent(p).replace(/^\/+/, '');
    const file = rel ? join(DIST, rel) : join(DIST, 'index.html');
    const candidate = existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
    if (!existsSync(candidate)) return json(404, { error: 'web/dist 不存在——门会先跑一次构建' });
    res.writeHead(200, { 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' });
    res.end(readFileSync(candidate));
    return undefined;
  });
  server.listen(PORT, '127.0.0.1');
  return { close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) };
}

/** 默认每次重建 dist：门的判据必须来自当前源码，否则负对照与回归都无从谈起 */
function buildWeb(): void {
  if (process.env.T02192_GATE_SKIP_BUILD === '1') {
    console.log('  (跳过构建：T02192_GATE_SKIP_BUILD=1，复用现有 web/dist)');
    return;
  }
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: WEB, encoding: 'utf8',
  });
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

/**
 * dist 与源码的新鲜度：源码改过但没重建时，门判的是旧产物，结论不可信。
 * 本轮实测踩过：跑完 --negative-control（它会把 dist 重建成缺陷态）再用 SKIP_BUILD=1 复跑正对照，
 * 报出的是缺陷签名（PASS=12 FAIL=7），一度被误读成「修复回退了」。
 */
function distFreshness(): { fresh: boolean; distAt: number; srcAt: number; srcPath: string; skipBuild: boolean } {
  const d = newest(DIST, /\.(html|js|css)$/);
  const s = newest(join(WEB, 'src'), /\.(tsx?|css)$/);
  return { fresh: d.at > 0 && d.at >= s.at, distAt: d.at, srcAt: s.at, srcPath: s.path, skipBuild: process.env.T02192_GATE_SKIP_BUILD === '1' };
}

const stamp = (ms: number): string => (ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : '无');

// ---------------- CDP 客户端（Node 18+ 全局 WebSocket，无外部依赖） ----------------
type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  close: () => void;
};
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
    // 页面未捕获异常收集：断言失败时把原因直接打出来，避免「门红了但看不出为什么红」
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

/** 面板内求值统一套 IIFE（裸 return 交给 Runtime.evaluate 是语法错误，T02040 踩过） */
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

const GATE = {
  select: '[aria-label="选择目标项目"]',
  customQuestion: 'tbody input[placeholder="自定义问题描述"]',
};
/** 面板根与目标表：从项目下拉往上找第一个含 tbody 的祖先（不依赖内联样式与 DOM 层级细节）。
 * 写成自执行**表达式**而非语句串——until()/ev() 会把它嵌进 `return (…)`，语句里的裸 return 是语法错误。 */
const LOCATE_PANEL = `(function () {
  let el = document.querySelector('${GATE.select}');
  while (el && !el.querySelector('tbody')) el = el.parentElement;
  window.__panel = el;
  window.__tbody = el ? el.querySelector('tbody') : null;
  return !!window.__tbody;
})()`;

/** 真实指针点击（CDP Input.dispatchMouseEvent）——DOM 级 el.click() 会掩盖本类缺陷，禁止改用 */
async function realPoint(cdp: Cdp, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** 取元素视口中心（先滚进可视区）；传 text 时按文本匹配按钮/卡片（面板控件无稳定 class） */
async function centerOf(ev: Eval, selector: string, text?: string): Promise<{ x: number; y: number } | null> {
  return ev(text
    ? `
      const el = [...document.querySelectorAll('button,[role="button"]')]
        .find(b => (b.textContent ?? '').includes(${JSON.stringify(text)}));
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    `
    : `
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    `);
}

async function realClickOn(cdp: Cdp, ev: Eval, selector: string, text?: string): Promise<void> {
  const p = await centerOf(ev, selector, text);
  if (!p) throw new Error(`找不到点击目标：${text ?? selector}`);
  if (process.env.T02192_GATE_DBG === '1') console.log(`  · 点击 (${p.x.toFixed(0)},${p.y.toFixed(0)}) ${text ?? selector}`);
  await realPoint(cdp, p.x, p.y);
}

/**
 * 真实拖拽圈选：按下→分步移动→释放，返回选区文本。
 * y 取元素**首行**（顶边 + 8px）而非几何中心——表格单元格里的正文常折行，中心点会落在两行之间的行距带上，
 * 拖不出选区（实测：单行标题可中、两行问题正文按中心拖恒空），与缺陷无关，别据此判红。
 * 释放前**重新取元素位置**——缺陷态元素已被换成新节点/新矩形，按老坐标收尾会把「选不中」误读成选区丢失。
 */
async function dragSelect(
  cdp: Cdp, ev: Eval, elementExpr: string,
): Promise<{ selected: boolean; text: string; found: boolean }> {
  await ev(`window.getSelection().removeAllRanges(); return 1;`);
  const rect = await ev(`
    const el = (${elementExpr});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x1: r.x + 2, x2: r.right - 2, y: r.y + Math.min(8, r.height / 2) };
  `);
  if (!rect) return { selected: false, text: '', found: false };
  if (process.env.T02192_GATE_DBG === '1') {
    const info = await ev(`const el = (${elementExpr}); return el ? { text: (el.textContent ?? '').slice(0, 24), w: Math.round(el.getBoundingClientRect().width), tag: el.tagName } : null;`);
    console.log(`  · 圈选目标 ${JSON.stringify(info)} 矩形 ${JSON.stringify(rect)}`);
    // 起/终点各被谁接住——top-layer 的浮层（toast/向导/遮罩）不参与 elementFromPoint 的语义差异，这里一并看清
    const hits = await ev(`
      const a = document.elementFromPoint(${rect.x1}, ${rect.y});
      const b = document.elementFromPoint(${rect.x2}, ${rect.y});
      const top = [...document.querySelectorAll('dialog[open], [aria-modal="true"], [class*=toast], [class*=notice]')].map(e => e.tagName + '.' + String(e.className).slice(0, 20));
      return { start: a ? a.tagName + ':' + (a.textContent ?? '').slice(0, 12) : null, end: b ? b.tagName + ':' + (b.textContent ?? '').slice(0, 12) : null, top };
    `);
    console.log(`  · 圈选命中 ${JSON.stringify(hits)}`);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x1, y: rect.y, button: 'left', clickCount: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x1 + ((rect.x2 - rect.x1) * i) / steps, y: rect.y, button: 'left' });
  }
  const after = await ev(`
    const el = (${elementExpr});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x2: r.right - 2, y: r.y + Math.min(8, r.height / 2) };
  `);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: after?.x2 ?? rect.x2, y: after?.y ?? rect.y, button: 'left', clickCount: 1,
  });
  await sleep(150);
  const text = await ev(`return window.getSelection().toString();`);
  return { selected: typeof text === 'string' && text.trim().length > 0, text: String(text ?? ''), found: true };
}

async function shot(cdp: Cdp, path: string): Promise<void> {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (r?.data) writeFileSync(path, Buffer.from(String(r.data), 'base64'));
}

/** 断言失败时打印页面现场（树是否还在 / 点到的到底是谁 / 有无未捕获异常）——门的失败信息必须自解释 */
async function dumpPage(ev: Eval, where: string): Promise<void> {
  const state = await ev(`
    const card = document.querySelector('[aria-label="原始需求生成 PRD"]');
    const r = card && card.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return {
      rootChildren: document.querySelector('#root')?.children.length ?? -1,
      cards: [...document.querySelectorAll('[aria-label="原始需求生成 PRD"]')].map(e => e.tagName + '/' + (e.getAttribute('role') ?? '')),
      cardRect: (() => { const r = card && card.getBoundingClientRect(); return r ? Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.x) + ',' + Math.round(r.y) : null; })(),
      hit: hit ? hit.tagName + '#' + (hit.getAttribute('aria-label') ?? '') + '.' + String(hit.className).slice(0, 40) : null,
      hitIsCardOrChild: !!hit && !!(card && (hit === card || card.contains(hit))),
      hitChain: (() => { const a = []; let n = hit; while (n && a.length < 5) { a.push(n.tagName + '.' + String(n.className).slice(0, 24)); n = n.parentElement; } return a.join(' < '); })(),
      select: !!document.querySelector('[aria-label="选择目标项目"]'),
      showPrdGenKey: sessionStorage.getItem('report.showPrdGen'),
      strongs: [...document.querySelectorAll('strong')].map(e => e.textContent).slice(0, 10),
      dialogs: document.querySelectorAll('dialog[open], [role="dialog"]').length,
    };
  `);
  console.log(`  · 现场(${where})：${JSON.stringify(state)}`);
  if (pageErrors.length > 0) console.log(`  · 页面异常：${pageErrors.slice(-3).join(' || ')}`);
}

/**
 * 静态特征扫描（T02203 加分项）：组件体内 `const x = cond ? { … } : …`（未被 useMemo 包裹）
 * 且该 `x` 出现在某个 useEffect 依赖数组里 → 命中即告警。
 * 只认两空格缩进的声明行（组件体顶层），避免把回调/函数内的局部对象误报进来。
 * 三元两分支必须**跨行**也能咬住：T02192 的缺陷原文就是 `? {` 换行写的，
 * 单行版正则只在负对照里失效过一次（门的静态守卫不能只认一种排版）。
 */
function scanRenderPhaseDeps(): { files: number; hits: string[] } {
  const hits: string[] = [];
  const srcRoot = join(WEB, 'src');
  const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((f: string) => f.endsWith('.tsx'))
    .map((f: string) => join(srcRoot, f));
  for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // 声明 → 到第一个分号为止的初始值（可跨行，上限 400 字符防失控）
    const decl = /^ {2}const ([A-Za-z_$][\w$]*) = ([^;]{0,400});/gm;
    let m: RegExpExecArray | null;
    while ((m = decl.exec(text))) {
      const [, name, init] = m;
      if (/^\s*(?:useMemo|useCallback)\s*[<(]/.test(init) || init.includes('useMemo(') || init.includes('useCallback(')) continue;
      // 「渲染期新建字面量」的形态：三元真分支是对象/数组字面量，或初始值本身就是字面量。
      // 刻意不认「冒号分支是字面量」——那会被 TS 类型标注里的 `xx?: { … }` 误咬（SettingsPage 实测踩过）。
      const buildsLiteral = /\?\s*[[{]/.test(init) || /^\s*[[{]/.test(init);
      if (!buildsLiteral) continue;
      // 依赖数组必须是 hook 尾（`}, [x])`）而非任意 `[x]`——对象下标访问 `obj?.[k]` 不算
      if (new RegExp(`\\}\\s*,\\s*\\[[^\\]]*\\b${name}\\b[^\\]]*\\]\\)`).test(text)) {
        hits.push(`${file.slice(ROOT.length + 1)}：const ${name} = … 在渲染期新建字面量，且出现在某 useEffect 依赖数组里`);
      }
    }
  }
  return { files: files.length, hits };
}

async function runUiChecks(): Promise<void> {
  const tmpRoot = process.env.T02192_GATE_TMP_ROOT ?? 'D:/code/tmp';
  if (!existsSync(tmpRoot)) console.log(`  ⚠ T02192_GATE_TMP_ROOT=${tmpRoot} 不存在，回落 os.tmpdir()（C: 满盘会假性失败）`);
  const TMP = mkdtempSync(join(existsSync(tmpRoot) ? tmpRoot : tmpdir(), 't02192-gate-'));
  const profile = join(TMP, 'chrome');
  mkdirSync(profile, { recursive: true });

  ok('E-01 Chrome 可执行文件在场（可用 T02192_GATE_CHROME 覆盖）', existsSync(CHROME), CHROME);
  ok('E-02 web/dist 已就绪（index.html 存在）', existsSync(join(DIST, 'index.html')));
  if (!existsSync(CHROME) || !existsSync(join(DIST, 'index.html'))) return;

  // E-03：判据必须来自当前源码。dist 比源码旧时，交互组跑的是旧产物——本轮实测被这条坑过一次
  // （负对照把 dist 重建成缺陷态后，SKIP_BUILD 复跑正对照报出缺陷签名，误读成「修复回退了」）。
  const fresh = distFreshness();
  ok('E-03 web/dist 不早于 web/src 最新源码（门的判据来自当前源码）', fresh.fresh,
    `dist=${stamp(fresh.distAt)} 源码=${stamp(fresh.srcAt)} 最新源码=${fresh.srcPath.replace(/\\/g, '/')}`);
  if (!fresh.fresh && !NEGATIVE) {
    console.log('  ⚠ dist 比源码旧：交互组判的是旧产物，结论不作数。'
      + `${fresh.skipBuild ? '（当前 T02192_GATE_SKIP_BUILD=1）' : ''}`
      + '请去掉 SKIP_BUILD 让门自行构建后复跑；刚跑过 --negative-control 时 dist 会被重建为缺陷态。');
    return;
  }

  const stub = startStubServer();
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
    // T00706 的「首次进入菜单 · 使用向导」是 native <dialog open>，位于 top-layer：
    // DOM 里卡片仍在原处、elementFromPoint 也照样命中卡片，但真实指针事件全被模态层吃掉——
    // 首轮就在这里踩过「点了卡片没反应」。本门测的是重渲染/聚焦/圈选，不是向导，
    // 故在应用脚本之前把各菜单的 seen 标记种好（localStorage 正是 markGuideSeen 用的口径）。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `for (const k of ${JSON.stringify(GUIDE_SEEN_KEYS)}) { try { localStorage.setItem(k, '1'); } catch { /* 隐私模式忽略 */ } }`,
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${BASE}/?gate=t02192` });

    // ---------- 走到「原始需求生成 PRD」面板 ----------
    ok('U-01 应用首屏挂载（#root 有子节点，桩服 /api 通道可用）',
      await until(ev, `document.querySelector('#root')?.children.length > 0`, 30_000));
    await ev(`window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'report' } })); return 1;`);
    const cardOk = await until(ev, `!!document.querySelector('[aria-label="原始需求生成 PRD"]')`, 20_000);
    ok('U-02 工作台卡片「原始需求生成 PRD」可达', cardOk);
    if (!cardOk) return;
    // T02143/T02146：卡片是 div[role=button]（HTML 禁止按钮套按钮），探针按 aria-label 取，两种形态都认
    await realClickOn(cdp, ev, '[aria-label="原始需求生成 PRD"]');

    const panelOk = await until(ev, `!!document.querySelector('${GATE.select}')`, 15_000);
    ok('U-03 面板打开且项目下拉在场', panelOk);
    if (!panelOk) { await dumpPage(ev, 'U-03'); return; }

    // 选目标项目（写 React 受控 select 的标准姿势：原生 value setter + change 冒泡）
    await ev(`
      const sel = document.querySelector('${GATE.select}');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(sel, '${PID}');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    `);
    // 注入原始需求文件（DataTransfer → input.files → change），再真实点击「确认」发起生成
    await ev(`
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(PRD_MD.slice(0, 60))}], '门禁验证原始需求.md', { type: 'text/markdown' }));
      const input = document.querySelector('input[type=file]');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.files.length;
    `);
    ok('U-04 文件入已选列表并出现「确认（1）」',
      await until(ev, `[...document.querySelectorAll('button')].some(b => (b.textContent ?? '').includes('确认（1）'))`, 10_000));
    await realClickOn(cdp, ev, '', '确认（1）');
    ok('U-05 待确认问题表已填充（桩 SSE 走完 stage/chunk/done，行数含 AI 问题）',
      await until(ev, `${LOCATE_PANEL}`, 30_000));
    if (!await ev(`return window.__tbody && window.__tbody.querySelectorAll('tr').length >= ${ISSUES.length};`)) return;

    // ---------- R 组：空闲态重渲染计数（缺陷族的本体指纹） ----------
    await ev(`
      window.__rem = 0;
      window.__obs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.removedNodes) if (n.nodeType === 1) window.__rem += 1;
      });
      window.__obs.observe(window.__tbody, { childList: true, subtree: true });
      return 1;
    `);
    await sleep(IDLE_REMOVAL_WINDOW_MS);
    const removals = Number(await ev(`window.__obs.disconnect(); return window.__rem;`));
    ok(`R-01 空闲 ${IDLE_REMOVAL_WINDOW_MS}ms 内 tbody 被移除节点数 ≤ ${MAX_IDLE_REMOVALS}（实测 ${removals}；缺陷态实测 2684）`,
      removals <= MAX_IDLE_REMOVALS, { removals });

    // ---------- F 组：真实点击聚焦 + 输入留存 ----------
    const answerBox = await ev(`
      const el = window.__tbody.querySelector('tr td:nth-child(4) input');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    `);
    if (!answerBox) {
      ok('F-00 结论输入框在场', false, answerBox);
      return;
    }
    await realPoint(cdp, answerBox.x, answerBox.y);
    await sleep(120);
    const focused = await ev(`
      const el = window.__tbody.querySelector('tr td:nth-child(4) input');
      el.__t02192 = 1;
      return document.activeElement === el;
    `);
    ok('F-01 真实指针点击后结论输入框获得焦点（缺陷态恒 false）', focused === true, focused);
    await cdp.send('Input.insertText', { text: TYPED_ANSWER });
    await sleep(800);
    const kept = await ev(`
      const el = window.__tbody.querySelector('tr td:nth-child(4) input');
      return { sameNode: el?.__t02192 === 1, value: el?.value ?? '' };
    `);
    ok(`F-02 输入「${TYPED_ANSWER}」后 800ms 值仍在（实测「${kept?.value}」）`, kept?.value === TYPED_ANSWER, kept);
    ok('F-03 800ms 后仍是同一 DOM 节点（未被整表重挂载顶替）', kept?.sameNode === true, kept);

    // ---------- C/Q 组：真实拖拽圈选 ----------
    const control = await dragSelect(cdp, ev, `
      [...window.__panel.querySelectorAll('strong')].find(e => e.textContent === '原始需求生成 PRD')
    `);
    ok('C-01 对照文本（面板标题）真实拖拽可选中——探针坐标与选区通道正常',
      control.selected && control.text.includes('原始需求'), control);
    const question = await dragSelect(cdp, ev, `window.__tbody.querySelector('tr td:nth-child(2) span')`);
    ok('Q-01 待确认问题正文真实拖拽可选中且落定后仍在（缺陷态被重挂载打断）',
      question.selected && question.text.length > 4, question);

    // ---------- X 组：自定义问题行留存（缺陷态一闪即被重置） ----------
    const rowCount = Number(await ev(`return window.__tbody.querySelectorAll('tr').length;`));
    await realClickOn(cdp, ev, '', '自定义问题');
    await sleep(250);
    const afterAdd = Number(await ev(`return window.__tbody.querySelectorAll('tr').length;`));
    ok(`X-01「自定义问题」点击后行数 +1（${rowCount} → ${afterAdd}）`, afterAdd === rowCount + 1, { rowCount, afterAdd });
    const customBox = await ev(`
      const el = document.querySelector('${GATE.customQuestion}');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      el.__t02192c = 1;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    `);
    if (!customBox) {
      ok('X-02 自定义行问题输入框在场', false, customBox);
      return;
    }
    await realPoint(cdp, customBox.x, customBox.y);
    await cdp.send('Input.insertText', { text: TYPED_CUSTOM });
    await sleep(1200);
    const customKept = await ev(`
      const el = document.querySelector('${GATE.customQuestion}');
      const first = window.__tbody.querySelector('tr td:nth-child(4) input');
      return {
        sameNode: el?.__t02192c === 1,
        value: el?.value ?? '',
        rows: window.__tbody.querySelectorAll('tr').length,
        firstAnswer: first?.value ?? '',
      };
    `);
    ok('X-02 自定义行 1200ms 后仍是同一节点且内容未丢', customKept?.sameNode === true && customKept?.value === TYPED_CUSTOM, customKept);
    ok('X-03 新增自定义行未冲掉首行已填结论（整表未被重填）', customKept?.firstAnswer === TYPED_ANSWER, customKept);

    // ---------- G 组：切页往返（T02192 同族的会话/store 复现通道） ----------
    const beforeNav = await ev(`return sessionStorage.getItem('prdGen.conclusion');`);
    await ev(`window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); return 1;`);
    await sleep(400);
    await ev(`window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'report' } })); return 1;`);
    await sleep(800);
    const backAgain = await until(ev, LOCATE_PANEL, 10_000);
    ok('G-01 切页往返后面板与结果仍在（store 单例 + 会话态口径）', backAgain);
    if (backAgain) {
      const back = await ev(`
        const first = window.__tbody.querySelector('tr td:nth-child(4) input');
        const trs = [...window.__tbody.querySelectorAll('tr')];
        return {
          rows: trs.length,
          aiRows: trs.filter((tr) => tr.querySelector('td:nth-child(2) span')).length,
          firstAnswer: first?.value ?? '',
          firstQuestion: window.__tbody.querySelector('tr td:nth-child(2)')?.textContent?.slice(0, 18) ?? '',
          conclBeforeNav: ${JSON.stringify(beforeNav)},
          conclAfterNav: sessionStorage.getItem('prdGen.conclusion'),
        };
      `);
      // 口径（T00820/T02214）：切页保留「结果正文 + 会话快照里的行集合」——AI 行按正文指纹重建，
      // 自定义行随同一代际快照恢复（T02214 前该行不落快照、切页整行消失，G-04/G-05 即守此回归面）。
      // AI 行按 DOM 结构计（问题单元格是 <span>，自定义行是 <input>），与总行数解耦。
      ok(`G-02 切页往返后 AI 问题行数不变（结果未被丢，实测 AI ${back?.aiRows} 行 / 总 ${back?.rows} 行 / 桩产出 ${ISSUES.length} 行）`,
        back?.aiRows === ISSUES.length, back);
      ok(`G-03 切页往返后首行已填结论按会话口径恢复（实测「${back?.firstAnswer}」）`,
        back?.firstAnswer === TYPED_ANSWER, back);
      const customBack = await ev(`
        const box = document.querySelector('${GATE.customQuestion}');
        return {
          rows: window.__tbody.querySelectorAll('tr').length,
          customQ: box?.value ?? '',
        };
      `);
      ok(`G-04 切页往返后行数 = AI ${ISSUES.length} + 自定义 1（实测 ${customBack?.rows} 行）`,
        customBack?.rows === ISSUES.length + 1, customBack);
      ok(`G-05 切页往返后自定义行问题正文按同一 DOM 语义取回（实测「${customBack?.customQ}」）`,
        customBack?.customQ === TYPED_CUSTOM, customBack);
    }

    await shot(cdp, join(OUT_DIR, NEGATIVE ? 't02192-pointer-negative.png' : 't02192-pointer-positive.png'));
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

// ---------------- 负对照：把源码改回缺陷形态，要求同一组交互断言必须红 ----------------
const REVERTS: Array<[RegExp, string]> = [
  [/const result = useMemo\(\(\) => \(activeItem && !activeItem\.failed\n([\s\S]*?)\), \[activeItem, snap\.result\]\);/,
    'const result = activeItem && !activeItem.failed$1;'],
  [/const gen = hashStr\(result\.prdMd\);/, 'const gen = `st-${Date.now()}`;'],
];

function applyNegativeControl(): { restore: () => void } {
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(BACKUP)) {
    // 上一轮被硬杀留下的备份——先回写，绝不把备份当原文再备份一次
    writeFileSync(PANEL_SRC, readFileSync(BACKUP, 'utf8'), 'utf8');
    rmSync(BACKUP, { force: true });
    console.log('  负对照：发现残留备份，已先回写 PrdGenPanel.tsx');
  }
  const original = readFileSync(PANEL_SRC, 'utf8');
  writeFileSync(BACKUP, original, 'utf8');
  let patched = original;
  for (const [re, to] of REVERTS) {
    if (!re.test(patched)) throw new Error(`负对照锚点未命中（源码形态变了，请同步本脚本）：${re.source.slice(0, 70)}`);
    patched = patched.replace(re, to);
  }
  writeFileSync(PANEL_SRC, patched, 'utf8');
  const restore = () => {
    if (!existsSync(BACKUP)) return;
    writeFileSync(PANEL_SRC, readFileSync(BACKUP, 'utf8'), 'utf8');
    rmSync(BACKUP, { force: true });
  };
  process.on('exit', restore);
  console.log(`  负对照：已把 PrdGenPanel.tsx 改回缺陷形态（原文备份 ${BACKUP}）`);
  return { restore };
}

// ---------------- 主流程 ----------------
mkdirSync(OUT_DIR, { recursive: true });
console.log(`T02192 指针回归门${NEGATIVE ? '【负对照】' : ''} · 桩服 ${BASE} · CDP ${CDP_PORT}`);

const src = readFileSync(PANEL_SRC, 'utf8');
if (!NEGATIVE) {
  ok('S-01 PrdGenPanel 的 result 走 useMemo（引用稳定，非渲染期新建字面量）',
    /const result = useMemo\(/.test(src) && !/^ {2}const result = activeItem/m.test(src));
  ok('S-02 交互表格行键取正文指纹（hashStr）而非 Date.now()',
    /const gen = hashStr\(result\.prdMd\);/.test(src) && /key: `gi-\$\{gen\}-\$\{i\}`/.test(src));
  // 本轮跑门时实测出来的同族缺陷（切页后已填结论被会话快照抹掉）——落盘必须以「表格已填充」为前提
  ok('S-04 结论落盘 effect 以 rows 非空为门槛（切页首帧 rows=[] 不得被当成「用户清空结论」）',
    /if \(!result \|\| rows\.length === 0\) return;/.test(src));
}
const negativeControl = NEGATIVE ? applyNegativeControl() : null;
try {
  // S-03 放在负对照打补丁**之后**评：否则负对照跑出来的 S-03 判的是未打补丁的源码，那个 PASS 是假的。
  const scan = scanRenderPhaseDeps();
  ok(`S-03 静态特征扫描：渲染期新建对象作 effect 依赖的组合为 0 处（扫 ${scan.files} 个 tsx，命中 ${scan.hits.length}）`,
    scan.hits.length === 0, scan.hits.slice(0, 5));
  buildWeb();
  await runUiChecks();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`  ⚠ 门执行异常：${msg}`);
  lines.push(`[CRASH] 门自身执行抛异常（崩溃即门失效，不得当成通过）→ ${msg}`);
  fail += 1;
} finally {
  negativeControl?.restore();
  if (NEGATIVE) {
    // 负对照期间 dist 是按缺陷源码构建的；不复原就会污染下一次 SKIP_BUILD 复跑（E-03 拦的那条）。
    // 源码已 restore，这里强制重建一次，让工作区回到「dist 与当前源码一致」。
    const saved = process.env.T02192_GATE_SKIP_BUILD;
    delete process.env.T02192_GATE_SKIP_BUILD;
    try {
      buildWeb();
      console.log('  (负对照收尾：web/dist 已按还原后的源码重建)');
    } catch (e) {
      console.log(`  ⚠ 负对照收尾重建 dist 失败：${e instanceof Error ? e.message : String(e)}——下一次正对照请勿用 SKIP_BUILD`);
    }
    if (saved !== undefined) process.env.T02192_GATE_SKIP_BUILD = saved;
  }
}

const interaction = lines.filter((l) => /^\[(PASS|FAIL)\] [URFCQXG]-/.test(l));
const interactionFail = interaction.filter((l) => l.startsWith('[FAIL]')).length;
if (NEGATIVE) {
  const caught = interaction.length > 0 && interactionFail > 0;
  lines.unshift(`[NEG] 负对照判定：缺陷形态下交互组 FAIL=${interactionFail}/${interaction.length} —— ${caught ? '门拦得住（合格）' : '门拦不住（失效，必须修门）'}`);
  console.log(`\n${lines[0]}`);
  pass = caught ? 1 : 0;
  fail = caught ? 0 : 1;
}

writeFileSync(RESULTS, `T02192 指针回归门${NEGATIVE ? '（负对照）' : ''}：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
console.log(`\nPASS=${pass} FAIL=${fail} → ${RESULTS}`);
process.exit(fail === 0 ? 0 : 1);
