import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { isWordFieldToken } from '../util/wordFields'; // T00814：关键词提取排除 Word 域代码标识符

/**
 * T00776（P0）：工作空间文件搜索 / 按需读文件 / 忽略配置 / 上下文预算。
 * 设计基准（T00772 评估报告）：本地检索边界——只访问 workspace_path 内文件；
 * 关键词检索默认可用（WorkBuddy 模式），向量语义检索留给 P2。
 */

/** 内置忽略（目录名/文件名精确匹配 + 常见敏感文件），与 .mtaskignore 叠加生效 */
export const DEFAULT_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'release', 'release2', 'release3', 'release4', 'release5', 'release6', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.workbuddy', '.trae', 'dist_electron']);
export const DEFAULT_IGNORE_FILES = new Set(['.env', '.env.local', '.env.production', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.mtaskignore']);

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
/**
 * T00782 N-8 → T02280（业主裁决选项 A，T03444 从 5cf3621 取回）：符号索引条数上限按工作空间规模自适应。
 *
 * 旧值是**绝对条数**上限 5000，而它不是时间的稳定代理：bemp 实测同一枚 5000，在高密度段只走
 * ~250 个文件，在低密度段要走 3,769~4,609 个文件——同一上限耗时差 14 倍，冷建因此要 23 轮
 * 刷新才收敛到全量。现按「本轮预计要产出的符号条数」定上限：`clamp(候选文件数 × 观测密度, 5000, 50000)`，
 * 观测密度 = 已索引行的 符号/文件 比。两个入参都取本轮本来就要读的现成料（`knownMtime` 的
 * 已索引文件数、T02210 树快照的候选文件数），不另起预扫描；冷建既无候选规模也无密度可依 →
 * 不设门槛直接取上界。
 * 由此得出一条可判读冷建成本的不变量：**无快照轮次的上限恒等于 clamp(累计行数)**——candidates
 * 取的就是 `knownMtime` 的已索引文件数，乘回 density 即还原 rows。累计覆盖因此每轮至少翻倍，
 * 到上界 50000 后线性 +50000/轮。
 */
const SYMBOL_LIMIT_FLOOR = 5000;
const SYMBOL_LIMIT_CEIL = 50000;

/** T02280：本轮符号条数上限（每轮开始算一次，轮内不变；短路轮复述登记时的值而非重算） */
function symbolLimitFor(
  db: ReturnType<typeof getDb>,
  projectId: string,
  knownFiles: number,
  snapshotCandidateFiles: number | undefined,
): number {
  const candidates = Math.max(knownFiles, snapshotCandidateFiles ?? 0);
  if (candidates === 0) return SYMBOL_LIMIT_CEIL; // 冷建：规模与密度皆无观测
  const rows = (db.prepare('SELECT COUNT(*) AS n FROM workspace_symbols WHERE project_id = ?').get(projectId) as { n: number }).n;
  const density = knownFiles > 0 ? rows / knownFiles : 0;
  return Math.min(SYMBOL_LIMIT_CEIL, Math.max(SYMBOL_LIMIT_FLOOR, Math.round(candidates * density)));
}
/**
 * T02211：单个文件的字节上限——与检索侧 `SEARCH_FILE_MAX_BYTES` 同族同值。
 * 让路（T02200）以「一个文件」为最小工作单元，但那一单元的成本过去无界：一个几 MB 的
 * `.min.js`/`.map`/打包产物会让单次 `symbolWalkStep` 就跑几百毫秒（T02200 实测 380ms 尖峰
 * 即来自 bemp 的真实大文件），片间让出点形同虚设。
 * 取与检索侧同一个阈值不是巧合：超过它的正文本来就进不了 `search`/memo 的读取窗口
 * （两处都按 `SEARCH_FILE_MAX_BYTES` 直接返回 0/-1），索引它换来的检索召回为零，只赔上让路。
 */
const SYMBOL_FILE_MAX_BYTES = SEARCH_FILE_MAX_BYTES;
/**
 * T02200（T00782 遗留项续办）：符号索引与检索 memo 扫描的「让路」预算。
 * 原实现把整棵工作空间的遍历放在一个同步调用里（T00790① 又用单个事务包住全程，把本可让出的
 * 空隙合并成一段更长的独占临界区）。实测 bemp（6,984 文件）冷建 139,970ms、热刷 8,000~73,514ms，
 * 同窗口内 GET /api/projects 挂 12,418ms 后以 ECONNRESET 失败——而 AI 生成链路的检索增强正走这条路。
 * 现按时间片切分：片内一次提交，片间 setImmediate 让出事件循环。
 *   SYMBOL_SLICE_MS=25：单片只处理个位数文件，让出点足够密（25ms 远在交互接口可感延迟之内）。
 *   SYMBOL_INLINE_BUDGET_MS=300：小工作空间（含既有符号 API 测试用的临时目录）仍在一次请求内建完，
 *   契约不变；超预算的大仓库把余量交后台续跑，返回值以 deferred 明示，下次刷新自然补齐。
 */
const SYMBOL_SLICE_MS = 25;
const SYMBOL_INLINE_BUDGET_MS = 300;
/** T02200：memo 预扫描只让路、不延迟——本次生成就要用它的检索结果，故只切片，不设内联预算 */
const MEMO_SLICE_MS = 25;

/** T02200：让出事件循环一个宏任务，让只读接口在遍历片间获得服务机会 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

/**
 * T02210（承接 T02200 让路）：未变更热刷的短路通道。
 *
 * T02200 解决的是「谁在跑」（切片让路 + 后台续跑），本段解决的是「还要不要跑」：
 * 判定「哪些文件变了」原先必然要 stat 全量候选文件（bemp 实测 7,233 次 stat ≈ 1.3s，
 * 仍超 300ms 内联预算，deferred 恒为 true）。而「文件内容被改」这件事在文件系统上
 * 没有免费的探测手段——目录 mtime 只随增删改名变化，不随内容写入变化，因此
 * 「目录条目指纹」只能证明结构未变，不能证明内容未变。
 *
 * 所以短路必须有两个正交前提，缺一不可：
 *   ① 目录条目指纹一致（即时捕捉新增/删除/改名，含整目录增删）；
 *   ② 该工作空间的文件监视器自上次深扫以来零事件（捕捉内容写入）。
 * 监视器不可用/报错/事件丢失时 `unsupported` 置位，短路整体失效 → 退回 T02200 的原行为，
 * 宁可慢也不漏。另加两道护栏：深扫最长间隔 SYMBOL_DEEP_VERIFY_MS（监视器静默失效时的
 * 最坏收敛时间，与既有 SEARCH_MEMO_TTL_MS 同量级，不引入新的陈旧级别），以及
 * SYMBOL_FAST_PATH_MIN_FILES（小树 stat 本就几十毫秒，短路省不出量级，反而让语义多一层分支）。
 */
const SYMBOL_DEEP_VERIFY_MS = 5 * 60 * 1000;
const SYMBOL_FAST_PATH_MIN_FILES = 200;
/** 快照遍历的目录数上限：超限说明目录结构本身已是负担，放弃短路（返回 null 即走深扫） */
const SYMBOL_SNAPSHOT_MAX_DIRS = 20000;

/** relDir（posix 相对路径，根为 ''）→ 该目录未忽略条目的「名字+是否目录」摘要 */
type DirSnapshot = Map<string, string>;

interface TreeSnapshot {
  dirs: DirSnapshot;
  /** 上次深扫真正 stat 到的候选文件数；短路时用它如实回报 skipped */
  candidateFiles: number;
  /** T02211：上次深扫按字节上限跳过的文件数（短路时如实复述，不让规模分布被抹成 0） */
  oversized: number;
  /** T02280：登记本快照那轮实际生效的自适应上限（短路轮不进深扫，如实复述这个值而不是重算） */
  symbolLimit: number;
  /** 上次深扫完成时刻（配合 SYMBOL_DEEP_VERIFY_MS） */
  deepVerifiedAt: number;
  /** 上次深扫完成时刻的监视事件计数（事件数未变 = 期间无人改过文件） */
  eventsAtSnapshot: number;
}

const treeSnapshots = new Map<string, TreeSnapshot>();

interface WorkspaceWatch {
  workspaceAbs: string;
  watcher?: FSWatcher;
  /** 自挂监视器以来收到的变更/改名事件计数 */
  events: number;
  /** 平台不支持递归监视或监视器报错 → 短路整体停用（退回逐文件 stat 的原语义） */
  unsupported: boolean;
}

const workspaceWatches = new Map<string, WorkspaceWatch>();

/**
 * 监视事件路径是否落在忽略集内——这些路径永不入索引，它们的变动不该作废短路。
 * 祖先段直接按目录判定；末段要问文件系统：Windows 把「目录内增删条目」报成目录名本身
 * （事件路径就是一个裸的 `node_modules` / `.git`），按文件判定会让这类事件漏过过滤，
 * 短路在真实仓库里几乎命中不了。末段 stat 失败（刚被删/不可访问）保守按「未忽略」计，
 * 宁可多走一次深扫，也不放过真实变更。
 */
function watchEventIgnored(relPath: string, rules: IgnoreRule[], workspaceAbs: string): boolean {
  const segs = relPath.split(/[\\/]/).filter(Boolean);
  if (segs.length === 0) return false;
  for (let i = 0; i < segs.length - 1; i++) {
    if (isIgnored(segs.slice(0, i + 1).join('/'), true, rules)) return true;
  }
  let leafIsDir = false;
  try { leafIsDir = statSync(resolve(workspaceAbs, relPath)).isDirectory(); } catch { /* 已删除：按未忽略处理 */ }
  return isIgnored(segs.join('/'), leafIsDir, rules);
}

/**
 * 取（或建立）项目工作空间的递归文件监视器。
 * 换绑工作空间时关掉旧的、重建；建立失败（平台不支持 recursive / 目录不可读）只记
 * unsupported，不影响深扫本身。
 *
 * 事件按忽略规则过滤：`.git`/`node_modules` 的写入极频繁（提交、装依赖），但它们永不入索引，
 * 不过滤会让短路在真实仓库里几乎命中不了。忽略规则在每次刷新时重新载入，
 * 规则本身的变化由结构指纹差异兜住（条目集变了必然走深扫）。
 */
function ensureWorkspaceWatch(projectId: string, workspaceAbs: string, rules: IgnoreRule[]): WorkspaceWatch {
  const cur = workspaceWatches.get(projectId);
  if (cur && cur.workspaceAbs === workspaceAbs) return cur;
  if (cur?.watcher) { try { cur.watcher.close(); } catch { /* 已关闭 */ } }
  const state: WorkspaceWatch = { workspaceAbs: workspaceAbs, events: 0, unsupported: false };
  try {
    state.watcher = watch(workspaceAbs, { recursive: true }, (_event, filename) => {
      // 回调只做计数 + 一次末段 stat：真正的判定留在刷新入口，回调里不碰 db
      if (!filename) { state.events++; return; } // 无路径的事件（如溢出）无法归类，按「有变更」计
      if (!watchEventIgnored(String(filename), rules, workspaceAbs)) state.events++;
    });
    state.watcher.on('error', () => {
      state.unsupported = true;
      state.events++; // 静默失效也要让下一轮走深扫
      try { state.watcher?.close(); } catch { /* 已关闭 */ }
      state.watcher = undefined;
    });
  } catch {
    state.unsupported = true;
  }
  workspaceWatches.set(projectId, state);
  return state;
}

/** 关掉并移除监视器（工作空间解绑/清空索引时调用，避免句柄泄漏与跨目录误报） */
function dropWorkspaceWatch(projectId: string): void {
  const cur = workspaceWatches.get(projectId);
  if (cur?.watcher) { try { cur.watcher.close(); } catch { /* 已关闭 */ } }
  workspaceWatches.delete(projectId);
}

/** 只遍历目录（沿用同一忽略规则源），产出目录条目指纹；读不动的目录或超上限返回 null */
function buildDirSnapshot(workspace: string, rules: IgnoreRule[]): DirSnapshot | null {
  const dirs: DirSnapshot = new Map();
  const stack: Array<{ dir: string; rel: string }> = [{ dir: workspace, rel: '' }];
  while (stack.length > 0) {
    if (dirs.size >= SYMBOL_SNAPSHOT_MAX_DIRS) return null;
    const frame = stack.pop() as { dir: string; rel: string };
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(frame.dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch { return null; }
    const sig: string[] = [];
    for (const e of entries) {
      const relChild = frame.rel ? `${frame.rel}/${e.name}` : e.name;
      if (isIgnored(relChild, e.isDir, rules)) continue;
      sig.push(e.isDir ? `${e.name}/` : e.name);
      if (e.isDir) stack.push({ dir: join(frame.dir, e.name), rel: relChild });
    }
    sig.sort();
    dirs.set(frame.rel, sig.join('\u0000'));
  }
  return dirs;
}

function snapshotEqual(a: DirSnapshot, b: DirSnapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** 深扫完成后登记快照；快照不可得时清除旧快照（下次仍走深扫） */
function commitTreeSnapshot(projectId: string, workspace: string, rules: IgnoreRule[], candidateFiles: number, oversized: number, events: number, symbolLimit: number): void {
  const dirs = buildDirSnapshot(workspace, rules);
  if (!dirs) { treeSnapshots.delete(projectId); return; }
  treeSnapshots.set(projectId, { dirs, candidateFiles, oversized, symbolLimit, deepVerifiedAt: Date.now(), eventsAtSnapshot: events });
}
interface SearchMemo {
  at: number;
  /** 本次预扫描把整棵树里「每个文件的可检索行」摊平后常驻，供任意关键词零 IO 复用（text 已小写） */
  lines: Array<{ path: string; line: number; text: string }>;
  /** 全部可检索文件的相对路径（供文件名命中匹配） */
  files: string[];
  truncated: boolean;
  scannedFiles: number;
  /** T03441：因超过单文件上限（SEARCH_FILE_MAX_BYTES）被跳过的文件数——此前该信息被丢弃，用户无法区分「没有」与「没扫到」 */
  skippedOversized: number;
}
const searchMemo = new Map<string, SearchMemo>();

/** 检索命中收集上限（M6-6.1：常量提取自 autoContext） */
const SEARCH_HIT_LIMIT = 12;
type SearchHit = { path: string; line: number; snippet: string };

/** 文件路径命中收集（与 search() 的「文件名命中」语义对齐）；返回 true 表示已达上限 */
function collectFileNameHits(memo: SearchMemo, needle: string, collected: SearchHit[], seen: Set<string>): boolean {
  for (const f of memo.files) {
    if (!f.toLowerCase().includes(needle)) continue;
    const key = `${f}:0`;
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push({ path: f, line: 0, snippet: '(文件名命中)' });
    if (collected.length >= SEARCH_HIT_LIMIT) return true;
  }
  return collected.length >= SEARCH_HIT_LIMIT;
}

/** 正文行命中收集（memo 已摊平，无任何文件 IO）；返回 true 表示已达上限 */
function collectLineHits(memo: SearchMemo, needle: string, collected: SearchHit[], seen: Set<string>): boolean {
  for (const l of memo.lines) {
    if (!l.text.includes(needle)) continue;
    const key = `${l.path}:${l.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = Math.max(0, l.text.indexOf(needle) - 60);
    collected.push({ path: l.path, line: l.line, snippet: l.text.slice(start, start + SEARCH_SNIPPET_MAX).trim() });
    if (collected.length >= SEARCH_HIT_LIMIT) return true;
  }
  return collected.length >= SEARCH_HIT_LIMIT;
}
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

/** T03441：检索增强结果 + 覆盖度元信息（PRD 生成侧据此区分「没有相关代码」与「预算内没扫到」） */
export interface RetrieveContext {
  /** 可直接注入 prompt 的片段文本；空串 = 无可注入内容 */
  block: string;
  /** 命中条数 */
  hits: number;
  /** memo 预扫描实际读取正文的文件数 */
  scannedFiles: number;
  /** true = 因文件数/字节数预算提前终止，结果可能不完整 */
  truncated: boolean;
  /** 因超过单文件大小上限被跳过的文件数 */
  skippedOversized: number;
  /** T03442：本次真正命中的检索词（按喂入顺序） */
  matchedKeywords?: string[];
  /** T03442：本次一个片段都没命中的检索词——stage 回显「哪些词白检索了」 */
  unmatchedKeywords?: string[];
  /** T03442：目录级定向检索实际深扫的目录（相对路径） */
  scopedDirs?: string[];
  /** T03443：命中文件的去重路径（供上层做「按文件提交归属」，最多 12 个） */
  hitPaths?: string[];
}


/** 上下文预算（T00776-4：统一截断策略，替换各处硬编码） */
export const ContextBudget = {
  treeChars: 4000,          // 目录树
  fileSnippetChars: 2500,   // 单文件片段
  searchHitsChars: 3000,    // 检索增强注入（T00777）
  prdContextChars: 6000,    // PRD 原文（与 util/prdContext 一致）
  /** T03441：PRD 生成注入的近期提交脉络（一次 git log，保头保尾） */
  gitContextChars: 1500,
  /** T03441：单次 PRD 生成投入的原始需求字符上限（超出走保头保尾，避免挤掉源码上下文） */
  requirementChars: 24000,
  /** T03443：符号词典反查注入（workspace_symbols 直接给出的 path:line，密度高、体量小） */
  symbolContextChars: 800,
  /** T03443：命中文件的最近改动（每文件至多 3 次提交，整体保头保尾） */
  gitFileContextChars: 1200,
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
  if (ctx.hits.length >= SEARCH_LIMIT || budgetHit(ctx)) { if (budgetHit(ctx)) { ctx.budgetExceeded = true; } return; }
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
  /** T02280：本轮的符号条数上限（规模自适应值，轮内固定；`truncated` 语义按它判定） */
  limit: number;
  /** T02211：因超单文件字节上限被跳过的文件数（skipped 的子集，单独报数以免规模分布被抹平） */
  oversized: number;
  /** T00790②：启动时一次性载入的 (path → 已知 mtime) 映射，消除逐文件 SELECT MAX(file_mtime) 的 N+1 */
  knownMtime: Map<string, number>;
  /** T02210：本轮深扫期间挂在该工作空间上的监视器（事件数用于登记快照） */
  watch: WorkspaceWatch;
  /** 准备语句复用（避免逐文件重复 prepare） */
  insStmt: AnyStatement;
  delStmt: AnyStatement;
}

/** 单文件符号提取：mtime 未变跳过；变化则重建该文件条目并按 extractor 正则抽取（上限 200/文件） */
function indexFileSymbols(ctx: SymbolIndexCtx, abs: string, relChild: string): void {
  const { projectId } = ctx;
  let st;
  try { st = statSync(abs); } catch { return; }
  const mtime = Math.floor(st.mtimeMs);
  // T00790②：改为查内存 Map（原先每个文件一条 SELECT MAX(file_mtime)）
  const seen = ctx.knownMtime.get(relChild) === mtime;
  // T02211：单文件字节上限。超限的巨型产物正则扫它要几百毫秒（且正文本就进不了检索窗口），
  //   按「本轮不索引」处理。放在 mtime 判定之前是为了让 `oversized` 每轮都如实报数
  //   （放后面会让第二轮走增量跳过、观测值在 1 与 0 之间跳），删除条目只在首次/变化时做一次。
  if (st.size > SYMBOL_FILE_MAX_BYTES) {
    // (path → 已知 mtime) 映射只由「已索引的行」构成，故 has() 为真才说明历史上收过它的条目 → 清一次；
    // 超限文件不建行，下一轮仍走这里（代价 = 主键索引上一条幂等 DELETE，bemp 全库仅 3 个文件命中）
    if (ctx.knownMtime.has(relChild)) ctx.delStmt.run(projectId, relChild);
    ctx.skipped++; ctx.oversized++;
    return;
  }
  if (seen) { ctx.skipped++; return; }
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

/**
 * T02200：可中断续跑的符号索引遍历状态。原递归 `symbolIndexWalk` 一次性跑完整棵树，
 * 中途无法让出事件循环；改为显式栈后，「处理一个条目」就是可切片的最小工作单元。
 */
interface SymbolWalkState {
  ctx: SymbolIndexCtx;
  /** 帧 = 目录 + 其条目 + 游标；弹栈即回到父目录续走下一个条目（深度优先顺序与递归版一致） */
  stack: Array<{ dir: string; rel: string; entries: Array<{ name: string; isDir: boolean }>; i: number }>;
  done: boolean;
  /** T02210：因本轮符号上限（T02280 起为 `ctx.limit` 自适应值）提前收摊（树没走完）→ 不得登记结构快照 */
  truncated: boolean;
}

/** 目录展开入栈（readdirSync 失败=不可读目录，与原实现一致静默跳过） */
function symbolPushDir(state: SymbolWalkState, dir: string, rel: string): void {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch { return; }
  state.stack.push({ dir, rel, entries, i: 0 });
}

/**
 * 走一个工作单元（一次真正的文件索引，或一次目录展开）。
 * 语义逐条对齐原 `symbolIndexWalk`（T00782 N-8 上限前置判断、忽略规则、扩展名过滤、深度优先）。
 */
function symbolWalkStep(state: SymbolWalkState): void {
  const { ctx } = state;
  while (state.stack.length > 0) {
    if (ctx.symbols >= ctx.limit) { state.done = true; state.truncated = true; state.stack.length = 0; return; } // N-8：达上限整体终止
    const frame = state.stack[state.stack.length - 1];
    if (frame.i >= frame.entries.length) { state.stack.pop(); continue; }
    const e = frame.entries[frame.i++];
    const relChild = frame.rel ? `${frame.rel}/${e.name}` : e.name;
    if (isIgnored(relChild, e.isDir, ctx.rules)) continue;
    const abs = join(frame.dir, e.name);
    if (e.isDir) { symbolPushDir(state, abs, relChild); continue; }
    if (!ctx.countExts.has(extname(e.name).toLowerCase())) continue;
    indexFileSymbols(ctx, abs, relChild);
    return;
  }
  state.done = true;
}

/**
 * 跑一个时间片并在片尾提交。
 * T02200：better-sqlite3 的事务不能跨 await，故提交粒度由 T00790① 的「整轮一次」改为「每片一次」——
 * 片内仍是单次提交（逐符号 autocommit 的老问题不回退），片间让路。
 */
function runSymbolSlice(state: SymbolWalkState): void {
  const until = Date.now() + SYMBOL_SLICE_MS;
  state.ctx.db.transaction(() => {
    while (!state.done && Date.now() < until) symbolWalkStep(state);
  })();
}

/** T02200：项目级后台续跑任务（同一项目同时至多一个；新请求取代旧任务，避免两轮遍历交错写同一批行） */
interface SymbolRefreshJob {
  state: SymbolWalkState;
  superseded: boolean;
}
const symbolJobs = new Map<string, SymbolRefreshJob>();

/** 后台续跑循环：片间让出，直到遍历完成或被新请求取代 */
async function pumpSymbolJob(projectId: string, job: SymbolRefreshJob): Promise<void> {
  try {
    while (!job.state.done && !job.superseded) {
      await yieldToEventLoop();
      if (job.superseded || job.state.done) break;
      runSymbolSlice(job.state);
    }
    if (job.superseded) return;
    if (symbolJobs.get(projectId) === job) symbolJobs.delete(projectId);
    invalidateSearchMemo(projectId);
    const { ctx } = job.state;
    // T02210：走完才登记快照（因符号上限提前收摊的轮次树未走全，登记会让后续短路漏建）
    if (!job.state.truncated) commitTreeSnapshot(projectId, ctx.workspaceAbs, ctx.rules, ctx.files + ctx.skipped, ctx.oversized, ctx.watch.events, ctx.limit);
    console.log(`[workspace] 符号索引后台续跑完成：project=${projectId} 文件 ${ctx.files} 个、符号 ${ctx.symbols} 个、跳过 ${ctx.skipped} 个（其中超 ${Math.round(SYMBOL_FILE_MAX_BYTES / 1024)}KB 上限 ${ctx.oversized} 个）、本轮符号上限 ${ctx.limit} 条${ctx.symbols >= ctx.limit ? '（已触顶，树未走完）' : ''}`);
  } catch (e) {
    if (symbolJobs.get(projectId) === job) symbolJobs.delete(projectId);
    console.warn(`[workspace] 符号索引后台续跑失败：project=${projectId} ${(e as Error).message}`);
  }
}

/**
 * T00782 M-1：检索 memo 预扫描家族——一次扫树、供 5 分钟内任意关键词复用。
 *
 * 预扫描把整棵工作空间的「可检索行」摊平为 {path,line,text} 列表常驻内存（≤5 分钟）。
 * 与 `search()` 的区别：search 是「给一个关键词、扫一次树」；本家族是「扫一次树、供任意关键词复用」。
 * 预算独立于 `search`（MEMO_MAX_FILES / MEMO_MAX_BYTES，约 4 倍上限），超限同样置 truncated。
 */
/** M6-6.1：memo 预扫描共享状态（walk 递归可变状态对象化，替代闭包捕获） */
type MemoScanState = {
  lines: SearchMemo['lines'];
  files: string[];
  scannedFiles: number;
  scannedBytes: number;
  truncated: boolean;
  skippedOversized: number;
};

/** 单文件读取并摊平为可检索行；返回消耗字节数，跳过（二进制/过大/读取失败）返回 -1 */
function memoScanFile(state: MemoScanState, abs: string, relChild: string): number {
  let buf: Buffer;
  try { buf = readFileSync(abs); } catch { return -1; }
  if (buf.length > SEARCH_FILE_MAX_BYTES) { state.skippedOversized++; return -1; }
  const text = buf.toString('utf8');
  if (text.includes('\0')) return -1;
  state.scannedFiles++;
  state.scannedBytes += buf.length;
  state.files.push(relChild);
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t) continue;
    state.lines.push({ path: relChild, line: i + 1, text: t.toLowerCase() });
  }
  return buf.length;
}

/** T02200：memo 预扫描的可续跑状态（同 symbolWalkStep 思路，保持「预算超限置 truncated 并整体退出」原语义） */
interface MemoWalkState {
  state: MemoScanState;
  rules: IgnoreRule[];
  stack: Array<{ dir: string; rel: string; entries: Array<{ name: string; isDir: boolean }>; i: number }>;
  done: boolean;
}

const memoOverBudget = (s: MemoScanState): boolean =>
  s.scannedFiles >= MEMO_MAX_FILES || s.scannedBytes >= MEMO_MAX_BYTES;

/** 目录展开入栈（readdirSync 失败静默跳过，与原 memoWalk 一致） */
function memoPushDir(ms: MemoWalkState, dir: string, rel: string): void {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch { return; }
  ms.stack.push({ dir, rel, entries, i: 0 });
}

/** 走一个工作单元：一次文件读取（或一次目录展开）；预算超限按原语义置 truncated 并整体终止 */
function memoWalkStep(ms: MemoWalkState): void {
  while (ms.stack.length > 0) {
    if (memoOverBudget(ms.state)) { ms.state.truncated = true; ms.done = true; ms.stack.length = 0; return; }
    const frame = ms.stack[ms.stack.length - 1];
    if (frame.i >= frame.entries.length) { ms.stack.pop(); continue; }
    const e = frame.entries[frame.i++];
    const relChild = frame.rel ? `${frame.rel}/${e.name}` : e.name;
    if (isIgnored(relChild, e.isDir, ms.rules)) continue;
    const abs = join(frame.dir, e.name);
    if (e.isDir) { memoPushDir(ms, abs, relChild); continue; }
    if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue;
    memoScanFile(ms.state, abs, relChild);
    return;
  }
  ms.done = true;
}

/** T02200：同项目并发构建合流——生成链路与 organize 队列同时触发时只扫一次树 */
const memoBuilds = new Map<string, Promise<SearchMemo>>();

/**
 * T02200：memo 构建改为分片异步（原同步 `getSearchMemo` 一次 readFileSync 读完 ≤3000 文件/96MB，
 * 与同请求里的符号索引刷新阻塞相加，是 T02191 实测阻塞的第二来源）。缓存命中/TTL 语义不变，
 * 构建期间每 MEMO_SLICE_MS 让出一次事件循环，结果内容与耗时口径与原版一致（不延迟、不截断）。
 */
async function getSearchMemoAsync(projectId: string): Promise<SearchMemo> {
  const cached = searchMemo.get(projectId);
  if (cached && Date.now() - cached.at < SEARCH_MEMO_TTL_MS) return cached;
  const inflight = memoBuilds.get(projectId);
  if (inflight) return inflight;
  const promise = buildSearchMemo(projectId).finally(() => {
    if (memoBuilds.get(projectId) === promise) memoBuilds.delete(projectId);
  });
  memoBuilds.set(projectId, promise);
  return promise;
}

async function buildSearchMemo(projectId: string): Promise<SearchMemo> {
  const { workspace, rules } = getProjectWorkspace(projectId);
  const state: MemoScanState = { lines: [], files: [], scannedFiles: 0, scannedBytes: 0, truncated: false, skippedOversized: 0 };
  const ms: MemoWalkState = { state, rules, stack: [], done: false };
  memoPushDir(ms, workspace, '');
  while (!ms.done) {
    const until = Date.now() + MEMO_SLICE_MS;
    while (!ms.done && Date.now() < until) memoWalkStep(ms);
    if (!ms.done) await yieldToEventLoop();
  }
  const memo: SearchMemo = { at: Date.now(), ...state };
  searchMemo.set(projectId, memo);
  return memo;
}

/* ---------------- T03442：检索命中累计与目录级定向深扫 ---------------- */

/** 一次检索的累计状态：memo 命中与目录级深扫共用，按 path:line 去重并记录每个词是否有产出 */
interface HitAccumulator {
  collected: SearchHit[];
  seen: Set<string>;
  matched: string[];
  unmatched: string[];
}

function newAccumulator(): HitAccumulator {
  return { collected: [], seen: new Set<string>(), matched: [], unmatched: [] };
}

/** 在 memo（已摊平的全文索引）里跑一遍关键词；命中归属按「这个词有没有新增片段」判定 */
function collectMemoHits(memo: SearchMemo, keywords: readonly string[], acc: HitAccumulator): void {
  for (const kw of keywords) {
    if (acc.collected.length >= SEARCH_HIT_LIMIT) break;
    const needle = kw.toLowerCase();
    if (needle.length < 2) continue;
    const before = acc.collected.length;
    const reached = collectFileNameHits(memo, needle, acc.collected, acc.seen)
      || collectLineHits(memo, needle, acc.collected, acc.seen);
    if (acc.collected.length > before) acc.matched.push(kw);
    else acc.unmatched.push(kw);
    if (reached) break;
  }
}

/** 组装 RetrieveContext（含 T03441 覆盖度与 T03442 词/目录归属） */
function buildRetrieveContext(
  acc: HitAccumulator,
  meta: { scannedFiles: number; truncated: boolean; skippedOversized: number; scopedDirs?: string[] },
  budgetChars: number,
): RetrieveContext {
  const block = acc.collected.length === 0
    ? ''
    : ContextBudget.headTail(
      `相关代码片段（关键词检索 Top ${acc.collected.length}）：\n${acc.collected.map((h) => `${h.path}:${h.line} — ${h.snippet}`).join('\n')}`,
      budgetChars,
      '检索片段 ',
    );
  return {
    block,
    hits: acc.collected.length,
    scannedFiles: meta.scannedFiles,
    truncated: meta.truncated,
    skippedOversized: meta.skippedOversized,
    matchedKeywords: acc.matched,
    unmatchedKeywords: acc.unmatched,
    hitPaths: [...new Set(acc.collected.map((h) => h.path))].slice(0, HIT_PATHS_LIMIT),
    ...(meta.scopedDirs ? { scopedDirs: meta.scopedDirs } : {}),
  };
}

/** T03443：交给上层做「按文件提交归属」的路径上限（每个文件一次 git log，成本随个数线性上升） */
const HIT_PATHS_LIMIT = 12;

/** T03442：目录级定向检索的独立预算——只深扫「命中路径所在的目录」，与 memo 的 3000 文件预算互不挤占 */
const SCOPED_MAX_DIRS = 5;
const SCOPED_MAX_FILES = 200;
const SCOPED_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 由 memo 的文件清单挑出与关键词相关的目录（零 IO）：文件路径命中记分，目录名本身命中也算；
 * 已命中的片段所在目录同样入选——memo 截断点若落在相关目录中间，重扫该目录能把同目录的其余文件补齐。
 */
function pickScopedDirs(memo: SearchMemo, needles: readonly string[], hitPaths: readonly string[] = []): string[] {
  const score = new Map<string, number>();
  const bump = (dir: string): void => { score.set(dir, (score.get(dir) ?? 0) + 1); };
  for (const f of memo.files) {
    const lower = f.toLowerCase();
    if (needles.some((n) => lower.includes(n))) {
      bump(f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.');
    }
    // 目录名本身命中（如 src/acceptance/）：让整个目录成为候选
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (needles.some((n) => dir.toLowerCase().includes(n))) bump(dir);
    }
  }
  for (const p of hitPaths) bump(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SCOPED_MAX_DIRS)
    .map(([dir]) => dir);
}

/**
 * 在指定目录内做行级匹配（递归但受 SCOPED_MAX_FILES / SCOPED_MAX_BYTES 约束）。
 * 返回是否因预算提前结束。
 */
function scanScopedDirs(
  workspace: string,
  dirs: readonly string[],
  rules: IgnoreRule[],
  needles: readonly string[],
  acc: HitAccumulator,
): { scannedFiles: number; truncated: boolean } {
  let scannedFiles = 0;
  let scannedBytes = 0;
  let truncated = false;
  const lower = needles.map((n) => n.toLowerCase()).filter((n) => n.length >= 2);
  for (const dir of dirs) {
    if (acc.collected.length >= SEARCH_HIT_LIMIT) break;
    const stack: string[] = [dir];
    while (stack.length > 0) {
      if (scannedFiles >= SCOPED_MAX_FILES || scannedBytes >= SCOPED_MAX_BYTES || acc.collected.length >= SEARCH_HIT_LIMIT) {
        truncated = true;
        break;
      }
      const relDir = stack.pop() as string;
      let entries: Array<{ name: string; isDir: boolean }>;
      try {
        entries = readdirSync(join(workspace, relDir), { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      } catch { continue; }
      for (const e of entries) {
        const rel = relDir === '.' ? e.name : `${relDir}/${e.name}`;
        if (isIgnored(rel, e.isDir, rules)) continue;
        if (e.isDir) { stack.push(rel); continue; }
        if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue;
        let buf: Buffer;
        try { buf = readFileSync(join(workspace, rel)); } catch { continue; }
        if (buf.length > SEARCH_FILE_MAX_BYTES) continue;
        scannedFiles++;
        scannedBytes += buf.length;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length && acc.collected.length < SEARCH_HIT_LIMIT; i++) {
          const text = lines[i];
          if (!text) continue;
          const lowerLine = text.toLowerCase();
          const needle = lower.find((n) => lowerLine.includes(n));
          if (!needle) continue;
          const key = `${rel}:${i + 1}`;
          if (acc.seen.has(key)) continue;
          acc.seen.add(key);
          const start = Math.max(0, lowerLine.indexOf(needle) - 60);
          acc.collected.push({ path: rel, line: i + 1, snippet: text.slice(start, start + SEARCH_SNIPPET_MAX).trim() });
        }
      }
    }
  }
  return { scannedFiles, truncated };
}

/**
 * T03443：标识符 → 词元（驼峰 / 下划线 / 连字符切分后小写，丢弃 <3 字符的碎片）。
 * `AcceptanceStatus` → ['acceptance','status']；`acceptance_status` → 同上。
 */
export function splitIdentifier(symbol: string): string[] {
  return symbol
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$.-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/** T03443：符号反查候选行的打分（词元全等 3 / 词元前缀 2 / 整名包含 1，累加） */
function scoreSymbol(symbol: string, needles: readonly string[]): number {
  const tokens = splitIdentifier(symbol);
  const lower = symbol.toLowerCase();
  let score = 0;
  for (const w of needles) {
    if (tokens.includes(w)) score += 3;
    else if (tokens.some((t) => t.length >= 4 && (t.startsWith(w) || w.startsWith(t)))) score += 2;
    else if (lower.includes(w)) score += 1;
  }
  return score;
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
    { exts: ['.py'], kind: 'function', re: /^[^\S\r\n]*def\s+([A-Za-z_]\w*)/gm },
    { exts: ['.py'], kind: 'class', re: /^[^\S\r\n]*class\s+([A-Za-z_]\w*)/gm },
    { exts: ['.java', '.cs'], kind: 'class', re: /(?:(?:public|private|protected|internal|final|abstract|static)[^\S\r\n]+)*(?:class|interface|enum)\s+([A-Za-z_]\w*)/g },
  ],

  /** T00780：清空某项目的符号索引（工作空间换绑/解绑时用） */
  clearSymbols(projectId: string): number {
    const r = getDb().prepare('DELETE FROM workspace_symbols WHERE project_id = ?').run(projectId);
    invalidateSearchMemo(projectId); // T00782：索引清空 → 检索 memo 同步失效
    treeSnapshots.delete(projectId); // T02210：索引已空，结构快照不再能代表「已建过」
    dropWorkspaceWatch(projectId); // T02210：解绑/换绑后旧目录的监视事件不该再短路新工作空间
    return r.changes;
  },

  /** 增量刷新符号索引：mtime 未变的文件跳过；变化则重建该文件条目。返回统计。
   *  T00780：工作空间根路径变化（换绑）时先清空旧索引，避免查到已不属于当前工作空间的路径。
   *  T00790②：启动时一次性载入 (path → 已知 mtime) Map，替代逐文件 SELECT MAX(file_mtime) 的 N+1。
   *  T02200：遍历改为分片可让路（原 T00790① 的整轮单事务按片拆细）。SYMBOL_INLINE_BUDGET_MS 内
   *  跑完的仍等价于「同步等结果」（小工作空间与既有 API 测试契约不变）；超预算则余量交后台续跑，
   *  返回值标 deferred。符号索引是检索增强的补充信号，可延迟收敛而不影响当次生成质量。
   *  T02210：承接让路的「降本」——未变更的热刷整轮不进逐文件 stat（详见上方短路注释块）。
   *  T02280（T03444 取回）：本轮符号条数上限按「候选文件数 × 观测密度」自适应钳位，
   *  值随返回值 `limit` 一起报出（门与排障都按它判读，不再靠猜当时的常量）。 */
  async refreshSymbols(projectId: string, inlineBudgetMs = SYMBOL_INLINE_BUDGET_MS): Promise<{ files: number; symbols: number; skipped: number; oversized: number; cleared: number; deferred: boolean; shortCircuited: boolean; limit: number }> {
    const { workspace, rules } = getProjectWorkspace(projectId);
    const db = getDb();
    // 根路径与建索引时不同（换绑）→ 旧索引整体失效，清空重建
    const workspaceAbs = resolve(workspace);
    const cleared = db.prepare('DELETE FROM workspace_symbols WHERE project_id = ? AND workspace <> ?').run(projectId, workspaceAbs).changes;
    // T02210：监视器在本轮遍历「之前」挂上——遍历期间落盘的写入会计入事件，
    // 登记快照时即可看出「本轮结果是否已被后续变更作废」，不留静默窗口
    const watchState = ensureWorkspaceWatch(projectId, workspaceAbs, rules);
    const snap = treeSnapshots.get(projectId);
    if (snap && snap.candidateFiles >= SYMBOL_FAST_PATH_MIN_FILES
      && !watchState.unsupported && watchState.watcher
      && watchState.events === snap.eventsAtSnapshot
      && Date.now() - snap.deepVerifiedAt < SYMBOL_DEEP_VERIFY_MS) {
      const current = buildDirSnapshot(workspaceAbs, rules);
      // 结构指纹一致（无增删改名）+ 期间零监视事件（无内容写入）→ 整轮 stat 可省；
      // 此时也不失效检索 memo——内容既然没变，让 memo 继续命中才是短路的完整收益
      if (current && snapshotEqual(snap.dirs, current)) {
        return { files: 0, symbols: 0, skipped: snap.candidateFiles, oversized: snap.oversized, cleared, deferred: false, shortCircuited: true, limit: snap.symbolLimit };
      }
    }
    // T00790②：一次查询建 (path → 已知 mtime) 映射（同 path 取最大 mtime，与原 MAX 语义一致）
    const knownMtime = new Map<string, number>();
    for (const row of db.prepare('SELECT path, MAX(file_mtime) AS m FROM workspace_symbols WHERE project_id = ? GROUP BY path').all(projectId) as Array<{ path: string; m: number | null }>) {
      if (row.m !== null) knownMtime.set(row.path, row.m);
    }
    // T02280：本轮上限按规模自适应（knownMtime 已把「已索引文件数」免费带出来，只补一条 COUNT）
    const limit = symbolLimitFor(db, projectId, knownMtime.size, snap?.candidateFiles);
    const ctx: SymbolIndexCtx = {
      db, projectId, rules, extractors: this.SYMBOL_EXTRACTORS,
      countExts: new Set(this.SYMBOL_EXTRACTORS.flatMap((x) => x.exts)),
      workspaceAbs,
      files: 0, symbols: 0, skipped: 0, oversized: 0,
      limit,
      knownMtime,
      watch: watchState,
      insStmt: db.prepare('INSERT INTO workspace_symbols (id, project_id, path, symbol, line, kind, file_mtime, workspace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      delStmt: db.prepare('DELETE FROM workspace_symbols WHERE project_id = ? AND path = ?'),
    };
    // T02200：取代仍在续跑的旧任务（显式刷新要看当前文件系统状态，两轮遍历交错会重复删插同一批行）
    const prev = symbolJobs.get(projectId);
    if (prev) { prev.superseded = true; symbolJobs.delete(projectId); }
    const state: SymbolWalkState = { ctx, stack: [], done: false, truncated: false };
    symbolPushDir(state, workspace, '');
    const until = Date.now() + inlineBudgetMs;
    while (!state.done && Date.now() < until) runSymbolSlice(state);
    invalidateSearchMemo(projectId); // T00782：索引刷新后检索 memo 失效（内容可能已变）
    if (!state.done) {
      const job: SymbolRefreshJob = { state, superseded: false };
      symbolJobs.set(projectId, job);
      void pumpSymbolJob(projectId, job);
    } else if (!state.truncated) {
      // T02210：一次请求内走完 → 当场登记结构快照，下一轮同状态热刷即短路
      commitTreeSnapshot(projectId, workspaceAbs, rules, ctx.files + ctx.skipped, ctx.oversized, watchState.events, ctx.limit);
    }
    if (ctx.oversized > 0) {
      console.log(`[workspace] 符号索引：project=${projectId} 按单文件字节上限跳过 ${ctx.oversized} 个（>${Math.round(SYMBOL_FILE_MAX_BYTES / 1024)}KB，正文本就超出检索读取窗口）`);
    }
    return { files: ctx.files, symbols: ctx.symbols, skipped: ctx.skipped, oversized: ctx.oversized, cleared, deferred: !state.done, shortCircuited: false, limit: ctx.limit };
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
   * T02868：按文件取现有符号索引里的定义（讲稿上下文「所在类」展开用）。
   * 复用 workspace_symbols，不新建索引机制；文件已不在工作空间时返回空。
   */
  symbolsInFile(projectId: string, path: string, limit = 50): Array<{ symbol: string; line: number; kind: string }> {
    const { workspace } = getProjectWorkspace(projectId);
    try { statSync(resolve(workspace, path)); } catch { return []; }
    return getDb().prepare(
      'SELECT symbol, line, kind FROM workspace_symbols WHERE project_id = ? AND workspace = ? AND path = ? ORDER BY line LIMIT ?',
    ).all(projectId, resolve(workspace), path.replaceAll('\\', '/'), Math.min(Math.trunc(limit), 200)) as Array<{ symbol: string; line: number; kind: string }>;
  },

  /**
   * T03443：符号词典反向匹配。需求侧给出的英文词（含中文经词表映射出的标识符）在全文检索里
   * 命中率天然低——代码里的 `AcceptanceService` / `acceptance_status` 未必与需求用词字面一致。
   * 这里复用 workspace_symbols 现成索引：把符号切成词元后按打分反查，直接返回 `path:line`。
   * 倒排只在本次调用现场构建（数千行量级、用完即弃），不做常驻缓存（约束：不引入大内存结构）。
   */
  symbolMatches(projectId: string, needles: readonly string[], limit = 8): Array<{ path: string; symbol: string; line: number; kind: string }> {
    const words = [...new Set(needles.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3))];
    if (words.length === 0) return [];
    const { workspace } = getProjectWorkspace(projectId);
    const rows = getDb().prepare(
      'SELECT path, symbol, line, kind FROM workspace_symbols WHERE project_id = ? AND workspace = ? LIMIT 20000',
    ).all(projectId, resolve(workspace)) as Array<{ path: string; symbol: string; line: number; kind: string }>;
    const scored: Array<{ row: (typeof rows)[number]; score: number }> = [];
    for (const row of rows) {
      const score = scoreSymbol(row.symbol, words);
      if (score > 0) scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path) || a.row.line - b.row.line);
    const out: Array<{ path: string; symbol: string; line: number; kind: string }> = [];
    const seen = new Set<string>();
    for (const { row } of scored) {
      const key = `${row.path}:${row.line}`;
      if (seen.has(key)) continue;
      // 孤儿防护（与 querySymbols 同口径）：索引行存在但文件已不在当前工作空间时丢弃
      try { statSync(resolve(workspace, row.path)); } catch { continue; }
      seen.add(key);
      out.push(row);
      if (out.length >= Math.min(Math.trunc(limit), 50)) break;
    }
    return out;
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
  async autoContext(projectId: string, keywords: string[], budgetChars = ContextBudget.searchHitsChars): Promise<string> {
    return (await WorkspaceService.autoContextDetailed(projectId, keywords, budgetChars)).block;
  },

  /**
   * T03441：带覆盖度元信息的检索增强（PRD 生成侧使用；`autoContext` 保留原字符串契约供其他调用方）。
   * 此前 memo 的 truncated / 超大文件跳过被丢弃，上层只能一律打「无命中」，用户无法区分
   * 「仓库里确实没有」与「预算内没扫到」——本方法把这两类信息一并交给调用方。
   */
  async autoContextDetailed(projectId: string, keywords: string[], budgetChars = ContextBudget.searchHitsChars): Promise<RetrieveContext> {
    if (!keywords || keywords.length === 0) {
      return { block: '', hits: 0, scannedFiles: 0, truncated: false, skippedOversized: 0 };
    }
    const memo = await getSearchMemoAsync(projectId);
    // M6-6.1：文件名命中/正文行命中两段收集循环提取为模块级助手，本函数仅保留遍历与上限控制
    const acc = newAccumulator();
    collectMemoHits(memo, keywords, acc);
    return buildRetrieveContext(
      acc,
      { scannedFiles: memo.scannedFiles, truncated: memo.truncated, skippedOversized: memo.skippedOversized },
      budgetChars,
    );
  },

  /**
   * T03442：目录级定向检索——memo 只覆盖前 3000 个文件（monorepo 上常全是 infra/工具），
   * 全局行匹配因此可能「预算内无命中」。这里先用 memo 的文件清单零 IO 挑出相关目录，
   * 再在这些目录内做**独立预算**（200 文件 / 8MB）的行级深扫，命中并入同一次结果。
   * memo 前缀 + 目录深扫两段互补：前者覆盖率广，后者命中率深。
   */
  async autoContextScoped(projectId: string, keywords: string[], budgetChars = ContextBudget.searchHitsChars): Promise<RetrieveContext> {
    if (!keywords || keywords.length === 0) {
      return { block: '', hits: 0, scannedFiles: 0, truncated: false, skippedOversized: 0 };
    }
    const memo = await getSearchMemoAsync(projectId);
    const acc = newAccumulator();
    collectMemoHits(memo, keywords, acc);
    const { workspace, rules } = getProjectWorkspace(projectId);
    const dirs = pickScopedDirs(memo, keywords, acc.collected.map((h) => h.path));
    let scoped = { scannedFiles: 0, truncated: false };
    if (dirs.length > 0) {
      await yieldToEventLoop(); // 与 T02200 同族：深扫前先给只读接口让路
      scoped = scanScopedDirs(workspace, dirs, rules, keywords, acc);
    }
    return buildRetrieveContext(
      acc,
      {
        scannedFiles: memo.scannedFiles + scoped.scannedFiles,
        truncated: memo.truncated || scoped.truncated,
        skippedOversized: memo.skippedOversized,
        scopedDirs: dirs,
      },
      budgetChars,
    );
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
    const stop = new Set(['the', 'and', 'for', 'with', 'const', 'let', 'function', 'return', 'this']);
    for (const m of text.matchAll(/[A-Za-z_]\w{2,}/g)) {
      const w = m[0];
      // T00814：排除 Word 域代码标识符（HYPERLINK/PAGEREF/_Toc18264…）——它们不是需求里的业务词，
      // 一旦被当成检索关键词，注入的代码片段与需求完全无关（实测控制台出现
      // `[HYPERLINK, _Toc18264, PAGEREF, _Toc14244, …]` 这种 6 个词全是域码的情况）
      if (isWordFieldToken(w)) continue;
      // 排除「数字为主」的串（版本号/哈希/编号），它们对代码检索没有区分度
      if ((w.match(/\d/g)?.length ?? 0) >= Math.ceil(w.length / 2)) continue;
      if (!out.includes(w) && !stop.has(w.toLowerCase())) out.push(w);
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
