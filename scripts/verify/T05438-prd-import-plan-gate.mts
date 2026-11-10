/*
 * T05438 门：PRD 导入规划结构修复（P0-1 多套 WBS 归一 / P0-2 里程碑工期口径）。
 *
 * 背景（T05206 复检实测）：BEMP审批与利率改造 一次导入产出 140 需求 / 146 计划，
 * 其中 19 个里程碑分属 5 套并行 WBS（章号 1.1 出现 5 次），18/19 个里程碑工期 ≠ 子项合计
 * （M6 写 4 天、24 个子项合计 51 天）。
 *
 * 本门：
 *  A 组 用 5 套夹具实跑 `normalizeWbs`，断言「检测到 5 套 → 归一到 1 套、后 4 套整段取消勾选」；
 *  B 组 源码锚：切分判据与 detect 一致、工期取 max(包络, 子项和) 且 end 同步、payload 按 include 过滤。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T05438-prd-import-plan-gate.mts
 * 无需后端、无需浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectWbsGroups, normalizeWbs, splitWbsGroupRanges, type QualityPlan } from '../../web/src/utils/prdQuality';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 5 套 WBS，每套 2 里程碑 + 2 明细，章号各自从 1 起（与分片各产一套的形状一致） */
function fixture(groups: number): QualityPlan[] {
  const out: QualityPlan[] = [];
  const suffix = ['一', '二', '三', '四', '五', '六', '七', '八'];
  for (let g = 0; g < groups; g += 1) {
    out.push({ title: `1 阶段A${suffix[g]}`, kind: 'milestone', durationDays: 2, include: true });
    out.push({ title: `1.1 明细A${suffix[g]}`, kind: 'normal', durationDays: 1, include: true });
    out.push({ title: `2 阶段B${suffix[g]}`, kind: 'milestone', durationDays: 2, include: true });
    out.push({ title: `2.1 明细B${suffix[g]}`, kind: 'normal', durationDays: 1, include: true });
  }
  return out;
}

console.log('—— A 组 · 多套 WBS 归一（行为） ——');
const one = fixture(1);
ok('A-01 单套夹具不会被误切（groups=1、零取消）',
  detectWbsGroups(one).groups === 1 && splitWbsGroupRanges(one).length === 1
  && normalizeWbs(one).disabledRows === 0,
  JSON.stringify({ groups: detectWbsGroups(one).groups, ranges: splitWbsGroupRanges(one).length }));

const five = fixture(5);
const ranges5 = splitWbsGroupRanges(five);
const n5 = normalizeWbs(five);
ok('A-02 5 套夹具被识别为 5 套 / 切出 5 段（判据与 detectWbsGroups 一致）',
  detectWbsGroups(five).groups === 5 && ranges5.length === 5,
  JSON.stringify({ groups: detectWbsGroups(five).groups, ranges: ranges5.length }));
ok('A-03 归一到 1 套：后 4 套整段取消勾选（16 行），第一套 4 行保留',
  n5.groupsBefore === 5 && n5.groupsAfter === 1 && n5.disabledRows === 16
  && n5.plans.filter((p) => p.include !== false).length === 4,
  JSON.stringify({ before: n5.groupsBefore, after: n5.groupsAfter, disabled: n5.disabledRows }));
ok('A-04 保留的正是第一套（标题后缀「一」），后续套被勾掉',
  n5.plans.filter((p) => p.include !== false).every((p) => p.title.includes('一')));
ok('A-05 行没有被删除，只是取消勾选（可勾回）',
  n5.plans.length === five.length, `rows=${n5.plans.length}`);
ok('A-06 里程碑重编号 M1…Mn 连续',
  (() => {
    const ms = n5.plans.filter((p) => p.kind === 'milestone' && p.include !== false);
    return ms.every((p, i) => (p.title ?? '').startsWith(`M${i + 1} `));
  })(), JSON.stringify(n5.plans.filter((p) => p.kind === 'milestone' && p.include !== false).map((p) => p.title)));
ok('A-07 工期按子项和重算（第一套每个里程碑 = 1 天明细，故工期 1）',
  n5.plans.filter((p) => p.kind === 'milestone' && p.include !== false).every((p) => p.durationDays === 1),
  JSON.stringify(n5.plans.filter((p) => p.kind === 'milestone' && p.include !== false).map((p) => p.durationDays)));

console.log('—— B 组 · 源码锚（口径与接线） ——');
const quality = src('web/src/utils/prdQuality.ts');
const svc = src('server/src/services/PlanService.ts');
const panel = src('web/src/pages/PrdImportPanel.tsx');
ok('B-01 normalizeWbs 真的调用 splitWbsGroupRanges 并按套取消勾选',
  /const ranges = splitWbsGroupRanges\(out\);/.test(quality) && /ranges\.slice\(1\)/.test(quality));
ok('B-02 切分判据与 detectWbsGroups 同源（章号 n <= prev 视为新套）',
  /if \(k > 0 && n >= 0 && prev >= 0 && n <= prev\) groupStartMs\.push\(k\);/.test(quality));
ok('B-03 归一后指标只统计仍勾选的行（否则取消的套继续计入）',
  /groupsAfter: detectWbsGroups\(out\.filter\(\(p\) => p\.include !== false\)\)\.groups/.test(quality));
ok('B-04 里程碑工期取 max(日历包络, 子项工期之和)，不再被包络单方向覆盖',
  /const duration = Math\.max\(envelope, sumKids\);/.test(svc) && /const envelope = workdaysInRange\(start, end, cal\);/.test(svc));
ok('B-05 工期取到子项和时 end 同步推移（避免「工期 51 / 跨度 4」自相矛盾）',
  /const endFinal = duration > envelope \? calcEndDate\(start, duration, cal\) : end;/.test(svc));
ok('B-06 子项查询带上 duration_days（否则算不出子项和）',
  /SELECT start_date, end_date, duration_days, deps FROM plan_tasks/.test(svc));
ok('B-07 导入 payload 按 include 过滤（取消勾选的套真的不会进库）',
  /const pl = plans\.filter\(\(x\) => x\.include && x\.title\.trim\(\)\);/.test(panel));
ok('B-08 前端提示改成「保留第一套、其余套取消勾选」',
  /保留第一套、其余套取消勾选 \$\{n\.disabledRows\} 条/.test(panel));

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
