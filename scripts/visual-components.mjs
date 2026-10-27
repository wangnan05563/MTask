/**
 * T03221（PM-302 ②④）组件视觉回归基线：把单源件画出来，逐格比像素哈希。
 *
 * 为什么存在：字号令牌门（T03180）只能证明「源码里写的是令牌」，证明不了「画出来还是那个样」。
 * PM-302 把七处样式常量收编成单源，逐字段取值核对是我自己写的断言——自己判自己不可信，
 * 需要一个与源码无关的观测量：同一格在同一浏览器里的 PNG 字节。
 *
 * 链路：scripts/visual-fixtures/t03221-gallery.tsx --esbuild--> 单页 HTML（注入 settings.tsx 的真实
 * themeCss）--> headless Chrome（CDP）逐格截图 → sha256 → 与 scripts/visual-baselines/*.json 比对。
 *
 * 用法：
 *   node scripts/visual-components.mjs                     # 截图并与基线比对（不一致 exit 1）
 *   node scripts/visual-components.mjs --update            # 重新生成基线（改了设计口径后用）
 *   node scripts/visual-components.mjs --cells button,badge # 只跑指定格（调试用，--update 时须全量）
 *   node scripts/visual-components.mjs --out <dir>         # 截图落盘目录（默认 <tmp>/t03221-shots）
 * 退出码：0 一致 / 1 不一致（点名差异格）/ 2 环境或用法错误。
 *
 * 已知约束：基线与 Chrome 主版本绑定（meta.chrome 记录了取基线时的版本）。换浏览器主版本后
 * 文本次像素会变，比对会全红——那是提示「重新取基线」，不是产品缺陷。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
// 三个可覆盖路径是给验收门做负对照用的：门在临时目录里改主题表/夹具/基线，不碰仓里的原件。
const FIXTURE = resolve(argOf('--fixture') ?? join(ROOT, 'scripts', 'visual-fixtures', 't03221-gallery.tsx'));
const SETTINGS = resolve(argOf('--settings') ?? join(ROOT, 'web', 'src', 'settings.tsx'));
const BASELINE = resolve(argOf('--baseline') ?? join(ROOT, 'scripts', 'visual-baselines', 't03221-pm302-components.json'));
const CELLS = ['button', 'input', 'select', 'badge', 'empty', 'drawer', 'priority'];
const THEMES = ['light', 'dark'];
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const UPDATE = args.includes('--update');
const cells = (argOf('--cells') ?? CELLS.join(',')).split(',').filter((c) => CELLS.includes(c));
const themes = (argOf('--themes') ?? THEMES.join(',')).split(',').filter((t) => THEMES.includes(t));
const OUT = resolve(argOf('--out') ?? join('D:/tmp', 't03221-shots'));
const WORK = join(OUT, 'build');
const CDP_PORT = Number(process.env.T03221_CDP_PORT ?? 0);

const die = (msg, code = 2) => { console.error(`[ERROR] ${msg}`); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 settings.tsx 抠出 themeCss 模板字面量的原文（它是未导出的私有常量，只能按文本取） */
function extractThemeCss() {
  const src = readFileSync(SETTINGS, 'utf8');
  const start = src.indexOf('const themeCss = `');
  if (start < 0) die('settings.tsx 里找不到 `const themeCss = `——主题表改名了，基线注入要跟着改');
  const from = start + 'const themeCss = `'.length;
  const end = src.indexOf('`;', from);
  if (end < 0) die('themeCss 模板字面量没有正常收尾');
  const css = src.slice(from, end);
  if (css.includes('${')) die('themeCss 含插值，纯文本注入不再等价于产品运行时——先解决这个再谈基线');
  for (const probe of ['--app-bg', '--card-bg', '--warn', '--danger', '--fs-m']) {
    if (!css.includes(probe)) die(`themeCss 缺少令牌 ${probe}（主题表面变了，基线不可信）`);
  }
  return css;
}

async function buildBundle() {
  const esbuild = (await import('esbuild')).default ?? (await import('esbuild'));
  mkdirSync(WORK, { recursive: true });
  const js = join(WORK, 'gallery.js');
  await esbuild.build({
    entryPoints: [FIXTURE],
    outfile: js,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    minify: false,
    target: 'es2020',
    absWorkingDir: ROOT,
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [join(ROOT, 'node_modules'), join(ROOT, 'web', 'node_modules')],
    logLevel: 'silent',
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${extractThemeCss()}
/* 截图确定性：冻结动画/过渡/光标闪烁；滚动条由启动开关隐藏 */
*,*::before,*::after{animation:none!important;transition:none!important;}
input,textarea{caret-color:transparent!important}
html,body{margin:0;padding:0;background:#fff}
</style></head><body><div id="root"></div><script src="gallery.js"></script></body></html>`;
  writeFileSync(join(WORK, 'index.html'), html, 'utf8');
  return join(WORK, 'index.html');
}

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  die(`找不到 Chrome/Edge（试过 ${CHROME_CANDIDATES.join(', ')}）；设 CHROME_PATH 指定`);
}

async function launchChrome(bin) {
  const profile = join(OUT, 'profile');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(bin, [
    '--headless=new', CDP_PORT ? `--remote-debugging-port=${CDP_PORT}` : '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--font-render-hinting=none',
    '--disable-lcd-text', '--allow-file-access-from-files', '--window-size=400,600',
    '--disable-features=Translate,BackForwardCache', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((r, j) => {
    let buf = '';
    const timer = setTimeout(() => j(new Error('Chrome 30s 内没报出 DevTools 端口')), 30_000);
    const onData = (d) => {
      buf += String(d);
      const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser/);
      if (m) { clearTimeout(timer); r(Number(m[1])); }
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
    proc.on('exit', (code) => { clearTimeout(timer); j(new Error(`Chrome 提前退出 code=${code}\n${buf.slice(-800)}`)); });
  }).catch((e) => die(e.message));
  return { proc, port };
}

async function connectCdp(port) {
  let wsUrl = '';
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) {
        const targets = await r.json();
        wsUrl = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? '';
      }
    } catch { /* Chrome 还没起好 */ }
    if (!wsUrl) await sleep(300);
  }
  if (!wsUrl) die('拿不到 Chrome page target');
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('CDP 连接失败')); });
  let seq = 0;
  const waiting = new Map();
  const pageErrors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      pageErrors.push(String(d?.exception?.description ?? d?.text ?? '').slice(0, 300));
    }
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++seq;
    waiting.set(id, (msg) => r(msg.error ? { __cdpError: msg.error.message } : msg.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, pageErrors, close: () => { try { ws.close(); } catch { /* */ } } };
}

async function captureCell(cdp, fileUrl, cell, theme) {
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 520, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${fileUrl}?cell=${cell}&theme=${theme}` });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'window.__READY === true', returnByValue: true });
    ready = r?.result?.value === true;
    if (!ready) await sleep(100);
  }
  if (!ready) die(`格子 ${cell}/${theme} 未挂载（__READY 超时）`, 2);
  const box = await cdp.send('Runtime.evaluate', {
    expression: `(() => { const e = document.getElementById('root').firstElementChild; const b = e.getBoundingClientRect();
      return { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(b.height) }; })()`,
    returnByValue: true,
  });
  const clip = box.result.value;
  if (!clip || clip.width < 8 || clip.height < 8) die(`格子 ${cell}/${theme} 量到的盒子异常：${JSON.stringify(clip)}`);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
  if (!shot?.data) die(`格子 ${cell}/${theme} 截图失败：${JSON.stringify(shot?.__cdpError ?? shot)}`);
  const buf = Buffer.from(shot.data, 'base64');
  const key = `${cell}.${theme}`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${key}.png`), buf);
  return { key, sha: createHash('sha256').update(buf).digest('hex'), ...clip, bytes: buf.length };
}

async function browserVersion(cdp) {
  const r = await cdp.send('Browser.getVersion');
  return String(r?.product ?? 'unknown');
}

async function main() {
  if (UPDATE && (cells.length !== CELLS.length || themes.length !== THEMES.length)) {
    die('--update 只允许全量跑（半量基线会让「基线缺格」长期挂红）');
  }
  mkdirSync(OUT, { recursive: true });
  const html = await buildBundle();
  const bin = findChrome();
  const { proc, port } = await launchChrome(bin);
  const cdp = await connectCdp(port);
  const results = [];
  try {
    const chrome = await browserVersion(cdp);
    for (const cell of cells) {
      for (const theme of themes) results.push(await captureCell(cdp, `file:///${html.replace(/\\/g, '/')}`, cell, theme));
    }
    if (cdp.pageErrors.length) die(`夹具运行期有未捕获异常：\n  ${cdp.pageErrors.join('\n  ')}`);
    const got = Object.fromEntries(results.map((r) => [r.key, { sha: r.sha, w: r.w ?? r.width, h: r.h ?? r.height, bytes: r.bytes }]));
    if (UPDATE) {
      const baseline = {
        meta: {
          chrome, generatedAt: new Date().toISOString().slice(0, 10), scale: 1,
          note: 'PM-302 ②：单源件渲染基线。改设计口径后用 `node scripts/visual-components.mjs --update` 重取；比对全红多半是 Chrome 主版本变了。',
        },
        cells: got,
      };
      mkdirSync(dirname(BASELINE), { recursive: true });
      writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
      console.log(`[OK] 基线已更新：${BASELINE}（${results.length} 格，Chrome ${chrome}）`);
      return;
    }
    if (!existsSync(BASELINE)) die(`基线文件不存在：${BASELINE}（先 --update 生成）`, 1);
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const diffs = [];
    for (const [key, g] of Object.entries(got)) {
      const b = baseline.cells?.[key];
      if (!b) diffs.push(`${key}: 基线缺格`);
      else if (b.sha !== g.sha) diffs.push(`${key}: 像素变了\n        基线 ${b.sha.slice(0, 16)} ${b.w}x${b.h}\n        当前 ${g.sha.slice(0, 16)} ${g.w}x${g.h}`);
    }
    for (const key of Object.keys(baseline.cells ?? {})) if (!(key in got)) diffs.push(`${key}: 当前未跑该格`);
    if (diffs.length) {
      console.log(`[FAIL] 视觉回归：${diffs.length} 处差异（截图在 ${OUT}）`);
      for (const d of diffs) console.log(`  ${d}`);
      process.exit(1);
    }
    console.log(`[PASS] 视觉回归：${results.length} 格与基线逐字节一致（Chrome ${chrome} vs 基线 ${baseline.meta.chrome}）`);
  } finally {
    cdp.close();
    proc.kill();
  }
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
