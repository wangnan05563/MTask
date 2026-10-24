/**
 * Git 只读采集引擎（六期 2.1 / PRD FR-1.1、FR-1.1a、FR-1.1b）。
 *
 * 三条红线在这里一次收口：
 *  1. **只读**：子命令白名单 + 参数数组 execFile，禁 shell；位置参数与选项分开校验，
 *     调用方无法传入 `--output=` 一类会写盘的选项（选项走本文件内的白名单表）。
 *  2. **编码**：统一注入 `-c i18n.logOutputEncoding=utf-8`（中文 commit 不乱码）与
 *     `-c core.quotepath=false`（中文路径不被转成 \xxX），只改本次调用，不碰用户 git 配置。
 *  3. **行尾**：diff 固定带 `--ignore-cr-at-eol`，避免 Windows autocrlf 把未改行尾的文件整文件算进增量。
 */
import { execFile, type ExecFileException } from 'node:child_process';

export const GIT_READONLY_SUBCOMMANDS = ['rev-parse', 'log', 'diff', 'show'] as const;
export type GitReadonlySubcommand = (typeof GIT_READONLY_SUBCOMMANDS)[number];

export const GIT_TIMEOUT_MS = 30_000;
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const GIT_DIFF_TEXT_LIMIT = 2 * 1024 * 1024;
/** 粘贴 patch 入口的字节上限（与讲稿流式端点 raw 30mb 同口径，FR-1.3） */
export const LECTURE_PATCH_TEXT_LIMIT = 30 * 1024 * 1024;
/** 空树 SHA-1：首个提交没有父提交时，用空树作为 diff 基线（只影响「首末 SHA」与时间窗的根提交情形） */
export const GIT_EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 只对本次子进程生效的输出配置（顺序即 argv 前缀） */
export const GIT_OUTPUT_CONFIG = [
  '-c', 'i18n.logOutputEncoding=utf-8',
  '-c', 'core.quotepath=false',
] as const;

/** 每个只读子命令允许的选项（白名单，防止调用方借选项写盘或改配置） */
const ALLOWED_FLAGS: Record<GitReadonlySubcommand, RegExp[]> = {
  'rev-parse': [/^--is-inside-work-tree$/],
  log: [/^--oneline$/, /^--no-merges$/, /^--format=[%\w.:{}+\-/ ]+$/, /^-n\d{1,4}$/, /^--since=[\w:+\-. ]{1,64}$/, /^--reverse$/],
  diff: [/^--ignore-cr-at-eol$/, /^--stat$/, /^--numstat$/, /^-U\d{1,3}$/],
  show: [],
};

export type GitErrorKind = 'no-git' | 'not-a-repo' | 'timeout' | 'too-large' | 'denied' | 'invalid-patch' | 'failed';

export class GitCollectError extends Error {
  readonly kind: GitErrorKind;

  constructor(kind: GitErrorKind, message: string) {
    super(message);
    this.name = 'GitCollectError';
    this.kind = kind;
  }
}

export interface GitCollectOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  /** 实际交给子进程的完整 argv（含本次注入的 -c），供取证与门断言 */
  argv: string[];
}

function assertSubcommand(value: string): GitReadonlySubcommand {
  if (!(GIT_READONLY_SUBCOMMANDS as readonly string[]).includes(value)) {
    throw new GitCollectError('denied', `拒绝非白名单 Git 子命令「${value}」（只读集合：${GIT_READONLY_SUBCOMMANDS.join('/')}）`);
  }
  return value as GitReadonlySubcommand;
}

function assertFlag(subcommand: GitReadonlySubcommand, flag: string): string {
  const allowed = ALLOWED_FLAGS[subcommand].some((re) => re.test(flag));
  if (!allowed) throw new GitCollectError('denied', `拒绝 Git 选项「${flag}」（不在 ${subcommand} 的白名单内）`);
  return flag;
}

function assertPositional(value: string): string {
  if (!value) throw new GitCollectError('denied', 'Git 位置参数不得为空');
  if (value.startsWith('-')) throw new GitCollectError('denied', `拒绝以「-」开头的 Git 位置参数「${value}」（防选项注入）`);
  if (/[\0\r\n]/.test(value)) throw new GitCollectError('denied', 'Git 位置参数含控制字符');
  return value;
}

/** 组装并校验 argv：`git <输出配置> <子命令> <白名单选项> <位置参数…>` */
export function buildGitArgv(subcommand: string, flags: string[], positional: string[]): string[] {
  const cmd = assertSubcommand(subcommand);
  const safeFlags = flags.map((f) => assertFlag(cmd, f));
  const safePos = positional.map(assertPositional);
  return [...GIT_OUTPUT_CONFIG, cmd, ...safeFlags, ...safePos];
}

/** 分支/标签/commit/range 形状校验；`--` 与空白/控制字符一律拒绝（防参数注入） */
export function assertSafeRevision(token: string): string {
  if (!token || token.startsWith('-') || /[\s\0]/.test(token)) {
    throw new GitCollectError('denied', `非法 Git 版本号「${token}」`);
  }
  if (!/^[\w./~^@{}:+-]+$/.test(token)) {
    throw new GitCollectError('denied', `非法 Git 版本号字符「${token}」`);
  }
  return token;
}

/** 单版本号位置（base/head/首末 SHA）：不接受 `..`/`...` 区间写法 */
export function assertSingleRevision(token: string): string {
  const rev = assertSafeRevision(token);
  if (rev.includes('..')) throw new GitCollectError('denied', `该区间形态要求单个版本号，不接受区间「${rev}」`);
  return rev;
}

/** 时间窗起点：允许 ISO 日期与「14 days ago」类相对写法，但不含引号/分号等元字符 */
export function assertSafeSince(value: string): string {
  const since = value.trim();
  if (!since || since.length > 64) throw new GitCollectError('denied', `非法时间窗起点「${value}」`);
  if (!/^[\w:+\-. ]+$/.test(since)) throw new GitCollectError('denied', `非法时间窗起点字符「${value}」`);
  return since;
}

/** 仓库相对路径校验：禁止绝对路径、反斜杠与 `..` 段 */
export function assertSafeRepoPath(rel: string): string {
  if (!rel || rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel) || rel.includes('\\')) {
    throw new GitCollectError('denied', `非法仓库相对路径「${rel}」`);
  }
  if (rel.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new GitCollectError('denied', `非法仓库相对路径「${rel}」`);
  }
  return rel;
}

function classifyExecError(e: ExecFileException): GitCollectError {
  const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr ? String(e.stderr) : '');
  const hay = `${stderr}\n${e.message ?? ''}`;
  if (e.code === 'ENOENT') return new GitCollectError('no-git', '未找到 git 命令：请安装 Git，或改用「粘贴 patch」模式');
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new GitCollectError('too-large', 'Git 输出超过 maxBuffer，请收窄采集范围');
  if (/not a git repository/i.test(hay)) return new GitCollectError('not-a-repo', `工作空间不是 Git 仓库：${(stderr || e.message).trim().slice(0, 200)}`);
  if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') return new GitCollectError('timeout', 'Git 采集超时（30s），请收窄范围后重试');
  return new GitCollectError('failed', `Git 采集失败：${(stderr || e.message).trim().slice(0, 300)}`);
}

/** 执行一条只读 Git 命令；所有错误统一转成带 kind 的 GitCollectError */
export function runGitReadonly(
  subcommand: string,
  flags: string[],
  positional: string[],
  cwd: string,
  opts: GitCollectOptions = {},
): Promise<GitRunResult> {
  const argv = buildGitArgv(subcommand, flags, positional);
  const execOpts = {
    cwd,
    timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: 'utf8' as const,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  return new Promise<GitRunResult>((resolve, reject) => {
    execFile('git', argv, execOpts, (err, stdout, stderr) => {
      if (err) { reject(classifyExecError(err)); return; }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), argv });
    });
  });
}

export interface GitProbeResult {
  /** 系统装了 git 且命令可执行 */
  available: boolean;
  /** 当前目录位于某个 git 工作树内 */
  isRepo: boolean;
  kind?: GitErrorKind;
  detail?: string;
}

/** 可用性探测：`rev-parse --is-inside-work-tree`；未装 git 与「不是仓库」按 kind 区分 */
export async function probeRepository(cwd: string, opts: GitCollectOptions = {}): Promise<GitProbeResult> {
  try {
    const r = await runGitReadonly('rev-parse', ['--is-inside-work-tree'], [], cwd, opts);
    return { available: true, isRepo: r.stdout.trim() === 'true' };
  } catch (e) {
    if (!(e instanceof GitCollectError)) throw e;
    if (e.kind === 'no-git') return { available: false, isRepo: false, kind: e.kind, detail: e.message };
    if (e.kind === 'not-a-repo') return { available: true, isRepo: false, kind: e.kind, detail: e.message };
    return { available: true, isRepo: false, kind: e.kind, detail: e.message };
  }
}

export interface GitCommitEntry {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

const LOG_FORMAT = '--format=%H%x09%an%x09%aI%x09%s';

function parseCommitLog(stdout: string): GitCommitEntry[] {
  return stdout.split('\n').filter(Boolean).flatMap((line) => {
    const [sha, author, date, ...rest] = line.split('\t');
    if (!sha || !author || !date) return [];
    return [{ sha, author, date, subject: rest.join('\t') }];
  });
}

/** 提交清单（`git log --no-merges`）；解析失败的行原样丢弃，不阻断采集 */
export async function collectCommitLog(
  cwd: string,
  range: string[],
  opts: GitCollectOptions = {},
  extraFlags: string[] = [],
): Promise<GitCommitEntry[]> {
  const revs = range.map(assertSafeRevision);
  const r = await runGitReadonly('log', ['--no-merges', LOG_FORMAT, ...extraFlags], revs, cwd, opts);
  return parseCommitLog(r.stdout);
}

/** 增量统计原文（`diff --stat`，带行尾口径）；超 2MB 由调用方按 FR-1.4 截断并点名 */
export async function collectDiffStat(cwd: string, range: string[], opts: GitCollectOptions = {}): Promise<string> {
  const revs = range.map(assertSafeRevision);
  const r = await runGitReadonly('diff', ['--stat', '--ignore-cr-at-eol'], revs, cwd, opts);
  return r.stdout;
}

/** 增量正文（unified diff，`contextLines` 默认 3）；超 2MB 由调用方按 FR-1.4 截断并点名 */
export async function collectDiff(cwd: string, range: string[], contextLines = 3, opts: GitCollectOptions = {}): Promise<string> {
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100) {
    throw new GitCollectError('denied', `非法上下文行数「${contextLines}」`);
  }
  const revs = range.map(assertSafeRevision);
  const r = await runGitReadonly('diff', [`-U${contextLines}`, '--ignore-cr-at-eol'], revs, cwd, opts);
  return r.stdout;
}

/** 读取某版本下的单文件内容（上下文展开用，仍属只读） */
export async function collectFileAtRevision(
  cwd: string,
  revision: string,
  relPath: string,
  opts: GitCollectOptions = {},
): Promise<string> {
  const rev = assertSafeRevision(revision);
  const rel = assertSafeRepoPath(relPath);
  const r = await runGitReadonly('show', [], [`${rev}:${rel}`], cwd, opts);
  return r.stdout;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

/**
 * 把区间终点解析成具体 commit SHA。
 *
 * 锚点的 blob 复核需要一个「不随新提交漂移」的坐标：`HEAD`/分支名在下一次提交后就指向别的树，
 * 按符号名取到的文件内容不再等于生成讲稿时看到的内容，FR-4.3 的时效声明就此失效。
 */
export async function resolveRevisionSha(
  cwd: string,
  revision: string,
  opts: GitCollectOptions = {},
): Promise<string> {
  const rev = assertSingleRevision(`${revision}^{commit}`);
  const r = await runGitReadonly('rev-parse', [], [rev], cwd, opts);
  const sha = r.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitCollectError('failed', `无法把「${revision}」解析成 commit SHA：${sha.slice(0, 80)}`);
  }
  return sha;
}

/** 保头保尾截断（纪律同 prdContext.trimPrdContent），用于 diff 文本的 2MB 上限 */
export function truncateDiffText(text: string, limit = GIT_DIFF_TEXT_LIMIT): TruncatedText {
  if (text.length <= limit) return { text, truncated: false, originalLength: text.length };
  const half = Math.floor(limit / 2);
  return {
    text: `${text.slice(0, half)}\n\n……（中段略去 ${text.length - limit} 字符，全文请收窄采集范围）……\n\n${text.slice(-half)}`,
    truncated: true,
    originalLength: text.length,
  };
}

// ---------------------------------------------------------------------------
// FR-1.2 区间三形态 / FR-1.3 粘贴 patch 降级 / FR-1.4 硬边界与优先级截断
// ---------------------------------------------------------------------------

export type GitRangeShape = 'base-head' | 'first-last' | 'since';
export type GitCollectionShape = GitRangeShape | 'patch';

/** 调用方传入的区间描述；三形态各用其中两个字段 */
export interface GitRangeInput {
  shape: GitRangeShape;
  /** base-head / first-last 的起点（分支、标签或 SHA） */
  base?: string;
  /** base-head / first-last 的终点；since 形态作为右端，缺省 HEAD */
  head?: string;
  /** since 形态的时间窗起点（ISO 日期或「14 days ago」） */
  since?: string;
}

export interface ResolvedGitRange {
  shape: GitRangeShape;
  label: string;
  /** diff 基线（根提交情形为空树 SHA） */
  base: string;
  head: string;
  diffPositional: string[];
  logPositional: string[];
  logFlags: string[];
  /** 时间窗内没有提交（不是错误，按空集合返回） */
  empty: boolean;
}

export interface GitHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** hunk 头之后的行，行首保留 diff 前缀（空格/加号/减号） */
  lines: string[];
}

export interface GitFileChange {
  /** 新路径；删除文件取旧路径 */
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: GitHunk[];
  /** 该文件原始 unified diff 段（含 `diff --git` 头），供预算裁剪与回放 */
  raw: string;
  textLength: number;
}

export interface GitDiffStats {
  files: number;
  additions: number;
  deletions: number;
  commits: number;
}

export interface DiffBudgetEntry {
  path: string;
  textLength: number;
  changedLines: number;
}

export interface DiffBudgetResult {
  kept: GitFileChange[];
  dropped: DiffBudgetEntry[];
  /** 单文件自身即超限、只能保头保尾截断的文件 */
  partial: DiffBudgetEntry[];
  usedLength: number;
  limit: number;
  truncated: boolean;
}

export interface GitCollection {
  source: 'git' | 'patch';
  range: { shape: GitCollectionShape; label: string; base: string; head: string };
  files: GitFileChange[];
  hunks: GitHunk[];
  commits: GitCommitEntry[];
  stats: GitDiffStats;
  budget: Omit<DiffBudgetResult, 'kept'>;
  warnings: string[];
}

export interface GitCollectionOptions extends GitCollectOptions {
  contextLines?: number;
  diffLimit?: number;
  /** symbol 引用次数（FR-1.4 第三优先级因子；由 T02868 装配时提供） */
  symbolRefs?: Record<string, number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** 安全敏感路径（FR-1.4 第二优先级因子）：按路径段命中 auth/crypto/sql/exec */
const SECURITY_PATH = /(^|[/_.-])(auth|authn|authz|crypto|sql|exec)([/_.-]|$)/i;

/** 讲稿上下文装配（T02868）复用同一安全路径口径，避免优先级因子两处漂移 */
export function isSecurityPath(path: string): boolean {
  return SECURITY_PATH.test(path);
}
const FILE_TRIM_MARKER = '\n\n……（该文件 diff 超出剩余预算，已保头保尾截断）……\n\n';

/** `--- a/x` / `+++ b/x` / `Binary files a/x and b/y differ` 里的路径还原 */
function decodeDiffPath(raw: string): string | null {
  let p = raw.trim();
  if (!p || p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    p = p.slice(1, -1).replaceAll(/\\(["\\])/g, '$1');
  }
  const m = /^[ab]\/(.*)$/.exec(p);
  return m ? m[1] : p;
}

/**
 * 解析 unified diff（`git diff -U<n>` / 粘贴 patch 共用）。
 * 只认 `diff --git` 分段与 `@@` hunk 头；hunk 内的 `---` 是删除行，不会被误当文件头。
 */
export function parseUnifiedDiff(text: string): GitFileChange[] {
  type OpenFile = Omit<GitFileChange, 'raw' | 'textLength'> & {
    rawLines: string[];
    /** `diff --git` 头的兜底路径：仅用来补 mode-only / 无 ---+++ 的段，不直接当作已解析路径 */
    headerOld?: string;
    headerNew?: string;
  };
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const files: GitFileChange[] = [];
  let cur: OpenFile | null = null;
  let hunk: GitHunk | null = null;
  let oldSeen = 0;
  let newSeen = 0;

  const flush = () => {
    const f = cur;
    if (!f) return;
    while (f.rawLines.length > 0 && f.rawLines[f.rawLines.length - 1] === '') f.rawLines.pop();
    const { rawLines, headerOld, headerNew, ...rest } = f;
    const raw = rawLines.join('\n');
    const path = rest.path || rest.oldPath || headerNew || headerOld || '';
    if (path) files.push({ ...rest, path, raw, textLength: raw.length });
    cur = null;
  };
  const startFile = (firstLine: string): OpenFile => {
    flush();
    const f: OpenFile = { path: '', additions: 0, deletions: 0, binary: false, hunks: [], rawLines: [firstLine] };
    cur = f;
    hunk = null;
    oldSeen = 0;
    newSeen = 0;
    return f;
  };
  // 用访问器读取当前段：闭包内对 cur 的赋值不会被 TypeScript 的控制流分析追踪
  const current = (): OpenFile | null => cur;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const f = startFile(line);
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice('diff --git '.length));
      if (m) {
        const oldPath = decodeDiffPath(m[1]);
        const newPath = decodeDiffPath(m[2]);
        if (oldPath) f.headerOld = oldPath;
        if (newPath) f.headerNew = newPath;
      }
      continue;
    }
    // 兼容 `diff -u` / 去掉 `diff --git` 头的裸 patch：`---` 起新段
    const open = current();
    if (!hunk && open && open.path && line.startsWith('--- ')) {
      const f = startFile(line);
      const p = decodeDiffPath(line.slice(4));
      if (p) f.oldPath = p;
      continue;
    }
    const opened = current();
    if (!opened) {
      if (line.startsWith('--- ')) {
        const f = startFile(line);
        const p = decodeDiffPath(line.slice(4));
        if (p) f.oldPath = p;
      }
      continue;
    }
    const f = opened;
    f.rawLines.push(line);

    if (line === 'GIT binary patch') { f.binary = true; continue; }
    const bin = /^Binary files (.+) and (.+) differ$/.exec(line);
    if (bin) {
      f.binary = true;
      const oldPath = decodeDiffPath(bin[1]);
      const newPath = decodeDiffPath(bin[2]);
      if (oldPath) f.oldPath = oldPath;
      if (newPath) f.path = newPath;
      continue;
    }

    if (!hunk) {
      const renameFrom = /^rename from (.+)$/.exec(line);
      if (renameFrom) { f.oldPath = renameFrom[1].trim(); continue; }
      const renameTo = /^rename to (.+)$/.exec(line);
      if (renameTo) { f.path = renameTo[1].trim(); continue; }
      if (line.startsWith('--- ')) {
        const p = decodeDiffPath(line.slice(4));
        if (p) f.oldPath = p;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = decodeDiffPath(line.slice(4));
        if (p) f.path = p;
        continue;
      }
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      f.hunks.push(hunk);
      oldSeen = 0;
      newSeen = 0;
      continue;
    }
    if (!hunk) continue;
    const closes = () => {
      if (hunk && oldSeen >= hunk.oldLines && newSeen >= hunk.newLines) hunk = null;
    };
    if (line.startsWith('+')) { f.additions += 1; hunk.lines.push(line); newSeen += 1; closes(); continue; }
    if (line.startsWith('-')) { f.deletions += 1; hunk.lines.push(line); oldSeen += 1; closes(); continue; }
    if (line.startsWith(' ')) { hunk.lines.push(line); oldSeen += 1; newSeen += 1; closes(); continue; }
    // `\ No newline at end of file` 等标记：不计数、不占上下文
  }
  flush();
  return files;
}

/** 单文件自身即超限时的保头保尾裁剪（长度严格不超过 limit） */
function trimFileText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= FILE_TRIM_MARKER.length) return text.slice(0, limit);
  const half = Math.floor((limit - FILE_TRIM_MARKER.length) / 2);
  const tail = limit - FILE_TRIM_MARKER.length - half;
  return `${text.slice(0, half)}${FILE_TRIM_MARKER}${text.slice(-tail)}`;
}

/**
 * FR-1.4 优先级截断：变更行数多者优先 → 安全敏感路径优先 → symbol 引用多者优先；
 * 被丢弃 / 被截断的文件逐一点名，供预检（FR-7.1）与两条路选择（FR-7.2）展示。
 */
export function applyDiffBudget(
  files: GitFileChange[],
  limit = GIT_DIFF_TEXT_LIMIT,
  symbolRefs: Record<string, number> = {},
): DiffBudgetResult {
  if (!Number.isInteger(limit) || limit <= 0) throw new GitCollectError('denied', `非法 diff 预算上限「${limit}」`);
  const total = files.reduce((sum, f) => sum + f.textLength, 0);
  const base = { dropped: [] as DiffBudgetEntry[], partial: [] as DiffBudgetEntry[], limit };
  if (total <= limit) return { ...base, kept: files, usedLength: total, truncated: false };

  const rank = (f: GitFileChange) => ({
    changedLines: f.additions + f.deletions,
    security: SECURITY_PATH.test(f.path) ? 1 : 0,
    refs: symbolRefs[f.path] ?? 0,
  });
  const sorted = [...files].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return rb.changedLines - ra.changedLines || rb.security - ra.security || rb.refs - ra.refs || a.path.localeCompare(b.path);
  });

  const keep = new Set<GitFileChange>();
  const replace = new Map<GitFileChange, GitFileChange>();
  const dropped: DiffBudgetEntry[] = [];
  const partial: DiffBudgetEntry[] = [];
  let used = 0;
  for (const f of sorted) {
    const entry = { path: f.path, textLength: f.textLength, changedLines: f.additions + f.deletions };
    if (used + f.textLength <= limit) {
      keep.add(f);
      used += f.textLength;
      continue;
    }
    if (used === 0) {
      const text = trimFileText(f.raw, limit);
      keep.add(f);
      replace.set(f, { ...f, raw: text, textLength: text.length });
      partial.push(entry);
      used = text.length;
      continue;
    }
    dropped.push(entry);
  }
  const kept = files.filter((f) => keep.has(f)).map((f) => replace.get(f) ?? f);
  return { kept, dropped, partial, usedLength: used, limit, truncated: true };
}

function nameList(entries: DiffBudgetEntry[], max = 8): string {
  const names = entries.slice(0, max).map((e) => e.path);
  return entries.length > max ? `${names.join('、')} 等 ${entries.length} 个` : names.join('、');
}

function emptyStats(commits = 0): GitDiffStats {
  return { files: 0, additions: 0, deletions: 0, commits };
}

function buildCollection(
  raw: string,
  commits: GitCommitEntry[],
  range: GitCollection['range'],
  source: GitCollection['source'],
  opts: GitCollectionOptions,
): GitCollection {
  const files = parseUnifiedDiff(raw);
  const budget = applyDiffBudget(files, opts.diffLimit ?? GIT_DIFF_TEXT_LIMIT, opts.symbolRefs);
  const warnings: string[] = [];
  const totalLength = files.reduce((sum, f) => sum + f.textLength, 0);
  if (budget.truncated) {
    warnings.push(`diff 文本 ${totalLength} 字符超过单仓上限 ${budget.limit}，已按优先级丢弃 ${budget.dropped.length} 个文件：${nameList(budget.dropped)}`);
    if (budget.partial.length > 0) warnings.push(`单文件超出剩余预算，已保头保尾截断：${nameList(budget.partial)}`);
  }
  if (files.length === 0) warnings.push('区间内无文件变更');
  return {
    source,
    range,
    files: budget.kept,
    hunks: budget.kept.flatMap((f) => f.hunks),
    commits,
    stats: {
      files: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      commits: commits.length,
    },
    budget: { dropped: budget.dropped, partial: budget.partial, usedLength: budget.usedLength, limit: budget.limit, truncated: budget.truncated },
    warnings,
  };
}

/** 取某提交的第一父提交（首末 SHA 形态需要「首」的前一站作为 diff 基线） */
async function resolveFirstParent(cwd: string, revision: string, opts: GitCollectOptions): Promise<string | null> {
  const r = await runGitReadonly('log', ['--format=%H%x09%P', '-n1'], [revision], cwd, opts);
  const line = r.stdout.split('\n').find(Boolean);
  if (!line) throw new GitCollectError('failed', `无法解析版本「${revision}」的提交信息`);
  const [, parents = ''] = line.split('\t');
  return parents.trim().split(' ').filter(Boolean)[0] ?? null;
}

/** 时间窗内最早的提交及其父提交；窗口为空返回 null */
async function resolveOldestSince(
  cwd: string,
  since: string,
  head: string,
  opts: GitCollectOptions,
): Promise<{ sha: string; parent: string | null } | null> {
  const r = await runGitReadonly('log', [`--since=${since}`, '--format=%H%x09%P', '--reverse'], [head], cwd, opts);
  const line = r.stdout.split('\n').find(Boolean);
  if (!line) return null;
  const [sha, parents = ''] = line.split('\t');
  if (!sha) return null;
  return { sha, parent: parents.trim().split(' ').filter(Boolean)[0] ?? null };
}

/** 三形态归一：产出 diff 与 log 各自的位置参数，并把「时间窗/首末 SHA」换算成可 diff 的基线 */
export async function resolveGitRange(
  cwd: string,
  input: GitRangeInput,
  opts: GitCollectOptions = {},
): Promise<ResolvedGitRange> {
  switch (input.shape) {
    case 'base-head': {
      if (!input.base) throw new GitCollectError('denied', 'base-head 形态需要 base（分支/标签/SHA）');
      const base = assertSingleRevision(input.base);
      const head = assertSingleRevision(input.head ?? 'HEAD');
      return {
        shape: input.shape,
        label: `${base}..${head}`,
        base,
        head,
        diffPositional: [base, head],
        logPositional: [`${base}..${head}`],
        logFlags: [],
        empty: false,
      };
    }
    case 'first-last': {
      if (!input.base || !input.head) throw new GitCollectError('denied', '首末 SHA 形态需要两个版本号');
      const first = assertSingleRevision(input.base);
      const last = assertSingleRevision(input.head);
      const parent = await resolveFirstParent(cwd, first, opts);
      const base = parent ?? GIT_EMPTY_TREE_SHA1;
      return {
        shape: input.shape,
        label: `${first}..${last}`,
        base,
        head: last,
        diffPositional: [base, last],
        // 根提交没有父：整段历史到 last 即为「含首」的区间
        logPositional: parent ? [`${base}..${last}`] : [last],
        logFlags: [],
        empty: false,
      };
    }
    case 'since': {
      if (!input.since) throw new GitCollectError('denied', '时间窗形态需要 since 起点');
      const since = assertSafeSince(input.since);
      const head = assertSingleRevision(input.head ?? 'HEAD');
      const oldest = await resolveOldestSince(cwd, since, head, opts);
      if (!oldest) {
        return { shape: input.shape, label: `自 ${since}`, base: '', head, diffPositional: [], logPositional: [], logFlags: [], empty: true };
      }
      const base = oldest.parent ?? GIT_EMPTY_TREE_SHA1;
      return {
        shape: input.shape,
        label: `自 ${since}`,
        base,
        head,
        diffPositional: [base, head],
        logPositional: [head],
        logFlags: [`--since=${since}`],
        empty: false,
      };
    }
    default: {
      const shape: never = input.shape;
      throw new GitCollectError('denied', `未知区间形态「${String(shape)}」`);
    }
  }
}

/** 三形态统一采集入口：`{ files[], hunks[], commits[], stats }` + 预算截断结果 */
export async function collectGitRange(
  cwd: string,
  input: GitRangeInput,
  opts: GitCollectionOptions = {},
): Promise<GitCollection> {
  const resolved = await resolveGitRange(cwd, input, opts);
  const range: GitCollection['range'] = { shape: resolved.shape, label: resolved.label, base: resolved.base, head: resolved.head };
  if (resolved.empty) {
    return {
      source: 'git',
      range,
      files: [],
      hunks: [],
      commits: [],
      stats: emptyStats(),
      budget: { dropped: [], partial: [], usedLength: 0, limit: opts.diffLimit ?? GIT_DIFF_TEXT_LIMIT, truncated: false },
      warnings: [`时间窗「${resolved.label}」内无提交：请放宽区间或改用其他形态`],
    };
  }
  const commits = await collectCommitLog(cwd, resolved.logPositional, opts, resolved.logFlags);
  const raw = await collectDiff(cwd, resolved.diffPositional, opts.contextLines ?? 3, opts);
  return buildCollection(raw, commits, range, 'git', opts);
}

/** 无 git / 非仓库时的降级判定：卡片据此显式提示并切「粘贴 patch」 */
export interface CollectionModeDecision {
  mode: 'git' | 'patch';
  probe: GitProbeResult;
  reason?: string;
}

export async function resolveCollectionMode(cwd: string, opts: GitCollectOptions = {}): Promise<CollectionModeDecision> {
  const probe = await probeRepository(cwd, opts);
  if (probe.available && probe.isRepo) return { mode: 'git', probe };
  let reason: string;
  if (!probe.available) reason = '未找到 git 命令：请安装 Git，或改用「粘贴 patch」模式';
  else if (probe.kind === 'not-a-repo') reason = '工作空间不是 Git 仓库：请初始化仓库，或改用「粘贴 patch」模式';
  else reason = `Git 采集不可用（${probe.kind ?? 'unknown'}）：${probe.detail ?? ''} 请改用「粘贴 patch」模式`;
  return { mode: 'patch', probe, reason };
}

/** 粘贴 patch：接受 unified diff 全文（上限同讲稿端点 raw 30mb），解析结果与 Git 采集同形 */
export function collectPatchRange(
  patchText: string,
  opts: { diffLimit?: number; symbolRefs?: Record<string, number> } = {},
): GitCollection {
  const text = patchText.startsWith('\uFEFF') ? patchText.slice(1) : patchText;
  if (Buffer.byteLength(text, 'utf8') > LECTURE_PATCH_TEXT_LIMIT) {
    throw new GitCollectError('too-large', `粘贴 patch 超过 ${LECTURE_PATCH_TEXT_LIMIT / (1024 * 1024)}MB 上限，请分次评审或收窄范围`);
  }
  if (!text.trim()) throw new GitCollectError('invalid-patch', '粘贴内容为空：请粘贴 git diff 输出的 unified diff 全文');
  if (!/^diff --git /m.test(text) && !/^--- .+\n\+\+\+ /m.test(text)) {
    throw new GitCollectError('invalid-patch', '未识别到 unified diff：请粘贴 git diff 输出（应以 diff --git 开头）');
  }
  return buildCollection(text, [], { shape: 'patch', label: '粘贴 patch', base: '', head: '' }, 'patch', opts);
}
