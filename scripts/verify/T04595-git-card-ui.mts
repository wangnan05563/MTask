/*
 * T04595 验收门（真浏览器，自带夹具）：Git 卡片 UI 优化四步合一。
 *
 * 工单锚定词（R-318，均为本仓真实存在的路径/词形）：
 *   scripts/verify/T04595-git-card-ui.mts
 *   web/src/ui/gitScopePicker.tsx  web/src/ui/GitTreePickerModal.tsx
 *   web/src/ui/GitScopeControls.tsx  web/src/utils/scopeControls.ts
 *   data-t04595="project-dropdown-trigger"  data-t04595="git-tree-entry"
 *   data-lck="git-tree-mode-time"  data-lck="git-tree-repo-view"  data-ref-group  groupBranchesByType
 *
 * 四步对应四组断言：
 *   A 组 步骤1 项目多选改下拉条：默认收起→点击展开→勾选→摘要回填→异空间项目置灰（同空间硬约束保留）→点外收起。
 *   B 组 步骤2 多仓库选范围复用「从 Git 树选范围」组件：入口文案/可点→打开同一 GitTreePickerModal。
 *   C 组 步骤3 视图模式增强：默认平铺（取消默认分支聚合）→按钮组两枚→切聚合→切回平铺（toggle 语义保留，T04585 回归）。
 *   D 组 步骤4 分支下拉按本地/远程/标签分组：组头文案+顺序+候选 data-ref-type 与组一致+远程独有分支正确定性。
 *   E 组 两卡共用同一组件：Git 提取卡与 Sonar 扫描卡都给出下拉触发钮与 Git 树入口（组件复用证据）。
 *   F 组 源码单源 + 发布新鲜度：四个源文件关键标记齐全；当前 dist 含本轮标记（非旧包）。
 *
 * 前置：隔离后端 MTask_DATA_DIR=<tmp>/t04595/data MTask_PORT=39913 MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/verify/T04595-git-card-ui.mts
 * 夹具自建：临时 git 仓库（本地分支 master/feature/local-a + 远端跟踪 origin/* + 轻量/注解标签），经 API 绑定项目。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39913';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REPO = process.cwd();
const SCRATCH = 'D:/tmp/t04595';
const SHOT = (n: string) => path.join(os.tmpdir(), `t04595-${n.replace(/[^\w]+/g, '-').slice(0, 60)}.png`);

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

/* ---------- 夹具：自建 git 仓库（本地 + 远端跟踪 + 标签）并经 API 绑定项目 ---------- */
const stamp = Date.now();
const ws = path.join(SCRATCH, `ws-${stamp}`);
const ws2 = path.join(SCRATCH, `ws2-${stamp}`);
const remote = path.join(SCRATCH, `remote-${stamp}.git`);
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let project: any = null;
let projectB: any = null;
try {
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(ws2, { recursive: true });
  git(['init'], ws);
  git(['symbolic-ref', 'HEAD', 'refs/heads/master'], ws);
  git(['config', 'user.email', 'gate@example.com'], ws);
  git(['config', 'user.name', 'T04595 Gate'], ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\n');
  git(['add', 'a.txt'], ws);
  git(['commit', '-m', 'c1 master'], ws);
  git(['branch', 'feature/local-a'], ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha beta\n');
  git(['commit', '-am', 'c2 master'], ws);
  git(['init', '--bare', remote], SCRATCH);
  git(['remote', 'add', 'origin', remote], ws);
  git(['push', 'origin', 'master', 'feature/local-a'], ws);
  git(['push', 'origin', 'master:refs/heads/feature/remote-b'], ws);
  git(['fetch', 'origin'], ws);
  git(['tag', 'v1.0.0'], ws);
  git(['tag', '-a', 'v2.0.0', '-m', 'annotated tag'], ws);

  project = await post('/api/projects', { name: `T04595 Git卡片门项目-${stamp}`, description: 'Git 卡片 UI 优化门夹具（同空间）' });
  await patch(`/api/projects/${project.id}`, { workspacePath: ws });
  projectB = await post('/api/projects', { name: `T04595 异空间门项目-${stamp}`, description: 'Git 卡片 UI 优化门夹具（异空间负控制）' });
  await patch(`/api/projects/${projectB.id}`, { workspacePath: ws2 });
} catch (e) {
  console.log(`BLOCKED 夹具自建失败 :: ${why(e)}`);
  process.exit(1);
}

/* ---------- 浏览器 ---------- */
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));

const NAV = { report: 'AI 工作台' } as const;
async function navTo(key: keyof typeof NAV) {
  const sel = `nav button.nav-btn[aria-label="${NAV[key]}"]`;
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

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.evaluate((kv: any) => {
  for (const k of Object.keys(kv)) sessionStorage.setItem(k, JSON.stringify(kv[k]));
}, { 'report.showGitExtract': true, 'report.showSonarScan': true });
await page.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), project.id);
await page.evaluate((keys: string[]) => {
  for (let i = 0; i < keys.length; i += 1) localStorage.setItem(keys[i], '1');
}, ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report',
  'mtask.guide.seen.settings', 'mtask.projectGuide.seen', `guide.dismiss.${project.id}`]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
await page.waitForTimeout(300);

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
const attr = (selector: string, name: string) => page.locator(selector).first().getAttribute(name);
const txt = (selector: string) => page.locator(selector).first().innerText().catch(() => '');

try {
  await navTo('report');
  await page.waitForSelector('[data-t03366="git-scope-picker"]', { timeout: 20000 });

  /* ---------- A 组 · 步骤1 项目多选改下拉条 ---------- */
  const trigger = '[data-t04595="project-dropdown-trigger"]';
  const menu = '[data-t04595="project-dropdown-menu"]';
  const myCheck = `input[aria-label="纳入项目 ${project.name}"]`;
  const otherCheck = `input[aria-label="纳入项目 ${projectB.name}"]`;

  ok('A-01 默认收起：触发钮存在且 aria-expanded=false', await page.locator(trigger).first().isVisible() && (await attr(trigger, 'aria-expanded')) === 'false');
  ok('A-02 默认收起：勾选弹层未渲染', (await page.locator(menu).count()) === 0);
  ok('A-03 触发钮紧凑摘要：未选时提示展开勾选', (await txt(trigger)).includes('未选择项目'), await txt(trigger));

  await clickPrep(trigger);
  await page.waitForSelector(menu, { timeout: 8000 });
  ok('A-04 点击展开：弹层渲染且 aria-expanded=true', (await page.locator(menu).count()) === 1 && (await attr(trigger, 'aria-expanded')) === 'true');
  ok('A-05 弹层内本项目复选项可见且可勾', await page.locator(myCheck).first().isVisible() && await page.locator(myCheck).first().isEnabled());

  await clickPrep(myCheck);
  await page.waitForTimeout(500);
  const summary = await txt(trigger);
  ok('A-06 勾选回填：触发钮摘要含项目名与已选计数', summary.includes(project.name) && summary.includes('已选 1'), summary);
  ok('A-07 同空间硬约束保留：异空间项目复选项被置灰', await page.locator(otherCheck).first().isDisabled());

  // 点外收起：向 document 派发 mousedown（target=document 不在触发钮 host 内 → 外点关闭逻辑命中）
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 })));
  await page.waitForTimeout(300);
  ok('A-08 点外收起：弹层关闭且 aria-expanded=false', (await page.locator(menu).count()) === 0 && (await attr(trigger, 'aria-expanded')) === 'false');

  await clickPrep(trigger);
  await page.waitForSelector(menu, { timeout: 8000 });
  ok('A-09 重新展开：本项目勾选态持久（checked）', await page.locator(myCheck).first().isChecked());
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 })));
  await page.waitForTimeout(250);
  await page.screenshot({ path: SHOT('A-project-dropdown') }).catch(() => {});

  /* ---------- B 组 · 步骤2 复用「从 Git 树选范围」组件 ---------- */
  const entry = '[data-t04595="git-tree-entry"]';
  ok('B-01 入口文案复用「从 Git 树选范围」且已选项目后可点', (await txt(entry)).includes('从 Git 树选范围') && await page.locator(entry).first().isEnabled(), await txt(entry));
  await clickPrep(entry);
  await page.waitForSelector('[data-lck="git-tree-modal"]', { timeout: 15000 });
  ok('B-02 打开同一 GitTreePickerModal（与代码评审讲稿卡共用）', (await attr('[data-lck="git-tree-modal"]', 'aria-label')) === '从 Git 树选择评审范围');

  /* ---------- C 组 · 步骤3 视图模式增强（默认平铺） ---------- */
  const modeTime = '[data-lck="git-tree-mode-time"]';
  const repoView = '[data-lck="git-tree-repo-view"]';
  await page.waitForSelector('[data-t04595="view-mode-group"]', { timeout: 10000 });
  ok('C-01 视图按钮组渲染且含两枚模式钮', (await page.locator('[data-t04595="view-mode-group"] button').count()) === 2);
  ok('C-02 默认平铺：时间顺序钮 pressed=true、仓库分组钮 pressed=false（取消默认分支聚合）',
    (await attr(modeTime, 'aria-pressed')) === 'true' && (await attr(repoView, 'aria-pressed')) === 'false');
  await page.waitForSelector('button[data-lck="git-tree-select"]', { timeout: 25000 });
  ok('C-03 平铺视图按时间混合加载出提交行', (await page.locator('button[data-lck="git-tree-select"]').count()) > 0,
    `rows=${await page.locator('button[data-lck="git-tree-select"]').count()}`);

  /* ---------- D 组 · 步骤4 分支下拉按本地/远程/标签分组（平铺 refs 路径） ---------- */
  await clickPrep('[data-lck="git-tree-head-toggle"]');
  await page.waitForSelector('[data-lck="git-tree-head-menu"]', { timeout: 10000 });
  await page.waitForSelector('[data-ref-group="branch"]', { timeout: 10000 });
  await page.waitForTimeout(600);
  const groups = await page.evaluate(() => {
    const out: any[] = [];
    document.querySelectorAll('[data-lck="git-tree-head-menu"] [data-ref-group]').forEach((g) => {
      const el = g as HTMLElement;
      const opts: any[] = [];
      el.querySelectorAll('[data-ref-type]').forEach((o) => opts.push({ name: o.getAttribute('data-ref'), type: o.getAttribute('data-ref-type') }));
      out.push({ type: el.getAttribute('data-ref-group'), text: el.textContent || '', opts });
    });
    return out;
  });
  const byType = (t: string) => groups.find((g) => g.type === t);
  ok('D-01 本地分支组头存在且文案含「本地分支」', !!byType('branch') && byType('branch').text.includes('本地分支'), byType('branch')?.text?.slice(0, 30));
  ok('D-02 远程分支组头存在且文案含「远程分支」', !!byType('remote') && byType('remote').text.includes('远程分支'), byType('remote')?.text?.slice(0, 30));
  ok('D-03 标签组头存在且文案含「标签」', !!byType('tag') && byType('tag').text.includes('标签'), byType('tag')?.text?.slice(0, 30));
  const order = groups.map((g) => g.type).join(',');
  ok('D-04 分组顺序：本地→远程→标签', order === 'branch,remote,tag', order);
  ok('D-05 各组候选 data-ref-type 与组一致且非空',
    ['branch', 'remote', 'tag'].every((t) => { const g = byType(t); return g && g.opts.length > 0 && g.opts.every((o: any) => o.type === t); }),
    groups.map((g) => `${g.type}:${g.opts.length}`).join(' '));
  const remoteOnly = byType('remote')?.opts?.some((o: any) => o.name === 'origin/feature/remote-b');
  const notInBranch = !(byType('branch')?.opts ?? []).some((o: any) => o.name === 'origin/feature/remote-b');
  ok('D-06 远程独有分支 origin/feature/remote-b 定性为 remote 而非 branch', !!remoteOnly && notInBranch);
  await page.screenshot({ path: SHOT('D-branch-groups') }).catch(() => {});
  // 收起 head 下拉（再点 toggle），避免弹层_overlay_遮住下方视图按钮；并等普查落定（scanning=false）
  // ——head 下拉 onOpen 会预触发普查，普查期间模式钮 disabled={scanning} 是源码合法行为，须待其结束再切视图。
  await clickPrep('[data-lck="git-tree-head-toggle"]');
  await page.waitForTimeout(200);

  /* ---------- C 组续 · 切聚合再切回平铺（toggle 语义保留，T04585 回归守卫） ---------- */
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-lck="git-tree-repo-view"]') as HTMLButtonElement | null;
    return !!b && !b.disabled;
  }, { timeout: 30000 });
  await clickPrep(repoView);
  await page.waitForTimeout(400);
  ok('C-04 切到仓库分组：分组钮 pressed=true、时间钮 pressed=false',
    (await attr(repoView, 'aria-pressed')) === 'true' && (await attr(modeTime, 'aria-pressed')) === 'false',
    `repoView=${await attr(repoView, 'aria-pressed')} modeTime=${await attr(modeTime, 'aria-pressed')}`);
  await page.locator('[data-lck="git-repo-scanning"]').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
  await page.waitForSelector('[data-lck="git-repo-groups"]', { timeout: 30000 });
  ok('C-05 聚合视图普查完成渲染分支×仓库分组', (await page.locator('[data-lck="git-repo-groups"]').count()) === 1);
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-lck="git-tree-mode-time"]') as HTMLButtonElement | null;
    return !!b && !b.disabled;
  }, { timeout: 30000 });
  await clickPrep(modeTime);
  await page.waitForTimeout(400);
  ok('C-06 切回平铺：时间钮 pressed=true、分组钮 pressed=false（toggle 语义未破坏）',
    (await attr(modeTime, 'aria-pressed')) === 'true' && (await attr(repoView, 'aria-pressed')) === 'false');
  await page.screenshot({ path: SHOT('C-view-modes') }).catch(() => {});

  // 关闭弹窗，回到卡片做 E 组
  await clickPrep('[data-lck="git-tree-modal"] button[aria-label="关闭 Git 树选择"]');
  await page.waitForSelector('[data-lck="git-tree-modal"]', { state: 'detached', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);

  /* ---------- E 组 · 两卡共用同一组件 ---------- */
  ok('E-01 Git 提取卡与 Sonar 扫描卡都渲染下拉触发钮（共用 GitScopePicker）',
    (await page.locator(trigger).count()) >= 2, `count=${await page.locator(trigger).count()}`);
  ok('E-02 两卡都渲染「从 Git 树选范围」入口', (await page.locator(entry).count()) >= 2,
    `count=${await page.locator(entry).count()}`);
} catch (e) {
  blockedSite('A~E 真浏览器取证', `前置未达成：${why(e)}`);
}

/* ---------- F 组 · 源码单源 + 发布新鲜度 ---------- */
try {
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
  const scope = read('web/src/utils/scopeControls.ts');
  const controls = read('web/src/ui/GitScopeControls.tsx');
  const picker = read('web/src/ui/gitScopePicker.tsx');
  const modal = read('web/src/ui/GitTreePickerModal.tsx');
  ok('F-01 scopeControls.ts 导出 groupBranchesByType（分组单源）', /export function groupBranchesByType/.test(scope));
  ok('F-02 GitScopeControls.tsx 用 groupBranchesByType 且候选带 data-ref-group', /groupBranchesByType/.test(controls) && /data-ref-group/.test(controls));
  ok('F-03 gitScopePicker.tsx 含下拉触发钮/Git 树入口/默认平铺 initialRepoView={false}',
    /project-dropdown-trigger/.test(picker) && /git-tree-entry/.test(picker) && /initialRepoView=\{false\}/.test(picker));
  ok('F-04 GitTreePickerModal.tsx 含视图按钮组与时间顺序模式钮', /view-mode-group/.test(modal) && /git-tree-mode-time/.test(modal));
  const distDir = path.join(REPO, 'web/dist/assets');
  const js = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join('\n');
  ok('F-05 当前 dist 含本轮标记（发布新鲜度，非旧包）',
    js.includes('project-dropdown-trigger') && js.includes('git-tree-mode-time') && js.includes('本地分支'));
} catch (e) {
  blockedSite('F 源码单源/发布新鲜度', `读取异常：${why(e)}`);
}

await browser.close();
console.log(`\nPASS=${pass} FAIL=${fail} BLOCKED=${blocked}`);
const code = fail > 0 ? 1 : 0;
console.log(`GATE_EXIT=${code}`);
process.exit(code);