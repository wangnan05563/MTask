/**
 * 报表构建 worker：在主进程之外执行 CPU 密集的文件合成（exceljs/docx/pptxgenjs/pdfkit）。
 * 通过 worker_threads 消息协议与 ReportService 通信：
 *   收：{ format, data, templateBuf?, aiInsight? }   （data 为纯 JSON 可序列化对象）
 *   发：{ buffer } 或 { error }
 * 大依赖（exceljs 等）只在 worker 首次启动时加载一次，worker 复用则无需重复加载。
 */
import { parentPort } from 'node:worker_threads';

/**
 * builder 的载入要同时伺候两种运行形态，静态 import 在其中之一必炸：
 *   - dist（tsc 出 CommonJS 的 report-worker.js）：`require('./report-builder')` 省略扩展名可用；
 *     这里写的每个 specifier 都会被 tsc 原样落进 require()，所以不能带 .ts。
 *   - dev（tsx 直跑 report-worker.ts，ESM 解析）：扩展名必须显式，且 tsx 不把 './x.js' 回映射成 x.ts
 *     （实测：'./report-builder' 与 './report-builder.js' 都 ERR_MODULE_NOT_FOUND）。
 * 用 `typeof require === 'function'` 分流，说明符用变量拼——写死 './report-builder.ts' 会被
 * TS5097（import 表达式不许以 .ts 结尾）在 server typecheck 阶段拦下，等于把这条静默失败搬进发布链路。
 * 首次消息时载入并缓存，保持「大依赖只在 worker 首启加载一次」的原意。
 */
let builderCache: typeof import('./report-builder') | undefined;
async function loadBuilder(): Promise<typeof import('./report-builder')> {
  if (builderCache) return builderCache;
  const spec = './report-builder' + (typeof require === 'function' ? '' : '.ts');
  builderCache = (await import(spec)) as typeof import('./report-builder');
  return builderCache;
}

if (!parentPort) throw new Error('report-worker 必须作为 worker_threads 运行');

parentPort.on('message', async (msg: { format: string; data: unknown; templateBuf?: Buffer; aiInsight?: string }) => {
  try {
    const { format, data, templateBuf, aiInsight } = msg;
    // 兼容 dist 编译产物（结构克隆后 Buffer 到达时可能退化为 Uint8Array）
    const tpl = templateBuf ? Buffer.from(templateBuf) : undefined;
    const { buildXlsx, buildDocx, buildPptx, buildPdf } = await loadBuilder();
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
