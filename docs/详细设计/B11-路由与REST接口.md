# B11 路由与 REST 接口

> 覆盖：`server/src/index.ts`（启动与中间件）、`routes/index.ts`（主 API 路由器，1260 行）、`routes/plans.ts`（计划路由）、`GET /api/events`（SSE）
> 定位：HTTP 边界总控。所有业务端点经 `routes/index.ts` 聚合挂载 `/api`；计划/数据维护/隧道为子路由；启动文件负责中间件、SSE、静态伺服、队列轮询器。

---

## 1. server/src/index.ts — 启动与中间件

- **端口**：`MTask_PORT`（默认 39876），HOST `127.0.0.1`。
- **尽早拦截 console**：`logService.init()` 使 ready/慢请求日志进入缓冲。
- **请求体上限**：`express.json({ limit: '30mb' })`（覆盖截图粘贴 base64 膨胀）。
- **CORS**：`Access-Control-Allow-Origin: *`（Electron 壳 file:// fetch 本地服务需跨源放行）。
- **慢请求日志**：仅 `≥100ms` 请求记 `方法 路径 状态码 耗时`；不打印密钥字段。
- **访问令牌中间件 `accessTokenGuard`**：配置 `accessToken` 后除 `/tunnel`、`/health`、`/events?token=` 外所有 `/api` 需 `X-Access-Token`；未配置则整体放行。
- **SSE 变更通知** `GET /api/events`：`text/event-stream`，首帧 `hello`，`changeBus.on('change')` 推 `{kind}`；25s 心跳；`req.on('close')` 清理。
- **静态伺服**：`express.static(web/dist)` + SPA 兜底（非 `/api` 未命中回显 index.html），使隧道/浏览器可直接打开 Web 界面。
- **统一错误兜底**：`(err, req, res, next) => 500 {error}`。
- **队列轮询器**：`setInterval(() => QueueService.pollPending(AIService.buildPoller()), 5000)`。
- 挂载顺序：`app.use('/api', accessTokenGuard, api)`、`app.use('/api/mcp', accessTokenGuard, mcpRouter())`、`app.use('/api/tunnel', tunnelRouter)`、`/api/events`（单独）、静态 + SPA 兜底。

## 2. routes/index.ts — 主 API 路由器

`export const api = Router()`，挂载 `/api`。约 90+ 端点，按域分组（完整清单见各模块文档，此处列主干）：

**系统/日志**：`GET /health`、`GET /logs?since=`
**项目**：`GET/POST /projects`、`PATCH/DELETE /projects/:id`（禁删 `sys-inbox`）
**任务**：`GET /tasks`（projectId/archived/limit≤500/offset/keyword/categoryId/sort）、`GET /tasks/by-no/:taskNo`、`POST /tasks`（支持 parentId）、`PATCH /tasks/:id`、`POST /tasks/move`、`POST /tasks/reorder`、`POST /tasks/import-csv/preview|confirm`、`POST /tasks/batch`、`POST /tasks/:id/reuse|to-prompt|to-req|adopt`、`POST /tasks/:id/images`、`GET /tasks/:id/images`、`GET /images/:id`、`DELETE /images/:id`、`POST /tasks/classify`、`POST /prompts/:id/to-task`、`POST /req-entries/:id/to-task`
**任务分类**：`GET/POST /task-categories`、`PATCH/DELETE /task-categories/:id`
**AI 工具**：`GET /aitools`、`GET /aitools/types`、`POST /aitools/reorder`、`POST /aitools/test`、`POST /aitools/models`、`POST/DELETE /aitools`、其他见 B08
**队列**：`GET /queues`、`GET /queues/:id`、`POST /queues`、`POST /queues/:id/jobs`、`DELETE /queues/:id/jobs/:jobId`、`POST /queues/:id/send|submit|reset`
**AI 梳理/优化**：`POST /ai/organize|beautify|optimize|chat`、`POST /ai/generalize-to-req`、`GET /ai/usage`
**报表/模板**：见 B06
**控制台任务**：见 B06（`/console-jobs`）
**提示词/通用需求**：见 B07
**归档**：`POST /archive`、`POST /archive/restore`、`DELETE /archive`
**设置/迁移/更新**：见 B08（`/settings/note-project`、`/settings/export`、`/settings/import`、`/update/*`）
**子路由**：`api.use('/dbadmin', dbAdminApi)`（B09）、`api.use('/plans', planApi)`（B05）

## 3. routes/plans.ts — 计划路由

主路由器子路由，完整端点见 B05。要点：节假日路由注册先于 `/:id`；Excel 导入导出走二进制（`getBinary`/`postBinary`）；AI 解析 `ai-parse`/`ai-parse-doc`；`from-req` 通用需求→计划。

## 4. SSE 事件约定

- `GET /api/events`：推送 `data: {"kind":"tasks"|"plans"|"queue"}`；前端 `api.openChangeStream` 订阅，对应页面自动刷新（TasksPage 用其刷新任务/计划/队列）。
- `POST /report/ai-generate-stream`：推送 `event: stage|chunk|done|error`（报表流式），由 `api/sse.ts` 消费。

## 5. 边界与约定

- 所有写操作经 `db.transaction`；列表类读经 TTL 缓存；写后 `notifyChange` 触发 SSE。
- 错误统一 `{error}`；密钥字段不出现在响应（路由层保证不返回明文密钥）。
- 页码/分页：任务 `limit≤500`；数据维护/日志分页游标（`since` / `offset`）。
