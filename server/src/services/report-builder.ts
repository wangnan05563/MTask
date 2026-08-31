/**
 * 报表文件构建器（CPU 密集）：exceljs / docx / pptxgenjs / pdfkit 的工作簿/文档合成。
 * 独立成模块的目的：在 ReportService 主进程之外（worker_threads）执行，避免阻塞 Node 事件循环。
 * 本模块只做「数据 → 文件 Buffer」的纯计算，不含 DB 访问与 IO 编排。
 */
import { existsSync } from 'node:fs';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType,
} from 'docx';
import type { ReportData } from './ReportService';

/** 报表标题行 */
function titleLine(data: ReportData): string {
  return `MTask ${data.periodLabel}（${data.period} · ${data.startDate} ~ ${data.endDate}）`;
}

// ---------- Excel 生成（exceljs） ----------
export async function buildXlsx(data: ReportData, templateBuf?: Buffer, aiInsight?: string): Promise<Buffer> {
  // 模板文件开头包含一个占位表头行结构；生产级实现会精确渲染，这里统一标准版式
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  if (templateBuf) {
    // 用户模板：以模板为基底，保留其原有 sheet，仅新增「报表数据」sheet，满足“参考模板结构生成”
    await wb.xlsx.load(templateBuf as unknown as ArrayBuffer);
  }
  // 标准版式遵循内置 skill xlsx-trae 的规范：浅色表头填充、细浅边框、数据斑马纹、合计加粗强调
  const HEAD_FILL = 'EAF2FF';
  const ZEBRA_FILL = 'F7F9FC';
  const THIN = { style: 'thin', color: { argb: 'D9DEE7' } } as const;
  const fillCell = (c: any, color: string) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; };
  const borderRow = (r: any) => r.eachCell((c: any) => { c.border = { top: THIN, left: THIN, bottom: THIN, right: THIN }; });
  const headerRow = (r: any) => { r.font = { bold: true }; r.eachCell((c: any) => fillCell(c, HEAD_FILL)); borderRow(r); };

  const ws = wb.addWorksheet('报表数据');
  ws.columns = [
    { header: '项目', key: 'project', width: 18 },
    { header: '任务标题', key: 'title', width: 40 },
    { header: '优先级', key: 'priority', width: 8 },
    { header: '状态', key: 'status', width: 10 },
    { header: '已验证', key: 'verified', width: 9 },
    { header: '分类', key: 'category', width: 12 },
    { header: '更新时间', key: 'updatedAt', width: 20 },
  ];
  ws.addRow([]);
  ws.addRow([titleLine(data)]);
  ws.addRow([`生成时间：${data.generatedAt}`]);
  ws.addRow([]);
  headerRow(ws.addRow(['项目', '任务数', '待办', '已完成', '已验证', '高', '中', '低']));
  for (const p of data.projects) {
    const r = ws.addRow([p.name, p.total, p.todo, p.done, p.verified, p.high, p.medium, p.low]);
    r.font = { bold: true };
    borderRow(r);
  }
  ws.addRow([]);
  headerRow(ws.addRow(['项目', '任务标题', '优先级', '状态', '已验证', '分类', '更新时间']));
  let zebra = false;
  for (const t of data.tasks) {
    const r = ws.addRow([t.project, t.title, t.priority, t.status, t.verified ? '是' : '', t.category, t.updatedAt]);
    borderRow(r);
    if (zebra) r.eachCell((c: any) => fillCell(c, ZEBRA_FILL));
    zebra = !zebra;
  }
  // AI 周报：追加「AI 周报洞察」工作表，按内置 skill xlsx-trae 版式将洞察 Markdown 渲染为结构化表格
  if (aiInsight) {
    const ai = wb.addWorksheet('AI 周报洞察');
    ai.columns = [{ header: '内容', key: 'line', width: 60 }];
    addInsightSheet(ai, aiInsight);
  }
  const buf = await wb.xlsx.writeBuffer();
  // exceljs 返回类型含 Buffer/ArrayBuffer 的泛型差异，统一转成内存 Buffer
  return Buffer.from(buf as unknown as ArrayBuffer);
}

/**
 * 将 AI 洞察 Markdown 渲染为结构化 Excel 工作表（遵循内置 skill xlsx-trae 版式）。
 * 识别：# 标题（浅色填充+加粗+阶梯字号）、`|` 表格（表头填充+斑马纹）、`- / * / 1.` 列表（圆点前缀）、
 * `**粗体**` 与 `` `行内码` ``（剥符号保留加粗）。替换此前"逐行原样落格"，使洞察开箱即已排版。
 */
function addInsightSheet(ai: any, insight: string): void {
  const HEAD_FILL = 'EAF2FF';
  const ZEBRA_FILL = 'F7F9FC';
  const THIN = { style: 'thin', color: { argb: 'D9DEE7' } } as const;
  const fill = (c: any, color: string) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; };
  // 剥离 markdown 内联符号：去掉粗体/行内码标记，返回纯文本
  const stripMd = (t: string) => t.replaceAll(/\*\*([^*]+)\*\*/g, '$1').replaceAll(/`([^`]+)`/g, '$1').trim();
  const hasBold = (t: string) => /\*\*/.test(t);
  let r = 1;

  const putLine = (text: string, bold: boolean, size: number, zebra: boolean) => {
    const cell = ai.getCell(r, 1);
    cell.value = text;
    cell.font = { bold, size };
    cell.alignment = { wrapText: true, vertical: 'top' };
    cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
    if (zebra) fill(cell, ZEBRA_FILL);
    r += 1;
  };
  // 标题行：按层级递减字号，浅色填充 + 加粗
  const putHeading = (text: string, level: number) => {
    const cell = ai.getCell(r, 1);
    cell.value = text;
    cell.font = { bold: true, size: 14 - Math.min(level, 3) };
    fill(cell, HEAD_FILL);
    cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
    r += 1;
  };
  // 表格块：首行表头加粗+填充，其余数据斑马纹；缓冲命中即落盘当前块
  const flushTable = (rows: string[][]) => {
    rows.forEach((cells, i) => {
      cells.forEach((v, j) => {
        const col = ai.getColumn(j + 1);
        if (!col.width) col.width = j === 0 ? 40 : 20;
        const cell = ai.getCell(r, j + 1);
        cell.value = v;
        cell.font = { bold: i === 0 };
        cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
        if (i === 0) fill(cell, HEAD_FILL);
        else if (i % 2 === 0) fill(cell, ZEBRA_FILL);
      });
      r += 1;
    });
    r += 1; // 表格块后留空行
  };

  const tableBuf: string[][] = [];
  for (const raw of insight.split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const isTableSep = /^\|[\s:|-]+\|$/.test(line);
    if (/^\|.*\|$/.test(line)) { // 表格数据行
      if (!isTableSep) tableBuf.push(line.split('|').slice(1, -1).map(stripMd));
      continue;
    }
    if (tableBuf.length) { flushTable(tableBuf); tableBuf.length = 0; }
    if (heading) { putHeading(stripMd(heading[2]), heading[1].length); continue; }
    if (!line) { r += 1; continue; }
    const item = line.replace(/^\d+\.\s+/, '').replace(/^[-*]\s+/, '');
    putLine(item ? `\u2022 ${item}` : line, hasBold(raw), 11, false);
  }
  if (tableBuf.length) flushTable(tableBuf);
}

// ---------- Word 生成（docx 库；用户模板用 docxtemplater 占位符渲染） ----------
export async function buildDocx(data: ReportData, templateBuf?: Buffer, aiInsight?: string): Promise<Buffer> {
  if (templateBuf) {
    // 用户 Word 模板：docxtemplater 渲染 {占位符}，模板未含占位符时原样保留
    const PizZip = (await import('pizzip')).default;
    const Docxtemplater = (await import('docxtemplater')).default;
    const zip = new PizZip(templateBuf as unknown as ArrayBuffer);
    const tmpl = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    const ctx: Record<string, unknown> = { ...data };
    tmpl.render(ctx);
    const out = tmpl.getZip().generate({ type: 'nodebuffer' }) as unknown as Buffer;
    return out;
  }

  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: titleLine(data), heading: HeadingLevel.TITLE }),
    new Paragraph({ text: `生成时间：${data.generatedAt}` }),
    new Paragraph(''),
    new Paragraph({ text: '项目汇总', heading: HeadingLevel.HEADING_2 }),
  ];
  if (data.projects.length === 0) {
    children.push(new Paragraph({ text: '本周期无任务活动。' }));
  } else {
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: ['项目', '任务数', '待办', '已完成', '已验证'].map(
              (h) => new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: h, bold: true })] })] }),
            ),
          }),
          ...data.projects.map(
            (p) =>
              new TableRow({
                children: [p.name, String(p.total), String(p.todo), String(p.done), String(p.verified)].map(
                  (v) => new TableCell({ children: [new Paragraph(v)] }),
                ),
              }),
          ),
        ],
      }),
    );
  }
  children.push(
    new Paragraph(''),
    new Paragraph({ text: '任务明细', heading: HeadingLevel.HEADING_2 }),
  );
  if (data.tasks.length === 0) {
    children.push(new Paragraph({ text: '本周期无任务记录。' }));
  } else {
    for (const t of data.tasks) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `[${t.status}/${t.priority}] ${t.title}`, bold: true }),
            new TextRun({ text: `  (${t.project})`, italics: true, color: '7f7f7f' }),
          ],
        }),
        new Paragraph({ children: [new TextRun({ text: t.updatedAt, color: '9ca3af', size: 18 })] }),
      );
    }
  }
  // AI 周报：在任务明细后追加「AI 洞察」章节（逐行段落，空行保留结构）
  if (aiInsight) {
    children.push(
      new Paragraph(''),
      new Paragraph({ text: 'AI 洞察', heading: HeadingLevel.HEADING_2 }),
      ...aiInsight.split('\n').map((line) => new Paragraph(line || ' ')),
    );
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ---------- PPT 生成（pptxgenjs）：遵循内置 skill pptx-trae（该 skill 即以 pptxgenjs 构建演示文稿） ----------
export async function buildPptx(data: ReportData, aiInsight?: string): Promise<Buffer> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 10, height: 5.63 });
  pptx.layout = 'WIDE';
  const s = pptx.addSlide();
  s.addText(`MTask ${data.periodLabel}`, { x: 0.5, y: 0.35, w: 9, h: 0.7, fontSize: 24, bold: true, color: '1F2937' });
  s.addText(`周期：${data.startDate} ~ ${data.endDate}    生成：${data.generatedAt}`, { x: 0.5, y: 1.1, w: 9, h: 0.4, fontSize: 10, color: '6B7280' });

  const header = ['项目', '任务数', '待办', '已完成', '已验证'];
  const body = data.projects.map((p) => [p.name, String(p.total), String(p.todo), String(p.done), String(p.verified)]);
  const rows = data.projects.length ? [header, ...body] : [header, ['本周期无任务活动', '', '', '', '']];
  s.addTable(rows as any, {
    x: 0.5, y: 1.7, w: 9, fontSize: 11,
    border: { type: 'solid', pt: 1, color: 'D9DEE7' },
    fill: { color: 'F7F9FC' },
  });

  if (data.tasks.length) {
    const s2 = pptx.addSlide();
    s2.addText('任务明细', { x: 0.5, y: 0.35, w: 9, h: 0.6, fontSize: 20, bold: true });
    const taskRows = [
      ['项目', '标题', '优先级', '状态', '已验证'],
      ...data.tasks.map((t) => [t.project, t.title, t.priority, t.status, t.verified ? '是' : '']),
    ];
    s2.addTable(taskRows as any, {
      x: 0.4, y: 1.1, w: 9.2, fontSize: 9,
      border: { type: 'solid', pt: 1, color: 'D9DEE7' },
      fill: { color: 'FFFFFF' },
    });
  }
  // AI 周报：追加一页承载洞察正文
  if (aiInsight) {
    const s3 = pptx.addSlide();
    s3.addText('AI 洞察', { x: 0.5, y: 0.35, w: 9, h: 0.6, fontSize: 20, bold: true });
    s3.addText(aiInsight.split('\n').slice(0, 14).join('\n'), { x: 0.5, y: 1.1, w: 9, h: 4, fontSize: 11 });
  }
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(out as unknown as ArrayBuffer);
}

// ---------- PDF 生成（pdfkit）：代理内置 skill pdf-trae（其脚本依赖外部 Python，Node 端以 pdfkit 实现等价输出） ----------
export async function buildPdf(data: ReportData, aiInsight?: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const FONT = 'C:/Windows/Fonts/simhei.ttf';
  if (process.platform === 'win32' && existsSync(FONT)) doc.font(FONT);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  doc.fontSize(18).text(`MTask ${data.periodLabel}（${data.startDate} ~ ${data.endDate}）`);
  doc.fontSize(10).text(`生成时间：${data.generatedAt}\n`);
  doc.fontSize(13).text('项目汇总', { underline: true }).moveDown(0.3);
  if (data.projects.length) {
    data.projects.forEach((p) => {
      doc.fontSize(11).text(`• ${p.name}：共 ${p.total}（待办 ${p.todo} / 完成 ${p.done} / 已验证 ${p.verified}）`);
    });
  } else {
    doc.fontSize(11).text('本周期无任务活动。');
  }
  doc.moveDown(0.5).fontSize(13).text('任务明细', { underline: true }).moveDown(0.3);
  if (data.tasks.length) {
    data.tasks.forEach((t) => {
      doc.fontSize(10).text(`[${t.status} / ${t.priority}] ${t.title}（${t.project}） ${t.updatedAt}`);
    });
  } else {
    doc.fontSize(11).text('本周期无任务记录。');
  }

  // AI 周报：追加洞察段落（保留换行，空行让 PDF 有自然分段）
  if (aiInsight) {
    doc.moveDown(0.6).fontSize(13).text('AI 洞察', { underline: true }).moveDown(0.3);
    doc.fontSize(11).text(aiInsight);
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
