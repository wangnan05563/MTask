/*
 * T04547 验收门：全站 abtn/ghost 图标按钮「按下回弹」真实浏览器取证 + 规则单源守卫。
 *
 * 工单锚定词（R-318，均为本仓真实存在的路径/词形）：
 *   scripts/verify/T04547-icon-bounce-ui.mts
 *   web/src/App.tsx  web/src/pages/ReqPage.tsx  web/src/pages/PromptsPage.tsx
 *   web/src/ui/gitBadge.tsx  web/src/components/GitCommitTab.tsx  web/src/ui/notice.tsx
 *   web/src/pages/AIToolsPage.tsx  web/src/pages/ArchivePage.tsx  web/src/pages/SprintPanel.tsx
 *   .abtn:active:not(:disabled)  .ghost:active:not(:disabled)  matrix(0.88
 *
 * 三组断言：
 *   A 组 工单「范围」逐调用点真鼠标取证（hover ≠ active、active = scale(.88)、过渡时长 0.15–0.20s）。
 *       导航口径：一级页签由 `nav button.nav-btn[aria-label]` 点击切换——深链格式是 `#/project/<id>/<tab>`，
 *       旧门照 `#/req` 写前置条件，页面从未真正离开任务页，于是 10 个调用点全部 BLOCKED。
 *       每个调用点独立取证：拿不到坐标时显式记 BLOCKED 并注明触发条件，绝不静默跳过。
 *   B 组 同类 ghost/abtn 按钮面扫（工单要求「另需覆盖同类 ghost 按钮」）：逐页扫在册实例，
 *       面扫前先断言「激活页签 == 目标页签」，防止导航失败时整组退化成同一页的重复取证。
 *   C 组 规则单源守卫：active 规则必须带 :not(:disabled) 且排在 hover 之后；页面级重复定义
 *       必须清零，源码与活体样式表双向核对。
 *
 * 前置：隔离后端 MTask_DATA_DIR=<tmp>/data MTask_PORT=39903 MTASK_STATIC_DIR=<repo>/web/dist
 *       产物路径类调用点（A12/A13）依赖 ai_artifacts 行——该表无 REST 写入口（只由真实 AI 成功生成落表），
 *       故门直接往该隔离库补夹具行；数据目录本就是临时目录，不触碰用户生产实例。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04547-icon-bounce-ui.mts
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const BASE = process.env.MTASK_UI_BASE || 'http://127.0.0.1:39903';
const CHROME = process.env.MTASK_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REPO = process.cwd();
const DB_FILE = process.env.MTASK_UI_DB || path.join(process.env.MTask_DATA_DIR || 'D:/tmp/t04547/data', 'mtask.db');
const SHOT = (n: string) => path.join(os.tmpdir(), `t04547-${n.replace(/[^\w]+/g, '-').slice(0, 60)}.png`);

let pass = 0, fail = 0, blocked = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
// 工单红线：取不到坐标不得静默跳过——单独计 BLOCKED 并注明触发条件，收尾强制列清单
const blockedSite = (name: string, reason: string) => {
  blocked++; console.log(`BLOCKED ${name} :: 触发条件=${reason}`);
};
/** Playwright 的超时信息整段都在换行后的 Call log 里，压平才能看出到底是「没命中」还是「被遮罩拦截」 */
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

/* ---------- 夹具：每类调用点都要有可渲染的数据行 ---------- */
const stamp = Date.now();
const list: any[] = await (await fetch(`${BASE}/api/projects`)).json();
let project = list.find((p) => p.name.startsWith('T04547 动画门'));
if (!project) project = await post('/api/projects', { name: `T04547 动画门项目-${stamp}`, description: '按钮回弹 UI 门夹具' });
await fetch(`${BASE}/api/projects/${project.id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspacePath: REPO }),
}).then(json);
const task = await post('/api/tasks', { projectId: project.id, title: `T04547 按钮动画门任务-${stamp}` });
// Git 徽标/弹层/抽屉三处调用点：≥2 条 link（才出「另有 N」触发键）且 SHA 能在绑定仓库解析
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
const prevSha = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: REPO, encoding: 'utf8' }).trim();
for (const s of [sha, prevSha]) await post(`/api/tasks/${task.id}/git/links`, { sha: s }).catch(() => null);
const reqCat = await post('/api/req-categories', { name: `T04547 需求分类-${stamp}` });
await post('/api/req-entries', { categoryId: reqCat.id, title: `T04547 通用需求-${stamp}`, content: '按钮回弹动画门夹具' });
const promptCat = await post('/api/prompt-categories', { name: `T04547 提示词分类-${stamp}` });
await post('/api/prompts', { categoryId: promptCat.id, title: `T04547 提示词-${stamp}`, content: '按钮回弹动画门夹具' });
await post('/api/aitools', {
  name: `T04547 工具-${stamp}`, type: 'openai', endpoint: 'http://127.0.0.1:1/v1', model: 't04547-model', apiKey: 'not-used',
}).catch(() => null);
const iteration = await post(`/api/projects/${project.id}/iterations`, {
  name: `T04547 迭代-${stamp}`, startDate: new Date().toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10),
});
await post(`/api/iterations/${iteration.id}/weekly-card`, {});
const archivedTask = await post('/api/tasks', { projectId: project.id, title: `T04547 归档夹具-${stamp}` });
await post('/api/archive', { taskIds: [archivedTask.id] });

// A12/A13 的产物路径调用点：ai_artifacts 只由真实 AI 成功生成写入（无 REST 写入口），此处补隔离库夹具行。
// 文件不必真的存在——产物条对 exists:false 照样渲染（照实提示「文件已不在」），取证要的是那颗按钮。
async function seedArtifacts(): Promise<string> {
  try {
    const mod: any = await import('better-sqlite3');
    const Database = mod?.default ?? mod;
    const db = new Database(DB_FILE);
    db.pragma('busy_timeout = 5000');
    const ins = db.prepare('INSERT OR REPLACE INTO ai_artifacts (id, card_key, filename, path, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    ins.run(randomUUID(), 'ai.weekly_report', 't04547-weekly.md', path.join(os.tmpdir(), 't04547-weekly.md'), now, null);
    ins.run(randomUUID(), 'ai.prd_gen', 't04547-prd.md', path.join(os.tmpdir(), 't04547-prd.md'), now, null);
    db.close();
    return '已补 2 行';
  } catch (e) {
    return `失败：${String((e as Error)?.message ?? e).slice(0, 90)}`;
  }
}
console.log(`# ai_artifacts 夹具行（隔离库 ${DB_FILE}）：${await seedArtifacts()}`);

/* ---------- 浏览器 ---------- */
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
page.on('dialog', (d: any) => d.dismiss().catch(() => {}));

const scaleOf = (t: string) => {
  const m = /matrix\(([^)]+)\)/.exec(t || '');
  if (!m) return 1;
  const [a, b] = m[1].split(',').map(Number);
  return Math.hypot(a || 0, b || 0);
};

/* ---------- 导航：一级页签只能靠 nav-btn 点击 ---------- */
const NAV = {
  tasks: '任务', req: '通用需求', prompts: '提示词', aitools: '模型',
  plan: '项目管理', report: 'AI 工作台', settings: '设置',
} as const;
async function navTo(key: keyof typeof NAV) {
  const label = NAV[key];
  const sel = `nav button.nav-btn[aria-label="${label}"]`;
  try {
    await page.locator(sel).click({ timeout: 6000 });
  } catch {
    // 导航不是本门的判据（动画取证走真鼠标），但残留遮罩会把后续所有页签点击级联拖死，
    // 故真点击失败时退到 DOM 层 click()——同一个 React handler，只是不经命中测试。
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
/** 全屏遮罩计数（dialogs.tsx 的 overlayStyle 是 position:fixed + zIndex:1000 + 铺满视口；
    吐司容器同样 fixed 但只占一角，按宽高双阈值排除——否则会把 error 档提示当成遮罩收掉，A03b 就没按钮可取了） */
async function overlayCount(): Promise<number> {
  return page.evaluate(() => {
    let n = 0;
    const els = document.querySelectorAll('div');
    for (let i = 0; i < els.length; i += 1) {
      const cs = getComputedStyle(els[i]);
      if (cs.position !== 'fixed') continue;
      if (Number(cs.zIndex) < 1000) continue;
      const r = els[i].getBoundingClientRect();
      if (r.width < window.innerWidth * 0.9 || r.height < window.innerHeight * 0.9) continue;
      n += 1;
    }
    return n;
  });
}
/** 收掉在途弹层：先点弹层自己的取消控件，再退到「点面板外即取消」（dialogs.tsx 的 outside-mousedown 通道） */
async function closeOverlays(): Promise<number> {
  let left = await overlayCount();
  let guard = 0;
  while (left > 0 && guard < 8) {
    guard += 1;
    const closer = page.locator('[aria-label="取消：放弃本次输入"], [aria-label="取消：取消并关闭确认"]');
    if ((await closer.count()) > 0) {
      await closer.first().click({ timeout: 2500 }).catch(() => {});
    } else {
      await page.mouse.click(12, 400 + guard * 45).catch(() => {});
    }
    await page.waitForTimeout(250);
    left = await overlayCount();
  }
  return left;
}
/** 页签身份判据：激活项的内联 background 是 var(--accent)（App.tsx 导航行按 tab===key 直接写内联样式） */
async function activeNavLabel(): Promise<string> {
  return page.evaluate(() => {
    const btns = document.querySelectorAll('nav button.nav-btn');
    for (let i = 0; i < btns.length; i += 1) {
      const bg = String((btns[i] as HTMLElement).style.background || '');
      if (bg.indexOf('accent') >= 0 && bg.indexOf('card-bg') < 0) return String(btns[i].getAttribute('aria-label') || '');
    }
    return '';
  });
}

/** 行内/工具栏控件默认淡出：宿主行 :hover / :focus-within 才显形；op-host 另有聚焦期间 op-force 通道 */
const forceOpHost = () => page.evaluate(() => {
  document.querySelectorAll('.op-host').forEach((h) => h.classList.add('op-force'));
});

/** 宿主行定位：悬浮「.arena-row 的第一个」会悬在分类行／别的任务行上——按钮所在行才是显形宿主。
    故先在页面里给「按钮自己的宿主祖先」打临时标记，再按标记悬浮（evaluate 体内不得写 `const fn = () =>`，
    esbuild/tsx 的 keepNames 会编译成 __name(fn) → 浏览器里 ReferenceError）。 */
async function markHost(selector: string, host?: string): Promise<string> {
  return page.evaluate((a: any) => {
    const stale = document.querySelectorAll('[data-t04547-host]');
    for (let i = 0; i < stale.length; i += 1) stale[i].removeAttribute('data-t04547-host');
    const el = document.querySelector(a.sel);
    if (!el) return 'no-el';
    let cur = el.parentElement;
    while (cur) {
      if (a.host && cur.matches(a.host)) {
        cur.setAttribute('data-t04547-host', '1');
        return 'marked';
      }
      cur = cur.parentElement;
    }
    return 'no-ancestor';
  }, { sel: selector, host: host || '' });
}

/** 前置动作（非判据）的点击兜底：这些触发键常在过渡中／被兄弟层遮住，Playwright 的可点性等待会耗尽超时。
    判定「回弹」靠的是取证阶段的真鼠标，前置只需把状态切过去，故允许退到 DOM 层 click()。 */
async function clickPrep(selector: string, timeout = 8000) {
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
}

/** 单点真鼠标取证：宿主行悬浮显形 → hover 采样 → 按下采样 → 抬到按钮外（click 不派发，零副作用）。
    disabled 的 abtn/ghost 不算失败：`:not(:disabled)` 正是 T04544 的修复本体，禁用态恒无变换是**预期行为**，
    单独断言成一条正向证据（否则面扫会把「按钮本就禁用」误判成回归）。 */
async function probeButton(label: string, selector: string, opts: { host?: string; trigger?: string } = {}) {
  try {
    const btn = page.locator(selector).first();
    await btn.waitFor({ state: 'attached', timeout: 20000 });
    const marked = opts.host ? await markHost(selector, opts.host) : 'no-host-arg';
    /** 显形：悬浮按钮自己的宿主行（不是「第一行」）→ 工具栏 op-force → 滚动到视野内 → 等 0.15s 过渡落定 */
    const reveal = async (withFocus = false) => {
      if (withFocus) await btn.evaluate((el: Element) => { (el as HTMLElement).focus(); }).catch(() => {});
      if (marked === 'marked') await page.locator('[data-t04547-host="1"]').hover({ timeout: 8000 }).catch(() => {});
      await forceOpHost();
      await btn.evaluate((el: Element) => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
      await page.waitForTimeout(320);
    };
    /** 坐标 + 显形态 + svg 样式一次读齐：取样一律用 getBoundingClientRect，不用 locator.boundingBox，
        这样「hover=none」能被分辨成「鼠标命中不到（vis/pe/op）」还是「坐标陈旧／在视野外（y 超出 vh）」。 */
    const read = () => page.evaluate((a: any) => {
      const el = document.querySelector(a.sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const svg = el.querySelector('svg');
      const s = svg ? getComputedStyle(svg) : null;
      return {
        x: r.x, y: r.y, w: r.width, h: r.height,
        hit: `x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)} vh=${window.innerHeight} vw=${window.innerWidth}`,
        vis: cs.visibility, pe: cs.pointerEvents, op: cs.opacity,
        inView: r.width > 0 && r.height > 0 && r.y >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
        disabled: Boolean((el as any).disabled), hasSvg: Boolean(svg),
        transform: s ? s.transform : '', duration: s ? s.transitionDuration : '',
      };
    }, { sel: selector });
    await reveal();
    let st = await read();
    if (!st || !st.hasSvg) { blockedSite(label, st ? '按钮内无 svg（动画挂在 svg 上，该调用点不适用）' : '按钮已从 DOM 移除'); return false; }
    if (Number(st.op) === 0 || st.vis === 'hidden' || st.pe === 'none') {
      // 键盘 :focus-within 是第二条显形通道（AIToolsPage 未悬浮时 pointer-events:none，只靠悬浮拿不到）
      await reveal(true);
      st = await read();
      if (!st) { blockedSite(label, '按钮已从 DOM 移除'); return false; }
      if (Number(st.op) === 0 || st.vis === 'hidden' || st.pe === 'none') {
        blockedSite(label, `${opts.trigger || `需悬浮宿主 ${opts.host || '（未声明）'}（祖先标记=${marked}）`}；悬浮+聚焦两通道后仍 opacity=${st.op} visibility=${st.vis} pointer-events=${st.pe} ${st.hit}`);
        return false;
      }
    }
    if (!st.inView) { blockedSite(label, `按钮不在可视区内且居中滚动后仍未归位（${st.hit}）——宿主/面板为独立滚动容器，需人工复核`); return false; }
    const dur = Number(/^([\d.]+)s/.exec(st.duration || '')?.[1] ?? 0);
    const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
    /** 真鼠标取证：坐标级 move/down，取样前先确认盒子；hover 未生效时重走一遍显形（盒子随页面滚动会过期） */
    const aim = async () => {
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(280);
      return read();
    };
    let hov = await aim();
    if (hov && !st.disabled && /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(hov.transform)) {
      await reveal();
      st = (await read()) || st;
      hov = await aim();
    }
    if (!hov) { blockedSite(label, '取样期间按钮被卸载'); return false; }
    if (st.disabled) {
      const flat = (t: string) => t === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(t);
      ok(`${label}（禁用态）不参与回弹：:not(:disabled) 生效`,
        flat(hov.transform), `disabled=true hover=${hov.transform} duration=${hov.duration}`);
      await page.screenshot({ path: SHOT(label) }).catch(() => {});
      return true;
    }
    await page.mouse.down();
    await page.waitForTimeout(320); // 过渡 0.18s：等落定再取样，避免采到中间态
    const act = await read();
    await page.mouse.move(4, 4); // 抬到别处再松手：click 不派发，取证零副作用
    await page.mouse.up();
    await page.waitForTimeout(120);
    const hs = scaleOf(hov.transform), as = scaleOf(act ? act.transform : '');
    const diag = `hover=${hov.transform} active=${act ? act.transform : '已卸载'} 命中=${Math.round(cx)},${Math.round(cy)} ${hov.hit} op=${hov.op} vis=${hov.vis} pe=${hov.pe}`;
    ok(`${label} hover 与 active 变换不同`, Math.abs(hs - as) > 0.05, diag);
    ok(`${label} active 落在 scale(.88)`, Math.abs(as - 0.88) < 0.005, `active=${act ? act.transform : ''} scale=${as}`);
    ok(`${label} svg 过渡时长在 0.15–0.20s`, dur >= 0.15 && dur <= 0.2, `duration=${hov.duration}`);
    await page.screenshot({ path: SHOT(label) }).catch(() => {});
    return true;
  } catch (e) {
    blockedSite(label, `取样异常：${why(e)}`);
    return false;
  }
}

/* ---------- 会话态预置：页内「当前分组 / 面板展开」都是 useSessionState（挂载时读 sessionStorage），故先播种再重载 ---------- */
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.evaluate((kv: any) => {
  for (const k of Object.keys(kv)) sessionStorage.setItem(k, JSON.stringify(kv[k]));
}, {
  'req.activeCat': reqCat.id,
  'prompts.activeCat': promptCat.id,
  'plan.projectId': project.id,
  'plan.showSprint': true,
  'report.projects': [project.id],
  'report.showPrdImport': true,
  'report.showPrdGen': true,
  // A13 的产物条挂在「AI 周报工作面板」里（ReportPage.tsx:1068 需 showAiLive 展开 + lastArtifact 命中），
  // 面板展开态是 useSessionState；互斥只在点击卡片时生效，重载读取播种值时不互斥，可与导入面板并存。
  'report.showAiLive': true,
  'prd-import.failedChunks': [{
    index: 1, total: 1, reason: 'error', message: 'T04547 夹具分片', chars: 18,
    text: 'T04547 分片原文', file: 'T04547-prd.md', uid: 'local:t04547',
  }],
});
await page.evaluate((id: string) => localStorage.setItem('tasks.activeProject', JSON.stringify(id)), project.id);
// T00706 使用向导：每个菜单首次进入自动弹出全屏弹窗（position:fixed / z-index:1200），
// 命中测试全被它吃掉——探针实测 elementFromPoint 只回这层遮罩，:hover/:active 一律不匹配，
// 于是所有「行悬浮才显形」的调用点取样恒为 transform:none。已读标记在 localStorage（逐菜单一个 seenKey），
// 播种一次即全程无弹窗；原来只在任务页点了一次「跳过」，其余菜单各弹一次。
await page.evaluate((keys: string[]) => {
  for (let i = 0; i < keys.length; i += 1) localStorage.setItem(keys[i], '1');
}, ['mtask.guide.seen.tasks', 'mtask.guide.seen.aitools', 'mtask.guide.seen.prompts', 'mtask.guide.seen.req',
  'mtask.guide.seen.report', 'mtask.guide.seen.history', 'mtask.guide.seen.queue', 'mtask.guide.seen.exec-sessions',
  'mtask.guide.seen.settings', 'mtask.projectGuide.seen', `guide.dismiss.${project.id}`]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.evaluate(() => document.querySelector('button[aria-label="跳过"]')?.click());
await page.waitForTimeout(300);

/** 逐站点回到干净起点：弹层遮罩、在途吐司、抽屉展开态一并清掉（sessionStorage 夹具不受重载影响）。
    v1 把清理寄托在「按 Escape / 点面板外」上，一旦某个站点把模态留在途，后续所有站点级联超时。 */
async function freshPage() {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => document.querySelector('button[aria-label="跳过"]')?.click());
  await page.waitForTimeout(250);
}

const pressEscape = () => page.keyboard.press('Escape').catch(() => {});

/* ---------- A 组：工单「范围」逐调用点 ---------- */
/** git 徽标链路的公共前置：开关打开 + 首行任务出徽标。站点重载后开关态会回落，故每个 git 调用点各自确保一次。 */
async function ensureGitBadge() {
  await page.waitForSelector('[data-t03343="git-toggle"]', { timeout: 20000 });
  if ((await page.locator('[data-t03343="git-toggle"]').getAttribute('aria-pressed')) !== 'true') {
    await clickPrep('[data-t03343="git-toggle"]');
    await page.waitForTimeout(800);
  }
  await page.waitForSelector('[data-t03343="git-badge"]', { state: 'attached', timeout: 25000 });
}

interface Site { label: string; file: string; nav: keyof typeof NAV; sel: string; host?: string; trigger?: string; prep?: () => Promise<void>; keepState?: boolean; blockedWhy?: string; }
const sites: Site[] = [
  {
    label: 'A01 CopyButton 本体（项目名下拉条复制）', file: 'web/src/ui/CopyButton.tsx', nav: 'tasks',
    sel: '[aria-label="复制项目名称"]',
  },
  {
    label: 'A02 ghost 取消输入', file: 'web/src/ui/dialogs.tsx', nav: 'tasks',
    sel: '[aria-label="取消：放弃本次输入"]',
    prep: async () => {
      await pressEscape(); await forceOpHost(); await page.waitForTimeout(300);
      await clickPrep('[aria-label="新项目：新建一个任务项目"]');
      await page.waitForSelector('[aria-label="新项目名称"]', { timeout: 20000 });
    },
  },
  {
    label: 'A03 notice 关闭提示', file: 'web/src/ui/notice.tsx', nav: 'tasks',
    sel: '[aria-label="关闭提示"]',
    trigger: '需一条在途提示（error 档驻留 6s）——以重名项目建单失败触发',
    prep: async () => {
      await pressEscape(); await forceOpHost(); await page.waitForTimeout(300);
      await clickPrep('[aria-label="新项目：新建一个任务项目"]');
      await page.waitForSelector('[aria-label="新项目名称"]', { timeout: 20000 });
      await page.fill('[aria-label="新项目名称"]', '收件箱'); // 重名 → 后端 400 → error 档提示
      await clickPrep('[aria-label="确定：确认并提交输入"]');
      await page.waitForSelector('[aria-label="关闭提示"]', { timeout: 15000 });
    },
  },
  {
    label: 'A03b notice 复制错误全文', file: 'web/src/ui/notice.tsx', nav: 'tasks',
    sel: '[aria-label="复制错误提示"]',
    trigger: '与 A03 同一条 error 提示（error 档才带复制按钮，须在 6s 内取样）',
    keepState: true,
  },
  {
    label: 'A04 gitBadge 行内复制', file: 'web/src/ui/gitBadge.tsx', nav: 'tasks',
    sel: '[data-t03343="git-badge"] [aria-label^="复制提交 "]', host: '.task-item',
    trigger: '需 git 开关开启 + 任务 ≥1 条 link 且 SHA 能在绑定仓库解析 + 悬浮任务行',
    prep: ensureGitBadge,
  },
  {
    label: 'A05 gitBadge 清单弹层复制', file: 'web/src/ui/gitBadge.tsx', nav: 'tasks',
    sel: '[data-t03343="git-popover-row"] [aria-label^="复制提交 "]',
    trigger: '需同一任务 ≥2 条 link 才出「另有 N」触发键；点击后浮层 portal 到 body',
    prep: async () => {
      await ensureGitBadge();
      await page.locator('[data-t03343="git-badge"]').first().hover().catch(() => {});
      await page.waitForSelector('[data-t03343="git-more"]', { state: 'attached', timeout: 20000 });
      const dlg = '[aria-label$="的全部关联提交"]'; // GitLinksPopover 的 <dialog open>（portal 到 body）
      await clickPrep('[data-t03343="git-more"]');
      // 触发键是 toggle（setAnchor(anchor ? null : …)）：真点击若在关闭态上多走一次会把浮层再关掉，故按现状补一次
      if ((await page.locator(dlg).count()) === 0) await clickPrep('[data-t03343="git-more"]');
      await page.waitForSelector(dlg, { state: 'attached', timeout: 15000 });
      const txt = await page.locator(dlg).first().innerText().catch(() => '');
      if (!/复制提交/.test(txt)) throw new Error(`清单浮层已开但行未出（接口回显）：${txt.replace(/\s*\r?\n\s*/g, ' | ').slice(0, 180)}`);
      await page.waitForSelector('[data-t03343="git-popover-row"]', { timeout: 15000 });
    },
    /*
     * 本调用点当前恒为 BLOCKED，原因不是夹具不到位，而是应用缺陷（已取证，派生单 T04577）：
     * gitBadge.tsx:243-249 在徽标 span 上挂了原生冒泡阶段的 click→stopPropagation，
     * 而 React 18 的委托监听在更外侧的 root 容器（main.tsx:7 createRoot(#root)），
     * 于是「+N」触发键的 React onClick 永不派发——真鼠标、dispatchEvent、DOM click 三条通道实测都开不了浮层
     * （D:/tmp/t04547/probe4b.log 全 false/0 行；probe5b.log 把按钮临时移出徽标 span 后同一通道立刻 popRows=2）。
     * 该拦截出自 commit 847a703。修复后本站点自动转 PASS，门应回到 BLOCKED=0。
     */
    blockedWhy: '应用缺陷 T04577：gitBadge 徽标 span 的原生 click→stopPropagation 抢在 React 委托（#root）之前，内层按钮 onClick 永不派发（探针 probe4b/probe5b.log 实证），修复后本调用点转可测',
  },
  {
    label: 'A06 GitCommitTab 抽屉复制', file: 'web/src/components/GitCommitTab.tsx', nav: 'tasks',
    sel: '[data-t03362="git-tab"] [data-t03362="commit-card"] [aria-label^="复制提交 "]',
    trigger: '需悬浮任务行 → 展开详情抽屉 → 切到 Git 页；提交卡要能在绑定仓库解析',
    prep: async () => {
      await pressEscape();
      await page.locator('.task-item').first().hover().catch(() => {});
      await clickPrep('[aria-label="展开详情抽屉 — 在右侧抽屉中查看并编辑任务完整详情"]');
      await clickPrep('button[aria-label="Git"]');
      await page.waitForSelector('[data-t03362="commit-card"]', { timeout: 25000 });
    },
  },
  {
    label: 'A07 ReqPage 需求行复制', file: 'web/src/pages/ReqPage.tsx', nav: 'req',
    sel: '[aria-label="复制：复制通用需求内容"]', host: '.arena-row',
    trigger: '需该分组内有需求行且悬浮 .arena-row（页面级 .abtn{opacity:0}）',
  },
  {
    label: 'A08 PromptsPage 提示词行复制', file: 'web/src/pages/PromptsPage.tsx', nav: 'prompts',
    sel: '[aria-label="复制：复制提示词内容"]', host: '.arena-row',
    trigger: '需该分组内有提示词行且悬浮 .arena-row',
  },
  {
    label: 'A09 AIToolsPage 行内编辑', file: 'web/src/pages/AIToolsPage.tsx', nav: 'aitools',
    sel: '[aria-label="编辑：编辑该配置，保留原 API Key"]', host: '.arena-row',
    trigger: '未悬浮时 .abtn 是 pointer-events:none，须悬浮行或聚焦显形',
  },
  {
    label: 'A10 ArchivePage 还原', file: 'web/src/pages/ArchivePage.tsx', nav: 'settings',
    sel: '[aria-label="还原：将该归档任务还原到待办列表"]', host: '.arena-row',
    trigger: '需「设置 → 归档」子页签 + 至少一条归档任务 + 悬浮行',
    prep: async () => {
      await clickPrep('[data-t03271="tab"][data-tab="archive"]');
      await page.waitForTimeout(1500);
    },
  },
  {
    label: 'A11 PrdImportPanel 分片原文复制', file: 'web/src/pages/PrdImportPanel.tsx', nav: 'report',
    sel: '[data-t03700="failed-shards"] [aria-label="复制第 1 片原文"]',
    trigger: '需失败分片列表非空（真实链路由 AI 分片解析产生；本门预置 sessionStorage 夹具）',
    prep: async () => { await page.waitForSelector('[data-t03700="failed-shards"]', { timeout: 20000 }); },
  },
  {
    label: 'A12 AiProvenance 产物路径复制', file: 'web/src/components/AiProvenance.tsx', nav: 'report',
    sel: '[data-t03262="artifact"] [aria-label="复制产物路径"]',
    trigger: '需 ai_artifacts 有该卡片行（只由真实 AI 成功生成写入；本门补隔离库夹具行）',
  },
  {
    label: 'A13 ReportPage 产物路径复制', file: 'web/src/pages/ReportPage.tsx', nav: 'report',
    sel: '[data-t03240="artifact"] [aria-label="复制产物路径"]',
    trigger: '需 ai_artifacts 有 ai.weekly_report 行（刷新后找回上一次产物通道）',
    prep: async () => { await page.waitForSelector('[data-t03240="artifact"]', { timeout: 20000 }); },
  },
  {
    label: 'A14 SprintPanel 周报卡复制', file: 'web/src/pages/SprintPanel.tsx', nav: 'plan',
    sel: '[data-t03227="weekly-card"] [aria-label="复制周报卡全文"]',
    trigger: '需「迭代与燃尽」面板展开 + 迭代已发周报卡（POST /iterations/:id/weekly-card）',
    prep: async () => {
      if ((await page.locator('[data-t03227="weekly-card"]').count()) === 0) {
        await clickPrep('button[aria-label="迭代与燃尽"]', 12000).catch(() => {});
      }
      await page.waitForSelector('[data-t03227="weekly-card"]', { timeout: 20000 });
    },
  },
];

for (const s of sites) {
  const siteLabel = `${s.label}（${s.file}）`;
  // 干净起点：重载清掉上一站点遗留的模态／抽屉／吐司（sessionStorage 夹具照旧生效）。
  // 唯一例外是 keepState 站点——它的取证对象正是上一站点产生的在途提示，重载会让它消失。
  if (s.keepState) {
    const leftover = await closeOverlays();
    if (leftover > 0) blockedSite(siteLabel, `上一站点残留 ${leftover} 层全屏遮罩，无法安全取证`);
  } else {
    try { await freshPage(); } catch { /* 重载失败仍继续走导航兜底 */ }
  }
  try {
    await navTo(s.nav);
    await forceOpHost();
    if (s.prep) await s.prep();
  } catch (e) {
    blockedSite(siteLabel, `前置条件未达成：${why(e)}${s.blockedWhy ? ' || ' + s.blockedWhy : ''}`);
    continue;
  }
  await probeButton(siteLabel, s.sel, { host: s.host, trigger: s.trigger });
}

/* ---------- B 组：同类 abtn/ghost 面扫（先证「真的切到了该页」，再扫） ---------- */
async function sweepPage(navKey: keyof typeof NAV, pageLabel: string) {
  await closeOverlays();
  await navTo(navKey);
  await forceOpHost();
  const onTab = await activeNavLabel();
  ok(`${pageLabel} 导航落地（激活页签=${onTab || '未识别'}）`, onTab === NAV[navKey], `期望页签=${NAV[navKey]}`);
  const found = await page.evaluate(() => {
    const els = document.querySelectorAll('button');
    let total = 0, visible = 0;
    for (let i = 0; i < els.length; i += 1) {
      const b = els[i] as HTMLElement;
      if (!/(^|\s)(abtn|ghost)(\s|$)/.test(String(b.className))) continue;
      total += 1;
      b.setAttribute('data-t04547-idx', String(total - 1));
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      if (r.width > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0) visible += 1;
    }
    return { total, visible };
  });
  ok(`${pageLabel} 页面存在 abtn/ghost 按钮`, found.total > 0, JSON.stringify(found));
  const n = Math.min(found.total, 6);
  for (let i = 0; i < n; i += 1) await probeButton(`${pageLabel} 面扫#${i + 1}`, `button[data-t04547-idx="${i}"]`, { host: '.arena-row, .task-item' });
  await page.evaluate(() => document.querySelectorAll('[data-t04547-idx]').forEach((e) => e.removeAttribute('data-t04547-idx')));
}
for (const [k, l] of [['tasks', 'B01 任务页'], ['req', 'B02 通用需求页'], ['prompts', 'B03 提示词页'], ['aitools', 'B04 AI 工具页'], ['plan', 'B05 项目管理页']] as const) {
  try { await sweepPage(k, l); } catch (e) { blockedSite(l, `页面未就绪：${why(e)}`); }
}

/* ---------- C 组：规则单源守卫 ---------- */
const src = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const appCss = src('web/src/App.tsx');
const iHover = appCss.indexOf('.abtn:hover:not(:disabled) svg');
const iActive = appCss.indexOf('.abtn:active:not(:disabled) svg');
ok('C-01 App.tsx 基准：hover 与 active 都带 :not(:disabled)（特异性拉平，T04544 修复本体）',
  iHover > 0 && iActive > 0, `iHover=${iHover} iActive=${iActive}`);
ok('C-02 App.tsx 基准：active 规则排在 hover 之后（同特异性靠后者胜出）', iActive > iHover, `hover@${iHover} active@${iActive}`);
const dupHits: string[] = [];
for (const f of ['web/src/pages/ReqPage.tsx', 'web/src/pages/PromptsPage.tsx', 'web/src/pages/AIToolsPage.tsx',
  'web/src/pages/ArchivePage.tsx', 'web/src/ui/CopyButton.tsx', 'web/src/ui/notice.tsx', 'web/src/ui/dialogs.tsx']) {
  const s = src(f);
  const hits = [...s.matchAll(/\.abtn:(hover|active)\s+svg/g), ...s.matchAll(/\.ghost:(hover|active)\s+svg/g)];
  if (hits.length) dupHits.push(`${f}:${hits.length}`);
}
ok('C-03 页面级重复定义清零：动画基准只由 App.tsx 单源持有（ReqPage/PromptsPage 旧 `.abtn:* svg` 已删）',
  dupHits.length === 0, dupHits.join(' | ') || '无重复');
const bundleDir = path.join(REPO, 'web/dist/assets');
const bundleFresh = fs.existsSync(bundleDir) && fs.readdirSync(bundleDir).some((f) => {
  if (!/\.(js|css)$/.test(f)) return false;
  const s = fs.readFileSync(path.join(bundleDir, f), 'utf8');
  return s.includes('.abtn:active:not(:disabled) svg') && !/\.abtn:active\s+svg/.test(s);
});
ok('C-04 发布新鲜度：当前 dist 包既含 :not(:disabled) 修复、也不再残留页面级旧规则', bundleFresh, 'web/dist/assets 逐文件核对');

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(900);
// 回调体内不得出现「箭头函数赋给变量」：tsx/esbuild 的 keepNames 会注入浏览器里不存在的 __name，整段 evaluate 直接 ReferenceError
const live = await page.evaluate(() => {
  const out = [];
  const sheets = document.styleSheets;
  for (let i = 0; i < sheets.length; i += 1) {
    let rules: any = null;
    try { rules = sheets[i].cssRules; } catch { continue; }
    if (!rules) continue;
    for (let j = 0; j < rules.length; j += 1) {
      const sel = String((rules[j] as any).selectorText || '');
      if (!/(^|[,>\s])(\.abtn|\.ghost)[^\s,]*:(hover|active)/.test(sel)) continue;
      let ids = 0, cls = 0, typ = 0;
      const parts = sel.split(',');
      for (let k = 0; k < parts.length; k += 1) {
        const p = parts[k];
        ids += (p.match(/#[\w-]+/g) || []).length;
        cls += (p.match(/\.[\w-]+/g) || []).length;
        cls += (p.match(/\[[^\]]+\]/g) || []).length;
        cls += (p.match(/:(?!not\b)[\w-]+/g) || []).length;
        const nots = (p.match(/:not\(([^)]*)\)/g) || []).join('');
        cls += (nots.match(/\.[\w-]+|:[\w-]+/g) || []).length;
        typ += (p.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g) || []).length;
      }
      out.push({
        sheet: ((sheets[i] as any).ownerNode as HTMLElement)?.tagName || 'inline',
        sel,
        disabled: /:not\(:disabled\)/.test(sel),
        spec: ids * 10000 + cls * 100 + typ,
        transform: String((rules[j] as any).style?.transform || ''),
      });
    }
  }
  return out;
});
const legacyLive = live.filter((r: any) => !r.disabled && /transform/.test(r.transform));
ok('C-05 活体样式表：所有带 transform 的 abtn/ghost hover/active 规则都带 :not(:disabled)（旧规则一旦复活即在此转红；底色类 .abtn:hover{background} 不参与——它不是 T04544 修复的那条链）',
  legacyLive.length === 0, legacyLive.map((r: any) => `${r.sheet} ${r.sel} -> ${r.transform}`).join(' | '));
const act = live.filter((r: any) => /:active/.test(r.sel)), hov = live.filter((r: any) => /:hover/.test(r.sel));
const maxAct = act.length ? Math.max(...act.map((r: any) => r.spec)) : 0;
const maxHov = hov.length ? Math.max(...hov.map((r: any) => r.spec)) : 0;
ok('C-06 活体特异性：active 规则的最高特异性 ≥ hover 规则（否则按下永远被悬浮压住）',
  act.length > 0 && hov.length > 0 && maxAct >= maxHov, `maxActive=${maxAct} maxHover=${maxHov} 规则数=${live.length}`);
const realSvgRules = live.filter((r: any) => /svg/.test(r.sel) && /:active/.test(r.sel) && /scale\([^)]*\.88/.test(r.transform));
ok('C-07 活体规则里确有 scale(.88) 的 active 基准（不是只靠源码字符串自证；注：CSS 序列化会把 .88 归一成 0.88）', realSvgRules.length > 0,
  realSvgRules.map((r: any) => `${r.sel} -> ${r.transform}`).join(' | ') || `活体规则清单=${JSON.stringify(live)}`);
await page.screenshot({ path: SHOT('final') }).catch(() => {});
await browser.close();

console.log(`\nA 组调用点：${sites.length} 个（工单范围 10 个文件 + ghost 同类）`);
console.log(`PASS=${pass} FAIL=${fail} BLOCKED=${blocked}`);
if (fail > 0 || blocked > 0) process.exitCode = 1;
