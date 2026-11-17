/**
 * T05210：Git 树选范围弹窗「右栏变更文件树」的数据源——**按项目 + 仓库坐标**批量取若干提交的变更文件清单。
 *
 * 为什么不复用 `GET /tasks/:id/git/:sha/files`：那条链路要一个任务 id 才能确定工作空间，
 * 而弹窗此刻还没有任务（用户正在挑提交，挑完才回传给任务/讲稿卡）。按 projectId + repoSub 定位仓库
 * 与 `queryGitLog`/`queryGitRepos` 是同一套口径（`resolveRepoSubPath` 判几何包含、`isRepositoryRoot` 判实体仓库），
 * 这样「左栏列出来的提交」与「右栏取到的文件」永远指向同一个 .git。
 *
 * 一次 `git log --no-walk -m --first-parent --raw --numstat`（`collectCommitFilesBatch`）取齐 N 个提交，
 * 不逐提交 spawn——右栏在每次点选时都要重取，逐条 fork 在 Windows 上是秒级等待。
 *
 * 失败口径与 lectureGitLog 一致：降级（未配工作空间 / 没装 git / 不是仓库 / 子目录不是仓库）回 `ok:false` + 一句人话，
 * 只有参数非法才 4xx；不让前端把「这个仓库取不了数」显示成「这个提交没有改文件」。
 */
import { getDb } from '../db/connection';
import { ACTIVE_PROJECT_WHERE } from '../util/projectRouting';
import {
  GitCollectError,
  collectCommitFiles,
  collectCommitFilesBatch,
  probeRepository,
  resolveCommitsInfo,
  type CommitFileEntry,
} from './gitCollect';
import { isRepositoryRoot, resolveRepoSubPath } from './nestedRepos';

/** 单次请求最多点名多少个提交：右栏是「点选即取」，超出这个量的交互本身已经不可读，
 *  且 `git log` 一次吐 N 个提交的完整文件清单会撞缓冲区上限。前端按此分片。 */
export const MAX_COMMIT_FILES_BATCH = 40;

/** 文件清单缓存的条数上限：SHA 决定内容，天然不可变，故不设 TTL，只做 LRU 淘汰。 */
const FILES_CACHE_MAX = 2000;
const filesCache = new Map<string, CommitFileEntry[]>();

const cacheKeyOf = (repoPath: string, sha: string) => `${repoPath}|${sha}`;

function readCache(repoPath: string, sha: string): CommitFileEntry[] | null {
  const key = cacheKeyOf(repoPath, sha);
  const hit = filesCache.get(key);
  if (!hit) return null;
  filesCache.delete(key);
  filesCache.set(key, hit);
  return hit;
}

function writeCache(repoPath: string, sha: string, files: CommitFileEntry[]): void {
  const key = cacheKeyOf(repoPath, sha);
  filesCache.delete(key);
  filesCache.set(key, files);
  if (filesCache.size > FILES_CACHE_MAX) {
    const oldest = filesCache.keys().next().value;
    if (oldest !== undefined) filesCache.delete(oldest);
  }
}

/** 测试/长跑进程用：清空缓存（与 taskGitLinks 的同类出口同形） */
export function clearCommitFilesCache(): void {
  filesCache.clear();
}

export interface CommitFilesRequest {
  projectId: string;
  /** 工作空间内的子仓库相对路径（空串 = 根仓库），与 `/git/log` 的 repoSub 同义 */
  repoSub?: string;
  /** 提交 SHA（完整或 7–40 位前缀）；重复项自动去重 */
  shas: string[];
}

export interface CommitFilesResult {
  ok: boolean;
  projectId: string;
  projectName: string;
  workspacePath: string;
  repoSub: string;
  /** SHA → 变更文件清单；只含真正取到的提交（缺失的进 `missing`，不塞空数组冒充「没改文件」） */
  files: Record<string, CommitFileEntry[]>;
  /** 请求了但仓库里已经取不到的 SHA（rebase / force-push / gc 之后）——右栏要如实说「这条提交没了」 */
  missing: string[];
  /** 单次上限（前端按它分片） */
  limit: number;
  /** 因超上限本次未取数的 SHA 条数（>0 时前端应继续发下一片，而不是以为取全了） */
  dropped: number;
  error?: { kind: string; message: string };
}

interface ProjectRow {
  id: string;
  name: string;
  workspace_path: string | null;
}

/** 有上限的并发映射：结果按下标对齐，单项失败不影响其它项（失败由调用方记为 missing） */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 兜底路径：批量的 `git log` 只要有一个 SHA 不在仓库里就整体非零退出（一条失效 SHA 会毒掉整屏）。
 * 这里逐条核对「这条提交还在不在」，再用一次批量取**存活的那部分**的清单——
 * 逐条取 diff 会是 2N 次 spawn，而逐条只核对 parents 是 N 次小输出 + 1 次批量。
 */
async function collectWithPoisonGuard(
  repoPath: string,
  shas: readonly string[],
  opts: { timeoutMs?: number },
): Promise<{ files: Map<string, CommitFileEntry[]>; missing: string[] }> {
  const missing: string[] = [];
  const alive: string[] = [];
  await mapLimit(shas, 6, async (sha) => {
    try {
      // 单条解析：`resolveCommitsInfo` 只用一个 SHA 时不会因为「其它 SHA 缺失」而整体失败
      const info = await resolveCommitsInfo(repoPath, [sha], opts);
      const entry = info.get(sha) ?? (info.size === 1 ? [...info.values()][0] : undefined);
      if (entry) alive.push(sha);
      else missing.push(sha);
    } catch {
      missing.push(sha);
    }
  });
  if (!alive.length) return { files: new Map(), missing };
  try {
    const batch = await collectCommitFilesBatch(repoPath, alive, opts);
    for (const sha of alive) if (!batch.has(sha)) missing.push(sha);
    return { files: batch, missing };
  } catch {
    // 极少数情况（缓冲区爆掉）才退到逐条 diff；这里不再抛，缺失如实上报
    const files = new Map<string, CommitFileEntry[]>();
    await mapLimit(alive, 4, async (sha) => {
      try {
        const info = await resolveCommitsInfo(repoPath, [sha], opts);
        const entry = info.get(sha) ?? (info.size === 1 ? [...info.values()][0] : undefined);
        if (!entry) { missing.push(sha); return; }
        files.set(sha, await collectCommitFiles(repoPath, sha, entry.parents, opts));
      } catch {
        missing.push(sha);
      }
    });
    return { files, missing };
  }
}

/**
 * 批量取提交文件清单。调用方（弹窗右栏）负责按 `limit` 分片。
 */
export async function queryCommitFiles(req: CommitFilesRequest): Promise<CommitFilesResult> {
  const projectId = typeof req.projectId === 'string' ? req.projectId.trim() : '';
  const base: CommitFilesResult = {
    ok: false,
    projectId,
    projectName: projectId,
    workspacePath: '',
    repoSub: (req.repoSub ?? '').trim(),
    files: {},
    missing: [],
    limit: MAX_COMMIT_FILES_BATCH,
    dropped: 0,
  };
  if (!projectId) return { ...base, error: { kind: 'denied', message: 'projectId 必填' } };

  const requested = [...new Set((req.shas ?? []).map((s) => String(s).trim()).filter(Boolean))];
  const shas = requested.slice(0, MAX_COMMIT_FILES_BATCH);
  const dropped = Math.max(0, requested.length - shas.length);

  const project = getDb()
    .prepare(`SELECT id, name, workspace_path FROM projects WHERE id = ? AND ${ACTIVE_PROJECT_WHERE}`)
    .get(projectId) as ProjectRow | undefined;
  if (!project) return { ...base, dropped, error: { kind: 'denied', message: '项目不存在或已归档（请刷新项目列表）' } };
  const named = { ...base, projectName: project.name, dropped };

  const workspacePath = (project.workspace_path ?? '').trim();
  if (!workspacePath) return { ...named, error: { kind: 'no-workspace', message: '未配置工作空间路径（请在项目管理中补配）' } };

  const repoSub = base.repoSub;
  let repoPath = workspacePath;
  try {
    repoPath = resolveRepoSubPath(workspacePath, repoSub);
  } catch (e) {
    return { ...named, error: { kind: 'bad-repo', message: e instanceof Error ? e.message : String(e) } };
  }
  // 与 /git/log 同一条红线：非空 repoSub 必须是一个**实体仓库根**，否则会静默读到根仓库的历史
  if (repoSub && !(await isRepositoryRoot(repoPath))) {
    return { ...named, error: { kind: 'not-a-repo', message: `${repoSub} 不是一个 Git 仓库（该目录下没有 .git）` } };
  }
  const probe = await probeRepository(repoPath);
  if (!probe.available) return { ...named, error: { kind: probe.kind ?? 'no-git', message: probe.detail ?? '未找到 git 命令：请安装 Git' } };
  if (!probe.isRepo) {
    return { ...named, error: { kind: probe.kind ?? 'not-a-repo', message: probe.detail ?? '工作空间不是 Git 仓库' } };
  }

  if (!shas.length) return { ...named, ok: true, workspacePath };

  // 命中缓存的先取走，只为剩下的 spawn 一次 git（右栏反复点选时热路径上是 0 次）
  const files: Record<string, CommitFileEntry[]> = {};
  const pending: string[] = [];
  for (const sha of shas) {
    const hit = readCache(repoPath, sha);
    if (hit) files[sha] = hit;
    else pending.push(sha);
  }

  const missing: string[] = [];
  if (pending.length) {
    try {
      const batch = await collectCommitFilesBatch(repoPath, pending);
      for (const [sha, entries] of batch) {
        files[sha] = entries;
        writeCache(repoPath, sha, entries);
      }
      for (const sha of pending) if (!(sha in files)) missing.push(sha);
    } catch (e) {
      const kind = e instanceof GitCollectError ? e.kind : 'failed';
      if (kind === 'no-git' || kind === 'not-a-repo' || kind === 'timeout') {
        return { ...named, files, error: { kind, message: e instanceof Error ? e.message : String(e) } };
      }
      // failed / too-large / bad-revision：整体非零退出多半是「其中某个 SHA 已经不在仓库里」，
      // 退回带毒丸隔离的取数，把失败范围收窄到真正缺失的那几条，不让一条失效 SHA 拖垮整屏。
      const one = await collectWithPoisonGuard(repoPath, pending, {});
      for (const [sha, entries] of one.files) {
        files[sha] = entries;
        writeCache(repoPath, sha, entries);
      }
      missing.push(...one.missing);
    }
  }

  return { ...named, ok: true, workspacePath, files, missing };
}
