import type { GitTreeCommit } from './gitTreeSelect';

/**
 * T04912：多仓库「按时间顺序混合显示」的纯函数层。
 *
 * 为什么单独抽一层：排序口径（Git 作者时间 %aI，带时区）、去重口径、以及「一次确认只回传
 * 一个仓库」的红线都要能被 node 门直接断言，而不是埋在 React effect 里靠肉眼走查。
 * 组件只负责并发取数与渲染，本模块不依赖 api / DOM / 服务端。
 */

/** 逐仓库取数结果折算成混合时间线的一条输入 */
export interface RepoTimelineInput {
  /** 相对工作空间目录的仓库坐标；'' = 根仓库。确认回传要用它，不能只留展示名 */
  readonly repoSub: string;
  /** 给用户看的来源名（子仓库=相对路径，根仓库=「根目录仓库 · 项目名」） */
  readonly repoLabel: string;
  readonly commits: readonly GitTreeCommit[];
}

/** 混合时间线里的一行：在原有 GitTreeCommit 上补两个来源字段，其余字段逐字保留 */
export type MixedCommit = GitTreeCommit & {
  readonly repoSub: string;
  readonly repoLabel: string;
};

/** 确认口径：与分组视图 `resolveRepoConfirmation` 同红线，跨仓库勾选一律拒 */
export type MixedConfirmation =
  | { readonly ok: true; readonly repoSub: string; readonly shas: string[] }
  | { readonly ok: false; readonly code: 'none' | 'multi' | 'missing'; readonly repoSubs: string[]; readonly missing: string[] };

/**
 * 严格按 commit 作者时间降序。服务端 `gitCollect` 用 `%aI`（ISO 8601 带时区），
 * 所以 `Date.parse` 能跨仓库正确比较，不需要按字符串字典序猜。
 * - 不可解析/缺失时间排末尾，不因为一条脏数据把整条时间线打乱；
 * - 同一时刻按 repoSub → sha → 原下标兜底，保证多次渲染顺序完全一致（确定性）。
 */
export function sortCommitsByDateDesc<T extends GitTreeCommit>(commits: readonly T[]): T[] {
  return commits
    .map((c, i) => ({ c, i, t: Date.parse(c?.date ?? '') }))
    .sort((a, b) => {
      const av = Number.isFinite(a.t) ? a.t : Number.NEGATIVE_INFINITY;
      const bv = Number.isFinite(b.t) ? b.t : Number.NEGATIVE_INFINITY;
      if (av !== bv) return bv - av;
      const ar = (a.c as { repoSub?: string }).repoSub ?? '';
      const br = (b.c as { repoSub?: string }).repoSub ?? '';
      if (ar !== br) return ar < br ? -1 : 1;
      if (a.c.sha !== b.c.sha) return a.c.sha < b.c.sha ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.c);
}

/** 逐仓库结果合并成一条混合时间线：按「仓库坐标 + SHA」去重（同一 SHA 落在不同仓库是不同实体） */
export function mergeRepoTimelines(inputs: readonly RepoTimelineInput[]): MixedCommit[] {
  const seen = new Set<string>();
  const out: MixedCommit[] = [];
  for (const input of inputs ?? []) {
    const sub = input?.repoSub ?? '';
    const label = input?.repoLabel || (sub || '根目录仓库');
    for (const c of input?.commits ?? []) {
      if (!c?.sha) continue;
      const key = `${sub}\u0000${c.sha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c, repoSub: sub, repoLabel: label });
    }
  }
  return sortCommitsByDateDesc(out);
}

/** 仓库来源标签：根仓库带上项目名以免所有根仓库都叫「根目录仓库」，子仓库直接用相对路径 */
export function repoLabelOf(repoSub: string, displayName: string, projectName: string): string {
  const sub = (repoSub ?? '').trim();
  if (sub) return sub;
  const name = (displayName ?? '').trim() || (projectName ?? '').trim();
  return name ? `根目录仓库 · ${name}` : '根目录仓库';
}

/**
 * 混合视图确认：一次确认只回传一个仓库。
 * - 跨仓库勾选 → multi（明确拒绝，不做假的跨仓库合并）；
 * - 所选 SHA 已不在当前可视集（翻页/搜索后）→ missing，要求重新取数，避免回传幽灵提交。
 */
export function resolveMixedConfirmation(
  commits: readonly { sha: string; repoSub?: string }[],
  selected: readonly string[],
): MixedConfirmation {
  const bySha = new Map<string, string[]>();
  for (const c of commits ?? []) {
    if (!c?.sha) continue;
    const subs = bySha.get(c.sha) ?? [];
    subs.push(c.repoSub ?? '');
    bySha.set(c.sha, subs);
  }
  const shas = [...(selected ?? [])];
  if (shas.length === 0) return { ok: false, code: 'none', repoSubs: [], missing: [] };
  const subs = new Set<string>();
  const missing: string[] = [];
  for (const sha of shas) {
    const hits = bySha.get(sha) ?? [];
    if (hits.length === 0) { missing.push(sha); continue; }
    for (const sub of hits) subs.add(sub);
  }
  const repoSubs = [...subs].sort();
  if (missing.length > 0 || repoSubs.length === 0) {
    return { ok: false, code: 'missing', repoSubs, missing };
  }
  if (repoSubs.length > 1) return { ok: false, code: 'multi', repoSubs, missing: [] };
  return { ok: true, repoSub: repoSubs[0], shas };
}
