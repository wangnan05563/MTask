/**
 * PRD 导入质量分析（纯函数，无外部依赖）。
 *
 * 背景（2026-11-10「BEMP审批」导入质量复核）：单次导入 161 需求 / 149 计划，
 * 结构上零断裂，但出现 7 套并行 WBS、里程碑工期与子项不符、否定口径被当成待开发需求、
 * 方案设计文档未参与导入、源文档独有条目（D/R/T/N/代码锚点）零覆盖等问题。
 * 本模块把「报告第五节的优化意见」落成可在导入前预演、可一键处置的确定性规则，
 * 与 AI 解析链路解耦：只标记、只建议，静默不改用户已勾选的数据。
 *
 * 设计红线：
 * - 所有检测函数只读；归一化函数返回新数组，不修改入参；
 * - 不删除任何行，只把判定为重复/否定的行 include=false（用户可再勾回）；
 * - 「命中」一律以源文档原文为准，不做业务价值判断（该判断留给人工复核）。
 */

/** 结构刻意与 PrdImportPanel 的 PrdReq/PrdPlan 兼容（不设索引签名，避免 TS 赋值不兼容） */
export interface QualityReq {
  reqNo: string;
  title: string;
  content?: string;
  sourceRef?: string;
  sourceIndex?: number;
  include?: boolean;
  key?: string;
}

export interface QualityPlan {
  title: string;
  description?: string;
  durationDays?: number;
  kind?: string;
  reqNos?: string[];
  include?: boolean;
  key?: string;
  /** T05574：排期起止（YYYY-MM-DD）——区间连续性校验用；缺省视为未排期，跳过该项 */
  startDate?: string;
  endDate?: string;
}

export interface QualitySource {
  name: string;
  text: string;
  role?: 'prd' | 'design' | 'test';
}

/** 否定/已闭环/不改造口径：这些是约束或验收项，不应作为「待开发需求」直接排期 */
export const CONSTRAINT_RE =
  /不新增|不变|不改造|不实施|不修正|不实现|不删|不迁移|不做|不得|废止|失效|禁止|仅移除|保持现状|保留不删|不下线|已闭环|已落地|无需开发|不参与|不新增下发/;

/** 只判标题——content 里大量「不」是正常业务描述（如「开关关闭时不读最低利率」） */
export function isConstraintReq(r: Pick<QualityReq, 'title'>): boolean {
  return CONSTRAINT_RE.test(r.title ?? '');
}

export function detectConstraintReqs(reqs: ReadonlyArray<QualityReq>): QualityReq[] {
  return reqs.filter(isConstraintReq);
}

/** 系统自动补齐的占位行：无业务语义，且不应归属到里程碑 */
export function isGapFillPlan(p: Pick<QualityPlan, 'title' | 'description'>): boolean {
  return /^REQ-\d{3}\b/.test((p.title ?? '').trim())
    || (p.description ?? '').startsWith('自动补齐：');
}

/** 标题归一化：去掉 WBS 编号前缀、空白与常见标点，用于跨片同题去重 */
export function normalizePlanTitle(title: string): string {
  return (title ?? '')
    .replace(/^\s*\d+(?:\.\d+)*\s*(?:M\d+)?\s*/i, '')
    .replace(/^\s*M\d+\s*/i, '')
    .replace(/^REQ-\d+\s*/i, '')
    // 只去空白/标点/符号，**不能**用 [\s\W_]：JS 的 \W 会把中文一并当作非单词字符删掉，
    // 导致所有纯中文标题归一化为 ''，跨片同题去重全部失效（质量门 A-02 实测捕获）。
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/**
 * 多套 WBS 检测：里程碑标题的章号出现「回退」（如 …3、4、1、2…）即视为新的一套。
 * 单次导入若 groups > 1，说明各分片独立产出了完整 WBS 后直接拼接。
 */
export function detectWbsGroups(plans: ReadonlyArray<QualityPlan>): {
  groups: number;
  milestones: number;
  groupStartTitles: string[];
} {
  const ms = plans.filter((p) => p.kind === 'milestone');
  let groups = ms.length > 0 ? 1 : 0;
  let prev = -1;
  const groupStartTitles: string[] = [];
  ms.forEach((m, i) => {
    const matched = /^\s*(\d+)/.exec(m.title ?? '');
    const n = matched ? Number(matched[1]) : -1;
    if (i === 0) groupStartTitles.push(m.title);
    else if (n >= 0 && prev >= 0 && n <= prev) {
      groups += 1;
      groupStartTitles.push(m.title);
    }
    if (n >= 0) prev = n;
  });
  return { groups, milestones: ms.length, groupStartTitles };
}

/**
 * T05438（P0-1）：按「里程碑章号回退」切分 WBS 套，返回每套覆盖的计划行区间 `[start, end)`。
 *
 * 一套 WBS 的范围 = 该套第一个里程碑，到下一套第一个里程碑之前（含其间的全部明细）。
 * 判据与 `detectWbsGroups` 完全一致（`^\s*(\d+)` 取章号，`n <= prev` 视为新一套），
 * 保证「检测到几套」与「能切出几段」永远对得上。
 */
export function splitWbsGroupRanges(plans: ReadonlyArray<QualityPlan>): Array<{ start: number; end: number }> {
  const ms: Array<{ p: QualityPlan; i: number }> = [];
  plans.forEach((p, i) => { if (p.kind === 'milestone') ms.push({ p, i }); });
  if (ms.length === 0) return [];
  const groupStartMs: number[] = [0];
  let prev = -1;
  ms.forEach((x, k) => {
    const matched = /^\s*(\d+)/.exec(x.p.title ?? '');
    const n = matched ? Number(matched[1]) : -1;
    if (k > 0 && n >= 0 && prev >= 0 && n <= prev) groupStartMs.push(k);
    if (n >= 0) prev = n;
  });
  return groupStartMs.map((k, gi) => ({
    start: ms[k].i,
    end: gi + 1 < groupStartMs.length ? ms[groupStartMs[gi + 1]].i : plans.length,
  }));
}

/** 同题计划分组（归一化标题相同即一组），返回重复组明细 */
export function findDuplicatePlanGroups(plans: ReadonlyArray<QualityPlan>): Array<{ key: string; titles: string[]; indexes: number[] }> {
  const byKey = new Map<string, { titles: string[]; indexes: number[] }>();
  plans.forEach((p, i) => {
    // 系统补齐占位行按 REQ 编号区分，归一化后全叫「相关实现」——必须排除，否则 22 行会被误判成一组重复
    if (isGapFillPlan(p)) return;
    const key = normalizePlanTitle(p.title ?? '');
    if (!key) return;
    const g = byKey.get(key);
    if (g) { g.titles.push(p.title); g.indexes.push(i); }
    else byKey.set(key, { titles: [p.title], indexes: [i] });
  });
  return Array.from(byKey.values()).filter((g) => g.indexes.length > 1).map((g, i) => ({ key: `dup-${i}`, ...g }));
}

/** 里程碑工期 = 其下（下一里程碑之前）勾选明细之和；返回不符清单 */
export function findMilestoneDurationIssues(plans: ReadonlyArray<QualityPlan>): Array<{
  title: string; index: number; declared: number; computed: number; children: number;
}> {
  const out: Array<{ title: string; index: number; declared: number; computed: number; children: number }> = [];
  for (let i = 0; i < plans.length; i++) {
    if (plans[i].kind !== 'milestone') continue;
    let sum = 0;
    let children = 0;
    for (let j = i + 1; j < plans.length; j++) {
      if (plans[j].kind === 'milestone') break;
      if (plans[j].include === false) continue;
      // 与服务端 milestoneDurations / intervalChildEdges 同一口径：系统补齐占位行不计入里程碑工期
      if (isGapFillPlan(plans[j])) continue;
      sum += Math.max(1, Math.round(Number(plans[j].durationDays) || 1));
      children += 1;
    }
    const declared = Math.max(1, Math.round(Number(plans[i].durationDays) || 1));
    if (children > 0 && sum !== declared) out.push({ title: plans[i].title, index: i, declared, computed: sum, children });
  }
  return out;
}

/**
 * T05574：里程碑区间连续性校验——排期层面的盲区（不是工期 ≠ 明细之和）。
 *
 * 背景（BEMP 复盘根因 #5 修正后）：M5 的 178 天**精确等于**其 83 条 normal 明细工期之和，
 * B-05 是 PASS 的；真正的缺陷是**区间不连续**——M1~M4 集中在 2026-11~2027-01，
 * M5 却跨 2027-09~2028-05，中间留了 8 个月空档，且里程碑内部有 27 处相邻明细间隔 > 3 天。
 * 工期相符 ≠ 排期合理，两者必须分开判。
 *
 * 判据（只用 startDate/endDate，未排期的行跳过）：
 *  ① 里程碑声明区间未覆盖其子项实际区间（子项超出上/下界）；
 *  ② 相邻两个里程碑之间存在 > maxGapDays 的空档（默认 3 天）；
 *  ③ 同一里程碑内相邻明细之间存在 > maxGapDays 的空档。
 * 纯函数，只读，不修改入参。
 */
export interface MilestoneScheduleGap {
  /** 问题类型 */
  kind: 'milestone-span' | 'milestone-gap' | 'child-gap';
  /** 里程碑（或空档前一条）标题 */
  title: string;
  /** 相关行的索引 */
  index: number;
  /** 对比对象标题（child-gap 时为下一条明细） */
  next?: string;
  /** 空档天数或越界天数 */
  days: number;
  detail: string;
}

const DAY_MS = 86_400_000;
const toDay = (v?: string): number | null => {
  if (!v) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : null;
};

export function findMilestoneScheduleGaps(
  plans: ReadonlyArray<QualityPlan>,
  options: { maxGapDays?: number } = {},
): MilestoneScheduleGap[] {
  const maxGap = Math.max(0, options.maxGapDays ?? 3);
  const out: MilestoneScheduleGap[] = [];
  // 收集里程碑区间（自身声明 + 子项实际）
  interface Ms { index: number; title: string; start: number | null; end: number | null; childStart: number | null; childEnd: number | null }
  const msList: Ms[] = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (p.kind !== 'milestone') continue;
    const cur: Ms = {
      index: i, title: p.title, start: toDay(p.startDate), end: toDay(p.endDate), childStart: null, childEnd: null,
    };
    let prevChild: { title: string; index: number; end: number } | null = null;
    for (let j = i + 1; j < plans.length; j++) {
      const c = plans[j];
      if (c.kind === 'milestone') break;
      if (c.include === false || isGapFillPlan(c)) continue;
      const cs = toDay(c.startDate);
      const ce = toDay(c.endDate) ?? (cs !== null ? cs + Math.max(1, Math.round(Number(c.durationDays) || 1)) - 1 : null);
      if (cs === null || ce === null) continue;
      if (cur.childStart === null || cs < cur.childStart) cur.childStart = cs;
      if (cur.childEnd === null || ce > cur.childEnd) cur.childEnd = ce;
      // ③ 同里程碑内相邻明细空档
      if (prevChild && cs - prevChild.end - 1 > maxGap) {
        out.push({
          kind: 'child-gap', title: prevChild.title, index: prevChild.index, next: c.title,
          days: cs - prevChild.end - 1,
          detail: `「${prevChild.title}」结束到「${c.title}」开始空 ${cs - prevChild.end - 1} 天`,
        });
      }
      prevChild = { title: c.title, index: j, end: ce };
    }
    // ① 声明区间未覆盖子项区间
    if (cur.start !== null && cur.childStart !== null && cur.childStart < cur.start) {
      out.push({ kind: 'milestone-span', title: cur.title, index: i, days: cur.start - cur.childStart, detail: `子项早于里程碑开始 ${cur.start - cur.childStart} 天` });
    }
    if (cur.end !== null && cur.childEnd !== null && cur.childEnd > cur.end) {
      out.push({ kind: 'milestone-span', title: cur.title, index: i, days: cur.childEnd - cur.end, detail: `子项晚于里程碑结束 ${cur.childEnd - cur.end} 天` });
    }
    msList.push(cur);
  }
  // ② 相邻里程碑空档（用实际区间：有子项用子项，否则用声明）
  for (let k = 1; k < msList.length; k++) {
    const a = msList[k - 1];
    const b = msList[k];
    const aEnd = a.childEnd ?? a.end;
    const bStart = b.childStart ?? b.start;
    if (aEnd === null || bStart === null) continue;
    const gap = bStart - aEnd - 1;
    if (gap > maxGap) {
      out.push({
        kind: 'milestone-gap', title: a.title, index: a.index, next: b.title, days: gap,
        detail: `「${a.title}」结束到「${b.title}」开始空 ${gap} 天`,
      });
    }
  }
  return out;
}

/** 文档状态词：同一编号在不同文档里「待确认」与「已确认」并存 → 版本口径冲突 */
const PENDING_RE = /待确认|未确认|待业务确认|待澄清|不得进入|不得开发|未闭环|待核实|待\s*Q-\d+\s*确认/;
const RESOLVED_RE = /已确认|已闭环|已通过|已核实|已落地|门禁.{0,4}通过|剩余待回复.{0,3}0\s*项/;
const ID_RE = /\b(Q-\d{2}|[DR]\d{1,2}|N-\d|O\d|S\d|T\d{1,2})\b/g;
/** 区间写法（Q-42~Q-70 / R1–R10）是「继承/留痕」叙述，不是对某个编号的状态断言 */
const RANGE_RE = /\b(?:Q-\d{2}|[DRTNO]\d{1,2}|N-\d)\s*[~～\-–—至]\s*(?:Q-\d{2}|[DRTNO]\d{1,2}|N-\d)\b/g;

export interface VersionConflict {
  id: string;
  states: Array<{ doc: string; state: 'pending' | 'resolved'; excerpt: string }>;
}

/**
 * 逐行扫描 + 三层降噪（2026-11-10 用真实 BEMP 文档复跑后收紧）：
 *  ① 抹掉区间写法（保留字符位置，避免误把 Q-42~Q-70 拆成两个编号断言）；
 *  ② 状态词必须在编号附近 ±45 字窗口内——整行里远处一句「门禁通过」不能给该编号定性；
 *  ③ 同窗口两态并存（叙述行）不下结论，且冲突必须由**两份不同文档**分别给出相反状态。
 * 输出仍是「待人工裁定的候选清单」，不替用户做版本裁决（优化意见④）。
 */
export function detectVersionConflicts(sources: ReadonlyArray<QualitySource>): VersionConflict[] {
  const byId = new Map<string, VersionConflict['states']>();
  for (const s of sources) {
    for (const raw of (s.text ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.length > 400) continue;
      // 用等长空格替换，保持 ID_RE 的 index 与原文位置一致
      const cleaned = line.replace(RANGE_RE, (m) => ' '.repeat(m.length));
      if (!PENDING_RE.test(cleaned) && !RESOLVED_RE.test(cleaned)) continue;
      ID_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ID_RE.exec(cleaned)) !== null) {
        const id = m[1];
        const win = cleaned.slice(Math.max(0, m.index - 45), Math.min(cleaned.length, m.index + id.length + 45));
        const pending = PENDING_RE.test(win);
        const resolved = RESOLVED_RE.test(win);
        if (pending === resolved) continue; // 无状态或两态并存的叙述行，不下结论
        const arr = byId.get(id) ?? [];
        const state: 'pending' | 'resolved' = pending ? 'pending' : 'resolved';
        // 同一文档同一状态只记一次，避免长表格重复刷屏
        if (!arr.some((x) => x.doc === s.name && x.state === state)) {
          arr.push({ doc: s.name, state, excerpt: line.slice(0, 120) });
        }
        byId.set(id, arr);
      }
    }
  }
  return Array.from(byId.entries())
    .filter(([, states]) => {
      const pendingDocs = new Set(states.filter((x) => x.state === 'pending').map((x) => x.doc));
      const resolvedDocs = new Set(states.filter((x) => x.state === 'resolved').map((x) => x.doc));
      // 必须是跨文档：同一文档内部的历史叙述不构成「版本冲突」
      return [...pendingDocs].some((d) => [...resolvedDocs].some((r) => r !== d));
    })
    .map(([id, states]) => ({ id, states }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface CoverageGroup {
  label: string;
  total: number;
  covered: number;
  missing: string[];
}

/** 从源文档抽取「可核对的条目编号」，与解析结果比对，给出覆盖率与缺口 */
export function buildSourceCoverage(
  sources: ReadonlyArray<QualitySource>,
  reqs: ReadonlyArray<QualityReq>,
  plans: ReadonlyArray<QualityPlan>,
): CoverageGroup[] {
  const docText = sources.map((s) => s.text ?? '').join('\n');
  const resultText = [
    ...reqs.map((r) => `${r.sourceRef ?? ''} ${r.title ?? ''} ${r.content ?? ''}`),
    ...plans.map((p) => `${p.title ?? ''} ${p.description ?? ''}`),
  ].join('\n');

  const specs: Array<{ label: string; re: RegExp }> = [
    { label: '章节 §x.y', re: /(?:§|^|\s)(\d{1,2}\.\d{1,2})(?:[\s\-A-Z]|$)/gm },
    { label: '确认项 Q-xx', re: /\bQ-\d{2}\b/g },
    { label: '脚本 Sx / S3-x', re: /\bS3-[BCD]\b|\bS[1-4]\b/g },
    { label: '设计决策 Dx', re: /\bD[1-7]\b/g },
    { label: '回归场景 Rx', re: /\bR(?:10|[1-9])\b/g },
    { label: '核实项 Tx', re: /\bT(?:11|10|[1-9])\b/g },
    { label: '偏差 N-x', re: /\bN-[1-5]\b/g },
    { label: '开放项 Ox', re: /\bO[1-5]\b/g },
  ];
  return specs.map(({ label, re }) => {
    const ids = new Set<string>();
    let m: RegExpExecArray | null;
    const source = new RegExp(re.source, re.flags);
    while ((m = source.exec(docText)) !== null) ids.add(m[1] ? `§${m[1]}` : m[0]);
    const missing: string[] = [];
    const covered = new Set<string>();
    for (const id of ids) {
      const needle = id.startsWith('§') ? id.slice(1) : id;
      // 短编号（D1/R1/T1/S1）必须按「非字母数字边界」匹配，否则会被 REQ-001 / 正文里的数字误命中
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hit = needle.length <= 3
        ? new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`).test(resultText)
        : resultText.includes(needle);
      if (hit) covered.add(id);
      else missing.push(id);
    }
    return { label, total: ids.size, covered: covered.size, missing: missing.sort() };
  });
}

export interface QualitySummary {
  docCounts: { prd: number; design: number; test: number };
  reqCount: number;
  planCount: number;
  milestoneCount: number;
  wbsGroups: number;
  duplicateGroups: number;
  duplicateRows: number;
  gapFillRows: number;
  constraintReqs: number;
  unattributedReqs: number;
  durationIssues: number;
  versionConflicts: number;
  inferredFieldRows: number;
  coverageGaps: number;
  conflicts: VersionConflict[];
  coverage: CoverageGroup[];
  durationDetails: ReturnType<typeof findMilestoneDurationIssues>;
  duplicateExamples: string[];
}

export function analyzeImportQuality(input: {
  sources: ReadonlyArray<QualitySource>;
  reqs: ReadonlyArray<QualityReq>;
  plans: ReadonlyArray<QualityPlan>;
}): QualitySummary {
  const { sources, reqs, plans } = input;
  const dup = findDuplicatePlanGroups(plans);
  const conflicts = detectVersionConflicts(sources);
  const coverage = buildSourceCoverage(sources, reqs, plans);
  const durationDetails = findMilestoneDurationIssues(plans);
  const docCounts = { prd: 0, design: 0, test: 0 };
  for (const s of sources) docCounts[s.role ?? 'prd'] += 1;
  return {
    docCounts,
    reqCount: reqs.length,
    planCount: plans.length,
    milestoneCount: plans.filter((p) => p.kind === 'milestone').length,
    wbsGroups: detectWbsGroups(plans).groups,
    duplicateGroups: dup.length,
    duplicateRows: dup.reduce((n, g) => n + g.indexes.length - 1, 0),
    gapFillRows: plans.filter(isGapFillPlan).length,
    constraintReqs: detectConstraintReqs(reqs).length,
    unattributedReqs: reqs.filter((r) => !/^(§|\d+\.\d+|Q-\d+)/.test((r.sourceRef ?? '').trim())).length,
    durationIssues: durationDetails.length,
    versionConflicts: conflicts.length,
    inferredFieldRows: plans.length, // 工期/复杂度/优先级/排期均无源文档依据
    coverageGaps: coverage.reduce((n, g) => n + g.missing.length, 0),
    conflicts,
    coverage,
    durationDetails,
    duplicateExamples: dup.slice(0, 8).map((g) => g.titles.slice(0, 3).join(' ≈ ')),
  };
}

/** 日志播报用的一行摘要（不换行、控制在可读长度） */
export function formatQualitySummary(s: QualitySummary): string {
  return `导入质量自检：来源文档 ${s.docCounts.prd} 份 PRD / ${s.docCounts.design} 份设计 / ${s.docCounts.test} 份测试；`
    + `${s.reqCount} 需求、${s.planCount} 计划（${s.milestoneCount} 里程碑）；`
    + `WBS ${s.wbsGroups} 套、同题重复 ${s.duplicateRows} 行、占位 ${s.gapFillRows} 行、工期不符 ${s.durationIssues} 个、`
    + `否定口径 ${s.constraintReqs} 条、溯源未标注 ${s.unattributedReqs} 条、版本冲突 ${s.versionConflicts} 项、覆盖缺口 ${s.coverageGaps} 项；`
    + `另有 ${s.inferredFieldRows} 行工期/复杂度/优先级属推定值（源文档无依据）`;
}

/**
 * 一键归一化（用户确认后才调用）：
 * ① 归一化同题计划只留首见，其余 include=false（**不删行**，可勾回）；
 * ② 仍保留的里程碑统一编号为 M1…Mn，去掉互相冲突的原章号/M 编号；
 * ③ 排除占位行后再按「里程碑=其下明细之和」重算工期。
 * 返回新数组与变更计数，调用方负责 setPlans 与播报。
 */
export function normalizeWbs(plans: ReadonlyArray<QualityPlan>): {
  plans: QualityPlan[];
  disabledRows: number;
  renumberedMilestones: number;
  groupsBefore: number;
  groupsAfter: number;
  durationIssuesAfter: number;
} {
  const groupsBefore = detectWbsGroups(plans).groups;
  const out = plans.map((p) => ({ ...p }));
  let disabledRows = 0;
  // T05438（P0-1）：先按「套」处理——多套并行 WBS 默认只保留第一套，其余套整段取消勾选
  // （行不删，用户可勾回）。旧实现只按「标题完全相同」去重，而分片各产一套时标题是不同的业务条目，
  // 去重命中不了，于是 5 套阶段并列进计划树（实测 1.1 出现 5 次、19 个里程碑分属 5 套）。
  const ranges = splitWbsGroupRanges(out);
  for (const r of ranges.slice(1)) {
    for (let i = r.start; i < r.end; i += 1) {
      if (out[i].include !== false) { out[i].include = false; disabledRows += 1; }
    }
  }
  const seen = new Set<string>();
  out.forEach((p) => {
    // 占位行按 REQ 编号区分，不参与同题去重（归一化后标题相同，会被整批误取消勾选）
    if (isGapFillPlan(p)) return;
    const key = normalizePlanTitle(p.title ?? '');
    if (!key) return;
    if (seen.has(key)) { p.include = false; disabledRows += 1; }
    else seen.add(key);
  });
  let mi = 0;
  let renumberedMilestones = 0;
  out.forEach((p) => {
    if (p.kind !== 'milestone' || p.include === false) return;
    mi += 1;
    const body = (p.title ?? '')
      .replace(/^\s*\d+(?:\.\d+)*\s*(?:M\d+)?\s*/i, '')
      .replace(/^\s*M\d+\s*/i, '')
      .trim();
    const next = `M${mi} ${body || p.title}`;
    if (next !== p.title) { p.title = next; renumberedMilestones += 1; }
  });
  // 工期重算：跳过未勾选行与占位行（与服务端补边口径一致）
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'milestone' || out[i].include === false) continue;
    let sum = 0;
    for (let j = i + 1; j < out.length; j++) {
      if (out[j].kind === 'milestone' && out[j].include !== false) break;
      if (out[j].include === false || isGapFillPlan(out[j])) continue;
      sum += Math.max(1, Math.round(Number(out[j].durationDays) || 1));
    }
    if (sum > 0) out[i].durationDays = sum;
  }
  return {
    plans: out,
    disabledRows,
    renumberedMilestones,
    groupsBefore,
    // 归一后的套数/工期问题只统计「仍勾选」的行，否则取消勾选的套会把指标继续算进去
    groupsAfter: detectWbsGroups(out.filter((p) => p.include !== false)).groups,
    durationIssuesAfter: findMilestoneDurationIssues(out.filter((p) => p.include !== false)).length,
  };
}

/**
 * T05575：覆盖缺口一键处置——把「原文有、解析结果无」的编号补成 normal 计划行。
 * 与 server/src/util/prdWbs.ts 的 applySourceEntryGapFill 同口径（description 以「自动补齐：」开头，
 * 因此不参与同题去重、不计入里程碑工期、可被质量卡单独统计与取消勾选）。
 * 返回新数组，不修改入参。
 */
export function appendCoverageGapPlans(
  plans: ReadonlyArray<QualityPlan>,
  coverage: ReadonlyArray<CoverageGroup>,
): { plans: QualityPlan[]; added: number } {
  const out = plans.map((p) => ({ ...p }));
  const existing = new Set(out.map((p) => p.title ?? ''));
  let added = 0;
  for (const g of coverage) {
    for (const id of g.missing ?? []) {
      const title = `${id} ${g.label}（源文档条目）`;
      if (existing.has(title)) continue;
      out.push({
        title,
        description: `自动补齐：源文档条目 ${g.label} ${id}——原文有该编号，解析结果未覆盖，请人工确认是否需要开发或改为验收项`,
        durationDays: 1,
        kind: 'normal',
        reqNos: [],
        include: true,
      });
      existing.add(title);
      added += 1;
    }
  }
  return { plans: out, added };
}

/** 一键取消勾选否定口径需求（返回新数组与取消条数） */
export function disableConstraintReqs(reqs: ReadonlyArray<QualityReq>): { reqs: QualityReq[]; disabled: number } {
  let disabled = 0;
  const out = reqs.map((r) => {
    if (!isConstraintReq(r) || r.include === false) return { ...r };
    disabled += 1;
    return { ...r, include: false };
  });
  return { reqs: out, disabled };
}
