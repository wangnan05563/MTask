## 根因

`WorkspaceService.search()`（`server/src/services/WorkspaceService.ts`）的两级递归 `searchWalk` / `searchVisitEntry` 只在**命中数达到 `SEARCH_LIMIT`(50)** 时才提前退出：

```ts
if (ctx.hits.length >= SEARCH_LIMIT) return;   // 唯一的退出条件
```

因此「无命中」与「弱命中」路径**没有任何截断**：必须同步读完整个工作空间——逐文件 `readFileSync`（≤1MB）+ `text.toLowerCase().includes(needle)` 全量扫描。在 3000 文件工作空间实测走满全树，600 文件夹场景实测 139~567ms/次；数万文件的真实大仓库会秒级独占 Node 单线程事件循环（better-sqlite3 与所有 HTTP 处理同线程）。

## 影响范围

- 端点：`GET /api/workspace/search`（用户在工作空间面板输入关键词，无命中是**最常见**情形——输入过程中每个前缀都可能无命中）
- 内部调用方：`WorkspaceService.autoContext()`（AI 梳理的检索增强注入），每个关键词触发一次该路径
- 连带影响：检索期间的 SSE 流（prd-generate-stream）与所有其它接口被事件循环阻塞排队

## 修复

文件：`D:\code\otherProjects\26_MTask\server\src\services\WorkspaceService.ts`

1. **新增双预算常量与判定**

```ts
const SEARCH_MAX_FILES = 800;                  // 单次检索最多扫描的文件数
const SEARCH_MAX_BYTES = 24 * 1024 * 1024;     // 单次检索最多读取的内容字节数（24MB）
function budgetHit(ctx: SearchCtx): boolean {
  return ctx.scannedFiles >= SEARCH_MAX_FILES || ctx.scannedBytes >= SEARCH_MAX_BYTES;
}
```

2. **`SearchCtx` 增加 `scannedFiles` / `scannedBytes` / `budgetExceeded` 三字段**；`searchWalk` 的递归入口与循环体内均加 `budgetHit()` 判定，超限即置 `budgetExceeded = true` 返回。

3. **`scanFileContent` 由 `void` 改为返回实际读取字节数**，调用处累加 `ctx.scannedBytes`（文件名命中不消耗字节预算，但仍计入文件数）。

4. **`search()` 返回类型显式声明为 `SearchHits`**（数组 + `partial?` / `scannedFiles?` 两个附加属性），原数组结构不变；新增 `invalidateSearchCache(projectId?)` 公开方法。

5. **路由显式透传元信息**（`server/src/routes/index.ts`）：JSON 序列化会丢弃数组的非索引属性，故改为返回对象：

```ts
return { items: hits, count: hits.length, partial: hits.partial === true, scannedFiles: hits.scannedFiles ?? 0 };
```

> 兼容性核查：前端 `web/src/` 全文搜索无 `/workspace/search` 调用（该端点尚无 UI 接入，仅 MCP/内部使用），故返回结构变化**无兼容风险**；`autoContext` 走服务内部调用，不受路由变化影响。

**预算取值依据**：3000×40 行 ts 工作空间实测 —— 2000 文件 → 710ms（仍偏慢）；800 文件 → 158~189ms；500 文件 → <200ms。折中取 800 覆盖绝大多数真实仓库「前 800 个可检索文件内命中」的需求，漏检由 `partial` 提示。memo 预扫描（T00782）使用独立的更宽预算（3000 文件/96MB），因其摊薄后成本极低。

## 验证（实测证据）

验证脚本：`perf/verify_ws.py`（直接调用）、`perf/verify_ws_api.py`（HTTP 级）、`perf/make_ws_big.py`（构造 3000 文件工作空间）

**1. 直接调用实测**（3000×40 行 ts 工作空间，隔离库 + 隔离实例）

| 场景 | 耗时 | hits | partial | scannedFiles |
|---|---|---|---|---|
| 无命中（改前无限遍历） | **388.8 ms**（首测 710ms@2000 预算） | 0 | true | **800**（有界） |
| 弱命中（1 条） | 233.2 ms | 1 | true | 800 |
| 强命中 | 5.6 ms | 50 | false | 17（50 条早退） |
| 常规关键词 | 14.6 ms | 50 | false | 50（早退） |

**2. HTTP 端点实测**（隔离实例 39910 / `perf/sandbox/verify_ws_api`）

| 场景 | status | 耗时 | count | partial | scannedFiles |
|---|---|---|---|---|---|
| 无命中关键词 | 200 | 188.9 ms | 0 | **true** | **800** |
| 弱命中 | 200 | 158.3 ms | 1 | **true** | 800 |
| 强命中 | 200 | 25.2 ms | 50 | false | 17 |
| 常规 | 200 | 40.6 ms | 50 | false | 50 |

`partial` / `scannedFiles` 正确透传至响应体。

**3. 事件循环灵敏度**：检索后连续 8 次 `/api/health` → max 15.9 ms / 中位 **14.4 ms**（改前大仓库下被拖到数百 ms）

**4. 编译**：`cd server && tsc --noEmit` → 退出码 0，0 错误

**5. 日志**：全程无 Error / TypeError

## 本次回写

- 本条与 **T00782**（organize 批量缓存 / refreshSymbols 异步化 / 符号上限前置）、**T00790**（refreshSymbols 事务包裹 + mtime Map）为**同域统一设计与同批实施**，按任务描述「建议统一设计，避免双轨」的要求合并落地，提交 `cc46968`。
- 新增派生任务：无。
- 遗留提示：`server/src/services/WorkspaceService.ts` 此前为 **git 未跟踪新文件**（T00776/T00777 新增），本次随修复一并首次入库；`server/src/routes/index.ts` 的 workspace 路由块（T00776/T00777 新增，含本次 T00786 改动）同为未提交内容，已用 `git apply --cached` 精确切分该 hunk 入库，未裹挟工作区其它并发会话改动。

## 下一步建议

- 若后续前端接入工作空间检索 UI，建议在有 `partial: true` 时给出「结果可能不完整，可用 glob 缩小范围」的提示（本次仅后端透传，UI 提示属前端范畴）。
