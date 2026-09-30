import { stripThinking } from '../util/thinking';

/**
 * T00814：PRD「待确认问题清单」解析（从 PrdGenService 抽出的纯函数模块，便于单测与复用）。
 *
 * 背景：原先只认 `<<<ISSUES>>>` 后的严格 JSON.parse，且正文回退只认精确标题「待确认问题汇总」——
 * 模型稍不守协议（JSON 前后夹带解释、写成 `<ISSUES>`、标题写成「## 八、待确认问题汇总」或改用表格）
 * 就会整条降级，用户侧看到「问题清单 JSON 协议解析失败 / 未解析到待确认问题」并多花一次 AI 调用。
 * 现在改为三级容错：标记后 JSON → 全文任意 JSON 数组 → 正文「待确认问题」节（列表/表格）。
 */

export interface PrdGenIssue { level: string; question: string; context: string; suggestion: string }

const LEVELS = ['blocker', 'suggested', 'info'] as const;

/** 把任意对象数组规整为问题清单（过滤空问题，level 收敛到三档；suggestion 缺失置空串） */
export function normalizeIssues(raw: unknown): PrdGenIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Partial<PrdGenIssue> => !!x && typeof x === 'object')
    .filter((x) => typeof x.question === 'string' && x.question.trim())
    .map((x) => ({
      level: (LEVELS as readonly string[]).includes(String(x.level)) ? String(x.level) : 'info',
      question: String(x.question).trim(),
      context: typeof x.context === 'string' ? x.context.trim() : '',
      suggestion: typeof x.suggestion === 'string' ? x.suggestion.trim() : '',
    }));
}

/**
 * 从文本里逐个「配平扫描」出顶层 JSON 数组并尝试解析。
 *
 * 为什么不能用 `indexOf('[')` + `lastIndexOf(']')`：爱解释的模型常在 JSON 前后夹带说明文字，
 * 甚至给出多个代码块/示例片段，粗略切片会把两段无关内容之间的文字一起塞进 JSON.parse → 必然抛错，
 * 于是整条主流程被判「协议解析失败」而降级（用户看到的正是这条报错）。
 */
export function scanJsonArrays(text: string): unknown[] {
  const out: unknown[] = [];
  // T01361（S2310）：外层改 while 手动推进——解析成功后跳到数组末尾的下一字符（i = j + 1），
  // 其余路径步进 1；与原 for（i = j 后经 i++ 得 j+1）行为完全一致
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '[') { i++; continue; }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let parsed = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            out.push(JSON.parse(text.slice(i, j + 1)));
          } catch { /* 非完整 JSON 片段，继续向后找下一个 '[' */ }
          i = j + 1; // 跳过本次已解析区间
          parsed = true;
          break;
        }
      }
    }
    if (!parsed) i++;
  }
  return out;
}

/** 解析问题清单 JSON：剥思考块与代码围栏，再配平扫描所有数组，取第一个能规整出条目的结果 */
export function parseIssuesJson(text: string): PrdGenIssue[] {
  const cleaned = stripThinking(text).replaceAll(/```[a-zA-Z]*/g, '');
  for (const arr of scanJsonArrays(cleaned)) {
    const issues = normalizeIssues(arr);
    if (issues.length > 0) return issues;
  }
  return [];
}

/** 标题行里含「待确认问题」即视为问题节（容忍「## 八、待确认问题汇总」「### 待确认问题清单」等写法） */
const ISSUE_HEADING_RE = /^\s*#{1,6}[^\n]*待确认问题[^\n]*$/m;

/** 问题清单分隔标记：`<<<ISSUES>>>` 为约定写法，同时容忍 `<ISSUES>` / `<<ISSUES>>` 等变体 */
const ISSUES_MARKER_RE = /<{1,4}\s*ISSUES\s*>{1,4}/i;

/** 表头/占位等无信息量的行，不作为问题条目 */
const SECTION_NOISE_RE = /^(序号|编号|问题|待确认项|说明|备注|结论|风险|无)$/;

/** 表格单元格是否为「序号/纯数字/噪声」——表格通常首列是序号，问题在第二列 */
function isNoiseCell(c: string): boolean {
  return !c || /^\d+$/.test(c) || c.length <= 1 || SECTION_NOISE_RE.test(c);
}

/** 从正文「待确认问题」节里提取条目：支持无序/有序列表与 Markdown 表格行 */
export function issuesFromSection(prdMd: string): PrdGenIssue[] {
  const m = ISSUE_HEADING_RE.exec(prdMd);
  if (!m) return [];
  const rest = prdMd.slice(m.index + m[0].length);
  // 截到下一个标题为止（原实现一路取到文末，会把后续章节也当成问题列表）
  const stop = /^\s*#{1,6}\s/m.exec(rest.slice(1));
  const body = stop ? rest.slice(0, stop.index + 1) : rest;
  const out: PrdGenIssue[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    // 跳过空行与表格分隔行（| --- | --- |）
    if (!t || t.startsWith('---') || /^\|?[\s|:-]+\|?$/.test(t)) continue;
    let q = '';
    let ctx = '';
    if (t.startsWith('|')) {
      // 表格行：逐格取值，跳过序号/表头列，第一个有意义的格当问题、其余作说明
      const cells = t.split('|').map((c) => c.replaceAll('**', '').trim()).filter((c) => !isNoiseCell(c));
      if (cells.length === 0) continue;
      q = cells[0];
      ctx = cells.slice(1).join('；');
    } else {
      q = (/^(?:[-*+]|\d+[.、)])\s*(.+)$/.exec(t)?.[1] ?? '').replaceAll('**', '').trim();
    }
    if (q.length <= 4 || SECTION_NOISE_RE.test(q)) continue;
    out.push({ level: 'info', question: q, context: ctx, suggestion: '' });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 三级容错解析待确认问题清单：
 * ① `<<<ISSUES>>>`（或 `<ISSUES>`）之后的 JSON；
 * ② 全文任意 JSON 数组（元素带 question 字段）；
 * ③ PRD 正文「待确认问题」节的列表/表格条目（level 一律 info，用户可在表格中改）。
 */
export function parsePrdIssues(text: string, prdMd: string, onStage: (msg: string) => void): PrdGenIssue[] {
  const marker = ISSUES_MARKER_RE.exec(text);
  const tail = marker ? text.slice(marker.index + marker[0].length) : text;
  let issues = parseIssuesJson(tail);
  if (issues.length === 0 && marker) {
    // 标记后没拿到有效 JSON：可能 JSON 被写到了标记之前，全量再扫一次
    issues = parseIssuesJson(text);
  }
  if (issues.length > 0) {
    onStage(`已从 AI 输出解析问题清单：${issues.length} 条`);
    return issues;
  }
  issues = issuesFromSection(prdMd);
  if (issues.length > 0) {
    onStage(`AI 未按 JSON 协议输出问题清单，已从 PRD 正文「待确认问题」节提取 ${issues.length} 条（级别默认「提示」，可在表格中改）`);
    return issues;
  }
  return [];
}

/**
 * T00815：解开「整份内容被代码围栏包裹」的输出。
 * 部分模型会把整份 PRD 包进 ```markdown … ```——Markdown 渲染器会把整体当**一个代码块**原样显示，
 * 用户看到的就是原始 #/** 符号（T00815 的直接来源）。识别首行 ``` + 末行 ``` 的整体包裹并解开；
 * 只在「开头和结尾同时是围栏」时生效，正文里局部的代码块不受影响。
 */
export function unwrapTopFence(text: string): string {
  const t = text.trim();
  const open = /^```[\w-]*[ \t]*\n/.exec(t);
  if (!open) return text;
  if (!/```[ \t]*$/.test(t)) return text; // 末尾没有闭合围栏（可能被截断），不动它
  return t.slice(open[0].length).replace(/```[ \t]*$/, '').trim();
}

/** 从完整 AI 输出里切出 PRD 正文：先解开整体围栏 → 去掉问题清单段与 `<<<PRD>>>` 标记（顺序重要：
 *  围栏可能包住含 <<<ISSUES>>> 的全部输出，先切标记会丢失闭合围栏导致解包失败） */
export function splitPrdBody(text: string): string {
  const unwrapped = unwrapTopFence(text);
  const marker = ISSUES_MARKER_RE.exec(unwrapped);
  return (marker ? unwrapped.slice(0, marker.index) : unwrapped)
    .replace(/<{1,4}\s*PRD\s*>{1,4}\s*/i, '')
    .trim();
}

/** T00818：问题清单内联渲染的前置保护——单元格里的管道符/换行会破坏表格结构，替换为占位 */
function escCell(s: string): string {
  return String(s).replaceAll('|', String.raw`\|`).replaceAll('\n', ' ').trim();
}

/** T00818：待确认问题级别 → 中文短标签（与交互表格口径一致，便于正文可直接阅读） */
const LEVEL_LABEL: Record<string, string> = { blocker: '🔴阻塞', suggested: '🟡建议', info: '🟢提示' };

/**
 * T00818：把解析出的问题清单内联回 PRD 正文「待确认问题汇总」章，修复「末章提示后内容为空」。
 * 根因：问题清单按输出协议走 `<<<ISSUES>>>` JSON 单独给出，被 splitPrdBody 剥离；正文该章只有
 * 标题 + 审查说明占位，无清单表格 → 前端预览末章即「提示后为空」。此函数在生成 return 前把
 * 清单以 Markdown 表格写进该章末尾（有该章 → 追加到节内末尾；无该章 → 文末补建该章），不清动原文。
 */
export function inlineIssuesSection(prdMd: string, issues: PrdGenIssue[]): string {
  if (!issues || issues.length === 0) return prdMd;
  const table = [
    '',
    '> 以下问题汇总自三角色审查，需业务方/开发方确认后方可进入开发阶段。',
    '| 级别 | 问题 | AI建议 | 说明 |',
    '|---|---:|---:|---:|',
    ...issues.map((x) => `| ${LEVEL_LABEL[x.level] ?? x.level} | ${escCell(x.question)} | ${escCell(x.suggestion)} | ${escCell(x.context)} |`),
    '',
  ].join('\n');
  const m = ISSUE_HEADING_RE.exec(prdMd);
  if (!m) {
    // 正文未含该章（模型跳写）：在文末补建一章，保证清单有落点
    return `${prdMd.replace(/\n*$/, '')}\n\n## 待确认问题汇总\n${table}\n`;
  }
  // 定位该章标题后、下一个标题前的节内末尾，在节尾追加表格（保留标题与原有提示文字）
  const rest = prdMd.slice(m.index + m[0].length);
  const stop = /^\s*#{1,6}\s/m.exec(rest.slice(1));
  const insertAt = stop ? m.index + m[0].length + stop.index + 1 : prdMd.length;
  return `${prdMd.slice(0, insertAt)}\n${table}${prdMd.slice(insertAt)}`;
}
