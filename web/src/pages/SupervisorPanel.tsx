/**
 * T01286（PRD FR-5.2~5.4）：监督状态与审计面板——设置页「监督审计」Tab。
 *
 * 为什么放在设置页：PRD §13 评审决策点 4 明确「审计视图仅设置页只读列表」——审计是回溯/排障视图，
 * 不是日常操作面，放进顶部菜单会与「任务/队列」等高频入口争夺注意力；熔断开关（FR-5.4）同理属于
 * 「配置类」动作，改动后应留在原地看效果，不做跨页跳转。
 *
 * 数据来源（T01286 新增的三条 REST）：
 * - `/supervisor/status`：状态看板（FR-5.2），每 10s 轮询一次——只轮询状态，不轮询审计与配置，
 *   避免把用户正在编辑的中继配置输入框冲掉；
 * - `/supervisor/runs`：审计列表（FR-5.3），按需/随状态一并刷新；
 * - `/supervisor/config`：熔断开关、中继通道与运行参数读写（FR-5.4 + T01283 遗留的两个配置键 + T01311 的 tick 周期/审计保留天数）。
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api/client';
import { fullTime, relTime } from '../ui/format';
import { askConfirm } from '../ui/dialogs';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  RefreshCw,
  Save,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
} from 'lucide-react';

/** 监督状态视图（与后端 SupervisorStatusView 同构） */
interface SupervisorAction {
  type: string;
  taskId?: string;
  platform?: string;
  toPlatform?: string;
  reason: string;
}

interface SessionBrief {
  platform: string;
  status: string;
  progress: number;
  stale: boolean;
  /** T01357：失败会话标记（快照采集已纳入 failed） */
  failed?: boolean;
  tasks: Array<{ taskId: string; taskNo: string | null; title: string }>;
}

interface StatusView {
  enabled: boolean;
  intervalMs: number;
  auditRetentionDays: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  tokenBudgetUsed: number;
  tokenBudget: number;
  maxConcurrent: number;
  maxRetry: number;
  cooldownMs: number;
  activeSessions: SessionBrief[];
  lastRunAt: string | null;
  lastActions: SupervisorAction[];
  lastModel: string;
}

interface RunRow {
  id: string;
  ranAt: string;
  snapshot: Record<string, unknown> | null;
  actions: unknown[];
  applied: unknown[];
  blockedBy: string;
  model: string;
}

interface ConfigView {
  enabled: boolean;
  intervalMs: number;
  auditRetentionDays: number;
  relayPlatforms: string;
  relayToolId: string;
}

/** 动作类型配色：与护栏/审计语义对齐（触发类=主色、换台=警示、升级人工=危险） */
const ACTION_COLOR: Record<string, string> = {
  CONTINUE: 'var(--text-muted)',
  RESUME: 'var(--accent)',
  REDISPATCH: 'var(--warn)',
  SPLIT: 'var(--accent)',
  ESCALATE: 'var(--danger)',
};

/** 落地状态配色：applied 成功、skipped 中性、failed 危险 */
const OUTCOME_COLOR: Record<string, string> = {
  applied: 'var(--success)',
  skipped: 'var(--text-muted)',
  failed: 'var(--danger)',
};

/** 审计 JSON 列的宽松取值（脏行不该让整页崩掉） */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown): boolean => v === true;

/** 数字输入框统一样式（运行参数与中继输入同风格） */
const INPUT_STYLE: CSSProperties = {
  fontSize: 'var(--fs-m)', padding: '6px 10px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
};

/** 卡片容器：白底 + 细边框 + 16px 圆角（全局商务浅白风格） */
function Card({ title, icon, extra, children }: { title: string; icon: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 16, background: 'var(--card-bg)', padding: 14, marginBottom: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--text-secondary)' }}>{icon}</span>
        <span style={{ fontSize: 'var(--fs-l)', fontWeight: 600 }}>{title}</span>
        {extra && <span style={{ marginLeft: 'auto' }}>{extra}</span>}
      </header>
      {children}
    </section>
  );
}

/** 单个指标：标签在上、值在下，值支持悬浮完整说明 */
function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div title={hint} style={{ minWidth: 132 }}>
      <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

export function SupervisorPanel() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  // 中继配置用独立输入态：轮询状态时不能被覆盖，否则用户正在输入的值会被冲掉
  const [relayPlatforms, setRelayPlatforms] = useState('');
  const [relayToolId, setRelayToolId] = useState('');
  // 运行参数（T01311）同样用独立输入态，理由同上；周期以「秒」呈现，提交时换算回毫秒
  const [intervalSec, setIntervalSec] = useState('');
  const [retentionDays, setRetentionDays] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 3000);
  };

  /** 只刷新状态：供 10s 轮询使用（不含审计与配置，避免打断编辑） */
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.get<StatusView>('/supervisor/status'));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** 全量刷新：进入面板、手动刷新、配置保存后调用 */
  const loadAll = useCallback(async () => {
    try {
      const [st, rs, c] = await Promise.all([
        api.get<StatusView>('/supervisor/status'),
        api.get<{ runs?: RunRow[] }>('/supervisor/runs?limit=30'),
        api.get<ConfigView>('/supervisor/config'),
      ]);
      setStatus(st);
      setRuns(rs.runs ?? []);
      setRelayPlatforms(c.relayPlatforms);
      setRelayToolId(c.relayToolId);
      setIntervalSec(String(Math.round(c.intervalMs / 1000)));
      setRetentionDays(String(c.auditRetentionDays));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);
  // 轮询节奏 10s：监督 tick 默认 30s，10s 足够体现「下次 tick / 新决策」变化且不刷屏
  useEffect(() => {
    const id = setInterval(() => { void loadStatus(); }, 10_000);
    return () => clearInterval(id);
  }, [loadStatus]);

  const saveConfig = async (patch: Partial<ConfigView>, msg: string) => {
    setBusy(true);
    try {
      const c = await api.post<ConfigView>('/supervisor/config', patch);
      setRelayPlatforms(c.relayPlatforms);
      setRelayToolId(c.relayToolId);
      await loadAll();
      flash(msg);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    if (!status || busy) return;
    const next = !status.enabled;
    // 开启即「允许自动改任务状态」，属高风险动作，必须先确认（关闭则无需确认，随时一键接管）
    if (next && !(await askConfirm('开启后监督器将自动执行续跑 / 换台 / 拆分等动作（仍受并发、重试、预算、冷却护栏约束）。确认开启？'))) return;
    await saveConfig({ enabled: next }, next ? '已开启：自动动作生效' : '已关闭：自动动作停摆，人工接管');
  };

  /**
   * T01311：保存运行参数。前端先做范围校验——把非法值挡在请求之前，
   * 避免「提交→400→输入框仍显示错值」的往复；范围与后端 setIntervalMs/setRetentionDays 一致。
   */
  const saveRuntime = async () => {
    const sec = Number(intervalSec);
    const days = Number(retentionDays);
    if (!Number.isFinite(sec) || sec < 1 || sec > 3600) return flash('tick 周期需为 1~3600 秒');
    if (!Number.isFinite(days) || days < 0 || days > 3650) return flash('审计保留天数需为 0~3650 天（0 = 不清理）');
    await saveConfig({ intervalMs: Math.round(sec * 1000), auditRetentionDays: Math.round(days) }, '运行参数已保存（即时生效）');
  };

  if (loading && !status) return <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-m)' }}>加载监督状态…</p>;

  const snap = (r: RunRow) => r.snapshot ?? {};

  return (
    <section style={{ maxWidth: 960 }}>
      <Card
        title="监督状态"
        icon={<Activity size={14} />}
        extra={
          <button
            onClick={() => void loadAll()}
            disabled={busy}
            title="刷新 — 重新拉取监督状态、审计列表与配置"
            aria-label="刷新：重新拉取监督状态与审计列表"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', padding: '4px 10px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)' }}
          >
            <RefreshCw size={13} /> 刷新
          </button>
        }
      >
        {/* 熔断开关（FR-5.4）：状态色与图标同步表达，避免只靠文案判断 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <button
            onClick={() => void toggleEnabled()}
            disabled={busy}
            title={status?.enabled ? '关闭监督 — 一键熔断，监督器停止自动执行，由人工接管' : '开启监督 — 允许监督器自动执行续跑/换台/拆分动作'}
            aria-label={status?.enabled ? '关闭监督：一键熔断自动执行' : '开启监督：允许自动执行'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-m)', padding: '6px 14px', borderRadius: 8,
              background: status?.enabled ? 'var(--accent)' : 'var(--surface-2)',
              color: status?.enabled ? 'var(--accent-text)' : 'var(--text)',
            }}
          >
            {status?.enabled ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
            {status?.enabled ? '监督已开启' : '监督已熔断'}
          </button>
          <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
            {status?.enabled
              ? '自动动作生效中：停滞会话任务会被重新就绪，失败任务会被换台。'
              : '自动动作已停摆：任务保持现状，仅观测层（会话停滞标记）仍在运行。'}
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12 }}>
          <Metric label="tick 周期" value={`${Math.round((status?.intervalMs ?? 0) / 1000)} 秒`} hint="supervisor.intervalMs；可在下方「运行参数」修改，写入即热重载生效" />
          <Metric label="审计保留" value={status && status.auditRetentionDays > 0 ? `${status.auditRetentionDays} 天` : '不清理'} hint="supervisor.auditRetentionDays；0 表示保留全部（不清理），清理每小时最多执行一次" />
          <Metric label="最近一次 tick" value={status?.lastTickAt ? relTime(status.lastTickAt) : '本进程尚未 tick'} hint={status?.lastTickAt ? fullTime(status.lastTickAt) : '含空转轮次；空转不写审计，故单独记内存态'} />
          <Metric label="下次 tick" value={status?.nextTickAt ? relTime(status.nextTickAt) : '—'} hint={status?.nextTickAt ? fullTime(status.nextTickAt) : '本进程尚未 tick，无法推算'} />
          <Metric
            label="最近决策"
            value={status?.lastRunAt ? relTime(status.lastRunAt) : '尚无决策记录'}
            hint={status?.lastRunAt ? `${fullTime(status.lastRunAt)} · 模型 ${status.lastModel || '未配置'}` : '空转/熔断轮次不写审计'}
          />
          <Metric
            label="token 预算"
            value={status && status.tokenBudget > 0 ? `${status.tokenBudgetUsed} / ${status.tokenBudget}` : `不限（已用 ${status?.tokenBudgetUsed ?? 0}）`}
            hint="supervisor.tokenBudget；0 表示不限"
          />
          <Metric label="活跃会话" value={`${status?.activeSessions.length ?? 0} / ${status?.maxConcurrent ?? 0}`} hint="当前活跃/停滞/失败会话数 / 并发上限 supervisor.maxConcurrent" />
          <Metric label="重试上限" value={`${status?.maxRetry ?? 0} 次`} hint="supervisor.maxRetry；超限动作被拦截并升级人工" />
          <Metric label="冷却窗口" value={`${Math.round((status?.cooldownMs ?? 0) / 60000)} 分钟`} hint="supervisor.cooldownMs；同一任务两次触发的最小间隔" />
        </div>

        <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, marginBottom: 6 }}>最近一轮决策动作</div>
        {status?.lastActions.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
            {status.lastActions.map((a, i) => (
              <li key={`${a.type}-${a.taskId ?? i}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 'var(--fs-m)' }}>
                <span style={{ color: ACTION_COLOR[a.type] ?? 'var(--text)', fontWeight: 600, minWidth: 88 }}>{a.type}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{a.taskId ?? '（全局）'}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{a.reason}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: 0, fontSize: 'var(--fs-m)', color: 'var(--text-muted)' }}>暂无动作记录（监督器每个决策轮次记录一次）。</p>
        )}

        {!!status?.activeSessions.length && (
          <>
            <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, margin: '12px 0 6px' }}>活跃 / 停滞 / 失败会话</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {status.activeSessions.map((s, i) => (
                <li key={`${s.platform}-${i}`} style={{ fontSize: 'var(--fs-m)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{s.platform}</span>
                  <span style={{ color: s.stale || s.failed ? 'var(--danger)' : 'var(--success)' }}>{s.failed ? '失败' : s.stale ? '停滞' : '存活'}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{Math.round(s.progress)}%</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{s.tasks.map((t) => t.taskNo ?? t.title).join('、') || '未关联任务'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card
        title="运行参数"
        icon={<SlidersHorizontal size={14} />}
        extra={
          <button
            onClick={() => void saveRuntime()}
            disabled={busy}
            title="保存 — 写入 tick 周期与审计保留天数（均即时生效，无需重启）"
            aria-label="保存：写入 tick 周期与审计保留天数"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', padding: '4px 10px', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)' }}
          >
            <Save size={13} /> 保存
          </button>
        }
      >
        <p style={{ margin: '0 0 10px', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
          tick 周期写入后即刻重注册定时器（热重载，无需重启）；审计保留天数由下一轮 tick 的清理动作按新策略执行（清理每小时最多一次，故改动不会立刻删行）。
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>tick 周期（秒，1 ~ 3600）</span>
            <input
              type="number"
              min={1}
              max={3600}
              step={1}
              value={intervalSec}
              onChange={(e) => setIntervalSec(e.target.value)}
              aria-label="tick 周期：监督器每轮决策的间隔秒数"
              style={INPUT_STYLE}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>审计保留天数（0 = 不清理，最长 3650 天）</span>
            <input
              type="number"
              min={0}
              max={3650}
              step={1}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              aria-label="审计保留天数：monitor_runs 保留天数，0 表示不清理"
              style={INPUT_STYLE}
            />
          </label>
        </div>
      </Card>

      <Card
        title="中继兜底通道"
        icon={<Info size={14} />}
        extra={
          <button
            onClick={() => void saveConfig({ relayPlatforms, relayToolId }, '中继通道配置已保存')}
            disabled={busy}
            title="保存 — 写入中继平台清单与中继工具"
            aria-label="保存：写入中继兜底通道配置"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)', padding: '4px 10px', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)' }}
          >
            <Save size={13} /> 保存
          </button>
        }
      >
        <p style={{ margin: '0 0 10px', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
          不支持 MCP 拉取任务的平台（如只有中继 endpoint 的黑盒平台）在此登记；命中清单的平台改走中继推送派发，否则任务会一直停在「就绪」等一个永不到来的拉取。
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>中继平台清单（英文逗号分隔，大小写不敏感）</span>
            <input
              value={relayPlatforms}
              onChange={(e) => setRelayPlatforms(e.target.value)}
              placeholder="如 wb-relay,dingtalk"
              aria-label="中继平台清单：不支持 MCP 拉取、需推送兜底的平台名"
              style={{ fontSize: 'var(--fs-m)', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>中继工具（「模型」页中的 AI 工具 id，留空则关闭推送兜底）</span>
            <input
              value={relayToolId}
              onChange={(e) => setRelayToolId(e.target.value)}
              placeholder="如 3f2a…（ai_tools.id）"
              aria-label="中继工具：承载推送派发的 AI 工具 id"
              style={{ fontSize: 'var(--fs-m)', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
            />
          </label>
        </div>
      </Card>

      <Card title="监督审计" icon={<AlertTriangle size={14} />} extra={<span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>最近 {runs.length} 条决策轮次</span>}>
        {runs.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--fs-m)', color: 'var(--text-muted)' }}>
            暂无审计记录。监督器只在「进入决策流程」的轮次写审计（空转、熔断、上一轮未结束不写），避免每 30s 一行把审计表刷成噪声。
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {runs.map((r) => {
              const s = snap(r);
              const open = !!expanded[r.id];
              const degraded = bool(s.degraded);
              const blockedCount = num(s.blockedCount);
              return (
                <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
                  <button
                    onClick={() => setExpanded((p) => ({ ...p, [r.id]: !p[r.id] }))}
                    title="展开/收起 — 查看该轮次的动作与落地结果"
                    aria-label="展开或收起审计详情"
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'transparent', color: 'var(--text)', textAlign: 'left', flexWrap: 'wrap' }}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span style={{ fontSize: 'var(--fs-m)', fontWeight: 600 }} title={fullTime(r.ranAt)}>{relTime(r.ranAt)}</span>
                    <span style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>{r.model || '模型未配置'}</span>
                    {degraded && (
                      <span style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 6, padding: '0 6px' }}>异常降级</span>
                    )}
                    {blockedCount > 0 && (
                      <span style={{ fontSize: 'var(--fs-s)', color: 'var(--warn)', border: '1px solid var(--warn)', borderRadius: 6, padding: '0 6px' }} title={r.blockedBy}>护栏拦截 {blockedCount}</span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
                      待办 {num(s.pending)}/{num(s.pendingTotal)} · 就绪 {num(s.pendingReady)} · 会话 {num(s.sessions)}（停滞 {num(s.staleSessions)}） · 并发 {num(s.concurrent)}/{num(s.maxConcurrent)}
                    </span>
                  </button>
                  {open && (
                    <div style={{ padding: '0 12px 10px 30px', fontSize: 'var(--fs-m)', display: 'grid', gap: 8 }}>
                      <div style={{ color: 'var(--text-secondary)' }}>
                        本轮标记：就绪 {num(s.readyMarked)} · 停滞 {num(s.stalledMarked)}；耗时 {num(s.decisionMs)}ms
                        {s.decisionError ? `；决策错误：${str(s.decisionError)}` : ''}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>AI 动作（{r.actions.length}）</div>
                        {r.actions.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>无</span> : (
                          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
                            {r.actions.map((a, i) => {
                              const o = (a ?? {}) as Record<string, unknown>;
                              const type = str(o.type);
                              return (
                                <li key={i} style={{ display: 'flex', gap: 8 }}>
                                  <span style={{ color: ACTION_COLOR[type] ?? 'var(--text)', fontWeight: 600, minWidth: 88 }}>{type || '—'}</span>
                                  <span style={{ color: 'var(--text-secondary)' }}>{str(o.taskId) || '（全局）'}</span>
                                  <span style={{ color: 'var(--text-secondary)' }}>{str(o.reason)}</span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>落地结果（{r.applied.length}）</div>
                        {r.applied.length === 0 ? <span style={{ color: 'var(--text-muted)' }}>无</span> : (
                          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
                            {r.applied.map((a, i) => {
                              const o = (a ?? {}) as Record<string, unknown>;
                              const st = str(o.status);
                              return (
                                <li key={i} style={{ display: 'flex', gap: 8 }}>
                                  <span style={{ color: OUTCOME_COLOR[st] ?? 'var(--text)', fontWeight: 600, minWidth: 60 }}>{st || '—'}</span>
                                  <span style={{ color: 'var(--text-secondary)' }}>{str(o.type)}</span>
                                  <span style={{ color: 'var(--text-secondary)' }}>{str(o.detail)}{o.createdTaskNo ? `（新任务 ${str(o.createdTaskNo)}）` : ''}</span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                      {r.blockedBy && <div style={{ color: 'var(--warn)' }}>护栏拦截原因：{r.blockedBy}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {notice && <output className="flash-toast">{notice}</output>}
    </section>
  );
}
