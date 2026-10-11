// T01995 API 级断言：多 PRD 合并导入后，计划/待办的需求关联必须落在**本来源**的行上，且错位不再静默通过
// 用法：node t01995-import-link-test.mjs [baseUrl]
// 背景：前端旧实现跨来源文件共用一张 old→new 表，后份文档的 REQ-001 覆盖前份同名旧号；
//       服务端 noToId 同样后写覆盖前写——两层都会让前一份的计划整体偏移到后一份的行上，
//       而编号「存在」所以 unlinkedReqNos 完全不报警（实测 mtask四期 前 20 行零关联）。
const BASE = process.argv[2] ?? 'http://127.0.0.1:39923';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    // Connection: close 让 fetch 的连接即用即关——脚本末尾不再因 keep-alive 套接字被强制退出而触发 libuv abort
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

const reqFile = (prefix, n) => Array.from({ length: n }, (_, i) => ({
  reqNo: `REQ-${String(i + 1).padStart(3, '0')}`,
  title: `${prefix} 需求 ${i + 1}`,
  content: '', sourceRef: `${prefix}#${i + 1}`, priority: 'normal',
}));
// 每份文档的 WBS 按「本文档内的本地编号」引用（AI 解析的真实形态）
const planFile = (prefix, n, from = 1) => Array.from({ length: n }, (_, i) => ({
  title: `${prefix} 计划 ${i + 1}`, description: '', durationDays: 1, kind: 'normal',
  reqNos: [`REQ-${String(from + i).padStart(3, '0')}`],
}));

// ============ 场景一：前端按来源分表重编号后的正常合并（A 20 + B 30） ============
const pid = (await api('POST', '/api/projects', { name: `T01995-分表合并-${Date.now() % 100000}` })).json.id;
const mergedReqs = [...reqFile('A', 20), ...reqFile('B', 30).map((x, i) => ({ ...x, reqNo: `REQ-${String(21 + i).padStart(3, '0')}` }))];
const mergedPlans = [...planFile('A', 20), ...planFile('B', 30, 21)];
const r1 = await api('POST', '/api/plans/import-prd', {
  projectId: pid, createTasks: true, requirements: mergedReqs, plans: mergedPlans,
  prdMd: '# T01995\n\n合并导入断言', prdFilename: 't01995-merge.md',
});
check('A-01 合并导入落库 50 需求 / 50 计划', r1.json?.requirements === 50 && r1.json?.plans === 50,
  `reqs=${r1.json?.requirements} plans=${r1.json?.plans} tasks=${r1.json?.tasks}`);
check('A-02 正常合并无歧义编号（ambiguousReqNos 为空）', (r1.json?.ambiguousReqNos ?? []).length === 0,
  `ambiguous=${JSON.stringify(r1.json?.ambiguousReqNos)}`);
check('A-03 正常合并零孤儿行（orphanRequirements 为空）', (r1.json?.orphanRequirements ?? []).length === 0,
  `orphans=${JSON.stringify(r1.json?.orphanRequirements)?.slice(0, 160)}`);

const rows = (await api('GET', `/api/plans/prd-requirements?projectId=${pid}`)).json ?? [];
check('A-04 矩阵 50 行编号唯一（REQ-001…050）', rows.length === 50 && new Set(rows.map((x) => x.req_no)).size === 50,
  `rows=${rows.length} 唯一=${new Set(rows.map((x) => x.req_no)).size}`);
const zeroLinked = rows.filter((x) => (x.linkedPlans ?? []).length === 0);
check('A-05 每行都有关联计划（零关联行 = 0，缺陷不复现）', zeroLinked.length === 0,
  `零关联行=${zeroLinked.map((x) => x.req_no).join(',') || '无'}`);
const zeroTask = rows.filter((x) => (x.linkedTasks ?? []).length === 0);
check('A-06 每行都有关联待办（createTasks 同享分表结果）', zeroTask.length === 0,
  `零待办行=${zeroTask.map((x) => x.req_no).join(',') || '无'}`);
// 归属判定：行的 source_ref 前缀必须与其关联计划标题前缀一致（偏移缺陷的直接表现形式是 A 行配 B 计划）
const mismatch = rows.filter((x) => {
  const own = String(x.source_ref ?? '').split('#')[0];
  return (x.linkedPlans ?? []).some((p) => !String(p.title).startsWith(`${own} `));
});
check('A-07 关联计划的来源与需求行一致（A 行只配 A 计划）', mismatch.length === 0,
  `错配行=${mismatch.slice(0, 3).map((x) => `${x.req_no}←${(x.linkedPlans ?? []).map((p) => p.title).join('/')}`).join(' | ') || '无'}`);
const first20 = rows.slice(0, 20);
check('A-08 前 20 行（前份文档）关联非空且指向自己的 20 条计划', first20.every((x) => (x.linkedPlans ?? []).length === 1 && String(x.linkedPlans[0].title).startsWith('A ')),
  `首行=${first20[0]?.req_no}→${first20[0]?.linkedPlans?.[0]?.title} 第20行=${first20[19]?.req_no}→${first20[19]?.linkedPlans?.[0]?.title}`);

// ============ 场景二：复刻旧前端的错误 payload（B 文档未分表，仍报 REQ-001…030） ============
// 服务端必须把歧义与孤儿点名出来——这是「错位不再静默通过」的兜底可观测面
const pid2 = (await api('POST', '/api/projects', { name: `T01995-跨源撞号-${Date.now() % 100000}` })).json.id;
const badReqs = [...reqFile('A', 20), ...reqFile('B', 30)];
const badPlans = [...planFile('A', 20), ...planFile('B', 30)];
const r2 = await api('POST', '/api/plans/import-prd', { projectId: pid2, requirements: badReqs, plans: badPlans });
const amb = r2.json?.ambiguousReqNos ?? [];
// 歧义 = 同一「PRD 原编号」被本次两行争用：A 的 REQ-001…020 与 B 的前 20 条旧号字面相同（跨来源真撞号）。
// 注意口径：原编号撞上别行**顺延后的新号**不算歧义（那是每次增量导入的正常产物，误报会让提示失去意义）
check('B-01 跨来源同旧号被识别为歧义（REQ-001…020 一号两行，共 20 条）',
  amb.length === 20 && amb.includes('REQ-001') && amb.includes('REQ-020') && !amb.includes('REQ-021'),
  `ambiguous=${amb.length} 样例=${amb.slice(0, 3).join(',')}…${amb.at(-1)}`);
const orph = r2.json?.orphanRequirements ?? [];
check('B-02 被抢占关联的需求行回传为孤儿（不再静默零关联）', orph.length > 0 && orph.every((x) => x.reqNo && x.title),
  `orphans=${orph.length} 样例=${orph.slice(0, 2).map((x) => `${x.reqNo}/${x.title}`).join(' , ')}`);
check('B-03 孤儿行是前一份文档（与 mtask四期「前 20 行零关联」症状同形）', orph.every((x) => x.title.startsWith('A ')),
  `非A孤儿=${orph.filter((x) => !x.title.startsWith('A ')).map((x) => x.title).join(',') || '无'}`);
const rows2 = (await api('GET', `/api/plans/prd-requirements?projectId=${pid2}`)).json ?? [];
const zero2 = rows2.filter((x) => (x.linkedPlans ?? []).length === 0);
check('B-04 旧 payload 形态确实产生零关联行（证明可观测面必要）', zero2.length > 0,
  `零关联行=${zero2.length}/${rows2.length} 编号=${zero2.slice(0, 5).map((x) => x.req_no).join(',')}`);
check('B-05 回传孤儿行数 = 实际零关联行数（口径一致，不多报不漏报）', orph.length === zero2.length,
  `orphanRequirements=${orph.length} 实际零关联=${zero2.length}`);

// ============ 场景三：单来源导入行为不变（回归面） ============
const pid3 = (await api('POST', '/api/projects', { name: `T01995-单来源回归-${Date.now() % 100000}` })).json.id;
const r3 = await api('POST', '/api/plans/import-prd', { projectId: pid3, requirements: reqFile('C', 5), plans: planFile('C', 5) });
check('C-01 单来源导入无歧义无孤儿', (r3.json?.ambiguousReqNos ?? []).length === 0 && (r3.json?.orphanRequirements ?? []).length === 0,
  `reqs=${r3.json?.requirements} plans=${r3.json?.plans}`);
const rows3 = (await api('GET', `/api/plans/prd-requirements?projectId=${pid3}`)).json ?? [];
check('C-02 单来源编号仍从 REQ-001 起（未被改动）', rows3.map((x) => x.req_no).join(',') === 'REQ-001,REQ-002,REQ-003,REQ-004,REQ-005',
  `reqNos=${rows3.map((x) => x.req_no).join(',')}`);

console.log(`\n== T01995 合并导入关联：pass=${pass} fail=${fail} ==`);
console.log(`PROJECTS ${pid} ${pid2} ${pid3}`);
// 用 exitCode 而非 process.exit：后者在 undici 套接字句字仍处 closing 态时强退，
// 会在 Windows 上触发 libuv `UV_HANDLE_CLOSING` abort 并把退出码覆盖成非 0（回归编排会误判）
process.exitCode = fail ? 1 : 0;
