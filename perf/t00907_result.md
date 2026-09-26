# T00907：PRD导入后自动上传并展示确认栏

## 根因

T00824（跳转 AI 工作台并展开导入面板）已就位，但跳转只透传 `projectId`、**不带用户选中的 PRD 文档**——
用户从「PRD 管理」视图点「从PRD导入项目计划」后，仍必须在导入面板里重新手动选文件才能解析，与「从 PRD 导入」的预期不符。

## 影响范围

- `web/src/pages/PrdPanel.tsx`：`goImportPrd` 增加 docId 透传；「从PRD导入项目计划」按钮改为传当前行文档 id。
- `web/src/pages/PrdImportPanel.tsx`：新增 `autoPullDoc` 与一次性消费 `sessionStorage('prd-import.docId')` 的自动带入逻辑。

## 修复（文件绝对路径 + 改动点）

`D:\code\otherProjects\26_MTask\web\src\pages\PrdPanel.tsx`
1. `goImportPrd(docId?)`：跳转时额外写 `sessionStorage['prd-import.docId'] = 当前行文档 id`（仅在传了 docId 时）。
2. 「从PRD导入项目计划」按钮 `onClick` 由 `goImportPrd` 改为 `goImportPrd(d.id)`，把该行 PRD 文档 id 带入。

`D:\code\otherProjects\26_MTask\web\src\pages\PrdImportPanel.tsx`
3. 新增 `autoPullDoc(docId)`：`GET /plans/prd-docs/{id}` 取 `filename + content_md` → 按扩展名构造 `File` →追加进 `pickedFiles`（按文件名去重）→ 控制台日志「已自动带入所选 PRD：…」；拉取失败写入面板 `error` 区兜底提示。
4. 挂载 `useEffect` 一次性消费 `sessionStorage['prd-import.docId']`（读取即 `removeItem` + `useRef` 防 StrictMode 双执行），存在则调 `autoPullDoc`。
5. **设计取舍**：自动带入到「已选文件」确认栏，**不自动触发 AI 解析**——沿用 T00841「选择入列表、确认才解析」既语义，避免跳转即意外消耗一次 AI 模型调用；用户点「确认」后沿用原 `parseAll` 流程。

## 验证（实测证据）

UI 实测（隔离实例：后端 http://127.0.0.1:39576 + 前端 http://127.0.0.1:5175）：
1. 在「wiki」项目用 REST 创建测试 PRD 文档「验证-从PRD导入自动填充.md」（id=321e4eb8-31ef-4a10-9315-4f76fd046522）。
2. 浏览器：进入 wiki 项目计划页 → 「PRD 管理」→ 选中该文档 → 点「从PRD导入项目计划」。
3. 页面自动跳转 AI 工作台并展开「从 PRD 导入项目计划」面板，面板「已选文件（1）」列表出现该文档条目，控制台日志显示「已自动带入所选 PRD」，全程无用户手动选文件。
4. 佐证：`fetch /api/plans/prd-docs/321e4eb8…` 返回 `{filename:"验证-从PRD导入自动填充.md", len:75}`，文档可读。
5. `web` 端 `tsc --noEmit`：EXIT=0，0 错误。
结论：跳转后自动上传（带入）并填充确认栏达成，无需手动干预。

## 本次回写

无派生单。

## 下一步建议（可选）

「上传失败兜底」分支（拉取文档失败写 error 区）为代码保证，本次未单独构造接口故障实测；如需可补一次故障注入覆盖验证。