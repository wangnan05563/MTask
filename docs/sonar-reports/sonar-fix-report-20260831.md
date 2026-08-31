# MTask SonarQube 代码质量扫描修复报告

- **扫描日期**：2026-08-31
- **项目 Key**：`26_MTask`（SonarQube 26.1.0，localhost:9000）
- **扫描范围**：`server/src`、`server/scripts`、`web/src`、`electron`（69 个源文件，ncloc 11232）
- **扫描工具**：sonar-scanner 8.0.1.6346

## 1. 结果总览

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| OPEN 问题总数 | 188 | **0** |
| CRITICAL | 29 | 0 |
| MAJOR | 54 | 0 |
| MINOR | 104 | 0 |
| INFO | 1 | 0 |
| VULNERABILITY | 0 | 0 |
| 质量门禁 | compliant | compliant |

收敛轮次：首轮扫描 → 8 组并行子代理修复（第一轮）→ 重扫（剩 31）→ 主代理直修 → 重扫（剩 10）→ 直修 → **重扫 OPEN=0**（共 4 次扫描）。

## 2. 问题分布（修复前）

### 2.1 按严重程度

| 严重度 | 数量 | 代表规则 |
|--------|------|----------|
| CRITICAL | 29 | S3735（void 使用 ×26）、S3776（认知复杂度）、S2004（函数嵌套过深） |
| MAJOR | 54 | S6853（label 未关联控件 ×22）、S6848/S6819（非交互元素可访问性）、S6479（数组索引作 key）、S3358（嵌套三元）、S4624（嵌套模板字面量） |
| MINOR | 104 | S4325（冗余断言 ×14）、S7781（replaceAll）、S6551（对象字符串化）、S6759（props 只读）、S7764（globalThis） |
| INFO | 1 | S1135（TODO） |

### 2.2 按文件（Top 10）

| 文件 | 问题数 |
|------|--------|
| web/src/pages/TasksPage.tsx | 30 |
| web/src/pages/AIToolsPage.tsx | 11 |
| server/src/routes/tunnel.ts | 10 |
| web/src/pages/TunnelPanel.tsx | 9 |
| web/src/mobile/MobileMore.tsx | 7 |
| server/src/services/SettingsService.ts | 7 |
| electron/main.js | 7 |
| web/src/mobile/QuickNote.tsx | 7 |
| web/src/ui/dialogs.tsx | 6 |
| web/src/mobile/offline.ts | 5 |

## 3. 修复策略与执行

采用 sonarqube-mcp 技能「扫描 → 分类 → 并行修复 → 重扫 → 收敛」闭环：

1. **第一轮（8 组并行子代理，按文件聚类分组）**：覆盖 188 个问题中的 ~180 个。
2. **第二轮（主代理直修 31 个）**：子代理部分编辑未落盘 + 修复期间新引入规则（S6819/S6842 由 role 补偿方案触发）。
3. **第三轮（主代理直修 10 个）**：同上残留，改用 `[System.IO.File]` 直接读写规避编辑工具写盘异常。

### 3.1 典型修复模式

| 规则 | 修复方式 |
|------|----------|
| S3735（void） | `return void res.status(500)...` → 语句 + `return;` |
| S3776（复杂度 17~43） | 拆分渲染函数/工具函数（TasksPage renderTaskItem 43→拆 10 个子函数；sse.ts、client.ts、QueueService.submitAll 等）；S7785 顶层 await 因 Electron CJS 入口限制以 NOSONAR 附原因豁免 |
| S2004（嵌套 5 层函数） | 提取 setState updater/回调为具名函数 |
| S6759（props 只读） | props 接口属性统一加 `readonly` |
| S6853（label） | 补 `htmlFor`/`id` 关联 |
| S6848/S6819/S6842 | 改原生 `<button>`（重置样式）+ `aria-label`；遮罩交互改 document 级事件委托 |
| S6551（[object Object]） | `typeof` 收窄后再字符串化（含密钥解密入参、SQL keyword、端口等） |
| S4822 | worker `terminate()` 的 Promise 用 `.catch()` 兜底 |

### 3.2 修复过程中发现并修复的产品缺陷（超出口扫范围）

**queue_jobs 外键缺 ON DELETE CASCADE**（S2933 之外的功能性 bug）：
- 现象：smoke 测试 22/23，删除关联队列作业的项目/任务/工具时被外键约束阻断（500）。
- 根因：[schema.ts](../../server/src/db/schema.ts) 中 `queue_jobs.task_id/tool_id` 外键无级联删除，而 `foreign_keys = ON`。
- 修复：新表定义补 `ON DELETE CASCADE` + 新增 `ensureQueueJobsCascade()` 幂等迁移（rename → create → copy → drop，事务内执行），兼容存量数据库。
- 验证：smoke 23/23 通过。

### 3.3 顺带修复的测试基础设施问题

| 问题 | 根因 | 修复 |
|------|------|------|
| smoke.mjs 队列发送失败（DeepSeek 401） | 脚本硬编码真实外部 API + 假 key，离线不可复现 | 改用本地 mock-ai-server（`MOCK_BASE` 可覆盖），断言「占位结果」→「mock-openai」 |
| mcp-smoke.mjs 握手 400 | 新版 MCP SDK 要求 `clientInfo.version` 必填，Client 构造缺省 | `new Client({ name, version: '1.0' }, ...)` |
| mcp-smoke「非法周期参数被拒」FAIL | 新 SDK 将入参校验失败作为 `isError=true` 结果返回（不再抛异常），断言仅依赖异常路径 | 断言改为「返回值 isError 或异常」双路径兼容 |

## 4. 验证结果

| 验证项 | 结果 |
|--------|------|
| server `tsc --noEmit` | ✅ 0 错误 |
| web `tsc --noEmit` | ✅ 0 错误 |
| adapter-e2e（适配器 mock 联调） | ✅ 51/51 |
| smoke（API 冒烟） | ✅ 23/23 |
| mcp-smoke（MCP HTTP E2E） | ✅ 15/15 |
| mcp-runtime-test（进程内 MCP） | ✅ 13/13 |
| verify-import（settings 导入） | ✅ 4/4 |
| web 生产构建（vite build） | ✅ 1620 模块，471.95 kB (gzip 147.88 kB) |
| server 生产构建（tsc） | ✅ |
| SonarQube 重扫 OPEN | ✅ 0 |

## 5. 硬约束合规确认

- ✅ better-sqlite3 布尔 0/1 归一化、busy_timeout 未触碰
- ✅ Markdown 渲染 XSS sanitize 逻辑完整保留
- ✅ API client post 显式 signal 参数签名不变
- ✅ QueueService submitAll/pollPending 异步状态机、ticket/submitted_at 语义不变
- ✅ 适配器 send/submit/poll 接口与 AdapterType 联合类型不变
- ✅ 打包态 39877 / 开发态 39876 端口逻辑、API 代理 duplex: half 配置不变
- ✅ lucide-react 按需导入；button 均有 aria-label「按钮名称：用途说明」
- ✅ 任务行 hover 显隐（.task-op）、统一点击动画等交互规范未动

## 6. 残留与建议

- S1874（execCommand 废弃 API）4 处以 NOSONAR 抑制（Clipboard API 失败降级路径，无未废弃等价 API）；S7785（顶层 await）1 处 NOSONAR（Electron CJS 入口不支持顶层 await）。
- 质量门禁显示 compliant；建议后续为 TasksPage 等大组件补充单元测试，提高 new_coverage。
- 本机环境注意：编辑工具存在偶发"返回成功但未落盘"现象，批量修改后务必 grep 磁盘复核。
