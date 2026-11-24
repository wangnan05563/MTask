/**
 * T06304（REQ-010 / PRD §B2）导入向导浏览器验收。
 *
 * 前置：隔离服务（默认 5202）+ web/dist 已构建。
 * 覆盖：CSV 文件选择 → 自动识别 Jira/映射外部 ID → 预览表显示外部 ID →
 *       确认导入 → 同文件重传按「来源+外部 ID」判重 → 1440/760 无横向溢出。
 *
 * 用法：node scripts/verify-t06304-visual.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.T06304_OUT || 'C:/pyfix_tmp/t06304-ui';
const API = process.env.T06304_API || 'http://127.0.0.1:5202';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CSV_PATH = join(OUT, 't06304-import.csv');

if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
try { rmSync(join(OUT, 'profile'), { recursive: true, force: true }); } catch { /* 忽略 */ }
writeFileSync(CSV_PATH, [
  'Summary,Description,Priority,Status,Issue key',
  'T06304 UI 导入甲,来自 Jira 的第一条,High,To Do,JIRA-UI-101',
  'T06304 UI 导入乙,来自 Jira 的第二条,Low,Done,JIRA-UI-102',
].join('\n'), 'utf8');

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
  const created = await fetch(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `T06304 UI 导入验证 ${Date.now()}`, description: 'T06304 隔离验收' }),
  }).then(json);
  if (!created.id) throw new Error(`创建测试项目失败：${JSON.stringify(created)}`);
  return created.id;
}

let chrome = null;
let ws = null;
try {
  const health = await fetch(`${API}/api/health`).then(json).catch((e) => ({ error: String(e) }));
  say('T06304-00 测试 API 就绪', health?.ok === true, health);
  if (health?.ok !== true) throw new Error(`API 未就绪：${JSON.stringify(health)}`);

  const projectId = await ensureProject();
  say('T06304-00b 测试项目就绪', Boolean(projectId), { projectId });

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
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].filter((d) => visible(d));
      for (const d of dialogs) {
        const btn = [...d.querySelectorAll('button')].find((b) => visible(b) && /关闭|知道了|跳过|稍后|开始使用|完成|取消|×/.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
        if (btn) btn.click();
      }
      return dialogs.length;
    })()`);
    await sleep(300);
  };
  const readPreview = async () => (await evl(`(() => {
    const panel = [...document.querySelectorAll('div')].find((d) => /^(CSV|JSON) 导入预览$/.test((d.querySelector('strong')?.innerText || '').trim()));
    if (!panel) return null;
    const extSelect = panel.querySelector('[data-t03267="map-externalId"]');
    const headers = [...panel.querySelectorAll('th')].map((th) => th.innerText.trim());
    const rows = [...panel.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    const rect = panel.getBoundingClientRect();
    return {
      title: panel.querySelector('strong')?.innerText.trim() || '',
      text: panel.innerText.slice(0, 700),
      source: panel.querySelector('[data-t03267="source"]')?.innerText.trim() || '',
      mappingExternalId: extSelect?.value ?? null,
      mappingOptions: extSelect ? [...extSelect.options].map((o) => o.textContent.trim()) : [],
      headers, rows,
      panelWidth: Math.round(rect.width), panelRight: Math.round(rect.right),
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewport: { w: innerWidth, h: innerHeight },
      confirmDisabled: Boolean([...panel.querySelectorAll('button')].find((b) => /确认导入/.test(b.innerText))?.disabled),
    };
  })()`)).value;
  const setFile = async (filePath) => {
    const r = await send('Runtime.evaluate', { expression: `document.querySelector('input[data-t03214="import-file-input"]')` });
    if (!r?.result?.objectId) return { __err: '未找到导入文件框' };
    const set = await send('DOM.setFileInputFiles', { files: [filePath], objectId: r.result.objectId });
    if (set.__err) return { __err: set.__err };
    // 个别环境 CDP 只改 FileList 不派发 change，兜底再显式派发一次（重复预览幂等）
    await sleep(900);
    const shown = await evl(`Boolean([...document.querySelectorAll('strong')].some((s) => /(CSV|JSON) 导入预览/.test(s.innerText)))`);
    if (!shown.value) {
      await evl(`(() => { const i = document.querySelector('input[data-t03214="import-file-input"]'); i?.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    }
    return { ok: true };
  };
  const clickConfirm = async () => (await evl(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /确认导入/.test(b.innerText) && !b.disabled);
    if (!btn) return false; btn.click(); return true;
  })()`)).value;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${API}/index.html` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { try {
    localStorage.setItem('mtask.guide.seen.dashboard', '1');
    localStorage.setItem('mtask.guide.seen.exec-sessions', '1');
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(projectId))});
  } catch {} return true; })()`);
  await send('Page.navigate', { url: `${API}/index.html` });
  await until(`Boolean(document.querySelector('#root aside'))`, 25_000);
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); return true; })()`);
  await until(`Boolean(document.querySelector('input[data-t03214="import-file-input"]'))`, 20_000);
  await dismiss();
  await sleep(800);

  const set1 = await setFile(CSV_PATH);
  say('T06304-01 选择 CSV 后出现导入预览', Boolean(set1?.ok && await until(`Boolean([...document.querySelectorAll('strong')].some((s) => /导入预览/.test(s.innerText)))`, 10_000)), set1);
  await sleep(500);
  const p1 = await readPreview();
  say('T06304-02 自动识别 Jira 并映射外部 ID', Boolean(
    p1 && /来源：Jira/i.test(p1.source) && p1.mappingExternalId === 'Issue key'
    && p1.mappingOptions.includes('Issue key') && p1.headers.includes('外部 ID'),
  ), p1);
  say('T06304-03 预览行携带外部 ID', Boolean(p1?.rows?.length === 2 && p1.rows[0]?.[5] === 'JIRA-UI-101' && p1.rows[1]?.[5] === 'JIRA-UI-102'), p1?.rows);
  const s1440 = await shot('00-t06304-import-preview-1440.png');
  say('T06304-04 1440 截图有效且无横向溢出', Boolean(s1440?.bytes > 10_000 && p1?.scrollWidth <= 1441), { shot: s1440, scrollWidth: p1?.scrollWidth });

  const clicked = await clickConfirm();
  const toast = await until(`(() => { const t = document.body.innerText; return /CSV 导入完成：2 条任务已创建/.test(t) ? t.match(/CSV 导入完成：[^\\n]+/)?.[0] : ''; })()`, 12_000);
  say('T06304-05 确认导入 2 条并回执', Boolean(clicked && toast), { clicked, toast });
  const todoRows = await fetch(`${API}/api/tasks?projectId=${encodeURIComponent(projectId)}&limit=100&status=todo`).then(json);
  const doneRows = await fetch(`${API}/api/tasks?projectId=${encodeURIComponent(projectId)}&limit=100&status=done`).then(json);
  const rows = [...(Array.isArray(todoRows) ? todoRows : (todoRows.rows ?? [])), ...(Array.isArray(doneRows) ? doneRows : (doneRows.rows ?? []))];
  const imported = rows.filter((t) => String(t.title).startsWith('T06304 UI 导入'));
  say('T06304-06 服务端落库 2 条（含 1 条完成态）', imported.length === 2, {
    count: rows.length,
    imported: imported.map((t) => ({ title: t.title, status: t.status })),
  });

  // 同文件重传：按来源+外部 ID 判重，UI 显示问题行
  await sleep(500);
  const set2 = await setFile(CSV_PATH);
  const dupShown = await until(`Boolean([...document.querySelectorAll('strong')].some((s) => /导入预览/.test(s.innerText)))`, 10_000);
  await sleep(500);
  const p2 = await readPreview();
  say('T06304-07 重复文件重传显示判重', Boolean(set2?.ok && dupShown && p2 && p2.rows.length === 0 && /问题 2 行/.test(p2.text) && /来源\+外部 ID 重复：jira:JIRA-UI-10[12]/.test(p2.text)), {
    source: p2?.source, rows: p2?.rows, text: p2?.text,
  });
  const sDup = await shot('01-t06304-import-duplicate-1440.png');
  say('T06304-08 判重态截图有效', Boolean(sDup?.bytes > 10_000), sDup);

  // 760：预览面板与表格不把页面撑出横向滚动
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const at760 = await readPreview();
  const s760 = await shot('02-t06304-import-duplicate-760.png');
  say('T06304-09 760 无横向溢出', Boolean(s760?.bytes > 8_000 && at760?.scrollWidth <= 761), { shot: s760, scrollWidth: at760?.scrollWidth, panel: at760?.panelWidth });
  say('T06304-10 全程无未捕获异常', consoleErrors.length === 0, { consoleErrors });
} catch (e) {
  say('T06304-ERR 验收异常', false, String(e?.stack || e).slice(0, 2500));
} finally {
  saveResult();
  if (ws) { try { ws.close(); } catch { /* 忽略 */ } }
  if (chrome?.pid) killTree(chrome.pid);
  const pass = checks.filter((x) => x.ok).length;
  const fail = checks.filter((x) => !x.ok).length;
  console.log(JSON.stringify({ pass, fail, out: OUT }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
}
