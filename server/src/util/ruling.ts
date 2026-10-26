/**
 * T02949（方案 A）：派生单「是否需要人工裁决」的识别与候选选项抽取。
 *
 * 为什么不把规则写进 TaskService：同一判定要供三处复用——①回传结论时自动打标
 * ②启动时补标历史派生单 ③面板/MCP 取动态选项。三处各写一份规则必然漂移，且没法直接喂样本验。
 *
 * 判定只读结论文本、不猜业务：**命中明确的裁决请求短语**才算「需要裁决」。
 * 候选词（方案 A / 方案 B …）只用来生成面板选项，不单独作为判定依据——
 * 历史结论里「方案 A 已落地」是事实陈述，按候选词判会把大量已收口单误挂成待裁决。
 */

/** 通用回落选项（语义贴合「AI 派生待办结论如何处置」）：结论里抽不出候选时才用它 */
export const RULING_DEFAULT_OPTIONS = ['采纳合并', '部分采纳', '暂不采纳', '需补充信息'];

/**
 * 明确的「请用户裁决」请求短语。
 * 刻意收窄：宁可漏标（用户仍可点徽标/自定义），也不把普通叙述挂成待裁决；
 * 只有「请选择/二选一/待定」这类祈使或被动态才算请求。
 */
const ASK_PATTERNS: RegExp[] = [
  /待裁决/,
  /请裁决/,
  /需裁决/,
  /需要你(?:来)?裁决/,
  /待你裁/,
  /请你裁/,
  /请裁定/,
  /待你定/,
  /请你定/,
  /需要你(?:来)?决定/,
  /请你决定/,
  /请你选择/,
  /请选择(?:方案|一种|其中|以下)/,
  /二选一/,
  /择一/,
  /待确认方案/,
  /需(?:你)?确认方案/,
  /请确认方案/,
  /方案待定/,
  /待定方案/,
];

/**
 * 候选：`方案 A` / `方案A（按 PRD 补齐）` / `选项一` / `方式 B`。
 * 标识位必须紧跟字母/数字/中文数字——这样「实施方案」「解决方案」不会被当候选。
 */
const CANDIDATE_RES: RegExp[] = [
  /方案\s*(?:[A-Za-z]|\d+|[一二三四五六七八九十]+)(?:（[^）]{1,16}）|\([^)]{1,16}\))?/g,
  /选项\s*(?:[A-Za-z]|\d+|[一二三四五六七八九十]+)(?:（[^）]{1,16}）|\([^)]{1,16}\))?/g,
  /方式\s*(?:[A-Za-z]|\d+|[一二三四五六七八九十]+)(?:（[^）]{1,16}）|\([^)]{1,16}\))?/g,
];

/** 从结论文本抽候选（保持出现顺序、去重、最多 4 个；括号内的短标签保留，太长则不保留） */
export function rulingCandidates(text: string): string[] {
  const src = String(text ?? '');
  const out: string[] = [];
  for (const re of CANDIDATE_RES) {
    for (const m of src.matchAll(re)) {
      // 归一空白与全/半角括号：同一候选在「方案 A」「方案A」两种写法下只留一条
      const label = m[0].replace(/\s+/g, '').replace(/\(/g, '（').replace(/\)/g, '）');
      if (!out.includes(label)) out.push(label);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

export interface RulingDetection {
  needed: boolean;
  /** 命中的请求短语或判定依据（写进 task_events 供审计；needed=false 时为空） */
  reason: string;
  /** 候选选项；不足 2 条时调用方应回落到 `RULING_DEFAULT_OPTIONS` */
  options: string[];
}

/**
 * 找第一条「非否定语境」的请求短语。
 * 为什么要做否定守卫：结论里常见的「**无需**裁决」「不必裁决」会把 `/需裁决/` 误命中，
 * 结果是把一张已经自行收口的单挂成待裁决——比漏标更难排查。
 */
function askHit(src: string): string {
  for (const re of ASK_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of src.matchAll(g)) {
      const at = m.index ?? 0;
      const before = src.slice(Math.max(0, at - 4), at);
      // 只判「紧邻否定」：无需/不需/不用/不必，或单独一个「不/无」收在短语前
      if (/(无需|不需|不用|不必|毋需|不|无)$/.test(before)) continue;
      return m[0];
    }
  }
  return '';
}

/**
 * `strict`：历史补标用。只认明确请求短语，不启用「多候选 + 动作词」这条较宽的规则——
 * 旧单的结论常叙述「方案 A/B 的取舍已定」，按宽规则补标会凭空制造待裁决。
 */
export function detectRuling(text: string, opts: { strict?: boolean } = {}): RulingDetection {
  const src = String(text ?? '');
  const hit = askHit(src);
  const options = rulingCandidates(src);
  const byCandidates = !opts.strict && options.length >= 2 && /裁决|选择|确认|决定|裁定/.test(src);
  return {
    needed: Boolean(hit) || byCandidates,
    reason: hit ? `命中请求短语「${hit}」` : byCandidates ? `含多候选（${options.join(' / ')}）且出现裁决动作词` : '',
    options,
  };
}
