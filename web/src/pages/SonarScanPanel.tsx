import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw, RotateCcw, ScanLine, StopCircle, X } from 'lucide-react'; // T03654：折叠箭头统一 lucide
import { api, type Project } from '../api/client';
import { streamEvents, GATE_BUSY_MSG } from '../api/sse';
import { FIELD_QUIET, PILL } from '../ui/primitives';
import { GitScopePicker, scopeWorkspace } from '../ui/gitScopePicker';
import type { GitScope } from '../ui/gitScopePicker';
import { FlowButton } from '../ui/FlowButton';
import { FlowProgress } from '../ui/FlowProgress';
import { usePersistentState, useSessionState } from '../ui/session';
import { applyDeepLink } from '../ui/deepLink';
import { focusSettingsTab } from '../ui/settingsTabs';

/**
 * 八期 §3.4.2「Sonar 质量扫描」工作面板（T03376 / T03377 / T03381 / T03416）。
 *
 * 三段式与提取卡同构：**范围**（共享 `GitScopePicker` 与 `git.scope`，两卡互相沿用上次范围）→
 * **回写方式**（自动回写开关 + 严重度阈值）→ **执行**（7 阶段进度 + 扫描器输出 + 分组结果 + 外链）。
 *
 * 四个不妥协的口径：
 *  - **环境缺失不弹错误框**（AC-16 / T03432）：缺 scanner / Java / projectKey 时面板给指引 +
 *    「去设置页」深链，开始按钮直接禁用——请求根本发不出去，也就不会留下半个 busy job；
 *  - **严重度阈值只在服务端有一处真值**：这里的默认值仅作为请求参数，展示分组用的是服务端回传的
 *    `grouped`，前端不按 severity 自己再筛一遍（两套阈值迟早漂移）；
 *  - **外链先校验协议**：SonarQube 地址来自设置页，仍可能带畸形 scheme，渲染层二次过滤 http/https
 *    （与 `GitCommitTab` 的 `safeHref` 同口径），非 http/https 直接不出链接；
 *  - **刷新能找回运行态**：进入面板先读 `/sonar/scan/running`，SSE 已断但服务端仍在跑时徽标不丢。
 */

/** 与后端 `runSonarScan` 的 stage 名一一对应（改这里要同时改 sonarScan.ts；门按名断言顺序） */
const STAGES = [
  { key: 'collect', label: '汇总' },
  { key: 'snapshot', label: '快照' },
  { key: 'config', label: '配置' },
  { key: 'scan', label: '扫描' },
  { key: 'wait', label: '等待' },
  { key: 'fetch', label: '拉取' },
  { key: 'writeback', label: '回写' },
] as const;

type SevKey = 'blocker' | 'critical' | 'major' | 'minor' | 'info';

/** 标签与后端 `SEVERITY_LABEL` 同字面（门断言两侧一致） */
const SEVERITIES: ReadonlyArray<{ key: SevKey; label: string }> = [
  { key: 'blocker', label: '阻断' },
  { key: 'critical', label: '严重' },
  { key: 'major', label: '主要' },
  { key: 'minor', label: '次要' },
  { key: 'info', label: '提示' },
];

const DEFAULT_THRESHOLD: SevKey[] = ['blocker', 'critical'];

interface ScanIssue {
  key: string;
  rule: string;
  severity: SevKey;
  path: string;
  line: number;
  message: string;
  url: string;
  taskNo: string | null;
  taskTitle: string | null;
  shared: boolean;
}

interface Receipts {
  created: number;
  skippedDuplicate: number;
  belowThreshold: number;
  failed: number;
  unattributed: number;
  failedNames: string[];
  summaryTaskNo: string | null;
  summaryFor: number;
}

interface ScanView {
  jobId: string;
  projectKey: string;
  snapshotHeadSha: string;
  currentHeadSha: string;
  headLag: number;
  files: number;
  bytes: number;
  commits: number;
  tasks: number;
  total: number;
  issues: ScanIssue[];
  grouped: Record<SevKey, ScanIssue[]>;
  reportUrl: string;
  receipts: Receipts | null;
}

/** `GET /sonar/scan/env`（服务端 `scanEnvState`，面板不可用态的单源判据） */
interface EnvView {
  ok: boolean;
  serverConfigured: boolean;
  projectKeysConfigured: number;
  reasons: string[];
  scanLimit: number;
  missingProjectKeys?: string[];
  /** 已选项目的 projectKey 映射（服务端单源）——前端自己读设置页会成第二套口径 */
  keysForProjects?: Array<{ projectId: string; sonarKey: string }>;
  scanner?: { available: boolean; hint?: string };
  java?: { available: boolean; hint?: string };
}

interface ErrorPayload {
  error?: string;
  kind?: string;
  hint?: string;
}

/** 扫描器输出只留最后 N 行：长日志整片塞进 DOM 会让面板卡住，而用户要看的是当下在跑什么 */
const LOG_TAIL = 300;

/** 读屏可见、视觉隐藏的题注（本仓无 .sr-only 类，与 GitExtractPanel 同口径） */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 外链仅允许 http/https（与 `GitCommitTab.safeHref` 同口径的渲染层二次校验） */
function safeHref(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** 后端错误负载换成人话：kind 决定的指引由服务端给（`hint`），前端不重拼第二套 */
function describeError(e: ErrorPayload): string {
  const base = e.error || '扫描失败';
  return e.hint && !base.includes(e.hint.slice(0, 8)) ? `${base} — ${e.hint}` : base;
}

export function SonarScanPanel({ projects, scope, onScopeChange, onClose, onEnvState, flash }: {
  readonly projects: Project[];
  /** 与 Git 卡同一份会话级范围（`git.scope`）：卡片徽标和面板必须读同一份，组件内再存一份就会漂移 */
  readonly scope: GitScope;
  readonly onScopeChange: (next: GitScope) => void;
  readonly onClose: () => void;
  /** T03377：环境不可用状态上抛——卡片 blocked 视觉要看「缺 scanner/Java/地址」，只有面板取数后才知道 */
  readonly onEnvState?: (down: boolean) => void;
  readonly flash?: (m: string) => void;
}) {
  const [autoWriteBack, setAutoWriteBack] = usePersistentState<boolean>('sonar.scan.autoWriteBack', true);
  const [threshold, setThreshold] = usePersistentState<SevKey[]>('sonar.scan.severities', DEFAULT_THRESHOLD);
  const [projectKey, setProjectKey] = useSessionState<string>('sonar.scan.projectKey', '');

  const [env, setEnv] = useState<EnvView | null>(null);
  const [envBusy, setEnvBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [stageIdx, setStageIdx] = useState(-1);
  const [jobId, setJobId] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<ScanView | null>(null);
  const [runError, setRunError] = useState('');
  const [errorKind, setErrorKind] = useState('');
  const [aborted, setAborted] = useState(false);
  const [openGroups, setOpenGroups] = useState<SevKey[]>(['blocker', 'critical']);
  const controllerRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const taskIds = useMemo(() => [...new Set(scope.taskIds)], [scope.taskIds]);
  const projectIdsKey = scope.projectIds.join(',');
  const ws = useMemo(() => scopeWorkspace(projects, scope.projectIds), [projects, scope.projectIds]);
  /** 环境不可用：服务端预检不通过（缺地址/scanner/Java/projectKey）或勾选跨了工作空间 */
  const envDown = !env?.ok || ws.blocked;

  const refreshEnv = useCallback(async () => {
    setEnvBusy(true);
    try {
      setEnv(await api.get<EnvView>(`/sonar/scan/env?projectIds=${encodeURIComponent(projectIdsKey)}`));
    } catch (e) {
      // 预检本身取不到时不能装作「环境可用」：置为不 ok，开始按钮保持禁用并显示原因
      setEnv({ ok: false, serverConfigured: false, projectKeysConfigured: 0, reasons: [e instanceof Error ? e.message : String(e)], scanLimit: 1 });
    } finally {
      setEnvBusy(false);
    }
  }, [projectIdsKey]);

  useEffect(() => {
    void refreshEnv();
  }, [refreshEnv]);

  // 卸载（切页/收起卡片）即掐流：服务端 res.close 会 abort 扫描器并回收快照目录
  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    onEnvState?.(envDown);
  }, [envDown, onEnvState]);

  // 刷新后恢复运行徽标：SSE 已经断了，但服务端的 job 可能还在跑（AC「刷新回徽标」）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.get<{ jobs: Array<{ jobId: string; stage: string | null }> }>('/sonar/scan/running');
        if (cancelled || !r.jobs.length) return;
        const job = r.jobs[0];
        setRunning(true);
        setJobId(job.jobId);
        const idx = STAGES.findIndex((s) => s.key === job.stage);
        setStageIdx(idx >= 0 ? idx : 0);
        setLines([`检测到仍在运行的扫描任务（${job.jobId.slice(0, 8)}）——刷新后进度可回读，但实时输出需重新发起扫描。`]);
      } catch { /* 回读失败只是少了个徽标，不影响本面板可用 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // 输出自动滚到底：扫描器日志是「现在在跑什么」的唯一线索
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function start() {
    if (!taskIds.length) { flash?.('请先勾选至少一个已回写 commit id 的任务'); return; }
    setRunning(true);
    setResult(null); setRunError(''); setErrorKind(''); setAborted(false);
    setStageIdx(-1); setJobId(''); setLines([]);
    const controller = new AbortController();
    controllerRef.current = controller;
    const onEvent = (name: string, payload: unknown) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (name === 'job') setJobId(String(p.jobId ?? ''));
      else if (name === 'stage') {
        const idx = STAGES.findIndex((s) => s.key === p.stage);
        if (idx >= 0) setStageIdx(idx);
      } else if (name === 'log') {
        setLines((prev) => [...prev, String((p as { line?: unknown }).line ?? '')].slice(-LOG_TAIL));
      } else if (name === 'done') {
        const v = p as unknown as ScanView;
        setResult(v);
        setStageIdx(STAGES.length - 1);
        // 分组默认展开：有阻断/严重才展开这两组，否则展开第一组非空——全空时不铺七个空壳
        setOpenGroups(SEVERITIES.filter((s) => (v.grouped?.[s.key]?.length ?? 0) > 0)
          .slice(0, 2).map((s) => s.key));
      } else if (name === 'aborted') setAborted(true);
      else if (name === 'error') {
        setRunError(describeError(p as ErrorPayload));
        setErrorKind(String(p.kind ?? ''));
      }
    };
    try {
      await streamEvents('/sonar/scan', {
        taskIds,
        projectKey: projectKey || undefined,
        autoWriteBack,
        severities: autoWriteBack && threshold.length ? threshold : undefined,
      }, onEvent, controller.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (controller.signal.aborted) setAborted(true);
      // 被闸拒不算「扫描失败」：并发超限不排队（T03410），语气与提取卡一致
      else if (msg.includes(GATE_BUSY_MSG)) setRunError(`已有扫描在跑（并发上限 ${env?.scanLimit ?? 1}），请稍后重试——超限不排队，避免两个扫描器同时打满服务器分析队列`);
      else setRunError(msg);
    } finally {
      setRunning(false);
      controllerRef.current = null;
    }
  }

  async function stop() {
    controllerRef.current?.abort();
    if (jobId) {
      try { await api.post('/sonar/scan/stop', { jobId }); } catch { /* 中止指令送不到也不影响收口：断开连接同样触发服务端回收 */ }
    }
    setAborted(true);
  }

  /** 缺配置时的出口：先落页签再定位子页——顺序反了设置页会按上次页签挂载、错过事件 */
  function goSettings() {
    focusSettingsTab('sonar');
    applyDeepLink({ projectId: '', tab: 'settings' });
  }

  const r = result?.receipts;
  /** 已选项目里配了 projectKey 的那些（值与「是否缺 key」都来自服务端 env 端点） */
  const keyOptions = (env?.keysForProjects ?? []).filter((k) => scope.projectIds.includes(k.projectId));
  const missingKeys = (env?.missingProjectKeys ?? []).filter((id) => scope.projectIds.includes(id));

  return (
    <div data-t03376="sonar-scan-panel" style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <ScanLine size={16} style={{ color: 'var(--accent)' }} aria-hidden="true" />
        <strong style={{ fontSize: 'var(--fs-l)' }}>Sonar 质量扫描</strong>
        <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>扫描任务关联提交的内容快照（不是工作树当前态），不动被采集仓库</span>
        <button type="button" onClick={() => void refreshEnv()} data-t03377="refresh-env"
          title="重新探测环境（扫描器 / Java / 服务器地址）" aria-label="重新探测环境"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>
          {envBusy ? <Loader2 size={13} className="aispin" /> : <RefreshCw size={13} />} 重探环境
        </button>
        <button type="button" onClick={onClose} title="收起面板" aria-label="收起 Sonar 质量扫描面板"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={16} />
        </button>
      </header>

      {/* ① 范围（与 Git 卡共享同一份会话级范围） */}
      <section aria-label="扫描范围" data-t03377="section-scope" style={{ marginBottom: 12 }}>
        <GitScopePicker projects={projects} value={scope} onChange={onScopeChange} />
        <div data-t03377="scope-summary" style={{ ...PILL, display: 'inline-flex', gap: 6, marginTop: 6 }}>
          已选 {scope.projectIds.length} 个项目 / {taskIds.length} 个任务{ws.path ? ` · 工作空间 ${ws.path.replace(/^.*[\\/]/, '')}` : ''}
        </div>
        {keyOptions.length > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            SonarQube 项目（projectKey）
            <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)} aria-label="选择 projectKey" data-t03377="project-key" style={{ ...FIELD_QUIET, width: 'auto', maxWidth: 220 }}>
              <option value="">按所选项目自动</option>
              {keyOptions.map((k) => {
                const name = projects.find((p) => p.id === k.projectId)?.name ?? k.projectId;
                return <option key={k.projectId} value={k.sonarKey}>{name} · {k.sonarKey}</option>;
              })}
            </select>
          </label>
        )}
        {missingKeys.length > 0 && (
          <div data-t03377="missing-keys" style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn)', marginTop: 4 }}>
            以下已选项目还没有 projectKey：{missingKeys.map((id) => projects.find((p) => p.id === id)?.name ?? id).join('、')}
            <button type="button" data-t03377="go-key-settings" onClick={goSettings}
              style={{ ...PILL, cursor: 'pointer', color: 'var(--accent)', marginLeft: 6 }} title="打开设置页 SonarQube 子页">去设置页配置</button>
          </div>
        )}
      </section>

      {/* ② 回写方式 */}
      <section aria-label="回写方式" data-t03382="section-writeback" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>结果回写（默认只回写高危问题，选择会被记住）</div>
        <label data-t03382="auto-writeback" style={{ ...FIELD_QUIET, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <input type="checkbox" checked={autoWriteBack} onChange={(e) => setAutoWriteBack(e.target.checked)}
            aria-label="扫描成功后自动回写为待办子任务" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--fs-s)' }}>扫描成功后自动回写为待办子任务</span>
        </label>
        {autoWriteBack && (
          <div data-t03382="threshold" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>回写阈值：</span>
            {SEVERITIES.map((s) => {
              const on = threshold.includes(s.key);
              return (
                <label key={s.key} data-t03382={`sev-${s.key}`}
                  style={{ ...PILL, cursor: 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: on ? 'var(--accent)' : 'var(--text-muted)' }}>
                  <input type="checkbox" checked={on} style={{ flexShrink: 0, marginRight: 4 }}
                    onChange={() => setThreshold((prev) => (prev.includes(s.key) ? prev.filter((x) => x !== s.key) : [...prev, s.key]))}
                    aria-label={`回写${s.label}级问题`} />
                  {s.label}
                </label>
              );
            })}
            <button type="button" data-t03382="sev-all" onClick={() => setThreshold(SEVERITIES.map((x) => x.key))}
              style={{ ...PILL, cursor: 'pointer' }} title="含次要/提示在内的全部严重度都回写">全部严重度</button>
            {!threshold.length && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>未选任何阈值时将按服务端默认（阻断/严重）回写。</span>}
          </div>
        )}
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
          单次最多回写 50 条，超出部分合并为 1 条汇总子任务；7 天内同指纹问题不重复建单。
        </div>
      </section>

      {/* ③ 执行 */}
      <section aria-label="执行" data-t03428="section-run">
        {envDown && (
          <div data-t03432="env-blocked" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', border: '1px solid var(--warn)', borderRadius: 8, padding: 8, marginBottom: 8, fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>
            <AlertTriangle size={13} style={{ flexShrink: 0 }} aria-hidden="true" />
            <span style={{ minWidth: 0 }}>
              {ws.conflict
                ? `已选项目跨了 ${ws.paths.length} 个工作空间——同一批提交必须在同一仓库，请取消其一`
                : `扫描环境未就绪：${(env?.reasons ?? ['环境探测中…']).join(' ')}`}
            </span>
            {!ws.conflict && (
              <button type="button" data-t03432="go-settings" onClick={goSettings}
                style={{ ...PILL, cursor: 'pointer', color: 'var(--accent)' }} title="打开设置页 SonarQube 子页">
                去设置页配置
              </button>
            )}
          </div>
        )}
        {runError && (
          <div data-t03428="run-error" role="alert" style={{ border: '1px solid var(--warn)', borderRadius: 8, padding: 8, marginBottom: 8, fontSize: 'var(--fs-s)', color: 'var(--warn)' }}>
            {runError}
            {errorKind && <span style={{ color: 'var(--text-muted)' }}>（kind: {errorKind}）</span>}
          </div>
        )}
        {aborted && !running && (
          <div data-t03428="aborted" style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 8 }}>
            本次扫描已中止，快照目录与临时配置已回收。
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FlowButton
            loading={running}
            loadingText="扫描中…"
            disabled={envDown || taskIds.length === 0}
            title={envDown ? '环境未就绪：请先在设置页补全 SonarQube 配置' : (taskIds.length ? '按当前范围开始扫描' : '请先勾选已回写 commit id 的任务')}
            aria-label="开始扫描"
            data-t03428="start"
            onClick={() => void start()}
          >
            <ScanLine size={13} aria-hidden="true" /> 开始扫描
          </FlowButton>
          {running && (
            <button type="button" onClick={() => void stop()} data-t03428="stop"
              style={{ ...PILL, color: 'var(--warn)', cursor: 'pointer', border: '1px solid var(--warn)' }}
              title="中止本次扫描（中止即回收快照目录）" aria-label="中止扫描">
              <StopCircle size={12} aria-hidden="true" /> 中止
            </button>
          )}
          {runError && !running && (
            <button type="button" onClick={() => void start()} data-t03428="retry"
              style={{ ...PILL, cursor: 'pointer', color: 'var(--accent)' }} title="用当前范围重试" aria-label="重试扫描">
              <RotateCcw size={12} aria-hidden="true" /> 重试
            </button>
          )}
        </div>

        {(running || stageIdx >= 0) && (
          <div style={{ marginTop: 8 }}>
            <FlowProgress value={Math.round(((stageIdx + 1) / STAGES.length) * 100)} aria-label="扫描进度" />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, fontSize: 'var(--fs-xs)' }}>
              {STAGES.map((s, i) => (
                <span key={s.key} data-t03428={`stage-${s.key}`} aria-label={`阶段 ${s.label}`}
                  style={{ color: i < stageIdx ? 'var(--text-muted)' : i === stageIdx ? 'var(--accent)' : 'var(--border-strong)', fontWeight: i === stageIdx ? 600 : 400 }}>
                  {i < stageIdx ? '✓' : i === stageIdx ? '…' : '·'} {s.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {lines.length > 0 && (
          <div data-t03428="console" ref={logRef} role="log" aria-label="扫描器输出"
            style={{ marginTop: 8, maxHeight: 180, overflowY: 'auto', background: 'var(--bg, rgba(0,0,0,.04))', border: '1px solid var(--border)', borderRadius: 6, padding: 6, fontFamily: 'Consolas, Menlo, monospace', fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {lines.map((l, i) => <div key={i} data-t03428="console-line">{l || ' '}</div>)}
          </div>
        )}

        {result && (
          <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <div data-t03428="result-summary" style={{ fontSize: 'var(--fs-s)', marginBottom: 4 }}>
              扫描完成：{result.total} 个问题 · {result.files} 个文件 / {fmtBytes(result.bytes)} · {result.commits} 个提交 · {result.tasks} 个任务 · projectKey {result.projectKey}
            </div>
            <div data-t03428="snapshot-declaration" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
              快照基于 SHA {result.snapshotHeadSha.slice(0, 8)}，当前 HEAD 为 {(result.currentHeadSha || '—').slice(0, 8)}，相差 {result.headLag} 个提交
              {result.headLag > 0 && '（结果不含这之后的改动）'}
            </div>
            {safeHref(result.reportUrl) && (
              <a data-t03428="report-link" href={safeHref(result.reportUrl)} target="_blank" rel="noreferrer"
                style={{ ...PILL, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none', color: 'var(--accent)', marginBottom: 8 }}>
                <ExternalLink size={12} aria-hidden="true" /> 在 SonarQube 打开报告
              </a>
            )}
            {r && (
              <div data-t03382="receipts" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
                回写回执：新建 {r.created} / 已存在跳过 {r.skippedDuplicate} / 低于阈值 {r.belowThreshold} / 失败 {r.failed}
                {r.unattributed > 0 && ` / 未归属 ${r.unattributed}`}
                {r.failedNames.length > 0 && <span style={{ color: 'var(--warn)' }}>（失败点名：{r.failedNames.slice(0, 3).join('、')}{r.failedNames.length > 3 ? '…' : ''}）</span>}
                {r.summaryTaskNo && <span> 另有 {r.summaryFor} 条合并为汇总任务 {r.summaryTaskNo}。</span>}
              </div>
            )}
            {!result.total && (
              <div data-t03428="no-issues" style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>本次快照未发现未解决问题。</div>
            )}
            {/* 按严重度分组的可折叠结果（T03416「结果折叠」）：默认只展开前两组非空 */}
            {result.total > 0 && (
              <div data-t03381="grouped">
                {SEVERITIES.map((s) => {
                  const list = result.grouped?.[s.key] ?? [];
                  if (!list.length) return null;
                  const open = openGroups.includes(s.key);
                  return (
                    <div key={s.key} data-t03381={`group-${s.key}`} style={{ borderTop: '1px solid var(--border)', paddingTop: 4, marginTop: 4 }}>
                      <button type="button" onClick={() => setOpenGroups((prev) => (prev.includes(s.key) ? prev.filter((x) => x !== s.key) : [...prev, s.key]))}
                        aria-expanded={open} data-t03381={`toggle-${s.key}`}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--fs-s)', color: 'var(--text)' }}>
                        <span aria-hidden="true" style={{ display: 'inline-flex' }}>{open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}</span>
                        <span style={{ fontWeight: 600 }}>{s.label}</span>
                        <span style={{ ...PILL }}>{list.length} 条</span>
                      </button>
                      {open && (
                        <ul data-t03381={`list-${s.key}`} style={{ margin: '4px 0 0 18px', padding: 0, listStyle: 'none', fontSize: 'var(--fs-xs)' }}>
                          {list.map((it, i) => (
                            <li key={`${it.key || 'x'}-${i}`} data-t03381="issue-row" style={{ marginBottom: 4, minWidth: 0 }}>
                              <span style={{ fontFamily: 'Consolas, Menlo, monospace' }}>{it.path}:{it.line}</span>
                              {' · '}
                              <span style={{ color: 'var(--text-muted)' }}>{it.rule}</span>
                              {' · '}
                              {it.message}
                              {(it.taskNo || it.shared) && (
                                <span style={{ color: 'var(--text-muted)' }}> （归属 {it.taskNo ?? '未识别'}{it.shared ? ' · 多任务共同改动' : ''}）</span>
                              )}
                              {safeHref(it.url) && (
                                <a href={safeHref(it.url)} target="_blank" rel="noreferrer" data-t03381="issue-link" style={{ marginLeft: 6, color: 'var(--accent)' }}>详情</a>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
