import type Database from 'better-sqlite3';

/**
 * T06294（REQ-001 / AC-01）：Today View 聚合服务。
 *
 * 只读当前工作集，不参与历史资产、趋势或统计周期；所有查询都在库内聚合 + LIMIT，
 * 前端不会为了首页去拉 5k 任务全量。窗口口径：
 * - 今天做：未归档、未搁置、待办中的置顶 / 紧急 / 高优先级任务（当前任务模型无截止日与指派人，
 *   这里以“现在最该动”的可排序信号替代，页面副标题会明示该口径）；
 * - 等我处理：AI 失败、AI 结果未读、待验证、待裁决四类需要人接手的任务；
 * - AI 正在跑：最近 50 个执行会话中的 active 会话优先，未被会话覆盖的 ai_state=running 任务兜底展示。
 *
 * 会话读取刻意不调用 ExecSessionService.listSessions()：后者会顺带做停滞判定写库，
 * 首页每刷新一次都触发全量会话收敛会把首屏预算消耗在非展示工作上；本服务只读最近 50 行，
 * 停滞由既有调度器按周期收敛，首页告警只对已落库状态做提示。
 */

export type TodayWaitReason = 'ai_failed' | 'ai_unread' | 'verify_pending' | 'ruling_pending';

export interface TodayTaskItem {
  id: string;
  task_no: string | null;
  title: string;
  priority: string;
  status: string;
  ai_state: string;
  verified: number;
  pinned: number;
  updated_at: string;
  project_id: string;
  project_name: string | null;
  /** 等我处理分组的原因；今天做分组为空 */
  reason?: TodayWaitReason;
}

export interface TodayRunningItem {
  /** session=来自执行会话；task=没有活跃会话但任务仍标 running 的兜底行 */
  kind: 'session' | 'task';
  id: string;
  task_id: string | null;
  task_no: string | null;
  title: string;
  project_id: string;
  project_name: string | null;
  platform: string | null;
  progress: number;
  progress_reported: boolean;
  phase: string;
  started_at: string;
  /** 同一执行会话关联的其它任务数（0=只有当前任务） */
  other_tasks: number;
}

export interface TodayAlert {
  id: string;
  level: 'danger' | 'warning';
  title: string;
  detail: string;
  count: number;
}

/** 首页只需要的会话字段；tasks 为 task_ids 解析后的轻量摘要 */
interface TodaySession {
  id: string;
  platform: string;
  status: string;
  progress: number;
  progress_reported: number;
  phase: string;
  started_at: string;
  tasks: Array<{
    id: string;
    task_no: string | null;
    title: string;
    status: string;
    archived: number;
    project_id: string;
    project_name: string | null;
  }>;
}

function parseTaskIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 最近 50 个执行会话 + 关联任务摘要（只读，不做停滞写库） */
function loadRecentSessions(db: Database.Database): TodaySession[] {
  const rows = db.prepare(
    `SELECT id, platform, status, progress, progress_reported, phase, started_at, last_heartbeat, task_ids
       FROM exec_sessions ORDER BY last_heartbeat DESC LIMIT 50`,
  ).all() as Array<{
    id: string; platform: string; status: string; progress: number; progress_reported: number;
    phase: string; started_at: string; last_heartbeat: string; task_ids: string;
  }>;
  const ids = new Set<string>();
  for (const row of rows) for (const id of parseTaskIds(row.task_ids)) ids.add(id);
  const taskMap = new Map<string, TodaySession['tasks'][number]>();
  const all = [...ids];
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT t.id, t.task_no, t.title, t.status, t.archived, t.project_id, p.name AS project_name
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id IN (${placeholders})`,
    ).all(...chunk) as TodaySession['tasks'];
    for (const task of found) taskMap.set(task.id, task);
  }
  return rows.map((row) => ({
    ...row,
    tasks: parseTaskIds(row.task_ids).map((id) => taskMap.get(id)).filter((t): t is TodaySession['tasks'][number] => !!t),
  }));
}

export interface TodayView {
  generated_at: string;
  summary: {
    /** 首屏实际展示的今日行动条数（最多 7 条） */
    today: number;
    /** 满足今日行动口径的候选总数；页面副标题据此说明“从 N 条中取前 7” */
    today_candidates: number;
    waiting: number;
    running: number;
    alerts: number;
  };
  today: TodayTaskItem[];
  waiting: {
    items: TodayTaskItem[];
    counts: {
      total: number;
      ai_failed: number;
      ai_unread: number;
      verify_pending: number;
      ruling_pending: number;
    };
  };
  running: {
    items: TodayRunningItem[];
    active_sessions: number;
  };
  alerts: TodayAlert[];
}

const PROJECT_JOIN = 'LEFT JOIN projects p ON p.id = t.project_id';
const TASK_COLUMNS = `t.id, t.task_no, t.title, t.priority, t.status, t.ai_state,
  t.verified, t.pinned, t.updated_at, t.project_id, p.name AS project_name`;

/** 今日动作池：只取待办中的置顶与高优先级；排序稳定，避免 5k 库让“先做哪件”随机漂移 */
const TODAY_WHERE = `t.archived = 0 AND COALESCE(t.history_at, '') = '' AND t.status = 'todo' AND COALESCE(t.shelved, 0) = 0
  AND (t.pinned = 1 OR t.priority IN ('urgent', 'high'))`;
const TODAY_ORDER = `ORDER BY t.pinned DESC,
  CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 9 END,
  t.updated_at DESC`;

/** 需要人接手的当前工作集（不做历史清仓）：
 *  - 未完成任务的 AI 失败 / 未读 / 待裁决；
 *  - 已完成但未验证（当前验证积压）；
 *  - 最近 7 天完成但结果未读（近期回传需要确认；更早的 1.8k 未读属于历史资产，不塞进首页）。
 *  互有重叠，计数按信号分别给，total 取 DISTINCT 行数。 */
const WAIT_BASE = `t.archived = 0 AND COALESCE(t.history_at, '') = '' AND COALESCE(t.shelved, 0) = 0`;
const WAIT_CRITERIA = `((t.status = 'todo' AND (t.ai_state IN ('failed', 'unread') OR t.ruling_state = '待裁决'))
  OR (t.status = 'done' AND t.verified = 0)
  OR (t.status = 'done' AND t.ai_state = 'unread' AND t.updated_at >= ?))`;

const WAIT_REASON_CASE = `CASE
  WHEN t.ai_state = 'failed' THEN 'ai_failed'
  WHEN t.ruling_state = '待裁决' THEN 'ruling_pending'
  WHEN t.ai_state = 'unread' THEN 'ai_unread'
  ELSE 'verify_pending' END`;

function projectClause(projectId: string): { where: string; args: string[] } {
  return projectId ? { where: ' AND t.project_id = ?', args: [projectId] } : { where: '', args: [] };
}

/**
 * 构造 Today 视图。`exec_sessions` 只读最近 50 行；本函数不触发会话心跳/停滞写库。
 */
export function buildTodayView(
  db: Database.Database,
  projectId: string,
): TodayView {
  const project = projectClause(projectId);
  const sessions = loadRecentSessions(db);
  const recentCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const waitWhere = `${WAIT_BASE}${project.where} AND ${WAIT_CRITERIA}`;
  const waitArgs = [...project.args, recentCutoff];

  const todayRows = db.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks t ${PROJECT_JOIN}
      WHERE ${TODAY_WHERE}${project.where} ${TODAY_ORDER} LIMIT 7`,
  ).all(...project.args) as TodayTaskItem[];

  const todayCount = db.prepare(
    `SELECT COUNT(*) AS c FROM tasks t WHERE ${TODAY_WHERE}${project.where}`,
  ).get(...project.args) as { c: number };

  const waitingRows = db.prepare(
    `SELECT ${TASK_COLUMNS}, ${WAIT_REASON_CASE} AS reason FROM tasks t ${PROJECT_JOIN}
      WHERE ${waitWhere}
      ORDER BY CASE
        WHEN t.ai_state = 'failed' THEN 0
        WHEN t.ruling_state = '待裁决' THEN 1
        WHEN t.ai_state = 'unread' THEN 2
        ELSE 3 END,
        t.updated_at DESC
      LIMIT 5`,
  ).all(...waitArgs) as TodayTaskItem[];

  const waitingCounts = db.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN t.ai_state = 'failed' THEN 1 ELSE 0 END) AS ai_failed,
       SUM(CASE WHEN t.ai_state = 'unread' THEN 1 ELSE 0 END) AS ai_unread,
       SUM(CASE WHEN t.status = 'done' AND t.verified = 0 THEN 1 ELSE 0 END) AS verify_pending,
       SUM(CASE WHEN t.ruling_state = '待裁决' THEN 1 ELSE 0 END) AS ruling_pending
     FROM tasks t WHERE ${waitWhere}`,
  ).get(...waitArgs) as {
    total: number; ai_failed: number | null; ai_unread: number | null;
    verify_pending: number | null; ruling_pending: number | null;
  };

  const runningTaskRows = db.prepare(
    `SELECT ${TASK_COLUMNS}, t.progress FROM tasks t ${PROJECT_JOIN}
      WHERE t.archived = 0 AND COALESCE(t.history_at, '') = '' AND t.ai_state = 'running'${project.where}
      ORDER BY t.ai_state_at DESC LIMIT 12`,
  ).all(...project.args) as Array<TodayTaskItem & { progress: number }>;

  const activeSessions = sessions.filter((s) => s.status === 'active');
  const runningItems: TodayRunningItem[] = [];
  let activeSessionCount = 0;
  for (const session of activeSessions) {
    const tasks = projectId
      ? session.tasks.filter((t) => t.project_id === projectId && t.archived === 0)
      : session.tasks.filter((t) => t.archived === 0);
    if (tasks.length === 0) continue;
    activeSessionCount += 1;
    for (const [index, task] of tasks.entries()) {
      runningItems.push({
        kind: 'session',
        id: index === 0 ? session.id : `${session.id}:${task.id}`,
        task_id: task.id,
        task_no: task.task_no,
        title: task.title,
        project_id: task.project_id,
        project_name: task.project_name,
        platform: session.platform,
        progress: session.progress,
        progress_reported: session.progress_reported === 1,
        phase: session.phase || '执行中',
        started_at: session.started_at,
        other_tasks: Math.max(0, tasks.length - 1),
      });
    }
  }

  // 兜底：有任务已标 running 但没有活跃会话可关联（例如平台刚置态、会话行已被清理）。
  // 不把这类无声运行藏起来，首页显式给“执行中 + 无会话”的提示。
  for (const task of runningTaskRows) {
    if (runningItems.some((item) => item.task_id === task.id)) continue;
    runningItems.push({
      kind: 'task',
      id: `task:${task.id}`,
      task_id: task.id,
      task_no: task.task_no,
      title: task.title,
      project_id: task.project_id,
      project_name: task.project_name,
      platform: null,
      progress: task.progress ?? 0,
      progress_reported: true,
      phase: 'AI 执行中（暂无执行会话）',
      started_at: task.updated_at,
      other_tasks: 0,
    });
  }

  const stalledSessions = sessions.filter((s) => s.status === 'stalled');
  const alerts: TodayAlert[] = [];
  const aiFailed = waitingCounts.ai_failed ?? 0;
  if (aiFailed > 0) {
    alerts.push({
      id: 'ai-failed',
      level: 'danger',
      title: `${aiFailed} 个任务的 AI 执行失败`,
      detail: '打开任务查看失败原因，必要时重试或改派。',
      count: aiFailed,
    });
  }
  const stalledInProject = projectId
    ? stalledSessions.filter((s) => s.tasks.some((t) => t.project_id === projectId))
    : stalledSessions;
  if (stalledInProject.length > 0) {
    alerts.push({
      id: 'session-stalled',
      level: 'warning',
      title: `最近 50 个会话中，${stalledInProject.length} 个已停滞`,
      detail: '心跳超时，任务可能卡住；到 AI 控制台查看并重派。',
      count: stalledInProject.length,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    summary: {
      today: todayRows.length,
      today_candidates: todayCount.c,
      waiting: waitingCounts.total,
      running: runningItems.length,
      alerts: alerts.length,
    },
    today: todayRows,
    waiting: {
      items: waitingRows,
      counts: {
        total: waitingCounts.total,
        ai_failed: aiFailed,
        ai_unread: waitingCounts.ai_unread ?? 0,
        verify_pending: waitingCounts.verify_pending ?? 0,
        ruling_pending: waitingCounts.ruling_pending ?? 0,
      },
    },
    running: {
      items: runningItems.slice(0, 6),
      active_sessions: activeSessionCount,
    },
    alerts,
  };
}
