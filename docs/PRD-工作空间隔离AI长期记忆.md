# PRD：工作空间隔离的 AI 长期记忆（product 维度）

> 文档类型：产品需求文档（PRD）
> 归属任务：T04120（派生自 T04113 评估）
> 上游文档：`docs/评估报告-工作空间隔离AI长期记忆-T04113.md`（v5，含 v2→v5 全部复审记录）、`docs/记忆提取技能规则规范.md`（T04114，提取行为判据）
> 下游实施单：T04118（Phase 1 MVP）——**本 PRD 是 T04118 的实施基准，两者范围一致**
> 编写时间：2026-11-03（v1.0）；**2026-11-03 v1.1 覆盖度审计修订（T04122）**：补 12 条遗漏需求、修正 D11 与导入模式术语、新增附录 A 追溯矩阵
> 方案代号：方案 B（`projects.product_key` 文本标签列），选型依据见评估报告 §1.5.4（三方案实测对比）
>
> **术语约定**：导入模式源码名为 `overwrite`（`ImportMode = 'overwrite' | 'keep' | 'merge'`，`SettingsService.ts:18`），即「全量清库后重插」；`keep/merge` 为合并模式。早期版本误写为 `replace`，以本约定为准。

---

## 1. 背景与目标

### 1.1 背景

外部 AI Agent（经 mtask Skill + MCP 处理任务的 WorkBuddy 等）每次开工只能拿到「任务字段 + PRD + 截图 + 摘要」四类上下文，跨任务经验无法积累；同一产品多期项目（wiki 一期/二期/三期）是各自独立的 `projects` 行，一期固化的结论在二期无法复用。MTask 全仓无任何长期记忆逻辑（评估报告 §2.1 实证）。

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

**S3（记忆审查）**：用户在设置 → 数据 → 「记忆管理」页按产品浏览全部记忆，逐条编辑/删除，并查看「被丢弃候选」列表以了解抽取器为何没记某些内容。

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

### 3.2 与现有轴的关系（防误解）

产品轴与现有 workspace 轴**正交**（评估报告 D6）：workspace 轴 = 同一 `workspace_path` 的多项目（`gitScopePicker.tsx:12` 分组语义）；产品轴 = 同一产品线、跨仓库跨期。产品标签不改变任何现有 workspace 行为。

---

## 4. 功能需求

> 编号 MEM-1xx；「验收」列给出可执行判据。标注 [T04118] = Phase 1 范围内。

### 4.1 数据与存储

| # | 需求 | 验收 |
|---|---|---|
| MEM-101 [T04118] | `projects` 增量补列 `product_key TEXT DEFAULT ''`（`ensureColumn`，**不带 REFERENCES**） | 老库启动自动补列；存量项目读出 `''` |
| MEM-102 [T04118] | 新建 `memories` 表，字段 = 评估报告 §3.1 DDL **加修正三列**：`invalidated_at TEXT`、`superseded_by TEXT`（INVALIDATE 动作落点）、`source_kind CHECK IN ('auto','manual','user_said','tool_output','inferred')`（与提取规范 §5.3 枚举统一）；不设任何外键 | DDL 与行为判据/门断言三方一致；非法 `source_kind` 被拒 |
| MEM-103 [T04118] | 索引：`idx_memories_product(product_key)`、`idx_memories_product_type(product_key,type)`、`idx_memories_project(project_id)` | EXPLAIN 命中索引 |
| MEM-104 [T04118] | **三张顺序表全覆盖**：`memories` 同时加入 `SettingsService` 的 `EXPORT_TABLES`（`:54`）、`INSERT_ORDER`（`:52`）**与 `DELETE_ORDER`（`:51`）**——`overwrite` 模式先按 `DELETE_ORDER` 清库（`:280`）再按 `INSERT_ORDER` 重插（`:282`），`keep/merge` 才遍历 `EXPORT_TABLES`（`:290`）。**漏任一张即出问题**：漏 `EXPORT_TABLES` ⇒ 导出不含记忆；漏 `INSERT_ORDER` ⇒ 清空后不恢复（记忆丢失）；漏 `DELETE_ORDER` ⇒ 旧记忆残留 + 新记忆再插（**记忆翻倍**）。无 FK ⇒ 三张表内**均无顺序敏感性**，位置任意 | overwrite 恢复后记忆行数与导出前**完全一致**（不多不少）；keep/merge 恢复后按主键 upsert 不产生重复行；旧备份文件仍可导入 |
| MEM-105 [T04118] | **项目删除钩子**：`DELETE /projects/:id`（`routes/index.ts:516`）删项目前执行 `UPDATE memories SET project_id=NULL WHERE project_id=?`（应用层实现 v2 时代 FK SET NULL 语义——记忆降级为产品级共享，不丢失） | 删项目后其特有记忆仍在，`project_id` 为 NULL 且可被同产品其他期召回 |
| MEM-106 [T04118] | **project_id 引用校验**：`mtask_save_memory`/REST POST 带 `projectId` 时校验项目存在（无 FK 后防孤儿行） | 传不存在 projectId → 报错不落库 |
| MEM-107 | 产品标签重命名/合并：`ProductTagService.rename(old,new)` 在**同一事务**内批量 UPDATE `projects.product_key` 与 `memories.product_key`，防止旧 key 记忆悬空 | 重命名后旧 key 零残留（projects + memories 双表断言） |
| MEM-108 | 孤立标签清理：管理页展示「已无项目引用但仍有记忆」的 product_key，提供「删除该标签全部记忆」或「挂回某项目」操作，均需 `askConfirm` 二次确认 | 孤立标签可见、操作留痕 |

### 4.2 抽取（写入侧）

| # | 需求 | 验收 |
|---|---|---|
| MEM-201 [T04118] | 任务回传钩子：`mtask_update_task_result` 落库（`mcp/server.ts:1060`）后**异步 fire-and-forget** 触发 `MemoryService.extract`，按结论 `project_id` 回查 `product_key` 落库；主链路不等待 | 任务回传响应时间无可测退化 |
| MEM-202 [T04118] | 提取行为全量遵循 `docs/记忆提取技能规则规范.md`：六段流程（候选→准入 Q1-Q7→禁记→动作四分类→写法 W1-W8→落库+遥测）、中文提示词模板（规范 §9）、`dropped[]` 丢弃原因回报 | 门脚本 `scripts/verify-t04114-memory-rules.mts` 全部断言通过（规范 §10.3 六条） |
| MEM-203 [T04118] | 代码强制四项：C1 never-store 正则+字段黑名单（`util/memoryGuard.ts`）；C2 单次回传 ≤5 条；C3 置信度 <0.7 不入库；C4 查询强制作用域 | 规范 §10.3 对应断言通过 |
| MEM-204 [T04118] | 未绑产品项目**不启用**自动抽取，计遥测（不静默失败）；手动录入不受限 | 抽取遥测可见未归属计数 |
| MEM-205 | 归档/沉淀项目（`archived`/`history_at`）的任务如被回传处理，仍可抽取——**记忆可见性与项目现行态解耦**（D4） | 归档项目的结论可正常落库 |
| MEM-206 [T04118] | **抽取源分区映射**（规范 §3.3）：按 `handle_result` 的「根因 / 修复 / 验证」三段分别抽取，`## 下一步建议` 段**默认不抽取**（是待办不是记忆）；段缺失时跳过而非报错 | 构造含四段结论的样例，断言仅前三段产生候选、建议段候选数=0 |
| MEM-207 [T04118] | **抽取幂等**：同一 `source_task_id` 重复回传**不得**产生重复记忆行——抽取前按 `source_task_id` 查既有抽取记录（记忆行 + 遥测表）已存在则跳过重抽（规范 §4.1 第 0 步） | 同一任务连续回传 3 次 ⇒ memories 中该来源行数不增；遥测记「跳过(幂等)」 |
| MEM-208 [T04118] | **写法校验重写限次**：W1–W8 自检不通过时**最多重写 1 次**，仍不合则丢弃并记 `dropped`（规范 §5.1 落点，防死循环） | 构造持续违规候选 ⇒ 恰好 1 次重写后丢弃，无无限循环 |
| MEM-209 [T04118] | **疑似敏感内容人工确认**：never-store 命中「个人敏感」类（身份证/手机号/银行卡/住址）时不直接丢弃，而转入**待确认队列**，由用户在记忆管理页确认后才入库（规范 §6.1「敏感模式识别 + 人工确认」） | 构造含手机号的候选 ⇒ 不自动入库，待确认队列出现该条；用户确认后入库 |
| MEM-210 [T04118] | **Skill 侧协作约定**：记忆不会自动进入上下文——须在 mtask Skill 文档中约定「Agent 开工前调用 `mtask_query_memories(productKey, [projectId])` 取回记忆并注入 system prompt」，并把「不查询记忆」列为任务回传/开工流程的显式步骤 | Skill 文档含该步骤；实测 Agent 开工路径确实发起记忆查询调用 |

### 4.3 查询（读取侧）

| # | 需求 | 验收 |
|---|---|---|
| MEM-301 [T04118] | `mtask_query_memories(productKey, [projectId], type?, query?, limit?)`：强制作用域，结果合并「产品级共享（`project_id IS NULL`）+ 本期特有（`project_id = 当前项目`）」；`limit` 默认 10 硬上限 20；`queryForContext` ≤2k token 截断；已失效行（`invalidated_at` 非空）默认不召回 | C4 断言：无 productKey 请求 → 报错非全量 |
| MEM-302 | **未绑产品项目的查询行为**：返回**空集 + 提示「该项目未绑定产品标签」**（不报错——Agent 拿到报错会误判为故障） | 未绑产品项目查询返回 ok + 空列表 + hint 字段 |
| MEM-303 | 检索排序：type 权重 → **溯源权重**（`user_said` > `auto` > `inferred` > `tool_output`，规范 §6.3 防线二）→ 未访问时长降权（§7.2）→ recency；失效行排除 | 可复现排序断言 |
| MEM-304 | 注入隔离：召回记忆以独立 `<memory-context>` 参考块注入提示词，不拼进指令块（提取规范 §6.3 防线三） | 注入块格式断言 |
| MEM-305 | **分型保留期与复核**（规范 §7.1，Phase 2）：`project` 型 180 天到期标「需复核」并降权（仍可召回），`user`/`feedback`/`reference` 无固定 TTL；到期判定基于 `updated_at` + 绝对日期（规范 §3.3 的时间锚），不引入第五型 | 到期条目召回时带「需复核」标记且排序降权 |
| MEM-306 | **容量上限与淘汰**（规范 §7.3，Phase 2）：单产品记忆上限 200，超限按 `access_count` 最低 / `updated_at` 最旧淘汰；淘汰走 INVALIDATE 软失效而非物理删除 | 超限后自动降权/失效最旧条目，并留审计链 |
| MEM-307 | **月度整理任务**（规范 §7.3，Phase 3）：定期合并近重复记忆、清理「无人遵守的规则」、归档已完结任务导出的记忆；整理动作全部走 UPDATE/INVALIDATE，不物理删除 | 整理脚本可重复执行且幂等 |

### 4.4 MCP 与 REST 接口

| # | 需求 |
|---|---|
| MEM-401 [T04118] | MCP 工具六件：`mtask_save_memory` / `mtask_query_memories` / `mtask_list_memories` / `mtask_update_memory` / `mtask_delete_memory` / `mtask_list_product_tags`；字段定义见评估报告 §3.3；项目定位复用 `resolveProjectIdOf`（`mcp/server.ts:761`），产品标签按归一化解析 |
| MEM-402 [T04118] | REST `/memories` CRUD（委托 MemoryService），供前端管理页 |
| MEM-403 [T04118] | 管理类操作（list/update/delete）均带 `productKey` 作用域校验；物理删除仅由管理页/显式 MCP 删除提供，自动流程只 INVALIDATE |

### 4.5 前端

| # | 需求 |
|---|---|
| MEM-501 [T04118] | 新建/关联工作空间流程（T00771 绑定弹窗，`TasksPage.tsx:1703`）：加「产品标签」栏——下拉选已有（`mtask_list_product_tags` 数据源）或新建；存量项目在项目编辑区补绑 |
| MEM-502 [T04118] | 设置 → data 组加「记忆管理」页签（`settingsTabs.ts:39-49`），`MemoryTab.tsx` 仿 `ApiTokensTab`：按产品为顶层维度列表（类型徽标/标题/摘要/标签/作用域/来源任务/更新时间/访问次数 + 失效标记）、新增/行内编辑/删除二次确认、按类型/关键词/作用域/丢弃原因筛选 |
| MEM-503 | 隔离可见性：UI 标注「本页记忆仅属于产品 X」，跨产品操作置灰 |
| MEM-504 | 自动抽取开关（项目级）+ 丢弃原因审查视图（§3.4 第 8 项）+ **待确认队列**（MEM-209 转入的疑似敏感内容，确认后才入库） |
| MEM-505 | 产品标签重命名入口（MEM-107）+ 孤立标签清理入口（MEM-108） |

### 4.6 遥测与验收门

| # | 需求 |
|---|---|
| MEM-601 [T04118] | 抽取遥测：抽取数/拒绝数/动作分布/丢弃原因分布，复用 `ai_usage`/`ai_card_provenance` 范式（cardKey 如 `memory_extract`） |
| MEM-602 | 门脚本 `scripts/verify-t04114-memory-rules.mts`（接 `gate-boot.mts`）：提取规范 §10.3 六组断言（展开 8 条）+ MEM-104/105/207 断言 |
| MEM-603 [T04118] | **质量指标达标线**（规范 §10.1，作为 Phase 1 验收判据）：抽取精度 ≥80%、召回 ≤15%、污染率 =0、矛盾率 =0（INVALIDATE 生效）、注入 ≤2k token；「精度/召回」以每批随机抽 20 条人工评审（规范 §10.2）测得——首版可只报数不阻断，但**污染率=0 与矛盾率=0 为硬门**（不达标即阻断发布） | 门脚本断言污染率/矛盾率为 0；遥测可导出精度/召回抽样结果 |
| MEM-604 | **抽样评审规程**（规范 §10.2，Phase 2 常态化）：每批抽取随机抽 20 条人工评审，判定「不值得记」须记下命中的判据编号（Q1–Q7 / W1–W8 / 禁记项）；**连续两批同一判据拒杀率 > 40% → 该判据需重写**（不靠放宽阈值掩盖）；样本与标注留档作回归基线 | 评审记录可导出；判据拒杀率统计可用 |
| MEM-605 | **抽取成本与并发约束**（非功能落到需求）：每次抽取 1 次 LLM 调用（`AIService.askJson`）+ 至多 1 次重写 ⇒ 单任务最多 2 次调用；抽取并发上限（建议 1，同产品串行）以免挤占 AI 配额 | 单任务抽取的 AI 调用数 ≤2；并发不超限 |

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
  tags             TEXT,               -- JSON 数组
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
```

> `projects.product_key` 由 MEM-101 补列。**全表无外键**（选型实测依据：评估报告 §1.5.2 T2/T4/T5）。

---

## 6. 非功能需求

| 类别 | 要求 |
|---|---|
| 性能 | 抽取异步不阻塞任务回传；单产品记忆 ≤200 条容量控制；查询 O(log n)；注入 ≤2k token |
| 成本 | 单任务抽取的 LLM 调用 ≤2 次（抽取 1 + 重写 ≤1）；同产品抽取串行，避免挤占 AI 配额（MEM-605） |
| 安全 | C1 禁记代码拦截（污染率=0）；`<memory-context>` 注入隔离；跨产品零串扰；记忆明文存储（业务数据非密钥）但纳入导出/备份 |
| 兼容 | 老库自动补列；旧备份可导入（memories 不进 CORE_TABLES）；`ChangeKind` 封闭联合需扩 `'memories'`（`ChangeBus.ts:13`） |
| 可观测 | 抽取成功率/丢弃原因/未归属计数遥测；门脚本可重复执行 |

---

## 7. 里程碑

| 阶段 | 范围 | 任务 |
|---|---|---|
| **Phase 1 MVP** | MEM-101~106、**206~210**、201~204、301/302、401~403、501/502/504、**601/603/605** + 提取规范落地 + 门脚本 MEM-602 | T04118 |
| **Phase 2 增强** | MEM-107/108、205、303、503/505、**305/306**、**604** + 语义判重（FTS5）、反思补漏、相关性排序 | 待建 |
| **Phase 3 完善** | **307**（月度整理）、记忆跨任务关联、图化评估（视「跨记忆聚合」需求出现与否） | 待建 |

---

## 8. 开放问题（不阻塞 Phase 1）

1. **`project` 型 180 天到期复核**的提醒形态（管理页徽标 vs 定时报告）——需求已落 MEM-305（Phase 2），形态待定；
2. **置信度 0.7 与拒杀率**的调参依据依赖 Phase 1 遥测数据积累（评审规程见 MEM-604）；
3. **产品标签是否需要描述/别名**（现方案仅一个归一化名）——出现真实重名冲突再评估；
4. mem0「上下文丰富」写法是否对 `user` 型放宽（提取规范 §12.1 保留项）——待 `user` 型记忆积累后评审。

---

## 附录 A：提取规范 → PRD 需求追溯矩阵

> 本表回答「规范里的每一条内容，是否在 PRD 里有任务体现」。**空白格 = 需求遗漏，已在本轮评审补齐并标注**。阶段列 P1/P2/P3 = Phase 1/2/3。

| 规范条目 | 关键要求 | PRD 需求 | 阶段 | 状态 |
|---|---|---|---|---|
| §3.1 Q1–Q7 | 七问准入判据 | MEM-202 | P1 | ✅（笼统引用判据全文） |
| §3.1 取舍 | 保守侧（宁缺勿滥），阈值 0.7 | MEM-203（C3）+ MEM-603 | P1 | ✅ |
| §3.2 四型准入门槛 | user/feedback/project/reference 各自门槛 | MEM-202 + MEM-102（CHECK） | P1 | ✅ |
| §3.3 **分区抽取映射** | 根因/修复/验证三段抽取；下一步建议不抽 | **MEM-206** | P1 | 🆕 本轮补 |
| §3.3 时间锚 | 锚点=任务完成时刻 | MEM-202 | P1 | ✅ |
| §4 动作四分类 | ADD/UPDATE/INVALIDATE/NOOP | MEM-202 + MEM-102（软失效列） | P1 | ✅ |
| §4.1 **幂等** | 同一来源重复抽取不产生重复行 | **MEM-207** | P1 | 🆕 本轮补 |
| §4.3 **信息量更大判据** | 五项死规则（专名/触发条件/理由/边界） | MEM-202 | P1 | ✅（写入提示词模板） |
| §5.1 W1–W8 | 写法八条硬要求 | MEM-202 | P1 | ✅ |
| §5.1 **重写限次** | 违规最多重写 1 次，防死循环 | **MEM-208** | P1 | 🆕 本轮补 |
| §6.1 never-store | 凭据/连接串/密文/大块原文 | MEM-203（C1） | P1 | ✅ |
| §6.1 **敏感人工确认** | 个人敏感类转待确认队列 | **MEM-209** + MEM-504 | P1 | 🆕 本轮补 |
| §6.2 C1–C4 | 四项代码强制 | MEM-203 | P1 | ✅ |
| §6.3 防线一 | 只存声明式事实，不存原文 | MEM-202（提示词）+ MEM-203 | P1 | ✅ |
| §6.3 防线二 | **溯源标记 + 检索加权** | MEM-102（`source_kind`）+ **MEM-303** | P1/P2 | 🆕 本轮补（加权规则） |
| §6.3 防线三 | 注入隔离（独立参考块） | MEM-304 | P1 | ✅ |
| §6.3 防线四 | 写前限流 + 人工审查 | MEM-203（C2）+ MEM-502 | P1 | ✅ |
| §7.1 **分型 TTL + 需复核** | project 180 天标「需复核」降权 | **MEM-305** | P2 | 🆕 本轮补 |
| §7.2 访问衰减 | 按未访问时长降权 | MEM-303 | P1 | ✅ |
| §7.3 **容量上限/淘汰** | 单产品 200 条上限 | **MEM-306** | P2 | 🆕 本轮补 |
| §7.3 **月度整理** | 合并近重复、清理无人遵守的规则 | **MEM-307** | P3 | 🆕 本轮补 |
| §9 提示词模板 | 中文模板 + `dropped[]` | MEM-202 | P1 | ✅ |
| §10.1 **六项质量指标** | 精度≥80%/召回≤15%/污染率0/矛盾率0/陈旧率≤10%/注入≤2k | **MEM-603** | P1 | 🆕 本轮补 |
| §10.2 **抽样评审规程** | 随机抽 20 条、记判据编号、拒杀率>40% 重写判据、留档 | **MEM-604** | P2 | 🆕 本轮补 |
| §10.3 门断言 | 六组（展开 8 条）自动化断言 | MEM-602 | P1 | ✅ |
| §11 落点对照 | memoryGuard.ts / 提示词常量 / 门脚本 / ChangeBus | MEM-203 / MEM-202 / MEM-602 / PRD §6 兼容 | P1 | ✅ |
| §12 改造点 | 原子 vs 上下文、图结构、三层记忆、软失效 | 说明性；MEM-305/306/307 + MEM-102 承接 | P1–P3 | ✅ |

**评估报告 → PRD 覆盖**：§3.1 数据模型 → PRD §5（权威版）+ MEM-101/102；§3.2 提取流程 → MEM-201/206；§3.3 MCP 六工具 → MEM-401；§3.4 前端页 → MEM-501/502/504；§4.1 性能 → PRD §6；§4.2 安全 → MEM-203/304 + PRD §6；§5 路线图 → PRD §7；§1.5 复审缺陷 D1–D11 → D1→MEM-204、D2/D7/D11→MEM-104、D3→MEM-105、D4→MEM-205、D5→MEM-307（时区随产品标签收敛）、D6→PRD §3.2、D8→MEM-105、D9/D10→MEM-102。**无悬空项。**

---

## 附录 B：文档评审记录

| 版本 | 日期 | 评审人 | 结论 |
|---|---|---|---|
| v1.0 | 2026-11-03 | T04120 | 初版：24 条功能需求 + 权威 DDL，作为 T04118 实施基准 |
| **v1.1** | 2026-11-03 | **T04122** | **覆盖度审计：补 12 条遗漏需求（MEM-206~210、303、305~307、603~605）；修正 D11（三张顺序表）与术语（overwrite 非 replace）；新增附录 A 追溯矩阵。结论：规范条目已 100% 有 PRD 落点** |
