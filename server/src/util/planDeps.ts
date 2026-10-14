/**
 * T01284（PRD FR-3.7）：`plan_tasks.deps` 的统一解析与依赖判定——消灭三处副本
 * （`TaskService.dependencyReadyIds` / `SupervisorService.collectSnapshot` / `PlanService.readyTasks`）。
 *
 * deps 契约（T00499，T02090 口径 A 签字后扩展为三型）：
 * `[{ id: <plan_tasks.id>, type: 'serial' | 'parallel' | 'child' }]`，语义见 FR-3.7：
 * - **serial**：严格先后——前置计划未完成时，后继**不得**排水；
 * - **parallel**：可并发投给不同平台会话——前置未完成**不阻塞**后继；等它反而把并行能力退化成串行；
 * - **child**（T02090）：**结构性归属边**——本行是指定里程碑的子项（唯一父子口径，见下）。
 *
 * T02090 口径 A（里程碑父子关系唯一口径 = `deps child`）：
 * 旧实现把 `type !== 'parallel'` 一律归一为 serial，`child` 边被并成 serial 后
 * 「等里程碑完成」与「等子任务完成」互为前提 → **倒挂卡死**（里程碑永远完不成）。
 * 因此 child 必须作为独立类型保留：`depsSatisfied` 对它不阻塞（它不是排期依赖），
 * `rescheduleDependents` 对它不对齐日期（避免子任务 start 被拉到里程碑 start）。
 * 与前端 `web/src/util/planDeps.ts` 的三型契约同语义（该侧 T01621 起已如此）。
 *
 * 解析保持**保守**：type 非这三者一律按 serial。历史数据可能缺 type，放宽等于悄悄解锁并发。
 */

/** deps 元素（已归一：type 只可能是这三个值） */
export interface PlanDep {
  /** 前置计划行 id（plan_tasks.id） */
  id: string;
  type: 'serial' | 'parallel' | 'child';
}

/** 解析 `plan_tasks.deps`：非数组/缺 id 的脏数据跳过（与既有三处解析口径一致）；
 *  T02090：`child` 保留为独立类型（旧实现会并成 serial，造成倒挂卡死） */
export function parsePlanDeps(raw: string | null | undefined): PlanDep[] {
  try {
    const v: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter((d): d is { id: string; type?: unknown } => !!d && typeof d.id === 'string')
      .map((d) => ({ id: d.id, type: d.type === 'parallel' ? 'parallel' : d.type === 'child' ? 'child' : 'serial' }));
  } catch {
    return [];
  }
}

/**
 * 依赖是否满足（FR-3.7 排水判定）。
 * `statusById` 只装**存在**的计划行；查不到的行视为已完成（脏引用不永久卡住排水，与既有口径一致）。
 * T02090：`child`（结构性归属边）与 parallel 一样不阻塞——它是父子关系标记，不是排期依赖。
 */
export function depsSatisfied(deps: PlanDep[], statusById: Map<string, string>): boolean {
  for (const d of deps) {
    if (d.type !== 'serial') continue; // parallel/child：语义即并发/归属，不阻塞
    const st = statusById.get(d.id);
    if (st === undefined) continue; // 计划行已不存在 → 按已完成
    if (st !== 'done') return false;
  }
  return true;
}

/**
 * 拓扑分层排序（Kahn）：让前置排在依赖它的任务之前，供排水按序投递。
 *
 * 为何 parallel/child 边也计入：serial 的先后由 `depsSatisfied` 硬保证（未完成的前置不会放行后继），
 * 这里只解决**投递顺序偏好**——parallel 混合链上「先投前置再投并发方」，否则平台可能先拉起依赖方；
 * child 边同理（子项排在里程碑之后投递，符合「先立阶段、再落明细」的直觉）。
 * 环（脏数据）不会被 Kahn 消解，按原序补尾，保证不丢项、不死循环。
 */
/**
 * M6-6.1：由图数据建邻接表与入度表（原 topoOrder 内联建图循环）。
 * 自环与引用集合外节点的边一律跳过——这类边来自脏数据，计入会让入度永远降不到 0。
 */
function buildTopoGraph(ids: string[], edges: Array<{ from: string; to: string }>): {
  adj: Map<string, string[]>;
  indeg: Map<string, number>;
} {
  const inSet = new Set(ids);
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (e.from === e.to || !inSet.has(e.from) || !inSet.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  return { adj, indeg };
}

/** M6-6.1：Kahn 排空——逐个出队并递减后继入度，归零者入队 */
function drainTopo(queue: string[], adj: Map<string, string[]>, indeg: Map<string, number>): string[] {
  const out: string[] = [];
  const pending = [...queue];
  while (pending.length > 0) {
    const id = pending.shift()!;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      const left = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, left);
      if (left === 0) pending.push(next);
    }
  }
  return out;
}

/** M6-6.1：环上的残余节点按原序补尾（Kahn 不消解环，保证不丢项、不死循环） */
function appendUnreached(out: string[], ids: string[]): string[] {
  if (out.length >= ids.length) return out;
  const seen = new Set(out);
  return [...out, ...ids.filter((id) => !seen.has(id))];
}

export function topoOrder(ids: string[], edges: Array<{ from: string; to: string }>): string[] {
  if (ids.length <= 1) return [...ids];
  const { adj, indeg } = buildTopoGraph(ids, edges);
  const roots = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  return appendUnreached(drainTopo(roots, adj, indeg), ids);
}
