---
name: workbuddy-mtask-dispatch
description: WorkBuddy 侧的 MTask A 通道薄适配器：平台值固定 workbuddy，负责 Automation/手动触发与 WorkBuddy 工作空间约定；任务生命周期遵循通用核心 mtask-agent-dispatch。
---

# WorkBuddy × MTask A 通道适配器

## 先加载通用核心

本文件只定义 **WorkBuddy 平台差异**，不重复任务生命周期。执行前必须读取并遵循：

```text
../mtask-agent-dispatch/SKILL.md
```

如果当前 WorkBuddy 版本不能读取同级目录，先把 `mtask-agent-dispatch` 安装为同一技能根目录下的独立技能，加载后再执行；找不到核心就停止，不要凭记忆重写一套。

## 平台固定配置

| 配置 | 值 |
|---|---|
| `MTASK_PLATFORM` | `workbuddy` |
| `MTASK_SESSION_PREFIX` | `workbuddy` |
| `MTASK_LIMIT` | `2` |
| `MTASK_PROJECT_ID` | 多项目共用时必填；单项目可省略 |

`mtask_list_ready_tasks`、`mtask_claim_task`、`mtask_report_progress` 必须统一使用 `platform: "workbuddy"`。

## 触发方式

1. **Automation 定时排水**：WorkBuddy「自动化」按间隔触发；当前客户端实测最小间隔为「每隔 1 小时」，不要写 10~30 分钟。
2. **人工手动指定**：用户说「处理 MTask 待办」「处理 Txxxx」「执行这个 MTask 任务」时，按核心流程执行；点名 `Txxxxx` 可直接 `mtask_claim_task`，跳过列表。

同一时间只允许一个 WorkBuddy 会话运行本适配器；不要并发开多个 Automation。

## 最小执行清单

按通用核心执行，WorkBuddy 侧只记住以下顺序：

1. `mtask_supervisor_status`：确认 MCP 可达；`readyMarkEnabled=true` 即可拉取，`enabled=false` 不阻断排水。
2. `mtask_list_ready_tasks`：`platform="workbuddy"`、可选 `projectId`、`limit=5`。
3. 对候选逐条 `mtask_claim_task`：`platform="workbuddy"`、`session_id="workbuddy-<yyyyMMddHHmmss>-<随机4位>"`；`conflict=true` 换下一条，不重试。
4. 认领成功后 `mtask_report_progress`，`phase="已认领"`、`pct=5`。
5. 执行时每 30~60 秒心跳；单条完成或失败后才处理下一条；本轮最多 2 条，串行。
6. 结束按核心回传四段结果，再 `progress done`，最后 `mtask_update_task(status="done")`。
7. 失败按核心双写：`progress failed` + `mtask_write_task_status(state="failed")` + `verified:false feedback`。

## WorkBuddy 特定约定

- **Automation**：只保留 1 条，Prompt 使用：

  ```text
  使用 workbuddy-mtask-dispatch 适配器，按 mtask-agent-dispatch 核心执行；platform=workbuddy；最多 2 条串行。
  ```

- **工作空间**：在 WorkBuddy 当前工作空间内实际执行；不因任务描述切换到无关目录，不读取与本任务无关的密钥或配置。
- **安装**：适配器安装到 `%USERPROFILE%\.workbuddy-ai\skills\workbuddy-mtask-dispatch`；通用核心安装到 `%USERPROFILE%\.workbuddy-ai\skills\mtask-agent-dispatch`。
- **急停**：直接在 Automation 面板停用；已认领任务由 MTask 会话超时/人工接管，不要另起一个 Automation 抢同一任务。
- **兼容旧入口**：原有「处理 MTask 待办」和 `workbuddy-mtask-dispatch` 触发词继续有效；内部改为委托通用核心。

## 边界

- 本适配器只做 A 通道；B0（CodeBuddy 网关直推）由 MTask `PushDispatcher` 负责，D（GUI）必须人工确认，均不在这里实现。
- 不创建/修改 Automation 配置以外的平台设置；不建派生单、不改 MTask 任务描述。
- 不把 WorkBuddy 的 1 小时间隔、安装路径或 `platform` 值写进通用核心；这些只属于本适配器。
- A 是拉取不是推送；若用户要求 MTask 主动推送，转 B0 或 CLI Process Adapter，不要用本适配器冒充推送。
