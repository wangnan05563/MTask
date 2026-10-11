# PRD：项目管理「估算」视图与工作量评估导出（MTask）

> 来源任务：T01839 ｜ 版本：**v1.9** ｜ 日期：2026-10-12 ｜ 状态：**已批准·E0 放行**（业主 2026-10-11 签字：D1~D6 全部按评审建议值通过，见文末「裁决结果」；E0 Spike 同日实测通过，见 §11.1）
> v1.9 变更（T02040 = §5.3 写路径 + §11-E5 实施回写）：① §5.3 原文「`E` 列随输入实时重算（**前端算**）」与 v1.8 起的零计算红线正面冲突，现裁决为**不前端算**：`PATCH` 成功后立刻重取 `GET /api/estimates`，读数仍是服务端重算的，「即时」的观感保留、算式只有一份（§5.3 一致性条同步改写）。② §5.3 的「按复杂度重推 / 按用例加权重推 / 按工期重推」三模式与服务端「自动择档」的关系定死：`onlyRule` 是**过滤，不是强制改算式**（`EstimateDerive` 为此新增 `skip='offRule'`）——某行的自然择档不是它时整行跳过，确认文案如实报「N 行不属于该档」；给没有复杂度档的行硬推一个数，正是 §4.6 要防的假数据。③ §4.1 的 0.5 输入精度在「统一值 + 相对幅度」通道由前端镜像 `toGrid()` 承担（唯一实现仍在服务端，跨包引不到，同工作日镜像的先例），镜像与服务端 19 格逐格全等断言见 `verify-t02040-estimate-e4b.mts` S-01。④ 行内录入**不前置判** `O≤M≤P`：不合格值由服务端 400 中文文案拒，面板只把该行标红 + 底部提示条逐行点名（S-09 源码守卫「判据只有一份」）；被拒的值**保留在格子里**，清掉它就是逼用户重打一遍。⑤ §5.2 的「只看未复核」筛选、行内错误态与 §7 的「脱离计划行显式清理入口」同日落地（后者兑现 T02039 面板文案里「清理入口随 E5 提供」的承诺）。⑥ 真机走查抓到两处**只有浏览器能看见**的缺陷：三个规则按钮没挂 `onClick`（渲染正常、点了没反应），以及 `runBatch` 漏传 `onlyRule`（三个按钮行为完全相同）——现各有源码断言（S-13b/S-13c）与网络层断言（U-13c：`POST /api/estimates/batch` 必须真打到）。⑦ §10-3/4/5 取证：`scripts/verify-t02040-ui.mjs` **PASS=37 FAIL=0**（真机 headless-Chrome/CDP，5 张截图）、`scripts/verify-t02040-estimate-e4b.mts` **PASS=46 FAIL=0**，E4 首段门 `scripts/verify-t02039-estimate-e4a.mts` 回归 **PASS=37 FAIL=0**。
> v1.8 变更（T02039 = §11-E4 首段实施回写）：① §5.1 末条对 `complexity` 的判断**按实测校正**——`GET /api/plans` 走 `SELECT p.*`，`complexity` 列早已随计划下发，E4 只需给 `TlPlan` 补一个可选字段，**服务端与计划查询都不必改**（原文「需扩…计划查询列」会让下一位实施者白跑一趟后端）。② 逐行 σ 的**唯一来源定为 `summary.rowRatios[].sigma`**（引擎 additive 补该字段）：§9「前端不重写公式」如果只覆盖 E 不覆盖 σ，面板 σ 列要么空着要么前端再算一遍 `sigma()`。③ §5.2 的**空态判定校正**为「`items.length === 0`」而非「全部 `source='default'`」——`default` 行也要先经「按规则推导」写入才存在，按原文判据则空态永远不出现。④ 明细列的**需求编号不新增服务端字段**，复用需求矩阵现成接口 `GET /api/plans/prd-requirements`（按 `linkedPlans[].id` 反查 `req_no`）。⑤ §5.2 四段按交付单**显式分段**：本单交付 1/2/3 段 + 空态，**行内录入与行内错误态随 T02040**、**区间条随 T02041**、**导出区随 E6/E7**，面板内不预留空壳按钮（预留即等于承诺一个未验的交互）。⑥ 覆盖式（<1200px）下面板自带标题行隐去，避免与 `SlideOver` 标题重复。⑦ §10-1/2/5/13 由 CDP 真机走查取证（`scripts/verify-t02039-e4-ui.mjs`，26 断言含三档视口与截图），另附取数/零计算脚本 `scripts/verify-t02039-estimate-e4a.mts`（37 断言）。
> v1.7 变更（T02037 = §11-E3 实施回写）：① §4.6 规则 2 的「k 项目级可配」缺键名，现定死两支 KV：全局 `estimate.caseWeightK`、项目级 `estimate.caseWeightK.<projectId>`（项目级优先，缺省 0.5；非正数直接报错不静默回落）。② §4.6 三档推导值**一律落到 0.5 人天网格**（§4.1「输入精度 0.5 人天」的实现口径）——不写死这条，面板显示 3.25、Excel 里又是 3.25，而客户模板全是 .5 步进，两侧迟早对不上。③ §4.6「人工改过即转 manual」的**落点定在路由层**：`PATCH /api/estimates/:planId` 未显式给 `source` 时，`rule`/`default` 行一律转 `manual`（`EstimateService` 的「缺省沿用原值」语义不动，避免与 E1 断言打架）；不转则 §9 的复核率会把人已改过的行继续算成未复核机器值。④ §8 端点按实测落地形态补注（见该节「E3 实测补充」）：derive **默认 dryRun**、`mode=derive`、`/meta` 单源、`/detach`+`/detach/cleanup` 显式清理、params 传空串=回落默认；并记一条引擎既有分类口径——排除计数按「未估算 → 小计 → 里程碑」优先级，未估算的里程碑行记入 `unEstimated` 而非 `milestone`。
> v1.6 变更（T02036 = §11-E2 实施回写）：① §9「可维护」项把引擎落点由 `web/src/util/estimate-engine.ts` **校正到服务端单源** `server/src/services/estimate-engine.ts`——两侧 tsconfig 均无跨包 include/alias（`server/tsconfig.json` 有 `rootDir:"src"`、`web/tsconfig.json` 只 include `src`），让 web 持有唯一实现会让服务端（E6 导出缓存值只能来自引擎输出，§11.1 红线 2）无法复用；前端经 E3 的汇总接口取数展示，「避免两处公式各写一遍」的原意由此真正落地（§9 该行同步改写）。② §4.6 的 `estimate.rule.default.ratio`「1:4:1.6」读法按正文显式式子定死：**首末两段是 O、P 相对 M 的倍率，中段 4 是 PERT 权重而非 M 的倍率**（即 O=M、P=1.6M，与模板实测形态一致）；实现落 `parseRuleRatio()`，中段不是 4 直接报错不猜。③ §4.2 补记「标准式与模板式逐值等价」的**前提是 O≤M≤P**（乱序反例 0/5/1：标准 3.5 vs 模板 1.5），该前提由 E1 服务层校验守住，引擎不重复设第二道校验。
> v1.5 变更（T02034 = §11-E1 实施回写）：§3.1 的 `plan_id` 由「FK→plan_tasks」校正为**不建物理外键 + 服务层归属校验 + 视图层过滤**，依据是 `PlanService.purge()` 的物理 DELETE 与 §7「估算行原样保留」在外键下不能共存（实测取证与断言见 `scripts/verify-t02034-estimate-e1.mts`）。§4.5 点名的 `addWorkdays(anchor,n)` 正向工作日工具同日落地（服务端 `server/src/util/workdays.ts` 唯一实现 + 前端 `web/src/utils/workday.ts` 同语义镜像，720 格网格逐格全等断言）。
> v1.4 变更（T01843 复杂度补录取证收口）：§1.1/§4.6 的复杂度基线按生产库实测改写（mtask四期 37/37 非空），§11-E15 判据按实测行数重述并记四期闭环，§12-R3 更新状态，§1.4 补「复杂度评级」术语并明确里程碑不重复计。全程只读取证，无数据写入。
> 评审报告：`docs/PRD评审报告-估算视图与工作量评估导出.md`（T01842，二次独立取证，v1.0→v1.1 修订项 C1~C9 全部落点见该报告 §7）
> 影响项目：mtask四期（工作空间 `D:\code\otherProjects\26_MTask`）
> 关联既有 PRD：`docs/PRD-项目计划.md`（T00431，已实现）、`docs/需求规格说明书.md`、`docs/PRD-测试用例管理.md`

---

## 0. 执行摘要

**做什么**：在「项目管理」菜单的时间线视图右侧新增**估算面板**（Estimate Panel），把已有的计划条目（`plan_tasks`）升级为可录入**三点估算（乐观 O / 最可能 M / 悲观 P）**的估算对象，按客户既有的《项目工作量估算表》口径自动汇总出「最终估算值 → 阶段人月 → 调节系数 → 实际预估人月」，并一键导出**结构完全复刻客户模板的 Excel**与**可直接提交客户的 PDF**。

**为什么现在做**：MTask 已沉淀了做估算所需的全部上游数据——需求矩阵（`prd_requirements`）、项目计划（`plan_tasks`，含工期/复杂度/依赖）、测试用例（`test_cases`）、历史待办耗时（`tasks` 1580 条），但**这些数据只用于排期，没有转化为可对外报价的工作量口径**。当前对外报价仍要在系统外手工誊抄一份 Excel（参考模板 `阜新银行-票据系统优化-工作量评估V2.0.xlsx` 即人工产物），既不可追溯，也无法随计划变更刷新。

**核心价值**：
1. **估算准确性**——用三点估算替代单点拍脑袋，并给出标准差与置信区间，让「估了多少、有多不确定」同时可见；
2. **可追溯**——每一条估算锚定到具体计划条目与需求编号（FR-x），客户质询时可逐行回放到需求与用例；
3. **交付即用**——导出文件的 sheet 名、合并区、公式、命名区域与列宽逐格对齐客户模板，无需二次排版；
4. **零新依赖，但不是零新能力**——exceljs / docx / pdfkit 均已在 `server/package.json`（exceljs 4.4.0、docx 9.7.1、pdfkit 0.20.1），符合项目「仅使用已有依赖」协议约束；但**「往单元格里写活公式」和「写非 ASCII 命名区域」在本仓库零先例**（全仓 grep `.formula` = 0 处，既有 exceljs 用法只做样式填充与加载用户模板），故 §11 设 **E0 技术验证（Spike）** 作为 E6 的放行闸门。**E0 已于 2026-10-11 实测通过**：exceljs 用 `{formula, result}` 可同时写公式与缓存值，常量命名区域经写侧注入后 Excel 可解析重算；唯一不达的是「复制客户模板再填充」这条路会丢常量命名区域 → E6 改走从零构建（结论与实现红线见 §11.1）。

**交付范围**：估算面板 UI + 三点估算数据模型 + PERT 计算与汇总引擎 + Excel/PDF 导出 + 计划↔估算联动 + MCP 工具暴露。**不含**资源费率管理、财务成本核算、跨项目组合（Portfolio）汇总（见 §1.3 非目标）。

---

## 1. 背景与目标

### 1.1 现状与证据（本次调研实测）

| 事实 | 实测证据 | 对功能设计的约束 |
|---|---|---|
| 计划条目只有**单点工期** `duration_days`（工作日），无三点字段 | `plan_tasks` 表结构：`duration_days:INTEGER`，无 O/M/P 列 | 新增估算数据，不改 `duration_days` 的排期语义 |
| `complexity`（复杂度 1~5）列已存在，但**填充与否完全取决于「该行是否由 PRD 导入产生」** | 只读统计（2026-10-11 v1.3）：mtask四期 20 条、mtask一期 20 条计划 `complexity=NULL`；仅 swork 20 条已填（1~5）。**v1.4 复查（2026-10-11 深夜，同一生产库 `%APPDATA%/mtask/data/mtask.db`）**：mtask四期 未归档计划 37 条 **37/37 非空**（2026-10-11 两次 PRD 重导由 AI 一并给出复杂度，行数由 20 变 37 即其结果），mtask一期 未归档 20 条仍 0/20，且该项目已进历史资产（`projects.history_at=2026-10-11T03:09:39Z`，故不在 `/api/projects` 活跃列表） | 三点估算仍需支持「复杂度 → 系数」冷启动推导，并允许逐条覆盖；NULL 行按 §4.6 规则 3 兜底 |
| 工期分布极窄（多数 1~3 天） | mtask四期 16 条 normal：`min=1 max=3 avg=1.75`；4 条 milestone：`min=1 max=12 avg=7.0` | 面板要按**阶段**（需求/设计/开发/实施…）汇总，单条粒度不足以直接报价 |
| 需求矩阵已可用 | mtask四期 `prd_requirements` 12 条（high 10 / normal 2）；mtask一期 34 条；swork 20 条 | 估算行需携带 `req_no` 溯源列 |
| 用例优先级已用 P0~P3 词表 | swork `test_cases` 71 条：P0 9 / P1 31 / P2 25 / P3 6（T01703 已统一 P 档换算） | 「按用例数折算」推导规则须与 P 档口径一致 |
| 导出基建齐备 | `server/src/services/prdExport.ts`（docx/pdfkit/exceljs）、`server/src/util/exportStyle.ts`、`server/src/util/export-gate.ts`；`/api/plans/export`、`/api/plans/prd-requirements/export` 已走 `exportGate` | 新导出端点必须复用 `exportGate` 与既有样式表，不另起炉灶 |
| 参数配置基建 | `server/src/services/AppSettings.ts` 提供**模块级具名函数** `getSetting(key)` / `setSetting(key, value)`（`:14/:19`，非类静态方法）；`app_settings` 表仅 `key`/`value` 两列（`schema.ts:160-163`） | 估算参数（人天/人月标准、调节系数默认值）落 `app_settings`，不建新配置表 |
| 时间线视图结构 | `web/src/pages/PlanPage.tsx:1938 renderTimeline()` → `PlanTimeline`（整宽）+ 节点详情 `SlideOver width={420}`；视图切换 `PlanViewModeToggle`（列表/甘特/时间线，`PlanPage.tsx:354`） | 「右侧嵌入」= 时间线区内分栏，不新增第四视图（理由见 §5.1） |

### 1.2 目标

- **G1**：在不改变现有排期逻辑（串行重排、节假日避让）的前提下，为项目计划提供三点估算能力。
- **G2**：估算口径**严格对齐**客户模板 `阜新银行-票据系统优化-工作量评估V2.0.xlsx`（公式、合并区、命名区域、汇总层级逐格一致）。
- **G3**：一次点击产出可提交客户的 Excel（含活公式，客户可自行改参复核）与 PDF（脱敏报价交付版）。
- **G4**：估算结果与计划/需求/用例双向可追溯，计划变更后估算面板与导出可刷新且能提示「待复核」的漂移行。
- **G5**：全部能力经 MCP 工具暴露，外部 Agent 可自动出估算数据（延续 T01689 的「外部 Agent 可校验」方向）。

### 1.3 非目标（本期明确不做）

| 不做 | 原因 |
|---|---|
| 人力单价 / 费率 / 金额换算 | 模板备注第 2 条明确：本表用于**成本估算与内部依据**，报价应转向价值定价；引入金额会让口径失真。**裁决 D6（2026-10-11 已签）：保持非目标**，金额列是否追加另行走商务确认，不阻塞本期交付（见文末「裁决结果」） |
| 资源负载均衡与人员日历 | `assignee` 仅文本字段，无资源池模型；属独立模块 |
| 跨项目组合汇总估算 | 估算以「项目 = 一次报价」为单位，跨项目聚合需先定义合同边界 |
| 蒙特卡洛模拟 | 参考生态有 PERT-Beta 实现（附录 D），但本期以 σ + 置信区间即可满足报价沟通需求，列为 P2 拓展 |
| 移动端估算面板 | 移动端 `web/src/mobile/` 无计划/时间线渲染（实测仅有 `MobileTaskDetail` 的事件时间线）；估算录入是桌面重交互 |
| **导出后的反向导入**（客户在导出 Excel 上改 O/M/P 再回灌 MTask） | 现 `/api/plans/template` / `/api/plans/import` 的列规范固定为 6 列（`docs/PRD-项目计划.md` §3.2），本期不扩列以免破坏既有导入校验。**影响**：客户手改后的文件需人工在面板重录，或走「参数 sheet 对比」定位差异行；若报价流程要求双向，列为 P2。**裁决 D6（2026-10-11 已签）：反向导入保持非目标**，本期不扩导入列规范。 |

### 1.4 术语表（与现系统对齐，禁止另造词）

| 术语 | 定义 | 系统对应 |
|---|---|---|
| 计划任务 | 项目计划里的一行工作项 | `plan_tasks.kind='normal'` |
| 里程碑 | 汇总节点（阶段包络） | `plan_tasks.kind='milestone'` |
| 复杂度评级 | AI 给出的实现复杂度 1~5（1=琐碎…5=极复杂），§4.6 规则 1 的输入；**里程碑行也会携带**（实测 mtask四期 10 条 milestone 全非空，取值 2~5） | `plan_tasks.complexity`（NULL=未评） |
| 阶段 | 估算归集口径（需求分析/系统设计/开发/实施/公共远程/现场维护） | 新增 `estimate_items.phase` |
| 三点估算 | 乐观 O、最可能 M、悲观 P（单位：**人天**） | 新增列 |
| 最终估算值 | PERT 期望值 E=(O+4M+P)/6 | 计算值，不落库 |
| 每人月工天标准 | 人天→人月换算因子，模板取 20.83 | `app_settings` KV |
| 调节系数 | 4 项风险/协作系数（客户协作磨合、质量要求、范围变更、进度变更） | 项目级可编辑 |
| 实际预估值 | 理想人月 ×(1+Σ系数) | 计算值 |
| 估算比例 | 该行占实际预估总量的比例，全表 Σ≈1 | 计算值（模板 I 列） |

### 1.5 用户故事（v1.1 依评审 M11 补齐）

| # | 角色与场景 | 期望 | 对应设计 |
|---|---|---|---|
| US1 | **PM 出报价**：项目要投标，我需要在 30 分钟内从已有计划产出一份客户模板级的工天/人月评估表 | 打开时间线 → 开估算面板 → 一键推导 → 导出的 Excel 客户无需排版 | §5.1/§5.3、§6.1、§9 性能 |
| US2 | **销售砍系数复核**：客户嫌贵，我要当场看「砍掉进度变更系数」对总价的影响，并知道砍了会承担什么风险 | 调系数即时试算 X→Y（Δ%），且知道哪些行仍是系统推导 | §7 影响试算、§5.2 来源徽标与「只看未复核」筛选 |
| US3 | **客户质询逐行回放**：客户问「这 6 人天怎么来的」，我要能指到需求与用例 | 每行带 `req_no`、复杂度、来源标记与依据备注；导出附加 sheet 保留全量溯源 | §3.1 `note`、§3.4 映射、§6.1 附加 sheet |
| US4 | **二次投标版本对比**：上一版报价报了几个月？改了哪些行？ | 每次导出留快照，可对比两版差异 | §3.2 `estimate_snapshots`、§5.2 导出区「对比」 |
| US5 | **外部 Agent 自动出数**：我在别的工作空间跑分析，需要直接取估算汇总并回写三点 | MCP 三枚工具，大响应不被截断 | §8 MCP、验收 11 |


---

## 2. 市场调研报告（GitHub 同类项目）

### 2.1 调研方法与样本

- 检索途径：GitHub REST `GET /search/repositories`（`sort=stars`）与 `GET /repos/{owner}/{repo}`（2026-10-11 实测），关键词 `gantt chart project management`、`PERT estimation project`；补充各项目 README/文档。
- 入选标准：① 提供**工期/工作量估算**或**成本报表**能力；② 近 12 个月有推送——**v1.1 澄清：②仅约束「功能/UX 借鉴类」样本（①~④）**；⑤⑥ 属**算法对照类**，其价值在于公式口径而非活跃度，显式允许停更；③ 许可证可用于功能借鉴（不作为代码引入）。

| # | 项目（链接） | Stars | 许可证 | 语言 | 最近推送 | 与「估算」的关系 |
|---|---|---|---|---|---|---|
| 1 | [makeplane/plane](https://github.com/makeplane/plane) | 60,656 | AGPL-3.0 | Python/TS | 2026-10-09 | 估算以**故事点**（Estimate，多档刻度）承载，面向敏捷迭代而非对外报价 |
| 2 | [opf/openproject](https://github.com/opf/openproject) | 16,379 | GPL-3.0 | Ruby | 2026-10-10 | **预计工时 + 剩余工时 + 时间条目 → 成本报告/预算**，是「工时→成本报表」最完整的开源实现 |
| 3 | [bardsoftware/ganttproject](https://github.com/bardsoftware/ganttproject) | 1,106 | GPL-3.0 | Java/Kotlin | 2026-10-01 | 唯一内建**PERT 图**（包 `org.ganttproject.chart.pert`）+ 资源负载图 + 任务成本 + PDF/HTML/PNG 导出 |
| 4 | [taskjuggler/TaskJuggler](https://github.com/taskjuggler/TaskJuggler) | 818 | GPL-2.0 | Ruby | 2025-07-28 | 文本建模 + **自研报表语言**（成本/工时/效率报表可定制到列）；⚠ 停更 14 个月，仅取其**报表模板语言**思想，不据其推断生态现状 |
| 5 | [linuxswords/pert-estimation](https://github.com/linuxswords/pert-estimation) | 1 | Apache-2.0 | — | 2025-11-02 | 独立 PERT 三点估算计算器（单点工具，无项目数据模型）——算法对照类 |
| 6 | [dlmueller/PERT-Beta-Python](https://github.com/dlmueller/PERT-Beta-Python) | 1 | GPL-2.0 | Python | 2015-05-04 | PERT **Beta 分布**纯实现（置信区间算法参考）——算法对照类，明确停更 |

> 结论性观察（重要）：**主流开源 PM 工具几乎不把「三点估算」和「对外报价文档导出」做成一条通路**——Plane 停在故事点、OpenProject 停在工时台账、GanttProject 有 PERT 图但导出是项目周报式 PDF；而 PERT 计算器类仓库虽公式正确却没有项目数据。**「系统内计划数据 → 三点估算 → 客户模板级 Excel/PDF」这段空白正是 MTask 的差异化位置**，且 MTask 已握有别人没有的上游资产（需求矩阵 + 用例 + 历史待办耗时）。

### 2.2 逐项目分析（设计 / UX / 功能拓展 / UI）

**① makeplane/plane（60.6k★，AGPL-3.0）**
- 设计：估算挂在「Issue → Estimate」字段上，取值来自项目级 **Estimate Set**（可选 1/2/3…线性、斐波那契、指数等刻度），刻度可换、历史值保留。→ 借鉴点：**估算标尺可配置且不破坏历史**（换刻度只改显示口径）。
- UX：在列表行内直接下拉改点，不打开详情；批量估算靠列表多选。→ 借鉴点：**三点录入必须在列表行内完成**，不要跳抽屉（本 PRD §5.3 采纳）。
- 功能拓展：Module/Cycle 两级聚合，估算随聚合滚动。→ 与 MTask 的「里程碑/计划」两级同构。
- UI：密度高、留白少、以颜色区分状态；估算列宽固定。

**② opf/openproject（16.4k★，GPL-3.0）**
- 设计：工作包同时持有 `estimated hours`（计划）与 `remaining hours`（滚动剩余），时间条目 `time_entries` 记录实际；成本报告按 **人员/角色/任务** 三维度透视，预算表另有 **contingency（应急储备）** 概念。→ 借鉴点：**「计划 vs 实际」并排 + 应急储备单列**，比单纯 O/M/P 更能应对客户砍价（本 PRD §4.4 以调节系数承接）。
- UX：报表页与数据页分离，导出走 CSV/PDF；筛选器持久。→ 借鉴点：估算面板**先看汇总卡、再下钻明细行**。
- 功能拓展：成本/工时报表可挂到任意层级节点，支持 rollup。
- UI：表格线偏重、可读性一般；MTask 应沿用自身 CSS 变量体系而非照搬。

**③ bardsoftware/ganttproject（1.1k★，GPL-3.0）**
- 设计：任务持有 min/most-likely/max 三值与标准差 σ，PERT 视图把任务渲染成网络图节点（包 `org.ganttproject.chart.pert`）。→ 借鉴点：**σ 必须与 E 同屏显示**，否则客户只记一个数。
- UX：三值在任务属性对话框分栏录入；PERT 图作为独立导出选项。→ 反面借鉴：**逐条开对话框在 20+ 行时不可用**（本 PRD §5.3 改为行内编辑 + 批量填充 + 规则推导）。
- 功能拓展：资源负载图 + 任务成本，可导出 PDF/HTML/PNG，与 Excel 互通。
- UI：桌面 Swing 观感陈旧；但「甘特条上叠加估算区间（浅色 whisker）」的可视化值得复刻。

**④ taskjuggler/TaskJuggler（818★，GPL-2.0）**
- 设计：一切皆文本模型，报表用专用语言模板生成（列、聚合、格式全可编排）。→ 借鉴点：**导出模板与数据解耦**——本 PRD §6.1 把列定义抽成 `ESTIMATE_COLUMNS` 常量，客户换模板只改列定义。
- UX：命令行 + HTML 报表，交互弱（不作为 UX 借鉴）。
- 功能拓展：时间/成本双主体核算，支持效率折损（`efficiency`）→ 对应模板的「合理范围空耗」。

**⑤ 小型 PERT 工具（pert-estimation / PERT-Beta-Python）**
- 设计：`E=(O+4M+P)/6`、`σ=(P-O)/6`，Beta 版给出 68/95/99.7 区间——与模板 H 列公式**完全一致**（见 §4.2 实证），可作为算法自测的对照基准。
- 价值：证明公式口径无争议，可作为单元测试的黄金样例来源。

### 2.3 对 MTask 的优化建议（四类）

**设计层面**
1. 估算数据与排期数据**物理分离**（新表 `estimate_items`），`duration_days` 保持排期唯一事实源，避免「改估算把排期也改了」的隐性耦合。
2. 阶段（phase）与调节系数是**项目级配置**而非行级：系数默认值存 `app_settings`，项目覆盖值存 `estimate_settings`（见 §3.3），保证跨项目可比。
3. 导出模板列定义常量化（借鉴 TaskJuggler），为后续「其他客户模板」留扩展点。

**用户体验**
4. **行内三点录入 + 批量填充**（借鉴 Plane）：选中多行 → 「按复杂度/用例数批量填 O/M/P」，一次覆盖全阶段。
5. **先汇总卡后明细**（借鉴 OpenProject）：面板顶部固定「实际预估 X 人月 / 置信区间 / 漂移行数」三张卡，滚动时吸附（sticky）。
6. **不确定度可视化**（借鉴 GanttProject）：每行 E 值右侧画 O~P 区间 whisker；甘特条叠加同一区间，让「排期 vs 估算」的张力一眼可见。
7. 空态必须有引导：未估算时面板显示「用规则一键推导」按钮（而非空白表格），避免冷启动劝退。

**功能拓展**
8. 三档估算来源可混合：**人工录入 > 规则推导（复杂度/用例数/历史耗时）> 默认系数**，并在行上标注来源徽标（人工/规则/默认），保证可解释。
9. 版本快照：每次导出留 `estimate_snapshots`，报价被质询时能回放「当时报的是哪一版、依据哪条计划」（MTask 已有 `task_result_history` 同范式，复用其设计）。
10. MCP 暴露 `mtask_get_estimates` / `mtask_update_estimates`（延续 T01689/T01704 的「外部 Agent 可校验」路线）。

**UI 升级**
11. 面板宽度对齐既有 `SlideOver` 口径（420px），复用 CSS 变量 `--card-bg / --border-strong / --text-muted`，禁止新色值。
12. 数字列统一右对齐 + 等宽字体（复用 `ResultDiff.tsx` 的 `FONT_MONO` 常量），小数保留 2 位、超过 100 保留 1 位。
13. 按钮沿用 `tbtn-anim` 悬浮倾斜/按下缩放动效（T00486 全站口径），图标取自已引入的 `lucide-react`。
14. 表头「最终估算值」这类**换行标题**（模板 H5 为 `最终\n估算值`）在 UI 上统一为单行 + title 悬浮提示，避免行高抖动。

---

## 3. 数据模型

### 3.1 新增表 `estimate_items`（每条计划一行，可空=未估算）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | uuid |
| project_id | TEXT FK→projects | 归属项目 |
| plan_id | TEXT（**不建物理外键**，v1.5 依 E1 实施实测校正本表的「FK→plan_tasks」记法） | 被估算的计划条目；**唯一索引** `(project_id, plan_id)`。**不设物理级联删除**（v1.1 依评审 B5）：`plan_tasks` 实为软归档（`archived`/`archived_at`，`server/src/db/schema.ts:517-518`），估算行随计划的归档态在**视图层**过滤，避免「删计划把历史报价依据一起删掉」。**校正依据**：`PlanService.purge()`（`services/PlanService.ts:960`）对**已归档**计划执行物理 `DELETE FROM plan_tasks`，若 plan_id 带外键则该语句抛 `SQLITE_CONSTRAINT`——归档菜单整条链断；而 §7 要求此时估算行**原样保留**并计为「脱离计划」，两者只能靠「不建外键 + 服务层归属校验（`EstimateService.requirePlan`：计划存在且同项目）+ 视图层 INNER JOIN 过滤」实现。`project_id` 仍写 `REFERENCES projects(id) ON DELETE CASCADE`——这是本仓既有口径（`tasks` / `prd_requirements` 同写法，`routes/index.ts:327` 的删项目依赖它），与「删计划不删估算」不冲突。断言见 `scripts/verify-t02034-estimate-e1.mts` A-04 / C-29~C-32。 |
| phase | TEXT | 阶段：`req`（需求分析）/`design`（系统设计）/`dev`（开发/研发）/`impl`（实施）/`common`（公共&远程投入）/`onsite`（现场维护） |
| unit | TEXT | 计量单位：`man_day`（默认，1 人天=8 人时，同模板 E4） |
| optimistic | REAL | 乐观值 O（人天，≥0） |
| likely | REAL | 最可能值 M（人天，≥O） |
| pessimistic | REAL | 悲观值 P（人天，**≥M**）（v1.1 校正：v1.0 误写「≥O」，与下方约束行自相矛盾） |
| source | TEXT | 来源标记：`manual` / `rule` / `default`（对应 §2.3-8） |
| note | TEXT | 估算依据说明（客户质询用，导出进 Excel 备注列） |
| created_at / updated_at | TEXT | ISO 时间戳 |

**约束**：`optimistic ≤ likely ≤ pessimistic`（服务端校验，违反返回行级错误，口径与 `PlanService` Excel 导入的「任一行失败整体不入库」一致）。

**迁移落点（v1.1 依评审 M13）**：两张新表加在 `server/src/db/schema.ts` 的建表清单内；后续字段增量沿用本仓既有 `ensureColumn` 幂等范式（先例见 `schema.ts:435-518` 对 `plan_tasks` 的 color/deps/kind/complexity/req_ids/archived 增量），**不引入新迁移框架**。

### 3.2 新增表 `estimate_snapshots`（导出版本留档）

| 字段 | 类型 | 说明 |
|---|---|---|
| id / project_id | TEXT | 同上 |
| format | TEXT | `xlsx` / `pdf` |
| filename | TEXT | 导出文件名（含时间戳） |
| payload | TEXT | 汇总结果 JSON（各 phase 的 E/σ/比例 + 系数 + 合计），**不存原始三点**（原始以 `estimate_items` 为准） |
| created_at | TEXT | ISO 时间戳 |

每项目保留最近 20 条（复用 `TaskService` 历史保留 10 条的裁剪范式——实测 `server/src/services/TaskService.ts:363-368`，`task_result_history` 以 `... ORDER BY replaced_at DESC LIMIT 10` 裁剪，本表参数化为 20）。

### 3.3 参数配置（不建新表）

`app_settings` KV（`server/src/services/AppSettings.ts`）：

| key | 默认 | 含义 |
|---|---|---|
| `estimate.manDaysPerManMonth` | **20.83** | 每人月工天标准（= 模板命名区域「每人月工天标准」，250 工作日/12） |
| `estimate.hoursPerManDay` | 8 | 1 人天=8 人时（模板 E4 文案） |
| `estimate.coef.collaboration` | 0.06 | 客户协作配合/磨合调节系数（模板 R36） |
| `estimate.coef.quality` | 0.06 | 项目质量要求调节系数（模板 R37） |
| `estimate.coef.scope` | 0.05 | 项目范围/需求变更调节系数（模板 R38） |
| `estimate.coef.schedule` | 0.06 | 项目进度变更调节系数（模板 R39） |
| `estimate.rule.default.ratio` | `1:4:1.6` | 规则推导时的 O:M:P 比例（对应 §4.6；取自模板实测：12/12/16、20/20/24、30/30/35 等均呈 O=M、P≈M×1.2~1.6 形态） |
| `estimate.hideCoefsForClient` | false | 客户版 PDF 是否隐藏调节系数与备注（模板备注第 2 条要求） |

> **裁决 D1（2026-10-11 已签）：采 20.83**（客户模板命名区域即报价口径权威）。原口径冲突记录保留如下，供后续复核：IFPUG 功能点模板用「生产效率 = 20」折算人月，而本模板用「每人月工天标准 = 20.83」，两者相差 4%，直接进报价。实现采「默认 20.83 + 可配置」，并要求导出时把该值写进 Excel 参数 sheet（客户可复核），不静默替换；改值需 owner 在参数页显式操作。取 20.83 的两处旁证：① 客户模板命名区域自带注释「每人年平均预估约 240 工作日（即每月平均约 20 工作日）……」——说明文字用 20、取值却是 20.83，本 PRD 以**取值**为准并把该注释随导出件写出（§11.1 红线 5）；② 同机 `27_Evaluation/scripts/pert.py:72` 独立实现的默认值同为 20.83（附录 D）。

### 3.4 与既有实体的映射（数据联动锚点）

| 估算需要 | 现有来源 | 取用方式 |
|---|---|---|
| 工作项标题/描述 | `plan_tasks.title / description` | 面板行主键（左联 `estimate_items`） |
| 阶段归属 | `plan_tasks.kind`（milestone→阶段包络）+ `deps type='child'` 显式归属（T01704 已提供 `planDeps` 单源判定） | milestone 行默认 `phase` 由标题关键字映射（需求/设计/开发/实施/维护） |
| 复杂度系数 | `plan_tasks.complexity`（1~5，可为 NULL） | §4.6 推导规则输入；NULL 时回退默认倍率 |
| 排期事实 | `plan_tasks.duration_days`（工作日） | 与 E 值并列展示做偏差检查（§7），**不参与计算** |
| 需求溯源 | `prd_requirements.req_no` ← `plan_tasks.req_ids` | Excel「需求编号」列；PDF 附录索引 |
| 规模代理 | `test_cases` 按 `req_id` 计数 + P 档权重（P0=3/P1=2/P2=1/P3=0.5） | §4.6 用例加权推导（词表与 T01703 一致） |
| 经验分布 | `tasks`（1580 条，含 `created_at/updated_at`、`progress`） | §4.6 历史耗时校准（本期仅输出建议值，不自动改写） |
| 工作日换算 | `holidays` 表 + 周末规则 | E 人天→日历天的展示换算（可选列） |

---

## 4. PERT 估算模型（计算口径）

### 4.1 三点定义

以「一名具备常规能力的开发者独立完成该工作项」为基准场景：
- **O（最乐观）**：一切顺利、无返工、无外部等待；
- **M（最可能）**：正常情况，含常规自测与一次评审修改；
- **P（最悲观）**：含需求澄清返工、联调阻塞、外部接口变更。

单位为**人天**（1 人天 = 8 人时），与模板 E4 文案一致；输入精度 0.5 人天。

### 4.2 期望值（最终估算值）——与模板公式逐字符对齐

模板 H 列实测公式（196 行同构）：

```
=(MIN(E:G)+MAX(E:G)+4*((SUM(E:G)-MIN(E:G)-MAX(E:G))/(COUNTA(E:G)-2)))/6
```

其中列序为 **E=最可能 M、F=最小 O、G=最大 P**。该式以 MIN/MAX 自动定位极值、以 `(SUM-MIN-MAX)/(COUNTA-2)` 取中间值作为 M，因此：

```
E = (O + P + 4M) / 6        —— 与标准 PERT (O + 4M + P)/6 完全等价
```

**实现要求**：`estimate-engine.ts` 必须实现为标准式 `(O + 4*M + P)/6`，同时提供属性测试断言其与模板式在 `COUNTA=3` 场景下逐值相等（黄金样例取自 §2.2-⑤ 与小工具文档：O=6, M=21, P=36 → E=21）。导出到 Excel 时**写入模板原式**（保持客户可复核、可改值重算），而非静态数值。

> **等价前提（v1.6 依 E2 实施实测补记）**：两式逐值相等**只在 `O ≤ M ≤ P` 时成立**——模板式靠 MIN/MAX 定位中值再按位次加权，三点乱序时必然分叉（反例 0/5/1：标准式 3.5、模板式 1.5，差 2 人天）。该前提由 E1 服务层的 `pointsError` 校验守住（`EstimateService` 拒绝 O>M），引擎自身不再设第二道校验：两道校验迟早漂移成两套报价数。断言见 `scripts/verify-t02036-estimate-e2.mts` 1-05（12341 格全网格逐值相等）与 1-06（乱序反例 + 违例计数为 0）。

### 4.3 不确定度

- 标准差 `σ = (P − O) / 6`；
- 置信区间：`E ± 1σ → 68.26%`、`E ± 2σ → 95.44%`、`E ± 3σ → 99.74%`；
- 里程碑/阶段聚合：`E_phase = ΣE_i`，`σ_phase = √(Σσ_i²)`（独立假设，UI 需注明「未计相关性」）；
- 面板默认展示 **P50（=E）与 P84（=E+1σ，精确 84.13%）**（v1.1 校正：v1.0 写「P85（≈E+1σ）」数学不确——P85 ≈ E+1.04σ；用 P84 可由 E+1σ 精确推出，客户复核时不会对不上）；报价建议取 **P84**（保守但不夸张）。**裁决 D2（2026-10-11 已签）：对外 P84，内部同时看 P50**，本条由主张转为实现口径。

### 4.4 汇总与调节系数（模板 R35~R40 复刻）

```
理想人月（各列）  = Σ(行值 E6:E34) / 每人月工天标准           —— 模板 SUBTOTAL(9,…) 语义
实际预估人月      = 理想人月 × (1 + Σ四个调节系数)
每行估算比例      = 行最终估算值 / 每人月工天标准 / 实际预估人月
系数行比例        = 理想人月 × 系数 / 实际预估人月
```

`SUBTOTAL(9, …)` 的语义要点有**两条**，缺一不可（v1.1 依评审 B2 补强）：

1. **忽略被筛选隐藏的行**——MTask 导出时保留该函数（客户在 Excel 里筛选阶段行即可重算），前端计算则用**当前可见行**求和以保持一致（v1.6 依 E2 实施落点：可见行集合由面板传给 E3 的汇总接口，接口内走同一个 `buildSummary(rows, config)`，**前端不重写求和公式**——两处各写一遍正是本节要防的事）；
2. **忽略范围内其他 SUBTOTAL 的结果**——模板 R35 的求和区间 `E6:E34` **包含 R31「小计：」行**（`E31=SUBTOTAL(9,E8:E30)`），Excel 靠嵌套忽略语义不重复计。前端若对同一区间朴素 `sum()`，**开发段人天会被算两遍、报价人月直接翻倍**。

因此实现口径固定为：**前端汇总 = 5 个阶段行值 + 开发段明细行值，显式排除小计行**（与 SUBTOTAL 嵌套忽略语义等价）；并新增单测断言「前端 Σ ≈ 模板 H35 重算值」（黄金样例见 §4.2）。

**自检口径**（模板备注第 3 条要求人工检查，本 PRD 改为自动）：自检单元格是 **I40 = `SUBTOTAL(9,I35:I39)`**（= Σ阶段比例 I35 + Σ系数比例 I36~I39），不是泛指「Σ估算比例」。面板底部显示「Σ估算比例（I40）= 99.98%（应为 100%，偏差来自四舍五入）」，偏差 >1% 时以 `--danger` 标注并提示存在未归入阶段的行。

> **偏差的代数来源（v1.6 依 E2 实施推导，写清楚免得被当成"精度问题"）**：`I35 = 1/(1+Σ系数)`、系数行 `I_r = 系数/(1+Σ系数)`，两者相加恒等于 **1**——所以完备数据的 I40 不是"接近"而是**精确** 100%（引擎侧实测差值 <1e-12）。真正能把读数推离 100% 的只有两件事：① 显示值四舍五入；② **有行没归进六个阶段**（它在面板里有占比读数，却不在 H35 的分子里）。因此 `buildSummary` 的 `ratioCheck` 把后者逐行点名返回（`unassigned:[{key,phase}]`），面板的告警必须能定位到行——只甩一个"99.98%"等于没做自检。

### 4.5 人天 / 人月 / 日历天换算

- 人天 → 人月：÷ `estimate.manDaysPerManMonth`（默认 20.83）；
- 人天 → 日历天：按工作日映射（跳周末与 `holidays`），供与 `duration_days` 对比。**现无正向函数**（v1.1 实测）：服务端有 `isWorkday/calcEndDate/nextWorkday/workdaysInRange`（`PlanService.ts:263/314/325/279`）、前端有 `web/src/utils/workday.ts` 的 `isWorkday/calcEndDate/countWorkdays/snapWorkdayForward/addDays`，但**没有「从锚点日向后走 N 个工作日」的 `addWorkdays(anchor, n)`** → E1/E2 需新增该工具（服务端 + 前端同语义，参照 `util/planDeps` 的单源教训避免两套口径），单测含 `holidays` 命中与跨周末用例。**E2 已落地的引擎侧入口**：`estimate-engine.ts` 的 `expectedEndWorkday(anchor, E, cal)`——按 ⌈E⌉ 个工作日正向推进，内部直接调 E1 的 `addWorkdays`，不自带第二套工作日口径（断言见 `scripts/verify-t02036-estimate-e2.mts` 2-10~2-13，含放假、加班日与跨周末）；
- **不做**人月 × 单价 → 金额（§1.3 非目标；**裁决 D6 已签：保持非目标**，金额列另行商务确认，不阻塞本期）。

### 4.6 冷启动：从既有数据推导三点

未录入时按优先级择一推导（结果 `source='rule'`，人工改过即转 `source='manual'`）：
> **「转 manual」的落点（v1.7）**：`PATCH /api/estimates/:planId` 未显式携带 `source` 时，把 `rule`/`default` 行转成 `manual`；`EstimateService.upsert` 的「source 缺省=沿用原值」语义保持不动（E1 的 84 条断言按它写），转换只做在路由层——PATCH 是人工录入的唯一通道，在这里转比在 service 里加参数少一个可被绕过的入口。显式传 `source:'rule'` 仍可写回（AI/批量通道要用）。不转的后果：§9 的「人工复核率 = `source='manual'` 占比」会把人已改过的行继续算成未复核机器值，上线度量直接失真。

1. **复杂度映射**（`complexity` 非空，如 swork 已填）
   `M = base_days(complexity)`，`O = M × rO`，`P = M × rP`；默认 `base_days` = {1:1, 2:2, 3:3.5, 4:5, 5:8}，`rO:rM:rP` 取 `estimate.rule.default.ratio`（1 : 4 : 1.6 → 即 O=M、P=1.6M，与模板实测形态一致）。
   > **比例串的读法已定死（v1.6，E3 实施前必须有一条口径，否则两侧各猜一套）**：按正文显式式子取意——**首末两段是 O、P 相对 M 的倍率，中段那个 4 是 PERT 权重而不是 M 的倍率**，所以 `1:4:1.6` 得 O=M×1、P=M×1.6（与模板实测 12/12/16、20/20/24、30/30/35 形态吻合）。实现落 `estimate-engine.ts` 的 `parseRuleRatio()`：段数不对/含非正数报错，**中段不是 4 也报错**（写成 `1:5:1.6` 只能是配置手滑，猜成 M×5 会推出离谱工时）。E3 的 derive 与 E13 的参数页都调这一个函数。
2. **用例加权映射**（该计划关联需求存在用例，如 swork 71 条）
   `M = clamp(Σ权重 × k, 0.5, 20)`，权重 P0=3/P1=2/P2=1/P3=0.5，`k` 默认 0.5（项目级可配）。
   > **k 的键名（v1.7 补，E3 实测口径）**：`app_settings` 里 §3.3 未给这一支的键名，实现定死为全局 `estimate.caseWeightK` + 项目级 `estimate.caseWeightK.<projectId>`（项目级优先）。非正数/非数字**报错**不静默回落——k 写歪一位，整个项目用例档的 M 全跟着歪。未知优先级（不在 P0~P3 内）权重记 0 并单独回传 `basis.caseWeightUnknown` 计数，不猜档。
   > **三档推导值一律落到 0.5 人天网格（v1.7）**：§4.1 写了「输入精度 0.5 人天」但没说推导要不要对齐；不对齐的话面板显示 `M=3.25 / P=5.2`，而客户模板全是 .5 步进，E6 导出与面板就成了两套数。实现见 `EstimateDerive.ts` 的 `toGrid()`（`Math.round(v×2)/2`），断言在 `scripts/verify-t02037-estimate-e3.mts` S-03~S-08。
3. **工期回退**（仅有 `duration_days`，如 mtask四期/一期全部计划）
   `M = duration_days`，`O = 0.8M`，`P = 1.4M`（面板显式提示「由排期工期推导，建议复核」）。
4. **历史耗时校准**（离线建议，本期只读输出）
   取同项目已完成 `tasks` 的 `updated_at − created_at` 分位数，按分类聚合，输出「建议 M 由 X→Y」提示，**不自动写入**。

> 实测基线（v1.4 复查，见 §1.1）：mtask四期 37 条未归档计划**已全部非空** → 该项目可直接走规则 1；mtask一期 20 条仍全 NULL（项目已进历史资产，不再补录，见 §11-E15）；swork 已具备规则 1+2 的全部输入。**规则 1 覆盖不到的项目（NULL 行）仍必须能落到规则 3**，否则功能上线即空面板——判据按「项目」而非「全库」计。
> **里程碑不重复计（v1.4 依 §1.4 实测口径）**：`complexity` 在里程碑行同样有值，而里程碑是其下明细的包络（§5.2 面板渲染为组头）。若规则 1 对**全表逐行**推导后再求和，一个阶段的工作量会被「里程碑 + 其明细」计两次。E3 的 `derive` 与 §4.4 汇总必须限定 `kind='normal'`（里程碑行可显示推导值供参考，但**不进 Σ**），并在单测里断言「Σ(normal) 与含 milestone 的 Σ 之差 = milestone 行推导值之和」。

---

## 5. 交互设计（估算视图）

### 5.1 入口与布局

**裁决 D3（2026-10-11 已签）：不新增第四视图，在时间线视图内右侧分栏常驻估算面板**（一并认可 E4 量级因「无分栏基元」由 L 上调至 XL）。

理由：① `PlanViewModeToggle`（`PlanPage.tsx:354`）已 3 段，加第 4 段会让「同一份计划的另一种视角」与「另一种数据」混淆；② 估算的价值在于**与时间线脉络同时看见**（阶段包络 → 阶段人月）；③ 分栏不改变 `viewMode` 的会话态持久键（`plan.viewMode`），回归风险最小。

布局（`renderTimeline()` 改造，`PlanPage.tsx:1938`）：

```
┌─ 时间线视图 ────────────────────────────────────────────────┐
│ [说明文案]              [粒度][间距][一键收起][估算面板 ⤢] │  ← 面板开关与三枚 toggle 同排
├──────────────────────────────────┬─────────────────────────┤
│ PlanTimeline（flex:1，现有渲染） │ EstimatePanel width=420 │
│                                  │  ┌ 汇总卡（sticky）    │
│                                  │  ├ 阶段列表 + 区间图    │
│                                  │  ├ 明细行（行内 O/M/P） │
│                                  │  └ 导出区（Excel/PDF）  │
└──────────────────────────────────┴─────────────────────────┘
```

- 面板开合态：`useSessionState('plan.estimatePanelOpen', false)`（与 `plan.viewMode`、`plan.collapsedMs` 同套持久化口径）。
- **新增成本如实计入（v1.1 依评审 M1）**：实测 `web/src/` **无任何 SplitPane / 右栏停靠基元可复用**（只有覆盖式 `web/src/components/SlideOver.tsx`），上图的 docked 分栏属新建；同时 `PlanTimeline` 原为整宽渲染，被 420px 挤压后的节点重叠/横向溢出风险未验证 → 验收补一档宽度走查（见 §10 第 13 项）。
- 视口宽度 <1200px 时面板转为覆盖式 `SlideOver`（宽度 420）。**E4 实测补记（v1.8）**：阈值写成可断言的纯函数 `estimatePanelModeForWidth(width)`（`<1200 → overlay`）并监听 `resize`，拖动窗口即时切换；转为抽屉时面板内标题行隐去（`hideHeading`），否则与 `SlideOver` 自带标题同屏重复。
- 面板打开时甘特视图不变（甘特另有「估算区间叠加」开关，见 §5.4）。
- 明细列要显示「复杂度」：**v1.8 按 E4 实测校正**——`GET /api/plans`（`PlanService.list` 走 `SELECT p.*`）本就返回 `complexity`，缺的只是时间线数据源类型 `TlPlan`（`web/src/components/PlanTimeline.tsx:36-52`）没声明该字段。E4 只加了一个可选字段 `complexity?: number | null`，**服务端与计划查询零改动**。

### 5.2 面板结构与状态

自上而下四段：

1. **汇总卡**（3 张，sticky）：实际预估人月（P50/P84 并列，口径见 §4.3）、理想人月、Σ估算比例校验（读数对应导出件 **I40**）；卡右下角小字显示换算参数「20.83 人天/人月 · 系数和 0.23」，点击进参数弹层。
2. **阶段视图**：6 个 phase 行（`req/design/dev/impl/common/onsite`），每行 `E / σ / 比例 / 区间条`；phase 无数据时置灰显示「未纳入本次报价」，不可删除（模板固定 6 类阶段结构）。
3. **明细行**：与时间线同源的计划条目列表（milestone 显示为组头、子项缩进，折叠态与 `plan.collapsedMs` 共享，延续 T01576 口径）；列：标题 / 需求编号 / 复杂度 / **O M P** / E / σ / 来源徽标。
4. **导出区**：`导出 Excel`、`导出 PDF（内部版）`、`导出 PDF（客户版）`，下方列出最近 5 次快照（`estimate_snapshots`）时间，可点「对比」看两次报价差异。

**E4 首段落地口径（v1.8 实施校正，实施单 T02039）**：

- **分组单源**：明细的里程碑分组直接复用时间线的 `groupTimelinePhases`，折叠读同一份 `plan.collapsedMs`——本仓 `planDeps` 双口径的教训不重演（面板不写第三套分组）。
- **需求编号列不新增服务端字段**：取需求矩阵现成接口 `GET /api/plans/prd-requirements?projectId=`，按 `linkedPlans[].id` 反查 `req_no`。为这一列改计划查询属重复建设。
- **逐行 σ 由服务端下发**：`summary.rowRatios[]` additive 补 `sigma` 字段。§9「前端不重写公式」若只管 E 不管 σ，面板 σ 列就只能空着或前端再算一遍。
- **零计算红线（面板内不做任何三点运算）**：汇总卡、阶段表、明细 E/σ 全部读 `GET /api/estimates` 响应；该约束由取数脚本反向断言（面板源码不含 PERT/σ 式子、不引图表库、不 import 服务端模块）。
- **交付分段**：本单只交付第 1/2/3 段 + 空态一键填充；**行内 O/M/P 录入与行内错误态（`O>M` 标红、导出禁用）随 T02040**、**每行 O~P 区间条随 T02041**、**第 4 段导出区随 E6/E7**。面板内不预留空壳按钮——预留一个没验过的交互比少一个按钮更贵。

状态要求：
- **加载**：骨架 `className="skel"`（复用 `ResultDiff.tsx` 空态范式）。
- **空态**：**v1.8 判据校正**——空态是「项目下一条估算都没有」（`items.length === 0`），不是原文写的「全部 `source='default'`」：`default` 行也要先经「按规则推导」写入才存在，按原判据空态永远不触发。空态下明细区上方常驻提示「尚未录入估算——点『按规则推导』用复杂度/用例/工期生成初始值」，按钮先 `dryRun` 预览 `writableCount` 再确认写入（预览行数与写入行数同源，§10-5）。
- **部分录入**：来源徽标混排（人工/规则/默认），未落库行显示推导档（`默认·复杂度` / `默认·用例` / `默认·工期`）并灰显、标为「建议值不进 Σ」；筛选「只看未复核（source≠manual）」**v1.9 随 T02040 落地**——口径是 `source !== 'manual'`（规则/默认/未录入都算待复核），与 §9 复核率同源，不靠徽标文案猜。
- **错误**：`O>M` 或 `P<M` 的行内联标红 + 底部提示「N 行不满足 O≤M≤P，导出前须修正」；导出按钮在存在错误时禁用并 title 说明原因。**v1.9 随 T02040 落地（§5.3 写路径）**：行内三列可编辑，错误态由服务端 400 文案驱动（面板不第二次判定），底部提示条逐行点名「计划标题：服务端原话」；红色取 `var(--danger)`，不硬编码色值。导出禁用随 E6 接入（本段先落 Σ估算比例偏差告警条 + 「脱离计划」计数与**显式清理入口**）。

### 5.3 录入与批量填充

- **行内编辑**：O/M/P 三列直接可编辑（`input[type=number] step=0.5`），Enter 保存、Esc 还原；焦点离开即 `PATCH /api/estimates/:planId`（即时落库，与计划页现有「操作均即时落库」口径一致）。
- **批量填充**：多选行 →「批量设定」→ 三种模式：① 按复杂度重新推导；② 按用例加权推导；③ 统一值 + 相对幅度（如 M=3，O=M×0.8，P=M×1.4）。二次确认走 `askConfirm`（`web/src/ui/dialogs.tsx`，**禁用原生 confirm**——Electron 不可靠，T01607/T01699 已定口径）。
- **撤销**：批量写入前把受影响行原值存入本次会话内存栈，面板顶部提示「已填充 N 行 · 撤销」。
- **一致性**：`E` 列只读，随输入实时重算（前端算，不落库）。**v1.9 裁决改写**：「前端算」与 §5.2/§9 的零计算红线互斥，落地形态为 **PATCH → 立即重取 `GET /api/estimates`**，E/σ/汇总卡读数全部来自服务端那一次重算；观感上仍是「改一个数、整屏跟着变」，但算式只有一份（真机断言 U-08/U-08b：改值后汇总卡读数变化、徽标由「默认·复杂度」转「人工」）。

**E4 写路径 / E5 落地口径（v1.9 实施校正，实施单 T02040）**：

- **三模式的两条通道**：①② 走 `POST /api/estimates/batch` `mode=derive` + `onlyRule`（**过滤语义**：不属于该档的行服务端整行跳过，新增 `skip='offRule'` 计数，面板在确认文案里如实报「N 行可写入、M 行不属于该档、K 行为人工复核过的行」）；③ 走 `mode=set`（`items` 带显式 `source:'manual'`——人给的统一值就是人工复核，不能让批量通道把徽标留在「规则」）。
- **预览行数 = 写入行数**：`dryRun` 预览与实际写入用同一组参数（含 `planIds` 作用域），按钮文案「写入 N 行」与落库行数不打架（§10-5，断言 U-12/R 段）。
- **人工行保护在批量通道同样生效**：`includeManual` 缺省 `false`，面板**不传**该参数——是否覆盖用户复核过的值不由批量按钮擅自决定，跳过的行数报出来即可。
- **撤销双通道**：会话内存栈存**写入前**快照（含 `source`/`phase`），撤销时原态有行的按 `PATCH` 还原、原态无行的按 `DELETE` 回滚（`batchSet` + `removeItem` 两条路），toast 分别报「还原 N 行，删除 M 行新建估算」——只说「已撤销」会把用户骗过一次。
- **建议行首次落库继承推导值**：只改一格时，另外两点取该行当前推导建议（面板不猜数，值来自 `derive` 预览），并带上 `phase`；三点仍由服务端校验，`M>P` 之类照样拒。
- **里程碑不参与**：勾选框与三点格对里程碑行不渲染（组头只读显示 E 与「不进 Σ」），批量作用域 `batchableIds` 天然排除——§4.6 红线一在 UI 层与写路径同一条款。
- **两处只有真机能看见的缺陷**（本单实测抓到，现各有断言守着）：规则按钮渲染正常但**没挂 `onClick`**（点了没反应，S-13c）；`runBatch` 漏传 `onlyRule`（三个按钮行为完全相同，S-13b）。数据层脚本对这两类问题永远全绿，故 U-13c 额外要求网络层真的出现 `POST /api/estimates/batch` 200。

### 5.4 可视化

| 图 | 内容 | 取舍 |
|---|---|---|
| 区间条（面板内每行） | 横向 whisker：O——P，中间竖线标 E，颜色 `--accent` | **P0**（v1.1：归入 E4，不再挂在 P1 的 E8 上——成本最低、信息密度最高，且没有它面板就无法表达不确定度） |
| 阶段柱 + 误差线 | 6 个 phase 的 E 柱，顶部画 ±1σ 误差线 | P1（E11） |
| 帕累托图 | 按 E 降序累计占比曲线，标 80% 线 | P1（E11） |
| 甘特叠加 | 甘特条上叠半透明 O~P 区间（`renderGantt`，`PlanPage.tsx:1991`） | P1，E8，与时间线面板开关独立 |
| 龙卷风图（敏感性） | 各行 σ 降序，示意「哪条最影响总价」 | P2，**E14**（v1.1 补齐：v1.0 此项无对应工作项，违反「有建议必有落点」的闭环要求） |
| PERT 网络图 | 依赖图 + 节点三点 | **不做**（M6-6.1 已有依赖线 + 关键路径，重复且收益低） |

图表实现约束：**不引入图表库**，用现有 SVG/CSS 手绘（`PlanTimeline.tsx` 已有同范式）；颜色只取 CSS 变量。

### 5.5 UI 风格守卫（延续 `docs` 内既有约定）

- 全部内联样式走 CSS 变量（`--card-bg/--surface/--border/--border-strong/--text/--text-muted/--accent/--accent-text/--danger/--success`）；
- 明暗主题双验（`ThemeContext` 现有），禁止硬编码色值；
- 字号沿用 11/12/13/14/16 阶梯；数字列 `FONT_MONO` 右对齐；
- 按钮统一 `tbtn-anim` 动效；图标 `lucide-react` 已引入（`Calculator`、`Download`、`SlidersHorizontal`、`Wand2`）；
- 虚拟滚动：**本期不做**（v1.1 消除未决句）。实测单项目计划行数 ≤20（mtask四期 20 / 一期 20），全库 528 行也按项目隔离渲染，原生渲染足够；§9 的 500 行指标是**压力上限验收**，不是常态路径。

---

## 6. 导出功能规格

### 6.1 Excel 导出（严格复刻模板）

**端点**：`GET /api/estimates/export-xlsx?projectId=&scope=all|estimated_only&phases=req,dev,…`（v1.1：一个参数只表一件事，`scope` 只管「是否仅已估算行」，阶段筛选独立走 `phases`），经 `exportGate('estimates-export-xlsx', undefined, { defer: true })`。并发闸语义实测补充：`exportGate` 是**并发信号量**（超限直接 429，不排队），默认上限 2，可被 `app_settings` 的 `exportGateLimit.<name>` 覆盖（`server/src/util/export-gate.ts:67`）；带 `defer:true` 的既有先例是 `prd-doc-export` / `req-matrix-export` / `testcase-export`，而 `plans-export`（`routes/plans.ts:104`）**不带** defer——新端点按前者取 `defer:true`。

**必须逐格对齐的结构**（实测自模板，附录 A）：

| 位置 | 内容 | 实现要求 |
|---|---|---|
| sheet 名 | `项目工作量估算表` | 固定 |
| B1（合并 B1:I1） | `项目工作量估算表` | 标题，加粗居中 |
| C2 / D2 | `估算日期` / 日期值 | 导出日 `YYYY-MM-DD` |
| E2 / F2 | `审批人` / 值 | 空值留空（由用户填写） |
| G2 / H2（合并 H2:I2） | `估算人` / 值 | 取 `estimate_settings.reviewer` 或留空 |
| B3:C3 + D3:I3 | `项目名称` / 值 | 值 = `projects.name` |
| B4:D4 / E4:H4 / I4 | `项目任务分解` / `估算结果(单位：人天，1人天=8人时）` / `估算比例` | 文案逐字符复制（含全角括号与右括号缺一个的原文拼写） |
| B5/C5/D5/E5/F5/G5/H5 | `产品/子系统/大模块` / （空）/ `小模块/功能单元/业务单元` / `最可能` / `最小` / `最大` / `最终\n估算值` | H5 保留换行符 |
| R6 | `需求分析`（B6:D6 合并）+ E/F/G 三值 + H 公式 + I 公式 | 阶段行（单行即汇总，无明细） |
| R7 | `系统设计（概设&详设、数据库设计）` | 阶段行（B7:D7 合并） |
| R8…R30 | `开发/研发（编码，单元测试，联调，评审等）`（B8:B31 纵向合并）+ C 中模块（同模块纵向合并）+ D 功能点描述 + E/F/G + H 公式 | **主数据区** |
| **R31** | `小计：`（D31）；`E31..H31 = SUBTOTAL(9,X8:X30)` | **小计行是公式行不是数据行**——明细区末行不是数据；此行的存在直接决定 R35 的求和语义（见 §4.4 排除规则） |
| R8 的 I 列 | `I8:I31` **纵向合并为一格**，公式 `=IFERROR(H31/每人月工天标准/$H$40,"")` | 语义是「**开发段整体比例**」（分子取 H31 小计，不是笔误）——非 dev 阶段行才用 `H{r}/…` 单行比例 |
| R32/R33/R34 | `实施（含安装部署、调测、验收、投产变更、跟踪优化、收尾结项及合理范围的空耗等）` / `公共&远程投入（如项目管理、质量管理、远程开发和技术支持、产品研发分摊等）` / `现场维护（对于客户要求或我方拟计划项目交付后仍需安排人员现场驻员技术服务的）` | 阶段行（各 B:D 合并） |
| **R35** | `项目总投入直接成本（单位：工作人月）最理想值：`（B35:D35 合并）；**E/F/G/H 四列各一条** `=SUBTOTAL(9,X6:X34)/每人月工天标准`；**I35 = `=SUBTOTAL(9,I6:I34)`** | 只写 E 列会导致客户改 F/G/H 后不重算——四列 + I 列必须全写 |
| **R36~R39** | 四个调节系数行（客户协作磨合 0.06 / 质量要求 0.06 / 范围变更 0.05 / 进度变更 0.06），每行 B:D 合并；**三列同值 E=F=G=系数**，`H{r}` 同样是 §4.2 的模板原式，`I{r} = =IFERROR($H$35*H{r}/$H$40,"")` | 系数在模板里也被当作三点行处理；只写 E 列会让 H36~H39 空、R40 求和失真 |
| **R40** | `项目总投入直接成本（单位：工作人月）实际预估值：`（B40:D40 合并）；**E40..H40 各一条** `=X35*(1+SUM(X36:X39))`；**I40 = `=SUBTOTAL(9,I35:I39)`** | I40 即「Σ估算比例应为 100%」的自检单元格（§4.4） |
| R42（合并 B42:I42） | `备注/说明：` 三条 | 原文复制（内部版必带；客户版按 §6.2 屏蔽） |
| 表头纵向合并 | `I4:I5`（「估算比例」跨两行）、`B5:C5`（大模块表头） | 与 `E4:H4` 一并还原，否则表头错位 |
| 命名区域 | `每人月工天标准 => 20.83` | **必须写成 workbook definedName**，否则公式全失效（非 ASCII 名称的写入可行性见 §11-E0） |
| 列宽 | A=2.0 B=6.5 C=15.625 D=63.125 E=8.25 F=8.375 G=8.125 H=6.5 I=5.5 | 逐列设置（D 列宽是关键：长描述不折行成糊墙） |

**合并区完整清单（实测 28 处，v1.1 校正——v1.0 误记 20 处）**：`B1:I1`、`H2:I2`、`B3:C3`、`D3:I3`、`B4:D4`、`E4:H4`、`I4:I5`、`B5:C5`、`B6:D6`、`B7:D7`、`B8:B31`、`I8:I31`、`C8:C11`、`C12:C15`、`C16:C18`、`C22:C23`、`C25:C26`、`C27:C28`、`B32:D32`、`B33:D33`、`B34:D34`、`B35:D35`、`B36:D36`、`B37:D37`、`B38:D38`、`B39:D39`、`B40:D40`、`B42:I42`。导出实现的断言基线 = 这 28 处（其中 C 列模块合并数量随实际数据变化，其余为固定结构）。

**列映射表（MTask 字段 → 模板单元格）**

| 模板列 | MTask 来源 | 规则 |
|---|---|---|
| B（大模块） | phase 名 | 阶段行 B:D 合并；开发段 B 列纵向合并覆盖全部功能行 |
| C（中模块） | `plan_tasks.kind='milestone'` 的标题（其 child 归属按 `deps type='child'`，`util/planDeps.ts` 单源） | 同模块纵向合并（同模板 C8:C11 式）；无 child 关系时留空不合并 |
| D（功能点描述） | `plan_tasks.description`（为空则 `title`） | 原文；导出前 `\r?\n` → ` `，>500 字截断加「…（见需求 FR-xxx）」 |
| E（最可能） | `estimate_items.likely` | 人天，0.5 精度 |
| F（最小） | `estimate_items.optimistic` |  |
| G（最大） | `estimate_items.pessimistic` |  |
| H（最终估算值） | — | **写模板原公式**（§4.2），不写静态值 |
| I（估算比例） | — | `=IFERROR(H{r}/每人月工天标准/$H$40,"")`；阶段汇总行按模板用 `$H$35*H{r}/$H$40` |

**行结构还原**：MTask 的明细行需按 phase 分组落位——`req/design/impl/common/onsite` 各 1 行（模板是阶段行，无明细），`dev` 展开全部开发类计划条目，其后**必须补 R31 小计行**（模板形态：数据行 R8:R30 + 小计 R31，段间不留空行）。若某非 dev 阶段存在多条明细，则聚合为 1 行并在 D 列以「（含 N 项，详见内部导出版）」注记。开发段的比例列不逐行写，按 `I8:I31` 合并表达整体比例（附录 A）。

**附加 sheet（不破坏主 sheet 的客户口径）**：
- `估算明细（MTask）`：全量行 + `req_no` + `plan_id` + 来源标记 + σ + 生成时间，用于内部复核；
- `参数`：换算参数与四系数（含「20 vs 20.83」口径冲突提示），用于评审留痕。

### 6.2 PDF 导出（交付/报价版）

**端点**：`GET /api/estimates/export-pdf?projectId=&audience=internal|client`，同样走 `exportGate`。

- 复用 `server/src/services/prdExport.ts` 的 pdfkit 渲染链（Markdown → 块 → PDF），新建 `estimate-report.md` 中间文档（表格式汇总 + 阶段构成 + 置信区间说明 + 免责声明），再渲染；
- **已知限制必须写入 PRD 与代码注释**：pdfkit 中文依赖系统黑体，非 Windows 或字体缺失时中文显示方框（`prdExport.ts:140` 已注明）。因此 PDF 定位为「汇报/预览」，**对外正式交付以 Excel 为准**；客户版若需严格版式，走 Excel→打印 PDF 的既有路径。**裁决 D4（2026-10-11 已签）：PDF 仅预览、Excel 为正式交付**，不为 PDF 中文版式追加字体依赖；
- `audience=client` 时：隐藏四个调节系数、隐藏 §6.1 备注三条、隐藏内部 sheet 引用、隐藏 σ/置信区间列（模板备注第 2 条要求：引导客户关注价值而非成本），并受 `estimate.hideCoefsForClient` 控制；
- 文件名：`工作量评估-<项目名>-YYYYMMDD-HHmmss.pdf`（时间戳与中文命名口径同 `/api/plans/export`）。

### 6.3 文件命名 / 权限 / 失败处理

- 文件名统一 `<前缀>-<项目名>-YYYYMMDD-HHmmss.<ext>`，项目名做 `[/\\:*?"<>|]` 清洗（与既有导出一致）；
- 单机单用户系统无角色区分（沿用 `docs/PRD-项目计划.md` §4）；「权限控制」体现为**客户版脱敏开关**（§6.2）而非账号权限；
- 全部导出写入 `estimate_snapshots`；
- `exportGate` 满时返回既有约定的 busy 语义，前端提示「导出通道繁忙，稍后重试」，不静默失败；
- 任一行 `source='default'`（未复核）时导出仍允许，但 Excel 附加 sheet 与 PDF 首页显著标注「N 行为系统推导值，未人工复核」。

---

## 7. 数据联动与变更影响

| 场景 | 行为 |
|---|---|
| 计划新增一条 | 估算面板出现对应行（`source='default'`，走 §4.6 规则推导），行首标「新」 |
| 计划删除/归档 | 计划走**软归档**（`plan_tasks.archived=1`，`schema.ts:517-518`），`estimate_items` **不级联删除**、原样保留（历史报价依据）；面板按归档态过滤该行，并提示「有 N 条估算已脱离计划，是否清理」，清理为**显式手动操作**（v1.1 依评审 B5，与 §3.1 口径统一）。**v1.9 落地（T02040）**：告警条上的「清理脱离行」按钮先 `GET /api/estimates/detach` 列明细、`askConfirm` 里逐条给出三点样例值，再 `POST /detach/cleanup` 按 id 删除；该操作**不进撤销栈**（删的是已脱离计划的行，面板明说「无法恢复」），确认前不删任何东西 |
| 计划工期改动（`duration_days`） | E 值不变（估算独立），但面板在该行显示**偏差徽标**：`E/duration_days` 比值 >1.5 或 <0.67 时黄色提示 |
| 三点改动 | 只改估算，不动排期；若 E 人天 > 剩余排期，汇总卡出现「排期与估算不一致」提示 |
| 阶段里程碑收口（进度 100%） | 估算行只读化（保留可解锁），避免已交付项被追溯改写报价 |
| 导出后计划又变更 | 面板顶部常驻「上次导出后 3 条计划已变化 → 建议重导」，数据来自 `estimate_snapshots.created_at` 与 `plan_tasks.updated_at` 比对 |
| MCP 外部回传改计划 | 与界面改动同路径（走 `PlanService`），估算面板下次拉取自然刷新；不新增钩子 |

**变更影响分析（报价场景）**：面板提供「影响试算」——调整任一系数或某行 P 值时，右侧即时显示「实际预估人月 X → Y（Δ Z%）」，让 PM 在提交前知道砍系数的代价。

---

## 8. API 接口定义建议

遵循现有路由与 `wrap(res, fn)` / `pid(req)` 约定（`server/src/routes/plans.ts`）。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/estimates?projectId=` | 全量估算：明细行（含 plan 字段左联）+ 汇总 + 参数 + 校验结果 |
| `PATCH /api/estimates/:planId` | 单行录入 `{phase?, optimistic, likely, pessimistic, note?}`；校验 O≤M≤P |
| `POST /api/estimates/batch` | 批量写入 `{items:[{planId, …}], mode:'set'|'derive'}`；事务，任一行失败整体回滚 + 行级错误 |
| `POST /api/estimates/derive` | 按规则推导（复杂度/用例/工期三档），`{dryRun:true}` 返回预览不落库 |
| `GET /api/estimates/params` / `PUT /api/estimates/params` | 读写 §3.3 配置（复用 `AppSettings`） |
| `GET /api/estimates/export-xlsx` / `export-pdf` | 见 §6 |
| `GET /api/estimates/snapshots?projectId=` | 最近快照列表；`?compare=a,b` 返回两版差异 |

**E3 实测补充（v1.7，落地形态与上表的差异都在这里，避免 E4/E10/E13 各自猜）**：

- `GET /api/estimates?projectId=&includeArchived=` 一次返回 `items / summary / params / meta / checks` 五块；**`includeArchived` 只影响 `items`，不影响 `summary`**（§3.1「归档行不进 Σ」——审计视角一开就把归档工作量算进报价是错的方向）。`checks` = `ratioCheck`（§4.4 I40 自检）+ `coverage`（normal/milestone/estimated/missing/bySource/detached，§9 复核率出数口）+ `detached`。
- 新增两枚上表未列的端点：`GET /api/estimates/meta`（§9「枚举与标签单源」的下发口：阶段/系数标签、8 个参数键名、复杂度基准档、用例权重、工期倍率）、`GET /api/estimates/detach` + `POST /api/estimates/detach/cleanup {ids}`（§7「清理为显式手动操作」；清理只动确属脱离的行，在架行返回 `removed:0`）。
- `POST /api/estimates/derive` **默认 `dryRun=true`**（`{dryRun:false}` 才落库）。上表写的是「`{dryRun:true}` 返回预览」，但把「写」当默认值意味着任何一次忘记传参的调用都在改库——报价依据不该这样。参数：`planIds?`、`scope:'missing'|'all'`（默认 missing：只补未估算行）、`includeManual?`（`scope=all` 下才生效，人工行默认受保护）、`caseWeightK?`（影响试算用，不落配置）。
- `POST /api/estimates/batch` 的 `mode:'derive'` 走同一套推导（`dryRun` 默认 false，与 derive 相反：批量端点本身就是写通道）；`mode:'set'` 沿用 §3.1「任一行不合格零写入 + 行级 `errors[{index,planId,message}]`」。
- `PUT /api/estimates/params {settings:{…}}`：**先全量试算再落库**（含单个非法值时整批零写入并回 400 中文文案）；值传空串 = 删除该配置、回落默认；未知键直接 400（防参数页写歪到别的 KV）。响应里的 `config` 是**写后回读**的生效值。
- 排除计数口径（引擎既有行为，记下来免得当成 bug）：`ratioCheck.excluded` 按「未估算 → 小计 → 里程碑」优先级归类，**未估算的里程碑行计入 `unEstimated` 而非 `milestone`**；里程碑真正带上估算值时才进 `milestone`。两条路径都不进 Σ（断言 S-26/S-27、R-53）。
- 导出端点 `export-xlsx` / `export-pdf` 属 E6/E7，**E3 不留占位路由**（空实现会被前端当成已就绪）。
- 验证：`scripts/verify-t02037-estimate-e3.mts`（S 段服务层 + R 段隔离实例 REST 全链）——**PASS=83 FAIL=0**。


MCP 工具（`server/src/mcp/server.ts`，注意 T01490 的响应体量截断教训：列表默认 brief + 显式 `full` 开关）：
`mtask_get_estimates {projectId|projectName, brief?}`、`mtask_update_estimates {taskNo|planId, optimistic, likely, pessimistic}`、`mtask_export_estimate_workload {projectId, format:'xlsx'|'pdf', audience?}`。

---

## 9. 非功能需求

| 维度 | 指标 | 验收方式 |
|---|---|---|
| 性能 | 500 行明细：面板首屏渲染 <500ms；`derive` 全量 <800ms；Excel 导出 500 行 <3s；PDF <6s | 隔离实例计时（`MTask_PORT` + `MTask_DATA_DIR` 副本库），复用 perf 目录既有基准脚本 |
| 正确性 | 汇总与人月换算误差 <0.01；导出文件在 Excel 打开后**公式可重算**且 H/I 列结果与面板一致到 2 位小数；前端 Σ ≈ 模板 H35（小计行不被双重计入，见 §4.4） | **三轨断言（v1.3 依 E0 Spike 实测改写 v1.1 的两轨口径）**：① 公式轨——用 openpyxl `data_only=False`（或直读 `xl/worksheets/sheetN.xml` 的 `<f>`）断言公式**串**与区间正确；② 缓存轨——`data_only=True` 断言 `<v>` 存在且等于估算引擎的输出（**exceljs 用 `{formula, result}` 双写即可产出缓存值，v1.1「exceljs 写公式必无缓存值」的判断已被实测推翻**）；③ 重算轨——Excel COM `CalculateFull()` 后取 `Value2` 与②比对，**差值 >1e-6 即失败**。三轨都过才算通过：E0 用一条故意写错的缓存值验证过——②轨能过而③轨抓到 0.608097 vs 0.576092 的偏差，证明「只断言缓存值」会放行错数 |
| 上线度量（v1.1 依评审 M14） | 功能是否被真用，三项：导出次数、人工复核率（`source='manual'` 行占比）、覆盖项目数 | 从 `estimate_snapshots` 与 `estimate_items.source` 出数；上线后首月复核率 <30% 视为估算不可信，触发 §4.6 规则参数复审 |
| 兼容 | Excel 2016+ / WPS（客户环境）；PDF 阅读器无要求（以 Excel 为正式交付物） | 真机用 Excel/WPS 各开一次，检查合并区与命名区域无损 |
| 数据一致 | 估算与排期解耦：删除估算不影响 `plan_tasks`；删除计划不留孤立行（级联/过滤见 §7） | API 冒烟 + 只读库比对 |
| 安全 | 报价数据不落第三方；导出端点走 `exportGate`；客户版脱敏由服务端决定（前端隐藏不算脱敏） | 代码审查断言：`audience=client` 分支在**服务端**过滤 |
| 可访问性 | 数字输入 `aria-label`；面板 `role="region"` + `aria-label="估算面板"`；键盘 Tab 可达全部录入控件；对比度沿用主题 | a11y 走查（延续 `docs` 内 T01674 键盘可达教训：禁止 label 包裹 `display:none` 文件框这类不可达写法） |
| 可维护 | 计算逻辑集中 `server/src/services/estimate-engine.ts`（**纯计算模块，不碰库不读配置**）+ `server/src/services/EstimateService.ts`（数据层），前端只读展示、经 E3 汇总接口取数，**避免两处公式各写一遍**（同 T01621 的 planDeps 单源教训）。⚠ v1.0~v1.5 本行原写 `web/src/util/estimate-engine.ts`，v1.6 按 E2 实施实测校正到服务端：`server/tsconfig.json` 有 `rootDir:"src"`、`web/tsconfig.json` 只 include `src`，两侧都无跨包 alias，web 持唯一实现会让服务端拿不到同一套数——而 §11.1 红线 2 明文要求「导出件的缓存值只能来自估算引擎的输出」。配置键名与四个系数的标签/顺序同样单源在引擎（`ESTIMATE_SETTING_KEYS` / `ESTIMATE_COEF_SETTING_KEYS`），E13 参数页不得再抄一份 | 单测覆盖引擎全分支（`scripts/verify-t02036-estimate-e2.mts`，含 Excel `SUBTOTAL(9,…)` 语义仿真对照轨） |

---

## 10. 验收标准（逐条可测）

1. 时间线视图出现「估算面板」开关，开合态刷新后保持；列表/甘特视图无此开关（不受影响）。
2. 面板打开即显示全部计划行；`complexity` 为空的项目（如 mtask四期 20 条）按 §4.6 规则 3 给出推导值且带「默认」徽标。
3. 行内改 O/M/P 后 E、σ、比例、汇总卡即时刷新；刷新页面后值仍在（已落库）。
4. 录入 `O>M` 被拒：行内标红、底部计数提示、导出按钮禁用。
5. 「按规则推导」`dryRun` 预览行数与确认写入行数一致；批量写入可撤销。
6. 甘特视图勾选「估算区间叠加」后，每条任务条出现 O~P whisker，不影响既有依赖线与关键路径。
7. 导出 Excel 后：sheet 名 = `项目工作量估算表`；B1/C2/B3/B4/H5 文案与模板逐字符一致；H 列是**公式**不是数值；命名区域 `每人月工天标准` 存在且改值后 R35/R40 重算生效；**合并区 28 处**（§6.1 完整清单）无丢失；**R35/R40 的 E/F/G/H 四列与 I 列公式齐全**（缺一即失败）；**R31 小计行为 `SUBTOTAL(9,X8:X30)` 公式**；**R36~R39 系数行 E=F=G 同值且 H 带公式**；**I8:I31 为单格合并的开发段整体比例**；列宽与模板一致。断言方式按 §9 双轨执行（公式串轨 + 打开重算数值轨）。
8. `I40` 对应值显示接近 100%，人为制造未归阶段行时偏差告警出现。
9. 导出 PDF（客户版）不含四个调节系数、备注三条、σ 列；内部版全含；两者文件名含时间戳且中文项目名可正常保存。
10. 修改任一计划 `duration_days` 后，面板偏差徽标与「上次导出后有变化」提示按 §7 出现。
11. `mtask_get_estimates` 返回的汇总值与面板显示一致（大项目响应不被截断，实测 500 行）。
12. 构建门禁（v1.1 命令名对齐仓库实际 scripts）：`npx tsc --noEmit`（web）、`npm run build -w mtask-web`（内含 `tsc --noEmit && vite build`）、`npm run typecheck`（→ server `tsc --noEmit`）全部 0 错；引擎单测通过；隔离实例 API 冒烟全绿；关键交互 CDP 真机复验（非人工抽验）。**本仓无 ESLint，禁止以「lint 通过」作为证据。**
13. 估算面板打开后，在 **1200 / 1440 / 1920** 三档视口宽度下走查：时间线节点不重叠、无横向滚动条、文字不截断（v1.1 依评审 M1，420px 分栏挤压是新引入的布局风险）。
14. **前端汇总 = 模板 H35**（同一批三点值下，两者差 <0.01 人月）；构造含小计行的项目数据后专门复验一次，确认开发段未被双重计入（v1.1 依评审 B2）。
15. 面板「Σ估算比例」读数对应导出文件的 **I40** 值（同数据下两侧一致，偏差 >1% 时告警在 UI 与 Excel 里都能定位到未归阶段的行）。

---

## 11. 交付拆解（已批准：按本表回写「项目计划」并逐条派生实施任务）

| ID | 工作项 | 依赖 | 优先级 | 量级 |
|---|---|---|---|---|
| **E0** | **技术验证 Spike（E6 的放行闸门）**：用 exceljs 产出最小样例文件，验证①单元格**写活公式**；②非 ASCII 命名区域 `每人月工天标准` 写入后公式可解析、改值可重算；③28 处合并区无损；④断言脚本可跑（公式串轨 + 缓存值轨 + Excel 重算轨）。任一不达 → 改方案 | — | **P0** | **S — 已完成（2026-10-11 实测通过，结论见 §11.1；E6 放行）** |
| E1 | 数据模型与迁移（`estimate_items` / `estimate_snapshots`，落 `schema.ts` + `ensureColumn` 范式）+ `EstimateService` CRUD + 校验 + **`addWorkdays(anchor,n)` 工作日正向工具（服务端/前端同语义，单源）** | E0 | P0 | **S — 已完成（2026-10-11，实施单 T02034）**：两张表落 `server/src/db/schema.ts` 建表清单、`EstimateService`（CRUD/PATCH 缺省沿用/批量「任一行失败零写入」/快照 20 条裁剪/脱离计划行）、`server/src/util/workdays.ts` + 前端镜像。验证 `scripts/verify-t02034-estimate-e1.mts` **PASS=84 FAIL=0**（隔离库），`npm run typecheck`（server）与 `npm run build -w mtask-web` 均 0 错。§3.1 的 plan_id 外键记法按实测校正（见该表 v1.5 说明）；REST 路由与 derive 规则归 E3，不属本单 |
| E2 | `estimate-engine.ts`（E/σ/汇总/系数/比例自检，**含「排除小计行」口径**）+ 黄金样例单测 + 「前端 Σ ≈ 模板 H35」断言 | E1 | P0 | **S — 已完成（2026-10-12，实施单 T02036）**：`server/src/services/estimate-engine.ts`（纯计算：`expected`/`sigma`/`confidence`/`buildSummary`/`toEngineRow`/`parseRuleRatio`/`resolveEstimateConfig`/`expectedEndWorkday`，配置键与系数标签同源）。落点由 §9 原写的 web 路径校正到服务端（理由见 §9 可维护行 v1.6 注）。验证 `scripts/verify-t02036-estimate-e2.mts` **PASS=73 FAIL=0**（隔离库）：12341 格标准式↔模板式逐值等价、附录 A 六条 H 列实测值、比例 0.0421/0.0687/0.5001 与 H40≈14.44 黄金回归、**Excel `SUBTOTAL(9,…)` 语义仿真对照轨**（§10-14 差 <1e-9 且反证朴素 sum 会把开发段算两遍）、里程碑/小计/归档三类排除行各归各位。`npm run typecheck`（server）与 `npm run build -w mtask-web` 均 0 错。derive 规则（复杂度/用例/工期）与 REST 路由归 E3，不属本单 |
| E3 | REST 路由 + `derive` 规则（复杂度/用例/工期三档） | E1,E2 | P0 | **M — 已完成（2026-10-12，实施单 T02037）**：`server/src/routes/estimates.ts`（§8 端点清单 + 该节「E3 实测补充」；复用 `planApi` 的 `wrap`/`pid`/静态路径先于 `:id` 约定，`api.use('/estimates', …)` 挂进 `routes/index.ts:2459`）+ `server/src/services/EstimateDerive.ts`（三档规则、0.5 网格、里程碑只出参考值不落库、人工行保护、`coverage` 出数口）。路由层不含任何计算：校验归 `EstimateService`、PERT/汇总/参数归 `estimate-engine.ts`、推导归 `EstimateDerive`。验证 `scripts/verify-t02037-estimate-e3.mts` **PASS=83 FAIL=0**（S 段服务层只读 + R 段隔离实例 REST 全链：derive 默认 dryRun→落库 4 行、Σ 恒等式 22.4166667、里程碑误写估算仍被挡在 Σ 外、批量任一行不合格零写入、PATCH 转 manual、参数非法整批零写入、快照 compare 差异、脱离行显式清理、归档行不进 Σ）；`npm run typecheck -w server` 与 `npm run build -w server` 均 0 错 |
| E4 | 估算面板 UI（**新建 docked 分栏，本仓无 SplitPane 基元** + 汇总卡 + 明细行内录入 + **每行 O~P 区间条（P0，自 E8 移入）** + 空态/错误态 + `TlPlan` 扩 complexity 字段） | E3 | P0 | **L→XL**（v1.1 上调：分栏基元与挤压走查为新增成本）**· 首段已交付（2026-10-12，实施单 T02039）**：`web/src/components/EstimatePanel.tsx`（分组/汇总卡/明细只渲染服务端 `buildSummary` 出数，零前端计算）+ `web/src/api/estimates.ts` + `PlanPage.tsx` 工具条开关与 `<1200px` 覆盖式（`useEstimatePanelMode`，dock 420px sticky / overlay 复用 `SlideOver` 且 `hideHeading`）+ `PlanTimeline.tsx` `TlPlan.complexity?` 可选字段（服务端与计划查询零改动）+ 空态「按规则推导」入口（dryRun 预览→`askConfirm`→落库→toast→REST 复核）+ 会话级持久化 `plan.estimatePanelOpen`。**验证**：`scripts/verify-t02039-estimate-e4a.mts` **PASS=37 FAIL=0**（S 段源码单一来源守卫 + R 段隔离实例真实 REST 喂 `buildPanelRows`，含 Σ 只增不减、里程碑恒在外）；`scripts/verify-t02039-e4-ui.mjs` **PASS=26 FAIL=0**（真机 headless-Chrome/CDP 走查，覆盖 §10-1/2/5/13：1920/1440/1200 三档无横向滚动、节点不重叠、文字不截断，1100 自动转覆盖式且时间线回全宽，刷新/重进页面开合态保持，5 张截图人工过目）。`npx tsc --noEmit`（web）、`npm run build -w mtask-web`、`npm run typecheck`（server）均 0 错。**剩余子段按 v1.8 §5.2「交付分段」口径派生**：行内 O/M/P 录入与错误态（§10-3/4）**已随 T02040 交付（v1.9，见 E5 行）**；每行 O~P 区间条（P0）→ T02041；导出区按钮与脱敏开关随 E6/E7 —— 首段不留空壳按钮 |
| E5 | 批量填充 + 撤销 + 筛选未复核 | E4 | P1 | **M — 已完成（2026-10-12，实施单 T02040）**：`web/src/components/EstimatePanel.tsx` 行内三列录入（`input[type=number] step=0.5`，Enter/失焦即 `PATCH`、Esc 还原、被拒值保留在格子内）+ 批量三模式（①② `mode=derive`+`onlyRule` 过滤、③ `mode=set` 统一值带 `source:'manual'`）+ 会话撤销栈（快照还原 / 无行删除双通道）+ 「只看未复核」筛选 + 底部行内错误条 + §7 脱离行显式清理入口。服务端配套：`EstimateDerive` 新增 `onlyRule` 与 `skip='offRule'`、`/meta` 下发 `deriveRules`/`deriveSkips`。**三条口径裁决见 §5.3「E4 写路径 / E5 落地口径」（v1.9）**。**验证**：`scripts/verify-t02040-estimate-e4b.mts` **PASS=46 FAIL=0**（S 段源码守卫：`toGrid` 19 格与服务端逐格全等、零计算/判据单源/askConfirm/按钮接线；R 段隔离实例 REST 写路径全链：单字段 PATCH 沿用原值、rule→manual、O>M 拒 400 且零写入、批量任一行不合格零写入、`onlyRule` 预览=写入、撤销双通道、`/detach` 列出与清理）；`scripts/verify-t02040-ui.mjs` **PASS=37 FAIL=0**（真机 headless-Chrome/CDP：§10-3 落库与刷新仍在、§10-4 标红+底部逐行点名且库里分毫未动、§10-5 预览行数=写入行数=撤销行数、统一值表单实时预览、1100px 覆盖式无横向滚动，5 张截图）；E4 首段门 `scripts/verify-t02039-estimate-e4a.mts` 回归 **PASS=37 FAIL=0**。`npx tsc --noEmit`（web）、`npm run typecheck`（server）、`npm run build -w mtask-web` 均 0 错 |
| E6 | **Excel 导出逐格复刻模板**（28 处合并区 / R31 小计 / R35·R40 跨 E~I 列公式 / 系数行三点 / 命名区域 / 列宽 / 备注）+ 回读断言 | E0,E2,E3 | P0 | L |
| E7 | PDF 导出（内部/客户版，服务端脱敏） | E6 | P1 | M |
| E8 | 甘特估算区间叠加（面板区间条已移入 E4） | E4 | P1 | M |
| E9 | 变更影响分析（偏差徽标 + 重导提示 + 影响试算） | E4 | P1 | M |
| E10 | MCP 工具三枚 + 大响应不截断实测 | E3 | P1 | S |
| E11 | 帕累托图 + 阶段柱（误差线） | E4 | P1 | M |
| E12 | 历史耗时校准建议（只读提示） | E3 | P2 | M |
| E13 | 参数设置 UI（人月标准/系数/比例/脱敏开关）+ 20 vs 20.83 冲突提示 | E3 | P1 | S |
| **E14** | **龙卷风图（敏感性，v1.1 补：§5.4 已列该图但 v1.0 无对应工作项）** | E4 | P2 | S |
| **E15** | **复杂度补录执行（原 R3 前置）**：直接调既有 `POST /api/plans/complexity/backfill`（`routes/plans.ts:773` + `PlanComplexity.ts`），跑 mtask一期/四期并抽查——**不是新建通道**（v1.1 依评审 B4；对应派生单 T01843）。**v1.4 状态：mtask四期闭环、mtask一期转历史资产不再补录**。判据里的「20 条」是 v1.3 时点的行数——2026-10-11 两次 PRD 重导后四期未归档计划已变 37 条，判据按行数重写为：**四期** `GET /api/plans/complexity/missing?projectId=a9911922…` 返 `count:0` **且** 只读 SQL `未归档行 complexity 非空 = 37/37`（两项 2026-10-11 均实测达成，见 §12-R3）；四期的非空值来自 **PRD 导入路径**（`PlanService.aiParsePrd` 一并给出 complexity），并非 `backfill` 写入，故未产生写前备份属正常——「备份文件必须存在」只对**实际跑 backfill** 的场景生效。**一期**（`1ca54445…`，`missing` 仍 20 条）已进历史资产、无估算视图消费者，补录需业主指定 `toolId` 并消耗 AI 配额，不由本单擅自执行（已建派生单收口该授权决策，见 T01843 结论） | — | P1 | S |

**裁决 D5（2026-10-11 已签）：E0 + E1~E4 + E6 先行**；**E0 是放行闸门：E0 不达不得启动 E6**。E5/E7~E15 按 P1/P2 排后。按本表用 `scripts/prd_to_plan.py` 回写「项目计划」菜单（不建散任务刷屏），并逐条派生实施任务。

### 11.1 E0 Spike 实测结论（2026-10-11，exceljs 4.4.0 + openpyxl 3.1.5 + 本机 Excel COM）

复现物在临时目录 `%TEMP%/t1842-e0/`（会话级取证，不入库）；客户模板原件零改写，取证用其只读副本。

| 判据 | 通道 | 实测结果 | 结论 |
|---|---|---|---|
| ① 单元格写活公式 | exceljs `cell.value={formula,result}` | sheet XML 得 `<c r="H6"><f>…</f><v>12.666666…</v></c>`，模板原式（MIN/MAX/COUNTA/SUBTOTAL/IFERROR）逐字符保真；exceljs 读回 `type=6 / formula / result` 齐全 | **通过**（本仓「零 `.formula` 先例」只是没人用过，不是能力缺口） |
| ② 非 ASCII 常量命名区域 | 原生 `wb.definedNames.add(loc,name)` | 只支持**区域型**（写出 `'估算参数'!$B$1`），常量形态无法表达 | 原生 API **不支持常量** |
| ② 同上 | `Object.defineProperty(wb.definedNames,'model',{get:()=>[{name:'每人月工天标准',ranges:['20.83']}]})` | workbook.xml 得 `<definedName name="每人月工天标准">20.83</definedName>`；Excel `wb.Names` 读到 `每人月工天标准 => =20.83`，引用它的 `E35`/`I6` 重算正确（32/20.83=1.536246） | **通过**（E6 采用此通道，改动仅在写侧，不碰 node_modules） |
| ② 同上 | **读客户模板再填**（exceljs `readFile→writeFile`） | 常量命名区域**被丢弃**：往返件 `defined_names=0`，Excel 打开后 `E35 = #NAME?`（对照组：模板副本 `E35=11.5`） | **不达**——填模板方案必须写完后重新注入命名区域，否则汇总列全废 |
| ③ 28 处合并区 | exceljs 从零 `mergeCells` ×28 | 读回锚点 28，`missing=[] / extra=[]`；往返件亦保 28 | **通过** |
| ④ 断言脚本可跑 | openpyxl 双模式 + Excel COM 重算 | 公式轨 ✅；缓存轨 ✅（`{formula,result}` 写入的 `<v>` 可被 `data_only=True` 读到）；重算轨 ✅（`CalculateFull` 后取值） | **通过**，且见下方五条实现红线 |

**由 Spike 得出的 E6 实现红线（不写进代码就等于没有）**：

1. **公式串必须去掉前导 `=`**：exceljs 原样落进 `<f>`，传 `=SUM(A1:B1)` 会得到 `<f>=SUM(A1:B1)</f>`（openpyxl 回读成 `==SUM(A1:B1)`）。两次独立运行对这种非规范形态的结果**不一致**——一次 Excel 仍算出 3，另一次直接 `#NAME?`。结论：不能赌客户的 Excel/WPS 容错，写侧统一 `formula.replace(/^=/,'')`，并在导出单测里断言 `<f>` 首字符不是 `=`。
2. **缓存值必须与重算一致，且断言要三轨**：E0 里故意让 `E35` 的缓存值取 0.608097，而 Excel 重算得 0.576092——只断言「有缓存值」会放行这类错数（§9 因此改三轨）。导出实现的缓存值只能来自同一个估算引擎的输出，禁止手填。
3. **openpyxl 只能读不能写**：openpyxl `load→save` 会把全部公式格的缓存值清成 `None`（实测 `E35 cached=None`），用它「顺手修一下文件」再断言 = 自造假阴性样本。
4. **填模板 vs 从零构建的取舍已定**：从零构建（逐格复刻）在 exceljs 下四条判据全过，且能自然控制命名区域；「复制客户模板再填充」反而丢常量名。⚠ 与兄弟会话结论的分歧已澄清：「模板往返不丢命名区域」是 openpyxl 的结果，exceljs 会丢——**E6 是 Node/exceljs 通道，以本表为准**。

5. **命名区域的注释要一起注入**：客户模板的 `每人月工天标准` 带原文 `comment`（「去除法定休息日、节假日、年休假、日常基本培训和会议保障后，每人年平均预估约 240 工作日（即每月平均约 20 工作日），每工作日标准工作时间为 8 工时。」，实测自 `xl/workbook.xml`）——这段是 D1 取值 20.83 的**客户侧依据**，导出件若丢掉它，客户复核时就只剩一个孤零零的数。exceljs 的注入通道目前只传 `name/ranges`，`comment` 需在写侧一并补（`DefinedNamesXform.render` 支持 `model` 上的属性透传，实测可达）。

**仍未闭环（转 E6 的验收内，不阻塞放行）**：WPS / Excel 在线预览对 `<f>`+`<v>` 的显示行为无法在本环境实测（机器未装 WPS，无 LibreOffice headless），按 §9 三轨 + §12-R8 由实施者在客户机上抽查一次留痕。数值轨依赖本机 GUI Excel 的 COM 自动化（`CalculateFull` 后取 `Value2`），**不能进 CI**（无头环境不可用、且会拉起隐藏 Excel 进程）→ E6 的自动化断言只跑①②轨，③轨作为发布前人工检查项；兄弟项目 `27_Evaluation/scripts/generate_xlsx.py` 已趟过这条路的坑（超时、按 PID 定向回收、熔断降级），实施时参照其防护而非从零试错。

---

## 12. 风险与开放问题

| # | 风险/问题 | 影响 | 建议处置 |
|---|---|---|---|
| R1 | 客户模板的「人月标准」两处口径不一致（20.83 与 IFPUG 模板 20） | 报价偏差约 4% | **已裁决（D1，2026-10-11）：采 20.83**；系统默认 20.83 且导出可见参数（§3.3），风险转为「参数页误改」→ 改值留痕 |
| R2 | 模板 H 列公式写法非标准（用 MIN/MAX 定位极值） | 若我们只写标准式，客户改列序会得不同结果 | 导出写**模板原式**，面板算标准式，单测断言二者等价（§4.2） |
| R3 | `complexity` 大面积为空 → 上线即「全是默认推导」 | 估算可信度低、用户不买单 | **通道已存在，无需新建**（v1.1 依评审 B4 更正）：直接调 `POST /api/plans/complexity/backfill`（`routes/plans.ts:773`，服务 `PlanComplexity.ts`，UI 入口 `PlanPage.tsx:1549-1562`「复杂度补算」）。根因原文见 `routes/plans.ts:766` 注释：「complexity 只在 PRD 导入时由 AI 给出，手工/Excel 导入与存量行恒为 NULL」→ 落为 §11-E15（跑一次 + 抽查），面板显式标「未复核」。**v1.3 实测现状（2026-10-11 只读复查生产库 `%APPDATA%/mtask/data/mtask.db`）：`plan_tasks` 共 528 行、非空 319（60.4%），值域 1~5 无越界；分布为 aimsg二期 89/101、wiki二期 42/42、compare二期 31/31、aimsg三期 29/29、mtask二期 24/24、swork 20/20、bemp 20/20、xianyu二期 19/19、compare三期 17/17，**而 mtask一期 0/20、mtask四期 0/20、aimsg一期 0/40、ev二期 0/36、test 0/30 仍全空**。⚠ 有一路后台执行报告声称已把 mtask一期/四期 40 条补齐（非空率 100%），本次独立复查**在生产库中看不到该结果**（连其自述的 `%TEMP%/mtask-db-backup-*` 备份文件也不存在），故 E15 按「未闭环」处理，不采信该回报；跑完后必须以 `GET /api/plans/complexity/missing` + SQL 只读双验证再收口（见 §11-E15 验收）。
**v1.4 复查（同日深夜，T01843）**：该风险对 mtask四期 已消除——未归档 37 行 complexity 37/37 非空、值域 1~5 无越界、分布 `{1:2, 2:9, 3:13, 4:8, 5:5}`，`GET /api/plans/complexity/missing?projectId=a9911922…` 返 `count:0`，只读 SQL 与端点**双验证一致**。数据来源是 2026-10-11 的两次 PRD 重导（AI 在导入时一并给值），不是补算通道写入：`POST /api/plans/complexity/backfill` 在**未带 force** 的情况下对四期实测返 `{"scanned":0,"updated":0,"batches":[]}`，既证明通道可用，也证明「无缺口可补」这一结论并非靠绕开 AI 手填造数。mtask一期 20 行仍全 NULL，但项目已进历史资产 → 是否补录交业主决策（§11-E15）。剩余真实缺口转移到**里程碑语义**：里程碑行也带 complexity，规则 1 若全表逐行推导会双计，已在 §4.6 记为 E3 必守口径。 |
| R4 | pdfkit 中文字体依赖系统字体（已知限制） | 非 Windows 环境 PDF 中文方框 | 实测 `prdExport.ts:13` 硬编码 `C:/Windows/Fonts/simhei.ttf`，且仅 `process.platform==='win32' && existsSync` 才加载（`:147`）→ PDF 定位为预览，正式交付走 Excel（§6.2） |
| R5 | 客户版脱敏若只做在前端 = 泄密 | 商务风险 | 服务端分支过滤 + 代码审查断言（§9 安全） |
| R6 | 面板与甘特/时间线三处共享折叠与视图会话态，易相互污染 | 交互回归 | 键名分区（`plan.estimatePanelOpen` 独立），CDP 复验含「列表↔甘特↔时间线」切换回归（延续 T01621 单源判定教训） |
| R7 | Excel 回读断言依赖 exceljs 能力边界（合并区/命名区域读取） | 自测假阳性/假阴性 | **已由 E0 Spike 关闭（v1.3 实测）**：合并区读回无损；exceljs **能**写缓存值（`{formula,result}`），故「必回 None」的判断作废；真正的坑换成了三条——①公式串带前导 `=` 会写成非规范形态；②只有缓存值不等于算得对（E0 用故意写错的缓存值验证过：缓存轨过、重算轨抓到偏差）；③**openpyxl `load→save` 会把缓存值清空**，严禁用它做断言中间产物。断言口径据此改为 §9「三轨」，命名区域读取走 workbook.xml/openpyxl 只读而非 exceljs（exceljs 读回命名区域为空） |
| **R8** | **某些查看器对无缓存值公式显示空白**：客户用 WPS 快速预览/在线预览/只读预览打开导出件时，H/I/R35/R40 可能显示为空而非数值 | 客户误判「文件是空的」，商务观感受损 | **缓解方案已定（v1.3，依 E0）**：导出时**同时写 `<f>` 与 `<v>`**（缓存值由估算引擎产出，§11.1 红线 2）——预览类查看器读缓存值即可显示数字，无需 LibreOffice headless 重算（本机也确实没有 LibreOffice）。残余：WPS/在线预览的真实显示行为本机无法实测（未装 WPS），转 E6 验收由实施者在客户机抽查一次留痕 |

---

## 附录 A：参考模板逐格解析（`阜新银行-票据系统优化-工作量评估V2.0.xlsx`）

- **实测方式**：openpyxl 双模式加载（`data_only=False` 读公式 / `True` 读缓存值），只读、未修改原文件；本节数字为 v1.1 二次独立复核结果。
- **规模**：单 sheet `项目工作量估算表`，`dims=B1:I196`（`max_row=196`），**28 个合并区**（v1.0 误记 20），1 个命名区域。
- **列义**：B 产品/子系统/大模块 · C 中模块 · D 小模块/功能单元/业务单元 · E 最可能 · F 最小 · G 最大 · H 最终估算值（公式）· I 估算比例（公式）。
- **合并区全量清单**：`B1:I1` 标题、`H2:I2` 估算人值、`B3:C3`+`D3:I3` 项目名、`B4:D4`/`E4:H4` 表头组、**`I4:I5`（「估算比例」跨表头两行）**、`B5:C5`、阶段行 `B6:D6`/`B7:D7`/`B32:D32`/`B33:D33`/`B34:D34`、开发段 `B8:B31`、**`I8:I31`（开发段比例单格合并）**、中模块 `C8:C11`/`C12:C15`/`C16:C18`/`C22:C23`/`C25:C26`/`C27:C28`、汇总与系数行 `B35:D35`~`B40:D40`、`B42:I42` 备注。
- **公式口径**：
  - 明细/阶段行 H 列 `=(MIN(X:Y:Z)+MAX+4*中值)/6`（全表同构，R6~R34 与**系数行 R36~R39 均如此**）；
  - I 列明细/阶段行 `=IFERROR(H{r}/每人月工天标准/$H$40,"")`；**`I8` 例外**——引用 `H31`（开发段小计），配合 `I8:I31` 合并表达「开发段整体比例」；系数行 `=IFERROR($H$35*H{r}/$H$40,"")`；
  - **R31「小计：」行**：`E31..H31 = SUBTOTAL(9,X8:X30)`（只对开发段做段内小计）；
  - **R35**：`E35..H35` 各 = `SUBTOTAL(9,X6:X34)/每人月工天标准`，`I35 = SUBTOTAL(9,I6:I34)`；
  - **R40**：`E40..H40` 各 = `X35*(1+SUM(X36:X39))`，`I40 = SUBTOTAL(9,I35:I39)` ← 备注第 3 条要人工核对的「I 列比例之和」正是 **I40**；
  - ⚠ `SUBTOTAL(9,E6:E34)` 的区间**含 R31 的 SUBTOTAL**，靠 Excel「忽略嵌套 SUBTOTAL」语义不重复计——前端自算必须显式排除小计行（§4.4）。
- **命名区域**：`每人月工天标准 => 20.83`（全表唯一命名区域，**常量形态而非单元格引用**）。⚠ 其原文 `comment`：「去除法定休息日、节假日、年休假、日常基本培训和会议保障后，每人年平均预估约 240 工作日（即每月平均约 20 工作日），每工作日标准工作时间为 8 工时。」——注意客户自己的说明文字写「每月约 20 工作日」而取值却是 20.83（= 250/12 口径），这正是 §3.3-D1 冲突的根源；导出件要连注释一起写（§11.1 红线 5），让客户复核时看得到依据。
- **列宽**：A 2.0 / B 6.5 / C 15.625 / D 63.125 / E 8.25 / F 8.375 / G 8.125 / H 6.5 / I 5.5。
- **实测样例**（H 列缓存值）：需求分析 12/12/16 → 12.667；系统设计 20/20/24 → 20.667；开发首行 6/6/7 → 6.167；实施 30/30/35；公共&远程 20/20/20；现场维护 10/10/10；比例示例 0.0421 / 0.0687 / 0.5001。
- **备注三条原文要点**：① 仅适用项目型工作量评估，不含产品/研发分摊；② 本表宜作内部依据，直接提交客户应考虑屏蔽调节系数并删除本备注，引导从成本定价转向价值定价；③ 估算完成后检查 I 列各阶段比例之和（= I40）。

## 附录 B：IFPUG 功能点法对照（同目录 `1.IFPUG国际标准功能点估算法计算-票据标识功能升级项目.xlsx`）

- 7 个 sheet：计算说明 / 功能点估算法-计算表 / 输入表1-功能点 / 输入表2-系统特征因子 / 软件需求功能列表 / 影响因子说明表 / 公式应用数据表。
- 口径链：`ILF(7/10/15) + EIF(5/7/10) + EI(3/4/6) + EO(4/5/7) + EQ(3/4/6)`（按低/中/高复杂度乘数）→ 未调整功能点 → `× VAF`，其中 `VAF = TDI×0.01 + 0.65`（14 个系统特征因子，每项 0~5 分）→ 工作量（人天口径）→ `÷ 生产效率(模板 M2=20)` → 人月。
- 与 PERT 的关系：**功能点法解决「规模从哪来」，PERT 解决「不确定度怎么表达」**。本 PRD 主线是 PERT（对齐客户报价模板），功能点法列为 P2 对照视图（`输入表1-功能点` 的 RET/DET/FTR 计数可作为 §4.6 规则 2 的替代规模源）。

## 附录 C：前期文档索引与数据基线

| 资产 | 位置 | 本 PRD 用途 |
|---|---|---|
| 项目计划模块 PRD | `docs/PRD-项目计划.md`（T00431） | 数据模型/导入导出/联动口径基线（§3、§6） |
| 系统需求规格 | `docs/需求规格说明书.md`、`docs/需求规格说明书_MTask优化升级_2026-09-26.md` | 术语与菜单结构一致性（§1.4） |
| 测试用例管理 PRD | `docs/PRD-测试用例管理.md`（mtask四期已导入为 PRD 文档，34,290 字符） | 用例规模源与 P 档权重（§4.6 规则 2） |
| 竞品调研历史 | `docs/PRD-竞品调研与优化需求.md`、`docs/竞品调研与优化需求梳理_2026-09-26.md`、`docs/同类产品分析报告.md` | §2 调研风格与结论衔接 |
| 数据基线（2026-10-11 只读实测） | `plan_tasks` 全库 528 行；mtask四期 20（4 milestone：28d，16 normal：均 1.75d）；`test_cases` 全库 138（swork 71：P0 9/P1 31/P2 25/P3 6）；`prd_requirements` mtask四期 12 / mtask一期 34 / swork 20；`tasks` 全库 1580 | §1.1 约束论证、§4.6 冷启动必要性 |

## 附录 D：调研引用清单

- 仓库元数据（stars / license / language / pushed_at）：GitHub REST API `GET /search/repositories`、`GET /repos/{owner}/{repo}`，2026-10-11 实测取值（见 §2.1 表格）。
- [bardsoftware/ganttproject](https://github.com/bardsoftware/ganttproject) — PERT 图模块 `org.ganttproject.chart.pert`、资源负载、成本、PDF/HTML/PNG 导出。
- [opf/openproject](https://github.com/opf/openproject) — 预计/剩余工时、时间条目、成本报告（人员/任务/趋势三维）、预算与应急储备。
- [makeplane/plane](https://github.com/makeplane/plane) — Estimate Set（多档故事点刻度）、列表行内改点、Module/Cycle 聚合。
- [taskjuggler/TaskJuggler](https://github.com/taskjuggler/TaskJuggler) — 报表模板语言（导出列与数据解耦）。
- [linuxswords/pert-estimation](https://github.com/linuxswords/pert-estimation)、[dlmueller/PERT-Beta-Python](https://github.com/dlmueller/PERT-Beta-Python) — `E=(O+4M+P)/6`、`σ=(P−O)/6` 与 Beta 分布置信区间的算法对照基准。
- 内部依赖：`exceljs`（MIT，已在 `server/package.json`）、`docx`、`pdfkit`（`server/src/services/prdExport.ts` 现有用法与中文限制注释）。
- **同机兄弟项目先例**（v1.3 新增，实测存在，非虚构）：`D:\code\otherProjects\27_Evaluation` 已有一条独立的工作量评估生成链，可作 E6/E0 数值轨的工程参照——
  - `scripts/pert.py:72` 以 `days_per_man_month: 20.83` 为默认值并注明「每人月工天标准（名称管理器宏变量）」→ **D1 取 20.83 的第二处内部先例**（与客户模板命名区域一致）；
  - `scripts/generate_xlsx.py` 用 `win32com.client.DispatchEx("Excel.Application")` 驱动 Excel 重算后 `SaveAs` 临时副本再原子替换，并配套超时、按 PID 定向回收隐藏实例、熔断降级（T00960/T01481 条目）→ E6 若需要「落缓存值」，照此防护，别裸调 COM；
  - 该链用 openpyxl 填客户模板（`ws.unmerge_cells` / `merge_cells` 插行扩列）——**注意其通道是 Python，常量命名区域可保**；本 PRD 的实现通道是 Node/exceljs，往返会丢该名称（§11.1 判据②），不可直接照搬其结论。

---

> **裁决结果（审批人已签字，2026-10-11）**：AI 初审与二次取证见 `docs/PRD评审报告-估算视图与工作量评估导出.md`（T01842），事实类缺陷 B1~B6 与 M1~M15 已在 v1.1 就地修订；6 项决策**全部按评审建议值通过**，本文档状态转为「已批准」，§11 自 E0 放行闸门起启动：
>
> | # | 决策项 | 评审建议 | 裁决（签字值） |
> |---|---|---|---|
> | D1 | §3.3 人月标准 **20.83 vs 20**（R1） | 采 20.83（客户模板命名区域即报价口径权威），参数页可改并写进导出参数 sheet | **通过：20.83**，导出时写进参数 sheet 供客户复核，改值须显式操作 |
> | D2 | §4.3 对外报 **P50 / P84 / P85** | 对外 P84（=E+1σ 精确），内部同时看 P50 | **通过：对外 P84**，面板与导出同口径 |
> | D3 | §5.1 **面板 vs 第四视图** | 面板（回归面最小），E4 量级因「无分栏基元」上调至 XL 需一并认可 | **通过：右侧分栏面板**，E4 量级 **XL** 一并认可 |
> | D4 | §6.2 **PDF 仅作预览、Excel 为正式交付** | 接受（`prdExport.ts:13` 硬编码系统字体，PDF 中文不可承诺） | **通过：PDF 仅预览**，不为 PDF 中文版式追加字体依赖 |
> | D5 | §11 **E0 + E1~E4 + E6 先行** | 通过；E0 不达不得启动 E6 | **通过：E0 先行**（Spike 结论回填 §11/R7~R8 后放行 E6） |
> | D6 | §1.3 **非目标「不含金额/费率」与「反向导入」** | 金额/费率需商务确认；反向导入建议保持非目标 | **通过：两者均保持本期非目标**。金额列若商务侧确认需要，另立需求（不阻塞本期）；反向导入列为 P2，扩列前不得改动 `/api/plans/import` 既有 6 列校验 |
>
> 落地位置（v1.2）：§1.3 两行、§3.3、§4.3、§4.5、§5.1、§6.2、§11 表尾与 E0 段、§12-R1 关闭、本表。
