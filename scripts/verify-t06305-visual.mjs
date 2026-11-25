/**
 * T06305（REQ-010 / PRD §B2）模板实例化浏览器验收。
 *
 * 前置：隔离服务 + web/dist 已构建（服务需在 dist 生成后启动/重启才会伺服界面）。
 * 覆盖：模板入口 → 内置任务模板一键建任务 → 撤销归档 →
 *       内置项目模板一键建项目+4 任务 → 项目内继续编辑前可整体撤销 →
 *       1440/760 布局无横向溢出 → 全程无未捕获异常。
 *
 * 用法：node scripts/verify-t06305-visual.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.T06305_OUT || 'C:/pyfix_tmp/t06305-ui';
const API = process.env.T06305_API || 'http://127.0.0.1:5203';
const EVIDENCE = process.env.T06305_EVIDENCE || 'docs/evidence/p10-ui';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });
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
const taskRows = (res) => Array.isArray(res) ? res : (res?.rows ?? []);

async function ensureProject() {
  const created = await fetch(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `T06305 UI 模板验证 ${Date.now()}`, description: 'T06305 隔离验收' }),
  }).then(json);
  if (!created.id) throw new Error(`创建测试项目失败：${JSON.stringify(created)}`);
  return created.id;
}

let chrome = null;
let ws = null;
try {
  const health = await fetch(`${API}/api/health`).then(json).catch((e) => ({ error: String(e) }));
  say('T06305-00 测试 API 就绪', health?.ok === true, health);
  if (health?.ok !== true) throw new Error(`API 未就绪：${JSON.stringify(health)}`);
  const projectId = await ensureProject();
  say('T06305-00b 宿主项目就绪', Boolean(projectId), { projectId });

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
  const openMenu = async () => {
    await evl(`document.querySelector('[data-t06305="template-menu"] button')?.click(); true`);
    await until(`Boolean(document.querySelector('[data-t06305="template-panel"]'))`, 8000);
    await until(`!document.querySelector('[data-t06305="template-panel"]')?.innerText.includes('加载模板')`, 8000);
    await sleep(300);
  };
  const readMenu = async () => (await evl(`(() => {
    const panel = document.querySelector('[data-t06305="template-panel"]');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return {
      text: panel.innerText.slice(0, 900),
      rows: panel.querySelectorAll('[data-t06305^="template-row-"]').length,
      taskRows: panel.querySelectorAll('[data-t06305="template-row-task"]').length,
      projectRows: panel.querySelectorAll('[data-t06305="template-row-project"]').length,
      taskDisabled: Boolean(panel.querySelector('[data-t06305="apply-task"]')?.disabled),
      width: Math.round(rect.width), left: Math.round(rect.left), right: Math.round(rect.right),
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewport: { w: innerWidth, h: innerHeight },
    };
  })()`)).value;
  const clickApply = async (type) => (await evl(`(() => {
    const b = document.querySelector('[data-t06305="apply-${type}"]');
    if (!b || b.disabled) return false; b.click(); return true;
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
    localStorage.setItem('tasks.activeProject', ${JSON.stringify(projectId)});
  } catch {} return true; })()`);
  await send('Page.navigate', { url: `${API}/index.html` });
  await until(`Boolean(document.querySelector('#root aside'))`, 25_000);
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })); return true; })()`);
  await until(`Boolean(document.querySelector('[data-t06305="template-menu"]'))`, 20_000);
  await dismiss();
  await sleep(700);

  await openMenu();
  const m1 = await readMenu();
  say('T06305-01 模板入口打开并列出内置任务/项目模板', Boolean(
    m1 && m1.rows >= 2 && m1.taskRows >= 1 && m1.projectRows >= 1
    && /功能开发任务/.test(m1.text) && /标准交付项目/.test(m1.text),
  ), m1);
  say('T06305-02 已选具体项目，任务模板可应用', Boolean(m1 && m1.taskDisabled === false), { taskDisabled: m1?.taskDisabled });

  const appliedTask = await clickApply('task');
  const taskResult = await until(`(() => {
    const el = document.querySelector('[data-t06305="template-result"]');
    return el ? el.innerText : '';
  })()`, 12_000);
  say('T06305-03 任务模板一键实例化回执', Boolean(appliedTask && /已创建 1 条任务/.test(taskResult || '')), { appliedTask, taskResult });
  let hostTasks = taskRows(await fetch(`${API}/api/tasks?projectId=${encodeURIComponent(projectId)}&limit=100`).then(json));
  const createdTask = hostTasks.find((t) => String(t.title).startsWith('功能开发：'));
  say('T06305-04 任务落库到当前项目且字段来自模板', Boolean(createdTask && createdTask.priority === 'normal' && /## 目标/.test(String(createdTask.description || ''))), createdTask ? {
    id: createdTask.id, title: createdTask.title, priority: createdTask.priority, status: createdTask.status,
  } : { tasks: hostTasks.map((t) => t.title) });
  const shotTask = await shot('00-t06305-task-instance-1440.png');
  copyFileSync(join(OUT, '00-t06305-task-instance-1440.png'), join(EVIDENCE, '51-t06305-task-instance-1440.png'));
  say('T06305-05 1440 任务实例截图有效且无横向溢出', Boolean(shotTask?.bytes > 10_000 && m1?.scrollWidth <= 1441), { shot: shotTask, scrollWidth: m1?.scrollWidth });

  const undoTask = await evl(`document.querySelector('[data-t06305="undo"]')?.click(); true`);
  const undoMsg = await until(`(() => {
    const p = document.querySelector('[data-t06305="template-panel"]');
    return p && /已撤销/.test(p.innerText) ? p.innerText.match(/已撤销[^\\n]*/)?.[0] || '' : '';
  })()`, 12_000);
  const archivedRows = taskRows(await fetch(`${API}/api/tasks?projectId=${encodeURIComponent(projectId)}&limit=200&archived=true`).then(json));
  const archivedTask = createdTask?.id ? archivedRows.find((t) => t.id === createdTask.id) : null;
  say('T06305-06 任务实例撤销后归档', Boolean(undoTask?.value && undoMsg && archivedTask?.archived === true), {
    undoMsg,
    archived: archivedTask ? { id: archivedTask.id, archived: archivedTask.archived, archived_at: archivedTask.archived_at } : null,
  });

  const reopenIfClosed = async () => {
    const openNow = await evl(`Boolean(document.querySelector('[data-t06305="template-panel"]'))`);
    if (!openNow.value) await openMenu();
    await sleep(250);
  };

  await reopenIfClosed();
  const m2 = await readMenu();
  const appliedProject = await clickApply('project');
  const projectResult = await until(`(() => {
    const el = document.querySelector('[data-t06305="template-result"]');
    return el ? el.innerText : '';
  })()`, 12_000);
  say('T06305-07 项目模板一键创建项目+4 任务回执', Boolean(appliedProject && /已创建项目/.test(projectResult || '') && /4 条模板任务/.test(projectResult || '')), { appliedProject, projectResult });
  const projects = await fetch(`${API}/api/projects`).then(json);
  const projectList = Array.isArray(projects) ? projects : (projects?.rows ?? []);
  const instancesRes = await fetch(`${API}/api/templates/instances`).then(json);
  const instanceRows = instancesRes?.rows ?? [];
  const latestProjectInstance = instanceRows
    .filter((row) => row.templateId === 'builtin-project-标准交付项目')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const newProject = latestProjectInstance?.projectId
    ? projectList.find((p) => p.id === latestProjectInstance.projectId)
    : null;
  const newProjectTasks = newProject?.id
    ? taskRows(await fetch(`${API}/api/tasks?projectId=${encodeURIComponent(newProject.id)}&limit=100`).then(json))
    : [];
  say('T06305-08 新项目与 4 条模板任务落库', Boolean(newProject?.id && newProjectTasks.length === 4), {
    project: newProject ? { id: newProject.id, name: newProject.name } : null,
    tasks: newProjectTasks.map((t) => `${t.title}:${t.status}`),
  });
  await until(`document.body.innerText.includes('共 4 条')`, 8000);
  await sleep(300);
  const shotProject = await shot('01-t06305-project-instance-1440.png');
  copyFileSync(join(OUT, '01-t06305-project-instance-1440.png'), join(EVIDENCE, '52-t06305-project-instance-1440.png'));
  say('T06305-09 1440 项目实例截图有效', Boolean(shotProject?.bytes > 10_000), shotProject);

  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const m760 = await readMenu();
  const shot760 = await shot('02-t06305-project-instance-760.png');
  copyFileSync(join(OUT, '02-t06305-project-instance-760.png'), join(EVIDENCE, '53-t06305-project-instance-760.png'));
  say('T06305-10 760 面板不撑出横向滚动', Boolean(shot760?.bytes > 8_000 && m760 && m760.scrollWidth <= 761 && m760.width <= 741), {
    shot: shot760, panel: { width: m760?.width, left: m760?.left, right: m760?.right }, scrollWidth: m760?.scrollWidth,
  });

  const undoProject = await evl(`document.querySelector('[data-t06305="undo"]')?.click(); true`);
  const undoProjectMsg = await until(`(() => {
    const p = document.querySelector('[data-t06305="template-panel"]');
    return p && /已撤销/.test(p.innerText) ? p.innerText.match(/已撤销[^\\n]*/)?.[0] || '' : '';
  })()`, 12_000);
  const afterProjectsRes = await fetch(`${API}/api/projects`).then(json);
  const afterProjects = Array.isArray(afterProjectsRes) ? afterProjectsRes : (afterProjectsRes?.rows ?? []);
  const projectStillThere = newProject?.id ? afterProjects.some((p) => p.id === newProject.id) : true;
  say('T06305-11 项目实例撤销删除项目', Boolean(undoProject?.value && undoProjectMsg && !projectStillThere), {
    undoProjectMsg, projectId: newProject?.id ?? null, projectStillThere,
  });
  say('T06305-12 全程无未捕获异常', consoleErrors.length === 0, { consoleErrors });
} catch (e) {
  say('T06305-ERR 验收异常', false, String(e?.stack || e).slice(0, 2500));
} finally {
  saveResult();
  if (ws) { try { ws.close(); } catch { /* 忽略 */ } }
  if (chrome?.pid) killTree(chrome.pid);
  const pass = checks.filter((x) => x.ok).length;
  const fail = checks.filter((x) => !x.ok).length;
  console.log(JSON.stringify({ pass, fail, out: OUT }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
}
