import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { TaskService, type TaskInput, type TaskView } from './TaskService';

/**
 * T06295（REQ-032 / PRD §A2）：可操作收件箱服务。
 *
 * 收件箱不接邮件，也不复制通知流；它把当前工作集里「需要人处理」的事件收敛成统一条目：
 * - decision：任务结论待裁决；
 * - ai_failed：AI 执行失败；
 * - verify_pending：任务已完成但未验证；
 * - system：最近 50 个执行会话中的停滞会话。
 *
 * 同一事件按 event_key 去重；event_version 记录本次事件实例，同一来源再次发生（重新失败/再次待验证/再次停滞）
 * 时允许终态条目重开，避免被旧事件键永久吞掉。
 * 每次列表读取做一次幂等同步，源事件消失后 open 条目自动收敛为 resolved。
 * 认领只写 assignee/claimed_at，status 仍是 open（否则「已认领」会从待处理统计里消失）；
 * 认领是排他的、可取消的，并写 inbox_audit，为后续团队模式保留操作者语义。
 * 转任务只允许没有 task_id 的条目，避免把已有任务复制成第二份；创建走 TaskService，编号/事件与普通建单一致。
 */

export type InboxType = 'decision' | 'ai_failed' | 'verify_pending' | 'system';
export type InboxStatus = 'open' | 'ignored' | 'resolved';
export type InboxSeverity = 'info' | 'warning' | 'danger';
export type InboxSource = 'task' | 'exec_session' | 'manual';
export type InboxAuditAction = 'claim' | 'unclaim' | 'ignore' | 'convert' | 'source_cleared' | 'reopen';

export interface InboxItemView {
  id: string;
  type: InboxType;
  source: InboxSource;
  task_id: string | null;
  task_no: string | null;
  task_status: string | null;
  run_id: string | null;
  project_id: string | null;
  project_name: string | null;
  title: string;
  body: string;
  severity: InboxSeverity;
  status: InboxStatus;
  assignee: string;
  unread: boolean;
  resolution: string;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  claim_expires_at: string | null;
  resolved_at: string | null;
}

export interface InboxCounts {
  open: number;
  unread: number;
  decision: number;
  ai_failed: number;
  verify_pending: number;
  system: number;
}

export interface InboxListResult {
  items: InboxItemView[];
  total: number;
  counts: InboxCounts;
  /** 服务端解析出的当前操作者；前端用它判断「我认领的」，不再由客户端硬编码身份。 */
  viewer: string;
  generated_at: string;
}

export interface InboxAuditEntry {
  id: string;
  inbox_id: string;
  action: InboxAuditAction;
  actor: string;
  from_assignee: string;
  to_assignee: string;
  detail: string;
  created_at: string;
}

export interface InboxListQuery {
  type?: InboxType | '';
  status?: InboxStatus;
  projectId?: string;
  assignee?: string;
  claimed?: 'yes' | 'no' | 'mine' | '';
  /** 服务端解析出的当前操作者；只由路由注入，不从请求体读取。 */
  actor?: string;
  limit?: number;
  offset?: number;
}

export class InboxError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'InboxError';
  }
}

interface RawInboxRow {
  id: string;
  type: InboxType;
  source: InboxSource;
  task_id: string | null;
  task_no: string | null;
  task_status: string | null;
  run_id: string | null;
  project_id: string | null;
  project_name: string | null;
  title: string;
  body: string;
  severity: InboxSeverity;
  status: InboxStatus;
  assignee: string;
  unread: number;
  resolution: string;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  claim_expires_at: string | null;
  resolved_at: string | null;
}

interface RawAuditRow extends InboxAuditEntry {}

type TaskCreator = (input: TaskInput) => TaskView;

const TYPE_VALUES = new Set<InboxType>(['decision', 'ai_failed', 'verify_pending', 'system']);
const STATUS_VALUES = new Set<InboxStatus>(['open', 'ignored', 'resolved']);
const CLAIMED_VALUES = new Set(['yes', 'no', 'mine']);
/** 单机默认身份；团队模式接入账号后应由服务端会话解析，不能继续信任客户端传值。 */
export const LOCAL_INBOX_ACTOR = '我';
const DEFAULT_ACTOR = LOCAL_INBOX_ACTOR;
const MAX_ACTOR_LENGTH = 40;
/** 认领租约：30 分钟无动作自动回到未认领，避免团队成员离线后把条目永久锁死。 */
const CLAIM_TTL_MS = 30 * 60_000;
/** 同步批次：不再用固定 LIMIT 静默截断；按批读完所有候选。 */
const TASK_SYNC_BATCH = 500;
const SESSION_SYNC_BATCH = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function normalizeActor(value?: string): string {
  const actor = (value ?? '').trim() || DEFAULT_ACTOR;
  if (actor.length > MAX_ACTOR_LENGTH) throw new InboxError(`操作者名称过长（最多 ${MAX_ACTOR_LENGTH} 字）`);
  return actor;
}

/** 事件实例键：时间戳缺失的老数据统一记为 legacy，避免每次同步都误判成新事件。 */
function eventVersionOf(value: string | null | undefined): string {
  return value && value.trim() ? value : 'legacy';
}

/** 90 天是 PRD §A2 的默认保留窗口；超窗任务不生成新条目，存量条目仍可查询。 */
const RETENTION_DAYS = 90;
/** 同一事件实例的 last_seen 节流：2 分钟内不反复写库。 */
const REMARK_AFTER_MS = 2 * 60_000;
/** 超过 10 分钟未见到的 open 源条目视为源事件已消失，自动 resolved。 */
const STALE_AFTER_MS = 10 * 60_000;

export class InboxService {
  constructor(
    private readonly db: Database.Database = getDb(),
    private readonly createTask: TaskCreator = (input) => TaskService.create(input),
  ) {}

  /** 幂等同步：新增源事件条目，标记仍存在的事件，自动收敛长期未见的 open 条目。 */
  sync(): void {
    const now = nowIso();
    const remarkCutoff = new Date(Date.now() - REMARK_AFTER_MS).toISOString();
    const staleCutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    const retentionCutoff = daysAgo(RETENTION_DAYS);
    const upsert = this.db.prepare(`
      INSERT INTO inbox_items
        (id, type, source, task_id, run_id, project_id, title, body, severity,
         status, assignee, event_key, event_version, unread, resolution,
         created_at, updated_at, claimed_at, claim_expires_at, resolved_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '', ?, ?, 1, '', ?, ?, NULL, NULL, NULL, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        title = excluded.title,
        body = excluded.body,
        project_id = excluded.project_id,
        task_id = excluded.task_id,
        run_id = excluded.run_id,
        last_seen_at = excluded.last_seen_at,
        event_version = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN event_version
          ELSE excluded.event_version
        END,
        status = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN status
          WHEN event_version = '' THEN status
          WHEN event_version = excluded.event_version THEN status
          ELSE 'open'
        END,
        assignee = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN assignee
          WHEN event_version = '' THEN assignee
          WHEN event_version = excluded.event_version THEN assignee
          WHEN status = 'open' THEN assignee
          ELSE ''
        END,
        claimed_at = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN claimed_at
          WHEN event_version = '' THEN claimed_at
          WHEN event_version = excluded.event_version THEN claimed_at
          WHEN status = 'open' THEN claimed_at
          ELSE NULL
        END,
        claim_expires_at = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN claim_expires_at
          WHEN event_version = '' THEN claim_expires_at
          WHEN event_version = excluded.event_version THEN claim_expires_at
          WHEN status = 'open' THEN claim_expires_at
          ELSE NULL
        END,
        unread = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN unread
          WHEN event_version = '' THEN unread
          WHEN event_version = excluded.event_version THEN unread
          ELSE 1
        END,
        resolution = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN resolution
          WHEN event_version = '' THEN resolution
          WHEN event_version = excluded.event_version THEN resolution
          ELSE ''
        END,
        created_at = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN created_at
          WHEN event_version = '' THEN created_at
          WHEN event_version = excluded.event_version THEN created_at
          ELSE excluded.created_at
        END,
        updated_at = excluded.updated_at,
        resolved_at = CASE
          WHEN excluded.event_version = 'legacy' AND event_version <> '' THEN resolved_at
          WHEN event_version = '' THEN resolved_at
          WHEN event_version = excluded.event_version THEN resolved_at
          ELSE NULL
        END
      WHERE event_version = ''
         OR event_version <> excluded.event_version
         OR last_seen_at < ?
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 认领租约到期：先释放，再进入来源同步。团队场景下成员离线不会永久锁死条目。
      const expiredClaims = this.db.prepare(`
        SELECT id, assignee
          FROM inbox_items
         WHERE status = 'open'
           AND assignee <> ''
           AND claim_expires_at IS NOT NULL
           AND claim_expires_at <= ?
      `).all(now) as Array<{ id: string; assignee: string }>;
      const expireClaim = this.db.prepare(`
        UPDATE inbox_items
           SET assignee = '', claimed_at = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'open' AND assignee = ?
           AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
      `);
      for (const item of expiredClaims) {
        const changed = expireClaim.run(now, item.id, item.assignee, now).changes;
        if (changed > 0) {
          this.logAudit(item.id, 'unclaim', 'system', item.assignee, '', 'claim_expired');
        }
      }

      const taskQuery = this.db.prepare(`
        WITH candidates AS (
          SELECT t.id, t.task_no, t.title, t.project_id, t.ai_state, t.ai_state_at,
                 t.status, t.verified, t.ruling_state, t.ruling_at, t.updated_at,
                 COALESCE(NULLIF(t.ai_state_at, ''), t.updated_at) AS ai_event_at,
                 COALESCE(NULLIF(t.ruling_at, ''), t.updated_at) AS ruling_event_at,
                 (SELECT MAX(e.created_at)
                    FROM task_events e
                   WHERE e.task_id = t.id
                     AND e.kind = 'status'
                     AND e.detail = 'todo → done') AS done_at
            FROM tasks t
           WHERE t.archived = 0
             AND COALESCE(t.shelved, 0) = 0
             AND COALESCE(t.history_at, '') = ''
             AND (
               (t.status = 'todo' AND t.ai_state = 'failed')
               OR (t.ruling_state = '待裁决')
               OR (t.status = 'done' AND t.verified = 0)
             )
        )
        SELECT id, task_no, title, project_id, ai_state, ai_state_at, status, verified,
               ruling_state, ruling_at, updated_at, done_at
          FROM candidates
         WHERE (status = 'todo' AND ai_state = 'failed' AND ai_event_at >= ?)
            OR (ruling_state = '待裁决' AND ruling_event_at >= ?)
            OR (status = 'done' AND verified = 0 AND COALESCE(done_at, updated_at) >= ?)
         ORDER BY updated_at DESC, id DESC
         LIMIT ? OFFSET ?
      `);

      let taskOffset = 0;
      while (true) {
        const taskRows = taskQuery.all(
          retentionCutoff, retentionCutoff, retentionCutoff, TASK_SYNC_BATCH, taskOffset,
        ) as Array<{
          id: string; task_no: string | null; title: string; project_id: string;
          ai_state: string; ai_state_at: string | null; status: string; verified: number;
          ruling_state: string; ruling_at: string | null; updated_at: string; done_at: string | null;
        }>;
        if (taskRows.length === 0) break;
        for (const task of taskRows) {
          if (task.status === 'todo' && task.ai_state === 'failed') {
            this.upsertEvent(upsert, {
              type: 'ai_failed', source: 'task', taskId: task.id, runId: null, projectId: task.project_id,
              title: task.title, body: 'AI 执行失败，需要人工排查原因或重试。', severity: 'danger',
              eventKey: `task_ai_failed:${task.id}`, eventVersion: eventVersionOf(task.ai_state_at),
            }, now, remarkCutoff);
          }
          if (task.ruling_state === '待裁决') {
            this.upsertEvent(upsert, {
              type: 'decision', source: 'task', taskId: task.id, runId: null, projectId: task.project_id,
              title: task.title, body: '任务结论待裁决，需要你选择采纳、不采纳或补充信息。', severity: 'warning',
              eventKey: `task_ruling:${task.id}`, eventVersion: eventVersionOf(task.ruling_at),
            }, now, remarkCutoff);
          }
          if (task.status === 'done' && task.verified === 0) {
            this.upsertEvent(upsert, {
              type: 'verify_pending', source: 'task', taskId: task.id, runId: null, projectId: task.project_id,
              title: task.title, body: '任务已完成，等待人工验证结果。', severity: 'warning',
              eventKey: `task_verify:${task.id}`, eventVersion: eventVersionOf(task.done_at),
            }, now, remarkCutoff);
          }
        }
        taskOffset += taskRows.length;
        if (taskRows.length < TASK_SYNC_BATCH) break;
      }

      const sessionQuery = this.db.prepare(`
        SELECT id, phase, last_heartbeat, started_at
          FROM exec_sessions
         WHERE status = 'stalled'
         ORDER BY last_heartbeat DESC, id DESC
         LIMIT ? OFFSET ?
      `);
      let sessionOffset = 0;
      while (true) {
        const sessions = sessionQuery.all(SESSION_SYNC_BATCH, sessionOffset) as Array<{
          id: string; phase: string; last_heartbeat: string; started_at: string;
        }>;
        if (sessions.length === 0) break;
        for (const session of sessions) {
          this.upsertEvent(upsert, {
            type: 'system', source: 'exec_session', taskId: null, runId: session.id, projectId: null,
            title: `执行会话停滞：${session.phase || '执行中'}`,
            body: `最近心跳 ${session.last_heartbeat || '未知'}，任务可能卡住；到 AI 控制台查看并重派。`,
            severity: 'warning', eventKey: `session_stalled:${session.id}`,
            eventVersion: eventVersionOf(session.last_heartbeat || session.started_at),
          }, now, remarkCutoff);
        }
        sessionOffset += sessions.length;
        if (sessions.length < SESSION_SYNC_BATCH) break;
      }

      // 现行任务查询有 90 天窗口和 LIMIT 1000；存量 open 条目不能据此判定来源消失。
      // 这里按 task_id/session_id 单独回查真实来源，仍活跃的先续期，避免被误收敛。
      this.db.prepare(`
        UPDATE inbox_items
           SET last_seen_at = ?
         WHERE status = 'open'
           AND source IN ('task', 'exec_session')
           AND last_seen_at < ?
           AND (
             (source = 'task' AND EXISTS (
               SELECT 1 FROM tasks t
                WHERE t.id = inbox_items.task_id
                  AND t.archived = 0
                  AND COALESCE(t.shelved, 0) = 0
                  AND COALESCE(t.history_at, '') = ''
                  AND (
                    (inbox_items.type = 'ai_failed' AND t.status = 'todo' AND t.ai_state = 'failed')
                    OR (inbox_items.type = 'decision' AND t.ruling_state = '待裁决')
                    OR (inbox_items.type = 'verify_pending' AND t.status = 'done' AND t.verified = 0)
                  )
             ))
             OR (source = 'exec_session' AND EXISTS (
               SELECT 1 FROM exec_sessions s
                WHERE s.id = COALESCE(
                        inbox_items.run_id,
                        CASE WHEN inbox_items.event_key LIKE 'session_stalled:%'
                             THEN substr(inbox_items.event_key, 17) ELSE '' END
                      )
                  AND s.status = 'stalled'
             ))
           )
      `).run(now, staleCutoff);

      // 只收敛「源事件型」且长期未见的 open 条目；ignored/resolved 与手动条目不动。
      // 逐条更新并写审计，团队场景能追溯自动关闭是谁/什么动作触发的。
      const staleItems = this.db.prepare(`
        SELECT id, assignee
          FROM inbox_items
         WHERE status = 'open'
           AND source IN ('task', 'exec_session')
           AND last_seen_at < ?
      `).all(staleCutoff) as Array<{ id: string; assignee: string }>;
      const resolveStale = this.db.prepare(`
        UPDATE inbox_items
           SET status = 'resolved', resolution = 'source_cleared', unread = 0,
               assignee = '', claimed_at = NULL, claim_expires_at = NULL,
               resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'open'
      `);
      for (const item of staleItems) {
        const changed = resolveStale.run(now, now, item.id).changes;
        if (changed > 0) {
          this.logAudit(item.id, 'source_cleared', 'system', item.assignee, '', 'source_cleared');
        }
      }

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private upsertEvent(
    upsert: Database.Statement,
    item: {
      type: InboxType; source: InboxSource; taskId: string | null; runId: string | null;
      projectId: string | null; title: string; body: string; severity: InboxSeverity;
      eventKey: string; eventVersion: string;
    },
    now: string,
    remarkCutoff: string,
  ): void {
    const prior = this.db.prepare(`
      SELECT id, status, assignee, event_version
        FROM inbox_items
       WHERE event_key = ?
    `).get(item.eventKey) as {
      id: string; status: InboxStatus; assignee: string; event_version: string;
    } | undefined;
    const reopens = !!prior
      && prior.status !== 'open'
      && prior.event_version !== ''
      && item.eventVersion !== 'legacy'
      && prior.event_version !== item.eventVersion;

    upsert.run(
      randomUUID(), item.type, item.source, item.taskId, item.runId, item.projectId,
      item.title, item.body, item.severity, item.eventKey, item.eventVersion, now, now, now,
      remarkCutoff,
    );

    if (reopens) {
      this.logAudit(
        prior.id, 'reopen', 'system', prior.assignee, '', `${prior.event_version} → ${item.eventVersion}`,
      );
    }
  }

  list(query: InboxListQuery = {}): InboxListResult {
    this.sync();
    const status = query.status ?? 'open';
    if (!STATUS_VALUES.has(status)) throw new InboxError(`状态非法：${status}`);
    const type = query.type ?? '';
    if (type && !TYPE_VALUES.has(type)) throw new InboxError(`分类非法：${type}`);
    const projectId = query.projectId?.trim() ?? '';
    const actor = normalizeActor(query.actor);
    const assignee = query.assignee?.trim() ?? '';
    if (assignee.length > MAX_ACTOR_LENGTH) throw new InboxError(`操作者名称过长（最多 ${MAX_ACTOR_LENGTH} 字）`);
    const claimed = query.claimed ?? '';
    if (claimed && !CLAIMED_VALUES.has(claimed)) throw new InboxError(`认领筛选非法：${claimed}`);
    if (claimed === 'mine' && assignee) throw new InboxError('claimed=mine 与 assignee 不能同时使用');
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);

    const where = ['i.status = ?'];
    const args: Array<string | number> = [status];
    if (type) { where.push('i.type = ?'); args.push(type); }
    if (projectId) { where.push('i.project_id = ?'); args.push(projectId); }
    if (assignee) { where.push('i.assignee = ?'); args.push(assignee); }
    else if (claimed === 'mine') { where.push('i.assignee = ?'); args.push(actor); }
    else if (claimed === 'yes') where.push("i.assignee <> ''");
    else if (claimed === 'no') where.push("i.assignee = ''");
    const whereSql = where.join(' AND ');

    const rows = this.db.prepare(`
      SELECT i.id, i.type, i.source, i.task_id, i.run_id, i.project_id, i.title, i.body,
             i.severity, i.status, i.assignee, i.unread, i.resolution, i.created_at, i.updated_at,
             i.claimed_at, i.claim_expires_at, i.resolved_at,
             t.task_no, t.status AS task_status, p.name AS project_name
        FROM inbox_items i
        LEFT JOIN tasks t ON t.id = i.task_id
        LEFT JOIN projects p ON p.id = i.project_id
       WHERE ${whereSql}
       ORDER BY CASE i.severity WHEN 'danger' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                i.created_at DESC
       LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as RawInboxRow[];
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM inbox_items i WHERE ${whereSql}`)
      .get(...args) as { c: number };
    return {
      items: rows.map(mapRow),
      total: total.c,
      counts: this.counts(projectId),
      viewer: actor,
      generated_at: nowIso(),
    };
  }

  summary(projectId = ''): { counts: InboxCounts; generated_at: string } {
    this.sync();
    return { counts: this.counts(projectId.trim()), generated_at: nowIso() };
  }

  private counts(projectId: string): InboxCounts {
    const projectSql = projectId ? ' AND project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS open,
             COALESCE(SUM(unread), 0) AS unread,
             SUM(CASE WHEN type = 'decision' THEN 1 ELSE 0 END) AS decision,
             SUM(CASE WHEN type = 'ai_failed' THEN 1 ELSE 0 END) AS ai_failed,
             SUM(CASE WHEN type = 'verify_pending' THEN 1 ELSE 0 END) AS verify_pending,
             SUM(CASE WHEN type = 'system' THEN 1 ELSE 0 END) AS system
        FROM inbox_items
       WHERE status = 'open'${projectSql}
    `).get(...args) as Record<'open' | 'unread' | 'decision' | 'ai_failed' | 'verify_pending' | 'system', number | null>;
    return {
      open: row.open ?? 0,
      unread: row.unread ?? 0,
      decision: row.decision ?? 0,
      ai_failed: row.ai_failed ?? 0,
      verify_pending: row.verify_pending ?? 0,
      system: row.system ?? 0,
    };
  }

  markRead(ids: string[] = []): number {
    const now = nowIso();
    if (ids.length === 0) {
      return this.db.prepare(`UPDATE inbox_items SET unread = 0 WHERE unread = 1 AND status = 'open'`).run().changes;
    }
    let changed = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const marks = chunk.map(() => '?').join(',');
      changed += this.db.prepare(`UPDATE inbox_items SET unread = 0 WHERE id IN (${marks})`).run(...chunk).changes;
    }
    return changed;
  }

  claim(id: string, actorInput?: string): InboxItemView {
    const actor = normalizeActor(actorInput);
    const now = nowIso();
    const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    return this.transaction(() => {
      const item = this.mustGet(id);
      if (item.status !== 'open') throw new InboxError('只有待处理条目可以认领', 409);
      if (item.assignee) {
        throw new InboxError(item.assignee === actor ? '你已认领该条目' : `已被 ${item.assignee} 认领`, 409);
      }
      const changed = this.db.prepare(`
        UPDATE inbox_items
           SET assignee = ?, claimed_at = ?, claim_expires_at = ?, unread = 0, updated_at = ?
         WHERE id = ? AND status = 'open' AND assignee = ''
      `).run(actor, now, expiresAt, now, id).changes;
      if (changed === 0) {
        const current = this.mustGet(id);
        throw new InboxError(current.assignee ? `已被 ${current.assignee} 认领` : '条目状态已变化，请刷新', 409);
      }
      this.logAudit(id, 'claim', actor, '', actor);
      return this.mustGet(id);
    });
  }

  /** 取消认领：只允许当前认领人释放；认领后仍 open，因此取消不改变 open 口径。 */
  unclaim(id: string, actorInput?: string): InboxItemView {
    const actor = normalizeActor(actorInput);
    return this.transaction(() => {
      const item = this.mustGet(id);
      if (item.status !== 'open') throw new InboxError('只有待处理条目可以取消认领', 409);
      if (!item.assignee) throw new InboxError('条目尚未认领', 409);
      if (item.assignee !== actor) throw new InboxError(`该条目由 ${item.assignee} 认领，不能取消`, 403);
      const now = nowIso();
      const changed = this.db.prepare(`
        UPDATE inbox_items
           SET assignee = '', claimed_at = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'open' AND assignee = ?
      `).run(now, id, actor).changes;
      if (changed === 0) throw new InboxError('认领状态已变化，请刷新', 409);
      this.logAudit(id, 'unclaim', actor, actor, '');
      return this.mustGet(id);
    });
  }

  /** 强制释放：管理员入口。单机模式当前操作者即管理员；团队模式由接入手册/权限中间件鉴权。 */
  forceUnclaim(id: string, actorInput?: string, reason = 'force_release'): InboxItemView {
    const actor = normalizeActor(actorInput);
    return this.transaction(() => {
      const item = this.mustGet(id);
      if (item.status !== 'open') throw new InboxError('只有待处理条目可以强制释放', 409);
      if (!item.assignee) throw new InboxError('条目尚未认领', 409);
      const now = nowIso();
      const changed = this.db.prepare(`
        UPDATE inbox_items
           SET assignee = '', claimed_at = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'open' AND assignee <> ''
      `).run(now, id).changes;
      if (changed === 0) throw new InboxError('认领状态已变化，请刷新', 409);
      this.logAudit(id, 'unclaim', actor, item.assignee, '', reason.slice(0, 80));
      return this.mustGet(id);
    });
  }

  ignore(id: string, actorInput?: string): InboxItemView {
    const actor = normalizeActor(actorInput);
    return this.transaction(() => {
      const item = this.mustGet(id);
      if (item.status !== 'open') throw new InboxError('只有待处理条目可以忽略', 409);
      this.assertActorCanAct(item, actor);
      const now = nowIso();
      const changed = this.db.prepare(`
        UPDATE inbox_items
           SET status = 'ignored', resolution = 'ignored_by_user', unread = 0,
               assignee = '', claimed_at = NULL, claim_expires_at = NULL,
               resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'open' AND (assignee = '' OR assignee = ?)
      `).run(now, now, id, actor).changes;
      if (changed === 0) throw new InboxError('条目认领状态已变化，请刷新', 409);
      this.logAudit(id, 'ignore', actor, item.assignee, '');
      return this.mustGet(id);
    });
  }

  /** 恢复忽略：仅 ignored 可恢复；resolved（已转任务/来源消失）不走这里，避免制造重复任务。 */
  reopen(id: string, actorInput?: string): InboxItemView {
    const actor = normalizeActor(actorInput);
    return this.transaction(() => {
      const item = this.mustGet(id);
      if (item.status !== 'ignored') throw new InboxError('只有已忽略条目可以恢复', 409);
      const now = nowIso();
      const changed = this.db.prepare(`
        UPDATE inbox_items
           SET status = 'open', resolution = '', unread = 1,
               assignee = '', claimed_at = NULL, claim_expires_at = NULL,
               resolved_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'ignored'
      `).run(now, id).changes;
      if (changed === 0) throw new InboxError('条目状态已变化，请刷新', 409);
      this.logAudit(id, 'reopen', actor, item.assignee, '', 'manual_reopen');
      return this.mustGet(id);
    });
  }

  convert(id: string, projectId: string, actorInput?: string): { item: InboxItemView; task: TaskView } {
    const actor = normalizeActor(actorInput);
    return this.transaction(() => {
      const item = this.mustGet(id);
      if (item.status !== 'open') throw new InboxError('只有待处理条目可以转任务', 409);
      this.assertActorCanAct(item, actor);
      if (item.task_id) throw new InboxError('该条目已关联任务，请直接打开任务', 409);
      const pid = projectId.trim();
      if (!pid) throw new InboxError('projectId 必填');
      if (pid === 'sys-inbox') throw new InboxError('不能转入系统收件箱项目');
      const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(pid) as { id: string } | undefined;
      if (!project) throw new InboxError('目标项目不存在', 404);
      const task = this.createTask({
        projectId: pid,
        title: item.title,
        description: `由收件箱转入（来源：${item.source} / ${item.type}）\n\n${item.body}`,
        priority: item.type === 'ai_failed' ? 'high' : 'normal',
        status: 'todo',
      });
      const now = nowIso();
      const changed = this.db.prepare(`
        UPDATE inbox_items
           SET task_id = ?, project_id = ?, status = 'resolved', resolution = 'converted_to_task',
               unread = 0, assignee = '', claimed_at = NULL, claim_expires_at = NULL,
               resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'open' AND task_id IS NULL AND (assignee = '' OR assignee = ?)
      `).run(task.id, pid, now, now, id, actor).changes;
      if (changed === 0) throw new InboxError('条目已被并发处理，请刷新后重试', 409);
      this.logAudit(id, 'convert', actor, item.assignee, '', task.task_no ?? task.id);
      return { item: this.mustGet(id), task };
    });
  }

  /** 操作审计：人工与自动动作都落表；团队模式可直接在条目详情展示。 */
  audit(id: string, limit = 20): InboxAuditEntry[] {
    this.mustGet(id);
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.db.prepare(`
      SELECT id, inbox_id, action, actor, from_assignee, to_assignee, detail, created_at
        FROM inbox_audit
       WHERE inbox_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?
    `).all(id, n) as RawAuditRow[];
  }

  /** 状态变更 + 审计必须同事务：审计失败就回滚，避免“状态变了但没记录”。 */
  private transaction<T>(fn: () => T): T {
    const db = this.db as Database.Database & {
      transaction?: <U>(callback: () => U) => () => U;
    };
    if (typeof db.transaction === 'function') return db.transaction(fn)();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private assertActorCanAct(item: InboxItemView, actor: string): void {
    if (item.assignee && item.assignee !== actor) {
      throw new InboxError(`该条目由 ${item.assignee} 认领，请先取消认领`, 403);
    }
  }

  private logAudit(
    inboxId: string, action: InboxAuditAction, actor: string,
    fromAssignee: string, toAssignee: string, detail = '',
  ): void {
    this.db.prepare(`
      INSERT INTO inbox_audit
        (id, inbox_id, action, actor, from_assignee, to_assignee, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), inboxId, action, actor, fromAssignee, toAssignee, detail, nowIso());
  }

  private mustGet(id: string): InboxItemView {
    const row = this.db.prepare(`
      SELECT i.id, i.type, i.source, i.task_id, i.run_id, i.project_id, i.title, i.body,
             i.severity, i.status, i.assignee, i.unread, i.resolution, i.created_at, i.updated_at,
             i.claimed_at, i.claim_expires_at, i.resolved_at,
             t.task_no, t.status AS task_status, p.name AS project_name
        FROM inbox_items i
        LEFT JOIN tasks t ON t.id = i.task_id
        LEFT JOIN projects p ON p.id = i.project_id
       WHERE i.id = ?
    `).get(id) as RawInboxRow | undefined;
    if (!row) throw new InboxError('收件箱条目不存在', 404);
    return mapRow(row);
  }
}

function mapRow(row: RawInboxRow): InboxItemView {
  return { ...row, unread: row.unread === 1 };
}

export const inboxService = new InboxService();
