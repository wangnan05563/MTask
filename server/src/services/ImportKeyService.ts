/**
 * T06304（REQ-010 / PRD §B2）：导入去重键的归一化、查询与登记。
 *
 * 去重键 = 来源 + 外部 ID；来源未知时归为 generic，外部 ID 为空时由调用方回退到标题去重。
 * 本服务只负责键表，不创建任务——任务仍由 TaskService 统一写入。
 */
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection';

export type ImportSource = 'github' | 'jira' | 'trello' | 'json' | 'generic';

export const IMPORT_SOURCES: ImportSource[] = ['github', 'jira', 'trello', 'json', 'generic'];

/** 来源归一化：CSV 的自动识别结果与 JSON 的导出形态都收口到固定词表。 */
export function normalizeImportSource(raw: unknown): ImportSource {
  const v = String(raw ?? '').trim().toLowerCase();
  if ((IMPORT_SOURCES as string[]).includes(v)) return v as ImportSource;
  if (v === 'csv') return 'generic';
  if (v === 'trello') return 'trello';
  if (v === 'jira') return 'jira';
  if (v === 'github') return 'github';
  return 'generic';
}

/** 外部 ID 归一化：去掉首尾空白并限长，避免同一 ID 因空格/超长被当成两条。 */
export function normalizeExternalId(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 200);
}

/** 键的展示串，用于预览错误信息；实际唯一约束在表索引上。 */
export function importKeyLabel(source: ImportSource, externalId: string): string {
  return `${source}:${externalId}`;
}

/** 读取项目 + 来源下已导入的外部 ID 集合，预览与确认共用同一判据。 */
export function listImportedKeys(projectId: string, source: ImportSource, db: Database.Database = getDb()): Set<string> {
  const rows = db
    .prepare('SELECT external_id FROM task_import_keys WHERE project_id = ? AND source = ?')
    .all(projectId, source) as Array<{ external_id: string }>;
  return new Set(rows.map((r) => r.external_id));
}

/** 是否已导入；供单个键的即时判断（预览集合之外的兜底）。 */
export function isImported(projectId: string, source: ImportSource, externalId: string, db: Database.Database = getDb()): boolean {
  if (!externalId) return false;
  const row = db
    .prepare('SELECT 1 AS hit FROM task_import_keys WHERE project_id = ? AND source = ? AND external_id = ? LIMIT 1')
    .get(projectId, source, externalId) as { hit: number } | undefined;
  return Boolean(row);
}

/** 登记一个已成功导入的外部键；唯一索引冲突视为幂等命中（返回 false）。 */
export function markImported(
  projectId: string,
  source: ImportSource,
  externalId: string,
  taskId: string,
  db: Database.Database = getDb(),
): boolean {
  if (!externalId) return false;
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO task_import_keys (id, project_id, source, external_id, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(uuid(), projectId, source, externalId, taskId, new Date().toISOString());
  return r.changes > 0;
}
