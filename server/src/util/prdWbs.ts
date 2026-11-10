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

/** 系统补齐的占位计划行：AI 自己补的「REQ-xxx 相关实现」或服务端 applyAutoGapFill 的「自动补齐：」 */
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
