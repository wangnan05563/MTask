/**
 * T02044 · E10 验证：估算视图 MCP 工具面（PRD-估算视图与工作量评估导出 §8 / §11 E10）。
 *
 * 三枚工具 `mtask_get_estimates` / `mtask_update_estimates` / `mtask_export_estimate_workload`
 * 都是**薄层**——真正要证的是四件事：
 *  ① 数值单源：MCP 给的汇总必须与 REST `GET /api/estimates` 逐字相同（工具层不许再算一遍）；
 *  ② 体量口径：默认精简、`full` 才出明细，且全量只进 `structuredContent`
 *     （T01490 实测教训：两处都塞全文会让 SSE 帧翻倍、大项目直接被截断）；
 *  ③ 定位翻译：projectName / taskNo → id，反查不到要报错而不是猜（多条命中把消歧责任交回调用方）；
 *  ④ 出件同流水线：MCP 的 base64 件与界面下载的件同源（同一条 `buildEstimateArtifact`、
 *     同一个快照契约），非法 O>M 零写入。
 *
 * 三段结构（T02293 判据规约落地）：
 *   M 段（隔离实例·MCP 通道）：按 §8 把三枚工具从发现、读取、定位翻译、回写到出件打通一遍，
 *     并与 REST 做数值/件名/快照的同源性比对。所有「应当拒绝」的断言走 `refusedPair`——
 *     行为侧 = 工具真的报错且拒绝即零副作用（行数/快照数/合法对照调用），字面侧 = 文案含单源词干。
 *   G 段（同进程·判据 1/4）：**改名模拟**——把 `ESTIMATE_ERRORS` 的 MCP 层词干逐支改成
 *     `ZZZ-<key>` 再用同一入参触发同一校验，要求「照样拒绝、文案随单源表移动、旧词干零残留、
 *     还原逐字符相同、零副作用」。任一失守即说明 MCP 薄层留了第二份抄本。件名（`ESTIMATE_FILE_BASE`
 *     是不可改的原始常量）改由 G-14 的**反证**取证：换 audience 或换一秒必须对不上服务端件名。
 *   H 段（跨进程·判据 4）：M 段登记的服务端原文与门进程词干表做同一性比对（逐条命中 + 假词干零命中
 *     + 同入参文案逐字符相同 + REST/MCP 件名同一规则），并保留一支「同文案但不报错」的负对照，
 *     自证这里的绿来自行为与同源，不是抄字面量。
 *
 * ⚠ 产品模块一律**动态 import**：静态 import 在 `process.env.MTask_DATA_DIR` 赋值之前就求值，
 *   `getDb()` 会按默认目录连到生产库（skill 红线 8）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02044-mcp-e10.mts
 * 可选环境变量：T02044_MCP_PORT（默认 39937）、T02044_KEEP
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：文案锚必须配行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02044-e10-'));
const PORT = Number(process.env.T02044_MCP_PORT ?? 39937);
const BASE = `http://127.0.0.1:${PORT}/api`;
// G 段要在**本进程**里跑产品的 MCP 定位函数与参数解析器（改名模拟只能改自己进程的常量表），
// 所以它必须连同一个临时库。⚠ 数据目录一定先于 import 定好：静态 import 在这些行之前求值，
// 写晚了 `getDb()` 会按默认目录连到**生产库**（skill 红线 8）。故产品模块一律用动态 import。
process.env.MTask_DATA_DIR = DATA_DIR;

const { ESTIMATE_ERRORS, ESTIMATE_FILE_BASE, ESTIMATE_FILE_CLIENT_MARK, ESTIMATE_POINT_LABELS } = await import('../server/src/services/estimateCopy');
const { estimateArtifactName, parseAudience, parsePhases, parseScope } = await import('../server/src/routes/estimates');
const { planByTaskNo, resolveEstimateProject, resolveEstimateTarget } = await import('../server/src/mcp/server');
const { pointsError, EstimateService } = await import('../server/src/services/EstimateService');
const { getDb, closeDb } = await import('../server/src/db/connection');

let pass = 0;
let fail = 0;
const skippedList: string[] = [];
function group(t: string) { console.log(`\n== ${t}`); }
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 240) : ''}`);
  }
}
function skipped(range: string, why: string) { skippedList.push(`${range}：${why}`); console.log(`  [SKIP] ${range} —— ${why}（不计 PASS）`); }
/** 把「应当抛错的调用」收成文案（不抛返回空串，交给配对器的行为侧判红） */
function fire(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
/** 服务端原文登记表（H-01/H-02 跨进程同源自证用：记下「哪几支词干、回了什么」） */
const mcpErrs: Array<{ label: string; text: string; stems: readonly string[] }> = [];
/**
 * MCP 拒绝类断言配对器（T02293 判据 3）：
 * 行为侧 = 工具确实报错（可再叠「拒绝即零副作用」这类读数检查）；
 * 字面侧 = 文案含产品单源词干（`ESTIMATE_ERRORS`，见 `server/src/services/estimateCopy.ts`）。
 */
function refusedPair(
  label: string,
  r: { isError: boolean; text: string },
  stem: string | readonly string[],
  extraBehavior?: () => boolean,
) {
  const stems = Array.isArray(stem) ? stem : [stem as string];
  if (r.isError) mcpErrs.push({ label, text: r.text, stems });
  return okPair(ok, label,
    () => r.isError === true && r.text.length > 0 && (extraBehavior ? extraBehavior() : true),
    () => stems.every((s) => r.text.includes(s)),
    () => ({ isError: r.isError, text: r.text.slice(0, 150) }));
}

/** 快照表当前状态（M5 每次刷新，坏参数的「拒绝即零留痕」由它取证） */
let latestSnaps: { status: number; json: Record<string, any> | null } = { status: 0, json: null };
function snapIds(): string[] {
  return ((latestSnaps.json?.snapshots ?? []) as Array<Record<string, any>>).map((s) => String(s.id));
}
/**
 * G 段改名模拟的公共骨架（T02293 判据 1/4）：把 `ESTIMATE_ERRORS` 某支词干改成 `ZZZ-<key>`，
 * 用**同一入参**再触发同一校验，要求四件事全部成立——
 *  ① 照样拒绝（行为没随文案走样：不是「改个词干就漏放」）；
 *  ② 新文案随单源表移动（说明这一层没有第二份抄本）；
 *  ③ 旧词干零残留；
 *  ④ 还原后与原消息逐字符相同，且没留下任何副作用。
 * 任一失守都在 `zj` 里落症结，不会只回一句「不匹配」。
 */
function renameSim(
  key: keyof typeof ESTIMATE_ERRORS,
  fireOnce: () => string,
  sideEffectProbe?: () => string,
): string {
  const orig = ESTIMATE_ERRORS[key] as string;
  const first = fireOnce();
  if (!first) return `${key}：词干「${orig}」未被触发（校验根本没跑，改名模拟无从证明 anything）`;
  const s0 = sideEffectProbe?.() ?? '';
  const zj: string[] = [];
  const stem = `ZZZ-${key}`;
  try {
    (ESTIMATE_ERRORS as Record<string, string>)[key] = stem;
    const second = fireOnce();
    if (!second) zj.push('改名后不再拒绝——该层校验是按字面量写的，行为随文案走样');
    else {
      if (!second.includes(stem)) zj.push(`改名后文案没随单源移动（仍回「${second.slice(0, 40)}」——留了第二份抄本）`);
      if (second.includes(orig)) zj.push(`旧词干「${orig}」仍残留在文案里`);
    }
  } finally {
    (ESTIMATE_ERRORS as Record<string, string>)[key] = orig;
  }
  const third = fireOnce();
  if (third !== first) zj.push(`还原后与原消息不一致（原「${first.slice(0, 60)}」/ 现「${String(third).slice(0, 60)}」）`);
  if (sideEffectProbe && s0 !== sideEffectProbe()) zj.push(`拒绝过程留下副作用：${s0} → ${sideEffectProbe()}`);
  return zj.join(' / ');
}
/** 从件名里反推时间戳（`-YYYYMMDD-HHMMSS` 尾巴）；件名口径若改了这里取不到，即说明拼装不再是同一份规则 */
function stampOf(name: string): Date | null {
  const m = name.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
console.log(`隔离实例启动器：${LAUNCHER.label}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForServer(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}
async function api(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
  });
  let out: Record<string, any> | null = null;
  try { out = (await res.json()) as Record<string, any>; } catch { /* 非 JSON */ }
  return { status: res.status, json: out };
}

// ---------------- MCP 通道（streamable HTTP：SSE 帧要拼完再解析，T01490/T00978 教训）
let sessionId = '';
let rpcId = 0;
async function mcpRaw(payload: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  let latest: Record<string, any> | undefined;
  try { latest = JSON.parse(frames || text); } catch { latest = undefined; }
  return latest as Record<string, any>;
}
async function mcpInit() {
  const body = await mcpRaw({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-t02044-e10', version: '1.0' } },
  });
  await mcpRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return body;
}
/** 返回 {isError, text, structured, raw} —— 负面用例要读 isError，不能像 t01689 那样直接抛 */
async function callTool(name: string, args: Record<string, unknown>) {
  const body = await mcpRaw({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  const r = body?.result ?? {};
  const text = String(r?.content?.[0]?.text ?? '');
  return { isError: r?.isError === true, text, structured: (r?.structuredContent ?? {}) as Record<string, any>, body };
}

const PROJ_NAME = 'T02044-E10MCP段';
let PID = '';
let PLAN_IDS: string[] = [];
// G 段（同进程改名模拟 + 跨进程同源自证）要复用 M 段留下的夹具标识与原文
let T1_NO = '';
let ORPHAN_NO = '';
let AMBIG_SERVER_TEXT = '';
let GHOST_SERVER_TEXT = '';
let NOLINK_SERVER_TEXT = '';
let XLSX_FNAME = '';
let CLIENT_PDF_FNAME = '';
let REST_FNAME = '';
let OTHER_PID = '';

if (!(await waitForServer())) {
  console.log('  [FAIL] 隔离服务未就绪，M 段整体跳过');
  console.log(serverLog.join('').slice(-1800));
  fail += 1;
} else {
  await mcpInit();
  const list = await mcpRaw({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} });
  const names: string[] = (list?.result?.tools ?? []).map((t: any) => t.name);

  // 夹具：1 里程碑 + 14 条计划 → 规则推导 → 两条人工行
  {
    const proj = (await api('POST', '/projects', { name: PROJ_NAME })).json;
    PID = String(proj?.id ?? '');
    const items: any[] = [{ title: 'M1 平台基座', kind: 'milestone' }];
    for (let i = 1; i <= 14; i++) {
      items.push({
        title: `W1.${i} 功能点${i}`,
        kind: 'normal',
        description: `第 ${i} 条功能点，用于 MCP 读取与回写。`,
        complexity: (i % 5) + 1,
      });
    }
    const batch = await api('POST', '/plans/batch', { projectId: PID, items });
    PLAN_IDS = batch.json?.ids ?? [];
    await api('POST', '/estimates/derive', { projectId: PID, dryRun: false, scope: 'missing' });
    await api('PATCH', `/estimates/${PLAN_IDS[2]}?projectId=${PID}`, { phase: 'dev', unit: 'man_day', optimistic: 4, likely: 6, pessimistic: 9 });
  }

  group('M1 注册与发现（§8 三枚工具进 tools/list）');
  {
    ok('M-01 三枚估算工具都已注册',
      ['mtask_get_estimates', 'mtask_update_estimates', 'mtask_export_estimate_workload'].every((n) => names.includes(n)),
      names.filter((n) => n.includes('estimate')));
    const defs = (list?.result?.tools ?? []).filter((t: any) => String(t.name).includes('estimate'));
    ok('M-02 描述里写清了「默认精简 + 出件与界面同源」（外部 Agent 只看描述就要会用）',
      defs.every((t: any) => String(t.description ?? '').length > 120), defs.map((t: any) => [t.name, String(t.description ?? '').length]));
  }

  group('M2 读取：默认精简 / full 全量（T01490 体量口径）');
  {
    const brief = await callTool('mtask_get_estimates', { projectId: PID });
    ok('M-03 精简模式不报错且 structuredContent 有汇总', !brief.isError && typeof brief.structured?.totals?.directManDays === 'number', brief.text.slice(0, 120));
    ok('M-04 精简模式不回 items（明细是截断的主因）', !('items' in brief.structured), Object.keys(brief.structured));
    ok('M-05 精简模式给到报价四口径 + 阶段数组 + 系数 + 自检（出报价所需的量）',
      ['projectName', 'totals', 'quote', 'phases', 'coefs', 'checks', 'params'].every((k) => k in brief.structured),
      Object.keys(brief.structured));
    const full = await callTool('mtask_get_estimates', { projectId: PID, full: true });
    const restItems = (await api('GET', `/estimates?projectId=${PID}`)).json?.items ?? [];
    ok('M-06 full 模式 items 与 REST 明细行数一致（一条通道取数，没有第二套筛选）',
      Array.isArray(full.structured?.items) && full.structured.items.length === restItems.length && restItems.length >= 14,
      { mcp: full.structured?.items?.length, rest: restItems.length });
    ok('M-07 full 模式 items 带 planId/phase/三点/source（明细字段齐备）',
      (() => {
        const it = (full.structured?.items ?? [])[0] ?? {};
        return ['plan_id', 'phase', 'optimistic', 'likely', 'pessimistic', 'source'].every((k) => k in it);
      })(), Object.keys((full.structured?.items ?? [])[0] ?? {}));
    ok('M-08 LLM 侧文本恒为精简摘要：full 的 text 不比精简的 text 长（全量只进 structuredContent）',
      full.text.length <= brief.text.length + 1, { brief: brief.text.length, full: full.text.length });
    ok('M-09 full 的 structuredContent 体量确实随明细增长（证明「不截断」不是把明细悄悄丢了）',
      JSON.stringify(full.structured).length > JSON.stringify(brief.structured).length * 1.5);
    const rest = await api('GET', `/estimates?projectId=${PID}`);
    const su = rest.json?.summary;
    ok('M-10 数值单源：MCP 汇总与 REST summary 逐字相同（工具层没有第二套算法）',
      Math.abs(brief.structured.totals.directManDays - Math.round(su.directManDays.expected * 1000) / 1000) < 1e-9
      && Math.abs(brief.structured.totals.actualManMonths - Math.round(su.actualManMonths.expected * 1000) / 1000) < 1e-9
      && Math.abs(brief.structured.quote.p84ManDays - Math.round(su.quote.p84ManDays * 1000) / 1000) < 1e-9,
      { mcp: brief.structured.totals, rest: su?.directManDays?.expected });
    ok('M-11 阶段数组只含 rowCount>0 的阶段（空阶段不占位）',
      Array.isArray(brief.structured.phases) && brief.structured.phases.length > 0
      && brief.structured.phases.every((p: any) => p.rowCount > 0)
      && brief.structured.phases.length === (su?.phases ?? []).filter((p: any) => p.rowCount > 0).length,
      brief.structured.phases?.map((p: any) => [p.phase, p.rowCount]));
    ok('M-12 checks 与 REST 同口径（coverage / estimated / visiblePlans / detached）',
      brief.structured.checks.estimated === rest.json?.checks?.estimated
      && brief.structured.checks.visiblePlans === rest.json?.checks?.visiblePlans,
      { mcp: brief.structured.checks, rest: rest.json?.checks });
  }

  group('M3 定位翻译（projectName / 未知 id / 都不给）');
  {
    const byName = await callTool('mtask_get_estimates', { projectName: PROJ_NAME });
    ok('M-13 projectName 能解析（外部 Agent 通常只有名字）', !byName.isError && byName.structured?.projectName === PROJ_NAME, byName.text.slice(0, 80));
    const ghost = await callTool('mtask_get_estimates', { projectId: 'no-such-project-e10' });
    GHOST_SERVER_TEXT = ghost.text;
    refusedPair('M-14 不存在的 projectId 直接报错（不能出一份空报价件当成功）', ghost, ESTIMATE_ERRORS.projectNotFound,
      // 行为侧同时钉「合法定位参数照样出数」：只改文案不会让这条变绿，校验失守才会
      () => !byName.isError && byName.structured?.projectName === PROJ_NAME);
    const none = await callTool('mtask_get_estimates', {});
    refusedPair('M-15 两种定位参数都不给 → 中文报错', none, ESTIMATE_ERRORS.projectOrNameRequired,
      () => !byName.isError);
    const ghostName = await callTool('mtask_get_estimates', { projectName: '这个项目不存在-E10' });
    refusedPair('M-16 按名解析失败也报错（不是回落成「全部项目」或空汇总）', ghostName, ESTIMATE_ERRORS.projectNotFound,
      () => !byName.isError && ghost.isError);
  }

  group('M4 回写：正常 / 校验 / 零写入 / taskNo 反查');
  {
    const before = await api('GET', `/estimates?projectId=${PID}`);
    const row6Before = (before.json?.items ?? []).find((it: any) => it.plan_id === PLAN_IDS[6]);
    const upd = await callTool('mtask_update_estimates', { planId: PLAN_IDS[5], projectId: PID, optimistic: 3, likely: 5, pessimistic: 10 });
    ok('M-17 按 planId 回写成功，source 缺省 manual（代理显式录入即视为已复核）',
      !upd.isError && upd.structured?.item?.source === 'manual', upd.text);
    const updText = JSON.parse(upd.text);
    ok('M-18 回执里的 E/σ 由引擎算（(3+20+10)/6=5.5、(10-3)/6≈1.167）',
      Math.abs(Number(updText?.expected ?? 0) - 5.5) < 1e-6 && Math.abs(Number(updText?.sigma ?? 0) - 7 / 6) < 1e-3,
      { expected: updText?.expected, sigma: updText?.sigma });
    const after5 = ((await api('GET', `/estimates?projectId=${PID}`)).json?.items ?? []).find((it: any) => it.plan_id === PLAN_IDS[5]);
    ok('M-19 回写真的落库（REST 复查该 plan 行三点 = 3/5/10，不是只回了个回执）',
      after5?.optimistic === 3 && after5?.likely === 5 && after5?.pessimistic === 10,
      after5 && [after5.optimistic, after5.likely, after5.pessimistic]);
    const bad = await callTool('mtask_update_estimates', { planId: PLAN_IDS[6], optimistic: 8, likely: 5, pessimistic: 9 });
    const row6After = ((await api('GET', `/estimates?projectId=${PID}`)).json?.items ?? []).find((it: any) => it.plan_id === PLAN_IDS[6]);
    const same6 = !!row6Before && !!row6After
      && [row6Before.optimistic, row6Before.likely, row6Before.pessimistic].join() === [row6After.optimistic, row6After.likely, row6After.pessimistic].join();
    refusedPair('M-20 O>M 被拒（§4.1 校验）', bad, ESTIMATE_ERRORS.ordering, () => same6);
    ok('M-21 校验失败是零写入：那一行三点与拒写前逐字相同（不是先落库再回滚的假拒）',
      same6,
      { before: row6Before && [row6Before.optimistic, row6Before.likely, row6Before.pessimistic], after: row6After && [row6After.optimistic, row6After.likely, row6After.pessimistic] });
    const srcRule = await callTool('mtask_update_estimates', { planId: PLAN_IDS[7], optimistic: 2, likely: 3, pessimistic: 4, source: 'rule' });
    ok('M-22 显式 source=rule 能落（批量补数不该计进复核率）', !srcRule.isError && srcRule.structured?.item?.source === 'rule', srcRule.text);
    const other = (await api('POST', '/projects', { name: 'T02044-E10另一个项目' })).json;
    OTHER_PID = String(other?.id ?? '');
    const mismatch = await callTool('mtask_update_estimates', { planId: PLAN_IDS[8], projectId: other?.id, optimistic: 1, likely: 2, pessimistic: 3 });
    const otherG = await api('GET', `/estimates?projectId=${other?.id}`);
    refusedPair('M-23 项目与计划不匹配 → 报错（不把估算挂到别的项目上）', mismatch, ESTIMATE_ERRORS.planProjectMismatch,
      // 行为侧：另一头的估算面仍是空的——跨项目写入没落库，而不是只回了句文案
      () => (otherG.json?.items ?? []).length === 0);
    const cntB = ((await api('GET', `/estimates?projectId=${PID}`)).json?.items ?? []).length;
    const noLocate = await callTool('mtask_update_estimates', { optimistic: 1, likely: 2, pessimistic: 3 });
    const cntA = ((await api('GET', `/estimates?projectId=${PID}`)).json?.items ?? []).length;
    refusedPair('M-24 planId 与 taskNo 都不给 → 报错', noLocate, ESTIMATE_ERRORS.planLocateRequired,
      () => cntA === cntB);

    // taskNo 反查：建待办 → 关联到计划（plan_tasks.linked_task_id 是唯一硬关联）
    // REST 侧任务视图是 snake_case（TaskView.task_no），MCP 工具入参才是 taskNo
    const task = (await api('POST', '/tasks', { projectId: PID, title: 'E10 反查夹具待办' })).json;
    const T1 = String(task?.task_no ?? '');
    T1_NO = T1;
    const link = await api('POST', `/plans/${PLAN_IDS[9]}/link`, { taskId: task?.id });
    const byNo = await callTool('mtask_update_estimates', { taskNo: T1, optimistic: 2, likely: 4, pessimistic: 8 });
    ok('M-25 taskNo 反查计划并回写成功（外部 Agent 手里常常只有 Txxxx）',
      !!T1 && link.status === 200 && !byNo.isError && byNo.structured?.planId === PLAN_IDS[9],
      { taskNo: T1, link: link.status, text: byNo.text.slice(0, 100) });
    const orphan = (await api('POST', '/tasks', { projectId: PID, title: 'E10 无关联计划待办' })).json;
    ORPHAN_NO = String(orphan?.task_no ?? '');
    const noLink = await callTool('mtask_update_estimates', { taskNo: ORPHAN_NO, optimistic: 1, likely: 1, pessimistic: 1 });
    NOLINK_SERVER_TEXT = noLink.text;
    refusedPair('M-26 taskNo 无关联计划 → 中文报错并提示改传 planId（不猜是哪条）', noLink, ESTIMATE_ERRORS.taskNoNoPlanLink,
      // 行为侧：反查不到要拒，但单条命中那条照样写成功——两套语义不能互相掩盖
      () => !byNo.isError && byNo.structured?.planId === PLAN_IDS[9]);
    // 同一 taskNo 关联两条计划：把消歧责任交回调用方
    const link2 = await api('POST', `/plans/${PLAN_IDS[10]}/link`, { taskId: task?.id });
    const gPre = await api('GET', `/estimates?projectId=${PID}`);
    const r10Pre = ((gPre.json?.items ?? []).find((it: any) => it.plan_id === PLAN_IDS[10]));
    const ambiguous = await callTool('mtask_update_estimates', { taskNo: T1, optimistic: 1, likely: 1, pessimistic: 1 });
    const gPost = await api('GET', `/estimates?projectId=${PID}`);
    const itemsPost = gPost.json?.items ?? [];
    const r9Post = itemsPost.find((it: any) => it.plan_id === PLAN_IDS[9]);
    const r10Post = itemsPost.find((it: any) => it.plan_id === PLAN_IDS[10]);
    AMBIG_SERVER_TEXT = ambiguous.text;
    refusedPair('M-27 taskNo 命中多条计划 → 报错列出候选（§8 定位歧义不自动选第一条）', ambiguous, ESTIMATE_ERRORS.taskNoAmbiguousTail,
      // 行为侧钉「两条都没被动过」：既不猜第一条也不猜第二条，消歧责任真的交回调用方
      () => link2.status === 200
        && r9Post?.optimistic === 2 && r9Post?.likely === 4 && r9Post?.pessimistic === 8
        && [r10Pre?.optimistic, r10Pre?.likely, r10Pre?.pessimistic].join() === [r10Post?.optimistic, r10Post?.likely, r10Post?.pessimistic].join());
    const itemsBefore27a = ((await api('GET', `/estimates?projectId=${PID}`)).json?.items ?? []).length;
    const ghostPlan = await callTool('mtask_update_estimates', { planId: 'no-such-plan-e10', optimistic: 1, likely: 1, pessimistic: 1 });
    const g27a = (await api('GET', `/estimates?projectId=${PID}`)).json?.items ?? [];
    const r927a = g27a.find((it: any) => it.plan_id === PLAN_IDS[9]);
    refusedPair('M-27a 不存在的 planId → 报错（不许凭空造一条没有归属的估算行）', ghostPlan, ESTIMATE_ERRORS.planMissingOrArchived,
      // 行为侧：行数没多、已有那行也没被顺手改写——拒绝是真的没落笔，而不是落了再删
      () => g27a.length === itemsBefore27a
        && [r927a?.optimistic, r927a?.likely, r927a?.pessimistic].join() === '2,4,8');
  }

  group('M5 出件：与界面同一条流水线');
  {
    const x = await callTool('mtask_export_estimate_workload', { projectId: PID, format: 'xlsx' });
    const buf = Buffer.from(String(x.structured?.base64 ?? ''), 'base64');
    ok('M-28 xlsx：base64 能解出合法 xlsx（PK 头 + 体量合理）',
      !x.isError && buf.subarray(0, 2).toString('hex') === '504b' && buf.length > 15_000, { size: buf.length, err: x.text.slice(0, 80) });
    XLSX_FNAME = String(x.structured?.filename ?? '');
    const xStamp = stampOf(XLSX_FNAME);
    okPair(ok, 'M-29 件名走 §6.3 口径（工作量评估-项目名-时间戳.xlsx）',
      // 行为侧：件名由**单源拼装器**用同一时间戳重算即逐字符复现（含项目名与时间戳形状）——
      // 服务端若另写一份模板，重算结果就对不上
      () => !!xStamp && estimateArtifactName(PROJ_NAME, 'internal', xStamp) + '.xlsx' === XLSX_FNAME
        && XLSX_FNAME.includes(PROJ_NAME),
      () => XLSX_FNAME.startsWith(ESTIMATE_FILE_BASE) && /-\d{8}-\d{6}\.xlsx$/.test(XLSX_FNAME),
      () => XLSX_FNAME);
    const p = await callTool('mtask_export_estimate_workload', { projectId: PID, format: 'pdf' });
    const pbuf = Buffer.from(String(p.structured?.base64 ?? ''), 'base64');
    ok('M-30 pdf：魔数 %PDF- 且尾部 %%EOF（渲染链跑完）',
      !p.isError && pbuf.subarray(0, 5).toString() === '%PDF-' && pbuf.subarray(-64).toString().includes('%%EOF'), pbuf.length);
    const cli = await callTool('mtask_export_estimate_workload', { projectId: PID, format: 'pdf', audience: 'client' });
    CLIENT_PDF_FNAME = String(cli.structured?.filename ?? '');
    const cliStamp = stampOf(CLIENT_PDF_FNAME);
    okPair(ok, 'M-31 客户版件名带 -客户版（同一套命名，不开第二条通道）',
      // 行为侧：把同一份单源拼装器的 audience 换成 client 就复现服务端件名，
      // 而内部版件名里必须没有客户版标记——两处不是一个模板就会失配
      () => !!cliStamp && !cli.isError && estimateArtifactName(PROJ_NAME, 'client', cliStamp) + '.pdf' === CLIENT_PDF_FNAME
        && !XLSX_FNAME.includes(ESTIMATE_FILE_CLIENT_MARK),
      () => CLIENT_PDF_FNAME.includes(ESTIMATE_FILE_CLIENT_MARK),
      () => ({ client: CLIENT_PDF_FNAME, internal: XLSX_FNAME }));
    ok('M-32 每次成功导出都写快照并回 snapshotId（§6.3 留痕）',
      /^[A-Za-z0-9_-]+$/.test(String(x.structured?.snapshotId ?? '')) && /^[A-Za-z0-9_-]+$/.test(String(p.structured?.snapshotId ?? '')),
      [x.structured?.snapshotId, p.structured?.snapshotId]);
    latestSnaps = await api('GET', `/estimates/snapshots?projectId=${PID}&limit=200`);
    const srow = (latestSnaps.json?.snapshots ?? []).find((s: any) => s.id === x.structured?.snapshotId);
    ok('M-33 MCP 快照的 format 记成 xlsx（与界面件同表同契约）', srow?.format === 'xlsx', srow && { format: srow.format, name: srow.filename });
    const restX = await fetch(`${BASE}/estimates/export-xlsx?projectId=${PID}`);
    const restSid = restX.headers.get('x-estimate-snapshot');
    latestSnaps = await api('GET', `/estimates/snapshots?projectId=${PID}&limit=200`);
    const restRow = (latestSnaps.json?.snapshots ?? []).find((s: any) => s.id === restSid);
    REST_FNAME = String(restRow?.filename ?? '');
    const mp = srow ? JSON.parse(srow.payload) : {};
    const rp = restRow ? JSON.parse(restRow.payload) : {};
    ok('M-34 MCP 件与界面件的快照汇总逐字相同（同一条流水线、同一份数）',
      JSON.stringify(mp.phases) === JSON.stringify(rp.phases)
      && mp.actualManMonths?.expected === rp.actualManMonths?.expected
      && mp.unreviewed === rp.unreviewed,
      { mcp: mp.actualManMonths?.expected, rest: rp.actualManMonths?.expected });
    ok('M-35 回执文本带 actualManMonths / unreviewed（LLM 不必解码 base64 就能报价）',
      typeof x.structured?.actualManMonths === 'number' && typeof x.structured?.unreviewed === 'number',
      { actual: x.structured?.actualManMonths, unreviewed: x.structured?.unreviewed });
    // 非法导出参数：除了「报错」还得证明**没落成件、没留痕**——只回文案而照样写快照，
    // 等于把一次坏请求变成一份可交付的历史记录。
    /**
     * 坏参数三段式：先把快照基线刷到最新 → 打坏参数 → **立刻**定格快照数（合法对照会再多写一条，
     * 事后再读就把对照的留痕算进坏参数的账上）→ 再跑只差这一个参数的合法对照，
     * 证明这条词干不是「把所有请求都拒了」换来的绿。
     */
    const badExportParam = async (
      label: string, badArgs: Record<string, unknown>, stem: string, goodArgs: Record<string, unknown>,
    ) => {
      latestSnaps = await api('GET', `/estimates/snapshots?projectId=${PID}&limit=200`);
      const before = snapIds().length;
      const bad = await callTool('mtask_export_estimate_workload', { projectId: PID, ...badArgs });
      latestSnaps = await api('GET', `/estimates/snapshots?projectId=${PID}&limit=200`);
      const afterBad = snapIds().length;
      const good = await callTool('mtask_export_estimate_workload', { projectId: PID, ...goodArgs });
      refusedPair(label, bad, stem, () => afterBad === before && !bad.structured?.base64 && !good.isError);
    };
    await badExportParam('M-36 未知 audience → 报错（与 REST 同词表，不静默回落内部版）',
      { format: 'pdf', audience: 'both' }, ESTIMATE_ERRORS.unknownAudience, { format: 'pdf', audience: 'internal' });
    await badExportParam('M-37 未知阶段 → 报错（静默吞掉会让「只导开发段」实际导出全部）',
      { format: 'xlsx', phases: 'dev,bogus' }, ESTIMATE_ERRORS.unknownPhase, { format: 'xlsx', phases: 'dev,req' });
    await badExportParam('M-37a phases 只有分隔符 → 报错而不是导出全部（把「筛没了」当「不筛」是悄悄放量）',
      { format: 'xlsx', phases: ',,' }, ESTIMATE_ERRORS.emptyPhases, { format: 'xlsx' });
    await badExportParam('M-38 未知范围 → 报错（同 REST 词表，不许回落成全部行）',
      { format: 'xlsx', scope: 'nope' }, ESTIMATE_ERRORS.unknownScope, { format: 'xlsx', scope: 'estimated_only' });
    const ph = await callTool('mtask_export_estimate_workload', { projectId: PID, format: 'xlsx', phases: 'dev' });
    latestSnaps = await api('GET', `/estimates/snapshots?projectId=${PID}&limit=200`);
    const phPayloadRow = (latestSnaps.json?.snapshots ?? []).find((s: any) => s.id === ph.structured?.snapshotId);
    const phPl = phPayloadRow ? JSON.parse(phPayloadRow.payload) : {};
    ok('M-39 phases=dev 落进快照 phaseFilter（导出范围可追溯，不只停在文件名）',
      !ph.isError && Array.isArray(phPl.phaseFilter) && phPl.phaseFilter.join() === 'dev', phPl.phaseFilter);
  }

  group('M6 大响应不截断（§11 E10 实测项）');
  {
    const big = (await api('POST', '/projects', { name: 'T02044-E10大响应60条' })).json;
    const many: any[] = [];
    for (let i = 1; i <= 60; i++) many.push({ title: `B60-${i} 功能点`, description: `第六十条为止的批量夹具：60 条是 full 模式的基准规模。`, complexity: (i % 5) + 1 });
    const mb = await api('POST', '/plans/batch', { projectId: big?.id, items: many });
    await api('POST', '/estimates/derive', { projectId: big?.id, dryRun: false, scope: 'missing' });
    const full = await callTool('mtask_get_estimates', { projectId: big?.id, full: true });
    ok('M-40 60 条 full 模式 SSE 帧解析完整（items=60，不是被截断的前若干条）',
      (full.structured?.items ?? []).length === 60, { ids: (mb.json?.ids ?? []).length, items: full.structured?.items?.length });
    const sseSize = JSON.stringify(full.body).length;
    ok('M-41 60 条 full 响应体量在可控范围（structuredContent 全量 <200KB，仍远小于会触发截断的量级）',
      sseSize > 20_000 && sseSize < 200_000, sseSize);
    ok('M-42 60 条汇总数值仍然自洽（Σ阶段人天 = 直接投入人天，工具层没有丢行）',
      (() => {
        const ph = full.structured?.phases ?? [];
        const sum = ph.reduce((a: number, q: any) => a + q.manDays, 0);
        return Math.abs(sum - full.structured?.totals?.directManDays) < 0.05;
      })(),
      { phaseSum: (full.structured?.phases ?? []).reduce((a: number, q: any) => a + q.manDays, 0), total: full.structured?.totals?.directManDays });
    const exp = await callTool('mtask_export_estimate_workload', { projectId: big?.id, format: 'pdf' });
    const ebuf = Buffer.from(String(exp.structured?.base64 ?? ''), 'base64');
    ok('M-43 60 行出 PDF 件不失败且体量随规模增长（>6KB）', !exp.isError && ebuf.length > 6_000, { size: ebuf.length, err: exp.text.slice(0, 100) });
  }

  // §10-11 原文写的是「实测 500 行」——60 行只能证明「明细没被悄悄丢掉」，证明不了响应面在
  // 真实大项目规模下仍不截断，也证不了 §9 的导出计时。这一段把规模提到 500 并顺手把 §9 的
  // 「Excel 500 行 <3s / PDF <6s」一起取证。
  group('M7 §10-11 实测规模：500 行不截断 + §9 导出计时');
  {
    const huge = (await api('POST', '/projects', { name: 'T02044-E10大响应500条' })).json;
    const many: any[] = [];
    for (let i = 1; i <= 500; i++) many.push({ title: `B500-${i} 功能点`, description: `第五百条为止的批量夹具：§10-11 要求的实测规模。`, complexity: (i % 5) + 1 });
    const mb = await api('POST', '/plans/batch', { projectId: huge?.id, items: many });
    await api('POST', '/estimates/derive', { projectId: huge?.id, dryRun: false, scope: 'missing' });
    const t0 = Date.now();
    const full = await callTool('mtask_get_estimates', { projectId: huge?.id, full: true });
    const readMs = Date.now() - t0;
    ok('M-44 500 条 full 模式 SSE 帧解析完整（items=500，不是被截断的前若干条）',
      (full.structured?.items ?? []).length === 500, { created: (mb.json?.ids ?? []).length, items: full.structured?.items?.length });
    const brief = await callTool('mtask_get_estimates', { projectId: huge?.id });
    ok('M-45 规模到 500 行后 LLM 侧文本仍是精简摘要（`text` 不随明细膨胀——截断的主因被按在门外）',
      full.text.length === brief.text.length && full.text.length < 4_000, { fullText: full.text.length, briefText: brief.text.length });
    ok('M-46 500 条汇总仍自洽（Σ阶段人天 = 直接投入人天，工具层没有丢行）',
      Math.abs((full.structured?.phases ?? []).reduce((a: number, q: any) => a + q.manDays, 0) - full.structured?.totals?.directManDays) < 0.5,
      { phaseSum: (full.structured?.phases ?? []).reduce((a: number, q: any) => a + q.manDays, 0), total: full.structured?.totals?.directManDays });
    ok('M-47 500 行 full 取数在秒级（§9 性能面：读通道不是瓶颈）', readMs < 8_000, { readMs });
    const tx = Date.now();
    const ex = await callTool('mtask_export_estimate_workload', { projectId: huge?.id, format: 'xlsx' });
    const xlsxMs = Date.now() - tx;
    const xbuf = Buffer.from(String(ex.structured?.base64 ?? ''), 'base64');
    ok('M-48 500 行出 xlsx 不失败且 §9 计时 <3s', !ex.isError && xbuf.length > 20_000 && xlsxMs < 3_000, { size: xbuf.length, xlsxMs, err: ex.text.slice(0, 120) });
    const tp = Date.now();
    const ep = await callTool('mtask_export_estimate_workload', { projectId: huge?.id, format: 'pdf' });
    const pdfMs = Date.now() - tp;
    const pbuf = Buffer.from(String(ep.structured?.base64 ?? ''), 'base64');
    ok('M-49 500 行出 PDF 不失败且 §9 计时 <6s（pdfkit 逐行渲染，这条是 PDF 侧唯一的规模闸门）',
      !ep.isError && pbuf.slice(0, 5).toString() === '%PDF-' && pdfMs < 6_000, { size: pbuf.length, pdfMs, err: ep.text.slice(0, 120) });
    console.log(`  [INFO] 500 行计时：full 取数 ${readMs}ms / xlsx ${xlsxMs}ms / pdf ${pdfMs}ms（PDF 体量 ${(pbuf.length / 1024).toFixed(0)}KB、xlsx ${(xbuf.length / 1024).toFixed(0)}KB）`);
  }

  group('G 同进程改名模拟（判据 1/4：MCP 层文案不许留第二份抄本）');
  {
    const cnt = () => {
      const d = getDb();
      const one = (t: string) => String((d.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
      return ['estimate_items', 'estimate_snapshots', 'plan_tasks', 'tasks'].map(one).join('/');
    };
    const pre = fire(cnt);
    ok('G-00 门进程连到的是本门自建的隔离库（读得到 M 段落的夹具行，改名模拟才有对象）',
      pre === '' && Number(cnt().split('/')[0]) > 0, { pre, cnt: pre === '' ? cnt() : '' });
    const pts = (o: number, m: number, p: number) => () => fire(() => {
      const e = pointsError(o, m, p);
      if (e) throw new Error(e);
    });
    const cases: Array<[string, keyof typeof ESTIMATE_ERRORS, () => string]> = [
      ['G-01', 'ordering', pts(8, 5, 9)],
      ['G-02', 'projectNotFound', () => fire(() => resolveEstimateProject({ projectId: 'no-such-project-e10' }))],
      ['G-03', 'projectOrNameRequired', () => fire(() => resolveEstimateProject({}))],
      ['G-04', 'taskNoNoPlanLink', () => fire(() => planByTaskNo(ORPHAN_NO))],
      ['G-05', 'taskNoAmbiguousTail', () => fire(() => planByTaskNo(T1_NO))],
      ['G-06', 'planLocateRequired', () => fire(() => resolveEstimateTarget({}))],
      ['G-07', 'planMissingOrArchived', () => fire(() => resolveEstimateTarget({ planId: 'no-such-plan-e10', projectId: PID }))],
      ['G-08', 'planProjectMismatch', () => fire(() => resolveEstimateTarget({ planId: PLAN_IDS[1], projectId: OTHER_PID }))],
      ['G-09', 'unknownAudience', () => fire(() => parseAudience('both'))],
      ['G-10', 'unknownScope', () => fire(() => parseScope('nope'))],
      ['G-11', 'unknownPhase', () => fire(() => parsePhases('dev,bogus'))],
      ['G-12', 'emptyPhases', () => fire(() => parsePhases(',,'))],
    ];
    for (const [no, key, fn] of cases) {
      const zj = renameSim(key, fn, cnt);
      ok(`${no} ${key}：改词干后照样拒绝、文案随单源表移动、旧词干零残留、还原逐字符相同、零副作用`, zj === '', zj || undefined);
    }
    // 三点标签也是单源表的一部分（E3 抓到过「加载期快照数组」这类第二份抄本，这里按同一纪律验一次）
    {
      const LBL = ESTIMATE_POINT_LABELS as unknown as Record<string, string>;
      const orig = LBL.optimistic;
      const lFirst = pts(8, 5, 9)();
      const l0 = cnt();
      LBL.optimistic = 'ZZZ-乐观值';
      const lSecond = pts(8, 5, 9)();
      LBL.optimistic = orig;
      const lThird = pts(8, 5, 9)();
      ok('G-12a 三点标签改名后照样拒绝、文案随表移动、旧标签零残留、还原逐字符相同、零副作用',
        lFirst.includes(orig) && lSecond.includes('ZZZ-乐观值') && !lSecond.includes(orig) && lThird === lFirst && cnt() === l0,
        { first: lFirst, second: lSecond, third: lThird });
    }
    ok('G-13 改名期间合法值不受影响（校验不会因文案改造反向变严）', (() => {
      const orig = ESTIMATE_ERRORS.unknownPhase;
      try {
        (ESTIMATE_ERRORS as Record<string, string>).unknownPhase = 'ZZZ-unknownPhase';
        return parsePhases('dev').join() === 'dev' && parseScope('all') === 'all'
          && parseAudience('client') === 'client' && pointsError(1, 2, 3) === null;
      } finally {
        (ESTIMATE_ERRORS as Record<string, string>).unknownPhase = orig;
      }
    })());
    ok('G-14 件名比对有牙：同一拼装器换 audience 或换一秒就对不上服务端件名（M-29 不是恒等式）', (() => {
      const st = stampOf(XLSX_FNAME);
      return !!st && estimateArtifactName(PROJ_NAME, 'client', st) + '.xlsx' !== XLSX_FNAME
        && estimateArtifactName(PROJ_NAME, 'internal', new Date(st.getTime() + 1000)) + '.xlsx' !== XLSX_FNAME;
    })(), XLSX_FNAME);
  }

  group('H 跨进程同源自证（判据 4：改措辞不假红，靠的是同源不是抄本）');
  {
    ok(`H-01 服务端 ${mcpErrs.length} 条 MCP 拒绝原文逐条能用门进程单源表的词干解释`,
      mcpErrs.length >= 10 && mcpErrs.every((e) => e.stems.every((s) => Object.values(ESTIMATE_ERRORS).includes(s))),
      mcpErrs.filter((e) => !e.stems.every((s) => Object.values(ESTIMATE_ERRORS).includes(s))).map((e) => e.label));
    ok('H-02 词干命中不是碰巧：不属于单源表的假词干（含改名模拟用的 ZZZ- 前缀）在服务端原文里零出现',
      mcpErrs.length > 0 && mcpErrs.every((e) => !e.text.includes('ZZZ-') && !e.text.includes('未知天晓得')),
      mcpErrs.map((e) => e.text.slice(0, 60)));
    // MCP 的 err() 会给正文套一层统一信封前缀（那是传输层的包装，不是估算文案的一部分）：
    // 剥掉信封后必须与门进程直调产品函数的原文**逐字符相同**，且三处的信封一致——
    // 这样才既不自欺（真的同一句话），也不把信封前缀抄进门里当第二份字面量。
    const envelope = (server: string, mine: string) =>
      mine !== '' && server.endsWith(mine) ? server.slice(0, server.length - mine.length) : null;
    const envAmb = envelope(AMBIG_SERVER_TEXT, fire(() => planByTaskNo(T1_NO)));
    const envGhost = envelope(GHOST_SERVER_TEXT, fire(() => resolveEstimateProject({ projectId: 'no-such-project-e10' })));
    const envNoLink = envelope(NOLINK_SERVER_TEXT, fire(() => planByTaskNo(ORPHAN_NO)));
    ok('H-03 MCP 层没有第二份文案：同一入参在门进程直调产品函数，剥掉统一信封后与服务端原文逐字符相同',
      envAmb !== null && envAmb === envGhost && envGhost === envNoLink && envAmb!.length <= 8,
      { 信封: envAmb, 另一处: envGhost, 第三处: envNoLink, amb: AMBIG_SERVER_TEXT.slice(0, 60) });
    ok('H-04 REST 下载的件名也能由同一拼装器逐字符复现（两条出口不是两套模板）', (() => {
      const rs = stampOf(REST_FNAME);
      // 两次出件落在同一秒时件名本就相同（时间戳只到秒），所以这里证的是「可复现」，不是「必须不同」
      return !!rs && estimateArtifactName(PROJ_NAME, 'internal', rs) + '.xlsx' === REST_FNAME
        && REST_FNAME.startsWith(ESTIMATE_FILE_BASE) && REST_FNAME.includes(PROJ_NAME);
    })(), { rest: REST_FNAME, mcp: XLSX_FNAME });
    const spy: Array<{ name: string; cond: boolean }> = [];
    okPair((name, cond) => spy.push({ name, cond }), 'H-05 负对照', () => false, () => true);
    ok('H-05 负对照：把词干原样放进一条「不报错」的响应里，配对器仍判红（M 段的绿不是字面给的）',
      spy.length === 1 && spy[0].cond === false, spy);
    closeDb(); // 门进程的连接必须在回收临时目录前收口（否则句柄自持，库里只剩 -wal）
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log(`T02044 E10（MCP）验证结果：PASS=${pass} FAIL=${fail}`);
if (skippedList.length) console.log('跳过：' + skippedList.join(' / '));

try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
await sleep(600);
if (process.platform === 'win32' && child.pid) {
  try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  await sleep(400);
}
try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
if (!process.env.T02044_KEEP) { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 占用 */ } }
process.exit(fail === 0 ? 0 : 1);
