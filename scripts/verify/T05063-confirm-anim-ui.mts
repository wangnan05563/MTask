/*
 * T05063 真浏览器 UI 门（自带夹具）：「确认选择」点击动画 + 防连点 + 提交安全。
 *
 * 覆盖：
 *  A 正常确认——点击瞬间真的有动画（animationName/时长）、按钮置灰、60ms 时仍未提交（延迟到动画结束）、
 *    动画结束后弹窗关闭且 git.scope 只收到 1 个提交；
 *  B 动画窗口内点「取消」——定时器被清理，等过动画时长后 git.scope 仍为空（不漏提交）；
 *  C 被拒场景（跨仓库勾选）——动画照播、300ms 后错误如实出现、按钮恢复可点、未写入任何提交；
 *  D 其它按钮（取消/搜索）没有被加上动画。
 *
 * 前置：隔离后端 MTask_PORT=39915 MTask_DATA_DIR=<tmp> MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/tsx/dist/cli.mjs scripts/verify/T05063-confirm-anim-ui.mts
 * 环境变量：MTASK_UI_BASE / MTASK_CHROME / PW_ROOT
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const SCRATCH = 'D:/tmp/t05063-ui';

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

const stamp = Date.now();
const wsOne = path.join(SCRATCH, `one-${stamp}`);
const wsMulti = path.join(SCRATCH, `multi-${stamp}`);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const makeRepo = (dir: string, branch: string, label: string, subjects: string[]) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 't05063@test.local');
  git(dir, 'config', 'user.name', 'T05063 Gate');
  git(dir, 'config', 'commit.gpgsign', 'false');
  subjects.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, 'f.txt'), `${label}-${i}-${s}\n`);
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', s);
  });
};
try {
  makeRepo(wsOne, 'main', 'one', ['anim-c1', 'anim-c2']);
  fs.mkdirSync(path.join(wsMulti, 'docs'), { recursive: true });
  makeRepo(path.join(wsMulti, 'banks'), 'dev', 'banks', ['banks-anim']);
  makeRepo(path.join(wsMulti, 'deploy'), 'main', 'deploy', ['deploy-anim']);
} catch (e) { console.log(`[FAIL] 夹具自建失败 :: ${why(e)}`); process.exit(1); }

const projectOne: any = await post('/api/projects', { name: `T05063单仓-${stamp}`, description: '确认动画门夹具' });
await patch(`/api/projects/${projectOne.id}`, { workspacePath: wsOne });
const projectMulti: any = await post('/api/projects', { name: `T05063多仓-${stamp}`, description: '跨仓库确认被拒夹具' });
await patch(`/api/projects/${projectMulti.id}`, { workspacePath: wsMulti });
ok('U-00 夹具：单仓库 + 多仓库两个工作空间已绑定', !!projectOne.id && !!projectMulti.id);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const rows = (pg: any) => pg.locator('button[data-lck="git-tree-select"]').count();
const waitRows = async (pg: any, predicate: (n: number) => boolean, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    const n = await rows(pg);
    if (predicate(n)) return n;
    await pg.waitForTimeout(250);
  }
  return rows(pg);
};
const readScope = (pg: any) => pg.evaluate(() => {
  const raw = sessionStorage.getItem('git.scope');
  return raw ? JSON.parse(raw) : null;
});

async function openPicker(project: any) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  p.on('dialog', (d: any) => d.dismiss().catch(() => {}));
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

/** 点击确认并在下一绘制帧读按钮的计算样式（动画名/时长/置灰/aria-busy） */
const clickAndProbe = (pg: any) => pg.evaluate(async () => {
  const b = document.querySelector('[data-lck="git-tree-confirm"]') as HTMLButtonElement | null;
  if (!b) return null;
  b.click();
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const s = getComputedStyle(b);
  return {
    animationName: s.animationName, animationDuration: s.animationDuration,
    disabled: b.disabled, busy: b.getAttribute('aria-busy'),
  };
});

try {
  /* ---------- F 发布新鲜度 ---------- */
  const assets = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).filter((f) => f.endsWith('.js'));
  const distJs = assets.map((f) => fs.readFileSync(path.join(ROOT, 'web/dist/assets', f), 'utf8')).join('\n');
  ok('F-01 当前 web/dist 含本轮动画标记（非旧包假性通过）',
    distJs.includes('git-tree-confirm-pop') && distJs.includes('git-tree-confirm'));

  /* ---------- A 组 · 正常确认：动画 + 延迟提交 ---------- */
  const a = await openPicker(projectOne);
  await waitRows(a.p, (n) => n > 0);
  await a.p.locator('button[data-lck="git-tree-select"]').first().click();
  const probe = await clickAndProbe(a.p);
  ok('A-01 点击瞬间按钮真的挂上动画（不是只有声明）',
    !!probe && probe.animationName.includes('git-tree-confirm-pop'), JSON.stringify(probe));
  ok('A-02 动画时长为 250ms（落在需求 200-300ms 区间）',
    !!probe && Math.round(parseFloat(probe.animationDuration) * 1000) === 250,
    probe?.animationDuration);
  ok('A-03 动画期间按钮置灰且 aria-busy 可读（防连点、无障碍可见）',
    !!probe && probe.disabled === true && probe.busy === 'true');
  await a.p.waitForTimeout(60);
  ok('A-04 点击后 60ms 仍未提交（反馈先播完再提交，不是一闪就关）',
    (await a.p.locator('[data-lck="git-tree-modal"]').count()) === 1);
  await a.p.locator('[data-lck="git-tree-modal"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  ok('A-05 动画结束后确认生效并关闭弹窗', (await a.p.locator('[data-lck="git-tree-modal"]').count()) === 0);
  const scopeA = await readScope(a.p);
  const shasA = scopeA?.commitIdsByProject?.[projectOne.id] ?? [];
  ok('A-06 只提交了一次（git.scope 恰好收到 1 个提交）', shasA.length === 1, `shas=${shasA.length}`);
  ok('A-07 其它按钮没有被加上动画（取消/搜索仍是静态样式）',
    (await a.p.evaluate(() => {
      const sel = ['[data-lck="git-tree-cancel"]', '[data-lck="git-tree-search-btn"]'];
      return sel.every((s) => {
        const el = document.querySelector(s);
        return !el || getComputedStyle(el).animationName === 'none';
      });
    })) === true);
  await a.ctx.close();

  /* ---------- B 组 · 动画窗口内取消 → 不漏提交 ---------- */
  const b = await openPicker(projectOne);
  await waitRows(b.p, (n) => n > 0);
  await b.p.locator('button[data-lck="git-tree-select"]').first().click();
  await b.p.evaluate(() => (document.querySelector('[data-lck="git-tree-confirm"]') as HTMLButtonElement | null)?.click());
  await b.p.waitForTimeout(80);
  await b.p.locator('[data-lck="git-tree-cancel"]').click();
  await b.p.waitForSelector('[data-lck="git-tree-modal"]', { state: 'detached', timeout: 5000 });
  await b.p.waitForTimeout(400); // 越过 250ms 动画窗口，确认定时器确实被清掉
  const scopeB = await readScope(b.p);
  const shasB = scopeB?.commitIdsByProject?.[projectOne.id] ?? [];
  ok('B-01 动画窗口内点取消：弹窗关闭且提交没有被延迟漏出', shasB.length === 0, `shas=${shasB.length}`);
  await b.ctx.close();

  /* ---------- C 组 · 被拒场景：动画照播、按钮恢复、零写入 ---------- */
  const c = await openPicker(projectMulti);
  await waitRows(c.p, (n) => n >= 2);
  await c.p.locator('button[data-lck="git-tree-select"][aria-label*="banks-anim"]').first().click();
  await c.p.locator('button[data-lck="git-tree-select"][aria-label*="deploy-anim"]').first().click();
  const probeC = await clickAndProbe(c.p);
  ok('C-01 被拒场景同样先播动画（不会因为要报错就没有反馈）',
    !!probeC && probeC.animationName.includes('git-tree-confirm-pop'), JSON.stringify(probeC));
  await c.p.waitForTimeout(350);
  const errText = await c.p.locator('[data-lck="git-tree-error"]').count()
    ? await c.p.locator('[data-lck="git-tree-error"]').innerText() : '';
  ok('C-02 动画结束后才如实报出跨仓库拒绝原因',
    errText.includes('一次确认只能回传一个仓库'), errText.slice(0, 120));
  const btnState = await c.p.evaluate(() => {
    const el = document.querySelector('[data-lck="git-tree-confirm"]') as HTMLButtonElement | null;
    return el ? { disabled: el.disabled, busy: el.getAttribute('aria-busy') } : null;
  });
  ok('C-03 被拒后按钮恢复可点（动画窗口不会把按钮永久锁死）',
    !!btnState && btnState.disabled === false && btnState.busy === null, JSON.stringify(btnState));
  const scopeC = await readScope(c.p);
  const shasC = scopeC?.commitIdsByProject?.[projectMulti.id] ?? [];
  ok('C-04 被拒时零写入（没有任何提交被错误关联）', shasC.length === 0, `shas=${shasC.length}`);
  ok('C-05 弹窗仍在，用户可继续调整勾选', (await c.p.locator('[data-lck="git-tree-modal"]').count()) === 1);
  await c.ctx.close();
} catch (e) {
  fail += 1;
  console.log(`[FAIL] UI 门执行异常 :: ${why(e)}`);
} finally {
  await browser.close();
  fs.rmSync(wsOne, { recursive: true, force: true });
  fs.rmSync(wsMulti, { recursive: true, force: true });
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
