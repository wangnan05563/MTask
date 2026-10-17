// T01875：PRD 导入「同名计划」处置口径断言。
// 复现 T01869 实测事实：重导同一份 PRD 时需求行按编号顺延新建（T01867），计划行按标题无脑新建
// ——两套同名计划并排、无法幂等重跑。本单把口径定下来并验证两种模式都不碰原行的 status/progress：
//   默认 new   ：撞名的新行加「（N）」区分后缀（与 T01867/T01921 需求编号顺延同构），原行一字不动；
//   显式 reuse ：命中未归档同名原行做幂等补写——只补空描述/空复杂度与需求关联（只增不减），不新建、不改状态与进度。
// T02303（裁定口径甲）扩展 B12~B16：reuse 连带需求侧幂等——同标题且同内容的存量需求行复用其 id，
//   不新建第二套 prd_requirements、不翻倍关联边；同标题不同内容仍新建；查找表按项目隔离。B12~B16 见下方断言。
// 用法：<node22runtime> scripts/verify-t01875.mjs
//   前提：better-sqlite3 与运行 node ABI 匹配（本机 ABI127 runtime 可用；Node24 会 ERR_DLOPEN_FAILED）
//   走隔离实例：MTask_PORT + MTask_DATA_DIR=临时目录，绝不碰用户生产库
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 39500 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api`;
const DIR = mkdtempSync(join(tmpdir(), 't01875-dup-'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jget = async (path) => (await fetch(`${API}${path}`)).json();
const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const patch = async (path, body) => {
  const res = await fetch(`${API}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const REQS = [
  { reqNo: 'REQ-01', title: '需求甲', content: '甲的原文要点' },
  { reqNo: 'REQ-02', title: '需求乙', content: '乙的原文要点' },
];
const plansPayload = (extra = {}) => [
  { title: '计划甲', description: '原描述', reqNos: ['REQ-01'], complexity: 2, ...extra },
  { title: '计划乙', description: '', reqNos: ['REQ-02'], ...extra },
];

let server;
try {
  const occupied = await fetch(`${API}/health`).then(() => true).catch(() => false);
  check('S00 目标端口启动前未被占用（断言不会误连其他实例）', occupied === false, BASE);
  if (occupied) throw new Error('端口已被占用，终止以免对错误实例取证');
  const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
  const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
  server = spawn(
    LAUNCHER.exec,
    LAUNCHER.tsx,
    { cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_DATA_DIR: DIR, MTask_PORT: String(PORT), MTask_LOG_DIR: DIR }, stdio: 'ignore' },
  );
  console.log(`隔离实例启动器：${LAUNCHER.label}`);
  let up = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${API}/health`)).ok) { up = true; break; } } catch { /* 未就绪 */ }
    await sleep(300);
  }
  check('S0 隔离实例已就绪', up, `${DIR} / ${BASE}`);
  if (!up) throw new Error('服务未启动');

  const mkProject = async (name) => {
    const r = await post('/projects', { name });
    return r.body?.data?.id ?? r.body?.id;
  };
  const pidA = await mkProject('T01875 默认新建让号');
  const pidB = await mkProject('T01875 幂等复用');
  check('S1 两个测试项目已建', !!pidA && !!pidB && pidA !== pidB, `${pidA} / ${pidB}`);

  const plansOf = async (pid) => (await jget(`/plans?projectId=${pid}`)) ?? [];
  const todosOf = async (pid) => (await jget(`/tasks?projectId=${pid}&archived=0&limit=500`)).filter((t) => String(t.title).startsWith('[PRD]'));
  const matrixOf = async (pid) => (await jget(`/plans/prd-requirements?projectId=${pid}`)) ?? [];

  // ---------- A 组：默认口径 new —— 撞名让号，原行不动 ----------
  const a1 = await post('/plans/import-prd', { projectId: pidA, requirements: REQS, plans: plansPayload(), createTasks: true });
  check('A1 首次导入不受影响（2 计划 / 2 待办，标题原样）',
    a1.status === 200 && a1.body?.plans === 2 && a1.body?.tasks === 2 && (a1.body?.dupPlanTitles ?? []).length === 0,
    JSON.stringify(a1.body));
  const a1rows = await plansOf(pidA);
  const idJia1 = a1rows.find((p) => p.title === '计划甲')?.id;
  check('A2 首导行标题无后缀', !!idJia1 && a1rows.filter((p) => p.title.startsWith('计划甲')).length === 1, a1rows.map((p) => p.title).join(','));

  // 模拟真实使用：把一条推进到进行中并有进度，另一条改日期
  await patch(`/plans/${idJia1}`, { status: 'doing', progress: 45 });
  const snapA = (await plansOf(pidA)).find((p) => p.id === idJia1);
  const a2 = await post('/plans/import-prd', { projectId: pidA, requirements: REQS, plans: plansPayload(), createTasks: true });
  const renamed = (a2.body?.dupPlanTitles ?? []).filter((x) => x.renamedTo);
  check('A3 重导撞名的新行加后缀区分（2 个标题全部让号）', a2.status === 200 && renamed.length === 2 && a2.body?.plans === 2,
    JSON.stringify(a2.body?.dupPlanTitles));
  check('A4 让号明细可核对（计划甲 → 计划甲（2））',
    renamed.some((x) => x.title === '计划甲' && x.renamedTo === '计划甲（2）' && x.existing === 1)
    && renamed.some((x) => x.title === '计划乙' && x.renamedTo === '计划乙（2）'),
    JSON.stringify(renamed));

  const a3rows = await plansOf(pidA);
  const jiaOld = a3rows.find((p) => p.id === idJia1);
  const jiaNew = a3rows.find((p) => p.title === '计划甲（2）');
  check('A5 计划行总数 4 且标题两两唯一', a3rows.length === 4 && new Set(a3rows.map((p) => p.title)).size === 4, a3rows.map((p) => `${p.title}:${p.status}/${p.progress}%`).join(' | '));
  check('A6 原行状态与进度一字未动（重导没把 doing 的行打回未开始）',
    jiaOld?.status === snapA?.status && jiaOld?.progress === snapA?.progress && snapA?.status === 'doing',
    `重导前=${snapA?.status}/${snapA?.progress}% 重导后=${jiaOld?.status}/${jiaOld?.progress}%`);
  check('A7 新行是独立的「未开始/0%」行', jiaNew?.status === 'todo' && jiaNew?.progress === 0, `新行=${jiaNew?.status}/${jiaNew?.progress}%`);
  check('A8 新行也建出派生待办且标题跟随让号后的计划标题',
    (await todosOf(pidA)).some((t) => t.title === '[PRD] 计划甲（2）'), (await todosOf(pidA)).map((t) => t.title).join(' | '));

  // 第三次重导：让号必须继续往下走，不与（2）撞
  await post('/plans/import-prd', { projectId: pidA, requirements: REQS, plans: plansPayload() });
  const a4rows = await plansOf(pidA);
  check('A9 三次重导后 6 行全唯一（第 3 次让成（3），不复发同名）',
    a4rows.length === 6 && new Set(a4rows.map((p) => p.title)).size === 6, a4rows.map((p) => p.title).join(' | '));

  // 同一批内自撞名（一份拆解里两条同标题）也要让号
  const a5 = await post('/plans/import-prd', {
    projectId: pidA,
    plans: [{ title: '批内撞名', reqNos: [] }, { title: '批内撞名', reqNos: [] }],
  });
  const a5rows = (await plansOf(pidA)).filter((p) => p.title.startsWith('批内撞名'));
  check('A10 同批内撞名同样让号（不再是两行同名）',
    a5rows.length === 2 && a5rows[0].title !== a5rows[1].title && (a5.body?.dupPlanTitles ?? []).some((x) => x.title === '批内撞名'),
    a5rows.map((p) => p.title).join(' | '));

  // ---------- B 组：显式 reuse —— 幂等补写，绝不重置原行 ----------
  const b1 = await post('/plans/import-prd', { projectId: pidB, requirements: REQS, plans: plansPayload(), createTasks: true });
  const b1rows = await plansOf(pidB);
  const jiaB = b1rows.find((p) => p.title === '计划甲');
  const yiB = b1rows.find((p) => p.title === '计划乙');
  check('B1 首导（reuse 前基线）2 计划 2 待办', b1.body?.plans === 2 && (await todosOf(pidB)).length === 2, JSON.stringify(b1.body));

  // 人为制造「已有数据」：状态/进度、手工加的第二条需求关联、已填的描述与复杂度
  await patch(`/plans/${jiaB.id}`, { status: 'done', progress: 100 });
  await patch(`/plans/${yiB.id}`, { startDate: '2026-12-01', durationDays: 9 });
  const yiReqRow = (await matrixOf(pidB)).find((r) => r.req_no === 'REQ-02');
  await post(`/plans/prd-requirements/${yiReqRow.id}/link`, { kind: 'plan', targetId: jiaB.id, linked: true });
  const jiaReqBefore = JSON.parse((await plansOf(pidB)).find((p) => p.id === jiaB.id).req_ids);
  const yiDates = (await plansOf(pidB)).find((p) => p.id === yiB.id);
  const jiaSnap = (await plansOf(pidB)).find((p) => p.id === jiaB.id);

  // T02303 甲：reuse 前的需求侧基线（行数、逐行字段与关联边），用于断言「重导不再造第二套需求行」
  const reqRowsBefore = await matrixOf(pidB);
  const otherProjReqBefore = await matrixOf(pidA);
  const reqSig = (r) => JSON.stringify([r.id, r.req_no, r.title, r.content, r.status, r.priority, (r.linkedPlans ?? []).map((x) => x.id).sort()]);

  const b2 = await post('/plans/import-prd', {
    projectId: pidB,
    requirements: REQS,
    plans: [
      { title: '计划甲', description: '重导新描述', reqNos: ['REQ-01'], complexity: 5 },
      { title: '计划乙', description: '补上的描述', reqNos: ['REQ-02'], complexity: 3 },
    ],
    createTasks: true,
    onDuplicatePlan: 'reuse',
  });
  const b2rows = await plansOf(pidB);
  check('B2 reuse 不新建计划（plans=0、reusedPlans=2，行数仍 2）',
    b2.status === 200 && b2.body?.plans === 0 && b2.body?.reusedPlans === 2 && b2rows.length === 2, JSON.stringify(b2.body));
  check('B3 reuse 不新建待办（同名计划已有未归档派生待办 → 不造第二条）', (await todosOf(pidB)).length === 2, (await todosOf(pidB)).map((t) => t.title).join(' | '));
  check('B4 reuse 回传命中原行 id（dupPlanTitles.reusedPlanId）',
    (b2.body?.dupPlanTitles ?? []).every((x) => x.reusedPlanId === jiaB.id || x.reusedPlanId === yiB.id) && (b2.body?.dupPlanTitles ?? []).length === 2,
    JSON.stringify(b2.body?.dupPlanTitles));

  const jiaAfter = b2rows.find((p) => p.id === jiaB.id);
  const yiAfter = b2rows.find((p) => p.id === yiB.id);
  check('B5 原行状态与进度不动（已完成的计划没被重导打回 0%）',
    jiaAfter?.status === jiaSnap?.status && jiaAfter?.progress === jiaSnap?.progress && jiaSnap?.status === 'done',
    `重导前=${jiaSnap?.status}/${jiaSnap?.progress}% 重导后=${jiaAfter?.status}/${jiaAfter?.progress}%`);
  check('B6 原行起止日期与工期不动（手工排期不被重导覆盖）',
    yiAfter?.start_date === yiDates.start_date && yiAfter?.end_date === yiDates.end_date && yiAfter?.duration_days === yiDates.duration_days,
    `${yiAfter?.start_date}~${yiAfter?.end_date}/${yiAfter?.duration_days}d`);
  check('B7 需求关联只增不减（手工加的第二条关联仍在）',
    JSON.parse(jiaAfter.req_ids).length >= jiaReqBefore.length && jiaReqBefore.every((x) => JSON.parse(jiaAfter.req_ids).includes(x)),
    `before=${jiaReqBefore.length} after=${JSON.parse(jiaAfter.req_ids).length}`);
  check('B8 描述只补空不覆盖（原描述保留 / 空描述补齐）',
    jiaAfter?.description === '原描述' && yiAfter?.description === '补上的描述', `甲=${jiaAfter?.description} 乙=${yiAfter?.description}`);
  check('B9 复杂度只补空不覆盖（已有 2 保留 / 空值补 3）', jiaAfter?.complexity === 2 && yiAfter?.complexity === 3, `甲=${jiaAfter?.complexity} 乙=${yiAfter?.complexity}`);

  const mB = await matrixOf(pidB);
  const req01 = mB.find((r) => r.req_no === 'REQ-01');
  check('B10 原需求行关联不因 reuse 丢失（REQ-01 仍挂着那条计划）', (req01?.linkedPlans ?? []).some((x) => x.id === jiaB.id),
    `REQ-01 linkedPlans=${(req01?.linkedPlans ?? []).length}`);

  // ---------- T02303 甲：reuse 连带需求侧幂等（B12~B16）----------
  check('B12 reuse 不新建需求行（requirementsCreated=0 / reusedRequirements=2，矩阵行数不变）',
    b2.body?.requirementsCreated === 0 && b2.body?.reusedRequirements === 2 && mB.length === reqRowsBefore.length,
    `created=${b2.body?.requirementsCreated} reused=${b2.body?.reusedRequirements} rows=${reqRowsBefore.length}→${mB.length}`);

  const beforeSig = reqRowsBefore.map(reqSig).sort();
  const afterSig = mB.map(reqSig).sort();
  check('B13 存量需求行逐字段一字未动（id/编号/标题/内容/状态/优先级）',
    beforeSig.length === afterSig.length && beforeSig.every((s, i) => s === afterSig[i]),
    `差异=${JSON.stringify(afterSig.filter((s) => !beforeSig.includes(s)).slice(0, 2))}|${JSON.stringify(beforeSig.filter((s) => !afterSig.includes(s)).slice(0, 2))}`);

  const edges = (rows) => rows.reduce((n, r) => n + (r.linkedPlans ?? []).length, 0);
  check('B14 需求↔计划关联边不翻倍（重导同一份 PRD 不产生第二套边）',
    edges(reqRowsBefore) === edges(mB), `边数=${edges(reqRowsBefore)}→${edges(mB)}`);

  // 同标题但内容不同 ⇒ 不是「同一份拆解的重复导入」，宁可新建也不静默改写存量行
  const b5 = await post('/plans/import-prd', {
    projectId: pidB,
    requirements: [{ reqNo: 'REQ-01', title: '需求甲', content: '甲的原文要点（本次改了口径）' }, { reqNo: 'REQ-02', title: '需求乙', content: '乙的原文要点' }],
    plans: [{ title: '计划甲', reqNos: ['REQ-01'] }],
    onDuplicatePlan: 'reuse',
  });
  const mB5 = await matrixOf(pidB);
  const req01AfterDiff = mB5.find((r) => r.id === reqRowsBefore.find((x) => x.req_no === 'REQ-01')?.id);
  check('B15 同标题不同内容不误复用（新建 1 行、存量 REQ-01 原文行不被改写）',
    b5.body?.requirementsCreated === 1 && b5.body?.reusedRequirements === 1
    && mB5.length === mB.length + 1 && reqSig(req01AfterDiff) === reqSig(reqRowsBefore.find((x) => x.req_no === 'REQ-01')),
    `created=${b5.body?.requirementsCreated} reused=${b5.body?.reusedRequirements} rows=${mB.length}→${mB5.length}`);

  const otherProjReqAfter = await matrixOf(pidA);
  check('B16 复用查找按项目隔离（另一项目的同名需求行既不被复用也不被改写）',
    otherProjReqAfter.length === otherProjReqBefore.length
    && otherProjReqAfter.map(reqSig).sort().every((s, i) => s === otherProjReqBefore.map(reqSig).sort()[i]),
    `pidA 需求行=${otherProjReqBefore.length}→${otherProjReqAfter.length}`);

  // reuse 与 new 混用不得互相污染：同一项目再走默认导入，仍按让号新建
  const b3 = await post('/plans/import-prd', { projectId: pidB, requirements: REQS, plans: plansPayload() });
  const b3rows = await plansOf(pidB);
  check('B11 缺省口径仍是新建+让号（未传 onDuplicatePlan 不改变现有行为）',
    b3.body?.plans === 2 && (b3.body?.dupPlanTitles ?? []).every((x) => !!x.renamedTo) && b3rows.length === 4,
    `rows=${b3rows.length} ${JSON.stringify(b3.body?.dupPlanTitles)}`);

  // ---------- 卫生检查 ----------
  const raw = await jget('/projects');
  const dirProjects = Array.isArray(raw) ? raw : (raw?.data ?? []);
  check('S99 隔离实例内除默认收件箱外只有本次新建的 2 个项目（未读写生产库）',
    dirProjects.filter((p) => String(p.name).startsWith('T01875')).length === 2 && dirProjects.length === 3,
    dirProjects.map((p) => p.name).join(' | '));
} catch (e) {
  check('EX 脚本未异常中断', false, String(e?.message ?? e));
} finally {
  server?.kill();
  await sleep(800);
  const stillUp = await fetch(`${API}/health`).then(() => true).catch(() => false);
  check('Z1 隔离实例已退出（不留驻进程/不锁 better_sqlite3.node）', stillUp === false, BASE);
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 句柄未释放时留给系统临时目录 */ }
  console.log(`\n==== T01875 断言：${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail > 0 ? 1 : 0);
}
