# 概要设计（八期增量）：Git 提交徽标、增量资产提取与 Sonar 质量回写

> 版本：v1.0 ｜ 日期：2026-10-30 ｜ 状态：随代码落地回填
> 需求基线：`docs/t03325-result-v1.2.md`（PRD v1.2，18 条 AC，Q1–Q12 裁定已固化）
> 本文只写**八期相对七期的新增面**，七期及以前的架构见 `docs/概要设计.md` 与 `docs/详细设计/`。

---

## 1. 范围

| 编号 | 能力 | 需求锚点 |
|------|------|----------|
| 八期-1 | 任务 ↔ 提交关联（MCP 回写 + 手动绑定） | PRD §2、§3.1、§3.2 |
| 八期-2 | 任务列表 Git 徽标与批量提交摘要 | PRD §3.1.1–§3.1.6 |
| 八期-3 | 详情抽屉「Git」页（提交卡 / 文件清单 / diff / 子任务区） | PRD §3.2 |
| 八期-4 | AI 工作台「Git 增量资产提取」三形态导出 | PRD §3.3 |
| 八期-5 | AI 工作台「Sonar 质量扫描」+ 设置页 + 问题回写子任务 | PRD §3.4 |
| 八期-6 | 主题与可访问性（四态对比度、图标语义、键盘等价） | PRD §4.4 |

**非目标（红线）**：不做任何 Git 写操作（不 commit/push/checkout/rebase）、不解析提交信息自动关联（Q1 否决）、不做托管平台 OAuth（只用 remote 拼外链）、不内置 Sonar 扫描器与 Java 运行时。

---

## 2. 总体结构

```
web/（React 18 + Vite）
  ├─ TasksPage 元信息行 / 看板卡尾  ← gitBadge.tsx      ┐
  ├─ TaskDetailDrawer「Git」页     ← DiffView + CopyButton│ 读
  ├─ ReportPage「Git 增量资产提取」 ← gitScopePicker.tsx  │ SSR/JSON
  ├─ ReportPage「Sonar 质量扫描」   ← SonarScanPanel.tsx  │
  └─ settings.tsx「SonarQube」子页 ← SonarSettingsTab.tsx ┘
                │  HTTP（api:// 自定义协议 → 127.0.0.1）
                ▼
server/（Express）
  ├─ routes/gitLinks.ts      /git/commit-summaries、/git/log、/tasks/:id/git*
  ├─ routes/gitExtract.ts    /git-extract、/git-extract/plan、/git-extract/download
  ├─ routes/sonarSettings.ts /settings/sonar*（读/写/查看原文+审计/连接测试）
  ├─ routes/sonarScan.ts     /sonar/scan*（SSE 七阶段 + 中止 + 环境探测）
  └─ services/
       ├─ gitCollect.ts      只读白名单取数（rev-parse/log/diff/show/remote/cat-file）
       ├─ taskGitLinks.ts    关联读写、SHA 解析、外链推导、抽屉聚合视图
       ├─ gitExtract.ts      范围计划、拓扑排序、限量、打包、tmp 清扫
       ├─ sonarScan.ts       快照 → 扫描 → 拉问题 → 指纹去重 → 子任务回写
       ├─ sonarSettings.ts   配置加密存取、三项连接测试、查看原文审计
       └─ gitAiLink.ts       「AI 智能关联」建议（不改关联，只出建议）
  └─ mcp/server.ts           mtask_link_git_commit（独立工具，Q7' 裁定）
  └─ db/schema.ts            task_git_links / sonar_issue_fps
```

**分层职责**：路由只做参数校验与 SSE 编排；所有 Git 取数经 `gitCollect.ts` 单点出口（白名单 + 参数注入校验），所有 Sonar 进程经 `sonarSettings.ts#planScannerSpawn` 单点出口（`execFile` 不走 shell）。

---

## 3. 数据模型

```sql
-- server/src/db/schema.ts:783
task_git_links(id, task_id, sha, workspace_path, source, created_at)
  UNIQUE(task_id, sha)                    -- 幂等：同任务重复回写同一 SHA 不落第二行
  INDEX(sha)                              -- 反查「哪些任务改了这个提交」
-- server/src/db/schema.ts:795
sonar_issue_fps(fp, project_id, task_id, severity, created_at)   -- fp = sha256(rule|path|line|message)
  INDEX(created_at)                       -- 7 天窗口清扫
```

口径要点：

1. `workspace_path` 只是**审计快照**；解析 SHA / 文件 / 外链一律用项目**当前** `projects.workspace_path`（PRD §2）。项目换绑后旧 SHA 在新仓库不存在 → 回执「提交已不在当前仓库」，不静默失败。
2. `source` 是开放枚举 `agent | manual | ci`（`taskGitLinks.ts:63`），预留 CI 回写不迁表。
3. `task_git_links` 对 `tasks` 有 `ON DELETE CASCADE`，归档物理删除不产生孤儿行（AC-18）。
4. Sonar 配置复用 `app_settings` + `util/crypto.ts`（AES-256-GCM），不新建明文表；Token 读取默认脱敏。

---

## 4. 关键流程

### 4.1 回写（主通道）

```
外部 Agent 提交后 → MCP mtask_link_git_commit { taskNo|id, commits: sha|sha[] }
   → normalizeShaInput（7–40 位 hex）→ resolveCommitSha（git rev-parse，项目当前工作空间）
   → INSERT OR IGNORE task_git_links(source='agent') + task_events(kind='git_link')
   → 返回 { linked, skipped, resolved:[{input,sha}], errors:[] }
```

幂等由唯一索引兜底；无法解析的 SHA 进 `errors` 而不是抛整体失败——批量回写不允许一条坏 SHA 吃掉其余。实现：`server/src/services/taskGitLinks.ts:141` `linkCommits`、`server/src/mcp/server.ts:1170`。

### 4.2 列表摘要（一次批量，不逐行）

```
GET /tasks 每项内联 gitLinks（最新一条 + 条数）        ← listLatestLinksByTask（单条 IN 查询）
POST /git/commit-summaries {links:[{taskId,sha}]}      ← 按 workspace 分组，每组一次 git log --no-walk
   → {groups:[{workspacePath, available, kind?, commits[], missing[], truncated}]}
```

前端只对**本页唯一 SHA 集合**发一次请求，60s 页级缓存；单页唯一 SHA > 200 时服务端截断并回 `truncated=true`。外链允许 ≤60s 陈旧（T03606 裁定，把 remote 纳入缓存键等于每次多付一次 git 进程启动）。

### 4.3 导出（Git 增量资产提取）

```
POST /git-extract/plan  → 只算范围与计数（面板摘要常显）
POST /git-extract       → SSE：汇总 → 读取(cat-file --batch 单进程) → 打包(PizZip STORE) → 可下载
GET  /git-extract/download?token= → 一次性令牌，下载即删（6h TTL 清扫）
```

护栏：文件 ≤ 2000、总体积 ≤ 50MB（Q9 甲），**超限即拦不自动分卷**；同一秒 + 无父子边 + 改同一文件的提交对在 plan 阶段直接 `ambiguous-order` 报错点名（T03609）；导出闸默认并发 2，超限 429 不排队。

### 4.4 扫描（Sonar）

```
POST /sonar/scan（SSE）
 stage1 collect  → 汇总增量文件（同上取数口径）
 stage2 snapshot → cat-file --batch 落 MTask_DATA_DIR/tmp/sonar-<job>/，记 snapshotHeadSha
 stage3 config   → 写临时 sonar-project.properties（projectBaseDir 指快照）
 stage4 scan     → execFile(scanner, ['-Dproject.settings=…'])；.scannerwork 落在快照目录
 stage5 wait     → 轮询 /api/ce/component 至 SUCCESS/FAILED（显示排队分钟数）
 stage6 fetch    → /api/issues/search 分页拉全
 stage7 writeback→ 阈值过滤（默认 blocker/critical）→ 建子任务 → 写指纹 → 回执
```

回写形态（Q3 选项C）：原任务是顶层 → 建子任务；原任务本身是子任务 → 挂其**父 epic**，描述注明「实际归属任务 Txxxxx」，不产生三级。单次 ≤50 条，超出合并 1 条摘要子任务「[Sonar] 本次扫描另有 N 个问题」。指纹 7 天去重，任务被删不影响窗口。

扫描对象是**提交内容快照**而非工作树当前态；回执注明「快照基于 SHA x，当前 HEAD 为 y，相差 n 个提交」。

### 4.5 降级

| 场景 | 行为 |
|------|------|
| 未绑定工作空间 / 非仓库 / 无 git / 无 remote | `GitCollectError.kind` 分类（`no-remote` 为八期新增枚举），UI 灰标「不可用」+ 具体指引，复制按钮隐藏，不出现失效外链 |
| 缺 sonar-scanner / Java | `/sonar/scan/env` 回不可用态，卡片置灰 + 安装指引，不发请求、不残留 job（AC-16、Q12） |
| 扫描/导出并发超限 | 429 + 明确文案，不排队 |

---

## 5. 复用清单（不重复造）

`GitTreePickerModal`（手动绑定选提交）、`CopyButton`（复制 SHA）、`DiffView`（抽屉文件 diff，批次 0 从讲稿面板抽取）、`streamEvents`（SSE）、`console_jobs`（运行态跨刷新恢复）、`export-gate`（导出/扫描并发闸）、`ReportService` 一次性 token 下载与 tmp 清扫、`exceljs`、`PizZip`、`util/crypto.ts`。

---

## 6. 非功能落地位置

| 项 | 设计值 | 落地位置 |
|----|--------|----------|
| 只读红线 | 白名单 `rev-parse/log/diff/show/remote(get-url)/cat-file(--batch)`；写类子命令与 `--batch-command` 等一律 denied | `server/src/services/gitCollect.ts`，负例见 `scripts/tests/verify-t03436-git-links.mts` W-01…W-08 |
| 凭据剥离 | remote URL 的 `user:token@` 在展示与打开前剥离 | `taskGitLinks.ts:50` `remoteInfoOf` |
| 外链 | 仅 http/https，渲染层 + 主进程二次校验 | `electron/main.js` `setWindowOpenHandler` |
| 脱敏 | Token 不入日志/命令行/properties；properties 随 tmp 清理 | `sonarScan.ts:215` `redact` |
| 审计 | 查看 Token 原文写 `sonar_reveal_audit` | `sonarSettings.ts:399` `recordRevealAudit` |
| 可访问性 | 图标按钮 100% `aria-label`；状态徽标字母+颜色双通道；摘要 `title` + `aria-label` 双提供 | `scripts/tests/verify-t03222-pm303-keyboard-a11y.mts`、`verify-t03411-a11y.mts` |
| 主题 | light / dark / auto / 禅模式 四态对比度 ≥ 4.5:1 | `scripts/tests/verify-t03431-theme-contrast.mts`、`verify-t03393-diff-theme.mts` |
