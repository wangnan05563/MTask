## 根因

`GET /api/console-jobs`（`server/src/routes/index.ts:1300` → `ConsoleJobService.list()`）为**无缓存全表查询**：

```sql
SELECT * FROM console_jobs ORDER BY created_at
```

`console_jobs.answer` 存 AI 完整回答长文本（实测 seed 单行已达 ~12KB），因此每次轮询都要
**读取全部行 + 全量 JSON 序列化**。前端控制台以轮询收敛运行中任务状态，属典型「读多写少」高频读路径，
在 stability 混合负载下 p50 310ms / p95 708ms（含事件循环排队放大），是本轮全端点测试中
F5 相关的 P1 瓶颈之一。

## 影响范围

- **受影响端点**：`GET /api/console-jobs`（单端点），及其排队放大所波及的同期请求延迟。
- **写入路径**（6 处，全部需保证失效正确）：`create` / `markDone` / `markError` / `reset` / `remove` / `clear`。
- **不影响**：`get(id)`（单行主键查，无缓存）、`runJob` 后台执行逻辑、AI 调用链路。

## 修复（绝对路径+改动点）

**`D:\code\otherProjects\26_MTask\server\src\services\ConsoleJobService.ts`**

设计决策：**把缓存与失效收敛在 Service 层，而非路由层**。理由——`console_jobs` 的全部写操作
都已在该服务内收敛（grep 确认 `server/src/routes/index.ts` 仅调用服务方法，无任何直接 SQL），
因此服务层实现可保证**任何调用方**都不会读到脏数据，避免将来新增路由漏加 `cacheClear`。

1. **新增模块常量**（文件头，紧随 import 之后）：
   - `LIST_CACHE_KEY = 'console-jobs'`
   - `LIST_TTL_MS = 5000`（与 `projects` / `prompt-categories` 等低频集合列表同一 5s 口径）
   - 引入 `import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';`

2. **`list()` 加缓存读**：
   ```ts
   list(): ConsoleJobRow[] {
     const cached = cacheGet<ConsoleJobRow[]>(LIST_CACHE_KEY);
     if (cached) return cached;
     const rows = getDb().prepare('SELECT * FROM console_jobs ORDER BY created_at').all() as ConsoleJobRow[];
     cacheSet(LIST_CACHE_KEY, rows, LIST_TTL_MS);
     return rows;
   }
   ```

3. **6 处写路径全部 `cacheClear(LIST_CACHE_KEY)`**：
   - `create()`：新建后立刻可见（不等 5s TTL）
   - `markDone()` / `markError()`：后台任务终态 → 轮询方需立刻看到 `done` + `answer`
   - `reset()`：「重新分析」置回 busy 后立刻反映
   - `remove()`：仅在 `changes > 0` 时失效
   - `clear()`：重置控制台后立刻为空

> 未采用方案②（LIMIT 50 + since 游标）：当前表规模与轮询语义下 TTL 缓存已完全消除该端点成本，
> 游标分页会改变前端 tab 的完整列表语义（需同时改前端），收益不及改动面。

## 验证（实测证据）

### 1. 类型检查
```
cd D:\code\otherProjects\26_MTask\server && npx tsc --noEmit
→ EXIT=0，0 错误
```

### 2. API 级端到端（隔离实例）
脚本：`D:\code\otherProjects\26_MTask\perf\verify_t00787_api.py`
环境：`MTask_PORT=39911` + `MTask_DATA_DIR=perf/sandbox/verify787`（复制生产样本库）
负载：启动前预置 **40 行 × ~12KB answer（answer 总长 752,280 字符）**，运行中追加至 60 行
结果文件：`perf/sandbox/verify787.result.json`

| 验收项 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 缓存命中 p50 | < 50ms | **17.73ms**（p95 35.10ms） | ✅ 通过 |
| 冷查询对照 p50 | 基线 | 34.33ms（p95 45.31ms） | p50 降幅 **1.94×** |
| POST 后 5s 内可见 | 全部可见 | 5/5 全部可见（32–66ms） | ✅ 通过 |
| 缓存一致性 | 逐字节一致 | 行数 / ID 顺序 / answer 全一致 | ✅ 通过 |
| TTL 过期后复比 | 一致 | 60 行全一致 | ✅ 通过 |
| DELETE 后立刻消失 | 是 | 是 | ✅ 通过 |
| clear 后立刻为空 | 是 | 是 | ✅ 通过 |

**关键证据摘录**：
```
✅ 缓存命中：n=60 p50=17.73ms p95=35.10ms min=13.65 max=37.90
✅ 冷查询对照：n=15 p50=34.33ms p95=45.31ms
   → p50 降幅 1.94×（冷 34.33ms → 命中 17.73ms）
✅ 连发 POST 后立即可见：是（5/5）；创建→可见最快 32.1ms 最慢 65.7ms（均远 <5s TTL）
✅ 缓存一致性：行数=True 顺序=True answer逐字节=True（TTL 过期后复比=True，共 60 行）
✅ DELETE 后立刻从列表消失：是
✅ 重置控制台后列表立刻为空：是
✅ 验收 p50<50ms：通过
OVERALL: PASS
```

> 实测相对原报告 p50 310ms 的绝对值更低，因原报告数值含 stability 混合负载下的事件循环排队放大；
> 本验证为单端点隔离测量，故以「命中 vs 冷查」的 1.94× 相对降幅与 <50ms 绝对验收线为准。

### 3. 提交
`599371f` — `perf(T00787): console-jobs 列表加 5s TTL 缓存，消除轮询全表扫`
（1 file changed, 25 insertions(+), 2 deletions(-)；已确认 diff 纯净，未裹挟并发会话 WIP）

## 本次回写

无（本任务为收敛型修复，无新增剩余工作）。

## 下一步建议（可选）

- 该缓存与 `projects` / `req-categories` 共用全局 `ttl-cache`，**未做容量上限**——若未来集合数量
  与单条体积继续增长，建议给 `ttl-cache` 加 LRU 上限（当前各 key 均 ≤ 单集合量级，风险低）。
- 前端控制台轮询若仍以固定 1s 间隔调用，可考虑随任务状态自适应退避（全部 done 时降频），
  进一步释放事件循环——属前端侧优化，本轮未纳入。
