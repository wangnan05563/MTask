/**
 * `waitIsolatedServer` —— 验收门「隔离实例就绪」的统一判据（T02712）。
 *
 * 为什么要有这个文件：全仓 39 支门里有 20+ 支各写各的 `waitForServer(ms = 45_000)`，
 * 三种病同根：
 *  ① **窗口是写死的常量**——本仓隔离实例（tsx 冷启动 + better-sqlite3 首连）就绪时间在负载机
 *     实测落在 24.5s~345s（T02085），45s 窗口把正常慢启动直接判成「未就绪」；E3 首轮 35/1
 *     就是这个红，同参数重跑即 93/0（T02630 现场取证）。
 *  ② **只看端口可达，不看是谁在应答**——窗口拉长却不校验身份，会把「起来的是别的服务」
 *     当成就绪，做成假绿（比恒红更危险）。
 *  ③ **超时只留一个布尔**——读者看到 `FAIL=1` 无从判断「等了多久 / health 最后一次返回什么」，
 *     「环境未就绪」就此冒充「判据失守」。
 *
 * 判据（本文件的三条契约，由 `--boot-selftest` 逐条自证）：
 *  · 就绪 = `/api/health` 返回 200 **且 `service === 'mtask-server'`**（不是端口能连、不是任意 200）；
 *  · 预算可覆盖（`budgetMs` 或环境变量），默认 180s——窗口是「最多愿意等多久」的环境事实，
 *    实际等待时长 `upMs` 必须进证据，不能只留一个红/绿；
 *  · 未就绪时把**最后一次读数**（状态码 + 应答体片段 / 抛错首行）带出来，让红可判读。
 *
 * ⚠ `.mjs`/`.js` 门不能引 `.mts`（tsx 才认 `.mts`）——那批门按既有约定在门内落**逐字孪生**，
 *    改这里时同步改孪生（`verify-t02037-estimate-e3.mts` 是本helper的首个消费者）。
 */
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

export type BootReading = {
  up: boolean;
  upMs: number;
  budgetMs: number;
  attempts: number;
  health: Record<string, unknown> | null;
  last: string;
};

const SERVICE_ID = 'mtask-server';

/**
 * 轮询到就绪，或到预算耗尽。永不抛错：抛错形态折进 `last` 供取证。
 */
export async function waitIsolatedServer(opts: {
  base: string;
  budgetMs?: number;
  /** 环境变量名（如 `T02037_BOOT_BUDGET`），设了就用它覆盖 budgetMs */
  envName?: string;
  intervalMs?: number;
  perProbeTimeoutMs?: number;
}): Promise<BootReading> {
  const envVal = opts.envName ? process.env[opts.envName] : undefined;
  const budgetMs = Number(envVal ?? opts.budgetMs ?? 180_000);
  const intervalMs = opts.intervalMs ?? 1000;
  const perProbe = opts.perProbeTimeoutMs ?? 2000;
  const t0 = Date.now();
  let attempts = 0;
  let last = '(一次都没探到——检查端口是否被占用 / 子进程是否启动即退)';
  while (Date.now() - t0 < budgetMs) {
    attempts += 1;
    try {
      const res = await fetch(`${opts.base}/api/health`, { signal: AbortSignal.timeout(perProbe) });
      let json: Record<string, unknown> | null = null;
      try { json = (await res.json()) as Record<string, unknown>; } catch { json = null; }
      if (res.ok && json?.service === SERVICE_ID) {
        return { up: true, upMs: Date.now() - t0, budgetMs, attempts, health: json, last: `HTTP ${res.status} ${JSON.stringify(json).slice(0, 160)}` };
      }
      last = `HTTP ${res.status} ${json === null ? '(应答不是 JSON——不像本仓服务)' : JSON.stringify(json).slice(0, 160)}`;
    } catch (e) {
      last = `抛错 ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`;
    }
    await sleep(intervalMs);
  }
  return { up: false, upMs: Date.now() - t0, budgetMs, attempts, health: null, last };
}

/** 证据行：等待时长/预算/轮询次数/最后一次读数——「未就绪」必须带着这些出场。 */
export const bootEvidence = (r: BootReading) =>
  `等待 ${r.upMs}ms / 预算 ${r.budgetMs}ms / 轮询 ${r.attempts} 次；最后一次读数 ${r.last}`;

/**
 * 负对照自证（判据 4）：三条都必须在**本机真端口**上跑，不拿合成布尔凑绿。
 * B-01 应答不是本仓服务 ⇒ 判未就绪（身份校验有牙，不是假绿）；
 * B-02 应答是本仓服务 ⇒ 判就绪（B-01 不是恒假式）；
 * B-03 端口根本没人应答 ⇒ 判未就绪且 `last` 带出抛错形态。
 */
export async function bootSelftest(
  report: (name: string, cond: boolean, extra?: unknown) => void,
): Promise<void> {
  const listen = (body: unknown) => new Promise<{ base: string; close: () => Promise<void> }>((res) => {
    const srv = createServer((req, reply) => {
      reply.writeHead(200, { 'Content-Type': 'application/json' });
      reply.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      res({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r2) => srv.close(() => r2())) });
    });
  });

  const foreign = await listen({ ok: true, service: 'some-other-service', time: 'x' });
  const b1 = await waitIsolatedServer({ base: foreign.base, budgetMs: 3000, intervalMs: 300 });
  await foreign.close();
  report('B-01 health 应答的 service 不是 mtask-server ⇒ 判未就绪（身份校验有牙）',
    b1.up === false && b1.attempts >= 1 && b1.last.includes('some-other-service'), bootEvidence(b1));

  const ours = await listen({ ok: true, service: SERVICE_ID, time: 'x' });
  const b2 = await waitIsolatedServer({ base: ours.base, budgetMs: 3000, intervalMs: 300 });
  await ours.close();
  report('B-02 同一条腿换成 service=mtask-server ⇒ 判就绪（B-01 不是恒假式）',
    b2.up === true && b2.health?.service === SERVICE_ID, bootEvidence(b2));

  const nonJson = await listen('plain text, not json');
  const b3 = await waitIsolatedServer({ base: nonJson.base, budgetMs: 3000, intervalMs: 300 });
  await nonJson.close();
  report('B-03 应答不是 JSON（端口被别的东西占了）⇒ 判未就绪且点名「不像本仓服务」',
    b3.up === false && b3.last.includes('不像本仓服务'), bootEvidence(b3));

  // B-04：先 bind 一个临时端口拿到号，再关掉它——此刻那个号上无人应答，
  // 考的是「服务起不来」这一支（失败形态应是 ECONNREFUSED 类抛错，不该是一句空红）。
  const deadPort = await new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
  await sleep(200);
  const b4 = await waitIsolatedServer({ base: `http://127.0.0.1:${deadPort}`, budgetMs: 3000, intervalMs: 300 });
  report('B-04 端口无人应答 ⇒ 判未就绪且 `last` 带出抛错形态（不是一句空红）',
    b4.up === false && /抛错/.test(b4.last), bootEvidence(b4));
}
