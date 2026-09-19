// T00754/T00764 断言复核（API 级，隔离实例）：节假日 kind 语义 → 工作日排期
// 用法：node t00754-holiday-workday-api-test.mjs [baseUrl]
// 场景（2026-09 真实日历）：
//   A. 放假日：09-21(周一) 标记 holiday → start 09-18(周五) dur=3 的任务 end 应为 09-22（跳过周一）
//   B. 加班日：09-19(周六) 标记 overtime → start 09-18(周五) dur=2 的任务 end 应为 09-19（周六计入）
const BASE = process.argv[2] ?? 'http://127.0.0.1:39901';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

// ---- 准备：项目 + 日历 ----
const proj = (await api('POST', '/api/projects', { name: `T00754-节假日复核-${Date.now() % 100000}` })).json;
const projectId = proj.id ?? proj.json?.id ?? proj.id;
const pid = proj.id;
check('P-01 创建项目', !!pid, `id=${pid}`);

await api('POST', '/api/plans/holidays', { date: '2026-09-21', name: '中秋节调休', kind: 'holiday' });
await api('POST', '/api/plans/holidays', { date: '2026-09-19', name: '国庆加班', kind: 'overtime' });
const hols = ((await api('GET', '/api/plans/holidays')).json) ?? [];
const h21 = hols.find((h) => h.date === '2026-09-21');
const o19 = hols.find((h) => h.date === '2026-09-19');
check('P-02 节假日写入与 kind 回读', h21?.kind === 'holiday' && o19?.kind === 'overtime',
  `09-21=${h21?.kind} 09-19=${o19?.kind}`);

// ---- 场景 A：放假日跳过 ----
const tA = (await api('POST', '/api/plans', { projectId: pid, title: 'A-跨放假日', startDate: '2026-09-18', durationDays: 3 })).json;
check('A-1 放假日(09-21周一)不计工作日', tA?.end_date === '2026-09-22', `start=2026-09-18 dur=3 → end=${tA?.end_date}（期望 09-22）`);

// ---- 场景 B：加班日计入 ----
const tB = (await api('POST', '/api/plans', { projectId: pid, title: 'B-跨加班日', startDate: '2026-09-18', durationDays: 2 })).json;
check('B-1 加班日(09-19周六)计入工作日', tB?.end_date === '2026-09-19', `start=2026-09-18 dur=2 → end=${tB?.end_date}（期望 09-19）`);

// ---- 场景 C：无日历基线（对照：未标记时周六跳过） ----
const tC = (await api('POST', '/api/plans', { projectId: pid, title: 'C-普通跨周末', startDate: '2026-09-22', durationDays: 3 })).json;
// 09-22(周二) 09-23(周三) 09-24(周四) → end 09-24；若周六被计入会错
check('C-1 普通周末(09-26/27)仍被排除', tC?.end_date === '2026-09-24', `start=2026-09-22 dur=3 → end=${tC?.end_date}（期望 09-24）`);

console.log(`==== T00754 复核 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
