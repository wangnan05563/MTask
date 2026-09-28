/**
 * 本机直连判定：区分「本机访问」与「经隧道代理转发的公网访问」。
 *
 * 为什么不能只看 remoteAddress：内网穿透由本机的 cloudflared/cpolar/tailscale 进程转发，
 * 公网请求到达后端时来源地址同样是 127.0.0.1，无法据此区分。
 *
 * 因此改用两个代理必然留下的痕迹取「或」（任一命中即判为非本机）：
 * 1) 代理注入的转发头——cloudflared 等会追加 X-Forwarded-For / X-Forwarded-Proto / CF-Connecting-IP，
 *    这些头由代理写入，外部请求无法移除，故「有 = 经过代理」是可靠方向；
 * 2) Host 非回环——本机直连的 Host 恒为 127.0.0.1 / localhost / [::1]，
 *    隧道转发虽可能改写 Host，但与条件 1 互为兜底。
 *
 * 反方向（把本机误判为公网）只会退化为「需手动输入令牌」，代价可控；
 * 正方向误判（把公网当本机）才是安全问题，故判据取保守侧。
 */
import type { Request } from 'express';

/** 代理注入的转发头：任一存在即说明请求经隧道/反代转发而来 */
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'cf-connecting-ip', 'x-real-ip'];

/** 回环主机名（已剥离端口与 IPv6 方括号） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLocalRequest(req: Request): boolean {
  for (const h of FORWARD_HEADERS) {
    if (req.headers[h]) return false;
  }
  // IPv6 的 Host 形如 [::1]:39876，去括号后才能与回环集合比对
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host);
}