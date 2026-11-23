# T06309 全局错误处理：兜底组件与用户提示

- 任务：T06309「[PRD] 统一错误处理」，priority urgent
- 关联需求：REQ-035「反馈与无障碍」，priority p0
- 实现范围：React 渲染/生命周期异常 + `window` 未处理异步异常；**网络异常不接管**
- 结论：已交付全局兜底组件并接入应用入口，静态门 34/34、浏览器 UI 门 19/19 PASS；错误面板与提示条 axe 扫描均为 0 个 serious/critical。

## 1. 问题与根因

改动前：

- 未挂载 React `ErrorBoundary`。任一组件 render/lifecycle 抛错都会让 React 卸载整棵子tree，用户只看到空白页，没有解释、没有重试入口。
- `window.onerror` / `unhandledrejection` 未监听。事件回调、`setTimeout`、未处理 Promise 的异常只进控制台，用户无感知。
- 各页面虽有局部 `useNotice` 提示，但只能在各自页面内使用，没有应用级兜底。

## 2. 实现

| 文件 | 改动 |
|---|---|
| `web/src/ui/GlobalErrorBoundary.tsx` | 新增 `GlobalErrorBoundary`、`ErrorFallback`、`GlobalErrorWatcher`、`GlobalErrorToast`、`toErrorMessage`、`isNetworkError` |
| `web/src/ui/globalError.css` | 新增兜底面板与全局提示条样式，固定层覆盖，不改变页面布局；使用 semantic token 与 `focus-visible` 焦点环 |
| `web/src/main.tsx` | 在 `App` 外层包裹 `GlobalErrorBoundary` > `GlobalErrorWatcher`，并引入样式 |
| `scripts/tests/verify-t06309-global-error.mts` | 新增 34 项静态/SSR 校验 |
| `scripts/tests/verify-t06309-ui.mjs` | 新增 19 项真实 Chrome UI 校验（含 axe） |
| `scripts/tests/run-esbuild-gate.mjs` | 在 tsx/esbuild JS 包缺失时，用独立 esbuild 二进制打包再执行校验脚本 |
| `package.json` | 新增 `verify:t06309`、`verify:t06309-ui` |

行为：

1. **渲染异常**：`getDerivedStateFromError` 切到兜底面板，`componentDidCatch` 记录控制台；面板 `role=alert`、`aria-live=assertive`、自动获得焦点，提供「重试当前页面」「重新加载应用」和可展开错误详情。
2. **异步异常**：监听 `error` 与 `unhandledrejection`，显示底部提示条（`role=alert`，自动聚焦），支持「重新加载」「关闭」；重复同文案 5 秒内去重。
3. **网络异常**：`Failed to fetch`、`NetworkError`、`Load failed`、`AbortError`、`ECONNREFUSED` 等不进入全局兜底，仍由业务页面原有提示处理，避免误报为页面崩溃。
4. **重试**：`retry` 清空边界错误状态并重新渲染子树；若错误持续存在，会再次被捕获，不会白屏。
5. **可访问性**：按钮均有可见文字与 38px 触控高度，`focus-visible` 3px 焦点环，颜色使用 `--mt-semantic-*` token，兼容 light/dark/high-contrast。

## 3. 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 静态/SSR 门 | `npm run verify:t06309` | **34 PASS / 0 FAIL** |
| 浏览器 UI 门 | `npm run verify:t06309-ui` | **19 PASS / 0 FAIL** |
| axe（兜底面板） | Chrome + axe-core 4.10.2，WCAG 2 A/AA | **0 violations / 0 serious-critical** |
| axe（全局提示条） | 同上 | **0 violations / 0 serious-critical** |
| Web 类型检查 | `node node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json` | **exit 0**（依赖恢复后复跑；日志见 `evidence/t06309-typecheck-web.log`） |
| 全站构建 | `npm --workspace web run build` | **exit 0**，Vite 产物生成成功（日志见 `evidence/t06309-build-web.log`） |

UI 实测证据：

- 初始渲染异常 → 兜底面板出现，焦点进入 `DIV` 面板，按钮可聚焦，无横向溢出（1258×802，overflowX 0）。
- 点「重试当前页面」→ 页面恢复 `#stable`，兜底面板消失。
- `setTimeout` 抛错 / 未处理 Promise → 提示条出现，文案包含异常消息，焦点进入提示条，点「关闭」后消失。
- `Promise.reject(new TypeError('Failed to fetch'))` → 900ms 内无提示条，网络异常被正确排除。
- axe 两次扫描均 0 violations。

## 4. 验证缺口与边界

- AC-05 的“关键路径 axe 0 严重问题”本轮只覆盖新增错误面板与提示条；全站关键路径扫描仍应由 T06310「无障碍修复」承接，不在本任务里冒充全站通过。
- 未处理网络异常是任务明确边界，仍由各业务调用点显示原提示。
- 真实 Electron 生产包未替换；本任务只改 web 源码与测试门。

## 5. 证据清单

- `evidence/t06309-verify-static.log`：34/34 静态门原始日志
- `evidence/t06309-ui.log`：19/19 UI 门原始日志（含 axe 结果）
- `evidence/cdp-t06309.json`：逐项断言 JSON
- `evidence/01-error-boundary.png`：渲染异常兜底面板
- `evidence/02-global-error-toast.png`：异步异常提示条
- `evidence/t06309-typecheck-web.log`：Web 类型检查 `exit 0`
- `evidence/t06309-build-web.log`：Vite 全站构建 `exit 0`
