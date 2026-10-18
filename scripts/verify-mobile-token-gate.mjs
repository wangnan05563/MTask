#!/usr/bin/env node
/**
 * 移动端隧道鉴权门（T02293 改判版）。
 *
 * 被测行为：隧道远程访问时，MobileShell 的鉴权探测必须打在**受 accessTokenGuard 保护的真实数据接口**上——
 * 首访（未带令牌）→ 401 → 令牌屏；错令牌 → 仍 401、屏不退、本地令牌清空；对令牌 → 放行并渲染数据行。
 * 未配置令牌的实例（纯本机语义）则不得出令牌屏，外壳与数据直出。
 *
 * 为什么不再用 Tailscale：旧门`serve/funnel --set-path` 真挂载会快照并**全量清空**用户 tailscale 配置
 * （本版本 off 无法按路径卸载），门中断即可能丢失用户隧道配置——共享系统状态风险不可接受。
 * 改为 CDP `Network.setExtraHTTPHeaders` 注入 `X-Forwarded-For`：服务端 `isLocalRequest` 的判据就是
 * 「任一转发头存在 ⇒ 经代理转发」，与真实隧道同一条服务端分支；零基础设施改动、零共享状态。
 * 必须同时 `Network.setBypassServiceWorker`，否则已激活的 SW 会代发请求、丢掉 CDP 注入头。
 *
 * 判据（T02293）：U 组只断言结构/行为/服务端响应；产品文案与标识符锚进 P 组 `okPair`（取证面 `git show HEAD:`）；
 * N 组负对照（空源码、HEAD 在场、抽干实测料、逐锚改名、okPair 契约、20 类行为破坏）。
 * 夹具门内自造（两套隔离实例 + 临时库 + API 建单），不读生产库、不碰生产实例。
 *
 * 用法：<node> node_modules/tsx/dist/cli.mjs scripts/verify-mobile-token-gate.mjs
 * 环境变量：MOBILE_TOKEN_PORT_A（默认 40417）、MOBILE_TOKEN_PORT_B（40418）、MOBILE_TOKEN_CDP（9442）、
 *           MOBILE_TOKEN_KEEP=1 保留临时目录。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// C: 盘常年 0 可用，SQLITE_FULL 会伪装成产品失败——临时根一律落 D:
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_A = mkdtempSync(join(TMP_ROOT, 'mobile-token-a-'));
const DATA_B = mkdtempSync(join(TMP_ROOT, 'mobile-token-b-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 'mobile-token-chrome-'));
if (!process.env.MTASK_GATE_ARTIFACT_DIR) process.env.MTASK_GATE_ARTIFACT_DIR = join(TMP_ROOT, 'mtask-gate-shots');
const { gateShotsDir } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
const SHOTS = gateShotsDir('mobile-token');

const PORT_A = Number(process.env.MOBILE_TOKEN_PORT_A ?? 40417);
const PORT_B = Number(process.env.MOBILE_TOKEN_PORT_B ?? 40418);
const CDP = Number(process.env.MOBILE_TOKEN_CDP ?? 9442);
const CHROME = process.env.MOBILE_TOKEN_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const TOKEN = 'gate-token-a1b2c3d4';
const WRONG = 'wrong-token-deliberately';
const REMOTE_IP = '203.0.113.9';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 400)}` : ''}`);
  }
};

/** 反模式 11：字面腿取已提交树（工作树可能躺着别的会话的过期产品文件） */
const headSource = (rel) => {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch { return ''; }
};
const SHELL_HEAD = headSource('web/src/mobile/MobileShell.tsx');
const APP_HEAD = headSource('web/src/App.tsx');
const CLIENT_HEAD = headSource('web/src/api/client.ts');
const TUNNEL_HEAD = headSource('server/src/routes/tunnel.ts');
const LOCAL_HEAD = headSource('server/src/util/local-request.ts');
const INDEX_HEAD = headSource('server/src/index.ts');
/** 运行期实测料：行为腿只读它（N-02 抽干后必须全部转假） */
let EV = {};

// ---------------- 1) 夹具：实例 A 预写隧道配置，两实例各起一个隔离服务 ----------------
mkdirSync(join(DATA_A, 'tunnel'), { recursive: true });
writeFileSync(join(DATA_A, 'tunnel', 'tunnel-config.json'), JSON.stringify({ provider: 'cloudflare', accessToken: TOKEN }));

const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const serverLog = [];
const startServer = (port, dataDir) => {
  const p = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(port), MTask_DATA_DIR: dataDir, MTASK_CSRF_MODE: 'header' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout?.on('data', (b) => serverLog.push(`[${port}] ${b}`));
  p.stderr?.on('data', (b) => serverLog.push(`[${port}] ${b}`));
  return p;
};
const procs = [];
const killTree = (pid) => { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } };
const bye = () => { for (const p of procs) killTree(p.pid); };
process.on('exit', bye);
const sleepSync = (i) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (i + 1)); };
const cleanup = () => {
  if (process.env.MOBILE_TOKEN_KEEP) return;
  for (const dir of [DATA_A, DATA_B, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
process.on('exit', cleanup);

/** 端口被孤儿实例占用时新实例会 EADDRINUSE 静默崩，健康检查打到孤儿 → 假红/假绿都难查 */
async function assertPortFree(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (r.ok) throw new Error(`端口 ${port} 已被孤儿实例占用，先清理再跑`);
  } catch (e) {
    if (String(e).includes('占用')) throw e;
  }
}
async function waitHealth(port) {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}
/** 直连 API 探针：remote=true 时注入与服务端判据同源的转发头 */
async function api(port, path, { method = 'GET', token, remote = false, body } = {}) {
  const headers = {};
  if (remote) headers['X-Forwarded-For'] = REMOTE_IP;
  if (token) headers['X-Access-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    return { status: r.status, json, text: text.slice(0, 300) };
  } catch (e) {
    return { status: 0, error: String(e) };
  }
}

await assertPortFree(PORT_A);
await assertPortFree(PORT_B);
const serverA = startServer(PORT_A, DATA_A);
const serverB = startServer(PORT_B, DATA_B);
procs.push(serverA, serverB);
console.log(`隔离实例：A=${PORT_A}（已配令牌，${DATA_A}） B=${PORT_B}（未配令牌，${DATA_B}）`);
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const upA = await waitHealth(PORT_A);
const upB = await waitHealth(PORT_B);
ok('S-00 两个隔离服务启动（A 已配令牌 / B 未配令牌，临时端口 + 临时库）', upA && upB, { upA, upB });
if (!upA || !upB) {
  console.log(`\n—— 服务日志 ——\n${serverLog.join('').split('\n').slice(-40).join('\n')}`);
  process.exit(1);
}

// 夹具建单：经 REST（走 accessTokenGuard + TaskService 钩子），不直写库
const noteA = await api(PORT_A, '/api/settings/note-project', { token: TOKEN });
const noteB = await api(PORT_B, '/api/settings/note-project');
const PID_A = noteA.json?.projectId;
const PID_B = noteB.json?.projectId;
const TITLE_A = `令牌门夹具A-${process.pid}`;
const TITLE_B = `令牌门夹具B-${process.pid}`;
const seedA = PID_A ? await api(PORT_A, '/api/tasks', { method: 'POST', token: TOKEN, body: { projectId: PID_A, title: TITLE_A, description: 'gate' } }) : { status: 0 };
const seedB = PID_B ? await api(PORT_B, '/api/tasks', { method: 'POST', body: { projectId: PID_B, title: TITLE_B, description: 'gate' } }) : { status: 0 };
ok('S-01 两实例各经 API 建一条夹具任务（归属默认可记事项目）',
  !!PID_A && !!PID_B && seedA.status >= 200 && seedA.status < 300 && seedB.status >= 200 && seedB.status < 300,
  { PID_A, PID_B, seedA: { status: seedA.status, text: seedA.text }, seedB: { status: seedB.status, text: seedB.text } });

// ---------------- 2) headless Chrome + CDP ----------------
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  '--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  `--user-data-dir=${CHROME_PROFILE}`, '--window-size=400,850', 'about:blank',
], { stdio: 'ignore' });
procs.push(chrome);

let wsUrl = '';
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
    if (r.ok) { const t = (await r.json()).find((x) => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; } }
  } catch { /* Chrome 还在起 */ }
  await sleep(400);
}
ok('S-02 Chrome CDP 通道就绪（系统 Chrome, headless=new）', !!wsUrl, wsUrl);
if (!wsUrl) process.exit(1);

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

/** 每请求一条：requestWillBeSent 给 url/headers，responseReceived 补 status，ExtraInfo 补全请求头 */
const apiEvents = new Map();
let eventOrder = 0;
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u; } };
const headerOf = (headers, name) => {
  const k = Object.keys(headers || {}).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : undefined;
};
const configBodies = [];
ws.onmessage = (ev2) => {
  const m = JSON.parse(ev2.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (!/\/api\//.test(u)) return;
    apiEvents.set(m.params.requestId, { order: ++eventOrder, url: pathOf(u), headers: m.params.request.headers || {} });
    return;
  }
  if (m.method === 'Network.requestWillBeSentExtraInfo') {
    const rec = apiEvents.get(m.params.requestId);
    if (rec) rec.headers = { ...rec.headers, ...(m.params.headers || {}) };
    return;
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (!/\/api\//.test(u)) return;
    const id = m.params.requestId;
    const rec = apiEvents.get(id) || { order: ++eventOrder, url: pathOf(u), headers: {} };
    rec.status = m.params.response.status;
    apiEvents.set(id, rec);
    // 远程/本机的隧道配置响应体必须看真值：本机明文下发用于自同步，公网只给脱敏串
    if (rec.url === '/api/tunnel/config' && rec.status === 200) {
      send('Network.getResponseBody', { requestId: id }).then((r) => {
        const raw = r?.result?.body ?? '';
        const text = r?.result?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
        try { configBodies.push({ order: ++eventOrder, body: JSON.parse(text) }); } catch { /* 解析失败自然让腿转假 */ }
      }).catch(() => { /* 响应体取不到时行为腿自然转假 */ });
    }
  }
};
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
async function until(expr, ms = 25_000) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) {
    v = await ev(expr);
    if (v) return v;
    await sleep(250);
  }
  return v;
}
const shotFiles = [];
async function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  await send('Page.bringToFront');
  for (let i = 0; i < 3; i++) {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const b64 = r.result && r.result.data;
    if (b64) {
      const file = join(SHOTS, `${name}.png`);
      writeFileSync(file, Buffer.from(b64, 'base64'));
      shotFiles.push(file);
      return file;
    }
    await sleep(700);
  }
  return '';
}

/**
 * 令牌屏结构句柄：整页只剩一个原生 input + 一个 button，且没有底栏 nav。
 * 外壳结构句柄：nav 下恰 5 个直接子 button，其中 4 个带文字、1 个中央纯图标。
 * 行结构句柄：li 正文含夹具标题，且行内恰 2 个 button（切换完成 + 详情）。
 */
const TOKEN_SCREEN = `(() => { const nav=document.querySelector('nav');
  const ins=document.querySelectorAll('input'); const bs=document.querySelectorAll('button');
  return !nav && ins.length===1 && bs.length===1 && !ins[0].hasAttribute('type') ? 1 : 0; })()`;
const SHELL = `(() => { const nav=document.querySelector('nav'); if(!nav) return 0;
  const bs=[...nav.querySelectorAll(':scope > button')];
  const texted=bs.filter((b)=>b.textContent.trim().length>0).length;
  const iconOnly=bs.filter((b)=>b.textContent.trim().length===0).length;
  return bs.length===5 && texted===4 && iconOnly===1 ? 1 : 0; })()`;
const shellInfo = `(() => { const nav=document.querySelector('nav'); if(!nav) return null;
  const bs=[...nav.querySelectorAll(':scope > button')];
  return { n: bs.length, texted: bs.filter((b)=>b.textContent.trim().length>0).length,
    iconOnly: bs.filter((b)=>b.textContent.trim().length===0).length,
    inputCount: document.querySelectorAll('input').length }; })()`;
const rowUp = (title) => `(() => {
  const lis=[...document.querySelectorAll('li')].filter((li)=>li.textContent.includes(${JSON.stringify(title)}));
  return lis.length===1 && lis[0].querySelectorAll('button').length===2 ? 1 : 0; })()`;
const submitToken = (token) => `(() => {
  const ins=[...document.querySelectorAll('input')]; const bs=[...document.querySelectorAll('button')];
  if (ins.length!==1 || bs.length!==1) return 'not-token-screen';
  const el=ins[0];
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(el, ${JSON.stringify(token)});
  el.dispatchEvent(new Event('input',{bubbles:true}));
  bs[0].click();
  return 'clicked';
})()`;
const storedToken = `localStorage.getItem('mtask.accessToken')`;
const collectErrors = async (bucket) => {
  const errs = await ev(`Array.isArray(window.__errs) ? window.__errs.slice(0,5) : []`);
  if (Array.isArray(errs)) bucket.push(...errs);
};
const fresh = (mark, path) => [...apiEvents.values()].filter((e) => e.order > mark && e.url === path).sort((a, b) => a.order - b.order);
const waitFresh = async (mark, path, ms = 20_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = fresh(mark, path).find((e) => typeof e.status === 'number');
    if (hit) return hit;
    await sleep(250);
  }
  return null;
};
const markNow = () => eventOrder;
const jsErrors = [];

const waitConfigAfter = async (mark, ms = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = [...configBodies].filter((b) => b.order > mark).pop();
    if (hit) return hit.body;
    await sleep(250);
  }
  return null;
};
/** Page.reload 立即返回；旧文档仍满足外壳/行断言——必须等新 document 代际，否则等于没测刷新 */
const reloadAndWaitDoc = async () => {
  const oldDoc = await ev('window.__docId');
  await send('Page.reload', { ignoreCache: true });
  const changed = await until(`window.__docId !== ${JSON.stringify(oldDoc)} ? 1 : ''`, 30_000);
  return changed === 1;
};

await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
// SW 会代发请求并丢掉 CDP 注入头（表现为“远程”被误判成本机，令牌屏永不出现）
await send('Network.setBypassServiceWorker', { bypass: true });
await send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': REMOTE_IP } });
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    window.__docId = Date.now() + '-' + Math.random();`,
});

// ---------------- 3) C 组前置：服务端鉴权矩阵（直连 API，remote 头与服务端判据同源） ----------------
console.log('\n=== 服务端鉴权矩阵（直连 API，remote 用 X-Forwarded-For 模拟隧道转发） ===');
const healthRemote = await api(PORT_A, '/api/health', { remote: true });
const projectsNoToken = await api(PORT_A, '/api/projects', { remote: true });
const projectsWrong = await api(PORT_A, '/api/projects', { remote: true, token: WRONG });
const projectsRight = await api(PORT_A, '/api/projects', { remote: true, token: TOKEN });
const cfgRemote = await api(PORT_A, '/api/tunnel/config', { remote: true });
const cfgLocal = await api(PORT_A, '/api/tunnel/config');
const queryTokenOnly = await api(PORT_A, `/api/projects?token=${encodeURIComponent(TOKEN)}`, { remote: true });
const NO_WRITE_TITLE = `越权写入探针-${process.pid}`;
const writeNoToken = await api(PORT_A, '/api/tasks', { method: 'POST', remote: true, body: { projectId: PID_A, title: NO_WRITE_TITLE } });
const tasksAfterNoToken = await api(PORT_A, `/api/tasks?projectId=${PID_A}&limit=200`, { remote: true, token: TOKEN });
const noTokenAppears = Array.isArray(tasksAfterNoToken.json) && tasksAfterNoToken.json.some((t) => t.title === NO_WRITE_TITLE);
const WRITE_OK_TITLE = `带令牌写入探针-${process.pid}`;
const writeWithToken = await api(PORT_A, '/api/tasks', { method: 'POST', remote: true, token: TOKEN, body: { projectId: PID_A, title: WRITE_OK_TITLE } });
const tasksAfterToken = await api(PORT_A, `/api/tasks?projectId=${PID_A}&limit=200`, { remote: true, token: TOKEN });
const writeAppears = Array.isArray(tasksAfterToken.json) && tasksAfterToken.json.some((t) => t.title === WRITE_OK_TITLE);
const mgmtRemote = await api(PORT_A, '/api/tunnel/reset-token', { method: 'POST', remote: true });
const cfgAfterMgmt = await api(PORT_A, '/api/tunnel/config');
const openBProjects = await api(PORT_B, '/api/projects', { remote: true });
const openBCfg = await api(PORT_B, '/api/tunnel/config', { remote: true });

EV.c = {
  health: { status: healthRemote.status },
  projectsNoToken: { status: projectsNoToken.status, error: projectsNoToken.json?.error },
  projectsWrong: { status: projectsWrong.status },
  projectsRight: { status: projectsRight.status, isArray: Array.isArray(projectsRight.json) },
  config: {
    remote: { status: cfgRemote.status, token: cfgRemote.json?.accessToken, configured: cfgRemote.json?.accessTokenConfigured, masked: cfgRemote.json?.accessTokenMasked },
    local: { status: cfgLocal.status, token: cfgLocal.json?.accessToken, configured: cfgLocal.json?.accessTokenConfigured },
  },
  mgmt: { status: mgmtRemote.status, tokenBefore: TOKEN, tokenAfter: cfgAfterMgmt.json?.accessToken },
  write: {
    noToken: { status: writeNoToken.status },
    noTokenAppears, withToken: { status: writeWithToken.status }, appears: writeAppears,
  },
  queryToken: { status: queryTokenOnly.status },
  openB: { projects: openBProjects.status, config: { status: openBCfg.status, token: openBCfg.json?.accessToken, configured: openBCfg.json?.accessTokenConfigured } },
};

// ---------------- 4) A 相位：已配令牌 + 远程访问 ----------------
console.log('\n=== A 相位：已配令牌，远程首访（令牌屏 → 错令牌拒 → 对令牌放行） ===');
await send('Page.navigate', { url: `${BASE_A}/?m=1` });
const screenA = await until(TOKEN_SCREEN, 40_000);
EV.a = { initial: { tokenScreen: screenA === 1, shell: false } };
ok('U-01 远程首访出现令牌屏（结构：无底栏、整页一个输入框 + 一个按钮）', screenA === 1, { screenA });
await shot('a1-token-screen');

const probeEvent = [...apiEvents.values()].filter((e) => e.url === '/api/projects' && e.status === 401).sort((a, b) => a.order - b.order)[0] || null;
EV.a.initial.probe = {
  path: probeEvent?.url ?? '',
  status: probeEvent?.status ?? 0,
  hadToken: probeEvent ? Boolean(headerOf(probeEvent.headers, 'x-access-token')) : true,
};
ok('U-02 触发令牌屏的探测请求是受守卫数据接口：无令牌 /api/projects → 401',
  EV.a.initial.probe.status === 401 && EV.a.initial.probe.hadToken === false && EV.a.initial.probe.path === '/api/projects',
  EV.a.initial.probe);

const wrongMark = markNow();
const wrongClick = await ev(submitToken(WRONG));
const wrongRes = await waitFresh(wrongMark, '/api/projects');
await sleep(600);
const wrongScreenStill = await ev(TOKEN_SCREEN);
const wrongStored = await ev(storedToken);
EV.a.wrong = {
  clicked: wrongClick === 'clicked',
  stayed: wrongScreenStill === 1,
  storedCleared: wrongStored === null || wrongStored === '',
  probe: {
    status: wrongRes?.status ?? 0,
    hadToken: wrongRes ? Boolean(headerOf(wrongRes.headers, 'x-access-token')) : false,
    token: wrongRes ? headerOf(wrongRes.headers, 'x-access-token') : undefined,
  },
};
ok('U-03 错令牌被拒：令牌屏不退、本地令牌被清空，且期间没有外壳出现',
  EV.a.wrong.clicked && EV.a.wrong.stayed && EV.a.wrong.storedCleared && (await ev(SHELL)) !== 1,
  { wrongClick, wrongScreenStill, wrongStored });
ok('U-04 错令牌确实随请求发出（X-Access-Token=错值）并被服务端 401',
  EV.a.wrong.probe.status === 401 && EV.a.wrong.probe.hadToken === true && EV.a.wrong.probe.token === WRONG,
  EV.a.wrong.probe);
await shot('a2-wrong-token');

const okMark = markNow();
await ev(submitToken(TOKEN));
const okProbe = await waitFresh(okMark, '/api/projects');
const shellA = await until(SHELL, 40_000);
const shellInfoA = await ev(shellInfo);
const rowA = await until(rowUp(TITLE_A), 30_000);
const tasksEvent = await waitFresh(okMark, '/api/tasks');
EV.a.ok = {
  probe: {
    status: okProbe?.status ?? 0,
    hadToken: okProbe ? Boolean(headerOf(okProbe.headers, 'x-access-token')) : false,
    token: okProbe ? headerOf(okProbe.headers, 'x-access-token') : undefined,
  },
  shell: shellInfoA ?? { n: 0, texted: 0, iconOnly: 0 },
  row: rowA === 1,
  tasks: {
    status: tasksEvent?.status ?? 0,
    hadToken: tasksEvent ? Boolean(headerOf(tasksEvent.headers, 'x-access-token')) : false,
    token: tasksEvent ? headerOf(tasksEvent.headers, 'x-access-token') : undefined,
  },
  stored: await ev(storedToken),
};
ok('U-05 对令牌放行：移动端外壳渲染（底栏恰 5 钮：4 带文字 + 1 中央纯图标）',
  shellA === 1 && EV.a.ok.shell.n === 5 && EV.a.ok.shell.texted === 4 && EV.a.ok.shell.iconOnly === 1, EV.a.ok.shell);
ok('U-06 校验请求带对令牌 /api/projects → 200',
  EV.a.ok.probe.status === 200 && EV.a.ok.probe.hadToken === true && EV.a.ok.probe.token === TOKEN,
  EV.a.ok.probe);
ok('U-07 夹具任务行经带令牌的数据接口渲染（li 含夹具标题且恰 2 个 button）', EV.a.ok.row === true);
ok('U-08 数据接口同样带对令牌 → 200（引擎没有绕过守卫的旁路）',
  EV.a.ok.tasks.status === 200 && EV.a.ok.tasks.hadToken === true && EV.a.ok.tasks.token === TOKEN,
  EV.a.ok.tasks);
await collectErrors(jsErrors);
await shot('a3-shell-row');

const cfgMark = markNow();
const docChanged = await reloadAndWaitDoc();
const shellReload = await until(SHELL, 40_000);
const rowReload = await until(rowUp(TITLE_A), 30_000);
// 移动壳不走桌面 Shell 的 /tunnel/config 自同步；若某版本开始调用，也只允许空值（公网不下发明文）
const configRequested = [...apiEvents.values()].some((e) => e.order > cfgMark && e.url === '/api/tunnel/config');
const cfgAfterReload = configRequested ? await waitConfigAfter(cfgMark) : null;
EV.a.reload = {
  docChanged,
  shell: shellReload === 1,
  row: rowReload === 1,
  stored: await ev(storedToken),
  configRequested,
  configRemoteToken: cfgAfterReload?.accessToken ?? null,
};
EV.a.reload.configTokenOk = !configRequested || EV.a.reload.configRemoteToken === '';
ok('U-09 刷新后仍免令牌进入（本地令牌恢复；移动壳未调用 config 或调用也只拿到空值）',
  EV.a.reload.docChanged && EV.a.reload.shell && EV.a.reload.row && EV.a.reload.stored === TOKEN
  && EV.a.reload.configTokenOk,
  EV.a.reload);
await collectErrors(jsErrors);
await shot('a4-reload');

// 失效令牌：模拟设备上残留旧令牌 → 首访应重新弹令牌屏，随后可恢复
await ev(`localStorage.setItem('mtask.accessToken', 'stale-bad-token')`);
const staleDocChanged = await reloadAndWaitDoc();
const staleScreen = await until(TOKEN_SCREEN, 40_000);
const staleMark = markNow();
await ev(submitToken(TOKEN));
const staleShell = await until(SHELL, 40_000);
const staleRow = await until(rowUp(TITLE_A), 30_000);
EV.a.stale = {
  screen: staleScreen === 1,
  recovered: staleShell === 1 && staleRow === 1,
  probe: { status: (await waitFresh(staleMark, '/api/projects'))?.status ?? 0 },
};
ok('U-10 残留失效令牌 → 首访重新弹令牌屏；重新输入对令牌后恢复外壳与数据行',
  EV.a.stale.screen && EV.a.stale.recovered && EV.a.stale.probe.status === 200, EV.a.stale);
await shot('a5-stale-recovered');
await collectErrors(jsErrors);

// ---------------- 5) B 相位：未配令牌 + 远程访问 ----------------
console.log('\n=== B 相位：未配令牌，远程首访（应直接渲染，不得出令牌屏） ===');
const bMark = markNow();
await send('Page.navigate', { url: `${BASE_B}/?m=1` });
const bVerdict = await until(`(() => {
  const nav=document.querySelector('nav');
  const ins=document.querySelectorAll('input'); const bs=document.querySelectorAll('button');
  if (!nav && ins.length===1 && bs.length===1) return 'screen-bad';
  if (nav) { const nbs=[...nav.querySelectorAll(':scope > button')];
    if (nbs.length===5 && nbs.filter((b)=>b.textContent.trim()).length===4) return 'shell-ok'; }
  return '';
})()`, 40_000);
const rowB = await until(rowUp(TITLE_B), 30_000);
await sleep(800);
const bEndScreen = await ev(TOKEN_SCREEN);
EV.b = { shell: bVerdict === 'shell-ok', screenSeen: bVerdict === 'screen-bad' || bEndScreen === 1, row: rowB === 1 };
ok('U-11 未配令牌 + 远程：不出令牌屏，外壳直接渲染', EV.b.shell && EV.b.screenSeen === false, { bVerdict, bEndScreen });
ok('U-12 未配令牌时夹具任务行直出（既有本地语义未因鉴权修复被破坏）', EV.b.row === true);
await shot('b1-no-token-shell');
await collectErrors(jsErrors);

// ---------------- 6) D 相位：桌面壳启动自同步的两个方向 ----------------
console.log('\n=== D 相位：桌面壳 /tunnel/config 自同步（远程只给空值，本机明文解锁） ===');
await send('Page.navigate', { url: `${BASE_A}/?m=0` });
await until(`document.readyState==='complete' && typeof window.__docId === 'string' ? 1 : ''`, 40_000);
await sleep(2_000);
const remoteSyncMark = markNow() - 1;
await ev(`localStorage.removeItem('mtask.accessToken')`);
const remoteDocChanged = await reloadAndWaitDoc();
const remoteCfgBody = await waitConfigAfter(remoteSyncMark);
await sleep(1_200);
// 直接行为探针：新文档里触发一次数据取数，若真“自解锁”了则必带令牌；这里应无令牌且 401
await ev(`globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } }))`);
await sleep(600);
const remoteSeamMark = markNow();
await ev(`globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } }))`);
const remoteSeamEvent = await waitFresh(remoteSeamMark, '/api/tasks');
EV.d = {
  remote: {
    docChanged: remoteDocChanged,
    configToken: remoteCfgBody?.accessToken,
    configConfigured: remoteCfgBody?.accessTokenConfigured,
    stored: await ev(storedToken),
    postSeam: {
      status: remoteSeamEvent?.status ?? 0,
      hadToken: remoteSeamEvent ? Boolean(headerOf(remoteSeamEvent.headers, 'x-access-token')) : true,
    },
  },
};
ok('U-15 远程桌面壳拿到空令牌配置：不自解锁（配置后新发数据请求仍无令牌且 401）',
  EV.d.remote.docChanged && EV.d.remote.configToken === '' && EV.d.remote.configConfigured === true
  && (EV.d.remote.stored === null || EV.d.remote.stored === '')
  && EV.d.remote.postSeam.status === 401 && EV.d.remote.postSeam.hadToken === false,
  EV.d.remote);

// 清掉 CDP 注入的转发头 → 服务端视角回到本机；config 应明文下发并自动写入本地
await send('Network.setExtraHTTPHeaders', { headers: {} });
const localSyncMark = markNow() - 1;
await ev(`localStorage.removeItem('mtask.accessToken')`);
await reloadAndWaitDoc();
const localCfgBody = await waitConfigAfter(localSyncMark);
const localStored = await until(`localStorage.getItem('mtask.accessToken') === ${JSON.stringify(TOKEN)} ? 1 : ''`, 25_000);
await ev(`globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } }))`);
const localTokenEvent = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    const hit = [...apiEvents.values()].find((e) => e.order > localSyncMark && e.status === 200
      && headerOf(e.headers, 'x-access-token') === TOKEN);
    if (hit) return hit;
    await sleep(250);
  }
  return null;
})();
EV.d.local = {
  configToken: localCfgBody?.accessToken,
  stored: await ev(storedToken),
  synced: localStored === 1,
  tokenEvent: { status: localTokenEvent?.status ?? 0, token: localTokenEvent ? headerOf(localTokenEvent.headers, 'x-access-token') : undefined },
};
ok('U-16 本机桌面壳拿到明文令牌并自动写入本地，随后的数据请求真的带上它且 200',
  EV.d.local.configToken === TOKEN && EV.d.local.synced && EV.d.local.stored === TOKEN
  && EV.d.local.tokenEvent.status === 200 && EV.d.local.tokenEvent.token === TOKEN,
  EV.d.local);
await collectErrors(jsErrors);
await shot('d1-desktop-sync');

// ---------------- 7) 健康与日志 ----------------
const fiveXx = [...apiEvents.values()].filter((e) => typeof e.status === 'number' && e.status >= 500).length;
const logText = serverLog.join('');
const logErr = /Unhandled|ERR_DLOPEN|Error:|错误|异常/.test(logText);
EV.health = { jsErrors: [...new Set(jsErrors)], fiveXx, logErr };
ok('U-13 全程无未捕获 JS 异常', EV.health.jsErrors.length === 0, EV.health.jsErrors);
ok('U-14 全程 API 无 5xx，服务日志无异常行', EV.health.fiveXx === 0 && EV.health.logErr === false, { fiveXx, logErr: logText.split('\n').filter((l) => /Unhandled|ERR_DLOPEN|Error:|错误|异常/.test(l)).slice(-3) });

// ---------------- 7) U 组行为腿索引（C 组服务端矩阵也在其中） ----------------
const BEHAVIOR = [
  { id: 'E-01', label: 'A 远程首访 → 令牌屏（结构句柄）', fn: () => EV.a?.initial?.tokenScreen === true },
  { id: 'E-02', label: '探测请求 = 无令牌 /api/projects → 401', fn: () => EV.a?.initial?.probe?.path === '/api/projects' && EV.a.initial.probe.status === 401 && EV.a.initial.probe.hadToken === false },
  { id: 'E-03', label: '错令牌被拒：屏不退 + 本地令牌清空', fn: () => EV.a?.wrong?.clicked === true && EV.a.wrong.stayed === true && EV.a.wrong.storedCleared === true },
  { id: 'E-04', label: '错令牌随请求发出并被 401', fn: () => EV.a?.wrong?.probe?.status === 401 && EV.a.wrong.probe.hadToken === true && EV.a.wrong.probe.token === WRONG },
  { id: 'E-05', label: '对令牌 → 外壳 5 钮结构（4 文字 + 1 纯图标）', fn: () => EV.a?.ok?.shell?.n === 5 && EV.a.ok.shell.texted === 4 && EV.a.ok.shell.iconOnly === 1 },
  { id: 'E-06', label: '对令牌校验请求 /api/projects → 200 + 正确请求头', fn: () => EV.a?.ok?.probe?.status === 200 && EV.a.ok.probe.hadToken === true && EV.a.ok.probe.token === TOKEN },
  { id: 'E-07', label: '夹具任务行经受守卫接口渲染', fn: () => EV.a?.ok?.row === true },
  { id: 'E-08', label: '刷新后本地令牌恢复（新文档代际已验证；移动壳不借 config 明文字段解锁）', fn: () => EV.a?.reload?.docChanged === true && EV.a.reload.shell === true && EV.a.reload.row === true && EV.a.reload.stored === TOKEN && EV.a.reload.configTokenOk === true },
  { id: 'E-09', label: '残留守卫令牌首访重弹令牌屏，重新输入后恢复', fn: () => EV.a?.stale?.screen === true && EV.a.stale.recovered === true && EV.a.stale.probe.status === 200 },
  { id: 'E-10', label: '未配令牌远程不出令牌屏，外壳直出', fn: () => EV.b?.shell === true && EV.b.screenSeen === false },
  { id: 'E-11', label: '未配令牌数据行直出', fn: () => EV.b?.row === true },
  { id: 'E-12', label: 'health 豁免 200 而数据接口无令牌 401（error=unauthorized）', fn: () => EV.c?.health?.status === 200 && EV.c.projectsNoToken.status === 401 && EV.c.projectsNoToken.error === 'unauthorized' },
  { id: 'E-13', label: '无令牌写接口 401 且零落库；带令牌写入成功且可查', fn: () => EV.c?.write?.noToken?.status === 401 && EV.c.write.noTokenAppears === false && EV.c.write.withToken.status >= 200 && EV.c.write.withToken.status < 300 && EV.c.write.appears === true },
  { id: 'E-14', label: '远程 tunnel/config 不下发明文令牌，本机下发（自同步seam）', fn: () => EV.c?.config?.remote?.status === 200 && EV.c.config.remote.token === '' && EV.c.config.remote.configured === true && EV.c.config.local.status === 200 && EV.c.config.local.token === TOKEN },
  { id: 'E-15', label: '远程隧道管理端点 403 且令牌未被重置', fn: () => EV.c?.mgmt?.status === 403 && EV.c.mgmt.tokenBefore === TOKEN && EV.c.mgmt.tokenAfter === TOKEN },
  { id: 'E-16', label: 'query token 不是全站旁路（数据接口仍 401）', fn: () => EV.c?.queryToken?.status === 401 },
  { id: 'E-17', label: '未配令牌实例对远程数据接口整体放行（既有语义）', fn: () => EV.c?.openB?.projects === 200 && EV.c.openB.config.token === '' && EV.c.openB.config.configured === false },
  { id: 'E-18', label: '全程无未捕获 JS 异常', fn: () => Array.isArray(EV.health?.jsErrors) && EV.health.jsErrors.length === 0 },
  { id: 'E-19', label: '全程无 5xx、无服务端异常日志', fn: () => EV.health?.fiveXx === 0 && EV.health.logErr === false },
  { id: 'E-20', label: '数据接口请求同样带对令牌（无旁路）', fn: () => EV.a?.ok?.tasks?.status === 200 && EV.a.ok.tasks.hadToken === true && EV.a.ok.tasks.token === TOKEN },
  { id: 'E-21', label: '远程桌面壳 config 为空值 → 不自解锁（配置后数据请求仍无令牌且 401）', fn: () => EV.d?.remote?.docChanged === true && EV.d.remote.configToken === '' && EV.d.remote.configConfigured === true && (EV.d.remote.stored === null || EV.d.remote.stored === '') && EV.d.remote.postSeam.status === 401 && EV.d.remote.postSeam.hadToken === false },
  { id: 'E-22', label: '本机桌面壳 config 明文 → 自动写入本地并用于后续数据请求', fn: () => EV.d?.local?.configToken === TOKEN && EV.d.local.synced === true && EV.d.local.stored === TOKEN && EV.d.local.tokenEvent.status === 200 && EV.d.local.tokenEvent.token === TOKEN },
];
const B = Object.fromEntries(BEHAVIOR.map((b) => [b.id, b.fn]));
const runBeh = (fn) => { try { return fn() === true; } catch { return false; } };

console.log('\n=== U 组：行为腿 ===');
for (const b of BEHAVIOR) ok(`${b.id} ${b.label}`, runBeh(b.fn));

// ---------------- 8) P 组：文案/标识符锚配对 ----------------
console.log('\n=== P 组：文案/标识符锚配对（行为失守⇒FAIL；行为在而锚失配⇒FAIL 交人判定） ===');
const ANCHORS = {
  probeCall: { needle: "api.get('/projects').then(() => setNeedToken(false))", src: SHELL_HEAD },
  probeUnauthorized: { needle: "e.message === 'unauthorized'", src: SHELL_HEAD },
  submitCall: { needle: 'await api.get(\'/projects\');', src: SHELL_HEAD },
  submitClear: { needle: "setAccessToken('');", src: SHELL_HEAD },
  tokenTitle: { needle: '访问口令', src: SHELL_HEAD },
  tokenPlaceholder: { needle: 'placeholder="粘贴访问口令"', src: SHELL_HEAD },
  tokenEnter: { needle: '>进入</button>', src: SHELL_HEAD },
  tabsDecl: { needle: "{ key: 'home', label: '任务', icon: ListTodo }", src: SHELL_HEAD },
  centerFlag: { needle: 'center: true', src: SHELL_HEAD },
  tunnelRemoteBlank: { needle: "accessToken: isLocalRequest(req) ? t.accessToken : '',", src: TUNNEL_HEAD },
  appAutoSync: { needle: 'if (c.accessToken) setAccessToken(c.accessToken);', src: APP_HEAD },
  forwardHeaders: { needle: "const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'cf-connecting-ip', 'x-real-ip'];", src: LOCAL_HEAD },
  forwardCheck: { needle: 'if (req.headers[h]) return false;', src: LOCAL_HEAD },
  healthExempt: { needle: "if (req.path === '/health') {", src: INDEX_HEAD },
  unauthorizedBody: { needle: "res.status(401).json({ error: 'unauthorized' });", src: INDEX_HEAD },
  tokenKey: { needle: "const TOKEN_KEY = 'mtask.accessToken';", src: CLIENT_HEAD },
  tokenHeader: { needle: "'X-Access-Token': accessToken", src: CLIENT_HEAD },
  uiOverride: { needle: "if (override === '1') return 'mobile';", src: APP_HEAD },
  uiDesktop: { needle: "if (override === '0') return 'desktop';", src: APP_HEAD },
};
const P_SPECS = [
  { id: 'P-01', anchors: ['probeCall', 'probeUnauthorized'], behavior: () => B['E-01']() && B['E-02'](), label: '探测走 /projects 且 401 触发令牌屏（行为腿同源）' },
  { id: 'P-02', anchors: ['submitCall', 'submitClear'], behavior: () => B['E-03']() && B['E-05'](), label: '提交校验同走 /projects，失败清本地令牌；成功后外壳在' },
  { id: 'P-03', anchors: ['tokenTitle', 'tokenPlaceholder', 'tokenEnter'], behavior: () => B['E-01'](), label: '令牌屏标题/占位/进入按钮字面在场，且令牌屏结构句柄在跑' },
  { id: 'P-04', anchors: ['tabsDecl', 'centerFlag'], behavior: () => B['E-05'](), label: '底栏任务 Tab 声明与中央标注字面在场，且 5 钮结构为该形态' },
  { id: 'P-05', anchors: ['tunnelRemoteBlank', 'appAutoSync'], behavior: () => B['E-21']() && B['E-22'](), label: '远程 config 置空 + 本机自同步只认非空；桌面壳两个方向都实测' },
  { id: 'P-06', anchors: ['forwardHeaders', 'forwardCheck'], behavior: () => B['E-14']() && B['E-15'](), label: '转发头判据字面在场，且远程判定确实翻转 config/管理端点' },
  { id: 'P-07', anchors: ['healthExempt', 'unauthorizedBody'], behavior: () => B['E-12'](), label: 'health 豁免与 401 响应体字面在场，且健康 200/数据 401 实测成立' },
  { id: 'P-08', anchors: ['tokenKey', 'tokenHeader'], behavior: () => B['E-06']() && B['E-22'](), label: '本地令牌键与请求头字面在场，且令牌真的随请求发出、并可由配置同步写入' },
  { id: 'P-09', anchors: ['uiOverride', 'uiDesktop'], behavior: () => B['E-01']() && B['E-10'](), label: '?m=1/m=0 覆盖字面在场，且 A 相位确实以移动外壳/令牌屏呈现' },
];
const literalOf = (spec, override) => spec.anchors.every((k) => {
  const a = ANCHORS[k];
  return (override === undefined ? a.src : override).includes(a.needle);
});
for (const spec of P_SPECS) {
  okPair(ok, `${spec.id} ${spec.label}`, spec.behavior, () => literalOf(spec), () => ({ spec: spec.id, anchors: spec.anchors }));
}

// ---------------- 9) N 组：负对照 ----------------
console.log('\n=== N 组：负对照 ===');
const withEV = (obj, fn) => { const saved = EV; EV = obj; try { return fn(); } finally { EV = saved; } };
ok('N-01 空源码探针：9 条字面腿喂空串后全部为假（没有不承重的正则）',
  P_SPECS.every((s) => literalOf(s, '') === false));
ok('N-01b HEAD 文本在场性：19 个锚点在已提交树里逐字命中',
  Object.values(ANCHORS).every((a) => a.src.length > 0 && a.src.includes(a.needle)),
  Object.entries(ANCHORS).filter(([, a]) => !a.src.includes(a.needle)).map(([k]) => k));
ok('N-02 敏感度探针：抽干运行期实测料后 22 条行为腿全部转假——行为腿确实在读实测，不是恒真',
  BEHAVIOR.every((b) => withEV({}, b.fn) === false),
  BEHAVIOR.filter((b) => withEV({}, b.fn) !== false).map((b) => b.id));
ok('N-02b 还原实证：实测料回填后同一批行为腿重新为真（N-02 的红不是恒红）',
  BEHAVIOR.every((b) => runBeh(b.fn) === true),
  BEHAVIOR.filter((b) => runBeh(b.fn) !== true).map((b) => b.id));
const renamed = [];
for (const [key, a] of Object.entries(ANCHORS)) {
  const tampered = a.src.split(a.needle).join('⟪改名⟫');
  const spec = P_SPECS.find((s) => s.anchors.includes(key));
  renamed.push({ key, spec: spec?.id, selfProof: tampered !== a.src, gone: !tampered.includes(a.needle), literalFalse: spec ? literalOf(spec, tampered) === false : false });
}
ok('N-03 改名模拟：19 个锚点逐个从 HEAD 副本抹掉后字面判据各自转假（每条自证 tampered !== original）',
  renamed.every((r) => r.selfProof && r.gone && r.literalFalse && r.spec),
  renamed.filter((r) => !(r.selfProof && r.gone && r.literalFalse && r.spec)));
{
  const rec = [];
  const recOk = (name, cond, extra) => rec.push({ name, cond, extra });
  okPair(recOk, '契约-行为假', () => false, () => true);
  okPair(recOk, '契约-字面假', () => true, () => false);
  okPair(recOk, '契约-双真', () => true, () => true);
  ok('N-04 okPair 落地：行为失守记「行为失守」、锚子失配记「字面锚点失配」、两者齐绿才判绿',
    rec.length === 3 && rec[0].cond === false && /行为失守/.test(rec[0].extra?.红因)
    && rec[1].cond === false && /字面锚点失配/.test(rec[1].extra?.红因) && rec[2].cond === true, rec);
}
const MUTATIONS = {
  'E-01': (e) => { e.a.initial.tokenScreen = false; },
  'E-02': (e) => { e.a.initial.probe.status = 200; },
  'E-03': (e) => { e.a.wrong.stayed = false; },
  'E-04': (e) => { e.a.wrong.probe.status = 403; },
  'E-05': (e) => { e.a.ok.shell.texted = 3; },
  'E-06': (e) => { e.a.ok.probe.status = 401; },
  'E-07': (e) => { e.a.ok.row = false; },
  'E-08': (e) => { e.a.reload.docChanged = false; },
  'E-09': (e) => { e.a.stale.recovered = false; },
  'E-10': (e) => { e.b.screenSeen = true; },
  'E-11': (e) => { e.b.row = false; },
  'E-12': (e) => { e.c.health.status = 401; },
  'E-13': (e) => { e.c.write.noToken.status = 200; },
  'E-14': (e) => { e.c.config.remote.token = TOKEN; },
  'E-15': (e) => { e.c.mgmt.status = 200; },
  'E-16': (e) => { e.c.queryToken.status = 200; },
  'E-17': (e) => { e.c.openB.projects = 401; },
  'E-18': (e) => { e.health.jsErrors = ['boom']; },
  'E-19': (e) => { e.health.fiveXx = 1; },
  'E-20': (e) => { e.a.ok.tasks.status = 401; },
  'E-21': (e) => { e.d.remote.configToken = TOKEN; },
  'E-22': (e) => { e.d.local.configToken = ''; },
};
const mutResults = BEHAVIOR.map((b) => {
  const mutate = MUTATIONS[b.id];
  if (!mutate) return { id: b.id, turnedFalse: 'no-mutation' };
  const e = structuredClone(EV);
  mutate(e);
  return { id: b.id, turnedFalse: withEV(e, b.fn) === false };
});
ok('N-05 破坏形态反证：22 类实测料被改写后对应行为腿各自转假（探测/令牌屏/拒错/放行/刷新/失效令牌/未配实例/守卫矩阵/写闸/泄漏/管理闸/query 旁路/桌面自同步/健康）',
  mutResults.every((r) => r.turnedFalse === true), mutResults.filter((r) => r.turnedFalse !== true));

console.log(`\n结果：PASS=${pass} FAIL=${fail}｜截图：${shotFiles.join('、') || '无'}`);
ws.close();
bye();
process.exit(fail === 0 ? 0 : 1);
