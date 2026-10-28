import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { initSchema } from './db/schema';
import { api } from './routes';
import tunnelRouter, { tryAutoStartTunnel } from './routes/tunnel'; // T03312：autoStart 的消费方（此前只有存与显示）
import { mcpRouter } from './mcp/http';
import { csrfGuard } from './services/CsrfGuard';
import { logService } from './services/LogService';
import { QueueService } from './services/QueueService';
import { AIService } from './services/AIService';
import { loadTunnelConfig, normalizePathPrefix } from './tunnel/tunnel-config';
import { changeBus } from './services/ChangeBus';
import { startDailyBackupTimer } from './services/BackupService'; // T01061-FR5.1：每日自动备份
import { RecurringService, TokenService } from './services/RecurringService'; // T01073：循环任务 + API Token
import { SupervisorService } from './services/SupervisorService'; // T01273：监督器 tick（含 T01270 会话停滞兜底）
import { reconcileLinkedPlanStatuses } from './services/PlanService';
import { reconcileReqStatuses } from './services/reqStatusSync'; // T02087：需求状态启动对账
import { reconcileDerivedFrom } from './services/derivedOrigin'; // T02320：派生单溯源（正文首行「来源：Txxxx」）启动回填
import { reconcileMilestoneProgresses } from './services/milestoneProgress'; // T02090：里程碑进度启动对账
import { TaskService, startStaleRunningGuard } from './services/TaskService'; // T01368 后续（P1）：running 超时兜底定时收敛（移出读路径）
import { IterationService } from './services/IterationService'; // T03227（PM-201⑥）：迭代周报卡跨结束日补生成
import { startEventRetentionTimer } from './services/EventRetention'; // T01064 后续：事件表 90 天保留期清理
import { startReportTmpSweeper } from './services/ReportService'; // T02144：导出令牌临时文件回收
import { MetricSnapshotService } from './services/MetricSnapshotService'; // T03237：PM-205 日快照（长历史唯一来源）
import { WebhookService } from './services/WebhookService'; // T03196：PM-401 Webhook 投递/重试定时器

const PORT = Number(process.env.MTask_PORT ?? 39876);
const HOST = '127.0.0.1';

const app = express();
app.disable('x-powered-by'); // S5689：funnel/cloudflared 隧道开启时不把框架信息带出公网
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

// 访问令牌中间件：一旦配置了 accessToken，所有 /api 数据接口都必须携带匹配的 X-Access-Token，
// 防止公网穿透后未授权读写数据。未配置令牌（纯本地单机）时整体放行，保持既有行为零回归。
function accessTokenGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // 隧道管理端点不在此校验令牌，改由 tunnel 路由内的「仅本机可管理」闸门负责
  // （公网只读 status/config）。原因：本机是令牌的唯一合法初始化入口，若这里按令牌拦截，
  // 会出现「已配置令牌但本机尚未持有令牌 → 读不到也重置不了」的死锁。
  // 用 originalUrl 判断：guard 同时被 /api 与 /api/tunnel 两处挂载，req.path 语义随挂载点变化。
  if (req.originalUrl.split('?')[0].startsWith('/api/tunnel/')) {
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
  // 前端以 ?token= 携带访问令牌（与 X-Access-Token 同值），仅此路径接受 query 形式。
  // T01340：判据必须用 originalUrl（含挂载前缀）而非 req.path——SSE 端点注册在 app 层，
  // 其 req.path 是 /api/events，用 startsWith('/events') 恒不成立，配令牌后 SSE 会被 401 拒掉。
  // originalUrl 在「app 层注册」与「router 挂载」两种写法下都是完整路径，故用精确等值最稳。
  if (req.originalUrl.split('?')[0] === '/api/events' && token && req.query.token === token) {
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
    const scope = provided ? TokenService.verify(provided) : null;
    if (!scope) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // T01073 后续：只读凭据拦截写操作。判据是方法而非路径——全站写操作一律走 POST/PATCH/PUT/DELETE，
    // 按路径维护白名单既冗长又会随新端点上线而漏配。MCP 走 POST，故只读凭据天然用不了 MCP（其工具含写能力）。
    if (scope === 'read' && req.method !== 'GET') {
      res.status(403).json({ error: '该凭据为只读（scope=read），不允许写操作' });
      return;
    }
  }
  next();
}

// T01389：Tailscale 路径前缀模式（funnel --set-path /xxx）会把 /xxx 原样转发到本地，
// 而本地按根路径路由（/api、静态资源）——菜单点击的 /api/* 在隧道边缘直接 404。
// 此处按隧道配置的 pathPrefix 把 /xxx/... 剥前缀后交给后续路由：
//   https://host/xxx/api/tasks → /api/tasks、/xxx/assets/* → /assets/*、/xxx/ → index.html
// pathPrefix 运行时可改（loadTunnelConfig 内存缓存），故每请求读取而非启动时固化。
app.use((req, _res, next) => {
  const prefix = normalizePathPrefix(loadTunnelConfig().pathPrefix);
  if (prefix && (req.url === prefix.slice(0, -1) || req.url.startsWith(prefix))) {
    req.url = '/' + req.url.slice(prefix.length);
    // T01420：同步 originalUrl——/api/events、/images/ 的 query-token 特例按 originalUrl 匹配，
    // 不改写会在子路径模式下 401（SSE 订阅与图片直链失效）
    req.originalUrl = req.url;
  }
  next();
});

// M8/8.2：CSRF 防护（自定义头强制 + Origin 白名单；MTASK_CSRF_MODE=off 可紧急止血）
app.use('/api', accessTokenGuard, csrfGuard, api);
// MCP streamable HTTP 端点：与 REST 一致受 accessTokenGuard（X-Access-Token）保护。
// 不叠加 csrfGuard——MCP 是机器对机器调用（自带令牌鉴权），不属于浏览器跨站面。
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
// T02967 回补（原 T02289 能力被 5eee8de 的过期副本覆盖掉）：MTASK_STATIC_DIR 与 MTask_DATA_DIR 同族，
// 是验收门的隔离通道——门要把缺陷版 sw.js 放进临时目录再由真实实例伺服，
// 缺少这条覆盖时实例永远伺服主仓 web/dist，两阶段对照没有判别力。
const webDist = process.env.MTASK_STATIC_DIR
  ? path.resolve(process.env.MTASK_STATIC_DIR)
  : path.resolve(__dirname, '..', '..', 'web', 'dist');
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
// T02087：需求状态对账——同一兜底家族的需求侧成员：关联计划/待办全部 done 的需求归位
// （旧版本从未派生过的存量 + 直写库绕过钩子的变更，都在这里对齐；changed 与无关联行不动）
try {
  const reqFixed = reconcileReqStatuses();
  if (reqFixed > 0) console.log(`[mtask] req-status reconcile: ${reqFixed} requirement(s) re-derived`);
} catch (e) {
  console.error('[mtask] req-status reconcile failed:', e);
}
// T02090：里程碑进度对账——兜底家族第三名成员：带子项（deps child）的里程碑按子项 done 数
// 收敛 progress/status（T02042 实测「子项全 done 里程碑仍 0%」的存量 + 直写库绕过聚合的变更）。
//  必须排在 plan-task reconcile **之后**：那一步按「关联待办 done → 计划 done」单向对齐，
//  已按 milestoneHasChildren 排除聚合作主的里程碑；这里再按子项实况做权威聚合。
try {
  const msFixed = reconcileMilestoneProgresses();
  if (msFixed > 0) console.log(`[mtask] milestone-progress reconcile: ${msFixed} milestone(s) re-aggregated`);
} catch (e) {
  console.error('[mtask] milestone-progress reconcile failed:', e);
}
// T02320：派生单溯源对账——兜底家族第四名成员。历史建单把派生关系只写进正文首行「来源：Txxxx」
// 而 derived_from 为空 ⇒ 结论从未被自动归并回母单（实测 4 张完成单即此形态）；这里按同一判据回填，
// 母单编号查无的行只计数不猜。
try {
  const rec = reconcileDerivedFrom();
  if (rec.backfilled > 0 || rec.missingOrigin > 0) {
    console.log(`[mtask] derived-from reconcile: ${rec.backfilled} task(s) backfilled, ${rec.missingOrigin} 来源编号查无母单（不回填）, scanned ${rec.scanned}`);
  }
} catch (e) {
  console.error('[mtask] derived-from reconcile failed:', e);
}
app.listen(PORT, HOST, () => {
  console.log(`[mtask] server ready at http://${HOST}:${PORT}`);
  console.log(`[mtask] health: http://${HOST}:${PORT}/api/health`);
  // T01061-FR5.1：每日自动备份（当天首启即备 + 每小时检查日期翻转）
  startDailyBackupTimer();
  // T01073-FR5.5：循环任务到期生成（启动即跑一轮 + 每小时检查）
  try { RecurringService.tick(); } catch (e) { console.error('[recurring] 启动 tick 失败:', e); }
  setInterval(() => { try { RecurringService.tick(); } catch { /* 单轮失败不中断定时 */ } }, 3600000);
  // T03227（PM-201⑥）：迭代结束日在本次运行之前被跨过、且还没有周报卡的迭代，启动时各补一张。
  //  判据自带幂等（候选=「无 weekly_card 事件」），故只在此跑一轮、不挂小时定时器：
  //  挂着跑会让「今天才结束」的迭代提前拿到卡，与本条要求的「关闭期间跨过」不是同一件事。
  try {
    const bf = IterationService.backfillWeeklyCards();
    if (bf.generated.length > 0) console.log(`[iterations] 周报卡补生成 ${bf.generated.length} 张（扫描 ${bf.scanned} 个无卡迭代）`);
  } catch (e) { console.error('[iterations] 周报卡补生成失败:', e); }
  // T01273-FR2.1：监督器 tick（启动即跑一轮 + 按 supervisor.intervalMs 周期，默认 30s）。
  // T01270 的会话停滞兜底已并入该 tick（观测层不受熔断开关影响），故移除其独立定时器；
  // 决策层受 supervisor.enabled 熔断开关控制（默认关闭），无监督对象时空转返回（NFR-1）。
  // T01311：定时器收拢进 SupervisorService.startScheduler——持有句柄才能支持 intervalMs 热重载。
  SupervisorService.startScheduler();
  // T01368 后续（P1）：running 超时兜底改为定时收敛，移出列表/详情读路径（去掉只读接口的写锁竞争）
  startStaleRunningGuard(60000);
  // T02949 方案 A：历史派生单补标一轮——旧版本只能手动点「+ 待裁决」，已回传且结论明确请求裁决的单
  // 仍是空态；启动时按严格规则补，命中才写（不重判已收口单，详见 TaskService.backfillRuling）。
  try {
    const marked = TaskService.backfillRuling();
    if (marked) console.log(`[ruling] 历史派生单补标 ${marked} 条为待裁决`);
  } catch (e) { console.error('[ruling] 历史补标失败:', e); }
  // T01064 后续：task_events 保留期清理（默认 90 天，events.retentionDays 可配，0 = 不清理）
  startEventRetentionTimer();
  // T02144：导出令牌临时文件回收（启动清一轮 + 每小时兜底）——未下载即放弃的 PPTX/XLSX 不再永久残留
  startReportTmpSweeper();
  // T03237（PM-205）：日快照启动即采一轮，之后每 30 分钟刷新当天读数（过去日期冻结、不回填）
  MetricSnapshotService.startSnapshotTimer();
  // T03196（PM-401）：Webhook 待重试投递续跑 + 每日逾期事件扫描（重启后 pending 记录可继续重试）
  WebhookService.startDeliveryTimer();
  // T03312：勾选「后端启动时自动开启隧道」时按 POST /start 同一套门禁自动拉起。
  // 不阻塞就绪、不抛错；结果既写日志，也经 /api/tunnel/status 的 autoStartResult 回显到面板。
  void tryAutoStartTunnel().then(
    (r) => console.log(`[mtask] tunnel auto-start: ${r.started ? r.reason : `skipped (${r.reason})`}`),
    (e) => console.error('[mtask] tunnel auto-start failed:', e),
  );
});

// 异步队列轮询器：周期性地将已受理（sending+有 ticket）的 Job 收口。
// .catch 兜底避免单次轮询异常中断定时器；scheme 常驻，服务随 Electron 进程存活。
const QUEUE_POLL_INTERVAL_MS = 5000;
setInterval(() => {
  QueueService.pollPending(AIService.buildPoller()).catch((e) =>
    console.error('[mtask] queue poller error:', e),
  );
}, QUEUE_POLL_INTERVAL_MS);
