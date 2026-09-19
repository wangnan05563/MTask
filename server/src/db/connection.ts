import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { clearStmtCache } from '../util/stmt-cache'; // T00792：连接生命周期联动语句缓存

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
      // T00785：WAL 模式下 synchronous 保持默认 FULL 会对**每次事务提交**都做一次
      // fsync（写 WAL 文件 + 必要时刷主库），是写吞吐随并发上升不增反降的主要成因
      // （压测实测写阶段 533→454→372 req/s）。WAL + NORMAL 是 SQLite 官方推荐组合：
      // 仅在 checkpoint 时 fsync，正常 commit 不做同步刷盘；崩溃最多丢失最近若干事务
      // （不损坏库，WAL 仍可回放）。桌面单用户场景「性能 vs 极端掉电丢最后几笔写」
      // 的权衡明确偏向性能，故显式设 NORMAL。
      d.pragma('synchronous = NORMAL');
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
  // T00785：兜底路径同样显式声明 NORMAL——DELETE 模式下 NORMAL 的 fsync 次数少于 FULL，
  // 且本路径本身已是「WAL 不可用」的降级形态，一致性诉求已让位于可用性。
  // 显式写出而非依赖默认值，避免未来 SQLite / better-sqlite3 升级改变默认行为时静默劣化。
  d.pragma('synchronous = NORMAL');
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
  // T00792：连接（重）建时丢弃语句缓存——旧 Statement 绑定在已关闭的连接上，不可复用
  clearStmtCache();

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
    // T00792：连接关闭后语句缓存必须失效（否则下次 getDb 前若被调用会持有已关闭连接的 Statement）
    clearStmtCache();
  }
}