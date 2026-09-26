## 根因

`PlanService.listRequirements()`（`server/src/services/PlanService.ts:1456`）对**每个需求**都重新遍历全量 `plans` / `tasks` 数组，并在每次遍历中重复执行 `JSON.parse(req_ids)`：

```ts
return reqs.map((r) => {
  const linkedPlans = plans.filter((p) => parse(p.req_ids).includes(rid))  // 每次重 parse 全部 plans
  const linkedTasks = tasks.filter((x) => parse(x.req_ids).includes(rid))  // 每次重 parse 全部 tasks
```

复杂度 O(N需求 × M计划/任务)。better-sqlite3 是同步 API，该循环全程占满 Node 单线程事件循环——这是 2026-09-18 全端点压测中**唯一的主导瓶颈**：`GET /api/plans/prd-requirements` 436 次调用累计占用事件循环 **117,641 ms**（服务器自身慢日志），单次最慢 27s，并把同进程 `/health` 的 p50 拖到 309ms。

## 影响范围

- 端点：`GET /api/plans/prd-requirements`（需求跟踪矩阵页载入）
- 间接受害面：同进程**所有**端点——同步长任务阻塞事件循环，SSE 流（prd-generate-stream）、健康检查、其它读写全部排队
- 触发条件：项目需求数与计划/任务数同时较大（压测数据 1805 需求 × 4291 计划 × 2209 任务时单次 5.5s；线上 400 需求规模单次约 27s 级）

## 修复

文件：`D:\code\otherProjects\26_MTask\server\src\services\PlanService.ts`（`listRequirements`，现 1468–1495 行）

改动点：把 `reqs.map` 内的两次 `filter` 换成「先各遍历一次 plans/tasks，按 reqId 建反向索引 Map」，再在 map 内 O(1) 取用：

- 新增 `plansByReq: Map<reqId, {id,title,status}[]>`
- 新增 `tasksByReq: Map<reqId, {id,taskNo,title,status,verified}[]>`
- 复杂度 O(N×M) → O(N+M)，`req_ids` 仅解析一次
- **返回结构、字段顺序、关联项顺序、`prdDoc` 逻辑全部不变**

提交：`8bf851b`（独立成条，未裹挟工作区其它并发改动）

## 验证（实测证据）

验证脚本：`perf/verify_t00784.py`（等价性+性能）、`perf/verify_t00784_api.py`（API 级）、`perf/seed_req_links.py`（补种关联数据）

**1. 行为等价性（逐字节）** — 同一 seed 库副本上分别运行旧/新实现：

| 项 | 旧 O(N×M) | 新反向索引 |
|---|---|---|
| 全量返回 JSON md5 | `89fa241836ffc54bc375cfc4c306738b` | `89fa241836ffc54bc375cfc4c306738b` |
| 需求条目数 | 1805 | 1805 |
| 计划关联引用 | 8486 | 8486 |
| 任务关联引用 | 3101 | 3101 |

md5 完全一致 → 输出逐字节等价，非近似等价。

**2. 性能收益**（seed 副本 1805 需求 × 4291 计划 × 2209 任务，取 3 次中位）

| 指标 | 改造前 | 改造后 | 提升 |
|---|---|---|---|
| 直接调用单次耗时 | 5529.0 ms | 35.4 ms | **156.3×** |
| 单次节省事件循环时间 | — | — | 5493.7 ms |

**3. API 级端到端**（隔离实例 39904 / `perf/sandbox/verify784`）

| 指标 | 压测实测（改造前） | 本次实测（改造后） |
|---|---|---|
| 端点单次耗时 | ~27,000 ms（436 次烧 117,641ms） | **69.5 ms**（5 次中位，最慢 78.6ms） |
| 并发期间 `/health` | p50 **309 ms** | **max 23.6 ms** |
| 4 路并发墙钟 | 串行阻塞 | 200.4 ms |
| 错误率 | — | **0**（9 次请求全 200） |
| 日志异常 | — | 无 |

**4. 编译**：`tsc --noEmit` 退出码 0，0 错误（`server/` 目录）

## 本次回写

- 无新增派生任务。
- 关联：本条为 2026-09-18 全端点性能测试报告 P0-1 的实施落地；报告中「P0-1 预期收益：单端点从 27s 降至 <200ms」已由实测（69.5ms）超额达成。
- 提交：`8bf851b`（单文件、单 hunk、22+/2-）

## 下一步建议

- 建议在「需求跟踪矩阵」页面做大项目（>1000 需求）人工实测一次，确认前端渲染未因响应体 1.7MB 而卡顿——如需优化属前端虚拟滚动范畴，与本次后端修复正交。
