/*
 * T04911 UI 门（真浏览器，自带夹具）：「按仓库分组」模式搜索必须真的过滤/刷新，
 * 且「按时间顺序混合显示」（平铺）模式搜索回归通过、分组结构布局不变。
 *
 * 前置：隔离后端 MTask_PORT=39915 MTask_DATA_DIR=<tmp>/t04911/data MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04911-grouped-search-ui.mts
 * 环境变量：MTASK_UI_BASE / MTASK_CHROME / PW_ROOT
 *
 * 夹具：工作空间根仓库 + 子仓 banks 都有 master 分支且各有 2 条提交（alpha-/beta-/gamma- 前缀），
 * 这样分组视图会默认展开 2 个「仓库 × 分支」窗口，搜索才能落在已加载的窗口上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const SCRATCH = 'D:/tmp/t04911-ui';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s*\r?\n\s*/g, ' | ').slice(0, 260);

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

/* ---------- 夹具 ---------- */
const stamp = Date.now();
const ws = path.join(SCRATCH, `ws-${stamp}`);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const makeRepo = (dir: string, subjects: string[]) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 't04911@test.local');
  git(dir, 'config', 'user.name', 'T04911 Gate');
  git(dir, 'config', 'commit.gpgsign', 'false');
  subjects.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, 'f.txt'), `${s}-${i}\n`);
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', s);
  });
};
try {
  makeRepo(ws, ['alpha-root-one', 'beta-root-two']);
  makeRepo(path.join(ws, 'banks'), ['alpha-banks-one', 'gamma-banks-two']);
} catch (e) { console.log(`[FAIL] 夹具自建失败 :: ${why(e)}`); process.exit(1); }

const project: any = await post('/api/projects', { name: `T04911分组搜索门-${stamp}`, description: '双模式搜索回归夹具' });
await patch(`/api/projects/${project.id}`, { workspacePath: ws });
ok('U-00 夹具：根仓库 + banks 子仓（同为 master，各 2 条提交）', !!project.id);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));
const reqs: string[] = [];
page.on('request', (r: any) => {
  const u = String(r.url());
  if (u.includes('/api/git/log')) reqs.push(u.replace(BASE, ''));
});
const hasReq = (frag: string) => reqs.some((u) => u.includes(frag));
const rows = () => page.locator('button[data-lck="git-tree-select"]').count();
/** 取数是异步的：固定 sleep 会把「还没回来」误判成「过滤无效」，一律按行数条件轮询 */
const waitRows = async (predicate: (n: number) => boolean, tries = 48) => {
  for (let i = 0; i < tries; i += 1) {
    const n = await rows();
    if (predicate(n)) return n;
    await page.waitForTimeout(250);
  }
  return rows();
};
/** 分组视图多窗口并发取数：连续若干次采样行数不变才算稳定，避免把「窗口 A 已回、B 还在路上」当全量 */
const waitStableRows = async (stableNeeded = 3, tries = 60) => {
  let last = -1, stable = 0;
  for (let i = 0; i < tries; i += 1) {
    const n = await rows();
    if (n === last) stable += 1; else { stable = 0; last = n; }
    if (n > 0 && stable >= stableNeeded) return n;
    await page.waitForTimeout(250);
  }
  return rows();
};
const waitReq = async (frag: string, tries = 40) => {
  for (let i = 0; i < tries; i += 1) {
    if (hasReq(frag)) return true;
    await page.waitForTimeout(250);
  }
  return false;
};
const fillSearch = async (term: string) => {
  await page.locator('[data-lck="git-tree-search"]').fill(term);
  await page.waitForTimeout(150);
};

try {
  /* ---------- 发布新鲜度 ---------- */
  const distJs = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'web/dist/assets', f), 'utf8')).join('\n');
  ok('F-01 当前 web/dist 含本轮分组搜索标记（非旧包假性通过）',
    distJs.includes('git-tree-grouped-search') && distJs.includes('请先展开一个'));

  /* ---------- 打开「从 Git 树选范围」 ---------- */
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.evaluate((kv: any) => {
    for (const k of Object.keys(kv)) sessionStorage.setItem(k, JSON.stringify(kv[k]));
  }, { 'report.showGitExtract': true, 'report.showSonarScan': true });
  await page.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), project.id);
  await page.evaluate((keys: string[]) => { for (const k of keys) localStorage.setItem(k, '1'); },
    ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report',
      'mtask.guide.seen.settings', 'mtask.projectGuide.seen', `guide.dismiss.${project.id}`]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1100);
  await page.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
  await page.waitForTimeout(250);
  await page.locator('nav button.nav-btn[aria-label="AI 工作台"]').first().click({ timeout: 12000 }).catch(async () => {
    await page.evaluate(() => (document.querySelector('nav button.nav-btn[aria-label="AI 工作台"]') as HTMLElement | null)?.click());
  });
  await page.waitForSelector('[data-t03366="git-scope-picker"]', { timeout: 20000 });
  await page.locator('[data-t04595="project-dropdown-trigger"]').first().click();
  await page.waitForSelector(`input[aria-label="纳入项目 ${project.name}"]`, { timeout: 12000 });
  await page.locator(`input[aria-label="纳入项目 ${project.name}"]`).first().click();
  await page.waitForTimeout(350);
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 })));
  await page.waitForTimeout(250);
  await page.locator('[data-t04595="git-tree-entry"]').first().click();
  await page.waitForSelector('[data-lck="git-tree-modal"]', { timeout: 20000 });
  await page.waitForTimeout(1200);
  ok('A-01 弹窗打开且默认平铺（T04595 口径）',
    (await page.locator('[data-lck="git-tree-mode-time"]').getAttribute('aria-pressed')) === 'true');

  /* ---------- A 组 · 平铺模式搜索回归 ---------- */
  const flatBefore = await waitRows((n) => n > 0);
  await fillSearch('alpha');
  await page.locator('[data-lck="git-tree-search-btn"]').click();
  const flatSearchReq = await waitReq('search=alpha');
  const flatAfter = await waitRows((n) => n > 0 && n < flatBefore);
  ok('A-02 平铺搜索：点击后发出带 search=alpha 的 /git/log 请求', flatSearchReq);
  ok('A-03 平铺搜索：列表按关键词过滤（行数下降且仍有命中）',
    flatBefore > 0 && flatAfter > 0 && flatAfter < flatBefore, `before=${flatBefore} after=${flatAfter}`);
  await fillSearch('');
  await page.locator('[data-lck="git-tree-search-btn"]').click();
  const flatRestored = await waitRows((n) => n === flatBefore);
  ok('A-04 平铺清空搜索后恢复全量', flatRestored === flatBefore, `rows=${flatRestored} before=${flatBefore}`);

  /* ---------- B 组 · 分组模式搜索（本单主修复） ---------- */
  await page.locator('[data-lck="git-tree-repo-view"]').first().click();
  await page.waitForSelector('[data-lck="git-repo-groups"]', { timeout: 60000 });
  await page.locator('[data-lck="git-repo-scanning"]').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
  // 等默认展开的窗口全部取完数（多窗口并发，行数稳定才算全量）
  const groupedBefore = await waitStableRows();
  const groupCount = await page.locator('[data-lck="git-repo-group"]').count();
  const repoCount = await page.locator('[data-lck="git-repo-repo"]').count();
  ok('B-01 分组视图已加载出「仓库 × 分支」窗口的提交', groupedBefore > 0 && groupCount > 0 && repoCount >= 2,
    `groups=${groupCount} repos=${repoCount} rows=${groupedBefore}`);

  const beforeReqs = reqs.length;
  await fillSearch('alpha');
  await page.locator('[data-lck="git-tree-search-btn"]').click();
  const groupedSearchReq = await waitReq('search=alpha');
  await page.waitForTimeout(1200);
  const hint = await page.locator('[data-lck="git-tree-grouped-search"]').count()
    ? await page.locator('[data-lck="git-tree-grouped-search"]').innerText() : '';
  ok('B-02 分组搜索：点击后有可见反馈（不再是「毫无响应」）',
    hint.includes('alpha') && /[1-9]\d* 个窗口/.test(hint), hint.slice(0, 120));
  ok('B-03 分组搜索：对已加载窗口重新发起带 search=alpha 的 /git/log', groupedSearchReq && reqs.length > beforeReqs,
    `newRequests=${reqs.length - beforeReqs}`);
  const groupedAfter = await waitRows((n) => n > 0 && n < groupedBefore);
  ok('B-04 分组搜索：提交列表按关键词过滤（命中数下降且不为空）',
    groupedAfter > 0 && groupedAfter < groupedBefore, `before=${groupedBefore} after=${groupedAfter}`);
  ok('B-05 分组搜索：分组/仓库结构不变（视觉布局未被改动）',
    (await page.locator('[data-lck="git-repo-group"]').count()) === groupCount
    && (await page.locator('[data-lck="git-repo-repo"]').count()) === repoCount,
    `groups=${groupCount} repos=${repoCount}`);
  const errText = await page.locator('[data-lck="git-tree-error"]').count()
    ? await page.locator('[data-lck="git-tree-error"]').innerText() : '';
  ok('B-06 分组搜索不误报「请先展开窗口」', !/请先展开一个/.test(errText), errText.slice(0, 100));

  await fillSearch('');
  await page.locator('[data-lck="git-tree-search-btn"]').click();
  const groupedRestored = await waitRows((n) => n === groupedBefore);
  ok('B-07 分组清空搜索后窗口恢复全量提交', groupedRestored === groupedBefore,
    `rows=${groupedRestored} before=${groupedBefore}`);

  /* ---------- C 组 · 回车路径与模式切换 ---------- */
  await fillSearch('gamma');
  await page.locator('[data-lck="git-tree-search"]').press('Enter');
  ok('C-01 回车触发分组搜索（键盘路径同样生效）', await waitReq('search=gamma'));
  await page.locator('[data-lck="git-tree-mode-time"]').first().click();
  await page.waitForSelector('[data-lck="git-tree-search-btn"]', { timeout: 15000 });
  let searchEnabled = false;
  for (let i = 0; i < 40; i += 1) {
    if (await page.locator('[data-lck="git-tree-search-btn"]').isEnabled()) { searchEnabled = true; break; }
    await page.waitForTimeout(250);
  }
  ok('C-02 切回平铺后搜索按钮仍可用且分组提示消失',
    searchEnabled && (await page.locator('[data-lck="git-tree-grouped-search"]').count()) === 0,
    `enabled=${searchEnabled}`);
} catch (e) {
  fail += 1;
  console.log(`[FAIL] UI 门执行异常 :: ${why(e)}`);
} finally {
  await browser.close();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
