/**
 * T02090（里程碑收口残项，口径 A 签字）：`deps` 中 `type='child'` 边的纯函数工具——单源实现。
 *
 * 口径 A：**`deps child` 是里程碑父子关系的唯一结构化标记**（与 T01704 包络重算、
 * 前端 PlanTimeline 阶段成员、估算导出 C 列归属同一份数据）。平台侧历史「排序区间」
 * 口径（milestoneDurations / PlanPage.milestoneMeta）只作展示汇总，不再作为父子判据。
 *
 * 本模块**不依赖 DB**（纯 JSON 文本进/出），供三处共用：
 * - `PlanService.importPrd`：导入后按区间规则补边；
 * - `scripts/t02090-backfill-child-edges`：存量补边（幂等）；
 * - 门脚本 `verify-t02042-milestone-deps.mts`：夹具断言。
 */

/** deps 元素（宽松入参：未知字段原样保留，只追加 child 边） */
interface RawDep { id?: unknown; type?: unknown; [k: string]: unknown }

/** 宽松解析 deps JSON：非数组/脏数据返回 []（与 parseLinkIds 同口径） */
function parseRaw(deps: string | null | undefined): RawDep[] {
  try {
    const a: unknown = deps ? JSON.parse(deps) : [];
    return Array.isArray(a) ? (a as RawDep[]) : [];
  } catch {
    return [];
  }
}

/** deps 中所有 `type='child'` 的父项 id（按出现序；脏数据跳过） */
export function childParentIds(deps: string | null | undefined): string[] {
  return parseRaw(deps)
    .filter((d): d is { id: string; type: 'child' } => !!d && typeof d.id === 'string' && d.type === 'child')
    .map((d) => d.id);
}

/** 是否已存在指向 parentId 的 child 边（幂等判定） */
export function hasChildEdge(deps: string | null | undefined, parentId: string): boolean {
  return childParentIds(deps).includes(parentId);
}

/**
 * 并集追加 child 边：已有指向 parentId 的边时**原样返回**（零 diff，补边脚本幂等的关键）；
 * 否则追加到末尾，其余边（serial/parallel/其它 child）原序保留。
 */
export function addChildEdge(deps: string | null | undefined, parentId: string): string {
  if (hasChildEdge(deps, parentId)) return deps ?? '';
  const arr = parseRaw(deps);
  arr.push({ id: parentId, type: 'child' });
  return JSON.stringify(arr);
}

/**
 * 区间规则：**里程碑之后、下一里程碑之前的 normal 行**归属该里程碑。
 * 与 `PlanService.milestoneDurations`（导入侧工期汇总）同一口径，保证「归属」与「工期汇总」不漂。
 * 返回 [{ index: 子行下标, parentIndex: 父里程碑下标 }]；首个里程碑之前的行无归属（不归任何里程碑）。
 */
export function intervalChildEdges(items: Array<{ kind?: string }>): Array<{ index: number; parentIndex: number }> {
  const out: Array<{ index: number; parentIndex: number }> = [];
  let parent = -1;
  for (let i = 0; i < items.length; i++) {
    const kind = items[i]?.kind;
    if (kind === 'milestone') { parent = i; continue; }
    if (kind === 'normal' && parent >= 0) out.push({ index: i, parentIndex: parent });
  }
  return out;
}
