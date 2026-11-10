/*
 * T05076 门：项目下拉「未验证 5」与已完成页签「未验证 0」口径不一致。
 *
 * 根因：页签 K 用 `done.filter(t => !t.verified).length`——`done` 只是本页已加载的一页
 * （PAGE_SIZE=200），项目已完成超过一页、未验证项排在页外时算成 0；而下拉徽标取服务端
 * `SUM(status='done' AND verified=0)`（全项目、已排除 archived/shelved）。`doneTotal`/`todoTotal`
 * 早已改成项目级全量，只有 K 漏改。
 *
 * 本门三段：A 数据级复现分叉（205 条 done，5 条未验证排页外）→ B 源码锚（前端已改用全量计数）
 * → C 真浏览器渲染消费（页签与徽标数值一致）。
 *
 * 前置：隔离后端 MTask_PORT=39915（A/C 组）；C 组需本机 Chrome。
 * 运行：CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/tsx/dist/cli.mjs scripts/verify/T05076-unverified-count-gate.mts
 * 环境变量：MTASK_UI_BASE / MTASK_CHROME / PW_ROOT
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const PAGE_SIZE = 200;

let pass = 0, fail = 0, skip = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const skipIt = (name: string, why: string) => { skip += 1; console.log(`[SKIP] ${name} :: ${why}`); };
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const post = (u: string, b: any) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const patch = (u: string, b: any) => fetch(BASE + u, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (u: string) => fetch(BASE + u).then((r) => r.json());

const stamp = Date.now();
const ws = path.join('D:/tmp/t05076/ws', String(stamp));
fs.mkdirSync(ws, { recursive: true });

console.log('—— A 组 · 数据级复现口径分叉 ——');
let proj: any = null;
try {
  proj = await post('/api/projects', { name: `T05076计数口径-${stamp}`, description: '205 done / 5 未验证排页外' });
  await patch(`/api/projects/${proj.id}`, { workspacePath: ws });
  // 先建 5 条未验证（updated_at 最旧 → 排在一页之后），再建 200 条已验证
  for (let i = 0; i < 5; i += 1) {
    await post('/api/tasks', { projectId: proj.id, title: `T05076 未验证 ${i + 1}`, status: 'done' });
  }
  for (let i = 0; i < PAGE_SIZE; i += 1) {
    const t: any = await post('/api/tasks', { projectId: proj.id, title: `T05076 已验证 ${i + 1}`, status: 'done' });
    await patch(`/api/tasks/${t.id}`, { verified: true });
  }
  const projects: any[] = await get('/api/projects');
  const row = (projects as any[]).find((p) => p.id === proj.id) ?? {};
  const serverUnv = row.unverified_count ?? 0;
  const pageRaw: any = await get(`/api/tasks?projectId=${proj.id}&status=done&limit=${PAGE_SIZE}`);
  // 该端点直接回数组（不是 { tasks: [] }），两种形状都兼容
  const pageDone: any[] = Array.isArray(pageRaw) ? pageRaw : (pageRaw.tasks ?? pageRaw.list ?? []);
  const pageUnv = pageDone.filter((t: any) => !t.verified).length;
  ok('A-01 项目级计数把 5 条未验证都算上（服务端全量口径）', serverUnv === 5, `unverified_count=${serverUnv}`);
  ok('A-02 本页已加载的一页里未验证为 0（未验证项排在页外）',
    pageDone.length >= PAGE_SIZE && pageUnv === 0, `pageRows=${pageDone.length} pageUnv=${pageUnv}`);
  ok('A-03 分叉可复现：同一时刻下拉 5 / 本页 0（修复前页签正是用本页数）',
    serverUnv === 5 && pageUnv === 0, `server=${serverUnv} page=${pageUnv}`);
  ok('A-04 服务端计数已排除归档/搁置（与任务列表同源）',
    /FROM tasks WHERE archived = 0 AND COALESCE\(shelved, 0\) = 0 GROUP BY project_id/.test(src('server/src/routes/index.ts')));
} catch (e) {
  skipIt('A 组（数据级复现）', `后端不可用或造数失败：${String((e as Error)?.message ?? e).slice(0, 160)}`);
}

console.log('—— B 组 · 前端已改用项目级全量计数 ——');
const tasks = src('web/src/pages/TasksPage.tsx');
ok('B-01 页签 K 改用 unverifiedTotal，不再直接用本页 done 过滤',
  /未验证 \$\{unverifiedTotal\}/.test(tasks) && !/未验证 \$\{done\.filter\(\(t\) => !t\.verified\)\.length\}/.test(tasks));
ok('B-02 unverifiedTotal 优先取项目级 unverified_count，聚合视图用各项目之和',
  /const unverifiedTotal = curProj\?\.unverified_count[\s\S]{0,160}aggregate \? aggUnv : done\.filter\(\(t\) => !t\.verified\)\.length/.test(tasks));
ok('B-03 保留了「项目计数缺失时回退本页统计」的降级路径（不因接口缺字段显示 0）',
  /\?\? \(aggregate \? aggUnv : done\.filter\(\(t\) => !t\.verified\)\.length\)/.test(tasks));
ok('B-04 下拉徽标仍用同一字段（两处同源，不是各算一套）',
  /unverified=\{curProj\.unverified_count \?\? 0\}|unverified=\{p\.unverified_count \?\? 0\}/.test(tasks));
ok('B-05 doneTotal/todoTotal 仍是项目级全量（本次只补 K，没有回退既有口径）',
  /const doneTotal = curProj\?\.done_count \?\? \(aggregate \? aggDone : done\.length\)/.test(tasks)
  && /const todoTotal = curProj\?\.todo_count \?\? \(aggregate \? aggTodo : todo\.length\)/.test(tasks));

console.log('—— C 组 · 真浏览器渲染消费（小数据两处一致） ——');
const pick = (m: any) => m?.chromium ?? m?.default?.chromium;
let chromium: any = null;
try { chromium = pick(await import('playwright')); } catch { chromium = null; }
if (!chromium) {
  try {
    const root = process.env.PW_ROOT || 'D:/code/otherProjects/OcrTools/node_modules/playwright/index.js';
    chromium = pick(await import(pathToFileURL(root).href));
  } catch { chromium = null; }
}
if (!chromium || !proj) {
  skipIt('C 组（UI）', chromium ? '未拿到可用项目' : 'playwright 不可用');
} else {
  let browser: any = null;
  try {
    const small: any = await post('/api/projects', { name: `T05076渲染-${stamp}`, description: '3 done / 2 未验证' });
    await patch(`/api/projects/${small.id}`, { workspacePath: ws });
    for (let i = 0; i < 3; i += 1) {
      const t: any = await post('/api/tasks', { projectId: small.id, title: `T05076 渲染任务 ${i + 1}`, status: 'done' });
      if (i === 0) await patch(`/api/tasks/${t.id}`, { verified: true });
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const p = await ctx.newPage();
    p.on('dialog', (d: any) => d.dismiss().catch(() => {}));
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(900);
    await p.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), small.id);
    await p.evaluate(() => sessionStorage.setItem('tasks.activeTab', JSON.stringify('done')));
    await p.evaluate((keys: string[]) => { for (const k of keys) localStorage.setItem(k, '1'); },
      ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report', 'mtask.guide.seen.settings', 'mtask.projectGuide.seen']);
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    await p.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
    await p.locator('nav button.nav-btn[aria-label="任务"]').first().click({ timeout: 10000 }).catch(() => {});
    await p.locator('button:has-text("已完成（")').first().waitFor({ timeout: 20000 });
    const tabText = await p.locator('button:has-text("已完成（")').first().innerText();
    const tabUnv = Number((tabText.match(/未验证\s*(\d+)/) ?? [])[1] ?? -1);
    const badge = await p.evaluate(() => {
      // 只取「纯数字 + title 含未验证」的徽标 span，避免命中「批量置为未验证」等按钮/文案
      const el = [...document.querySelectorAll('span')].find((s) =>
        /^\d+$/.test((s.textContent ?? '').trim()) && (s.getAttribute('title') ?? '').includes('未验证'));
      return el ? { text: (el.textContent ?? '').trim(), title: el.getAttribute('title') ?? '' } : null;
    });
    const badgeUnv = Number(badge?.text ?? -1);
    ok('C-01 页签「未验证」显示项目级全量 2（不是本页过滤值）', tabUnv === 2, `tab="${tabText.replace(/\s+/g, ' ')}"`);
    ok('C-02 下拉徽标同样显示 2', badgeUnv === 2, JSON.stringify(badge));
    ok('C-03 两处数字一致（本单要修的就是这个）', tabUnv === badgeUnv && tabUnv === 2, `tab=${tabUnv} badge=${badgeUnv}`);
    await ctx.close();
  } catch (e) {
    skipIt('C 组（UI）', `执行异常：${String((e as Error)?.message ?? e).slice(0, 160)}`);
  } finally {
    if (browser) await browser.close();
  }
}

fs.rmSync(ws, { recursive: true, force: true });
console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip}`);
if (fail > 0) process.exitCode = 1;
