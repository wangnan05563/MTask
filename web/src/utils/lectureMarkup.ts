/**
 * 讲稿条目切分与三态标记（六期 3.2 / T02873，PRD §6.2「标记/忽略」）。
 *
 * 标记对象是**讲稿里的单条风险/建议**（列表项）。为了让渲染与导出在同一份口径下取条目序号，
 * 切分函数是唯一入口：`splitLectureBlocks` 的 `ordinal` 既拼 DOM 的 `data-lck` 键，也拼导出剔除的键。
 * 忽略条目不进导出稿；会后跟进条目保留在正文，并在导出稿尾部追加「会后跟进清单」节（PRD §6.2）。
 */

export type LectureMark = 'adopt' | 'followup' | 'ignore';
export type LectureMarkMap = Readonly<Record<string, LectureMark>>;

export interface LectureBlock {
  kind: 'item' | 'prose';
  text: string;
  /** 列表项在**本节内**的序号（从 0 起）；prose 恒为 -1 */
  ordinal: number;
}

const ITEM_START = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** 把一节讲稿切成「列表项 / 普通段落」，列表项含其缩进续行 */
export function splitLectureBlocks(text: string): LectureBlock[] {
  const lines = (text ?? '').split('\n');
  const blocks: LectureBlock[] = [];
  let prose: string[] = [];
  let item: string[] | null = null;
  let ordinal = 0;

  const flushProse = () => {
    const joined = prose.join('\n').trim();
    if (joined) blocks.push({ kind: 'prose', text: joined, ordinal: -1 });
    prose = [];
  };
  const flushItem = () => {
    if (item) blocks.push({ kind: 'item', text: item.join('\n').trim(), ordinal: ordinal++ });
    item = null;
  };

  for (const line of lines) {
    if (ITEM_START.test(line)) {
      flushItem();
      flushProse();
      item = [line];
      continue;
    }
    if (item && /^\s+\S/.test(line)) {
      item.push(line);
      continue;
    }
    if (item) {
      flushItem();
    }
    prose.push(line);
  }
  flushItem();
  flushProse();
  return blocks;
}

/** 标记键：节 key + 条目序号（序号由 `splitLectureBlocks` 决定，导出与渲染共用） */
export function lectureMarkKey(sectionKey: string, ordinal: number): string {
  return `${sectionKey}#${ordinal}`;
}

/** 本节里有哪些条目（UI 用来渲染行尾三按钮；prose 不参与标记） */
export function lectureSectionItems(sectionKey: string, text: string): Array<{ ordinal: number; key: string; text: string }> {
  return splitLectureBlocks(text)
    .filter((b) => b.kind === 'item')
    .map((b) => ({ ordinal: b.ordinal, key: lectureMarkKey(sectionKey, b.ordinal), text: b.text }));
}

/** 按标记重建一节正文：忽略项剔除，其余原样（会后跟进保留在正文，另在尾部汇总） */
export function applyMarksToSection(sectionKey: string, text: string, marks: LectureMarkMap): { text: string; ignored: number; followups: string[] } {
  const blocks = splitLectureBlocks(text);
  const kept: string[] = [];
  const followups: string[] = [];
  let ignored = 0;
  for (const b of blocks) {
    if (b.kind === 'prose') { kept.push(b.text); continue; }
    const mark = marks[lectureMarkKey(sectionKey, b.ordinal)] ?? 'adopt';
    if (mark === 'ignore') { ignored += 1; continue; }
    kept.push(b.text);
    if (mark === 'followup') followups.push(b.text);
  }
  return { text: kept.join('\n\n'), ignored, followups };
}

export interface LectureExportSection {
  key: string;
  label: string;
  text: string;
}

/**
 * 导出稿的八段固定骨架（PRD §8 A-2：导出稿必须八段标题齐全）。
 * 服务端可能因分段失败而不返回某一节，导出时仍按此顺序补位，缺节显式写「（本节未生成）」，
 * 避免成稿静默少节、会上无法照稿讲。
 */
export const LECTURE_EXPORT_SECTIONS = [
  { key: 'opening', label: '开场白' },
  { key: 'summary', label: '变更摘要' },
  { key: 'walkthrough', label: '逐项目-逐模块讲解' },
  { key: 'risks', label: '风险清单' },
  { key: 'standards', label: '规范检查' },
  { key: 'improvements', label: '改进建议' },
  { key: 'questions', label: '讨论问题' },
  { key: 'closing', label: '结语' },
] as const;

export interface LectureExportDoc {
  markdown: string;
  ignored: number;
  followups: number;
  followupList: Array<{ section: string; text: string }>;
}

/**
 * 导出稿装配（md 直出；docx/pptx 由服务端按同一份 sections 再排）。
 * 顺序：标题 → 项目 → 各节（忽略项已剔除）→「会后跟进清单」→ 生成时间。
 */
/**
 * 导出前最后一道正文清洗（R7 实测遗留）：
 * 1) 模型在节内自带与本节同名的 H2（如 `## 逐项目-逐模块讲解 — 逐模块讲解`）——导出已有标准 H2，
 *    再留一条会让目录多出一个平级节点；按「等于 label / label + 破折号或冒号后缀」整行删掉。
 * 2) `[#server/x.ts#L1-L2]` 这类锚点首字符 `#` 未去掉、`#L1-#L2` 双井号写法——统一成 [path#L1-L2]。
 * 3) 反斜杠转义（`verify:\<id>`）在 Markdown 里会显示成字面 `\`，去掉多余的一层。
 */
function sanitizeSectionText(text: string, label: string): string {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const isDupHeading = (heading: string): boolean => {
    const h = norm(heading);
    if (!h || !label) return false;
    if (h === norm(label)) return true;
    return /^[—\-:：]/.test(h.slice(norm(label).length)) && h.startsWith(norm(label));
  };
  const out: string[] = [];
  for (const line of (text ?? '').split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (m && isDupHeading(m[2])) continue;
    // 节内不应有 H2：导出自己已经写了 `## label`，模型再写 `## 项目 — 模块` 会与八段平级。
    // 统一降一级（`##`→`###`），既保留小标题又保证目录只有八段。
    if (m && m[1] === '##') { out.push(`### ${m[2]}`); continue; }
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\[#([^\]\s]+)\]/g, '[$1]')
    .replace(/#L(\d+)-#L(\d+)/g, '#L$1-L$2')
    .replace(/\\([<>|`*_{}[\]()#+.!-])/g, '$1')
    .trim();
}

export function assembleLectureExport(input: {
  title: string;
  projectNames: readonly string[];
  sections: readonly LectureExportSection[];
  marks: LectureMarkMap;
  generatedAt: string;
}): LectureExportDoc {
  const body: string[] = [`# ${input.title}`, '', `项目：${input.projectNames.join('、')}`, ''];
  let ignoredCount = 0;
  const followupList: Array<{ section: string; text: string }> = [];
  // 同一 key 可能存在多段（逐模块讲解每模块一段）：合并成节内多段，而不是重复一个 H2 标题
  const grouped = new Map<string, { label: string; texts: string[] }>();
  for (const s of input.sections) {
    const applied = applyMarksToSection(s.key, s.text, input.marks);
    ignoredCount += applied.ignored;
    applied.followups.forEach((text) => followupList.push({ section: s.label, text }));
    const kept = sanitizeSectionText(applied.text, s.label);
    const bucket = grouped.get(s.key);
    if (bucket) {
      if (kept) bucket.texts.push(kept);
    } else {
      grouped.set(s.key, { label: s.label, texts: kept ? [kept] : [] });
    }
  }
  const emitted = new Set<string>();
  for (const meta of LECTURE_EXPORT_SECTIONS) {
    const found = grouped.get(meta.key);
    emitted.add(meta.key);
    const text = (found?.texts ?? []).join('\n\n').trim();
    body.push(`## ${found?.label || meta.label}`, '', text || '（本节未生成）', '');
  }
  // 骨架之外的附加节（如服务端补的「溯源」）按原顺序追加，不吞内容
  for (const [key, value] of grouped) {
    if (emitted.has(key)) continue;
    const text = value.texts.join('\n\n').trim();
    body.push(`## ${value.label}`, '', text || '（本节未生成）', '');
  }
  if (followupList.length > 0) {
    body.push('## 会后跟进清单', '');
    followupList.forEach((f, i) => body.push(`${i + 1}. 【${f.section}】${f.text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')}`));
    body.push('');
  }
  body.push(`> 生成时间：${input.generatedAt}｜已忽略 ${ignoredCount} 条（不出现在本稿）｜会后跟进 ${followupList.length} 条`);
  return { markdown: body.join('\n'), ignored: ignoredCount, followups: followupList.length, followupList };
}

/** 讲稿块的下标（锚点文案用不到，但「从第 n 节继续」需要一个稳定的节序） */
export function sectionIndexByKey(sections: ReadonlyArray<{ key: string }>, key: string): number {
  return sections.findIndex((s) => s.key === key);
}
