/**
 * PRD 导入质量 golden 回归基线（2026-11-18）。
 *
 * 背景：同一份 PRD 在低预算模型下曾从单轮 30K 输出截断回退到 8 片分片，
 * 每片各产一套完整 WBS，最终 147 需求 / 71 计划 / 10 里程碑 / 2 套 WBS / 8 项硬阻断。
 * P0/P1 已把普通 PRD 改为「单轮高预算 → 骨架模式」，P2 补分片路径的全局 WBS 折叠与同一收口。
 *
 * 本门守三件事：
 *   G1 多套标签族 WBS（P0-1…P1-5）经归一 + 折叠后收敛为单一 M1…M5；
 *   G2 分片/骨架共用 finalizePrdParseResult：P2/P3 被范围闸门剔除、normal 不超过 45、AC 全覆盖；
 *   G3 golden fixture（60 需求 / 5 里程碑 / 33 normal）在质量门下稳定为 ready，作为可重复基线。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/tests/verify-prd-parse-golden.mts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collapseRepeatedWbsGroups,
  detectWbsGroups,
  normalizeWbsGroups,
} from '../server/src/util/prdWbs';
import { finalizePrdParseResult } from '../server/src/services/PlanService';
import { evaluateImportReadiness, type QualityPlan, type QualityReq } from '../web/src/utils/prdQuality';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'prd-parse-golden.json');

let pass = 0;
let fail = 0;
const results: Array<{ ok: boolean; name: string; extra?: string }> = [];
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass += 1;
    results.push({ ok: true, name });
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    const detail = extra === undefined ? '' : ` :: ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}`;
    results.push({ ok: false, name, extra: detail });
    console.log(`FAIL ${name}${detail}`);
  }
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  requirements: Array<QualityReq & { content?: string }>;
  plans: QualityPlan[];
};
// finalize 会原地补需求/关联；每个用例用独立深拷贝，避免后续 G3 基线读到前序用例的变更。
const cloneFixture = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---------------------------------------------------------------------------
// G1：分片重复 WBS -> 单一 M1…M5
// ---------------------------------------------------------------------------
const chunkedPlans: QualityPlan[] = [];
const themes = ['架构设计与数据模型', '核心调度与适配实现', '派发入口与交互', '可观测与质量门', '验收与回归'];
const prefixSets = ['P0', 'P1'];
for (const [setIdx, prefix] of prefixSets.entries()) {
  for (let m = 1; m <= 5; m += 1) {
    chunkedPlans.push({
      title: `${prefix}-${m} ${themes[m - 1]}`,
      kind: 'milestone',
      wbsCode: `${prefix}-${m}`,
      parentCode: '',
      priority: 'P0',
      description: '阶段交付：完成该阶段全部子任务，接口与数据契约通过联调，质量门无新增阻断。',
    });
    for (let j = 1; j <= 3; j += 1) {
      chunkedPlans.push({
        title: `${prefix}-${m}.${j} 第${setIdx + 1}套交付物${m}-${j}`,
        kind: 'normal',
        wbsCode: `${prefix}-${m}.${j}`,
        parentCode: `${prefix}-${m}`,
        priority: j === 3 ? 'P1' : 'P0',
        description: `实现第${setIdx + 1}套第${m}-${j}项交付物：完成接口与数据契约，补充异常分支与回归用例；边界是不改动既有队列语义，完成定义是单测、API 冒烟与质量门全部通过。`,
        reqNos: [`FR-1.${((m - 1) * 3 + j)}`],
        acceptanceRefs: [`AC-${m}`],
      });
    }
  }
}
const preGroups = detectWbsGroups(chunkedPlans);
const normalized = normalizeWbsGroups(chunkedPlans);
const collapsed = collapseRepeatedWbsGroups(normalized.drafts, 6);
const postGroups = detectWbsGroups(collapsed.drafts);
const msCodes = new Set(collapsed.drafts.filter((d) => d.kind === 'milestone').map((d) => (d.wbsCode ?? '').trim()));
const normals = collapsed.drafts.filter((d) => d.kind !== 'milestone');
check('G1 输入被识别为多套 WBS', preGroups.groups > 1, { groups: preGroups.groups, families: preGroups.families });
check('G1 归一 + 折叠后里程碑=5', collapsed.milestones === 5, { milestones: collapsed.milestones, collapsed: collapsed.collapsedMilestones });
check('G1 折叠后只剩一套 WBS', postGroups.groups === 1, { groups: postGroups.groups });
check('G1 每条 normal 都挂到存在的里程碑', normals.every((d) => msCodes.has((d.parentCode ?? '').trim())), {
  missing: normals.filter((d) => !msCodes.has((d.parentCode ?? '').trim())).map((d) => d.title).slice(0, 3),
});
check('G1 normal 编号连续为 Mx.y', normals.every((d) => /^M\d+\.\d+\s/.test(d.title)), {
  sample: normals.slice(0, 3).map((d) => d.title),
});

// G1b：骨架路径不经过分片合并，也必须由 finalize 统一归一/折叠（实测模型会输出两套 WBS）。
const skeletonInput = chunkedPlans.map((p) => ({ ...p, reqNos: p.reqNos ?? [], acceptanceRefs: p.acceptanceRefs ?? [] }));
const skeletonFinal = finalizePrdParseResult(cloneFixture(fixture.requirements), cloneFixture(skeletonInput), '');
check('G1b 骨架收口后只剩一套 WBS', skeletonFinal.wbsGroups === 1, { groups: skeletonFinal.wbsGroups });
check('G1b 骨架收口后里程碑=5', skeletonFinal.drafts.filter((d) => d.kind === 'milestone').length === 5, {
  milestones: skeletonFinal.drafts.filter((d) => d.kind === 'milestone').length,
});

// ---------------------------------------------------------------------------
// G2：finalize 共用收口——P2/P3 不进入本期、AC 全覆盖、normal ≤45
// ---------------------------------------------------------------------------
const p2Plans: QualityPlan[] = [
  ...fixture.plans,
  ...Array.from({ length: 8 }, (_, i) => ({
    title: `M5.${i + 1} P2 后续批次能力 ${i + 1}`,
    kind: 'normal',
    wbsCode: `M5.${i + 1}`,
    parentCode: 'M5',
    priority: 'P2',
    description: '后续批次能力：本项不进入九期排期，仅保留在需求矩阵，待十期再评估实现。'.repeat(2),
    reqNos: [`FR-1.${i + 1}`],
  })),
];
const finalized = finalizePrdParseResult(cloneFixture(fixture.requirements), cloneFixture(p2Plans), '');
const finalNormals = finalized.drafts.filter((d) => d.kind !== 'milestone');
check('G2 分片收口剔除 P2/P3', finalNormals.every((d) => !/p[23]/i.test(d.priority ?? '')), {
  p2: finalNormals.filter((d) => /p[23]/i.test(d.priority ?? '')).map((d) => d.title).slice(0, 3),
});
check('G2 normal 不超过 45', finalNormals.length <= 45, { normals: finalNormals.length });
check('G2 收口后仍为单一 WBS', finalized.wbsGroups === 1, { groups: finalized.wbsGroups });
check('G2 AC 全部有任务承接', (() => {
  const mapped = new Set<string>();
  for (const p of finalized.drafts) {
    for (const r of p.reqNos ?? []) mapped.add(r);
    for (const r of p.acceptanceRefs ?? []) mapped.add(r);
  }
  const acs = fixture.requirements.filter((r) => r.type === 'AC');
  return acs.every((r) => !!r.reqNo && mapped.has(r.reqNo));
})(), { acs: fixture.requirements.filter((r) => r.type === 'AC').map((r) => r.reqNo) });

// G2b：模型把 AC 写成 REQ-xxx + type=AC（不是原文 AC-xx），且原文抽不到 AC 标题时，
// ensurePrdAcceptanceCoverage 也必须从需求矩阵识别并映射，不能留下未映射 AC。
const reqNoAcs = [
  ...fixture.requirements,
  { reqNo: 'REQ-900', title: '验收标准：分片结果必须单一 WBS', type: 'AC', priority: 'P1', sourceRef: '验收标准', content: 'Given 分片合并，When 质量门执行，Then 无未映射 AC。' },
];
const plansWithoutAcRefs = fixture.plans.map((p) => ({ ...p, acceptanceRefs: [] as string[] }));
const acFinal = finalizePrdParseResult(cloneFixture(reqNoAcs), cloneFixture(plansWithoutAcRefs), '');
check('G2b REQ 编号 AC 也被映射', acFinal.drafts.some((p) => [...(p.reqNos ?? []), ...(p.acceptanceRefs ?? [])].includes('REQ-900')), {
  mapped: acFinal.drafts.filter((p) => [...(p.reqNos ?? []), ...(p.acceptanceRefs ?? [])].includes('REQ-900')).map((p) => p.title),
});

// ---------------------------------------------------------------------------
// G3：golden fixture 质量门基线
// ---------------------------------------------------------------------------
const gate = evaluateImportReadiness(fixture.requirements, fixture.plans);
check('G3 golden 基线为 ready', gate.readiness === 'ready', { readiness: gate.readiness, errors: gate.errors, warnings: gate.warnings });
check('G3 golden 无硬阻断', gate.errors.length === 0, { errors: gate.errors });
check('G3 golden 里程碑=5 / normal=33', fixture.plans.filter((p) => p.kind === 'milestone').length === 5
  && fixture.plans.filter((p) => p.kind === 'normal').length === 33, {
  milestones: fixture.plans.filter((p) => p.kind === 'milestone').length,
  normals: fixture.plans.filter((p) => p.kind === 'normal').length,
});
check('G3 golden 单一 WBS', detectWbsGroups(fixture.plans).groups === 1, { groups: detectWbsGroups(fixture.plans).groups });

console.log(`\nPRD 导入质量 golden 基线：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);

