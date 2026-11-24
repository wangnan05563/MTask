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
 * 同一事件按 event_key 去重；每次列表读取做一次幂等同步，源事件消失后 open 条目自动收敛为 resolved。
 * 认领只写 assignee/claimed_at，status 仍是 open（否则「已认领」会从待处理统计里消失）。
 * 转任务只允许没有 task_id 的条目，避免把已有任务复制成第二份；创建走 TaskService，编号/事件与普通建单一致。
 */

export type InboxType = 'decision' | 'ai_failed' | 'verify_pending' | 'system';
export type InboxStatus = 'open' | 'ignored' | 'resolved';
export type InboxSeverity = 'info' | 'warning' | 'danger';
export type InboxSource = 'task' | 'exec_session' | 'manual';

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
  generated_at: string;
}

export interface InboxListQuery {
  type?: InboxType | '';
  status?: InboxStatus;
  projectId?: string;
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
  resolved_at: string | null;
}

type TaskCreator = (input: TaskInput) => TaskView;

const TYPE_VALUES = new Set<InboxType>(['decision', 'ai_failed', 'verify_pending', 'system']);
const STATUS_VALUES = new Set<InboxStatus>(['open', 'ignored', 'resolved']);

function nowIso(): string {
  return new Date().toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** 90 天是 PRD §A2 的默认保留窗口；超窗任务不生成新条目，存量条目仍可查询。 */
const RETENTION_DAYS = 90;
/** 源事件同步的标记节流：同一条目 2 分钟内不反复写 last_seen_at。 */
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
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO inbox_items
        (id, type, source, task_id, project_id, title, body, severity, status, assignee, event_key, unread,
         resolution, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', '', ?, 1, '', ?, ?, ?)
    `);
    const remark = this.db.prepare(`
      UPDATE inbox_items SET last_seen_at = ?
       WHERE event_key = ? AND last_seen_at < ?
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const taskRows = this.db.prepare(`
        SELECT t.id, t.task_no, t.title, t.project_id, t.ai_state, t.status, t.verified, t.ruling_state, t.updated_at
          FROM tasks t
         WHERE t.archived = 0
           AND COALESCE(t.shelved, 0) = 0
           AND COALESCE(t.history_at, '') = ''
           AND t.updated_at >= ?
           AND (
             (t.status = 'todo' AND t.ai_state = 'failed')
             OR (t.ruling_state = '待裁决')
             OR (t.status = 'done' AND t.verified = 0)
           )
         ORDER BY t.updated_at DESC
         LIMIT 1000
      `).all(retentionCutoff) as Array<{
        id: string; task_no: string | null; title: string; project_id: string;
        ai_state: string; status: string; verified: number; ruling_state: string; updated_at: string;
      }>;

      for (const task of taskRows) {
        if (task.status === 'todo' && task.ai_state === 'failed') {
          this.upsertEvent(insert, remark, {
            type: 'ai_failed', source: 'task', taskId: task.id, projectId: task.project_id,
            title: task.title, body: 'AI 执行失败，需要人工排查原因或重试。', severity: 'danger',
            eventKey: `task_ai_failed:${task.id}`,
          }, now, remarkCutoff);
        }
        if (task.ruling_state === '待裁决') {
          this.upsertEvent(insert, remark, {
            type: 'decision', source: 'task', taskId: task.id, projectId: task.project_id,
            title: task.title, body: '任务结论待裁决，需要你选择采纳、不采纳或补充信息。', severity: 'warning',
            eventKey: `task_ruling:${task.id}`,
          }, now, remarkCutoff);
        }
        if (task.status === 'done' && task.verified === 0) {
          this.upsertEvent(insert, remark, {
            type: 'verify_pending', source: 'task', taskId: task.id, projectId: task.project_id,
            title: task.title, body: '任务已完成，等待人工验证结果。', severity: 'warning',
            eventKey: `task_verify:${task.id}`,
          }, now, remarkCutoff);
        }
      }

      const stalled = this.db.prepare(`
        SELECT id, phase, last_heartbeat
          FROM exec_sessions
         WHERE status = 'stalled'
         ORDER BY last_heartbeat DESC
         LIMIT 50
      `).all() as Array<{ id: string; phase: string; last_heartbeat: string }>;
      for (const session of stalled) {
        this.upsertEvent(insert, remark, {
          type: 'system', source: 'exec_session', taskId: null, projectId: null,
          title: `执行会话停滞：${session.phase || '执行中'}`,
          body: `最近心跳 ${session.last_heartbeat || '未知'}，任务可能卡住；到 AI 控制台查看并重派。`,
          severity: 'warning', eventKey: `session_stalled:${session.id}`,
        }, now, remarkCutoff);
      }

      // 只收敛「源事件型」且长期未见的 open 条目；ignored/resolved 与手动条目不动。
      this.db.prepare(`
        UPDATE inbox_items
           SET status = 'resolved', resolution = 'source_cleared', unread = 0,
               resolved_at = ?, updated_at = ?
         WHERE status = 'open'
           AND source IN ('task', 'exec_session')
           AND last_seen_at < ?
      `).run(now, now, staleCutoff);

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private upsertEvent(
    insert: Database.Statement,
    remark: Database.Statement,
    item: {
      type: InboxType; source: InboxSource; taskId: string | null; projectId: string | null;
      title: string; body: string; severity: InboxSeverity; eventKey: string;
    },
    now: string,
    remarkCutoff: string,
  ): void {
    insert.run(
      randomUUID(), item.type, item.source, item.taskId, item.projectId,
      item.title, item.body, item.severity, item.eventKey, now, now, now,
    );
    remark.run(now, item.eventKey, remarkCutoff);
  }

  list(query: InboxListQuery = {}): InboxListResult {
    this.sync();
    const status = query.status ?? 'open';
    if (!STATUS_VALUES.has(status)) throw new InboxError(`状态非法：${status}`);
    const type = query.type ?? '';
    if (type && !TYPE_VALUES.has(type)) throw new InboxError(`分类非法：${type}`);
    const projectId = query.projectId?.trim() ?? '';
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);

    const where = ['i.status = ?'];
    const args: Array<string | number> = [status];
    if (type) { where.push('i.type = ?'); args.push(type); }
    if (projectId) { where.push('i.project_id = ?'); args.push(projectId); }
    const whereSql = where.join(' AND ');

    const rows = this.db.prepare(`
      SELECT i.id, i.type, i.source, i.task_id, i.run_id, i.project_id, i.title, i.body,
             i.severity, i.status, i.assignee, i.unread, i.resolution, i.created_at, i.updated_at,
             i.claimed_at, i.resolved_at, t.task_no, t.status AS task_status, p.name AS project_name
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

  claim(id: string): InboxItemView {
    const item = this.mustGet(id);
    if (item.status !== 'open') throw new InboxError('只有待处理条目可以认领', 409);
    const now = nowIso();
    this.db.prepare(`
      UPDATE inbox_items
         SET assignee = CASE WHEN assignee = '' THEN '我' ELSE assignee END,
             claimed_at = COALESCE(claimed_at, ?), unread = 0, updated_at = ?
       WHERE id = ?
    `).run(now, now, id);
    return this.mustGet(id);
  }

  ignore(id: string): InboxItemView {
    const item = this.mustGet(id);
    if (item.status !== 'open') throw new InboxError('只有待处理条目可以忽略', 409);
    const now = nowIso();
    this.db.prepare(`
      UPDATE inbox_items
         SET status = 'ignored', resolution = 'ignored_by_user', unread = 0,
             resolved_at = ?, updated_at = ?
       WHERE id = ?
    `).run(now, now, id);
    return this.mustGet(id);
  }

  convert(id: string, projectId: string): { item: InboxItemView; task: TaskView } {
    const item = this.mustGet(id);
    if (item.status !== 'open') throw new InboxError('只有待处理条目可以转任务', 409);
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
    this.db.prepare(`
      UPDATE inbox_items
         SET task_id = ?, project_id = ?, status = 'resolved', resolution = 'converted_to_task',
             unread = 0, resolved_at = ?, updated_at = ?
       WHERE id = ?
    `).run(task.id, pid, now, now, id);
    return { item: this.mustGet(id), task };
  }

  private mustGet(id: string): InboxItemView {
    const row = this.db.prepare(`
      SELECT i.id, i.type, i.source, i.task_id, i.run_id, i.project_id, i.title, i.body,
             i.severity, i.status, i.assignee, i.unread, i.resolution, i.created_at, i.updated_at,
             i.claimed_at, i.resolved_at, t.task_no, t.status AS task_status, p.name AS project_name
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
