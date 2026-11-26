# 收集箱作用域验证（2026-11-26）

## 范围

- `sys-inbox` 的任务域展示名从「收件箱」改为「收集箱」。
- 顶栏「当前项目/工作区」在「全部项目」后常驻「收集箱」选项。
- 菜单「收件箱」（`inbox_items` 分诊台）保持不动，不与 `sys-inbox` 合并数据。

## 验证结果

- `npm exec --workspace mtask-web -- tsc --noEmit`：通过。
- `npm run build -w mtask-web`：通过（1913 modules，vite build 成功）。
- 任务页顶栏菜单选项：`全部项目`、`收集箱`；无普通项目时提示「可直接使用收集箱」。
- 选择「收集箱」后顶栏显示「收集箱」，作用域持久化；刷新后仍为「收集箱」。
- 临时在 `sys-inbox` 创建 `T00001 收集箱计数验证`：
  - 顶栏「收集箱」计数变为 1；
  - 任务页列表显示该任务，任务行项目名为「收集箱」；
  - 「全部项目」计数同样包含该任务。
- 循环任务「选择项目」：选项为 `选择项目…`、`收集箱`（`sys-inbox`），无「收件箱」。
- 临时任务已归档并物理删除；复查 `sys-inbox` 未归档任务数为 0。

## 证据

- `docs/evidence/collection-box-scope.png`：收集箱作用域 + 临时任务计数。
- `docs/evidence/collection-box-switcher.png`：顶栏常驻收集箱选项。

## 说明

验证使用本地 Vite 5175 + server 39876，验证后已停止；测试任务已清理。
