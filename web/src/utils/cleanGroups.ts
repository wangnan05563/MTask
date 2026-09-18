// T00751：数据清洗分组解析（自 ReportConsole 抽出为可测模块）
// 从 AI 结论中解析「合并分组」，兼容多种字段形状与任务号区间简写。

export interface CleanRow {
  id: string;
  project: string;
  keep: string;
  merge: string[];
  reason: string;
  include: boolean;
}

/**
 * 扫描文本中所有**顶层 {...} 对象**（括号配平，正确跳过字符串与转义）。
 * 用于兼容大模型常见的 JSON 格式瑕疵：数组元素间缺逗号、NDJSON（每行一个对象）、
 * 结果中夹杂说明文字、末尾对象被截断（自动丢弃不完整者）——比整体 JSON.parse 鲁棒得多。
 */
export function extractTopLevelObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let startIdx = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === String.fromCharCode(92)) esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && startIdx >= 0) {
        try {
          const o = JSON.parse(text.slice(startIdx, i + 1)) as unknown;
          if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>);
        } catch { /* 跳过损坏对象，继续扫描后续 */ }
        startIdx = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/**
 * T00751：展开任务号区间简写——"T00056-T00080" / "T00056-80" → 逐条完整编号。
 * 模型被要求精简输出时会压缩成区间，而执行清洗按逐条任务号合并，必须还原；
 * 展开上限 200 条防爆量（超限保持原串，交由后端按「任务不存在」跳过）。
 */
export function expandTaskNoRanges(list: string[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const m = /^(T?)(\d+)\s*[-~—]\s*(T?)(\d+)$/.exec(item);
    if (!m) { out.push(item); continue; }
    const prefix = m[1] || m[3] || 'T';
    const from = Number(m[2]);
    const width = m[2].length;
    const to = Number(m[4].length < width ? m[4].padStart(width, '0') : m[4]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 200) { out.push(item); continue; }
    for (let n = from; n <= to; n += 1) out.push(`${prefix}${String(n).padStart(width, '0')}`);
  }
  return out;
}

/**
 * T00652/T00751 数据清洗：从 AI 结论中解析合并分组。
 * 兼容 ```json 代码围栏与裸 JSON 数组：先剥围栏，再取首个 '[' 到末尾 ']' 之间解析；
 * 逐组校验 keep 非空且 merge 非空（AI 输出不可靠，宁缺毋滥）。
 * T00751：兼容模型给出的替代字段形状（tasks/taskNos/items/list 数组 → 首个=保留、其余=合并），
 * 并展开 "T00056-T00080" 这类区间简写（此前模型这样输出会导致执行清洗弹窗无数据）。
 */
export function parseCleanGroups(md: string): CleanRow[] {
  const bare = md.replaceAll(/```json/gi, '').replaceAll(/```/gi, '').trim();
  let arr: unknown[] | null = null;
  const start = bare.indexOf('[');
  const end = bare.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(bare.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) arr = parsed;
    } catch { arr = null; }
  }
  if (!arr) arr = extractTopLevelObjects(bare);
  const out: CleanRow[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    // T00751：keep/merge 缺失时，尝试从 tasks/taskNos/items/list 数组取（首个=保留，其余=合并）
    const rawList = [o.tasks, o.taskNos, o.items, o.list].find((v) => Array.isArray(v)) as unknown[] | undefined;
    const listed = (rawList ?? [])
      .filter((x): x is string => typeof x === 'string' && !!x.trim())
      .map((x) => x.trim());
    const keep = (typeof o.keep === 'string' ? o.keep.trim() : '') || listed[0] || '';
    const mergeSource = Array.isArray(o.merge) && o.merge.length > 0 ? o.merge : listed.slice(1);
    const merge = expandTaskNoRanges(mergeSource
      .filter((x): x is string => typeof x === 'string' && !!x.trim())
      .map((x) => x.trim()))
      .filter((x) => x !== keep);
    if (!keep || merge.length === 0) continue;
    out.push({
      id: `clean-${out.length}`,
      project: typeof o.project === 'string' ? o.project.trim() : '',
      keep,
      merge: Array.from(new Set(merge)),
      reason: typeof o.reason === 'string' ? o.reason.trim() : '',
      include: true,
    });
  }
  return out;
}
