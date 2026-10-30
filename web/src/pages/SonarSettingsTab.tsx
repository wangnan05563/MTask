/**
 * T03372 / T03373 / T03374 / T03375 / T03405 / T03406 / T03427（八期 §3.4.1）
 * 设置页「SonarQube」子页：服务器地址、认证 Token（密文 + 脱敏 + 二次确认查看 + 审计）、
 * 扫描器路径（留空按 PATH 探测）、Java 环境（只读探测展示）、projectKey 映射、扫描并发上限（1–2），
 * 以及三项连接测试（服务器状态 / 扫描器版本 / 项目键可达性）。
 *
 * 三条实现约束（都是踩过坑的地方，别改回去）：
 *  - Token 明文只在 `reveal` 成功后短暂驻留内存，隐藏即清 state——不留副本、不进 localStorage；
 *  - 校验以服务端为准：前端不重复一套 URL 规则，只把 400 的 `error` 原样行内回显（两套规则迟早漂移）；
 *  - 连接测试用的是**草稿值**（未保存也能测），与 `update/test` 同口径，避免「先保存才能测」的多余门槛。
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { ProjectListHint, useProjectList } from '../ui/projectList';
import { Eye, EyeOff, Plus, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react';

interface ProbeView {
  available: boolean;
  resolved: string;
  version: string;
  hint: string;
}

interface ConfigView {
  serverUrl: string;
  tokenConfigured: boolean;
  tokenMasked: string;
  scannerPath: string;
  projectKeys: Record<string, string>;
  scanLimit: number;
  gateLimitEffective: number;
  scanner: ProbeView;
  java: ProbeView;
}

interface TestRow {
  label: string;
  ok: boolean;
  detail: string;
  hint: string;
}

interface TestResult {
  server?: { ok: boolean; version?: string; edition?: string; status?: string };
  scanner?: { ok: boolean; version?: string };
  java?: { ok: boolean };
  project?: { ok: boolean; projectKey?: string };
  errors: Array<{ kind: string; message: string; hint: string }>;
}

interface AuditRow {
  revealedAt: string;
  serverUrl: string;
  ok: boolean;
  note: string;
}

const EMPTY_CFG: ConfigView = {
  serverUrl: '', tokenConfigured: false, tokenMasked: '', scannerPath: '',
  projectKeys: {}, scanLimit: 1, gateLimitEffective: 1,
  scanner: { available: false, resolved: '', version: '', hint: '' },
  java: { available: false, resolved: '', version: '', hint: '' },
};

const fieldStyle: React.CSSProperties = { width: '100%', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 4 };
const btnStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 'var(--fs-s)', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' };

export function SonarSettingsTab() {
  const [cfg, setCfg] = useState<ConfigView>(EMPTY_CFG);
  const [serverDraft, setServerDraft] = useState('');
  const [scannerDraft, setScannerDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [keys, setKeys] = useState<Array<{ projectId: string; projectKey: string }>>([]);
  const [scanLimit, setScanLimit] = useState(1);
  const [revealed, setRevealed] = useState('');
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [rows, setRows] = useState<TestRow[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'reveal'>('');
  const projectView = useProjectList({ excludeInbox: true });

  const applyCfg = (c: ConfigView) => {
    setCfg(c);
    setServerDraft(c.serverUrl);
    setScannerDraft(c.scannerPath);
    setScanLimit(c.scanLimit);
    setKeys(Object.entries(c.projectKeys).map(([projectId, projectKey]) => ({ projectId, projectKey })));
  };

  async function load() {
    try {
      applyCfg(await api.get<ConfigView>('/settings/sonar'));
      setError('');
    } catch (e) {
      setError(`配置读取失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useEffect(() => {
    void load();
    void api.get<{ rows: AuditRow[] }>('/settings/sonar/audit').then((r) => setAudit(r.rows)).catch(() => undefined);
  }, []);

  /** 保存：Token 留空=不改动，「清除已存 Token」显式送空串；projectKey 空值由服务端剔除 */
  async function save(extraTokenClear = false) {
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const body: Record<string, unknown> = {
        serverUrl: serverDraft,
        scannerPath: scannerDraft,
        scanLimit: Number(scanLimit),
        projectKeys: Object.fromEntries(keys.filter((k) => k.projectId).map((k) => [k.projectId, k.projectKey])),
      };
      if (extraTokenClear) body.token = '';
      else if (tokenDraft.trim()) body.token = tokenDraft.trim();
      applyCfg(await api.put<ConfigView>('/settings/sonar', body));
      setTokenDraft('');
      setRevealed('');
      setNotice(extraTokenClear ? '已保存（Token 已清除）' : '已保存 — 建议点「连接测试」确认三项都能通过');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  /** 查看原文：二次确认在服务端也设了门（confirm 缺失即 400），这里的弹窗不是唯一防线 */
  async function reveal() {
    const ok = await askConfirm('查看 Sonar Token 原文会写入审计记录（谁、何时、看了哪台服务器的 Token）。确认继续？');
    if (!ok) return;
    setBusy('reveal');
    setError('');
    try {
      const r = await api.post<{ token: string; revealedAt: string }>('/settings/sonar/reveal', { confirm: true });
      setRevealed(r.token);
      setAudit((await api.get<{ rows: AuditRow[] }>('/settings/sonar/audit')).rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  function hideToken() {
    setRevealed('');
  }

  /** 三项连接测试：用当前草稿（未保存也能测），结果按项分别回显 */
  async function test() {
    setBusy('test');
    setError('');
    setRows([]);
    try {
      const body: Record<string, unknown> = { serverUrl: serverDraft };
      if (tokenDraft.trim()) body.token = tokenDraft.trim();
      const firstKey = keys.find((k) => k.projectKey)?.projectKey ?? '';
      if (firstKey) body.projectKey = firstKey;
      const r = await api.post<TestResult>('/settings/sonar/test', body);
      const hintOf = (kind: string) => r.errors.find((x) => x.kind === kind)?.hint ?? '';
      const msgOf = (kind: string) => r.errors.find((x) => x.kind === kind)?.message ?? '';
      setRows([
        {
          label: '服务器状态（/api/system/status）',
          ok: r.server?.ok === true,
          detail: r.server?.ok ? `版本 ${r.server.version || '—'} · 版本线 ${r.server.edition || '—'} · 状态 ${r.server.status || '—'}` : msgOf('unreachable') || msgOf('auth-failed'),
          hint: r.server?.ok ? '' : hintOf('unreachable') || hintOf('auth-failed'),
        },
        {
          label: '扫描器（sonar-scanner -v）',
          ok: r.scanner?.ok === true,
          detail: r.scanner?.ok ? r.scanner.version ?? '' : msgOf('no-scanner'),
          hint: r.scanner?.ok ? '' : hintOf('no-scanner'),
        },
        {
          label: '项目键可达性（/api/projects/show）',
          ok: r.project?.ok === true,
          detail: r.project?.ok ? `projectKey ${r.project.projectKey}` : (r.project?.projectKey ? msgOf('project-not-found') || msgOf('unreachable') : '未配置 projectKey'),
          hint: r.project?.ok ? '' : hintOf('project-not-found') || hintOf('unreachable') || hintOf('no-scanner'),
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  const tokenShown = revealed || (cfg.tokenConfigured ? cfg.tokenMasked : '');

  return (
    <div data-t03371="sonar-tab" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
        SonarQube 连接参数与扫描环境。首版按 Community 版实现（用 <code>sonar.inclusions</code> 收窄增量），分支/PR 模式列为后续迭代。
      </div>

      <div>
        <label style={labelStyle} htmlFor="sonar-server-url">服务器地址</label>
        <input
          id="sonar-server-url"
          data-t03372="server-url"
          style={fieldStyle}
          value={serverDraft}
          placeholder="http://127.0.0.1:9000"
          onChange={(e) => setServerDraft(e.target.value)}
        />
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
          仅允许 http/https；保存时自动去掉结尾斜杠；地址里不能带账号口令（凭据请填下面的 Token）。
        </div>
      </div>

      <div>
        <label style={labelStyle} htmlFor="sonar-token">认证 Token（密文存储，默认脱敏）</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            id="sonar-token"
            data-t03373="token"
            style={{ ...fieldStyle, flex: '1 1 260px' }}
            type={revealed ? 'text' : 'password'}
            value={revealed || tokenDraft}
            placeholder={cfg.tokenConfigured ? `已保存（${cfg.tokenMasked}），留空即不改动` : '生成于 SonarQube「我的账户 → 安全」'}
            onChange={(e) => {
              if (revealed) hideToken();
              setTokenDraft(e.target.value);
            }}
          />
          {cfg.tokenConfigured && (
            revealed
              ? <button type="button" style={btnStyle} data-t03373="hide" onClick={hideToken} aria-label="隐藏 Token 原文"><Eye size={14} /> 隐藏</button>
              : <button type="button" style={btnStyle} data-t03373="reveal" onClick={() => void reveal()} disabled={busy === 'reveal'} aria-label="查看 Token 原文"><Eye size={14} /> 查看原文</button>
          )}
          {cfg.tokenConfigured && !revealed && !tokenDraft.trim() && (
            <button type="button" style={btnStyle} data-t03373="clear" onClick={() => void save(true)} disabled={busy === 'save'} aria-label="清除已保存的 Token">清除</button>
          )}
        </div>
        <div data-t03373="token-state" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
          {cfg.tokenConfigured ? `当前：${tokenShown}（AES-256-GCM 密文落库；查看原文需二次确认并写审计）` : '未配置 Token；匿名可读的实例可留空。'}
          {revealed && <b style={{ color: 'var(--warn)', marginLeft: 8 }}>原文已展开 — 离开页签或点「隐藏」即清除</b>}
        </div>
      </div>

      <div>
        <label style={labelStyle} htmlFor="sonar-scanner-path">扫描器路径</label>
        <input
          id="sonar-scanner-path"
          data-t03375="scanner-path"
          style={fieldStyle}
          value={scannerDraft}
          placeholder="留空则按系统 PATH 探测 sonar-scanner"
          onChange={(e) => setScannerDraft(e.target.value)}
        />
        <div data-t03375="scanner-probe" style={{ fontSize: 'var(--fs-xs)', marginTop: 4, color: cfg.scanner.available ? 'var(--text-muted)' : 'var(--warn)' }}>
          {cfg.scanner.available ? `探测到：${cfg.scanner.resolved} · ${cfg.scanner.version}` : `未探测到可用扫描器 — ${cfg.scanner.hint}`}
        </div>
      </div>

      <div>
        <label style={labelStyle}>Java 环境（只读探测）</label>
        <div data-t03375="java-probe" style={{ fontSize: 'var(--fs-xs)', color: cfg.java.available ? 'var(--text-muted)' : 'var(--warn)' }}>
          {cfg.java.available ? `探测到：${cfg.java.version}` : `未探测到 Java — ${cfg.java.hint}`}
        </div>
      </div>

      <div>
        <label style={labelStyle}>默认 projectKey 映射</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {keys.map((k, i) => (
            <div key={`${k.projectId || 'new'}-${i}`} data-t03375="key-row" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                data-t03375="key-project"
                aria-label={`映射项目 ${i + 1}`}
                style={{ ...fieldStyle, flex: '1 1 180px' }}
                value={k.projectId}
                onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, projectId: e.target.value } : x)))}
              >
                <option value="">{projectView.phase === 'loading' ? '项目列表加载中…' : '选择项目…'}</option>
                {projectView.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input
                data-t03375="key-value"
                aria-label={`Sonar project key ${i + 1}`}
                style={{ ...fieldStyle, flex: '1 1 200px' }}
                value={k.projectKey}
                placeholder="Sonar project key"
                onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, projectKey: e.target.value } : x)))}
              />
              <button type="button" style={btnStyle} aria-label="删除该映射" onClick={() => setKeys(keys.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
          {keys.length === 0 && (
            <div data-t03375="key-empty" style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn)' }}>
              尚未配置任何 projectKey —— 未配置的项目在扫描面板里会被要求先补上。
            </div>
          )}
          <div>
            <button type="button" style={btnStyle} data-t03375="key-add" onClick={() => setKeys([...keys, { projectId: '', projectKey: '' }])}><Plus size={14} /> 添加映射</button>
          </div>
        </div>
        {projectView.phase === 'error' && <ProjectListHint view={projectView} />}
      </div>

      <div>
        <label style={labelStyle} htmlFor="sonar-scan-limit">扫描并发上限（1–2）</label>
        <select
          id="sonar-scan-limit"
          data-t03375="scan-limit"
          style={{ ...fieldStyle, maxWidth: 160 }}
          value={scanLimit}
          onChange={(e) => setScanLimit(Number(e.target.value))}
        >
          <option value={1}>1 — 逐个扫描（默认）</option>
          <option value={2}>2 — 允许两个并行</option>
        </select>
        <div data-t03375="gate-effective" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
          当前生效闸上限：{cfg.gateLimitEffective}（与既有导出族共用闸机制，超限返回 429 且不排队）
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="primary" data-t03372="save" onClick={() => void save()} disabled={busy === 'save'}>
          <Save size={14} /> {busy === 'save' ? '保存中…' : '保存配置'}
        </button>
        <button type="button" style={btnStyle} data-t03374="test" onClick={() => void test()} disabled={busy === 'test'}>
          <RefreshCw size={14} /> {busy === 'test' ? '测试中…' : '连接测试（三项）'}
        </button>
        <button type="button" style={btnStyle} onClick={() => { void load(); void api.get<{ rows: AuditRow[] }>('/settings/sonar/audit').then((r) => setAudit(r.rows)).catch(() => undefined); }}>
          重新探测
        </button>
        {cfg.serverUrl && (
          // 外链只在 http/https 且已校验过的地址上生成；渲染层不做二次拼接
          <a style={{ ...btnStyle, textDecoration: 'none' }} href={`${cfg.serverUrl}/dashboard`} target="_blank" rel="noreferrer">
            <ShieldCheck size={14} /> 打开 SonarQube
          </a>
        )}
      </div>

      {notice && <div role="status" data-t03372="notice" style={{ fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{notice}</div>}
      {error && <div role="alert" data-t03427="error" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>{error}</div>}

      {rows.length > 0 && (
        <div data-t03374="test-rows" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
          <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600 }}>连接测试结果</div>
          {rows.map((r) => (
            <div key={r.label} data-t03374="test-row" style={{ fontSize: 'var(--fs-xs)', color: r.ok ? 'var(--text-muted)' : 'var(--danger)' }}>
              <span style={{ fontWeight: 600, color: r.ok ? 'var(--success, var(--accent))' : 'var(--danger)' }}>{r.ok ? '通过' : '失败'} · </span>
              {r.label} — {r.detail || '—'}
              {!r.ok && r.hint && <div style={{ marginTop: 2, color: 'var(--warn)' }}>指引：{r.hint}</div>}
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={{ fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 6 }}>Token 查看审计</div>
        <div data-t03373="audit-list" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {audit.length === 0 && <span data-t03373="audit-empty">暂无查看记录（审计只记时间与服务器地址，不记 Token 本身）</span>}
          {audit.slice(0, 5).map((a, i) => (
            <span key={`${a.revealedAt}-${i}`} data-t03373="audit-row">
              {a.revealedAt.replace('T', ' ').slice(0, 19)} · {a.ok ? '成功' : `失败${a.note ? `（${a.note}）` : ''}`} · {a.serverUrl || '（未配置地址）'}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
