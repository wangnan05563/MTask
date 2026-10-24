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

/** 只对本次子进程生效的输出配置（顺序即 argv 前缀） */
export const GIT_OUTPUT_CONFIG = [
  '-c', 'i18n.logOutputEncoding=utf-8',
  '-c', 'core.quotepath=false',
] as const;

/** 每个只读子命令允许的选项（白名单，防止调用方借选项写盘或改配置） */
const ALLOWED_FLAGS: Record<GitReadonlySubcommand, RegExp[]> = {
  'rev-parse': [/^--is-inside-work-tree$/],
  log: [/^--oneline$/, /^--no-merges$/, /^--format=[%\w.:{}+\-/ ]+$/, /^-n\d{1,4}$/],
  diff: [/^--ignore-cr-at-eol$/, /^--stat$/, /^--numstat$/, /^-U\d{1,3}$/],
  show: [],
};

export type GitErrorKind = 'no-git' | 'not-a-repo' | 'timeout' | 'too-large' | 'denied' | 'failed';

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

/** 提交清单（`git log --no-merges`）；解析失败的行原样丢弃，不阻断采集 */
export async function collectCommitLog(cwd: string, range: string[], opts: GitCollectOptions = {}): Promise<GitCommitEntry[]> {
  const revs = range.map(assertSafeRevision);
  const r = await runGitReadonly('log', ['--no-merges', LOG_FORMAT], revs, cwd, opts);
  return r.stdout.split('\n').filter(Boolean).flatMap((line) => {
    const [sha, author, date, ...rest] = line.split('\t');
    if (!sha || !author || !date) return [];
    return [{ sha, author, date, subject: rest.join('\t') }];
  });
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
