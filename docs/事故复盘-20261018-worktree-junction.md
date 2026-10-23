# 事故复盘：worktree 收口误删主仓（2026-10-18）

> 关联任务：**T02364**（worktree 收口事故：junction 未先拆导致主仓 server/web/electron 工作树被清空、node_modules 被删）
> 性质：事故登记与恢复口径。**本单不代改他人 WIP**，仅做事实复核 + 恢复 SOP。
> 登记基准：`0c3dfa2`（事故前 HEAD）→ `0f18e08`（事故后补丁落点），均已在仓库中核实存在。

---

## 1. 摘要（TL;DR）

处理 **T02304** 时，在负对照用的 detached worktree 收口阶段执行了 `git worktree remove --force`，**没有先拆掉该副本里指向主仓 `node_modules` 的 junction**。Windows 下 git 把 junction 当作真实目录递归删除，于是沿链接吃进主仓，清空了主仓的 `node_modules/` 以及 `server/`、`web/`、`electron/` 三个目录（共 **253 个受版本管理的文件**从工作树消失）。

恢复已按 git 索引全量还原，主仓代码状态已回到可用；但**只存在于工作树、从未 `git add` 的并发会话 WIP 无法恢复**，需业主/原会话自行确认与重建。

---

## 2. 事故经过

- 时间：2026-10-18 05:03~05:04（本机时间），位于 commit `0c3dfa2` 之后。
- 触发动作：对负对照 detached worktree `D:/code/tmp/gate-tmp/t02304-negwt` 执行 `git worktree remove --force`。
- 直接原因：该 worktree 的 `node_modules` 是一个指向**主仓** `node_modules` 的 Windows junction（符号链接的目录形态），移除前未删除它。

## 3. 根因

Windows 上 `git worktree remove --force` 对 junction 的处理是「当目录递归删除」。junction 不指向本地副本，而是指向主仓，于是删除操作顺着链接一路删进主仓：

- 主仓 `node_modules/` 被清空（0 项）；
- 主仓 `server/`、`web/`、`electron/` 三个目录被清空，共 **253 个受版本管理文件**从工作树消失。

> 本质：junction 与主仓是**同一物理目录的两个名字**。对它所在的 worktree 做「强制移除」，等于对主仓做破坏性操作。

## 4. 影响范围

| 对象 | 状态 |
|---|---|
| 主仓 `node_modules/` | 被清空，已 `npm ci` 重建 |
| `server/` `web/` `electron/` 工作树 | 253 个受版本管理文件消失，已按索引还原 |
| `HEAD` / 索引 / `.git` | **未受影响**（`git rev-parse HEAD` = `0c3dfa2`，无 stash，对象库完好） |
| 未提交 WIP（见第 6 节） | **不可恢复**，需业主确认 |

## 5. 已执行的恢复（已落地）

1. `git ls-files -d`（261 项）→ `xargs git restore --worktree --`：**全部 253 个文件已还原**（源为 git 索引；其中 8 个他人已 `MD` staged 的改动按索引内容还原，其余按 HEAD）。`git status` 已无 ` D` 项。
2. `npm ci --no-audit --no-fund`（registry=npmmirror）按 `package-lock` 重建 `node_modules`，已跑完。
3. 校验：`git rev-parse HEAD` 不变，无 stash，`.git` 完好。

## 6. 无法恢复的部分（需业主确认）

只存在于工作树、从未 `git add` 的未提交改动，索引与对象库里都没有其 blob，无法还原。事故前快照显示被清空目录内的未提交改动至少包括：

- `server/src/services/estimateExportXlsx.ts`（相对 HEAD **+503/-151**，Sonar S3776 复杂度重构 + T02123 守卫）—— 现已被还原为 HEAD 版本；T02304 补丁已按 HEAD 形态另行入库 `0f18e08`，不依赖该重构。
- `server/src/routes/estimates.ts`（相对 HEAD +86 行，含 T02120 改值留痕一族）、`server/src/services/estimate-engine.ts`（+4 行）。
- `server/src/db/schema.ts`、`server/src/mcp/server.ts`、`server/src/index.ts`、`server/src/routes/plans.ts` 中「已 staged 之外的未 staged 改动」。
- `web/src/**`（快照被截断未逐条清点）、`electron/package.json`、`server/package.json`、`server/scripts/m1-checks-ui.mjs`。

排查过的恢复通道（皆无果）：`git stash list` 空；VS Code 本地历史（`AppData/Roaming/Code/User/History`）无 `estimateExportXlsx` 命中；其余 worktree 副本（wtA/wtB/mtask-head-wt/mtask-hwt-*/t02299-wt）均为 detached HEAD 快照，只含历史提交，不含 WIP。

**请业主处理**：若那路并发会话（Sonar S3776 重构 / T02298 / T02301 一族）仍持有这些文件全文，请让它按上下文重写落盘再逐 hunk 复核——**不要整文件覆盖 `0f18e08` 之后的 `estimateExportXlsx.ts`**（里程碑行进引擎那一支已在 HEAD）。

## 7. 安全收口 SOP（本单核心交付）

**任何 worktree 负对照 / 副本收口，必须遵守：先拆链接，再移除。**

```bash
# 1) 先拆掉指向主仓的依赖链接（junction / 符号链接）
#    Windows junction 用 rmdir 或 Node unlinkSync；符号链接用 rm
node -e "const fs=require('fs'),p=require('path');const j=p.join(process.argv[1],'node_modules');try{if(fs.lstatSync(j).isSymbolicLink()||fs.junctionExists?false:true)fs.rmSync(j,{recursive:false,force:true});}catch(e){console.log('no junction:',e.message)}" <wt>

# 2) 确认该副本 node_modules 已不存在 / 不再是主仓链接后，再移除 worktree
git worktree remove --force <wt>
```

要点：
- **绝不对「其 `node_modules` 是主仓 junction」的 worktree 直接 `git worktree remove --force`**。
- 移除前用 `fs.lstatSync(<wt>/node_modules).isSymbolicLink()` 或 `junctionExists` 判断；是链接则先 `unlinkSync`/`rmdir`，再移除。
- 批量清理脚本同理：先 `unlinkSync(junction)`，**再** `rmSync(copy, {recursive:true})`。

## 8. 与本仓既有防护的衔接

`scripts/tests/verify-t02321-pack-precheck.mts`（gitignored，不入库）已落实同一条铁律（约 L602）：

```js
if (existsSync(join(copy, 'node_modules'))) continue; // junction 没解除就别往下删（会顺链删根依赖）
```

即「副本根下若仍挂着 `node_modules` junction，就**中止删除**、绝不顺链往下删主仓依赖」。新写的 worktree 清理 / 门夹具自清逻辑，一律复用这条判定，不要在别处重写一套不一致的口径。

## 9. 教训

- junction 与主仓是同一物理目录的两个名字，**对它所在 worktree 的任何「强制删除」都等价于对主仓动手**。
- worktree 收口的标准顺序固定为：**拆链接 → 校验无链接 → 再 `git worktree remove --force`**。
- 并发多会话场景下，「未提交 WIP」是最贵的不可恢复资产；破坏性清理前必须先把 WIP 提交或 stash，而不是赌它能还原。

---

*本复盘由 T02364 任务登记内容整理而成；恢复步骤与 SOP 可直接作为后续同类操作的 checklist。任务在 MTask 系统中的状态置 `done` 需经 MTask MCP/REST（`mtask_update_task`），不在此文档范围内。*
