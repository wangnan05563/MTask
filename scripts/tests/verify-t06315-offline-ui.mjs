/**
 * T06315 浏览器离线捕获验收：移动端真实断网 → 随手记落草稿 → 顶栏「待同步」立即可见。
 * 前置：5217 隔离服务 + web/dist 已构建。只写浏览器 localStorage，不写业务库。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.T06315_API || 'http://127.0.0.1:5217';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'C:/Users/hspcadmin/AppData/Local/Temp/t06315-ui';
const EVID = 'D:/code/otherProjects/MTask/docs/evidence/p10-ui';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(CHROME)) throw new Error(`Chrome 不存在：${CHROME}`);
mkdirSync(OUT, { recursive: true });
mkdirSync(EVID, { recursive: true });
try { rmSync(join(OUT, 'profile'), { recursive: true, force: true }); } catch { /* ignore */ }
const checks = [];
const say = (name, ok, extra) => {
  checks.push({ name, ok: Boolean(ok), extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1200)}`}`);
};

let chrome = null;
let ws = null;
let seq = 0;
const pending = new Map();
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
async function until(expression, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evl(expression, 8_000)) return true; } catch { /* retry */ }
    await sleep(200);
  }
  return false;
}
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } };

try {
  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  say('T06315-UI-01 隔离服务就绪', health?.ok === true, health);
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=390,844',
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
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${API}/index.html?m=1` });
  const shellReady = await until(`Boolean(document.querySelector('button[aria-label="随手记"]'))`, 25_000);
  say('T06315-UI-02 移动端外壳加载', shellReady, { shellReady });
  await evl(`(() => { try { localStorage.removeItem('mtask.mobileDrafts'); localStorage.setItem('mtask.pwaGuide.seen','1'); } catch {} return true; })()`);
  await send('Page.reload');
  await until(`Boolean(document.querySelector('button[aria-label="随手记"]'))`, 20_000);
  await until(`document.body.innerText.includes('在线')`, 10_000);

  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await evl(`window.dispatchEvent(new Event('offline')); true`);
  const offlineShown = await until(`document.body.innerText.includes('离线中——正在浏览缓存数据')`, 10_000);
  say('T06315-UI-03 断网状态与离线横幅', offlineShown, { offlineShown });

  await evl(`(() => { document.querySelector('button[aria-label="随手记"]')?.click(); return true; })()`);
  await until(`Boolean(document.querySelector('textarea[aria-label="随手记标题"]'))`, 10_000);
  await evl(`(() => {
    const el = document.querySelector('textarea[aria-label="随手记标题"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '离线 UI 捕获 T06315');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  const typed = await evl(`document.querySelector('textarea[aria-label="随手记标题"]').value`);
  say('T06315-UI-04 随手记输入可用', typed === '离线 UI 捕获 T06315', { typed });
  await evl(`(() => { document.querySelector('button[aria-label="完成"]')?.click(); return true; })()`);
  const toast = await until(`document.body.innerText.includes('已存为草稿')`, 10_000);
  const stored = await evl(`(() => { try { return JSON.parse(localStorage.getItem('mtask.mobileDrafts') || '[]'); } catch { return []; } })()`);
  say('T06315-UI-05 断网提交落草稿并提示', toast && Array.isArray(stored) && stored.length === 1 && stored[0]?.title === '离线 UI 捕获 T06315',
    { toast, drafts: stored });
  const badge = await evl(`document.body.innerText.includes('待同步 1')`);
  say('T06315-UI-06 顶栏「待同步」即时可见（修复回归）', badge === true, { badge });
  const banner = await evl(`document.body.innerText.includes('离线中——正在浏览缓存数据')`);
  say('T06315-UI-07 草稿保存后仍保持离线态', banner === true, { banner });
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(EVID, '54-t06315-offline-draft-390.png');
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  say('T06315-UI-08 移动端 390 证据截图', existsSync(file), { file });
  writeFileSync(join(OUT, 'ui-result.json'), JSON.stringify({ checks }, null, 2), 'utf8');
} catch (e) {
  say('T06315-UI-ERR 未捕获异常', false, String(e?.stack || e));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome?.pid) killTree(chrome.pid);
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`PASS=${pass} FAIL=${fail} OUT=${OUT}`);
  process.exit(fail ? 1 : 0);
}
