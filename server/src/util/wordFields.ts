/**
 * T00814：Word 域代码（field code）噪声清理。
 *
 * 背景：不少 docx（Word/WPS 导出）把「目录」「页码」「交叉引用」保存成**域代码文本**，
 * 解压 document.xml 后取到的就是形如：
 *   `HYPERLINK \l _Toc18264 1. 基本情况 PAGEREF _Toc18264 \h 1`
 * 这类行既不是需求内容，也不好读——实测某 70KB 需求文档 3582 字符正文里，域代码命中共 60 处，
 * 且「检索增强」的关键词提取把这批域标识符当成了代码检索词
 * （控制台出现 `[HYPERLINK, _Toc18264, PAGEREF, ...]` 这种毫无信息量的关键词），
 * 导致注入的代码片段与需求无关，还白白占用上下文预算。
 *
 * 这里提供两个能力：① 清洗正文里的域代码片段；② 判定某个 token 是否属于域标识符（供关键词提取排除）。
 */

/** Word 域指令关键字（不区分大小写）：出现这些词的标识符一律视为域代码而非业务词 */
const FIELD_KEYWORDS = [
  'HYPERLINK', 'PAGEREF', 'TOC', 'MERGEFORMAT', 'STYLEREF', 'NUMPAGES', 'PAGES', 'SEQ',
  'AUTOTEXT', 'AUTONUM', 'REF', 'NOTEREF', 'INCLUDEPICTURE', 'INCLUDETEXT', 'DATE', 'TIME',
  'FILENAME', 'DOCPROPERTY', 'FORMTEXT', 'XE', 'TC', 'RD', 'ASK', 'FILLIN', 'QUOTE', 'SET', 'IF',
] as const;

/** 域生成的书签/锚点标识符：`_Toc123`（目录）、`_Hlk123`（超链接锚）、`_Ref123`（交叉引用）等 */
const FIELD_BOOKMARK_RE = /^_(?:Toc|Hlk|Ref|GoBack|Toc\d+)\d*$/i;

/** 域指令开关参数（`\l` `\h` `\o` `\*` 等）——单独出现时也是噪声 */
const FIELD_SWITCH_RE = /^\\[*a-z]+$/i;

/** 该 token 是否属于 Word 域代码标识符（关键词提取直接排除） */
export function isWordFieldToken(token: string): boolean {
  const t = token.trim();
  if (!t) return true;
  if (FIELD_SWITCH_RE.test(t)) return true;
  if (FIELD_BOOKMARK_RE.test(t)) return true;
  if (t.startsWith('_') && /\d{2,}/.test(t)) return true; // _Toc18264 / _Hlk6028721 之类
  const upper = t.toUpperCase();
  if ((FIELD_KEYWORDS as readonly string[]).includes(upper)) return true;
  // 形如 TOC1 / REF2 的编号变体
  const m = /^([A-Za-z]+)\d*$/.exec(upper);
  return !!m && (FIELD_KEYWORDS as readonly string[]).includes(m[1]);
}

/**
 * 清洗一段文本中的域代码：
 * - 整行仅由域代码 + 编号/页码构成（目录行）→ 整行删除；
 * - 行内混排（如「HYPERLINK \l _Toc1 标题 PAGEREF _Toc1 \h 3」）→ 剔除域指令片段，保留可读文字；
 * - 收尾折叠多余空白，避免留下空行垃圾。
 */
export function stripWordFieldCodes(text: string): string {
  if (!text) return '';
  const kept: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw;
    if (/HYPERLINK|PAGEREF|MERGEFORMAT|_Toc\d/i.test(line)) {
      // 目录行的典型形态：域指令 + 标题 + 域指令 + 页码；只保留中间的标题文字
      line = line
        // PAGEREF _Toc123 \h 12 → 连开关与页码一起剔除
        .replaceAll(/PAGEREF\s+\S+\s*(?:\\[*a-z]+\s*)*(?:\d+)?/gi, ' ')
        // HYPERLINK "锚点" / HYPERLINK \l _Toc123 → 剔除指令本体，保留其后的可读标题
        .replaceAll(/HYPERLINK\s+(?:"[^"]*"|\S+)?\s*(?:\\[*a-z]+\s*)*/gi, ' ')
        .replaceAll(/\\[*a-z]+/gi, ' ')
        .replaceAll(/\bMERGEFORMAT\b/gi, ' ')
        .replaceAll(/_Toc\d+/gi, ' ')
        .replaceAll(/\s{2,}/g, ' ')
        .trim();
    }
    const t = line.trim();
    // 清洗后为空、或只剩页码（如「1」「12.」）视为无内容行
    if (!t || /^\d+\.?$/.test(t)) continue;
    kept.push(t);
  }
  return kept.join('\n');
}
