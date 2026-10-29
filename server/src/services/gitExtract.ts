/**
 * 八期 §3.3「Git 增量资产提取」取数与打包引擎（T03367 / T03424 / T03425 / T03426 / T03351）。
 *
 * 口径要点（PRD v1.2 §3.3.2 逐条落地，这里只写「为什么」）：
 * - 多项目必须同 `workspace_path`：跨工作空间会让「同一批提交」在不同仓库各自解析，产物语义不成立，直接拒；
 * - 取内容只用 `git cat-file --batch`（单进程、stdin 驱动）：逐文件 spawn `git show` 在 2000 文件量级会把进程数打爆；
 * - 内容落 `MTask_DATA_DIR/tmp/git-extract-<job>/`，**不写入被采集仓库**（AC-14 只读红线）；
 * - PizZip 用 STORE：源码再压缩不省时间；超上限按「文件完整性」分卷，一个文件不拆两半（拆了解出来就是坏文件）；
 * - 下载令牌走 ReportService 的 UUID 一次性 token（下载即删 + 6h TTL 清扫同一把钥匙）；
 * - 打包阶段从磁盘逐文件读回，内存峰值 = 单文件体积，不是整包体积。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import PizZip from 'pizzip';
import ExcelJS from 'exceljs';
import { getDb, dataDir } from '../db/connection';
import { catFileBatch, collectCommitFiles, collectCommitSummaries } from './gitCollect';
import type { BatchObject, CommitFileEntry, CommitSummaryRow } from './gitCollect';
import { saveReportBuffer } from './ReportService';
import { listLinks, resolveTask } from './taskGitLinks';
import type { GitLinkRow, TaskRef } from './taskGitLinks';

/** Q9 甲裁定上限：文件数 ≤2000、总体积 ≤50MB，任务数不设限 */
export const GIT_EXTRACT_MAX_FILES = 2000;
export const GIT_EXTRACT_MAX_BYTES = 50 * 1024 * 1024;

export const GIT_EXTRACT_MODES = ['files', 'xlsx', 'md'] as const;
export type GitExtractMode = (typeof GIT_EXTRACT_MODES)[number];

/** 清单 9 列（§3.3.2 末行；Excel 与 Markdown 同字段，AC-9） */
export const MANIFEST_COLUMNS = ['提交', '文件路径', '变更状态', '新增行', '删除行', '任务编号', '任务标题', '作者', '提交时间'] as const;

export class ExtractError extends Error {
  readonly kind: string;
  readonly counts?: { files: number; bytes: number };
  constructor(kind: string, message: string, counts?: { files: number; bytes: number }) {
    super(message);
    this.kind = kind;
    this.counts = counts;
  }
}

/** 超限即时报错并把「当前计数」写进文案（AC-8：报错要给计数，不能只说超限） */
export function assertWithinLimits(files: number, bytes: number): void {
  if (files > GIT_EXTRACT_MAX_FILES) {
    throw new ExtractError('too-many-files',
      `超出文件数上限：当前 ${files} 个（上限 ${GIT_EXTRACT_MAX_FILES}），请缩小勾选范围`, { files, bytes });
  }
  if (bytes > GIT_EXTRACT_MAX_BYTES) {
    throw new ExtractError('too-large',
      `超出体积上限：当前 ${(bytes / 1024 / 1024).toFixed(1)}MB（上限 ${Math.round(GIT_EXTRACT_MAX_BYTES / 1048576)}MB），请缩小勾选范围`,
      { files, bytes });
  }
}

export interface ExtractTaskRef {
  taskId: string;
  taskNo: string | null;
  title: string;
  status: string;
  projectId: string;
  links: GitLinkRow[];
}

export interface ManifestRow {
  commit: string;
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  taskNo: string | null;
  taskTitle: string;
  author: string;
  date: string;
  binary: boolean;
  /** 二进制文件的字节大小（§3.3.2「清单标二进制 + 字节大小」） */
  binarySize?: number;
}

export interface ExtractPlan {
  jobId: string;
  workspacePath: string;
  projects: { projectId: string; name: string }[];
  tasks: ExtractTaskRef[];
  commits: CommitSummaryRow[];
  /** 逐提交逐行的清单行数（导出规模指示，非去重） */
  manifestRows: number;
  /** 去重后需要落盘的文件数（源文件包口径） */
  uniquePaths: number;
  /** 未回写 commit id 的任务（面板置灰并说明原因，不算失败） */
  unlinked: { taskNo: string | null; title: string }[];
  /** 关联记录已不在当前仓库的提交（换绑/未 fetch） */
  missingShas: string[];
  filesByCommit: { sha: string; shortSha: string; entries: CommitFileEntry[] }[];
}

function titleOf(taskId: string): string {
  const r = getDb().prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title?: string } | undefined;
  return r?.title ?? '';
}
function nameOf(projectId: string): string {
  const r = getDb().prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name?: string } | undefined;
  return r?.name ?? projectId;
}

/**
 * 范围校验 + 清单汇总（§3.3.1「范围」段 / stage 1）。
 *
 * 不做：不解析提交信息取 SHA（关联唯一来源是 task_git_links）、不 checkout、不写工作树。
 */
export async function planExtract(taskIds: string[]): Promise<ExtractPlan> {
  const ids = [...new Set((taskIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (!ids.length) throw new ExtractError('no-tasks', '未勾选任何任务');
  const tasks: ExtractTaskRef[] = [];
  const workspaces = new Set<string>();
  const noWorkspace: string[] = [];
  for (const id of ids) {
    const ref: TaskRef | null = resolveTask({ id });
    if (!ref) throw new ExtractError('task-not-found', `任务不存在或已归档（${id.slice(0, 12)}）`);
    if (!ref.workspacePath) noWorkspace.push(ref.taskNo ?? id);
    workspaces.add(ref.workspacePath);
    tasks.push({
      taskId: ref.id, taskNo: ref.taskNo, title: titleOf(ref.id), status: ref.status,
      projectId: ref.projectId, links: listLinks(ref.id),
    });
  }
  if (noWorkspace.length) {
    throw new ExtractError('no-workspace', `以下任务所在项目未绑定工作空间，无法取数：${noWorkspace.join('、')}`);
  }
  const named = [...workspaces].filter(Boolean);
  if (named.length > 1) {
    throw new ExtractError('cross-workspace', `多项目必须同工作空间：当前勾选跨了 ${named.length} 个工作空间（${named.join(' | ')}）`);
  }
  const workspacePath = named[0];
  const linked = tasks.filter((t) => t.links.length > 0);
  const shas = [...new Set(linked.flatMap((t) => t.links.map((l) => l.sha)))];
  if (!shas.length) throw new ExtractError('no-links', '所选任务均未回写提交 ID，无可提取内容');

  const summaries = await collectCommitSummaries(workspacePath, shas);
  // 提交顺序就是「最终内容」的判定依据：清单按旧→新展开，同一文件后写覆盖前写。
  // 不能只按提交日期排——`git log --no-walk` 返回的是新→旧，而同一秒内的相邻提交日期完全相同
  // （脚本建仓 / rebase / 批量导入极常见），平局会原样保留这个反序：前一个提交把后一个提交
  // 删掉的文件重新写回包里、把改动过的文件导出成最早版本。故按已采集的父提交边做拓扑排序。
  const commitsAsc = topoOrderCommits(summaries.commits);
  const filesByCommit: ExtractPlan['filesByCommit'] = [];
  for (const c of commitsAsc) {
    filesByCommit.push({ sha: c.sha, shortSha: c.shortSha, entries: await collectCommitFiles(workspacePath, c.sha, c.parents) });
  }
  // 源文件包口径：同一文件被多个提交改动只保留「最终内容」一份；删除的既不留在包里也不该留在目录树里
  const finalPath = finalPathMap(filesByCommit);
  assertWithinLimits(finalPath.size, 0);
  return {
    jobId: randomUUID(),
    workspacePath,
    projects: [...new Set(tasks.map((t) => t.projectId))].map((p) => ({ projectId: p, name: nameOf(p) })),
    tasks,
    commits: commitsAsc,
    manifestRows: filesByCommit.reduce((n, f) => n + f.entries.length, 0),
    uniquePaths: finalPath.size,
    unlinked: tasks.filter((t) => t.links.length === 0).map((t) => ({ taskNo: t.taskNo, title: t.title })),
    missingShas: summaries.missing,
    filesByCommit,
  };
}

/**
 * 提交集合排序：父提交必须排在子提交之前（Kahn 拓扑排序，边只取集合内的父子关系）。
 * 无父子边的提交按日期升序、再按 sha 兜底，保证同样输入恒得同样输出（回执可对账）。
 * git 的提交图无环，故拓扑排序必定能吐出全部提交。
 */
function topoOrderCommits(commits: CommitSummaryRow[]): CommitSummaryRow[] {
  const rowBySha = new Map(commits.map((c) => [c.sha, c]));
  const childShas = new Map<string, string[]>();
  const pendingParents = new Map<string, number>();
  for (const c of commits) {
    const inside = c.parents.filter((p) => rowBySha.has(p));
    pendingParents.set(c.sha, inside.length);
    for (const p of inside) childShas.set(p, [...(childShas.get(p) ?? []), c.sha]);
  }
  const byDateThenSha = (a: string, b: string) =>
    Date.parse(rowBySha.get(a)!.date) - Date.parse(rowBySha.get(b)!.date) || (a < b ? -1 : a > b ? 1 : 0);
  const ready = [...pendingParents.keys()].filter((sha) => pendingParents.get(sha) === 0).sort(byDateThenSha);
  const out: CommitSummaryRow[] = [];
  while (ready.length) {
    const sha = ready.shift()!;
    out.push(rowBySha.get(sha)!);
    for (const child of childShas.get(sha) ?? []) {
      const left = (pendingParents.get(child) ?? 1) - 1;
      pendingParents.set(child, left);
      if (left === 0) { ready.push(child); ready.sort(byDateThenSha); }
    }
  }
  return out;
}

/** 文件 → 最后一次改动它的提交（决定导出内容；D 结尾的不导出） */
// 导出给 Sonar 快照（§3.4.2 stage 2）复用：删除/重命名的「最终内容」判定是同一套口径，
// 两处各写一遍迟早漂移（八期 T03424 修的就是这套语义）。
export function finalPathMap(filesByCommit: ExtractPlan['filesByCommit']): Map<string, { sha: string; path: string }> {
  const out = new Map<string, { sha: string; path: string }>();
  // 入参按「父在子前」排序，所以「后写覆盖前写」= 「取最终内容」。乱序会让包里装的是最早版本。
  for (const f of filesByCommit) {
    for (const e of f.entries) {
      // 重命名：旧路径在这一步已不存在，前面提交落进映射的旧名必须撤掉，否则包里同时出现新旧两份
      if (e.status === 'R' && e.oldPath) out.delete(e.oldPath);
      if (e.status === 'D') { out.delete(e.path); continue; }
      out.set(e.path, { sha: f.sha, path: e.path });
    }
  }
  return out;
}

export function extractTmpRoot(): string {
  return join(dataDir(), 'tmp');
}

/** job 目录：jobId 恒为本服务生成的 UUID，仍显式校验——入参参与路径拼接都是遍历攻击面 */
export function jobDir(jobId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId))) throw new ExtractError('bad-job', '非法 job 标识');
  return join(extractTmpRoot(), `git-extract-${String(jobId).toLowerCase()}`);
}

/** 仓库相对路径 → 落盘绝对路径（挡越界；git 侧 assertBatchObjectSpec 已挡一次，这是第二道） */
function safeJoin(root: string, relPath: string): string {
  const abs = resolvePath(root, ...relPath.split(/[\\/]+/).filter((s) => s && s !== '.'));
  // 必须用平台分隔符比对：Windows 上 resolve 给 `...\a.txt`，写死 `/` 会把所有合法相对路径都判成越界
  const normRoot = resolvePath(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + sep)) throw new ExtractError('bad-path', `非法文件路径「${relPath.slice(0, 80)}」`);
  return abs;
}

/** 回收超 TTL 的 job 目录（UUID 令牌文件由 ReportService.sweepReportTmp 负责，这里只管目录） */
export function sweepGitExtractTmp(ttlMs = 6 * 60 * 60 * 1000, now = Date.now()): number {
  const root = extractTmpRoot();
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith('git-extract-')) continue;
    const dir = join(root, name);
    try {
      if (now - statSync(dir).mtimeMs > ttlMs) { rmSync(dir, { recursive: true, force: true }); removed += 1; }
    } catch { /* 单个目录判定失败不影响其余清扫 */ }
  }
  return removed;
}

export interface TaskReceipt {
  taskNo: string | null;
  title: string;
  ok: boolean;
  files: number;
  note: string;
}

export interface ExtractVolume {
  token: string;
  fileName: string;
  bytes: number;
  files: number;
}

export interface ExtractResult {
  jobId: string;
  token: string;
  fileName: string;
  volumes: ExtractVolume[];
  bytes: number;
  files: number;
  receipts: TaskReceipt[];
  manifestRows: number;
}

export type StageEvent = (stage: string, detail?: Record<string, unknown>) => void;

/**
 * 执行一次提取：stage 2 读取内容 → stage 3 打包 → stage 4 可下载。
 *
 * `signal` 中止即回收 tmp（PRD「中止按钮（中止即回收 tmp）」）。
 */
export async function runExtract(
  plan: ExtractPlan,
  mode: GitExtractMode,
  onStage: StageEvent,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const dir = jobDir(plan.jobId);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const finalPath = finalPathMap(plan.filesByCommit);
    const specs = [...finalPath.values()].map(({ sha, path }) => `${sha}:${path}`);
    onStage('collect', { files: specs.length, commits: plan.commits.length, tasks: plan.tasks.length });
    assertWithinLimits(specs.length, 0);

    onStage('read');
    await mkdir(dir, { recursive: true });
    const binarySizes = new Map<string, number>();
    const written = new Map<string, number>();
    // cat-file 的回调是同步的，落盘只能排进队列、在打包前统一 await（否则读到半个文件）
    const pendingWrites: Promise<void>[] = [];
    let bytes = 0;
    // 回调里 throw 会逃出 stdout 事件处理器（=进程级未捕获异常），所以超限/中止都只记状态、
    // 用内部 AbortController 掐子进程，出栈后再把原始错误抛给调用方。
    const inner = new AbortController();
    let limitHit: ExtractError | null = null;
    let abortHit: ExtractError | null = signal?.aborted ? new ExtractError('aborted', '已中止') : null;
    const bail = (e: unknown) => {
      limitHit ??= e instanceof ExtractError ? e : new ExtractError('failed', String((e as Error).message));
      inner.abort();
    };
    if (signal) {
      if (!signal.aborted) signal.addEventListener('abort', () => { abortHit ??= new ExtractError('aborted', '已中止'); inner.abort(); }, { once: true });
      else inner.abort();
    }
    try {
      await catFileBatch(plan.workspacePath, specs, (o: BatchObject) => {
        if (inner.signal.aborted || limitHit || abortHit) return;
        if (o.missing || o.content === null) return;
        const content = o.content;
        bytes += content.length;
        binarySizes.set(o.spec, content.length);
        try {
          assertWithinLimits(written.size + 1, bytes);
        } catch (e) {
          bail(e);
          return;
        }
        if (mode === 'files') {
          const rel = o.spec.slice(o.spec.indexOf(':') + 1);
          let abs: string;
          try {
            abs = safeJoin(dir, rel);
          } catch (e) {
            bail(e);
            return;
          }
          // 仓库相对路径是多层目录，落盘前按层级建目录（保留原始目录结构是 §3.3 的硬要求）
          pendingWrites.push(mkdir(dirname(abs), { recursive: true }).then(() => writeFile(abs, content)));
          written.set(o.spec, content.length);
        }
      }, { signal: inner.signal });
    } catch (e) {
      if (limitHit) throw limitHit;
      if (abortHit || inner.signal.aborted) throw abortHit ?? new ExtractError('aborted', '已中止');
      throw e;
    }
    if (limitHit) throw limitHit;
    if (abortHit || signal?.aborted) throw abortHit ?? new ExtractError('aborted', '已中止');
    await Promise.all(pendingWrites);
    const manifest = buildManifest(plan, binarySizes);
    const receipts = buildReceipts(plan, manifest);
    onStage('pack', { mode, bytes, files: specs.length });
    const volumes = mode === 'files'
      ? await packZipVolumes(dir, plan.jobId, finalPath, specs.length)
      : [await packManifestFile(dir, plan.jobId, mode, plan.commits, manifest)];
    if (!volumes.length) throw new ExtractError('empty', '没有可导出的内容');
    onStage('ready', { volumes: volumes.length, token: volumes[0].token });
    return {
      jobId: plan.jobId,
      token: volumes[0].token,
      fileName: volumes[0].fileName,
      volumes,
      bytes,
      files: specs.length,
      receipts,
      manifestRows: manifest.length,
    };
  } finally {
    // 产物已转成 UUID 令牌，中间落盘目录（含中止路径）一律回收；6h TTL 扫只是兜底
    cleanup();
  }
}

/** 逐提交逐行展开（与源文件包「按最终内容去重」是两套口径，§3.3.2 重复文件行） */
function buildManifest(plan: ExtractPlan, binarySizes: Map<string, number>): ManifestRow[] {
  const ownerBySha = new Map<string, ExtractTaskRef>();
  for (const t of plan.tasks) for (const l of t.links) if (!ownerBySha.has(l.sha)) ownerBySha.set(l.sha, t);
  const rows: ManifestRow[] = [];
  for (const f of plan.filesByCommit) {
    const c = plan.commits.find((x) => x.sha === f.sha);
    const owner = ownerBySha.get(f.sha);
    for (const e of f.entries) {
      rows.push({
        commit: f.shortSha,
        path: e.path,
        status: e.status,
        additions: e.additions,
        deletions: e.deletions,
        taskNo: owner?.taskNo ?? null,
        taskTitle: owner?.title ?? '',
        author: c?.author ?? '',
        date: c?.date ?? '',
        binary: e.binary,
        ...(e.binary ? { binarySize: binarySizes.get(`${f.sha}:${e.path}`) } : {}),
      });
    }
  }
  return rows;
}

function buildReceipts(plan: ExtractPlan, manifest: ManifestRow[]): TaskReceipt[] {
  const shortToSha = new Map(plan.commits.map((c) => [c.shortSha, c.sha]));
  return plan.tasks.map((t) => {
    const shas = new Set(t.links.map((l) => l.sha));
    const files = manifest.filter((r) => shas.has(shortToSha.get(r.commit) ?? r.commit)).length;
    const gone = [...shas].filter((s) => plan.missingShas.includes(s));
    return {
      taskNo: t.taskNo,
      title: t.title,
      ok: files > 0 && gone.length === 0,
      files,
      note: files === 0
        ? (gone.length ? '关联提交已不在当前仓库' : '未回写 commit id')
        : gone.length ? `部分提交解析不到：${gone.map((s) => s.slice(0, 7)).join('、')}` : '',
    };
  });
}

/**
 * 封卷判定（§3.3.2「单包超限时分卷 zip」）。
 *
 * 独立成函数是因为这条判定的边界要能被门逐字验证：首文件必须入卷（否则空卷死循环），
 * 只有「已在卷内 + 再加会超」才封。Q9 甲的任务级 50MB 上限在读取阶段就拦住了大体量，
 * 所以正常任务只出一卷；卷判定守的是「接近上限的最后一卷不要再叠」这条底线。
 */
export function shouldSealVolume(curBytes: number, nextBytes: number): boolean {
  return curBytes > 0 && curBytes + nextBytes > GIT_EXTRACT_MAX_BYTES;
}

/**
 * STORE 分卷打包：逐文件从磁盘读回（内存峰值 = 单文件），超上限即封卷开下一卷。
 *
 * 分卷按「文件完整性」切——一个文件绝不拆两半，否则解出来是坏文件。
 */
async function packZipVolumes(
  dir: string,
  jobId: string,
  finalPath: Map<string, { sha: string; path: string }>,
  total: number,
): Promise<ExtractVolume[]> {
  const volumes: ExtractVolume[] = [];
  const paths = [...finalPath.values()].map((v) => v.path).sort();
  if (paths.length !== total) throw new ExtractError('bad-state', `落盘文件数与规格数不一致（${paths.length}/${total}）`);
  let zip = new PizZip();
  let curBytes = 0;
  let curFiles = 0;
  const flush = async () => {
    if (curFiles === 0) return;
    const buf = zip.generate({ type: 'nodebuffer', compression: 'STORE' }) as Buffer;
    const fileName = `git-extract-${jobId.slice(0, 8)}-part${volumes.length + 1}.zip`;
    volumes.push({ token: saveReportBuffer(buf), fileName, bytes: buf.length, files: curFiles });
    zip = new PizZip();
    curBytes = 0;
    curFiles = 0;
  };
  for (const rel of paths) {
    const buf = await readFile(safeJoin(dir, rel));
    if (shouldSealVolume(curBytes, buf.length)) await flush();
    zip.file(rel.replace(/\\/g, '/'), buf, { compression: 'STORE' });
    curBytes += buf.length;
    curFiles += 1;
  }
  await flush();
  return volumes;
}

function sheetFrom(rows: ManifestRow[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('增量清单');
  ws.addRow([...MANIFEST_COLUMNS]);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow([
      r.commit,
      r.path,
      r.binary ? `二进制（${r.binarySize ?? 0} 字节）` : r.status,
      r.binary ? '-' : (r.additions ?? 0),
      r.binary ? '-' : (r.deletions ?? 0),
      r.taskNo ?? '',
      r.taskTitle,
      r.author,
      r.date,
    ]);
  }
  return wb;
}

async function packManifestFile(
  dir: string,
  jobId: string,
  mode: GitExtractMode,
  commits: CommitSummaryRow[],
  rows: ManifestRow[],
): Promise<ExtractVolume> {
  let buf: Buffer;
  let fileName: string;
  if (mode === 'xlsx') {
    const wrote = await sheetFrom(rows).xlsx.writeBuffer();
    buf = Buffer.from(wrote as unknown as ArrayBuffer);
    fileName = `git-extract-${jobId.slice(0, 8)}.xlsx`;
  } else {
    const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const lines = ['# Git 增量资产清单', '', '## 提交摘要', '', '| 提交 | 主题 | 作者 | 时间 |', '|---|---|---|---|'];
    for (const c of commits) lines.push(`| \`${c.shortSha}\` | ${esc(c.subject)} | ${esc(c.author)} | ${c.date} |`);
    lines.push('', '## 文件清单', '', `| ${MANIFEST_COLUMNS.join(' | ')} |`, `|${MANIFEST_COLUMNS.map(() => '---').join('|')}|`);
    for (const r of rows) {
      lines.push(`| \`${r.commit}\` | ${esc(r.path)} | ${r.binary ? `二进制（${r.binarySize ?? 0} 字节）` : r.status} | `
        + `${r.binary ? '-' : (r.additions ?? 0)} | ${r.binary ? '-' : (r.deletions ?? 0)} | ${r.taskNo ?? ''} | ${esc(r.taskTitle)} | ${esc(r.author)} | ${r.date} |`);
    }
    buf = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    fileName = `git-extract-${jobId.slice(0, 8)}.md`;
  }
  await writeFile(join(dir, fileName), buf);
  return { token: saveReportBuffer(buf), fileName, bytes: buf.length, files: rows.length };
}
