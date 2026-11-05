// T04484 GUI 门脚本：在隔离实例上真实浏览器操作「记忆管理」页签与产品标签弹窗（22 断言）。
//
// 前置：
//   1) 隔离后端已启动（MTask_PORT=39901、MTask_DATA_DIR 指向快照库、web/dist 已构建）
//   2) 本机有 Chrome；`npm i --no-save playwright-core`（未入 package.json，按需安装）
// 运行：node scripts/tests/verify-t04484-memory-gui.mjs
// 说明：全局按钮有 transform transition，Playwright 常规/force 点击会卡稳定性或不触发
//       React onClick，故脚本统一走 DOM 原生 click（clickText / clickInRow / evaluate）。
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://127.0.0.1:39901/';
const SHOT = (n) => path.join(os.tmpdir(), `gui-${n}.png`);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

// 全局 button 有 transform transition，Playwright 点击会卡在 "waiting for element to be stable"；
// force 在浮层里也偶发不触发 React onClick —— 统一用 DOM 原生 click（按文本匹配）。
const clickText = async (text, rootSel = null) => page.evaluate(({ text, rootSel }) => {
  const root = rootSel ? document.querySelector(rootSel) : document;
  const norm = (s) => (s ?? '').replace(/\s+/g, '');
  const btn = [...root.querySelectorAll('button')].find((b) => norm(b.textContent).includes(norm(text)));
  if (!btn) throw new Error('button not found: ' + text);
  btn.click();
}, { text, rootSel });

// 行内按钮（编辑/删除）：synthetic click 在 force 下不触发 React onClick，按「行文本 + 按钮文本」原生点击
const clickInRow = async (rowText, buttonText) => page.evaluate(({ rowText, buttonText }) => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const row = rows.find((r) => r.textContent.includes(rowText));
  if (!row) throw new Error('row not found: ' + rowText);
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.includes(buttonText));
  if (!btn) throw new Error('button not found in row: ' + buttonText);
  btn.click();
}, { rowText, buttonText });

// 每次运行用唯一标题，避免重复跑时同名行干扰「编辑/删除」定位
const uniqTitle = 'GUI新增-' + Date.now();
const editedTitle = uniqTitle + '-已编辑';

try {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  // 每轮自备一条 PII 待确认候选（上一轮会把它确认入库消耗掉）
  await page.request.post(URL + 'api/memories', {
    data: {
      productKey: 't04498-verify', type: 'project', title: 'GUI-待确认候选-' + Date.now(),
      content: '紧急联系人电话 13800138000，请勿自动入库',
    },
  });

  // 1) 设置 → 记忆管理（走应用自身全局导航事件）
  await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'settings' } })));
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    localStorage.setItem('settings.tab', JSON.stringify('memory'));
    globalThis.dispatchEvent(new CustomEvent('mtaskSettingsTab', { detail: { key: 'memory' } }));
  });
  await page.waitForTimeout(1500);
  check('设置页出现「记忆管理」页签', (await page.locator('nav button', { hasText: '记忆管理' }).count()) >= 1);
  await page.screenshot({ path: SHOT('02-memory-tab'), fullPage: false });

  const body = await page.locator('body').innerText();
  check('页签标注隔离范围「本页记忆仅属于产品」', body.includes('本页记忆仅属于产品'));
  check('产品下拉选中 t04498-verify', (await page.locator('select[aria-label="产品标签"]').inputValue()) === 't04498-verify',
    await page.locator('select[aria-label="产品标签"]').inputValue());
  const rowCount = await page.locator('table tbody tr').count();
  check('记忆列表渲染（真实抽取 3 条 + 手工 1 条）', rowCount >= 4, String(rowCount));
  check('真实抽取记忆可见', body.includes('网关漏桶参数误配导致限流'));
  check('待确认区块可见（PII 候选入队）', body.includes('待确认（'));
  check('项目级自动抽取开关区块存在', body.includes('自动抽取（项目级）'));
  check('孤立标签维护区存在', body.includes('孤立标签'));

  // 2) 新增记忆
  await page.fill('input[aria-label="新记忆标题"]', uniqTitle);
  await page.fill('input[aria-label="新记忆内容"]', '这是一条用于浏览器实测的临时记忆内容，验证新增表单与列表刷新是否正常联动。');
  await page.waitForTimeout(300);
  await clickText('新增');
  await page.waitForTimeout(2000);
  const afterCreate = await page.locator('body').innerText();
  check('新增后列表出现新记忆', afterCreate.includes(uniqTitle), afterCreate.slice(0, 120).replace(/\n/g, ' | '));
  await page.screenshot({ path: SHOT('03-created'), fullPage: false });

  // 3) 行内编辑
  await clickInRow(uniqTitle, '编辑');
  await page.waitForTimeout(600);
  const editTitle = page.locator('input[aria-label="编辑标题"]');
  check('行内编辑打开（标题输入框出现）', (await editTitle.count()) === 1);
  await editTitle.fill(editedTitle);
  await page.waitForTimeout(200);
  await clickText('保存');
  await page.waitForTimeout(1500);
  check('编辑保存后标题更新', (await page.locator('body').innerText()).includes(editedTitle));

  // 4) 删除（二次确认）
  await clickInRow(editedTitle, '删除');
  await page.waitForTimeout(600);
  // 确认弹窗同样用原生 click：force 点它不会触发 React 的 onConfirm
  await page.locator('[aria-label="确定：确认执行该操作"]').evaluate((el) => el.click());
  await page.waitForTimeout(1500);
  check('删除确认后行消失', !(await page.locator('body').innerText()).includes(editedTitle));

  // 5) 待确认队列：确认入库
  const beforeConfirm = await page.locator('table tbody tr').count();
  await clickText('确认入库');
  await page.waitForTimeout(2000);
  const afterConfirm = await page.locator('table tbody tr').count();
  const afterBody = await page.locator('body').innerText();
  check('确认入库后列表 +1', afterConfirm >= beforeConfirm + 1, `${beforeConfirm}->${afterConfirm}`);
  check('确认条目出现在列表', afterBody.includes('GUI-待确认候选'));
  const pendingAfter = await (await page.request.get(URL + 'api/memories/pending?productKey=t04498-verify')).json();
  check('队列项已清空', (pendingAfter.memories ?? []).length === 0, String((pendingAfter.memories ?? []).length));
  await page.screenshot({ path: SHOT('04-confirmed'), fullPage: false });

  // 6) 标签重命名入口（断言弹窗预填后取消，不改数据）
  await clickText('重命名标签');
  await page.waitForTimeout(800);
  const dlgInput = page.locator('input').last();
  check('重命名弹窗出现', (await page.locator('[aria-label="确定：确认并提交输入"]').count()) === 1);
  check('重命名弹窗默认值=当前产品', (await dlgInput.inputValue()) === 't04498-verify', await dlgInput.inputValue());
  await page.locator('[aria-label="取消：放弃本次输入"]').click({ force: true });
  await page.waitForTimeout(500);

  // 7) 项目级自动抽取开关可切换
  const sw = page.locator('label', { hasText: '自动抽取已' }).locator('input[type="checkbox"]');
  const before = await sw.isChecked();
  // 受控 checkbox 必须走原生 click 才会触发 React onChange
  await sw.evaluate((el) => el.click());
  await page.waitForTimeout(1200);
  const after = await sw.isChecked();
  check('自动抽取开关可切换', before !== after, `${before}->${after}`);

  // 8) 产品标签弹窗（T04133）：新项目 → 工作空间绑定弹窗含产品标签栏
  await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } })));
  await page.waitForTimeout(1200);
  await page.locator('button[aria-label="新项目：新建一个任务项目"]').evaluate((el) => el.click());
  await page.waitForTimeout(800);
  await page.locator('input').last().fill('GUI-产品标签弹窗验证');
  await page.locator('[aria-label="确定：确认并提交输入"]').evaluate((el) => el.click());
  await page.waitForTimeout(2500);
  const modalText = await page.locator('body').innerText();
  check('新建项目后出现工作空间绑定弹窗', modalText.includes('选择工作空间'));
  check('弹窗包含「产品标签（可选，留空＝未绑定产品）」', modalText.includes('产品标签（可选，留空＝未绑定产品）'));
  check('产品标签输入框存在', (await page.locator('[aria-label="产品标签"]').count()) >= 1);
  await page.screenshot({ path: SHOT('05-project-tag-modal'), fullPage: false });
  await page.locator('[aria-label="产品标签"]').fill('t04498-verify');
  await clickText('保存产品标签');
  await page.waitForTimeout(1500);
  check('标签保存生效', (await page.locator('body').innerText()).includes('t04498-verify'));
  await page.screenshot({ path: SHOT('06-project-tag-saved'), fullPage: false });
} catch (e) {
  console.log('EXCEPTION:', String(e?.message ?? e).slice(0, 300));
  await page.screenshot({ path: SHOT('zz-error'), fullPage: false }).catch(() => {});
  fail++;
} finally {
  await browser.close();
}
console.log(`\n结果: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exitCode = 1;
