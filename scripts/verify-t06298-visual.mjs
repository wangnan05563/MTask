/**
 * T06298（REQ-036 / PRD §B6）Run 追踪详情浏览器验收。
 *
 * 前置：测试库副本已由 API 启动并完成 schema 初始化（默认 C:/pyfix_tmp/t06298-data），
 *       API 在 5195，web/dist 已构建。脚本只写测试库，不写生产库。
 *
 * 检查：
 * 1. 执行会话卡片有「追踪」入口，点击进入 Run 详情；
 * 2. 原生 Run 头部状态/任务/模型/Prompt/耗时/成本/审批正确；
 * 3. 5 个步骤时间线、类型/风险、成本归因 4 类、审批已批准；
 * 4. 步骤可展开输入/输出；重跑入口明确禁用；
 * 5. 返回看板后，旧会话进入兼容视图：3 个合成步骤、成本缺失提示、稳定 legacy ID；
 * 6. 1440/1280/760 截图有效、无横向溢出；
 * 7. 无未捕获前端异常。
 *
 * 用法：node scripts/verify-t06298-visual.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
const OUT = process.env.T06298_OUT || 'C:/pyfix_tmp/t06298-ui';
const DATA_DIR = process.env.T06298_DATA_DIR || 'C:/pyfix_tmp/t06298-data';
const DB_PATH = join(DATA_DIR, 'mtask.db');
const API = process.env.T06298_API || 'http://127.0.0.1:5195';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NATIVE_SESSION = 't06298-demo-session';
const LEGACY_SESSION = 't06298-legacy-session';
const NATIVE_RUN = 't06298-run-ui';

if (!existsSync(DB_PATH)) { console.error(`测试库不存在：${DB_PATH}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome 不存在：${CHROME}`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
try { rmSync(join(OUT, 'profile'), { recursive: true, force: true }); } catch { /* 忽略 */ }

const checks = [];
const say = (name, okVal, extra) => {
  const item = { name, ok: Boolean(okVal), extra };
  checks.push(item);
  console.log(`[${item.ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1600)}`}`);
};
const save = () => writeFileSync(join(OUT, 'visual-result.json'), JSON.stringify({
  pass: checks.filter((x) => x.ok).length, fail: checks.filter((x) => !x.ok).length, checks,
}, null, 2), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } };

function seedFixture() {
  const db = new DatabaseSync(DB_PATH);
  const taskId = '406a04db-1a28-4072-a330-618056f17c02';
  const projectId = '586ae8c6-2e08-4180-86ba-732f1fab5006';
  const task = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`测试库缺少 T06298 任务：${taskId}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_runs','agent_run_steps')").all();
  if (tables.length !== 2) throw new Error('agent_runs/agent_run_steps 尚未初始化：请先启动测试 API');
  const now = '2026-11-24T06:10:00.000Z';
  const start = '2026-11-24T06:09:52.000Z';
  db.prepare(`INSERT OR REPLACE INTO exec_sessions (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(NATIVE_SESSION, 'workbuddy', 'ext-t06298-demo', JSON.stringify([task.id]), 'done', 100, 1,
      'Run 追踪详情页实现与浏览器验收完成', now, start, now);
  db.prepare(`INSERT OR REPLACE INTO exec_sessions (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(LEGACY_SESSION, 'trae', 'ext-t06298-legacy', JSON.stringify([task.id]), 'stalled', 42, 1,
      '读取 Run 追踪需求', '2026-11-24T06:08:40.000Z', '2026-11-24T06:08:00.000Z', null);
  db.prepare('DELETE FROM agent_run_steps WHERE run_id = ?').run(NATIVE_RUN);
  db.prepare('DELETE FROM agent_runs WHERE id = ?').run(NATIVE_RUN);
  db.prepare(`INSERT INTO agent_runs (id, task_id, project_id, queue_id, parent_run_id, status, trigger_type, model,
      prompt_version, tokens, cost, executor, started_at, ended_at, error_code, legacy_source, legacy_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(NATIVE_RUN, task.id, projectId, null, null, 'succeeded', 'legacy', 'doubao-pro', 'p10-run-trace-v1',
      12345, 0.42, 'workbuddy', start, now, '', 'exec_session', NATIVE_SESSION, start, now);
  const step = db.prepare(`INSERT INTO agent_run_steps (id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  step.run('t06298-step-0', NATIVE_RUN, 0, 'prompt', 'succeeded',
    JSON.stringify({ task: 'T06298', requirement: 'REQ-036', context: 'PRD §B6 Run 追踪UI' }),
    JSON.stringify({ promptVersion: 'p10-run-trace-v1', model: 'doubao-pro', messages: ['系统：只读追踪', '用户：实现 Run 详情页'] }),
    1200, 0.03, 'R0', start, now);
  step.run('t06298-step-1', NATIVE_RUN, 1, 'tool', 'succeeded',
    JSON.stringify({ tool: 'read_file', files: ['web/src/pages/ExecSessionsPage.tsx', 'server/src/services/RunTraceService.ts'] }),
    JSON.stringify({ filesRead: 2, lines: 240 }), 2400, 0.05, 'R1', start, now);
  step.run('t06298-step-2', NATIVE_RUN, 2, 'observation', 'succeeded',
    JSON.stringify({ command: 'node scripts/verify-t06298-run-trace.mts' }),
    JSON.stringify({ result: '63 assertions passed', exitCode: 0 }), 2000, 0.08, 'R0', start, now);
  step.run('t06298-step-3', NATIVE_RUN, 3, 'artifact', 'succeeded',
    JSON.stringify({ type: 'patch', files: ['RunDetailPage.tsx', 'runTrace.css'] }),
    JSON.stringify({ commit: '8ab8782', summary: 'Run 追踪详情页与只读契约' }), 900, 0.26, 'R2', start, now);
  step.run('t06298-step-4', NATIVE_RUN, 4, 'approval', 'succeeded',
    JSON.stringify({ risk: 'R2', action: '写 UI 文件' }),
    JSON.stringify({ decision: 'approved', by: 'local-user' }), 1500, 0, 'R2', start, now);
  db.close();
}

let chrome = null;
let ws = null;
try {
  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  say('TRACE-00 测试 API 就绪', health?.ok === true, health);
  if (health?.ok !== true) throw new Error(`API 未就绪：${JSON.stringify(health)}`);
  seedFixture();
  say('TRACE-00b 测试库夹具写入（原生 Run + 旧会话）', true, { nativeSession: NATIVE_SESSION, legacySession: LEGACY_SESSION });

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
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].filter((d) => d.getAttribute('data-capture-root') === null && visible(d));
      for (const d of dialogs) {
        const btn = [...d.querySelectorAll('button')].find((b) => visible(b) && /关闭|知道了|跳过|稍后|开始使用|完成|取消|×/.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
        if (btn) btn.click();
      }
      return dialogs.length;
    })()`);
    await sleep(300);
  };
  const openSessionTrace = async (sessionId) => {
    const clicked = await evl(`(() => {
      const card = document.querySelector('[data-session-id="${sessionId}"]');
      const btn = card?.querySelector('[data-lck="trace-run-btn"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await until(`Boolean(document.querySelector('[data-lck="run-detail-page"]'))`, 10_000);
    return Boolean(clicked.value);
  };
  const inspectRun = async () => evl(`(() => {
    const page = document.querySelector('[data-lck="run-detail-page"]');
    const metrics = {};
    for (const m of document.querySelectorAll('.run-metric')) {
      metrics[m.querySelector('.run-metric-label')?.innerText?.trim()] = m.querySelector('.run-metric-value')?.innerText?.trim();
    }
    return {
      page: Boolean(page),
      runId: page?.getAttribute('data-run-id') || '',
      status: document.querySelector('[data-lck="run-status"]')?.innerText?.trim() || '',
      source: document.querySelector('.run-source')?.innerText?.trim() || '',
      title: document.querySelector('.run-title')?.innerText?.trim() || '',
      metrics,
      stepCount: document.querySelectorAll('[data-lck="run-step"]').length,
      stepTypes: [...document.querySelectorAll('.run-step-type')].map((e) => e.innerText.trim()),
      stepStatuses: [...document.querySelectorAll('[data-lck="run-step-toggle"] .run-step-status')].map((e) => e.innerText.trim()),
      syntheticCount: document.querySelectorAll('.run-synthetic').length,
      costBars: document.querySelectorAll('.run-cost-row').length,
      costLabels: [...document.querySelectorAll('.run-cost-row-head span:first-child')].map((e) => e.innerText.trim()),
      costPercents: [...document.querySelectorAll('.run-cost-row-head span:last-child')].map((e) => e.innerText.trim()),
      costTotal: document.querySelector('[data-lck="run-cost-total"]')?.innerText?.trim() || '',
      warnings: document.querySelector('[data-lck="run-warning-banner"]')?.innerText?.trim() || '',
      approval: document.querySelector('[data-lck="run-approval-card"]')?.innerText?.trim() || '',
      retryDisabled: Boolean(document.querySelector('[data-lck="run-retry-disabled"]')?.disabled),
      hasExport: Boolean(document.querySelector('[data-lck="run-export"]')),
      footer: document.querySelector('[data-lck="run-footer"]')?.innerText?.trim() || '',
      detailExpanded: Boolean(document.querySelector('.run-step-detail')),
      detailInput: document.querySelector('.run-step-detail pre')?.innerText?.slice(0, 180) || '',
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewport: { w: innerWidth, h: innerHeight },
      pageWidth: page ? Math.round(page.getBoundingClientRect().width) : 0,
    };
  })()`);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${API}/` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { try { localStorage.setItem('mtask.guide.seen.dashboard', '1'); localStorage.setItem('mtask.guide.seen.exec-sessions', '1'); } catch {} return true; })()`);
  await dismiss();
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'exec-sessions' } })); return true; })()`);
  await until(`Boolean(document.querySelector('[data-session-id="${NATIVE_SESSION}"]'))`, 15_000);
  await dismiss();
  const cardsReady = Boolean((await evl(`Boolean(document.querySelector('[data-session-id="${NATIVE_SESSION}"] [data-lck="trace-run-btn"]'))`)).value);
  say('TRACE-01 执行会话卡片出现追踪入口', cardsReady, { session: NATIVE_SESSION });

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const openNative = await openSessionTrace(NATIVE_SESSION);
  const native = (await inspectRun()).value;
  say('TRACE-02 原生 Run 详情页头部字段正确', Boolean(
    openNative && native?.page && native.runId === NATIVE_RUN && native.status === '成功'
    && native.title.includes('T06298') && native.title.includes('Run 追踪UI')
    && native.metrics.模型 === 'doubao-pro' && native.metrics['Prompt 版本'] === 'p10-run-trace-v1'
    && native.metrics.成本 === '$0.42' && native.metrics.审批 === '已批准'
    && native.metrics.耗时 === '8.0s',
  ), native);

  say('TRACE-03 步骤时间线/成本归因/审批与禁用重跑', Boolean(
    native?.stepCount === 5
    && native.stepTypes.join('|') === 'Prompt|工具调用|观察|产物|审批'
    && native.costBars === 4 && native.costLabels.join('|') === 'Prompt|工具调用|观察|产物'
    && native.costPercents.join('|') === '$0.03 · 7.1%|$0.05 · 11.9%|$0.08 · 19.0%|$0.26 · 61.9%'
    && native.costTotal === '$0.42' && native.approval.includes('已批准')
    && native.retryDisabled && native.hasExport,
  ), { stepTypes: native?.stepTypes, costLabels: native?.costLabels, costPercents: native?.costPercents, costTotal: native?.costTotal, retryDisabled: native?.retryDisabled });

  const stepToggle = await evl(`(() => {
    const step = document.querySelector('[data-step-seq="0"]');
    const btn = step?.querySelector('[data-lck="run-step-toggle"]');
    if (!btn) return false; btn.click(); return true;
  })()`);
  await until(`Boolean(document.querySelector('.run-step-detail'))`, 3_000);
  const expanded = (await inspectRun()).value;
  say('TRACE-04 步骤可展开并显示输入/输出', Boolean(stepToggle.value && expanded?.detailExpanded && expanded.detailInput.includes('"task"')), {
    detailInput: expanded?.detailInput,
  });
  const shot1440 = await shot('01-run-native-1440.png');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const shot1280 = await shot('02-run-native-1280.png');
  const native1280 = (await inspectRun()).value;
  say('TRACE-05 1280 无横向溢出', Boolean(shot1280?.bytes > 10_000 && native1280?.scrollWidth <= native1280?.viewport.w + 1), native1280);

  const backClick = await evl(`(() => { const b = document.querySelector('[data-lck="run-back"]'); if (!b) return false; b.click(); return true; })()`);
  const backBoard = await until(`Boolean(document.querySelector('[data-session-id="${NATIVE_SESSION}"]'))`, 5_000);
  say('TRACE-06 返回执行会话看板', Boolean(backClick.value && backBoard), { backBoard });

  const openLegacy = await openSessionTrace(LEGACY_SESSION);
  const legacy = (await inspectRun()).value;
  say('TRACE-07 旧会话兼容视图：稳定 ID、3 合成步骤、成本缺失', Boolean(
    openLegacy && legacy?.page && legacy.runId === `legacy:exec_session:${LEGACY_SESSION}`
    && legacy.status === '已暂停' && legacy.stepCount === 3 && legacy.syntheticCount === 3
    && legacy.costBars === 0 && legacy.costTotal === '$0.00'
    && legacy.warnings.includes('旧执行会话兼容视图') && legacy.costTotal === '$0.00',
  ), legacy);
  const shotLegacy = await shot('03-run-legacy-1280.png');

  await evl(`(() => { const b = document.querySelector('[data-lck="run-back"]'); if (b) b.click(); return true; })()`);
  await until(`Boolean(document.querySelector('[data-session-id="${NATIVE_SESSION}"]'))`, 5_000);

  await openSessionTrace(NATIVE_SESSION);
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const shot760 = await shot('04-run-native-760.png');
  const narrow = (await inspectRun()).value;
  say('TRACE-08 1440/1280/760 截图有效且无横向溢出', Boolean(
    shot1440?.bytes > 10_000 && shot1280?.bytes > 10_000 && shotLegacy?.bytes > 10_000 && shot760?.bytes > 10_000
    && narrow?.scrollWidth <= narrow?.viewport.w + 1 && narrow?.pageWidth <= narrow?.viewport.w + 1,
  ), { files: [shot1440, shot1280, shotLegacy, shot760], narrow });

  say('TRACE-09 无未捕获前端异常', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 3) });
  writeFileSync(join(OUT, 'visual-summary.json'), JSON.stringify({
    native, expanded, native1280, legacy, narrow, checks,
  }, null, 2), 'utf8');
} catch (e) {
  say('TRACE-FATAL 验收异常', false, String(e?.stack || e).slice(0, 900));
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { if (chrome) killTree(chrome.pid); } catch { /* 忽略 */ }
  save();
  console.log(`\n[t06298-visual] pass=${checks.filter((x) => x.ok).length} fail=${checks.filter((x) => !x.ok).length} out=${OUT}`);
  process.exit(checks.some((x) => !x.ok) ? 1 : 0);
}
