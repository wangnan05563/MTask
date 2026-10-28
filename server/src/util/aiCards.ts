/**
 * T03172（PRD AI-301 / D-05 / G-2）：AI 卡片注册表单源。
 *
 * 口径：
 * - 「AI 卡」= 一项配置化产品能力（有稳定 card_key、可用状态），**不等同于通道 kind**（PRD 术语表）；
 * - 分母 = `available` 为 true 的卡（禁用/未发布不进分母）；
 * - `metered` 标记「该卡的 ai_usage 写入点是否已接 card_key」——未接的卡**仍进分母**（覆盖率如实偏低），
 *   接入派生单闭环后逐卡翻 true（T03164 只加列，本单先开通道并映射与 kind 一对一的卡）；
 * - ask/ask-json/stream 是多卡共用的**通用通道**，不得以 kind 冒充卡片维度：调用方必须显式传 cardKey，否则记 unknown。
 */

export interface AiCard {
  /** 稳定卡片标识（落 ai_usage.card_key） */
  key: string;
  title: string;
  /** 分组（规划/汇报/质量/开发），对齐 AI-301「按规划/汇报/质量等配置化分组」 */
  group: 'plan' | 'report' | 'quality' | 'dev';
  /** 当前可用（禁用/未发布=false，不进 G-2 分母） */
  available: boolean;
  /** 写入点是否已接 card_key（false=待接，见派生单） */
  metered: boolean;
}

export const AI_CARDS: readonly AiCard[] = [
  // —— 与 AIService 现网写入点 kind 一对一的卡（本单接通，metered:true）——
  { key: 'ai.organize', title: '任务 AI 梳理', group: 'plan', available: true, metered: true },
  { key: 'ai.task_summary', title: '任务摘要', group: 'plan', available: true, metered: true },
  { key: 'ai.title_optimize', title: '标题/描述优化', group: 'plan', available: true, metered: true },
  { key: 'ai.title_beautify', title: '标题美化', group: 'plan', available: true, metered: true },
  { key: 'ai.text_polish', title: '文本润色', group: 'plan', available: true, metered: true },
  { key: 'ai.title_simplify', title: '标题精简', group: 'plan', available: true, metered: true },
  { key: 'ai.category_classify', title: '分类建议', group: 'plan', available: true, metered: true },
  { key: 'ai.plan_evaluate', title: '计划 AI 评估', group: 'plan', available: true, metered: true },
  // —— 已上线但未接写入点的卡（进分母；接入见派生单，接入后翻 metered:true）——
  { key: 'ai.prd_gen', title: 'PRD 生成', group: 'plan', available: true, metered: false },
  { key: 'ai.prd_import', title: 'PRD 导入解析', group: 'plan', available: true, metered: false },
  { key: 'ai.plan_import', title: 'AI 项目计划导入', group: 'plan', available: true, metered: false },
  { key: 'ai.weekly_report', title: '周报/月报生成', group: 'report', available: true, metered: true },
  { key: 'ai.summary_ppt', title: '阶段总结 PPT', group: 'report', available: true, metered: false },
  { key: 'ai.kickoff_ppt', title: '启动会 PPT', group: 'report', available: true, metered: false },
  { key: 'ai.test_case_gen', title: '测试用例生成', group: 'quality', available: true, metered: false },
  { key: 'ai.code_review_lecture', title: '代码评审讲稿', group: 'dev', available: true, metered: false },
];

/** kind → card_key 显式映射：仅收录与卡片**一对一**的通道；通用通道（ask/ask-json/stream）不在表内，防 kind 冒充卡维度 */
export const KIND_TO_CARD: Readonly<Record<string, string>> = Object.freeze({
  organize: 'ai.organize',
  summary: 'ai.task_summary',
  optimize: 'ai.title_optimize',
  beautify: 'ai.title_beautify',
  polish: 'ai.text_polish',
  simplify: 'ai.title_simplify',
  classify: 'ai.category_classify',
  'plan-evaluate': 'ai.plan_evaluate',
});

/** 注册表中「可用」的卡（G-2 分母口径） */
export function availableCards(): AiCard[] {
  return AI_CARDS.filter((c) => c.available);
}

/** key 是否已注册（写入点校验用：未注册 key 落库前应拒绝或标 unknown，不静默造新维度） */
export function isRegisteredCardKey(key: string): boolean {
  return AI_CARDS.some((c) => c.key === key);
}
