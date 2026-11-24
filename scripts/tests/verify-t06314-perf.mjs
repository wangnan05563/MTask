/**
 * T06314 浏览器性能探针：5k 任务列表/看板滚动帧率 + DOM 规模。
 * 前置：5217 隔离服务已启动（5k 夹具）。只读/滚动，不写业务数据。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.T06314_API || 'http://127.0.0.1:5217';
const PROJECT = 'p-t06314-perf';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'C:/Users/hspcadmin/AppData/Local/Temp/t06314-ui';
if (!existsSync(CHROME)) throw new Error(`Chrome 不存在：${CHROME}`);
mkdirSync(OUT, { recursive: true });
try { rmSync(join(OUT, 'profile'), { recursive: true, force: true }); } catch { /* ignore */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const say = (name, ok, extra) => {
  checks.push({ name, ok: Boolean(ok), extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1500)}`}`);
};
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } };

const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
say('T06314-API-00 隔离服务就绪', health?.ok === true, health);
const projects = await fetch(`${API}/api/projects`).then((r) => r.json()).catch(() => []);
const perfProject = Array.isArray(projects) ? projects.find((p) => p.id === PROJECT) : null;
say('T06314-API-01 5k 数据集就绪', perfProject?.todo_count === 5000, { todo_count: perfProject?.todo_count, done_count: perfProject?.done_count });
const searchTimes = [];
for (let i = 0; i < 30; i += 1) {
  const q = ['压测任务', '性能滚动', 'T06314-4', '压测任务 4999'][i % 4];
  const t0 = performance.now();
  const rows = await fetch(`${API}/api/tasks?projectId=${PROJECT}&limit=200&keyword=${encodeURIComponent(q)}`).then((r) => r.json());
  searchTimes.push(performance.now() - t0);
  if (i < 4) say(`T06314-API-02${i === 0 ? '' : `-${i}`} 搜索返回行数受 limit=200 约束`, Array.isArray(rows) && rows.length > 0 && rows.length <= 200, { q, rows: Array.isArray(rows) ? rows.length : null });
}
searchTimes.sort((a, b) => a - b);
const p50 = searchTimes[14];
const p95 = searchTimes[28];
const max = searchTimes[29];
say('T06314-API-03 5k 搜索 p95 < 300ms', p95 < 300, { p50: +p50.toFixed(1), p95: +p95.toFixed(1), max: +max.toFixed(1), min: +searchTimes[0].toFixed(1) });

let chrome = null;
let ws = null;
let seq = 0;
const pending = new Map();
const events = new Map();
function onEvent(method, fn) { const l = events.get(method) || []; l.push(fn); events.set(method, l); }
function send(method, params = {}, timeout = 60_000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
async function evl(expression, timeout = 60_000) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result?.value;
}
async function until(expression, timeout = 30_000, step = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evl(expression, 10_000)) return true; } catch { /* retry */ }
    await sleep(step);
  }
  return false;
}
async function fps(label, ms = 2600) {
  await evl(`(() => {
    try { clearInterval(window.__t06314Scroll); clearInterval(window.__t06314Stop); } catch {}
    window.__t06314Frames = [];
    window.__t06314Start = performance.now();
    window.__t06314Dir = 1;
    const loop = (t) => {
      if (!window.__t06314Running) return;
      window.__t06314Frames.push(t);
      requestAnimationFrame(loop);
    };
    window.__t06314Running = true;
    requestAnimationFrame(loop);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, max > 0 ? Math.round(max * 0.5) : 0);
    window.__t06314Scroll = setInterval(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (window.scrollY >= max - 2) window.__t06314Dir = -1;
      else if (window.scrollY <= 2) window.__t06314Dir = 1;
      window.scrollBy(0, window.__t06314Dir * 420);
    }, 70);
    window.__t06314Stop = setTimeout(() => {
      window.__t06314Running = false; clearInterval(window.__t06314Scroll);
    }, ${ms});
    return true;
  })()`);
  await sleep(ms + 900);
  const raw = await evl(`(() => {
    const f = window.__t06314Frames || [];
    const d = []; for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
    d.sort((a, b) => a - b);
    const elapsed = f.length > 1 ? (f[f.length - 1] - f[0]) : 0;
    return {
      frames: f.length,
      elapsed,
      avgFps: elapsed > 0 ? (f.length - 1) / elapsed * 1000 : 0,
      p95: d.length ? d[Math.floor(d.length * 0.95)] : 0,
      max: d.length ? d[d.length - 1] : 0,
      longFrames: d.filter((x) => x > 34).length,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
    };
  })()`);
  const rounded = { ...raw, avgFps: +raw.avgFps.toFixed(1), p95: +raw.p95.toFixed(1), max: +raw.max.toFixed(1) };
  say(`${label} 滚动帧率`, rounded.avgFps >= 55 && rounded.p95 <= 22, rounded);
  return rounded;
}

try {
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,1000',
    '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 30s 未报端口')), 30_000);
    const on = (d) => { buf += String(d); const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(buf); if (m) { clearTimeout(timer); resolve(Number(m[1])); } };
    chrome.stderr.on('data', on); chrome.stdout.on('data', on);
    chrome.on('exit', (c) => { clearTimeout(timer); reject(new Error(`Chrome 退出 ${c} ${buf.slice(-200)}`)); });
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((x) => x.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else {
      for (const fn of events.get(msg.method) || []) fn(msg.params);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${API}/index.html` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => {
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(PROJECT))});
    localStorage.setItem('mtask.guide.seen.dashboard', '1');
    localStorage.setItem('mtask.guide.seen.exec-sessions', '1');
    sessionStorage.setItem('tasks.viewMode', '"list"');
    return true;
  })()`);
  await send('Page.navigate', { url: `${API}/index.html` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  const tNav = Date.now();
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); return true; })()`);
  const ready = await until(`document.querySelectorAll('li.task-item').length > 0`, 20_000);
  say('T06314-UI-01 5k 项目任务页首屏可用', ready, { rows: await evl(`document.querySelectorAll('li.task-item').length`), ms: Date.now() - tNav });

  const firstRows = await evl(`document.querySelectorAll('li.task-item').length`);
  say('T06314-UI-02 首屏按页加载且 DOM 行数有界', firstRows > 0 && firstRows < 500, { rows: firstRows });

  const board = await evl(`(() => { const b=[...document.querySelectorAll('button[aria-label="看板视图"]')][0]; if(!b) return false; b.click(); return true; })()`);
  say('T06314-UI-03 切到看板视图', board, { board });
  await until(`document.querySelectorAll('button[aria-label*="压测任务"]').length > 0`, 25_000);
  const boardCards200 = await evl(`document.querySelectorAll('button[aria-label*="压测任务"]').length`);
  const boardCols = await evl(`document.querySelectorAll('ul[aria-label*="可拖放任务卡片"]').length`);
  say('T06314-UI-04 看板首屏卡片与两列结构', boardCards200 > 0 && boardCols === 2, { boardCards200, boardCols });
  const b200 = await fps('T06314-UI-05 看板首屏(200卡)', 2600);
  if (boardCards200 > 0) say('T06314-UI-05b 看板首屏 DOM 卡片数=当前页', boardCards200 <= 200, { boardCards200 });

  // 回列表并触发触底续取，把 5k 全量装入内存
  await evl(`(() => { const b=[...document.querySelectorAll('button[aria-label="列表视图"]')][0]; b?.click(); return true; })()`);
  await until(`document.querySelectorAll('li.task-item').length > 0`, 20_000);
  let loaded = 0;
  const tLoad = Date.now();
  for (let i = 0; i < 45; i += 1) {
    await evl(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await sleep(420);
    const n = await evl(`document.querySelectorAll('li.task-item').length`);
    if (n > loaded) loaded = n;
    const more = await evl(`Boolean(document.querySelector('[data-t03215-window]')) && document.documentElement.scrollHeight > window.innerHeight`);
    if (Date.now() - tLoad > 18_000) break;
    if (!more) break;
  }
  await sleep(900);
  const rows5k = await evl(`document.querySelectorAll('li.task-item').length`);
  const apiCount = await fetch(`${API}/api/tasks?projectId=${PROJECT}&limit=1&scope=all`).then((r) => r.json()).catch(() => null);
  say('T06314-UI-06 5k 全量续取后 DOM 行仍窗口化', rows5k > 0 && rows5k < 200, { rows5k, loaded, apiSample: Array.isArray(apiCount) ? apiCount.length : null, ms: Date.now() - tLoad });
  await sleep(1800);
  const l5k = await fps('T06314-UI-07 列表5k全量', 2600);

  const tBoard = Date.now();
  await evl(`(() => { const b=[...document.querySelectorAll('button[aria-label="看板视图"]')][0]; b?.click(); return true; })()`);
  await until(`document.querySelectorAll('button[aria-label*="压测任务"]').length > 0`, 40_000);
  await sleep(500);
  const boardCards5k = await evl(`document.querySelectorAll('button[aria-label*="压测任务"]').length`);
  say('T06314-UI-08 5k 全量切看板后的 DOM 卡片规模', boardCards5k > 0, { boardCards5k, switchMs: Date.now() - tBoard });
  if (boardCards5k > 200) {
    const b5k = await fps('T06314-UI-09 看板5k全量', 2600);
  } else {
    say('T06314-UI-09 看板5k全量', false, { reason: '看板未呈现全量卡片，无法验证 5k 滚动', boardCards5k });
  }

  writeFileSync(join(OUT, 'perf-result.json'), JSON.stringify({ checks, list5k: l5k, board200: b200 }, null, 2), 'utf8');
} catch (e) {
  say('T06314-UI-ERR 未捕获异常', false, String(e?.stack || e));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome?.pid) killTree(chrome.pid);
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`PASS=${pass} FAIL=${fail} OUT=${OUT}`);
  process.exit(fail ? 1 : 0);
}
