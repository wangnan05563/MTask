/*
 * T04585 验收门（真浏览器）：聚合视图单提交 decorate 简化 + 平铺视图负控制。
 *
 * 前置：隔离后端 MTask_DATA_DIR=<tmp>/t04585/data MTask_PORT=39910 MTASK_STATIC_DIR=<repo>/web/dist
 *       夹具 ws 根仓库 head 提交带 10 个引用（3 本地分支 + origin/master 孪生 + 6 标签）。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04585-commit-refs-simplify-ui.mts
 *
 * A 组 聚合视图：head 提交行可见 pill 收敛为 3 + 「+7」；折叠名不在行文本里；+K title 列全量；详情行列全 10 个（不丢信息）。
 * B 组 负控制：切回平铺视图同一提交逐字平铺全部 pill（含被折叠标签），且无 +K（不影响非聚合视图）。
 */
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39910';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REPO = process.cwd();
const SHOT = (n: string) => path.join(os.tmpdir(), `t04585-${n.replace(/[^\w]+/g, '-').slice(0, 60)}.png`);
const HIDDEN_TAG = 'BEMP5.0V202301-02-036M006';

let pass = 0, fail = 0, blocked = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const blockedSite = (name: string, reason: string) => { blocked++; console.log(`BLOCKED ${name} :: ${reason}`); };
const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s*\r?\n\s*/g, ' | ').slice(0, 300);

const pick = (m: any) => m?.chromium ?? m?.default?.chromium;
let chromium: any = null;
try { chromium = pick(await import('playwright')); } catch { chromium = null; }
if (!chromium) {
  const root = process.env.PW_ROOT || 'D:/code/otherProjects/OcrTools/node_modules/playwright/index.js';
  chromium = pick(await import(pathToFileURL(root).href));
}
if (!chromium) throw new Error('playwright 不可用：请设置 PW_ROOT');

const list: any[] = await (await fetch(`${BASE}/api/projects`)).json();
const project = list.find((p) => p.name.startsWith('T04585 分支名简化门项目'));
if (!project) { console.log('BLOCKED 夹具项目不存在（先跑 t04585-setup.mjs）'); process.exit(1); }

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));

async function navToReport() {
  const sel = 'nav button.nav-btn[aria-label="AI 工作台"]';
  try { await page.locator(sel).click({ timeout: 6000 }); }
  catch {
    const done = await page.evaluate((s: string) => { const el = document.querySelector(s) as HTMLElement | null; if (!el) return false; el.click(); return true; }, sel);
    if (!done) throw new Error('AI 工作台页签不存在');
  }
  await page.waitForTimeout(700);
}
const clickPrep = async (selector: string, timeout = 8000) => {
  try { await page.locator(selector).first().click({ timeout }); }
  catch {
    const done = await page.evaluate((s: string) => { const el = document.querySelector(s) as HTMLElement | null; if (!el) return false; el.click(); return true; }, selector);
    if (!done) throw new Error(`前置控件不存在：${selector}`);
    await page.waitForTimeout(400);
  }
};

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.evaluate((kv: any) => { for (const k of Object.keys(kv)) sessionStorage.setItem(k, JSON.stringify(kv[k])); }, { 'report.showGitExtract': true });
await page.evaluate((keys: string[]) => { for (const k of keys) localStorage.setItem(k, '1'); },
  ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report', 'mtask.guide.seen.settings', 'mtask.projectGuide.seen', `guide.dismiss.${project.id}`]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
await page.waitForTimeout(300);

try {
  await navToReport();
  await page.waitForSelector('[data-t03366="git-scope-picker"]', { timeout: 20000 });
  await clickPrep(`input[aria-label^="纳入项目 T04585"]`);
  await page.waitForTimeout(400);
  await clickPrep('[data-t04553="open"]');
  await page.waitForSelector('[data-lck="git-tree-modal"]', { timeout: 20000 });
  // 多仓库入口默认开聚合；确保聚合态
  await page.waitForSelector('[data-lck="git-tree-repo-view"]', { timeout: 20000 });
  if ((await page.locator('[data-lck="git-tree-repo-view"]').getAttribute('aria-pressed')) !== 'true') {
    await clickPrep('[data-lck="git-tree-repo-view"]');
  }
  await page.waitForSelector('[data-lck="git-repo-groups"]', { timeout: 20000 });
  const groupSel = '[data-lck="git-repo-group"][data-branch="master"]';
  await page.waitForSelector(groupSel, { timeout: 25000 });
  // 展开 master 分支组
  if ((await page.locator(`${groupSel} [data-lck="git-repo-branch"]`).getAttribute('aria-expanded')) !== 'true') {
    await clickPrep(`${groupSel} [data-lck="git-repo-branch"]`);
  }
  await page.waitForTimeout(400);
  // 展开根仓库面板触发取数
  await clickPrep(`${groupSel} [data-lck="git-repo-repo-toggle"]`);
  await page.waitForSelector(`${groupSel} [data-lck="git-tree-row"]`, { timeout: 25000 });
  await page.waitForTimeout(400);

  const rowInfo = await page.evaluate((g: string) => {
    const row = document.querySelector(`${g} [data-lck="git-tree-row"]`) as HTMLElement | null;
    if (!row) return null;
    const more = row.querySelector('[data-lck="git-tree-refs-more"]') as HTMLElement | null;
    return { text: row.textContent || '', moreText: more?.textContent || '', moreTitle: more?.getAttribute('title') || '' };
  }, groupSel);
  if (!rowInfo) { blockedSite('A 组 聚合提交行', 'master 组内无提交行'); }
  else {
    ok('A-01 聚合 head 提交行出现 +K 折叠 chip', !!rowInfo.moreText && /^\+\d+$/.test(rowInfo.moreText.trim()), `more=${rowInfo.moreText}`);
    ok('A-02 折叠数为 7（10 引用 - 3 可见）', rowInfo.moreText.trim() === '+7', `more=${rowInfo.moreText}`);
    ok('A-03 行文本露出本地分支但隐藏标签不在行内（密度下降）',
      rowInfo.text.includes('feature/x') && !rowInfo.text.includes(HIDDEN_TAG), `hasBranch=${rowInfo.text.includes('feature/x')} hasHiddenTag=${rowInfo.text.includes(HIDDEN_TAG)}`);
    ok('A-04 +K title 悬浮列全量折叠名（含孪生与标签）',
      rowInfo.moreTitle.includes('origin/master') && rowInfo.moreTitle.includes(HIDDEN_TAG), `title=${rowInfo.moreTitle.slice(0, 120)}`);
    await page.screenshot({ path: SHOT('agg-capped') }).catch(() => {});
    // 展开提交详情 → 全量引用不丢
    await clickPrep(`${groupSel} [data-lck="git-tree-row"] [data-lck="git-tree-expand"]`);
    await page.waitForTimeout(300);
    const detailRefs = await page.evaluate((g: string) => {
      const el = document.querySelector(`${g} [data-lck="git-tree-detail-refs"]`) as HTMLElement | null;
      return el?.textContent || '';
    }, groupSel);
    ok('A-05 详情行列全 10 个引用（不丢分支归属信息）',
      detailRefs.includes('（10）') && detailRefs.includes(HIDDEN_TAG) && detailRefs.includes('origin/master'), `detail=${detailRefs.slice(0, 140)}`);
  }

  // B 组负控制：切回平铺，同一提交逐字平铺全部 pill、无 +K
  await clickPrep('[data-lck="git-tree-repo-view"]');
  await page.waitForTimeout(600);
  await page.waitForSelector('[data-lck="git-tree-row"]', { timeout: 25000 });
  await page.waitForTimeout(400);
  const flatInfo = await page.evaluate(() => {
    const row = document.querySelector('[data-lck="git-tree-row"]') as HTMLElement | null;
    if (!row) return null;
    return { text: row.textContent || '', hasMore: !!row.querySelector('[data-lck="git-tree-refs-more"]') };
  });
  if (!flatInfo) { blockedSite('B 组 平铺负控制', '平铺视图无提交行'); }
  else {
    ok('B-01 平铺视图同一提交仍平铺被折叠标签（非聚合不受影响）', flatInfo.text.includes(HIDDEN_TAG), `hasHiddenTag=${flatInfo.text.includes(HIDDEN_TAG)}`);
    ok('B-02 平铺视图无 +K 折叠 chip（保持改造前展示）', !flatInfo.hasMore, `hasMore=${flatInfo.hasMore}`);
    await page.screenshot({ path: SHOT('flat-unchanged') }).catch(() => {});
  }
} catch (e) {
  blockedSite('A/B 组 聚合 decorate 简化交互', `前置未达成：${why(e)}`);
}

await browser.close();
console.log(`\nPASS=${pass} FAIL=${fail} BLOCKED=${blocked}`);
if (fail > 0 || blocked > 0) process.exitCode = 1;