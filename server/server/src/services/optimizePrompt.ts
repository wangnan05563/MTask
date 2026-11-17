/**
 * T04808：POST /ai/optimize 的提示词构造（纯函数，从 AIService.optimizeText 抽出便于断言）。
 *
 * 常规输入（标题 + 描述）逐字保持原有 system 要求与 user 结构，任务菜单的既有行为不变；
 * 新增「仅标题」分支：description 为空且 title 非空时，模型收到的唯一输入是【任务标题】，
 * 并追加第 8 条要求，明确标题即待优化的核心意图——避免把同一句标题既当标题又当描述重复投喂，
 * 也避免模型因「没有描述」而输出空泛内容或臆造事实。
 */

export interface OptimizeScope {
  readonly projectName?: string;
  readonly categoryName?: string;
}

export interface OptimizePrompt {
  readonly system: string;
  readonly user: string;
}

/** 原有 7 条要求，逐字保留（回归基线） */
const BASE_REQUIREMENTS = [
  '你是 MTask 的提示词优化专家。给定一个任务的标题与描述，将其优化为一则清晰、具体、结构化、可直接交由大模型或他人执行的任务提示词。',
  '要求：',
  '1. 保留原意与全部关键信息，不虚构不删改事实',
  '2. 明确定义目标、输入、约束、期望输出，缺失的地方基于上下文给出合理推断',
  '3. 使用 Markdown 分节组织，语言贴合原文语境',
  // 显式锁定输出语言：LLM 默认跟随输入语言输出，输入含繁体时会连带输出繁体，必须在指令层面强制简体
  '4. 无论输入是繁体还是简体，最终输出必须统一使用简体中文（简体字），严禁出现任何繁体字',
  '5. 只输出优化后的提示词文本，不要任何前置说明或寒暄',
  '6. 不要输出“任务提示词 / 任务描述 / 任务标题”这类文档级标题作为开头，直接从具体内容小节开始（如“目标”“步骤”“约束”），避免被误识别为提示词优化任务',
  // 归属信息只用于贴合语境，显式禁止扩写，避免模型把项目/分类当成任务内容的一部分
  '7. 【所属项目】【任务分类】仅用于贴合项目语境与用词，不是任务内容，不得据此虚构需求或扩写范围',
];

/** 仅标题输入时追加：告诉模型「标题就是全部输入」，缺失细节只能通用推断，不得虚构 */
const TITLE_ONLY_RULE = '8. 本次仅提供了标题、没有正文描述：标题即待优化的核心意图，请围绕标题推断目标、输入、约束与期望输出，只做通用且合理的推断，不得虚构具体事实、数据或实现细节';

/** 唯一的分支判据：描述为空且标题非空（任务菜单描述恒非空，不会命中） */
export function isTitleOnlyInput(title: string, description: string): boolean {
  return !description.trim() && Boolean(title.trim());
}

export function buildOptimizePrompt(title: string, description: string, scope: OptimizeScope = {}): OptimizePrompt {
  const cleanTitle = title.trim();
  const cleanDescription = description.trim();
  const titleOnly = isTitleOnlyInput(title, description);
  const system = [...BASE_REQUIREMENTS, ...(titleOnly ? [TITLE_ONLY_RULE] : [])].join('\n');
  // 仅标题时 user 只有一行【任务标题】，即「标题作为唯一输入源」；
  // 常规输入保持【任务标题】+【任务描述】两行（外加可选的项目/分类归属事实）。
  const user = [
    scope.projectName ? `【所属项目】${scope.projectName}` : '',
    scope.categoryName ? `【任务分类】${scope.categoryName}` : '',
    cleanTitle ? `【任务标题】${cleanTitle}` : '',
    cleanDescription ? `【任务描述】${cleanDescription}` : '',
  ].filter(Boolean).join('\n');
  return { system, user };
}
