import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FILE_INPUT_SR_ONLY } from '../ui/fileInput'; // T01674：file input 视觉隐藏但保留键盘焦点
import { api } from '../api/client';
import { Eye, FileUp, Save, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useSessionState } from '../ui/session';
import { ProjectListHint, projectListPlaceholder, useProjectList } from '../ui/projectList';
import { CopyButton } from '../ui/CopyButton';
import { EXPORT_MIME, saveBlob } from '../utils/download';
import { aiImportStore } from '../stores/aiImportStore';
// 2026-11-10 质量复核优化：导入前质量自检（纯函数，只读分析 + 用户确认后才归一化）
import {
  analyzeImportQuality, disableConstraintReqs, formatQualitySummary, isConstraintReq, isGapFillPlan,
  normalizeWbs, type QualitySource, type QualitySummary,
} from '../utils/prdQuality';

/** T00662：PRD 解析结果（需求项 + WBS 计划草稿） */
interface PrdReq { reqNo: string; title: string; content: string; sourceRef: string; priority: string; include: boolean; key: string; /** T04064：来源文件下标（= prdDocs 下标），导入时据此回填 prd_id */ sourceIndex?: number; }
/** T01001：kind 可选——AI 解析出的里程碑/普通任务类型（后端可能未返回时缺省），编辑也是普通任务 */
interface PrdPlan { title: string; description: string; durationDays: number; reqNos: string[]; kind?: 'milestone' | 'normal' | 'daily'; include: boolean; key: string; }

/**
 * T01001 二轮：里程碑工期 = 其下明细任务工期之和。
 * 口径与项目管理页「里程碑汇总」一致：本里程碑之后、下一个里程碑之前的非里程碑行即其明细；
 * 只统计勾选（include）的明细，正好等于最终会导入的那些行（未勾选不入计划表）。
 * 里程碑自身工期不可手工调整，改任一明细即联动重算——修复「M1 工期 4、子任务合计 5 不相等」。
 */
function isMilestoneRow(p: Pick<PrdPlan, 'kind'>): boolean {
  return p.kind === 'milestone';
}

/** 重算全部里程碑工期（返回新数组；无明细的里程碑保留原值） */
function recalcMilestoneDurations(list: PrdPlan[]): PrdPlan[] {
  const out = list.map((p) => ({ ...p }));
  for (let i = 0; i < out.length; i++) {
    if (!isMilestoneRow(out[i])) continue;
    let sum = 0;
    for (let j = i + 1; j < out.length; j++) {
      if (isMilestoneRow(out[j])) break;
      // 2026-11-10 质量复核优化⑥：系统补齐占位行不计入里程碑工期（与服务端 child 归属口径一致）
      if (out[j].include && !isGapFillPlan(out[j])) sum += Math.max(1, Math.round(Number(out[j].durationDays) || 1));
    }
    if (sum > 0) out[i] = { ...out[i], durationDays: sum };
  }
  return out;
}

/** /plans/import-prd 响应（S3776：doImport 的结果播报分支抽为 logImportResult，字段口径与原文案一字未改） */
interface ImportPrdResult {
  requirements: number; plans: number; tasks: number;
  unlinkedReqNos?: string[]; prdId?: string;
  reqNoMap?: Array<{ from: string; to: string }>;
  dupPlanTitles?: Array<{ title: string; existing: number; renamedTo?: string; reusedPlanId?: string }>;
  reusedPlans?: number; ambiguousReqNos?: string[];
  orphanRequirements?: Array<{ reqNo: string; title: string }>;
  /** T02303 甲：payload 条数之外，本次「真新建」与「复用存量」的需求行数 */
  requirementsCreated?: number; reusedRequirements?: number;
}

/** T02300：/plans/import-prd/preview 响应（只读预演，字段口径与 importPrd 同源） */
interface PrdPreviewResult {
  willCreatePlans: number; willReusePlans: number; willRenamePlans: number;
  dupPlanTitles: Array<{ title: string; existing: number; renamedTo?: string; reusedPlanId?: string }>;
  requirements: number; willCreateReqs: number; willReuseReqs: number;
  reqNoMap: Array<{ from: string; to: string }>;
  ambiguousReqNos: string[]; unlinkedReqNos: string[];
  orphanRequirements: Array<{ reqNo: string; title: string }>;
  prdDoc: { action: 'none' | 'reuse' | 'create'; id?: string; by?: 'hash' | 'name' };
  planRowsPreview: Array<{ title: string; reuseId: string | null }>;
  /** 2026-11-10 质量复核优化①：每份来源文档被需求行引用的条数（零引用＝该文档未参与生成） */
  docReferences?: Array<{ filename: string; docKind: 'prd' | 'design' | 'test'; reqCount: number }>;
  createTasks: boolean;
  readOnly: true;
}

/**
 * T02300：预演结果播报。放在导入按钮之前，让用户点「导入」**前**就看到连带影响——
 * T01869 的原始症状（重导后两行同名、一行被读成待办/0）之所以被误判成「原有计划被回档」，
 * 正是因为导入前的连带影响完全不可见。文案必须写清两条事实（实测口径）：
 * ① 存量矩阵/计划行不会被删除或改写（importPrd 全文零 DELETE）；
 * ② reuse 模式下「同标题 + 同内容」的需求行会被复用（T02303 甲），只有内容变化的才新建并顺延编号。
 */
/** T02300：预演——PRD 原文的处置说明（复用 / 新建 / 不落文档） */
function previewDocPart(p: PrdPreviewResult): string {
  const byName = p.prdDoc.by === 'hash' ? '同内容' : '同文件名';
  if (p.prdDoc.action === 'reuse') return `PRD 原文命中存量文档（按${byName}复用并覆盖其正文，不新建）`;
  if (p.prdDoc.action === 'create') return 'PRD 原文将新建一条文档记录';
  return '本次未带 PRD 正文，不落文档';
}

/** 预演——撞名计划让号/同名复用的预告 */
function logPreviewDupPlans(list: ReadonlyArray<{ title: string; renamedTo?: string; reusedPlanId?: string }>): void {
  const renamed = list.filter((x) => x.renamedTo);
  const reused = list.filter((x) => x.reusedPlanId);
  if (renamed.length) {
    const renamedPairs = renamed.slice(0, 8).map((x) => `${x.title}→「${x.renamedTo}」`).join('、');
    aiImportStore.log(`同名计划让号预告：${renamed.length} 个标题在项目内已存在（${renamedPairs}${renamed.length > 8 ? ' 等' : ''}），原行不变、新行带后缀`, 'info');
  }
  if (reused.length) aiImportStore.log(`同名计划复用预告：${reused.length} 个标题命中存量同名行，将补写到原行（status/progress 一字不动）`, 'info');
}

/** 预演——需求编号让号预告 */
function logPreviewReqNoMap(list: ReadonlyArray<{ from: string; to: string }>): void {
  const pairs = list.slice(0, 12).map((x) => `${x.from}→${x.to}`).join('、');
  aiImportStore.log(`编号让号预告：${list.length} 条需求编号会与矩阵已有编号冲突，将改为项目内顺延号（${pairs}${list.length > 12 ? ' 等' : ''}）`, 'info');
}

function logPreviewResult(p: PrdPreviewResult): void {
  aiImportStore.log(
    `预演结果（只读，未改动任何数据）：需求 新建 ${p.willCreateReqs} 条 / 复用同标题同内容存量 ${p.willReuseReqs} 条；`
    + `计划 新建 ${p.willCreatePlans} 条（其中撞名让号 ${p.willRenamePlans} 条）/ 复用同名存量 ${p.willReusePlans} 条；${previewDocPart(p)}`
    + `${p.createTasks ? '；已勾选同步生成待办（只给新建的计划行派生待办）' : ''}`,
    'info',
  );
  aiImportStore.log('预演补充：以上计数不改存量行——导入只新增/补写，既有需求与计划的状态、进度、编号一律不被删除或改写', 'info');
  if (p.willReuseReqs) {
    aiImportStore.log(`需求侧复用：${p.willReuseReqs} 条与存量「同标题且同内容」的需求行命中，将复用原行不新建（内容有一字之差即视为新行）`, 'info');
  }
  if (p.reqNoMap?.length) logPreviewReqNoMap(p.reqNoMap);
  if (p.dupPlanTitles?.length) logPreviewDupPlans(p.dupPlanTitles);
  if (p.unlinkedReqNos?.length) {
    aiImportStore.log(`预演告警：${p.unlinkedReqNos.length} 个需求编号在本次导入里找不到对应需求行（${p.unlinkedReqNos.join('、')}），其计划/待办关联将被忽略——请核对编号或先补导对应需求`, 'error');
  }
  if (p.ambiguousReqNos?.length) {
    aiImportStore.log(`预演告警：${p.ambiguousReqNos.length} 个需求编号在本次 payload 的多个来源里重复（${p.ambiguousReqNos.join('、')}），关联只会挂到其中一行——多来源导入请先全局重排编号`, 'error');
  }
  if (p.orphanRequirements?.length) {
    const names = p.orphanRequirements.slice(0, 12).map((x) => x.reqNo).join('、');
    const more = p.orphanRequirements.length > 12 ? ' 等' : '';
    aiImportStore.log(`预演提醒：本次要新建的 ${p.orphanRequirements.length} 条需求没有任何计划/待办引用（${names}${more}）`, 'info');
  }
  // 2026-11-10 质量复核优化①：逐份来源文档的引用数，暴露「只归档但被误认为参与了生成」的文档
  for (const d of p.docReferences ?? []) {
    if (d.reqCount > 0) continue;
    const role = d.docKind === 'prd' ? 'PRD' : d.docKind === 'design' ? '设计文档' : '测试用例';
    aiImportStore.log(`预演提醒：${role}「${d.filename}」被 0 条需求引用——${d.docKind === 'prd'
      ? '该来源文档未产出任何需求，请确认是否漏选/漏解析'
      : '关联文档按设计仅归档、不参与 AI 解析；若期望其内容进入 WBS，需作为 PRD 文件参与解析'}`, 'info');
  }
}

/** 导入结果明细播报（自 doImport 逐字搬出，判定顺序与日志级别不变） */
function logImportResult(r: ImportPrdResult): void {
  const taskPart = r.tasks ? `、待办任务 ${r.tasks} 条` : '';
  const prdPart = r.prdId ? '；源 PRD 已录入「PRD 管理」并关联本次需求矩阵记录' : '';
  const reusedPart = r.reusedPlans ? `（另复用同名计划 ${r.reusedPlans} 条）` : '';
  aiImportStore.log(`导入完成：需求 ${r.requirements} 条（已入需求跟踪矩阵）、新建计划 ${r.plans} 条${reusedPart}${taskPart}${prdPart}`, 'ok');
  // T02303 甲（文案随 T02300 同步）：reuse 口径下需求侧不再「整批新建」——同标题同内容的存量行会被复用，
  // 旧说法「需求行全部按新号新建」已不成立，按实回传的两条计数说清，否则用户看不出补写到底幂等了没有
  if (r.reusedRequirements) {
    aiImportStore.log(`需求侧复用：${r.reusedRequirements} 条命中存量「同标题且同内容」的需求行，已复用原行未新建（本次真新建 ${r.requirementsCreated ?? r.requirements - r.reusedRequirements} 条，原行状态/编号一字未动）`, 'info');
  }
  // T01867：与项目已有编号撞号的需求由服务端按最大编号顺延，明细必须可见——
  // 用户手里拿的是 PRD 原编号，静默改号会让后续按编号核对全部对不上
  if (r.reqNoMap?.length) {
    const reqNoPairs = r.reqNoMap.map((x) => `${x.from}→${x.to}`).join('、');
    aiImportStore.log(`编号顺延：${r.reqNoMap.length} 条需求与矩阵已有编号重复，已改为项目内顺延号（${reqNoPairs}），计划/待办关联按顺延后的编号建立`, 'error');
  }
  // T01869→T01875：撞名计划的新行落库时已带「（N）」区分后缀，不再是与原行无法分辨的同名行；
  // 明细点名哪个原号让成了哪个新标题，消除「原有任务被重置」的误读面
  if (r.dupPlanTitles?.length) {
    const renamed = r.dupPlanTitles.filter((x) => x.renamedTo);
    if (renamed.length) {
      const renamedDetail = renamed.map((x) => `${x.title} → 新行「${x.renamedTo}」，原有 ${x.existing} 条`).join('、');
      aiImportStore.log(`同名让号：本次有 ${renamed.length} 个计划标题在项目内已存在（${renamedDetail}）——原条目状态与进度一字未动，新增那条用后缀区分，不会与原计划混淆`, 'info');
    }
    if (r.reusedPlans) {
      aiImportStore.log(`同名复用：${r.reusedPlans} 条计划命中项目内已有同名行（未新建），仅补齐空描述/空复杂度与需求关联（只增不减），其状态与进度保持不变`, 'info');
    }
  }
  // T00712（D-5）：无效需求编号不再静默丢弃——服务端返回 unlinkedReqNos 时在控制台给出可感知告警
  if (r.unlinkedReqNos?.length) {
    aiImportStore.log(`告警：${r.unlinkedReqNos.length} 个需求编号未命中本次导入的需求（${r.unlinkedReqNos.join('、')}），其计划/待办关联已被忽略，请核对编号或先补导对应需求`, 'error');
  }
  // T01995：跨来源编号歧义——同一旧编号被本次导入的两行争用（多份 PRD 各自从 REQ-001 起号且调用方未重编号）。
  // 关联口径沿用既有「后登记者胜出」，所以先出现那份来源的行会整批零关联——必须当场点名，不能静默放过
  if (r.ambiguousReqNos?.length) {
    aiImportStore.log(`编号歧义：${r.ambiguousReqNos.length} 个需求编号在本次导入的多个来源中重复出现（${r.ambiguousReqNos.join('、')}），这些编号的计划/待办只挂到了其中一行（按最后出现的来源建立），先出现那份来源的行会整批零关联——多来源导入请确认各文件的需求编号已全局重排为连续号（REQ-001…）后再导入`, 'error');
  }
  // T01995：本次新建却零关联的需求行——错挂类缺陷的可见性补丁（编号存在性校验对此完全无感）。
  // 与解析阶段的「反向覆盖告警」同源，故用 info 级：需求本就无对应计划是合法场景，不能变成狼来了
  if (r.orphanRequirements?.length) {
    aiImportStore.log(`零关联提醒：本次新建的 ${r.orphanRequirements.length} 条需求没有任何计划/待办关联（${r.orphanRequirements.slice(0, 12).map((x) => x.reqNo).join('、')}${r.orphanRequirements.length > 12 ? ' 等' : ''}）——若为多来源合并导入，请核对是否把关联挂到了别的来源的行上`, 'info');
  }
}

/**
 * T03700+：覆盖缺口播报——基于合并重排后的最终编号，且必须带标题：编号是位置号，
 * 同一份文档每次解析都会重排，只报编号会让用户误以为「每次缺的都不一样」。
 */
function logUncoveredReqs(list: ReadonlyArray<{ reqNo: string; title: string }>): void {
  if (list.length === 0) return;
  const names = list.slice(0, 8).map((r) => `${r.reqNo}《${r.title.slice(0, 16)}》`).join('、');
  const more = list.length > 8 ? ' 等' : '';
  aiImportStore.log(
    `⚠ 有 ${list.length} 条需求暂未被任何 WBS 计划关联（${names}${more}）——这些需求当前不可追溯；`
    + '可在面板「未被任何计划关联」处点「补齐计划」自动生成一行，或在矩阵面板手动关联（编号每次解析会按出现顺序重排，跨次比对请以标题为准）',
    'error',
  );
}

/**
 * T03700+：系统自动补齐播报——服务端会为未被任何计划关联的需求各生成一行 normal 任务
 * （description 以「自动补齐：」开头），必须让用户知道这些行不是 AI 拆出来的，可改标题或取消勾选。
 */
function logAutoFilled(rows: ReadonlyArray<{ title: string; description?: string }>): void {
  const auto = rows.filter((p) => (p.description ?? '').startsWith('自动补齐：'));
  if (auto.length === 0) return;
  const names = auto.slice(0, 8).map((p) => `「${p.title.slice(0, 24)}」`).join('、') + (auto.length > 8 ? ' 等' : '');
  aiImportStore.log(
    `已自动补齐 ${auto.length} 条未被任何 WBS 计划关联的需求（${names}）——系统按最终编号各生成一行 normal 任务；可在计划表改标题或取消勾选，无需追溯时也可直接不导入该行`,
    'ok',
  );
}

/**
 * 2026-11-10 质量复核优化④/⑤/⑦：把「导入前质量自检」摊到控制台。
 * 只播报、不改数据——所有处置都由用户显式点按钮或编辑表格完成。
 */
function logQualityWarnings(s: QualitySummary): void {
  const severe = s.wbsGroups > 1 || s.constraintReqs > 0 || s.versionConflicts > 0 || s.durationIssues > 0;
  aiImportStore.log(formatQualitySummary(s), severe ? 'error' : 'info');
  if (s.wbsGroups > 1) {
    aiImportStore.log(`⚠ 检测到 ${s.wbsGroups} 套并行 WBS（分片各自产出完整里程碑后直接拼接）——建议导入前点「合并重复 WBS」统一编号；否则同一业务模块会重复排期`, 'error');
  }
  if (s.constraintReqs > 0) {
    aiImportStore.log(`⚠ ${s.constraintReqs} 条需求命中「不新增/不改造/已闭环/废止」等否定口径——这类是约束或验收项，不应作为待开发需求排期，可用「取消勾选否定口径」批量排除`, 'error');
  }
  if (s.versionConflicts > 0) {
    const brief = s.conflicts.slice(0, 6).map((c) => `${c.id}（${c.states.map((x) => x.doc).join(' ↔ ')}）`).join('、');
    aiImportStore.log(`⚠ 跨文档版本冲突 ${s.versionConflicts} 项：${brief}${s.versionConflicts > 6 ? ' 等' : ''}——同一编号在不同来源里「待确认」与「已确认」并存，请人工裁定基线版本后再导入`, 'error');
  }
  if (s.durationIssues > 0) {
    aiImportStore.log(`⚠ ${s.durationIssues} 个里程碑工期 ≠ 其下明细之和（例：${s.durationDetails.slice(0, 2).map((d) => `${d.title} ${d.declared}天/${d.computed}天`).join('、')}）——导入前可点「合并重复 WBS」重算`, 'error');
  }
  if (s.coverageGaps > 0) {
    const gaps = s.coverage.filter((g) => g.missing.length > 0).map((g) => `${g.label} ${g.covered}/${g.total}`).join('、');
    aiImportStore.log(`源文档条目覆盖自检：${gaps}；共 ${s.coverageGaps} 个编号未出现在解析结果中，可能是「需求级」内容，请人工确认是否需补计划`, 'info');
  }
  if (s.docCounts.design === 0 && s.docCounts.test === 0 && s.docCounts.prd > 0) {
    aiImportStore.log('提示：本次没有关联设计/测试文档。如需归档配套方案设计，请在「关联设计/测试文档」添加；该类文档按设计只归档、不参与 AI 解析，若期望其实现细节进入 WBS，需作为 PRD 文件参与解析', 'info');
  }
}

/**
 * 2026-11-10 质量复核优化⑧：把质量检查报告做成「导入附加产物」——只读 Markdown，随用户下载。
 * 与 tmp/质量检查报告-BEMP审批-PRD导入-20261110.md 的检查项同口径，便于逐次回归对照。
 */
function formatQualityReport(s: QualitySummary, baseline: string, sources: QualitySource[]): string {
  const lines: string[] = [
    '# PRD 导入质量自检报告',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 版本基线（唯一需求依据）：${baseline.trim() || '**未裁定**'}`,
    `- 来源文档：${sources.map((x) => `${x.name}［${x.role === 'prd' ? 'PRD·参与解析' : x.role === 'design' ? '设计·只归档' : '测试·只归档'}］`).join('、') || '（无）'}`,
    `- 检查方式：前端只读分析（未改写源文档、未改写数据库）`,
    '',
    '## 一、总体结论',
    '',
    (s.wbsGroups > 1 || s.versionConflicts > 0 || s.durationIssues > 0 || s.constraintReqs > 0 || s.coverageGaps > 0)
      ? '**需复核后导入**：存在并行 WBS / 版本冲突 / 工期不符 / 否定口径 / 覆盖缺口，详见下表。'
      : '**通过**：未检测到结构性偏差；推定字段与业务判定仍需人工复核。',
    '',
    formatQualitySummary(s),
    '',
    '## 二、检查项',
    '',
    '| 检查项 | 数值 | 说明 |',
    '|---|---:|---|',
    `| 并行 WBS 套数 | ${s.wbsGroups} | >1 表示分片各自产出了完整里程碑体系 |`,
    `| 同题重复计划 | ${s.duplicateGroups} 组 / ${s.duplicateRows} 行 | 归一化标题相同 |`,
    `| 自动补齐占位行 | ${s.gapFillRows} | 无业务语义，不归属里程碑 |`,
    `| 里程碑工期不符 | ${s.durationIssues} | 声明工期 ≠ 其下明细之和 |`,
    `| 否定/已闭环口径 | ${s.constraintReqs} | 约束项，不应作待开发需求 |`,
    `| 溯源未标注 | ${s.unattributedReqs} | sourceRef 非章节/Q 编号格式 |`,
    `| 跨文档版本冲突 | ${s.versionConflicts} | 同编号状态相反 |`,
    `| 源文档覆盖缺口 | ${s.coverageGaps} | 章节/Q/S/D/R/T/N/O 编号未出现在解析结果 |`,
    `| 推定字段行 | ${s.inferredFieldRows} | 工期/复杂度/优先级/排期源文档均无依据 |`,
    '',
    '## 三、跨文档版本冲突',
    '',
  ];
  if (s.conflicts.length === 0) lines.push('（无）', '');
  else {
    lines.push('| 编号 | 来源文档 | 状态 | 原文片段 |', '|---|---|---|---|');
    for (const c of s.conflicts) {
      for (const st of c.states) {
        lines.push(`| ${c.id} | ${st.doc} | ${st.state === 'pending' ? '待确认' : '已确认'} | ${st.excerpt.replace(/\|/g, '\\|').slice(0, 100)} |`);
      }
    }
    lines.push('');
  }
  lines.push('## 四、源文档条目覆盖', '', '| 类别 | 覆盖/总数 | 缺口编号 |', '|---|---|---|');
  for (const g of s.coverage) {
    lines.push(`| ${g.label} | ${g.covered}/${g.total} | ${g.missing.slice(0, 40).join('、') || '—'}${g.missing.length > 40 ? ` 等 ${g.missing.length} 项` : ''} |`);
  }
  lines.push('', '## 五、里程碑工期不符', '');
  if (s.durationDetails.length === 0) lines.push('（无）', '');
  else {
    lines.push('| 里程碑 | 声明工期 | 明细合计 | 子项数 |', '|---|---:|---:|---:|');
    for (const d of s.durationDetails.slice(0, 40)) lines.push(`| ${d.title} | ${d.declared} | ${d.computed} | ${d.children} |`);
    lines.push('');
  }
  lines.push('## 六、同题重复计划（示例）', '');
  lines.push(...(s.duplicateExamples.length ? s.duplicateExamples.map((x) => `- ${x}`) : ['（无）']), '');
  lines.push(
    '## 七、处置建议',
    '',
    '1. 多套 WBS → 点「合并重复 WBS」统一 M1…Mn（只取消勾选重复行，不删行）。',
    '2. 否定/已闭环口径 → 点「取消勾选否定口径」，或逐条改标为约束/验收项。',
    '3. 版本冲突 → 在面板指定「唯一需求依据」后，逐条复核冲突编号的基线状态。',
    '4. 覆盖缺口 → 确认是「需求级内容」还是需补计划；关联设计/测试文档按设计只归档、不参与 AI 解析。',
    '5. 工期不符 / 占位行 → 归一化后仍不符的，人工调整明细工期；占位行改为有业务语义的任务或取消勾选。',
    '6. 推定字段（工期/复杂度/优先级/排期）→ 源文档无依据，导入后人工排期并标注为推定值。',
    '',
    '---',
    '',
    '*本报告由导入面板只读生成，未对源文档或已生成数据做任何修改。*',
  );
  return lines.join('\n') + '\n';
}

/** 小指标块（主题色走 CSS 变量，暗色主题同样可读） */
function QualityMetric({ label, value, bad, hint }: {
  readonly label: string; readonly value: string | number; readonly bad: boolean; readonly hint: string;
}) {
  return (
    <span title={hint} style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px', whiteSpace: 'nowrap' }}>
      {label}{' '}
      <strong style={{ color: bad ? 'var(--danger)' : 'var(--text)' }}>{value}</strong>
    </span>
  );
}

/** 2026-11-10 质量复核优化①③⑤⑦：预演增强卡片——所有数值只读，处置必须用户显式点按钮 */
function QualityCard({ s, sources, baselineDoc, onBaseline, previewDocRefs, busy, onNormalize, onDisable, onRefresh, onExport }: {
  readonly s: QualitySummary;
  readonly sources: QualitySource[];
  readonly baselineDoc: string;
  readonly onBaseline: (v: string) => void;
  readonly previewDocRefs: NonNullable<PrdPreviewResult['docReferences']>;
  readonly busy: boolean;
  readonly onNormalize: () => void;
  readonly onDisable: () => void;
  readonly onRefresh: () => void;
  readonly onExport: () => void;
}) {
  const severe = s.wbsGroups > 1 || s.versionConflicts > 0 || s.durationIssues > 0 || s.constraintReqs > 0;
  const prdNames = sources.filter((x) => (x.role ?? 'prd') === 'prd').map((x) => x.name);
  const gapGroups = s.coverage.filter((g) => g.missing.length > 0);
  return (
    <div data-qc="import-quality" style={{ marginBottom: 10, border: `1px solid ${severe ? 'var(--danger)' : 'var(--border-strong)'}`, borderRadius: 8, padding: '8px 10px', background: 'var(--card-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--fs-s)', color: severe ? 'var(--danger)' : 'var(--text)' }}>
          导入前质量自检{severe ? '（需复核）' : '（通过）'}
        </strong>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          只读快照 · 解析完成/预演/一键处置时刷新；逐字符编辑表格不会重扫源文档
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onRefresh} disabled={busy} className="tbtn-anim" title="按当前表格内容重新计算质量快照并播报到控制台"
          style={{ fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: busy ? 'default' : 'pointer', padding: '3px 8px' }}>
          重新自检
        </button>
        <button onClick={onExport} disabled={busy} className="tbtn-anim" title="导出质量自检报告（只读 Markdown）——优化意见⑧：作为导入附加产物，便于逐次回归"
          style={{ fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: busy ? 'default' : 'pointer', padding: '3px 8px' }}>
          导出质量报告
        </button>
        <button onClick={onNormalize} disabled={busy || s.planCount === 0} className="tbtn-anim"
          title="同题计划只留首见（置 include=false，不删行可勾回）、里程碑统一编号 M1…Mn、按明细重算工期"
          style={{ fontSize: 'var(--fs-xs)', border: '1px solid var(--danger)', borderRadius: 6, background: 'transparent', color: 'var(--danger)', cursor: busy ? 'default' : 'pointer', padding: '3px 8px' }}>
          合并重复 WBS
        </button>
        <button onClick={onDisable} disabled={busy || s.constraintReqs === 0} className="tbtn-anim"
          title="把「不新增/不改造/已闭环/废止/保持现状」等约束项取消勾选（不删行、不改状态，可再勾回）"
          style={{ fontSize: 'var(--fs-xs)', border: '1px solid var(--danger)', borderRadius: 6, background: 'transparent', color: 'var(--danger)', cursor: busy ? 'default' : 'pointer', padding: '3px 8px' }}>
          取消勾选否定口径（{s.constraintReqs}）
        </button>
      </div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', margin: '6px 0' }}>{formatQualitySummary(s)}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        <QualityMetric label="来源 PRD/设计/测试" value={`${s.docCounts.prd}/${s.docCounts.design}/${s.docCounts.test}`} bad={s.docCounts.prd === 0} hint="设计/测试文档按当前设计只归档、不参与 AI 解析" />
        <QualityMetric label="并行 WBS" value={`${s.wbsGroups} 套`} bad={s.wbsGroups > 1} hint="分片各自产出完整里程碑后直接拼接会造成重复排期" />
        <QualityMetric label="同题重复" value={`${s.duplicateGroups} 组 / ${s.duplicateRows} 行`} bad={s.duplicateRows > 0} hint="归一化标题（去掉章号/空白/标点）后相同" />
        <QualityMetric label="占位行" value={s.gapFillRows} bad={s.gapFillRows > 0} hint="系统自动补齐，无业务语义，不归属里程碑" />
        <QualityMetric label="工期不符" value={s.durationIssues} bad={s.durationIssues > 0} hint="里程碑声明工期 ≠ 其下明细之和" />
        <QualityMetric label="否定口径" value={s.constraintReqs} bad={s.constraintReqs > 0} hint="约束/验收项，不应作为待开发需求" />
        <QualityMetric label="溯源未标注" value={s.unattributedReqs} bad={s.unattributedReqs > 0} hint="sourceRef 不是章节/Q 编号格式，无法唯一定位原文" />
        <QualityMetric label="版本冲突" value={s.versionConflicts} bad={s.versionConflicts > 0} hint="同一编号在不同来源里「待确认」与「已确认」并存" />
        <QualityMetric label="覆盖缺口" value={s.coverageGaps} bad={s.coverageGaps > 0} hint="源文档章节/Q/S/D/R/T/N/O 编号未出现在解析结果中" />
        <QualityMetric label="推定字段" value={`${s.inferredFieldRows} 行`} bad hint="工期/复杂度/优先级/排期在源文档中均无依据" />
      </div>
      {/* 优化意见①④：版本基线显式裁定 + 预演逐文档引用数回显 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          版本基线（唯一需求依据）：
          <select value={baselineDoc} onChange={(e) => onBaseline(e.target.value)} disabled={busy || prdNames.length === 0}
            title="跨文档同一编号状态冲突时，指定哪份 PRD 为唯一需求依据；未裁定且存在冲突时禁止导入"
            style={{ padding: '2px 4px', fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', maxWidth: 260 }}>
            <option value="">未裁定{s.versionConflicts > 0 ? '（存在冲突，将阻止导入）' : ''}</option>
            {prdNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {s.versionConflicts > 0 && !baselineDoc.trim() && (
          <span role="alert" style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
            检测到 {s.versionConflicts} 项跨文档版本冲突，必须先裁定基线再导入
          </span>
        )}
        {(s.docCounts.design > 0 || s.docCounts.test > 0) && (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            关联设计/测试文档只归档、不参与 AI 解析；若期望其实现细节进入 WBS，需作为 PRD 文件参与解析
          </span>
        )}
      </div>
      {previewDocRefs.length > 0 && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
          预演文档引用数：
          {previewDocRefs.map((d) => (
            <span key={`${d.filename}-${d.docKind}`} style={{ marginRight: 8, color: d.reqCount === 0 ? 'var(--danger)' : 'var(--text-secondary)' }}>
              {d.filename}［{d.docKind === 'prd' ? 'PRD' : d.docKind === 'design' ? '设计' : '测试'}］{d.reqCount} 条{d.reqCount === 0 ? '（未参与生成）' : ''}
            </span>
          ))}
        </div>
      )}
      <details>
        <summary style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', cursor: 'pointer' }}>
          查看冲突 / 覆盖缺口 / 工期明细（{s.conflicts.length} 项冲突、{s.coverageGaps} 项缺口、{s.durationIssues} 个工期不符）
        </summary>
        <div style={{ maxHeight: 240, overflow: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginTop: 6 }}>
          <div style={{ marginBottom: 6 }}>
            <strong style={{ color: 'var(--text)' }}>跨文档版本冲突</strong>
            {s.conflicts.length === 0 ? <div>— 无</div> : s.conflicts.map((c) => (
              <div key={c.id} style={{ marginTop: 2 }}>
                <strong style={{ color: 'var(--danger)' }}>{c.id}</strong>：
                {c.states.map((st) => `${st.doc}（${st.state === 'pending' ? '待确认' : '已确认'}）「${st.excerpt.slice(0, 60)}」`).join(' ↔ ')}
              </div>
            ))}
          </div>
          <div style={{ marginBottom: 6 }}>
            <strong style={{ color: 'var(--text)' }}>源文档条目覆盖</strong>
            {gapGroups.length === 0 ? <div>— 全部命中</div> : gapGroups.map((g) => (
              <div key={g.label}>{g.label}：{g.covered}/{g.total}，缺口 {g.missing.slice(0, 25).join('、')}{g.missing.length > 25 ? ` 等 ${g.missing.length} 项` : ''}</div>
            ))}
          </div>
          <div style={{ marginBottom: 6 }}>
            <strong style={{ color: 'var(--text)' }}>里程碑工期不符</strong>
            {s.durationDetails.length === 0 ? <div>— 无</div> : s.durationDetails.slice(0, 20).map((d) => (
              <div key={`${d.index}-${d.title}`}>{d.title}：声明 {d.declared} 天 / 明细合计 {d.computed} 天（{d.children} 子项）</div>
            ))}
          </div>
          <div>
            <strong style={{ color: 'var(--text)' }}>同题重复示例</strong>
            {s.duplicateExamples.length === 0 ? <div>— 无</div> : s.duplicateExamples.map((x, i) => <div key={`${i}-${x}`}>{x}</div>)}
          </div>
        </div>
      </details>
    </div>
  );
}

/**
 * 2026-11-10 质量复核优化①：质量自检的来源集合 = 参与解析的主 PRD + 只归档的关联设计/测试文档。
 * 单独抽成模块级纯函数，是为了让「解析完成立即算」和「预演时按最新行重算」用同一份来源，
 * 且解析回调里能直接用本轮新读到的 sources（此时 prdSources 状态还没更新，读状态会拿到旧值）。
 */
function qualitySources(
  prd: ReadonlyArray<{ name: string; text: string }>,
  design: ReadonlyArray<{ name: string; text: string; docKind: 'design' | 'test' }>,
): QualitySource[] {
  return [
    ...prd.map((s) => ({ name: s.name, text: s.text, role: 'prd' as const })),
    ...design.map((d) => ({ name: d.name, text: d.text, role: d.docKind })),
  ];
}

/** 解析前置校验：目标项目/AI 模型缺失或未选文件时给出可见原因并中止 */
function canStartParse(projectId: string, toolId: string, fileCount: number): boolean {
  if (!projectId) { aiImportStore.patch({ error: '请先选择目标项目' }); aiImportStore.log('缺少目标项目，已中止', 'error'); return false; }
  if (!toolId) { aiImportStore.patch({ error: '请先在控制台选择 AI 模型（顶部模型下拉）' }); aiImportStore.log('缺少 AI 模型（控制台未选择），已中止', 'error'); return false; }
  return fileCount > 0;
}

/** 单文件解析：成功后回传解析结果与 PRD 原文（截断/分片/覆盖率提示按原顺序落控制台），失败抛给调用方 */
async function parseOneFile(
  file: File, projectId: string, toolId: string, signal: AbortSignal, opts?: { persistFailures?: boolean },
): Promise<PrdParseResult> {
  const buf = await file.arrayBuffer();
  // T04010：补解析单片的正文是整篇 PRD 的切片，服务端按它算出的哈希在 prd_docs 里找不到对应正文——
  // 落索引只会留下永远恢复不出来的死行，且原失败片索引本身仍在，故补解析调用显式不落库。
  const persist = opts?.persistFailures === false ? '&persist=0' : '';
  const r = await api.postBinary<{ ok: boolean } & PrdParseResult>(
    `/plans/ai-parse-prd?projectId=${projectId}&toolId=${toolId}&filename=${encodeURIComponent(file.name)}${persist}`,
    buf,
    { signal },
  );
  aiImportStore.log(`✓ ${file.name}：需求 ${r.requirements?.length ?? 0} 条、WBS ${r.drafts?.length ?? 0} 条`, 'ok');
  // T03700+：覆盖告警不再在这里播报——后端按本文件编号算，多文件合并重排后会和面板行号对不上，
  // 统一改由 parseAll 用合并后的最终结果计算（见 logUncoveredReqs）。
  // T01156：首轮输出被截断、走了精简重试——需求可能被静默压缩，必须提示用户核对数量
  if (r.truncatedNote) aiImportStore.log(`⚠ ${r.truncatedNote}`, 'error');
  // T02270 复议：分片完整跑完是**无损**结果，按普通信息展示——不能混进上面的 ⚠，
  // 否则用户看到分片提示会误判成「又被砍到 20 条」。
  if (r.parseNote) aiImportStore.log(r.parseNote);
  // 2026-11-10 质量复核优化②：服务端跨片去重后仍有多套里程碑编号时，解析完就点名，
  // 不等到导入后靠人工看甘特才发现（本次复核实测 7 套并行 WBS）。
  if ((r.wbsGroups ?? 0) > 1) {
    aiImportStore.log(`⚠ ${file.name}：跨片合并后仍有 ${r.wbsGroups} 套并行 WBS 编号——请在导入前点「合并重复 WBS」统一为 M1…Mn，否则同一模块会重复排期`, 'error');
  }
  // T03730：HTML 里被跳过的片段（内嵌页/图表/无 alt 图片）与层级丢失提示——按警示级透出，避免静默丢内容
  for (const w of r.parseWarnings ?? []) aiImportStore.log(`⚠ ${w}`, 'error');
  return {
    requirements: r.requirements ?? [],
    drafts: r.drafts ?? [],
    coverageWarn: r.coverageWarn,
    truncatedNote: r.truncatedNote,
    textMd: r.textMd,
    failedChunks: r.failedChunks,
    failedChunkIds: r.failedChunkIds,
    wbsGroups: r.wbsGroups,
  };
}

/** 逐文件解析的累计结果：解析产物、PRD 原文、缺失分片、首个错误与中断位置 */
interface ParseAcc {
  results: PrdParseResult[];
  sources: { name: string; text: string }[];
  failed: FailedShardRow[];
  firstError: string;
  stopName: string;
}

/** 逐文件串行解析（避免激增 AI 并发）：单文件失败记录日志并跳过，其余文件继续 */
async function parseSelectedFiles(
  files: File[], projectId: string, toolId: string, signal: AbortSignal, onProgress: (done: number) => void,
): Promise<ParseAcc> {
  const acc: ParseAcc = { results: [], sources: [], failed: [], firstError: '', stopName: '' };
  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) break; // 取消后剩余文件不再发起，避免"已取消却还在跑"
    const file = files[i];
    aiImportStore.log(`提取并解析（${i + 1}/${files.length}）：${file.name}…`);
    try {
      const result = await parseOneFile(file, projectId, toolId, signal);
      acc.results.push(result);
      // T00908：暂存每份文件的 PRD 全文（供确认导入时落库 PRD 管理视图）
      if (result.textMd) acc.sources.push({ name: file.name, text: result.textMd });
      // T03700+：失败/中止分片带文件名留档，面板可展示原文并单独补解析
      // T04010：附服务端失败片索引 id（与 failedChunks 同序），补解析成功后据此删除
      for (const [k, fc] of (result.failedChunks ?? []).entries()) {
        acc.failed.push({
          ...fc,
          file: file.name,
          uid: `${file.name}::${fc.index}::${Date.now()}-${acc.failed.length}`,
          serverId: result.failedChunkIds?.[k],
        });
      }
    } catch (e) {
      if (signal.aborted) {
        // 用户中断不是解析失败，不能记进 firstError 让末尾报「全部文件解析失败」
        acc.stopName = file.name;
        break;
      }
      const msg = String((e as Error).message ?? e);
      acc.firstError ||= msg;
      aiImportStore.log(`✗ ${file.name} 解析失败（已跳过，其余文件继续）：${msg}`, 'error');
    }
    onProgress(i + 1);
  }
  return acc;
}

/** T00982：解析结果落盘键（与 useSessionState 同键）——切页恢复靠它们，改键名需同步改面板的读取键 */
const PERSIST_KEYS = {
  reqs: 'prd-import.reqs',
  plans: 'prd-import.plans',
  sources: 'prd-import.sources',
  failed: 'prd-import.failedChunks',
} as const;

/**
 * T00982：解析结果同步落盘。
 * 解析期间切页会让本面板卸载：React 会丢弃卸载后的 setState，而 useSessionState 的持久化写在
 * useEffect 里（卸载后不再执行）→ 解析出的需求/计划整批丢失，控制台却仍显示「解析完成」
 * （store 是模块级的，日志不受影响）。这里在解析完成时同步写一次会话存储，切回即可恢复。
 */
function persistParseResult(
  reqs: PrdReq[],
  plans: PrdPlan[],
  sources: { readonly name: string; readonly text: string }[],
): void {
  try {
    sessionStorage.setItem(PERSIST_KEYS.reqs, JSON.stringify(reqs));
    sessionStorage.setItem(PERSIST_KEYS.plans, JSON.stringify(plans));
    sessionStorage.setItem(PERSIST_KEYS.sources, JSON.stringify(sources));
  } catch {
    /* 配额不足等写入失败静默忽略，不阻塞解析流程 */
  }
}

/**
 * T01995：PrdParseResult 与多文件合并逻辑挪到 prdMerge.ts（无依赖纯函数，脚本可逐字断言同一份实现）。
 * 缺陷本身在旧版 mergePrdResults：old→new 重编号表跨文件共用一张，后份文档的 REQ-001 覆盖前份的同名旧号，
 * 前份的 WBS 草稿因此整体偏移到后份的需求行上（实测 mtask四期 一次导 2 份 PRD，前 20 行零关联）。
 */
import { buildGapFillDrafts, findUncoveredReqs, mergePrdResults, mergeRestoredFailures, type FailedShardRow, type PrdFailedChunk, type PrdParseResult, type RestoredFailedChunk } from './prdMerge';

/** 缺失原因 → 人话（决定用户该「稍后重试」还是「换模型/拆文档」） */
const FAIL_REASON_LABEL: Record<PrdFailedChunk['reason'], string> = {
  'rate-limit': '限流退避后仍失败',
  error: 'AI 解析失败',
  aborted: '总预算中止，未解析',
  'not-run': '预算中止后未发起',
};

/**
 * 从 PRD 导入项目计划面板（T00662）：上传 PRD → AI 拆 WBS + 逐条提取需求 →
 * 预览确认（需求清单 + 计划草稿，可编辑/勾选）→ 导入（需求进矩阵、计划进甘特、可选同步待办）。
 * 与「AI 项目计划导入」共用控制台日志通道（tab 标题随导入类型切换）。
 */
export function PrdImportPanel({ toolId, onClose, onSaved }: {
  readonly toolId: string;
  readonly onClose?: () => void;
  readonly onSaved?: (n: { requirements: number; plans: number; tasks: number }) => void;
}) {
  const snap = useSyncExternalStore(aiImportStore.subscribe, aiImportStore.getSnapshot);
  // T02201：项目列表走统一容错层（加载中/失败可见 + 重试，失败不写缓存）
  const projectList = useProjectList();
  const { projects } = projectList;
  const [projectId, setProjectId] = useSessionState<string>('prd-import.project', '');
  const [createTasks, setCreateTasks] = useSessionState<boolean>('prd-import.createTasks', true);
  // T02076：同名计划处置开关——缺省新建让号，显式选 'reuse' 走幂等补写（不改原行 status/progress）
  const [onDuplicatePlan, setOnDuplicatePlan] = useSessionState<'rename' | 'reuse'>('prd-import.onDuplicatePlan', 'rename');
  const [reqs, setReqs] = useSessionState<PrdReq[]>('prd-import.reqs', []);
  const [plans, setPlans] = useSessionState<PrdPlan[]>('prd-import.plans', []);
  // T00841：待解析的已选 PRD 文件——选择仅追加到列表，用户点「确认」才触发 parseAll；确认前可增删
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  /** T03185（UX-07②）：解析进度（已完成文件数/总数）——只在面板内显示"跑到第几个文件"，取消入口据此可见 */
  const [parseProgress, setParseProgress] = useState<{ done: number; total: number } | null>(null);

  // T00907：跳转自动带入标记——一次消费（读取即清），避免每次展开面板都重复触发
  const autoPullDone = useRef<boolean>(false);

  /** T00907：从 PRD 管理视图「从PRD导入项目计划」跳转而来时，自动读取所选 PRD 文档内容，
   *  构造为 File 填充「已选文件」确认栏（不自动触发 AI 解析，沿用 T00841「确认才解析」） */
  const autoPullDoc = useCallback(async (docId: string) => {
    try {
      const d = await api.get<{ filename: string; content_md: string }>(`/plans/prd-docs/${docId}`);
      const ext = (/\.([a-z0-9]+)$/i.exec(d.filename)?.[1] ?? 'md').toLowerCase();
      const file = new File([d.content_md], d.filename || `PRD-${docId}.md`,
        { type: ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain' });
      setPickedFiles((prev) => (prev.some((f) => f.name === file.name) ? prev : [...prev, file]));
      aiImportStore.log(`已自动带入所选 PRD：${file.name}——确认内容后点「确认」开始解析导入`, 'ok');
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: `自动带入所选 PRD 失败：${msg}` });
      aiImportStore.log(`自动带入所选 PRD 失败（已中止，可在面板内手动选择文件）：${msg}`, 'error');
    }
  }, []);

  // T00908：各源文件的 PRD 全文（解析时从 textMd 暂存）——确认导入时拼为 prdMd 落库 PRD 管理视图并关联需求矩阵
  // T00982：改会话级持久化——切页后回来仍要带着源文入库，否则会导入成"无 PRD 关联"的需求
  const [prdSources, setPrdSources] = useSessionState<{ name: string; text: string }[]>(PERSIST_KEYS.sources, []);
  // T03700+：缺失分片（含原文）——会话级保留，切页后仍可补解析
  const [failedShards, setFailedShards] = useSessionState<FailedShardRow[]>(PERSIST_KEYS.failed, []);
  // T04897：关联设计/测试文档——不参与 AI 解析，手动选文件读内容后随主 PRD 一起落 prd_docs（docKind 标注类型）
  const [designDocs, setDesignDocs] = useState<Array<{ name: string; text: string; docKind: 'design' | 'test' }>>([]);
  // 2026-11-10 质量复核优化⑦：质量自检快照只在「解析完成 / 预演」时重算，
  // 避免编辑表格时对每个按键都全文扫描源文档（单次扫描约 10 万字 × 8 组标识符）。
  const [qualitySnapshot, setQualitySnapshot] = useState<QualitySummary | null>(null);
  const [previewDocRefs, setPreviewDocRefs] = useState<NonNullable<PrdPreviewResult['docReferences']>>([]);
  // 2026-11-10 质量复核优化④：基线裁定走会话级持久化——切页回来不能把已选定的「唯一需求依据」丢了
  const [baselineDoc, setBaselineDoc] = useSessionState<string>('prd-import.baselineDoc', '');
  /** 冲突未裁定 → 导入软闸：不静默把矛盾口径一起落库（未检测到冲突时完全不干预既有流程） */
  const baselineRequired = (qualitySnapshot?.versionConflicts ?? 0) > 0 && !baselineDoc.trim();

  /** 本次参与质量自检的全部来源（含只归档不解析的关联文档） */
  const currentSources = (): QualitySource[] => qualitySources(prdSources, designDocs);

  /**
   * 按当前表格状态重算质量快照。只做只读分析，不改任何行。
   * 刻意不做 useEffect 逐键重算：源文档十万字 × 8 组编号的全文扫描，逐个字符编辑都会卡住表格；
   * 触发点固定为「解析完成 / 预演 / 关联文档变化 / 用户点重新自检 / 一键处置之后」。
   */
  function refreshQuality(opts: {
    sources?: QualitySource[]; reqRows?: PrdReq[]; planRows?: PrdPlan[]; log?: boolean;
  } = {}): QualitySummary {
    const s = analyzeImportQuality({
      sources: opts.sources ?? currentSources(),
      reqs: opts.reqRows ?? reqs,
      plans: opts.planRows ?? plans,
    });
    setQualitySnapshot(s);
    if (opts.log) logQualityWarnings(s);
    return s;
  }

  /** 关联文档增删后刷新快照（表格行不变，用 ref 读最新行，避免把 reqs/plans 放进依赖逐键重扫） */
  const rowsRef = useRef({ reqs, plans });
  rowsRef.current = { reqs, plans };
  useEffect(() => {
    if (rowsRef.current.reqs.length === 0 && rowsRef.current.plans.length === 0) return;
    const s = analyzeImportQuality({
      sources: qualitySources(prdSources, designDocs),
      reqs: rowsRef.current.reqs,
      plans: rowsRef.current.plans,
    });
    setQualitySnapshot(s);
    // 依赖刻意不含 reqs/plans：逐键编辑不重扫源文档，只在关联文档变化时重算（主 PRD 解析完成时已单独算过一次）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designDocs]);

  /** 一键归一化：同题计划只留首见（不删行，置 include=false 可勾回）+ 里程碑统一 M1…Mn + 重算工期 */
  function normalizeWbsNow() {
    if (busy || plans.length === 0) return;
    const n = normalizeWbs(plans);
    const next = recalcMilestoneDurations(n.plans.map((p, i) => ({
      ...plans[i],
      title: p.title ?? plans[i].title,
      include: p.include ?? plans[i].include,
      durationDays: p.durationDays ?? plans[i].durationDays,
    })));
    setPlans(next);
    const s = refreshQuality({ planRows: next });
    aiImportStore.log(
      `已合并重复 WBS：保留第一套、其余套取消勾选 ${n.disabledRows} 条（行仍保留，可勾回）、重编号里程碑 ${n.renumberedMilestones} 个；`
      + `并行 WBS ${n.groupsBefore} 套 → ${n.groupsAfter} 套，工期不符里程碑 ${s.durationIssues} 个`,
      'ok',
    );
  }

  /** 一键排除否定口径需求：「不新增/不改造/已闭环/废止」是约束项，不是待开发需求 */
  function disableConstraintNow() {
    if (busy || reqs.length === 0) return;
    const d = disableConstraintReqs(reqs);
    const next = reqs.map((r, i) => ({ ...r, include: d.reqs[i].include ?? r.include }));
    setReqs(next);
    refreshQuality({ reqRows: next });
    aiImportStore.log(`已取消勾选 ${d.disabled} 条否定/已闭环口径需求（只取消勾选，不删行、不改写状态；如需保留可重新勾选）`, 'ok');
  }

  /** 优化意见⑧：质量报告作为导入附加产物（只读 Markdown 下载，不落库、不改源文档） */
  function downloadQualityReport() {
    const s = refreshQuality();
    const md = formatQualityReport(s, baselineDoc, currentSources());
    saveBlob(new Blob([md], { type: EXPORT_MIME.md }), `PRD导入质量自检-${new Date().toISOString().slice(0, 10)}.md`);
    aiImportStore.log(`已导出导入前质量自检报告（只读 Markdown）：版本冲突 ${s.versionConflicts} 项、覆盖缺口 ${s.coverageGaps} 项、工期不符 ${s.durationIssues} 个、并行 WBS ${s.wbsGroups} 套`, 'ok');
  }

  // S2004：行字段更新回调下沉为组件级函数，避免 JSX 深层嵌套箭头
  const patchReq = (i: number, patch: Partial<PrdReq>) => setReqs((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // T01001 二轮：任何行变更（工期/勾选/类型）后都重算里程碑工期，保证"里程碑 = 其下明细之和"
  const patchPlan = (i: number, patch: Partial<PrdPlan>) =>
    setPlans((prev) => recalcMilestoneDurations(prev.map((x, j) => (j === i ? { ...x, ...patch } : x))));
  // S2004：已选文件删除回调同样下沉，避免 JSX 内 setPickedFiles 回调嵌套过深
  const removePickedFile = (idx: number) => setPickedFiles((prev) => prev.filter((_, j) => j !== idx));
  // T04897：读取关联设计/测试文档（不参与 AI 解析，读原文后随主 PRD 落 prd_docs；类型缺省 design，可改）
  const addDesignDocs = useCallback(async (files: File[]) => {
    const items: Array<{ name: string; text: string; docKind: 'design' | 'test' }> = [];
    for (const f of files) {
      try {
        const text = await f.text();
        if (!text.trim()) continue;
        items.push({ name: f.name, text, docKind: 'design' });
      } catch (e) {
        aiImportStore.log(`读取设计文档失败（已跳过）：${f.name} —— ${String((e as Error).message ?? e)}`, 'error');
      }
    }
    if (items.length > 0) {
      setDesignDocs((prev) => [...prev, ...items]);
      aiImportStore.log(`已添加 ${items.length} 份关联文档（类型默认 design，可在列表中修改；随主 PRD 一起导入「PRD 管理」，不参与 AI 解析）`, 'ok');
    }
  }, []);
  const patchDesignDoc = (i: number, patch: Partial<{ name: string; docKind: 'design' | 'test' }>) =>
    setDesignDocs((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const removeDesignDoc = (i: number) => setDesignDocs((prev) => prev.filter((_, j) => j !== i));
  const { busy, fileName, error } = snap;

  useEffect(() => {
    aiImportStore.patch({ kind: 'prd' });
    // T00907：消费「从 PRD 管理视图」跳转自动带入的文档标记（一次性，读取即清不重复触发）
    const docId = sessionStorage.getItem('prd-import.docId');
    if (docId && !autoPullDone.current) {
      autoPullDone.current = true;
      sessionStorage.removeItem('prd-import.docId');
      void autoPullDoc(docId);
    }
  }, [autoPullDoc]);

  // T00982：解析完成戳变化 → 重新从会话存储载入结果。
  // 覆盖两类切页时序：① 解析在卸载期间完成（切回来时挂载读取已在存储里）；
  // ② 已切回页面、解析随后完成（旧实例的 setState 被丢弃，靠本戳把结果拉回当前实例）。
  const parseStamp = snap.parseStamp ?? 0;
  useEffect(() => {
    if (!parseStamp) return;
    try {
      const r: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.reqs) ?? '[]');
      const p: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.plans) ?? '[]');
      const s: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.sources) ?? '[]');
      const f: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.failed) ?? '[]');
      if (Array.isArray(r) && r.length > 0) setReqs(r as PrdReq[]);
      if (Array.isArray(p) && p.length > 0) setPlans(p as PrdPlan[]);
      if (Array.isArray(s) && s.length > 0) setPrdSources(s as { name: string; text: string }[]);
      if (Array.isArray(f) && f.length > 0) setFailedShards(f as FailedShardRow[]);
    } catch {
      /* 脏数据忽略：保留界面现有内容 */
    }
  }, [parseStamp]);

  /**
   * T04010：关窗/重启后恢复缺失片——服务端只存片号与字符区间，原文按同内容 prd_docs 正文现切，
   * 因此恢复出来的是「来源文件 + 片号 + 原文」完整行，补解析入口照旧可用。
   * 并入本地列表（不覆盖）：本会话解析响应已带 serverId 的行、或同文件同片号的行不重复加。
   */
  const failedRef = useRef(failedShards);
  failedRef.current = failedShards;
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void api.get<{ items: RestoredFailedChunk[] }>(`/plans/prd-parse-failures?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => {
        if (!alive) return;
        const items = Array.isArray(r.items) ? r.items : [];
        if (items.length === 0) return;
        const prev = failedRef.current;
        const merged = mergeRestoredFailures(prev, items);
        if (merged.length === prev.length) return;
        setFailedShards(merged);
        aiImportStore.log(`已恢复 ${merged.length - prev.length} 条上次未解析成功的分片（原文按本机 PRD 正文切出，可直接补解析，不必整篇重跑）`, 'ok');
      })
      .catch(() => { /* 恢复失败不阻塞面板：本会话既有缺失片列表照常可用 */ });
    return () => { alive = false; };
  }, [projectId, setFailedShards]);

  /** T00824：多文件批量解析——逐文件调用单文件接口（串行避免激增 AI 并发），
   *  单文件失败记录日志并跳过其余继续；合并后统一重编号，供下方交互表格编辑/勾选 */
  const parseAll = useCallback(async (files: File[]) => {
    if (!canStartParse(projectId, toolId, files.length)) return;
    aiImportStore.reset('prd');
    setPrdSources([]); // T00908：重新解析即作废上一批暂存的 PRD 全文
    setFailedShards([]); // T03700+：上一轮的缺失分片随重新解析作废
    const total = files.length;
    // T03185（UX-07②）：本轮解析的取消闸门。句柄登记在模块级 store，切页卸载后仍能中断；
    // 控制台「停止」与本面板「取消解析」共用这一句柄，保证中断的是真实请求而不是只清前端日志。
    const ctrl = new AbortController();
    const release = () => { aiImportStore.setAbort(null); setParseProgress(null); };
    aiImportStore.setAbort(() => ctrl.abort());
    aiImportStore.patch({ fileName: total > 1 ? `${total} 个文件` : files[0].name, busy: true });
    aiImportStore.log(`已选择 ${total} 个 PRD 文件：${files.map((f) => f.name).join('、')}`);
    setParseProgress({ done: 0, total });
    const { results, sources, failed, firstError, stopName } = await parseSelectedFiles(
      files, projectId, toolId, ctrl.signal, (done) => setParseProgress({ done, total }),
    );
    if (ctrl.signal.aborted) {
      // T03185（UX-07②）：取消即整轮作废——已完成的分片结果只活在局部变量里，这里直接返回，
      // 不 setReqs/setPlans、不 persistParseResult、不递增 parseStamp，因此界面与会话存储都不留半成品，
      // 也不会生成"需求 ↔ 计划"的关联（关联只在确认导入时建立）。
      const stopNote = stopName ? `（停在 ${stopName}）` : '';
      aiImportStore.log(`已取消解析${stopNote}：本次共 0 条需求 / 0 条计划进入面板，未产生任何半成品关联`, 'error');
      aiImportStore.patch({ error: '解析已取消，未生成任何条目' });
      release();
      aiImportStore.patch({ busy: false });
      return;
    }
    if (results.length === 0) {
      aiImportStore.patch({ error: firstError || '全部文件解析失败' });
      aiImportStore.log(`解析失败：${firstError || '全部文件解析失败'}`, 'error');
      release();
      aiImportStore.patch({ busy: false });
      return;
    }
    if (sources.length > 0) setPrdSources(sources);
    setFailedShards(failed);
    const { requirements, drafts } = mergePrdResults(results);
    // T03700+：服务端已为缺口需求自动补行——先播报补齐情况，再播报合并后仍未覆盖的残留（正常应为 0 条）
    logAutoFilled(drafts);
    // T03700+：覆盖缺口按合并后的最终编号播报（后端告警是单文件编号，多文件重排后会对不上）
    logUncoveredReqs(findUncoveredReqs(requirements, drafts));
    const stamp = Date.now();
    const reqRows = requirements.map((x, i) => ({ ...x, include: true, key: `pr-${stamp}-${i}` }));
    // T01001 二轮：解析出来就先汇总一次里程碑工期（AI 给的里程碑工期与其明细合计常不相等）
    const planRows = recalcMilestoneDurations(drafts.map((x, i) => ({ ...x, include: true, key: `pp-${stamp}-${i}` })));
    setReqs(reqRows);
    setPlans(planRows);
    setPreviewDocRefs([]); // 上一轮的预演引用数作废，避免新解析结果还挂着旧文档统计
    // 2026-11-10 质量复核优化④/⑤/⑦：解析完成即算一次质量快照并播报（只读，不改任何行）。
    // 来源用本轮新读到的 sources + 当前关联文档；此时 prdSources 状态仍是上一轮，不能读状态。
    const quality = analyzeImportQuality({
      sources: qualitySources(sources, designDocs),
      reqs: reqRows, plans: planRows,
    });
    setQualitySnapshot(quality);
    logQualityWarnings(quality);
    // T00982：同步落盘 + 递增完成戳（解析期间切页导致组件卸载时，这两处是结果不丢的关键）
    persistParseResult(reqRows, planRows, sources);
    aiImportStore.log(`解析完成（${results.length}/${total} 个文件）：合并需求 ${requirements.length} 条、WBS 计划 ${drafts.length} 条，编号已全局重排（REQ-001…），可编辑后导入`, 'ok');
    release();
    aiImportStore.patch({ busy: false, parseStamp: stamp });
  }, [projectId, toolId, setReqs, setPlans, setPrdSources, designDocs]);

  /**
   * T02300：勾选过滤 + PRD 全文拼接 + 处置口径收成**同一个** payload 构造函数。
   * 预演与导入必须投同一份 payload——各拼一份的话预演计数与实落库必然分叉，本单红线。
   * 返回 null = 一条都没勾选（调用方各自给提示）。
   * 顺带把「被勾选过滤丢弃的 reqNos」原样交出（不改 payload，只供播报）：面板既有口径一直是静默丢弃，
   * 实测预演时暴露出「编号打错/漏勾」在界面里连一行提示都没有——预演的立项理由就是让连带影响可见，
   * 这条丢弃属于同一类影响，故在此点名；服务端 `unlinkedReqNos` 告警仍照常工作（它看到的是丢弃后的 payload）。
   */
  function composeImportPayload(): { payload: Record<string, unknown>; droppedReqNos: string[] } | null {
    const rq = reqs.filter((x) => x.include && x.title.trim());
    const pl = plans.filter((x) => x.include && x.title.trim());
    // T03185（UX-07③）：提交门槛由「需求或计划任一非空」收紧为「至少一条需求」——
    // 计划的需求关联以矩阵里的需求行为锚点，只勾计划会让关联悬空（事后无从回溯来源），故不放行。
    if (rq.length === 0) return null;
    // 勾选过滤：仅提交勾选项；reqNos 需与提交的需求编号保持一致（未勾选需求的引用自动丢弃）
    const keptNos = new Set(rq.map((x) => x.reqNo));
    const droppedReqNos = [...new Set(pl.flatMap((p) => p.reqNos.filter((n) => !keptNos.has(n))))];
    // T00908：暂存的源文件 PRD 全文随导入落库（PRD 管理视图），需求行回填 prd_id 建立关联
    // T04064：多文件不再拼接成一条「N 个来源文件」——逐份传 prdDocs，后端每份落一条文档，
    // 需求按 sourceIndex 归属各自文档；单文件仍保留 prdMd/prdFilename 旧字段，兼容未升级的服务端。
    const prdMd = prdSources.map((s) => `# 来源：${s.name}\n\n${s.text}`).join('\n\n---\n\n');
    const prdFilename = prdSources.length > 1 ? `${prdSources.length} 个来源文件` : prdSources[0]?.name;
    const singleSource = prdSources.length === 1;
    return {
      payload: {
        projectId,
        createTasks,
        requirements: rq.map(({ include: _inc, key: _key, ...rest }) => rest),
        plans: pl.map(({ include: _inc, key: _key, ...rest }) => ({ ...rest, reqNos: rest.reqNos.filter((n) => keptNos.has(n)) })),
        // T04897：主 PRD（prdSources）docKind 默认 prd；关联设计/测试文档（designDocs）带各自 docKind 一并落 prd_docs
        prdDocs: [
          ...prdSources.map((s) => ({ filename: s.name, contentMd: s.text, docKind: 'prd' as const })),
          ...designDocs.map((d) => ({ filename: d.name, contentMd: d.text, docKind: d.docKind })),
        ],
        prdMd: singleSource ? prdMd || undefined : undefined,
        prdFilename: singleSource ? prdFilename || undefined : undefined,
        // T02076：同名计划处置——'reuse' 走幂等补写，缺省新建让号
        onDuplicatePlan: onDuplicatePlan === 'reuse' ? 'reuse' : undefined,
      },
      droppedReqNos,
    };
  }

  /** 勾选过滤丢弃的编号必须可见（实测：面板此前静默丢弃，导入后关联凭空少一条且无从追溯） */
  function logDroppedReqNos(dropped: string[], when: string): void {
    if (dropped.length === 0) return;
    aiImportStore.log(
      `${when}提示：${dropped.length} 个需求编号被已勾选的计划引用，但不在本次勾选的需求行里（${dropped.join('、')}）——`
      + '按既有口径这些引用会被丢弃，导入后对应关联不会建立；请核对是否漏勾了需求行或编号写错',
      'error',
    );
  }

  /** T02300：导入前预演——打只读端点 `/plans/import-prd/preview`，同一份 payload 先问清「这次会动什么」 */
  async function doPreview() {
    const composed = composeImportPayload();
    if (!composed) { aiImportStore.log('未勾选任何需求，无法预演（计划的需求关联需要需求行作锚点）', 'error'); return; }
    const { payload } = composed;
    // 2026-11-10 质量复核优化⑦：预演按「当前勾选/编辑后的行」重算一次质量快照并播报，
    // 让 WBS 套数、占位行、否定口径、未标注溯源、推定字段在点「导入」之前可见（解析快照会随编辑过期）。
    const quality = refreshQuality({ log: true });
    if (quality.versionConflicts > 0 && !baselineDoc.trim()) {
      aiImportStore.log(`⚠ 检测到 ${quality.versionConflicts} 项跨文档版本冲突，尚未指定版本基线——请在「导入前质量自检」选定唯一需求依据；预演仍只读，不落库`, 'error');
    }
    aiImportStore.patch({ busy: true, error: '' });
    aiImportStore.log('预演中：只读统计本次导入的连带影响，不改动任何数据…');
    logDroppedReqNos(composed.droppedReqNos, '预演');
    try {
      const p = await api.post<PrdPreviewResult>('/plans/import-prd/preview', payload);
      logPreviewResult(p);
      setPreviewDocRefs(p.docReferences ?? []);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`预演失败：${msg}`, 'error');
    } finally {
      aiImportStore.patch({ busy: false });
    }
  }

  /** 确认导入：事务创建需求项（矩阵）+ 计划（关联需求）+ 可选待办任务 */
  async function doImport() {
    const composed = composeImportPayload();
    if (!composed) { aiImportStore.patch({ error: '请至少勾选一条需求（计划的需求关联需要需求行作锚点）' }); aiImportStore.log('未勾选任何需求，已中止导入', 'error'); return; }
    // 2026-11-10 质量复核优化④：同一编号在多份来源里「待确认 / 已确认」并存时，
    // 未裁定基线就导入会把矛盾口径一起落成待开发需求（本次复核 Q-70 即此类）→ 显式软闸，不静默放行。
    if (baselineRequired) {
      aiImportStore.patch({ error: '存在跨文档版本冲突，请先在「导入前质量自检」指定版本基线' });
      aiImportStore.log('导入已中止：检测到跨文档版本冲突且未指定版本基线——请选定「唯一需求依据」并复核冲突清单后再导入', 'error');
      return;
    }
    const payload = composed.payload;
    const rqCount = ((payload.requirements as unknown[]) ?? []).length;
    const plCount = ((payload.plans as unknown[]) ?? []).length;
    if (baselineDoc.trim()) {
      aiImportStore.log(`版本基线裁定：以「${baselineDoc.trim()}」为唯一需求依据；其余来源仅作设计/参考，冲突项按该基线口径人工复核`, 'info');
    }
    aiImportStore.patch({ busy: true, error: '' });
    aiImportStore.log(`导入中：需求 ${rqCount} 条、计划 ${plCount} 条${createTasks ? '，并同步生成待办任务' : ''}…`);
    logDroppedReqNos(composed.droppedReqNos, '导入');
    try {
      const r = await api.post<ImportPrdResult>('/plans/import-prd', payload);
      logImportResult(r);
      // T00982：导入成功即清空完成戳，避免后续再按旧戳把已导入的结果拉回界面
      aiImportStore.patch({ lastSaved: r.plans, parseStamp: 0 });
      setReqs([]); setPlans([]); setPrdSources([]); setFailedShards([]);
      setQualitySnapshot(null); setPreviewDocRefs([]); // 快照/预演引用数随本批数据作废
      onSaved?.(r);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`导入失败：${msg}`, 'error');
    } finally {
      aiImportStore.patch({ busy: false });
    }
  }

  const includedPlans = useMemo(() => plans.filter((x) => x.include).length, [plans]);
  const includedReqs = useMemo(() => reqs.filter((x) => x.include).length, [reqs]);
  // T03185（UX-07③）：与 composeImportPayload 同口径的可提交需求数（勾选且标题非空）——
  // 按钮门槛若只看 include，会把「勾了但标题为空」的行算成可提交，点了仍被拦，等于禁用项不给真原因。
  const submittableReqs = useMemo(() => reqs.filter((x) => x.include && x.title.trim()).length, [reqs]);
  // T03700+：按「本次实际会导入的勾选集」算未关联需求——未勾选的计划不参与导入，其覆盖不应算数
  const uncoveredReqs = useMemo(
    () => findUncoveredReqs(reqs.filter((x) => x.include), plans.filter((x) => x.include)),
    [reqs, plans],
  );

  /**
   * T03700+：为未关联需求**确定性**补计划。此前靠提示词要求模型自行补「REQ-xxx 相关实现/验证」，
   * 但分片有 45 条计划上限，补偿行最先被裁掉，缺口集合因此随每次解析漂移；这里改为用户点一下就落行，
   * 不再比拼模型是否记得补（行可再编辑或取消勾选）。
   */
  /** T03700+：下载缺失片原文为 .md，便于人工补录或用其它工具单独解析 */
  function downloadShard(row: FailedShardRow): void {
    const stem = row.file.replace(/\.[^.]+$/, '') || 'PRD';
    saveBlob(new Blob([row.text], { type: EXPORT_MIME.md }), `${stem}-第${row.index}片.md`);
  }

  /**
   * T03700+：单片补解析——把缺失片原文当一份独立 PRD 再解析，结果**并入**当前结果（不覆盖已解析部分），
   * 合并时按「现有结果 + 补解析结果」两个来源重排全局编号，已勾选状态按行序保留。
   */
  async function retryShard(row: FailedShardRow) {
    if (busy || !projectId || !toolId) return;
    const ctrl = new AbortController();
    const release = () => aiImportStore.setAbort(null);
    aiImportStore.setAbort(() => ctrl.abort());
    aiImportStore.patch({ busy: true, error: '' });
    aiImportStore.log(`补解析缺失片：${row.file} 第 ${row.index}/${row.total} 片（${row.chars} 字）…`);
    try {
      const stem = row.file.replace(/\.[^.]+$/, '') || 'PRD';
      const file = new File([row.text], `${stem}-第${row.index}片.md`, { type: 'text/markdown' });
      const retried = await parseOneFile(file, projectId, toolId, ctrl.signal, { persistFailures: false });
      if (retried.requirements.length === 0 && retried.drafts.length === 0) {
        aiImportStore.log(`第 ${row.index} 片补解析未得到任何条目（可能仍被限流），已保留在缺失分片列表中`, 'error');
        return;
      }
      const base: PrdParseResult = {
        requirements: reqs.map(({ include: _inc, key: _key, ...rest }) => rest),
        drafts: plans.map(({ include: _inc, key: _key, ...rest }) => rest),
      };
      const merged = mergePrdResults([base, retried]);
      // T03700+：服务端对该片同样做了缺口补齐——只统计本次补解析新增的补齐行，避免把已有行重复播报
      const autoCount = retried.drafts.filter((d) => (d.description ?? '').startsWith('自动补齐：')).length;
      const stamp = Date.now();
      const reqRows = merged.requirements.map((x, i) => ({ ...x, include: i < reqs.length ? reqs[i].include : true, key: `pr-${stamp}-${i}` }));
      const planRows = recalcMilestoneDurations(merged.drafts.map((x, i) => ({ ...x, include: i < plans.length ? plans[i].include : true, key: `pp-${stamp}-${i}` })));
      setReqs(reqRows); setPlans(planRows);
      const remain = failedShards.filter((x) => x.uid !== row.uid);
      setFailedShards(remain);
      persistParseResult(reqRows, planRows, prdSources);
      try { sessionStorage.setItem(PERSIST_KEYS.failed, JSON.stringify(remain)); } catch { /* 配额等写入失败忽略 */ }
      // T04010：该片已解析成功，删掉服务端失败片索引——否则下次打开面板会把它当「上次未成功」再恢复出来
      if (row.serverId) {
        void api.del<{ deleted: number }>(`/plans/prd-parse-failures?projectId=${encodeURIComponent(projectId)}`, { ids: [row.serverId] })
          .catch(() => { /* 删除失败只留脏索引，不影响本会话结果 */ });
      }
      aiImportStore.log(`✓ 第 ${row.index}/${row.total} 片补解析完成：新增需求 ${merged.requirements.length - reqs.length} 条、计划 ${merged.drafts.length - plans.length} 条${autoCount ? `（其中自动补齐 ${autoCount} 条缺口需求，可在计划表取消勾选）` : ''}，已并入并全局重排编号`, 'ok');
      logUncoveredReqs(findUncoveredReqs(reqRows.filter((x) => x.include), planRows.filter((x) => x.include)));
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`第 ${row.index} 片补解析失败：${msg}（原文仍在缺失分片列表中，可再次重试或复制另存）`, 'error');
    } finally {
      release();
      aiImportStore.patch({ busy: false });
    }
  }

  function fillUncoveredPlans() {
    if (uncoveredReqs.length === 0) return;
    const stamp = Date.now();
    const rows: PrdPlan[] = buildGapFillDrafts(uncoveredReqs).map((d, i) => ({ ...d, include: true, key: `pp-${stamp}-gap-${i}` }));
    setPlans((prev) => recalcMilestoneDurations([...prev, ...rows]));
    aiImportStore.log(
      `已补齐 ${rows.length} 行计划（每条未关联需求一行「REQ-xxx … 实现/验证」，工期 1 天）——请核对标题，或取消勾选不需要追溯的需求`,
      'ok',
    );
  }

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <FileUp size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 'var(--fs-l)' }}>从 PRD 导入项目计划</strong>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          上传 PRD（Word/Excel/Markdown/文本/PDF）→ AI 拆分 WBS 并逐条提取需求 → 预览确认 → 导入（需求进矩阵、计划进甘特，可同步生成待办）；执行输出见右侧控制台
        </span>
        <span style={{ flex: 1 }} />
        {onClose && (
          <button onClick={onClose} className="tbtn-anim" title="收起面板" aria-label="收起 PRD 导入面板"
            style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 6px' }}>
            <X size={13} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy || projectList.unusable}
          aria-label="目标项目" title="PRD 将导入到该项目（计划 + 需求矩阵 + 可选待办）"
          style={{ padding: 4, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">{projectListPlaceholder(projectList, '选择目标项目…')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <ProjectListHint view={projectList} />
        <label className="tbtn-anim" title="选择 PRD 文件（可多选 .docx/.md/.markdown/.txt/.xlsx/.csv/.pdf/.html/.htm，将合并分析为单一需求矩阵与项目计划；HTML 支持 Confluence 导出与网页另存）"
          style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 'var(--fs-s)' }}>
          <Upload size={13} /> 选择 PRD 文件{pickedFiles.length > 0 ? `（已选 ${pickedFiles.length}）` : ''}
          <input type="file" multiple accept=".docx,.md,.markdown,.txt,.xlsx,.csv,.pdf,.html,.htm" style={FILE_INPUT_SR_ONLY}
            onChange={(e) => {
              const fs = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = '';
              if (fs.length === 0) return;
              // 选择仅追加到待解析列表、不立即解析；确认后统一走 parseAll（T00841）
              setPickedFiles((prev) => [...prev, ...fs]);
            }} />
        </label>
        <label className="tbtn-anim" title="关联设计/测试文档（.md/.pdf，可多选）——不参与 AI 解析，读原文后随主 PRD 一起导入「PRD 管理」；类型默认 design，可在下方列表改为 test"
          style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', fontSize: 'var(--fs-s)' }}>
          <FileUp size={13} /> 添加设计文档{designDocs.length > 0 ? `（${designDocs.length}）` : ''}
          <input type="file" multiple accept=".md,.markdown,.pdf,.txt" style={FILE_INPUT_SR_ONLY}
            onChange={(e) => {
              const fs = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = '';
              if (fs.length === 0) return;
              void addDesignDocs(fs);
            }} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          title="勾选后：WBS 节点同时生成待办任务（携带需求关联），便于 AI 推进执行">
          <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} style={{ cursor: 'pointer' }} />
          {' '}
          同步生成待办任务
        </label>
        {fileName && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{fileName}</span>}
        {busy && <span className="ai-shimmer" style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, ['--ai-shimmer-color' as never]: 'var(--accent)' }}>处理中…</span>}
        {/* T03185（UX-07②）：解析进度就地可见——此前只有一行「处理中…」，多文件时看不出跑到第几个、还要等多久 */}
        {parseProgress && (
          <output data-t03185="parse-progress" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
            解析进度 {parseProgress.done}/{parseProgress.total}
          </output>
        )}
        {busy && snap.canCancel && (
          <button onClick={() => { if (aiImportStore.cancelByUser()) aiImportStore.log('已请求取消解析：正在中断当前 AI 请求，剩余文件不再发起…'); }}
            className="tbtn-anim" data-t03185="cancel-parse"
            title="取消解析 — 中断本轮 AI 解析请求；本轮结果整轮作废，不会留下半成的需求/计划行"
            aria-label="取消本轮 PRD 解析"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', border: '1px solid var(--danger)', borderRadius: 6, background: 'transparent', color: 'var(--danger)', cursor: 'pointer', padding: '3px 8px' }}>
            <X size={12} /> 取消解析
          </button>
        )}
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          {snap.logs.length > 0 ? `控制台已输出 ${snap.logs.length} 条执行日志 →` : '执行过程将在右侧 AI 控制台逐行输出'}
        </span>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-s)', marginBottom: 8 }}>{error}</div>}

      {/* T03700+：缺失分片就地可见——原文可展开/复制/下载，并支持只补解析这一片后并入结果 */}
      {failedShards.length > 0 && (
        <div data-t03700="failed-shards" style={{ marginBottom: 10, border: '1px solid var(--danger)', borderRadius: 8, padding: '8px 10px', background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>缺失分片（{failedShards.length}）</strong>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              以下分片解析失败或未解析，其需求/计划不在下方清单中；可展开查看原文、复制/下载另存，或「补解析此片」把内容并入当前结果
            </span>
          </div>
          {failedShards.map((row) => (
            <div key={row.uid} style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text)' }}>
                  {row.file} · 第 {row.index}/{row.total} 片 · {FAIL_REASON_LABEL[row.reason]} · {row.chars} 字
                </span>
                <CopyButton getText={() => row.text} title="复制该片原文" ariaLabel={`复制第 ${row.index} 片原文`} />
                <button onClick={() => downloadShard(row)} className="tbtn-anim" title="下载该片原文为 .md（可人工补录或换工具解析）" aria-label={`下载第 ${row.index} 片原文`}
                  style={{ fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '2px 8px' }}>
                  下载原文
                </button>
                <button onClick={() => void retryShard(row)} disabled={busy || !projectId || !toolId} className="tbtn-anim"
                  title="只把该片原文再解析一次，并并入当前结果（不覆盖已解析部分）"
                  aria-label={`补解析第 ${row.index} 片`}
                  style={{ fontSize: 'var(--fs-xs)', border: '1px solid var(--danger)', borderRadius: 6, background: 'transparent', color: 'var(--danger)', cursor: (busy || !projectId || !toolId) ? 'default' : 'pointer', padding: '2px 8px' }}>
                  补解析此片
                </button>
              </div>
              {row.message && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>失败原因：{row.message}</div>}
              <details style={{ marginTop: 4 }}>
                <summary style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', cursor: 'pointer' }}>查看该片原文</summary>
                <pre style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--fs-xs)', background: 'var(--border-weak, rgba(0,0,0,.03))', padding: 8, borderRadius: 6 }}>{row.text}</pre>
              </details>
            </div>
          ))}
        </div>
      )}

      {/* T03700+：覆盖缺口就地可见并给确定性补齐入口——只报编号不够（编号每次都重排），必须带标题 */}
      {uncoveredReqs.length > 0 && (
        <div role="status" data-t03700="uncovered" style={{ marginBottom: 10, border: '1px solid var(--danger)', borderRadius: 8, padding: '8px 10px', background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>⚠ {uncoveredReqs.length} 条需求未被任何计划关联</strong>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              {uncoveredReqs.slice(0, 6).map((r) => `${r.reqNo}《${r.title.slice(0, 16)}》`).join('、')}
              {uncoveredReqs.length > 6 ? ` 等 ${uncoveredReqs.length} 条` : ''}
              （编号每次解析会重排，跨次比对请以标题为准）
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={fillUncoveredPlans} disabled={busy} className="tbtn-anim"
              title="为每条未关联需求追加一行「REQ-xxx … 实现/验证」任务（工期 1 天）——确定性补齐，不依赖模型是否记得补计划；生成后可编辑或取消勾选"
              aria-label="为未关联需求补齐计划"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', fontSize: 'var(--fs-xs)', cursor: busy ? 'default' : 'pointer' }}>
              补齐计划（{uncoveredReqs.length}）
            </button>
          </div>
        </div>
      )}

      {/* T00841：已选文件列表——选择仅入列表不解析，用户点「确认」才触发 parseAll；确认前可增删 */}
      {pickedFiles.length > 0 && (
        <div style={{ marginBottom: 10, border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <strong style={{ fontSize: 'var(--fs-s)' }}>已选文件（{pickedFiles.length}）</strong>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>确认后合并解析，可同步生成待办</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { const fs = pickedFiles; setPickedFiles([]); void parseAll(fs); }} disabled={busy} className="tbtn-anim"
              title="确认 — 用已选文件开始解析并导入项目计划" aria-label="确认：开始解析并导入"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', border: 'none', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)', cursor: busy ? 'default' : 'pointer', padding: '4px 10px' }}>
              <Sparkles size={12} /> 确认
            </button>
          </div>
          {pickedFiles.map((f, i) => (
            <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
              <FileUp size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: 'var(--fs-s)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={f.name}>{f.name}</span>
              <button onClick={() => removePickedFile(i)} className="tbtn-anim"
                title="删除 — 从已选列表中移除该文件，不再参与解析" aria-label="删除：移除已选文件"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px' }}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* T04897：关联设计/测试文档列表——不参与 AI 解析，随主 PRD 一起落 prd_docs；类型可改 design/test */}
      {designDocs.length > 0 && (
        <div data-t04897="design-docs" style={{ marginBottom: 10, border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <strong style={{ fontSize: 'var(--fs-s)' }}>关联文档（{designDocs.length}）</strong>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>不参与 AI 解析，导入时随主 PRD 落「PRD 管理」；类型可改</span>
          </div>
          {designDocs.map((d, i) => (
            <div key={`${d.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
              <FileUp size={12} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
              <span style={{ fontSize: 'var(--fs-s)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={d.name}>{d.name}</span>
              <select value={d.docKind} aria-label={`文档类型 ${d.name}`}
                onChange={(e) => patchDesignDoc(i, { docKind: e.target.value as 'design' | 'test' })}
                style={{ padding: '1px 4px', fontSize: 'var(--fs-xs)', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
                <option value="design">设计文档</option>
                <option value="test">测试用例</option>
              </select>
              <button onClick={() => removeDesignDoc(i)} className="tbtn-anim"
                title="移除该关联文档" aria-label={`移除关联文档 ${d.name}`}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px' }}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 2026-11-10 质量复核优化①③⑤⑦：导入前质量自检卡片（只读快照 + 用户显式处置） */}
      {qualitySnapshot && (reqs.length > 0 || plans.length > 0) && (
        <QualityCard
          s={qualitySnapshot}
          sources={currentSources()}
          baselineDoc={baselineDoc}
          onBaseline={setBaselineDoc}
          previewDocRefs={previewDocRefs}
          busy={busy}
          onNormalize={normalizeWbsNow}
          onDisable={disableConstraintNow}
          onRefresh={() => refreshQuality({ log: true })}
          onExport={downloadQualityReport}
        />
      )}

      {(reqs.length > 0 || plans.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          {/* 需求清单（矩阵行） */}
          <div>
            <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={12} style={{ color: 'var(--accent)' }} />
              需求清单 {reqs.length} 条（勾选 {includedReqs}）
              <button onClick={() => setReqs((p) => p.map((x) => ({ ...x, include: true })))} disabled={busy} title="全选需求" aria-label="全选需求"
                style={{ border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-xs)', padding: '1px 6px', cursor: 'pointer' }}>全选</button>
              <button onClick={() => setReqs((p) => p.map((x) => ({ ...x, include: false })))} disabled={busy} title="全不选需求" aria-label="全不选需求"
                style={{ border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-xs)', padding: '1px 6px', cursor: 'pointer' }}>全不选</button>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>选</th>
                    <th style={{ padding: 4 }}>编号</th>
                    <th style={{ padding: 4 }}>需求标题</th>
                    <th style={{ padding: 4 }}>原文定位</th>
                  </tr>
                </thead>
                <tbody>
                  {reqs.map((r, i) => (
                    <tr key={r.key} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: 4 }}>
                        <input type="checkbox" checked={r.include} aria-label={`选中需求 ${r.title}`}
                          onChange={(e) => patchReq(i, { include: e.target.checked })} />
                      </td>
                      <td style={{ padding: 4, width: 88 }}>
                        <input value={r.reqNo} aria-label="需求编号" title={r.content || '（无详细描述）'}
                          onChange={(e) => patchReq(i, { reqNo: e.target.value })}
                          style={{ width: 80, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-xs)', padding: '1px 4px' }} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          {/* 优化意见③：否定语义就地可见——「不新增/已闭环」是约束项，不该被当待开发需求静默排期 */}
                          {isConstraintReq(r) && r.include && (
                            <span aria-label="否定口径提示" title="命中「不新增/不改造/不修正/已闭环/废止/保持现状」等否定口径：该行更可能是约束或验收项，不应作为待开发需求排期；可用上方「取消勾选否定口径」批量排除"
                              style={{ color: 'var(--danger)', fontSize: 'var(--fs-xs)', flexShrink: 0 }}>⚠</span>
                          )}
                          <input value={r.title} aria-label="需求标题" title={r.content}
                            onChange={(e) => patchReq(i, { title: e.target.value })}
                            style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }} />
                        </div>
                      </td>
                      <td style={{ padding: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.sourceRef}>{r.sourceRef || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* WBS 计划草稿（含需求关联） */}
          <div>
            <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 6 }}>
              WBS 计划 {plans.length} 条（勾选 {includedPlans}，其中里程碑 {plans.filter((x) => isMilestoneRow(x)).length} 条）——
              关联需求编号显示在标题后；里程碑工期为其下任务工期汇总，改任务即联动，不可手工调整
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>选</th>
                    <th style={{ padding: 4 }}>WBS 任务</th>
                    <th style={{ padding: 4 }}>类型</th>
                    <th style={{ padding: 4 }}>工期</th>
                    <th style={{ padding: 4 }}>关联需求</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p, i) => {
                    const ms = isMilestoneRow(p);
                    return (
                    <tr key={p.key} style={{ borderTop: '1px solid var(--border)', background: ms ? 'var(--border-weak, rgba(0,0,0,.03))' : undefined }}>
                      <td style={{ padding: 4 }}>
                        <input type="checkbox" checked={p.include} aria-label={`选中计划 ${p.title}`}
                          onChange={(e) => patchPlan(i, { include: e.target.checked })} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input value={p.title} aria-label="WBS 标题" title={p.description}
                          onChange={(e) => patchPlan(i, { title: e.target.value })}
                          style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', fontWeight: ms ? 700 : undefined }} />
                      </td>
                      {/* T01001 二轮：草稿表单标注任务类型（里程碑/任务），可手动纠正 AI 判定 */}
                      <td style={{ padding: 4, width: 78 }}>
                        <select value={p.kind ?? 'normal'} aria-label={`计划类型 ${p.title}`}
                          title={ms ? '里程碑 — 工期由其下任务汇总，不可手工调整' : '普通任务 — 工期可手工调整'}
                          onChange={(e) => patchPlan(i, { kind: e.target.value as PrdPlan['kind'] })}
                          style={{ width: 72, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: ms ? 'var(--accent)' : 'var(--text)', fontSize: 'var(--fs-xs)', padding: '1px 2px' }}>
                          <option value="normal">任务</option>
                          <option value="milestone">里程碑</option>
                        </select>
                      </td>
                      <td style={{ padding: 4, width: 70 }}>
                        <input type="number" min={1} value={p.durationDays} aria-label="工期" readOnly={ms}
                          title={ms ? '里程碑工期 = 其下任务工期汇总（不可手工调整，改子任务即联动）' : '工期（天）'}
                          onChange={(e) => patchPlan(i, { durationDays: Number(e.target.value) || 1 })}
                          style={{ width: 50, border: '1px solid var(--border)', borderRadius: 4, background: ms ? 'transparent' : 'var(--card-bg)', color: ms ? 'var(--text-muted)' : 'var(--text)', fontSize: 'var(--fs-s)', padding: '1px 4px', fontWeight: ms ? 700 : undefined }} />
                      </td>
                      <td style={{ padding: 4, fontSize: 'var(--fs-xs)', color: 'var(--accent)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.reqNos.join('、')}>
                        {p.reqNos.length > 0 ? p.reqNos.join('、') : '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {(reqs.length > 0 || plans.length > 0) && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* T02076：同名计划处置开关——缺省新建让号，显式选 reuse 走幂等补写 */}
          <label style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span>同名计划处置：</span>
            <select value={onDuplicatePlan} onChange={(e) => setOnDuplicatePlan(e.target.value as 'rename' | 'reuse')} disabled={busy}
              title="新建让号 = 撞名时加「（N）」后缀并建为新行；幂等复用 = 撞名时补写到原计划行（不改 status/progress），并连带复用「同标题+同内容」的存量需求行（T02303 甲）"
              style={{ padding: '2px 4px', fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
              <option value="rename">新建让号（默认）</option>
              <option value="reuse">幂等复用原行</option>
            </select>
          </label>
          {/* T02300：导入前预演（只读端点）——把「这次会新建/复用/让号多少行」摊在点导入之前，
              T01869 那类「重导后两行同名被读成回档」的误判就没了生长空间 */}
          <button onClick={() => void doPreview()} disabled={busy || submittableReqs === 0}
            title={submittableReqs === 0 ? '需先勾选至少一条需求 — 计划的需求关联以需求行为锚点，未勾选需求时预演/导入都不放行' : '只读预演：按当前勾选项与处置口径，算出本次导入将新建/复用/让号多少行，零写库（不改任何数据）'}
            aria-label="预演本次 PRD 导入的连带影响"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', cursor: (busy || submittableReqs === 0) ? 'default' : 'pointer' }}>
            <Eye size={13} /> 预演（只读）
          </button>
          <button onClick={() => void doImport()} disabled={busy || submittableReqs === 0 || baselineRequired} className="tbtn-anim"
            title={submittableReqs === 0 ? '需先勾选至少一条需求 — 计划的需求关联以需求行为锚点，只勾计划会留下悬空关联'
              : baselineRequired ? '存在跨文档版本冲突且未指定版本基线 — 请先在「导入前质量自检」选定唯一需求依据'
                : '导入勾选的条目——需求进矩阵、计划进甘特（含需求关联）、可选生成待办任务'}
            aria-label="导入 PRD 解析结果"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)', cursor: (busy || submittableReqs === 0) ? 'default' : 'pointer' }}>
            <Save size={13} /> 导入（需求 {includedReqs} 条 / 计划 {includedPlans} 条{createTasks ? ' + 待办' : ''}）
          </button>
          {/* T03185（UX-07③）：门槛原因就地说明，不靠点击后弹提示（禁用项须说明原因） */}
          {submittableReqs === 0 && (
            <span role="alert" data-t03185="need-req" style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
              至少勾选一条需求才能预演或导入：计划的需求关联需要需求行作锚点，只勾计划会产生悬空关联。
            </span>
          )}
          {baselineRequired && (
            <span role="alert" data-qc="baseline-required" style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
              导入已暂停：存在跨文档版本冲突，请先在上方「导入前质量自检」指定版本基线（唯一需求依据）。预演仍可正常使用。
            </span>
          )}
        </div>
      )}
    </div>
  );
}
