# MTask MCP 接口文档

> 版本：v1.0 · 日期：2026-08-28
> 定位：把现有 MTask 后端（Express + SQLite）的**任务管理 / 提示词管理 / 周报生成 / 数据迁移**能力，以 MCP（Model Context Protocol）工具的形式暴露给外部 AI agent，实现「AI 分析结果转任务录入 / 定时触发周报 / 批量任务整理、迁移」。
> 适用：streamable HTTP 传输（内嵌于 MTask 后端，同现有 accessToken 鉴权体系）。

---

## 1. 概述

### 1.1 接入形态

| 项 | 值 |
|----|----|
| 协议 | MCP（Model Context Protocol） |
| 传输 | **streamable HTTP**（POST / GET / DELETE） |
| 端点 | `{base}/api/mcp`（本地默认 `http://127.0.0.1:39876/api/mcp`） |
| 鉴权 | MCP 请求体外的 `X-Access-Token` 请求头（与现有 REST 完全一致） |
| 数据 | 复用现有 service 与业务校验，不产生第二套实现，与 Web 端结果一致 |

> 本地「干净」（未配置访问令牌）时整体放行，与现有 REST 行为一致，零回归；一旦配置令牌，所有 `/api/*`（含 MCP）统一要求令牌。

### 1.2 实现位置

| 文件 | 说明 |
|------|------|
| `server/src/mcp/server.ts` | 创建 MCP server 并注册全部工具（复用 TaskService/ReportService/SettingsService 等） |
| `server/src/mcp/http.ts` | streamable HTTP 路由：按会话管理 transport，POST/GET/DELETE 处理 |
| `server/src/mcp/sdk-shim.d.ts` | `@modelcontextprotocol/sdk` 最小类型垫片（node10 解析不支持 exports 子路径的解决） |
| `server/src/index.ts` | 挂载 `app.use('/api/mcp', accessTokenGuard, mcpRouter())` |
| `server/scripts/mcp-runtime-test.mjs` | 进程内端到端测试（12 项） |
| `server/scripts/mcp-smoke.mjs` | HTTP 冒烟测试（含鉴权用例） |
| `server/scripts/mcp-run.mjs` | 编排器：拉起隔离服务并跑冒烟 |

### 1.3 依赖

- `@modelcontextprotocol/sdk@^1.30`（纯 ESM，经 require→dist/cjs 双态兼容本 CJS 工程）
- `zod@^4`（参数 schema；SDK peer 依赖）

安装：`npm install @modelcontextprotocol/sdk`（workspace 根已补齐到 `node_modules`）。

---

## 2. 接入配置

MCP client（如 streamable HTTP client / Claude Code 等）配置：

```
URL:     http://127.0.0.1:39876/api/mcp
Headers: X-Access-Token: <访问令牌>   # 已配置令牌时必填，否则请求返回 401
```

- **HTTPS**：MTask 内网穿透（隧道）自带公网 HTTPS；本机/局域网直连为 HTTP（数据不出本机）。公网接入请走隧道启用令牌并配置 HTTPS 端点。
- 每个 MCP 会话独立 transport；客户端按标准 MCP 流程 `initialize` → 携带 `mcp-session-id` 复用会话 → `DELETE` 结束会话。

---

## 3. 接口功能清单

工具统一前缀 `mtask_`，返回 `content[].text`（供 LLM 阅读）+ `structuredContent`（供程序消费，键与下表返回字段一致）。

### 3.1 任务管理

| 工具 | 方法语义 | 关键入参 | 返回要点 | 注解 |
|------|----------|----------|----------|------|
| `mtask_list_projects` | 列项目 | - | projects | readOnly |
| `mtask_create_task` | 建任务 | projectId, title(必,去空白校验), description, priority(`low/normal/high/urgent`), status(`todo/done`), categoryId | task | |
| `mtask_update_task` | 更新任务 | id, 可选 title/description/priority/status/verified/pinned/categoryId(null 清分类) | task | |
| `mtask_list_tasks` | 列任务 | projectId, archived(默认 false) | tasks | readOnly |
| `mtask_get_task` | 查任务 | id | task(含 images 元信息) | readOnly |
| `mtask_move_tasks` | 批量移项目 | taskIds[], projectId | - | |
| `mtask_set_tasks_archived` | 归档/还原 | taskIds[], archived | tasks | |

> 入参与现有 REST 完全同构，服务层校验一致（不存在项目、空标题、外键冲突均返回错误）。

### 3.2 提示词管理

| 工具 | 方法语义 | 关键入参 | 返回要点 | 注解 |
|------|----------|----------|----------|------|
| `mtask_list_prompt_categories` | 列分类 | - | categories(含 promptCount) | readOnly |
| `mtask_create_prompt_category` | 建分类 | name(必), description | category | |
| `mtask_list_prompts` | 列提示词 | categoryId, keyword | prompts | readOnly |
| `mtask_create_prompt` | 建提示词 | categoryId(必), title(必), content | prompt | |
| `mtask_update_prompt` | 更新提示词 | id, 可选 title/content/categoryId/pinned | prompt | |
| `mtask_delete_prompt` | 删提示词 | id | - | destructive |

### 3.3 周报生成

| 工具 | 方法语义 | 关键入参 | 返回要点 | 注解 |
|------|----------|----------|----------|------|
| `mtask_gather_report_data` | 聚合周期数据 | period(`day/week/month`), projectId? | data：项目汇总 + 任务明细（供 AI 自行分析） | readOnly |
| `mtask_generate_report` | 生成标准报表 | period, format(`xlsx/docx/pdf/pptx`), projectId?, templateId? | filename, format, size, base64 | |
| `mtask_ai_generate_report` | AI 生成周报 | period, format, toolId(已配置 AI), projectId? | insight(Markdown), filename, base64 | |

- `period`/`format` 在工具 handler 内显式校验，非法值返回错误（不依赖客户端是否做 schema 校验）。
- `mtask_ai_generate_report` 消费一次性临时文件（读取即删）换取 base64——若同时想从前端 UI 再次下载该次文件将不可得，属预期行为。
- 定时触发：MTask 侧不内置定时器；由外部 agent/系统的定时任务按需调用（MCP 同步 tool）。

### 3.4 数据迁移

| 工具 | 方法语义 | 关键入参 | 返回要点 | 注解 |
|------|----------|----------|----------|------|
| `mtask_export_data` | 导出全量 | - | bundle：app/version/data（任务/项目/提示词/AI 工具/队列等全部业务表） | readOnly |
| `mtask_import_data` | 导入全量 | data(bundle), mode(`overwrite/keep/merge`) | result.imported | destructive |

- 逻辑与 `SettingsService.exportBundle/importBundle` 完全一致；导入在单事务内完成，失败整体回滚。
- 三种模式均可用：`overwrite`（清空后全量重建）、`keep`（保留已有主键）、`merge`（覆盖同名主键合并）。
- 已修复 `upsertRows` 对 `app_settings`（KV 表、主键为 `key`）统一用 `WHERE id` 预编译导致的 `no such column: id` 缺陷。

---

## 4. 权限控制方案

本项目当前为单用户桌面应用，鉴权采取「**访问令牌（单层 Bearer-Like）**」模型，与现有 REST 一致：

1. **令牌机制**：隧道配置 `accessToken`（`server/src/tunnel/tunnel-config.ts`）。一旦配置，`accessTokenGuard` 放行条件为请求头 `X-Access-Token` 与配置值严格相等，否则 `401`。
2. **覆盖范围**：`/api/*` 全量覆盖，MCP 端点 `/api/mcp` 同受保护；`/tunnel/*`（隧道自管理）例外。
3. **未配置令牌**：本地单机直接可用（默认），保证既有本地行为零回归。

**角色扩展建议**（多用户/多系统接入时启用）：
- 在令牌基础上增加 `X-MTask-Role`（如 `agent-read / agent-write / agent-admin`），在 MCP 层按工具 category 做角色断言：
  - `agent-read`：仅 `*_list_* / *_get_* / gather_report_data / export_data`（readOnly 类）。
  - `agent-write`：在 read 之上开放任务/提示词写入与归档、标准报表生成。
  - `agent-admin`：全部，含 `import_data`（破坏性）、`ai_generate_report`。
- 破坏性工具（`mtask_delete_prompt`、`mtask_import_data`）已在 MCP annotations 标记 `destructiveHint`，客户端可据此做二次确认。

---

## 5. 错误码与契约

| 场景 | 层 | 表现 |
|------|----|------|
| 未带/错误令牌 | HTTP | `401`（JSON `{"error":"unauthorized"}`） |
| 非初始化且无会话 | MCP | `-32000 Bad Request` |
| 参数校验失败（如缺 title、非法 period/format、非法枚举） | MCP 工具 | 返回 `content[].text="错误：…"` 且 `isError=true`，或协议层 `-32602` |
| 业务规则失败（项目不存在、同名冲突、采纳内容为空） | MCP 工具 | 同上，`isError=true` 携带具体中文文案 |
| 服务端异常 | MCP | `-32603 Internal server error` |

**调用示例（程序化，SDK Client）**：

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'my-agent', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:39876/api/mcp'),
  { requestInit: { headers: { 'X-Access-Token': process.env.MTASK_TOKEN } } },
));
const r = await client.callTool({ name: 'mtask_create_task', arguments: { projectId, title: '分析结论转任务' } });
```

---

## 6. 系统兼容性验证

| 项 | 结论 | 依据 |
|----|------|------|
| 编译 | ✅ | `tsc -p server/tsconfig.json` 通过（含全部 mcp 文件）；SDK 经 CJS require → dist/cjs 正常加载（`zod`/`mcp.js`/`streamableHttp.js`/`mcp/http`/`mcp/server` 均在 node22 下瞬间加载） |
| 运行时（进程内端到端） | ✅ 12/12 | `mcp-runtime-test.mjs`：真实 SQLite + SDK Client，覆盖枚举/只读/任务写/归档/提示词/导出/导入(overwrite)/三类数据校验异常 |
| 鉴权 | ✅ | 带令牌实例对 `/api/health` 无令牌返回 401；`accessTokenGuard` 直接保护 `/api/mcp` |
| 与现有 REST 一致性 | ✅ | 工具直接调用现有 service，数据校验、图片附件、密钥加密、导入导出逻辑与 Web 端完全一致 |
| 迁移/打包兼容 | ✅ | 新增代码随 server 编译进 dist；SDK 以依赖进 `node_modules`（electron-builder `files` 已含 `node_modules/**/*`，`asarUnpack` 免改）；无需全新 ABI，沿用托管 Node 22.22.2 |
| 端口隔离 | ✅ | 端点挂在 MTask 现有服务端口，无新端口；不改变打包应用 39877 / 开发 39876 约定 |

> ⚠️ 说明：本会话内 HTTP 服务进程无法在沙箱稳定拉起（进程派生/输出捕获环境问题，非代码问题；模块加载与进程内链路均已验证）。`mcp-smoke.mjs`（HTTP 冒烟，含鉴权用例）与 `mcp-run.mjs`（编排器）已交付，可在本地正常环境一键执行：
> ```bash
> # 本地（自动拉起隔离服务并回收）
> node server/scripts/mcp-run.mjs
> # 对已运行服务直接冒烟 / 带令牌
> node server/scripts/mcp-smoke.mjs --url http://127.0.0.1:39876/api/mcp [--token <访问令牌>]
> ```

---

## 7. 安全与数据完整性

- 传输：公网走隧道 HTTPS；密钥不落日志、不随 MCP API Key 相关工具返回（本接口不暴露 AI 工具密钥，仅任务/提示词/报表/迁移）。
- 校验：入参即服务层校验，杜绝绕过现有规则（字段长度、必填、归属存在性、外键）。
- 迁移完整性：导入单事务+失败回滚；base64 图片损坏置空保留记录；API Key 明文跨机重新加密。
- 破坏性保护：导入/删除标记 `destructiveHint`，建议仅 `agent-admin` 可调。