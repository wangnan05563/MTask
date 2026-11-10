/*
 * T05439 门：任务行「切换任务完成状态」勾选框左移，双击编号不再误触。
 *
 * 根因：元信息行整行 `marginLeft:32` 时，勾选框 x ≈ 标题行任务编号 x（置顶图标 21 + gap 8 ≈ 29），
 * 两者几乎垂直对齐——双击编号复制时鼠标稍下移就命中勾选框，把任务误标成完成。
 * 修复：元信息行贴到行首（marginLeft:0），勾选框与编号水平错开约 30px。
 *
 * A 组 几何（真浏览器）：勾选框在编号左侧且错开 ≥24px、元信息行 marginLeft=0px、行高未变；
 * B 组 交互（真浏览器）：双击编号 → 任务仍是 todo（不误触）；单击勾选框 → 变 done（功能不变）。
 *
 * 前置：隔离后端 MTask_PORT=39915（或 MTASK_UI_BASE）；自带夹具（1 项目 + 1 待办任务）。
 * 运行：CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/tsx/dist/cli.mjs scripts/verify/T05439-task-checkbox-left-gate.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const SCRATCH = 'D:/tmp/t05439/ui';

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

const post = (u: string, b: any) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => ({})) }));
const get = (u: string) => fetch(BASE + u).then((r) => r.json());
const stamp = Date.now();
fs.mkdirSync(SCRATCH, { recursive: true });

const proj: any = (await post('/api/projects', { name: `T05439勾选框-${stamp}`, description: '勾选框左移门夹具' })).b;
const task: any = (await post('/api/tasks', { projectId: proj.id, title: 'T05439 双击编号不应误触勾选框' })).b;
ok('U-00 夹具：1 项目 + 1 待办任务', !!proj.id && !!task.id, `${proj.name} / ${task.task_no ?? task.id}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const assets = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).filter((f) => f.endsWith('.js'));
  const distJs = assets.map((f) => fs.readFileSync(path.join(ROOT, 'web/dist/assets', f), 'utf8')).join('\n');
  ok('F-01 当前 web/dist 含本轮标记（元信息行 marginLeft:0）',
    distJs.includes('marginLeft:0') || distJs.includes('marginLeft: 0'));

  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const p = await ctx.newPage();
  p.on('dialog', (d: any) => d.dismiss().catch(() => {}));
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  await p.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), proj.id);
  await p.evaluate((keys: string[]) => { for (const k of keys) localStorage.setItem(k, '1'); },
    ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report', 'mtask.guide.seen.settings', 'mtask.projectGuide.seen']);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1400);
  for (let i = 0; i < 2; i += 1) {
    await p.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
    await p.waitForTimeout(300);
  }
  await p.locator('nav button.nav-btn[aria-label="任务"]').first().click({ force: true }).catch(() => {});
  // 任务行的操作区（含勾选框）默认隐藏、悬停该行才淡入
  await p.locator('[data-ttask-id]').first().waitFor({ timeout: 20000 });
  await p.locator('[data-ttask-id]').first().hover();
  await p.waitForTimeout(400);
  await p.waitForSelector('[aria-label="切换任务完成状态"]', { state: 'visible', timeout: 20000 });

  const geo = await p.evaluate(() => {
    const box = document.querySelector('[aria-label="切换任务完成状态"]') as HTMLElement | null;
    const no = document.querySelector('[aria-label^="任务编号"]') as HTMLElement | null;
    if (!box || !no) return null;
    const b = box.getBoundingClientRect();
    const n = no.getBoundingClientRect();
    const row = box.closest('[data-ttask-id]') as HTMLElement | null;
    const meta = box.closest('.task-toolbar') as HTMLElement | null;
    return {
      boxLeft: Math.round(b.left), boxRight: Math.round(b.right), boxTop: Math.round(b.top),
      noLeft: Math.round(n.left), noTop: Math.round(n.top),
      metaMarginLeft: meta ? getComputedStyle(meta).marginLeft : '',
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
      metaHeight: meta ? Math.round(meta.getBoundingClientRect().height) : 0,
      canvasLeft: Math.round((meta ? meta.getBoundingClientRect().left : b.left)),
      colLeft: Math.round((row ? row.getBoundingClientRect().left : b.left)),
    };
  });
  ok('A-01 勾选框在任务编号左侧且水平错开 ≥24px（原实现几乎垂直对齐）',
    !!geo && geo.boxLeft + 24 <= geo.noLeft, geo ? `box=${geo.boxLeft} no=${geo.noLeft} 差=${geo.noLeft - geo.boxLeft}` : '');
  ok('A-02 元信息行贴到行首（computed marginLeft=0px）',
    !!geo && geo.metaMarginLeft === '0px', geo?.metaMarginLeft);
  ok('A-03 勾选框未被挤出内容区（左边缘不早于行左边缘）',
    !!geo && geo.boxLeft >= geo.colLeft - 1, geo ? `box=${geo.boxLeft} rowLeft=${geo.colLeft}` : '');
  ok('A-04 元信息行未被压扁（高度 >0，控件仍在正常行内）',
    !!geo && geo.metaHeight > 0, JSON.stringify({ metaHeight: geo?.metaHeight, rowHeight: geo?.rowHeight }));

  const iconOf = () => p.evaluate(() => (document.querySelector('[aria-label="切换任务完成状态"]') as HTMLElement | null)?.textContent?.trim() ?? '');
  ok('B-00 初始为未完成 ☐', (await iconOf()) === '☐', await iconOf());

  await p.locator('[aria-label^="任务编号"]').first().dblclick({ force: true });
  await p.waitForTimeout(700);
  ok('B-01 双击任务编号（复制）后状态未被误改，仍是 ☐',
    (await iconOf()) === '☐', `icon=${await iconOf()}`);

  await p.locator('[aria-label="切换任务完成状态"]').first().click();
  await p.waitForTimeout(900);
  // 完成后该行会从「待办」列表移除，DOM 上读不到 ☑ —— 用接口断言状态真的变了
  const listed: any = await get(`/api/tasks?projectId=${proj.id}`);
  const rowsNow: any[] = Array.isArray(listed) ? listed : (listed.tasks ?? []);
  const target = rowsNow.find((x: any) => x.id === task.id);
  ok('B-02 单击勾选框仍能正常切换为已完成（业务逻辑未变）',
    !!target && target.status === 'done', JSON.stringify({ status: target?.status, icon: await iconOf() }));
  await ctx.close();
} catch (e) {
  fail += 1;
  console.log(`[FAIL] UI 门执行异常 :: ${why(e)}`);
} finally {
  await browser.close();
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
