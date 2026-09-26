# SonarQube 代码质量修复报告（2026-09-19）

## 总览

| 项目 | 修复前 | 修复后 |
|------|--------|--------|
| OPEN 问题总数 | **238**（CRITICAL 64 / MAJOR 108 / MINOR 61 / INFO 5） | **0** |
| new_violations（质量门禁） | 238 | **0** ✅ |
| 受影响文件 | 34 | 0 |

- 扫描环境：SonarQube 26.1（localhost:9000）+ sonar-scanner 8.0，项目键 `26_MTask`
- 修复方式：**全部为真实代码修复，零 NOSONAR / eslint-disable / @ts-ignore 抑制**
- 全程 8 轮扫描-修复迭代（238 → 134 → 13 → 15 → 13 → 10 → 1 → 0）

## 问题分布（修复前 Top 规则）

| 规则 | 数量 | 修复策略 |
|------|------|----------|
| S6819 无障碍角色误用（status/listbox/option/button/dialog） | 31 | `<span role="status">` → 原生 `<output>`；`role="dialog"` → 原生 `<dialog open>`；自定义下拉移除 listbox/option 角色改用原生 button + `aria-pressed` |
| S3776 认知复杂度超限（16~65） | 26 | 抽取模块级组件/辅助函数（PlanGanttRow、PlanTitleCell、PlanDurationCell、PlanRowMenu、HolidayModal、DepEditorModal、PlanProjectPicker、PlanBatchBar、comparePrompts、buildTaskFilter、organizeOne 等 40+ 个） |
| S2004 函数嵌套超 4 层 | 20 | 深层内联箭头下沉为组件级/模块级回调 |
| S3358 嵌套三元 | 18 | 抽为 if/else 或独立函数（cmpSortWeight、progressBucket 等） |
| S1854 无用赋值 | 13 | 删除死赋值（tools、existingCount、prev、victims 等） |
| S3735 void 运算符 | 10 | `runAsync()` 兜底 catch / prop 类型收紧为 `Promise<void>` / 消息文案化 |
| S1128 未用导入 | 9 | 移除 |
| S4624 嵌套模板字符串 | 8 | 内层模板提变量 |
| 其余（S2871/S2681/S7764/S7780/S7758/S6353/S5843/S1994/S4323/S6479 等） | ~113 | 逐条修复（localeCompare 比较器、globalThis、String.raw、Math.trunc、正则简化、循环条件修正、类型别名等） |

## 重点重构

- **PlanPage.tsx**（44→0）：甘特行拆为 PlanGanttRow + 7 个单元格组件；节假日弹窗、依赖配置弹窗、项目选择器、批量操作条、工具栏动作区全部组件化；过滤逻辑下沉为 planRowHidden/colFilterHidden/milestoneMeta 纯函数
- **TasksPage.tsx**（24→0）：任务行、弹窗、下拉的无障碍与结构修复
- **PlanService.ts**（21→0）：JSON 恢复解析状态机、PRD 归一化、时间线重排等抽取复用
- **WorkspaceService.ts**（12→0）：glob 解析去循环变量改写、文件搜索/符号索引递归抽取

## 行为保持承诺

- 全部修复保持运行时行为与 UI 渲染不变（单元格组件与原内联实现逐行等价）
- 唯一微小交互变化：4 个弹窗（PageGuide / ReqMatrixPanel / TasksPage / PlanPage）的「点击遮罩关闭 / Esc 关闭」被移除（S6847 合规要求），各弹窗均保留明确的关闭/取消按钮
- CopyButton 移除了 `document.execCommand` 兜底（S1874 弃用 API）：Electron（file:// 属安全上下文）与 vite（localhost）下 clipboard API 均可用

## 测试验证（隔离实例，未触碰用户数据）

| 套件 | 结果 |
|------|------|
| API 冒烟 smoke.mjs | **23/23** ✅ |
| 适配器 E2E adapter-e2e.mjs（tsx + mock AI server） | **51/51** ✅ |
| t00754 节假日工作日 | **5/5** ✅ |
| t00763 PRD 上下文 | **11/11** ✅ |
| t00769 PRD 生成 | **19/19** ✅ |
| t00770 PRD 管理 | **25/25** ✅ |
| t00776 工作空间 | **21/21** ✅ |
| t00777 符号索引 | **11/11** ✅ |
| t00779 流式截断 | **6/6** ✅ |
| t00780 符号生命周期 | **11/11** ✅ |
| verify-ai-state（AI 状态机端到端） | **全部通过** ✅ |
| MCP smoke / full / runtime | **15+57+13 全过** ✅ |

说明：t00707-ai-regression 需真实模型 AGNES_KEY，不在离线套件内。mcp-full-test 在 tsx 直跑 src 下有 4 例 worker 路径报错（`report-builder` 无扩展名导入，src 运行方式固有限制，与本次修复无关），改用 dist 生产构建运行后 57/57 全过。

## 打包产物

- 安装包：`release\MTask Setup 0.1.91-9.117.exe`（约 105 MB，版本 0.1.0919.117）
- 校验：包内 `better_sqlite3.node` ABI = Electron 版 ✅；asar 构建时间 2026-09-19T00:37（新鲜）✅；包内含 server/dist（61 文件，services 21 + skills 6）与 web/dist（12 文件）✅；工作区 ABI 已恢复 dev ✅

## 质量门禁剩余项（非代码质量问题）

- `new_coverage`：项目无测试覆盖率上报管线（未配置 c8/istanbul 等采集），属工程基建项，不在本次范围
- `new_security_hotspots_reviewed`：当前安全热点数为 0，该项因分母为 0 显示 0%
