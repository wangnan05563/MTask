/**
 * T02389：把任务描述 / 处理结果里的文件引用变成可点击链接。
 *
 * 只改写「看起来是文件」的片段（带扩展名的相对/绝对路径、file://），
 * 输出统一的 `mtask-file:` 内部链接；真正的打开动作由 MarkdownContent 的 onFileClick 拦截，
 * 不跳转页面、不开新窗口。代码块内不改写，行内代码只在整体是路径时改为可点击的代码链接。
 */
export const FILE_LINK_PREFIX = 'mtask-file:';

const DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const PLACEHOLDER_RE = /@@MTASK_PH_(\d+)@@/g;
const BAD_SEGMENT_CHARS = /[\s:：,，;；!?！？、()（）[\]【】"'`<>|*?]/;

function isPathSegment(seg: string): boolean {
  return seg === '.' || seg === '..' || (!!seg && !BAD_SEGMENT_CHARS.test(seg));
}

/** 整体是否像一个文件路径（用于行内代码、引号路径、裸路径的收口判定） */
export function looksLikeFilePath(raw: string, allowSpaces = false): boolean {
  const s = raw.trim().replace(/^<|>$/g, '');
  if (!s) return false;
  if (/^file:\/\//i.test(s)) return true;
  if (s.startsWith('\\\\') || s.startsWith('//')) return false; // UNC/设备路径不生成链接
  if (!allowSpaces && /\s/.test(s)) return false;
  if (DRIVE_ABS.test(s)) return /\.[A-Za-z0-9]{1,12}$/.test(s);
  if (s.startsWith('/')) return /\.[A-Za-z0-9]{1,12}$/.test(s);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) return false;
  const parts = s.split('/');
  if (parts.length < 2) return false;
  const file = parts[parts.length - 1];
  if (!/^[^\\\s:：,，;；!?！？、()（）[\]【】"'`<>|*?]+\.[A-Za-z0-9]{1,12}$/.test(file)) return false;
  return parts.slice(0, -1).every(isPathSegment);
}

/** 去掉 #L12 / :12 行号锚，得到一个可交给服务端的路径 */
export function normalizeFileTarget(raw: string): string {
  let s = raw.trim().replace(/^<|>$/g, '');
  s = s.replace(/#L\d+(?:-L\d+)?$/i, '');
  if (!DRIVE_ABS.test(s)) s = s.replace(/:\d+(?::\d+)?$/, '');
  return s;
}

function isFileTarget(dest: string): boolean {
  const d = normalizeFileTarget(dest);
  if (!d || d.startsWith('#') || d.startsWith('//')) return false;
  if (/^file:\/\//i.test(d)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(d) && !DRIVE_ABS.test(d)) return false;
  return looksLikeFilePath(d, true);
}

function trimBarePath(raw: string): string {
  let s = raw;
  while (s.length > 1 && /[)\]}】）>.,;:!?，。；：！？、]+$/.test(s)) s = s.slice(0, -1);
  return s;
}

const MD_LINK_RE = /!?\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const HTTP_URL_RE = /https?:\/\/[^\s<>"'`）)\]}]+/gi;
const MAILTO_RE = /mailto:[^\s<>"'`）)\]}]+/gi;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const QUOTED_PATH_RE = /(["'])((?:file:\/\/|[A-Za-z]:[\\/]|\/(?!\/))[^"'\r\n]+)\1/g;
// 前置边界避免把 URL 尾部/单词内部误判成路径；Windows 盘符、POSIX 绝对、相对路径三选一
const BARE_PATH_RE = /(^|[\s(（\[【"'`，,;；:：])((?:file:\/\/[^\s<>"'`，。；：）)\]}]+)|(?:[A-Za-z]:[\\/][^\s<>"'`|?*，。；：）)\]}]+)|(?:\/(?!\/)[^\s<>"'`，。；：）)\]}]+)|(?:(?:[^\s/\\:：,，;；!?！？、()（）\[\]【】"'`<>|*?]+\/)+[^\s/\\:：,，;；!?！？、()（）\[\]【】"'`<>|*?]+\.[A-Za-z0-9]{1,12}))/g;

function linkMarkdown(label: string, target: string): string {
  const text = (label || target).replace(/[[\]]/g, (ch) => `\\${ch}`);
  return `[${text}](${FILE_LINK_PREFIX}${encodeURIComponent(target)})`;
}

function processLine(line: string): string {
  const holds: string[] = [];
  const hold = (text: string) => {
    holds.push(text);
    return `@@MTASK_PH_${holds.length - 1}@@`;
  };

  // 1) 既有 Markdown 链接/图片：文件目标改写成内部链接；其余链接原样隔离，避免被后续路径规则拆坏
  let out = line.replace(MD_LINK_RE, (raw, label: string, dest: string) => {
    if (!isFileTarget(dest)) return hold(raw);
    const target = normalizeFileTarget(dest);
    return hold(linkMarkdown(label.trim(), target));
  });

  // 2) 网络链接先隔离（否则 https://host/a/b.md 会被尾部 /a/b.md 规则命中）
  out = out.replace(HTTP_URL_RE, (raw) => hold(raw)).replace(MAILTO_RE, (raw) => hold(raw));

  // 3) 行内代码：整体是路径时转为可点击的代码链接；其余同样隔离
  out = out.replace(INLINE_CODE_RE, (raw, inner: string) => {
    if (!looksLikeFilePath(inner)) return hold(raw);
    return hold(`[\`${inner}\`](${FILE_LINK_PREFIX}${encodeURIComponent(normalizeFileTarget(inner))})`);
  });

  // 4) 引号包裹的含空格路径（如 "D:\Program Files\a.txt"）
  out = out.replace(QUOTED_PATH_RE, (raw, _quote: string, path: string) => {
    if (!looksLikeFilePath(path, true)) return raw;
    return hold(linkMarkdown(path, normalizeFileTarget(path)));
  });

  // 5) 裸路径
  out = out.replace(BARE_PATH_RE, (raw, lead: string, cand: string) => {
    const path = trimBarePath(cand);
    if (!looksLikeFilePath(path)) return raw;
    const tail = cand.slice(path.length);
    return `${lead}${linkMarkdown(path, normalizeFileTarget(path))}${tail}`;
  });

  return out.replace(PLACEHOLDER_RE, (_raw, idx: string) => holds[Number(idx)] ?? '');
}

/** Markdown 源码入口：按行跳过围栏代码块与缩进代码块，其余行做文件链接改写 */
export function linkifyFilePaths(markdown: string): string {
  const lines = (markdown ?? '').split('\n');
  let fence: { char: string; len: number } | null = null;
  const out = lines.map((line) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], len: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.len) fence = null;
      return line;
    }
    if (fence) return line;
    if (/^\s{4,}\S/.test(line)) return line; // 缩进代码块
    return processLine(line);
  });
  return out.join('\n');
}
