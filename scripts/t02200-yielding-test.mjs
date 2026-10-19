// T02200 API 级断言：符号索引刷新「让路」——大工作空间分片让路 + 后台续跑收敛 + 只读接口延迟
// 用法：node t02200-yielding-test.mjs [baseUrl] [tmpBase]
//   baseUrl 缺省 http://127.0.0.1:39904（隔离实例）；tmpBase 缺省 os.tmpdir()
//   （磁盘紧张时可设 TMPDIR 或第二参数指到别处，测试夹具只是小文本文件）
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}
const BASE = process.argv[2] ?? 'http://127.0.0.1:39904';
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

const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const os = await import('node:os');
const TMP = process.argv[3] ?? os.tmpdir();

// ---- 判定函数（纯函数，teeth 自测直接喂构造样本，证明阈值不是空转） ----
function judge(samples, { minSamples = 50, p99Limit = 500, maxLimit = 500 } = {}) {
  const ok = samples.filter((s) => s.code === 200).map((s) => s.ms);
  const fails = samples.filter((s) => s.code !== 200);
  if (samples.length < minSamples) return { okFlag: false, why: `样本数 ${samples.length} < ${minSamples}` };
  if (fails.length > 0) return { okFlag: false, why: `失败请求 ${fails.length} 次` };
  const sorted = [...ok].sort((a, b) => a - b);
  const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1)];
  const max = sorted[sorted.length - 1];
  if (p99 > p99Limit) return { okFlag: false, why: `P99=${p99} > ${p99Limit}` };
  if (max > maxLimit) return { okFlag: false, why: `max=${max} > ${maxLimit}` };
  return { okFlag: true, why: `n=${samples.length} P99=${p99} max=${max}` };
}

// ---- 大工作空间夹具：25 目录 × 180 文件 = 4,500 个 .ts（每个 1 个导出函数，共 4,501 符号；T02280 起上限按规模自适应，冷建取上界 50,000，本夹具远低于它 → 让路语义不受限值影响） ----
const DIRS = 25, PER = 180, TOTAL = DIRS * PER + 1; // +1：末段目录的收敛探针文件
const WS = mkdtempSync(join(TMP, 'mtask-t02200-'));
for (let d = 0; d < DIRS; d++) {
  const dir = join(WS, `src/mod_${String(d).padStart(2, '0')}`);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PER; i++) {
    writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.ts`), `export function sym_${d}_${i}() { return ${i}; }\n`);
  }
}
// 末段目录：只有整轮遍历跑到最后才会被索引，用作「余量已补齐」的探针
mkdirSync(join(WS, 'zzz_tail'), { recursive: true });
writeFileSync(join(WS, 'zzz_tail', 'tail.ts'), 'export function zzEndMarker() {}\n');

const proj = (await api('POST', '/api/projects', { name: `T02200-YIELD-${Date.now() % 100000}` })).json;
const pid = proj.id;
await api('PATCH', `/api/projects/${pid}`, { workspacePath: WS });
check('Y-01 夹具项目+工作空间', !!pid, `id=${pid} files=${TOTAL}`);

// ---- ① 冷建：内联预算内返回 deferred，只读接口在同窗口保持可响应 ----
const samples = [];
let stop = false;
const pollers = Array.from({ length: 3 }, async () => {
  while (!stop) {
    const t = Date.now();
    let code = 200;
    try {
      const r = await fetch(`${BASE}/api/projects`);
      await r.text();
      code = r.status;
    } catch (e) { code = `ERR:${e.cause?.code ?? e.name}`; }
    samples.push({ ms: Date.now() - t, code });
  }
});
await new Promise((r) => setTimeout(r, 300));
const t0 = Date.now();
const cold = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
const coldMs = Date.now() - t0;
await new Promise((r) => setTimeout(r, 4000)); // 覆盖后台续跑窗口
const verdict = judge(samples);
stop = true;
await Promise.allSettled(pollers);

check('Y-02 冷建让路：请求在内联预算处返回 deferred=true', cold?.deferred === true && coldMs < 900, `deferred=${cold?.deferred} 耗时=${coldMs}ms 统计=${JSON.stringify(cold)}`);
check('Y-03 让路返回的是部分结果（未建完全树）', typeof cold?.files === 'number' && cold.files < TOTAL, `files=${cold?.files} < ${TOTAL}`);
check('Y-04 让路窗口内只读接口 P99<500ms 且 0 失败', verdict.okFlag, verdict.why);

// ---- ② 后台续跑收敛：末段符号可查（只读查询，不触发新刷新以免取代在跑任务） ----
const markerAt = Date.now();
let tailHit = null;
while (Date.now() - markerAt < 60000) {
  const q = await api('GET', `/api/workspace/symbols?projectId=${pid}&q=zzEndMarker`);
  if ((q.json ?? []).length > 0) { tailHit = q.json; break; }
  await new Promise((r) => setTimeout(r, 500));
}
check('Y-05 余量交后台补齐：末段目录符号最终可查（索引最终一致）', !!tailHit, tailHit ? JSON.stringify(tailHit) : '60s 内未出现');

// ---- ③ 热刷：整树 mtime 命中不重建（增量语义保持）；大树的 stat-only 遍历仍可超内联预算 → 让路 ----
const hot = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
check('Y-06 热刷增量语义保持：files=0（无一重建），skipped 按片累积',
  hot?.files === 0 && (hot?.deferred === true ? hot.skipped > 0 : hot?.skipped >= TOTAL), JSON.stringify(hot));

// ---- ④ 取代语义：连发两次刷新（第二次取代第一次的续跑）后仍收敛 ----
writeFileSync(join(WS, 'zzz_tail', 'late.ts'), 'export function zzLateMarker() {}\n');
const a = await api('POST', '/api/workspace/symbols/refresh', { projectId: pid });
const b = await api('POST', '/api/workspace/symbols/refresh', { projectId: pid });
let lateHit = null;
const lateAt = Date.now();
while (Date.now() - lateAt < 60000) {
  const q = await api('GET', `/api/workspace/symbols?projectId=${pid}&q=zzLateMarker`);
  if ((q.json ?? []).length > 0) { lateHit = q.json; break; }
  await new Promise((r) => setTimeout(r, 500));
}
check('Y-07 连发刷新（取代在跑任务）不破坏收敛',
  a.status === 200 && b.status === 200 && !!lateHit, `a=${JSON.stringify(a.json)} b=${JSON.stringify(b.json)} late=${JSON.stringify(lateHit)}`);

// ---- ⑤ 小工作空间契约不变（既有 t00777/t00780 的同族断言，这里显式覆盖一次） ----
const SMALL = mkdtempSync(join(TMP, 'mtask-t02200-small-'));
writeFileSync(join(SMALL, 'a.ts'), 'export function smallAlpha() {}\n');
writeFileSync(join(SMALL, 'b.ts'), 'export function smallBeta() {}\n');
const smallProj = (await api('POST', '/api/projects', { name: `T02200-SMALL-${Date.now() % 100000}` })).json;
await api('PATCH', `/api/projects/${smallProj.id}`, { workspacePath: SMALL });
const small = (await api('POST', '/api/workspace/symbols/refresh', { projectId: smallProj.id })).json;
check('Y-08 小工作空间一次请求内建完（deferred=false、files=2）', small?.deferred === false && small?.files === 2, JSON.stringify(small));

// ---- ⑥ teeth：判定函数在构造样本上必须报红（证明 Y-04 有牙） ----
const fast = Array.from({ length: 200 }, () => ({ ms: 12, code: 200 }));
const oneSlow = [...fast.slice(0, 199), { ms: 12418, code: 200 }];
const oneFail = [...fast.slice(0, 199), { ms: 8022, code: 'ERR:ECONNRESET' }];
const tooFew = [{ ms: 5, code: 200 }, { ms: 6, code: 200 }];
check('Y-09 teeth·全快样本判绿', judge(fast).okFlag, judge(fast).why);
check('Y-10 teeth·单条 12,418ms 阻塞判红', !judge(oneSlow).okFlag, judge(oneSlow).why);
check('Y-11 teeth·单条 ECONNRESET 判红', !judge(oneFail).okFlag, judge(oneFail).why);
check('Y-12 teeth·样本不足判红', !judge(tooFew).okFlag, judge(tooFew).why);

try { await api('DELETE', `/api/projects/${pid}`); await api('DELETE', `/api/projects/${smallProj.id}`); } catch { /* 无删除端点则留档 */ }
rmSync(WS, { recursive: true, force: true });
rmSync(SMALL, { recursive: true, force: true });

console.log(`==== T02200 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
