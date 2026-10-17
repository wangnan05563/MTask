/**
 * T02143 UI 实测（临时脚本，不入库）：
 *  ① dev 模式下 validateDOMNesting 是否消失 + 卡片容器形态；
 *  ② 全站点 Tab 扫描「button 套 button」实例数（根因是否别处也有）；
 *  ③ 键盘通路：聚焦卡片 Enter 展开 → 角标按钮 Enter 只弹重置确认、不触发展开。
 *
 * T02309：旁证文件名带运行标识防并发互覆。before/after 是一对（分两次跑），打标识会拆散配对，
 * 故支持显式传 tag：`node scripts/.t02143-ui-probe.mjs before mytag` / `... after mytag`；
 * 不传则用进程级标识（单次取证场景）。
 */
import { writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'file:///D:/code/otherProjects/11_OcrDemo/node_modules/playwright/index.mjs';

const LOCAL = [
  'C:/Users/hspcadmin/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const MODE = process.argv[2] ?? 'after';
const TAG = process.argv[3] ?? `${process.pid}-${Date.now()}`;
const URL = 'http://127.0.0.1:5175';
const OUT = `D:/code/otherProjects/26_MTask/.workbuddy/t02143-${MODE}-${TAG}`;
const browser = await chromium.launch({ headless: true, executablePath: LOCAL.find((p) => existsSync(p)) });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const msgs = [];
page.on('console', (m) => msgs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => msgs.push(`pageerror: ${e.message}`));
const nested = () => page.evaluate(() => ({
  buttonInButton: document.querySelectorAll('button button').length,
  samples: [...document.querySelectorAll('button button')].slice(0, 4).map(
    (el) => `${el.tagName}«${(el.textContent ?? '').trim().slice(0, 16)}»`),
}));

const guide = page.getByRole('button', { name: '跳过向导' });
const dismissGuide = async () => {
  // 向导浮层（含 跳过/下一步 的 fixed 遮罩）会拦截指针事件；React 状态里也已 seen，直接摘掉遮罩节点
  await page.evaluate(() => {
    for (const el of [...document.querySelectorAll('div')]) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (cs.zIndex !== 'auto' && Number(cs.zIndex) < 100) continue;
      if (/向导|跳过/.test(el.textContent ?? '') && (el.textContent ?? '').length < 4000) el.remove();
    }
  }).catch(() => {});
  await page.waitForTimeout(120);
};
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(1_500);

// ② 全站点扫描：直接枚举侧栏 .nav-btn 的 aria-label，DOM 级点击（扫描用途，不判交互）
const sweep = {};
const navLabels = await page.evaluate(() =>
  [...document.querySelectorAll('.nav-btn')].map((b) => b.getAttribute('aria-label') ?? '').filter(Boolean));
for (const label of navLabels) {
  await page.evaluate((l) => {
    [...document.querySelectorAll('.nav-btn')].find((b) => b.getAttribute('aria-label') === l)?.click();
  }, label);
  await page.waitForTimeout(700);
  sweep[label] = { ...(await nested()), 卡片数: await page.evaluate(() =>
    [...document.querySelectorAll('div[role=button],button')].filter((el) => /工作面板/.test(el.textContent ?? '')).length) };
}

// ① 卡片容器形态（回 AI 工作台）
await page.evaluate(() => {
  [...document.querySelectorAll('.nav-btn')].find((b) => /工作台/.test(b.getAttribute('aria-label') ?? ''))?.click();
});
await page.waitForTimeout(900);
const cards = await page.evaluate(() => {
  const list = [...document.querySelectorAll('div[role=button].card-btn, button.card-btn, button, div[role=button]')]
    .filter((el) => /工作面板/.test(el.textContent ?? '') && (el.getAttribute('aria-label') ?? '').length > 0);
  return list.map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    tabIndex: el.getAttribute('tabindex'),
    aria: (el.getAttribute('aria-label') ?? '').slice(0, 20),
    innerButtons: el.querySelectorAll('button').length,
    transition: getComputedStyle(el).transition.slice(0, 40),
  }));
});

// ③ 键盘通路（工单口径 3）：聚焦卡片 Enter 展开 → Tab 到角标按钮 → Enter 只弹重置确认、不触发展开
const kb = { 说明: '需存在带 onReset 的卡片' };
const target = page.locator('div[role=button].card-btn').filter({ has: page.locator('button[aria-label^=重置]') }).first();
if (await target.count()) {
  const expanded = async () => (await target.innerText()).includes('收起工作面板');
  const resetDialog = () => page.evaluate(() =>
    /重置将清空控制台任务/.test(document.body.innerText || ''));
  kb.卡片 = await target.getAttribute('aria-label');
  await target.evaluate((el) => el.focus());
  kb.聚焦元素 = await page.evaluate(() => document.activeElement?.getAttribute('role') + '/' + document.activeElement?.tagName);
  const e0 = await expanded();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(350);
  const e1 = await expanded();
  kb.Enter前展开态 = e0;
  kb.Enter后展开态 = e1;
  kb.Enter切换生效 = e0 !== e1;
  kb.Enter后弹层 = await resetDialog();

  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  kb.Tab后聚焦 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
  kb.角标Enter弹确认 = await resetDialog();
  kb.角标Enter后展开态未变 = (await expanded()) === e1;
  await page.screenshot({ path: `${OUT}-keyboard.png` });
  await page.keyboard.press('Escape'); // 取消，不真的重置
  await page.waitForTimeout(250);
  kb.取消后弹层消失 = !(await resetDialog());
}

// 再点开一张卡片做视觉取证
await page.getByRole('button', { name: /AI 周报生成/ }).first().click().catch(() => {});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}.png` });

const domNesting = msgs.filter((m) => /validateDOMNesting/.test(m));
writeFileSync(`${OUT}-console.txt`, msgs.join('\n'), 'utf8');
writeFileSync(`${OUT}-report.json`, JSON.stringify({ 站点扫描: sweep, 卡片明细: cards, 键盘: kb }, null, 2), 'utf8');
console.log(JSON.stringify({
  mode: MODE,
  validateDOMNesting_条数: domNesting.length,
  样本: domNesting.slice(0, 2),
  全站嵌套按钮: Object.fromEntries(Object.entries(sweep).map(([k, v]) => [k, v.buttonInButton])),
  卡片数: cards.length,
  卡片形态: cards.map((c) => `${c.tag}[role=${c.role}][tabindex=${c.tabIndex}] 内按钮${c.innerButtons} transition:${c.transition}`),
  键盘: kb,
}, null, 1));
await browser.close();
