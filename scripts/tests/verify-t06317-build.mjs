/**
 * T06317 构建打包优化验收：
 * ① 产物已拆分 vendor chunk（主入口体积/压缩体积可复核）；
 * ② AC-08：主题列表切换 → 200ms 内完成渲染（连续三轮，取每次双 rAF 实测）；
 * ③ 首屏启动指标（DOMContentLoaded / FCP）留证。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const API = process.env.T06317_API || 'http://127.0.0.1:5217';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIST = 'D:/code/otherProjects/MTask/web/dist';
const OUT = 'C:/Users/hspcadmin/AppData/Local/Temp/t06317-build';
const EVID = 'D:/code/otherProjects/MTask/docs/evidence/p10-ui';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
mkdirSync(EVID, { recursive: true });
const checks = [];
const say = (name, ok, extra) => {
  checks.push({ name, ok: Boolean(ok), extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1200)}`}`);
};

// ---------- 产物静态核对 ----------
const assets = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
const sizes = assets.map((f) => {
  const raw = readFileSync(join(DIST, 'assets', f));
  return { file: f, bytes: raw.length, gzip: gzipSync(raw, { level: 9 }).length };
});
const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
const total = sizes.reduce((s, x) => s + x.bytes, 0);
say('T06317-01 产物已拆 vendor-react/graph/markdown/icons', ['vendor-react', 'vendor-graph', 'vendor-markdown', 'vendor-icons']
  .every((n) => assets.some((f) => f.startsWith(n))), sizes);
const main = sizes.find((x) => x.file.startsWith('index-'));
say('T06317-02 主入口包 ≤ 2.2MB / gzip ≤ 620KB', Boolean(main && main.bytes <= 2_200_000 && main.gzip <= 620_000), main);
say('T06317-03 index.html 以 modulepreload 拉取 vendor（非单包内联）', (indexHtml.match(/modulepreload/g) || []).length >= 3, { preload: (indexHtml.match(/modulepreload/g) || []).length });
writeFileSync(join(OUT, 'assets.json'), JSON.stringify({ assets: sizes, total, main }, null, 2), 'utf8');

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
    await sleep(150);
  }
  return false;
}
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } };

try {
  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  say('T06317-04 隔离服务就绪', health?.ok === true, health);
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 30s 未报端口')), 30_000);
    const on = (d) => { buf += String(d); const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(buf); if (m) { clearTimeout(timer); resolve(Number(m[1])); } };
    chrome.stderr.on('data', on); chrome.stdout.on('data', on);
    chrome.on('exit', (c) => { clearTimeout(timer); reject(new Error(`Chrome 退出 ${c} ${buf.slice(-200)}`)); });
  });
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page');
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${API}/index.html` });
  const ready = await until(`Boolean(document.querySelector('nav')) && document.body.innerText.includes('任务')`, 30_000);
  say('T06317-05 首页加载完成', ready, { ready });
  const navPerf = await evl(`(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const fcp = performance.getEntriesByName('first-contentful-paint')[0] || {};
    const res = performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js'));
    return { domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0), fcp: Math.round(fcp.startTime || 0), jsCount: res.length, transfer: res.reduce((s, r) => s + (r.transferSize || 0), 0) };
  })()`);
  say('T06317-06 首屏指标可读（DOMContentLoaded/load）', navPerf.domContentLoaded > 0 && navPerf.load > 0, navPerf);
  await evl(`window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'settings' } })); true`);
  const settingsReady = await until(`Boolean(document.querySelector('[aria-label="主题：深色"]')) && document.body.innerText.includes('主题预设')`, 20_000);
  say('T06317-07 设置页主题列表可达', settingsReady, { settingsReady });
  const guideClosed = await evl(`(() => {
    const close = document.querySelector('[aria-label="关闭向导"]');
    if (close) { close.click(); return true; }
    return false;
  })()`);
  await until(`!document.querySelector('[aria-label="关闭向导"]')`, 5_000);
  say('T06317-07b 使用向导已关闭（主题按钮可被真实点击）', guideClosed === true && await evl(`!document.querySelector('[aria-label="关闭向导"]')`), { guideClosed });

  const rounds = [];
  for (const label of ['海洋', '默认浅色', '日暮', '海洋']) {
    const r = await evl(`(async () => {
      const btn = document.querySelector('[aria-label="主题预设：${label}"]');
      if (!btn) return { error: 'no-button' };
      const rect = btn.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const hit = Boolean(top && (top === btn || btn.contains(top)));
      const t0 = performance.now();
      btn.click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t1 = performance.now();
      const root = document.documentElement;
      return { label: '${label}', ms: +(t1 - t0).toFixed(2), hit, theme: root.dataset.theme,
        accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
        bg: getComputedStyle(root).getPropertyValue('--app-bg').trim() };
    })()`);
    rounds.push(r);
  }
  const allFast = rounds.every((r) => !r.error && r.ms >= 0 && r.ms <= 200);
  const allHit = rounds.every((r) => r.hit === true);
  const allChanged = rounds.every((r) => r.theme && r.accent);
  say('T06317-08 AC-08 主题列表切换 ≤200ms（4 次真实可点击）', allFast && allHit, rounds);
  say('T06317-09 切换后主题变量与强调色实际生效', allChanged
    && new Set(rounds.map((r) => `${r.theme}|${r.accent}`)).size >= 3, rounds.map((r) => `${r.theme}|${r.accent}`));
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(EVID, '55-t06317-theme-switch-1440.png');
  writeFileSync(file, Buffer.from(screenshot.data, 'base64'));
  say('T06317-10 1440 主题切换证据截图', existsSync(file), { file });
  writeFileSync(join(OUT, 'build-result.json'), JSON.stringify({ assets: sizes, total, main, navPerf, rounds, checks }, null, 2), 'utf8');
} catch (e) {
  say('T06317-ERR 未捕获异常', false, String(e?.stack || e));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome?.pid) killTree(chrome.pid);
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`PASS=${pass} FAIL=${fail} OUT=${OUT}`);
  process.exit(fail ? 1 : 0);
}
