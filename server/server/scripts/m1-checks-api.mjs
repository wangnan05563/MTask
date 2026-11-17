/**
 * T01488：M1 验收回归——服务端断言集（PRD-测试用例管理 §13 验收表 A2/A3/A4/A5/A6 + §5.3 CASCADE 自保 + §11 分页）。
 *
 * 由 `m1-regression.mjs` 编排调用，也可单独 import 复用；本模块只认一个 HTTP 基址，
 * 不关心被测实例怎么起来的（隔离实例 / 已在跑的实例走同一套断言），因此**绝不在脚本里删库或改配置**。
 *
 * 为什么交互级（`m1-checks-ui.mjs`）之外还要这一份：
 *  A2~A6 的判定项里有大量「服务端契约」——自动编号、枚举收窄、批量语义、CASCADE 行数。
 *  这些在 UI 上表现为「看起来正常」，只有直接打接口才能区分「前端刚好没显示」与「数据真的对」。
 *
 * CASCADE 自保断言（§5.3 明确要求）：`connection.ts` 的 `foreign_keys = ON` 一旦被关掉，
 * 或 `deleteRequirement` 被改成逻辑删除，级联会**静默失效**——所以这里断言的是
 * 「删需求后 `test_cases` 与 `case_steps` 两张表的行数都少了」，而不是只看接口返回列表少了几条。
 * 表行数取自 `GET /api/dbadmin/tables`（其行数来自逐表 `SELECT COUNT(*)`，是真库口径）。
 *
 * 计数断言一律「交叉核对」而非写死数字：coverage 的 caseCount 对 `list?reqId=` 的 total、
 * stats 的 total/linked/orphan 对全量列表的实际分布。写死魔法数字只会让「改了造数据顺序」
 * 变成「改了预期值」，那是在迁就脚本，不是在验证产品。
 */

import http from 'node:http';

const P = '/api';

/** 断言收集器：按验收条目分组，允许附带 SKIP（前置缺失时如实标缺，不算通过） */
export function mkReport() {
  const groups = [];
  let cur = { title: '未分组', ids: [], list: [] };
  return {
    section(title, ids) {
      cur = { title, ids: ids ?? [], list: [] };
      groups.push(cur);
      return cur;
    },
    t(k, cond, msg = '') {
      cur.list.push({ k, pass: !!cond, skip: false, msg: String(msg).slice(0, 240) });
    },
    skip(k, why) {
      cur.list.push({ k, pass: false, skip: true, msg: String(why).slice(0, 240) });
    },
    /** 当前所在节名：脚本中途报错时，报告要能说清「断在哪一节、后面哪些没跑」 */
    get current() {
      return cur.title;
    },
    groups,
  };
}

/** 极简 HTTP 客户端：`raw` 返回状态码与解析体（负向断言要用），`call` 只在 2xx 时返回体
 *
 * 为何不用全局 fetch：本脚本会先 `await import('exceljs')`（首次加载要几秒），
 * 那段空闲足以让服务端的 keep-alive 默认 5s 超时把连接关掉；下一个请求复用这条死 socket
 * 就 ECONNRESET，表现为一句没头没尾的 `fetch failed`。回归脚本“跑三次红一次”比稳定 FAIL 更坑——
 * 它会让人开始怀疑全部绿色结论。所以这里用 node:http 并 `agent:false`（每次新建连接、不池化），
 * 从根上消除这一类假失败。
 */
function httpOnce(method, urlStr, bodyBuf) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:') { reject(new Error(`本客户端只面向隔离实例的 http:// 基址，收到 ${u.protocol}`)); return; }
    const headers = { 'Content-Type': 'application/json' };
    // 显式 Content-Length：不写则 node 走 chunked，与之前 fetch 行为不一致，给 body-parser 众多一条可变因素
    if (bodyBuf) headers['Content-Length'] = bodyBuf.length;
    const req = http.request({
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      agent: false, headers, timeout: 90000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        buf: Buffer.concat(chunks),
        ct: res.headers['content-type'] ?? '',
        cd: res.headers['content-disposition'] ?? '',
      }));
    });
    req.on('timeout', () => req.destroy(new Error('超时 90s')));
    // 报错必须带上方法/路径/错误码：“fetch failed” 这种光秃秃一句话在本报告里等于没取证
    req.on('error', (e) => reject(new Error(`${method} ${u.pathname}${u.search} 网络失败：${e.code ?? ''} ${e.message}`.slice(0, 200))));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// 只对幂等方法重试：读请求在连接层挂掉时重试不会造数据；
// POST/PATCH 不重试（无法确定服务端是否已执行），宁可让断言响也不留双写风险
async function httpWithRetry(method, urlStr, bodyBuf) {
  const safe = method === 'GET' || method === 'DELETE' || method === 'HEAD';
  const max = safe ? 3 : 1;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    try { return await httpOnce(method, urlStr, bodyBuf); }
    catch (e) { lastErr = e; if (!safe || i === max - 1) break; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw lastErr;
}

export function mkHttp(base) {
  async function raw(method, path, body) {
    const r = await httpWithRetry(method, `${base}${P}${path}`, body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8'));
    const text = r.buf.toString('utf8');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: r.status, data, ct: r.ct, cd: r.cd };
  }
  async function call(method, path, body) {
    const r = await raw(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    return r.data;
  }
  /** 二进制下载（导出断言用）：状态码 + Buffer + 两个关键响应头 */
  async function binary(method, path, body) {
    return httpWithRetry(method, `${base}${P}${path}`, body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8'));
  }
  return { raw, call, binary };
}

/** 全表行数（真库口径，CASCADE 与「不留残渣」两条断言的地基） */
async function tableCounts(call) {
  const tables = await call('GET', '/dbadmin/tables');
  const map = {};
  for (const t of tables) map[t.name] = t.rows;
  return map;
}

const gist = (v) => JSON.stringify(v ?? null).slice(0, 140);

export async function runApiChecks({ base, prefix = 'M1' }) {
  const { raw, call, binary } = mkHttp(base);
  const R = mkReport();
  const uniq = `${prefix}-${Date.now()}`;
  // 建任何东西之前先取库基线，末尾用它自证「净零残渣」
  const t0 = await tableCounts(call);
  let otherProjId = null;

  // ---------- 造数据：2 条需求带用例 + 1 条 0 用例需求 + 1 条孤儿用例 ----------
  const proj = await call('POST', '/projects', { name: `${uniq} 项目` });
  const mkReq = (title) => call('POST', '/plans/prd-requirements', { projectId: proj.id, title });
  const rA = await mkReq('需求A（带用例）');
  const rB = await mkReq('需求B（带用例）');
  const rC = await mkReq('需求C（零用例）');
  const mkCase = (body) => call('POST', '/plans/test-cases', { projectId: proj.id, ...body });
  const orphan = await mkCase({ title: '孤儿用例（无需求，须幸存到最后）' });

  try {
    try {
    /** ---------- A2 增删改查 ---------- */
    R.section('A2 用例增删改查', ['A2']);
    // 默认值不写魔法字面量，直接拿服务端自己下发的 `meta.defaults`（§5.4 单源）：
    // 否则将来改一个默认优先级，脚本就会把「产品按新默认走」误报成回归。
    const meta = await call('GET', `/plans/test-cases/meta?projectId=${proj.id}`);
    const mdef = meta?.defaults ?? {};
    R.t('A2_metaCarriesDefaults', Boolean(mdef.priority && mdef.type && mdef.status && mdef.lastResult),
      `meta.defaults=${gist(mdef)}`);
    const c1 = await mkCase({
      reqId: rA.id, title: '登录成功', module: '认证', priority: 'P1', type: 'functional', method: 'manual',
      preconditions: '已注册', expected: '进入首页', testData: 'u1/p1', postconditions: '登出',
      steps: [{ action: '打开登录页', expected: '显示输入框' }, { action: '提交', expected: '进入首页' }],
    });
    const c2 = await mkCase({ reqId: rA.id, title: '密码错误被拒' });
    const c3 = await mkCase({ reqId: rB.id, title: '库存回补', priority: 'P2' });
    R.t('A2_createWithTitleOnly', !!c2.id && /^TC-\d{3}$/.test(c2.case_no ?? ''), `自动编号=${c2.case_no}`);
    // 返回体是 DB 行口径（snake_case），入参才是 camelCase——这里刻意按 snake 读，防「前端字段名碰巧对上了」
    R.t('A2_defaults', c2.priority === mdef.priority && c2.type === mdef.type && c2.status === mdef.status && c2.last_result === mdef.lastResult,
      `实回=${gist([c2.priority, c2.type, c2.status, c2.last_result])} meta.defaults=${gist([mdef.priority, mdef.type, mdef.status, mdef.lastResult])}`);
    const got = await call('GET', `/plans/test-cases/${c1.id}`);
    R.t('A2_fieldsRoundTrip', got.preconditions === '已注册' && got.test_data === 'u1/p1'
      && got.postconditions === '登出' && got.expected === '进入首页' && got.req_id === rA.id,
      gist([got.preconditions, got.test_data, got.postconditions, got.req_id === rA.id]));
    const patched = await call('PATCH', `/plans/test-cases/${c1.id}`, { title: '登录成功(改)', caseNo: 'TC-900', module: '登录' });
    R.t('A2_inlineEditPersists', patched.title === '登录成功(改)' && patched.case_no === 'TC-900' && patched.module === '登录',
      gist([patched.title, patched.case_no, patched.module]));
    const sel = await call('PATCH', `/plans/test-cases/${c2.id}`, { priority: 'P0', status: 'approved', lastResult: 'pass', method: 'automation' });
    R.t('A2_selectEdits', sel.priority === 'P0' && sel.status === 'approved' && sel.last_result === 'pass' && sel.method === 'automation',
      gist([sel.priority, sel.status, sel.last_result, sel.method]));
    const dupNo = await raw('POST', '/plans/test-cases', { projectId: proj.id, title: '重号用例', caseNo: 'TC-900' });
    R.t('A2_caseNoUniqueRejected', dupNo.status === 400, `${dupNo.status} ${gist(dupNo.data)}`);
    // 枚举口径（§5.4 + 服务层注释）：写入脏值回落默认值（AI 生成/批量导入单字段脏不该让整条写失败），
    // 筛选非法值必须 400（否则「筛 P9」静默变成「不筛」，返回更多行比一次 400 更难被发现）。
    const dirtyEnum = await mkCase({ reqId: rA.id, title: '脏枚举用例', priority: 'P9', type: 'nonsense' });
    R.t('A2_writeDirtyEnumFallsBack', dirtyEnum.priority === mdef.priority && dirtyEnum.type === mdef.type,
      `priority=${dirtyEnum.priority} type=${dirtyEnum.type}（应回落 defaults=${mdef.priority}/${mdef.type}）`);
    const badFilter = await raw('GET', `/plans/test-cases?projectId=${proj.id}&priority=P9`);
    R.t('A2_filterBadEnumRejected', badFilter.status === 400 && /非法/.test(gist(badFilter.data)), `${badFilter.status} ${gist(badFilter.data)}`);
    await raw('DELETE', `/plans/test-cases/${dirtyEnum.id}`);
    const ghost = await raw('GET', '/plans/test-cases/no-such-case-id');
    R.t('A2_getMissingIsError', (ghost.status === 404 || /不存在/.test(gist(ghost.data))) && ghost.status < 500, `${ghost.status} ${gist(ghost.data)}`);
    const del = await raw('DELETE', `/plans/test-cases/${c3.id}`);
    R.t('A2_deleteSingle', del.status === 200, `${del.status}`);
    const gone = await raw('GET', `/plans/test-cases/${c3.id}`);
    R.t('A2_deletedReallyGone', gone.status !== 200 && /不存在/.test(gist(gone.data)), `${gone.status} ${gist(gone.data)}`);

    /** ---------- A3 步骤 0~N 与增删排序 ---------- */
    R.section('A3 步骤可编辑 0~N + 增删排序 + 刷新仍在', ['A3']);
    const cNoStep = await mkCase({ reqId: rA.id, title: '零步骤用例' });
    R.t('A3_zeroStepsAllowed', Array.isArray(cNoStep.steps) && cNoStep.steps.length === 0, `steps=${cNoStep.steps?.length}`);
    const s1 = await call('GET', `/plans/test-cases/${c1.id}`);
    R.t('A3_stepNumbers', s1.steps.map((x) => x.step_no).join(',') === '1,2', s1.steps.map((x) => x.step_no).join(','));
    R.t('A3_stepFields', s1.steps.every((x) => x.action && x.expected), gist(s1.steps[0]));
    const reordered = await call('PATCH', `/plans/test-cases/${c1.id}`, {
      steps: [{ action: '第三步', expected: 'E3' }, { action: '第一步', expected: 'E1' }],
    });
    R.t('A3_replaceAndReorder', reordered.steps.map((x) => x.action).join('|') === '第三步|第一步'
      && reordered.steps.map((x) => x.step_no).join(',') === '1,2',
      reordered.steps.map((x) => `${x.step_no}.${x.action}`).join('|'));
    const afterReload = await call('GET', `/plans/test-cases/${c1.id}`);
    R.t('A3_persistAcrossReload', afterReload.steps.length === 2 && afterReload.steps[1].action === '第一步', `steps=${afterReload.steps.length}`);
    const cleared = await call('PATCH', `/plans/test-cases/${c1.id}`, { steps: [] });
    R.t('A3_deleteAllSteps', cleared.steps.length === 0, `steps=${cleared.steps.length}`);

    /** ---------- A4 覆盖度与「用例 N」口径（矩阵 chip 与 A15 连带条数的数据源） ---------- */
    R.section('A4 覆盖度计数（矩阵 chip 与删除连带条数的数据源）', ['A4']);
    const cov = await call('GET', `/plans/test-cases/coverage?projectId=${proj.id}`);
    const byId = Object.fromEntries(cov.byReq.map((x) => [x.reqId, x.caseCount]));
    // §7.2「仅显示未覆盖需求」依赖 byReq 保留 caseCount=0 的行，漏掉 0 用例需求会让该筛选永远算不出结果
    R.t('A4_byReqIncludesZeroCaseReq', cov.byReq.some((x) => x.reqId === rC.id && x.caseCount === 0), `C=${byId[rC.id]}`);
    const reqIds = cov.byReq.map((x) => x.reqId);
    const listCounts = {};
    for (const rid of reqIds) {
      listCounts[rid] = (await call('GET', `/plans/test-cases?projectId=${proj.id}&reqId=${rid}&limit=0`)).total;
    }
    R.t('A4_coverageCrossCheckList', cov.byReq.every((x) => x.caseCount === listCounts[x.reqId]),
      `coverage=${reqIds.map((r) => byId[r]).join(',')} list=${reqIds.map((r) => listCounts[r]).join(',')}`);
    R.t('A4_totalsRelate', cov.total === reqIds.length && cov.covered === cov.byReq.filter((x) => x.caseCount > 0).length
      && cov.uncovered === cov.total - cov.covered && cov.rate === Math.round((cov.covered / cov.total) * 1000) / 10,
      gist({ total: cov.total, covered: cov.covered, uncovered: cov.uncovered, rate: cov.rate }));
    // 孤儿用例是「没有需求」的用例，绝不能被当成一条需求计入覆盖度
    R.t('A4_orphansNotCountedAsReqs', !cov.byReq.some((x) => x.reqId === null || x.reqId === orphan.id),
      `byReq 中无孤儿行（byReq 条数=${cov.byReq.length}）`);
    const st = await call('GET', `/plans/test-cases/stats?projectId=${proj.id}`);
    const allNow = await call('GET', `/plans/test-cases?projectId=${proj.id}&limit=0`);
    const realOrphan = allNow.items.filter((x) => !x.req_id).length;
    R.t('A4_statsCrossCheckList', st.total === allNow.total && st.orphan === realOrphan && st.linked === st.total - st.orphan,
      `stats=${gist(st)} listTotal=${allNow.total} 实际孤儿=${realOrphan}`);
    R.t('A4_orphanScenarioExercised', st.orphan === 1, `orphan=${st.orphan}（造数据安排了 1 条孤儿）`);

    /** ---------- A5 批量动作 ---------- */
    R.section('A5 批量改/复制/删除（每项 ≥2 条样本）', ['A5']);
    const b1 = await mkCase({ reqId: rA.id, title: '批量样本一' });
    const b2 = await mkCase({ reqId: rA.id, title: '批量样本二' });
    const ids = [b1.id, b2.id];
    // 路由契约：批量体是 `{ ids, patch }`（不是 fields），复制端点是 `/duplicate`（不是 `/batch-duplicate`）
    const bp = await call('PATCH', '/plans/test-cases/batch', { ids, patch: { priority: 'P0', type: 'api', status: 'review' } });
    const gb1 = await call('GET', `/plans/test-cases/${b1.id}`);
    const gb2 = await call('GET', `/plans/test-cases/${b2.id}`);
    R.t('A5_batchThreeFields', bp.updated === 2 && gb1.priority === 'P0' && gb1.type === 'api' && gb2.status === 'review', `updated=${bp.updated}`);
    const bl = await call('PATCH', '/plans/test-cases/batch', { ids, patch: { reqId: rB.id } });
    R.t('A5_batchLinkReq', bl.updated === 2 && (await call('GET', `/plans/test-cases/${b1.id}`)).req_id === rB.id, `updated=${bl.updated}`);
    const bu = await call('PATCH', '/plans/test-cases/batch', { ids, patch: { reqId: null } });
    R.t('A5_batchUnlink', bu.updated === 2 && (await call('GET', `/plans/test-cases/${b1.id}`)).req_id === null, `req_id=${(await call('GET', `/plans/test-cases/${b1.id}`)).req_id}`);
    const bm = await call('PATCH', '/plans/test-cases/batch', { ids, patch: { module: '批量模块' } });
    R.t('A5_batchModule', bm.updated === 2 && (await call('GET', `/plans/test-cases/${b2.id}`)).module === '批量模块', `updated=${bm.updated}`);
    const dupIds = await call('POST', '/plans/test-cases/duplicate', { ids });
    const dupFirst = await call('GET', `/plans/test-cases/${dupIds.ids[0]}`);
    R.t('A5_batchDuplicate', dupIds.ids.length === 2 && dupFirst.title === '批量样本一' && /^TC-\d{3}$/.test(dupFirst.case_no), `no=${dupFirst.case_no}`);
    // 副本必须是干净资产而非执行结论：status=draft / last_result=untested，幂等去重键不随复制传播
    R.t('A5_duplicateIsCleanAsset', dupFirst.status === 'draft' && dupFirst.last_result === 'untested' && !dupFirst.source_key,
      gist([dupFirst.status, dupFirst.last_result, dupFirst.source_key]));
    const allNos = (await call('GET', `/plans/test-cases?projectId=${proj.id}&limit=0`)).items.map((x) => x.case_no);
    R.t('A5_duplicateNoSameNo', allNos.length === new Set(allNos).size, `编号 ${allNos.length} 条 / 去重后 ${new Set(allNos).size}`);
    const bd = await call('DELETE', '/plans/test-cases/batch', { ids: [...ids, ...dupIds.ids] });
    R.t('A5_batchDelete', bd.deleted === 4, `deleted=${bd.deleted}`);
    otherProjId = (await call('POST', '/projects', { name: `${uniq} 另一项目` })).id;
    const oc = await call('POST', '/plans/test-cases', { projectId: otherProjId, title: '跨项目用例' });
    const mix = await raw('PATCH', '/plans/test-cases/batch', { ids: [c1.id, oc.id], patch: { priority: 'P3' } });
    R.t('A5_crossProjectRejected', mix.status === 400 && /同一项目/.test(gist(mix.data)), `${mix.status} ${gist(mix.data)}`);
    const ghostBatch = await raw('DELETE', '/plans/test-cases/batch', { ids: [c1.id, 'ghost-id'] });
    R.t('A5_ghostIdRejected', ghostBatch.status === 400 && /不存在/.test(gist(ghostBatch.data)), `${ghostBatch.status} ${gist(ghostBatch.data)}`);
    R.skip('A5_batchExportUI', '批量导出的确认弹窗与真实落盘文件属交互判定，由 UI 段 A13/A6 与 t01487 探针覆盖');

    /** ---------- A6 三格式导出 + 样式同源 ---------- */
    R.section('A6 三格式导出成功 / Excel 含覆盖率子表 / 样式与矩阵导出同源', ['A6']);
    const files = {};
    for (const fmt of ['xlsx', 'docx', 'md']) {
      files[fmt] = await binary('POST', '/plans/test-cases/export', { projectId: proj.id, format: fmt });
    }
    R.t('A6_threeFormats200', ['xlsx', 'docx', 'md'].every((f) => files[f].status === 200 && files[f].buf.length > 0),
      ['xlsx', 'docx', 'md'].map((f) => `${f}=${files[f].status}/${files[f].buf.length}B`).join(' '));
    R.t('A6_mimeDistinct', /spreadsheetml\.sheet/.test(files.xlsx.ct) && /wordprocessingml/.test(files.docx.ct) && /text\/markdown/.test(files.md.ct),
      [files.xlsx.ct, files.docx.ct, files.md.ct].join(' | '));
    R.t('A6_rfc5987ChineseName', /filename\*=UTF-8''%E6%B5%8B%E8%AF%95%E7%94%A8%E4%BE%8B-/.test(files.md.cd),
      decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(files.md.cd)?.[1] ?? 'none')));
    R.t('A6_zipMagicXlsxDocx', files.xlsx.buf.readUInt32LE(0) === 0x04034b50 && files.docx.buf.slice(0, 2).toString('latin1') === 'PK',
      `xlsx=${files.xlsx.buf.readUInt32LE(0).toString(16)} docx=${files.docx.buf.slice(0, 2).toString('latin1')}`);
    const mdText = files.md.buf.toString('utf8');
    R.t('A6_mdShape', /^# 测试用例 - /m.test(mdText) && /^## /m.test(mdText) && /^### /m.test(mdText) && /## 需求覆盖率汇总/.test(mdText),
      `H2=${(mdText.match(/^## /gm) ?? []).length} H3=${(mdText.match(/^### /gm) ?? []).length}`);
    const badFmt = await raw('POST', '/plans/test-cases/export', { projectId: proj.id, format: 'pdf' });
    R.t('A6_badFormatRejected', badFmt.status === 400 && /format/.test(gist(badFmt.data)), `${badFmt.status} ${gist(badFmt.data)}`);
    // xlsx 回读：必须真的有两个 sheet，且第二个是覆盖率子表；表头底色与矩阵导出同为规范 A 的 HEAD_FILL
    // exceljs / pizzip 都是 CJS 包：`await import()` 拿到的是命名空间，真身在 `.default`（直接用命名空间会撞「not a constructor」）
    const ExcelJSMod = await import('exceljs').catch(() => null);
    const ExcelJS = ExcelJSMod?.default?.Workbook ? ExcelJSMod.default : ExcelJSMod;
    const PizZipMod = await import('pizzip').catch(() => null);
    // pizzip 导出的是个类（实例方法叫 file()/load()），静态上并没有 unpack——用 typeof 判可用才不会误 SKIP
    const PizZip = PizZipMod?.default ?? PizZipMod;
    const covAtExport = await call('GET', `/plans/test-cases/coverage?projectId=${proj.id}`);
    if (!ExcelJS?.Workbook) {
      R.skip('A6_xlsxSheetAndStyle', 'exceljs 不可用（依赖缺失），无法回读工作簿');
    } else {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(files.xlsx.buf);
      const sheetNames = wb.worksheets.map((w) => w.name);
      R.t('A6_xlsxHasCoverageSheet', sheetNames.includes('测试用例') && sheetNames.includes('需求覆盖率'), sheetNames.join(','));
      const ws = wb.getWorksheet('测试用例');
      const headFill = ws.getRow(2).getCell(1).fill?.fgColor?.argb;
      R.t('A6_frozenAndFilter', ws.views[0]?.ySplit === 2 && String(ws.autoFilter?.ref ?? ws.autoFilter ?? '') !== 'undefined',
        `ySplit=${ws.views[0]?.ySplit} autoFilter=${gist(ws.autoFilter?.ref ?? ws.autoFilter)}`);
      const ws2 = wb.getWorksheet('需求覆盖率');
      R.t('A6_coverageSheetMatchesApi', ws2.rowCount - 1 === covAtExport.byReq.length && /覆盖/.test(String(ws2.getCell('D3').value ?? '')),
        `子表数据行=${ws2.rowCount - 1} API byReq=${covAtExport.byReq.length} D3=${ws2.getCell('D3').value}`);
      // 同源证据：矩阵导出的表头底色与用例导出完全一致（两处都只可能来自 util/exportStyle 的 HEAD_FILL）
      const mfile = await binary('GET', `/plans/prd-requirements/export?projectId=${proj.id}`);
      if (mfile.status !== 200) {
        R.skip('A6_styleSameAsMatrix', `矩阵导出返回 ${mfile.status}，无法比对底色`);
      } else {
        const mwb = new ExcelJS.Workbook();
        await mwb.xlsx.load(mfile.buf);
        const mHead = mwb.worksheets[0].getRow(2).getCell(1).fill?.fgColor?.argb;
        R.t('A6_styleSameAsMatrix', Boolean(headFill) && headFill === mHead && String(headFill).toUpperCase().endsWith('EAF2FF'),
          `cases=${headFill} matrix=${mHead}`);
      }
    }
    if (typeof PizZip !== 'function') {
      R.skip('A6_docxHeadShading', `pizzip 不可用（拿到的是 ${typeof PizZip}），无法解包 document.xml 校验表头底色`);
    } else {
      const xml = new PizZip(new Uint8Array(files.docx.buf)).file('word/document.xml').asText();
      R.t('A6_docxHeadShading', (xml.match(/w:fill="EAF2FF"/g) ?? []).length >= 1, `EAF2FF 命中 ${(xml.match(/w:fill="EAF2FF"/g) ?? []).length} 处`);
    }

    /** ---------- §5.3 CASCADE 自保：删需求连带用例与步骤（真库行数口径） ---------- */
    R.section('§5.3 CASCADE 自保：删需求连带用例+步骤（真库行数）', ['A15', 'CASCADE']);
    const delReq = await mkReq('待删需求（连带验证）');
    const d1 = await mkCase({ reqId: delReq.id, title: '连带用例一', steps: [{ action: 'a1', expected: 'e1' }, { action: 'a2', expected: 'e2' }] });
    const d2 = await mkCase({ reqId: delReq.id, title: '连带用例二', steps: [{ action: 'a3', expected: 'e3' }] });
    const keeper = await mkCase({ reqId: rA.id, title: '他需求用例（须幸存）', steps: [{ action: 'k1', expected: 'ke1' }] });
    const before = await tableCounts(call);
    R.t('CASCADE_baselineHasRows', before.test_cases > 0 && before.case_steps >= 3, gist([before.test_cases, before.case_steps]));
    // A15 的弹窗文案「将一并删除 N 条测试用例」就取这个 N：接口口径先立住，UI 才有得显示
    const delPre = await call('GET', `/plans/test-cases?projectId=${proj.id}&reqId=${delReq.id}&limit=0`);
    R.t('A15_deletableCountKnown', delPre.total === 2, `待删需求下用例=${delPre.total}（弹窗应明示 2 条）`);
    await call('DELETE', `/plans/prd-requirements/${delReq.id}`);
    const after = await tableCounts(call);
    R.t('CASCADE_casesRowRemoved', after.test_cases === before.test_cases - 2,
      `test_cases ${before.test_cases} -> ${after.test_cases}（应 -2）`);
    R.t('CASCADE_stepsRowRemoved', after.case_steps === before.case_steps - 3,
      `case_steps ${before.case_steps} -> ${after.case_steps}（应 -3：两步 + 一步）`);
    const goneD1 = await raw('GET', `/plans/test-cases/${d1.id}`);
    const goneD2 = await raw('GET', `/plans/test-cases/${d2.id}`);
    R.t('CASCADE_casesApiGone', goneD1.status !== 200 && goneD2.status !== 200, `${goneD1.status}/${goneD2.status}`);
    const stillA = await raw('GET', `/plans/test-cases/${keeper.id}`);
    const stillO = await raw('GET', `/plans/test-cases/${orphan.id}`);
    R.t('CASCADE_siblingsSurvive', stillA.status === 200 && stillO.status === 200, `keeper=${stillA.status} orphan=${stillO.status}`);
    // 只多删和少删都要被抓出来：幸存用例自己的步骤必须一条不少
    const keeperNow = await call('GET', `/plans/test-cases/${keeper.id}`);
    R.t('CASCADE_survivorStepsIntact', keeperNow.steps.length === 1 && keeperNow.steps[0].action === 'k1', `幸存用例步骤=${keeperNow.steps.length}`);
    R.skip('CASCADE_pragmaLiteral', '无只读 SQL 端点可读 `PRAGMA foreign_keys`；上面两条行数断言即行为级自保——关掉 pragma 或改逻辑删除会直接 FAIL');

    /** ---------- §11 导出全量 / 分页上限 / 禁 N+1（列表侧） ---------- */
    R.section('§11 导出全量 / 分页 / 禁 N+1（列表侧）', ['PERF']);
    const many = [];
    for (let i = 0; i < 3; i++) many.push(await mkCase({ reqId: rA.id, title: `填充 ${i}` }));
    const listPage = await call('GET', `/plans/test-cases?projectId=${proj.id}&limit=2`);
    R.t('PERF_listRespectsPaging', listPage.items.length === 2 && listPage.total > 2, `items=${listPage.items.length} total=${listPage.total}`);
    const full = await call('GET', `/plans/test-cases?projectId=${proj.id}&limit=0`);
    const mdAll = await binary('POST', '/plans/test-cases/export', { projectId: proj.id, format: 'md' });
    const allText = mdAll.buf.toString('utf8');
    R.t('PERF_exportIgnoresPaging', (allText.match(/^### /gm) ?? []).length === full.total,
      `md 用例段=${(allText.match(/^### /gm) ?? []).length} 库里 total=${full.total}`);
    const big = await call('GET', `/plans/test-cases?projectId=${proj.id}&limit=999999`);
    R.t('PERF_largeLimitClampsNotErrors', big.items.length === full.total && big.total === full.total,
      `items=${big.items.length}（服务层 Math.min(raw, MAX_PAGE_SIZE=5000)；样本量小于 5000 故未触发截断，仅证不报错）`);
    // §11「禁 N+1」的可验证部分：列表响应必须自带 steps 数组，前端才不必逐条回查。
    // 至于服务端内部有没有偷偷循环查库，HTTP 层看不出来（无查询计数端点），故只断言契约形态。
    const known = full.items.find((x) => x.id === keeper.id);
    R.t('PERF_listCarriesStepsInline', full.items.every((x) => Array.isArray(x.steps))
      && known?.steps.length === 1 && known.steps[0].action === 'k1',
      `items=${full.items.length} 全部自带 steps=${full.items.every((x) => Array.isArray(x.steps))} keeper 步骤=${known?.steps?.length}`);
    R.skip('PERF_noNplusOneQueryCount', '服务端未暴露查询计数，无法从 HTTP 证明「一次取全」；`stepsByCase` 的单条 IN 查询是源码级保证，此处只验响应契约');
    for (const m of many) await raw('DELETE', `/plans/test-cases/${m.id}`);
    } catch (e) {
      // 断言集自身撞错（非产品 FAIL，而是「没跑完」）：必须显形成一个 FAIL + 一个说明节，
      // 绝不能让后面的节静默消失——那样报告会长得像「其余全绿」，是最坏的假信号。
      R.t('ABORT_inFlight', false, `在【${R.current}】中断：${String(e?.message ?? e).slice(0, 200)}`);
      R.section('脚本中断（本节后继断言未执行）', ['ABORT']);
      R.t('ABORT_restNotRun', false, '上方节被中断跳过，其断言未执行——退出码必为非 0，不得当作验收通过');
    }
  } finally {
    /** ---------- 清理：只删本脚本自己建的项目，末尾用基线行数自证净零 ---------- */
    await raw('DELETE', `/projects/${proj.id}`);
    if (otherProjId) await raw('DELETE', `/projects/${otherProjId}`);
    R.section('清理与自证（回归脚本不留数据）', ['CLEAN']);
    const leftProj = await raw('GET', `/plans/test-cases?projectId=${proj.id}&limit=0`);
    R.t('CLEAN_projectRemoved', leftProj.status >= 400 || (leftProj.data?.total ?? 0) === 0,
      `残留=${gist(leftProj.data) ?? leftProj.status}`);
    // 净零断言：与开跑前的库基线比行数——这是真比较，不是自己和自己比
    const tEnd = await tableCounts(call);
    R.t('CLEAN_netZeroCases', tEnd.test_cases === t0.test_cases, `test_cases 基线=${t0.test_cases} 收尾=${tEnd.test_cases}`);
    R.t('CLEAN_netZeroSteps', tEnd.case_steps === t0.case_steps, `case_steps 基线=${t0.case_steps} 收尾=${tEnd.case_steps}`);
    R.t('CLEAN_netZeroReqs', tEnd.prd_requirements === t0.prd_requirements, `prd_requirements 基线=${t0.prd_requirements} 收尾=${tEnd.prd_requirements}`);
  }

  return R.groups;
}
