/**
 * T02293 批㉘ 的归因夹具：t02144 门里 A2-01 慢开机轮连红两次（`e.cause=ECONNRESET`），推测是
 * 「undici 复用服务端 keepAliveTimeout 之后悄悄关掉的连接」。本夹具把该推测单独摆出来验证——
 * 实测**未复现**（空闲超 timeout 时 undici 对 FIN 优雅重连；卡关闭边界 12 次亦 0 炸），
 * 所以 `Connection: close` 在 t02144 里的定位是「消除整族复用时序红的手段」，不是「已证明的根因修复」。
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/probe-keepalive-idle-race.mts
 */
import http from 'node:http';
import assert from 'node:assert';

const srv = http.createServer((_req, res) => res.end('ok'));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(srv.address() as any).port}`;
console.log(`服务端 keepAliveTimeout=${srv.keepAliveTimeout}ms（Node 默认）`);

async function post(headers: Record<string, string>) {
  const res = await fetch(`${BASE}/`, { method: 'POST', headers, body: 'x' });
  return res.status;
}
async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

/**
 * 腿 1：默认复用。两种窗口都试——
 * (a) 远超 keepAliveTimeout 的空闲（服务端已收到 FIN、undici 会优雅新建，预期不炸）；
 * (b) 卡在服务端关闭那一瞬的竞态窗口（客户端刚把请求写进那条正在被 FIN/RST 的连接，预期 ECONNRESET）。
 */
let staleIdleFailure = '';
try {
  await post({ 'content-type': 'text/plain' });
  await sleep(srv.keepAliveTimeout + 3000);
  await post({ 'content-type': 'text/plain' });
} catch (e: any) {
  staleIdleFailure = `${String(e)}｜cause=${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`;
}
console.log(`[腿1a 空闲>timeout] ${staleIdleFailure || '未炸（undici 对 FIN 优雅重连）'}`);

const raceAttempts: string[] = [];
srv.keepAliveTimeout = 1200;
for (let i = 0; i < 12; i++) {
  try {
    await post({ 'content-type': 'text/plain' });
    await sleep(1200); // 正好落在服务端超时关闭的边界
    await post({ 'content-type': 'text/plain' });
    raceAttempts.push('.');
  } catch (e: any) {
    raceAttempts.push(`X${e?.cause?.code ?? String(e).slice(0, 12)}`);
  }
}
console.log(`[腿1b 卡关闭边界 12 次] ${raceAttempts.join('')}  命中 ECONNRESET=${raceAttempts.some((s) => /ECONNRESET/.test(s))}`);
const raceHit = raceAttempts.some((s) => /ECONNRESET/.test(s));


// 腿 2：Connection: close —— 同两种窗口各跑一遍，不该出现任何传输层错误
let closeFailure = '';
try {
  await post({ 'content-type': 'text/plain', connection: 'close' });
  await sleep(1500);
  await post({ 'content-type': 'text/plain', connection: 'close' });
  for (let i = 0; i < 12; i++) {
    await post({ 'content-type': 'text/plain', connection: 'close' });
    await sleep(1200);
    await post({ 'content-type': 'text/plain', connection: 'close' });
  }
} catch (e: any) {
  closeFailure = `${String(e)}｜cause=${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`;
}
assert.strictEqual(closeFailure, '', `close 姿势不该出错：${closeFailure}`);
console.log(`[腿2 Connection: close] 空闲超 timeout + 12 次卡边界，全部 200，无传输层错误`);
console.log(`结论：竞态在默认复用姿势下${raceHit ? '可稳定命中（12 次里有 X）' : '本机 12 次未命中'}；`
  + `close 姿势 0 错。故「不复用连接」是把该族时序红从门里根除的姿势修正，`
  + `是否等于已证实的机制需以门内实测（两轮 ECONNRESET）为限，不外推为产品缺陷。`);
srv.close();

