## 根因

`plans/export`（`routes/plans.ts:77`）、`settings/export`（`routes/index.ts:1819`）、
`dbadmin/tables/:table/export`（`routes/dbadmin.ts:60`）、`report/generate`（`routes/index.ts:1075`）
四个导出端点**均无并发上限**，而它们都是同步主线程重活：

| 端点 | 实测单次 | 负载性质 |
|---|---|---|
| `settings/export` | 98–122ms | 4.4MB 全量序列化（`exportBundle()` 遍历全部导出表） |
| `dbadmin/*/export` | 35ms | 全表 `SELECT *` + 逐行 Buffer→base64 |
| `plans/export` | 59ms | Excel 生成（**async**，会让出事件循环） |
| `report/generate` | 165~2162ms | worker 隔离 + 主线程结果装配 |

多路并发时请求**串行叠加**：实测 20 路 `settings/export` 最慢达 **1972ms**（基线 122ms），
期间阻塞事件循环、拖慢无关端点。任务给出的预期收益成立。

## 影响范围

- **受保护端点（4 个）**：`plans/export`、`settings/export`、`dbadmin/tables/:table/export`、`report/generate`。
- **不影响**：同路由下其他端点（`plans/template`、`dbadmin/*/import`、`settings/import` 等）语义未变。
- **单用户场景**：闸门仅在**同时**发起 ≥3 路导出时生效，常规单次导出完全不受影响。

## 修复（绝对路径+改动点）

### 1. 新增 `D:\code\otherProjects\26_MTask\server\src\util\export-gate.ts`（75 行）

内存信号量中间件：

```ts
export function exportGate(name: string, limit = EXPORT_GATE_LIMIT, opts?: { defer?: boolean }) {
  return function exportGateMiddleware(_req, res, next) {
    const cur = inflight.get(name) ?? 0;
    if (cur >= limit) { res.status(429).json({ error: '导出任务过多，请稍后再试' }); return; }
    inflight.set(name, cur + 1);
    let released = false;
    const release = () => { if (released) return; released = true; /* 计数 -1，归零则删除 key */ };
    res.once('finish', release);
    res.once('close', release);   // 异常 / 客户端提前断开也归还，防泄漏
    if (defer) setImmediate(next); else next();
  };
}
```

- `EXPORT_GATE_LIMIT = 2`（同时 2 路，第 3 路起拒绝）。
- `finish` / `close` 双事件 + `once` 去重 → 异常与断连场景均归还计数，避免闸门永久锁死。
- `gateSnapshot()` 暴露计数快照供测试/诊断。
- 单进程内存态即可（本服务单进程部署），进程重启归零，符合「瞬时过载保护」语义。

### 2. 四个端点挂闸

| 文件 | 改动 |
|---|---|
| `server/src/routes/plans.ts:79` | `planApi.get('/export', exportGate('plans-export'), ...)` |
| `server/src/routes/dbadmin.ts:60` | `exportGate('dbadmin-export', undefined, { defer: true })` |
| `server/src/routes/index.ts:1819` | `exportGate('settings-export', undefined, { defer: true })` |
| `server/src/routes/index.ts:1075` | `api.post('/report/generate', exportGate('report-generate'), ...)` |

`report/generate` 保持 worker 现状，仅加闸（与任务要求一致）。

### ⚠️ 实施中发现并修复的深层问题（本次最大价值点）

**首版实现只在异步端点上生效，对完全同步的处理器完全失效。**

首轮实测：`plans/export` 5 路并发正确 2×200+3×429，但 `settings/export`、`dbadmin/export`
20 路并发**仍然 0×429**，且 `settings/export` 最慢 1972ms（线性叠加未缓解）。

**根因（已证实）**：Node 单线程在**同步执行**处理器期间无法接受并解析下一个 HTTP 请求——
后续请求的闸门检查根本不会在「计数已达上限」时被求值，计数永远停在 1，闸门形同虚设。
`plans/export` 之所以生效，是因为它的处理器是 `async`（`.then(...)`），执行中会让出事件循环。

**证据**（`perf/verify_t00789_diagnose.py`）：

| 端点 | 处理器 | 基线 | 10 路并发最慢 | 429 数 |
|---|---|---|---|---|
| `settings/export` | **sync** | 121.9ms | **946.5ms** | **0** |
| `plans/export` | **async** | 58.9ms | 42.9ms | **6** |

**修法**：对两个同步端点传入 `{ defer: true }`，把 `next()` 推迟到 `setImmediate`——
让事件循环先处理已排队请求（各自完成闸门检查与计数），再开始同步重活。

**修复后复测**：`settings/export` 10 路 → **3×200 + 7×429**，最慢由 946ms 降至 **296ms**。

> 该教训已完整写入 `export-gate.ts` 模块注释，供后续新增导出端点参考（**同步处理器必须传 `defer: true`**）。

## 验证（实测证据）

### 1. 类型检查
```
cd D:\code\otherProjects\26_MTask\server && npx tsc --noEmit   → EXIT=0
```

### 2. 主验收（隔离实例，端口 39916）
脚本 `perf/verify_t00789_api.py`

| 验收项 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 并发 5 路 `plans/export` | 2×200 + 3×429 | `[200,200,429,429,429]` | ✅ 通过 |
| 429 响应体中文提示 | 「导出任务过多，请稍后再试」 | 完全匹配 | ✅ 通过 |
| 信号量归零 | 并发后恢复 200 | 连发 6 次全 200 | ✅ 通过 |
| 多轮并发不泄漏 | 每轮后恢复 200 | 4 轮全部恢复 | ✅ 通过 |
| 其余端点同样受闸 | 各自出现 429 | settings 429×1 / dbadmin 429×2 / report 429×3 | ✅ 通过 |

### 3. 端点级 20 路压测（端口 39917）
| 端点 | 200 | 429 | 最慢 |
|---|---|---|---|
| `plans/export` | 2 | 18 | 47.0ms |
| `dbadmin/export` | 4 | 16 | 125.3ms |
| `settings/export` | 4 | 16 | 371.3ms |

### 4. 闸门逻辑单元验证（端口无关，直调模块）
脚本 `perf/verify_t00789_gate_unit.py`，全部 PASS：
- `limit=2` + 5 路 → 2 放行 + 3 拒绝，拒绝体为 429 + 中文提示 ✅
- `finish` 后计数 2→1；再 `close` **不重复归还**（`once` 去重生效）✅
- 全部释放后快照 `{}`（计数归零），恢复放行 ✅
- 闸名隔离：A 闸满载不影响 B 闸放行 ✅

### 5. 提交
`608c4cc` — `perf(T00789): 导出类端点加并发闸，同步处理器需 defer 让出事件循环`
（4 files changed, 88 insertions(+), 4 deletions(-)；已用 `git apply --cached` 精确切分，
未裹挟并发会话 WIP）

## 本次回写

无（本单为收敛型修复，四个端点已全覆盖；deep 发现已在模块注释中留存，无需另立单）。

## 下一步建议（可选）

- 当前闸上限硬编码为 2（`EXPORT_GATE_LIMIT`）。若后续要按端点调优（如 `report/generate` 更重，
  可设 1；`plans/export` 较轻可设 3），建议改从 `app_settings` 读取，避免再改代码。
- 更深一层：`settings/export` 与 `dbadmin/*/export` 的**同步重活本身**才是根本瓶颈（`defer`
  只解决了闸门可见性，未减少单次阻塞时长）。若将来导出体积继续增长，建议把 `exportBundle()`
  改为**分表让出**（每导完一张表 `await setImmediate()`），把单次阻塞切成多段，收益远大于加闸。
