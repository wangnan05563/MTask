# T05210 处理结果：Git 树选范围视图改造为 IDEA 风格双栏（左记录列表 ↔ 右变更文件树）

## 需求与落点

把「Git 树选范围」弹窗从**单栏记录列表**改造成 IDEA Git 视图的**左右两栏**：

| 需求条目 | 落点 |
| --- | --- |
| 左右分栏（左记录列表 / 右文件树 + 摘要） | `GitTreePickerModal` 新增 `data-lck="git-tree-split"` 两栏容器（46% / 自适应），两栏各自滚动 |
| 仓库色彩标识（左栏色条 + 图标 + 标签） | `RepoStripe` + `FolderGit2`（均取 `--gt-repo-N`）；混合多仓库时启用 |
| 记录单选/多选、点选即刷新右栏 | 沿用既有勾选式多选语义，右栏由「选中集合签名」驱动重取 |
| 列表项含仓库图标/分支/摘要/作者/时间 | 原有字段保留，新增带色仓库图标；分支仍以 refs pill 呈现 |
| 右栏文件树（目录层级 + 状态字母） | `buildFileTree` + `TreeRow`：目录可折叠、`A/M/D/R/T` 字母跟随文件名 |
| 文件树节点色 = 该记录仓库标识色 | 文件名与文件图标取同一 `var(--gt-repo-N)`，左栏色条同源（left-to-right mapping） |
| 底部摘要区（提交说明/统计/分支详情） | `SummaryBox`：完整 subject、SHA、作者、绝对+相对时间、`N 个文件 +X −Y`、状态分布、父提交、分支标签 |
| 多选汇总（去重/层级合并） | `aggregateCommitFiles`（同路径一行、last-wins）+ `groupCommitFilesByRepo`（按仓库分组） |
| Base 记录 / 对比视图 | 右栏「基准记录」选择器 → `compareFileSets` 四类分栏（仅其余/仅基准/状态不同/状态相同） |
| Design Tokens | `gitTreeTheme.ts`：行高 22px、缩进 11px、8 色仓库板、状态色、选中/悬停底色，浅深两套按 `[data-theme]` 切 |
| >1000 文件虚拟滚动 | `windowSlice` + `FILE_TREE_VIRTUAL_THRESHOLD=400`（固定行高 + 上下占位，单滚动容器） |
| 空态/加载/长路径/兼容性 | 空态引导文案、分批进度「读取中 k/n」、`data-kind` + title 全路径、无 `color-mix`/无新依赖 |

## 改动清单

**新增**

| 文件 | 作用 |
| --- | --- |
| `web/src/utils/gitFileTree.ts` | 右栏纯逻辑：建树/拍平/聚合/对比/视窗切片/状态元信息（零 React 依赖，可 node 断言） |
| `web/src/ui/gitTreeTheme.ts` | Design Tokens + 仓库色索引（集合排序取色，视图内两两不同）+ 注入样式 |
| `web/src/ui/gitTreeFilePanel.tsx` | 右栏组件：分批取数、分组文件树、Base 对比、摘要区、虚拟滚动、色条导出 |
| `server/src/services/gitCommitFiles.ts` | `queryCommitFiles`：按 projectId + repoSub 批量取 N 个提交的变更文件（缓存 + 毒丸隔离） |
| `scripts/verify/T05210-git-idea-split.mts` | node 门（53 条）：纯逻辑 + 真实 git 仓库的服务层 |
| `scripts/verify/T05210-git-idea-split-ui.mts` | 真浏览器门（19 条）：结构/联动/色彩映射/多选对比 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `web/src/ui/GitTreePickerModal.tsx` | 单栏 → 双栏；仓库色索引与 `detailEntries` 派生；`CommitRows` 增色条/彩色仓库图标；分组视图仓库图标取色；弹窗宽度 1080→1400 |
| `server/src/routes/gitLinks.ts` | 新增 `POST /git/commit-files` |
| `web/src/utils/gitFileTree.ts` | （同上，新增） |

## 关键取舍（都写在代码注释里）

1. **`collectCommitFilesBatch` 一次 `git log --no-walk -m --first-parent --raw --numstat` 取齐 N 个提交**，不逐提交 `git diff`——右栏每次点选都要重取，逐条 fork 在 Windows 上是秒级等待。
2. **毒丸隔离**：批量的 `git log` 只要有一个 SHA 不在仓库里（rebase/force-push/gc 之后常见）就整体非零退出。此时逐条核对存活 → 再对存活的那批走一次批量，**不让一条失效 SHA 拖垮整屏**，也不把缺失塞成空数组冒充「没改文件」（`missing` 单独回报，右栏显式提示）。
3. **多选聚合 last-wins**：同一文件被多条记录改过只出一行，状态取**最新一次**（先新增后删除显示 D 而不是 A）；增删行数**不求和**（多轮改写求和会远超实际），改显示「改过 K 次」。
4. **跨仓库不合并、不对比**：同一相对路径在两个仓库是两个文件，合并会让「19 个文件」凭空变小；Base 对比只在同仓库时开放，跨仓库直接写明「跨仓库不可对比」。
5. **颜色由「当前视图内仓库集合排序取色」**，不用字符串 hash：hash 在 8 个仓库的小集合里撞色概率高，撞了就失去区分意义；排序保证视图内两两不同，且左右两侧算出来的索引一致。
6. **虚拟滚动用单滚动容器 + 混排行数组**（分组头与树行同一个数组），而非每个仓库各自嵌套滚动——多一层嵌套滚动条会让「滚到底」变成猜谜。

## 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 服务端类型 | `npm run typecheck` | exit 0 |
| 前端类型 + 构建 | `cd web && npm run build` | exit 0（1768 modules，21s） |
| 字号令牌 lint | `node scripts/lint-font-tokens.mjs` | PASS（数字字号 0 处） |
| 单源 lint | `node scripts/lint-ui-single-source.mjs` | 失败 7 处，**全部在 `MemoryTab`/`SonarScanPanel`/`SonarSettingsTab`（本单未触碰）**，本单新增文件零命中 |
| node 门 | `tsx scripts/verify/T05210-git-idea-split.mts` | **PASS=53 FAIL=0** |
| 浏览器门 | `tsx scripts/verify/T05210-git-idea-split-ui.mts` | **PASS=19 FAIL=0** |
| 负对照 | 把 `aggregateCommitFiles` 的 last-wins 改成覆盖、`windowSlice` 的 `padBottom` 归零 | **PASS=50 FAIL=3**，红的正是 `B-02` / `D-04` / `D-05`，其余不动 → 断言有牙 |
| 既有门回归（T03302 Git 树弹窗端到端） | 同一门跑两次：HEAD 基线 vs 本单改动 | 基线 **23/3** → 改动后 **24/2**（U-01 由本单顺带修好，其余两项同红）→ 本单零回归（详见下节） |

浏览器门覆盖的关键链路：双栏存在 → 空态引导 → 点选一条 → 文件行出现（状态字母 ∈ A/M/D/R/T、有目录层）→ 摘要给出 SHA/作者 → 左栏色条与右栏文件名颜色**取到同一组色** → 跨仓库多选出现 ≥2 分组头且「跨仓库不可对比」→ 同仓库两条开放基准选择器 → 选基准后出现四类对比计数 → 取消全部勾选回到空态。

### 既有门 T03302 的归因（不是本单引入）

`verify-t03302-ui.mts` 当前恒有 3 项红；本单用「同一门跑 HEAD 基线 vs 改动后」做归因：

| 断言 | HEAD 基线 | 本单改动后 | 根因（与本单无关，早于本单） |
| --- | --- | --- | --- |
| U-01 弹窗以 role=dialog 出场 | FAIL | **PASS** | 原生 `<dialog>` 没有显式 `role` 属性，门取 `getAttribute('role')` 得空。本单顺带补 `role="dialog"`（语义等价、无障碍更明确）后转绿 |
| U-03 行内字段齐备 | FAIL | FAIL | 门的 `firstRowCells` 取 `row.children` 的文本，而 T05074「C-04 改判内层原生按钮」已把行内单元格整体包进一个 `<button>`，于是只剩一段拼接文本 |
| U-18 边界点名 | FAIL | FAIL | 探针切到「非 git / 未配工作空间」项目后仍读到上一项目的 7 条提交（切项目探针未等到重取数落定） |

（另有一次跑出 `PASS=3 FAIL=1 SKIP=1`，A-01 门内构建失败——是并行会话当时把 `TasksPage.tsx` 改到语法破损的瞬时态，`tsc` 复核当前树为绿后重跑即恢复 24/2，属多会话并行的样本污染，不是本单问题。）

另：门里 `.card-btn[aria-label]` 选择器因 `ReportPage` 把 `aria-label` 移到卡片内层 `<button>` 而恒为 0（会让 U 组整体以「面板未出场」假红）。本单把选择器对齐成 `.card-btn button[aria-label]`——只改取元素的路径，判据不变。**注意 `scripts/tests/` 在 `.gitignore:103` 内，这处修正只在本地生效。**

视觉取证：`tmp/t05210/shot-light-single.png`（单选浅色）、`shot-light-multi.png`（跨仓库聚合）、`shot-light-compare.png`（基准对比）、`shot-dark-single.png`（深色主题）。

## 已知边界（未做，不影响本单验收）

1. **摘要区只显示 subject，没有 commit body**：`collectGitGraph` 的 `--format` 里没有 `%b`，加字段会改动讲稿侧共用的取数口径；本条以「完整 subject 换行显示 + SHA/父提交/分支/统计」满足「摘要」语义。
2. **对比是文件集对比，不是内容 diff**：只凭每条提交的 name-status/numstat 就能给结论，不需要再取一次 diff 全文；界面上措辞为「仅基准有 / 仅其余有 / 状态不同 / 状态相同」，不宣称「内容相同」。
3. **>40 条选中时分批串行取数**：进度以「读取中 k/n」呈现，未做多批并发（服务端单批已是一次 git 进程，并发收益低、进程数风险高）。
4. **既有红门**（与本单无交集、未处理）：`verify:t02354-mcp-prd-preview`、`verify:t02300-import-preview`。

## 回写

- 任务 T05210 → `done`（`verified` 待人工 UI 抽查后置 1）。
- 待提交 commit 清单：上述 6 个新增 + 2 个修改文件（另有 `tmp/t05210/*` 取证产物不入库）。
