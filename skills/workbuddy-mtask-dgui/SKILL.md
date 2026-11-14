---
name: workbuddy-mtask-dgui
description: MTask D 应急通道（GUI 直驱）操作手册：人工确认后，用 Playwright MCP 的无障碍快照（role/name/ref）驱动 WorkBuddy 桌面 UI 执行一条任务，全程截图/日志留痕，结果按四段模板回传并保持 verified=false。禁止无人值守。
---

# WorkBuddy × MTask D 通道（GUI 应急）

## 何时使用

仅当 B0（CodeBuddy 本地网关）不可用、且 A（MCP 拉取）在约定窗口内未接住任务时使用。
D 是**应急通道**，不是常规分发路径；每次运行必须由人明确确认，禁止挂 Automation、禁止无人值守。

## 前置检查（全部只读）

1. `GET /api/dispatch/status` 或 `mtask_supervisor_status`：确认 B0 未配置/不可达、A `readyTasks=0` 或 A 已关闭。
2. `mtask_get_task {taskNo}` 读取目标任务：只接受 `status=todo`、`archived=0`、`ai_state=''` 的任务；
   已被认领/已完成/已归档的任务不得走 D。
3. 记录本次 D 运行三要素：任务号、操作者、人工确认时间。
4. 启动审计会话（仓库内脚本，强制人工闸门）：

```
node D:\code\otherProjects\MTask\scripts\d-gui\d-channel.mjs start ^
  --task T05749 ^
  --task-title "<任务标题>" ^
  --prompt-file "<任务提示词文件>" ^
  --page-title "<只读快照看到的页面标题>" ^
  --account "<登录账号脱敏值，如 hs***>" ^
  --workspace "<工作空间名>" ^
  --operator "<操作者>" ^
  --confirm
```

- 必须带 `--confirm`；缺省直接拒绝启动。
- 脚本会拒绝明显含密码/token 赋值的提示词，并写 `logs/d-channel/<session>.jsonl`。
- 记下返回的 `sessionId`，后续 step/finish 都用它。

## 人工闸门（不可跳过）

开始操作 GUI 前，把以下四项展示给人并等待明确确认：

```
页面标题：<title>
登录账号：<脱敏账号>
工作空间：<workspace>
目标任务：Txxxxx <标题>
```

人回复「确认执行 D 通道 Txxxxx」才继续；任何一项不符、或页面停在登录/验证码/权限弹窗，
立即停止并转人工，不要自行输入密码、扫码或授予权限。

## GUI 操作（Playwright MCP 优先）

1. `browser_navigate` 到 WorkBuddy 本地 UI 地址（以当前进程实际端口为准）。
2. `browser_snapshot` 取无障碍树，确认页面标题、账号、工作空间、目标任务与人工确认一致。
3. 用 `browser_type` 按快照中的 `ref` 定位输入框，输入**任务标题 + 任务说明**；不要输入密码/token/
   与本任务无关的账号信息。
4. 提交后循环：`browser_snapshot` → 判断状态 → `browser_click`（ref）→ 再 `browser_snapshot`。
   **不使用纯截图坐标**，不使用 `click_xy` 猜位置。
5. 每步调用审计脚本：

```
node D:\code\otherProjects\MTask\scripts\d-gui\d-channel.mjs step ^
  --session <sessionId> --action "browser_snapshot" --result ok --note "<页面状态摘要>"
```

6. 限制：最多 40 步、最长 15 分钟；任一超限立即 `finish --status failed`，不得继续。
7. 急停：操作者说停、出现非预期弹窗、要求输入凭据、页面跳到外部站点，立即停止并转人工。

## 截图与脱敏

- 每次关键状态（登录后、提交前、结果页）用 `browser_take_screenshot` 留证，保存到
  `logs/d-channel/<session>/`。
- 截图必须遮蔽账号头像/昵称、邮箱、token、工作空间路径中的用户名段；可用 Playwright 截图 mask
  或在保存后用系统画图工具遮盖，禁止把未脱敏原图写入仓库或任务结果。
- 日志只记动作名、ref、页面状态摘要和结果，不记完整 DOM、不记密码/token。

## 结果回传（固定模板）

```
## 根因
<任务要解决的问题/背景>

## 影响范围
<受影响页面/接口/用户/模块>

## 修复
<GUI 操作实际做了什么；无代码改动则写实际处置>

## 验证
<页面结果截图/日志路径；明确「D 通道人工触发，未经 B0/A」>

---
通道：D（GUI 直驱，人工触发）
操作者：<operator>
任务：Txxxxx
会话：<sessionId>
完成时间：<ISO 时间>
```

调用顺序：

```
mtask_update_task_result { taskNo:"Txxxxx", result:"<上述 Markdown>" }
mtask_report_progress { platform:"d-gui", session_id:"<sessionId>", task_id:"Txxxxx", done:true, pct:100, phase:"D 通道完工" }
mtask_update_task { taskNo:"Txxxxx", status:"done" }
```

- **不要传 `verified:false`** 给 `mtask_update_task`：会回退 todo；D 通道结果保持未验证，由人工复核。
- 结果里必须写「D 通道、人工触发」；如有截图路径，写绝对路径。

## 失败/超时

```
node ...\d-channel.mjs finish --session <sessionId> --status failed --note "<原因>"
mtask_report_progress { platform:"d-gui", session_id:"<sessionId>", task_id:"Txxxxx", failed:true, phase:"D 通道失败：<原因>" }
mtask_write_task_status { taskNo:"Txxxxx", state:"failed" }
mtask_update_task { taskNo:"Txxxxx", verified:false, feedback:"<原因 + 已操作到哪一步>" }
```

- 失败必须转人工，不得自动换任务重试。
- 若 D 运行期间 B0/A 恢复，停止 D，交回自动通道，不要双跑。

## 安全红线

- 不把密码、token、Cookie、私钥写入 prompt、日志、任务结果或截图文件名。
- 不绕过登录/验证码/MFA；遇到即转人工。
- 不操作与任务无关的窗口、文件、浏览器标签；不读取用户私人数据。
- 不开启无人值守；D 运行结束（成功/失败）必须关闭审计会话。
