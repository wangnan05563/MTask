/**
 * T02149 门：内网穿透 Tailscale 启动 HTTP 500 修复。
 *
 * 根因（本机实复现）：Tailscale 客户端未登录（BackendState=NoState）时 start() 抛裸
 * Error，路由一律映射 500——用户可修复的前置状态被报成「服务器错误」，前端也拿不到
 * 分类指引。修复：TailscaleNotReadyError（带 reason）→ 路由 400 + errorType，
 * 前端按 reason 渲染操作指引；funnel 非零退出补最近输出；status JSON 解析失败归
 * status_unavailable 不抛 SyntaxError。
 *
 * 断言组：
 *   S 组 源码守卫：错误类/纯函数/路由映射/前端 reason 指引四处在位。
 *   U 组 分类纯函数四态单测 + 路由级 API 实测（隔离 DATA_DIR + 假二进制路径，
 *        确定性触发 not_installed → 400 + errorType + reason，不依赖机器 Tailscale 状态）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02149-tailscale-start.mts
 * 结果落 .workbuddy/t02149-gate-results-<运行标识>.txt。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ---------- S 组：源码守卫 ----------
const SVC = strip(readFileSync(join(ROOT, 'server', 'src', 'tunnel', 'tunnel-service.ts'), 'utf8'));
const ROUTE = strip(readFileSync(join(ROOT, 'server', 'src', 'routes', 'tunnel.ts'), 'utf8'));
const PANEL = readFileSync(join(ROOT, 'web', 'src', 'pages', 'TunnelPanel.tsx'), 'utf8');

ok('S-01 TailscaleNotReadyError 带 reason 出厂（四态枚举）',
  /export type TailscaleNotReadyReason = 'not_installed' \| 'not_logged_in' \| 'magicdns_off' \| 'status_unavailable'/.test(SVC)
  && /export class TailscaleNotReadyError extends Error \{[\s\S]*?readonly reason: TailscaleNotReadyReason/.test(SVC));
ok('S-02 就绪判定抽成纯函数 classifyTailscaleStatus（start() 与门禁单测共用同一 seam）',
  /export function classifyTailscaleStatus\(raw: string\)/.test(SVC) && /const verdict = classifyTailscaleStatus\(statusResult\);/.test(SVC));
ok('S-03 start() 的三个不合格态全部改抛 TailscaleNotReadyError（不再抛裸 Error）',
  /throw new TailscaleNotReadyError\('not_installed'/.test(SVC)
  && (SVC.match(/throw new TailscaleNotReadyError/g) ?? []).length >= 3
  && !/throw new Error\('请先打开并登录 Tailscale/.test(SVC));
ok('S-04 status CLI 失败与 JSON 解析失败都归 status_unavailable（不把 SyntaxError 抛给用户）',
  /reason: 'status_unavailable'/.test(SVC) && /无法读取 Tailscale 状态：\$\{err instanceof Error/.test(SVC));
ok('S-05 路由把 TailscaleNotReadyError 映射 400 + errorType + reason（用户可修复状态不再是 500）',
  /if \(err instanceof TailscaleNotReadyError\) \{[\s\S]*?res\.status\(400\)\.json\(\{[\s\S]*?errorType: 'tailscale_not_ready',[\s\S]*?reason: err\.reason,/.test(ROUTE));
ok('S-06 funnel 非零退出带最近输出（code=1 无输出用户无从判断）',
  /Tailscale Funnel 进程退出，code=\$\{code\}\$\{recentOutput\}/.test(SVC));
ok('S-07 前端按 reason 渲染操作指引（not_installed/not_logged_in/magicdns_off/status_unavailable 四支）',
  /errorType === 'tailscale_not_ready'/.test(PANEL)
  && /reason === 'not_installed'/.test(PANEL) && /reason === 'not_logged_in'/.test(PANEL)
  && /reason === 'magicdns_off'/.test(PANEL) && /reason\?: string/.test(PANEL));

// ---------- U 组：分类纯函数四态单测 ----------
const { classifyTailscaleStatus, TailscaleNotReadyError } = await import('../server/src/tunnel/tunnel-service.ts');

const v1 = classifyTailscaleStatus(JSON.stringify({ BackendState: 'NoState', Self: { DNSName: 'x.ts.net.' } }));
ok('U-01 NoState（未登录）→ not_logged_in', !v1.ok && v1.reason === 'not_logged_in', v1);
const v2 = classifyTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: '' } }));
ok('U-02 Running 但无 DNSName → magicdns_off', !v2.ok && v2.reason === 'magicdns_off', v2);
const v3 = classifyTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.tail1234.ts.net.' } }));
ok('U-03 Running + ts.net → ok 且域名去尾点', v3.ok && v3.dnsName === 'host.tail1234.ts.net', v3);
const v4 = classifyTailscaleStatus('Logged out.');
ok('U-04 非 JSON 输出 → status_unavailable（不抛 SyntaxError）', !v4.ok && v4.reason === 'status_unavailable', v4);
const v5 = classifyTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 42 } }));
ok('U-05 DNSName 非字符串 → magicdns_off（typeof 收窄不 String() 化）', !v5.ok && v5.reason === 'magicdns_off', v5);
const e1 = new TailscaleNotReadyError('not_installed', 'x');
ok('U-06 错误类形状：name/reason/message 齐备', e1.name === 'TailscaleNotReadyError' && e1.reason === 'not_installed' && e1.message === 'x' && e1 instanceof Error);

// ---------- U 组：路由级 API 实测（隔离 DATA_DIR + 假二进制路径，确定性触发） ----------
process.env.MTask_DATA_DIR = mkdtempSync(join(tmpdir(), 't02149-gate-'));
try {
  const express = (await import('express')).default;
  const tunnelRouter = (await import('../server/src/routes/tunnel.ts')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/tunnel', tunnelRouter);
  const server = await new Promise<any>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/tunnel`;
  const post = async (p: string, body?: unknown) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  // 假二进制路径：ensureBinary 必然抛 not_installed——不依赖机器 Tailscale 装机/登录状态，无副作用
  const save = await post('/config', { provider: 'tailscale', binaryPath: 'C:\\t02149-gate\\not-exists\\tailscale.exe', pathPrefix: '' });
  ok('U-07 配置保存 200（provider=tailscale 持久化）', save.status === 200, save);
  const token = await post('/reset-token');
  ok('U-08 访问令牌生成 200（绕过 T01341 的令牌闸，直达启动逻辑）', token.status === 200, token);

  const start = await post('/start');
  ok('U-09 未安装 Tailscale → 400 + errorType=tailscale_not_ready + reason=not_installed（不再是 500）',
    start.status === 400 && start.body?.errorType === 'tailscale_not_ready' && start.body?.reason === 'not_installed' && /未检测到|路径不存在/.test(start.body?.detail ?? ''),
    start);
  const st = await (await fetch(base + '/status')).json().catch(() => null) as any;
  ok('U-10 启动失败后状态保持 stopped（不半启动）', st?.status === 'stopped', st);

  await new Promise<void>((r) => server.close(() => r()));
} finally {
  rmSync(process.env.MTask_DATA_DIR as string, { recursive: true, force: true });
}

mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02149-gate-results.txt', `T02149 Tailscale 启动 500 修复门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
