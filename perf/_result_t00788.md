## 根因

`GET /api/history/list`（`server/src/routes/history.ts:41`）对每个快照项目**逐个执行 2 次全列查询**：

```ts
const snapshots = projects.map((p) => {
  const tasks = db.prepare('SELECT ... FROM tasks WHERE project_id = ? ORDER BY task_no').all(p.id);
  const plans = db.prepare('SELECT ... FROM plan_tasks WHERE project_id = ? ORDER BY sort_order').all(p.id);
  ...
});
```

典型的 N+1 模式：查询数 `1 + 2N` 随快照量**线性增长**；且每次 `prepare+all` 都走一遍
better-sqlite3 的语句编译与结果集编组，快照量增长后成本叠加，响应体可达数 MB。

## 影响范围

- **受影响端点**：`GET /api/history/list`（单端点）。
- **不影响**：`/history/summary`、`/transfer`、`/restore`、`/to-archive` 均未改动。
- **响应契约**：字段集合、字段名、嵌套结构、排序**完全不变**（已用逐字节对照验证）。

## 修复（绝对路径+改动点）

**`D:\code\otherProjects\26_MTask\server\src\routes\history.ts`** — `/list` handler 重写：

1. 先一次取全部快照项目；空集直接返回 `{ snapshots: [] }`（早返回，省两次空 IN 查询）。
2. `ids.map(() => '?').join(',')` 动态生成占位符，用**一条 IN 查询**各取回全部任务 / 计划。
3. 内存按 `project_id` 用 `Map` 分组，**保持原 ORDER BY 顺序**（任务按 `task_no`、计划按 `sort_order`）。
4. `stats` 与最终装配逻辑不变，`project_id` 从下发对象中剔除（与原实现字段集一致）。

**查询数：`1 + 2N` → `3`（与快照数无关）。**

### ⚠️ 与任务描述的一处偏离（有意为之）

任务描述建议「列表查询去掉 description 大字段」。**该项未采纳**，原因经代码核实：

| 字段 | 消费点 | 用途 |
|---|---|---|
| `tasks.description` / `tasks.handle_result` | `web/src/pages/HistoryPage.tsx:237` | 任务行 `title` 属性 tooltip |
| `plans.description` | `web/src/pages/HistoryPage.tsx:250` | 计划行 `title` 属性 tooltip |
| `projects.description` | `web/src/pages/HistoryPage.tsx:87` | 快照搜索过滤关键词 |

裁剪任一字段都会造成**可感知的 UI 回归**（tooltip 丢失 / 搜索失效），且详情页并无承载这些
字段的替代接口（描述中「详情视图另有接口承载」的前提不成立）。因此本次只做 N+1 消除，
列裁剪留待前端改造 tooltip 数据源后再评估。

## 验证（实测证据）

### 1. 类型检查
```
cd D:\code\otherProjects\26_MTask\server && npx tsc --noEmit   → EXIT=0
npx tsc --noEmit -p web/tsconfig.json                          → 0 错误
```

### 2. 逐字节等价 + 边界（隔离实例）
脚本 `perf/verify_t00788_api.py` / `perf/verify_t00788_scaling.py`
环境 `MTask_PORT=39912/39913` + 复制生产样本库
负载 **24 快照 × 45 任务 + 8 计划**（另置 1 个空快照验证边界）

| 验收项 | 结果 |
|---|---|
| 与旧实现输出逐字节等价（31 快照） | ✅ 是 |
| 任务 `task_no` / 计划 `sort_order` 顺序一致 | ✅ 是 |
| 项目 `history_at DESC` 顺序一致 | ✅ 是 |
| 空快照边界：`stats` 全 0 且 `tasks/plans` 为 `[]` | ✅ 是 |
| 查询数 | `1+2N=49` → **3** |

### 3. 端点级 A/B 对照（关键证据）
脚本 `perf/ab_t00788.py` —— **同一 DB、同一时刻**，把实现临时切回 N+1 旧版各测 30 次：

```
✅ [NEW  ] p50=30.67ms p95=47.59ms  (1109.1 KB)
✅ [OLD  ] p50=36.37ms p95=47.61ms  (1109.1 KB)
✅ 两者响应体逐字节等价：是
✅ 端点 p50：NEW 30.67ms vs OLD 36.37ms → 0.843×（快 15.7%）
```
（测毕已还原新实现，md5 校验一致；A/B 记录 `perf/sandbox/ab788.result.json`）

### 4. 成本拆解（说明验收线的真实含义）
单跑计算链路 40 次：**SQL+分组+stats+JSON p50 = 16.77ms / p95 = 19.70ms**，其中
SQL 取数 ~9ms、`JSON.stringify` ~7ms（1.07MB 响应体）。

端点实测 p50 落在 **30–45ms 区间波动**，与纯计算链路的差额（~15–25ms）为 express 路由
分发 / `res.json` 序列化 + HTTP 写出开销，非本次改动引入。

> **验收「p50<30ms」的诚实结论**：端点 p50 实测 **30.67ms（A/B 那次）/ 37–43ms（另两次）**，
> 处于 30ms 验收线**边缘、未稳定达标**。根因已定位为**响应体本身的 JSON 序列化与 HTTP 写出**
> （1.1MB，占端点成本一半以上），而非 SQL——N+1 消除后 SQL 已不是瓶颈。要真正压到 30ms 以下
> 需减少响应体（前端改懒加载 tasks/plans，或列表页只下发 stats），属**前端契约变更**，超出本单范围。

### 5. 提交
`cdcf79d` — `perf(T00788): history/list 消 N+1，IN 分组替代逐快照全列查询`
（1 file changed, 37 insertions(+), 3 deletions(-)；diff 纯净，未裹挟并发会话 WIP）

## 本次回写

本单为收敛型修复，但验证过程暴露一条**独立的、有明确收益的**后续项，已建单：

- **`【AI回写待审核】性能P2：history/list 响应体瘦身——列表页免传 tasks/plans 或改按需加载`**
  （derivedFrom: T00788）——端点 p50 无法稳定 <30ms 的唯一原因是 1.1MB 响应体的序列化与
  网络写出；需前端契约配合（列表只渲染 stats + 展开时再拉取，或新增 `/history/snapshot/:id` 详情接口）。

## 下一步建议（可选）

- `history/list` 目前每次请求都全量返回所有快照的 tasks/plans，与前端「分页 10 条 + 折叠展示」
  的 UI 模式不匹配（前端翻了 10 条的数据却只用 1/10）。若采纳上述派生单，建议同时评估
  服务端分页 + 详情按需拉取，收益比单纯 N+1 消除大一个量级。
