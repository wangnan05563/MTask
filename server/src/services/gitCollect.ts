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
  'rev-parse': [/^--is-inside-work-tree$/, /^--verify$/, /^--quiet$/],
  // T03302：Git 树取数需要 --all（全分支）、--skip/-n（懒加载分页）、--no-walk（只取点名提交）
  // T03590：`--until` 与 `--since` 同形（日期窗口右端），字面量范围与左端一致
  log: [/^--oneline$/, /^--no-merges$/, /^--format=[%\w.:{}+\-/ ]+$/, /^-n\d{1,4}$/, /^--since=[\w:+\-. ]{1,64}$/, /^--until=[\w:+\-. ]{1,64}$/, /^--reverse$/, /^--all$/, /^--skip=\d{1,4}$/, /^--no-walk$/],
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
  // T03310：`--` 是 git 的选项/路径分隔符，尾随它可避免「形似版本号的分支名」被当成路径
  if (value === '--') return value;
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

/** 纯日期形态（`--since`/`--until` 里需要补齐到当天零点/末刻，否则 git 按当天 12:00 解释） */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 时间窗起点：允许 ISO 日期与「14 days ago」类相对写法，但不含引号/分号等元字符 */
export function assertSafeSince(value: string, what = '时间窗起点'): string {
  const since = value.trim();
  if (!since || since.length > 64) throw new GitCollectError('denied', `非法${what}「${value}」`);
  if (!/^[\w:+\-. ]+$/.test(since)) throw new GitCollectError('denied', `非法${what}字符「${value}」`);
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
  /** 提交者（T03303：与 author 一起参与提交人过滤——一个过滤词命中任一字段即算命中） */
  committer: string;
  date: string;
  subject: string;
}

const LOG_FORMAT = '--format=%H%x09%an%x09%cn%x09%aI%x09%s';

function parseCommitLog(stdout: string): GitCommitEntry[] {
  return stdout.split('\n').filter(Boolean).flatMap((line) => {
    const [sha, author, committer, date, ...rest] = line.split('\t');
    if (!sha || !author || !committer || !date) return [];
    return [{ sha, author, committer, date, subject: rest.join('\t') }];
  });
}

/**
 * T03303：提交人过滤文本。
 * 写法：`张三`（单值）｜`张三, 李四`（且：两个词都要命中，靠 author+committer 两字段互补）｜`张三 | 李四`（或）。
 * 一个「词」命中 = 该提交的 author **或** committer 与它完全相同（去空白、忽略大小写）。
 */
export interface AuthorFilter {
  /** 或关系的分组；组内每个词都必须命中（且关系） */
  groups: string[][];
  /** 归一后的回显文本（预检/日志用） */
  normalized: string;
}
const MAX_AUTHOR_TERMS = 8;
const MAX_AUTHOR_TERM_LEN = 64;

export function parseAuthorFilter(raw: unknown): AuthorFilter | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new GitCollectError('denied', '提交人过滤必须是字符串');
  const text = raw.trim();
  if (!text) return null;
  const rawGroups = text.split(/[|｜]/).map((g) => g.split(/[,，＋+]/).map((t) => t.trim()));
  if (rawGroups.some((g) => g.length === 0 || g.some((t) => t === ''))) {
    throw new GitCollectError('denied', `提交人过滤「${text}」含空段：请写成「张三」「张三, 李四」（且）或「张三 | 李四」（或）`);
  }
  const groups = rawGroups;
  const terms = groups.flat();
  if (terms.length > MAX_AUTHOR_TERMS) throw new GitCollectError('denied', `提交人过滤最多 ${MAX_AUTHOR_TERMS} 个词（当前 ${terms.length} 个）`);
  for (const t of terms) {
    if (t.length > MAX_AUTHOR_TERM_LEN) throw new GitCollectError('denied', `提交人「${t.slice(0, 12)}…」超过 ${MAX_AUTHOR_TERM_LEN} 字`);
    if (/[\0\r\n]/.test(t)) throw new GitCollectError('denied', '提交人过滤含控制字符');
  }
  return { groups, normalized: groups.map((g) => g.join(', ')).join(' | ') };
}

const sameWho = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** 任一「或组」内全部词命中即保留（组内是且，组间是或） */
export function commitMatchesAuthorFilter(
  entry: Pick<GitCommitEntry, 'author' | 'committer'>,
  filter: AuthorFilter,
): boolean {
  return filter.groups.some((group) => group.every((term) => sameWho(entry.author, term) || sameWho(entry.committer, term)));
}

/**
 * 过滤只在 JS 侧做，不向 git 传 `--author/--committer`：git 对这两类选项是**且**关系
 * （author 命中任一 --author，且 committer 命中任一 --committer），而本口径要的是「词命中 author 或 committer」，
 * 预筛会把「author 不匹配但 committer 匹配」的提交提前丢掉（见 verify-t03303 I-04）。
 */

/** 提交清单（`git log --no-merges`）；解析失败的行原样丢弃，不阻断采集 */
export async function collectCommitLog(
  cwd: string,
  range: string[],
  opts: GitCollectOptions = {},
  extraFlags: string[] = [],
  authorFilter?: string | null,
): Promise<GitCommitEntry[]> {
  const revs = range.map(assertSafeRevision);
  const filter = parseAuthorFilter(authorFilter);
  const r = await runGitReadonly('log', ['--no-merges', LOG_FORMAT, ...extraFlags], [...revs, '--'], cwd, opts);
  const entries = parseCommitLog(r.stdout);
  return filter ? entries.filter((e) => commitMatchesAuthorFilter(e, filter)) : entries;
}

/**
 * T03590：提交人候选——作者多选控件的选项源。
 * 取最近 N 个提交的 author/committer 名去重，按出现次数降序（同名不同大小写按首次出现归一）；
 * 与 `parseAuthorFilter` 的「精确匹配 author 或 committer」同口径，下拉里出现的名字一定能命中。
 */
export async function collectAuthorNames(
  cwd: string,
  opts: GitCollectOptions & { limit?: number } = {},
): Promise<{ authors: string[]; scanned: number }> {
  const limit = clampInt(opts.limit, 500, 1, 2000);
  const r = await runGitReadonly('log', ['--format=%an%x09%cn', `-n${limit}`], ['--'], cwd, opts);
  const counts = new Map<string, { name: string; count: number }>();
  const lines = r.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    for (const raw of line.split('\t')) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.count += 1;
      else counts.set(key, { name, count: 1 });
    }
  }
  const authors = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((e) => e.name);
  return { authors, scanned: lines.length };
}

/** 增量统计原文（`diff --stat`，带行尾口径）；超 2MB 由调用方按 FR-1.4 截断并点名 */
export async function collectDiffStat(cwd: string, range: string[], opts: GitCollectOptions = {}): Promise<string> {
  const revs = range.map(assertSafeRevision);
  const r = await runGitReadonly('diff', ['--stat', '--ignore-cr-at-eol'], [...revs, '--'], cwd, opts);
  return r.stdout;
}

/** 增量正文（unified diff，`contextLines` 默认 3）；超 2MB 由调用方按 FR-1.4 截断并点名 */
export async function collectDiff(cwd: string, range: string[], contextLines = 3, opts: GitCollectOptions = {}): Promise<string> {
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100) {
    throw new GitCollectError('denied', `非法上下文行数「${contextLines}」`);
  }
  const revs = range.map(assertSafeRevision);
  const r = await runGitReadonly('diff', [`-U${contextLines}`, '--ignore-cr-at-eol'], [...revs, '--'], cwd, opts);
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

/**
 * T03310：把「这个引用到底存不存在」提前到拼 argv 前判。
 * 不做这步时，写错的基线只会换来 git 的原生报错
 * `fatal: ambiguous argument 'X..HEAD': unknown revision or path not in the working tree`，
 * 用户分不清是分支名拼错、没 fetch、还是把标签名当成了分支。
 */
export async function assertResolvableCommitish(
  cwd: string,
  token: string,
  role: string,
  opts: GitCollectOptions = {},
): Promise<string> {
  const rev = assertSingleRevision(token);
  try {
    await runGitReadonly('rev-parse', ['--verify', '--quiet'], [`${rev}^{commit}`], cwd, opts);
  } catch (e) {
    if (!(e instanceof GitCollectError)) throw e;
    if (e.kind === 'no-git' || e.kind === 'not-a-repo' || e.kind === 'timeout' || e.kind === 'too-large') throw e;
    throw new GitCollectError(
      'failed',
      `${role}「${rev}」无法解析为提交：仓库里没有这个分支/标签/SHA。`
      + '请核对分支大小写、远端分支是否要写成 origin/ 前缀、标签是否已 fetch（git branch -a / git tag -l 可查）。'
      + `原始报错：${e.message.slice(0, 200)}`,
    );
  }
  return rev;
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

export type GitRangeShape = 'base-head' | 'first-last' | 'since' | 'commits';
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
  /** T03590：since 形态的可选时间窗右端（含）；缺省不设右界，行为与单 since 逐字节一致 */
  until?: string;
  /** T03303：提交人过滤（`甲`｜`甲, 乙` 且｜`甲 | 乙` 或），只筛提交清单，不改 diff 范围 */
  authorFilter?: string;
  /** T03302：`commits` 形态——Git 树里点选的提交 SHA（连续段自动并成区间，非连续按提交并集） */
  commits?: string[];
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
  return finalizeCollection(parseUnifiedDiff(raw), commits, range, source, opts);
}

/** 预算 + 统计 + 告警收口（区间采集与「多选提交并集」共用，避免两套口径） */
function finalizeCollection(
  files: GitFileChange[],
  commits: GitCommitEntry[],
  range: GitCollection['range'],
  source: GitCollection['source'],
  opts: GitCollectionOptions,
): GitCollection {
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

/**
 * T03590：时间窗归一成「窗口内最新/最旧提交」——有 until 时 diff 必须止于窗口最新提交，
 * 否则会把右端之后的改动也算进来。窗口为空返回 null。
 */
async function resolveSinceWindow(
  cwd: string,
  flags: string[],
  head: string,
  opts: GitCollectOptions,
): Promise<{ newest: SinceCommit; oldest: SinceCommit } | null> {
  const r = await runGitReadonly('log', [...flags, '--format=%H%x09%P'], [head], cwd, opts);
  const lines = r.stdout.split('\n').filter(Boolean);
  const parse = (line: string): SinceCommit => {
    const [sha, parents = ''] = line.split('\t');
    return { sha, parent: parents.trim().split(' ').filter(Boolean)[0] ?? null };
  };
  const newest = lines[0];
  const oldest = lines[lines.length - 1];
  if (!newest || !oldest) return null;
  return { newest: parse(newest), oldest: parse(oldest) };
}

interface SinceCommit {
  sha: string;
  parent: string | null;
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
      const base = await assertResolvableCommitish(cwd, input.base, '基线版本', opts);
      const head = await assertResolvableCommitish(cwd, input.head ?? 'HEAD', '目标版本', opts);
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
      const first = await assertResolvableCommitish(cwd, input.base, '首个提交', opts);
      const last = await assertResolvableCommitish(cwd, input.head, '末个提交', opts);
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
      const sinceRaw = assertSafeSince(input.since);
      const untilRaw = input.until ? assertSafeSince(input.until, '时间窗截止') : '';
      // T03590：有右端时是「日期范围」语义——git 把纯日期当成当天 12:00（approxidate 默认），
      // 不补齐会漏掉起始日上午 / 截止日下午的提交。单 since 保持原样，与改造前逐字节一致。
      const since = untilRaw && DATE_ONLY_RE.test(sinceRaw) ? `${sinceRaw} 00:00:00` : sinceRaw;
      const until = untilRaw && DATE_ONLY_RE.test(untilRaw) ? `${untilRaw} 23:59:59` : untilRaw;
      const head = await assertResolvableCommitish(cwd, input.head ?? 'HEAD', '目标版本', opts);
      const label = until ? `${since} ~ ${until}` : `自 ${since}`;
      const logFlags = until ? [`--since=${since}`, `--until=${until}`] : [`--since=${since}`];
      const win = await resolveSinceWindow(cwd, logFlags, head, opts);
      if (!win) {
        return { shape: input.shape, label, base: '', head, diffPositional: [], logPositional: [], logFlags: [], empty: true };
      }
      const base = win.oldest.parent ?? GIT_EMPTY_TREE_SHA1;
      // 无右端时终点仍是原来的 head 写法（分支名/HEAD），保证与 T03590 之前逐字节一致；
      // 有右端才钉成窗口最新提交，避免 diff 越过 until
      const end = until ? win.newest.sha : head;
      return {
        shape: input.shape,
        label,
        base,
        head: end,
        diffPositional: [base, end],
        // 位置参数留给原 head（分支/标签名），窗口筛选交给 logFlags
        logPositional: [head],
        logFlags,
        empty: false,
      };
    }
    case 'commits': {
      // T03302：多选提交没有「一对版本号」的区间可言，走 collectCommitsUnion 的并集采集
      throw new GitCollectError('denied', 'commits 形态不按版本号区间解析，请走 collectCommitsUnion');
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
  if (input.shape === 'commits') return collectCommitsUnion(cwd, input.commits ?? [], opts);
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
  const commits = await collectCommitLog(cwd, resolved.logPositional, opts, resolved.logFlags, input.authorFilter);
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

// ---------------------------------------------------------------------------
// T03302：Git 树取数（IDEA 风格日志视图）+「多选提交」并集采集
//
// 弹窗要的是一条能懒加载、带分支/标签装饰、带 parents（画车道用）的提交清单，
// 以及「用户点的不一定是连续段」时怎么把它变成 diff。口径统一成
// **每个选中提交相对其第一父提交的增量之并集**（与 `git log -p`、IDEA 的显示一致），
// 连续段自动并成一次区间 diff，省掉逐条 spawn。
// ---------------------------------------------------------------------------

/** Git 树一页最多多少条（再大 DOM 与 git 输出都不划算） */
export const GIT_GRAPH_MAX_PAGE = 500;
export const GIT_GRAPH_DEFAULT_PAGE = 100;
/** 搜索态一次扫描的提交窗口上限：过滤在 JS 侧做，超窗要如实提示「只在最近 N 条里搜」 */
export const GIT_GRAPH_SEARCH_SCAN = 1000;
/** 一次评审最多点选多少个提交 */
export const MAX_SELECTED_COMMITS = 200;

export interface GitRefName {
  type: 'branch' | 'remote' | 'tag';
  name: string;
}

export interface GitGraphEntry {
  sha: string;
  /** 父提交 SHA（车道布局与并集基线都靠它；空数组 = 根提交） */
  parents: string[];
  refs: GitRefName[];
  /** 该提交是否 HEAD 所指 */
  head: boolean;
  author: string;
  committer: string;
  date: string;
  subject: string;
}

/** `%D` 只有装饰名；这里额外带 %cn，让并集采集能直接产出 GitCommitEntry */
const GRAPH_FORMAT = '--format=%H%x09%P%x09%D%x09%an%x09%cn%x09%aI%x09%s';

function parseRefDecorate(raw: string): { refs: GitRefName[]; head: boolean } {
  const refs: GitRefName[] = [];
  let head = false;
  for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const tag = /^tag:\s*(.+)$/.exec(token);
    if (tag) { refs.push({ type: 'tag', name: tag[1] }); continue; }
    if (token.startsWith('HEAD')) {
      head = true;
      const arrow = token.split('->')[1]?.trim();
      if (arrow) refs.push({ type: 'branch', name: arrow });
      continue;
    }
    refs.push({ type: token.includes('/') ? 'remote' : 'branch', name: token });
  }
  return { refs, head };
}

function parseGraphLog(stdout: string): GitGraphEntry[] {
  const out: GitGraphEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [sha, parents = '', decorate = '', author = '', committer = '', date = '', ...rest] = line.split('\t');
    if (!/^[0-9a-f]{40}$/.test(sha) || !date) continue;
    const { refs, head } = parseRefDecorate(decorate);
    out.push({ sha, parents: parents.trim().split(' ').filter(Boolean), refs, head, author, committer, date, subject: rest.join('\t') });
  }
  return out;
}

export interface GitGraphQuery {
  /** 起点版本（分支/标签/SHA），缺省 HEAD；`all=true` 时忽略 */
  head?: string;
  /** true = 全部分支（`--all`），此时 head 无意义 */
  all?: boolean;
  /** 懒加载偏移（0–9999） */
  skip?: number;
  /** 本页条数（1–500） */
  limit?: number;
  /** 关键词：在 JS 侧对小标题/SHA/作者做子串过滤，不向 git 传 --grep */
  search?: string;
}

export interface GitGraphPage {
  commits: GitGraphEntry[];
  hasMore: boolean;
  skip: number;
  limit: number;
  /** 本次实际扫描的提交数；搜索态下命中只来自这个窗口 */
  scanned: number;
  scanTruncated: boolean;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function matchesSearch(e: GitGraphEntry, needle: string): boolean {
  return e.subject.toLowerCase().includes(needle) || e.sha.startsWith(needle)
    || e.author.toLowerCase().includes(needle) || e.committer.toLowerCase().includes(needle);
}

/** Git 树取数一页：`git log --format=<graph> [--all | <head>] [--skip=n] -n<limit+1>`（多取一条判 hasMore） */
export async function collectGitGraph(cwd: string, q: GitGraphQuery = {}, opts: GitCollectOptions = {}): Promise<GitGraphPage> {
  const limit = clampInt(q.limit, GIT_GRAPH_DEFAULT_PAGE, 1, GIT_GRAPH_MAX_PAGE);
  const skip = clampInt(q.skip, 0, 0, 9999);
  const needle = (q.search ?? '').trim().toLowerCase();
  const all = q.all === true;
  const fetchCount = needle ? Math.min(GIT_GRAPH_SEARCH_SCAN, 9999) : Math.min(GIT_GRAPH_MAX_PAGE + 1, limit + 1);
  const flags = [
    GRAPH_FORMAT,
    ...(all ? ['--all'] : []),
    ...(needle ? [] : [`--skip=${skip}`]),
    `-n${fetchCount}`,
  ];
  const positional = all ? ['--'] : [assertSafeRevision((q.head ?? '').trim() || 'HEAD'), '--'];
  const r = await runGitReadonly('log', flags, positional, cwd, opts);
  const allCommits = parseGraphLog(r.stdout);
  if (needle) {
    const hits = allCommits.filter((e) => matchesSearch(e, needle));
    return {
      commits: hits.slice(0, limit),
      hasMore: hits.length > limit || allCommits.length >= fetchCount,
      skip: 0,
      limit,
      scanned: allCommits.length,
      scanTruncated: allCommits.length >= fetchCount,
    };
  }
  return { commits: allCommits.slice(0, limit), hasMore: allCommits.length > limit, skip, limit, scanned: allCommits.length, scanTruncated: false };
}

/** 点选提交的合法性：只收 hex SHA（弹窗给的就是 40 位），拒绝分支名、`..`、以 `-` 开头的选项形状 */
export function normalizeSelectedCommits(input: unknown): string[] {
  if (!Array.isArray(input)) throw new GitCollectError('denied', '选中提交必须是 SHA 数组');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') throw new GitCollectError('denied', '选中提交必须是字符串 SHA');
    const sha = raw.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new GitCollectError('denied', `非法提交 SHA「${raw.slice(0, 40)}」（Git 树点选的应是十六进制 SHA）`);
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
  }
  if (out.length === 0) throw new GitCollectError('denied', '至少要在 Git 树里点选 1 个提交');
  if (out.length > MAX_SELECTED_COMMITS) throw new GitCollectError('denied', `一次最多点选 ${MAX_SELECTED_COMMITS} 个提交（当前 ${out.length} 个），请收窄范围`);
  return out;
}

/** 一次 `--no-walk` 拿齐选中提交的 parents 与元信息（逐条 spawn 按 200 选在 Windows 上就是几十秒） */
export async function resolveCommitsInfo(cwd: string, shas: readonly string[], opts: GitCollectOptions = {}): Promise<Map<string, GitGraphEntry>> {
  const bySha = new Map<string, GitGraphEntry>();
  if (shas.length === 0) return bySha;
  try {
    const r = await runGitReadonly('log', ['--no-walk', GRAPH_FORMAT], [...shas, '--'], cwd, opts);
    for (const e of parseGraphLog(r.stdout)) bySha.set(e.sha, e);
    return bySha;
  } catch (e) {
    const kind = e instanceof GitCollectError ? e.kind : 'failed';
    if (kind !== 'failed') throw e;
    // 整条 --no-walk 失败多半是「某个 SHA 已不在仓库里」；逐条复跑只为了点名，不参与正常路径
    const missing: string[] = [];
    for (const sha of shas) {
      try {
        const one = await runGitReadonly('log', ['--no-walk', GRAPH_FORMAT, '-n1'], [sha, '--'], cwd, opts);
        const [entry] = parseGraphLog(one.stdout);
        if (entry) bySha.set(entry.sha, entry); else missing.push(sha);
      } catch { missing.push(sha); }
    }
    if (missing.length === 0) throw e;
    throw new GitCollectError('failed',
      `选中的提交在仓库里不存在（分支被 rebase/force-push 丢弃？）：${missing.slice(0, 5).map((s) => s.slice(0, 7)).join('、')}`
      + `${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}，请在 Git 树里重新选择`);
  }
}

export interface CommitRun {
  base: string;
  head: string;
  commits: GitGraphEntry[];
}

/**
 * 把点选集合压成尽量少的连续段：仅当「段内每个提交只有单个父、且该父也被选中」时才并段。
 * 合并提交永远只当段头——`第一父..merge` 才是它自己引入的增量，继续向上并就把旁支也算进来了。
 */
export function planCommitRuns(entries: readonly GitGraphEntry[]): CommitRun[] {
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.sha.localeCompare(a.sha));
  const bySha = new Map(sorted.map((e) => [e.sha, e]));
  const used = new Set<string>();
  const runs: CommitRun[] = [];
  for (const start of sorted) {
    if (used.has(start.sha)) continue;
    used.add(start.sha);
    const chain = [start];
    let oldest = start;
    while (oldest.parents.length === 1) {
      const next = bySha.get(oldest.parents[0]);
      if (!next || used.has(next.sha)) break;
      used.add(next.sha);
      chain.push(next);
      oldest = next;
    }
    runs.push({ base: oldest.parents[0] ?? GIT_EMPTY_TREE_SHA1, head: start.sha, commits: chain });
  }
  return runs;
}

/** 两段 diff 里同一文件各出现一次时合成一块：hunk 顺排、增删行相加、raw 拼接 */
function mergeChangesByPath(chunks: readonly GitFileChange[]): GitFileChange[] {
  const order: string[] = [];
  const byPath = new Map<string, GitFileChange>();
  for (const c of chunks) {
    const prev = byPath.get(c.path);
    if (!prev) {
      byPath.set(c.path, { ...c, hunks: [...c.hunks] });
      order.push(c.path);
      continue;
    }
    prev.hunks.push(...c.hunks);
    prev.additions += c.additions;
    prev.deletions += c.deletions;
    prev.binary = prev.binary || c.binary;
    if (c.oldPath && !prev.oldPath) prev.oldPath = c.oldPath;
    prev.raw = `${prev.raw}\n${c.raw}`;
    prev.textLength = prev.raw.length;
  }
  return order.map((p) => byPath.get(p)!);
}

/** 「多选提交」形态的采集：逐段 diff → 按路径合并 → 与区间采集共用同一份预算与统计口径 */
export async function collectCommitsUnion(
  cwd: string,
  selected: readonly string[],
  opts: GitCollectionOptions = {},
): Promise<GitCollection> {
  const shas = normalizeSelectedCommits(selected);
  const info = await resolveCommitsInfo(cwd, shas);
  const entries: GitGraphEntry[] = [];
  for (const s of shas) {
    const full = info.has(s) ? s : [...info.keys()].find((k) => k.startsWith(s));
    const entry = full ? info.get(full) : undefined;
    if (entry) entries.push(entry);
  }
  if (entries.length !== shas.length) {
    const matched = new Set(entries.map((e) => e.sha));
    const missing = shas.filter((s) => !matched.has(s) && ![...matched].some((full) => full.startsWith(s)));
    throw new GitCollectError('failed', `选中的提交在仓库里不存在：${missing.slice(0, 5).map((s) => s.slice(0, 7)).join('、')}，请在 Git 树里重新选择`);
  }
  const runs = planCommitRuns(entries);
  const chunks: GitFileChange[] = [];
  for (const run of runs) {
    const raw = await collectDiff(cwd, [run.base, run.head], opts.contextLines ?? 3, opts);
    chunks.push(...parseUnifiedDiff(raw));
  }
  const commits = [...entries].sort((a, b) => a.date.localeCompare(b.date)).map((e): GitCommitEntry => ({
    sha: e.sha, author: e.author, committer: e.committer, date: e.date, subject: e.subject,
  }));
  const newest = [...entries].sort((a, b) => b.date.localeCompare(a.date))[0];
  const oldest = [...entries].sort((a, b) => a.date.localeCompare(b.date))[0];
  const range: GitCollection['range'] = {
    shape: 'commits',
    label: `已选 ${shas.length} 个提交（${runs.length} 段）`,
    base: oldest.parents[0] ?? GIT_EMPTY_TREE_SHA1,
    head: newest.sha,
  };
  const collection = finalizeCollection(mergeChangesByPath(chunks), commits, range, 'git', opts);
  const merges = entries.filter((e) => e.parents.length > 1);
  if (merges.length > 0) {
    collection.warnings.unshift(`选中 ${merges.length} 个合并提交（${merges.slice(0, 3).map((e) => e.sha.slice(0, 7)).join('、')}${merges.length > 3 ? ' 等' : ''}）：`
      + '按第一父提交计增量，旁支自带但未点选的提交不计入');
  }
  if (runs.length > 1) {
    collection.warnings.unshift(`非连续选择：${shas.length} 个提交合成 ${runs.length} 段，未点选的中间提交不计入增量`);
  }
  return collection;
}
