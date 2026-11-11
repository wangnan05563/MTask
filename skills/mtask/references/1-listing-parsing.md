# Reference 1 —— 清单解析（mtask_list_tasks 输出处理）

## 背景

`mtask_list_tasks` 返回的文本并不是可直接用的任务数组，而是 **MCP 文本包装 + 双层 JSON 字符串**：

```
The MCP server responded with: [{"type":"text","text":"[\n {id..,task_no..},\n {..}\n]"}]
```

- **外层**：普通的 MCP 工具响应（`[{"type":"text","text":"..."}]`）。
- **内层**：`text` 字段的值，本身又是一个 **JSON 数组字符串**（即任务数组序列化成了字符串）。

要拿到任务对象，必须**二次解析**：先解析外层得到 `text`，再对 `text` 解析得到任务数组。

## 解析脚本

优先使用 `scripts/list-todo.ps1`（输入为 `mtask_list_tasks` 的原始输出文件），它已封装二次解析、`todo` 筛选与 `task_no` 升序排序：

```powershell
./scripts/list-todo.ps1 -InputFile "C:\path\to\mtask-output.txt"
./scripts/list-todo.ps1 -InputFile "C:\path\to\mtask-output.txt" -ProjectFilter "97510316-0063-4d25-a22c-566021c93ae8"
```

### 省 Token：先按项目收窄再解析（默认=待处理+未验证）

用户点名项目时（如「处理 wiki 待办」），**不要** `mtask_list_tasks({})` 全量拉取。改为传 `projectName`，让 MCP 服务端只返回该项目任务。**默认查询范围 = 待处理(todo) 或 未验证(verified=0)**，即既不传 `status` 也不传 `scope` 时：

- `mtask_list_tasks({ projectName: 'wiki' })` → 只拉 wiki 项目「待处理+未验证」任务（默认，利于分析决策）。
- `mtask_list_tasks({ projectName: 'wiki', status: 'todo' })` → 只拉 wiki 项目纯待办。
- `mtask_list_tasks({ projectName: 'wiki', scope: 'all', archived: false })` → 该范围全部状态（等价旧行为）。

未验证(done)任务之所以纳入默认，是因其 `handle_result` 处理结果可能仍有待判断、可与其他任务交叉印证。`projectName/status/scope` 均在服务端过滤（见 MCP `server.ts` 的 `mtask_list_tasks`）。脚本的 `-ProjectFilter` 用于服务端已按项目过滤后、再按某具体项目二次缩小；两者可配合。

## PowerShell 手工解析要点（若需自行写）

```powershell
$raw = Get-Content -Raw $inputFile                    # 用 -Raw，不要把整段拆行
$prefix = 'The MCP server responded with: '
$outer = $raw.Substring($prefix.Length).Trim() | ConvertFrom-Json   # 第一次解析 → 外层
$innerText = $outer[0].text                           # 这才是任务数组(json字符串)
$tasks = $innerText | ConvertFrom-Json                # 第二次解析 → 任务对象数组
```

筛选与排序：

```powershell
$todo = $tasks | Where-Object { $_.status -eq 'todo' } |
        Sort-Object { [int]($_.task_no -replace 'T','') }   # 按编号数值升序
$todo | ForEach-Object { "{0} | {1} | {2}" -f $_.task_no, $_.id, $_.title }
```

## 约定

- **处理顺序** = `task_no` **数值升序**（T00224 → T00225 → T00226），不是创建时间，也不是文本序。
- 只处理 `status == 'todo'`；`done` / `archived=true` 不参与本轮。
- 每条任务的关键字段：`id`（内部 UUID）、`task_no`（如 `T00224`）、`title`、`description`、`status`、`verified`、`project_id`、`category_id`。
- 回传时可用 `taskNo` 或 `id` 定位，二者选一；`taskNo` 更直观，`id` 更稳定（重名时用 id）。

## 踩坑记录

- **不要用 Read 工具直接读** MCP 输出的清单文件：其编码/包装可能导致 Read 返回空或不可读；用 PowerShell `Get-Content -Raw` 可正常读到完整长度。
- 输出可能很大（数百条任务，数百 KB），先交脚本解析，避免把原始文本灌入上下文。
- 若解析正则匹配到 0 条，多半是转义引号（`\"`）或包装未剥离，回到上面的二次 `ConvertFrom-Json` 思路。