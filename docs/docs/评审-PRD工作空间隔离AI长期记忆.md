# PRD 评审：工作空间隔离的 AI 长期记忆（product 维度）

> 评审对象：`docs/PRD-工作空间隔离AI长期记忆.md`（v1.1，2026-11-03，T04120 / T04122）
> 评审基线：`docs/系统架构设计文档.md`（T04079）、`docs/记忆提取技能规则规范.md`（T04114）、`docs/评估报告-工作空间隔离AI长期记忆-T04113.md`（v5）
> 评审方式：静态走查 PRD + 对照 `server/src`、`web/src` 当前源码逐条核实（非仅看文档自洽）
> 评审日期：2026-11-03

---

## 0. 总体结论

**评级：有条件通过（Conditional Pass）。** 方案选型（方案 B：`projects.product_key` 文本标签、无外键）经源码与 SQLite 实测，规避了外键级联陷阱，技术方向正确；提取规则规范与 PRD 的追溯矩阵（附录 A）覆盖度到位；SettingsService 的三张顺序表机制真实存在且对无 FK 表支持任意插入位置。

但 **Phase 1 实施基准（T04118）在「存储模型」与「写入路径闭环」两处存在硬性缺口**，会导致 MEM-209/MEM-504、MEM-101 的部分验收无法落地。此外抽取触发点过窄（仅 MCP 路径）、C4 与 MEM-302 边界未厘清、项目级开关与 PII 待确认队列缺存储，均需在进入 T04118 编码前补齐。

**建议：在 T04118 编码启动前，先修订本 PRD（补 F1/F2/F3/F4/F5/F6 共 6 项），其余 F7–F17 可在实施中顺带收口或列入 Phase 2/3。**

---

## 1. 需求完整性

### 1.1 已覆盖良好

| 维度 | 评价 |
|---|---|
| 方案选型 | 方案 B 经 `ensureColumn` 实测（`schema.ts` 用 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`，无 REFERENCES），与外键陷阱（评估报告 T2/T4/T5）的复盘一致，正确 |
| 导出/导入完整性 | MEM-104 三张顺序表（`EXPORT_TABLES`/`INSERT_ORDER`/`DELETE_ORDER` 在 `SettingsService.ts:54/52/51` 真实存在，overwrite 走 `:280` 删 + `:282` 插、keep/merge 走 `:290` EXPORT_TABLES）机制描述准确 |
| 规则规范追溯 | 附录 A 矩阵把规范 §3–§12 逐条映射到 MEM 编号 + 阶段，覆盖率经 T04122 审计补齐，无悬空 |
| DDL 前瞻性 | `access_count`/`last_accessed_at`/`invalidated_at`/`superseded_by` 已在 Phase 1 DDL 预留，兼容 Phase 2/3 |
| 门脚本范式 | MEM-602 接 `gate-boot.mts` 的写法与仓内既有门脚本实证一致 |

### 1.2 缺口清单（按严重度）

| 编号 | 严重度 | 涉及 PRD | 缺口描述 |
|---|---|---|---|
| **F1** | 🔴 阻断 | MEM-209 / MEM-504 | **PII 待确认队列无存储模型**。规范 §6.1 要求「个人敏感类（身份证/手机号/银行卡/住址）转人工确认队列，不自动入库、不静默丢弃」，MEM-504 也要求管理页「待确认队列」入口。但 §5 DDL 只有 `memories` 一张表，**没有任何表/列承接这些「待确认候选」**——`memories` 行本身若未确认则不应存在，`memoryGuard` 又不存储。落地无法实现。 |
| **F2** | 🔴 阻断 | MEM-101 / MEM-501 | **`product_key` 写入路径未闭环**。`grep product_key` 全仓 `server/src` **零命中**，证实：① `api.post('/projects')`（routes/index.ts:167）与 `api.patch('/projects/:id')`（:336，当前仅解构 `name/description/sortWeight/workspacePath/wipLimit/timezone`，:337）**均未接受/持久化 product_key**；② 前端绑定弹窗（MEM-501 引用的 T00771、`TasksPage.tsx:1703`）与「存量项目编辑区补绑」无后端落点。MEM-101 只要求 `ensureColumn` 补列，未要求打通创建/编辑 handler 与 UI。 |
| **F3** | 🔴 阻断 | MEM-201 | **抽取触发点过窄**。MEM-201 写「`mtask_update_task_result` 落库后异步触发」，但任务结论有**两条**写入路径：MCP 工具（server.ts:1060 → `TaskService.update({handle_result})`）与 Web UI `PATCH /tasks/:id`（routes/index.ts:1026 → 同一 `TaskService.update`）。若只在 MCP 钩子触发，Web 端编辑的结论不抽取。且 `TaskService.update` 已有 `handle_result` 变更检测分支（TaskService.ts:675 `patch.handle_result !== undefined && !== before.handle_result`），此处是**统一 fire-and-forget 抽取**的唯一正确落点，可同时覆盖 MCP 与 Web。 |
| **F4** | 🟠 重要 | MEM-203 / MEM-301 / MEM-302 | **C4 强制作用域 与 MEM-302 边界冲突**。`mtask_query_memories(productKey,...)` 强制作用域：① 完全缺省 productKey（C4 要报错）；② 传入空串 / 指向未绑产品项目（MEM-302 要求「返回空集 + ok + hint，不报错」）。空串 productKey 会被 C4 判为「无作用域」而报错，与 MEM-302 直接矛盾。需明确区分「调用方根本没传参数（错误）」与「项目未绑产品（空串，返回空+提示）」。 |
| **F5** | 🟠 重要 | MEM-204 / MEM-504 | **项目级自动抽取开关缺存储**。MEM-204「未绑产品不启用」+ MEM-504「自动抽取开关（项目级）」，但 DDL 无 `projects.memory_auto_extract` 列、无 settings key。MEM-201 抽取前需读取该开关，无存储则无法实现「项目级开关」。 |
| **F6** | 🟠 重要 | MEM-303 / §6.3 | **`source_kind` 检索权重遗漏 `manual`**。规范 §6.3 与 MEM-303 排序权重为 `user_said > auto > inferred > tool_output`，但 DDL 枚举含 `manual`（人工录入，`source_kind CHECK` 五项之一），排序未定义其位置。 |
| **F7** | 🟡 适中 | MEM-104 / §6 | **CORE_TABLES 约束未写进需求**。§6 兼容性一句带过「memories 不进 CORE_TABLES」，但 MEM-104 验收只强调「加入三张顺序表」。实现者易误将 memories 加进 `CORE_TABLES`（SettingsService.ts:182），导致旧备份（无 memories key）`validateBundle` 失败、无法导入。应写入 MEM-104 验收为硬约束。 |
| **F8** | 🟡 适中 | MEM-604 | **抽样评审记录缺存储**。MEM-604 要求「评审记录可导出、判据拒杀率统计、留档作回归基线」（规范 §10.2），但无表承载样本+标注+判定。需新增 `memory_review_log` 或明确导出格式（CSV/JSON 落盘）。 |
| **F9** | 🟡 适中 | MEM-305 / 306 / 307 | **TTL/容量/月度整理执行机制未指定**。建议：TTL「需复核」标记在查询时**惰性计算**（无调度依赖、便宜）；月度整理用现有 `RecurringService.tick`（index.ts:283 每小时间隔 + 启动 tick）注册周期任务。PRD 应点明机制，否则 Phase 2/3 会重复设计。 |
| **F10** | 🟡 适中 | MEM-107 / 108 | **rename 与删除钩子/孤儿清理的联合场景未覆盖**。MEM-107 单事务批量 UPDATE 两表，需补：① 归一化（trim+lowercase）一致性；② new key 已存在他项目（merge 语义）的冲突处理；③ 与 MEM-105（删项目 set NULL）+ MEM-108（孤儿清理）的联合验收。 |
| **F11** | 🟡 适中 | §6 / MEM-502 | **ChangeBus 集成不完整**。§6 说「ChangeKind 需扩 'memories'」（当前 `ChangeBus.ts:13` 为 `'tasks'|'plans'|'queue'|'projects'`），但未说清 memory 增删改是否发 SSE、MemoryTab 是否订阅 `/events` 实时刷新。 |
| **F12** | 🟢 轻微 | MEM-103 | **索引对 OR 查询不友好**。`idx_memories_product_type(product_key,type)` 对 MEM-301「`project_id IS NULL OR project_id=?`」效果有限。容量 ≤200/产品，性能影响小，可补 `idx_memories_product_project(product_key,project_id)` 或标注「非阻塞」。 |
| **F13** | 🟢 轻微 | MEM-502 / 303 | **`tags` 存储与筛选未约定**。DDL `tags TEXT`（JSON 数组），但「按标签/关键词筛选」「检索加权」需 JSON 解析或 `LIKE` 约定，无索引/解析规范。 |
| **F14** | 🟢 轻微（风险） | MEM-210 | **跨仓依赖风险**。记忆真正生效依赖外部 mtask Skill（`~/.workbuddy/skills/mtask`）新增「开工前调用 `mtask_query_memories`」步骤，该 skill 不在本仓，验收「实测 Agent 开工路径确实发起记忆查询」超出本 PRD 可控范围。应列为独立任务并计入 Phase 1 完成判据，并提供降级（如 system prompt 注入模板）。 |
| **F15** | 🟢 轻微 | MEM-304 | **注入隔离格式契约未定义**。`<memory-context>` 块的产出格式、`queryForContext()` 的返回结构、Agent 侧消费方式（MEM-210 注入步骤）均未约定。 |
| **F16** | 🟢 轻微 | MEM-601 | **抽取遥测存储未定义**。`ai_usage` 无 reason 列，但「丢弃原因分布」需结构化（dropped.reason 为 Q1–Q7/禁记项文本）。需明确是扩展 `ai_usage`（加 card_key=`memory_extract` + 扩展字段）还是独立 `memory_extract_log` 表。DDL 未定义。 |
| **F17** | ⚪ 笔误级 | 附录 A | 附录 A「§6.3 防线二」阶段列 `P1/P2` 略含糊（加权属查询侧 MEM-303=P1），可细化标注。 |

---

## 2. 技术可行性

**整体可行**，方案 B 与现有 better-sqlite3 同步 API、`ensureColumn` 迁移范式、`SettingsService` 三表顺序导入机制天然契合。逐项：

- **MEM-101/102/103（表与索引）**：完全可行。`initSchema` 的 `ensureColumn`/`CREATE TABLE IF NOT EXISTS` 范式已在 `schema.ts` 实证；无 FK 后导入顺序无敏感性（与 PRD 一致）。
- **MEM-104（三表顺序）**：可行，但须补 F7（不得入 CORE_TABLES）与 F1/F2 的存储前置。
- **MEM-105（删除钩子）**：可行。`DELETE /projects/:id`（routes/index.ts:510-516）当前 `DELETE FROM projects` 后无 memories 处理；补 `UPDATE memories SET project_id=NULL WHERE project_id=?` 即可。注意：现有删项目注释写「级联删任务」，经核验 tasks 的级联由 FK（`foreign_keys=ON`）或应用层完成；memories 无 FK → 不会被级联删，正合「降级共享不丢失」意图。
- **MEM-201 抽取触发**：可行，但**落点应改到 `TaskService.update` 的 handle_result 变更分支**（F3），而非仅 MCP 钩子。
- **MEM-203 四项代码强制**：可行，`util/memoryGuard.ts`（新建，与 `util/planDeps.ts` 同定位）承接 C1；C2/C3 在 `MemoryService` 写路径、C4 在查询路径。
- **MEM-209 PII 待确认**：**当前不可行**——缺存储（F1）。
- **MEM-501 绑定弹窗 / MEM-502 记忆管理页**：可行，但需补 F2 的后端落点与 F11 的 SSE 订阅。

---

## 3. 与现有架构的兼容性

| 架构点 | 兼容性结论 |
|---|---|
| 进程/端口模型（架构 §2） | 记忆服务在 Node 后端子进程内，MCP/REST 均复用 service 层，与「复用现有 service、不产生第二套业务实现」原则一致 ✓ |
| 数据访问层（架构 §3.3） | `getDb()` 单例 + WAL，memories 无 FK，与现有 50+ 表共存无冲突 ✓；加密边界（仅第三方密钥）不受记忆明文影响 ✓ |
| 路由「瘦路由+胖服务」（架构 §3.2） | 记忆 CRUD 走 `/memories` REST + `MemoryService`，符合范式 ✓ |
| MCP 复用 service（架构 §3.6） | 六个 `mtask_*` 记忆工具直接调 `MemoryService`，符合「mtask_* 复用 service」原则 ✓ |
| SSE 变更总线（架构 §4.2 D） | 需补 F11：memory 写操作发 `notifyChange('memories')`，MemoryTab 订阅 ✓（待补） |
| 调度（架构 §6.3 / RecurringService） | MEM-307 月度整理可挂 `RecurringService.tick`（index.ts:283），无需新调度基础设施 ✓ |
| 设置页签单源（settingsTabs.ts） | MEM-502 新增 `memory` 到 `SettingsTabKey` 闭合联合 + `SETTINGS_GROUPS.data` + 渲染 switch，属标准扩展 ✓（需补键类型与渲染分支，PRD 未提） |

---

## 4. 潜在风险与遗漏点（非功能 / 运行时）

1. **异步抽取的失败可见性**：MEM-201 fire-and-forget 不阻塞回传，但抽取失败（AI 超时/限流）需进遥测（MEM-601）且**不影响主任务**——PRD 已隐含，建议显式写「抽取失败仅记遥测，绝不回滚/报错主链路」作为非功能验收。
2. **PII 待确认队列的积压风险**：F1 队列若只增不消费，会无限增长。需定上限或「超过 N 条提示清理」。
3. **overwrite 导入与未绑定产品的交互**：旧备份无 `memories` 键 → 跳过（兼容）；新备份有 memories 但目标库 `memories` 表由 `initSchema` 保证存在 → 可导入。但若**跨版本导入**（旧 app 导、新 app 入，或反之）未覆盖测试，可能触发「no such table: memories」。建议补一条导入兼容性验收（F7 相关）。
4. **幂等（MEM-207）与导入 upsert 的边界**：抽取幂等按 `source_task_id` 查既有记录；导入按 `id` upsert。两者机制不同，需分别在门脚本断言（MEM-602 已含 MEM-207 断言，OK）。
5. **MEM-210 的跨仓交付风险**（F14）：外部 Skill 不更新则功能「建好不用」，属发布风险，非技术不可行。

---

## 5. 需补充或修正的具体内容（逐条 actionable）

| 编号 | 修正动作（建议写入 PRD 的位置） |
|---|---|
| **F1** | 新增 **MEM-109（或并入 MEM-209）**：定义 PII 待确认队列存储——建议新增表 `memory_review_queue(id, product_key, project_id, title, content, type, source_task_id, source_kind, confidence, pii_kind, created_at)`，并由 `mtask_list_pending_memories` / REST `GET /memories/pending` 暴露；MEM-504 的「待确认队列」即读此表。 |
| **F2** | 在 MEM-101 下补子项：① `api.post('/projects')` 与 `api.patch('/projects/:id')` 接受并持久化 `product_key`（经归一化）；② 前端 T00771 绑定弹窗 + 项目编辑区「补绑」UI 给出输入/下拉；③ 复用 `ProductTagService`（MEM-107 新建）做校验。 |
| **F3** | 改写 MEM-201 落点：抽取触发统一收敛到 `TaskService.update` 的 `handle_result` 变更检测分支（TaskService.ts:675 附近），覆盖 MCP 与 Web 两条入口；MCP 钩子仅作为「已回传」的语义确认，不再单独触发。 |
| **F4** | 在 MEM-301 与 MEM-302 间补一段「作用域解析规则」：调用方必须先 `resolveProjectIdOf` 拿到 product_key；product_key 为空串 ⇒ 走 MEM-302（空+提示，非错误）；**完全未提供 productKey 参数** ⇒ C4 报错。明确空串 ≠ 缺省。 |
| **F5** | 在 MEM-101 增列 `projects.memory_auto_extract INTEGER NOT NULL DEFAULT 1`；MEM-201 抽取前读取该开关；MEM-504 开关 UI 读写此列。 |
| **F6** | MEM-303 排序权重补全 `manual`：建议 `user_said = manual > auto > inferred > tool_output`（人工录入不弱于用户陈述）。 |
| **F7** | MEM-104 验收加硬约束：「memories 加入 EXPORT_TABLES/INSERT_ORDER/DELETE_ORDER，**不得**加入 CORE_TABLES（SettingsService.ts:182），以保持旧备份可导入」。 |
| **F8** | 新增 MEM-606（或并入 MEM-604）：定义评审记录存储 `memory_review_log(id, batch_id, memory_id, verdict, hit_rule, reviewer, created_at)` 或明确导出 JSON/CSV 落盘路径。 |
| **F9** | MEM-305/306/307 补「执行机制」：TTL 标记惰性于查询时计算；月度整理挂 `RecurringService.tick`（新增一类周期任务）。 |
| **F10** | MEM-107 验收补：归一化一致性 + new key 已存在冲突处理 + 与 MEM-105/MEM-108 的联合场景（删项目→set NULL→product_key 变孤儿→MEM-108 可见）。 |
| **F11** | §6 兼容补：`MemoryService` 写路径 `notifyChange('memories')`（需先将 `'memories'` 加入 `ChangeBus.ts:13` 的 `ChangeKind` 联合）；MemoryTab 订阅 `/events` 实时刷新。 |
| **F12** | MEM-103 补索引 `idx_memories_product_project(product_key, project_id)`，或标注 OR 查询非阻塞（容量 ≤200）。 |
| **F13** | MEM-502/303 补 `tags` 解析约定（建议 `LIKE '%"kw"%'` 或规范化存储），必要时加表达式索引。 |
| **F14** | MEM-210 补：① 将 mtask Skill 改造列为独立任务并计入 Phase 1 完成判据；② 提供降级注入模板。 |
| **F15** | MEM-304 补 `queryForContext()` 返回契约（独立 `<memory-context>` 块、字段、截断 ≤2k token）与 Agent 消费方式。 |
| **F16** | MEM-601 明确抽取遥测落点：扩展 `ai_usage`（加 `card_key='memory_extract'` + 扩展字段）或独立 `memory_extract_log`；DDL 补定义。 |
| **F17** | 附录 A「§6.3 防线二」阶段列细化（加权=P1）。 |

---

## 6. 评审结论与优先级

- **P0（编码前必改，否则 Phase 1 卡死）**：F1、F2、F3。三者分别堵死「PII 待确认」「product_key 落库」「抽取触发覆盖」，是当前 PRD 与可实施代码之间的硬断点。
- **P1（Phase 1 内须收口）**：F4、F5、F6、F7。属作用域语义、开关存储、权重完备性、导入兼容的硬约束。
- **P2（Phase 2/3 或实施顺带）**：F8–F13、F16、F17。
- **P3（跨仓/发布风险，需跟踪）**：F14、F15。

**好消息**：除 F1/F2/F3 三处硬缺口外，PRD 的架构判断、选型论证、规则追溯、DDL 前瞻性均扎实，无需推翻重构，按上表补丁式修订即可进入 T04118 实施。

> 附：源码核实范围——`server/src/services/SettingsService.ts`（1–360）、`server/src/routes/index.ts`（167/336/505–522/977–1026）、`server/src/mcp/server.ts`（761/1047–1096）、`server/src/services/ChangeBus.ts`、`server/src/services/TaskService.ts`（651–710）、`server/src/db/schema.ts`、`web/src/ui/settingsTabs.ts`、`web/src/ui/gitScopePicker.tsx` 引用；全仓 `grep product_key` 零命中已证实 greenfield 状态。
