# PRD 评审报告：AI 控制台「代码评审会议讲稿生成」（T02169）

> 评审对象：`docs/PRD-代码评审会议讲稿生成.md` ｜ 评审版本：**v1.0（2026-10-16）** ｜ 评审日期：2026-10-16
> 评审人：AI 评审（结合本仓实现与架构逐条取证）｜ 方法：同 T02170 评审——**不评审文档，只评审假设**，逐条抽取技术断言回代码核行号与语义
> 修订结果：PRD 已升至 **v1.1（评审修订版）**；新建门禁 `scripts/verify-t02169-lecture-prd.mts` 固化取证结论

---

## 0. 评审结论

**v1.0 整体质量高于平均**：结构完整覆盖任务期望输出全部 8 节、竞品调研真实可溯（阿里 Open Code Review 与 Copilot 2026-09 两项关键事实均经联网核验为真）、安全红线（execFile 白名单/禁 shell）意识到位。但存在 **3 个事实性/一致性问题**（1 个虚构字段、1 个错挂项目、1 个与已批准 PRD 的序号冲突未声明）和 **1 个所有同类方案都会漏掉的平台性风险**（Windows git 输出编码）。

修订后（v1.1）：3 个问题全部消解，Windows 编码风险落为 FR-1.1 硬约束 + 验收项，另补锚点防漂移借鉴与 3 条建议。**v1.1 可提交业主审批**，前置仍是 §9 的 E-1~E-4 四项签字。

| 级别 | 数量 | 处置 |
|---|---|---|
| 阻塞 B | 1 | 已修订（`projects.color` 虚构字段） |
| 重要 I | 4 | 已修订（项目错挂 / 卡位冲突未声明 / Windows 编码 / 锚点漂移） |
| 建议 S | 3 | 已采纳 |

---

## 1. 问题清单

| 编号 | 级别 | 问题 | 证据 | 处置 |
|---|---|---|---|---|
| B1 | 阻塞 | §6.3 称「多项目章节色标取自项目色（**`projects.color` 字段在位**）」——该字段**不存在** | `schema.ts` 的 color 列只在 `tasks:484`/`prompts:485`/`req_entries:489`/`plan_tasks:490`；projects 表（`:7-14` + ensureColumn 组）无 color | §6.3 改为「从 `exportStyle.ts` 品牌色板按项目索引取色（单源纪律）」；如需项目自有色，列为扩展项（需 ensureColumn 迁移，同 E-4 走裁决） |
| I1 | 重要 | 头部「影响项目：**mtask四期**」错挂 | T02169 与派生单 T02219 的 `project_id` 均为 `bea1ce5b-…` = **mtask六期**（2026-10-15 建） | 头部改 mtask六期（与 T02170 PRD 同款修正） |
| I2 | 重要 | §2.3 称「新卡片是**第 8 张**」但未声明与 **T02170 PRD（已批准）同争该位** | `docs/PRD-阶段性项目总结汇报PPT.md` §12 已记冲突提示（按尾部追加、时点定序）；本 PRD 无任何说明 | §2.3 该行约束列补冲突提示，口径与 T02170 §12 对齐：两张卡均按 `reportCards` 尾部追加，先落地者为 8、后落地者为 9 |
| I3 | 重要 | **Windows git 输出编码风险完全未识别**（平台性盲点） | 中文 Windows 上 `git log`/`git diff` 默认按 locale（cp936/GBK）输出 commit message 与文件名，Node 按 utf8 读即乱码；`core.quotepath` 默认把非 ASCII 路径转义为 `\xxX`；`core.autocrlf=true`（Windows 安装默认项）会让未改行尾的文件整文件进 diff。本仓自身有 GBK 乱码教训（工作记忆：门脚本输出须落文件再读取） | FR-1.1 白名单命令统一加 `-c i18n.logOutputEncoding=utf-8 -c core.quotepath=false`；FR-1.2 补 CRLF 口径（`--ignore-cr-at-eol` 或显式声明）；§8 A-3 扩断言：中文 commit/文件名在采集输出中为可读 UTF-8（无乱码、无 `\xxx` 转义） |
| I4 | 重要 | 锚点 `[file#Lx-Ly]` **行号漂移风险未提**：生成后代码再变（新提交/格式化）即定位失效 | 竞品 §5.2 阿里 OCR 的架构亮点正是「外部定位与反思模块……在早期拦截 LLM 幻觉与知识漂移，确保行级评论精度」（调研来源），PRD 只抄了「成本可见」 | §5.2 OCR 行补「行号锚定由确定性步骤保证」借鉴；FR-4.3 补锚点时效声明（锚点=生成时点快照，附 blob/commit 标识，A-4 验收同步） |
| S1 | 建议 | FR-1.4「按文件优先级截断」的优先级规则未定义（2MB 上限 → 60k 预算的漏斗中间层是空洞） | FR-1.4 与 FR-3.1 之间缺排序因子 | FR-1.4 补三条排序因子：变更行数多者优先、安全敏感路径（auth/crypto/sql）优先、被 workspace symbols 引用多者优先 |
| S2 | 建议 | §7.2「预检 ≤3s」无测量口径（大仓 `git log --stat` 可能超时） | FR-1.4 子进程超时 30s 与 §7.2 预检 3s 并存，未说明关系 | §7.2 标注为「P50、万行级以下仓」前提；预检超 3s 时先返回部分统计并流式补全 |
| S3 | 建议 | 竞品数字（OCR 16k stars 等）无时点口径 | §5.2/§10 | §10 补官方仓库链接（`github.com/alibaba/open-code-review`、`open-codereview.ai`）+ 数字标注「截至 2026-10 检索」 |

---

## 2. 三个必改问题的详细论证

### B1：`projects.color` 是虚构字段

§6.3 原文：「多项目章节色标取自项目色（`projects.color` 字段在位）」。实测 `schema.ts` 全文：color 列只 ensureColumn 到 `tasks`/`prompts`/`req_entries`/`plan_tasks` 四张表，projects 没有任何 color 痕迹（grep `projects', 'color'` 零命中）。这是与 T02170 评审 B2（`estimate_items` 无 actual 字段）完全同型的错误：**把"希望有的字段"写成"已在位的字段"**——实施者按此文写代码会直接 `no such column: projects.color` 500。

处置没有选择"补迁移"，而是改设计：项目章节色标本就不该来自数据层，取 `exportStyle.ts` 品牌色板按项目索引分配即可（色值单源纪律本来就是本仓约定）。若未来确要项目自有色，那是 schema 变更，必须走裁决——已把这句写进 PRD。

### I1/I2：项目错挂 + 卡位冲突——两个"复制粘贴"型错误

头部「影响项目：mtask四期」是从 kickoff PRD 抄来的（T02169 实际在六期）；「第 8 张卡」也是沿用旧口径——但这次不是简单的行号漂移，而是**与已批准的 T02170 PRD 真实冲突**：T02170 的 FR-1.1 同样写"第 8 张"，且其 §12 已明确记录"同项目 T02219 同争第 8 张，按尾部追加、时点定序"。两份 PRD 对同一槽位给出互斥声明，实施者无论先做哪张都会困惑。已在 T02169 PRD §2.3 补上与 T02170 §12 逐字对齐的冲突提示。

### I3：Windows git 输出编码——同类方案的通用盲点

PRD 的安全思考很深（execFile 数组化、禁 shell、只读命令白名单、路径穿越校验），但漏了**采集质量**而非采集安全的一层：MTask 是 Windows 桌面应用（本仓全部开发与打包均在 win32），而 git 的中文输出编码在 Windows 上恰恰是最常见的坑：

1. `git log`/`git show` 的 commit message 默认按 `i18n.logOutputEncoding`（未设时取 locale，中文 Windows = cp936/GBK）输出字节 → Node `utf8` 解码 → **中文提交信息全乱码**，而讲稿的「为什么改」第一证据源正是 commit message（FR-4.3）——乱码直接掏空讲稿核心素材；
2. `core.quotepath` 默认 true → 中文路径显示为 `"\345\206\205\345\256\266.md"` 转义 → 锚点文件名不可读、A-4 点击定位直接失效；
3. `core.autocrlf` 在 Windows 安装 git 时默认勾选 true → 仅行尾差异的文件整文件进 diff → 预检统计虚高、预算被噪声吃掉。

三条都会**静默降质**（不报错，只是内容不对），与 PRD 自己的 G4「不静默出劣稿」直接冲突。处置：命令层统一注入两个 `-c` 配置（成本为零、不动用户全局配置），CRLF 走 `--ignore-cr-at-eol` 口径，并把「中文 commit/文件名可读」升格为 A-3 验收断言（命令链可自动测：用本仓真实中文提交样本生成一次采集，断言输出含可读中文且无 `\xxx`）。

---

## 3. 关键修订前后对照

| 条目 | v1.0 | v1.1 |
|---|---|---|
| 影响项目 | mtask四期（错） | **mtask六期**（bea1ce5b，T02169 归属） |
| 项目章节色标 | `projects.color` 字段在位（虚构） | `exportStyle.ts` 色板按项目索引；项目自有色列为扩展（需迁移+裁决） |
| 卡片序号 | 第 8 张（无冲突说明） | 第 8 张 + **与 T02170 PRD 冲突提示**（尾部追加、时点定序） |
| Git 采集命令 | 白名单 5 条只读命令 | 同左 + **`-c i18n.logOutputEncoding=utf-8 -c core.quotepath=false`** + CRLF 口径 |
| 锚点 | `[file#Lx-Ly]`，无时效说明 | 锚点=生成时点快照 + blob/commit 标识 + 漂移风险声明（借鉴 OCR 定位模块） |
| 截断优先级 | 「按文件优先级」未定义 | 三条排序因子（变更行数/安全路径/symbols 引用数） |
| 验收 A-3 | 只读红线 + 注入用例 | + **中文 commit/文件名 UTF-8 可读断言** |
| 预检 ≤3s | 无前提 | P50 + 万行级以下仓前提；超时流式补全 |
| §7.1 XSS | 「前端既有 Markdown 渲染守卫沿用」 | 精确锚点 `web/src/ui/Markdown.tsx:11`（markdown-it `html:false` + rel/noopener） |
| 竞品来源 | 13 条链接 | + 官方仓库链接（alibaba/open-code-review、open-codereview.ai）+ 时点标注 |

---

## 4. 取证核验台账（本次评审全量）

**属实（抽验 12 条）**：SSE 三点同构 `index.ts:1568/1711/1764`（raw 30mb 均在位）✓；AIService 四通道 `294/474/499/556` ✓（askJson 确为 :499）；`prdContext.ts:25` 6000 + 截断 `:77-79` ✓；workspace 四端点 `:257/274/282/290` ✓；`adapters/types.ts:93/101/110` ✓；ai-download `:1824` ✓；buildPptx `report-builder.ts:247` ✓；WorkspaceService 忽略 `.git`（`:15`）✓；无 git 依赖（server/package.json）✓；无 diff 渲染组件（web grep 零命中）✓；Markdown XSS 守卫（`ui/Markdown.tsx:11`）✓；打包不带 git（electron 配置零命中）✓；竞品：阿里 OCR（`alibaba/open-code-review`，Apache-2.0，2026-05-18 开源，16k+ stars，token 约 1/9）✓、Copilot 2026-09-01 自动审批公开预览 + 09-02 Content exclusions GA ✓。

**不实（3 条）**：`projects.color`（不存在）；影响项目 mtask四期（实为六期）；「第 8 张卡」无冲突声明（与 T02170 PRD 互斥）。

**行号漂移（2 处，已改）**：reportCards `:580/:622` → `:584/:626`；prdContext 截断 `:77-78` → `:77-79`。另 FR-1.1 的「execFile 先例」误引 `tunnel-service.ts:179`（那是 spawn），execFile 现成先例是 `:15 execFileAsync`（`:14` 注释「不走 shell，参数数组传递避免路径转义问题」正是本 PRD 需要的论据）。

---

## 5. 剩余风险（修订后仍需关注）

| 编号 | 风险 | 说明 |
|---|---|---|
| — | E-1 git 依赖仍未签字 | 装机版确实不带 git（已核验打包配置），降级路（粘贴 patch）设计完备，风险可控；但「用户机 git 普及率」是业务判断，须业主签字 |
| — | 锚点时效 | 已加声明与 blob 标识，但「生成后代码变动导致定位偏差」无技术根治（除非定位时重算），靠声明兜住 |
| — | 大仓预检 3s | 已加 P50 前提与流式补全；超大 monorepo 仍可能超，验收基准样本需固定规模 |
| — | T02219 记录偏差 | 其 handle_result 写「挂 mtask四期」，实际为六期——非本 PRD 范围，建议下轮处理 T02219 时顺手修正 |

---

## 6. 复审与门禁

取证结论已固化为 `scripts/verify-t02169-lecture-prd.mts`（v1.1 新增）：结构断言（§1~§10 对任务期望输出 8 节）、锚点断言（上述 12 条属实项逐条对代码）、防回退断言（`projects.color` 不得再被声称在位、编码参数必须在位、冲突提示必须在位）、需求覆盖断言（竞品 3-5 家 + UX 章节 + 验收 A-1~A-7 + E-1~E-4）。

**复审触发条件**：① E-1~E-4 裁决结果与 PRD 假设不符；② `projects` 增加 color 列（B1 处置可简化）；③ 采集层引入 git 库替代子进程（白名单/编码约束整体作废）。
