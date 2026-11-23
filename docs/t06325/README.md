# T06325 统一 B0/A/D 角色标识为中文或英文简称

## 结论

派发链路的 B0/A/D 已统一为可读名称，同时保留全部机器契约：

| 机器值 | 中文主名 | 中文短名 | 英文短名 | 平台值 | 行为 |
|---|---|---|---|---|---|
| B0 | CodeBuddy 网关 | 网关 | Gateway | codebuddy-gateway | 主动推送，自动链路首选 |
| A | MCP 就绪池 | 就绪池 | ReadyPool | mcp | 任务放回就绪池，等外部 Agent 拉取 |
| D | 人工确认 | 人工 | Manual | d-gui | 只标记待人工确认，自动链路永不自动执行 |
| auto | 自动派发 | 自动 | Auto | — | 网关 → 就绪池 → 人工兜底 |

任务描述中的 `B0=基础用户 / A=管理员 / D=开发者` 是错误假设，已按九期 PRD 纠正。命名单源：

- 服务端 `server/src/services/DispatchChannels.ts`
- 前端 `web/src/ui/dispatchChannel.ts`

## 兼容边界

以下内容**保持不变**，避免破坏历史审计、REST 调用和排障检索：

- 通道机器值 `B0 / A / D` 与 API 值 `b0 / a / d / auto`
- `dispatch_attempts.channel` 审计字段
- REST 请求/响应与错误码前缀 `B0_*`、`A_NOT_READY`、`D_MANUAL_ONLY`
- 平台值 `codebuddy-gateway / mcp / d-gui`
- 内部 API 字段 `b0`、`b0ToolId`（UI 不再显示代号，但契约不强制改名）

## 代码改动

- 新增服务端三通道命名表与前端通道元数据/可读化/错误码映射。
- `PushDispatcher` 方法改为语义名：`classifyGatewayError`、`fallbackToReadyPool`、`escalateToManualConfirm`、`toGatewayAttempt`；`status()` 增加只读 `channels` 元数据。
- `DispatchPolicy` 改为 `resolveGatewayTool` / `validateGatewayTool`，校验文案统一为「CodeBuddy 网关」。
- 服务端日志、注释、失败说明、隔离边界说明同步改为可读名称；风险识别正则保留旧词 B0 作为兼容检索词。
- 前端派发菜单、最近派发、派发策略、派发记录、执行会话、帮助页、队列 pill、设置搜索全部改为可读名称。
- 完整文件级清单见 `02-代码变更清单.csv`，界面/文案清单见 `03-UI与文案变更清单.csv`。

### 附带修复：派发菜单在抽屉内不可见

独立 UI 实测发现：`DispatchMenu` 的面板用 `position: fixed` 渲染在任务详情抽屉内部，而抽屉的 `transform` 会成为 fixed 元素的包含块并裁剪超出面板，导致面板 DOM 存在但视觉不可见。已将面板通过 `createPortal` 挂到 `document.body`，恢复正确的视口定位与层叠顺序。

## 验证

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run verify:t06325` | 40 / 40 PASS |
| `npm run verify:t06244` | 67 / 67 PASS |
| `npm run verify:t06273-persist` | 7 / 7 PASS |
| `npm run verify:t06325-ui` | 17 / 17 PASS（隔离后端 39886 + Chrome CDP） |
| Web 构建 | `npm run build:web` PASS（tsc + vite，1855 modules，48.94s） |

完整矩阵与证据见 `04-测试与验证矩阵.csv`，截图与日志在 `evidence/`：

- `02-dispatch-menu-1500.png`：派发菜单三通道主名（portal 修复后可见）
- `02a-drawer-open.png`：任务详情抽屉
- `03-policy-1500.png`：派发策略三通道状态与口径
- `04-dispatch-records-1500.png`：派发记录说明
- `05-exec-sessions-1500.png`：执行会话说明
- `cdp-t06325.json`：17 项断言的原始结果与菜单文本
- `t06325-verify-*.log`、`t06325-build-web-portal.log`：各验证命令原始输出

## 产物与提交

- 源码提交：`451c2834ab81489eaea7f7cf9c8ed2908fe6b61c`（30 个源码文件，+420/−178）
- 后续校正提交：抽屉内派发菜单 portal 修复、两套验证脚本（`scripts/tests` 被 `.gitignore` 忽略，需 `git add -f`）、`package.json` 验证命令、本目录文档
- UI 实测 JSON：`D:\tmp\mtask-t06325\ui\cdp-t06325.json`

## 复现

```powershell
Set-Location D:\code\otherProjects\MTask
npm run typecheck
npm run verify:t06325
npm run verify:t06244
npm run verify:t06273-persist
npm run verify:t06325-ui
```

UI 门使用临时 `DATA_DIR` 和端口 39886，不写入生产库、不触碰生产 39877。启动器先实例化 `better-sqlite3` 探测 ABI，失败时回落 Electron-as-node。
