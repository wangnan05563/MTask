/*
 * T05078 真浏览器 UI 门（自带夹具）：手动关联批量入口的目标可见 + 不再串任务。
 *
 * 夹具：1 个项目 + 1 条提交 + 2 个 status='done' 且未回写的任务。
 *
 * 覆盖：
 *  A 弹窗显示「本次确认将关联到：T000xx · 标题」；
 *  B 第一次确认后目标自动切到下一条（弹窗仍在，连续补录保留），但**勾选已清空**、确认按钮置灰；
 *  C 此时程序化强点确认也写不进第二个任务（guard 生效，API 断言零新增）；
 *  D 重新勾选后再确认，第二个任务才真正拿到提交（必须由用户重新选择）。
 *
 * 前置：隔离后端 MTask_PORT=39915 MTask_DATA_DIR=<tmp> MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/tsx/dist/cli.mjs scripts/verify/T05078-manual-link-target-ui.mts
 * 环境变量：MTASK_UI_BASE / MTASK_CHROME / PW_ROOT
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const SCRATCH = 'D:/tmp/t05078/ui';

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

const post = (u: string, b: any) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const patch = (u: string, b: any) => fetch(BASE + u, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (u: string) => fetch(BASE + u).then((r) => r.json());

const stamp = Date.now();
const ws = path.join(SCRATCH, `ws-${stamp}`);
fs.mkdirSync(ws, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git(ws, 'init', '-q', '-b', 'main');
git(ws, 'config', 'user.email', 't05078@test.local');
git(ws, 'config', 'user.name', 'T05078 Gate');
git(ws, 'config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(ws, 'f.txt'), 't05078\n');
git(ws, 'add', 'f.txt');
git(ws, 'commit', '-q', '-m', 'T05078-fixture-commit');
const sha = git(ws, 'rev-parse', 'HEAD').trim();

const proj: any = await post('/api/projects', { name: `T05078目标可见-${stamp}`, description: '批量补录目标可见门夹具' });
await patch(`/api/projects/${proj.id}`, { workspacePath: ws });
const taskA: any = await post('/api/tasks', { projectId: proj.id, title: 'T05078 任务甲', status: 'done' });
const taskB: any = await post('/api/tasks', { projectId: proj.id, title: 'T05078 任务乙', status: 'done' });
ok('U-00 夹具：2 个已完成未回写任务 + 1 条提交', !!proj.id && !!taskA.id && !!taskB.id,
  `${taskA.task_no}/${taskB.task_no} sha=${sha.slice(0, 7)}`);

const linksOf = async (id: string) => ((await get(`/api/tasks/${id}/git/links`)).links ?? []).map((l: any) => l.sha);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const rowCount = (pg: any) => pg.locator('button[data-lck="git-tree-select"]').count();
const waitRows = async (pg: any, predicate: (n: number) => boolean, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    const n = await rowCount(pg);
    if (predicate(n)) return n;
    await pg.waitForTimeout(250);
  }
  return rowCount(pg);
};

try {
  const assets = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).filter((f) => f.endsWith('.js'));
  const distJs = assets.map((f) => fs.readFileSync(path.join(ROOT, 'web/dist/assets', f), 'utf8')).join('\n');
  ok('F-01 当前 web/dist 含本轮标记 git-tree-target（非旧包假性通过）', distJs.includes('git-tree-target'));

  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  p.on('dialog', (d: any) => d.dismiss().catch(() => {}));
  const reqs: string[] = [];
  p.on('request', (r: any) => { const u = String(r.url()); if (u.includes('/git/links')) reqs.push(`${r.method()} ${u.replace(BASE, '')}`); });

  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  await p.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), proj.id);
  await p.evaluate(() => sessionStorage.setItem('tasks.activeTab', JSON.stringify('done')));
  await p.evaluate((keys: string[]) => { for (const k of keys) localStorage.setItem(k, '1'); },
    ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report', 'mtask.guide.seen.settings', 'mtask.projectGuide.seen']);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
  await p.locator('nav button.nav-btn[aria-label="任务"]').first().click({ timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(500);
  await p.locator('button:has-text("已完成（")').first().click({ timeout: 15000 }).catch(async () => {
    await p.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').startsWith('已完成（'));
      b?.click();
    });
  });
  await p.waitForSelector('[data-t03360="unlinked-bar"]', { timeout: 30000 });
  await p.locator('[data-t03360="manual-link"]').first().click();
  await p.waitForSelector('[data-lck="git-tree-target"]', { timeout: 20000 });
  await waitRows(p, (n) => n > 0);

  /* A 组 · 目标可见 */
  const target1 = await p.locator('[data-lck="git-tree-target"]').innerText();
  const firstNo = target1.includes(taskA.task_no) ? taskA.task_no : taskB.task_no;
  const secondNo = firstNo === taskA.task_no ? taskB.task_no : taskA.task_no;
  ok('A-01 弹窗明示本次确认写入哪个任务（含任务编号）',
    /本次确认将关联到：/.test(target1) && (target1.includes(taskA.task_no) || target1.includes(taskB.task_no)),
    target1.replace(/\s+/g, ' ').slice(0, 120));
  ok('A-02 队列有 2 条时提示当前是第几条', /第 1\/2 条/.test(target1), target1.replace(/\s+/g, ' ').slice(-40));

  /* B 组 · 第一次确认后目标切换、勾选清空 */
  await p.locator('button[data-lck="git-tree-select"]').first().click();
  await p.locator('[data-lck="git-tree-confirm"]').click();
  await p.waitForTimeout(900);
  const target2 = await p.locator('[data-lck="git-tree-target"]').innerText().catch(() => '');
  const btnState = await p.evaluate(() => {
    const b = document.querySelector('[data-lck="git-tree-confirm"]') as HTMLButtonElement | null;
    return b ? { disabled: b.disabled } : null;
  });
  ok('B-01 第一次确认后目标自动切到下一条（连续补录保留，但目标变了）',
    target2.includes(secondNo) && !target2.includes(firstNo), target2.replace(/\s+/g, ' ').slice(0, 120));
  ok('B-02 目标切换即重挂载：勾选被清空、确认按钮置灰（不可能直接再确认一次）',
    !!btnState && btnState.disabled === true, JSON.stringify(btnState));
  ok('B-03 底部选择计数归零（不是「还选着刚才那批」）',
    (await p.locator('[data-lck="git-tree-selected"]').innerText()).includes('已选 0 个提交'));

  /* C 组 · 程序化强点也写不进第二个任务 */
  const secondId = secondNo === taskA.task_no ? taskA.id : taskB.id;
  const firstId = firstNo === taskA.task_no ? taskA.id : taskB.id;
  const beforeSecond = (await linksOf(secondId)).length;
  await p.evaluate(() => {
    const b = document.querySelector('[data-lck="git-tree-confirm"]');
    b?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await p.waitForTimeout(700);
  const afterSecond = (await linksOf(secondId)).length;
  ok('C-01 绕过 disabled 程序化强点确认，也不会把提交写进第二个任务',
    beforeSecond === 0 && afterSecond === 0, `before=${beforeSecond} after=${afterSecond}`);
  ok('C-02 第一个任务确实已写入该提交（对照组：写入链路本身是通的）',
    (await linksOf(firstId)).includes(sha));

  /* D 组 · 重新勾选后才允许写入第二个任务 */
  await waitRows(p, (n) => n > 0);
  await p.locator('button[data-lck="git-tree-select"]').first().click();
  await p.locator('[data-lck="git-tree-confirm"]').click();
  await p.waitForTimeout(900);
  ok('D-01 用户重新勾选并确认后，第二个任务才拿到提交',
    (await linksOf(secondId)).includes(sha), JSON.stringify({ second: (await linksOf(secondId)).map((s) => s.slice(0, 7)) }));
  ok('D-02 队列走完弹窗关闭，且两次确认各写一个任务（无重复 POST 抖动）',
    (await p.locator('[data-lck="git-tree-modal"]').count()) === 0
    && reqs.length === 2, JSON.stringify(reqs));
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
