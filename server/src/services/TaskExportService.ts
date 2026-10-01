/**
 * T01480：任务导出服务——单条/批量任务导出为 Markdown / Excel(.xlsx) / Word(.docx)。
 * 三格式共用同一数据装配（标题/状态/优先级/分类/描述/处理结果摘要/时间），仅转换输出格式。
 */
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { getDb } from '../db/connection';

export type ExportFormat = 'md' | 'xlsx' | 'docx';

interface ExportRow {
  task_no: string | null;
  title: string;
  status: string;
  priority: string;
  category: string | null;
  description: string | null;
  handle_result: string | null;
  created_at: string;
  updated_at: string;
}

const PRIORITY_LABEL: Record<string, string> = { urgent: '紧急', high: '高', normal: '中', low: '低' };
const STATUS_LABEL: Record<string, string> = { todo: '待办', done: '已完成' };

/** 装配任务行（保持传入 taskIds 的顺序） */
function loadRows(taskIds: string[]): ExportRow[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT t.task_no, t.title, t.status, t.priority, c.name AS category, t.description,
           t.handle_result, t.created_at, t.updated_at
    FROM tasks t LEFT JOIN task_categories c ON c.id = t.category_id
    WHERE t.id = ?
  `);
  return taskIds
    .map((id) => stmt.get(id) as ExportRow | undefined)
    .filter((r): r is ExportRow => !!r);
}

function label(row: ExportRow): string {
  return `${PRIORITY_LABEL[row.priority] ?? row.priority}`;
}

/** Markdown 拼装（多任务时分节，单任务同构） */
function buildMarkdown(rows: ExportRow[]): Buffer {
  const parts: string[] = [`# 任务导出（${rows.length} 条）`, ''];
  for (const r of rows) {
    parts.push(`## ${r.task_no ? `${r.task_no} · ` : ''}${r.title}`);
    parts.push('');
    parts.push(`- 状态：${STATUS_LABEL[r.status] ?? r.status}`);
    parts.push(`- 优先级：${label(r)}`);
    if (r.category) parts.push(`- 分类：${r.category}`);
    parts.push(`- 创建时间：${r.created_at.slice(0, 19).replace('T', ' ')}`);
    if (r.description) parts.push('', r.description);
    if (r.handle_result) parts.push('', `> 处理结果：${r.handle_result.split('\n')[0]}`);
    parts.push('', '---', '');
  }
  return Buffer.from(parts.join('\n'), 'utf-8');
}

/** Excel 装配：一行一任务，冻结首行 + 自适应列宽 */
async function buildXlsx(rows: ExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('任务导出', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: '编号', key: 'no', width: 10 },
    { header: '标题', key: 'title', width: 40 },
    { header: '状态', key: 'status', width: 8 },
    { header: '优先级', key: 'prio', width: 8 },
    { header: '分类', key: 'cat', width: 14 },
    { header: '描述', key: 'desc', width: 60 },
    { header: '创建时间', key: 'created', width: 20 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({
      no: r.task_no ?? '', title: r.title, status: STATUS_LABEL[r.status] ?? r.status,
      prio: label(r), cat: r.category ?? '', desc: r.description ?? '',
      created: r.created_at.slice(0, 19).replace('T', ' '),
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** Word 装配：Heading 分节 + 属性段 + 描述/结果段 */
async function buildDocx(rows: ExportRow[]): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: `任务导出（${rows.length} 条）`, heading: HeadingLevel.TITLE })];
  for (const r of rows) {
    children.push(new Paragraph({ text: `${r.task_no ? `${r.task_no} · ` : ''}${r.title}`, heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ children: [
      new TextRun({ text: `状态：${STATUS_LABEL[r.status] ?? r.status}　优先级：${label(r)}` }),
      ...(r.category ? [new TextRun({ text: `　分类：${r.category}` })] : []),
      new TextRun({ text: `　创建：${r.created_at.slice(0, 19).replace('T', ' ')}`, color: '888888', size: 18 }),
    ] }));
    if (r.description) {
      children.push(new Paragraph({ text: '描述', heading: HeadingLevel.HEADING_3 }));
      for (const line of r.description.split('\n')) children.push(new Paragraph({ text: line }));
    }
    if (r.handle_result) {
      children.push(new Paragraph({ text: '处理结果摘要', heading: HeadingLevel.HEADING_3 }));
      children.push(new Paragraph({ text: r.handle_result.split('\n')[0] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

export const TaskExportService = {
  async export(taskIds: string[], format: ExportFormat): Promise<{ buffer: Buffer; filename: string; mime: string }> {
    const rows = loadRows(taskIds);
    if (rows.length === 0) throw new Error('未找到可导出的任务');
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'md') {
      return { buffer: buildMarkdown(rows), filename: `任务导出-${stamp}.md`, mime: 'text/markdown; charset=utf-8' };
    }
    if (format === 'xlsx') {
      return { buffer: await buildXlsx(rows), filename: `任务导出-${stamp}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    return { buffer: await buildDocx(rows), filename: `任务导出-${stamp}.docx`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  },
};
