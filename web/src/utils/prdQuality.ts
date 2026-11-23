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
  /** 2026-11-17：需求类型（FR/NFR/AC/EX/RISK/OPEN/REF/CONTEXT） */
  type?: string;
  acceptanceRefs?: string[];
  priority?: string;
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
  /** 2026-11-17：结构字段（与 server/src/services/PlanService 的 PrdPlanExtras 同口径） */
  wbsCode?: string;
  parentCode?: string;
  phaseCode?: string;
  priority?: string;
  sourceSection?: string;
  deliverable?: string;
  acceptanceRefs?: string[];
  dependsOn?: string[];
  taskType?: string;
  estimateDays?: number;
  /** 系统补齐的覆盖模板：只作编辑草稿，默认不勾选、不计入覆盖 */
  gapFill?: boolean;
}

export interface QualitySource {
  name: string;
  text: string;
  role?: 'prd' | 'design' | 'test';
}

/** 否定/已闭环/不改造口径：这些是约束或验收项，不应作为「待开发需求」直接排期 */
export const CONSTRAINT_RE =
  /不新增|不变|不改造|不实施|不修正|不实现|不删|不迁移|不做|不得|废止|失效|禁止|仅移除|保持现状|保留不删|不下线|已闭环|已落地|无需开发|不参与|不新增下发/;

/** 只判标题——content 里大量「不」是正常业务描述（如「开关关闭时不读最低利率」）。
 *  2026-11-17：AC 验收项标题出现「禁止/不得」是验收语义（例如「自动 D 链路禁止自动开 GUI」），
 *  不是待开发约束；把 AC 当成否定口径会误触发「取消勾选」并制造新的覆盖缺口。 */
export function isConstraintReq(r: Pick<QualityReq, 'title' | 'type' | 'reqNo'> & { sourceRef?: string }): boolean {
  if ((r.type ?? '').toUpperCase() === 'AC' || /^AC[-_.]?\d/i.test(r.reqNo ?? '') || /验收标准/.test(r.sourceRef ?? '')) return false;
  return CONSTRAINT_RE.test(r.title ?? '');
}

export function detectConstraintReqs(reqs: ReadonlyArray<QualityReq>): QualityReq[] {
  return reqs.filter(isConstraintReq);
}

/** 系统自动补齐的占位行：只认 description 前缀/显式标记；REQ- 编号只是来源标识，不再一刀切判占位 */
export function isGapFillPlan(p: Pick<QualityPlan, 'title' | 'description'> & { gapFill?: boolean }): boolean {
  if (p.gapFill === true) return true;
  return (p.description ?? '').startsWith('自动补齐：');
}

/** 标题归一化：去掉 WBS 编号前缀、空白与常见标点，用于跨片同题去重 */
export function normalizePlanTitle(title: string): string {
  return (title ?? '')
    .replace(/^\s*\d+(?:\.\d+)*\s*(?:M\d+)?\s*/i, '')
    .replace(/^\s*M\d+\s*/i, '')
    .replace(/^REQ-\d+\s*/i, '')
    // 2026-11-21：系统覆盖卡用（2）…（12）区分；尾序号不剥离会让 12 张同题卡被统计成 0 组重复。
    .replace(/\s*[（(]\s*\d+\s*[)）]\s*$/i, '')
    // 只去空白/标点/符号，**不能**用 [\s\W_]：JS 的 \W 会把中文一并当作非单词字符删掉，
    // 导致所有纯中文标题归一化为 ''，跨片同题去重全部失效（质量门 A-02 实测捕获）。
    .replaceAll(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/** 阶段族：数字章号（1/2/5.3/M1）或标签族（P0/P1/EX/Q/F/R） */
type PhaseKey = { kind: 'num'; n: number } | { kind: 'label'; label: string };

function phaseKeyOf(title: string): PhaseKey | null {
  const t = (title ?? '').trim();
  const num = /^(?:M)?(\d+)(?:\s|\.|$)/i.exec(t);
  if (num) return { kind: 'num', n: Number(num[1]) };
  const label = /^(P0|P1|EX|Q|F|R)(?:[-\s.]|$)/i.exec(t);
  if (label) return { kind: 'label', label: label[1].toUpperCase() };
  return null;
}

/** 多套 WBS 检测：数字章号回退，或阶段族切换（数字↔标签族、标签族彼此切换）即新的一套。
 *  与服务端 prdWbs.detectWbsGroups 同口径，避免前端说 3 套、后端说 2 套。 */
export function detectWbsGroups(plans: ReadonlyArray<QualityPlan>): {
  groups: number;
  milestones: number;
  groupStartTitles: string[];
  families: string[];
} {
  const ms = plans.filter((p) => p.kind === 'milestone');
  if (ms.length === 0) return { groups: 0, milestones: 0, groupStartTitles: [], families: [] };
  let groups = 1;
  const groupStartTitles: string[] = [ms[0].title];
  const families: string[] = [];
  let prev: PhaseKey | null = phaseKeyOf(ms[0].title ?? '');
  families.push(prev ? (prev.kind === 'num' ? `num:${prev.n}` : `label:${prev.label}`) : 'unknown');
  for (let i = 1; i < ms.length; i += 1) {
    const cur = phaseKeyOf(ms[i].title ?? '');
    let nextGroup = false;
    if (prev && cur) {
      if (prev.kind !== cur.kind) nextGroup = true;
      else if (cur.kind === 'num' && prev.kind === 'num' && cur.n <= prev.n) nextGroup = true;
      else if (cur.kind === 'label' && prev.kind === 'label' && cur.label !== prev.label) nextGroup = true;
    }
    if (nextGroup) {
      groups += 1;
      groupStartTitles.push(ms[i].title);
    }
    if (cur) {
      families.push(cur.kind === 'num' ? `num:${cur.n}` : `label:${cur.label}`);
      prev = cur;
    }
  }
  return { groups, milestones: ms.length, groupStartTitles, families };
}

/** 按检测到的同一套判据切分 WBS 行区间 `[start,end)`：每套从该套首个里程碑到下一套首个里程碑之前。 */
export function splitWbsGroupRanges(plans: ReadonlyArray<QualityPlan>): Array<{ start: number; end: number }> {
  const ms: Array<{ p: QualityPlan; i: number }> = [];
  plans.forEach((p, i) => { if (p.kind === 'milestone') ms.push({ p, i }); });
  if (ms.length === 0) return [];
  const groupStartMs: number[] = [0];
  let prev: PhaseKey | null = phaseKeyOf(ms[0].p.title ?? '');
  ms.forEach((x, k) => {
    if (k === 0) return;
    const cur = phaseKeyOf(x.p.title ?? '');
    let next = false;
    if (prev && cur) {
      if (prev.kind !== cur.kind) next = true;
      else if (cur.kind === 'num' && prev.kind === 'num' && cur.n <= prev.n) next = true;
      else if (cur.kind === 'label' && prev.kind === 'label' && cur.label !== prev.label) next = true;
    }
    if (next) groupStartMs.push(k);
    if (cur) prev = cur;
  });
  return groupStartMs.map((k, gi) => ({
    start: ms[k].i,
    end: gi + 1 < groupStartMs.length ? ms[groupStartMs[gi + 1]].i : plans.length,
  }));
}

/** 系统兜底的「需求追溯与覆盖核对」卡：按不同需求组拆成多张，标题只差序号，
 *  语义上不是重复任务；同题去重不能把它们算成重复行（真正的重复卡由导入侧幂等去重消除）。 */
export function isPrdCoveragePlan(p: Pick<QualityPlan, 'title'>): boolean {
  return /需求追溯与覆盖核对/.test(p.title ?? '');
}

/** 设计/运维/工程治理类支撑任务（enabler）：架构评审、风险登记册、环境准备、代码审查与清理等。
 *  它们可以是合法交付物，但必须有足够描述；带章节溯源时优先放行，工程治理类标题可在无章节时按标题识别。
 *  实现/测试类零关联仍按孤儿阻断。 */
export function isEnablerPlan(p: Pick<QualityPlan, 'title' | 'taskType' | 'sourceSection' | 'description'>): boolean {
  const type = (p.taskType ?? '').toLowerCase();
  const explicitSupport = type === 'design' || type === 'ops' || type === 'enabler';
  const sourced = /§\s*\d+(?:\.\d+)*/.test(p.sourceSection ?? '');
  const descOk = (p.description ?? '').replace(/\s/g, '').length >= 50;
  if (explicitSupport) return sourced && descOk;
  // 2026-11-22：AirMirror「代码审查与清理」被模型标成 verify 且未关联需求——它是跨需求的工程治理动作，
  // 不是某条功能的实现/验收卡。标题语义足够明确时按 enabler 放行，避免为了过门强行挂一条无关需求。
  const engineeringGovernance = /代码审查|代码评审|代码清理|代码重构|技术债|静态代码检查|静态扫描|死代码|重复代码|编码规范|依赖清理|依赖升级/.test(p.title ?? '')
    && !/^(?:实现|开发|新增|接入|支持)/.test((p.title ?? '').trim());
  return engineeringGovernance && descOk;
}

/** 同题计划分组（归一化标题相同即一组），返回重复组明细 */
export function findDuplicatePlanGroups(plans: ReadonlyArray<QualityPlan>): Array<{ key: string; titles: string[]; indexes: number[] }> {
  const byKey = new Map<string, { titles: string[]; indexes: number[] }>();
  plans.forEach((p, i) => {
    // 系统补齐占位行按 REQ 编号区分，归一化后全叫「相关实现」——必须排除，否则 22 行会被误判成一组重复
    if (isGapFillPlan(p)) return;
    // 覆盖核对卡是按需求组拆分的系统卡（标题带（2）…（N）），不是重复执行任务
    if (isPrdCoveragePlan(p)) return;
    const key = normalizePlanTitle(p.title ?? '');
    if (!key) return;
    const g = byKey.get(key);
    if (g) { g.titles.push(p.title); g.indexes.push(i); }
    else byKey.set(key, { titles: [p.title], indexes: [i] });
  });
  return Array.from(byKey.values()).filter((g) => g.indexes.length > 1).map((g, i) => ({ key: `dup-${i}`, ...g }));
}

/** 从显式字段/标题前缀推出 WBS 编号（与服务端 prdWbs.wbsCodeOf 同口径） */
export function planWbsCodeOf(p: Pick<QualityPlan, 'title' | 'wbsCode'>): string {
  const explicit = (p.wbsCode ?? '').trim();
  if (explicit) return explicit;
  const m = /^(M\d+(?:\.\d+)*|\d+(?:\.\d+)*|P[01]-\d+(?:\.\d+)*|EX|Q|F|R-\d+(?:\.\d+)*)\s+/i.exec((p.title ?? '').trim());
  return m ? m[1].replace(/^m/i, 'M') : '';
}

/** 父编号：显式 parentCode 优先；否则按 wbsCode 点分层级推导（M1.1 → M1）。 */
export function planParentCodeOf(p: Pick<QualityPlan, 'title' | 'kind' | 'wbsCode' | 'parentCode'>): string {
  if (p.kind === 'milestone') return '';
  const explicit = (p.parentCode ?? '').trim();
  if (explicit) return explicit;
  const code = planWbsCodeOf(p);
  return code.includes('.') ? code.slice(0, code.lastIndexOf('.')) : '';
}

/** 沿 parentCode 向上找归属里程碑；找不到返回 -1（供结构化工期汇总用）。 */
function milestoneOwnerOf(plans: ReadonlyArray<QualityPlan>, index: number): number {
  let cur = index;
  for (let guard = 0; guard < 16; guard += 1) {
    const p = plans[cur];
    if (!p) return -1;
    if (p.kind === 'milestone') return cur;
    const parentCode = planParentCodeOf(p);
    if (!parentCode) return -1;
    const parentIdx = plans.findIndex((x) => planWbsCodeOf(x) === parentCode);
    if (parentIdx < 0) return -1;
    cur = parentIdx;
  }
  return -1;
}

/** 里程碑工期 = 其下勾选明细之和；返回不符清单。
 *  2026-11-22：结构字段（wbsCode/parentCode）优先——旧实现按「下一里程碑之前」的行序区间统计，
 *  当模型把 5 个里程碑集中输出在文档前部、明细集中在末尾时，会把所有明细都算到最后一座里程碑，
 *  误报「M5 23≠123」。覆盖核对卡是管理动作，不计入交付工期。 */
export function findMilestoneDurationIssues(plans: ReadonlyArray<QualityPlan>): Array<{
  title: string; index: number; declared: number; computed: number; children: number;
}> {
  const out: Array<{ title: string; index: number; declared: number; computed: number; children: number }> = [];
  const structured = plans.some((p) => !!planWbsCodeOf(p) || !!planParentCodeOf(p));
  for (let i = 0; i < plans.length; i++) {
    if (plans[i].kind !== 'milestone' || plans[i].include === false) continue;
    let sum = 0;
    let children = 0;
    if (structured) {
      for (let j = 0; j < plans.length; j += 1) {
        const child = plans[j];
        if (j === i || child.kind === 'milestone' || child.include === false) continue;
        if (isGapFillPlan(child) || isPrdCoveragePlan(child)) continue;
        if (milestoneOwnerOf(plans, j) !== i) continue;
        sum += Math.max(1, Math.round(Number(child.durationDays) || 1));
        children += 1;
      }
    } else {
      for (let j = i + 1; j < plans.length; j++) {
        if (plans[j].kind === 'milestone') break;
        if (plans[j].include === false) continue;
        // 与服务端 milestoneDurations / intervalChildEdges 同一口径：系统补齐占位行、覆盖核对卡不计入里程碑工期
        if (isGapFillPlan(plans[j]) || isPrdCoveragePlan(plans[j])) continue;
        sum += Math.max(1, Math.round(Number(plans[j].durationDays) || 1));
        children += 1;
      }
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
      const cleaned = line.replaceAll(RANGE_RE, (m) => ' '.repeat(m.length));
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
  /** §x.y 只是章节定位锚点；Dx 是设计决策标题。两者缺失都只提示，不参与硬阻断/一键补计划。 */
  soft?: boolean;
}

/** 从源文档抽取「可核对的条目编号」，与解析结果比对，给出覆盖率与缺口 */
export function buildSourceCoverage(
  sources: ReadonlyArray<QualitySource>,
  reqs: ReadonlyArray<QualityReq>,
  plans: ReadonlyArray<QualityPlan>,
): CoverageGroup[] {
  // 未勾选的行不参与导入，也不得被当成“已覆盖”：否则点“补齐”生成未勾选模板后，
  // 覆盖缺口会假归零，导入时却因模板行被过滤而丢掉这些条目。
  const activeReqs = reqs.filter((r) => r.include !== false);
  const activePlans = plans.filter((p) => p.include !== false);
  const docText = sources.map((s) => s.text ?? '').join('\n');
  const resultText = [
    ...activeReqs.map((r) => `${r.sourceRef ?? ''} ${r.title ?? ''} ${r.content ?? ''}`),
    ...activePlans.map((p) => `${p.title ?? ''} ${p.description ?? ''} ${p.sourceSection ?? ''}`),
  ].join('\n');

  const specs: Array<{ label: string; re: RegExp; soft?: boolean; ctx?: RegExp; ctxFor?: (id: string) => RegExp }> = [
    // 章节号用于定位，不是需求条目；解析结果通常只保留「1.3 目标 G1」而不写 §1.3。
    // 把它算成硬缺口会让一份正常 PRD 每次都要求补 20~40 条占位计划（2026-11-17 实测 39 项全为 §）。
    { label: '章节 §x.y（仅定位，不阻断）', re: /(?:§|^|\s)(\d{1,2}\.\d{1,2})(?:[\s\-A-Z]|$)/gm, soft: true },
    { label: '确认项 Q-xx', re: /\bQ-\d{2}\b/g, ctx: /待确认|确认项|待回复|问题/ },
    { label: '脚本 Sx / S3-x', re: /\bS3-[BCD]\b|\bS[1-4]\b/g, ctx: /脚本|步骤|用例|测试/ },
    { label: '设计决策 Dx（仅提示）', re: /\bD[1-7]\b/g, ctx: /设计|决策|方案/, soft: true },
    // 回归场景必须与编号相邻（R1 回归 / 回归场景 R1）；只看 ±60 字窗口会把「功能不回归 … R2」误判成缺口。
    { label: '回归场景 Rx', re: /\bR(?:10|[1-9])\b/g, ctxFor: (id) => new RegExp(`(?:${id}\\s*[：:、-]?\\s*回归)|(?:回归(?:场景|用例)?\\s*[：:、-]?\\s*${id})`) },
    { label: '核实项 Tx', re: /\bT(?:11|10|[1-9])\b/g, ctx: /核实|验证|测试/ },
    { label: '偏差 N-x', re: /\bN-[1-5]\b/g, ctx: /偏差|差异|偏离/ },
    { label: '开放项 Ox', re: /\bO[1-5]\b/g, ctx: /开放项|待定|待确认|待回复|风险/ },
  ];
  return specs.map(({ label, re, soft, ctx, ctxFor }) => {
    const ids = new Set<string>();
    let m: RegExpExecArray | null;
    const source = new RegExp(re.source, re.flags);
    while ((m = source.exec(docText)) !== null) {
      // 2026-11-22：短编号必须结合上下文判定。AutoClicker PRD 的 O1~O5 是「目标」、S1~S5 是「用户场景」、
      // R1~R3 是「发布批次」，都不是待补的条目；只按 \bO1/\bS1/\bR1 抓取会制造 11 个假硬缺口并阻断导入。
      const raw = m[1] ? `§${m[1]}` : m[0];
      const testRe = ctxFor ? ctxFor(raw) : ctx;
      if (testRe) {
        const lineStart = docText.lastIndexOf('\n', m.index) + 1;
        const lineEndRaw = docText.indexOf('\n', m.index);
        const lineEnd = lineEndRaw < 0 ? docText.length : lineEndRaw;
        const line = docText.slice(lineStart, lineEnd);
        const win = docText.slice(Math.max(0, m.index - 60), Math.min(docText.length, m.index + m[0].length + 60));
        if (!testRe.test(`${line}\n${win}`)) continue;
      }
      ids.add(raw);
    }
    const missing: string[] = [];
    const covered = new Set<string>();
    for (const id of ids) {
      const needle = id.startsWith('§') ? id.slice(1) : id;
      // 短编号（D1/R1/T1/S1）必须按「非字母数字边界」匹配，否则会被 REQ-001 / 正文里的数字误命中
      const escaped = needle.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hit = needle.length <= 3
        ? new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`).test(resultText)
        : resultText.includes(needle);
      if (hit) covered.add(id);
      else missing.push(id);
    }
    // 需求编号含数字后缀（R2/R10），必须按自然序排，否则 R10 会排到 R2 前面
    missing.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
    return { label, total: ids.size, covered: covered.size, missing, soft: !!soft };
  });
}

/** 需求引用编号归一：AC-01 / ac_1 / AC-1 视为同一验收项；REQ-1 / REQ-001 视为同一需求。
 *  质量门两侧（需求行 reqNo 与计划 acceptanceRefs/reqNos）必须用同一把尺子，
 *  否则编号写法漂移会制造「AC 未映射」假阻断。 */
export function normalizeReqRefKey(raw: string): string {
  const s = (raw ?? '').trim().toUpperCase().replaceAll('_', '-').replaceAll(' ', '-');
  // 2026-11-21：模型会把 AC 写成 REQ-AC-01；必须与 AC-01 视为同一验收项。
  const ac = /^(?:REQ-?)?AC-?0*(\d+)$/.exec(s);
  if (ac) return `AC-${Number(ac[1])}`;
  const req = /^(?:REQ(?:UIREMENT)?|R)?-?0*(\d+)$/.exec(s);
  if (req) return `REQ-${String(Number(req[1])).padStart(3, '0')}`;
  return s;
}

export type ImportReadiness = 'ready' | 'needs_review' | 'blocked';

/** 2026-11-17 质量门：与 server/src/services/PlanService.validatePrdImportDraft 同口径的前端只读版本。
 *  前端用它决定「生成可执行计划」是否可点、树形预演列出哪些阻断项；后端仍会二次校验。 */
export function evaluateImportReadiness(
  reqs: ReadonlyArray<QualityReq>,
  plans: ReadonlyArray<QualityPlan>,
): { readiness: ImportReadiness; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ms = plans.filter((p) => p.kind === 'milestone');
  // 2026-11-22：覆盖核对卡是管理动作，不是交付任务——不占 45 条 executable 上限，也不计入里程碑工期。
  const allNormals = plans.filter((p) => p.kind !== 'milestone');
  const coveragePlans = allNormals.filter(isPrdCoveragePlan);
  const normals = allNormals.filter((p) => !isPrdCoveragePlan(p));
  const groups = detectWbsGroups(plans);
  if (groups.groups > 1) errors.push(`检测到 ${groups.groups} 套并行 WBS（${groups.groupStartTitles.slice(0, 5).join(' / ')}…）——必须收敛为一套 5~6 个里程碑`);
  const durationIssues = findMilestoneDurationIssues(plans);
  if (durationIssues.length > 0) {
    errors.push(`里程碑工期与子项不符 ${durationIssues.length} 个（${durationIssues.slice(0, 3).map((x) => `「${x.title}」${x.declared}≠${x.computed}`).join('、')}）——请重算后再导入`);
  }
  const zeroLinkedNormals = normals.filter((p) => {
    if (isGapFillPlan(p)) return false;
    const links = new Set([...(p.reqNos ?? []), ...(p.acceptanceRefs ?? [])].map(normalizeReqRefKey).filter(Boolean));
    return links.size === 0;
  });
  // 设计/运维类支撑任务是合法 enabler（架构评审、风险登记册等），带章节溯源时不应按「孤儿任务」阻断；
  // 实现/测试类零关联仍必须阻断（上一轮 AirMirror P1 预留接口验证即属此类）。
  const zeroLinkedEnablers = zeroLinkedNormals.filter(isEnablerPlan);
  const zeroLinkedImplementations = zeroLinkedNormals.filter((p) => !isEnablerPlan(p));
  if (zeroLinkedImplementations.length > 0) {
    const detail = zeroLinkedImplementations.slice(0, 5).map((p) => {
      const code = (p.wbsCode ?? '').trim();
      return `「${p.title}」${code ? `（${code}）` : ''}`;
    }).join('、');
    errors.push(`有 ${zeroLinkedImplementations.length} 条任务未关联任何需求/验收项（${detail}）——请补关联或删除`);
  }
  if (zeroLinkedEnablers.length > 0) {
    const detail = zeroLinkedEnablers.slice(0, 3).map((p) => `「${p.title}」`).join('、');
    warnings.push(`有 ${zeroLinkedEnablers.length} 条设计/运维/工程治理类支撑任务未关联需求（${detail}）——已按章节溯源或标题语义放行，确认是否本期交付`);
  }
  // 覆盖核对卡按需求组拆分；同一需求被两张卡重复承接时，待办会出现「同一件事做两遍」。
  const coverageRefs = new Set<string>();
  if (coveragePlans.length > 0) {
    const seen = new Set<string>();
    let dup = 0;
    for (const p of coveragePlans) {
      // 同一张卡里 reqNos 与 acceptanceRefs 本来就允许重叠（AC 同时是需求和验收引用），
      // 只有「跨卡重复」才代表同一需求被两张覆盖卡承接。
      const cardRefs = new Set([...(p.reqNos ?? []), ...(p.acceptanceRefs ?? [])].map(normalizeReqRefKey).filter(Boolean));
      for (const ref of cardRefs) {
        coverageRefs.add(ref);
        if (seen.has(ref)) dup += 1; else seen.add(ref);
      }
    }
    if (dup > 0) {
      errors.push(`覆盖核对卡有 ${dup} 个跨卡重复需求引用（如「${coveragePlans[0].title}」）——同一需求只能由一张覆盖卡承接`);
    }
    const needed = Math.ceil(seen.size / 6);
    if (coveragePlans.length > needed) {
      errors.push(`覆盖核对卡 ${coveragePlans.length} 张，超过 ${seen.size} 条需求所需 ${needed} 张——请合并重复卡`);
    }
  }
  // 覆盖核对只是管理动作，不能替代实现/验收卡；P0 仅被覆盖卡承接必须阻断，P1 强提示。
  const realRefs = new Set<string>();
  for (const p of normals) {
    if (isPrdCoveragePlan(p)) continue;
    for (const ref of [...(p.reqNos ?? []), ...(p.acceptanceRefs ?? [])].map(normalizeReqRefKey)) {
      if (ref) realRefs.add(ref);
    }
  }
  const onlyCoverageReqs = reqs.filter((r) => {
    if (/p[23]/i.test(r.priority ?? '') || !r.reqNo) return false;
    const key = normalizeReqRefKey(r.reqNo);
    return !!key && coverageRefs.has(key) && !realRefs.has(key);
  });
  const onlyCoverageP0 = onlyCoverageReqs.filter((r) => /p0/i.test(r.priority ?? ''));
  if (onlyCoverageP0.length > 0) {
    errors.push(`有 ${onlyCoverageP0.length} 条 P0 需求只被覆盖核对卡承接、没有实现/验收任务（${onlyCoverageP0.slice(0, 5).map((r) => r.reqNo).join('、')}）——请补真实交付任务`);
  } else if (onlyCoverageReqs.length > 0) {
    warnings.push(`有 ${onlyCoverageReqs.length} 条 P1 需求只被覆盖核对卡承接（${onlyCoverageReqs.slice(0, 5).map((r) => r.reqNo).join('、')}）——确认是否进入本期交付`);
  }
  if (ms.length > 8) errors.push(`里程碑 ${ms.length} 个，超过上限 8 个——请合并阶段，保留 5~6 个交付阶段`);
  if (ms.length < 5) warnings.push(`里程碑只有 ${ms.length} 个，低于建议的 5~6 个`);
  // 2026-11-22：结构退化诊断——模型有时把 5 个里程碑集中输出在文档前部，再把全部明细挂到最后一个里程碑。
  // 按树汇总后工期可能自洽（123=123），但前 4 个阶段为空，甘特/待办仍失真；这里只提示，交由人工按阶段拆分。
  const structuredForOwner = plans.some((p) => !!planWbsCodeOf(p) || !!planParentCodeOf(p));
  if (structuredForOwner && ms.length >= 3 && normals.length >= 10) {
    const ownerCounts = ms.map(() => 0);
    for (let i = 0; i < plans.length; i += 1) {
      if (plans[i].kind === 'milestone' || plans[i].include === false) continue;
      if (isGapFillPlan(plans[i]) || isPrdCoveragePlan(plans[i])) continue;
      const owner = milestoneOwnerOf(plans, i);
      if (owner >= 0) ownerCounts[ms.indexOf(plans[owner])] += 1;
    }
    const maxCount = Math.max(...ownerCounts);
    const emptyStages = ownerCounts.filter((n) => n === 0).length;
    if (maxCount / normals.length >= 0.8 && emptyStages >= 2) {
      const topIdx = ownerCounts.indexOf(maxCount);
      warnings.push(`WBS 阶段分布失衡：${ms[topIdx]?.title ?? '最后一个里程碑'} 承接 ${maxCount}/${normals.length} 条任务，${emptyStages} 个阶段为空——请按 parentCode 把任务拆回对应阶段，否则甘特与待办会集中在一处`);
    }
  }
  if (normals.length > 45) errors.push(`可执行任务 ${normals.length} 条，超过上限 45 条——粒度过细，请合并同一交付物`);
  if (normals.length < 20) warnings.push(`可执行任务只有 ${normals.length} 条，低于建议的 30~40 条，可能漏项`);
  if (normals.length === 0) errors.push('没有任何可执行任务（normal）——里程碑不能独立交付');
  const missingPriority = normals.filter((p) => !/p[01]/i.test(p.priority ?? ''));
  if (missingPriority.length > 0) errors.push(`有 ${missingPriority.length} 条 normal 未写 P0/P1 优先级（如「${missingPriority[0].title}」）——必须显式标注优先级`);
  const missingStructure = normals.filter((p) => !p.wbsCode || !p.parentCode);
  if (missingStructure.length > 0) errors.push(`有 ${missingStructure.length} 条 normal 缺少 wbsCode/parentCode（如「${missingStructure[0].title}」）——会挂不到里程碑成为孤儿`);
  const gap = plans.filter(isGapFillPlan);
  if (gap.length > 0) errors.push(`存在 ${gap.length} 条系统补齐占位行（如「${gap[0].title}」）——请改写或取消勾选`);
  const fragmentRe = /§|\||`|\.(?:tsx?|jsx?|json|md|sql|py)$/i;
  const fragments = plans.filter((p) => fragmentRe.test((p.title ?? '').trim()));
  if (fragments.length > 0) errors.push(`存在 ${fragments.length} 条碎片标题（如「${fragments[0].title}」）——标题应是可交付动作`);
  const thinP0 = plans.filter((p) => p.kind !== 'milestone' && /p[01]/i.test(p.priority ?? '') && (p.description ?? '').replace(/\s/g, '').length < 50);
  if (thinP0.length > 0) errors.push(`P0/P1 任务 ${thinP0.length} 条描述不足 50 字（如「${thinP0[0].title}」）——执行卡必须写清动作、边界与验收`);
  const structured = plans.some((p) => !!p.wbsCode || !!p.parentCode);
  if (structured) {
    const orphans = normals.filter((p) => !p.parentCode && !(p.wbsCode ?? '').includes('.') && !(p.dependsOn ?? []).length);
    if (orphans.length > 0) errors.push(`存在 ${orphans.length} 条父节点缺失/孤儿任务（如「${orphans[0].title}」）`);
    const withParent = normals.filter((p) => !!p.parentCode || (p.wbsCode ?? '').includes('.')).length;
    if (withParent === 0) errors.push('0 条真实父子依赖——任务没有挂到任何里程碑，无法按阶段推进');
  }
  // P2/P3 验收项按范围闸门不进入本期计划；它们未映射不是质量缺陷，不能阻断本期导入。
  const acReqs = reqs.filter((r) => !/p[23]/i.test(r.priority ?? '')
    && (r.type === 'AC' || /^AC[-_.]?\d/i.test(r.reqNo ?? '') || /验收标准/.test(r.sourceRef ?? '')));
  if (acReqs.length > 0) {
    const mapped = new Set<string>();
    for (const p of plans) {
      for (const ref of p.acceptanceRefs ?? []) mapped.add(normalizeReqRefKey(ref));
      for (const r of p.reqNos ?? []) mapped.add(normalizeReqRefKey(r));
    }
    const unmapped = acReqs.filter((r) => !!r.reqNo && !mapped.has(normalizeReqRefKey(r.reqNo)));
    if (unmapped.length > 0) errors.push(`AC 未映射：${unmapped.length} 条验收标准没有任何任务承接（${unmapped.slice(0, 5).map((x) => x.reqNo).join('、')}）`);
  } else {
    warnings.push('未识别到 AC 类型需求——验收标准覆盖无法校验');
  }
  const p2p3 = plans.filter((p) => /p[23]/i.test(p.priority ?? ''));
  if (p2p3.length > 0) errors.push(`P2/P3 条目 ${p2p3.length} 条进入了本次排期（如「${p2p3[0].title}」）——请取消勾选或拆到后续批次`);
  // 2026-11-18：覆盖兜底/骨架模式容易把多条需求堆到一条测试卡；这些不阻断，但必须在导入前可见。
  // 关联数按 reqNos ∪ acceptanceRefs 计——只数 reqNos 会漏掉「1 条 REQ + 6 条 AC」的假轻载。
  const heavyReqRows = normals.filter((p) => new Set([
    ...(p.reqNos ?? []).map((x) => normalizeReqRefKey(x)),
    ...(p.acceptanceRefs ?? []).map((x) => normalizeReqRefKey(x)),
  ].filter(Boolean)).size > 6);
  if (heavyReqRows.length > 0) {
    warnings.push(`有 ${heavyReqRows.length} 条任务关联需求超过 6 条（如「${heavyReqRows[0].title}」关联 ${new Set([...(heavyReqRows[0].reqNos ?? []), ...(heavyReqRows[0].acceptanceRefs ?? [])]).size} 条）——建议拆分或迁移到语义相近的任务`);
  }
  const longNormalRows = normals.filter((p) => (p.description ?? '').replace(/\s/g, '').length > 800);
  if (longNormalRows.length > 0) {
    warnings.push(`有 ${longNormalRows.length} 条任务描述超过 800 字（如「${longNormalRows[0].title}」）——建议把长需求原文留在矩阵，执行卡只保留直接相关的 4~6 条`);
  }
  const reqTitleGroups = new Map<string, string[]>();
  for (const r of reqs) {
    const key = (r.title ?? '').replace(/\s/g, '').toLowerCase();
    if (!key) continue;
    const list = reqTitleGroups.get(key) ?? [];
    list.push(r.reqNo);
    reqTitleGroups.set(key, list);
  }
  const duplicateReqTitles = [...reqTitleGroups.entries()].filter(([, nos]) => new Set(nos).size > 1);
  if (duplicateReqTitles.length > 0) {
    warnings.push(`有 ${duplicateReqTitles.length} 组需求标题重复（如 ${duplicateReqTitles[0][1].slice(0, 3).join('、')}）——建议 AC 标题加“验收标准：”前缀或合并重复行`);
  }
  const explicitDurations = normals
    .map((p) => Number(p.durationDays))
    .filter((d) => Number.isFinite(d) && d > 0);
  if (normals.length >= 10 && explicitDurations.length === normals.length && new Set(explicitDurations).size === 1) {
    warnings.push(`可执行任务 ${normals.length} 条全部为 ${explicitDurations[0]} 天——工期没有体现复杂度差异，建议按 complexity/任务类型拆分 1~5 天`);
  }
  const readiness: ImportReadiness = errors.length > 0 ? 'blocked' : warnings.length > 0 ? 'needs_review' : 'ready';
  return { readiness, errors, warnings };
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
  /** §x.y 章节号缺口：只作定位提示，不阻断导入、不生成占位计划 */
  coverageSectionGaps: number;
  conflicts: VersionConflict[];
  coverage: CoverageGroup[];
  durationDetails: ReturnType<typeof findMilestoneDurationIssues>;
  duplicateExamples: string[];
  /** 2026-11-17：质量门结果（ready/needs_review/blocked）与阻断项/提醒项 */
  readiness: ImportReadiness;
  qualityErrors: string[];
  qualityWarnings: string[];
}

export function analyzeImportQuality(input: {
  sources: ReadonlyArray<QualitySource>;
  reqs: ReadonlyArray<QualityReq>;
  plans: ReadonlyArray<QualityPlan>;
}): QualitySummary {
  const { sources, reqs, plans } = input;
  // 质量门和结构指标只看实际参与导入的行；未勾选的占位模板/历史套次不得继续制造阻断。
  const activeReqs = reqs.filter((r) => r.include !== false);
  const activePlans = plans.filter((p) => p.include !== false);
  const dup = findDuplicatePlanGroups(activePlans);
  const conflicts = detectVersionConflicts(sources);
  const coverage = buildSourceCoverage(sources, activeReqs, activePlans);
  const durationDetails = findMilestoneDurationIssues(activePlans);
  const docCounts = { prd: 0, design: 0, test: 0 };
  for (const s of sources) docCounts[s.role ?? 'prd'] += 1;
  const gate = evaluateImportReadiness(activeReqs, activePlans);
  return {
    docCounts,
    reqCount: reqs.length,
    planCount: plans.length,
    milestoneCount: activePlans.filter((p) => p.kind === 'milestone').length,
    wbsGroups: detectWbsGroups(activePlans).groups,
    duplicateGroups: dup.length,
    duplicateRows: dup.reduce((n, g) => n + g.indexes.length - 1, 0),
    gapFillRows: plans.filter(isGapFillPlan).length,
    constraintReqs: detectConstraintReqs(activeReqs).length,
    unattributedReqs: activeReqs.filter((r) => !/^(§|\d+\.\d+|Q-\d+)/.test((r.sourceRef ?? '').trim())).length,
    durationIssues: durationDetails.length,
    versionConflicts: conflicts.length,
    // 2026-11-17：只把「缺少结构依据」的行算推定；有 wbsCode/parentCode/acceptanceRefs 的行已有可追溯来源
    inferredFieldRows: activePlans.filter((p) => !p.wbsCode && !p.parentCode && !p.sourceSection).length,
    // 2026-11-17：§x.y 是定位锚点、Dx 是设计决策标题，均非独立需求条目，单独计数为提示；
    // 硬缺口只算 Q/S/R/T/N/O，避免正常 PRD 因章节号或设计决策编号未回写就被拦在导入门外。
    coverageGaps: coverage.filter((g) => !g.soft).reduce((n, g) => n + g.missing.length, 0),
    coverageSectionGaps: coverage.filter((g) => g.soft).reduce((n, g) => n + g.missing.length, 0),
    conflicts,
    coverage,
    durationDetails,
    duplicateExamples: dup.slice(0, 8).map((g) => g.titles.slice(0, 3).join(' ≈ ')),
    readiness: gate.readiness,
    qualityErrors: gate.errors,
    qualityWarnings: gate.warnings,
  };
}

/** 日志播报用的一行摘要（不换行、控制在可读长度） */
export function formatQualitySummary(s: QualitySummary): string {
  return `导入质量自检：来源文档 ${s.docCounts.prd} 份 PRD / ${s.docCounts.design} 份设计 / ${s.docCounts.test} 份测试；`
    + `${s.reqCount} 需求、${s.planCount} 计划（${s.milestoneCount} 里程碑）；`
    + `WBS ${s.wbsGroups} 套、同题重复 ${s.duplicateRows} 行、占位 ${s.gapFillRows} 行、工期不符 ${s.durationIssues} 个、`
    + `否定口径 ${s.constraintReqs} 条、溯源未标注 ${s.unattributedReqs} 条、版本冲突 ${s.versionConflicts} 项、硬覆盖缺口 ${s.coverageGaps} 项、软定位缺口 ${s.coverageSectionGaps} 项（章节/设计决策，仅提示）；`
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
  // 2026-11-17：不再「第二套整段取消」——那会不可逆地丢掉 P0/P1/EX/Q/F/R 等独有阶段。
  // 改为「同题去重（保留首见）+ 独有条目保留」，多套结构交给结构树/质量门处理。
  const seen = new Set<string>();
  out.forEach((p) => {
    // 占位行不参与同题去重（归一化后标题相同，会被整批误取消勾选）
    if (isGapFillPlan(p)) return;
    // 2026-11-22：覆盖核对卡按需求组拆分，标题归一化后都叫「需求追溯与覆盖核对」；
    // 若参与同题去重，第 2~N 张会被整批取消勾选，直接制造「7 条需求未覆盖」。
    if (isPrdCoveragePlan(p)) return;
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
  // 工期重算：结构字段优先；跳过未勾选行、占位行与覆盖核对卡（与服务端 milestoneDurations 一致）
  const structured = out.some((p) => !!planWbsCodeOf(p) || !!planParentCodeOf(p));
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== 'milestone' || out[i].include === false) continue;
    let sum = 0;
    if (structured) {
      for (let j = 0; j < out.length; j += 1) {
        const p = out[j];
        if (j === i || p.kind === 'milestone' || p.include === false) continue;
        if (isGapFillPlan(p) || isPrdCoveragePlan(p)) continue;
        if (milestoneOwnerOf(out, j) !== i) continue;
        sum += Math.max(1, Math.round(Number(p.durationDays) || 1));
      }
    } else {
      for (let j = i + 1; j < out.length; j++) {
        if (out[j].kind === 'milestone' && out[j].include !== false) break;
        if (out[j].include === false || isGapFillPlan(out[j]) || isPrdCoveragePlan(out[j])) continue;
        sum += Math.max(1, Math.round(Number(out[j].durationDays) || 1));
      }
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
 * T05575：覆盖缺口一键处置——把「原文有、解析结果无」的编号补成 normal 占位模板。
 * 生成行默认 **不勾选**：它们只是待改写的草稿，勾选前不参与覆盖统计、也不得被当成
 * 已覆盖（否则一键补齐会把覆盖缺口假归零，随后又被质量门按占位行拦截）。
 * 与 server/src/util/prdWbs.ts 的 applySourceEntryGapFill 同口径（description 以「自动补齐：」开头，
 * 因此不参与同题去重、不计入里程碑工期）。
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
    if (g.soft) continue; // §x.y / Dx 仅定位或设计决策，不生成占位计划
    for (const id of g.missing ?? []) {
      const title = `${id} ${g.label}（源文档条目）`;
      if (existing.has(title)) continue;
      out.push({
        title,
        description: `自动补齐：源文档条目 ${g.label} ${id}——原文有该编号，解析结果未覆盖，请人工确认是否需要开发或改为验收项`,
        durationDays: 1,
        kind: 'normal',
        reqNos: [],
        include: false,
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
