/**
 * 任务契约的唯一解析入口。
 *
 * 之前 `taskContractFor()`（提示词）和 `receiptWarnings()`（质量门）各写一套正则，
 * 任一处新增“给出/提供 3 条”等表达时，另一处不会同步，导致“提示词要求 3 条、
 * 质量门识别 0 条”的规则漂移。这里把解析结果结构化，两个调用方都只读同一份契约。
 */
export interface TaskContract {
  /** 全文非空行上限（含分段标题） */
  lineLimit?: number;
  /** 必须原样使用的分段标题；空数组表示任务没有分段要求 */
  sections: string[];
  /** 条目数量区间（包含端点） */
  countRange?: { min: number; max: number };
  /** 条目数量必须恰好为 N */
  countExact?: number;
  /** “侧重 xxx”的原文 */
  focus?: string;
  /** 每个项目一句话 */
  oneLinePerProject: boolean;
  /** 没有内容必须写本期无/不得凑数 */
  noPadding: boolean;
  /** 避免重复同一事件 */
  avoidDuplicates: boolean;
  /** 任务日期当天口径 */
  sameDay: boolean;
}

export function parseTaskContract(title: string, description: string): TaskContract {
  const text = `${title}\n${description}`;
  const contract: TaskContract = {
    sections: [],
    oneLinePerProject: /每个项目一句话/.test(text),
    noPadding: /没有值得看的内容直接说没有|不要凑数/.test(text),
    avoidDuplicates: /不要重复|避免重复/.test(text),
    sameDay: /当天|今日|今天|每日|当日/.test(text),
  };

  const lineLimit = text.match(/全文\s*(\d+)\s*行以内/);
  if (lineLimit) contract.lineLimit = Number(lineLimit[1]);

  const sectionMatch = text.match(/按((?:[「“][^」”]+[」”][、，,]?)+)分段/);
  if (sectionMatch) {
    contract.sections = [...sectionMatch[1].matchAll(/[「“]([^」”]+)[」”]/g)].map((m) => m[1]);
  }

  const range = text.match(/(\d+)\s*[-~至]\s*(\d+)\s*条/);
  if (range) {
    contract.countRange = { min: Number(range[1]), max: Number(range[2]) };
  } else {
    const exact = text.match(/(?:整理|筛选|输出|列出)\s*(\d+)\s*条/);
    if (exact) contract.countExact = Number(exact[1]);
  }

  const focus = text.match(/侧重\s*([^。；\n]+)/);
  if (focus) contract.focus = focus[1];

  return contract;
}

/** 把结构化契约渲染成提示词规则；渲染顺序与旧版保持一致，避免回执行为漂移。 */
export function taskContractRules(contract: TaskContract): string[] {
  const rules: string[] = [];
  if (contract.lineLimit !== undefined) {
    rules.push(`全文不超过 ${contract.lineLimit} 行（按非空行计数，含分段标题；宁少勿多）。`);
  }
  if (contract.sections.length) {
    rules.push(`必须原样使用以下分段标题逐段输出：${contract.sections.join(' / ')}；某段没有符合条件的内容就写「本期无」，不得改用其他分段名。`);
    if (contract.sections.includes('版本更新')) {
      rules.push('「发布 / 上线 / 新版本 / Introducing / 正式推出」类信息必须放在「版本更新」段，不得归入「其他动态」。');
      rules.push('只要检索结果中存在发布类条目，「版本更新」段就必须逐条列出，不得写「本期无」；「其他动态」不得再重复这些发布类条目。');
    }
    if (contract.sections.includes('新项目')) {
      rules.push('「新项目」段只能列 GitHub 仓库（URL 形如 github.com/owner/repo），不得把协议、博客文章或一般行业动态归入新项目。');
    }
  }
  if (contract.countRange) {
    const { min, max } = contract.countRange;
    rules.push(`条目数量必须在 ${min}–${max} 条之间，不得少于 ${min} 条或多于 ${max} 条。`);
    rules.push(`若高相关条目不足 ${min} 条，必须补入检索结果中同领域、来源可靠的条目并标注相关性较弱；不得因某条官方页面「暂无摘要」就丢弃，少于 ${min} 条即不合格。`);
  } else if (contract.countExact !== undefined) {
    rules.push(`条目数量必须恰好 ${contract.countExact} 条。`);
  }
  if (contract.focus) rules.push(`内容侧重：${contract.focus}；检索结果没有覆盖该方向时明确说明，不得用无关内容代替。`);
  if (contract.oneLinePerProject) rules.push('每个项目只用一句话，依次说清：它做什么、为什么突然火、和我的关系。');
  if (contract.noPadding) rules.push('没有符合条件的内容就直接写「本期无」或说明没有，不得凑数。');
  if (contract.avoidDuplicates) rules.push('避免重复描述同一事件；只从检索结果中挑选不同事件。');
  if (contract.sameDay) rules.push('优先只选任务日期当天的内容；当天不足时，必须逐条标注实际发布日期并说明哪些不是当天，不得把前一日内容写成「今日」。');
  if (rules.length) rules.push('任务描述中的条数、分段、行数、侧重点都是硬约束，不得套用通用 3 条模板。');
  rules.push('数字、日期、公司名、链接必须与【联网检索结果】原文一致；不得换算、四舍五入、放大或缩小数量（例如 thousands 不得写成数万，99 不得写成约 990）。');
  rules.push('来源链接必须整段复制检索结果中的 URL；GitHub 链接的 owner/repo 必须逐字核对，不得改写、缩写或替换仓库名。');
  return rules;
}
