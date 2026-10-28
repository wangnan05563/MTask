import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, FileSpreadsheet, FileText, GitBranch, Loader2, Package, RefreshCw, StopCircle, X } from 'lucide-react';
import { api, type Project } from '../api/client';
import { streamEvents, GATE_BUSY_MSG } from '../api/sse';
import { FIELD_QUIET, PILL } from '../ui/primitives';
import { GitScopePicker, scopeWorkspace, type GitScope } from '../ui/gitScopePicker';
import { WorkspaceSelect, wsBasename } from '../ui/WorkspaceSelect';
import { patchProject } from '../ui/projectList';
import { GIT_DEGRADED_HINT } from '../ui/gitBadge';
import { FlowButton } from '../ui/FlowButton';
import { FlowProgress } from '../ui/FlowProgress';
import { useSessionState } from '../ui/session';
import { saveBlob } from '../utils/download';

/**
 * 八期 §3.3.1「Git 增量资产提取」工作面板（T03366 / T03416）。
 *
 * 三段式：**范围**（共享 GitScopePicker）→ **方式**（源文件包 / Excel 清单 / Markdown 清单）→
 * **执行**（分阶段进度 + 逐任务回执 + 下载 / 中止）。
 *
 * 三个不妥协的口径：
 *  - **摘要常显**走 `POST /git-extract/plan`：只读端点（不落盘、不占导出闸），所以每次勾选变化都
 *    可以放心重算，不必等用户点「开始」才知道会超上限；
 *  - **上限报错带计数**：服务端文案已含「当前 N 个（上限 M）」，前端逐字透出、不改写数字——
 *    AC-8 要的就是那个计数，前端重拼一遍就成了两套口径；
 *  - **环境类降级走指引不走错误框**：`no-workspace / not-a-repo / no-git` 用户可以自行修复，
 *    面板内明示原因并给「去绑定工作空间」入口（PRD §3.3.1 末条）。
 */

type ExtractMode = 'files' | 'xlsx' | 'md';

const MODES: ReadonlyArray<{ key: ExtractMode; label: string; desc: string; icon: React.ReactNode }> = [
  { key: 'files', label: '源文件提取', desc: '保留仓库目录结构的 zip 包（二进制原样保留，删除文件不导出内容）', icon: <Package size={13} /> },
  { key: 'xlsx', label: 'Excel 清单', desc: '单 sheet 九列变更清单（提交 / 路径 / 状态 / 增删行 / 任务编号 / 任务标题 / 作者 / 时间）', icon: <FileSpreadsheet size={13} /> },
  { key: 'md', label: 'Markdown 清单', desc: '提交摘要小节 + 同字段表格，可直接贴进评审记录', icon: <FileText size={13} /> },
];

/** 与后端 `runExtract` 的 stage 名一一对应（改这里要同时改 gitExtract.ts；门按名断言顺序） */
const STAGES = [
  { key: 'collect', label: '汇总清单' },
  { key: 'read', label: '读取内容' },
  { key: 'pack', label: '打包' },
  { key: 'ready', label: '可下载' },
] as const;

/** 摘要端点回读（server `routes/gitExtract.ts` 的 `/git-extract/plan` 响应） */
interface PlanView {
  workspacePath: string;
  projects: number;
  tasks: number;
  commits: number;
  files: number;
  manifestRows: number;
  unlinked: { taskNo: string | null; title: string }[];
  missingShas: string[];
}

/** 执行结果（server `gitExtract.ExtractResult`） */
interface ExtractView {
  jobId: string;
  volumes: { token: string; fileName: string; bytes: number; files: number }[];
  bytes: number;
  files: number;
  manifestRows: number;
  receipts: { taskNo: string | null; title: string; ok: boolean; files: number; note: string }[];
}

/** SSE `error` 事件负载（与 JSON 4xx 同形状：`{ error, kind, counts? }`） */
interface ErrorPayload {
  error?: string;
  kind?: string;
}

/**
 * 「环境不可用」的 kind 集合（PRD §3.3.1 末条：未绑定工作空间 / 非仓库 / 无 git）。
 * 这几种用户可以自行修复，卡片出 blocked 视觉 + 面板给绑定入口；
 * 其余 kind（如 git 超时）是临时故障，不当作环境缺失上报。
 */
const ENV_KINDS = new Set(['no-workspace', 'not-a-repo', 'no-git', 'cross-workspace']);

/** 读屏可见、视觉隐藏的表格题注（与 FlowProgress 的原生 progress 同口径，本仓无 .sr-only 类） */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 后端错误负载换成人话：原因与计数逐字透出，环境类再补一条同源的可操作指引 */
function describeError(e: ErrorPayload): string {
  const base = e.error || '提取失败';
  const hint = e.kind ? GIT_DEGRADED_HINT[e.kind] : undefined;
  return hint && !base.includes(hint.slice(0, 8)) ? `${base} — ${hint}` : base;
}

export function GitExtractPanel({ projects, scope, onScopeChange, onClose, onEnvState, flash }: {
  readonly projects: Project[];
  /** 共享范围（`git.scope`）由页面层持有——卡片徽标与面板必须读同一份，组件内再存一份就会漂移 */
  readonly scope: GitScope;
  readonly onScopeChange: (next: GitScope) => void;
  readonly onClose: () => void;
  /** T03366：环境不可用状态上抛——卡片的 blocked 视觉要覆盖「非仓库 / 无 git」，只有面板取数后才知道 */
  readonly onEnvState?: (down: boolean) => void;
  readonly flash?: (m: string) => void;
}) {
  const [mode, setMode] = useSessionState<ExtractMode>('git.extract.mode', 'files');
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [planError, setPlanError] = useState('');
  /** 取数降级 kind（非仓库 / 无 git）：卡片要据此出 blocked 视觉，故上抛给页面层 */
  const [degraded, setDegraded] = useState('');
  const [planBusy, setPlanBusy] = useState(false);

  const [running, setRunning] = useState(false);
  const [stageIdx, setStageIdx] = useState(-1);
  const [jobId, setJobId] = useState('');
  const [result, setResult] = useState<ExtractView | null>(null);
  const [runError, setRunError] = useState('');
  const [aborted, setAborted] = useState(false);
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const controllerRef = useRef<AbortController | null>(null);

  /** 交给后端的任务集：会话里存的是历史勾选，去重即可——「未回写」的任务由服务端按关联表判定并点名 */
  const taskIds = useMemo(() => [...new Set(scope.taskIds)], [scope.taskIds]);
  const taskIdsKey = taskIds.join(',');
  const ws = useMemo(() => scopeWorkspace(projects, scope.projectIds), [projects, scope.projectIds]);
  /** 环境不可用：勾了项目却没有可用的共同工作空间（未绑定 / 跨空间）——判据单源于 scopeWorkspace */
  const envBlocked = ws.blocked;
  /** 环境不可用的全集：页面层算得出的（未绑定 / 跨空间）+ 只有服务端取数才知道的（非仓库 / 无 git） */
  const envDown = envBlocked || degraded !== '';

  const refreshPlan = useCallback(async () => {
    if (!taskIds.length) {
      setPlan(null); setPlanError(''); setDegraded(''); setPlanBusy(false);
      return;
    }
    setPlanBusy(true);
    try {
      const body = await api.post<PlanView & ErrorPayload>('/git-extract/plan', { taskIds });
      // 取数降级（非仓库 / 无 git / 超时）服务端按 **HTTP 200 + {error, kind}** 回（与 §3.1 徽标同一口径），
      // 不判这一层就会把错误负载当成摘要渲染成「已选 undefined 个项目」
      if (body && typeof body.error === 'string') {
        setPlan(null);
        setPlanError(describeError(body));
        setDegraded(ENV_KINDS.has(body.kind ?? '') ? String(body.kind) : '');
        return;
      }
      setPlan(body);
      setPlanError('');
      setDegraded('');
    } catch (e) {
      // 范围类问题（跨工作空间 / 全未回写）在 plan 阶段就 400：这是「还不该开始」的提示，常驻显示
      setPlan(null);
      setPlanError(e instanceof Error ? e.message : String(e));
      setDegraded('');
    } finally {
      setPlanBusy(false);
    }
  }, [taskIds]);

  // 勾选/筛选/项目变化即重算摘要，debounce 400ms（连点勾选不该打一串 plan 请求）
  useEffect(() => {
    const t = setTimeout(() => void refreshPlan(), 400);
    return () => clearTimeout(t);
  }, [refreshPlan, taskIdsKey, scope.projectIds.length]);

  // 卸载（切页/收起卡片）即掐流：服务端 res.close 会 abort 子进程并回收 tmp，不留半个包在跑
  useEffect(() => () => controllerRef.current?.abort(), []);

  // 环境不可用（勾了项目没共同空间 / 取数发现非仓库·无 git）上抛给页面层驱动卡片 blocked 视觉
  useEffect(() => {
    onEnvState?.(envDown);
  }, [envDown, onEnvState]);

  /** 环境修复的目标项目：优先未绑定的那个，其次第一个勾选项（非仓库属「改绑」场景） */
  const bindTarget = useMemo(() => {
    const picked = projects.filter((p) => scope.projectIds.includes(p.id));
    return picked.find((p) => !p.workspace_path) ?? picked[0] ?? null;
  }, [projects, scope.projectIds]);

  async function bindWorkspaceFor(project: Project, path: string) {
    try {
      const updated = await api.patch<Project>(`/projects/${project.id}`, { workspacePath: path });
      patchProject(project.id, { workspace_path: updated?.workspace_path ?? path });
      flash?.(`已绑定工作空间：${path} —— 范围摘要稍后自动重算`);
      void refreshPlan();
    } catch (e) {
      flash?.(e instanceof Error ? e.message : String(e));
    }
  }

  async function start() {
    if (!taskIds.length) { flash?.('请先勾选至少一个已回写 commit id 的任务'); return; }
    setRunning(true);
    setResult(null); setRunError(''); setAborted(false); setDownloaded([]); setStageIdx(-1); setJobId('');
    const controller = new AbortController();
    controllerRef.current = controller;
    const onEvent = (name: string, payload: unknown) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (name === 'job') setJobId(String(p.jobId ?? ''));
      else if (name === 'stage') {
        const idx = STAGES.findIndex((s) => s.key === p.stage);
        if (idx >= 0) setStageIdx(idx);
      } else if (name === 'done') {
        setResult(p as unknown as ExtractView);
        setStageIdx(STAGES.length - 1);
      } else if (name === 'aborted') setAborted(true);
      else if (name === 'error') setRunError(describeError(p as ErrorPayload));
    };
    try {
      await streamEvents('/git-extract', { taskIds, mode }, onEvent, controller.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (controller.signal.aborted) setAborted(true);
      // 被闸拒不算「提取失败」：语气与其余导出卡一致（PRD §3.3.2 明确不排队）
      else setRunError(msg.includes(GATE_BUSY_MSG) ? '已有 2 个导出在跑，请稍后重试（并发超限不排队，避免同时打满磁盘）' : msg);
    } finally {
      setRunning(false);
      controllerRef.current = null;
    }
  }

  async function stop() {
    controllerRef.current?.abort();
    if (jobId) {
      try { await api.post('/git-extract/stop', { jobId }); } catch { /* 中止指令送不到也不影响前端收口：断开连接同样触发服务端回收 */ }
    }
    setAborted(true);
  }

  async function download(v: { token: string; fileName: string }) {
    try {
      const { blob, filename } = await api.getDownload(
        `/git-extract/download?token=${encodeURIComponent(v.token)}&name=${encodeURIComponent(v.fileName)}`,
      );
      saveBlob(blob, filename || v.fileName);
      // 一次性令牌下载即删：把该卷标成「已取走」，否则重复点只会拿到 404
      setDownloaded((prev) => [...new Set([...prev, v.token])]);
    } catch (e) {
      flash?.(e instanceof Error ? e.message : String(e));
    }
  }

  const okReceipts = result?.receipts.filter((r) => r.ok).length ?? 0;
  const badReceipts = (result?.receipts.length ?? 0) - okReceipts;

  return (
    <div data-t03366="git-extract-panel" style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <GitBranch size={16} style={{ color: 'var(--accent)' }} aria-hidden="true" />
        <strong style={{ fontSize: 'var(--fs-l)' }}>Git 增量资产提取</strong>
        <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>范围 → 方式 → 执行（只读取数，不动被采集仓库）</span>
        <button type="button" onClick={() => void refreshPlan()} data-t03366="refresh-plan"
          title="重新计算范围摘要（只读，不产生文件）" aria-label="重新计算范围摘要"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>
          {planBusy ? <Loader2 size={13} className="aispin" /> : <RefreshCw size={13} />} 重算摘要
        </button>
        <button type="button" onClick={onClose} title="收起面板" aria-label="收起 Git 增量资产提取面板"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={16} />
        </button>
      </header>

      {/* ① 范围 */}
      <section aria-label="提取范围" data-t03366="section-scope" style={{ marginBottom: 12 }}>
        <GitScopePicker projects={projects} value={scope} onChange={onScopeChange} />
        {/* 摘要常显：范围任一侧变化即时重算（PRD §3.3.1） */}
        <div data-t03366="summary" style={{ ...PILL, display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, color: 'var(--accent)' }}>
          {planBusy && <Loader2 size={11} className="aispin" aria-hidden="true" />}
          <span>
            {plan
              ? `已选 ${plan.projects} 个项目 / ${plan.tasks} 个任务 / 共 ${plan.files} 个文件`
              : `已选 ${scope.projectIds.length} 个项目 / ${scope.taskIds.length} 个任务 / 共 — 个文件`}
          </span>
          {plan && <span style={{ color: 'var(--text-muted)' }}>· 提交 {plan.commits} 个 · 清单 {plan.manifestRows} 行 · 工作空间 {wsBasename(plan.workspacePath)}</span>}
        </div>
        {plan && (plan.unlinked.length > 0 || plan.missingShas.length > 0) && (
          <div data-t03366="plan-notes" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
            {plan.unlinked.length > 0 && (
              <span>其中 {plan.unlinked.length} 个任务未回写 commit id（{plan.unlinked.slice(0, 3).map((u) => u.taskNo ?? u.title).join('、')}{plan.unlinked.length > 3 ? '…' : ''}），不参与提取。</span>
            )}
            {plan.missingShas.length > 0 && <span> {plan.missingShas.length} 个关联提交已不在当前仓库（换绑或未 fetch），其文件不计入。</span>}
          </div>
        )}
        {planError && <div data-t03366="plan-error" style={{ fontSize: 'var(--fs-s)', color: 'var(--warn)', marginTop: 4 }}>{planError}</div>}
      </section>

      {/* ② 方式 */}
      <section aria-label="提取方式" data-t03366="section-mode" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>提取方式（三选一）</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {MODES.map((m) => (
            <label key={m.key} data-t03366={`mode-${m.key}`}
              style={{ ...FIELD_QUIET, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', padding: '6px 8px', width: '100%', boxSizing: 'border-box', border: `1px solid ${mode === m.key ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6 }}>
              <input type="radio" name="git-extract-mode" checked={mode === m.key}
                onChange={() => { setMode(m.key); setResult(null); setRunError(''); setAborted(false); setStageIdx(-1); }}
                aria-label={m.label} style={{ marginTop: 2, flexShrink: 0 }} />
              <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} aria-hidden="true">{m.icon}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-s)', color: 'var(--text)' }}>{m.label}</span>
                <span style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{m.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* ③ 执行 */}
      <section aria-label="执行" data-t03366="section-run">
        {envDown && (
          <div data-t03366="env-blocked" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', border: '1px solid var(--warn)', borderRadius: 8, padding: 8, marginBottom: 8, fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>
            <AlertTriangle size={13} style={{ flexShrink: 0 }} aria-hidden="true" />
            <span>
              {ws.conflict
                ? `已选项目跨了 ${ws.paths.length} 个工作空间（${ws.paths.map(wsBasename).join(' / ')}）——多项目必须同工作空间，请取消其一`
                : degraded
                  ? `Git 无法从当前工作空间取数：${GIT_DEGRADED_HINT[degraded] ?? degraded}。改绑正确的仓库目录后自动重算：`
                  : `项目「${bindTarget?.name ?? ''}」未绑定工作空间，Git 无法取数。绑定仓库目录后即可提取：`}
            </span>
            {!ws.conflict && bindTarget && (
              <WorkspaceSelect project={bindTarget} onBind={(path) => bindWorkspaceFor(bindTarget, path)} flash={flash} />
            )}
          </div>
        )}
        {runError && (
          <div data-t03366="run-error" role="alert" style={{ border: '1px solid var(--warn)', borderRadius: 8, padding: 8, marginBottom: 8, fontSize: 'var(--fs-s)', color: 'var(--warn)' }}>
            {runError}
          </div>
        )}
        {aborted && !running && (
          <div data-t03366="aborted" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 8 }}>
            本次提取已中止，临时目录已回收（未生成可下载文件）。
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FlowButton
            loading={running}
            loadingText="提取中…"
            disabled={envDown || taskIds.length === 0}
            title={envDown ? '环境未就绪：请先绑定正确的仓库目录' : (taskIds.length ? '按当前范围开始提取' : '请先勾选已回写 commit id 的任务')}
            aria-label="开始提取"
            data-t03366="start"
            onClick={() => void start()}
          >
            <Download size={13} aria-hidden="true" /> 开始提取
          </FlowButton>
          {running && (
            <button type="button" onClick={() => void stop()} data-t03366="stop"
              style={{ ...PILL, color: 'var(--warn)', cursor: 'pointer', border: '1px solid var(--warn)' }}
              title="中止本次提取（中止即回收临时目录）" aria-label="中止提取">
              <StopCircle size={12} aria-hidden="true" /> 中止
            </button>
          )}
        </div>

        {(running || stageIdx >= 0) && (
          <div style={{ marginTop: 8 }}>
            <FlowProgress value={Math.round(((stageIdx + 1) / STAGES.length) * 100)} aria-label="提取进度" />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, fontSize: 'var(--fs-xs)' }}>
              {STAGES.map((s, i) => (
                <span key={s.key} data-t03366={`stage-${s.key}`} aria-label={`阶段 ${s.label}`}
                  style={{ color: i < stageIdx ? 'var(--text-muted)' : i === stageIdx ? 'var(--accent)' : 'var(--border-strong)', fontWeight: i === stageIdx ? 600 : 400 }}>
                  {i < stageIdx ? '✓' : i === stageIdx ? '…' : '·'} {s.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <div data-t03366="result-summary" style={{ fontSize: 'var(--fs-s)', marginBottom: 6 }}>
              提取完成：成功 {okReceipts} 个任务{badReceipts ? ` / 失败 ${badReceipts} 个` : ''} · {result.files} 个文件 · {fmtBytes(result.bytes)} · 清单 {result.manifestRows} 行
            </div>
            <div data-t03366="downloads" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {result.volumes.map((v) => {
                const taken = downloaded.includes(v.token);
                return (
                  <button key={v.token} type="button" disabled={taken} onClick={() => void download(v)} data-t03366="download"
                    title={taken ? '该卷已下载（一次性令牌已失效）' : `下载 ${v.fileName}（${v.files} 个文件 / ${fmtBytes(v.bytes)}）`}
                    aria-label={`下载 ${v.fileName}`}
                    style={{ ...PILL, cursor: taken ? 'not-allowed' : 'pointer', opacity: taken ? 0.5 : 1, color: 'var(--accent)' }}>
                    <Download size={12} aria-hidden="true" /> {v.fileName}（{v.files} 个 / {fmtBytes(v.bytes)}）{taken ? ' 已取走' : ''}
                  </button>
                );
              })}
              {result.volumes.length > 1 && (
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', alignSelf: 'center' }}>
                  共 {result.volumes.length} 卷：按文件完整性分卷（一个文件不拆两半），逐卷下载后解压到同一目录即可。
                </span>
              )}
            </div>
            {/* 逐任务回执三列（任务 / 结果 / 说明），语言与 T03214 导入回执一致 */}
            <table data-t03366="receipts" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-xs)' }}>
              <caption style={SR_ONLY}>逐任务提取回执</caption>
              <thead>
                <tr>
                  {['任务', '结果', '说明'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.receipts.map((r, i) => (
                  <tr key={`${r.taskNo ?? 'x'}-${i}`} data-t03366="receipt-row">
                    <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
                      <span style={{ fontFamily: 'Consolas, Menlo, monospace', color: 'var(--text-muted)' }}>{r.taskNo ?? '—'}</span> {r.title}
                    </td>
                    <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', color: r.ok ? 'var(--accent)' : 'var(--warn)' }}>
                      {r.ok ? `成功（${r.files} 个文件）` : '失败'}
                    </td>
                    <td style={{ padding: '4px 6px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>{r.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
