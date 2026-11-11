# Reference 5 —— 前端 UI 任务防护（主题 / 弹层 / 会话 / 验证降级）

本文件沉淀前端 UI 类任务（样式冲突、主题适配、弹层组件、会话失效）的通用排查与修复规则，以及「无法真实验证时」的降级验证路径。所有**具体值**（CSS 变量、token key、验证命令、症状关键词）均以 `config/config.yaml` 的 `frontend-guard` / `session-recovery` / `validation` 节为准；本文只描述方法与判断逻辑，不写死任何参数。

## 一、主题适配排查清单（通用）

处理任何「颜色 / 样式 / 主题」类前端任务时，按下述顺序排查：

1. **颜色是否取自主题变量**
   - 组件颜色必须引用 `frontend-guard.theme-css-variables` 中列出的 CSS 变量，禁止硬编码 `rgba(...)` / `#hex` 常量。
   - 发现硬编码 → 替换为对应主题变量；变量缺失时先补到 config.yaml 再使用。
2. **弹层 / 悬浮层是否受 scoped 限制**
   - tooltip、popover、dropdown 等通常渲染在组件 DOM 之外，Vue 的 scoped 样式不命中。
   - 处置：给弹层加 `popper-class` 自定义类，用**非 scoped** `<style>` 段编写样式（见 `frontend-guard.scoped-pitfall`）。
3. **深色背景 vs 浅色文字（或反之）冲突**
   - 弹层默认背景常与主题文字对比度冲突 → 背景改主题卡片变量、文字色随主题，箭头 / 描边同步（按 `frontend-guard.component-fixes` 命中规则处置）。
4. **响应式 / 窄屏溢出**
   - 检查最小宽度下是否溢出、遮挡、横向滚动；优先用 CSS 变量与弹性布局，不写死像素断点。

## 二、会话失效恢复流程（后端重载 / 密钥轮换后）

典型场景：后端热重载（如 tsx watch）或 JWT 密钥轮换 → 前端已存凭据失效 → 接口 401 / 白屏 / 跳回登录。

1. 先核对 `session-recovery.symptom-keywords` 是否命中当前症状（401 / 会话失效 / 重新登录…）。
2. 命中 → 按 `session-recovery.actions` 序列执行：清除 `token-storage-key` 对应 localStorage → 刷新页面 → 重新登录。
3. 若「进程仍在但会话整体失效」，优先走清凭据 + 刷新 + 重登，**不要误判为接口缺陷而改代码**。

## 三、验证等级与降级路径（无法真实验证时）

真实链路无法触发时（缺 API key / 外部依赖 / 无运行环境），按 `validation.enabled-dimensions` 顺序逐级降级，并在结论文档「验证」节**如实标注到达的等级**：

| 等级 | 名称 | 手段 | 文档标注 |
|---|---|---|---|
| L1 | 静态自检 | `validation.static-check-commands`（按技术栈取） | 「静态自检通过」 |
| L2 | 运行时探测 | 启动服务，探测健康端点 / 页面可达 | 「运行时可达」 |
| L3 | DOM 断言 | 浏览器自动化断言关键文案 / 元素可见 | 「DOM 断言」 |
| L4 | 数据链路（模拟） | 用 mock / 模拟事件驱动链路（如 SSE 完成事件）验证数据流存在 | 「模拟验证，需真实环境复测」 |

- 到达 L4 仍未闭环：明确标注「需在 XX 环境实测」，不做伪验证、不置 done。
- `validation.allow-runtime-only-on-static-fail=false` 时，静态自检失败**不可**仅凭运行时声称通过。

## 四、常见陷阱速查（来自实际踩坑）

- **状态快照不刷新**：setup store 的普通 getter 对动态状态可能只读初始快照 → 用 `computed` 暴露动态值。
- **后端路由未注册**：新增/恢复接口后 404 → 检查路由是否在入口显式注册（如 `registerXxxRoute`）。
- **前端部署产物残留**：构建后旧资源未清 → 先删旧 dist / public 再重建，避免新旧共存导致 404。
- **错误归类误判**：区分「网络错误」与「接口报错」，别把 4xx / 5xx 一律当成服务未启动；把后端返回的 error 原文透传，避免前端二次猜测。
- **a11y 批修例外（T02143）**：「div role=button 转原生 button」这类规则**不得用于内含交互子元素的容器**——
  容器改原生 button 会让内部角标/置顶/重置按钮变成非法 DOM（`validateDOMNesting`）。
  该告警只在 dev 模式打，生产构建剥掉、`tsc` 也不报，所以批修必须 dev + 浏览器取证；
  div role=button 需自带 `tabIndex={0}` + `onKeyDown`（并判 `e.target !== e.currentTarget` 防子按钮按键冒泡），
  且脱离全局 `button:hover/:active` 后要补容器级手感规则，否则微交互观感静默回退。