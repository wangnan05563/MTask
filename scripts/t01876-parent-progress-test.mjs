// T01876 API 级断言：父待办进度重算口径 + 归档/还原子任务后补重算
// 复现工单 D1~D8 全序列（隔离实例实测），并把修复后的期望值钉成回归基线：
//   D4/D5 部分完成 → 进度按未归档子任务比例；D6/D7 归档子任务 → 必须重算（旧实现永久停在 33%）；
//   D8 全部子任务归档（total=0）→ 不动父；另覆盖 T00776「done 父再添 todo 子」与生产 T00772 的冻结态。
// 口径结论：tasks.status 保持 todo|done 二元（写 doing 会让父从待办/已完成两页签同时消失，见 TaskService.recalcParentProgress 注释），
//   因此本测试同时断言「状态恒为二元」与「todo/doing 可见性不变」。
// 用法：node t01876-parent-progress-test.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://127.0.0.1:39925';
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

const proj = (await api('POST', '/api/projects', { name: `T01876-父进度-${Date.now() % 100000}` })).json;
const pid = proj.id;
check('A-01 创建项目', !!pid, `id=${pid}`);

// 全量快照（活跃 + 归档），用于按 id 取 status/progress
async function snap(id) {
  const active = (await api('GET', `/api/tasks?projectId=${pid}&limit=500`)).json ?? [];
  const arch = (await api('GET', `/api/tasks?projectId=${pid}&archived=1&limit=500`)).json ?? [];
  return [...active, ...arch].find((t) => t.id === id) ?? null;
}
/** 返回 "status/progress%" 形态，便于与工单里的 D 序列输出逐条对照 */
async function cell(id) {
  const t = await snap(id);
  return t ? `${t.status}/${t.progress}%` : 'MISSING';
}
const seen = [];
async function track(name, id) {
  const v = await cell(id);
  seen.push({ v, status: (v.split('/')[0]), progress: Number(v.split('/')[1].replace('%', '')) });
  return v;
}

async function mkTask(title, parentId, status) {
  const r = await api('POST', '/api/tasks', { projectId: pid, title, parentId, status });
  return r.json;
}

// ---- D1~D3：父 E + 两个 todo 子 ----
const E = await mkTask('父E（汇总）');
const E1 = await mkTask('E1', E.id);
const E2 = await mkTask('E2', E.id);
check('D1 父+2 todo 子 → todo/0%', (await track('D1', E.id)) === 'todo/0%', await cell(E.id));
// ---- D2：E1 完成 → 50% ----
await api('PATCH', `/api/tasks/${E1.id}`, { status: 'done' });
check('D2 1/2 子 done → todo/50%（进度求真，状态仍二元）', (await track('D2', E.id)) === 'todo/50%', await cell(E.id));
// ---- D3：新增第 3 个 todo 子 → 33% ----
const E3 = await mkTask('E3', E.id);
check('D3 再添 todo 子 → todo/33%', (await track('D3', E.id)) === 'todo/33%', await cell(E.id));
// ---- D4：批量归档接口归档 E3 → 必须重算 50%（旧实现停在 33%）----
await api('POST', '/api/archive', { taskIds: [E3.id] });
check('D4 POST /api/archive 归档子任务 → todo/50%（重算，非停留旧值）', (await track('D4', E.id)) === 'todo/50%', await cell(E.id));
// ---- D5：PATCH 单条归档 E2（只剩 1 个 done 子）→ done/100%（旧实现停在 33%）----
await api('PATCH', `/api/tasks/${E2.id}`, { archived: true });
check('D5 PATCH archived 归档子任务 → done/100%（两条路径都触发重算）', (await track('D5', E.id)) === 'done/100%', await cell(E.id));
// ---- D6：还原 E3 → 回到 todo/50% ----
await api('POST', '/api/archive/restore', { taskIds: [E3.id] });
check('D6 还原子任务 → todo/50%', (await track('D6', E.id)) === 'todo/50%', await cell(E.id));
// ---- D7：再还原 E2 → todo/33%（3 子中 1 done）----
await api('POST', '/api/archive/restore', { taskIds: [E2.id] });
check('D7 全部还原 → todo/33%', (await track('D7', E.id)) === 'todo/33%', await cell(E.id));
// ---- D8：三个子任务全归档（total=0）→ 父保持不动 ----
await api('POST', '/api/archive', { taskIds: [E1.id, E2.id, E3.id] });
check('D8 子任务全归档 → 父保持 todo/33%（无可依据比例，不改人工态）', (await track('D8', E.id)) === 'todo/33%', await cell(E.id));
await api('POST', '/api/archive/restore', { taskIds: [E1.id, E2.id, E3.id] });
check('D8b 全部还原后重算恢复一致 → todo/33%', (await track('D8b', E.id)) === 'todo/33%', await cell(E.id));

// ---- T00776 场景：done 父再添 todo 子（旧 `status != 'done'` 守卫把 done 父整体冻结）----
const F = await mkTask('父F（T00776）');
const F1 = await mkTask('F1', F.id);
const F2 = await mkTask('F2', F.id);
await api('PATCH', `/api/tasks/${F1.id}`, { status: 'done' });
await api('PATCH', `/api/tasks/${F2.id}`, { status: 'done' });
check('T1 子任务全 done → 父 done/100%', (await cell(F.id)) === 'done/100%', await cell(F.id));
const F3 = await mkTask('F3', F.id);
check('T2 done/100% 父新增 todo 子 → todo/67%（旧实现冻结在 done/100%）', (await cell(F.id)) === 'todo/67%', await cell(F.id));
// ---- 生产 T00772 冻结态自愈：done 但进度停在旧值的父，任一子任务变更后按真实比例回算 ----
await api('PATCH', `/api/tasks/${F3.id}`, { status: 'done' });
check('T3 最后一个子任务完成 → done/100%', (await cell(F.id)) === 'done/100%', await cell(F.id));
await api('PATCH', `/api/tasks/${F3.id}`, { status: 'todo' });
check('T4 done 父不再被守卫冻结（子任务退回即回算 todo/67%）', (await cell(F.id)) === 'todo/67%', await cell(F.id));

// ---- 不变量：全程状态恒为二元，且不出现「done 但非 100%」/「todo 但 100%」----
const bad = seen.filter((s) => !['todo', 'done'].includes(s.status));
check('I-01 观察到的父状态恒为 todo|done（不产出 UI 不可见的 doing）', bad.length === 0, `bad=${bad.map((b) => b.v).join(',') || '无'}`);
const contra = seen.filter((s) => (s.status === 'todo' && s.progress === 100) || (s.status === 'done' && s.progress !== 100));
check('I-02 无「todo+100%」/「done+非100%」自相矛盾行', contra.length === 0, `contra=${contra.map((c) => c.v).join(',') || '无'}`);
// 可见性回归：未完成的父必须仍在待办列表（TasksPage 待办页签按 status==='todo' 严格二分）
const activeList = (await api('GET', `/api/tasks?projectId=${pid}&limit=500`)).json ?? [];
const todoSide = activeList.filter((t) => t.status === 'todo').map((t) => t.id);
const doingSide = activeList.filter((t) => !['todo', 'done'].includes(t.status)).map((t) => t.id);
check('I-03 活跃列表无第三种状态行（父不会从待办/已完成两页签同时消失）', doingSide.length === 0, `游离行=${doingSide.join(',') || '无'}`);
check('I-04 未完成父留在待办侧（AI 待处理队列 status=todo 仍可领取）', todoSide.includes(E.id), `E=${E.id} 待办侧数=${todoSide.length}`);
// 非父任务不受影响
const orphan = await mkTask('无父子任务');
check('I-05 无父子任务状态/进度不受影响', (await cell(orphan.id)) === 'todo/0%', await cell(orphan.id));

console.log(`\n观察序列：${seen.map((s) => s.v).join(' → ')}`);
console.log(`\nT01876 断言：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
