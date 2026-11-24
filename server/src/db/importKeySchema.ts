import type Database from 'better-sqlite3';
import { getDb } from './connection';

/**
 * T06304（REQ-010 / PRD §B2）：导入去重键登记表。
 *
 * PRD 要求去重键为「来源 + 外部 ID」。标题去重只能作为缺外部 ID 时的兜底：
 * 同一条 Jira/GitHub 记录改名后仍应被识别为重复，不同来源的同名任务也不应互相覆盖。
 *
 * 表只登记已成功导入的外部键，不复制任务内容；task_id 用于追溯，任务删除后键保留，
 * 避免同一外部记录被再次导入。
 */
export const IMPORT_KEY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_import_keys (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- 同一项目、同一来源、同一外部 ID 只能导入一次；并发写入由索引兜底。
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_import_keys_dedupe
  ON task_import_keys(project_id, source, external_id);
CREATE INDEX IF NOT EXISTS idx_task_import_keys_project
  ON task_import_keys(project_id, source);
`;

/** 启动时幂等建表；独立导出便于门禁脚本在内存库执行同一份 DDL。 */
export function ensureImportKeySchema(db: Database.Database = getDb()): void {
  db.exec(IMPORT_KEY_SCHEMA_SQL);
}
