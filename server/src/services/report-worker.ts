/**
 * 报表构建 worker：在主进程之外执行 CPU 密集的文件合成（exceljs/docx/pptxgenjs/pdfkit）。
 * 通过 worker_threads 消息协议与 ReportService 通信：
 *   收：{ format, data, templateBuf?, aiInsight? }   （data 为纯 JSON 可序列化对象）
 *   发：{ buffer } 或 { error }
 * 大依赖（exceljs 等）只在 worker 首次启动时加载一次，worker 复用则无需重复加载。
 */
import { parentPort } from 'node:worker_threads';
import { buildXlsx, buildDocx, buildPptx, buildPdf } from './report-builder';

if (!parentPort) throw new Error('report-worker 必须作为 worker_threads 运行');

parentPort.on('message', async (msg: { format: string; data: unknown; templateBuf?: Buffer; aiInsight?: string }) => {
  try {
    const { format, data, templateBuf, aiInsight } = msg;
    // 兼容 dist 编译产物（结构克隆后 Buffer 到达时可能退化为 Uint8Array）
    const tpl = templateBuf ? Buffer.from(templateBuf) : undefined;
    let buffer: Buffer;
    if (format === 'xlsx') buffer = await buildXlsx(data as Parameters<typeof buildXlsx>[0], tpl, aiInsight);
    else if (format === 'docx') buffer = await buildDocx(data as Parameters<typeof buildDocx>[0], tpl, aiInsight);
    else if (format === 'pptx') buffer = await buildPptx(data as Parameters<typeof buildPptx>[0], aiInsight);
    else buffer = await buildPdf(data as Parameters<typeof buildPdf>[0], aiInsight);
    // transfer 底层 ArrayBuffer，避免大文件二次拷贝
    parentPort!.postMessage({ buffer }, [buffer.buffer as ArrayBuffer]);
  } catch (e) {
    parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
});
