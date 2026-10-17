/**
 * T02155 渲染验证：真生成 PDF，确认
 *   ① 表格不再以 ` | ` 文本拼接（无裸 `|` 残留、列单元齐全且被 pdfkit 框为独立文本）；
 *   ② 柱状图可绘制（drawBarChart 不抛错且产出非空字节）；
 *   ③ 标题/引用/列表等块仍正常渲染。
 * 产出两份样本：.workbuddy/t02155-sample-table-<运行标识>.pdf、t02155-sample-charts-<运行标识>.pdf（T02309 旁证同标识；实际路径见 stdout）。
 * 文本层断言（裸 `|` 残留 / 关键单元格是否在文本层）交由同目录 verify-t02155-extract.py 完成。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrdPdf, newPdfDoc, renderMdPdf, drawBarChart } from '../server/src/services/prdExport';
import { gateArtifactPath } from './lib/gate-results.mts'; // T02309：样本 PDF 按运行标识命名

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.workbuddy');
mkdirSync(OUT, { recursive: true });

const md = [
  '# 估算报告（内部版）',
  '',
  '> 注意：本次导出有 2 行为系统推导值，未人工复核。',
  '',
  '## 一、报价结论',
  '',
  '| 指标 | 数值 | 依据 |',
  '| --- | --- | --- |',
  '| 直接投入人天 | 120.5 | 三点加权 E=(O+4M+P)/6 求和 |',
  '| 实际预估人月 | 6.3 | 理想人月 ×（1 + 综合调节系数 0.08） |',
  '',
  '## 二、阶段构成',
  '',
  '| 阶段 | 最小 | 最可能 | 最大 | 最终估算值（人天） | 占比 | 条目数 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| 需求/设计 | 10 | 14 | 22 | 14.3 | 11.9% | 3 |',
  '| 开发段 | 60 | 88 | 130 | 89.7 | 74.5% | 12 |',
  '| 测试段 | 8 | 12 | 20 | 12.5 | 10.4% | 5 |',
  '| 合计 | 78 | 114 | 172 | 116.5 | — | 20 |',
  '',
  '- 各阶段占比之和 = 96.8%，偏差 3.2%。',
  '- 未计入合计的行：小计 0 行。',
].join('\n');

const tablePdf = await buildPrdPdf(md, '估算报告（内部版）');
const tablePdfPath = gateArtifactPath(OUT, 't02155-sample-table.pdf');
writeFileSync(tablePdfPath, tablePdf);

// 图表样本：基于 MD 渲染后再追加两张柱状图
const { doc, done, finish } = await newPdfDoc('估算图表样本');
renderMdPdf(doc, '# 各阶段数据图\n\n下面是本次估算的阶段分布。');
drawBarChart(doc, '各阶段最终估算值（人天）', [
  { label: '需求/设计', value: 14.3 },
  { label: '开发段', value: 89.7 },
  { label: '测试段', value: 12.5 },
]);
drawBarChart(doc, '各阶段占比（%）', [
  { label: '需求/设计', value: 11.9 },
  { label: '开发段', value: 74.5 },
  { label: '测试段', value: 10.4 },
]);
doc.end();
await done;
const chartPdf = finish();
const chartPdfPath = gateArtifactPath(OUT, 't02155-sample-charts.pdf');
writeFileSync(chartPdfPath, chartPdf);

// T02309：样本名带运行标识后，把实际路径打出来——文本层断言由同目录 verify-t02155-extract.py 人工执行，路径不能靠猜
console.log(`table.pdf=${tablePdf.length} bytes → ${tablePdfPath}`);
console.log(`charts.pdf=${chartPdf.length} bytes → ${chartPdfPath}`);
