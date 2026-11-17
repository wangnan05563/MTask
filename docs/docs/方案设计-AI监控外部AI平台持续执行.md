# 方案设计：MTask 作为「AI 编排大脑」监控外部 AI 平台持续执行

> 版本：v1.0 ｜ 日期：2026-09-28 ｜ 状态：方案设计（待评审）
> 演进自：`docs/MTask发送任务到WorkBuddy-可行性评估.md`（2026-09-13，单次派发可行性）

---

## 0. 目标与范围

**一句话目标**：让 MTask 当「大脑」，AI 监控 WorkBuddy / Trae 等外部 Agent 的**执行会话**与**待办运行状态**，自动触发剩余任务，形成**无人值守、可持续排水**的「AI 监控 AI」闭环。

| 维度 | 本方案范围 | 不在本方案范围 |
|------|-----------|----------------|
| 监控对象 | 外部平台的执行会话存活度、任务 running/failed 状态、进度 | 平台底层进程/CPU 级监控 |
| 触发动作 | 续跑、换台、重试、拆分、回灌待办 | 修改外部平台自身代码 |
| 决策 | 规则 + LLM 辅助裁决（带护栏） | 完全自治无人工兜底 |
| 平台 | WorkBuddy、Trae（均支持 MCP）；不支持 MCP 的走中继适配器 | 无 API 也无法拉取的黑盒平台 |

---

## 1. 现状盘点（可复用资产，避免重复造车）

经代码走查，MTask 已具备编排闭环所需的大部分原语，缺口集中在「**会话可见性**」与「**监督决策 + 自动续跑**」两层。

| 能力 | 现有实现 | 本方案如何复用 |
|------|----------|----------------|
| 外部平台接入（拉取式） | `server/src/mcp/server.ts` 20+ 个 `mtask_*` 工具（`mtask_list_tasks` / `mtask_get_task` / `mtask_update_task_result` / `mtask_write_task_status`），streamable HTTP，复用 accessToken 鉴权 | 外部平台以 **MCP 客户端**身份接入，拉任务 + 回写结果（路线 A） |
| 外部平台接入（推送式） | `server/src/adapters/workbuddy.ts` `WorkBuddyAdapter`：`submit()` 拿回执 `ticket`、`poll()` 轮询收敛，POST JSON 契约到可配置 endpoint（中继骨架） | 平台不支持 MCP 时，Supervisor 经此适配器 `submit`/`poll` 派发 |
| 异步任务编排状态机 | `server/src/services/QueueService.ts`：`queued/sending/success/failed/timeout` + `submitAll`/`pollPending`/超时判定 | 作为「执行层」派发引擎复用 |
| 任务运行状态机 | `server/src/services/TaskService.ts`：`ai_state` ∈ `running/failed/unread/''`；`expireStaleRunning()` 把超 1 小时的 running 惰性置 failed（带 `idx_tasks_ai_state` 索引） | 复用其 stale 判定作为「会话停滞」的兜底信号 |
| 持久化后台任务 | `server/src/services/ConsoleJobService.ts`：落库即返回、后台 `runJob` 回写、AbortController 可中止 | 监督循环可复用其「后台执行 + 中止」模式 |
| 定时 tick | `server/src/services/RecurringService.ts`：`tick()` 由 server 周期调用 | 监督循环复用同一 tick 机制（新增 `supervisorTick()`） |
| 远程可达 | `server/src/tunnel/tunnel-service.ts`：cloudflared / cpolar / tailscale，暴露公网 URL | 跨机部署时让外部平台经隧道连 MTask |
| 外部鉴权 | `api_tokens` 表 + `X-Access-Token` 头 | 外部平台/脚本调用 REST/MCP 的具名凭据 |

**关键缺口（本方案要补的）**：
1. **会话不可见**：MTask 现在只能看到「任务状态」与「队列回执」，看不到外部平台的**执行会话进程**（是否活着、卡在哪步、进度多少）。
2. **无监督决策层**：没有把「停滞检测 → 决策 → 续跑」串起来的常驻逻辑，目前派发是**手动触发**（`QueueService.sendAll`）。
3. **无自动续跑/换台动作**：任务 failed/timeout 后只能人工重试。

---

## 2. 总体架构（三层 + 闭环）

```
┌──────────────────────────────────────────────────────────────────────┐
│                        外部 AI 平台（执行臂）                          │
│   WorkBuddy ──MCP client──┐            Trae ──MCP client──┐          │
│   （拉取任务/回写进度/心跳）      （拉取任务/回写进度/心跳）          │
│   或：经 WorkBuddyAdapter 中继 submit/poll（推送式）                  │
└──────────────────────────┬─────────────────────────────────────────┘
                            │  MCP 调用 / 心跳 / 进度回写
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  MTask 中枢（编排大脑，常驻进程）                      │
│                                                                        │
│  ┌─────────── 观测层 ──────────┐  ┌────────── 决策层（AI 监控 AI）──┐ │
│  │ exec_sessions 表            │  │ SupervisorService（周期 tick）  │ │
│  │   平台/会话/任务/心跳/进度  │  │  1) 状态快照（待办/会话/停滞）  │ │
│  │ mtask_report_progress(MCP)  │  │  2) 调「决策 LLM」裁决动作      │ │
│  │ + ai_state expireStale 兜底 │  │  3) 安全护栏（并发/重试/预算）  │ │
│  └────────────┬───────────────┘  └────────────┬───────────────────┘ │
│               │ 写入                            │ 输出 action plan     │
│               ▼                                 ▼                      │
│  ┌─────────── 状态层 ──────────┐  ┌────────── 执行层 ──────────────┐ │
│  │ tasks.ai_state / exec_*     │  │ QueueService（派发状态机）     │ │
│  │ queue_jobs（回执/ ticket）  │  │ WorkBuddyAdapter.submit/poll  │ │
│  └────────────┬───────────────┘  └────────────┬───────────────────┘ │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │ 触发：续跑 / 换台 / 排水下一待办
                                 └──────► 回到外部平台（闭环）
```

**闭环流转**：Supervisor 周期 tick → 采集状态快照 → 调决策 LLM → 得到动作（CONTINUE/RESUME/REDISPATCH/SPLIT/ESCALATE）→ 执行层落库触发 → 外部平台执行并回写心跳/结果 → 状态层更新 → 下一 tick。

---

## 3. 观测层：让 MTask「看见」执行会话

核心问题：外部平台不暴露进程级 API，但**平台可主动上报**。WorkBuddy / Trae 均支持以 MCP 客户端接入 MTask，因此让其在执行期间**周期性回调**即可获得会话可见性。

### 3.1 新增数据表 `exec_sessions`
```sql
CREATE TABLE exec_sessions (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,        -- 'workbuddy' | 'trae' | 'relay:xxx'
  session_id    TEXT,                 -- 平台侧会话标识（中继回传）
  task_ids      TEXT NOT NULL,        -- 本轮负责的关联任务 id（JSON 数组）
  status        TEXT NOT NULL DEFAULT 'active', -- active|stalled|done|failed|aborted
  progress      REAL DEFAULT 0,       -- 0~100
  phase         TEXT DEFAULT '',      -- 当前阶段描述（由平台回传）
  last_heartbeat TEXT NOT NULL,       -- 最近一次心跳时间
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX idx_exec_platform_status ON exec_sessions(platform, status);
CREATE INDEX idx_exec_heartbeat ON exec_sessions(last_heartbeat);
```

### 3.2 新增 MCP 工具 `mtask_report_progress`
供外部平台在执行中周期调用（建议每 30~60s 一次）：
```
mtask_report_progress(platform, session_id, task_id, phase?, pct?, note?)
```
- 落库/更新 `exec_sessions`（按 `platform+session_id` upsert），刷新 `last_heartbeat`。
- 同步把对应任务的 `ai_state` 置 `running` + `ai_state_at=now`（复用现有状态机，前端动画继续转）。
- 若 `pct>=100` 或平台声明完成，session 置 `done`、任务走 `mtask_write_task_status`/'unread' 终态。

### 3.3 停滞兜底（不依赖平台配合）
即使平台不发心跳，复用 `TaskService.expireStaleRunning()` 逻辑：Supervisor 也检查 `exec_sessions` 中 `last_heartbeat` 超过阈值（默认 10min，可配 `supervisor.sessionStaleMs`）的会话，置 `stalled`。

---

## 4. 决策层：AI 监控 AI 的核心

### 4.1 `SupervisorService`（常驻监督器）
- 复用 `RecurringService.tick()` 的驱动方式，新增 `supervisorTick()`，**每 30s** 执行一次（频率可配 `supervisor.intervalMs`）。
- 单例、幂等：先 `SELECT` 是否有 `active`/`stalled` 会话或 `running` 任务，无则空转返回，避免无谓 LLM 调用。

### 4.2 状态快照（输入给决策 LLM）
```ts
interface MonitorSnapshot {
  pending:  { taskId: string; title: string; deps: Dep[]; priority: string }[]; // 待办
  sessions: { platform: string; status: string; progress: number; stale: boolean }[];
  failed:   { taskId: string; aiState: string; retryCount: number }[];   // 失败/超时
  budget:   { usedTokens: number; maxTokens: number; concurrent: number; maxConcurrent: number };
}
```

### 4.3 决策 LLM（结构化输出，带护栏）
复用 `AIService.askJson`（自带截断重试 + JSON 解析校验）调一个「监控专用」模型，输入快照，输出动作计划：
```json
{
  "actions": [
    { "type": "CONTINUE",      "taskId": "…", "reason": "会话健康，等待心跳" },
    { "type": "RESUME",        "taskId": "…", "platform": "workbuddy", "reason": "会话停滞 12min，触发续跑" },
    { "type": "REDISPATCH",    "taskId": "…", "toPlatform": "trae", "reason": "WB 连续失败，换台" },
    { "type": "SPLIT",         "taskId": "…", "reason": "复杂度过高，建议拆子任务" },
    { "type": "ESCALATE",      "taskId": "…", "reason": "重试 3 次仍失败，需人工" }
  ]
}
```
**决策永远受护栏约束**（见 §6），LLM 只「建议」，护栏「拍板」。

---

## 5. 执行层：自动触发外部平台

| 动作 | 拉取式（推荐，WB/Trae 支持 MCP） | 推送式（中继，不支持 MCP 的平台） |
|------|--------------------------------|----------------------------------|
| **排水下一待办** | Supervisor 把 `pending` 中**无未完成前置依赖**的任务标记 `ready`；平台经 `mtask_list_tasks`（过滤 `ai_state='' & status='todo' & monitor_ready=1`）拉走执行 | Supervisor 用 `QueueService.submitAll` / `WorkBuddyAdapter.submit` 派发 |
| **RESUME 续跑** | 重新把 stalled 任务标记 `ready`，平台再次拉取；必要时经 WB 自动化/Skill 唤醒 | `WorkBuddyAdapter.submit` 重新提交（复用 ticket/poll） |
| **REDISPATCH 换台** | 改任务的 `monitor_preferred_platform` 字段，平台选择时偏好该平台 | 用另一 `type` 的适配器 submit |
| **SPLIT 拆分** | 调 `mtask_create_task` 生成子任务并挂 `parent_id` | 同左 |
| **ESCALATE 升级** | 写 `task_events` 通知 + 置 `ai_state='failed'` 等人工 | 同左 |

**依赖感知连续执行**：复用 `plan_tasks.deps`（`[{id,type:'serial'|'parallel'}]`）。Supervisor 排水时按依赖拓扑排序，serial 任务严格先后，parallel 可并发投给不同平台会话，最大化「持续执行」吞吐。

**无人值守唤醒（拉取式关键）**：平台侧需一个轻量「自动化/Skill」周期消费 MTask 待办（如 WorkBuddy 自动化定时说「处理 MTask 就绪待办」）。这是路线 A 实现「无人值守」的唯一前提，MTask 侧零改动。

---

## 6. 安全护栏（防止「AI 失控狂跑」）

决策 LLM 的输出一律过护栏，任何动作被拦截则降级为 `ESCALATE`：
- **最大并发会话** `supervisor.maxConcurrent`（默认 2，防把多平台跑满）。
- **单任务重试上限** `supervisor.maxRetry`（默认 3，超限 → ESCALATE 人工）。
- **冷却窗口** `supervisor.cooldownMs`：同一任务两次触发间隔下限，防抖动循环。
- **成本/额度预算** `supervisor.tokenBudget`：决策 LLM + 执行 LLM 累计 token 超预算即暂停自动触发，转人工。
- **一键熔断（kill-switch）**：`supervisor.enabled=0` 时 Supervisor 完全停摆，所有任务保持现状，人工接管。
- **审计**：每次决策与动作写 `monitor_runs` 表（快照摘要 + 动作 + 是否护栏拦截），前端可回溯「AI 为什么这么做」。

---

## 7. 数据模型 / 接口增量清单

**新增表**：`exec_sessions`、`monitor_runs`（审计）。
**tasks 增量列**：`monitor_ready INTEGER DEFAULT 0`（待平台拉取）、`monitor_preferred_platform TEXT`、`monitor_retry INTEGER DEFAULT 0`、`exec_session_id TEXT`。
**新增 MCP 工具**：`mtask_report_progress`（上报）、`mtask_list_ready_tasks`（平台拉取就绪待办）、`mtask_claim_task`（原子认领，防多平台抢同一任务）、`mtask_supervisor_status`（查监督器状态/最近决策）。
**复用**：`mtask_list_tasks` / `mtask_write_task_status` / `mtask_update_task_result` / `mtask_create_task` / `QueueService` / `WorkBuddyAdapter`。

---

## 8. 分阶段落地路线

- **P0（可视，零风险）**：建 `exec_sessions` + `mtask_report_progress`；外部平台接 MCP 后开始上报；前端「执行会话」面板展示存活/进度/停滞。**仅观测，不自动动作。**
- **P1（监督+告警）**：`SupervisorService` + `supervisorTick`；停滞检测 + `task_events` 通知 + 通知中心红点（复用 `listAiPending`）。仍不自动续跑。
- **P2（自动闭环）**：接入决策 LLM + 护栏；实现 RESUME/REDISPATCH/排水；`monitor_runs` 审计。默认 `supervisor.enabled=0`，需用户显式开启。
- **P3（多平台+依赖排水+成本护栏）**：Trae 接入、`plan_deps` 依赖排序、token 预算、熔断面板。达成完整「AI 监控 AI 持续执行」。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 外部平台无任务注入 API（可行性评估已确认） | 走 MCP **拉取式**（平台主动消费就绪待办）+ 中继推送兜底；MTask 不依赖平台私有 API |
| 误触发导致重复执行/污染 | `mtask_claim_task` 原子认领 + 冷却窗口 + 重试上限 |
| 成本失控 | token 预算 + 最大并发 + 默认关闭自动触发 |
| 决策 LLM 幻觉给出危险动作 | 护栏白名单（仅 5 类安全动作）+ 审计回溯 + 一键熔断 |
| 跨机部署网络不通 | `tunnel-service` 暴露公网；`api_tokens` 鉴权 |
| 循环失败刷屏 | 重试上限 + 升级人工 + 冷却 |

---

## 10. 与本仓库既有方案的关系

- 本方案是 `MTask发送任务到WorkBuddy-可行性评估.md` 的**演进**：从「单次派发 / 手动触发」升级为「闭环持续编排 / AI 监督」。
- 复用面极广：MCP `mtask_*`、QueueService 状态机、WorkBuddyAdapter、ai_state 状态机、RecurringService tick、tunnel、api_tokens —— **几乎无需新建执行/接入能力，主要是「新增监督决策层 + 会话可见性 + 护栏」**。
