/**
 * T06300（REQ-007 / PRD §B7）审批弹窗浏览器验收。
 *
 * 前置：测试服务已启动（默认 127.0.0.1:5198），测试库位于 T06300_DATA_DIR，
 *       web/dist 已构建。脚本只写测试库，不碰生产库。
 *
 * 检查：
 * 1. Run 详情页出现「处理审批」入口；
 * 2. 弹窗含风险等级、影响范围、diff、执行预览与决策备注；
 * 3. 超时显示未来时点「剩余 N 小时/天」，不再误显示「刚刚」；
 * 4. 1440/1280/760 三档截图有效且无横向溢出；
 * 5. 批准后 Run 回到 running，页脚提示正确，审计新增 approved 事件；
 * 6. 无未捕获前端异常。
 *
 * 用法：node scripts/verify-t06300-visual.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const OUT = process.env.T06300_OUT || 'C:/pyfix_tmp/t06300-ui';
const DATA_DIR = process.env.T06300_DATA_DIR || 'C:/Users/hspcadmin/AppData/Local/Temp/t06300-ui';
const DB_PATH = join(DATA_DIR, 'mtask.db');
const API = process.env.T06300_API || 'http://127.0.0.1:5198';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROJECT = 'p-t06300-ui';
const TASK_ID = 'task-t06300-ui';
const SESSION = 'sess-t06300-ui';
const RUN = 'run-t06300-ui';
const STEP = 'run-t06300-ui-s1';

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
  const now = new Date().toISOString();
  try {
    db.prepare('DELETE FROM agent_run_approvals WHERE run_id = ?').run(RUN);
    db.prepare('DELETE FROM agent_run_steps WHERE run_id = ?').run(RUN);
    db.prepare('DELETE FROM agent_runs WHERE id = ?').run(RUN);
    db.prepare('DELETE FROM exec_sessions WHERE id = ?').run(SESSION);
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(PROJECT);
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(PROJECT, '十期审批 UI 验证', now, now);
    db.prepare('INSERT INTO tasks (id, task_no, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(TASK_ID, 'T06300-UI', PROJECT, '审批弹窗 UI 验证', 'todo', now, now);
    db.prepare(`INSERT INTO exec_sessions
      (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at)
      VALUES (?, 'workbuddy', ?, ?, 'active', 70, 1, ?, ?, ?)`)
      .run(SESSION, 'wb-t06300-ui', JSON.stringify([TASK_ID]), '等待高风险审批', now, now);
    db.prepare(`INSERT INTO agent_runs
      (id, task_id, project_id, status, trigger_type, model, prompt_version, tokens, cost, executor, started_at, legacy_source, legacy_ref, created_at, updated_at)
      VALUES (?, ?, ?, 'running', 'manual', 'doubao', 'prd-b7-v1', 1234, 0.012, 'workbuddy', ?, 'exec_session', ?, ?, ?)`)
      .run(RUN, TASK_ID, PROJECT, now, SESSION, now, now);
    db.prepare(`INSERT INTO agent_run_steps (id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
      VALUES (?, ?, 0, 'prompt', 'succeeded', ?, ?, 900, 0.002, 'R0', ?, ?)`)
      .run(`${RUN}-s0`, RUN, JSON.stringify({ prompt: '执行任务 T06300 审批 UI 验证' }), '已解析任务与项目上下文', now, now);
    db.prepare(`INSERT INTO agent_run_steps (id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
      VALUES (?, ?, 1, 'tool', 'running', ?, '', 0, 0, 'R2', ?, ?)`)
      .run(STEP, RUN, JSON.stringify({ tool: 'delete_file', path: 'server/data/mtask.db' }), now, now);
  } finally { db.close(); }
}

let chrome = null;
let ws = null;
try {
  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  say('T06300-00 测试 API 就绪', health?.ok === true, health);
  if (health?.ok !== true) throw new Error(`API 未就绪：${JSON.stringify(health)}`);
  seedFixture();
  say('T06300-00b 测试夹具写入', true, { project: PROJECT, session: SESSION, run: RUN });

  const gate = await fetch(`${API}/api/run-risk/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: RUN,
      stepId: STEP,
      projectId: PROJECT,
      signal: {
        operation: 'delete',
        target: 'server/data/mtask.db',
        action: '覆盖并删除生产数据文件',
      },
      actor: 'workbuddy/T06300-ui',
      impact: '将删除 server/data/mtask.db（含 42 条任务、8 个项目与 Run 审计），删除后无法从回收站恢复。',
      diff: '--- a/server/data/mtask.db\n+++ b/server/data/mtask.db\n@@ -1,6 +1,4 @@\n- tasks: 42 rows\n- projects: 8 rows\n- agent_run_audit: 137 rows\n- agent_run_approvals: 3 rows\n+ tasks: 0 rows\n+ projects: 0 rows\n+ (数据库文件被覆盖)',
      preview: 'rm -f server/data/mtask.db\n# 随后以空库重启，原任务与审计不可恢复',
    }),
  }).then((r) => r.json());
  say('T06300-01 R2 门禁创建待审批', gate?.decision === 'ask' && Boolean(gate?.approval?.id), gate);
  if (gate?.decision !== 'ask' || !gate?.approval?.id) throw new Error('门禁未创建审批');

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
  const inspectModal = async () => evl(`(() => {
    const dialog = document.querySelector('.approval-dialog');
    const rect = dialog?.getBoundingClientRect();
    return {
      modal: Boolean(document.querySelector('[data-lck="approval-modal"]')),
      risk: document.querySelector('[data-lck="approval-risk"]')?.innerText.trim() || '',
      impact: document.querySelector('[data-lck="approval-impact"]')?.innerText.trim() || '',
      diffLines: (document.querySelector('[data-lck="approval-diff"]')?.innerText || '').split(/\\n/).length,
      preview: document.querySelector('[data-lck="approval-preview"]')?.innerText.trim() || '',
      approve: document.querySelector('[data-lck="approval-approve"]')?.innerText.trim() || '',
      reject: document.querySelector('[data-lck="approval-reject"]')?.innerText.trim() || '',
      reason: Boolean(document.querySelector('[data-lck="approval-reason"]')),
      expiry: document.querySelector('.approval-expiry')?.innerText.trim() || '',
      width: rect ? Math.round(rect.width) : 0,
      right: rect ? Math.round(rect.right) : 0,
      viewport: { w: innerWidth, h: innerHeight },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  })()`).then((r) => r.value);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${API}/index.html` });
  await until(`Boolean(document.querySelector('#root aside'))`, 30_000);
  await evl(`(() => { try { localStorage.setItem('mtask.guide.seen.dashboard', '1'); localStorage.setItem('mtask.guide.seen.exec-sessions', '1'); } catch {} return true; })()`);
  await send('Page.reload');
  await sleep(2200);
  await until(`Boolean(document.querySelector('#root aside'))`, 20_000);
  await dismiss();
  await evl(`(() => { window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'exec-sessions' } })); return true; })()`);
  await until(`Boolean(document.querySelector('[data-session-id="${SESSION}"]'))`, 15_000);
  await dismiss();
  const cardsReady = Boolean((await evl(`Boolean(document.querySelector('[data-session-id="${SESSION}"] [data-lck="trace-run-btn"]'))`)).value);
  say('T06300-02 执行会话卡片出现追踪入口', cardsReady, { session: SESSION });

  const openTrace = await evl(`(() => {
    const card = document.querySelector('[data-session-id="${SESSION}"]');
    const btn = card?.querySelector('[data-lck="trace-run-btn"]');
    if (!btn) return false; btn.click(); return true;
  })()`);
  await until(`Boolean(document.querySelector('[data-lck="run-detail-page"]'))`, 10_000);
  const runBefore = (await evl(`(() => {
    const p = document.querySelector('[data-lck="run-detail-page"]');
    return {
      page: Boolean(p),
      id: p?.getAttribute('data-run-id') || '',
      status: p?.getAttribute('data-run-status') || '',
      cta: Boolean(document.querySelector('[data-lck="run-approval-open"]')),
      approvalText: document.querySelector('[data-lck="run-approval-card"]')?.innerText.trim() || '',
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewport: { w: innerWidth, h: innerHeight },
    };
  })()`)).value;
  say('T06300-03 待审批 Run 显示处理入口', Boolean(
    openTrace.value && runBefore?.page && runBefore.id === RUN
    && runBefore.status === 'awaiting_approval' && runBefore.cta
    && runBefore.approvalText.includes('等待审批'),
  ), runBefore);
  const shotRun = await shot('00-run-awaiting-1440.png');

  const openApproval = await evl(`(() => { const b = document.querySelector('[data-lck="run-approval-open"]'); if (!b) return false; b.click(); return true; })()`);
  await until(`Boolean(document.querySelector('[data-lck="approval-modal"]'))`, 8_000);
  const modal1440 = await inspectModal();
  say('T06300-04 审批弹窗字段完整', Boolean(
    openApproval.value && modal1440?.modal && modal1440.risk === 'R2 覆盖/删除'
    && modal1440.impact.includes('server/data/mtask.db') && modal1440.diffLines >= 4
    && modal1440.preview.includes('rm -f server/data/mtask.db')
    && modal1440.approve.includes('批准并继续') && modal1440.reject.includes('拒绝并终止')
    && modal1440.reason,
  ), modal1440);
  say('T06300-05 超时显示未来时点而非「刚刚」', Boolean(
    modal1440?.expiry.includes('剩余') && /(分钟|小时|天)/.test(modal1440.expiry)
    && !modal1440.expiry.includes('刚刚'),
  ), { expiry: modal1440?.expiry });
  const shot1440 = await shot('01-approval-modal-1440.png');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const modal1280 = await inspectModal();
  const shot1280 = await shot('02-approval-modal-1280.png');
  say('T06300-06 1280 无横向溢出', Boolean(
    shot1280?.bytes > 10_000 && modal1280?.right <= modal1280?.viewport.w + 1
    && modal1280?.scrollWidth <= modal1280?.viewport.w + 1,
  ), { shot1280, modal1280 });

  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const modal760 = await inspectModal();
  const shot760 = await shot('03-approval-modal-760.png');
  say('T06300-07 760 窄屏无横向溢出', Boolean(
    shot760?.bytes > 10_000 && modal760?.right <= modal760?.viewport.w + 1
    && modal760?.scrollWidth <= modal760?.viewport.w + 1 && modal760?.width < modal1440.width,
  ), { shot760, modal760 });

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  await evl(`(() => { const r = document.querySelector('[data-lck="approval-reason"]'); if (r) r.value = '影响范围已确认，允许执行'; return true; })()`);
  const approveClick = await evl(`(() => { const b = document.querySelector('[data-lck="approval-approve"]'); if (!b) return false; b.click(); return true; })()`);
  await until(`document.querySelector('[data-lck="approval-modal"]') === null`, 12_000);
  const after = (await evl(`(() => ({
    page: Boolean(document.querySelector('[data-lck="run-detail-page"]')),
    status: document.querySelector('[data-lck="run-detail-page"]')?.getAttribute('data-run-status') || '',
    notice: document.querySelector('.run-footer-note')?.innerText.trim() || '',
    approval: document.querySelector('[data-lck="run-approval-card"]')?.innerText.trim() || '',
  }))()`)).value;
  say('T06300-08 批准后弹窗关闭且 Run 恢复运行', Boolean(
    approveClick.value && after?.page && after.status === 'running'
    && after.notice.includes('已批准') && after.approval.includes('已批准'),
  ), after);
  const shotApproved = await shot('04-approval-approved-1440.png');

  const audit = await fetch(`${API}/api/run-risk/audit?runId=${RUN}&limit=50`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const approvedEvents = (audit?.rows || []).filter((row) => row.eventType === 'approved' && row.approvalId === gate.approval.id);
  say('T06300-09 批准写入审计', approvedEvents.length === 1 && approvedEvents[0].actor === 'web-ui', {
    approvedEvents, auditCount: audit?.count,
  });
  say('T06300-10 三档截图有效', Boolean(
    shotRun?.bytes > 10_000 && shot1440?.bytes > 10_000 && shot1280?.bytes > 10_000
    && shot760?.bytes > 10_000 && shotApproved?.bytes > 10_000,
  ), { files: [shotRun, shot1440, shot1280, shot760, shotApproved] });
  say('T06300-11 无未捕获前端异常', consoleErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 3) });

  writeFileSync(join(OUT, 'visual-summary.json'), JSON.stringify({
    gate, runBefore, modal1440, modal1280, modal760, after, approvedEvents, checks,
  }, null, 2), 'utf8');
  save();
  if (checks.some((x) => !x.ok)) process.exitCode = 1;
} catch (e) {
  say('T06300-99 验收中断', false, String(e?.stack || e).slice(0, 1200));
  save();
  process.exitCode = 2;
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  if (chrome?.pid) killTree(chrome.pid);
}
