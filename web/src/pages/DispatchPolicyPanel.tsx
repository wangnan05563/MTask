/**
 * T06264/T06265/T06266/T06271（十期）：设置 → 派发策略。
 *
 * 页面回答三个问题：
 * 1) 现在能不能派（B0/A/D 状态卡 + 自动是否可运行）；
 * 2) 自动派发按什么规则跑（项目范围、默认通道、周期、冷却、上限）；
 * 3) 下一轮会推哪些任务（候选预览 / dry-run / 立即跑一轮）。
 *
 * 所有数值范围由服务端再次校验；前端只做输入便利与即时提示。
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock, Loader2, Play, RefreshCw, Save, Send, ShieldAlert, XCircle,
} from 'lucide-react';
import { api, type AITool, type DispatchCandidateView, type DispatchConfigView, type DispatchStatusView, type Project } from '../api/client';
import { BADGE, BADGE_TONE, BTN_PRIMARY, BTN_SECONDARY_MD, FIELD_CARD, FIELD_LABEL, FIELD_SM, SELECT } from '../ui/primitives';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const card: CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', padding: 12, marginBottom: 12,
};
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const hint: CSSProperties = { fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' };
const pill = (tone: 'success' | 'danger' | 'warning' | 'neutral') => ({ ...BADGE, ...BADGE_TONE[tone], whiteSpace: 'nowrap' as const });

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function numberField(label: string, value: number, min: number, max: number, suffix: string, onChange: (n: number) => void, help: string) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={FIELD_LABEL}>{label}</span>
      <span style={{ ...row, gap: 4 }}>
        <input
          type="number" min={min} max={max} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ ...FIELD_SM, width: 110 }}
        />
        <span style={hint}>{suffix}</span>
      </span>
      <span style={{ ...hint, marginTop: 3 }}>{help}</span>
    </label>
  );
}

export function DispatchPolicyPanel() {
  const [status, setStatus] = useState<DispatchStatusView | null>(null);
  const [config, setConfig] = useState<DispatchConfigView | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tools, setTools] = useState<AITool[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [candidates, setCandidates] = useState<DispatchCandidateView[] | null>(null);
  const [runResult, setRunResult] = useState<DispatchStatusView['auto']['lastResult'] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [s, c, ps, ts] = await Promise.all([
        api.get<DispatchStatusView>('/dispatch/status'),
        api.get<DispatchConfigView>('/dispatch/config'),
        api.get<Project[]>('/projects'),
        api.get<AITool[]>('/aitools'),
      ]);
      setStatus(s);
      setConfig(c);
      setProjects(ps.filter((p) => !(p as Project & { archived?: boolean }).archived));
      setTools(ts.filter((t) => t.type === 'codebuddy-gateway' && t.enabled));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const update = <K extends keyof DispatchConfigView>(key: K, value: DispatchConfigView[K]) => {
    setConfig((prev) => prev ? { ...prev, [key]: value } : prev);
  };

  const save = async () => {
    if (!config) return;
    setBusy('save');
    setNotice('');
    setError('');
    try {
      const next = await api.put<DispatchConfigView>('/dispatch/config', {
        autoEnabled: config.autoEnabled,
        defaultChannel: config.defaultChannel,
        b0ToolId: config.b0ToolId,
        scopeProjectIds: config.scopeProjectIds,
        trigger: config.trigger,
        intervalMs: config.intervalMs,
        cooldownMs: config.cooldownMs,
        maxPerTick: config.maxPerTick,
        maxAttempts: config.maxAttempts,
        allowFallbackA: config.allowFallbackA,
        retentionDays: config.retentionDays,
        expectedUpdatedAt: config.updatedAt,
      });
      setConfig(next);
      setNotice('已保存；自动调度周期已热重载。');
      await load();
    } catch (e) {
      const message = errText(e);
      setError(message);
      // 双窗口并发保存：旧版本被 409 拒绝后自动刷新，避免用户继续用过期表单覆盖
      if (message.includes('CONFIG_CONFLICT') || message.includes('配置已被')) await load();
    } finally {
      setBusy('');
    }
  };

  const test = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      const r = await api.post<{ ok: boolean; message: string }>('/dispatch/test', {});
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, message: errText(e) });
    } finally {
      setBusy('');
    }
  };

  const preview = async () => {
    setBusy('preview');
    setError('');
    try {
      const r = await api.get<{ items: DispatchCandidateView[] }>('/dispatch/candidates?limit=20');
      setCandidates(r.items);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const run = async (dryRun: boolean) => {
    if (!dryRun && !window.confirm('确认立即跑一轮自动派发？将按当前策略串行提交候选任务，最多本轮上限。')) return;
    setBusy(dryRun ? 'dry' : 'run');
    setError('');
    try {
      const r = await api.post<DispatchStatusView['auto']['lastResult']>('/dispatch/auto/run', { dryRun });
      setRunResult(r ?? null);
      setNotice(dryRun ? '试运行完成：未写审计、未改任务。' : '本轮派发完成，详情见下方结果与任务「最近派发」。');
      if (!dryRun) await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const b0Tools = useMemo(() => tools, [tools]);
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p.name] as const)), [projects]);

  if (loading && !config) {
    return <div style={card}><Loader2 size={14} className="aispin" /> 派发策略加载中…</div>;
  }

  return (
    <div data-dispatch-policy="1">
      {error && (
        <output style={{ ...card, borderColor: 'var(--danger)', color: 'var(--danger)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <AlertTriangle size={14} /> {error}
          <button onClick={() => void load()} style={BTN_SECONDARY_MD}>重试</button>
        </output>
      )}
      {notice && (
        <output style={{ ...card, borderColor: 'var(--success)', color: 'var(--success)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <CheckCircle2 size={14} /> {notice}
        </output>
      )}

      {/* 状态卡 */}
      <div style={card}>
        <div style={{ ...row, marginBottom: 8 }}>
          <b style={{ fontSize: 'var(--fs-m)' }}><Send size={15} style={{ color: 'var(--accent)' }} /> 派发通道状态</b>
          <span style={{ flex: 1 }} />
          <button onClick={() => void load()} style={BTN_SECONDARY_MD} title="刷新状态"><RefreshCw size={12} /> 刷新</button>
          <button onClick={() => void test()} disabled={busy === 'test' || !status?.b0.configured} style={BTN_SECONDARY_MD} title={status?.b0.configured ? '只探测 health/auth，不发送真实任务' : status?.b0.reason ?? 'B0 未配置'}>
            {busy === 'test' ? <Loader2 size={12} className="aispin" /> : <ShieldAlert size={12} />} 测试连接
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 8 }}>
          <div style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={row}><b>B0 CodeBuddy 网关</b><span style={pill(status?.b0.configured ? 'success' : 'danger')}>{status?.b0.configured ? '已配置' : '未配置'}</span></div>
            <div style={{ ...hint, marginTop: 4 }}>{status?.b0.toolName ?? status?.b0.reason ?? '未配置'}</div>
            <div style={{ ...hint, marginTop: 2, wordBreak: 'break-all' }}>{status?.b0.endpoint || '—'}</div>
          </div>
          <div style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={row}><b>A MCP 就绪池</b><span style={pill('warning')}>{status?.a.readyTasks ?? 0} 条待拉取</span></div>
            <div style={{ ...hint, marginTop: 4 }}>{status?.a.supervisorEnabled ? '监督器已开启' : '监督器关闭（不影响自动派发）'}</div>
          </div>
          <div style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={row}><b>D 人工应急</b><span style={pill('neutral')}>{status?.d.failedTasks ?? 0} 条待确认</span></div>
            <div style={{ ...hint, marginTop: 4 }}>只标记人工，不自动开 GUI</div>
          </div>
          <div style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={row}>
              <b>自动派发</b>
              <span style={pill(config?.autoEnabled ? (status?.b0.configured && config.scopeProjectIds.length ? 'success' : 'warning') : 'neutral')}>
                {config?.autoEnabled ? (status?.b0.configured && config.scopeProjectIds.length ? '运行中' : '配置不完整') : '已暂停'}
              </span>
            </div>
            <div style={{ ...hint, marginTop: 4 }}>最近：{fmtTime(status?.auto.lastRunAt)}　下一轮：{fmtTime(status?.auto.nextRunAt)}</div>
            <div style={{ ...hint, marginTop: 2 }}>本日：成功 {status?.auto.today.success ?? 0} / 失败 {status?.auto.today.failed ?? 0} / 跳过 {status?.auto.today.skipped ?? 0}</div>
          </div>
        </div>
        {testResult && (
          <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, border: `1px solid ${testResult.ok ? 'var(--success)' : 'var(--danger)'}`, color: testResult.ok ? 'var(--success)' : 'var(--danger)', fontSize: 'var(--fs-s)', display: 'flex', gap: 6 }}>
            {testResult.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {testResult.message}
          </div>
        )}
      </div>

      {/* 配置 */}
      {config && (
        <div style={card}>
          <div style={{ ...row, marginBottom: 10 }}>
            <b style={{ fontSize: 'var(--fs-m)' }}>自动派发策略</b>
            <span style={hint}>空项目范围 = 不启用；自动链路永不执行 D。</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => void save()} disabled={busy === 'save'} style={BTN_PRIMARY}>
              {busy === 'save' ? <Loader2 size={13} className="aispin" /> : <Save size={13} />} 保存
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-s)' }}>
              <input type="checkbox" checked={config.autoEnabled} onChange={(e) => update('autoEnabled', e.target.checked)} />
              开启自动派发
            </label>
            <label style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={FIELD_LABEL}>默认通道</span>
              <select value={config.defaultChannel} onChange={(e) => update('defaultChannel', e.target.value as 'auto' | 'b0')} style={SELECT}>
                <option value="auto">自动（B0 → A）</option>
                <option value="b0">仅 B0</option>
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={FIELD_LABEL}>B0 工具</span>
              <select value={config.b0ToolId} onChange={(e) => update('b0ToolId', e.target.value)} style={SELECT}>
                <option value="">未指定（取第一条 enabled）</option>
                {b0Tools.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {b0Tools.length === 0 && <span style={{ ...hint, color: 'var(--warn)', marginTop: 3 }}>没有 enabled 的 codebuddy-gateway 工具</span>}
            </label>
            <label style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={FIELD_LABEL}>触发方式</span>
              <select value={config.trigger} onChange={(e) => update('trigger', e.target.value as 'ready' | 'interval')} style={SELECT}>
                <option value="ready">就绪标记后</option>
                <option value="interval">定时扫描</option>
              </select>
            </label>
            {numberField('扫描间隔', config.intervalMs, 5000, 3600000, 'ms', (n) => update('intervalMs', n), '5 秒 ~ 1 小时；保存后热重载')}
            {numberField('冷却窗口', config.cooldownMs, 60000, 86400000, 'ms', (n) => update('cooldownMs', n), '同一任务两次自动派发的最小间隔')}
            {numberField('每轮上限', config.maxPerTick, 1, 20, '条', (n) => update('maxPerTick', n), '串行提交，避免压垮网关')}
            {numberField('最大尝试', config.maxAttempts, 1, 10, '次', (n) => update('maxAttempts', n), '连续失败达到上限后转人工')}
            {numberField('审计保留', config.retentionDays, 1, 365, '天', (n) => update('retentionDays', n), '每天清理一次 dispatch_attempts')}
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-s)' }}>
              <input type="checkbox" checked={config.allowFallbackA} onChange={(e) => update('allowFallbackA', e.target.checked)} />
              B0 失败后回落 A 就绪池
            </label>
            <div style={{ ...FIELD_CARD, padding: 8, fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
              自动 D：<b style={{ color: 'var(--danger)' }}>关闭（硬边界）</b>。D 仅允许人工在任务详情确认。
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ ...FIELD_LABEL, marginBottom: 6 }}>项目范围（空=不启用）</div>
            {projects.length === 0 ? <div style={hint}>没有可派发的项目</div> : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 'var(--fs-s)' }}>
                {projects.map((p) => (
                  <label key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <input
                      type="checkbox"
                      checked={config.scopeProjectIds.includes(p.id)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...config.scopeProjectIds, p.id]
                          : config.scopeProjectIds.filter((id) => id !== p.id);
                        update('scopeProjectIds', next);
                      }}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 候选与试运行 */}
      <div style={card}>
        <div style={{ ...row, marginBottom: 8 }}>
          <b style={{ fontSize: 'var(--fs-m)' }}>候选预览与手动补跑</b>
          <span style={{ flex: 1 }} />
          <button onClick={() => void preview()} disabled={busy === 'preview'} style={BTN_SECONDARY_MD}>
            {busy === 'preview' ? <Loader2 size={12} className="aispin" /> : <RefreshCw size={12} />} 预览候选
          </button>
          <button onClick={() => void run(true)} disabled={busy === 'dry' || busy === 'run'} style={BTN_SECONDARY_MD}>
            {busy === 'dry' ? <Loader2 size={12} className="aispin" /> : <Play size={12} />} 试运行
          </button>
          <button onClick={() => void run(false)} disabled={busy === 'run' || busy === 'dry'} style={BTN_PRIMARY} title="真实提交，最多本轮上限">
            {busy === 'run' ? <Loader2 size={12} className="aispin" /> : <Play size={12} />} 立即跑一轮
          </button>
        </div>
        {candidates === null ? (
          <div style={hint}>点「预览候选」查看下一轮会处理哪些任务；候选查询只读，不改任务。</div>
        ) : candidates.length === 0 ? (
          <div style={hint}>当前没有符合条件的候选。请检查：项目范围已选、任务已就绪、AI 状态为空、未在冷却期、未被指定给其他平台。</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '4px 6px' }}>任务</th>
                  <th style={{ padding: '4px 6px' }}>项目</th>
                  <th style={{ padding: '4px 6px' }}>优先级</th>
                  <th style={{ padding: '4px 6px' }}>上次派发</th>
                  <th style={{ padding: '4px 6px' }}>本轮</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '4px 6px' }}><span style={{ color: 'var(--accent)' }}>{c.task_no ?? c.id.slice(0, 8)}</span> {c.title}</td>
                    <td style={{ padding: '4px 6px' }}>{projectMap.get(c.project_id) ?? c.project_name}</td>
                    <td style={{ padding: '4px 6px' }}>{c.priority}</td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{fmtTime(c.dispatch_last_at)}</td>
                    <td style={{ padding: '4px 6px', color: c.eligible ? 'var(--success)' : 'var(--warn)' }}>{c.eligible ? '将派发' : c.skip_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {runResult && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 'var(--fs-s)' }}>
            <div style={{ ...row }}>
              <b>{runResult.reason === 'dry_run' ? '试运行结果' : '本轮结果'}</b>
              <span style={hint}>候选 {runResult.candidateCount}，提交 {runResult.dispatched}，成功 {runResult.success}，失败 {runResult.failed}，跳过 {runResult.skipped}，耗时 {runResult.durationMs}ms</span>
            </div>
            {(runResult.results ?? []).length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {(runResult.results ?? []).map((r) => (
                  <div key={`${r.taskNo}-${r.channel}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    {r.ok ? <CheckCircle2 size={12} style={{ color: 'var(--success)' }} /> : <XCircle size={12} style={{ color: 'var(--danger)' }} />}
                    <span style={{ color: 'var(--accent)' }}>{r.taskNo}</span>
                    <span>{r.channel} · {r.state}</span>
                    <span style={{ ...hint, flex: 1, wordBreak: 'break-word' }}>{r.detail}</span>
                  </div>
                ))}
              </div>
            )}
            {(runResult.results ?? []).length === 0 && <div style={{ ...hint, marginTop: 4 }}>没有提交任务；见上方候选跳过原因。</div>}
          </div>
        )}
      </div>

      <div style={{ ...hint, display: 'flex', alignItems: 'center', gap: 5 }}>
        <Clock size={12} /> 自动派发只处理「就绪」任务；暂停期间不补跑，需要补跑请用上方「立即跑一轮」。
      </div>
    </div>
  );
}
