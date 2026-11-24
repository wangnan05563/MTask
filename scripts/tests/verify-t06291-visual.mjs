/**
 * T06291 组件视觉回归 + 三主题对比度门禁。
 *
 * 覆盖：
 * 1. 核心 10 页 × light/dark/high-contrast 截图矩阵（30 张）；
 * 2. Design System 画廊 × 3 主题截图（3 张）+ axe color-contrast 门禁；
 * 3. 主题生效断言（body 背景色三主题互异）；
 * 4. 截图尺寸/非空校验与 matrix.html 汇总页。
 *
 * 用法：node scripts/tests/verify-t06291-visual.mjs
 * 产出默认：D:/tmp/t06291-visual
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const OUT = process.env.T06291_OUT || 'D:/tmp/t06291-visual';
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06291_PORT || 39912);
const API_PORT = Number(process.env.MTASK_API_PORT || 39877);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const AXE = process.env.AXE_PATH || 'D:/tmp/t06309-axe/node_modules/axe-core/axe.min.js';
const TOKEN_FILE = join(process.env.APPDATA || '', 'mtask', 'data', 'tunnel', 'tunnel-config.json');
const THEMES = ['light', 'dark', 'high-contrast'];
const TABS = [
  ['dashboard', '概览'], ['tasks', '任务'], ['plan', '计划'], ['req', '需求'], ['report', '报表'],
  ['queue', '队列'], ['exec-sessions', '执行会话'], ['prompts', '提示词'], ['aitools', '模型'], ['settings', '设置'],
];

if (!existsSync(join(DIST, 'index.html'))) { console.error(`dist 不存在，请先构建：${DIST}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
if (!existsSync(AXE)) { console.error(`axe-core 不存在：${AXE}`); process.exit(2); }
const axeSource = readFileSync(AXE, 'utf8');
let accessToken = '';
try { accessToken = String(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).accessToken || ''); } catch { /* 未配置令牌 */ }

mkdirSync(OUT, { recursive: true });
const galleryBody = join(OUT, 'gallery-body.html');
execFileSync('node', ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'web/tsconfig.json', 'scripts/tests/t06291-gallery.tsx', galleryBody], { cwd: ROOT, stdio: 'inherit' });
const tokensCss = readFileSync(join(ROOT, 'web/src/theme/tokens.css'), 'utf8');
const componentsCss = readFileSync(join(ROOT, 'web/src/ui/components.css'), 'utf8');
const galleryPage = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8" />
<title>T06291 组件画廊</title><style>
${tokensCss}
${componentsCss}
html,body{margin:0;padding:0;background:var(--mt-semantic-bg-canvas);color:var(--mt-semantic-text-primary);font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.t06291-gallery{max-width:1180px;margin:0 auto;padding:24px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.t06291-gallery__head{grid-column:1/-1;padding-bottom:12px;border-bottom:1px solid var(--mt-semantic-border-default)}
.t06291-gallery__head h1{font-size:22px;margin:0 0 6px}
.t06291-gallery__head p{font-size:13px;color:var(--mt-semantic-text-secondary);margin:0}
.t06291-gallery__section{padding:16px;border:1px solid var(--mt-semantic-border-default);border-radius:10px;background:var(--mt-semantic-bg-surface)}
.t06291-gallery__section h2{font-size:14px;margin:0 0 12px;color:var(--mt-semantic-text-secondary)}
.t06291-gallery__row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.t06291-gallery__grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.t06291-gallery__body{font-size:13px;line-height:1.7;margin:0;color:var(--mt-semantic-text-secondary)}
.t06291-gallery__skeleton{display:flex;flex-direction:column;gap:8px;margin-top:16px}
</style></head><body>${readFileSync(galleryBody, 'utf8')}</body></html>`;

const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1200)}`}`);
};
const save = () => writeFileSync(join(OUT, 'visual-result.json'), JSON.stringify({
  pass: checks.filter((x) => x.ok).length,
  fail: checks.filter((x) => !x.ok).length,
  checks,
}, null, 2), 'utf8');
const pngSize = (buf) => {
  if (buf.length < 24 || buf.subarray(1, 4).toString() !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const server = createServer((req, res) => {
  const raw = req.url || '/';
  if (raw === '/__gallery' || raw.startsWith('/__gallery?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(galleryPage);
    return;
  }
  if (raw.startsWith('/api/')) {
    const upstream = httpRequest({
      host: '127.0.0.1', port: API_PORT, path: raw, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${API_PORT}`, ...(accessToken ? { 'X-Access-Token': accessToken } : {}) },
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message) })); });
    req.pipe(upstream);
    return;
  }
  const pathname = decodeURIComponent(raw.split('?')[0]);
  let file = join(DIST, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!existsSync(file) || pathname.endsWith('/')) file = join(DIST, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': `${MIME[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };
let chrome = null;
let ws = null;

try {
  await new Promise((resolve, reject) => server.listen(PORT, '127.0.0.1', resolve).once('error', reject));
  say('VIS-00 静态服务器 / API 代理 / 画廊页面就绪', true, { port: PORT, apiPort: API_PORT, token: Boolean(accessToken) });

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1280,900', '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cdpPort = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 30s 内未报出调试端口')), 30_000);
    const on = (d) => {
      buf += String(d);
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    chrome.stderr.on('data', on); chrome.stdout.on('data', on);
    chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome 提前退出 code=${code} ${buf.slice(-300)}`)); });
  });

  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = targets.find((x) => x.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  let seq = 0;
  const waits = new Map();
  const consoleErrors = [];
  ws.onmessage = (message) => {
    const msg = JSON.parse(String(message.data));
    if (msg.id !== undefined && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '').slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    waits.set(id, (msg) => resolve(msg.error ? { __err: msg.error.message } : msg.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evl = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.__err) return { __err: r.__err };
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400) };
    return { value: r.result?.value };
  };
  const until = async (expression, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = await evl(expression);
      if (r.value) return r.value;
      await sleep(250);
    }
    return null;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r?.data) return null;
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(OUT, name), buf);
    return { bytes: buf.length, sha: sha(buf), size: pngSize(buf) };
  };
  const dismiss = async () => {
    await evl(`(() => {
      const visible = (el) => !!(el && el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden');
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].filter(visible);
      for (const d of dialogs) {
        const btn = [...d.querySelectorAll('button')].find((b) => visible(b) && /关闭|知道了|跳过|稍后|开始使用|完成|取消|×/.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
        if (btn) btn.click();
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return dialogs.length;
    })()`);
    await sleep(350);
  };
  const axeContrast = async () => {
    const r = await evl(`(async () => {
      const res = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] } });
      return res.violations.map((v) => ({
        id: v.id, impact: v.impact,
        nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 160), failureSummary: (n.failureSummary || '').slice(0, 160) }))
      }));
    })()`);
    if (r.__err) return { error: r.__err, violations: [] };
    return { violations: r.value || [] };
  };
  const setTheme = async (theme) => {
    if (theme === 'high-contrast') {
      await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
      await sleep(1000);
      await evl(`document.documentElement.setAttribute('data-theme', 'high-contrast'); true`);
      await sleep(250);
      return (await evl(`document.documentElement.getAttribute('data-theme')`)).value;
    }
    const prefs = { theme, font: 'default', fontSize: 'm', accent: '', zen: false };
    await evl(`localStorage.setItem('settings.prefs', ${JSON.stringify(JSON.stringify(prefs))}); true`);
    await send('Page.reload');
    await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
    await sleep(1000);
    return (await evl(`document.documentElement.getAttribute('data-theme')`)).value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: axeSource });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  const appReady = await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  say('VIS-01 生产构建加载成功', Boolean(appReady));

  const matrix = [];
  for (const theme of THEMES) {
    const applied = await setTheme(theme);
    const bodyBg = await evl(`getComputedStyle(document.body).backgroundColor`);
    const expectedBg = { light: 'rgb(255, 255, 255)', dark: 'rgb(24, 24, 27)', 'high-contrast': 'rgb(0, 0, 0)' }[theme];
    say(`VIS-theme-${theme} 主题应用`, applied === theme && bodyBg.value === expectedBg, { applied, bodyBg: bodyBg.value, expectedBg });

    for (const [tab, label] of TABS) {
      await dismiss();
      if (theme === 'high-contrast') await evl(`document.documentElement.setAttribute('data-theme', 'high-contrast'); true`);
      await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: ${JSON.stringify(tab)} } })); return true; })()`);
      const loaded = await until(`(() => {
        const root = document.querySelector('#root');
        if (!root) return false;
        const text = root.innerText || '';
        return document.querySelectorAll('.mt-skeleton').length === 0 && !/加载中|正在加载/.test(text);
      })()`, 20_000);
      if (!loaded) await sleep(1500);
      await dismiss();
      if (theme === 'high-contrast') await evl(`document.documentElement.setAttribute('data-theme', 'high-contrast'); true`);
      await evl(`window.scrollTo(0, 0); true`);
      const pageInfo = await evl(`(() => ({
        activeNav: document.querySelector('.mt-nav-item[aria-current="page"], .mt-nav-subitem[aria-current="page"]')?.innerText || '',
        textLen: (document.querySelector('#root')?.innerText || '').length,
        skeletons: document.querySelectorAll('.mt-skeleton').length,
        loadingText: /加载中|正在加载/.test(document.querySelector('#root')?.innerText || ''),
        loaded: ${Boolean(loaded)},
        theme: document.documentElement.getAttribute('data-theme'),
      }))()`);
      const file = `matrix-${theme}-${tab}.png`;
      const info = await shot(file);
      const nonBlank = Boolean(info && info.bytes > 8000 && info.size && info.size.width >= 1200 && info.size.height >= 700);
      say(`VIS-matrix-${theme}-${tab} 截图与页面有效`, nonBlank && Boolean(pageInfo.value?.loaded) && (pageInfo.value?.textLen || 0) > 60, {
        file, bytes: info?.bytes, size: info?.size, sha: info?.sha, ...pageInfo.value,
      });
      matrix.push({ theme, tab, label, file, ...info, ...pageInfo.value, nonBlank });
      const contrast = await axeContrast();
      const count = contrast.violations.length;
      say(`VIS-contrast-${theme}-${tab} 无 color-contrast 违规`, !contrast.error && count === 0, {
        count, ids: contrast.violations.map((v) => ({ id: v.id, nodes: v.nodes.length, first: v.nodes[0]?.target })).slice(0, 3),
      });
    }
  }

  for (const theme of THEMES) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/__gallery` });
    const ready = await until(`Boolean(document.querySelector('[data-testid="t06291-gallery"]'))`, 20_000);
    if (!ready) { say(`VIS-gallery-${theme} 画廊加载`, false); continue; }
    await evl(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
    await sleep(500);
    const bg = await evl(`getComputedStyle(document.body).backgroundColor`);
    const sections = await evl(`document.querySelectorAll('[data-gallery-section]').length`);
    const info = await shot(`gallery-${theme}.png`);
    say(`VIS-gallery-${theme} 六类组件可见且截图有效`, sections.value === 6 && Boolean(info && info.bytes > 8000), {
      sections: sections.value, bytes: info?.bytes, size: info?.size, theme: (await evl(`document.documentElement.getAttribute('data-theme')`)).value, bodyBg: bg.value,
    });
    const contrast = await axeContrast();
    say(`VIS-gallery-${theme} 三主题对比度门禁`, !contrast.error && contrast.violations.length === 0, {
      error: contrast.error, count: contrast.violations.length,
      nodes: contrast.violations.reduce((n, v) => n + v.nodes.length, 0),
      first: contrast.violations.slice(0, 3).map((v) => ({ id: v.id, nodes: v.nodes.length, target: v.nodes[0]?.target, html: v.nodes[0]?.html })),
    });
  }

  const themeBgs = await evl(`['light','dark','high-contrast'].map((t) => { document.documentElement.setAttribute('data-theme', t); return [t, getComputedStyle(document.body).backgroundColor]; })`);
  const bgSet = new Set((themeBgs.value || []).map((x) => x[1]));
  say('VIS-theme-03 三主题画布背景互异', bgSet.size === 3, { values: themeBgs.value });

  const galleryImgs = THEMES.map((t) => `gallery-${t}.png`).filter((f) => existsSync(join(OUT, f)));
  const appImgs = matrix.filter((m) => m.file && existsSync(join(OUT, m.file)));
  say('VIS-matrix-01 截图矩阵数量', appImgs.length === 30 && galleryImgs.length === 3, { app: appImgs.length, gallery: galleryImgs.length });

  const rows = matrix.map((m) => `<figure><img src="${m.file}" alt="${m.theme}-${m.label}" /><figcaption>${m.theme} · ${m.label}</figcaption></figure>`).join('\n');
  writeFileSync(join(OUT, 'matrix.html'), `<!doctype html><html><head><meta charset="utf-8"><title>T06291 截图矩阵</title><style>body{font-family:sans-serif;background:#111;color:#eee;padding:16px}figure{display:inline-block;width:31%;margin:0 1% 16px;vertical-align:top}img{width:100%;border:1px solid #555}figcaption{font-size:12px;padding:4px 0}</style></head><body><h1>核心页 × 三主题截图矩阵</h1>${rows}</body></html>`, 'utf8');
  writeFileSync(join(OUT, 'matrix.json'), JSON.stringify(matrix, null, 2), 'utf8');
} catch (e) {
  say('VIS-FATAL 测试异常', false, String(e?.stack || e).slice(0, 800));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  save();
  console.log(`\n[t06291-visual] pass=${checks.filter((x) => x.ok).length} fail=${checks.filter((x) => !x.ok).length} out=${OUT}`);
  process.exit(checks.some((x) => !x.ok) ? 1 : 0);
}
