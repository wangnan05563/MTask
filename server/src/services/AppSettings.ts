/**
 * 应用级键值设置：当前承载移动端「默认记事项目」指针。
 * - getSetting / setSetting：通用 KV 读写（upsert）。
 * - getDefaultNoteProjectId：移动端随手记缺省归属；用户设置的默认项目优先，
 *   否则回退系统"收件箱"项目；若设置的默认项目已被删除则自动回退收件箱。
 */
import { getDb } from '../db/connection';

/** 系统收件箱项目 id（确定性，schema 启动时种子） */
export const INBOX_PROJECT_ID = 'sys-inbox';

const DEFAULT_NOTE_KEY = 'defaultNoteProjectId';

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** 默认记事项目：用户设置优先且必须存在，否则回退收件箱 */
export function getDefaultNoteProjectId(): string {
  const custom = getSetting(DEFAULT_NOTE_KEY);
  if (custom && getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(custom)) return custom;
  return INBOX_PROJECT_ID;
}
