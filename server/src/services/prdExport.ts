/**
 * T00959：PRD 管理与需求跟踪矩阵的导出构建器（服务端合成文件，客户端只负责触发下载）。
 *
 * 为什么放服务端：docx/pdf/xlsx 依赖（docx / pdfkit / exceljs）都在 Node 侧，且中文字体只能用系统字体
 * （PDF 用 C:/Windows/Fonts/simhei.ttf，与报表构建器同口径），浏览器端无法保证一致效果。
 * 本模块只做「数据 → 文件 Buffer」的纯计算，不含 DB 访问与路由编排。
 */
import { existsSync } from 'node:fs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import { DOCX_HEAD_SHADING, paintDataRow, paintHeaderRow } from '../util/exportStyle'; // T01487：规范 A 版式单源

/** 与报表构建器同口径的中文字体（Windows 环境下用于 PDF 渲染） */
const PDF_FONT = 'C:/Windows/Fonts/simhei.ttf';

/** 图表标题占位高度（12pt 字号 + 行距）：整块换页判定按「标题 + 图体 + 轴标签」总高算 */
const TITLE_H = 18;

/** 去除 Markdown 行内标记（加粗/行内代码/链接），保留可读文字 */
function plainInline(text: string): string {
  return text
    .replaceAll(/`([^`]+)`/g, '$1')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/** 判断是否为 Markdown 表格分隔行（| --- | --- |） */
function isTableSep(line: string): boolean {
  return /^\|?[\s|:-]+\|?$/.test(line) && line.includes('-');
}

/** 拆分 Markdown 表格行（去掉首尾竖线，按 | 切分） */
function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => plainInline(c.trim()));
}

/** 标题层级：# → 1，## → 2，最多 6 级 */
function headingLevel(line: string): number {
  const m = /^(#{1,6})\s+/.exec(line);
  return m ? m[1].length : 0;
}

const HEADING_BY_LEVEL = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
] as const;

// ---------- M6-6.1：Markdown 两遍式解析（docx/pdf 渲染共用，替代各自的行循环） ----------

type MdBlock =
  | { k: 'heading'; level: number; text: string }
  | { k: 'code'; code: string }
  | { k: 'table'; head: string[]; body: string[][] }
  | { k: 'quote'; text: string }
  | { k: 'list'; text: string }
  | { k: 'space' }
  | { k: 'para'; text: string };

/** 从 i 行开始解析一个 Markdown 块；空行返回 space 块（pdf 渲染为 moveDown 间距，docx 跳过） */
function parseMdBlockAt(lines: string[], i: number): { block: MdBlock; next: number } {
  const line = lines[i].trimEnd();
  if (!line.trim()) return { block: { k: 'space' }, next: i + 1 };
  if (/^\s*```/.test(line)) {
    const code: string[] = [];
    let j = i + 1;
    while (j < lines.length && !/^\s*```/.test(lines[j])) { code.push(lines[j]); j += 1; }
    j += 1; // 跳过闭合围栏
    return { block: { k: 'code', code: code.join('\n') }, next: j };
  }
  const lvl = headingLevel(line);
  if (lvl >= 1) return { block: { k: 'heading', level: lvl, text: plainInline(line.replace(/^#{1,6}\s+/, '')) }, next: i + 1 };
  if (line.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
    const head = splitRow(line);
    let j = i + 2;
    const body: string[][] = [];
    while (j < lines.length && lines[j].trim().startsWith('|')) { body.push(splitRow(lines[j].trim())); j += 1; }
    return { block: { k: 'table', head, body }, next: j };
  }
  if (/^>\s?/.test(line)) return { block: { k: 'quote', text: plainInline(line.replace(/^>\s?/, '')) }, next: i + 1 };
  const list = /^\s*(?:[-*+]|\d+[.、)])\s+(.+)$/.exec(line);
  if (list) return { block: { k: 'list', text: plainInline(list[1]) }, next: i + 1 };
  return { block: { k: 'para', text: plainInline(line) }, next: i + 1 };
}

/** Markdown → 块列表（供 docx/pdf 渲染共用） */
export function parseMdBlocks(md: string): MdBlock[] {
  const lines = (md ?? '').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const r = parseMdBlockAt(lines, i);
    blocks.push(r.block);
    i = r.next;
  }
  return blocks;
}

/** docx 表格块构建（提取自 buildPrdDocx） */
function mdTable(b: Extract<MdBlock, { k: 'table' }>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: b.head.map((h) => new TableCell({
          shading: { fill: DOCX_HEAD_SHADING },
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
        })),
      }),
      ...b.body.map((r) => new TableRow({
        children: b.head.map((_, ci) => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: r[ci] ?? '' })] })],
        })),
      })),
    ],
  });
}

/**
 * Markdown → Word（.docx）。
 * 支持：标题、无序/有序列表、表格、代码块（等宽段落）、引用、普通段落；按 xlsx-trae 同族版式做浅表头。
 * M6-6.1：行循环改两遍式（parseMdBlocks → 块渲染），认知复杂度自 25 降至阈值内。
 */
export async function buildPrdDocx(md: string, title: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: `导出时间：${new Date().toLocaleString('zh-CN')}`, spacing: { after: 200 } }),
  ];
  for (const b of parseMdBlocks(md)) {
    if (b.k === 'heading') children.push(new Paragraph({ text: b.text, heading: HEADING_BY_LEVEL[b.level - 1] }));
    else if (b.k === 'code') for (const c of b.code.split('\n')) children.push(new Paragraph({ children: [new TextRun({ text: c || ' ', font: 'Consolas' })] }));
    else if (b.k === 'table') children.push(mdTable(b));
    else if (b.k === 'quote') children.push(new Paragraph({ text: b.text, indent: { left: 360 } }));
    else if (b.k === 'list') children.push(new Paragraph({ text: b.text, bullet: { level: 0 } }));
    else if (b.k === 'para') children.push(new Paragraph({ text: b.text, spacing: { after: 80 } }));
  }
  const doc = new Document({ sections: [{ children }] });
  return await Packer.toBuffer(doc);
}

// ---------- M6-6.1：Markdown → PDF（pdfkit 逐块渲染，含真实表格 + 柱状图） ----------
type PDFDoc = PDFKit.PDFDocument;

/**
 * 创建 A4 PDF 文档并写入大标题与导出时间；返回 doc、结束事件与取字节回调。
 * 抽成公共入口，让 PRD 与估算 PDF 走同一条「建文档 → 渲染块 → 追加图表 → 收尾」链路。
 */
async function newPdfDocImpl(title: string): Promise<{ doc: PDFDoc; done: Promise<void>; finish: () => Buffer }> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc: PDFDoc = new PDFDocument({ size: 'A4', margin: 50 });
  if (process.platform === 'win32' && existsSync(PDF_FONT)) doc.font(PDF_FONT);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  doc.fontSize(18).text(title);
  doc.fontSize(9).text(`导出时间：${new Date().toLocaleString('zh-CN')}`).moveDown(0.6);
  return { doc, done, finish: () => Buffer.concat(chunks) };
}

/** 计算每列宽度：按内容自然宽度比例摊满可用宽度（过宽则压缩触发单元格换行，不再用 ` | ` 拼接） */
function computeColWidths(doc: PDFDoc, head: string[], body: string[][], pageWidth: number): number[] {
  const pad = 4;
  doc.fontSize(9); // 测量统一按 9pt（与单元格渲染同字号），widthOfString 读当前字号
  const natural = head.map((_, i) => {
    const wHead = doc.widthOfString(head[i] || ' ');
    const wBody = body.reduce((m, r) => Math.max(m, doc.widthOfString(r[i] || ' ')), 0);
    return Math.max(wHead, wBody) + pad * 2;
  });
  const sum = natural.reduce((a, b) => a + b, 0) || 1;
  const scale = pageWidth / sum;
  const clamped = natural.map((w) => Math.max(28, w * scale));
  // 28pt 下限会把窄列顶宽：直接返回会让各列之和超过页宽，最后一列画到页外（横向截断）。
  // 故按实际和再归一一次，保证总宽恒等于可用页宽。
  const total = clamped.reduce((a, b) => a + b, 0);
  return clamped.map((w) => (w * pageWidth) / total);
}

/**
 * 真实表格渲染（T02155 修复点）：列宽自适应 + 黑灰边框 + 表头浅底 + 单元格自动换行。
 * 替代原 `head.join(' | ')` / `r.join(' | ')` 的纯文本拼接——那会留下可见 `|` 分隔符（格式符裸露）
 * 且没有任何列对齐（表格错位）。
 */
function drawTable(doc: PDFDoc, head: string[], body: string[][]): void {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const top = doc.page.margins.top;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const pad = 4;
  const lineH = 12;
  const colW = computeColWidths(doc, head, body, pageWidth);
  const cellLines = (cells: string[]): number => {
    let lines = 1;
    cells.forEach((c, i) => {
      const h = doc.heightOfString(c || ' ', { width: colW[i] - pad * 2 });
      lines = Math.max(lines, Math.ceil(h / lineH));
    });
    return lines * lineH + pad * 2;
  };
  doc.x = doc.page.margins.left;
  let y = doc.y;
  const drawRow = (cells: string[], isHead: boolean) => {
    const h = cellLines(cells);
    if (y + h > bottom) { doc.addPage(); y = top; doc.x = doc.page.margins.left; }
    const x0 = doc.page.margins.left;
    doc.rect(x0, y, pageWidth, h).fill(isHead ? '#e8eef7' : '#ffffff');
    let x = x0;
    cells.forEach((c, i) => {
      doc.fontSize(9).fillColor('#222222').text(c || '', x + pad, y + pad, { width: colW[i] - pad * 2, height: h - pad * 2, ellipsis: true });
      x += colW[i];
    });
    doc.y = y + h; doc.x = x0; // 绝对定位后复位指针，避免 cell 文本的占位推进污染后续行
    x = x0;
    cells.forEach((_, i) => { doc.rect(x, y, colW[i], h).stroke(); x += colW[i]; });
    y += h;
  };
  drawRow(head, true);
  for (const r of body) drawRow(r, false);
  doc.y = y + 6;
  doc.x = doc.page.margins.left;
}

/**
 * 图表整块换页判定（T02155 截断修复的根因处）：pdfkit 的 `rect/moveTo/lineTo` 是绝对坐标绘制，
 * 越过页底**不会**自动分页，只有 `text()` 会——于是柱体被页底裁掉、数值标签却跑到下一页，
 * 出现「一根柱子 + 下一页孤零零一个数」。图表必须先按「标题 + 图体 + 轴标签」总高判定留位。
 */
function ensureChartSpace(doc: PDFDoc, need: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + need > bottom) doc.addPage();
  doc.x = doc.page.margins.left;
}

/**
 * 简单柱状图（T02155 图表补全）：items.value 映射为柱高，柱顶标数值、柱底标类别。
 * 供估算 PDF 绘制「各阶段人天 / 占比」等数据图。
 */
function drawBarChartImpl(doc: PDFDoc, title: string, items: Array<{ label: string; value: number }>): void {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const chartH = 150;
  const labelH = 30;
  ensureChartSpace(doc, TITLE_H + chartH + labelH);
  doc.fontSize(12).fillColor('#08409C').text(title);
  doc.moveDown(0.2);
  const baseY = doc.y + chartH;
  const n = items.length;
  const gap = 18;
  const barW = (pageWidth - gap * (n + 1)) / n;
  const max = Math.max(...items.map((i) => i.value), 1e-6);
  doc.moveTo(doc.page.margins.left, baseY).lineTo(doc.page.margins.left + pageWidth, baseY).stroke();
  let x = doc.page.margins.left + gap;
  for (const it of items) {
    const h = (it.value / max) * (chartH - 18);
    const yTop = baseY - h;
    doc.rect(x, yTop, barW, h).fill('#0059E9');
    doc.fontSize(8).fillColor('#222222').text(String(Math.round(it.value * 100) / 100), x, yTop - 10, { width: barW, align: 'center' });
    doc.fontSize(8).fillColor('#444444').text(it.label, x, baseY + 4, { width: barW, align: 'center', height: 24 });
    x += barW + gap;
  }
  doc.y = baseY + labelH;
  doc.x = doc.page.margins.left;
}

/**
 * 帕累托图（E11，T02155 补全）：柱=单行 E（按同批最大 E 归一，行间可比），折线=累计占比
 * （基数取全批之和，与面板 `paretoGeometries` 同一口径），并画 80% 参考线。
 * 行多时只画调用方传入的前 N 行（标题已按页宽截断），累计折线仍覆盖到页尾。
 */
export function drawParetoChart(
  doc: PDFDoc,
  title: string,
  items: Array<{ label: string; value: number; cumPct: number }>,
): void {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const chartH = 150;
  const labelH = 34;
  ensureChartSpace(doc, TITLE_H + chartH + labelH);
  doc.fontSize(12).fillColor('#08409C').text(title);
  doc.moveDown(0.2);
  const left = doc.page.margins.left;
  const baseY = doc.y + chartH;
  const n = items.length;
  const gap = 8;
  const barW = (pageWidth - gap * (n + 1)) / n;
  const maxE = Math.max(...items.map((i) => i.value), 1e-6);
  doc.moveTo(left, baseY).lineTo(left + pageWidth, baseY).stroke();
  // 80% 累计参考线（虚线）：帕累托的读图锚点，没有它就只剩一串柱子
  const y80 = baseY - 0.8 * chartH;
  doc.lineWidth(0.6).dash(3, { space: 3 })
    .moveTo(left, y80).lineTo(left + pageWidth, y80).stroke()
    .undash().lineWidth(1);
  let x = left + gap;
  let prev: [number, number] | null = null;
  for (const it of items) {
    const h = (it.value / maxE) * (chartH - 18);
    doc.rect(x, baseY - h, barW, h).fill('#9CC3F5');
    const cx = x + barW / 2;
    const cy = baseY - (Math.min(100, Math.max(0, it.cumPct)) / 100) * chartH;
    if (prev) doc.strokeColor('#08409C').moveTo(prev[0], prev[1]).lineTo(cx, cy).stroke();
    doc.circle(cx, cy, 2).fill('#08409C');
    doc.fontSize(7).fillColor('#08409C').text(`${Math.round(it.cumPct)}%`, cx - barW / 2, cy - 12, { width: barW, align: 'center' });
    doc.fontSize(7).fillColor('#444444').text(it.label, x, baseY + 4, { width: barW, align: 'center', height: 28, ellipsis: true });
    prev = [cx, cy];
    x += barW + gap;
  }
  doc.fontSize(8).fillColor('#666666').text('柱=单行最终估算值（同批最大归一） · 折线=累计占比 · 虚线=80%', left, baseY + labelH - 4);
  doc.y = baseY + labelH + 10;
  doc.x = left;
}

/**
 * 龙卷风图（E14 敏感性，T02155 补全）：横向条按 σ 降序，条长 = σ ÷ 同批最大 σ，条尾标 σ 值。
 * 与面板 `tornadoGeometries` 同口径（σ 唯一来源是引擎逐行 sigma）。σ 属内部依据，
 * **客户版不得调用**（§6.2 四项无条件脱敏之一）。
 */
export function drawTornadoChart(
  doc: PDFDoc,
  title: string,
  items: Array<{ label: string; sigma: number; pct: number }>,
): void {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const labelW = 130;
  const rowH = 16;
  const chartH = items.length * rowH + 14;
  ensureChartSpace(doc, TITLE_H + chartH + 14);
  const left = doc.page.margins.left;
  doc.fontSize(12).fillColor('#08409C').text(title);
  doc.moveDown(0.2);
  let y = doc.y + 4;
  const barMax = pageWidth - labelW - 46;
  for (const it of items) {
    doc.fontSize(8).fillColor('#444444').text(it.label, left, y + 2, { width: labelW - 6, ellipsis: true });
    const w = Math.max(1, (Math.min(100, Math.max(0, it.pct)) / 100) * barMax);
    doc.rect(left + labelW, y, w, rowH - 6).fill('#0059E9');
    doc.fontSize(8).fillColor('#222222').text(numSigma(it.sigma), left + labelW + w + 4, y + 2, { width: 42 });
    y += rowH;
  }
  doc.y = y + 6;
  doc.x = left;
}

/** σ 读数：保留两位并去尾零，0.50 → 0.5 */
function numSigma(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Markdown → PDF 块渲染（标题/列表/引用/段落 + 真实表格），PRD 与估算 PDF 共用 */
export function renderMdPdf(doc: PDFDoc, md: string): void {
  doc.x = doc.page.margins.left;
  for (const b of parseMdBlocks(md)) {
    if (b.k === 'heading') doc.moveDown(0.25).fontSize(Math.max(11, 17 - b.level * 1.5)).fillColor('#08409C').text(b.text, { underline: b.level === 1 }).fillColor('#222222').moveDown(0.2);
    else if (b.k === 'code') { doc.fontSize(9).fillColor('#333333').text(b.code); doc.moveDown(0.4); }
    else if (b.k === 'table') drawTable(doc, b.head, b.body);
    else if (b.k === 'quote') doc.fontSize(10).fillColor('#666666').text(plainInline(b.text), { indent: 20 }).fillColor('#222222').moveDown(0.2);
    else if (b.k === 'list') doc.fontSize(10).fillColor('#222222').text(`• ${b.text}`);
    else if (b.k === 'space') doc.moveDown(0.3);
    else { doc.fontSize(10).fillColor('#222222').text(b.text); }
  }
}

/** 柱状图绘制（导出供估算 PDF 绘制各阶段人天/占比图） */
export function drawBarChart(doc: PDFDoc, title: string, items: Array<{ label: string; value: number }>): void {
  drawBarChartImpl(doc, title, items);
}

/** 创建空白 PDF 文档（标题 + 导出时间），供估算 PDF 在 MD 渲染后追加图表 */
export async function newPdfDoc(title: string): Promise<{ doc: PDFDoc; done: Promise<void>; finish: () => Buffer }> {
  return await newPdfDocImpl(title);
}

export async function buildPrdPdf(md: string, title: string): Promise<Buffer> {
  const { doc, done, finish } = await newPdfDoc(title);
  renderMdPdf(doc, md);
  doc.end();
  await done;
  return finish();
}

/** 需求跟踪矩阵行列定义（导出与前端展示同序，避免导出列与界面不一致） */
export const MATRIX_COLUMNS = [
  { header: '需求编号', key: 'reqNo', width: 14 },
  { header: '需求标题', key: 'title', width: 42 },
  { header: '需求内容', key: 'content', width: 46 },
  { header: '优先级', key: 'priority', width: 10 },
  { header: '状态', key: 'status', width: 10 },
  { header: '来源', key: 'source', width: 22 },
  { header: '关联 PRD', key: 'prdDoc', width: 26 },
  { header: '关联计划', key: 'plans', width: 32 },
  { header: '关联待办', key: 'tasks', width: 32 },
] as const;

/** 导出用的矩阵行（不含 id 等内部字段） */
export interface MatrixExportRow {
  reqNo: string;
  title: string;
  content: string;
  priority: string;
  status: string;
  source: string;
  prdDoc: string;
  plans: string;
  tasks: string;
}

/** 需求跟踪矩阵 → Excel（.xlsx）：浅色表头 + 细边框 + 斑马纹，与 xlsx-trae 规范一致 */
export async function buildMatrixXlsx(rows: MatrixExportRow[], projectName: string): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('需求跟踪矩阵');
  ws.columns = MATRIX_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  paintHeaderRow(ws.getRow(1));
  rows.forEach((r, i) => {
    paintDataRow(ws.addRow({ ...r }), i % 2 === 1);
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // 首行补充项目与统计信息，便于导出件单独流转时仍有上下文
  ws.insertRow(1, [`项目：${projectName}`, `需求 ${rows.length} 条`, `导出时间：${new Date().toLocaleString('zh-CN')}`]);
  ws.getRow(1).font = { bold: true };
  paintHeaderRow(ws.getRow(2)); // insertRow 把原表头挤到第 2 行，样式要重新刷一遍
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}
