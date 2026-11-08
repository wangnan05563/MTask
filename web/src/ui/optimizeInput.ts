/**
 * T04808：「提示词优化」按钮的输入源判定单源（提示词菜单 + 通用需求菜单共用）。
 *
 * 此前两处各自判定：提示词页（PromptsPage）早在 T00636 就支持「内容为空回退标题」，
 * 而通用需求页用的 ui/PromptOptimizeButton 把空内容直接当作空输入并把按钮置为 disabled，
 * 于是只填了标题的条目点不动优化，也拿不到任何提示。这里统一口径：
 *  - 正文非空：标题 + 正文都传（保持既有逻辑，仅补首尾空白清洗）；
 *  - 正文为空、标题非空：只传标题，description 置空；服务端据此进入「仅标题」提示词分支，
 *    模型收到的唯一输入就是【任务标题】，不会把同一句话当成标题+描述各读一遍；
 *  - 两者皆空：返回 null，由调用方提示「请输入标题或描述」（不再静默禁用按钮）。
 *
 * 纯函数、零依赖：既能被按钮与页面复用，也便于门脚本对三种验收用例做断言。
 */
export interface OptimizeInput {
  readonly title: string;
  readonly description: string;
  /** 完成 toast 用：本次优化的实际输入来源 */
  readonly source: '内容' | '标题';
}

/** 标题与内容都为空时的统一提示文案（验收用例 3） */
export const OPTIMIZE_EMPTY_MESSAGE = '请输入标题或描述';

export function resolveOptimizeInput(title: string, content: string): OptimizeInput | null {
  const cleanTitle = title.trim();
  const cleanContent = content.trim();
  if (cleanContent) return { title: cleanTitle, description: cleanContent, source: '内容' };
  if (cleanTitle) return { title: cleanTitle, description: '', source: '标题' };
  return null;
}
