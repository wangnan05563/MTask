/**
 * T02949（方案 A）：派生单「是否需要人工裁决」的识别与候选选项抽取。
 *
 * 为什么不把规则写进 TaskService：同一判定要供三处复用——①回传结论时自动打标
 * ②启动时补标历史单 ③面板/MCP 取动态选项。三处各写一份规则必然漂移，且没法直接喂样本验。
 *
 * 判定输入是**三个面**，不只是结论文本（T02949 复验 2026-10-26 的教训）：
 *  - 标题徽标：现场大量单把裁决请求写在标题里（`【待裁决 A/B/C】…`、`【…等 T02734 裁决】…`），
 *    其中相当一部分**连结论都还没回传**（handle_result 空）。只读 handle_result 的旧口径
 *    对这些单永远不响，用户点名的 T02974 / T02963 / T02947 全在这一类里漏掉。
 *  - 结论文本：命中明确的裁决请求短语才算「需要裁决」，候选词本身不单独作数——
 *    历史结论里「按裁定 A 落地」「裁决：保留 X」是陈述，按候选词判会把已收口单误挂成待裁决。
 *  - 描述：只用来识别派生单（首行「来源：Txxxx」），不参与请求判定（描述里全是背景叙述）。
 */

/** 通用回落选项（语义贴合「AI 派生待办的结论如何处置」）：结论里抽不出候选时才用它 */
export const RULING_DEFAULT_OPTIONS = ['采纳合并', '部分采纳', '暂不采纳', '需补充信息'];

/** 判定输入：允许只传结论文本（字符串）以兼容「只看结论」的调用与历史用例 */
export interface RulingInput {
  title?: string | null;
  description?: string | null;
  handleResult?: string | null;
  /** 派生来源（tasks.derived_from）；无来源但标题带裁决徽标的单同样可裁决，见 isRulingSubject */
  derivedFrom?: string | null;
}

/**
 * 明确的「请用户裁决」请求短语。
 * 刻意收窄：宁可漏标（用户仍可自定义提交），也不把普通叙述挂成待裁决。
 * 每条都带「向谁请求」的指向（你/用户/需求方/产品/人工）或祈使语气，
 * 单纯出现「裁决」「裁定」不算——否则「已按裁决 A 落地」「业务裁决已落实」这类陈述会全被挂上。
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
  // ↓ T02949 复验补：现场请求写法比预设的短句式更松散（T02974「等你一句话裁决」「A/B/C 我按你裁决执行」）
  /等(?:待)?(?:你|用户|需求方|产品)(?:的)?(?:一?句话)?(?:裁决|裁定|定夺|拍板|决定|确认)/,
  /按你(?:的)?(?:裁决|裁定|决定|拍板)/,
  /(?:交由|交给|留给|返给)(?:你|用户|需求方|产品)(?:的)?(?:裁决|裁定|决定|拍板|选择)/,
  /选择权留给(?:你|用户|需求方|产品)/,
  /[待需请由等](?:你|用户|需求方|产品|人工)(?:来)?(?:裁决|裁定|定夺|拍板|决定|选择|确认)/,
  /需(?:先)?[给等请](?:产品|需求方|用户|人工)(?:的)?(?:裁决|裁定|决策|拍板)/,
  /[还尚]需[^，。；;]{0,12}(?:决策|裁决|拍板|定夺|确认)/,
  /供(?:你|用户|需求方)(?:裁决|选择|决策|定夺)/,
  /请(?:你)?明确(?:一句)?/,
];

/** 命中点前的否定/已然词：紧贴短语即视为「不是请求」 */
const NEG_BEFORE = /(无需|不需|不用|不必|毋需|未|不|无|已|经|按|依|照|循|沿用|既往|既有|既定)$/;
/**
 * 命中点前的条件/常态修饰：紧贴即说明这句是「叙述」不是「请求」。
 * 现场误标样本（2026-10-26 生产副本复演）：
 *  「若需人工确认页面观感，可在下一次 UI 巡检时顺带看」——条件式观察提示；
 *  「不写 thumbnailMode——偏好仍由用户决定」——说明设计取向，没有向谁请求裁决；
 *  「T02661 的口径仍需产品裁决，本单未改…」——转述**另一张单**在等人裁决，本单已自行取舍。
 * 只判「紧邻」：`覆盖风险仍在，提交由用户决定` 中间有逗号隔断，仍是本单在等人定，不能被挡。
 */
const NARR_BEFORE = /([若如或仍凡])$/;
/** 命中点后的完成态：短语之后 8 字内出现这些词，说明裁决已经下过 */
const DONE_AFTER = /^\s{0,8}[已即将]?(?:落地|落实|定案|执行|确定|完成|采纳|通过|回复|拍板|决定)/;
/**
 * 括注/小标题/引号式陈述：「（需求方裁决）：上述三页面统一为法人全辖」「裁决：保留 X」是已下结论；
 * 「冲突行标「需人工确认」并给原因」是被引用的界面文案标签；
 * 「陈旧暂存态「需人工裁决」——裁决对象已自然消失」是回传标题里对被撤销口径的引述。
 */
const PAREN_AFTER = /^\s*[）】：:」』”’]/;
const PAREN_BEFORE = /（$|【$/;

/**
 * 候选：`方案 A` / `方案A（按 PRD 补齐）` / `选项一` / `方式 B`。
 * 标识位必须紧跟字母/数字/中文数字——这样「实施方案」「解决方案」不会被当候选。
 */
const CANDIDATE_RES: RegExp[] = [
  /方案\s*(?:[A-Za-z]|\d+|[一二三四五六七八九十]+)(?:（[^）]{1,16}）|\([^)]{1,16}\))?/g,
  /选项\s*(?:[A-Za-z]|\d+|[一二三四五六七八九十]+)(?:（[^）]{1,16}）|\([^)]{1,16}\))?/g,
  /方式\s*(?:[A-Za-z]|\d+|[一二三四五六七八九十]+)(?:（[^）]{1,16}）|\([^)]{1,16}\))?/g,
];

/** 标题里的裁决徽标：`【…裁决/裁定/拍板/定夺…】`（「已裁决」是终态标注，不算请求） */
const BADGE_RE = /【([^】]{0,80}?(?:裁决|裁定|定夺|拍板)[^】]{0,80}?)】/;

/** 徽标里的候选：`【待裁决 A全量纳管/B改名+列清单/C先文案后拆单】` → A/B/C 三条 */
const BADGE_LABEL_RE = /^[A-Za-z][\u4e00-\u9fa5A-Za-z0-9+＋\-_/（）()·、，,.\s]{1,24}$/;

export interface RulingDetection {
  needed: boolean;
  /** 命中的请求短语或判定依据（写进 task_events 供审计；needed=false 时为空） */
  reason: string;
  /** 候选选项；不足 2 条时调用方应回落到 `RULING_DEFAULT_OPTIONS` */
  options: string[];
}

function toInput(input: string | RulingInput): { title: string; description: string; handleResult: string; derivedFrom: string } {
  const s: RulingInput = typeof input === 'string' ? { handleResult: input } : input;
  return {
    title: s.title ?? '',
    description: s.description ?? '',
    handleResult: s.handleResult ?? '',
    derivedFrom: s.derivedFrom ?? '',
  };
}

/** 标题裁决徽标原文（不含【】）；非请求徽标返回 '' */
export function rulingBadge(title: string | null | undefined): string {
  const m = BADGE_RE.exec(String(title ?? ''));
  if (!m) return '';
  const inner = m[1].trim();
  if (/已裁决|裁决已(?:定|完成|落)/.test(inner)) return '';
  return inner;
}

/**
 * 可裁决对象：派生单（derived_from 非空 / 描述首行「来源：Txxxx」）或标题自带裁决徽标的单。
 * 为什么放宽：现场 T02963「【待裁决】mode 默认值口径归 API 契约还是 domain」不是字段意义上的派生单
 * （derived_from 为空），但标题已经向用户请求裁决——按旧的「仅派生单」限制，这类单永远标不上，
 * 而它正是用户复验时点名的漏标项之一。
 */
export function isRulingSubject(input: string | RulingInput): boolean {
  const s = toInput(input);
  if (typeof input === 'string') return true; // 纯文本调用方（历史用例）不做范围限制
  return Boolean(s.derivedFrom)
    || /^来源[:：]\s*[Tt]\d+/.test(s.description.trim())
    || /【AI回写待审核】/.test(s.title)
    || Boolean(rulingBadge(s.title));
}

/** 从结论正文抽候选（保持出现顺序、去重、最多 4 个） */
function candidatesFromResult(src: string): string[] {
  const out: string[] = [];
  for (const re of CANDIDATE_RES) {
    for (const m of src.matchAll(re)) {
      // 归一空白与全/半角括号：同一候选在「方案 A」「方案A」两种写法下只留一条
      const label = m[0].replaceAll(/\s+/g, '').replaceAll('(', '（').replaceAll(')', '）');
      if (!out.includes(label)) out.push(label);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

/**
 * 从标题徽标抽候选，优先于结论候选（徽标就是这张单写给用户的选项清单）。
 * 只认 `A…/B…` 这类带标识位的斜杠/顿号分隔串；若每条都只是裸字母（如「待裁决 A/B/C」），
 * 标签里没有可读语义 → 返回空，让面板回落到通用四枚，而不是摆出三个「A」「B」「C」按钮。
 */
export function candidatesFromBadge(badge: string): string[] {
  const inner = badge.replace(/^(?:待裁决|需裁决|请裁决|裁决|裁定|定夺|拍板)[\s:：]*/i, '');
  const parts = inner.split(/[/、]/).map((p) => p.replaceAll(/\s+/g, '')).filter(Boolean);
  const labels = parts.filter((p) => BADGE_LABEL_RE.test(p));
  if (labels.length < 2 || labels.length !== parts.length) return [];
  if (!labels.some((l) => l.length > 2)) return [];
  return labels.slice(0, 4);
}

/**
 * 找第一条「非否定、非已然、非括注」的请求短语。
 * 三层守卫的由来（都是现场样本）：
 *  - 否定：「无需裁决」会被 `/需裁决/` 误命中；
 *  - 已然：「两项业务裁决**已落实**」「按裁定 A 落地」是收口陈述；
 *  - 括注：「决策（需求方裁决）：上述三页面统一为法人全辖」「裁决：保留 X」是已下结论的写法。
 */
function askHit(src: string): string {
  for (const re of ASK_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of src.matchAll(g)) {
      const at = m.index ?? 0;
      const before = src.slice(Math.max(0, at - 4), at);
      const after = src.slice(at + m[0].length, at + m[0].length + 12);
      if (NEG_BEFORE.test(before) || NARR_BEFORE.test(before) || PAREN_BEFORE.test(before)) continue;
      if (DONE_AFTER.test(after) || PAREN_AFTER.test(after)) continue;
      return m[0];
    }
  }
  return '';
}

/**
 * `strict`：历史补标用。只认标题徽标与明确请求短语，不启用「多候选 + 动作词」这条较宽的规则——
 * 旧单的结论常叙述「方案 A/B 的取舍已定」，按宽规则补标会凭空制造待裁决。
 */
export function detectRuling(input: string | RulingInput, opts: { strict?: boolean } = {}): RulingDetection {
  const s = toInput(input);
  const badge = rulingBadge(s.title);
  const hit = askHit(s.handleResult);
  const options = badge ? candidatesFromBadge(badge) : [];
  const resultOptions = options.length ? [] : candidatesFromResult(s.handleResult);
  const picked = options.length ? options : resultOptions;
  const byCandidates = !opts.strict && picked.length >= 2 && /裁决|选择|确认|决定|裁定|拍板|定夺/.test(s.handleResult);
  const needed = Boolean(badge) || Boolean(hit) || byCandidates;
  let reason: string;
  if (badge) {
    reason = `标题徽标请求裁决「${badge}」`;
  } else if (hit) {
    reason = `命中请求短语「${hit}」`;
  } else if (byCandidates) {
    reason = `含多候选（${picked.join(' / ')}）且出现裁决动作词`;
  } else {
    reason = '';
  }
  return { needed, reason, options: picked };
}
