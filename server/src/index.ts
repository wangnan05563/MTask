import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { initSchema } from './db/schema';
import { api } from './routes';
import tunnelRouter from './routes/tunnel';
import { mcpRouter } from './mcp/http';
import { logService } from './services/LogService';
import { QueueService } from './services/QueueService';
import { AIService } from './services/AIService';
import { loadTunnelConfig } from './tunnel/tunnel-config';
import { changeBus } from './services/ChangeBus';
import { startDailyBackupTimer } from './services/BackupService'; // T01061-FR5.1：每日自动备份
import { RecurringService, TokenService } from './services/RecurringService'; // T01073：循环任务 + API Token
import { reconcileLinkedPlanStatuses } from './services/PlanService';

const PORT = Number(process.env.MTask_PORT ?? 39876);
const HOST = '127.0.0.1';

const app = express();
// 尽早拦截 console，使 server ready / 请求日志等后续输出都能进入日志缓冲
logService.init();
// 上限覆盖截图粘贴：单图解码后 ≤ 8MB（TaskImageService 内校验），base64 膨胀约 4/3
app.use(express.json({ limit: '30mb' }));

// CORS：Electron 壳中 file:// 页面 fetch http://127.0.0.1:PORT 需要跨源许可（本地服务，放行即可）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Access-Token,mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 慢请求日志：仅记录耗时 ≥100ms 的请求（含状态码与耗时）。
// 原"非 GET 全打日志"在高写压力下产生大量日志 IO，改阈值过滤后既保留慢端点诊断价值，又显著降 IO。
// 不打印密钥类字段（路由层已保证不返回明文密钥）。
const SLOW_LOG_MS = 100;
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= SLOW_LOG_MS) {
      console.log(`[mtask] ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`);
    }
  });
  next();
});

// 访问令牌中间件：一旦配置了 accessToken，除 /tunnel/*（隧道的启停/配置自身）外，
// 所有 /api 数据接口都必须携带匹配的 X-Access-Token，防止公网穿透后未授权读写数据。
// 未配置令牌（纯本地单机）时整体放行，保持既有行为零回归。
function accessTokenGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // 隧道管理端点自身放行：若被 401 拦截，用户将无法在公网输入令牌完成解锁
  if (req.path.startsWith('/tunnel')) {
    next();
    return;
  }
  // 健康检查放行：仅返回存活状态，无敏感数据。Electron 主进程/运维探针探测后端存活
  // 时不携带 X-Access-Token（否则 401 被误判为"后端未就绪"，触发杀子进程+换端口循环，
  // 表现即"后端未连接"）。真实数据接口不受影响。
  if (req.path === '/health') {
    next();
    return;
  }
  const token = loadTunnelConfig().accessToken;
  // T00444：SSE 变更通知端点支持 query token——EventSource 无法自定义请求头，
  // 前端以 ?token= 携带访问令牌（与 X-Access-Token 同值），仅此路径接受 query 形式
  if (req.path.startsWith('/events') && token && req.query.token === token) {
    next();
    return;
  }
  // T00580：图片直链支持 query token——<img src> 无法自定义请求头，前端以 ?token= 携带
  // （与 X-Access-Token 同值）；图片 id 为 uuid 不可枚举，仅此路径接受 query 形式
  if (req.path.startsWith('/images/') && token && req.query.token === token) {
    next();
    return;
  }
  if (token && req.headers['x-access-token'] !== token) {
    // T01073-FR5.6：API Token 具名凭据——主令牌不匹配时尝试 api_tokens 表（启用中的凭据通过并刷新 last_used_at）
    const provided = String(req.headers['x-access-token'] ?? '');
    if (!provided || !TokenService.verify(provided)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }
  next();
}

app.use('/api', accessTokenGuard, api);
// MCP streamable HTTP 端点：与 REST 一致受 accessTokenGuard（X-Access-Token）保护
app.use('/api/mcp', accessTokenGuard, mcpRouter());

// T00444：SSE 数据变更通知端点——前端 EventSource 订阅后，任务/计划/队列的外部变更
//（MCP 回传、队列自动回写、其他窗口操作）即时推送，替代纯轮询的延迟
app.get('/api/events', accessTokenGuard, (req: express.Request, res: express.Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ kind: 'hello' })}\n\n`);
  const onChange = (kind: string) => {
    try { res.write(`data: ${JSON.stringify({ kind })}\n\n`); } catch { /* 客户端已断开 */ }
  };
  changeBus.on('change', onChange);
  // 心跳：防止代理/系统空闲超时断开 SSE 连接
  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n'); } catch { /* ignore */ }
  }, 25000);
  req.on('close', () => {
    changeBus.off('change', onChange);
    clearInterval(heartbeat);
  });
});
// 内网穿透路由：暴露后端 HTTP 服务到公网（对应 /api/tunnel/*）
app.use('/api/tunnel', tunnelRouter);

// 静态伺服前端构建产物：让隧道 URL / 浏览器访问时能打开可操作的 Web 界面。
// dev 态 __dirname=server/src，打包态=resources/app/server/dist，均回溯到根/web/dist
const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist));
  // SPA 兜底：非 /api、未命中静态文件的 GET 一律回显 index.html
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  console.log(`[mtask] web 静态已伺服: ${webDist}`);
} else {
  console.log(`[mtask] 未找到 web/dist，跳过 Web 界面伺服（仅 API）`);
}

// 统一错误兜底
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // T00711（D-3 修复）：请求体超限（如 PRD 上传 > 30mb）映射 413 + 可操作中文提示，不再冒 500
  const payloadErr = err as Error & { type?: string; status?: number; statusCode?: number };
  if (payloadErr?.type === 'entity.too.large' || payloadErr?.status === 413 || payloadErr?.statusCode === 413) {
    return res.status(413).json({ error: '文件超过 30MB 上限，请拆分或压缩后再上传' });
  }
  console.error('[mtask] unhandled error:', err);
  res.status(500).json({ error: err.message ?? 'internal error' });
});

initSchema();
// T00470：启动对账——直写库场景（AI 脚本回写）绕过同步钩子时，兜底对齐待办→计划状态
try {
  const fixed = reconcileLinkedPlanStatuses();
  if (fixed > 0) console.log(`[mtask] plan-task reconcile: ${fixed} plan record(s) aligned to done`);
} catch (e) {
  console.error('[mtask] plan-task reconcile failed:', e);
}
app.listen(PORT, HOST, () => {
  console.log(`[mtask] server ready at http://${HOST}:${PORT}`);
  console.log(`[mtask] health: http://${HOST}:${PORT}/api/health`);
  // T01061-FR5.1：每日自动备份（当天首启即备 + 每小时检查日期翻转）
  startDailyBackupTimer();
  // T01073-FR5.5：循环任务到期生成（启动即跑一轮 + 每小时检查）
  try { RecurringService.tick(); } catch (e) { console.error('[recurring] 启动 tick 失败:', e); }
  setInterval(() => { try { RecurringService.tick(); } catch { /* 单轮失败不中断定时 */ } }, 3600000);
});

// 异步队列轮询器：周期性地将已受理（sending+有 ticket）的 Job 收口。
// .catch 兜底避免单次轮询异常中断定时器；scheme 常驻，服务随 Electron 进程存活。
const QUEUE_POLL_INTERVAL_MS = 5000;
setInterval(() => {
  QueueService.pollPending(AIService.buildPoller()).catch((e) =>
    console.error('[mtask] queue poller error:', e),
  );
}, QUEUE_POLL_INTERVAL_MS);
