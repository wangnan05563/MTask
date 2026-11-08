# PRD：工作空间隔离的 AI 长期记忆（product 维度）

> 文档类型：产品需求文档（PRD）
> 归属任务：T04120（派生自 T04113 评估）
> 上游文档：`docs/评估报告-工作空间隔离AI长期记忆-T04113.md`（v5，含 v2→v5 全部复审记录）、`docs/记忆提取技能规则规范.md`（T04114，提取行为判据）
> 下游实施单：T04118（Phase 1 MVP）——**本 PRD 是 T04118 的实施基准，两者范围一致**
> 编写时间：2026-11-03（v1.0）；**2026-11-03 v1.1 覆盖度审计修订（T04122）**：补 12 条遗漏需求、修正 D11 与导入模式术语、新增附录 A 追溯矩阵；**2026-11-03 v1.2 源码走查评审修订（T04120 评审）**：补齐 P0–P3 共 17 项缺口（PIP 待确认队列存储、product_key 写入闭环、抽取触发点收敛、作用域解析、项目级开关、检索权重、CORE_TABLES 约束、评审记录存储、执行机制、ChangeBus、索引、tags 约定、Skill 独立任务、注入契约、遥测落点等），详见附录 B 与 §10
> 方案代号：方案 B（`projects.product_key` 文本标签列），选型依据见评估报告 §1.5.4（三方案实测对比）
>
> **术语约定**：导入模式源码名为 `overwrite`（`ImportMode = 'overwrite' | 'keep' | 'merge'`，`SettingsService.ts:18`），即「全量清库后重插」；`keep/merge` 为合并模式。早期版本误写为 `replace`，以本约定为准。

---

## 1. 背景与目标

### 1.1 背景

外部 AI Agent（经 mtask Skill + MCP 处理任务的 WorkBuddy 等）每次开工只能拿到「任务字段 + PRD + 截图 + 摘要」四类上下文，跨任务经验无法积累；同一产品多期项目（wiki 一期/二期/三期）是各自独立的 `projects` 行，一期固化的结论在二期无法复用。MTask 全仓无任何长期记忆逻辑（评估报告 §2.1 实证；`grep product_key` 全仓 `server/src` 零命中已二次证实）。

### 1.2 产品目标

| # | 目标 | 度量 |
|---|---|---|
| G1 | Agent 跨任务/跨期复用已固化结论 | 同产品二期项目开工时能召回一期任务抽取的记忆 |
| G2 | 隔离可靠 | 跨产品零串扰（查询强制 `product_key` 作用域，无作用域请求报错） |
| G3 | 记忆质量可控 | 抽取精度 ≥80%、污染率 =0、注入预算 ≤2k token（提取规范 §10） |
| G4 | 数据不丢失 | 导出/导入（含 `overwrite` 全量恢复）记忆全量往返（不多不少不翻倍）；删项目记忆降级共享不丢失 |

### 1.3 非目标（本期不做）

- 不做跨用户/多用户记忆（单机单用户）；不做云端同步；
- 不做向量检索与语义判重（Phase 2）；不做图结构记忆（评估报告 §1.5.4 方案 C 及 Graphiti 图化均排除/延后）；
- 不做 CLAUDE.md 式「人写规则层」（提取规范 §1：只做自动层 + 人工审查页）；
- 不引入 `products` 字典表与外键（评估报告实测：REFERENCES + DEFAULT '' 被 SQLite 硬拒、导入顺序敏感、级联删陷阱）。

---

## 2. 用户场景

**S1（跨期复用）**：用户在一期项目处理完「PRD 解析 429 限流需退避」的任务后，Agent 回传结论触发自动抽取，落一条 `project` 型记忆。二期项目（同 `product_key`）的新任务开工时，Agent 调 `mtask_query_memories` 召回该记忆，直接采用退避策略，不再踩坑。

**S2（产品标签绑定）**：用户新建「wiki 二期」项目并关联工作空间时，在绑定弹窗（T00771）里选择已有产品标签「Wiki」（或新建），二期项目即与一期共享同一记忆池。

**S3（记忆审查）**：用户在设置 → 数据 → 「记忆管理」页按产品浏览全部记忆，逐条编辑/删除，并查看「被丢弃候选」列表以了解抽取器为何没记某些内容；对「待确认队列」中的疑似敏感候选做确认/驳回。

**S4（换机恢复）**：用户导出数据包在新机 `overwrite` 恢复，记忆随包完整恢复，无静默丢失、无翻倍。

---

## 3. 范围与核心口径

### 3.1 核心对象与统一口径

| 对象 | 口径 |
|---|---|
| **产品标签（product_key）** | 存在 `projects.product_key` 上的**归一化文本标签**（trim + 小写），同值即同一产品；`''` = 未归属。无字典表：候选集由 `SELECT DISTINCT product_key FROM projects WHERE product_key <> ''` 现算 |
| **记忆（memory）** | 一条声明式事实（W1 一事一条），挂 `product_key`（必填）+ 可选 `project_id` 子作用域 |
| **隔离边界** | `product_key` 为**唯一**隔离边界（所有查询强制 `WHERE product_key = ?`）；`project_id` 仅为产品内「本期特有/产品级共享」的子作用域 |
| **四型记忆** | `user` / `feedback` / `project` / `reference`（对齐 Claude 分类），准入门槛与保留期见提取规范 §3.2/§7.1 |

**作用域解析规则（C4 与 MEM-302 的唯一判据，修订 v1.2·F4）**：调用方须先经 `resolveProjectIdOf`（`mcp/server.ts:761`）取得 `product_key` 再查询。两种语义**不可混淆**：
- ① **完全未提供 `productKey` 参数** ⇒ C4 报错（拒绝无作用域全局检索，防止跨产品串扰）；
- ② **解析后 `product_key` 为空串**（项目未绑产品）⇒ 走 MEM-302，返回空集 + `hint` 字段 + HTTP 200，**不报错**（避免 Agent 把「未绑产品」误判为故障）。空串是「显式绑定到无产品」，不是「缺省无作用域」。

### 3.2 与现有轴的关系（防误解）

产品轴与现有 workspace 轴**正交**（评估报告 D6）：workspace 轴 = 同一 `workspace_path` 的多项目（`gitScopePicker.tsx:12` 分组语义）；产品轴 = 同一产品线、跨仓库跨期。产品标签不改变任何现有 workspace 行为。

---

## 4. 功能需求

> 编号 MEM-1xx；「验收」列给出可执行判据。标注 [T04118] = Phase 1 范围内。

### 4.1 数据与存储

| # | 需求 | 验收 |
|---|---|---|
| MEM-101 [T04118] | **列与写入闭环**：① `projects` 增量补列 `product_key TEXT DEFAULT ''` 与 `memory_auto_extract INTEGER NOT NULL DEFAULT 1`（均 `ensureColumn`，**不带 REFERENCES**）；② 创建/编辑 handler（`api.post('/projects')` routes/index.ts:167、`api.patch('/projects/:id')` :336）接受并持久化 `product_key`（经归一化 trim+小写）；③ 前端 T00771 绑定弹窗与项目编辑区「补绑」UI 给出产品标签输入/下拉。**老库启动自动补列；存量项目读出 `''`** | ① 老库启动自动补列；② 创建/补绑后 `SELECT product_key FROM projects WHERE id=?` 命中归一化值；③ 前端弹窗可写入并回显 |
| MEM-102 [T04118] | 新建 `memories` 表，字段 = 评估报告 §3.1 DDL **加修正三列**：`invalidated_at TEXT`、`superseded_by TEXT`（INVALIDATE 动作落点）、`source_kind CHECK IN ('auto','manual','user_said','tool_output','inferred')`（与提取规范 §5.3 枚举统一）；不设任何外键；`tags` 以 JSON 数组文本存储（见 MEM-502 约定） | DDL 与行为判据/门断言三方一致；非法 `source_kind` 被拒 |
| MEM-103 [T04118] | 索引：`idx_memories_product(product_key)`、`idx_memories_product_type(product_key,type)`、`idx_memories_project(project_id)`、**`idx_memories_product_project(product_key, project_id)`**（承载 MEM-301 的 `project_id IS NULL OR project_id=?` 合并查询，修订 v1.2·F12） | EXPLAIN 命中索引 |
| MEM-104 [T04118] | **三张顺序表全覆盖**：`memories` 同时加入 `SettingsService` 的 `EXPORT_TABLES`（`:54`）、`INSERT_ORDER`（`:52`）**与 `DELETE_ORDER`（`:51`）**——`overwrite` 模式先按 `DELETE_ORDER` 清库（`:280`）再按 `INSERT_ORDER` 重插（`:282`），`keep/merge` 才遍历 `EXPORT_TABLES`（`:290`）。**硬约束（修订 v1.2·F7）：`memories` 不得加入 `CORE_TABLES`（SettingsService.ts:182）**——误加会导致 `validateBundle` 拒绝不含 memories 的旧备份。**漏任一张即出问题**：漏 `EXPORT_TABLES` ⇒ 导出不含记忆；漏 `INSERT_ORDER` ⇒ 清空后不恢复（记忆丢失）；漏 `DELETE_ORDER` ⇒ 旧记忆残留 + 新记忆再插（记忆翻倍）。无 FK ⇒ 三张表内**均无顺序敏感性**，位置任意 | overwrite 恢复后记忆行数与导出前**完全一致**（不多不少）；keep/merge 恢复后按主键 upsert 不产生重复行；旧备份文件（无 memories key）仍可导入 |
| MEM-105 [T04118] | **项目删除钩子**：`DELETE /projects/:id`（`routes/index.ts:510`）删项目前执行 `UPDATE memories SET project_id=NULL WHERE project_id=?`（应用层实现 v2 时代 FK SET NULL 语义——记忆降级为产品级共享，不丢失）；删除不进行任何记忆物理删除 | 删项目后其特有记忆仍在，`project_id` 为 NULL 且可被同产品其他期召回 |
| MEM-106 [T04118] | **project_id 引用校验**：`mtask_save_memory`/REST POST 带 `projectId` 时校验项目存在（无 FK 后防孤儿行） | 传不存在 projectId → 报错不落库 |
| MEM-107 | 产品标签重命名/合并：`ProductTagService.rename(old,new)` 在**同一事务**内批量 UPDATE `projects.product_key` 与 `memories.product_key`（均归一化），防止旧 key 记忆悬空。**联合场景验收（修订 v1.2·F10）**：① new key 已存在于他项目（merge 语义）需定义冲突处理与遥测；② 与 MEM-105（删项目 set NULL）+ MEM-108（孤儿清理）的联合：删项目导致某 product_key 变孤儿后，MEM-108 立即可见 | 重命名后旧 key 在 projects + memories 双表零残留；联合场景行为确定（无悬空、无重复计数） |
| MEM-108 | 孤立标签清理：管理页展示「已无项目引用但仍有记忆」的 product_key，提供「删除该标签全部记忆」或「挂回某项目」操作，均需 `askConfirm` 二次确认 | 孤立标签可见、操作留痕 |
| MEM-109 [T04118] | **PII 待确认队列存储（修订 v1.2·F1）**：新建 `memory_review_queue` 表（无 FK），承接「疑似敏感但待人工确认」的候选（规范 §6.1）。`memoryGuard` 命中个人敏感类（身份证/手机号/银行卡/住址）时，**不入库 `memories`、不静默丢弃**，而是写入本表待确认；用户确认后转 `ADD` 入 `memories` 并删本表行，驳回则直接删本表行 | 构造含手机号的候选 ⇒ 不自动入库、本表出现该条；确认后入 memories、本表清空 |

### 4.2 抽取（写入侧）

| # | 需求 | 验收 |
|---|---|---|
| MEM-201 [T04118] | **抽取触发点收敛（修订 v1.2·F3）**：任务结论落库时异步 fire-and-forget 触发 `MemoryService.extract`。触发统一挂在 `TaskService.update` 的 `handle_result` 变更检测分支（`TaskService.ts:675` `patch.handle_result !== undefined && patch.handle_result !== before.handle_result`），**覆盖 MCP `mtask_update_task_result`（server.ts:1060）与 Web `PATCH /tasks/:id`（routes/index.ts:1026）两条入口**；主链路不等待；抽取前读取 `projects.memory_auto_extract` 开关（MEM-101③）与产品绑定态（MEM-204）。**抽取失败仅记遥测，绝不回滚/报错主任务链路** | 经 MCP 与经 Web 编辑结论均触发抽取；任务回传响应时间无可测退化；抽取异常不影响主任务 |
| MEM-202 [T04118] | 提取行为全量遵循 `docs/记忆提取技能规则规范.md`：六段流程（候选→准入 Q1-Q7→禁记→动作四分类→写法 W1-W8→落库+遥测）、中文提示词模板（规范 §9）、`dropped[]` 丢弃原因回报 | 门脚本 `scripts/verify-t04114-memory-rules.mts` 全部断言通过（规范 §10.3 六条） |
| MEM-203 [T04118] | 代码强制四项：C1 never-store 正则+字段黑名单（`util/memoryGuard.ts`）；C2 单次回传 ≤5 条；C3 置信度 <0.7 不入库；C4 查询强制作用域（见 §3.1 作用域解析规则） | 规范 §10.3 对应断言通过 |
| MEM-204 [T04118] | 未绑产品项目**不启用**自动抽取，计遥测（不静默失败）；`memory_auto_extract=0` 的项目也不抽取；手动录入不受限 | 抽取遥测可见未归属计数与开关关闭计数 |
| MEM-205 | 归档/沉淀项目（`archived`/`history_at`）的任务如被回传处理，仍可抽取——**记忆可见性与项目现行态解耦**（D4） | 归档项目的结论可正常落库 |
| MEM-206 [T04118] | **抽取源分区映射**（规范 §3.3）：按 `handle_result` 的「根因 / 修复 / 验证」三段分别抽取，`## 下一步建议` 段**默认不抽取**（是待办不是记忆）；段缺失时跳过而非报错 | 构造含四段结论的样例，断言仅前三段产生候选、建议段候选数=0 |
| MEM-207 [T04118] | **抽取幂等**：同一 `source_task_id` 重复回传**不得**产生重复记忆行——抽取前按 `source_task_id` 查既有抽取记录（记忆行 + 遥测表）已存在则跳过重抽（规范 §4.1 第 0 步） | 同一任务连续回传 3 次 ⇒ memories 中该来源行数不增；遥测记「跳过(幂等)」 |
| MEM-208 [T04118] | **写法校验重写限次**：W1–W8 自检不通过时**最多重写 1 次**，仍不合则丢弃并记 `dropped`（规范 §5.1 落点，防死循环） | 构造持续违规候选 ⇒ 恰好 1 次重写后丢弃，无无限循环 |
| MEM-209 [T04118] | **疑似敏感内容人工确认**：never-store 命中「个人敏感」类（身份证/手机号/银行卡/住址）时不直接丢弃，而转入**待确认队列**（`memory_review_queue`，MEM-109），由用户在记忆管理页确认后才入库（规范 §6.1「敏感模式识别 + 人工确认」） | 构造含手机号的候选 ⇒ 不自动入库，待确认队列出现该条；用户确认后入库 |
| MEM-210 [T04118] | **Skill 侧协作约定（须作为独立任务单列，修订 v1.2·F14）**：记忆不会自动进入上下文——须在 mtask Skill 文档中约定「Agent 开工前调用 `mtask_query_memories(productKey, [projectId])` 取回记忆并注入 system prompt」，并把「不查询记忆」列为任务回传/开工流程的显式步骤。**本项须作为独立任务（新 T 号，如 T0412x「mtask Skill 增加记忆查询注入步骤」）单列跟踪，并计入 Phase 1 完成判据**——其验收「实测 Agent 开工路径确实发起记忆查询调用」是 Phase 1 发布的硬门之一。Skill 改造完成前提供降级方案：在 PRD/规范中给出 system prompt 注入模板说明，保证即便 Skill 未及时更新，记忆也可经手动/模板方式注入 | 独立任务已建并链入 Phase 1；Skill 文档含该步骤；实测 Agent 开工路径确实发起记忆查询调用（或降级模板可用） |

### 4.3 查询（读取侧）

| # | 需求 | 验收 |
|---|---|---|
| MEM-301 [T04118] | `mtask_query_memories(productKey, [projectId], type?, query?, limit?)`：按 §3.1 作用域解析规则强制作用域，结果合并「产品级共享（`project_id IS NULL`）+ 本期特有（`project_id = 当前项目`）」；`limit` 默认 10 硬上限 20；`queryForContext` ≤2k token 截断；已失效行（`invalidated_at` 非空）默认不召回 | C4 断言：完全缺省 productKey ⇒ 报错非全量；空串 productKey ⇒ 走 MEM-302 |
| MEM-302 | **未绑产品项目的查询行为**：解析后 `product_key` 为空串时返回**空集 + 提示「该项目未绑定产品标签」（`hint` 字段）+ HTTP 200**（不报错——Agent 拿到报错会误判为故障），见 §3.1 ② | 未绑产品项目查询返回 ok + 空列表 + hint 字段 |
| MEM-303 | 检索排序：type 权重 → **溯源权重**（`user_said` = `manual` > `auto` > `inferred` > `tool_output`，规范 §6.3 防线二，**修订 v1.2·F6 补 `manual` 排序——人工录入不弱于用户陈述**）→ 未访问时长降权（§7.2）→ recency；失效行排除；`tags` 过滤按 JSON 文本 `LIKE '%"kw"%'`（修订 v1.2·F13） | 可复现排序断言；manual 与 user_said 同档 |
| MEM-304 | 注入隔离：召回记忆以独立 `<memory-context>` 参考块注入提示词，不拼进指令块（提取规范 §6.3 防线三）。**格式契约（修订 v1.2·F15）**：`queryForContext()` 产出独立 `<memory-context>` 块（含 memory id/type/title/content，按 ≤2k token 截断），**不拼进指令块、不拥有指令权限**；Agent 侧消费方式见 MEM-210 注入步骤 | 注入块格式断言；指令块不含记忆内容 |
| MEM-305 | **分型保留期与复核**（规范 §7.1，Phase 2）：`project` 型 180 天到期标「需复核」并降权（仍可召回），`user`/`feedback`/`reference` 无固定 TTL；到期判定基于 `updated_at` + 绝对日期（规范 §3.3 的时间锚），不引入第五型。**执行机制（修订 v1.2·F9）：「需复核」标记于查询时惰性计算（基于 updated_at + 绝对日期，无调度依赖、便宜）** | 到期条目召回时带「需复核」标记且排序降权 |
| MEM-306 | **容量上限与淘汰**（规范 §7.3，Phase 2）：单产品记忆上限 200，超限按 `access_count` 最低 / `updated_at` 最旧淘汰；淘汰走 INVALIDATE 软失效而非物理删除。**执行机制（F9）：容量评估在查询/写入触发时计算** | 超限后自动降权/失效最旧条目，并留审计链 |
| MEM-307 | **月度整理任务**（规范 §7.3，Phase 3）：定期合并近重复记忆、清理「无人遵守的规则」、归档已完结任务导出的记忆；整理动作全部走 UPDATE/INVALIDATE，不物理删除。**执行机制（F9）：挂 `RecurringService.tick`（server/index.ts:283 每小时间隔 + 启动 tick）注册周期任务，复用既有调度基础设施，不新建调度** | 整理脚本可重复执行且幂等 |

### 4.4 MCP 与 REST 接口

| # | 需求 |
|---|---|
| MEM-401 [T04118] | MCP 工具六件（另加待确认队列一件，共七件）：`mtask_save_memory` / `mtask_query_memories` / `mtask_list_memories` / `mtask_update_memory` / `mtask_delete_memory` / `mtask_list_product_tags` / **`mtask_list_pending_memories`**（读 `memory_review_queue`，MEM-109）；字段定义见评估报告 §3.3；项目定位复用 `resolveProjectIdOf`（`mcp/server.ts:761`），产品标签按归一化解析 |
| MEM-402 [T04118] | REST `/memories` CRUD（委托 MemoryService），含 `/memories/pending`（GET 待确认队列）、`POST /memories/:id/confirm`（确认入 memories）、`POST /memories/:id/reject`（驳回），供前端管理页 |
| MEM-403 [T04118] | 管理类操作（list/update/delete）均带 `productKey` 作用域校验（按 §3.1 规则）；物理删除仅由管理页/显式 MCP 删除提供，自动流程只 INVALIDATE |

### 4.5 前端

| # | 需求 |
|---|---|
| MEM-501 [T04118] | 新建/关联工作空间流程（T00771 绑定弹窗，`TasksPage.tsx:1703`）：加「产品标签」栏——下拉选已有（`mtask_list_product_tags` 数据源）或新建；存量项目在项目编辑区补绑（后端落点见 MEM-101②） |
| MEM-502 [T04118] | 设置 → data 组加「记忆管理」页签（`settingsTabs.ts:39-49`，需将 `'memory'` 加入 `SettingsTabKey` 闭合联合并在渲染 switch 补分支），`MemoryTab.tsx` 仿 `ApiTokensTab`：按产品为顶层维度列表（类型徽标/标题/摘要/标签/作用域/来源任务/更新时间/访问次数 + 失效标记）、新增/行内编辑/删除二次确认、按类型/关键词/作用域/丢弃原因筛选；**`tags` 按 JSON 数组展示与过滤（修订 v1.2·F13）** |
| MEM-503 | 隔离可见性：UI 标注「本页记忆仅属于产品 X」，跨产品操作置灰 |
| MEM-504 | 自动抽取开关（项目级，绑定 `projects.memory_auto_extract`，MEM-101③）+ 丢弃原因审查视图（§3.4 第 8 项）+ **待确认队列**（MEM-209 转入的疑似敏感内容，确认后才入库，读 `memory_review_queue`） |
| MEM-505 | 产品标签重命名入口（MEM-107）+ 孤立标签清理入口（MEM-108） |

### 4.6 遥测与验收门

| # | 需求 |
|---|---|
| MEM-601 [T04118] | 抽取遥测：抽取数/拒绝数/动作分布/丢弃原因分布，复用 `ai_usage`/`ai_card_provenance` 范式。**落点（修订 v1.2·F16）：扩展 `ai_usage`（新增 `card_key='memory_extract'` 行，并扩展结构化字段 `memory_action`/`memory_dropped_reason`/`memory_source_kind`），或独立 `memory_extract_log` 表；`dropped[]` 原因（Q1–Q7/禁记项文本）需结构化落库以支持拒杀率统计（MEM-604）** |
| MEM-602 | 门脚本 `scripts/verify-t04114-memory-rules.mts`（接 `gate-boot.mts`）：提取规范 §10.3 六组断言（展开 8 条）+ MEM-104/105/207 断言 |
| MEM-603 [T04118] | **质量指标达标线**（规范 §10.1，作为 Phase 1 验收判据）：抽取精度 ≥80%、召回 ≤15%、污染率 =0、矛盾率 =0（INVALIDATE 生效）、注入 ≤2k token；「精度/召回」以每批随机抽 20 条人工评审（规范 §10.2）测得——首版可只报数不阻断，但**污染率=0 与矛盾率=0 为硬门**（不达标即阻断发布） | 门脚本断言污染率/矛盾率为 0；遥测可导出精度/召回抽样结果 |
| MEM-604 | **抽样评审规程**（规范 §10.2，Phase 2 常态化）：每批抽取随机抽 20 条人工评审，判定「不值得记」须记下命中的判据编号（Q1–Q7 / W1–W8 / 禁记项）；**连续两批同一判据拒杀率 > 40% → 该判据需重写**（不靠放宽阈值掩盖）；样本与标注留档作回归基线 | 评审记录可导出（见 MEM-606）；判据拒杀率统计可用 |
| MEM-605 | **抽取成本与并发约束**（非功能落到需求）：每次抽取 1 次 LLM 调用（`AIService.askJson`）+ 至多 1 次重写 ⇒ 单任务最多 2 次调用；抽取并发上限（建议 1，同产品串行）以免挤占 AI 配额 | 单任务抽取的 AI 调用数 ≤2；并发不超限 |
| MEM-606 [T04118] | **抽样评审记录存储（修订 v1.2·F8）**：新增 `memory_review_log` 表，承载评审样本+标注+判定（`verdict`/`hit_rule`/`reviewer`），可导出作回归基线（规范 §10.2），供 MEM-604 拒杀率统计 | 评审记录可结构化查询与导出 |

---

## 5. 数据模型

见评估报告 §3.1 DDL **经 MEM-102 修正后的版本**（以本 PRD 为准）：

```sql
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  product_key      TEXT NOT NULL,      -- 归一化产品标签；隔离/共享单元
  project_id       TEXT,               -- 可选子作用域；NULL=产品级共享
  type             TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  tags             TEXT,               -- JSON 数组文本（如 '["限流","429"]'）；过滤见 MEM-502/303
  source_task_id   TEXT,
  source_kind      TEXT NOT NULL DEFAULT 'auto'
                     CHECK(source_kind IN ('auto','manual','user_said','tool_output','inferred')),
  confidence       REAL,               -- 抽取置信度（C3 阈值 0.7）
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  invalidated_at   TEXT,               -- INVALIDATE 动作：软失效时间戳（NULL=有效）
  superseded_by    TEXT,               -- 取代本条的既有/新记忆 id（审计链）
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- v1.2·F1：PII 待确认队列（无 FK）；确认→转 memories 并删本行，驳回→删本行
CREATE TABLE IF NOT EXISTS memory_review_queue (
  id            TEXT PRIMARY KEY,
  product_key   TEXT NOT NULL,
  project_id    TEXT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  type          TEXT NOT NULL CHECK(type IN ('user','feedback','project','reference')),
  pii_kind      TEXT,                  -- 命中敏感类型：id/phone/bank/address
  source_task_id TEXT,
  source_kind   TEXT NOT NULL DEFAULT 'auto'
                   CHECK(source_kind IN ('auto','manual','user_said','tool_output','inferred')),
  confidence    REAL,
  created_at    TEXT NOT NULL
);

-- v1.2·F8：抽样评审记录（Phase 2 启用）
CREATE TABLE IF NOT EXISTS memory_review_log (
  id         TEXT PRIMARY KEY,
  batch_id   TEXT,                     -- 评审批次
  memory_id  TEXT,                     -- 被评记忆 id（或 'candidate:<id>'）
  verdict    TEXT NOT NULL CHECK(verdict IN ('worth','not_worth','poor_writing')),
  hit_rule   TEXT,                     -- 命中判据编号 Q1-Q7/W1-W8/禁记项
  reviewer   TEXT,
  created_at TEXT NOT NULL
);
```

> `projects.product_key`（MEM-101①，另含 `memory_auto_extract INTEGER NOT NULL DEFAULT 1`）由 `ensureColumn` 补列。**全表无外键**（选型实测依据：评估报告 §1.5.2 T2/T4/T5）。

---

## 6. 非功能需求

| 类别 | 要求 |
|---|---|
| 性能 | 抽取异步不阻塞任务回传；单产品记忆 ≤200 条容量控制；查询 O(log n)；注入 ≤2k token |
| 成本 | 单任务抽取的 LLM 调用 ≤2 次（抽取 1 + 重写 ≤1）；同产品抽取串行，避免挤占 AI 配额（MEM-605） |
| 安全 | C1 禁记代码拦截（污染率=0）；`<memory-context>` 注入隔离；跨产品零串扰；记忆明文存储（业务数据非密钥）但纳入导出/备份；PII 候选先入 `memory_review_queue` 不落 `memories` |
| 兼容 | 老库自动补列；旧备份可导入（`memories` 不进 `CORE_TABLES`，见 MEM-104 硬约束）；`ChangeKind` 封闭联合需扩 `'memories'`（`ChangeBus.ts:13`），**且 memory 写路径提交后 `notifyChange('memories')`、MemoryTab 订阅 `/events` 实时刷新（修订 v1.2·F11）** |
| 可观测 | 抽取成功率/丢弃原因/未归属计数/开关关闭计数遥测；门脚本可重复执行 |

---

## 7. 里程碑

| 阶段 | 范围 | 任务 |
|---|---|---|
| **Phase 1 MVP** | MEM-101~106、**109**、**206~210**、201~204、301/302、401~403（+`mtask_list_pending_memories`）、501/502/504、**601/603/605/606** + 提取规范落地 + 门脚本 MEM-602 + **mtask Skill 改造独立任务（MEM-210 单列，计入 Phase 1 完成判据）** | T04118 |
| **Phase 2 增强** | MEM-107/108、205、303、503/505、**305/306**、**604** + 语义判重（FTS5）、反思补漏、相关性排序 | 待建 |
| **Phase 3 完善** | **307**（月度整理，挂 RecurringService.tick）、记忆跨任务关联、图化评估（视「跨记忆聚合」需求出现与否） | 待建 |

---

## 8. 开放问题（不阻塞 Phase 1）

1. **`project` 型 180 天到期复核**的提醒形态（管理页徽标 vs 定时报告）——需求已落 MEM-305（Phase 2），形态待定；
2. **置信度 0.7 与拒杀率**的调参依据依赖 Phase 1 遥测数据积累（评审规程见 MEM-604）；
3. **产品标签是否需要描述/别名**（现方案仅一个归一化名）——出现真实重名冲突再评估；
4. mem0「上下文丰富」写法是否对 `user` 型放宽（提取规范 §12.1 保留项）——待 `user` 型记忆积累后评审；
5. **（v1.2 新增）PII 待确认队列积压上限**——若长期不消费会无限增长，建议设上限或「超过 N 条提示清理」，具体阈值 Phase 1 实测后定。

---

## 9. 实施风险与对策（v1.2 评审增补）

| 风险 | 对策 |
|---|---|
| 抽取触发点遗漏 Web 入口（原 MEM-201 仅写 MCP） | 收敛到 `TaskService.update` 变更分支（F3） |
| product_key 补列后无写入落点，功能形同虚设 | MEM-101 补齐 handler + 前端（F2） |
| PII 待确认无存储，MEM-209 不可落地 | 新增 `memory_review_queue`（F1） |
| 误将 memories 加入 CORE_TABLES 致旧备份不可导入 | MEM-104 硬约束（F7） |
| Skill 不改造则记忆「建好不用」 | MEM-210 单列独立任务 + 降级模板（F14） |
| 异步抽取失败污染主任务 | MEM-201 明确「失败仅记遥测，不回滚主链路」 |

---

## 10. 评审修订溯源（v1.2）

本版依据 `docs/评审-PRD工作空间隔离AI长期记忆.md`（T04120 评审）的 P0–P3 共 17 项发现修订，逐条映射：

| 评审发现 | 严重度 | PRD 落点 |
|---|---|---|
| F1 PII 待确认队列无存储 | 🔴 P0 | 新增 MEM-109 + §5 `memory_review_queue` + MEM-401/402/504 |
| F2 product_key 写入路径未闭环 | 🔴 P0 | MEM-101 补 ②③（handler + 前端） |
| F3 抽取触发点过窄 | 🔴 P0 | MEM-201 改写（收敛到 TaskService.update 变更分支） |
| F4 C4 与 MEM-302 边界冲突 | 🟠 P1 | §3.1 作用域解析规则 + MEM-301/302 验收 |
| F5 项目级开关缺存储 | 🟠 P1 | MEM-101① 补 `memory_auto_extract` 列 + MEM-201/504 |
| F6 source_kind 权重漏 manual | 🟠 P1 | MEM-303 权重补全 |
| F7 CORE_TABLES 约束未写入 | 🟠 P1 | MEM-104 硬约束 |
| F8 评审记录缺存储 | 🟡 P2 | 新增 MEM-606 + §5 `memory_review_log` |
| F9 TTL/容量/整理执行机制 | 🟡 P2 | MEM-305/306/307 执行机制说明 |
| F10 rename 联合场景 | 🟡 P2 | MEM-107 联合场景验收 |
| F11 ChangeBus SSE 集成 | 🟡 P2 | §6 兼容补 notifyChange + 订阅 |
| F12 索引对 OR 查询 | 🟢 P3 | MEM-103 补 `idx_memories_product_project` |
| F13 tags 解析约定 | 🟢 P3 | MEM-502/303 tags 约定 |
| F14 Skill 独立任务 | 🟢 P3（发布风险） | MEM-210 单列独立任务 + 降级模板 |
| F15 注入格式契约 | 🟢 P3 | MEM-304 格式契约 |
| F16 遥测落点 | 🟡 P2 | MEM-601 落点说明 |
| F17 附录笔误 | ⚪ | 附录 A 阶段标注细化 |

---

## 11. 附录 A：提取规范 → PRD 需求追溯矩阵

> 本表回答「规范里的每一条内容，是否在 PRD 里有任务体现」。**空白格 = 需求遗漏，已在本轮评审补齐并标注**。阶段列 P1/P2/P3 = Phase 1/2/3。

| 规范条目 | 关键要求 | PRD 需求 | 阶段 | 状态 |
|---|---|---|---|---|
| §3.1 Q1–Q7 | 七问准入判据 | MEM-202 | P1 | ✅（笼统引用判据全文） |
| §3.1 取舍 | 保守侧（宁缺勿滥），阈值 0.7 | MEM-203（C3）+ MEM-603 | P1 | ✅ |
| §3.2 四型准入门槛 | user/feedback/project/reference 各自门槛 | MEM-202 + MEM-102（CHECK） | P1 | ✅ |
| §3.3 **分区抽取映射** | 根因/修复/验证三段抽取；下一步建议不抽 | **MEM-206** | P1 | 🆕 v1.1 补 |
| §3.3 时间锚 | 锚点=任务完成时刻 | MEM-202 | P1 | ✅ |
| §4 动作四分类 | ADD/UPDATE/INVALIDATE/NOOP | MEM-202 + MEM-102（软失效列） | P1 | ✅ |
| §4.1 **幂等** | 同一来源重复抽取不产生重复行 | **MEM-207** | P1 | 🆕 v1.1 补 |
| §4.3 **信息量更大判据** | 五项死规则 | MEM-202 | P1 | ✅（写入提示词模板） |
| §5.1 W1–W8 | 写法八条硬要求 | MEM-202 | P1 | ✅ |
| §5.1 **重写限次** | 违规最多重写 1 次，防死循环 | **MEM-208** | P1 | 🆕 v1.1 补 |
| §6.1 never-store | 凭据/连接串/密文/大块原文 | MEM-203（C1） | P1 | ✅ |
| §6.1 **敏感人工确认** | 个人敏感类转待确认队列 | **MEM-209** + MEM-109（队列存储）+ MEM-401/402/504 | P1 | 🆕 v1.1 补条目；**v1.2 补存储落点（F1）** |
| §6.2 C1–C4 | 四项代码强制 | MEM-203 | P1 | ✅ |
| §6.3 防线一 | 只存声明式事实，不存原文 | MEM-202（提示词）+ MEM-203 | P1 | ✅ |
| §6.3 防线二 | **溯源标记 + 检索加权** | MEM-102（`source_kind`）+ **MEM-303（含 manual，P1）** | P1 | 🆕 v1.1 补加权；**v1.2 补 manual（F6）** |
| §6.3 防线三 | 注入隔离（独立参考块） | MEM-304（含格式契约，v1.2·F15） | P1 | ✅ |
| §6.3 防线四 | 写前限流 + 人工审查 | MEM-203（C2）+ MEM-502 | P1 | ✅ |
| §6.3 **作用域强制 C4 与未绑项目** | 无作用域报错；未绑项目返回空+提示 | MEM-203 + **§3.1 作用域解析规则 + MEM-301/302（v1.2·F4）** | P1 | 🆕 v1.2 补边界厘清 |
| §7.1 **分型 TTL + 需复核** | project 180 天标「需复核」降权 | **MEM-305**（含惰性执行机制，v1.2·F9） | P2 | 🆕 v1.1 补；v1.2 补机制 |
| §7.2 访问衰减 | 按未访问时长降权 | MEM-303 | P1 | ✅ |
| §7.3 **容量上限/淘汰** | 单产品 200 条上限 | **MEM-306**（含触发机制，v1.2·F9） | P2 | 🆕 v1.1 补；v1.2 补机制 |
| §7.3 **月度整理** | 合并近重复、清理无人遵守的规则 | **MEM-307**（挂 RecurringService.tick，v1.2·F9） | P3 | 🆕 v1.1 补；v1.2 补机制 |
| §9 提示词模板 | 中文模板 + `dropped[]` | MEM-202 | P1 | ✅ |
| §10.1 **六项质量指标** | 精度≥80%/召回≤15%/污染率0/矛盾率0/陈旧率≤10%/注入≤2k | **MEM-603** | P1 | 🆕 v1.1 补 |
| §10.1 **遥测落点** | 丢弃原因等结构化 | **MEM-601（v1.2·F16）** | P1 | 🆕 v1.2 补 |
| §10.2 **抽样评审规程** | 随机抽 20 条、记判据编号、拒杀率>40% 重写判据、留档 | **MEM-604** + **MEM-606（记录存储，v1.2·F8）** | P2 | 🆕 v1.1 补条目；v1.2 补存储 |
| §10.3 门断言 | 六组（展开 8 条）自动化断言 | MEM-602 | P1 | ✅ |
| §11 落点对照 | memoryGuard.ts / 提示词常量 / 门脚本 / ChangeBus | MEM-203 / MEM-202 / MEM-602 / PRD §6（含 notifyChange，v1.2·F11） | P1 | ✅ |
| §12 改造点 | 原子 vs 上下文、图结构、三层记忆、软失效 | 说明性；MEM-305/306/307 + MEM-102 承接 | P1–P3 | ✅ |

**评估报告 → PRD 覆盖**：§3.1 数据模型 → PRD §5（权威版）+ MEM-101/102/109；§3.2 提取流程 → MEM-201/206；§3.3 MCP 七工具 → MEM-401（含待确认队列一件）；§3.4 前端页 → MEM-501/502/504；§4.1 性能 → PRD §6；§4.2 安全 → MEM-203/304 + PRD §6；§5 路线图 → PRD §7；§1.5 复审缺陷 D1–D11 → D1→MEM-204、D2/D7/D11→MEM-104、D3→MEM-105、D4→MEM-205、D5→MEM-307（时区随产品标签收敛）、D6→PRD §3.2、D8→MEM-105、D9/D10→MEM-102。**无悬空项。**

---

## 12. 附录 B：文档评审记录

| 版本 | 日期 | 评审人 | 结论 |
|---|---|---|---|
| v1.0 | 2026-11-03 | T04120 | 初版：24 条功能需求 + 权威 DDL，作为 T04118 实施基准 |
| **v1.1** | 2026-11-03 | **T04122** | **覆盖度审计：补 12 条遗漏需求（MEM-206~210、303、305~307、603~605）；修正 D11（三张顺序表）与术语（overwrite 非 replace）；新增附录 A 追溯矩阵。结论：规范条目已 100% 有 PRD 落点** |
| **v1.2** | 2026-11-03 | **T04120 评审（源码走查）** | **按 P0–P3 共 17 项发现修订：补 PII 待确认队列存储（MEM-109 + `memory_review_queue`）、product_key 写入闭环（MEM-101 ②③）、抽取触发点收敛（MEM-201→TaskService.update）、作用域解析规则（§3.1）、项目级开关列、source_kind 权重补 manual、CORE_TABLES 硬约束、评审记录存储（MEM-606 + `memory_review_log`）、TTL/容量/整理执行机制、ChangeBus SSE、索引、tags 约定、MEM-210 独立任务 + 降级模板、注入格式契约、遥测落点。结论：Phase 1 实施阻断性缺口已全部闭合** |
| **v1.2 实施验收** | 2026-11-05 | T04174 | 逐项核对 17 项修订的落地证据：F1 PII 待确认队列（T04137）、F2 product_key 写入（T04132）、F3 触发点收敛（T04143）、F4 作用域解析（T04134）、F5 项目开关列（T04127）、F6 manual 权重（T04148）、F7 CORE_TABLES 约束（T04130）、F8 评审记录（T04158）、F9 执行机制（T04150）、F10 标签联合场景（T04139/T04154）、F11 ChangeBus SSE（T04171）、F12 索引、F13 tags 约定（T04148）、F14 Skill 独立任务（T04147）、F15 注入契约（T04149）、F16 抽取遥测（T04143）、F17 附录 A 校准。结论：**17 项全部闭合，无遗留阻断项**（附录 A 29 行规范条目 100% 有 PRD 落点） |
