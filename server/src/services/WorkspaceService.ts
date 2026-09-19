import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';

/**
 * T00776（P0）：工作空间文件搜索 / 按需读文件 / 忽略配置 / 上下文预算。
 * 设计基准（T00772 评估报告）：本地检索边界——只访问 workspace_path 内文件；
 * 关键词检索默认可用（WorkBuddy 模式），向量语义检索留给 P2。
 */

/** 内置忽略（目录名/文件名精确匹配 + 常见敏感文件），与 .mtaskignore 叠加生效 */
const DEFAULT_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'release', 'release2', 'release3', 'release4', 'release5', 'release6', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.workbuddy', '.trae', 'dist_electron']);
const DEFAULT_IGNORE_FILES = new Set(['.env', '.env.local', '.env.production', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.mtaskignore']);

/** 全文检索的文件体积上限（超过只做文件名匹配）与单行/单文件截断 */
const SEARCH_FILE_MAX_BYTES = 1024 * 1024;
const SEARCH_SNIPPET_MAX = 240;
const SEARCH_LIMIT = 50;
const READ_LINE_MAX_CHARS = 500;

/**
 * T00786：检索扫描预算——命中 50 条会自然早退，但「无命中 / 弱命中」路径原先会同步读完
 * 整棵工作空间（逐文件 readFileSync + 全文 includes），大仓库下秒级阻塞 Node 事件循环。
 * 这里给扫描加双预算（文件数 + 累计读取字节），超限即停并把 partial 标记透出，
 * 把最坏情形从「全树遍历」压到「有界扫描」。
 *
 * 取值依据（2026-09-19 实测，3000×40 行 ts 工作空间）：
 *   2000 文件 → 无命中 710ms（仍偏慢）；500 文件 → <200ms；
 *   memo 预扫描（T00782）不受此限制，它一次摊平整棵树后供全部关键词复用。
 * 折中取 800：单次关键词检索（用户手输场景）把事件循环阻塞控制在百毫秒量级，
 * 同时覆盖绝大多数真实仓库的「前 800 个可检索文件内即可命中」需求；
 * 漏检由 partial 标记提示，需要精确结果时可走目录级 glob 缩小范围。
 */
const SEARCH_MAX_FILES = 800;                  // 单次检索最多扫描的文件数
const SEARCH_MAX_BYTES = 24 * 1024 * 1024;     // 单次检索最多读取的内容字节数（24MB）

/**
 * T00782：memo 预扫描的独立预算——它是「扫一次供 5 分钟内全部关键词复用」，
 * 摊薄后单次成本远低于逐关键词检索，因此允许更大上限（约 4 倍）。
 */
const MEMO_MAX_FILES = 3000;
const MEMO_MAX_BYTES = 96 * 1024 * 1024;

/**
 * T00782 M-1：检索结果 memo 缓存——organize 批量梳理时每个任务都对若干关键词各调一次
 * autoContext → search 全树扫描（10 任务 × 最多 11 关键词 = 最多 110 次全树扫描）。
 * 按 (projectId) 缓存整棵树的「关键词 → 命中」结果，同一批任务共享一次扫描。
 * 5 分钟 TTL：工作空间是用户源码，短时间内的检索结果足够新鲜。
 */
const SEARCH_MEMO_TTL_MS = 5 * 60 * 1000;
/** T00782 N-8：符号索引条数上限（原为散落字面量 5000，抽出常量供 walk 入口与循环共用） */
const SYMBOL_LIMIT = 5000;
interface SearchMemo {
  at: number;
  /** 本次预扫描把整棵树里「每个文件的可检索行」摊平后常驻，供任意关键词零 IO 复用（text 已小写） */
  lines: Array<{ path: string; line: number; text: string }>;
  /** 全部可检索文件的相对路径（供文件名命中匹配） */
  files: string[];
  truncated: boolean;
  scannedFiles: number;
}
const searchMemo = new Map<string, SearchMemo>();
/** 索引/换绑后必须失效（工作空间内容已变），由 refreshSymbols / clearSymbols 调用 */
function invalidateSearchMemo(projectId?: string): void {
  if (projectId) searchMemo.delete(projectId);
  else searchMemo.clear();
}

/**
 * T00786：检索结果数组 + 附加元信息。仍是一个普通数组（保持既有调用方与前端契约不变），
 * 只挂两个额外属性用于「结果可能不完整」的提示与可观测性。
 */
export type SearchHits = Array<{ path: string; line: number; snippet: string }> & {
  /** true = 因扫描预算（文件数/字节数）提前结束，结果可能不完整 */
  partial?: boolean;
  /** 本次实际扫描（读取正文）的文件数 */
  scannedFiles?: number;
};


/** 上下文预算（T00776-4：统一截断策略，替换各处硬编码） */
export const ContextBudget = {
  treeChars: 4000,          // 目录树
  fileSnippetChars: 2500,   // 单文件片段
  searchHitsChars: 3000,    // 检索增强注入（T00777）
  prdContextChars: 6000,    // PRD 原文（与 util/prdContext 一致）
  /** 保头保尾截断：超限时中间替换为省略说明 */
  headTail(text: string, limit: number, label: string): string {
    if (text.length <= limit) return text;
    const half = Math.floor(limit / 2);
    return `${text.slice(0, half)}\n\n……（${label}中段略去 ${text.length - limit} 字符）……\n\n${text.slice(-half)}`;
  },
};

interface IgnoreRule { re: RegExp; raw: string }

/** glob → RegExp：** 任意层级、* 段内任意、? 单字符；不含 / 的 pattern 匹配任意路径段 */
function globToRegex(pattern: string): RegExp {
  const p = pattern.trim().replace(/^\.\//, '').replace(/\/$/, '');
  const parts: string[] = [];
  let rest = p;
  while (rest.length > 0) {
    if (rest.startsWith('**')) { parts.push('.*'); rest = rest.slice(2); if (rest.startsWith('/')) rest = rest.slice(1); }
    else if (rest.startsWith('*')) { parts.push('[^/]*'); rest = rest.slice(1); }
    else if (rest.startsWith('?')) { parts.push('[^/]'); rest = rest.slice(1); }
    else { parts.push(rest[0].replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)); rest = rest.slice(1); }
  }
  return new RegExp(`(^|/)${parts.join('')}$`, 'i');
}

/** H-2 修复：glob 模式入口防护——字符白名单 + 长度上限，拒绝嵌套量词类 ReDoS 输入 */
function assertSafeGlob(glob: string): void {
  if (glob.length > 128) throw new Error('glob 模式过长（上限 128 字符）');
  if (!/^[\w\-.*?/\s]+$/.test(glob)) throw new Error('glob 模式仅允许字母/数字/与 * ? / - _ 字符');
  if (/\*{3,}/.test(glob)) throw new Error('glob 模式不允许多重 * 连用');
}

/** 项目的忽略规则：内置默认 + workspace 根 .mtaskignore（每行一条 glob，# 注释）。M-4：导出供 loadWorkspaceContext 等共用单一规则源 */
export function loadIgnoreRules(workspacePath: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const push = (raw: string) => {
    const s = raw.trim();
    if (!s || s.startsWith('#') || s === '/') return;
    try { rules.push({ re: globToRegex(s), raw: s }); } catch { /* 非法行忽略 */ }
  };
  for (const d of DEFAULT_IGNORE_DIRS) push(`${d}/`);
  for (const f of DEFAULT_IGNORE_FILES) push(f);
  try {
    const lines = readFileSync(join(workspacePath, '.mtaskignore'), 'utf8').split(/\r?\n/);
    for (const l of lines) push(l);
  } catch { /* 无 .mtaskignore */ }
  return rules;
}

function isIgnored(relPosix: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  // 目录型规则（如 'secrets/'）需命中任意祖先目录段——取全部前缀路径逐条测试
  const segs = relPosix.split('/');
  const prefixes = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('/'));
  const candidates = [relPosix, ...(isDir ? [`${relPosix}/`] : []), ...prefixes];
  for (const r of rules) {
    for (const c of candidates) {
      if (r.re.test(c)) return true;
    }
  }
  return false;
}

/** M-4：导出忽略判定（供 PrdGenService.loadWorkspaceContext 等共用，消除双轨规则） */
export { isIgnored };

function getProjectWorkspace(projectId: string): { workspace: string; rules: IgnoreRule[] } {
  const row = getDb().prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path: string | null } | undefined;
  if (!row) throw new Error('项目不存在');
  if (!row.workspace_path) throw new Error('该项目未配置工作空间（项目管理 → 选择工作空间）');
  let st;
  try { st = statSync(row.workspace_path); } catch { throw new Error('工作空间目录不可访问（已移动或删除？）'); }
  if (!st.isDirectory()) throw new Error('工作空间路径不是目录');
  return { workspace: row.workspace_path, rules: loadIgnoreRules(row.workspace_path) };
}

/** 防目录穿越：解析后必须仍在 workspace 内 */
function safeResolve(workspace: string, relPath: string): string {
  const abs = resolve(workspace, relPath);
  const root = resolve(workspace);
  // T00783-N7：Windows 卷名/盘符大小写不敏感（c:\ws vs C:\ws），比较前统一小写。
  // 走查 L-3 纠正：仅 Win32 做小写比较——POSIX 文件系统大小写敏感，
  // 全平台 toLowerCase 会把 /ws/Data 项目对 /ws/data/* 的访问放行（越界检查失效）
  const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const inside = abs === root || norm(abs).startsWith(norm(root) + sep);
  if (!inside) throw new Error('路径越界：目标不在工作空间内');
  return abs;
}

interface SearchCtx {
  rules: IgnoreRule[];
  globRe: RegExp | null;
  needle: string;
  hits: Array<{ path: string; line: number; snippet: string }>;
  // T00786：扫描预算计数器（无命中路径的兜底闸门）
  scannedFiles: number;
  scannedBytes: number;
  budgetExceeded: boolean;
}

const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf', '.mp4', '.db']);

/** T00786：预算是否已耗尽——文件数或累计字节任一超限即停（供 walk/visit 统一判定） */
function budgetHit(ctx: SearchCtx): boolean {
  return ctx.scannedFiles >= SEARCH_MAX_FILES || ctx.scannedBytes >= SEARCH_MAX_BYTES;
}

/** 全文匹配单个文件：最多 3 条命中，命中追加进 ctx.hits（跳过大文件与二进制内容）。
 *  T00786：返回本次实际读取的字节数（供调用方累加扫描预算）；跳过/读取失败返回 0。 */
function scanFileContent(abs: string, relChild: string, needle: string, hits: Array<{ path: string; line: number; snippet: string }>): number {
  let buf: Buffer;
  try { buf = readFileSync(abs); } catch { return 0; }
  if (buf.length > SEARCH_FILE_MAX_BYTES) return 0;
  const text = buf.toString('utf8');
  if (text.includes('\0')) return 0; // 二进制
  const lines = text.split(/\r?\n/);
  let perFile = 0;
  for (let i = 0; i < lines.length && perFile < 3 && hits.length < SEARCH_LIMIT; i++) {
    const idx = lines[i].toLowerCase().indexOf(needle);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 60);
    hits.push({ path: relChild, line: i + 1, snippet: lines[i].slice(start, start + SEARCH_SNIPPET_MAX).trim() });
    perFile++;
  }
  return buf.length;
}

/** 目录递归：忽略规则 → 目录下钻 → glob 过滤 → 文件名/全文命中（T00786：带扫描预算） */
function searchWalk(ctx: SearchCtx, dir: string, rel: string): void {
  if (ctx.hits.length >= SEARCH_LIMIT || budgetHit(ctx)) { if (budgetHit(ctx)) ctx.budgetExceeded = true; return; }
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch { return; }
  for (const e of entries) {
    if (ctx.hits.length >= SEARCH_LIMIT) return;
    if (budgetHit(ctx)) { ctx.budgetExceeded = true; return; }
    searchVisitEntry(ctx, dir, rel, e);
  }
}

/** 单条目录项处理：忽略规则 → 目录下钻 / glob 过滤 → 文件名命中 / 全文命中 */
function searchVisitEntry(ctx: SearchCtx, dir: string, rel: string, e: { name: string; isDir: boolean }): void {
  const relChild = rel ? `${rel}/${e.name}` : e.name;
  if (isIgnored(relChild, e.isDir, ctx.rules)) return;
  const abs = join(dir, e.name);
  if (e.isDir) { searchWalk(ctx, abs, relChild); return; }
  if (ctx.globRe && !ctx.globRe.test(relChild)) return; // H-3：glob 过滤对文件名命中同样生效（原先被绕过）
  // 文件名匹配
  if (relChild.toLowerCase().includes(ctx.needle)) {
    ctx.hits.push({ path: relChild, line: 0, snippet: '(文件名命中)' });
    return;
  }
  // 全文匹配（跳过二进制类扩展）
  if (BINARY_EXTS.has(extname(e.name).toLowerCase())) return;
  // T00786：进入正文扫描前记账（文件名命中不消耗字节预算，但仍计入文件数上限）
  ctx.scannedFiles++;
  ctx.scannedBytes += scanFileContent(abs, relChild, ctx.needle, ctx.hits);
}

interface SymbolExtractor { exts: string[]; kind: string; re: RegExp }

/** better-sqlite3 的 Statement 类型（prepare 返回值），此处只用到 run()；用 any 承接重载联合类型 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStatement = { run: (...args: any[]) => { changes: number } };

interface SymbolIndexCtx {
  db: ReturnType<typeof getDb>;
  projectId: string;
  rules: IgnoreRule[];
  extractors: SymbolExtractor[];
  countExts: Set<string>;
  workspaceAbs: string;
  files: number;
  symbols: number;
  skipped: number;
  /** T00790②：启动时一次性载入的 (path → 已知 mtime) 映射，消除逐文件 SELECT MAX(file_mtime) 的 N+1 */
  knownMtime: Map<string, number>;
  /** 准备语句复用（避免逐文件重复 prepare） */
  insStmt: AnyStatement;
  delStmt: AnyStatement;
}

/** 单文件符号提取：mtime 未变跳过；变化则重建该文件条目并按 extractor 正则抽取（上限 200/文件） */
function indexFileSymbols(ctx: SymbolIndexCtx, abs: string, relChild: string): void {
  const { db, projectId } = ctx;
  let st;
  try { st = statSync(abs); } catch { return; }
  const mtime = Math.floor(st.mtimeMs);
  // T00790②：改为查内存 Map（原先每个文件一条 SELECT MAX(file_mtime)）
  if (ctx.knownMtime.get(relChild) === mtime) { ctx.skipped++; return; }
  // 提取
  const text = (() => { try { return readFileSync(abs, 'utf8'); } catch { return null; } })();
  if (text === null || text.includes('\0')) return;
  ctx.delStmt.run(projectId, relChild);
  for (const ex of ctx.extractors) {
    if (!ex.exts.includes(extname(relChild).toLowerCase())) continue;
    let m: RegExpExecArray | null;
    const re = new RegExp(ex.re.source, ex.re.flags);
    let count = 0;
    while ((m = re.exec(text)) !== null && count < 200) {
      const line = text.slice(0, m.index).split('\n').length;
      ctx.insStmt.run(uuid(), projectId, relChild, m[1], line, ex.kind, mtime, ctx.workspaceAbs);
      ctx.symbols++; count++;
    }
  }
  ctx.knownMtime.set(relChild, mtime);
  ctx.files++;
}

/** 符号索引目录递归（T00782 N-8：符号上限判断前置到 walk 入口，避免「已达上限仍全量 readdir 递归」；
 *  T00790①：整体由 db.transaction() 包裹，把逐符号 autocommit 收敛为单次提交） */
function symbolIndexWalk(ctx: SymbolIndexCtx, dir: string, rel: string): void {
  if (ctx.symbols >= SYMBOL_LIMIT) return; // N-8：入口即判，不再进入 readdir
  let entries: Array<{ name: string; isDir: boolean }>;
  try { entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() })); } catch { return; }
  for (const e of entries) {
    if (ctx.symbols >= SYMBOL_LIMIT) return; // 防炸上限（保持原语义，仅在循环内提前退出）
    const relChild = rel ? `${rel}/${e.name}` : e.name;
    if (isIgnored(relChild, e.isDir, ctx.rules)) continue;
    const abs = join(dir, e.name);
    if (e.isDir) { symbolIndexWalk(ctx, abs, relChild); continue; }
    if (!ctx.countExts.has(extname(e.name).toLowerCase())) continue;
    indexFileSymbols(ctx, abs, relChild);
  }
}

/**
 * T00782 M-1：获取（必要时构建）某项目的检索 memo。
 *
 * 预扫描一次整棵工作空间，把「可检索行」摊平为 {path,line,text} 列表常驻内存（≤5 分钟）。
 * 与 `search()` 的区别：search 是「给一个关键词、扫一次树」；本函数是「扫一次树、供任意关键词复用」。
 * 预算独立于 `search`（MEMO_MAX_FILES / MEMO_MAX_BYTES，约 4 倍上限）：它扫一次供
 * 5 分钟内的全部关键词复用，摊薄后单次成本远低于逐关键词检索，超限同样置 truncated。
 */
function getSearchMemo(projectId: string): SearchMemo {
  const cached = searchMemo.get(projectId);
  if (cached && Date.now() - cached.at < SEARCH_MEMO_TTL_MS) return cached;

  const { workspace, rules } = getProjectWorkspace(projectId);
  const lines: SearchMemo['lines'] = [];
  const files: string[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let truncated = false;

  const walk = (dir: string, rel: string): void => {
    if (scannedFiles >= MEMO_MAX_FILES || scannedBytes >= MEMO_MAX_BYTES) { truncated = true; return; }
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch { return; }
    for (const e of entries) {
      if (scannedFiles >= MEMO_MAX_FILES || scannedBytes >= MEMO_MAX_BYTES) { truncated = true; return; }
      const relChild = rel ? `${rel}/${e.name}` : e.name;
      if (isIgnored(relChild, e.isDir, rules)) continue;
      const abs = join(dir, e.name);
      if (e.isDir) { walk(abs, relChild); continue; }
      if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue;
      let buf: Buffer;
      try { buf = readFileSync(abs); } catch { continue; }
      if (buf.length > SEARCH_FILE_MAX_BYTES) continue;
      const text = buf.toString('utf8');
      if (text.includes('\0')) continue;
      scannedFiles++;
      scannedBytes += buf.length;
      files.push(relChild);
      const raw = text.split(/\r?\n/);
      for (let i = 0; i < raw.length; i++) {
        const t = raw[i];
        if (!t) continue;
        lines.push({ path: relChild, line: i + 1, text: t.toLowerCase() });
      }
    }
  };
  walk(workspace, '');

  const memo: SearchMemo = { at: Date.now(), lines, files, truncated, scannedFiles };
  searchMemo.set(projectId, memo);
  return memo;
}

export const WorkspaceService = {
  /**
   * 文件搜索：文件名匹配 + 全文关键词（大小写不敏感），返回 {path, line, snippet}（限 50 条）。
   * q 必填（≥2 字符）；glob 可选（限定文件名模式，如 *.ts）。
   */
  search(projectId: string, q: string, glob?: string): SearchHits {
    const query = q?.trim();
    if (!query || query.length < 2) throw new Error('q 必填且至少 2 个字符');
    const { workspace, rules } = getProjectWorkspace(projectId);
    if (glob) assertSafeGlob(glob); // H-2：入口防护（ReDoS / 非法字符）
    const ctx: SearchCtx = {
      rules,
      globRe: glob ? globToRegex(glob) : null,
      needle: query.toLowerCase(),
      hits: [],
      scannedFiles: 0,
      scannedBytes: 0,
      budgetExceeded: false,
    };
    searchWalk(ctx, workspace, '');
    // T00786：把「是否因预算截断」透出为附加属性（数组本身仍是原结构，前端与既有调用方零改动）
    const out = ctx.hits as SearchHits;
    out.partial = ctx.budgetExceeded;
    out.scannedFiles = ctx.scannedFiles;
    return out;
  },

  /**
   * 按需读文件：行号范围（offset 0 起，limit ≤400 行），单行截断 500 字符，总文本 ≤64KB。
   * 路径防穿越 + 忽略规则同样生效（.mtaskignore 内的文件不可读）。
   */
  readFile(projectId: string, relPath: string, offset = 0, limit = 200): { path: string; totalLines: number; offset: number; lines: Array<{ n: number; text: string }>; truncated: boolean } {
    const { workspace, rules } = getProjectWorkspace(projectId);
    const relPosix = relPath.replaceAll('\\', '/').replace(/^\/+/, '');
    if (isIgnored(relPosix, false, rules)) throw new Error('该文件在忽略列表内（.mtaskignore / 内置规则），不可读取');
    const abs = safeResolve(workspace, relPosix);
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch { throw new Error('文件不存在或不可读'); }
    const text = buf.toString('utf8');
    if (text.includes('\0')) throw new Error('二进制文件不支持文本读取');
    const lines = text.split(/\r?\n/);
    const off = Math.max(0, Math.min(Math.trunc(offset), lines.length));
    const lim = Math.max(1, Math.min(Math.trunc(limit), 400));
    const slice = lines.slice(off, off + lim).map((t, i) => ({ n: off + i + 1, text: t.length > READ_LINE_MAX_CHARS ? t.slice(0, READ_LINE_MAX_CHARS) + '…' : t }));
    // 总文本预算 64KB：超限截断行集合
    let used = 0;
    const out: Array<{ n: number; text: string }> = [];
    for (const l of slice) {
      used += l.text.length + 1;
      if (used > 64 * 1024) { out.push({ n: l.n, text: '…（已达单次读取 64KB 上限）' }); break; }
      out.push(l);
    }
    return { path: relPosix, totalLines: lines.length, offset: off, lines: out, truncated: off + out.length < lines.length };
  },

  // ---------- T00777：轻量符号索引（P1：读得懂） ----------

  /** 符号提取规则（语言无关正则，非完整 LSP——够 Agent 定位用） */
  SYMBOL_EXTRACTORS: [
    { exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], kind: 'function', re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
    { exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], kind: 'class', re: /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g },
    { exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], kind: 'const', re: /export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/g },
    { exts: ['.py'], kind: 'function', re: /(?:^|\n)\s*def\s+([A-Za-z_]\w*)/g },
    { exts: ['.py'], kind: 'class', re: /(?:^|\n)\s*class\s+([A-Za-z_]\w*)/g },
    { exts: ['.java', '.cs'], kind: 'class', re: /(?:(?:public|private|protected|internal|final|abstract|static)\s+)*(?:class|interface|enum)\s+([A-Za-z_]\w*)/g },
  ],

  /** T00780：清空某项目的符号索引（工作空间换绑/解绑时用） */
  clearSymbols(projectId: string): number {
    const r = getDb().prepare('DELETE FROM workspace_symbols WHERE project_id = ?').run(projectId);
    invalidateSearchMemo(projectId); // T00782：索引清空 → 检索 memo 同步失效
    return r.changes;
  },

  /** 增量刷新符号索引：mtime 未变的文件跳过；变化则重建该文件条目。返回统计。
   *  T00780：工作空间根路径变化（换绑）时先清空旧索引，避免查到已不属于当前工作空间的路径。
   *  T00790①：整轮重建包在单个事务里——原先逐符号 DELETE/INSERT 各自 autocommit
   *  （每条一次 fsync），600 文件冷建索引实测 1655ms；事务化后收敛为一次提交。
   *  T00790②：启动时一次性载入 (path → mtime) Map，替代逐文件 SELECT MAX(file_mtime) 的 N+1。 */
  refreshSymbols(projectId: string): { files: number; symbols: number; skipped: number; cleared: number } {
    const { workspace, rules } = getProjectWorkspace(projectId);
    const db = getDb();
    // 根路径与建索引时不同（换绑）→ 旧索引整体失效，清空重建
    const cleared = db.prepare('DELETE FROM workspace_symbols WHERE project_id = ? AND workspace <> ?').run(projectId, resolve(workspace)).changes;
    // T00790②：一次查询建 (path → 已知 mtime) 映射（同 path 取最大 mtime，与原 MAX 语义一致）
    const knownMtime = new Map<string, number>();
    for (const row of db.prepare('SELECT path, MAX(file_mtime) AS m FROM workspace_symbols WHERE project_id = ? GROUP BY path').all(projectId) as Array<{ path: string; m: number | null }>) {
      if (row.m !== null) knownMtime.set(row.path, row.m);
    }
    const ctx: SymbolIndexCtx = {
      db, projectId, rules, extractors: this.SYMBOL_EXTRACTORS,
      countExts: new Set(this.SYMBOL_EXTRACTORS.flatMap((x) => x.exts)),
      workspaceAbs: resolve(workspace),
      files: 0, symbols: 0, skipped: 0,
      knownMtime,
      insStmt: db.prepare('INSERT INTO workspace_symbols (id, project_id, path, symbol, line, kind, file_mtime, workspace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      delStmt: db.prepare('DELETE FROM workspace_symbols WHERE project_id = ? AND path = ?'),
    };
    // T00790①：walk 全程（含所有 DELETE/INSERT）在单事务内执行
    const run = db.transaction(() => symbolIndexWalk(ctx, workspace, ''));
    run();
    invalidateSearchMemo(projectId); // T00782：索引刷新后检索 memo 失效（内容可能已变）
    return { files: ctx.files, symbols: ctx.symbols, skipped: ctx.skipped, cleared };
  },

  /** 符号查询：symbol LIKE 匹配（q ≥2 字符），返回 {path, symbol, line, kind} */
  querySymbols(projectId: string, q: string, limit = 30): Array<{ path: string; symbol: string; line: number; kind: string }> {
    const query = q?.trim();
    if (!query || query.length < 2) throw new Error('q 必填且至少 2 个字符');
    const { workspace } = getProjectWorkspace(projectId); // 项目/工作空间校验
    const db = getDb();
    // 走查 L-1：SQL 层先按建索引时的根路径过滤（T00780 workspace 列）——
    // 换绑残留行（含 workspace='' 的历史行）在库层即被排除，statSync 只兜「文件被外部删除」一种场景
    const rows = db.prepare(
      'SELECT path, symbol, line, kind FROM workspace_symbols WHERE project_id = ? AND workspace = ? AND symbol LIKE ? ORDER BY path, line LIMIT ?',
    ).all(projectId, resolve(workspace), `%${query}%`, Math.min(Math.trunc(limit), 100)) as Array<{ path: string; symbol: string; line: number; kind: string }>;
    // T00780：孤儿防护——索引行存在但文件已不在当前工作空间（换绑未刷新/文件被删）时过滤掉，
    // 避免把已不属于本项目的路径返回给调用方
    return rows.filter((r) => {
      try { statSync(resolve(workspace, r.path)); return true; } catch { return false; }
    });
  },

  /**
   * 检索增强注入（T00777）：按关键词跑搜索，组装预算内的片段文本（供 AI prompt 注入）。
   * keywords：词组数组（英文 token / 标题短语）；返回空串表示无可注入内容。
   *
   * T00782 M-1：原实现对**每个关键词**各调一次 `search()`（各自全树遍历 + 逐文件 readFileSync）。
   * organize 批量梳理 10 个任务 × 最多 11 个关键词 = 最多 110 次全树扫描，是任务链路的主要耗时来源。
   * 现改为：首次调用触发**一次**全树预扫描，把所有「可检索行」摊平进 memo（按 projectId 缓存 5 分钟），
   * 后续任意关键词（含跨任务）都在内存里零 IO 匹配，扫描次数从 O(任务数×关键词数) 收敛为 O(1)/5min。
   */
  autoContext(projectId: string, keywords: string[], budgetChars = ContextBudget.searchHitsChars): string {
    if (!keywords || keywords.length === 0) return '';
    const memo = getSearchMemo(projectId);
    const collected: Array<{ path: string; line: number; snippet: string }> = [];
    const seen = new Set<string>();
    for (const kw of keywords) {
      if (collected.length >= 12) break;
      const needle = kw.toLowerCase();
      if (needle.length < 2) continue;
      // 文件路径命中也算（与 search() 的「文件名命中」语义对齐）
      for (const f of memo.files) {
        if (f.toLowerCase().includes(needle)) {
          const key = `${f}:0`;
          if (!seen.has(key)) {
            seen.add(key);
            collected.push({ path: f, line: 0, snippet: '(文件名命中)' });
            if (collected.length >= 12) break;
          }
        }
      }
      if (collected.length >= 12) break;
      // 正文行匹配（memo 已摊平，无任何文件 IO）
      for (const l of memo.lines) {
        if (!l.text.includes(needle)) continue;
        const key = `${l.path}:${l.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const start = Math.max(0, l.text.indexOf(needle) - 60);
        collected.push({ path: l.path, line: l.line, snippet: l.text.slice(start, start + SEARCH_SNIPPET_MAX).trim() });
        if (collected.length >= 12) break;
      }
    }
    if (collected.length === 0) return '';
    const body = collected.map((h) => `${h.path}:${h.line} — ${h.snippet}`).join('\n');
    return ContextBudget.headTail(`相关代码片段（关键词检索 Top ${collected.length}）：\n${body}`, budgetChars, '检索片段 ');
  },

  /** T00782：主动失效检索 memo（供换绑/索引刷新后调用；外部集成测试亦可用） */
  invalidateSearchCache(projectId?: string): void {
    invalidateSearchMemo(projectId);
  },

  /**
   * 关键词提取（T00777）：英文标识符 token 全取（≤6 个）+ 中文 2~4 字滑窗短语（≤5 个，去虚词）。
   * 供检索增强注入从任务标题/需求文本生成搜索词。
   */
  extractKeywords(text: string): string[] {
    if (!text) return [];
    const out: string[] = [];
    for (const m of text.matchAll(/[A-Za-z_]\w{2,}/g)) {
      const w = m[0];
      if (!out.includes(w) && !['the', 'and', 'for', 'with', 'const', 'let', 'function', 'return', 'this'].includes(w.toLowerCase())) out.push(w);
      if (out.length >= 6) break;
    }
    // T00783-N9：英文标识符已足够（≥3 个）时不再补中文词——中文 2~4 字滑窗会产生「需求/模块/功能」等泛词噪声
    if (out.length >= 3) return out;
    appendChineseKeywords(out, text);
    return out;
  },
};

/** 中文 2~4 字滑窗补词（累计 ≤11 个，去虚词/重复） */
function appendChineseKeywords(out: string[], text: string): void {
  const cn = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const stop = new Set(['我们', '你们', '这个', '那个', '需要', '可以', '应该', '以及', '或者', '然后', '并且']);
  for (const seg of cn) {
    for (let len = 4; len >= 2 && out.length < 11; len -= 2) {
      for (let i = 0; i + len <= seg.length && out.length < 11; i += len) {
        const w = seg.slice(i, i + len);
        if (!stop.has(w) && !out.includes(w)) out.push(w);
      }
    }
    if (out.length >= 11) break;
  }
}
