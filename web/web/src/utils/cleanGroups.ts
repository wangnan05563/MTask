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
/** 跳过一段字符串字面量（含转义），返回结束引号之后一个字符的下标 */
function advanceThroughString(text: string, i: number): number {
  let idx = i + 1;
  while (idx < text.length) {
    const c = text[idx];
    if (c === '\\') { idx += 2; continue; }
    if (c === '"') return idx + 1;
    idx += 1;
  }
  return idx;
}

/** 将扫描到的顶层对象切片解析并追加（损坏对象静默跳过） */
function pushTopObject(out: Record<string, unknown>[], text: string, start: number, end: number): void {
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>);
  } catch { /* 跳过损坏对象，继续扫描后续 */ }
}

/** 处理右花括号：depth-1 后若闭合顶层对象则解析入列；越界 depth 归零 */
function closeTopObject(out: Record<string, unknown>[], text: string, startIdx: number, endIdx: number, depth: number): { depth: number; startIdx: number } {
  const newDepth = depth > 0 ? depth - 1 : 0;
  if (newDepth === 0 && startIdx >= 0) {
    pushTopObject(out, text, startIdx, endIdx);
    return { depth: newDepth, startIdx: -1 };
  }
  return { depth: newDepth, startIdx };
}

export function extractTopLevelObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let startIdx = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') { i = advanceThroughString(text, i); continue; }
    if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      const r = closeTopObject(out, text, startIdx, i, depth);
      depth = r.depth;
      startIdx = r.startIdx;
    }
    i += 1;
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
/** 将任意值中可识别的字符串数组去空白、去空串，归一为 string[]（供 keep/merge/listed 复用） */
function asStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && !!x.trim())
    .map((x) => x.trim());
}

/** 将单条记录解析为 CleanRow；字段不合法（无保留项或无合并项）时返回 null */
function buildCleanRow(r: unknown, index: number): CleanRow | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  // T00751：keep/merge 缺失时，尝试从 tasks/taskNos/items/list 数组取（首个=保留，其余=合并）
  const rawList = [o.tasks, o.taskNos, o.items, o.list].find((v) => Array.isArray(v)) as unknown[] | undefined;
  const listed = asStrings(rawList);
  const keep = (typeof o.keep === 'string' ? o.keep.trim() : '') || listed[0] || '';
  const mergeSource = Array.isArray(o.merge) && o.merge.length > 0 ? o.merge : listed.slice(1);
  const merge = expandTaskNoRanges(asStrings(mergeSource)).filter((x) => x !== keep);
  if (!keep || merge.length === 0) return null;
  return {
    id: `clean-${index}`,
    project: typeof o.project === 'string' ? o.project.trim() : '',
    keep,
    merge: Array.from(new Set(merge)),
    reason: typeof o.reason === 'string' ? o.reason.trim() : '',
    include: true,
  };
}

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
  arr ??= extractTopLevelObjects(bare);
  const out: CleanRow[] = [];
  for (const r of arr) {
    const row = buildCleanRow(r, out.length);
    if (row) out.push(row);
  }
  return out;
}
