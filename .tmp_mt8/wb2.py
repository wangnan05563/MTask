# -*- coding: utf-8 -*-
"""八期批次2（M1 Git 前端）回传驱动：建派生单 → 逐单 running + progress start → result → progress done → done(+verified) → 复核。

全部经 MCP 接口（scripts/mcp-direct-call.py 的 call），零 sqlite 直写。
T03392（§4.3 复用组件集成）不进本轮回传：8 项复用里只有 2 项属本批，其余由后续批次既有单承接，保持 todo。
"""
import datetime
import importlib.util
import json
import os
import re
from pathlib import Path

SKILL = r'C:/Users/hspcadmin/.qoder-cn/skills/mtask/scripts/mcp-direct-call.py'
src = open(SKILL, encoding='utf-8').read().split('def main(')[0]
mod = {}
exec(compile(src, SKILL, 'exec'), mod)
ensure_session, call = mod['ensure_session'], mod['call']
SID = ensure_session()
OUT = Path('D:/code/otherProjects/26_MTask/.tmp_mt8/writeback2.log')
PLATFORM = 'qoder'
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
    log_lines.append('%s -> %s' % (name, txt[:300]))
    return txt


def find_no(txt):
    # 建单响应正文里同时含「来源：Txxxx」，泛匹配会取到父单号——只认 task_no 字段
    m = re.search(r'"task_no"\s*:\s*"(T\d{4,6})"', txt or '')
    return m.group(1) if m else None


# ---------------------------------------------------------------- 派生单（先建，编号要写进各单 result）
# 已建过就复用编号：DERIVED_NOS 非空时不再建单，避免重复（硬规则 3 查重）
PRESET = [x.strip() for x in os.environ.get('DERIVED_NOS', '').split(',') if x.strip()]
DERIVED = []
d1 = '' if PRESET else rpc('mtask_create_task', {
    'title': '【AI回写待审核】Git 降级三场景（no-git / timeout / too-large）补可构造场景门与真机腿',
    'description': '来源：T03421（八期 M1.3 提交降级处理）/ T03363（2.2 新鲜度与错误处理）。\n\n'
        '⚠ 阻塞：本批真机实测已覆盖 not-a-repo / no-remote / no-workspace 三类（UI-27/28/28b/29/37），'
        '但 no-git（本机 git 恒在）、timeout（fixture 仓库极小）、too-large（diff 体积超限）三类无法在该环境自然构造，'
        '两单已按「未闭环」诚实标 verified:false。\n\n'
        '要做：1) 在 gitCollect 层加可注入的取数时限/体积阈值测试钩子（不放宽生产默认值）；'
        '2) 门 scripts/tests 补三场景（伪造 PATH 无 git、超阈值 diff、超时中断）；'
        '3) 前端 GIT_DEGRADED_HINT 三类文案各一条真机腿，确认「不可用徽标 + 原因 + 指引」齐备。\n\n'
        '与 T03355（4.2 边界与降级测试）同族但不重复：T03355 覆盖 Sonar 侧缺 scanner/JRE、并发 429、50MB/2000 上限，'
        '本单只管 Git 徽标与抽屉的这三类；实施时可共用同一注入钩子。',
    'projectName': 'mtask八期',
    'priority': 'normal',
    'derivedFrom': 'T03421',
})
DERIVED.append((find_no(d1), 'no-git/timeout/too-large 场景门'))
d2 = '' if PRESET else rpc('mtask_create_task', {
    'title': '【AI回写待审核】打包实例内主进程外链白名单实机复验（file:// 与自定义协议被 deny）',
    'description': '来源：T03358（八期 1.1 超链接行为实现）。\n\n'
        '⚠ 阻塞：需重打包并重启生产实例，用户 2026-10-19 裁定「生产实例重打包/重启不放行」，本批只做代码落地 + 纯函数谓词断言。\n\n'
        '已做：electron/main.js setWindowOpenHandler 仅对 ^https?:// 调 shell.openExternal，其余 deny；'
        '渲染层实测 window.open 记录为空（UI-34），6 例谓词断言（file:// / javascript: / mtask:// 拒，http/https/HTTPS 放行）。\n'
        '要做：重打包放行后，在装机实例里点一次 Git 外链，确认走系统浏览器且 file:// / 自定义协议被拦并留日志。',
    'projectName': 'mtask八期',
    'priority': 'normal',
    'derivedFrom': 'T03358',
})
DERIVED.append((find_no(d2), '打包实例外链白名单复验'))
d3 = '' if PRESET else rpc('mtask_create_task', {
    'title': '【AI回写待审核】remote 内容变更后摘要缓存即时失效（当前 60s TTL 窗口内徽标陈旧）',
    'description': '来源：T03343（八期 3.1 Git 徽标组件开发）/ 批次1 T03345（批量摘要缓存）。\n\n'
        '现状：缓存键已含工作空间（换绑即失效，UI-36 实证），但同一工作空间内 remote URL 被改动时，'
        '徽标外链在 60 秒 TTL 窗口内仍指向旧 remote（UI-37 实测复现：移除 origin 后抽屉已转站内、行上徽标仍有外链，63 秒后一致）。'
        '该窗口属设计内 TTL，不是缺陷；PRD 未要求即时失效。\n\n'
        '要做（若产品确认需要即时）：1) 项目工作空间/remote 变更事件里显式清 summaries 缓存；'
        '2) 或在徽标 tooltip 标注摘要时刻，让用户可判断新鲜度。若维持现状，请在 PRD §3.1.6 补一句「外链允许 ≤60s 陈旧」。',
    'projectName': 'mtask八期',
    'priority': 'low',
    'derivedFrom': 'T03343',
})
DERIVED.append((find_no(d3), '60s TTL 外链陈旧窗口'))
if len(PRESET) >= 3:
    DERIVED = [(PRESET[0], 'no-git/timeout/too-large 场景门'), (PRESET[1], '打包实例外链白名单复验'),
               (PRESET[2], '60s TTL 外链陈旧窗口')]
dv = '、'.join('%s（%s）' % (n or '建单失败', t) for n, t in DERIVED)
DA, DB, DC = [(x[0] or '建单失败') for x in DERIVED] + [''] * (3 - len(DERIVED))
log_lines.append('DERIVED=' + dv)

# ---------------------------------------------------------------- 共享证据块
EV_HEAD = """
## 验证
真机 UI 实测（非交回人工抽验）：驱动 `D:/code/otherProjects/26_MTask/scripts/tests/t03343-git-ui-driver.mjs` 经 CDP 直驱 headless Chrome，在隔离实例上实跑 **PASS=43 / FAIL=0**，全程 **无 JS 异常**、**无 4xx/5xx 接口**。
环境口径：隔离后端 `MTask_PORT=39893` + `MTask_DATA_DIR=D:/tmp/t03343-ui/data`（落 D: 避 C: 满）+ `MTASK_STATIC_DIR=web/dist`（跑的是构建产物，非 dev server）；夹具是真实 `git init` 仓库（2 提交 + 带凭据 origin），生产实例 :39877 全程未触碰（UI-00）。
留档：`D:/tmp/t03343-ui/ui-results.json`（43 条 checks + jsErrors + apiLog）、`D:/tmp/t03343-ui/t03343-git-ui.png`（真机截图）、`D:/tmp/t03343-driver2.log`（全文）。
编译与门：`npm run typecheck` 无错；`npm run verify:head-selfconsistency` 9/9 PASS（HEAD 自身两侧皆可编译）；只读红线 UI-31（整轮仓库 `git status --porcelain` 恒空、目录内零新增文件）。
"""
EV_COMMIT = '主体入库：提交 `6b2def7`（13 文件，+1284 / −84）——八期批次2 M1 前端全链。'
EV_COMMIT_E = '入库：提交 `6b2def7`（前端全链）+ 提交 `4ea35d3`（`electron/main.js:1257` 主进程 window.open 协议白名单）。'
EV_B1 = '后端侧断言沿用批次1 门 `scripts/tests/verify-t03343-git-links.mts`（PASS=91 / FAIL=0）与真机冒烟 23 PASS / 0 FAIL。'

DOCS = {}

DOCS['T03343'] = """## 根因
列表与看板原先没有任何位置承载「任务↔提交」关联；而一次批量取数成功后，逐任务仍需区分五种状态（正常 / 已完成未回写 / 待办暂无 / 降级不可用 / 摘要解析中）。这五态若在前端重新推断，必然与服务端的错误分类漂移，最终表现是「降级被画成正常」。

## 影响范围
新增 `D:/code/otherProjects/26_MTask/web/src/ui/gitBadge.tsx`（256 行，本批唯一徽标实现）——列表行与看板卡共用同一状态机，不各写一份。悬浮首版用多行 `title` + 等价 `aria-label`（富 HoverCard 属 P1，已由 T03394 单列，不阻塞本单）。显隐开关是会话级，不进 localStorage。

## 修复
- `web/src/ui/gitBadge.tsx:134 GitBadge`（行内徽标）/ `:226 GitBoardBadge`（看板纯文本变体，不嵌交互元素）
- 五态锚点：`:144 git-unlinked`（已完成未回写）、`:152 git-none`（待办暂无关联）、`:163 git-unavailable`（降级；文案 `:19 GIT_DEGRADED_HINT` + `:29 gitDegradedText`，kind 直接取服务端不回猜）、`:177 git-pending`（解析中 / 「提交已不在当前仓库」）、正常态外链锚点 `:197`
- 悬浮四要素：`:37 gitSummaryTitle`（作者·时间 / 主题 / 来源 / 完整 40 位 SHA），同时写进 `title` 与 `aria-label`（`:197`）
- 「+N」浮层：`:209 git-more` → `:59 GitLinksPopover`（列全部关联、逐条来源标注与独立复制入口 `:114`、Escape 与点外即关 `:103`）
- 截断提示：`:254 gitTruncatedNote`（>200 唯一 SHA 被截时给明示，不静默丢）
- 开关：`web/src/pages/TasksPage.tsx:433 gitOn = useSessionState('tasks.git.badge')`，工具条按钮 `:3936 git-toggle`；接入点 `:2640`（列表）、`:1788`（看板）

## 验证（本单相关断言条目）
UI-04（逐行简写对账）、UI-05 / UI-05b（暂无 / 未回写两态）、UI-08（四要素同进 title 与 aria）、UI-10（键盘可达，Enter 即复制）、UI-11（+N 浮层列全 2 条关联、Escape 即关）、UI-14（开关关闭后徽标与提示条整体消失并会话级落值，再开恢复）、UI-15（看板卡内仅纯文本）、UI-27 / UI-29（降级与换绑恢复）、UI-35 / UI-36 / UI-37（徽标在新鲜度、换绑、无 remote 三场景下不假装正常）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true（UI 实测全绿）。富 HoverCard 提升属 P1，沿用既有单 T03394，不重复建单。

## 下一步建议
- """ + DC + """：同一工作空间内 remote 被改动时，徽标外链在 60s 摘要缓存窗口内仍指旧 remote（UI-37 实测复现，属设计内 TTL）——需产品裁定「允许 ≤60s 陈旧」或补即时失效（已建派生单）。
- （仅观察不建单）T03394 富 HoverCard 已在库中挂 todo，批次4 承接。"""

DOCS['T03358'] = """## 根因
外链此前没有统一构造口径：`git remote get-url` 返回的 URL 常含 `user:token@` 凭据，直接拼进 `href` 等于把口令写进 DOM、浏览器历史与用户可见的 tooltip；另一侧，Electron 渲染层的 `window.open` 会交给主进程 `shell.openExternal`，没有协议白名单时 `file://` 与自定义协议可被页面拉起本机程序。

## 影响范围
服务端 `server/src/util/gitRemote.ts`（平台识别与拼链，是渲染层 href 的唯一来源）；前端 `web/src/ui/gitBadge.tsx` 的锚点属性；Electron 主进程 `electron/main.js` 的 window-open 闸口。渲染层无任何自行拼 URL 的路径。

## 修复
- `server/src/util/gitRemote.ts:16 stripUrlCredentials`（userinfo 含口令整段剥离后再拼链，剥离发生在服务端）
- `:34 parseRemoteRepo`（ssh / https 两种 remote 都归一为 `owner/repo`）、`:65 detectPlatform`（github / gitlab / gitee / coding 四类，自托管域名按 host 前缀归入 gitlab 系）、`:107 buildCommitLink`（识别不出平台 → 返回空，前端转站内）、`:114 isSafeExternalUrl`（仅 `http`/`https` 才可为外链）
- `:129 isNoRemoteError`：调用方按类型判断而非比字符串
- `web/src/ui/gitBadge.tsx:197` `target="_blank" rel="noopener noreferrer"` + 平台名前置 aria 文案；`:202` 无可用 URL 时不渲染假链接，改 `onOpenGit` 走站内抽屉
- `electron/main.js:1257`：`setWindowOpenHandler` 仅当 `/^https?:\\/\\//i` 才 `shell.openExternal(url)`，其余一律 `{action:'deny'}`

## 验证（本单相关断言条目）
UI-06（`href` 精确等于 `https://github.com/acme/widget/commit/<40位SHA>`，`rel=noopener noreferrer`）、UI-07（凭据泄露扫描：整页 HTML / 所有 `title` / 所有 `href` 均不含夹具口令串）、UI-19（抽屉提交卡同口径，平台名前置展示）、UI-34（渲染层 `window.open` 记录恒空——外链从未在渲染层直接打开）、UI-37（无 remote 时徽标 `href=null` 且「站内查看」兜底在位）。
纯函数谓词另跑 6 例：`file://`、`javascript:`、`mtask://` 全拒；`http://`、`https://`、`HTTPS://` 全放行。渲染层仅两处 `window.open` 调用方（`web/src/pages/SettingsPage.tsx:644`、`:769`）皆 http(s)，白名单不伤既有功能。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT_E + """
**本单标 verified:false（done 未验证）**：主进程分支是「代码落地 + 谓词断言 + 渲染层从不直接开窗」三重证据，但「装机实例里点击外链真的由系统浏览器接管、`file://` 真的被 deny」需重打包并重启生产实例——用户 2026-10-19 裁定该项不放行，本批无法自行完成实机复验。已建派生单 """ + DB + """ 承接。

## 下一步建议
- """ + DB + """：重打包放行后在装机实例复验主进程闸口（已建派生单，阻塞原因写在生产实例不放行）。"""

DOCS['T03359'] = """## 根因
徽标行内要放复制入口，但任务列表整行可点（点击即开抽屉），复制按钮若事件冒泡会「复制的同时把抽屉弹开」；另一个硬约束是复制目标必须是 40 位全量 SHA——7 位简写粘给 Agent 或贴进检索框都不唯一。

## 影响范围
复用既有 `web/src/ui/CopyButton.tsx`（语义与视觉不动，避免与讲稿侧复制按钮分叉），新增两处接入：行内徽标与「+N」浮层逐条。

## 修复
- `web/src/ui/gitBadge.tsx:207`（行内）：`getText={() => link.sha}` 取全量 40 位（展示用 `shortSha`，复制用 `sha`，同源不二次截断），`ariaLabel` 带完整 SHA 便于读屏核对
- `:114`（浮层逐条）同口径，`title="复制完整提交 ID"`
- `web/src/ui/CopyButton.tsx:16 doCopy` 内 `stopPropagation`（阻断行 onClick），`:21/:31` `lucide Copy → Check` 1500ms 回落；失败走 flash/notice 提示而非静默

## 验证（本单相关断言条目）
UI-09（真指针点击 → 剪贴板写入 **40 位全量 SHA** 且出现已复制反馈，行抽屉未被误开）、UI-10（复制按钮 Tab 可聚焦、Enter 即触发同一复制——§4.4 可访问性）、UI-11（浮层内每条关联各带独立复制入口）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。

## 下一步建议
（仅观察不建单）复制反馈时长 1500ms 沿用组件既有值，若批次6 主题化统一动效时长再一并调。"""

DOCS['T03360'] = """## 根因
已完成任务缺提交 ID 时 AI 无法回溯补齐（任务一旦被归档删除，关联再无处可补），需要一处「看得见、且当场可执行」的入口。两个易踩的点：统计口径必须限「本页已加载」范围（跨 tab 全量统计既不实也会误导批量补录），以及回写指令文本要让 Agent 直接可执行（含编号与 taskId，不能只给标题）。

## 影响范围
`web/src/pages/TasksPage.tsx` 已完成 tab 顶部的提示条与其两个动作；不新增后端接口（统计来自批次1 已内联的 `gitLinks`/`gitLinkCount`）。

## 修复
- `web/src/pages/TasksPage.tsx:639 unlinkedDone`：仅取当前页 `status==='done'` 且 `gitLinks.length===0` 的任务
- `:4202-4214` 条体（`data-t03360="unlinked-bar"`，`role="status"`）：文案「本页已加载 N 条已完成任务中，M 条未回写提交 ID」+「归档删除后无法补齐」原因
- `:649 copyWriteBackInstruction`：生成含任务编号、`taskId=<id>`、标题清单与 `mtask_link_git_commit` 调用样例的文本，一次写剪贴板
- `:4205 copy-instruction` / `:4211 manual-link` 两个动作；后者经 `:675-676` 把整页未回写任务压入 `gitLinkQueue` 并打开 Git 树弹窗（批量补录队列入口）

## 验证（本单相关断言条目）
UI-12（待办 tab `bar===null`；已完成 tab 条内计数 = 接口口径算出的本页未回写数，跨 tab 才出现）、UI-13（剪贴板文本同时含 `mtask_link_git_commit`、任务编号与 `taskId=`——Agent 拿来即可执行）、UI-39（「手动关联」把本页未回写任务送进 Git 树弹窗且弹窗真的取到提交行）、UI-05b（行内「未回写」态与条体原因文案一致）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。

## 下一步建议
（仅观察不建单）跨页（翻页后）累计口径 PRD 已裁定不做，保持「只统计本页」。"""

DOCS['T03362'] = """## 根因
详情抽屉原先只有 5 个 tab，Git 关联无处展开（身份 / 来源 / 主题 / 统计 / 变更文件五层）；且 `focusDrawerTab` 有白名单校验，新 tab 不登记则「从列表徽标点击直达 Git 页」这条深链会被静默吞掉。

## 影响范围
`web/src/components/TaskDetailDrawer.tsx`（tab 类型、图标、渲染位）与新增 `web/src/components/GitCommitTab.tsx`（400 行，Git 页全部）；变更文件 diff 走共享 `DiffView`，不复制第二套渲染。

## 修复
- `web/src/components/TaskDetailDrawer.tsx:22` `TaskDetailTab` 联合类型增 `'git'`（同时进 `focusDrawerTab` 白名单，`:20` 校验才认）；`:273` 第 6 个 tab，图标 `lucide GitBranch`（`:17` 导入）；`:653` 渲染 `GitCommitTab`；`:69` 绑定/解绑后回报父级刷新列表
- `web/src/components/GitCommitTab.tsx:335 commit-card` 五层：`:335` 卡体（`role=button`、可选中）、`:345 primary`（主提交）、`:346 source-{manual|agent}` 来源角标、`:347 initial` 首提交、`:357 subject` 主题、`:344` 时间/作者行、统计行 + `:242 files` 懒加载清单
- `:292 file-{A|M|D}` 变更状态字母徽标（与接口、git numstat 同源）；`:312` 展开行走共享 `rowAttr="data-t03362-row"`（`web/src/ui/DiffView.tsx:41 DiffFileView`）
- `:250 subtasks` 子任务折叠区常显（Sonar 回写的子任务在详情侧可见），展开列编号与标题
- 顶部工具条 `:189 refresh`、`:194 bind`、`:199 platform` 平台名；错误回显 `:208 error` / `:209 unlink-error`

## 验证（本单相关断言条目）
UI-16（点看板卡/行 → 抽屉落在 git tab）、UI-17（卡上主题/作者与 `git show` 逐字一致，主提交与来源角标齐备）、UI-18（统计行「增 3 / 删 2」与 numstat 合计逐字一致）、UI-20（首屏 0 次 files 请求，选中提交才 1 次）、UI-21（A/M/D 三方同源）、UI-22（二进制标「二进制」不给行号）、UI-23（点文件行才渲染 DiffView 行级 DOM，展开前 0 行）、UI-24（子任务折叠区展开后列编号与标题）、UI-30（首提交标「初始提交」且清单与 `git show` 一致）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。真机跑测中打回并修掉一条层级缺陷：抽屉内解绑二次确认面板默认 z-index 1000 < 抽屉 1100，「确定」不可命中（见 T03364）。

## 下一步建议
（仅观察不建单）`:20` 白名单与 tab 类型同文件，后续加 tab 只需改两处，无需再派单。"""

DOCS['T03363'] = """## 根因
两处会「骗人」：摘要 60s 缓存 + 工作空间换绑后旧链接解析不到时，UI 会继续显示一条看起来正常的徽标；错误若不分类，用户只看到一行 git 原生 stderr，既不明白坏在哪，也没有可操作出口。

## 影响范围
前端摘要缓存 hook `web/src/utils/gitSummaries.ts`（新增 141 行）、抽屉新鲜度与降级面板 `GitCommitTab.tsx`、服务端视图字段 `server/src/services/taskGitLinks.ts`。

## 修复
- `web/src/utils/gitSummaries.ts:13 CACHE_TTL_MS = 60_000`、`:47 useGitSummaries`（一次批量解析本页全部 SHA；刷新期间保留旧内容不清空、不重排，`:85` TTL 命中即不发请求）
- 提交晚于任务更新时间：`GitCommitTab.tsx:348 later`（服务端 `server/src/services/taskGitLinks.ts:319 laterThanTask` 判定，前端不比自己时钟）
- 工作空间漂移：`:349 drift` + `:223 missing`（服务端 `:320 workspaceDrift`、`:366 files missing`）——解析得到的标「工作空间已换绑」，解析不到的逐条点名，绝不当成「无关联」
- 降级分类面板：`:213 degraded`（服务端 `:327 degraded` 回 kind），文案映射 `web/src/ui/gitBadge.tsx:19 GIT_DEGRADED_HINT`；未绑定工作空间额外给选择入口（可操作出口，不是空白报错）
- 缓存键含工作空间（`server/src/routes/gitLinks.ts` 组键 `taskId:workspace:sha`），换绑即失效
- 空态明示 `:229 empty`；文件清单侧降级 `:277 files-degraded` / 空 `:280 files-empty`

## 验证（本单相关断言条目）
UI-27（换绑非仓库目录后行徽标转「不可用」并给原因与指引）、UI-28（非 Git 目录这一类只解释不给绑定入口）、UI-28b（未绑定工作空间时降级面板内出现工作空间选择入口）、UI-29（换绑回来即恢复，不缓存坏状态）、UI-35（未来日期提交 → 「提交晚于任务更新时间」角标且最新回写即主提交、不误挂漂移）、UI-36（换绑到另一仓库：可解析项标漂移、解析不到进 missing、行徽标转「已不在当前仓库」）、UI-37（无 remote：缓存过期后不再给外链、抽屉转站内；60s 窗口内沿用旧组为设计内 TTL）。
""" + EV_HEAD + EV_B1 + """
## 本次回写
""" + EV_COMMIT + """
**本单标 verified:false（done 未验证）**：新鲜度（later / drift / missing / 换绑恢复 / 无 remote）已真机全绿，但 `no-git`（未装 git）、`timeout`（大仓库取数超时）、`too-large`（diff 体积超限）三类降级场景在本机无法自然构造——代码路径与文案映射都在，缺的是能触发它们的场景门。已建派生单 """ + DA + """。

## 下一步建议
- """ + DA + """：补 no-git / timeout / too-large 三场景的可注入测试钩子与门/真机腿（已建派生单）。"""

DOCS['T03364'] = """## 根因
三件事叠在一起：Git 树弹窗原先挂在讲稿命名空间（任务侧复用要么跨模块取数、要么复制一份必然漂移）；选择上限 200 必须两端都拦（前端即时反馈、服务端才是权威口径）；解绑的二次确认面板默认 z-index 1000，而任务详情抽屉是 1100——面板被抽屉压住，「确定」点不着，且它的面板外 mousedown 即取消，结果解绑永远走不完 yet 界面毫无报错。

## 影响范围
`web/src/ui/GitTreePickerModal.tsx`（复用 + 新增 zIndex）、`web/src/utils/gitTreeSelect.ts`（上限与区间选择）、`web/src/ui/dialogs.tsx`（确认对话框层级可配——**通用修复，任何高层浮层内调用 askConfirm 都受益**）、`GitCommitTab.tsx` 绑定/解绑链路、服务端 `gitLinks.ts` 端点与 `taskGitLinks.ts` 解绑守卫。

## 修复
- `web/src/ui/dialogs.tsx:125/:128/:149` `ConfirmDialogProps.zIndex`，`:181 askConfirm(message, { zIndex })`；`GitCommitTab.tsx:147` 解绑确认传 `zIndex: 1200`（高于抽屉 1100）
- `web/src/ui/GitTreePickerModal.tsx`：`:62 zIndex` prop、`:172` 弹窗根（`data-lck="git-tree-modal"`）、`:203` 搜索输入、`:299` 确认关联、`:153` 超上限报错；左侧分支/标签树 + 右侧提交列表 + 顶部搜索 + 底部确认，全部沿用讲稿侧组件不复制
- `web/src/utils/gitTreeSelect.ts:36 MAX_SELECTED_COMMITS = 200`（注释点明与服务端 `gitCollect.MAX_SELECTED_COMMITS` 同值）、`:104-105` 截断并回报被截数、`:149` 选择集按提交顺序归一
- 取数端点提至 `server/src/routes/gitLinks.ts:125 GET /git/log`，旧 `POST /plans/code-review-lecture/git-log` 保留并转发同一 `queryGitLog`（同一份逻辑，两个入口）
- 绑定 `GitCommitTab.tsx:123 bindShas` → 服务端 `taskGitLinks.ts:485 manualLink`（`source='manual'`）；解绑 `:143`（仅 manual，`:384`；服务端 `:246 unlinkCommit` 对 agent 来源回 409 并说明「请在提交侧修正后重新回写」），失败经 `:209 unlink-error` 显式回显
- 事件流：`taskGitLinks.ts:124` 每次绑定/解绑写 `task_events kind='git_link'`（`op=link` / `op=unlink`）

## 验证（本单相关断言条目）
UI-25（弹窗浮在抽屉之上——z-index 高于 1100——确认后即时落库并刷新列表与卡片）、UI-26（二次确认「确定」在抽屉之上**可命中**：前 2 条 → 1 条，接口 `gitLinkCount` 与 DOM 卡片同步减少）、UI-26b（同一抽屉里 agent 回写的卡片没有解绑按钮、手动的有）、UI-38（弹窗取数走 `GET /git/log`：标题搜索「初始」使 3 行 → 1 行且命中项即首提交，已选计数区在位）。
""" + EV_HEAD + EV_B1 + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。其中 z-index 层序是本轮真机实测打回后定位并修掉的真实缺陷（不只是测试脚手架问题）——`dialogs.tsx` 的改动属通用受益。

## 下一步建议
（仅观察不建单）区间选择（选 A 与 B 自动含中间提交）已由 `gitTreeSelect` 覆盖并入库，无需再派活。"""

DOCS['T03413'] = """## 根因
M5.1 的口径很具体：列表要 `…状态|T✦a1b2c3d[⧉]|…` 行内展示且 title 悬浮四要素，看板卡受拖拽宿主限制**只允许纯文本**（嵌链接/按钮会抢走拖拽指针，实测会破坏拖拽）。两侧共用一个组件时，必须让「看板变体」显式去掉交互，而不是靠调用方记得传参数。

## 影响范围
`web/src/pages/TasksPage.tsx` 列表行与看板卡两处接入点；`web/src/ui/gitBadge.tsx` 的两个导出（行内 / 看板）。

## 修复
- 列表行：`web/src/pages/TasksPage.tsx:2640`（`GitBadge`，`onOpenGit={(task) => openDetailDrawer(task, 'git')}` 点击徽标直达抽屉 Git 页，`flash` 复用既有通知通道）
- 看板卡：`:1788`（`GitBoardBadge` → `web/src/ui/gitBadge.tsx:226`，`Omit<GitBadgeProps,'onOpenGit'>` 从类型上就不接受交互参数；内部 `:232`/`:246` 只渲染 `<span>`，`:246` title 保留四要素、无 `a`/无 `button`）
- title 四要素：`gitBadge.tsx:37 gitSummaryTitle`（作者·时间 / 主题 / 来源 / 完整 SHA），`:207` 复制入口只在行内变体出现
- 取数：`:636 useGitSummaries(gitBadgeTasks, gitOn, workspaceOfTask)` 一次批量解析本页全部 SHA（按 workspace 分组、每组一次 `git log --no-walk`、>200 截断）

## 验证（本单相关断言条目）
UI-03（`GET /tasks` 内联 `gitLinks`/`gitLinkCount` 加性字段，原字段一个不丢）、UI-04（逐行短码 = 服务端 `gitLinks[0].shortSha`，主提交取最新回写）、UI-08（四要素同进 title 与 aria-label）、UI-15（**看板卡内查询不到任何 `a` 与 `button`，仅纯文本徽标**）、UI-16（点看板卡 → 抽屉 git tab 打开，交互没被徽标吃掉）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。

## 下一步建议
（仅观察不建单）看板卡的「站内查看」深链刻意不做（评审#3 裁定看板仅纯文本），点击整卡即进抽屉。"""

DOCS['T03414'] = """## 根因
M5.2 要「顶部提交卡列表 + 左时间轴 + 选中卡下方文件清单 + 底部子任务折叠区」。一屏十几条提交若都带清单与 diff，一次请求会把整仓 diff 拉满——「选中才取数」是量级唯一可控点，因此必须能证明网络层真的只发了一次。

## 影响范围
`web/src/components/GitCommitTab.tsx`（页面骨架与懒加载编排）；后端沿用批次1 的三个端点，无新增接口。

## 修复
- `GitCommitTab.tsx:186` 页面骨架：顶部提交卡列表（`:335`，左时间轴由卡体竖线承载）+ 选中卡下方 `:242 files` 区 + 底部 `:250 subtasks` 折叠区
- 取数编排：首屏只 `GET /tasks/:id/git`（摘要 + 统计，`server/src/services/taskGitLinks.ts:286 buildTaskGitView`）；选中提交才 `GET /tasks/:id/git/:sha/files`（`server/src/routes/gitLinks.ts:86`），并按 `:214 ORDER BY created_at DESC` 倒序展示；展开文件行才渲染 diff hunks
- 中间态齐备：`:277 files-degraded`（清单侧降级）、`:280 files-empty`（该提交无变更文件）、`:223 missing`（解析不到的点名）、`:229 empty`（无关联）
- 底部子任务区：`:250`（常显折叠，编号 + 标题）

## 验证（本单相关断言条目）
UI-20（**网络层断言：抽屉首屏 0 次 files 请求，选中一条提交恰好 1 次且不发第二趟**）、UI-21（清单字母徽标与接口、numstat 三方同源）、UI-23（点文件行才展开共享 DiffView，展开前行级 DOM 为 0）、UI-24（底部子任务折叠区展开后列出编号与标题）、UI-30（首提交也能列全清单——diff 基线走空树）、UI-25/UI-26（页内绑定/解绑后该区即时刷新）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。

## 下一步建议
（仅观察不建单）清单懒加载等待超时已加诊断输出（`waitDrawer`），门里再出现空清单可直接读日志定位。"""

DOCS['T03415'] = """## 根因
M5.3 明确「复用原有组件」：讲稿侧 Git 树弹窗与任务侧「关联提交」是同一份取数逻辑的两个入口。复制一份的后果是搜索/过滤/上限规则随后各自漂移；而搜索过滤放在服务端会让每次键入都打一次 git。

## 影响范围
`web/src/ui/GitTreePickerModal.tsx`（复用，加 zIndex 与任务侧确认回调）、`web/src/utils/gitTreeSelect.ts`（纯函数选择逻辑，前端过滤）、`server/src/routes/gitLinks.ts`（端点上提 + 旧端点转发）。

## 修复
- `web/src/ui/GitTreePickerModal.tsx`：`:172` 弹窗根 `data-lck="git-tree-modal"`、左侧分支/标签树 + 右侧提交列表（`data-lck="git-tree-row"`）、`:203` 顶部搜索输入（`data-lck="git-tree-search"`，纯前端过滤，不打后端）、`:299` 底部确认关联、`:153` 超 200 上限明示、`:62 zIndex`（高于抽屉 1100）、`git-tree-cancel` 取消
- `web/src/utils/gitTreeSelect.ts`：搜索命中、区间选择（选首尾含中间）、`:104`/`:149` 上限 200 截断与被截数回报
- 取数：`server/src/routes/gitLinks.ts:125 GET /git/log` 为权威端点；旧 `POST /plans/code-review-lecture/git-log` 保留并转发同一 `queryGitLog`，讲稿侧行为不变
- 批量入口：`web/src/pages/TasksPage.tsx:4211 manual-link` 也从这条通道打开弹窗（一次补录整页未回写）

## 验证（本单相关断言条目）
UI-38（弹窗取数确走 `GET /git/log`；输入「初始」后搜索按钮使行数 3 → 1 且存活项即首提交；已选计数区 `git-tree-selected` 在位；取消按钮正常关闭）、UI-39（未回写提示条「手动关联」批量入口打开弹窗且真的列出可关联提交）、UI-25（弹窗层级高于抽屉，确认后落库并刷新列表与卡片）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。

## 下一步建议
（仅观察不建单）旧讲稿端点已只做转发，待批次4 讲稿侧重构时可正式下线（现网有引用，暂不删）。"""

DOCS['T03420'] = """## 根因
M1.2 的三个口径容易各自实现：行内只放得下 7 位简写（且扫读更友好），但复制**必须**给全量 40 位；已完成无关联要灰标「未回写」而待办无关联是「—」，两态不能混；「Git 开关」若落 localStorage 会跨会话粘住用户的一次性显隐。

## 影响范围
`web/src/ui/gitBadge.tsx`（简写展示 + 复制取全量 + 两态区分）、`web/src/pages/TasksPage.tsx`（开关与会话态）、`web/src/utils/gitSummaries.ts`（批量摘要）。

## 修复
- 简写展示：`web/src/ui/gitBadge.tsx:197`（`link.shortSha` 直接来自服务端 `:107 buildCommitLink` 同一批数据，前端不二次截断，避免 `abc…` 之类再造）
- 复制全量：`:207` `getText={() => link.sha}`（40 位），`ariaLabel` 带完整 SHA
- 未回写灰标：`:144 git-unlinked`（title 明确「请 AI Agent 通过 MCP 回写或手动关联」）；待办暂无：`:152 git-none`
- 开关切页保持：`web/src/pages/TasksPage.tsx:433 gitOn = useSessionState('tasks.git.badge')`（会话级：切页/切筛选保持，关应用即复位），工具条 `:3936 git-toggle`（`aria-pressed` 同步）
- 批量取数：`:636 useGitSummaries(...)` 一次解析本页全部 SHA，60s 缓存（`web/src/utils/gitSummaries.ts:13`），刷新期间保留旧内容

## 验证（本单相关断言条目）
UI-01 / UI-02（夹具与落库口径）、UI-04（逐行 7 位简写与服务端 `gitLinks[0].shortSha` 完全一致）、UI-09（**展示 7 位但剪贴板落 40 位全量**）、UI-05 / UI-05b（待办「—」与已完成「未回写」两态分明）、UI-14（开关关闭 → 徽标与未回写提示条整体消失，`sessionStorage['tasks.git.badge']` 落值，再开恢复）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。

## 下一步建议
（仅观察不建单）简写位数 7 由服务端 `shortSha` 统一给，未来改宽度只动一处。"""

DOCS['T03421'] = """## 根因
M1.3 四场景（未绑定工作空间 / 非 Git 目录 / 未装 git / 无 remote）此前统一表现为「徽标不显示」——用户分不清是没数据还是环境坏了，而且降级态仍可能带着一条拼错的外链（坏外链比没外链更糟）。

## 影响范围
服务端错误分类 `server/src/services/gitCollect.ts`（`GitErrorKind`）与视图侧 `taskGitLinks.ts:327 degraded`；前端文案映射 `web/src/ui/gitBadge.tsx:19/:29`；行内不可用态 `:163`；抽屉降级面板 `GitCommitTab.tsx:213`。

## 修复
- 分类不合并：`GitErrorKind` 含 `no-git` / `not-a-repo` / `no-remote` / `timeout` / `too-large` / `denied` / `invalid-patch` / `failed`（既有分类一项不丢，批次1 T03391 已落 `no-remote`）
- 前端只映射不回猜：`web/src/ui/gitBadge.tsx:19 GIT_DEGRADED_HINT`（每类一句可操作文案）+ `:29 gitDegradedText`（kind + 原始 message，排查时不丢上下文）
- 行内降级态：`:163 git-unavailable`——**不渲染外链**，只给原因与指引；`git-pending` 与「已不在当前仓库」区分（`:177`）
- 抽屉降级面板 `GitCommitTab.tsx:213`：按分类给原因；`not-a-repo` 这类**只解释不给绑定入口**（绑了还是非仓库，给了反而误导）；未绑定工作空间则给 WorkspaceSelect 可操作出口（`:282`）
- 换绑回来即恢复：不在前端缓存坏状态（`web/src/utils/gitSummaries.ts` 缓存键含 workspace，`server/src/routes/gitLinks.ts`）

## 验证（本单相关断言条目）
UI-27（换绑非仓库目录 → 行徽标转「不可用」并给原因与指引，href 已消失）、UI-28（非 Git 目录这一类只解释、无绑定入口）、UI-28b（未绑定工作空间：降级面板内出现工作空间选择入口，不是空白报错）、UI-29（换绑回来即恢复）、UI-37（无 remote：不给坏外链，站内兜底在位）。
""" + EV_HEAD + EV_B1 + """
## 本次回写
""" + EV_COMMIT + """
**本单标 verified:false（done 未验证）**：四场景中 `not-a-repo`、`no-remote`、`no-workspace` 三类真机全绿；`no-git` 需卸载 git 或伪造 PATH、`timeout` 与 `too-large` 需可控阈值钩子才能构造，本批未做——三类在前端只有文案映射，缺触发它们的场景证据。已建派生单 """ + DA + """（与 T03363 同一张，不重复）。

## 下一步建议
- """ + DA + """：补 no-git / timeout / too-large 三场景的可注入测试钩子 + 门 + 真机腿（已建派生单）。"""

DOCS['T03422'] = """## 根因
M1.4 要求「五层提交卡实时显示，文件清单与 `git show --stat` 一致，首提交标记」。「与 git show 一致」意味着卡片统计必须直接取服务端 numstat 合计而不是前端逐行累加（前端累加会漏掉二进制与重命名两侧）；首提交没有父提交，拿父当基线直接报错、清单显示空。

## 影响范围
`web/src/components/GitCommitTab.tsx` 提交卡与清单区；服务端 `taskGitLinks.ts:286 buildTaskGitView`、`gitCollect.collectCommitFiles`（首提交空树基线，批次1 T03346）。

## 修复
- 五层卡：`GitCommitTab.tsx:335 commit-card`（身份：`:343` SHA + 时间/作者；来源角标 `:346 source-{manual|agent}`；主提交 `:345 primary`；主题 `:357 subject`；统计行 + 变更文件清单 `:242 files`）
- 统计同源：数字取服务端 numstat 合计，前端不二次累加；顺序由 `server/src/services/taskGitLinks.ts:214 ORDER BY created_at DESC` 决定（最新回写在最上、即主提交）
- 首提交：`card.isInitial` → `:347 initial`「初始提交」，清单基线走 `GIT_EMPTY_TREE_SHA1`（不是父提交），保证首提交也能列全部新增文件
- 状态徽标：`:292 file-{A|M|D}`（与接口、numstat 三方同源）；二进制文件标注「二进制」不给行号（`:277`/`:280` 覆盖降级与空清单两态）
- 新鲜度角标：`:348 later`（提交晚于任务更新时间）、`:349 drift`（工作空间已换绑）

## 验证（本单相关断言条目）
UI-17（卡上主题/作者与 `git show` 逐字一致，主提交与来源角标齐备）、UI-18（「增 3 / 删 2」与 numstat 合计逐字一致）、UI-21（A/M/D 字母徽标与接口、git numstat 三方同源）、UI-22（二进制标注而非行号统计）、UI-30（**首提交标「初始提交」，diff 基线走空树，清单与 `git show` 一致而不是空清单**）、UI-35（最新回写即主提交 + 晚于任务更新时间角标）。
""" + EV_HEAD + EV_B1 + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。

## 下一步建议
（仅观察不建单）卡片实时性 = 打开即查 + 手动 refresh（`:189`），PRD 未要求推送失效，不额外加轮询。"""

DOCS['T03423'] = """## 根因
M1.5 的两个真实风险：绑定/解绑后列表与抽屉是两份视图，任一不刷新就会出现「卡片已删、行上徽标还在」的假状态；解绑若允许 agent 来源，等于把手动删除 AI 权威链路伪装成可逆操作（AI 回写应在提交侧修正后重新回写）。

## 影响范围
`web/src/components/GitCommitTab.tsx` 绑定/解绑链路 + `TaskDetailDrawer.tsx:69` 回报父级 + 服务端 `taskGitLinks.ts` 解绑守卫与事件流 + `web/src/ui/dialogs.tsx` 确认层级（通用受益）。

## 修复
- 绑定即时反映：`GitCommitTab.tsx:123 bindShas` → 成功后 `:69`（`TaskDetailDrawer.tsx`）回报父级重取 `GET /tasks`，列表行 `gitLinks`/`gitLinkCount` 与卡片同时更新；服务端 `taskGitLinks.ts:485 manualLink`
- 解绑仅 manual：`:143`（`:384` 只给 `card.source==='manual'` 渲染解绑按钮）；服务端 `taskGitLinks.ts:246 unlinkCommit` 对 agent 来源回 **409 + 原因文案**，`server/src/routes/gitLinks.ts:112` 透传
- 二次确认：`GitCommitTab.tsx:147 askConfirm(..., { zIndex: 1200 })` —— 抽屉是 `z-index: 1100`（`TasksPage.tsx:4587`），默认 1000 的面板被压在抽屉下：「确定」不可命中，且面板外 mousedown 即取消，表现为「点了没反应」。`web/src/ui/dialogs.tsx:125/:149/:181` 新增可选 zIndex 修掉这一层序缺陷
- 事件流：`taskGitLinks.ts:124` 每次 link/unlink 写 `task_events kind='git_link'`（`op=link sha=… source=…` / `op=unlink`），供时间轴与审计回查
- 失败不静默：`:209 unlink-error` 显式回显服务端原因

## 验证（本单相关断言条目）
UI-25（Git 树弹窗浮在抽屉之上，确认后即时落库并**同时**刷新列表与卡片）、UI-26（解绑走二次确认后真实删除：前 2 条 → 1 条，接口 `gitLinkCount` 与 DOM 卡片数同步减少；确认面板在抽屉之上可命中——`hit===true` 显式断言，不只看接口）、UI-26b（同一抽屉里 agent 回写的卡片没有解绑按钮、手动的有）。
""" + EV_HEAD + EV_B1 + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。z-index 层序缺陷是真机实测打回后定位的产品级修复（影响所有高层浮层内使用 `askConfirm` 的既有功能）。

## 下一步建议
（仅观察不建单）`dialogs.tsx` 的 zIndex 参数已被本批两处复用（弹窗 + 确认），无需再派生治理单。"""

DOCS['T03435'] = """## 根因
M1.17 要「提示条统计本页未回写数量，附一键复制回写指令」。难点不在 UI 而在口径一致：条内文案的数字、复制指令的条目、以及行内「未回写」徽标三者必须同源，否则用户按提示补录后发现条数对不上；另外统计必须限本页已加载范围（跨页全量既取不全也会诱导错误批量操作）。

## 影响范围
`web/src/pages/TasksPage.tsx` 已完成 tab 顶部条体 + 两个动作；数据源是批次1 已内联的 `gitLinks`（不为提示条新增接口）。

## 修复
- `web/src/pages/TasksPage.tsx:639 unlinkedDone`：`status==='done'` ∧ `gitLinks.length===0`，只算当前页已加载项——行内徽标（`web/src/ui/gitBadge.tsx:144`）与条体共用同一份判定，不会出现「徽标说未回写、条里没它」
- `:4202-4214` 条体（`data-t03360="unlinked-bar"`，`role="status"` 让读屏也能播报）：文案「本页已加载 N 条已完成任务中，M 条未回写提交 ID」+「归档删除后无法补齐」
- `:649 copyWriteBackInstruction` 一键动作：产出 Agent 可直接执行文本（编号清单 + `taskId=<id>` + `mtask_link_git_commit` 调用样例），复制后 flash 明示条数
- `:4211 manual-link` → `:675-676` 把整页未回写任务压入 `gitLinkQueue`，打开 Git 树弹窗做批量手动关联（与 T03360 同入口，不重复实现）

## 验证（本单相关断言条目）
UI-12（待办 tab 条体 `null`；已完成 tab 条内数字 == 由接口逐条算出的本页未回写数 M）、UI-13（复制文本同时含 `mtask_link_git_commit`、任务编号 `T…`、`taskId=`，Agent 拿来即可执行）、UI-39（「手动关联」批量入口打开弹窗且可取数）。
""" + EV_HEAD + """
## 本次回写
""" + EV_COMMIT + """ 本单 verified:true。

## 下一步建议
（仅观察不建单）跨页累计与「一键跳到未回写筛选」PRD 未要求，本批刻意不做，避免与分页筛选打架。"""

# ---------------------------------------------------------------- 回传顺序（编号升序，T03392 不进本轮）
ORDER = ['T03343', 'T03358', 'T03359', 'T03360', 'T03362', 'T03363', 'T03364',
         'T03413', 'T03414', 'T03415', 'T03420', 'T03421', 'T03422', 'T03423', 'T03435']
# 诚实标注：主进程实机复验 / 三场景降级未证 → done 但不传 verified
NOT_VERIFIED = {'T03358', 'T03363', 'T03421'}

summary = []
ONLY = os.environ.get('WB_ONLY')
if os.environ.get('WB_DERIVED_ONLY'):
    OUT.write_text('DERIVED(only): ' + dv + '\n\n---- RAW ----\n' + '\n'.join(log_lines), encoding='utf-8')
    print('DERIVED=' + dv)
    raise SystemExit(0)
for no in ORDER:
    if ONLY and no not in ONLY.split(','):
        continue
    sess = '%s-%s-%s' % (PLATFORM, no, datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
    rpc('mtask_write_task_status', {'taskNo': no, 'state': 'running'})
    rpc('mtask_report_progress', {'platform': PLATFORM, 'session_id': sess, 'task_id': no,
                                  'phase': '八期批次2 M1 前端实现与真机实测'})
    r = rpc('mtask_update_task_result', {'taskNo': no, 'result': DOCS[no]})
    rpc('mtask_report_progress', {'platform': PLATFORM, 'session_id': sess, 'task_id': no, 'pct': 100, 'phase': '已回传'})
    rpc('mtask_report_progress', {'platform': PLATFORM, 'session_id': sess, 'task_id': no, 'done': True, 'phase': '完工'})
    args = {'taskNo': no, 'status': 'done', 'verified': True} if no not in NOT_VERIFIED else {'taskNo': no, 'status': 'done'}
    d = rpc('mtask_update_task', args)
    chk = rpc('mtask_get_task', {'taskNo': no})
    m = re.search(r'"status"\s*:\s*"([^"]+)"', chk)
    v = re.search(r'"verified"\s*:\s*(true|false)', chk)
    st = re.search(r'"ai_state"\s*:\s*"([^"]*)"', chk)
    sm = re.search(r'"session_state"\s*:\s*"([^"]*)"', chk)
    summary.append('%s status=%s verified=%s ai_state=%s len=%s err=%s' % (
        no, m.group(1) if m else '?', v.group(1) if v else '?', st.group(1) if st else '?',
        len(chk), 'ERR' if (r.startswith('ERR') or d.startswith('ERR')) else 'ok'))

OUT.write_text('DERIVED: ' + dv + '\n\n' + '\n'.join(summary) + '\n\n---- RAW ----\n' + '\n'.join(log_lines), encoding='utf-8')
print('DERIVED=' + dv)
print('\n'.join(summary))
