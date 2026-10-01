# T01374 workspace 清理 — 执行报告

> 目标：清理 `D:\code\otherProjects\26_MTask` 工作空间的可重建垃圾（缓存 / 构建产物 / 日志 / IDE
> 缓存等），**严格保护**源码、配置（package.json/tsconfig/.env）、用户数据、`.workbuddy`。

## 调研结论（先做只读扫描，按 git 跟踪状态核对）
- 候选共 42 项、约 **432 MB**，经 `git ls-files` 核对 **无一纳入版本控制**（删除不会破坏版本库）。
- 但进一步逐目录核对发现两处**必须排除**的陷阱（仅比目录路径会漏检内部文件）：
  1. **根 `build/` 含 git 跟踪的源码资产**（`build/icon.*`、`build/social-preview.*` 等）+
     运行时原生模块 `build/native/**/better_sqlite3.node` —— 误删会破坏图标素材与本地运行，**排除**。
  2. **`server/dist/data/mtask.db`（+shm/wal）是运行时用户库** —— 违反「用户数据禁止删」规则，**排除**。
- `release/`（420 MB）是 electron-builder 安装包产物：gitignored、可由 `scripts/构建打包.bat`
  重建，但属**当前交付物**，保守保留。

## 实际删除清单（均为可重建、无跟踪文件、无活动用户库）
| 项 | 大小 | 说明 |
|---|---:|---|
| `web/dist` | ~1.6 MB | 前端构建产物（vite 输出），可重建 |
| `perf/sandbox/t00792_repo/build` | ~3.9 MB | 隔离验证沙箱副本的构建目录，可重建 |
| `.scannerwork/` | ~0.3 MB | SonarQube 分析临时缓存 |
| `perf/**/*.log` | ~50 KB | 性能测试过程日志 |
| `_history.new.ts.bak` | ~8 KB | 备份文件 |

**释放空间合计：约 5.5 MB（42 项中的安全子集）。**

## 保留项（受保护 / 交付物，未删）
- `server/dist/`（含运行时 `mtask.db` 用户库）
- 根 `build/`（含跟踪素材 + 原生模块）
- `release/`（420 MB 当前安装包，留作交付物）
- `node_modules/`、`.trae/`、`.workbuddy/`、所有源码与配置

## 空间提示（重要）
清理仅回收约 5.5 MB，对磁盘压力杯水车薪：**`D:` 盘当前已 99% 满（仅剩 ~1.9 GB 可用）**。
若需真正回收空间，最大可释放块是 `release/`（420 MB，重建命令 `scripts/构建打包.bat`）。
建议另行评估是否清理历史 `release*/`、`node_modules`（需保留以构建）、或迁移大目录。

## 结论
清理在「安全优先」前提下完成，未触碰任何源码 / 配置 / 用户数据 / 版本控制文件；确认了
`build/` 与 `server/dist/data` 两个易误删陷阱并主动规避。后续如需更大空间回收，建议单独立项
处理 `release/` 与磁盘容量。
