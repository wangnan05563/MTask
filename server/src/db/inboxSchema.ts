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
  unread       INTEGER NOT NULL DEFAULT 1 CHECK(unread IN (0,1)),
  resolution   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  claimed_at   TEXT,
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
`;

/** 启动时幂等建表；独立导出便于门禁脚本在内存库执行同一份 DDL。 */
export function ensureInboxSchema(): void {
  getDb().exec(INBOX_SCHEMA_SQL);
}
