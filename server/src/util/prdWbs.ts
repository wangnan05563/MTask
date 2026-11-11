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
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/** 系统补齐的占位计划行：AI 自己补的「REQ-xxx 相关实现」、服务端 applyAutoGapFill 的「自动补齐：」、
 *  T05571 源文档条目补齐的「自动补齐：源文档条目」（前缀是 AUTO_GAP_FILL_DESC 的子串，一并命中） */
export function isGapFillPlan(p: { title?: string; description?: string }): boolean {
  return /^REQ-\d{3}\b/.test((p.title ?? '').trim())
    || (p.description ?? '').startsWith('自动补齐：');
}

/** 多套 WBS 检测：里程碑章号出现回退（…3、4、1、2…）即新的一套 */
export function detectWbsGroups(items: ReadonlyArray<{ title: string; kind?: string }>): {
  groups: number;
  milestones: number;
  groupStartTitles: string[];
} {
  const ms = items.filter((x) => x.kind === 'milestone');
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
      const excerpt = text.slice(start, end).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
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
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
