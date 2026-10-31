/**
 * T03730：HTML 版 PRD（Confluence 导出 / 内部 Wiki / 浏览器另存网页）→ 层级 Markdown 文本。
 *
 * 只做「结构搬运」，不做字段映射：标题 → `#`、列表 → 缩进项目符号、表格 → 单元格以「 | 」分隔、
 * 段落 → 行，产出与 .md/.docx 同口径的层级文本，交给既有 AI 解析管线（PlanService.aiParsePrd）
 * 与既有计划数据模型对接——语义拆分仍由提示词完成，避免把字段映射假设硬编码进解析器。
 *
 * 零新增依赖：不引入 cheerio / jsdom，用带容错的单遍扫描器。
 * 容错范围——标签不闭合、大小写混写、属性裸值/单双引号混用、正文里出现裸 `<` 都能过。
 * 无法转成文本的片段（iframe / svg / canvas / 无 alt 图片等）一律计入 warnings 明确告知，
 * 绝不静默丢弃（T03730 约束⑤）。
 */

/** 空元素：不产生块，也不等待闭合标签 */
const VOID_TAGS = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'embed', 'frame', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 从不承载可读正文的元素：内容整体跳过并计入 warnings */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed',
  'canvas', 'video', 'audio', 'picture', 'map', 'select', 'option', 'button',
]);

/** 块级边界：遇到即结束当前文本块（本行文本以段落形式落地） */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'figure', 'figcaption', 'form', 'fieldset', 'address', 'blockquote', 'details',
  'summary', 'center', 'dir', 'menu', 'hgroup', 'body', 'html',
]);

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** 常见命名实体：只收 PRD 里真正会出现的，未命中的保留原样（宁可留字面量，也不猜） */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷',
  deg: '°', plusmn: '±', sect: '§', para: '¶', yen: '¥', euro: '€', pound: '£',
  le: '≤', ge: '≥', ne: '≠',
};

export interface HtmlDocStats {
  blocks: number;
  headings: number;
  listItems: number;
  tableRows: number;
  skipped: number;
}

export interface HtmlDocResult {
  markdown: string;
  /** 无法转为正文的片段 / 结构缺失提示——调用方必须原样透出给用户（约束⑤） */
  warnings: string[];
  stats: HtmlDocStats;
}

export interface HtmlDocOptions {
  /** 段落数上限（防超大网页把内存/提示词撑爆）；超出部分截断并给出 warning */
  maxBlocks?: number;
}

/** 单次标签段的最大长度：超过视为正文里的裸 `<`（不是标签），按文本保留 */
const MAX_TAG_SEGMENT = 4096;

interface Cursor {
  kind: 'heading' | 'para' | 'li';
  level: number;
  marker: string;
  depth: number;
  indent: string;
  text: string;
}

interface TableState {
  rows: string[][];
  row: string[];
  cell: string | null;
}

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replaceAll(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (dec) {
      const code = Number(dec);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const key = (name ?? '').toLowerCase();
    return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : whole;
  });
}

/** 行内空白归一：换行/多空格/nbsp 全部折成单个空格（`<br>` 产生的换行由调用方先切分） */
function squeeze(raw: string): string {
  return raw.replaceAll(/\s+/g, ' ').trim();
}

/** 段落文本：按 `<br>` 留下的换行切行，逐行归一，丢空行 */
function paragraphLines(raw: string): string[] {
  return raw.split('\n').map((s) => squeeze(s)).filter(Boolean);
}

function attrValue(seg: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(seg);
  if (!m) return '';
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim();
}

/**
 * HTML → 层级 Markdown。纯函数（无 I/O、无全局状态），便于脚本级断言。
 * 提取不到正文时抛错（错误文案带诊断信息与可操作建议），而不是返回空串让下游 AI 空转。
 */
export function htmlToMarkdown(input: string, opts: HtmlDocOptions = {}): HtmlDocResult {
  const maxBlocks = opts.maxBlocks ?? 8000;
  const warnings: string[] = [];

  let html = input.replace(/^\uFEFF/, '');

  // 1) 先取文档标题（Confluence/Wiki 导出的页面名通常只在 <title> 里）
  const titleRaw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? '';
  const pageTitle = squeeze(decodeEntities(titleRaw)).replace(/\s*[-|–]\s*Confluence\s*$/i, '');

  // 2) 清掉注释/doctype/CDATA，以及 <head>（含 meta/link/内联样式，标题已单独取出）
  html = html
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replaceAll(/<![^>]*>/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?(?=<body\b)/i, ' ');

  // 3) 跳过量的记账（成对/未闭合的跳过都在下面单遍扫描的 skip 模式里完成——
  //    不用 `<(a|b)>[\s\S]*?</\1>` 这类回溯正则整篇预扫，避免超大页面上的平方级耗时）
  const skipKinds = new Map<string, number>();
  let skipped = 0;

  const blocks: string[] = [];
  const listLines: string[] = [];
  let headings = 0;
  let listItems = 0;
  let tableRows = 0;
  let imgNoAlt = 0;

  let cur: Cursor | null = null;
  let lists: Array<{ ordered: boolean; counter: number }> = [];
  let table: TableState | null = null;
  let pre = false;
  let preBuf = '';
  let skipName: string | null = null;
  let skipDepth = 0;
  let anchorHref = '';
  let anchorLen = 0;

  const bufferLen = () => (table?.cell !== null && table?.cell !== undefined ? table.cell.length : (cur?.text.length ?? 0));

  const flushList = () => {
    if (listLines.length === 0) return;
    blocks.push(listLines.join('\n'));
    listLines.length = 0;
  };

  const pushBlock = (s: string) => {
    if (!s.trim()) return;
    flushList();
    blocks.push(s);
  };

  const emitCur = () => {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (c.kind === 'li') {
      const text = squeeze(c.text);
      if (!text) return;
      listLines.push(`${'  '.repeat(c.depth)}${c.marker}${text}`);
      listItems++;
      return;
    }
    if (c.kind === 'heading') {
      const text = squeeze(c.text);
      if (!text) return;
      pushBlock(`${'#'.repeat(Math.min(6, c.level))} ${text}`);
      headings++;
      return;
    }
    const lines = paragraphLines(c.text).map((l) => c.indent + l);
    if (lines.length === 0) return;
    // <dd> 的说明文字紧跟其 <dt> 条目，不能因为空行被拆成另一段
    if (c.indent && listLines.length > 0) {
      listLines.push(...lines);
      return;
    }
    pushBlock(lines.join('\n'));
  };

  const endCell = () => {
    if (!table || table.cell === null) return;
    table.row.push(squeeze(table.cell));
    table.cell = null;
  };

  const emitTable = () => {
    if (!table) return;
    endCell();
    if (table.row.length > 0) table.rows.push(table.row);
    const t = table;
    table = null;
    // 表格首行通常是表头：统一按「单元格 | 单元格」输出，AI 能从列语义识别（与 Excel 导入同一口径）
    const lines = t.rows
      .filter((r) => r.some((c) => c !== ''))
      .map((r) => r.join(' | ').replace(/[\s|]+$/, ''));
    if (lines.length === 0) return;
    tableRows += lines.length;
    pushBlock(lines.join('\n'));
  };

  const endBlock = () => {
    if (pre) return;
    emitCur();
  };

  const addText = (raw: string) => {
    if (!raw || skipName) return;
    const text = decodeEntities(raw);
    if (pre) {
      preBuf += text;
      return;
    }
    if (table && table.cell !== null) {
      table.cell += text;
      return;
    }
    if (table) return; // 表格行/单元格之间的空白不属于正文
    if (!cur) cur = { kind: 'para', level: 0, marker: '', depth: 0, indent: '', text: '' };
    cur.text += text;
  };

  const openTag = (name: string, seg: string, selfClosing: boolean) => {
    if (HEADING_LEVEL[name]) {
      endBlock();
      cur = { kind: 'heading', level: HEADING_LEVEL[name], marker: '', depth: 0, indent: '', text: '' };
      return;
    }
    if (name === 'ul' || name === 'ol') {
      endBlock();
      lists.push({ ordered: name === 'ol', counter: 0 });
      return;
    }
    if (name === 'li') {
      endBlock();
      const top = lists.at(-1);
      if (top) {
        top.counter++;
        cur = { kind: 'li', level: 0, marker: top.ordered ? `${top.counter}. ` : '- ', depth: Math.max(0, lists.length - 1), indent: '', text: '' };
      } else {
        // 裸 <li>（没有 ul/ol 包裹）：按一级无序列表兜底
        cur = { kind: 'li', level: 0, marker: '- ', depth: 0, indent: '', text: '' };
      }
      return;
    }
    if (name === 'dl') {
      endBlock();
      lists.push({ ordered: false, counter: 0 });
      return;
    }
    if (name === 'dt') {
      endBlock();
      cur = { kind: 'li', level: 0, marker: '- ', depth: Math.max(0, lists.length - 1), indent: '', text: '' };
      return;
    }
    if (name === 'dd') {
      endBlock();
      cur = { kind: 'para', level: 0, marker: '', depth: 0, indent: '  '.repeat(Math.max(1, lists.length)), text: '' };
      return;
    }
    if (name === 'table') {
      endBlock();
      table = { rows: [], row: [], cell: null };
      return;
    }
    if (name === 'tr' || name === 'thead' || name === 'tbody' || name === 'tfoot') {
      if (!table) return;
      endCell();
      if (table.row.length > 0) table.rows.push(table.row);
      table.row = [];
      return;
    }
    if (name === 'td' || name === 'th') {
      if (!table) return;
      endCell();
      table.cell = '';
      return;
    }
    if (name === 'pre') {
      endBlock();
      pre = true;
      preBuf = '';
      return;
    }
    if (name === 'a') {
      anchorHref = attrValue(seg, 'href');
      anchorLen = bufferLen();
      return;
    }
    if (selfClosing) return;
    if (BLOCK_TAGS.has(name)) {
      endBlock();
      return;
    }
  };

  const closeTag = (name: string) => {
    if (HEADING_LEVEL[name] || name === 'li' || name === 'dt') {
      endBlock();
      return;
    }
    if (name === 'dd') {
      endBlock();
      return;
    }
    if (name === 'ul' || name === 'ol' || name === 'dl') {
      endBlock();
      lists.pop();
      return;
    }
    if (name === 'table') {
      endBlock();
      emitTable();
      return;
    }
    if (name === 'tr' || name === 'thead' || name === 'tbody' || name === 'tfoot' || name === 'td' || name === 'th') {
      if (name === 'td' || name === 'th') {
        endCell();
        return;
      }
      if (!table) return;
      endCell();
      if (table.row.length > 0) table.rows.push(table.row);
      table.row = [];
      return;
    }
    if (name === 'pre') {
      pre = false;
      const lines = preBuf.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));
      if (lines.some((l) => l.trim())) pushBlock(lines.join('\n').trim());
      preBuf = '';
      return;
    }
    if (name === 'a') {
      // 图标链接/纯锚点没有可见文字：把 href 写进正文，避免链接整条消失
      if (anchorHref && bufferLen() === anchorLen) addText(`[链接：${anchorHref}]`);
      anchorHref = '';
      return;
    }
    if (BLOCK_TAGS.has(name)) {
      endBlock();
    }
  };

  const voidTag = (name: string, seg: string) => {
    if (SKIP_TAGS.has(name)) {
      skipKinds.set(name, (skipKinds.get(name) ?? 0) + 1);
      skipped++;
      return;
    }
    if (name === 'br') {
      if (pre) preBuf += '\n';
      else if (table && table.cell !== null) table.cell += ' ';
      else if (cur) cur.text += '\n';
      else addText(' ');
      return;
    }
    if (name === 'hr') {
      endBlock();
      pushBlock('---');
      return;
    }
    if (name === 'img') {
      // 表单输入框/脚本等内容不承载需求正文；图片说明（alt）是正文信息，必须保留
      const alt = attrValue(seg, 'alt');
      if (alt) addText(`[图片：${alt}]`);
      else imgNoAlt++;
    }
  };

  // 4) 单遍扫描：`<` 之后找最近的 `>`；找不到或标签段超长 → 当正文里的裸 `<` 保留
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      addText(html.slice(lt));
      break;
    }
    const seg = html.slice(lt + 1, gt);
    i = gt + 1;
    if (seg.length > MAX_TAG_SEGMENT) {
      addText(html.slice(lt, gt + 1));
      continue;
    }
    // 标签名必须紧贴 `<`：`a < b` 这类正文比较式不会被误判成标签
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(seg);
    if (!m) {
      addText(html.slice(lt, gt + 1));
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosing = seg.trimEnd().endsWith('/');

    if (pre && name !== 'pre' && name !== 'br') continue;

    if (skipName) {
      if (name === skipName) {
        if (closing) {
          skipDepth--;
          if (skipDepth <= 0) skipName = null;
        } else if (!selfClosing) {
          skipDepth++;
        }
      }
      continue;
    }
    if (!closing && SKIP_TAGS.has(name)) {
      skipKinds.set(name, (skipKinds.get(name) ?? 0) + 1);
      skipped++;
      if (!selfClosing && !VOID_TAGS.has(name)) {
        skipName = name;
        skipDepth = 1;
      }
      continue;
    }
    if (VOID_TAGS.has(name)) {
      voidTag(name, seg);
      continue;
    }
    if (closing) closeTag(name);
    else openTag(name, seg, selfClosing);
  }

  // 5) 收尾：未闭合的块/列表/表格/折叠块一律按已收集内容落地（容错：不因缺标签丢内容）
  if (pre && preBuf.trim()) pushBlock(preBuf.split(/\r?\n/).map((l) => l.trimEnd()).join('\n').trim());
  endBlock();
  flushList();
  emitTable();

  if (imgNoAlt > 0) {
    warnings.push(`有 ${imgNoAlt} 处图片缺少替代文本（alt），未写入正文；若图片承载需求信息，请在原文档补 alt 或改用含文字的版本（PDF/Markdown）。`);
  }
  if (skipped > 0) {
    const detail = [...skipKinds.entries()].map(([k, v]) => `<${k}>×${v}`).join('、');
    warnings.push(`已跳过 ${skipped} 处非正文元素（${detail}）——脚本、样式、图表、内嵌页面与表单控件不会进入解析；如其中含正文，请改用 PDF/Markdown 或手动补充。`);
  }
  if (headings === 0 && blocks.length > 0) {
    warnings.push('未识别到任何标题层级（h1-h6），已按段落输出——若原文档的章节层级丢失，请在导入预览里手工调整 WBS 层级。');
  }
  if (blocks.length > maxBlocks) {
    const dropped = blocks.length - maxBlocks;
    blocks.length = maxBlocks;
    warnings.push(`HTML 正文超过 ${maxBlocks} 段，已截断尾部 ${dropped} 段；建议拆分为多份文档分别导入，避免需求被漏拆。`);
  }

  const body = blocks.join('\n\n').replaceAll(/\n{3,}/g, '\n\n').trim();
  const firstHeading = blocks.find((b) => b.startsWith('# '))?.slice(2).trim() ?? '';
  const head = pageTitle && pageTitle !== firstHeading ? `# ${pageTitle}\n\n` : '';
  const markdown = (head + body).trim();

  const stats: HtmlDocStats = { blocks: blocks.length, headings, listItems, tableRows, skipped };
  // 空判定只看正文块，不看 <title>：否则「标题很长、body 空」的 JS 渲染空壳页会被当成有正文
  if (blocks.length === 0 || body.length < 20) {
    throw new Error(
      `HTML 未提取到可读正文（可识别文本 ${body.length} 字，跳过非正文元素 ${skipped} 处）。`
      + '常见原因：正文由 JavaScript 动态渲染（保存下来的 body 为空）、文件只是导航/框架页，或内容全部在图片/图表里。'
      + '请在浏览器中确认正文已完整显示后再另存（或导出 PDF / Markdown），也可直接粘贴正文手动导入。',
    );
  }
  return { markdown, warnings, stats };
}

/**
 * 按 <meta charset> / <meta http-equiv="Content-Type"> 解码 HTML 字节流。
 * 国内 Wiki/老系统导出的 GBK 页面直接按 UTF-8 解会整页乱码（AI 拆出来就是垃圾），
 * 因此先读宿主编码声明再解码；声明缺失或解码器不可用时回退 UTF-8。
 */
export function decodeHtmlBuffer(buffer: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  } catch {
    text = buffer.toString('utf-8');
  }
  const head = text.slice(0, 4096);
  const declared = /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(head)?.[1]
    ?? /<meta[^>]+content\s*=\s*["'][^"']*charset=([a-zA-Z0-9_-]+)/i.exec(head)?.[1]
    ?? '';
  const label = declared.toLowerCase();
  if (!label || /^utf-?8$/.test(label)) return text;
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return text;
  }
}
