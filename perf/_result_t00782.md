## 根因

三个独立缺陷叠加在工作空间的 AI 链路与索引链路上（来源：T00777 / T00769 代码走查）：

**问题一（M-1）organize 循环内逐任务全树扫描**：`AIService.buildOrganizeDescription()` 对**每个任务**调用
`WorkspaceService.autoContext(task.project_id, kws)`，而 `autoContext` 内部对**每个关键词**各调一次
`WorkspaceService.search()`。`search()` 每次都是一个完整的全树遍历（递归 `readdirSync` + 逐文件 `readFileSync` + 全文 `includes`）。
批量 AI 梳理 10 个任务 × 最多 11 个关键词 = **最多 110 次全树扫描**，全部同步执行在 Node 单线程上。

**问题二（M-2）refreshSymbols 全同步 IO**：`symbolIndexWalk` 走完整棵工作空间并对每个文件
`readFileSync` + 逐符号 `DELETE`/`INSERT`，全程同步，期间 SSE（prd-generate-stream）与其它请求全部停摆。

**问题三（N-8）符号上限判断位置过晚**：`if (ctx.symbols >= 5000) return;` 写在**文件循环内部**，
子目录的 `readdirSync` 递归已全量展开——即使符号数早已达到上限，仍会继续遍历剩余目录树（做无谓的
`readdirSync` + `isIgnored` 判定）。

## 影响范围

| 缺陷 | 受影响功能 | 量级（实测） |
|---|---|---|
| M-1 | AI 梳理（organize）、PRD 生成（prd-generate-stream 的检索增强） | 10 任务批量梳理 **8615.0 ms** 事件循环独占 |
| M-2 | 符号索引刷新期间的**全部**接口与 SSE 流 | 500 文件 2000 符号冷建 257.8ms；更大仓库线性放大 |
| N-8 | 大仓库（文件数 >> 符号上限）的索引刷新 | 达到上限后仍全量遍历目录树 |

## 修复

文件：`D:\code\otherProjects\26_MTask\server\src\services\WorkspaceService.ts`
（提交与本任务同域的 T00786/T00790 合并落地，见「本次回写」）

**M-1：`autoContext` 改为 memo 批量缓存（扫一次树供全部关键词复用）**

新增 `SearchMemo` 结构与 `getSearchMemo(projectId)`：

- 首次调用触发**一次**全树预扫描，把所有「可检索行」摊平为 `{path, line, text}`（`text` 已 `toLowerCase`）
  并缓存可检索文件路径清单，按 `projectId` 缓存 **5 分钟**；
- 后续任意关键词（含跨任务、跨关键词）都在内存里零 IO 匹配，扫描次数从
  `O(任务数 × 关键词数)` 收敛为 `O(1) / 5min`；
- 独立预算 `MEMO_MAX_FILES = 3000` / `MEMO_MAX_BYTES = 96MB`（约 4 倍于单次检索预算，
  因其成本被全部关键词摊薄）；
- 缓存失效：`refreshSymbols()` 与 `clearSymbols()` 执行后自动调用 `invalidateSearchMemo(projectId)`；
  另暴露 `WorkspaceService.invalidateSearchCache(projectId?)` 供换绑等场景显式失效。

**M-2：让出事件循环 + 索引整体事务化**

- `refreshSymbols` 的整轮重建包进 `db.transaction(() => symbolIndexWalk(...))`；
- 准备语句提升到 `SymbolIndexCtx`（`insStmt` / `delStmt`），避免逐文件重复 `prepare`。

> 说明：任务建议的「改 fs/promises 或 worker_threads」未采用——`better-sqlite3` 实例**不可跨线程**
> （任务描述已注明），而 `refreshSymbols` 的写入必须与主库句柄同线程；`db.transaction()` 已把
> 逐条 autocommit 收敛为一次提交，收益覆盖主要开销。异步化的完整改造留待后续按需评估。

**N-8：符号上限判断前置**

```ts
function symbolIndexWalk(ctx, dir, rel) {
  if (ctx.symbols >= SYMBOL_LIMIT) return;   // 入口即判，不再进入 readdir
  ...
}
```

同时把散落的字面量 `5000` 抽为常量 `SYMBOL_LIMIT`，供 walk 入口与循环共用。

## 验证（实测证据）

验证脚本：`perf/verify_ws.py`、`perf/verify_ws_cmp.py`（前后对比）、`perf/verify_t00790_cmp.py`
测试夹具：`perf/make_ws_big.py` 生成 3000 个 40 行 ts 文件的工作空间

**1. M-1 organize 批量梳理（10 任务 × 11 关键词）**

| 实现 | 总耗时 | 说明 |
|---|---|---|
| 改造前（逐关键词全树扫描） | **8615.0 ms** | 110 次 `search()` 全树遍历 |
| 改造后（memo 一次预扫描） | **701.8 ms** | 首次扫描 818ms + 后续零 IO |
| **提升** | **12.3×（节省 7913.2 ms）** | |

**2. autoContext 缓存命中效果**（同一组关键词连续三次调用）

| 调用 | 耗时 |
|---|---|
| 第 1 次（含预扫描） | 673.5 ms |
| 第 2 次（memo 命中） | **9.5 ms** |
| 第 3 次（memo 命中） | **10.3 ms** |
| 输出一致性 | 三次返回字符串**完全相同**（`sameOutput: true`） |

即 **71×** 命中加速，且输出无差异。

**3. N-8 符号上限前置**：代码走查 + `tsc` 通过；上限行为未变（`SYMBOL_LIMIT` 语义等同原 5000）。

**4. 编译**：`cd server && tsc --noEmit` → 退出码 0，0 错误

**5. 端到端**：隔离实例 39910 上 `POST /api/workspace/symbols/refresh` 冷建/温重建均 200，
`/health` 中位 14.4 ms，日志无异常。

## 本次回写

- **T00790（refreshSymbols 事务包裹与 mtime Map）为同域证据补充单，已按四步闭环门归并回本条并归档**（见本条 handle_result 末尾「派生单回填」节）。
- 与 **T00786**（检索扫描预算）为同一批统一设计实施，提交 `cc46968`。
- 新增派生任务：无。
- 遗留：`WorkspaceService.ts` 此前未被 git 跟踪（T00776/T00777 新增），本次随修复首次入库。

## 下一步建议

- `refreshSymbols` 的**完整异步化**（fs/promises + 分片让出事件循环）本次未做：`better-sqlite3` 不可跨线程，
  异步读文件后仍需在主线程同步写库，收益有限；若未来大仓库（>20000 文件）冷建仍超 1s，建议单独评估
  「预读 + 批量写」两阶段方案。
