/**
 * T01488：M1 验收回归——交互级断言集（PRD §13 验收表 A1/A13/A15 + A4 双向跳转 + A2 入口）。
 *
 * 与 `m1-checks-api.mjs` 的分工：那一份证明「数据真的对」，这一份证明「用户看得见、点得动」。
 * A1（按钮样式一致）、A13（切页/刷新会话态保持）本质是渲染与持久化契约，接口打不出来，只能驱动真实 DOM。
 *
 * 前置：需要一个开着 CDP 的 Chromium 指向被测实例前端（默认 http://127.0.0.1:9333）。
 * 连不上 CDP 时，编排器（`m1-regression.mjs`）会把整段标 SKIP 并让退出码=2，**绝不给假绿**。
 *
 * 沿用 t01485~t01487 探针的既有教训（勿回退）：
 *  - 会话键必须在 navigate 前写完（mount 时 useSessionState 一次性读 sessionStorage 初值）；
 *  - reload 会抽掉 window 上的工具，每次挂载后重新注入 helpers；
 *  - 按钮查找限定面板作用域（矩阵与用例面板有同名 aria-label）；
 *  - askConfirm 弹窗反扫 button[aria-label^="确定："]，不要拿 body.lastElementChild 当弹窗。
 */
import fs from 'node:fs';
import { mkReport } from './m1-checks-api.mjs';

/**
 * UI 段种子数据的唯一声明处。
 * 为什么由断言集自己声明数量，而不是让编排器随手造两条：
 * A13 要验「页码真的被保持」，就必须存在合法的第 2 页——小样本里任何 page>0 都会被面板
 * 当成越界回落，测出来的「保持」是假的。种子与断言分两处写、改一处忘另一处，
 * 就会退化成「断言迁就数据」，所以数量与关键词在这里和消费方绑在一起。
 */
export const UI_SEED = { cases: 205, keyword: '会话哨兵', pageSize: 200 };
// 哨兵筛选（关键词 + P0 + 当前需求）命中的就是全部种子，因此页数可由种子直接推出，
// 不必在断言里写死「第 2/2 页」——将来调 cases 或 pageSize 时分页文案会自动跟着变
const SEED_PAGES = Math.ceil(UI_SEED.cases / UI_SEED.pageSize);

/** 造一个干净项目：两条需求（一条带用例、一条零用例）+ UI_SEED.cases 条 P0 用例 */
export async function seedUiFixture(base, tag, opts = {}) {
  const c = opts.call ?? (await import('./m1-checks-api.mjs')).mkHttp(base).call;
  const proj = await c('POST', '/projects', { name: `${tag} UI 种子` });
  const reqA = await c('POST', '/plans/prd-requirements', { projectId: proj.id, title: `${UI_SEED.keyword}需求（带用例）` });
  await c('POST', '/plans/prd-requirements', { projectId: proj.id, title: `${UI_SEED.keyword}需求（零用例）` });
  // 逐条串行：case_no 由服务端扫全表取最大序号生成，并发插会撞唯一索引；本机 205 条实测 2s 内完成
  for (let i = 1; i <= UI_SEED.cases; i++) {
    await c('POST', '/plans/test-cases', {
      projectId: proj.id, reqId: reqA.id,
      title: `${UI_SEED.keyword}用例-${String(i).padStart(3, '0')}`,
      priority: 'P0',
      steps: i === 1 ? [{ action: '哨兵步骤', expected: '哨兵预期' }] : undefined,
    });
  }
  return { projectId: proj.id, reqIdWithCases: reqA.id };
}

/** CDP 连接：拿到 page target 的 ws，包一层 evaluate / navigate / waitLoad。
 *  T01496：导出给 m3-checks-ui.mjs 复用——CDP 握手/异常收集是全量验收 UI 段的公共底座，勿另造一份。 */
export async function connectCdp(cdpBase) {
  const targets = await (await fetch(`${cdpBase}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on CDP');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const fired = [];
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method) fired.push(msg.method);
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'unknown');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const waitLoad = async (timeoutMs = 25000) => {
    const base = fired.length;
    const t0 = Date.now();
    while (!fired.slice(base).includes('Page.loadEventFired')) {
      if (Date.now() - t0 > timeoutMs) throw new Error('load timeout');
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('in-page: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, evalIn, waitLoad, consoleErrors, close: () => ws.close() };
}

/** 页内工具：作用域定位 + 会话态写入 + 样式读取，注入后挂到 window.__m1 */
const HELPERS = `(function () {
  var TC = 'section[aria-label="测试用例面板"]';
  var MX = 'div[aria-label="需求跟踪矩阵面板"]';
  var t = {
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    ok: function (out, k, pass, msg) { out.push({ k: k, pass: !!pass, msg: String(msg === undefined ? '' : msg).slice(0, 240) }); },
    tc: function () { return document.querySelector(TC); },
    mx: function () { return document.querySelector(MX); },
    btns: function (root) { return Array.prototype.slice.call((root || document).querySelectorAll('button')); },
    byAria: function (v, root) { return t.btns(root).find(function (b) { return (b.getAttribute('aria-label') || '') === v; }); },
    ariaPrefix: function (v, root) { return t.btns(root).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf(v) === 0; }); },
    input: function (aria) { var el = document.querySelector(TC + ' input[aria-label="' + aria + '"]'); return el ? el.value : null; },
    expBtnOf: function (v) { var b = t.byAria(v); return b ? b.getAttribute('aria-expanded') : 'absent'; },
    // A1：入口按钮的可视样式（className 与相邻按钮比对）
    btnClass: function (v) { var b = t.byAria(v); return b ? b.className : 'absent'; },
    styleOf: function (v) {
      var b = t.byAria(v); if (!b) return null;
      var cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, color: cs.color, br: cs.borderRadius, pad: cs.padding, fs: cs.fontSize };
    },
    dialog: function () {
      var kids = Array.prototype.slice.call(document.body.children);
      for (var i = kids.length - 1; i >= 0; i--) { if (kids[i].querySelector('button[aria-label^="确定："]')) return kids[i]; }
      return null;
    },
    dlgText: function () { var d = t.dialog(); return d ? (d.textContent || '') : ''; },
    // 点「确定」放行 askConfirm（弹窗只有一个主操作按钮，前缀扫「确定：」）
    confirmYes: function () { var d = t.dialog(); var b = d ? d.querySelector('button[aria-label^="确定："]') : null; if (b) b.click(); return !!b; },
    chipCount: function (reqId) {
      var tr = document.querySelector(MX + ' tbody tr[data-req-id="' + reqId + '"]');
      if (!tr) return 'no-row';
      var chip = Array.prototype.slice.call(tr.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('下钻查看需求') === 0; });
      return chip ? (chip.textContent || '').trim() : 'no-chip';
    },
    enterPlan: async function () {
      var nav = t.btns(document.querySelector('nav')).find(function (b) { return (b.textContent || '').indexOf('项目管理') >= 0; });
      if (nav) nav.click();
      for (var i = 0; i < 80 && !t.byAria('需求跟踪矩阵'); i++) await t.sleep(200);
      return !!t.byAria('需求跟踪矩阵');
    },
  };
  window.__m1 = t;
  return 'helpers-ok';
})()`;

/**
 * A13 会话态恢复：mount 前把全部会话键写成哨兵值，进页后读回 UI 是否如实恢复。
 * 这是「切页返回不丢」的最硬证据——不是读 sessionStorage 自身（那只是自证），而是看渲染结果。
 */
const SEED_SESSION = (projectId, sentinel) => `(function () {
  var sid = ${JSON.stringify(projectId)};
  // 必须把跳转意图键也列入清理：plan.tcFocusReqId 是下钻写入的会话键，面板 mount 时只要它非空
  // 就会把 tc.reqFilter 抢写到那个旧需求上——上一轮跑留下的值不清，本轮哨兵会被静默覆写（跨跑污染）
  var keys = ['plan.showTestCases','plan.showPrd','plan.showMatrix','plan.tcFocusReqId','plan.matrixLocateReqId','tc.reqFilter','tc.keyword','tc.filters','tc.multi','tc.selIds','tc.page','tc.pageSize','tc.expanded','tc.newTitle','tc.filterOpen','tc.uncovered'];
  keys.forEach(function (k) { sessionStorage.removeItem(k); });
  sessionStorage.setItem('plan.projectId', JSON.stringify(sid));
  var s = ${JSON.stringify(sentinel)};
  Object.keys(s).forEach(function (k) { sessionStorage.setItem(k, JSON.stringify(s[k])); });
  localStorage.setItem('mtask.projectGuide.seen', '1');
  return 'seeded';
})()`;

export async function runUiChecks({ base, cdp = 'http://127.0.0.1:9333', projectId, reqIdWithCases, prefix = 'M1-UI' }) {
  void prefix; // 预留：将来多实例并行时用于区分报告归属
  const rpt = mkReport();
  const cdpReachable = await fetch(`${cdp}/json`).then((r) => r.ok).catch(() => false);
  if (!cdpReachable) {
    rpt.section('交互级断言（CDP 不可达）', ['A1', 'A13', 'A15', 'A4']);
    rpt.skip('UI_all', `CDP ${cdp} 不可达——A1/A13/A15/A4 无法在无浏览器下判定，整段标缺不算通过`);
    return { groups: rpt.groups, consoleErrors: [], skipped: true };
  }

  const c = await connectCdp(cdp);
  const ok = (k, cond, msg) => rpt.t(k, cond, msg);
  const origin = base.replace(/\/api\/?$/, '');

  // 先落 A13 的哨兵会话态，再 navigate（顺序反了初值就被 mount 时的 useState 吞掉）
  const sentinel = {
    'plan.showTestCases': true,
    'tc.reqFilter': reqIdWithCases,
    'tc.keyword': UI_SEED.keyword,
    'tc.filters': { module: '', priority: 'P0', type: '', status: '', result: '', orphanOnly: false },
    'tc.multi': true,
    'tc.selIds': ['sentinel-id-a', 'sentinel-id-b'],
    'tc.page': 1,
    'tc.pageSize': UI_SEED.pageSize,
    'tc.expanded': '',
    'tc.newTitle': '',
    'tc.filterOpen': true,
    'tc.uncovered': false,
  };

  try {
    await c.send('Page.navigate', { url: origin + '/' });
    await c.waitLoad();
    await new Promise((r) => setTimeout(r, 800));
    await c.evalIn(SEED_SESSION(projectId, sentinel));
    await c.send('Page.navigate', { url: origin + '/' });
    await c.waitLoad();
    await new Promise((r) => setTimeout(r, 1600));
    await c.evalIn(HELPERS);
    await c.evalIn(`(function(){ return window.__m1.enterPlan(); })()`);

    // 等用例面板出现（plan.showTestCases=true 应被恢复并自动展开）
    let tcShown = await c.evalIn(`(function(){ var t=window.__m1; return (async function(){ for(var i=0;i<60 && !t.tc();i++) await t.sleep(150); return !!t.tc(); })(); })()`);
    if (!tcShown) {
      await c.evalIn(`(function(){ var b=window.__m1.byAria('测试用例'); if(b) b.click(); return 1; })()`);
      await new Promise((r) => setTimeout(r, 1200));
      tcShown = await c.evalIn(`(function(){ return !!window.__m1.tc(); })()`);
    }

    rpt.section('A1 入口按钮出现且样式与相邻按钮一致', ['A1']);
    // 先让两个面板都展开，再比样式：A13 哨兵已把用例面板打开，若拿「激活态的用例按钮」去比
    // 「未激活的矩阵按钮」，底色/字色必然不同——那是比错了对象，不是样式不一致
    await c.evalIn(`(function(){ var t=window.__m1; return (async function(){
      if (!t.mx()) { var m=t.byAria('需求跟踪矩阵'); if(m) m.click(); for(var i=0;i<40 && !t.mx();i++) await t.sleep(150); }
      return !!t.mx(); })(); })()`);
    // 刚点开的按钮 background 还在 transition 里，立即取 computedStyle 会拿到中间帧（实测 rgba alpha=0.992），
    // 差 0.008 就能把「同源样式」误判成「不一致」——比样式前先让它跑完
    await new Promise((r) => setTimeout(r, 900));
    const cls = await c.evalIn(`(function(){ var t=window.__m1; return { tc: t.btnClass('测试用例'), mx: t.btnClass('需求跟踪矩阵'), exp: t.expBtnOf('测试用例'), mxExp: t.expBtnOf('需求跟踪矩阵') }; })()`);
    ok('A1_buttonPresent', typeof cls.tc === 'string' && cls.tc.includes('tbtn-anim'), `测试用例 className=${cls.tc}`);
    ok('A1_classSameAsMatrix', cls.tc === cls.mx, `tc=${cls.tc} matrix=${cls.mx}`);
    ok('A1_panelExpanded', cls.exp === 'true', `aria-expanded=${cls.exp}`);
    const sty = await c.evalIn(`(function(){ var t=window.__m1; var a=t.styleOf('测试用例'), b=t.styleOf('需求跟踪矩阵'); return {a:a,b:b}; })()`);
    const sameStyle = sty.a && sty.b && ['bg', 'color', 'br', 'pad', 'fs'].every((p) => sty.a[p] === sty.b[p]);
    ok('A1_activeStyleSameAsMatrix', sameStyle && cls.mxExp === 'true',
      `两者均激活态下 tc=${JSON.stringify(sty.a)} mx=${JSON.stringify(sty.b)}（matrix aria-expanded=${cls.mxExp}）`);

    rpt.section('A13 会话态恢复（§7.1 全部会话键，mount 前哨兵 → 渲染回读）', ['A13']);
    const restored = await c.evalIn(`(function(){ var t=window.__m1; return {
      kw: t.input('用例关键词筛选'),
      priority: (document.querySelector('section[aria-label="测试用例面板"] select[aria-label="按优先级筛选"]')||{}).value || null,
      filterOpen: t.expBtnOf('筛选'),
      newTitleInput: !!document.querySelector('section[aria-label="测试用例面板"] input[aria-label="新增用例标题"]'),
    }; })()`);
    ok('A13_keywordRestored', restored.kw === sentinel['tc.keyword'], `关键词 input=${restored.kw}`);
    ok('A13_priorityRestored', restored.priority === 'P0', `优先级 select=${restored.priority}`);
    ok('A13_filterPanelOpen', restored.filterOpen === 'true', `筛选 aria-expanded=${restored.filterOpen}`);
    // 多选项与 selIds 是内存态不直接可视，用 sessionStorage 读回 + 面板进入多选（批量条出现）双重证
    const multiVis = await c.evalIn(`(function(){ var t=window.__m1; return {
      hasBatchBar: !!t.ariaPrefix('批量', t.tc()),
      selRaw: sessionStorage.getItem('tc.selIds'), pageRaw: sessionStorage.getItem('tc.page'), psRaw: sessionStorage.getItem('tc.pageSize'), reqRaw: sessionStorage.getItem('tc.reqFilter'),
      prevDisabled: (function(){ var b=t.ariaPrefix('上一页', t.tc()); return b ? String(b.disabled) : 'absent'; })(),
      pagerText: (function(){ var el=Array.prototype.slice.call((t.tc()||document).querySelectorAll('span')).find(function(s){ var x=(s.textContent||''); return x.indexOf('共')===0 && x.indexOf('页')>=0; }); return el?(el.textContent||'').trim():'no-pager'; })(),
    }; })()`);
    ok('A13_multiModeRestored', multiVis.hasBatchBar === true && (JSON.parse(multiVis.selRaw || '[]')).length === 2,
      `批量条=${multiVis.hasBatchBar} selIds=${multiVis.selRaw}`);
    ok('A13_pageSizeRestored', Number(JSON.parse(multiVis.psRaw ?? '0')) === UI_SEED.pageSize, `pageSize=${multiVis.psRaw}`);
    ok('A13_reqFilterRestored', JSON.parse(multiVis.reqRaw ?? 'null') === reqIdWithCases, `reqFilter=${multiVis.reqRaw}`);
    // 分页真保持：种子造 >200 条让 pageSize=200 能切出 2 页，注入 page=1 后应真的在第 2 页（上一页可点）。
    // 之所以不直接规约小样本：面板会故意把越界页码回落（见下），小样本里 page>0永远被当成越界，测不出「保持」
    ok('A13_pageRestoredDrivesUI', multiVis.prevDisabled === 'false' && new RegExp(`第 ${SEED_PAGES}/${SEED_PAGES} 页`).test(multiVis.pagerText),
      `上一页 disabled=${multiVis.prevDisabled} pager="${multiVis.pagerText}"`);

    // 越界回落是 TestCasePanel 的刻意行为（items 空 & total>0 & page>0 → setPage(0)，避免「空列表 + 页码还在第3页」），
    // 所以这里验的是「回落生效」，而不是把 page 当成越界也要保持
    await c.evalIn(`(function(){ sessionStorage.setItem('tc.page', JSON.stringify(99)); return 1; })()`);
    await c.send('Page.navigate', { url: origin + '/' });
    await c.waitLoad();
    await new Promise((r) => setTimeout(r, 1500));
    await c.evalIn(HELPERS);
    await c.evalIn(`(function(){ return window.__m1.enterPlan(); })()`);
    const clamp = await c.evalIn(`(function(){ var t=window.__m1; return (async function(){
      for(var i=0;i<60 && !t.tc();i++) await t.sleep(150);
      var b=t.ariaPrefix('上一页', t.tc());
      var el=Array.prototype.slice.call((t.tc()||document).querySelectorAll('span')).find(function(s){ var x=(s.textContent||''); return x.indexOf('共')===0 && x.indexOf('页')>=0; });
      return { disabled: b ? String(b.disabled) : 'absent', pager: el?(el.textContent||'').trim():'no-pager', stored: sessionStorage.getItem('tc.page') };
    })(); })()`);
    ok('A13_outOfRangePageFallsBack', clamp.disabled === 'true' && new RegExp(`第 1/${SEED_PAGES} 页`).test(clamp.pager),
      `注入 page=99 越界 → 上一页 disabled=${clamp.disabled} pager="${clamp.pager}" 回写 tc.page=${clamp.stored}`);
    // §13 A13 原文还包含“AI 草稿均保持”：`tcgen.draft` 属 M2（T01492），本期产品里根本不存在这个键，
    // 没东西可验就不能把它算进 A13 的通过项——显式标 SKIP，跟上面那些真跑出来的实测分开
    rpt.skip('A13_aiDraftKept', '「AI 草稿保持」属 §13 A13 原文成分，但 tcgen.draft 由 M2/T01492 交付，本期无该会话键可验——归 M2 回归接揽');

    rpt.section('A4 矩阵 ⇄ 用例 双向跳转（chip 计数与筛选回填）', ['A4']);
    // chip 属矩阵面板，得先把它展开才能读——顺序错了会读到 no-row 而误判
    await c.evalIn(`(function(){ var t=window.__m1; return (async function(){
      if (!t.mx()) { var m=t.byAria('需求跟踪矩阵'); if(m) m.click(); for(var i=0;i<40 && !t.mx();i++) await t.sleep(150); }
      return !!t.mx(); })(); })()`);
    const chip = await c.evalIn(`(function(){ return window.__m1.chipCount(${JSON.stringify(reqIdWithCases)}); })()`);
    ok('A4_matrixChipHasCount', /\d/.test(String(chip)), `矩阵行「用例」chip=${chip}`);

    // 先清掉 A13 哨兵的多选/筛选（否则会干扰跳转判定），再真实点下钻
    await c.evalIn(`(function(){ ['tc.multi','tc.selIds','tc.reqFilter','tc.keyword','tc.filters','plan.tcFocusReqId','plan.matrixLocateReqId'].forEach(function(k){sessionStorage.removeItem(k);}); return 1; })()`);
    await c.send('Page.navigate', { url: origin + '/' });
    await c.waitLoad();
    await new Promise((r) => setTimeout(r, 1500));
    await c.evalIn(HELPERS);
    await c.evalIn(`(function(){ return window.__m1.enterPlan(); })()`);
    const jump = await c.evalIn(`(function(){ var t=window.__m1; return (async function(){
      if (!t.mx()) { var m=t.byAria('需求跟踪矩阵'); if(m) m.click(); for(var i=0;i<40 && !t.mx();i++) await t.sleep(150); }
      var tr=document.querySelector('div[aria-label="需求跟踪矩阵面板"] tbody tr[data-req-id=${JSON.stringify(reqIdWithCases)}]');
      if(!tr) return {err:'no-matrix-row'};
      var chip=Array.prototype.slice.call(tr.querySelectorAll('button')).find(function(b){return (b.getAttribute('aria-label')||'').indexOf('下钻查看需求')===0;});
      if(!chip) return {err:'no-drill-chip'};
      var label=chip.getAttribute('aria-label');
      chip.click();
      for(var j=0;j<60 && !t.tc();j++) await t.sleep(150);
      // 筛选是下钻后由面板 effect 异步回写的（setState → 重渲染 → useStorageState 写 sessionStorage），
      // 面板本来就已展开时上面的循环会第 0 轮就退出，不等一拍只会读到写之前的空值（伪 FAIL）。
      // 轮询条件不能写“值非空就退出”：useSessionState 在 mount 时会把初始空串回写成 '""'，
      // 那是个非空字符串，第 0 轮就会命中而永久卡在空值上（本轮三条 FAIL 的真因）——必须比解析后的值
      var want = JSON.stringify(${JSON.stringify(reqIdWithCases)});
      var got = '';
      for(var k=0;k<60;k++){ var v=sessionStorage.getItem('tc.reqFilter'); if(v && v !== '""'){ got=v; break; } await t.sleep(100); }
      if (got !== want) { await t.sleep(400); got = sessionStorage.getItem('tc.reqFilter') || ''; }
      var panel=document.querySelector('section[aria-label="测试用例面板"]');
      // 全量会话键快照：下钻不生效时，“chip 没反态”与“反态了但父级没接”与“接了又被洗掉”
      // 三种情形的现场完全不同，只回传一个空字符串等于没取证
      var all={}; for(var q=0;q<sessionStorage.length;q++){ var kk=sessionStorage.key(q); if(kk.indexOf('tc.')===0||kk.indexOf('plan.')===0) all[kk]=sessionStorage.getItem(kk); }
      return { tcOpen: !!t.tc(), mxOpen: !!t.mx(), label: label, reqRaw: got, focusRaw: sessionStorage.getItem('plan.tcFocusReqId'), pageRaw: sessionStorage.getItem('tc.page'), keys: all, panelText: panel ? (panel.textContent||'') : '' };
    })(); })()`);
    ok('A4_drillOpensTCPanel', jump.tcOpen === true, JSON.stringify(jump.err ?? jump.tcOpen));
    // msg 里同时带 label/focus/全键快照：下钻失败时分清「没点到 chip」「点到了但父级未接住」「接到了但被面板洗回空」
    // 不要只留一个空字符串让人猜（本轮就靠这个快照才定位到真正环节）
    ok('A4_drillSetsReqFilter', jump.reqRaw === JSON.stringify(reqIdWithCases),
      `chip[${jump.label ?? jump.err}] tc.reqFilter=${jump.reqRaw || '""'} focus=${jump.focusRaw || '""'} keys=${JSON.stringify(jump.keys ?? {}).slice(0, 260)}`);
    // 下钻同时会把分页归零（面板 effect 里 setPage(0)），这是预期行为，显式钉住防止将来改成保留页码却漏改筛选
    ok('A4_drillResetsPage', Number(JSON.parse(jump.pageRaw ?? '-1')) === 0, `下钻后 tc.page=${jump.pageRaw}`);
    ok('A4_filterChipVisible', String(jump.panelText || '').includes('需求：'), '面板应显式化当前筛选需求');

    // 正向“各 3 次”：重复下钻走的是面板的 (id, seq) 去重分支（父级靠 setTcDrillSeq 递增识别新意图）。
    // 每轮先点「清除筛选」把筛选收回去，否则证明不了“第二次点同一个 chip 仍生效”——
    // 若哪天把去重改成只比 id，重复下钻会静默失效，而单次跳转断言依然是绿的
    const again = await c.evalIn(`(function(){ var t=window.__m1; return (async function(){
      var reqId = ${JSON.stringify(reqIdWithCases)};
      var want = JSON.stringify(reqId);
      var rounds = [];
      for (var r = 0; r < 3; r++) {
        var clr = t.ariaPrefix('清除筛选', t.tc());
        if (clr) clr.click();
        for (var x = 0; x < 40; x++) { if ((sessionStorage.getItem('tc.reqFilter') || '') === '""') break; await t.sleep(80); }
        if (!t.mx()) { var mb = t.byAria('需求跟踪矩阵'); if (mb) mb.click(); for (var y = 0; y < 40 && !t.mx(); y++) await t.sleep(100); }
        var tr = document.querySelector('div[aria-label="需求跟踪矩阵面板"] tbody tr[data-req-id="' + reqId + '"]');
        var dc = tr ? Array.prototype.slice.call(tr.querySelectorAll('button')).find(function(b){ return (b.getAttribute('aria-label')||'').indexOf('下钻查看需求')===0; }) : null;
        if (!dc) { rounds.push({ round: r, err: tr ? 'no-chip' : 'no-row' }); break; }
        dc.click();
        var applied = false;
        for (var k = 0; k < 50; k++) { if (sessionStorage.getItem('tc.reqFilter') === want) { applied = true; break; } await t.sleep(80); }
        rounds.push({ round: r, applied: applied });
      }
      return rounds; })(); })()`);
    const againArr = Array.isArray(again) ? again : [];
    ok('A4_repeatDrillThreeRounds', againArr.length === 3 && againArr.every((x) => x.applied === true),
      `清掉筛选后重复下钻 3 轮均重新回填筛选：${JSON.stringify(againArr).slice(0, 180)}`);

    // 反向跳转：§13 A4 原文是“双向跳转各 3 次无误”，只验矩阵→用例不算完成。
    // 关键是不允许矩阵保持展开：已展开时点 chip 只能证明高亮写上了，证明不了“父级真的重新展开了矩阵”
    // （面板未接住时 TestCasePanel 会退化成本地按需求筛选，界面也会“看起来对了”）
    const back = await c.evalIn(`(function(){ var t=window.__m1; return (async function(){
      var reqId = ${JSON.stringify(reqIdWithCases)};
      var rounds = [];
      for (var r = 0; r < 3; r++) {
        if (t.mx()) { var mb = t.byAria('需求跟踪矩阵'); if (mb) mb.click(); for (var x = 0; x < 40 && t.mx(); x++) await t.sleep(100); }
        var chip = t.ariaPrefix('查看需求', t.tc());
        if (!chip) { rounds.push({ round: r, err: 'no-req-chip' }); break; }
        var label = chip.getAttribute('aria-label');
        chip.click();
        var opened = false, lit = false;
        for (var k = 0; k < 60; k++) {
          opened = !!t.mx();
          lit = !!document.querySelector('div[aria-label="需求跟踪矩阵面板"] tbody tr[data-req-id="' + reqId + '"][data-locate="1"]');
          if (opened && lit) break;
          await t.sleep(100);
        }
        rounds.push({ round: r, opened: opened, lit: lit, label: label });
      }
      return rounds; })(); })()`);
    const backArr = Array.isArray(back) ? back : [];
    ok('A4_reverseJumpReopensMatrix', backArr.length === 3 && backArr.every((x) => x.opened === true),
      `3 轮关矩阵后点「关联需求」chip 是否重新展开：${JSON.stringify(backArr).slice(0, 200)}`);
    ok('A4_reverseJumpHighlightsRow', backArr.length === 3 && backArr.every((x) => x.lit === true),
      `3 轮均命中 tr[data-locate="1"] 定位高亮：${JSON.stringify(backArr.map((x) => x.lit)).slice(0, 120)}`);

    rpt.section('A15 删除带用例需求：确认弹窗明示「将一并删除 N 条测试用例」', ['A15']);
    const dlg = await c.evalIn(`(function(){ var t=window.__m1; return (async function(){
      var tr=document.querySelector('div[aria-label="需求跟踪矩阵面板"] tbody tr[data-req-id=${JSON.stringify(reqIdWithCases)}]');
      if(!tr) return {err:'no-row-for-delete'};
      var delBtn=Array.prototype.slice.call(tr.querySelectorAll('button')).find(function(b){return (b.getAttribute('aria-label')||'').indexOf('删除需求')===0;});
      if(!delBtn) return {err:'no-del-btn'};
      delBtn.click();
      for(var i=0;i<40 && !t.dialog();i++) await t.sleep(100);
      var txt=t.dlgText();
      var m=/一并删除\\s*(\\d+)\\s*条测试用例/.exec(txt.replace(/\\s+/g,' '));
      return { shown: !!m, n: m?m[1]:'?', text: txt.slice(0,120) };
    })(); })()`);
    ok('A15_confirmMentionsCaseCount', dlg.shown === true, `弹窗命中条数=${dlg.n} text=${dlg.text ?? dlg.err}`);
    // 取消而不是确认——回归脚本不许真删数据
    await c.evalIn(`(function(){ var d=window.__m1.dialog(); if(!d) return 0; var cancel=Array.prototype.slice.call(d.querySelectorAll('button')).find(function(b){return (b.getAttribute('aria-label')||'').indexOf('取消')===0;}); if(cancel) cancel.click(); else document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1; })()`);

    ok('UI_noConsoleErrors', c.consoleErrors.length === 0, `${c.consoleErrors.length} 条：${c.consoleErrors.slice(0, 2).join(' | ').slice(0, 200)}`);
  } catch (e) {
    // 同 API 段：页内脚本撞错要显形成 FAIL，绝不能让后续断言静默消失、拼出一副「其余全绿」的假象
    rpt.t('ABORT_uiInFlight', false, `在【${rpt.current}】中断：${String(e?.message ?? e).slice(0, 200)}`);
  } finally {
    c.close();
  }

  return { groups: rpt.groups, consoleErrors: c.consoleErrors, skipped: false };
}

/** 供编排器落一张失败现场截图（可选，无 CDP 时返回 null） */
export async function maybeScreenshot(cdp, url, to) {
  if (!(await fetch(`${cdp}/json`).then((r) => r.ok).catch(() => false))) return null;
  const c = await connectCdp(cdp);
  try {
    await c.send('Page.navigate', { url });
    await c.waitLoad();
    const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(to, Buffer.from(data, 'base64'));
    return to;
  } finally {
    c.close();
  }
}
