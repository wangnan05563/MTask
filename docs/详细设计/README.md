# MTask 详细设计文档导航

> 本目录为 `docs/概要设计.md` 的配套「逐模块详细设计」。每个文件聚焦一个子系统/模块，结构统一为：职责、关键接口、数据结构、依赖、核心流程、边界与异常处理。
> 内容基于 2026-09-12 代码现状（`server/src`、`web/src`）逐文件核对，非推测。

## 后端（server/src）

| 文件 | 覆盖模块 |
|------|----------|
| [B01-数据层与基础设施.md](B01-数据层与基础设施.md) | `db/connection`、`db/schema`、`util/crypto`、`util/ttl-cache`、`AppSettings`、`ChangeBus`、`LogService` |
| [B02-AI适配器与AI服务.md](B02-AI适配器与AI服务.md) | `adapters/*`（types/index/netutil/openaiCompat/claude/ollama/workbuddy）、`AIService` |
| [B03-任务与分类模块.md](B03-任务与分类模块.md) | `TaskService`、`TaskCategoryService`、`TaskImageService`、`ArchiveService` |
| [B04-队列分发模块.md](B04-队列分发模块.md) | `QueueService`（Job 状态机、异步轮询收口） |
| [B05-计划管理模块.md](B05-计划管理模块.md) | `PlanService`（串行瀑布、节假日、Excel、AI 解析） |
| [B06-报表与控制台模块.md](B06-报表与控制台模块.md) | `ReportService`、`report-builder`、`report-worker`、`ConsoleJobService` |
| [B07-提示词与通用需求模块.md](B07-提示词与通用需求模块.md) | `ReqService`（提示词仓库 + 通用需求仓库） |
| [B08-配置更新与迁移模块.md](B08-配置更新与迁移模块.md) | `ConfigService`、`UpdateService`、`SettingsService` |
| [B09-数据维护模块.md](B09-数据维护模块.md) | `DbAdminService`、`routes/dbadmin` |
| [B10-内网穿透模块.md](B10-内网穿透模块.md) | `tunnel/*`、`routes/tunnel` |
| [B11-路由与REST接口.md](B11-路由与REST接口.md) | `routes/index`、`routes/plans`、服务启动 `index.ts`、`SSE /api/events` |
| [B12-MCP服务.md](B12-MCP服务.md) | `mcp/server`、`mcp/http`（21 个工具） |

## 前端（web/src）

| 文件 | 覆盖模块 |
|------|----------|
| [F01-应用骨架与API客户端.md](F01-应用骨架与API客户端.md) | `App.tsx`、`settings.tsx`、`api/client`、`api/sse`、`stores/beautifyStore`、`ui/*` |
| [F02-任务与模型页面.md](F02-任务与模型页面.md) | `TasksPage`、`AIToolsPage`、`UsagePanel` |
| [F03-计划提示词需求页面.md](F03-计划提示词需求页面.md) | `PlanPage`、`PromptsPage`、`ReqPage` |
| [F04-报表队列设置页面.md](F04-报表队列设置页面.md) | `ReportPage`、`ReportConsole`、`reportStream`、`QueuePage`、`SettingsPage` 及子视图、`CommandPalette`、`HelpTab` |
| [F05-移动端.md](F05-移动端.md) | `mobile/*`（Shell/Home/QuickNote/Queue/Prompts/More/offline） |

## 编号约定

- `Bxx` = Backend（后端）；`Fxx` = Frontend（前端）。
- 接口签名以「方法 + 路径 / 函数名 + 关键参数」记录，完整清单见对应源码与 `docs/MCP接口文档.md`。
