/**
 * T05210：Git 树选范围弹窗**右栏**的纯逻辑（变更文件树 / 多记录聚合 / Base 对比 / 视窗切片）。
 *
 * 为什么单独成模块：右栏是「点选即重算」的地方，组件里算就等于只能靠真浏览器断言；
 * 抽出来之后，四条最容易撒谎的边界能在 node 门里先钉住——
 *  1. **层级合并**：同一目录下的文件必须落到同一个目录节点，不能因为分隔符/大小写差异裂成两份；
 *  2. **聚合去重**：多条记录改同一个文件只出**一行**，状态取「最新一次修改」（last-wins），
 *     而不是把三条记录的同名文件平铺成三行（那会让「动了多少个文件」这个数字直接失真）；
 *  3. **Base 对比**：只在真的取到两边清单时给结论，缺失的 SHA 不许当成「这个文件没改」；
 *  4. **视窗切片**：1000+ 文件时只渲染可见窗口，切片算错会出现「滚到底还是空白」或「行高跳动」。
 *
 * 状态字母沿用服务端 `gitCollect.CommitFileStatus`（A/M/D/R/T）：右栏显示与 `git show --stat` 同源，
 * 不另造一套「新增/修改/删除」的第二口径。
 */

/** 与服务端 `gitCollect.CommitFileStatus` 同形状（web 侧不 import server 模块，各自声明） */
export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'T';

/** 与服务端 `gitCollect.CommitFileEntry` 同形状 */
export interface CommitFileEntry {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitFilesPayload {
  sha: string;
  /** 提交时间（ISO）：聚合时用它判「哪一次是最新修改」 */
  date: string;
  files: readonly CommitFileEntry[];
}

/** 文件行（叶子）。聚合视图下 `shas` 会多于一个 */
export interface FileLeaf {
  kind: 'file';
  name: string;
  /** 仓库相对全路径（与 git 输出一致，`/` 分隔） */
  path: string;
  depth: number;
  status: GitFileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** 改过这个文件的提交（按调用方给的顺序去重）；聚合视图下用来提示「改过 K 次」 */
  shas: string[];
  /** 最后一次改写它的提交（last-wins 的依据，详情里点名用） */
  latestSha: string;
  /** 各提交对它的状态（去重后按首次出现序）；长度 >1 说明多次修改的状态不一致 */
  statuses: GitFileStatus[];
  /** 重命名前的路径（仅 status='R' 且能从条目里读到） */
  oldPath?: string;
}

/** 目录行 */
export interface FileDir {
  kind: 'dir';
  name: string;
  path: string;
  depth: number;
  children: FileTreeNode[];
  /** 该目录下（含深层）的文件总数——折叠态下也要能显示数量，不能让用户以为目录是空的 */
  fileCount: number;
  additions: number;
  deletions: number;
}

export type FileTreeNode = FileLeaf | FileDir;

/** 拍平后的一行：虚拟滚动按它渲染，`depth` 决定缩进 */
export interface FileTreeRow {
  node: FileTreeNode;
  depth: number;
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 目录优先、再按名字升序：与 IDEA 的文件树一致（目录永远在上，同级按字母） */
function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.sort((a, b) => {
    const dirA = a.kind === 'dir' ? 0 : 1;
    const dirB = b.kind === 'dir' ? 0 : 1;
    return dirA - dirB || byName(a, b);
  });
}

/**
 * 把「提交里的文件列表」铺成一棵树。
 *
 * 空路径段（`a//b`、结尾 `/`）直接跳过而不是造一个空名目录：这类路径只会来自损坏的 git 输出，
 * 造出空名节点会让缩进凭空多一级。
 */
export function buildFileTree(files: readonly FileLeaf[], rootPath = ''): FileDir[] {
  const root: FileDir = { kind: 'dir', name: '', path: rootPath, depth: -1, children: [], fileCount: 0, additions: 0, deletions: 0 };
  const dirs = new Map<string, FileDir>([[rootPath, root]]);

  const ensureDir = (full: string, name: string, depth: number): FileDir => {
    const hit = dirs.get(full);
    if (hit) return hit;
    const dir: FileDir = { kind: 'dir', name, path: full, depth, children: [], fileCount: 0, additions: 0, deletions: 0 };
    dirs.set(full, dir);
    return dir;
  };

  for (const leaf of files) {
    const segs = leaf.path.split('/').filter((s) => s.length > 0);
    if (!segs.length) continue;
    let cur = root;
    // 最后一段是文件名，前面的都是目录
    for (let i = 0; i < segs.length - 1; i += 1) {
      const full = segs.slice(0, i + 1).join('/');
      let next = dirs.get(full);
      if (!next) {
        next = ensureDir(full, segs[i], i);
        cur.children.push(next);
      }
      cur = next;
    }
    const leafNode: FileLeaf = { ...leaf, name: segs[segs.length - 1], depth: segs.length - 1 };
    // 同一路径重复出现时保留第一次（调用方应先聚合；这里兜底，避免渲染出两行同路径）
    if (!cur.children.some((c) => c.kind === 'file' && c.path === leafNode.path)) cur.children.push(leafNode);
  }

  // 自底向上累计目录的文件数与增删（递归后序：先算孩子再算自己）
  const rollup = (dir: FileDir): { count: number; add: number; del: number } => {
    let count = 0;
    let add = 0;
    let del = 0;
    for (const child of dir.children) {
      if (child.kind === 'file') {
        count += 1;
        add += child.additions ?? 0;
        del += child.deletions ?? 0;
      } else {
        const sub = rollup(child);
        count += sub.count;
        add += sub.add;
        del += sub.del;
      }
    }
    dir.fileCount = count;
    dir.additions = add;
    dir.deletions = del;
    sortNodes(dir.children);
    return { count, add, del };
  };
  rollup(root);
  return root.children as FileDir[];
}

/** 单提交：把服务端条目转成叶子（shas 只有它自己） */
export function leavesOfCommit(sha: string, files: readonly CommitFileEntry[]): FileLeaf[] {
  return files.map((f) => ({
    kind: 'file' as const,
    name: '',
    path: f.path,
    depth: 0,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    binary: f.binary,
    shas: [sha],
    latestSha: sha,
    statuses: [f.status],
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
  }));
}

/**
 * 多提交聚合：同一路径只出一行，状态按**最新一次修改**（last-wins）。
 *
 * 为什么不是「首次出现」：用户勾了一串提交回看范围，最关心的是「这批提交最终把这个文件弄成什么样」；
 * 用最早一次会把「先新增后删除」的文件显示成 A（新增），而它此刻其实已经不存在了。
 * 增删行数在聚合视图**不做求和**（同一文件多轮改写求和会得到远超实际的数字），
 * 单文件行处改显示「改过 K 次」，统计数字见目录/仓库级的文件数。
 *
 * `commits` 的顺序即优先级：越靠前越新（调用方按可视列表「新→旧」传入）。
 */
export function aggregateCommitFiles(commits: readonly CommitFilesPayload[]): FileLeaf[] {
  const byPath = new Map<string, FileLeaf>();
  for (const commit of commits) {
    for (const f of commit.files) {
      const prev = byPath.get(f.path);
      if (!prev) {
        byPath.set(f.path, {
          kind: 'file',
          name: '',
          path: f.path,
          depth: 0,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary,
          shas: [commit.sha],
          latestSha: commit.sha,
          statuses: [f.status],
          ...(f.oldPath ? { oldPath: f.oldPath } : {}),
        });
        continue;
      }
      if (!prev.shas.includes(commit.sha)) prev.shas.push(commit.sha);
      if (!prev.statuses.includes(f.status)) prev.statuses.push(f.status);
      // 先到的是更新的提交：只补统计，不覆盖状态（last-wins 就是「保留首个」）
      if (prev.binary !== f.binary) prev.binary = prev.binary && f.binary;
    }
  }
  return [...byPath.values()];
}

/** 全部目录路径（默认全展开时给 expanded 集合用） */
export function allDirPaths(nodes: readonly FileTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly FileTreeNode[]): void => {
    for (const n of list) {
      if (n.kind !== 'dir') continue;
      out.push(n.path);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * 拍平成渲染行：折叠的目录只出自己一行，其孩子整段跳过。
 * `depth` 从 0 起（顶层目录/文件都是 0），缩进由调用方按 `depth * INDENT` 算。
 */
export function flattenFileTree(nodes: readonly FileTreeNode[], expanded: ReadonlySet<string>): FileTreeRow[] {
  const out: FileTreeRow[] = [];
  const walk = (list: readonly FileTreeNode[], depth: number): void => {
    for (const n of list) {
      out.push({ node: n, depth });
      if (n.kind === 'dir' && expanded.has(n.path)) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

export interface FileStats {
  files: number;
  additions: number;
  deletions: number;
  /** 二进制文件数（其增删行数为 null，不计入上面两个合计） */
  binary: number;
  byStatus: Record<GitFileStatus, number>;
}

const EMPTY_STATUS_COUNT = (): Record<GitFileStatus, number> => ({ A: 0, M: 0, D: 0, R: 0, T: 0 });

export function fileStatsOf(leaves: readonly FileLeaf[]): FileStats {
  const byStatus = EMPTY_STATUS_COUNT();
  let additions = 0;
  let deletions = 0;
  let binary = 0;
  for (const f of leaves) {
    byStatus[f.status] += 1;
    if (f.binary) { binary += 1; continue; }
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return { files: leaves.length, additions, deletions, binary, byStatus };
}

/** 状态字母 + 中文全称 + 配色 token（token 名与弹窗里注入的 CSS 变量一致，单源在这里） */
export function statusMeta(status: GitFileStatus): { letter: string; label: string; color: string } {
  switch (status) {
    case 'A': return { letter: 'A', label: '新增', color: 'var(--gt-status-add)' };
    case 'D': return { letter: 'D', label: '删除', color: 'var(--gt-status-del)' };
    case 'R': return { letter: 'R', label: '重命名', color: 'var(--gt-status-ren)' };
    case 'T': return { letter: 'T', label: '类型变更', color: 'var(--gt-status-mod)' };
    default: return { letter: 'M', label: '修改', color: 'var(--gt-status-mod)' };
  }
}

/* ------------------------------------------------------------------ *
 * 多记录：按仓库分组 + Base 对比
 * ------------------------------------------------------------------ */

/** 一条选中记录携带的文件清单（含它属于哪个仓库） */
export interface RepoCommitFiles {
  sha: string;
  date: string;
  /**
   * 仓库身份键（`projectId\0repoSub`，与 `gitRepoBranchGroups.repoKeyOf` 同形）。
   * 为什么不是 `repoSub`：本模块只用它**分组**与**取色**，不参与显示——早期误用子路径名字
   * 导致分组头把复合键整串印了出来（含 projectId），这里按真实语义命名。
   */
  repoKey: string;
  repoLabel: string;
  files: readonly CommitFileEntry[];
}

export interface RepoFileGroup {
  repoKey: string;
  repoLabel: string;
  /** 该仓库下聚合后的文件（last-wins） */
  leaves: FileLeaf[];
  /** 贡献了文件的提交（去重，保持入参顺序） */
  shas: string[];
}

/**
 * 多记录聚合的第一层：按仓库分组，再在仓库内做 last-wins 聚合。
 *
 * 为什么不跨仓库合成一棵树：同一相对路径在两个仓库里是两个不同的文件，
 * 合并成一行会让「19 个文件」这种数字凭空变小——IDEA 在多仓库工作区里也是按仓库分组的。
 */
export function groupCommitFilesByRepo(commits: readonly RepoCommitFiles[]): RepoFileGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, { label: string; list: CommitFilesPayload[] }>();
  for (const c of commits) {
    if (!buckets.has(c.repoKey)) {
      order.push(c.repoKey);
      buckets.set(c.repoKey, { label: c.repoLabel, list: [] });
    }
    buckets.get(c.repoKey)!.list.push({ sha: c.sha, date: c.date, files: c.files });
  }
  return order.map((repoKey) => {
    const bucket = buckets.get(repoKey)!;
    const leaves = aggregateCommitFiles(bucket.list);
    const shas: string[] = [];
    for (const l of leaves) for (const s of l.shas) if (!shas.includes(s)) shas.push(s);
    return { repoKey, repoLabel: bucket.label, leaves, shas };
  });
}

/** Base 对比的一行 */
export interface FileSetCompareRow {
  path: string;
  status: GitFileStatus;
  /** 基准记录里的状态；null = 基准里没有这个文件 */
  baseStatus: GitFileStatus | null;
  kind: 'only-base' | 'only-others' | 'both-same' | 'both-different';
}

/**
 * Base 记录对比：把「基准那一条」的文件集与「其余选中记录」的并集做集合比对。
 *
 * 三组语义（界面文案按这三组分栏）：
 *  - `only-base`：只有基准改过 → 其余记录没碰它；
 *  - `only-others`：其余记录改过、基准没碰；
 *  - `both-*`：两边都碰过，再看状态是否一致（`both-different` 才值得看一眼）。
 *
 * 这是**文件集对比**，不是内容 diff：只凭每条提交的 name-status/numstat 就能给结论，
 * 不需要再多取一次 `git diff` 全文，也不会把「两边都改了但改的行不一样」说成「相同」。
 */
export function compareFileSets(
  base: readonly CommitFileEntry[],
  others: readonly CommitFileEntry[],
): FileSetCompareRow[] {
  const baseMap = new Map(base.map((f) => [f.path, f.status] as const));
  const otherMap = new Map(others.map((f) => [f.path, f.status] as const));
  const rows: FileSetCompareRow[] = [];
  for (const [path, baseStatus] of baseMap) {
    const otherStatus = otherMap.get(path);
    if (otherStatus === undefined) rows.push({ path, status: baseStatus, baseStatus, kind: 'only-base' });
    else rows.push({
      path, status: otherStatus, baseStatus,
      kind: otherStatus === baseStatus ? 'both-same' : 'both-different',
    });
  }
  for (const [path, otherStatus] of otherMap) {
    if (baseMap.has(path)) continue;
    rows.push({ path, status: otherStatus, baseStatus: null, kind: 'only-others' });
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/* ------------------------------------------------------------------ *
 * 虚拟滚动切片
 * ------------------------------------------------------------------ */

export interface WindowSlice {
  /** 渲染区间 [start, end) */
  start: number;
  end: number;
  /** 上下占位高度（px）：撑住滚动条，位置正确才不会跳动 */
  padTop: number;
  padBottom: number;
}

/** 虚拟滚动的阈值：低于此直接全量渲染（DOM 更简单，也便于 UI 门按文本断言） */
export const FILE_TREE_VIRTUAL_THRESHOLD = 400;
/** 行高基准：须与渲染时用的 `--gt-row-h` 数值一致（默认档 22px，见 gitTreeTheme） */
export const FILE_TREE_ROW_H = 22;
/** 视窗外多渲染几行，滚动时避免白屏 */
export const FILE_TREE_OVERSCAN = 12;

/**
 * 按滚动位置算可视窗口。
 *
 * `viewportH <= 0`（尚未测量）时返回整段：首帧渲染全部会让长列表卡一下，但比「先渲染 0 行、
 * 量完再补」更稳——后者在某些浏览器里量到的高度是 0，于是永远停在空白。
 */
export function windowSlice(
  total: number,
  scrollTop: number,
  viewportH: number,
  rowH = FILE_TREE_ROW_H,
  overscan = FILE_TREE_OVERSCAN,
): WindowSlice {
  if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  if (!(viewportH > 0) || !(rowH > 0)) return { start: 0, end: total, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowH) - overscan);
  const visible = Math.ceil(viewportH / rowH) + overscan * 2;
  const end = Math.min(total, first + visible);
  return { start: first, end, padTop: first * rowH, padBottom: Math.max(0, (total - end) * rowH) };
}

/** 路径列显示：过长时保留头尾（`a/b/…/x/y.ts`），中间省略而不是砍掉文件名 */
export function ellipsisPath(path: string, max = 64): string {
  if (path.length <= max) return path;
  const segs = path.split('/');
  const base = segs[segs.length - 1] ?? path;
  const head = segs[0] ?? '';
  const keep = max - base.length - 4; // 4 = `…` 两侧的 `/`
  if (keep <= 1) return `…/${base}`.slice(0, max);
  return `${head}/${keep > 1 ? '…' : ''}${(segs[1] ?? '').slice(0, keep)}/${base}`.slice(0, max);
}
