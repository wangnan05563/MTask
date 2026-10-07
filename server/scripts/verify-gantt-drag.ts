/**
 * T01059 后续（甘特拖动联动排期）冒烟脚本。
 *
 * 断言前端拖动推导 workday/ganttDrag 与服务端 PlanService 的工作日历口径一致：
 * - 工作日计算（周末/放假日/加班日）；
 * - 三种拖动语义：move（平移保工期）、resize-l（改开始日重算工期）、resize-r（改结束日重算工期）；
 * - 边界：不许拖反（开始 > 结束 / 结束 < 开始），夹到 1 个工作日；
 * - 位移 0 的时候不产生变更（避免误发 PATCH）。
 *
 * 运行：npx tsx server/scripts/verify-gantt-drag.ts
 */
import { buildWorkdayCtx, calcEndDate, countWorkdays, isWorkday, parseYmd, snapWorkdayBack, snapWorkdayForward } from '../../web/src/utils/workday';
import { deltaDaysFromPx, ganttDragResult, newGanttDrag } from '../../web/src/utils/ganttDrag';

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

const EMPTY = buildWorkdayCtx([]);

console.log('[1] 工作日口径（2026-10-05 周一 / 10-10 周六 / 10-11 周日）');
assert(isWorkday(parseYmd('2026-10-05'), EMPTY), '周一为工作日');
assert(!isWorkday(parseYmd('2026-10-10'), EMPTY), '周六非工作日');
assert(!isWorkday(parseYmd('2026-10-11'), EMPTY), '周日非工作日');
assert(calcEndDate('2026-10-05', 5, EMPTY) === '2026-10-09', `5 工作日结束于周五（实际 ${calcEndDate('2026-10-05', 5, EMPTY)}）`);
assert(countWorkdays('2026-10-05', '2026-10-09', EMPTY) === 5, '周一至周五计 5 个工作日');
assert(countWorkdays('2026-10-05', '2026-10-12', EMPTY) === 6, '跨周末只计 6 个工作日');

console.log('[2] 放假日 / 加班日');
const HOL = buildWorkdayCtx([{ date: '2026-10-07', name: '调休', kind: 'holiday' }]);
assert(!isWorkday(parseYmd('2026-10-07'), HOL), '放假日非工作日');
assert(calcEndDate('2026-10-05', 5, HOL) === '2026-10-12', `跳过放假日→结束日顺延到 10-12（实际 ${calcEndDate('2026-10-05', 5, HOL)}）`);
const OT = buildWorkdayCtx([{ date: '2026-10-10', name: '加班', kind: 'overtime' }]);
assert(isWorkday(parseYmd('2026-10-10'), OT), '加班日（周六）算工作日');
assert(countWorkdays('2026-10-05', '2026-10-12', OT) === 7, '含加班日计 7 个工作日');

console.log('[3] 吸附（拖动落到非工作日时归位）');
assert(snapWorkdayForward('2026-10-10', EMPTY) === '2026-10-12', '周六向后吸附到下周一');
assert(snapWorkdayBack('2026-10-11', EMPTY) === '2026-10-09', '周日向前吸附到上周五');

console.log('[4] move：平移保工期');
const mv = ganttDragResult('move', '2026-10-05', '2026-10-09', 5, 3, EMPTY);
assert(mv.start === '2026-10-08' && mv.end === '2026-10-14' && mv.dur === 5, `右移 3 天：10-08 ~ 10-14 / 5 天（实际 ${mv.start} ~ ${mv.end} / ${mv.dur}）`);
const mv0 = ganttDragResult('move', '2026-10-05', '2026-10-09', 5, 0, EMPTY);
assert(mv0.start === '2026-10-05' && mv0.end === '2026-10-09', '位移 0 → 日期不变（不发请求）');
const mvSat = ganttDragResult('move', '2026-10-05', '2026-10-09', 5, 5, EMPTY);
assert(mvSat.start === '2026-10-12', `落到周六吸附到周一（实际 ${mvSat.start}）`);

console.log('[5] resize-l：改开始日，结束日不动，工期重算');
const rl = ganttDragResult('resize-l', '2026-10-05', '2026-10-09', 5, 2, EMPTY);
assert(rl.start === '2026-10-07' && rl.end === '2026-10-09' && rl.dur === 3, `左缘右移 2 天 → 10-07~10-09 / 3 天（实际 ${rl.start}~${rl.end} / ${rl.dur}）`);
const rlOver = ganttDragResult('resize-l', '2026-10-05', '2026-10-09', 5, 10, EMPTY);
assert(rlOver.start === '2026-10-09' && rlOver.dur === 1, `拖过结束日被夹住（实际 ${rlOver.start} / ${rlOver.dur}）`);

console.log('[6] resize-r：改结束日，开始日不动，工期重算');
const rr = ganttDragResult('resize-r', '2026-10-05', '2026-10-09', 5, 3, EMPTY);
assert(rr.start === '2026-10-05' && rr.end === '2026-10-12' && rr.dur === 6, `右缘右移 3 天 → 10-05~10-12 / 6 天（实际 ${rr.start}~${rr.end} / ${rr.dur}）`);
const rrNeg = ganttDragResult('resize-r', '2026-10-05', '2026-10-09', 5, -10, EMPTY);
assert(rrNeg.end === '2026-10-05' && rrNeg.dur === 1, `拖到开始日之前被夹住（实际 ${rrNeg.end} / ${rrNeg.dur}）`);

console.log('[7] 位移换算与初始状态');
assert(deltaDaysFromPx(54, 18) === 3, '54px / 18px 日宽 = 3 天');
assert(deltaDaysFromPx(-18, 18) === -1, '反向 1 天');
const st = newGanttDrag('p1', 'move', 100, '2026-10-05', '2026-10-09', 5);
assert(st.moved === false && st.nextStart === '2026-10-05', '初始态：未位移、预览=原值');

console.log(failed === 0 ? '\nSMOKE OK: 全部断言通过' : `\nSMOKE FAILED: ${failed} 条断言未通过`);
process.exit(failed === 0 ? 0 : 1);
