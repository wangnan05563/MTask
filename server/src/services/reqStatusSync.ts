/**
 * T02087：需求状态（`prd_requirements.status`）随关联计划/待办的执行状态自动派生。
 *
 * 背景：任务完成的状态同步链原本有三层——任务→计划（TaskService.syncPlanOnStatusChange）、
 * 计划→需求维度待办（T01266 syncReqLinkedTasks）、启动对账（T00470 reconcileLinkedPlanStatuses），
 * 唯独需求自身的 `status` 字段从不派生：矩阵里 308 条需求的关联计划/待办全部 done，
 * status 却停留在 todo（用户报「外部 AI 执行关联任务完成后，计划状态更新了，需求状态未更新」）。
 *
 * 派生口径（关联项 = 未归档计划 ∪ 未归档待办，经 req_ids 关联，与 PlanService.listRequirements 同一口径）：
 *  - 无关联项 → 不动（没有执行信号，保留人工状态，不猜）；
 *  - 当前为 `changed` → 不动（需求变更属业务判断，不被执行进度覆盖）；
 *  - 全部 done → `done`；
 *  - 任一 doing、或 done/todo 混合 → `doing`；
 *  - 全 todo → `todo`（与计划↔待办同步同为「可回退」语义）。
 *
 * 本模块只依赖 getDb，不 import PlanService/TaskService——两个服务都要调用它，
 * 放任何一侧都会形成循环导入（PlanService 已 import TaskService 的 nextTaskNo）。
 */
import { getDb } from '../db/connection';

/** 需求状态词表（与 MCP `mtask_update_matrix`、矩阵面板 STATUS_OPTIONS 同源） */
export const REQ_STATUSES = ['todo', 'doing', 'done', 'changed'] as const;
export type ReqStatus = (typeof REQ_STATUSES)[number];

type Db = ReturnType<typeof getDb>;

/** `req_ids` JSON 数组文本 → id 列表（脏值返回空数组，与 PlanService.parseLinkIds 同语义） */
export function parseReqIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * 纯派生：关联项状态 → 需求状态；无关联返回 null（调用方保持原值不动）。
 * 单独导出供单测与对账脚本直接断言规则本身。
 */
export function deriveReqStatus(linked: ReadonlyArray<{ status: string }>): ReqStatus | null {
  if (linked.length === 0) return null;
  if (linked.every((x) => x.status === 'done')) return 'done';
  if (linked.every((x) => x.status === 'todo')) return 'todo';
  return 'doing';
}

/**
 * 对给定需求集合重算并落库（在调用方同一事务内执行，失败随事务回滚）。
 * 返回实际发生状态变更的需求 id 列表——供启动对账日志与测试断言「改了什么」。
 */
export function syncReqStatuses(db: Db, projectId: string, reqIds: readonly string[]): string[] {
  const uniq = [...new Set(reqIds.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (uniq.length === 0 || !projectId) return [];
  // 关联项快照：未归档计划 ∪ 未归档待办（与 listRequirements 同口径；req_ids 为空的行
  // 在 SQL 侧直接滤掉，省去每条 JSON.parse——生产 1865 待办/779 计划里仅 274/281 行带关联）
  const plans = db
    .prepare(
      `SELECT req_ids, status FROM plan_tasks
        WHERE project_id = ? AND archived = 0 AND req_ids IS NOT NULL AND req_ids != '' AND req_ids != '[]'`,
    )
    .all(projectId) as Array<{ req_ids: string; status: string }>;
  const tasks = db
    .prepare(
      `SELECT req_ids, status FROM tasks
        WHERE project_id = ? AND archived = 0 AND req_ids IS NOT NULL AND req_ids != '' AND req_ids != '[]'`,
    )
    .all(projectId) as Array<{ req_ids: string; status: string }>;
  const byReq = new Map<string, Array<{ status: string }>>();
  const push = (id: string, status: string): void => {
    const bucket = byReq.get(id);
    if (bucket) bucket.push({ status });
    else byReq.set(id, [{ status }]);
  };
  for (const p of plans) for (const id of parseReqIds(p.req_ids)) push(id, p.status);
  for (const t of tasks) for (const id of parseReqIds(t.req_ids)) push(id, t.status);

  const changed: string[] = [];
  const ts = new Date().toISOString();
  const readStmt = db.prepare('SELECT status FROM prd_requirements WHERE id = ? AND project_id = ?');
  const writeStmt = db.prepare('UPDATE prd_requirements SET status = ?, updated_at = ? WHERE id = ?');
  for (const rid of uniq) {
    const row = readStmt.get(rid, projectId) as { status: string } | undefined;
    if (!row) continue; // 关联指向已删除/跨项目需求：没有可写对象
    if (row.status === 'changed') continue; // 业务判断优先于执行进度
    const next = deriveReqStatus(byReq.get(rid) ?? []);
    if (next === null || next === row.status) continue;
    writeStmt.run(next, ts, rid);
    changed.push(rid);
  }
  return changed;
}

/**
 * T00470 对账家族的需求侧成员：启动时把**全部**有关联的需求按派生口径对齐
 * （AI/脚本直写 sqlite 绕过钩子、或旧版本从未派生过的存量，都在这里兜底）。
 * 生产库首跑预计把 308 条「关联项全 done 但 status=todo」的需求归位。
 */
export function reconcileReqStatuses(): number {
  const db = getDb();
  const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
  let fixed = 0;
  for (const p of projects) {
    const plans = db
      .prepare(
        `SELECT req_ids FROM plan_tasks
          WHERE project_id = ? AND archived = 0 AND req_ids IS NOT NULL AND req_ids != '' AND req_ids != '[]'`,
      )
      .all(p.id) as Array<{ req_ids: string }>;
    const tasks = db
      .prepare(
        `SELECT req_ids FROM tasks
          WHERE project_id = ? AND archived = 0 AND req_ids IS NOT NULL AND req_ids != '' AND req_ids != '[]'`,
      )
      .all(p.id) as Array<{ req_ids: string }>;
    const reqIds = [...plans, ...tasks].flatMap((r) => parseReqIds(r.req_ids));
    fixed += syncReqStatuses(db, p.id, reqIds).length;
  }
  return fixed;
}
