#!/usr/bin/env node
/**
 * T02307 UI 腿：真机浏览器点「AI 批量分类」，核对账户级门禁下的中止提示与忙碌态复位。
 *
 * 只断言「非真实浏览器不能回答」的产物：
 *   U-01 页面就绪：工具条按钮可点，未分类计数 = 30（目标数来自真实任务列表，不是门自报）；
 *   U-02 点击后弹出确认对话框（批量入口的真实交互前提）；
 *   U-03 运行期忙碌态可见（按钮 aria-label 切「批量分类进行中」/ spinner 出现）；
 *   U-04 收尾可见提示含「中止 / 额度·限流 / 厂商错误原文」，且不出现「未能为这些任务匹配到合适的分类」；
 *   U-05 结束后忙碌态复位（按钮回到空闲 aria-label、spinner 消失）；
 *   U-06 mock 厂商只收到 1 次请求（30 条目标没有打满）；
 *   U-07 服务端 ai_usage 增量 = 1（与实发一致）。
 *
 * 隔离纪律：临时端口 + 临时 DATA_DIR（D:），空库由服务自建，夹具经 REST 建；
 *   不碰生产实例 39877，不读生产库。Chrome 用系统安装包 + 独立 profile。
 *
 * T02293 批㉚ 改判（判据 3/4）：本门原先把**中文文案锚写进了选择器**——`BTN` 用
 * `/^(AI 批量分类|批量分类进行中)/` 匹配 aria-label，U-01/U-03/U-05 的成败直接由这串措辞决定，
 * U-04 又把「中止 / 额度·限流 / rate limit / 不含『未能为这些任务匹配到合适的分类』」和行为计数串在
 * 同一条 `&&` 里。于是「有人把按钮改名」（等价重构，功能完好）与「批量入口根本没渲染」「熔断失效」
 * 三种情况在结果文件里长得一模一样。现按判据 3 拆 `okPair`（**本门是 `node` 直跑的 `.mjs`，不能引
 * `scripts/lib/anchor-pair.mts` 把整门拖进 tsx，故用同口径本地孪生实现**，与批㉘ t02041、批㉙
 * abi-switch 同一处理）：行为腿只认「按钮在场且可用 / spinner 生命周期 / flash 是否出现 / 厂商实收次数」，
 * 字面腿只认措辞；`BTN` 选择器同时降级为「取值 + 留痕」，取不到时用文案无关的兜底探针点名是漂移还是缺失。
 * 判据 4：PA-01..04 用**本轮真实捕获值**做变异（只改字→落「字面锚点失配（行为在）」、只改行为→落
 * 「行为失守」、两绿→PASS、变异确有对象），拆配对必须自证有牙。
 *
 * 用法：
 *   TMP=/d/code/tmp TEMP=/d/code/tmp node node_modules/tsx/dist/cli.mjs scripts/verify-t02307-ui.mjs
 * 环境变量：T02307_UI_PORT（默认 40138，占用向后扫）、T02307_UI_CDP（默认 9360）、
 *   T02307_UI_CHROME（默认系统 Chrome）、T02307_UI_KEEP=1 保留临时目录。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02307-ui-'));
const LOG_DIR = mkdtempSync(join(TMP_ROOT, 't02307-ui-log-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02307-ui-chrome-'));
const { gateShotsDir, writeGateResults } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const SHOTS = gateShotsDir('t02307-ui');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02307-ui-gate-results.txt';
const PORT_BASE = Number(process.env.T02307_UI_PORT ?? 40138);
const CDP = Number(process.env.T02307_UI_CDP ?? 9360);
const CHROME = process.env.T02307_UI_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0; let skip = 0;
const lines = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; lines.push(`[PASS] ${name}`); console.log(`  [PASS] ${name}`); }
  else {
    fail += 1;
    const tail = extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 400)}` : '';
    lines.push(`[FAIL] ${name}${tail}`); console.log(`  [FAIL] ${name}${tail}`);
  }
};
const skipped = (name, why) => { skip += 1; lines.push(`[SKIP] ${name}（${why}）——不计 PASS`); console.log(`  [SKIP] ${name}（${why}）`); };
const note = (s) => { lines.push(`[INFO] ${s}`); console.log(`  · ${s}`); };

/**
 * `scripts/lib/anchor-pair.mts` 的同口径本地孪生（判据 3）。本门 `node scripts/...mjs` 直跑，
 * 引 `.mts` 会强制整门走 tsx；孪生实现红因文案与共享版逐字一致，改共享版时同步此处。
 */
const probe = (fn) => { try { return { passed: fn() === true }; } catch (e) { return { passed: false, threw: e instanceof Error ? e.message : String(e) }; } };
const okPair = (name, behavior, literal, ctx) => {
  const b = probe(behavior);
  if (!b.passed) return ok(name, false, { 红因: b.threw ? `行为断言抛错：${b.threw}` : '行为失守（功能未达成，与文案无关）', ...(ctx ? { 证据: ctx() } : {}) });
  const l = probe(literal);
  return ok(name, l.passed, l.passed ? undefined : {
    红因: l.threw ? `字面锚点抛错：${l.threw}` : '字面锚点失配（行为在）——等价重构或文案变更，需人工判定改锚还是改码',
    ...(ctx ? { 证据: ctx() } : {}),
  });
};
/** 判据 4：直接按同一口径算出「红因归属」，用于证明拆配对自身有牙（不落账、只判归属） */
const pairVerdict = (behavior, literal) => {
  const b = probe(behavior);
  if (!b.passed) return b.threw ? `行为断言抛错：${b.threw}` : '行为失守（功能未达成，与文案无关）';
  const l = probe(literal);
  return l.passed ? 'PASS'
    : (l.threw ? `字面锚点抛错：${l.threw}` : '字面锚点失配（行为在）——等价重构或文案变更，需人工判定改锚还是改码');
};

/**
 * `--pair-selftest`：只验「拆配对的红因路由」本身（PA-01..05 的逻辑），用**合成夹具**、
 * 不启动服务也不开浏览器。存在的理由：本轮工作树里 `TasksPage.tsx` 引用了尚未入库的
 * `FilePreviewDrawer`，`npm run build`/`vite build` 都编不出 `web/dist`，浏览器腿（含 PA 的活体版）
 * 根本跑不到——没有这条道，拆配对就只是「写下来但从未执行过」的断言。
 * 夹具形态（合成，非产品产物，不冒充实测）：
 *   flash = 收尾提示文本；label = 按钮 aria-label；vendorHits = 熔断在场证据。
 */
if (process.argv.includes('--pair-selftest')) {
  const flash = '批量分类已中止：账户额度/限流（You’ve reached the API rate limit for free users.）';
  const label = 'AI 批量分类';
  const beh4 = () => String(flash).trim().length > 0 && 1 === 1;
  const lit4 = () => flash.includes('中止') && /额度|限流/.test(flash) && !flash.includes('未能为这些任务匹配到合适的分类');
  const beh5 = () => label !== undefined && !label.includes('批量分类进行中');
  const lit5 = () => /^AI 批量分类/.test(label);
  const flashRenamed = flash.replace('中止', '已停');
  const labelRenamed = label.replace(/^AI 批量分类/, '智能分类');
  ok('ST-01 只改文案 → 红因落「字面锚点失配（行为在）」', pairVerdict(beh4, () => flashRenamed.includes('中止')).startsWith('字面锚点失配'), { 红因: pairVerdict(beh4, () => flashRenamed.includes('中止')) });
  ok('ST-02 行为失守（把厂商命中当成 999）→ 红因落「行为失守」，字面腿不参与判定', pairVerdict(() => false, lit4).startsWith('行为失守'), { 红因: pairVerdict(() => false, lit4) });
  ok('ST-03 两绿 → PASS（pair 不是恒红机器）', pairVerdict(beh4, lit4) === 'PASS', { 判定: pairVerdict(beh4, lit4) });
  ok('ST-04 变异确有对象（改字真的动了夹具文本/标签）', flash.includes('中止') && !flashRenamed.includes('中止') && lit5() && !/^AI 批量分类/.test(labelRenamed), { 原: label, 变异: labelRenamed });
  ok('ST-05 措辞漂移专款：按钮在场、只是 aria-label 变了 → 「字面锚点失配」而不是「按钮没渲染」', pairVerdict(beh5, () => /^AI 批量分类/.test(labelRenamed)).startsWith('字面锚点失配'), { 红因: pairVerdict(beh5, () => /^AI 批量分类/.test(labelRenamed)) });
  ok('ST-06 反证 ST-05 不是空转：把「按钮真没渲染」喂进去必须落「行为失守」', pairVerdict(() => false, () => /^AI 批量分类/.test(labelRenamed)).startsWith('行为失守'));
  const s = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  console.log(`\n${s}（pair 自证模式，合成夹具，未启动服务/浏览器）`);
  for (const d of [DATA_DIR, LOG_DIR, CHROME_PROFILE]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 收工 */ } }
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------- mock 厂商：延迟 1.2s 后回 429，制造可观测的忙碌窗口 ----------------
let vendorHits = 0;
const mock = createServer(async (req, res) => {
  vendorHits += 1;
  await sleep(1200);
  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'You’ve reached the API rate limit for free users. Upgrade to a Token Plan.' } }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ---------------- 隔离实例 ----------------
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
let server = null;
let BASE = '';
const serverLog = [];
for (let i = 0; i < 20 && !BASE; i += 1) {
  const port = PORT_BASE + i;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(port), MTask_DATA_DIR: DATA_DIR, MTask_LOG_DIR: LOG_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => serverLog.push(String(b)));
  child.stderr.on('data', (b) => serverLog.push(String(b)));
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 90000) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${base}/api/health`);
      const ct = String(r.headers.get('content-type') ?? '');
      if (r.ok && ct.includes('application/json')) {
        const b = await r.json();
        if (b?.service === 'mtask-server') { up = true; break; }
      }
    } catch { /* 未就绪 */ }
    await sleep(500);
  }
  if (up) { server = child; BASE = base; break; }
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
}

let chrome = null;
const bye = () => {
  if (server?.pid) { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } }
  if (chrome?.pid) { try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } }
};
const cleanup = () => {
  if (process.env.T02307_UI_KEEP) return;
  for (const dir of [DATA_DIR, LOG_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i += 1) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { spawnSync('cmd', ['/c', 'ping', '-n', '2', '127.0.0.1'], { stdio: 'ignore' }); }
    }
  }
};
process.on('exit', bye);
process.on('exit', cleanup);

ok('U-00 隔离实例启动并回 JSON 体检体（临时端口 + 临时库）', Boolean(server && BASE), { BASE, dataDir: DATA_DIR });
if (!server || !BASE) {
  console.log(serverLog.join('').split('\n').slice(-30).join('\n'));
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  const f = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, { port: PORT_BASE, dataDir: DATA_DIR, note: '服务未起' });
  console.log(`\n${summary}\n结果文件：${f}`);
  process.exit(1);
}
note(`隔离实例启动器：${LAUNCHER.label ?? LAUNCHER.exec} · BASE=${BASE}`);

const jfetch = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---------------- 夹具：项目 + 分类 + 30 条未分类任务 + mock 工具（全部走 REST） ----------------
const proj = await jfetch('POST', '/api/projects', { name: `T02307 UI 门 ${Date.now() % 100000}` });
const cat = await jfetch('POST', '/api/task-categories', { name: '开发' });
const toolName = `T02307-ui-mock-${Date.now() % 100000}`;
const tool = await jfetch('POST', '/api/aitools', {
  name: toolName, type: 'openai-compatible', purpose: 'classify',
  endpoint: `${MOCK}/429`, apiKey: 'k', model: 'm', timeoutMs: 8000,
});
let created = 0;
for (let i = 0; i < 30; i += 1) {
  const t = await jfetch('POST', '/api/tasks', { projectId: proj.body?.id, title: `UI 门未分类任务 ${i + 1}`, priority: 'normal' });
  if (t.status === 200 || t.status === 201) created += 1;
}
ok('U-00b 夹具经 REST 建齐（项目 + 分类 + 30 条未分类任务 + mock 429 工具）',
  Boolean(proj.body?.id) && Boolean(cat.body?.id) && Boolean(tool.body?.id) && created === 30,
  { proj: proj.status, cat: cat.status, tool: tool.status, created });

// ---------------- headless Chrome + CDP ----------------
/**
 * 前置件（批㉚ 新增，U-00e）：本门测的是**已构建的前端产物**，`web/dist` 不在就等于「考卷没发」——
 * 直接跑下去，浏览器腿会全红成「行为失守」（本轮实测就是这样：`漂移探针:[]`、页面一个按钮都没有，
 * 而 HEAD 版同形同红），既冤枉产品也冤枉改判。产物缺失按 SKIP 收口并 exit≠0：
 * 「什么都没测」绝不能被读成绿。产物时间戳与 HEAD 提交时间一并留痕，防「拿旧 dist 测新代码」。
 */
const DIST_INDEX = join(ROOT, 'web', 'dist', 'index.html');
const distReady = existsSync(DIST_INDEX);
const distMtime = distReady ? statSync(DIST_INDEX).mtimeMs : 0;
const headCommitMs = Number(spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).stdout.trim() || 0) * 1000;
if (!distReady) {
  skipped('U-00e 前端产物就位', `web/dist/index.html 不在（${DIST_INDEX}）——前置件缺失，不是判据失守`);
  skipped('U-00c..U-07 浏览器腿', 'web/dist 未构建：产物缺失 ≠ 功能失守，先跑 `cd web && npm run build` 再复跑本门（本轮什么都没测，故 exit≠0）');
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  const f = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, { port: Number(BASE.split(':').pop()), dataDir: DATA_DIR, note: 'web/dist 缺失，前置件收口' });
  console.log(`\n${summary}\n结果文件：${f}`);
  process.exit(1);
}
note(`前置件就位：${DIST_INDEX}（构建于 ${new Date(distMtime).toISOString()}，HEAD 提交于 ${new Date(headCommitMs).toISOString()}）`);
if (headCommitMs > 0 && distMtime < headCommitMs) {
  // 旧 dist 上跑浏览器腿＝拿旧考卷判新产品，红绿都不可归因到 HEAD。按判据 2/4 的口径：测不了就 SKIP，
  // 不判 FAIL（否则「谁忘了重新 build」会变成一支恒红门——正是 T02293 要打的那一类）。
  skipped('U-00c..U-07 浏览器腿', 'web/dist 早于 HEAD 提交：产物是旧的，本轮结论不可归因；先跑「cd web && npm run build」再复跑');
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  const f = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, { port: Number(BASE.split(':').pop()), dataDir: DATA_DIR, note: 'web/dist 早于 HEAD，前置件收口' });
  console.log(`\n${summary}\n结果文件：${f}`);
  process.exit(1);
}
ok('U-00c Chrome 可执行文件在场', existsSync(CHROME), CHROME);
if (!existsSync(CHROME)) {
  skipped('U-01..U-07 浏览器腿', '系统 Chrome 缺失');
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  const f = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, { port: Number(BASE.split(':').pop()), dataDir: DATA_DIR, note: 'Chrome 缺失' });
  console.log(`\n${summary}\n结果文件：${f}`);
  process.exit(1);
}
chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  '--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  `--user-data-dir=${CHROME_PROFILE}`, '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = '';
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
    if (r.ok) { const t = (await r.json()).find((x) => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; } }
  } catch { /* Chrome 还在起 */ }
  await sleep(400);
}
ok('U-00d Chrome CDP 通道就绪（系统 Chrome, headless=new）', Boolean(wsUrl), wsUrl);
if (!wsUrl) {
  skipped('U-01..U-07 浏览器腿', 'CDP 通道不可用');
  const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
  const f = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, { port: Number(BASE.split(':').pop()), dataDir: DATA_DIR, note: 'CDP 不可用' });
  console.log(`\n${summary}\n结果文件：${f}`);
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
async function until(expr, ms = 20_000) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) { v = await ev(expr); if (v) return v; await sleep(250); }
  return v;
}
let shotSeq = 0;
async function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const b64 = r.result?.data;
  if (!b64) return '';
  const file = join(SHOTS, `${String(++shotSeq).padStart(2, '0')}-${name}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}
/**
 * 取数表达式（批㉚）：返回按钮的**行为事实**（在场 / 可用 / busy / 计数文本）外加 label 措辞留痕，
 * 并在 aria-label 匹配失效时走「文案无关兜底」（带数字且含「分类」字样的按钮），把
 * `matchedBy` 记进结果——这样「有人改了按钮措辞」与「按钮根本没渲染」不再都是 `null`。
 */
const BTN = `(()=>{const all=[...document.querySelectorAll('button')];const byLabel=all.find(x=>/^(AI 批量分类|批量分类进行中)/.test(x.getAttribute('aria-label')||''));const byText=all.find(x=>/\\d/.test(x.textContent||'')&&/分类/.test((x.getAttribute('aria-label')||'')+(x.textContent||'')));const b=byLabel||byText;if(!b)return{missing:true,alt:all.map(x=>(x.getAttribute('aria-label')||'')+'|'+((x.textContent||'').trim().slice(0,16))).filter(s=>/分类/.test(s)).slice(0,6)};return{label:b.getAttribute('aria-label'),matchedBy:byLabel?'aria-label':'文案无关兜底',disabled:b.disabled,text:(b.textContent||'').trim(),busy:!!b.querySelector('.aispin')}})()`;

await send('Page.enable');
await send('Page.navigate', { url: `${BASE}/?m=0` });
await until(`document.readyState==='complete'`, 25_000);
await sleep(1200);
await ev(`localStorage.setItem('tasks.activeProject', ${JSON.stringify(JSON.stringify(proj.body.id))});localStorage.setItem('tasks.organizeToolId', ${JSON.stringify(JSON.stringify(tool.body.id))});localStorage.setItem('mtask.guide.seen.tasks','1');true`);
await send('Page.reload', { ignoreCache: true });
await sleep(1500);

const ready = await until(`(()=>{const b=${BTN};return b&&!b.missing&&!b.disabled&&b.text.includes('30')&&!b.busy?b:null})()`, 30_000);
// 找不到入口时不能只留 `null`——那正是本批要打掉的「红因不可区分」。补一次文案无关兜底探针：
// 把页面上所有带「分类 / AI」字样的按钮列出来，一眼分辨「措辞漂移」（列表里有）与「真没渲染」（列表为空）。
const driftProbe = ready ? null : await ev(`(()=>{const all=[...document.querySelectorAll('button')];return all.map(x=>(x.getAttribute('aria-label')||'')+'|'+(x.textContent||'').trim().slice(0,24)).filter(s=>/分类|AI/.test(s)).slice(0,12)})()`);
const guide = await ev(`!!document.querySelector('dialog[open]')||[...document.querySelectorAll('[role="dialog"]')].some(d=>/使用向导/.test(d.textContent||''))`);
okPair('U-01 页面就绪：批量分类入口在场且可用、未分类计数=30（行为腿）；按钮措辞符合预期（字面腿）',
  () => Boolean(ready),
  () => /^(AI 批量分类|批量分类进行中)/.test(String(ready?.label ?? '')),
  () => ({ ready, 兜底命中: ready?.matchedBy ?? '(按钮缺失)', 漂移探针: driftProbe }));
ok('U-01b 首访向导未遮挡（已标记 seen，真实用户路径可直接操作工具条）', guide === false, { guide });
const shotBefore = await shot('ready-30-unclassified');
if (ready) {
  // 收尾提示记录器：flash 只存活 2.5s，轮询会漏，改由 MutationObserver 全量留痕
  await ev(`(()=>{window.__gateFlashes=[];const rec=()=>{const o=document.querySelector('output.flash-toast');if(o&&o.textContent&&!window.__gateFlashes.includes(o.textContent))window.__gateFlashes.push(o.textContent);};window.__gateRec=rec;new MutationObserver(rec).observe(document.body,{childList:true,subtree:true,characterData:true});rec();return true})()`);
  const clickLabel = await ev(`(()=>{const all=[...document.querySelectorAll('button')];const x=all.find(y=>/^(AI 批量分类|批量分类进行中)/.test(y.getAttribute('aria-label')||''))||all.find(y=>/\\d/.test(y.textContent||'')&&/分类/.test((y.getAttribute('aria-label')||'')+(y.textContent||'')));if(!x)return'no-button';x.click();return x.getAttribute('aria-label')||x.textContent.trim().slice(0,20)})()`);
  const dlg = await until(`document.querySelector('[aria-label="确定：确认执行该操作"]')?true:null`, 8000);
  okPair('U-02 点击批量入口弹出确认对话框（行为腿：对话框在场）；确认钮措辞未漂移（字面腿）',
    () => Boolean(dlg),
    () => Boolean(clickLabel) && /^AI 批量分类/.test(String(clickLabel)),
    () => ({ clickLabel, dlg }));
  const shotDialog = await shot('confirm-dialog');

  if (dlg) {
    await ev(`document.querySelector('[aria-label="确定：确认执行该操作"]').click();true`);
    let sawBusy = false; let sawSpinner = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      const s = await ev(BTN);
      if (s && String(s.label).includes('批量分类进行中')) sawBusy = true;
      if (s && s.busy) sawSpinner = true;
      if (sawBusy && sawSpinner) break;
      if ((await ev(`window.__gateFlashes.length`)) > 0) break;
      await sleep(120);
    }
    const shotBusy = await shot('batch-busy');
    okPair('U-03 运行期忙碌态可见（行为腿：spinner 在场＝批量循环真在跑；字面腿：aria-label 切「批量分类进行中」）',
      () => sawSpinner, () => sawBusy, () => ({ sawBusy, sawSpinner, shot: shotBusy }));

    const gotFlash = await until(`window.__gateFlashes&&window.__gateFlashes.length>0?window.__gateFlashes:null`, 20_000);
    const flashText = Array.isArray(gotFlash) ? gotFlash[gotFlash.length - 1] : '';
    const shotFlash = await shot('abort-flash');
    okPair('U-04 收尾提示含「中止/额度·限流/厂商原文」，不出现「未能为这些任务匹配到合适的分类」（行为腿：提示真出现且熔断在场＝厂商只收到 1 次）',
      () => String(flashText).trim().length > 0 && vendorHits === 1,
      () => flashText.includes('中止') && /额度|限流/.test(flashText) && flashText.includes('rate limit')
        && !flashText.includes('未能为这些任务匹配到合适的分类'),
      () => ({ flashText, vendorHits, shot: shotFlash }));

    await sleep(700);
    const after = await ev(BTN);
    okPair('U-05 结束后忙碌态复位（行为腿：spinner 消失且按钮重新可用；字面腿：aria-label 回到空闲措辞）',
      () => Boolean(after) && !after.missing && after.busy === false && after.disabled === false,
      () => !String(after?.label ?? '').includes('批量分类进行中') && /^AI 批量分类/.test(String(after?.label ?? '')),
      () => ({ after }));

    ok('U-06 mock 厂商只收到 1 次请求（30 条目标没有打满）', vendorHits === 1, { vendorHits });
    const usage = await jfetch('GET', '/api/ai/usage?days=1');
    const row = (usage.body?.byTool ?? []).find((x) => x.tool_name === toolName && x.kind === 'classify');
    ok('U-07 服务端 ai_usage 增量 = 1（与实发一致）', Number(row?.calls ?? 0) === 1, { row, vendorHits });
    // PA-01..05（判据 4：拆配对自身要有牙——全部拿本轮**真实捕获值**做变异，不动产品代码）
    const beh4 = () => String(flashText).trim().length > 0 && vendorHits === 1;
    const lit4 = () => flashText.includes('中止') && /额度|限流/.test(flashText)
      && !flashText.includes('未能为这些任务匹配到合适的分类');
    const flashRenamed = flashText.replace('中止', '已停');
    const beh5 = () => Boolean(after) && !after.missing && after.busy === false && after.disabled === false;
    const lit5 = () => /^AI 批量分类/.test(String(after?.label ?? ''));
    const labelRenamed = String(after?.label ?? '').replace(/^AI 批量分类/, '智能分类');
    ok('PA-01 拆配对自证：只改文案（等价重构）→ 红因必须是「字面锚点失配（行为在）」',
      pairVerdict(beh4, () => flashRenamed.includes('中止')).startsWith('字面锚点失配'),
      { 红因: pairVerdict(beh4, () => flashRenamed.includes('中止')), flash: String(flashText).slice(0, 100) });
    ok('PA-02 拆配对自证：行为失守（把厂商命中数当成 999）而文案照旧 → 必须是「行为失守」，字面腿根本不参与判定',
      pairVerdict(() => String(flashText).trim().length > 0 && vendorHits === 999, lit4).startsWith('行为失守'),
      { 红因: pairVerdict(() => String(flashText).trim().length > 0 && vendorHits === 999, lit4), vendorHits });
    ok('PA-03 拆配对自证：行为与文案都真 → 必须 PASS（pair 不是恒红机器）',
      pairVerdict(beh4, lit4) === 'PASS', { 判定: pairVerdict(beh4, lit4) });
    ok('PA-04 变异确有对象：改字真的动了本轮捕获的文案/标签（否则反证在测同一份文本＝没测）',
      flashText.includes('中止') && !flashRenamed.includes('中止') && lit5() && !/^AI 批量分类/.test(labelRenamed),
      { flash: String(flashText).slice(0, 60), 原标签: after?.label, 变异标签: labelRenamed });
    ok('PA-05 措辞漂移专款：按钮在场且可用、只是 aria-label 换了 → 必须落「字面锚点失配」而不是「按钮没渲染」',
      pairVerdict(beh5, () => /^AI 批量分类/.test(labelRenamed)).startsWith('字面锚点失配'),
      { 红因: pairVerdict(beh5, () => /^AI 批量分类/.test(labelRenamed)), 取数路径: after?.matchedBy });
    note(`截图：${[shotBefore, shotDialog, shotBusy, shotFlash].filter(Boolean).join(' ; ')}`);
  }
}

// ---------------- 收尾 ----------------
ws.close();
try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
chrome = null;
if (server?.pid) { try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } }
server = null;
mock.closeAllConnections?.();
await new Promise((r) => mock.close(() => r()));

const summary = `PASS=${pass} FAIL=${fail} SKIP=${skip}`;
const resultsFile = writeGateResults(OUT_DIR, OUT_BASE, `${summary}\n${lines.join('\n')}`, {
  port: Number(BASE.split(':').pop()), dataDir: DATA_DIR,
  note: `CDP=${CDP} 夹具=${created} 条未分类任务 mock厂商命中=${vendorHits}`,
});
console.log(`\n${summary}`);
console.log(`结果文件：${resultsFile}`);
process.exit(fail === 0 ? 0 : 1);
