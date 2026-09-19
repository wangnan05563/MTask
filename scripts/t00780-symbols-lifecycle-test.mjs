// T00780 断言：workspace_symbols 索引生命周期（换绑/解绑清理 + 孤儿过滤）
// 用法：node t00780-symbols-lifecycle-test.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://127.0.0.1:39906';
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');

const A = mkdtempSync(join(tmpdir(), 'ws-A-'));
const B = mkdtempSync(join(tmpdir(), 'ws-B-'));
writeFileSync(join(A, 'alpha.ts'), 'export function alphaOnly() {}\n');
writeFileSync(join(B, 'beta.ts'), 'export function betaOnly() {}\n');

const proj = (await api('POST', '/api/projects', { name: `T00780-${Date.now() % 100000}` })).json;
const pid = proj.id;

// ① 绑 A → 刷新 → 应只有 A 的符号
await api('PATCH', `/api/projects/${pid}`, { workspacePath: A });
const r1 = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
check('L-1 绑定 A 后刷新建索引', r1?.symbols >= 1, JSON.stringify(r1));
const qA = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=alphaOnly`)).json ?? [];
check('L-2 A 的符号可查', qA.some((s) => s.symbol === 'alphaOnly'), JSON.stringify(qA));

// ② 改绑 B（旧索引应被清理；不刷新也不应返回 A 的符号）
check('L-3 换绑成功', (await api('PATCH', `/api/projects/${pid}`, { workspacePath: B })).status === 200, '');
const qAafter = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=alphaOnly`)).json ?? [];
check('L-4 换绑后旧符号不再返回（清理生效 + 孤儿过滤）', qAafter.length === 0, JSON.stringify(qAafter));
const r2 = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
// 说明：换绑瞬间 PATCH /projects/:id 已 clearSymbols，故此处 cleared 通常为 0（双保险生效）；
// 断言点是 cleared 字段存在且为数值（refresh 自身的「根路径不一致自清理」为二次防线）
check('L-5 换绑后重建索引 cleared 字段可用（双保险：绑定处已清，此处应为 0）', typeof r2?.cleared === 'number' && r2.cleared === 0, JSON.stringify(r2));
const qB = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=betaOnly`)).json ?? [];
check('L-6 B 的符号可查', qB.some((s) => s.symbol === 'betaOnly'), JSON.stringify(qB));

// ③ 同路径再次刷新不应误清（mtime 增量仍生效）
const r3 = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
check('L-7 同路径刷新 cleared=0 且 skipped=1（增量仍生效）', r3?.cleared === 0 && r3?.skipped === 1, JSON.stringify(r3));

// ④ 解绑 → 索引清空，查询应报未配置工作空间
await api('PATCH', `/api/projects/${pid}`, { workspacePath: '' });
const qUn = await api('GET', `/api/workspace/symbols?projectId=${pid}&q=betaOnly`);
check('L-8 解绑后查询报未配置工作空间（400）', qUn.status === 400 && (qUn.json?.error ?? '').includes('未配置工作空间'), `status=${qUn.status} error=${qUn.json?.error}`);
const refreshUn = await api('POST', '/api/workspace/symbols/refresh', { projectId: pid });
check('L-9 解绑后刷新同样拒绝', refreshUn.status === 400, `status=${refreshUn.status}`);

// ⑤ 重新绑回 A → 索引可用（验证解绑时已清空，不残留 B 的符号）
await api('PATCH', `/api/projects/${pid}`, { workspacePath: A });
const r4 = (await api('POST', '/api/workspace/symbols/refresh', { projectId: pid })).json;
const qA2 = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=alphaOnly`)).json ?? [];
const qB2 = (await api('GET', `/api/workspace/symbols?projectId=${pid}&q=betaOnly`)).json ?? [];
check('L-10 重绑 A 后 alphaOnly 可查', qA2.some((s) => s.symbol === 'alphaOnly'), JSON.stringify(qA2));
check('L-11 重绑 A 后不残留 betaOnly（索引已随解绑清空）', qB2.length === 0, JSON.stringify(qB2));
void r4;

console.log(`==== T00780 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
