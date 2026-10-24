import { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Download, Eye, RefreshCw, Sparkles, X } from 'lucide-react';
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
 * 同里程碑后续单接手：逐条三态标记（T02873）、导出链路（T02874，本单只留状态条槽位）、
 * 预检面板与超限两条路（T02875）。
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

  // ---- 两段式生成 ----
  async function runStream(extra: Record<string, unknown>, stageLabel: string) {
    if (scopeBody.error) return flash(scopeBody.error);
    if (!toolId) return flash('请先在右侧控制台选择 AI 工具');
    const ac = new AbortController();
    codeReviewLectureStore.setAbortCtrl(ac);
    codeReviewLectureStore.begin();
    codeReviewLectureStore.pushLog(`${stageLabel}：开始采集与上下文装配`);
    let outline: LectureOutline | undefined;
    let errMsg = '';
    try {
      await streamEvents('/plans/code-review-lecture-stream', { ...scopeBody.body, toolId, ...extra }, (name, payload) => {
        if (name === 'stage') {
          const s = payload as { phase: string; msg: string; progress: number; data?: { type?: string; outline?: LectureOutline } };
          codeReviewLectureStore.setStage({ phase: s.phase, msg: s.msg, progress: s.progress });
          if (s.data?.type === 'outline_ready' || s.data?.type === 'outline_only') outline = s.data.outline;
        } else if (name === 'chunk') {
          const c = payload as { section: string; text: string };
          codeReviewLectureStore.appendLive(c.section, c.text);
        } else if (name === 'done') {
          const d = payload as LectureStreamResult;
          if (d?.outline) outline = d.outline;
          codeReviewLectureStore.setResult(d ?? null);
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

  const outline = snap.result?.outline;
  const sections = snap.result?.sections ?? [];

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
        <FlowButton onClick={() => void runStream({ outlineOnly: true }, '只出大纲')} disabled={snap.streaming}
          title="只出八段骨架大纲（1 次模型调用），确认后再展开正文">
          <Eye size={13} style={{ marginRight: 4 }} />只出大纲
        </FlowButton>
        <FlowButton onClick={() => void runStream(outline ? { outline } : {}, '生成讲稿正文')} disabled={snap.streaming}
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
            onAnchorClick={locateAnchorClick} />
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
        <FlowButton onClick={() => { codeReviewLectureStore.abort(); flash('已停止——右栏已生成的章节保留'); }} disabled={!snap.streaming}
          title="中止当前生成（已生成的节次保留）">
          <Ban size={13} style={{ marginRight: 4 }} />停止
        </FlowButton>
        {/* 本单只留槽位：导出链路（md/docx/pptx + 下载令牌）在 T02874 接入，此前恒禁用而不是「有正文就能点」 */}
        <FlowButton onClick={() => flash('导出链路（md/docx/pptx + 下载令牌）在 T02874 接入')} disabled
          title="导出链路在 T02874 接入">
          <Download size={13} style={{ marginRight: 4 }} />导出
        </FlowButton>
      </footer>
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

// ---- 右栏渲染：八段手风琴（逐段流出 + 锚点交互） ----
interface SectionRow {
  key: string;
  title: string;
  text: string;
  pending: boolean;
  failed: boolean;
  error?: string;
}

function LectureSections({ outline, sections, live, streaming, onAnchorClick }: {
  readonly outline?: LectureOutline;
  readonly sections: readonly LectureSectionResult[];
  readonly live: Readonly<Record<string, string>>;
  readonly streaming: boolean;
  readonly onAnchorClick: (href: string) => void;
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
        return (
          <div key={r.key} data-lck={`section-${r.key}`} style={{ marginBottom: 6, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <button type="button" onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}
              aria-expanded={expanded}
              style={{ width: '100%', display: 'flex', gap: 6, alignItems: 'center', background: 'var(--surface-2)', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 12, padding: '6px 8px', textAlign: 'left' }}>
              <span style={{ color: 'var(--text-muted)' }}>{expanded ? '▾' : '▸'}</span>
              <strong>{r.title}</strong>
              {r.pending && !r.text && <span style={{ color: 'var(--text-muted)' }}>等待生成…</span>}
              {r.failed && <span data-lck="section-failed" style={{ color: 'var(--danger)' }}>部分未生成{r.error ? `：${r.error}` : ''}</span>}
            </button>
            {expanded && (
              <div style={{ padding: '6px 8px' }}>
                {r.text
                  ? <Markdown content={linkifyLectureAnchors(r.text)} onAnchorClick={onAnchorClick} />
                  : <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{r.pending ? '（本节尚未流出）' : '（本节无内容）'}</p>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
