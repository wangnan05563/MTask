import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute, parse, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * T00771 二轮：工作空间的「服务端目录浏览」——纯浏览器（Vite dev / 无 Electron 壳）下渲染进程
 * 既调不到原生目录对话框，也拿不到 `File.path`（绝对路径），「打开本地文件夹」此前只能靠
 * `<input webkitdirectory>` 猜路径，实际取不到值。这里由服务端枚举本机目录供前端选择，
 * 作为该入口的第三级降级（① Electron 原生对话框 → ② 本服务端枚举）。
 *
 * 安全边界（本地单机应用，仍按最小暴露面设计）：
 * - 只列目录，不读任何文件内容、不返回文件；
 * - 路径必须是绝对路径且真实存在（否则 400），不做路径拼接/通配；
 * - 单目录条目上限 MAX_ENTRIES，超出截断并标记，避免超大目录拖垮响应。
 */

/** 单目录返回的条目上限 */
const MAX_ENTRIES = 500;

/** 系统级噪声目录：列出无意义且常因权限报错，直接跳过 */
const SKIP_NAMES = new Set(['System Volume Information', '$RECYCLE.BIN', 'Config.Msi']);

export interface DirEntry { name: string; path: string }

export interface DirListing {
  /** 当前目录绝对路径（根列表时为空串） */
  path: string;
  /** 上级目录；已在根（盘符根 / 文件系统根）或处于根列表时为 null */
  parent: string | null;
  /** 子目录（按名称不区分大小写排序） */
  entries: DirEntry[];
  /** 是否因条目上限被截断 */
  truncated: boolean;
  /** 快捷入口：本机盘符根 + 用户主目录，供前端做「快速跳转」 */
  roots: string[];
  /** 用户主目录（默认落地位置） */
  home: string;
}

/**
 * 枚举本机磁盘根：Windows 逐个探测盘符（A~Z 的 `X:\`），非 Windows 返回 `['/']`。
 * 不依赖外部命令（wmic / PowerShell 在受限环境可能不可用）。
 */
function listRoots(): string[] {
  if (process.platform !== 'win32') return [sep];
  const roots: string[] = [];
  for (let c = 65; c <= 90; c += 1) {
    const root = `${String.fromCodePoint(c)}:\\`;
    try {
      if (existsSync(root)) roots.push(root);
    } catch { /* 个别盘符可能抛错（如未就绪的光驱），跳过 */ }
  }
  return roots;
}

/** 列子目录（仅目录，跳过系统噪声目录与隐藏目录，失败项静默跳过） */
function listChildDirs(dir: string): { entries: DirEntry[]; truncated: boolean } {
  const names: string[] = [];
  let truncated = false;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (names.length >= MAX_ENTRIES) { truncated = true; break; }
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_NAMES.has(e.name)) continue;
      names.push(e.name);
    }
  } catch {
    // 无权限 / 目录已被删除：返回空列表（调用方仍可看到当前路径并返回上级）
    return { entries: [], truncated: false };
  }
  names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return { entries: names.map((n) => ({ name: n, path: join(dir, n) })), truncated };
}

/**
 * 列出目录内容：path 为空 → 返回磁盘根列表；否则返回该目录的子目录。
 * 路径非法（非绝对 / 不存在 / 非目录）时抛错，由路由转 400 给前端可读提示。
 */
export function listDirectories(rawPath: string): DirListing {
  const roots = [...listRoots(), homedir()];
  const bases: DirListing = { path: '', parent: null, entries: [], truncated: false, roots, home: homedir() };
  const target = (rawPath ?? '').trim();
  if (!target) {
    // 根列表：把每个盘符根与主目录作为可选条目（用户不必先手工输入路径）
    return { ...bases, entries: roots.map((p) => ({ name: p === homedir() ? `主目录（${homedir()}）` : p, path: p })) };
  }
  if (!isAbsolute(target)) throw new Error(`路径须为绝对路径（收到：${target}）`);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(target);
  } catch {
    throw new Error(`路径不存在或不可访问：${target}`);
  }
  if (!st.isDirectory()) throw new Error(`不是文件夹：${target}`);
  const parentPath = dirname(target);
  // 盘符根（C:\）或文件系统根（/）的 dirname 等于自身 → 视为最顶层，无上级
  const atRoot = parentPath === target || parse(target).root === target;
  const { entries, truncated } = listChildDirs(target);
  return { path: target, parent: atRoot ? null : parentPath, entries, truncated, roots, home: homedir() };
}
