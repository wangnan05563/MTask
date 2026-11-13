# 【AI回写待审核】better-sqlite3 native ABI 重建：让全部 DB 驱动 .mts 门脚本恢复可跑

## 背景（来源：T04896 验证时发现的 ABI 错配）

T04896 门脚本 `verify-t04896.mts` 的 5 条 DB 断言因 `better-sqlite3` native 二进制 ABI 错配全部 [SKIP-ABI]，且该错配是**全仓级**的——不只 T04896，所有依赖 better-sqlite3 的 `.mts` 门脚本（t02851/t04064 等）当前都崩在 `dlopen`，DB 断言跑不了。

## 现状诊断（已实测）

| 位置 | NODE_MODULE_VERSION | 备注 |
|------|--------------------|----|
| 系统 Node v22.22.2 `process.versions.modules` | 127 | 当前 PATH 上的 Node |
| `node_modules/better-sqlite3/build/Release/better_sqlite3.node`（工作区） | 137 | Electron ABI |
| `build/native/dev/better_sqlite3.node`（dev 缓存） | 137（sha `e75b8c02`，与工作区字节相同） | 本应是系统 Node ABI，却装成了 Electron 份 |
| `build/native/electron/better_sqlite3.node`（electron 缓存） | 130 | Electron 33.4.11 运行时 |

`scripts/native-switch.bat` 头注释声称 dev=137「matches the node on PATH」，但实测当前系统 Node=127——dev 缓存是**旧 managed Node 时代（v22.22 模块号曾为 137）的产物**，Node 版本/构建变更后未重建，导致 dev 缓存与当前系统 Node 不匹配。

## 修复目标

把 `build/native/dev/better_sqlite3.node` 重建为**与当前系统 Node(127) 匹配**的 better-sqlite3 二进制，并让工作区可切过去，使所有 `.mts` 门脚本 DB 断言恢复可跑。

## 待办

1. 用与系统 Node v22.22.2（MODULE 127）匹配的 better-sqlite3 预编译件或 `npm rebuild better-sqlite3` 重建 Node 版二进制。
2. 校验重建出的二进制 `process.versions.modules` 与系统 Node 一致（用 `dlopen` 冒烟：`node -e "new (require('better-sqlite3'))(':memory:').exec('select 1')"` 不报 ABI 错）。
3. 覆盖 `build/native/dev/better_sqlite3.node`（dev 缓存）。
4. `native-switch.bat dev` 把工作区 `node_modules/better-sqlite3/build/Release` 切到 dev ABI，跑通任一 DB 门脚本（如 `t02851`）确认全绿。
5. 重跑 `verify-t04896.mts`，让 T04896 的 5 条 DB 断言从 [SKIP-ABI] 转全量 8 断言。
6. （可选加固）把「native ABI 可用性探针」纳入 gate-boot 预检：ABI 不匹配时显式告警而非静默 [SKIP-ABI]。

## 影响范围

- 纯环境/原生二进制层，**零源码改动**；`build/` 与 `node_modules/` 均不入库。
- 风险：重建会动到 `build/native/dev` 缓存（Electron 运行时走 `build/native/electron`，不受影响）；若 `npm rebuild` 失败（缺 C++ 工具链）需走预编译件下载。
- 不阻塞 T04896 代码合入（红线与接线已用纯函数 + 源码断言验证）；完成后 T04896 门脚本可补验转全量。

## 验收

- `node -e "new (require('better-sqlite3'))(':memory:').exec('select 1')"` 在系统 Node 下无 ABI 报错。
- `t02851` / `verify-t04896.mts` 的 DB 断言全部 PASS（非 [SKIP-ABI]）。
- `native-switch.bat electron` 仍可用（Electron 缓存未被 dev 重建污染）。
