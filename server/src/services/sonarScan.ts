/**
 * 八期 §3.4.2/§3.4.3「Sonar 质量扫描」执行引擎（T03376–T03382、T03428、T03369）。
 *
 * 七阶段（每阶段一个 SSE `stage` 事件，同时写 `console_jobs` 供刷新后恢复运行徽标）：
 *   1 collect   汇总增量文件清单——直接复用 §3.3 的 `planExtract`，取数口径只有一套
 *   2 snapshot  `cat-file --batch` 导出到 MTask_DATA_DIR/tmp/sonar-<job>/（保留相对路径）
 *   3 config    快照目录写临时 sonar-project.properties
 *   4 scan      spawn 扫描器，输出按行流式入控制台（.scannerwork 落快照目录，不落被采集仓库）
 *   5 wait      轮询 /api/ce/component 到 SUCCESS/FAILED（排队时给「已 n 分钟」）
 *   6 fetch     /api/issues/search 分页拉全部未解决 issues
 *   7 writeback 阈值/上限过滤 → 建子任务 → 写指纹表 → 回执
 *
 * 三条不能妥协的口径：
 * - **只读红线**（AC-14）：全程只用白名单只读 git 子命令，被采集仓库 `git status` 必须逐字节不变；
 *   扫描工作目录、`.scannerwork`、properties 全在快照目录内，随 tmp 一起回收。
 * - **凭据不落盘**：Token 只进 HTTP 头与子进程环境变量，绝不写进 properties / 命令行 / 日志
 *   （PRD 阶段表把 token 列进 properties 是早期写法，以 §5 安全条款与 AC 为准）；
 *   扫描器输出里出现的 Token 原文一律先替成掩码再往控制台送。
 * - **洪泛有闸**（Q10）：默认只回写 blocker/critical、单次 ≤50 条，其余并成 1 条汇总子任务；
 *   7 天内同指纹不重复建单。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { getDb } from '../db/connection';
import { catFileBatch, collectCommitLog, normalizeSelectedCommits, resolveRevisionSha } from './gitCollect';
import type { BatchObject } from './gitCollect';
import { assertWithinLimits, extractTmpRoot, finalPathByRepo, finalPathKey, finalPathMap, planExtract } from './gitExtract';
import type { ExtractPlan } from './gitExtract';
import { ConsoleJobService } from './ConsoleJobService';
import { TaskService } from './TaskService';
import {
  looksLikeSonarToken, normalizeSonarUrl, planScannerSpawn, probeJava, probeScanner,
  projectKeyFor, readScanSettings, resolveScannerBin,
} from './sonarSettings';
import type { SonarProbe } from './sonarSettings';
import { scalarText } from '../util/scalarText';

/** 严重度内部口径（新旧两套 API 归一到这五档，PRD §3.4.2） */
export type ScanSeverity = 'blocker' | 'critical' | 'major' | 'minor' | 'info';
export const SEVERITY_ORDER: ScanSeverity[] = ['blocker', 'critical', 'major', 'minor', 'info'];
export const SEVERITY_LABEL: Record<ScanSeverity, string> = {
  blocker: '阻断', critical: '严重', major: '主要', minor: '次要', info: '提示',
};
/** Q10 甲：默认阈值与单次上限（现网待办池 172 条，无护栏会被洪泛淹没） */
export const DEFAULT_SEVERITIES: ScanSeverity[] = ['blocker', 'critical'];
export const WRITEBACK_CAP = 50;
/** 指纹去重窗口（天）；任务被物理删除不影响窗口，所以指纹必须独立成表 */
export const FP_TTL_DAYS = 7;
const ISSUE_PAGE_SIZE = 500;
const CE_POLL_MS = 3_000;
const CE_TIMEOUT_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;
/** 快照目录 TTL（与提取族同一把扫帚口径） */
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
/** 控制台日志上限：SSE 与 console_jobs 都不该为一次扫描背上无界内存 */
const MAX_LOG_LINES = 4_000;

export type ScanStage = 'collect' | 'snapshot' | 'config' | 'scan' | 'wait' | 'fetch' | 'writeback';

export class ScanError extends Error {
  readonly kind: string;
  readonly hint?: string;
  constructor(kind: string, message: string, hint?: string) {
    super(message);
    this.name = 'ScanError';
    this.kind = kind;
    if (hint) this.hint = hint;
  }
}

export interface ScanIssue {
  key: string;
  rule: string;
  severity: ScanSeverity;
  /** 快照/仓库内的相对路径（Sonar 的 component 形如 `projectKey:path`） */
  path: string;
  line: number;
  message: string;
  url: string;
  fingerprint: string;
  /** 归属任务（按「最后改动该文件的提交 → 任务」推得；推不出为空，计入 unattributed） */
  taskId: string | null;
  taskNo: string | null;
  taskTitle: string | null;
  /** 同一提交被多任务改动时的标注 */
  shared: boolean;
}

export interface WriteBackReceipts {
  created: number;
  skippedDuplicate: number;
  belowThreshold: number;
  failed: number;
  unattributed: number;
  failedNames: string[];
  summaryTaskNo: string | null;
  summaryFor: number;
}

export interface ScanResult {
  jobId: string;
  projectKey: string;
  serverUrl: string;
  snapshotHeadSha: string;
  currentHeadSha: string;
  /** 快照基于 SHA x，当前 HEAD 为 y，相差 n 个提交（时效判定用，PRD「扫描对象声明」） */
  headLag: number;
  files: number;
  bytes: number;
  commits: number;
  tasks: number;
  total: number;
  issues: ScanIssue[];
  grouped: Record<ScanSeverity, ScanIssue[]>;
  reportUrl: string;
  receipts: WriteBackReceipts | null;
}

export interface ScanInput {
  taskIds: string[];
  /** T04526：未关联任务的 Git 提交，与任务关联提交一起进快照，不写入 task_git_links */
  commitIds?: string[];
  /** T04576：手动提交的来源仓库（SHA → repoSub，空串=项目根仓库）；缺省则由服务端逐仓库判定 */
  commitRepos?: Record<string, string>;
  /** 手动提交为主、taskIds 为空时，用于定位项目与 workspace_path */
  projectIds?: string[];
  /** 不传则取映射里第一个已配置项目（与设置页连接测试同口径） */
  projectKey?: string;
  autoWriteBack?: boolean;
  severities?: ScanSeverity[];
  cap?: number;
}

/** 可注入依赖（门用假 SonarQube + 假扫描器跑全链，不打真机） */
export interface ScanDeps {
  fetchJson?: (url: string, token: string) => Promise<{ status: number; json: any }>;
  spawnScanner?: (spec: { command: string; args: string[]; shell: boolean }, env: Record<string, string>, onLine: (l: string) => void, signal?: AbortSignal) => Promise<{ code: number | null }>;
  cePollMs?: number;
  ceTimeoutMs?: number;
}

/* ------------------------- 纯函数：口径层 ------------------------- */

/**
 * 严重度归一。新（≥10.x，clean code taxonomy）走 `impacts.SEVERITY`，
 * 取值是 BLOCKER/HIGH/MEDIUM/LOW/INFO；旧走 `severity`，取值是 BLOCKER/CRITICAL/MAJOR/MINOR/INFO。
 * 两套的「高档」名字不同（HIGH vs CRITICAL），归一必须按位次而不是字面：HIGH→critical。
 */
export function normalizeSeverity(issue: any): ScanSeverity {
  const impacts = issue?.impacts;
  if (impacts && typeof impacts === 'object') {
    const raw = String(impacts.SEVERITY ?? '').trim().toUpperCase();
    if (raw === 'BLOCKER') return 'blocker';
    if (raw === 'HIGH') return 'critical';
    if (raw === 'MEDIUM') return 'major';
    if (raw === 'LOW') return 'minor';
    if (raw === 'INFO') return 'info';
    // impacts 在但取不到可用值：退回经典字段，而不是静默判成最低档
    const asClassic = CLASSIC[raw];
    if (asClassic) return asClassic;
  }
  const classic = CLASSIC[String(issue?.severity ?? '').trim().toUpperCase()];
  return classic ?? 'info';
}

const CLASSIC: Record<string, ScanSeverity> = {
  BLOCKER: 'blocker', CRITICAL: 'critical', MAJOR: 'major', MINOR: 'minor', INFO: 'info',
};

/** 优先级映射（§3.4.3） */
export function priorityOf(sev: ScanSeverity): 'high' | 'normal' | 'low' {
  if (sev === 'blocker' || sev === 'critical') return 'high';
  if (sev === 'major') return 'normal';
  return 'low';
}

/** 指纹 `sha256(rule|path|line|message)`——比标题查重稳（标题会随消息文案变） */
export function fingerprintOf(rule: string, path: string, line: number, message: string): string {
  return createHash('sha256').update(`${rule}|${path}|${line}|${message}`).digest('hex');
}

/** Sonar 的 component 是 `projectKey:相对路径`，取不到就原样返回（不猜路径） */
export function pathOfComponent(component: unknown, projectKey: string): string {
  const c = scalarText(component ?? '');
  if (!c) return '';
  const prefix = `${projectKey}:`;
  return c.startsWith(prefix) ? c.slice(prefix.length) : c;
}

/** 外链必须过同一套地址校验：脏配置拼出的 href 不能交给 shell.openExternal */
export function reportUrlFor(serverUrl: string, projectKey: string): string {
  const base = normalizeSonarUrl(serverUrl);
  return `${base}/dashboard?id=${encodeURIComponent(projectKey)}`;
}

/**
 * `sonar.inclusions` 单行写全（PRD 决策 #9：走 properties 而不是 CLI 传参，因为 Windows 命令行 32KB 上限）。
 * properties 的行长度没有 OS 限制，所以不需要折行——折行反而要求解析侧支持续行。
 */
/** Java .properties 的值转义：反斜杠在 Properties.load 里是转义符，Windows 路径直接写进去会被吃掉
 *  （`D:\tmp` 的 `\t` 变成制表符 → 扫描器抛 InvalidPathException，整条扫描链在 Windows 上必挂）。 */
export function propertyValue(raw: string): string {
  // 顺序不能变：先转义反斜杠本身，再逐个替换控制字符（否则新生成的反斜杠会被二次转义）
  return String(raw)
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('\r', String.raw`\r`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\t', String.raw`\t`);
}

export function buildProperties(input: {
  projectKey: string; projectName: string; serverUrl: string; baseDir: string; inclusions: string[];
}): string {
  const lines = [
    `sonar.projectKey=${propertyValue(input.projectKey)}`,
    `sonar.projectName=${propertyValue(input.projectName)}`,
    `sonar.host.url=${propertyValue(normalizeSonarUrl(input.serverUrl))}`,
    `sonar.projectBaseDir=${propertyValue(input.baseDir)}`,
    'sonar.sourceEncoding=UTF-8',
    'sonar.sources=.',
    // 配置自己与扫描器产物不能被自己扫（否则每次扫描都新增一批「问题」）
    'sonar.exclusions=sonar-project.properties,.scannerwork/**',
    `sonar.inclusions=${propertyValue(input.inclusions.join(','))}`,
  ];
  // 安全条款：这里绝不出现 Token——properties 会随快照留在磁盘上，而它能被日志/工单带走
  return lines.join('\n') + '\n';
}

/** 全链路脱敏：把可能出现 Token 的任意文本换成掩码（扫描器会把参数回显到 stdout） */
export function redact(text: string, token: string): string {
  if (!token) return text;
  const mask = token.length <= 8 ? '****' : `${token.slice(0, 4)}****${token.slice(-4)}`;
  return text.split(token).join(mask);
}

/* ------------------------- 快照目录 ------------------------- */

export function sonarJobDir(jobId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId))) throw new ScanError('bad-job', '非法 job 标识');
  return join(extractTmpRoot(), `sonar-${String(jobId).toLowerCase()}`);
}

/** 仓库相对路径 → 快照内绝对路径（挡越界；git 侧 assertBatchObjectSpec 已挡一次，这是第二道） */
function safeJoin(root: string, relPath: string): string {
  const abs = resolvePath(root, ...relPath.split(/[\\/]+/).filter((s) => s && s !== '.'));
  const normRoot = resolvePath(root);
  // 必须按平台分隔符比对：Windows 上 resolve 给 `...\a.txt`，写死 `/` 会把所有合法路径判成越界
  if (abs !== normRoot && !abs.startsWith(normRoot + sep)) throw new ScanError('bad-path', `非法文件路径「${relPath.slice(0, 80)}」`);
  return abs;
}

/** 回收超 TTL 的快照目录（只认 `sonar-` 前缀，绝不去碰同根的 `git-extract-` 目录） */
export function sweepSonarTmp(ttlMs = SNAPSHOT_TTL_MS, now = Date.now()): number {
  const root = extractTmpRoot();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith('sonar-')) continue;
    const dir = join(root, name);
    try {
      if (now - statSync(dir).mtimeMs > ttlMs) { rmSync(dir, { recursive: true, force: true }); removed += 1; }
    } catch { /* 单个目录判定失败不影响其余清扫 */ }
  }
  return removed;
}

/** 指纹 7 天窗口清扫（T03602：任务会被物理删除，窗口只能靠表自身收口） */
export function sweepSonarFps(days = FP_TTL_DAYS, now = Date.now()): number {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const info = getDb().prepare('DELETE FROM sonar_issue_fps WHERE created_at < ?').run(cutoff);
  return info.changes;
}

/* ------------------------- HTTP ------------------------- */

async function sonarGet(url: string, token: string): Promise<{ status: number; json: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const credentials = `${token}:`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` } : {}),
      },
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  } catch (e) {
    throw new ScanError('unreachable', `无法连接 SonarQube：${(e as Error).message}`, '确认服务地址可达、端口开放，且本机未被代理/防火墙拦截。');
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- 扫描器进程 ------------------------- */

/**
 * 中止后等 close 的兜底窗口。`close` 要等 stdio 全关，而 JVM 孙进程握着管道时它不会来——
 * 一旦 `close` 缺席，abort → catch/finally 整条链都不执行，`console_jobs` 停在 busy、
 * 快照目录留在盘上（T03708 实测）。兜底窗口到期就主动断流并按「已中止」结算。
 */
const KILL_SETTLE_MS = 3_000;

/**
 * 按进程树终止扫描器。Windows 上 `.bat` 走 `shell: true`，Node 直接持有的是 cmd.exe，
 * `child.kill()` 只终止包装器、JVM 孙进程照跑——必须 taskkill /T 连孙进程一起收。
 */
function killProcessTree(child: ChildProcess, onLine?: (line: string) => void): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
      // 只有 /T 能收掉 java 孙进程；它失败时退回 kill 至少别把 cmd 包装器留着
      if (err && onLine) onLine(`[mtask] taskkill 未能终止扫描器进程树（${err.message}），已回退为直接终止包装进程`);
      child.kill();
    });
    return;
  }
  child.kill('SIGTERM');
}

async function defaultSpawnScanner(
  spec: { command: string; args: string[]; shell: boolean },
  env: Record<string, string>,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: env.SONAR_PROJECT_BASE_DIR,
      env,
      shell: spec.shell,
      windowsHide: true,
    });
    let buffer = '';
    let stderrBuffer = '';
    let settled = false;
    let settleTimer: NodeJS.Timeout | null = null;
    const emit = (chunk: string, toStderr = false) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = toStderr ? stderrBuffer + lines.pop()! : lines.pop()!;
      for (const l of lines) {
        const t = l.trim();
        if (t) onLine(t);
      }
    };
    child.stdout?.on('data', (b: Buffer) => emit(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => emit(b.toString('utf8'), true));
    const release = () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      release();
      // 收尾残留半行，别把最后一行吞掉（用户要能在控制台看到失败原因）
      const tail = (buffer + stderrBuffer).trim();
      if (tail) onLine(tail);
      resolve({ code });
    };
    const onAbort = () => {
      killProcessTree(child, onLine);
      if (settleTimer) return;
      settleTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        settle(null);
      }, KILL_SETTLE_MS);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      release();
      // ENOENT 说明解析到的文件在 spawn 时已不存在（或指向目录）：给可操作指引，而不是把系统错误原文贴给用户
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new ScanError(
          'scan-failed',
          '扫描器启动失败：未找到 sonar-scanner。',
          '请在设置页配置「扫描器路径」，或将 sonar-scanner 加入系统 PATH 环境变量。',
        ));
        return;
      }
      reject(new ScanError('scan-failed', `扫描器启动失败：${e.message}`, '在设置页核对「扫描器路径」，或留空按 PATH 探测。'));
    });
    child.on('close', (code) => settle(code));
  });
}

/* ------------------------- 归属推断 ------------------------- */

interface Ownership {
  taskId: string | null;
  taskNo: string | null;
  taskTitle: string | null;
  shared: boolean;
}

/**
 * 「问题归属文件所属提交 → 对应任务」：先由最终内容映射拿到最后改动该文件的提交，
 * 再按 task_git_links 反查任务。同一提交被多任务关联时取第一个并在描述里标注（§3.4.3 归属行）。
 */
function buildOwnerIndex(plan: ExtractPlan): Map<string, Ownership> {
  const byLink = new Map<string, { taskId: string; taskNo: string | null; title: string; count: number }[]>();
  for (const t of plan.tasks) {
    for (const l of t.links) {
      const key = finalPathKey(l.repoSub, l.sha);
      const list = byLink.get(key) ?? [];
      list.push({ taskId: t.taskId, taskNo: t.taskNo, title: t.title, count: list.length + 1 });
      byLink.set(key, list);
    }
  }
  const out = new Map<string, Ownership>();
  // 键用产物路径（子仓库带前缀），与 sonar inclusions / 磁盘布局逐字一致
  for (const v of finalPathMap(plan.filesByCommit).values()) {
    const owners = byLink.get(finalPathKey(v.repoSub, v.sha)) ?? [];
    const first = owners[0];
    out.set(v.outPath, first
      ? { taskId: first.taskId, taskNo: first.taskNo, taskTitle: first.title, shared: owners.length > 1 }
      : { taskId: null, taskNo: null, taskTitle: null, shared: false });
  }
  return out;
}

/* ------------------------- 阶段 2：快照导出 ------------------------- */

async function exportSnapshot(
  plan: ExtractPlan,
  dir: string,
  onStage: (stage: ScanStage, detail?: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<{ files: number; bytes: number; snapshotHeadSha: string; snapshotRepoPath: string }> {
  const finalPath = finalPathMap(plan.filesByCommit);
  assertWithinLimits(finalPath.size, 0);
  await mkdir(dir, { recursive: true });
  const inner = new AbortController();
  let bytes = 0;
  let limitHit: ScanError | null = null;
  let abortHit: ScanError | null = signal?.aborted ? new ScanError('aborted', '已中止') : null;
  const pendingWrites: Promise<void>[] = [];
  if (signal) {
    if (signal.aborted) inner.abort();
    else signal.addEventListener('abort', () => { abortHit ??= new ScanError('aborted', '已中止'); inner.abort(); }, { once: true });
  }
  try {
    // T04576：逐仓库 cat-file——子仓库的提交只在它自己的仓库里能读到
    for (const [repoSub, entries] of finalPathByRepo(finalPath)) {
      if (inner.signal.aborted || limitHit || abortHit) break;
      const cwd = plan.repos.find((r) => r.repoSub === repoSub)?.path;
      if (!cwd) throw new ScanError('bad-state', `仓库 ${repoSub || '项目根仓库'} 不在计划清单里`);
      const entryBySpec = new Map(entries.map((v) => [`${v.sha}:${v.path}`, v]));
      await catFileBatch(cwd, [...entryBySpec.keys()], (o: BatchObject) => {
        if (inner.signal.aborted || limitHit || abortHit) return;
        if (o.missing || o.content === null) return;
        const entry = entryBySpec.get(o.spec);
        if (!entry) return;
        const abs = safeJoin(dir, entry.outPath);
        bytes += o.content.length;
        try {
          assertWithinLimits(finalPath.size, bytes);
        } catch (e) {
          limitHit ??= new ScanError('too-large', (e as Error).message);
          inner.abort();
          return;
        }
        // cat-file 回调是同步的：落盘排队，阶段结束前统一 await（否则配置文件会读到半个快照）
        pendingWrites.push(writeFileIn(abs, o.content));
      }, { signal: inner.signal });
    }
  } catch (e) {
    if (limitHit) throw limitHit;
    if (abortHit) throw abortHit;
    throw e;
  }
  if (limitHit) throw limitHit;
  if (abortHit) throw abortHit;
  await Promise.all(pendingWrites);
  // 多仓库时「最新提交」按提交时间取（跨仓库没有共同拓扑），head 对比用它所属仓库的 cwd
  const latest = plan.repos
    .flatMap((r) => r.commits.map((c) => ({ c, path: r.path })))
    .sort((a, b) => Date.parse(b.c.date) - Date.parse(a.c.date))[0];
  const snapshotHeadSha = latest?.c.sha ?? '';
  const snapshotRepoPath = latest?.path ?? plan.workspacePath;
  onStage('snapshot', { files: finalPath.size, bytes, snapshotHeadSha });
  return { files: finalPath.size, bytes, snapshotHeadSha, snapshotRepoPath };
}

/** 建目录再写文件（快照保留相对路径，深层目录不会凭空存在） */
async function writeFileIn(abs: string, content: Buffer): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

/* ------------------------- 阶段 7：回写 ------------------------- */

interface WriteBackContext {
  projectKey: string;
  serverUrl: string;
  snapshotHeadSha: string;
}

/** 指纹是否已在 7 天窗口内出现（命中即跳过建单，AC-13「重复扫描不重复建单」） */
export function isFpFresh(fp: string, now = Date.now(), days = FP_TTL_DAYS): boolean {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const row = getDb().prepare('SELECT fp FROM sonar_issue_fps WHERE fp = ? AND created_at >= ?').get(fp, cutoff) as { fp?: string } | undefined;
  return !!row?.fp;
}

export function rememberFp(fp: string, projectId: string, taskId: string | null, severity: ScanSeverity, at = new Date().toISOString()): void {
  getDb().prepare(
    `INSERT INTO sonar_issue_fps (fp, project_id, task_id, severity, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fp) DO UPDATE SET task_id = excluded.task_id, severity = excluded.severity, created_at = excluded.created_at`,
  ).run(fp, projectId, taskId, severity, at);
}

/**
 * 两级层级禁令处置（§3.4.3）：原任务是顶层 → 挂它；原任务本身是子任务 → 挂它的父 epic，
 * 并在描述里注明「实际归属任务 Txxxxx」。三级会让任务树与导出层级同时崩。
 */
export function resolveWriteBackParent(taskId: string): { parentId: string | null; projectId: string | null; note: string } {
  const db = getDb();
  const row = db.prepare('SELECT id, project_id, parent_id, task_no FROM tasks WHERE id = ?').get(taskId) as
    { id: string; project_id: string; parent_id: string | null; task_no: string } | undefined;
  if (!row) return { parentId: null, projectId: null, note: '' };
  if (!row.parent_id) return { parentId: row.id, projectId: row.project_id, note: '' };
  return {
    parentId: row.parent_id,
    projectId: row.project_id,
    note: `实际归属任务 ${row.task_no ?? taskId}（该任务本身是子任务，按两级层级禁令挂到其父 epic 下）`,
  };
}

export function issueDescription(issue: ScanIssue, ctx: WriteBackContext, extraNote: string): string {
  const lines = [
    `规则键：${issue.rule}`,
    `严重度：${SEVERITY_LABEL[issue.severity]}（${issue.severity}）`,
    `位置：${issue.path}:${issue.line}`,
    `问题链接：${issue.url}`,
    `原始消息：${issue.message}`,
    `指纹：${issue.fingerprint}`,
    `快照 SHA：${ctx.snapshotHeadSha}（projectKey ${ctx.projectKey}）`,
  ];
  if (issue.shared) lines.push('该提交同时被多个任务关联，归属取其中之一，可能需人工改派。');
  if (extraNote) lines.push(extraNote);
  return lines.join('\n');
}

/** 回写口径（阈值/上限/兜底项目） */
type WriteBackOpts = { severities: ScanSeverity[]; cap: number; projectIds: string[] };

/** 单条问题回写：归属任务 → 项目 → 指纹去重 → 建单；失败只计入收据，不中断整批 */
function writeBackOneIssue(issue: ScanIssue, ctx: WriteBackContext, opts: WriteBackOpts, receipts: WriteBackReceipts): void {
  if (!issue.taskId) { receipts.unattributed += 1; return; }
  if (isFpFresh(issue.fingerprint)) { receipts.skippedDuplicate += 1; return; }
  const parent = resolveWriteBackParent(issue.taskId);
  const projectId = parent.projectId ?? opts.projectIds[0] ?? '';
  if (!projectId) { receipts.failed += 1; receipts.failedNames.push(`${issue.rule} ${issue.path}:${issue.line}（找不到项目）`); return; }
  const title = `[Sonar] ${issue.rule} ${issue.path}:${issue.line}`;
  try {
    const view = TaskService.create({
      projectId,
      title,
      description: issueDescription(issue, ctx, parent.note),
      priority: priorityOf(issue.severity),
      parentId: parent.parentId,
      status: 'todo',
    });
    rememberFp(issue.fingerprint, projectId, view.id, issue.severity);
    receipts.created += 1;
  } catch (e) {
    receipts.failed += 1;
    receipts.failedNames.push(`${title}（${(e as Error).message}）`);
  }
}

/** 超过单次上限的部分：合并成一张汇总单（Q10 甲裁定，防洪泛淹没待办池） */
function writeBackOverflow(
  overflow: ScanIssue[],
  head: ScanIssue[],
  ctx: WriteBackContext,
  opts: WriteBackOpts,
  receipts: WriteBackReceipts,
): void {
  if (!overflow.length) return;
  // 溢出段里 7 天内已回写过的指纹同样跳过：否则同一批问题第二次扫描会再造一张汇总单，
  // 待办池被同一批问题反复灌满（汇总单本身不是指纹主体，只能按成员逐条判）
  const freshOverflow = overflow.filter((i) => isFpFresh(i.fingerprint));
  const pool = overflow.filter((i) => !isFpFresh(i.fingerprint));
  receipts.skippedDuplicate += freshOverflow.length;
  receipts.summaryFor = pool.length;
  if (!pool.length) return;
  const firstOwner = pool.find((i) => i.taskId)?.taskId ?? head.find((i) => i.taskId)?.taskId ?? '';
  const parent = firstOwner ? resolveWriteBackParent(firstOwner) : { parentId: null, projectId: opts.projectIds[0] ?? null, note: '' };
  const projectId = parent.projectId ?? opts.projectIds[0] ?? '';
  if (!projectId) {
    receipts.failed += pool.length;
    return;
  }
  try {
    const list = pool.slice(0, 200).map((i) => `- ${SEVERITY_LABEL[i.severity]} ${i.rule} ${i.path}:${i.line} ${i.message}`).join('\n');
    const view = TaskService.create({
      projectId,
      title: `[Sonar] 本次扫描另有 ${pool.length} 个问题`,
      description: [
        `本次扫描超过单次回写上限 ${opts.cap} 条，其余 ${pool.length} 条合并为一单（Q10 甲裁定，防洪泛淹没待办池）。`,
        `报告：${reportUrlFor(ctx.serverUrl, ctx.projectKey)}`,
        `快照 SHA：${ctx.snapshotHeadSha}`,
        '',
        list,
        pool.length > 200 ? `\n（清单截断到前 200 条，完整列表见上面的报告链接）` : '',
        parent.note,
      ].filter(Boolean).join('\n'),
      priority: 'normal',
      parentId: parent.parentId,
      status: 'todo',
    });
    // 汇总单本身不是指纹主体，但被它兜住的每条问题都要记指纹，
    // 否则下一次扫描会把同一批问题再算成「超上限」并再建一张汇总单
    for (const i of pool) rememberFp(i.fingerprint, projectId, view.id, i.severity);
    receipts.summaryTaskNo = view.task_no ?? null;
    receipts.created += 1;
  } catch {
    receipts.failed += 1;
  }
}

export function writeBack(issues: ScanIssue[], opts: WriteBackOpts, ctx: WriteBackContext): WriteBackReceipts {
  const receipts: WriteBackReceipts = {
    created: 0, skippedDuplicate: 0, belowThreshold: 0, failed: 0, unattributed: 0,
    failedNames: [], summaryTaskNo: null, summaryFor: 0,
  };
  const allow = new Set(opts.severities);
  const ranked = issues
    .filter((i) => SEVERITY_ORDER.map((s) => `${s}`).includes(i.severity))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const picked: ScanIssue[] = [];
  for (const i of ranked) {
    if (!allow.has(i.severity)) { receipts.belowThreshold += 1; continue; }
    picked.push(i);
  }
  const head = picked.slice(0, opts.cap);
  for (const issue of head) writeBackOneIssue(issue, ctx, opts, receipts);
  writeBackOverflow(picked.slice(opts.cap), head, ctx, opts, receipts);
  return receipts;
}

/* ------------------------- 阶段 5/6 ------------------------- */

/** 分析状态轮询地址：有 CE 任务 id 走 `ce/task`（提交者即可读），否则退回要求管理员权限的 `ce/component` */
function analysisPollUrl(serverUrl: string, componentKey: string, ceTaskId?: string): string {
  const base = normalizeSonarUrl(serverUrl);
  return ceTaskId
    ? `${base}/api/ce/task?id=${encodeURIComponent(ceTaskId)}`
    : `${base}/api/ce/component?component=${encodeURIComponent(componentKey)}`;
}

/** 轮询的 HTTP 状态归因：401/403 的指引按可用端点区分；其余 4xx/5xx 直接抛 */
function assertAnalysisHttp(status: number, componentKey: string, ceTaskId?: string): void {
  if (status === 401 || status === 403) throw new ScanError('auth-failed', `等待分析结果被拒绝（HTTP ${status}）`, ceTaskId
    ? 'Token 需具备查看该项目的权限（`ce/task` 对提交该分析的 Token 开放）。'
    : 'Token 需具备查看该项目的权限（`ce/component` 还要求项目管理员；扫描器输出里没有 CE 任务 id 时无法改走 `ce/task`）。');
  if (status === 404) throw new ScanError('project-not-found', `项目 ${componentKey} 无分析记录`, '确认 projectKey 与扫描确实提交成功（见上面的扫描器输出）。');
  if (status >= 500) throw new ScanError('unreachable', `SonarQube 返回 HTTP ${status}`);
}

/** 失败/取消终态直接抛；其余状态返回由调用方继续轮询 */
function assertAnalysisTerminal(state: string, json: any): void {
  if (state !== 'FAILED' && state !== 'CANCELED') return;
  const reason = String(json?.analysis?.errors?.[0] ?? json?.task?.reason ?? '') || '无原因字段';
  throw new ScanError('scan-failed', `SonarQube 分析${state === 'FAILED' ? '失败' : '被取消'}：${reason}`, '到 SonarQube 看该项目的分析日志。');
}

interface WaitForAnalysisInput {
  serverUrl: string;
  token: string;
  componentKey: string;
  deps: Required<Pick<ScanDeps, 'fetchJson'>> & ScanDeps;
  onLog: (line: string) => void;
  onStage: (stage: ScanStage, detail?: Record<string, unknown>) => void;
  signal?: AbortSignal;
  ceTaskId?: string;
}

async function waitForAnalysis(input: WaitForAnalysisInput): Promise<void> {
  const { serverUrl, token, componentKey, deps, onLog, onStage, signal, ceTaskId } = input;
  // 有扫描器回显的 CE 任务 id 时走 `ce/task`：该端点对提交者开放，而 `ce/component` 要求项目管理员权限，
  // 只带「分析 + 浏览」的常规 Token 会被它 403 挡住，整条扫描链在 wait 阶段断掉。
  const url = analysisPollUrl(serverUrl, componentKey, ceTaskId);
  const started = Date.now();
  const pollMs = deps.cePollMs ?? CE_POLL_MS;
  const timeoutMs = deps.ceTimeoutMs ?? CE_TIMEOUT_MS;
  let lastQueueMinute = -1;
  for (;;) {
    if (signal?.aborted) throw new ScanError('aborted', '已中止');
    const { status, json } = await deps.fetchJson(url, token);
    assertAnalysisHttp(status, componentKey, ceTaskId);
    const st = String(json?.task?.status ?? json?.component?.status ?? '').toUpperCase();
    if (st === 'SUCCESS') {
      onStage('wait', { status: st, waitedMs: Date.now() - started });
      return;
    }
    assertAnalysisTerminal(st, json);
    const waitedMin = Math.floor((Date.now() - started) / 60_000);
    if (waitedMin > lastQueueMinute) {
      lastQueueMinute = waitedMin;
      onLog(`Sonar 分析队列中（已 ${waitedMin} 分钟）`);
      onStage('wait', { status: st || 'PENDING', waitedMinutes: waitedMin });
    }
    if (Date.now() - started > timeoutMs) throw new ScanError('timeout', `等待分析结果超时（${Math.round(timeoutMs / 60_000)} 分钟）`, '可以到 SonarQube 手动确认该项目的分析状态后重试。');
    await sleepWithAbort(pollMs, signal);
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new ScanError('aborted', '已中止')); };
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(new ScanError('aborted', '已中止')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 拉取清单的单页状态归因：401/403 是认证，其余 4xx/5xx 归为不可达（带上服务端原因） */
function assertIssuePageStatus(status: number, json: any): void {
  if (status === 401 || status === 403) throw new ScanError('auth-failed', `拉取问题清单被拒绝（HTTP ${status}）`);
  if (status < 400) return;
  const serverMsg = json?.errors?.[0]?.msg ? `：${json.errors[0].msg}` : '';
  throw new ScanError('unreachable', `拉取问题清单失败（HTTP ${status}）${serverMsg}`);
}

/** 合并一页并按 key 去重：分页期间服务端可能插入新问题，同一问题不能计两次 */
function mergeIssuePage(page: any[], all: any[], seen: Set<string>): void {
  for (const i of page) {
    const k = String(i?.issue?.key ?? i?.key ?? '');
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    all.push(i);
  }
}

async function fetchAllIssues(
  serverUrl: string,
  token: string,
  componentKey: string,
  deps: Required<Pick<ScanDeps, 'fetchJson'>> & ScanDeps,
  onStage: (stage: ScanStage, detail?: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<any[]> {
  const base = `${normalizeSonarUrl(serverUrl)}/api/issues/search?componentKeys=${encodeURIComponent(componentKey)}&resolved=false&ps=${ISSUE_PAGE_SIZE}`;
  const all: any[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= 100; p += 1) {
    if (signal?.aborted) throw new ScanError('aborted', '已中止');
    const { status, json } = await deps.fetchJson(`${base}&p=${p}`, token);
    assertIssuePageStatus(status, json);
    const page: any[] = Array.isArray(json?.issues) ? json.issues : [];
    mergeIssuePage(page, all, seen);
    const total = Number(json?.total ?? all.length);
    onStage('fetch', { page: p, fetched: all.length, total });
    if (page.length < ISSUE_PAGE_SIZE || all.length >= total) break;
  }
  return all;
}

/* ------------------------- 环境可用性（AC-16 降级） ------------------------- */

export interface ScanEnvState {
  ok: boolean;
  scanner: SonarProbe;
  java: SonarProbe;
  serverConfigured: boolean;
  /** 未配置任何 projectKey 时给「去设置页」的指引 */
  projectKeysConfigured: number;
  reasons: string[];
}

/** 面板的不可用态与请求前的服务端预检共用这一个函数（两套判定就会一边绿一边红） */
export async function scanEnvState(projectIds?: string[]): Promise<ScanEnvState> {
  const settings = readScanSettings();
  const [scanner, java] = await Promise.all([probeScanner(settings.scannerPath || undefined), probeJava()]);
  const ids = (projectIds ?? []).filter(Boolean);
  // T04477：Token 形态的映射值「不算已配置」——否则面板说环境可用、点下去才在扫描入口被拒。
  const keyOf = (p: string): string => projectKeyFor(p);
  const usable = (key: string): boolean => !!key && !looksLikeSonarToken(key);
  const keysConfigured = ids.length
    ? ids.filter((p) => usable(keyOf(p))).length
    : Object.values(readProjectKeyCount()).filter(usable).length;
  const hasTokenShapedKey = ids.length
    ? ids.some((p) => looksLikeSonarToken(keyOf(p)))
    : Object.values(readProjectKeyCount()).some(looksLikeSonarToken);
  const reasons: string[] = [];
  if (!settings.serverUrl) reasons.push('未配置服务器地址：到「设置 → SonarQube」填写后点「连接测试」。');
  if (!scanner.available) reasons.push(`未探测到可用扫描器：${scanner.hint || '安装 sonar-scanner 并在设置页填路径，或留空按 PATH 探测。'}`);
  if (!java.available) reasons.push(`未探测到 Java：${java.hint || '需要 JDK 11+；本工具不代装。'}`);
  if (hasTokenShapedKey) reasons.push('「默认 projectKey 映射」里有 Token 形态的值（sqX_ 前缀）：它会被当作项目键外发，已在扫描入口拦截。到设置页改成 SonarQube 的项目 key。');
  if (!keysConfigured && !hasTokenShapedKey) reasons.push('未配置 projectKey：到「设置 → SonarQube → 默认 projectKey 映射」为所选项目配置。');
  return {
    ok: reasons.length === 0,
    scanner,
    java,
    serverConfigured: !!settings.serverUrl,
    projectKeysConfigured: keysConfigured,
    reasons,
  };
}

function readProjectKeyCount(): Record<string, string> {
  // 只用于「配了几个」的计数；具体值走 projectKeyFor（映射的读写口径单源在 sonarSettings）
  const raw = getDb().prepare("SELECT value FROM app_settings WHERE key = 'sonar.projectKeys'").get() as { value?: string } | undefined;
  if (!raw?.value) return {};
  try {
    const parsed = JSON.parse(raw.value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => [k, String(v)] as [string, string]);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

/* ------------------------- 编排 ------------------------- */

const runningStages = new Map<string, { stage: ScanStage; at: number }>();

/** 刷新后恢复运行徽标：busy 的 sonar console_job + 当前阶段 */
export function listRunningScans(): Array<{ jobId: string; title: string; stage: ScanStage | null; createdAt: string }> {
  const rows = (ConsoleJobService.list() as any[]).filter((r) => r.category === 'sonar' && r.status === 'busy');
  return rows.map((r) => ({
    jobId: r.id,
    title: r.title,
    stage: runningStages.get(r.id)?.stage ?? null,
    createdAt: r.created_at,
  }));
}

/** Sonar `/api/issues/search` 原始行 → 扫描结果条目（归属取快照提交的 owner 索引） */
function toScanIssue(i: any, projectKey: string, reportBase: string, owners: Map<string, Ownership>): ScanIssue {
  const sev = normalizeSeverity(i);
  const path = pathOfComponent(i?.component, projectKey);
  const line = Number(i?.line ?? 0);
  const rule = String(i?.rule ?? 'unknown-rule');
  const message = String(i?.message ?? '');
  const key = String(i?.key ?? '');
  const owner = owners.get(path) ?? { taskId: null, taskNo: null, taskTitle: null, shared: false };
  return {
    key, rule, severity: sev, path, line, message,
    url: key ? `${reportBase}/issue/${encodeURIComponent(key)}` : reportBase,
    fingerprint: fingerprintOf(rule, path, line, message),
    ...owner,
  };
}

/** 时效声明取数：快照 SHA 与当前 HEAD 的关系；取不到不影响扫描结果本身（留空由回执省略） */
async function resolveHeadLag(
  workspacePath: string,
  snapshotSha: string,
  signal?: AbortSignal,
): Promise<{ currentHeadSha: string; headLag: number }> {
  try {
    const currentHeadSha = await resolveRevisionSha(workspacePath, 'HEAD');
    if (currentHeadSha && snapshotSha && currentHeadSha !== snapshotSha) {
      return { currentHeadSha, headLag: (await collectCommitLog(workspacePath, [`${snapshotSha}..HEAD`], { signal })).length };
    }
    return { currentHeadSha, headLag: 0 };
  } catch {
    return { currentHeadSha: '', headLag: 0 };
  }
}

type StageEmit = (stage: ScanStage, detail?: Record<string, unknown>) => void;

interface ScanEmit {
  stage?: StageEmit;
  log?: (line: string) => void;
  /** jobId 要尽早回给前端（中止按钮按它掐进程），所以在建 console_job 的当场就报 */
  job?: (jobId: string) => void;
}

interface ScanConsole {
  stage: StageEmit;
  log: (line: string) => void;
  logLines: string[];
  /** 扫描器输出里带 `…/api/ce/task?id=<uuid>` 时记下 CE 任务 id（wait 阶段优先走 ce/task） */
  consumeScanLine: (line: string) => void;
  ceTaskId: () => string;
}

/** 控制台出口：阶段徽标 + 脱敏日志 + CE 任务 id 捕获（抽出来，主流程只按阶段推进） */
function createScanConsole(jobId: string, token: string, emit: ScanEmit): ScanConsole {
  const logLines: string[] = [];
  const stage: StageEmit = (s, detail) => {
    runningStages.set(jobId, { stage: s, at: Date.now() });
    emit.stage?.(s, detail);
  };
  const log = (line: string) => {
    if (logLines.length < MAX_LOG_LINES) logLines.push(redact(line, token));
    emit.log?.(redact(line, token));
  };
  let ceTaskId = '';
  const consumeScanLine = (line: string) => {
    const hit = /\/api\/ce\/task\?id=([0-9a-f-]{36})/i.exec(line);
    if (hit) ceTaskId = hit[1];
    log(line);
  };
  return { stage, log, logLines, consumeScanLine, ceTaskId: () => ceTaskId };
}

function normalizeTaskIds(taskIds?: string[]): string[] {
  return [...new Set((taskIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
}

/** projectKey 口径：入参 > 首个项目的映射 > 映射表第一个；都没有则报可操作的错 */
function resolveScanProjectKey(input: ScanInput, plan: ExtractPlan, projectIds: string[]): string {
  const projectKey = String(input.projectKey ?? '').trim()
    || projectKeyFor(projectIds[0] ?? '')
    || Object.values(readProjectKeyCount())[0]
    || '';
  if (projectKey) {
    // T04477：保存层与连接测试都拦过 Token 形态值，但**已落库的脏值**仍会走到这里——
    // 它会被拼进 sonar-project.properties 的 key 并随扫描外发，等于把凭据当项目键送出去。
    // 报错文案刻意不回显该值本身（否则等于把凭据再扩散一次）。
    if (looksLikeSonarToken(projectKey)) {
      const name = plan.projects[0]?.name ?? projectIds[0] ?? '';
      throw new ScanError(
        'bad-project-key',
        `项目「${name}」配置的 projectKey 是 Token 形态（sqX_ 前缀），已拒绝启动扫描`,
        '到「设置 → SonarQube → 默认 projectKey 映射」把该值改成 SonarQube 的项目 key（形如 MTask）；Token 只填「认证 Token」框。',
      );
    }
    return projectKey;
  }
  const name = plan.projects[0]?.name ?? projectIds[0] ?? '';
  throw new ScanError('no-project-key', `项目「${name}」未配置 projectKey`, '到「设置 → SonarQube → 默认 projectKey 映射」配置后重试。');
}

/** 阶段 4：装配置、起扫描器、把退出码/中止翻成 ScanError */
async function runScannerPhase(params: {
  settings: { serverUrl: string; scannerPath: string };
  token: string;
  dir: string;
  deps: ScanDeps;
  console: ScanConsole;
  signal?: AbortSignal;
}): Promise<void> {
  const { settings, token, dir, deps, console, signal } = params;
  const spawnScanner = deps.spawnScanner ?? defaultSpawnScanner;
  // 路径解析必须与设置页探测同一口径（T04501）：此处原先直接用 `settings.scannerPath || 'sonar-scanner'`，
  // 配置为空且 PATH 未命中时只能等到运行期抛一句 spawn ENOENT，用户拿不到可执行的修复指引。
  const resolution = resolveScannerBin(settings.scannerPath || undefined);
  if (!resolution.bin) {
    throw new ScanError(
      'no-scanner',
      '扫描器启动失败：未找到 sonar-scanner。',
      '请在设置页配置「扫描器路径」，或将 sonar-scanner 加入系统 PATH 环境变量。',
    );
  }
  const spec = planScannerSpawn(resolution.bin, ['-Dproject.settings=sonar-project.properties']);
  if (spec.unsafe) throw new ScanError('no-scanner', '扫描器路径含 cmd.exe 无法安全执行的字符', '在设置页改指向不含 & | ^ % < > " \' ; 反引号 的路径。');
  console.stage('scan', { scanner: resolution.bin });
  console.log(`$ ${resolution.bin} -Dproject.settings=sonar-project.properties（工作目录 ${dir}）`);
  const run = await spawnScanner(spec, {
    ...process.env as Record<string, string>,
    SONAR_TOKEN: token,
    SONAR_HOST_URL: normalizeSonarUrl(settings.serverUrl),
    SONAR_PROJECT_BASE_DIR: dir,
  }, console.consumeScanLine, signal);
  if (signal?.aborted) throw new ScanError('aborted', '已中止');
  if (run.code === 0) return;
  throw new ScanError('scan-failed', `扫描器退出码 ${run.code}`, '看上面的扫描器输出；常见原因是 projectKey 无权限或服务器不可达。');
}

/**
 * 删扫描快照目录。Windows 上刚被 taskkill 的 JVM 释放 `.scannerwork` 句柄有延迟（T03708 实测：
 * 快照目录在中止后仍留在盘上），`force` 也不代表能删。先短重试；仍失败就转后台每秒再试——
 * 既不能为了删目录把 aborted 帧拖住，也不能留半个快照。彻底删不掉时留给下次扫描的 sweepSonarTmp。
 */
function removeScanDir(dir: string): void {
  const attempt = (retries: number) => { rmSync(dir, { recursive: true, force: true, maxRetries: retries, retryDelay: 200 }); };
  try { attempt(4); return; } catch { /* 句柄未释放，转后台重试 */ }
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    try { attempt(1); clearInterval(timer); } catch { if (tries >= 10) clearInterval(timer); }
  }, 1_000);
  timer.unref?.();
}

/** 阶段 7：阈值/上限过滤后回写；面板关掉自动回写时返回 null */
function performWriteBack(params: {
  input: ScanInput;
  issues: ScanIssue[];
  projectIds: string[];
  ctx: WriteBackContext;
  stage: StageEmit;
}): WriteBackReceipts | null {
  const { input, issues, projectIds, ctx, stage } = params;
  if (input.autoWriteBack === false) return null;
  const severities = (input.severities ?? DEFAULT_SEVERITIES).filter((s) => SEVERITY_ORDER.includes(s));
  const requestedCap = Number(input.cap);
  const cap = Number.isInteger(requestedCap) && requestedCap > 0 ? requestedCap : WRITEBACK_CAP;
  stage('writeback', { severities, cap });
  const receipts = writeBack(issues, { severities, cap, projectIds }, ctx);
  stage('writeback', receipts as unknown as Record<string, unknown>);
  return receipts;
}

function writeBackLineOf(receipts: WriteBackReceipts | null): string {
  if (!receipts) return '回写：已关闭（面板上的自动回写开关）';
  const summaryTaskText = receipts.summaryTaskNo ? ` / 汇总单 ${receipts.summaryTaskNo}` : '';
  return `回写：新建 ${receipts.created} / 已存在跳过 ${receipts.skippedDuplicate} / 低于阈值 ${receipts.belowThreshold} / 无法归属 ${receipts.unattributed} / 失败 ${receipts.failed}${summaryTaskText}`;
}

interface ScanAnswerInput {
  projectKey: string;
  serverUrl: string;
  snap: { files: number; bytes: number; snapshotHeadSha: string };
  currentHeadSha: string;
  headLag: number;
  issues: ScanIssue[];
  grouped: Record<ScanSeverity, ScanIssue[]>;
  receipts: WriteBackReceipts | null;
  logLines: string[];
}

/** 回答正文（证据链）：主流程只管推进阶段，拼装口径集中在这里 */
function buildScanAnswer(input: ScanAnswerInput): string {
  const severityBreakdown = SEVERITY_ORDER.map((s) => `${SEVERITY_LABEL[s]} ${input.grouped[s].length}`).join(' / ');
  const headLabel = input.currentHeadSha ? input.currentHeadSha.slice(0, 12) : '未知';
  const lagText = input.headLag ? `，相差 ${input.headLag} 个提交` : '';
  return [
    `projectKey：${input.projectKey}`,
    `快照：${input.snap.files} 个文件 / ${input.snap.bytes} 字节，SHA ${input.snap.snapshotHeadSha.slice(0, 12)}`,
    `时效：当前 HEAD ${headLabel}${lagText}`,
    `问题：共 ${input.issues.length} 条（${severityBreakdown}）`,
    writeBackLineOf(input.receipts),
    `报告：${reportUrlFor(input.serverUrl, input.projectKey)}`,
    '',
    '--- 扫描器输出 ---',
    ...input.logLines,
  ].join('\n');
}

/**
 * 执行一次扫描。
 *
 * `console_jobs` 行先建（jobId 即其 id，UUID 形）——这样刷新页面还能按 id 找回运行态；
 * 任何失败路径都要 markError 并回收快照目录，不能留没人收的 busy 行（AC-16「无残留 job」）。
 */
export async function runSonarScan(
  input: ScanInput,
  emit: ScanEmit,
  deps: ScanDeps = {},
  signal?: AbortSignal,
): Promise<ScanResult> {
  const settings = readScanSettings();
  const taskIds = normalizeTaskIds(input.taskIds);
  const commitIds = input.commitIds?.length ? normalizeSelectedCommits(input.commitIds) : [];
  if (!taskIds.length && !commitIds.length) throw new ScanError('no-tasks', '未选择任务关联记录或手动 Git 提交');
  if (!settings.serverUrl) throw new ScanError('no-server', '未配置 SonarQube 服务器地址', '到「设置 → SonarQube」填写地址并保存。');

  // 1 汇总（复用 §3.3 取数口径）
  const plan = await planExtract(taskIds, commitIds, input.projectIds ?? [], input.commitRepos ?? {});
  const projectIds = plan.projects.map((p) => p.projectId);
  const projectKey = resolveScanProjectKey(input, plan, projectIds);

  const job = ConsoleJobService.create({
    title: `[Sonar] 质量扫描 ${projectKey} · ${plan.tasks.length} 个任务 / ${plan.manualCommits.length} 条手动提交`,
    prompt: `任务范围：${taskIds.join(', ')}\n手动提交：${plan.manualCommits.join(', ')}\nprojectKey：${projectKey}`,
    category: 'sonar',
    period: null,
    projectIds,
  });
  const jobId = job.id;
  emit.job?.(jobId);
  const dir = sonarJobDir(jobId);
  const token = settings.token;
  const console = createScanConsole(jobId, token, emit);

  try {
    console.stage('collect', { files: plan.uniquePaths, commits: plan.commits.length, tasks: plan.tasks.length, projects: plan.projects.length });

    // 2 快照
    const snap = await exportSnapshot(plan, dir, console.stage, signal);
    console.stage('snapshot', { files: snap.files, bytes: snap.bytes, snapshotHeadSha: snap.snapshotHeadSha });

    // 3 配置（Token 不进这里）
    const owners = buildOwnerIndex(plan);
    const inclusions = [...owners.keys()];
    const propsFile = join(dir, 'sonar-project.properties');
    await writeFile(propsFile, buildProperties({
      projectKey,
      projectName: `MTask 快照 ${snap.snapshotHeadSha.slice(0, 8)}`,
      serverUrl: settings.serverUrl,
      baseDir: dir,
      inclusions,
    }), 'utf8');
    console.stage('config', { propsFile, inclusions: inclusions.length });

    // 4 扫描
    await runScannerPhase({ settings, token, dir, deps, console, signal });

    // 5 等待
    const fetchDeps = { ...deps, fetchJson: deps.fetchJson ?? sonarGet } as Required<Pick<ScanDeps, 'fetchJson'>> & ScanDeps;
    await waitForAnalysis({
      serverUrl: settings.serverUrl,
      token,
      componentKey: projectKey,
      deps: fetchDeps,
      onLog: console.log,
      onStage: console.stage,
      signal,
      ceTaskId: console.ceTaskId() || undefined,
    });

    // 6 拉取
    const raw = await fetchAllIssues(settings.serverUrl, token, projectKey, fetchDeps, console.stage, signal);
    const reportBase = normalizeSonarUrl(settings.serverUrl);
    const issues: ScanIssue[] = raw.map((i) => toScanIssue(i, projectKey, reportBase, owners));
    console.stage('fetch', { total: issues.length });
    const grouped = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, issues.filter((i) => i.severity === s)])) as Record<ScanSeverity, ScanIssue[]>;

    // 时效声明：快照基于 SHA x，当前 HEAD 为 y，相差 n 个提交
    const { currentHeadSha, headLag } = await resolveHeadLag(snap.snapshotRepoPath, snap.snapshotHeadSha, signal);

    // 7 回写（可关闭）
    const receipts = performWriteBack({
      input,
      issues,
      projectIds,
      ctx: { projectKey, serverUrl: settings.serverUrl, snapshotHeadSha: snap.snapshotHeadSha },
      stage: console.stage,
    });

    const answer = buildScanAnswer({
      projectKey,
      serverUrl: settings.serverUrl,
      snap,
      currentHeadSha,
      headLag,
      issues,
      grouped,
      receipts,
      logLines: console.logLines,
    });
    ConsoleJobService.markDone(jobId, answer);
    return {
      jobId, projectKey, serverUrl: settings.serverUrl,
      snapshotHeadSha: snap.snapshotHeadSha, currentHeadSha, headLag,
      files: snap.files, bytes: snap.bytes, commits: plan.commits.length, tasks: plan.tasks.length,
      total: issues.length, issues, grouped,
      reportUrl: reportUrlFor(settings.serverUrl, projectKey),
      receipts,
    };
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e), token);
    const hint = e instanceof ScanError && e.hint ? `\n指引：${e.hint}` : '';
    ConsoleJobService.markError(jobId, `${msg}${hint}`);
    throw e instanceof ScanError ? new ScanError(e.kind, msg, e.hint) : new ScanError('failed', msg);
  } finally {
    runningStages.delete(jobId);
    // 中止/失败都立刻回收快照目录（同 discardReport 语义：不留半个快照在磁盘上）
    removeScanDir(dir);
  }
}
