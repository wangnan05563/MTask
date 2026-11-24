import type Database from 'better-sqlite3';
import { getDb } from './connection';

/**
 * T06303（REQ-009 / PRD §B1）：保存视图增量表。
 *
 * 视图只保存「怎么看」的配置（筛选、排序、分组、列宽、密度），不复制任务数据；
 * 任务仍由任务表唯一承载。visibility=project 表示项目内共享，private 表示本机私有。
 *
 * 首版 CREATE TABLE IF NOT EXISTS 幂等建表；后续枚举演进需整表重建迁移。
 */
export const SAVED_VIEW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS saved_views (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL
                CHECK(type IN ('list','board','table','calendar')),
  config      TEXT NOT NULL DEFAULT '{}',
  visibility  TEXT NOT NULL DEFAULT 'private'
                CHECK(visibility IN ('private','project')),
  created_by  TEXT NOT NULL DEFAULT 'local',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 同一项目内视图名不区分大小写唯一；重名由服务层返回 409，索引兜底防并发写入。
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_views_project_name
  ON saved_views(project_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_saved_views_project
  ON saved_views(project_id, updated_at DESC);
`;

/** 启动时幂等建表；独立导出便于门禁脚本在内存库执行同一份 DDL。 */
export function ensureSavedViewSchema(db: Database.Database = getDb()): void {
  db.exec(SAVED_VIEW_SCHEMA_SQL);
}
