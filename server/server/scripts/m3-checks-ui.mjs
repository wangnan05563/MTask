#!/usr/bin/env node
/**
 * T01496：全量验收——交互级 UI 断言集（补齐 M1/M2 遗留、只有真实浏览器才能打定的项）。
 *
 * 覆盖（PRD §13）：
 *  - A7  生成卡片与其余卡片样式一致（computedStyle/className 比对，M2 曾标 SKIP）；
 *  - A8  「两类通道可共存 + 确认后才触发」中的前端门控（M2 A8 只打了 HTTP 契约，交互侧标 SKIP）；
 *  - A13 「AI 草稿保持」——tcgen.draft 会话键切页返回后是否还原草稿视图（M1 曾标 SKIP）；
 *  - M3  虚拟滚动渲染不变式——「全部」>1000 时 DOM `<tr>` 有界（不随条数线性增长）、分页档 DOM=页大小
 *        （T01495 result 明确建议「补 m3-checks-ui.mjs 走 CDP 断言」，把 verified=false 收敛为实测）。
 *
 * 前置：编排器（full-acceptance.mjs）已拉起一个开着 CDP 的无头 Chrome 并传入 --cdp=。
 * 连不上 CDP → 打印 M3UI 全段 skip，交上层如实标 SKIP，绝不冒充已验。
 *
 * 隔离纪律（硬规则#8）：自举隔离实例（MTask_PORT + 临时 MTask_DATA_DIR，前缀 mtask-m3-），
 *  只造带前缀自建项目并整体随临时库销毁；用完即杀进程、清目录。
 *
 * 输出协议：stdout 末行 `M3UI:<json>`（{results,pass,fail,skip}），stderr 逐条 PASS/FAIL 供调试。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkHttp } from './m1-checks-api.mjs';
import { connectCdp } from './m1-checks-ui.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name, dft) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
};
const CDP = flag('cdp', 'http://127.0.0.1:9333');
const CASES_N = Number(flag('cases', '1050')); // >1000 才触发虚拟；留 50 条余量防边界

const results = [];
const push = (k, pass, msg, skip = false) => { results.push({ k, pass: !!pass, skip, msg: String(msg ?? '').slice(0, 240) }); process.stderr.write(`${skip ? 'SKIP' : pass ? 'PASS' : 'FAIL'}  ${k}  ${msg ?? ''}\n`); };

/* ---------- 隔离实例自举（与 m1/m2 同构） ---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function spawnInstance({ port, dataDir, runner }) {
  const env = { ...process.env, MTask_PORT: String(port), MTask_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: '1' };
  if (runner === 'electron') {
    const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    return spawn(exe, ['server/dist/index.js'], { cwd: ROOT, env, windowsHide: true });
  }
  return spawn(process.execPath, [path.join(ROOT, 'server', 'dist', 'index.js')], { cwd: ROOT, env, windowsHide: true });
}
async function waitForHealth(base, child, timeoutMs = 45000) {
  const t0 = Date.now(); let exited = false; let stderr = '';
  child.on('exit', () => { exited = true; });
  child.stderr?.on('data', (b) => { stderr = (stderr + b.toString()).slice(-3000); });
  while (Date.now() - t0 < timeoutMs) {
    if (exited) return { ok: false, stderr };
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return { ok: true, stderr }; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, stderr: stderr || 'health 等待超时' };
}
async function bootIsolated() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-m3-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let runner = 'node';
  let child = spawnInstance({ port, dataDir, runner });
  let res = await waitForHealth(base, child);
  if (!res.ok && /ERR_DLOPEN_FAILED/.test(res.stderr)) {
    child.kill(); runner = 'electron';
    child = spawnInstance({ port, dataDir, runner });
    res = await waitForHealth(base, child);
  }
  if (!res.ok) throw new Error(`隔离实例起不来 @ ${base}\n${res.stderr}`);
  process.stderr.write(`隔离实例就绪 ${base} runner=${runner}\n`);
  return { base, child, dataDir, runner };
}
function sweepTemp(dir) {
  if (!dir || !path.basename(dir).startsWith('mtask-m3-')) { process.stderr.write(`跳过清理（非本脚本前缀）：${dir}\n`); return 'skipped'; }
  try { fs.rmSync(dir, { recursive: true, force: true }); return 'removed'; } catch (e) { return 'locked:' + e.message; }
}

/* ---------- 页内工具：注入后挂 window.__m3 ---------- */
const HELPERS = `(function () {
  var TC = 'section[aria-label="测试用例面板"]';
  var t = {
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    btns: function (root) { return Array.prototype.slice.call((root || document).querySelectorAll('button')); },
    byAria: function (v, root) { return t.btns(root).find(function (b) { return (b.getAttribute('aria-label') || '') === v; }); },
    ariaPrefix: function (v, root) { return t.btns(root).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf(v) === 0; }); },
    byText: function (v, root) { return t.btns(root).find(function (b) { return (b.textContent || '').indexOf(v) >= 0; }); },
    // A7：能力卡容器自 T02143 起是 div[role=button]（卡片右上角有原生 button 角标，HTML 禁止按钮套按钮），
    //      早先的 d69b16c 探针只查 button.ln——容器复位后恒为 0，属探针滞后而非产品缺陷。
    //      这里按「可交互元素」取，button 与 [role=button] 两态都认，断言语义不变。
    interactive: function (root) { return Array.prototype.slice.call((root || document).querySelectorAll('button, [role="button"]')); },
    cardByAria: function (v, root) { return t.interactive(root).find(function (b) { return (b.getAttribute('aria-label') || '') === v; }); },
    cards: function () { return Array.prototype.slice.call(document.querySelectorAll('button.ln[aria-label], [role="button"].ln[aria-label]')); },
    cardStyle: function (aria) {
      var b = t.interactive(document).find(function (x) { return x.classList.contains('ln') && (x.getAttribute('aria-label') || '') === aria; });
      if (!b) return null;
      var cs = getComputedStyle(b);
      var title = b.querySelector('span > span');
      return { cls: b.className, pad: cs.padding, br: cs.borderRadius, bg: cs.backgroundColor,
        titleFs: title ? getComputedStyle(title).fontSize : null, titleFw: title ? getComputedStyle(title).fontWeight : null };
    },
    tcBody: function () { var s = document.querySelector(TC); var tb = s ? s.querySelector('tbody') : null; return tb; },
    // 受控 select：用原生 setter 写值再派发 change，React 才会走 onChange（直接改 .value 不触发）
    setSelect: function (sel, val) {
      if (!sel) return 'no-select';
      var proto = Object.getPrototypeOf(sel);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(sel, String(val));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    },
    enterNav: async function (label) {
      var nav = t.byText(label, document.querySelector('nav')) || t.byText(label, document);
      if (nav) nav.click();
      for (var i = 0; i < 100 && !t.byText(label === 'AI 工作台' ? '从 PRD 生成测试用例' : '需求跟踪矩阵', document); i++) await t.sleep(150);
      return !!nav;
    },
  };
  window.__m3 = t;
  return 'helpers-ok';
})()`;

/* ---------- A13 草稿快照（tcgen.draft 结构，与 DraftSnapshot 对齐） ---------- */
function draftSnapshot(projectId) {
  return {
    projectId,
    requirements: [{ reqNo: 'R-哨兵-1', title: '草稿恢复哨兵需求', content: 'c', sourceRef: 's', priority: 'P0', isNew: false }],
    cases: [
      { reqNo: 'R-哨兵-1', module: '登录', title: '草稿用例A', preconditions: '', expected: '', testData: '', postconditions: '', priority: 'P0', type: '功能', method: '手工', tags: '', steps: [{ action: 'a', expected: 'e' }], sourceKey: 'sk-a', sourceHash: 'h-a', include: true, alreadyImported: false },
      { reqNo: 'R-哨兵-1', module: '登录', title: '草稿用例B', preconditions: '', expected: '', testData: '', postconditions: '', priority: 'P1', type: '功能', method: '手工', tags: '', steps: [], sourceKey: 'sk-b', sourceHash: 'h-b', include: true, alreadyImported: false },
    ],
    coverage: { total: 1, covered: 1, uncovered: 0, rate: 100, byReq: [{ reqId: 'rq-1', reqNo: 'R-哨兵-1', caseCount: 2 }] },
    notes: [], truncated: false, source: '内部 PRD 文档',
  };
}

async function main() {
  const cdpReachable = await fetch(`${CDP}/json`).then((r) => r.ok).catch(() => false);
  if (!cdpReachable) {
    push('M3UI_cdpUnreachable', false, `CDP ${CDP} 不可达——A7/A8门控/A13草稿/虚拟滚动 DOM 无法判定`, true);
    process.stdout.write('M3UI:' + JSON.stringify({ results, pass: 0, fail: 0, skip: 1 }) + '\n');
    return 2;
  }

  const booted = await bootIsolated();
  const { base, child, dataDir } = booted;
  const origin = base.replace(/\/api\/?$/, '');
  const { call } = mkHttp(base);

  let c = null;
  try {
    /* ---- 种子：一个项目 + CASES_N 条用例（供虚拟滚动 DOM 计数） ---- */
    const proj = await call('POST', '/projects', { name: `M3UI-种子-${Date.now()}` });
    const tc = { call };
    for (let i = 1; i <= CASES_N; i++) {
      await tc.call('POST', '/plans/test-cases', { projectId: proj.id, title: `压测用例-${String(i).padStart(4, '0')}`, priority: 'P0' });
    }
    process.stderr.write(`种子用例 ${CASES_N} 条已入库（项目 ${proj.id}）\n`);

    c = await connectCdp(CDP);
    const reload = async () => { await c.send('Page.navigate', { url: origin + '/' }); await c.waitLoad(); await new Promise((r) => setTimeout(r, 1200)); await c.evalIn(HELPERS); };

    /* ================= A7 卡片一致性 ================= */
    await reload();
    await c.evalIn(`(function(){ return window.__m3.enterNav('AI 工作台'); })()`);
    await new Promise((r) => setTimeout(r, 700));
    const a7 = await c.evalIn(`(function(){ var t=window.__m3;
      var cards = t.cards().filter(function(b){ var a=b.getAttribute('aria-label')||''; return ['AI 项目计划导入','离线周报生成','AI 周报生成','原始需求生成 PRD','从 PRD 导入项目计划','从 PRD 生成测试用例'].indexOf(a)>=0; });
      var tcStyle = t.cardStyle('从 PRD 生成测试用例');
      var refStyle = t.cardStyle('AI 周报生成');
      var resetBtn = t.ariaPrefix('重置从 PRD 生成测试用例', document);
      return { n: cards.length, tc: tcStyle, ref: refStyle, hasReset: !!resetBtn };
    })()`);
    push('A7_tcGenCardPresent', a7.tc != null, `tc-gen 卡样式=${JSON.stringify(a7.tc)}`);
    push('A7_cardCountSix', a7.n === 6, `能力卡数=${a7.n}（应为 6）`);
    const styleSame = a7.tc && a7.ref && ['pad', 'br', 'bg', 'titleFs', 'titleFw'].every((p) => a7.tc[p] === a7.ref[p]);
    push('A7_styleConsistentWithSiblings', !!styleSame, `tc=${JSON.stringify(a7.tc)} ref=${JSON.stringify(a7.ref)}`);
    push('A7_hasResetCorner', a7.hasReset === true, 'tc-gen 卡具备卡片侧重置入口（与其余有产物卡一致）');

    /* ================= A8 双通道共存 + 确认后才触发（前端门控） ================= */
    const a8 = await c.evalIn(`(function(){ var t=window.__m3;
      var card = t.cardByAria('从 PRD 生成测试用例'); if (card) card.click();
      return !!card; })()`);
    await new Promise((r) => setTimeout(r, 800));
    const a8b = await c.evalIn(`(function(){ var t=window.__m3;
      var panel = t.byAria('开始生成测试用例');
      var box = panel ? panel.closest('div') : null;
      var root = document.querySelector('section,div'); // 面板在卡片下方内联
      var internalSel = document.querySelector('select[aria-label="选择内部 PRD 文档"]');
      var fileInput = document.querySelector('input[type="file"]');
      var idleHint = Array.prototype.slice.call(document.querySelectorAll('div')).some(function(d){ return (d.textContent||'').indexOf('点「开始生成」')>=0; });
      var generating = !!t.byAria('开始生成测试用例') && !!Array.prototype.slice.call(document.querySelectorAll('span')).find(function(s){return (s.textContent||'').indexOf('生成中')>=0;});
      return { hasTrigger: !!panel, hasInternal: !!internalSel, hasFile: !!fileInput, idleHint: idleHint, generating: generating };
    })()`);
    push('A8_channelsCoexist', a8b.hasInternal === true && a8b.hasFile === true, `内部选择器=${a8b.hasInternal} 外部上传=${a8b.hasFile}`);
    push('A8_singleConfirmTrigger', a8b.hasTrigger === true, '存在唯一显式「开始生成」按钮作为触发点');
    push('A8_notTriggeredUntilConfirm', a8b.generating === false && a8b.idleHint === true, `仅打开通道未点确认：generating=${a8b.generating} idleHint=${a8b.idleHint}`);

    /* ================= A13 AI 草稿保持（tcgen.draft 切页返回还原） ================= */
    await c.evalIn(`(function(){ var pid=${JSON.stringify(proj.id)};
      ['report.showTcGen','tcgen.project','tcgen.draft'].forEach(function(k){ sessionStorage.removeItem(k); });
      sessionStorage.setItem('report.showTcGen', JSON.stringify(true));
      sessionStorage.setItem('tcgen.project', JSON.stringify(pid));
      sessionStorage.setItem('tcgen.draft', ${JSON.stringify(JSON.stringify(draftSnapshot(proj.id)))});
      return 1; })()`);
    await reload();
    await c.evalIn(`(function(){ return window.__m3.enterNav('AI 工作台'); })()`);
    await new Promise((r) => setTimeout(r, 1200));
    const a13 = await c.evalIn(`(function(){ var t=window.__m3;
      // showTcGen 已恢复 true → 面板应自动展开并从 tcgen.draft 还原
      var confirmBtn = t.byAria('确认导入');
      var checks = Array.prototype.slice.call(document.querySelectorAll('input[aria-label^="是否导入用例"]'));
      var cov = Array.prototype.slice.call(document.querySelectorAll('strong')).find(function(s){ return (s.textContent||'').indexOf('覆盖度')>=0; });
      return { hasConfirm: !!confirmBtn, nChecks: checks.length, cov: cov ? cov.textContent.trim() : null };
    })()`);
    push('A13_aiDraftRestoredView', a13.hasConfirm === true, `切页返回后草稿视图「确认导入」按钮=${a13.hasConfirm}`);
    push('A13_aiDraftCaseCountKept', a13.nChecks === 2, `还原草稿用例 checkbox 数=${a13.nChecks}（快照 2 条）`);
    push('A13_aiDraftCoverageKept', /覆盖度/.test(String(a13.cov ?? '')), `覆盖度条=${a13.cov}`);

    /* ================= M3 虚拟滚动 DOM 不变式 ================= */
    await c.evalIn(`(function(){ var pid=${JSON.stringify(proj.id)};
      ['plan.projectId','plan.showTestCases','tc.pageSize','tc.page','tc.keyword','tc.reqFilter','tc.filters','tc.multi','tc.selIds'].forEach(function(k){ sessionStorage.removeItem(k); });
      sessionStorage.setItem('plan.projectId', JSON.stringify(pid));
      sessionStorage.setItem('plan.showTestCases', JSON.stringify(true));
      sessionStorage.setItem('tc.pageSize', JSON.stringify(0));
      return 1; })()`);
    await reload();
    await c.evalIn(`(function(){ return window.__m3.enterNav('项目管理'); })()`);
    await new Promise((r) => setTimeout(r, 1400));
    // 等 TC 面板出现且用例已载入
    let vReady = await c.evalIn(`(function(){ var t=window.__m3; return (async function(){
      for (var i=0;i<80 && !t.tcBody();i++) await t.sleep(150);
      var s=document.querySelector('section[aria-label="测试用例面板"]');
      var note = s ? Array.prototype.slice.call(s.querySelectorAll('div')).some(function(d){return (d.textContent||'').indexOf('启用虚拟滚动')>=0;}) : false;
      var trCount = t.tcBody() ? t.tcBody().querySelectorAll('tr').length : -1;
      var hidden = t.tcBody() ? t.tcBody().querySelectorAll('tr[data-spacer]').length : -1;
      return { trCount: trCount, hidden: hidden, note: note, pagerText: (function(){ var el=Array.prototype.slice.call((s||document).querySelectorAll('span')).find(function(x){return (x.textContent||'').indexOf('共')===0;}); return el?(el.textContent||'').trim():''; })() };
    })(); })()`);
    push('M3_virtualEngaged', vReady.note === true && vReady.trCount > 0, `全部模式载入 ${CASES_N} 条 → 虚拟提示=${vReady.note} tbody tr=${vReady.trCount}`);
    push('M3_domRowsBounded_notLinearInCount', vReady.trCount > 0 && vReady.trCount <= 40,
      `DOM <tr>=${vReady.trCount}（上界≈窗口36+占位2=38），远小于 ${CASES_N}；若退化为全量渲染将≈${CASES_N}`);
    push('M3_spacerRowsPresent', vReady.hidden >= 1, `占位行（tr[data-spacer]）=${vReady.hidden}（撑出与全量一致的滚动区间）`);

    // 滚到底：窗口滑动但 DOM 行数仍有界（不退化增长）
    const scrolled = await c.evalIn(`(function(){ var t=window.__m3; return (async function(){
      var tb=t.tcBody(); var sc=tb.closest('div'); if(!sc) return {err:'no-scroll-container'};
      sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll'));
      await t.sleep(500);
      tb=t.tcBody();
      return { trCount: tb.querySelectorAll('tr').length, hidden: tb.querySelectorAll('tr[data-spacer]').length };
    })(); })()`);
    push('M3_domBoundedAfterScrollToBottom', scrolled.trCount > 0 && scrolled.trCount <= 40,
      `滚到底后 DOM <tr>=${scrolled.trCount}（仍 ≤40，窗口随滚动滑动，证明非全量渲染）`);

    // 切分页档 200：虚拟关闭，数据重取 limit=200 → DOM=200（每页真实行，无占位、无虚拟提示）。
    // 1050→200 的重取+重挂是异步的（pageSize 进 load effect 依赖），须轮询至收敛，不能只睡固定一拍
    const pag = await c.evalIn(`(function(){ var t=window.__m3; return (async function(){
      var sel=document.querySelector('select[aria-label="每页条数"]');
      t.setSelect(sel, 200);
      var tr=-1;
      for (var i=0;i<40;i++){ await t.sleep(200); var tb=t.tcBody(); tr = tb?tb.querySelectorAll('tr').length:-1; if (tr>=0 && tr<=200) break; }
      var s=document.querySelector('section[aria-label="测试用例面板"]');
      var note = s ? Array.prototype.slice.call(s.querySelectorAll('div')).some(function(d){return (d.textContent||'').indexOf('启用虚拟滚动')>=0;}) : true;
      await t.sleep(300);
      tb=t.tcBody();
      return { trCount: tb?tb.querySelectorAll('tr').length:-1, hidden: tb?tb.querySelectorAll('tr[data-spacer]').length:-1, note: note };
    })(); })()`);
    push('M3_pagination200_domEqualsPageSize', pag.trCount === 200, `200 档 DOM <tr>=${pag.trCount}（应=页大小200，勿过度设计不虚拟）`);
    push('M3_pagination200_notVirtual', pag.note === false && pag.hidden === 0, `200 档无虚拟提示=${pag.note === false} 无占位行=${pag.hidden === 0}`);

    push('M3UI_noConsoleErrors', c.consoleErrors.length === 0, `${c.consoleErrors.length} 条：${c.consoleErrors.slice(0, 2).join(' | ').slice(0, 200)}`);
  } catch (e) {
    push('M3UI_ABORT', false, `执行中断：${String(e?.message ?? e).slice(0, 220)}`);
  } finally {
    if (c) c.close();
    child.kill();
    await new Promise((r) => setTimeout(r, 600));
    process.stderr.write(`临时数据目录 ${sweepTemp(dataDir)}：${dataDir}\n`);
  }

  const pass = results.filter((x) => x.pass).length;
  const skip = results.filter((x) => x.skip).length;
  const fail = results.length - pass - skip;
  process.stdout.write('M3UI:' + JSON.stringify({ results, pass, fail, skip }) + '\n');
  return fail > 0 ? 1 : skip > 0 ? 2 : 0;
}

process.exit(await main());
