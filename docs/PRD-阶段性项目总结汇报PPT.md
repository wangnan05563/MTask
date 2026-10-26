# PRD：AI 控制台「阶段性项目总结汇报 PPT 生成」（MTask）

> 来源任务：T02170 ｜ 版本：**v1.4（已批准）** ｜ 日期：2026-10-16 ｜ 状态：**已批准（2026-10-16 业主签字），按 §9 回写项目计划并派生实施任务；v1.2/v1.3 为 2026-10-24 文档裁决修订（T02957/T02959/T02960）；v1.4 为 2026-10-25 T02960 复议（方案 A：恢复三档版式预设）**
> 评审报告：`docs/PRD评审报告-阶段性项目总结汇报PPT.md`（v1.0 → v1.1 的 3 阻塞 / 5 重要 / 4 建议问题及处置）
> 影响项目：**mtask六期**（MTask 项目 `bea1ce5b-67c1-4a0d-a08c-db0d5a3d9136`，2026-10-15 建；工作空间 `D:\code\otherProjects\26_MTask`——与四期同仓不同项目，T02170 归属六期）
> 关联既有 PRD：`docs/PRD-项目启动会PPT生成.md`（T02107，v1.1 已批准且**已实现**——`kickoffService.ts`/`kickoffBuilder.ts`/`kickoff-layout.ts`/`KickoffPptPanel.tsx` 全部在位，本 PRD 的最大复用基座）；`docs/PRD-估算视图与工作量评估导出.md`（v2.5 已实现）
> 取证方式：全文每条技术断言均锚到本仓 `路径:行号`；「不存在」的结论标注 grep 关键字与范围（§1.3）；竞品结论锚到 2026-10-16 实时检索来源（附录 B）

---

## 0. 版本与审批记录

| 版本 | 日期 | 变更 | 审批状态 |
|---|---|---|---|
| v1.0 | 2026-10-16 | 首版：基于 T02170 任务要求与代码库实测取证撰写 | — |
| v1.1 | 2026-10-16 | **评审修订**：B1 周期上限对齐事件保留期并加覆盖率降级、B2 工作量口径无 actual 字段改为三选一裁决、B3 更正 `PRD_CONTEXT_LIMIT` 引用错误并解多项目提示词矛盾；I1 范围改复用页面级选择器、I2 问题页拆两栏、I3 叶子里程碑渲染分支、I4 更正复用度（kickoffService 单项目签名）、I5 补 `buildPptx` 路径对比与 `gatherReportData` 数源复用；S1~S4 详见评审报告 | **已批准** |
| v1.2 | 2026-10-24 | **文档裁决修订（不改 S3/S4 行为）**：① T02957 方案 A——合并版页数四处口径统一为 `6 + 4N`，A.2 的 N=3 示例 20→18 页并删去实现中不存在的「共性风险」页；② T02959 方案 A——§6.1 与 §3.5 的 dataKey 词表对齐 `SUMMARY_DATA_KEYS` 12 键（`kpi/highlights/milestones/planRows/risks/workload/deliverables/nextSteps/summary/appendix/compare/horizontal`），补「代码为单源」说明，旧 7 键（`projectInfo/periodStats/issues/coverage/events/nextPlans/crossProject`）退役 | **已批准（用户 2026-10-24 裁定）** |
| v1.3 | 2026-10-24 | **范围收缩（T02960 方案 B）**：FR-2.3 三档版式预设（商务蓝/墨灰/常青）移出本期，本期仅标准版式、面板不提供版式/配色选择器；§7「UI 视觉」同步；三档预设留口为 §5.3 的 E-8。§8 验收 1~15 原本就没有版式预设项，无需删条 | **已批准（用户 2026-10-24 裁定）** |
| v1.4 | 2026-10-25 | **复议恢复（T02960 方案 A）**：撤销 v1.3 的范围收缩，FR-2.3 恢复三档版式预设（商务蓝/墨灰/常青）；S4 装配器接 `style` 枚举、S5 SSE 透传、S6 面板加选择器（默认商务蓝）；未传 `style` 与显式传商务蓝的产物逐字节等价；原 §5.3 E-8 留口随之关闭 | **已批准（用户 2026-10-25 裁定方案 A）** |

### 审批签字（2026-10-16）

**批准人**：业主（MTask 负责人）｜ **批准日期**：2026-10-16｜ **批准方式**：对评审报告收口问题（A-5 工作量口径 / A-6 多项目例外范围）确认「是」，其余四项按建议值一并签字。签字值见 §11；批准后已按 §9 回写项目计划（S0~S8 九项），回写记录见 §12。

### v1.1 修订清单（评审驱动）

| 编号 | 级别 | 问题 | 处置 |
|---|---|---|---|
| B1 | 阻塞 | 自定义周期上限 92 天 > `task_events` 保留期 90 天，长周期下「本期动态/本期完成」**静默失真**，违反 PRD 自身 G4 | 上限改 90 天；新增校验项 S9「事件覆盖率」；FR-5.4 增「实际覆盖窗口」页脚声明；§10 增 R7 |
| B2 | 阻塞 | `estimate_items` 无 actual/done_at 字段（`schema.ts:427-440`），「本期完成人天」**不可算**，现写法会给客户无法溯源的数字 | FR-5.8 改三口径；新增裁决 **A-5**；§7 质量控制增「工作量口径声明」；§10 增 R8 |
| B3 | 阻塞 | 误把 `PRD_CONTEXT_LIMIT=6000`（PRD **原文注入**上限）当全局提示词上限，且与「每项目 1500 字符 × 8 项目」自相矛盾（12000 > 6000） | §6.2 改为按项目数自适应预算（Σ≤6000）+ 指明真正硬约束是 `ai_tools.max_tokens/timeout_ms` |
| I1 | 重要 | 面板新建项目勾选器，与页面级 `ProjectScopePicker`（`ReportPage.tsx:958`）重复且可能与顶部选区冲突；未声明与 T02190 口径（多选时 kickoff 产物仍单项目）的关系 | FR-2.2 改为消费 `report.projects` 会话态 + 卡片级覆盖开关；新增裁决 **A-6**；S6 量级 L→M |
| I2 | 重要 | `prd_issues` 是「PRD 待确认问题」（`schema.ts:282-283`），非执行风险，混用会误报 | FR-5.7 拆「需求待确认 / 执行风险」两栏，并声明系统**无风险实体** |
| I3 | 重要 | 叶子里程碑无子项时 progress 不聚合（`milestoneProgress.ts:66-67` 保留人工值），时间线会画成 0% 误导 | FR-5.5 按 `milestoneHasChildren`（`:121`）分两类渲染 |
| I4 | 重要 | 「已具备完整 PPT 生成管线」高估复用度：`kickoffService` 四个对外函数全为 `projectId: string` 单项目签名（`:282/:495/:908/:1144`） | §1.2 该行限定为「版式层 + 端点范式已具备」；S2/S4 量级 M→L |
| I5 | 重要 | 未说明为何不复用 `report-builder.buildPptx`（`:247`，**已支持多项目**），也未指出 `gatherReportData(period, projectIds)` 可直接当数源 | §1.2 新增该行；§6.1 标注三个 dataKey 零新查询 |

**审批检查点（文档完整性 + 业务决策）**：① §1.4 非目标 N1~N5 确认；② §11 六项裁决（A-1 批量默认模式 / A-2 zip 白名单扩展 / A-3 留档表 / A-4 自定义周期 / **A-5 工作量口径（评审新增）** / **A-6 多项目例外范围（评审新增）**）；③ §8 验收标准 15 条逐条过。批准后才按 §9 回写项目计划，**本 PRD 不自动写入计划**。

---

## 1. 项目概述与目标

### 1.1 一句话

在 AI 控制台（能力卡片页）新增第 8 张卡片 **「阶段性项目总结汇报 PPT 生成」**：按**汇报周期**（日报/周报/月报/自定义区间）与**项目范围**（单项目/多项目批量）读取项目管理模块已沉淀的数据（任务进度、计划执行、里程碑、问题、交付物、工作量），由 AI 组织成一份**原生可编辑 .pptx** 的阶段总结汇报材料——单项目一份完整汇报稿，多项目可一键产出合并汇报稿（或分别独立稿打包），告别手工誊数据做周报/月报 PPT。

与第 7 张卡「项目启动会 PPT 生成」（T02107）的分工：**kickoff 面向"项目开始一次"**（范围/计划/团队全景）；**本卡片面向"项目周期滚动"**（本期做了什么/里程碑走到哪/有什么问题/下阶段干什么），核心差异是**周期维度**与**多项目批量**。

### 1.2 现状与证据（本次实测，全部只读）

| 事实 | 实测证据 | 对本功能的约束 |
|---|---|---|
| 「AI 控制台」卡片页是 `ReportPage.tsx`，现共 **7 张卡**，第 7 张为 kickoff-ppt | `web/src/pages/ReportPage.tsx:584 const reportCards`（卡片定义 `:585-635`，kickoff-ppt 在 `:626`）；卡片组件 `ReportCard`（`:85-112`） | 新卡片是**第 8 张**，数组尾部追加；复用 `ReportCard` DOM/样式，**不得新造卡片组件**；面板互斥开关加 `summary-ppt` key（对齐 `:542 togglePanel` 与 kickoff 的 `panelSetters` 范式） |
| **本仓已有 2 条 pptx 生成路径，且只有版式层可直接复用**（评审修订 I4/I5） | ① **版式/装配侧**：`kickoffService.ts`（`preflight:282`/`collectBundle:495`/`KICKOFF_LAYOUTS:546`）、`kickoffBuilder.ts`（`blocksForKey:317`/`timelineBlocks:474`/`sanitizeBullets:577`/`fitTableRows:636`/`pageViolations:1126`/`drawBlock:1170`）、`kickoff-layout.ts`（`assertInBounds:96`/`stackY:121`/`findOverlaps:161`/`assertContrast:204`，**通用函数可直接 import**）；端点先例 `server/src/routes/plans.ts:60/63/78`（preflight/outline/stream）+ `exportGate(REPORT_GATE)`（`plans.ts:78`、`export-gate.ts:30`）<br>② **数据报表侧**：`report-builder.ts:247 buildPptx(data: ReportData, aiInsight?)`，**已支持多项目**（T02165 `scopeLine/scopeSuffix`），但版式仅「标题页+统计表+明细页」，无断言层/时间线/图表<br>**关键限制**：`kickoffService` 四个对外函数**全部是 `projectId: string` 单项目签名**（`:282/:495/:908/:1144`） | 主路径沿用 pptxgenjs + 版式断言层 + worker 池 + SSE + 导出闸（**零新增依赖**）；**新增的是多项目采集与周期维度装配器**，不是新 PPT 引擎。S2/S4 量级因单项目假设不成立而上调为 L |
| **`gatherReportData` 可直接当数源，三个 dataKey 零新查询**（评审修订 I5） | `ReportService.ts:266 gatherReportData(period, projectScope?)` 已返回多项目 `ReportData`：`projects[]`（per-project total/todo/done/verified/high/medium/low，`:283-300`）、`tasks[]`、`plans[]`（含 `overdue` 判定）、`projectScope[]`（`:61-66`） | §6.1 的 `periodStats`/`planRows`/`crossProject` 直接消费其返回，不另写聚合查询；仅 `milestones/issues/events/deliverables/nextPlans` 需新查 |
| **页面已有项目范围多选器**（评审修订 I1） | `web/src/pages/ReportPage.tsx:958 <ProjectScopePicker projects={projects} value={projectIds} onChange={setProjectIds} />`；`:428` 会话键 `useSessionState<string[]>('report.projects')`；T02190 口径注释（`:571-577`）：**顶部可多选，但 kickoff 产物仍单项目（`projectIds[0]`）+ 角标明示** | 本卡片**不新建勾选器**，默认消费 `report.projects`（§3.2 FR-2.2）；「多项目合并产物」是 T02190 口径的首个例外，须裁决 **A-6** |
| **`task_events` 有 90 天保留期，长周期会静默失真**（评审修订 B1） | `server/src/services/EventRetention.ts:23 DEFAULT_RETENTION_DAYS = 90`；配置键 `events.retentionDays`（`:19`，`0 = 不清理`，上限 10 年）；定时清理走 `idx_task_events_proj`；行注释 `:6-9` 说明事件是「过程留痕」保留 90 天对业务无损 | 「本期动态/本期完成」依赖事件，**周期跨度 > 保留期即部分缺失**；必须探测覆盖率并显式声明覆盖窗口（§3.3 S9、FR-5.4），否则违反 G4「不静默出劣稿」 |
| **报表周期机制已存在且刚修复**（T02157） | `server/src/services/ReportService.ts:12 export type ReportPeriod = 'day' \| 'week' \| 'month'`；`:224-241 periodRange`（日报=[今天,明天)、周报=[本周一,下周一)、月报=[本月1号,下月1号)——T02157 修正了月报起点；`:244 PERIOD_LABEL`；`:480 REPORT_PERSONA` 周期口吻表 | 本卡片周期**直接复用** `ReportPeriod` 与 `periodRange`，不另造周期语义；自定义区间为对 `periodRange` 的参数化扩展（§3.2，改动受回归门禁守护） |
| **多项目聚合范围已存在**（T02165） | `ReportService.ts:70 REPORT_PROJECT_MAX=8`；`:93-111 validateProjectIds`（空=全部、超上限拒绝、不存在的 id 点名）；`:76 normalizeScope`；`gatherReportData(period, projectScope)`（`:266`）已支持 `project_id IN (…)`；`console_jobs.project_ids`（`server/src/db/schema.ts:584-586`）为「周期类任务多项目范围持久化」先例 | 批量多项目**复用** `validateProjectIds` 与 8 项目上限，不新造范围校验；范围入参形态对齐既有口径 |
| 项目管理侧数据源端点齐备（全部真实存在） | PRD 文档 `prd_docs`（`schema.ts:272-279`，含 `status` `:547`）；需求矩阵 `prd_requirements`（`schema.ts:203-215`）；计划 `plan_tasks`（`schema.ts:184-199`，含 `kind` `:492` normal/milestone/daily、`complexity` `:506`、`deps` `:491`、`req_ids` `:533`、`archived` `:574`）；测试用例 `test_cases`（`schema.ts:376-398`，含 `priority` P0~P3、`last_result`）；估算 `estimate_items`（`schema.ts:427-440`，三点 optimistic/likely/pessimistic）；问题清单 `prd_issues`（`schema.ts:284-294`，含 `level` `:551` blocker/suggested/info）；任务事件 `task_events`（`schema.ts:219-227`，kind=status/verified/ai_state/result，`TaskService.ts:183-184`） | 前置校验（§3.3）与取数（§6.1）**只消费这些表/端点**，不新建聚合端点、不改各端点语义 |
| 任务事件流有现成查询能力 | `TaskService.ts:459 listEvents({projectId, limit, since})`；REST `GET /api/events/recent`（`server/src/routes/index.ts:428`） | 「本期动态」章节的数据源；按周期区间过滤 |
| 里程碑有聚合口径 | `plan_tasks.kind='milestone'`（`schema.ts:492`）；`server/src/services/milestoneProgress.ts:63 recalcMilestoneProgress`（progress=round(done/total)）、`:132 reconcileMilestoneProgresses` | 「里程碑进展」页**读聚合后的 progress 字段**，不自行重算子项（防口径分叉） |
| 计划状态四值 | `server/src/services/PlanService.ts:84 const PLAN_STATUSES = new Set<PlanStatus>(['todo','doing','done','blocked'])` | 「计划执行情况」页按四值分桶；`blocked` 与逾期（`end_date < 今天 && status != 'done'`，判定期先例 `ReportService.ts:323-326`）进风险页 |
| 产物落盘与下载链路齐备；白名单原稿不含 zip，已按 **A-2 裁决**扩展 | 下载端点 `POST /api/report/ai-download`（`server/src/routes/index.ts:1824`，令牌换文件、下载即删）；文件名白名单 `DOWNLOAD_NAME_RE`（`server/src/util/export-name.ts:14`，单源；A-2 后含 `pptx|zip`）；MIME 映射（`routes/index.ts:1831-1836`，xlsx/docx/pptx/pdf/zip）；zip 能力：`server/package.json` 直依赖 `"pizzip": "^3.2.0"` | 单 deck 下载**零改动复用** ai-download；批量「分别独立版」的 zip 交付按 **A-2（已批准）**白名单加 `zip` 扩展名 + MIME `application/zip`，沿用同一条正则单源，不新开校验口子 |
| AI 调用只支持文本 chat，**无图片/vision 输入** | `server/src/services/AIService.ts`（`askJson` temperature=0、解析失败重试 1 次）；`server/src/adapters/` 仅 chat/chatStream | 幻灯片配图只走 pptxgenjs 原生形状/图表；**不得**承诺「AI 生成插图」；AI 只产措辞，数字一律本地填充（§3.4 步骤 4） |
| `PRD_CONTEXT_LIMIT` 只约束 **PRD 原文注入量**，不是全局提示词上限（评审修订 B3） | `server/src/util/prdContext.ts:24-25`：`PRD_CONTEXT_LIMIT = 6000`，注释为「PRD **上下文截断长度**；超长时保头保尾」——只管反查命中的 `prd_docs.content_md` 注入量。报表链路的提示词规模实际靠 `handleResult.slice(0,600)`（`ReportService.ts:309`）+ `ai_tools.max_tokens`（默认 4096，`schema.ts:74`）/ `timeout_ms`（`:75`） | §6.2 不得以 6000 作「总提示词上限」；多项目合并大纲须**按项目数自适应预算**（Σ≤6000），真正硬约束是模型侧 `max_tokens`/`timeout_ms` |
| 长耗时 AI 生成的既有范式是 **SSE 流** + 导出并发闸 | `routes/plans.ts:78` kickoff-ppt-stream 挂 `exportGate(REPORT_GATE)`；`server/src/util/export-gate.ts` 内存信号量（上限 2，超限 429）；前端 `web/src/api/sse.ts` | 新端点必须走 `*-stream` 形态，复用 SSE 客户端；**不用** queues/queue_jobs（外部 Agent 批量通道，非本场景） |

### 1.3「不存在」的取证口径（供复核）

- grep 范围：`server/src`、`web/src`、`electron/`，排除 `node_modules`、`docs`、`perf`。
- `summary_ppt\|SummaryPpt\|阶段性总结` → **0 命中**（本功能确为新增，无撞名）；`archiver\|jszip` → 不在 `server/package.json` dependencies（仅 node_modules 传递依赖，**不得**直接 import）；`shell.openPath\|showSaveDialog` → 0 命中（沿用下载端点范式）；`python` → 仅注释命中（不引 Python 运行时，同 kickoff N1 结论）；`zip` 于 `DOWNLOAD_NAME_RE` → 未覆盖（`export-name.ts:14`）。

### 1.4 目标 / 非目标

**目标**
- G1：一张卡片、一条 SSE 链路产出**原生可编辑** .pptx（文本框/表格/图表是 PowerPoint 对象，非整页截图）。
- G2：**周期维度**——日报/周报/月报/自定义区间四档，口径与既有报表严格一致（复用 `periodRange`）。
- G3：**批量多项目**——勾选 N 个项目一次产出；默认合并版（单 deck 分项目章节），可选分别独立版（zip）。
- G4：资料不齐时**不静默出劣稿**——前置校验点名缺什么、怎么补，「可降级」与「硬阻塞」分流。
- G5：**数字防幻觉**——所有数字（完成数/进度/人天/覆盖率）本地从库内计算，AI 只写措辞；每页脚注带数据截至日期，可回溯系统内视图。

**非目标（本期明确不做，需审批确认）**
- N1：**不做** .pptx 母版/模板文件套用（装机版不含 Python 运行时，同 kickoff N1；E-1 留口）。
- N2：**不做** PPT 在线预览编辑器（产物交 PowerPoint/WPS；参照 PPTist/open-slide 属独立项目量级）。
- N3：**不做** AI 生成插图/文生图（AIService 无 vision 能力）。
- N4：**不做** 自定义 HTML 幻灯渲染链（Marp/Slidev 路线产物不可编辑，§5.2 实证排除）。
- N5：**不新增依赖**（pptxgenjs/pizzip 已在位）、**默认不新增数据库表**（§3.7 的留档表由 A-3 决定）。

### 1.5 术语表（与现系统对齐，禁止另造词）

| 术语 | 定义 | 系统对应 |
|---|---|---|
| AI 控制台 | 能力卡片页 | `web/src/pages/ReportPage.tsx`（`reportCards:584`） |
| 汇报周期 | 数据统计时间窗 | `ReportPeriod`（`ReportService.ts:12`）+ 自定义区间（§3.2） |
| 项目范围 | 参与聚合的项目集合 | `validateProjectIds`（`ReportService.ts:93`），上限 8 |
| 合并版 | 多项目产出单份 deck，分项目章节 | §3.6（默认） |
| 分别独立版 | 每项目一份 deck，zip 打包 | §3.6（A-2 已批准） |
| 里程碑 | 阶段节点计划行 | `plan_tasks.kind='milestone'`（`schema.ts:492`） |
| 大纲先行 | 先生成议程大纲供确认，再逐页装配 | `stage` 事件 `outline_ready`（§4.2） |
| 数字本地填充 | 数字型内容由库内计算注入，不经 LLM | §3.4 步骤 4（dataKeys 机制） |

---

## 2. 用户角色与场景

| 角色 | 场景 | 痛点（现状） | 使用路径 |
|---|---|---|---|
| **项目负责方（乙方 PM，主要用户）** | 每周/每月/每阶段要向甲方或内部汇报项目进展 | 数据都在 MTask 里，但要手工誊到 PPT，1~3 小时且每次口径不一 | 卡片 → 选周期 → 选项目（可多选）→ 前置校验 → 改大纲 → 生成 → 下载 pptx → PowerPoint 润色 |
| 多项目负责人（组合管理） | 同时管 3~8 个项目，月底要一份横向对比汇报 | 每个项目单独做再手工拼，数字还对不齐 | 卡片 → 周期=月报 → 勾选全部项目 → 合并版一键出稿 |
| 交付/实施同事 | 接手客户沟通，需要「进展+问题+计划」一页看懂 | 甘特只能截图，字号失真 | FR-5.5/5.6 用 pptxgenjs 原生表格与形状（可编辑） |
| 客户方项目负责人 | 会上逐页质询「进度依据、问题依据」 | 手工 PPT 无溯源 | FR-5.12 每页脚注带「数据截至 <ISO 日期>」+ 附录资料清单，可回溯系统内视图 |
| 开发/评审者（内部） | 复核 AI 产出是否编造 | LLM 直出整稿难定位 | G5 数字本地填充 + 大纲先行 + 控制台逐页 stage 留痕 |

**核心场景（Happy path）**：mtask四期本周有 12 条任务 done、2 个里程碑推进、1 条 blocker 问题 → 打开卡片 → 周期=周报（默认）→ 校验通过 → 大纲确认（删掉「测试与质量」，因无用例）→ 生成 14 页 → 下载 `项目总结汇报-mtask四期-20261016.pptx`。

**反例场景（必须友好处理）**：周期内零活动项目（任务无更新、计划无变动）→ 校验报「本周期内无任何活动数据」并引导切换周期或补充，**不允许**生成一份全「无」的空壳稿（FR-3.4 硬阻塞）。

---

## 3. 功能需求详解

### 3.1 FR-1 新增能力卡片

| 编号 | 需求 | 落点（改动点） |
|---|---|---|
| FR-1.1 | `reportCards` 数组尾部追加：`{ key:'summary-ppt', title:'阶段性项目总结汇报 PPT 生成', desc:'按汇报周期与项目范围自动装配阶段总结汇报材料（原生可编辑 .pptx）', hint:'周期内至少有 1 个项目有活动数据' }` | `web/src/pages/ReportPage.tsx:584`（第 8 张，对齐 kickoff-ppt `:626` 的文案长度与 hint 风格） |
| FR-1.2 | 卡片渲染复用 `ReportCard`（图标 + 标题 + 描述 + hint + 运行中 glow），色值只走 CSS 变量 | `ReportPage.tsx:85-112`、`:691` 映射处；**禁止**硬编码新色值 |
| FR-1.3 | 面板互斥开关加 `summary-ppt` key；展开区挂载新工作面板 `SummaryPptPanel` | `ReportPage.tsx:542 togglePanel` 及 panelSetters 组（对齐 kickoff 的 `:758+` 挂载范式） |
| FR-1.4 | 控制台过程留痕：新增 tab（id 常量集中在 `ReportConsole.tsx:69-78`），逐页生成按 SSE `stage` 事件写入 | `web/src/pages/ReportConsole.tsx:69-78`；复用现有 tab 内容组件 |
| FR-1.5 | 未选项目/周期时的按钮态与确认框，走 `web/src/ui/dialogs.tsx`（不用原生 alert/confirm） | `SummaryPptPanel` 内 |

### 3.2 FR-2 汇报周期与项目范围（本卡片核心差异）

**FR-2.1 周期四档**

| 档位 | 区间口径 | 实现 |
|---|---|---|
| 日报 | [今天 0 点, 明天 0 点) | 直接复用 `periodRange('day')`（`ReportService.ts:227-229`） |
| 周报（默认） | [本周一 0 点, 下周一 0 点) | 复用 `periodRange('week')`（`:230-238`） |
| 月报 | [本月 1 号 0 点, 下月 1 号 0 点) | 复用 `periodRange('month')`（`:239-241`，T02157 已修正） |
| **自定义** | [用户选起始日 0 点, 用户选结束日+1 天 0 点) | **参数化扩展**：`periodRange(period, custom?)`，前三档行为逐字不变（回归安全）；自定义经 `ymd`（`ReportService.ts:245`）本地时区解析，与既有「避免跨日误判」口径一致 |

> 约束（评审修订 B1）：自定义区间上限 **90 天**（原 92）——与 `task_events` 默认保留期 `EventRetention.ts:23` 对齐；起始日不得晚于结束日；结束日不得晚于今天（不汇总未来）。若用户把 `events.retentionDays` 调小（如 30 天），周期超出**实际保留期**的部分按 S9 降级声明，不静默丢数。

**FR-2.2 项目范围（评审修订 I1：默认消费页面级选择器，不新建勾选器）**
- **范围来源**：默认取页面顶部 `ProjectScopePicker` 的选择（`ReportPage.tsx:958`，会话键 `report.projects`，跨面板/跨页保持）；面板内提供**「本卡片另选项目」覆盖开关**，开启后在面板内多选（仅本次生成生效，不改顶部选区），两者不一致时以卡片覆盖值为准并在卡片 hint 提示「本次不跟随顶部范围」。
- 单选：单项目汇报稿（完整 12 章）。
- 多选：1~8 个项目，走 `validateProjectIds` 同款校验（超限拒绝、不存在 id 点名，`ReportService.ts:93-111`）。
- 不选（全部项目）：等价于勾选当前全部未归档项目；项目数 >8 时提示收窄，不静默截断。
- **与 T02190 口径的关系**：既有口径为「顶部可多选，但启动会 PPT 产物仍单项目（`projectIds[0]`）+ 角标明示」（`ReportPage.tsx:571-577`）。本卡片的多项目合并产物是该口径的**首个例外**，须经裁决 **A-6** 确认；例外仅限本卡片，不改动 kickoff 行为。

**FR-2.3 版式**：提供 **3 档版式预设**（商务蓝 / 墨灰 / 常青），色值单源取 `server/src/util/exportStyle.ts` 的 `DECK_STYLES`，面板内可视化选择、默认「商务蓝」。缺省/未传 `style` 与显式传 `standard` 等价，产物与既有标准稿**逐字节一致**；三档只改页标题/章节编号/页脚主色，不改版式几何。非法枚举返回 400 并点名可选值。**不读外部模板文件**（N1）。

### 3.3 FR-3 前置校验机制（资料齐备性）

一次 `GET /api/plans/summary-preflight?period=&projectIds=` 聚合返回（服务端直接复用现有 Service 查询，只读零 AI 消耗）：

| 编号 | 校验项 | 数据源（真实表） | 判定 | 缺失时提示 |
|---|---|---|---|---|
| S1 | 周期内活动数据 | `tasks.updated_at` 落在区间（口径同 `gatherReportData`，`ReportService.ts:266+`） | `count ≥ 1`（任一项目） | **硬阻塞**：换周期/先去任务页活动；给「任务管理」深链 |
| S2 | 项目计划 | `plan_tasks`（`archived=0`） | `count ≥ 3` 且 `start_date` 非空率 ≥ 60% | 「从 PRD 导入项目计划」卡片深链；点名几条缺日期 |
| S3 | 里程碑 | `plan_tasks.kind='milestone'` | `count ≥ 1` | 可降级：进展页改「按阶段分组」并页脚注记 |
| S4 | 需求矩阵 | `prd_requirements` | `count ≥ 3` | 可降级：需求页只写统计不列表 |
| S5 | PRD 文档 | `prd_docs`（`status='confirmed'` 优先） | `count ≥ 1` | 可降级：背景页只写项目 description |
| S6 | 测试用例 | `test_cases` | 可选；有则出覆盖率 | 降级：质量页写「本期未建用例」 |
| S7 | 估算数据 | `estimate_items` | 可选 | 降级：工作量页走 `Σ duration_days` + 页脚「工期口径」声明（同 kickoff FR-4.6 口径） |
| S8 | 工作空间 | `projects.workspace_path` | 可选 | 降级：技术素材页省略 |
| S9 | **事件覆盖率**（评审修订 B1） | `task_events` 保留期 vs 周期跨度：比较 `now - readEventRetentionDays()`（`EventRetention.ts:37`）与周期起点 | 周期起点 ≥ 保留期边界 → ✓；否则 ⚠ | ⚠ 时「本期动态」页降级并在**页脚声明实际覆盖窗口**（如「事件仅覆盖最近 30 天，更早动态已被保留策略清理」）；不静默丢数 |

- **FR-3.2 呈现**：面板 checklist（✓/⚠/✕ + 条数 + 一句「怎么补」）；⚠ 级（可降级继续）必须在**生成的 PPT 页面上显式留痕**（页脚小字），不允许只在 UI 提示。
- **FR-3.3 硬阻塞**：S1 ✕ 或 S2 ✕ → `blocked:true` + 深链，生成按钮置灰（避免空壳稿）。S9 ⚠ **不阻塞**，但强制降级留痕。
- **FR-3.4 一致性**：校验只读，不触发写入或 AI 调用（零配额消耗）。

### 3.4 FR-4 生成流程（outline-first，两段 AI + 一段本地装配）

1. **采集**：并发读 S1~S8 数据（服务端 Service 层直接取，不走 HTTP 自环）；多项目时按 `validateProjectIds` 归一后的顺序逐项目采集。
2. **大纲**：1 次 `AIService.askJson`（temperature=0、失败自动重试 1 次）→ 输出 `[{ section, title, bullets[], dataKeys[], layout }]`，页数约束：单项目 12~16 页、多项目合并版 `6 + 4N`（N=项目数）且 ≤40 页。
3. **人工确认**：面板内可改标题/增删页/调顺序（内存态，不落库）；确认后发第 2 段。
4. **取数填充**：本地装配器按 `dataKeys` 从采集结果取数——**数字类内容一律本地填充，不经 LLM**（完成数、进度%、人天、覆盖率、逾期数——避免幻觉改数）。
5. **逐页渲染**：pptxgenjs（worker 池，先例 `report-worker.ts`），每页发一条 SSE `stage` 事件（`page <n>/<N> 已装配`）。
6. **版式自检**：出 Buffer 前跑 `kickoff-layout.ts` 断言（§6.3），越界即该页降级为「标题 + 正文」安全版式并记入 `warnings[]`。
7. **交付**：Buffer + 下载令牌（下载即删、单次有效）；多项目分别独立版追加 zip 打包（A-2）。

### 3.5 FR-5 PPT 章节定义（单项目完整稿，顺序固定，可删页）

| 编号 | 章节 | 数据键 → 数据来源（真实字段） | 版式 | 缺失降级 |
|---|---|---|---|---|
| FR-5.1 | 封面 | —（`layout=cover`，无 dataKey）项目名 + 周期标签 + 生成日期 | cover | — |
| FR-5.2 | 目录 | —（`layout=toc`，无 dataKey）本地取章节标题（不由 AI 写） | toc | — |
| FR-5.3 | 总体进展 | `kpi`：`tasks` 周期内完成/todo/verified 统计；`plan_tasks.progress` 均值；里程碑 progress 汇总 | KPI 卡（chip） | 无任务活动 → S1 硬阻塞已拦 |
| FR-5.4 | 本期重点工作 | `highlights`：①「本期**有活动**的任务」：`tasks.updated_at` 落区间（口径同 `gatherReportData`，即周期内被改动过，**不等于本期完成**，§6.1 `kpi` 注）+ 本期 `status='done'` 的计划/任务（按 `end_date<=今天` 或人工核对，页脚标注口径）；②「本期关键动态」：`task_events` 区间过滤（`TaskService.ts:459`），**覆盖窗口受 S9 约束**，超出保留期部分按 S9 声明 | 列表（list） | 无事件 → 只列完成项并注明「事件无记录」 |
| FR-5.5 | 里程碑与阶段进展 | `milestones`：`plan_tasks.kind='milestone'`：**按 `milestoneHasChildren`（`milestoneProgress.ts:121`）分两类渲染**——① 有子项：显示聚合 progress + `done/total`（读 `recalcMilestoneProgress:63` 结果，**不自行重算**）；② 无子项：progress 是人工填报值（无子项时聚合直接保留原值，`:66-67`），**不画进度条**，改按 `status` 显示「未开始/进行中/已完成」并标注「人工填报」 | 时间线（timeline，菱形+进度条；叶子里程碑用状态徽标替代进度条） | 无里程碑 → 按 `kind='normal'` 阶段分组 + 页脚注记 |
| FR-5.6 | 计划执行情况 | `planRows`：`plan_tasks` 四态（`PlanService.ts:84`）分布 + 逾期清单（`end_date < 今天 && status != 'done'`）+ `blocked` 清单 | 表格 + 饼图 | 无逾期/blocked → 写「本周期无延期与阻塞」 |
| FR-5.7 | 问题与风险（**两栏，评审修订 I2**） | `risks`：**左栏「需求待确认」**——`prd_issues`（`question/level/status/answer`，`schema.ts:284-294`）——注意这是 **PRD 待确认问题**（需求澄清，`schema.ts:282-283` 注释），**不是执行风险**；**右栏「执行风险」**——本地规则枚举：逾期计划 + `blocked` 计划 + `complexity ≥ 4`（`schema.ts:506`）行数 + 里程碑未达成数；`prd_issues` 中 `level='blocker'` 的待确认项在左栏置顶 | 双栏表格 | 无命中 → 「系统内暂无风险信号，会上补充」。**能力声明（须写入页脚）**：本仓**无风险/问题登记实体**，风险全部由规则推导，不含人工登记的风险条目；客户问「你们登记了哪些风险」时需现场/文档补充——缺口列为 **E-6** |
| FR-5.8 | 工作量与质量（**三口径，评审修订 B2**） | `workload`：**`estimate_items` 无 actual/done_at 字段**（`schema.ts:427-440` 只有 optimistic/likely/pessimistic + plan_id），是**计划级**估算 → **「本期完成人天」不可从库内真实计算**。三口径择一（裁决 **A-5**）：① **累计口径**：展示截至当前的累计估算人天/完成计划人天，页脚「累计估算，非本期实测」；② **分摊口径（A-5 明令禁用，实现侧抛错）**：按本期 done 计划在总估算中的占比分摊，页脚须声明「分摊值非实测，仅供趋势参考」；③ **不报人天（A-5 签字默认）**：只报完成工作项数与工期消耗。`test_cases` 覆盖率与 P0~P3 分布**并入本页同一数据键**取数（`workload`，不再单列 `coverage`） | 表格 + 柱图（口径①/③不画人天柱图，改画完成项数/工期） | 无估算 → 页脚「工期口径，非三点估算」；无用例 → 文字策略 |
| FR-5.9 | 交付物清单 | `deliverables`：`prd_docs`（文档交付）+ `estimate_snapshots`（估算交付，`schema.ts:447-454`）+ 本期完成的计划/任务（功能交付） | 表格 | — |
| FR-5.10 | 下阶段计划 | `nextSteps`：未完成计划按 `start_date` 排序（Top N）+ 下一里程碑 + `deps` 关键路径提示（`schema.ts:491`） | 列表 | 全部完成 → 「项目已收尾」页 |
| FR-5.11 | 本期总结与展望 | `summary`：**仅 AI 措辞**（`askJson` 第 2 段），允许引用本页其它 dataKey 取到的原文片段，禁止引入库外事实 | 图文双栏 | — |
| FR-5.12 | 附录 | `appendix`：S1~S9 条数 + 各资料 `updated_at` + 项目名 + `workspace_path` + 降级标记汇总 | 表格 | — |

> **数据键单源（T02959 方案 A）**：上表「数据键」列与 §6.1 同源，权威定义是 `SUMMARY_DATA_KEYS`；合并版的 `compare` / `horizontal` 两键见 FR-6.1。新增或改名必须三处同步（代码 / §3.5 / §6.1），否则 S3 会以「含未知项」硬失败、S4 取不到块。

**FR-5.13 逐页脚注**：每页脚注固定「`<项目名> · <章节> · 数据截至 <ISO 日期>`」，来源可回溯系统内视图。

### 3.6 FR-6 批量多项目机制（合并版 / 分别独立版）

**FR-6.1 合并版（默认）**：单份 deck，结构 = 封面 → 目录 → **汇总对比页**（各项目 KPI 横表：任务完成/计划进度/里程碑进度/逾期数/blocker 数）→ 每项目一组小结页（总体进展、里程碑进展、问题 Top3、下阶段计划，4 页/项目）→ **横向对比页**（工作量/进度柱图，pptxgenjs 原生图表）→ 本期总结 → 附录。页数 = `6 + 4N ≤ 40`（T02957 方案 A：按枚举逐项计数，封面/目录/汇总对比/横向对比/本期总结/附录 共 6 页 + 每项目 4 页）。

**FR-6.2 分别独立版（可选，A-2）**：每项目独立完整稿（FR-5 全 12 章），N 份 pptx 经 `pizzip`（`server/package.json` 直依赖）打包为单 zip 交付。
- **约束（A-2 已批准，已落地）**：下载白名单 `DOWNLOAD_NAME_RE`（`server/src/util/export-name.ts:14`）原稿不含 zip、MIME 映射（`routes/index.ts:1831-1836`）亦无 zip → 两处已同步扩展（正则加 `zip`、MIME 加 `application/zip`），仍过同一条白名单；若不扩展则该模式降级为「前端逐份触发下载」（N 次 ai-download，体验次之但零后端改动）。

**FR-6.3 数据隔离**：各项目数据严格按 `project_id` 分区，汇总页数字 = 各项目分区数字之和（本地计算，不经 AI）。

### 3.7 数据模型

- 本期**不新增表**（N5），装配全部内存态。
- 可选（审批项 **A-3**）：`summary_ppt_logs(id, project_ids, period, page_count, warnings, created_at)` 留档「生成历史」，沿用 `schema.ts` 建表清单 + `ensureColumn` 幂等范式；不做则日志仅进控制台 SSE 流（同 kickoff A-3 结论）。

---

## 4. API 接口定义

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plans/summary-preflight?period=&projectIds=` | §3.3 校验聚合，返回 `{ items:[{key,count,status,note,deepLink}], blocked, missingHard, periodRange:{start,end} }`；只读、无 AI 调用 |
| POST | `/api/plans/summary-ppt-outline` | 第 1 段 AI：body `{ period, projectIds, start?, end?, style? }` → `{ outline:[{section,title,bullets,dataKeys,layout}] }`（`askJson`） |
| POST | `/api/plans/summary-ppt-stream` | 第 2 段：body `{ period, projectIds, outline, mode:'merged'\|'separate' }`，SSE 事件 `stage`（逐页）/`done`（含 `token`、`fileName`、`pageCount`、`warnings[]`、`projects[]`；分别独立版含 `zipToken`，A-2 已批准故随 `done` 直接下发）/`error`；挂 `exportGate(REPORT_GATE)`；客户端断开即 abort（对齐 `routes/plans.ts:78-114`） |
| POST | `/api/report/ai-download` | 令牌换 Buffer（**零改动复用**，`routes/index.ts:1824`；zip 走 A-2 扩展） |

约束：
- `toolId` 必填且取 `ai_tools` 表（`schema.ts:64-84`，端点 `/api/aitools`）；未配置 model 时返 400 + 引导文案（不静默烧配额）。
- `period` 枚举 `day\|week\|month\|custom`；`custom` 时 `start`/`end`（`YYYY-MM-DD`）必填，服务端按 §3.2 规则校验。
- `projectIds` 省略 = 全部项目；>8 或含不存在 id → 400 + 中文文案（复用 `validateProjectIds`）。
- `mode='separate'` 已随 A-2 批准可用（N 份 pptx 打 zip）；非 `merged|separate` 的取值 400 点名。

---

## 5. 竞品调研与优化建议（GitHub 同类项目）

### 5.1 调研方法与样本

2026-10-16 经 WebSearch/GitHub/官方文档实时核对（来源见附录 B），主样本 5 项 + 其他样本 4 项。选取标准：① 与「周期性汇报材料自动生成」场景相关；② 覆盖「可编程库 / AI 生成器 / Markdown 渲染 / Agent 框架」四类技术路线；③ 有可验证的活跃度与许可证信息。

> **数据口径声明（评审建议 S4）**：star / forks 为**检索时点快照且多来源口径不一**（open-slide 数月内从 2.1k 涨到 9.2k，各转载站取值不同），仅用于判断技术路线活跃度，**不作为选型依据**；选型依据是「产物是否原生可编辑」这一硬指标（附录 B 已注明检索日期）。

### 5.2 逐项目结论（只留对本 PRD 有约束力的）

| 项目 | 关键事实（2026-10 检索） | 借鉴点 | 对本 PRD 的落点 |
|---|---|---|---|
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | Node/浏览器同构；产物原生 OOXML；行业内在「周期性报告流水线」（周报/月报/客户报告代码化生成）的默认选择 | 代码化、可版本管理、模板稳定的批量产出 | **主路径**（本仓已锁 `^4.0.1`）；经 `summaryPptBuilder.ts` 单点封装，升级只改一处 |
| [Presenton](https://github.com/presenton/presenton) | ~5k-7k stars、Apache-2.0；Gamma 开源替代；**Standard/Smart 双模式 + 大纲审查检查点**；BYOK（Ollama/OpenAI/Anthropic…）；支持上传自有 PPTX 模板；Electron 桌面 + Docker 自托管；内置 MCP Server；生成 API；导出**完全可编辑 PPTX** | ① 大纲先行 + 确认再生成；② 本地运行隐私；③ 桌面形态 | G4/§3.4 采纳「outline-first」；隐私口径（§7）；Smart 自适应版式列为 E-2 扩展；其「上传自有模板」对应本 PRD N1 非目标（装机无 Python 的约束同 kickoff §6.4） |
| [PPTAgent](https://github.com/icip-cas/PPTAgent) | EMNLP 2025、中科院计算所；两阶段生成（模板 schema→大纲→逐页编辑动作）+ **PPTEval 三维自评**（Content/Design/Coherence） | 逐页粒度失败隔离；质量可量化 | §3.4 步骤 5 逐页 stage（页级失败仅重试该页）；PPTEval 三维转化为**人工验收清单**（§8 可编辑性/数字一致性/版式三条即其落地），不引入自动自评（无 vision 且耗配额，列为 E-4） |
| [Marp](https://github.com/marp-team/marp) / [Slidev](https://github.com/slidevjs/slidev) | Marp ~11.3k stars、Slidev ~48.8k stars、均 MIT；Markdown→幻灯生态成熟；但 PPTX 导出历史上为**整页渲染图/实验特性**（本仓 T02107 期已实证：Slidev 导出=图片捕获；Marp `--pptx-editable` 标 EXPERIMENTAL） | Markdown 内容组织思路 | **排除为主路径**（N4）：产物不可编辑与「汇报后还要改」冲突；本卡片的内容大纲（`KickoffOutline` 式结构）即吸收其「内容与版式分离」思想，但渲染走 pptxgenjs 原生对象 |
| [open-slide](https://github.com/1weiho/open-slide) | 2026-04 开源、数月 2k→9k stars、MIT、TypeScript/React；**agent-native**：自然语言→agent 写 React 页面；1920×1080 固定画布；**浏览器点选批注→AI 应用修改**；演讲者模式；导出 HTML/PDF（**无可编辑 PPTX 导出**） | 批注式迭代交互、画布先行 | 交互范式参照：§5.3「生成后批注式修改」列为 E-3 扩展；**不作为渲染路线**（无可编辑 PPTX，且引入 React 渲染链与 N5 冲突） |

其他样本（简）：[ppt-master](https://github.com/hugohe3/ppt-master)（任意文档→可编辑 PPTX，真实形状+动画——佐证「可编辑」是同类项目共同追求）；[MiniMax-AI/pptx-generator](https://github.com/MiniMax-AI/pptx-generator)（基于 PptxGenJS 的封面/目录/内容/分隔/总结标准结构——佐证 §3.5 章节划分）；[reveal.js](https://github.com/hakimel/reveal.js)（~72k stars HTML 框架，导出 PDF 为主）；[DeckTape](https://github.com/astefanutti/decktape)（HTML 演示→高质量 PDF，E-5 参照）。

### 5.3 优化建议（写进需求，不留在建议层）

- **界面设计**：卡片复用 `ReportCard`（FR-1.2）；面板四段式「周期与范围 → 校验 → 大纲 → 生成/下载」；周期选择器复用报表页既有三值标签风格（`ReportPage.tsx:34-36` 的 day/week/month）；多项目勾选器对齐 `PrdImportPanel` 的项目下拉范式；确认一律走 `dialogs.tsx`。
- **交互体验（UX）**：① 大纲可编辑（G4/§3.4 步骤 3）；② 数字本地填充、AI 只写文字（防幻觉，G5）；③ 逐页进度 + 取消（SSE abort 先例 `routes/plans.ts:78-114`）；④ 生成后 `warnings[]` 明示哪页被降级、哪项走了降级口径，让用户知道去哪儿复核；⑤ **合并版默认**，减少多项目用户的选择负担（A-1）。
- **认知负荷控制**：周期默认「周报」（最高频）；面板顶部常驻一行「本周期：<起> ~ <止> ｜ 项目数 N ｜ 预计 2 次 AI 调用」；降级项在面板与 PPT 页脚双通道留痕。
- **功能模块扩展**（本期不做、按编号留口）：E-1 公司模板母版（依赖 N1 决策）；E-2 Smart 自适应版式（参照 Presenton）；E-3 生成后批注式修改（参照 open-slide）；E-4 PPTEval 式三维自评；E-5 PDF 交付稿（`pdfkit` 在位，字体先例同 kickoff）；**E-6 风险/问题登记实体**（评审新增 I2：本仓无风险表，风险全靠规则推导；需新增可人工登记的风险条目 + 状态流转，汇报页才有"已登记风险"可答）；E-7 工时/实绩字段（评审新增 B2：补 actual 人天字段，工作量页才能报本期实测值）。原 **E-8 版式预设**（商务蓝/墨灰/常青三档）已由 T02960 方案 A 落地（S4 接 `style` 枚举 + S5 透传 + S6 选择器），不再是扩展留口。
- **UI 视觉**：提供三档版式预设选择器（商务蓝/墨灰/常青，默认商务蓝），主色取 `exportStyle.ts` 的 `DECK_STYLES` 单源；正文 ≥14pt、每页 bullet ≤6 行、单行 ≤42 字（超限按 `kickoff-layout.ts` 断言降页，`BULLET_MAX_*` 常量 `:64-67`）。

### 5.4 技术选型结论

主路径 **pptxgenjs（已在依赖内）+ `kickoff-layout.ts` 断言层 + worker 池 + SSE 流 + 原生对象**；周期口径复用 `ReportService.periodRange`；范围校验复用 `validateProjectIds`；不引入 HTML 幻灯渲染链（不可编辑）、不引 Python 子进程、zip 分别独立版已随 A-2 批准启用。

---

## 6. 数据依赖与技术实现说明

### 6.1 取数映射（字段级，便于实现核对）

`SummaryOutline.bullets[].dataKeys` 的**唯一权威**是 `server/src/services/summaryPptOutline.ts` 的 `SUMMARY_DATA_KEYS`（12 键；S3 校验、S4 装配器 `blocksForKey` 与本表同源，T02959 方案 A 对齐）：`kpi | highlights | milestones | planRows | risks | workload | deliverables | nextSteps | summary | appendix | compare | horizontal`。装配器按 key 从采集结果取值；**任何数字型 bullet 必须由 dataKey 解析，不接受 AI 自由文本**。新增/改名键必须同时改代码、本节与 §3.5 的 FR-5 数据键列，并由 `verify-t02855` 的「词表全键可渲染」门兜底；未知键在 S3 硬失败并点名（`含未知项`）。

| dataKey | 表.字段（真实） | 计算口径 |
|---|---|---|
| kpi | **直接消费 `gatherReportData(period, projectIds)`**（`ReportService.ts:266`）的 `projects[]`（per-project total/todo/done/verified/high/medium/low）与 `tasks[]`；另含 `plan_tasks.progress` 均值与里程碑完成数 | FR-5.3 总体进展。口径警示：该函数按 `t.updated_at` 落区间取「**周期内有活动**」的任务（`:271-283`），**不等于「本期完成」**——页面标题须写「本期有活动的任务」，不得写成完成清单。`projects[].done` 亦为「区间内统计到的 done」 |
| highlights | `gatherReportData` 的 `tasks[]`/`plans[]` + `task_events.kind/detail/created_at`（`schema.ts:219-227`）区间过滤，`listEvents({projectId, since})`（`TaskService.ts:459`） | FR-5.4 本期重点工作（活动任务 + 计划态 + 本期动态）；**保留期约束见 S9**（`EventRetention.ts:23` 默认 90 天，可配 0=不清理） |
| milestones | `plan_tasks`（`kind='milestone'`） | FR-5.5。读 progress（`milestoneProgress.ts` 聚合口径），**不重算**；有子项/无子项分支见 FR-5.5 |
| planRows | `gatherReportData` 的 `plans[]`（已含 `overdue` 判定）+ 需要 `duration_days/assignee/kind` 时补一次查询 | FR-5.6 计划执行。四态分桶（`PlanService.ts:84`）+ 逾期沿用其判据 |
| risks | 左栏 `prd_issues.question/level/status/answer`（`schema.ts:284-294`）；右栏本地规则枚举 | FR-5.7 两栏。左栏 `status='open'`、`level='blocker'` 置顶（**语义=需求待确认，非执行风险**，I2）；右栏 = 逾期计划 + `blocked` 计划 + `complexity ≥ 4` 行数 + 里程碑未达成数；**无人工登记风险实体** |
| workload | `estimate_items.optimistic/likely/pessimistic/phase`（`schema.ts:427-440`）+ `test_cases.priority/req_id/last_result`（`schema.ts:376-398`） | FR-5.8 工作量与质量（用例覆盖率与 P0~P3 分布并入本页）。**无 actual/done_at → 无本期实测人天**；三口径见 FR-5.8 与裁决 A-5。缺失降级 `Σ duration_days`（工作日）+ `complexity` 分布；人月因子单源（同估算 PRD） |
| deliverables | `prd_docs` / `estimate_snapshots` / 本期 done 计划 | FR-5.9。三类各列条数与 updated_at |
| nextSteps | `plan_tasks`（`status != 'done'`） | FR-5.10。按 `start_date` 升序 Top N + 下一里程碑 |
| summary | 无库内查询 | FR-5.11 本期总结与展望：正文 = AI 措辞（`askJson` 第 2 段），只允许引用本页其它 dataKey 取到的原文片段 |
| appendix | `preflight.items`（S1~S9）+ 项目名/`workspace_path`（页脚） | FR-5.12。校验项条数与降级标记汇总，fail/warn 优先 |
| compare | **直接消费 `gatherReportData` 的 `projects[]` + `projectScope[]`**（`ReportService.ts:61-66`） | 合并版汇总对比页（FR-6.1），各项目 KPI 横表，零新查询 |
| horizontal | `gatherReportData` 的 `projects[]` + 各项目 `workload` | 合并版横向对比页（FR-6.1），进度/工作量柱图；工作量单位全 deck 一致（A-5） |

### 6.2 AI 侧

- **2 次调用**：大纲（`askJson`）+ 本期总结与展望措辞（`askJson`）。
- **提示词预算（评审修订 B3）**：`PRD_CONTEXT_LIMIT=6000`（`util/prdContext.ts:24-25`）**只约束 PRD 原文注入量，不是全局提示词上限**。多项目合并大纲须**按项目数自适应**：摘要总预算 Σ≤6000 字符（每项目 = 6000/N，N=8 时约 750 字符），统计摘要另计；超限时按项目优先级截断并在大纲事件里带 `truncated` 标记。真正的硬约束是模型侧 `ai_tools.max_tokens`（默认 4096，`schema.ts:74`）与 `timeout_ms`（默认 60s，`:75`），PRD 原文注入另受 6000 保头保尾截断。
- **配额纪律**：面板显示「本次将调用 <toolId> 2 次」，用户确认后才发起；失败仅重试对应段（不做全链重跑）。
- **多项目**：大纲 1 次覆盖全部项目（按上述自适应预算分块）；总结措辞按项目各 1 次（N 次，N≤8，面板明示总数）。

### 6.3 版式质量门禁（复用既有资产）

`kickoff-layout.ts`（`server/src/services/kickoff-layout.ts`）为通用断言层，**直接 import**，不复制不改写：
0. **版式定义独立命名**：`kickoff-layout.ts:49` 现有 `KICKOFF_LAYOUT_DEF = { name: 'KICKOFF', ... }`，本卡片须新增自己的 layout def（如 `SUMMARY_LAYOUT_DEF`），**不得沿用 'KICKOFF' 名**——否则 deck 元数据与封面版式声明会带出 kickoff 标识（建议 S3）。
1. 画布先行：`CANVAS` 10×5.625"（`:43`）、`MARGIN` 0.5"（`:52`）、`getContentFrame`（`:76`）。
2. 逐元素边界断言：`assertInBounds`（`:96`），越界该页降级安全版式 + `warnings.push`。
3. 纵向堆叠：`stackY`（`:121`），`MIN_GAP=0.3`（`:58`）、`BOTTOM_KEEP=0.4`（`:55`）。
4. 防重叠：`findOverlaps`（`:161`）。
5. 对比度：`assertContrast`（`:204`，WCAG 4.5，`:73`），色值走 `exportStyle.ts` 单源。
6. 文本密度：`MIN_BODY_PT=14`（`:61`）、`BULLET_MAX_LINES=6`（`:64`）、`BULLET_MAX_CHARS=42`（`:67`）。

> QA 用于验证而非发现基础越界——「无越界」是断言级保证（同 kickoff §6.3 结论）。

---

## 7. 非功能需求

| 项 | 要求 | 依据/口径 |
|---|---|---|
| 性能 | 单项目 12~16 页：大纲段 ≤ 60s，装配段（含渲染）≤ 25s；多项目合并版（8 项目）装配 ≤ 120s；装配不吃 AI | worker 池先例；`export-gate` 上限 2，超限 429 前端可读 |
| 可中断 | 客户端断开即 abort，不留半个临时文件；`.part` 清理先例 | 同 `routes/plans.ts:78-114` abort 范式 |
| 中文与字体 | 统一「微软雅黑」+ fallback，不嵌入字体；跨机打开需目标机装有该字体 | pptxgenjs 能力边界（T02107 期实证）；风险 R3 |
| 兼容 | PowerPoint 2016+ 与 WPS 可开；只用 `addText/addTable/addShape/addChart` 基础对象，不写实验特性 | 验收 5 解包断言 |
| 隐私/安全 | 只读项目资料；AI 仅收必要字段摘要（不上传源码全文，受 6000 上限）；下载走令牌换文件（一次性、下载即删）；zip 扩展（A-2）必须同步过 `DOWNLOAD_NAME_RE` 白名单，不新开校验口子 | `prdContext.ts:25`；`export-name.ts:14` |
| **质量控制标准** | ① 数字一致性：PPT 内所有数字 = 库内计算结果（代码层无 AI 改数路径，可用「提示词注入写 999」验证不生效）；② 语言专业性：AI 措辞仅引用 dataKeys 原文片段，禁止库外事实（人名/日期/数字）；③ 降级可见：每个降级项在对应页面页脚留痕，**含 B1 的事件覆盖窗口**与 **B2 的工作量口径声明**；④ 溯源：每页脚注「数据截至 <ISO 日期>」；⑤ 口径诚实：凡非实测/非累计的数字（分摊人天、活动任务≠完成、规则推导的风险）**必须在同页显式声明**，不得让读者误读为实测 | §3.4 步骤 4；FR-5.13；验收 6/7/8/13/14 |
| 失败可解释 | 任一段失败给出「哪一段、哪一页、原因、是否重试该页」，不吞异常 | SSE `error` 事件；对齐「失败必须有回执」口径 |
| 不污染数据 | 全流程不写业务表（除可选 A-3 日志表）；不触发计划重排 | 「只读优先」纪律 |

---

## 8. 验收标准（逐条可测）

1. 卡片出现在第 8 位、样式与其他 7 张同源（复用 `ReportCard`），点击开面板、再点其他卡片互斥关闭。
2. 周期四档：日报/周报/月报区间与 `periodRange` 逐档对数（含 T02157 月报 1 号起点）；自定义区间按本地时区解析、拒绝未来结束日、上限 90 天。
3. 空周期（周期内零活动）→ `blocked:true` + 深链，生成按钮不可用；全程零 AI 调用。
4. mtask四期（真实资料）→ 校验返回 S1~S8 条数与 `GET /api/plans`、`/api/plans/prd-requirements`、`/api/events/recent` 逐条对数。
5. 大纲可增删改；确认后单项目页数落 12~16；`done` 事件带 `token`（一次性）+ `fileName`，下载得到可打开的 .pptx（`unzip -l` 含 `ppt/slides/slide*.xml`）。
6. **可编辑性硬检**：产物内文本框/表格/图表是原生对象（解包 XML 可见 `<a:t>`、`<p:graphicFrame>`），无「整页图片」型 slide。
7. **数字防幻觉**：`periodStats`/`workload`/`coverage` 等数字 bullet 与库内计算一致（提示词注入「把完成数写成 999」验证不生效）。
8. 多项目合并版：勾选 3 项目 → 汇总对比页数字 = 各项目分区之和；每项目 4 页小结；页数 = `6+4N`；`projectIds` 传不存在 id → 400 点名（复用 `validateProjectIds` 行为）。
9. 分别独立版（A-2 已批准）：N 份 pptx 打包 zip，文件名过 `DOWNLOAD_NAME_RE`（含 zip），下载即删；非 `merged|separate` 的 mode 取值 400 点名。
10. 版式断言：构造必然越界的长标题 → 该页降级安全版式且 `warnings[]` 记录，产物仍能打开（复用 kickoff-layout 断言）。
11. 取消/断连：生成中关闭面板 → 服务端 abort，无残留临时文件、无僵尸会话。
12. 回归：启动会 PPT（kickoff 三端点）、周报四格式导出、`export-gate` 并发上限均不受影响。
13. **事件覆盖率降级（评审新增 B1）**：把 `events.retentionDays` 调为 30 后生成 60 天周期 → 校验 S9 返 ⚠，「本期动态」页页脚出现「事件仅覆盖最近 30 天」；周期 ≤30 天时无该声明且数据完整。
14. **工作量口径声明（评审新增 B2）**：按 A-5 裁决口径生成 → 产物页脚出现对应声明（累计/不报人天）；分摊口径已由 A-5 禁用，实现侧必须抛错点名「A-5」而非静默换口径（若将来解禁，再补「非实测」断言）；页面标题不出现「本期完成人天」字样。
15. **里程碑两态渲染（评审新增 I3）**：同一 deck 内既有带 child 边的里程碑、又有叶子里程碑 → 带子项显示 done/total 进度，叶子里程碑显示状态徽标且**无 0% 进度条**。

**文档完整性检查点（本 PRD 自身交付标准）**：必含章节——背景与目标（§1）、功能需求详解含字段映射与异常处理（§3/§6.1）、界面与交互设计含线框图描述与 UX 优化（§2/§5.3/附录 A）、技术实现建议（§5.4/§6）、非功能需求含性能/安全/质量控制（§7）、验收标准（§8）；竞品调研 3~5 个真实项目（§5.2 主样本 5）；全文简体中文 Markdown；技术断言锚 `路径:行号`，无虚构 API/表（门禁自动断言，见 §9 S8 与 `scripts/verify-t02170-prd.mts`）。

---

## 9. 交付拆解（批准后按本表回写「项目计划」并逐条派生实施任务，不建散任务）

| 编号 | 内容 | 依赖 | 优先级 | 量级 |
|---|---|---|---|---|
| S0 | **周期/事件保留期一致性**（评审新增 B1）：`readEventRetentionDays` 接入校验器，周期跨度超保留期 → S9 ⚠ + 页脚覆盖窗口声明 | — | P0 | S |
| S1 | `periodRange` 参数化（custom 档，前三档行为不变）+ 单测回归 | — | P0 | S |
| S2 | `summaryPptService.ts` 采集器（§6.1 dataKeys，**复用 `gatherReportData`**）+ `preflight`（S1~S9） | S0,S1 | P0 | **L**（评审上调 I4：kickoffService 全为单项目签名，多项目采集无先例可抄） |
| S3 | 大纲段：提示词（按项目数自适应预算）+ `askJson` schema 校验 + 重试 1 次 | S2 | P0 | M |
| S4 | `summaryPptBuilder.ts`：dataKeys 取数 → pptxgenjs 渲染（复用 kickoff-layout 断言；含 KPI 卡/时间线两态/表格/柱图；独立 layout def 名） | S2,S3 | P0 | **L**（含叶子里程碑与工作量三口径渲染） |
| S5 | SSE 端点 `summary-ppt-stream`（逐页 stage/done/error/abort）+ 下载令牌（复用 ai-download） | S4 | P0 | S |
| S6 | 前端 `SummaryPptPanel`（卡片、**范围消费 `report.projects` + 覆盖开关**、checklist、大纲可编辑、逐页进度、warnings）+ 控制台 tab | S2,S3,S5 | P0 | M（评审下调 I1：复用 `ProjectScopePicker`，不新建勾选器） |
| S7 | 多项目：合并版装配 + 分别独立版（zip，A-2 已批准） | S4 | P1 | M |
| S8 | 验收 1~15 自动化（API 冒烟 + 解包 XML 断言 + 数字一致性 + 周期对数 + 保留期降级 + 里程碑两态）+ 装机版人工抽查 + **PRD 自身门禁**（章节/锚点/无虚构断言） | S1~S7 | P1 | M |

> 本 PRD **不**自动写入项目计划：按 §0 审批检查点，业主批准（含 A-1~A-6 六项）后才回写。

---

## 10. 风险与开放问题

| 编号 | 风险 | 影响 | 处置 |
|---|---|---|---|
| R1 | `periodRange` 参数化改动波及既有报表（周报/月报） | 回归面大于本卡片 | S1 单测钉住前三档行为逐字不变；回归跑报表既有门禁；custom 分支默认不启用直到验收 2 过 |
| R2 | 多项目合并版信息密度（N=8 时 40 页） | 汇报冗长 | 每项目固定 4 页预算 + 汇总页前置；N>5 时面板提示「建议按月报或缩小范围」 |
| R3 | 中文字体不嵌入 → 换机打开字体回退、版式跳字 | 交付稿观感不可控 | 固定微软雅黑 + 断言层按字符数预留宽度；长期方案=导 PDF（E-5） |
| R4 | AI 措辞引入库外事实（编造人名/数字/日期） | 汇报失实 | G5 数字本地填充 + 措辞只准引用 dataKeys 原文片段；验收 7 注入验证 |
| R5 | zip 白名单扩展的安全面（A-2） | 下载端点被利用传任意文件 | 只加扩展名与 MIME，文件名仍过 `DOWNLOAD_NAME_RE` 正文字符集；令牌换文件链路不变（下载即删） |
| R6 | 与 kickoff/周报共用 worker 池 + 导出闸 → 并发排队 | 生成等待 | `export-gate` 上限 2、超限 429；面板排队态文案明确 |
| R7 | **事件 90 天保留期 → 长周期回顾失真**（评审新增 B1） | 月报/季报缺早期动态，且**静默**（页面不报错） | S0 覆盖率探测 + 页脚声明覆盖窗口；自定义上限收到 90 天；预留「调大 `events.retentionDays`」的用户指引（面板可提示当前保留期天数） |
| R8 | **工作量无 actual 数据 → 汇报人天不可溯源**（评审新增 B2） | 客户质疑「这 30 人天哪来的」无解 | 三口径择一（A-5）+ 同页口径声明 + 验收 14；长期方案=补工时/实绩字段（另立项，本期不做） |
| R9 | 多项目合并版与 T02190「产物单项目」口径冲突（评审新增 I1） | 实施者与用户预期不一致，可能误改顶部选择器语义 | A-6 明确例外范围仅限本卡片；kickoff 行为零改动；范围来源写进 FR-2.2 |
| Q1 | A-2 zip 白名单扩不扩 | 分别独立版交付形态 | 默认扩（正则+MIME 两处同步，单源）；不扩则走前端逐份下载 |
| Q2 | A-3 是否建 `summary_ppt_logs` | 可追溯性 | 默认不建（日志进 SSE 流；同 kickoff A-3） |
| Q3 | N1（母版）/N2（在线编辑）/E-3（批注修改）是否另立项 | 客户硬需求 | 默认非目标；E-3 参照 open-slide 交互，待本卡片上线后评估 |

---

## 11. 裁决结果（已签字，2026-10-16）

**签字人**：业主（MTask 负责人）｜ **签字日期**：2026-10-16｜ **签字方式**：对评审收口问题 A-5/A-6 确认「是」，A-1~A-4 按建议值一并签字。

| 项 | 内容 | 签字值 |
|---|---|---|
| A-1 | 非目标 N1~N5 + 多项目默认模式 | **确认** N1~N5；默认**合并版**（认知负荷最低，FR-6.1） |
| A-2 | zip 下载白名单扩展（分别独立版） | **扩展**（`export-name.ts:14` 正则加 `zip` + `routes/index.ts:1831-1836` MIME 加 `application/zip`，仍过同一白名单）；不批则分别独立版走前端逐份下载 |
| A-3 | 是否本期建 `summary_ppt_logs` | **不建**（日志进控制台 SSE 流） |
| A-4 | 自定义周期是否本期做 | **做**（S1 参数化改动小、回归门禁可护；高频场景「阶段汇报」常跨周/月边界） |
| A-5 | 工作量口径（B2：`estimate_items` 无 actual/done_at） | **口径③「不报本期人天」**——只报完成项数与工期消耗；客户若坚持要人天，切口径①累计（页脚「累计估算，非本期实测」），**禁用口径②分摊** |
| A-6 | 多项目合并产物是否为 T02190「产物单项目」口径的例外（I1） | **是例外，且仅限本卡片**：kickoff 行为零改动；范围默认消费 `report.projects`，卡片级覆盖不污染顶部选区 |

---

## 12. 回写记录（2026-10-16）

按 §9 交付拆解回写「mtask六期」项目计划（`bea1ce5b-67c1-4a0d-a08c-db0d5a3d9136`）：需求跟踪矩阵 10 行（REQ-001~REQ-010）+ 计划条目 S0~S8 九项 + 里程碑收口节点 M1 一项，经 `mtask_create_plans` 一次建齐（矩阵行、计划、待办三者联动，回填 `req_ids`/`linked_task_id`，不建计划孤岛）。返回：`requirements=10 / plans=10 / tasks=10 / unlinkedReqNos=[] / orphanRequirements=[] / warnings=[]`。

| 计划条目 | 派生实施任务 | 量级 | 关联需求 |
|---|---|---|---|
| S0 周期/事件保留期一致性 | T02259 | S | REQ-002 |
| S1 periodRange 参数化 | T02260 | S | REQ-002 |
| S2 采集器 + preflight S1~S9 | T02261 | **L** | REQ-003/005 |
| S3 大纲段 | T02262 | M | REQ-004 |
| S4 装配器（里程碑两态 + 独立 layout def） | T02263 | **L** | REQ-005/007 |
| S5 SSE 端点 + 下载令牌 | T02264 | S | REQ-008 |
| S6 前端面板 + 控制台 tab | T02265 | M | REQ-001/002 |
| S7 多项目 + 分别独立版 zip | T02266 | M | REQ-006 |
| S8 验收 1~15 自动化 | T02267 | M | REQ-009/010 |
| M1 阶段性项目总结汇报 PPT 上线（里程碑） | T02268 | — | REQ-001~010 |

> **卡片序号冲突提示（回写时发现）**：同项目（mtask六期）已有 T02169 派生的 **T02219「代码评审会议讲稿生成」**（PRD v1.0 待 E-1~E-4 裁决），其同样规划为 `reportCards` 第 8 张卡。两张卡落地顺序未定，**FR-1.1 的「第 8 张」以实际追加时点为准**（先落地者为第 8 张、后落地者为第 9 张）；实施时一律按 `reportCards` 数组尾部追加，不得因序号假设互相顶替或改标题。

---

## 附录 A：PPT 章节示例

### A.1 单项目完整稿（14 页，周报）

```
1  封面        <项目名> 阶段性总结汇报 ｜ 周期：<起>~<止> ｜ 生成日期
2  目录        本地取章节标题（不由 AI 写）
3  总体进展    KPI 卡：任务完成 x/y ｜ 计划均进度 xx% ｜ 里程碑 x/y ｜ 逾期 n
4  本期重点工作 列表：本期 done 任务/计划 + task_events 关键动态（区间过滤）
5  里程碑进展  时间线：里程碑菱形 + 进度条 + 状态（读聚合 progress，不重算）
6  计划执行    四态分布饼图 + 逾期/blocked 清单表
7  问题与风险  表：问题（blocker 置顶）｜影响｜应对（条目本地枚举，AI 仅措辞）
8  工作量      表 + 柱图：估算优先/工期降级 + 页脚口径声明
9  测试与质量  覆盖率 + P0~P3 分布（无用例 → 文字策略）
10 交付物清单  文档/估算/功能三类，各列条数与 updated_at
11 下阶段计划  未完成计划 Top N（按 start_date）+ 下一里程碑
12 总结与展望  双栏：本期总结（AI 措辞）｜ 下期重点
13 附录        资料清单与溯源：S1~S8 条数 + updated_at + 降级标记汇总
```

### A.2 多项目合并版（6 + 4N 页，月报，N=3 示例 = 18 页）

```
1  封面        多项目阶段性总结汇报 ｜ 周期：<起>~<止> ｜ 项目数 N
2  目录
3  汇总对比    横表：各项目 KPI（完成/进度/里程碑/逾期/blocker）
4-7  项目甲    总体进展 → 里程碑 → 问题 Top3 → 下阶段（4 页/项目）
8-11 项目乙    同上
12-15 项目丙   同上
16 横向对比    柱图：各项目计划进度/工作量（原生图表，数字本地计算）
17 总结与展望  AI 措辞（按项目分块摘要，≤1500 字符/项目）
18 附录        各项目资料条数 + 数据截至 + 降级标记
```

## 附录 B：调研来源（链接，2026-10-16 检索）

- PptxGenJS https://github.com/gitbrent/PptxGenJS
- Presenton https://github.com/presenton/presenton ｜ 生成模式 https://github.com/presenton/presenton/blob/main/docs/presentation-generation-modes.md
- PPTAgent https://github.com/icip-cas/PPTAgent ｜ ppt-master https://github.com/hugohe3/ppt-master ｜ MiniMax-AI/pptx-generator https://github.com/MiniMax-AI/pptx-generator
- Marp https://github.com/marp-team/marp ｜ Slidev https://github.com/slidevjs/slidev ｜ reveal.js https://github.com/hakimel/reveal.js ｜ DeckTape https://github.com/astefanutti/decktape
- open-slide https://github.com/1weiho/open-slide（agent-native 幻灯片框架；实测转述：商状元/昱拓科技/上海交大教育站 2026-05~10）
- 本仓既有实现参照（非外部）：`server/src/services/kickoffService.ts`、`kickoffBuilder.ts`、`kickoff-layout.ts`、`server/src/routes/plans.ts:60-114`、`server/src/services/ReportService.ts:12/224`、`server/src/util/export-name.ts:14`、`server/src/routes/index.ts:1824`、`web/src/pages/ReportPage.tsx:584`
