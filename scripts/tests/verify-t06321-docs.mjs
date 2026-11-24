/**
 * T06321 文档发布审查验收：
 * ① 应用内「设置 → 帮助文档」已覆盖十期关键模块与更新日志；
 * ② 帮助搜索能定位模块、命令面板说明已更新为任务+Run 统一搜索；
 * ③ 帮助页 axe WCAG 2 A/AA 无 serious/critical；
 * ④ 1440 / 760 两档截图，窄屏帮助面板无横向溢出。
 *
 * 前置：web/dist 为最新构建，隔离服务 5217 正在提供 index.html。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.T06321_API || 'http://127.0.0.1:5217';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const AXE = process.env.AXE_PATH || 'C:/Users/hspcadmin/AppData/Local/Temp/eval_t171_clean/tests/phase3/vendor/axe.min.js';
const OUT = 'C:/Users/hspcadmin/AppData/Local/Temp/t06321-docs';
const EVID = 'D:/code/otherProjects/MTask/docs/evidence/p10-ui';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
mkdirSync(EVID, { recursive: true });
const checks = [];
const say = (name, ok, extra) => {
  checks.push({ name, ok: Boolean(ok), extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 900)}`}`);
};

let chrome = null;
let ws = null;
let seq = 0;
const pending = new Map();
function send(method, params = {}, timeout = 60_000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
async function evl(expression, timeout = 60_000) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result?.value;
}
async function until(expression, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evl(expression, 8_000)) return true; } catch { /* retry */ }
    await sleep(150);
  }
  return false;
}
const killTree = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } };
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(EVID, name);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return { file, bytes: Buffer.from(r.data, 'base64').length };
};

try {
  say('T06321-00 发布文档存在', existsSync('D:/code/otherProjects/MTask/docs/用户手册-十期.md') && existsSync('D:/code/otherProjects/MTask/docs/更新日志-十期.md'));
  say('T06321-00b axe 依赖存在', existsSync(AXE), { AXE });
  const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null);
  say('T06321-01 隔离服务就绪', health?.ok === true, health);

  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(OUT, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-features=Translate', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 30s 未报端口')), 30_000);
    const on = (d) => { buf += String(d); const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(buf); if (m) { clearTimeout(timer); resolve(Number(m[1])); } };
    chrome.stderr.on('data', on); chrome.stdout.on('data', on);
    chrome.on('exit', (c) => { clearTimeout(timer); reject(new Error(`Chrome 退出 ${c} ${buf.slice(-200)}`)); });
  });
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${API}/index.html` });
  const ready = await until(`Boolean(document.querySelector('nav')) && document.body.innerText.includes('任务')`, 30_000);
  say('T06321-02 首页加载完成', ready);

  const closeGuide = await evl(`(() => { const b = document.querySelector('[aria-label="关闭向导"]'); if (b) b.click(); return !document.querySelector('[aria-label="关闭向导"]'); })()`);
  await until(`!document.querySelector('[aria-label="关闭向导"]')`, 5_000);
  say('T06321-03 使用向导已关闭', closeGuide === true);

  await evl(`window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'settings' } })); true`);
  const settingsReady = await until(`Boolean(document.querySelector('[aria-label="主题：深色"]'))`, 20_000);
  say('T06321-04 设置页可达', settingsReady);
  await evl(`window.dispatchEvent(new CustomEvent('mtaskSettingsTab', { detail: { key: 'help' } })); true`);
  const helpReady = await until(`Boolean(document.querySelector('[data-help-tab="features"]'))`, 20_000);
  if (!helpReady) throw new Error('帮助文档页签未出现');
  await evl(`(() => {
    localStorage.setItem('mtask.help.subtab', 'features');
    const tab = document.querySelector('[data-help-tab="features"]');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  const featureReady = await until(`document.querySelector('[data-help-tab="features"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('#help-panel')?.innerText.includes('十期更新日志')`, 20_000);
  say('T06321-05 功能说明页默认可达', featureReady);

  const closeGuide2 = await evl(`(() => {
    const b = document.querySelector('[aria-label="关闭向导"]');
    if (!b) return true;
    b.click();
    return true;
  })()`);
  await until(`!document.querySelector('[aria-label="关闭向导"]')`, 5_000);
  say('T06321-05b 帮助页使用向导已关闭（截图与 axe 无遮挡）', closeGuide2 === true && await evl(`!document.querySelector('[aria-label="关闭向导"]')`));

  const modules = ['十期更新日志（0.1.1123.284）', '首页 · 今日与收件箱', '保存视图、模板与导入', 'Run 追踪与人工审批', '主题、无障碍与离线'];
  const coverage = await evl(`(() => {
    const text = document.querySelector('#help-panel')?.innerText || '';
    return { names: ${JSON.stringify(modules)}.map(n => ({ n, ok: text.includes(n) })), len: text.length, count: (text.match(/^\\s*[^\\n]{2,40}\\n/gm) || []).length };
  })()`);
  say('T06321-06 十期五个新增模块全部在帮助页', coverage.names.every((x) => x.ok) && coverage.len > 5000, coverage);

  const commandDoc = await evl(`(() => {
    const text = document.querySelector('#help-panel')?.innerText || '';
    return {
      old: text.includes('跨实体搜索任务/项目/提示词'),
      unified: text.includes('统一搜索任务与 Run'),
      searchSyntax: text.includes('type:task/run/all'),
      runMatch: text.includes('Run 按会话 ID/平台/阶段/关联任务'),
      zero: text.includes('归档 / 历史资产 / 搁置'),
    };
  })()`);
  say('T06321-07 命令面板说明已改为任务+Run 并含搜索语法', !commandDoc.old && commandDoc.unified && commandDoc.searchSyntax && commandDoc.runMatch && commandDoc.zero, commandDoc);

  const searchResult = await evl(`(async () => {
    const input = document.querySelector('[data-help-search]');
    if (!input) return { error: 'no-search' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '十期更新');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const text = document.querySelector('#help-panel')?.innerText || '';
    const count = (text.match(/十期更新日志（0.1.1123.284）/g) || []).length;
    setter?.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { count, has: text.includes('十期更新日志（0.1.1123.284）'), cleared: !(document.querySelector('[data-help-search]')?.value || '') };
  })()`);
  say('T06321-08 帮助搜索可命中十期更新模块并清空恢复', searchResult?.has === true && searchResult?.cleared === true, searchResult);

  const axeSrc = readFileSync(AXE, 'utf8');
  await evl(`${axeSrc}\n; true`, 90_000);
  const axeCheck = await evl(`(async () => {
    const scope = document.querySelector('#help-panel')?.parentElement || document.querySelector('#help-panel');
    const r = await axe.run(scope, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
    const map = r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
    return { total: r.violations.length, serious: map.filter(v => v.impact === 'serious' || v.impact === 'critical'), all: map, passes: r.passes.length };
  })()`, 120_000);
  say('T06321-09 帮助页 axe WCAG2 A/AA serious/critical=0', axeCheck?.serious?.length === 0, axeCheck);

  await evl(`document.querySelector('#help-panel')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); true`);
  await sleep(300);
  const s1440 = await shot('56-t06321-help-docs-1440.png');
  say('T06321-10 1440 帮助文档截图', existsSync(s1440.file), s1440);

  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const narrow = await evl(`(() => {
    const p = document.querySelector('#help-panel');
    const tabs = document.querySelector('.help-tabs');
    if (!p) return { error: 'no-panel' };
    const wide = p.scrollWidth > p.clientWidth + 1;
    const tabMetrics = tabs ? { scroll: tabs.scrollWidth, client: tabs.clientWidth, count: tabs.querySelectorAll('button').length } : null;
    return { wide, panel: { scroll: p.scrollWidth, client: p.clientWidth }, tabs: tabMetrics, viewport: innerWidth };
  })()`);
  say('T06321-11 760 窄屏帮助面板无横向溢出', narrow?.wide === false && narrow?.viewport === 760, narrow);
  await evl(`document.querySelector('#help-panel')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); true`);
  await sleep(300);
  const s760 = await shot('57-t06321-help-docs-760.png');
  say('T06321-12 760 帮助文档截图', existsSync(s760.file), s760);

  const passed = checks.filter((c) => c.ok).length;
  const summary = { checks, passed, total: checks.length, at: new Date().toISOString() };
  writeFileSync(join(OUT, 't06321-docs-result.json'), JSON.stringify(summary, null, 2), 'utf8');
  writeFileSync(join(OUT, 't06321-docs.log'), checks.map((c) => `[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}`).join('\n') + `\n${passed}/${checks.length} PASS\n`, 'utf8');
  console.log(`\n${passed}/${checks.length} PASS`);
  if (passed !== checks.length) process.exitCode = 1;
} catch (e) {
  say('T06321-ERR 未捕获异常', false, String(e?.stack || e));
  writeFileSync(join(OUT, 't06321-docs-result.json'), JSON.stringify({ checks, error: String(e?.stack || e) }, null, 2), 'utf8');
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  killTree(chrome?.pid);
}
