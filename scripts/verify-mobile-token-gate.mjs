#!/usr/bin/env node
/**
 * 移动端隧道鉴权门（修复回归）：MobileShell 鉴权探测端点必须是受守卫接口。
 * 背景：探测曾用 /health（accessTokenGuard 探活豁免路径），永远 200 → 令牌屏永不出现，
 * 公网首开用户只见空壳 + 数据 401；且 submitToken 校验也走 /health，任意垃圾令牌都「通过」。
 *
 * 关键前提：服务端 isLocalRequest 按「Host 非回环 / 转发头」判定本机 vs 远程；
 * 本机访问时 App 启动会从豁免的 /tunnel/config 明文自同步令牌（App.tsx L106-110），
 * 因此打 127.0.0.1 永远走免令牌路径、测不到令牌屏。这里用 CDP Network.setExtraHTTPHeaders
 * 覆写 Host 为非回环名，忠实模拟「经隧道远程访问」的服务端视角（零基础设施改动）。
 *
 * A 相位（已配令牌）：?m=1 → 访问口令屏出现 → 错令牌被拒（屏不退）→ 对令牌放行 + 数据行渲染。
 * B 相位（未配令牌）：?m=1 → 不出令牌屏，直接渲染外壳 + 数据行（无令牌配置则直接放行）。
 * 前置：web dist 已构建（含修复）；隔离实例用 managed node 22（nodejs24 触发 esbuild
 * "The service was stopped"，2026-10-13 实测）。
 * 运行：node scripts/verify-mobile-token-gate.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, p, i) => { if (!p) failures++; console.log(`  [${p ? 'PASS' : 'FAIL'}] ${n}${i ? ' → ' + String(i).slice(0, 200) : ''}`); };
const TOKEN = 'gate-token-a1b2c3d4';
const TS = 'C:/Program Files/Tailscale/tailscale.exe';
const TS_HOST = 'desktop-g10o4nl.tailbca47.ts.net';
// 服务端 isLocalRequest 按 Host 非回环判远程；本机 127.0.0.1 会被 App 自同步令牌（免令牌路径），
// 故经 tailscale serve 临时挂载隔离实例走真隧道链路（tailnet-only，非公网 Funnel），测完即清理。
const SERVE_PATH_A = '/mtask-gate-a';
const SERVE_PATH_B = '/mtask-gate-b';
async function tsServe(pathP, port) {
  await new Promise((res) => {
    const p = spawn(TS, ['serve', '--bg', '--set-path', pathP, `http://127.0.0.1:${port}`], { stdio: 'ignore' });
    p.on('exit', res); procs.push(p);
  });
  await sleep(2500);
}
/** 快照当前 funnel/serve 配置（serve status --json：Web[host].Handlers + AllowFunnel） */
async function tsSnapshot() {
  const out = await new Promise((res) => {
    const p = spawn(TS, ['serve', 'status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = ''; p.stdout.on('data', (c) => { s += c; }); p.on('exit', () => res(s));
  });
  try { return JSON.parse(out); } catch { return null; }
}
/** 全量关闭（本版本 tailscale 的 off 无论带不带路径参数都会清空全部配置——实测踩坑） */
async function tsWipeAll() {
  await new Promise((res) => { const p = spawn(TS, ['funnel', '--https=443', 'off'], { stdio: 'ignore' }); p.on('exit', res); });
}
/** 按快照回放：所有 Handler 一律以 funnel --bg --set-path 重建（本机存量全是 funnel 项；node spawn 无 MSYS 路径改写问题） */
async function tsRestore(snap) {
  if (!snap?.Web) return;
  for (const handlers of Object.values(snap.Web)) {
    for (const [pathP, cfg] of Object.entries(handlers?.Handlers ?? {})) {
      if (!cfg?.Proxy) continue;
      await new Promise((res) => { const p = spawn(TS, ['funnel', '--bg', '--yes', `--set-path=${pathP}`, cfg.Proxy], { stdio: 'ignore' }); p.on('exit', res); });
      await sleep(400);
    }
  }
}
const SHOTS = path.join(process.cwd(), '.workbuddy', 'tunnel-mobile-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const procs = [];
const bye = () => { for (const p of procs) { try { spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } };
process.on('exit', bye);

function startServer(port, dataDir) {
  const p = spawn('C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-6/node.exe', [path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], {
    cwd: path.join(process.cwd(), 'server'),
    env: { ...process.env, MTask_DATA_DIR: dataDir, MTask_PORT: String(port) },
    stdio: 'ignore', shell: process.platform === 'win32',
  });
  procs.push(p);
  return p;
}
async function waitHealth(port) {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* */ } await sleep(500); }
  return false;
}
/** 端口预检：被占即硬失败。教训：孤儿实例占端口时新实例 EADDRINUSE 静默崩溃（stdio ignore），
 * 健康检查打到孤儿——无令牌配置的旧实例会让 A 相位永远不弹令牌屏（2026-10-13 实测踩坑）。 */
async function assertPortFree(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); if (r.ok) throw new Error(`端口 ${port} 已被孤儿实例占用，先清理再跑`); } catch (e) { if (String(e).includes('占用')) throw e; }
}
async function seedTask(port, title, token) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Access-Token': token } : {}) }, body: JSON.stringify({ projectId: 'sys-inbox', title, description: 'x' }) })).json());
}

// ---- 隔离实例 A：预写隧道配置（含 accessToken）
const TMP_A = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-tokengate-a-'));
fs.mkdirSync(path.join(TMP_A, 'tunnel'), { recursive: true });
fs.writeFileSync(path.join(TMP_A, 'tunnel', 'tunnel-config.json'), JSON.stringify({ accessToken: TOKEN, provider: 'tailscale' }));
const PORT_A = 39917;
await assertPortFree(PORT_A);
startServer(PORT_A, TMP_A);
if (!await waitHealth(PORT_A)) { console.error('实例 A 未就绪'); process.exit(1); }
const seededA = await seedTask(PORT_A, '移动端令牌门探针A', TOKEN); // 实例 A 已配令牌，建单必须携带
if (!seededA?.id) { console.error('实例 A 种子失败:', JSON.stringify(seededA)); process.exit(1); }
console.log(`实例 A（已配令牌）: 39917 就绪，种子任务 ${seededA.id}`);

// ---- 隔离实例 B：无令牌配置
const TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-tokengate-b-'));
const PORT_B = 39918;
await assertPortFree(PORT_B);
startServer(PORT_B, TMP_B);
if (!await waitHealth(PORT_B)) { console.error('实例 B 未就绪'); process.exit(1); }
const seededB = await seedTask(PORT_B, '移动端令牌门探针B');
console.log(`实例 B（未配令牌）: 39918 就绪，种子任务 ${seededB.id}`);

// ---- Chrome 移动视口（?m=1 强制移动端，headless 无 touch 必须用 URL 参数）
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--remote-debugging-port=9342', '--headless=new', '--no-first-run', '--disable-gpu',
  '--window-size=400,850', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'tokengate-'))}`, 'about:blank',
], { stdio: 'ignore' });
procs.push(chrome);
let targets;
for (let i = 0; i < 30; i++) { try { const r = await fetch('http://127.0.0.1:9342/json/list'); if (r.ok) { targets = await r.json(); break; } } catch { /* */ } await sleep(400); }
if (!targets) { console.error('Chrome CDP 未就绪'); process.exit(1); }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (evd) => { const m = JSON.parse(evd.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = (name) => send('Page.captureScreenshot').then((r) => { if (r?.result?.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64')); });
await send('Network.enable');

const navigate = (url) => send('Page.navigate', { url });
const waitTokenScreen = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    if (document.body.textContent.includes('访问口令') && document.querySelector('input[placeholder="粘贴访问口令"]')) return 'token-screen';
    await sleep(500);
  }
  return 'no-token-screen: ' + document.body.textContent.replace(/\\s+/g, ' ').slice(0, 120);
})()`;
const waitInput = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 20; i++) { if (document.querySelector('input[placeholder="粘贴访问口令"]')) return true; await sleep(400); }
  return false;
})()`;
const setTokenAndSubmit = (token) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const input = document.querySelector('input[placeholder="粘贴访问口令"]');
  if (!input) return 'input-missing';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(token)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  // 真机主路径：点「进入」按钮（合成 keydown 在 headless 下未触发 React onKeyDown，实测）
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '进入');
  if (btn) btn.click();
  else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(1800);
  return 'submitted';
})()`;
const waitShell = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    const labels = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
    // 底栏中央「随手记」是纯图标按钮（无文本），断言用其余 4 个 Tab
    if (labels.includes('任务') && labels.includes('队列') && labels.includes('提示词') && labels.includes('更多')) return 'shell-ok';
    await sleep(500);
  }
  return 'shell-missing: ' + document.body.textContent.replace(/\\s+/g, ' ').slice(0, 120);
})()`;
const waitRow = (title) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 25; i++) {
    const labels = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label'));
    if (labels.some(l => (l || '').includes(${JSON.stringify(title)}))) return 'rows-ok';
    await sleep(500);
  }
  return 'rows-missing';
})()`;

console.log('\nA 相位：已配令牌（期望令牌屏 → 错令牌拒 → 对令牌放行）');
const tsSnap = await tsSnapshot(); // 先快照用户配置，结束后全清+回放（按路径 off 在本版本等于全清）
await tsServe(SERVE_PATH_A, PORT_A);
await tsServe(SERVE_PATH_B, PORT_B);
console.log(`隧道挂载: https://${TS_HOST}${SERVE_PATH_A}/ 与 ${SERVE_PATH_B}/（tailnet-only，结束即卸载）`);
await navigate(`https://${TS_HOST}${SERVE_PATH_A}/?m=1`);
const a1 = await ev(waitTokenScreen);
check('A1 令牌屏出现（探测端点受守卫后 401 触发）', a1 === 'token-screen', a1);
await shot('gate-a1-token-screen.png');

const a2in = await ev(waitInput);
const a2 = await ev(setTokenAndSubmit('wrong-token-deliberately'));
const a2still = await ev(`document.body.textContent.includes('访问口令')`);
check('A2 错令牌被拒：令牌屏不退（受守卫端点 401）', a2in === true && a2 === 'submitted' && a2still === true, `${a2in}/${a2}/${a2still}`);
await shot('gate-a2-wrong-token.png');

const a3in = await ev(waitInput);
const a3sub = await ev(setTokenAndSubmit(TOKEN));
// 提交后可能发生 SW 激活自刷新（skipWaiting+controllerchange）→ 带令牌冷启动 ~20s，窗口给足
const a3shell = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 70; i++) {
    const labels = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
    if (labels.includes('任务') && labels.includes('队列') && labels.includes('提示词') && labels.includes('更多')) return 'shell-ok';
    await sleep(500);
  }
  return 'shell-missing: ' + document.body.textContent.replace(/\\s+/g, ' ').slice(0, 120);
})()`);
check('A3 对令牌放行：移动端外壳渲染', a3in === true && a3sub === 'submitted' && a3shell === 'shell-ok', `${a3in}/${a3sub}/${a3shell}`);
const a3row = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 50; i++) {
    const labels = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label'));
    if (labels.some(l => (l || '').includes('移动端令牌门探针A'))) return 'rows-ok';
    await sleep(500);
  }
  return 'rows-missing';
})()`);
check('A3b 种子任务行经受令牌 API 渲染', a3row === 'rows-ok', a3row);
await shot('gate-a3-ok.png');

console.log('\nB 相位：未配令牌（期望无令牌屏直接放行）');
await navigate(`https://${TS_HOST}${SERVE_PATH_B}/?m=1`);
const b1 = await ev(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 50; i++) {
    const labels = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
    if (labels.includes('任务') && labels.includes('队列')) return 'no-screen-shell-ok';
    if (document.body.textContent.includes('访问口令')) return 'screen-shown-bad';
    await sleep(500);
  }
  return 'timeout';
})()`);
check('B1 无令牌配置不出令牌屏、外壳直渲染', b1 === 'no-screen-shell-ok', b1);
const b2 = await ev(waitRow('移动端令牌门探针B'));
check('B2 数据行直渲染（豁免语义未破坏）', b2 === 'rows-ok', b2);
await shot('gate-b1-no-token.png');

console.log(failures > 0 ? `\n失败 ${failures} 项` : '\n门全绿 ✓');
ws.close();
await tsWipeAll();
await tsRestore(tsSnap);
const tsCheck = await tsSnapshot();
console.log('tailscale 配置已按快照回放，Handler 数 =', Object.values(tsCheck?.Web ?? {})[0]?.Handlers ? Object.keys(Object.values(tsCheck.Web)[0].Handlers).length : 0);
bye();
process.exit(failures > 0 ? 1 : 0);
