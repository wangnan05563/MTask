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
import { getSetting } from './AppSettings'; // T01270：停滞阈值读 app_settings（supervisor.sessionStaleMs）
import { normalizePlatform } from '../util/platform'; // T01288：平台标识归一化（会话按平台唯一，防大小写分裂）
import { TaskService } from './TaskService';

/** T01270（FR-1.3）：会话停滞默认阈值 10 分钟——超过无心跳即视为停滞（PRD FR-1.3） */
const DEFAULT_SESSION_STALE_MS = 10 * 60 * 1000;
/** 阈值配置键：与 PRD 配置命名一致，M2 的 SupervisorService 直接复用同一键 */
const SESSION_STALE_KEY = 'supervisor.sessionStaleMs';

/** 停滞阈值解析：显式入参 > app_settings 配置 > 默认 10 分钟（非法值一律回退默认，避免 0/NaN 把全部会话误判停滞） */
function resolveStaleMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  const raw = getSetting(SESSION_STALE_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_STALE_MS;
}

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

/** T01281：认领冲突的内部信号——仅在事务内抛出以触发回滚，不外泄给调用方（MCP 层只看到结构化结果） */
class ClaimConflictError extends Error {}

/** T01281（FR-3.2 / §6.1）：原子认领入参 */
export interface ClaimTaskInput {
  platform: string;
  sessionId: string;
  /** 任务内部 id 或任务编号（Txxxxx），与心跳上报同口径 */
  taskRef: string;
}

/** T01281（FR-3.2）：认领结果——冲突不抛异常：外部平台需要区分「被别人抢走」与「服务出错」，前者应换任务而非重试 */
export interface ClaimTaskResult {
  claimed: boolean;
  /** 未认领成功的原因：not_found=任务不存在 | already_claimed=已被认领 | not_ready=非待办/已归档 */
  reason?: 'not_found' | 'already_claimed' | 'not_ready';
  taskNo?: string | null;
  /** 冲突时回显当前 ai_state，便于平台判断是否是自己已有会话在跑 */
  aiState?: string;
  sessionRowId?: string;
}
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
    const platform = normalizePlatform(input.platform);
    const sessionId = (input.sessionId ?? '').trim();
    if (!platform) throw new Error('platform 必填');
    if (!sessionId) throw new Error('session_id 必填');
    const task = resolveTaskRef((input.taskRef ?? '').trim());
    if (!task) throw new Error(`任务不存在：${input.taskRef}`);

    const now = new Date().toISOString();
    const pctProvided = typeof input.pct === 'number' && Number.isFinite(input.pct);
    // 完成判定：平台显式声明 done，或进度已到 100（PRD §6.1）
    const finished = input.done === true || (pctProvided && clampPct(input.pct as number) >= 100);

    // T01288：列侧 LOWER/TRIM 兜底存量行——归一化只在写入侧生效，会话行按 platform+session_id 唯一，
    // 大小写不一致会让同一会话被判成两个（面板分裂、停滞判定各看一半）。
    const existing = db.prepare(
      'SELECT * FROM exec_sessions WHERE LOWER(TRIM(platform)) = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1',
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

  /**
   * T01281（FR-3.2 / §6.1）：原子认领——多平台同时拉到同一任务时，保证只有一个能认领成功。
   *
   * 并发安全由「immediate 写事务 + 条件 UPDATE」双重保证，缺一不可：
   * - `immediate`：事务开始即取写锁，避免 deferred 事务「先读后写」时升级锁失败（SQLITE_BUSY），
   *   或两个事务都基于同一份旧快照做判断的竞态；
   * - `WHERE ai_state = ''`：认领成立与否由数据库在写入瞬间裁决（changes=0 即已被抢走），
   *   而不是「先 SELECT 校验、再 UPDATE」——两者之间有窗口，正是重复执行/多平台抢单的根源。
   *
   * 冲突时抛内部信号回滚整个事务：新会话行一并撤销，不留「有会话但任务没跑」的脏数据。
   */
  claimTask(input: ClaimTaskInput): ClaimTaskResult {
    const db = getDb();
    const platform = normalizePlatform(input.platform);
    const sessionId = (input.sessionId ?? '').trim();
    if (!platform) throw new Error('platform 必填');
    if (!sessionId) throw new Error('session_id 必填');
    const task = resolveTaskRef((input.taskRef ?? '').trim());
    if (!task) return { claimed: false, reason: 'not_found' };

    const ts = new Date().toISOString();
    const run = db.transaction((): ClaimTaskResult => {
      // 会话先行：exec_session_id 要写进任务，必须先拿到（或建好）会话行
      const existing = db.prepare(
        'SELECT * FROM exec_sessions WHERE LOWER(TRIM(platform)) = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1',
      ).get(platform, sessionId) as ExecSessionRow | undefined;
      const sessionRowId = existing?.id ?? randomUUID();
      if (existing) {
        // 复用会话：并入本次认领的任务、刷新心跳；已 done/stalled 的会话被重新认领即回 active（PRD §8）
        db.prepare(
          "UPDATE exec_sessions SET task_ids = ?, status = 'active', last_heartbeat = ?, finished_at = NULL WHERE id = ?",
        ).run(mergeTaskIds(existing.task_ids, task.id), ts, sessionRowId);
      } else {
        db.prepare(
          `INSERT INTO exec_sessions
             (id, platform, session_id, task_ids, status, progress, phase, last_heartbeat, started_at, finished_at)
           VALUES (?, ?, ?, ?, 'active', 0, '', ?, ?, NULL)`,
        ).run(sessionRowId, platform, sessionId, JSON.stringify([task.id]), ts, ts);
      }
      // 原子认领：status='todo' + archived=0 一并约束——已完成/已归档任务即便 ai_state 为空也不该被拉走重跑（PRD §8 状态机）。
      // monitor_ready 同事务清零：认领即出就绪池，否则任务日后被清空 ai_state 时仍带旧标记、会被再次拉取执行。
      const r = db.prepare(
        `UPDATE tasks
            SET ai_state = 'running', ai_state_at = ?, exec_session_id = ?, monitor_ready = 0, updated_at = ?
          WHERE id = ? AND ai_state = '' AND status = 'todo' AND archived = 0`,
      ).run(ts, sessionRowId, ts, task.id);
      if (r.changes === 0) throw new ClaimConflictError();
      return { claimed: true, taskNo: task.task_no, aiState: 'running', sessionRowId };
    });

    try {
      return run.immediate();
    } catch (e) {
      if (!(e instanceof ClaimConflictError)) throw e;
      // 回滚后重新读库判定冲突原因（回滚已撤销会话侧写入，此处读到的是其他赢家提交后的状态）
      const cur = db.prepare('SELECT ai_state FROM tasks WHERE id = ?').get(task.id) as { ai_state: string } | undefined;
      const taken = !!cur && cur.ai_state !== '';
      return { claimed: false, reason: taken ? 'already_claimed' : 'not_ready', taskNo: task.task_no, aiState: cur?.ai_state ?? '' };
    }
  },

  /** 按平台+会话标识取会话（供 MCP 返回与后续停滞判定复用）；T01288：入参先归一化，与写入侧同口径 */
  getByPlatformSession(platform: string, sessionId: string): ExecSessionRow | null {
    return (getDb().prepare(
      'SELECT * FROM exec_sessions WHERE LOWER(TRIM(platform)) = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(normalizePlatform(platform), sessionId) as ExecSessionRow | undefined) ?? null;
  },

  /**
   * T01270（FR-1.3）：停滞兜底——把 last_heartbeat 超阈值（默认 10min，可配 `supervisor.sessionStaleMs`）
   * 的 active 会话置 stalled。
   *
   * 设计取舍：
   * - **探测优先**（对齐 TaskService.expireStaleRunning）：先用一次轻量 SELECT 判断有无超时会话
   *   （走 idx_exec_platform_status），无则直接返回，避免每次 tick 都开写事务；
   * - **只改会话状态，不动任务 ai_state**：任务侧超时由 TaskService.expireStaleRunning 兜底
   *   （PRD FR-1.3 后半句），两者阈值语义不同（会话 10min 是「平台是否还在干活」，任务 1h 是
   *   「Agent 是否已中断」），混用会让长任务被误判中断；
   * - 停滞只是**观测信号**，M1 阶段不触发任何自动动作（P0 仅观测）；自愈路径在 reportProgress
   *   里（stalled 会话收到新心跳即回 active，PRD §8 状态机）。
   */
  expireStaleSessions(maxAgeMs?: number): number {
    const db = getDb();
    const staleMs = resolveStaleMs(maxAgeMs);
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const probe = db.prepare(
      "SELECT id FROM exec_sessions WHERE status = 'active' AND last_heartbeat < ? LIMIT 1",
    ).get(cutoff) as { id: string } | undefined;
    if (!probe) return 0;
    const r = db.prepare(
      "UPDATE exec_sessions SET status = 'stalled' WHERE status = 'active' AND last_heartbeat < ?",
    ).run(cutoff);
    if (r.changes > 0) {
      console.warn(`[ExecSessionService] ${r.changes} 个执行会话超过 ${Math.round(staleMs / 60000)} 分钟无心跳，置 stalled（FR-1.3 停滞兜底）`);
    }
    return r.changes;
  },
};