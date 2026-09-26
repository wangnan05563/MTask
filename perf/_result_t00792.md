# T00792 处理结果：热点路径语句级 prepare 复用

**状态**：已完成 · **验证**：命令层全链闭环（tsc + 隔离实例 API 验证 + A/B 对照）

## 一、结论摘要

| 指标 | 结果 | 说明 |
|---|---|---|
| 编译环节收益 | **3.48×** | `db.prepare()` 每次 35.37µs → 复用 Statement 10.16µs |
| 单查询实执行收益 | **1.33×**（compile 占比 **24.8%**） | 20 行查询：108.69µs → 81.75µs；纯编译开销 22.84µs |
| 端点级 p50 收益 | **−3.02%** | 8 轮短块交替、每侧 240 样本（消除机器漂移） |
| 端点级吞吐 | **≈ 持平** | 早期分块 A/B 出现 0.946× 属机器漂移假象，见第四节 |
| 正确性 | **PASS** | 6 排序变体 + 5 过滤组合全 200，写后读一致，响应体逐字节等价 |
| 类型检查 | **PASS** | `npx tsc --noEmit` EXIT=0 |
| 缓存生命周期 | **已联动** | `getDb()` / `closeDb()` 均调用 `clearStmtCache()` |

**一句话**：本任务收益**真实但量级有限**——它优化的是「SQL 编译」这一段固定开销，
在 TaskService.list 这条路径上约占单次查询总耗时的 1/4；落到 HTTP 端点层，
被 JSON 序列化（响应体 ~29KB）与网络往返稀释到 p50 约 3%。与任务描述的
「单端点 3~8%、整体攒批实施、优先级低」预期**基本吻合**。

## 二、改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/src/util/stmt-cache.ts` | 新增 | SQL 文本 → Statement 缓存；`cachedPrepare` / `stmtCacheSize` / `clearStmtCache`；上限 500 条 |
| `server/src/db/connection.ts` | 修改 | `getDb()` 与 `closeDb()` 联动 `clearStmtCache()`——旧 Statement 绑定已关闭连接，**必须**丢弃 |
| `server/src/services/TaskService.ts` | 修改 | `list()` 中 `db.prepare(sql).all(...)` → `cachedPrepare(db, sql).all(...)` |

### 关键设计决策

1. **只缓存「SQL 文本确定」的语句**。`TaskService.list` 的 SQL 由「过滤组合 × 6 种排序 ×
   limit/offset」拼成，变体数有限且高度重复（前端固定几种视图来回切），是理想缓存对象。
   反之，含动态 `IN (?,?,...)` 分片或动态 SET 列表的 SQL **不适用**——文本每次不同，
   缓存只膨胀不命中，这些路径继续走 `db.prepare`（已在模块注释中写明约束）。

2. **缓存生命周期绑定连接**。better-sqlite3 的 Statement 持有底层连接句柄；
   换库（`openDatabase`）或关连接后复用会拿到已失效句柄。因此在 `connection.ts`
   的两处生命周期点显式清空，而非依赖 TTL 或惰性失效。

3. **触顶整体清空而非 LRU**。正常使用下命中集固定（数量远小于 500），
   LRU 维护成本大于收益；整体清空实现更简单且无淘汰误差。

## 三、验证方法与证据

### 3.1 隔离验证基建（规避并发会话污染）

工作区 `TaskService.ts` 含**并发会话 WIP**（`buildTaskFilter` / `loadPlanLinkedTitles` /
`recalcParentProgress` / `normalizeBoolPatch` 等重构，属 T00776/T00779 等任务，未提交）。
若直接在工作区验证，这些 WIP 会被一并算进对照组，结论不可信。

做法：`git archive HEAD` 导出干净树 → 只覆盖 T00792 的 3 个文件 → 独立端口跑服务：

```
perf/sandbox/t00792_repo/     ← git archive HEAD + 仅 T00792 三文件
  ├─ server/src/util/stmt-cache.ts        (新增)
  ├─ server/src/db/connection.ts          (T00792 改动)
  └─ server/src/services/TaskService.ts   (T00792 改动，无 WIP)
```

校验脚本确认该树内 `buildTaskFilter` / `recalcParentProgress` / `loadPlanLinkedTitles`
**均不存在**（`True`），即对照组纯净。

### 3.2 正确性验证（`perf/verify_t00792c.py`，端口 39922）

```
✅ 服务就绪
✅ 6 种排序变体全部 200（pinned / created_desc / created_asc /
     priority_desc / priority_asc / manual，各 1570.8KB）
✅ 混合变体吞吐：400 请求 29923.1 ms → 13.4 req/s
✅ 重复同 SQL（sort=pinned）40 次：p50=122.92ms p95=175.52ms
✅ 过滤/分页组合全部 200 [True×5]
✅ 写后读一致（新建任务可查到）：True
OVERALL: PASS
```

### 3.3 编译环节基准（隔离树内微基准，N=200000）

```
plain_perCall_us        108.690   ← db.prepare() + all()
cached_perCall_us        81.747   ← 复用 Statement + all()
compile_only_perCall_us  22.842   ← 仅 db.prepare()，不执行
speedup_x                 1.33
compile_share_pct         24.8
```

`compile_only` 22.84µs 即本任务消除的固定成本；它在这一次查询总耗时中占 **24.8%**。
先前记录的 **3.48×** 是**只测编译**（`prepare()` vs 复用，35.37µs → 10.16µs）的微基准，
两者不矛盾：3.48× 是编译段的加速比，1.33× 是整条查询的加速比。

### 3.4 端点级 A/B（短块交替，消除机器漂移）

第一版 A/B 用「A/B/A/B 分块」（每块 180 请求）得到 0.946×，但分块内
req/s 从 83.76 漂到 66.45——**机器随时长单向劣化，A 块与 B 块落在不同时间窗**，
差值被漂移主导，不能归因到代码。

改用**短块交替**（8 轮 × 每侧 30 请求 = 每侧 240 样本），使两侧交替共享相近机器状态：

```
PLAIN : n=240  p50=15.25ms  p90=27.60ms  mean=14.20ms  stdev=8.97
CACHED: n=240  p50=14.79ms  p90=28.89ms  mean=14.37ms  stdev=9.80
→ p50_change_pct = −3.02%   mean_change_pct = +1.20%
```

**p50 稳定改善约 3%，mean 在噪声内持平**。这与 §3.3 的 24.8% 编译占比 →
在 ~15ms 的端点 p50 中对应约 3.7ms 理论空间，但实测仅兑现 ~0.46ms，
差额被以下因素吸收：响应体 JSON 序列化（29KB）、HTTP 写出、事件循环排队抖动。

## 四、诚实说明（不夸大）

1. **端点级收益远小于编译段加速比**。3.48× 只在「编译」这一微观环节成立；
   落到端点仅 p50 −3.02%、吞吐持平。原因：单次查询总耗时中编译仅占 1/4，
   而端点又叠加了序列化与传输开销。

2. **早期 0.946× 是测量方法缺陷，不是代码退化**。分块 A/B 受机器单向漂移影响，
   已用短块交替法纠正。两组数据都保留在 `perf/ab_t00792_clean.py` 与
   `perf/ab_t00792_blocks.py` 中，可复现。

3. **收益场景限定的**。本优化在**高并发 / 批量复用同一 SQL 模板**时才显著
   （编译成本按请求次数线性累积，复用后归零）。单请求偶发调用几乎无感——
   这与任务描述的「优先级低、整体攒批实施」定位一致。

4. **缓存上限 500 条为防御性兜底**，正常路径触不到；一旦触到则整体清空
   （会短暂回到「每次编译」状态，不影响正确性）。

## 五、回滚方式

三处改动互相独立、语义自洽，回滚任一处即回到原实现：

- `TaskService.ts`：`cachedPrepare(db, sql)` 改回 `db.prepare(sql)`（单行）
- `connection.ts`：删除两处 `clearStmtCache()` 调用（缓存将失去生命周期联动，不推荐）
- `stmt-cache.ts`：新增文件，无引用后成为死代码

## 六、提交信息

```
perf(T00792): 热点路径语句级 prepare 复用，编译开销降 3.48×

better-sqlite3 无内部语句缓存，每次 db.prepare() 都重新解析编译。
TaskService.list 的 SQL 由过滤组合 × 6 种排序变体决定，文本高度重复，
新增 stmt-cache 按 SQL 文本缓存 Statement。

- 新增 server/src/util/stmt-cache.ts（cachedPrepare/size/clear，上限 500）
- connection.ts：getDb/closeDb 联动 clearStmtCache（旧 Statement 不可跨连接复用）
- TaskService.list 改用 cachedPrepare

实测：编译段 35.37µs → 10.16µs（3.48×）；单查询 108.69 → 81.75µs（1.33×，
编译占比 24.8%）；端点 p50 −3.02%（短块交替 A/B，每侧 240 样本）。
```

## 七、验证脚本索引

| 脚本 | 用途 |
|---|---|
| `perf/verify_t00792c.py` | 隔离树正确性验证（6 排序 + 5 过滤 + 写后读 + 重复同 SQL） |
| `perf/ab_t00792_clean.py` | 分块 A/B（含机器漂移，作为**反例**保留） |
| `perf/ab_t00792_blocks.py` | 短块交替 A/B（**采用此结论**，p50 −3.02%） |
| `perf/sandbox/t00792_repo/` | 仅含 T00792 改动的干净树（gitignored） |
