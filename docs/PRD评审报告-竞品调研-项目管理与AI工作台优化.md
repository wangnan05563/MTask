# PRD 评审报告：GitHub 竞品调研及项目管理与 AI 工作台优化（T02272）

> 评审对象：`docs/PRD-竞品调研-项目管理与AI工作台优化.md` ｜ 评审版本：**v1.0（2026-10-16）** ｜ 评审日期：2026-10-16
> 评审人：AI 评审（结合本仓实现与架构逐条取证）｜ 方法：同 T02169/T02170 评审——**不评审文档，只评审假设**
> 同一轮次内另含「按建议改写方案」：Q-1~Q-3 按建议签字，PRD 升至 v1.1
> 修订结果：PRD 已为 **v1.1（改写方案 + 评审修订）**；门禁 `scripts/verify-t02272-prd.mts` 增补断言固化本次取证

---

## 0. 评审结论

**v1.0 存在 3 个阻塞**：其中 B3 是**把既有能力当新增需求**（批量操作 T00457/T01065 早已上线，含 5 种动作与 10 级撤销栈），B1 是**需求依赖了不存在的字段**（tasks 无任何排期字段，逾期预测无从计算）。两者都属此前两轮评审反复抓出的同类错误，说明**「需求 × schema 字段级对齐」应固化为门禁项而非人工记忆**。

修订后（v1.1）：3 阻塞消解、6 重要落进需求或转为开放问题、3 建议采纳，另含 Q-1~Q-3 裁决落定与 Q-4~Q-6 新增。**v1.1 可提交业主审批**。

| 级别 | 数量 | 处置 |
|---|---|---|
| 阻塞 B | 3 | 全部修订 |
| 重要 I | 6 | 全部修订（4 项改口径、1 项改路径、1 项补落库位） |
| 建议 S | 3 | 全部采纳 |

---

## 1. 问题清单

| 编号 | 级别 | 问题 | 证据 | 处置 |
|---|---|---|---|---|
| B1 | 阻塞 | **AI-204「按任务工期完成率 vs 时间进度」预测逾期——不可实现**：`tasks` 表**无任何排期字段** | `schema.ts:16-32` + 全部 `ensureColumn('tasks',…)`（`:481-580`，19 条）逐条扫过：无 `start_date`/`duration_days`/`due_date`/`estimate`；排期字段全在 `plan_tasks`（`:184-199`） | AI-204 口径改为**计划级预测**（`plan_tasks` 有日期+工期+进度）；新增 **Q-4** 裁决「是否给 tasks 补 due_date」（建议本期不做）；验收⑤显式禁止出现「任务逾期」字样 |
| B2 | 阻塞 | G-4 指标名与口径不符：写「逾期**任务**率」，但任务无截止日概念 | 同 B1 证据 | 改为「逾期**计划**率」，口径锚 `end_date < 今天 && status != 'done'` |
| B3 | 阻塞 | **PM-105 把既有能力当新增**：系统早已具备批量操作 | `web/src/pages/TasksPage.tsx:742 multiSelect`、`:746 selectedIds`、`:94-96 ACTION_LABEL`（status/category/priority/color/archive 五种动作）、`:109 MAX_UNDO_STEPS=10`（T01065 撤销栈）；`:2910` 入口按钮 title 明示「批量改状态/分类/归档」 | PM-105 重写为「**批量操作增强**」：只补三处缺口（跨项目批量、导出所选、部分失败逐条回执），并把既有锚点钉进验收⑤防回归 |
| I1 | 重要 | PM-205 洞察页的长历史深度未受约束 | `server/src/services/EventRetention.ts:23 DEFAULT_RETENTION_DAYS = 90`（`events.retentionDays` 可配）——与 T02170 评审 B1 同源问题 | 需求内写明：**>90 天历史无法从事件表重建，自建日快照表是长历史唯一来源**，每图标注实际可回溯窗口起点，验收②③⑥ 相应加强 |
| I2 | 重要 | AI-401「月度成本上限」无数据源 | `ai_usage` 列：id/tool_id/tool_name/model/**kind**/ok/**duration_ms**/**content_chars**/error/created_at —— **无 token、无金额** | 改「用量上限（调用次数+字符量代理指标）」，验收⑤明示「非金额，不显示虚假估算」；新增 **Q-5** |
| I3 | 重要 | AI-301「组内按使用频率排序」无卡片维度 | `ai_usage.kind` 记录 AI 通道类型（organize/ask/askJson/askStream/…），**无 card 列**，无法按卡片聚合 | 改 `kind` 粗映射排序（零 schema 变更）+ 标注精度有限；新增 **Q-6** |
| I4 | 重要 | AI-104「使用次数落库」无落库位 | `prompts` 列：id/category_id/title/content/pinned/created_at/updated_at + `ensureColumn`（archived/archived_at/color/req_category_id/sort_weight）——**无计数字段**；`app_settings:160` 为应用级 KV 不适合逐模板计数 | 采用 `ensureColumn('prompts','usage_count',…)` 幂等补列 + 启动时 +1；不从 console_jobs 派生（口径不一致） |
| I5 | 重要 | PM-201 迭代直接跳到「新表」选项，漏了成本更低的零新表路径 | `plan_tasks` 已有 `start_date/end_date/deps(kind=child)`，天然可表达「区间 + 成员集合」 | 需求改为「**先评估零新表路径**（迭代=计划区间视图），不可行才新增表」，验收⑥要求技术方案评审明确结论 |
| I6 | 重要 | PM-103 项目级开关与 PM-401 投递日志均无落库位 | `app_settings` 为应用级 `key/value`（`schema.ts:160-164`），无项目维度；Webhook 投递日志无对应表 | PM-103 改键命名 `guide.dismiss.<projectId>`（零 schema 变更）；PM-401 补 `webhook_deliveries` 建表声明（走 ensureColumn 范式） |
| S1 | 建议 | §3.2 现状 #1 未显性声明「tasks 无排期字段」——B1 的根因 | 同 B1 | 现状表补该边界 + 批量能力锚点，使后续需求作者一眼看到约束 |
| S2 | 建议 | §6.3「Windows 为主」缺锚点 | `package.json:70-72` electron-builder `build.win.target` | 补锚点 |
| S3 | 建议 | PM-105 修订后需防未来再次误判为新增 | 同 B3 | 既有锚点（`:94/:109/:742/:746`）钉进验收⑤ |

---

## 2. 三个阻塞问题的详细论证

### B3：批量操作早已存在——最刺眼的一处

v1.0 的 PM-105（P0）写「任务列表支持多选（跨页保持）后批量改状态/优先级/分类/归档」，并给出「500 条 ≤5s、事务回滚」等验收。实测 `TasksPage.tsx`：

- `:742 const [multiSelect, setMultiSelect] = useState(false)` —— 多选模式在位；
- `:746 const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())` —— 选中集合在位，注释写明「T00457 批量操作——多选模式 + 选中任务集合（跨待办/已完成统一 id 集合）」；
- `:94-96 ACTION_LABEL: Record<'status'|'category'|'priority'|'color'|'archive', string>` —— **五种批量动作**已实现（比 v1.0 写的四项还多一个颜色）；
- `:109 MAX_UNDO_STEPS = 10` + `:1243` 入栈 + `:1421`「撤销 N 步」UI —— T01065 的 10 级撤销栈在位。

也就是说，PM-105 里约 90% 的内容是**已交付能力**。若按 v1.0 排期，实施者会重复开发甚至重写既有链路。修订后只保留三处真实缺口：跨项目批量（当前选中集合在单项目视图内生效）、导出所选、部分失败逐条回执。

### B1：逾期预测依赖了不存在的字段

v1.0 的 AI-204 写「按任务**工期完成率** vs 时间进度推算」。把 `tasks` 表定义（`schema.ts:16-32`）与全部 19 条 `ensureColumn('tasks', …)`（`:481-580`）逐条扫过：无 `start_date`、无 `duration_days`、无 `due_date`、无 `estimate`。任务的排期语义全部在 `plan_tasks`（`:184-199` 有 start/end/duration/progress），待办本身只有 `progress` 与 `created_at/updated_at`。

后果：按 v1.0 实施会让实现者去猜「任务工期」从哪来——要么编造（违反本 PRD 自己的可验证原则），要么静默改口径。修订为**计划级预测**（`end_date`/`duration_days`/`progress` 三者足够算「时间已过 vs 进度」），并把「要不要给 tasks 补 due_date」立为 Q-4（建议不做，与 Q-1「不改 tasks 核心结构」同逻辑）。G-4 指标名同步改为「逾期**计划**率」。

### B1/B2 的共同教训

这是 T02170 评审 B2（`estimate_items` 无 actual）在另一张 PRD 上的复现：**需求写得像数据模型已经长成那样**。三次评审连续命中同一类问题（B3 已有能力、B1 缺字段），说明应把「需求所依赖的字段/能力必须在 schema 或服务层找到证据」做成门禁断言——本次已把 B1/B3 的证据锚点写进 `verify-t02272-prd.mts`（F-C11/F-C12）。

---

## 3. 修订前后对照

| 条目 | v1.0 | v1.1 |
|---|---|---|
| PM-105 批量操作 | 新增需求（P0），含 4 项动作 | 重写为「批量操作增强」，以既有 T00457/T01065 为基线，只补 3 处缺口 |
| AI-204 逾期预测 | 任务级「工期完成率 vs 时间进度」 | **计划级**预测（plan_tasks），禁止出现「任务逾期」字样；Q-4 待裁决 |
| G-4 指标 | 逾期任务率 | 逾期**计划**率（口径锚 plan_tasks.end_date） |
| AI-401 | 月度成本上限 | 用量上限（调用次数/字符量代理），明示非金额；Q-5 待裁决 |
| AI-301 | 按卡片使用频率排序 | `kind` 粗映射排序（无 card 列）；Q-6 待裁决 |
| AI-104 | 使用次数落库 | `ensureColumn('prompts','usage_count')` 幂等补列 |
| PM-201 迭代 | 数据模型=新表 `iterations` | **先评估零新表路径**（迭代=计划区间视图），验收⑥要求技术结论 |
| PM-103 | 项目级「不再显示」（未说落库） | 键命名 `guide.dismiss.<projectId>`（app_settings 应用级，零 schema 变更） |
| PM-401 | 投递日志保留 30 天（未说落库） | 补 `webhook_deliveries` 建表声明 |
| PM-205 洞察 | 未提历史深度 | 明写「>90 天无法从事件表重建，快照表是长历史唯一来源」+ 每图标注可回溯窗口 |
| §3.2 现状 #1 | 字段清单 | 增补「批量操作已具备」锚点 + 「⚠ 无任何排期字段」边界 |
| Q-1~Q-3 | 开放问题待裁决 | **已签字**（§1.1 裁决记录），R-1 相应降级 |
| Q-4~Q-6 | — | 新增三项 schema 相关开放问题，均建议本期不做 |
| §6.3 兼容性 | 「Windows 为主」 | 补锚点 `package.json:70-72`（electron-builder 仅 win target） |

---

## 4. 取证核验台账（本次评审全量）

**属实（抽验 10 条）**：看板双视图（`TasksPage.tsx:321`）、计划三视图（`PlanPage.tsx:382`）、reportCards 7 卡（`ReportPage.tsx:584`）、RTM/估算/console_jobs/exec_sessions 表与行号、命令面板 Ctrl+F（`CommandPalette.tsx:23`）、CSV 导入预览（`TasksPage.tsx:740`）、分页存在（`:399 limit: PAGE_SIZE`）、Markdown XSS guard（`ui/Markdown.tsx:11`）、打包仅 win（`package.json:70-72`）、i18n 底座（T01071 `web/src/i18n.ts`）。

**不实（3 条）**：① tasks 存在排期字段（否）；② 批量操作需新建（否，T00457/T01065 已在位）；③ 「无暗色主题」（v1.0 撰写阶段已自纠，机制在 `settings.tsx` 的 themeCss——详见 T02272 PRD §9.3 取证教训）。

**新增确认（评审据以立论）**：`tasks` 19 条 ensureColumn 无排期字段；`ai_usage` 无 token/成本/卡片维度；`prompts` 无使用计数；`app_settings` 为应用级 KV；`EventRetention` 默认 90 天；批量动作五种 + 10 级撤销栈。

---

## 5. 剩余风险（修订后仍需关注）

| 编号 | 风险 | 说明 |
|---|---|---|
| R-2 | 护城河叙事被竞品追平（GitHub agent sessions / Gitee AI 队友 / Azure MCP） | 已在 PRD §3.3 F-1/R-2 记录；靠 AI-101/AI-203/AI-402 把「AI 队友感」做进现有闭环 |
| R-5 | PM-201/PM-205/PM-401 新增表或字段（iterations/日快照/webhook_deliveries/prompts.usage_count） | 迁移面扩大；均走 `ensureColumn` 幂等范式并逐条声明；PM-201 优先零新表路径 |
| — | Q-4~Q-6 三项 schema 决策悬而未决 | 若业主后续批准「加 due_date / 加 token 计量 / 加 card 列」，需回改 AI-204/AI-401/AI-301 三条需求（改动点已在本报告标注） |
| — | 竞品信息时点性 | 矩阵随竞品迭代过时；建议每季度复核（PRD §8 R-6） |

---

## 6. 门禁与复审触发

本轮取证已增补进 `scripts/verify-t02272-prd.mts`：

| 断言 | 钉住的事实 |
|---|---|
| F-C11 | `tasks` 无排期字段（ensureColumn 全列扫过）且 PRD 不得声称任务级逾期预测 |
| F-C12 | 批量操作既有能力在位（`multiSelect`/`selectedIds`/`ACTION_LABEL`/`MAX_UNDO_STEPS`）且 PRD 的 PM-105 须标注为增强 |
| F-C13 | `ai_usage` 无 token/成本/卡片维度列，`prompts` 无计数字段，`app_settings` 为应用级 |
| F-C14 | `EventRetention` 默认 90 天在位且 PM-205 须引用该约束 |
| F-C15 | 裁决记录 Q-1~Q-3 已签字 + 新增 Q-4~Q-6 |

**复审触发条件**：① Q-4~Q-6 任一被批准（须回改 AI-204/AI-401/AI-301）；② PM-201 技术方案给出「零新表不可行」结论（需求需改写数据模型段）；③ 竞品矩阵季度复核后有实质变化。
