/**
 * T04577 验收门：任务行 Git 徽标里的三个内层控件在**真实点击**下必须生效。
 *
 * 缺陷（T04547 动画门 A05 取证时发现）：徽标 `<span>` 上挂了原生冒泡阶段的
 * `click → stopPropagation`，而 React 18 的委托监听在更外侧的 `#root`——
 * span 抢先把事件掐断，内层按钮的 React `onClick` 永不派发：
 *   ① 短 SHA 按钮（无远端基址时）不开抽屉 Git 页；
 *   ② 复制完整 SHA 的 CopyButton 不出回执；
 *   ③ 「+N」触发键不开清单浮层。
 *
 * 本门的判据（工单「要做什么」第 1、2 条）：
 *   A 组：真实点击三个控件，各自拿到可观测结果；
 *   B 组：拦截仍在（点徽标非控件区不穿透开抽屉），且已迁到 React 合成事件层——
 *        源码里不再有原生 `addEventListener('click', stop)` 无条件拦截，span 上挂 `onClick`。
 *
 * 前置（R-332：不得用 vite preview）：
 *   1) 先构建：`cd web && D:/code/nodejs24/node.exe ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && D:/code/nodejs24/node.exe ../node_modules/vite/bin/vite.js build`
 *   2) 再起隔离后端：
 *      `MTask_DATA_DIR=D:/tmp/t04577/data MTask_PORT=39908 MTASK_STATIC_DIR=<repo>/web/dist \
 *       D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs server/src/index.ts`
 *   3) 运行：`D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/verify/T04577-git-badge-click.mts`
 *
 * 夹具：临时 git 仓库（**无 remote**，短 SHA 才渲染成按钮而非外链）+ 两个提交；
 * 全程只碰隔离实例与临时目录，不触碰用户生产实例/配置。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39908';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REPO = process.cwd();

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s*\r?\n\s*/g, ' | ').slice(0, 300);
const pick = (m: any) => m?.chromium ?? m?.default?.chromium;
let chromium: any = null;
try { chromium = pick(await import('playwright')); } catch { chromium = null; }
if (!chromium) {
  const root = process.env.PW_ROOT || 'D:/code/otherProjects/OcrTools/node_modules/playwright/index.js';
  chromium = pick(await import(pathToFileURL(root).href));
}

/* ------------------------------ 夹具：无远端的临时仓库 ------------------------------ */
const FIXED_DATE = '2026-01-02T00:00:00+0000';
const runGit = (cwd: string, args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Gate', GIT_AUTHOR_EMAIL: 'gate@example.com', GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_NAME: 'Gate', GIT_COMMITTER_EMAIL: 'gate@example.com', GIT_COMMITTER_DATE: FIXED_DATE,
  },
}).trim();
const wsRepo = mkdtempSync(path.join(os.tmpdir(), 't04577-repo-'));
mkdirSync(wsRepo, { recursive: true });
runGit(wsRepo, ['init', '-q', '-b', 'main']);
runGit(wsRepo, ['config', 'core.autocrlf', 'false']);
writeFileSync(path.join(wsRepo, 'a.txt'), 'one\n', 'utf8');
runGit(wsRepo, ['add', '-A']);
runGit(wsRepo, ['commit', '-q', '-m', 'first']);
const firstSha = runGit(wsRepo, ['rev-parse', 'HEAD']);
writeFileSync(path.join(wsRepo, 'a.txt'), 'two\n', 'utf8');
runGit(wsRepo, ['add', '-A']);
runGit(wsRepo, ['commit', '-q', '-m', 'second']);
const secondSha = runGit(wsRepo, ['rev-parse', 'HEAD']);

const json = async (r: Response) => {
  const x = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(x)}`);
  return x;
};
const post = (url: string, body?: any) => fetch(BASE + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(json);

const stamp = Date.now();
const project = await post('/api/projects', { name: `T04577 徽标点击门-${stamp}`, description: 'Git 徽标内层控件真实点击' });
await fetch(`${BASE}/api/projects/${project.id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspacePath: wsRepo }),
}).then(json);
const task = await post('/api/tasks', { projectId: project.id, title: `T04577 徽标点击任务-${stamp}` });
for (const s of [secondSha, firstSha]) {
  const r = await post(`/api/tasks/${task.id}/git/links`, { sha: s });
  if (!r || r.error) throw new Error(`关联提交失败：${JSON.stringify(r)}`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));

// 使用向导（T00706）首次进入会弹全屏遮罩，命中测试全被吃掉——按 localStorage 已读标记播种
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.evaluate((kv: any) => {
  localStorage.setItem('tasks.activeProject', JSON.stringify(kv.projectId));
  const keys = ['mtask.guide.seen.tasks', 'mtask.guide.seen.aitools', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req',
    'mtask.guide.seen.report', 'mtask.guide.seen.history', 'mtask.guide.seen.queue', 'mtask.guide.seen.exec-sessions',
    'mtask.guide.seen.settings', 'mtask.projectGuide.seen', `guide.dismiss.${kv.projectId}`];
  for (const k of keys) localStorage.setItem(k, '1');
}, { projectId: project.id });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(() => document.querySelector('button[aria-label="跳过"]')?.click());
await page.waitForTimeout(300);

/* ------------------------------ A 组：三个控件真实点击 ------------------------------ */
try {
  // 工具条控件默认 op-hidden（悬浮/聚焦才显形）——只要挂上 DOM 就够；开关态已开时不必再点
  await page.waitForSelector('[data-t03343="git-toggle"]', { state: 'attached', timeout: 20000 });
  if ((await page.locator('[data-t03343="git-toggle"]').getAttribute('aria-pressed')) !== 'true') {
    await page.evaluate(() => document.querySelectorAll('.op-host').forEach((h) => h.classList.add('op-force')));
    await page.locator('[data-t03343="git-toggle"]').click({ timeout: 8000 });
    await page.waitForTimeout(800);
  }
  await page.waitForSelector('[data-t03343="git-badge"]', { state: 'attached', timeout: 25000 });
  ok('A-00 夹具就绪：任务行出现 Git 徽标（2 条关联提交）',
    (await page.locator('[data-t03343="git-badge"]').count()) > 0);
  // 徽标内控件随任务行显隐（未悬浮时 visibility:hidden / op-hidden）——真点击前先悬浮它自己的行
  const revealRow = async () => {
    await page.locator('li.task-item').first().hover({ timeout: 8000 });
    await page.waitForTimeout(300);
  };

  // ① 短 SHA 按钮 → 打开抽屉 Git 页。无 remote 时它才是 <button>（有基址会渲染成外链，不属本判据）
  const shortBtn = page.locator('[data-t03343="git-badge"] button[aria-label*="来源"]').first();
  const shortIsButton = (await shortBtn.count()) > 0;
  ok('A-01 短 SHA 在无远端基址时渲染为按钮（外链形态不参与本判据）', shortIsButton,
    shortIsButton ? '' : '未找到短 SHA 按钮（夹具仓库不应有 remote）');
  if (shortIsButton) {
    await revealRow();
    await shortBtn.click({ timeout: 8000 });
    let opened = false;
    try {
      await page.waitForSelector('[data-t03362="commit-card"]', { timeout: 12000 });
      opened = true;
    } catch { opened = false; }
    ok('A-02 点短 SHA → 抽屉打开并落在 Git 页（事件不再被徽标抢走）', opened,
      opened ? '' : `当前 URL=${page.url()} 抽屉存在=${await page.locator('[aria-label^="展开详情抽屉"]').count()}`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }

  // ② 复制完整 SHA → 回执（CopyButton 把 aria-label 追加「（已复制）」并改 title）
  const copyBtn = page.locator('[data-t03343="git-badge"] [aria-label^="复制提交 "]').first();
  await revealRow();
  await copyBtn.click({ timeout: 8000 });
  await page.waitForTimeout(350);
  const copyLabel = await copyBtn.getAttribute('aria-label').catch(() => '');
  const copyTitle = await copyBtn.getAttribute('title').catch(() => '');
  ok('A-03 点复制完整 SHA → 出「已复制」回执（点击真实派发到 React handler）',
    /（已复制）/.test(copyLabel ?? '') || copyTitle === '已复制', `aria-label=${copyLabel} title=${copyTitle}`);

  // ③ 「+N」触发键 → 清单浮层（portal 到 body 的 dialog）与 2 条行
  const more = page.locator('[data-t03343="git-more"]').first();
  await revealRow();
  await more.click({ timeout: 8000 });
  const dlg = '[aria-label$="的全部关联提交"]';
  let popRows = 0;
  try {
    await page.waitForSelector(dlg, { state: 'attached', timeout: 12000 });
    await page.waitForSelector('[data-t03343="git-popover-row"]', { timeout: 12000 });
    popRows = await page.locator('[data-t03343="git-popover-row"]').count();
  } catch { popRows = 0; }
  ok('A-04 点「+N」→ 清单浮层打开且列出全部关联提交', popRows === 2, `git-popover-row=${popRows}`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  // ④ 原意不回退：点徽标非控件区不穿透到任务行（否则会莫名打开抽屉）
  const badge = page.locator('[data-t03343="git-badge"]').first();
  await badge.evaluate((el: Element) => (el as HTMLElement).click());
  await page.waitForTimeout(600);
  const drawerOpen = await page.locator('[data-t03362="git-tab"]').count();
  ok('A-05 点徽标非控件区不穿透开抽屉（整块拦截的原意保留）', drawerOpen === 0, `git-tab=${drawerOpen}`);
} catch (e) {
  fail++;
  console.log(`FAIL A 组执行异常 :: ${why(e)}`);
} finally {
  await browser.close().catch(() => {});
}

/* ------------------------------ B 组：拦截位置守卫（源码） ------------------------------ */
const badgeSrc = readFileSync(path.join(REPO, 'web/src/ui/gitBadge.tsx'), 'utf8');
ok('B-01 原生无条件 click→stopPropagation 已移除（不再抢 React 委托）',
  !/addEventListener\(\s*'click'\s*,\s*stop\s*\)/.test(badgeSrc), 'gitBadge.tsx');
ok('B-02 徽标 span 上挂 React onClick 拦截', /data-t03343="git-badge"[\s\S]{0,240}onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(badgeSrc),
  'data-t03343="git-badge" 附近未找到 onClick={(e) => e.stopPropagation()}');

console.log(`\nPASS=${pass} FAIL=${fail}`);
try { rmSync(wsRepo, { recursive: true, force: true }); } catch { /* 清理失败不改变结论 */ }
process.exit(fail === 0 ? 0 : 1);
