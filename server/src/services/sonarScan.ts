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
import { spawn } from 'node:child_process';
import { getDb } from '../db/connection';
import { catFileBatch, collectCommitLog, resolveRevisionSha } from './gitCollect';
import type { BatchObject } from './gitCollect';
import { assertWithinLimits, extractTmpRoot, finalPathMap, planExtract } from './gitExtract';
import type { ExtractPlan } from './gitExtract';
import { ConsoleJobService } from './ConsoleJobService';
import { TaskService } from './TaskService';
import {
  SONAR_SCAN_GATE, normalizeSonarUrl, planScannerSpawn, probeJava, probeScanner,
  projectKeyFor, readScanSettings,
} from './sonarSettings';
import type { SonarProbe } from './sonarSettings';

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
    const raw = String((impacts as any).SEVERITY ?? '').trim().toUpperCase();
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
  const c = String(component ?? '');
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
export function buildProperties(input: {
  projectKey: string; projectName: string; serverUrl: string; baseDir: string; inclusions: string[];
}): string {
  const lines = [
    `sonar.projectKey=${input.projectKey}`,
    `sonar.projectName=${input.projectName}`,
    `sonar.host.url=${normalizeSonarUrl(input.serverUrl)}`,
    `sonar.projectBaseDir=${input.baseDir}`,
    'sonar.sourceEncoding=UTF-8',
    'sonar.sources=.',
    // 配置自己与扫描器产物不能被自己扫（否则每次扫描都新增一批「问题」）
    'sonar.exclusions=sonar-project.properties,.scannerwork/**',
    `sonar.inclusions=${input.inclusions.join(',')}`,
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
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` } : {}),
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
    if (signal) {
      if (signal.aborted) { child.kill(); }
      else signal.addEventListener('abort', () => { child.kill(); }, { once: true });
    }
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      reject(new ScanError('scan-failed', `扫描器启动失败：${e.message}`, '在设置页核对「扫描器路径」，或留空按 PATH 探测。'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      // 收尾残留半行，别把最后一行吞掉（用户要能在控制台看到失败原因）
      const tail = (buffer + stderrBuffer).trim();
      if (tail) onLine(tail);
      resolve({ code });
    });
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
  const bySha = new Map<string, { taskId: string; taskNo: string | null; title: string; count: number }[]>();
  for (const t of plan.tasks) {
    for (const l of t.links) {
      const list = bySha.get(l.sha) ?? [];
      list.push({ taskId: t.taskId, taskNo: t.taskNo, title: t.title, count: list.length + 1 });
      bySha.set(l.sha, list);
    }
  }
  const out = new Map<string, Ownership>();
  for (const [path, { sha }] of finalPathMap(plan.filesByCommit)) {
    const owners = bySha.get(sha) ?? [];
    const first = owners[0];
    out.set(path, first
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
): Promise<{ files: number; bytes: number; snapshotHeadSha: string }> {
  const finalPath = finalPathMap(plan.filesByCommit);
  const specs = [...finalPath.values()].map(({ sha, path }) => `${sha}:${path}`);
  assertWithinLimits(specs.length, 0);
  await mkdir(dir, { recursive: true });
  const inner = new AbortController();
  let bytes = 0;
  let limitHit: ScanError | null = null;
  let abortHit: ScanError | null = signal?.aborted ? new ScanError('aborted', '已中止') : null;
  const pendingWrites: Promise<void>[] = [];
  if (signal) {
    if (!signal.aborted) signal.addEventListener('abort', () => { abortHit ??= new ScanError('aborted', '已中止'); inner.abort(); }, { once: true });
    else inner.abort();
  }
  try {
    await catFileBatch(plan.workspacePath, specs, (o: BatchObject) => {
      if (inner.signal.aborted || limitHit || abortHit) return;
      if (o.missing || o.content === null) return;
      const spec = o.spec;
      const entry = [...finalPath.values()].find((v) => `${v.sha}:${v.path}` === spec);
      const rel = entry?.path ?? spec.split(':').slice(1).join(':');
      const abs = safeJoin(dir, rel);
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
  } catch (e) {
    if (limitHit) throw limitHit;
    if (abortHit) throw abortHit;
    throw e;
  }
  if (limitHit) throw limitHit;
  if (abortHit) throw abortHit;
  await Promise.all(pendingWrites);
  // 拓扑序（父在子前）的最后一个提交 = 这批快照里最新的 SHA
  const snapshotHeadSha = plan.commits[plan.commits.length - 1]?.sha ?? '';
  onStage('snapshot', { files: finalPath.size, bytes, snapshotHeadSha });
  return { files: finalPath.size, bytes, snapshotHeadSha };
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

export function writeBack(
  issues: ScanIssue[],
  opts: { severities: ScanSeverity[]; cap: number; projectIds: string[] },
  ctx: WriteBackContext,
): WriteBackReceipts {
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
  const overflow = picked.slice(opts.cap);

  for (const issue of head) {
    if (!issue.taskId) { receipts.unattributed += 1; continue; }
    if (isFpFresh(issue.fingerprint)) { receipts.skippedDuplicate += 1; continue; }
    const parent = resolveWriteBackParent(issue.taskId);
    const projectId = parent.projectId ?? opts.projectIds[0] ?? '';
    if (!projectId) { receipts.failed += 1; receipts.failedNames.push(`${issue.rule} ${issue.path}:${issue.line}（找不到项目）`); continue; }
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

  if (overflow.length) {
    // 溢出段里 7 天内已回写过的指纹同样跳过：否则同一批问题第二次扫描会再造一张汇总单，
    // 待办池被同一批问题反复灌满（汇总单本身不是指纹主体，只能按成员逐条判）
    const freshOverflow = overflow.filter((i) => isFpFresh(i.fingerprint));
    const pool = overflow.filter((i) => !isFpFresh(i.fingerprint));
    receipts.skippedDuplicate += freshOverflow.length;
    receipts.summaryFor = pool.length;
    if (pool.length) {
      const firstOwner = pool.find((i) => i.taskId)?.taskId ?? head.find((i) => i.taskId)?.taskId ?? '';
      const parent = firstOwner ? resolveWriteBackParent(firstOwner) : { parentId: null, projectId: opts.projectIds[0] ?? null, note: '' };
      const projectId = parent.projectId ?? opts.projectIds[0] ?? '';
      if (projectId) {
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
      } else {
        receipts.failed += pool.length;
      }
    }
  }
  return receipts;
}

/* ------------------------- 阶段 5/6 ------------------------- */

async function waitForAnalysis(
  serverUrl: string,
  token: string,
  componentKey: string,
  deps: Required<Pick<ScanDeps, 'fetchJson'>> & ScanDeps,
  onLog: (line: string) => void,
  onStage: (stage: ScanStage, detail?: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${normalizeSonarUrl(serverUrl)}/api/ce/component?component=${encodeURIComponent(componentKey)}`;
  const started = Date.now();
  const pollMs = deps.cePollMs ?? CE_POLL_MS;
  const timeoutMs = deps.ceTimeoutMs ?? CE_TIMEOUT_MS;
  let lastQueueMinute = -1;
  for (;;) {
    if (signal?.aborted) throw new ScanError('aborted', '已中止');
    const { status, json } = await deps.fetchJson(url, token);
    if (status === 401 || status === 403) throw new ScanError('auth-failed', `等待分析结果被拒绝（HTTP ${status}）`, 'Token 需具备查看该项目的权限。');
    if (status === 404) throw new ScanError('project-not-found', `项目 ${componentKey} 无分析记录`, '确认 projectKey 与扫描确实提交成功（见上面的扫描器输出）。');
    if (status >= 500) throw new ScanError('unreachable', `SonarQube 返回 HTTP ${status}`);
    const st = String(json?.task?.status ?? json?.component?.status ?? '').toUpperCase();
    if (st === 'SUCCESS') {
      onStage('wait', { status: st, waitedMs: Date.now() - started });
      return;
    }
    if (st === 'FAILED' || st === 'CANCELED') {
      const reason = String(json?.analysis?.errors?.[0] ?? json?.task?.reason ?? '') || '无原因字段';
      throw new ScanError('scan-failed', `SonarQube 分析${st === 'FAILED' ? '失败' : '被取消'}：${reason}`, '到 SonarQube 看该项目的分析日志。');
    }
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
    if (status === 401 || status === 403) throw new ScanError('auth-failed', `拉取问题清单被拒绝（HTTP ${status}）`);
    if (status >= 400) throw new ScanError('unreachable', `拉取问题清单失败（HTTP ${status}）${json?.errors?.[0]?.msg ? `：${json.errors[0].msg}` : ''}`);
    const page: any[] = Array.isArray(json?.issues) ? json.issues : [];
    // 分页期间服务端可能插入新问题，用 key 去重防止同一问题被计两次
    for (const i of page) {
      const k = String(i?.issue?.key ?? i?.key ?? '');
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      all.push(i);
    }
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
  const keysConfigured = ids.length
    ? ids.filter((p) => projectKeyFor(p)).length
    : Object.keys(readProjectKeyCount()).length;
  const reasons: string[] = [];
  if (!settings.serverUrl) reasons.push('未配置服务器地址：到「设置 → SonarQube」填写后点「连接测试」。');
  if (!scanner.available) reasons.push(`未探测到可用扫描器：${scanner.hint || '安装 sonar-scanner 并在设置页填路径，或留空按 PATH 探测。'}`);
  if (!java.available) reasons.push(`未探测到 Java：${java.hint || '需要 JDK 11+；本工具不代装。'}`);
  if (!keysConfigured) reasons.push('未配置 projectKey：到「设置 → SonarQube → 默认 projectKey 映射」为所选项目配置。');
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
      .filter(([, v]) => typeof v === 'string' && (v as string).trim())
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

/**
 * 执行一次扫描。
 *
 * `console_jobs` 行先建（jobId 即其 id，UUID 形）——这样刷新页面还能按 id 找回运行态；
 * 任何失败路径都要 markError 并回收快照目录，不能留没人收的 busy 行（AC-16「无残留 job」）。
 */
export async function runSonarScan(
  input: ScanInput,
  emit: {
    stage?: (stage: ScanStage, detail?: Record<string, unknown>) => void;
    log?: (line: string) => void;
    /** jobId 要尽早回给前端（中止按钮按它掐进程），所以在建 console_job 的当场就报 */
    job?: (jobId: string) => void;
  },
  deps: ScanDeps = {},
  signal?: AbortSignal,
): Promise<ScanResult> {
  const settings = readScanSettings();
  const taskIds = [...new Set((input.taskIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (!taskIds.length) throw new ScanError('no-tasks', '未勾选任何任务');
  if (!settings.serverUrl) throw new ScanError('no-server', '未配置 SonarQube 服务器地址', '到「设置 → SonarQube」填写地址并保存。');

  // 1 汇总（复用 §3.3 取数口径）
  const plan = await planExtract(taskIds);
  const projectIds = plan.projects.map((p) => p.projectId);
  const projectKey = String(input.projectKey ?? '').trim()
    || projectKeyFor(projectIds[0] ?? '')
    || Object.values(readProjectKeyCount())[0]
    || '';
  if (!projectKey) throw new ScanError('no-project-key', `项目「${plan.projects[0]?.name ?? projectIds[0] ?? ''}」未配置 projectKey`, '到「设置 → SonarQube → 默认 projectKey 映射」配置后重试。');

  const job = ConsoleJobService.create({
    title: `[Sonar] 质量扫描 ${projectKey} · ${plan.tasks.length} 个任务`,
    prompt: `任务范围：${taskIds.join(', ')}\nprojectKey：${projectKey}`,
    category: 'sonar',
    period: null,
    projectIds,
  });
  const jobId = job.id;
  emit.job?.(jobId);
  const dir = sonarJobDir(jobId);
  const stage: NonNullable<typeof emit.stage> = (s, detail) => {
    runningStages.set(jobId, { stage: s, at: Date.now() });
    emit.stage?.(s, detail);
  };
  const logLines: string[] = [];
  const token = settings.token;
  const log: NonNullable<typeof emit.log> = (line) => {
    if (logLines.length < MAX_LOG_LINES) logLines.push(redact(line, token));
    emit.log?.(redact(line, token));
  };

  try {
    stage('collect', { files: plan.uniquePaths, commits: plan.commits.length, tasks: plan.tasks.length, projects: plan.projects.length });

    // 2 快照
    const snap = await exportSnapshot(plan, dir, stage, signal);
    stage('snapshot', { files: snap.files, bytes: snap.bytes, snapshotHeadSha: snap.snapshotHeadSha });

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
    stage('config', { propsFile, inclusions: inclusions.length });

    // 4 扫描
    const spawnScanner = deps.spawnScanner ?? defaultSpawnScanner;
    const spec = planScannerSpawn(settings.scannerPath || 'sonar-scanner', ['-Dproject.settings=sonar-project.properties']);
    if (spec.unsafe) throw new ScanError('no-scanner', '扫描器路径含 cmd.exe 无法安全执行的字符', '在设置页改指向不含 & | ^ % < > " \' ; 反引号 的路径。');
    stage('scan', { scanner: settings.scannerPath || 'sonar-scanner' });
    log(`$ sonar-scanner -Dproject.settings=sonar-project.properties（工作目录 ${dir}）`);
    const run = await spawnScanner(spec, {
      ...process.env as Record<string, string>,
      SONAR_TOKEN: token,
      SONAR_HOST_URL: normalizeSonarUrl(settings.serverUrl),
      SONAR_PROJECT_BASE_DIR: dir,
    }, log, signal);
    if (signal?.aborted) throw new ScanError('aborted', '已中止');
    if (run.code !== 0) throw new ScanError('scan-failed', `扫描器退出码 ${run.code}`, '看上面的扫描器输出；常见原因是 projectKey 无权限或服务器不可达。');

    // 5 等待
    const fetchDeps = { ...deps, fetchJson: deps.fetchJson ?? sonarGet } as Required<Pick<ScanDeps, 'fetchJson'>> & ScanDeps;
    await waitForAnalysis(settings.serverUrl, token, projectKey, fetchDeps, log, stage, signal);

    // 6 拉取
    const raw = await fetchAllIssues(settings.serverUrl, token, projectKey, fetchDeps, stage, signal);
    const reportBase = normalizeSonarUrl(settings.serverUrl);
    const issues: ScanIssue[] = raw.map((i) => {
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
    });
    stage('fetch', { total: issues.length });
    const grouped = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, issues.filter((i) => i.severity === s)])) as Record<ScanSeverity, ScanIssue[]>;

    // 时效声明：快照基于 SHA x，当前 HEAD 为 y，相差 n 个提交
    let currentHeadSha = '';
    let headLag = 0;
    try {
      currentHeadSha = await resolveRevisionSha(plan.workspacePath, 'HEAD');
      if (currentHeadSha && snap.snapshotHeadSha && currentHeadSha !== snap.snapshotHeadSha) {
        headLag = (await collectCommitLog(plan.workspacePath, [`${snap.snapshotHeadSha}..HEAD`], { signal })).length;
      }
    } catch { /* 时效信息取不到不影响扫描结果本身，留空由回执省略 */ }

    // 7 回写（可关闭）
    let receipts: WriteBackReceipts | null = null;
    if (input.autoWriteBack !== false) {
      const severities = (input.severities ?? DEFAULT_SEVERITIES).filter((s) => SEVERITY_ORDER.includes(s));
      const cap = Number.isInteger(input.cap) && (input.cap as number) > 0 ? (input.cap as number) : WRITEBACK_CAP;
      stage('writeback', { severities, cap });
      receipts = writeBack(issues, { severities, cap, projectIds }, {
        projectKey, serverUrl: settings.serverUrl, snapshotHeadSha: snap.snapshotHeadSha,
      });
      stage('writeback', receipts as unknown as Record<string, unknown>);
    }

    const answer = [
      `projectKey：${projectKey}`,
      `快照：${snap.files} 个文件 / ${snap.bytes} 字节，SHA ${snap.snapshotHeadSha.slice(0, 12)}`,
      `时效：当前 HEAD ${currentHeadSha ? currentHeadSha.slice(0, 12) : '未知'}${headLag ? `，相差 ${headLag} 个提交` : ''}`,
      `问题：共 ${issues.length} 条（${SEVERITY_ORDER.map((s) => `${SEVERITY_LABEL[s]} ${grouped[s].length}`).join(' / ')}）`,
      receipts
        ? `回写：新建 ${receipts.created} / 已存在跳过 ${receipts.skippedDuplicate} / 低于阈值 ${receipts.belowThreshold} / 无法归属 ${receipts.unattributed} / 失败 ${receipts.failed}${receipts.summaryTaskNo ? ` / 汇总单 ${receipts.summaryTaskNo}` : ''}`
        : '回写：已关闭（面板上的自动回写开关）',
      `报告：${reportUrlFor(settings.serverUrl, projectKey)}`,
      '',
      '--- 扫描器输出 ---',
      ...logLines,
    ].join('\n');
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
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 目录本来就不存在时不必再报一次 */ }
  }
}
