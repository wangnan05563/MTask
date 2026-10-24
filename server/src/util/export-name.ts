/**
 * T02104（FR-5）：导出文件名单源。
 *
 * 为什么单独成文件：下载端点的**白名单**与生成文件名的**清洗口径**必须同源。两者分叉的后果不是
 * 「名字难看」，而是 `report/ai-download` 对不合规名字整体回退成 `MTask-ai-report.xlsx`——
 * 用户点一个 .pptx 的下载，拿到一个 xlsx 名（内容仍是 pptx），且全程无人报错。
 *
 * 命名口径两处不同用途，故两个函数并存而非合并：
 * - `safeExportName`：直接进 `Content-Disposition` 的导出名（矩阵/测试用例/PRD/评估），只禁路径分隔与控制字符。
 * - `downloadSafeName`：走「令牌换文件」链路的名字，必须洗到能过 {@link DOWNLOAD_NAME_RE}。
 */

/**
 * 下载端点文件名白名单（T02103 起为启动会 PPT 复用周报链路，A-2 裁决：零改动复用）。
 * T02856（六期 S5 / PRD 裁决 A-2）：加 `zip`——分别独立版多项目打包的交付扩展名；
 * T02874（六期 3.3）：加 `md`——代码评审讲稿的纯文本导出。
 * 正文可字符集不变，生成侧仍须经 {@link downloadSafeName} 洗到能过这里，不新开校验口子。
 */
export const DOWNLOAD_NAME_RE = /^[\w\-.()·\u4e00-\u9fa5 ]+\.(xlsx|docx|pdf|pptx|zip|md)$/i;

/** 白名单允许的正文字符（去掉扩展名后逐字判定）：ASCII 字母数字下划线、`- . ( ) ·`、空格、CJK 基本区 */
const BODY_CHAR_RE = /[\w\-().·\u4e00-\u9fa5]/;

/** 导出文件名安全化：去掉路径分隔与非法字符（与前端 safeFilename 同口径，避免下载文件名带斜杠） */
export function safeExportName(name: string, fallback: string): string {
  const s = name.replaceAll(/[\\/:*?"<>|\n\r\t]/g, '-').replaceAll(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

/**
 * 把「不含扩展名的文件名」洗到必然通过 {@link DOWNLOAD_NAME_RE} 的正文部分。
 *
 * 与 `safeExportName` 的差别是它更严：白名单不含 `&` `#` `+` 全角括号 `（）` 中文顿号等，
 * 项目名里出现这些字符时若只走 `safeExportName`，下载端点会静默回退成 xlsx 兜名。
 */
export function downloadSafeName(base: string, fallback: string): string {
  const kept = base
    .split('')
    .map((ch) => (BODY_CHAR_RE.test(ch) ? ch : '-'))
    .join('')
    .replaceAll(/ {2,}/g, ' ')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^[-. ]+/, '')
    .replace(/[-. ]+$/, '')
    .slice(0, 80);
  return kept || fallback;
}
