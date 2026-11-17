# 概要设计（七期增量）：MTask 项目管理与 AI 工作台优化

> 版本：v7.0 增量设计（2026-10-26）
> 基线：`docs/概要设计.md`（v1.0，2026-09-12，整体架构）+ `docs/PRD评审报告-MTask-项目管理与AI工作台优化-整合版.md`
> 本文件**只描述增量**：既有架构（Electron 壳 + React/Vite + Express/TS + SQLite）不再复述，仅在受影响处标注扩展点。
> 关联任务：T03155（本文件）；上游评审 T03154；下游详细设计 T03156

---

## 1. 设计目标与约束

1. **不重建机制**：主题、RTM、估算、AI 闭环、批量动作与十级撤销、计划时间线均扩展而非替换。
2. **口径单源**：逾期率 / 燃尽 / AI 成功率 / 卡片覆盖率 / 预估偏差，各自只有一个服务端计算入口。
3. **最小数据增量**：只做向后兼容加列/加表；老库启动必须自愈（`ensureColumn` 模式）。
4. **可观测**：批量、生成、外发三类动作必须留逐条回执与可查询记录。
5. **可验证**：每条需求落到「服务接口 + 前端落点 + 验收门」三元组。

---

## 2. 分层与模块划分（增量视图）

```
┌──────────────────────────── web/src（React 18） ────────────────────────────┐
│ 页面层   TasksPage / ReqPage+ReqMatrixPanel / PlanPage / AIToolsPage         │
│          ReportConsole / ReportPage / QueuePage / ExecSessionsPage /         │
│          UsagePanel / SettingsPage / CommandPalette / DashboardPage          │
│ 移动端   mobile/MobileShell + MobileHome/Queue/TaskDetail/ExecSessions/...   │
│ 公共组件 ui/*（反馈、空态、骨架、对话框、资源状态）+ 主题与字号（settings.tsx）│
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │ REST /api/*（CSRF + Token scope）
┌────────────────────────── server/src（Express 4） ──────────────────────────┐
│ 服务层   TaskService / PlanService / ReqService / QueueService               │
│          AIService / AiCardStats / AiReadinessService                        │
│          ExecSessionService / Supervisor* / RelayDispatchService             │
│          ReportService / summaryPpt* / kickoff* / lecture*                   │
│          Estimate* / TestCase* / TaskExportService / PushService             │
│ 新增/扩展（本 PRD）:                                                          │
│          IterationService / BurndownService / InsightService                 │
│          SearchService(结构化搜索) / WebhookService / ShareSnapshotService    │
│          timePrimitives(业务日/边界日) — 共享原语，非独立服务                 │
│ 数据层   SQLite（30 表）+ 增量列/表（见 §5）                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 需求族 → 模块映射

| 需求族 | 需求 | 前端落点 | 服务端落点 | 设计要点 |
|---|---|---|---|---|
| 任务列表与批量 | PM-101/102/105、UX-01/02、PM-304 | `TasksPage.tsx`、`CommandPalette.tsx`、`ui/*` 反馈组件 | `TaskService`、新增 `SearchService` | 看板 WIP 只统计 todo；结构化搜索后端全集过滤；批量回执逐条 |
| 模型/提示词/主题 | UX-03/04、PM-301/302、UX-11、AI-304 | `SettingsPage.tsx`、`PromptsPage.tsx`、`settings.tsx` | `SettingsService`、`PromptsPage` 对应写接口 | `.op-host` 悬浮层规范；`:focus-visible` 基线；字号门已落地 |
| 需求与项目管理 | PM-103/201/204/205、UX-05～08 | `ReqPage.tsx`、`ReqMatrixPanel.tsx`、`PrdImportPanel.tsx`、`AiPlanImportPanel.tsx`、`PlanPage.tsx` | `ReqService`、`PlanService`、`kickoff*`、新增 `IterationService`/`BurndownService`/`InsightService` | 迭代=计划行集合；燃尽/预测共享时间原语；深链契约单源 |
| AI 工作台 | AI-101～104/201～205/301～304、UX-10/12 | `AIToolsPage.tsx`、`SummaryPptPanel.tsx`、`KickoffPptPanel.tsx`、`ReportConsole.tsx`、`UsagePanel.tsx` | `AIService`、`AiCardStats`、`AiReadinessService`、`summaryPpt*`、`kickoff*`、`lecture*` | 生成前预估随卡；card_key 显式传参；失败态统一组件 |
| 执行可观测 | AI-402、UX-10 | `ExecSessionsPage.tsx`、`QueuePage.tsx` | `ExecSessionService`、`SupervisorService`、`RelayDispatchService` | 可见 2s / 隐藏 15s 双档；重派复用单引擎 |
| 导出/集成/分享 | PM-401～404 | `TasksPage` 导出入口、`SettingsPage` 集成子页 | `TaskExportService`、新增 `WebhookService`/`ShareSnapshotService` | outbound 事件白名单 + 签名 + 投递回执；快照只读脱敏 |
| 移动端 | PM-104 | `mobile/*` | 复用既有 `/api/*`（只读路径受 scope=read 限制） | 任务可操作、需求/计划只读 |

---

## 4. 横切设计

### 4.1 时间原语（D-12，C1）

- 单模块提供：`businessDay(now, tz)`、`isOnOrBeforeBoundary(dateOnly, now, tz)`、`workdaysBetween(a, b, holidays)`、`formatDate(dateOnly, tz, knownMissing)`。
- 所有「逾期 / 燃尽 / 预测 / 周报周期」均调用同一模块；缺失值统一 `null` 语义，展示层用统一占位符。
- 落库保持原值（不做时区改写）；仅在展示与比较时投影到业务日。

### 4.2 深链与路由契约（D-13，C4）

- 统一 `#/project/:projectId/:tab?/:anchor?` 形式，项目/矩阵/计划/任务详情为稳定锚点；抽屉与 Tab 重构必须读写同一契约。
- 命令面板、通知、执行会话「任务直达」全部走该契约，不各自拼装跳转。

### 4.3 AI 不可用入口策略（D-14，C5）

- 组件级统一：`可用 / 可见禁用(原因+修复动作) / 隐藏(从未启用)` 三态，由 `AiReadinessService` 输出原因码，前端不自行判断。

### 4.4 设计系统基线（PM-302）

- 先修具体缺陷（UX-01/03/04 等），再沉淀：按钮层级、空态、骨架、提示时长（成功 2.5s / 错误 ≥6s 可复制）、`.op-host` 悬浮层规范。
- 视觉回归以关键页截图基线为准（浅/深 × 三档字号的最小组合集）。

---

## 5. 数据模型增量（概要）

| 对象 | 变更 | 说明 |
|---|---|---|
| `ai_usage` | 加列 `card_key`（已落） | D-05；历史 `unknown`，不回填 |
| `prompts` | 加列 `usage_count`（已落） | D-06；默认 0 |
| `project_iterations`（新） | `id/project_id/name/goal/dod/start_date/end_date/status/created_at` | D-02：迭代是计划行集合的容器，不建任务排期 |
| `plan_tasks` | 加列 `iteration_id`（可空） | 计划行归属迭代；空=未规划 |
| `webhook_subscriptions`（新） | `id/project_id/url/secret/events/enabled/created_at` | PM-402 outbound |
| `webhook_deliveries`（新） | `id/subscription_id/event/dedup_key/status/attempts/last_error/created_at` | 逐条投递回执 |
| `share_snapshots`（新） | `id/project_id/scope_json/token/expires_at/created_at/revoked_at` | PM-404 只读脱敏快照 |
| 逾期/燃尽/洞察 | **无新表** | 全部由 `plan_tasks` + `task_events` + 日历（`holidays`）派生 |

> 所有新表通过 `CREATE TABLE IF NOT EXISTS`，新列通过 `ensureColumn`，保证老库启动自愈。

---

## 6. 接口分组（概要）

| 分组 | 代表接口 | 备注 |
|---|---|---|
| 搜索 | `POST /api/tasks/search` | 表达式白名单 → SQL；返回总数 + 当前页 |
| 看板 | `GET/PUT /api/projects/:id/board-settings` | WIP 上限 1～50、隐藏空列（会话级） |
| 迭代 | `GET/POST/PUT/DELETE /api/projects/:id/iterations` | 含 `plan_tasks.iteration_id` 批量挂载 |
| 燃尽/预测 | `GET /api/projects/:id/burndown`、`GET /api/plans/:id/forecast` | 统一时间原语；返回区间与方法版本 |
| 洞察 | `GET /api/projects/:id/insights` | 只读聚合，标注样本量 |
| AI 用量/覆盖率 | `GET /api/ai/usage`、`GET /api/ai/coverage` | `card_key` 维度；区分「无人用/未接埋点」 |
| 执行会话 | `GET /api/exec-sessions?visible=1`、`POST /api/exec-sessions/:id/redispatch` | 双档刷新由前端退避，服务端不做推送 |
| 外发/分享 | `POST /api/webhooks`、`POST /api/shares`、`DELETE /api/shares/:id` | 签名 + 过期 + 撤销 |

> 详细字段、状态码、错误码见 `docs/详细设计/七期-接口与数据模型增量.md`（T03156）。

---

## 7. 关键流程（时序要点）

### 7.1 需求 → 计划 → 迭代 → 燃尽

1. PRD 导入 → `prd_requirements`（保留 reqIds）→ 计划回写（`requirements` + `items[].reqNos` 联动，硬规则 9）。
2. 迭代创建时选择时间窗 → 批量把该窗内 `plan_tasks` 打上 `iteration_id`。
3. 燃尽按业务日采样：每日剩余未完成计划行数 + 理想线；缺失日期不插值，标注「无数据」。

### 7.2 AI 生成 → 预估 → 分段 → 溯源

1. 生成前：`AiReadinessService` 判可用 → 预估（次数/字符量/耗时区间，带版本）→ 用户确认。
2. 分段生成：job 为主键，segment 重试不重复计成功 job（G-3 口径）。
3. 完成后：溯源面板列出输入来源与产物路径；偏差复算仅提示，不阻断。

### 7.3 执行会话可观测 → 重派

1. 页面可见：2s 轮询；隐藏：15s 或暂停。
2. 停滞/失败：一键重派走 `RelayDispatchService` 单引擎，生成新会话，原会话保留为历史。
3. 任务 chip 直达任务详情（深链契约）。

---

## 8. 非功能设计

| 项 | 设计 |
|---|---|
| 性能 | 列表 5000 条分页 + `content-visibility`；结构化搜索走索引（`tasks(project_id,status)`、`ai_usage(card_key,created_at)`） |
| 一致性 | 批量动作单事务 + 逐条回执；计划↔任务↔需求状态同步沿用既有 `reqStatusSync` |
| 安全 | 外发签名 HMAC + 不存明文密钥于日志；分享快照只读、可撤销、含过期 |
| 可访问性 | 图标按钮命名、role=button 键盘等价、`:focus-visible`、无正 tabIndex（既有门 T03181 持续约束） |
| 可降级 | AI 不可用三态；离线/额度受限时保留只读能力 |
| 可回退 | 新表可空、新列有默认；关闭开关后旧路径可用 |

---

## 9. 交付切分（与 P0/P1/P2 对齐）

1. **P0 批**（15 条）：搜索/看板/批量回执/空项目引导/暗色与字号收口/可访问性阻断项/AI 预估与溯源/执行会话可见性。
2. **P1 批**（20 条）：字号全覆盖（已提前完成）、迭代与燃尽、模型页与提示词体验、AI 模板与路由、移动端核心链路、分享快照。
3. **P2 批**（14 条）：5000 条性能、里程碑预测 UI、洞察深度、Webhook、组件规范长期基线。

## 10. 风险

- 迭代/预测的日期口径若无统一测试，将在跨时区项目上漂移（D-12）。
- 结构化搜索若绕过索引，1000 条以上会退化（PM-102 ⑧）。
- Webhook 外发的重试与去重若无 `dedup_key`，会重复投递。
- 指标视图在样本不足时若展示百分比，会被误读为真实水平（§6 风险 1）。
