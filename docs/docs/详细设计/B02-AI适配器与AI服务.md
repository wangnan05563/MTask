# B02 AI 适配器与 AI 服务

> 覆盖：`adapters/types.ts`、`adapters/index.ts`、`adapters/netutil.ts`、`adapters/openaiCompat.ts`、`adapters/claude.ts`、`adapters/ollama.ts`、`adapters/workbuddy.ts`、`services/AIService.ts`
> 定位：AI 接入的统一抽象层（适配器）与调用编排层（AIService）。FR2 梳理 / FR4 分发 / 控制台问答 / 优化 / 分类 均经此层；密钥运行时不落日志。

---

## 1. adapters/types.ts — 统一接口

**核心类型**：
- `TaskContext { taskId, title, description, aiSummary?, projectName, attachments? }`
- `ToolConfig { endpoint, model?, temperature?, maxTokens?, timeoutMs?, apiKey? }`（apiKey 仅运行时解密传入）
- `JobResult { ok, content?, error?, rawMeta? }`
- `ModelsResult { ok, models?, message? }`
- `SubmitResult { ok, accepted?, ticket?, content?, error? }`（异步受理语义）
- `PollResult { status: 'running'|'success'|'failed'|'timeout', content?, error? }`
- `StreamResult { ok, content?, error? }`

**`AIAdapter` 接口**：
```ts
interface AIAdapter {
  readonly type: string;
  testConnection(config): Promise<{ ok; message }>;
  listModels(config): Promise<ModelsResult>;
  chat(system, user, config): Promise<JobResult>;          // 通用单轮
  chatStream(system, user, config, onDelta): Promise<StreamResult>; // 增量回调
  send(context, config): Promise<JobResult>;               // 任务执行
  submit?(context, config): Promise<SubmitResult>;         // 可选：异步提交
  poll?(ticket, config): Promise<PollResult>;              // 可选：异步轮询
}
```
- `AdapterType = 'openai-compatible' | 'claude' | 'ollama' | 'workbuddy'`。

## 2. adapters/index.ts — 注册表

- 导出 `getAdapter(type)`、`listAdapterTypes()`、`testAdapter(type, config)`、`listAdapterModels(type, config)`。
- 映射：`openai-compatible→OpenAICompatAdapter`、`claude→ClaudeAdapter`、`ollama→OllamaAdapter`、`workbuddy→WorkBuddyAdapter`。

## 3. adapters/netutil.ts — 共享网络工具

- `withTimeout(p, ms)`：Promise 竞速超时（超时抛错，触发 Job `timeout`）。
- `formatHttpError(status, errText)`：解析 OpenAI 兼容 `error.message`。
- `normalizeModels(json)`：归一化 `{data:[{id}]}` 或 `{models:[{name}]}` → `string[]`。
- `readStreamLines(res, onLine)`：逐行读流式响应（兼容 `data:` 前缀与纯 JSON 行）。

## 4. 各适配器协议细节

### 4.1 OpenAICompatAdapter（`openai-compatible`）
- `baseUrl()` 自动补 `/v1`（兼容「填根域名/填到 /v1」两种习惯）。
- `testConnection` → `GET {base}/models`（Bearer）；`listModels` 同端点归一化。
- `chat` → `POST {base}/chat/completions`，body `{model, messages:[system,user], temperature, max_tokens}`。
- `chatStream`：`stream:true`，逐 `choices[0].delta.content` 回调，AbortController 超时。
- `send`：固定系统提示「开发任务执行者」，user 拼【项目/任务/描述/AI摘要/附件】。

### 4.2 ClaudeAdapter（`claude`）
- endpoint 为根地址；头 `x-api-key` + `anthropic-version: 2023-06-01`。
- `chat` → `POST {base}/v1/messages`，body 顶层 `system` + `messages`，解析 `content[]` 文本块拼接。
- `chatStream`：解析 `content_block_delta` / `text_delta`。

### 4.3 OllamaAdapter（`ollama`）
- `testConnection` → `GET {base}/api/tags`；`listModels` 同端点 `{models:[{name}]}`。
- `chat` → `POST {base}/api/chat`（`stream:false`），prompt 为 `system\n\nuser`。
- `chatStream` → `stream:true`，逐行 `message.content`（纯 JSON 行，无 `data:` 前缀）。

### 4.4 WorkBuddyAdapter（`workbuddy`）— 中继/回调型
- endpoint 视为「任务派发目标 URL」，JSON 契约带 `action`：`ping`/`chat`/`send`/`send_submit`/`send_poll`。
- `listModels` 不支持（返回 `ok:false`）。
- `submit()`：`POST action:'send_submit'`；`accepted→{ok,accepted:true,ticket}`；否则同步 `content`。
- `poll()`：`POST action:'send_poll'` + `ticket`；`status` 映射 success/failed/running。
- `chatStream`：不支持增量，回退一次性 `onDelta(整段)`。

## 5. services/AIService.ts — 调用编排

**职责**：统一编排 adapter 调用，串联 梳理/分发/问答/优化/分类，并记录用量。

**关键方法**：
- `organize(taskIds, toolId)`：循环调 `adapter.send`，结果仅存文本待人工合并（回填 `ai_summary`）。
- `optimizeText` / `beautifyTitle`：通用单轮 `chat`；`stripPromptHeading`/`stripThinking` 净化输出（锁简体）。
- `ask(toolId, system, user, timeoutMs?)`：通用单轮问答（控制台用）。
- `askStream(...)`：流式问答（`onDelta` 增量，报表/控制台 SSE 用）。
- `classifyCategory(title, categories, toolId)`：分类匹配（精确优先 + 最长包含兜底）。
- `buildSender()` → `send(job)`：取 `runtimeWithModel(job.tool_id)` → adapter，`snapshotTaskContext` 固化上下文后 `adapter.send`。
- `buildSubmitter()` → `submit(job)`：若 adapter 实现 `submit` 走异步，否则回退 `send`（零回归）。
- `buildPoller()` → `poll(job, ticket)`：`adapter.poll`；`running` 且 `elapsed > config.timeoutMs` 降级 `timeout`。
- `recordUsage(kind, toolId, model, ok, startedAt, contentChars, error?)`：写 `ai_usage`。
- `runtimeWithModel(toolId)`：取运行时配置并校验 `model` 已配置（未配置抛 `MODEL_UNCONFIGURED`，前端提示先配模型，不静默回退）。

**依赖**：`ConfigService`（解密密钥）、`QueueService`、`TaskService`、`adapters/*`、`ai_usage`。

---

## 核心流程

1. **同步分发**：`QueueService.sendAll` → `AIService.buildSender().send(job)` 串行保序 → `JobResult` 写 `response_payload`。
2. **异步分发**：`QueueService.submitAll` → `buildSubmitter().submit(job)` → 受理 `ticket` → 主进程 5s 轮询 `buildPoller().poll(ticket)` 收口。
3. **梳理/优化/分类**：前端调用 `POST /ai/organize|beautify|optimize|classify` → `AIService` 对应方法 → 结果回前端（草稿确认或即时回填）。
4. **用量记录**：每次调用结束 `recordUsage`，供 `UsagePanel`（`GET /ai/usage`）聚合展示。

## 边界与异常处理

- 密钥仅运行时解密传入 adapter，绝不落日志/落库明文。
- `withTimeout` 保证超时进入 `timeout` 状态（异步）或抛错（同步失败态）。
- 模型未配置时不静默回退，抛 `MODEL_UNCONFIGURED`。
- WorkBuddy 作为中继型适配器，未实现 `submit` 时由 `buildSubmitter` 自动回退 `send`。
