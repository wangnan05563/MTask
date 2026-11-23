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
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { HoverCard } from '../ui/HoverCard';
import { ProjectListHint, useProjectList } from '../ui/projectList';
import { CircleHelp, Eye, ListChecks, Plus, RefreshCw, Save, ScanLine, ShieldCheck, Trash2 } from 'lucide-react';
import { SettingsHelpIcon } from '../ui/settingsHelp'; // T06019：子页说明文字改为语义图标

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
  scanner?: { ok: boolean; version?: string; note?: string };
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

interface SonarProjectOption {
  key: string;
  name: string;
}

const EMPTY_CFG: ConfigView = {
  serverUrl: '', tokenConfigured: false, tokenMasked: '', scannerPath: '',
  projectKeys: {}, scanLimit: 1, gateLimitEffective: 1,
  scanner: { available: false, resolved: '', version: '', hint: '' },
  java: { available: false, resolved: '', version: '', hint: '' },
};

// T05788：输入框收缩并受控——boxSizing 让 padding/border 计入宽度（全局无 border-box reset，
// 缺它时 width:100% 会溢出容器被右栏裁切）；maxWidth 限制最长，minWidth:0 防止 flex 子项撑破左栏。
const fieldStyle: React.CSSProperties = { width: '100%', maxWidth: 480, minWidth: 0, minHeight: 36, boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginBottom: 4 };
const btnStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 36, boxSizing: 'border-box', padding: '6px 12px', fontSize: 'var(--fs-s)', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer' };
/** 主按钮：此前只挂了不存在的 .primary 类，390 下退化成 19px 原生按钮；改为显式样式。 */
const primaryBtnStyle: React.CSSProperties = { ...btnStyle, padding: '6px 16px', borderColor: 'var(--accent)', background: 'var(--accent)', color: '#fff' };

/** T05773：右栏信息卡片。卡片不承载表单，纯展示；标题与正文分区固定，便于左右栏对齐。 */
function SonarCard({ title, extra, children }: { readonly title: string; readonly extra?: ReactNode; readonly children: ReactNode }) {
  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', padding: 12 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 'var(--fs-s)', fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        {extra && <span style={{ marginLeft: 'auto' }}>{extra}</span>}
      </header>
      {children}
    </section>
  );
}

/** 项目键可达性一行的人话（原为嵌套三元；抽成纯函数让分支一眼可读） */
function projectKeyDetail(
  project: TestResult['project'],
  msgOf: (kind: string) => string,
): string {
  if (project?.ok) return `projectKey ${project.projectKey}`;
  if (project?.projectKey) return msgOf('project-not-found') || msgOf('unreachable');
  // Token 形态的值会被服务端拒绝外发并回 projectKey=''——这时不能落回「未配置」，
  // 否则用户照着提示去补 key，而真正的原因是贴错了框。
  return msgOf('project-not-found') || '未配置 projectKey';
}

/** 审计行结果文案（成功 / 失败（原因））——原为模板里套三元，抽成纯函数避免嵌套 */
function auditResultText(row: AuditRow): string {
  if (row.ok) return '成功';
  return row.note ? `失败（${row.note}）` : '失败';
}

/** T05773：右栏探针行。状态点只表达“已探测/未探测”，不把未测试的服务器状态说成通过。 */
function ProbeLine({ label, ok, value, hint }: { readonly label: string; readonly ok: boolean; readonly value: string; readonly hint?: string }) {
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>
      <span aria-hidden="true" style={{ color: ok ? 'var(--success, var(--accent))' : 'var(--warn)', flex: '0 0 auto' }}>●</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: 'var(--text)' }}><span style={{ fontWeight: 600 }}>{label}</span> — {value}</div>
        {hint && <div style={{ color: 'var(--text-muted)' }}>{hint}</div>}
      </div>
    </div>
  );
}

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
  const [loading, setLoading] = useState(true);
  const [projectOptions, setProjectOptions] = useState<SonarProjectOption[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [projectSource, setProjectSource] = useState('');
  const [projectsBusy, setProjectsBusy] = useState(false);
  const projectView = useProjectList({ excludeInbox: true });

  const applyCfg = (c: ConfigView) => {
    setCfg(c);
    setServerDraft(c.serverUrl);
    setScannerDraft(c.scannerPath);
    setScanLimit(c.scanLimit);
    setKeys(Object.entries(c.projectKeys).map(([projectId, projectKey]) => ({ projectId, projectKey })));
  };

  async function load() {
    setLoading(true);
    try {
      applyCfg(await api.get<ConfigView>('/settings/sonar'));
      setError('');
    } catch (e) {
      setError(`配置读取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
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

  /** 清除 Token：独立确认，且只提交 token 字段——不能顺带保存地址/扫描器/projectKey 的未保存草稿。 */
  async function clearToken() {
    const ok = await askConfirm('清除已保存的 Sonar Token？清除后需要重新录入才能访问需要认证的实例；此动作不可撤销。');
    if (!ok) return;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const r = await api.put<ConfigView>('/settings/sonar', { token: '' });
      // 只回填 Token 状态，保留用户尚未保存的其他草稿，避免「清除 Token」顺手覆盖表单。
      setCfg((prev) => ({ ...prev, tokenConfigured: r.tokenConfigured, tokenMasked: r.tokenMasked }));
      setTokenDraft('');
      setRevealed('');
      setNotice('Token 已清除；其他未保存的修改未提交');
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

  /** T04545：从 SonarQube 读取 projectKey 候选；输入框保留自由手输，服务列表只作为下拉候选。 */
  async function loadProjects() {
    setProjectsBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { serverUrl: serverDraft };
      if (tokenDraft.trim()) body.token = tokenDraft.trim();
      const r = await api.post<{ serverUrl: string; projects: SonarProjectOption[]; total: number }>(
        '/settings/sonar/projects',
        body,
      );
      setProjectOptions(r.projects);
      setProjectTotal(r.total);
      setProjectSource(r.serverUrl);
      setNotice(`已加载 ${r.projects.length} 个 Sonar projectKey`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectsBusy(false);
    }
  }

  /** 三项连接测试：用当前草稿（未保存也能测），结果按项分别回显 */
  async function test() {
    setBusy('test');
    setError('');
    setNotice('');
    setRows([]);
    try {
      const body: Record<string, unknown> = { serverUrl: serverDraft, scannerPath: scannerDraft };
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
          detail: r.scanner?.ok
            ? `${r.scanner.version ?? ''}${r.scanner.note ? ` · ${r.scanner.note}` : ''}`
            : msgOf('no-scanner'),
          hint: r.scanner?.ok ? '' : hintOf('no-scanner'),
        },
        {
          label: '项目键可达性（/api/components/show）',
          ok: r.project?.ok === true,
          detail: projectKeyDetail(r.project, msgOf),
          hint: r.project?.ok ? '' : hintOf('project-not-found') || hintOf('unreachable') || hintOf('no-scanner'),
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  const serverTest = rows.find((r) => r.label.startsWith('服务器状态'));

  return (
    <div
      data-t03371="sonar-tab"
      data-project-source={projectSource}
      className="sonar-config-grid"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16, alignItems: 'start' }}
    >
      {/* T05773：响应式双栏——1024px 以下堆叠，左栏先于右栏，保持原有 Tab 焦点顺序。 */}
      <style>{`
        .sonar-config-grid { width: 100%; }
        .sonar-config-left, .sonar-config-right { min-width: 0; }
        /* T05788：左栏表单区加边框与内边距，明确区域边界；overflow-x hidden 兜底防止输入框撑破。 */
        .sonar-config-left {
          box-sizing: border-box;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 14px;
          background: var(--card-bg);
          overflow-x: hidden;
        }
        .sonar-config-left input, .sonar-config-left select { max-width: 100%; box-sizing: border-box; }
        .sonar-card-scroll { max-height: 300px; overflow-y: auto; overscroll-behavior: contain; }
        @media (max-width: 1024px) {
          .sonar-config-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
        /* 窄屏把 projectKey 行拆成两行：项目选择占满一行，projectKey + 删除按钮占下一行，避免名称被压成省略号。 */
        @media (max-width: 640px) {
          .sonar-key-row { flex-wrap: wrap !important; }
          .sonar-key-row [data-t03375="key-project"] { flex: 1 1 100% !important; }
          .sonar-key-row [data-t03375="key-value"] { flex: 1 1 calc(100% - 44px) !important; }
        }
      `}</style>

      <div className="sonar-config-left" data-t05788="sonar-left" aria-busy={loading} style={{ display: 'flex', flexDirection: 'column', gap: 14, opacity: loading ? 0.65 : 1, pointerEvents: loading ? 'none' : 'auto' }}>
      <div style={{ marginBottom: 2 }}>
        <SettingsHelpIcon
          icon={ScanLine}
          label="SonarQube"
          ariaDescription="SonarQube 连接参数与扫描环境。首版按 Community 版实现（用 sonar.inclusions 收窄增量），分支/PR 模式列为后续迭代。"
          description={<>SonarQube 连接参数与扫描环境。首版按 Community 版实现（用 <code>sonar.inclusions</code> 收窄增量），分支/PR 模式列为后续迭代。</>}
        />
      </div>

      <HoverCard
        ariaLabel="服务器地址填写说明"
        testId="sonar-server-hint"
        cardW={390}
        cardH={112}
        style={{ display: 'block' }}
        card={<div style={{ lineHeight: 1.65 }}>仅允许 http/https；保存时自动去掉结尾斜杠；地址里不能带账号口令（凭据请填下面的 Token）。</div>}
      >
        <label style={labelStyle} htmlFor="sonar-server-url"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>服务器地址<CircleHelp size={12} aria-hidden="true" /></span></label>
        <input
          id="sonar-server-url"
          data-t03372="server-url"
          style={fieldStyle}
          value={serverDraft}
          placeholder="http://127.0.0.1:9000"
          onChange={(e) => {
            setServerDraft(e.target.value);
            setProjectOptions([]);
            setProjectTotal(0);
            setProjectSource('');
          }}
        />
      </HoverCard>

      <HoverCard
        ariaLabel="认证 Token 填写说明"
        testId="sonar-token-hint"
        cardW={430}
        cardH={128}
        style={{ display: 'block' }}
        card={<div style={{ lineHeight: 1.65 }}>Token 以 AES-256-GCM 密文落库；查看原文需二次确认并写审计。留空保存不会改动现有 Token，「清除」会显式清空。</div>}
      >
        <label style={labelStyle} htmlFor="sonar-token"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>认证 Token（密文存储，默认脱敏）<CircleHelp size={12} aria-hidden="true" /></span></label>
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
            <button type="button" style={btnStyle} data-t03373="clear" onClick={() => void clearToken()} disabled={busy === 'save'} aria-label="清除已保存的 Token">清除</button>
          )}
        </div>
        <div data-t03373="token-state" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
          {cfg.tokenConfigured ? `当前：${cfg.tokenMasked}（AES-256-GCM 密文落库；查看原文需二次确认并写审计）` : '未配置 Token；匿名可读的实例可留空。'}
          {revealed && <b style={{ color: 'var(--warn)', marginLeft: 8 }}>原文仅在输入框展开；点「隐藏」或离开页签即清除</b>}
        </div>
      </HoverCard>

      <HoverCard
        ariaLabel="扫描器路径填写说明"
        testId="sonar-scanner-hint"
        cardW={360}
        cardH={88}
        style={{ display: 'block' }}
        card={<div style={{ lineHeight: 1.65 }}>留空按系统 PATH 探测 sonar-scanner；探测到的路径与版本在右栏「自动检测」实时展示。</div>}
      >
        <label style={labelStyle} htmlFor="sonar-scanner-path"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>扫描器路径<CircleHelp size={12} aria-hidden="true" /></span></label>
        <input
          id="sonar-scanner-path"
          data-t03375="scanner-path"
          style={fieldStyle}
          value={scannerDraft}
          placeholder="留空则按系统 PATH 探测 sonar-scanner"
          onChange={(e) => setScannerDraft(e.target.value)}
        />
      </HoverCard>

      <div>
        <div style={labelStyle}>默认 projectKey 映射</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <button
            type="button"
            style={btnStyle}
            data-t04545="load-projects"
            onClick={() => void loadProjects()}
            disabled={projectsBusy}
          >
            <ListChecks size={14} /> {projectsBusy ? '读取项目…' : '从服务器读取 projectKey'}
          </button>
          <span data-t04545="projects-state" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            {projectOptions.length
              ? `已加载 ${projectOptions.length} 个${projectTotal > projectOptions.length ? `（服务器共 ${projectTotal} 个）` : ''}`
              : '可选后仍可手动输入'}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {keys.map((k, i) => (
            <div key={`${k.projectId || 'new'}-${i}`} data-t03375="key-row" className="sonar-key-row" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
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
                list="sonar-project-key-options"
                onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, projectKey: e.target.value } : x)))}
              />
              <button type="button" style={btnStyle} aria-label="删除该映射" onClick={() => setKeys(keys.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
          <datalist id="sonar-project-key-options">
            {projectOptions.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
          </datalist>
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

      <HoverCard
        ariaLabel="扫描并发上限填写说明"
        testId="sonar-limit-hint"
        cardW={370}
        cardH={104}
        style={{ display: 'block' }}
        card={<div style={{ lineHeight: 1.65 }}>1 — 逐个扫描（默认）；2 — 允许两个并行。与既有导出族共用闸机制，超限返回 429 且不排队。</div>}
      >
        <label style={labelStyle} htmlFor="sonar-scan-limit"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>扫描并发上限（1–2）<CircleHelp size={12} aria-hidden="true" /></span></label>
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
      </HoverCard>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" style={primaryBtnStyle} data-t03372="save" onClick={() => void save()} disabled={busy === 'save'}>
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

      {notice && <output data-t03372="notice" style={{ display: 'block', fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{notice}</output>}
      {error && <div role="alert" data-t03427="error" style={{ fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>{error}</div>}
      </div>

      <aside className="sonar-config-right" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SonarCard
          title="自动检测"
          extra={<button type="button" style={{ ...btnStyle, padding: '4px 8px' }} onClick={() => { void load(); void api.get<{ rows: AuditRow[] }>('/settings/sonar/audit').then((r) => setAudit(r.rows)).catch(() => undefined); }} aria-label="重新探测 Sonar 环境">重新探测</button>}
        >
          {loading ? (
            <div data-t05773="config-loading" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {[74, 58, 66].map((w, i) => (
                <div key={i} style={{ height: 11, width: `${w}%`, borderRadius: 4, background: 'var(--surface-2)' }} />
              ))}
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>正在读取配置与环境探针…</div>
            </div>
          ) : (
            <div data-t05773="auto-detect-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <ProbeLine label="服务器地址" ok={!!cfg.serverUrl} value={cfg.serverUrl || '未配置'} hint={cfg.serverUrl ? '保存后可用左侧「连接测试」校验版本与状态' : '请先在左栏填写 SonarQube 地址'} />
              <ProbeLine label="服务器状态" ok={serverTest?.ok === true} value={serverTest ? serverTest.detail : '未测试'} hint={serverTest && !serverTest.ok ? serverTest.hint : '连接测试后会在此显示版本、版本线与状态'} />
              <div data-t03375="scanner-probe">
                <ProbeLine label="扫描器" ok={cfg.scanner.available} value={cfg.scanner.available ? `${cfg.scanner.version}` : '未探测到'} hint={cfg.scanner.available ? cfg.scanner.resolved : cfg.scanner.hint} />
              </div>
              <div data-t03375="java-probe">
                <ProbeLine label="Java 环境" ok={cfg.java.available} value={cfg.java.available ? cfg.java.version : '未探测到'} hint={cfg.java.available ? cfg.java.resolved : cfg.java.hint} />
              </div>
              <ProbeLine label="认证 Token" ok={cfg.tokenConfigured} value={cfg.tokenConfigured ? cfg.tokenMasked : '未配置'} hint={cfg.tokenConfigured ? 'AES-256-GCM 密文落库；查看原文需二次确认并写审计' : '匿名实例可留空'} />
            </div>
          )}
        </SonarCard>

        <SonarCard title="连接测试">
          <div data-t03374="test-rows" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {busy === 'test' && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>正在测试服务器、扫描器与项目键…</div>}
            {rows.length === 0 && busy !== 'test' && (
              <div data-t03374="test-empty" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                尚未运行连接测试；左栏「连接测试（三项）」会使用当前草稿地址与 Token，无需先保存。
              </div>
            )}
            {rows.map((r) => (
              <div key={r.label} data-t03374="test-row" style={{ fontSize: 'var(--fs-xs)', color: r.ok ? 'var(--text-muted)' : 'var(--danger)' }}>
                <span style={{ fontWeight: 600, color: r.ok ? 'var(--success, var(--accent))' : 'var(--danger)' }}>{r.ok ? '通过' : '失败'} · </span>
                {r.label} — {r.detail || '—'}
                {!r.ok && r.hint && <div style={{ marginTop: 2, color: 'var(--warn)' }}>指引：{r.hint}</div>}
              </div>
            ))}
          </div>
        </SonarCard>

        <SonarCard title="配置概览">
          <div data-t05773="config-summary" style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            <span>projectKey 映射：{keys.filter((k) => k.projectKey.trim()).length} 个</span>
            <span data-t03375="gate-effective">扫描并发上限：{scanLimit}（当前生效闸上限 {cfg.gateLimitEffective}）</span>
            <span>加载的 Sonar 项目候选：{projectOptions.length} 个{projectTotal > projectOptions.length ? `（服务器共 ${projectTotal} 个）` : ''}</span>
          </div>
        </SonarCard>

        <SonarCard title="质量扫描概览">
          <div data-t05773="quality-empty" style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            <span>代码库规模：暂无数据</span>
            <span>扫描进度：暂无运行中的扫描</span>
            <span>质量问题：暂无扫描结果</span>
            <div style={{ marginTop: 2, lineHeight: 1.5 }}>统计由「报告 → Sonar 质量扫描」面板提供；本配置页只读连接参数，不缓存扫描结果。</div>
          </div>
        </SonarCard>

        <SonarCard title="Token 查看审计" extra={<span data-t03373="audit-count" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{audit.length} 条</span>}>
          <div className="sonar-card-scroll" data-t03373="audit-list" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {audit.length === 0 && <span data-t03373="audit-empty">暂无查看记录（审计只记时间与服务器地址，不记 Token 本身）</span>}
            {audit.map((a, i) => (
              <span key={`${a.revealedAt}-${i}`} data-t03373="audit-row">
                {a.revealedAt.replace('T', ' ').slice(0, 19)} · {auditResultText(a)} · {a.serverUrl || '（未配置地址）'}
              </span>
            ))}
          </div>
        </SonarCard>
      </aside>
    </div>
  );
}
