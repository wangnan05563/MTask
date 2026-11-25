/**
 * T06343 浏览器验收：任务工具条低频项收进「更多」，模板前置，搜索框收缩，首排不换行。
 *
 * 前置：隔离服务（默认 5212，静态目录为最新 web/dist）+ 已构建 web。
 * 覆盖：1440/1280 首排几何、More 展开/收起、8 类低频入口归属、模板先于添加任务、760 无横向溢出。
 *
 * 用法：node scripts/tests/verify-t06343-visual.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.T06343_OUT || 'docs/evidence/t06343-toolbar';
const API = process.env.T06343_API || 'http://127.0.0.1:5212';
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

let chrome = null;
let ws = null;
try {
  const health = await fetch(`${API}/api/health`).then(json).catch((e) => ({ error: String(e) }));
  say('T06343-00 测试 API 就绪', health?.ok === true, health);
  if (health?.ok !== true) throw new Error(`API 未就绪：${JSON.stringify(health)}`);

  const project = await fetch(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `T06343 工具条验收 ${Date.now()}`, description: 'T06343 隔离验收' }),
  }).then(json);
  say('T06343-00b 测试项目就绪', Boolean(project?.id), { projectId: project?.id });
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
  const readLayout = async () => (await evl(`(() => {
    const trigger = document.querySelector('[data-t03623="more-trigger"]');
    const panel = document.querySelector('[data-t06343="more-panel"]');
    const search = document.querySelector('[data-page-search]');
    const root = trigger?.parentElement;
    if (!trigger || !panel || !search || !root) return { error: 'missing trigger/panel/search/root' };
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const low = {
      savedView: document.querySelector('[data-t06303="saved-view-menu"]'),
      saveView: document.querySelector('[aria-label="保存当前视图"]'),
      copyView: document.querySelector('[aria-label="复制当前视图"]'),
      deleteView: document.querySelector('[aria-label="删除当前视图"]'),
      wsAsk: document.querySelector('[data-t03250="ask-entry"]'),
      beautify: document.querySelector('[data-t06343="beautify"]'),
      density: document.querySelector('[data-t06322="density"]'),
      git: document.querySelector('[data-t03343="git-toggle"]'),
      projectActions: document.querySelector('[data-t06343="project-actions"]'),
      exportSelect: document.querySelector('[data-t03267="project-export"]'),
    };
    const lowState = Object.fromEntries(Object.entries(low).map(([k, el]) => [k, {
      exists: Boolean(el), inPanel: Boolean(el && panel.contains(el)), visible: visible(el),
    }]));
    const direct = [...root.children].filter((el) => visible(el) && el !== panel);
    const rawTops = [...new Set(direct.map((el) => Math.round(el.getBoundingClientRect().top)))].sort((a, b) => a - b);
    const rows = [];
    for (const top of rawTops) {
      if (rows.length === 0 || top - rows[rows.length - 1] > 8) rows.push(top);
    }
    const searchRect = search.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const template = document.querySelector('[data-t06305="template-menu"]');
    const addBtn = document.querySelector('button[aria-label^="添加任务"]');
    const templateFirst = Boolean(template && addBtn && (template.compareDocumentPosition(addBtn) & Node.DOCUMENT_POSITION_FOLLOWING));
    return {
      triggerVisible: visible(trigger),
      expanded: trigger.getAttribute('aria-expanded'),
      panelDisplay: getComputedStyle(panel).display,
      panelVisible: visible(panel),
      panelWidth: Math.round(panelRect.width),
      panelRight: Math.round(panelRect.right),
      rows,
      directCount: direct.length,
      searchWidth: Math.round(searchRect.width),
      searchVisible: visible(search),
      lowState,
      templateVisible: visible(template),
      addVisible: visible(addBtn),
      templateFirst,
      templateTop: template ? Math.round(template.getBoundingClientRect().top) : null,
      addTop: addBtn ? Math.round(addBtn.getBoundingClientRect().top) : null,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewport: { w: innerWidth, h: innerHeight },
    };
  })()`)).value;
  const clickMore = async () => {
    await evl(`document.querySelector('[data-t03623="more-trigger"]')?.click(); true`);
    await sleep(450);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${API}/index.html#/project/${encodeURIComponent(project.id)}/tasks` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { try {
    localStorage.setItem('mtask.nav.collapsed', '0');
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(project.id)});
    localStorage.setItem('mtask.guide.seen.tasks', '1');
  } catch {} return true; })()`);
  await send('Page.navigate', { url: `${API}/index.html#/project/${encodeURIComponent(project.id)}/tasks` });
  await until(`Boolean(document.querySelector('[data-t03623="more-trigger"]'))`, 25_000);
  // 直接深链不一定能把新项目置为当前；通过项目切换器显式选中，确保 workspace/视图/模板均处于具体项目上下文
  await evl(`document.querySelector('[aria-label="切换项目"]')?.click(); true`);
  await sleep(350);
  const selected = await evl(`(() => {
    const btn = [...document.querySelectorAll('button[aria-label^="切换到项目 "]')]
      .find((b) => b.getAttribute('aria-label') === ${JSON.stringify(`切换到项目 ${project.name}`)});
    if (!btn) return { clicked: false, labels: [...document.querySelectorAll('button[aria-label^="切换到项目 "]')].map((b) => b.getAttribute('aria-label')).slice(0, 8) };
    btn.click();
    return { clicked: true };
  })()`);
  say('T06343-00c 已切到具体测试项目', Boolean(selected.value?.clicked), selected.value);
  await sleep(700);
  await dismiss();
  await sleep(500);

  const closed1440 = await readLayout();
  const lowNames = ['savedView', 'saveView', 'copyView', 'deleteView', 'wsAsk', 'beautify', 'density', 'git'];
  say('T06343-01 1440 工具条主排单行', Boolean(closed1440 && closed1440.rows?.length === 1), closed1440?.rows);
  say('T06343-02 1440 低频项全部在 More 且默认不可见', Boolean(closed1440 && lowNames.every((k) => closed1440.lowState?.[k]?.exists && closed1440.lowState?.[k]?.inPanel && !closed1440.lowState?.[k]?.visible)), closed1440?.lowState);
  say('T06343-03 More 默认收起且不渲染占位', Boolean(closed1440 && closed1440.expanded === 'false' && closed1440.panelDisplay === 'none' && !closed1440.panelVisible), {
    expanded: closed1440?.expanded, display: closed1440?.panelDisplay,
  });
  say('T06343-04 搜索框收缩且可见', Boolean(closed1440?.searchVisible && closed1440?.searchWidth <= 160 && closed1440?.searchWidth >= 100), { width: closed1440?.searchWidth });
  say('T06343-05 模板入口可见并前置于添加任务', Boolean(closed1440?.templateVisible && closed1440?.addVisible && closed1440?.templateFirst), {
    templateFirst: closed1440?.templateFirst, templateTop: closed1440?.templateTop, addTop: closed1440?.addTop,
  });
  const s1440 = await shot('00-tasks-toolbar-1440.png');
  say('T06343-06 1440 收起态截图有效', Boolean(s1440?.bytes > 8000), s1440);

  await clickMore();
  const open1440 = await readLayout();
  say('T06343-07 More 展开且 8 类低频入口可见', Boolean(open1440 && open1440.expanded === 'true' && open1440.panelDisplay === 'flex' && open1440.panelVisible && lowNames.every((k) => open1440.lowState?.[k]?.visible) && open1440.lowState?.exportSelect?.visible), {
    expanded: open1440?.expanded, display: open1440?.panelDisplay, low: open1440?.lowState,
  });
  say('T06343-07b 低频项目操作也收进 More', Boolean(open1440?.lowState?.projectActions?.inPanel && open1440?.lowState?.projectActions?.visible), open1440?.lowState?.projectActions);
  say('T06343-08 More 面板 1440 不横向溢出', Boolean(open1440 && open1440.panelRight <= 1441 && open1440.panelWidth > 300 && open1440.scrollWidth <= 1441), {
    panelWidth: open1440?.panelWidth, panelRight: open1440?.panelRight, scrollWidth: open1440?.scrollWidth,
  });
  const sMore = await shot('01-tasks-more-1440.png');
  say('T06343-09 1440 展开态截图有效', Boolean(sMore?.bytes > 10_000), sMore);
  await clickMore();
  const reclosed = await readLayout();
  say('T06343-10 More 可再次收起', Boolean(reclosed && reclosed.expanded === 'false' && reclosed.panelDisplay === 'none'), {
    expanded: reclosed?.expanded, display: reclosed?.panelDisplay,
  });

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const at1280 = await readLayout();
  say('T06343-11 1280 首排不换行且无溢出', Boolean(at1280 && at1280.rows?.length === 1 && at1280.scrollWidth <= 1281), {
    rows: at1280?.rows, scrollWidth: at1280?.scrollWidth,
  });
  const s1280 = await shot('02-tasks-toolbar-1280.png');
  say('T06343-12 1280 截图有效', Boolean(s1280?.bytes > 8000), s1280);

  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const at1024 = await readLayout();
  say('T06343-12b 1024 无横向溢出', Boolean(at1024 && at1024.scrollWidth <= 1025), { scrollWidth: at1024?.scrollWidth, rows: at1024?.rows });
  const s1024 = await shot('04-tasks-toolbar-1024.png');
  say('T06343-12c 1024 截图有效', Boolean(s1024?.bytes > 8000), s1024);

  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const at760 = await readLayout();
  say('T06343-13 760 无横向溢出', Boolean(at760 && at760.scrollWidth <= 761), { scrollWidth: at760?.scrollWidth, rows: at760?.rows });
  await clickMore();
  const open760 = await readLayout();
  say('T06343-14 760 More 面板不撑出横向滚动', Boolean(open760 && open760.panelWidth <= 740 && open760.panelRight <= 761 && open760.scrollWidth <= 761), {
    panelWidth: open760?.panelWidth, panelRight: open760?.panelRight, scrollWidth: open760?.scrollWidth,
  });
  const s760 = await shot('03-tasks-more-760.png');
  say('T06343-15 760 展开态截图有效', Boolean(s760?.bytes > 8000), s760);

  // 模板入口仍可打开并列出模板，确认前置只改位置不改变交互
  const templateOpened = await evl(`document.querySelector('[data-t06305="template-menu"] button')?.click(); true`);
  const templatePanel = await until(`Boolean(document.querySelector('[data-t06305="template-panel"]'))`, 8_000);
  const templateReady = await until(`/任务模板/.test(document.querySelector('[data-t06305="template-panel"]')?.innerText || '')`, 12_000);
  const templateText = (await evl(`document.querySelector('[data-t06305="template-panel"]')?.innerText || ''`)).value || '';
  say('T06343-16 模板入口交互保持', Boolean(templateOpened && templatePanel && templateReady && /从模板新建/.test(templateText) && /任务模板|项目模板/.test(templateText)), {
    opened: templateOpened, panel: Boolean(templatePanel), ready: Boolean(templateReady), text: templateText.slice(0, 400),
  });

  say('T06343-99 全程无未捕获异常', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 8) });
} catch (e) {
  say('T06343-ERR 验收异常', false, String(e?.stack || e).slice(0, 2500));
} finally {
  saveResult();
  if (ws) { try { ws.close(); } catch { /* 忽略 */ } }
  if (chrome?.pid) killTree(chrome.pid);
  const pass = checks.filter((x) => x.ok).length;
  const fail = checks.filter((x) => !x.ok).length;
  console.log(JSON.stringify({ pass, fail, out: OUT }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
}
