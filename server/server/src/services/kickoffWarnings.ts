/**
 * T05671：启动会稿「版式/降级提示」的用户可读化单源。
 *
 * 背景：builder 逐页产出的 note 是写给维护者看的——「自然高 2.71" → 实排 2.67"」「按 pptxgenjs 截字」
 * 「PRD 文档 028063cd-…」这类内部度量与主键，对用户既不可读也不可行动；8 条平铺在卡片上、
 * 再在溯源行里用「；」拼成一整段，用户分不清「哪条需要管、哪条只是正常分页」。
 *
 * 这里只做三件事，不改任何生成结果：
 *   1. 分级：error（功能缺失）/ warn（真实降级，需要知情）/ info（正常分页或已自动处理）；
 *   2. 归并：同类逐页提示（表格让位压缩）合并成一条，页码进 `pages`；
 *   3. 文案：标题只写用户视角的结果，原始串一律留在 `detail`（折叠区可见）。
 *
 * 兼容纪律：`KickoffStreamResult.warnings: string[]` 的原始串**逐字保留**（既有门 t02103/t02111/t02166
 * 与旧前端都消费它）；本模块只新增 `warningItems`，不替换、不改写 warnings。
 */

export type KickoffWarningLevel = 'error' | 'warn' | 'info';

export interface KickoffWarningItem {
  /** 稳定的分类键，前端据此分组/去重，不参与展示 */
  code: string;
  level: KickoffWarningLevel;
  /** 面向用户的一句话（不含页码前缀与内部度量） */
  title: string;
  /** 原始技术串或逐页明细，默认折叠，排障时才看 */
  detail?: string;
  /** 涉及页（1 基）；非逐页提示不填 */
  pages?: number[];
}

/** 逐页提示的「第 N 页：」前缀——展示文案里去掉，改由 `pages` 承载 */
const PAGE_PREFIX = /^第\s*(\d+)\s*页[：:]\s*/;
/** 标题上限：卡片一行放得下，超出以省略号收尾（详情仍有原文） */
const TITLE_MAX = 60;

function pageNoOf(w: string): number | undefined {
  const m = PAGE_PREFIX.exec(w);
  return m ? Number(m[1]) : undefined;
}

function stripPage(w: string): string {
  return w.replace(PAGE_PREFIX, '').trim();
}

function clamp(s: string): string {
  return s.length <= TITLE_MAX ? s : `${s.slice(0, TITLE_MAX - 1)}…`;
}

/** 单条（非归并类）分类：按顺序首个命中即返回，兜底保留原文而不是吞掉 */
function classifyOne(raw: string): KickoffWarningItem {
  const page = pageNoOf(raw);
  const pages = page === undefined ? undefined : [page];
  const body = stripPage(raw);

  // 输入截断：用户无需行动，但要留「结论未受影响」的定心话；UUID 进 detail
  if (/^PRD 摘要超出\s*\d+\s*字已保头保尾截断/.test(raw)) {
    return {
      code: 'prd-truncated',
      level: 'info',
      title: 'PRD 篇幅较长，摘要已按头尾保留（结论覆盖全部要点）',
      detail: raw,
    };
  }

  // 措辞降级：把「域名 + 超时 + 重试」压成一句人话，原因细分到「未配模型 / 连接超时 / 其它」
  if (/^风险措辞 AI 失败/.test(raw)) {
    const reason = /未配置|not\s*configured/i.test(raw)
      ? '当前工具未配置模型'
      : /timeout|超时|fetch failed|ECONNRESET|ENOTFOUND|network/i.test(raw)
        ? 'AI 连接超时，已自动重试'
        : 'AI 调用未成功';
    return {
      code: 'wording-fallback',
      level: 'warn',
      title: `风险/沟通措辞改用本地条目（${reason}）`,
      detail: raw,
    };
  }

  // 自动重试后通过：结果没问题，属说明级
  if (/已自动重试 1 次后通过/.test(raw)) {
    return {
      code: 'ai-retry',
      level: 'info',
      title: 'AI 首轮输出不合规，已自动重试后通过',
      detail: raw,
    };
  }

  // 表格占满版面、要点整段没排进去——比压缩严重，必须点名并给可操作建议
  if (/要点为本页表格让位，未排入版面/.test(raw)) {
    return {
      code: 'bullets-dropped',
      level: 'warn',
      title: '要点未能排入（版面被表格占满），可拆分该页',
      detail: raw,
      pages,
    };
  }

  // 阶段链只画前 N 个：这是分页设计，不是丢内容
  const chain = /阶段链只承载前\s*(\d+)\s*个里程碑，其余\s*(\d+)\s*个见时间线页/.exec(raw);
  if (chain) {
    return {
      code: 'milestone-paging',
      level: 'info',
      title: `阶段链展示前 ${chain[1]} 个里程碑，其余 ${chain[2]} 个在时间线页完整列出`,
      detail: raw,
      pages,
    };
  }

  const clipStage = /(\d+)\s*个阶段名超出节点宽度/.exec(raw);
  if (clipStage) {
    return {
      code: 'stage-label-clip',
      level: 'info',
      title: `${clipStage[1]} 个阶段名在流程图上缩写，完整名称见里程碑页`,
      detail: raw,
      pages,
    };
  }

  const people = /本页版面只排得下\s*(\d+)\s*个人员标签，其余\s*(\d+)\s*人见分工页/.exec(raw);
  if (people) {
    return {
      code: 'assignee-paging',
      level: 'info',
      title: `人员标签展示前 ${people[1]} 人，其余 ${people[2]} 人见分工页与工作量页`,
      detail: raw,
      pages,
    };
  }

  const chipClip = /(\d+)\s*个标签过长已截断显示/.exec(raw);
  if (chipClip) {
    return {
      code: 'chip-clip',
      level: 'info',
      title: `${chipClip[1]} 个人员标签在图上缩写`,
      detail: raw,
      pages,
    };
  }

  const undated = /(\d+)\s*条计划缺起止日期，条形未绘制/.exec(raw);
  if (undated) {
    return {
      code: 'timeline-undated',
      level: 'warn',
      title: `${undated[1]} 条计划缺起止日期，未画入时间线（补全日期后自动出现）`,
      detail: raw,
      pages,
    };
  }

  const merged = /(\d+)\s*个里程碑与同日里程碑并成一枚菱形绘制/.exec(raw);
  if (merged) {
    return {
      code: 'milestone-merged',
      level: 'info',
      title: `${merged[1]} 个同日里程碑合并为一枚菱形`,
      detail: raw,
      pages,
    };
  }

  if (/数字由系统改写/.test(raw)) {
    return {
      code: 'number-rewrite',
      level: 'warn',
      title: '正文数字与库内不一致，已按库内数据改写',
      detail: raw,
      pages,
    };
  }

  if (/空间不足，已省略/.test(raw)) {
    return {
      code: 'space-drop',
      level: 'warn',
      title: '版面不足少排了一块（内容未丢，可拆分该页）',
      detail: raw,
      pages,
    };
  }

  if (/版式越界.*已降级为「标题 \+ 正文」/.test(raw)) {
    return {
      code: 'layout-degraded',
      level: 'warn',
      title: '版式越界，已降级为「标题 + 正文」安全版式',
      detail: raw,
      pages,
    };
  }

  if (/元素写入失败/.test(raw)) {
    return {
      code: 'write-failed',
      level: 'warn',
      title: '有元素未能写入，已跳过',
      detail: raw,
      pages,
    };
  }

  if (/配色对比度不达标/.test(raw)) {
    return {
      code: 'palette-contrast',
      level: 'warn',
      title: '部分配色对比度偏低',
      detail: raw,
    };
  }

  if (/^HTML 版生成失败/.test(raw)) {
    return {
      code: 'html-failed',
      level: 'error',
      title: 'HTML 版未生成，本次仅提供 PPTX',
      detail: raw,
    };
  }

  // 兜底：不认识的提示一律保留（降级为 warn），绝不静默吞掉——「没提示」不能等于「没问题」
  return { code: 'other', level: 'warn', title: clamp(body), detail: raw, pages };
}

const LEVEL_RANK: Record<KickoffWarningLevel, number> = { error: 0, warn: 1, info: 2 };

/**
 * 分类 + 归并。同一批里所有「表格让位压缩排版」合并为一条（页码升序去重），
 * 其余逐条分类后按 error → warn → info 稳定排序；同级保持原顺序。
 */
export function classifyKickoffWarnings(warnings: readonly string[]): KickoffWarningItem[] {
  const compactPages: number[] = [];
  const compactRaw: string[] = [];
  const rest: KickoffWarningItem[] = [];

  for (const raw of warnings) {
    const w = String(raw ?? '').trim();
    if (!w) continue;
    if (/要点为表格让位压缩排版/.test(w)) {
      compactRaw.push(w);
      const p = pageNoOf(w);
      if (p !== undefined) compactPages.push(p);
      continue;
    }
    rest.push(classifyOne(w));
  }

  if (compactRaw.length > 0) {
    const pages = [...new Set(compactPages)].sort((a, b) => a - b);
    rest.unshift({
      code: 'layout-compact',
      level: 'info',
      title: `${pages.length || compactRaw.length} 页为容纳表格做了紧凑排版，文字完整保留`,
      detail: compactRaw.join('\n'),
      pages: pages.length > 0 ? pages : undefined,
    });
  }

  // Array.prototype.sort 自 ES2019 起稳定：同级保持 builder 的逐页原顺序
  return rest.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

/**
 * 溯源行用的短文案：每条只取 title（已去页码前缀与内部度量），顺序与分级一致。
 * 不省略任何一条——导出稿的「截断/降级」必须如实，只是把长句换成了短句。
 */
export function compactKickoffWarnings(warnings: readonly string[]): string[] {
  return classifyKickoffWarnings(warnings).map((i) => i.title);
}

/** 卡片摘要行用：分级计数与总体语气 */
export interface KickoffWarningSummary {
  total: number;
  errorCount: number;
  warnCount: number;
  infoCount: number;
  /** 摘要行文案：有 error 先说缺口，其次 warn，最后才是纯说明 */
  headline: string;
}

export function summarizeKickoffWarnings(items: readonly KickoffWarningItem[]): KickoffWarningSummary {
  const errorCount = items.filter((i) => i.level === 'error').length;
  const warnCount = items.filter((i) => i.level === 'warn').length;
  const infoCount = items.filter((i) => i.level === 'info').length;
  const total = items.length;
  let headline: string;
  if (errorCount > 0) {
    headline = `${errorCount} 条未能完成${warnCount > 0 ? ` · ${warnCount} 条已降级` : ''}${infoCount > 0 ? ` · ${infoCount} 条排版说明` : ''}`;
  } else if (warnCount > 0) {
    headline = `${warnCount} 条已自动降级处理${infoCount > 0 ? ` · ${infoCount} 条排版说明` : ''}`;
  } else {
    headline = `${infoCount} 条排版/分页说明`;
  }
  return { total, errorCount, warnCount, infoCount, headline };
}
