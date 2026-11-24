/**
 * T06303（REQ-009 / PRD §B1）保存视图浏览器验收。
 *
 * 前置：隔离测试服务已启动（默认 127.0.0.1:5199），web/dist 已构建；
 *       脚本只写测试库（项目/任务/保存视图），不碰生产库。
 *
 * 覆盖：
 * 1. 工具条出现保存视图入口，URL 恢复 view/q/priority/density；
 * 2. UI 保存视图（命名 + 项目共享确认）→ 服务端 config 白名单字段正确；
 * 3. 应用视图恢复筛选/视图/密度；
 * 4. 复制、删除视图；
 * 5. 刷新后 URL 仍恢复视图；
 * 6. 1440/760 无横向溢出、截图有效、无未捕获异常。
 *
 * 用法：node scripts/verify-t06303-visual.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.T06303_OUT || 'C:/pyfix_tmp/t06303-ui';
const API = process.env.T06303_API || 'http://127.0.0.1:5199';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VIEW_NAME = 'T06303 视图';
const QUERY = 'view=board&q=T06303&priority=high&density=comfortable&boardHide=0';

if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
try { rmSync(join(OUT, 'profile'), { recursive: true, force: true }); } catch { /* 忽略 */ }

const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1800)}`}`);
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

async function ensureProject() {
  const list = await fetch(`${API}/api/projects`).then(json);
  const rows = Array.isArray(list) ? list : (list.rows ?? []);
  const found = rows.find?.((p) => p.name === 'T06303 保存视图验证');
  if (found) return found.id;
  const created = await fetch(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'T06303 保存视图验证', description: 'T06303 隔离验收' }),
  }).then(json);
  if (!created.id) throw new Error(`创建测试项目失败：${JSON.stringify(created)}`);
  return created.id;
}

async function createTask(projectId, title, priority, status) {
  const r = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, title, priority, status }),
  });
  if (!r.ok) throw new Error(`创建任务失败：${r.status} ${await r.text()}`);
  return r.json();
}

let chrome = null;
let ws = null;
try {
  const health = await fetch(`${API}/api/health`).then(json).catch((e) => ({ error: String(e) }));
  say('T06303-00 测试 API 就绪', health?.ok === true, health);
  if (health?.ok !== true) throw new Error(`API 未就绪：${JSON.stringify(health)}`);

  const projectId = await ensureProject();
  const oldViews = await fetch(`${API}/api/saved-views?projectId=${encodeURIComponent(projectId)}`).then(json);
  for (const v of oldViews.rows ?? []) {
    await fetch(`${API}/api/saved-views/${encodeURIComponent(v.id)}`, { method: 'DELETE' });
  }
  await createTask(projectId, 'T06303 高优待验证任务', 'high', 'todo');
  await createTask(projectId, 'T06303 普通待办任务', 'normal', 'todo');
  await createTask(projectId, 'T06303 已完成任务', 'normal', 'done');
  say('T06303-00b 测试夹具就绪', true, { projectId, tasks: 3 });

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
      await sleep(180);
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
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].filter((d) => d.getAttribute('data-capture-root') === null && visible(d));
      for (const d of dialogs) {
        const btn = [...d.querySelectorAll('button')].find((b) => visible(b) && /关闭|知道了|跳过|稍后|开始使用|完成|取消|×/.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
        if (btn) btn.click();
      }
      return dialogs.length;
    })()`);
    await sleep(300);
  };
  const readMenu = async () => (await evl(`(() => {
    const menu = document.querySelector('[data-t06303="saved-view-menu"]');
    const select = menu?.querySelector('select');
    const rect = menu?.getBoundingClientRect();
    return {
      menu: Boolean(menu),
      options: [...(select?.options ?? [])].map((o) => ({ value: o.value, text: o.textContent }) ),
      selected: select?.value || '',
      disabled: Boolean(select?.disabled),
      saveDisabled: Boolean(menu?.querySelector('[aria-label="保存当前视图"]')?.disabled),
      copyDisabled: Boolean(menu?.querySelector('[aria-label="复制当前视图"]')?.disabled),
      deleteDisabled: Boolean(menu?.querySelector('[aria-label="删除当前视图"]')?.disabled),
      width: rect ? Math.round(rect.width) : 0,
      right: rect ? Math.round(rect.right) : 0,
      viewport: { w: innerWidth, h: innerHeight },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      url: location.search,
      boardPressed: Boolean(document.querySelector('[aria-label="看板视图"]')?.getAttribute('aria-pressed') === 'true'),
      listPressed: Boolean(document.querySelector('[aria-label="列表视图"]')?.getAttribute('aria-pressed') === 'true'),
    };
  })()`)).value;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${API}/index.html` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { try {
    localStorage.setItem('mtask.guide.seen.dashboard', '1');
    localStorage.setItem('mtask.guide.seen.exec-sessions', '1');
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(projectId))});
  } catch {} return true; })()`);
  await send('Page.navigate', { url: `${API}/index.html?${QUERY}` });
  await until(`Boolean(document.querySelector('#root aside'))`, 25_000);
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); return true; })()`);
  await until(`Boolean(document.querySelector('[data-t06303="saved-view-menu"]'))`, 20_000);
  await dismiss();
  await sleep(1000);
  const initial = await readMenu();
  say('T06303-01 保存视图入口与 URL 恢复', Boolean(
    initial?.menu && initial.boardPressed && initial.selected === '' && !initial.saveDisabled
    && initial.url.includes('view=board') && initial.url.includes('q=T06303')
    && initial.url.includes('priority=high') && initial.url.includes('density=comfortable'),
  ), initial);
  const shot1440 = await shot('00-t06303-saved-view-1440.png');
  say('T06303-02 1440 工具栏无横向溢出', Boolean(shot1440?.bytes > 10_000 && initial?.scrollWidth <= 1441 && initial?.right <= 1441), {
    shot: shot1440, scrollWidth: initial?.scrollWidth, right: initial?.right,
  });

  // UI 保存：命名 → 项目共享确认
  const clickSave = await evl(`(() => { const b = document.querySelector('[aria-label="保存当前视图"]'); if (!b) return false; b.click(); return true; })()`);
  await until(`Boolean(document.querySelector('[role="dialog"] input'))`, 8_000);
  await evl(`(() => {
    const input = document.querySelector('[role="dialog"] input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(VIEW_NAME)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evl(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('确定')); b?.click(); return Boolean(b); })()`);
  await until(`Boolean(document.querySelector('[role="alertdialog"]'))`, 8_000);
  const confirmText = (await evl(`document.querySelector('[role="alertdialog"]')?.innerText || ''`)).value;
  await evl(`(() => { const b = [...document.querySelectorAll('[role="alertdialog"] button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('确定')); b?.click(); return Boolean(b); })()`);
  await until(`[...document.querySelectorAll('[data-t06303="saved-view-menu"] option')].some((o) => o.textContent.includes(${JSON.stringify(VIEW_NAME)}))`, 12_000);
  const afterSave = await readMenu();
  const views1 = await fetch(`${API}/api/saved-views?projectId=${encodeURIComponent(projectId)}`).then(json);
  const saved1 = views1.rows?.find((v) => v.name === VIEW_NAME);
  say('T06303-03 UI 保存视图并写对 config', Boolean(
    clickSave.value && confirmText.includes('项目共享') && saved1
    && saved1.visibility === 'project' && saved1.type === 'board'
    && saved1.config?.viewMode === 'board' && saved1.config?.search === 'T06303'
    && saved1.config?.priorityFilter === 'high' && saved1.config?.density === 'comfortable',
  ), { saved: saved1, confirmText, options: afterSave?.options, savedId: afterSave?.selected });

  // 切到列表，再应用保存视图，应该恢复看板 + URL 筛选
  await evl(`(() => { document.querySelector('[aria-label="列表视图"]')?.click(); return true; })()`);
  await sleep(500);
  const beforeApply = await readMenu();
  await evl(`(() => {
    const s = document.querySelector('[data-t06303="saved-view-menu"] select');
    const id = ${JSON.stringify(saved1?.id ?? '')};
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, id); s.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`);
  await until(`document.querySelector('[aria-label="看板视图"]')?.getAttribute('aria-pressed') === 'true'`, 8_000);
  await sleep(600);
  const applied = await readMenu();
  say('T06303-04 应用视图恢复看板与筛选 URL', Boolean(
    beforeApply?.listPressed && applied?.boardPressed && applied?.selected === saved1?.id
    && applied.url.includes('view=board') && applied.url.includes('q=T06303')
    && applied.url.includes('priority=high') && applied.url.includes('density=comfortable'),
  ), { before: beforeApply, after: applied });

  // 复制
  const clickCopy = await evl(`(() => { const b = document.querySelector('[aria-label="复制当前视图"]'); if (!b) return false; b.click(); return true; })()`);
  await until(`[...document.querySelectorAll('[data-t06303="saved-view-menu"] option')].filter((o) => o.value).length >= 2`, 12_000);
  const views2 = await fetch(`${API}/api/saved-views?projectId=${encodeURIComponent(projectId)}`).then(json);
  const copy = views2.rows?.find((v) => v.name.includes('（副本）'));
  const afterCopy = await readMenu();
  say('T06303-05 复制视图并自动避让重名', Boolean(clickCopy.value && copy && afterCopy?.selected === copy?.id && afterCopy.options?.some((o) => o.value === copy.id)), {
    copy, options: afterCopy?.options, selected: afterCopy?.selected,
  });

  // 删除副本
  const clickDelete = await evl(`(() => { const b = document.querySelector('[aria-label="删除当前视图"]'); if (!b) return false; b.click(); return true; })()`);
  await until(`Boolean(document.querySelector('[role="alertdialog"]'))`, 8_000);
  await evl(`(() => { const b = [...document.querySelectorAll('[role="alertdialog"] button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('确定')); b?.click(); return Boolean(b); })()`);
  await until(`[...document.querySelectorAll('[data-t06303="saved-view-menu"] option')].length === 2`, 10_000);
  const views3 = await fetch(`${API}/api/saved-views?projectId=${encodeURIComponent(projectId)}`).then(json);
  const afterDelete = await readMenu();
  say('T06303-06 删除视图仅删配置行', Boolean(clickDelete.value && views3.rows?.length === 1 && !views3.rows?.some((v) => v.id === copy?.id) && afterDelete?.selected === ''), {
    remaining: views3.rows?.map((v) => v.name), after: afterDelete,
  });

  // 760 视口：菜单仍在视口内，无横向溢出（列表布局测量；看板列本身可横向滚动）
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
  await evl(`(() => { document.querySelector('[aria-label="列表视图"]')?.click(); return true; })()`);
  await sleep(600);
  const at760 = await readMenu();
  const shot760 = await shot('01-t06303-saved-view-760.png');
  say('T06303-07 760 无横向溢出', Boolean(shot760?.bytes > 8_000 && at760?.scrollWidth <= 761 && at760?.right <= 761 && at760?.menu), {
    shot: shot760, menu: at760,
  });

  // 回到 1440，应用原视图后刷新，验证 URL 恢复
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await evl(`(() => {
    const s = document.querySelector('[data-t06303="saved-view-menu"] select');
    const id = ${JSON.stringify(saved1?.id ?? '')};
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, id); s.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`);
  await sleep(800);
  await send('Page.reload');
  await until(`Boolean(document.querySelector('#root aside'))`, 25_000);
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); return true; })()`);
  await until(`Boolean(document.querySelector('[data-t06303="saved-view-menu"]'))`, 25_000);
  await dismiss();
  await sleep(1200);
  const afterReload = await readMenu();
  say('T06303-08 刷新后按 URL 恢复视图/筛选', Boolean(
    afterReload?.menu && afterReload.boardPressed
    && afterReload.url.includes('view=board') && afterReload.url.includes('q=T06303')
    && afterReload.url.includes('priority=high') && afterReload.url.includes('density=comfortable'),
  ), afterReload);
  const shotReload = await shot('02-t06303-saved-view-reload-1440.png');
  say('T06303-09 刷新后截图有效且无异常', Boolean(shotReload?.bytes > 10_000 && consoleErrors.length === 0), {
    shot: shotReload, consoleErrors,
  });
} catch (e) {
  say('T06303-ERR 验收异常', false, String(e?.stack || e).slice(0, 2500));
} finally {
  saveResult();
  if (ws) { try { ws.close(); } catch { /* 忽略 */ } }
  if (chrome?.pid) killTree(chrome.pid);
  const pass = checks.filter((x) => x.ok).length;
  const fail = checks.filter((x) => !x.ok).length;
  console.log(JSON.stringify({ pass, fail, out: OUT }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
}
