#!/usr/bin/env node
/**
 * T02292 回归门：归档三列表（/tasks?archived=1、/prompts?archived=1、/plans/archived）的
 * **服务端分页 + 裸数组兼容契约**固化。
 *
 * 拦的是「后续改动无声破坏兼容面」这一类，不是新功能：
 *   ① 不带 `total` 时响应体必须是**裸数组**——CommandPalette / 移动端 ArchiveView / MCP /
 *      scripts/verify-t01874.mjs / perf jmx 全按数组取数；
 *   ② `/prompts`、`/plans/archived` 不带 `limit` 时必须是**全量**（缺省 limit=全量是 T02284
 *      写进注释的兼容选择）；
 *   ③ `/tasks` 缺省 limit=200、硬钳 [1,500] 的 M7-7.2 口径**不被 `total` 通道改变**；
 *   ④ 分页遍历去重后的行数必须等于 `total`（无重叠、无遗漏），且 500 条窗口之外的行
 *      在分页/关键词/分类下推下可达（防止退回「先本地切片再本地过滤」的旧实现）。
 *
 * 用法（Node 须与 better-sqlite3 ABI 对齐；本仓惯例走 tsx）：
 *   <node> node_modules/tsx/dist/cli.mjs scripts/verify-t02284-paging.mjs
 *   环境变量：T02284_PORT（默认 39944，避开其他门占用的端口）、T02284_TMP_ROOT（默认 D:/code/tmp，**勿指 C:**——
 *   C: 常年 0 可用会假性 SQLITE_FULL）、T02284_KEEP=1 保留临时库与种子数据便于排障。
 *
 * 隔离纪律（skill 红线 8）：另起隔离实例（独立端口 + MTask_DATA_DIR=临时目录），
 * 数据由本门**自播种**（520 条归档任务 / 230 条归档计划 / 260 条归档提示词——后两者刻意超过
 * 200，好让「缺省 limit=全量」被改回截断时 L-01/L-02 必然失败，而不是空转通过），
 * 期望值全部由播种常量现算，不落任何上一轮的 project/category ID——
 * 这正是「在全新数据目录下一次通过」的前提（搬门时踩过的坑：硬编码上一轮 ID → 第二次跑就红）。
 * 不连生产实例、不碰生产数据目录；无 AI、无外网依赖，失败即非零退出。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02284_PORT ?? 39944);
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP_ROOT = process.env.T02284_TMP_ROOT || 'D:/code/tmp';
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02284-paging-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 播种常量（期望值全部由此派生，杜绝硬编码上一轮 ID） ----------------
const TASK_TOTAL = 520;          // > 500：让「旧实现一次拉 500 条够不到的区」必须可达
const TAIL_KEYWORD = 'ZZZTAIL';  // 挂在最老的 20 条上：默认 200 窗口内搜不到，服务端下推才命中
const TAIL_COUNT = 20;
const PLAN_TOTAL = 230;         // > 200：把「缺省 limit=全量」改回截断时，L-02 必然失败
const PLAN_EVERY = 5;            // 每 PLAN_EVERY 条归到 B 项目 → 项目筛选下推的期望值
const PROMPT_TOTAL = 260;       // > 200：同上，让 L-01 对「缺省截断」回归有区分性
const CAT_EVERY = 3;             // 每 CAT_EVERY 条任务挂分类
const PROMPT_KW = '样本 3';      // 标题命中集由播种行现算（见 EXPECT），不写死条数
const PLAN_TITLE_KW = '归档计划样本 1'; // 与上同理：命中集由播种行现算
const DEFAULT_LIMIT = 200;   // M7-7.2：/tasks 不带 limit 的缺省截断
const HARD_CLAMP = 500;      // M7-7.2：/tasks limit 硬钳上限
// 播种行登记表：所有期望值都由这些行现算——门不因数据规模调整而需要同步改判据
const seeded = { tasks: [], plans: [], prompts: [] };
const EXPECT = {};

let pass = 0;
let fail = 0;
const lines = [];
const ok = (name, cond, extra) => {
  const line = `${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined && extra !== '' ? ` → ${JSON.stringify(extra).slice(0, 300)}` : ''}`;
  lines.push(line);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${line.slice(line.indexOf(' ') + 1)}`);
  if (cond) pass += 1; else fail += 1;
};

async function raw(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, text: await r.text(), headers: r.headers };
}
async function j(path) {
  const { status, text } = await raw(path);
  if (status < 200 || status >= 400) throw new Error(`GET ${path} -> ${status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function send(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const post = (p, b) => send('POST', p, b);
const patch = (p, b) => send('PATCH', p, b);
const q = (o) => '?' + new URLSearchParams(o).toString();

// ---------------- 1) 隔离实例 ----------------
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
console.log(`隔离实例启动器：${LAUNCHER.label}`);
console.log(`数据目录：${DATA_DIR} / 端口：${PORT}`);
{ // 起服务前先探端口：已有实例应答时绝不把断言打在别人的实例上（尤其是生产实例）
  let taken = false;
  try { taken = (await fetch(`${BASE}/health`)).ok; } catch { /* 端口空闲 */ }
  if (taken) {
    console.log(`端口 ${PORT} 上已有实例应答——本门的断言必须打在自己起的隔离实例上，请用 T02284_PORT 换端口`);
    process.exit(1);
  }
}
const child = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR, MTask_LOG_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
child.stdout?.on('data', (b) => serverLog.push(b.toString()));
child.stderr?.on('data', (b) => serverLog.push(b.toString()));
const killTree = (pid) => { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 回收失败不影响判定 */ } };
process.on('exit', () => { if (child.pid) killTree(child.pid); });

let serverUp = false;
for (let i = 0; i < 240; i++) {
  try { if ((await fetch(`${BASE}/health`)).ok) { serverUp = true; break; } } catch { /* 还没起来 */ }
  if (child.exitCode !== null) break;
  await sleep(500);
}
ok('S-00 隔离实例启动（独立端口 + 临时数据目录，未连生产实例）', serverUp);
if (!serverUp) {
  console.log(`\n—— 服务日志 ——\n${serverLog.join('').split('\n').slice(-40).join('\n')}`);
  console.log('服务未起来，终止');
  process.exit(1);
}

// ---------------- 2) 自播种 ----------------
const stamp = Date.now();
const proj = await post('/projects', { name: `T02284分页门项目-${stamp}` });
const projB = await post('/projects', { name: `T02284分页门项目B-${stamp}` });
const taskCat = await post('/task-categories', { name: `T02284分页门分类-${stamp}` });
const promptCat = await post('/prompt-categories', { name: `T02284分页门提示词分类-${stamp}` });

for (let i = 1; i <= TASK_TOTAL; i++) {
  // created_at DESC ⇒ 尾部（i ≤ TAIL_COUNT）落在默认窗口之外，是「够不到的区」
  const title = i <= TAIL_COUNT ? `归档尾部样本 ${i} ${TAIL_KEYWORD}` : `归档任务样本 ${i}`;
  const categoryId = i % CAT_EVERY === 0 ? taskCat.id : undefined;
  const t = await post('/tasks', {
    projectId: proj.id,
    title,
    description: `T02284 分页契约样本 #${i}`,
    categoryId,
  });
  seeded.tasks.push({ id: t.id, title, categoryId });
}
await post('/archive', { taskIds: seeded.tasks.map((t) => t.id) });

for (let i = 1; i <= PLAN_TOTAL; i++) {
  const projectId = i % PLAN_EVERY === 0 ? projB.id : proj.id;
  const title = `归档计划样本 ${i}`;
  const p = await post('/plans', { projectId, title, durationDays: 1 });
  seeded.plans.push({ id: p.id, projectId, title });
  await post(`/plans/${p.id}/archive`);
}

for (let i = 1; i <= PROMPT_TOTAL; i++) {
  const title = `归档提示词样本 ${i}`;
  const p = await post('/prompts', { categoryId: promptCat.id, title, content: 'T02284 分页契约内容' });
  seeded.prompts.push({ id: p.id, title });
  await patch(`/prompts/${p.id}`, { archived: true });
}
ok('S-01 播种完成（归档任务/计划/提示词 = 期望规模，全部门槛数据自算不落历史 ID）',
  seeded.tasks.length === TASK_TOTAL && seeded.plans.length === PLAN_TOTAL && seeded.prompts.length === PROMPT_TOTAL,
  `任务 ${seeded.tasks.length}·计划 ${seeded.plans.length}·提示词 ${seeded.prompts.length}`);

// 期望值由播种行现算（改数据规模不需要同步改判据；也是「全新目录一次通过」的根据）
Object.assign(EXPECT, {
  tasks: TASK_TOTAL,
  tail: seeded.tasks.filter((t) => t.title.includes(TAIL_KEYWORD)).length,
  cats: seeded.tasks.filter((t) => t.categoryId === taskCat.id).length,
  plans: PLAN_TOTAL,
  plansB: seeded.plans.filter((p) => p.projectId === projB.id).length,
  plansA: seeded.plans.filter((p) => p.projectId === proj.id).length,
  planTitleKw: seeded.plans.filter((p) => p.title.includes(PLAN_TITLE_KW)).length,
  prompts: PROMPT_TOTAL,
  promptKw: seeded.prompts.filter((p) => p.title.includes(PROMPT_KW)).length,
});

// ---------------- 3) 契约断言 ----------------
// 遍历辅助：limit 步长翻完一页集，返回去重后的 id 集 + 各页条数
async function traverse(ep, params, limit) {
  const seen = new Map();
  const pages = [];
  let offset = 0;
  for (let guard = 0; guard < 200; guard++) {
    const r = await j(`${ep}${q({ ...params, limit, offset, total: 1 })}`);
    pages.push(r.items.length);
    r.items.forEach((row) => seen.set(row.id, (seen.get(row.id) ?? 0) + 1));
    if (r.items.length < limit) return { seen, pages, total: r.total };
    offset += limit;
  }
  return { seen, pages, total: -1 };
}

// ===== N 组：不带 total 的响应体必须是裸数组（兼容性契约 ①）=====
{
  const r = await raw('/tasks' + q({ archived: 1, limit: 20, offset: 0 }));
  ok('N-01 契约①：/tasks 不带 total → HTTP 200 且响应体是裸数组（CommandPalette/移动端/MCP 按数组取数）',
    r.status === 200 && Array.isArray(JSON.parse(r.text)), `type=${Array.isArray(JSON.parse(r.text)) ? 'array' : typeof JSON.parse(r.text)}`);
}
{
  const r = await raw('/prompts' + q({ archived: 1, limit: 10, offset: 0 }));
  ok('N-02 契约①：/prompts 不带 total → 响应体是裸数组', r.status === 200 && Array.isArray(JSON.parse(r.text)));
}
{
  const r = await raw('/plans/archived' + q({ limit: 10, offset: 0 }));
  ok('N-03 契约①：/plans/archived 不带 total → 响应体是裸数组', r.status === 200 && Array.isArray(JSON.parse(r.text)));
}
for (const [ep, params, id] of [
  ['/tasks', { archived: 1, limit: 20, offset: 40 }, 'N-04'],
  ['/prompts', { archived: 1, limit: 10, offset: 20 }, 'N-05'],
  ['/plans/archived', { limit: 10, offset: 30 }, 'N-06'],
]) {
  const plain = await raw(`${ep}${q(params)}`);
  const env = await raw(`${ep}${q({ ...params, total: 1 })}`);
  const same = plain.text === JSON.stringify(JSON.parse(env.text).items);
  ok(`${id} 契约①：${ep} 同参数下「裸数组」与「total 信封的 items」逐字相等（加性通道不改数据）`,
    same, `裸数组长度=${JSON.parse(plain.text).length} 信封 total=${JSON.parse(env.text).total} 一致=${same}`);
}
{ // 带筛选条件时同样成立：兼容面不只覆盖无参调用
  const kw = encodeURIComponent(TAIL_KEYWORD);
  const plain = await raw(`/tasks?archived=1&limit=20&offset=0&keyword=${kw}&categoryId=${taskCat.id}`);
  ok('N-07 契约①：带 keyword/categoryId 筛选时 /tasks 不带 total 仍是裸数组',
    plain.status === 200 && Array.isArray(JSON.parse(plain.text)),
    `type=${Array.isArray(JSON.parse(plain.text)) ? 'array' : typeof JSON.parse(plain.text)} len=${JSON.parse(plain.text).length}`);
}

// ===== L 组：缺省 limit / 硬钳口径（兼容性契约 ②③）=====
{
  const all = await j('/prompts?archived=1');
  ok('L-01 契约②：/prompts 不带 limit = 全量（缺省全量是 T02284 的兼容选择）',
    Array.isArray(all) && all.length === PROMPT_TOTAL, `条数=${Array.isArray(all) ? all.length : typeof all} 期望=${PROMPT_TOTAL}`);
}
{
  const all = await j('/plans/archived');
  ok('L-02 契约②：/plans/archived 不带 limit = 全量',
    Array.isArray(all) && all.length === PLAN_TOTAL, `条数=${Array.isArray(all) ? all.length : typeof all} 期望=${PLAN_TOTAL}`);
}
{
  const r = await j('/tasks' + q({ archived: 1 }));
  ok('L-03 契约③：/tasks 不带 limit = 缺省 200（M7-7.2 截断语义保持不变）',
    Array.isArray(r) && r.length === DEFAULT_LIMIT, `条数=${Array.isArray(r) ? r.length : typeof r} 期望=${DEFAULT_LIMIT}`);
}
{
  const big = await j('/tasks' + q({ archived: 1, limit: 9999 }));
  const zero = await j('/tasks' + q({ archived: 1, limit: 0 }));
  const nan = await j('/tasks' + q({ archived: 1, limit: 'abc' }));
  ok('L-04 契约③：/tasks limit 非法值口径不变（超大→500 硬钳；0/非数→缺省 200）',
    big.length === HARD_CLAMP && zero.length === DEFAULT_LIMIT && nan.length === DEFAULT_LIMIT,
    `9999→${big.length} 0→${zero.length} abc→${nan.length}`);
}
{
  const big = await j('/tasks' + q({ archived: 1, limit: 9999, total: 1 }));
  const zero = await j('/tasks' + q({ archived: 1, limit: 0, total: 1 }));
  const none = await j('/tasks' + q({ archived: 1, total: 1 }));
  const neg = await j('/tasks' + q({ archived: 1, limit: 20, offset: -5, total: 1 }));
  ok('L-05 契约③：total 通道不改变缺省/硬钳读数（limit9999→500、limit0→200、无limit→200、offset<0→第1页）',
    big.items.length === HARD_CLAMP && zero.items.length === DEFAULT_LIMIT
    && none.items.length === DEFAULT_LIMIT && neg.items.length === 20,
    `9999→${big.items.length} 0→${zero.items.length} 无limit→${none.items.length} offset-5→${neg.items.length}`);
}
{
  const bare = await raw('/plans/archived');
  const explicit = await raw(`/plans/archived?limit=${PLAN_TOTAL}`);
  ok('L-06 契约②：/plans/archived 无 limit 与显式全量 limit 返回体逐字相等（全量语义等价）',
    bare.text === explicit.text, `无limit=${JSON.parse(bare.text).length} 显式=${JSON.parse(explicit.text).length}`);
}

// ===== T 组：total 加性通道与遍历一致性（兼容性契约 ④）=====
{
  const r = await j('/tasks' + q({ archived: 1, limit: 20, offset: 0, total: 1 }));
  ok('T-01 契约④：/tasks?archived=1 的 total == 播种条数', r.total === TASK_TOTAL, `total=${r.total} 期望=${TASK_TOTAL}`);
}
{
  const t = await traverse('/tasks', { archived: 1 }, 50);
  const dup = [...t.seen.values()].filter((n) => n > 1).length;
  ok('T-02 契约④：/tasks 50/页遍历去重后的行数 == total（无重叠、无遗漏）',
    t.seen.size === t.total && dup === 0, `遍历=${t.seen.size} total=${t.total} 重复行=${dup} 页数=${t.pages.length}`);
}
{
  const t = await traverse('/prompts', { archived: 1 }, 10);
  ok('T-03 契约④：/prompts 分页遍历去重后的行数 == total', t.seen.size === t.total, `遍历=${t.seen.size} total=${t.total}`);
}
{
  const t = await traverse('/plans/archived', {}, 20);
  ok('T-04 契约④：/plans/archived 分页遍历去重后的行数 == total', t.seen.size === t.total, `遍历=${t.seen.size} total=${t.total}`);
}
{
  const rows = [];
  let good = true;
  for (const size of [10, 20, 50, 100]) {
    const pages = Math.ceil(TASK_TOTAL / size);
    const first = await j('/tasks' + q({ archived: 1, limit: size, offset: 0, total: 1 }));
    const last = await j('/tasks' + q({ archived: 1, limit: size, offset: (pages - 1) * size, total: 1 }));
    const expectLast = TASK_TOTAL - (pages - 1) * size;
    if (!(first.items.length === size && first.total === TASK_TOTAL && last.items.length === expectLast)) good = false;
    rows.push(`${size}/页→${pages}页,末页${last.items.length}/${expectLast}`);
  }
  ok('T-05 契约④：各档位页数与末页条数自洽（10/20/50/100 四种步长）', good, rows.join(' | '));
}
{
  const r = await j('/tasks' + q({ archived: 1, limit: 20, offset: TASK_TOTAL + 100, total: 1 }));
  ok('T-06 契约④：越界 offset → items 为空但 total 不变（前端按 total 收敛页码的依据）',
    r.items.length === 0 && r.total === TASK_TOTAL, `items=${r.items.length} total=${r.total}`);
}
{
  const beyond = await j('/tasks' + q({ archived: 1, limit: 20, offset: HARD_CLAMP, total: 1 }));
  const window = await j('/tasks' + q({ archived: 1, limit: HARD_CLAMP }));
  const windowIds = new Set(window.map((t) => t.id));
  const reachable = beyond.items.filter((t) => !windowIds.has(t.id)).length;
  ok('T-07 契约④：硬钳 500 条窗口之外的行经分页可达（旧实现一次拉 500 条够不到的区）',
    beyond.items.length === TASK_TOTAL - HARD_CLAMP && reachable === beyond.items.length,
    `第 501+ 页条数=${beyond.items.length} 其中不在 500 窗口内=${reachable}`);
}

// ===== F 组：过滤下推（防退回「先取窗口再本地过滤」）=====
{
  const r = await j('/tasks' + q({ archived: 1, limit: 100, offset: 0, total: 1, keyword: TAIL_KEYWORD }));
  const bare = await j('/tasks' + q({ archived: 1, limit: 100, offset: 0, keyword: TAIL_KEYWORD }));
  ok('F-01 契约④：关键词下推到服务端——尾部样本命中集正好 = 播种条数（裸数组口径同数）',
    r.total === EXPECT.tail && r.items.length === EXPECT.tail && bare.length === EXPECT.tail
    && r.items.every((t) => t.title.includes(TAIL_KEYWORD)), `total=${r.total} 期望=${EXPECT.tail}`);
}
{
  const hit = await j('/tasks' + q({ archived: 1, limit: 100, offset: 0, total: 1, keyword: TAIL_KEYWORD }));
  const defWin = await j('/tasks' + q({ archived: 1 }));
  const defIds = new Set(defWin.map((t) => t.id));
  const outside = hit.items.filter((t) => !defIds.has(t.id)).length;
  ok('F-02 契约④：命中集整体落在默认 200 条窗口之外（本地过滤 + 缺省截断的旧实现永远搜不到）',
    outside === EXPECT.tail, `命中 ${hit.items.length} 条，其中不在默认窗口内=${outside}`);
}
{
  const r = await j('/tasks' + q({ archived: 1, limit: 1, offset: 0, total: 1, categoryId: taskCat.id }));
  ok('F-03 契约④：分类筛选下推 → total == 挂该分类的播种条数', r.total === EXPECT.cats, `total=${r.total} 期望=${EXPECT.cats}`);
}
{
  const b = await j('/plans/archived' + q({ projectId: projB.id, total: 1 }));
  const a = await j('/plans/archived' + q({ projectId: proj.id, total: 1 }));
  ok('F-04 契约④：/plans/archived 项目筛选下推（B 项目条数正确、返回行归属无误）',
    b.total === EXPECT.plansB && a.total === EXPECT.plansA && b.items.every((p) => p.project_id === projB.id),
    `B total=${b.total} 期望=${EXPECT.plansB}；A total=${a.total} 期望=${EXPECT.plansA}`);
}
{
  const byTitle = await j('/plans/archived' + q({ keyword: PLAN_TITLE_KW, total: 1 }));
  const byProj = await j('/plans/archived' + q({ keyword: '分页门项目B', total: 1 }));
  const none = await j('/plans/archived' + q({ keyword: '不存在的关键字XYZ', total: 1 }));
  ok('F-05 契约④：/plans/archived 关键词命中标题与项目名，无命中返回 total=0',
    byTitle.total === EXPECT.planTitleKw && byProj.total === EXPECT.plansB && none.total === 0,
    `标题=${byTitle.total} 项目名=${byProj.total} 无命中=${none.total}`);
}
{
  const r = await j('/prompts' + q({ archived: 1, keyword: PROMPT_KW, limit: 1, offset: 0, total: 1 }));
  const act = await j('/prompts?categoryId=' + promptCat.id);
  ok('F-06 契约④：/prompts 关键词下推命中条数正确，且未归档口径（archived 缺省）仍是裸数组',
    r.total === EXPECT.promptKw && Array.isArray(act), `关键词 total=${r.total} 期望=${EXPECT.promptKw}；未归档 type=${Array.isArray(act) ? 'array' : typeof act}`);
}

// ===== R 组：写操作后 total/页码收敛（分页信封不破坏既有归档-还原链路）=====
{
  const last = await j('/tasks' + q({ archived: 1, limit: 20, offset: TASK_TOTAL - 20, total: 1 }));
  const ids = last.items.map((t) => t.id);
  await post('/archive/restore', { taskIds: ids });
  const after = await j('/tasks' + q({ archived: 1, limit: 20, offset: TASK_TOTAL - 20, total: 1 }));
  ok('R-01 写操作收敛：还原一页后 total 随之减少、原越界页返回空（前端据此收敛页码）',
    after.total === TASK_TOTAL - 20 && after.items.length === 0, `还原后 total=${after.total} 该页条数=${after.items.length}`);
  const kept = await j('/tasks' + q({ archived: 1, limit: 20, offset: after.total - 20, total: 1 }));
  ok('R-02 写操作收敛：按新 total 取末页仍有数据（无空页/无漏行）', kept.items.length === 20, `末页条数=${kept.items.length}`);
  await post('/archive', { taskIds: ids });
  const back = await j('/tasks' + q({ archived: 1, limit: 1, offset: 0, total: 1 }));
  ok('R-03 写操作收敛：再归档后 total 复原（信封口径与写操作互不污染）', back.total === TASK_TOTAL, `total=${back.total}`);
}

// ---------------- 4) 汇总 ----------------
const head = `PASS=${pass} FAIL=${fail}`;
const summary = `${head}\n门：verify-t02284-paging · 数据目录 ${DATA_DIR} · 端口 ${PORT}\n${lines.join('\n')}\n`;
console.log(`\n${head}`);
const { writeGateResults } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const resultsFile = writeGateResults(OUT_DIR, 't02284-paging-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`结果文件：${resultsFile}`);

if (!process.env.T02284_KEEP) {
  if (child.pid) killTree(child.pid);
  for (let i = 0; i < 8; i++) {
    try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { await sleep(300 * (i + 1)); }
  }
} else {
  console.log(`（T02284_KEEP=1）保留数据目录：${DATA_DIR}`);
}
process.exit(fail ? 1 : 0);
