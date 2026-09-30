/**
 * T00959：PRD 管理与需求跟踪矩阵的导出构建器（服务端合成文件，客户端只负责触发下载）。
 *
 * 为什么放服务端：docx/pdf/xlsx 依赖（docx / pdfkit / exceljs）都在 Node 侧，且中文字体只能用系统字体
 * （PDF 用 C:/Windows/Fonts/simhei.ttf，与报表构建器同口径），浏览器端无法保证一致效果。
 * 本模块只做「数据 → 文件 Buffer」的纯计算，不含 DB 访问与路由编排。
 */
import { existsSync } from 'node:fs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';

/** 与报表构建器同口径的中文字体（Windows 环境下用于 PDF 渲染） */
const PDF_FONT = 'C:/Windows/Fonts/simhei.ttf';

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

/**
 * Markdown → Word（.docx）。
 * 支持：标题、无序/有序列表、表格、代码块（等宽段落）、引用、普通段落；按 xlsx-trae 同族版式做浅表头。
 */
export async function buildPrdDocx(md: string, title: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: `导出时间：${new Date().toLocaleString('zh-CN')}`, spacing: { after: 200 } }),
  ];
  const lines = (md ?? '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) { i += 1; continue; }
    // 代码块：原样保留，等宽字体
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1; // 跳过闭合围栏
      for (const c of code) children.push(new Paragraph({ children: [new TextRun({ text: c || ' ', font: 'Consolas' })] }));
      continue;
    }
    const lvl = headingLevel(line);
    if (lvl >= 1) {
      children.push(new Paragraph({ text: plainInline(line.replace(/^#{1,6}\s+/, '')), heading: HEADING_BY_LEVEL[lvl - 1] }));
      i += 1;
      continue;
    }
    // 表格：表头 + 分隔行 + 数据行
    if (line.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
      const head = splitRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { body.push(splitRow(lines[i].trim())); i += 1; }
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: head.map((h) => new TableCell({
              shading: { fill: 'EAF2FF' },
              children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
            })),
          }),
          ...body.map((r) => new TableRow({
            children: head.map((_, ci) => new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: r[ci] ?? '' })] })],
            })),
          })),
        ],
      }));
      continue;
    }
    if (/^>\s?/.test(line)) {
      children.push(new Paragraph({ text: plainInline(line.replace(/^>\s?/, '')), indent: { left: 360 } }));
      i += 1;
      continue;
    }
    const list = /^\s*(?:[-*+]|\d+[.、)])\s+(.+)$/.exec(line);
    if (list) {
      children.push(new Paragraph({ text: plainInline(list[1]), bullet: { level: 0 } }));
      i += 1;
      continue;
    }
    children.push(new Paragraph({ text: plainInline(line), spacing: { after: 80 } }));
    i += 1;
  }
  const doc = new Document({ sections: [{ children }] });
  return await Packer.toBuffer(doc);
}

/**
 * Markdown → PDF（.pdf）：pdfkit 逐块渲染（标题分级字号、列表加项目符号、分页自动）。
 * 中文依赖系统黑体；非 Windows 或无该字体时回退默认字体（英文可读，中文可能显示为方框，属已知限制）。
 */
export async function buildPrdPdf(md: string, title: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  if (process.platform === 'win32' && existsSync(PDF_FONT)) doc.font(PDF_FONT);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  doc.fontSize(18).text(title);
  doc.fontSize(9).text(`导出时间：${new Date().toLocaleString('zh-CN')}`).moveDown(0.6);
  const lines = (md ?? '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { doc.moveDown(0.3); i += 1; continue; }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      doc.fontSize(9).text(code.join('\n'));
      doc.moveDown(0.4);
      continue;
    }
    const lvl = headingLevel(line);
    if (lvl >= 1) {
      doc.moveDown(0.25).fontSize(Math.max(11, 17 - lvl * 1.5)).text(plainInline(line.replace(/^#{1,6}\s+/, '')), { underline: lvl === 1 }).moveDown(0.2);
      i += 1;
      continue;
    }
    if (line.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
      const head = splitRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { body.push(splitRow(lines[i].trim())); i += 1; }
      doc.moveDown(0.2).fontSize(10).text(head.join(' | '), { underline: true });
      for (const r of body) doc.fontSize(9).text(r.join(' | '));
      doc.moveDown(0.3);
      continue;
    }
    const list = /^\s*(?:[-*+]|\d+[.、)])\s+(.+)$/.exec(line);
    if (list) { doc.fontSize(10).text(`• ${plainInline(list[1])}`); i += 1; continue; }
    doc.fontSize(10).text(plainInline(line));
    i += 1;
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
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
  const HEAD_FILL = 'EAF2FF';
  const ZEBRA_FILL = 'F7F9FC';
  const THIN = { style: 'thin', color: { argb: 'D9DEE7' } } as const;
  ws.columns = MATRIX_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const hr = ws.getRow(1);
  hr.font = { bold: true };
  hr.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    c.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  });
  rows.forEach((r, i) => {
    const row = ws.addRow({ ...r });
    row.eachCell((c) => { c.border = { top: THIN, left: THIN, bottom: THIN, right: THIN }; });
    if (i % 2 === 1) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } }; });
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // 首行补充项目与统计信息，便于导出件单独流转时仍有上下文
  ws.insertRow(1, [`项目：${projectName}`, `需求 ${rows.length} 条`, `导出时间：${new Date().toLocaleString('zh-CN')}`]);
  ws.getRow(1).font = { bold: true };
  const hr2 = ws.getRow(2);
  hr2.font = { bold: true };
  hr2.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    c.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  });
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}
