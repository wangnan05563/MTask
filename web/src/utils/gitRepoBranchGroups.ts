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
import type { BranchOption } from './scopeControls';

/**
 * 归一化分支名（同名聚合的键）：tag 不参与；远端跟踪引用去掉最前面的远端名一段。
 *
 * T04552 起服务端按真实 refname 前缀定性（`refs/heads/` / `refs/remotes/` / `refs/tags/`），
 * `ref.type` 就是可信来源，这里不再按「削完是否真有其名」反推：
 *  - `branch` 原样返回，包括字面名叫 `origin/x` 的本地分支（`refs/heads/origin/x`）；
 *  - `remote` 只削首段（`origin/release/2.3` → `release/2.3`）；
 *  - `origin/HEAD` 是符号引用、不是一条真分支，不成组。
 * 视图层只按名字聚合，**不判断同源**，组内始终带工作空间路径可核对（方案 §9 风险 1）。
 */
export function branchNameOf(ref: GitRefName): string | null {
  if (ref.type === 'tag') return null;
  const name = ref.name;
  if (!name) return null;
  if (ref.type === 'branch') return name;
  const slash = name.indexOf('/');
  if (slash < 0) return name;
  const stripped = name.slice(slash + 1);
  return !stripped || stripped === 'HEAD' ? null : stripped;
}

/** 一个仓库（= 一个 git 工作树）在该分支视图里的归属行输入 */
export interface RepoBranchInput {
  projectId: string;
  projectName: string;
  workspacePath: string;
  /**
   * T04525：仓库相对工作空间目录的路径（POSIX，'' = 工作空间根仓库）。
   * 「一个项目 = 一个仓库」是本需求修订前的隐含假设；同一目录里装着 7 个子仓库时，
   * 只靠 projectId 会让 8 份引用清单互相覆盖，所以每一行都必须带这个坐标。
   */
  repoSub?: string;
  /** 该仓库 `/git/log?all=1` 首页回传的引用清单；取数失败时传空数组 */
  refs: GitRefName[];
  /** `/git/log` 回包 ok 且未抛异常 */
  available: boolean;
  /** 不可用时的一句话原因（服务端 `error.message` 或本地判定） */
  unavailableReason?: string;
}

export type RepoRowStatus = 'current' | 'spare' | 'unbound' | 'unavailable';

/**
 * 仓库一行的稳定身份：`项目 + 目录内相对路径`。
 *
 * 单独成函数的原因：paneKey、勾选、折叠状态、确认回传全都要按仓库算，
 * 任何一处漏掉 `repoSub` 就会把根仓库的窗口当成子仓库的（同名分支下必然撞上）。
 */
export function repoKeyOf(projectId: string, repoSub?: string): string {
  return `${projectId}\u0000${(repoSub ?? '').trim()}`;
}

/** 仓库展示路径：工作空间根原样，子仓库补相对段（只用于显示，取数仍用两段字段） */
export function repoPathOf(workspacePath: string, repoSub?: string): string {
  const sub = (repoSub ?? '').trim();
  if (!sub) return workspacePath;
  return `${workspacePath.replace(/[\\/]+$/, '')}/${sub}`;
}

/** 引用普查的并发上限（方案 §3.2 建议 3）：一次普查每仓要 fork 两条 git 命令，不该同时全开 */
export const REPO_SCAN_CONCURRENCY = 3;

export interface RepoBranchRow {
  /** 仓库身份（`repoKeyOf`）：跨分支组、勾选、折叠状态一律按它算 */
  repoKey: string;
  projectId: string;
  projectName: string;
  /** T04525：仓库相对工作空间目录的路径；'' = 根仓库 */
  repoSub: string;
  /** 展示用仓库名：默认项目名，同名项目或子仓库补路径段 */
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
 * 仓库展示名：根仓库取 `Project.name`（同名项目再补工作空间末段目录名）；
 * 同一目录里的子仓库一律带上相对路径（`项目名 · served`）——否则 8 行同名的「项目 A」
 * 正是这次验收失败要消灭的东西。
 */
export function repoLabelOf(input: RepoBranchInput, nameCounts: Map<string, number>): string {
  const base = input.projectName || input.projectId;
  const sub = (input.repoSub ?? '').trim();
  if (sub) return `${base} · ${sub}`;
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
  const nameCounts = projectNameCounts(inputs);
  const byBranch = new Map<string, RepoBranchGroup>();
  for (const input of inputs) {
    const branches = new Set<string>();
    for (const ref of input.refs) {
      const name = branchNameOf(ref);
      if (name) branches.add(name);
    }
    const status = rowStatusOf(input, activeProjectId);
    const available = status === 'current' || status === 'spare';
    const repoKey = repoKeyOf(input.projectId, input.repoSub);
    for (const branchName of branches) {
      const group = byBranch.get(branchName) ?? {
        branchKey: branchName, branchName, repos: [], repoCount: 0, totalCommits: null,
      };
      if (group.repos.some((r) => r.repoKey === repoKey)) continue;
      group.repos.push({
        repoKey,
        projectId: input.projectId,
        projectName: input.projectName,
        repoSub: (input.repoSub ?? '').trim(),
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

/** T04583：分支聚合按「当前项目工作空间」收窄普查输入。buildRepoBranchGroups 的 activeProjectId
 *  只改状态/排序/展开、从不剔除别的项目的分支，跨工作空间时过滤形同虚设（返回所有项目的所有分支）。
 *  这里先按工作空间路径过滤再归组：同一目录的根仓库+子仓库（repoSub）照旧保留，别的工作空间不误召回。
 *  路径归一化分隔符/尾斜杠/大小写（Windows 不区分大小写）；当前项目未绑定则仅留自身行，找不到则原样返回。 */
export function inputsForActiveWorkspace(inputs: readonly RepoBranchInput[], activeProjectId: string): RepoBranchInput[] {
  const active = inputs.find((i) => i.projectId === activeProjectId);
  if (!active) return [...inputs];
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const ws = norm(active.workspacePath ?? '');
  if (!ws) return inputs.filter((i) => i.projectId === activeProjectId);
  return inputs.filter((i) => norm(i.workspacePath ?? '') === ws);
}

/**
 * T04584：把普查输入折算成「起点分支」输入框的候选列表。
 *
 * 单仓库形态的 head 输入框过去只拿根仓库的 refs，工作空间目录里的子仓库（banks/deploy…）分支
 * 根本不出现，用户无从按子仓库分支取数。这里只取**当前项目**的可用仓库（平铺取数按 projectId+repoSub
 * 定位，别的项目的仓库平铺视图取不到，不该混进候选）：根仓库候选不带标注（外观与改造前一致），
 * 子仓库候选带 repoSub + repoLabel，同名分支跨仓库由 filterBranches 按 type:name:repoSub 区分、不互相覆盖。
 * 顺序：根仓库在前，其余子仓库按相对路径字典序。引用名用原始 ref.name（取数时直接当 head 用）。
 */
export function branchOptionsFromCensus(inputs: readonly RepoBranchInput[], activeProjectId: string): BranchOption[] {
  const mine = inputs
    .filter((i) => i.projectId === activeProjectId && i.available)
    .sort((a, b) => ((a.repoSub ?? '') ? 1 : 0) - ((b.repoSub ?? '') ? 1 : 0)
      || (a.repoSub ?? '').localeCompare(b.repoSub ?? ''));
  const out: BranchOption[] = [];
  for (const input of mine) {
    const sub = (input.repoSub ?? '').trim();
    const repoLabel = sub ? `${input.projectName || input.projectId} · ${sub}` : undefined;
    for (const ref of input.refs) {
      out.push({ type: ref.type, name: ref.name, repoSub: sub, repoLabel });
    }
  }
  return out;
}

/**
 * 项目名出现次数——**按项目去重后**统计，不是按仓库行统计。
 *
 * 一个装着 8 个子仓库的项目如果按行算，`nameCounts` 会把它判成「同名项目」，
 * 于是根仓库莫名其妙多出「· 目录名」后缀，真正需要同名区分的场景反而被淹没。
 */
function projectNameCounts(inputs: readonly RepoBranchInput[]): Map<string, number> {
  const seenProject = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const input of inputs) {
    if (seenProject.has(input.projectId)) continue;
    seenProject.set(input.projectId, input.projectName);
    const key = input.projectName || input.projectId;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
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
  const nameCounts = projectNameCounts(inputs);
  return inputs
    .filter((input) => !input.available || !input.workspacePath.trim())
    .map((input) => {
      const status = rowStatusOf(input, activeProjectId);
      return {
        repoKey: repoKeyOf(input.projectId, input.repoSub),
        projectId: input.projectId,
        projectName: input.projectName,
        repoSub: (input.repoSub ?? '').trim(),
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
 *
 * 入参是 `repoKeyOf` 产出的仓库身份而不是裸 projectId：T04525 之后同一项目的根仓库与子仓库
 * 是两个独立窗口，用裸 projectId 会让它们共用一份提交数。
 */
export function paneKeyOf(repoKey: string, branchName: string): string {
  return `${branchName}\n${repoKey}`;
}

/** 把懒加载回来的提交数写回分组（不改分组结构，只补 `commitCount` 与 `totalCommits`） */
export function applyCommitCounts(groups: RepoBranchGroup[], countsByPane: Record<string, number>): RepoBranchGroup[] {
  return groups.map((group) => {
    let total: number | null = null;
    const repos = group.repos.map((row) => {
      const count = countsByPane[paneKeyOf(row.repoKey, group.branchName)];
      if (count == null) return row;
      total = (total ?? 0) + count;
      return { ...row, commitCount: count };
    });
    return { ...group, repos, totalCommits: total };
  });
}

/**
 * 默认展开的分支组上限。
 *
 * T04525 实测打回点在「展开组数」而不是「组内仓库数」：一个工作空间目录里 8 个仓库 × 全部分支组
 * 会一次性铺出 200 多个待取数窗口（每个窗口一次 git 取数），弹窗卡死、门也等不到结果。
 * 分组按「同名仓库数」降序，所以前几组正是最需要横向对比的那几条分支；其余组保持折叠，
 * 用户点开时才取数。
 */
export const DEFAULT_OPEN_BRANCH_GROUPS = 3;

/** 分支组默认展开：同名分支组里含当前项目的那些（承接用户在范围层选的上下文），其余折叠，最多 `DEFAULT_OPEN_BRANCH_GROUPS` 组 */
export function defaultExpandedBranches(groups: RepoBranchGroup[], activeProjectId: string): string[] {
  return sharedBranchGroups(groups)
    .filter((g) => g.repos.some((r) => r.projectId === activeProjectId && r.available))
    .slice(0, DEFAULT_OPEN_BRANCH_GROUPS)
    .map((g) => g.branchKey);
}

/**
 * 仓库行默认展开：一个分支组里默认展开**当前项目的全部仓库**（根仓库 + 它工作空间目录里的子仓库）。
 *
 * T04525 的需求原话就是「`D:\code\QJ\BEMP5.0DEV` 下有 master 与 feature/hnnxbank/dev，
 * 还有 adapter/banks/deploy/served… 多个仓库」——只默认展开根仓库的话，
 * 用户第一屏看到的仍是「一个仓库」，与验收失败前没有区别。
 * 返回值是 `repoKeyOf` 口径（调用方直接拿去填 `openRepos`）。
 */
export function defaultExpandedRepos(group: RepoBranchGroup, activeProjectId: string): string[] {
  return group.repos.filter((r) => r.projectId === activeProjectId && r.available).map((r) => r.repoKey);
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
  const matches = refs.filter((r) => branchNameOf(r) === branchName);
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
  project: { id: string; name: string; workspacePath?: string | null; repoSub?: string },
  settled: PromiseSettledResult<{ refs?: GitRefName[]; workspacePath?: string }>,
): RepoBranchInput {
  const workspacePath = (project.workspacePath ?? '').trim();
  const repoSub = (project.repoSub ?? '').trim();
  if (!workspacePath) {
    return { projectId: project.id, projectName: project.name, workspacePath: '', repoSub, refs: [], available: false, unavailableReason: '该项目未绑定工作空间，无法取 Git 数据' };
  }
  if (settled.status === 'rejected') {
    return { projectId: project.id, projectName: project.name, workspacePath, repoSub, refs: [], available: false, unavailableReason: String(settled.reason ?? '') || 'Git 取数失败' };
  }
  const value = settled.value ?? {};
  return {
    projectId: project.id,
    projectName: project.name,
    workspacePath: value.workspacePath ?? workspacePath,
    repoSub,
    refs: value.refs ?? [],
    available: true,
  };
}

/** 普查要扫描的一个仓库（一个项目展开成它工作空间目录里的 N 个仓库） */
export interface RepoScanTarget {
  projectId: string;
  projectName: string;
  workspacePath: string;
  repoSub: string;
}

/** `/git/repos` 回包形状（只取普查要用的字段） */
export interface RepoListResult {
  ok: boolean;
  repos?: { subPath?: string }[];
  workspacePath?: string;
  error?: { kind?: string; message?: string };
}

/**
 * 把「逐项目的 `/git/repos` 结果」折算成普查扫描目标。
 *
 * 三条判据都有人踩过：
 *  1. 未绑定工作空间的项目**不 fork 任何请求**（直接给一条 `repoSub=''` 的死行，由 `repoInputFromScan` 判原因）；
 *  2. `/git/repos` 失败或返回空清单 → 回落到「根仓库一条」，让下游 `/git/log` 去给那句真正的错误，
 *     不在这里发明第二套错误文案；
 *  3. 成功时**根仓库也在清单里**（服务端已把 `subPath:''` 排第一），前端不再自行补一条，
 *     否则根仓库会在分组里出现两行。
 */
export function censusTargetsFromRepoLists(
  projects: readonly { id: string; name: string; workspacePath?: string | null }[],
  repoLists: readonly (PromiseSettledResult<RepoListResult> | undefined)[],
): RepoScanTarget[] {
  const out: RepoScanTarget[] = [];
  projects.forEach((project, index) => {
    const workspacePath = (project.workspacePath ?? '').trim();
    if (!workspacePath) {
      out.push({ projectId: project.id, projectName: project.name, workspacePath: '', repoSub: '' });
      return;
    }
    const settled = repoLists[index];
    const list = settled?.status === 'fulfilled' ? settled.value : undefined;
    const subs = list?.ok && list.repos?.length
      ? list.repos.map((r) => (r.subPath ?? '').trim())
      : [''];
    for (const repoSub of subs) {
      out.push({ projectId: project.id, projectName: project.name, workspacePath, repoSub });
    }
  });
  return out;
}

/** 一份「仓库维度」的勾选：确认阶段要按仓库回传，所以身份、归属项目、相对路径三者必须一起带 */
export interface RepoSelection {
  repoKey: string;
  projectId: string;
  repoSub: string;
  shas: string[];
}

/**
 * 把各「仓库 × 分支」窗口的勾选并成**按仓库**一份：同一仓库的两条分支共享历史，
 * 同一个 SHA 会被两个窗口各勾选一次，不去重就会数两遍（范围层拿到的条数与界面显示的「已选」不一致）。
 * 顺序按首次出现保留，便于用户看到自己勾选的先后。
 */
export function mergePaneSelections(
  panes: readonly { repoKey: string; projectId: string; repoSub?: string; shas: readonly string[] }[],
): Record<string, RepoSelection> {
  const out: Record<string, RepoSelection> = {};
  const seen: Record<string, Set<string>> = {};
  for (const pane of panes) {
    if (!pane.repoKey) continue;
    const entry = out[pane.repoKey] ??= { repoKey: pane.repoKey, projectId: pane.projectId, repoSub: (pane.repoSub ?? '').trim(), shas: [] };
    const done = seen[pane.repoKey] ??= new Set<string>();
    for (const sha of pane.shas) {
      if (!sha || done.has(sha)) continue;
      done.add(sha);
      entry.shas.push(sha);
    }
  }
  return out;
}

export type ConfirmOutcome =
  | { ok: true; projectId: string; repoSub: string; shas: string[] }
  | { ok: false; code: 'empty'; repoKeys: string[] }
  /** 多个仓库都有勾选：现有执行链路按单一仓库跑，前端不许伪合并 */
  | { ok: false; code: 'multi'; repoKeys: string[] };

/**
 * 确认阶段的唯一口径：一次只回传**一个仓库**的 SHA 集合。
 * 只有一份勾选时原样回传（含该仓库的 `repoSub`，否则子仓库的选择会在下游被当成根仓库的）；
 * 多份勾选直接拒——「让用户挑一个仓库再确认」比「静默丢掉其他仓库的选择」诚实。
 */
export function resolveRepoConfirmation(selectionByRepo: Record<string, RepoSelection>): ConfirmOutcome {
  const filled = Object.keys(selectionByRepo).filter((key) => (selectionByRepo[key]?.shas.length ?? 0) > 0);
  if (filled.length === 0) return { ok: false, code: 'empty', repoKeys: [] };
  if (filled.length > 1) return { ok: false, code: 'multi', repoKeys: filled };
  const picked = selectionByRepo[filled[0]];
  return { ok: true, projectId: picked.projectId, repoSub: picked.repoSub, shas: [...picked.shas] };
}
