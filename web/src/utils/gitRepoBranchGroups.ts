/**
 * T04527（方案见 `docs/T04525-Git视图同一分支多仓库展示区分方案.md`）：
 * Git 视图「同一分支 → 多个仓库」的**纯视图层函数**。
 *
 * 为什么单独成模块（与 `gitTreeSelect.ts` 同族理由）：弹窗是 DOM 密集交互，分组/归一化/折叠
 * 这些判据若写在组件里只能靠真浏览器断言；抽出来后「同名分支聚合、失败仓库不许隐身、
 * 一次确认只回传一个仓库」这些**会撒谎就得被发现的**边界，先在 node 门里钉住。
 *
 * 三条不可让的边界（方案 §9 风险清单落到代码）：
 *  1. **同名不等于同源**：只按分支名聚合，函数不产出任何「两个仓库是同一份代码」的判断；
 *  2. **失败仓库保留可见行**：未绑定工作空间 / 非仓库 / 取数失败的仓库仍然成行，带一句话原因，
 *     绝不静默丢行——丢行会让用户以为「这个仓库没有这条分支」，与「取不到」是两回事；
 *  3. **不制造不可执行的假合并**：确认阶段一次只回传一个仓库的 SHA 集合，多仓库有选则直接拒绝。
 */
import type { GitRefName } from './gitTreeSelect';

/**
 * 归一化分支名（同名聚合的键）：tag 不参与；`<remote>/<branch>` 去掉最前面的远端段。
 *
 * 「是不是远端段」不能只看 `ref.type`：服务端 `parseRefDecorate`（`gitCollect.ts:1683`）把 `%D` 里
 * **一切带斜杠的名字**都标成 `remote`，于是本地分支 `release/2.3`、`solo/only-in-alpha` 也被标成远端。
 * 照段数削会把它们变成 `2.3`、`only-in-alpha`——既读不懂，也可能把两条根本不同的分支并进同一组。
 * 因此用两条判据认定「这一段是远端名」，命中才削：
 *  1. 削完剩下的名字在本仓库的引用里**真有其名**（`origin/main` ←→ 本地 `main`，最常见）；
 *  2. 前一段是本仓库某个 `<前缀>/HEAD` 的前缀（clone/fetch 会为真远端建 `origin/HEAD` 符号引用），
 *     或属于 git 约定的远端名 `origin`/`upstream`——这条兜管住「只 fetch 没 checkout」的仓库：
 *     它只有 `origin/release/2.3`，若按判据 1 会被当成一条名叫 `origin/release/2.3` 的分支，
 *     于是明明同名的两个仓库聚不到一组。
 * 已知残余误差（都只剩「本地分支名恰好以 origin/ 或 upstream/ 开头」这一种形状）：会被当成远端跟踪引用削段。
 * 视图层只按名字聚合，**不判断同源**，组内始终带工作空间路径可核对（方案 §9 风险 1）。
 */
export function branchNameOf(ref: GitRefName, siblingRefNames?: ReadonlySet<string>): string | null {
  if (ref.type === 'tag') return null;
  const name = ref.name;
  if (!name) return null;
  const slash = name.indexOf('/');
  if (slash < 0) return name;
  const stripped = name.slice(slash + 1);
  // origin/HEAD 是符号引用，不是一条真分支，不参与聚合
  if (!stripped || stripped === 'HEAD') return null;
  if (!siblingRefNames) return name;
  if (siblingRefNames.has(stripped)) return stripped;
  const prefix = name.slice(0, slash);
  if (KNOWN_REMOTE_NAMES.has(prefix) || siblingRefNames.has(`${prefix}/HEAD`)) return stripped;
  return name;
}

/** git 初始化远端时的默认名（`git clone` 只有 `origin`，`git remote add upstream` 是社区约定） */
const KNOWN_REMOTE_NAMES = new Set(['origin', 'upstream']);

/** 该仓库全部引用名（供 `branchNameOf` 判「削段后是否真有其名」） */
export function refNameSet(refs: readonly GitRefName[]): Set<string> {
  return new Set(refs.map((r) => r.name));
}

/** 一个仓库（= 一个 MTask 项目工作空间）在该分支视图里的归属行输入 */
export interface RepoBranchInput {
  projectId: string;
  projectName: string;
  workspacePath: string;
  /** 该仓库 `/git/log?all=1` 首页回传的引用清单；取数失败时传空数组 */
  refs: GitRefName[];
  /** `/git/log` 回包 ok 且未抛异常 */
  available: boolean;
  /** 不可用时的一句话原因（服务端 `error.message` 或本地判定） */
  unavailableReason?: string;
}

export type RepoRowStatus = 'current' | 'spare' | 'unbound' | 'unavailable';

/** 引用普查的并发上限（方案 §3.2 建议 3）：一次普查每仓要 fork 两条 git 命令，不该同时全开 */
export const REPO_SCAN_CONCURRENCY = 3;

export interface RepoBranchRow {
  projectId: string;
  projectName: string;
  /** 展示用仓库名：默认项目名，同名项目补工作空间末段目录名 */
  repoLabel: string;
  workspacePath: string;
  status: RepoRowStatus;
  available: boolean;
  unavailableReason: string;
  /** 本仓库该分支的可见提交数；未懒加载前为 null（只作引导，不承诺历史全量） */
  commitCount: number | null;
}

export interface RepoBranchGroup {
  branchKey: string;
  branchName: string;
  /** 含不可用仓库在内的全部仓库行（顺序：当前项目 → 可用 → 不可用，再按仓库名） */
  repos: RepoBranchRow[];
  /** 参与同名的**可用**仓库数（分支 chip 上的数字） */
  repoCount: number;
  /** 已展开仓库的提交数之和；一个都没加载时为 null */
  totalCommits: number | null;
}

/** 取工作空间路径的最后一段目录名（用于区分同名项目）；空路径回空串 */
function lastSegmentOf(workspacePath: string): string {
  const parts = workspacePath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * 仓库展示名：默认 `Project.name`；项目名重复（同名项目指向不同工作空间）时补工作空间末段目录名，
 * 保证「一眼能判断这一行是哪个仓库」——这正是本方案要解决的问题本身。
 */
export function repoLabelOf(input: RepoBranchInput, nameCounts: Map<string, number>): string {
  const base = input.projectName || input.projectId;
  const duplicated = (nameCounts.get(base) ?? 0) > 1;
  const tail = lastSegmentOf(input.workspacePath);
  if (!duplicated || !tail || tail === base) return base;
  return `${base} · ${tail}`;
}

/** 单仓库行状态判定（顺序即优先级：取数失败 > 未绑定 > 当前 > 备用） */
function rowStatusOf(input: RepoBranchInput, activeProjectId: string): RepoRowStatus {
  if (!input.available) return 'unavailable';
  if (!input.workspacePath.trim()) return 'unbound';
  if (activeProjectId && input.projectId === activeProjectId) return 'current';
  return 'spare';
}

/**
 * 按归一化分支名聚合多个仓库：`分支 → 仓库[]`。
 *
 * 只保留**至少有 1 个可用仓库**的分支组（全不可用的分支不配占一个组位），
 * 但同一组内的不可用仓库仍然保留成行——两件事不冲突，判据见 `## 边界 2`。
 */
export function buildRepoBranchGroups(inputs: RepoBranchInput[], activeProjectId = ''): RepoBranchGroup[] {
  const nameCounts = new Map<string, number>();
  for (const input of inputs) {
    const key = input.projectName || input.projectId;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const byBranch = new Map<string, RepoBranchGroup>();
  for (const input of inputs) {
    const branches = new Set<string>();
    const names = refNameSet(input.refs);
    for (const ref of input.refs) {
      const name = branchNameOf(ref, names);
      if (name) branches.add(name);
    }
    const status = rowStatusOf(input, activeProjectId);
    const available = status === 'current' || status === 'spare';
    for (const branchName of branches) {
      const group = byBranch.get(branchName) ?? {
        branchKey: branchName, branchName, repos: [], repoCount: 0, totalCommits: null,
      };
      if (group.repos.some((r) => r.projectId === input.projectId)) continue;
      group.repos.push({
        projectId: input.projectId,
        projectName: input.projectName,
        repoLabel: repoLabelOf(input, nameCounts),
        workspacePath: input.workspacePath,
        status,
        available,
        unavailableReason: available ? '' : (input.unavailableReason ?? (status === 'unbound' ? '未绑定工作空间' : 'Git 取数失败')),
        commitCount: null,
      });
      if (available) group.repoCount += 1;
      byBranch.set(branchName, group);
    }
  }
  // 取数失败/未绑定的仓库即使一条分支都没取到，也要在「它自己应当出现的地方」露出来：
  // 它们不属于任何分支组，改由 blockedRepoRows 单独成行，故这里只收有可用仓库的组。
  const groups = [...byBranch.values()].filter((g) => g.repoCount > 0);
  for (const g of groups) {
    g.repos.sort((a, b) => {
      const rank = (r: RepoBranchRow) => (r.projectId === activeProjectId ? 0 : r.available ? 1 : 2);
      return rank(a) - rank(b) || a.repoLabel.localeCompare(b.repoLabel, 'zh-Hans-CN');
    });
  }
  // 同名最多的分支排前面（用户最关心的就是「这条分支到底在几个仓库里」），再按分支名稳定排序
  groups.sort((a, b) => b.repoCount - a.repoCount || a.branchName.localeCompare(b.branchName, 'zh-Hans-CN'));
  return groups;
}

/** 真正的「同一分支多仓库」组：至少 2 个可用仓库，才值得在视图上多一层折叠 */
export function sharedBranchGroups(groups: RepoBranchGroup[]): RepoBranchGroup[] {
  return groups.filter((g) => g.repoCount > 1);
}

/**
 * 取数失败 / 未绑定工作空间的仓库：它们没有 refs 可归组，但必须可见（方案 §4.3「未绑定/不可用」两行）。
 * 返回的顺序与入参一致，便于用户按项目下拉的顺序对上号。
 */
export function blockedRepoRows(inputs: RepoBranchInput[], activeProjectId = ''): RepoBranchRow[] {
  const nameCounts = new Map<string, number>();
  for (const input of inputs) {
    const key = input.projectName || input.projectId;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  return inputs
    .filter((input) => !input.available || !input.workspacePath.trim())
    .map((input) => {
      const status = rowStatusOf(input, activeProjectId);
      return {
        projectId: input.projectId,
        projectName: input.projectName,
        repoLabel: repoLabelOf(input, nameCounts),
        workspacePath: input.workspacePath,
        status,
        available: false,
        unavailableReason: status === 'unbound'
          ? '该项目未绑定工作空间，无法取 Git 数据'
          : (input.unavailableReason || 'Git 取数失败'),
        commitCount: null,
      };
    });
}

/**
 * 一个「仓库 × 分支」窗口的键：同一个仓库会出现在多个分支组里，各组的提交集合互不相干，
 * 所以懒加载结果不能只按 projectId 存（那样切分支组时会把上一个分支的提交数当成这个分支的）。
 */
export function paneKeyOf(projectId: string, branchName: string): string {
  return `${branchName}\n${projectId}`;
}

/** 把懒加载回来的提交数写回分组（不改分组结构，只补 `commitCount` 与 `totalCommits`） */
export function applyCommitCounts(groups: RepoBranchGroup[], countsByPane: Record<string, number>): RepoBranchGroup[] {
  return groups.map((group) => {
    let total: number | null = null;
    const repos = group.repos.map((row) => {
      const count = countsByPane[paneKeyOf(row.projectId, group.branchName)];
      if (count == null) return row;
      total = (total ?? 0) + count;
      return { ...row, commitCount: count };
    });
    return { ...group, repos, totalCommits: total };
  });
}

/** 分支组默认展开：同名分支组里含当前项目的那些（承接用户在范围层选的上下文），其余折叠 */
export function defaultExpandedBranches(groups: RepoBranchGroup[], activeProjectId: string): string[] {
  return sharedBranchGroups(groups)
    .filter((g) => g.repos.some((r) => r.projectId === activeProjectId && r.available))
    .map((g) => g.branchKey);
}

/** 仓库行默认展开：一个分支组里只默认展开当前项目对应的仓库，其余仓库点击才懒加载 */
export function defaultExpandedRepos(group: RepoBranchGroup, activeProjectId: string): string[] {
  const current = group.repos.find((r) => r.projectId === activeProjectId && r.available);
  return current ? [current.projectId] : [];
}

/**
 * 会话级折叠状态的数组增删（`useSessionState` 存的是可序列化数组，不用 Set）
 */
export function toggleKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

/**
 * 在某个仓库自己的引用清单里，找回「归一化分支名」对应的那个**原始引用名**。
 *
 * 为什么必须有：聚合视图里点的是 `release/2.3`，但该仓库可能只有 `origin/release/2.3`；
 * 把归一化名直接当 `head` 传给 `/git/log` 会取不到东西（而且看起来像「这仓库没这条分支」）。
 * 优先级：本地分支 > 远端引用（本地分支是可直接取数的稳定入口）。
 */
export function refNameForBranch(refs: GitRefName[], branchName: string): string | null {
  const names = refNameSet(refs);
  const matches = refs.filter((r) => branchNameOf(r, names) === branchName);
  // 本地分支优先：它是可直接取数的稳定入口；`origin/main` 只在本仓库没有本地同名分支时才用
  return matches.find((r) => r.type === 'branch')?.name ?? matches[0]?.name ?? null;
}

/**
 * 带并发上限的 `Promise.allSettled`（方案 §3.2 第 3、4 条）。
 *
 * 两条必须钉住的性质：**结果位置与入参一一对应**（顺序错了会把 A 仓库的提交挂到 B 仓库名下）；
 * **一项失败不拖别人**（一个仓库取数炸了，其它仓库的分组照旧显示）。上限存在的理由不是好看，
 * 是一次点开弹窗不该同时 fork 十几个 git 子进程。
 */
export async function mapSettledWithLimit<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<PromiseSettledResult<R>[]> {
  const out = new Array<PromiseSettledResult<R>>(items.length);
  const size = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        out[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (e) {
        // 记原因而不是记 Error 对象：调用方要把这句话直接渲染进「不可用」行
        out[index] = { status: 'rejected', reason: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: size }, () => worker()));
  return out;
}

/**
 * 把「单仓库引用扫描」的 settled 结果折算成分组输入——三种失败各有各的一句话：
 * 未绑定工作空间（根本不该 fork git）、取数被服务端拒（`ok:false`）、网络/进程异常（reject）。
 * 抽成纯函数的原因：这三句区别是验收点 5 的全部内容，写在 `await` 旁边就只能靠真浏览器才能验证。
 */
export function repoInputFromScan(
  project: { id: string; name: string; workspacePath?: string | null },
  settled: PromiseSettledResult<{ refs?: GitRefName[]; workspacePath?: string }>,
): RepoBranchInput {
  const workspacePath = (project.workspacePath ?? '').trim();
  if (!workspacePath) {
    return { projectId: project.id, projectName: project.name, workspacePath: '', refs: [], available: false, unavailableReason: '该项目未绑定工作空间，无法取 Git 数据' };
  }
  if (settled.status === 'rejected') {
    return { projectId: project.id, projectName: project.name, workspacePath, refs: [], available: false, unavailableReason: String(settled.reason ?? '') || 'Git 取数失败' };
  }
  const value = settled.value ?? {};
  return {
    projectId: project.id,
    projectName: project.name,
    workspacePath: value.workspacePath ?? workspacePath,
    refs: value.refs ?? [],
    available: true,
  };
}

/**
 * 把各「仓库 × 分支」窗口的勾选并成**按仓库**一份：同一仓库的两条分支共享历史，
 * 同一个 SHA 会被两个窗口各勾选一次，不去重就会数两遍（范围层拿到的条数与界面显示的「已选」不一致）。
 * 顺序按首次出现保留，便于用户看到自己勾选的先后。
 */
export function mergePaneSelections(panes: readonly { projectId: string; shas: readonly string[] }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const pane of panes) {
    if (!pane.projectId) continue;
    const bucket = out[pane.projectId] ??= [];
    const done = seen[pane.projectId] ??= new Set<string>();
    for (const sha of pane.shas) {
      if (!sha || done.has(sha)) continue;
      done.add(sha);
      bucket.push(sha);
    }
  }
  return out;
}

export type ConfirmOutcome =
  | { ok: true; projectId: string; shas: string[] }
  | { ok: false; code: 'empty'; projectIds: string[] }
  /** 多个仓库都有勾选：现有执行链路按单一工作空间跑，前端不许伪合并 */
  | { ok: false; code: 'multi'; projectIds: string[] };

/**
 * 确认阶段的唯一口径：一次只回传**一个**仓库的 SHA 集合。
 * 只有一份勾选时原样回传；多份勾选直接拒——「让用户挑一个仓库再确认」比「静默丢掉其他仓库的选择」诚实。
 */
export function resolveRepoConfirmation(selectionByRepo: Record<string, string[]>): ConfirmOutcome {
  const filled = Object.keys(selectionByRepo).filter((id) => (selectionByRepo[id]?.length ?? 0) > 0);
  if (filled.length === 0) return { ok: false, code: 'empty', projectIds: [] };
  if (filled.length > 1) return { ok: false, code: 'multi', projectIds: filled };
  return { ok: true, projectId: filled[0], shas: [...selectionByRepo[filled[0]]] };
}
