import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** SQLite 连接单例。数据文件默认放在 server/data/mtask.db，可用 MTask_DATA_DIR 覆盖。 */
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = process.env.MTask_DATA_DIR ?? join(__dirname, '..', 'data');
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'mtask.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 写锁竞争时等待而非立即报 SQLITE_BUSY（better-sqlite3 默认即 5000ms，显式声明避免未来误改）
  db.pragma('busy_timeout = 5000');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
