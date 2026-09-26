来源：T00788（history/list 消 N+1 后的实测发现）。

背景：T00788 已把 /api/history/list 的查询数从 1+2N 降到 3，端点 p50 由 36.37ms 降至 30.67ms
（A/B 实测，快 15.7%）。但复测表明 p50 仍无法稳定压到 30ms 验收线以下，根因已定位并量化：

- 纯计算链路（SQL+分组+stats+JSON）：p50 16.77ms，其中 SQL 取数 ~9ms、JSON.stringify ~7ms
- 端点实测 p50 30–45ms 波动，差额 ~15–25ms 为 express 路由分发 + res.json 序列化 + HTTP 写出
- 响应体 1.09MB（24 快照 × 45 任务 + 8 计划）——**序列化与网络写出已占端点成本一半以上**

问题：SQL 已不是瓶颈，瓶颈是**响应体本身**。当前 /list 一次下发所有快照的
全部 tasks + plans（含 description/handle_result 长文本），而前端 UI 是「分页 10 条 +
每条可折叠」——前端翻 10 条快照的数据却只用其中 1/10，典型的不匹配。

修复方向（需前后端协同，任选或组合）：
① **列表免传明细**：/list 只返回 projects + stats（去掉 tasks/plans 数组），新增
   `GET /api/history/snapshot/:id` 详情接口，前端展开某快照时按需拉取该快照的 tasks/plans。
   预期响应体从 1.09MB 降到 ~10KB，端点 p50 有望进入个位数 ms。
② **服务端分页**：/list 支持 page/pageSize（与前端已有 PAGE_SIZE=10 对齐），只返回当前页
   快照的明细。简单但只按页减小，单页仍有 ~50KB。
③ 若前端 tooltip 不再需要 description/handle_result，可裁剪大字段（T00788 已确认当前
   HistoryPage.tsx:237/250 确实消费这两个字段，裁剪前必须先改前端）。

验收：
- 响应体显著下降（方案①目标 <100KB）且 /api/history/list p50 < 30ms（隔离实例，24+ 快照稳态）
- 前端历史资产页功能不回归：快照列表、展开查看任务/计划、tooltip（任务描述/处理结果、
  计划描述）、关键词搜索快照项目 全部可用
- 前后端 tsc --noEmit 0 错误

复杂度与风险：涉及前端 HistoryPage 数据加载结构调整（展开态触发二次请求 + loading 态 +
错误处理），属中等改动；建议与「历史资产页按需加载」的 UX 优化一并做。
