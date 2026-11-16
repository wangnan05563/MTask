# 平台适配说明

本文件回答两个问题：**哪些平台能消费 MTask A 通道**，以及**平台差异应该放在哪里**。

## 一、先分清“拉取”和“推送”

| 语义 | 谁发起 | 适用方案 | 是否需要平台触发器 |
|---|---|---|---|
| 拉取 | 外部平台定时/人工启动，调用 MTask MCP | A | 需要：Automation、cron、CLI、无头 Agent |
| 推送 | MTask 主动把任务交给平台 | B0、CLI Process Adapter、HTTP 中继 | 不需要平台轮询，但需要平台可被调用 |

A 的通用核心只做拉取。**不要把“MTask 主动推送”写成 A 的能力**；如果目标是推送，应走 B0 或进程适配器。

## 二、平台能力矩阵

> 以下为公开文档/本机已有配置的核对结果，除 WorkBuddy 的 Automation 间隔外，均未在本轮逐一实测。

| 平台 | MCP 客户端 | 平台触发方式 | 建议 platform 值 | A 是否可用 | 备注 |
|---|---|---|---|---|---|
| WorkBuddy | 已配置 | Automation（实测最小“每隔 1 小时”，5.11.3） | `workbuddy` | **可用**，当前首选兜底 | 已有 `workbuddy-mtask-dispatch` 适配器；仍需完成 Automation 与真实 Agent 端到端验收 |
| Qoder（用户也写作 Qcoder） | 公开资料显示支持 | `qoder -p` 无头调用，或平台侧定时能力 | `qoder` | 可做，未实测 | 未发现 `/api/v1/runs`；没有稳定调度时，CLI Process Adapter 更接近“推送” |
| Trae | 公开资料显示支持 | `traecli exec` 非交互调用，或平台侧定时能力 | `trae` | 可做，未实测 | 未发现 `/api/v1/runs`；可做 TraeCliAdapter |
| 豆包 / 豆包工作 | 需自定义 MCP 连接器 | 平台定时任务/对话触发 | `doubao` | 可做，未实测 | 无公开本地 run 网关；B0 不适用；自动触发依赖豆包侧配置 |
| Codex | 支持 MCP / `codex exec` / app-server | CLI 定时或进程调用 | `codex` | 可做，未实测 | 未发现 `/api/v1/runs`；可做 CodexCliAdapter 或 AppServerAdapter |

### 结论

- **协议层是通用的**：MTask 只认 `platform` 字符串和 MCP 工具，Qoder、Trae、豆包、Codex 都可以作为 A 客户端。
- **自动层不是通用的**：每个平台必须有自己的启动器；没有启动器的平台只能人工触发，不能称为“自动排水”。
- **不要因为“支持 MCP”就认定“自动排水已可用”**：还需要 MCP 连接、技能加载、定时器、权限和一次真实端到端任务。

## 三、平台适配器应包含什么

每个平台适配器只放以下差异，不复制任务生命周期：

1. `platform` 固定值；
2. 会话前缀；
3. 启动方式（Automation / cron / CLI / 无头 Agent）；
4. 技能安装目录与加载方式；
5. MCP 连接与凭据来源；
6. 平台权限/工具白名单；
7. 平台特有的最小间隔、并发限制和急停方式。

通用核心放在 `skills/mtask-agent-dispatch/SKILL.md`；平台适配器只引用它。

## 四、WorkBuddy 适配器

- 适配器：`skills/workbuddy-mtask-dispatch/SKILL.md`
- 通用核心：`skills/mtask-agent-dispatch/SKILL.md`
- 安装根目录：`%USERPROFILE%\.workbuddy-ai\skills`
- `platform`：`workbuddy`
- 触发：Automation（建议只保留 1 条，间隔 1 小时）或人工指定 `Txxxxx`
- 当前状态：适配器和核心可安装；Automation 创建、真实 WorkBuddy Agent 端到端仍属于待人工验收项。

## 五、多平台并存的注意事项

1. **平台偏好**：任务上的 `monitor_preferred_platform` 只让匹配的平台看到；未设置偏好的任务所有平台都可能抢到。
2. **项目隔离**：多项目共用时必须传 `projectId`，否则可能跨项目拉取。
3. **原子认领**：`mtask_claim_task` 能防止重复执行，但不能保证“任务一定分给指定平台”；谁先轮询谁拿到。
4. **凭据隔离**：当前 MTask 侧仍是单层 `X-Access-Token`，多平台接入前应补按平台具名 token + 角色权限；不要多个平台共用同一高权限 token。
5. **单平台单实例**：同一平台不要挂多个 Automation 并行；不同平台也不要共享同一个会话标识。
6. **先验收一个**：九期先只保留 WorkBuddy 一个 A 执行端；Qoder/Trae/豆包/Codex 作为后续适配，不同时上线。

## 六、什么情况下不要用 A

- 要求 MTask 主动发起、平台不需要轮询 → 用 B0/CLI Process Adapter/C 类中继。
- 平台没有 MCP 客户端，也没有可调用的无头入口 → A 不可用。
- 平台不能加载技能或不能读取 MCP 工具 → 只能人工执行或另建适配器。
- 需要秒级实时协作 → A 的 Automation 粒度不够，改用推送/进程调用。
