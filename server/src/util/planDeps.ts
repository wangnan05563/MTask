/**
 * T01284（PRD FR-3.7）：`plan_tasks.deps` 的统一解析与依赖判定——消灭三处副本
 * （`TaskService.dependencyReadyIds` / `SupervisorService.collectSnapshot` / `PlanService.readyTasks`）。
 *
 * deps 契约（T00499）：`[{ id: <plan_tasks.id>, type: 'serial' | 'parallel' }]`，语义见 FR-3.7：
 * - **serial**：严格先后——前置计划未完成时，后继**不得**排水；
 * - **parallel**：可并发投给不同平台会话——前置未完成**不阻塞**后继；等它反而把并行能力退化成串行。
 *
 * 三处副本此前一律按「全部前置完成才就绪」，把 parallel 误当 serial（比契约更严）：不会造成错误执行，
 * 却会白白压住本可并发的任务——正是 FR-3.7 要解决的问题。
 *
 * 解析保持**保守**：type 非 'parallel' 一律按 serial。历史数据可能缺 type，放宽等于悄悄解锁并发。
 */

/** deps 元素（已归一：type 只可能是这两个值） */
export interface PlanDep {
  /** 前置计划行 id（plan_tasks.id） */
  id: string;
  type: 'serial' | 'parallel';
}

/** 解析 `plan_tasks.deps`：非数组/缺 id 的脏数据跳过（与既有三处解析口径一致） */
export function parsePlanDeps(raw: string | null | undefined): PlanDep[] {
  try {
    const v: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter((d): d is { id: string; type?: unknown } => !!d && typeof d.id === 'string')
      .map((d) => ({ id: d.id, type: d.type === 'parallel' ? 'parallel' : 'serial' }));
  } catch {
    return [];
  }
}

/**
 * 依赖是否满足（FR-3.7 排水判定）。
 * `statusById` 只装**存在**的计划行；查不到的行视为已完成（脏引用不永久卡住排水，与既有口径一致）。
 */
export function depsSatisfied(deps: PlanDep[], statusById: Map<string, string>): boolean {
  for (const d of deps) {
    if (d.type !== 'serial') continue; // parallel：语义即并发，不阻塞
    const st = statusById.get(d.id);
    if (st === undefined) continue; // 计划行已不存在 → 按已完成
    if (st !== 'done') return false;
  }
  return true;
}

/**
 * 拓扑分层排序（Kahn）：让前置排在依赖它的任务之前，供排水按序投递。
 *
 * 为何 parallel 边也计入：serial 的先后由 `depsSatisfied` 硬保证（未完成的前置不会放行后继），
 * 这里只解决**投递顺序偏好**——parallel 混合链上「先投前置再投并发方」，否则平台可能先拉起依赖方。
 * 环（脏数据）不会被 Kahn 消解，按原序补尾，保证不丢项、不死循环。
 */
export function topoOrder(ids: string[], edges: Array<{ from: string; to: string }>): string[] {
  if (ids.length <= 1) return [...ids];
  const inSet = new Set(ids);
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (e.from === e.to || !inSet.has(e.from) || !inSet.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      const left = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (out.length < ids.length) {
    const seen = new Set(out);
    for (const id of ids) if (!seen.has(id)) out.push(id);
  }
  return out;
}
