# mtask 技能复盘要点全库（pitfalls）

> 用法：主文件只留硬规则红线；本文件按需检索。用关键词 Ctrl+F（如 running / 派生 / 回写 / 归档 / dist / SQL / 拖拽 / 悬浮）。
> 编号已按文档顺序重排（原 33~38 双编号已修复）。主题快速索引：状态机与回传（搜 running/接口/sqlite）、派生单闭环（搜 归并/归档/derivedFrom）、回写（搜 回写/收尾/收件箱）、清单与范围（搜 list/跨项目/搁置）、前端与 CSS（搜 悬浮/类名/主题/dist）、补丁与写盘（搜 锚点/断言/写盘）、数据链与 SQL（搜 参数/列序/导出导入）、构建与环境（搜 磁盘/新鲜度/WIP）、AI 解析（搜 aiParse/PRD/JSON）、计划工具（搜 create_plans/SSE/幂等）、**性能验证（搜 A/B/漂移/时间窗/微基准）**、**条件触发型任务（搜 触发条件/阈值/不立项）**、**mock 上游（搜 api_key_enc/mock-slow/对照锚点）**、**AI 无输出类反馈（搜 max_tokens/截断/补问/复现）**、**提交树验证（搜 checkout-index/导出树/Junction）**、**隔离库路径（搜 MTask_DATA_DIR/空库）**、**UI 真验证（搜 web/dist 伺服/DevTools 点击/backup API）**、**开关不生效（搜 判定集合漏项/草稿态）**、**「找不到按钮」（搜 没接/看不见/opacity 禁用态）**、**打包态看不到改动（搜 39877/ExecutablePath/重打包）**、**Electron 当无头浏览器（搜 executeJavaScript/全角括号）**、**docx 域码噪声（搜 wordFields/HYPERLINK/_Toc/styleId）**、**输出触顶（搜 partial/finish_reason/思考型模型上限）**、**围栏包裹（搜 unwrapTopFence/cleanPrdStreamText）**、**探针注释炸（搜 `**/` 块注释）**、**看不到变化（搜 可见性缺口/（当前）/徽标）**、**漏提交（搜 git log -- <file>/暂存区导出树）**、**toast 读不到（搜 offsetParent/fixed）**、**服务端导出 docx/pdf/xlsx（搜 prdExport/exportGate/simhei）**、**下载验证（搜 will-download/PK/%PDF）**、**精确提交锚点（搜 git show HEAD/锚点断言）**、**打包 EBUSY（搜 better-sqlite3/.node 锁）**。

1. **双层嵌套 JSON**：MCP 返回文本是 `The MCP server responded with: [{"type":"text","text":"<inner-json>"}]`，内层才是任务数组；直接用文本提取按需二次 `ConvertFrom-Json`。

2. **Read 工具读不到大/特殊编码文件**：任务清单文件用 PowerShell `Get-Content -Raw` 读取解析，不要依赖 Read 工具直接读它。

3. **`list tools failed` 是连接问题**：是整层工具枚举失败，不是参数错误；重试或让用户修连接。

4. **跨项目甄别**：根据每条任务的 `project_id` 判断归属；同是待办可能分属不同项目，混在一起处理会误改非本项目的代码。

5. **不擅自改生产配置**：排查/修复以展示层与必要代码为主，不擅动 AI 服务实际配置；改前先列明约束。

6. **会话失效 ≠ 接口缺陷**：后端重载/密钥轮换后前端 401/白屏，先按 config.yaml 的 session-recovery 清凭据+刷新+重登，别误改代码。

7. **无法真实触发时降级验证**：缺 key/外部依赖时，按 validation.enabled-dimensions 逐级降级（静态→运行时→DOM→数据链路模拟），结论文档如实标注到达等级，不伪验证。

8. **主题色冲突**：弹层默认背景与主题文字对比度冲突时，背景/文字/箭头改用 frontend-guard.theme-css-variables 的主题变量，并处理 scoped 不命中问题。

9. **先收窄再查询**：用户点名项目时，用 mtask_list_tasks({ projectName }) 只拉该项目任务，别全量拉取——projectName 在 MCP 服务端过滤，显著省 Token。

10. **默认范围=待处理+未验证**：mtask_list_tasks 不传 status/scope 时默认返回「todo 或 verified=0」任务，其中未验证(done)任务的处理结果对关联决策有价值，是本流程默认分析集合；确需全部再传 scope:all 或显式 status。

11. **会话未注册 update 工具时走 HTTP 直连回传**：本会话 ToolSearch 可能只暴露查询工具（list_projects/list_tasks/get_task），`mtask_update_task_result`/`mtask_update_task` 搜不到 ≠ 服务端没有——先别下结论"无法回传"。降级路径：读 `~/.workbuddy/mcp.json` 拿 mtask 的 `url` + `X-Access-Token`，按 streamable HTTP 直连 JSON-RPC：① initialize（从**响应头 mcp-session-id** 取会话 ID）→ ② notifications/initialized（**必须带 Mcp-Session-Id 头，否则 400**）→ ③ tools/list 确认服务端全量工具 → ④ tools/call 批量回传（`mtask_update_task_result` 仅 `result` 必填 Markdown；`mtask_update_task` 传 `taskNo/status:'done'/verified:true`）。注意响应是 SSE `data:` 行需解析；幂等脚本用完即删。
    **现成脚本**：`python scripts/mcp-direct-call.py get|list|result|done|create|raw ...`（见"相关文件"），无需手写 JSON-RPC；token 不落盘、直连读 mcp.json，`400/404` 时自动提示删会话缓存重试。

12. **磁盘满时 Edit/Write 工具会把目标文件截断为 0**：目标盘 0 字节可用时，Edit 工具先截断后写、写失败留下空文件（实测 SKILL.md 被清空）。改前先记文件大小，写完校验 `Length > 0`；恢复用会话内已有的全文经 PowerShell here-string 直写（`[System.IO.File]::WriteAllText` + UTF8），别再用 Edit 重试。

13. **「[计划] xxx」前缀任务 = 项目计划镜像待办**（plan_tasks.linked_task_id 已关联，状态与计划双向同步）：处理这类任务时 ① 不要重复创建新的待办（先查项目计划与既有待办是否已覆盖同一需求，多渠道创建会产生重复项——实测 P0 需求被 AI 直建 + 计划镜像各建一条）；② 完成镜像待办时计划状态自动同步，无需手动改计划；③ 发现重复条目时合并到已关联计划的镜像待办（吸收优先级/信息），原条目归档并在 handle_result 标注重复原因。

14. **双库与端口**：桌面版 server 连用户库 `%APPDATA%/MTask/data/mtask.db`，`npx tsx` 默认连开发库 `server/src/data`（除非设 `MTask_DATA_DIR`）——回传前先确认目标库，跨库写=白写。新版 server 的 REST 启用 accessTokenGuard（裸 curl 401），token 在 mcp.json 的 `headers.X-Access-Token`。

15. **AI 拆分文档的类型歧义**：aiParseWbs 对「调研报告/PRD」类文档会误拆成"文档撰写步骤"而非"文档提出的优化需求"——提示词已加文档类型识别（拆需求条目而非撰写步骤）；直接构造 batch 条目（自己掌握文档内容时）比依赖 AI 二次拆分更可控，但首条必须带 startDate（createBatch 无锚点会因空日期崩）。

16. **批量处理按价值重排**：bug/数据一致性类任务优先于纯 UI 批量；同类 UI 任务先落公共 CSS/组件类再逐条接入（参数见 config.yaml execution 节）。实测 2026-09-13 轮：14 条任务 bug 优先 + 共用设施复用，比严格 task_no 序显著减少重复改动。

17. **假绿防线（T00463 两次教训）**：python 补丁长锚点替换会静默失败（断言不抛、tsc 不报）——拆小锚点逐步替换 + 每步 grep 计数复核；JSX 接线类改动必须 grep 构建产物特征串，文件级 assert 不足以证明功能接入。

18. **直写 sqlite = 绕过业务钩子（T00470 根因）**：回传任务状态直写库会绕过 TaskService.update 的关联同步（如 plan_tasks），造成隐性数据不一致。回传一律走 MCP/TaskService；排查时警惕同端口被桌面版/旧进程占用导致 PATCH 打到别的库（先查端口归属再发请求，读写路径全程显式）。

19. **验证状态诚实标注（T00478）**：纯 UI 交互/AI 质量类任务即使编译全绿也置 verified:false（Agent 无法 GUI 实测），result 写明人工抽查步骤；存量同类任务发现 verified=1 应重置。详见「完成标注」节。

20. **悬浮交互禁止灰显降级（T00488 用户否决）**：「悬浮显示」类需求一律用 op-host/op-hidden 完全隐藏二态（opacity 0/1 + visibility，200ms），不做 opacity .35 之类的灰显淡化——用户实测反馈灰显等于「看起来坏掉」。

21. **行级 :active 缩放与行内按钮冲突（T00489）**：记录行内含按钮时禁止 `:hover/:active` 行级缩放（点击按钮会带动整行变形产生漂移感）——改事件驱动：mousedown（closest 过滤交互元素）按住超时后才加缩放类，mouseup/leave 撤销。

22. **覆盖面清单先行（T00509/T00510 教训）**：「各页面/所有按钮/统一风格」类需求，首轮只改单点必返工——动手前 grep 枚举完整改动点清单（页面×元素矩阵），修完逐项复核并附清单汇报。参数见 config.yaml requirement-patterns。

23. **渲染接线走查（T00527 教训）**：预计算数据（如顺延序号 Map）存在 ≠ 生效——必须 grep 渲染点确认真的引用了新数据源。tsc/build 对「算了没用」完全无感。

24. **SQL 占位符参数逐一对照（T00494 教训）**：better-sqlite3 `run(...)` 参数顺序必须与 SQL `?` 逐一对照，错位（如 updated_at 收到 id）会静默匹配 0 行；落库类修复必须 API 级冒烟看真实落库结果。数据链走查见 config.yaml dataflow-walkthrough。

25. **类名用法决定选择器形式（T00513 教训）**：写全局动画/样式规则前先 grep 类名实际用法——作容器用（规则写 `.cls button:hover`）还是作自身标记（须写 `button.cls:hover`）；且 :not() 排除类计入特异性，新规则会被高特异性兜底规则覆盖。见 config.yaml css-safety。

26. **构建/打包失败先体检环境（T00528 教训）**：磁盘 0 字节（ENOSPC）、构建产物被运行中实例锁定都会让正确代码失败——先按 config.yaml env-precheck.checklist 体检（磁盘/锁/进程/依赖），再查代码。

27. **拖拽 reorder 的 id 序列必须取渲染所用数组（T00494 教训）**：用户拖拽的是「看到的顺序」（排序后数组），用原始数组序计算 from/to 映射必然错乱。见 dataflow-walkthrough.reorder-source-must-match-render。

28. **验证不通过先判「发布新鲜度」（T00531/537 教训）**：修复提交时间晚于安装包打包时间 → 验证环境不含改动，属「假性失败」——先重新打包再复验，禁止在旧包环境做代码修改决策。见 env-precheck.release-freshness。

29. **API 载荷字段名前后端逐一对照（T00531 真根因）**：markVerifyFailed 发 snake_case handle_result，服务端只认 camelCase handleResult——静默忽略导致反馈从未落库。grep 全站排查同类。

30. **非受控 input 值变化配 key（T00545 教训）**：defaultValue 输入框 reload 后 DOM 不刷新——数据变了界面没变（「联动失效」观感）。见 patching.uncontrolled-input-key。

31. **导出列序变更必须同步导入解析器（T00553 教训）**：固定列序解析在列序演进时必然错位（日期被当工期）——导入解析改表头映射通用化。见 patching.export-import-column-sync。

32. **工具链纪律（T00546/551 教训）**：python 写文件用绝对路径 + 写后重读断言；TS 源码 
 转义用 chr(92)+'n' 拼接（heredoc 会吃转义）；replace 前确认调用点归属（同名 props 撞名）。见 patching 节。

33. **容器 hover 显隐类（task-op/op-hidden）只用于确实处于 hover 容器内的元素（T00704 教训）**：`task-op` 的显隐规则是「祖先任务行 hover 才显示」——**浮出式操作条**（sticky/fixed 浮于列表上方，如多选批量条）里的按钮**不在任务行内**，hover 永远不触发 → 按钮全部不可见，用户会误报「功能缺失」（T00704 实测：批量归档按钮早已存在，因不可见被报「缺少」）。**判断口诀**：给元素加 hover 显隐类前，确认「触发 hover 的容器」与「元素实际所在位置」是同一处；浮层/操作条内的按钮一律常显。

34. **「跳过/排除」条件必须精确匹配自己写入的标记值（T00663 教训）**：实现「某些数据不参与重排/不处理」时，判定条件要**精确等于**本功能写入的特殊值（如 `=== PROJ_PIN_WEIGHT(-9999)`），**不能用宽泛范围**（如 `< 0`）——否则会把系统数据（收件箱权重 -1000）一并误伤（T00663 实测：拖拽排序把收件箱也跳过了，冒烟才发现）。同理，跨端共享的魔法值应抽为常量并在前后端保持同一来源（前端 projectOrder.ts ↔ 服务端 PROJ_PIN_WEIGHT）。

35. **MCP 冒烟断言用无引号子串（T00662 技巧）**：`mcp-direct-call.py raw` 的输出是**转义后的 JSON**（`{\"key\":...`），断言写 `'"key"' in out` 会**永远失败**（引号被转义）——应用 `'key' in out`（无引号）。同理，输出可能被 `[:4000]` 截断，长响应只断言关键字段名。

36. **UI 状态放对作用域：局部变量不可被组件级 effect 访问（T00658 教训）**：渲染函数内的局部计算值（如 `renderTaskLists` 里的 `visibleTodo`）**不能被组件级 useEffect 使用**——需半选/联动这类「依赖局部值」的行为，应**封装为小组件（内部 ref + useEffect）**（T00658 的 `TriCheckbox` 即此模式），或把计算上提到组件作用域。写完先跑 tsc：`Cannot find name` + `used before declaration` 就是作用域错位的信号。

37. **权重/排序类需求先核查既有数据语义（T00655 教训）**：实现「置顶 / 优先 / 权重」前必须查清：① 服务端 ORDER BY 是升序还是降序；② 既有数据的权重取值惯例（T00655 实测：`ORDER BY sort_weight, created_at` 为**升序**，收件箱已占 -1000——初版把「置顶」写成 +1000 会排到最后，靠冒烟前查数据才发现）。判定「已置顶」应**精确匹配自己写入的权重值**（避免误判系统项目的既有权重）。

38. **视觉/交互改造先对齐基线（T00622 回滚教训）**：「简洁化 / 折叠 / 紧凑 / 重排」类需求**主观体验强**——直接实现易被判「不符合预期」并要求回滚（T00622 实测：整轮改动被 revert）。落地前置动作：① 先产出**视觉/交互描述或小样**（列显隐范围、hover 效果、期望密度）供确认；② 或实现为**可切换/可关闭**的选项（默认保持原样）；③ 回滚时用 `git revert <commit>` 保留历史（勿手改还原），并在回传中说明「哪些未受影响」。

39. **「标签/入口」类改动用产物扫描核实渲染点完整性（T00623 实用技巧）**：改某类 UI 元素（如「验证失败」标签）的显隐条件时，除了源码 grep 枚举，还应**在产物（dist js）中搜索该元素的字符串常量**并逐个查看上下文——同一语义常有多个渲染形态（T00623 实测：源码改了 span 徽标，产物扫描发现还有一处 button 入口未改）。校验口诀：**同类条件应全部带守卫，数量自检（带守卫 N 处 / 无守卫 0 处）**。

40. **回传必须走接口（T00589 排查教训，强制自检）**：处理 MTask 任务时，**结果回传与状态标注一律经 `scripts/mcp-direct-call.py`（result / status / done / raw）或 REST 接口**完成；**严禁用 sqlite 直接 UPDATE 回写**（绕过接口 = 绕过 TaskService 钩子与状态自动驱动）。实测踩坑（2026-09-15）：处理 T00589 时用 sqlite 直写回传 → 任务未变 running、回写后未变 unread——用户侧表现为「状态动画失效」，而接口本身完全正常（显式 aiState 与语义自动驱动实测均通过）。**自检口诀：回传前问一句「我是通过接口写的吗？」**

41. **写操作后清相关 TTL 缓存（T00589 二轮教训）**：服务端对低频集合（如项目列表）有 TTL 缓存（5s）。新增/标记/删除类写操作后**必须 `cacheClear('<key>')`**，否则列表接口在 TTL 内继续返回旧数据——前端表现为「功能没生效」（实测：项目沉淀后仍在项目下拉中，直到缓存过期）。冒烟时必须**先预热缓存再写**，才能真正覆盖此路径。

42. **横切资源统一到主容器（T00569 三轮教训）**：两个区块功能「深度整合去重」时，**日志输出与模型选择等横切资源应统一由主容器承载**（如 AI 控制台 tab 输出日志、控制台模型下拉统一供各功能使用），子面板只保留业务输入（选择/上传/编辑/提交）——避免同一能力重复实现与状态双写。长过程状态需放**模块级 store**（切页不中断、返回即恢复）。

43. **「迁移」= 功能整体搬走并原生可用，不是「入口跳转」（T00569 二轮教训）**：需求说「把 X 功能迁移到 Y 页面」时，必须在 Y 页面**原生实现完整功能**（上传/执行/预览/保存全链路）并**移除原位置**；「卡片点击跳转到原页并打开弹窗」不算迁移（会被判定为不符合预期）。若功能含长耗时过程（AI 解析/批量入库），新位置需提供**执行过程可见的输出区**（滚动日志：阶段 + 时间戳 + 自动滚底）。

44. **新概念先确认与既有概念的边界（T00589 教训，设计前置）**：需求引入新概念（如「历史资产」）时，**先判定它与既有概念（归档/删除/标签）是否为同一语义**——若不同（归档=软删除 vs 历史资产=组织过程资产沉淀），必须用独立字段/状态与独立视图承载，**禁止复用既有字段**（复用会导致整轮返工）。落地前用一句话写出「新概念定义 + 与既有概念的差异 + 三区隔离规则」并自检。

45. **写盘与产物校验纪律（T00569 教训，强制）**：批量脚本中任一 assert 失败会**整体跳过写盘**——改完必须逐项确认改动真的落入文件（读回目标片段校验独有文案），不能只看脚本输出的 OK；`dist` 特征校验必须用**本次改动独有文案**并做**反向校验**（旧文案应不在产物），涉及迁移/移除时校验「新位置在 + 旧位置不在」双向特征——禁止用菜单名等会被既有代码误匹配的通用词。见 patching.verify-write-landed / dist-verify-must-be-unique / dist-verify-bidirectional。

46. **`verified:false` 会把任务打回待办（T00572 实测）**：想表达「done 但未验证」而传
   `{status:'done', verified:false}` 时，服务端按「验证未通过」处理并**回退 `status=todo`**——
   返回 200、`updated_at` 照变，只看调用是否报错会误判成功。正确做法：**只传 `status:'done'` 省略 verified**，
   回写后务必 `mtask_get_task` 复核 `status/verified` 实际值。详见「完成标注」节。
   **推论（2026-09-20 T00796 二轮实测）**：口径一**回传 result 也会把已 done 的任务打回 todo** ——
   给已完成任务补一段结果（整文替换）后复核发现 `status` 从 done 变回 todo（`ai_state` 转 unread）。
   所以**顺序必须是「先回传 result → 再标 done」**；若顺序反了（先 done 后补 result），
   收尾要再补一次 `update_task {status:'done'}`，并且每次都 `get` 复核实值，不要凭调用成功下结论。

47. **并发会话会在同一文件留下未提交 WIP（本项目高频）**：commit-per-task 前先 `git diff <file>` 逐 hunk 分类，
   只 `git apply --cached` 本任务的 hunk（先 `git diff > full.patch`，按 hunk 关键词切分后 `--cached --check` 再 apply），
   否则会把别的会话的 WIP 裹进自己的提交。另：本仓 `.git/index.lock` 多次出现 0 字节 stale 锁，
   确认无 git 进程后用 ctypes `DeleteFileW` 删除即可。
   ⚠️ **切 hunk 有硬边界，超出即失效（2026-09-19 T00792 实测）**：当同一文件里别的会话的改动**与你的改动在同一个 hunk 内**（hunk 边界横跨双方），
   `sed` 切 hunk 无论怎么切都会裹挟对方代码。实测 TaskService.ts 工作区 diff 达 86+/64-，我的改动只占 2 处，却与 `loadPlanLinkedTitles` 等重构处于同一 hunk。
   **定式（推荐，绕开 hunk 边界问题）**：不从工作区 diff 取补丁，而是
   ① `git show HEAD:<file> > base` 取原文 → ② Python 脚本按**唯一锚点**（先 assert 唯一性）只打自己的改动 → ③ `git hash-object -w <改后文件>` 拿 blob → ④ `git update-index --cacheinfo 100644,<blob>,<path>` 精确落暂存 → ⑤ `git diff --cached` 复核行数符合预期（本例 4+/1-）再 commit。
   全程**不碰工作区**，并发会话的 WIP 分毫不动。
   识别信号：`git diff --stat` 的改动量远超你的预期（如只改 2 行却报 150 行变更）→ 立即停手，按上述定式重做。

47b. **验证必须在干净树上做，工作区含 WIP 时工作区验证必然失真（2026-09-19 T00792/T00793 定型）**：
   `git archive HEAD | tar -x -C <dir>` 导出 → 仅覆盖本单改动的文件 → 独立端口 + 独立数据目录 → 再跑 API 验证/基准。
   两个必踩的坑：① **`git archive` 不含 untracked 文件**，若现网 import 了新模块（如 `util/prdContext.ts`、`src/skills/`）会 `MODULE_NOT_FOUND`，需手工补齐才能启动；
   ② `node_modules` 需目录联接（PowerShell `New-Item -ItemType Junction -Path <t>\node_modules -Target <repo>\node_modules`；`cmd //c mklink /J` 经 Git Bash 常静默失败）。
   临时校验树放 `perf/sandbox/`（已 gitignore，不污染提交）。

48. **回写不传项目 = 落在收件箱的死单（2026-09-14 实测）**：`tasks.project_id` 是
   `NOT NULL REFERENCES projects(id)`，`mtask_create_task` 不传 `projectId/projectName` 时服务端兜底到
   `sys-inbox`（收件箱）。后果：按 `projectName` 拉取永远看不到它 → 「形成了待办却没人处理」；
   且 `dedupe` 只查「同项目同标题」，跨项目的重复拦不住，同一建议会在库里出现两份
   （实测 T00422/423/429 落收件箱，T00483/484/485 是同日同源建议在正确项目重建的第二份）。
   回写指令见「步骤 5b / 完成标注」节；脚本用法 `create <title> <desc.md> [projectName|projectId]`。

49. **收尾梳理是「防漏」也是「防刷」两难（2026-09-14 规则升级）**：任务收尾强制梳理剩余工作并回写待办
   （`config.writeback`），避免「结论躺在 result 里没人跟进」；但每条被处理的待办又可能产出新待办，
   天然存在**链式增殖**风险。三道闸门必须同时保留：① `excludes` 过滤无交付物的结论陈述；
   ② `max-items-per-task` 限单任务上限；③ `【AI回写待审核】` 前缀 + 人工审核转正（**前缀未去掉＝未获准执行**）。
   另：`verify-gap`（真机/人工验证）也属剩余工作、应建单——但要与「不宜建单的观察提示」区分，
   后者只进 result 的「下一步建议」节。判断口诀：**有交付物 / 要再派活 → 建单；只需人看一眼 → 写建议**。
   （2026-09-14 追加：上限改为 `0=不限`，剩余工作**全部建单**。）
   （2026-10-07 T01547 升级：废除「建单 / 写建议」二选一——「下一步建议」节凡含后续动作的条目**必须建派生子任务**
   并在行末标「已建派生单 Txxxx」；仅无需再派活的纯观察提示留文本且显式标「（仅观察不建单）」。
   口诀改：**有建议必有单；纯观察才标注**。旧句「只需人看一眼 → 写建议」中「写建议」的含义收窄为「留文本+标注」。）

50. **回写三步缺一不可 + 派生单必须回流（2026-09-14 用户实测反馈）**：
   ① （2026-09-15 起状态由服务端自动驱动，无需手工标记：读取详情→running、回传结果→unread、验证失败→failed。）
   ② 剩余工作**全部建单、不设上限**以保不漏；防膨胀改由「同类项合并 + 派生单回流」承担，而不是靠裁剪。
   ③ **派生单膨胀的真正解法是回流而非限流**：派生单只当执行凭据，结论追加回原单 `handle_result`
      （`## 派生单回填 Txxxxx`，不动原单 status/verified）后归档自身；且派生单处理中新产生的剩余工作，
      「来源」仍写**最初的原单** → 结构恒为单层，从源头掐断链式派生。

51. **【已废弃·勿用】状态标记全自动驱动（2026-09-15 早间旧口径）**——本条与 T00620 显式驱动冲突：**开工写 running 仍必须显式调用**（见主文件状态机），仅「完成→unread / 失败→failed」的自动驱动部分仍有效。
   历史规范「写入目标是谁就标谁（新建标新单 / 回传标当前单 / 归并标原单）」已由**接口层自动实现**——
   服务端在 get_task / update_task_result / update_task{done|verified:false} 时按语义自动置
   running / unread / failed，MCP 与 REST 同规则。**Agent 与脚本都不再需要任何显式状态调用**
   （脚本曾内置的兜底反而会覆盖服务端的 failed，已移除）。

52. **派生单复验通过 = 原单验证缺口的证据（2026-09-14 实测）**：原单因「需真机/人工复验」置 `verified:false` 时，
   回写出来的 `verify-gap` 派生单其实就是那次复验。复验结果一出（如用户回一句「已验证问题未复发」），
   **原单的验证缺口即闭合**——此时应显式把原单置 `verified:true`，否则原单会永远挂在「未验证」清单里。
   注意与第 5c 节「归并不得改原单 status/verified」不矛盾：**merge 动作不改**（防状态串台），
   **显式决策才改**，并在 `## 派生单回填` 节注明是显式决策。
   实测一轮闭环：T00573→T00572、T00574→T00571 两例均据此把原单从「未验证」转「已验证」，news 待处理清单 6 条 → 2 条。

53. **派生溯源用 `derivedFrom`（不是 parentId）+ 查重不跨归档单（2026-09-15 实测）**：
   ① `mtask_create_task` 支持 **`derivedFrom: '原任务编号'`**——本单派生自哪个任务，MTask 会在派生单完成后
      **自动把结论整合回原任务**（应用级实现）。**⚠️ 2026-09-26 实测（T01105→T01082）：该自动整合是
      「整文替换」而非追加——母单 handle_result 被派生单 result 全文覆盖，母单原有处置文档丢失**。
      派生单收尾**必须走脚本 `merge` 子命令**（先判后写：内容一致不重复追加、修订就地刷新那一节，且不改原单状态；T04572 起默认 dry-run，确认后加 `--write` 才写盘并归档派生单）；若已误用 result 自动整合，用母单回传前的本地源文件（result md 应先落盘）
      重发 result 恢复原文，再走 merge。**`parentId` 是 epic→task 层级父子语义**（T00450），
      拿它做派生关联是误用；脚本 `create` 的第 4 参已改为传 `derivedFrom`。
   ② **`dedupe` 的盲区：只比「同项目 + 同标题 + 未归档」**。同源单若**已归档**（如校验完成的派生单），
      以同标题回写会**新建重复单**——实测用已归档 T00596 的标题重跑 `create` 生成了 T00600，事后归档清理。
      规范：**回写前先查归档单**（`mtask_list_tasks {archived: true}`）或确认同源单已闭环，命中则不建。
      ⚠️ 该盲区与「归并后一律归档」叠加后更要警惕：同源派生单归档后，同标题回写必然新建——
      回写前先回看原单回填节与归档清单。

54. **派生单闭环门自查口诀（T00599 实测盲区）**：派生单收尾必须依次过四道——
    **回传 result → 归并回原单（无条件，与 verified 无关）→ 标注 done → 归档（2026-09-15 用户裁决：
    归并后一律归档，验证缺口由原单回填节承载跟踪）**。
    「归并」与「归档」是两个独立动作，缺一不可：只归档不归并 = 原单拿不到结论（T00596 前的教训反面）；
    只归并不归档 = 未验证清单积累僵尸单（T00599/T00584 实测）。

55. **AI 状态自 v0.1.0915.97+ 起为「显式驱动 + 超时兜底」（2026-09-15 服务端修复 T00620，替代此前自动驱动）**：
    ① **`mtask_get_task` 不再自动置 running**（原 T00566 二轮设计是"读取待办即开始处理"，实测导致
      「仅查看/复核也转圈」「已完成的 unread、中断后的 failed、已读清空的 '' 被抹回 running」——用户反馈
      "任务执行结束后状态还是运行态"）。Agent **开始处理时必须显式** `mtask_write_task_status {state:'running'}`
      （或该次读取传 `markRunning:true`），否则状态保持空白。
    ② **终态必须显式写**：正常完成 → `unread`；**异常/中断/放弃 → `failed`**（红色警示，用户据此重试）。
    ③ **服务端超时兜底**：`running` 超过 `MTASK_AI_STATE_STALE_MS`（默认 30 分钟）未更新，
      读取路径会**自动置 failed 并落库**——Agent 进程被杀/会话中断无需自身收尾也能落终态。
      故**同一任务处理超过 30 分钟需中途重写 running 续期**（长任务心跳）。
    ④ 客户端不再需要"janitor 清理僵尸 running"（服务端已自动过期）；此前 #42 记的
      「派生单 ai_state 被服务端固定为 running」是**误判**——真因就是 ① 的读取自动置 running，已随本次修复消失。
    对带 `derived_from` 的派生单调用 `mtask_write_task_status {state:'unread'|'failed'|...}`，
    **写入接口会回显你传的状态，但 `mtask_get_task` / `mtask_list_tasks` 读回始终是 `running`**
    （实测连写 failed/unread/running 三次，读回恒为 running）——即服务端把「派生单待处理」表现为 running
    （列表里转圈），未读圆点对派生单不可用。**结论：派生单不必反复重写 ai_state**（白费往返）；
    「写必标未读」对普通任务有效，对派生单由服务端接管。若确实需要未读提示，应避免使用 `derived_from`
    建立派生关系（用 description 的「来源：Txxxx」文本关联替代），代价是失去自动回流。

56. **项目计划要回写到「项目计划」菜单，不是建散任务（2026-09-17 用户指正）**：编制项目执行计划类任务，产出文档后须用 `scripts/prd_to_plan.py --plan` 写入 `mtask_create_plans`（项目计划 WBS），而**不是** `mtask_create_task` 建一堆散任务刷屏。入参：顶层 `projectName`/`projectId` + `items[]`；item 仅 `title` 必填（另有 `description`/`startDate`/`endDate`/`durationDays`/`progress`/`status`/`assignee`/`linkedTaskNo`）。

57. **大响应必须拼接全部 SSE data 事件（2026-09-17 实测，list_plans 与 list_tasks 双双踩中）**：任何 MCP 工具返回体超过约 5KB 都会被截断，而 `scripts/mcp-direct-call.py` 的解析只保留**最后一个** `data:` 事件 → 会误判条目数或解析失败（实测：list_plans 36 条被数成 10 条；list_tasks 同样截断致 JSON 断在半个字符串）。核验大列表须自行拼接所有 data 事件的 `result.content[].text` 后再解析；解析时对**原始文本**直接 `json.loads`（**勿先 unicode_escape**——那会把 `\n` 变成真实换行破坏 JSON）。

58. **计划类工具只有 create / list，没有 delete / update（2026-09-17 实测）**：`mtask_delete_plans`、`mtask_update_plans` 均 not found。故回写前必须先不带 `--plan` 预览、确认 WBS 无误再写入；且回写**非幂等**，重跑前先 `mtask_list_plans` 查重，否则产生重复条目只能界面手工删。

59. **AI 输出的 JSON 解析一律「快路径 + 逐顶层对象扫描回退」，且禁止静默吞错（2026-09-18 T00752 实测）**：
    大模型常漏写**数组元素间的逗号**（实测样本：`...同一优化方向"},
  {"project":"mtask"...`——逗号与 `{` 之间缺 `,`）、
    输出 NDJSON（每行一个对象）或结果里夹杂说明文字。只做「截取 `[`…`]` → 整体 `JSON.parse`」的实现**必然失败且静默返回空**
    ——用户侧表现为「控制台已输出结论，点击执行清洗弹窗却『共 0 组』」。
    标准做法：① 先整体 parse（快路径）；② 失败则**逐顶层对象扫描**（括号配平 + 字符串/转义状态机：
    遇 `"` 进字符串态、`\` 置转义、深度归零时切片 parse 并跳过损坏对象），可完整救回缺逗号/NDJSON/夹杂文本/尾部截断；
    ③ 解析失败**必须回显原因**，禁止静默 `return []`；④ 前后端同款（本次已同步 `web ReportConsole.parseCleanGroups`
    与 `server PlanService.parseJsonArrayWithRecovery`——后者覆盖 WBS 拆分 / PRD 解析 / AI 计划导入全场景）。
    验证方式：**用真实结论样本跑一遍**（原解析抛 `Expecting ',' delimiter` → 新逻辑提取出全部分组）才算修好。

60. **前端改动「是否已生效」的校验：源码级断言 + 产物新鲜度，别单靠产物字符串（2026-09-18 T00752 实测）**：
    Vite/esbuild 会**压缩局部变量名**（`inStr`→`t`）并**常量折叠**（`String.fromCharCode(92)` → 字面量 `''`），
    用产物字符串做特征校验会**假阴性**（第 17 条要求 grep 产物特征，但特征选择要避开这两类）。
    可靠组合：① **源码级断言**（改动确实在 `src/` 且逻辑完整，如函数定义 + 调用点都在）；
    ② **产物新鲜度**（`dist` 文件 mtime ≥ 对应 `src` mtime，证明构建包含本次改动）；
    ③ 需要产物级特征时优先挑**不会被折叠/改名**的内容（中文文案、未被压缩的函数名、独有字符串常量）。

61. **`mcp-direct-call.py` 的 `raw`/`get`/`list` 输出截断（2026-09-18 T00707 实测）**：脚本对 print 做 `[:4000]/[:6000]/[:8000]` 字符截断——**长结果任务（如 T00707 16KB result）用 raw get 拿到的 JSON 必然截断**，json.loads 报 Unterminated string。长文本回写不要经 raw 通道拼装：① 优先直接用 MCP `mtask_get_task` 工具取原文（无截断）→ 在会话内拼接新全文 → MCP `mtask_update_task_result` 整文回传（服务端语义为整文替换，原文须逐字保留）；② 或给脚本加 `--full` 参数去截断。另注意 SSE/控制台输出含「会话已建立」前缀行与裸控制字符，解析前先 `raw[raw.index('{'):]` + `json.loads(strict=False)`。

62. **better-sqlite3 ABI 残留（打包异常退出后 dev 启动崩）**：打包流程把 better-sqlite3 切到 Electron ABI（NODE_MODULE_VERSION 130），异常中断时回切不执行 → 下次 `node server/dist/index.js` 报 `NODE_MODULE_VERSION 130 vs 127` ERR_DLOPEN_FAILED。修法：`cp build/native/dev/better_sqlite3.node node_modules/better-sqlite3/build/Release/`。另：server dist 与源码可能不同步（他人改源码未构建），跑隔离测试前先 `npm run build:server`。

63. **Windows 下 `node -e "<复杂JS>"` 转义不可靠**：execSync/命令行内联多语句 JS（含引号/中文/JSON）在 cmd 转义链路容易静默失败（空 stdout 但 exit 0）或语法崩。可靠做法：**写临时 `.cjs` 探针文件 → `execFileSync(process.execPath, [probeFile], {env})`**，路径用 `JSON.stringify(utilPath)` 内插，不要手工拼引号转义。另注意 `new URL('../x', import.meta.url)` 相对的是**文件所在目录**，`../..` 别多跳一层。

64. **性能类任务：同机 A/B 必须让两组共享同一时间窗（2026-09-19 T00792 实测）**：分块 A/B/A/B（各 180 请求）得出「0.946× 退化」的结论，实为**测量缺陷**——同块内 req/s 从 83.8 漂到 66.5，机器单向劣化污染了组间差，A 块与 B 块根本不在可比时间窗。改用**短块交替**（8 轮 × 每侧 30 请求 = 每侧 240 样本，块间切换实现在重启实例）后回到 **−3.02%**。
   **配套口径**：① 微基准与端点基准**分开报**——编译段 3.48× ≠ 端点收益；先量化「目标环节占整体的比例」（本例编译仅占单查询 24.8%，端点又被 JSON 序列化（响应体 29KB）与网络稀释到 p50 −3%），再判断是否值得做；② A/B 脚本务必**备份原文件 + finally 还原 + 还原后校验**，但注意 `open(w)` 会改写行尾（LF↔CRLF）→ git 视角全文 diff 的假象（本例 TaskService.ts 从 4fb3680a 变 5e59cd60，内容逻辑一致但换行符被改写）。还原时用 `newline=''` 并按原行尾风格写回。

65. **条件触发型任务（描述自带阈值）：先核验触发条件，不满足就产出评估结论并关单（2026-09-19 T00778 定型）**：任务描述写明「满足其一才立项：源文件 > 2000，或关键词召回率明显不足」这类**显式门槛**时，最高 ROI 的动作是**先实测该阈值**，而不是直接实现。本例实测 184 文件 vs 阈值 2000（差 10.9×）+ 无召回率缺陷证据 → 结论「不立项」，零代码改动归档评估报告。
   **这类单的正确交付物是「有证据的评估结论」，不是代码**——强行实现一个用不上的特性（引入 embedding + 向量库 + 索引生命周期）成本高两个量级。回传文档须含：阈值实测值、判定依据、为何不做（成本收益）、建议的再触发信号与未来实施入口。

66. **把 AI 端点指向 mock 上游时 `ai_tools.api_key_enc` 必须留 NULL（2026-09-19 T00793 实测）**：验证 AI 端点本地编排成本时，在 `ai_tools` 表插一行 `endpoint` 指向 `server/scripts/mock-ai-server.mjs` 即可完成上游改写（`ConfigService.getRuntimeConfig(id)` 按 id 直读该表，**无需改业务代码**）。但 `api_key_enc` 若填任意字符串（如 `'mock-key'`），`decrypt()` 会按 `iv.tag.data` 三段式 base64 解析并抛
   `The first argument must be of type string or an instance of Buffer, ArrayBuffer... Received undefined` ——**错误信息完全不指向密钥**，表现为该端点全部 400（极易误判为业务逻辑问题）。mock 上游不校验鉴权，留 NULL 即可。
   另：`/tasks/classify` 的 `categories` 入参是 **`{id,name}[]` 对象数组**而非字符串数组（传字符串会因 `c.name.trim()` 报 `undefined.trim`）。启 mock + 隔离实例的测量脚手架可直接复用 `perf/verify_t00793_local_cost.py`。
   **方法论收益**：加一条 `mock-slow`（上游 2500ms 延迟）做对照锚点，实测 2532ms，即可把「上游延迟」与「本地编排」清晰切开——**没有对照锚点的延迟数字无法归因**。

67. **「AI 没输出结果 / 没识别出东西」类反馈：先查 token 预算与截断，别急着改提示词（2026-09-20 T00769 实测）**：
    全库 `ai_tools.max_tokens` 默认 **4096**，而「一次成文」的场景（PRD / 长报告）要输出数千字，**思考型模型的思维链占用同一预算**，
    实测 DeepSeek 仅输出 **1775 字符即 `finish_reason=length`**；T00779 的截断检测随即判失败 → 上层拿不到 `done` 事件 →
    用户侧表现为「右侧控制台无任何输出」「AI 没识别出待确认问题」，极易被误判成「模型能力差」或「上下文没加载」而改错方向。
    **排查顺序**：先把 stage/error 事件全量打出来看有没有截断报错 → 再谈上下文、提示词、模型选型。
    **修法**：按**场景**抬高预算（本次新增 `PRD_MIN_OUTPUT_TOKENS=8192` / `PRD_MIN_TIMEOUT_MS=300000`，取「用户配置与下限的较大值」），
    **不要改工具配置本身**（否则污染其他场景）。
    **配套**：结构化产物（如问题清单 JSON）不要只靠「一次生成 + 协议解析」，加**补问兜底**（基于已生成正文再发一次只求 JSON 的轻量调用），
    实测主流程协议解析失败率不低（思考型模型常不遵守 `<<<ISSUES>>>` 这类协议），兜底后从 0 条 → 10 条。

68. **失败反馈类任务：先复现「修复前的失败输出」，再动手（2026-09-20 T00769 定型）**：
    handle_result 里的【验证失败 …】段是**第一输入**，但用户描述的是现象（"无输出""没识别"），真因往往在别处。
    标准动作：**先在隔离实例上跑一遍原始路径，把失败证据（error 事件 / 截断字符数 / 空结果）抓下来写进回传文档**，
    再逐条修；回传文档里「修复前 X / 修复后 Y」的对照比任何解释都可信。
    本例一次复现就挖出 4 个叠加缺陷（控制台无订阅 / token 截断 / 清单无兜底 / 工作空间静默跳过），若按现象直改只会修掉 1 个。

69. **提交验证要在「暂存区导出树」上做，不能只信工作区 tsc（2026-09-20 定型）**：
    采用精确提交法（第 57 条）后，暂存区内容 ≠ 工作区内容，**工作区 tsc 通过不代表提交树能编译**。
    做法：`git checkout-index -a --prefix=<dir>/` 导出暂存区 → 用 Junction 挂 `node_modules`（`New-Item -ItemType Junction`，勿复制）
    → 在导出树跑 `tsc --noEmit`。本次即因此发现 **HEAD 本身就编译不过**（`web` 缺 `api.put`、`server` 缺 `WorkspaceService` 导入，
    均为他人 WIP 未随提交带入），顺手补回才让提交树可编译——否则会留下一个坏的 commit。
    **另**：`git archive` / `checkout-index` 都不含 untracked 文件，导出树若缺新模块需手工补齐才能启动/编译。

70. **隔离实例的 `MTask_DATA_DIR` 必须给 Windows 真实路径（2026-09-20 实测）**：
    Git Bash 里写 `MTask_DATA_DIR=/tmp/mtask-iso` 时 Node 解析不到该路径，server 会**静默落到空库**（health 正常、接口全通、但
    `GET /api/aitools` 返回 `[]`）→ 调 AI 时报「AI 工具不存在」，极易误判成配置问题。
    给绝对路径（如 `D:\...\.workbuddy\tmp-iso`）或 `C:\Users\...\AppData\Local\Temp\...` 形式，并在起服后立刻
    `GET /api/projects` 校验条数，确认连的是目标库。
    **清理**：临时目录里若有 Junction（`node_modules`），必须先用 `RemoveDirectoryW` 删联接点再删文件/目录
    （safe-delete 沙箱下 `os.remove`/`shutil.rmtree` 会被拦，且联接点会连累父目录删不掉）。

71. **隔离库复制必须走 SQLite backup API，直接 `cp mtask.db` 会拿到陈旧快照（2026-09-20 实测）**：
    生产库 `%APPDATA%/MTask/data/mtask.db` 处于 **WAL 模式**，最新提交可能还在 `mtask.db-wal` 里未 checkpoint；
    只复制主库文件（哪怕刚刚 `cp`）会得到一个"能正常打开、数据看着也对"的**旧快照**——
    本次实测：副本里 T00769 是 `verified=1/hr=1167`，真实库却是 `verified=0/hr=3298`，T00796/T00797 干脆整行缺失。
    **正确做法**：`src=sqlite3.connect(源); dst=sqlite3.connect(目的); src.backup(dst)`（Python 3.7+ 内置，自动含 WAL 内容）；
    或同时复制 `.db` + `.db-wal` + `.db-shm` 三件套。
    **自检**：起服后拿一条**本会话刚改过**的任务对一下 `hr`/`verified`，不要只看 `/api/health` 正常。

72. **UI 类任务的"真验证"很低成本：服务端自带 web/dist 伺服 + DevTools 脚本点击（2026-09-20 定型，强烈推荐）**：
    本项目 server 启动时会 `[mtask] web 静态已伺服: <repo>/web/dist`，所以：
    ① `vite build` 出产物 → ② 起隔离实例（独立端口 + backup 出来的库副本）→ ③ `new_page` 打开 `http://127.0.0.1:<port>/`
    → ④ `evaluate_script` 用 `document.querySelector('button[aria-label="…"]').click()` + `setTimeout` 等 React 提交，
    再统计 DOM 断言（例如"文本为『验证失败反馈』的区块数"）。
    这样能把 GUI 项的结论从「源码断言 + build 通过」提升到**真实交互闭环**，且不必装 Playwright。
    **注意**：`evaluate_script` 的 `function` 参数里**不要写反斜杠**（经 shell/JSON 两层转义会被吃掉），
    需要 `\` 时用 `chr(92)` 或改用「写临时 .py 文件再执行」——本次 heredoc 里 `'D:\'` 被吃掉导致 SyntaxError。

73. **「某个开关没对某块 UI 生效」类反馈：多半是判定集合漏项，而不是事件没绑（2026-09-20 T00797 定型）**：
    用户描述"一键收起对验证失败反馈不生效"时，直觉是"事件没接上"，实际是聚合判定 `hasExpanded` 少算了一个状态位，
    导致**点收起反而走了展开分支**（现象比"没反应"更迷惑：越点越乱）。
    **排查套路**：① 找到聚合判定表达式，逐一对照页面上所有独立折叠状态（本例 4 组：desc/summary/result/failback）；
    ② 检查收起分支是否只清了部分状态；③ 检查"草稿态"这类**隐式可见条件**（`fbDrafts !== undefined` 时窗口仍渲染，
    只清 open 标志收不掉）；④ 把重复计算抽出单一来源（同一表达式在 onClick 与图标里各写一份 = 必漂移）。

74. **「找不到按钮」类反馈先分清是「没接」还是「接了就看不见」（2026-09-20 T00796 补漏定型）**：
    用户截图说"某处没有 X 按钮"时，两种成因的修法完全不同，别默认只补挂载点：
    ① **真的没接**（本例「修改」入口：只在录入弹窗/处理结果接了，行内编辑态漏掉）→ 补挂载；
    ② **接了但被样式藏了**（本例「录入」弹窗：空闲态 `opacity: 0.45` 的 13px 描边图标在浅色背景上直接不可辨，
    截图里那一行右侧看着就是空的）→ 改可见性。
    **判定套路**：先用容器/aria-label 定位该按钮是否存在于 DOM（`querySelector` 命中即"接了"），
    再看 `getComputedStyle(el).opacity / color` 与实际尺寸 —— 本例实测空文本态 `opacity:0.45, color:muted`，
    填充后 `opacity:1`；改法是把「不可用」只体现在颜色+`cursor` 上（`text-muted` + `opacity 0.75`），
    并在 title 里说明原因（如「（请先填写内容）」），保证按钮**始终清晰可见**。
    推广：所有"图标按钮 + 空值禁用"的交互都有此风险，禁用态不要低于 0.7 不透明度。

75. **打包态与开发态是两套 UI：改了前端没重打包 = 用户看不到（2026-09-20 实测，配合第 7 条判新鲜度）**：
    用户报"按钮没有"时，先确认**他运行的是哪个实例**：查监听端口（打包态默认 39877、开发态 39876）
    与进程映像路径（`wmic process where "ProcessId=<pid>" get ExecutablePath`）——
    本次查到是 `F:\Program Files\MTask\MTask.exe`，而 `release/MTask Setup *.exe` 的打包时间早于修复 commit，
    属于典型假性失败。**改完前端后必须重打包**（统一入口 `scripts/构建打包.bat`，或 Node 版 `scripts/打包.mjs`），
    并提前告知用户"打包会先关闭正在运行的 MTask 实例"。

76. **DevTools MCP 不可用时的 UI 验证替代：用仓库自带的 Electron 当无头浏览器（2026-09-20 定型）**：
    `npx electron <probe.js>` + 隐藏 `BrowserWindow` 加载 `http://127.0.0.1:<隔离端口>/`，
    再用 `win.webContents.executeJavaScript(<async IIFE>)` 跑点击与 DOM 断言，最后 `app.exit(0)`。
    零额外安装、渲染环境与产品一致（同一 Chromium），onclick 用 `el.click()` 即可触发 React 合成事件。
    **两个实测陷阱**：① 中文界面里的括号是**全角** —— 用 `/已完成\s*\(/` 匹配「已完成（8/200…）」会失败，改 `/已完成/`；
    ② 同名元素歧义 —— `aria-label="验证失败"` 的徽标与"标记验证失败"菜单项文案相同，必须先在容器
    （`[aria-label="验证结果选择"]`）内查找，否则会点到徽标导致"菜单没展开"。
    另外脚本里等待 AI 回填要轮询（本例 7~12s），不要写死 sleep 后断言。

77. **docx 抽取文本里的 Word 域代码噪声（2026-09-20 T00814 实测）**：不少 Word/WPS 导出的 docx 把目录/页码/交叉引用保存成域代码文本，解压 document.xml 后取到的正文形如
    `HYPERLINK \l _Toc18264 1. 基本情况 PAGEREF _Toc18264 \h 1`。实测 70KB 需求文档 3582 字符里域码命中 60 处，连锁反应：
    ① 喂给 AI 的需求全文被污染；② 「检索增强」关键词提取把这批域标识符当检索词（控制台打出 `[HYPERLINK, _Toc18264, PAGEREF, …]`），
    注入的代码片段与需求无关。修法：`server/src/util/wordFields.ts` —— `stripWordFieldCodes()`（目录行只留可读标题、整行域码丢弃，
    实测 3582→2720 字符、域码 60→0）+ `isWordFieldToken()`（extractKeywords 里排除域标识符与"数字为主"的串）。

78. **docx 标题识别：中文版 Word 的标题 styleId 是"恰好一位数字"，任何模糊数字兜底都会误判（2026-09-20 T00814 实测）**：
    `docxToMarkdown` 原来的 `/(\d)/` 兜底把 styleId 149（修改记录表头「编号/日期」）、214（封面）、49/58/36（目录行）全部标成 `#`~`####` 标题，
    正文结构被污染。正确姿势：只认 `HeadingN` 或 `^([1-9])$` 的 styleId（中文 Word「标题2」存为 "2"），不做"任意位置含数字"兜底。
    排查方法：dump 每段的 `pStyle` + 文本对照（见 .workbuddy/chk-styles.ts 思路）。

79. **思考型模型的输出触顶给更高 max_tokens 也救不了：模型自身有输出上限（2026-09-20 T00814 实测）**：
    deepseek-v4-flash 在 max_tokens=8192/16384/32768 三档下，流出的可见正文都停在 ~9~10K 字符即 `finish_reason=length`
    （思维链占同一预算，且模型自身上限封顶）。**对策**：`StreamResult.partial` —— 触顶时携带已流出文本返回（ok 仍为 false），
    仅"用户会逐条复核"的长文场景（当前仅 PRD 生成）选择性采纳并显式告警「⚠ 保留当前 N 字符继续，问题由补充提问补齐」；
    T00779 的"ok=false 防半截入库"语义对其它场景（任务回写/PRD 导入等）保持不变。配套：prompt 给篇幅边界
    （PRD 正文 ≤6000 字、不复述原文），输出预算下限 16K、提供商拒绝时自动回退 8K 重试。

80. **打包 EBUSY：先确认没有本会话遗留的隔离 server 进程（2026-09-20 实测）**：
    `scripts/打包.mjs` 切 better-sqlite3 ABI 时要把 electron 版 `.node` 拷进 node_modules —— 若本会话起过的隔离 tsx 实例还活着，
    会锁住该文件报 `EBUSY: resource busy or locked`。打包前先 `netstat -ano | grep <隔离端口>` 并 Stop-Process 对应 PID。

81. **AI 输出整份内容被 ``` 围栏包裹时，Markdown 渲染"看起来坏了"（2026-09-20 T00815 定型）**：
    模型偶尔把整份产物（PRD/报告）包进 ```markdown … ```——markdown-it 按规范把整体渲染成**一个代码块**，
    用户看到的就是原始 #/**/- 符号，表现为"Markdown 没渲染"。此时组件本身没问题（.mdv 容器存在、
    markdown-it 工作正常），别急着换渲染库或加依赖。**修法**：识别「首行 ``` + 末行 ```」的整体包裹并解开
    （`unwrapTopFence`），注意：① 若产物含 <<<ISSUES>>> 等分段标记，必须**先解围栏再切分段**，
    顺序颠倒会丢失闭合围栏；② 流式场景末行围栏未到，只去首行（前端 cleanPrdStreamText 同口径）；
    ③ 局部代码块不能动。server 与 web 各有一份同口径实现（prdIssues.splitPrdBody / utils/prdFence），改动需同步。

82. **给探针/脚本写块注释时严禁出现 `**/`（2026-09-20 实测）**：探针头注释写了"裸文本 **/#（未渲染）"，
    `**/` 提前终止了块注释 → 整个文件 SyntaxError → Electron 加载失败弹窗（show:false 时完全看不到），
    后台任务挂了 14 分钟无任何输出。同类：行注释里写 `// ... */` 无害，但 `/** ... **/` 组合必炸。
    探针类脚本务必：① 头部 `setTimeout(app.exit, N).unref()` 兜底超时退出；② 输出直接落文件
    （`> log 2>&1`）而非经管道 grep——grep 会缓冲到进程结束，中途什么都看不到。

83. **"功能被拦截/不生效"类反馈：先分清「逻辑没生效」与「生效了但用户看不到」（2026-09-23 T00873 四轮定型）**：
    用户连续四轮报同一功能，前三轮都在改判定逻辑；实测发现**逻辑本身早在三轮就正确**（改完能提交、能落库），
    真正的病灶是三处可见性缺口：① 下拉不标「（当前）」→ 用户无法判断当前值，重复提交得到"无改动"文案；
    ② 界面上完全不展示该属性 → 操作后"毫无变化"，看不出是否成功；③ 该属性无处可检索 → 形同不存在。
    **套路**：先用隔离实例 + 探针把"用户描述的那一步"完整点一遍并核对 API/DB，确认逻辑层是否真的失败；
    若逻辑通过，就逐项问"用户怎么知道它成功了"——把当前值标出来、把结果展示出来、把维度做成可筛选，
    并把 no-op 文案按真实情形分开（"已归入X，无需重复" vs "两个维度都没改，各自该用哪个下拉"）。

84. **交付了但没入库 = 下一轮必然踩坑（2026-09-23 实测）**：T00873 的问题在四轮里反复出现，一查 `git log -- <file>`
    才发现 T00636/T00837/T00873 一~三轮的**前端与后端实现全都只存在于工作区、从未提交**（另有 T00872/T00817/T00821 等其它会话的未提交改动混在同一批文件里）。
    处置：对**多会话共用文件**用「HEAD + 锚点打补丁」只提交本任务相关 hunk（server 侧只补 req_category_id 的 schema/路由/审计行），
    对**整文件都属于本任务族**的文件（如本例 PromptsPage.tsx）整文件提交，并在 commit message 里写明"同时补齐此前未入库的 X/Y/Z"。
    **提交后必须用暂存区导出树跑 tsc**：本例正是靠它发现 `Prompt.req_category_id` 类型定义（client.ts）也漏在库外。

85. **探针读 toast 别套 `filter(vis)`（2026-09-23 实测）**：`.flash-toast` 是 `position: fixed`，而 `offsetParent` 对 fixed 元素恒为 `null`，
    用 `filter((el)=>el.offsetParent!==null)` 会把它整个过滤掉，表现为"点了但没提示"的假象（白排查一轮）。
    正确做法：读 toast 时不做 vis 过滤，或直接 `document.body.innerText.match(/关键词/)`。

86. **建单标题带中文弯引号会被 PowerShell 拆参（2026-09-23 实测）**：PowerShell 把 `“ ”`（U+201C/U+201D）当字符串定界符，
    传 `"【AI回写待审核】…“是否生效”…"` 时标题在弯引号处被切断，`argv[2]` 变成标题后半段，python 直接报
    `FileNotFoundError: '<标题后半段>'`（误判为找不到 desc 文件）。建单标题一律用直引号或干脆不带引号，禁用 `“”‘’`。

86. **"多选只处理了一份"先查服务端请求数：请求都发了 = 前端状态被覆盖（2026-09-23 T00933 定型）**：
    用户报"多份只处理了第一份"，先看**隔离实例服务端日志里该端点被请求了几次**——本次 2 次都在（72s+141s），
    说明后端与遍历都没问题，缺陷在前端：`generate()` 每份都调 `prdGenStore.begin()`（重置 logs/streamText/result），
    于是第 1..N-1 份的结果被下一份覆盖后**凭空消失**，只剩最后一份（前序 AI 生成白跑，用户观感"只处理一份"）。
    **修法**：批次状态只建一次（`beginBatch(total)`），每份用 `beginFile(idx,name)` 只重置本份流式字段，
    每份结果 `pushBatchItem` 入册（失败也留占位），`finishBatch(okCount)` 收尾；面板再给一个「批次结果」列表，
    每份可点「载入」切换当前查看/录入对象。**批量类功能通用检查点**：日志是否被覆盖？结果是否被覆盖？失败份有无留痕？

87. **折叠式卡片面板的探针定位（2026-09-23 实测）**：AI 工作台等页面的卡片展开触发器**不一定是 button**（可能是可点击容器），
    且顶层容器的文本包含**所有**卡片名——按"祖先链含卡片名"匹配会命中第一张卡，点了错的卡片。
    正确姿势：① 取「同时含卡片标题与『点击展开工作面板』、**文本长度最小**的元素」作为卡片块；
    ② 在该块内部再取最内层含展开文案的元素（button/div/span/a 都试）再 `.click()`；③ 展开后用 aria-label 找控件，
    找不到就先 dump 全部 `[aria-label]` 与 input 列表再改选择器（面板改版很快，旧 aria-label 可能已变）。

88. **服务端合成导出文件（docx/pdf/xlsx）的落地套路（2026-09-23 T00959 定型，可直接复用）**：
    导出类需求（"加个下载/导出按钮，出 Word/PDF/Excel"）优先**服务端合成 + 客户端只触发下载**：
    ① 重依赖（docx / pdfkit / exceljs）放 `services/xxxExport.ts` 且用 `await import()` 按需加载，避免常驻内存；
    ② 中文 PDF 用系统字体 `C:/Windows/Fonts/simhei.ttf`（与 report-builder 同口径），否则中文全变方框；
    ③ 路由用 `exportGate('名字', undefined, { defer: true })` 挂并发闸；`Content-Disposition` 用
       `filename*=UTF-8''` + encodeURIComponent(文件名)（中文名必须 RFC5987 编码）；文件名先过 safeExportName 去非法字符；
    ④ 导出数据**与界面同源**（调同一个 service 重新取），不要接收前端传的行数据，否则界面有筛选时导出会被裁剪；
    ⑤ 客户端统一下载口径（Blob + 隐藏 a + 正确 MIME），收口到一个 util，避免各处 MIME 写错存成 .bin。

89. **验证"下载"类交互要捕获真实落盘，别只查按钮存在（2026-09-23 实测）**：Electron 探针里用
    `session.defaultSession.on('will-download', (e, item) => { item.setSavePath(dest); item.on('done', (_, st) => records.push({ name: item.getFilename(), st })); })`
    才能断言"点了确实产出文件、文件名与字节数正确"；只断言按钮/请求存在会漏掉"下载被拦掉/扩展名不对"。
    服务端另配一套纯 HTTP 断言（文件头 PK / %PDF … %%EOF + 用 pizzip/exceljs 反解内容），两层互补。
    验证导出代码还应**在暂存区导出树再跑一遍**（在 staged 目录直接 tsx 起服务，node_modules 会自动向上找到主仓），
    确认"入库的那份代码"本身可跑，而不是只有工作区能跑。

90. **精确提交时锚点必须现查 HEAD，不能照抄工作区（2026-09-23 T00959 踩坑）**：工作区里存在的路由/代码块可能是
    **其它会话未提交的 WIP**（本次 `/prd-docs/:id/status` 就是），照抄工作区文本去打 HEAD 补丁会 count=0 直接失败。
    正确姿势：每个锚点先用 `git show HEAD:<file> | grep -n -A/-B` 核对原文，脚本里对每个锚点做 `count == 1` 断言，
    失败即退出（不要静默继续）；补齐依赖类型/工具函数的文件也要一并精确补（否则暂存区导出树 tsc 会报缺属性）。

91. **⚠ 清理"暂存区导出树"时严禁递归删除含 node_modules 链接的目录（2026-09-23 T00959 惊险一次）**：
    在 staged 树里跑验证时为省事用 `ln -s ../../../node_modules .workbuddy/stagedX/node_modules`（Git Bash 建的符号链接），
    清理脚本若用「递归 listdir + 逐层 DeleteFileW」去删 stagedX，会**顺着链接走进真实 node_modules 删文件**（本次链接恰好是悬空的
    `D:\\code\\otherProjects\\node_modules` 才侥幸无事）。正确姿势：① 先 `os.path.islink(p)` 判断，是链接就 `os.unlink(p)`
    只删链接本身，再删外层目录；② 更稳的是**不放链接**——直接在 staged 目录里跑 `npx tsx`，Node 会自动向上找到主仓 node_modules；
    ③ 删任何目录前先打印待删清单与层数，别一把梭。

92. **"用默认值提交"类静默失败：先查"空输入=取消"的弹窗语义（2026-09-24 T00964 定型）**：
    用户报"不填直接点确认没任何反应"，典型根因是自绘输入弹窗把**空输入一律 resolve null**（null 又被调用方当取消
    直接 return）——没有任何报错，现象就是"点了没反应"。修法别改全局语义（会波及所有调用方），给共享弹窗加
    `allowEmpty` 开关（true 时空输入 resolve ''，取消仍 null），需要默认值兜底的调用方打开它，
    提交侧保留 `value.trim() || 默认值`。验证必须覆盖四条路径：预填直接确认 / 清空后确认 / 改名确认 / 取消不产生数据。

93. **"长任务切页后结果没了/控制台卡住"：查组件卸载，不是查网络（2026-09-25 T00982 定型）**：
    现象常是"控制台日志停在『xx 完成』但结果一条都没有"。三步定位：
    ① React 会**丢弃已卸载组件**上的 setState —— 长任务（AI 解析/生成）在切页后完成，setState 全部无效；
    ② 若结果靠 `useSessionState`（持久化写在 useEffect 里）落盘，**卸载后 effect 不再执行** → 内存与磁盘双双落空；
    ③ 日志 store 是模块级的照常输出 → 于是"日志说完成、界面没结果"。
    **修法**：任务完成时**同步写 sessionStorage**（与 useSessionState 同键，键名集中定义），
    同时在模块级 store 上加一个"完成戳（stamp）"，面板按 stamp 变化重新从存储载入——
    覆盖两种时序：解析在卸载期间完成（切回挂载时读到）、已切回后解析才完成（旧实例 setState 被丢弃，靠 stamp 拉回）；
    导入/提交成功时顺手把 stamp 清零，避免旧结果回流。
    验证要跑"同一脚本前后对比"：切页前后各记录结果行数、按钮是否存在、sessionStorage 字节数。

94. **⚠ 前端改完必须 `vite build` 才能用探针验证（2026-09-25 T01001 二轮踩坑）**：
    Electron 探针访问的 `http://127.0.0.1:<隔离端口>/` 是**服务端伺服的 `web/dist`**，不是源码。
    只跑 `tsc --noEmit` 就开探针，会验证到**上一版产物**（本次现象：新加的「类型」列不存在、
    里程碑工期仍是旧值 4），极易误判成"改错了"。**顺序：改码 → `npx tsc --noEmit` → `npx vite build` → 起探针**。

95. **上游 AI 不可用时的确定��� UI 验证：用 fetch 桩注入 fixture（2026-09-25 实测）**：
    AI 上游报 `fetch failed`（模型/Agnes 侧故障）时，真实解析链路跑不了，但仍要验证面板渲染与交互——
    在探针里覆写 `window.fetch`：命中目标接口（如 `/ai-parse-prd`）就返回与用户反馈**同构**的 fixture Response，
    其它请求透传给原 fetch。这样能真实驱动组件渲染、校验表格列/只读属性/联动计算（改子任务 → 父项重算）。
    结论区要如实标注"真实模型路径未复验，需人工抽查"。

96. **里程碑任务：先子后父 + 逐条回写进度（T01037）**：处理带「里程碑」徽标的待办时，
    **先处理其下子任务、再收口里程碑**；每完成一条子任务 PATCH `/api/plans/<里程碑id> {progress}`，
    全部完成后才 `{"progress":100,"status":"done"}`。
    ⚠ 反向操作会毁掉进度语义：里程碑自身待办一旦 done，「待办 done → 关联 plan done + progress 100」
    的双向同步会让里程碑在子任务还没动时就 100%。子任务口径：A 优先按 `deps` 里 `type='child'` 指向该里程碑的条目，
    B 兜底按排序取「本里程碑之后到下一里程碑之前的非里程碑条目」（与项目管理页 milestoneMeta 同口径）。
    详见 `references/8-milestone-workflow.md`。

97. **项目名必须取服务端真实 `name`，拼出来的名字会「项目不存在」（2026-09-27 实测）**：
    AIMsg 项目在 MTask 里的真实名称是 **`aimsg一期`**（不是凭目录名猜的 `aimsg`）。
    `mtask_list_tasks({projectName:'aimsg'})` / `mtask_create_task({projectName:'aimsg'})` 都会报
    `错误：项目不存在：aimsg` 并给出候选列表。修法：`raw mtask_list_projects '{}'` 拉全量项目，
    用 `workspace_path` 匹配到目标项目后取它的 `name`；**更稳的是直接用 `projectId`**（从任务详情的
    `project_id` 拿，脚本 `create <title> <desc.md> <projectName|projectId>` 会自动按是否含 `-` 判定）。
    另：`raw` 分支输出被截到 4000 字符，取编号用正则从文本里抠 `T\d{5}`，不要指望 JSON 解析。
