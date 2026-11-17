# 九期 · A 通道平台适配现状（实机核对）

> 日期：2026-11-17；对应任务：T05797~T05799、T05801~T05804。
> 本文只记录本机实际探测结果；未实测的平台能力不写成“已支持”。

## 总览

| 平台 | MCP 客户端/连接 | 可无头触发 | A 通道可落地性 | B0 通用性 |
|---|---|---|---|---|
| WorkBuddy | 已配置 MTask MCP（`~/.workbuddy/mcp.json`） | WorkBuddy Automation（1 小时间隔） | 可用，自动化未验收 | B0 已验证本地网关传输/Agent 执行；真实云端账号未验收 |
| Qoder（Qcoder） | 公开资料称支持 MCP，本机未配置 | 无 `qoder`/`qoder-cli`；只有 Electron IDE | **阻塞**：缺 headless CLI/客户端配置 | 不适用（无本地 run 网关） |
| Trae | 公开资料称支持 MCP，本机未配置 | `trae` 只是 VS Code 编辑器 CLI，无 `exec`/prompt | **阻塞**：缺 headless CLI/平台触发器 | 不适用 |
| 豆包 / 豆包工作 | 需自定义 MCP 连接器 | 平台定时任务/对话触发，本机未配 | **阻塞**：自定义连接器与定时未配置 | 不适用（无本地网关） |
| Codex | 支持 MCP；`codex exec` 本机可用 | `codex exec` 可无头，但 provider 不可达 | **阻塞**：模型 provider 不可用 | 不适用 |

## Qoder

- 安装目录：`F:\Program Files\Qoder CN`，版本目录 `.qoder-versions\0.5.13`。
- `Get-Command qoder,qoder-cli`、`where.exe qoder` 均无命中。
- `resources\bin` 仅 `appshot_bare_modifier_monitor.exe`、`dji_mic_button.node`、`native_clipboard.node`、`notification_permission.node`，不是 prompt CLI。
- `@qoder-ai/qoder-cn-agent-sdk` 未发现 CLI/bin 入口。
- 结论：Qoder A 通道必须先有 **MCP 客户端配置 + 定时/触发入口**；当前只能人工在 IDE 内使用，不能自动排水。

## Trae

- `F:\Program Files\Trae CN\bin\trae.cmd` 指向 VS Code `out\cli.js`。
- `trae --help` 输出 `Trae CN 3.4.20`，参数为 diff/merge/add/goto/new-window/wait/extensions 等编辑器选项，没有 `exec`/`-p`/prompt。
- 结论：不能把 `trae` 当 Agent CLI；Trae A 通道需要平台内 MCP + 定时器/智能体触发，当前未配置。

## 豆包 / 豆包工作

- 本机未发现豆包本地 run 网关；MTask 通过 MCP/HTTP 访问，需在豆包侧添加自定义 MCP 连接器。
- 豆包定时任务/自动触发的具体入口与权限未实测。
- 结论：A 通道协议层可行，但连接器、鉴权、定时触发三项都未落地。

## Codex

- `npx @openai/codex@0.169.0` 可用；`codex exec` 支持 stdin prompt、`--cd`、`--sandbox`、`--model`、`--skip-git-repo-check`。
- `codex doctor` 报 provider endpoints unreachable；默认 `127.0.0.1:57321` 未监听。
- Agnes `responses` 不接受 Codex 的 `tools[4].type=namespace`；OpenAI provider 连接超时。
- 结论：Codex CLI 本体可用，但当前无可用模型 provider；A 通道/适配器都要等 provider 恢复后再实测。

## 对 T05801~T05804 的统一结论

1. **通用 A 核心不需要为每个平台重写**：仍是 `list_ready_tasks → claim_task → progress → result → done`。
2. **平台薄适配器缺的是“启动器 + MCP 客户端配置 + 账号权限”**，不是 MTask 协议。
3. 在没有平台真实客户端的情况下，把任务标“已完成/已验证”属于伪验收；本轮按阻塞记录，保留待办。
4. 推荐顺序：先 WorkBuddy A（已有技能）跑通定时排水，再 Qoder/Trae 的 MCP 客户端，再豆包自定义连接器，最后 Codex（依赖 provider）。
