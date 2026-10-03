/**
 * T00959：导出下载的统一入口。
 *
 * 原先各页面各自写 Blob + 隐藏 a 标签的下载代码（PlanPage / DbAdminTab / ReportConsole 各一份），
 * 导出按钮增多后统一到这里，避免 MIME 与文件名处理口径不一致（例如 xlsx 的 MIME 写错会导致
 * 部分浏览器把文件存成 .bin）。文件名由调用方给出，服务端 Content-Disposition 仅作兜底。
 */

/** 常用导出格式的 MIME（与服务端响应头保持一致） */
export const EXPORT_MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  md: 'text/markdown;charset=utf-8',
} as const;

/** 把二进制内容存为文件并触发下载 */
export function saveBinary(buf: ArrayBuffer, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([buf], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  // 立刻回收即可：click() 已把下载请求交给浏览器，URL 在下一轮事件循环前仍有效
  URL.revokeObjectURL(url);
}

/** 下载文件名安全化（去掉路径分隔与非法字符；与后端 safeExportName 同口径） */
export function safeExportName(name: string, fallback = 'export'): string {
  const s = name.replaceAll(/[\\/:*?"<>|\n\r\t]/g, '-').replaceAll(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

/**
 * T01485：保存 Blob 为文件——用于 `api.postDownload()` 这类「POST 换文件流」的导出。
 *
 * 与 `saveBinary` 的差别只在于输入：后者接 ArrayBuffer（GET 二进制），
 * 前者接 Blob 且直接用服务端 Content-Disposition 给出的文件名（含中文与日期），
 * 避免前端再拼一份命名规则形成第二套口径。
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeExportName(filename, 'export');
  a.rel = 'noopener';
  a.click();
  URL.revokeObjectURL(url);
}
