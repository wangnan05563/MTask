/**
 * CSRF 防护中间件（M8 / 8.2）
 *
 * 设计依据：docs/安全-CSRF防护方案.md
 *
 * 核心事实：MTask 的鉴权是**自定义头 X-Access-Token**而非 Cookie。
 * 浏览器跨站请求无法自动附加自定义头，因此「强制自定义头」等价于事实上的 CSRF 防护。
 * 真正的跨站面只在：①隧道场景的浏览器会话 ②简单请求（表单类）。故本中间件做三件事：
 *   1) 状态变更方法（POST/PUT/PATCH/DELETE）强制要求自定义头；
 *   2) Origin 白名单辅助校验（覆盖隧道/公网域名场景）；
 *   3) strict 模式追加双提交 Cookie 校验（用于未来若引入 Cookie 会话）。
 *
 * 开关：MTASK_CSRF_MODE=off|header|strict（默认 header）；off 为紧急止血开关。
 * 白名单扩展：MTASK_CSRF_ALLOWED_ORIGINS=https://a.example,https://b.example
 */
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { loadTunnelConfig } from '../tunnel/tunnel-config';

export type CsrfMode = 'off' | 'header' | 'strict';

/** 只读方法：无副作用，不构成 CSRF 面（本项目 GET 语义均为读） */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfMode(): CsrfMode {
  const m = String(process.env.MTASK_CSRF_MODE ?? 'header').toLowerCase();
  if (m === 'off') return 'off';
  if (m === 'strict') return 'strict';
  return 'header';
}

function envAllowed(): string[] {
  return String(process.env.MTASK_CSRF_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 隧道域名：读 tunnel-config.json 的 hostname（缓存在内存，避免每请求读盘） */
let tunnelHostCache: { host: string; at: number } | null = null;
function tunnelHost(): string {
  const now = Date.now();
  if (tunnelHostCache && now - tunnelHostCache.at < 60_000) return tunnelHostCache.host;
  let host = '';
  try {
    const dir = process.env.MTask_DATA_DIR || path.join(process.cwd(), 'data');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel', 'tunnel-config.json'), 'utf-8'));
    if (typeof cfg?.hostname === 'string' && cfg.hostname.trim()) host = cfg.hostname.trim().toLowerCase();
  } catch {
    /* 隧道未配置/未启用：忽略 */
  }
  tunnelHostCache = { host, at: now };
  return host;
}

export function isAllowedOrigin(origin: string): boolean {
  const o = origin.toLowerCase();
  // 本机回环（任意端口）
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o)) return true;
  // Electron 自定义协议与本地文件（桌面 UI 由 app://ui 加载）
  if (o.startsWith('app://') || o.startsWith('api://') || o.startsWith('file://')) return true;
  // 隧道域名（自动）
  const th = tunnelHost();
  if (th && (o === `https://${th}` || o === `http://${th}`)) return true;
  // 显式白名单
  return envAllowed().some((e) => o === e);
}

/** 手动解析 Cookie（项目未引入 cookie-parser，避免为 strict 模式加依赖） */
function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const mode = csrfMode();
  if (mode === 'off') return next();
  if (SAFE_METHODS.has(req.method)) return next();

  // 豁免：健康检查探针（只读无副作用）
  const p = (req.originalUrl || req.url).split('?')[0];
  if (p === '/api/health') return next();

  // 主线：状态变更必须带自定义头（跨站无法自动附加）。
  // ⚠ 与 accessTokenGuard 同源判据：仅在**已配置令牌**时强制——纯本地单机未配令牌时客户端
  // 根本不会发该头（accessTokenGuard 亦整体放行），此处若无条件强制会把桌面 UI 的写操作全拦死。
  const token = loadTunnelConfig().accessToken;
  if (token && !req.get('x-access-token')) {
    res.status(403).json({ error: 'CSRF：状态变更请求缺少 X-Access-Token 自定义头', code: 'CSRF_NO_TOKEN' });
    return;
  }

  // 辅助：Origin 白名单——**仅当请求携带 Cookie 时才校验**。
  // CSRF 的本质是「环境凭据（Cookie）被浏览器自动携带」；本项目令牌走自定义头，
  // 零 Cookie 请求没有任何可被伪造的凭据，跳过 Origin 检查既不损失防护，也
  // 兜底各种协议序列化差异（如自定义 scheme 下 Origin 可能为 "null"）。
  const hasCookies = Boolean(req.get('cookie'));
  const origin = req.get('origin');
  if (origin && hasCookies && !isAllowedOrigin(origin)) {
    console.warn(`[csrf] 拒绝跨站请求 origin=${origin} ${req.method} ${p}`);
    res.status(403).json({ error: `CSRF：Origin 不在白名单（${origin}）`, code: 'CSRF_BAD_ORIGIN' });
    return;
  }

  // strict：双提交 Cookie（未来若引入 Cookie 会话时启用）
  if (mode === 'strict') {
    const ck = cookieValue(req, 'mtask_csrf');
    const hd = req.get('x-csrf-token');
    if (!ck || !hd || ck !== hd) {
      res.status(403).json({ error: 'CSRF：双提交校验失败', code: 'CSRF_DOUBLE_SUBMIT' });
      return;
    }
  }
  return next();
}

export default csrfGuard;
