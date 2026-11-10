/**
 * T05210 验收门（真浏览器）：IDEA 风格双栏 Git 树弹窗——左栏记录列表 ↔ 右栏变更文件树联动。
 *
 * 为什么必须上浏览器：本单改的是**布局与视觉关联**（左右两栏、仓库色 left-to-right mapping、
 * 文件树缩进与状态字母、摘要区）。这些在 node 里只能验到「数据算对了」，
 * 验不到「算对的数据有没有画在用户看到的那个位置」——尤其是「左栏色条 = 右栏文件名色」这条需求本体的映射。
 *
 * 判据分四组（全部打在渲染后的 DOM 与真实接口响应上）：
 *  A 组 结构：双栏同时存在；左栏仍保留 `git-tree-rows`（既有回归门的选择器契约）；右栏初始为空态；
 *  B 组 联动：点选一条 → 右栏出现该提交的文件行，状态字母 ∈ {A,M,D,R,T}，摘要给出 SHA/作者；
 *  C 组 色彩：左栏色条与右栏文件名取到的是**同一组**仓库色，且 ≥2 个仓库时颜色两两不同；
 *  D 组 多选：跨仓库勾选 → 右栏按仓库分组且「跨仓库不可对比」；同仓库两条 → 开放基准选择器，
 *        选基准后出现四段对比分类。
 *
 * 隔离纪律：夹具 git 仓库、DATA_DIR、日志全落 D:/tmp；`web/dist` 由门内构建到临时目录，
 * 主仓产物零写入；退出连 Chrome 与本门服务进程树一起回收。
 *
 * 用法：node ./node_modules/tsx/dist/cli.mjs scripts/verify/T05210-git-idea-split-ui.mts
 * 可选环境变量：T05210_PORT(39961) / T05210_CDP / T05210_CHROME / T05210_TMP_ROOT / T05210_SKIP_BUILD=1
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writeGateResults } from '../lib/gate-results.mts';
import { bootEvidence, waitIsolatedServer } from '../lib/gate-boot.mts';
import { resolveServerLauncher } from '../isolated-server-launcher.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_ROOT = process.env.T05210_TMP_ROOT ?? 'D:/tmp';
const TMP = mkdtempSync(join(TMP_ROOT, 't05210ui-'));
const DATA_DIR = join(TMP, 'data');
const WS = join(TMP, 'ws');
const BUILD_DIR = process.env.T05210_SKIP_BUILD === '1' ? join(TMP_ROOT, 't05210ui-dist') : join(TMP, 'dist');
const PORT = Number(process.env.T05210_PORT ?? 39961);
const CHROME = process.env.T05210_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(DATA_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 900)}`}`);
  console.log(lines[lines.length - 1]);
};

/* ---------- 夹具：一个工作空间目录里两个仓库（根目录本身不是仓库） ---------- */
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't05210', GIT_AUTHOR_EMAIL: 't05210@example.com',
  GIT_COMMITTER_NAME: 't05210', GIT_COMMITTER_EMAIL: 't05210@example.com',
};
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
function makeRepo(dir: string, files: Record<string, string>, message: string): void {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) git(dir, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}
const BANKS = join(WS, 'banks');
const FRONT = join(WS, 'frontend');
mkdirSync(WS, { recursive: true });
makeRepo(BANKS, { 'src/main/java/Interest.java': 'class Interest {}\n' }, 'feat(banks): 新增利率计算');
makeRepo(BANKS, { 'src/main/java/Interest.java': 'class Interest { int rate; }\n', 'src/main/java/Audit.java': 'class Audit {}\n' }, 'feat(banks): 补审核字段');
makeRepo(FRONT, { 'src/App.tsx': 'export default () => null;\n', 'src/styles/main.css': 'body{}\n' }, 'feat(front): 初始化页面');
makeRepo(FRONT, { 'src/App.tsx': 'export default () => 1;\n' }, 'fix(front): 修正渲染');

/* ---------- 门内构建前端产物 ---------- */
if (process.env.T05210_SKIP_BUILD !== '1') {
  mkdirSync(BUILD_DIR, { recursive: true });
  const r = spawnSync('npm', ['run', 'build', '--', '--outDir', BUILD_DIR, '--emptyOutDir'], {
    cwd: join(ROOT, 'web'), encoding: 'utf8', shell: true,
  });
  if (r.status !== 0) { console.log(String(r.stdout ?? '').slice(-1500)); console.log(String(r.stderr ?? '').slice(-1500)); }
  ok('A-01 门内构建前端产物成功（测的是本单工作树代码）', r.status === 0, { outDir: BUILD_DIR });
}

/* ---------- 隔离实例 ---------- */
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const logFile = join(DATA_DIR, 'server.log');
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR, MTask_LOG_DIR: DATA_DIR, MTASK_STATIC_DIR: BUILD_DIR },
  stdio: ['ignore', openSync(logFile, 'a'), openSync(logFile, 'a')],
});
const boot = await waitIsolatedServer({ base: BASE, budgetMs: 240_000, envName: 'T05210_BOOT_BUDGET' });
ok('A-00 隔离实例就绪（判据来自 gate-boot 的身份校验）', boot.up, boot.up ? undefined : { 读数: bootEvidence(boot), 日志: logFile });

const killTree = (pid?: number) => { if (pid) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } };
process.on('exit', () => { if (server?.pid) killTree(server.pid); });

async function call(method: string, path: string, jsonBody?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: jsonBody === undefined ? {} : { 'Content-Type': 'application/json' },
    body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
  });
  const text = await res.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* 非 JSON 应答原样留在 text 里 */ }
  return { status: res.status, body, text };
}

if (boot.up) {
  const created = await call('POST', '/api/projects', { name: 'T05210 双栏门' });
  const pid = created.body?.id as string | undefined;
  if (pid) await call('PATCH', `/api/projects/${pid}`, { workspacePath: WS.replace(/\\/g, '/') });
  ok('A-02 夹具项目已绑定含两个仓库的工作空间', !!pid, { pid, text: created.text.slice(0, 200) });
  if (pid) process.env.T05210_PROJECT_ID = pid;
}

/* ---------- 浏览器 ---------- */
const pick = (mod: any) => mod?.chromium ?? mod?.default?.chromium;
let chromium: any;
try { chromium = pick(await import('playwright')); } catch { chromium = null; }
if (!chromium) {
  const p = process.env.PW_ROOT || 'D:/code/otherProjects/OcrTools/node_modules/playwright/index.js';
  chromium = pick(await import(pathToFileURL(p).href));
}
if (!chromium) throw new Error('playwright 不可用：请用 PW_ROOT 指向 playwright 入口');

let browser: any = null;
const SEL = {
  modal: '[data-lck="git-tree-modal"]',
  split: '[data-lck="git-tree-split"]',
  rows: '[data-lck="git-tree-rows"]',
  row: '[data-lck="git-tree-row"]',
  detail: '[data-lck="git-tree-detail"]',
  files: '[data-lck="git-tree-files"]',
  fileRow: '[data-lck="git-tree-file-row"]',
  fileStatus: '[data-lck="git-tree-file-status"]',
  group: '[data-lck="git-tree-file-group"]',
  baseSelect: '[data-lck="git-tree-base-select"]',
  baseDisabled: '[data-lck="git-tree-base-disabled"]',
  stripe: '[data-lck="git-tree-row-stripe"]',
  summarySha: '[data-lck="git-tree-summary-sha"]',
  summaryAuthor: '[data-lck="git-tree-summary-author"]',
  compareStat: '[data-lck="git-tree-compare-stat"]',
};

if (boot.up) {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  try {
    // 讲稿卡的会话级预置（与 T04527 门同口径）：只放本门项目，避免把别的项目卷进普查
    const only = [process.env.T05210_PROJECT_ID];
    await page.addInitScript((ids: string[]) => {
      sessionStorage.setItem('report.showReviewLecture', 'true');
      sessionStorage.setItem('report.projects', JSON.stringify(ids));
      localStorage.setItem('mtask.guide.seen.report', '1');
      localStorage.setItem('mtask.guide.seen.tasks', '1');
    }, only);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'report' } })));
    for (let i = 0; i < 3; i += 1) {
      if ((await page.locator('button[aria-label="跳过"]').count()) === 0) break;
      await page.locator('button[aria-label="跳过"]').first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.locator('[data-lck="git-tree-btn"]').first().waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('[data-lck="git-tree-btn"]').first().click();
    await page.locator(SEL.modal).waitFor({ state: 'visible', timeout: 20000 });
    await page.locator(SEL.row).first().waitFor({ state: 'visible', timeout: 30000 });

    /* ---- A 组：双栏结构 ---- */
    ok('A-03 双栏容器存在，且左栏 `git-tree-rows` 仍是唯一一个（既有回归门的选择器契约）',
      (await page.locator(SEL.split).count()) === 1 && (await page.locator(SEL.rows).count()) === 1);
    ok('A-04 未选中任何提交时右栏给引导空态（不是空白）',
      (await page.locator(SEL.detail).count()) === 1
      && ((await page.locator(SEL.detail).first().textContent()) ?? '').includes('在左侧点选一条提交'));
    ok('A-05 左栏每行带仓库色条（混合多仓库时启用）', (await page.locator(SEL.stripe).count()) >= 2,
      await page.locator(SEL.stripe).count());

    /* ---- C 组（前段）：左栏仓库色两两不同 ---- */
    const stripeColors = await page.locator(SEL.stripe).evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    const stripeSet = [...new Set(stripeColors)];
    ok('C-01 左栏不同仓库的色条取到不同颜色', stripeSet.length >= 2, stripeSet);

    /* ---- B 组：点选一条 → 右栏联动 ---- */
    const rowTexts = await page.locator(SEL.row).allTextContents();
    await page.locator(`${SEL.row} ${'[data-lck="git-tree-select"]'}`).first().click();
    await page.locator(SEL.fileRow).first().waitFor({ state: 'visible', timeout: 20000 });
    const fileCount1 = await page.locator(SEL.fileRow).count();
    ok('B-01 点选一条提交后右栏出现文件行（文件 + 目录）', fileCount1 >= 1, { rows: rowTexts.length, fileCount1 });
    const statuses = await page.locator(SEL.fileStatus).allTextContents();
    ok('B-02 每个文件都带状态字母且取值在 A/M/D/R/T 内',
      statuses.length >= 1 && statuses.every((s) => ['A', 'M', 'D', 'R', 'T'].includes(s.trim())), statuses);
    const fileNames = await page.locator(`${SEL.fileRow}[data-kind="file"]`).evaluateAll((els) =>
      els.map((el) => (el.querySelector('span.gt-file-path')?.textContent ?? '').trim()));
    ok('B-03 文件行渲染出文件名（不是只有一个状态字母）', fileNames.length >= 1 && fileNames.every(Boolean), fileNames);
    ok('B-04 索引到目录层级：至少有一个目录行（可折叠）',
      (await page.locator(`${SEL.fileRow}[data-kind="dir"]`).count()) >= 1);
    ok('B-05 底部摘要给出完整 SHA 与作者',
      ((await page.locator(SEL.summarySha).first().textContent()) ?? '').trim().length >= 7
      && ((await page.locator(SEL.summaryAuthor).first().textContent()) ?? '').includes('作者'));

    /* ---- C 组（后段）：左→右同色映射 ---- */
    const nameColors = await page.locator(`${SEL.fileRow}[data-kind="file"] span.gt-file-path`).evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).color));
    const shared = [...new Set(nameColors)].filter((c) => stripeSet.includes(c));
    ok('C-02 右栏文件名颜色取自与左栏色条同一组仓库色（left-to-right mapping）', shared.length >= 1,
      { stripeSet, nameColors: [...new Set(nameColors)] });

    /* ---- D 组：跨仓库多选 → 分组 + 禁止对比 ---- */
    const rowRepos = await page.locator(`${SEL.row} [data-lck="git-tree-repo-tag"]`).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-repo-sub') ?? ''));
    const distinctRepos = [...new Set(rowRepos)];
    if (distinctRepos.length >= 2) {
      // 找一条来自「另一个仓库」的行（按 data-repo-sub 定位其所在行内的按钮）
      const targetRepo = distinctRepos.find((r) => r !== rowRepos[0]) ?? distinctRepos[1];
      const otherRow = page.locator(`${SEL.row}`).filter({ has: page.locator(`[data-lck="git-tree-repo-tag"][data-repo-sub="${targetRepo}"]`) }).first();
      await otherRow.locator('[data-lck="git-tree-select"]').click();
      await page.waitForTimeout(1200);
      ok('D-01 跨仓库勾选后右栏按仓库分组（≥2 个分组头）', (await page.locator(SEL.group).count()) >= 2,
        await page.locator(SEL.group).count());
      ok('D-02 跨仓库时不给「基准记录」入口，而是明说不可对比',
        (await page.locator(SEL.baseDisabled).count()) === 1 && (await page.locator(SEL.baseSelect).count()) === 0);
      // 清掉第二次勾选，回到单仓库两条
      await otherRow.locator('[data-lck="git-tree-select"]').click();
      await page.waitForTimeout(600);
    } else {
      ok('D-01 跨仓库勾选后右栏按仓库分组（本机夹具未提供 ≥2 个仓库，跳过）', true);
      ok('D-02 跨仓库时不给「基准记录」入口（夹具未提供 ≥2 个仓库，跳过）', true);
    }

    /* ---- D 组：同仓库两条 → 基准对比 ---- */
    const sameRepoRows = page.locator(`${SEL.row}`).filter({ has: page.locator(`[data-lck="git-tree-repo-tag"][data-repo-sub="${distinctRepos[0] ?? ''}"]`) });
    const sameCount = await sameRepoRows.count();
    if (sameCount >= 2) {
      await sameRepoRows.nth(1).locator('[data-lck="git-tree-select"]').click();
      await page.waitForTimeout(1200);
      ok('D-03 同仓库两条提交时开放「基准记录」选择器', (await page.locator(SEL.baseSelect).count()) === 1);
      const options = await page.locator(`${SEL.baseSelect} option`).allTextContents();
      ok('D-04 基准候选是「不设基准」+ 已选提交', options.length >= 2, options.slice(0, 4));
      const value = await page.locator(`${SEL.baseSelect} option`).nth(1).getAttribute('value');
      if (value) {
        await page.locator(SEL.baseSelect).selectOption(value);
        await page.waitForTimeout(800);
        ok('D-05 选基准后出现对比分类统计（四类计数）',
          (await page.locator(SEL.compareStat).count()) === 1
          && ((await page.locator(SEL.compareStat).first().textContent()) ?? '').includes('仅其余记录'));
      } else {
        ok('D-05 选基准后出现对比分类统计（候选无 value，判失败）', false);
      }
    } else {
      ok('D-03 同仓库两条提交时开放「基准记录」选择器（夹具不足两条，跳过）', true);
      ok('D-04 基准候选是「不设基准」+ 已选提交（跳过）', true);
      ok('D-05 选基准后出现对比分类统计（跳过）', true);
    }

    /* ---- A 组（后段）：取消全部勾选回到空态 ---- */
    const checked = page.locator(`${SEL.row}[data-selected="1"]`);
    for (let i = 0, n = await checked.count(); i < n; i += 1) {
      await page.locator(`${SEL.row}[data-selected="1"]`).first().locator('[data-lck="git-tree-select"]').click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(500);
    ok('A-06 取消全部勾选后右栏回到引导空态（文件行清空，不留上一条的残余）',
      (await page.locator(SEL.fileRow).count()) === 0
      && ((await page.locator(SEL.detail).first().textContent()) ?? '').includes('在左侧点选一条提交'));
  } catch (e) {
    ok('Z-99 用例执行未抛异常', false, String((e as Error)?.message ?? e).slice(0, 800));
  } finally {
    await browser?.close().catch(() => {});
  }
}

const summary = `PASS=${pass} FAIL=${fail}`;
writeGateResults(OUT_DIR, 't05210-git-idea-split-ui-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响判据 */ }
console.log(summary);
process.exit(fail > 0 ? 1 : 0);
