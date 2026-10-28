/**
 * T03302：Git 树范围选择弹窗的**纯逻辑**（车道布局 + 点选语义 + 已选摘要）。
 *
 * 为什么单独成模块：弹窗是 DOM 密集交互（Shift 框选、Ctrl 加选、懒加载跨页选择），
 * 逻辑写在组件里就只能靠真浏览器断言；抽出来后台阶边界（跨页保持、去重、上限截断、
 * Shift 锚点失效、分叉车道不重叠）能先在 node 门里钉住，浏览器门只验「装配对不对」。
 *
 * 点选语义（T03326 起按「勾选式多选」）：
 *  - 单击 = 在已选集合里加/去这一条（行首有复选框，用户不会预期「点第二条就把第一条顶掉」）；
 *  - Ctrl/Cmd + 单击 = 同单击（保留 IDEA 习惯，不影响结果）；
 *  - Shift + 单击 = 从锚点到这一条的**可视连续段**（锚点为上一条单击/加选的条目）；
 *  - Shift + Ctrl = 在已选集合上再并上这段。
 *
 * T03326 前的语义是 IDEA 的「单击=只选这条」，缺陷单报告「不能多选」即由此而来：
 * 带复选框的列表里，无修饰键单击就替换整份选择，多选只能靠知道要按 Ctrl 的用户才能完成。
 */
/** 引用类型（与服务端 `gitCollect.GitRefName` 同形状；web 侧不 import server 模块，各自声明） */
export interface GitRefName {
  type: 'branch' | 'remote' | 'tag';
  name: string;
}

/** 弹窗一行（服务端 `lectureGitLog.GitLogCommit` 的前端镜像，字段刻意保持子集） */
export interface GitTreeCommit {
  sha: string;
  short: string;
  parents: string[];
  refs: GitRefName[];
  head: boolean;
  author: string;
  date: string;
  subject: string;
}

/** 与服务端 `gitCollect.MAX_SELECTED_COMMITS` 同值：前端拦一次给即时反馈，服务端仍是权威口径 */
export const MAX_SELECTED_COMMITS = 200;
/** 一页取多少条（懒加载步长） */
export const GIT_TREE_PAGE_SIZE = 100;

export interface LaneLayout {
  /** 与 commits 一一对应的车道号（0 起） */
  lanes: number[];
  /** 实际用到的车道数（渲染时据此画竖线） */
  count: number;
  /**
   * 每行「应当画线」的车道集合（含本行自己的车道）：
   * 弹窗按这个数组在行左侧画 `│` 与 `●`，不用自己去猜上下游连线。
   */
  through: number[][];
}

/**
 * 车道分配：一条车道「等」某个 SHA 出现，出现即接线；第一父沿用车道，其余父另开道，
 * 已被别的车道等的父不再重复开线（分叉汇合点）。
 *
 * 不做全局最优（IDEA 会回溯整段历史），但结果必须满足两条硬性质：
 * 同一行只有一个车道号、同一条边的两端不会落在两条不同车道上被同时占用。
 */
export function assignLanes(commits: readonly GitTreeCommit[]): LaneLayout {
  const lanes: (string | null)[] = [];
  const out: number[] = [];
  const through: number[][] = [];
  for (const c of commits) {
    let lane = lanes.indexOf(c.sha);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) { lanes.push(null); lane = lanes.length - 1; }
    }
    out.push(lane);
    lanes[lane] = null;
    let firstParentPlaced = false;
    for (const p of c.parents) {
      if (lanes.includes(p)) continue;
      if (!firstParentPlaced && c.parents[0] === p) {
        lanes[lane] = p;
        firstParentPlaced = true;
        continue;
      }
      let free = lanes.indexOf(null);
      if (free < 0) { lanes.push(null); free = lanes.length - 1; }
      lanes[free] = p;
    }
    through.push([...lanes.map((l, i) => (l !== null || i === lane ? i : -1)).filter((i) => i >= 0)]);
  }
  return { lanes: out, count: out.length === 0 ? 0 : Math.max(...out) + 1, through };
}

export interface SelectionMods {
  ctrl?: boolean;
  shift?: boolean;
}

export interface SelectionResult {
  /** 已选 SHA，保持「可视顺序（新→旧）」而不是点击顺序 */
  selected: string[];
  /** 下一次 Shift 框选的锚点（可视列表下标） */
  anchor: number;
  /** 因超过 {@link MAX_SELECTED_COMMITS} 被截断 */
  limited: number;
}

/** 超过上限时截断，并把截掉的条数报给调用方显示（不静默丢选择） */
function capSelected(selected: string[]): { list: string[]; limited: number } {
  return selected.length > MAX_SELECTED_COMMITS
    ? { list: selected.slice(0, MAX_SELECTED_COMMITS), limited: selected.length - MAX_SELECTED_COMMITS }
    : { list: selected, limited: 0 };
}

/** 单击/加选/Shift 框选的统一入口 */
export function selectAt(args: {
  commits: readonly GitTreeCommit[];
  selected: readonly string[];
  index: number;
  anchor: number | null;
  mods: SelectionMods;
}): SelectionResult {
  const { commits, selected, index, anchor, mods } = args;
  const target = commits[index];
  if (!target) return { selected: [...selected], anchor: anchor ?? index, limited: 0 };
  const current = new Set(selected);
  let next: string[];
  if (mods.shift && anchor !== null && anchor >= 0 && anchor < commits.length) {
    const from = Math.min(anchor, index);
    const to = Math.max(anchor, index);
    const span = commits.slice(from, to + 1).map((c) => c.sha);
    next = mods.ctrl ? [...selected, ...span.filter((s) => !current.has(s))] : span;
  } else {
    // T03326：无修饰键单击 = 勾选/取消这一条（不再替换整份选择）——多选不该要求用户先知道按 Ctrl
    next = current.has(target.sha) ? selected.filter((s) => s !== target.sha) : [...selected, target.sha];
  }
  const capped = capSelected(next);
  return { selected: orderSelected(commits, capped.list), anchor: index, limited: capped.limited };
}

/** 顺序化：按可视列表（新→旧）排，列表外的（例如换分支后残留）保留在尾部不静默丢 */
export function orderSelected(commits: readonly GitTreeCommit[], selected: readonly string[]): string[] {
  const rank = new Map(commits.map((c, i) => [c.sha, i] as const));
  const inList = selected.filter((s) => rank.has(s));
  const outside = selected.filter((s) => !rank.has(s));
  return [...new Set([...inList, ...outside])].sort((a, b) => (rank.get(a)! - rank.get(b)!));
}

/** 「全选本页 / 取消本页」 */
export function toggleVisible(commits: readonly GitTreeCommit[], selected: readonly string[], check: boolean): string[] {
  const set = new Set(selected);
  for (const c of commits) {
    if (check) set.add(c.sha); else set.delete(c.sha);
  }
  return orderSelected(commits, [...set]).slice(0, MAX_SELECTED_COMMITS);
}

/**
 * 已选摘要：段数（连续段合并后的 diff 次数）+ 时间跨度。
 *
 * 段数走的是服务端 `planCommitRuns` 的**同一套算法**（同排序、同「单父且父也被选中才并段」的
 * 向下走链、合并提交永远只当段头）：徽标上的「N 段」是在告诉用户「这会采几次区间 diff」，
 * 近似口径在时间戳异常的历史上会少报一段，两端就漂移了。
 * 唯一的已知局限：只看得见可视集里的父子关系，翻页范围外的父链看不到（服务端仍是权威口径）。
 */
export function summarizeSelection(commits: readonly GitTreeCommit[], selected: readonly string[]): {
  count: number; runs: number; newest: string; oldest: string;
} {
  const chosen = commits.filter((c) => selected.includes(c.sha));
  const bySha = new Map(chosen.map((c) => [c.sha, c] as const));
  const sorted = [...chosen].sort((a, b) => b.date.localeCompare(a.date) || b.sha.localeCompare(a.sha));
  const used = new Set<string>();
  let runs = 0;
  for (const start of sorted) {
    if (used.has(start.sha)) continue;
    used.add(start.sha);
    let oldest = start;
    while (oldest.parents.length === 1) {
      const next = bySha.get(oldest.parents[0]);
      if (!next || used.has(next.sha)) break;
      used.add(next.sha);
      oldest = next;
    }
    runs += 1;
  }
  const dates = chosen.map((c) => c.date).filter(Boolean).sort();
  return {
    count: selected.length,
    runs,
    newest: dates[dates.length - 1] ?? '',
    oldest: dates[0] ?? '',
  };
}

/** 徽标/摘要里的一行提交：`a1b2c3d 标题（作者）` */
export function commitLabel(c: GitTreeCommit): string {
  return `${c.short} ${c.subject}`;
}

/** 从提交装饰里聚合引用清单（按首次出现顺序；同一条分支只出现一次） */
export function groupByRef(commits: readonly GitTreeCommit[]): GitRefName[] {
  const seen = new Set<string>();
  const out: GitRefName[] = [];
  for (const c of commits) {
    for (const r of c.refs) {
      const key = `${r.type}:${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}
