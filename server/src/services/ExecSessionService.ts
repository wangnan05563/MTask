/**
 * T01269（PRD FR-1.2）：外部平台执行会话服务——AI 编排大脑的观测层。
 *
 * 外部平台（WorkBuddy/Trae/中继）执行期间周期调用 `mtask_report_progress` 上报心跳，
 * 本服务 upsert `exec_sessions` 并同步任务 AI 状态；Supervisor 据此判定会话存活/停滞
 * （FR-1.3）并驱动后续 RESUME/REDISPATCH 决策。
 *
 * 数据模型见 PRD §5.1（exec_sessions）；本服务只负责观测写入，不做自动动作（P0 仅观测）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { TaskService } from './TaskService';

/** exec_sessions 行（PRD §5.1） */
export interface ExecSessionRow {
  id: string;
  platform: string;
  session_id: string | null;
  task_ids: string;
  status: string;
  progress: number;
  phase: string;
  last_heartbeat: string;
  started_at: string;
  finished_at: string | null;
}

export interface ReportProgressInput {
  platform: string;
  /** 平台侧会话标识 */
  sessionId: string;
  /** 任务内部 id 或任务编号（Txxxxx），二者皆可 */
  taskRef: string;
  phase?: string;
  pct?: number;
  /** 平台侧附注（当前数据模型无对应列，仅回显，供后续审计扩展） */
  note?: string;
  /** 平台显式声明本轮执行已完成 */
  done?: boolean;
}

export interface ReportProgressResult {
  sessionRowId: string;
  status: string;
  progress: number;
  taskNo: string | null;
  taskState: string;
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, n));

/** 任务定位：内部 id 优先，其次任务编号（外部平台通常只持有编号） */
function resolveTaskRef(ref: string): { id: string; task_no: string | null } | null {
  const db = getDb();
  const byId = db.prepare('SELECT id, task_no FROM tasks WHERE id = ?').get(ref) as
    | { id: string; task_no: string | null }
    | undefined;
  if (byId) return byId;
  return (db.prepare('SELECT id, task_no FROM tasks WHERE task_no = ?').get(ref) as
    | { id: string; task_no: string | null }
    | undefined) ?? null;
}

/** task_ids（JSON 数组字符串）并入新任务 id 并去重；脏数据按空数组处理 */
function mergeTaskIds(raw: string, taskId: string): string {
  let list: string[] = [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) list = v.filter((x): x is string => typeof x === 'string');
  } catch {
    // 存量脏数据不阻断上报：按空数组重建
  }
  if (!list.includes(taskId)) list.push(taskId);
  return JSON.stringify(list);
}

export const ExecSessionService = {
  /**
   * FR-1.2：心跳与进度上报。按 platform+session_id upsert 会话、刷新 last_heartbeat，
   * 并把关联任务置 running（完成则置终态 unread）。
   */
  reportProgress(input: ReportProgressInput): ReportProgressResult {
    const db = getDb();
    const platform = (input.platform ?? '').trim();
    const sessionId = (input.sessionId ?? '').trim();
    if (!platform) throw new Error('platform 必填');
    if (!sessionId) throw new Error('session_id 必填');
    const task = resolveTaskRef((input.taskRef ?? '').trim());
    if (!task) throw new Error(`任务不存在：${input.taskRef}`);

    const now = new Date().toISOString();
    const pctProvided = typeof input.pct === 'number' && Number.isFinite(input.pct);
    // 完成判定：平台显式声明 done，或进度已到 100（PRD §6.1）
    const finished = input.done === true || (pctProvided && clampPct(input.pct as number) >= 100);

    const existing = db.prepare(
      'SELECT * FROM exec_sessions WHERE platform = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(platform, sessionId) as ExecSessionRow | undefined;

    let sessionRowId: string;
    if (existing) {
      sessionRowId = existing.id;
      // 心跳到达即证明会话重新活跃：stalled → active（PRD §8 状态机）；完成则终态 done
      const nextStatus = finished ? 'done' : (existing.status === 'stalled' ? 'active' : existing.status);
      const nextPct = finished ? 100 : (pctProvided ? clampPct(input.pct as number) : existing.progress);
      const nextPhase = input.phase !== undefined ? input.phase : existing.phase;
      db.prepare(
        `UPDATE exec_sessions
            SET task_ids = ?, status = ?, progress = ?, phase = ?, last_heartbeat = ?, finished_at = ?
          WHERE id = ?`,
      ).run(
        mergeTaskIds(existing.task_ids, task.id), nextStatus, nextPct, nextPhase, now,
        finished ? (existing.finished_at ?? now) : existing.finished_at, sessionRowId,
      );
    } else {
      sessionRowId = randomUUID();
      db.prepare(
        `INSERT INTO exec_sessions
           (id, platform, session_id, task_ids, status, progress, phase, last_heartbeat, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionRowId, platform, sessionId, JSON.stringify([task.id]),
        finished ? 'done' : 'active',
        finished ? 100 : (pctProvided ? clampPct(input.pct as number) : 0),
        input.phase ?? '', now, now, finished ? now : null,
      );
    }

    // 任务↔会话绑定（PRD §5.3 exec_session_id）：心跳即证明该任务正在此会话中执行
    db.prepare('UPDATE tasks SET exec_session_id = ? WHERE id = ?').run(sessionRowId, task.id);
    // 同步任务 AI 状态：执行中 running；完成 → unread 终态（PRD §6.1 / §8）
    const taskState = finished ? 'unread' : 'running';
    TaskService.setAiState(task.id, taskState);

    const saved = db.prepare('SELECT * FROM exec_sessions WHERE id = ?').get(sessionRowId) as ExecSessionRow;
    return {
      sessionRowId: saved.id,
      status: saved.status,
      progress: saved.progress,
      taskNo: task.task_no,
      taskState,
    };
  },

  /** 按平台+会话标识取会话（供 MCP 返回与后续停滞判定复用） */
  getByPlatformSession(platform: string, sessionId: string): ExecSessionRow | null {
    return (getDb().prepare(
      'SELECT * FROM exec_sessions WHERE platform = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(platform, sessionId) as ExecSessionRow | undefined) ?? null;
  },
};