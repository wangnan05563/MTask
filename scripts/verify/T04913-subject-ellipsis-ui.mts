/*
 * T04913 真浏览器 UI 门（自带夹具）：Git 记录标题单行省略 + 悬浮全量显示。
 *
 * 夹具：单仓库工作空间，两条提交——一条 300+ 字符的超长标题（必然截断）、一条短标题。
 * 覆盖：CSS 三件套与真截断、显式降字号与行密度、Tooltip 仅在截断时出现且全文可见、
 * 不拦截点选/展开、三种视口宽度下都不溢出屏幕。
 *
 * 前置：隔离后端 MTask_PORT=39915 MTask_DATA_DIR=<tmp> MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/tsx/dist/cli.mjs scripts/verify/T04913-subject-ellipsis-ui.mts
 * 环境变量：MTASK_UI_BASE / MTASK_CHROME / PW_ROOT
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const SCRATCH = 'D:/tmp/t04913-ui';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s*\r?\n\s*/g, ' | ').slice(0, 240);

const pick = (m: any) => m?.chromium ?? m?.default?.chromium;
let chromium: any = null;
try { chromium = pick(await import('playwright')); } catch { chromium = null; }
if (!chromium) {
  const root = process.env.PW_ROOT || 'D:/code/otherProjects/OcrTools/node_modules/playwright/index.js';
  chromium = pick(await import(pathToFileURL(root).href));
}
if (!chromium) throw new Error('playwright 不可用：请设置 PW_ROOT');

const post = (u: string, b: any) => fetch(BASE + u, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then((r) => r.json());
const patch = (u: string, b: any) => fetch(BASE + u, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then((r) => r.json());

/* ---------- 夹具：根即仓库，1 条超长标题 + 1 条短标题 ---------- */
const LONG = 'T04913 超长提交标题-单行省略与悬浮全量显示-'
  + '修复 Git 树选范围视图在多仓库混合时间线下长文本换行导致的视觉杂乱问题-'.repeat(4)
  + 'ENDING-MARKER-全量可见';
const SHORT = 'short-subject';
const stamp = Date.now();
const ws = path.join(SCRATCH, `ws-${stamp}`);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  fs.mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'config', 'user.email', 't04913@test.local');
  git(ws, 'config', 'user.name', 'T04913 UI Gate');
  git(ws, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(ws, 'f.txt'), 'one\n');
  git(ws, 'add', 'f.txt');
  git(ws, 'commit', '-q', '-m', LONG);
  fs.writeFileSync(path.join(ws, 'f.txt'), 'two\n');
  git(ws, 'add', 'f.txt');
  git(ws, 'commit', '-q', '-m', SHORT);
} catch (e) { console.log(`[FAIL] 夹具自建失败 :: ${why(e)}`); process.exit(1); }

const project: any = await post('/api/projects', { name: `T04913标题省略-${stamp}`, description: '超长标题 + 短标题' });
await patch(`/api/projects/${project.id}`, { workspacePath: ws });
// 「超长」以 A-02 的 scrollWidth/clientWidth 实证为准，这里只守住夹具确实生成了长文本
ok('U-00 夹具：单仓库工作空间含 1 条超长标题与 1 条短标题', !!project.id && LONG.length > 150,
  `longLen=${LONG.length}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const LONG_SEL = '[data-lck="git-tree-subject"][data-full-subject^="T04913"]';
const SHORT_SEL = `[data-lck="git-tree-subject"][data-full-subject="${SHORT}"]`;
const TIP_SEL = '[data-lck="git-tree-subject-tooltip"]';
const textOf = (pg: any, sel: string) => pg.locator(sel).first().innerText().catch(() => '');

async function openPicker() {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  p.on('dialog', (d: any) => d.dismiss().catch(() => {}));
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  await p.evaluate((kv: any) => {
    for (const k of Object.keys(kv)) sessionStorage.setItem(k, JSON.stringify(kv[k]));
  }, { 'report.showGitExtract': true, 'report.showSonarScan': true });
  await p.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), project.id);
  await p.evaluate((keys: string[]) => { for (const k of keys) localStorage.setItem(k, '1'); },
    ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report',
      'mtask.guide.seen.settings', 'mtask.projectGuide.seen', `guide.dismiss.${project.id}`]);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1100);
  await p.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
  await p.waitForTimeout(250);
  await p.locator('nav button.nav-btn[aria-label="AI 工作台"]').first().click({ timeout: 12000 }).catch(async () => {
    await p.evaluate(() => (document.querySelector('nav button.nav-btn[aria-label="AI 工作台"]') as HTMLElement | null)?.click());
  });
  await p.waitForSelector('[data-t03366="git-scope-picker"]', { timeout: 20000 });
  await p.locator('[data-t04595="project-dropdown-trigger"]').first().click({ timeout: 12000 });
  await p.waitForSelector(`input[aria-label="纳入项目 ${project.name}"]`, { timeout: 12000 });
  await p.locator(`input[aria-label="纳入项目 ${project.name}"]`).first().click();
  await p.waitForTimeout(350);
  await p.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 })));
  await p.waitForTimeout(250);
  await p.locator('[data-t04595="git-tree-entry"]').first().click({ timeout: 12000 });
  await p.waitForSelector('[data-lck="git-tree-modal"]', { timeout: 20000 });
  await p.waitForSelector(LONG_SEL, { timeout: 30000 });
  return { ctx, p };
}

try {
  /* ---------- F 组 · 发布新鲜度 ---------- */
  const distAssets = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).filter((f) => f.endsWith('.js'));
  const distJs = distAssets.map((f) => fs.readFileSync(path.join(ROOT, 'web/dist/assets', f), 'utf8')).join('\n');
  ok('F-01 当前 web/dist 含本轮标记 git-tree-subject-tooltip（非旧包假性通过）',
    distJs.includes('git-tree-subject-tooltip') && distJs.includes('git-tree-subject'));

  const { ctx, p } = await openPicker();

  /* ---------- A 组 · 单行省略与视觉层级 ---------- */
  const style = await p.locator(LONG_SEL).evaluate((el: Element) => {
    const s = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    const row = el.closest('[data-lck="git-tree-row"]');
    return {
      textOverflow: s.textOverflow, whiteSpace: s.whiteSpace, overflow: s.overflow,
      fontSize: s.fontSize, fsS: root.getPropertyValue('--fs-s').trim(), fsM: root.getPropertyValue('--fs-m').trim(),
      scrollWidth: (el as HTMLElement).scrollWidth, clientWidth: (el as HTMLElement).clientWidth,
      rowPaddingTop: row ? getComputedStyle(row).paddingTop : '',
    };
  });
  ok('A-01 标题区 CSS 三件套齐备（单行 / 隐藏 / 省略号）',
    style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && style.overflow === 'hidden',
    JSON.stringify({ textOverflow: style.textOverflow, whiteSpace: style.whiteSpace, overflow: style.overflow }));
  ok('A-02 超长标题确实被截断（不是靠短标题蒙混）',
    style.scrollWidth > style.clientWidth + 1, `scroll=${style.scrollWidth} client=${style.clientWidth}`);
  ok('A-03 标题字号显式收敛到 --fs-s，且该档位小于 --fs-m（较原继承字号减小）',
    style.fontSize === style.fsS && parseFloat(style.fsS) < parseFloat(style.fsM),
    JSON.stringify({ fontSize: style.fontSize, fsS: style.fsS, fsM: style.fsM }));
  ok('A-04 行内边距收紧到 2px（提高垂直密度）', style.rowPaddingTop === '2px', `paddingTop=${style.rowPaddingTop}`);
  ok('A-05 全文仍可从 DOM 读取（无障碍/取证兜底，不依赖悬浮）',
    (await p.locator(LONG_SEL).getAttribute('data-full-subject')) === LONG
    && (await p.locator(LONG_SEL).getAttribute('aria-label')) === LONG);

  /* ---------- B 组 · 悬浮全量显示 ---------- */
  ok('B-01 未悬浮时没有 Tooltip', (await p.locator(TIP_SEL).count()) === 0);
  await p.locator(LONG_SEL).hover();
  await p.waitForSelector(TIP_SEL, { timeout: 5000 });
  ok('B-02 悬浮截断标题即出现 Tooltip', (await p.locator(TIP_SEL).count()) === 1);
  const tipText = await textOf(p, TIP_SEL);
  ok('B-03 Tooltip 显示完整标题（含末尾标记，未截断）',
    tipText === LONG && tipText.endsWith('ENDING-MARKER-全量可见'), `tipLen=${tipText.length} longLen=${LONG.length}`);
  const tipStyle = await p.locator(TIP_SEL).evaluate((el: Element) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      position: s.position, pointerEvents: s.pointerEvents, zIndex: s.zIndex, whiteSpace: s.whiteSpace,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      vw: window.innerWidth, vh: window.innerHeight, parentTag: el.parentElement?.tagName ?? '',
    };
  });
  ok('B-04 Tooltip 挂在 body 且 fixed 定位（列表 overflow:auto 裁不到）',
    tipStyle.parentTag === 'BODY' && tipStyle.position === 'fixed', JSON.stringify({ parentTag: tipStyle.parentTag, position: tipStyle.position }));
  ok('B-05 Tooltip 不拦截鼠标且层级高于弹窗',
    tipStyle.pointerEvents === 'none' && parseInt(tipStyle.zIndex, 10) >= 2000,
    JSON.stringify({ pointerEvents: tipStyle.pointerEvents, zIndex: tipStyle.zIndex }));
  ok('B-06 Tooltip 文本可换行（长标题完整铺开）', tipStyle.whiteSpace === 'normal');
  ok('B-07 Tooltip 不溢出视口',
    tipStyle.left >= 0 && tipStyle.right <= tipStyle.vw && tipStyle.top >= 0 && tipStyle.bottom <= tipStyle.vh,
    JSON.stringify({ left: tipStyle.left, right: tipStyle.right, vw: tipStyle.vw, top: tipStyle.top, bottom: tipStyle.bottom, vh: tipStyle.vh }));
  await p.locator('[data-lck="git-tree-modal"] header strong').hover();
  await p.waitForTimeout(150);
  ok('B-08 鼠标移出后 Tooltip 消失', (await p.locator(TIP_SEL).count()) === 0);
  await p.locator(SHORT_SEL).hover();
  await p.waitForTimeout(200);
  ok('B-09 短标题（未截断）悬浮不弹 Tooltip', (await p.locator(TIP_SEL).count()) === 0);

  /* ---------- C 组 · 原有交互逐字不变 ---------- */
  await p.locator(LONG_SEL).hover();
  await p.waitForSelector(TIP_SEL, { timeout: 5000 });
  await p.locator(LONG_SEL).click();
  ok('C-01 Tooltip 显示时点击标题仍可勾选该提交',
    (await textOf(p, '[data-lck="git-tree-selected"]')).includes('已选 1 个提交'),
    await textOf(p, '[data-lck="git-tree-selected"]'));
  await p.locator('[data-lck="git-tree-row"]').filter({ has: p.locator(LONG_SEL) })
    .locator('[data-lck="git-tree-expand"]').click();
  ok('C-02 展开详情按钮仍可用（详情行含完整 SHA）',
    (await p.locator('[data-lck="git-tree-detail"]').count()) === 1
    && (await textOf(p, '[data-lck="git-tree-detail"]')).includes('SHA '));

  /* ---------- D 组 · 不同分辨率一致 ---------- */
  for (const [w, h] of [[1280, 800], [1024, 768]] as const) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(150);
    const s2 = await p.locator(LONG_SEL).evaluate((el: Element) => {
      const s = getComputedStyle(el);
      return { textOverflow: s.textOverflow, whiteSpace: s.whiteSpace,
        scrollWidth: (el as HTMLElement).scrollWidth, clientWidth: (el as HTMLElement).clientWidth };
    });
    ok(`D-${w} 分辨率 ${w}×${h}：仍单行省略且真截断`,
      s2.textOverflow === 'ellipsis' && s2.whiteSpace === 'nowrap' && s2.scrollWidth > s2.clientWidth + 1,
      JSON.stringify(s2));
    await p.locator(LONG_SEL).hover();
    await p.waitForSelector(TIP_SEL, { timeout: 5000 });
    const box = await p.locator(TIP_SEL).evaluate((el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
    });
    ok(`D-${w} 分辨率 ${w}×${h}：Tooltip 仍完整可见且不溢出`,
      (await textOf(p, TIP_SEL)) === LONG && box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh,
      JSON.stringify(box));
  }
  await ctx.close();
} catch (e) {
  fail += 1;
  console.log(`[FAIL] UI 门执行异常 :: ${why(e)}`);
} finally {
  await browser.close();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
