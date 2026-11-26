import type Database from 'better-sqlite3';
import { getDb } from './connection';

/**
 * T06295（REQ-032 / PRD §A2）：可操作收件箱增量表。
 *
 * 只做增量表，不修改任务、执行会话、通知等旧表。收件箱是「需要用户处理的事项集合」，
 * 不是通知流：每条有稳定 event_key 去重，open 状态必须由认领 / 忽略 / 转任务等动作解决。
 *
 * 状态口径：
 * - status=open：仍待处理；认领只写 assignee/claimed_at，不改变 open，否则统计会把「已认领」当成已解决；
 * - status=ignored / resolved：终态，分别由用户忽略或转任务/源事件消失收敛；
 * - unread 只影响角标，页面打开后统一置 0，不改变 open。
 *
 * 团队准备：
 * - assignee 是操作者字段（当前单机默认「我」，团队模式由服务端身份解析）；
 * - event_version 记录本次源事件实例（失败/裁决/完成/停滞时间），同一 event_key 的新实例会重开终态条目；
 * - inbox_audit 记录认领/取消认领/忽略/转任务，便于多人环境追责。
 *
 * 首版 CREATE TABLE IF NOT EXISTS 幂等建表；后续枚举演进需整表重建迁移。
 */
export const INBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inbox_items (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL
                 CHECK(type IN ('decision','ai_failed','verify_pending','system')),
  source       TEXT NOT NULL
                 CHECK(source IN ('task','exec_session','manual')),
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id       TEXT,
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  severity     TEXT NOT NULL DEFAULT 'warning'
                 CHECK(severity IN ('info','warning','danger')),
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK(status IN ('open','ignored','resolved')),
  assignee     TEXT NOT NULL DEFAULT '',
  event_key    TEXT NOT NULL,
  event_version TEXT NOT NULL DEFAULT '',
  unread       INTEGER NOT NULL DEFAULT 1 CHECK(unread IN (0,1)),
  resolution   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  claimed_at   TEXT,
  claim_expires_at TEXT,
  resolved_at  TEXT,
  last_seen_at TEXT NOT NULL
);

-- 同一事件只允许一条；任务失败 / 待验证 / 待裁决 / 会话停滞按各自 event_key 去重。
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_event_key
  ON inbox_items(event_key);
-- 列表默认按 open + type + 时间读取。
CREATE INDEX IF NOT EXISTS idx_inbox_items_open_type
  ON inbox_items(status, type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_items_task
  ON inbox_items(task_id);
CREATE INDEX IF NOT EXISTS idx_inbox_items_unread
  ON inbox_items(unread, status);
CREATE INDEX IF NOT EXISTS idx_inbox_items_project
  ON inbox_items(project_id, status);
-- 团队/认领筛选：status + assignee。
CREATE INDEX IF NOT EXISTS idx_inbox_items_assignee
  ON inbox_items(status, assignee, updated_at DESC);

-- 操作审计：认领/取消/忽略/转任务/自动收敛/重开。actor 由服务端会话解析，单机回退「我」。
CREATE TABLE IF NOT EXISTS inbox_audit (
  id            TEXT PRIMARY KEY,
  inbox_id      TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  action        TEXT NOT NULL
                  CHECK(action IN ('claim','unclaim','ignore','convert','source_cleared','reopen')),
  actor         TEXT NOT NULL DEFAULT '',
  from_assignee TEXT NOT NULL DEFAULT '',
  to_assignee   TEXT NOT NULL DEFAULT '',
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_audit_item
  ON inbox_audit(inbox_id, created_at DESC);
`;

/** 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列。 */
function ensureInboxColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(inbox_items)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'event_version')) {
    db.exec("ALTER TABLE inbox_items ADD COLUMN event_version TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === 'claim_expires_at')) {
    db.exec('ALTER TABLE inbox_items ADD COLUMN claim_expires_at TEXT');
    // 老版本认领没有租约：升级时补 30 分钟到期时间，避免旧认领永久占用。
    const legacyClaims = db.prepare(`
      SELECT id, claimed_at FROM inbox_items
       WHERE status = 'open' AND assignee <> '' AND claimed_at IS NOT NULL
    `).all() as Array<{ id: string; claimed_at: string }>;
    const setExpiry = db.prepare('UPDATE inbox_items SET claim_expires_at = ? WHERE id = ?');
    for (const claim of legacyClaims) {
      const at = Date.parse(claim.claimed_at);
      if (!Number.isNaN(at)) setExpiry.run(new Date(at + 30 * 60_000).toISOString(), claim.id);
    }
  }
}

/**
 * 老库一次性补齐事件实例键：否则事件版本为空的历史条目会被当成「首次兼容」，
 * 之后第一次真正的新事件仍可能被吞掉。只补空值，已有值不动。
 *
 * 关键边界：终态条目只有在「来源版本 <= 解决时间」时才回填当前版本；
 * 如果来源版本发生在 resolved_at 之后，说明解决后已经产生了新事件，必须回填 legacy，
 * 让下一次 sync 把它当作新实例重开。否则升级/重启会把新事件永久吞掉。
 */
function backfillInboxEventVersions(db: Database.Database): void {
  db.prepare(`
    WITH src AS (
      SELECT
        i.id AS inbox_id,
        CASE
          WHEN i.type = 'ai_failed' THEN COALESCE(NULLIF(
            (SELECT t.ai_state_at FROM tasks t WHERE t.id = i.task_id), ''), '')
          WHEN i.type = 'decision' THEN COALESCE(NULLIF(
            (SELECT t.ruling_at FROM tasks t WHERE t.id = i.task_id), ''), '')
          WHEN i.type = 'verify_pending' THEN COALESCE(
            (SELECT MAX(e.created_at) FROM task_events e
              WHERE e.task_id = i.task_id
                AND e.kind = 'status' AND e.detail = 'todo → done'), '')
          WHEN i.source = 'exec_session' THEN COALESCE(
            NULLIF((SELECT s.last_heartbeat FROM exec_sessions s
                     WHERE s.id = COALESCE(NULLIF(i.run_id, ''),
                       CASE WHEN i.event_key LIKE 'session_stalled:%'
                            THEN substr(i.event_key, 17) ELSE '' END)), ''),
            NULLIF((SELECT s.started_at FROM exec_sessions s
                     WHERE s.id = COALESCE(NULLIF(i.run_id, ''),
                       CASE WHEN i.event_key LIKE 'session_stalled:%'
                            THEN substr(i.event_key, 17) ELSE '' END)), ''),
            '')
          ELSE ''
        END AS src_ts,
        COALESCE(NULLIF(i.resolved_at, ''), i.updated_at, i.created_at, '') AS terminal_at
      FROM inbox_items i
      WHERE i.event_version = ''
    )
    UPDATE inbox_items
       SET event_version = CASE
         WHEN inbox_items.status IN ('ignored', 'resolved')
          AND src.src_ts <> ''
          AND src.src_ts > src.terminal_at
           THEN 'legacy'
         ELSE COALESCE(NULLIF(src.src_ts, ''), 'legacy')
       END
      FROM src
     WHERE inbox_items.id = src.inbox_id
  `).run();
}

/** 启动时幂等建表；独立导出便于门禁脚本在内存库执行同一份 DDL。 */
export function ensureInboxSchema(db: Database.Database = getDb()): void {
  db.exec(INBOX_SCHEMA_SQL);
  ensureInboxColumns(db);
  backfillInboxEventVersions(db);
}
