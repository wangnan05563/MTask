/**
 * T02874（六期 3.3，PRD FR-6.1/6.2）：代码评审讲稿导出装配（md / docx / pptx）。
 *
 * 前端送来的是**已按标记过滤后的成稿**（`assembleLectureExport` 在 web 侧单源处理忽略/会后跟进），
 * 服务端只做格式转换与令牌落盘，不再重算标记——否则两套过滤口径必然分叉。
 * 下载走既有 `saveReportBuffer` + `/report/ai-download` 令牌链路（零新增下载端点）。
 *
 * pptx 为投屏模式：每节一页（要点页）+ 讲者备注全文（PRD §6.2）。
 */

import { downloadSafeName } from '../util/export-name';

export type LectureExportFormat = 'md' | 'docx' | 'pptx';

export const LECTURE_EXPORT_FORMATS: readonly LectureExportFormat[] = ['md', 'docx', 'pptx'];

/** 令牌换文件链路的文件名：必须洗到能过 `DOWNLOAD_NAME_RE`（含 md，T02874 同步扩白名单） */
export function lectureExportFilename(title: string, format: LectureExportFormat): string {
  return `${downloadSafeName(title, '代码评审会议讲稿')}.${format}`;
}

export interface LectureExportSection {
  key: string;
  label: string;
  text: string;
}

export interface LectureExportFollowup {
  section: string;
  text: string;
}

export interface LectureExportRequest {
  format: LectureExportFormat;
  title: string;
  generatedAt: string;
  markdown: string;
  sections: LectureExportSection[];
  followups: LectureExportFollowup[];
  ignored: number;
}

export class LectureExportError extends Error {}

const MAX_MARKDOWN = 4 * 1024 * 1024;
const MAX_SECTIONS = 24;
const MAX_SECTION_TEXT = 200_000;
const MAX_TITLE = 200;
const MAX_FOLLOWUPS = 200;

function text(v: unknown, field: string, max: number, required = false): string {
  if (v == null || v === '') {
    if (required) throw new LectureExportError(`${field} 必填`);
    return '';
  }
  if (typeof v !== 'string') throw new LectureExportError(`${field} 必须是字符串`);
  if (v.length > max) throw new LectureExportError(`${field} 超长（${v.length} > ${max}）`);
  return v;
}

/** 入参校验：格式/标题必填，md 需 markdown 正文，docx/pptx 需 sections；数值字段只做边界裁剪 */
export function validateLectureExportBody(body: unknown): LectureExportRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const format = b.format as LectureExportFormat;
  if (!LECTURE_EXPORT_FORMATS.includes(format)) {
    throw new LectureExportError(`format 必须是 ${LECTURE_EXPORT_FORMATS.join('/')} 之一`);
  }
  const title = text(b.title, 'title', MAX_TITLE, true).trim();
  if (!title) throw new LectureExportError('title 必填');
  const markdown = text(b.markdown, 'markdown', MAX_MARKDOWN, format === 'md');
  if (format === 'md' && !markdown.trim()) throw new LectureExportError('md 导出需要 markdown 正文');

  if (b.sections != null && !Array.isArray(b.sections)) throw new LectureExportError('sections 必须是数组');
  const rawSections = Array.isArray(b.sections) ? b.sections : [];
  if (format !== 'md' && rawSections.length === 0) throw new LectureExportError('docx/pptx 导出需要 sections（按节排版）');
  if (rawSections.length > MAX_SECTIONS) throw new LectureExportError(`sections 不能超过 ${MAX_SECTIONS} 节`);
  const sections = rawSections.map((s, i) => {
    const item = (s ?? {}) as Record<string, unknown>;
    const label = text(item.label, `sections[${i}].label`, MAX_TITLE, true).trim();
    return {
      key: text(item.key, `sections[${i}].key`, 64).trim() || `section-${i}`,
      label,
      text: text(item.text, `sections[${i}].text`, MAX_SECTION_TEXT),
    };
  });

  if (b.followups != null && !Array.isArray(b.followups)) throw new LectureExportError('followups 必须是数组');
  const rawFollowups = Array.isArray(b.followups) ? b.followups : [];
  if (rawFollowups.length > MAX_FOLLOWUPS) throw new LectureExportError(`followups 不能超过 ${MAX_FOLLOWUPS} 条`);
  const followups = rawFollowups.map((f, i) => {
    const item = (f ?? {}) as Record<string, unknown>;
    return {
      section: text(item.section, `followups[${i}].section`, MAX_TITLE) || '未分节',
      text: text(item.text, `followups[${i}].text`, 4000, true),
    };
  });

  return {
    format,
    title,
    generatedAt: text(b.generatedAt, 'generatedAt', 64) || new Date().toLocaleString('zh-CN'),
    markdown,
    sections,
    followups,
    ignored: Number.isFinite(Number(b.ignored)) ? Math.max(0, Math.trunc(Number(b.ignored))) : 0,
  };
}

/** markdown 行 → docx 段落（标题行与列表项的轻量映射，保留原始正文给 md） */
function docxParagraphs(raw: string) {
  return raw.split('\n').map((line) => {
    const t = line.trimEnd();
    if (!t.trim()) return { blank: true as const, text: '' };
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(t)) {
      return { blank: false as const, bullet: true, text: t.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '') };
    }
    return { blank: false as const, bullet: false, text: t };
  });
}

async function buildDocx(input: LectureExportRequest): Promise<Buffer> {
  const { Document: DocxDocument, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
  const ignoredNote = input.ignored ? `　已忽略 ${input.ignored} 条` : '';
  const generatedTimeText = `生成时间：${input.generatedAt}${ignoredNote}`;
  const children: import('docx').Paragraph[] = [
    new Paragraph({ text: input.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: generatedTimeText, color: '6B7280', size: 18 })] }),
    new Paragraph(''),
  ];
  for (const section of input.sections) {
    children.push(new Paragraph({ text: section.label, heading: HeadingLevel.HEADING_2 }));
    for (const p of docxParagraphs(section.text || '（本节无内容）')) {
      if (p.blank) { children.push(new Paragraph('')); continue; }
      children.push(new Paragraph(p.bullet ? { text: p.text, bullet: { level: 0 } } : { text: p.text }));
    }
    children.push(new Paragraph(''));
  }
  if (input.followups.length > 0) {
    children.push(new Paragraph({ text: '会后跟进清单', heading: HeadingLevel.HEADING_2 }));
    for (const f of input.followups) {
      children.push(new Paragraph({ text: `【${f.section}】${f.text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')}`, bullet: { level: 0 } }));
    }
    children.push(new Paragraph(''));
  }
  const doc = new DocxDocument({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/** 要点页正文：只取列表项/短行，避免整节全文溢出页面（全文进讲者备注） */
function slideBullets(raw: string): string[] {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => /^(?:[-*•]|\d+[.)])\s+/.test(l));
  const picked = (items.length > 0 ? items : lines).map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, ''));
  return picked.slice(0, 8).map((l) => (l.length > 120 ? `${l.slice(0, 118)}…` : l));
}

async function buildPptx(input: LectureExportRequest): Promise<Buffer> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 10, height: 5.63 });
  pptx.layout = 'WIDE';

  const cover = pptx.addSlide();
  const coverIgnoredNote = input.ignored ? `    已忽略 ${input.ignored} 条` : '';
  const coverGeneratedTime = `生成时间：${input.generatedAt}${coverIgnoredNote}`;
  cover.addText(input.title, { x: 0.5, y: 0.5, w: 9, h: 1.2, fontSize: 28, bold: true, color: '1F2937' });
  cover.addText(coverGeneratedTime, {
    x: 0.5, y: 1.8, w: 9, h: 0.5, fontSize: 12, color: '6B7280',
  });

  input.sections.forEach((section, index) => {
    const slide = pptx.addSlide();
    slide.addText(`${index + 1}. ${section.label}`, { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 22, bold: true, color: '1F2937' });
    const bullets = slideBullets(section.text);
    if (bullets.length > 0) {
      slide.addText(bullets.map((line) => ({ text: line, options: { bullet: true } })) as never, {
        x: 0.6, y: 1.15, w: 8.8, h: 3.9, fontSize: 13, color: '374151', breakLine: true,
      });
    } else {
      slide.addText('（本节按大纲留白，会上口头补充）', { x: 0.6, y: 1.15, w: 8.8, h: 0.6, fontSize: 13, color: '9CA3AF' });
    }
    // 讲者备注 = 本节全文（PRD §6.2 投屏模式：一页一节要点页 + 讲者备注全文）
    slide.addNotes(section.text || '（本节无内容）');
  });

  if (input.followups.length > 0) {
    const slide = pptx.addSlide();
    slide.addText('会后跟进清单', { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 22, bold: true, color: '1F2937' });
    slide.addText(input.followups.slice(0, 12).map((f) => ({
      text: `[${f.section}] ${f.text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')}`,
      options: { bullet: true },
    })) as never, { x: 0.6, y: 1.1, w: 8.8, h: 4, fontSize: 12, color: '374151', breakLine: true });
    slide.addNotes(input.followups.map((f) => `[${f.section}] ${f.text}`).join('\n'));
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(out as unknown as ArrayBuffer);
}

/** 生成导出物：md 直出、docx/pptx 走既有装配栈（零新增依赖） */
export async function buildLectureExport(input: LectureExportRequest): Promise<Buffer> {
  if (input.format === 'md') return Buffer.from(input.markdown.endsWith('\n') ? input.markdown : `${input.markdown}\n`, 'utf8');
  if (input.format === 'docx') return buildDocx(input);
  return buildPptx(input);
}
