/*
 * T05437 真浏览器 UI 门：需求跟踪矩阵「关联PRD」列单行截断 + 悬浮全文 + 行高不换行。
 *
 * 夹具：一次 `/plans/import-prd` 造出「项目 + 超长文件名 PRD + 1 需求 + 里程碑/明细」，
 * 直接展开矩阵面板（sessionStorage `plan.showMatrix`），读真实 DOM 的计算样式。
 *
 * 前置：隔离后端 MTask_PORT=39915 MTask_DATA_DIR=<tmp> MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/tsx/dist/cli.mjs scripts/verify/T05437-matrix-doc-cell-ui.mts
 * 环境变量：MTASK_UI_BASE / MTASK_CHROME / PW_ROOT
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const SCRATCH = 'D:/tmp/t05437/ui';

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

const post = (u: string, b: any) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const patch = (u: string, b: any) => fetch(BASE + u, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

const stamp = Date.now();
const LONG_PRD = '审批功能优化和指导利率改动20261106业务需求-v6-超长文件名用于验证矩阵列截断与悬浮全文.md';
const ws = path.join(SCRATCH, `ws-${stamp}`);
fs.mkdirSync(ws, { recursive: true });

const proj: any = (await post('/api/projects', { name: `T05437矩阵截断-${stamp}`, description: '矩阵文档列截断夹具' })).body;
await patch(`/api/projects/${proj.id}`, { workspacePath: ws });
const imp = await post('/api/plans/import-prd', {
  projectId: proj.id,
  prdDocs: [{ filename: LONG_PRD, contentMd: '# 测试 PRD\n\n正文内容', docKind: 'prd' }],
  requirements: [{ reqNo: 'REQ-001', title: '矩阵截断验证需求', content: '用于验证关联PRD列截断', sourceIndex: 0, priority: 'normal' }],
  plans: [
    { title: 'M1 测试里程碑', kind: 'milestone', durationDays: 2 },
    { title: '1.1 测试明细', kind: 'normal', durationDays: 1 },
  ],
  createTasks: false,
});
ok('U-00 夹具：项目 + 超长文件名 PRD + 1 需求 + 2 计划已导入',
  imp.status === 200 && !!imp.body?.requirements, `status=${imp.status} body=${JSON.stringify(imp.body).slice(0, 160)}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const assets = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).filter((f) => f.endsWith('.js'));
  const distJs = assets.map((f) => fs.readFileSync(path.join(ROOT, 'web/dist/assets', f), 'utf8')).join('\n');
  ok('F-01 当前 web/dist 含本轮标记（DocCell 的 flex 收缩写法）',
    distJs.includes('flex: "1 1 auto"') || distJs.includes("flex:'1 1 auto'") || distJs.includes('1 1 auto'));

  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const p = await ctx.newPage();
  p.on('dialog', (d: any) => d.dismiss().catch(() => {}));
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  await p.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), proj.id);
  // 计划页有独立的项目选择（plan.projectId），不跟随任务页的 activeProject
  await p.evaluate((id: string) => sessionStorage.setItem('plan.projectId', JSON.stringify(id)), proj.id);
  await p.evaluate(() => sessionStorage.setItem('plan.showMatrix', JSON.stringify(true)));
  await p.evaluate((keys: string[]) => { for (const k of keys) localStorage.setItem(k, '1'); },
    ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report', 'mtask.guide.seen.settings', 'mtask.projectGuide.seen']);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  // 引导层会拦截点击：连点两次「跳过」（首帧可能还没渲染出来）
  await p.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
  await p.waitForTimeout(400);
  await p.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
  await p.waitForTimeout(200);
  // 计划页挂在「项目管理」tab 下（导航里没有独立的「计划」）
  await p.locator('nav button.nav-btn[aria-label="项目管理"]').first().click({ force: true, timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(1000);
  // 兜底：若面板未自动展开（sessionStorage 键被重置），点一次「需求跟踪矩阵」开关
  if ((await p.locator('table').count()) === 0) {
    await p.locator('button[aria-label="需求跟踪矩阵"]').first().click({ timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(800);
  }
  await p.waitForSelector('button[aria-label^="打开关联 PRD"]', { timeout: 30000 });

  const info = await p.evaluate(() => {
    const btn = document.querySelector('button[aria-label^="打开关联 PRD"]') as HTMLElement | null;
    if (!btn) return null;
    const span = btn.querySelector('span') as HTMLElement;
    const td = btn.closest('td') as HTMLElement;
    const tr = btn.closest('tr') as HTMLElement;
    const ss = getComputedStyle(span);
    const bs = getComputedStyle(btn);
    return {
      title: btn.getAttribute('title') ?? '',
      ariaLabel: btn.getAttribute('aria-label') ?? '',
      spanText: span.textContent ?? '',
      whiteSpace: ss.whiteSpace, textOverflow: ss.textOverflow, overflow: ss.overflow,
      spanScroll: span.scrollWidth, spanClient: span.clientWidth,
      btnMinWidth: bs.minWidth,
      tdWidth: Math.round(td.getBoundingClientRect().width),
      tdHeight: Math.round(td.getBoundingClientRect().height),
      trHeight: Math.round(tr.getBoundingClientRect().height),
    };
  });
  ok('A-01 单元格内是单行省略三件套（nowrap / ellipsis / hidden）',
    !!info && info.whiteSpace === 'nowrap' && info.textOverflow === 'ellipsis' && info.overflow === 'hidden',
    JSON.stringify({ whiteSpace: info?.whiteSpace, textOverflow: info?.textOverflow, overflow: info?.overflow }));
  ok('A-02 超长文件名确实被截断（scrollWidth > clientWidth，省略号真的出现）',
    !!info && info.spanScroll > info.spanClient + 1, info ? `scroll=${info.spanScroll} client=${info.spanClient}` : '');
  ok('A-03 按钮自身可收缩（computed minWidth=0px，不再被内容撑开）',
    !!info && info.btnMinWidth === '0px', info?.btnMinWidth);
  ok('A-04 列宽受控（<=200px，不随文件名长度撑开；文件名自然宽度 481px）',
    !!info && info.tdWidth <= 200, String(info?.tdWidth));
  ok('A-05 单元格高度保持单行（<=30px，长文件名不换行撑高）',
    !!info && info.tdHeight <= 30, info ? `td=${info.tdHeight} tr=${info.trHeight}` : '');
  ok('B-01 悬浮 title 是完整文件名（不是截断后的文本）',
    !!info && info.title.includes(LONG_PRD.trim()) && info.title.includes('打开 PRD 原文'),
    String(info?.title).slice(0, 120));
  ok('B-02 aria-label 同样带完整文件名（读屏可读全）',
    !!info && info.ariaLabel.includes(LONG_PRD.trim()), String(info?.ariaLabel).slice(0, 120));
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
