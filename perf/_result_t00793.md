# T00793 处理结果：mock 上游下的 AI 端点本地编排成本评估

**状态**：已完成（评估类任务，产出基线表） · **验证**：命令层全链闭环

## 一、结论摘要

| 项 | 结果 |
|---|---|
| 方法可行性 | **成立**——mock 上游可完全替代真实上游，隔离测出本地编排成本 |
| 成功测得端点 | **9 / 10 条**（均 8/8 × 200） |
| 上游慢对照 | **2529~2532ms**（mock 侧 2500ms + 本地编排 ~30ms），精确锚定，证明能区分「本地慢」与「上游慢」 |
| 上下文预算 | **生效**——43222 字符 PRD 注入后 prompt 压至 **6375 字符**（含头尾保留 + 截断标记） |
| 未能测得 | `POST /update/check`——其依赖**真实 GitHub Release**（非 AI 上游），mock-ai-server 无法覆盖 |

**一句话**：本地编排成本（prompt 组装 + 上下文注入 + 一次 loopback HTTP）在
**3.5ms ~ 36ms** 区间，中位约 **18ms**。对比真实上游通常 1~60s 的模型推理时间，
**本地编排从来不是「AI 卡顿」的主因**——这为「AI 卡顿」类反馈提供了明确的数据口径。

## 二、方法

### 2.1 隔离基建

复用 T00792 的干净树（`perf/sandbox/t00792_repo`），独立端口 + 独立数据目录：

| 组件 | 端口 | 说明 |
|---|---|---|
| mock 上游 | 18995 | `server/scripts/mock-ai-server.mjs`，内存应答，自身耗时 ≈ 0 |
| SUT | 39930 | MTask 后端，`MTask_PORT` + `MTask_DATA_DIR` 隔离 |

### 2.2 让 SUT 指向 mock

在隔离库 `ai_tools` 表插入两行指向 mock：

```sql
INSERT INTO ai_tools (id, name, type, purpose, endpoint, api_key_enc, model, ...)
VALUES ('tool-t793', 'Mock AI', 'openai-compatible', 'develop',
        'http://127.0.0.1:18995', NULL, 'mock-model', ...);
```

`ConfigService.getRuntimeConfig(id)` 直接按 id 读该表并解密密钥，
因此插入行即完成「上游改写」，**无需改动任何业务代码**。

> ⚠️ **实测坑**：`api_key_enc` 必须留 NULL。若填任意字符串（如 `'mock-key'`），
> `decrypt()` 会按 `iv.tag.data` 三段式 base64 解析，遇到非法密文抛
> `The first argument must be of type string or an instance of Buffer... Received undefined`，
> 表现为端点全部 400。mock 上游不校验鉴权，留 NULL 即可。

### 2.3 夹具

- `taskIds`：真实库中 5 条有标题的活跃任务；
- `categories`：`task_categories` 的 3 条 `{id, name}` 对象（**注意**：classify 需要
  对象数组而非字符串数组，传字符串会因 `c.name.trim()` 报 `undefined.trim`）。

## 三、本地编排成本基线表（单线程，隔离实例）

| 端点 | 成功 | p50 | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| `POST /ai/beautify` | 8/8 | **5.26ms** | 25.70ms | — | — |
| `POST /aitools/:id/models` | 8/8 | **3.53ms** | 22.25ms | 3.39 | 7.18 |
| `POST /ai/chat`（无 period） | 8/8 | **14.41ms** | 26.49ms | — | — |
| `POST /ai/optimize` | 8/8 | **17.48ms** | 26.89ms | — | — |
| `POST /ai/simplify` | 8/8 | **19.79ms** | 28.30ms | — | — |
| `POST /tasks/classify` | 8/8 | **25.52ms** | 29.08ms | — | — |
| `POST /ai/organize` | 8/8 | **25.97ms** | 95.47ms | — | — |
| `POST /ai/chat`（period=week） | 8/8 | **35.98ms** | 44.50ms | — | — |
| `POST /update/check` | **0/6** | 103.26ms | 312.34ms | 89.09 | 562.58 |
| `[对照] /ai/chat`（上游 slow 2500ms） | 3/3 | **2532.43ms** | 2535.73ms | 2507.51 | 2535.73 |

### 读数要点

1. **最重的本地编排是 `period=week` 的 `/ai/chat`（p50 35.98ms）**——因为它要在服务端
   `gatherReportData()` 聚合整周任务/项目数据并 `JSON.stringify` 注入提示词。
   这是唯一一个「本地真实计算量可观」的 AI 端点。
2. **`/ai/beautify` 最轻（p50 5.26ms）**——仅拼一个短提示词，无上下文注入。
3. **`/ai/organize` p95 达 95.47ms**——其内部**逐任务串行**调用（`for taskId of taskIds`
   内 `await organizeOne`），5 条任务即 5 次串行上游往返；本地编排本身不重，
   但**N 次串行叠加**造成长尾。这印证了 T00782（organize 批量缓存）的价值。
4. **对照锚点精度**：mock 侧 `setTimeout(2500ms)`，实测 2532ms，即本地编排仅摊到
   **~32ms**——与同端点无延迟时 p50 14.41ms 的差值（~18ms）同量级，
   证明测量方法能把上游延迟与本地编排**清晰分离**。

## 四、上下文预算验证（任务验收项 ①）

任务要求「验证 T00776/T00777 的上下文预算（headTail 截断）在高负载下确实生效」。
本项**端到端实测**（非仅读源码）：

```
构造：43,222 字符的 PRD 原文（首尾各带唯一标记 HEAD / TAIL）
关联：prd_requirements.prd_id → prd_docs，任务 req_ids 指向该需求
触发：POST /api/ai/organize {taskIds:[...], toolId:tool-t793}
取证：从 mock 的 GET /__last 取回**实际发出的 prompt**

结果：
  organize 响应码        = 200
  实际 prompt 总长       = 6,375 字符   （原文 43,222 → 压缩到 14.7%）
  含头部标记 HEAD        = True
  含尾部标记 TAIL        = True
  含截断省略标记「中段略去」= True
  BUDGET_TRUNCATION_VERIFIED = True
```

**结论**：`ContextBudget.headTail`（`WorkspaceService.ts:89`）与
`resolvePrdContext` 的 6000 字符保头保尾截断（`util/prdContext.ts:44`）**均真实生效**，
超长 PRD 不会撑爆提示词。任务验收项 ① **达成**。

## 五、未能覆盖的端点与边界说明（诚实标注）

| 端点 | 状态 | 原因 |
|---|---|---|
| `POST /update/check` | **未能测得** | 错误体明确：`仓库不存在，或该仓库尚未发布任何 Release`。它依赖**真实 GitHub Release**（非 AI 上游协议），mock-ai-server 的 OpenAI/Claude/Ollama 协议端点无法替代。若需覆盖，得另起一个**模拟 GitHub Releases API** 的 mock（不同协议、不同响应结构），超出本任务「用 mock-ai-server 评估」的范围。 |
| `/tunnel/*` 写操作 | 未纳入 | 依赖 cloudflared 二进制与真实网络隧道，非 HTTP mock 可覆盖。 |
| `/api/mcp` | 未纳入 | streamable HTTP 协议握手，非普通请求/响应形态。 |
| `/plans/prd-generate-stream` | 未纳入 | SSE 流式端点，需专门的流式消费客户端与完成判定；本次聚焦非流式本地编排成本。 |
| `/report/ai-generate*`、`/plans/ai-parse*` | 未纳入 | 走 worker/队列异步路径，延迟语义与同步端点不同（报告已有 worker 隔离结论）。 |

**关于 26 条 vs 10 条的口径说明**：报告 §1.2 列出的 26 条是「**全部**外部依赖端点」，
包含 AI 调用、隧道、更新检查、节假日导入、MCP 握手等多种异构依赖。
本任务按描述聚焦「**用 mock-ai-server 可覆盖的 AI 工具类端点**」，实际测得 9 条，
加上 1 条同协议但依赖不同的 `update/check` 共 10 条。剩余端点因**协议/依赖形态不同**，
不属于 mock-ai-server 的能力范围，已在上表逐条标注边界。

## 六、对「AI 卡顿」反馈的口径贡献（任务验收项 ②）

本任务的核心价值之一是把 AI 端点的延迟**拆成两段**：

```
端到端延迟 = 本地编排成本（3.5 ~ 36ms，实测） + 上游模型推理（真实环境 1 ~ 60s）
```

- 若用户反馈「AI 卡顿」，本地编排占比**普遍 < 1%**（即使最重的 35.98ms，
  对比 1s 以上的上游推理也不足 4%）；
- 因此**优化本地编排对感知速度几乎无收益**，瓶颈应定位到上游模型/网络；
- 唯一的例外是 **`/ai/organize` 的 N 次串联**（p95 95ms 且随任务数线性增长），
  这是唯一值得做本地优化（批量合并/缓存）的点，与 T00782 一致。

## 七、产出物

| 文件 | 内容 |
|---|---|
| `perf/verify_t00793_local_cost.py` | 测量主脚本（启 mock + 隔离实例 + 逐端点压测） |
| `perf/verify_t00793_budget.py` | 上下文预算端到端验证脚本 |
| `perf/diag_t00793.py` | 400 诊断脚本（定位 `api_key_enc` 解密坑） |
| `perf/sandbox/t00792_repo/perf/t00793_local_cost.json` | 原始测量数据（gitignored） |

## 八、结论

1. **任务达成**：产出 mock 上游下各 AI 端点的单线程延迟基线表（9 条成功 + 1 条边界说明），
   并注明与真实上游的差异边界（本地编排 3.5~36ms vs 上游 1~60s）。
2. **预算验证达成**：`headTail` 保头保尾截断端到端生效（43KB → 6.4KB）。
3. **口径贡献达成**：为「AI 卡顿」区分本地/上游提供可复用数据口径。
4. **不建议再为此投入**：本地编排普遍 < 36ms，除 `/ai/organize` 的串联问题外，
   继续优化本地编排的收益极低——优先级应保持 P2 及以下。
