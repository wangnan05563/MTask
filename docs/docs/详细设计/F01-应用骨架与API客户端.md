# F01 应用骨架与 API 客户端

> 覆盖：`App.tsx`、`settings.tsx`、`api/client.ts`、`api/sse.ts`、`stores/beautifyStore.ts`、`ui/*`
> 定位：前端最底层——桌面/移动布局判定、Tab 路由、主题字号、统一网络封装、通用组件与跨 Tab 状态。其余页面均依赖本层。

---

## 1. App.tsx — 应用骨架与路由

**职责**：顶层壳 + 路由；桌面/移动布局判定；挂载全局命令面板；启动探测。

**关键导出**：
- `App()`：调 `resolveUiMode()` → `<SettingsProvider>` 包裹 `<MobileShell/>`（移动）或 `<Shell/>`（桌面）；挂载 `<CommandPalette/>`；启动 `GET /health` + `GET /tunnel/config`（同步访问令牌到 `setAccessToken`）。
- `Shell()`：桌面布局——顶部 `TABS` 导航栏 + 后端连接状态（3 态：未知/已连接/未连接）+ 按 `tab` 状态条件挂载页面。
- `resolveUiMode()`：返回 `'mobile'|'desktop'`；优先级 `URL ?m=1/0` → `localStorage('mtask.uiMode')` → 自动探测（`ontouchstart` + `matchMedia('(max-width:820px)')`）。

**桌面导航 `TABS`**（顺序即菜单）：任务(ListTodo)、模型(Boxes)、提示词(ScrollText)、通用需求(Lightbulb)、项目计划(CalendarRange)、周报(BarChart3)、队列(ListOrdered)、设置(Settings)。
> 注：`LogsPage`、`ArchivePage` 已移出主导航（T00441），改为 设置 → 日志 / 归档 子 Tab。

**路由方式**：**in-app 状态**（无 react-router），`tab` state 决定挂载页；切换 Tab 不卸载的跨 Tab 状态用 `stores/*` + `ui/session.ts` 持久化。

## 2. settings.tsx — 主题/字号 Provider

**职责**：全局主题/字体/字号，CSS 变量驱动，持久化 `localStorage('settings.prefs')`。

- `SettingsProvider({children})`：注入主题 CSS（`data-theme`）、字体族、`--fs-*` 字号变量。
- `useSettings()`：`{ prefs, update }`；类型 `Theme/FontKey/FontSizeKey/ImportMode/SettingsPrefs`；常量 `FONT_OPTIONS/FONT_SIZE_OPTIONS/FONT_MAP/FONT_SIZE_MAP`。

## 3. api/client.ts — 统一 fetch 封装

**职责**：薄封装，统一 `/api`（浏览器）或 `api://mtask`（Electron）基址；附加 `X-Access-Token`；非 2xx 抛错；解析 JSON/JSON 错误。

**导出（动词对象 `api`）**：
- `api.get/post/patch/del<T>(path, data?, signal?)`、`api.getBinary(path)`（ArrayBuffer）、`api.postBinary<T>(path, ArrayBuffer)`、`api.download(path, data)`（`{blob, filename}`，解析 `Content-Disposition`）、`api.openChangeStream(onChange)`（订阅 `GET /api/events` SSE，token 经 query）。
- `setAccessToken(token)`、`apiBase`、类型 `Project/Task/TaskImage/TaskCategory/AITool/Queue/QueueJob/PromptCategory/Prompt/ReqCategory/ReqEntry`。
- 图片辅助：`imageUrl(id)`、`fetchImage(id)`、`imageDataURL(id)`（`<img src>` 直用）。

> **重要**：`api/client.ts` 无按域 helper（如 `tasks.create()`）；各页面以字面路径调用 `api.post('/tasks', {...})`。设计文档隐含「强类型 API 客户端」当前不存在，调用为 ad-hoc 字符串路径。

## 4. api/sse.ts — SSE 消费（报表流式）

**职责**：低层 SSE 消费，独立于 JSON `api` 对象，避免流式语义污染通用封装。

- `streamEvents(path, data, onEvent)`：`POST` 后读响应体为 SSE 流，对每个 `event:`/`data:` 块派发 `(eventName, payload)`；流结束 resolve，HTTP 错误 reject。
- 消费：`POST /report/ai-generate-stream`（事件 `stage/chunk/done/error`）。

## 5. stores/beautifyStore.ts — 跨 Tab 状态

**职责**：「AI 标题美化」运行状态（并行单+批，草稿保留），跨 Tab 存活。

- 导出 `beautifyStore`（`subscribe/getSnapshot/aborts/setBusy/clearBusy/setBatchBusy/setDraft/mergeDrafts/cancelAll`）、类型 `BeautifySnapshot { busy, batchBusy, drafts }`。

## 6. ui/* — 通用组件

| 文件 | 职责 |
|------|------|
| `Markdown.tsx` | 安全 Markdown 渲染（markdown-it `html:false` 防 XSS）+ 预览/源码切换 + 复制 |
| `PinToggle.tsx` | 置顶切换按钮（gold Pin / grey PinOff，停冒泡） |
| `busy.ts` | 全局「操作中」标志（按 key，`useSyncExternalStore`，防重复提交） |
| `dialogs.tsx` | Promise 式模态（替代 Electron 下失效的 `window.prompt/confirm`）：`askInput`/`askConfirm` |
| `format.ts` | 时间格式化：`relTime`（刚刚/x分钟前…）、`fullTime`（YYYY-MM-DD HH:mm） |
| `session.ts` | `useSessionState`（sessionStorage）/ `usePersistentState`（localStorage）——半填表单跨 Tab 存活 |

## 7. 依赖与边界

- 依赖：纯 `react` / `react-dom` / `lucide-react` / `markdown-it`（叶子层，无内部业务依赖）。
- 边界：`apiBase` 在 `file://` 下为 `api://mtask`，否则 `/api`；访问令牌统一经 `X-Access-Token`；Electron 下 `window.prompt/confirm` 不可用，须用 `dialogs.tsx`；SSE 令牌经 query 携带（EventSource 不能自定义头）。
