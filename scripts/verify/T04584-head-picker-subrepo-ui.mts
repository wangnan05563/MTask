/*
 * T04584 验收门：Git 树选范围「起点分支输入框」真浏览器查询子目录仓库分支。
 *
 * 工单锚定词（R-318，均为本仓真实存在的路径/词形）：
 *   scripts/verify/T04584-head-picker-subrepo-ui.mts
 *   web/src/ui/GitTreePickerModal.tsx  web/src/ui/GitScopeControls.tsx  web/src/utils/scopeControls.ts
 *   data-lck="git-tree-head"  data-ref-sub  branchOptionsFromCensus  flatRepoSub  git.scope
 *   子目录  子仓库  banks  deploy  BEMP5.0DEV
 *
 * 前置：隔离后端 MTask_DATA_DIR=<tmp>/data MTask_PORT=39909 MTASK_STATIC_DIR=<repo>/web/dist；
 *   夹具工作空间 <tmp>/ws 含根仓库（master/root-only）+ 子仓库 banks（banks-feature）+ deploy（deploy-feature）。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04584-head-picker-subrepo-ui.mts
 *
 * 三组：
 *   A 组 展开起点输入框 → 懒普查 → 候选里真出现子仓库分支（带 data-ref-sub 标注），根仓库候选无标注；
 *      同名 master 跨根/banks/deploy 三条不互相覆盖；banks-feature 是根仓库没有的分支（证明真扫了子仓库）。
 *   B 组 选中 banks-feature → 平铺取数请求带 repoSub=banks、列表渲染 banks 的提交、确认后 git.scope
 *      的 repoSubByProject 落 banks（子仓库选择不会被当根仓库下发）。
 *   C 组 发布新鲜度：当前 dist 含 data-ref-sub 与起点输入框 placeholder（重打包已带本轮修复）。
 *   取不到控件/普查未回时显式 BLOCKED 并注明触发条件，绝不静默跳过。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39909';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WS = process.env.MTASK_T04584_WS || 'D:/tmp/t04584/ws';
const REPO = process.cwd();
const SHOT = (n: string) => path.join(os.tmpdir(), `t04584-${n.replace(/[^\w]+/g, '-').slice(0, 60)}.png`);

let pass = 0, fail = 0, blocked = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const blockedSite = (name: string, reason: string) => { blocked++; console.log(`BLOCKED ${name} :: 触发条件=${reason}`); };
const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s*\r?\n\s*/g, ' | ').slice(0, 300);

const pick = (m: any) => m?.chromium ?? m?.default?.chromium;
let chromium: any = null;
try { chromium = pick(await import('playwright')); } catch { chromium = null; }
if (!chromium) {
  const root = process.env.PW_ROOT || 'D:/code/otherProjects/OcrTools/node_modules/playwright/index.js';
  chromium = pick(await import(pathToFileURL(root).href));
}
if (!chromium) throw new Error('playwright 不可用：请设置 PW_ROOT 指向 playwright 安装入口');

const json = async (r: Response) => {
  const x = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(x)}`);
  return x;
};
const post = (url: string, body?: any) => fetch(BASE + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(json);
const patch = (url: string, body?: any) => fetch(BASE + url, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(json);

/* ---------- 夹具：一个绑定到嵌套仓库工作空间的项目 ---------- */
const stamp = Date.now();
const list: any[] = await (await fetch(`${BASE}/api/projects`)).json();
let project = list.find((p) => p.name.startsWith('T04584 子仓库门'));
if (!project) project = await post('/api/projects', { name: `T04584 子仓库门项目-${stamp}`, description: '起点分支输入框查子目录分支 UI 门夹具' });
await patch(`/api/projects/${project.id}`, { workspacePath: WS });

/* ---------- 浏览器 ---------- */
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));
const gitLogUrls: string[] = [];
page.on('request', (r: any) => { const u = r.url(); if (u.includes('/git/log')) gitLogUrls.push(u); });

async function navToReport() {
  const sel = 'nav button.nav-btn[aria-label="AI 工作台"]';
  try { await page.locator(sel).click({ timeout: 6000 }); }
  catch {
    const done = await page.evaluate((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return false; el.click(); return true;
    }, sel);
    if (!done) throw new Error(`页签按钮不存在：${sel}`);
  }
  await page.waitForTimeout(700);
}
const clickPrep = async (selector: string, timeout = 8000) => {
  try { await page.locator(selector).first().click({ timeout }); }
  catch {
    const done = await page.evaluate((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return false; el.click(); return true;
    }, selector);
    if (!done) throw new Error(`前置控件不存在：${selector}`);
    await page.waitForTimeout(400);
  }
};

/* ---------- 会话态预置 + 向导已读 ---------- */
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.evaluate((kv: any) => {
  for (const k of Object.keys(kv)) sessionStorage.setItem(k, JSON.stringify(kv[k]));
}, { 'report.showGitExtract': true });
await page.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), project.id);
await page.evaluate((keys: string[]) => {
  for (let i = 0; i < keys.length; i += 1) localStorage.setItem(keys[i], '1');
}, ['mtask.guide.seen.tasks', 'mtask.guide.seen.report', 'mtask.guide.seen.settings',
  'mtask.projectGuide.seen', `guide.dismiss.${project.id}`]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
await page.waitForTimeout(300);

/** 打开 Git 树弹窗并落到平铺单仓库视图，再展开起点输入框候选（触发懒普查） */
async function openHeadPicker() {
  await navToReport();
  await page.waitForSelector('[data-t03366="git-scope-picker"]', { timeout: 20000 });
  // T04595：项目多选改下拉条，先展开触发钮再勾选项目复选项
  await clickPrep('[data-t04595="project-dropdown-trigger"]');
  await page.waitForTimeout(250);
  await clickPrep(`input[aria-label^="纳入项目 T04584"]`);
  await page.waitForTimeout(500);
  await clickPrep('[data-t04553="open"]');
  await page.waitForSelector('[data-lck="git-tree-modal"]', { timeout: 20000 });
  await page.waitForSelector('[data-lck="git-tree-repo-view"]', { timeout: 20000 });
  if ((await page.locator('[data-lck="git-tree-repo-view"]').getAttribute('aria-pressed')) === 'true') {
    await clickPrep('[data-lck="git-tree-repo-view"]');
    await page.waitForTimeout(500);
  }
  await clickPrep('[data-lck="git-tree-head-toggle"]');
  // 普查回包后子仓库候选才出现；等不到则 BLOCKED（不静默跳过）
  await page.waitForSelector('[data-lck="git-tree-head-option"][data-ref-sub="banks"]', { timeout: 25000 });
}

/* ---------- A 组：候选里真出现子仓库分支 ---------- */
try {
  await openHeadPicker();
  const opts = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-lck="git-tree-head-option"]'));
    return nodes.map((n) => ({
      ref: n.getAttribute('data-ref'), sub: n.getAttribute('data-ref-sub'),
      type: n.getAttribute('data-ref-type'), title: n.getAttribute('title'), text: (n.textContent || '').trim(),
    }));
  });
  const banksFeat = opts.find((o) => o.ref === 'banks-feature' && o.sub === 'banks');
  const deployFeat = opts.find((o) => o.ref === 'deploy-feature' && o.sub === 'deploy');
  const rootMaster = opts.find((o) => o.ref === 'master' && !o.sub);
  const masters = opts.filter((o) => o.ref === 'master');
  const rootOnly = opts.find((o) => o.ref === 'root-only' && !o.sub);
  ok('A-01 起点候选含子仓库 banks 的 banks-feature（带 data-ref-sub=banks）', !!banksFeat, JSON.stringify(banksFeat ?? null));
  ok('A-02 起点候选含子仓库 deploy 的 deploy-feature（带 data-ref-sub=deploy）', !!deployFeat, JSON.stringify(deployFeat ?? null));
  ok('A-03 根仓库 master 候选无仓库标注（外观与改造前一致）', !!rootMaster, JSON.stringify(rootMaster ?? null));
  ok('A-04 同名 master 跨根/banks/deploy 三条候选不互相覆盖', masters.length >= 3 && new Set(masters.map((o) => o.sub ?? '')).size >= 3, JSON.stringify(masters.map((o) => o.sub)));
  ok('A-05 banks-feature 是根仓库没有的分支却出现在候选（证明真扫了子仓库，非恒绿）', !!banksFeat, '根仓库仅 master/root-only');
  ok('A-06 子仓库候选 title 带仓库标注「· banks」', !!banksFeat && (banksFeat.title || '').includes('· banks'), JSON.stringify(banksFeat?.title ?? null));
  ok('A-07 根仓库独有 root-only 候选无 sub 标注（负控制：标注只挂子仓库）', !!rootOnly, JSON.stringify(rootOnly ?? null));
  await page.screenshot({ path: SHOT('head-picker-menu') }).catch(() => {});

  /* ---------- B 组：选中子仓库分支 → 真按该仓库取数 + 确认回传 repoSub ---------- */
  await clickPrep('[data-lck="git-tree-head-option"][data-ref-sub="banks"][data-ref="banks-feature"]');
  await page.waitForTimeout(600);
  // 确保落在平铺视图（多仓库入口默认开聚合；若仍在聚合则切回平铺，提交行才直接渲染）
  const pressedAfterPick = await page.locator('[data-lck="git-tree-repo-view"]').getAttribute('aria-pressed');
  if (pressedAfterPick === 'true') { await clickPrep('[data-lck="git-tree-repo-view"]'); await page.waitForTimeout(600); }
  try { await page.waitForSelector('button[data-lck="git-tree-select"]:has-text("T04584-banks-commit")', { timeout: 15000 }); }
  catch { /* 下面断言会如实记 FAIL/BLOCKED */ }
  const headVal = await page.evaluate(() => (document.querySelector('input[data-lck="git-tree-head"]') as HTMLInputElement | null)?.value ?? null);
  ok('B-01 选中后起点输入框回填 banks-feature', headVal === 'banks-feature', `head=${headVal}`);
  const banksReq = gitLogUrls.filter((u) => u.includes('repoSub=banks') && u.includes('head=banks-feature'));
  ok('B-02 平铺取数请求带 head=banks-feature&repoSub=banks（不再恒按根仓库取数）', banksReq.length > 0,
    `匹配=${banksReq.slice(-1)[0] ?? '无'} | 最近repoSub=banks请求=${gitLogUrls.filter((u) => u.includes('repoSub=banks')).slice(-1)[0] ?? '无'} | pressed=${pressedAfterPick}`);
  const rowsText = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('button[data-lck="git-tree-select"]'));
    return rows.map((r) => r.textContent || '').join('\n');
  });
  const emptyText = await page.evaluate(() => (document.querySelector('[data-lck="git-tree-empty"]')?.textContent || ''));
  ok('B-03 平铺列表渲染出 banks 子仓库的提交 T04584-banks-commit', rowsText.includes('T04584-banks-commit'),
    `rows=${rowsText.slice(0, 160) || '空'} | empty=${emptyText.slice(0, 80)} | pressed=${pressedAfterPick}`);
  await page.screenshot({ path: SHOT('banks-commits') }).catch(() => {});
  // 勾选第一条提交 → 确认 → git.scope 的 repoSubByProject 应落 banks
  await clickPrep('button[data-lck="git-tree-select"]:has-text("T04584-banks-commit")');
  await page.waitForTimeout(300);
  await clickPrep('[data-lck="git-tree-confirm"]');
  await page.waitForTimeout(900);
  const scope = await page.evaluate(() => {
    const raw = sessionStorage.getItem('git.scope');
    return raw ? JSON.parse(raw) : null;
  });
  const scopeRepoSub = scope?.repoSubByProject?.[project.id];
  const scopeShas = scope?.commitIdsByProject?.[project.id] ?? [];
  ok('B-04 确认后 git.scope.repoSubByProject 落 banks（子仓库选择不会被当根仓库下发）', scopeRepoSub === 'banks', `repoSub=${scopeRepoSub} shas=${scopeShas.length}`);
  ok('B-05 确认后确有勾选提交回传（commitIdsByProject 非空）', scopeShas.length > 0, `shas=${scopeShas.length}`);
} catch (e) {
  blockedSite('A/B 组 起点输入框子仓库分支交互', `前置未达成：${why(e)}`);
}

/* ---------- C 组：发布新鲜度 ---------- */
const bundleDir = path.join(REPO, 'web/dist/assets');
let hasRefSub = false, hasPlaceholder = false;
if (fs.existsSync(bundleDir)) {
  for (const f of fs.readdirSync(bundleDir)) {
    if (!/\.js$/.test(f)) continue;
    const s = fs.readFileSync(path.join(bundleDir, f), 'utf8');
    if (s.includes('data-ref-sub')) hasRefSub = true;
    if (s.includes('起点分支/标签/SHA')) hasPlaceholder = true;
  }
}
ok('C-01 发布新鲜度：当前 dist 含子仓库候选锚 data-ref-sub', hasRefSub, 'web/dist/assets 逐文件核对');
ok('C-02 发布新鲜度：当前 dist 含起点输入框 placeholder', hasPlaceholder, '起点分支/标签/SHA');

await page.screenshot({ path: SHOT('final') }).catch(() => {});
await browser.close();
console.log(`\nPASS=${pass} FAIL=${fail} BLOCKED=${blocked}`);
if (fail > 0 || blocked > 0) process.exitCode = 1;