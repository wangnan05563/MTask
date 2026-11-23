/**
 * T06310 全站无障碍扫描：真实 Chrome + 生产 dist + 本地 API 代理。
 *
 * 关键路径：首页/任务/计划/需求/报表/队列/执行会话/提示词/模型/设置。
 * 每页跑 axe-core WCAG 2 A/AA，记录 serious/critical 违规、截图与 DOM 摘要；
 * 另测键盘 Tab 焦点环（outline 宽度/样式与相对背景对比度）。
 *
 * 用法：node scripts/tests/verify-t06310-a11y.mjs
 * 产出默认在 D:/tmp/t06310-a11y。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';

const ROOT = process.cwd();
const OUT = process.env.T06310_OUT || 'D:/tmp/t06310-a11y';
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06310_PORT || 39910);
const API_PORT = Number(process.env.MTASK_API_PORT || 39877);
const THEME = process.env.T06310_THEME || 'light';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const AXE = process.env.AXE_PATH || 'D:/tmp/t06309-axe/node_modules/axe-core/axe.min.js';
const TOKEN_FILE = join(process.env.APPDATA || '', 'mtask', 'data', 'tunnel', 'tunnel-config.json');

const TABS = [
  ['dashboard', '概览'], ['tasks', '任务'], ['plan', '计划'], ['req', '需求'], ['report', '报表'],
  ['queue', '队列'], ['exec-sessions', '执行会话'], ['prompts', '提示词'], ['aitools', '模型'], ['settings', '设置'],
];

if (!existsSync(join(DIST, 'index.html'))) { console.error(`dist 不存在，请先构建：${DIST}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
if (!existsSync(AXE)) { console.error(`axe-core 不存在：${AXE}`); process.exit(2); }
const axeSource = readFileSync(AXE, 'utf8');
let accessToken = '';
try { accessToken = String(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).accessToken || ''); } catch { /* 本机未配置令牌 */ }

mkdirSync(OUT, { recursive: true });
const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1200)}`}`);
};
const save = () => writeFileSync(join(OUT, 'a11y-result.json'), JSON.stringify({
  pass: checks.filter((x) => x.ok).length,
  fail: checks.filter((x) => !x.ok).length,
  checks,
}, null, 2), 'utf8');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const server = createServer((req, res) => {
  const raw = req.url || '/';
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
  say('A11Y-00 静态服务器与 API 代理就绪', true, { port: PORT, apiPort: API_PORT, token: Boolean(accessToken) });

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
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') consoleErrors.push(String(msg.params.args?.map((a) => a.value ?? a.description).join(' ')).slice(0, 300));
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
    if (r?.data) writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: axeSource });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  const appReady = await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  say('A11Y-01 应用生产构建加载成功', Boolean(appReady));
  await sleep(1500);

  if (THEME !== 'light') {
    await evl(`localStorage.setItem('settings.prefs', JSON.stringify({ theme: ${JSON.stringify(THEME)}, font: 'default', fontSize: 'm', accent: '', zen: false })); true`);
    await send('Page.reload');
    const themed = await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
    await sleep(1200);
    const applied = await evl(`document.documentElement.getAttribute('data-theme')`);
    say(`A11Y-01b ${THEME} 主题已应用`, Boolean(themed) && applied.value === THEME, { theme: applied.value });
  }

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
    await sleep(400);
  };

  const summary = [];
  for (const [tab, label] of TABS) {
    await dismiss();
    await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: ${JSON.stringify(tab)} } })); return true; })()`);
    await sleep(1800);
    await dismiss();
    await evl(`window.scrollTo(0, 0); true`);
    const pageInfo = await evl(`(() => ({
      hash: location.hash, title: document.title,
      activeNav: document.querySelector('.mt-nav-item[aria-current="page"]')?.innerText || document.querySelector('.mt-nav-subitem[aria-current="page"]')?.innerText || '',
      textLen: (document.querySelector('#root')?.innerText || '').length,
      bodyText: (document.querySelector('#root')?.innerText || '').slice(0, 160)
    }))()`);
    const axeResult = await evl(`(async () => {
      const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
      return r.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 180), failureSummary: (n.failureSummary || '').slice(0, 180) }))
      }));
    })()`);
    if (axeResult.__err) {
      say(`A11Y-${tab} 扫描执行失败`, false, { error: axeResult.__err, page: pageInfo.value });
      summary.push({ tab, label, error: axeResult.__err });
      continue;
    }
    const violations = axeResult.value || [];
    const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    const moderate = violations.filter((v) => v.impact === 'moderate' || v.impact === 'minor');
    say(`A11Y-${tab} axe WCAG2A/AA 无 serious/critical`, serious.length === 0, {
      serious: serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target) })),
      moderateMinor: moderate.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
      page: pageInfo.value,
    });
    summary.push({ tab, label, serious, moderate, page: pageInfo.value, consoleErrors: consoleErrors.slice(-6) });
    await shot(`page-${tab}.png`);
  }

  // 键盘焦点环：从 body 开始连按 Tab，找到第一个一级导航按钮并检查焦点样式与对比度。
  await dismiss();
  await evl(`document.body.focus(); true`);
  let focusProbe = null;
  for (let i = 0; i < 8; i += 1) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(160);
    const probe = await evl(`(() => {
      const el = document.activeElement;
      if (!el) return null;
      const s = getComputedStyle(el);
      const cls = String(el.className || '');
      const isNav = el.closest('.mt-primary-nav');
      let bg = s.backgroundColor;
      let p = el; 
      while (p && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) { p = p.parentElement; bg = p ? getComputedStyle(p).backgroundColor : 'rgb(255,255,255)'; }
      return {
        tag: el.tagName, text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 30), cls,
        isNav: Boolean(isNav), outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth) || 0,
        outlineColor: s.outlineColor, outlineOffset: s.outlineOffset, bg, boxShadow: s.boxShadow,
        active: true
      };
    })()`);
    if (probe.value?.isNav && probe.value?.outlineWidth > 0) { focusProbe = probe.value; break; }
  }
  say('A11Y-focus-01 键盘 Tab 能进入主导航', Boolean(focusProbe), focusProbe);
  if (focusProbe) {
    const ratio = await evl(`(() => {
      const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const a = m[1].split(',').map(Number); return [a[0], a[1], a[2], a[3] === undefined ? 1 : a[3]]; };
      const lum = (rgb) => { const f = rgb.slice(0,3).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.05) / 1.05, 2.4); }); return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2]; };
      const A = parse(${JSON.stringify(focusProbe.outlineColor)}), B = parse(${JSON.stringify(focusProbe.bg)});
      if (!A || !B) return null;
      const l1 = lum(A), l2 = lum(B);
      return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
    })()`);
    say('A11Y-focus-02 主导航焦点环 >=2px 且对比度 >=3:1', focusProbe.outlineWidth >= 2 && focusProbe.outlineStyle !== 'none' && (ratio.value ?? 0) >= 3, { ratio: ratio.value, outline: `${focusProbe.outlineWidth}px ${focusProbe.outlineStyle} ${focusProbe.outlineColor}` });
  }

  const totalSerious = summary.reduce((n, p) => n + (p.serious?.length || 0), 0);
  say('A11Y-summary 全站 10 个关键路径 serious/critical 合计', totalSerious === 0, { pages: summary.length, serious: totalSerious, errors: summary.filter((p) => p.error).length });
  writeFileSync(join(OUT, 'a11y-pages.json'), JSON.stringify(summary, null, 2), 'utf8');
} catch (e) {
  say('A11Y-FATAL 测试异常', false, String(e?.stack || e).slice(0, 800));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  save();
  console.log(`\n[t06310-a11y] pass=${checks.filter((x) => x.ok).length} fail=${checks.filter((x) => !x.ok).length} out=${OUT}`);
  process.exit(checks.some((x) => !x.ok) ? 1 : 0);
}
