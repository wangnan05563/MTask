import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** 打开库失败时是否属于可重试的瞬时问题（文件被占用/杀软扫描/残留句柄）。
 *  非瞬时错误（如 SQL 语法错、盘满）应直接抛出，避免无意义重试掩盖真因。 */
function isRetryable(err: unknown): boolean {
  const s = String((err as Error)?.message ?? err);
  return /IOERR|BUSY|locked|file is in use/i.test(s);
}

/**
 * 打开数据库连接。默认尝试 WAL：写入并发更好，且会自动回放上次遗留的 -wal 恢复数据。
 *
 * 为什么要"尝试"而非常态保障：Windows 下 WAL 初始化（写 -shm / 截断 -wal）会因杀软瞬时锁定、
 * 上次强杀遗留的脏文件被并发占用抛 SQLITE_IOERR_TRUNCATE，直接崩掉整个后端，UI 表现就是
 * 「后端未连接」。桌面单进程读写 WAL 并非必需，因此失败时回退到默认日志模式继续启动，
 * 宁可牺牲一点并发也不让后端因为库打不开而整机卡死。
 */
function openDatabase(file: string): Database.Database {
  // 少量重试即可骑过绝大多数瞬时文件锁；重试后成功还能把遗留 -wal 一并回放不丢数据
  for (let i = 0; i < 3; i++) {
    try {
      const d = new Database(file);
      d.pragma('journal_mode = WAL');
      return d;
    } catch (err) {
      if (!isRetryable(err) || i === 2) {
        return fallbackOpen(file);
      }
      // 短暂退避再试，等待占用方释放文件句柄
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  return fallbackOpen(file);
}

/** WAL 始终不可用的兜底：改用默认（DELETE）日志模式打开，保证后端必然能启动。 */
function fallbackOpen(file: string): Database.Database {
  const d = new Database(file);
  // DELETE 模式没有 -shm，天然避开 WAL 的截断/共享内存失败点；写锁竞争仍由 busy_timeout 兜底
  d.pragma('journal_mode = DELETE');
  return d;
}

/** SQLite 连接单例。数据文件默认放在 server/data/mtask.db，可用 MTask_DATA_DIR 覆盖。 */
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = process.env.MTask_DATA_DIR ?? join(__dirname, '..', 'data');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'mtask.db');
  db = openDatabase(file);

  db.pragma('foreign_keys = ON');
  // 写锁竞争时等待而非立即报 SQLITE_BUSY（better-sqlite3 默认即 5000ms，显式声明避免未来误改）
  db.pragma('busy_timeout = 5000');

  // WAL 打开成功后主动做一次 checkpoint，把上次崩溃遗留的 -wal 合并进主库并截断，
  // 避免脏 WAL 越积越大、并让下次启动更接近"干净状态"
  try {
    const mode = db.pragma('journal_mode', { simple: true });
    if (/wal/i.test(String(mode))) db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // checkpoint 失败不影响继续使用，仅留存量脏 WAL，下次启动仍会重试
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}