/*
 * T04912 真浏览器 UI 门（自带夹具）：「按时间顺序混合显示」把工作空间内所有仓库的提交
 * 按作者时间交织成一条时间线，每行带来源仓库标识；确认仍守「一次只回传一个仓库」红线。
 *
 * 夹具：根非仓库工作空间含 banks / deploy / grp/sub/deep 三个子仓库，各提交按日期刻意交错；
 * 另有「根即仓库」单仓库工作空间验兼容降级。提交日期用 GIT_AUTHOR_DATE/GIT_COMMITTER_DATE
 * 固定，服务端 %aI 才能给出可断言的跨仓库时间序。
 *
 * 前置：隔离后端 MTask_PORT=39915 MTask_DATA_DIR=<tmp> MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/tsx/dist/cli.mjs scripts/verify/T04912-mixed-timeline-ui.mts
 * 环境变量：MTASK_UI_BASE / MTASK_CHROME / PW_ROOT
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const SCRATCH = 'D:/tmp/t04912-ui';

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

/* ---------- 夹具 ---------- */
const stamp = Date.now();
const ws = path.join(SCRATCH, `ws-${stamp}`);
const wsRoot = path.join(SCRATCH, `root-${stamp}`);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitAt = (cwd: string, date: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
});
const D = (day: number) => `2026-01-0${day} 09:00:00 +0800`;
const makeRepo = (dir: string, branch: string, label: string, stamps: { date: string; subject: string }[]) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 't04912@test.local');
  git(dir, 'config', 'user.name', 'T04912 UI Gate');
  git(dir, 'config', 'commit.gpgsign', 'false');
  stamps.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, 'f.txt'), `${label}-${i}-${s.subject}\n`);
    git(dir, 'add', 'f.txt');
    gitAt(dir, s.date, 'commit', '-q', '-m', s.subject);
  });
  git(dir, 'remote', 'add', 'origin', `https://example.com/${label}.git`);
};
try {
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'x.md'), 'not a repo\n');
  makeRepo(path.join(ws, 'banks'), 'dev', 'banks', [
    { date: D(1), subject: 'banks-old' }, { date: D(3), subject: 'banks-new' },
  ]);
  makeRepo(path.join(ws, 'deploy'), 'main', 'deploy', [
    { date: D(2), subject: 'deploy-old' }, { date: D(4), subject: 'deploy-new' },
  ]);
  makeRepo(path.join(ws, 'grp', 'sub', 'deep'), 'feat', 'deep', [
    { date: D(5), subject: 'deep-new' },
  ]);
  makeRepo(wsRoot, 'main', 'rootrepo', [{ date: D(6), subject: 'root-only' }]);
} catch (e) { console.log(`[FAIL] 夹具自建失败 :: ${why(e)}`); process.exit(1); }

// 项目名不要含「混合」：底部标注会带项目名，否则「不再写混合」的回退断言被夹具名自己命中
const projectA: any = await post('/api/projects', { name: `T04912多仓时间线-${stamp}`, description: '根非仓库 + 3 个子仓库交错提交' });
await patch(`/api/projects/${projectA.id}`, { workspacePath: ws });
const projectB: any = await post('/api/projects', { name: `T04912单仓库兼容-${stamp}`, description: '根即仓库' });
await patch(`/api/projects/${projectB.id}`, { workspacePath: wsRoot });
ok('U-00 夹具：多仓库与单仓库两个工作空间已绑定', !!projectA.id && !!projectB.id);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const reqs: string[] = [];
const attrOf = (pg: any, sel: string, name: string) => pg.locator(sel).first().getAttribute(name).catch(() => null);
const textOf = (pg: any, sel: string) => pg.locator(sel).first().innerText().catch(() => '');
const hasReq = (frag: string) => reqs.some((u) => u.includes(frag));
const rowCount = (pg: any) => pg.locator('button[data-lck="git-tree-select"]').count();
/** 混合取数要等 /git/repos + N 个 /git/log 全部回来，固定 sleep 会把「还没回来」误判成功能失败 */
const waitRows = async (pg: any, predicate: (n: number) => boolean, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    const n = await rowCount(pg);
    if (predicate(n)) return n;
    await pg.waitForTimeout(250);
  }
  return rowCount(pg);
};
const subjectsOf = (pg: any) => pg.locator('button[data-lck="git-tree-select"]').evaluateAll(
  (els: Element[]) => els.map((e) => (e.getAttribute('aria-label') ?? '').split('：').slice(1).join('：')));

/** 真实用户路径：AI 工作台 → Git 提取卡 → 勾选项目 → 从 Git 树选范围 */
async function openPicker(project: any) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  p.on('dialog', (d: any) => d.dismiss().catch(() => {}));
  p.on('request', (r: any) => {
    const u = String(r.url());
    if (u.includes('/api/git/repos') || u.includes('/api/git/log')) reqs.push(u.replace(BASE, ''));
  });
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
  return { ctx, p };
}

try {
  /* ---------- F 组 · 发布新鲜度 ---------- */
  const distAssets = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).filter((f) => f.endsWith('.js'));
  const distJs = distAssets.map((f) => fs.readFileSync(path.join(ROOT, 'web/dist/assets', f), 'utf8')).join('\n');
  ok('F-01 当前 web/dist 含本轮标记 git-tree-repo-tag / git-tree-mix-repos（非旧包假性通过）',
    distJs.includes('git-tree-repo-tag') && distJs.includes('git-tree-mix-repos'));

  /* ---------- A 组 · 默认混合时间线 ---------- */
  const { ctx, p } = await openPicker(projectA);
  await p.waitForSelector('[data-lck="git-tree-mix-repos"]', { timeout: 30000 });
  await waitRows(p, (n) => n >= 5);
  ok('A-01 默认仍是「按时间顺序混合显示」（T04595 裁决未被反转）',
    (await attrOf(p, '[data-lck="git-tree-mode-time"]', 'aria-pressed')) === 'true'
    && (await attrOf(p, '[data-lck="git-tree-repo-view"]', 'aria-pressed')) === 'false');
  ok('A-02 打开弹窗即请求 /git/repos（进入模式前先列全仓库）', hasReq('/api/git/repos'));
  ok('A-03 「混合全部仓库」默认开启',
    (await p.locator('[data-lck="git-tree-mix-repos"] input').isChecked()) === true);
  ok('A-04 自动逐仓库取数：banks / deploy / 三级嵌套 grp/sub/deep 各发一次 /git/log',
    hasReq('repoSub=banks') && hasReq('repoSub=deploy') && hasReq('repoSub=grp%2Fsub%2Fdeep'));
  const n5 = await rowCount(p);
  ok('A-05 三个仓库的 5 条提交同屏显示（不再是只显示根目录仓库）', n5 === 5, `rows=${n5}`);
  ok('A-06 每行都带来源仓库标识',
    (await p.locator('[data-lck="git-tree-repo-tag"]').count()) === 5);
  const order = await subjectsOf(p);
  ok('A-07 严格按 Git 作者时间交织（跨仓库不按仓库分块堆叠、无时间跳跃）',
    order.join(',') === 'deep-new,deploy-new,banks-new,deploy-old,banks-old', order.join(','));
  const tagSubs = await p.locator('[data-lck="git-tree-repo-tag"]').evaluateAll(
    (els: Element[]) => els.map((e) => e.getAttribute('data-repo-sub') ?? ''));
  ok('A-08 标识的坐标与提交所属仓库一致（3 个仓库都出现）',
    new Set(tagSubs).size === 3 && tagSubs.includes('banks') && tagSubs.includes('deploy') && tagSubs.includes('grp/sub/deep'),
    JSON.stringify(tagSubs));
  ok('A-09 长仓库名用 title 显示全称（无需右键查询）',
    ((await p.locator('[data-lck="git-tree-repo-tag"][data-repo-sub="grp/sub/deep"]').first().getAttribute('title')) ?? '')
      .includes('grp/sub/deep'));
  ok('A-10 底部标注说明正在混合几个仓库', (await textOf(p, '[data-lck="git-tree-selected"]')).includes('混合 3 个仓库'),
    await textOf(p, '[data-lck="git-tree-selected"]'));
  ok('A-11 混合视图给出「每仓库各取一页」提示且不显示跨仓库加载更多',
    (await p.locator('[data-lck="git-tree-mixed-hint"]').count()) === 1
    && (await p.locator('[data-lck="git-tree-load-more"]').count()) === 0);

  /* ---------- B 组 · 混合模式搜索仍生效 ---------- */
  const beforeSearch = await rowCount(p);
  await p.locator('[data-lck="git-tree-search"]').fill('banks');
  await p.locator('[data-lck="git-tree-search-btn"]').click();
  await waitRows(p, (n) => n === 2);
  ok('B-01 混合搜索逐个仓库带 search= 取数', hasReq('search=banks'));
  ok('B-02 搜索结果只剩命中仓库的提交且仍带来源标识',
    (await rowCount(p)) === 2 && (await p.locator('[data-lck="git-tree-repo-tag"][data-repo-sub="banks"]').count()) === 2,
    `before=${beforeSearch} after=${await rowCount(p)}`);
  await p.locator('[data-lck="git-tree-search"]').fill('');
  await p.locator('[data-lck="git-tree-search-btn"]').click();
  await waitRows(p, (n) => n === 5);
  ok('B-03 清空搜索恢复全量混合时间线', (await rowCount(p)) === 5);

  /* ---------- C 组 · 一次确认只回传一个仓库（红线） ---------- */
  await p.locator('button[data-lck="git-tree-select"][aria-label*="deep-new"]').first().click();
  await p.locator('button[data-lck="git-tree-select"][aria-label*="banks-new"]').first().click();
  await p.locator('[data-lck="git-tree-confirm"]').click();
  ok('C-01 勾选跨仓库提交时明确拒绝，不做假的跨仓库合并',
    (await textOf(p, '[data-lck="git-tree-error"]')).includes('一次确认只能回传一个仓库')
    && (await p.locator('[data-lck="git-tree-modal"]').count()) === 1,
    await textOf(p, '[data-lck="git-tree-error"]'));
  await p.locator('button[data-lck="git-tree-select"][aria-label*="banks-new"]').first().click();
  await p.locator('[data-lck="git-tree-confirm"]').click();
  await p.locator('[data-lck="git-tree-modal"]').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  ok('C-02 只勾一个仓库时确认成功（回传该仓库坐标，弹窗关闭）',
    (await p.locator('[data-lck="git-tree-modal"]').count()) === 0);
  await ctx.close();

  /* ---------- D 组 · 关闭混合逐字回到单仓库口径 ---------- */
  const second = await openPicker(projectA);
  await second.p.waitForSelector('[data-lck="git-tree-mix-repos"]', { timeout: 30000 });
  await second.p.locator('[data-lck="git-tree-mix-repos"] input').uncheck();
  await waitRows(second.p, (n) => n > 0 && n < 5);
  ok('D-01 关闭混合后回到单仓库取数（行数 < 混合全量）', (await rowCount(second.p)) < 5,
    `rows=${await rowCount(second.p)}`);
  ok('D-02 单仓库视图不再渲染来源仓库标识', (await second.p.locator('[data-lck="git-tree-repo-tag"]').count()) === 0);
  const backText = await textOf(second.p, '[data-lck="git-tree-selected"]');
  ok('D-03 底部标注不再写「混合 N 个仓库」', !/混合\s*\d+\s*个仓库/.test(backText), backText);
  await second.p.selectOption('[data-lck="git-tree-repo-select"]', 'deploy');
  await waitRows(second.p, (n) => n === 2);
  ok('D-04 切到另一个仓库仍能逐仓库取数（T04586 选择器未被破坏）',
    (await rowCount(second.p)) === 2 && hasReq('repoSub=deploy'));
  await second.ctx.close();

  /* ---------- E 组 · 单仓库工作空间优雅降级 ---------- */
  const third = await openPicker(projectB);
  await third.p.waitForSelector('[data-lck="git-tree-repo-select"]', { timeout: 30000 });
  await waitRows(third.p, (n) => n > 0);
  ok('E-01 只有 1 个仓库时不显示混合开关（无子仓库不报错、不多余控件）',
    (await third.p.locator('[data-lck="git-tree-mix-repos"]').count()) === 0);
  ok('E-02 单仓库仍正常加载提交且不带来源标识',
    (await rowCount(third.p)) > 0 && (await third.p.locator('[data-lck="git-tree-repo-tag"]').count()) === 0);
  ok('E-03 单仓库不按子仓库坐标取数（旧请求串不变）',
    !reqs.some((u) => u.includes(`projectId=${projectB.id}`) && u.includes('repoSub=')));
  await third.ctx.close();
} catch (e) {
  fail += 1;
  console.log(`[FAIL] UI 门执行异常 :: ${why(e)}`);
} finally {
  await browser.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(wsRoot, { recursive: true, force: true });
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
