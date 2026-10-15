/**
 * T01487：测试用例导出构建器（PRD-测试用例管理 §10.3）。
 *
 * 分层与 `prdExport.ts` 一致：本模块只做「数据 → 文件 Buffer」的纯计算，不碰 DB、不做路由编排。
 * 三点刻意设计：
 *  1. **列规格单源**：xlsx 表头/列宽/取值与 docx、md 的字段清单都从同一份 `CASE_COLUMNS` 派生，
 *     三种格式不可能出现「Excel 有标签列、Word 没有」这类漂移；中文标签一律取 `util/testCaseEnums`
 *     的映射表（值本身就是收窄后的字面量联合类型，直接索引即可，无需 `as any`）。
 *  2. **重依赖按需加载**：`exceljs` / `docx` 都在函数体内 `await import()`，`md` 构建器零依赖——
 *     只导 Markdown 的进程永远不会为这两个库付加载成本（§11）。
 *  3. **版式走 `util/exportStyle`**：规范 A 的参数不在本文件再抄一遍（§10.2 抽共享常量的初衷）。
 */
import {
  CASE_METHOD_LABEL,
  CASE_PRIORITY_LABEL,
  CASE_RESULT_LABEL,
  CASE_STATUS_LABEL,
  CASE_TYPE_LABEL,
} from '../util/testCaseEnums';
import { DOCX_HEAD_SHADING, markWarnCell, paintDataRow, paintHeaderRow } from '../util/exportStyle';
import type { TestCaseWithSteps } from './TestCaseService';
// docx 的构造器在 `buildCaseDocx` 内部按需 `await import`，那里的局部绑定会遮蔽同名类型，
// 故类型位置用带前缀的别名导入（`import type` 编译期擦除，不引入运行时依赖）
import type { Paragraph as DocxParagraph, Table as DocxTable, TableCell as DocxTableCell } from 'docx';

/** 覆盖度摘要（`TestCaseService.coverage` 返回体的子集；类型自持，避免依赖服务层内部函数签名） */
export interface CaseCoverageSummary {
  total: number;
  covered: number;
  uncovered: number;
  rate: number;
  byReq: Array<{ reqId: string; reqNo: string; title: string; caseCount: number }>;
}

/** 三种格式共用的输入：项目名 + 本次导出范围的用例（含步骤）+ 项目级覆盖度 */
export interface CaseExportInput {
  projectName: string;
  cases: readonly TestCaseWithSteps[];
  coverage: CaseCoverageSummary;
}

/**
 * 用例列规格（§10.3 列序）。`wrap` 标记 xlsx 里需要换行的长文本列；
 * `steps` 只服务 xlsx——docx/md 用步骤表格表达，不在字段行里重复。
 */
const CASE_COLUMNS: ReadonlyArray<{
  header: string;
  key: string;
  width: number;
  wrap?: boolean;
  get: (c: TestCaseWithSteps) => string;
}> = [
  { header: '用例编号', key: 'caseNo', width: 12, get: (c) => c.case_no },
  { header: '所属模块', key: 'module', width: 18, get: (c) => c.module || '-' },
  { header: '用例标题', key: 'title', width: 40, get: (c) => c.title },
  { header: '前置条件', key: 'preconditions', width: 30, wrap: true, get: (c) => c.preconditions || '-' },
  { header: '测试步骤', key: 'steps', width: 52, wrap: true, get: (c) => stepsText(c) },
  { header: '预期结果', key: 'expected', width: 34, wrap: true, get: (c) => c.expected || '-' },
  { header: '测试数据', key: 'testData', width: 24, wrap: true, get: (c) => c.test_data || '-' },
  { header: '后置条件', key: 'postconditions', width: 22, wrap: true, get: (c) => c.postconditions || '-' },
  { header: '优先级', key: 'priority', width: 10, get: (c) => CASE_PRIORITY_LABEL[c.priority] },
  { header: '类型', key: 'type', width: 10, get: (c) => CASE_TYPE_LABEL[c.type] },
  { header: '执行方式', key: 'method', width: 10, get: (c) => CASE_METHOD_LABEL[c.method] },
  { header: '状态', key: 'status', width: 10, get: (c) => CASE_STATUS_LABEL[c.status] },
  { header: '执行结果', key: 'result', width: 10, get: (c) => CASE_RESULT_LABEL[c.last_result] },
  { header: '关联需求编号', key: 'reqNo', width: 14, get: (c) => c.reqNo ?? '-' },
  { header: '关联需求标题', key: 'reqTitle', width: 32, get: (c) => c.reqTitle ?? '-' },
];

/** docx / md 的字段清单：同一份列规格去掉步骤列（步骤另有表格） */
const CASE_FIELD_COLUMNS = CASE_COLUMNS.filter((col) => col.key !== 'steps');

/** 需要 xlsx 单元格换行的列 key（由规格派生，不在渲染循环里再硬编码一次列名） */
const WRAP_KEYS = CASE_COLUMNS.filter((col) => col.wrap).map((col) => col.key);

/** 需求覆盖率子表列规格 */
const COVERAGE_COLUMNS = [
  { header: '需求编号', key: 'reqNo', width: 14 },
  { header: '需求标题', key: 'title', width: 46 },
  { header: '用例数', key: 'caseCount', width: 10 },
  { header: '是否覆盖', key: 'covered', width: 12 },
] as const;

/** 步骤拍平成多行文本：`1. 操作 → 预期结果`（无预期时只出操作，不留孤零零的箭头） */
function stepsText(c: TestCaseWithSteps): string {
  return c.steps
    .map((s) => {
      const tail = s.expected ? ` → ${s.expected}` : '';
      return `${s.step_no}. ${s.action}${tail}`;
    })
    .join('\n');
}

function stamp(): string {
  return new Date().toLocaleString('zh-CN');
}

/**
 * 统计行（§10.3 xlsx 表头行1）。刻意写「本次导出 N 条」而不是「用例 N 条」：
 * 按选中/单需求导出时条数是子集，而覆盖率永远是项目级口径，两句话混在一行不加区分会被读成子集覆盖率。
 */
function summaryLine(input: CaseExportInput): string {
  const cov = input.coverage;
  return `项目：${input.projectName} ｜ 本次导出 ${input.cases.length} 条 ｜ 项目需求覆盖 ${cov.covered}/${cov.total}（${cov.rate}%）｜ 导出时间：${stamp()}`;
}

/** 需求分组（docx/md 的一级标题）。孤儿用例独立成组并排到最后——它不是一条需求，混在里面会被当成需求读 */
function groupByReq(cases: readonly TestCaseWithSteps[]): Array<{ label: string; orphan: boolean; cases: TestCaseWithSteps[] }> {
  const map = new Map<string, { label: string; orphan: boolean; cases: TestCaseWithSteps[] }>();
  for (const c of cases) {
    const key = c.req_id ?? '';
    let g = map.get(key);
    if (!g) {
      g = c.req_id
        ? { label: `${c.reqNo ?? ''} ${c.reqTitle ?? ''}`.trim() || c.req_id, orphan: false, cases: [] }
        : { label: '未关联需求（孤儿用例）', orphan: true, cases: [] };
      map.set(key, g);
    }
    g.cases.push(c);
  }
  const all = [...map.values()];
  return [...all.filter((g) => !g.orphan), ...all.filter((g) => g.orphan)];
}

/** 模块分组（docx 的二级标题，§10.3）；未填模块的用例归到「未划分模块」，不能让标题变成空串 */
function groupByModule(cases: TestCaseWithSteps[]): Array<{ label: string; cases: TestCaseWithSteps[] }> {
  const map = new Map<string, { label: string; cases: TestCaseWithSteps[] }>();
  for (const c of cases) {
    const key = c.module || '';
    let g = map.get(key);
    if (!g) {
      g = { label: key || '未划分模块', cases: [] };
      map.set(key, g);
    }
    g.cases.push(c);
  }
  return [...map.values()];
}

/** 覆盖率子表行（xlsx Sheet2 与 docx/md 汇总共用）。 */
function coverageRows(cov: CaseCoverageSummary): Array<{ reqNo: string; title: string; caseCount: number; covered: string }> {
  // PRD §10.3 字面写「未覆盖行整行 `--`」，此处按 0 + 「未覆盖」红字标注落地：
  // 整行打 `--` 会把需求编号与标题一起抹掉，导出件就再也定位不到是哪条需求没覆盖，
  // 而用例数列留 0 才能在 Excel 里直接排序/求和。取舍记录在 T01487 result 文档。
  return cov.byReq.map((r) => ({
    reqNo: r.reqNo || '-',
    title: r.title || '-',
    caseCount: r.caseCount,
    covered: r.caseCount > 0 ? '已覆盖' : '未覆盖',
  }));
}

/** Markdown 表格单元格转义：竖线会截列，换行会截行 */
function mdCell(text: string): string {
  // String.raw`\|` 与 '\\|' 完全等价，写成原文可避免多余转义
  return text.replaceAll('|', String.raw`\|`).replaceAll('\n', '<br>');
}

/**
 * 标题类输出（md 的 H2/H3）压成一行：用例标题或需求标题里带换行时（AI 生成不罕见），
 * 直接拼进 `###` 会把一条用例劈成两段列表式噪声，整份文档的层级就塌了。
 */
function oneLine(text: string): string {
  return text.replaceAll(/\s*\n\s*/g, ' / ').trim();
}

/** Excel（.xlsx）：Sheet1 用例明细 + Sheet2 需求覆盖率，规范 A 版式 + 冻结前 2 行 + 自动筛选（§10.3） */
export async function buildCaseXlsx(input: CaseExportInput): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('测试用例');
  ws.columns = CASE_COLUMNS.map((col) => ({ header: col.header, key: col.key, width: col.width }));
  paintHeaderRow(ws.getRow(1));
  input.cases.forEach((c, i) => {
    const values: Record<string, string> = {};
    for (const col of CASE_COLUMNS) values[col.key] = col.get(c);
    const row = ws.addRow(values);
    paintDataRow(row, i % 2 === 1);
    for (const key of WRAP_KEYS) row.getCell(key).alignment = { wrapText: true, vertical: 'top' };
  });
  // 统计行插到第 1 行后原表头下移到第 2 行，样式要重刷（与矩阵导出同一套处理）
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.insertRow(1, [summaryLine(input)]);
  ws.getRow(1).font = { bold: true };
  paintHeaderRow(ws.getRow(2));
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: CASE_COLUMNS.length } };

  const ws2 = wb.addWorksheet('需求覆盖率');
  ws2.columns = COVERAGE_COLUMNS.map((col) => ({ header: col.header, key: col.key, width: col.width }));
  paintHeaderRow(ws2.getRow(1));
  coverageRows(input.coverage).forEach((r, i) => {
    const row = ws2.addRow({ ...r });
    paintDataRow(row, i % 2 === 1);
    if (r.caseCount === 0) markWarnCell(row.getCell('covered'));
  });
  ws2.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
}

/**
 * Word（.docx）：一级=需求 / 二级=模块 / 用例两列表 + 独立步骤表 + 文末覆盖率汇总（§10.3）。
 * 用例标题另起 HEADING_3：规范只写到「再下为用例表格」，但一个模块下多条用例时
 * 没有小标题会连成一片表格墙，评审打印时读不出边界。
 */
export async function buildCaseDocx(input: CaseExportInput): Promise<Buffer> {
  const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import('docx');
  const cell = (text: string, opts?: { bold?: boolean; fill?: string }): DocxTableCell => new TableCell({
    ...(opts?.fill ? { shading: { fill: opts.fill } } : {}),
    children: (text || ' ').split('\n').map((line) => new Paragraph({
      children: [new TextRun({ text: line || ' ', bold: opts?.bold })],
    })),
  });
  const table = (head: readonly string[], rows: ReadonlyArray<readonly string[]>): DocxTable => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((h) => cell(h, { bold: true, fill: DOCX_HEAD_SHADING })) }),
      ...rows.map((r) => new TableRow({ children: r.map((v) => cell(v)) })),
    ],
  });
  const children: Array<DocxParagraph | DocxTable> = [
    new Paragraph({ text: `测试用例 - ${input.projectName}`, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: summaryLine(input), spacing: { after: 240 } }),
  ];
  for (const g of groupByReq(input.cases)) {
    children.push(new Paragraph({ text: oneLine(g.label), heading: HeadingLevel.HEADING_1 }));
    for (const m of groupByModule(g.cases)) {
      children.push(new Paragraph({ text: m.label, heading: HeadingLevel.HEADING_2 }));
      for (const c of m.cases) {
        children.push(
          new Paragraph({ text: `${c.case_no} ${oneLine(c.title)}`, heading: HeadingLevel.HEADING_3 }),
          table(['字段', '值'], CASE_FIELD_COLUMNS.map((col) => [col.header, col.get(c)])),
          new Paragraph({ text: '测试步骤', spacing: { before: 120, after: 60 } }),
          c.steps.length === 0
            ? new Paragraph({ text: '（未填写步骤）' })
            : table(['序号', '操作', '预期结果'], c.steps.map((s) => [String(s.step_no), s.action, s.expected])),
        );
      }
    }
  }
  children.push(
    new Paragraph({ text: '需求覆盖率汇总', heading: HeadingLevel.HEADING_1, spacing: { before: 240 } }),
    table(
      COVERAGE_COLUMNS.map((col) => col.header),
      coverageRows(input.coverage).map((r) => [r.reqNo, r.title, String(r.caseCount), r.covered]),
    ),
  );
  const doc = new Document({ sections: [{ children }] });
  return await Packer.toBuffer(doc);
}

/** Markdown（.md）：`# 项目` → `## REQ` → `### TC` → 字段列表 → 步骤表格（§10.3；层级严格按规范，不插模块层） */
export function buildCaseMd(input: CaseExportInput): Buffer {
  const out: string[] = [`# 测试用例 - ${oneLine(input.projectName)}`, '', `> ${summaryLine(input)}`, ''];
  for (const g of groupByReq(input.cases)) {
    out.push(`## ${oneLine(g.label)}`, '');
    for (const c of g.cases) {
      out.push(`### ${c.case_no} ${oneLine(c.title)}`, '');
      for (const col of CASE_FIELD_COLUMNS) out.push(`- **${col.header}**：${mdCell(col.get(c))}`);
      out.push('', '**测试步骤**', '');
      if (c.steps.length === 0) out.push('（未填写步骤）', '');
      else {
        out.push('| 序号 | 操作 | 预期结果 |', '| --- | --- | --- |');
        for (const s of c.steps) out.push(`| ${s.step_no} | ${mdCell(s.action)} | ${mdCell(s.expected)} |`);
        out.push('');
      }
    }
  }
  out.push('## 需求覆盖率汇总', '', '| 需求编号 | 需求标题 | 用例数 | 是否覆盖 |', '| --- | --- | --- | --- |');
  for (const r of coverageRows(input.coverage)) {
    out.push(`| ${mdCell(r.reqNo)} | ${mdCell(r.title)} | ${r.caseCount} | ${r.covered} |`);
  }
  out.push('');
  return Buffer.from(out.join('\n'), 'utf8');
}
