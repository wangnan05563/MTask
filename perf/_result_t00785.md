## 根因

`server/src/db/connection.ts` 的 `openDatabase()` 只设置了两个 pragma：

```ts
d.pragma('journal_mode = WAL');
// busy_timeout 在 getDb() 里另设
```

**未设 `synchronous`**。SQLite 默认值为 `FULL`（实测确认：新建连接默认 `synchronous=2`，切到 WAL 后仍为 `2`）。在 WAL + FULL 组合下，**每一次事务提交都要对 WAL 文件做一次 fsync**。

而本项目所有服务层写操作都是逐条 autocommit（better-sqlite3 同步 API，除少数显式 `db.transaction()` 包裹外），因此「一条业务写 = 一次 fsync」。这是 2026-09-18 全端点压测中**写吞吐随并发上升不增反降**（533 → 454 → 372 req/s）的直接成因：并发越高，fsync 排队越严重。

## 影响范围

- 全部写端点：`POST/PATCH/DELETE /api/tasks`、`/api/plans`、`/api/prj-requirements`、`/api/history` 快照写入、MCP 工具写路径等
- 失败表现：单条写延迟被 fsync 独占性抬升；并发写吞吐反降；SSE 流与读请求在写密集时被连带拖慢
- 桌面单用户场景：此开销属纯粹浪费——本地单机无多机崩溃一致性的强需求

## 修复

文件：`D:\code\otherProjects\26_MTask\server\src\db\connection.ts`

改动 1（`openDatabase()`，WAL 成功路径）：

```ts
d.pragma('journal_mode = WAL');
+ d.pragma('synchronous = NORMAL');
return d;
```

改动 2（`fallbackOpen()`，WAL 不可用的 DELETE 兜底路径）：同样显式 `d.pragma('synchronous = NORMAL')`——避免依赖默认值（未来 SQLite / better-sqlite3 升级若改默认行为会静默劣化），且该路径本身已是「WAL 不可用」的降级形态，一致性诉求已让位于可用性。

**语义说明**：WAL + `synchronous=NORMAL` 是 SQLite 官方推荐组合。commit 时不再 fsync（仅在 checkpoint 时同步刷盘）。崩溃/断电最多丢失最近若干**已提交事务**，但**不会损坏数据库**（WAL 仍可正常回放）。桌面单用户场景下这个权衡明确偏向性能。

提交：`f54e4f9`（单文件、11 行新增、无并发会话改动混入）

## 验证（实测证据）

验证脚本：`perf/verify_t00785.py`（写吞吐基准 + 完整性断言）、`perf/verify_t00785_api.py`（API 级）

**1. 写吞吐基准**（同一 seed 库副本，4000 个事务逐条 autocommit，模拟真实热点写：tasks 状态更新 + 审计插入；两轮取平均）

| 指标 | synchronous=FULL | synchronous=NORMAL | 变化 |
|---|---|---|---|
| 4000 事务耗时 | 3708.0 ms | **383.7 ms** | 降至 **10%** |
| 吞吐 | 1079 tx/s | **10538 tx/s** | **+876.7%（约 9.8×）** |
| 首轮实测 | 3668.0 ms / 1091 tx/s | 343.8 ms / 11634 tx/s | — |
| 复测 | 3748.0 ms / 1067 tx/s | 423.6 ms / 9443 tx/s | — |

> 注：任务预期为「提升 30~60%」，实测在「逐条 autocommit」负载下达到约 **9.8 倍**——因为原实现每次 commit 都是一次完整 fsync，属该场景下的最大瓶颈；实际业务的提升幅度取决于事务粒度（已用批量事务包裹的路径提升较小）。

**2. 数据完整性断言**（同 N=4000 写入，对比两种模式最终库状态）

| 校验项 | FULL | NORMAL | 结果 |
|---|---|---|---|
| 审计表行数 | 4000 | 4000 | ✅ |
| tasks 表行数 | 2831 | 2831 | ✅ |
| 标题长度总和 md5 | `3ab2ed1a7ac2cb460fd597c13d77a11c` | `3ab2ed1a7ac2cb460fd597c13d77a11c` | ✅ |

三种校验完全一致 → **未丢任何写入数据**。

**3. API 级端到端**（隔离实例 39905 / `perf/sandbox/verify785`）

| 项 | 结果 |
|---|---|
| 服务启动 | ✅ `/api/health` 200 |
| 300 连写 `PATCH /api/tasks/:id` | ✅ **成功 300 / 失败 0**，墙钟 1.59s（≈189 req/s，含 HTTP + 应用层开销） |
| 落库断言 | ✅ 直接 SQL 查询确认 `tasks.updated_at` 已更新 **300 行** |
| `/health` 10 次 | max 14.7 ms / 中位 **1.4 ms** |
| 日志异常 | 无（无 Error / TypeError / SQLITE 报错） |

**4. 编译**：`cd server && tsc --noEmit` → 退出码 0，0 错误

## 本次回写

- 无新增派生任务。
- 本条为 2026-09-18 全端点性能测试报告 P1-1 的实施落地。
- 与 T00784（`8bf851b`）同为 P0/P1 落地批次，两条提交互相独立、可分别回滚。

## 下一步建议

- `synchronous` 是**连接级**（非持久化到库文件）设置，本改动对每次 `getDb()` 新建连接生效，无需迁移脚本。
- 若后续引入多进程/多用户共享同一库文件，需重新评估 NORMAL 的掉电丢事务窗口（当前单进程桌面架构无此风险）。
