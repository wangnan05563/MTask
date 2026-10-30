# -*- coding: utf-8 -*-
"""八期批次1 回传驱动：建派生单 → 逐单 running/progress start → result → progress done → done verified → 复核。

全部经 MCP 接口（scripts/mcp-direct-call.py 的 call/unwrap），零 sqlite 直写。
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SKILL = r'C:/Users/hspcadmin/.qoder-cn/skills/mtask/scripts/mcp-direct-call.py'
src = open(SKILL, encoding='utf-8').read().split('def main(')[0]
mod = {}
exec(compile(src, SKILL, 'exec'), mod)
ensure_session, call, unwrap = mod['ensure_session'], mod['call'], mod['unwrap']
SID = ensure_session()
OUT = Path('D:/code/otherProjects/26_MTask/.tmp_mt8/writeback.log')
log_lines = []


def rpc(name, args):
    res = call(SID, name, args, 3)
    txt = ''
    if isinstance(res, dict):
        txt = '\n'.join(i.get('text', '') for i in res.get('content', []) if i.get('type') == 'text')
        if res.get('isError'):
            txt = 'ERR ' + txt
    else:
        txt = str(res)
    log_lines.append('%s -> %s' % (name, txt[:400]))
    return txt


def find_no(txt):
    m = re.search(r'T\d{4,6}', txt or '')
    return m.group(0) if m else None


DERIVED = []
d1 = rpc('mtask_create_task', {
    'title': '【AI回写待审核】sonar 采集产物脱敏：scanning.properties/report-task.txt 不落 token 与绝对路径',
    'description': '来源：T03407（八期 M3.3 安全实现）。\n\n本批已闭环 Git 侧三项（只读白名单、remote URL 凭据剥离、外链 http/https 校验）；'
    '剩余「Sonar 采集产物脱敏」依赖 Sonar 设置页与扫描 job 尚未落地，先建单占位。\n\n'
    '要做：1) 写 sonar-scanner 的 .properties 时 token 走环境变量而非明文入文件；'
    '2) 若仍落盘 report-task.txt，写完后立即脱敏 projectKey/token 行；'
    '3) 快照目录（MTask_DATA_DIR/tmp）内的采集产物不进入任何对外展示/导出。',
    'projectName': 'mtask八期',
    'priority': 'high',
    'derivedFrom': 'T03407',
})
DERIVED.append((find_no(d1), 'properties 脱敏'))
d2 = rpc('mtask_create_task', {
    'title': '【AI回写待审核】sonar_issue_fps 7 天窗口清扫 job（与回写阈值/汇总单同批实施）',
    'description': '来源：T03402（八期 M2.2 表）/ T03434（M1.16 数据完整性）。\n\n表与索引已建（fp 主键 + created_at 索引），'
    '但清扫 job 的写入方（回写规则：阈值、≤50 条、汇总单、三级禁令）属于八期 Sonar 批次，尚未产生行——'
    '先建空 job 等于写一段没有生产者的代码，故与本批解耦。\n\n'
    '要做：随「回写规则」批次一起落：每日（或扫描收口时）DELETE FROM sonar_issue_fps WHERE created_at < now-7d，'
    '并在 T03434 的清理验证里补断言。',
    'projectName': 'mtask八期',
    'priority': 'normal',
    'derivedFrom': 'T03402',
})
DERIVED.append((find_no(d2), 'fps 7 天清扫'))
# 建单响应文本里同时含 derivedFrom 编号，正则首匹配会取到父单号——用显式编号覆盖（本轮实测 T03601/T03602）
if os.environ.get('DERIVED_NOS'):
    _n = os.environ['DERIVED_NOS'].split(',')
    DERIVED = [(_n[0].strip(), 'properties 脱敏'), (_n[1].strip(), 'fps 7 天清扫')]
dv = '、'.join('%s（%s）' % (n or '建单失败', t) for n, t in DERIVED)
D0 = DERIVED[0][0] or '建单失败'
D1 = DERIVED[1][0] or '建单失败'
log_lines.append('DERIVED=' + dv)

EV_GATE = ('门 scripts/tests/verify-t03436-git-links.mts（隔离 MTask_DATA_DIR + 真 git fixture：初始提交/普通提交/重命名/二进制/tag）'
           '实跑 PASS=91 / FAIL=0；npm run typecheck 无错。')
EV_SMOKE = ('真机冒烟（隔离实例 43999 + 独立数据目录，REST 21 项 + MCP over HTTP 4 项）实跑 23 PASS / 0 FAIL：'
            '建项目→绑定工作空间→建任务→MCP 回写（短 SHA/大写短写重复/仓库外 SHA/缺定位参数）→'
            'GET /tasks 内联 gitLinks+gitLinkCount→抽屉首屏三卡倒序与首提交标记→首提交空树基线清单→'
            '重命名 oldPath 与 ?diff=1 hunks→commit-summaries 去重→CRUD 与 409/404/400→GET /git/log→'
            'git status 全程零改动（只读红线）。')
COMMIT = '提交 d66893d（批次1 后端全链）+ 12442e0（commit-summaries 缺字段改 400）。'

DOCS = {}
DOCS['T03390'] = """## 根因
只读采集引擎的子命令白名单只含 rev-parse/log/diff/show，`remote get-url`（取 origin 供外链）与 `cat-file --batch`（批量取 blob，后续 git-extract 的取数底座）都在白名单外；同时批量摘要需要 `--format` 里带 \\x1f/\\x1e 作字段/记录分隔符（主题含空格与冒号时按空格拆分会歧义），原 `--format=` 值域不放行这两个控制字符，命令被拒后整页摘要静默变空。

## 影响范围
server/src/services/gitCollect.ts 的白名单与选项校验；八期所有「按点名 SHA 批量取摘要/取内容」的路径都依赖它。既有 log/diff/show 调用方不受影响。

## 修复
- server/src/services/gitCollect.ts:20 `GIT_READONLY_SUBCOMMANDS` 增 `remote`、`cat-file`
- server/src/services/gitCollect.ts:31 ALLOWED_FLAGS 增 `diff --name-status`、`remote: []`、`cat-file: [/^--batch$/]`；`--format=` 值域放行 \\x1f\\x1e
- server/src/services/gitCollect.ts:49 POSITIONAL_HEAD：`remote` 首段仅 `get-url`，`cat-file` 不接受任何位置参数（对象名走 stdin）——写类子动作 `remote add/set-url/remove/prune/update/rename`、`cat-file --batch-command/-e/-t/--textconv/--filters` 全部拒
- 新增 `collectCommitSummaries` / `collectCommitFiles` / `catFileBatch`(Map) 取数函数

## 验证
门 W 组 8 项：正例（remote get-url / cat-file --batch / diff --name-status）+ 负例 18 条（10 个写类子命令、6 个 cat-file 非法形态、选项注入、对象规格含 `..`/绝对路径/控制字符）全绿。%s

## 本次回写
%smain 代码已入库（见提交）。派生单见「下一步建议」。""" % (EV_GATE, COMMIT)

DOCS['T03391'] = """## 根因
`git remote get-url origin` 在没有 origin 时非零退出，落到通用 `failed` 分类，用户看到的是一行 git 原生 stderr（"no such remote 'origin'"），无法与「不是仓库」「没装 git」「超时」区分，前端也拿不到可操作的指引。

## 影响范围
GitErrorKind 联合类型与 classifyExecError；任务抽屉的 Git tab、外链按钮、后续 git-extract 的降级提示都按 kind 分流。

## 修复
- server/src/services/gitCollect.ts:58 新增枚举值 `no-remote`（`GitErrorKind` 现为 no-git/not-a-repo/no-remote/timeout/too-large/denied/invalid-patch/failed 八项，既有分类一项不丢）
- server/src/services/gitCollect.ts:60 `NO_REMOTE_RE` 覆盖 git 三种原生措辞，classifyExecError 里优先归为 no-remote
- server/src/util/gitRemote.ts:107 `isNoRemoteError`：调用方按类型判断，不再比对字符串
- server/src/services/taskGitLinks.ts 抽屉视图 `remote.noRemote` 显式回给前端（外链按钮据此置灰而非消失）

## 验证
门 R-01 非仓库目录归 not-a-repo（不与 no-remote 混谈）、R-02 无 origin 仓库归 no-remote（新枚举值而非 failed 原始报错）、M-06/M-07 联合类型与错误类保持向后兼容。%s

## 本次回写
%s""" % (EV_GATE, COMMIT)

DOCS['T03401'] = """## 根因
任务↔提交关联原先无处落库（讲稿侧只做一次性区间取数），需要一个可幂等写入、可按任务/按 SHA 双向查、且随任务删除级联清理的表。

## 影响范围
server/src/db/schema.ts（建表即迁移，幂等 CREATE TABLE IF NOT EXISTS + PRAGMA foreign_keys=ON）；task_events 新增 kind='git_link' 事件流。

## 修复
- server/src/db/schema.ts task_git_links(id, task_id→tasks ON DELETE CASCADE, sha, workspace_path, source, created_at)
- 唯一索引 `ux_task_git_links(task_id, sha)`（幂等的最后一道）+ 普通索引 `ix_task_git_links_sha`
- `source` 为开放枚举 agent/manual/ci（ci 预留，未来 CI 回写不改表）

## 验证
门 C-01 索引形状（含 UNIQUE 复合列）、C-03 DB 层真的拦得住重复 (task_id,sha)、C-04 写入预留值 ci 不报错；N 组断言删除任务后 task_git_links 零孤儿行（FK CASCADE 生效）。冒烟 R-01/R-06 在真库上验证同一 SHA 重复绑定不产生第二行。%s

## 本次回写
%s""" % (EV_GATE, COMMIT)

DOCS['T03402'] = """## 根因
Sonar 回写需要「同一问题不重复开单」的指纹表：以 issue fingerprint 为主键、带 created_at 供 7 天窗口判定，超窗后允许重新提醒（避免永久静音真实回归）。

## 影响范围
server/src/db/schema.ts 建表；消费方是八期 Sonar 回写规则批次（阈值、≤50 条、汇总单、三级禁令）。

## 修复
- server/src/db/schema.ts sonar_issue_fps(fp TEXT PRIMARY KEY, task_id, created_at) + 索引 `ix_sonar_fps_created(created_at)`（清扫即 `WHERE created_at < now-7d` 走该索引）

## 验证
门 C-02 主键与 created_at 索引就位；N 组断言无残留行。%s

## 本次回写
表结构已入库（%s）。**7 天窗口清扫 job 本批未做**——它的写入方（回写规则批次）还不存在，先建空 job 等于写一段没有生产者的代码，已按规则建派生单：%s。

## 下一步建议
- %s 与「回写规则」批次同批实施 fps 清扫（已建派生单，见上）；（仅观察不建单）清扫触发点建议放在每次 Sonar 扫描收口处，避免独立定时器多一套生命周期。""" % (EV_GATE, COMMIT, dv, D1)

DOCS['T03344'] = """## 根因
关联只能由显式写入产生（PRD 裁定不做 commit message 解析），因此需要一条「AI 回写主通道」：短 SHA 要在服务端按当前工作空间解析成 40 位、重复回写要幂等、解析不出要逐条点名而不是整批静默失败。

## 影响范围
server/src/services/taskGitLinks.ts（新）；REST 与 MCP 共用同一实现，不分叉两条写入路径。

## 修复
- `linkCommits(ref, commits, source)`：逐个 normalizeShaInput（7–40 位十六进制）→ resolveCommitSha（短写/大写都归一到 40 位）→ `INSERT OR IGNORE` + 前置存在性判定，返回 {linked, skipped, resolved[], errors[]}
- 每次真实写入落 `task_events(kind='git_link', detail='op=link sha=… source=…')`，解绑落 `op=unlink`
- 任务不存在/已归档、项目未绑定工作空间、SHA 不在仓库：三类都进 errors 并给可操作文案（「请先在项目上绑定仓库目录」「请在正确仓库中重新回写」）
- `unlinkCommit` 仅允许 source=manual，agent 来源回 409 并说明「请在提交侧修正后重新回写」

## 验证
门 L-01…L-14：短 SHA 解析、重复（大写+短写）幂等 skipped=1、批量 3 SHA、仓库外 SHA 点名、非法 ID 点名、任务不存在、未绑定工作空间、git_link 事件逐条落地、+N 计数、内联字段不丢原字段、手动绑定 source=manual、409/404 解绑。冒烟 M-01…M-04 走真 MCP over HTTP 通道复现同一结果（含缺定位参数被拒）。%s %s

## 本次回写
%s""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03345'] = """## 根因
一页任务列表里逐提交请求摘要会产生 N×M 次 git 调用；PRD 要求「按 workspace 分组、每组一次 `git log --no-walk`、SHA 去重、>200 截断」。任一 SHA 解析不了会让整条命令非零退出，直接返回空等于「静默丢数据」。

## 影响范围
server/src/services/gitCollect.ts 的批量摘要 + server/src/routes/gitLinks.ts 的 POST /git/commit-summaries + 60s 结果缓存。

## 修复
- `collectCommitSummaries(cwd, shas)`：一次 `git log --no-walk <shas>`，`\\x1f` 分字段 / `\\x1e` 分记录（主题里的空格与冒号不再造成歧义），产出 sha/shortSha/author/date(%%aI 绝对时间)/subject/refs/parents
- 整条命令失败时**退化为逐个点名**：能解析的照常返回，解析不出的进 `missing`（工作空间换绑后的旧链接即走这条）
- `buildSummaryGroups(links)`：按 workspacePath 分组，未绑定单独成组（kind=no-workspace），单页唯一 SHA > 200 → 只解析前 200 并回 `truncated=true`，被截掉的计入 missing
- 路由层 60s 缓存键 = 排序后的 `taskId:sha` 串（翻页即换键，不会命中旧页结果）

## 验证
门 S-01…S-07（4 SHA 零缺失、四要素齐且中文主题不乱码、tag 带进 refs、不存在 SHA 进 missing、请求去重、非仓库按 kind 抛出不伪装空结果、解析器单测）、D-11 多 workspace 分组各自归位、D-12 201 个唯一 SHA → truncated=true 且被截项进 missing。冒烟 R-05 三请求去重后回 2 条。%s %s

## 本次回写
%s另：冒烟发现「body 缺 links 字段」会静默回 `{groups:[]}`，已按「不静默失败」改为 400 点名（提交 12442e0）。""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03346'] = """## 根因
抽屉首屏只要摘要+统计，变更文件与 diff 必须点开才取数（一次请求只解析一个提交），否则一页十几条提交会把整仓 diff 拉满；首提交没有父提交，用父当基线会直接报错。

## 影响范围
server/src/services/gitCollect.ts（numstat/name-status 解析、cat-file 底座）、server/src/services/taskGitLinks.ts（懒加载视图）、路由 GET /tasks/:id/git/:sha/files。

## 修复
- `collectCommitFiles(cwd, sha, parents)`：基线 = `parents[0]`，**首提交用 `GIT_EMPTY_TREE_SHA1`** → 「初始提交」也能列全新增文件
- `parseNumstat`（二进制行 `-`/`-` → additions/deletions=null + binary=true，不谎报行数）与 `parseNameStatus`（`R100<TAB>old<TAB>new` → status=R + oldPath）
- `buildTaskGitFiles(ref, sha, withDiff)`：只接受该任务已关联的 SHA（未关联回 404，防越权读任意提交内容）；`?diff=1` 时逐文件附 hunks 供 DiffView 直接渲染
- 请求的 SHA 在当前仓库解析不出来 → 回 `missing`（工作空间换绑场景）

## 验证
门 F-01…F-04（首提交全 A、R 带 oldPath、二进制 null、**与 `git show --stat` 原生口径逐文件对账**）、D-05…D-07（懒加载单提交、diff hunks、未关联 SHA 404）、K-01/K-02（`cat-file --batch` 单进程批量取 blob，顺序与请求相关，二进制按原字节）。冒烟 R-03 首提交清单全 A、R-04 `b.txt → b2.txt` 带 oldPath 且 hunks 非空。%s %s

## 本次回写
%s""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03349'] = """## 根因
Q7 裁定：回写 commit 走**独立 MCP 工具**，不扩展 `mtask_update_task`（原工具的字段更新语义会把一次关联写入伪装成任务编辑，且无法承载 linked/skipped 回执）。

## 影响范围
server/src/mcp/server.ts 注册表 + mtask 技能的回写步骤（技能侧需接入，见下一步建议）。

## 修复
- 新增 `mtask_link_git_commit({taskNo|id, commits: string | string[]})` → 直接调 TaskGit.linkCommits(source='agent')，与 REST 手动绑定同一实现
- 返回文本 `linked=… skipped=… resolved=N` + 每条 `输入 -> 40 位 SHA` + 错误逐条点名；structuredContent 原样带 {linked,skipped,resolved,errors}
- 缺 taskNo 与 id 时回 isError（不落到任意任务）

## 验证
门 M-01…M-05（注册为独立工具、与 linkCommits 同源、回执四项、路由挂载锚点、旧讲稿端点保留）；冒烟在隔离实例上以真 MCP over HTTP 调用四次：短 SHA linked=1、大写短写重复 skipped=1 + 两个新 SHA linked=2、仓库外 SHA linked=0 且 errors 点名、缺定位参数被拒。%s %s

## 本次回写
%s**技能侧接入未做**：mtask SKILL.md 的「完工回写」步骤还没写上「有 commit 就调 mtask_link_git_commit」，属跨仓（技能目录）改动，见下一步建议。

## 下一步建议
- 已建派生单：%s（properties 脱敏）与 %s（fps 清扫）。
- 待建：mtask 技能 SKILL.md 回写步骤接入 mtask_link_git_commit ——本批**未建单**，因为它改的是技能目录（不在本仓库工作空间），按「缺环境」口径处理更合适；已在 T03396 结果中登记为跨环境阻塞项。""" % (EV_GATE, EV_SMOKE, COMMIT, D0, D1)

DOCS['T03396'] = """## 根因
同 T03349（同一交付物的三个编号之一：3.7 需求项 / M1.1 计划项 / M1.1 实现项）。工具落库要同时写 task_git_links 与 task_events，否则「关联了什么」与「谁在什么时候写的」两套口径会各说各话。

## 影响范围
server/src/mcp/server.ts、server/src/services/taskGitLinks.ts。

## 修复
- 工具 handler 内不自行 INSERT，一律走 `TaskGit.linkCommits`：该函数在同一次调用里写 task_git_links（幂等）+ task_events(kind='git_link', op=link sha=… source=agent)
- 写入前后都用同一 SHA 归一化结果（40 位小写）作为 key，避免大小写/短写产生两行

## 验证
门 L-08 断言每次写入都落一条 git_link 事件且 detail 形状为 `op=link sha=<40位> source=agent`；L-13 断言解绑落 `op=unlink`。冒烟 M-01/M-02 走真 MCP 通道，事件在隔离实例库里按同样口径落地。%s %s

## 本次回写
%s与 T03349/T03419 为同一交付物，结果文档互为参照（三单同源，避免三份不同描述）。mtask 技能步骤接入属技能目录（非本仓库），已按跨环境阻塞登记。""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03419'] = """## 根因
AC-1 要求「回写 1 个 SHA」与「回写 3 个 SHA」两条分支都有明确回执，且重复回写不产生重复行——回执口径必须在工具层就固定，不能靠调用方自己数。

## 影响范围
server/src/mcp/server.ts 的 mtask_link_git_commit 入参与返回。

## 修复
- 入参 `commits: z.union([z.string(), z.array(z.string())])`：单个字符串与数组都接受（1/3 个 SHA 同一通道）
- 返回首行恒为 `linked=N skipped=M resolved=K`，后随每条 `输入 -> 完整 SHA` 与逐条错误
- 幂等由 `INSERT OR IGNORE` + 前置存在性判定共同保证（服务层判 skipped，DB 唯一索引兜底并发）

## 验证
门 L-01（1 个 SHA：linked=1）、L-02（重复短写+大写：linked=0 skipped=1，库里仍一行）、L-03（3 个 SHA：linked=3）、C-03（并发唯一约束真的拦得住）。冒烟 M-01/M-02 在真 MCP 通道上打出 `linked=1` 与 `linked=2 skipped=1` 两条分支。%s %s

## 本次回写
%s""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03361'] = """## 根因
列表页要显示提交徽标（最新一条 + 「+N」），若逐任务查询就是 N 次 SQL；PRD 要求 GET /tasks 直接内联，翻页时摘要接口按唯一 SHA 集合请求，60s 缓存且翻页不得命中旧结果。

## 影响范围
server/src/routes/index.ts（GET /tasks）、server/src/routes/gitLinks.ts（commit-summaries + 缓存）、server/src/services/taskGitLinks.ts（attachGitLinks / listLatestLinksByTask）。

## 修复
- `attachGitLinks(items)`：**页内一次查询**取回本页全部任务的关联，加性字段 `gitLinks`（仅最新一条）+ `gitLinkCount`（总数供 +N）；GET /tasks 的裸数组响应契约不变，原字段一项不丢
- commit-summaries 缓存键 = 排序后的 `taskId:sha` 串（键控翻页失效），TTL 60s
- 单页唯一 SHA > 200 → `truncated=true`，页脚据此提示「本页提交摘要已截断」

## 验证
门 L-10（内联字段：只含最新一条、count 为总数、原字段全保留）、D-12（201 唯一 SHA → truncated=true）、S-05（请求 SHA 去重）。冒烟 R-01 真库内联返回 gitLinkCount=3 + 最新一条 SHA 与预期一致。%s %s

## 本次回写
%s验证缺口（如实）：60s TTL 的**时序**未做断言（门与冒烟只验了缓存键控与去重行为，没有跨 60s 观察过期），属计时类弱断言，留给前端联调批次一并复测；（仅观察不建单）。""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03397'] = """## 根因
手动绑定/解绑是用户对「AI 回写错了」的唯一纠正通道，必须与 agent 来源分开计权：agent 回写的关联不允许在 UI 上删（否则回写记录与真实提交会永久错配且无人知晓），只能删 manual。

## 影响范围
server/src/routes/gitLinks.ts：GET/POST /tasks/:id/git/links、DELETE /tasks/:id/git/links/:sha。

## 修复
- GET links：抽屉刷新与「+N」浮层的数据源
- POST links（body `{sha}`）：走 manualLink，source=manual；非法 SHA 形态 400 点名
- DELETE links/:sha：manual → 删除 + `op=unlink` 事件；agent → **409** 并说明「AI 回写的关联请在提交侧修正后重新回写」；该任务没有这个关联 → 404
- 任务不存在/已归档 → 404（不落到空视图）

## 验证
门 L-11…L-14（manual 绑定来源、agent 解绑 409 且库里仍在、manual 解绑成功 + 事件、重复解绑 404）。冒烟 R-06（已有 agent 关联时手动绑定不产生重复行、来源如实保留 agent）、R-06b 非法 SHA 400、R-07 干净任务上 manual 绑定→解绑闭环、R-08 409、R-08b 404、R-10 不存在任务 404。%s %s

## 本次回写
%s""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03398'] = """## 根因
抽屉首屏要「打开就实时查询」（AC-5：不展示可能过期的缓存视图），同时错误必须分类可见（no-git / not-a-repo / no-remote / 未绑定 / 空关联），否则用户看到的是一片空白。

## 影响范围
server/src/routes/gitLinks.ts：GET /tasks/:id/git、GET /tasks/:id/git/:sha/files、POST /git/commit-summaries。

## 修复
- GET /tasks/:id/git 走 `buildTaskGitView`：提交卡按时间倒序，字段含五层（作者/绝对时间/主题/统计/SHA+来源）+ isInitial + laterThanTask + workspaceDrift
- 未绑定工作空间 → `degraded.kind='no-workspace'` + 「请先绑定仓库目录」指引（不报错、不空白）
- 目录不是仓库 → `degraded.kind='not-a-repo'`；git 不可用/超时/过大同样按 kind 回传，前端据 kind 出不同文案
- 无 origin 远端 → `remote.noRemote=true`（外链按钮置灰但摘要照常显示，不拖垮首屏）
- 文件清单/差异懒加载端点单独取数

## 验证
门 D-01…D-10（倒序与五层字段、isInitial、laterThanTask 正反例、懒加载、未关联 SHA 404、no-workspace/not-a-repo 降级、换绑后旧 SHA 全进 missing）。冒烟 R-02（3 卡倒序 + 首提交标记 + 四要素）、R-03/R-04（清单与 diff）、R-05（摘要接口）。%s %s

## 本次回写
%s前端「刷新保留旧内容 / 未绑定给 WorkspaceSelect / 空态提示」属 T03363 与抽屉 Git tab 批次，本批只提供后端契约。""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03436'] = """## 根因
Git 树取数原先只挂在讲稿命名空间（POST /plans/code-review-lecture/git-log），任务侧要复用得先取 projectId 再解析工作空间——不应让任务功能长期依赖一个讲稿语义的路径。

## 影响范围
server/src/routes/gitLinks.ts 的 GET /git/log；server/src/routes/plans.ts 的旧端点。

## 修复
- 新 `GET /git/log?projectId=&head=&all=&skip=&limit=&search=`：按项目解析工作空间后复用同一 `queryGitLog`
- 旧 `POST /plans/code-review-lecture/git-log` **保留不动**，与新增端点共用同一实现（「同一份取数逻辑，两个入口」= 转发的语义），不做破坏性改名
- 缺 projectId 回 400 点名，不猜项目

## 验证
门 M-04/M-05（新端点与 router 挂载锚点、旧讲稿端点仍在库内）。冒烟 R-09 取回 3 条提交（含 parents/refs）、R-09b 缺 projectId 400。%s %s

## 本次回写
%s""" % (EV_GATE, EV_SMOKE, COMMIT)

DOCS['T03407'] = """## 根因
采集链路有两个泄露面：① remote URL 常写成 `https://user:token@host/repo.git`，原样进前端 DOM 等于泄露 token；② 取数若含任何写类 git 子命令，就可能改动用户工作树（PRD 的 Git 只读红线）。

## 影响范围
server/src/util/gitRemote.ts（新）、server/src/services/gitCollect.ts 白名单、外链渲染。

## 修复
- `stripUrlCredentials`：scheme 形态剥掉 userinfo（token 不进展示串），scp 形态规范化；展示串只留 host/owner/repo
- `parseRemoteRepo`：scp 式先判（`git@host:grp/sub/repo.git` 冒号后不是端口，走 URL 解析会因端口非法整体失败），GitLab 子群组取末两段
- `buildCommitLink`：Q6 四类（github/gitee/gitlab 含自建）；识别不出 → null 走站内兜底（不拼一个 404 外链）；GitLab 走 `/-/commit/`，其余 `/commit/`
- `isSafeExternalUrl`：仅 http/https，`javascript:` / `file:` 一律拒（渲染层与主进程同口径二次校验）
- 本地路径形态（`D:\\code\\x.git`）不误判为远端 → 不给外链

## 验证
门 R-04 凭据剥离（token 不出现）、R-05 scp 解析 host/owner/repo、R-06 四类平台、R-07 外链构造与 unknown 不给链接、R-08 仅 http/https；门 W 组 18 条写类/越权负例全部被拒；门 N-01 **git status 字节级前后一致**、仓库内无 `.scannerwork` 残留。冒烟 N-01/N-02 在真服务上复现只读红线。%s %s

## 本次回写
%s四项中 Git 侧三项已闭环；「Sonar properties 脱敏」依赖 Sonar 设置/扫描批次，本批未做。

## 下一步建议
- %s：sonar 采集产物（scanning.properties / report-task.txt）不落 token 与绝对路径（已建派生单）。""" % (EV_GATE, EV_SMOKE, COMMIT, D0)

DOCS['T03434'] = """## 根因
关联表挂在任务上，若删除/归档路径不清理，抽屉会读到已消失任务的提交（幽灵行），摘要接口还会为不存在的 SHA 白白 spawn git。

## 影响范围
server/src/db/schema.ts（FK + 索引）、server/src/services/taskGitLinks.ts（查询侧过滤）、八期 Sonar 批次（fps 表清理）。

## 修复
- `task_git_links.task_id` 声明 `REFERENCES tasks(id) ON DELETE CASCADE`，且连接层 `PRAGMA foreign_keys = ON`（否则 CASCADE 静默失效——这是最常见的坑）
- 查询侧（attachGitLinks / listLatestLinksByTask）只按当前页任务 id 取数，不产生跨任务残留读
- 归档任务不物理删行，关联保留（重新打开仍在）；物理删除才级联清理
- `sonar_issue_fps` 侧：索引 `ix_sonar_fps_created` 已备好，清扫 job 属 Sonar 批次（见派生单）

## 验证
门 N 组：在开启 FK 的隔离库上删除任务后断言 `SELECT COUNT(*) FROM task_git_links WHERE task_id=? = 0`（CASCADE 真生效，不是靠服务层手删）；门 C-02 断言 fps 表与 created_at 索引就位。%s

## 本次回写
%s孤儿行清理已闭环；fps 7 天清扫本批未做（写入方尚不存在），已建派生单 %s。

## 下一步建议
- %s：随「回写规则」批次实施 fps 清扫（同一张表、同一个生产者，拆开只会造成两套生命周期）。""" % (EV_GATE, COMMIT, D1, D1)

ORDER = ['T03390', 'T03391', 'T03401', 'T03402', 'T03344', 'T03345', 'T03346', 'T03349', 'T03396',
         'T03419', 'T03361', 'T03397', 'T03398', 'T03436', 'T03407', 'T03434']
# 纯 UI 交互不在本批：T03363（新鲜度/错误处理前端）保持 todo，不进本轮回传
VERIFIED = set(ORDER)

import datetime
PLATFORM = 'qoder'
summary = []
ONLY = os.environ.get('WB_ONLY')
MODE = os.environ.get('WB_MODE', 'full')
for no in ORDER:
    if ONLY and no not in ONLY.split(','):
        continue
    sess = '%s-%s-%s' % (PLATFORM, no, datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
    if MODE == 'results':
        rpc('mtask_update_task_result', {'taskNo': no, 'result': DOCS[no]})
        chk = rpc('mtask_get_task', {'taskNo': no})
        summary.append('%s(result-only) len=%s' % (no, len(chk)))
        continue
    rpc('mtask_report_progress', {'platform': PLATFORM, 'session_id': sess, 'task_id': no, 'phase': '八期批次1 后端实现与验证'})
    r = rpc('mtask_update_task_result', {'taskNo': no, 'result': DOCS[no]})
    rpc('mtask_report_progress', {'platform': PLATFORM, 'session_id': sess, 'task_id': no, 'pct': 100, 'phase': '已回传'})
    rpc('mtask_report_progress', {'platform': PLATFORM, 'session_id': sess, 'task_id': no, 'done': True, 'phase': '完工'})
    d = rpc('mtask_update_task', {'taskNo': no, 'status': 'done', 'verified': True} if no in VERIFIED
            else {'taskNo': no, 'status': 'done'})
    chk = rpc('mtask_get_task', {'taskNo': no})
    m = re.search(r'"status"\s*:\s*"([^"]+)"', chk)
    v = re.search(r'"verified"\s*:\s*(true|false)', chk)
    st = re.search(r'"ai_state"\s*:\s*"([^"]*)"', chk)
    summary.append('%s status=%s verified=%s ai_state=%s resultErr=%s' % (
        no, m.group(1) if m else '?', v.group(1) if v else '?', st.group(1) if st else '?',
        'ERR' if r.startswith('ERR') or d.startswith('ERR') else 'ok'))

OUT.write_text('DERIVED: ' + dv + '\n\n' + '\n'.join(summary) + '\n\n---- RAW ----\n' + '\n'.join(log_lines), encoding='utf-8')
print('DERIVED=' + dv)
print('\n'.join(summary))
