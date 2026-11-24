/**
 * T06292 视觉降噪走查 —— 核心 10 页可复核指标与 light 主题快照。
 *
 * 审计口径（只读，不改任何布局/业务代码）：
 * 1. 页头是否使用统一 PageShell/PageHeader，是否声明唯一 primaryAction；
 * 2. 首屏可见的主色实底按钮（--accent / --success），作为「主操作竞争」客观信号；
 * 3. 徽标/标签类元素数量（圆角 + 短文本启发式，排除 button/a/input），以及单行/单卡最大数量；
 * 4. 可见标题层级 h1-h6 分布、可见 SVG 尺寸档位；
 * 5. 逐页 light 主题截图 + 指标 JSON/CSV。
 *
 * 用法：node scripts/tests/audit-t06292-noise.mjs
 * 产出默认：D:/tmp/t06292-audit
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const OUT = process.env.T06292_OUT || 'D:/tmp/t06292-audit';
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.T06292_PORT || 39913);
const CDP_PORT = Number(process.env.T06292_CDP_PORT || 9333);
const API_PORT = Number(process.env.MTASK_API_PORT || 39877);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TOKEN_FILE = join(process.env.APPDATA || '', 'mtask', 'data', 'tunnel', 'tunnel-config.json');
const AUDIT_PROJECT = process.env.T06292_PROJECT || '586ae8c6-2e08-4180-86ba-732f1fab5006';
const RUN_ID = Date.now().toString(36);
const TABS = [
  ['dashboard', '概览', 'web/src/pages/DashboardPage.tsx'],
  ['tasks', '任务', 'web/src/pages/TasksPage.tsx'],
  ['plan', '计划', 'web/src/pages/PlanPage.tsx'],
  ['req', '需求', 'web/src/pages/ReqPage.tsx'],
  ['report', '报表', 'web/src/pages/ReportPage.tsx'],
  ['queue', '队列', 'web/src/pages/QueuePage.tsx'],
  ['exec-sessions', '执行会话', 'web/src/pages/ExecSessionsPage.tsx'],
  ['prompts', '提示词', 'web/src/pages/PromptsPage.tsx'],
  ['aitools', '模型', 'web/src/pages/AIToolsPage.tsx'],
  ['settings', '设置', 'web/src/pages/SettingsPage.tsx'],
];

if (!existsSync(join(DIST, 'index.html'))) { console.error(`dist 不存在，请先构建：${DIST}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
let accessToken = '';
try { accessToken = String(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).accessToken || ''); } catch { /* 未配置令牌 */ }

mkdirSync(OUT, { recursive: true });
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
    }, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
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
const pngSize = (buf) => {
  if (buf.length < 24 || buf.subarray(1, 4).toString() !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** 静态扫描：每个核心页文件中的显式图标 size 字面量与标题层级。 */
function staticScan() {
  const rows = [];
  for (const [tab, label, file] of TABS) {
    const abs = join(ROOT, file);
    if (!existsSync(abs)) { rows.push({ tab, label, file, missing: true }); continue; }
    const src = readFileSync(abs, 'utf8');
    const sizes = {};
    for (const m of src.matchAll(/\bsize=\{(\d+)\}/g)) sizes[m[1]] = (sizes[m[1]] || 0) + 1;
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    const h = {};
    for (const m of src.matchAll(/<h([1-6])\b/g)) h[`h${m[1]}`] = (h[`h${m[1]}`] || 0) + 1;
    rows.push({
      tab, label, file, iconLiterals: total, iconSizes: sizes,
      iconAllowed: (sizes['16'] || 0) + (sizes['20'] || 0), iconDisallowed: total - (sizes['16'] || 0) - (sizes['20'] || 0),
      headings: h, h4plus: Object.entries(h).filter(([k]) => Number(k.slice(1)) >= 4).reduce((a, [, v]) => a + v, 0),
      usesPageShell: /PageShell/.test(src), usesPageHeader: /PageHeader/.test(src), declaresPrimaryAction: /\bprimaryAction=/.test(src),
      accentOrSuccessFills: (src.match(/BTN_PRIMARY|background: 'var\(--accent\)'|background: 'var\(--success\)'/g) || []).length,
    });
  }
  return rows;
}

const staticRows = staticScan();
const staticCsv = ['tab,label,usesPageShell,usesPageHeader,declaresPrimaryAction,iconLiterals,iconAllowed16or20,iconDisallowed,iconSizes,h4plus,accentOrSuccessFills,file'];
for (const s of staticRows) {
  staticCsv.push([s.tab, s.label, s.usesPageShell, s.usesPageHeader, s.declaresPrimaryAction, s.iconLiterals, s.iconAllowed, s.iconDisallowed,
    JSON.stringify(s.iconSizes || {}), s.h4plus, s.accentOrSuccessFills, s.file]
    .map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
}
writeFileSync(join(OUT, 'audit-static.csv'), `${staticCsv.join('\n')}\n`, 'utf8');
writeFileSync(join(OUT, 'audit-static.json'), JSON.stringify({ generatedAt: new Date().toISOString(), project: AUDIT_PROJECT, static: staticRows }, null, 2), 'utf8');
if (process.env.T06292_STATIC_ONLY === '1') {
  console.log(`[STATIC-ONLY] ${join(OUT, 'audit-static.csv')}`);
  process.exit(0);
}

let chrome = null;
let ws = null;
const result = { generatedAt: new Date().toISOString(), project: AUDIT_PROJECT, tabs: [], static: staticRows };

try {
  await new Promise((resolve, reject) => server.listen(PORT, '127.0.0.1', resolve).once('error', reject));
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(OUT, `profile-${RUN_ID}`)}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1280,900', '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeTail = '';
  chrome.stderr.on('data', (d) => { chromeTail = (chromeTail + String(d)).slice(-400); });
  chrome.stdout.on('data', (d) => { chromeTail = (chromeTail + String(d)).slice(-400); });
  let targets = null;
  for (let i = 0; i < 40 && !targets; i += 1) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) targets = await res.json();
    } catch { /* 尚未就绪 */ }
  }
  if (!targets) throw new Error(`Chrome 20s 内未开放调试端口 ${CDP_PORT}：${chromeTail}`);
  const target = targets.find((x) => x.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  let seq = 0;
  const waits = new Map();
  const runtimeErrors = [];
  ws.onmessage = (message) => {
    const msg = JSON.parse(String(message.data));
    if (msg.id !== undefined && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') runtimeErrors.push(String(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '').slice(0, 300));
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
    await sleep(300);
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r?.data) return null;
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(OUT, name), buf);
    return { bytes: buf.length, sha: sha(buf), size: pngSize(buf) };
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  const appReady = await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  console.log(`[INFO] 生产构建加载 ${appReady ? 'OK' : 'FAIL'}`);
  await evl(`(() => {
    const prefs = ${JSON.stringify({ theme: 'light', font: 'default', fontSize: 'm', accent: '', zen: false })};
    localStorage.setItem('settings.prefs', JSON.stringify(prefs));
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(AUDIT_PROJECT)});
    return true;
  })()`);
  await send('Page.reload');
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await sleep(1200);

  for (const [tab, label] of TABS) {
    await dismiss();
    await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: ${JSON.stringify(tab)} } })); return true; })()`);
    const loaded = await until(`(() => {
      const root = document.querySelector('#root');
      if (!root) return false;
      const text = root.innerText || '';
      return document.querySelectorAll('.mt-skeleton').length === 0 && !/加载中|正在加载/.test(text);
    })()`, 25_000);
    if (!loaded) await sleep(1500);
    await dismiss();
    await evl(`window.scrollTo(0, 0); true`);
    await sleep(300);

    const metrics = await evl(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0;
      };
      const root = document.querySelector('#root');
      const host = document.querySelector('.mt-page-host') || document.querySelector('#root main') || root;
      const shell = document.querySelector('.mt-page-shell');
      const header = document.querySelector('.mt-page-header');
      const declaredPrimary = document.querySelector('[data-page-primary-action="true"]');
      const cssColor = (name) => {
        const tmp = document.createElement('div');
        tmp.style.background = 'var(' + name + ')';
        document.body.appendChild(tmp);
        const c = getComputedStyle(tmp).backgroundColor;
        tmp.remove();
        return c;
      };
      const accent = cssColor('--accent');
      const success = cssColor('--success');
      const norm = (c) => c.replace(/\\s+/g, '').toLowerCase();
      const labelled = (el) => (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
        || (el.getAttribute('aria-label') || '').trim().slice(0, 40)
        || (el.getAttribute('title') || '').trim().slice(0, 40)
        || '(无文本)';
      const buttons = [...host.querySelectorAll('button')].filter(visible);
      const colored = [];
      for (const b of buttons) {
        const s = getComputedStyle(b);
        const bg = norm(s.backgroundColor);
        if ((bg === norm(accent) || bg === norm(success)) && !b.disabled) {
          const inSwitch = Boolean(b.closest('.mt-page-view-switch'));
          colored.push({ label: labelled(b), bg, inViewSwitch: inSwitch, type: b.getAttribute('type') || 'submit' });
        }
      }
      const primaryColored = colored.filter((x) => !x.inViewSwitch);
      const pageHeaderActions = header ? [...header.querySelectorAll('button')].filter(visible).map((b) => labelled(b)) : [];

      const pillLike = (el) => {
        if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG', 'PATH'].includes(el.tagName)) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const txt = (el.innerText || '').trim();
        const br = parseFloat(s.borderTopLeftRadius) || 0;
        const bg = s.backgroundColor;
        const bw = parseFloat(s.borderTopWidth) || 0;
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && txt.length > 0 && txt.length <= 28
          && br >= 8 && (bg !== 'rgba(0, 0, 0, 0)' || bw > 0) && r.height <= 32;
      };
      const pills = [...host.querySelectorAll('span,small,em,strong,div')].filter((el) => visible(el) && pillLike(el));
      const rowSel = 'tbody tr, [data-lck="exec-session-card"], [data-task-id], [data-prompt-id], .mt-prompt-row, .mt-task-row, .mt-plan-row';
      const rows = [...host.querySelectorAll(rowSel)].filter(visible).map((r) => ({
        tag: r.tagName.toLowerCase(),
        key: (r.getAttribute('data-lck') || r.getAttribute('data-task-id') || r.getAttribute('data-prompt-id') || '').slice(0, 24),
        sample: (r.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 70),
        badges: [...r.querySelectorAll('span,small,em,strong')].filter((el) => visible(el) && pillLike(el)).length,
      }));
      const maxBadges = rows.reduce((m, r) => Math.max(m, r.badges), 0);
      const over2 = rows.filter((r) => r.badges > 2).sort((a, b) => b.badges - a.badges).slice(0, 6);

      const headings = {};
      for (const h of [...host.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible)) headings[h.tagName.toLowerCase()] = (headings[h.tagName.toLowerCase()] || 0) + 1;
      const iconSizes = {};
      for (const svg of [...host.querySelectorAll('svg')].filter(visible)) {
        const r = svg.getBoundingClientRect();
        const key = Math.round(r.width) + 'x' + Math.round(r.height);
        iconSizes[key] = (iconSizes[key] || 0) + 1;
      }
      const pageTitle = (document.querySelector('.mt-page-title')?.innerText || host.querySelector('h1')?.innerText || host.querySelector('h2')?.innerText || '').trim().slice(0, 40);
      return {
        pageTitle,
        shell: Boolean(shell),
        pageHeader: Boolean(header),
        declaredPrimary: Boolean(declaredPrimary),
        headerActions: pageHeaderActions,
        buttons: buttons.length,
        coloredPrimary: primaryColored,
        coloredPrimaryCount: primaryColored.length,
        coloredAll: colored,
        badges: pills.length,
        rowCount: rows.length,
        maxBadgesPerRow: maxBadges,
        over2Rows: over2,
        headings,
        h4plusCount: Object.entries(headings).filter(([k]) => Number(k.slice(1)) >= 4).reduce((a, [, v]) => a + v, 0),
        iconSizes,
        hostTextLength: (host.innerText || '').length,
      };
    })()`);

    const file = `audit-light-${tab}.png`;
    const info = await shot(file);
    const val = metrics.value || { error: metrics.__err };
    result.tabs.push({ tab, label, file, loaded: Boolean(loaded), ...info, ...val });
    console.log(`[INFO] ${label} shell=${val.shell} header=${val.pageHeader} primary=${val.declaredPrimary} colored=${val.coloredPrimaryCount} badges=${val.badges} maxPerRow=${val.maxBadgesPerRow} h4+=${val.h4plusCount} file=${file}`);
  }

  writeFileSync(join(OUT, 'audit-metrics.json'), JSON.stringify({ ...result, runtimeErrors }, null, 2), 'utf8');
  const csvRows = ['tab,label,pageHeader,declaredPrimary,coloredPrimaryCount,coloredPrimaryLabels,badges,maxBadgesPerRow,h4plus,iconSizeVariants,iconVisibleTotal,screenshot'];
  for (const t of result.tabs) {
    csvRows.push([
      t.tab, t.label, t.pageHeader, t.declaredPrimary, t.coloredPrimaryCount,
      JSON.stringify((t.coloredPrimary || []).map((x) => x.label).join(' | ')),
      t.badges, t.maxBadgesPerRow, t.h4plusCount, JSON.stringify(Object.keys(t.iconSizes || {}).join(' | ')),
      Object.values(t.iconSizes || {}).reduce((a, b) => a + b, 0), t.file,
    ].map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
  }
  writeFileSync(join(OUT, 'audit-metrics.csv'), `${csvRows.join('\n')}\n`, 'utf8');
  console.log(`[DONE] ${join(OUT, 'audit-metrics.json')}`);
} catch (e) {
  console.error(`[FAIL] ${e?.stack || e}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome?.pid) killTree(chrome.pid);
  await new Promise((resolve) => server.close(resolve));
}
