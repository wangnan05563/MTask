# 章节规划 · MTask 四期·五期 功能模块培训（科技风 tech）

> 核心信息：四期、五期把 MTask 从"排期工具"升级为"对外报价 + 一键成稿"闭环——计划→估算报价→用例覆盖→启动会成稿。
> 视觉系统：深色 #0a0e1a；强调色 #38bdf8(青) / #a78bfa(紫) / #fbbf24(琥珀)；等宽字体做技术标签；卡片化分层。

## Page 1: 封面
- Page Type: Cover | Selected Template: cover/tech/039.tpl
- Title: MTask 四期·五期 功能模块培训 | Subtitle: 从项目计划到对外报价与一键成稿
- 标签: [SYSTEM_READY] · 内部培训 · 2026

## Page 2: 目录
- Page Type: TOC | Selected Template: toc/tech/3582.tpl
- 四章：01 背景与总览 / 02 四期详解 / 03 五期详解 / 04 实操与收尾

## Page 3: 过渡 01
- Page Type: Transition | Selected Template: transition/tech/560.tpl
- [ 01 ] 背景与总览 / 为何要做四期、五期

## Page 4: 背景与痛点
- Page Type: Content | Selected Template: content/tech/1582.tpl（三卡片）
- 三痛点：(1) 报价脱节——历史待办 1580 条、需求矩阵/计划/用例已沉淀却只用于排期，报价仍手工誊抄 Excel（阜新银行模板即人工产物）；(2) 用例零散——缺统一库、缺覆盖度度量、缺与需求矩阵溯源；(3) 资料不转化——PRD/矩阵/计划/用例沉淀后启动会 PPT 仍人工拼装。
- 数据：mtask四期 12 条需求(high 10/normal 2)；工期分布 normal avg 1.75 天、milestone avg 7.0 天。

## Page 5: 四期·五期 交付总览（三大模块地图）
- Page Type: Content | Selected Template: content/tech/1583.tpl（四模块）
- 四卡片：①估算面板与 PERT 引擎 ②Excel/PDF 导出 ③测试用例管理+AI生成 ④AI 启动会 PPT 生成
- 闭环：计划 → 估算报价 → 用例覆盖 → 启动会成稿

## Page 6: 过渡 02
- Page Type: Transition | Selected Template: transition/tech/560.tpl
- [ 02 ] 四期详解 / 估算·导出·测试用例

## Page 7: 估算面板与三点估算
- Page Type: Content | Selected Template: content/tech/1581.tpl（2x2 四卡）
- 四卡：入口(项目管理时间线右侧新增估算面板) / 面板结构(每行计划=一估算对象) / 录入与批量(乐观O·最可能M·悲观P三点) / 可视化(不确定度随录入实时可见)
- 要点：三点估算替代单点拍脑袋；复杂度→系数冷启动推导，可逐条覆盖。

## Page 8: PERT 计算与汇总引擎
- Page Type: Content | Selected Template: content/tech/1584.tpl（五节点流）
- 流水线：O/M/P 录入 → E=(O+4M+P)/6 期望值 → σ=(P-O)/6 标准差 → 置信区间 → 按"阶段"汇总(最终估算→阶段人月→调节系数→实际预估人月)
- 口径：排除小计行、里程碑不进 Σ；复刻客户模板 R35~R40。

## Page 9: Excel / PDF 导出
- Page Type: Content | Selected Template: content/tech/1585.tpl（三立方体）
- 三交付：①Excel——sheet名/合并区/公式/命名区域/列宽逐格对齐客户模板，无需二次排版；②PDF——可直接提交客户的报价版；③MCP——以 mtask_* 工具暴露，可被外部 Agent 调用。
- 快照留档 estimate_snapshots；依赖 exceljs 4.4.0 / docx 9.7.1 / pdfkit 0.20.1（零新依赖）。

## Page 10: 测试用例管理模块
- Page Type: Content | Selected Template: content/tech/1588.tpl（四面板）
- 四面板：数据模型(test_cases + case_steps 步骤子表 + 枚举常量单源) / CRUD 与批量(静态路径优先) / 覆盖度(按 P0~P3 统计，swork 71 条用例) / 矩阵双向跳转(需求矩阵⇄用例)。

## Page 11: AI 生成链路与 MCP 工具
- Page Type: Content | Selected Template: content/tech/1590.tpl（管线/网络）
- 链路：PRD/外部导入 → TestCaseGenService 生成草稿 → 草稿确认视图 → 确认导入 → 以 mtask_* MCP 工具注册暴露。
- 约束：长文输出受 max_tokens 易截断→需抬预算/分章；复用既有 report-worker 池。

## Page 12: 过渡 03
- Page Type: Transition | Selected Template: transition/tech/560.tpl
- [ 03 ] 五期详解 / AI 启动会 PPT 生成

## Page 13: 能力卡片与前置校验
- Page Type: Content | Selected Template: content/tech/1582.tpl（三卡片）
- 三卡：①第 7 张卡——在 ReportPage 的 reportCards 数组新增"项目启动会 PPT 生成"卡，复用 ReportCard 组件，不新造；②前置校验(Preflight)——聚合查询资料齐备性，硬阻塞缺料；③面板互斥与样式——与其他卡一致的光晕/hint 风格。

## Page 14: 核心生成引擎
- Page Type: Content | Selected Template: content/tech/1583.tpl（四模块）
- 四组件：版式断言层(质量门禁，Node 移植技能路径纪律) / PPT 装配器(新增的"内容装配"，非新引擎) / 时间线形状绘制(甘特/时间线) / 工作量与降级逻辑(超预算降级保交付)。
- 复用 pptxgenjs@^4.0.1 + worker 池，不引入 reveal/Slidev/Marp。

## Page 15: SSE 流式与交付链路
- Page Type: Content | Selected Template: content/tech/1584.tpl（五节点流）
- 链路：请求 → `POST /api/plans/kickoff-ppt-stream` SSE 流(stage/chunk/done/error) → 流式装配 → 服务端 Buffer + Content-Disposition 落盘 → 前端 saveBlob 下载；并发闸防资源打满；产物一次点击 12~18 页 .pptx。

## Page 16: 前端 KickoffPptPanel 交互
- Page Type: Content | Selected Template: content/tech/1587.tpl（代码/窗格）
- 要点：KickoffPptPanel 读取 PRD 文档 / 需求跟踪矩阵 / 项目计划 / 测试用例 / 工作空间分析；生成中 glow 光晕；可继续编辑的原生 pptx（含甘特、工作量、风险、沟通管理）。

## Page 17: 过渡 04
- Page Type: Transition | Selected Template: transition/tech/560.tpl
- [ 04 ] 实操与收尾 / 流程·成效·边界

## Page 18: 使用流程演练
- Page Type: Content | Selected Template: content/tech/1589.tpl（三步）
- 三步：①选资料(勾选 PRD/计划/用例) ②点"生成"(卡片触发 SSE) ③得 .pptx(下载 / 继续编辑)；一次点击成稿，无需手工拼装。

## Page 19: 能力对照与关键成效
- Page Type: Content | Selected Template: content/tech/1581.tpl（2x2 四卡）
- 四卡：四期·估算(三点→报价，可追溯) / 四期·测试(结构化库+覆盖度+AI生成) / 五期·PPT(资料→一键成稿) / 成效(零新依赖、复用 worker 池、12~18 页成品)。

## Page 20: 注意事项与边界
- Page Type: Content | Selected Template: content/tech/1588.tpl（四面板）
- 四边界：非目标(资源费率/财务核算/Portfolio 汇总不做；五期不造新 PPT 引擎) / 降级策略(长文截断→抬预算分章；版式断言门禁) / 风险(并发闸、资料缺料阻塞) / 审批状态(四期 PRD 已批准 v1.3；五期 PRD 草案待审批 v1.0)。

## Page 21: 结尾
- Page Type: Ending | Selected Template: ending/tech/1108.tpl
- 谢谢 / 感谢聆听 · MTask 团队
