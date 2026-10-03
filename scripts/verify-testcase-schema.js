// T01482 隔离验证：测试用例数据模型（test_cases / case_steps）与需求级联删除断言。
// 起隔离实例（临时数据目录 + 独立端口），不触碰生产库/生产配置。
// 运行：node scripts/verify-testcase-schema.js [--port 39921]
//
// 为什么用「级联删除」而不是「PRAGMA foreign_keys」做自我保护断言：
// schema.ts 的外键只在 pragma 打开时才生效（connection.ts 启动时 db.pragma('foreign_keys = ON')）。
// 一旦后续改动关掉 pragma 或把物理删除改成逻辑删除，本用例的级联断言会立即失败——
// 比直接读 pragma 值更能证明「删除需求 → 连带删用例」这条业务约束真实成立（PRD §5.3）。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(REPO, 'server');
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 39921);
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t01482-'));

let fail = 0;
const check = (name, cond, extra) => {
  if (!cond) fail++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' → ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 运行时选择：本机 Node 与 Electron 内置 Node 的原生模块 ABI 可能不同（见 scripts/native-switch.bat）。
 * 注意探针必须真的 `new Database()`：better-sqlite3 的 lib/database.js 在构造时才调 bindings() 打开 .node，
 * 只 require 会成功返回，导致 ABI 不匹配的运行时被误判为可用（实测 Node 24 + electron(130) 二进制）。
 */
const PROBE = "const D=require('better-sqlite3'); const db=new D(':memory:'); db.pragma('foreign_keys'); db.close();";
function pickRuntime() {
  const electronBin = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const candidates = [
    { cmd: process.execPath, env: {} },
    ...(fs.existsSync(electronBin) ? [{ cmd: electronBin, env: { ELECTRON_RUN_AS_NODE: '1' } }] : []),
  ];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, ['-e', PROBE], {
      cwd: SERVER_DIR, env: { ...process.env, ...c.env }, encoding: 'utf8', shell: false,
    });
    if (r.status === 0) return c;
  }
  throw new Error('没有可加载 better-sqlite3 的运行时：先执行 scripts\\native-switch.bat dev|electron 对齐 ABI');
}

const req = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};
const get = (p) => req('GET', p);
const rows = async (table, search) => {
  const q = search ? `?search=${encodeURIComponent(search)}` : '';
  const r = await get(`/dbadmin/tables/${table}/rows${q}`);
  return r.json?.rows ?? [];
};

async function waitHealth(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch (_) { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}

(async () => {
  const rt = pickRuntime();
  console.log(`[setup] 运行时: ${path.basename(rt.cmd)}｜临时数据目录: ${TMP}`);
  const server = spawn(rt.cmd, ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...rt.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));

  const now = new Date().toISOString();
  const pid = `t01482-proj-${Date.now()}`;
  const reqId = `t01482-req-${Date.now()}`;
  const caseId = `t01482-case-${Date.now()}`;
  const stepId = `t01482-step-${Date.now()}`;

  try {
    if (!(await waitHealth())) throw new Error('服务启动超时：\n' + logs.join(''));

    console.log('\n[场景1] 建表与列结构（PRD §5.1 / §5.2）');
    const tables = (await get('/dbadmin/tables')).json ?? [];
    const names = tables.map((t) => t.name);
    check('test_cases 表已创建', names.includes('test_cases'), names.filter((n) => n.startsWith('test_')).join(','));
    check('case_steps 表已创建', names.includes('case_steps'));

    const caseCols = (await get('/dbadmin/tables/test_cases/schema')).json ?? [];
    const expectCols = ['id', 'project_id', 'req_id', 'case_no', 'module', 'title', 'preconditions', 'expected',
      'test_data', 'postconditions', 'priority', 'type', 'method', 'status', 'last_result', 'tags',
      'source_key', 'source_hash', 'sort_order', 'created_at', 'updated_at'];
    const gotCols = caseCols.map((c) => c.name);
    const missing = expectCols.filter((c) => !gotCols.includes(c));
    check('test_cases 列齐全（21 列）', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : `共 ${gotCols.length} 列`);
    const colMap = Object.fromEntries(caseCols.map((c) => [c.name, c]));
    check('req_id 可空（孤儿用例）', colMap.req_id?.nullable === true, `nullable=${colMap.req_id?.nullable}`);
    // PRAGMA table_info 的 dflt_value 保留 DDL 原文（字符串字面量带单引号），比对前统一去引号
    const dflt = (name) => String(colMap[name]?.default ?? '').replace(/^'|'$/g, '');
    check('priority 默认 P1', dflt('priority') === 'P1', String(colMap.priority?.default));
    check('type 默认 functional', dflt('type') === 'functional', String(colMap.type?.default));
    check('method 默认 manual', dflt('method') === 'manual', String(colMap.method?.default));
    check('status 默认 draft', dflt('status') === 'draft', String(colMap.status?.default));
    check('last_result 默认 untested', dflt('last_result') === 'untested', String(colMap.last_result?.default));

    const stepCols = (await get('/dbadmin/tables/case_steps/schema')).json ?? [];
    check('case_steps 列齐全', ['id', 'case_id', 'step_no', 'action', 'expected', 'created_at', 'updated_at'].every((c) => stepCols.some((x) => x.name === c)), stepCols.map((c) => c.name).join(','));

    console.log('\n[场景2] 枚举默认值可落库（schema 与 testCaseEnums 口径一致）');
    await req('POST', '/dbadmin/tables/projects/rows', { id: pid, name: 'T01482 验证项目', description: '', sort_weight: 0, created_at: now, updated_at: now });
    await req('POST', '/dbadmin/tables/prd_requirements/rows', { id: reqId, project_id: pid, req_no: 'REQ-001', title: '登录校验', content: '', source_ref: '', priority: 'normal', status: 'todo', sort_order: 0, created_at: now, updated_at: now });
    const ins = await req('POST', '/dbadmin/tables/test_cases/rows', { id: caseId, project_id: pid, req_id: reqId, case_no: 'TC-001', title: '手机号+正确密码登录成功', created_at: now, updated_at: now });
    check('仅必填字段插入成功（其余走 DDL 默认值）', ins.status >= 200 && ins.status < 300, `status=${ins.status} ${ins.text?.slice(0, 120)}`);
    const inserted = (await rows('test_cases', 'TC-001'))[0] ?? {};
    check('默认 priority=P1', inserted.priority === 'P1', String(inserted.priority));
    check('默认 type=functional', inserted.type === 'functional', String(inserted.type));
    check('默认 method=manual', inserted.method === 'manual', String(inserted.method));
    check('默认 status=draft', inserted.status === 'draft', String(inserted.status));
    check('默认 last_result=untested', inserted.last_result === 'untested', String(inserted.last_result));

    console.log('\n[场景3] 用例编号项目内唯一（idx_test_cases_no）');
    const dup = await req('POST', '/dbadmin/tables/test_cases/rows', { id: `${caseId}-dup`, project_id: pid, req_id: reqId, case_no: 'TC-001', title: '重号用例', created_at: now, updated_at: now });
    check('同项目同 case_no 被唯一索引拒绝', dup.status >= 400 || /UNIQUE constraint failed/.test(dup.text ?? ''), `status=${dup.status} ${(dup.text ?? '').slice(0, 120)}`);

    console.log('\n[场景4] 删除需求级联删用例与步骤（自我保护断言，PRD §5.3）');
    await req('POST', '/dbadmin/tables/case_steps/rows', { id: stepId, case_id: caseId, step_no: 1, action: '打开登录页', expected: '展示账号密码输入框', created_at: now, updated_at: now });
    const stepsBefore = await rows('case_steps', stepId);
    check('步骤已落库', stepsBefore.length === 1, `count=${stepsBefore.length}`);
    const delReq = await req('DELETE', `/dbadmin/tables/prd_requirements/rows/${reqId}`);
    check('删除需求接口成功', delReq.status >= 200 && delReq.status < 300, `status=${delReq.status}`);
    const casesAfter = await rows('test_cases', caseId);
    check('需求删除后其用例被 CASCADE 一并删除', casesAfter.length === 0, `残留 ${casesAfter.length} 条：外键 pragma 未生效或被改为逻辑删除`);
    const stepsAfter = await rows('case_steps', stepId);
    check('用例删除后步骤被 CASCADE 一并删除', stepsAfter.length === 0, `残留 ${stepsAfter.length} 条`);
  } finally {
    server.kill();
    await sleep(300);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n==== 结论：${fail === 0 ? '全部通过' : fail + ' 项失败'} ====`);
  if (logs.join('').includes('error')) console.log('[server stderr 摘要]\n' + logs.join('').split('\n').filter((l) => /error|Error/.test(l)).slice(0, 5).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
