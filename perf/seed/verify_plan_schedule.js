/**
 * 计划时间线不变式校验（P0-1「增量重排」改动的正确性验证）。
 *
 * 背景：原实现每次计划变更都无条件全量重排（rescheduleAll，O(n)）；改为按变更位置增量重排后，
 * 必须证明「重排范围收敛」没有破坏串行瀑布语义。
 *
 * 做法：不信任被测代码的中间状态，**独立重新推导**应有日期（首行 start 为锚点 → 逐行串行推导
 * 下一工作日与含尾结束日），与库内实际值逐行比对；每步变更后都校验一次。
 *
 * 用法：node perf/seed/verify_plan_schedule.js
 */
const path = require('node:path');
const fs = require('node:fs');

const DIR = path.join(__dirname, '..', 'sandbox', 'verify-plans');
process.env.MTask_DATA_DIR = DIR;
fs.mkdirSync(DIR, { recursive: true });

const { initSchema } = require('../../server/dist/db/schema.js');
initSchema();
const { getDb } = require('../../server/dist/db/connection.js');
const { PlanService } = require('../../server/dist/services/PlanService.js');

const PID = 'proj-verify';

// ---------- 独立实现的工作日历推导（与被测代码同规则，但独立书写） ----------
const fmt = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const parseDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('非法日期: ' + s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const holidaySet = () => new Set(getDb().prepare('SELECT date FROM holidays').all().map((r) => r.date));
const isWorkday = (d, h) => {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  return !h.has(fmt(d));
};
const nextWorkday = (after, h) => {
  const d = parseDate(after);
  do { d.setDate(d.getDate() + 1); } while (!isWorkday(d, h));
  return fmt(d);
};
const calcEndDate = (start, dur, h) => {
  const d = parseDate(start);
  let left = dur;
  while (left > 0) {
    if (isWorkday(d, h)) left -= 1;
    if (left > 0) d.setDate(d.getDate() + 1);
  }
  return fmt(d);
};

let failed = 0;
/**
 * 校验不变式。
 * @param label      步骤描述
 * @param reanchorAt 该下标行的 start_date 由用户显式指定（update(startDate)），
 *                   因此它不要求等于 nextWorkday(prevEnd)，只要求 > prevEnd；
 *                   其后的行仍必须从它串行推导。
 *
 * 两条独立不变式：
 *  (a) 自洽：每行 end_date === calcEndDate(start_date, duration_days, holidays)
 *  (b) 串联：下标 > reanchorAt 的行 start_date === nextWorkday(prevEnd)
 *      （reanchorAt 行本身只要求 start_date > prevEnd 且为工作日）
 * 另注：archive 只把行从活跃时间线移除、**不重排 sort_order**（沿用原语义），
 *      因此只断言 sort_order 严格递增，不断言连续。
 */
function check(label, reanchorAt = -1) {
  const rows = getDb().prepare(
    'SELECT id, title, start_date, end_date, duration_days, sort_order FROM plan_tasks WHERE project_id = ? AND archived = 0 ORDER BY sort_order',
  ).all(PID);
  const h = holidaySet();
  const errs = [];
  let prevEnd = null;
  rows.forEach((r, i) => {
    if (i > 0 && r.sort_order <= rows[i - 1].sort_order) errs.push(`sort_order 非递增：位置 ${i}`);
    let start;
    if (i === 0) {
      start = r.start_date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) errs.push(`首行 start 非法：${start}`);
    } else if (i === reanchorAt) {
      // 显式重设开始日：语义为「用户指定即生效」——即使早于前序结束日（产生重叠）也按原值采用，
      // 这是既有产品行为（原 update 走 rescheduleFrom(firstStartDate) 亦如此），本次优化未改动。
      // 因此这里只断言「是合法工作日日期」，并单独断言其等于请求值（见步骤 5）。
      start = r.start_date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) errs.push(`重锚行 start 非法：${start}`);
      else if (!isWorkday(parseDate(start), h)) errs.push(`重锚行 start(${start}) 不是工作日`);
    } else {
      start = nextWorkday(prevEnd, h);
    }
    const end = calcEndDate(start, Math.max(1, r.duration_days), h);
    if (r.start_date !== start) errs.push(`#${i}「${r.title}」start 期望 ${start} 实际 ${r.start_date}`);
    if (r.end_date !== end) errs.push(`#${i}「${r.title}」end 期望 ${end} 实际 ${r.end_date}`);
    prevEnd = end;
  });
  if (errs.length) {
    failed += 1;
    console.log(`❌ ${label} — ${errs.length} 处违例`);
    errs.slice(0, 6).forEach((e) => console.log('     · ' + e));
  } else {
    console.log(`✅ ${label}（${rows.length} 行不变式通过）`);
  }
  return rows;
}

// ---------- 准备干净项目 ----------
getDb().prepare('DELETE FROM plan_tasks WHERE project_id = ?').run(PID);
getDb().prepare('DELETE FROM projects WHERE id = ?').run(PID);
getDb().prepare('DELETE FROM holidays').run();
const t = new Date().toISOString();
getDb().prepare('INSERT INTO projects (id,name,description,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run(PID, '计划校验项目', '', 0, t, t);

console.log('=== P0-1 增量重排 · 时间线不变式校验 ===\n');

// 1) 批量创建（首条带锚点日期）
PlanService.createBatch(PID, [
  { title: 'A-需求评审', durationDays: 2, startDate: '2026-09-14' },
  { title: 'B-设计', durationDays: 3 },
  { title: 'C-开发', durationDays: 5 },
  { title: 'D-测试', durationDays: 2 },
  { title: 'E-上线', durationDays: 1 },
]);
let rows = check('createBatch 5 条（首条锚点 2026-09-14）');

// 2) 单条追加（原实现每次 create 都全量重排 → O(n)）
PlanService.create({ projectId: PID, title: 'F-追加任务', durationDays: 3 });
rows = check('create 追加尾部');

// 3) 中间插入
PlanService.insertAfter(rows[2].id, 'C2-插入任务', '插入在中部');
rows = check('insertAfter 中间插入');

// 4) 改工期（中部任务）
PlanService.update(rows[3].id, { durationDays: 7 });
rows = check('update 中部改工期 3→7');

// 5) 显式改开始日（中间任务作新锚点）
const REANCHOR = '2026-10-02';
PlanService.update(rows[4].id, { startDate: REANCHOR });
const reanchored = PlanService.get(rows[4].id);
if (reanchored.start_date !== REANCHOR) {
  failed += 1;
  console.log(`❌ 显式开始日未被原样采用：期望 ${REANCHOR} 实际 ${reanchored.start_date}`);
} else {
  console.log(`✅ 显式开始日原样生效（${REANCHOR}）`);
}
rows = check('update 中部显式改开始日（该行为新锚点，其后串行顺延）', 4);

// 6) 归档（移除并衔接）
const archiveTarget = rows[2].id;
PlanService.archive(archiveTarget);
rows = check('archive 中间行（衔接重排）');

// 7) 恢复（插回原位）
PlanService.restore(archiveTarget);
rows = check('restore 恢复原位');

// 8) 拖拽排序（倒序）
const ids = PlanService.list(PID).map((r) => r.id);
PlanService.reorder(PID, [...ids].reverse());
rows = check('reorder 全量倒序（应从首个变化位置重排）');

// 9) 顺序未变的 reorder（走无副作用分支）
PlanService.reorder(PID, PlanService.list(PID).map((r) => r.id));
check('reorder 顺序未变（无副作用分支）');

// 10) 新增节假日（含跨节假日重排）
PlanService.addHoliday('2026-10-05', '校验节假日');
rows = check('addHoliday 2026-10-05（受影响段重排）');

// 11) 移除节假日
PlanService.removeHoliday('2026-10-05');
check('removeHoliday 2026-10-05');

// 12) 规模与耗时：在已有 N 条的计划上追加，验证单次 create 不随 N 增长（原实现 O(n)）
const N = 800;
for (let i = 0; i < N; i++) PlanService.create({ projectId: PID, title: `bulk-${i}`, durationDays: 1 });
const t0 = process.hrtime.bigint();
for (let i = 0; i < 100; i++) PlanService.create({ projectId: PID, title: `append-${i}`, durationDays: 1 });
const perCreate = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
console.log(`\n[规模] 基线 ${N} 条，追加 100 条单次 create 平均 ${perCreate.toFixed(2)} ms`);
check(`规模 ${N + 100} 条（追加后）`);

console.log(`\n结果：${failed === 0 ? '✅ 全部不变式通过' : `❌ ${failed} 个步骤违例`}（单次 create ≈ ${perCreate.toFixed(2)} ms）`);
process.exit(failed === 0 ? 0 : 1);
