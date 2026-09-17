# B12 MCP 服务

> 覆盖：`mcp/server.ts`、`mcp/http.ts`、`mcp/sdk-shim.d.ts`
> 定位：把现有 service 能力以 **MCP（Model Context Protocol）Streamable HTTP** 暴露给外部 AI Agent。复用 service，无第二套实现。端点 `/api/mcp`，受 `X-Access-Token` 保护。详细字段见 `docs/MCP接口文档.md`。

---

## 1. mcp/server.ts — 工具注册

**导出**：`async createMCPServer(): Promise<McpServer>`（`name:'mtask', version:'1.0.0'`）。

**注册函数与返回约定**：
- `ok(text, data)` / `err(msg)` / `resolveTask({id,taskNo})` / `taskLocateError()`（id 或 taskNo 定位）。
- 统一返回 `{ content:[{type:'text'}], structuredContent }`，失败标 `isError:true` + 中文错误文本。

**21 个工具**（注册 `server.registerTool('mtask_*', {...})`）：

| # | 工具 | 用途 | 关键参数 |
|---|------|------|----------|
| 1 | `mtask_list_projects` | 列出全部项目 | — |
| 2 | `mtask_create_task` | 建任务（默认项目/查重/父子层级） | projectId?, title, description?, priority?, status?, categoryId?, parentId?, dedupe? |
| 3 | `mtask_list_plans` | 列项目计划（串行瀑布+关联待办号） | projectId?, projectName?, includeArchived? |
| 4 | `mtask_create_plans` | 批量建计划（WBS 拆行，首条 startDate 锚点） | projectId?, projectName?, items[] |
| 5 | `mtask_update_task` | 更新任务（id 或 taskNo） | id?, taskNo?, title?, description?, priority?, status?, verified?, pinned?, categoryId? |
| 6 | `mtask_list_tasks` | 列任务（默认待处理+未验证） | projectId?, projectName?, status?, scope?, archived? |
| 7 | `mtask_get_task` | 查单任务（含 task_no/截图元信息） | id?, taskNo? |
| 8 | `mtask_update_task_result` | 同步处理结果（handle_result） | id?, taskNo?, result |
| 9 | `mtask_move_tasks` | 批量移项目 | taskIds[], projectId |
| 10 | `mtask_set_tasks_archived` | 归档/还原 | taskIds[], archived |
| 11 | `mtask_list_prompt_categories` | 提示词分类+计数 | — |
| 12 | `mtask_create_prompt_category` | 建提示词分类 | name, description? |
| 13 | `mtask_list_prompts` | 列提示词（分类/关键词） | categoryId?, keyword? |
| 14 | `mtask_create_prompt` | 建提示词 | categoryId, title, content? |
| 15 | `mtask_update_prompt` | 更提示词 | id, title?, content?, categoryId?, pinned? |
| 16 | `mtask_delete_prompt` | 删提示词 | id |
| 17 | `mtask_gather_report_data` | 聚合周期数据（只读） | period, projectId? |
| 18 | `mtask_generate_report` | 生成报表文件（base64） | period, format, projectId?, templateId? |
| 19 | `mtask_ai_generate_report` | AI 周报（洞察+文件 base64） | period, format, toolId, projectId? |
| 20 | `mtask_export_data` | 导出全量 bundle | — |
| 21 | `mtask_import_data` | 导入 bundle（destructiveHint） | data, mode: overwrite\|keep\|merge |

**依赖**：`TaskService`、`PlanService`、`ArchiveService`、`ReportService`（gather/generate/ai/读取）、`SettingsService`、`AppSettings`、`getDb`、`zod`（入参校验）。

## 2. mcp/http.ts — 传输层

**导出**：`mcpRouter()`，挂载 `/api/mcp`；用 `StreamableHTTPServerTransport` 管理会话；鉴权复用现有 `accessTokenGuard`（`X-Access-Token`）。

**协议**：JSON-RPC 2.0；会话经 `mcp-session-id` 头关联。
- 首次 `initialize` 建立会话；会话中 `notifications/initialized` + `tools/*`；`DELETE /api/mcp` 终止会话。
- 错误码：`-32700` 解析错误 / `-32600` 无效请求 / `-32601` 方法未找到 / `-32602` 无效参数 / `-32603` 内部错误 / `-32000` 无效会话 / `401` 未授权 / 业务 `isError:true`。

## 3. mcp/sdk-shim.d.ts

`@modelcontextprotocol/sdk` 类型垫片（node10 模块解析兼容），使 TS 正确识别 SDK 类型。

## 4. 边界与约定

- MCP 工具**复用 service**（如 `TaskService`、`PlanService`、`ReportService`、`SettingsService`），不重复实现业务逻辑；`taskNo` 定位与查重逻辑与 REST 一致。
- 会话级鉴权与 REST 同源；未配置令牌时整体放行（本地模式）。
- `mtask_import_data` 标注 `destructiveHint`（overwrite 危险），由调用方确认。
- 报表类工具返回 base64 + 文件名，与 REST `/report/*` 同合成路径（经 `report-worker`）。
