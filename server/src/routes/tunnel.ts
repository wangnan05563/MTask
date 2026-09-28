/**
 * 内网穿透路由（移植自 19_Karpathy 项目，适配 Express）。
 *   GET  /api/tunnel/status                  查询运行状态
 *   POST /api/tunnel/start                   启动隧道
 *   POST /api/tunnel/stop                    停止隧道
 *   GET  /api/tunnel/config                  读取配置（authtoken 脱敏）
 *   POST /api/tunnel/config                  保存配置
 *   POST /api/tunnel/cloudflare/login        启动 cloudflared login（非阻塞）
 *   GET  /api/tunnel/cloudflare/login/status 轮询 login 状态
 *   POST /api/tunnel/cloudflare/create       创建命名隧道
 *   POST /api/tunnel/cloudflare/route-dns    配置 DNS CNAME
 */
import { Router } from 'express';
import {
  TunnelService,
  BinaryDownloadError,
  TailscaleFunnelAuthError,
  CloudflareLoginService,
} from '../tunnel/tunnel-service';
import {
  type TunnelConfig,
  loadTunnelConfig,
  saveTunnelConfig,
  saveTunnelField,
  backendPort,
  regenerateAccessToken,
} from '../tunnel/tunnel-config';
import { isLocalRequest } from '../util/local-request';

const router = Router();

/**
 * 隧道管理仅限本机：公网（经隧道转发）只放行运行状态与脱敏配置查询——
 * 前端需要它们判断「是否已配置访问令牌」并引导用户解锁；其余端点（启停、改配置、
 * 重置令牌、命名隧道向导）都能改变本机状态或夺取控制权，公网任意人可达即为越权面。
 */
router.use((req, res, next) => {
  if (isLocalRequest(req)) {
    next();
    return;
  }
  if (req.method === 'GET' && (req.path === '/status' || req.path === '/config')) {
    next();
    return;
  }
  res.status(403).json({ error: '隧道管理仅限本机操作' });
});

/** 隧道服务单例：管理 provider 生命周期（启动/停止/状态/URL） */
const tunnel = new TunnelService();

/** login 向导单例：login 是两阶段流程（start + poll status），状态须在同一实例上 */
let loginService: CloudflareLoginService | null = null;
function getLoginService(): CloudflareLoginService {
  loginService ??= new CloudflareLoginService();
  return loginService;
}

function statusBody() {
  return { status: tunnel.status, publicUrl: tunnel.publicUrl, provider: tunnel.providerName };
}

router.get('/status', (_req, res) => {
  res.json(statusBody());
});

router.post('/start', async (_req, res) => {
  try {
    const config = loadTunnelConfig();
    await tunnel.start(config, backendPort());
    res.json(statusBody());
  } catch (err) {
    // 二进制下载失败：返回结构化指引，前端渲染手动下载链接
    if (err instanceof BinaryDownloadError) {
      res.status(500).json({
        detail: err.message,
        errorType: 'binary_download_failed',
        manualPath: err.manualPath,
        downloadUrls: err.downloadUrls,
      });
      return;
    }
    // Tailscale Funnel 首次授权：返回授权链接，前端渲染授权向导
    if (err instanceof TailscaleFunnelAuthError) {
      res.status(500).json({
        detail: err.message,
        errorType: 'tailscale_funnel_auth',
        authUrl: err.authUrl,
      });
      return;
    }
    res.status(500).json({ detail: `隧道启动失败: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
});

router.post('/stop', (_req, res) => {
  tunnel.stop();
  res.json(statusBody());
});

router.get('/config', (req, res) => {
  const t = loadTunnelConfig();
  res.json({
    provider: t.provider,
    localPort: t.localPort,
    cpolarAuthtokenMasked: maskToken(t.cpolarAuthtoken),
    cpolarAuthtokenConfigured: Boolean(t.cpolarAuthtoken),
    binaryPath: t.binaryPath,
    autoStart: t.autoStart,
    tunnelMode: t.tunnelMode,
    tunnelName: t.tunnelName,
    tunnelId: t.tunnelId,
    credentialsFile: t.credentialsFile,
    hostname: t.hostname,
    certFileConfigured: Boolean(t.certFile),
    pathPrefix: t.pathPrefix,
    // 明文令牌只在本机下发（前端据此自动解锁，无需手工输入）；公网仅给脱敏串与「是否已配置」标志——
    // 否则任何拿到隧道 URL 的人都能读走令牌，从而完全接管数据接口与隧道管理。
    accessToken: isLocalRequest(req) ? t.accessToken : '',
    accessTokenMasked: maskToken(t.accessToken),
    accessTokenConfigured: Boolean(t.accessToken),
  });
});

/** 生成/重置访问令牌：用于公网保护数据接口 */
router.post('/reset-token', (_req, res) => {
  const token = regenerateAccessToken();
  res.json({ ok: true, accessToken: token, message: '访问令牌已更新，旧的令牌将立即失效' });
});

router.post('/config', (req, res) => {
  const body = (req.body ?? {}) as Partial<TunnelConfig>;
  if (body.provider && body.provider !== 'cloudflare' && body.provider !== 'cpolar' && body.provider !== 'tailscale') {
    res.status(400).json({ detail: `不支持的 provider: ${body.provider}` });
    return;
  }
  try {
    saveTunnelConfig(body);
    res.json({ ok: true, message: '配置已保存，下次启动隧道时生效' });
  } catch (err) {
    res.status(500).json({ detail: `配置保存失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ---------- Cloudflare Named Tunnel 向导 ----------

router.post('/cloudflare/login', async (_req, res) => {
  const config = loadTunnelConfig();
  const svc = getLoginService();
  try {
    const result = await svc.startLogin(config.binaryPath);
    if (result.status === 'failed') loginService = null;
    res.json(result);
  } catch (err) {
    loginService = null;
    res.status(500).json({ detail: `login 启动失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.get('/cloudflare/login/status', async (_req, res) => {
  const svc = getLoginService();
  const result = svc.checkLoginStatus();
  if (result.status === 'success' && result.certFile) {
    saveTunnelField('certFile', result.certFile);
    loginService = null;
  } else if (result.status === 'failed') {
    loginService = null;
  }
  res.json(result);
});

router.post('/cloudflare/create', async (req, res) => {
  const body = (req.body ?? {}) as { tunnelName?: string; certFile?: string };
  if (!body.tunnelName?.trim()) {
    res.status(400).json({ detail: '请输入隧道名称' });
    return;
  }
  const config = loadTunnelConfig();
  const certFile = body.certFile || config.certFile;
  if (!certFile) {
    res.status(400).json({ detail: '请先执行 login 步骤获取 cert.pem' });
    return;
  }
  try {
    const result = await getLoginService().createTunnel(body.tunnelName.trim(), certFile, config.binaryPath);
    saveTunnelField('tunnelId', result.tunnelId);
    saveTunnelField('credentialsFile', result.credentialsFile);
    saveTunnelField('tunnelName', result.tunnelName);
    res.json({ ok: true, ...result, message: '隧道创建成功，可以继续配置 DNS 路由' });
  } catch (err) {
    res.status(500).json({ detail: `创建隧道失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.post('/cloudflare/route-dns', async (req, res) => {
  const body = (req.body ?? {}) as { hostname?: string; certFile?: string };
  if (!body.hostname?.trim()) {
    res.status(400).json({ detail: '请输入固定域名' });
    return;
  }
  const config = loadTunnelConfig();
  const certFile = body.certFile || config.certFile;
  if (!certFile) {
    res.status(400).json({ detail: '请先执行 login 步骤获取 cert.pem' });
    return;
  }
  const tunnelNameOrId = config.tunnelName || config.tunnelId;
  if (!tunnelNameOrId) {
    res.status(400).json({ detail: '请先执行创建隧道步骤' });
    return;
  }
  try {
    const publicUrl = await getLoginService().routeDns(tunnelNameOrId, body.hostname.trim(), certFile, config.binaryPath);
    saveTunnelField('hostname', body.hostname.trim());
    saveTunnelField('tunnelMode', 'named');
    res.json({ ok: true, publicUrl, message: 'DNS 路由配置成功，已自动切换到固定域名模式' });
  } catch (err) {
    res.status(500).json({ detail: `DNS 路由配置失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});

/** authtoken 脱敏：长度 > 4 显示末 4 位，<=4 全遮罩 */
function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 4) return '?'.repeat(token.length);
  return token.slice(-4).padStart(token.length, '?');
}

// 保持既有导出面不变：TunnelProvider 仅供本路由的消费者透传使用
export { TunnelProvider } from '../tunnel/tunnel-config';
export default router;