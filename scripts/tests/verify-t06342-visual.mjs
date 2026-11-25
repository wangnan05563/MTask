/**
 * T06342 浏览器验收：10 个核心页去掉重复面包屑/可见大标题，保留操作槽与隐藏 h1。
 *
 * 前置：隔离服务（默认 5212，静态目录为最新 web/dist）+ 已构建 web。
 * 覆盖：10 页 × 1440/1280/1024/760；可见标题/面包屑为 0、隐藏 h1 仍可访问、
 *       页头高度收敛、内容上移且不贴顶、操作槽保留、无横向溢出。
 *
 * 用法：node scripts/tests/verify-t06342-visual.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.T06342_OUT || 'docs/evidence/t06342-page-chrome';
const API = process.env.T06342_API || 'http://127.0.0.1:5212';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
try { rmSync(join(OUT, 'profile'), { recursive: true, force: true }); } catch { /* 忽略 */ }

const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1600)}`}`);
};
const saveResult = () => writeFileSync(join(OUT, 'visual-result.json'), JSON.stringify({
  pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks,
}, null, 2), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };
const json = async (r) => {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { __raw: text, __status: r.status }; }
};

const pages = [
  { tab: 'dashboard', title: '今日', label: '首页' },
  { tab: 'inbox', title: '收件箱', label: '收件箱' },
  { tab: 'tasks', title: '任务', label: '任务' },
  { tab: 'aitools', title: 'AI 工具与模型', label: '模型' },
  { tab: 'prompts', title: '提示词', label: '提示词' },
  { tab: 'req', title: '通用需求', label: '通用需求' },
  { tab: 'plan', title: '项目计划', label: '项目计划' },
  { tab: 'queue', title: '投递队列', label: '队列' },
  { tab: 'exec-sessions', title: '执行会话', label: '执行会话' },
  { tab: 'settings', title: '设置', label: '设置' },
];

let chrome = null;
let ws = null;
try {
  const health = await fetch(`${API}/api/health`).then(json).catch((e) => ({ error: String(e) }));
  say('T06342-00 测试 API 就绪', health?.ok === true, health);
  if (health?.ok !== true) throw new Error(`API 未就绪：${JSON.stringify(health)}`);

  const project = await fetch(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `T06342 页头验收 ${Date.now()}`, description: 'T06342 隔离验收' }),
  }).then(json);
  say('T06342-00b 测试项目就绪', Boolean(project?.id), { projectId: project?.id });
  if (!project?.id) throw new Error(`创建测试项目失败：${JSON.stringify(project)}`);

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,1000', '--disable-features=Translate', 'about:blank',
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
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(String(msg.params?.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 300));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    waits.set(id, (msg) => resolve(msg.error ? { __err: msg.error.message } : msg.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evl = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.__err) return { __err: r.__err };
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 500) };
    return { value: r.result?.value };
  };
  const until = async (expression, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = await evl(expression);
      if (r.value) return r.value;
      await sleep(150);
    }
    return null;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r?.data) return null;
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(OUT, name), buf);
    return { file: name, bytes: buf.length };
  };
  const dismiss = async () => {
    await evl(`(() => {
      const visible = (el) => !!(el && el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden');
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].filter((d) => visible(d));
      for (const d of dialogs) {
        const btn = [...d.querySelectorAll('button')].find((b) => visible(b) && /关闭|知道了|跳过|稍后|开始使用|完成|取消|×/.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
        if (btn) btn.click();
      }
      return dialogs.length;
    })()`);
    await sleep(250);
  };
  const readPage = async (expectedTitle) => (await evl(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const shell = document.querySelector('.mt-page-shell');
    const header = document.querySelector('header.mt-page-header');
    if (!shell || !header) return { error: 'missing shell/header' };
    const h1 = header.querySelector('h1');
    const minimal = header.classList.contains('mt-page-header--minimal');
    const title = (h1?.innerText || '').trim();
    const titleStyle = h1 ? getComputedStyle(h1) : null;
    const visibleH1 = [...document.querySelectorAll('h1')].filter(visible).map((el) => el.innerText.trim());
    const visibleBreadcrumbs = [...document.querySelectorAll('nav[aria-label="面包屑"]')].filter(visible).length;
    const visibleTitleClasses = [...document.querySelectorAll('.mt-page-title, .mt-page-description')].filter(visible).length;
    const headerRect = header.getBoundingClientRect();
    let firstContent = header.nextElementSibling;
    while (firstContent && firstContent.getBoundingClientRect().height < 2) firstContent = firstContent.nextElementSibling;
    const firstRect = firstContent?.getBoundingClientRect() ?? null;
    const actions = header.querySelectorAll('.mt-page-header-actions button, .mt-page-header-actions a, [data-page-primary-action] button, [data-page-primary-action] a');
    const visibleActions = [...actions].filter(visible).length;
    return {
      minimal, title,
      titleHidden: Boolean(titleStyle && titleStyle.position === 'absolute' && titleStyle.width === '1px' && titleStyle.height === '1px'),
      visibleH1, visibleBreadcrumbs, visibleTitleClasses,
      headerHeight: Math.round(headerRect.height * 10) / 10,
      headerBottom: Math.round(headerRect.bottom * 10) / 10,
      firstContentTop: firstRect ? Math.round(firstRect.top * 10) / 10 : null,
      firstContentGap: firstRect ? Math.round((firstRect.top - headerRect.bottom) * 10) / 10 : null,
      visibleActions,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewport: { w: innerWidth, h: innerHeight },
      hasAside: Boolean(document.querySelector('#root aside')),
      bodyText: document.body.innerText.slice(0, 160),
    };
  })()`)).value;
  const setTab = async (page) => {
    await evl(`(() => { location.hash = '#/project/${encodeURIComponent(project.id)}/${page.tab}'; return true; })()`);
    const ok = await until(`(() => {
      const h = document.querySelector('header.mt-page-header--minimal h1');
      return (h?.innerText || '').trim() === ${JSON.stringify(page.title)};
    })()`, 15_000);
    await sleep(450);
    await dismiss();
    return Boolean(ok);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${API}/index.html#/project/${encodeURIComponent(project.id)}/dashboard` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { try {
    localStorage.setItem('mtask.nav.collapsed', '0');
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(project.id)});
    ${JSON.stringify(pages.map((p) => p.tab)).replace(/^\[|\]$/g, '').split(',').map((t) => `localStorage.setItem('mtask.guide.seen.${t.replace(/"/g, '')}', '1');`).join('')}
  } catch {} return true; })()`);
  await sleep(600);

  const widths = [1440, 1280, 1024, 760];
  for (const width of widths) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width <= 760 ? 900 : 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    for (const page of pages) {
      const loaded = await setTab(page);
      const info = loaded ? await readPage(page.title) : null;
      say(`T06342-${width}-${page.tab} 页面加载`, loaded, info?.error ? info : undefined);
      if (!info || info.error) continue;
      say(`T06342-${width}-${page.tab} minimal 页头生效`, info.minimal, { title: info.title, headerHeight: info.headerHeight });
      say(`T06342-${width}-${page.tab} 无可见标题/面包屑`, info.visibleH1.length === 0 && info.visibleBreadcrumbs === 0 && info.visibleTitleClasses === 0, {
        visibleH1: info.visibleH1, visibleBreadcrumbs: info.visibleBreadcrumbs, visibleTitleClasses: info.visibleTitleClasses,
      });
      say(`T06342-${width}-${page.tab} 隐藏 h1 可访问`, info.titleHidden && info.title === page.title, {
        title: info.title, titleHidden: info.titleHidden,
      });
      say(`T06342-${width}-${page.tab} 页头收敛且内容不贴顶`, info.headerHeight >= 8 && info.headerHeight <= 64 && info.firstContentTop !== null && info.firstContentTop >= info.headerBottom && info.firstContentGap >= 0 && info.firstContentGap <= 24 && info.firstContentTop <= 180, {
        headerHeight: info.headerHeight, headerBottom: info.headerBottom, firstContentTop: info.firstContentTop, gap: info.firstContentGap,
      });
      say(`T06342-${width}-${page.tab} 无横向溢出`, info.scrollWidth <= width + 1, { scrollWidth: info.scrollWidth, width });
      if (['dashboard', 'inbox', 'queue'].includes(page.tab)) {
        say(`T06342-${width}-${page.tab} 操作槽保留`, info.visibleActions > 0, { visibleActions: info.visibleActions });
      }
      if (width === 1440 && ['dashboard', 'tasks', 'settings', 'queue'].includes(page.tab)) {
        const s = await shot(`00-${page.tab}-1440.png`);
        say(`T06342-1440-${page.tab} 截图有效`, Boolean(s?.bytes > 8000), s);
      }
      if (width === 760 && ['tasks', 'plan'].includes(page.tab)) {
        const s = await shot(`01-${page.tab}-760.png`);
        say(`T06342-760-${page.tab} 截图有效`, Boolean(s?.bytes > 8000), s);
      }
    }
  }

  say('T06342-99 全程无未捕获异常', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8) });
} catch (e) {
  say('T06342-ERR 验收异常', false, String(e?.stack || e).slice(0, 2500));
} finally {
  saveResult();
  if (ws) { try { ws.close(); } catch { /* 忽略 */ } }
  if (chrome?.pid) killTree(chrome.pid);
  const pass = checks.filter((x) => x.ok).length;
  const fail = checks.filter((x) => !x.ok).length;
  console.log(JSON.stringify({ pass, fail, out: OUT }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
}
