# 九期 · 按平台具名 Token 与角色隔离（草案）

> 状态：设计草案，等待用户确认角色矩阵后实施；本文件不包含任何真实 token。
> 对应任务：T05800。

## 1. 现状与问题

当前 MTask MCP/HTTP 使用单一 `X-Access-Token`：

- 无法区分调用方是 WorkBuddy、Qoder、Trae、豆包还是 Codex；
- `mtask_list_ready_tasks` / `mtask_claim_task` 只凭 `platform` 字符串区分，平台名可被任意冒用；
- 同一 token 可跨项目读/写，多平台并行时权限过大；
- 审计只能记录 token 是否有效，不能回溯“哪个平台、哪个项目、什么角色”。

## 2. 建议数据模型

在 `api_tokens` 增补（保留既有 `scope` 兼容旧凭据）：

| 字段 | 取值 | 说明 |
|---|---|---|
| `platform` | `workbuddy` / `qoder` / `trae` / `doubao` / `codex` / `*` | 绑定平台；`*` 仅给本机管理员或迁移期旧 token |
| `project_scope` | JSON 数组或 `*` | 允许访问的 projectId 列表；空/`*` 表示不限制（不推荐生产） |
| `role` | `read` / `claim` / `write` | 只读 / 只允许 claim+progress / 允许 result+done |
| `label` | 自由文本 | 便于审计识别，如“九期-Qoder-排水器” |

建议角色矩阵（待用户确认）：

| 平台 | 读任务 | claim | progress | result | done/归档 | 项目范围 |
|---|---|---|---|---|---|---|
| WorkBuddy | 是 | 是 | 是 | 是 | 是 | 仅 MTask 九期 |
| Qoder | 是 | 是 | 是 | 是 | 是 | 仅 MTask 九期 |
| Trae | 是 | 是 | 是 | 是 | 是 | 仅 MTask 九期 |
| 豆包 | 是 | 是 | 是 | 是 | 是 | 仅 MTask 九期 |
| Codex | 是 | 是 | 是 | 是 | 是 | 仅 MTask 九期 |
| 监控/看板 | 是 | 否 | 否 | 否 | 否 | 只读 |

> 如果用户希望“平台只能看到自己被分配的任务”，还需增加 `monitor_preferred_platform` 的强制匹配；本草案先不改任务分配语义。

## 3. 服务端校验点

1. **认证层**：`accessTokenGuard` 返回 token 记录（platform/projectScope/role），而不是只返回 scope。
2. **MCP 工具层**：每个工具声明所需角色：
   - `mtask_supervisor_status`、`mtask_list_ready_tasks`、`mtask_get_task` → `read`
   - `mtask_claim_task`、`mtask_report_progress` → `claim`
   - `mtask_update_task_result`、`mtask_write_task_status`、`mtask_update_task` → `write`
3. **平台绑定**：工具入参 `platform` 必须等于 token 的 `platform`；管理员 token (`*`) 例外。
4. **项目范围**：`projectId` 或任务所属 projectId 必须在 `project_scope` 内；越界返回 403。
5. **审计**：每次 claim/result/write 记录 `tokenId/platform/projectId/action/result`，不记录 token 明文。

## 4. 迁移路径

- 旧 token：`scope=write`、`platform=*`、`project_scope=*`，行为不变；
- 新平台 token：一个平台一个 token，只绑定 MTask 九期；
- 先只读/监控 token 上线，再切 claim/write；
- 轮换：新增 token 验证通过后停用旧 token，不直接删除。

## 5. 验收清单（实施后）

- [ ] Qoder token 无法 claim `platform=workbuddy` 的任务；
- [ ] `projectId` 范围外请求返回 403；
- [ ] 只读 token 调 claim/result 被拒；
- [ ] 旧单 token 仍可完成一次 list→claim→result；
- [ ] 审计日志可按平台/tokenId 回溯，且无明文 token；
- [ ] 不改变 A/B0/CLI 任务生命周期。

## 6. 待确认

角色矩阵、是否强制 `monitor_preferred_platform`、是否需要企业版 OAuth，均需用户确认后再冻结；确认前不建议直接在 `api_tokens` 写入生产 token。
