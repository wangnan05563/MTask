/*
 * T04586 复验 UI 门（真浏览器，自带夹具）：「从 Git 树选范围」**默认平铺视图**就要列出
 * 工作空间目录内递归发现的全部仓库（根 + 任意层级子仓库），且能逐仓库取数。
 *
 * 打回背景（【验证失败 2026-11-10】）：上一轮只改了服务端 /git/repos，默认视图恒定 repoSub=''
 * 且从不普查，用户第一屏仍只有根目录那一个仓库。本门走真实用户路径（AI 工作台 → Git 提取卡
 * → 勾选项目 → 从 Git 树选范围）复验修复，并覆盖「根本身就是仓库」的向后兼容形状。
 *
 * 前置：隔离后端 MTask_PORT=39915 MTask_DATA_DIR=<tmp>/t04586v/data MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04586-default-repo-picker-ui.mts
 * 环境变量：MTASK_UI_BASE / MTASK_CHROME / PW_ROOT
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39915';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = process.cwd();
const SCRATCH = 'D:/tmp/t04586-ui';

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

/* ---------- 夹具：A 根非仓库 + 4 个子仓库（含 depth3）；B 根本身就是仓库 ---------- */
const stamp = Date.now();
const ws = path.join(SCRATCH, `ws-${stamp}`);
const wsRoot = path.join(SCRATCH, `root-${stamp}`);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const makeRepo = (dir: string, branch: string, label: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 't04586@test.local');
  git(dir, 'config', 'user.name', 'T04586 UI Gate');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'f.txt'), `${label}\n`);
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-q', '-m', `init ${label}`);
  git(dir, 'remote', 'add', 'origin', `https://example.com/${label}.git`);
};
try {
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true }); // 非 git 目录，应被过滤
  fs.writeFileSync(path.join(ws, 'docs', 'x.md'), 'not a repo\n');
  makeRepo(path.join(ws, 'banks'), 'dev', 'banks');
  makeRepo(path.join(ws, 'deploy'), 'main', 'deploy');
  makeRepo(path.join(ws, 'adapter'), 'master', 'adapter');
  makeRepo(path.join(ws, 'grp', 'sub', 'deep'), 'feat', 'deep');
  makeRepo(wsRoot, 'main', 'rootrepo');
} catch (e) { console.log(`[FAIL] 夹具自建失败 :: ${why(e)}`); process.exit(1); }

const projectA: any = await post('/api/projects', { name: `T04586默认仓库选择器-${stamp}`, description: '根非仓库 + 多层子仓库' });
await patch(`/api/projects/${projectA.id}`, { workspacePath: ws });
const projectB: any = await post('/api/projects', { name: `T04586根仓库兼容-${stamp}`, description: '根本身就是仓库' });
await patch(`/api/projects/${projectB.id}`, { workspacePath: wsRoot });
ok('U-00 夹具：两个项目分别绑定「根非仓库」与「根即仓库」工作空间', !!projectA.id && !!projectB.id);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const reqs: string[] = [];
const attrOf = (pg: any, sel: string, name: string) => pg.locator(sel).first().getAttribute(name).catch(() => null);
const textOf = (pg: any, sel: string) => pg.locator(sel).first().innerText().catch(() => '');
const hasReq = (frag: string) => reqs.some((u) => u.includes(frag));
/** 平铺首屏要连走「根仓库取数 → /git/repos → 切到真实子仓库再取数」两段异步，
 *  固定 sleep 在慢实例上会把「还没回来」误判成「取不到提交」，一律按行数条件轮询。 */
const waitRows = async (pg: any, predicate: (n: number) => boolean, tries = 60) => {
  for (let i = 0; i < tries; i += 1) {
    const n = await pg.locator('button[data-lck="git-tree-select"]').count();
    if (predicate(n)) return n;
    await pg.waitForTimeout(250);
  }
  return pg.locator('button[data-lck="git-tree-select"]').count();
};
/** 切换仓库后要等「带该 repoSub 的请求已发出 + 新仓库提交行已渲染」两段异步都完成；
 *  各夹具仓库提交数相同（都是 1 条），单看行数会命中切换前的旧结果，故按提交标题判定。 */
const waitCommit = async (pg: any, frag: string, subject: string, tries = 60) => {
  const sel = `button[data-lck="git-tree-select"][aria-label*="${subject}"]`;
  for (let i = 0; i < tries; i += 1) {
    if (hasReq(frag) && (await pg.locator(sel).count()) > 0) return true;
    await pg.waitForTimeout(250);
  }
  return false;
};

/** 用真实用户路径打开「从 Git 树选范围」弹窗（每个场景独立 context，避免 localStorage 串项目） */
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
  /* ---------- F 组 · 发布新鲜度（测的必须是本轮新包） ---------- */
  const distAssets = fs.readdirSync(path.join(ROOT, 'web/dist/assets')).filter((f) => f.endsWith('.js'));
  const distJs = distAssets.map((f) => fs.readFileSync(path.join(ROOT, 'web/dist/assets', f), 'utf8')).join('\n');
  ok('F-01 当前 web/dist 含本轮标记 git-tree-repo-select（非旧包假性通过）', distJs.includes('git-tree-repo-select'));

  /* ---------- A 组 · 默认平铺视图：打开即列出全部仓库 ---------- */
  const { ctx, p } = await openPicker(projectA);
  await p.waitForSelector('[data-lck="git-tree-repo-select"]', { timeout: 30000 });
  await waitRows(p, (n) => n > 0);
  ok('A-01 默认仍是「按时间顺序混合显示」（T04595 裁决未被反转）',
    (await attrOf(p, '[data-lck="git-tree-mode-time"]', 'aria-pressed')) === 'true'
    && (await attrOf(p, '[data-lck="git-tree-repo-view"]', 'aria-pressed')) === 'false');
  ok('A-02 打开弹窗即请求 /git/repos（修复前默认视图从不普查）', hasReq('/api/git/repos'));

  const options = await p.evaluate(() => [...document.querySelectorAll('[data-lck="git-tree-repo-select"] option')]
    .map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' })));
  ok('A-03 仓库选择器列出 4 个仓库，含任意层级嵌套 grp/sub/deep',
    options.length === 4 && options.some((o) => o.value === 'grp/sub/deep'), JSON.stringify(options.map((o) => o.value)));
  ok('A-04 非 git 目录 docs 未被误报为仓库', !options.some((o) => o.value === 'docs'));
  ok('A-05 每项带分支名与 8 位短提交（需求约束 4 的结构化元数据在 GUI 可见）',
    options.some((o) => o.value === 'banks' && /dev/.test(o.text) && /@[0-9a-f]{8}/.test(o.text)),
    JSON.stringify(options.find((o) => o.value === 'banks') ?? {}));
  const defaultVal = await p.locator('[data-lck="git-tree-repo-select"]').inputValue();
  ok('A-06 根非仓库时默认落到真实的子仓库（不再恒定根仓库）', defaultVal !== '' && options.some((o) => o.value === defaultVal), `value=${defaultVal}`);
  ok('A-07 默认视图取数带上该 repoSub（不是根仓库的 /git/log）',
    hasReq(`repoSub=${encodeURIComponent(defaultVal)}`), `value=${defaultVal}`);
  const rows = await p.locator('button[data-lck="git-tree-select"]').count();
  const errText = await p.locator('[data-lck="git-tree-error"]').count() ? await textOf(p, '[data-lck="git-tree-error"]') : '';
  ok('A-08 默认视图拿到该仓库的提交且无「不是 Git 仓库」误报', rows > 0 && !/不是 Git 仓库/.test(errText), `rows=${rows} error=${errText.slice(0, 80)}`);
  ok('A-09 底部仓库标注跟随当前子仓库（不再一律写项目名）',
    (await textOf(p, '[data-lck="git-tree-selected"]')).includes(` · ${defaultVal}`), await textOf(p, '[data-lck="git-tree-selected"]'));

  /* ---------- B 组 · 逐仓库切换（含三级嵌套） ---------- */
  await p.selectOption('[data-lck="git-tree-repo-select"]', 'banks');
  await waitCommit(p, 'repoSub=banks', 'init banks');
  ok('B-01 切到 banks：请求带 repoSub=banks 且取到该仓库提交',
    hasReq('repoSub=banks') && (await p.locator('button[data-lck="git-tree-select"][aria-label*="init banks"]').count()) > 0);
  ok('B-02 切仓库后底部标注同步为 banks', (await textOf(p, '[data-lck="git-tree-selected"]')).includes(' · banks'));
  await p.selectOption('[data-lck="git-tree-repo-select"]', 'grp/sub/deep');
  await waitCommit(p, 'repoSub=grp%2Fsub%2Fdeep', 'init deep');
  ok('B-03 切到三级嵌套 grp/sub/deep：请求带编码后的 repoSub 且取到该仓库提交',
    hasReq('repoSub=grp%2Fsub%2Fdeep') && (await p.locator('button[data-lck="git-tree-select"][aria-label*="init deep"]').count()) > 0);
  ok('B-04 三级嵌套仓库标注正确', (await textOf(p, '[data-lck="git-tree-selected"]')).includes(' · grp/sub/deep'));

  /* ---------- C 组 · 分组视图回归（本轮不得破坏旧聚合能力） ---------- */
  await p.locator('[data-lck="git-tree-repo-view"]').first().click();
  await p.waitForSelector('[data-lck="git-repo-groups"]', { timeout: 60000 });
  await p.locator('[data-lck="git-repo-scanning"]').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
  ok('C-01 切「按仓库分组显示」仍能渲染分支组', (await p.locator('[data-lck="git-repo-group"]').count()) > 0);
  ok('C-02 分组视图隐藏平铺专属的仓库选择器', (await p.locator('[data-lck="git-tree-repo-select"]').count()) === 0);
  await p.locator('[data-lck="git-tree-mode-time"]').first().click();
  await p.waitForSelector('[data-lck="git-tree-repo-select"]', { timeout: 20000 });
  ok('C-03 切回平铺后仓库选择器恢复且保留刚才的仓库坐标',
    (await p.locator('[data-lck="git-tree-repo-select"]').inputValue()) === 'grp/sub/deep');
  await ctx.close();

  /* ---------- D 组 · 向后兼容：根本身就是仓库 ---------- */
  const second = await openPicker(projectB);
  await second.p.waitForSelector('[data-lck="git-tree-repo-select"]', { timeout: 30000 });
  await waitRows(second.p, (n) => n > 0);
  const rootVal = await second.p.locator('[data-lck="git-tree-repo-select"]').inputValue();
  ok('D-01 根是仓库时默认 repoSub 仍为 ""（旧单仓库取数逻辑不变）', rootVal === '', `value=${rootVal}`);
  ok('D-02 单仓库场景仍显示选择器且只有 1 项，提交正常加载',
    (await second.p.locator('[data-lck="git-tree-repo-select"] option').count()) === 1
    && (await second.p.locator('button[data-lck="git-tree-select"]').count()) > 0);
  ok('D-03 单仓库场景不额外按子仓库取数（无 repoSub 参数）', !reqs.some((u) => u.includes(`projectId=${projectB.id}`) && u.includes('repoSub=')));
  await second.ctx.close();
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
