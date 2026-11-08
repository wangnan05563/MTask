/**
 * T04592 验收门：任务菜单工具条「Git 徽标 + 搜索框」向左靠拢「一键收起」、紧凑单行。
 *
 * 缺陷：搜索框 span 挂 `marginLeft:'auto'`，把 [搜索框][更多] 顶到工具条最右端，与 Git 徽标/一键收起
 * 之间留出大段空白，窄窗时还会换行下沉。工单要求：左靠拢、缩窄间距、消除换行、同一行展示。
 *
 * 判据：
 *   A 组（真实浏览器 1600×1000，量 getBoundingClientRect）：Git 徽标/搜索框/更多 与一键收起同一行；
 *        Git 徽标→搜索框、搜索框→更多 间距收到正常 gap（≤14px，证明 auto 外边距已移除）；整组左对齐（右侧留白）。
 *   B 组（源码锚）：搜索框 span 不再带 marginLeft:'auto'；工具条容器 gap 收窄到 6。
 *
 * 前置（R-332 不用 vite preview）：先 `cd web && npm run build`，再起隔离后端
 *   `MTask_PORT=39912 MTask_DATA_DIR=D:/tmp/t04592/data MTASK_STATIC_DIR=<repo>/web/dist ... server/src/index.ts`。
 * 全程只碰隔离实例与临时目录，不触生产。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39912';
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

// 等隔离后端就绪
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(BASE + '/api/projects'); if (r.ok) break; } catch { /* 未起 */ }
  await new Promise((r) => setTimeout(r, 500));
}

const json = async (r: Response) => { const x = await r.json().catch(() => null); if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(x)}`); return x; };
const post = (url: string, body?: any) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(json);
const stamp = Date.now();
const project = await post('/api/projects', { name: `T04592布局门-${stamp}`, description: '工具条紧凑布局' });
await post('/api/tasks', { projectId: project.id, title: `T04592布局任务-${stamp}` });

const dataDir = mkdtempSync(path.join(os.tmpdir(), 't04592-ui-'));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));

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
await page.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
await page.waitForTimeout(300);
// 工具条控件默认 op-hidden（visibility:hidden 仍占位）——显形后量真实可见布局
await page.evaluate(() => document.querySelectorAll('.op-host').forEach((h) => h.classList.add('op-force')));
await page.waitForTimeout(400);

try {
  await page.waitForSelector('[data-t03343="git-toggle"]', { state: 'attached', timeout: 20000 });
  await page.waitForSelector('[data-page-search]', { state: 'attached', timeout: 20000 });
  const m = await page.evaluate(() => {
    const foldEl = document.querySelector('button[aria-label="一键收起或展开全部任务详情"]');
    const gitEl = document.querySelector('[data-t03343="git-toggle"]');
    const searchEl = document.querySelector('[data-page-search]');
    const moreEl = document.querySelector('[data-t03623="more-trigger"]');
    const hostEl = foldEl ? foldEl.closest('.op-host') : null;
    const fr = foldEl ? foldEl.getBoundingClientRect() : null;
    const gr = gitEl ? gitEl.getBoundingClientRect() : null;
    const sr = searchEl ? searchEl.getBoundingClientRect() : null;
    const mr = moreEl ? moreEl.getBoundingClientRect() : null;
    const hr = hostEl ? hostEl.getBoundingClientRect() : null;
    return {
      fold: fr ? { x: fr.x, y: fr.y, right: fr.right, width: fr.width, height: fr.height } : null,
      git: gr ? { x: gr.x, y: gr.y, right: gr.right, width: gr.width, height: gr.height } : null,
      search: sr ? { x: sr.x, y: sr.y, right: sr.right, width: sr.width, height: sr.height } : null,
      more: mr ? { x: mr.x, y: mr.y, right: mr.right, width: mr.width, height: mr.height } : null,
      host: hr ? { x: hr.x, y: hr.y, right: hr.right, width: hr.width, height: hr.height } : null,
    };
  });
  console.log('[RECT]', JSON.stringify(m));
  const { fold, git, search, more, host } = m as any;
  ok('A-01 一键收起/Git 徽标/搜索框/更多/工具条容器均挂载', !!(fold && git && search && more && host));
  if (fold && git && search && more && host) {
    const row = (a: any) => Math.abs(a.y - fold.y) <= 4;
    ok('A-02 Git 徽标与一键收起同一行（不换行下沉）', row(git), `git.y=${git.y.toFixed(1)} fold.y=${fold.y.toFixed(1)}`);
    ok('A-03 搜索框与一键收起同一行（不换行下沉）', row(search), `search.y=${search.y.toFixed(1)} fold.y=${fold.y.toFixed(1)}`);
    ok('A-04 更多与一键收起同一行（不换行下沉）', row(more), `more.y=${more.y.toFixed(1)} fold.y=${fold.y.toFixed(1)}`);
    const gapGitSearch = search.x - git.right;
    ok('A-05 Git 徽标→搜索框间距收到正常 gap（≤14px，auto 外边距已移除）', gapGitSearch <= 14 && gapGitSearch >= -2, `gap=${gapGitSearch.toFixed(1)}px`);
    const gapSearchMore = more.x - search.right;
    ok('A-06 搜索框→更多间距收到正常 gap（≤14px）', gapSearchMore <= 14 && gapSearchMore >= -2, `gap=${gapSearchMore.toFixed(1)}px`);
    const rightFree = host.right - more.right;
    ok('A-07 搜索框压缩后仍可用（宽度 ≥80px，未塌成零）', search.width >= 80, `search.width=${search.width.toFixed(1)}px rightFree=${rightFree.toFixed(1)}px`);
  }
} catch (e) {
  fail++; console.log(`FAIL A 组执行异常 :: ${why(e)}`);
} finally {
  await browser.close().catch(() => {});
}

/* ------------------------------ B 组：源码锚 ------------------------------ */
const src = readFileSync(path.join(REPO, 'web/src/pages/TasksPage.tsx'), 'utf8');
ok('B-01 搜索框 span 不再带 marginLeft:auto（原 unique 组合已移除）',
  !src.includes("position: 'relative', display: 'inline-flex', marginLeft: 'auto'"), 'TasksPage.tsx 搜索框 span');
ok('B-02 工具条容器 gap 收窄到 6（缩窄控件间距）',
  src.includes("display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap'"), 'renderToolbar 外层 div');
ok('B-03 搜索框小基准宽不换行（span flex:1 1 120px/minWidth:0/maxWidth:220 + input width:100%/minWidth:0）',
  src.includes("display: 'inline-flex', flex: '1 1 120px', minWidth: 0, maxWidth: 220") && src.includes("width: '100%', minWidth: 0, padding: '6px 8px 6px 26px'"), 'TasksPage.tsx 搜索框 span/input');

console.log(`\nPASS=${pass} FAIL=${fail}`);
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不改变结论 */ }
process.exit(fail === 0 ? 0 : 1);