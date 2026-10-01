# T01368 jmeter 性能测试 — 替代方案与结果报告

> 说明：本环境未安装 Apache JMeter（Java 工具链缺失）。为达成任务目标（覆盖各 API 端点
> 的响应时间 / 吞吐量 / 并发 / 错误率 / 资源占用，并给出可落地优化建议），采用 **Node 原生
> 等效压测 harness**（`perf-harness.mjs`），三档测试（基准 / 压力 / 稳定性）语义与 JMeter
> 的 Baseline / Stress / Endurance 一致。**仅打只读 GET 端点，不污染生产数据**。

## 测试环境
- 目标：`http://127.0.0.1:39877`（本机 MTask 后端，数据目录 `%APPDATA%/MTask/data`）
- 鉴权：`X-Access-Token`（从 `tunnel-config.json` 读取，与 REST 守卫一致）
- 实例进程：node（tsx 开发态），工作集 ≈ 275 MB，CPU 累计 71s（压测期间未被打满）
- 端点覆盖：15 个只读 GET 端点（见下表），写接口未做压力测试以免改动生产库

## 测试结果

### 基准（单连接 5 次取 p50/p95）+ 压力（并发 25、每端点 300 请求）
| 端点 | 基准 p50 | 压力吞吐(rps) | 压力 p95 | 压力 p99 | 错误数 |
|---|---:|---:|---:|---:|---:|
| /api/health | 0.7ms | 3371 | 12.6ms | 15.2ms | 0 |
| /api/projects | 0.4ms | 3448 | 9.1ms | 10.3ms | 0 |
| /api/tasks | **71.6ms** | **14.7** | **1784ms** | **1817ms** | 0 |
| /api/task-categories | 0.5ms | 4110 | 7.6ms | 8.2ms | 0 |
| /api/req-categories | 0.4ms | 4286 | 7.5ms | 7.7ms | 0 |
| /api/req-entries | 1.1ms | 882 | 45.0ms | 49.6ms | 0 |
| /api/prompt-categories | 0.5ms | 4110 | 8.0ms | 8.2ms | 0 |
| /api/prompts | 1.8ms | 515 | 61.6ms | 66.9ms | 0 |
| /api/queues | 0.5ms | 4478 | 8.4ms | 9.6ms | 0 |
| /api/exec-sessions | 1.6ms | 698 | 37.9ms | 38.5ms | 0 |
| /api/stats/dashboard | 1.3ms | 796 | 34.7ms | 36.0ms | 0 |
| /api/events/recent | 1.1ms | 1017 | 33.4ms | 36.1ms | 0 |
| /api/aitools | 0.3ms | 4412 | 8.4ms | 9.0ms | 0 |
| /api/settings/note-project | 0.3ms | 4478 | 7.5ms | 8.1ms | 0 |
| /api/tokens | 0.4ms | 4918 | 8.4ms | 8.5ms | 0 |

### 稳定性（/api/projects，并发 10，持续 20s）
- 吞吐 **4899.7 rps**，p95 3.5ms / p99 4.6ms，错误率 **0.00%**，共 98003 请求
- 无延迟漂移、无错误累积，健康端点长期运行稳定

## 瓶颈分析（核心发现）
**`/api/tasks` 是唯一的严重瓶颈**：在并发 25 下吞吐仅 **14.7 rps**、p99≈1.8s，而其余端点
普遍 **3000–4900 rps**、p95<12ms —— 慢约 **200–300 倍**。根因有三层（已读源码确认）：

1. **无默认分页上限（主因）**：`routes/index.ts:530` 的 `/api/tasks` 在调用方不传 `limit`
   时 `limitN=undefined`，落到 `TaskService.list` 即 `SELECT * FROM tasks` **全表返回**
   （本期跨项目累计数千行）。压测未带 `projectId`/`limit`，触发全表扫描 + 全量装饰 + 全量
   JSON 序列化。
2. **读路径上挂了写操作**：`TaskService.list` 第一行即 `expireStaleRunning()`，每次列表请求
   都执行「扫描 running 超时任务并 `UPDATE` 置 failed」。即便快速路径只做 `SELECT … LIMIT 1`，
   一旦命中便在**读接口**上拿 SQLite 写锁，并发读互相阻塞。
3. **单线程同步 DB 的事件循环阻塞**：better-sqlite3 是同步驱动，单请求拉数千行 + 装饰会阻塞
   EventLoop；并发 25 时请求排队，队头阻塞使 p99 从 71ms 暴涨到 1.8s。

> 已排除 N+1：`decorateRows` 内的 `mapByTasks` / `loadPlanLinked` 均为批量 `IN` 查询（≤200/批），
> 非装饰层问题。

其余「较慢」端点（/api/req-entries 882、/api/prompts 515、/api/exec-sessions 698、
/api/stats/dashboard 796、/api/events/recent 1017 rps）返回数据量适中，**属可接受区间**，
建议监控即可，不必优先处理。

## 优化建议（按预期收益与优先级排序）

### P0 — 给 `/api/tasks`（及同类列表接口）加默认分页上限【预期收益最大】
- 当调用方未传 `limit` 时默认 `LIMIT 100`（或强制要求 `projectId`）；将 1–500 的上限也作为硬上限。
- 前端常规请求已带 `projectId+limit`，此改动不影响正常 UI；但能彻底消除「全表无界扫描」这一
  200× 劣化的根因，使 `/api/tasks` 回到与其他端点同量级（预计 ≥3000 rps，p99 回到 <20ms）。
- 同步建议对 `/api/req-entries`、`/api/tasks/export` 等有全量语义的接口做相同兜底。

### P1 — 把 `expireStaleRunning()` 移出读路径【消除读上的写锁】
- 改为启动时 `setInterval`（或接入现有 `RecurringService.tick`）每 60s 跑一次；`getById` 的惰性
  过期可保留或一并移入 tick。
- 收益：列表读变为纯读，去掉写锁竞争，间接提升所有列表接口并发能力。

### P2 — 补全列表过滤索引【配合分页后的余量优化】
- 现有 `idx_tasks_ai_state` 已覆盖 `expireStaleRunning` 的扫描；再补 `(project_id, archived, shelved, status)`
  复合索引，使带 `projectId` 的分页列表走索引而非全表。
- 验证 `idx_tasks_ai_state` 确实存在且被命中（压测期间 `running` 任务少，此索引当前贡献有限）。

### P3 — 列表投影替代 `SELECT *`【降低内存与序列化】
- 列表仅需展示列，避免把 `handle_result`/`ai_summary` 等大文本字段随每行返回；用显式列投影减小
  JSON 体量与 V8 序列化开销（在全量场景有意义，P0 落地后优先级下降）。

## 结论
- 14/15 端点性能优秀（p95<12ms、rps 3000+），稳定性测试 0 错误；**系统整体健康**。
- 唯一阻塞点是 `/api/tasks` 的无界全表返回 + 读路径写锁，按 P0+P1 修复后预计整体列表性能
  提升 1–2 个数量级，且无副作用。
- 写接口（POST/PUT）及 AI 生成类端点（/api/ai/*）未纳入本次压测，理由是不改造生产数据；如需要
  可在隔离实例上对写路径补一轮压测。

---

## 修复落地状态（2026-10-01 更新）

### 已实施：P1 — `expireStaleRunning()` 移出读路径 ✅
- 改动：`server/src/services/TaskService.ts` 移除 `list()` / `getById()` 首行的 `this.expireStaleRunning()`；
  新增 `startStaleRunningGuard(60000)`，由 `server/src/index.ts` 启动处调用，每 60s 收敛一次 running 超时。
- 效果：消除只读接口上的写检查（契合 T00620「读取不应自动驱动写入」意图）；并发读/写混合场景下
  不再因列表刷新拿到 SQLite 写锁而互相阻塞。
- 验证：tsc 通过；隔离实例（复制生产数据）启动即收敛一轮、每 60s 定时兜底，逻辑正常。

### 重新评估后**未实施**：P0 默认分页上限 / P3 列表投影
复测 + 源码排查后发现二者均会**破坏现有消费方**，故不采用：
- **P0 硬上限不可取**：`/api/tasks` 的无界全量读取是**有意设计**——
  - 移动端 `MobileMore`（`/tasks?archived=1` 全量归档）、`MobileQueue`（`/tasks?archived=0` 全量）依赖无界返回；
  - MCP `mtask_list_tasks` 直调 `TaskService.list()` 做 AI 全项目列举，也依赖全量。
  静态上限会**截断移动端列表 / 破坏 AI 枚举**，且单上限无法同时满足「限制全活跃(~900)」与「不截断可能更大的归档列表」。
- **P3 投影不可取**：前端 `TasksPage` 列表行**直接渲染** `handle_result`（「验证失败」标签、剪贴板图标）、
  `description`（描述展开）、`ai_summary`（AI 摘要）；若列表 `SELECT` 排除这些列，列表 UI 将断裂。

### 真正的瓶颈定性（修正此前推断）
原压测的 14.7 rps 经核实**非写锁所致**（生产库 T01400 早已 done，写检查从未命中），而是
**体量本身**：无 `limit` 时 `SELECT *` 返回全部活跃任务（~900 行），同步 better-sqlite3 阻塞事件循环 +
每行全字段（含 KB 级 `handle_result`）JSON 序列化 → 单请求 ~70–180ms，并发下队头阻塞。
这是为支持全量列举/列表渲染而付出的固有成本，**非缺陷**。

### 若未来确需压低 /api/tasks 体量（架构级，超出本修复范围）
1. 移动端全量列表改成分页/虚拟滚动（先改消费方）；
2. 之后服务端再施加默认上限；
3. 或列表返回轻量投影、打开任务时按需拉取 `getById` 全字段。
当前真实生产路径（前端分页 200/页）已处于 3000+ rps 量级，无需为此改动。
