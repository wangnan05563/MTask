/**
 * PRD 分片解析后的 WBS 归一化（纯函数，不依赖 DB）。
 *
 * 背景（2026-11-10「BEMP审批」导入质量复核）：一份长 PRD 被切成 8 片，
 * 每片各自输出一套完整 WBS（里程碑 + 明细），合并时只做了「标题精确去重」，
 * 结果 149 条计划里出现 7 套并行里程碑编号（1~4 M1~M4 / 1~6 / 1~3 M4~M6 …），
 * 同一业务模块（判重匹配、导入解析、字典改造）被重复拆成 3~5 套。
 *
 * 本模块提供三类确定性能力：
 * ① 归一化标题（去掉互相冲突的 WBS 章号前缀）——跨片同题去重；
 * ② 系统补齐占位行判定——这类行不应归属到里程碑，也不应计入里程碑工期；
 * ③ 多套 WBS 检测——里程碑章号「回退」即视为新的一套，供预演/解析日志告警。
 *
 * 与 web/src/utils/prdQuality.ts 的同名函数口径一致（两处各自单源，避免前端引 server 代码）。
 */

/** 去掉 WBS 编号前缀后的标题主体：用于跨分片同题判定 */
export function normalizePlanTitle(title: string): string {
  return (title ?? '')
    .replace(/^\s*\d+(?:\.\d+)*\s*(?:M\d+)?\s*/i, '')
    .replace(/^\s*M\d+\s*/i, '')
    .replace(/^REQ-\d+\s*/i, '')
    // 只去空白/标点/符号，**不能**用 [\s\W_]：\W 会把中文一并删掉，
    // 纯中文标题会全部归一化为 ''，跨片同题去重直接失效（质量门 A-02 实测捕获）。
    .replaceAll(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/** 系统补齐的占位计划行：只认系统写的 description 前缀，或显式 gapFill 标记。
 *  旧实现用 `^REQ-\d{3}` 判标题，会把「REQ-020 工具卡片展示」这类真实任务一并误判成占位——
 *  REQ 编号只是来源标识，不是「无业务语义」的同义词。 */
export function isGapFillPlan(p: { title?: string; description?: string; gapFill?: boolean }): boolean {
  if (p.gapFill === true) return true;
  return (p.description ?? '').startsWith('自动补齐：');
}

/** 阶段族：数字章号（1/2/5.3/M1）或标签族（P0/P1/EX/Q/F/R） */
type PhaseKey = { kind: 'num'; n: number } | { kind: 'label'; label: string };

function phaseKeyOf(title: string, wbsCode?: string): PhaseKey | null {
  const t = (title ?? '').trim();
  // M1 / 1 / 1.1 / 5.3：取首段数字作为「同一族内的递增序」；M 前缀与裸数字视为同族
  const num = /^(?:M)?(\d+)(?:\s|\.|$)/i.exec(t);
  if (num) return { kind: 'num', n: Number(num[1]) };
  const label = /^(P0|P1|EX|Q|F|R)(?:[-\s.]|$)/i.exec(t);
  if (label) return { kind: 'label', label: label[1].toUpperCase() };
  // 标题没有前缀时回落到显式 wbsCode：分片模型常把 P0-1/M1 写进字段而不是标题。
  const code = (wbsCode ?? '').trim();
  if (code) {
    const cnum = /^(?:M)?(\d+)(?:\.|$)/i.exec(code);
    if (cnum) return { kind: 'num', n: Number(cnum[1]) };
    const clabel = /^(P0|P1|EX|Q|F|R)(?:[-\s.]|$)/i.exec(code);
    if (clabel) return { kind: 'label', label: clabel[1].toUpperCase() };
  }
  return null;
}

/** 多套 WBS 检测：数字章号回退，或阶段族切换（数字 ↔ P0/P1/EX/Q/F/R，标签族彼此切换）即新的一套。
 *  当前 PRD 的 1..8.2 / 5.3 / P0-1 / P1-2 / EX / Q / F / R-* 会被识别为多套，而不是只报 2 套。 */
export function detectWbsGroups(items: ReadonlyArray<{ title: string; kind?: string; wbsCode?: string }>): {
  groups: number;
  milestones: number;
  groupStartTitles: string[];
  families: string[];
} {
  const ms = items.filter((x) => x.kind === 'milestone');
  if (ms.length === 0) return { groups: 0, milestones: 0, groupStartTitles: [], families: [] };
  let groups = 1;
  const groupStartTitles: string[] = [ms[0].title];
  const families: string[] = [];
  let prev: PhaseKey | null = phaseKeyOf(ms[0].title ?? '', ms[0].wbsCode);
  families.push(prev ? (prev.kind === 'num' ? `num:${prev.n}` : `label:${prev.label}`) : 'unknown');
  for (let i = 1; i < ms.length; i += 1) {
    const cur = phaseKeyOf(ms[i].title ?? '', ms[i].wbsCode);
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

/** 从标题/显式字段推出 WBS 编号。显式 wbsCode 优先；标题前缀只做兼容兜底。 */
export function wbsCodeOf(p: { title: string; wbsCode?: string }): string {
  const explicit = (p.wbsCode ?? '').trim();
  if (explicit) return explicit;
  const m = /^(M\d+(?:\.\d+)*|\d+(?:\.\d+)*|P[01]-\d+(?:\.\d+)*|EX|Q|F|R-\d+(?:\.\d+)*)\s+/i.exec((p.title ?? '').trim());
  if (!m) return '';
  return m[1].replace(/^m/i, 'M').replace(/^p/i, 'P').replace(/^ex/i, 'EX').replace(/^q/i, 'Q').replace(/^f/i, 'F').replace(/^r/i, 'R');
}

/** 父编号：显式 parentCode 优先；否则按 wbsCode 的点分层级推导（M1.1 → M1，8.2.1 → 8.2）。 */
export function parentCodeOf(p: { title: string; kind?: string; parentCode?: string; wbsCode?: string }): string {
  if (p.kind === 'milestone') return '';
  const explicit = (p.parentCode ?? '').trim();
  if (explicit) return explicit;
  const code = wbsCodeOf(p);
  if (!code || !code.includes('.')) return '';
  return code.slice(0, code.lastIndexOf('.'));
}

/** 结构树：按 wbsCode/parentCode 建父子；无 code 的旧数据不强行建树（交给区间兜底）。 */
export interface WbsTreeResult {
  hasStructure: boolean;
  roots: number[];
  parentOf: number[];
  childrenOf: number[][];
  issues: string[];
}

export function deriveWbsTree(items: ReadonlyArray<{ title: string; kind?: string; wbsCode?: string; parentCode?: string }>): WbsTreeResult {
  const n = items.length;
  const parentOf = new Array<number>(n).fill(-1);
  const childrenOf = Array.from({ length: n }, () => [] as number[]);
  const issues: string[] = [];
  const codeToIndex = new Map<string, number>();
  const codes = items.map((p) => wbsCodeOf(p));
  const hasStructure = codes.some((c) => !!c);
  if (!hasStructure) return { hasStructure: false, roots: items.map((_, i) => i), parentOf, childrenOf, issues };
  codes.forEach((code, i) => {
    if (!code) return;
    if (codeToIndex.has(code)) {
      issues.push(`WBS 编号重复：${code}（第 ${codeToIndex.get(code)! + 1} 行与第 ${i + 1} 行）`);
      return;
    }
    codeToIndex.set(code, i);
  });
  const nearestMilestone = (i: number): number => {
    for (let j = i - 1; j >= 0; j -= 1) if (items[j]?.kind === 'milestone') return j;
    return -1;
  };
  for (let i = 0; i < n; i += 1) {
    const p = items[i];
    if (p.kind === 'milestone') continue;
    const parentCode = parentCodeOf(p);
    if (parentCode && codeToIndex.has(parentCode)) {
      parentOf[i] = codeToIndex.get(parentCode)!;
      continue;
    }
    if (parentCode) issues.push(`找不到父节点 ${parentCode}：${p.title}`);
    const fallback = nearestMilestone(i);
    if (fallback >= 0) {
      parentOf[i] = fallback;
      if (!parentCode) issues.push(`任务缺少 parentCode，已按最近前置里程碑兜底：${p.title}`);
    } else {
      issues.push(`任务没有任何前置里程碑可归属：${p.title}`);
    }
  }
  const roots: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (parentOf[i] >= 0) childrenOf[parentOf[i]].push(i);
    else roots.push(i);
  }
  return { hasStructure, roots, parentOf, childrenOf, issues };
}

/** 结构化 child 边：父边来自 parentCode/树；没有结构信息时返回空数组，调用方回退区间规则。 */
export function structuralChildEdges(
  items: ReadonlyArray<{ title: string; kind?: string; wbsCode?: string; parentCode?: string }>,
): Array<{ index: number; parentIndex: number }> {
  const tree = deriveWbsTree(items);
  if (!tree.hasStructure) return [];
  const out: Array<{ index: number; parentIndex: number }> = [];
  for (let i = 0; i < items.length; i += 1) {
    if (tree.parentOf[i] >= 0) out.push({ index: i, parentIndex: tree.parentOf[i] });
  }
  return out;
}

/**
 * 跨片同题去重：按归一化标题保留首见，reqNos 取并集（不丢关联）。
 * 返回新数组与合并条数；不修改入参。
 */
export function dedupeDraftsByNormalizedTitle<T extends { title: string; description?: string; reqNos?: string[] }>(drafts: ReadonlyArray<T>): {
  drafts: T[];
  merged: number;
} {
  const seen = new Map<string, number>();
  const out: T[] = [];
  let merged = 0;
  for (const d of drafts) {
    // 系统补齐占位行按 REQ 编号区分，归一化标题全是「相关实现」——不能参与同题去重，否则会被整批并成一行
    if (isGapFillPlan({ title: d.title, description: d.description })) { out.push({ ...d }); continue; }
    const key = normalizePlanTitle(d.title ?? '');
    const idx = key ? seen.get(key) : undefined;
    if (key && idx !== undefined) {
      const kept = out[idx];
      const left = Array.isArray(kept.reqNos) ? kept.reqNos : [];
      const right = Array.isArray(d.reqNos) ? d.reqNos : [];
      if (right.length > 0) (kept as { reqNos?: string[] }).reqNos = [...new Set([...left, ...right])];
      merged += 1;
      continue;
    }
    out.push({ ...d });
    if (key) seen.set(key, out.length - 1);
  }
  return { drafts: out, merged };
}

/** 给解析日志用的一行 WBS 摘要 */
export function formatWbsNote(groups: number, milestones: number, merged: number): string {
  if (groups <= 1 && merged === 0) return '';
  const parts: string[] = [];
  if (groups > 1) parts.push(`检测到 ${groups} 套并行 WBS（${milestones} 个里程碑），建议导入前用「合并重复 WBS」统一编号`);
  if (merged > 0) parts.push(`已按归一化标题合并 ${merged} 条同题计划`);
  return parts.join('；');
}

/**
 * T05573：WBS 自动归一化——多套并行 WBS 收敛为单一递增编号序列。
 *
 * 背景（BEMP 复盘根因 #3）：长文档分片后每片各产一套完整 WBS，合并时只做了标题精确去重，
 * 不自动收敛编号，结果 7 套并行里程碑编号并存（1~4 M1~M4 / 1~6 / 1~3 M4~M6 …）。
 * 本函数检测到多套时自动把后续套的里程碑章号顺延到前一套最大章号之后，
 * 同时把该套下所有明细（normal 行）的 WBS 前缀做相应替换。
 *
 * 规则：
 * - 只处理 kind='milestone' 行的章号；normal 行前缀按所属里程碑章号同步替换。
 * - 里程碑章号按首次出现顺序编号：第 1 套保持原样（视为基准），第 2+ 套章号从 prevMax+1 起递增。
 * - 不修改入参，返回新数组与替换统计。
 */
export interface WbsNormalizeResult {
  /** 归一化后的计划行（入参不修改） */
  drafts: Array<{ title: string; description?: string; durationDays?: number; startDate?: string; reqNos?: string[]; status?: string; kind?: string; complexity?: number }>;
  /** 实际收敛的并行套数（1 = 无需处理） */
  groups: number;
  /** 替换了章号的 normal 行数 */
  renumberedNormals: number;
  /** 替换了章号的 milestone 行数 */
  renumberedMilestones: number;
}

function stripWbsPrefix(title: string): string {
  const raw = (title ?? '').trim();
  const stripped = raw
    .replace(/^(?:M\d+(?:\.\d+)*|\d+(?:\.\d+)*|P[01]-\d+(?:\.\d+)*|P[01]|EX|Q|F|R-\d+(?:\.\d+)*)\s*[.、:：\-]?\s*/i, '')
    .trim();
  return stripped || raw;
}

/** 2026-11-18：标签族/无前缀里程碑的兜底归一——当章号算法无法重写（全部是 P0-1/P1-2/EX/Q/F/R
 *  或无前缀标题）时，把整套里程碑强制排成 M1…Mn，normal 按最近前置里程碑挂到 Mx.y。
 *  这不改变业务标题，只改编号；显式 wbsCode/parentCode/phaseCode 同步改写，避免标题与字段打架。 */
function canonicalizeWbsGroups<T extends { title: string; kind?: string }>(
  drafts: ReadonlyArray<T>,
  groups: number,
): WbsNormalizeResult {
  let msSeq = 0;
  let parent = '';
  let child = 0;
  let renumberedMs = 0;
  let renumberedNorm = 0;
  const out: WbsNormalizeResult['drafts'] = [];
  for (const d of drafts) {
    if (d.kind === 'milestone') {
      msSeq += 1;
      parent = `M${msSeq}`;
      child = 0;
      const title = `${parent} ${stripWbsPrefix(d.title)}`;
      out.push({
        ...d,
        title,
        wbsCode: parent,
        parentCode: '',
        phaseCode: parent,
      } as WbsNormalizeResult['drafts'][number]);
      renumberedMs += 1;
      continue;
    }
    if (!parent) parent = 'M1';
    child += 1;
    const code = `${parent}.${child}`;
    const title = `${code} ${stripWbsPrefix(d.title)}`;
    out.push({
      ...d,
      title,
      wbsCode: code,
      parentCode: parent,
      phaseCode: parent,
    } as WbsNormalizeResult['drafts'][number]);
    renumberedNorm += 1;
  }
  return { drafts: out, groups, renumberedNormals: renumberedNorm, renumberedMilestones: renumberedMs };
}

/**
 * 2026-11-18：分片 WBS 的全局折叠——仅归一编号还不够：8 片各产 5 个里程碑时，
 * 即使章号顺延成 M1…M40，质量门仍会因「里程碑 > 8」阻断。
 * 本函数按里程碑标题的字符 bigram 相似度聚类（阈值 0.72），同一业务阶段只保留一个代表；
 * 超过 maxMilestones 时，把尾部/最不相似的簇并入最相似的保留簇，再把所有 normal 按
 * 原 parentCode（找不到则最近前置里程碑）重新挂到 M1…Mn，输出 Mx.y 连续编号。
 *
 * 只用于分片合并这种「同一文档被重复拆解」的场景；单轮解析不调用，避免误合并不同业务阶段。
 */
export interface WbsCollapseResult {
  drafts: WbsNormalizeResult['drafts'];
  collapsedMilestones: number;
  milestones: number;
}

function titleBigrams(s: string): Set<string> {
  const chars = [...s];
  const out = new Set<string>();
  if (chars.length <= 2) { if (s) out.add(s); return out; }
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b || a.includes(b) || b.includes(a)) return 1;
  const A = titleBigrams(a);
  const B = titleBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

export function collapseRepeatedWbsGroups<T extends {
  title: string;
  kind?: string;
  wbsCode?: string;
  parentCode?: string;
}>(drafts: ReadonlyArray<T>, maxMilestones = 6): WbsCollapseResult {
  const msIdx = drafts.map((d, i) => (d.kind === 'milestone' ? i : -1)).filter((i) => i >= 0);
  if (msIdx.length === 0) return { drafts: [...drafts], collapsedMilestones: 0, milestones: 0 };
  const bodyOf = (i: number): string => normalizePlanTitle(drafts[i].title ?? '') || stripWbsPrefix(drafts[i].title ?? '');
  const clusters: Array<{ title: string; members: number[]; first: number }> = [];
  for (const idx of msIdx) {
    const body = bodyOf(idx);
    let best = -1;
    let bestSim = 0;
    for (let c = 0; c < clusters.length; c += 1) {
      const sim = titleSimilarity(body, clusters[c].title);
      if (sim >= 0.72 && sim > bestSim) { best = c; bestSim = sim; }
    }
    if (best >= 0) clusters[best].members.push(idx);
    else clusters.push({ title: body, members: [idx], first: idx });
  }

  // 超过上限时保留最早出现的 maxMilestones 个簇，其余按相似度并入保留簇；
  // 若全不相似，兜底并入最后一个保留簇（分片重复场景下这是可接受的确定性收敛）。
  const kept = clusters.slice(0, maxMilestones);
  const dropped = clusters.slice(maxMilestones);
  for (const c of dropped) {
    let best = kept.length - 1;
    let bestSim = -1;
    for (let k = 0; k < kept.length; k += 1) {
      const sim = titleSimilarity(c.title, kept[k].title);
      if (sim > bestSim) { best = k; bestSim = sim; }
    }
    kept[best].members.push(...c.members);
  }

  const msToKept = new Map<number, number>();
  kept.forEach((c, k) => { c.members.forEach((idx) => msToKept.set(idx, k)); });

  // parentCode → 原里程碑下标；normal 优先按显式父编号归位，找不到再回退最近前置里程碑。
  const codeToMs = new Map<string, number>();
  for (const idx of msIdx) {
    const code = wbsCodeOf(drafts[idx]);
    if (code && !codeToMs.has(code)) codeToMs.set(code, idx);
  }
  const ownerOf = (normalIdx: number): number => {
    const parent = parentCodeOf(drafts[normalIdx]);
    if (parent && codeToMs.has(parent)) return codeToMs.get(parent)!;
    for (let j = normalIdx - 1; j >= 0; j -= 1) if (drafts[j].kind === 'milestone') return j;
    return msIdx[0];
  };

  const childCount = new Map<number, number>();
  const out: WbsNormalizeResult['drafts'] = [];
  kept.forEach((c, k) => {
    const parent = `M${k + 1}`;
    out.push({
      ...drafts[c.first],
      title: `${parent} ${stripWbsPrefix(drafts[c.first].title ?? '')}`,
      wbsCode: parent,
      parentCode: '',
      phaseCode: parent,
    } as WbsNormalizeResult['drafts'][number]);
  });
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    if (d.kind === 'milestone') continue;
    const owner = ownerOf(i);
    const k = msToKept.get(owner) ?? 0;
    const parent = `M${k + 1}`;
    const child = (childCount.get(k) ?? 0) + 1;
    childCount.set(k, child);
    const code = `${parent}.${child}`;
    out.push({
      ...d,
      title: `${code} ${stripWbsPrefix(d.title ?? '')}`,
      wbsCode: code,
      parentCode: parent,
      phaseCode: parent,
    } as WbsNormalizeResult['drafts'][number]);
  }
  return { drafts: out, collapsedMilestones: msIdx.length - kept.length, milestones: kept.length };
}

/**
 * 输入约束：至少含 title 与 kind（检测 WBS 章号用）；其余字段原样透传，不修改入参。
 * 类型 T 的返回值用 WbsNormalizeResult['drafts']（宽松泛型），调用方自行 cast 回精确类型。
 */
export function normalizeWbsGroups<T extends { title: string; kind?: string }>(drafts: ReadonlyArray<T>): WbsNormalizeResult {
  const { groups } = detectWbsGroups(drafts);
  if (groups <= 1) return { drafts: [...drafts], groups: 1, renumberedNormals: 0, renumberedMilestones: 0 };

  const chapterOf = (t: string): number => {
    const m = /^\s*(\d+)/.exec(t ?? '');
    return m ? Number(m[1]) : -1;
  };
  const replaceChapter = (title: string, oldCh: number, newCh: number): string => {
    const re = new RegExp(`^(\\s*)${oldCh}(?=\\s|\\.|$)`);
    return re.test(title) ? title.replace(re, `$1${newCh}`) : title;
  };

  // ① 按出现顺序扫描里程碑，用「章号回退」切套（与 detectWbsGroups 同一判据）
  interface MsRow { idx: number; ch: number; group: number; ordinal: number }
  const msRows: MsRow[] = [];
  let group = 0;
  let prevCh = -1;
  let maxCh0 = 0;
  let ordinal = 0;
  for (let i = 0; i < drafts.length; i += 1) {
    if (drafts[i].kind !== 'milestone') continue;
    const ch = chapterOf(drafts[i].title ?? '');
    if (ch < 0) { msRows.push({ idx: i, ch, group, ordinal: 0 }); continue; }
    if (prevCh >= 0 && ch <= prevCh) { group += 1; ordinal = 0; }
    ordinal += 1;
    if (group === 0) maxCh0 = Math.max(maxCh0, ch);
    prevCh = ch;
    msRows.push({ idx: i, ch, group, ordinal });
  }

  // ② 章号重映射：第 0 套保持原样，第 k 套从 maxCh0 之后顺延
  const newChOf = new Map<number, number>();
  for (const m of msRows) {
    if (m.ch < 0) continue;
    newChOf.set(m.idx, m.group === 0 ? m.ch : maxCh0 + m.ordinal);
  }

  // ③ 逐行重写：里程碑改自身章号；明细按「最近的前置里程碑」推出新章号
  const out: WbsNormalizeResult['drafts'] = [];
  let owner: { old: number; next: number } | null = null;
  let renumberedMs = 0;
  let renumberedNorm = 0;
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    const title = d.title ?? '';
    if (d.kind === 'milestone') {
      const oldCh = chapterOf(title);
      const newCh = newChOf.get(i);
      if (oldCh >= 0 && newCh !== undefined && newCh !== oldCh) {
        owner = { old: oldCh, next: newCh };
        out.push({ ...d, title: replaceChapter(title, oldCh, newCh) });
        renumberedMs += 1;
      } else {
        owner = oldCh >= 0 ? { old: oldCh, next: oldCh } : null;
        out.push({ ...d });
      }
      continue;
    }
    const nextTitle = owner && owner.next !== owner.old ? replaceChapter(title, owner.old, owner.next) : title;
    if (nextTitle !== title) renumberedNorm += 1;
    out.push(nextTitle !== title ? { ...d, title: nextTitle } : { ...d });
  }
  // 2026-11-18：章号算法对 P0/P1/EX/Q/F/R 或无前缀里程碑无能为力（detect 已判多套但这里零改写），
  // 改用强制 M1…Mn 的兜底归一，避免「检测到 2 套却收敛 0 个」。
  if (renumberedMs === 0 && renumberedNorm === 0) return canonicalizeWbsGroups(drafts, groups);
  return { drafts: out, groups, renumberedNormals: renumberedNorm, renumberedMilestones: renumberedMs };
}

/**
 * T05571：源文档条目按编号确定性补齐（纯函数，不依赖 DB）。
 *
 * 背景（BEMP 复盘根因 #2）：applyAutoGapFill 只兜「已解析 PRD 的需求」，设计文档独有的
 * D/R/T/N/O/S/§x.y/Q-xx 编号若未进入 AI 解析（design 只归档），就成了覆盖缺口却补不回来。
 * 这里按与 web/src/utils/prdQuality.ts buildSourceCoverage 同源的 8 类编号正则，从源文档原文
 * 抽出「可核对条目编号」，与已解析的 reqs/drafts 比对，对缺失编号各补一条 normal 任务行，
 * 标题带编号、description 以「自动补齐：源文档条目」前缀（可被 isGapFillPlan 识别、一键取消）。
 *
 * 红线：不修改入参；只返回新数组与补齐明细；「命中」以原文为准，不做业务价值判断（留给人工复核）。
 */

/** 与 prdQuality.buildSourceCoverage 同源的 8 类编号抽取正则（顺序与标签保持一致） */
export const SOURCE_ENTRY_GAP_DESC = '自动补齐：源文档条目';
export const SOURCE_ENTRY_SPECS: Array<{ label: string; re: RegExp }> = [
  { label: '章节 §x.y', re: /(?:§|^|\s)(\d{1,2}\.\d{1,2})(?:[\s\-A-Z]|$)/gm },
  { label: '确认项 Q-xx', re: /\bQ-\d{2}\b/g },
  { label: '脚本 Sx / S3-x', re: /\bS3-[BCD]\b|\bS[1-4]\b/g },
  { label: '设计决策 Dx', re: /\bD[1-7]\b/g },
  { label: '回归场景 Rx', re: /\bR(?:10|[1-9])\b/g },
  { label: '核实项 Tx', re: /\bT(?:11|10|[1-9])\b/g },
  { label: '偏差 N-x', re: /\bN-[1-5]\b/g },
  { label: '开放项 Ox', re: /\bO[1-5]\b/g },
];

export interface SourceEntryRow {
  id: string;
  label: string;
  /** 原文 ±50 字窗口（去换行压平），供任务标题/description 摘要 */
  excerpt: string;
}

/** 从源文档原文抽取 8 类条目编号 + 各自 ±50 字窗口。同一编号在原文多处只取首见。 */
export function extractSourceEntries(sourceText: string): SourceEntryRow[] {
  const text = sourceText ?? '';
  const out: SourceEntryRow[] = [];
  const seen = new Set<string>();
  for (const { label, re } of SOURCE_ENTRY_SPECS) {
    const source = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = source.exec(text)) !== null) {
      const id = m[1] ? `§${m[1]}` : m[0];
      if (seen.has(id)) continue;
      seen.add(id);
      const start = Math.max(0, m.index - 50);
      const end = Math.min(text.length, m.index + m[0].length + 50);
      const excerpt = text.slice(start, end).replaceAll(/\r?\n/g, ' ').replaceAll(/\s+/g, ' ').trim();
      out.push({ id, label, excerpt });
      if (m[0].length === 0) source.lastIndex += 1;
    }
  }
  return out;
}

/**
 * 按缺失编号生成补齐行。`coveredText` 是已解析 reqs/drafts 的拼接正文（编号在其中即视为已覆盖）。
 * 只补「原文有、已解析结果无」的编号；每行 description 带 SOURCE_ENTRY_GAP_DESC 前缀。
 */
export function applySourceEntryGapFill(
  sourceText: string,
  coveredText: string,
): Array<{ id: string; label: string; title: string; description: string; excerpt: string }> {
  const entries = extractSourceEntries(sourceText);
  const resultText = coveredText ?? '';
  const rows: Array<{ id: string; label: string; title: string; description: string; excerpt: string }> = [];
  for (const e of entries) {
    const needle = e.id.startsWith('§') ? e.id.slice(1) : e.id;
    const escaped = needle.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 短编号（D1/R1/T1/S1）必须按非字母数字边界匹配，避免被 REQ-001 / 正文数字误命中
    const hit = needle.length <= 3
      ? new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`).test(resultText)
      : resultText.includes(needle);
    if (hit) continue;
    const brief = e.excerpt.slice(0, 40);
    rows.push({
      id: e.id,
      label: e.label,
      title: `${e.id} ${brief.slice(0, 24)}（源文档条目）`,
      description: `${SOURCE_ENTRY_GAP_DESC} ${e.label}：${brief}`,
      excerpt: e.excerpt,
    });
  }
  return rows;
}
