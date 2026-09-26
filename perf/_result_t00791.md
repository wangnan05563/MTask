## 根因

2026-09-18 全端点性能测试**开测前**，工作区源码处于无法编译/无法启动状态，导致压测无法开展。三处缺陷：

1. **语法错误（致命）**：`server/src/services/PlanService.ts` 中 `normalizeRequirements` / `normalizePrdPlans` 两个函数声明被误放进 `export const PlanService = { ... }` **对象字面量内部**。对象字面量不允许裸函数声明，整文件解析失败 → `tsc` 报级联语法错误。
2. **运行时 TypeError**：同文件 `linkRequirement()` 对 `const ids` 重新赋值（`ids = ids.filter(...)`），TypeScript 报 TS2588，运行时抛 `TypeError: Assignment to constant variable` → 「需求矩阵-解除关联」**必然 500**。
3. **TS2366**：`server/src/services/PrdGenService.ts` 的 `buildRetrieveBlock()` 声明返回 `: string`，但 `catch` 分支无 `return`（TS2366 声明可能返回 undefined）。

**关键放大因素**：`server` 的 `tsc` 未开 `noEmitOnError`，语法错误时 `tsc` 仍退出码 0 并产出**损坏的 JS**，故障表现为「构建成功但服务启动即崩」——极具误导性。

## 影响范围

| 缺陷 | 影响面 | 严重度 |
|---|---|---|
| 1 语法错误 | 全服务无法启动（PlanService 被几乎所有路由引用） | 阻断 |
| 2 const 赋值 | 「需求矩阵-解除关联」功能 100% 500 | 高 |
| 3 缺 return | 工作空间检索增强失败时返回 undefined 而非空串 | 中 |

## 修复

文件 1：`D:\code\otherProjects\26_MTask\server\src\services\PlanService.ts`

- 修复 1：将 `normalizeRequirements` / `normalizePrdPlans` **提升为模块级函数**（现 485 / 495 行），位于 `export const PlanService`（515 行）之前。两函数调用点均为裸调用，作用域提升后行为不变。
- 修复 2：`linkRequirement()` 第 1540 行

```ts
// 修复前（对 const 重新赋值 → TypeError）
ids = ids.filter((x) => x !== reqId);
// 修复后（原地修改，语义等价）
if (!target.linked && has) ids.splice(ids.indexOf(reqId), 1);
```

文件 2：`D:\code\otherProjects\26_MTask\server\src\services\PrdGenService.ts`

- 修复 3：`buildRetrieveBlock()` 第 109 行 catch 分支补 `return ''`，与函数内「检索增强失败不阻塞主流程」注释语义一致。

提交：`8bf851b` 的同一批次已完成 T00784 独立提交；**本条三处修复中，文件 2（PrdGenService.ts）为 git 未跟踪新文件**（T00763 新增，尚未 `git add`），文件 1 的两处修复与并发会话的大规模改动位于同一文件，故未单独切分提交——已在本条如实记录，供人工确认入库策略。

## 验证（实测证据）

验证脚本：`perf/verify_t00791c.py`（隔离实例 39903 / `perf/sandbox/verify791c`，复制生产库样本，绝不触碰生产实例）

**1. 编译**：`cd server && tsc --noEmit` → 退出码 **0**，0 错误（修复前为级联语法错误）

**2. 转译后语法**：对 `PlanService.ts`、`PrdGenService.ts` 分别 `ts.transpileModule` + 构造 `vm.Script` → 均「语法 OK」（证明不再有加载期崩溃）

**3. 服务启动**：隔离实例启动 → `/api/health` 返回 `{"ok":true,"service":"mtask-server",...}`，启动日志无任何 `Error`（修复前：启动即崩）

**4. 「需求矩阵-解除关联」端到端**（修复 2 核心验收路径）：

| 步骤 | 请求 | 结果 |
|---|---|---|
| 造需求 | `POST /api/plans/prd-requirements` | ✅ 200，返回 id `f861b9d1-…` |
| 建立关联 | `POST /api/plans/prd-requirements/:id/link` `{kind:'task',targetId:'efde5dc0-…',linked:true}` | ✅ 200 `{"ok":true}`，回读 `linkedTasks` 含 T00778 |
| **解除关联** | 同端点 `{"linked":false}` | ✅ **200 `{"ok":true}`**（修复前必然 500），回读 `linkedTasks: []` 已清空 |
| 再次关联（幂等性） | `{"linked":true}` | ✅ 200 |
| 清理临时需求 | `DELETE /api/plans/prd-requirements/:id` | ✅ 200 |

**5. 日志异常**：整个验证过程隔离实例日志**无 Error / TypeError 行**。

## 本次回写

- 无新增派生任务。
- 遗留待人工确认：`server/src/services/PrdGenService.ts`、`WorkspaceService.ts`、`server/src/skills/`、`server/src/util/prdContext.ts` 为 **git 未跟踪新文件**（T00763 相关新增），建议随下次功能提交一并 `git add` 入库，避免长期游离。
- 建议（非本单范围）：为 `server` 开启 `noEmitOnError: true`——本次「tsc 退出 0 却产出损坏 JS」正是导致故障难定位的根因，开启后可在构建期直接失败。

## 下一步建议

- 与 T00784 同文件（PlanService.ts）：本次 T00784 提交已用 `git apply --cached` 精确切分单 hunk，未裹挟并发会话改动；建议另一会话在合并前复跑 `npm run build` + `tsc --noEmit`（MEMORY.md T00783 并发改写特征的既定防护动作）。
