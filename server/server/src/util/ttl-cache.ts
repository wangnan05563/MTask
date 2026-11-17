/**
 * 极简 TTL 内存缓存：服务于"读多写少"的低频集合查询（projects/queues/aitools/分类/模板等）。
 * 目的：高并发/事件循环排队时减少重复 DB 查询与文件系统读，缓解全局延迟；
 * 不做复杂失效策略，靠 TTL 过期兜底 + 关键写端点主动 cacheClear 保持一致性。
 */
const store = new Map<string, { value: unknown; expire: number }>();

/** 读取缓存；未命中或已过期返回 undefined（过期即删除，避免脏数据复活） */
export function cacheGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expire) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

/** 写入缓存 */
export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expire: Date.now() + ttlMs });
}

/** 失效缓存；传 key 只清单个，不传清空全部（写操作后调用，保证读到的不是脏数据） */
export function cacheClear(key?: string): void {
  if (key) store.delete(key);
  else store.clear();
}
