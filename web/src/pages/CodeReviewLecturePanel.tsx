import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FIELD_QUIET, PILL } from '../ui/primitives'; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
import { Ban, ChevronDown, ChevronRight, Download, Eye, GitBranch, ListChecks, RefreshCw, Sparkles, X } from 'lucide-react'; // T03654：折叠箭头统一 lucide
import { api } from '../api/client';
import { streamEvents, GATE_BUSY_MSG } from '../api/sse';
import { describeStreamFailure } from '../api/streamError'; // T03999：传输层断连补可操作说明
import type { Project } from '../api/client';
import { ProjectScopePicker } from '../ui/projectScopePicker';
import { GitTreePickerModal } from '../ui/GitTreePickerModal';
import { AuthorMultiSelect, BranchPicker, DateRangeField } from '../ui/GitScopeControls';
import { buildSinceWindow, type BranchOption } from '../utils/scopeControls';
import { FlowButton } from '../ui/FlowButton';
import { FlowProgress } from '../ui/FlowProgress';
import { Markdown } from '../ui/Markdown';
import { useSessionState } from '../ui/session';
import {
  codeReviewLectureStore,
  useCodeReviewLecture,
  type LectureOutline,
  type LectureDeviationDimension,
  type LectureRunUsageDeviation,
  type LectureSectionResult,
  type LectureStreamResult,
} from '../stores/codeReviewLectureStore';
import {
  anchorHitRowIds,
  anchorLocateMessage,
  diffRowDomId,
  groupFilesByModule,
  linkifyLectureAnchors,
  locateAnchor,
  parseAnchorHref,
  type LectureAnchorHit,
  type LectureDiffFile,
  type LectureDiffProject,
  type LectureDiffView,
} from '../utils/lectureDiff';
import { DiffFileView } from '../ui/DiffView';
import {
  applyMarksToSection,
  assembleLectureExport,
  lectureMarkKey,
  splitLectureBlocks,
  type LectureMark,
} from '../utils/lectureMarkup';
import { saveBlob } from '../utils/download';
import { AiProvenanceSection } from '../components/AiProvenance'; // T03262（AI-101①④）：溯源面板 + 产物找回

/**
 * 代码评审会议讲稿 · 工作面板（六期 3.1 / T02872，PRD §6.1 三区布局、§6.2 锚点交互）。
 *
 * 三区：**左** diff 面板（文件树 + unified diff，hunk 可折叠）；**右** 讲稿流式面板（八段手风琴，逐段流出）；
 * **底** 状态条（阶段文案 + 进度 + 停止 + 导出槽位）。
 * 锚点 `[file#Lx-Ly]` 点击 = 左栏滚动定位 + 1.5s 闪烁（`.locate-flash` 的时长与 PRD 同源）；
 * hover 该条 = 左栏对应行加底色；无锚点条目（开场/结语类）不渲染交互。
 *
 * 两段式（FR-4.1）：「只出大纲」走同一 SSE 端点的 `outlineOnly`，大纲出来后就地确认，
 * 再「按大纲生成正文」把大纲回传——服务端收到 outline 即跳过大纲 AI 调用（见 lectureStream.ts）。
 *
 * T02873：风险/建议条目行尾三态标记（采纳 / 会后跟进 / 忽略），忽略项折叠且不进导出稿；
 * 「停止」保留已生成节，可「从第 n 节继续」或对失败节「重试本节」（服务端 resumeFrom / sectionKeys）。
 * 同里程碑后续单接手：导出链路（T02874，本单只留状态条槽位）、预检面板与超限两条路（T02875）。
 */

const RANGE_SHAPES = [
  { key: 'base-head', label: 'base..head（分支/标签/SHA）' },
  { key: 'first-last', label: '首末 SHA' },
  { key: 'since', label: '时间窗（--since）' },
] as const;
type RangeShape = (typeof RANGE_SHAPES)[number]['key'];
/** 导出格式（S4323：union 收成类型别名，状态与子组件入参共用同一口径） */
type ExportFormat = 'md' | 'docx' | 'pptx';

const fieldStyle: React.CSSProperties = FIELD_QUIET; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
const chipStyle: React.CSSProperties = PILL; // PM-302 ① 单源 ui/primitives.ts（取值与整改前逐字段相同）
const FONT_MONO = 'Consolas, Menlo, monospace';

/** 文件级展开态键 */
const fileKey = (projectId: string, path: string) => `${projectId}|${path}`;

/** T02875：预检响应（统计面 + 预算估算，服务端 `lectureScope`/`lecturePreflight` 的镜像） */
interface LecturePreflightProject {
  projectId: string;
  projectName: string;
  workspacePath: string;
  mode: 'git' | 'patch';
  rangeLabel: string;
  git: { available: boolean; isRepo: boolean };
  stats: { commits: number; files: number; additions: number; deletions: number };
  excluded: { count: number };
  kept: { files: number; additions: number; deletions: number; chars: number };
  budget: { dropped: number; droppedNames: string[]; limit: number; truncated: boolean };
  warnings: string[];
  blocked?: string;
}
interface LecturePreflight {
  projects: LecturePreflightProject[];
  totals: {
    projects: number; ready: number; commits: number; files: number; additions: number; deletions: number;
    excluded: number; keptFiles: number; keptChars: number;
  };
  ok: boolean;
  warnings: string[];
  /** T03174 新增字段为可选：旧服务端响应（打包实例滞后 dist）缺省时回退点值展示 */
  estimate: { groups: number; calls: number; seconds: number; secondsLow?: number; secondsHigh?: number; contextChars: number; contextBudget: number; modelVersion?: string };
}

const fmtSeconds = (s: number): string => (s >= 60 ? `${Math.ceil(s / 60)} 分钟` : `${s} 秒`);

/**
 * T03245（AI-103③）：`GET /plans/code-review-lecture/jobs/latest` 的台账视图
 * （服务端 `AiGenJournal.GenJobView` + 节中文名）。刷新/重进后面板据此显示上次进度。
 */
interface LectureJournalSegment {
  sectionKey: string;
  segmentKey: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  text: string;
  error: string | null;
  attempts: number;
}
interface LectureJournalSection {
  key: string;
  label: string;
  total: number;
  done: number;
  failed: number;
  segments: LectureJournalSegment[];
}
interface LectureJournalView {
  id: string;
  status: 'running' | 'done' | 'partial' | 'aborted' | 'error';
  createdAt: string;
  updatedAt: string;
  progress: { sectionsTotal: number; sectionsDone: number; segmentsTotal: number; segmentsDone: number; segmentsFailed: number };
  sections: LectureJournalSection[];
}

const JOURNAL_STATUS_LABEL: Record<LectureJournalView['status'], string> = {
  running: '上次运行中断',
  done: '已完成',
  partial: '部分段失败',
  aborted: '已中止',
  error: '上次运行失败',
};

/** T03174（AI-102⑤，D-04）：与服务端 `preflightEstimate.PROXY_METRIC_NOTICE` 同字面量（门比对一致，前端不能 import 服务端模块） */
const PROXY_METRIC_NOTICE = '用量为代理指标（调用次数/字符量/耗时），非金额';

/**
 * 续作/重试结果拼接：服务端只回「从 resumeFrom 起（或点名的节）」的 sections，
 * 之前已完成的节取上一轮结果（或流式实时正文），按大纲顺序重排并重算整体 ok。
 * 全新一轮（replaceFromKey 为空）不拼接，避免把上一轮旧节混进新稿。
 */
function mergeLectureRun(
  before: {
    outline: LectureOutline | null;
    result: LectureStreamResult | null;
    live: Record<string, string>;
    sectionOk: Record<string, boolean>;
  },
  next: LectureStreamResult | null,
  replaceFromKey?: string,
): LectureStreamResult | null {
  if (!next || !replaceFromKey) return next;
  const outline = next.outline ?? before.outline ?? undefined;
  if (!outline) return next;
  const prior = new Map<string, LectureSectionResult>();
  if (before.result) {
    before.result.sections.forEach((s) => prior.set(s.key, s));
  } else {
    for (const [key, text] of Object.entries(before.live)) {
      const meta = outline.sections.find((s) => s.key === key);
      if (meta && text.trim()) {
        prior.set(key, { key, label: meta.title, ok: before.sectionOk[key] !== false, text: text.trim(), segments: [] });
      }
    }
  }
  next.sections.forEach((s) => prior.set(s.key, s));
  const sections = outline.sections.map((s) => prior.get(s.key)).filter((s): s is LectureSectionResult => s !== undefined);
  const ok = sections.length === outline.sections.length && sections.every((s) => s.ok);
  return { ...next, outline, sections, ok };
}

/** Set 成员切换（diff 文件展开 / hunk 折叠 / 手风琴节共用），始终返回新 Set 以触发重渲染 */
function toggleInSet(prev: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) { next.delete(key); } else { next.add(key); }
  return next;
}

/** 采集入参（T05682：只剩「按提交清单」一条路径——Git 树点选 ∪ 已完成任务勾选） */
interface ScopeInput {
  readonly selectedIds: readonly string[];
  readonly selectedCommits: Readonly<Record<string, string[]>>;
  /** T04576：每个项目这批提交来自工作空间目录内的哪个仓库（缺省 = 项目根仓库） */
  readonly selectedRepoSubs: Readonly<Record<string, string>>;
}

/** 采集入参：T05682 起只有一条路径——按项目提交清单采集（Git 树点选 ∪ 已完成任务勾选） */
function buildScopeBody(input: ScopeInput): { body?: Record<string, unknown>; error?: string } {
  if (input.selectedIds.length === 0) return { error: '请先选择项目' };
  const missing = input.selectedIds.filter((projectId) => (input.selectedCommits[projectId] ?? []).length === 0);
  if (missing.length > 0) {
    return { error: `${missing.length} 个项目还没有选择提交——请用「从 Git 树选范围」或勾选「已完成任务」` };
  }
  const projects = input.selectedIds.map((projectId) => {
    const picked = input.selectedCommits[projectId] ?? [];
    // T04576：`shape='commits'` 带上仓库维度——子仓库的 SHA 若按根仓库下发，服务端会整批判 missing
    const repoSub = (input.selectedRepoSubs[projectId] ?? '').trim();
    return { projectId, range: { shape: 'commits', commits: picked, ...(repoSub ? { repoSub } : {}) } };
  });
  return { body: { projects } };
}

/** 一轮生成的入参规划结果（流式调用的 body + 续作/重试落点） */
interface RunPlan {
  readonly retryJob: boolean;
  readonly body: Record<string, unknown>;
  readonly resumeFrom?: string;
  readonly retryKeys?: string[];
  readonly error?: string;
}

function planRun(extra: Record<string, unknown>, ctx: {
  readonly scopeError?: string;
  readonly scopeBody?: Record<string, unknown>;
  readonly toolId: string;
}): RunPlan {
  const retryJob = typeof extra.jobId === 'string' && extra.retryFailed === true;
  // T03245（AI-103②③）：台账重试按服务端留档入参重建，不看当前面板范围（刷新后范围 UI 可能已变）
  if (!retryJob && ctx.scopeError) return { retryJob, body: {}, error: ctx.scopeError };
  // 台账重试用服务端留档的 toolId，刷新后新会话没选工具也能恢复
  if (!retryJob && !ctx.toolId) return { retryJob, body: {}, error: '请先在右侧控制台选择 AI 工具' };
  const resumeFrom = typeof extra.resumeFrom === 'string' ? extra.resumeFrom : undefined;
  const retryKeys = Array.isArray(extra.sectionKeys) ? (extra.sectionKeys as string[]) : undefined;
  const body = retryJob
    ? { jobId: extra.jobId, retryFailed: true, ...(ctx.toolId ? { toolId: ctx.toolId } : {}) }
    : { ...ctx.scopeBody, toolId: ctx.toolId, ...extra };
  return { retryJob, body, resumeFrom, retryKeys };
}

/** SSE `stage` 帧的数据面（服务端 lectureStream 镜像） */
interface StageFramePayload {
  phase: string;
  msg: string;
  progress: number;
  data?: { type?: string; outline?: LectureOutline; section?: string; ok?: boolean; jobId?: string };
}

/** 一轮生成的可变上下文：流式帧回调需要跨帧累计大纲 / 错误 / 任务 id */
interface StreamRunCtx {
  outline: LectureOutline | undefined;
  errMsg: string;
  /** 任务 id 落点（写回 `jobIdRef.current`，续作/单节重试都靠它复用已完成段） */
  readonly setJobId: (id: string) => void;
  readonly before: {
    outline: LectureOutline | null;
    result: LectureStreamResult | null;
    live: Record<string, string>;
    sectionOk: Record<string, boolean>;
  };
  readonly resumeFrom?: string;
  readonly retryKeys?: string[];
  readonly flash: (m: string) => void;
}

function applyStageFrame(payload: unknown, ctx: StreamRunCtx): void {
  const s = payload as StageFramePayload;
  codeReviewLectureStore.setStage({ phase: s.phase, msg: s.msg, progress: s.progress });
  const data = s.data;
  if (!data) return;
  // T03246：任务一落库就记住 id——停止时收不到 aborted 帧，续作只能靠这里留下的 id 复用已完成段
  if (data.type === 'job' && typeof data.jobId === 'string') ctx.setJobId(data.jobId);
  if (data.type === 'outline_ready' || data.type === 'outline_only') {
    if (data.outline) { ctx.outline = data.outline; codeReviewLectureStore.setOutline(data.outline); }
    return;
  }
  if (data.type === 'section_done' && data.section) codeReviewLectureStore.setSectionOk(data.section, data.ok === true);
}

function applyDoneFrame(payload: unknown, ctx: StreamRunCtx): void {
  const d = payload as LectureStreamResult;
  if (d?.outline) { ctx.outline = d.outline; codeReviewLectureStore.setOutline(d.outline); }
  if (d?.jobId) ctx.setJobId(d.jobId);
  codeReviewLectureStore.setResult(mergeLectureRun(ctx.before, d ?? null, ctx.resumeFrom ?? ctx.retryKeys?.[0]));
}

function applyAbortedFrame(payload: unknown, ctx: StreamRunCtx): void {
  // 用户主动「停止」：服务端把已完成的节次交回，保留下来供「从第 n 节继续」
  const d = payload as LectureStreamResult;
  if (d?.outline) codeReviewLectureStore.setOutline(d.outline);
  if (d?.jobId) ctx.setJobId(d.jobId);
  codeReviewLectureStore.setResult(d ?? null);
  const kept = d?.sections?.length ?? 0;
  // T03301：停止是关键节点，控制台要有一行收口日志（此前只在面板 toast 里提示，控制台看不出发生过什么）
  codeReviewLectureStore.pushLog(`已停止——已生成 ${kept} 节已保留，可「从第 n 节继续」`);
  codeReviewLectureStore.finish();
  ctx.flash(`已停止——已生成 ${kept} 节已保留，可「从第 n 节继续」`);
}

/** 单帧分派：按事件名落到对应处理，避免把整条 if/else 链堆在组件内联回调里 */
function handleStreamFrame(name: string, payload: unknown, ctx: StreamRunCtx): void {
  if (name === 'stage') { applyStageFrame(payload, ctx); return; }
  if (name === 'chunk') {
    const c = payload as { section: string; text: string };
    codeReviewLectureStore.appendLive(c.section, c.text);
    return;
  }
  if (name === 'done') { applyDoneFrame(payload, ctx); return; }
  if (name === 'aborted') { applyAbortedFrame(payload, ctx); return; }
  if (name === 'error') ctx.errMsg = (payload as { error: string }).error ?? '生成失败';
}

/** T03301：完成是关键节点——写一行带产出量的收口日志（节数/锚点/降级），控制台据此判断这轮到底产出了什么 */
function logRunFinished(): void {
  const done = codeReviewLectureStore.get().result;
  if (!done) return;
  const okCount = done.sections.filter((s) => s.ok).length;
  const degradePart = done.warnings.length > 0 ? ` · 降级 ${done.warnings.length} 处` : '';
  codeReviewLectureStore.pushLog(`生成完成：${okCount}/${done.sections.length} 节 · 锚点 ${done.stats.anchors} 个${degradePart}`);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function CodeReviewLecturePanel({ projectIds, onProjectIdsChange, projects, toolId, onClose }: {
  readonly projectIds: string[];
  /** T03311：与顶部「报表范围」同一份 state——卡片内改选即写回，顶部改选本卡片自动回填 */
  readonly onProjectIdsChange: (ids: string[]) => void;
  readonly projects: Project[];
  readonly toolId: string;
  readonly onClose: () => void;
}) {
  const snap = useCodeReviewLecture();
  const [shape, setShape] = useSessionState<RangeShape>('lecture.rangeShape', 'base-head');
  const [base, setBase] = useSessionState('lecture.base', '');
  const [head, setHead] = useSessionState('lecture.head', '');
  const [since, setSince] = useSessionState('lecture.since', '');
  // T03590：时间窗右端（日期范围控件的结束日）；空 = 与改造前的单 since 完全一致
  const [until, setUntil] = useSessionState('lecture.until', '');
  // T03303：提交人过滤（甲 / 甲, 乙（且）/ 甲 | 乙（或）），与区间一起提交，服务端按 author+committer 精确比对
  const [authorFilter, setAuthorFilter] = useSessionState('lecture.authorFilter', '');
  // T03590：分支/标签候选（所选项目的引用并集）与提交人候选（仓库最近提交的 author/committer）
  const [branchOptions, setBranchOptions] = useState<BranchOption[]>([]);
  const [authorOptions, setAuthorOptions] = useState<string[]>([]);
  const branchRequested = useRef(false);
  const authorsRequested = useRef(false);
  /** T03302：Git 树点选的提交（按项目分别存）——非空即该项目走 `shape='commits'`，优先于手填区间 */
  const [selectedCommits, setSelectedCommits] = useSessionState<Record<string, string[]>>('lecture.selectedCommits', {});
  // T05682：已完成任务勾选——每个任务带自己的关联提交，与 Git 树点选可叠加
  const [doneTasks, setDoneTasks] = useState<DoneTask[]>([]);
  const [checkedTaskIds, setCheckedTaskIds] = useState<string[]>([]);
  /** T04576：Git 树确认时一并记住仓库维度（与 selectedCommits 同生命周期；空串 = 项目根仓库） */
  const [selectedRepoSubs, setSelectedRepoSubs] = useSessionState<Record<string, string>>('lecture.selectedRepoSubs', {});
  const [gitTreeOpen, setGitTreeOpen] = useState(false);
  const [patchMode, setPatchMode] = useSessionState('lecture.patchMode', false);
  const [patchText, setPatchText] = useState('');
  const [exportFormat, setExportFormat] = useSessionState<ExportFormat>('lecture.exportFormat', 'md');
  // T05696：导出/预检运行态改从 store 快照读——卡片切走再切回，按钮 loading 不再丢
  const exporting = snap.exporting;
  /** T02875：预检覆盖层 + 「裁剪继续」要接着跑的意图 */
  const [preflight, setPreflight] = useState<LecturePreflight | null>(null);
  const preflightLoading = snap.preflightLoading;
  const pendingRun = useRef<{ extra: Record<string, unknown>; label: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [foldedHunks, setFoldedHunks] = useState<Set<string>>(new Set());
  /** 锚点闪烁的行标识；seq 每次点击自增，让同一行的 CSS 动画重放（PRD 要求 1.5s 闪烁） */
  const [flashRows, setFlashRows] = useState<{ ids: Set<string>; seq: number } | null>(null);
  const [hoverRows, setHoverRows] = useState<Set<string>>(new Set());
  /** T03245（AI-103③）：上次未完成任务的台账——刷新/重进后从服务端回读，不依赖前端记忆 */
  const [journal, setJournal] = useState<LectureJournalView | null>(null);
  /**
   * T03246（AI-103④）：本轮任务的 jobId——stage `job` 事件一落地就记住（停止时前端收不到 aborted 帧，
   * 不能只指望 done/aborted 带回）；续作/单节重试带上它，服务端才会复用已完成段、不再重复调用模型。
   */
  const jobIdRef = useRef<string | null>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (m: string) => {
    setNotice(m);
    globalThis.setTimeout(() => setNotice(''), 3600);
  };

  const selectedIds = projectIds.length > 0 ? projectIds : projects.map((p) => p.id);
  // T05682：已完成任务勾选——每个任务带自己的关联提交，与 Git 树点选可叠加
  const selectedKey = selectedIds.join(',');
  useEffect(() => {
    if (!selectedKey) { setDoneTasks([]); setCheckedTaskIds([]); return undefined; }
    let alive = true;
    void api.get<{ ok: boolean; tasks: DoneTask[] }>(`/git/done-task-commits?projectIds=${encodeURIComponent(selectedKey)}`)
      .then((r) => { if (alive) setDoneTasks(r.tasks ?? []); })
      .catch(() => { if (alive) setDoneTasks([]); });
    return () => { alive = false; };
  }, [selectedKey]);
  /** 勾选任务的提交并入 Git 树点选集（同项目取并集），下游仍走既有 commits 协议 */
  const mergedCommits = useMemo(() => {
    const out: Record<string, string[]> = { ...selectedCommits };
    for (const t of doneTasks) {
      if (!checkedTaskIds.includes(t.id)) continue;
      out[t.projectId] = [...new Set([...(out[t.projectId] ?? []), ...t.commits.map((c) => c.sha)])];
    }
    return out;
  }, [selectedCommits, doneTasks, checkedTaskIds]);
  const toggleTask = useCallback((id: string, checked: boolean) => {
    setCheckedTaskIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  }, []);
  const projectKey = selectedIds.join('|');

  // 项目集合变了：上一批候选可能来自别的仓库，作废缓存（真正取数推迟到展开下拉时）
  useEffect(() => {
    branchRequested.current = false;
    authorsRequested.current = false;
    setBranchOptions([]);
    setAuthorOptions([]);
  }, [projectKey]);

  /**
   * T03590：分支下拉的选项来自所选项目的引用装饰（`git log --all` 已有口径）——只做并集，不引入新 git 语义。
   * 按需触发（展开下拉才取）：默认范围是「全部项目」，进面板就逐仓取数会把打开卡片变成一次批量扫描。
   * 取不到就留空：输入框始终可以手输，下拉只是少了一份候选，不阻塞任何采集路径。
   * 窗口取 200 条而非首页默认 100：refs 是「当前页提交上的装饰」，窗口太窄会只剩 HEAD 那一条的分支名。
   */
  async function loadBranchOptions() {
    if (branchRequested.current) return;
    branchRequested.current = true;
    const merged = new Map<string, BranchOption>();
    for (const projectId of selectedIds) {
      try {
        const r = await api.post<{ ok: boolean; refs?: BranchOption[] }>('/plans/code-review-lecture/git-log', { projectId, all: true, limit: 200 });
        (r.refs ?? []).forEach((ref) => merged.set(`${ref.type}:${ref.name}`, ref));
      } catch {
        // 单项目取不到不影响其他项目，也不影响手输
      }
    }
    setBranchOptions([...merged.values()]);
  }

  /** T03590：提交人候选按需拉取（展开下拉才请求），多项目取并集，失败保持空列表 */
  async function loadAuthorOptions() {
    if (authorsRequested.current) return;
    authorsRequested.current = true;
    const names = new Set<string>();
    for (const projectId of selectedIds) {
      try {
        const r = await api.post<{ ok: boolean; authors?: string[] }>('/plans/code-review-lecture/git-authors', { projectId });
        (r.authors ?? []).forEach((n) => names.add(n));
      } catch {
        // 候选名单只提升输入效率，取不到就让用户手输
      }
    }
    setAuthorOptions([...names]);
  }

  /** T03302：Git 树点选摘要——只报当前报表范围里确实点过的项目，范围外残留不显示也不参与采集 */
  const pickedProjects = useMemo(() => selectedIds
    .map((projectId) => ({ projectId, projectName: projects.find((p) => p.id === projectId)?.name ?? projectId, shas: selectedCommits[projectId] ?? [] }))
    .filter((p) => p.shas.length > 0), [selectedIds, selectedCommits, projects]);

  const clearPicked = (projectId: string) => {
    setSelectedCommits((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setSelectedRepoSubs((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  };

  /**
   * T05700：勾选「已完成任务」时，提交来自哪个子仓库（repoSub）必须跟着走。
   * 旧实现 mergedCommits 只取 `c.sha` 并按 projectId 合成一维数组，repoSub 全丢 ——
   * 服务端按工作空间根仓库解析子仓库 SHA，整批 --no-walk fatal，被误报成「rebase/force-push 丢弃」。
   */
  const repoScopePlan = useMemo(() => {
    // 先按项目聚合「所有已勾选任务」涉及的仓库——逐个任务判定会漏掉「三个任务分属三个仓库」这类冲突
    const byProject = new Map<string, Set<string>>();
    for (const t of doneTasks) {
      if (!checkedTaskIds.includes(t.id)) continue;
      const set = byProject.get(t.projectId) ?? new Set<string>();
      for (const c of t.commits) {
        const sub = (c.repoSub ?? '').trim();
        set.add(sub === '.' ? '' : sub);
      }
      byProject.set(t.projectId, set);
    }
    const subs: Record<string, string> = { ...selectedRepoSubs };
    const conflicts: string[] = [];
    for (const [pid, set] of byProject) {
      const fromTree = (selectedRepoSubs[pid] ?? '').trim();
      if (fromTree && fromTree !== '.') set.add(fromTree);
      const uniq = [...set];
      if (uniq.length > 1) {
        const names = uniq.map((s) => s || '根仓库').join('、');
        conflicts.push(`项目下勾选的提交跨了 ${uniq.length} 个 Git 仓库（${names}）`);
      } else if (uniq.length === 1) {
        subs[pid] = uniq[0];
      }
    }
    // 服务端一个项目只允许一个 range / 一个 repoSub（lectureScope 禁止重复 projectId），
    // 跨仓库混合无法在一个 range 表达 —— 明确阻断并给出分批办法，优于让 Git 报误导性「提交不存在」。
    return {
      subs,
      error: conflicts.length
        ? `${[...new Set(conflicts)].join('；')}。一次只能采集同一仓库的提交，请按仓库分批勾选已完成任务后分别「加载 diff」`
        : '',
    };
  }, [selectedRepoSubs, doneTasks, checkedTaskIds]);

  /** 采集入参：一次评审共用一份区间；patch 模式单项目（E-1 降级通道） */
  const scopeBody = useMemo(
    () => (repoScopePlan.error
      ? { error: repoScopePlan.error }
      : buildScopeBody({ selectedIds, selectedCommits: mergedCommits, selectedRepoSubs: repoScopePlan.subs })),
    [selectedIds, mergedCommits, repoScopePlan],
  );

  useEffect(() => () => {
    if (flashTimer.current) globalThis.clearTimeout(flashTimer.current);
    codeReviewLectureStore.setAbortCtrl(null);
  }, []);

  /**
   * T03245（AI-103③）：回读最近一次任务台账。只有「未完成」的任务值得提示——
   * 已完成任务的成稿已在右栏/历史里，再弹一条恢复横幅只会打扰。
   * T03246（AI-103④）：停止是「客户端先断开、服务端随后才把在跑段标失败并落终态」，
   * 立刻回读会拿到 running 旧快照（横幅写「上次运行中断 / 继续生成未完成段」）——
   * 读到 running 就短暂轮询，等终态落地再展示。
   */
  const refreshJournal = useCallback(async () => {
    for (let i = 0; i < 12; i += 1) {
      try {
        const view = await api.get<LectureJournalView | null>('/plans/code-review-lecture/jobs/latest');
        if (view?.status === 'running' && i < 11) {
          await new Promise((r) => { globalThis.setTimeout(r, 300); });
          continue;
        }
        setJournal(view && view.status !== 'done' && view.progress.segmentsTotal > 0 ? view : null);
        return;
      } catch {
        // 台账只服务于恢复提示；读失败不阻塞生成主流程
        return;
      }
    }
  }, []);

  useEffect(() => { void refreshJournal(); }, [refreshJournal]);

  // ---- 左栏：diff 视图 ----
  async function loadDiff() {
    if (scopeBody.error) return flash(scopeBody.error);
    codeReviewLectureStore.setDiffLoading(true);
    try {
      const view = await api.post<LectureDiffView>('/plans/code-review-lecture/diff', scopeBody.body);
      codeReviewLectureStore.setDiff(view.projects);
      // T03301：采集结果也进 AI 控制台日志——只有「开始采集」一行、没有产出条数时，用户无法判断采集是否真的拿到东西
      codeReviewLectureStore.pushLog(`采集完成：可用项目 ${view.totals.ready}/${view.totals.projects}、文件 ${view.totals.files}（排除 ${view.totals.excluded}）`);
      // 默认只展开每个项目的第一个文件：多项目全展开会把左栏变成滚动长墙，锚点点击时再按需展开
      setOpenFiles(new Set(view.projects.flatMap((p) => p.files.slice(0, 1).map((f) => fileKey(p.projectId, f.path)))));
      flash(`diff 已就绪：可用项目 ${view.totals.ready}/${view.totals.projects}、文件 ${view.totals.files}（排除 ${view.totals.excluded}）`);
    } catch (e) {
      codeReviewLectureStore.setDiff([], e instanceof Error ? e.message : String(e));
      codeReviewLectureStore.pushLog(`采集失败：${e instanceof Error ? e.message : String(e)}`);
      flash(`diff 加载失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- 两段式生成（含中止续作 / 单节重试 / 台账重试失败段） ----
  async function runStream(extra: Record<string, unknown>, stageLabel: string) {
    const plan = planRun(extra, { scopeError: scopeBody.error, scopeBody: scopeBody.body, toolId });
    if (plan.error) return flash(plan.error);
    // T03246（AI-103④）：续作沿用同一任务；全新一轮先清空，等 stage job 事件写回新 id
    // ——采集阶段就被停止时不能错挂上一轮任务（会把旧段当成本轮已完成段复用）
    if (plan.retryJob) jobIdRef.current = String(extra.jobId);
    else if (!plan.resumeFrom && !plan.retryKeys) jobIdRef.current = null;
    const ac = new AbortController();
    codeReviewLectureStore.setAbortCtrl(ac);
    // 续作/重试保留已有三态标记；全新一轮才清空
    codeReviewLectureStore.begin(Boolean(plan.resumeFrom || plan.retryKeys));
    codeReviewLectureStore.pushLog(`${stageLabel}：开始采集与上下文装配`);
    const ctx: StreamRunCtx = {
      outline: codeReviewLectureStore.get().outline ?? undefined,
      errMsg: '',
      setJobId: (id: string) => { jobIdRef.current = id; },
      before: codeReviewLectureStore.get(),
      resumeFrom: plan.resumeFrom,
      retryKeys: plan.retryKeys,
      flash,
    };
    try {
      await streamEvents('/plans/code-review-lecture-stream', plan.body, (name, payload) => {
        handleStreamFrame(name, payload, ctx);
        if (name === 'aborted') void refreshJournal();
      }, ac.signal);
      if (ctx.errMsg) {
        codeReviewLectureStore.finish(ctx.errMsg);
        void refreshJournal();
        return flash(ctx.errMsg);
      }
      if (extra.outlineOnly && ctx.outline) codeReviewLectureStore.pushLog('大纲已就绪——右栏确认结构后点「按大纲生成正文」');
      logRunFinished();
      codeReviewLectureStore.finish();
      void refreshJournal();
    } catch (e) {
      const msg = describeStreamFailure(errText(e), { resumable: true }); // T03999：讲稿流有分段台账，断流提示要指到「重试失败段」
      // 用户主动「停止」不是故障：保留已生成章节，不写错误态
      codeReviewLectureStore.finish(ac.signal.aborted ? undefined : msg);
      if (!ac.signal.aborted) flash(msg.includes(GATE_BUSY_MSG) ? `${msg}——请稍后重试` : msg);
      void refreshJournal();
    } finally {
      codeReviewLectureStore.setAbortCtrl(null);
    }
  }

  // ---- T02875：预检覆盖层（FR-7.1 统计面 + FR-7.2 超限两条路） ----
  async function openPreflight(extra: Record<string, unknown>, label: string) {
    if (scopeBody.error) return flash(scopeBody.error);
    if (!toolId) return flash('请先在右侧控制台选择 AI 工具');
    codeReviewLectureStore.setPreflightLoading(true);
    try {
      const p = await api.post<LecturePreflight>('/plans/code-review-lecture/preflight', scopeBody.body);
      pendingRun.current = { extra, label };
      setPreflight(p);
    } catch (e) {
      flash(`预检失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      codeReviewLectureStore.setPreflightLoading(false);
    }
  }

  function continueFromPreflight() {
    const pending = pendingRun.current;
    setPreflight(null);
    pendingRun.current = null;
    if (!pending) return;
    void runStream(pending.extra, pending.label);
  }

  function cancelPreflight() {
    setPreflight(null);
    pendingRun.current = null;
    flash('已中止——请调整项目/区间/排除规则后重新预检');
  }

  // ---- 锚点交互：点击定位 + hover 底色 ----
  function applyHit(hit: LectureAnchorHit | null): { ids: string[]; primary: string } | null {
    if (!hit) return null;
    setOpenFiles((prev) => new Set(prev).add(fileKey(hit.projectId, hit.path)));
    setFoldedHunks((prev) => {
      const next = new Set(prev);
      next.delete(`${fileKey(hit.projectId, hit.path)}|${hit.hunkIndex}`);
      return next;
    });
    return anchorHitRowIds(hit);
  }

  function locateAnchorClick(href: string) {
    const anchor = parseAnchorHref(href);
    if (!anchor) return;
    const projects = codeReviewLectureStore.get().diff;
    const hit = locateAnchor(projects, anchor);
    const ids = applyHit(hit);
    codeReviewLectureStore.pushLog(anchorLocateMessage(anchor, hit, projects));
    if (!ids) return flash(anchorLocateMessage(anchor, null, projects));
    setFlashRows((prev) => ({ ids: new Set(ids.ids), seq: (prev?.seq ?? 0) + 1 }));
    if (flashTimer.current) globalThis.clearTimeout(flashTimer.current);
    flashTimer.current = globalThis.setTimeout(() => setFlashRows(null), 1600);
    // 展开目标文件要等这一帧落地，否则查不到刚渲染出的行
    globalThis.setTimeout(() => {
      leftRef.current?.querySelector(`[data-lck-row="${ids.primary}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  }

  function hoverFromEvent(target: EventTarget | null) {
    const link = (target as HTMLElement | null)?.closest?.('a');
    const href = link?.getAttribute('href') ?? '';
    const anchor = href.startsWith('#lck:') ? parseAnchorHref(href) : null;
    if (!anchor) { setHoverRows(new Set()); return; }
    const hit = locateAnchor(codeReviewLectureStore.get().diff, anchor);
    setHoverRows(new Set(hit ? anchorHitRowIds(hit).ids : []));
  }

  const outline = snap.result?.outline ?? snap.outline ?? undefined;
  const sections = snap.result?.sections ?? [];

  // ---- T02874：导出 md/docx/pptx（标记过滤后送服务端装配，下载走 ai-download 令牌） ----
  async function exportLecture() {
    const result = snap.result;
    if (!result || sections.length === 0) return flash('还没有可导出的讲稿正文——请先完成生成');
    if (snap.streaming) return flash('生成中——请等当前流结束或先「停止」再导出');
    const projectNames = snap.diff.length > 0
      ? snap.diff.map((p) => p.projectName)
      : (result.title.split('·')[1]?.split('、').map((s) => s.trim()).filter(Boolean) ?? []);
    const generatedAt = new Date().toLocaleString('zh-CN');
    const doc = assembleLectureExport({
      title: result.title,
      projectNames,
      sections: result.sections.map((s) => ({ key: s.key, label: s.label, text: s.text })),
      marks: snap.marks,
      generatedAt,
    });
    codeReviewLectureStore.setExporting(true);
    try {
      const created = await api.post<{ token: string; filename: string }>('/plans/code-review-lecture/export', {
        format: exportFormat,
        title: result.title,
        generatedAt,
        markdown: doc.markdown,
        sections: result.sections.map((s) => ({
          key: s.key, label: s.label, text: applyMarksToSection(s.key, s.text, snap.marks).text,
        })),
        followups: doc.followupList,
        ignored: doc.ignored,
      });
      const { blob, filename } = await api.postDownload('/report/ai-download', { token: created.token, filename: created.filename });
      saveBlob(blob, filename);
      codeReviewLectureStore.pushLog(`已导出 ${exportFormat.toUpperCase()}：${filename}（忽略 ${doc.ignored} 条 / 会后跟进 ${doc.followups} 条）`);
      flash(`已导出 ${filename}（忽略 ${doc.ignored} 条，跟进 ${doc.followups} 条）`);
    } catch (e) {
      flash(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      codeReviewLectureStore.setExporting(false);
    }
  }

  // 「从第 n 节继续」/「单节重试」的落点：第一节没正文或上一轮失败的位置
  const outlineSections = outline?.sections ?? [];
  const okBySection = new Map<string, boolean>();
  snap.result?.sections.forEach((s) => okBySection.set(s.key, s.ok));
  Object.entries(snap.sectionOk).forEach(([k, v]) => { if (!okBySection.has(k)) okBySection.set(k, v); });
  const resumeKey = outlineSections.find((s) => !okBySection.has(s.key) || okBySection.get(s.key) === false)?.key;
  const resumeIndex = resumeKey ? outlineSections.findIndex((s) => s.key === resumeKey) + 1 : 0;
  const canResume = !snap.streaming && resumeIndex > 0
    && (snap.result !== null || Object.keys(snap.live).length > 0);
  const markValues = Object.values(snap.marks);
  const followupCount = markValues.filter((m) => m === 'followup').length;
  const ignoredCount = markValues.filter((m) => m === 'ignore').length;

  return (
    <div data-lck="panel" style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 12 }}>
      {notice && <output className="flash-toast">{notice}</output>}
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Sparkles size={16} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 'var(--fs-l)' }}>代码评审讲稿生成</strong>
        <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>左 diff · 右讲稿 · 底状态条（锚点可点击定位）</span>
        <button type="button" onClick={onClose} title="收起面板" aria-label="收起代码评审讲稿面板"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={16} />
        </button>
      </header>

      {/* T03245（AI-103③）：刷新/重进后按服务端台账恢复——进度照实显示，只补未完成段 */}
      {journal && (
        <JournalRestoreBanner journal={journal} streaming={snap.streaming}
          onRetry={(label) => void runStream({ jobId: journal.id, retryFailed: true }, label)}
          onDismiss={() => setJournal(null)} />
      )}

      <LectureScopeSection projects={projects} projectIds={projectIds} onProjectIdsChange={onProjectIdsChange}
        selectedIds={selectedIds} shape={shape} setShape={setShape}
        base={base} setBase={setBase} head={head} setHead={setHead}
        since={since} until={until} setSince={setSince} setUntil={setUntil}
        authorFilter={authorFilter} setAuthorFilter={setAuthorFilter}
        branchOptions={branchOptions} authorOptions={authorOptions}
        loadBranchOptions={loadBranchOptions} loadAuthorOptions={loadAuthorOptions}
        pickedProjects={pickedProjects} clearPicked={clearPicked}
        patchMode={patchMode} setPatchMode={setPatchMode} patchText={patchText} setPatchText={setPatchText}
        streaming={snap.streaming} diffLoading={snap.diffLoading} preflightLoading={preflightLoading}
        onLoadDiff={() => void loadDiff()} onPreflight={openPreflight} onOpenGitTree={() => setGitTreeOpen(true)}
        outline={outline} onOpenOutline={() => void openPreflight({ outlineOnly: true }, '只出大纲')}
        doneTasks={doneTasks} checkedTaskIds={checkedTaskIds} onToggleTask={toggleTask} />

      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', minHeight: 320 }}>
        <aside data-lck="diff-pane" ref={leftRef} aria-label="变更 diff 面板"
          style={{ flex: '1 1 46%', minWidth: 0, maxHeight: 460, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--surface)' }}>
          {snap.diffError && <p data-lck="diff-error" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', margin: '4px 0' }}>diff 加载失败：{snap.diffError}</p>}
          <LectureDiffPane projects={snap.diff} openFiles={openFiles} foldedHunks={foldedHunks}
            flashRows={flashRows} hoverRows={hoverRows}
            onToggleFile={(k) => setOpenFiles((prev) => toggleInSet(prev, k))}
            onToggleHunk={(k) => setFoldedHunks((prev) => toggleInSet(prev, k))} />
        </aside>
        <main data-lck="lecture-pane" aria-label="讲稿面板" onMouseOver={(e) => hoverFromEvent(e.target)} onFocus={(e) => hoverFromEvent(e.target)} onMouseLeave={() => setHoverRows(new Set())}
          style={{ flex: '1 1 54%', minWidth: 0, maxHeight: 460, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--surface)' }}>
          <LectureSections outline={outline} sections={sections} live={snap.live} streaming={snap.streaming}
            marks={snap.marks}
            onMark={(key, m) => codeReviewLectureStore.setMark(key, m)}
            onAnchorClick={locateAnchorClick}
            {...(!snap.streaming && outline && resumeKey
              ? {
                onRetrySection: (key: string, label: string) => void runStream(
                  // T03246（AI-103④）：带 jobId 的单节重试只补该节未完成段，已完成段照旧复用
                  { outline, sectionKeys: [key], ...(jobIdRef.current ? { jobId: jobIdRef.current } : {}) },
                  `重试「${label}」`,
                ),
              }
              : {})} />
        </main>
      </div>

      <LectureStatusFooter stage={snap.stage} streaming={snap.streaming} result={snap.result}
        followupCount={followupCount} ignoredCount={ignoredCount}
        onStop={() => { codeReviewLectureStore.stop(); flash('已停止——右栏已生成的章节保留'); }}
        canResume={canResume} resumeIndex={resumeIndex}
        onResume={() => void runStream(
          { outline: outline ?? snap.outline, resumeFrom: resumeKey, ...(jobIdRef.current ? { jobId: jobIdRef.current } : {}) },
          `从第 ${resumeIndex} 节继续`,
        )}
        provenanceProjectId={selectedIds.length === 1 ? selectedIds[0] : null}
        exportFormat={exportFormat} setExportFormat={setExportFormat} exporting={exporting}
        onExport={() => void exportLecture()} canExport={!snap.streaming && Boolean(snap.result) && sections.length > 0} />

      {gitTreeOpen && (
        <GitTreePickerModal projects={projects.filter((p) => selectedIds.includes(p.id))} activeProjectId={selectedIds[0] ?? ''}
          selectedByProject={selectedCommits}
          onConfirm={(projectId, shas, repoSub) => {
            setSelectedCommits((prev) => ({ ...prev, [projectId]: shas }));
            setSelectedRepoSubs((prev) => ({ ...prev, [projectId]: repoSub }));
            setGitTreeOpen(false);
            const repoNote = repoSub ? ` · 仓库 ${repoSub}` : '';
            flash(`Git 树已选 ${shas.length} 个提交（${projects.find((p) => p.id === projectId)?.name ?? projectId}${repoNote}）`);
          }}
          onClose={() => setGitTreeOpen(false)} />
      )}

      {preflight && (
        <PreflightOverlay preflight={preflight} continueLabel={pendingRun.current?.label ?? '生成'}
          onCancel={cancelPreflight} onContinue={continueFromPreflight} />
      )}
    </div>
  );
}

// ---- 采集范围 / 台账恢复 / 状态条 / 预检覆盖层：条件块下沉为模块级子组件（S3776） ----

/** T03245（AI-103③）：刷新/重进后按服务端台账恢复——进度照实显示，只补未完成段 */
function JournalRestoreBanner({ journal, streaming, onRetry, onDismiss }: {
  readonly journal: LectureJournalView;
  readonly streaming: boolean;
  readonly onRetry: (label: string) => void;
  readonly onDismiss: () => void;
}) {
  const failed = journal.progress.segmentsFailed;
  const retryLabel = failed > 0 ? `重试失败段（${failed}）` : '继续生成未完成段';
  return (
    <section data-t03245="journal-restore" aria-label="未完成的生成任务"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', border: '1px solid var(--warn)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
      <RefreshCw size={14} style={{ color: 'var(--warn)' }} aria-hidden="true" />
      <strong style={{ fontSize: 'var(--fs-s)' }}>上次生成未完成</strong>
      <span data-t03245="journal-progress" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
        {JOURNAL_STATUS_LABEL[journal.status]}：已生成 {journal.progress.segmentsDone}/{journal.progress.segmentsTotal} 段
        {failed > 0 ? `，${failed} 段失败` : ''}
        （{journal.progress.sectionsDone}/{journal.progress.sectionsTotal} 节完成）
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {journal.sections.map((s) => {
          const failedPart = s.failed ? `，${s.failed} 段失败` : '';
          return (
            <span key={s.key} data-t03245="journal-section"
              title={`${s.label}：${s.done}/${s.total} 段已完成${failedPart}`}
              style={{ ...PILL, color: s.failed > 0 ? 'var(--warn)' : 'var(--text-muted)' }}>
              {s.label} {s.done}/{s.total}{s.failed > 0 ? `（失败 ${s.failed}）` : ''}
            </span>
          );
        })}
      </span>
      <FlowButton data-t03245="retry-failed" onClick={() => onRetry(retryLabel)} disabled={streaming}
        title="只为未完成/失败的段发 AI 调用：已完成段直接复用正文，不重复生成">
        <RefreshCw size={13} style={{ marginRight: 4 }} />
        {retryLabel}
      </FlowButton>
      <button type="button" data-t03245="journal-dismiss" onClick={onDismiss}
        style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>
        忽略
      </button>
    </section>
  );
}

/** T05682：已完成任务（含其关联提交）——勾选后按任务范围生成讲稿 */
interface DoneTask {
  readonly id: string;
  readonly taskNo: string;
  readonly title: string;
  readonly projectId: string;
  readonly commits: ReadonlyArray<{ readonly sha: string; readonly repoSub: string }>;
}

interface ScopeSectionProps {
  readonly projects: Project[];
  readonly projectIds: string[];
  readonly onProjectIdsChange: (ids: string[]) => void;
  readonly selectedIds: string[];
  readonly shape: RangeShape;
  readonly setShape: (s: RangeShape) => void;
  readonly base: string;
  readonly setBase: (v: string) => void;
  readonly head: string;
  readonly setHead: (v: string) => void;
  readonly since: string;
  readonly until: string;
  readonly setSince: (v: string) => void;
  readonly setUntil: (v: string) => void;
  readonly authorFilter: string;
  readonly setAuthorFilter: (v: string) => void;
  readonly branchOptions: BranchOption[];
  readonly authorOptions: string[];
  readonly loadBranchOptions: () => Promise<void>;
  readonly loadAuthorOptions: () => Promise<void>;
  readonly pickedProjects: ReadonlyArray<{ readonly projectId: string; readonly projectName: string; readonly shas: string[] }>;
  readonly clearPicked: (projectId: string) => void;
  readonly patchMode: boolean;
  readonly setPatchMode: (v: boolean) => void;
  readonly patchText: string;
  readonly setPatchText: (v: string) => void;
  readonly streaming: boolean;
  readonly diffLoading: boolean;
  readonly preflightLoading: boolean;
  readonly onLoadDiff: () => void;
  readonly onPreflight: (extra: Record<string, unknown>, label: string) => void;
  readonly onOpenGitTree: () => void;
  readonly onOpenOutline: () => void;
  readonly outline?: LectureOutline;
  /** T05682：已完成任务勾选 */
  readonly doneTasks: DoneTask[];
  readonly checkedTaskIds: string[];
  readonly onToggleTask: (id: string, checked: boolean) => void;
}

/** 采集范围区：项目范围 + 区间形态 + 提交人 + Git 树点选摘要 + patch 降级通道 + 采集/预检入口 */
function LectureScopeSection(props: ScopeSectionProps) {
  const {
    projects, projectIds, onProjectIdsChange, selectedIds, shape, setShape, base, setBase, head, setHead,
    since, until, setSince, setUntil, authorFilter, setAuthorFilter, branchOptions, authorOptions,
    loadBranchOptions, loadAuthorOptions, pickedProjects, clearPicked, patchMode, setPatchMode, patchText,
    setPatchText, streaming, diffLoading, preflightLoading, onLoadDiff, onPreflight, onOpenGitTree, onOpenOutline, outline,
    doneTasks, checkedTaskIds, onToggleTask,
  } = props;
  return (
    <section aria-label="采集范围" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
      {/* T03311：不再只读——改选直接写回顶部「报表范围」（空数组=全部项目），两处始终同一份数据 */}
      <div data-lck="scope-picker" style={{ width: 240, maxWidth: '100%' }}>
        {/* T05694：与 Git 提取/Sonar 卡对齐——多项目必须同一工作空间，跨空间候选置灰并写明原因 */}
        <ProjectScopePicker projects={projects} value={projectIds} onChange={onProjectIdsChange} workspaceConstraint />
      </div>
      <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
        已选 {selectedIds.length} 个{projectIds.length === 0 ? '（全部项目）' : ''}，与顶部「报表范围」联动
      </span>
      {/* T05682：区间 / base / head / 提交人 / 粘贴 patch 入口已移除；
          采集范围只来自「从 Git 树选范围」或下方「已完成任务勾选」，两者可混用 */}
      <FlowButton data-lck="git-tree-btn" onClick={onOpenGitTree} disabled={streaming}
        title="打开 Git 树挑提交：单击=勾选/取消（可连点多条）、Shift+单击=框选一段；确认后按选中提交采集">
        <GitBranch size={13} style={{ marginRight: 4 }} />从 Git 树选范围
      </FlowButton>
      {pickedProjects.length > 0 && (
        <span data-lck="git-tree-picked" style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
          {pickedProjects.map((p) => (
            <span key={p.projectId} style={chipStyle}>
              {p.projectName}：Git 树已选 {p.shas.length} 个提交
              <button type="button" onClick={() => clearPicked(p.projectId)} aria-label={`清除 ${p.projectName} 的 Git 树选择`}
                title="清除该项目在 Git 树里的选择"
                style={{ marginLeft: 4, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: 'var(--fs-xs)' }}>×</button>
            </span>
          ))}
        </span>
      )}
      {doneTasks.length > 0 && (
        <div data-lck="done-tasks" style={{ width: '100%', borderTop: '1px dashed var(--border)', paddingTop: 8, marginTop: 2 }}>
          <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 4 }}>
            已完成任务（勾选后按其关联提交生成；{checkedTaskIds.length} / {doneTasks.length} 已选）
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 168, overflow: 'auto' }}>
            {/* T05693：未回写 commit 的任务灰显且禁止勾选——勾了也不产生采集范围，只会让「加载 diff」白跑一趟 */}
            {doneTasks.map((t) => (
              <label key={t.id} title={t.commits.length ? `关联 ${t.commits.length} 个提交` : '该任务未回写 commit，不可勾选（勾了也不会产生采集范围）'}
                style={{ ...chipStyle, display: 'inline-flex', gap: 4, alignItems: 'center', opacity: t.commits.length ? 1 : 0.55, cursor: t.commits.length ? undefined : 'not-allowed' }}>
                <input type="checkbox" checked={checkedTaskIds.includes(t.id)} disabled={!t.commits.length}
                  onChange={(e) => onToggleTask(t.id, e.target.checked)} />
                <span>{t.taskNo} {t.title}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-2xs)' }}>{t.commits.length} 提交</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <FlowButton onClick={onLoadDiff} disabled={streaming} loading={diffLoading} loadingText="采集中"
        title="按当前范围采集 diff 并渲染到左栏">
        <RefreshCw size={13} style={{ marginRight: 4 }} />加载 diff
      </FlowButton>
      <FlowButton data-lck="preflight-btn" onClick={() => onPreflight(outline ? { outline } : { outlineOnly: true }, '预检后继续')}
        disabled={streaming} loading={preflightLoading} loadingText="预检中"
        title="先统计后放行：项目/commit/文件/+−行/排除命中/预算估算/git 可用性">
        <ListChecks size={13} style={{ marginRight: 4 }} />预检
      </FlowButton>
      <FlowButton onClick={onOpenOutline} disabled={streaming}
        title="只出八段骨架大纲（1 次模型调用），确认后再展开正文">
        <Eye size={13} style={{ marginRight: 4 }} />只出大纲
      </FlowButton>
      <FlowButton onClick={() => onPreflight(outline ? { outline } : {}, '生成讲稿正文')} disabled={streaming}
        title={outline ? '按已确认大纲生成八段正文（跳过大纲调用）' : '直接生成八段正文（含一次大纲调用）'}>
        <Sparkles size={13} style={{ marginRight: 4 }} />{outline ? '按大纲生成正文' : '开始生成'}
      </FlowButton>
    </section>
  );
}

/** 单维偏差文案：偏/≈ + 百分比（无可比基数时给「—」） */
function deviationPart(name: string, d: LectureDeviationDimension): string {
  const dir = d.overThreshold ? '偏' : '≈';
  const pct = d.deviation === null ? '—' : `${Math.round(d.deviation * 100)}%`;
  return `${name} ${dir}${pct}`;
}

/** T03243（AI-102②③）：实测与预估的偏差明示——只提示不阻断 */
function DeviationNotice({ deviation }: { readonly deviation: LectureRunUsageDeviation }) {
  const notice = deviation.noticeRequired;
  const dims = [['字符量', deviation.chars], ['耗时', deviation.seconds]] as const;
  const parts = dims.filter(([, d]) => d.expected > 0).map(([n, d]) => deviationPart(n, d)).join(' / ');
  return (
    <span data-lck={notice ? 'usage-deviation-notice' : 'usage-deviation-ok'}
      style={{ fontSize: 'var(--fs-s)', color: notice ? 'var(--warn)' : 'var(--text-muted)', fontWeight: notice ? 600 : 400 }}
      title="预估偏差仅明示、不阻断（AI-102③）；实际值可在 AI 用量记录回看（④）">
      {notice ? '⚠ 实测与预估偏差>50%：' : '用量偏差在阈值内：'}
      {parts}
      {' '}（实际 {deviation.actualCalls} 次调用）
    </span>
  );
}

/** 底部状态条：阶段文案 + 进度 + 计数 + 停止/续作 + 溯源 + 导出 */
function LectureStatusFooter({ stage, streaming, result, followupCount, ignoredCount, onStop, canResume, resumeIndex, onResume, provenanceProjectId, exportFormat, setExportFormat, exporting, onExport, canExport }: {
  readonly stage: { msg: string; progress: number } | null;
  readonly streaming: boolean;
  readonly result: LectureStreamResult | null;
  readonly followupCount: number;
  readonly ignoredCount: number;
  readonly onStop: () => void;
  readonly canResume: boolean;
  readonly resumeIndex: number;
  readonly onResume: () => void;
  readonly provenanceProjectId: string | null;
  readonly exportFormat: ExportFormat;
  readonly setExportFormat: (v: ExportFormat) => void;
  readonly exporting: boolean;
  readonly onExport: () => void;
  readonly canExport: boolean;
}) {
  const stageText = stage?.msg ?? (streaming ? '准备中…' : '未开始（可先「加载 diff」或「只出大纲」）');
  return (
    <footer data-lck="status-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <span data-lck="stage" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', minWidth: 0, flex: '1 1 auto' }}>{stageText}</span>
      <div style={{ width: 150 }}>
        <FlowProgress value={stage?.progress ?? 0} aria-label="讲稿生成进度" />
      </div>
      <span data-lck="anchor-count" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>锚点 {result?.stats.anchors ?? 0}</span>
      {result?.deviation && <DeviationNotice deviation={result.deviation} />}
      <span data-lck="mark-count" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>跟进 {followupCount} · 忽略 {ignoredCount}</span>
      <FlowButton onClick={onStop} disabled={!streaming} title="中止当前生成（已生成的节次保留）">
        <Ban size={13} style={{ marginRight: 4 }} />停止
      </FlowButton>
      {canResume && (
        <FlowButton data-lck="resume-btn" onClick={onResume} disabled={streaming}
          title={`跳过已生成的前 ${resumeIndex - 1} 节，从第 ${resumeIndex} 节开始补生成`}>
          <RefreshCw size={13} style={{ marginRight: 4 }} />从第 {resumeIndex} 节继续
        </FlowButton>
      )}
      {!streaming && (
        <AiProvenanceSection cardKey="ai.code_review_lecture" projectId={provenanceProjectId} refreshKey={result?.title ?? ''} />
      )}
      <select data-lck="export-format" value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
        style={fieldStyle} aria-label="导出格式" disabled={exporting}>
        <option value="md">md 讲稿</option>
        <option value="docx">docx 文稿</option>
        <option value="pptx">pptx 投屏（一页一节 + 讲者备注）</option>
      </select>
      <FlowButton data-lck="export-btn" onClick={onExport} disabled={!canExport}
        loading={exporting} loadingText="导出中" title="按当前标记过滤后导出（忽略项不出现在稿中，会后跟进另列清单）">
        <Download size={13} style={{ marginRight: 4 }} />导出
      </FlowButton>
    </footer>
  );
}

/** git 面文案：patch 模式、未装 git、非仓库、可用四态 */
function gitStatusText(p: LecturePreflightProject): string {
  if (p.mode === 'patch') return '无需 git';
  if (!p.git.available) return '未检测到 git';
  return p.git.isRepo ? 'git 可用' : '非 git 仓库';
}

/** 预估耗时文案：有区间给「下限~上限」，否则给点值 */
function estimateText(est: LecturePreflight['estimate']): string {
  const { secondsLow, secondsHigh } = est;
  const secs = secondsLow !== undefined && secondsHigh !== undefined
    ? `${fmtSeconds(secondsLow)}~${fmtSeconds(secondsHigh)}`
    : fmtSeconds(est.seconds);
  const modelPart = est.modelVersion ? ` · 模型 ${est.modelVersion}` : '';
  return `${est.groups} 个分段组 → 预估 ${est.calls} 次调用 / ${secs} / ${est.contextChars} 字符${modelPart}`;
}

/** T02875：预检覆盖层（FR-7.1 统计面 + FR-7.2 超限两条路）——原生 <dialog> 承载，显隐仍由上方条件控制 */
function PreflightOverlay({ preflight, continueLabel, onCancel, onContinue }: {
  readonly preflight: LecturePreflight;
  readonly continueLabel: string;
  readonly onCancel: () => void;
  readonly onContinue: () => void;
}) {
  return (
    <dialog open data-lck="preflight" aria-modal="true" aria-label="生成前预检"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 16, border: 'none', boxSizing: 'border-box', background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 'min(920px, 96vw)', maxHeight: '84vh', overflow: 'auto', background: 'var(--card-bg)', border: '1px solid var(--accent)', borderRadius: 10, padding: 14 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ListChecks size={16} style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 'var(--fs-l)' }}>生成前预检</strong>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>先统计后放行——超限可「裁剪继续」或「中止收窄范围」</span>
          <button type="button" onClick={onCancel} aria-label="关闭预检"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={15} />
          </button>
        </header>

        <div data-lck="preflight-totals" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
          <span style={chipStyle}>项目 {preflight.totals.ready}/{preflight.totals.projects} 可采集</span>
          <span style={chipStyle}>{preflight.totals.commits} commits</span>
          <span style={chipStyle}>{preflight.totals.files} 文件</span>
          <span style={chipStyle}><span style={{ color: 'var(--success)' }}>+{preflight.totals.additions}</span> / <span style={{ color: 'var(--danger)' }}>-{preflight.totals.deletions}</span></span>
          <span style={chipStyle}>排除命中 {preflight.totals.excluded}</span>
          <span style={chipStyle}>预算内 {preflight.totals.keptFiles} 文件 / {preflight.totals.keptChars} 字符（上限 {preflight.estimate.contextBudget}）</span>
          <span data-lck="preflight-estimate" style={chipStyle}>{estimateText(preflight.estimate)}</span>
          <span data-lck="preflight-notice" style={{ ...chipStyle, color: 'var(--text-muted)' }}>{PROXY_METRIC_NOTICE}</span>
        </div>

        {!preflight.ok && (
          <p data-lck="preflight-blocked" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', margin: '4px 0' }}>
            没有可采集的项目：请补配工作空间路径、调整区间，或改用「粘贴 patch」后重新预检。
          </p>
        )}
        {preflight.warnings.map((w) => <p key={w} style={{ fontSize: 'var(--fs-s)', color: 'var(--warn)', margin: '2px 0' }}>{w}</p>)}

        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {preflight.projects.map((p) => (
            <section key={p.projectId} data-lck={`preflight-project-${p.projectId}`}
              style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--surface)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <strong style={{ fontSize: 'var(--fs-m)' }}>{p.projectName}</strong>
                <span style={chipStyle}>{p.mode === 'patch' ? '粘贴 patch' : p.rangeLabel}</span>
                <span data-lck={`preflight-git-${p.projectId}`} style={{ ...chipStyle, color: p.git.available && p.git.isRepo ? 'var(--success)' : 'var(--danger)' }}>
                  {gitStatusText(p)}
                </span>
                <span style={chipStyle}>{p.stats.commits} commits · {p.stats.files} 文件 · +{p.stats.additions}/-{p.stats.deletions}</span>
                <span style={chipStyle}>排除 {p.excluded.count}</span>
                <span style={chipStyle}>保留 {p.kept.files} 文件 / {p.kept.chars} 字符</span>
              </div>
              {p.blocked && <p style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', margin: '4px 0' }}>{p.blocked}</p>}
              {p.budget.dropped > 0 && (
                <p data-lck="preflight-dropped" style={{ fontSize: 'var(--fs-s)', color: 'var(--warn)', margin: '4px 0' }}>
                  超预算已按优先级丢弃 {p.budget.dropped} 个文件：{p.budget.droppedNames.join('、')}
                  {p.budget.truncated ? '（列表已截断）' : ''}
                </p>
              )}
              {p.warnings.map((w) => <p key={w} style={{ fontSize: 'var(--fs-s)', color: 'var(--warn)', margin: '2px 0' }}>{w}</p>)}
            </section>
          ))}
        </div>

        <footer style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', flex: '1 1 auto' }}>
            「裁剪继续」＝按预算内保留文件生成；被丢弃的文件已点名，不会静默缺稿。
          </span>
          <FlowButton data-lck="preflight-cancel" onClick={onCancel}
            style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }} title="不动代码：回面板调整项目/区间/排除规则">
            中止收窄范围
          </FlowButton>
          <FlowButton data-lck="preflight-continue" onClick={onContinue} disabled={!preflight.ok}
            title={preflight.ok ? '按当前统计面继续（超预算文件按优先级丢弃）' : '没有可采集的项目，无法继续'}>
            裁剪继续 · {continueLabel}
          </FlowButton>
        </footer>
      </div>
    </dialog>
  );
}

// ---- 左栏渲染 ----
/**
 * 单个文件的 diff 行：八期 评审 #8 起复用共享 DiffFileView（与任务抽屉 Git 页同一口径），
 * 锚点/高亮入参逐字保留。抽成模块级组件，避免在父组件里三层嵌套渲染。
 */
function DiffFileRow({ projectId, file, openFiles, onToggleFile, foldedHunks, onToggleHunk, flashRows, hoverRows }: {
  readonly projectId: string;
  readonly file: LectureDiffFile;
  readonly openFiles: ReadonlySet<string>;
  readonly onToggleFile: (key: string) => void;
  readonly foldedHunks: ReadonlySet<string>;
  readonly onToggleHunk: (key: string) => void;
  readonly flashRows: { ids: Set<string>; seq: number } | null;
  readonly hoverRows: ReadonlySet<string>;
}) {
  const fk = fileKey(projectId, file.path);
  return (
    <DiffFileView key={file.path} path={file.path} oldPath={file.oldPath} binary={file.binary}
      additions={file.additions} deletions={file.deletions} hunks={file.hunks}
      open={openFiles.has(fk)} onToggleFile={() => onToggleFile(fk)}
      foldedHunks={foldedHunks} onToggleHunk={onToggleHunk} hunkKeyPrefix={fk}
      rowDomId={(hunkIndex, rowIndex) => diffRowDomId(projectId, file.path, hunkIndex, rowIndex)}
      fileAttrValue={`file-${file.path}`}
      flashRowIds={flashRows?.ids} flashSeq={flashRows?.seq} hoverRowIds={hoverRows} />
  );
}

function LectureDiffPane({ projects, openFiles, foldedHunks, flashRows, hoverRows, onToggleFile, onToggleHunk }: {
  readonly projects: readonly LectureDiffProject[];
  readonly openFiles: ReadonlySet<string>;
  readonly foldedHunks: ReadonlySet<string>;
  readonly flashRows: { ids: Set<string>; seq: number } | null;
  readonly hoverRows: ReadonlySet<string>;
  readonly onToggleFile: (key: string) => void;
  readonly onToggleHunk: (key: string) => void;
}) {
  if (projects.length === 0) {
    return <p data-lck="diff-empty" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', margin: 6 }}>左栏为空：点「加载 diff」按当前范围采集。</p>;
  }
  return (
    <>
      {projects.map((p) => (
        <section key={p.projectId} data-lck={`diff-project-${p.projectId}`} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--fs-m)' }}>{p.projectName}</strong>
            <span style={chipStyle}>{p.mode === 'patch' ? '粘贴 patch' : p.rangeLabel}</span>
            <span style={chipStyle}>{p.files.length} 文件 +{p.kept.additions}/-{p.kept.deletions}</span>
            {p.excluded.count > 0 && <span style={chipStyle}>排除 {p.excluded.count}</span>}
            {p.budget.dropped > 0 && <span data-lck="budget-dropped" style={chipStyle}>预算丢弃 {p.budget.dropped}</span>}
          </div>
          {p.blocked && <p data-lck="blocked" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', margin: '4px 0' }}>{p.blocked}</p>}
          {p.warnings.map((w) => <p key={w} style={{ fontSize: 'var(--fs-s)', color: 'var(--warn)', margin: '2px 0' }}>{w}</p>)}
          {p.budget.droppedNames.length > 0 && (
            <p style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', margin: '2px 0' }}>超预算未进讲稿：{p.budget.droppedNames.join('、')}</p>
          )}
          {!p.blocked && p.files.length === 0 && (
            <p style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', margin: '4px 0' }}>区间内没有可讲解的变更（或全部被排除规则命中）。</p>
          )}
          {groupFilesByModule(p.files).map((group) => (
            <div key={group.module} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontFamily: FONT_MONO }}>{group.module}/</div>
              {group.files.map((f) => (
                <DiffFileRow key={f.path} projectId={p.projectId} file={f}
                  openFiles={openFiles} onToggleFile={onToggleFile}
                  foldedHunks={foldedHunks} onToggleHunk={onToggleHunk}
                  flashRows={flashRows} hoverRows={hoverRows} />
              ))}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

// ---- 右栏渲染：八段手风琴（逐段流出 + 锚点交互 + 风险/建议条目三态标记） ----
interface SectionRow {
  key: string;
  title: string;
  text: string;
  pending: boolean;
  failed: boolean;
  error?: string;
}

/** 三态标记只作用于「风险清单」「改进建议」两节里的列表条目（PRD §6.2） */
const MARKABLE_SECTIONS = new Set(['risks', 'improvements']);

/** 行数据来源优先级：已完成结果 > 大纲占位 > 流式片段（口径与改前一致） */
function sectionRows(sections: readonly LectureSectionResult[], outline: LectureOutline | undefined,
  live: Readonly<Record<string, string>>, streaming: boolean): SectionRow[] {
  if (sections.length > 0) {
    return sections.map((s) => ({ key: s.key, title: s.label, text: s.text, pending: false, failed: !s.ok, ...(s.error ? { error: s.error } : {}) }));
  }
  if (outline) {
    return outline.sections.map((s) => ({ key: s.key, title: s.title, text: live[s.key] ?? '', pending: streaming, failed: false }));
  }
  return Object.entries(live).map(([key, text]) => ({ key, title: key, text, pending: streaming, failed: false }));
}

/** 段落正文三态：有条目化渲染 / 普通 Markdown / 占位文案 */
function SectionBody({ row, markable, marks, onMark, onAnchorClick }: {
  readonly row: SectionRow;
  readonly markable: boolean;
  readonly marks: Readonly<Record<string, LectureMark>>;
  readonly onMark: (key: string, mark: LectureMark) => void;
  readonly onAnchorClick: (href: string) => void;
}) {
  if (!row.text) {
    return <p style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', margin: 0 }}>{row.pending ? '（本节尚未流出）' : '（本节无内容）'}</p>;
  }
  if (markable) {
    return <MarkedLectureBody sectionKey={row.key} text={row.text} marks={marks} onMark={onMark} onAnchorClick={onAnchorClick} />;
  }
  return <Markdown content={linkifyLectureAnchors(row.text)} onAnchorClick={onAnchorClick} />;
}

function LectureSections({ outline, sections, live, streaming, marks, onMark, onAnchorClick, onRetrySection }: {
  readonly outline?: LectureOutline;
  readonly sections: readonly LectureSectionResult[];
  readonly live: Readonly<Record<string, string>>;
  readonly streaming: boolean;
  readonly marks: Readonly<Record<string, LectureMark>>;
  readonly onMark: (key: string, mark: LectureMark) => void;
  readonly onAnchorClick: (href: string) => void;
  readonly onRetrySection?: (key: string, label: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set(['opening']));
  const rows = sectionRows(sections, outline, live, streaming);

  if (rows.length === 0) {
    return <p data-lck="lecture-empty" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', margin: 6 }}>讲稿为空：先「只出大纲」确认结构，或直接「开始生成」。</p>;
  }
  return (
    <>
      {rows.map((r) => {
        const expanded = open.has(r.key);
        const markable = MARKABLE_SECTIONS.has(r.key) && r.text.trim().length > 0;
        return (
          <div key={r.key} data-lck={`section-${r.key}`} style={{ marginBottom: 6, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-2)' }}>
              <button type="button" onClick={() => setOpen((prev) => toggleInSet(prev, r.key))}
                aria-expanded={expanded}
                style={{ flex: '1 1 auto', display: 'flex', gap: 6, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 'var(--fs-s)', padding: '6px 8px', textAlign: 'left' }}>
                <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}>{expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}</span>
                <strong>{r.title}</strong>
                {r.pending && !r.text && <span style={{ color: 'var(--text-muted)' }}>等待生成…</span>}
                {r.failed && <span data-lck="section-failed" style={{ color: 'var(--danger)' }}>部分未生成{r.error ? `：${r.error}` : ''}</span>}
              </button>
              {r.failed && onRetrySection && !streaming && (
                <button type="button" data-lck={`retry-${r.key}`} onClick={() => onRetrySection(r.key, r.title)}
                  style={{ flexShrink: 0, background: 'none', border: 'none', padding: '6px 8px', fontSize: 'var(--fs-xs)', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}>重试本节</button>
              )}
            </div>
            {expanded && (
              <div style={{ padding: '6px 8px' }}>
                <SectionBody row={r} markable={markable} marks={marks} onMark={onMark} onAnchorClick={onAnchorClick} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * 条目化渲染：列表项行尾三个标记按钮，「忽略」折叠该条（默认不显示，可展开恢复）。
 * 条目序号由 `splitLectureBlocks` 与导出侧共用，忽略项在导出稿中被剔除（lectureMarkup.applyMarksToSection）。
 */
function MarkedLectureBody({ sectionKey, text, marks, onMark, onAnchorClick }: {
  readonly sectionKey: string;
  readonly text: string;
  readonly marks: Readonly<Record<string, LectureMark>>;
  readonly onMark: (key: string, mark: LectureMark) => void;
  readonly onAnchorClick: (href: string) => void;
}) {
  const [showIgnored, setShowIgnored] = useState(false);
  const blocks = splitLectureBlocks(text);
  const ignoredCount = blocks.filter((b) => b.kind === 'item' && marks[lectureMarkKey(sectionKey, b.ordinal)] === 'ignore').length;
  return (
    <div data-lck={`marked-${sectionKey}`}>
      {blocks.map((b) => {
        if (b.kind === 'prose') {
          return <Markdown key={`p${b.text.slice(0, 24)}`} content={linkifyLectureAnchors(b.text)} onAnchorClick={onAnchorClick} />;
        }
        const key = lectureMarkKey(sectionKey, b.ordinal);
        const mark = marks[key] ?? 'adopt';
        if (mark === 'ignore' && !showIgnored) return null;
        return (
          <div key={key} data-lck={`mark-item-${sectionKey}-${b.ordinal}`}
            style={{ display: 'flex', gap: 6, alignItems: 'flex-start', borderRadius: 6, padding: '2px 4px', background: mark === 'ignore' ? 'var(--surface-2)' : undefined, opacity: mark === 'ignore' ? 0.7 : 1 }}>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <Markdown content={linkifyLectureAnchors(b.text)} onAnchorClick={onAnchorClick} />
            </div>
            <div style={{ display: 'flex', gap: 2, flexShrink: 0, paddingTop: 2 }}>
              <MarkButton lck={`mark-${sectionKey}-${b.ordinal}-adopt`} active={mark === 'adopt'} label="采纳" onClick={() => onMark(key, 'adopt')} />
              <MarkButton lck={`mark-${sectionKey}-${b.ordinal}-followup`} active={mark === 'followup'} label="会后跟进" onClick={() => onMark(key, 'followup')} />
              <MarkButton lck={`mark-${sectionKey}-${b.ordinal}-ignore`} active={mark === 'ignore'} label="忽略" onClick={() => onMark(key, 'ignore')} />
            </div>
          </div>
        );
      })}
      {ignoredCount > 0 && (
        <div data-lck={`ignored-${sectionKey}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', borderTop: '1px dashed var(--border)', marginTop: 4, paddingTop: 4 }}>
          <span>已忽略 {ignoredCount} 条（不影响导出稿）</span>
          <button type="button" data-lck={`ignored-toggle-${sectionKey}`} onClick={() => setShowIgnored((v) => !v)}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--fs-xs)', padding: 0 }}>
            {showIgnored ? '收起' : '展开查看'}
          </button>
        </div>
      )}
    </div>
  );
}

function MarkButton({ lck, active, label, onClick }: {
  readonly lck: string;
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" data-lck={lck} aria-pressed={active} onClick={onClick}
      style={{
        fontSize: 'var(--fs-2xs)', padding: '1px 5px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent)' : 'var(--surface)',
        color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
      }}>{label}</button>
  );
}
