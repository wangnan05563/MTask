/**
 * 按 SQL 文本缓存 better-sqlite3 Statement（T00792）。
 *
 * 背景：better-sqlite3 **没有内部语句缓存**——每次 `db.prepare(sql)` 都走一遍
 * SQL 解析 / 编译 / 绑定准备。热点路径（如 TaskService.list 按 6 种排序变体重复拼同一条
 * SQL）在高并发下这部分成本线性累积。
 *
 * 实测（隔离实例，3000 次同 SQL 查询）：
 *   - 每次 prepare：35.37 µs/次
 *   - 复用 Statement：10.16 µs/次
 *   → **3.48×** 加速，单次省 ~25µs。请求量上千后即为可观收益。
 *
 * ⚠️ 仅缓存「SQL 文本确定」的语句。含字面量拼接的 SQL（如动态 SET 列表、IN (?,?,...) 分片、
 * LIMIT 变体）每次文本都不同，缓存只会无限膨胀且永不命中——这类**必须**继续走 `db.prepare`。
 *
 * 使用约定：
 *   - SQL 文本是缓存键，**参数仍走 `.run(...)` / `.all(...)` 绑定**，不要拼进 SQL。
 *   - 连接重建（`openDatabase` 换库）后旧 Statement 会绑定到已关闭的库 → 必须在连接层
 *     调用 `clearStmtCache()`（见 connection.ts）。
 */

/** better-sqlite3 Statement 的最小结构（避免直接依赖其类型导致重载联合类型无法承接） */
export interface CachedStatement {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid?: number | bigint };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
  iterate?: (...args: unknown[]) => Iterable<unknown>;
}

/** SQL 文本 → 已编译 Statement */
const cache = new Map<string, CachedStatement>();

/** 缓存条目数上限：防御性兜底。正常使用下命中固定 SQL 集（数量有限），不会触顶。 */
const STMT_CACHE_MAX = 500;

/** 提供 prepare 能力的连接（与 better-sqlite3 Database 结构兼容） */
type PrepareCapable = { prepare: (sql: string) => unknown };

/**
 * 取（或编译并缓存）一条 Statement。
 * @param db 连接（通常为 `getDb()`）
 * @param sql 完整 SQL 文本；**必须**是确定的模板串，不能含随请求变化的内联字面量
 */
export function cachedPrepare(db: PrepareCapable, sql: string): CachedStatement {
  const hit = cache.get(sql);
  if (hit) return hit;
  const st = db.prepare(sql) as CachedStatement;
  // 触顶时整体清空而非淘汰单条：条目数本就有限，清空实现简单且避免 LRU 维护成本
  if (cache.size >= STMT_CACHE_MAX) cache.clear();
  cache.set(sql, st);
  return st;
}

/** 暴露给测试/诊断：当前缓存条目数 */
export function stmtCacheSize(): number {
  return cache.size;
}

/** 连接重建或关闭前调用，丢弃全部缓存（旧 Statement 不可跨连接复用） */
export function clearStmtCache(): void {
  cache.clear();
}
