/**
 * T04525 UI 门（真实浏览器）：Git 树选范围弹窗在**只有一个项目**时，也要把该项目工作空间目录里的
 * 多个仓库按分支分组显示出来——这正是上一轮被打回的场景（派生单只做了「多项目多仓库」，
 * 单项目 + 目录内子仓库仍然什么都看不到）。
 *
 * 前置（与 `T04525-nested-repos-gate.mts` 同一套隔离实例，不碰用户生产实例）：
 *   1) `MTask_DATA_DIR=D:/tmp/t04525/data MTask_PORT=39907 MTASK_STATIC_DIR=<repo>/web/dist node node_modules/tsx/dist/cli.mjs server/src/index.ts`
 *   2) 本机 Chrome；playwright 不在本仓，用 `PW_ROOT` 指向安装入口
 * 运行：
 *   `PW_ROOT=D:/code/otherProjects/OcrTools/node_modules/playwright/index.js MTASK_UI_BASE=http://127.0.0.1:39907 \
 *    MTASK_LIVE_REPO=D:/code/QJ/BEMP5.0DEV node node_modules/tsx/dist/cli.mjs scripts/verify/T04525-nested-repos-ui.mts`
 *
 * 锚定词（R-318）：`同一工作空间目录` / `多仓库` / `master` / `feature/hnnxbank/dev` / `BEMP5.0DEV` / `git-repo-repo-nested`
 *
 * 只断言「看得到、分得开、不撒谎」三件事，全部走真实 DOM：
 *   - 分支组里出现 ≥2 个仓库行，且 `data-project` 是同一个项目（证明不是"多个工作空间"）；
 *   - 子仓库行带 `目录内仓库` 标记与相对路径（用户一眼能判断这一行是哪个仓库）；
 *   - 展开子仓库能取到它自己的提交（不是根仓库历史的复制）；
 *   - 两个仓库都有勾选时确认被拒（不许伪合并）。
 */
import path from 'node:path';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39907';
const REPO = (process.env.MTASK_LIVE_REPO || 'D:/code/QJ/BEMP5.0DEV').trim();
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BRANCH = 'feature/hnnxbank/dev';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const pick = (mod: any) => mod?.chromium ?? mod?.default?.chromium;
let chromium: any = null;
try { chromium = pick(await import('playwright')); } catch { chromium = null; }
if (!chromium) {
  const root = process.env.PW_ROOT || 'D:/code/otherProjects/OcrTools/node_modules/playwright/index.js';
  chromium = pick(await import(new URL(`file:///${root.replace(/\\/g, '/')}`).href));
}
if (!chromium) throw new Error('playwright 不可用：请设置 PW_ROOT 指向 playwright 安装入口');

/** 夹具：项目绑定真实工作空间 + 一条「已完成未回写」任务（该形状下「手动关联」入口给弹窗的正是单项目） */
const post = async (url: string, body: unknown) => {
  const r = await fetch(`${BASE}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return await r.json() as Record<string, any>;
};
const projects = await (await fetch(`${BASE}/api/projects`)).json() as Record<string, any>[];
let project = projects.find((p) => String(p.name).startsWith('T04525'));
if (!project) {
  project = await post('/api/projects', { name: `T04525 同一工作空间多仓库-${Date.now()}`, description: 'UI 门夹具' });
}
const patched = await fetch(`${BASE}/api/projects/${project.id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspacePath: REPO }),
}).then((r) => r.json()) as Record<string, any>;
const projRow = patched && patched.workspace_path !== undefined ? patched : project;
const all = await (await fetch(`${BASE}/api/tasks?projectId=${project.id}&archived=0&limit=50`)).json() as Record<string, any>[];
const unlinked = all.filter((t) => t.status === 'done' && (t.gitLinks?.length ?? 0) === 0);
const task = unlinked[0] ?? await post('/api/tasks', {
  projectId: project.id, title: 'T04525 同一工作空间多仓库-夹具任务（已完成未回写）', status: 'done',
});
ok('U-00 夹具：项目绑定真实工作空间 + 有「已完成未回写」任务（手动关联入口的前提）',
  String(projRow.workspace_path ?? '').includes('BEMP5.0DEV') && !!task.id,
  { workspace: projRow.workspace_path, taskId: task.id, doneUnlinked: unlinked.length });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[aria-label="跳过"]', { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="跳过"]')?.click());
  // 用真实用户路径选定夹具项目（点下拉选「切换到项目 X」）——写 localStorage 会被失效纠正逻辑回退到收件箱
  await page.waitForSelector('button[aria-label="切换项目"]', { timeout: 30000 });
  await page.locator('button[aria-label="切换项目"]').click();
  await page.locator(`button[aria-label="切换到项目 ${project.name}"]`).click();
  await page.waitForFunction((n) => document.querySelector('button[aria-label="切换项目"]')?.textContent?.includes(n) ?? false,
    project.name, { timeout: 30000 });
  // 入口走「已完成」tab 的「手动关联」：该入口给弹窗的 projects 恒为**一个项目**，
  // 正是上一轮被打回的形状（单项目 → 改造前 `projects.length > 1` 直接不进普查，什么都看不到）
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[aria-pressed]')].find((b) => /已完成/.test(b.textContent ?? ''));
    btn?.click();
  });
  await page.waitForSelector('[data-t03360="manual-link"]', { timeout: 30000 });
  ok('U-01 单项目「已完成」提示条给出未回写补齐入口（跨项目才会禁用，这里必须可点）',
    await page.locator('[data-t03360="manual-link"]').first().isEnabled());
  await page.locator('[data-t03360="manual-link"]').first().click();
  await page.waitForSelector('[data-lck="git-tree-modal"]', { timeout: 30000 });
  ok('U-02 Git 树选范围弹窗打开', true);

  // 关键回归点：单项目也要普查（改造前 `projects.length > 1` 直接不进普查）
  await page.locator('[data-lck="git-tree-repo-view"]').first().click();
  await page.waitForSelector('[data-lck="git-repo-groups"]', { timeout: 60000 });
  const scanning = page.locator('[data-lck="git-repo-scanning"]');
  await scanning.waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
  // 取数扇出的上限：一个目录里 8 个仓库 × 30 条分支组，铺满就是 200 多个 git 取数（实测会打死弹窗）
  const inflightAfterCensus = await page.evaluate(() =>
    [...document.querySelectorAll('p')].filter((p) => (p.textContent ?? '').includes('取数中')).length);
  ok('U-03b 普查结束后在途取数窗口有上限（不是「组数 × 仓库数」全铺）', inflightAfterCensus <= 6, { inflightAfterCensus });

  const branchSel = (b: string) => `[data-lck="git-repo-group"][data-branch="${b}"]`;
  /** 分支组默认只展开「同名仓库最多的前几组」（T04525 的取数上限），门要看的那组自己点开 */
  const openBranchGroup = async (b: string) => {
    const head = page.locator(`${branchSel(b)} [data-lck="git-repo-branch"]`).first();
    if ((await head.getAttribute('aria-expanded')) !== 'true') { await head.click(); await page.waitForTimeout(300); }
    await page.waitForFunction((s) => !!document.querySelector(`${s} [data-lck="git-repo-repo"]`),
      branchSel(b), { timeout: 60000 }).catch(() => {});
  };
  await openBranchGroup(BRANCH);
  await openBranchGroup('master');

  const rendered = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('[data-lck="git-repo-group"]')];
    return groups.map((g) => ({
      branch: g.getAttribute('data-branch') ?? '',
      expanded: g.querySelector('[data-lck="git-repo-branch"]')?.getAttribute('aria-expanded') === 'true',
      rows: [...g.querySelectorAll('[data-lck="git-repo-repo"]')].map((r) => ({
        project: r.getAttribute('data-project') ?? '',
        // 根仓库的相对路径是空串，DOM 里用 `.` 占位（属性值不能为空），读回来先还原
        repoSub: (r.getAttribute('data-repo-sub') ?? '').replace(/^\.$/, ''),
        status: r.getAttribute('data-status') ?? '',
        nested: !!r.querySelector('[data-lck="git-repo-repo-nested"]'),
        label: r.querySelector('[data-lck="git-repo-repo-toggle"] span')?.textContent?.trim() ?? '',
        path: r.querySelector('code')?.textContent?.trim() ?? '',
        open: r.querySelector('[data-lck="git-repo-repo-toggle"]')?.getAttribute('aria-expanded') === 'true',
      })),
    }));
  });
  ok('U-03 聚合视图对单项目也普查出分支组（不是「只有一个项目就不分组」）', rendered.length > 0, rendered.slice(0, 3));
  const devGroup = rendered.find((g) => g.branch === BRANCH);
  ok(`U-04 需求点名的分支 ${BRANCH} 出现在分组清单里`, !!devGroup, rendered.map((g) => g.branch));
  const rootGroup = rendered.find((g) => g.branch === 'master');
  ok('U-05 根仓库的 master 也在清单里（同一目录里既有 master 也有子仓库分支，需求原话的两条分支都要见到）', !!rootGroup,
    rendered.map((g) => g.branch));
  const distinctProjects = new Set((devGroup?.rows ?? []).map((r) => r.project));
  ok('U-06 同组多个仓库但**只有一个项目**：证明这是「同一工作空间目录内的多仓库」而不是「多个工作空间」',
    (devGroup?.rows.length ?? 0) >= 2 && distinctProjects.size === 1,
    { rows: devGroup?.rows.length, projects: [...distinctProjects] });
  ok('U-07 组内仓库行两两不重复（repoSub 参与身份，根仓库不会被子仓库顶掉）',
    new Set((devGroup?.rows ?? []).map((r) => `${r.project}|${r.repoSub}`)).size === devGroup?.rows.length,
    devGroup?.rows.map((r) => r.repoSub));
  ok('U-08 子仓库行带「目录内仓库」标记', (devGroup?.rows ?? []).every((r) => r.repoSub === '' || r.nested === true),
    devGroup?.rows.map((r) => [r.repoSub, r.nested]));
  ok('U-09 子仓库行展示路径带相对段（`工作空间/served`，不是只有工作空间）',
    (devGroup?.rows ?? []).filter((r) => r.repoSub).every((r) => r.path.includes(r.repoSub)),
    devGroup?.rows.map((r) => r.path));
  ok('U-10 展示名可区分：同一组里的仓库标签互不相同',
    new Set((devGroup?.rows ?? []).map((r) => r.label)).size === devGroup?.rows.length,
    devGroup?.rows.map((r) => r.label));

  // 展开一个子仓库窗口，确认真的取到该仓库自己的提交
  const rowSel = (branch: string, sub: string) =>
    `[data-lck="git-repo-group"][data-branch="${branch}"] [data-lck="git-repo-repo"][data-repo-sub="${sub || '.'}"]`;
  /** 把某个仓库窗口点到「取数结束」：有提交行、或明确空/明确报错都算读完（读完才轮到断言判对错） */
  const ensurePaneLoaded = async (sel: string) => {
    const toggle = page.locator(`${sel} [data-lck="git-repo-repo-toggle"]`).first();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') { await toggle.click(); await page.waitForTimeout(250); }
    await page.waitForFunction((s) => {
      const r = document.querySelector(s);
      if (!r) return false;
      if (r.querySelector('[data-lck="git-repo-repo-error"]')) return true;
      const ps = [...r.querySelectorAll('p')].map((x) => x.textContent ?? '');
      if (ps.some((t) => t.includes('取数中'))) return false;
      return r.querySelectorAll('[data-lck="git-tree-row"]').length > 0 || ps.some((t) => t.includes('没有提交'));
    }, sel, { timeout: 60000 }).catch(() => {});
  };

  const nestedRow = (devGroup?.rows ?? []).find((r) => r.repoSub && r.status !== 'unavailable');
  ok('U-11 组内至少有一个可展开的子仓库行', !!nestedRow, devGroup?.rows.map((r) => [r.repoSub, r.status]));
  if (nestedRow) {
    await openBranchGroup(BRANCH);
    const sel = rowSel(BRANCH, nestedRow.repoSub);
    await ensurePaneLoaded(sel);
    const paneState = await page.evaluate((s) => {
      const row = document.querySelector(s);
      const err = row?.querySelector('[data-lck="git-repo-repo-error"]')?.textContent ?? '';
      const shas = [...(row?.querySelectorAll('[data-lck="git-tree-row"]') ?? [])].map((el) => el.getAttribute('data-sha') ?? '');
      const anyRow = [...document.querySelectorAll('[data-lck="git-tree-row"]')].length;
      return { err: err.trim(), shas: shas.slice(0, 5), count: shas.length, renderedCommitRows: anyRow };
    }, sel);
    ok(`U-12 子仓库 ${nestedRow.repoSub} 的分支窗口能展开且没有取数错误`,
      paneState.err === '', paneState);
    ok('U-13 窗口里确有该仓库的提交行（不是「展开但空白」——空白会被读成「这仓库没这条分支」）',
      paneState.count > 0 || paneState.renderedCommitRows > 0, paneState);
  }

  // 勾选两个仓库 → 确认必须被拒（不许伪合并），并在真实 DOM 里给出仓库数
  const loaded: string[] = [];
  for (const r of devGroup?.rows ?? []) {
    if (r.status === 'unavailable') continue;
    await ensurePaneLoaded(rowSel(BRANCH, r.repoSub));
    const has = await page.evaluate((s) => !!document.querySelector(`${s} [data-lck="git-tree-row"]`), rowSel(BRANCH, r.repoSub));
    if (has) loaded.push(r.repoSub);
    if (loaded.length >= 2) break;
  }
  ok('U-14 同一条分支上凑到两个可勾选的仓库窗口（只有一个项目也凑得到，正是需求点名的形状）',
    loaded.length >= 2, { loaded, rows: devGroup?.rows.map((r) => [r.repoSub, r.status]) });
  for (const sub of loaded.slice(0, 2)) {
    await page.locator(`${rowSel(BRANCH, sub)} [data-lck="git-tree-row"]`).first().click();
    await page.waitForTimeout(250);
  }
  // 取数进行中确认本就是禁用的；等到可点为止——拒绝要发生在点击之后并给出原因，而不是一只没有解释的灰按钮
  const clickable = await page.waitForFunction(() => {
    const b = document.querySelector<HTMLButtonElement>('[data-lck="git-tree-confirm"]');
    return !!b && !b.disabled;
  }, undefined, { timeout: 60000 }).then(() => true).catch(() => false);
  const diag = await page.evaluate(() => ({
    footer: document.body.innerText.match(/已选[^\n]*/)?.[0] ?? '',
    loadingPanes: [...document.querySelectorAll('p')].filter((p) => (p.textContent ?? '').includes('取数中')).length,
    err: document.querySelector('[data-lck="git-tree-error"]')?.textContent ?? '',
  }));
  ok('U-15 勾选跨两个仓库时确认按钮仍可点（灰按钮不解释原因，正是上一轮的缺陷之一）', clickable, diag);
  if (clickable) {
    await page.locator('[data-lck="git-tree-confirm"]').first().click();
    await page.waitForTimeout(400);
    const errText = await page.evaluate(() => document.querySelector('[data-lck="git-tree-error"]')?.textContent ?? '');
    ok('U-16 两个仓库都有勾选时确认被拒，并如实点出仓库数（不做假的跨仓库合并）',
      /个仓库的提交/.test(errText) && /一次确认只能回传一个仓库/.test(errText), errText.slice(0, 160));
  } else {
    ok('U-16 两个仓库都有勾选时确认被拒并给出原因', false, diag);
  }

  await page.screenshot({ path: path.join(process.env.TMP || 'D:/tmp', 't04525-ui-groups.png'), fullPage: false });
} catch (e) {
  console.log('EXCEPTION:', String((e as Error)?.stack ?? e).slice(0, 900));
  await page.screenshot({ path: path.join(process.env.TMP || 'D:/tmp', 't04525-ui-error.png') }).catch(() => {});
  fail += 1;
} finally {
  await browser.close();
}
console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
