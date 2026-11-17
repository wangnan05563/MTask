# PRD：AI 控制台「项目启动会 PPT 生成」（MTask）

> 来源任务：T01844 ｜ 版本：**v1.1（已批准）** ｜ 日期：2026-10-12 ｜ 状态：**已批准，等待实施**（本文件只定义需求与设计，不含实现）
> 影响项目：mtask四期（工作空间 `D:\code\otherProjects\26_MTask`）
> 关联既有 PRD：`docs/PRD-估算视图与工作量评估导出.md`（T01839/T01842，v2.5，**已实现**）、`docs/PRD-项目计划.md`（T00431，已实现）、`docs/PRD-测试用例管理.md`（已实现）
> 质量参照技能：`D:\code\Data_Trae\.trae-cn\skills\pptx-skill-for-trae`（本机已存在，见 §6.4 的可用性实测）
> 取证方式：全文每条技术断言均锚到本仓 `路径:行号`；「不存在」的结论标注 grep 关键字与范围（§1.3）

---

## 0. 审批记录（v1.0 → v1.1）

**审批人**：业主代表（通过 T02073 任务授权）  
**审批日期**：2026-10-12  
**审批结论**：批准立项，按建议值签署 A-1~A-4 裁决（其中 A-4 因估算引擎已落地而调整），修订后版本号 v1.1。

### A-1.1 E-1 落地记录（T02156，2026-10-14）

N1 的搁置根因是「读模板母版需要 Python 运行时」。T02156 用户硬要求遵循 `2023恒生PPT模板.pptx` 品牌规范后，E-1 以**不引 Python、不加依赖**的方式落地：pptxgenjs 原生 `defineSlideMaster({ background })` 把恒生三张版式背景（封面/目录/内容，提取为 1280×720 副本进 `server/src/services/assets/kickoff/`）登记为自定义版式，品牌四色（08409C/0059E9/C9DCF6/FFFFFF）进 `exportStyle.ts` 单源；图表字体/颜色、表头深蓝白字、时间线品牌色同步整改。**N1 裁决本身不变**（仍不做「读任意模板母版并填充」），落地的是「内置版式的品牌化」，判据与验收见 `docs/T02156-启动会PPT品牌优化策略.md` 与 `scripts/verify-t02156-kickoff-brand.mts`（26 断言全绿）。

### A-1 非目标确认（N1~N4 维持不变）

| 编号 | 原 PRD 建议 | 签字值 | 理由 |
|---|---|---|---|
| N1 | 不做 .pptx 母版/模板文件套用 | **同意** | 装机版不含 Python 运行时，无法调用 python-pptx/pptx-automizer；内置 3 套版式足够 Kickoff 场景 |
| N2 | 不做 PPT 在线预览编辑器 | **同意** | 本仓无 canvas 幻灯片编辑器，产物交给 PowerPoint/WPS 编辑 |
| N3 | 不做 AI 生成插图/文生图 | **同意** | AIService 仅支持文本 chat，无 vision/base64 输入能力 |
| N4 | 不做依赖 E 系列的 PERT 三点估算取数 | **调整为部分同意** | 估算引擎已实现（v2.5 已上线），但 Kickoff PPT 仍不引入复杂 PERT 计算，保持"工作量页优先取 estimate_items 汇总，缺失时降级 duration_days"的混合口径（见 A-4） |

### A-2 下载端点决策

**建议值**：复用 `/api/report/ai-download` 白名单（已含 pptx，零改动）  
**签字值**：**同意**  
**理由**：文件名正则 `^[\w\-.()·\u4e00-\u9fa5 ]+\.(xlsx|docx|pdf|pptx)$` 已覆盖 pptx（routes/index.ts:1680），无需新增端点。

### A-3 日志表决策

**建议值**：本期不建 `kickoff_ppt_logs` 表，日志仅进控制台流  
**签字值**：**同意**  
**理由**：简化首期实现，后续如需追溯可通过 SSE 事件留痕或手动补建。

### A-4 工作量页口径决策（关键变更）

**原 PRD 建议**：E 系列未实现 → 工作量页只走 `Σ duration_days`（工作日）+ `complexity` 分布，页脚常驻"工期口径，非三点估算"  
**修正后签字值**：**优先取 estimate_items 汇总，缺失时降级 duration_days**  
**理由**：估算视图已于 v2.5 上线（grep `estimate_items|/api/estimates` 命中 9 文件，estimates.ts/EstimateService.ts/estimate-engine.ts 等均已落地），Kickoff PPT 应优先读取估算引擎的实际输出（人天/人月、PERT 三点、复杂度分布），仅在项目未配置估算数据时降级为 `plan_tasks.duration_days` 汇总。页脚标记改为"工作量来源：估算引擎 / 工期推导（降级）"动态显示。

### v1.1 主要修订清单

1. **§1.2 现状表第 28 行修正**："估算视图未实现" → "估算视图已实现（v2.5，9 文件命中）"，约束从"禁止依赖 estimate_items"改为"优先取 estimate_items，缺失时降级 duration_days"。
2. **§1.4 非目标 N4 修正**：从"不做依赖 E 系列的 PERT 三点估算取数"改为"不做复杂 PERT 计算链路，但工作量页优先读取估算引擎汇总结果"。
3. **FR-4.6 工作量评估章节修正**：数据来源增加 `estimate_items` 表及 `/api/estimates/summary` 端点，取数逻辑改为"有估算用估算，无估算用工期"。
4. **关联 PRD 版本更新**：从"v1.4，尚未实现"改为"v2.5，已实现"。

---

## 1. 项目概述与目标

### 1.1 一句话

在 AI 控制台（能力卡片页）新增一张 **「项目启动会 PPT 生成」** 卡片：读项目管理模块已沉淀的资料（PRD 文档、需求跟踪矩阵、项目计划、测试用例、工作空间分析），由 AI 组织成一份**可继续编辑的原生 .pptx** 项目启动会（Kickoff）材料，一次点击得到 12~18 页、含甘特/时间线、工作量、风险、沟通管理的成品。

### 1.2 现状与证据（本次实测，全部只读）

| 事实 | 实测证据 | 对本功能的约束 |
|---|---|---|
| 「AI 控制台」的卡片页不是 `AIToolsPage.tsx`（那是模型配置表格页），而是 **`ReportPage.tsx`** | `web/src/pages/ReportPage.tsx:68 interface ReportCardCfg`、`:404 const reportCards: ReportCardCfg[]`、`:691 {reportCards.map(...)}`；卡片组件 `ReportCard` 在 `:85-112` | 新卡片必须进 `reportCards` 数组（`:404`）与其面板开关（`:367-378 panelSetters/panelOpen`），复用 `ReportCard` 的 DOM/样式，**不得新造卡片组件**（一致性约束） |
| 现存 6 张卡：AI 项目计划导入 / 离线周报生成 / AI 周报生成 / 原始需求生成 PRD / 从 PRD 导入项目计划 / 从 PRD 生成测试用例 | `ReportPage.tsx:404-441` | 新卡片是第 7 张；卡片底部 hint 文案风格、运行中 `glow` 光晕（`:112`、`:704`）需对齐 |
| **本仓已具备 pptx 生成能力，无需新增依赖** | `server/package.json:23 "pptxgenjs": "^4.0.1"`；实现先例 `server/src/services/report-builder.ts:220 buildPptx()`（`:221 await import('pptxgenjs')`）、worker 池调度 `report-worker.ts:9/21`、`ReportService.ts:227-243`；四格式导出端点 `routes/index.ts:1446` | 主路径沿用 pptxgenjs + worker 池，不引入 reveal.js/Slidev/Marp 渲染链（理由见 §5.4）；**新增的是「启动会内容装配器」，不是新的 PPT 引擎** |
| 长耗时 AI 生成的既有范式是 **SSE 流**，不是队列 | `POST /api/plans/prd-generate-stream`（`routes/index.ts:1491-1545`，事件 `stage/chunk/done/error`，客户端断开即 abort `:1527`）、`/plans/testcase-generate-stream`（`:1550`）、`/report/ai-generate-stream`（`:1629`）；前端消费 `web/src/api/sse.ts`、`reportStream.ts`。全局变更流 `GET /api/events`（`server/src/index.ts:128-142`） | 新端点必须走 `*-stream` 形态（`POST /api/plans/kickoff-ppt-stream`），复用 `sse.ts` 客户端；**不用** `queues/queue_jobs`（那是外部 Agent 待办批量通道，`QueueService.ts:137/267/297`，5s 轮询 `server/src/index.ts:206-211`） |
| 产物落盘与下载链路齐备 | 无 `/api/download`；范式=服务端 Buffer + `Content-Disposition`，前端 `web/src/utils/download.ts:18 saveBinary / :42 saveBlob`；AI 周报走**临时文件 + 令牌换文件**：`POST /api/report/ai-download`（`routes/index.ts:1669`，文件名白名单正则**已含 pptx** `:1673`），前端 `ReportPage.tsx:590 api.download` | 直接复用 ai-download 白名单（已含 pptx，零改动）或同构新增 `kickoff-ppt-download`；**不**使用 `shell.openPath`/`showSaveDialog`（全仓不存在，grep 见 §1.3） |
| 项目管理侧数据源端点齐备 | PRD 文档表 `prd_docs`（`server/src/db/schema.ts:272`）+ `GET/POST /api/plans/prd-docs[/:id]`（`routes/plans.ts:205-260`）；RTM `GET /api/plans/prd-requirements`（`plans.ts:328`）；测试用例 `GET /api/plans/test-cases`、`/coverage`、`/stats`（`plans.ts:448-477`，表 `test_cases` `schema.ts:376`）；计划 `GET /api/plans`（`plans.ts:50-205`） | 前置校验（FR-2）按这些端点的**返回条数**判定，不新建聚合端点 |
| 工作空间分析能力可用 | `projects.workspace_path`（`schema.ts:501`）读取方 `routes/index.ts:185-204`、`WorkspaceService.ts:185-191`、`AIService.ts:106/464/490`、`PrdGenService.ts:194`、`TestCaseGenService.ts:149`；端点 `GET /api/workspace/search`、`GET /api/workspace/file`、`POST /api/workspace/symbols/refresh`（`routes/index.ts:250-287`） | 技术章节（架构/规模）素材来自 symbols/search，**但无「代码度量统计」能力**（行数/模块数无现成端点）→ 附录页只写已得事实，不臆造指标 |
| **估算视图已实现**（工作量评估章节的关键前提，v1.1 修正） | grep `estimate_items\|/api/estimates` 命中 9 文件：`server/src/routes/estimates.ts`、`EstimateService.ts`、`estimate-engine.ts`、`EstimateDerive.ts`、`estimateExportXlsx.ts` 等；端点 `/api/estimates/summary` 返回人天/人月汇总与 PERT 三点 | 「工作量评估」页应**优先取 estimate_items 汇总**（人天/人月、复杂度分布、PERT 三点），仅在项目未配置估算数据时**降级**为 `plan_tasks.duration_days` 汇总（工作日）+ `complexity` 分布；页脚标记动态显示"工作量来源：估算引擎 / 工期推导（降级）"——见 FR-4.6 修订 |
| **无「团队/角色」实体** | `server/src/db/schema.ts` grep `member\|team` 无命中；仅 `plan_tasks.assignee TEXT DEFAULT ''`（`:194`）；`tasks` 表无 assignee | 「项目团队介绍」章节（FR-4.1）**只能是**：① 从 `plan_tasks.assignee` 去重出参与人 + 其承担计划数；② 卡片面板允许用户临时补录角色表（内存态，不落库）。缺失时在预览态以「待补充」占位，不得由 AI 编造人名 |
| AI 调用只支持文本 chat，**无图片/vision 输入** | `server/src/services/AIService.ts:154` 导出 `organize:159 / ask:304 / askJson:328（解析失败重试 1 次、temperature=0）/ askStream:379(onDelta)`；适配器 `adapters/types.ts:78-100` 仅 chat/chatStream（openaiCompat/claude/ollama）；grep `image\|vision\|base64` 于 `server/src/adapters/` 零命中 | 幻灯片配图只能走：pptxgenjs 原生形状/图表（本地绘制）或工作空间已有图片文件；**不得**承诺「AI 生成插图」 |
| PRD 上下文注入有既成上限 | `server/src/util/prdContext.ts:25 PRD_CONTEXT_LIMIT=6000`（保头保尾截断 `:75-86`，`resolvePrdContext`），注入点 `AIService.ts:108` | 启动会内容装配沿用同一截断口径与提示词分层，不新造上下文机制 |

### 1.3「不存在」的取证口径（供复核）

- grep 范围：`server/src`、`web/src`、`electron/`，排除 `node_modules`、`docs`、`perf`。
- `estimate_items|/api/estimates` → 0 命中（代码）；`prd_documents`（用户描述里的表名）→ 0 命中，实际表名为 **`prd_docs`**（`schema.ts:272`）；`openPath|showSaveDialog` → 0 命中（仅 `dialog:open-directory` IPC，`electron/main.js:440`）；`child_process` spawn 仅 4 处且均与 Python 无关（`electron/main.js:113/122` 拉起 server、`:525` 安装器 `/S`、`server/src/tunnel/tunnel-service.ts:124` funnel 二进制）；`python` 于三工作区代码 → 仅注释命中（`report-builder.ts:261`「Node 端以 pdfkit 实现等价输出」）。

### 1.4 目标 / 非目标

**目标**
- G1：一张卡片、一条 SSE 链路产出**原生可编辑** .pptx（文本框/表格/图表是 PowerPoint 对象，不是整页截图）。
- G2：资料不齐时**不静默出劣稿**——前置校验点名缺什么、怎么补，并给出「降级继续」与「中止去补」两条路。
- G3：内容装配**大纲先行**（outline-first）：AI 先出大纲 → 用户改 → 再逐页生成，避免整稿返工。
- G4：版式质量**由代码保证而非事后 QA**（技能路径的 Layout Safety 纪律移植到 Node，见 §6.3）。

**非目标（本期明确不做，需审批确认）**
- N1：**不做** .pptx 母版/模板文件套用（读现有公司模板 pptx 需 python-pptx 或 pptx-automizer 子进程；本仓无 Python 运行时先例，装机版不含 Python，见 §6.4 实测）→ 只做「内置 3 套版式」。
- N2：**不做** PPT 在线预览编辑器（本仓无 canvas 幻灯片编辑器；参照 PPTist 属独立项目量级）。产物交给 PowerPoint/WPS 编辑。
- N3：**不做** AI 生成插图/文生图。
- N4：**不做** 依赖 E 系列的 PERT 三点估算取数（E 系列未实现）；工作量页走降级口径，估算功能上线后再切。
- N5：**不新增依赖**（pptxgenjs 已在位）、不新增数据库表（除 §3.4 的 1 张可选留档表，由审批决定是否本期做）。

### 1.5 术语表（与现系统对齐，禁止另造词）

| 术语 | 定义 | 系统对应 |
|---|---|---|
| AI 控制台 | 能力卡片页 | `web/src/pages/ReportPage.tsx`（`reportCards:404`） |
| 能力卡片 | 一个可点击的 AI 工作入口 | `ReportCard`（`ReportPage.tsx:85-112`） |
| 需求跟踪矩阵 | 需求 ↔ 计划 ↔ 待办 ↔ 用例的矩阵 | `prd_requirements` + `/api/plans/prd-requirements`（`plans.ts:328`） |
| 项目计划 | 计划条目时间线（串行瀑布） | `plan_tasks`（`kind=milestone\|normal`、`duration_days`、`complexity`） |
| 工作量评估 | 客户模板口径的人天/人月表 | **优先取 estimate_items 汇总，缺失时降级 duration_days**（§3.3 D6，v1.1 修正） |
| 大纲先行 | 先生成议程大纲供确认，再逐页装配 | `stage` 事件 `outline_ready`（§4.2） |
| 版式（Layout） | 页面元素坐标方案 | pptxgenjs `SLIDE_LAYOUT` + 本项目 `kickoffLayouts`（§6.3） |
| 前置校验 | 生成前的资料齐备性检查 | `GET /api/plans/kickoff-preflight`（§4.1） |

---

## 2. 用户角色与场景

| 角色 | 场景 | 痛点（现状） | 使用路径 |
|---|---|---|---|
| **项目负责方（乙方 PM，主要用户）** | 投标/立项后开启动会，需要一份对客户的介绍材料 | 资料都在 MTask 里（PRD、RTM、计划、用例），但要手工誊到 PPT，2~4 小时且每次口径不一 | 卡片 → 选项目 → 前置校验 → 改大纲 → 生成 → 下载 pptx → PowerPoint 润色 |
| 交付/实施同事 | 接手客户沟通，需要「项目范围 + 计划 + 风险」一页看懂 | 甘特/时间线只能截图，不可编辑、字号失真 | FR-4.5 用 pptxgenjs 原生形状画时间线（可编辑），RTM 用原生表格（FR-4.3） |
| 客户方项目负责人 | 会上逐页质询「范围为什么这样切、工期依据是什么」 | 手工 PPT 无溯源，答不上 | FR-4.3 每页脚注带 `req_no`/计划标题；附录页列资料清单与更新时间（可回溯到系统内视图） |
| 开发/评审者（内部） | 复核 AI 产出是否编造 | LLM 直出整稿难定位 | G3 大纲先行 + §4.2 逐页 stage 事件在控制台留痕（复用 `ReportConsole.tsx:69-78` tab 注册范式） |

**核心场景（Happy path）**：mtask四期 已有 50 条需求矩阵、37 条未归档计划、若干用例与 2 份 PRD 文档 → 打开卡片 → 校验 6/6 通过（工作量页显示降级标记）→ 大纲确认（删掉「团队介绍」，因无 assignee 数据）→ 生成 14 页 → 下载 `项目启动会-mtask四期-20261011.pptx`。

**反例场景（必须友好处理）**：全新项目零资料 → 校验报「PRD 文档 0 / 需求矩阵 0 / 计划 0」并逐项给补充入口深链（跳「项目管理 · PRD 管理」等菜单），且**不允许**用户在此状态下发起生成（FR-2.4）。

---

## 3. 功能需求详解

### 3.1 FR-1 新增能力卡片

| 编号 | 需求 | 落点（改动点） |
|---|---|---|
| FR-1.1 | 在 `reportCards` 数组追加一项：`{ key:'kickoff-ppt', title:'项目启动会 PPT 生成', desc:'按项目资料自动装配 Kickoff 材料（原生可编辑 .pptx）', hint:'需 PRD/需求矩阵/计划至少各 1 条' }` | `web/src/pages/ReportPage.tsx:404`（数组尾部插入，保持既有 6 项顺序与文案长度风格） |
| FR-1.2 | 卡片渲染复用 `ReportCard`（图标 + 标题 + 描述 + 底部 hint + 运行中 `glow`），色值只走 CSS 变量 `var(--border)/var(--card-bg)` | `ReportPage.tsx:85-112`、`:691`；**禁止**硬编码新色值（延续本仓 UI 风格守卫：`docs` 内既有约定、T00735 类问题） |
| FR-1.3 | 面板互斥开关加 `kickoff-ppt` key（打开本面板关闭其他） | `ReportPage.tsx:367-378 panelSetters/panelOpen`、`:758+` 展开区挂载新工作面板 `KickoffPptPanel` |
| FR-1.4 | 控制台过程留痕：新增 tab（id 常量集中在 `ReportConsole.tsx:69-78`），逐页生成过程按 SSE `stage` 事件写入 | `web/src/pages/ReportConsole.tsx:69-78`；渲染复用现有 tab 内容组件，不新造容器 |
| FR-1.5 | 项目未选/`workspace_path` 为空时的卡片态：面板显示「先在项目管理选择项目」，按钮 disabled（不用原生 `alert/confirm`——Electron 不可靠，仓内既有口径 T01607/T01699） | `KickoffPptPanel` 内；确认走 `web/src/ui/dialogs.tsx` |

### 3.2 FR-2 前置校验机制（资料齐备性）

**FR-2.1 校验项与取数（只读，一次 `GET /api/plans/kickoff-preflight?projectId=` 聚合返回，服务端直接复用现有 Service 查询，不改各端点语义）**

| 校验项 | 数据源（真实端点/表） | 判定 | 缺失时提示文案要点 |
|---|---|---|---|
| P1 PRD 文档 | `prd_docs`（`schema.ts:272`）via `/api/plans/prd-docs` | `count ≥ 1` | 「PRD 管理」菜单导入原文（给深链） |
| P2 需求矩阵 | `prd_requirements` via `/api/plans/prd-requirements`（`plans.ts:328`） | `count ≥ 3`（<3 视为未梳理） | 「从 PRD 生成需求矩阵」即用卡片 4；编号规则见 T01867/T01921（同项目内 req_no 唯一、撞号顺延） |
| P3 项目计划 | `plan_tasks`（未归档）via `/api/plans` | `count ≥ 3`，且 `start_date` 非空率 ≥ 60% | 「从 PRD 导入项目计划」（卡片 5）；无起始日则时间线页无法绘制 → 直接点名有几条缺日期 |
| P4 里程碑 | `plan_tasks.kind='milestone'` | `count ≥ 1` | 缺里程碑时时间线降级为「按日期排序的计划列表」 |
| P5 测试用例 | `test_cases` via `/api/plans/test-cases`（`plans.ts:448`） | 可选；`count` 仅用于覆盖率页文案 | 缺则覆盖率页写「本期未建用例，测试策略按 PRD 验收标准描述」 |
| P6 复杂度/工期 | `plan_tasks.complexity`、`duration_days` | 非空率 ≥ 80% | 工作量评估页取数依据；不足则标注「工期由排期推导，建议复核」（与估算 PRD §4.6 规则 3 同口径） |
| P7 工作空间 | `projects.workspace_path` + `/api/workspace/search` | 可选 | 技术章节素材；为空则该页只写计划口径 |

**FR-2.2 呈现**：面板内 checklist（逐项 ✓/⚠/✕ + 条数 + 一句「怎么补」），全部 ✓/⚠ 才允许「下一步」。⚠ 级（可降级继续）必须在**生成的 PPT 页面上显式留痕**（页脚小字「本页工期由排期推导，未经估算复核」），不允许只在 UI 提示——客户会上追问时页面上要有依据。

**FR-2.3 一致性**：校验只读，不触发任何写入或 AI 调用（零配额消耗）。

**FR-2.4 硬阻塞**：P1+P2+P3 同时为 ✕ → 返回 `blocked:true` + 3 条深链，按钮置灰并写明原因（避免生成一份全「待补充」的空壳稿）。

### 3.3 FR-3/FR-4 PPT 生成流程与章节定义

**FR-3 流程（outline-first，两段 AI + 一段本地装配）**

1. 采集：并发读 P1~P7（服务端 Service 层直接取，不走 HTTP 自环）。
2. 大纲：1 次 `AIService.askJson`（`AIService.ts:328`，temperature=0、失败自动重试 1 次）→ 输出 `[{ section, title, bullets[], dataKeys[], layout }]`，页数 12~18 由提示词约束。
3. **人工确认**：面板内可改标题/增删页/调顺序（内存态，不落库）；确认后发第 2 段。
4. 取数填充：本地装配器按 `dataKeys` 从采集结果取数（**数字类内容一律本地填充，不经 LLM**：计划条数、工期合计、覆盖率、需求分布——避免幻觉改数）。
5. 逐页渲染：pptxgenjs（worker 池，先例 `report-worker.ts:21`），每页发一条 SSE `stage` 事件（`page <n>/<N> 已装配`）。
6. 版式自检：出 Buffer 前跑 §6.3 的 bounds/overlap 断言，越界即该页降级为「标题 + 正文」安全版式并在响应 `warnings[]` 记录。
7. 交付：Buffer + `Content-Disposition`（或令牌下载，见 §3.5）。

**FR-4 章节（必含，顺序固定，均可在大纲确认阶段删页但删时提示「客户会上通常需要」）**

| 编号 | 章节 | 数据来源（真实） | 版式 | 缺失降级 |
|---|---|---|---|---|
| FR-4.1 | 项目团队介绍 | `plan_tasks.assignee` 去重 + 各人承担计划数；用户面板临时补录角色 | 表格 | 无 assignee → 占位「待补充」+ 页脚注明（禁止编造人名） |
| FR-4.2 | 项目背景 | `prd_docs.content_md` 前段（经 `prdContext.ts:75-86` 6000 字符截断） | 图文双栏（图用工作空间已有素材或原生形状） | 无 PRD → 属硬阻塞项（FR-2.4） |
| FR-4.3 | 项目需求 | RTM `prd_requirements`：编号/标题/优先级/关联计划数（`plans.ts:328` 已回 `linkedPlans`） | 原生表格（分页，每页 ≤10 行） | — |
| FR-4.4 | 项目范围 | RTM 分组 + `kind='milestone'` 标题集（范围内/范围外两栏；范围外由 AI 从 PRD「非目标/明确不做」段抽取） | 双栏列表 | PRD 无非目标段 → 范围外页脚注「PRD 未声明，需现场确认」 |
| FR-4.5 | 项目计划（时间线/甘特） | `plan_tasks` 未归档行：`start_date/end_date/duration_days/status/progress/kind` | **原生形状绘时间线**（矩形条 + 里程碑菱形 + 日期轴），不用截图 | 无日期 → 降级为按 `sort_order` 的列表（FR-2.1 P3 已预警） |
| FR-4.6 | 工作量评估 | **优先**：`estimate_items` 表 via `/api/estimates/summary`（人天/人月汇总、PERT 三点、复杂度分布）；**降级**：`Σ plan_tasks.duration_days`（工作日）+ `complexity` 分布；**人月 = 人天 ÷ 20.83**（与估算 PRD §4.5 同因子，常量单源） | 表格 + 饼图/柱图（pptxgenjs `addChart`） | 无估算数据 → 页脚显示「工期口径，非三点估算」；有估算 → 页脚显示「工作量来源：估算引擎」 |
| FR-4.7 | 测试与质量策略 | `test_cases` 覆盖率 `/coverage`、`/stats`（`plans.ts:448-477`）、P0~P3 分布 | 表格 | 无用例 → 从 PRD 验收标准段落生成文字策略 |
| FR-4.8 | 项目风险 | 计划行 `status='blocked'`、进度落后（`progress` vs 时间）、RTM 无关联计划的需求数、复杂度 ≥4 的行数；风险正文 1 次 `askJson` 只做**措辞**，条目由本地规则枚举 | 表格（风险/影响/应对） | 无风险命中 → 写「系统内暂无风险信号，会上补充」 |
| FR-4.9 | 沟通管理 | 里程碑日期推导的例会节点 + `plan_tasks` 阶段边界；协作口径由 AI 生成 | 列表 | — |
| FR-4.10 | 附录：资料清单与溯源 | P1~P7 的条数 + 各资料 `updated_at` + 项目名/工作空间路径 | 表格 | — |

**FR-4.11 逐页脚注**：每页脚注固定「`<项目名> · <章节> · 数据截至 <ISO 日期>`」，来源可回溯到系统内视图（客户质询时的第一道依据，对应 US「逐行回放」诉求）。

### 3.4 数据模型

- 本期**不新增表**。装配全部内存态。
- 可选（审批项 **A-3**）：`kickoff_ppt_logs(id, project_id, tool_id, page_count, warnings, created_at)` 用于「生成历史/可追溯」，沿用 `schema.ts` 建表清单 + `ensureColumn` 幂等范式（先例 `schema.ts:435-518`）；不做则日志仅进控制台流。

### 3.5 FR-5 交付与命名

- 文件名：`项目启动会-<项目名>-<YYYYMMDD>.pptx`（项目名清洗走既有导出命名口径，见 `routes/index.ts:1446` 附近实现与 `export-gate` 用法）。
- 下载：复用 `web/src/utils/download.ts:18/42`；令牌换文件沿用 `ai-download` 白名单范式（`routes/index.ts:1669-1673`，正则**已含 pptx**，零改动）。
- 并发闸：导出走 `server/src/util/export-gate.ts`（内存信号量上限 2，超限 429）——启动会稿与周报共用同一闸，避免 worker 池被并发大稿打满。

---

## 4. API 接口定义

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plans/kickoff-preflight?projectId=` | FR-2.1 校验聚合，返回 `{ items:[{key,count,status,note,deepLink}], blocked, missingHard }`；只读、无 AI 调用 |
| POST | `/api/plans/kickoff-ppt-outline` | 第 1 段 AI：`{ projectId, toolId, extraNote? }` → `{ outline:[{section,title,bullets,dataKeys,layout}] }`（`askJson`） |
| POST | `/api/plans/kickoff-ppt-stream` | 第 2 段：body `{ projectId, toolId, outline }`，SSE 事件 `stage`（逐页）/`done`（含 `token`、`fileName`、`pageCount`、`warnings[]`；`token` 是落盘一次性下载令牌——**下载即删、单次有效**，中止/无人接收时由服务端回收）/`error`；形态对齐 `routes/index.ts:1491-1545`，客户端断开即 abort |
| POST | `/api/plans/kickoff-ppt-download` | 令牌换 Buffer（或复用 `/api/report/ai-download`，审批项 **A-2**） |

约束：`toolId` 必填且取 `ai_tools` 表（`schema.ts:64-78`，CRUD `ConfigService.ts:78-241`，端点 `/api/aitools` `routes/index.ts:1176-1297`）；`AIService.runtimeWithModel` 要求已配 model（`AIService.ts:19-21`）——未配置时端点返 400 + 引导文案（不静默用默认模型烧配额，遵循「不擅改用户 AI 服务配置」）。

---

## 5. 竞品调研与优化建议（GitHub 同类项目）

### 5.1 调研方法与样本

2026-10-11 经 WebSearch/GitHub/官方文档实时核对，样本 4 类共 10 项：可编程生成 pptx 的库（PptxGenJS、python-pptx、pptx-automizer）、Markdown/DSL→幻灯（Marp、Slidev、reveal.js）、AI 生成 PPT 的开源项目（Presenton、PPTAgent、ppt-master、PPTist）、文档 DSL 系参照（docx）。来源链接见文末「调研来源」。

### 5.2 逐项目结论（只留对本 PRD 有约束力的）

| 项目 | 借鉴点 | 对本 PRD 的落点 |
|---|---|---|
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | Node/浏览器同构，文本/表格/图表/图片/备注齐全，产物为原生 OOXML；**单人维护、近期提交稀疏**（[Snyk 维护度 Inactive](https://security.snyk.io/package/npm/pptxgenjs)） | 主路径沿用（本仓已锁 `^4.0.1`，`server/package.json:23`）；**封装适配层 `kickoffBuilder.ts` 独占 import**，全仓不散用，升级只改一处（对应风险 R4） |
| [Presenton](https://github.com/presenton/presenton) | 双模式：Standard（固定版式 + **大纲审查检查点**）/Smart（自适应版式）；Electron 桌面形态、产物可编辑 | FR-3 采纳「大纲先行 + 确认再生成」（本 PRD G3）；本期只做 Standard 版式集（N1/N2），Smart 版式列为扩展 E-2 |
| [PPTAgent](https://github.com/icip-cas/PPTAgent) | 两阶段 edit-based（先抽模板 schema→大纲→逐页编辑动作）+ PPTEval 三维自评（Content/Design/Coherence） | 采纳「逐页失败仅重试该页」（FR-3.5 的页级 stage 事件粒度）；自评三维列入 E-4 观察项，**本期不引入**（无 vision、且自评再耗配额） |
| [PPTist](https://github.com/pipipi-pikachu/PPTist) | Web 端元素级编辑 + 本地导出，是「生成后人工润色」的最佳 UI 参照 | 记为 N2 非目标的依据：本仓无 canvas 编辑器，在线编辑另立项 |
| [Marp](https://github.com/marp-team/marp-cli) / [Slidev](https://github.com/slidevjs/slidev) / [reveal.js](https://github.com/hakimel/reveal.js) | Marp `--pptx` 默认导出**整页渲染图**（`--pptx-editable` 仍标 EXPERIMENTAL）；Slidev 官方文档明确 PPTX 导出＝图片捕获（[导出文档](https://sli.dev/guide/exporting)） | **禁止**作为主路径：产物不可编辑，与「启动会后还要改」冲突（这就是本仓不引入 HTML 幻灯渲染链的实证理由） |
| [python-pptx](https://github.com/scanny/python-pptx)（[PyPI](https://pypi.org/project/python-pptx/)）/ [pptx-automizer](https://www.npmjs.com/package/pptx-automizer) | 唯一能**读现有 .pptx 模板/母版**并填充的路线 | 落为 N1 非目标：装机版不含 Python 运行时（§6.4 实测 `python3` 在本机不可执行），pptx-automizer 虽 Node 但依赖模板母版工程，本期不做 |
| [docx](https://github.com/dolanmiu/docx) | 声明式 DSL→OOXML 的分层设计（本仓 `docx ^9.7.1` 已在用） | 版式 DSL 分层思路沿用：内容模型（`KickoffOutline`）与渲染（pptxgenjs 调用）分离，中间加坐标断言层（§6.3） |

### 5.3 四类优化建议（写进需求，不留在建议层）

- **界面设计规范**：卡片复用 `ReportCard`（FR-1.2）；面板三段式「校验 → 大纲 → 生成/下载」，状态徽标沿用系统二元口径（`todo|done`，见 T01876 结论：`tasks.status` 全链路按二元消费，**本期不引入第三态**）；所有确认走 `web/src/ui/dialogs.tsx`。
- **交互体验改进**：① 大纲可编辑（G3）；② 数字本地填充、AI 只写文字（FR-3.4，防幻觉改数）；③ 逐页进度 + 取消（复用 `AiBatchToast.tsx:9` 的进度条/取消范式与 `aiBatchStore.ts:150 cancelBatch`，SSE abort 已有先例 `routes/index.ts:1527`）；④ 生成后 `warnings[]` 明示哪页被降级版式，让用户知道去哪儿复核。
- **功能模块扩展**（本期不做、按编号留口）：E-1 公司模板母版套用（依赖 N1 决策）；E-2 Smart 自适应版式；E-3 一键把 PPT 大纲回写为「启动会待办」；E-4 PPTEval 式三维自评；E-5 PDF 版交付稿（`pdfkit` 已有，字体走 `C:/Windows/Fonts/simhei.ttf` 先例 `prdExport.ts:1-13`）。
- **UI 视觉升级**：内置 3 套版式（封面/目录、图文双栏、数据页），主色取 `server/src/util/exportStyle.ts:1-33`「规范 A」色值**单源**（导出物与界面同色系）；图文配比约 6:4；正文 ≥14pt、每页 bullet ≤6 行、单行 ≤42 字（超出即按 §6.3 断言降页）。

### 5.4 技术选型结论

主路径 **pptxgenjs（已在依赖内）+ worker 池 + 原生对象**；不引入 HTML 幻灯渲染链（不可编辑）；不引入 Python 子进程（运行时无先例、装机不含）；HTML 预览编辑、模板母版、文生图全部排除在本期之外。

---

## 6. 数据依赖与技术实现说明

### 6.1 取数映射（一页一处，便于实现核对）

内容模型 → 数据：`KickoffOutline.bullets[].dataKeys` 枚举 `prdDoc | reqList | reqStats | planRows | milestones | coverage | assignees | risks | workspace`，装配器按 key 从 §3.3 步骤 1 的采集结果取值；**任何数字型 bullet 必须由 dataKey 解析，不接受 AI 自由文本**（FR-3.4 的可测化）。

### 6.2 AI 侧

- 2 次调用：大纲（`askJson`）+ 风险/沟通正文措辞（`askJson`）。总提示词长度受 `PRD_CONTEXT_LIMIT=6000` 约束（`util/prdContext.ts:25`）。
- 配额纪律：面板显示「本次将调用 <toolId> 约 2 次」，用户确认后才发起；失败仅重试对应段（不做全链重跑，避免 T01620 那类批量僵尸态）。

### 6.3 版式质量门禁（技能路径纪律的 Node 移植）

`pptx-skill-for-trae/pptxgenjs.md:149-233` 的 Layout Safety 六条 → 本仓实现为 `server/src/services/kickoff-layout.ts`：

1. 画布先行（`:153`）：固定 `LAYOUT_16x9`（10×5.625"），`MARGIN` 四周 0.5"，先算 `getContentFrame`（`:157-180`）。
2. 逐元素边界断言（`:182-192`）：`addText/addShape/addImage/addChart` 前 `assertInBounds`，越界即该页降级安全版式 + `warnings.push`。
3. 纵向堆叠（`:196-212`）：`stackY(startY, blocks, gap)`，`gap ≥ 0.3`、底部留 ≥0.4"，禁止散写 `y`。
4. 换版式必缩放（`:214-227`）：`scaleBox`，避免半迁移。
5. 动态布局防重叠（`:229+`）。
6. 对比度：正文色/背景色走 WCAG 检查（`:308`），色值仍来自 `exportStyle.ts` 单源。

> 关键设计选择：**QA 用于验证而非发现基础越界**（技能原文 `:151`「QA should validate, not discover basic bounds errors」）——因此本功能的验收里「无越界」是断言级保证，不是抽查级观察。

### 6.4 对指定技能路径的可用性实测（2026-10-11，取证方式：只读列目录 + 命令层验证）

- 路径存在：`D:\code\Data_Trae\.trae-cn\skills\pptx-skill-for-trae\{SKILL.md, editing.md, pptxgenjs.md, package.json, README.md, scripts/}`；`scripts/` 为 `add_slide.py / clean.py / fix_pptx.py / pack.py / unpack.py / validate_layout.py`。
- **可采纳的是方法论**：`pptxgenjs.md` 的 Layout Safety 全章（`:139-233`）、版式尺寸表（`:139-145`）、原生形状作图（`:397+`）、表格（`:605+`）、对比度（`:308`）→ 已在 §6.3 落为需求。
- **不可采纳的是运行时**：技能 QA 链路写死 `python3 -m markitdown` 与 `python3 scripts/*.py`，而 ① 本仓运行形态是 Electron 安装包（不含 Python 运行时，child_process 用法仅 §1.3 四处，无 python 先例）；② 本机实测 `python3 -c "print(1)"` → **exit 49 不可用**（`python` 可用，但技能脚本以 `python3` 调用）。故 **N1**：不在产品里调 Python；`validate_layout.py`/`markitdown` 只能作为**开发期外部工具**（人工在有 python3 的机器上抽查产物），运行时 QA 用 §6.3 的 Node 断言替代。

---

## 7. 非功能需求

| 项 | 要求 | 依据/口径 |
|---|---|---|
| 性能 | 14 页稿：大纲段 ≤ 60s，装配段（含渲染）≤ 25s；装配不吃 AI | worker 池先例 `ReportService.ts:227-243`；导出并发闸 `export-gate.ts`（上限 2，超限 429） |
| 可中断 | 客户端断开即 abort，不留半个临时文件 | 同 `routes/index.ts:1527` 范式；`.part` 清理先例 `electron/main.js:462-492` |
| 中文与字体 | pptxgenjs **不做字体嵌入**，只记字体名 → 统一「微软雅黑」并声明 fallback；跨机打开需目标机装有该字体 | 调研 §5.2（PptxGenJS 能力边界），风险 R3 |
| 兼容 | 产物需在 PowerPoint 2016+ 与 WPS 均能打开；不写入 pptxgenjs 实验特性 | 产物由 `addTable/addText/addShape` 基础对象组成，图表走 `addChart`（原生 chart，非图片） |
| 隐私/安全 | 只读项目资料 + 工作空间白名单文件；不上传源码全文（技术章节仅用 symbols/摘要，受 6000 上限） | `prdContext.ts:25`；`/workspace/file` 既有守卫（`routes/index.ts:250-287`） |
| 失败可解释 | 任一段失败给出「哪一段、哪一页、原因、是否重试该页」，不吞异常 | SSE `error` 事件；对齐 T01568/T01569 系列「失败必须有回执」口径 |
| 不污染数据 | 全流程不写业务表（除可选日志表 A-3）；不触发计划重排（`PlanService.rescheduleFrom`） | 与 T01875/T01843 一致的「只读优先」纪律 |

---

## 8. 验收标准（逐条可测）

1. 卡片出现在第 7 位、样式与其他 6 张逐像素同源（复用 `ReportCard`），点击开面板、再点其他卡片互斥关闭。
2. 空项目 → `blocked:true`，3 条硬缺失点名 + 深链可跳转，生成按钮不可用；全程零 AI 调用（可用 `/api/aitools` 调用计数或日志佐证）。
3. mtask四期（真实资料）→ 校验返回 P1~P7 条数与实际一致（与 `GET /api/plans/prd-requirements`、`GET /api/plans` 逐条对数）。
4. 大纲可增删改；确认后页数落 12~18；`done` 事件带 `token`（一次性下载令牌，下载即删）+ `fileName`，下载得到可打开的 .pptx（`unzip -l` 含 `ppt/slides/slide*.xml`）。
5. **可编辑性硬检**：产物内文本框/表格/图表是原生对象（解包 XML 可见 `<a:t>` 文本、`<p:graphicFrame>` 表格），无「整页图片」型 slide（这是排除 Marp/Slidev 路线的验收落点）。
6. FR-4.5 时间线页存在里程碑菱形与日期轴；FR-4.6 工作量页人天合计 = `Σ estimate_items.man_days`（有估算时）或 `Σ plan_tasks.duration_days`（降级时），且页脚动态显示「工作量来源：估算引擎」或「工期口径，非三点估算」。
7. §6.3 断言：构造一个必然越界的长标题 → 该页降级为安全版式且 `warnings[]` 记录，产物仍能打开。
8. 数字防幻觉：`reqStats` 等数字 bullet 与库内条数一致（AI 改数字的路径在代码层不存在，可用提示词注入「把需求数写成 999」验证不生效）。
9. 取消/断连：生成中关闭面板 → 服务端 abort，无残留临时文件、无僵尸会话。
10. 回归：周报四格式导出（含 pptx）不受影响；`export-gate` 并发上限仍生效。

---

## 9. 交付拆解（批准后按本表回写「项目计划」并逐条派生实施任务，不建散任务）

| 编号 | 内容 | 依赖 | 优先级 | 量级 |
|---|---|---|---|---|
| K1 | `kickoff-preflight` 端点 + Service 取数聚合（纯读） | — | P0 | S |
| K2 | 大纲段：提示词 + `askJson` schema 校验 + 失败重试 1 次 | K1 | P0 | M |
| K3 | `kickoff-layout.ts` 版式断言层（§6.3 六条）+ 3 套版式 + 色值接 `exportStyle` 单源 | — | P0 | M |
| K4 | 装配器 `kickoffBuilder.ts`：dataKeys 取数 → pptxgenjs 渲染（含 FR-4.5 时间线形状、FR-4.6 图表） | K2,K3 | P0 | **L**（时间线/甘特形状为最大不确定项） |
| K5 | SSE 端点 `kickoff-ppt-stream`（逐页 `stage`/`done`/`error`/abort）+ 下载令牌 | K4 | P0 | S |
| K6 | 前端 `KickoffPptPanel`（卡片、checklist、大纲可编辑、逐页进度、warnings 展示）+ 控制台 tab | K1,K2,K5 | P0 | L |
| K7 | 降级与占位路径（无 assignee/无用例/无日期）+ 页脚溯源文案 | K4 | P1 | S |
| K8 | 验收 1~10 自动化（API 冒烟 + 解包 XML 断言 + 数字一致性）+ 装机版人工抽查 | K1~K7 | P1 | M |

> 本 PRD **不**自动写入项目计划：按 §11 的裁决门，业主批准（含 N1/N4/A-2/A-3 四项）后才回写。

---

## 10. 风险与开放问题

| 编号 | 风险 | 影响 | 处置 |
|---|---|---|---|
| R1 | pptxgenjs 单人维护、活跃度趋停（`^4.0.1`） | 后续升级/安全补丁不确定 | 适配层单点封装 + 锁版本 + 产物解包断言进回归（验收 4/5） |
| R2 | 工作量页与估算功能（E 系列）口径可能分叉 | 同一项目两套人天数字，客户会上被质询 | 本期走「工期口径 + 页脚声明」（N4）；E 系列上线后 K4 的数据键 `workload` 切到 `estimate_items`，**切换必须保留口径开关与来源标注**，不静默换数 |
| R3 | 中文字体不嵌入 → 换机打开字体回退、版式跳字 | 交付稿观感不可控 | 固定「微软雅黑」+ 断言层按字符数预留宽度；文档明示；长期方案=导 PDF（E-5） |
| R4 | AI 编造事实（团队、范围外、风险） | 客户会上失实 | FR-3.4 数字本地填充 + FR-4.1 禁编人名 + 缺失显式「待补充」占位；正文措辞只允许引用 dataKeys 取到的原文片段 |
| R5 | 大项目资料超 6000 字符截断 → 背景/范围失真 | 内容不全覆盖 | 大纲段带 `truncated:true` 标记并提示；范围/背景拆两页由 RTM 表格补全（表格不走截断，本地分页） |
| R6 | 与周报共用 worker 池 + 导出闸 → 并发下排队 | 生成等待 | `export-gate` 上限 2、超限 429 前端可读；面板排队态明确文案 |
| Q1 | 是否本期做日志表 `kickoff_ppt_logs` | 可追溯性 | 审批项 **A-3**（默认不做） |
| Q2 | 下载走复用 `ai-download` 白名单还是新增端点 | 一致性 | 审批项 **A-2**（默认复用，白名单已含 pptx） |
| Q3 | N1（母版模板）/N2（在线编辑）是否另立项 | 客户若有公司模板硬需求 | 审批项 **A-1**（默认非目标） |

---

## 11. 裁决结果（待业主签字）

| 项 | 待决内容 | 建议值 |
|---|---|---|
| A-1 | 非目标 N1（模板母版）/N2（在线编辑）/N3（文生图）/N4（依赖估算）是否确认 | **确认**（N1/N2 若客户有模板硬需求，另立 E-1 单，需先解决装机含 Python 运行时的打包问题——见 §6.4） |
| A-2 | 下载端点复用 or 新增 | 复用 `/api/report/ai-download`（`routes/index.ts:1669`，白名单已含 pptx） |
| A-3 | 是否本期建 `kickoff_ppt_logs` | 不建（日志进控制台 SSE 流；有审计诉求再补） |
| A-4 | 工作量页口径 | 本期用 `Σ duration_days` + 页脚「非三点估算」标记；估算 PRD §4.5 的 20.83 因子作为共享常量单源 |

---

## 附录 A：PPT 模板章节示例（14 页版）

```
1  封面        <项目名> 项目启动会 ｜ 日期 ｜ 甲方/乙方标识位（原生文本，无图片依赖）
2  议程        6 条 bullet（本地取章节标题，不由 AI 写）
3  项目背景    图文双栏：左 PRD 摘要（≤120 字，截断标记）｜右 项目要素卡
4  项目团队    表格：角色 | 姓名 | 承担计划数（assignee 缺失 → 「待补充」行）
5  项目需求    表格 P1：req_no | 标题 | 优先级 | 关联计划数（≤10 行/页）
6  项目需求    表格 P2（续页，表头重复）
7  需求分布    原生柱图：按优先级/按模块（数据来自 RTM 统计）
8  项目范围    双栏：范围内（milestone 标题集）｜范围外（PRD 非目标段；缺 → 现场补充）
9  项目计划    原生形状时间线：里程碑菱形 + 计划条 + 日期轴（16:9，左右边距 0.5"）
10 计划明细    表格：标题 | 起 | 止 | 工期 | 状态 | 进度
11 工作量评估  表格 + 饼图：按里程碑人天小计 ｜ Σ 人天 ｜ 人月=人天÷20.83 ｜ 页脚口径声明
12 测试与质量  表格：覆盖率 | P0~P3 分布 | 用例数（无用例 → 文字策略）
13 项目风险    表格：风险 | 影响 | 应对（条目由本地规则枚举，AI 仅措辞）
14 沟通管理    列表：例会节点（按里程碑日期推导）| 变更流程 | 问题升级路径
15 附录        资料清单与溯源：P1~P7 条数 + updated_at + 项目名 + workspace_path
```

## 附录 B：调研来源（链接）

- PptxGenJS https://github.com/gitbrent/PptxGenJS ｜ 维护度 https://security.snyk.io/package/npm/pptxgenjs
- Presenton https://github.com/presenton/presenton ｜ 生成模式 https://github.com/presenton/presenton/blob/main/docs/presentation-generation-modes.md
- PPTAgent https://github.com/icip-cas/PPTAgent ｜ ppt-master https://github.com/hugohe3/ppt-master ｜ PPTist https://github.com/pipipi-pikachu/PPTist
- marp-cli https://github.com/marp-team/marp-cli ｜ marpit https://github.com/marp-team/marpit ｜ Slidev 导出说明 https://sli.dev/guide/exporting ｜ reveal.js https://github.com/hakimel/reveal.js
- python-pptx https://github.com/scanny/python-pptx ｜ PyPI https://pypi.org/project/python-pptx/ ｜ pptx-automizer https://www.npmjs.com/package/pptx-automizer ｜ docx https://github.com/dolanmiu/docx
- 本仓既有实现参照（非外部）：`server/src/services/report-builder.ts:220`、`server/src/services/report-worker.ts:21`、`server/src/routes/index.ts:1446/1491/1669`、`server/src/util/export-gate.ts`、`server/src/util/exportStyle.ts`、`server/src/util/prdContext.ts:25`、`web/src/pages/ReportPage.tsx:85/404/691`、`web/src/stores/aiBatchStore.ts:85/131/150`、`web/src/ui/AiBatchToast.tsx:9`、`D:\code\Data_Trae\.trae-cn\skills\pptx-skill-for-trae\pptxgenjs.md:139-233`
