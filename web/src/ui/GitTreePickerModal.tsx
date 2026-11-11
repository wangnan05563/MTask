import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom'; // T04913：标题 Tooltip 挂 body，绕开列表 overflow 裁剪
import { Check, ChevronDown, ChevronRight, FolderGit2, GitBranch, Loader2, Maximize2, RefreshCw, Search, Tag, X } from 'lucide-react'; // T03654：折叠箭头统一 lucide · T04527：仓库行用 FolderGit2 · T05556：全屏按钮用 Maximize2
import { api } from '../api/client';
import type { Project } from '../api/client';
import { fullTime, relTime } from '../ui/format';
import { PILL } from './primitives'; // PM-302 ① 单源（与 CodeReviewLecturePanel 原为逐字节相同的两份定义）
import { BranchPicker } from './GitScopeControls'; // T03590：head 输入框 → 可展开分支选择器
import { useSessionState } from './session'; // T04527：分支组/仓库折叠态跨重开保持（方案 §5.2）
import {
  GIT_TREE_PAGE_SIZE,
  MAX_SELECTED_COMMITS,
  assignLanes,
  groupByRef,
  orderSelected,
  selectAt,
  simplifyCommitRefs,
  summarizeSelection,
  toggleVisible,
  type GitRefName,
  type GitTreeCommit,
  type LaneLayout,
} from '../utils/gitTreeSelect';
import {
  REPO_SCAN_CONCURRENCY,
  applyCommitCounts,
  blockedRepoRows,
  branchNameOf,
  branchOptionsFromCensus,
  buildRepoBranchGroups,
  censusTargetsFromRepoLists,
  defaultExpandedBranches,
  defaultExpandedRepos,
  defaultRepoSub,
  repoChoicesFromRepoList,
  inputsForActiveWorkspace,
  localOnlyRefInputs,
  mapSettledWithLimit,
  mergePaneSelections,
  paneKeyOf,
  refNameForBranch,
  repoInputFromScan,
  repoKeyOf,
  repoPathOf,
  resolveRepoConfirmation,
  sharedBranchGroups,
  toggleKey,
  type RepoBranchGroup,
  type RepoBranchInput,
  type RepoBranchRow,
  type RepoChoice,
  type RepoListResult,
  type RepoScanTarget,
} from '../utils/gitRepoBranchGroups';
import { mergeRepoTimelines, repoLabelOf, resolveMixedConfirmation, type RepoTimelineInput } from '../utils/gitTimelineMerge'; // T04912：多仓库混合时间线纯函数层
import { shouldShowSubjectTooltip, subjectTooltipBox } from '../utils/gitSubjectTooltip'; // T04913：标题截断判据与浮层坐标
import type { BranchOption } from '../utils/scopeControls'; // T04584：起点分支候选（含子仓库 repoSub）
import { GitTreeFilePanel, RepoStripe, type DetailEntry } from './gitTreeFilePanel'; // T05210：IDEA 双栏 · 右栏文件树与摘要
import { GIT_TREE_STYLE, repoColorMap, repoColorVar } from './gitTreeTheme'; // T05210：Design Tokens 与仓库色单源

/** 聚合视图里「在途取数窗口」的并发预算：与普查同一口径，一个仓库多就一起多（T04525） */
const PANE_LOAD_INFLIGHT = REPO_SCAN_CONCURRENCY;
/**
 * T05063：「确认选择」点击动画时长。需求建议 200-300ms，取中值 250ms，
 * 与项目既有 `copy-pop .28s` / `toast-in .2s` / `sheet-up 220ms` 同一量级。
 */
const CONFIRM_ANIM_MS = 250;

/**
 * T03302：代码评审讲稿卡 · Git 树选范围弹窗（布局参照 JetBrains Git Log，点选按勾选式多选—T03326）。
 *
 * 为什么是弹窗：范围选择是一次「多步、可反悔」的动作（勾选、翻页、搜索、Shift 框选、跨页保持），
 * 铺在卡片里会把三区布局挤没；确认后才把 SHA 集合回传给卡片，卡片再按项目组装 `shape='commits'` 的范围。
 *
 * 三条不可让的边界：
 *  1. **取数失败 ≠ 没有提交**：未配工作空间 / 不是 git 仓库 / 没装 git / 网络异常各给一句话，
 *     列表空着但按钮禁用，避免用户以为「这仓没东西」；
 *  2. **跨页与搜索不丢选择**：已选 SHA 存在组件外的 `selectedByProject` 里，翻页/换分支只是改可视集；
 *  3. **上限由两端同口径把关**：前端截到 200 并说明被截条数，服务端 `normalizeSelectedCommits` 仍会拒。
 *
 * T04527 新增「分支聚合（多仓库）」视图（方案 `docs/T04525-Git视图同一分支多仓库展示区分方案.md`）：
 * 单仓库形态是缺省且逐字节不变——多一层折叠只在用户显式开启、或普查确认某分支真的跨了 ≥2 个仓库之后才出现；
 * 判据（归一化/聚合/失败仓库保留/确认口径）全部在 `utils/gitRepoBranchGroups.ts`，本文件只做渲染。
 *
 * 折叠交互的取舍：分支行不做「伪树折叠」（一个提交可以同时属于两条分支，藏起来会撒谎），
 * 而是点分支 = 按该分支为起点重新取数（等价于 IDEA 的 branch filter），提交行自身可展开看 SHA/父/作者/提交者。
 */

/** `POST /api/plans/code-review-lecture/git-log` 响应（服务端 lectureGitLog 的前端镜像） */
interface GitLogResponse {
  ok: boolean;
  projectId: string;
  projectName: string;
  workspacePath: string;
  commits: GitTreeCommit[];
  hasMore: boolean;
  skip: number;
  limit: number;
  scanned: number;
  scanTruncated: boolean;
  refs?: GitRefName[];
  repoSub?: string;
  error?: { kind: string; message: string };
}

const LANE_COLORS = ['var(--accent)', '#e0863a', '#3aa0e0', '#57b06a', '#b0579a', '#8a8f98'];

/**
 * T04527：分组视图里一个「仓库 × 分支」窗口的全部状态。
 * 勾选也放在窗口上（而不是散成另一个 map），是因为点选/Shift 框选的锚点必须与这份可视集同生共死。
 */
interface RepoPane {
  /** 仓库身份（`repoKeyOf`）：T04525 起一个项目可能有根仓库 + N 个子仓库，只按 projectId 认会串窗口 */
  repoKey: string;
  projectId: string;
  /** 仓库相对工作空间目录的路径；'' = 根仓库。取数与确认回传都要它 */
  repoSub: string;
  branchName: string;
  commits: GitTreeCommit[];
  loading: boolean;
  /** 至少成功取回过一次：决定分组头能不能显示提交数 */
  loaded: boolean;
  hasMore: boolean;
  error: string;
  selected: string[];
}

const emptyPane: RepoPane = { repoKey: '', projectId: '', repoSub: '', branchName: '', commits: [], loading: false, loaded: false, hasMore: false, error: '', selected: [] };

const boxStyle: React.CSSProperties = {
  fontSize: 'var(--fs-s)', padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)',
};
const chipStyle: React.CSSProperties = PILL; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
const FONT_MONO = 'Consolas, Menlo, monospace';

/** 组装 `GET /git/log` 的查询串（抽出来单放：条件拼装不占 `load` 的认知复杂度） */
function buildLogQuery(projectId: string, head: string, allBranches: boolean, search: string, skip: number, repoSub = ''): string {
  const qs = new URLSearchParams({ projectId, skip: String(skip), limit: String(GIT_TREE_PAGE_SIZE) });
  const trimmedHead = head.trim();
  if (!allBranches && trimmedHead) qs.set('head', trimmedHead);
  if (allBranches) qs.set('all', '1');
  const trimmedSearch = search.trim();
  if (trimmedSearch) qs.set('search', trimmedSearch);
  // T04525：子仓库靠这个参数定位；缺省（根仓库）不带参数，保证旧请求串逐字节不变
  const trimmedSub = repoSub.trim();
  if (trimmedSub) qs.set('repoSub', trimmedSub);
  return qs.toString();
}

/** 车道图的一格：本行自己的车道画 ●、贯穿本行的车道画 │、其余留白 */
function laneCell(lanes: LaneLayout, row: number, lane: number) {
  const color = LANE_COLORS[lane % LANE_COLORS.length];
  if (lanes.lanes[row] === lane) return <span key={lane} style={{ color }}>●</span>;
  if (lanes.through[row]?.includes(lane)) return <span key={lane} style={{ color }}>│</span>;
  return <span key={lane}> </span>;
}

export function GitTreePickerModal({ projects, activeProjectId, selectedByProject, initialRepoView = false, onConfirm, onClose, zIndex = 1000, targetLabel, targetQueue = 0 }: {
  readonly projects: Project[];
  readonly activeProjectId: string;
  /** 各项目已选 SHA（确认后由卡片写回；弹窗内改的是当前项目的这一份） */
  readonly selectedByProject: Record<string, string[]>;
  /** T04553：独立的多仓库入口直接落在聚合视图，省略时保持单仓库列表的既有默认 */
  readonly initialRepoView?: boolean;
  /** T04576：第三个参数是确认来自工作空间目录内的哪个仓库（空串 = 项目根仓库） */
  readonly onConfirm: (projectId: string, shas: string[], repoSub: string) => void;
  readonly onClose: () => void;
  /** 抽屉内打开时须高于 SlideOver（1100），否则弹窗被抽屉遮住（八期 §3.2.3） */
  readonly zIndex?: number;
  /**
   * T05078 / T05556：批量补录入口专用——明示本次「确认选择」会写入哪个任务。
   * 不传则完全不渲染（其余三个入口零影响）；根因是目标对用户不可见时，
   * 队列推进会让同一批勾选被误认为「还是刚才那个任务」。
   */
  readonly targetLabel?: string;
  /**
   * T05556：队列总条数。targetQueue>0 时 targetLabel 条额外显示「第 1/N 条」进度，
   * 让用户在弹窗里就知道还有几条待补录，不必靠 flash 消息。
   * 非批量补录入口不传（保持原样）。
   */
  readonly targetQueue?: number;
}) {
  const [projectId, setProjectId] = useState(activeProjectId || projects[0]?.id || '');
  const [head, setHead] = useState('');
  /** T04584：平铺视图当前取数的仓库（'' = 根仓库）。起点分支输入框选中子仓库候选时切到该 repoSub，
   *  load/confirm 都按它定位——否则选了 banks 的分支仍按根仓库取数，子目录分支永远查不到。 */
  const [flatRepoSub, setFlatRepoSub] = useState('');
  /** T04586 复验：默认平铺视图的仓库清单（打开弹窗即递归普查，不再只有切到分组视图才问 /git/repos） */
  const [repoChoices, setRepoChoices] = useState<RepoChoice[]>([]);
  const [repoListState, setRepoListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [repoListTruncated, setRepoListTruncated] = useState(false);
  /** T04912：平铺视图默认把工作空间内所有仓库混成一条时间线；关掉即回到 T04586 的单仓库口径 */
  const [mixRepos, setMixRepos] = useState(true);
  /** T04912：部分仓库取数失败的降级说明——不阻断其余仓库，也不伪装成「这个仓库没提交」 */
  const [mixedWarnings, setMixedWarnings] = useState<string[]>([]);
  /** T05063：确认按钮点击动画进行中（同时充当连点守卫） */
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  const [allBranches, setAllBranches] = useState(false);
  const [search, setSearch] = useState('');
  /** T04911：分组窗口懒加载时读「此刻」的搜索词（loadPane 不在 effect 依赖里，闭包会抓旧值） */
  const searchRef = useRef(search);
  searchRef.current = search;
  /** T04911：每个「仓库 × 分支」窗口的取数序号——连续搜索时旧请求晚到不得覆盖新结果 */
  const paneSeq = useRef<Record<string, number>>({});
  /** T04911：分组视图最近一次点搜索的关键词与重取数窗口数，用于给用户一句可见的刷新反馈 */
  const [groupedSearchTerm, setGroupedSearchTerm] = useState('');
  const [groupedSearchCount, setGroupedSearchCount] = useState(0);
  const [commits, setCommits] = useState<GitTreeCommit[]>([]);
  const [refs, setRefs] = useState<GitRefName[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>(selectedByProject[projectId] ?? []);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [foldRefs, setFoldRefs] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  /** T05556：全屏态。打开时弹窗铺满视口（不再限 90vh），Esc 先退出全屏、再按一次才关闭弹窗 */
  const [fullscreen, setFullscreen] = useState(false);
  /** T05556：左栏宽度百分比（默认 46，与 T05210 原布局一致；拖拽分隔线时动态更新） */
  const [leftPanePct, setLeftPanePct] = useState(75);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startPct: number } | null>(null);
  /** 拖拽分隔线：mousedown 起记录起点，window mousemove 实时算新百分比（20%~70% 钳制防布局崩坏） */
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startPct: leftPanePct };
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const deltaPct = ((ev.clientX - dragState.current.startX) / rect.width) * 100;
      const next = Math.min(90, Math.max(20, dragState.current.startPct + deltaPct));
      setLeftPanePct(next);
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  /** T04584：取数序号守卫——切子仓库分支时旧的根仓库请求可能晚到，晚到者不得覆盖新结果。 */
  const loadSeq = useRef(0);

  /* ---------- T04527：分支聚合（多仓库）视图。缺省关闭，关闭时下面这些状态一概不参与渲染 ---------- */
  const [repoView, setRepoView] = useState(initialRepoView === true);
  /** T04883：分组视图默认只列本地分支；勾上「显示远程分支」才把远程跟踪引用放回分组 */
  const [showRemoteBranches, setShowRemoteBranches] = useState(false);
  /** 引用普查结果（每个仓库一份 refs）；null = 还没普查过，此时不画任何分组层 */
  const [census, setCensus] = useState<RepoBranchInput[] | null>(null);
  const [scanning, setScanning] = useState(false);
  /** T04886：逐项目 `/git/repos` 的截断信息（因目录上限未扫全），用于显式提示，不阻断正常列出 */
  const [truncations, setTruncations] = useState<{ projectId: string; projectName: string; truncated: boolean; scannedDirs: number }[]>([]);
  /** 「仓库 × 分支」窗口：懒加载回来的提交、勾选、取数状态与错误 */
  const [panes, setPanes] = useState<Record<string, RepoPane>>({});
  const [paneAnchor, setPaneAnchor] = useState<Record<string, number | null>>({});
  const [groupExpanded, setGroupExpanded] = useState<Set<string>>(new Set());
  const [openBranches, setOpenBranches] = useSessionState<string[]>('git.tree.openBranches', []);
  const [openRepos, setOpenRepos] = useSessionState<string[]>('git.tree.openRepos', []);

  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);
  /** T04912：混合只在「平铺 + 用户未关闭 + 清单确实有 ≥2 个仓库」时启用；单仓库工作空间逐字走旧逻辑 */
  const mixActive = !repoView && mixRepos && repoChoices.length > 1;
  /** T04586 复验：平铺视图当前看的仓库。底部原先一律写项目名，会把子仓库的提交也标成「根目录仓库」 */
  const activeRepoChoice = useMemo(() => repoChoices.find((c) => c.subPath === flatRepoSub), [repoChoices, flatRepoSub]);
  const flatRepoLabel = useMemo(() => {
    const base = project?.name ?? '';
    if (!activeRepoChoice) return base;
    return activeRepoChoice.isRoot ? `${base}（根目录仓库）` : `${base} · ${activeRepoChoice.subPath}`;
  }, [project, activeRepoChoice]);
  const visibleRefs = useMemo(() => groupByRef(commits), [commits]);
  const summary = useMemo(() => summarizeSelection(commits, selected), [commits, selected]);

  /* ---------- T05210：IDEA 双栏所需的两个派生量 ---------- */
  /** 项目名索引：右栏摘要要说清「这条提交来自哪个仓库」，根仓库不带 repoSub 时得回落到项目名 */
  const projectNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of projects) m[p.id] = p.name;
    return m;
  }, [projects]);
  /**
   * 仓库色索引：由「当前可见的所有仓库」排序后取色（`repoColorMap` 保证视图内两两不同）。
   * 只在真的有 ≥2 个仓库时才需要颜色——单仓库视图整屏一个色等于没上色，反而添噪。
   */
  const repoColorKeys = useMemo(() => {
    if (repoView) return Object.values(panes).map((p) => repoKeyOf(p.projectId, p.repoSub));
    if (mixActive) return commits.map((c) => repoKeyOf(projectId, c.repoSub ?? ''));
    return [];
  }, [repoView, panes, mixActive, commits, projectId]);
  const colorIndex = useMemo(() => repoColorMap(repoColorKeys).index, [repoColorKeys]);
  const multiRepoColored = useMemo(() => new Set(repoColorKeys).size > 1, [repoColorKeys]);

  /**
   * 右栏的输入：把「已选 SHA」还原成带仓库坐标的记录。
   * 平铺混合视图里每条提交有自己的来源仓库，分组视图里由所在窗口决定——两处都要带上 projectId，
   * 因为分组视图的普查是跨项目的（一个工作空间里可能有多项）。
   */
  const detailEntries = useMemo<DetailEntry[]>(() => {
    const out: DetailEntry[] = [];
    const push = (c: GitTreeCommit, pid: string, sub: string, label: string) => {
      out.push({
        sha: c.sha, short: c.short, author: c.author, date: c.date, subject: c.subject,
        parents: c.parents, refs: c.refs, projectId: pid, repoSub: sub, repoLabel: label,
        repoKey: repoKeyOf(pid, sub),
      });
    };
    if (repoView) {
      for (const pane of Object.values(panes)) {
        for (const sha of pane.selected) {
          const c = pane.commits.find((x) => x.sha === sha);
          if (!c) continue;
          push(c, pane.projectId, pane.repoSub, repoLabelOf(pane.repoSub, projectNameById[pane.projectId] ?? '', ''));
        }
      }
      return out;
    }
    for (const sha of selected) {
      const c = commits.find((x) => x.sha === sha);
      if (!c) continue;
      if (mixActive) push(c, projectId, c.repoSub ?? '', c.repoLabel ?? flatRepoLabel);
      else push(c, projectId, flatRepoSub, flatRepoLabel);
    }
    return out;
  }, [repoView, panes, selected, commits, mixActive, projectId, flatRepoSub, flatRepoLabel, projectNameById]);

  /* ---------- T04527：分组视图的派生数据与动作 ---------- */
  /** 已加载窗口的提交数（未加载的窗口不带计数，分组头显示「仓库数」而不谎报「提交数」） */
  const countsByPane = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, pane] of Object.entries(panes)) if (!pane.loading && !pane.error) out[key] = pane.commits.length;
    return out;
  }, [panes]);
  /** T04583：先把普查输入收窄到当前项目的工作空间，再归组/列不可用行——否则跨工作空间的所选项目
   *  会把别的工作空间的分支一并显示，项目下拉切换只改排序不改成员（过滤失效）。同目录子仓库照旧保留。 */
  const scopedCensus = useMemo(() => (census ? inputsForActiveWorkspace(census, projectId) : []), [census, projectId]);
  /** T04883：分组视图的数据源——默认只留本地分支；勾「显示远程分支」才用全量普查引用。
   *  起点分支候选仍走全量 census（含远程），用户可通过搜索/输入框手动按远程分支取数。 */
  const groupInputs = useMemo(
    () => (showRemoteBranches ? scopedCensus : localOnlyRefInputs(scopedCensus)),
    [scopedCensus, showRemoteBranches],
  );
  /** T04584：起点分支候选。普查前退回根仓库 refs（外观与改造前一致）；展开输入框触发普查后，
   *  换成「当前项目根仓库 + 子仓库」的并集，子仓库分支带 repoSub 标注，选中即按该仓库取数。 */
  const headOptions = useMemo<BranchOption[]>(
    () => (census ? branchOptionsFromCensus(scopedCensus, projectId) : refs),
    [census, scopedCensus, projectId, refs],
  );
  const repoGroups = useMemo(
    () => applyCommitCounts(buildRepoBranchGroups(groupInputs, projectId), countsByPane),
    [groupInputs, projectId, countsByPane],
  );
  /** 未绑定/取数失败的仓库：没有 refs 可归组，但要单独成行（验收点 5） */
  const blockedRows = useMemo(() => blockedRepoRows(scopedCensus, projectId), [scopedCensus, projectId]);
  /** 分支名 → 可用仓库数。普查前是空表，单仓库模式的分支 chip 因此与改造前逐字一致 */
  const repoCountByBranch = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of repoGroups) out[g.branchName] = g.repoCount;
    return out;
  }, [repoGroups]);
  /** 按仓库并好的勾选（跨分支同仓库已去重），确认口径与计数都以它为准；键是 `repoKeyOf` */
  const selectionByRepo = useMemo(
    () => mergePaneSelections(Object.values(panes).map((p) => ({ repoKey: p.repoKey, projectId: p.projectId, repoSub: p.repoSub, shas: p.selected }))),
    [panes],
  );
  const pickedRepoCount = Object.values(selectionByRepo).filter((sel) => sel.shas.length > 0).length;
  const pickedRepo = Object.values(selectionByRepo).find((sel) => sel.shas.length > 0);
  const pickedRepoName = pickedRepo
    ? (census?.find((i) => repoKeyOf(i.projectId, i.repoSub) === pickedRepo.repoKey)?.projectName ?? '')
    : '';
  const paneSelectedCount = Object.values(panes).reduce((n, p) => n + p.selected.length, 0);
  const paneBusy = Object.values(panes).some((p) => p.loading);

  /**
   * 引用普查，两相位：① 逐项目问 `/git/repos`「这个工作空间目录里装着哪些仓库」，② 逐仓库取引用清单。
   *
   * 相位 ① 是 T04525 的需求修订本体：修订前把「一个项目 = 一个仓库」当成事实去普查，
   * 于是 `D:\code\QJ\BEMP5.0DEV` 里 7 个子仓库在视图上根本不存在（服务端 `--is-inside-work-tree`
   * 在子目录也回 true，读起来就是「只有根仓库」）。
   * 未绑定工作空间的项目在本地直接判死（一条 git 都不该 fork），服务端拒绝与网络异常各留一句话原因。
   */
  async function runCensus(list: Project[]) {
    setScanning(true);
    setError('');
    try {
      const scanProjects = list.map((p) => ({ id: p.id, name: p.name, workspacePath: (p.workspace_path ?? '').trim() }));
      const repoLists = await mapSettledWithLimit(scanProjects, async (p) => {
        if (!p.workspacePath) throw new Error('该项目未绑定工作空间，无法取 Git 数据');
        return api.get<RepoListResult>(`/git/repos?${new URLSearchParams({ projectId: p.id }).toString()}`);
      }, REPO_SCAN_CONCURRENCY);
      const targets = censusTargetsFromRepoLists(scanProjects, repoLists);
      const settled = await mapSettledWithLimit(targets, async (t) => {
        if (!t.workspacePath) throw new Error('该项目未绑定工作空间，无法取 Git 数据');
        const qs = new URLSearchParams({ projectId: t.projectId, all: '1', skip: '0', limit: '1' });
        if (t.repoSub) qs.set('repoSub', t.repoSub);
        const r = await api.get<GitLogResponse>(`/git/log?${qs.toString()}`);
        if (!r.ok) throw new Error(r.error?.message ?? 'Git 取数失败');
        return { refs: r.refs ?? [], workspacePath: r.workspacePath };
      }, REPO_SCAN_CONCURRENCY);
      const next = targets.map((t, i) => repoInputFromScan(
        { id: t.projectId, name: t.projectName, workspacePath: t.workspacePath, repoSub: t.repoSub }, settled[i]));
      setCensus(next);
      // T04886：把逐项目的截断信息挑出来，供 UI 显式提示（不阻断列表）
      setTruncations(scanProjects.map((p, i) => {
        const v = repoLists[i]?.status === 'fulfilled' ? repoLists[i].value : undefined;
        return { projectId: p.id, projectName: p.name, truncated: !!v?.truncated, scannedDirs: Number(v?.scannedDirs ?? 0) };
      }));
      // 首屏折叠：只把「当前项目所在的那条分支」摊开，其余仓库要点一下才取数（方案 §3.3）
      // T04583：默认展开按「收窄到当前工作空间后」的分组算，与视图显示成员一致
      const scoped = inputsForActiveWorkspace(next, projectId);
      const groups = buildRepoBranchGroups(showRemoteBranches ? scoped : localOnlyRefInputs(scoped), projectId);
      setOpenBranches((prev) => (prev.length ? prev : defaultExpandedBranches(groups, projectId)));
      setOpenRepos((prev) => (prev.length
        ? prev
        : sharedBranchGroups(groups).flatMap((g) => defaultExpandedRepos(g, projectId).map((repoKey) => paneKeyOf(repoKey, g.branchName)))));
    } finally {
      setScanning(false);
    }
  }

  /** 展开某个「仓库 × 分支」窗口时才按该仓库自己的原始引用名取数（归一化名可能是 origin/ 前缀被去掉后的产物） */
  async function loadPane(target: { repoKey: string; projectId: string; repoSub: string; branchName: string }, append: boolean, force = false) {
    const key = paneKeyOf(target.repoKey, target.branchName);
    const current = panes[key];
    // force：搜索重取数允许打断在途请求（旧响应由 paneSeq 守卫丢弃），否则连续搜索会被静默跳过
    if (append ? (current?.loading ?? false) : (!force && current?.loading)) return;
    // T04911：连续两次搜索（或搜索后立刻清空）时，前一个请求可能晚到并把结果覆盖回旧关键词
    const seq = (paneSeq.current[key] ?? 0) + 1;
    paneSeq.current[key] = seq;
    const isStale = () => paneSeq.current[key] !== seq;
    const input = (censusRef.current ?? []).find((i) => repoKeyOf(i.projectId, i.repoSub) === target.repoKey);
    const refName = input ? refNameForBranch(input.refs, target.branchName) : null;
    setPanes((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? emptyPane), repoKey: target.repoKey, projectId: target.projectId, repoSub: target.repoSub, branchName: target.branchName, commits: append ? (prev[key]?.commits ?? []) : [], loading: true, loaded: false, hasMore: false, error: '', selected: prev[key]?.selected ?? [] },
    }));
    try {
      // T04911：分组窗口也必须带上当前搜索词（修复前写死 ''，且搜索按钮在 repoView 下直接 return）
      const qs = buildLogQuery(target.projectId, refName ?? target.branchName, false, searchRef.current, append ? (current?.commits.length ?? 0) : 0, target.repoSub);
      const r = await api.get<GitLogResponse>(`/git/log?${qs}`);
      setPanes((prev) => {
        if (isStale()) return prev;
        const pane = prev[key] ?? emptyPane;
        if (!r.ok) {
          return { ...prev, [key]: { ...pane, loading: false, loaded: false, hasMore: false, error: r.error?.message ?? 'Git 取数失败' } };
        }
        return { ...prev, [key]: { ...pane, commits: append ? dedupe([...pane.commits, ...r.commits]) : r.commits, loading: false, loaded: true, hasMore: r.hasMore, error: '' } };
      });
    } catch (e) {
      setPanes((prev) => (isStale() ? prev : ({
        ...prev,
        [key]: { ...(prev[key] ?? emptyPane), loading: false, loaded: false, error: `取数失败：${e instanceof Error ? e.message : String(e)}` },
      })));
    }
  }

  /**
   * T04911：分组视图的搜索链路。
   *
   * 修复前搜索框/搜索按钮都调 `load(false)`，而 `load` 开头 `if (!projectId || repoView) return`
   * 直接吞掉分组模式的调用；窗口取数 `buildLogQuery` 的 search 又写死空串，即便刷新也不会带关键词。
   * 现在按当前关键词对**已展开且已加载**的「仓库 × 分支」窗口重新取数（skip=0）；
   * 分组头/仓库行/折叠层级一律不动（约束：只修搜索交互链路，不改分组视觉布局）。
   * 之后新展开的窗口由 `loadPane` 经 `searchRef` 自动带上同一关键词。
   */
  function runGroupedSearch() {
    const term = search.trim();
    setGroupedSearchTerm(term);
    setError('');
    const loaded = Object.values(panes).filter((p) => p.loaded || p.loading);
    if (!loaded.length) {
      setGroupedSearchCount(0);
      setError('请先展开一个「仓库 × 分支」窗口再搜索；展开后会自动按关键词取数');
      return;
    }
    // 触发瞬间记下窗口数：重取数会把 pane.loaded 暂时置 false，直接读 panes 会显示「0 个窗口」
    setGroupedSearchCount(loaded.length);
    for (const pane of loaded) {
      void loadPane({ repoKey: pane.repoKey, projectId: pane.projectId, repoSub: pane.repoSub, branchName: pane.branchName }, false, true);
    }
  }

  /** 搜索/重新取数按视图模式分派：平铺沿用原 load，分组走窗口重取数（T04911） */
  function triggerSearch() {
    if (repoView) runGroupedSearch();
    else void load(false);
  }

  function onPaneRowClick(key: string, index: number, e: React.MouseEvent) {
    const pane = panes[key];
    if (!pane) return;
    const res = selectAt({
      commits: pane.commits, selected: pane.selected, index, anchor: paneAnchor[key] ?? null,
      mods: { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey },
    });
    setPanes((prev) => ({ ...prev, [key]: { ...prev[key], selected: res.selected } }));
    setPaneAnchor((prev) => ({ ...prev, [key]: res.anchor }));
    if (res.limited > 0) setError(`一次最多点选 ${MAX_SELECTED_COMMITS} 个提交，超出部分未加入（${res.limited} 条被忽略）`);
  }

  function toggleGroupRowExpand(key: string, sha: string) {
    setGroupExpanded((prev) => {
      const n = new Set(prev);
      const rowKey = `${key}\n${sha}`;
      if (n.has(rowKey)) n.delete(rowKey); else n.add(rowKey);
      return n;
    });
  }
  /** 首屏/切条件取数用的最新闭包（要读当时的 commits/search），经 ref 交给 effect，避免整函数进依赖 */
  const loadRef = useRef<(append: boolean) => Promise<void>>(async () => undefined);
  /** 切项目时读的是「父层此刻的已选」，同样只取最新一份，不因父层重渲染而重置选择 */
  const selectedByProjectRef = useRef(selectedByProject);
  selectedByProjectRef.current = selectedByProject;
  /** 懒加载窗口时要按「当时那份普查结果」找原始引用名，不能让异步函数闭包抓住旧的 census */
  const censusRef = useRef(census);
  censusRef.current = census;

  // Esc = 取消（不丢已选：确认后才会写回卡片，取消保持原样）
  // T05556：全屏时第一次 Esc 先退出全屏，再按一次才关闭弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (fullscreen) { setFullscreen(false); e.preventDefault(); }
      else onClose();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose, fullscreen]);

  // T05063：动画窗口内被取消/Esc 关闭时，绝不能把延迟提交漏到关闭之后
  useEffect(() => () => {
    if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
  }, []);

  // 切项目 = 换一份已选与可视集，否则「在 A 项目选的提交」会串到 B 项目的范围里
  useEffect(() => {
    setSelected(selectedByProjectRef.current[projectId] ?? []);
    setAnchor(null);
    setExpanded(new Set());
    setFlatRepoSub(''); // T04584：换项目回到根仓库，别把上个项目的子仓库路径带过来
  }, [projectId]);

  // T04912：仓库清单回来 / 混合开关切换都要重取；load 内部分派到逐仓库并发取数，调用点不变
  useEffect(() => { void loadRef.current(false); }, [projectId, head, allBranches, repoView, flatRepoSub, mixRepos, repoChoices.length]);

  /**
   * T04586 复验修复：默认（平铺）视图也要「开箱列出工作空间目录里的所有仓库」。
   *
   * 修复前只有 `repoView` 或展开起点分支下拉才触发 runCensus → 平铺视图恒定 `repoSub=''`，
   * 用户工作空间里装着 7 个子仓库，第一屏也只取根目录那一个（【验证失败 2026-11-10】）。
   * 这里不阻塞原有首屏取数（单仓库场景零额外延迟）；清单回来后渲染仓库选择器，并在
   * 「根不是仓库」时把取数坐标落到第一个子仓库（根是仓库则保持 ''，旧行为逐字不变）。
   */
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setRepoListState('loading');
    setRepoChoices([]);
    setRepoListTruncated(false);
    void api.get<RepoListResult>(`/git/repos?${new URLSearchParams({ projectId })}`)
      .then((list) => {
        if (!alive) return;
        const choices = repoChoicesFromRepoList(list);
        setRepoChoices(choices);
        setRepoListTruncated(!!list.truncated);
        setRepoListState('ready');
        setFlatRepoSub((prev) => defaultRepoSub(choices, prev));
      })
      .catch(() => { if (alive) setRepoListState('error'); });
    return () => { alive = false; };
  }, [projectId]);

  // 打开聚合视图才普查一次（方案 §5.1「先保留单仓库体验」）；同一份弹窗生命周期内复用结果，不反复 fork git。
  // T04525：条件从 `projects.length > 1` 放开到「有项目就普查」——需求要看的本来就是
  // **一个**工作空间目录里的多个仓库，只在多项目场景才普查正是上次验收失败的原因。
  useEffect(() => {
    if (repoView && !census && !scanning && projects.length > 0) void runCensus(projects);
  }, [repoView, census, scanning, projects]);

  /**
   * 默认展开的「仓库 × 分支」窗口没有经过任何点击，得在这里补一次取数。
   * 少了它，普查结束后的第一屏就是「箭头是开的、列表是空的」——用户只能读成「这仓库这条分支没提交」。
   * 判据只用 `panes[key]` 是否存在：`loadPane` 会立刻写入占位窗口，因此同一窗口不会被并发取两次。
   *
   * T04525 实测到的两条边界（都写死在这里，否则一个 8 仓库 × 30 分支组的工作空间会一次铺出 200 多个
   * git 取数，弹窗和后端一起卡死）：
   *   - 只给**已展开的分支组**取数——折叠组里的仓库行根本没渲染，取了也看不见；
   *   - 在途窗口超过 `PANE_LOAD_INFLIGHT` 就本轮不补，等下一次 `panes` 变化再排（等价于限流队列）。
   */
  useEffect(() => {
    if (!repoView || !census || scanning) return;
    const inflight = Object.values(panes).filter((p) => p.loading).length;
    let budget = PANE_LOAD_INFLIGHT - inflight;
    if (budget <= 0) return;
    for (const group of repoGroups) {
      if (!openBranches.includes(group.branchKey)) continue;
      for (const row of group.repos) {
        if (!row.available) continue;
        const key = paneKeyOf(row.repoKey, group.branchName);
        if (!openRepos.includes(key) || panes[key]) continue;
        void loadPane({ repoKey: row.repoKey, projectId: row.projectId, repoSub: row.repoSub, branchName: group.branchName }, false);
        if (--budget <= 0) return;
      }
    }
  }, [repoView, census, scanning, repoGroups, openBranches, openRepos, panes]);

  /**
   * T04912：「按时间顺序混合显示」的逐仓库并发取数。
   * 进入视图前 `/git/repos` 已把根 + 任意层级子仓库（含分支元数据）列全，这里按清单各取一页，
   * 用 `mergeRepoTimelines` 按作者时间统一排序并给每行补来源仓库。
   * 取数失败的仓库只降级为一条说明，不拖垮其余仓库；全部失败才走「取数失败 ≠ 没有提交」的空态。
   * 并发上限复用普查的 `REPO_SCAN_CONCURRENCY`，避免 8 仓库工作空间一次铺出大量 git 进程。
   */
  async function loadMixed() {
    if (!projectId || repoView || repoChoices.length === 0) return;
    const seq = ++loadSeq.current;
    const choices = repoChoices.slice();
    setLoading(true);
    setError('');
    setMixedWarnings([]);
    try {
      const results = await mapSettledWithLimit(choices, (choice) => {
        const qs = buildLogQuery(projectId, head, allBranches, search, 0, choice.subPath);
        return api.get<GitLogResponse>(`/git/log?${qs}`);
      }, REPO_SCAN_CONCURRENCY);
      if (seq !== loadSeq.current) return;
      const inputs: RepoTimelineInput[] = [];
      const warnings: string[] = [];
      for (let i = 0; i < results.length; i += 1) {
        const choice = choices[i];
        const label = repoLabelOf(choice.subPath, choice.displayName, project?.name ?? '');
        const res = results[i];
        if (res.status === 'rejected') { warnings.push(`${label}：${String(res.reason)}`); continue; }
        const r = res.value;
        if (!r?.ok) { warnings.push(`${label}：${r?.error?.message ?? '取数失败'}`); continue; }
        inputs.push({ repoSub: choice.subPath, repoLabel: label, commits: r.commits ?? [] });
      }
      const merged = mergeRepoTimelines(inputs);
      setCommits(merged);
      // 混合视图每仓库各取最近一页，不做跨仓库分页（skip 是单仓库语义，混用会让时间线跳档）
      setHasMore(false);
      setScanTruncated(false);
      setMixedWarnings(warnings);
      setSelected((prev) => orderSelected(merged, prev));
      if (inputs.length === 0) setError(warnings[0] ?? '所有仓库取数失败');
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(`混合取数失败：${e instanceof Error ? e.message : String(e)}`);
      setCommits([]);
      setHasMore(false);
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        listRef.current?.focus();
      }
    }
  }

  async function load(append: boolean) {
    if (!projectId || repoView) return;
    // T04912：混合时间线走独立取数；搜索/重新取数/切条件仍复用同一个 load 入口，分组门锚不变
    if (mixActive) { await loadMixed(); return; }
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');
    const nextSkip = append ? commits.length : 0;
    try {
      // Q11 裁定：Git 树取数端点上提为 `GET /git/log`——任务侧与讲稿侧共用同一取数逻辑，
      // 不再让任务抽屉依赖讲稿命名空间（旧 POST 路径仍在服务端保留转发）。
      const qs = buildLogQuery(projectId, head, allBranches, search, nextSkip, flatRepoSub);
      const r = await api.get<GitLogResponse>(`/git/log?${qs}`);
      if (seq !== loadSeq.current) return;
      if (!r.ok) {
        setError(r.error?.message ?? 'Git 取数失败');
        setCommits(append ? commits : []);
        setHasMore(false);
        return;
      }
      // 翻页追加按 SHA 去重：换分支/搜索窗口重叠时不能出现两行同样的提交
      const merged = append ? dedupe([...commits, ...r.commits]) : r.commits;
      setCommits(merged);
      setHasMore(r.hasMore);
      setScanTruncated(r.scanTruncated);
      if (r.refs) setRefs(r.refs);
      // 可视集变了就重排已选顺序（保持「新→旧」与列表一致），但不删列表外的历史选择
      setSelected((prev) => orderSelected(merged, prev));
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // 网络异常与后端 5xx 都走这里：给出可复述的一句话，而不是一片空白列表
      setError(`无法连接到本机服务或取数被拒绝：${e instanceof Error ? e.message : String(e)}`);
      setCommits(append ? commits : []);
      setHasMore(false);
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        listRef.current?.focus();
      }
    }
  }
  loadRef.current = load;

  function onRowClick(index: number, e: React.MouseEvent) {
    // T04912：确认类错误（跨仓库勾选 / 幽灵提交）在用户重新点选后即过期；
    // 否则用户按提示清空了其它仓库的勾选，红色提示还挂着、确认按钮也被锁死。
    setError((prev) => (prev.includes('一次确认只能回传一个仓库') || prev.includes('所选提交已不在当前列表') ? '' : prev));
    const res = selectAt({ commits, selected, index, anchor, mods: { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey } });
    setSelected(res.selected);
    setAnchor(res.anchor);
    if (res.limited > 0) setError(`一次最多点选 ${MAX_SELECTED_COMMITS} 个提交，超出部分未加入（${res.limited} 条被忽略）`);
  }

  function toggleRowExpand(sha: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(sha)) n.delete(sha); else n.add(sha);
      return n;
    });
  }

  /**
   * 分支 chip 的落点（方案 §5.1）：普查确认这条分支跨了多个仓库 → 进聚合视图并展开该分支组；
   * 只属于一个仓库 → 保持现状（按这条分支重新取数）。没有普查数据时 `repoCount` 恒为 0，行为与改造前一致。
   */
  function onChipClick(r: GitRefName) {
    const branch = branchNameOf(r) ?? r.name;
    const group = repoGroups.find((g) => g.branchName === branch);
    if (group && group.repoCount > 1) {
      setRepoView(true);
      if (!openBranches.includes(group.branchKey)) setOpenBranches((prev) => toggleKey(prev, group.branchKey));
      return;
    }
    setRepoView(false);
    setAllBranches(false);
    setHead(r.name);
  }

  function confirm() {
    if (!repoView) {
      if (selected.length === 0) return;
      // T04912：混合时间线与分组视图同红线——一次确认只回传一个仓库，不许把多仓库 SHA 假合并
      if (mixActive) {
        const out = resolveMixedConfirmation(commits, selected);
        if (!out.ok) {
          setError(out.code === 'multi'
            ? `已勾选 ${out.repoSubs.length} 个仓库的提交：提取/扫描按单一仓库逐仓库执行，一次确认只能回传一个仓库，请先清空其它仓库的勾选`
            : out.code === 'missing' ? '所选提交已不在当前列表中，请重新取数后再确认' : '还没有勾选任何提交');
          return;
        }
        setError('');
        onConfirm(projectId, orderSelected(commits, selected), out.repoSub);
        return;
      }
      // T04584：平铺视图也可能正看着某个子仓库，确认时把 repoSub 一起交出去（空串 = 根仓库，与改造前一致）
      onConfirm(projectId, orderSelected(commits, selected), flatRepoSub);
      return;
    }
    // 分组视图：确认口径由 `resolveRepoConfirmation` 把关——多仓库有勾选就拒，不做假的跨仓库合并
    const out = resolveRepoConfirmation(selectionByRepo);
    if (!out.ok) {
      setError(out.code === 'multi'
        ? `已勾选 ${out.repoKeys.length} 个仓库的提交：提取/扫描按单一仓库逐仓库执行，一次确认只能回传一个仓库，请先清空其它仓库的勾选`
        : '还没有勾选任何提交');
      return;
    }
    setError('');
    const pickedKey = repoKeyOf(out.projectId, out.repoSub);
    const paneCommits = Object.values(panes).filter((p) => p.repoKey === pickedKey).flatMap((p) => p.commits);
    // T04576：把仓库维度一起交出去——只回 SHA 的话，子仓库的提交会在回写/提取时按根仓库解析并判 missing
    onConfirm(out.projectId, orderSelected(dedupe(paneCommits), out.shas), out.repoSub);
  }

  // 分组视图：勾选跨多个仓库时按钮保持**可点**——拒绝由 `confirm()` 给明原因（-disabled 只会让人对着
  // 一个没有解释的灰按钮打转，多仓库场景下这恰好是最需要「为什么不行」的一句话）
  // T04912：混合视图的 error 可能只是「上次确认被拒」，不能把按钮锁死；取数全失败时
  // commits 为空 → selected 必为 0，仍守住「取数失败 ≠ 没有提交」的禁用边界。
  const canConfirm = repoView
    ? paneSelectedCount > 0 && !paneBusy && !scanning
    : selected.length > 0 && !loading && (!error || mixActive);
  /** 动画窗口内按钮置灰（需求允许），但对外仍用「还能不能确认」这一条判据表达原因 */
  const confirmEnabled = canConfirm && !confirming;

  /**
   * T05063：点击先播 250ms 动画，动画结束才真正 `confirm()`。
   *
   * 为什么不能「同步 confirm + 同时播动画」：四个入口里 `gitScopePicker`（`setCommitPickerMode(null)`）
   * 与讲稿卡（`setGitTreeOpen(false)`）在确认后**同步卸载**弹窗，动画来不及绘制就被卸载，
   * 用户仍会读成「点了没反应」并继续连点。延迟一个动画时长不改结果，但保证反馈始终可见。
   *
   * 防连点两道：① `confirming` 期间 `disabled`（浏览器不再派发 click）；
   * ② 即便同一帧内被程序化连发多次，重复调用只会 `clearTimeout` 前一个定时器，最终只提交一次。
   * 组件卸载时（Esc / 取消 / 父层关闭）会清定时器，不会把提交漏到关闭之后。
   */
  function onConfirmClick() {
    if (!confirmEnabled) return;
    setConfirming(true);
    if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      confirmTimer.current = null;
      setConfirming(false);
      confirm();
    }, CONFIRM_ANIM_MS);
  }

  return (
    /* 原生 <dialog open>：显隐仍由本组件挂载/卸载控制（父层只在需要时渲染），Esc 仍由上面的监听负责。
       T05210：显式补 role="dialog"——原生 <dialog> 的隐式角色在部分自动化/无障碍工具里取不到
       `getAttribute('role')`，显式声明后「弹窗以 dialog 角色出场」这条可被直接断言，也不再依赖隐式语义。 */
    <dialog open role="dialog" data-lck="git-tree-modal" data-fullscreen={fullscreen ? '1' : '0'} aria-modal="true" aria-label="从 Git 树选择评审范围"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, margin: 0,
        // T05556：全屏时 padding=0、背景铺满；非全屏保持原 16px 收边与半透明遮罩
        padding: fullscreen ? 0 : 16, border: 'none',
        width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none',
        background: fullscreen ? 'var(--card-bg)' : 'rgba(15,23,42,0.45)', color: 'inherit',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
      {/* T05063：只给「确认选择」用的点击反馈关键帧（缩放 + 透明度），不动全局样式，也不影响其它按钮 */}
      <style>{`@keyframes git-tree-confirm-pop {
  0% { transform: scale(1); opacity: 1; }
  45% { transform: scale(.93); opacity: .72; }
  100% { transform: scale(1); opacity: 1; }
  .gt-divider { cursor: col-resize; }
  .gt-divider:hover { background: var(--accent-soft); }
}${GIT_TREE_STYLE}`}</style>
      {/* T05210/T05556：双栏后需要更多横向空间（左栏记录 + 右栏文件树）；窄屏按 97vw 收边；全屏时铺满视口 */}
      <div style={{
        width: fullscreen ? '100%' : 'min(1400px, 97vw)',
        height: fullscreen ? '100%' : undefined,
        maxHeight: fullscreen ? undefined : '90vh',
        display: 'flex', flexDirection: 'column',
        background: 'var(--card-bg)',
        border: fullscreen ? 'none' : '1px solid var(--accent)',
        borderRadius: fullscreen ? 0 : 10,
        padding: fullscreen ? 8 : 14,
      }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <GitBranch size={16} style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 'var(--fs-l)' }}>Git 树选范围</strong>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            单击=勾选/取消多个提交 · Shift+单击=框选到上一条锚点；确认后按「每个选中提交相对第一父的增量」采集
          </span>
          {/* T05556：全屏/退出全屏按钮——全屏时铺满视口、非全屏时恢复原尺寸；Esc 先退全屏再关闭 */}
          <button type="button" data-lck="git-tree-fullscreen" onClick={() => setFullscreen((v) => !v)}
            aria-label={fullscreen ? '退出全屏' : '全屏显示'}
            title={fullscreen ? '退出全屏（Esc 或再点此按钮）' : '全屏显示，便于处理大量 Git 树节点'}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Maximize2 size={15} aria-hidden />
            <span style={{ fontSize: 'var(--fs-xs)' }}>{fullscreen ? '退出全屏' : '全屏'}</span>
          </button>
          <button type="button" onClick={onClose} aria-label="关闭 Git 树选择"
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}>
            <X size={15} />
          </button>
        </header>

        {/* T05078/T05556：目标任务条——只在调用方显式传入时出现，其它入口不渲染。
            T05556：批量补录时额外显示队列进度（第 1/N 条），让用户在弹窗里就知道还有几条待补录 */}
        {targetLabel && (
          <div data-lck="git-tree-target"
            data-queue-total={targetQueue > 0 ? targetQueue : undefined}
            title={`本次「确认选择」将把勾选的提交关联到：${targetLabel}`}
            style={{
              marginTop: 8, padding: '5px 9px', borderRadius: 6, background: 'var(--surface-2)',
              border: '1px solid var(--border-strong)', fontSize: 'var(--fs-s)', color: 'var(--text)',
              // 任务标题可能很长：在标签条内换行，不用省略号藏掉目标
              overflowWrap: 'anywhere', wordBreak: 'break-word',
              display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap',
            }}>
            <span>本次确认将关联到：</span>
            <strong>{targetLabel}</strong>
            {targetQueue > 0 && (
              <span data-lck="git-tree-queue-progress" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                · 共 {targetQueue} 条待补录
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0' }}>
          {projects.length > 1 && (
            <select data-lck="git-tree-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={boxStyle} aria-label="选择项目仓库">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {/* T04586 复验：默认视图的仓库选择器——递归清单（根 + 任意层级子仓库），每项带分支/短提交。
              清单含根仓库时 value 仍是 ''，旧「单仓库」口径逐字不变，只是多了可切换的仓库坐标。 */}
          {!repoView && repoChoices.length > 0 && (
            <select data-lck="git-tree-repo-select" value={flatRepoSub}
              aria-label="选择工作空间内的 Git 仓库"
              title="工作空间目录内递归发现的 Git 仓库（含任意层级子目录）"
              onChange={(e) => {
                // 换仓库 = 换一份可视集：旧仓库的勾选/起点分支不带过去，确认仍按 flatRepoSub 回传
                // T04912：显式选中某个仓库即退出「混合全部仓库」，避免下拉看着像没生效
                setMixRepos(false);
                setSelected([]);
                setAnchor(null);
                setHead('');
                setAllBranches(false);
                setFlatRepoSub(e.target.value);
              }}
              style={{ ...boxStyle, maxWidth: 320 }}>
              {repoChoices.map((c) => (
                <option key={c.subPath || '.'} value={c.subPath}>
                  {`${c.isRoot ? `根目录仓库 · ${c.displayName}` : c.subPath}${c.branch ? ` · ${c.branch}` : ''}${c.commit ? `@${c.commit.slice(0, 8)}` : ''}`}
                </option>
              ))}
            </select>
          )}
          {!repoView && repoChoices.length > 1 && (
            <span data-lck="git-tree-repo-count" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              工作空间内 {repoChoices.length} 个仓库
              {repoListTruncated ? '（扫描已达上限，深层仓库可能未列出）' : ''}
            </span>
          )}
          {/* T04912：默认开启——进入「按时间顺序混合显示」即自动取全部仓库，按作者时间交织；
              关闭后逐字回到 T04586 的单仓库取数/确认口径（兼容性验收）。 */}
          {!repoView && repoChoices.length > 1 && (
            <label data-lck="git-tree-mix-repos"
              title="按 Git 作者时间把工作空间内所有仓库的提交混成一条时间线；关闭后只看当前选中的仓库"
              style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={mixRepos}
                onChange={(e) => { setMixRepos(e.target.checked); setSelected([]); setAnchor(null); }} />
              混合全部仓库
            </label>
          )}
          {!repoView && repoListState === 'error' && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>仓库清单取数失败，仍按当前仓库取数</span>
          )}
          {/* T03590：head 文本框升级为可展开的分支选择器（模糊过滤 + 选中即按该分支重新取数 + 清除）；
              输入框本体保留 data-lck="git-tree-head"，手输 SHA/标签与改造前一致 */}
          <BranchPicker value={head}
            onChange={(next) => { setAllBranches(false); setHead(next); }}
            options={headOptions} testId="git-tree-head" width={200}
            onOpen={() => { if (!census && !scanning && projects.length > 0) void runCensus(projects); }}
            onSelect={(opt) => setFlatRepoSub(opt.repoSub ?? '')}
            placeholder="起点分支/标签/SHA（留空=HEAD）" ariaLabel="起点版本" disabled={allBranches} />
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-s)' }}>
            <input data-lck="git-tree-all" type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} />
            {' '}全部分支
          </label>
          <input data-lck="git-tree-search" value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') triggerSearch(); }}
            placeholder="搜索标题/SHA/作者后回车" style={{ ...boxStyle, width: 200 }} aria-label="搜索提交" />
          <button type="button" onClick={() => triggerSearch()} disabled={repoView ? scanning : loading} style={boxStyle} aria-label="重新取数" title="重新取数（当前条件）">
            {loading ? <Loader2 size={13} className="aispin" /> : <RefreshCw size={13} />}
          </button>
          <button type="button" data-lck="git-tree-search-btn" onClick={() => triggerSearch()} disabled={repoView ? scanning : loading} style={boxStyle}>
            <Search size={13} style={{ marginRight: 4 }} />搜索
          </button>
          {/* T04911：分组模式搜索的可见反馈（只是一条提示，不改分组层级/仓库行布局） */}
          {repoView && groupedSearchTerm && (
            <span data-lck="git-tree-grouped-search" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
              分组搜索「{groupedSearchTerm}」· {groupedSearchCount} 个窗口已按关键词刷新
            </span>
          )}
          {/* T04595：结果区两种展示模式（参考 IDEA Git 视图）——「按时间顺序混合显示」（平铺，提交按时间线排列，
              可勾全部分支混合）/「按仓库分组显示」（同一分支→多仓库聚合）。默认平铺（T04595 取消默认分支聚合）。
              「按仓库分组显示」钮保留 data-lck="git-tree-repo-view" 与切换语义（既有回归门按 aria-pressed 点击切换）；
              「按时间顺序混合显示」钮绝对回到平铺。T04525：入口条件看 projects.length>0（单项目工作空间内也可有多仓库）。 */}
          {projects.length > 0 && (
            <div data-t04595="view-mode-group" style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }}>
              <button type="button" data-lck="git-tree-mode-time" aria-pressed={!repoView} disabled={scanning}
                onClick={() => { setError(''); setRepoView(false); }}
                title="按时间顺序混合显示：提交按时间线统一排列（可勾「全部分支」混合各分支），单仓库逐条确认"
                style={{ ...boxStyle, border: 'none', borderRadius: 0, cursor: 'pointer', background: !repoView ? 'var(--accent)' : 'var(--surface)', color: !repoView ? '#fff' : 'var(--text)' }}>
                <GitBranch size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />
                按时间顺序混合显示
              </button>
              <button type="button" data-lck="git-tree-repo-view" aria-pressed={repoView} disabled={scanning}
                onClick={() => { setError(''); setRepoView((v) => !v); }}
                title="按仓库分组显示：同一分支→多个仓库聚合（含工作空间目录内的子仓库），取数仍逐仓库确认；再点回到时间顺序"
                style={{ ...boxStyle, border: 'none', borderRadius: 0, borderLeft: '1px solid var(--border-strong)', cursor: 'pointer', background: repoView ? 'var(--accent)' : 'var(--surface)', color: repoView ? '#fff' : 'var(--text)' }}>
                {scanning ? <Loader2 size={13} className="aispin" style={{ marginRight: 4, verticalAlign: '-2px' }} /> : <FolderGit2 size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />}
                按仓库分组显示
              </button>
            </div>
          )}
          {/* T04883：分组视图默认只列本地分支；要看远程跟踪引用由用户显式勾选，不再默认全量加载 */}
          {repoView && (
            <label data-lck="git-tree-show-remote" title="默认只列本地分支；勾选后把各仓库的远程跟踪引用一起纳入分组"
              style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showRemoteBranches} onChange={(e) => setShowRemoteBranches(e.target.checked)} />
              显示远程分支
            </label>
          )}
        </div>

        {!foldRefs && visibleRefs.length > 0 && (
          <div data-lck="git-tree-refs" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
            <button type="button" onClick={() => setFoldRefs(true)} style={{ ...chipStyle, cursor: 'pointer', background: 'var(--surface)' }} aria-label="收起分支列表">收起分支</button>
            {refs.length > 0 && <button type="button" data-lck="git-tree-ref-all" onClick={() => { setAllBranches(true); setHead(''); }} style={{ ...chipStyle, cursor: 'pointer', background: 'var(--surface)' }}>全部分支</button>}
            {visibleRefs.slice(0, 24).map((r) => {
              const branch = branchNameOf(r) ?? r.name;
              const repoCount = repoCountByBranch[branch] ?? 0;
              return (
                <button key={`${r.type}:${r.name}`} type="button" className="row-title-btn" data-lck="git-tree-ref" data-ref={r.name}
                  data-repo-count={repoCount > 1 ? repoCount : undefined}
                  onClick={() => onChipClick(r)}
                  style={{ ...chipStyle, cursor: 'pointer', background: head === r.name && !allBranches && !repoView ? 'var(--accent)' : 'var(--surface)', color: head === r.name && !allBranches && !repoView ? '#fff' : 'var(--text-secondary)' }}>
                  {r.type === 'tag' ? <Tag size={10} style={{ marginRight: 3, verticalAlign: '-1px' }} /> : null}{r.name}
                  {/* T04527：普查后同名分支出现在 ≥2 个仓库时，chip 补一个仓库数——这就是「要多看一层」的信号 */}
                  {repoCount > 1 ? <span style={{ marginLeft: 4, color: 'var(--accent)' }}>· {repoCount}</span> : null}
                </button>
              );
            })}
          </div>
        )}
        {foldRefs && (
          <button type="button" data-lck="git-tree-refs-open" onClick={() => setFoldRefs(false)} style={{ ...chipStyle, cursor: 'pointer', marginBottom: 8, width: 'fit-content' }}>
            展开分支（{refs.length || visibleRefs.length}）
          </button>
        )}

        {error && <p data-lck="git-tree-error" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', margin: '2px 0 8px' }}>{error}</p>}

        {/* T04912：个别仓库取数失败只降级提示，其余仓库照常混入时间线，不误报成空仓库 */}
        {!repoView && mixActive && mixedWarnings.length > 0 && (
          <p data-lck="git-tree-mixed-warning" style={{ fontSize: 'var(--fs-xs)', color: '#b45309', margin: '2px 0 8px' }}>
            {mixedWarnings.length} 个仓库未纳入混合时间线：{mixedWarnings.slice(0, 3).join('；')}{mixedWarnings.length > 3 ? ' …' : ''}
          </p>
        )}

        {/* T04886：扫描被目录上限截断时显式提示，避免用户误以为「真的没有更多仓库」 */}
        {!scanning && truncations.some((t) => t.truncated) && (
          <div data-lck="git-tree-truncated" style={{ fontSize: 'var(--fs-s)', color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
            部分项目扫描已达目录上限（最多扫描 {Math.max(...truncations.filter((t) => t.truncated).map((t) => t.scannedDirs))} 个目录），深层仓库可能未列出。若缺少预期仓库，请在项目管理中收窄工作空间路径。
          </div>
        )}

        {/* T05210/T05556：IDEA 风格双栏——左「记录列表」，右「变更文件树 + 摘要」。
            两栏各自滚动：左栏翻页/搜索、右栏看长文件树时互不牵扯滚动位置。
            `data-lck="git-tree-rows"` 仍在左栏滚动容器上（既有回归门按它定位行），行锚点一并保留。
            T05556：中间加分隔线（可拖拽调整左栏宽度 20%~70%），全屏时容器铺满视口。 */}
        <div data-lck="git-tree-split" ref={splitContainerRef}
          style={{ display: 'flex', gap: 0, alignItems: 'stretch', flex: '1 1 auto', minHeight: 0, maxHeight: fullscreen ? '100%' : '58vh' }}>
          {/* T05556：数据范围标记——左侧提交清单按「当前项目 × 仓库」取数，标签让数据归属清晰 */}
          {project && (
            <div data-lck="git-tree-data-scope"
              title={`数据范围：${project.name} · ${flatRepoSub || '根仓库'}（按当前项目工作空间取数，不跨项目）`}
              style={{ position: 'absolute', top: 4, left: 8, fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.75 }}>
              数据范围：{project.name}{flatRepoSub ? ` · ${flatRepoSub}` : ''}
            </div>
          )}
          <div style={{ flex: `0 0 ${leftPanePct}%`, minWidth: 0, display: 'flex', flexDirection: 'column', maxHeight: '100%', position: 'relative' }}>
            {repoView ? (
              <RepoBranchGroupList groups={repoGroups} blocked={blockedRows} activeProjectId={projectId}
                panes={panes} openBranches={openBranches} openRepos={openRepos} groupExpanded={groupExpanded}
                scanning={scanning} censusDone={!!census} colorIndex={colorIndex} multiRepoColored={multiRepoColored}
                onToggleBranch={(key) => setOpenBranches((prev) => toggleKey(prev, key))}
                onToggleRepo={(key) => setOpenRepos((prev) => toggleKey(prev, key))}
                onLoadRepo={(row, branchName, append) => void loadPane({ repoKey: row.repoKey, projectId: row.projectId, repoSub: row.repoSub, branchName }, append)}
                onRowClick={onPaneRowClick}
                onToggleRowExpand={toggleGroupRowExpand}
                onSelectAllVisible={(key, check) => setPanes((prev) => {
                  const pane = prev[key];
                  return pane ? { ...prev, [key]: { ...pane, selected: toggleVisible(pane.commits, pane.selected, check) } } : prev;
                })} />
            ) : (
              <div ref={listRef} tabIndex={-1} data-lck="git-tree-rows"
                style={{ flex: '1 1 auto', minHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
                {!loading && commits.length === 0 && !error && (
                  <p data-lck="git-tree-empty" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12, margin: 0 }}>
                    这个仓库在当前条件下没有可显示的提交：换个分支、放宽搜索，或改用区间/粘贴 patch。
                  </p>
                )}
                <CommitRows commits={commits} selected={selected} expandedSet={expanded} keyPrefix=""
                  onRowClick={onRowClick} onToggleRowExpand={toggleRowExpand}
                  colorIndex={colorIndex} repoTintOf={multiRepoColored
                    ? (c) => repoKeyOf(projectId, mixActive ? (c.repoSub ?? '') : flatRepoSub)
                    : undefined} />
                {loading && <p style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 8, margin: 0 }}>取数中…</p>}
              </div>
            )}
          </div>
          {/* T05556：可拖拽分隔线——mousedown 起记录起点，mousemove 实时算左栏百分比（钳制 20%~70% 防布局崩坏） */}
          <div data-lck="git-tree-divider" className="gt-divider"
            onMouseDown={startDrag}
            role="separator" aria-orientation="vertical"
            aria-label="拖拽调整左右栏宽度" aria-valuenow={Math.round(leftPanePct)}
            style={{
              flex: '0 0 4px', minHeight: 0, cursor: 'col-resize', background: 'var(--border)',
              borderRadius: 2, margin: '0 3px', alignSelf: 'stretch', transition: 'background .15s ease',
            }}>
            <style>{`.gt-divider{transition:background .15s ease}.gt-divider:hover{background:var(--accent)}.gt-divider:active{background:var(--accent-soft)}`}</style>
          </div>
          <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', maxHeight: '100%' }}>
            <GitTreeFilePanel entries={detailEntries} colorIndex={colorIndex} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          {!repoView && !mixActive && hasMore && (
            <button type="button" data-lck="git-tree-load-more" onClick={() => void load(true)} disabled={loading} style={boxStyle}>
              加载更多（已显示 {commits.length} 条）
            </button>
          )}
          {!repoView && mixActive && (
            <span data-lck="git-tree-mixed-hint" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              每行已标注来源仓库；混合视图每仓库各取最近一页，需看更早记录请关闭「混合全部仓库」或改用分组视图
            </span>
          )}
          {!repoView && !mixActive && scanTruncated && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              搜索只扫描了最近 {GIT_TREE_PAGE_SIZE > 0 ? commits.length : 0} 条以内的窗口，可能还有更早的命中——换分支或翻页后再搜更准
            </span>
          )}
          <span data-lck="git-tree-selected"
            style={{ fontSize: 'var(--fs-s)', color: (repoView ? paneSelectedCount : selected.length) ? 'var(--text)' : 'var(--text-muted)' }}>
            {repoView ? (
              <>已选 {paneSelectedCount} 个提交 · {pickedRepoCount} 个仓库
                {/* 执行按单一工作空间逐仓库跑：勾到第二个仓库时先说清「确认会被拒」，而不是让用户点了才知道 */}
                {pickedRepoCount > 1 ? <span style={{ color: 'var(--danger)' }}>（一次只能确认一个仓库）</span> : null}
                {pickedRepoCount === 1 ? `（仓库 ${pickedRepoName}）` : null}
              </>
            ) : (
              <>已选 {summary.count} 个提交{summary.count > 0 ? `（${summary.runs} 段）` : ''}
                {mixActive ? ` · 混合 ${repoChoices.length} 个仓库` : ''}
                {flatRepoLabel ? ` · 仓库 ${flatRepoLabel}` : ''}
              </>
            )}
          </span>
          {!repoView && (
            <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-xs)', marginLeft: 'auto' }}>
              <input type="checkbox" checked={commits.length > 0 && selected.length === commits.length}
                onChange={(e) => setSelected(toggleVisible(commits, selected, e.target.checked))} />
              {' '}全选本页
            </label>
          )}
          <button type="button" data-lck="git-tree-cancel" onClick={onClose} style={boxStyle}>取消</button>
          <button type="button" data-lck="git-tree-confirm" onClick={onConfirmClick} disabled={!confirmEnabled}
            aria-busy={confirming || undefined}
            style={{
              ...boxStyle,
              background: confirmEnabled ? 'var(--accent)' : 'var(--surface-2)',
              color: confirmEnabled ? '#fff' : 'var(--text-muted)',
              cursor: confirmEnabled ? 'pointer' : 'not-allowed',
              // 动画只在点击后的 250ms 内挂上，结束即移除，不给按钮留常驻 transform
              animation: confirming ? `git-tree-confirm-pop ${CONFIRM_ANIM_MS}ms cubic-bezier(.4,0,.2,1)` : undefined,
              willChange: 'transform, opacity',
            }}>
            <Check size={13} style={{ marginRight: 4, verticalAlign: '-2px' }} />确认选择
          </button>
        </div>
      </div>
    </dialog>
  );
}

function dedupe(list: GitTreeCommit[]): GitTreeCommit[] {
  const seen = new Set<string>();
  const out: GitTreeCommit[] = [];
  for (const c of list) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    out.push(c);
  }
  return out;
}

/**
 * T04585：单提交的 decorate 引用 pills。
 * 非聚合（compact=false）逐字保持改造前：全部引用平铺成 pill。
 * 聚合（compact=true）走 simplifyCommitRefs：可见上限 + 远端孪生/标签折叠成「+K」，
 * 「+K」是纯展示 span（不嵌套交互控件），title 悬浮列全量折叠名；全量亦可在提交详情行查看，不丢信息。
 */
function CommitRefPills({ refs, compact }: { readonly refs: GitRefName[]; readonly compact: boolean }) {
  if (!compact) {
    return <>{refs.map((r) => <span key={`${r.type}:${r.name}`} style={{ ...chipStyle, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100, flexShrink: 1 }}>{r.name}</span>)}</>;
  }
  const { visible, hidden } = simplifyCommitRefs(refs);
  return (
    <>
      {visible.map((r) => <span key={`${r.type}:${r.name}`} style={{ ...chipStyle, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100, flexShrink: 1 }} title={r.name}>{r.name}</span>)}
      {hidden.length > 0 && (
        <span data-lck="git-tree-refs-more" style={{ ...chipStyle, cursor: 'help', whiteSpace: 'nowrap', flexShrink: 0 }}
          title={`另有 ${hidden.length} 个分支/标签：${hidden.map((r) => r.name).join('、')}`}>
          +{hidden.length}
        </span>
      )}
    </>
  );
}

/**
 * T04913：提交标题「单行省略 + 悬浮全量显示」。
 *
 * 改造前已有 CSS 单行省略与原生 `title`，但原生提示有 ~1s 延迟、样式由浏览器决定、
 * 长文本在窄屏还会被裁，不满足「不同分辨率和浏览器下显示一致」。这里：
 *  - 只在 `scrollWidth > clientWidth`（真截断）时显示受控浮层，短标题不打扰；
 *  - portal 到 body + `position: fixed`，列表容器 `overflow:auto` 裁不到；坐标由纯函数
 *    `subjectTooltipBox` 按视口钳制，靠右/靠底自动收边或翻转；
 *  - `pointerEvents: none` 且不接管 onClick，点选 / Shift 框选语义逐字不变；
 *  - 去掉会与自定义浮层叠出两份提示的原生 title，改用 `aria-label` + `data-full-subject`
 *    承担无障碍与取证（全文始终可从 DOM 读出）。
 */
function CommitSubject({ text }: { readonly text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<ReturnType<typeof subjectTooltipBox> | null>(null);
  const show = () => {
    const el = ref.current;
    if (!el || !shouldShowSubjectTooltip(el.scrollWidth, el.clientWidth)) { setBox(null); return; }
    const r = el.getBoundingClientRect();
    setBox(subjectTooltipBox(
      { left: r.left, top: r.top, bottom: r.bottom, right: r.right },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  };
  useEffect(() => {
    if (!box) return;
    // 列表滚动 / 视口变化后旧坐标立即失效，收起而不是把浮层留在半空
    const hide = () => setBox(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [box]);
  return (
    <>
      <span ref={ref} data-lck="git-tree-subject" data-full-subject={text} aria-label={text}
        onMouseEnter={show} onMouseLeave={() => setBox(null)}
        style={{
          flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          // 由继承 body 字号收敛到 --fs-s（默认档 12px，比原 13px 小一级、仍比 11px 的日期/作者高一层级），
          // 配合行内边距由 3px 收到 2px，单条记录更紧凑，一屏能多看几行。
          fontSize: 'var(--fs-s)', lineHeight: 1.3,
        }}>
        {text}
      </span>
      {box && createPortal(
        <span data-lck="git-tree-subject-tooltip" role="tooltip"
          style={{
            position: 'fixed', left: box.left, top: box.top, maxWidth: box.maxWidth, width: 'max-content',
            display: 'block', zIndex: 2000, pointerEvents: 'none', padding: '6px 10px', borderRadius: 6,
            background: 'var(--card-bg)', color: 'var(--text)', border: '1px solid var(--border-strong)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)', fontSize: 'var(--fs-s)', lineHeight: 1.45,
            whiteSpace: 'normal', overflowWrap: 'anywhere',
          }}>
          {text}
        </span>, document.body)}
    </>
  );
}

/**
 * 提交行 + 详情行。单仓库列表和分组视图里每个仓库的列表共用这一段 JSX，
 * 差别只在 `keyPrefix`（同一 SHA 可能在两个仓库的窗口里各出现一次，展开态不能串）。
 *
 * 车道按**各自那份 commits** 计算：方案 §9.3——跨仓库拼车道会画出根本不存在的父子连线。
 */
function CommitRows({ commits, selected, expandedSet, keyPrefix, onRowClick, onToggleRowExpand, compactRefs = false, colorIndex, repoTintOf }: {
  readonly commits: GitTreeCommit[];
  readonly selected: readonly string[];
  readonly expandedSet: Set<string>;
  readonly keyPrefix: string;
  readonly onRowClick: (index: number, e: React.MouseEvent) => void;
  readonly onToggleRowExpand: (sha: string) => void;
  /** T04585：仅聚合视图置真，简化 decorate；平铺视图缺省 false 保持原展示 */
  readonly compactRefs?: boolean;
  /** T05210：仓库色索引（与右栏同一份）；未提供则不画色条 */
  readonly colorIndex?: Record<string, number>;
  /** T05210：本行所属仓库的色键；返回 null/undefined 表示这一行不上色（单仓库视图） */
  readonly repoTintOf?: (c: GitTreeCommit) => string | null | undefined;
}) {
  const lanes = assignLanes(commits);
  // T04912：混合时间线跨仓库拼车道会画出根本不存在的父子连线（方案 §9.3），有仓库标签时一律不画
  const hasRepoTags = commits.some((c) => !!c.repoLabel);
  const tintKeys = repoTintOf && colorIndex
    ? commits.map((c) => repoTintOf(c)).filter((k): k is string => !!k)
    : [];
  const tinted = new Set(tintKeys).size > 1;
  return (
    <>
      {commits.map((c, i) => {
        const checked = selected.includes(c.sha);
        const open = expandedSet.has(`${keyPrefix}${c.sha}`);
        const tintKey = tinted ? repoTintOf?.(c) : null;
        return (
          /* 行本身只是布局容器；「点选这一条」落到行内的原生 <button> 上（Shift/Ctrl 框选语义不变） */
          <div key={`${keyPrefix}${c.sha}`} data-lck="git-tree-row" data-sha={c.sha} data-selected={checked ? '1' : '0'}
            style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap', overflow: 'hidden', padding: '2px 8px', borderBottom: '1px solid var(--border)', background: checked ? 'var(--gt-row-selected)' : 'transparent' }}>
            {/* T05210：仓库色条（IDEA 的变更集色块）——与右栏文件名同色，形成左→右视觉关联 */}
            {tintKey && colorIndex ? <RepoStripe repoKey={tintKey} colorIndex={colorIndex} /> : null}
            {/* 复选框只是勾选态的视觉镜像（真正的控件是右侧按钮）；点它同样落到同一段点选逻辑上 */}
            <input type="checkbox" checked={checked} readOnly tabIndex={-1} aria-label={`选择提交 ${c.short}`}
              onClick={(e) => onRowClick(i, e)} style={{ cursor: 'pointer' }} />
            <button type="button" className="row-title-btn" data-lck="git-tree-select" aria-pressed={checked}
              aria-label={`${checked ? '取消选择' : '选择'}提交 ${c.short}：${c.subject}`}
              onClick={(e) => onRowClick(i, e)}
              style={{
                display: 'flex', gap: 6, alignItems: 'center', flex: '1 1 auto', minWidth: 0,
                padding: 0, border: 'none', background: 'transparent', color: 'inherit',
                font: 'inherit', textAlign: 'left', cursor: 'pointer',
              }}>
              {!hasRepoTags && (
                <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', whiteSpace: 'pre', minWidth: lanes.count * 10 }}>
                  {Array.from({ length: lanes.count }, (_, l) => laneCell(lanes, i, l))}
                </span>
              )}
              <code style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{c.short}</code>
              {/* T05210：仓库图标（带该仓库标识色）——比纯文字标签更快认出「这条来自哪个仓库」 */}
              {c.repoLabel && tintKey && colorIndex && (
                <FolderGit2 size={13} data-lck="git-tree-repo-icon" aria-hidden
                  style={{ flex: '0 0 auto', color: repoColorVar(colorIndex[tintKey]) }} />
              )}
              {/* T04912：来源仓库标识——次要色、单行省略，hover/title 给全称；不用右键查也能区分仓库。
                  T05210：多仓库时标签文字取该仓库标识色，与图标、左色条、右栏文件名四处同源。 */}
              {c.repoLabel && (
                <span data-lck="git-tree-repo-tag" data-repo-sub={c.repoSub ?? ''}
                  title={`来源仓库：${c.repoLabel}`}
                  style={{ ...chipStyle, flex: '0 1 auto', minWidth: 0, maxWidth: 132, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: tintKey && colorIndex ? repoColorVar(colorIndex[tintKey]) : 'var(--text-secondary)', background: 'var(--surface-2)', fontSize: 'var(--fs-xs)' }}>
                  {c.repoLabel}
                </span>
              )}
              <CommitSubject text={c.subject} />
              <CommitRefPills refs={c.refs} compact={compactRefs} />
              <span data-lck="git-tree-date" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fullTime(c.date)}>{relTime(c.date)}</span>
              <span data-lck="git-tree-author" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.author}>{c.author}</span>
            </button>
            <button type="button" className="row-title-btn" onClick={(e) => { e.stopPropagation(); onToggleRowExpand(c.sha); }} aria-label={open ? '收起提交详情' : '展开提交详情'}
              aria-expanded={open} data-lck="git-tree-expand"
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', height: 16 }}>
              {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            </button>
          </div>
        );
      })}
      {commits.map((c) => (expandedSet.has(`${keyPrefix}${c.sha}`) ? (
        <div key={`${keyPrefix}d-${c.sha}`} data-lck="git-tree-detail" data-sha={c.sha}
          style={{ padding: '4px 8px 6px 46px', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontFamily: FONT_MONO, borderBottom: '1px solid var(--border)' }}>
          SHA {c.sha}<br />父 {c.parents.length === 0 ? '(根提交)' : c.parents.join(' ')}<br />
          作者 {c.author} · {fullTime(c.date)} · 选中它等于采集「相对第一父」的增量
          {compactRefs && c.refs.length > 0 && (
            <><br /><span data-lck="git-tree-detail-refs">分支/标签（{c.refs.length}）：{c.refs.map((r) => r.name).join('、')}</span></>
          )}
        </div>
      ) : null))}
    </>
  );
}

/** 仓库行左侧状态徽标（方案 §4.3）：备用仓库不打徽标，避免多仓库场景满屏标签 */
function repoStatusBadge(status: RepoBranchRow['status']): string {
  if (status === 'current') return '当前';
  if (status === 'unbound') return '未绑定';
  if (status === 'unavailable') return '不可用';
  return '';
}

const groupHeadStyle: React.CSSProperties = {
  display: 'flex', gap: 6, alignItems: 'center', width: '100%', padding: '5px 8px',
  border: 'none', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)',
  color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
};

/**
 * T04527：分支 → 仓库 → 提交 三层列表（只在「分支聚合」视图打开时渲染）。
 *
 * 这一层只画结构，不判据：分组/计数/状态/原因全部由 `utils/gitRepoBranchGroups.ts` 算好后传进来，
 * 于是「失败仓库不许隐身」「一次只回传一个仓库」这些能撒谎的边界都有 node 门可钉，不必全靠浏览器实测。
 */
function RepoBranchGroupList({ groups, blocked, activeProjectId, panes, openBranches, openRepos, groupExpanded, scanning, censusDone, colorIndex, multiRepoColored,
  onToggleBranch, onToggleRepo, onLoadRepo, onRowClick, onToggleRowExpand, onSelectAllVisible }: {
  readonly groups: RepoBranchGroup[];
  readonly blocked: RepoBranchRow[];
  readonly activeProjectId: string;
  readonly panes: Record<string, RepoPane>;
  readonly openBranches: readonly string[];
  readonly openRepos: readonly string[];
  readonly groupExpanded: Set<string>;
  readonly scanning: boolean;
  readonly censusDone: boolean;
  /** T05210：仓库色索引（与右栏同源）；`multiRepoColored` 为假时仍用原来的「当前项目 = 强调色」口径 */
  readonly colorIndex: Record<string, number>;
  readonly multiRepoColored: boolean;
  readonly onToggleBranch: (branchKey: string) => void;
  readonly onToggleRepo: (paneKey: string) => void;
  /** 按仓库行取数：一个项目可能有根仓库 + 多个子仓库，只带 projectId 无法定位是哪一个（T04525） */
  readonly onLoadRepo: (row: RepoBranchRow, branchName: string, append: boolean) => void;
  readonly onRowClick: (paneKey: string, index: number, e: React.MouseEvent) => void;
  readonly onToggleRowExpand: (paneKey: string, sha: string) => void;
  readonly onSelectAllVisible: (paneKey: string, check: boolean) => void;
}) {
  return (
    <div data-lck="git-repo-groups"
      style={{ flex: '1 1 auto', minHeight: 180, maxHeight: '100%', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
      {!censusDone && scanning && (
        <p data-lck="git-repo-scanning" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12, margin: 0 }}>
          正在逐仓库读取分支清单（并发 {REPO_SCAN_CONCURRENCY}）…仓库多时会稍等。
        </p>
      )}
      {censusDone && groups.length === 0 && blocked.length === 0 && (
        <p data-lck="git-repo-empty" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12, margin: 0 }}>
          这些仓库没有可比的分支清单：可能是只有一个项目绑定了工作空间，或全部分支都只存在于单个仓库——单仓库视图已经够用。
        </p>
      )}

      {groups.map((group) => {
        const branchOpen = openBranches.includes(group.branchKey);
        return (
          <div key={group.branchKey} data-lck="git-repo-group" data-branch={group.branchName}>
            <button type="button" className="row-title-btn" data-lck="git-repo-branch" aria-expanded={branchOpen} onClick={() => onToggleBranch(group.branchKey)} style={groupHeadStyle}>
              {branchOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
              <GitBranch size={13} style={{ color: 'var(--accent)' }} />
              <span style={{ fontWeight: 600 }}>{group.branchName}</span>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                {group.repos.length} 个仓库{group.repoCount < group.repos.length ? `（可用 ${group.repoCount}）` : ''}
                {group.totalCommits != null ? ` · 已加载 ${group.totalCommits} 个提交` : ''}
              </span>
              {group.repos.length > 1 && (
                <span style={{ ...chipStyle, marginLeft: 'auto' }}>同名分支</span>
              )}
            </button>

            {branchOpen && group.repos.map((row) => {
              const paneKey = paneKeyOf(row.repoKey, group.branchName);
              const pane = panes[paneKey];
              const repoOpen = openRepos.includes(paneKey);
              const badge = repoStatusBadge(row.status);
              const isCurrent = row.projectId === activeProjectId;
              const repoPath = repoPathOf(row.workspacePath, row.repoSub);
              return (
                <div key={paneKey} data-lck="git-repo-repo" data-project={row.projectId} data-repo-sub={row.repoSub || '.'} data-status={row.status}
                  style={{ marginLeft: 12, paddingLeft: 8, borderLeft: '2px solid var(--border)', background: repoOpen ? 'var(--surface-2)' : 'transparent' }}>
                  <button type="button" className="row-title-btn" data-lck="git-repo-repo-toggle" aria-expanded={repoOpen} disabled={!row.available}
                    onClick={() => {
                      const nextOpen = !repoOpen;
                      onToggleRepo(paneKey);
                      if (nextOpen && row.available && !pane) onLoadRepo(row, group.branchName, false);
                    }}
                    style={{ ...groupHeadStyle, background: 'transparent', borderBottom: 'none', padding: '4px 4px', cursor: row.available ? 'pointer' : 'not-allowed', opacity: row.available ? 1 : 0.7 }}>
                    {row.available ? (repoOpen ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />) : <span style={{ width: 11 }} />}
                    {/* T05210：多仓库时仓库图标取该仓库标识色（与右栏文件树同色）；单仓库保持原「当前项目 = 强调色」 */}
                    <FolderGit2 size={13} style={{ color: multiRepoColored ? repoColorVar(colorIndex[row.repoKey]) : (isCurrent ? 'var(--accent)' : 'var(--text-muted)') }} />
                    <span style={{ fontSize: 'var(--fs-s)', color: isCurrent ? 'var(--text)' : 'var(--text-secondary)' }}>{row.repoLabel}</span>
                    {/* 子仓库这一枚标记是「同一目录里不止一个仓库」的直接证据，门与用户都靠它 */}
                    {row.repoSub && <span data-lck="git-repo-repo-nested" style={chipStyle}>目录内仓库</span>}
                    <code style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }} title={repoPath}>{repoPath}</code>
                    {badge && <span data-lck="git-repo-repo-badge" data-badge={badge} style={chipStyle}>{badge}</span>}
                    {row.available && row.commitCount != null && (
                      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>{row.commitCount} 个提交</span>
                    )}
                  </button>
                  {/* 取不到数的仓库：原因贴着它自己那一行，不藏进 tooltip——「为什么没有」正是用户此刻要读的 */}
                  {!row.available && (
                    <p data-lck="git-repo-repo-reason" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', margin: '0 0 6px 24px' }}>
                      {row.unavailableReason}
                    </p>
                  )}
                  {repoOpen && row.available && (
                    <div style={{ paddingBottom: 6 }}>
                      {pane?.loading && <p style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 6, margin: 0 }}>取数中…</p>}
                      {pane && !pane.loading && pane.error && (
                        <p data-lck="git-repo-repo-error" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', padding: '2px 6px', margin: 0 }}>
                          {pane.error}
                          <button type="button" onClick={() => onLoadRepo(row, group.branchName, false)} style={{ ...boxStyle, marginLeft: 6 }}>重试</button>
                        </p>
                      )}
                      {pane && !pane.loading && !pane.error && pane.commits.length === 0 && (
                        <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', padding: '2px 6px', margin: 0 }}>这条分支在本仓库当前窗口内没有提交（同名不等于同源）。</p>
                      )}
                      {pane && !pane.loading && (
                        <CommitRows commits={pane.commits} selected={pane.selected} expandedSet={groupExpanded} keyPrefix={`${paneKey}\n`}
                          onRowClick={(index, e) => onRowClick(paneKey, index, e)}
                          onToggleRowExpand={(sha) => onToggleRowExpand(paneKey, sha)} compactRefs />
                      )}
                      {pane && pane.hasMore && (
                        <button type="button" data-lck="git-repo-load-more" onClick={() => onLoadRepo(row, group.branchName, true)}
                          disabled={pane.loading} style={{ ...boxStyle, marginLeft: 6 }}>
                          加载更多（已显示 {pane.commits.length} 条）
                        </button>
                      )}
                      {pane && pane.commits.length > 0 && (
                        <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-xs)', marginLeft: 6 }}>
                          <input type="checkbox" data-lck="git-repo-select-all" checked={pane.selected.length === pane.commits.length}
                            onChange={(e) => onSelectAllVisible(paneKey, e.target.checked)} />
                          {' '}全选本页
                        </label>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {blocked.length > 0 && (
        <div data-lck="git-repo-blocked" style={{ borderTop: '1px solid var(--border)', padding: '6px 8px' }}>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', margin: '0 0 4px' }}>以下仓库没有可归组的分支清单，但保留在这里说明原因：</p>
          {blocked.map((row) => (
            <div key={row.repoKey} data-lck="git-repo-blocked-row" data-project={row.projectId} data-repo-sub={row.repoSub || '.'} data-status={row.status}
              style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
              <FolderGit2 size={12} style={{ color: 'var(--text-muted)' }} />
              <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>{row.repoLabel}</span>
              <span data-lck="git-repo-repo-badge" data-badge={repoStatusBadge(row.status)} style={chipStyle}>{repoStatusBadge(row.status)}</span>
              <span data-lck="git-repo-repo-reason" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{row.unavailableReason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
