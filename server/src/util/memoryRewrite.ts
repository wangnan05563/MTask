/**
 * T04145（PRD MEM-208 / 规范 §5.1、§8 第五段）：写法校验的**重写限次**。
 *
 * W1–W8 自检不通过时最多重写 1 次，仍不合则丢弃并记 dropped——防「模型反复自改」死循环，
 * 也防把不合格写法直接落进长期记忆。校验用可判定子集（W1/W2/W4/W5/W8）；
 * W3/W6/W7 属语义级，由提示词自检负责，这里不做不可靠的正则猜测。
 */

/** 单次抽取允许的最大重写次数（PRD MEM-208：恰好 1 次） */
export const MAX_REWRITES = 1;

export interface WritingItem { title: string; content: string }

/** 返回命中的违规规则编号；空数组表示写法合格。 */
export function validateWriting(c: WritingItem): string[] {
  const rules: string[] = [];
  const content = String(c.content ?? '').trim();
  // W2 自足：以代词开头，脱离上下文读不懂
  if (/^(它|这|该|其|此|上述|前者|后者)/.test(content)) rules.push('W2');
  // W4 时间锚定：相对时间必须换成基于 now 的绝对日期
  if (/(昨天|今天|明天|上周|下周|上周|近日|最近|刚才|前不久)/.test(content)) rules.push('W4');
  // W5 数值精确：模糊量词不得替代精确数值
  if (/(约\s*\d|大概|几个|左右|差不多|可能是\d)/.test(content)) rules.push('W5');
  // W8 长度有界：中文 30–120 字（按字符数近似）
  if (content.length < 30 || content.length > 120) rules.push('W8');
  // W1 一事一条：多个句末标点通常是多条事实拼在一起
  if ((content.match(/[。；]/g) ?? []).length > 1) rules.push('W1');
  return rules;
}

export interface RewriteViolation<T extends WritingItem> { index: number; item: T; rules: string[] }
export interface Rewritten<T extends WritingItem> { index: number; item: T }

/**
 * 应用重写预算：初次校验 → 违规则调用 rewrite **至多一次** → 二次校验，仍违规进 dropped。
 * rewrite 返回空数组/异常均视为重写失败，违规项照样丢弃，绝不进入下一轮重写。
 */
export async function applyRewriteBudget<T extends WritingItem>(
  items: T[],
  rewrite: (violations: RewriteViolation<T>[]) => Promise<Rewritten<T>[]>,
): Promise<{
  accepted: { item: T; index: number }[];
  dropped: { title: string; reason: string }[];
  rewrites: number;
}> {
  const violations: RewriteViolation<T>[] = [];
  items.forEach((item, index) => {
    const rules = validateWriting(item);
    if (rules.length) violations.push({ index, item, rules });
  });

  let working = items.map((item, index) => ({ item, index }));
  let rewrites = 0;
  if (violations.length && MAX_REWRITES > 0) {
    rewrites = 1;
    let fixed: Rewritten<T>[] = [];
    try { fixed = await rewrite(violations); } catch { /* 重写失败按仍不合格处理 */ }
    const byIndex = new Map<number, T>();
    for (const f of fixed) if (f?.item && Number.isInteger(f.index) && f.index >= 0 && f.index < items.length) {
      byIndex.set(f.index, f.item);
    }
    working = working.map((w) => (byIndex.has(w.index) ? { item: byIndex.get(w.index) as T, index: w.index } : w));
  }

  const accepted: { item: T; index: number }[] = [];
  const dropped: { title: string; reason: string }[] = [];
  for (const w of working) {
    const rules = validateWriting(w.item);
    if (rules.length) dropped.push({
      title: w.item.title ?? '',
      reason: rewrites > 0 ? `W 重写后仍不合格:${rules.join(',')}` : `W 写法不合格:${rules.join(',')}`,
    });
    else accepted.push(w);
  }
  return { accepted, dropped, rewrites };
}
