/**
 * T02144 门（派生自 T02108：导出令牌临时文件无生命周期回收——tmp 单调增长）。
 *
 * 令牌生命周期原本只有「写入」与「下载即删」两端，本单补第三端（过期/放弃回收）。
 * 分工：verify-t02141 已证「措辞/装配阶段中止不落盘、闸位归还、停止后令牌仍有效」，本门只补此前无人证过的三层：
 *   ① 清扫语义本身（进程内直调，可控时钟）：只删「UUID 命名 + 超 TTL」，未过期/非令牌文件一律不动，
 *      单文件失败（如 UUID 命名的目录）不中断整轮；
 *   ② 真实链路的三种收场各归其位：正常下载仍即时删（不回归）、done 送达后用户放弃→由重启清扫回收、
 *      中止落在落盘之后→当场回收不残留；
 *   ③ 「done 已送达后不得删」这条语义边界（红线：T02105/T02141 的「停止后令牌仍有效、可重试下载」）——
 *      N-02 负对照把守卫改成无条件删，该断言必须变红，否则本门是绿的摆设。
 *
 * 用法：TMP=/d/code/tmp TEMP=/d/code/tmp node node_modules/tsx/dist/cli.mjs scripts/verify-t02144-tmp-sweep.mts
 *   （必须走 tsx，不能用 `node --experimental-strip-types` 直跑：T 组会进程内 import 产品源码
 *    `server/src/services/ReportService.ts`，而它内部是 `./db/connection` 这类无扩展名说明符，
 *    node 的类型剥离不做补全解析，会在门体中途炸成 ERR_MODULE_NOT_FOUND、连 PASS 行都不产出。）
 * 环境变量：T02144_PORT（默认随机 39600+rand300）、T02144_SANDBOX（临时 DATA_DIR 根，默认仓库上两级 tmp/）。
 * 隔离纪律（skill 红线 8）：DATA_DIR/TMP 一律落 D:（C: 盘实测 0 可用会触发 SQLITE_FULL）；
 *   生产库只读副本、端口全临时、模型走进程内 mock（零真实配额）、收尾删目录（副本含明文密钥配置）。
 * 负对照工作区（T02293）：N 组要把接线摘掉/把守卫改错再重启，**不在本仓工作树上动源码**——
 *   那等于在别人正在编辑的文件里读-改-写（并发会话的丢更新窗口），门中途崩了还会把仓库留在被改坏的状态。
 *   改为 `git worktree add --detach` 出一份 HEAD 副本，node_modules 用 junction 复用（原生模块 ABI 必须与主仓一致），
 *   用完先摘 junction 再 worktree remove；主仓工作树全程零写入（N-05 用 sha256 自证）。
 * 结果落 .workbuddy/t02144-gate-results-<运行标识>.txt。
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  utimesSync, unlinkSync, writeFileSync, symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

/**
 * 静态红线那条（S-11）的字面腿从 **HEAD 已提交树**取数（T02293 批㉘）：读工作树时，并发会话的半成品
 * 会把「等价重构」的红因扣在本门头上。helper 命名沿用房内 `headSrc` 约定，`verify-t02205` 才认得出
 * 这条锚点并逐轮核对。行为腿才是主判据，字面腿只在行为绿时兜底。
 */
function headSrc(rel: string): string {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02144_PORT ?? 39_600 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
// 沙箱根优先 D:（C: 0 可用是本单实测踩到的环境坑）；不存在则回落系统 tmpdir
const SANDBOX_ROOT = process.env.T02144_SANDBOX ?? (() => {
  const up = resolve(ROOT, '..', '..', 'tmp');
  mkdirSync(up, { recursive: true });
  return up;
})();
const DATA_DIR = mkdtempSync(join(SANDBOX_ROOT, 't02144-lab-'));
const TMP_DIR = join(DATA_DIR, 'tmp');
const HOURS = 3_600_000;
const FIVE_PID = '95f31a46-92f6-4046-8cb6-ee3c4e228a44'; // mtask五期（本特性自己的项目）
process.env.MTask_DATA_DIR = DATA_DIR;
mkdirSync(TMP_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
/** T02293 改判用：把行为证据同时记进 BEH，S 组（机制收口）据此取数，不再去匹配源码文本 */
const BEH: Record<string, boolean> = {};
const okB = (key: string, name: string, cond: boolean, extra?: unknown) => {
  BEH[key] = cond;
  ok(name, cond, extra);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { randomUUID } = await import('node:crypto');
const tok = () => randomUUID();
const ls = () => readdirSync(TMP_DIR);
const has = (n: string) => existsSync(join(TMP_DIR, n));
const isTokenName = (n: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n);
const tokens = (exclude: string[] = []) => ls().filter((n) => isTokenName(n) && !exclude.includes(n));
const backdate = (n: string, hoursAgo: number) => {
  const t = new Date(Date.now() - hoursAgo * HOURS);
  utimesSync(join(TMP_DIR, n), t, t);
};

// =====================================================================
// mock AI：非流式（启动会措辞段）+ 流式 SSE（周报洞察）都支持，零真实配额
// =====================================================================
const mockHits: string[] = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    let j: any = {};
    try { j = JSON.parse(body); } catch { /* 坏请求回空 */ }
    const user = String((j.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n'));
    mockHits.push(j.stream ? 'stream' : 'json');
    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = ['本周概况：五期启动会链路收口中。', '各项目进展要点：估算、导出、看板均在闭环。', '重点工作与高风险项：临时文件生命周期。', '下周建议：完成验收与发布。'];
      for (const t of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const want = /条数分别为 (\d+) 与 (\d+)。/.exec(user);
    const nRisks = want ? +want[1] : 2;
    const nComms = want ? +want[2] : 2;
    const items = [...user.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => m[1].trim());
    const content = JSON.stringify({
      risks: Array.from({ length: nRisks }, (_, i) => ({
        item: (items[i] ?? `风险 ${i + 1}`).slice(0, 40), impact: '会上确认影响面', mitigation: '会上明确责任方与时限',
      })),
      comms: Array.from({ length: nComms }, (_, i) => (i === 0 ? '周会跟里程碑节点开' : '变更先登记进需求跟踪矩阵')),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 隔离实例：生产库只读副本 → 临时 DATA_DIR（D:）
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
const Database = (await import('better-sqlite3')).default;
{
  const src = new Database(prodDb, { readonly: true });
  await src.backup(join(DATA_DIR, 'mtask.db'));
  src.close();
}
ok('X-00 生产库只读副本已生成（本门零写生产库）', existsSync(join(DATA_DIR, 'mtask.db')));

let child: ChildProcess | null = null;
let serverLog = '';
/** 上一次 killBoot 的端口确认结果（负对照据此判断「health 应答来自副本还是旧实例」） */
let lastKill: { freed: boolean; waitedMs: number } = { freed: true, waitedMs: 0 };
/** 副本工作区与主仓各自的启动器（原生模块 ABI 探测按 root 走，两份缓存） */
const LAUNCHERS = new Map<string, ReturnType<typeof resolveServerLauncher>>();
function launcherFor(root: string) {
  let l = LAUNCHERS.get(root);
  if (!l) {
    l = resolveServerLauncher(root, join(root, 'server', 'src', 'index.ts'));
    LAUNCHERS.set(root, l);
  }
  return l;
}
function boot(root: string = ROOT): ChildProcess {
  const L = launcherFor(root);
  const c = spawn(L.exec, L.tsx, {
    cwd: root,
    env: { ...process.env, ...L.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR, TMP: SANDBOX_ROOT, TEMP: SANDBOX_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout?.on('data', (b: Buffer) => (serverLog += b.toString()));
  c.stderr?.on('data', (b: Buffer) => (serverLog += b.toString()));
  return c;
}
/**
 * 等待隔离实例就绪。**开机预算 120s → 300s → 600s，并把实测耗时写进证据**（T02293 批㉘）：
 * X-00 喂给实例的是生产库的**只读副本**（本轮实测 94MB），开机要走 req-status reconcile、
 * derived-from 回填、自动备份一整套，本机有并发负载时实测 120~140s 才 listen——120s 的预算
 * 把「起得慢」判成「起不来」，X-01 一红就连带 15 条行为判据全红（本轮即此形态，红的全是门、产品零改动）。
 * 判据该问「实例是否就绪」，不该赌机器此刻多闲；真起不来时照旧红，且证据里有实测等待时长可用。
 * 第二轮把预算再放宽到 600s 并改成可环境变量覆盖：本轮把本门与 `verify-t02205`（全程高 CPU 的
 * 96 门枚举）并发跑，首次开机 300s 都没起来——门的预算要为「本机有别的工作在跑」留余量。
 * 残余问题记入台账交下一批：boot 输入本应是门自造的夹具库（规约判据 2），拿生产副本当输入
 * 会让本门耗时随生产数据增长继续漂。
 */
const BOOT_BUDGET_MS = Number(process.env.T02144_BOOT_BUDGET ?? 600_000);
async function waitUp(ms = BOOT_BUDGET_MS): Promise<{ up: boolean; waitedMs: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok && (await res.json().catch(() => null))?.service === 'mtask-server') return { up: true, waitedMs: Date.now() - t0 };
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return { up: false, waitedMs: Date.now() - t0 };
}
async function killBoot(): Promise<void> {
  const c = child;
  child = null;
  /**
   * 按**进程树**杀，不是只杀句柄进程（T02293 批㉘ 第二轮）。`spawn(exec, [tsx/cli.mjs, entry])` 里
   * tsx CLI 还会再拉起一个真正跑 server 的子进程：`child.kill()` 只终止父进程，孤儿子实例照样 listen、
   * 照样在 startup 做一轮 `sweepReportTmp()`。它既会顶替新实例回答 health（负对照测错对象），
   * 又会把负对照刚埋下的过期令牌删掉——本轮实测的 N-01「摘掉接线过期令牌仍被清」即此形态。
   */
  if (process.platform === 'win32' && c?.pid) {
    try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', timeout: 20_000 }); }
    catch { c.kill(); }
  } else c?.kill();
  /**
   * kill 之后**确认端口真的空了**再返回（T02293 批㉘ 第二轮补）。`kill()` 是异步的，Windows 上
   * 被 kill 的实例可能仍在 listen；不确认就重启，下一次 `waitUp` 拿到的 health 应答可能来自
   * **上一个进程**，负对照于是测错对象——本轮实测形态：N-01 在副本里摘掉启动清扫接线后
   * 「过期令牌仍被清」判红，红因不是守卫没用，而是主仓那个接线完好的旧实例回答了 health，
   * 打了补丁的副本实例根本没被访问过。这一条不修，N 组既能假红也能假绿。
   */
  const t0 = Date.now();
  let freed = false;
  while (Date.now() - t0 < 30_000) {
    let alive = false;
    try { alive = (await fetch(`${BASE}/health`)).ok; } catch { /* 端口已空 */ }
    if (!alive) { freed = true; break; }
    await sleep(500);
  }
  lastKill = { freed, waitedMs: Date.now() - t0 };
  await sleep(1_200); // 等句柄释放，Windows 上否则临时目录删不净
}
async function call(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: NO_KEEPALIVE,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* 二进制 */ }
  return { status: res.status, body };
}
/**
 * 门→隔离实例的每个请求都带 `Connection: close`（T02293 批㉘）。
 * A2-01 连着两轮红在「首条 SSE 零帧」，把 `e.cause` 打出来后是 `ECONNRESET read ECONNRESET`；
 * 指纹是「慢开机轮必红、快开机轮不红」（实测 boot 18s 轮 49/0；boot 173s/382s 轮 46/3），
 * 同一进程内后续同路由请求全部正常，所以不是产品缺陷，是门这条连接姿势的问题。
 * **归因诚实标注**：原本推测是「undici 复用服务端 keepAliveTimeout(默认 5s) 之后悄悄关掉的连接」，
 * 但用最小夹具（`scripts/probe-keepalive-idle-race.mts`，本批已入库：空闲远超 timeout 一次 + 卡关闭边界 12 次）实测**未复现**
 * ——undici 对 FIN 会优雅重连，本机 12/12 没炸。故这里只把已证实的部分写下：
 * 已证实 = 两轮红在传输层 ECONNRESET 且只与空闲时长相关；未证实 = 具体是哪一侧先关的连接。
 * `Connection: close` 是让整族「复用连接上的时序红」无从发生的手段（消除而非证明），
 * 用完即换下一条连接，代价是每请求一次握手——门内量级可忽略。
 */
const NO_KEEPALIVE = { 'Content-Type': 'application/json', connection: 'close' };
/** 上一次「门→实例」请求的时刻，用来把「空闲多久」写进 A2-01 证据（keep-alive 竞态的直接读数） */
let lastReqAt = Date.now();
function stampReq() { const g = Date.now() - lastReqAt; lastReqAt = Date.now(); return g; }

async function download(token: string, fileName: string) {
  const res = await fetch(BASE + '/report/ai-download', {
    method: 'POST', headers: NO_KEEPALIVE,
    body: JSON.stringify({ token, filename: fileName }),
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}
/** 走 SSE；abortWhen 命中即在客户端断开（服务端的 close 守卫由此被触发） */
async function streamGen(path: string, body: unknown, opts: { abortWhen?: (ev: { event: string; data: any }) => boolean } = {}): Promise<{
  events: Array<{ event: string; data: any }>; aborted: boolean; status: number; contentType: string; failure: string; idleMs: number;
}> {
  const ac = new AbortController();
  const events: Array<{ event: string; data: any }> = [];
  let aborted = false;
  let status = 0;
  let contentType = '';
  // 批㉘：原来 `catch {}` 把所有失败咽进同一口「events 空」的井——A2-01 红时既分不清「服务端在出第一帧
  // 之前就炸了（非 SSE 应答）」还是「流被中断/解析不出帧」，红因不可辨（本轮实测首轮生成即此形态）。
  let failure = '';
  let idleMs = 0;
  try {
    idleMs = stampReq();
    const res = await fetch(BASE + path, {
      method: 'POST', headers: NO_KEEPALIVE, body: JSON.stringify(body), signal: ac.signal,
    });
    status = res.status;
    contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !contentType.includes('event-stream')) {
      failure = `HTTP ${status} content-type=${contentType || '(空)'} 响应体: ${(await res.text().catch(() => '')).slice(0, 400)}`;
      return { events, aborted, status, contentType, failure, idleMs };
    }
    let raw = '';
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      let i = raw.indexOf('\n\n');
      while (i >= 0) {
        const chunk = raw.slice(0, i);
        raw = raw.slice(i + 2);
        const ev = {
          event: /^event: (.+)$/m.exec(chunk)?.[1] ?? '',
          data: (() => { try { return JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? '{}'); } catch { return {}; } })(),
        };
        events.push(ev);
        if (opts.abortWhen?.(ev)) { aborted = true; ac.abort(); return { events, aborted, status, contentType, failure, idleMs }; }
        i = raw.indexOf('\n\n');
      }
    }
  } catch (e: any) {
    const s = String(e);
    // 客户端主动 abort 是预期内（N 组靠它验中止），不算失败
    if (!aborted && !/abort/i.test(s)) {
      // `TypeError: fetch failed` 本身不带原因，原因在 e.cause（ECONNRESET / ECONNREFUSED / UND_ERR_*）。
      // 第二轮实测 A2-01 就红在这里（173s 开机后首条 SSE 连不上），只打 String(e) 等于没打。
      const c = e?.cause;
      failure = `读流出错: ${s}｜cause=${c?.code ?? c?.name ?? ''} ${c?.message ?? ''}`.trim();
    }
  }
  return { events, aborted, status, contentType, failure, idleMs };
}

/** 12 页标准稿（含风险页 + 沟通页，措辞段必然被调用） */
function baseOutline(): any[] {
  const spec: Array<[string, string, string[], string[]]> = [
    ['封面', '项目启动会', ['preflight'], []],
    ['议程', '今天讲什么', ['preflight'], ['范围与交付物', '责任分工']],
    ['项目背景', '为什么现在做', ['prdDoc'], ['业务背景', '现状痛点']],
    ['项目团队介绍', '谁负责什么', ['assignees'], ['责任分工', '协作接口人']],
    ['项目需求', '需求全景与优先级', ['reqStats', 'reqList'], ['高优先级需求', '待确认需求']],
    ['项目范围', '做什么与不做什么', ['reqList'], ['范围内', '范围外']],
    ['项目计划', '项目计划时间线', ['timeline', 'planRows'], ['阶段划分', '关键依赖']],
    ['工作量评估', '人天与报价口径', ['workload'], ['估算区间', '口径说明']],
    ['测试与质量策略', '用例覆盖与质量门槛', ['coverage'], ['覆盖率结论', '回归策略']],
    ['项目风险', '风险登记与应对', ['risks'], ['进度风险', '范围风险']],
    ['沟通管理', '例会与变更口径', [], ['周会节奏', '变更登记']],
    ['附录', '数据口径与工作空间', ['workspace', 'prdDoc'], ['取数时间', '原文索引']],
  ];
  const layoutOf = (i: number) => (i === 0 ? 'cover' : i === 1 ? 'toc' : i === 6 ? 'timeline' : i === 7 ? 'chart' : i === 11 ? 'list' : 'table');
  return spec.map(([section, title, dataKeys, bullets], i) => ({
    section, title, bullets: section === '封面' ? [] : bullets, dataKeys, layout: layoutOf(i),
  }));
}

// =====================================================================
// S 组（机制收口）改判说明：T02293 前这里读 5 个源文件做正则匹配
// （export function sweepReportTmp / app.listen 后的 startReportTmpSweeper() /
//   if (!isReportToken(name)) continue / if (issuedToken && !doneSent) ... 等），
// 任何等价重构（改名、提函数、挪文件）都会让门恒红，而机制到底接没接上，
// 下面 A1/T/A2/A3 已用真产物给过答案。S 组现在挪到这些行为取数之后，逐条改判为读 BEH。
// =====================================================================

// =====================================================================
// A1 组：重启即清（单上「生成后不下载 → 等待/重启服务 → tmp/ 为空」的正面证据）
// =====================================================================
const seedStale = tok();
const seedFresh = tok();
const seedPlain = 'notes-保留.txt';
const seedDirTok = tok(); // UUID 命名的目录：unlinkSync 必抛 EISDIR，验「单文件失败不中断整轮」
writeFileSync(join(TMP_DIR, seedStale), Buffer.from('stale-export'));
writeFileSync(join(TMP_DIR, seedFresh), Buffer.from('fresh-export'));
writeFileSync(join(TMP_DIR, seedPlain), '与令牌无关的业务临时文件');
mkdirSync(join(TMP_DIR, seedDirTok));
backdate(seedStale, 7);
backdate(seedDirTok, 7);
const seededBeforeBoot = ls().slice().sort();

child = boot();
const boot1 = await waitUp();
if (!boot1.up) {
  ok('X-01 隔离实例启动', false, {
    等待: `${boot1.waitedMs}ms（预算 ${Math.round(BOOT_BUDGET_MS / 1000)}s）`,
    末段日志: serverLog.slice(-600),
    日志字节: serverLog.length,
    子进程: child ? { pid: child.pid, 已退出: child.exitCode !== null, 退出码: child.exitCode, 信号: child.signalCode } : '已回收',
  });
} else {
  ok(`X-01 隔离实例启动（boot1，实测就绪耗时 ${Math.round(boot1.waitedMs / 1000)}s；预算 ${Math.round(BOOT_BUDGET_MS / 1000)}s，起得慢不等于起不来）`, true);
  ok('A1-00 埋点就位：boot 前 tmp 里确有 4 类道具（过期令牌/未过期令牌/非令牌文件/UUID 命名的目录）',
    seededBeforeBoot.length === 4, seededBeforeBoot);
  okB('staleSweptAtBoot', 'A1-01 重启即清过期令牌（7h > 6h TTL 的令牌文件开机被回收）', !has(seedStale), ls());
  okB('freshKept', 'A1-02 未过期令牌不误删（TTL 内仍有效，不能让「回收」变成「开机清空」把待下载文件一起带走）', has(seedFresh), ls());
  okB('plainKept', 'A1-03 非令牌文件一律不动（白名单外的东西不归本机制管）', has(seedPlain), ls());
  okB('dirTolerated', 'A1-04 同轮里删不掉的（UUID 命名目录）不阻断其它文件回收，也不炸启动',
    has(seedDirTok) && !has(seedStale), { 目录仍在: has(seedDirTok), 文件已清: !has(seedStale) });
  okB('sweepLoggedBoot1', 'A1-05 清扫有留痕（日志写明回收数量，孤儿增长这事得能被观测到）',
    /report-tmp sweep: \d+ abandoned export file\(s\) removed/.test(serverLog), (serverLog.match(/report-tmp[^\n]*/) ?? []).slice(0, 2));
  const tool = await call('POST', '/aitools', {
    name: 't02144-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-wording', timeoutMs: 20_000,
  });
  const toolId = tool.body?.id as string | undefined;
  ok('X-02 mock AI 工具已建（不触真实模型、不烧真实配额）', !!toolId, tool.body);

  // ---- T 组：清扫语义（进程内直调 + 可控时钟，不靠真实等 6h）----
  const RS = await import('../server/src/services/ReportService.ts');
  ok('T-01 TTL 常量确实是 6h（过期口径钉住：不是「立刻删」也不是「永不删」）', RS.REPORT_TMP_TTL_MS === 6 * HOURS, RS.REPORT_TMP_TTL_MS);
  const tStale = tok();
  const tStale2 = tok();
  const tFresh = tok();
  const tPlain = 'keep-me.bin';
  for (const n of [tStale, tStale2, tFresh]) writeFileSync(join(TMP_DIR, n), Buffer.from('x'));
  writeFileSync(join(TMP_DIR, tPlain), 'x');
  backdate(tStale, 7);
  backdate(tStale2, 8);
  const removed = RS.sweepReportTmp(RS.REPORT_TMP_TTL_MS, Date.now());
  okB('ttlSweepCount', 'T-02 过期令牌全部删除且返回数如实（本轮 2 个：7h/8h）',
    removed === 2 && !has(tStale) && !has(tStale2), { removed, 残留: ls() });
  ok('T-03 未过期令牌与非令牌文件原样保留（含那个删不动的 UUID 目录）',
    has(tFresh) && has(tPlain) && has(seedFresh) && has(seedPlain) && has(seedDirTok), ls());
  ok('T-04 discardReport 删指定令牌返回 true，对不存在的令牌返回 false 且不抛（回收失败不能让请求跟着炸）',
    RS.discardReport(tFresh) === true && !has(tFresh) && RS.discardReport(tok()) === false);
  ok('T-05 无可回收对象时返回 0（UUID 命名的目录 unlink 抛错被吞、不计数、不中断）',
    RS.sweepReportTmp(RS.REPORT_TMP_TTL_MS, Date.now()) === 0, { 目录仍在: has(seedDirTok), tmp: ls() });
  okB('clockInjectWorks', 'T-06 时钟注入有效：now 往前拨 12h 后，刚写入的令牌也算过期（清扫判据只有 mtime 一个来源）', (() => {
    const n = tok();
    writeFileSync(join(TMP_DIR, n), Buffer.from('x'));
    const k = RS.sweepReportTmp(RS.REPORT_TMP_TTL_MS, Date.now() + 12 * HOURS);
    return k >= 1 && !has(n);
  })());
  // A1/T 组用的道具文件清场，给 A2 一个「零令牌」的干净基线
  for (const n of [seedPlain, seedFresh, tPlain]) if (has(n)) unlinkSync(join(TMP_DIR, n));
  rmSync(join(TMP_DIR, seedDirTok), { recursive: true, force: true });
  ok('T-07 基线已清场（A2 的「无残留」断言据此才有意义）', tokens().length === 0, ls());

  // ---- A2 组：真实链路三种收场 ----
  const outline = baseOutline();
  const body = { projectId: FIVE_PID, toolId, outline };

  const gen1 = await streamGen('/plans/kickoff-ppt-stream', body);
  const done1 = gen1.events.find((e) => e.event === 'done');
  // T02293 改判：原来钉 pageCount === outline.length（12），把「一条大纲 = 一页」这一实现形态
  // 当成了口径；时间线页按阶段展开后天然会多页（expandTimelinePages），钉死 12 是锁实现不是锁行为。
  // 改钉行为：done 送达 + 页数不少于大纲条目数（少一页就是真丢内容，仍会红）。
  ok('A2-01 正常生成链路通（done 送达，且产出不少于大纲条目数——时间线页按阶段展开成多页属正常）',
    !!done1 && Number(done1.data?.pageCount ?? 0) >= outline.length,
    {
      events: gen1.events.map((e) => e.event).join(','), pageCount: done1?.data?.pageCount, 大纲条数: outline.length,
      // 批㉘：红因可读性——零帧时把 HTTP 状态/content-type/失败面一起打出来，不再只留一个空 events 串
      应答: `HTTP ${gen1.status} ${gen1.contentType || '(无 content-type)'}`, 失败面: gen1.failure || '(无)',
      距上次请求空闲: `${Math.round(gen1.idleMs / 1000)}s（服务端 keepAliveTimeout 默认 5s，超此值就不该再复用连接）`,
    });
  const tok1 = done1 ? String(done1.data?.token ?? '') : '';
  const dl1 = tok1 ? await download(tok1, String(done1?.data?.fileName ?? '')) : null;
  // 批㉘：A2-02 原来在 A2-01 已红（done1 不存在 → tok1 空）时仍去 has('')，而
  // existsSync(join(TMP_DIR,'')) 判的是目录本身，恒真——把上一断言的红，误报成本断言的「残留:true」。
  // 改钉「拿到令牌才算这一腿成立」：无令牌时如实标 skipped 并指回 A2-01，不与真残留混成一类红。
  okB('downloadDeletes', 'A2-02 正常下载即删（单上「生成后正常下载 → 仍即时删除」不回归）',
    !!tok1 && dl1?.status === 200 && dl1.buf.subarray(0, 2).toString() === 'PK' && dl1.buf.length > 20_000 && !has(tok1),
    { status: dl1?.status, bytes: dl1?.buf.length, 令牌: tok1 || '(A2-01 未产出 done，本腿无对象)', 残留: tok1 ? has(tok1) : false });

  const gen2 = await streamGen('/plans/kickoff-ppt-stream', body, { abortWhen: (e) => e.event === 'done' });
  const done2 = gen2.events.find((e) => e.event === 'done');
  const earlyDrop = String(done2?.data.token ?? '');
  okB('tokenSurvivesDone', 'A2-03 done 已送达后客户端断开 → 令牌文件必须仍在（这是「正常放弃」，归清扫管，不能当场删）',
    !!earlyDrop && has(earlyDrop), { events: gen2.events.map((e) => e.event).join(','), 残留: has(earlyDrop) });
  const dl2 = earlyDrop ? await download(earlyDrop, String(done2?.data.fileName ?? 'x.pptx')) : null;
  okB('retryDownloadOk', 'A2-04 「停止后令牌仍有效、可重试下载」未回归（T02105/T02141 的既有验收）',
    dl2?.status === 200 && dl2.buf.subarray(0, 2).toString() === 'PK' && !has(earlyDrop),
    { status: dl2?.status, bytes: dl2?.buf.length, 下载后仍在: has(earlyDrop) });

  const gen3 = await streamGen('/plans/kickoff-ppt-stream', body, {
    // 中止点仍要落在「装配尾段」：按事件自带的 N/M 编号取最后一页，不写死页数（同上，锁行为不锁数）
    abortWhen: (e) => {
      if (e.event !== 'stage') return false;
      const m = /页 (\d+)\/(\d+) 已装配/.exec(String(e.data?.msg ?? ''));
      return !!m && m[1] === m[2];
    },
  });
  await sleep(1_500);
  okB('kickoffAbortClean', 'A2-05 中止落在装配尾段（最后一页之后）→ 令牌文件不残留（单上第 3 条验收）',
    gen3.aborted && tokens().length === 0, { aborted: gen3.aborted, 残留: tokens(), 错误事件: gen3.events.find((e) => e.event === 'error')?.data });
  const err3 = String(gen3.events.find((e) => e.event === 'error')?.data?.error ?? '');
  ok('A2-06 中止如实回报而非静默（error 事件带中止语义，前端能区分失败与取消）',
    !gen3.events.some((e) => e.event === 'done') && (/已中止|已停止/.test(err3) || gen3.aborted), { err3 });

  // 周报流式链路（同一把守卫的第二个用户）
  const rep = await streamGen('/report/ai-generate-stream', { period: 'week', format: 'xlsx', projectId: FIVE_PID, toolId });
  const repDone = rep.events.find((e) => e.event === 'done');
  const repTok = String(repDone?.data?.token ?? '');
  const repErr = String(rep.events.find((e) => e.event === 'error')?.data?.error ?? '');
  ok('A2-07 周报流式生成不受影响（mock SSE 出稿并落盘令牌）', !!repDone && !!repTok && has(repTok),
    { events: rep.events.map((e) => e.event).join(','), token: repTok, 错误: repErr.slice(0, 400),
      末段日志: serverLog.slice(-400) });
  if (repTok) {
    const dlR = await download(repTok, String(repDone?.data?.filename ?? 'r.xlsx'));
    ok('A2-08 周报正常下载即删（不回归）', dlR.status === 200 && dlR.buf.length > 1_000 && !has(repTok),
      { status: dlR.status, bytes: dlR.buf.length });
  }
  const rep2 = await streamGen('/report/ai-generate-stream', { period: 'week', format: 'xlsx', projectId: FIVE_PID, toolId }, {
    abortWhen: (e) => e.event === 'stage' && /合成文件/.test(String(e.data?.msg ?? '')),
  });
  await sleep(1_500);
  okB('reportAbortClean', 'A2-09 周报中止（落在合成/落盘窗口）→ 无孤儿残留',
    rep2.aborted && tokens().length === 0,
    { 残留: tokens(), events: rep2.events.map((e) => e.event).join(','),
      中止前事件: rep2.events.filter((e) => e.event === 'stage').map((e) => String(e.data?.msg ?? '')).slice(-2),
      错误: String(rep2.events.find((e) => e.event === 'error')?.data?.error ?? '').slice(0, 300) });

  // 「生成后不下载」的真实产物：正常跑完、done 送达、用户就是不点下载 → 现场留给 A3 复现重启回收
  const gen4 = await streamGen('/plans/kickoff-ppt-stream', body);
  const abandoned = String(gen4.events.find((e) => e.event === 'done')?.data.token ?? '');
  ok('A2-10 复现材料就位：正常出稿后不下载，令牌文件确实留在 tmp（这正是本单要治的孤儿形态）',
    !!abandoned && has(abandoned) && tokens().length === 1, { abandoned, tmp: tokens() });

  const health = await call('GET', '/health');
  okB('bootHealthy', 'A2-11 实例全程健康，无未捕获异常', health.status === 200 && !/unhandledRejection|uncaughtException/.test(serverLog),
    (serverLog.match(/unhandledRejection|uncaughtException[^\n]{0,120}/) ?? []).slice(0, 2));
  ok('A2-12 模型调用全程走 mock（非流式措辞 + 流式洞察都命中，零真实配额）',
    mockHits.includes('json') && mockHits.includes('stream') && new Set(mockHits).size === 2, { mockHits });

  await killBoot();
  // ---- A3 组：真实产物 + 真实重启（A2-10 那个被放弃的导出文件，重启后被清）----
  const stillThere = has(abandoned);
  backdate(abandoned, 7); // 代表「用户放了 7 小时没下载」（TTL=6h）
  serverLog = '';
  child = boot();
  const { up: up2 } = await waitUp();
  okB('a3SweptAbandoned', 'A3-01 用户放弃的真实导出文件在重启后被回收（单上「等待/重启服务 → tmp/ 为空」用真产物复现）',
    up2 && stillThere && !has(abandoned), { 重启前有: stillThere, 重启后在: has(abandoned), tmp: ls() });
  ok('A3-02 tmp 目录收口干净（无任何令牌残留）', up2 && tokens().length === 0, ls());
  await killBoot();
}

// =====================================================================
// N 组：负对照（把改动摘掉/改错，对应断言必须变红——证明本门有牙）
// T02293 改判两条：
//   ① 落点：原先直接改本仓工作树的 server/src/index.ts、server/src/routes/plans.ts。那两个文件正是
//      并发会话在编辑的对象，读-改-写的窗口就是别人的丢更新窗口，门中途崩了仓库还留在被摘掉接线的状态。
//      现在一律在 HEAD 的 detached worktree 副本里做，主仓工作树只读（N-05 用 sha256 自证零写入）。
//   ② 定位：原先钉的是「整行字面量（含缩进）」，缩进一变就 throw，整门崩栈；现在按语义正则定位，
//      命不中只让对应负对照腿记红并写明原因（负对照缺席=本门没牙，这是判据问题，不是门脚本崩溃的理由）。
// =====================================================================
const NEG_ROOT = join(SANDBOX_ROOT, `t02144-negwt-${process.pid}`);
const NEG_FILES = ['server/src/index.ts', 'server/src/routes/plans.ts'];
const shaOf = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function buildNegWorkspace(): boolean {
  try {
    if (existsSync(NEG_ROOT)) rmSync(NEG_ROOT, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '--detach', NEG_ROOT, 'HEAD'], { cwd: ROOT, stdio: 'pipe', timeout: 180_000 });
    // junction（实测本机无需管理员权限；普通 symlink 需要），依赖仍用主仓那一份——原生模块 ABI 必须一致
    symlinkSync(join(ROOT, 'node_modules'), join(NEG_ROOT, 'node_modules'), 'junction');
    return existsSync(join(NEG_ROOT, 'server', 'src', 'index.ts')) && existsSync(join(NEG_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
  } catch (e) {
    serverLog += `\n[负对照工作区创建失败] ${e instanceof Error ? e.message : String(e)}\n`;
    return false;
  }
}
function dropNegWorkspace(): void {
  // 先摘 junction（Node 的 rmSync 只删链接本身，实测不会顺着删进主仓 node_modules），再删副本
  try { rmSync(join(NEG_ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* 没建成就无需解除 */ }
  try { execFileSync('git', ['worktree', 'remove', '--force', NEG_ROOT], { cwd: ROOT, stdio: 'ignore', timeout: 180_000 }); }
  catch { rmSync(NEG_ROOT, { recursive: true, force: true }); }
  try { execFileSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'ignore', timeout: 60_000 }); } catch { /* 尽力 */ }
}
/** 在副本里按语义正则打一处补丁；返回 null 表示没命中（调用方据此记红，不抛） */
function patchIn(root: string, rel: string, find: RegExp, to: (m: RegExpExecArray) => string):
  { sha: string; hit: string; restore: () => void } | null {
  const p = join(root, rel);
  const before = readFileSync(p, 'utf8');
  const m = find.exec(before);
  if (!m) return null;
  writeFileSync(p, before.slice(0, m.index) + to(m) + before.slice(m.index + m[0].length));
  const sha = createHash('sha256').update(before).digest('hex');
  return {
    sha, hit: m[0].trim(),
    restore: () => {
      writeFileSync(p, before);
      if (shaOf(p) !== sha) throw new Error(`负对照还原后 sha256 不一致：${rel}`);
    },
  };
}
{
  const negReady = buildNegWorkspace();
  okB('negWorkspace', 'N-00 负对照工作区就绪：HEAD 的 detached worktree 副本 + node_modules junction（主仓工作树全程只读）',
    negReady, { NEG_ROOT, 创建方式: 'git worktree add --detach + fs junction' });
  const repoBefore = new Map(NEG_FILES.map((f) => [f, shaOf(join(ROOT, f))]));
  try {
    if (!negReady) throw new Error('负对照工作区未建成（见 serverLog）');

    // N-01 摘掉启动清扫接线 → 过期令牌必须活下来
    const nFile = tok();
    writeFileSync(join(TMP_DIR, nFile), Buffer.from('n01'));
    backdate(nFile, 7);
    const guard = patchIn(NEG_ROOT, 'server/src/index.ts', /^[ \t]*startReportTmpSweeper\(\);[ \t]*$/m,
      () => '  /* 负对照：启动清扫接线摘除 */');
    if (!guard) throw new Error('N-01 接线锚点未命中：副本里找不到「启动时调用清扫定时器」这一行');
    try {
      serverLog = '';
      // 记 boot 之前的端口确认：端口没空就 boot，health 可能由**上一个实例**应答，
      // 那这条负对照测的就不是副本里摘了接线的进程（上轮实测即此形态）。
      const portClearBeforeBoot = lastKill.freed;
      child = boot(NEG_ROOT);
      const { up } = await waitUp();
      okB('nWiringControl', 'N-01 负对照：在副本里摘掉启动清扫接线后，过期令牌不再被清（A1-01 不是绿的摆设）',
        up && portClearBeforeBoot && has(nFile),
        { 起来了: up, 仍在: has(nFile), 摘除的接线: guard.hit, 启动前端口已空: portClearBeforeBoot });
      await killBoot();
    } finally {
      guard.restore();
      if (has(nFile)) unlinkSync(join(TMP_DIR, nFile));
    }
    okB('nRestore1', 'N-02 负对照还原校验：副本 index.ts 的 sha256 与改动前一致（补丁没留下残渣）', shaOf(join(NEG_ROOT, 'server/src/index.ts')) === guard.sha);

    // N-03 把 close 守卫改成无条件删 → done 送达后重试下载必须失败（证明 !doneSent 这个条件是必要的）
    const guard2 = patchIn(NEG_ROOT, 'server/src/routes/plans.ts',
      /if \(issuedToken && !doneSent\) discardReport\(issuedToken\);/,
      () => 'if (issuedToken) discardReport(issuedToken);');
    if (!guard2) throw new Error('N-03 守卫锚点未命中：副本里找不到「未送达才回收令牌」这条守卫');
    try {
      const n3PortClear = lastKill.freed;
      const mockTool = await (async () => { child = boot(NEG_ROOT); await waitUp(); return call('POST', '/aitools', {
        name: 't02144-mock3', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'mock-key', model: 'mock-wording', timeoutMs: 20_000,
      }); })();
      const toolId3 = mockTool.body?.id as string;
      const g = await streamGen('/plans/kickoff-ppt-stream', { projectId: FIVE_PID, toolId: toolId3, outline: baseOutline() }, {
        abortWhen: (e) => e.event === 'done',
      });
      const t3 = String(g.events.find((e) => e.event === 'done')?.data.token ?? '');
      const r3 = t3 ? await download(t3, 'x.pptx') : null;
      okB('nDoneSentControl', 'N-03 负对照：无条件删令「done 已送达后重试下载」失败（A2-04 的语义边界确有守卫价值）',
        n3PortClear && !!t3 && r3?.status !== 200, { token: t3, status: r3?.status, 文件在: has(t3), 启动前端口已空: n3PortClear });
      await killBoot();
    } finally {
      guard2.restore();
    }
    okB('nRestore2', 'N-04 负对照还原校验：副本 plans.ts 的 sha256 与改动前一致', shaOf(join(NEG_ROOT, 'server/src/routes/plans.ts')) === guard2.sha);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    serverLog += `\n[N 组负对照未完成] ${why}\n`;
    okB('nWiringControl', 'N-01 负对照：在副本里摘掉启动清扫接线后，过期令牌不再被清（A1-01 不是绿的摆设）', false, `未完成：${why}`);
    okB('nRestore1', 'N-02 负对照还原校验：副本 index.ts 的 sha256 与改动前一致（补丁没留下残渣）', false, `未完成：${why}`);
    okB('nDoneSentControl', 'N-03 负对照：无条件删令「done 已送达后重试下载」失败（A2-04 的语义边界确有守卫价值）', false, `未完成：${why}`);
    okB('nRestore2', 'N-04 负对照还原校验：副本 plans.ts 的 sha256 与改动前一致', false, `未完成：${why}`);
  } finally {
    if (existsSync(NEG_ROOT)) dropNegWorkspace();
  }
  okB('repoUntouched', 'N-05 本仓工作树零写入：N 组跑完后主仓两个源码文件的 sha256 与进入 N 组前逐字一致（负对照只在副本里动刀）',
    NEG_FILES.every((f) => shaOf(join(ROOT, f)) === repoBefore.get(f)),
    NEG_FILES.map((f) => ({ f, 前: repoBefore.get(f)?.slice(0, 12), 后: shaOf(join(ROOT, f)).slice(0, 12) })));
}

// =====================================================================
// S 组：机制收口（T02293 改判 —— 断言读上面已实测到的行为证据，不读源码文本）
// 每条都写清「行为腿是哪几条」：重构改了函数名/文件位置不影响这里，机制断了才红。
// 唯一保留的字面锚点是 S-11（定时器 unref）：它没有运行期可观测面（监听器本身就让 loop 活着），
// 属规约第 3 条说的静态红线，按规约必须配同义行为腿（S-06），行为腿红 ⇒ S-11 记红。
// 批㉘：S-11 写成 okPair（红因分「行为失守 / 锚点失配」两种落账）、取数面换 `git show HEAD:`（不读并发工作树），
// 并加 S-11b 反证给字面腿配牙——N-01 摘接线时 S-11 应红在行为腿上。
// =====================================================================
{
  ok('S-01 回收链路三端都实测到位：可下载（A2-02）、开机回收过期（A1-01）、中止当场回收（A2-05）',
    BEH.downloadDeletes && BEH.staleSweptAtBoot && BEH.kickoffAbortClean, BEH);
  ok('S-02 白名单外的东西一律不碰（非令牌文件与 UUID 命名的目录两轮清扫后都在——机制不是 rm -rf tmp）',
    BEH.plainKept && BEH.dirTolerated, BEH);
  ok('S-03 过期判定只看 mtime+TTL：7h/8h 令牌被清且计数如实、TTL 内的保留、把 now 拨快后新令牌也算过期',
    BEH.ttlSweepCount && BEH.freshKept && BEH.clockInjectWorks, BEH);
  ok('S-04 单文件失败不中断整轮（删不动的目录不阻断同轮回收，实例全程健康）',
    BEH.dirTolerated && BEH.bootHealthy, BEH);
  ok('S-05 定时家族确实挂在启动上：两轮真实开机都做了回收并留痕（不是只在测试里手工调了一次）',
    BEH.sweepLoggedBoot1 && BEH.a3SweptAbandoned, BEH);
  ok('S-06 开机即刻先清一轮，不等 TTL 间隔（waitUp 返回时过期令牌已不在）',
    BEH.staleSweptAtBoot && BEH.sweepLoggedBoot1, BEH);
  ok('S-07 两条导出链路一个口径：启动会中止与周报中止都不留孤儿（原来钉两处源码，现在钉两条真实链路）',
    BEH.kickoffAbortClean && BEH.reportAbortClean, BEH);
  ok('S-08 done 已送达后不得删（红线：停止后令牌仍有效、可重试下载，A2-03/A2-04 同时成立）',
    BEH.tokenSurvivesDone && BEH.retryDownloadOk, BEH);
  ok('S-09 close 早于 promise 落地的补删窗口有行为证据（装配尾段中止后 tmp 归零，孤儿没人管就会留一个）',
    BEH.kickoffAbortClean, BEH);
  ok('S-10 清扫可观测：日志写明回收数量（孤儿增长这事得能被看见）', BEH.sweepLoggedBoot1, BEH);
  {
    const RSRC = headSrc('server/src/services/ReportService.ts');
    okPair(ok, 'S-11 静态红线（规约第 3 条：无运行期可观测面才允许钉源码，且必须服从行为腿 S-06）：清扫定时器 unref，不拖住进程退出',
      () => BEH.staleSweptAtBoot === true,
      () => /unref\?\.\(\)/.test(RSRC) || /unref\(\)/.test(RSRC),
      () => ({ 行为腿S06: BEH.staleSweptAtBoot, 取数面: 'git show HEAD:server/src/services/ReportService.ts' }));
    // 判据 4（字面腿自己也得有牙）：把 unref 写法换掉，同一条字面判据必须转假——S-11 不是恒真摆设。
    // 变异面必须覆盖**全部**出现处：ReportService 里有两枚定时器（清扫 + 空闲回收），只摘第一处
    // 会让第二处把字面腿照旧撑成真，那是「反证没落地」而不是「判据有牙」（批㉘ 首轮实测即此红）。
    const legL = (src: string): boolean => /unref\?\.\(\)/.test(src) || /unref\(\)/.test(src);
    const unrefHits = (RSRC.match(/unref\?\.\(\)|unref\(\)/g) ?? []).length;
    const mutated = RSRC.replace(/unref\?\.\(\)/g, 'unref && void 0').replace(/unref\(\)/g, 'unref && void 0');
    ok('S-11b 反证：unref 写法全部摘掉后，S-11 的字面腿必须转红（原物为真、改写串确实不同、出现次数如实报出）',
      mutated !== RSRC && unrefHits >= 1 && legL(RSRC) === true && legL(mutated) === false,
      { unref出现次数: unrefHits, 命中原物: legL(RSRC), 命中改写后: legL(mutated) });
  }
  ok('S-12 有牙证明：两条反证都真的把行为打断过（N-01 摘接线后过期令牌活下来、N-03 无条件删后重试下载失败），'
    + '且两处源码逐字节还原——上面 S-01~S-11 不是恒绿摆设',
    BEH.nWiringControl && BEH.nRestore1 && BEH.nDoneSentControl && BEH.nRestore2, {
      nWiringControl: BEH.nWiringControl, nRestore1: BEH.nRestore1,
      nDoneSentControl: BEH.nDoneSentControl, nRestore2: BEH.nRestore2,
    });
}

// =====================================================================
// 收口
// =====================================================================
child?.kill();
mock.close();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }

const summary = `T02144 导出令牌临时文件回收门：PASS ${pass} / FAIL ${fail}\n` + lines.join('\n');
writeGateResults(OUT_DIR, 't02144-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}\nDATA_DIR=${DATA_DIR}`);
process.exit(fail === 0 ? 0 : 1);
