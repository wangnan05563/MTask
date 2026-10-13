/**
 * T02095 门：启动会 PPT 前置校验（PRD-项目启动会PPT生成 §3.2 FR-2）落地验证。
 *
 * 断言：
 *   S 组 源码守卫：零 AI 依赖（FR-2.3）、无写库/无新表、阈值与硬阻塞口径（FR-2.4）、
 *                  工作量来源判定复用估算汇总 countedKeys、端点注册在 /:id 之前。
 *   R 组 隔离实例（生产库副本，只读）：
 *     R-04~R-08 七项 count 与实际端点逐条相等（PRD 验收 3）；
 *     R-09~R-10 P3 status 与独立复算的日期填充率一致、warn 文案点名缺日期条数；
 *     R-11 连续两次调用逐字一致（只读幂等，FR-2.3）；
 *     R-12 workloadSource 与 `/api/estimates` 汇总 countedKeys 同判；
 *     R-13~R-15 空项目 P1/P2/P3 全 fail 且 blocked=true + 三条深链，P4~P7 只 warn（验收 2）；
 *     R-16 缺 projectId → 400 统一错误口径；R-17 真实项目不被硬阻塞。
 *
 * 隔离纪律（skill 红线 8）：库副本、端口、临时目录全部临时的，不碰生产数据目录，跑完 kill + 回收。
 * 用法（better-sqlite3 需与当前 Node ABI 匹配；不匹配时用 scripts/vendor/bs137.tar.gz 恢复，
 *   与 T02126/T02131 同口径）：node node_modules/tsx/dist/cli.mjs scripts/verify-t02095-kickoff-preflight.mts
 * 环境变量：`T02095_PORT`（默认随机 39600+rand300）。
 * 断言输出落 .workbuddy/t02095-gate-results.txt 与 t02095-preflight-payload.json（GBK 控制台乱码，以文件为权威）。
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02095_PORT ?? 39_600 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02095-preflight-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const FIVE_PID = '95f31a46-92f6-4046-8cb6-ee3c4e228a44'; // mtask五期（/api/projects 实测取号）

const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

// ---------- S 组：源码/契约守卫 ----------
const svcSrc = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8');
const routeSrc = readFileSync(join(ROOT, 'server', 'src', 'routes', 'plans.ts'), 'utf8');
// 前置校验段的「零 AI 依赖」必须按段断言：大纲段（T02096）与流式段（T02103）后续落在同一文件里，
// 整文件断言会让 FR-2.3 的守卫在合法演进中必然误红——口径与 T02096 的 preflightSrc 一致。
const preflightSrc = svcSrc.slice(svcSrc.indexOf('// ---------- 前置校验'), svcSrc.indexOf('// ---------- 资料采集 Bundle'));
ok('S-01 校验实现零 AI 依赖（FR-2.3 只读、零配额）', !/AIService|askJson|fetch\(/.test(preflightSrc));
ok('S-02 未新增表/未写库（只读聚合，无 INSERT/UPDATE/DELETE）', !/\b(INSERT|UPDATE|DELETE)\b/i.test(svcSrc));
ok('S-03 取数全部复用既有 Service 查询，仅工作空间一处直查 projects', (svcSrc.match(/getDb\(\)/g) ?? []).length === 1);
ok('S-04 端点注册在 /:id 之前且走 wrap 统一错误口径',
  routeSrc.indexOf('/kickoff-preflight') < routeSrc.indexOf("planApi.patch('/:id'") && /planApi\.get\('\/kickoff-preflight'/.test(routeSrc));
ok('S-05 硬阻塞口径 = P1∧P2∧P3 全 fail（FR-2.4，非任意缺失即阻塞）',
  /hardItems\.length > 0 && missingHard\.length === hardItems\.length/.test(svcSrc) && /key: 'P1'[\s\S]*hard: true/.test(svcSrc));
ok('S-06 阈值抄 PRD FR-2.1 且单源常量化', /MIN_REQUIREMENTS = 3/.test(svcSrc) && /MIN_DATE_FILL_RATE = 0\.6/.test(svcSrc) && /MIN_WORKLOAD_FILL_RATE = 0\.8/.test(svcSrc));
ok('S-07 工作量来源判定复用估算汇总 countedKeys（不另数一遍）', /estimatesSnapshot\(projectId\)\.summary/.test(svcSrc) && /countedKeys\.length > 0/.test(svcSrc));
ok('S-08 每条 warn/fail 都带「怎么补」文案与深链字段', /note:/.test(svcSrc) && /deepLink: 'plan\?menu=prd'/.test(svcSrc) && /deepLink: 'report\?card=prd-import'/.test(svcSrc));

// ---------- R 组：隔离实例（生产库副本，只读） ----------
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
const copyPath = join(DATA_DIR, 'mtask.db');
{
  const Database = (await import('better-sqlite3')).default;
  const src = new Database(prodDb, { readonly: true });
  await src.backup(copyPath); // backup() 首参是路径字符串（传 Database 实例会 TypeError）
  src.close();
}
ok('R-00a 生产库副本已生成', existsSync(copyPath));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok && (await res.json().catch(() => null))?.service === 'mtask-server') return true;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}
async function get<T = any>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path);
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

if (!(await waitUp())) {
  ok('R-00 隔离实例启动', false, serverLog.join('').slice(-500));
} else {
  ok('R-00 隔离实例启动', true);
  const pf = await get<any>(`/plans/kickoff-preflight?projectId=${FIVE_PID}`);
  ok('R-01 端点 200 且返回固定结构', pf.status === 200 && pf.body && Array.isArray(pf.body.items) && typeof pf.body.blocked === 'boolean',
    { status: pf.status, keys: Object.keys(pf.body ?? {}) });
  const items: any[] = pf.body?.items ?? [];
  ok('R-02 七项齐备且顺序 P1~P7', items.length === 7 && items.map((i) => i.key).join('') === 'P1P2P3P4P5P6P7', items.map((i) => i.key));
  ok('R-03 每项都有 label/count/status/note/deepLink/hard',
    items.every((i) => i.label && typeof i.count === 'number' && ['ok', 'warn', 'fail'].includes(i.status) && i.note && i.deepLink && typeof i.hard === 'boolean'),
    items.find((i) => !i.label || !i.note || !i.deepLink));

  // 验收 3：条数与实际端点一致
  const docs = await get<any[]>(`/plans/prd-docs?projectId=${FIVE_PID}`);
  const reqs = await get<any[]>(`/plans/prd-requirements?projectId=${FIVE_PID}`);
  const plans = await get<any[]>(`/plans?projectId=${FIVE_PID}`);
  const cases = await get<any>(`/plans/test-cases/stats?projectId=${FIVE_PID}`);
  const by = (k: string) => items.find((i) => i.key === k)?.count;
  ok('R-04 P1 条数 = /prd-docs 实际条数', by('P1') === (docs.body ?? []).length, { preflight: by('P1'), api: (docs.body ?? []).length });
  ok('R-05 P2 条数 = /prd-requirements 实际条数', by('P2') === (reqs.body ?? []).length, { preflight: by('P2'), api: (reqs.body ?? []).length });
  ok('R-06 P3 条数 = /plans 未归档实际条数', by('P3') === (plans.body ?? []).length, { preflight: by('P3'), api: (plans.body ?? []).length });
  ok('R-07 P4 条数 = P3 中 kind=milestone 行数', by('P4') === (plans.body ?? []).filter((p: any) => p.kind === 'milestone').length,
    { preflight: by('P4') });
  ok('R-08 P5 条数 = /test-cases/stats.total', by('P5') === cases.body?.total, { preflight: by('P5'), api: cases.body?.total });

  // 日期填充率口径独立复算，status 必须与之一致
  const rows: any[] = plans.body ?? [];
  const dated = rows.filter((p) => !!String(p.start_date ?? '').trim() && !!String(p.end_date ?? '').trim()).length;
  const p3 = items.find((i) => i.key === 'P3');
  const expectP3 = rows.length < 3 ? 'fail' : dated / Math.max(rows.length, 1) < 0.6 ? 'warn' : 'ok';
  ok('R-09 P3 status 与独立复算的日期填充率一致', p3?.status === expectP3, { actual: p3?.status, expect: expectP3, dated, total: rows.length });
  ok('R-10 P3 文案点名缺日期的条数', expectP3 !== 'warn' || /缺起止日期|无排期/.test(String(p3?.note)), p3?.note);

  // 幂等 + 只读：两次调用完全一致（无任何写入/AI 抖动）
  const pf2 = await get<any>(`/plans/kickoff-preflight?projectId=${FIVE_PID}`);
  ok('R-11 连续两次调用结果逐字一致（只读幂等）', JSON.stringify(pf.body) === JSON.stringify(pf2.body));

  // 工作量来源判定与估算侧汇总一致
  const est = await get<any>(`/estimates?projectId=${FIVE_PID}`);
  const counted = est.body?.summary?.countedKeys?.length;
  ok('R-12 workloadSource 与估算汇总 countedKeys 同判',
    est.status === 200 && typeof counted === 'number' && pf.body?.workloadSource === (counted > 0 ? 'estimate' : 'duration'),
    { estStatus: est.status, workloadSource: pf.body?.workloadSource, counted });

  // 验收 2：空项目硬阻塞
  const np = await post<any>('/projects', { name: `T02095 冒烟空项目 ${Date.now()}` });
  const npId = np.body?.id ?? np.body?.project?.id;
  const blockedPf = await get<any>(`/plans/kickoff-preflight?projectId=${npId}`);
  const bi: any[] = blockedPf.body?.items ?? [];
  ok('R-13 空项目 P1/P2/P3 均 fail 且点名进 missingHard',
    blockedPf.status === 200 && ['P1', 'P2', 'P3'].every((k) => bi.find((i) => i.key === k)?.status === 'fail')
    && blockedPf.body?.missingHard?.join('') === 'P1P2P3', blockedPf.body?.missingHard);
  ok('R-14 空项目 blocked=true 且 3 条硬缺失各带深链',
    blockedPf.body?.blocked === true && bi.filter((i) => i.hard).every((i) => !!i.deepLink && !!i.note));
  ok('R-15 空项目 P4~P7 为 warn（可选/降级项不阻塞）',
    bi.filter((i) => !i.hard).every((i) => i.status === 'warn'), bi.filter((i) => !i.hard).map((i) => [i.key, i.status]));

  // projectId 缺失走统一 400 口径
  const bad = await get('/plans/kickoff-preflight');
  ok('R-16 缺 projectId → 400 + { error }', bad.status === 400 && !!bad.body?.error, bad);

  // 真实项目不应被阻塞
  ok('R-17 mtask五期不被硬阻塞', pf.body?.blocked === false);
  writeFileSync(join(ROOT, '.workbuddy', 't02095-preflight-payload.json'), JSON.stringify({ 五期: pf.body, 空项目: blockedPf.body }, null, 2), 'utf8');
}

async function post<T = any>(path: string, json: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
const summary = `T02095 前置校验门（kickoff-preflight）：PASS=${pass} FAIL=${fail}\n` + lines.join('\n') + '\n';
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeFileSync(join(ROOT, '.workbuddy', 't02095-gate-results.txt'), summary, 'utf8');
for (let i = 0; i < 5; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
}
process.exit(fail === 0 ? 0 : 1);
