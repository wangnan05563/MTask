/*
 * T04582 验收门：五处「数据标题」悬浮不再倾斜（真实浏览器 computed-transform 取证 + 规则单源守卫）。
 *
 * 工单锚定词（R-318，均为本仓真实存在的路径/词形）：
 *   scripts/verify/T04582-no-title-tilt-ui.mts
 *   web/src/App.tsx  web/src/pages/TasksPage.tsx  web/src/pages/PromptsPage.tsx  web/src/pages/ReqPage.tsx
 *   web/src/ui/NotifyBell.tsx  web/src/ui/GitTreePickerModal.tsx
 *   row-title-btn  data-lck="git-tree-select"  data-t04553="open"  transform: none
 *
 * 三组断言：
 *   A 组 工单点名的 5 个位置逐处真鼠标取证：悬浮「数据标题」按钮后 computed transform 无旋转（b=c=0）
 *       且无缩放（a=d=1 或 none）。任务/提示词/通用需求三页标题本就是 row-title-btn；通知中心行按钮与
 *       Git 树选范围提交标题按钮本轮新增 row-title-btn 类——五处共用 App.tsx 一条 `transform: none` 收口。
 *       取不到坐标/控件未渲染时显式记 BLOCKED 并注明触发条件，绝不静默跳过（工单红线：覆盖全部 5 处不留遗漏）。
 *   B 组 负控制：倾斜体系对「非数据标题」按钮仍然生效——nav-btn 悬浮仍 rotate(-2deg)（matrix b≠0），
 *       证明本轮只摘标题倾斜，没有把全站微交互一刀切（约束：保留其他正常 hover 交互）。
 *   C 组 规则单源 + 发布新鲜度：App.tsx `button.row-title-btn:hover` 必须是 transform:none；五个组件都带
 *       row-title-btn 类；当前 dist 包含该 none 规则且不残留旧的 rotate(-1deg) 标题规则。
 *
 * 前置：隔离后端 MTask_DATA_DIR=<tmp>/data MTask_PORT=39908 MTASK_STATIC_DIR=<repo>/web/dist
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04582-no-title-tilt-ui.mts
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39908';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REPO = process.cwd();
const SHOT = (n: string) => path.join(os.tmpdir(), `t04582-${n.replace(/[^\w]+/g, '-').slice(0, 60)}.png`);

let pass = 0, fail = 0, blocked = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const blockedSite = (name: string, reason: string) => {
  blocked++; console.log(`BLOCKED ${name} :: 触发条件=${reason}`);
};
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

/* ---------- 夹具：五处都要有可渲染的数据行 ---------- */
const stamp = Date.now();
const list: any[] = await (await fetch(`${BASE}/api/projects`)).json();
let project = list.find((p) => p.name.startsWith('T04582 悬停门'));
if (!project) project = await post('/api/projects', { name: `T04582 悬停门项目-${stamp}`, description: '数据标题去倾斜 UI 门夹具' });
await patch(`/api/projects/${project.id}`, { workspacePath: REPO });
const task = await post('/api/tasks', { projectId: project.id, title: `T04582 标题去倾斜门任务-${stamp}` });
// 通知中心要有一条事件：改任务状态即由 TaskService 钩子写一条 status 事件（带 task_no，行按钮 title 含「点击前往任务」）
await patch(`/api/tasks/${task.id}`, { status: 'done' });
// 任务菜单默认只看待办：上面那条已 done 会被滤掉，另留一条 todo 任务供 A1 标题行渲染
await post('/api/tasks', { projectId: project.id, title: `T04582 待办标题行-${stamp}` });
const reqCat = await post('/api/req-categories', { name: `T04582 需求分类-${stamp}` });
await post('/api/req-entries', { categoryId: reqCat.id, title: `T04582 通用需求-${stamp}`, content: '数据标题去倾斜门夹具' });
const promptCat = await post('/api/prompt-categories', { name: `T04582 提示词分类-${stamp}` });
await post('/api/prompts', { categoryId: promptCat.id, title: `T04582 提示词-${stamp}`, content: '数据标题去倾斜门夹具' });

/* ---------- 浏览器 ---------- */
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));

const NAV = { tasks: '任务', req: '通用需求', prompts: '提示词', report: 'AI 工作台' } as const;
async function navTo(key: keyof typeof NAV) {
  const sel = `nav button.nav-btn[aria-label="${NAV[key]}"]`;
  try {
    await page.locator(sel).click({ timeout: 6000 });
  } catch {
    const done = await page.evaluate((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return false;
      el.click();
      return true;
    }, sel);
    if (!done) throw new Error(`页签按钮不存在：${sel}`);
  }
  await page.waitForTimeout(700);
}

/** computed transform 解析：none 或 matrix(a,b,c,d,e,f)。无旋转=b=c=0；无缩放=a=d=1。 */
function noTilt(t: string): boolean {
  if (!t || t === 'none') return true;
  const m = /matrix\(([^)]+)\)/.exec(t);
  if (!m) return false;
  const [a, b, c, d] = m[1].split(',').map(Number);
  return Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && Math.abs(a - 1) < 1e-6 && Math.abs(d - 1) < 1e-6;
}
function hasRotation(t: string): boolean {
  const m = /matrix\(([^)]+)\)/.exec(t || '');
  if (!m) return false;
  const [, b, c] = m[1].split(',').map(Number);
  return Math.abs(b) > 0.01 || Math.abs(c) > 0.01;
}

/** 真鼠标悬浮取样：locator.hover 滚入视野并移鼠标 → 等过渡落定 → 读 computed transform。 */
async function hoverTransform(selector: string): Promise<{ transform: string; hit: string; ok: boolean } | null> {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'attached', timeout: 20000 });
  await loc.evaluate((el: Element) => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
  await page.waitForTimeout(200);
  await loc.hover({ timeout: 8000 });
  await page.waitForTimeout(320);
  return page.evaluate((s: string) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      transform: cs.transform,
      hit: `x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)} vis=${cs.visibility} op=${cs.opacity} pe=${cs.pointerEvents}`,
      ok: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
    };
  }, selector);
}

async function probeTitle(label: string, selector: string, trigger: string) {
  try {
    const st = await hoverTransform(selector);
    if (!st) { blockedSite(label, `${trigger}；取样期间按钮被卸载`); return; }
    if (!st.ok) { blockedSite(label, `${trigger}；按钮不可见 ${st.hit}`); return; }
    ok(`${label} 悬浮无倾斜无缩放`, noTilt(st.transform), `transform=${st.transform} ${st.hit}`);
    await page.screenshot({ path: SHOT(label) }).catch(() => {});
  } catch (e) {
    blockedSite(label, `${trigger}；取样异常：${why(e)}`);
  }
}

/* ---------- 会话态预置 + 使用向导已读（否则全屏遮罩吃掉命中测试，:hover 恒不匹配） ---------- */
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.evaluate((kv: any) => {
  for (const k of Object.keys(kv)) sessionStorage.setItem(k, JSON.stringify(kv[k]));
}, {
  'req.activeCat': reqCat.id,
  'prompts.activeCat': promptCat.id,
  'report.showGitExtract': true,
});
await page.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), project.id);
await page.evaluate((keys: string[]) => {
  for (let i = 0; i < keys.length; i += 1) localStorage.setItem(keys[i], '1');
}, ['mtask.guide.seen.tasks', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req', 'mtask.guide.seen.report',
  'mtask.guide.seen.settings', 'mtask.projectGuide.seen', `guide.dismiss.${project.id}`]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
await page.waitForTimeout(300);

async function freshPage() {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => (document.querySelector('button[aria-label="跳过"]') as HTMLElement | null)?.click());
  await page.waitForTimeout(250);
}
const clickPrep = async (selector: string, timeout = 8000) => {
  try {
    await page.locator(selector).first().click({ timeout });
  } catch {
    const done = await page.evaluate((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return false;
      el.click();
      return true;
    }, selector);
    if (!done) throw new Error(`前置控件不存在：${selector}`);
    await page.waitForTimeout(400);
  }
};

/* ---------- A 组：工单点名的 5 个位置 ---------- */
// A1 任务菜单
try {
  await freshPage(); await navTo('tasks');
  await page.waitForSelector('button.row-title-btn', { timeout: 20000 });
  await probeTitle('A1 任务菜单数据标题（TasksPage.tsx）', 'button.row-title-btn', '需当前项目下有任务行');
} catch (e) { blockedSite('A1 任务菜单数据标题', `前置未达成：${why(e)}`); }

// A2 提示词菜单
try {
  await freshPage(); await navTo('prompts');
  await page.waitForSelector('button.row-title-btn', { timeout: 20000 });
  await probeTitle('A2 提示词菜单数据标题（PromptsPage.tsx）', 'button.row-title-btn', '需该分组内有提示词行');
} catch (e) { blockedSite('A2 提示词菜单数据标题', `前置未达成：${why(e)}`); }

// A3 通用需求菜单
try {
  await freshPage(); await navTo('req');
  await page.waitForSelector('button.row-title-btn', { timeout: 20000 });
  await probeTitle('A3 通用需求菜单数据标题（ReqPage.tsx）', 'button.row-title-btn', '需该分组内有通用需求行');
} catch (e) { blockedSite('A3 通用需求菜单数据标题', `前置未达成：${why(e)}`); }

// A4 通知中心菜单（顶栏铃铛展开浮层里的行按钮）
try {
  await freshPage();
  await clickPrep('button[aria-label^="通知中心"]');
  await page.waitForSelector('button.row-title-btn[title*="点击前往任务"]', { timeout: 15000 });
  await probeTitle('A4 通知中心数据标题（NotifyBell.tsx）', 'button.row-title-btn[title*="点击前往任务"]', '需铃铛浮层内有任务事件行');
} catch (e) { blockedSite('A4 通知中心数据标题', `前置未达成：${why(e)}`); }

// A5 Git 树选范围视图（AI 工作台 Git 提取卡 → 多仓库选范围 → 提交标题按钮）
try {
  await freshPage(); await navTo('report');
  await page.waitForSelector('[data-t03366="git-scope-picker"]', { timeout: 20000 });
  // T04595：项目多选改下拉条，先展开触发钮再勾选项目复选项
  await clickPrep('[data-t04595="project-dropdown-trigger"]');
  await page.waitForTimeout(250);
  await clickPrep(`input[aria-label^="纳入项目 T04582"]`);
  await page.waitForTimeout(500);
  await clickPrep('[data-t04553="open"]');
  // T04595：多仓库入口默认平铺（取消默认分支聚合）；若仍处聚合态则切回平铺单仓库视图，
  // 同一颗 git-tree-select 提交标题按钮直接渲染，取证对象不变（row-title-btn 类同一条 CSS 收口）
  await page.waitForSelector('[data-lck="git-tree-repo-view"]', { timeout: 20000 });
  if ((await page.locator('[data-lck="git-tree-repo-view"]').getAttribute('aria-pressed')) === 'true') {
    await clickPrep('[data-lck="git-tree-repo-view"]');
    await page.waitForTimeout(500);
  }
  await clickPrep('button[aria-label="重新取数"]').catch(() => {});
  await page.waitForSelector('button.row-title-btn[data-lck="git-tree-select"]', { timeout: 25000 });
  await probeTitle('A5 Git 树选范围数据标题（GitTreePickerModal.tsx）', 'button.row-title-btn[data-lck="git-tree-select"]', '需多仓库选范围弹窗加载出提交行');
} catch (e) { blockedSite('A5 Git 树选范围数据标题', `前置未达成：${why(e)}`); }

/* ---------- B 组：负控制——非数据标题按钮的倾斜体系仍在 ---------- */
try {
  await freshPage();
  const navSel = 'nav button.nav-btn[aria-label="通用需求"]';
  const st = await hoverTransform(navSel);
  if (!st) { blockedSite('B1 nav-btn 负控制', '导航按钮被卸载'); }
  else {
    ok('B1 负控制：nav-btn 悬浮仍倾斜（倾斜体系未被一刀切）', hasRotation(st.transform), `transform=${st.transform} ${st.hit}`);
  }
} catch (e) { blockedSite('B1 nav-btn 负控制', `取样异常：${why(e)}`); }

/* ---------- C 组：规则单源 + 发布新鲜度 ---------- */
const src = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const appCss = src('web/src/App.tsx');
ok('C-01 App.tsx 标题悬浮规则收口为 transform:none',
  /button\.row-title-btn:hover:not\(:disabled\)\s*\{\s*transform:\s*none;?\s*\}/.test(appCss),
  'button.row-title-btn:hover:not(:disabled) { transform: none; }');
ok('C-02 App.tsx 不再残留旧的标题 rotate(-1deg) 倾斜',
  !/button\.row-title-btn:hover[^}]*rotate\(-1deg\)/.test(appCss), '旧 T00890 微倾斜已摘');
ok('C-03 全局 button 倾斜仍排除 row-title-btn（标题不走兜底 rotate）',
  /button:hover:not\(:disabled\)[^}]*:not\(\.row-title-btn\)/.test(appCss), '全局兜底 :not(.row-title-btn) 仍在');
const classSites: [string, string][] = [
  ['web/src/pages/TasksPage.tsx', '任务'],
  ['web/src/pages/PromptsPage.tsx', '提示词'],
  ['web/src/pages/ReqPage.tsx', '通用需求'],
  ['web/src/ui/NotifyBell.tsx', '通知中心'],
  ['web/src/ui/GitTreePickerModal.tsx', 'Git 树选范围'],
];
const missingClass = classSites.filter(([f]) => !/className="row-title-btn"/.test(src(f))).map(([, l]) => l);
ok('C-04 五个组件的数据标题按钮都带 row-title-btn 类（覆盖全部 5 处不留遗漏）',
  missingClass.length === 0, missingClass.length ? `缺类：${missingClass.join('、')}` : '任务/提示词/通用需求/通知中心/Git 树选范围 齐');
ok('C-05 Git 树提交标题按钮带类且保留 data-lck 锚（点选语义不变）',
  /className="row-title-btn" data-lck="git-tree-select"/.test(src('web/src/ui/GitTreePickerModal.tsx')), 'GitTreePickerModal.tsx');
const bundleDir = path.join(REPO, 'web/dist/assets');
let bundleNone = false, bundleLegacy = false;
if (fs.existsSync(bundleDir)) {
  for (const f of fs.readdirSync(bundleDir)) {
    if (!/\.(js|css)$/.test(f)) continue;
    const s = fs.readFileSync(path.join(bundleDir, f), 'utf8');
    if (/button\.row-title-btn:hover:not\(:disabled\)\s*\{\s*transform:\s*none/.test(s)) bundleNone = true;
    if (/button\.row-title-btn:hover:not\(:disabled\)\s*\{\s*transform:\s*scale\(1\.02\)\s*rotate\(-1deg\)/.test(s)) bundleLegacy = true;
  }
}
ok('C-06 发布新鲜度：当前 dist 含标题 transform:none 规则', bundleNone, 'web/dist/assets 逐文件核对');
ok('C-07 发布新鲜度：当前 dist 不残留旧标题 rotate(-1deg) 规则', !bundleLegacy, '旧规则已随重打包清除');

await page.screenshot({ path: SHOT('final') }).catch(() => {});
await browser.close();

console.log(`\nA 组位置：5 个（工单点名）+ B 组负控制 1 + C 组守卫 7`);
console.log(`PASS=${pass} FAIL=${fail} BLOCKED=${blocked}`);
if (fail > 0 || blocked > 0) process.exitCode = 1;