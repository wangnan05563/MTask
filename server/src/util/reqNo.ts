/**
 * T01867：需求编号（prd_requirements.req_no）项目内唯一性解析。
 *
 * 背景：AI 每次解析 PRD 都从 REQ-001 起编号，且 prd_requirements 没有编号唯一约束，
 * 增量导入第二个 PRD 时与项目已有编号直接撞号（实测同项目出现 REQ-001 两行）。
 * 编号一旦重复，矩阵/导出/用例的「按编号定位需求」就变成不确定命中，
 * 后续删除其中一行会连带清理另一行的引用——这是 T01869 报告的「删增量致原数据断裂」的成因之一。
 *
 * 口径：本系统是**单一编号空间**（草稿态/正式态由 prd_docs.status 区分，需求行不按态分号），
 * 故顺延只依据项目内现有编号的最大值，旧编号一律不改。
 *
 * T01867 复验修正：判重必须按**编号同一性**而不是字符串——存量矩阵常用 REQ-01 两位写法，
 * AI 解析出的增量批次是 REQ-001 三位写法，按字符串比会判定「不冲突」而原样落库，
 * 实测 mtask四期 出现 REQ-01..REQ-12 与 REQ-001..REQ-020 并存（用户反馈「增量导入后编号还是从 REQ-01 开始」）。
 */

/** 尾部为纯整数的编号（REQ-001 / A-12）：可安全顺延 */
const TRAILING_INT = /^(\D*)(\d+)$/;

/**
 * 编号同一性键：同前缀 + 同序号（忽略前导零、忽略大小写）视为同一个编号。
 * `REQ-01` 与 `REQ-001` → `REQ|1`；层级式编号（FR-1.1）尾部非纯整数，退回整串大写比较。
 */
export function reqNoKey(no: string): string {
  const s = String(no ?? '').trim();
  const m = TRAILING_INT.exec(s);
  return m ? `${m[1].trim().toUpperCase()}|${Number(m[2])}` : s.toUpperCase();
}

/** 项目内该编号前缀已用过的最大序号（无则 0） */
function maxSeqForPrefix(existing: ReadonlySet<string>, prefix: string): number {
  let max = 0;
  const p = prefix.trim().toUpperCase();
  for (const no of existing) {
    const m = TRAILING_INT.exec(no);
    if (!m || m[1].trim().toUpperCase() !== p) continue;
    max = Math.max(max, Number(m[2]));
  }
  return max;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** 保证候选号不与 taken 冲突：冲突就继续 +1（防御批内并发取名） */
function bumpUntilFree(taken: ReadonlySet<string>, prefix: string, start: number, width: number): string {
  let n = start;
  let no = `${prefix}${pad(n, width)}`;
  while (taken.has(reqNoKey(no))) no = `${prefix}${pad(++n, width)}`;
  return no;
}

/**
 * 解析出项目内可用的需求编号。
 * @param existing 项目内已占用的编号集合（调用方需把同批已分配编号也加进来）
 * @param requested AI/用户给出的编号；空串表示自动编号
 * @returns 顺延后的唯一编号（requested 按编号同一性未被占用时原样返回）
 */
export function resolveReqNo(existing: ReadonlySet<string>, requested?: string): string {
  const taken = new Set([...existing].map(reqNoKey)); // 归一化占用集：REQ-01 与 REQ-001 算同一个号
  const req = (requested ?? '').trim();
  if (!req) {
    const prefix = 'REQ-';
    return bumpUntilFree(taken, prefix, maxSeqForPrefix(existing, prefix) + 1, 3);
  }
  if (!taken.has(reqNoKey(req))) return req;
  const m = TRAILING_INT.exec(req);
  if (m) {
    const prefix = m[1];
    // 宽度取「请求值」与「该前缀已用最长」的较大者，避免 REQ-9 顺延成 REQ-10 后排序错位
    const p = prefix.trim().toUpperCase();
    const width = Math.max(m[2].length, ...[...existing].filter((no) => TRAILING_INT.exec(no)?.[1].trim().toUpperCase() === p).map((no) => (TRAILING_INT.exec(no)?.[2] ?? '').length));
    return bumpUntilFree(taken, prefix, maxSeqForPrefix(existing, prefix) + 1, width);
  }
  // 层级式编号（FR-1.1 / UC-2.3.4）尾部不是单一整数，无法用「最大号 +1」表达层级语义；
  // 与 normalizeRequirementEntry 的批内去重同形态，追加批次后缀保唯一。
  let k = 1;
  while (taken.has(reqNoKey(`${req}-${k}`))) k += 1;
  return `${req}-${k}`;
}

/** 是否存在与 no 同编号同一性的其他行（手工新增/改号的前置校验） */
export function isReqNoTaken(existing: Iterable<string>, no: string): boolean {
  const key = reqNoKey(no);
  for (const x of existing) if (reqNoKey(x) === key) return true;
  return false;
}

/** 找出项目内重复的需求编号分组（供矩阵面板提示存量脏数据；按编号同一性分组，能识别 REQ-01 与 REQ-001 混写） */
export function groupDuplicateReqNos(rows: Array<{ req_no: string | null }>): Array<{ reqNo: string; count: number; variants: string[] }> {
  const byKey = new Map<string, string[]>();
  for (const r of rows) {
    const no = String(r.req_no ?? '').trim();
    if (!no) continue;
    const list = byKey.get(reqNoKey(no));
    if (list) list.push(no);
    else byKey.set(reqNoKey(no), [no]);
  }
  return [...byKey.values()]
    .filter((v) => v.length > 1)
    .map((v) => ({ reqNo: v[0], count: v.length, variants: [...new Set(v)] }))
    .sort((a, b) => a.reqNo.localeCompare(b.reqNo, undefined, { numeric: true }));
}
