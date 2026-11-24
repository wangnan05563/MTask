import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Clock3, Coins, Download,
  Eye, FileWarning, GitBranch, Loader2, MessageSquareText, Package, RefreshCw, ShieldCheck,
  TriangleAlert, Wrench, XCircle,
} from 'lucide-react';
import { api, type RunTrace, type RunTraceRisk, type RunTraceStep, type RunTraceStepStatus, type RunTraceStepType } from '../api/client';
import { fullTime, relTime } from '../ui/format';
import { focusTaskByNo } from '../ui/focusTask';
import './runTrace.css';

const RUN_STATUS_LABEL: Record<RunTrace['status'], string> = {
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  awaiting_approval: '等待审批',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const STEP_STATUS_LABEL: Record<RunTraceStepStatus, string> = {
  pending: '待执行',
  running: '执行中',
  awaiting_approval: '等待审批',
  succeeded: '成功',
  failed: '失败',
  skipped: '已跳过',
};

const STEP_TYPE_LABEL: Record<RunTraceStepType, string> = {
  prompt: 'Prompt',
  tool: '工具调用',
  observation: '观察',
  decision: '决策',
  artifact: '产物',
  approval: '审批',
};

const RISK_LABEL: Record<RunTraceRisk, string> = {
  R0: 'R0 只读',
  R1: 'R1 可逆写',
  R2: 'R2 覆盖/删除',
  R3: 'R3 不可逆',
};

const TRIGGER_LABEL: Record<RunTrace['triggerType'], string> = {
  manual: '手动',
  queue: '队列',
  api: 'API',
  schedule: '定时',
  retry: '重试',
  legacy: '旧记录',
};

const STEP_ICON: Record<RunTraceStepType, typeof MessageSquareText> = {
  prompt: MessageSquareText,
  tool: Wrench,
  observation: Eye,
  decision: GitBranch,
  artifact: Package,
  approval: ShieldCheck,
};

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(n)));
}

function stepAutoExpand(steps: readonly RunTraceStep[]): Record<string, boolean> {
  const failed = steps.find((s) => s.status === 'failed');
  return failed ? { [failed.id]: true } : {};
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

function pretty(text: string): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * T06298（REQ-036 / PRD §B6）：Run 追踪详情页。
 *
 * 单次 Run 的头部状态/任务/模型/Prompt 版本/耗时/成本/审批 + 步骤时间线 + 成本归因。
 * 不实现断点重跑；底部入口保留但明确禁用，避免把 B8 的交互伪装成已完成。
 */
export function RunDetailPage({ runRef, onBack }: { readonly runRef: string; readonly onBack: () => void }) {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  const expandedRef = useRef<Record<string, boolean>>({});
  expandedRef.current = expanded;

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await api.get<RunTrace>(`/runs/${encodeURIComponent(runRef)}`);
      setTrace(next);
      setExpanded((cur) => (Object.keys(cur).length > 0 ? cur : stepAutoExpand(next.steps)));
      setError('');
    } catch (e) {
      if (!silent) {
        setTrace(null);
        setError((e as Error).message || 'Run 不存在或读取失败');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [runRef]);

  useEffect(() => {
    void load();
  }, [load]);

  // 运行中的 Run 每 3 秒静默刷新，满足「步骤实时出现」；展开状态不丢。
  useEffect(() => {
    if (!trace || !['queued', 'running', 'awaiting_approval'].includes(trace.status)) return;
    const timer = globalThis.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 3000);
    return () => globalThis.clearInterval(timer);
  }, [trace?.status, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onBack();
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onBack]);

  const toggleStep = (id: string) => {
    setExpanded((cur) => ({ ...cur, [id]: !cur[id] }));
  };

  const exportArtifacts = () => {
    if (!trace) return;
    const artifacts = trace.steps.filter((s) => s.type === 'artifact');
    if (artifacts.length === 0) {
      setNotice('当前 Run 没有产物步骤，暂无可导出内容。');
      return;
    }
    const payload = {
      runId: trace.id,
      taskId: trace.taskId,
      taskNo: trace.taskNo,
      generatedAt: new Date().toISOString(),
      artifacts: artifacts.map((s) => ({
        stepId: s.id, seq: s.seq, status: s.status, input: s.input, output: s.output,
        durationMs: s.durationMs, riskLevel: s.riskLevel,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `run-${trace.taskNo || trace.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-artifacts.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`已导出 ${artifacts.length} 个产物步骤。`);
  };

  if (loading) {
    return (
      <div className="run-trace-page run-trace-center" data-lck="run-detail-loading">
        <Loader2 size={20} className="run-spin" />
        <span>正在读取 Run 追踪…</span>
      </div>
    );
  }

  if (error || !trace) {
    return (
      <div className="run-trace-page run-trace-center" data-lck="run-detail-error">
        <FileWarning size={28} style={{ color: 'var(--danger)' }} />
        <strong>Run 读取失败</strong>
        <span className="run-muted">{error || 'run_not_found'}</span>
        <div className="run-error-actions">
          <button className="run-btn" onClick={() => void load()}><RefreshCw size={14} />重试</button>
          <button className="run-btn run-btn-primary" onClick={onBack}><ArrowLeft size={14} />返回执行会话</button>
        </div>
      </div>
    );
  }

  const totalCost = trace.cost;
  const maxCost = Math.max(totalCost, trace.stepCostTotal, 0.0001);

  return (
    <div className="run-trace-page" data-lck="run-detail-page" data-run-id={trace.id} data-run-status={trace.status}>
      <header className="run-topbar">
        <button className="run-back" data-lck="run-back" onClick={onBack} title="返回执行会话（Esc）">
          <ArrowLeft size={15} /><span>执行会话</span>
        </button>
        <nav className="run-breadcrumb" aria-label="面包屑">
          <Activity size={13} /><span>Run 追踪</span><span className="run-breadcrumb-sep">/</span>
          <code>{trace.id.length > 38 ? `${trace.id.slice(0, 34)}…` : trace.id}</code>
        </nav>
        <div className="run-top-actions">
          <span className="run-refresh-note">{refreshing ? '刷新中…' : `更新于 ${relTime(trace.generatedAt)}`}</span>
          <button className="run-icon-btn" onClick={() => void load(true)} disabled={refreshing} title="刷新 Run 数据" aria-label="刷新 Run 数据">
            <RefreshCw size={15} className={refreshing ? 'run-spin' : undefined} />
          </button>
        </div>
      </header>

      <section className="run-hero" data-lck="run-detail-hero">
        <div className="run-hero-main">
          <div className="run-eyebrow">
            <span className={`run-status run-status-${trace.status}`} data-lck="run-status">
              <span className="run-status-dot" />{RUN_STATUS_LABEL[trace.status]}
            </span>
            <span className={`run-source ${trace.legacy ? 'run-source-legacy' : ''}`} title={trace.legacy ? `旧记录映射：${trace.legacySource}:${trace.legacyRef}` : '原生 Run'}>
              {trace.source === 'native' ? (trace.legacy ? '映射 Run' : '原生 Run') : '旧记录兼容'}
            </span>
            <span className="run-id-chip" title={trace.id}>{trace.id}</span>
          </div>
          <h1 className="run-title">
            {trace.taskNo && (
              <button className="run-task-link" onClick={() => void focusTaskByNo(trace.taskNo, 'notice')} title="打开任务详情">
                {trace.taskNo}
              </button>
            )}
            <span>{trace.taskTitle || '未关联任务'}</span>
          </h1>
          <div className="run-subline">
            <span className="run-project-badge">{trace.projectName || '未分配项目'}</span>
            {trace.errorCode && <span className="run-error-code">错误码：{trace.errorCode}</span>}
            {trace.approval.status !== 'none' && (
              <span className={`run-approval-pill run-approval-${trace.approval.status}`}>{trace.approval.label}</span>
            )}
          </div>
        </div>
        <div className="run-metric-strip" data-lck="run-header-metrics">
          <Metric label="模型" value={trace.model || '未记录'} hint={trace.executor ? `执行者：${trace.executor}` : ''} />
          <Metric label="Prompt 版本" value={trace.promptVersion || '未记录'} />
          <Metric label="耗时" value={fmtDuration(trace.durationMs)} hint={trace.startedAt ? fullTime(trace.startedAt) : ''} />
          <Metric label="成本" value={fmtCost(totalCost)} hint={`${fmtTokens(trace.tokens)} tokens`} />
          <Metric label="审批" value={trace.approval.label} />
        </div>
      </section>

      {trace.warnings.length > 0 && (
        <div className="run-warning-banner" data-lck="run-warning-banner">
          <TriangleAlert size={16} />
          <div>
            {trace.warnings.map((w) => <div key={w}>{w}</div>)}
          </div>
        </div>
      )}

      <div className="run-content-grid">
        <main className="run-timeline-card" data-lck="run-timeline">
          <div className="run-section-head">
            <div>
              <h2>步骤时间线</h2>
              <p>{trace.steps.length} 个步骤 · 失败步骤默认展开，其余按需展开</p>
            </div>
            {['queued', 'running', 'awaiting_approval'].includes(trace.status) && (
              <span className="run-live"><span className="run-live-dot" />实时刷新</span>
            )}
          </div>

          {trace.steps.length === 0 ? (
            <div className="run-empty-steps">
              <Activity size={22} />
              <strong>该 Run 尚无步骤</strong>
              <span>执行器写入 `agent_run_steps` 后，时间线会在此实时补全。</span>
            </div>
          ) : (
            <ol className="run-timeline" aria-label="Run 步骤时间线">
              {trace.steps.map((s) => {
                const Icon = STEP_ICON[s.type];
                const open = Boolean(expanded[s.id]);
                return (
                  <li className={`run-step run-step-${s.status}`} key={s.id} id={`run-step-${s.id}`} data-lck="run-step" data-step-seq={s.seq}>
                    <div className="run-step-rail">
                      <span className={`run-step-dot run-step-dot-${s.status}`}><Icon size={14} /></span>
                      <span className="run-step-line" />
                    </div>
                    <div className="run-step-body">
                      <button
                        className="run-step-head"
                        onClick={() => toggleStep(s.id)}
                        aria-expanded={open}
                        data-lck="run-step-toggle"
                      >
                        <span className="run-step-seq">#{String(s.seq + 1).padStart(2, '0')}</span>
                        <span className="run-step-type">{STEP_TYPE_LABEL[s.type]}</span>
                        <span className={`run-step-status run-step-status-${s.status}`}>{STEP_STATUS_LABEL[s.status]}</span>
                        <span className={`run-risk run-risk-${s.riskLevel}`} title={RISK_LABEL[s.riskLevel]}>{s.riskLevel}</span>
                        {s.synthetic && <span className="run-synthetic" title="该步骤由旧执行会话状态合成，非原始 RunStep">兼容</span>}
                        <span className="run-step-metrics">{fmtDuration(s.durationMs)} · {fmtCost(s.cost)}</span>
                        <span className="run-step-chevron">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                      </button>
                      {!open && s.output && <div className="run-step-preview">{preview(s.output)}</div>}
                      {open && (
                        <div className="run-step-detail">
                          <label>输入</label>
                          <pre>{pretty(s.input) || '（空）'}</pre>
                          <label>输出</label>
                          <pre>{pretty(s.output) || '（空）'}</pre>
                          <div className="run-step-detail-meta">
                            <span>风险：{RISK_LABEL[s.riskLevel]}</span>
                            <span>耗时：{fmtDuration(s.durationMs)}</span>
                            <span>成本：{fmtCost(s.cost)}</span>
                            <span>更新：{fullTime(s.updatedAt)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </main>

        <aside className="run-side">
          <section className="run-side-card run-cost-card" data-lck="run-cost-card">
            <div className="run-side-head"><h2>成本归因</h2><Coins size={16} /></div>
            <div className="run-cost-total">
              <strong data-lck="run-cost-total">{fmtCost(totalCost)}</strong>
              <span>{fmtTokens(trace.tokens)} tokens</span>
            </div>
            {trace.costBreakdown.length === 0 ? (
              <div className="run-side-empty">
                {trace.source === 'legacy_exec_session'
                  ? '旧会话未记录模型成本；Run 数据映射/回填完成后可回放。'
                  : '该 Run 未记录成本拆分。'}
              </div>
            ) : (
              <div className="run-cost-bars" data-lck="run-cost-bars">
                {trace.costBreakdown.map((slice) => (
                  <div className="run-cost-row" key={slice.key}>
                    <div className="run-cost-row-head">
                      <span>{slice.label}</span><span>{fmtCost(slice.cost)} · {slice.pct.toFixed(1)}%</span>
                    </div>
                    <div className="run-cost-bar"><span style={{ width: `${Math.min(100, (slice.cost / maxCost) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
            {trace.unattributedCost > 0 && (
              <div className="run-cost-foot">步骤合计 {fmtCost(trace.stepCostTotal)}，未归因差额 {fmtCost(trace.unattributedCost)}</div>
            )}
          </section>

          <section className="run-side-card" data-lck="run-info-card">
            <div className="run-side-head"><h2>执行信息</h2><Clock3 size={16} /></div>
            <dl className="run-kv">
              <dt>执行者</dt><dd>{trace.executor || '—'}</dd>
              <dt>触发方式</dt><dd>{TRIGGER_LABEL[trace.triggerType]}</dd>
              <dt>开始</dt><dd>{fullTime(trace.startedAt)}</dd>
              <dt>结束</dt><dd>{fullTime(trace.endedAt)}</dd>
              <dt>耗时</dt><dd>{fmtDuration(trace.durationMs)}</dd>
              <dt>来源</dt><dd>{trace.source === 'native' ? 'agent_runs' : 'exec_sessions'}</dd>
            </dl>
          </section>

          <section className="run-side-card" data-lck="run-approval-card">
            <div className="run-side-head"><h2>审批</h2><ShieldCheck size={16} /></div>
            <div className={`run-approval-state run-approval-${trace.approval.status}`}>
              {trace.approval.status === 'approved' ? <CheckCircle2 size={16} /> : trace.approval.status === 'rejected' ? <XCircle size={16} /> : <ShieldCheck size={16} />}
              <span>{trace.approval.label}</span>
            </div>
            <div className="run-side-note">
              {trace.approval.status === 'pending' ? '高风险步骤正在等待人工处理。'
                : trace.approval.status === 'none' ? '本 Run 未经过审批步骤。'
                  : trace.approval.updatedAt ? `更新：${fullTime(trace.approval.updatedAt)}` : '审批状态已记录。'}
            </div>
          </section>
        </aside>
      </div>

      <footer className="run-footer" data-lck="run-footer">
        <div className="run-footer-actions">
          <button className="run-btn" disabled title="本单不实现断点重跑（B8 / T06333 之后接入）" data-lck="run-retry-disabled">
            <RefreshCw size={14} />从失败步骤重跑
          </button>
          <button className="run-btn" onClick={exportArtifacts} data-lck="run-export">
            <Download size={14} />导出产物
          </button>
          <button className="run-btn" disabled title="审计日志尚未接入（等待审计存储与查询契约）">
            <ShieldCheck size={14} />查看审计
          </button>
        </div>
        <div className="run-footer-note" role="status">{notice || '只读追踪；重跑与审计为后续能力。'}</div>
      </footer>
    </div>
  );
}

function Metric({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint?: string }) {
  return (
    <div className="run-metric" title={hint || value}>
      <span className="run-metric-label">{label}</span>
      <span className="run-metric-value">{value}</span>
      {hint && <span className="run-metric-hint">{hint}</span>}
    </div>
  );
}
