import { useEffect, useRef, useState } from 'react';
import { api, setAccessToken } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { Copy, Network, Pause, Play, Save, ExternalLink, RefreshCw, PlugZap, KeyRound } from 'lucide-react';

/** 内网穿透：设置页面板。启动后把本地 Web 服务暴露到公网，可手机/远程浏览器访问。 */
export function TunnelPanel() {
  const [status, setStatus] = useState<{ status: string; publicUrl: string | null; provider: string }>({ status: 'stopped', publicUrl: null, provider: '' });
  const [provider, setProvider] = useState<'cloudflare' | 'cpolar' | 'tailscale'>('cloudflare');
  const [localPort, setLocalPort] = useState('0');
  const [binaryPath, setBinaryPath] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [tokenNew, setTokenNew] = useState('');
  const [tunnelMode, setTunnelMode] = useState<'quick' | 'named'>('quick');
  const [cfName, setCfName] = useState('');
  const [cfHostname, setCfHostname] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const [tokenVal, setTokenVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flash = (m: string, isErr = false) => { setNotice(m); setFieldError(isErr ? m : ''); setTimeout(() => { setNotice(''); setFieldError(''); }, 6000); };

  const loadStatus = async () => {
    try { setStatus(await api.get('/tunnel/status')); } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  };
  const loadConfig = async () => {
    try {
      const c = await api.get<Record<string, unknown>>('/tunnel/config');
      setProvider((c.provider ?? 'cloudflare') as typeof provider);
      // localPort 来自 JSON 反序列化的 unknown 值，typeof 收窄后再转字符串，避免 [object Object]
      setLocalPort(String(typeof c.localPort === 'number' || typeof c.localPort === 'string' ? c.localPort : 0));
      setBinaryPath((c.binaryPath as string) ?? '');
      setAutoStart(Boolean(c.autoStart));
      setTokenConfigured(Boolean(c.cpolarAuthtokenConfigured));
      setTokenNew('');
      setTunnelMode((c.tunnelMode === 'named' ? 'named' : 'quick'));
      setCfName((c.tunnelName as string) ?? '');
      setCfHostname((c.hostname as string) ?? '');
      setPathPrefix((c.pathPrefix as string) ?? '');
      setTokenVal((c.accessToken as string) ?? '');
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  };
  useEffect(() => { void loadStatus(); void loadConfig(); }, []);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // T01386：配置载荷统一构造——保存与启动共用，保证「启动的就是界面所见」
  const cfgPayload = () => ({
    provider, localPort: Math.max(Number(localPort) || 0, 0),
    binaryPath, autoStart, tunnelMode, tunnelName: cfName || undefined,
    hostname: cfHostname || undefined, pathPrefix: pathPrefix || undefined,
    certFile: undefined,
    cpolarAuthtoken: tokenNew || undefined,
  });

  const saveConfig = async () => {
    setBusy(true);
    try {
      await api.post('/tunnel/config', cfgPayload());
      flash('配置已保存');
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); } finally { setBusy(false); }
  };

  const start = async () => {
    // T01386：根因是「启动」用的是**已保存**的旧配置——用户选了 Tailscale 但未保存时点启动，
    // 服务端仍按旧 provider（cloudflare）启动，表现为误连 trycloudflare.com。
    // 修复：启动前先以界面当前选择保存配置，保证「启动的就是界面所见」。
    // 二进制缺失等异常由服务端 ensureBinary 抛出明确文案（「未检测到 Tailscale…」）。
    setBusy(true); setAuthUrl('');
    try {
      await api.post('/tunnel/config', cfgPayload()); // 以界面当前选择为准
      const r = await api.post<{ status: string; publicUrl: string | null; provider: string }>('/tunnel/start');
      setStatus(r);
      flash('隧道已启动');
    } catch (e) {
      // catch 的 e 已是 unknown，直接断言到目标类型即可，先转 unknown 属于冗余断言（S4325）
      const err = e as { message?: string; errorType?: string; authUrl?: string; manualPath?: string; downloadUrls?: string[] };
      const msg = err.message ?? String(e);
      if (err.errorType === 'tailscale_funnel_auth') {
        setAuthUrl(err.authUrl ?? '');
        flash(msg, true);
      } else if (err.errorType === 'access_token_required') {
        // T01341：未配令牌被拒——提示直达「生成访问令牌」，而不是让用户在启动失败里猜
        flash(`${msg}（可点下方「重新生成」取得令牌）`, true);
      } else if (err.errorType === 'binary_download_failed') {
        flash(`${msg}\n请手动下载并放到: ${err.manualPath}\n${(err.downloadUrls ?? []).join('\n')}`, true);
      } else {
        flash(msg, true);
      }
    } finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true);
    try { setStatus(await api.post('/tunnel/stop')); flash('隧道已停止'); } catch (e) { flash(e instanceof Error ? e.message : String(e), true); } finally { setBusy(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* 忽略 */ }
  };

  const resetAccess = async () => {
    if (!(await askConfirm('重新生成访问令牌？旧令牌将立即失效，需在其它已登录设备重新配置。'))) return;
    try {
      const r = await api.post<{ accessToken: string; message: string }>('/tunnel/reset-token');
      setTokenVal(r.accessToken);
      setAccessToken(r.accessToken); // 同步前端随后的请求都带新令牌，避免立即 401
      flash(r.message);
    } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  };

  // Cloudflare 命名隧道向导：login → 轮询 → create → route-dns
  const cfLogin = async () => {
    setAuthUrl('');
    const r = await api.post<{ status: string; authUrl?: string | null; message: string; output?: string }>('/tunnel/cloudflare/login');
    if (r.authUrl) setAuthUrl(r.authUrl);
    flash(`login ${r.status === 'failed' ? '失败' : '请求中'}: ${r.message}`, r.status === 'failed');
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.get<{ status: string; authUrl?: string | null; certFile?: string; message: string; output?: string }>('/tunnel/cloudflare/login/status');
        if (s.authUrl) setAuthUrl(s.authUrl);
        if (s.status === 'success') { clearInterval(pollRef.current!); setAuthUrl(''); flash('授权成功，cert.pem 已生成'); }
        else if (s.status === 'failed') { clearInterval(pollRef.current!); flash(s.message, true); }
      } catch { /* 忽略单次轮询错误 */ }
    }, 2500);
  };
  const cfCreate = async () => {
    if (!cfName.trim()) return flash('请填写隧道名称', true);
    try { const r = await api.post<{ message: string }>('/tunnel/cloudflare/create', { tunnelName: cfName.trim() }); flash(r.message); } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  };
  const cfRouteDns = async () => {
    if (!cfHostname.trim()) return flash('请填写固定域名', true);
    if (!(await askConfirm(`确认将域名 ${cfHostname.trim()} 路由到本机？需该域名已在 Cloudflare 托管。`))) return;
    try { const r = await api.post<{ publicUrl: string; message: string }>('/tunnel/cloudflare/route-dns', { hostname: cfHostname.trim() }); setStatus((s) => ({ ...s, publicUrl: r.publicUrl })); flash(r.message); } catch (e) { flash(e instanceof Error ? e.message : String(e), true); }
  };

  const running = status.status === 'running';
  const field = { fontSize: 'var(--fs-m)', padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', width: '100%', boxSizing: 'border-box' } as const;
  const label = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 } as const;
  const card = { border: '1px solid var(--border)', borderRadius: 8, padding: 14, background: 'var(--card-bg)', marginBottom: 12 } as const;
  const ctrl = { fontSize: 'var(--fs-m)', padding: '6px 10px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' } as const;

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 'var(--fs-l)', marginBottom: 4 }}><Network size={15} /> 内网穿透</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        将本机 Web 服务暴露到公网，手机/远程浏览器可通过隧道地址访问使用。支持 Cloudflare / cpolar / Tailscale。
      </div>

      {/* 状态卡 */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <div style={{ fontSize: 'var(--fs-m)', color: running ? 'var(--success)' : 'var(--text-muted)' }}>
              {running ? '● 运行中' : '○ 未运行'} · {provider || '-'}
            </div>
            {status.publicUrl && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <a href={status.publicUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 'var(--fs-m)' }}>{status.publicUrl}</a>
                <button onClick={() => void copy(status.publicUrl ?? '')} title="复制 — 复制公网地址" aria-label="复制公网地址" style={{ display: 'inline-flex', alignItems: 'center', padding: '2px', cursor: 'pointer' }}><Copy size={13} /></button>
                <a href={status.publicUrl} target="_blank" rel="noreferrer" title="打开 — 在新窗口打开公网地址" aria-label="打开公网地址" style={{ display: 'inline-flex', alignItems: 'center', padding: '2px' }}><ExternalLink size={13} /></a>
              </div>
            )}
            {!status.publicUrl && <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-muted)', marginTop: 2 }}>启动后可获得公网地址</div>}
            {/* T01341：未配令牌时提前告知启动会被拒，避免用户点了才撞 400 */}
            {!running && !tokenVal && (
              <div style={{ fontSize: 'var(--fs-m)', color: 'var(--danger)', marginTop: 2 }}>
                未配置访问令牌：穿透会把数据接口无鉴权暴露到公网，启动会被拒绝——请先「重新生成」令牌。
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {running ? (
              <button onClick={() => void stop()} disabled={busy} title="停止 — 关闭内网穿透" aria-label="停止内网穿透" style={{ fontSize: 'var(--fs-m)', padding: '6px 14px', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Pause size={13} />停止</button>
            ) : (
              <button onClick={() => void start()} disabled={busy} title="启动 — 启动内网穿透隧道" aria-label="启动内网穿透" style={{ fontSize: 'var(--fs-m)', padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Play size={13} />{busy ? '启动中…' : '启动'}</button>
            )}
            <button onClick={() => void loadStatus()} title="刷新 — 重新查询隧道状态" aria-label="刷新状态" style={{ fontSize: 12, padding: '6px', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}><RefreshCw size={13} /></button>
          </div>
        </div>
        {authUrl && (
          <div style={{ marginTop: 10, padding: 8, border: '1px solid var(--danger)', borderRadius: 6, fontSize: 'var(--fs-m)', color: 'var(--text)' }}>
            首次使用需授权，请点击：<a href={authUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{authUrl}</a>
          </div>
        )}
      </div>

      {/* 访问令牌：保护公网数据接口 */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 4 }}><KeyRound size={14} /> 访问令牌</div>
        <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>
          启用隧道后，通过公网访问数据接口需携带此令牌（本地使用不受影响）。请妥善保管，可在其它设备填写该令牌。
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <code style={{ flex: 1, minWidth: 200, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--surface)', fontSize: 'var(--fs-m)', wordBreak: 'break-all' }}>{tokenVal || '未生成'}</code>
          <button onClick={() => void copy(tokenVal)} disabled={!tokenVal} title="复制 — 复制访问令牌" aria-label="复制访问令牌" style={ctrl}><Copy size={13} />复制</button>
          <button onClick={() => void resetAccess()} title="重新生成 — 生成新的访问令牌并使旧令牌失效" aria-label="重新生成访问令牌" style={ctrl}><RefreshCw size={13} />重新生成</button>
        </div>
      </div>

      {/* 通用配置 */}
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>隧道配置</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label htmlFor="tunnel-provider" style={label}>提供方</label>
            <select id="tunnel-provider" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)} style={field}>
              <option value="cloudflare">Cloudflare（免注册）</option>
              <option value="cpolar">cpolar（需注册）</option>
              <option value="tailscale">Tailscale Funnel（需安装）</option>
            </select>
          </div>
          <div>
            <label htmlFor="tunnel-local-port" style={label}>本地端口（0=后端端口）</label>
            <input id="tunnel-local-port" value={localPort} onChange={(e) => setLocalPort(e.target.value)} style={field} inputMode="numeric" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="tunnel-binary-path" style={label}>隧道二进制路径（可选，留空自动下载）</label>
            <input id="tunnel-binary-path" value={binaryPath} onChange={(e) => setBinaryPath(e.target.value)} style={field} placeholder="如 D:\tools\cloudflared.exe" />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
          <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
          <span style={{ fontSize: 'var(--fs-m)' }}>后端启动时自动开启隧道</span>
        </div>
      </div>

      {provider === 'cloudflare' && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Cloudflare</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button onClick={() => setTunnelMode('quick')} title="快速隧道 — 免注册自动分配 trycloudflare 域名" aria-pressed={tunnelMode === 'quick'} style={{ fontSize: 'var(--fs-m)', padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border-strong)', background: tunnelMode === 'quick' ? 'var(--accent)' : 'var(--card-bg)', color: tunnelMode === 'quick' ? 'var(--accent-text)' : 'var(--text)', cursor: 'pointer' }}>快速隧道</button>
            <button onClick={() => setTunnelMode('named')} title="固定域名 — 用自有域名（需向导配置）" aria-pressed={tunnelMode === 'named'} style={{ fontSize: 'var(--fs-m)', padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border-strong)', background: tunnelMode === 'named' ? 'var(--accent)' : 'var(--card-bg)', color: tunnelMode === 'named' ? 'var(--accent-text)' : 'var(--text)', cursor: 'pointer' }}>固定域名</button>
          </div>
          {tunnelMode === 'named' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <div>
                <label htmlFor="tunnel-cf-name" style={label}>隧道名称</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input id="tunnel-cf-name" value={cfName} onChange={(e) => setCfName(e.target.value)} style={field} placeholder="如 my-tunnel" />
                  <button onClick={() => void cfLogin()} title="授权 — 登录 Cloudflare 获取 cert.pem" aria-label="Cloudflare 授权登录" style={{ fontSize: 12, padding: '4px 10px', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}><KeyRound size={13} />登录</button>
                  <button onClick={() => void cfCreate()} title="创建 — 创建命名隧道" aria-label="创建命名隧道" style={{ fontSize: 12, padding: '4px 10px', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}><PlugZap size={13} />创建</button>
                </div>
              </div>
              <div>
                <label htmlFor="tunnel-cf-hostname" style={label}>固定域名</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input id="tunnel-cf-hostname" value={cfHostname} onChange={(e) => setCfHostname(e.target.value)} style={field} placeholder="如 tunnel.example.com" />
                  <button onClick={() => void cfRouteDns()} title="路由 — 配置 DNS CNAME 指向该域名" aria-label="配置DNS路由" style={{ fontSize: 12, padding: '4px 10px', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}><Network size={13} />路由</button>
                </div>
              </div>
              <button onClick={() => void saveConfig()} style={{ justifySelf: 'start', fontSize: 'var(--fs-m)', padding: '4px 12px', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Save size={13} />保存配置</button>
            </div>
          )}
        </div>
      )}

      {provider === 'cpolar' && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>cpolar</div>
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>需到 <a href="https://dashboard.cpolar.com/signup" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>cpolar 官网</a> 注册获取 authtoken。</div>
          <label style={label}>authtoken {tokenConfigured ? '（当前已配置，留空保留原值）' : ''}</label>
          <input type="password" value={tokenNew} onChange={(e) => setTokenNew(e.target.value)} style={field} placeholder={tokenConfigured ? '••••（已配置）' : '请输入 authtoken'} autoComplete="new-password" />
        </div>
      )}

      {provider === 'tailscale' && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Tailscale Funnel</div>
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>需本机已安装并登录 Tailscale、启用 MagicDNS，可获取固定 <code>*.ts.net</code> 地址。</div>
          <label htmlFor="tunnel-path-prefix" style={label}>路径前缀（可选，空=根路径）</label>
          <input id="tunnel-path-prefix" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} style={field} placeholder="如 /mtask" />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => void saveConfig()} disabled={busy} title="保存配置 — 保存当前隧道设置" aria-label="保存隧道配置" style={{ fontSize: 'var(--fs-m)', padding: '6px 16px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Save size={13} />保存配置</button>
        {notice && <span style={{ fontSize: 13, color: fieldError ? 'var(--danger)' : 'var(--accent)', alignSelf: 'center' }}>{notice}</span>}
      </div>
    </div>
  );
}