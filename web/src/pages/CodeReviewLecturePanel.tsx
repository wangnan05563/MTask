import { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Download, Eye, ListChecks, RefreshCw, Sparkles, X } from 'lucide-react';
import { api } from '../api/client';
import { streamEvents, GATE_BUSY_MSG } from '../api/sse';
import type { Project } from '../api/client';
import { ProjectScopePicker } from '../ui/projectScopePicker';
import { FlowButton } from '../ui/FlowButton';
import { FlowProgress } from '../ui/FlowProgress';
import { Markdown } from '../ui/Markdown';
import { useSessionState } from '../ui/session';
import {
  codeReviewLectureStore,
  useCodeReviewLecture,
  type LectureOutline,
  type LectureSectionResult,
  type LectureStreamResult,
} from '../stores/codeReviewLectureStore';
import {
  anchorHitRowIds,
  anchorLocateMessage,
  diffRowDomId,
  groupFilesByModule,
  hunkToRows,
  linkifyLectureAnchors,
  locateAnchor,
  parseAnchorHref,
  type LectureAnchorHit,
  type LectureDiffProject,
  type LectureDiffView,
} from '../utils/lectureDiff';
import {
  applyMarksToSection,
  assembleLectureExport,
  lectureMarkKey,
  splitLectureBlocks,
  type LectureMark,
} from '../utils/lectureMarkup';
import { saveBlob } from '../utils/download';

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

const fieldStyle: React.CSSProperties = {
  fontSize: 12, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)',
};
const chipStyle: React.CSSProperties = {
  fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-secondary)',
};
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
  const sections = outline.sections.map((s) => prior.get(s.key)).filter((s): s is LectureSectionResult => Boolean(s));
  const ok = sections.length === outline.sections.length && sections.every((s) => s.ok);
  return { ...next, outline, sections, ok };
}

export function CodeReviewLecturePanel({ projectIds, projects, toolId, onClose }: {
  readonly projectIds: string[];
  readonly projects: Project[];
  readonly toolId: string;
  readonly onClose: () => void;
}) {
  const snap = useCodeReviewLecture();
  const [shape, setShape] = useSessionState<RangeShape>('lecture.rangeShape', 'base-head');
  const [base, setBase] = useSessionState('lecture.base', '');
  const [head, setHead] = useSessionState('lecture.head', '');
  const [since, setSince] = useSessionState('lecture.since', '');
  const [patchMode, setPatchMode] = useSessionState('lecture.patchMode', false);
  const [patchText, setPatchText] = useState('');
  const [exportFormat, setExportFormat] = useSessionState<'md' | 'docx' | 'pptx'>('lecture.exportFormat', 'md');
  const [exporting, setExporting] = useState(false);
  /** T02875：预检覆盖层 + 「裁剪继续」要接着跑的意图 */
  const [preflight, setPreflight] = useState<LecturePreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const pendingRun = useRef<{ extra: Record<string, unknown>; label: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [foldedHunks, setFoldedHunks] = useState<Set<string>>(new Set());
  /** 锚点闪烁的行标识；seq 每次点击自增，让同一行的 CSS 动画重放（PRD 要求 1.5s 闪烁） */
  const [flashRows, setFlashRows] = useState<{ ids: Set<string>; seq: number } | null>(null);
  const [hoverRows, setHoverRows] = useState<Set<string>>(new Set());
  const leftRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<number | null>(null);

  const flash = (m: string) => {
    setNotice(m);
    window.setTimeout(() => setNotice(''), 3600);
  };

  const selectedIds = projectIds.length > 0 ? projectIds : projects.map((p) => p.id);

  /** 采集入参：一次评审共用一份区间；patch 模式单项目（E-1 降级通道） */
  const scopeBody = useMemo((): { body?: Record<string, unknown>; error?: string } => {
    if (patchMode) {
      if (selectedIds.length !== 1) return { error: '粘贴 patch 模式一次只支持 1 个项目，请在顶部报表范围里只选一个' };
      if (!patchText.trim()) return { error: '请粘贴 unified diff 全文（git diff / git format-patch 输出均可）' };
      return { body: { projects: [{ projectId: selectedIds[0], patch: patchText }] } };
    }
    const range: Record<string, string> = { shape };
    if (shape === 'since') {
      if (!since.trim()) return { error: '时间窗形态需要起始时间（如 2026-10-01 或 "14 days ago"）' };
      range.since = since.trim();
    } else {
      if (!base.trim()) return { error: '需要填写 base（分支/标签/SHA）' };
      range.base = base.trim();
      if (shape === 'first-last' && !head.trim()) return { error: '首末 SHA 形态需要同时填写两个 SHA' };
      if (head.trim()) range.head = head.trim();
    }
    return { body: { projects: selectedIds.map((projectId) => ({ projectId, range })) } };
  }, [patchMode, patchText, selectedIds, shape, since, base, head]);

  useEffect(() => () => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    codeReviewLectureStore.setAbortCtrl(null);
  }, []);

  // ---- 左栏：diff 视图 ----
  async function loadDiff() {
    if (scopeBody.error) return flash(scopeBody.error);
    codeReviewLectureStore.setDiffLoading(true);
    try {
      const view = await api.post<LectureDiffView>('/plans/code-review-lecture/diff', scopeBody.body);
      codeReviewLectureStore.setDiff(view.projects);
      // 默认只展开每个项目的第一个文件：多项目全展开会把左栏变成滚动长墙，锚点点击时再按需展开
      setOpenFiles(new Set(view.projects.flatMap((p) => p.files.slice(0, 1).map((f) => fileKey(p.projectId, f.path)))));
      flash(`diff 已就绪：可用项目 ${view.totals.ready}/${view.totals.projects}、文件 ${view.totals.files}（排除 ${view.totals.excluded}）`);
    } catch (e) {
      codeReviewLectureStore.setDiff([], e instanceof Error ? e.message : String(e));
      flash(`diff 加载失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- 两段式生成（含中止续作 / 单节重试） ----
  async function runStream(extra: Record<string, unknown>, stageLabel: string) {
    if (scopeBody.error) return flash(scopeBody.error);
    if (!toolId) return flash('请先在右侧控制台选择 AI 工具');
    const resumeFrom = typeof extra.resumeFrom === 'string' ? extra.resumeFrom : undefined;
    const retryKeys = Array.isArray(extra.sectionKeys) ? (extra.sectionKeys as string[]) : undefined;
    const before = codeReviewLectureStore.get();
    const ac = new AbortController();
    codeReviewLectureStore.setAbortCtrl(ac);
    // 续作/重试保留已有三态标记；全新一轮才清空
    codeReviewLectureStore.begin(Boolean(resumeFrom || retryKeys));
    codeReviewLectureStore.pushLog(`${stageLabel}：开始采集与上下文装配`);
    let outline: LectureOutline | undefined = before.outline ?? undefined;
    let errMsg = '';
    try {
      await streamEvents('/plans/code-review-lecture-stream', { ...scopeBody.body, toolId, ...extra }, (name, payload) => {
        if (name === 'stage') {
          const s = payload as { phase: string; msg: string; progress: number; data?: { type?: string; outline?: LectureOutline; section?: string; ok?: boolean } };
          codeReviewLectureStore.setStage({ phase: s.phase, msg: s.msg, progress: s.progress });
          if (s.data?.type === 'outline_ready' || s.data?.type === 'outline_only') {
            if (s.data.outline) { outline = s.data.outline; codeReviewLectureStore.setOutline(s.data.outline); }
          } else if (s.data?.type === 'section_done' && s.data.section) {
            codeReviewLectureStore.setSectionOk(s.data.section, s.data.ok === true);
          }
        } else if (name === 'chunk') {
          const c = payload as { section: string; text: string };
          codeReviewLectureStore.appendLive(c.section, c.text);
        } else if (name === 'done') {
          const d = payload as LectureStreamResult;
          if (d?.outline) { outline = d.outline; codeReviewLectureStore.setOutline(d.outline); }
          codeReviewLectureStore.setResult(mergeLectureRun(before, d ?? null, resumeFrom ?? (retryKeys ? retryKeys[0] : undefined)));
        } else if (name === 'aborted') {
          // 用户主动「停止」：服务端把已完成的节次交回，保留下来供「从第 n 节继续」
          const d = payload as LectureStreamResult;
          if (d?.outline) codeReviewLectureStore.setOutline(d.outline);
          codeReviewLectureStore.setResult(d ?? null);
          codeReviewLectureStore.finish();
          flash(`已停止——已生成 ${d?.sections?.length ?? 0} 节已保留，可「从第 n 节继续」`);
          return;
        } else if (name === 'error') {
          errMsg = (payload as { error: string }).error ?? '生成失败';
        }
      }, ac.signal);
      if (errMsg) {
        codeReviewLectureStore.finish(errMsg);
        return flash(errMsg);
      }
      if (extra.outlineOnly && outline) codeReviewLectureStore.pushLog('大纲已就绪——右栏确认结构后点「按大纲生成正文」');
      codeReviewLectureStore.finish();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 用户主动「停止」不是故障：保留已生成章节，不写错误态
      codeReviewLectureStore.finish(ac.signal.aborted ? undefined : msg);
      if (!ac.signal.aborted) flash(msg.includes(GATE_BUSY_MSG) ? `${msg}——请稍后重试` : msg);
    } finally {
      codeReviewLectureStore.setAbortCtrl(null);
    }
  }

  // ---- T02875：预检覆盖层（FR-7.1 统计面 + FR-7.2 超限两条路） ----
  async function openPreflight(extra: Record<string, unknown>, label: string) {
    if (scopeBody.error) return flash(scopeBody.error);
    if (!toolId) return flash('请先在右侧控制台选择 AI 工具');
    setPreflightLoading(true);
    try {
      const p = await api.post<LecturePreflight>('/plans/code-review-lecture/preflight', scopeBody.body);
      pendingRun.current = { extra, label };
      setPreflight(p);
    } catch (e) {
      flash(`预检失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPreflightLoading(false);
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
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashRows(null), 1600);
    // 展开目标文件要等这一帧落地，否则查不到刚渲染出的行
    window.setTimeout(() => {
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
    setExporting(true);
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
      setExporting(false);
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
        <strong style={{ fontSize: 14 }}>代码评审会议讲稿生成</strong>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>左 diff · 右讲稿 · 底状态条（锚点可点击定位）</span>
        <button type="button" onClick={onClose} title="收起面板" aria-label="收起代码评审讲稿面板"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={16} />
        </button>
      </header>

      <section aria-label="采集范围" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
        <ProjectScopePicker projects={projects} value={selectedIds} onChange={() => flash('评审项目范围请在页面顶部「报表范围」中选择')} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>已选 {selectedIds.length} 个</span>
        {!patchMode && (
          <>
            <select value={shape} onChange={(e) => setShape(e.target.value as RangeShape)} style={fieldStyle} aria-label="Git 区间形态">
              {RANGE_SHAPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            {shape !== 'since' && (
              <input value={base} onChange={(e) => setBase(e.target.value)} placeholder={shape === 'base-head' ? 'base（如 main）' : '首个 SHA'}
                style={{ ...fieldStyle, width: 150 }} aria-label="区间起点" />
            )}
            {shape === 'since' ? (
              <input value={since} onChange={(e) => setSince(e.target.value)} placeholder="起始时间（2026-10-01 / 14 days ago）"
                style={{ ...fieldStyle, width: 210 }} aria-label="时间窗起点" />
            ) : (
              <input value={head} onChange={(e) => setHead(e.target.value)} placeholder={shape === 'first-last' ? '末个 SHA' : 'head（留空=HEAD）'}
                style={{ ...fieldStyle, width: 150 }} aria-label="区间终点" />
            )}
          </>
        )}
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={patchMode} onChange={(e) => setPatchMode(e.target.checked)} />
          粘贴 patch（无 git 时的降级通道）
        </label>
        <FlowButton onClick={() => void loadDiff()} disabled={snap.streaming} loading={snap.diffLoading} loadingText="采集中"
          title="按当前范围采集 diff 并渲染到左栏">
          <RefreshCw size={13} style={{ marginRight: 4 }} />加载 diff
        </FlowButton>
        <FlowButton data-lck="preflight-btn" onClick={() => void openPreflight(outline ? { outline } : { outlineOnly: true }, '预检后继续')}
          disabled={snap.streaming} loading={preflightLoading} loadingText="预检中"
          title="先统计后放行：项目/commit/文件/+−行/排除命中/预算估算/git 可用性">
          <ListChecks size={13} style={{ marginRight: 4 }} />预检
        </FlowButton>
        <FlowButton onClick={() => void openPreflight({ outlineOnly: true }, '只出大纲')} disabled={snap.streaming}
          title="只出八段骨架大纲（1 次模型调用），确认后再展开正文">
          <Eye size={13} style={{ marginRight: 4 }} />只出大纲
        </FlowButton>
        <FlowButton onClick={() => void openPreflight(outline ? { outline } : {}, '生成讲稿正文')} disabled={snap.streaming}
          title={outline ? '按已确认大纲生成八段正文（跳过大纲调用）' : '直接生成八段正文（含一次大纲调用）'}>
          <Sparkles size={13} style={{ marginRight: 4 }} />{outline ? '按大纲生成正文' : '开始生成'}
        </FlowButton>
        {patchMode && (
          <textarea value={patchText} onChange={(e) => setPatchText(e.target.value)} rows={5}
            placeholder="粘贴 unified diff（git diff base..head 或 format-patch 全文）"
            style={{ ...fieldStyle, width: '100%', fontFamily: FONT_MONO, resize: 'vertical' }} aria-label="粘贴 patch 全文" />
        )}
      </section>

      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', minHeight: 320 }}>
        <aside data-lck="diff-pane" ref={leftRef} aria-label="变更 diff 面板"
          style={{ flex: '1 1 46%', minWidth: 0, maxHeight: 460, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--surface)' }}>
          {snap.diffError && <p data-lck="diff-error" style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0' }}>diff 加载失败：{snap.diffError}</p>}
          <LectureDiffPane projects={snap.diff} openFiles={openFiles} foldedHunks={foldedHunks}
            flashRows={flashRows} hoverRows={hoverRows}
            onToggleFile={(k) => setOpenFiles((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
            onToggleHunk={(k) => setFoldedHunks((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
        </aside>
        <main data-lck="lecture-pane" aria-label="讲稿面板" onMouseOver={(e) => hoverFromEvent(e.target)} onMouseLeave={() => setHoverRows(new Set())}
          style={{ flex: '1 1 54%', minWidth: 0, maxHeight: 460, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--surface)' }}>
          <LectureSections outline={outline} sections={sections} live={snap.live} streaming={snap.streaming}
            marks={snap.marks}
            onMark={(key, m) => codeReviewLectureStore.setMark(key, m)}
            onAnchorClick={locateAnchorClick}
            {...(!snap.streaming && outline && resumeKey
              ? { onRetrySection: (key: string, label: string) => void runStream({ outline, sectionKeys: [key] }, `重试「${label}」`) }
              : {})} />
        </main>
      </div>

      <footer data-lck="status-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <span data-lck="stage" style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 0, flex: '1 1 auto' }}>
          {snap.stage?.msg ?? (snap.streaming ? '准备中…' : '未开始（可先「加载 diff」或「只出大纲」）')}
        </span>
        <div style={{ width: 150 }}>
          <FlowProgress value={snap.stage?.progress ?? 0} aria-label="讲稿生成进度" />
        </div>
        <span data-lck="anchor-count" style={{ fontSize: 12, color: 'var(--text-muted)' }}>锚点 {snap.result?.stats.anchors ?? 0}</span>
        {snap.result?.deviation && (
          <span data-lck={snap.result.deviation.noticeRequired ? 'usage-deviation-notice' : 'usage-deviation-ok'}
            style={{ fontSize: 12, color: snap.result.deviation.noticeRequired ? 'var(--warn)' : 'var(--text-muted)', fontWeight: snap.result.deviation.noticeRequired ? 600 : 400 }}
            title="预估偏差仅明示、不阻断（AI-102③）；实际值可在 AI 用量记录回看（④）">
            {snap.result.deviation.noticeRequired ? '⚠ 实测与预估偏差>50%：' : '用量偏差在阈值内：'}
            {([['字符量', snap.result.deviation.chars], ['耗时', snap.result.deviation.seconds]] as const)
              .filter(([, d]) => d.expected > 0)
              .map(([n, d]) => `${n} ${d.overThreshold ? '偏' : '≈'}${d.deviation === null ? '—' : `${Math.round(d.deviation * 100)}%`}`)
              .join(' / ')}
            {' '}（实际 {snap.result.deviation.actualCalls} 次调用）
          </span>
        )}
        <span data-lck="mark-count" style={{ fontSize: 12, color: 'var(--text-muted)' }}>跟进 {followupCount} · 忽略 {ignoredCount}</span>
        <FlowButton onClick={() => { codeReviewLectureStore.stop(); flash('已停止——右栏已生成的章节保留'); }} disabled={!snap.streaming}
          title="中止当前生成（已生成的节次保留）">
          <Ban size={13} style={{ marginRight: 4 }} />停止
        </FlowButton>
        {canResume && (
          <FlowButton data-lck="resume-btn" onClick={() => void runStream({ outline: outline ?? snap.outline, resumeFrom: resumeKey }, `从第 ${resumeIndex} 节继续`)}
            disabled={snap.streaming}
            title={`跳过已生成的前 ${resumeIndex - 1} 节，从第 ${resumeIndex} 节开始补生成`}>
            <RefreshCw size={13} style={{ marginRight: 4 }} />从第 {resumeIndex} 节继续
          </FlowButton>
        )}
        <select data-lck="export-format" value={exportFormat} onChange={(e) => setExportFormat(e.target.value as 'md' | 'docx' | 'pptx')}
          style={fieldStyle} aria-label="导出格式" disabled={exporting}>
          <option value="md">md 讲稿</option>
          <option value="docx">docx 文稿</option>
          <option value="pptx">pptx 投屏（一页一节 + 讲者备注）</option>
        </select>
        <FlowButton data-lck="export-btn" onClick={() => void exportLecture()} disabled={snap.streaming || !snap.result || sections.length === 0}
          loading={exporting} loadingText="导出中" title="按当前标记过滤后导出（忽略项不出现在稿中，会后跟进另列清单）">
          <Download size={13} style={{ marginRight: 4 }} />导出
        </FlowButton>
      </footer>

      {preflight && (
        <div data-lck="preflight" role="dialog" aria-modal="true" aria-label="生成前预检"
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: 'min(920px, 96vw)', maxHeight: '84vh', overflow: 'auto', background: 'var(--card-bg)', border: '1px solid var(--accent)', borderRadius: 10, padding: 14 }}>
            <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ListChecks size={16} style={{ color: 'var(--accent)' }} />
              <strong style={{ fontSize: 14 }}>生成前预检</strong>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>先统计后放行——超限可「裁剪继续」或「中止收窄范围」</span>
              <button type="button" onClick={cancelPreflight} aria-label="关闭预检"
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
              <span data-lck="preflight-estimate" style={chipStyle}>
                {preflight.estimate.groups} 个分段组 → 预估 {preflight.estimate.calls} 次调用 /{' '}
                {preflight.estimate.secondsLow !== undefined && preflight.estimate.secondsHigh !== undefined
                  ? `${fmtSeconds(preflight.estimate.secondsLow)}~${fmtSeconds(preflight.estimate.secondsHigh)}`
                  : fmtSeconds(preflight.estimate.seconds)}
                {' '}/ {preflight.estimate.contextChars} 字符
                {preflight.estimate.modelVersion ? ` · 模型 ${preflight.estimate.modelVersion}` : ''}
              </span>
              <span data-lck="preflight-notice" style={{ ...chipStyle, color: 'var(--text-muted)' }}>{PROXY_METRIC_NOTICE}</span>
            </div>

            {!preflight.ok && (
              <p data-lck="preflight-blocked" style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0' }}>
                没有可采集的项目：请补配工作空间路径、调整区间，或改用「粘贴 patch」后重新预检。
              </p>
            )}
            {preflight.warnings.map((w, i) => <p key={`pw${i}`} style={{ fontSize: 12, color: 'var(--warn)', margin: '2px 0' }}>{w}</p>)}

            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              {preflight.projects.map((p) => (
                <section key={p.projectId} data-lck={`preflight-project-${p.projectId}`}
                  style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--surface)' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <strong style={{ fontSize: 13 }}>{p.projectName}</strong>
                    <span style={chipStyle}>{p.mode === 'patch' ? '粘贴 patch' : p.rangeLabel}</span>
                    <span data-lck={`preflight-git-${p.projectId}`} style={{ ...chipStyle, color: p.git.available && p.git.isRepo ? 'var(--success)' : 'var(--danger)' }}>
                      {p.mode === 'patch' ? '无需 git' : p.git.available ? (p.git.isRepo ? 'git 可用' : '非 git 仓库') : '未检测到 git'}
                    </span>
                    <span style={chipStyle}>{p.stats.commits} commits · {p.stats.files} 文件 · +{p.stats.additions}/-{p.stats.deletions}</span>
                    <span style={chipStyle}>排除 {p.excluded.count}</span>
                    <span style={chipStyle}>保留 {p.kept.files} 文件 / {p.kept.chars} 字符</span>
                  </div>
                  {p.blocked && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0' }}>{p.blocked}</p>}
                  {p.budget.dropped > 0 && (
                    <p data-lck="preflight-dropped" style={{ fontSize: 12, color: 'var(--warn)', margin: '4px 0' }}>
                      超预算已按优先级丢弃 {p.budget.dropped} 个文件：{p.budget.droppedNames.join('、')}
                      {p.budget.truncated ? '（列表已截断）' : ''}
                    </p>
                  )}
                  {p.warnings.map((w, i) => <p key={`w${i}`} style={{ fontSize: 12, color: 'var(--warn)', margin: '2px 0' }}>{w}</p>)}
                </section>
              ))}
            </div>

            <footer style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: '1 1 auto' }}>
                「裁剪继续」＝按预算内保留文件生成；被丢弃的文件已点名，不会静默缺稿。
              </span>
              <FlowButton data-lck="preflight-cancel" onClick={cancelPreflight}
                style={{ backgroundColor: 'var(--surface-2)', color: 'var(--text)' }} title="不动代码：回面板调整项目/区间/排除规则">
                中止收窄范围
              </FlowButton>
              <FlowButton data-lck="preflight-continue" onClick={continueFromPreflight} disabled={!preflight.ok}
                title={preflight.ok ? '按当前统计面继续（超预算文件按优先级丢弃）' : '没有可采集的项目，无法继续'}>
                裁剪继续 · {pendingRun.current?.label ?? '生成'}
              </FlowButton>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 左栏渲染 ----
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
    return <p data-lck="diff-empty" style={{ fontSize: 12, color: 'var(--text-muted)', margin: 6 }}>左栏为空：点「加载 diff」按当前范围采集。</p>;
  }
  return (
    <>
      {projects.map((p) => (
        <section key={p.projectId} data-lck={`diff-project-${p.projectId}`} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{p.projectName}</strong>
            <span style={chipStyle}>{p.mode === 'patch' ? '粘贴 patch' : p.rangeLabel}</span>
            <span style={chipStyle}>{p.files.length} 文件 +{p.kept.additions}/-{p.kept.deletions}</span>
            {p.excluded.count > 0 && <span style={chipStyle}>排除 {p.excluded.count}</span>}
            {p.budget.dropped > 0 && <span data-lck="budget-dropped" style={chipStyle}>预算丢弃 {p.budget.dropped}</span>}
          </div>
          {p.blocked && <p data-lck="blocked" style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0' }}>{p.blocked}</p>}
          {p.warnings.map((w, i) => <p key={`w${i}`} style={{ fontSize: 12, color: 'var(--warn)', margin: '2px 0' }}>{w}</p>)}
          {p.budget.droppedNames.length > 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0' }}>超预算未进讲稿：{p.budget.droppedNames.join('、')}</p>
          )}
          {!p.blocked && p.files.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>区间内没有可讲解的变更（或全部被排除规则命中）。</p>
          )}
          {groupFilesByModule(p.files).map((group) => (
            <div key={group.module} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: FONT_MONO }}>{group.module}/</div>
              {group.files.map((f) => {
                const fk = fileKey(p.projectId, f.path);
                const open = openFiles.has(fk);
                return (
                  <div key={f.path} style={{ marginTop: 4 }}>
                    <button type="button" data-lck={`file-${f.path}`} onClick={() => onToggleFile(fk)} aria-expanded={open}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: 0, textAlign: 'left', fontFamily: FONT_MONO }}>
                      {open ? '▾' : '▸'} {f.path} <span style={{ color: 'var(--success)' }}>+{f.additions}</span>{' '}
                      <span style={{ color: 'var(--danger)' }}>-{f.deletions}</span>
                    </button>
                    {open && f.binary && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 14 }}>二进制文件，无文本 diff。</div>}
                    {open && !f.binary && f.hunks.map((h, hunkIndex) => {
                      const hk = `${fk}|${hunkIndex}`;
                      if (foldedHunks.has(hk)) {
                        return (
                          <div key={hk} style={{ marginLeft: 14, fontSize: 11, color: 'var(--text-muted)' }}>
                            hunk @{h.newStart} 已折叠{' '}
                            <button type="button" onClick={() => onToggleHunk(hk)}
                              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>展开</button>
                          </div>
                        );
                      }
                      const rows = hunkToRows(h);
                      return (
                        <div key={hk} style={{ marginLeft: 14, marginTop: 2 }}>
                          <button type="button" onClick={() => onToggleHunk(hk)} title="折叠该 hunk"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: 0, fontFamily: FONT_MONO }}>
                            {rows[0].text}
                          </button>
                          {rows.slice(1).map((r, offset) => {
                            const rowIndex = offset + 1; // rows[0] 是 hunk 头，行号口径与 utils 的展开结果一致
                            const id = diffRowDomId(p.projectId, f.path, hunkIndex, rowIndex);
                            const flashed = flashRows?.ids.has(id);
                            return (
                              <div key={flashed ? `${id}-${flashRows?.seq}` : id} data-lck-row={id}
                                className={flashed ? 'locate-flash' : undefined}
                                style={{
                                  display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.45, fontFamily: FONT_MONO,
                                  background: hoverRows.has(id) ? 'var(--accent-soft)' : undefined,
                                  color: r.kind === 'del' ? 'var(--danger)' : r.kind === 'add' ? 'var(--success)' : 'var(--text)',
                                }}>
                                <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)', flexShrink: 0 }}>{r.oldLine ?? ''}</span>
                                <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)', flexShrink: 0 }}>{r.newLine ?? ''}</span>
                                <span style={{ width: 10, flexShrink: 0 }}>{r.kind === 'add' ? '＋' : r.kind === 'del' ? '−' : ' '}</span>
                                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{r.text}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
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
  const rows: SectionRow[] = sections.length > 0
    ? sections.map((s) => ({ key: s.key, title: s.label, text: s.text, pending: false, failed: !s.ok, ...(s.error ? { error: s.error } : {}) }))
    : outline
      ? outline.sections.map((s) => ({ key: s.key, title: s.title, text: live[s.key] ?? '', pending: streaming, failed: false }))
      : Object.entries(live).map(([key, text]) => ({ key, title: key, text, pending: streaming, failed: false }));

  if (rows.length === 0) {
    return <p data-lck="lecture-empty" style={{ fontSize: 12, color: 'var(--text-muted)', margin: 6 }}>讲稿为空：先「只出大纲」确认结构，或直接「开始生成」。</p>;
  }
  return (
    <>
      {rows.map((r) => {
        const expanded = open.has(r.key);
        const markable = MARKABLE_SECTIONS.has(r.key) && r.text.trim().length > 0;
        return (
          <div key={r.key} data-lck={`section-${r.key}`} style={{ marginBottom: 6, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <button type="button" onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}
              aria-expanded={expanded}
              style={{ width: '100%', display: 'flex', gap: 6, alignItems: 'center', background: 'var(--surface-2)', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 12, padding: '6px 8px', textAlign: 'left' }}>
              <span style={{ color: 'var(--text-muted)' }}>{expanded ? '▾' : '▸'}</span>
              <strong>{r.title}</strong>
              {r.pending && !r.text && <span style={{ color: 'var(--text-muted)' }}>等待生成…</span>}
              {r.failed && <span data-lck="section-failed" style={{ color: 'var(--danger)' }}>部分未生成{r.error ? `：${r.error}` : ''}</span>}
              {r.failed && onRetrySection && !streaming && (
                <span role="button" tabIndex={0} data-lck={`retry-${r.key}`}
                  onClick={(e) => { e.stopPropagation(); onRetrySection(r.key, r.title); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onRetrySection(r.key, r.title); } }}
                  style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}>重试本节</span>
              )}
            </button>
            {expanded && (
              <div style={{ padding: '6px 8px' }}>
                {r.text
                  ? markable
                    ? <MarkedLectureBody sectionKey={r.key} text={r.text} marks={marks} onMark={onMark} onAnchorClick={onAnchorClick} />
                    : <Markdown content={linkifyLectureAnchors(r.text)} onAnchorClick={onAnchorClick} />
                  : <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{r.pending ? '（本节尚未流出）' : '（本节无内容）'}</p>}
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
        <div data-lck={`ignored-${sectionKey}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px dashed var(--border)', marginTop: 4, paddingTop: 4 }}>
          <span>已忽略 {ignoredCount} 条（不影响导出稿）</span>
          <button type="button" data-lck={`ignored-toggle-${sectionKey}`} onClick={() => setShowIgnored((v) => !v)}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
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
        fontSize: 10, padding: '1px 5px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent)' : 'var(--surface)',
        color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
      }}>{label}</button>
  );
}
