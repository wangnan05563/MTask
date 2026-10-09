/**
 * T01621 验证：时间线阶段分组（groupTimelinePhases）夹具逻辑测试。
 * 口径：有显式子任务的里程碑成员=显式子集（与列表折叠一致）；无显式子任务沿用位置分组；悬空引用不丢行。
 * 运行：D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/verify-t01621.mjs（需 node24 ABI）
 */
import { groupTimelinePhases, type TlPlan } from '../web/src/components/PlanTimeline.tsx';
import { childParentIdOf } from '../web/src/util/planDeps.ts';

let failures = 0;
const check = (n: string, cond: boolean, extra?: unknown) => { if (!cond) failures++; console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${n}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 260) : ''}`); };

function row(id: string, kind: string, start: string, deps?: Array<{ id: string; type: string }>): TlPlan {
  return { id, title: id, description: null, kind, start_date: start, end_date: start, duration_days: 1, progress: 0, status: 'todo', assignee: null, color: null, linked_task_id: null, deps: deps ? JSON.stringify(deps) : null };
}

// ---- 夹具 A（混合）：M1(06-01) → A(显式child→M1, 06-05) → B(无依赖, 06-10) → M2(06-15) → C(显式child→M2, 06-20)
const A1 = [
  row('M1', 'milestone', '2026-06-01'),
  row('A', 'normal', '2026-06-05', [{ id: 'M1', type: 'child' }]),
  row('B', 'normal', '2026-06-10'),
  row('M2', 'milestone', '2026-06-15'),
  row('C', 'normal', '2026-06-20', [{ id: 'M2', type: 'child' }]),
];
const pA = groupTimelinePhases(A1);
const itemsOf = (msId: string | null) => pA.filter((ph) => ph.milestone?.id === msId).flatMap((ph) => ph.items.map((x) => x.id));
const loose = pA.filter((ph) => ph.milestone === null).flatMap((ph) => ph.items.map((x) => x.id));
check('A1 阶段数=3（M1 段 + B 无名段 + M2 段）', pA.length === 3, pA.map((ph) => ph.milestone?.id ?? '(无名)'));
check('A2 折叠 M1：时间线隐藏 {A} == 列表折叠隐藏 {A}（差集空）', itemsOf('M1').join() === 'A' && !loose.includes('A'), { ms1: itemsOf('M1'), loose });
check('A3 折叠 M2：隐藏 {C} == 列表 {C}', itemsOf('M2').join() === 'C', itemsOf('M2'));
check('A4 B 不属于任何里程碑阶段（列表折叠 M1/M2 均不隐藏 B，时间线同）', loose.join() === 'B', loose);

// ---- 夹具 B（纯 legacy，无任何 child 依赖）：M3 → D 位置相邻，沿用位置分组
const B1 = [row('M3', 'milestone', '2026-07-01'), row('D', 'normal', '2026-07-05')];
const pB = groupTimelinePhases(B1);
check('B1 无显式依赖：位置分组不回退（D 仍属 M3 阶段）', pB.length === 1 && pB[0].milestone?.id === 'M3' && pB[0].items.map((x) => x.id).join() === 'D', pB.map((ph) => [ph.milestone?.id, ph.items.map((x) => x.id)]));

// ---- 夹具 C：显式子任务 start_date 早于里程碑行（pending 路径）
const C1 = [
  row('A2', 'normal', '2026-08-01', [{ id: 'M4', type: 'child' }]),
  row('M4', 'milestone', '2026-08-10'),
];
const pC = groupTimelinePhases(C1);
check('C1 早于里程碑的显式子任务仍归 M4 阶段', pC.length === 1 && pC[0].milestone?.id === 'M4' && pC[0].items.map((x) => x.id).join() === 'A2', pC.map((ph) => [ph.milestone?.id, ph.items.map((x) => x.id)]));

// ---- 夹具 D：child 指向不存在的里程碑（悬空引用不丢行）
const D1 = [
  row('M5', 'milestone', '2026-09-01'),
  row('A3', 'normal', '2026-09-02', [{ id: 'ghost', type: 'child' }]),
  row('E', 'normal', '2026-09-03'),
];
const pD = groupTimelinePhases(D1);
const allD = pD.flatMap((ph) => ph.items.map((x) => x.id)).join();
check('D1 悬空引用任务不丢失（承接于尾部无名段）', allD.includes('A3') && allD.includes('E'), { all: allD, phases: pD.map((ph) => [ph.milestone?.id, ph.items.map((x) => x.id)]) });

// ---- 夹具 E：全无里程碑 → 单一无名段（原 prelude 语义）
const E1 = [row('E1', 'normal', '2026-10-01'), row('E2', 'daily', '2026-10-02')];
const pE = groupTimelinePhases(E1);
check('E1 无里程碑：单一无名段包含全部', pE.length === 1 && pE[0].milestone === null && pE[0].items.length === 2, pE.map((ph) => [ph.milestone?.id, ph.items.length]));

// ---- 共享 helper 冒烟：childParentIdOf 与 PlanPage.childMilestoneOf 同源
check('F1 childParentIdOf 取第一个 child 引用', childParentIdOf('[{"id":"x","type":"serial"},{"id":"M1","type":"child"}]') === 'M1');
check('F2 非法 JSON/空值 → null', childParentIdOf('not-json') === null && childParentIdOf(null) === null && childParentIdOf(undefined) === null);

console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
