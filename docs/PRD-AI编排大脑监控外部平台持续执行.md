# PRD：AI 编排大脑 —— 监控外部 AI 平台持续执行

> 版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：待研发评审
> 设计依据：`docs/方案设计-AI监控外部AI平台持续执行.md`
> 关联既有方案：`docs/MTask发送任务到WorkBuddy-可行性评估.md`（2026-09-13，单次派发可行性）

---

## 1. 背景与目标

MTask 当前已能把待办派发给 WorkBuddy / Trae 等外部 Agent 执行（详见可行性评估），但派发是**手动触发、一次性**的：任务失败/停滞后需人工发现并重新派发，缺少「无人值守、持续排水」的闭环。

本 PRD 目标：让 MTask 充当「**AI 编排大脑**」，AI 监控外部平台的**执行会话**与**待办运行状态**，自动续跑/换台/排水剩余任务，达成「AI 监控 AI 持续执行」。

**范围**：监控外部平台执行会话存活与进度、基于规则+LLM 裁决自动触发剩余任务、依赖感知的连续排水。
**非范围**：修改外部平台代码、平台底层进程级监控、完全自治无人工兜底。

**成功指标**：
- 外部任务停滞到被自动续跑的时延 ≤ 1 个监督周期（默认 30s）+ 平台拉取延迟
- 无人值守场景下，待办 backlog 在平台健康时持续收敛至空（不靠人工干预）
- 任何自动动作 100% 可审计、可一键熔断

---

## 2. 用户故事

| 编号 | 角色 | 故事 |
|---|---|---|
| US-1 | 任务所有者 | 我希望把一批待办交给 WorkBuddy 后就去忙别的，系统能自己盯着进度、卡住自动续跑，不用我守着 |
| US-2 | 任务所有者 | 我希望能在一个面板里看到每个外部平台的执行会话是否还活着、卡在哪一步、进度多少 |
| US-3 | 任务所有者 | 当某个平台连续失败，我希望系统自动把任务转给另一个平台（换台）而不是反复撞墙 |
| US-4 | 管理者 | 我希望 AI 的每次「决策与动作」都有据可查，出问题时能回溯它为什么这么做 |
| US-5 | 管理者 | 我必须能一键关掉自动执行，所有任务立刻回到人工接管状态，绝不允许失控狂跑 |

---

## 3. 功能需求（FR）

### 3.1 观测层：让 MTask 看见执行会话（FR-1.x）

- **FR-1.1 执行会话建模**：新增 `exec_sessions` 表，记录每次外部执行会话（平台 / 会话标识 / 关联任务 / 状态 / 进度 / 阶段 / 最近心跳 / 起止时间）。
- **FR-1.2 心跳与进度上报**：新增 MCP 工具 `mtask_report_progress(platform, session_id, task_id, phase?, pct?, note?)`，外部平台执行期间周期调用（建议 30~60s），upsert `exec_sessions` 并刷新 `last_heartbeat`；同步把对应任务 `ai_state` 置 `running`。
- **FR-1.3 停滞兜底**：Supervisor 把 `last_heartbeat` 超 `supervisor.sessionStaleMs`（默认 10min）的会话置 `stalled`；无心跳时复用 `TaskService.expireStaleRunning` 把超时 `running` 任务置 `failed`。
- **FR-1.4 会话可视**：前端新增「执行会话」面板，展示各平台会话的存活/进度/阶段/停滞标记。

### 3.2 决策层：AI 监控 AI（FR-2.x）

- **FR-2.1 常驻监督器**：新增 `SupervisorService`，复用 `RecurringService.tick()` 的驱动机制，新增 `supervisorTick()`，按 `supervisor.intervalMs`（默认 30s）周期执行；无活跃/停滞会话且无 `running` 任务时空转返回（不调 LLM）。
- **FR-2.2 状态快照**：每轮采集待办（含 `plan_tasks.deps` 依赖）、活跃/停滞会话、失败任务与重试计数、预算占用，组装 `MonitorSnapshot`。
- **FR-2.3 LLM 裁决**：调「监控专用」模型（复用 `AIService.askJson`，自带截断重试+JSON 校验），输入快照，输出结构化动作计划（见 §7 模板），动作类型：`CONTINUE / RESUME / REDISPATCH / SPLIT / ESCALATE`。
- **FR-2.4 护栏约束**：LLM 仅「建议」，实际动作受护栏（§3.4）拍板；被拦截的动作降级为 `ESCALATE`。

### 3.3 执行层：自动触发外部平台（FR-3.x）

- **FR-3.1 就绪排水（拉取式，推荐）**：Supervisor 把无未完成前置依赖的待办标记 `monitor_ready=1`；外部平台经 `mtask_list_tasks`（过滤 `ai_state='' & status='todo' & monitor_ready=1`）拉走执行。**前提**：平台侧需一个轻量「自动化/Skill」周期消费就绪待办（MTask 侧零改动）。
- **FR-3.2 原子认领**：新增 `mtask_claim_task(task_id)`，平台拉取时原子认领（置 `ai_state=running` + `exec_session_id`），防多平台抢同一任务。
- **FR-3.3 RESUME 续跑**：stalled 会话对应任务重新标记 `monitor_ready`，平台再次拉取；必要时经平台自动化唤醒。
- **FR-3.4 REDISPATCH 换台**：改任务 `monitor_preferred_platform`，平台选择时偏好该字段指向的平台。
- **FR-3.5 SPLIT 拆分**：调 `mtask_create_task` 生成子任务并挂 `parent_id`，回灌待办池。
- **FR-3.6 推送式兜底**：对不支持 MCP 的平台，Supervisor 经 `QueueService.submitAll` / `WorkBuddyAdapter.submit` 派发（复用现有 `submit`/`poll`/`ticket` 机制）。
- **FR-3.7 依赖感知连续执行**：排水按 `plan_tasks.deps`（`[{id,type:'serial'|'parallel'}]`）拓扑排序；serial 严格先后，parallel 可并发投给不同平台会话。

### 3.4 护栏与审计（FR-4.x）

- **FR-4.1 最大并发**：`supervisor.maxConcurrent`（默认 2），超限动作降级 ESCALATE。
- **FR-4.2 重试上限**：`supervisor.maxRetry`（默认 3），单任务超上限 → ESCALATE 人工。
- **FR-4.3 冷却窗口**：`supervisor.cooldownMs`，同一任务两次触发间隔下限，防抖动循环。
- **FR-4.4 成本预算**：`supervisor.tokenBudget`，决策 LLM + 执行 LLM 累计 token 超预算即暂停自动触发，转人工。
- **FR-4.5 一键熔断**：`supervisor.enabled=0` 时 Supervisor 完全停摆，任务保持现状，人工接管；默认 `enabled=0`（P2 起需用户显式开启）。
- **FR-4.6 审计**：每次决策与动作写 `monitor_runs`（快照摘要 + 动作 + 是否护栏拦截），前端可回溯。

### 3.5 交互（FR-5.x）

- **FR-5.1 会话面板**：展示外部平台会话存活/进度/阶段/停滞。
- **FR-5.2 监督状态**：展示最近决策、下次 tick、预算占用、熔断开关。
- **FR-5.3 审计视图**：`monitor_runs` 列表，逐条「AI 为什么这么做」。
- **FR-5.4 熔断开关**：设置页显式开关，关闭即停自动执行。

---

## 4. 非功能需求（NFR）

- **NFR-1 性能**：监督 tick 默认 30s，单轮空转耗时 < 50ms（仅查索引）；有动作时 LLM 调用 < 10s（超时降级 ESCALATE）。
- **NFR-2 安全**：外部调用一律经 `X-Access-Token`（`api_tokens`）或 accessToken 鉴权；跨机部署经 `tunnel-service`；外部 token 不出本机。
- **NFR-3 可用性/可观测**：自动执行默认关闭；任何异常（LLM 失败/平台不可达）不得导致任务丢失，统一降级为人工可见状态并写审计。
- **NFR-4 兼容性**：纯新增表/列/工具，向后兼容既有库（`ensureColumn` 补列、`CREATE TABLE IF NOT EXISTS`）；不改动现有队列/AI 工具链路。

---

## 5. 数据模型

### 5.1 新增 `exec_sessions`
```sql
CREATE TABLE IF NOT EXISTS exec_sessions (
  id             TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,        -- 'workbuddy' | 'trae' | 'relay:xxx'
  session_id     TEXT,                 -- 平台侧会话标识（中继回传）
  task_ids       TEXT NOT NULL,        -- 本轮关联任务 id（JSON 数组）
  status         TEXT NOT NULL DEFAULT 'active', -- active|stalled|done|failed|aborted
  progress       REAL DEFAULT 0,       -- 0~100
  phase          TEXT DEFAULT '',
  last_heartbeat TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_platform_status ON exec_sessions(platform, status);
CREATE INDEX IF NOT EXISTS idx_exec_heartbeat ON exec_sessions(last_heartbeat);
```

### 5.2 新增 `monitor_runs`（审计）
```sql
CREATE TABLE IF NOT EXISTS monitor_runs (
  id          TEXT PRIMARY KEY,
  ran_at      TEXT NOT NULL,
  snapshot    TEXT,                    -- MonitorSnapshot 摘要（JSON）
  actions     TEXT NOT NULL,           -- 决策 LLM 输出动作（JSON）
  applied     TEXT NOT NULL,           -- 实际落地动作（护栏后，JSON）
  blocked_by  TEXT DEFAULT '',         -- 被护栏拦截原因（空=未拦截）
  model       TEXT DEFAULT ''
);
```

### 5.3 `tasks` 增量列（`ensureColumn` 后向兼容）
| 列 | 类型 | 说明 |
|---|---|---|
| `monitor_ready` | INTEGER DEFAULT 0 | 待平台拉取的就绪标记 |
| `monitor_preferred_platform` | TEXT | REDISPATCH 指定的偏好平台 |
| `monitor_retry` | INTEGER DEFAULT 0 | 监督器重试计数 |
| `exec_session_id` | TEXT | 关联 `exec_sessions.id` |

---

## 6. 接口契约

### 6.1 新增 MCP 工具

**`mtask_report_progress`**（FR-1.2）
```
入参 { platform: string, session_id: string, task_id: string,
       phase?: string, pct?: number, note?: string }
行为：upsert exec_sessions（按 platform+session_id）；刷新 last_heartbeat；
      同步任务 ai_state=running、ai_state_at=now；pct>=100 或平台声明完成→会话 done + 任务终态。
```

**`mtask_list_ready_tasks`**（FR-3.1）
```
入参 { platform?: string, limit?: number }
返回 待办列表，WHERE ai_state='' AND status='todo' AND monitor_ready=1
      AND (monitor_preferred_platform IS NULL OR =platform)
      AND 前置依赖（plan_tasks.deps）均已完成
```

**`mtask_claim_task`**（FR-3.2）
```
入参 { task_id: string, platform: string, session_id: string }
行为：事务内校验 ai_state='' 后原子置 ai_state='running'、ai_state_at=now、
      exec_session_id=会话 id、新建/绑定 exec_sessions；返回成功/冲突(409)
```

**`mtask_supervisor_status`**（FR-5.2）
```
返回 { enabled, intervalMs, nextTickAt, tokenBudgetUsed, lastActions[], activeSessions[] }
```

### 6.2 复用既有接口（不改动）
- `mtask_list_tasks` / `mtask_get_task` / `mtask_update_task` / `mtask_update_task_result` / `mtask_write_task_status` / `mtask_create_task`
- `QueueService.submitAll` / `pollPending`（推送式兜底）
- `WorkBuddyAdapter.submit` / `poll`（中继推送）
- `TaskService.expireStaleRunning`（停滞兜底）

---

## 7. 决策 LLM Prompt 模板（FR-2.3）

```
system:
你是 MTask 的监督决策器。你监控外部 AI 平台（WorkBuddy/Trae）的执行会话与待办状态，
产出下一步动作计划。只依据下方快照，不虚构任务。
可用动作：
- CONTINUE：会话健康，等待下一心跳
- RESUME：会话停滞，重新标记就绪触发续跑
- REDISPATCH：连续失败，换到另一个平台
- SPLIT：任务复杂度过高，拆分为子任务
- ESCALATE：超重试上限/需人工判断
只输出 JSON：{"actions":[{"type":...,"taskId":...,"toPlatform"?:...,"reason":...}]}

user:
{MonitorSnapshot 序列化：pending / sessions / failed / budget}
```

调用参数：`AIService.askJson`，`max_tokens=2048`（决策输出短小）、`temperature=0`（决策稳定）。

---

## 8. 状态机

```
exec_sessions:
  active ──心跳超时──▶ stalled ──RESUME──▶ active(重新就绪)
  active ──pct>=100──▶ done
  active ──平台报错──▶ failed ──REDISPATCH──▶ active(换台)
  stalled/failed/active ──人工──▶ aborted

tasks(监督相关):
  todo ──claim──▶ running(ai_state) ──report done──▶ unread
  running ──stale──▶ failed(expireStaleRunning) ──retry──▶ monitor_ready(续跑)
  monitor_ready ──claim──▶ running

supervisor:
  enabled=1 ──tick──▶ 快照 ──askJson──▶ 动作 ──护栏──▶ 落地/ESCALATE
  enabled=0 ──▶ 完全停摆，任务保持现状
```

---

## 9. 业务流程：监督 tick 闭环

1. `supervisorTick()` 触发 → 探测是否有 `active`/`stalled` 会话或 `running` 任务，无则返回。
2. 采集 `MonitorSnapshot`（待办 + 会话 + 失败 + 预算）。
3. `AIService.askJson` → 动作计划。
4. 逐动作过护栏（并发/重试/冷却/预算/熔断）→ 落库触发（就绪/换台/拆分/续跑）或降级 ESCALATE。
5. 写 `monitor_runs` 审计。
6. 外部平台拉取就绪任务执行 → 周期 `mtask_report_progress` 回写 → 状态层更新 → 下一 tick。

---

## 10. 约束与边界

- 自动执行默认 `supervisor.enabled=0`，P2 起需用户显式开启。
- 拉取式无人值守依赖平台侧「自动化/Skill」周期消费（MTask 不控制平台调度）。
- 外部平台无任务注入 API（可行性评估已确认）→ 不依赖平台私有 API；推送式仅经既有中继适配器。
- 纯新增，不改动现有队列/AI 工具/PRD/计划模块逻辑。
- 单任务重试上限、最大并发、token 预算均为可配项，越界即降级人工。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 外部平台无任务注入 API | MCP 拉取式 + 中继推送兜底；MTask 不依赖私有 API |
| 误触发重复执行/污染 | `mtask_claim_task` 原子认领 + 冷却 + 重试上限 |
| 成本失控 | token 预算 + 最大并发 + 默认关闭 |
| 决策 LLM 幻觉危险动作 | 护栏白名单（5 类安全动作）+ 审计 + 一键熔断 |
| 跨机网络不通 | `tunnel-service` 公网暴露 + `api_tokens` 鉴权 |
| 循环失败刷屏 | 重试上限 + 升级人工 + 冷却 |

---

## 12. 分阶段里程碑与验收标准

### P0（可视，零风险）
- 建 `exec_sessions` + `mtask_report_progress`；外部平台接 MCP 后开始上报。
- 前端「执行会话」面板展示存活/进度/停滞。**仅观测，不自动动作。**
- 验收：平台执行期间会话面板实时更新；无上报时按超时判停滞。

### P1（监督+告警）
- `SupervisorService` + `supervisorTick`；停滞检测 + 通知中心红点（复用 `listAiPending`）。
- 验收：模拟会话停滞，≤1 周期内出现停滞标记与通知；仍不自动续跑。

### P2（自动闭环）
- 决策 LLM + 护栏 + RESUME/REDISPATCH/排水 + `monitor_runs` 审计。
- 验收：开启 `enabled=1` 后，停滞任务被自动续跑、连续失败任务被换台；每次动作可在审计视图回溯；关闭开关后所有任务停摆。

### P3（多平台+依赖排水+成本护栏）
- Trae 接入、`plan_deps` 依赖排序、token 预算、熔断面板。
- 验收：多平台并发执行且 serial/parallel 依赖被正确遵守；超预算自动暂停并通知。

---

## 13. 评审决策点

1. 默认 `supervisor.enabled` 的取值（本方案：P2 起默认 0，需显式开启）——或默认开启但仅告警不动作？
2. 拉取式「无人值守」是否必须依赖平台侧自动化；若平台侧无法配置自动化，是否退回纯推送式（中继）？
3. 决策 LLM 用哪个模型/预算档位（本方案：独立监控专用模型，`max_tokens=2048`、`temperature=0`）。
4. 审计视图是否对普通用户可见，还是仅管理员/设置页（本方案：设置页「监督审计」只读列表）。
