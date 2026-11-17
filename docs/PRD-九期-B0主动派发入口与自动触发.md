# PRD：MTask 九期 · B0 主动派发入口与自动触发

> 文档状态：评审稿（待产品、研发、测试确认）  
> 版本：v1.1（补充队列页 / 执行会话页 / 任务池分工与 `queues.kind`）  
> 日期：2026-11-17  
> 项目：MTask 九期  
> 关联任务：T05739（分发调研）、T05747（PushDispatcher）、T05792 / T05793（评审与平台适配）、T05800（按平台 Token 与角色隔离草案）  
> 适用端：MTask 桌面版 / 打包版；生产端口 `39877`，开发端口 `39876`  
> 设计基线：`docs/调研-MTask向WorkBuddy分发任务方案及开源参考.md`、`docs/九期-A通道平台适配现状.md`、`docs/九期-按平台token与角色隔离-草案.md`

---

## 0. 摘要

MTask 已经具备 B0 的**服务层能力**：`PushDispatcher` 能把任务路由到 CodeBuddy 本地 run 网关，`RelayDispatchService` 与 `QueueService` 能承载提交、ticket、轮询和结果回写。但目前 B0：

- 只有 REST 手动入口 `POST /api/dispatch/task`，没有用户可见的界面入口；
- 没有自动触发调度器，任务不会因为进入待办或就绪而自动推送；
- 没有 B0 专属配置页、状态卡、派发历史与失败原因面板；
- 与 A（MCP 拉取）、D（GUI 应急）的边界在 UI 上不可见，用户无法判断“为什么没有派发”。

本 PRD 定义两个入口，并把三个现有工作面串起来：

1. **手动派发**：在任务详情抽屉按单条任务触发，支持“自动 / 仅 B0 / 仅 A / D 应急”，结果逐通道回显。
2. **自动派发**：在设置 → 运维与诊断 → 新增“派发策略”页签中配置，由独立调度器按策略扫描任务；不依赖监督器 LLM，也不自动执行 D。
3. **观测与审计**：任务详情显示最近派发尝试；队列页“派发记录”查看内部 queue/job；执行会话页只观测外部 Agent 会话，不混入 B0 run。

**与现有两个菜单的分工一句话结论：**

- **任务详情**：单条任务的“现在就要派发”，看本次尝试与结果。
- **队列**：人工批量编排与批量投放，看 queue/job 回执；B0 单条派发产生的内部队列默认不在这里展示。
- **执行会话**：外部 Agent 会话的存活/进度/停滞观测与“重派”，不承载 B0 run 状态，也不作为 B0 派发入口。
- **设置 → 派发策略**：全局自动策略与 B0 工具配置，不是日常派发操作台。

**结论：不新增顶层“派发”菜单。** 单条在任务详情，批量在队列页，执行会话页只做外部会话观测；B0 派发产生的内部队列不进入人工队列列表。

---

## 1. 背景与目标

### 1.1 现状

| 能力 | 当前实现 | 现状判断 |
|---|---|---|
| B0 适配器 | `server/src/adapters/codebuddyGateway.ts`：`POST {endpoint}/api/v1/runs`，结果经 `GET /api/v1/runs/:runId/stream` SSE 收敛 | 已实现，Beta 接口 |
| B0 路由 | `server/src/services/PushDispatcher.ts`：`B0_PLATFORM='codebuddy-gateway'`、`B0_TOOL_KEY='dispatch.b0ToolId'`，`auto` 顺序 B0 → A → D | 已实现，手动调用 |
| B0 REST | `server/src/routes/dispatch.ts`：`GET /status`、`POST /task`，channel 支持 `auto/b0/a/d` | 已实现，但无 UI |
| 队列与回执 | `RelayDispatchService.dispatchTask()` 复用 `QueueService` 的 submit/poll/ticket；B0 工具 id 通过 `toolIdOverride` 传入 | 已实现 |
| 异步结果 | `AIService.buildPoller()` 对 `codebuddy-gateway` 的失败/超时执行 A 归位 | 已实现，但 UI 不可见 |
| 执行会话 | `ExecSessionService.redispatchSession()` 调 `RelayDispatchService.dispatchTask(taskId, row.platform)`，读 `supervisor.relayToolId` | **不是 B0 链路**，不能当作 B0 入口 |
| 自动触发 | `SupervisorService.supervisorTick()` 只做会话停滞、就绪标记与监督决策；不调用 `PushDispatcher` | **缺失** |
| 设置页 | `SettingsPage` 的 `supervisor` 页签 → `SupervisorPanel`，只有 `relayPlatforms` / `relayToolId` | **无 B0 配置** |
| 状态展示 | `PushDispatcher.status()` 能返回 B0 configured/toolId/endpoint | 前端未消费 |

### 1.2 问题陈述

1. **入口不可发现**：用户必须知道 REST 路径和 token，才能手动派发一条任务。
2. **自动触发缺失**：任务进入 `todo` / `monitor_ready` 后，不会主动推送到 CodeBuddy 网关；B0 的能力实际上闲置。
3. **策略不可控**：没有“哪些项目、哪些任务、什么条件下自动派发”的界面，无法防止把所有待办误推给 B0。
4. **失败不可解释**：B0 失败、转 A、转 D、异步超时等结果只写日志，用户看不到“为什么没派发/派发到哪了”。
5. **语义易混淆**：执行会话页的“重派”走中继工具 `supervisor.relayToolId`，不是 B0；如果继续把 B0 按钮塞进执行会话，会造成“重派 = B0”的误解。
6. **自动与监督器耦合风险**：`SupervisorService` 在 `supervisor.enabled=false` 时提前返回；若把 B0 自动触发挂在其后，B0 会随监督器一起停摆。

### 1.3 目标

| 编号 | 目标 | 可度量结果 |
|---|---|---|
| G1 | 提供单任务手动派发入口 | 用户从任务详情 3 次点击内发起派发；结果和失败原因可见 |
| G2 | 提供可配置的自动派发 | 可在设置中开启/关闭、选择 B0 工具、限定项目与任务范围；重启后策略保持 |
| G3 | 自动触发不依赖监督器 LLM | `supervisor.enabled=false` 时，自动派发仍可按 `dispatch.autoEnabled` 独立运行 |
| G4 | 防止重复派发 | 同一任务在冷却窗口内不重复自动派发；进程重启后不重复提交 |
| G5 | 保持 A/D 语义 | B0 失败可降级 A；D 只在人工确认后执行，自动链路不执行 D |
| G6 | 可观测、可审计 | 每次派发记录 channel/state/queue/ticket/fallback；任务详情可见最近尝试 |
| G7 | 为其他平台预留扩展 | B0 仅用于 `codebuddy-gateway`；Qoder/Trae/豆包/Codex 不强行套用 B0，预留 A / CLI Process Adapter |

### 1.4 非目标

- 不在本期实现企业版 Managed Agents / ACP / A2A 完整接入。
- 不在本期实现 Qoder、Trae、豆包、Codex 的本地 run 网关适配；这些平台没有 `/api/v1/runs` 时，不能称为 B0。
- 不把 D（GUI 直驱）改为无人值守自动执行；D 仍然必须人工确认。
- 不新建第二套任务库或队列库；复用 `tasks` / `queue_jobs` / `exec_sessions`。
- 不做多租户、计费、云端控制面。
- 不把执行会话页的“重派”改成 B0；保留其“会话恢复”语义。

---

## 2. 用户场景

### 2.1 角色

| 角色 | 关注点 | 典型动作 |
|---|---|---|
| 项目负责人 | 某条任务现在就要交给 CodeBuddy 执行 | 打开任务详情 → 派发 → 选“仅 B0” → 看结果 |
| 日常开发者 | 批量把今日待办推给外部 Agent | 队列页选择任务 → 加入队列 → 发送队列 → 看逐条回执 |
| 运维 / 平台管理员 | 配置 B0 网关、自动策略、排障 | 设置 → 派发策略 → 测试连接 → 看审计 |
| 评审者 | 确认失败原因与是否转人工 | 任务详情 → 查看 attempts / fallback / 执行会话 |

### 2.2 用户故事

| 编号 | 场景 | 用户操作 | 期望结果 |
|---|---|---|---|
| US-1 | 单任务立即派发 | 任务详情点“派发”，选择“仅 CodeBuddy 网关（B0）” | B0 受理后显示 runId/ticket；失败时显示鉴权/端口/工具未配置原因，且不回退 |
| US-2 | 单任务自动降级 | 选择“自动（B0 → A → D）” | B0 失败自动退 A；A 失败显示“已转 D 人工确认”，不自动开 GUI |
| US-3 | 自动排水 | 在设置中开启自动派发，限定 MTask 九期 | 符合条件的待办按冷却窗口逐步派发；不重复、不误推其他项目 |
| US-4 | 暂停自动 | 设置页关闭总开关 | 下一轮不再取新任务；已经在途的 B0 job 不受影响 |
| US-5 | 失败排障 | 打开任务详情“最近派发” | 看到每次 channel、state、ticket、fallback reason、queue/job 链接 |
| US-6 | 批量派发 | 队列页勾选多条待办，加入人工队列并发送 | 逐条显示成功/失败/跳过，不因一条失败中断整批 |
| US-7 | 防止误推 | 任务标记“自动派发=关闭” | 即使全局开关打开，该任务也不会被自动派发 |
| US-8 | 生产验收 | 管理员在 39877 端口检查状态 | 能确认 B0 已配置、A 就绪池数量、D 待人工数量、自动策略最近运行时间 |

### 2.3 关键用户流程

**手动单任务：**

```text
任务详情
  → 点击「派发」
  → 选择通道（自动 / 仅 B0 / 仅 A / D）
  → 前端校验 todo + 未归档 + 非 running
  → POST /api/dispatch/task
  → 显示 attempts（逐通道）
  → 刷新任务 / 执行会话 / 队列回执
```

**自动策略：**

```text
设置 → 派发策略
  → 开启自动派发
  → 选择 CodeBuddy 网关工具
  → 选择项目范围 / 任务范围
  → 设置冷却与每轮上限
  → 保存
  → 调度器下一轮扫描候选
  → 逐条派发 + 写审计
  → 状态卡显示最近运行与成功/失败
```

---

## 3. GitHub 同款与同类产品调研

### 3.1 调研口径

- 调研时间：2026-11-17。
- 范围：GitHub 上以“任务/工单 → Agent 执行 → 结果回写”为核心的产品，以及提供队列、重试、运行观测、人工闸门的任务编排平台。
- 判断维度：核心功能、用户流程、交互亮点、技术边界、对 MTask 的可借鉴点。
- 不以 star 数作为质量判断；star 数易受时间与推广影响，本文只看仓库实际功能与文档。
- 许可证只作为“能否复用代码”的边界，不把参考产品的代码直接搬进 MTask；本 PRD 只借鉴模式与交互。

### 3.2 同款：任务/工单直接派发给 Agent

#### 3.2.1 `ginkida/agent-dispatch`

- 仓库：<https://github.com/ginkida/agent-dispatch>
- 定位：MCP server + CLI，让 Claude Code Agent 把任务派发到其他项目目录中的 Agent。
- 核心功能：
  - `list_agents` / `inspect_agent`：列出和检查可用 Agent；
  - `dispatch` / `dispatch_async` / `dispatch_session`：同步、异步、续会话；
  - `dispatch_status` / `dispatch_wait` / `dispatch_cancel` / `dispatch_jobs` / `dispatch_gc`：任务生命周期；
  - `groups`：把多个项目 Agent 组成共享 brief 的工作组；
  - usage journal：统计耗时、成本、成功率、错误类型。
- 用户流程：`list_agents` → `inspect_agent` → `dispatch` 或 `dispatch_async` → `dispatch_status/wait` → 结果；超时后用 `session_id` 续跑。
- 交互亮点：
  - 派发前可检查 Agent 的能力、MCP、技术栈、权限和典型耗时；
  - 错误类型是确定性的：`permission`、`timeout`、`recursion`、`not_found`、`budget`、`usage_limit`、`cli_error`；
  - 超时保留 `session_id`，支持“从上次断点继续”，而不是重新开一条；
  - 明确建议：能自己做的不要派发，派发会启动一个完整会话。
- 技术边界：主要面向 Claude Code；本地进程与会话存储；没有中心化任务看板；跨项目仍依赖本机 CLI 与账号。
- 对 MTask 可借鉴：
  - **Agent 能力注册表**：B0 工具卡片应显示 endpoint、鉴权状态、最近成功/失败，而不是只显示一个工具 id；
  - **session/attempt 可续跑**：MTask 的 `exec_session_id` 与 B0 `runId` 应形成可回溯关系；
  - **确定性错误分类**：把“未配置、鉴权失败、端口不通、超时、结果流丢失”拆成不同错误码；
  - **成本与耗时**：任务详情可显示本次派发耗时、ticket、结果状态；
  - **派发前的克制**：不是所有任务都值得派发，自动策略必须有范围。

#### 3.2.2 `artificemachine/superharness`

- 仓库：<https://github.com/artificemachine/superharness>
- 定位：面向 Claude Code、Codex CLI、Gemini CLI、OpenCode、Pi、Hermes 的多 Agent 任务生命周期与队列编排。
- 核心功能：
  - `discussions`：多 Agent 讨论与共识；
  - `tasks`：任务生命周期 `todo → plan_proposed → plan_approved → in_progress → report_ready → done`；
  - `enqueue` / `dispatch` / `watch`：基于队列的委派；
  - `handoff`：跨会话交接；
  - `status`：一屏查看 Agent、队列、讨论、任务、审批；
  - SQLite 作为唯一状态源；watcher 可后台运行。
- 用户流程：创建任务 → 计划/批准 → 入队 → watcher 派发给 Agent → Agent 上报 → `report_ready` → 评审 → `done`；中断后通过 handoff 继续。
- 交互亮点：
  - `shux status` 用一行摘要暴露 `pending/launched/running/paused/done/failed/stale`；
  - 生命周期门槛阻止未批准任务直接执行；
  - 自动归档、自动失败、清理孤儿队列；
  - 任务支持依赖、验收标准、TDD 三段。
- 技术边界：本地 SQLite + CLI；没有中心化多租户控制面；依赖各 Agent CLI；不是通用任务管理 UI。
- 对 MTask 可借鉴：
  - MTask 应把“派发”做成 **任务生命周期的一等状态**，而不是一次 HTTP 调用；
  - 引入 `attempt / stale / failed / manual` 等状态，并在 UI 一屏可见；
  - 自动清理与冷却；任务级验收标准；
  - 任务详情展示“上一次派发/下一次可派发时间”。

#### 3.2.3 `layl-labs/orchestmux`

- 仓库：<https://github.com/layl-labs/orchestmux>
- 定位：用 tmux 把 Claude Code、Codex、Kimi、Gemini、OpenCode 等 CLI 编排成可观察的并行工作器。
- 核心功能：
  - 一句话让 Claude 选择 ensemble（同一任务多 Agent 对比）或 split（拆分独立子任务）；
  - 每个 worker 一个 tmux pane；
  - 等待 worker **真正上报完成**，而不是猜测终端输出；
  - 每个 worker 输出镜像到日志文件；
  - worker 死亡立即通知协调者。
- 用户流程：`/orchestmux:run ...` → 选择形状 → 启动多个 pane → 等待上报 → 汇总答案。
- 交互亮点：
  - “完成”是记录下来的事实，不是终端看起来像完成；
  - pane 保留，可回看推理与接管；
  - 失败大声，不静默卡在“进行中”；
  - 无 daemon、无服务、单 SQLite 文件。
- 技术边界：tmux、Unix/WSL；共享工作树时并发编辑会冲突；没有远程控制面；不提供模型访问。
- 对 MTask 可借鉴：
  - “已受理”与“已完成”必须是两个不同状态；
  - 结果日志要持久化，不能只依赖进程内存；
  - 失败必须主动通知，不等待超时；
  - MTask 不需要内嵌终端 pane，但需要等价的“运行详情 + 日志 + 失败原因”。

#### 3.2.4 `dephelion/baya-cli`

- 仓库：<https://github.com/dephelion/baya-cli>
- 定位：把纯文本任务清单转成依赖图，路由到本机已安装的 Codex / Claude / Copilot / OpenCode 并执行。
- 核心功能：
  - 任务清单支持 Markdown、TXT、YAML；
  - LLM 规划器生成 JSON DAG；
  - 按 provider/model 路由；
  - 独立任务并行、依赖任务等待；
  - 失败/中断后 checkpoint 与 resume；
  - 兼容任务复用进程。
- 用户流程：写任务清单 → `baya` 规划 → 生成 DAG → 选择 provider/model → 执行 → 报告。
- 交互亮点：
  - 不要求用户学习配置 DSL；
  - 自然语言里的依赖也能被识别；
  - 失败后可从断点继续，不丢已完成步骤；
  - `baya doctor` 先检查环境。
- 技术边界：CLI、本机账号、Node 24；没有 Web 控制台；不提供任务管理 UI。
- 对 MTask 可借鉴：
  - 任务依赖与 DAG 可以作为自动派发的排序依据；
  - provider 路由不应硬编码在 UI，应做成适配器/能力表；
  - 断点恢复应落到 `exec_session_id` 与 `ticket`；
  - 自动派发前先做环境诊断，避免把任务推给不可达的 CLI。

### 3.3 同类：任务队列、工作流与 Agent 运行平台

#### 3.3.1 `hatchet-dev/hatchet`

- 仓库：<https://github.com/hatchet-dev/hatchet>
- 核心：后台任务、AI Agent、持久工作流的编排引擎；队列、自动重试、DAG、cron、事件触发、worker affinity、并发/速率限制、实时 UI。
- 用户流程：定义任务 → 注册 worker → 触发/定时/事件 → worker 领取 → 重试/完成 → 在 Web UI 查看运行。
- 交互亮点：实时运行看板、重试历史、worker 槽位、按标签路由。
- 技术边界：Go 服务 + Postgres；需要独立部署；不是任务管理产品。
- 可借鉴：重试策略、worker 路由、运行观测、Postgres 作为 durability 层；MTask 不引入其服务，只借鉴“attempt + state”模型。

#### 3.3.2 `triggerdotdev/trigger.dev`

- 仓库：<https://github.com/triggerdotdev/trigger.dev>
- 核心：TypeScript AI Agent / 长任务平台；队列、重试、幂等、waitpoint 人工审批、实时订阅、运行日志。
- 用户流程：定义 task → `tasks.trigger` → run → 订阅实时状态 → 人工 waitpoint → 结果。
- 交互亮点：每个 run 有完整 tracing；长任务无超时；人工审批作为可等待节点。
- 技术边界：SDK/云或自托管；面向开发者，不是通用任务管理。
- 可借鉴：run 时间线、waitpoint 人工闸门、幂等键、流式结果。

#### 3.3.3 `windmill-labs/windmill`

- 仓库：<https://github.com/windmill-labs/windmill>
- 核心：代码优先的 workflows/apps/AI agents；脚本自动生成 UI/API/cron；worker groups；环境与 Git 同步；AI session 预览和评审。
- 用户流程：写脚本 → 自动生成参数 UI → 组成 flow → 定时/触发 → 在 worker 执行 → 查看运行。
- 交互亮点：代码与 UI 同源、环境晋升、AI 结果可 review 后部署。
- 技术边界：Rust 服务、AGPLv3；自托管较重。
- 可借鉴：worker group、调度与环境隔离；MTask 的“自动派发”应只做运营策略，不扩成通用 workflow builder。

#### 3.3.4 `n8n-io/n8n`

- 仓库：<https://github.com/n8n-io/n8n>
- 核心：可视化工作流、1500+ 集成、Webhook/定时触发、执行历史、AI 节点。
- 用户流程：画布编排 → 配置触发器/凭据 → 执行 → 查看每次 execution。
- 交互亮点：触发器与连接器目录极其完整；执行历史按节点展开。
- 技术边界：fair-code Sustainable Use License，企业功能另授权；自托管资源占用较高。
- 可借鉴：触发器目录、执行历史、凭据隔离；不借鉴其可视化画布作为 MTask 主界面。

#### 3.3.5 `langgenius/dify`

- 仓库：<https://github.com/langgenius/dify>
- 核心：Agentic workflow、RAG、模型/工具抽象、工作区、运行日志。
- 用户流程：创建工作流/Agent → 配置模型与工具 → 调试 → 发布 → 查看日志。
- 交互亮点：模型与工具配置集中；工作区协作；调试与运行记录。
- 技术边界：Python 技术栈；偏 LLM 应用，不是任务管理系统。
- 可借鉴：工具配置与凭据集中管理、运行日志；MTask 的 B0 工具卡片可参考其“模型/工具”配置体验。

#### 3.3.6 `activepieces/activepieces`

- 仓库：<https://github.com/activepieces/activepieces>
- 核心：AI Agents + MCP + 工作流自动化；pieces 是 TypeScript 包，可自动暴露为 MCP server；支持人工输入/审批。
- 用户流程：选择 trigger → 编排 pieces → 运行 → 人工输入/审批。
- 交互亮点：适配器即 piece，生态可扩展；人工输入接口内建。
- 技术边界：社区版 MIT + 企业功能商业许可；偏集成自动化。
- 可借鉴：**适配器注册表**与“能力即插件”的思路；B0、A、CLI Process 应作为并列 adapter，不要互相耦合。

#### 3.3.7 `temporalio/temporal`

- 仓库：<https://github.com/temporalio/temporal>
- 核心：持久化执行平台；Workflow/Activity、自动重试、长等待、状态恢复。
- 用户流程：定义 workflow → worker 执行 activity → 失败重试 → 查询历史。
- 交互亮点：确定性重放、长任务状态持久化、运维可见。
- 技术边界：独立服务、运维成本高；对单机 MTask 过重。
- 可借鉴：把“派发尝试”持久化；本期不引入 Temporal，避免架构膨胀。

#### 3.3.8 `OpenHands/OpenHands`

- 仓库：<https://github.com/OpenHands/OpenHands>
- 核心：自托管 Agent Canvas；可接 OpenHands、Claude Code、Codex、Gemini、Pi、OpenCode；本地/远程/云后端；Automations 支持 Slack/GitHub/Linear 和定时/Webhook。
- 用户流程：选择 Agent/后端 → 创建会话 → 对话/自动化 → 查看运行。
- 交互亮点：多后端切换、统一控制中心、自动化模板。
- 技术边界：Agent 运行时/控制中心，不是任务管理；后端接入需要各自协议。
- 可借鉴：**统一后端抽象**与“会话即执行单元”；MTask 可把 B0、A、CLI Process 作为后端，而不是把平台名散落在业务代码里。

#### 3.3.9 `opensandbox-group/OpenSandbox`

- 仓库：<https://github.com/opensandbox-group/OpenSandbox>
- 核心：AI Agent 沙箱；命令/文件/浏览器/桌面隔离；网络出入控制；凭据保管；SDK/CLI/MCP；本地 Docker 到 Kubernetes。
- 用户流程：创建 sandbox → 执行命令/文件 → 取结果 → 销毁/暂停。
- 交互亮点：凭据不进入沙箱；暂停/恢复保留内存与磁盘状态。
- 技术边界：需要容器/集群；偏运行时，不是任务管理。
- 可借鉴：D 通道的隔离与凭据边界；MTask 的 D 不做无人值守，但应保留“人工确认 + 隔离环境”原则。

### 3.4 横向对比

| 产品 | 调度模型 | 自动触发 | 运行观测 | 重试/恢复 | 人工闸门 | 多平台 | 对 MTask 的主要借鉴 |
|---|---|---|---|---|---|---|---|
| agent-dispatch | Agent + session/job | 有 async/job | session、job、usage journal | 超时续 session | 权限/预算拦截 | Claude 为主 | Agent 注册表、错误分类、续跑 |
| superharness | 任务生命周期 + 队列 | watcher 后台 | 一屏 status、handoff | stale/失败清理 | 计划批准 | 多 CLI | 生命周期、队列、看板 |
| orchestmux | 多 CLI + tmux | 由协调 Agent 触发 | pane + 日志 | worker 死亡通知 | `--yolo` 显式授权 | Claude/Codex/Kimi 等 | 完成是事实、日志持久化 |
| baya-cli | 文本任务 → DAG | 手动 CLI | report | checkpoint/resume | 无中心审批 | 多 provider | DAG、provider 路由、恢复 |
| Hatchet | 队列 + worker | cron/event/webhook | Web UI + OTel | 内置重试/持久化 | 可扩展 | SDK 多语言 | 重试、worker 路由、观测 |
| Trigger.dev | run + queue | cron/webhook | run tracing/realtime | 幂等/重试/checkpoint | waitpoint | SDK | run 时间线、人工等待 |
| Windmill | 脚本/flow + worker | cron/webhook | 运行历史 | 重试/环境 | 评审后部署 | 多语言 | worker group、环境隔离 |
| n8n | 可视化 flow | 丰富 trigger | execution 历史 | 重试 | 人工审批节点 | 1500+ 集成 | 触发器目录、执行历史 |
| Dify | Agentic workflow | 应用触发 | 运行日志 | 重试/调试 | 人工调试 | 模型/工具 | 工具配置、日志 |
| Activepieces | pieces + flow | 触发/人工输入 | run 记录 | 重试 | human input | MCP 生态 | 适配器即插件 |
| Temporal | Workflow/Activity | 事件/定时 | 历史/重放 | 持久化重试 | signal | 多语言 | 持久化状态机（不引入） |
| OpenHands | Agent 后端 + session | automations | 会话/自动化 | 会话恢复 | 人工对话 | 多 Agent 后端 | 后端抽象、控制中心 |
| OpenSandbox | sandbox runtime | 无 | 执行 API | pause/resume | 凭据保管 | 多 SDK | D 的隔离边界 |

### 3.5 调研结论

1. **“派发”不是一次 HTTP 调用，而是一条可追踪的 attempt 生命周期。** 同款产品都把 `dispatch → run → status → result` 作为独立对象；MTask 目前只有 `POST /api/dispatch/task`，缺少 attempt 视图。
2. **手动与自动必须分开。** 同款产品的自动模式都有明确的范围、并发、冷却和审批；没有“所有任务一律自动推”的安全默认。
3. **自动触发要独立于“决策 LLM”。** superharness 的 watcher、Hatchet 的 scheduler、Trigger.dev 的 cron 都不依赖一个必须开启的 LLM 监督器；MTask 也不应把 B0 自动挂在 `supervisor.enabled` 后面。
4. **运行观测要成为一等能力。** 用户需要看到“已受理 / 运行中 / 已完成 / 失败 / 已转人工”，而不是一个 `ok: true/false`。
5. **人工闸门只用于高风险动作。** D 必须人工确认；A/B0 可以自动，但要有范围、冷却、重试上限。
6. **适配器应可注册、可诊断。** agent-dispatch 的 Agent 注册表、Activepieces 的 pieces、OpenHands 的后端抽象都说明：平台差异应放在 adapter，而不是散在业务逻辑里。
7. **不要照搬重型编排器。** Temporal/Hatchet 适合分布式多 worker；MTask 是单机 SQLite + Electron，本期只需借鉴状态机、重试、冷却和观测，不引入新服务。

### 3.6 研究结论到需求的映射

| 竞品启示 | 本 PRD 的落点 | 验证方式 |
|---|---|---|
| 派发是 attempt 生命周期 | FR-3 观测、`dispatch_attempts` 表、任务详情“最近派发” | AC-18、AC-21 |
| 手动与自动分离 | FR-1 手动入口、FR-2 自动策略 | AC-03、AC-09 |
| 自动触发独立于决策层 | FR-2.4 `DispatchScheduler` 独立运行 | AC-10 |
| 冷却、幂等、去重 | FR-2.5 冷却与幂等 | AC-11、AC-14 |
| 人工闸门只用于高风险动作 | FR-2.6 自动链路 `allowD=false`；D 人工确认 | AC-15 |
| 运行观测与错误分类 | FR-3 状态卡、错误码表 | AC-17、AC-23 |
| 批量入口应复用既有队列，而不是新建第二套派发引擎 | FR-1.5 待派发、§9.4 队列原生批量 | AC-29 |
| 队列、会话、任务各自有单一状态源 | §6.1.1 分工表、`queues.kind` | AC-27、AC-30 |
| 适配器可注册/可诊断 | FR-6 多平台边界；P3 adapterRegistry | 设计评审 |
| 不要过度编排 | §1.4 非目标、§13 风险 | 设计评审 |

### 3.7 既有调研补充（前序文档已覆盖，不重复展开）

以下项目来自 `docs/调研-MTask向WorkBuddy分发任务方案及开源参考.md`，作为本 PRD 的补充基线；它们不是本期直接实施对象，但影响 A/D 的技术边界：

| 项目 | 核心功能 | 用户流程/交互亮点 | 技术边界 | 对 MTask 可借鉴点 |
|---|---|---|---|---|
| MCP 规范 / TypeScript SDK | Streamable HTTP、会话、JSON-RPC、工具/资源原语 | 客户端初始化 → 工具调用 → 结果 | 需要 MCP 客户端与会话管理 | A 通道协议基线；工具与角色声明 |
| browser-use | 浏览器 Agent 循环：感知 → 决策 → Playwright/CDP 执行 → 验证 | 观察页面 → 规划 → 执行 → 复核 | 浏览器会话、模型成本、脆弱性 | D 的感知/执行分层；只作应急 |
| Playwright MCP | 用无障碍树 role/name/ref 驱动浏览器 | snapshot → click/type → re-snapshot | 需要 Playwright/浏览器环境 | D 优先无障碍树，不用像素坐标猜 |
| A2A | Agent Card、任务八态、Message/Part/Artifact、SSE | 发现 Agent → 发送任务 → 订阅状态 | 需要 A2A Server/Client | P3 跨厂商互操作储备，不本期实施 |
| LangGraph | Checkpointer、interrupt/resume、human-in-the-loop | 图执行 → 中断 → 人工 → 恢复 | 依赖 LangGraph 运行时 | 断点恢复、人工闸门的语义参考 |
| CrewAI | Crews（角色协作）+ Flows（事件驱动） | 角色分工 → 流程编排 → 汇总 | Python 生态、偏多 Agent 应用 | 多角色分工；MTask 不引入其运行时 |
| AutoGPT | 图执行、工作队列、节点生命周期 | 建图 → 入队 → worker 执行 | 平台较重、偏自主 Agent | 队列/节点状态语义参考 |
| E2B | 隔离沙箱、文件/进程 API、Code Interpreter | 创建 sandbox → 执行 → 取结果 | 云沙箱/运行时 | D/B 的隔离与文件边界 |
| Skyvern | LLM + Playwright 的浏览器工作流 | 定义工作流 → 执行 → 验证 | AGPL-3.0，商用需注意 | D 的“可重复工作流”思路 |
| Open Interpreter | OS 级 computer API（截图/鼠标/键盘） | 自然语言 → 本机操作 → 结果 | 权限/安全边界高 | 说明 D 的能力与风险边界 |
| agent-browser | 结构化浏览器 CLI（navigate/click/type/snapshot） | 命令 → 快照 → 操作 | 本机已装同名技能 | D 的 CLI 化备选，不替代 Playwright MCP |

---

## 4. 当前系统架构与约束

### 4.1 模块清单

| 模块 | 路径 | 当前职责 | 与 B0 的关系 |
|---|---|---|---|
| `TaskService` | `server/src/services/TaskService.ts` | 任务 CRUD、`markMonitorReady()`、`listMonitorReady()` | 自动候选来源 |
| `SupervisorService` | `server/src/services/SupervisorService.ts` | tick、会话停滞、就绪标记、LLM 决策、审计 | 当前不调用 B0；`enabled=false` 提前返回 |
| `PushDispatcher` | `server/src/services/PushDispatcher.ts` | B0→A→D 路由、状态、审计日志 | 手动 REST 入口；无自动调用 |
| `RelayDispatchService` | `server/src/services/RelayDispatchService.ts` | 建队列、提交、ticket、任务归位 | B0 复用 `dispatchTask(taskId, platform, toolIdOverride)` |
| `QueueService` | `server/src/services/QueueService.ts` | 队列/job 状态机、submit/poll、结果回写 | B0 的 queue/job/ticket 载体 |
| `AIService` | `server/src/services/AIService.ts` | adapter 调度、submit/poll、结果写回、异步失败回 A | B0 异步失败后的 A 归位在此 |
| `codebuddyGateway` | `server/src/adapters/codebuddyGateway.ts` | `POST /api/v1/runs`、SSE、run 状态缓存 | B0 协议适配器 |
| `ExecSessionService` | `server/src/services/ExecSessionService.ts` | 执行会话列表、停滞/失败、重派 | 重派走 `supervisor.relayToolId`，非 B0 |
| `dispatch` 路由 | `server/src/routes/dispatch.ts` | `GET /status`、`POST /task` | 现有唯一 B0 手动入口 |
| 设置页 | `web/src/pages/SettingsPage.tsx` + `SupervisorPanel.tsx` | 监督/中继配置 | 无 B0 配置 |
| 任务详情抽屉 | `web/src/components/TaskDetailDrawer.tsx` | 任务描述/结果/摘要/Git/阻塞/字段 | 无派发入口 |
| 队列页 | `web/src/pages/QueuePage.tsx` | 人工队列、任务池、批量发送 AI 工具 | 工具下拉可选中 `codebuddy-gateway`，具备“事实上的 B0 批量”；但无 B0 专用视图，且 B0 单条派发每次生成一条内部队列 |
| 执行会话页 | `web/src/pages/ExecSessionsPage.tsx` | 外部会话观测、重派 | 只读 `exec_sessions`；B0 不写该表，不能把 B0 当成执行会话 |

### 4.2 现有 B0 调用图

```text
┌──────────────────────────────┐
│ 任务详情 / 现有 REST 调用方   │
└──────────────┬───────────────┘
               │ POST /api/dispatch/task
               ▼
┌──────────────────────────────┐
│ PushDispatcher.dispatch      │
│  - resolveB0Tool()            │
│  - B0 → A → D                 │
└──────────────┬───────────────┘
               │ dispatchTask(taskId, 'codebuddy-gateway', tool.id)
               ▼
┌──────────────────────────────┐
│ RelayDispatchService         │
│  - QueueService.create(kind='dispatch') │
│  - QueueService.addJobs      │
│  - QueueService.submitAll    │
│  - armTaskRunning / armReady │
└──────────────┬───────────────┘
               │ AIService.buildSubmitter()
               ▼
┌──────────────────────────────┐
│ codebuddyGateway.submit      │
│  POST /api/v1/runs           │
│  → runId / ticket            │
│  SSE /api/v1/runs/:id/stream │
└──────────────┬───────────────┘
               │ QueueService.pollPending
               ▼
┌──────────────────────────────┐
│ AIService.buildPoller        │
│  - 写 handle_result          │
│  - 异步失败/超时 → armReady  │
└──────────────────────────────┘
```

### 4.3 数据模型现状

| 表 | 关键字段 | 与派发的关系 |
|---|---|---|
| `tasks` | `status`、`archived`、`ai_state`、`monitor_ready`、`monitor_preferred_platform`、`monitor_retry`、`exec_session_id` | 候选、去重、归位 |
| `queue_jobs` | `queue_id`、`task_id`、`tool_id`、`status`、`ticket`、`submitted_at`、`error` | B0 受理与轮询 |
| `queues` | `status`、`date`、`name`；建议新增 `kind` | 派发载体；`kind` 区分 `manual`（人工批量）/`dispatch`（B0/A 系统派发）/`relay`（监督中继） |
| `exec_sessions` | `platform`、`session_id`、`task_ids`、`status`、`progress`、`phase`、`last_heartbeat` | 外部执行观测 |
| `app_settings` | `key`、`value` | B0 工具、监督器、策略 KV |
| `ai_tools` | `type`、`endpoint`、`api_key_enc`、`enabled` | B0 工具来源 |
| `monitor_runs` | 决策与动作审计 | 监督审计，不是派发历史 |
| `LogService` | JSON 日志 | 现有 dispatch audit 只在日志 |

### 4.4 关键约束

1. **单机单进程 + SQLite**：没有分布式 worker；自动调度必须单飞，避免同一进程内重复派发。
2. **B0 是 Beta 网关**：`/api/v1/runs` 与 SSE 字段可能随 CodeBuddy 版本变化；endpoint 可能动态；默认口令鉴权。
3. **SSE 无历史回放**：订阅晚于完成会 404；适配器已在内存保存终态，进程重启后可能丢失，需要以 queue job 和审计记录兜底。
4. **A 的就绪门槛**：`markMonitorReady()` 只处理 `status=todo`、`archived=0`、`shelved=0`、`ai_state=''`、`monitor_ready=0`；`listMonitorReady()` 还要求 `ai_state=''` 和依赖二次校验。
5. **监督器提前返回**：`supervisorTick()` 在 `readEnabled()` 为 false 时 return；B0 自动不能挂在其后。
6. **D 必须人工**：现有 `escalateD()` 只写 `ai_state=failed`、`monitor_preferred_platform='d-gui'`，不自动开 GUI。
7. **重派语义**：`ExecSessionService.redispatchSession()` 用 `supervisor.relayToolId`，平台来自 `row.platform`；不能把它当作 B0 手动入口。
8. **队列自动完成**：`queue.autoCompleteTask` 默认开启；B0 同步成功可能直接把任务置 `done`（不等同于 `verified`）。
9. **UI 信息架构**：设置页有“偏好 / 数据 / 运维与诊断”三组；任务详情是抽屉；队列页已有任务池、批量发送 AI 工具与 `queue_jobs` 回执；执行会话是 `exec_sessions` 观测页。B0 每次派发都会 `QueueService.create('监督派发（platform）')`，生成一条独立队列；如果不做 `kind` 过滤，队列页会被内部派发队列污染。
10. **权限**：现有单层 `X-Access-Token`；按平台 token/角色仍在草案，不能假定已有多租户能力。

### 4.5 差距清单

| 差距 | 当前证据 | 影响 | 优先级 |
|---|---|---|---|
| 无手动 UI | 只有 `POST /api/dispatch/task` | 用户无法发现/使用 B0 | P0 |
| 无自动触发 | `SupervisorService` 不调用 `PushDispatcher` | B0 闲置 | P1 |
| 无策略配置 | 只有 `dispatch.b0ToolId`，无 UI | 自动无法安全上线 | P1 |
| 无候选预览 | 只能直接派发 | 无法防误推 | P1 |
| 无 attempt 记录 | 只有 `dispatch` 日志 | 失败不可解释 | P1 |
| 无任务级自动开关 | `monitor_preferred_platform` 未在 UI 暴露 | 无法按任务排除 | P1 |
| 无 B0 专用批量视图 | 队列页工具下拉已可选 `codebuddy-gateway`，但没有“待派发/B0 批量”视图，也没有把 B0 批量与普通工具队列区分 | 用户不知道可以批量走 B0；批量与单条语义混在一起 | P2 |
| B0 内部队列污染队列页 | `RelayDispatchService.dispatchTask()` 每次 `QueueService.create('监督派发（platform）')`，B0 单条派发也走这条 | 队列选择器出现大量“监督派发”队列，人工队列被淹没 | P0/P1 设计必须处理 |
| 执行会话与 B0 状态混淆 | `exec_sessions` 只由 `mtask_report_progress` 写入，B0 不写；B0 状态在 `queue_jobs` | 用户可能在执行会话页找不到 B0 run，或误以为“无会话=未派发” | P0 文案/IA 必须区分 |
| 任务池“暂停”对 B0 不成立 | 任务池读 `ai_state='running'`，B0 任务会出现在其中；“暂停”实际是 `shelve`，不取消 B0 | 用户以为暂停能终止 B0 执行 | P1 增加 B0 标识与“移出池”文案 |
| 无 B0 连接测试 | 配置后只能靠实际任务试错 | 排障成本高 | P1 |
| `auto` 当前会转 D | `PushDispatcher` 末端调用 `escalateD` | 自动策略可能把任务标 failed | P0 设计必须处理 |
| 异步失败回 A 无自动冷却 | `AIService` 直接 `armReady` | 自动调度可能重复派发 | P1 |
| 重派与 B0 混淆 | `ExecSessionService` 走 relay tool | 用户误以为重派触发 B0 | P0 文案/IA 必须区分 |

---

## 5. 范围边界

### 5.1 In Scope

- 单任务手动派发（任务详情抽屉）。
- 自动派发策略配置与独立调度器。
- B0 工具选择、连接测试、状态卡。
- 派发 attempt 观测、失败原因、fallback 链路。
- A 兜底与 D 人工确认的语义展示。
- 任务级自动派发开关（P1）。
- 队列页“待派发”与 B0 批量（复用人工队列，P2）。
- 队列页“派发记录”视图（P1）。
- 数据迁移、接口、权限、审计、测试与文档。

### 5.2 Out of Scope

- 企业版 Managed Agents / ACP / A2A 的完整接入。
- Qoder、Trae、豆包、Codex 的本地 run 网关适配。
- 远程多租户控制面、云端 worker。
- 通用可视化工作流编辑器。
- D 的无人值守自动化。
- 计费、配额、组织权限体系。
- 把 B0 改造成通用 A2A server。

### 5.3 平台矩阵

| 平台 | B0（主动推送） | A（MCP 拉取） | CLI Process Adapter | 本期结论 |
|---|---|---|---|---|
| WorkBuddy / CodeBuddy 桌面 | 可用（本地 run 网关） | 可用（MCP + Automation） | 可选 | **本期主链路** |
| Qoder | 不适用（未发现 `/api/v1/runs`） | 需要 MCP 客户端 + 触发入口 | 可研究 `qoder -p` | 不套 B0；A 需补环境 |
| Trae | 不适用（无 headless prompt） | 需要平台内 MCP + 定时器 | `trae` 只是编辑器 CLI | 不套 B0；A 阻塞 |
| 豆包 / 豆包工作 | 不适用（无本地网关） | 需要自定义 MCP 连接器 | 平台 API 待确认 | 不套 B0；A 需配置 |
| Codex | 不适用（无 `/api/v1/runs`） | MCP 可用但 provider 需可达 | `codex exec` 可无头 | 后续 CLI Adapter |

### 5.4 假设

- B0 工具类型固定为 `codebuddy-gateway`；`dispatch.b0ToolId` 指向 `ai_tools` 中 enabled 的工具。
- 一个 MTask 实例在单机运行；自动调度器只在主进程启动。
- 任务以 `taskNo` 或内部 id 唯一标识；`taskNo` 全局唯一。
- 自动派发不替换现有 A/D 生命周期；只在其前面增加 B0 主动推送机会。

---

## 6. 功能需求

### 6.1 信息架构与入口

| 层级 | 位置 | 作用 | 优先级 |
|---|---|---|---|
| 任务级 | 任务详情抽屉顶部“派发”按钮 | 单条任务立即派发 | P0 |
| 全局级 | 设置 → 运维与诊断 → “派发策略”页签 | 自动策略、B0 工具、状态、审计 | P1 |
| 批量级 | 队列页“待派发”视图 | 多选任务加入人工队列，按队列统一发送 | P2 |
| 记录级 | 队列页“派发记录”视图 | 查看 B0/A 单条/自动派发产生的内部 queue/job，不污染人工队列 | P1 |
| 观测级 | 执行会话页 | 仅观测 A/D 等外部会话与重派，不放 B0 按钮 | P0 |

**交互原则：**

- UI 上不直接写“B0”作为主标签；主标签用“CodeBuddy 网关”，技术名 B0 放在副文案/tooltip。
- “派发”与“重派”分开：派发是主动推送；重派是失败会话恢复，走 `RelayDispatchService`。
- 所有失败必须显示“下一步”：去配置、重试、查看日志、转人工。
- 自动开关旁必须有“暂停自动派发”的显式状态，不能只有一个小开关。

### 6.1.1 与队列、执行会话的职责分工

**结论：不新增顶层“派发”菜单。** 单条派发放任务详情；批量编排放队列；外部会话观测放执行会话；自动策略放设置。四个工作面各自回答一个问题，避免同一状态在多个页面重复出现。

| 工作面 | 回答的问题 | 拥有 | 不拥有 | 主数据源 |
|---|---|---|---|---|
| 任务详情（任务列表只负责定位） | “这一条现在能不能派、派到哪了？” | 单条派发按钮、通道选择、最近 attempts、结果与失败原因、跳转队列/会话 | 批量编排、全局策略、运行中槽位管理 | `tasks` + `dispatch_attempts` |
| 队列页 | “这一批任务按什么顺序、用哪个工具发？” | 人工队列创建、任务与工具选择、批量排序、发送、失败重试、job 回执 | 单条快捷派发、自动策略、外部会话心跳 | `queues` + `queue_jobs` |
| 队列页内的“任务池” | “现在有哪些任务在跑、B0 在不在跑、池满没满？” | 运行中槽位、并行上限、排队深度、搁置入口（B0 文案“移出池”，不终止网关侧 run） | 终止 B0/Agent 执行、修改派发通道 | `tasks.ai_state` + `monitor_preferred_platform` 的运行视图 |
| 执行会话页 | “外部 Agent 会话活着吗、卡住没、能否重派？” | `active/stalled/failed/done` 会话看板、心跳、阶段、进度、重派 | B0 run 状态、队列 job 状态、自动策略 | `exec_sessions` |
| 设置 → 派发策略 | “全局要不要自动派、什么范围、什么节奏？” | 自动开关、B0 工具、项目范围、冷却、每轮上限、候选预览、审计 | 单条立即派发、队列编排、会话重派 | `app_settings` + `dispatch_attempts` 汇总 |

**四条不可混淆的边界：**

1. **单条 vs 批量**：任务详情只做单条；需要多选时，跳到队列页的“待派发”选择器。队列页不提供“在列表行直接派发”的入口，避免和单条按钮重复。
2. **队列只展示人工编排队列**：B0 单条/自动派发产生的 `kind=dispatch` 内部队列默认不进入队列下拉；需要查记录时走“派发记录”视图或任务详情 attempts，不把内部实现暴露成人工队列。
3. **执行会话不伪造 B0 会话**：P0/P1 不把 B0 `runId` 写进 `exec_sessions`。B0 运行状态看 `queue_jobs` + `dispatch_attempts`；只有 A/D 等通过 `mtask_report_progress` 上报的外部会话才出现在执行会话页。若未来要展示 B0 进度，必须单独设计 `platform=codebuddy-gateway` 的上报与“重派”动作，不能复用中继重派。
4. **任务池只观测，不是取消台**：B0 任务会因 `ai_state='running'` 出现在任务池；这里只显示“B0 执行中”标识，不提供“暂停/终止”假动作。现有“暂停”实际是 `shelve`（移出分发池），对已经受理的 B0 run 无效，文案必须写成“移出池”，并提示“不会终止网关侧执行”。

**状态源单一原则：**

| 视图 | 读取 | 不读取/不推导 |
|---|---|---|
| 任务详情“最近派发” | `dispatch_attempts`、任务状态 | 不从 `exec_sessions` 推断 B0 成功/失败 |
| 队列页 job 回执 | `queue_jobs`（`queued/sending/success/failed/timeout`） | 不把 `tasks.ai_state` 当作 job 状态 |
| 执行会话页 | `exec_sessions`（`active/stalled/failed/done`） | 不把 `queue_jobs.sending` 当作会话心跳 |
| 任务池 | `tasks.ai_state='running'` | 不把“池里有任务”当作“B0 已成功” |
| 设置状态卡 | `dispatch.status()` + 汇总 attempts | 不返回任务正文、token、网关口令 |

**三条派发链路的落点：**

```text
单条派发：
  任务详情 → POST /api/dispatch/task
    → 内部 queue(kind=dispatch) → queue_job → B0/A/D
    → 任务详情 attempts 显示结果；内部 queue 不在人工队列下拉中出现

批量派发：
  队列页“待派发” → 选择任务 + 选择 B0 工具
    → 加入人工 queue(kind=manual) → queue_job（多条）
    → “发送队列” → B0/A 工具
    → 队列页 job 回执；任务详情只显示“属于队列 Q”的链接

自动派发：
  DispatchScheduler → dispatchAuto(task)
    → 内部 queue(kind=dispatch) → queue_job → B0/A
    → dispatch_attempts + 设置页状态卡；不进入人工队列
```

**队列页“待派发”的定位：**

- 它不是第三套派发引擎，只是“任务选择器 + 预填 B0 工具”的批量入口。
- 选中任务后，动作是 **加入队列**，不是逐条调用 `POST /api/dispatch/task`；随后由“发送队列”统一提交。这样排序、暂停、失败重试、回执都复用 `QueueService`，不会出现“队列页一套、派发页一套”的双状态。
- 如果用户要“一键批量立即发”，可以在创建队列后自动执行“发送队列”，但仍生成一条 `kind=manual` 的队列，保留 job 回执与失败重试能力。

**执行会话页的定位：**

- 保留现有“重派”按钮，但 tooltip 明确：“仅对停滞/失败的外部会话，经 `supervisor.relayToolId` 中继重派；不是 B0 派发”。
- 若任务详情显示 B0 `running`，不要求执行会话页出现卡片；任务详情 attempts 里显示 `queueId/jobId/ticket`，并提供“查看队列 job”链接。
- 若未来 B0 adapter 上报 `exec_sessions`，必须新增 `platform=codebuddy-gateway` 的会话卡与“B0 重派”动作；在未实现前，不在 UI 上暗示 B0 会话存在。

### 6.2 FR-1 手动单任务派发（P0）

#### FR-1.1 任务详情“派发”按钮

- 位置：`TaskDetailDrawer` 顶部徽标区右侧，或徽标区下方独立操作条。
- 默认状态：
  - `status=todo`、`archived=0`、`ai_state!='running'` 时可点；
  - 其他状态按钮可见但禁用，tooltip 说明原因（已完成/已归档/执行中）。
- 按钮文案：`派发`；展开菜单后显示：
  - `自动（CodeBuddy → MCP → 人工）`
  - `仅 CodeBuddy 网关（B0，失败不回退）`
  - `仅 MCP 就绪池（A）`
  - `D 应急（需人工确认）`
- 菜单顶部显示 B0 状态：
  - 已配置：工具名 + endpoint 主机（不显示口令）；
  - 未配置：`未配置 CodeBuddy 网关工具` + “去配置”链接（跳设置 `dispatch` 页签）。
- 交互：
  - 选“自动”时，如果 B0 未配置，仍允许提交，但文案说明“将直接走 A/D”；
  - 选“仅 B0”时，B0 未配置则禁用提交，避免用户误以为已派发；
  - 选“D”时弹出二次确认：显示“不会自动执行 GUI，只标记人工确认”。

#### FR-1.2 前端前置校验

- 与 `PushDispatcher.ensureDispatchable` 同口径：
  - `archived=1` → 禁用；
  - `status!='todo'` → 禁用；
  - `ai_state='running'` → 禁用。
- 旧版服务端未返回 `status` / `archived` 时，前端按旧行为回退，不误报“不可派发”。
- 请求期间按钮 loading，禁止重复点击。

#### FR-1.3 结果回显

- 请求 `POST /api/dispatch/task`，响应为 `DispatchResult`（含 `attempts`）。
- 结果区按通道展示：
  - `B0`：已受理（ticket/runId）、同步完成、失败原因；
  - `A`：已退回就绪池；
  - `D`：已标记人工确认，未自动执行。
- 不使用单一“成功/失败”toast；必须显示“最终落点”和“降级原因”。
- 成功后刷新：
  - 任务详情状态；
  - 任务列表行；
  - 执行会话页（仅当该通道确实产生 `exec_sessions` 记录；B0 不伪造会话）；
  - 队列页回执链接：`kind=dispatch` 的内部队列只打开只读 job drawer，不跳人工队列列表。

#### FR-1.4 任务级自动开关（P1）

- 在派发菜单中增加：
  - `允许自动派发：跟随项目 / 开启 / 关闭`
- 对应 `tasks.dispatch_auto`：
  - `NULL` = 跟随全局；
  - `0` = 禁止自动；
  - `1` = 允许自动。
- 默认 `NULL`，不改变存量任务行为。
- 关闭时只影响自动调度，不影响手动派发。

#### FR-1.5 队列页“待派发”与 B0 批量（P2）

- 队列页新增“待派发”视图，作为**任务选择器**，不是新的派发引擎：
  - 列出 `status=todo`、`archived=0`、`ai_state!='running'`；
  - 可选项目过滤；
  - 显示是否允许自动、上次派发状态；
  - B0 工具选项只列 `type=codebuddy-gateway` 且 enabled 的工具；默认预选 `dispatch.b0ToolId`。
- 批量动作是 **加入队列**，不是逐条调用 `POST /api/dispatch/task`：
  - 新建或选择一个 `kind=manual` 人工队列；
  - 通过 `POST /queues/:id/jobs` 批量加入任务 + B0 工具；
  - 用户确认后走 `POST /queues/:id/submit`，由 `QueueService` 统一提交；
  - job 回执、失败重试、队列暂停全部复用现有队列语义。
- 一条失败不阻断其余；汇总条显示 `成功/失败/跳过` 数量。
- 如果提供“一键批量立即发”快捷动作，仍先创建 `kind=manual` 队列并落 job，再 submit；不绕过队列直接循环单条 API。
- 队列页默认只显示 `kind=manual`；`kind=dispatch/relay` 的内部队列进入“派发记录”视图，不进入人工队列下拉。

#### FR-1.6 队列页“派发记录”（P1）

- 在队列页增加二级视图 `派发记录`，默认展示 `kind=dispatch/relay` 的 queue/job：
  - 任务号、项目、通道（B0/A/D）、状态（queued/sending/success/failed/timeout）、ticket、创建时间；
  - 支持按任务号、项目、通道、状态、时间范围过滤；
  - 每条记录提供“打开任务”“查看 job 详情”；失败项提供“重试/重新派发”。
- 与任务详情的“最近派发”共用 `dispatch_attempts` 的展示口径，但队列 job 的权威状态仍来自 `queue_jobs`。
- 该视图不展示人工队列；人工队列仍在默认“队列”视图。

#### FR-1.7 B0 连接测试（P1）

- 设置页“派发策略”提供 `测试连接`：
  - 调用 `POST /api/dispatch/test`；
  - 检查 endpoint 可达、鉴权、`/api/v1/runs` 是否可访问；
  - 不创建真实任务、不发送真实任务内容；只发探测请求（如 `/api/v1/auth/status` 或 health）。
  - 结果展示：`可连接 / 鉴权失败 / 端口不通 / 版本不兼容`。
- 口令永不回显，只显示“已配置/未配置”。

### 6.3 FR-2 自动派发策略（P1）

#### FR-2.1 设置页签

在 `web/src/ui/settingsTabs.ts` 的“运维与诊断”组新增：

```text
监督与审计（现有）
派发策略（新增）
内网穿透
日志
```

页签 key：`dispatch`；渲染 `DispatchPolicyPanel`。  
理由：自动派发是全局运营策略，不属于单个任务，也不属于“监督审计”的 LLM 决策。

#### FR-2.2 配置字段

| 字段 | 配置键 | 默认 | 说明 |
|---|---|---|---|
| 自动派发总开关 | `dispatch.autoEnabled` | `0` | 0=关，1=开；关闭后下一轮不取新任务 |
| 默认通道 | `dispatch.defaultChannel` | `auto` | `auto` 或 `b0`；不允许 `d` |
| B0 工具 | `dispatch.b0ToolId` | 空 | 仅列出 `type=codebuddy-gateway` 且 enabled 的工具 |
| 项目范围 | `dispatch.scopeProjectIds` | 空=不启用 | JSON 数组；空数组表示不启用，避免“空=全量”误推 |
| 触发方式 | `dispatch.trigger` | `ready` | `ready`=就绪标记后；`interval`=定时扫描 |
| 扫描间隔 | `dispatch.intervalMs` | `30000` | 与 supervisor tick 可共用节奏，但独立调度 |
| 冷却窗口 | `dispatch.cooldownMs` | `300000` | 同一任务两次自动派发最小间隔 |
| 每轮上限 | `dispatch.maxPerTick` | `5` | 防一次扫太多 |
| 最大尝试 | `dispatch.maxAttempts` | `3` | 超过转人工/告警，不无限重试 |
| A 降级 | `dispatch.allowFallbackA` | `1` | B0 失败是否归位 A |
| 自动 D | `dispatch.allowAutoD` | `0` | 硬编码为 0；UI 只读展示“D 仅人工” |
| attempt 保留 | `dispatch.retentionDays` | `30` | 审计清理 |

#### FR-2.3 自动候选条件

自动调度器只处理同时满足以下条件的任务：

```text
status = 'todo'
archived = 0
shelved = 0
ai_state = ''                 -- 不自动接管 failed/unread/running
monitor_ready = 1             -- 依赖已满足，且已由 markMonitorReady 判定
project_id ∈ dispatch.scopeProjectIds（空数组=不启用）
dispatch_auto ∈ {NULL, 1}    -- 0 明确禁止
monitor_preferred_platform IS NULL
  OR LOWER(TRIM(monitor_preferred_platform)) = 'codebuddy-gateway'
dispatch_last_at 为空或早于 now - cooldownMs
```

说明：

- 候选必须“就绪”，不能绕过依赖直接推。
- `ai_state` 只接受空串，避免把 `failed`/`unread` 任务自动重推。
- 若任务被显式标记给 `workbuddy`、`trae` 等其他平台，B0 自动不得抢占。
- `dispatch_auto=0` 是硬闸；即使全局开启也不派发。

#### FR-2.4 自动调度器

- 新增 `DispatchScheduler`（或 `PushDispatcher.autoTick()`）：
  - 启动时读取配置；配置变更后热重载；
  - 单飞锁，避免重入；
  - 每轮最多 `dispatch.maxPerTick` 条；
  - 逐条串行调用 `PushDispatcher.dispatchAuto(task, { allowD: false })`，避免并发压垮网关；
  - 写 `dispatch_attempts`；
  - 更新 `dispatch_last_at` / `dispatch_last_state`；
  - 失败按 `dispatch.maxAttempts` 限制。
- **独立性**：
  - 不依赖 `supervisor.enabled`；`supervisor.enabled=false` 时自动派发仍可运行；
  - 若复用 `SupervisorService.startScheduler`，必须在 `readEnabled()` 提前返回之前调用 `DispatchScheduler.tick()`，或使用独立 `setInterval`；
  - 自动调度不调用 LLM，不消耗监督器 token 预算。
- **与就绪标记的顺序**：
  - 先 `markMonitorReady()`，再取候选；
  - 若 `readyMarkEnabled=0`，自动策略应提示“就绪标记已关闭，自动候选为空”，而不是反复空扫。

#### FR-2.5 冷却、幂等与去重

- 同一任务在 `cooldownMs` 内不重复自动派发。
- 手动派发也写 `dispatch_last_at`，自动调度应尊重手动派发后的冷却，避免“手动刚推、自动又推”。
- 进程重启后：
  - `dispatch_last_at` 持久化；
  - `queue_jobs` 中 `sending` + `ticket` 继续由 `pollPending` 收敛；
  - 自动调度不因重启立刻重推 `sending` 任务。
- 请求幂等键：`taskNo + channel + timeBucket` 或 `taskNo` 作为业务幂等键；B0 侧若支持 idempotency key，必须透传。

#### FR-2.6 自动策略的 D 边界

- 自动链路不允许调用 `escalateD()` 的自动执行分支；D 只允许：
  - 标记 `d-gui` 待人工；
  - 在设置/任务详情显示“需人工确认”；
  - 由人工点击 D 并按确认弹窗执行。
- 因此不能直接复用当前 `PushDispatcher.dispatch(task, 'auto')` 的完整末端；需要：
  - `dispatchAuto(task, { allowD: false })`，或
  - `dispatch(task, channel, options)`，由 `allowD` 控制末端。

#### FR-2.7 预览与试运行

- 设置页提供 `预览候选`：
  - `GET /api/dispatch/candidates?projectId=&limit=`；
  - 只读，不派发；
  - 显示任务号、标题、项目、优先级、上次派发时间、预计是否会被冷却跳过。
- 提供 `立即跑一轮`：
  - `POST /api/dispatch/auto/run`，支持 `dryRun=true`；
  - dry-run 返回“将会派发哪些”，不写 attempt、不改任务；
  - 实际运行需要二次确认，并显示本轮上限。

#### FR-2.8 暂停与恢复

- 设置页主开关关闭后：
  - 不再取新候选；
  - 已在途的 B0 run 不受影响；
  - 状态卡显示“已暂停”。
- 提供 `暂停自动派发` 快捷按钮（P1），不必进入设置深层页。
- 恢复时从下一轮开始，不补跑暂停期间的任务；如需补跑，由“预览候选 → 立即跑一轮”显式执行。

### 6.4 FR-3 观测与审计

#### FR-3.1 状态卡

设置页“派发策略”顶部展示：

```text
CodeBuddy 网关（B0）：已配置 / 未配置     [测试连接]
MCP 就绪池（A）：N 条待拉取
D 应急：N 条待人工确认
自动派发：运行中 / 已暂停 / 配置不完整
最近运行：2026-11-17 12:30:00    下一轮：12:30:30
本日：成功 N / 失败 N / 跳过 N
```

数据来自 `GET /api/dispatch/status` 扩展字段，不返回 token。

#### FR-3.2 任务详情“最近派发”

- 在任务详情抽屉增加折叠区 `最近派发`（P1）：
  - 时间、通道、状态、queue/job/ticket、fallback reason；
  - 最多 10 条；
  - 链接到队列回执 / 执行会话 / 日志。
- 无记录时显示“尚未派发”；手动派发后立即刷新。

#### FR-3.3 审计

- 每次派发写 `dispatch_attempts`：
  - `taskNo`、`channel`、`state`、`queueId`、`jobId`、`ticket`、`fallbackReason`、`detail`、`actor`（`manual` / `auto` / `api`）、`createdAt`。
- `dispatch_attempts` 保留 `dispatch.retentionDays`；清理任务每天一次。
- 日志仍保留结构化 JSON，但不再作为唯一查询源。
- 审计中不得包含 API key、gateway password、任务正文中的密钥。

### 6.5 FR-4 异常与降级语义

| 场景 | 期望行为 | 用户可见 |
|---|---|---|
| B0 工具未配置 | 仅 B0：不派发；自动：跳过并显示配置原因 | “未配置 CodeBuddy 网关工具”，链接到设置 |
| B0 端口不通 | 仅 B0：失败；自动：按策略回 A 或保持 todo | 显示 endpoint 主机与网络错误，不显示口令 |
| B0 鉴权失败 | 不重试；提示核对网关口令 | “鉴权失败”，链接到工具配置 |
| B0 提交超时 | 保持 `ready` 或 A；写 attempt | “提交超时，未受理” |
| B0 已受理但异步失败/超时 | `AIService` 归位 A；写 fallback | “B0 已受理但结果失败，已退回 MCP 就绪池” |
| A 不可用 | 保持 todo，不静默消失 | “未进入就绪池，请检查就绪标记/依赖” |
| 自动链路 A 也失败 | 不自动 D；标记需人工/告警 | “自动派发失败，需人工处理” |
| 任务已归档/已完成 | 拒绝派发 | “任务已归档/已完成，不能派发” |
| 任务 running | 拒绝派发 | “任务执行中，避免双跑” |
| 重复点击/重复调度 | 前端 loading + 服务端冷却/幂等 | “已受理，请勿重复提交” |
| SSE 断流 | `poll` 按 `active=false` 判失败；A 归位 | “结果流断开，已退回 A/需人工” |
| 进程重启 | 队列 `sending` 任务继续 poll；不自动重推 | “恢复检查中” |
| D 被请求 | 只标记人工，不自动开 GUI | “已转人工确认” |

### 6.6 FR-5 权限与安全

- `GET/PUT /api/dispatch/config` 仅管理员/本机用户可用；沿用现有 `accessTokenGuard`。
- B0 endpoint 只允许：
  - `127.0.0.1` / `localhost`；
  - 或显式白名单内网地址；
  - 远程必须 HTTPS。
- 网关口令只放 `Authorization: Bearer`，不写日志、不回显、不进 URL。
- 任务派发载荷沿用 `QueueService.snapshotTaskContext`；自动派发不得额外读取与本任务无关的密钥。
- 结果回传不得包含 token/密码；前端展示前做敏感字段遮蔽。
- 按平台具名 Token / 角色（`docs/九期-按平台token与角色隔离-草案.md`）作为 P2/P3 前置；本期至少记录 `actor` 与 `platform`，为后续审计留字段。

### 6.7 FR-6 多平台扩展边界

- `B0` 只绑定 `codebuddy-gateway`。
- 其他平台不满足 B0 条件时：
  - 不显示“B0 可用”；
  - A 走 `mtask_list_ready_tasks` + `mtask_claim_task`；
  - 有 headless CLI 的平台走 `cli-process` adapter（后续）；
  - D 仅人工。
- 自动策略的 `defaultChannel` 本期允许 `auto` / `b0`；扩展平台时再加 `adapter` 选择，不把平台名硬编码进 UI。
- `PushDispatcher` 应保留 `channel` 抽象；未来以 `adapterRegistry` 注册 `codebuddy-gateway`、`cli-process`、`acp`、`webhook`。

---

## 7. 非功能需求

| 类别 | 要求 | 验收方式 |
|---|---|---|
| 性能 | 手动派发 API 在 1s 内返回“已受理/失败”（不含网关实际执行）；自动一轮候选查询 <500ms（1 万任务） | API 压测/日志耗时 |
| 吞吐 | 自动每轮默认最多 5 条，串行提交；可配置 1~20 | 调度器测试 |
| 可靠性 | 冷却窗口内不重复；进程重启不重复提交；B0 失败可归位 A | 故障注入/重启测试 |
| 可观测 | 每次 attempt 有状态、ticket、fallback；状态卡可查 | API/DB 断言 |
| 安全 | 无 token 泄漏；endpoint 白名单；配置接口受保护 | 安全测试/日志扫描 |
| 兼容 | 老库自动迁移；旧 token 行为不变；旧 UI API 不破坏 | 迁移测试 |
| 可维护 | 自动调度与监督器解耦；adapter 与业务路由分离 | 代码评审 |
| 可测试 | 提供 fake gateway；dry-run；无真实外部依赖 CI | 集成测试 |
| 可访问性 | 按钮有 aria-label/title；禁用原因可读；键盘可达 | UI 检查 |
| 数据保留 | attempt 默认 30 天；可配置 | 清理任务测试 |
| 兼容端口 | 生产 `39877` / 开发 `39876`；不把临时预览端口写回配置 | 部署检查 |

---

## 8. 数据与接口影响

### 8.1 数据模型变更

#### 8.1.1 `tasks` 增量列（P1）

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dispatch_auto` | INTEGER | NULL | NULL=跟随全局；0=禁止自动；1=允许自动 |
| `dispatch_last_at` | TEXT | NULL | 最近一次派发尝试时间（ISO） |
| `dispatch_last_state` | TEXT | `''` | `running/done/ready/manual/failed` |

迁移方式：`ensureColumn()` 幂等补列；老任务 `dispatch_auto=NULL`，不改变现有行为。

#### 8.1.2 `dispatch_attempts` 新表（P1）

```sql
CREATE TABLE IF NOT EXISTS dispatch_attempts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  task_no         TEXT,
  channel         TEXT NOT NULL,        -- B0 / A / D
  state           TEXT NOT NULL,        -- running/done/ready/manual/failed
  queue_id        TEXT,
  job_id          TEXT,
  ticket          TEXT,
  fallback_reason TEXT DEFAULT '',
  detail          TEXT DEFAULT '',
  actor           TEXT NOT NULL,        -- manual / auto / api
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_task_time
  ON dispatch_attempts(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_time
  ON dispatch_attempts(created_at DESC);
```

说明：

- 不替代 `queue_jobs`；`queue_jobs` 仍是队列执行状态的唯一来源，`dispatch_attempts` 是跨通道的审计/展示层。
- 只存展示与审计字段，不存任务正文、不存 token。

#### 8.1.3 `queues` 增量列（P1/P2）

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `kind` | TEXT | `'manual'` | `manual`=人工编排队列；`dispatch`=B0/A 单条/自动派发的内部队列；`relay`=监督中继队列 |

迁移方式：SQLite 侧用 `ensureColumn('queues','kind',"TEXT NOT NULL DEFAULT 'manual'")` 幂等补列；以下 SQL 为等价口径：

```sql
ALTER TABLE queues ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
CREATE INDEX IF NOT EXISTS idx_queues_kind_date ON queues(kind, date DESC, created_at DESC);
UPDATE queues SET kind='relay'
 WHERE kind='manual' AND name LIKE '监督派发（%';
```

兼容策略：

- 存量队列全部回填 `manual`，保持队列页现状。
- 存量 `name LIKE '监督派发（%'` 的队列做一次性回填 `kind='relay'`（仅迁移用名称识别，运行时不再依赖名称）。
- `QueueService.create(name, date, kind='manual')` 新增可选参数；旧调用默认 `manual`。
- `RelayDispatchService.dispatchTask()` 增加可选 `queueKind`：B0/A 单条/自动传 `dispatch`；`ExecSessionService.redispatchSession()` 传 `relay`。
- `/api/queues` 默认只返回 `manual`；`kind=all` 才返回内部队列，供“派发记录”使用。
- 不对 `queue_jobs` 做结构变更；job 仍按 `queue_id` 读取。

#### 8.1.4 `app_settings` 配置键

见 §6.3 FR-2.2；均为 KV，不新增配置表。

### 8.2 API 变更

#### 8.2.1 现有接口

| 方法 | 路径 | 变更 |
|---|---|---|
| GET | `/api/dispatch/status` | 增加 `auto` 配置/运行状态、`b0` 诊断字段；不返回 token |
| POST | `/api/dispatch/task` | 保持兼容；增加可选 `idempotencyKey`；响应增加 `attemptId`（P1） |
| GET | `/api/queues` | 默认只返回 `kind=manual`；`?kind=all` 才返回内部派发队列（P1） |
| GET | `/api/queues/:id` | 支持读取 `kind=dispatch/relay` 的只读详情，供“派发记录”抽屉使用 |
| POST | `/api/queues` | 增加可选 `kind`，默认 `manual`；公开路由只允许创建 `manual`，内部队列由服务层创建 |
| GET | `/api/pool/status` | 增加 `platform`/`channel` 字段（取自 `monitor_preferred_platform`），供任务池显示 B0/MCP/D 标识 |

**POST /api/dispatch/task 请求：**

```json
{
  "taskNo": "T05808",
  "channel": "b0",
  "idempotencyKey": "T05808:manual:202611171230"
}
```

**响应（保持现有 DispatchResult 结构，新增字段）：**

```json
{
  "ok": true,
  "taskNo": "T05808",
  "state": "running",
  "channel": "B0",
  "attempts": [
    {
      "channel": "B0",
      "ok": true,
      "state": "running",
      "detail": "已推送至 codebuddy-gateway 并拿到回执，等待轮询收敛",
      "queueId": "...",
      "jobId": "...",
      "ticket": "..."
    }
  ],
  "attemptId": "..."
}
```

#### 8.2.2 新增接口

| 方法 | 路径 | 用途 | 优先级 |
|---|---|---|---|
| GET | `/api/dispatch/config` | 读取自动策略与 B0 配置（脱敏） | P1 |
| PUT | `/api/dispatch/config` | 保存自动策略；服务端校验范围/上限 | P1 |
| GET | `/api/dispatch/candidates?projectId=&limit=` | 预览自动候选，只读 | P1 |
| POST | `/api/dispatch/auto/run` | 立即跑一轮；`dryRun` 支持试运行 | P1 |
| POST | `/api/dispatch/test` | 测试 B0 连接/鉴权，不发送任务 | P1 |
| GET | `/api/dispatch/attempts?taskNo=&limit=` | 查询任务派发历史 | P1 |

> 批量派发**不新增** `POST /api/dispatch/batch`。P2 复用现有 `POST /api/queues` + `POST /api/queues/:id/jobs` + `POST /api/queues/:id/submit`，把批量入口固定在队列语义上，避免出现“队列一套、派发一套”的双状态。

**`GET /api/dispatch/status` 响应（扩展后）：**

```json
{
  "defaultChannel": "auto",
  "order": ["B0", "A", "D"],
  "b0": {
    "configured": true,
    "toolId": "...",
    "toolName": "CodeBuddy 本地网关",
    "endpoint": "http://127.0.0.1:39879",
    "reason": null
  },
  "a": {
    "supervisorEnabled": false,
    "readyTasks": 12,
    "note": "..."
  },
  "d": {
    "manualOnly": true,
    "failedTasks": 3,
    "platform": "d-gui"
  },
  "auto": {
    "enabled": true,
    "defaultChannel": "auto",
    "b0ToolId": "...",
    "scopeProjectIds": ["e4d8b042-0808-43df-bb11-a630e8ee9e56"],
    "trigger": "ready",
    "intervalMs": 30000,
    "cooldownMs": 300000,
    "maxPerTick": 5,
    "lastRunAt": "2026-11-17T12:30:00+08:00",
    "nextRunAt": "2026-11-17T12:30:30+08:00",
    "candidates": 12,
    "today": { "success": 4, "failed": 1, "skipped": 7 }
  }
}
```

**`PUT /api/dispatch/config` 校验：**

- `scopeProjectIds` 必须是存在且未归档项目；空数组=不启用（不是全量）。
- `defaultChannel` 仅 `auto/b0`。
- `maxPerTick` 1~20；`cooldownMs` 1 分钟~24 小时；`maxAttempts` 1~10。
- `allowAutoD` 强制为 false；传入 true 返回 400。
- `b0ToolId` 必须存在、`type=codebuddy-gateway`、`enabled=1`；否则 400。
- 不返回 `api_key_enc`；endpoint 只返回 host/path，不返回 query 中的口令。

#### 8.2.3 错误结构

现有路由使用 `{ "error": "..." }`；建议新增 `code` 便于 UI 分支：

```json
{
  "error": "B0 网关鉴权失败",
  "code": "B0_AUTH_FAILED",
  "detail": "HTTP 401，请核对工具中的网关口令"
}
```

错误码建议：

```text
B0_NOT_CONFIGURED
B0_AUTH_FAILED
B0_UNREACHABLE
B0_TIMEOUT
B0_STREAM_LOST
TASK_NOT_FOUND
TASK_NOT_TODO
TASK_ARCHIVED
TASK_RUNNING
A_NOT_READY
D_MANUAL_ONLY
DISPATCH_DUPLICATE
CONFIG_INVALID
PROJECT_SCOPE_EMPTY
QUEUE_SUBMIT_FAILED
```

### 8.3 前端改动点

| 文件 | 改动 |
|---|---|
| `web/src/ui/settingsTabs.ts` | 新增 `dispatch` 页签，放入“运维与诊断” |
| `web/src/pages/SettingsPage.tsx` | `active === 'dispatch'` 时渲染 `DispatchPolicyPanel` |
| `web/src/pages/DispatchPolicyPanel.tsx` | 新组件：状态卡、自动策略、候选预览、测试连接、最近运行 |
| `web/src/components/TaskDetailDrawer.tsx` | 顶部“派发”按钮 + 通道菜单 + 最近派发折叠区 |
| `web/src/components/DispatchMenu.tsx` | 复用派发菜单：前置校验、提交、结果回显 |
| `web/src/api/client.ts` | 新增 `DispatchConfig`、`DispatchAttempt`、`DispatchStatus` 类型 |
| `web/src/pages/QueuePage.tsx` | 默认只列 `kind=manual` 人工队列；新增“派发记录”二级视图；P2 新增“待派发”任务选择器，批量加入人工队列后统一 submit |
| `web/src/pages/ExecSessionsPage.tsx` | 保持 `exec_sessions` 观测与“重派”；增加“B0 运行请在任务详情/派发记录查看”的说明；不改重派语义 |

### 8.4 后端改动点

| 文件 | 改动 |
|---|---|
| `server/src/services/PushDispatcher.ts` | 增加自动入口/options（`allowD=false`）；写 attempt；扩展 status |
| `server/src/services/DispatchScheduler.ts` | 新调度器：候选查询、冷却、单飞、批量上限 |
| `server/src/services/RelayDispatchService.ts` | 增加可选 `queueKind`：B0/A 单条/自动 `dispatch`，会话重派 `relay`；B0 主流程不变 |
| `server/src/services/QueueService.ts` | `create()` 增加可选 `kind`；`list(kind)` 支持 `manual/all` |
| `server/src/services/ConcurrencyPool.ts` | `PoolRunSlot` 增加 `platform`/`channel`（取自 `monitor_preferred_platform`），供任务池 B0 标识 |
| `server/src/routes/dispatch.ts` | 新增 config/candidates/auto/test/attempts 路由；不新增 batch |
| `server/src/routes/index.ts` | `/queues` 支持 `kind` 过滤；“派发记录”复用 `/queues?kind=all` |
| `server/src/db/schema.ts` | `dispatch_auto`、`dispatch_last_at`、`dispatch_last_state`；`dispatch_attempts` 表；`queues.kind` |
| `server/src/services/AppSettings.ts` | 读取/写入策略键（沿用 KV） |
| `server/src/index.ts` | 启动 `DispatchScheduler`，独立于 supervisor |
| `server/src/services/SupervisorService.ts` | 不把 B0 自动塞进 `readEnabled()` 之后；必要时在 ready mark 后调用 scheduler |

---

## 9. 关键流程

### 9.1 手动单任务 B0 成功

```text
用户 → 任务详情 → 派发/仅 B0
  → 前端校验 status/archived/ai_state
  → POST /api/dispatch/task {channel:'b0'}
  → PushDispatcher.resolveB0Tool()
  → RelayDispatchService.dispatchTask(taskId,'codebuddy-gateway',tool.id, queueKind='dispatch')
  → QueueService.create('监督派发（codebuddy-gateway）', ..., kind='dispatch')
  → QueueService.addJobs(queueId, [{taskId, toolId}])
  → AIService.buildSubmitter() → codebuddyGateway.submit()
  → POST /api/v1/runs → runId/ticket
  → armTaskRunning(taskId,'codebuddy-gateway') → monitor_ready=0
  → 返回 state='running' + ticket
  → 前端显示“已受理，等待结果”
  → SSE completed → QueueService poll → handle_result
  → queue.autoCompleteTask 开启时任务 done；否则保持 todo + 结果
```

### 9.2 手动“自动”且 B0 失败

```text
POST /api/dispatch/task {channel:'auto'}
  → B0 未配置/失败：attempt B0 failed/ready
  → tryA(task)：armReady(taskId,'mcp')，monitor_ready=1
  → A 成功：state='ready'，detail='已退回 MCP 就绪池'
  → A 失败：escalateD(task) → ai_state=failed / d-gui（仅手动确认）
  → 前端显示三段 attempts 与 fallback reason
```

### 9.3 自动调度一轮

```text
DispatchScheduler.tick()
  → 读 dispatch.autoEnabled / scope / cooldown / maxPerTick
  → 若关闭或配置不完整：返回 skipped
  → 先 TaskService.markMonitorReady()（若 readyMarkEnabled）
  → 查询候选（status=todo/archived=0/ai_state=''/monitor_ready=1/
       dispatch_auto IN (NULL,1)/平台偏好匹配/冷却外）
  → 按优先级、创建时间排序，取 maxPerTick
  → 逐条 dispatchAuto(task, { allowD:false })
      → B0 成功：state=running；写 attempt；更新 last_at；内部 queue kind=dispatch
      → B0 失败 + allowFallbackA：armReady(A)；写 attempt
      → B0/A 都失败：保持 todo + 标记需人工（不自动 D）
  → 写 auto 运行摘要（counts/lastRunAt）
```

### 9.4 批量派发（P2，复用队列）

```text
队列页 → 待派发 → 勾选 N 条
  → POST /api/queues {name,date,kind:'manual'} 或选择已有 kind=manual 队列（预选 B0 工具）
  → POST /api/queues/:id/jobs {items:[{taskId,toolId}]}
  → POST /api/queues/:id/submit
  → 返回 queue_jobs[]
  → UI 汇总 queued/sending/success/failed/timeout
  → 失败项走队列既有“重试失败”，不逐条调用 /dispatch/task
```

### 9.5 配置与测试连接

```text
设置 → 派发策略
  → 选择 B0 工具 → 保存
  → 测试连接 → POST /api/dispatch/test
  → 返回 configured/auth/endpoint/版本兼容
  → 预览候选 → GET /candidates
  → 立即跑一轮（dryRun=true）→ 查看将派发列表
  → 确认后 dryRun=false
```

### 9.6 执行会话重派（现有链路，不改）

```text
执行会话页 → stalled/failed 会话 → 重派
  → POST /exec-sessions/:id/redispatch
  → ExecSessionService.redispatchSession()
  → 校验会话状态（仅 stalled/failed）
  → 校验关联任务未归档且 status=todo
  → RelayDispatchService.dispatchTask(taskId, row.platform, undefined, queueKind='relay')
  → 读 supervisor.relayToolId（不是 dispatch.b0ToolId）
  → 逐任务返回 dispatched/ok/detail
  → 会话行不变，依赖同 session_id 新心跳复活
```

> 该链路只属于外部会话恢复；任务详情的手动“派发”才是 B0 入口。两者不互相替代，也不共享配置键。

---

## 10. 异常场景

| 编号 | 场景 | 检测 | 处理 | 用户提示 |
|---|---|---|---|---|
| EX-01 | B0 工具未配置 | `resolveB0Tool` 返回 null | 仅 B0 不派发；自动跳过 | “未配置 CodeBuddy 网关工具，去设置” |
| EX-02 | B0 端口不通 | fetch ECONNREFUSED/超时 | 保持 ready；写 attempt；自动按策略回 A | “网关不可达，请检查端口/进程” |
| EX-03 | 鉴权失败 | HTTP 401/403 | 不重试；不降级到 A 以外的通道 | “鉴权失败，检查网关口令” |
| EX-04 | 路径错误 | HTTP 404 | 提示 endpoint 不要带 `/api/v1` | “Endpoint 应为网关根地址” |
| EX-05 | 提交成功但 SSE 断流 | `active=false` / 无终态 | 判失败；A 归位；记录 ticket | “已受理但结果流断开，已退回 A” |
| EX-06 | 任务已被归档 | `archived=1` | 拒绝 | “任务已归档，不能派发” |
| EX-07 | 任务已完成 | `status!='todo'` | 拒绝 | “仅待办可派发” |
| EX-08 | 任务执行中 | `ai_state='running'` | 拒绝；自动候选排除 | “任务执行中，避免双跑” |
| EX-09 | 重复提交 | 冷却/幂等键命中 | 返回已有 attempt，不再新建 queue | “已受理，请勿重复提交” |
| EX-10 | 自动候选为空 | 查询 0 条 | 不写 attempt；状态卡显示原因 | “无符合条件的待办/全部在冷却” |
| EX-11 | 监督器关闭 | `supervisor.enabled=false` | 自动调度仍独立运行 | 状态卡说明“监督器关闭不影响自动派发” |
| EX-12 | 就绪标记关闭 | `readyMarkEnabled=0` | 自动候选为空；提示 | “就绪标记关闭，无法自动排水” |
| EX-13 | 队列提交失败 | `dispatchTask` catch | `armReady`；写失败 attempt | “派发未成，任务已退回就绪池” |
| EX-14 | 进程重启 | 启动时扫描 `sending` job | 继续 poll；不重推 | “恢复检查中” |
| EX-15 | 配置被并发修改 | 保存版本/更新时间冲突 | 拒绝旧版本；提示刷新 | “配置已更新，请刷新后重试” |
| EX-16 | D 被自动请求 | `allowAutoD` 强制 false | 拒绝；转人工 | “D 仅支持人工确认” |
| EX-17 | 项目范围为空 | `scopeProjectIds=[]` | 自动不启用 | “未选择项目，自动派发不会运行” |
| EX-18 | 数据库写失败 | SQLite busy/异常 | 不重复提交；记录日志；人工重试 | “本地数据库繁忙，请稍后重试” |
| EX-19 | B0 内部队列出现在人工队列下拉 | `/queues` 未按 `kind` 过滤 | 默认只返回 `manual`；内部队列仅在“派发记录”展示 | 队列页不显示“监督派发（…）” | 
| EX-20 | B0 任务出现在任务池，用户点“暂停” | 任务池按 `ai_state='running'` 读取 | 显示“B0 执行中”；按钮文案改为“移出池”，并提示不终止网关侧执行 | “仅移出分发池，不会取消 B0 run” |
| EX-21 | 执行会话页找不到 B0 run | `exec_sessions` 无 B0 行 | 属正常；任务详情 attempts 查看 queue/job/ticket | “B0 运行记录在任务详情/派发记录” |
| EX-22 | 批量 B0 某条失败 | `queue_jobs` 为 failed/timeout | 在队列页“重试失败”，重置为 queued；不逐条调用单任务接口 | “队列中 X 条失败，已重置可重试” |

---

## 11. 验收标准

### 11.1 P0 验收

| AC | Given / When / Then |
|---|---|
| AC-01 | Given 任务是 `todo`、未归档、非 running；When 打开任务详情；Then 能看到“派发”按钮 |
| AC-02 | Given 任务已完成/已归档/执行中；When 打开菜单；Then 按钮禁用且 tooltip 说明原因 |
| AC-03 | Given B0 已配置；When 选择“仅 B0”并提交；Then 返回 B0 attempt，显示 ticket/runId，任务变 running |
| AC-04 | Given B0 未配置；When 选择“仅 B0”；Then 提交被禁用或返回 `B0_NOT_CONFIGURED`，不回退 A |
| AC-05 | Given B0 失败、A 可用；When 选择“自动”；Then attempts 显示 B0 失败 + A ready，任务回到就绪池 |
| AC-06 | Given B0/A 都失败；When 选择“自动”；Then 显示 D 人工确认，未自动开 GUI |
| AC-07 | Given 执行会话页；When 查看重派按钮；Then 仍走原中继语义，不出现 B0 入口 |
| AC-08 | Given 生产端口 39877；When 打开设置/任务详情；Then API 可达，页面无旧 bundle 混用 |

### 11.2 P1 验收

| AC | Given / When / Then |
|---|---|
| AC-09 | Given 自动开关开启、项目范围内有待办；When 调度器跑一轮；Then 最多派发 `maxPerTick` 条，逐条写 attempt |
| AC-10 | Given `supervisor.enabled=false`；When 自动开关开启；Then 调度器仍运行（不依赖监督器） |
| AC-11 | Given 同一任务刚派发；When 冷却窗口内再次调度；Then 跳过，不新建 queue |
| AC-12 | Given 任务 `dispatch_auto=0`；When 全局自动开启；Then 永不自动派发 |
| AC-13 | Given 任务平台偏好是 `workbuddy`；When B0 自动扫描；Then 不抢占 |
| AC-14 | Given 进程重启；When 启动调度器；Then 不重复提交已有 `sending` job |
| AC-15 | Given 自动链路 B0/A 都失败；Then 不自动 D；状态标记需人工 |
| AC-16 | Given 设置页保存配置；When 重启 MTask；Then 策略保持 |
| AC-17 | Given 点击“测试连接”；When 网关不可达；Then 返回明确错误，不创建任务 |
| AC-18 | Given 任务详情；When 展开“最近派发”；Then 显示 attempt 时间/通道/状态/fallback |

### 11.3 菜单分工与队列边界验收

| AC | Given / When / Then |
|---|---|
| AC-27 | Given B0 单条/自动派发生成 `kind=dispatch` 队列；When 打开队列页默认视图；Then 不显示该内部队列；切到“派发记录”可见 |
| AC-28 | Given B0 任务在任务池；When 查看运行槽位；Then 显示“B0 执行中”，不提供“终止 B0”假动作 |
| AC-29 | Given 队列页多选任务加入人工队列并发送；When 其中一条失败；Then 其余 job 继续，失败项可“重试失败”，不回退到逐条 dispatch API |
| AC-30 | Given B0 正在运行；When 打开执行会话页；Then 不出现伪造的 B0 会话卡；任务详情 attempts 能看到 queue/job/ticket |

### 11.4 非功能与安全验收

| AC | 验证 |
|---|---|
| AC-19 | `POST /api/dispatch/task` 在正常链路 1s 内返回受理/失败；不等待 B0 完成 |
| AC-20 | 1 万任务候选查询 <500ms（索引/EXPLAIN） |
| AC-21 | 日志/响应/数据库中搜不到 gateway password/token 明文 |
| AC-22 | 老库启动迁移成功；旧任务/旧 token 行为不变 |
| AC-23 | B0 鉴权失败、端口不通、404、SSE 断流各有独立测试 |
| AC-24 | A 手动/自动、D 人工、执行会话重派三条旧链路回归通过 |
| AC-25 | `npm run typecheck`、`npm run build:server`、`npm run build:web` 通过 |
| AC-26 | 生产 `39877` API health 通过；UI 构建产物与后端构建产物一致 |

### 11.5 Definition of Done

- 代码、迁移、接口、UI、文档齐全。
- 自动化测试覆盖候选选择、冷却、fallback、错误码、旧库迁移。
- 提供 fake B0 gateway 集成测试脚本，不依赖真实 CodeBuddy 账号。
- 提供生产构建截图/录屏或 DOM 断言（至少任务详情按钮、设置页状态卡）。
- 不把任何“已实现”写成“已验证”；未在真实网关验收的项明确标注。

---

## 12. 优先级规划

| 阶段 | 范围 | 交付物 | 依赖 |
|---|---|---|---|
| P0（手动优先） | 任务详情派发、状态卡只读、`GET /status` 扩展、attempt 基础日志 | 前端入口 + API + 测试 | 现有 `PushDispatcher` / B0 adapter |
| P1（自动策略） | `DispatchScheduler`、设置“派发策略”、B0 工具选择、候选预览、冷却、任务级开关、attempt 表、`queues.kind`、队列页“派发记录” | 自动闭环 + 配置 + 审计 | P0；`dispatch_attempts` 迁移 |
| P2（批量与体验） | 队列页“待派发”、B0 批量复用人工队列、“派发记录”历史面板、测试连接增强 | 批量 + 观测 | P1 |
| P3（扩展） | CLI Process Adapter、平台适配器注册表、按平台 token/角色、A2A/ACP | 多平台 | 用户确认平台范围 |

**建议第一版只做 P0 + P1 的最小闭环：**

1. 任务详情“派发”（手动）。
2. 设置“派发策略”（自动 + B0 工具 + 候选预览 + 冷却）。
3. `dispatch_attempts` + 任务详情最近派发。
4. 队列页“派发记录”只读视图，默认隐藏 `kind=dispatch/relay` 内部队列。
5. 暂不做“待派发”批量，避免一次铺开。

---

## 13. 风险说明

| 风险 | 概率/影响 | 说明 | 缓解 |
|---|---|---|---|
| B0 Beta 接口漂移 | 中/高 | `/api/v1/runs`、SSE 字段/鉴权可能随版本变化 | adapter 契约测试；版本探测；失败明确提示；保留 A 兜底 |
| 网关端口/口令配置错误 | 高/中 | endpoint 动态、口令不显示 | 测试连接；endpoint 白名单；错误码区分 401/404/ECONNREFUSED |
| 自动重复派发 | 中/高 | 异步失败回 A 后可能再次被扫到 | 冷却 + `dispatch_last_at` + `sending` job 排除 + 幂等键 |
| 监督器耦合导致自动停摆 | 高/中 | `supervisor.enabled=false` 提前返回 | 独立 `DispatchScheduler`；不在 `readEnabled()` 后挂 B0 |
| `auto` 误转 D | 中/高 | 现有 `PushDispatcher.auto` 末端会 `escalateD` | 自动入口 `allowD=false`；D 仅人工 |
| 任务被误推给 B0 | 中/高 | 全局自动可能抓走 WorkBuddy 任务 | 项目范围 + `dispatch_auto` + 平台偏好双重过滤 |
| 进程重启丢 run 状态 | 中/中 | `codebuddyGateway` 的 `runStates` 是内存 Map | 持久化 attempt；`poll` 以 `active=false` 判失败；A 归位 |
| SQLite 写竞争 | 低/中 | 调度器/队列/poller 同进程写 | 单飞、短事务、避免长事务；错误可重试 |
| 用户误以为“重派=B0” | 中/中 | 两个动作语义不同 | 执行会话页只保留“重派”；B0 放任务详情；文案明确 |
| 内部派发队列污染人工队列 | 高/中 | B0 单条每次 `QueueService.create('监督派发（platform）')` | `queues.kind` 过滤；`/queues` 默认只列 `manual`；派发记录单独视图 |
| B0 任务在任务池被误“暂停” | 中/中 | 任务池按 `ai_state='running'` 读取，`shelve` 不终止已受理 run | B0 标识 + “移出池”文案；不提供终止假动作 |
| 执行会话页误判 B0 未派发 | 中/中 | `exec_sessions` 无 B0 行 | 任务详情 attempts 显示 queue/job/ticket；页面文案说明 B0 不在会话板 |
| 自动把任务标 done | 中/中 | `queue.autoCompleteTask` 默认开启 | 文档说明；需要人工复核的项目设 `0`；后续加 `dispatch.autoComplete` 覆盖 |
| 许可证风险 | 低/中 | 参考项目含 AGPL/fair-code/商业许可 | 只借鉴模式，不复制代码；引入依赖前做许可证评审 |
| 平台误判 | 中/高 | Qoder/Trae/豆包/Codex 无 `/runs` | 平台矩阵显式标注；不提供假 B0 按钮 |
| 缺少真实端到端验收 | 中/高 | 本机 B0 真实账号/企业环境可能不可用 | fake gateway + 真实网关分阶段验收；未验收不标 verified |
| 配置文件增长/历史膨胀 | 低/低 | attempts 30 天 | 定时清理；索引；分页 |

---

## 14. 待确认问题

1. 自动派发默认是否要求任务显式 `dispatch_auto=1`，还是项目范围内 `NULL` 也允许？（本 PRD 建议：项目范围 + `NULL` 允许，但提供 `0` 硬闸；高风险项目建议默认 `0`。）
2. B0 同步成功是否应沿用 `queue.autoCompleteTask=1` 直接置 done，还是必须人工查看结果后才 done？
3. 自动策略是否允许处理 `ai_state='failed'` 的历史失败任务？本 PRD 建议不允许，避免自动重推失败任务。
4. 项目是否允许多个 B0 工具？本期建议只允许一个 `dispatch.b0ToolId`，多工具放 P3。
5. 是否需要在任务列表行内提供“派发”快捷动作？本期建议只在详情抽屉，列表批量放 P2。
6. 自动调度器与 `SupervisorService` 的定时器是否合并？建议独立，避免监督器开关影响 B0。
7. 真实 B0 网关的鉴权/版本探测接口是否稳定？需要在实施前用实际网关验证。
8. 是否需要按平台 Token/角色立即上线？建议作为 P2/P3，不阻塞 P0/P1。
9. 内部派发队列如何隐藏？建议加 `queues.kind`，不用名称前缀过滤；名称过滤太脆弱，改名即失效。
10. 批量 B0 是否要写 `dispatch_attempts`？建议不写，队列 job 是唯一状态源；任务详情只显示“该任务在队列 Q 中”的链接。
11. B0 是否要出现在执行会话页？建议 P0/P1 不出现；若未来要出现，先设计 B0 progress 上报与独立的“B0 重派”，不复用中继重派。
12. 任务池里的 B0 “暂停”怎么处理？建议改为“移出池”并提示不会终止网关侧执行；不提供无法兑现的“终止”按钮。

---

## 15. 参考来源

### 15.1 GitHub 参考项目

- `ginkida/agent-dispatch`：<https://github.com/ginkida/agent-dispatch>
- `artificemachine/superharness`：<https://github.com/artificemachine/superharness>
- `layl-labs/orchestmux`：<https://github.com/layl-labs/orchestmux>
- `dephelion/baya-cli`：<https://github.com/dephelion/baya-cli>
- `hatchet-dev/hatchet`：<https://github.com/hatchet-dev/hatchet>
- `triggerdotdev/trigger.dev`：<https://github.com/triggerdotdev/trigger.dev>
- `windmill-labs/windmill`：<https://github.com/windmill-labs/windmill>
- `n8n-io/n8n`：<https://github.com/n8n-io/n8n>
- `langgenius/dify`：<https://github.com/langgenius/dify>
- `activepieces/activepieces`：<https://github.com/activepieces/activepieces>
- `temporalio/temporal`：<https://github.com/temporalio/temporal>
- `OpenHands/OpenHands`：<https://github.com/OpenHands/OpenHands>
- `opensandbox-group/OpenSandbox`：<https://github.com/opensandbox-group/OpenSandbox>
- MCP 规范：<https://github.com/modelcontextprotocol/modelcontextprotocol>
- MCP TypeScript SDK：<https://github.com/modelcontextprotocol/typescript-sdk>

### 15.2 内部依据

- `docs/调研-MTask向WorkBuddy分发任务方案及开源参考.md`
- `docs/九期-A通道平台适配现状.md`
- `docs/九期-按平台token与角色隔离-草案.md`
- `server/src/services/PushDispatcher.ts`
- `server/src/services/RelayDispatchService.ts`
- `server/src/services/QueueService.ts`
- `server/src/services/SupervisorService.ts`
- `server/src/services/ExecSessionService.ts`
- `server/src/adapters/codebuddyGateway.ts`
- `server/src/routes/dispatch.ts`
- `web/src/pages/SettingsPage.tsx`
- `web/src/pages/SupervisorPanel.tsx`
- `web/src/components/TaskDetailDrawer.tsx`
- `web/src/pages/QueuePage.tsx`
- `web/src/pages/ExecSessionsPage.tsx`

### 15.3 调研限制

- 竞品功能来自各自 README/官方文档，未对本 PRD 中所有产品做端到端实测。
- star 数、许可证、接口字段以仓库/官方文档为准，可能随版本变化。
- MTask 的 B0 真实网关验收受本机 CodeBuddy 账号、端口、版本影响；PRD 中的 B0 链路以现有代码与已完成的隔离网关实测为基线，未把“代码走查”写成“生产已验证”。
- 参考项目许可证不同（AGPLv3 / fair-code / Apache-2.0 / MIT / 商业许可）；本 PRD 不包含代码移植，实施前需单独做许可证评审。

---

## 附录 A：建议 UI 文案

| 位置 | 文案 |
|---|---|
| 任务详情按钮 | `派发` |
| 通道菜单 | `自动（CodeBuddy → MCP → 人工）` / `仅 CodeBuddy 网关（B0）` / `仅 MCP 就绪池（A）` / `D 应急（需人工确认）` |
| B0 未配置 | `未配置 CodeBuddy 网关工具` + `去设置` |
| 已受理 | `已受理，等待网关返回结果` |
| B0 失败转 A | `B0 未成，已退回 MCP 就绪池：<原因>` |
| B0 失败不降级 | `仅 B0 模式，未降级；任务仍为待办` |
| D | `已转人工确认，不会自动执行 GUI` |
| 自动关闭 | `自动派发已暂停；在途任务不受影响` |
| 自动范围为空 | `未选择项目，自动派发不会运行` |
| 测试连接 | `连接正常 / 鉴权失败 / 网关不可达 / 版本不兼容` |

## 附录 B：自动候选 SQL 草案

```sql
SELECT id, task_no, title, project_id, priority, created_at
FROM tasks
WHERE status = 'todo'
  AND archived = 0
  AND shelved = 0
  AND ai_state = ''
  AND monitor_ready = 1
  AND (dispatch_auto IS NULL OR dispatch_auto = 1)
  AND (
    monitor_preferred_platform IS NULL
    OR LOWER(TRIM(monitor_preferred_platform)) = 'codebuddy-gateway'
  )
  AND (
    dispatch_last_at IS NULL
    OR dispatch_last_at < :cooldownBefore
  )
  AND project_id IN (:scopeProjectIds)
ORDER BY
  CASE priority
    WHEN 'urgent' THEN 1
    WHEN 'high' THEN 2
    WHEN 'normal' THEN 3
    ELSE 4
  END,
  created_at ASC
LIMIT :maxPerTick;
```

> 上线前需用 `EXPLAIN QUERY PLAN` 验证索引；建议为 `(status, archived, monitor_ready)` 或 `(project_id, status, monitor_ready)` 增加组合索引。

## 附录 C：手动/自动派发状态映射

| 用户看到的 | 内部 state | 说明 |
|---|---|---|
| 已受理 | `running` | B0 拿到 ticket/runId，等待结果 |
| 已完成 | `done` | 队列成功/任务 done |
| 已退回就绪池 | `ready` | B0 失败，A 可拉取 |
| 已转人工 | `manual` | D 标记，等待人工确认 |
| 失败 | `failed` | 无法归位/队列失败，需处理 |
| 稍后可重试 | `ready` + cooldown | 冷却窗口内不自动重试 |

## 附录 D：界面草图（低保真）

### D.1 任务详情抽屉

```text
┌──────────────────────────────────────────────────────────────┐
│ T05808 修复派发按钮无响应                         [待办] [×] │
│ 项目：MTask 九期        优先级：高        更新时间：…        │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ [派发]  最近派发：B0 已受理 · 12:30                      │ │
│ └──────────────────────────────────────────────────────────┘ │
│ [描述] [结果] [摘要] [时间线] [计划] [Git] [阻塞] [字段]    │
│                                                              │
│  …任务内容…                                                   │
└──────────────────────────────────────────────────────────────┘
```

点击“派发”后的菜单：

```text
┌──────────────────────────────────────────────┐
│ CodeBuddy 网关：已配置（127.0.0.1:39879）    │
│ ──────────────────────────────────────────── │
│ ○ 自动（CodeBuddy → MCP → 人工）            │
│ ○ 仅 CodeBuddy 网关（B0，失败不回退）       │
│ ○ 仅 MCP 就绪池（A）                        │
│ ○ D 应急（需人工确认）                      │
│                                              │
│ 允许自动派发： [跟随项目 ▾]                  │
│                              [取消] [派发]   │
└──────────────────────────────────────────────┘
```

### D.2 设置 → 派发策略

```text
┌──────────────────────────────────────────────────────────────┐
│ 设置                                                         │
│ [偏好] [数据] [运维与诊断]                                   │
│   ├ 监督与审计                                               │
│   ├ 派发策略  ← 当前                                         │
│   ├ 内网穿透                                                 │
│   └ 日志                                                     │
├──────────────────────────────────────────────────────────────┤
│ 派发状态                                                     │
│ ┌───────────────────────┐ ┌───────────────────────┐          │
│ │ CodeBuddy 网关         │ │ MCP 就绪池             │          │
│ │ 已配置 · 测试连接      │ │ 12 条待拉取            │          │
│ └───────────────────────┘ └───────────────────────┘          │
│ ┌───────────────────────┐ ┌───────────────────────┐          │
│ │ D 应急                 │ │ 自动派发               │          │
│ │ 3 条待人工             │ │ 运行中 · 最近 12:30    │          │
│ └───────────────────────┘ └───────────────────────┘          │
├──────────────────────────────────────────────────────────────┤
│ 自动派发  [已开启]                    [暂停自动派发]         │
│ 默认通道： [自动 ▾]                                          │
│ B0 工具：  [CodeBuddy 本地网关 ▾]     [测试连接]             │
│ 项目范围： [MTask 九期 ×] [选择项目]                         │
│ 触发：     [就绪后扫描 ▾]   间隔 [30s]                       │
│ 冷却：     [5 分钟]         每轮上限 [5]                     │
│ 最大尝试： [3]              A 降级 [开]                      │
│ D：        仅人工（不可自动）                                 │
│                                                              │
│ [预览候选] [立即跑一轮（试运行）]              [保存]        │
├──────────────────────────────────────────────────────────────┤
│ 最近派发                                                      │
│ 12:30 T05808 B0 已受理  ticket=run_…   [查看]                │
│ 12:28 T05806 B0 失败   401 鉴权失败    [查看]                │
└──────────────────────────────────────────────────────────────┘
```

### D.3 队列页“待派发 / 派发记录”（P1/P2）

```text
┌──────────────────────────────────────────────────────────────┐
│ 队列                                                         │
│ [人工队列] [待派发] [派发记录]                                 │
│ 项目： [MTask 九期 ▾]   工具： [CodeBuddy 本地网关 ▾]                      │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ ☑ T05808 修复派发按钮无响应     高   B0 可派    [加入]   │ │
│ │ ☑ T05807 验收 WorkBuddy 登录     中   需人工    [加入]   │ │
│ │ ☐ T05806 补充平台适配文档        低   冷却中    [加入]   │ │
│ └──────────────────────────────────────────────────────────┘ │
│ 已选 2 条              [加入队列]   [发送队列（B0）]         │
│                                                              │
│ 派发记录（切到该视图才显示）                                  │
│ 12:30 T05808 B0 sending  ticket=run_…   [查看 job]          │
│ 12:28 T05806 B0 failed   401 鉴权失败   [重试]              │
└──────────────────────────────────────────────────────────────┘
```
