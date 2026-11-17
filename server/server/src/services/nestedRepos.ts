/**
 * T04525（§4.4 修订）：同一工作空间目录下的**多仓库发现**。
 *
 * 需求原话是「`D:\code\QJ\BEMP5.0DEV` 下有 master 与 feature/hnnxbank/dev 分支，还有
 * adapter/.git、banks/.git、deploy/.git、served/.git… 多个仓库」——用户要看的不是
 * 「多个项目各自的工作空间」，而是「一个工作空间目录里装着多少个仓库」。
 * 而服务端此前的判定只有 `git rev-parse --is-inside-work-tree`（`gitCollect.ts:273`），
 * 它在子目录里也会回 true（归属外层仓库），于是内嵌仓库在旧口径下**根本不存在**。
 *
 * 三条口径：
 *  1. **以 `.git` 实体为唯一判据**（目录或 worktree/子模块的 gitfile 都算）：不做「看起来像工程目录」的猜测，
 *     否则 `node_modules` 里每个包都会冒充仓库；
 *  2. **命中即边界（默认）**：一个目录被认定为仓库后不再往里下钻——仓库内再嵌仓库属于该仓库自己的事务，
 *     列出来只会让清单变噪音；`descendIntoRepos`（T04883，仅 `/git/repos` 普查开启）是例外：分组目录
 *     本身是仓库、内部仍装着独立仓库时（如 `BEMP5.0DEV/banks`），继续下钻才不会把那些仓库连同分支漏掉；
 *  3. **有界**：深度、目录数、返回条数全部有上限，发现过程不许变成全盘扫描（工作空间可能是几百 GB 的代码树）。
 *
 * 只读：本模块只 `readdir`/`stat`，绝不 fork git、绝不写任何文件。
 */
import path from 'node:path';
import { promises as fs, type Dirent } from 'node:fs';

/** 一个仓库在工作空间目录里的位置 */
export interface NestedRepo {
  /** 相对工作空间根的路径（POSIX 分隔）；空串 = 工作空间根本身就是仓库 */
  subPath: string;
  /** 绝对路径（交给 git 当 cwd 用） */
  absPath: string;
  /** 展示名：根仓库用工作空间目录名，子仓库用其所在目录名 */
  displayName: string;
  isRoot: boolean;
  /** T04586：当前分支（detached/空仓库为空串）；发现阶段不填，由清单取数层补元数据 */
  branch?: string;
  /** T04586：最新提交哈希（空仓库为空串） */
  commit?: string;
  /** T04586：origin 远端 URL（未配置为空串） */
  remoteUrl?: string;
}

export interface DiscoverReposResult {
  workspacePath: string;
  repos: NestedRepo[];
  /** 实际查看过的目录数（门与诊断用，不承诺等于仓库数） */
  scannedDirs: number;
  /** 因深度或条数上限被截断 */
  truncated: boolean;
}

/** 下钻深度上限：实测的内嵌仓库都在第 1 层，留 2 层给 `apps/xxx`、`services/xxx` 这类分组目录 */
export const NESTED_REPO_MAX_DEPTH = 2;
/** 返回条数上限：一个工作空间里几十个子仓库已经超出人能扫视的清单，超出置 truncated */
export const NESTED_REPO_MAX_COUNT = 40;
/** 单次发现最多查看的目录数（防御巨型 monorepo 与符号链接环路） */
export const NESTED_REPO_MAX_SCAN_DIRS = 2000;

/** 一定不是「人手工放进去的仓库」的目录名：跳过不下钻，也不会被当成仓库 */
const SKIPPED_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode',
]);

/** 隐藏目录（`.` 开头）默认不下钻：`.trae`/`.workbuddy`/`.screenshots` 这类工具产物不是用户的仓库 */
function isSkippedName(name: string): boolean {
  return SKIPPED_DIR_NAMES.has(name.toLowerCase()) || name.startsWith('.');
}

/** `<dir>/.git` 是否存在（目录或 gitfile 都算），用于判「这个目录是一个仓库根」 */
async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * 「这个目录本身是不是一个仓库根」——与 `probeRepository` 的 `--is-inside-work-tree` **不是一回事**。
 *
 * 这个区分是 D-06 实测揪出来的：`docs/` 位于根仓库工作树之内，`--is-inside-work-tree` 照样回 true，
 * 于是 `repoSub=docs` 会「成功」返回**根仓库**的提交——用户看到的是「多了一个仓库」，实际是同一份历史换了个名字。
 * `repoSub` 是一次「这里是一个独立仓库」的断言，所以必须按 `.git` 实体核，不能按「在不在某个工作树里」核。
 */
export function isRepositoryRoot(dir: string): Promise<boolean> {
  return hasGitEntry(dir);
}

function toPosixRel(workspacePath: string, absPath: string): string {
  return path.relative(workspacePath, absPath).split(path.sep).join('/');
}

/**
 * 发现工作空间目录内的全部仓库：根目录自身若为仓库则排第一，其余按相对路径字典序。
 *
 * 广度优先：先浅后深，条数上限截断时留下的是用户更可能关心的浅层仓库。
 */
export async function discoverNestedRepos(
  workspacePath: string,
  limits: { maxDepth?: number; maxCount?: number; maxScanDirs?: number; descendIntoRepos?: boolean } = {},
): Promise<DiscoverReposResult> {
  const root = path.resolve(workspacePath);
  const maxDepth = limits.maxDepth ?? NESTED_REPO_MAX_DEPTH;
  const maxCount = limits.maxCount ?? NESTED_REPO_MAX_COUNT;
  const maxScanDirs = limits.maxScanDirs ?? NESTED_REPO_MAX_SCAN_DIRS;
  /** T04883：默认保持「命中即边界」，仅普查显式开启时才进仓库目录内部继续找 */
  const descendIntoRepos = limits.descendIntoRepos ?? false;
  const repos: NestedRepo[] = [];
  let scannedDirs = 0;
  let truncated = false;

  const rootIsRepo = await hasGitEntry(root);
  if (rootIsRepo) {
    repos.push({ subPath: '', absPath: root, displayName: path.basename(root), isRoot: true });
  }
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    if (depth >= maxDepth) { truncated = true; continue; }
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/竞态删除：跳过这一支，不因此让整视图报错
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (isSkippedName(entry.name)) continue;
      if (scannedDirs >= maxScanDirs) { truncated = true; continue; }
      const abs = path.join(dir, entry.name);
      scannedDirs += 1;
      const isRepo = await hasGitEntry(abs);
      if (isRepo) {
        if (repos.length >= maxCount) truncated = true;
        else repos.push({ subPath: toPosixRel(root, abs), absPath: abs, displayName: entry.name, isRoot: false });
        // T04883：census 开启 descendIntoRepos 时不停在这里，继续把该目录压进队列；
        // 仍受 maxDepth / maxScanDirs 约束，且 .git、node_modules 等由 isSkippedName 挡住。
        if (!descendIntoRepos) continue; // 口径 2：默认命中即边界，不再下钻
      }
      // 符号链接指向目录才继续下钻；链接环路由 maxScanDirs 兜住
      if (entry.isSymbolicLink()) {
        try {
          if (!(await fs.stat(abs)).isDirectory()) continue;
        } catch { continue; }
      }
      queue.push({ dir: abs, depth: depth + 1 });
    }
  }
  repos.sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.subPath.localeCompare(b.subPath));
  return { workspacePath: root, repos, scannedDirs, truncated };
}

/** 大小写不敏感比较用的归一（Windows/macOS 文件系统不区分大小写，Linux 区分） */
const caseFold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);

/**
 * 把 `repoSub` 解析成工作空间内的绝对路径，**并校验它真在工作空间里面**。
 *
 * 为什么必须校验：这个值来自前端 query，拼成 cwd 之后就是「在哪个目录执行 git」。
 * 只判 `..` 字符串不够——绝对路径、Windows 盘符、软链出逃都能绕过字面检查，
 * 所以判据落在「resolve 之后仍然以工作空间为前缀」这一条几何事实。
 * 不合法时抛错（调用方折成 `ok:false` 的一句话），不静默回落到工作空间根：
 * 回落会把「子仓库的提交」读成「根仓库没有这些提交」，那是更难查的错。
 */
export function resolveRepoSubPath(workspacePath: string, repoSub: string): string {
  const root = path.resolve(workspacePath);
  const sub = (repoSub ?? '').trim();
  if (!sub || sub === '.') return root;
  const candidate = path.isAbsolute(sub) ? path.resolve(sub) : path.resolve(root, sub);
  const rel = path.relative(root, candidate);
  const escapes = rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
  if (escapes || !caseFold(candidate).startsWith(caseFold(root))) {
    throw new Error(`仓库路径越出工作空间：${repoSub}`);
  }
  return candidate;
}
