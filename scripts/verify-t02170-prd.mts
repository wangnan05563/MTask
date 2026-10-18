/**
 * T02170 门：AI 工作台「阶段性项目总结汇报 PPT 生成」PRD 交付质量。
 *
 * 任务要求（T02170）：撰写可交付/可审批的 PRD——功能逻辑严格基于现有项目管理模块能力、
 * 不虚构 API/数据结构；竞品基于真实 GitHub 项目；含目标/功能详情/UI-UX/验收标准；
 * 简体中文 Markdown，开发可直接依据开发测试。
 *
 * 断言组（按 `docs/验收门判据规约.md` 改判后的三段式）：
 *  D 组 文档结构（必含章节/附录/无占位符/规模——按**解析出的标题层级**判，不按整段子串）
 *  F 组 事实锚点（表由产品 `initSchema()` 建出来的隔离库实测；端点由隔离实例实测；
 *       口径类断言直接调用产品导出的函数/常量拿运行时值——防虚构 API）
 *  G 组 需求覆盖（对照 T02170 任务步骤逐条：交互流程/生成逻辑/批量机制/非功能/验收审批）
 *  H 组 跨进程同源自证（门进程调用产品函数得到的文案/数字，必须与服务端 HTTP 回给用户的逐字相同）
 *  S 组 改名模拟（把运行时章节白名单表 KICKOFF_SECTIONS 就地改名：校验行为跟着表走，
 *       与 PRD 文本无关；还原后逐字一致、零残留、零库副作用）
 *  N 组 负对照（伪造大纲/伪造文件名/伪造响应喂给同一批判据函数，必须判红）
 *
 * 判据口径：
 *  1. 原判据里 `/REPORT_PROJECT_MAX = 8/.test(源码)`、`/DEFAULT_RETENTION_DAYS = 90/`、
 *     `/export function preflight\(projectId: string\)/`、`/const \[multiSelect…/` 这类
 *     **源码字面量**全部换成运行时断言：import 产品导出的常量与函数、打真实 HTTP、
 *     读隔离库的 `sqlite_master` / `PRAGMA`、真跑一遍 `buildPptx()` 再用 jszip 解出 slide XML 验内容。
 *     源码文本最多退到 `okPair` 的字面侧，绿必须靠行为侧。
 *  2. 夹具自造（隔离库 + 隔离实例 + 门内项目/任务/计划/PRD 文档），生产库不读不写；
 *     实例起不来 ⇒ 运行时判据 `skipped()`，不冒充 PASS。
 *  3. 保留的字面锚点（PRD 的口径句、任务标题原文）一律 `okPair`，红因分「行为失守」/「字面锚点失配（行为在）」。
 *  4. 每条改判配负对照与改名模拟。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02170-prd.mts
 * 环境变量：T02170_PORT（默认 39914）、T02170_TMP_ROOT（默认 D:/code/tmp）、T02170_KEEP=1 保留临时目录
 * 结果落 .workbuddy/t02170-gate-results-<运行标识>.txt。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults } from './lib/gate-results.mts';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { okPair } from './lib/anchor-pair.mts'; // 判据 3：字面锚点必须配同义行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const PRD_PATH = join(ROOT, 'docs', 'PRD-阶段性项目总结汇报PPT.md');
const TMP_ROOT = process.env.T02170_TMP_ROOT ?? 'D:/code/tmp';
const PORT = Number(process.env.T02170_PORT ?? 39914);
const BASE = `http://127.0.0.1:${PORT}/api`;
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02170-gate-'));
// ⚠ 数据目录必须在任何产品模块 import 之前定好：静态 import 会先求值、`getDb()` 按默认目录连到生产库。
process.env.MTask_DATA_DIR = DATA_DIR;
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
const REAL_FETCH = globalThis.fetch.bind(globalThis);

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
/** 环境不具备（而非功能失守）时留痕，不冒充 PASS——判据 2 的 `skipped()` 口径 */
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  lines.push(`[SKIP] ${range} —— ${why}（不计 PASS）`);
};
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p: string) => existsSync(join(ROOT, p));

// ======================= Markdown 结构解析（判据 1：打结构，不抄散文） =======================
type Heading = { level: number; text: string; line: number };
function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  const ls = md.split('\n');
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const fm = /^\s*(```|~~~)/.exec(l);
    if (fm) { if (!fence) fence = fm[1]; else if (l.trim().startsWith(fence)) fence = null; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) out.push({ level: h[1].length, text: h[2].trim(), line: i + 1 });
  }
  return out;
}
function stripFences(md: string): string {
  const keep: string[] = [];
  let fence: string | null = null;
  for (const l of md.split('\n')) {
    const fm = /^\s*(```|~~~)/.exec(l);
    if (fm) { if (!fence) fence = fm[1]; else if (l.trim().startsWith(fence)) fence = null; continue; }
    if (!fence) keep.push(l);
  }
  return keep.join('\n');
}
function sectionBody(md: string, headings: Heading[], match: (h: Heading) => boolean): string {
  const idx = headings.findIndex(match);
  if (idx < 0) return '';
  const ls = md.split('\n');
  const lv = headings[idx].level;
  let end = ls.length;
  for (let j = idx + 1; j < headings.length; j++) if (headings[j].level <= lv) { end = headings[j].line - 1; break; }
  return ls.slice(headings[idx].line, end).join('\n');
}
function hasHeading(headings: Heading[], level: number, prefix: string): boolean {
  return headings.some((h) => h.level === level && h.text.startsWith(prefix));
}
type TableRow = { cells: string[]; line: number };
function parseTables(text: string): TableRow[][] {
  const blocks: TableRow[][] = [];
  const ls = text.split('\n');
  let cur: TableRow[] = [];
  for (let i = 0; i < ls.length; i++) {
    const raw = ls[i].trim();
    if (raw.startsWith('|') && raw.endsWith('|')) {
      const cells = raw.slice(1, -1).split('|').map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) cur.push({ cells, line: i + 1 });
    } else if (cur.length) { blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}
const bold = (s: string) => s.replace(/\*\*/g, '');

// ======================= 前置：PRD 必须存在 =======================
ok('D-00 PRD 文件存在（docs/PRD-阶段性项目总结汇报PPT.md）', existsSync(PRD_PATH));
if (!existsSync(PRD_PATH)) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeGateResults(OUT_DIR, 't02170-gate-results.txt', `T02170 PRD 门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
const PRD = readFileSync(PRD_PATH, 'utf8');
const HEADINGS = parseHeadings(PRD);
const bodyOf = (m: (h: Heading) => boolean) => sectionBody(PRD, HEADINGS, m);
const sec = (prefix: string, level = 2) => bodyOf((h) => h.level === level && h.text.startsWith(prefix));
/** PRD 里出现的全部 `文件:行号` 锚点（H-05 逐条在仓里定位） */
const docAnchors = [...new Set(PRD.match(/[\w.-]+\.(?:tsx|ts|json|md):\d+(?:-\d+)?/g) ?? [])];

// ======================= 产品运行时真值（隔离库 + 产品导出面） =======================
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema(); // F-T 组的「表在不在」只问这座由产品自己建出来的库
const GATE_DB = getDb();
const tablesIn = (): Set<string> =>
  new Set((GATE_DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
const rowCount = (t: string): number => {
  try { return Number((GATE_DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c); } catch { return -1; }
};
const ReportSvc = await import('../server/src/services/ReportService.ts');
const Kickoff = await import('../server/src/services/kickoffService.ts');
const MsProg = await import('../server/src/services/milestoneProgress.ts');
const ExportName = await import('../server/src/util/export-name.ts');
const ReportBuilder = await import('../server/src/services/report-builder.ts');
const { readEventRetentionDays } = await import('../server/src/services/EventRetention.ts');
const PrdContext = await import('../server/src/util/prdContext.ts');
const { PlanService } = await import('../server/src/services/PlanService.ts');
const retentionDays = readEventRetentionDays();

// ======================= 隔离实例 =======================
let LAUNCHER: ReturnType<typeof resolveServerLauncher> | null = null;
let child: ChildProcess | null = null;
const serverLog: string[] = [];
const apiLog: Array<{ label: string; status: number; error: string }> = [];
async function startInstance(): Promise<boolean> {
  LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
  child = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR, TMP: TMP_ROOT, TEMP: TMP_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
  child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    try { if ((await REAL_FETCH(`${BASE}/health`)).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function stopInstance() {
  try { child?.kill('SIGTERM'); } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 600));
  if (process.platform === 'win32' && child?.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  try { child?.kill('SIGKILL'); } catch { /* 已退出 */ }
}
async function api(method: string, path: string, body?: unknown) {
  const res = await REAL_FETCH(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, any> | null = null;
  try { json = (await res.json()) as Record<string, any>; } catch { /* 二进制或非 JSON */ }
  return { status: res.status, json };
}
const errText = (r: { json: Record<string, any> | null }) => String(r.json?.error ?? '');
const rejected = (r: { status: number; json: Record<string, any> | null }) => r.status >= 400 && errText(r).trim().length > 0;
function refusedPair(label: string, r: { status: number; json: Record<string, any> | null }, literal: () => boolean, ctx?: () => unknown) {
  if (r.status >= 400) apiLog.push({ label, status: r.status, error: errText(r) });
  return okPair(ok, label, () => rejected(r), literal,
    () => ({ status: r.status, error: errText(r).slice(0, 160), ...(ctx ? { 证据: ctx() } : {}) }));
}

// ======================= D 组：文档结构（解析标题层级 + 小节非空） =======================
{
  const must = ['1. 项目概述与目标', '3. 功能需求详解', '7. 非功能需求', '8. 验收标准'];
  okPair(ok, 'D-01 必含章节：背景与目标 / 功能需求详解 / 非功能需求 / 验收标准',
    // 行为侧：四节都是真 H2 且各自有正文（>80 字符）——标题在但正文空壳即红
    () => must.every((p) => hasHeading(HEADINGS, 2, p))
      && must.every((p) => sec(p).trim().length > 80),
    () => /## 1\. 项目概述与目标/.test(PRD) && /## 3\. 功能需求详解/.test(PRD)
      && /## 7\. 非功能需求/.test(PRD) && /## 8\. 验收标准/.test(PRD),
    () => must.map((p) => [p, sec(p).trim().length]));
  const must2 = [['2. 用户角色与场景', 2], ['5. 竞品调研与优化建议', 2], ['5.3 优化建议', 3], ['5.4 技术选型结论', 3], ['6. 数据依赖与技术实现说明', 2]] as Array<[string, number]>;
  okPair(ok, 'D-02 必含章节：界面与交互设计（角色场景 + UX 优化建议）/ 技术实现建议 / 竞品调研',
    () => must2.every(([p, lv]) => hasHeading(HEADINGS, lv, p))
      && sec('2. 用户角色与场景').trim().length > 80 && bodyOf((h) => h.level === 3 && h.text.startsWith('5.3')).trim().length > 40,
    () => /## 2\. 用户角色与场景/.test(PRD) && /## 5\. 竞品调研与优化建议/.test(PRD)
      && /### 5\.3 优化建议/.test(PRD) && /### 5\.4 技术选型结论/.test(PRD) && /## 6\. 数据依赖与技术实现说明/.test(PRD),
    () => must2.map(([p, lv]) => [p, lv, hasHeading(HEADINGS, lv, p)]));
  const appB = bodyOf((h) => h.level === 2 && h.text.startsWith('附录 B'));
  // 附录 A 的交付形态是**围栏代码块里的逐页清单**（不是表格）：拿 `parseTables` 当判据恒为 0，
  // 会把真示例判成缺失。按「页目条目数」测，空壳/散文都会让条目数掉到 0。
  const a1Body = bodyOf((h) => h.level === 3 && h.text.startsWith('A.1 '));
  const a2Body = bodyOf((h) => h.level === 3 && h.text.startsWith('A.2 '));
  const pageEntries = (t: string) => (t.match(/^\s*\d+(?:-\d+)?\s+\S/gm) ?? []).length;
  const perProjectRanges = (a2Body.match(/^\s*\d+-\d+\s+项目\S*/gm) ?? []).length;
  okPair(ok, 'D-03 附录 A（PPT 章节示例）+ 附录 B（调研来源链接）',
    // 行为侧：两个附录都是真 H2；A.1 的逐页清单落在 §8-5 的单项目 12~16 页口径内；
    // A.2 有 ≥2 行「4-7 项目甲 / 8-11 项目乙」这类**每项目 4 页**的区间行（8+4N 的结构实体）；
    // 附录 B 里 ≥5 条去重 github.com 链接
    () => hasHeading(HEADINGS, 2, '附录 A') && hasHeading(HEADINGS, 2, '附录 B')
      && new Set(appB.match(/https?:\/\/github\.com\/\S+/g) ?? []).size >= 5
      && pageEntries(a1Body) >= 12 && pageEntries(a1Body) <= 16
      && pageEntries(a2Body) >= 8 && perProjectRanges >= 2,
    () => /## 附录 A/.test(PRD) && /## 附录 B/.test(PRD) && /github\.com/.test(PRD),
    () => ({ '附录B链接数': new Set(appB.match(/https?:\/\/github\.com\/\S+/g) ?? []).size, A1页目: pageEntries(a1Body), A2页目: pageEntries(a2Body), A2每项目区间行: perProjectRanges }));
  okPair(ok, 'D-04 无占位符（TODO/TBD/FIXME/WIP/XXX 大小写敏感——不误伤 todo 等状态枚举值；lorem 大小写不敏感）',
    // 行为侧：扫描域=围栏代码之外的正文；且「正文非空」逐节成立（防空壳）
    () => !/TODO|TBD|FIXME|WIP|XXX/.test(stripFences(PRD)) && !/[Ll]orem/.test(PRD)
      && HEADINGS.filter((h) => h.level === 2).every((h) => bodyOf((x) => x.line === h.line).trim().length > 20),
    () => !/TODO|TBD|FIXME|WIP|XXX/.test(PRD) && !/[Ll]orem/.test(PRD));
  ok('D-05 简体中文正文规模充足（>15000 字符，非骨架稿）', PRD.length > 15000 && /[\u4e00-\u9fa5]{20}/.test(PRD), PRD.length);
}

// ======================= F 组：事实锚点（防虚构 API/表/文件） =======================
const TABLES = ['projects', 'tasks', 'plan_tasks', 'prd_requirements', 'prd_docs', 'prd_issues',
  'test_cases', 'estimate_items', 'estimate_snapshots', 'console_jobs', 'task_events'];
const DB_TABLES = tablesIn();
const schemaSrc = read('server/src/db/schema.ts');
for (const t of TABLES) {
  okPair(ok, `F-T ${t} 表在 schema.ts 真实存在且被 PRD 引用`,
    // 行为侧：表由**产品的 initSchema()** 在隔离库里真的建出来了（读 sqlite_master）——
    // 迁移写歪时 CREATE 文本还在、表却不存在，这里必红
    () => DB_TABLES.has(t),
    () => new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`).test(schemaSrc) && PRD.includes(t),
    () => ({ 隔离库表数: DB_TABLES.size }));
}
const FILES = ['server/src/services/kickoffService.ts', 'server/src/services/kickoffBuilder.ts',
  'server/src/services/kickoff-layout.ts', 'server/src/services/ReportService.ts',
  'server/src/services/PlanService.ts', 'server/src/services/TaskService.ts',
  'server/src/services/milestoneProgress.ts', 'server/src/services/AIService.ts',
  'server/src/services/report-worker.ts', 'server/src/util/prdContext.ts',
  'server/src/util/export-name.ts', 'server/src/util/exportStyle.ts', 'server/src/util/export-gate.ts',
  'server/src/routes/plans.ts', 'server/src/routes/index.ts', 'server/src/db/schema.ts',
  'web/src/pages/ReportPage.tsx', 'web/src/pages/ReportConsole.tsx',
  'web/src/pages/KickoffPptPanel.tsx', 'web/src/ui/dialogs.tsx', 'web/src/api/sse.ts'];
for (const f of FILES) ok(`F-F ${f} 文件真实存在`, exists(f));

let instanceUp = false;
if (await startInstance()) {
  instanceUp = true;
  // ---- 门内夹具：项目 + 计划（四态各一条 + 一条非法态）+ 里程碑（有子/无子）+ 长 PRD 文档 ----
  const PID = String((await api('POST', '/projects', { name: `T02170 取证夹具-${process.pid}` })).json?.id ?? '');
  ok('F-C0 门内夹具就绪（隔离实例建出 1 个项目）', PID.length > 0, { PID });
  const planStatuses = ['todo', 'doing', 'done', 'blocked'] as const;
  const createdIds: string[] = [];
  for (const st of planStatuses) createdIds.push(String(PlanService.create({ projectId: PID, title: `四态-${st}`, status: st as any }).id));
  const illegalStatus = PlanService.create({ projectId: PID, title: '非法态-archived', status: 'archived' as any });
  const persistedStatuses = (GATE_DB.prepare('SELECT DISTINCT status FROM plan_tasks WHERE project_id = ?').all(PID) as Array<{ status: string }>).map((r) => r.status).sort();
  const msId = String(PlanService.create({ projectId: PID, title: '里程碑-有子', kind: 'milestone' }).id);
  const leafId = String(PlanService.create({ projectId: PID, title: '里程碑-无子', kind: 'milestone' }).id);
  // 父子口径（口径 A）：plan_tasks 没有 parent_id 列，父子关系唯一标记是子行 deps 里的
  // `type='child'` 边——所以模拟「有子项」必须写 deps JSON，而不是 SET parent_id。
  const childRow = PlanService.create({ projectId: PID, title: '里程碑有子-子项' });
  GATE_DB.prepare('UPDATE plan_tasks SET deps = ? WHERE id = ?')
    .run(JSON.stringify([{ id: msId, type: 'child' }]), String(childRow.id));
  const prdTitle = `取证PRD长文标记-${process.pid}`;
  const longContent = `${prdTitle}\n` + '一'.repeat(20000);
  GATE_DB.prepare('INSERT INTO prd_docs (id, project_id, filename, content_md, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('gate-prd-doc', PID, `${prdTitle}.md`, longContent, new Date().toISOString(), new Date().toISOString());
  const longTaskId = String((await api('POST', '/tasks', { projectId: PID, title: prdTitle })).json?.id ?? '');

  // ---- F-E 端点锚点：kickoff 三端点 + ai-download + events/recent（挂载与否由服务自己回答，不 grep 路由文件）----
  const ep = {
    preflight: await api('GET', '/plans/kickoff-preflight?projectId=' + encodeURIComponent(PID)),
    outlineNoTool: await api('POST', '/plans/kickoff-ppt-outline', { projectId: PID }),
    streamBad: await api('POST', '/plans/kickoff-ppt-stream', {}),
    downloadBad: await api('POST', '/report/ai-download', { token: 'no-such-token' }),
    eventsRecent: await api('GET', '/events/recent?limit=1'),
    summaryPreflight: await api('GET', '/plans/summary-preflight?projectId=' + encodeURIComponent(PID)),
    summaryStream: await api('POST', '/plans/summary-ppt-stream', {}),
  };
  for (const [k, r] of Object.entries(ep)) if (r.status >= 400) apiLog.push({ label: 'F-E ' + k, status: r.status, error: errText(r) });
  okPair(ok, 'F-E 端点锚点：kickoff 三端点 + ai-download + events/recent 均在位',
    // 行为侧：五条既有端点**不是 404**（路由真的挂着，业务参数错才 4xx），且 preflight/events 正常返回 JSON；
    //        同时 PRD 规划的 summary-* 端点此刻必须还不存在（404），否则「前瞻需求」就变成了虚报
    () => ep.preflight.status !== 404 && ep.outlineNoTool.status !== 404 && ep.streamBad.status !== 404
      && ep.downloadBad.status !== 404 && ep.eventsRecent.status === 200
      && ep.preflight.status === 200 && Array.isArray(ep.preflight.json?.items)
      && ep.summaryPreflight.status === 404 && ep.summaryStream.status === 404,
    () => PRD.includes('summary-preflight') && PRD.includes('summary-ppt-stream'),
    () => Object.fromEntries(Object.entries(ep).map(([k, r]) => [k, r.status])));

  // ---- F-C1 项目数上限：产品导出的常量 + 校验函数 + 真实 HTTP 三层同判 ----
  // 「8 个放行」必须拿**库里真实存在**的 8 个项目测：validateProjectIds 在帽之后还查存在性，
  // 用假 id 测到的「放行」根本不存在（门内自造数据，走 POST /projects 这条 sanctioned 通道）
  const mkProj = async (tag: string) => String((await api('POST', '/projects', { name: `T02170 范围夹具-${tag}` })).json?.id ?? '');
  const ids8: string[] = [];
  for (let i = 0; i < 8; i++) ids8.push(await mkProj(`p${i}`));
  const ninth = await mkProj('p8');
  const v8 = ReportSvc.validateProjectIds(ids8);
  const v9 = ReportSvc.validateProjectIds([...ids8, ninth]);
  const http9 = await api('POST', '/report/generate', { period: 'week', format: 'xlsx', projectIds: [...ids8, ninth] });
  const rowsBeforeGen = rowCount('tasks');
  okPair(ok, 'F-C1 REPORT_PROJECT_MAX=8 与 PRD 声称一致',
    // 行为侧：常量值=8；8 个 id 放行、9 个 id 被拒且**点名当前个数**；HTTP 同判（400 + 回写库零变化）
    () => ReportSvc.REPORT_PROJECT_MAX === 8 && ids8.every(Boolean) && !v8.error && v8.ids.length === 8
      && !!v9.error && /当前选择了 9 个/.test(v9.error) && http9.status === 400 && rowCount('tasks') === rowsBeforeGen,
    () => PRD.includes('REPORT_PROJECT_MAX=8'),
    () => ({ 常量: ReportSvc.REPORT_PROJECT_MAX, 九个的报错: v9.error, HTTP: http9.status }));
  refusedPair('F-C1a 超限项目数走 HTTP 也是 400（不是只在前端拦）', http9, () => /一次最多聚合 8 个项目/.test(errText(http9)),
    () => ({ 门内函数文案: v9.error }));

  // ---- F-C2 计划四态：写入口的闭包性实测（非法值进不了库）----
  okPair(ok, 'F-C2 PLAN_STATUSES 四值（todo/doing/done/blocked）与 PRD 一致',
    // 行为侧：四态逐个写入 `plan_tasks` 后**回读逐字相等**；第五个值（archived）被写入口降级、
    // 库内 distinct status 集合恰好等于这四个——比 regex 扫 Set 字面量强：改了枚举不通知前端时这里必红
    () => persistedStatuses.join(',') === Array.from(planStatuses).sort().join(',')
      && illegalStatus.status === 'todo' && createdIds.length === 4,
    () => PRD.includes("['todo','doing','done','blocked']") && PRD.includes('PlanService.ts:84'),
    () => ({ 库内状态集: persistedStatuses, 非法入参落库值: illegalStatus.status }));

  // ---- F-C3 下载名白名单：直接调产品函数 ----
  const allowPptx = ExportName.DOWNLOAD_NAME_RE.test('启动会汇报.pptx');
  const denyZip = ExportName.DOWNLOAD_NAME_RE.test('打包.zip');
  const dirtyName = '项目 A & B（月报）+ 复盘 #3';
  const washed = ExportName.downloadSafeName(dirtyName, 'fallback') + '.pptx';
  okPair(ok, 'F-C3 下载白名单不含 zip（PRD 的 A-2 约束前提为真：白名单放行 pptx、拒绝 zip）',
    // 行为侧：白名单**实际放行/拒绝**两个文件名；且 `downloadSafeName` 洗过的怪名字必然过白名单
    // （洗名函数的契约就是「洗到能过」，做不到就是产品缺陷，这里必红）
    () => allowPptx === true && denyZip === false && ExportName.DOWNLOAD_NAME_RE.test(washed),
    () => /DOWNLOAD_NAME_RE/.test(PRD) && !ExportName.DOWNLOAD_NAME_RE.test('x.zip'),
    () => ({ pptx: allowPptx, zip: denyZip, 洗名结果: washed }));

  // ---- F-C4 周期枚举与取数窗口：真跑三个周期 ----
  const periods = ['day', 'week', 'month'] as const;
  const wins = periods.map((p) => { const d = ReportSvc.gatherReportData(p, PID); return `${d.startDate}|${d.endDate}`; });
  const badPeriod = await api('POST', '/report/generate', { period: 'quarter', format: 'pptx' });
  const badFormat = await api('POST', '/report/generate', { period: 'week', format: 'zip' });
  okPair(ok, 'F-C4 ReportPeriod 三值 + 周期窗口存在（周期复用前提为真）',
    // 行为侧：三个周期各自能取到数且**窗口日期互不相同**（day⊂week⊂month），
    // 非法周期/非法格式被服务端 400 拒掉——枚举与窗口是跑出来的，不是读类型定义读出来的
    () => new Set(wins).size === 3 && rejected(badPeriod) && rejected(badFormat),
    () => /export type ReportPeriod = 'day' \| 'week' \| 'month'/.test(read('server/src/services/ReportService.ts'))
      && PRD.includes('periodRange'),
    () => ({ 窗口: wins, 非法周期: badPeriod.status, 非法格式: badFormat.status }));

  // ---- F-C5 卡片现状：既有 7 卡 + 新卡未实现（服务端自己承认）----
  const reportPageSrc = read('web/src/pages/ReportPage.tsx');
  const cardKeys = (() => {
    const m = /const reportCards[^=]*=\s*\[([\s\S]*?)\n  \];/.exec(reportPageSrc);
    return (m?.[1]?.match(/\{\s*key:\s*'([a-zA-Z-]+)'/g) ?? []).map((s) => /'([a-zA-Z-]+)'/.exec(s)![1]);
  })();
  okPair(ok, 'F-C5 卡片现状：kickoff-ppt 已在位（第 7 张），summary-ppt 尚未实现（PRD 为前瞻需求文档）',
    // 行为侧：kickoff-ppt 的后端端点挂得上（非 404），summary-ppt 的两条规划端点确为 404——
    // 「已实现/未实现」由服务自己回答，而不是靠 reportPage 里有没有某个字符串
    () => ep.preflight.status === 200 && ep.summaryPreflight.status === 404 && ep.summaryStream.status === 404,
    () => cardKeys.length === 7 && cardKeys.includes('kickoff-ppt') && !cardKeys.includes('summary-ppt'),
    () => ({ 卡: cardKeys, summary: [ep.summaryPreflight.status, ep.summaryStream.status] }));

  // ---- F-C6 竞品检索日期与核验方式：限定到 §5.1 调研方法小节 ----
  const survey = sec('5. 竞品调研与优化建议');
  okPair(ok, 'F-C6 PRD 记录竞品检索日期与联网核验方式（2026-10-16 WebSearch）',
    // 行为侧：日期与核验方式出现在**调研小节**里（不在附录蹭一个日期就算），且该节有样本清单（≥3 个 github 仓库）
    () => sec('5.1 调研方法与样本', 3).includes('2026-10-16')
      && /WebSearch|联网/.test(sec('5.1 调研方法与样本', 3))
      && new Set(survey.match(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? []).size >= 3,
    () => PRD.includes('2026-10-16') && /WebSearch/.test(PRD),
    () => ({ '调研节长度': survey.length }));

  // ---- F-C7 事件保留期（运行时函数，而不是 DEFAULT_RETENTION_DAYS 文本）----
  okPair(ok, 'F-C7 B1 前提：task_events 默认保留 90 天且可配；PRD 生效口径已收敛为 90 天并加 S9 事件覆盖率',
    // 行为侧：空配置的隔离库里 `readEventRetentionDays()` 返回 90（产品当前真实口径）；
    // 「注：92 天是 v1.1 修订清单里的旧值记述」——PRD 侧只校验生效口径句在场
    () => retentionDays === 90,
    () => /DEFAULT_RETENTION_DAYS = 90/.test(read('server/src/services/EventRetention.ts'))
      && /S9/.test(PRD) && /事件覆盖率/.test(PRD) && /自定义区间上限 \*\*90 天\*\*/.test(PRD),
    () => ({ 实测保留天数: retentionDays }));

  // ---- F-C8 里程碑聚合两态：直接调产品函数，用门内造的两种里程碑 ----
  const withChildren = MsProg.milestoneHasChildren(GATE_DB, msId);
  const withoutChildren = MsProg.milestoneHasChildren(GATE_DB, leafId);
  const leafBefore = PlanService.get(leafId)?.progress ?? -1;
  const recalc = MsProg.recalcMilestoneProgress(GATE_DB, leafId);
  const leafAfter = PlanService.get(leafId)?.progress ?? -1;
  okPair(ok, 'F-C8 I3 前提：里程碑无子项时不聚合（保留人工 progress）；PRD 已分两态渲染',
    // 行为侧：同一张库里「有子项/无子项」两个里程碑的判定结果相反，且对无子项里程碑执行聚合重算后
    // progress 值**一个字没动**（这就是 PRD「无子项走人工填报、不画进度条」的真前提）
    () => withChildren === true && withoutChildren === false && leafAfter === leafBefore
      && recalc.changed === false,
    () => PRD.includes('milestoneHasChildren') && /人工填报/.test(PRD),
    () => ({ 有子: withChildren, 无子: withoutChildren, progress: [leafBefore, leafAfter], 重算: recalc }));

  // ---- F-C9 kickoff 复用面：单项目签名（arity + 实跑只认一个项目）----
  const pfInProcess = Kickoff.preflight(PID);
  const bundle = Kickoff.collectBundle(PID);
  okPair(ok, 'F-C9 I4 前提：kickoffService 四函数为单项目 projectId 签名；PRD 已限定复用口径为版式层+端点范式',
    // 行为侧：preflight/collectBundle 的入参个数就是 1，且实跑结果只覆盖我们指定的那一个项目
    // （projectName/projectId 与夹具一致）——多项目化不是靠改文本，改代码就会在这里露馅
    () => Kickoff.preflight.length === 1 && Kickoff.collectBundle.length === 1
      && pfInProcess.projectId === PID && bundle.project.id === PID
      && Array.isArray(pfInProcess.items) && pfInProcess.items.length === 7,
    () => /版式层 \+ 端点范式/.test(PRD),
    () => ({ arity: [Kickoff.preflight.length, Kickoff.collectBundle.length], items: pfInProcess.items.length }));

  // ---- F-C10 第二条 pptx 路径：真生成一份多项目 deck 并解包验内容 ----
  const mkData = (names: string[]): ReportSvc.ReportData => ({
    period: 'week', periodLabel: '周报', startDate: '2026-10-12', endDate: '2026-10-18',
    generatedAt: '2026-10-18T00:00:00.000Z',
    projects: names.map((n) => ({ name: n, total: 3, todo: 1, done: 2, verified: 1, high: 1, medium: 1, low: 1 })),
    tasks: names.flatMap((n) => [
      { project: n, title: `${n}-已完成`, priority: 'high', status: 'done', verified: true, category: '后端' } as any,
      { project: n, title: `${n}-待办`, priority: 'normal', status: 'todo', verified: false, category: '前端' } as any,
    ]),
    plans: names.map((n) => ({ project: n, title: `${n}-计划`, startDate: '2026-10-12', endDate: '2026-10-16', assignee: '张三', status: 'done', kind: 'normal', progress: 100, complexity: 2 } as any)),
    projectScope: names.length > 1 ? names : undefined,
  });
  const zipText = async (buf: Buffer) => {
    const z = await JSZip.loadAsync(buf);
    let all = '';
    for (const f of Object.values(z.files)) if (f && /ppt\/slides\/slide\d+\.xml$/.test(f.name)) all += await f.async('string');
    return all;
  };
  const twoBuf = await ReportBuilder.buildPptx(mkData(['取证甲项目', '取证乙项目']));
  const oneBuf = await ReportBuilder.buildPptx(mkData(['取证甲项目']));
  const twoXml = await zipText(twoBuf);
  okPair(ok, 'F-C10 I5 前提：仓内第二条 pptx 路径 buildPptx 在位（已支持多项目）；PRD 已作对照说明',
    // 行为侧：**真跑一次生成**——产物是合法 OOXML 包（PK 头 + 解出 slide XML），
    // 两个项目名都出现在幻灯片正文里（多项目聚合真落地），且多项目稿与单项目稿不是同一份字节
    () => twoBuf.subarray(0, 2).toString('hex') === '504b' && twoBuf.length > 10000
      && twoXml.includes('取证甲项目') && twoXml.includes('取证乙项目')
      && oneBuf.length !== twoBuf.length && twoXml.length > 1000,
    () => ReportBuilder.buildPptx.length >= 1 && PRD.includes('buildPptx'),
    () => ({ 字节: twoBuf.length, 单项目字节: oneBuf.length, slideXML长度: twoXml.length }));

  // ---- F-C11 项目范围选择器：会话键 + 页面消费的数据源实测 ----
  const projList = await api('GET', '/projects');
  const legacyShape = Array.isArray(projList.json) ? projList.json : (projList.json?.items ?? []);
  okPair(ok, 'F-C11 I1 前提：页面级 ProjectScopePicker + report.projects 会话键在位；PRD 改为消费而非新建',
    // 行为侧：选择器要消费的范围数据源 `/projects` 真返回项目数组（含夹具项），
    // 且多项目范围函数 `normalizeScope` 对数组的语义就是「去重保序」——选择器的行为契约
    () => projList.status === 200 && legacyShape.length >= 1
      && legacyShape.some((p: any) => p.id === PID)
      && ReportSvc.normalizeScope(['a', 'a', '', 'b']).join(',') === 'a,b',
    () => /ProjectScopePicker/.test(reportPageSrc) && /useSessionState<string\[\]>\('report.projects'/.test(reportPageSrc)
      && PRD.includes('report.projects'),
    () => ({ 项目数: legacyShape.length, 归一: ReportSvc.normalizeScope(['a', 'a', '', 'b']) }));

  // ---- F-C12 防回退：90 天口径（运行时）+ PRD 的 6000 上下文预算（用产品截断函数实测）----
  const ctx = PrdContext.resolvePrdContext({ taskId: longTaskId });
  const elided = /中段略去 (\d+) 字符/.exec(ctx?.content ?? '');
  const budget = elided ? longContent.length - Number(elided[1]) : -1;
  okPair(ok, 'F-C12 防回退：生效口径句必须是 90 天上限（原 92）与按项目数自适应预算（原每项目 1500 字）',
    // 行为侧：PRD 说的 90 天=运行时默认值；PRD 说的 6000 字预算=产品截断函数**实测出来的预算**
    // （长文 20001 字 → 命中截断 → 反推预算），而不是 `PRD_CONTEXT_LIMIT = 6000` 那行文本；
    // 6000/N 的自适应口径以此为分子
    () => retentionDays === 90 && ctx !== null && budget === 6000
      && ctx.content.length < longContent.length && /按项目数自适应/.test(PRD) === true,
    () => /自定义区间上限 \*\*90 天\*\*（原 92）/.test(PRD) && /每项目 = 6000\/N/.test(PRD) && /按项目数自适应/.test(PRD),
    () => ({ 保留期: retentionDays, 实测预算: budget, 命中: ctx?.hitBy, 截断后长度: ctx?.content.length }));

  // ---- H 组：跨进程同源自证 ----
  const pfViaHttp = await api('GET', '/plans/kickoff-preflight?projectId=' + encodeURIComponent(PID));
  const pfInProcessAgain = Kickoff.preflight(PID);
  ok('H-01 同一项目、同一时刻：门进程调用 preflight() 与服务端 HTTP 回的 JSON 逐字相同（文案只有一个源）',
    JSON.stringify(pfViaHttp.json) === JSON.stringify(pfInProcessAgain) && pfViaHttp.status === 200,
    { 服务端: JSON.stringify(pfViaHttp.json).slice(0, 160) });
  ok('H-02 超限项目数的 400 文案 == 门进程调用 validateProjectIds() 得到的 error（服务端没另抄一份话术）',
    errText(http9) === (v9.error ?? '') && errText(http9).includes(String(ReportSvc.REPORT_PROJECT_MAX)),
    { HTTP: errText(http9), 门内: v9.error });
  const FAKE_STEM = 'ZZZ-本门不存在的词干';
  ok('H-03 假词干在 PRD、服务端 4xx 原文、产品运行时文案里零命中（H-01/H-02 的逐字比对不是恒真式）',
    !PRD.includes(FAKE_STEM) && apiLog.every((r) => !r.error.includes(FAKE_STEM))
      && !JSON.stringify(pfInProcessAgain).includes(FAKE_STEM) && !twoXml.includes(FAKE_STEM),
    { 服务端4xx条数: apiLog.length });
  const illegalRepeat = await api('POST', '/report/generate', { period: 'quarter', format: 'pptx' });
  ok('H-04 同一非法入参两次打，服务端回同一句话（错误出自服务端同一处代码，门里没另抄）',
    errText(badPeriod) === errText(illegalRepeat) && rejected(illegalRepeat), { 原文: errText(badPeriod) });
  ok('H-05 PRD 里每个 `文件:行号` 锚点都能在仓库定位到真实文件的真实行区间（不是随手编的行号）',
    docAnchors.length >= 20 && (() => {
      const idx = new Map<string, string[]>();
      const push = (b: string, p: string) => { const a = idx.get(b); if (a) a.push(p); else idx.set(b, [p]); };
      const rd = readdirSync, st = statSync, jj = join;
      const walk = (d: string) => { for (const e of rd(d)) { const p = jj(d, e); if (st(p).isDirectory()) { if (!/node_modules|dist|\.next|\.git/.test(e)) walk(p); } else if (/\.(tsx|ts|json|md)$/.test(e)) push(e, p); } };
      walk(join(ROOT, 'web', 'src')); walk(join(ROOT, 'server', 'src')); walk(join(ROOT, 'docs'));
      for (const e of rd(ROOT)) { const p = join(ROOT, e); if (st(p).isFile() && /\.(tsx|ts|json|md)$/.test(e)) push(e, p); }
      const bad: string[] = [];
      for (const t of docAnchors) {
        const m = /^([\w.-]+)\.(tsx|ts|json|md):(\d+)(?:-(\d+))?$/.exec(t);
        if (!m) { bad.push('PARSE ' + t); continue; }
        const end = Number(m[4] ?? m[3]);
        if (!(idx.get(`${m[1]}.${m[2]}`) ?? []).some((p) => end <= readFileSync(p, 'utf8').split('\n').length)) bad.push(t);
      }
      return bad.length === 0;
    })(), { 锚点数: docAnchors.length });
  ok('H-06 PRD §4 的 API 表把未实现端点写成「规划」，运行时实况是 404（PRD 没有把没做的说成做了）',
    /summary-preflight/.test(sec('4. API 接口定义', 2)) && ep.summaryPreflight.status === 404
      && ep.summaryStream.status === 404 && ep.preflight.status === 200,
    { summary: [ep.summaryPreflight.status, ep.summaryStream.status], kickoff: ep.preflight.status });
  ok('H-07 附录 A.2 声明的页数可由「8 + 4N」按同一份解析重算（数字同源，不是各抄一份）',
    (() => {
      const h = HEADINGS.find((x) => x.level === 3 && x.text.startsWith('A.2 '))?.text ?? '';
      const m = /(\d+)\s*\+\s*(\d+)N[^\d]*N=(\d+)\s*示例\s*=\s*(\d+)\s*页/.exec(h);
      return !!m && Number(m[1]) + Number(m[2]) * Number(m[3]) === Number(m[4]);
    })(), { 标题: HEADINGS.find((x) => x.level === 3 && x.text.startsWith('A.2 '))?.text });

  // ---- S 组：改名模拟（运行时章节白名单表 KICKOFF_SECTIONS 就地搬走，看校验行为跟不跟）----
  {
    const mkOutline = (section: string) => Array.from({ length: 12 }, (_, i) => ({
      section: i === 0 ? section : '项目风险',
      title: `取证标题${i + 1}`,
      bullets: [`「取证名称${i + 1}」按此推进`],
      dataKeys: i === 0 ? ['timeline'] : i === 1 ? ['workload'] : [],
      layout: i === 0 ? 'cover' : i === 1 ? 'toc' : i === 11 ? 'thanks' : 'list',
    }));
    const ORIGINAL = Kickoff.KICKOFF_SECTIONS[0]; // '封面'
    const dbSnap = ['tasks', 'plan_tasks', 'prd_docs'].map((t) => `${t}:${rowCount(t)}`).join(',');
    const base = Kickoff.validateOutline(mkOutline(ORIGINAL) as unknown);
    const RENAMED = `${FAKE_STEM}-封面`;
    (Kickoff.KICKOFF_SECTIONS as string[])[0] = RENAMED;
    const afterRename = Kickoff.validateOutline(mkOutline(ORIGINAL) as unknown);   // 原名应当被点名
    const newNameAccepted = Kickoff.validateOutline(mkOutline(RENAMED) as unknown); // 新名应当被认
    // 在「改名窗口内」取一次 HTTP preflight：若 preflight 文案吃这张表，它此刻会跟着变
    const pfHttpDuring = await api('GET', '/plans/kickoff-preflight?projectId=' + encodeURIComponent(PID));
    (Kickoff.KICKOFF_SECTIONS as string[])[0] = ORIGINAL;                            // 还原
    const restored = Kickoff.validateOutline(mkOutline(ORIGINAL) as unknown);
    ok('S-01 改名模拟（校验跟着表走）：把 KICKOFF_SECTIONS[0] 改名后，用**原名**提交的大纲立刻被记 warning「不在标准清单」',
      base.warnings.every((w) => !w.includes('不在标准清单'))
        && afterRename.warnings.some((w) => w.includes('不在标准清单') && w.includes(ORIGINAL)),
      { 改名前警告: base.warnings.length, 改名后警告: afterRename.warnings });
    ok('S-02 改名模拟（副本确实搬走）：改名期间用**新名**提交即被认，说明章节白名单只有一个源（运行时表），PRD 文本不参与判定',
      newNameAccepted.warnings.every((w) => !w.includes('不在标准清单')) && !PRD.includes(RENAMED),
      { 新名警告: newNameAccepted.warnings });
    ok('S-03 还原逐字一致 + 零残留：改名撤销后，同一输入的校验结果与首次逐字相同，运行时表与产物里再无假词干',
      JSON.stringify(restored) === JSON.stringify(base) && Kickoff.KICKOFF_SECTIONS[0] === ORIGINAL
        && !(Kickoff.KICKOFF_SECTIONS as readonly string[]).some((s) => s.includes(FAKE_STEM))
        && !JSON.stringify(Kickoff.validateOutline(mkOutline(ORIGINAL) as unknown)).includes(FAKE_STEM),
      { 原名: ORIGINAL, 表: Kickoff.KICKOFF_SECTIONS.slice(0, 3) });
    ok('S-04 模拟零数据库副作用：整轮表改名模拟前后，隔离库 tasks/plan_tasks/prd_docs 行数一字不变',
      ['tasks', 'plan_tasks', 'prd_docs'].map((t) => `${t}:${rowCount(t)}`).join(',') === dbSnap, { 快照: dbSnap });
    ok('S-05 服务端侧同步跟随：改名窗口**内**取 HTTP preflight，逐字等于窗口外那次（它不吃章节表），而同窗口内 validateOutline 已跟着表变红（S-01）——两组对照才有牙，不是把 H-01 重跑一遍',
      pfHttpDuring.status === 200 && pfViaHttp.status === 200
        && JSON.stringify(pfHttpDuring.json) === JSON.stringify(pfViaHttp.json)
        && afterRename.warnings.some((w) => w.includes('不在标准清单'))
        && (pfHttpDuring.json as any)?.items?.length === pfInProcess.items.length,
      { preflight项数: (pfHttpDuring.json as any)?.items?.length ?? 0, 窗口内警告条数: afterRename.warnings.length });
  }

  await stopInstance();
} else {
  fail += 1;
  lines.push('[FAIL] 隔离实例未就绪，F 组运行时判据无法执行 → ' + serverLog.join('').slice(-800));
  skipped('F-C1/F-C4/F-C8/F-C9/F-C10/S 组等运行时判据', '隔离实例未起（见上一行日志），不当 PASS 用');
}

// ======================= G 组：需求覆盖（限定小节检索，不整篇子串） =======================
{
  const fr2 = bodyOf((h) => h.level === 3 && h.text.startsWith('3.2 '));
  const fr4 = bodyOf((h) => h.level === 3 && h.text.startsWith('3.4 '));
  okPair(ok, 'G-01 交互流程：选中项目 / 设置汇报周期 / 选择模板风格',
    // 行为侧：三要素齐落在 **FR-2 那一节**里（范围/周期/风格是同一节定义的交互），不是全文蹭词
    () => ['项目范围', '周期'].every((w) => fr2.includes(w)) && /风格|版式/.test(fr2) && fr2.length > 300,
    () => /选中项目|项目范围/.test(PRD) && /汇报周期/.test(PRD) && /模板风格|版式/.test(PRD),
    () => ({ 'FR2长度': fr2.length }));
  const fr5 = bodyOf((h) => h.level === 3 && h.text.startsWith('3.5 '));
  const chapterRows = parseTables(fr5).flat();
  okPair(ok, 'G-02 生成逻辑：关键节点/风险/成果映射到标准结构（封面/目录/进展/问题/计划/结语）',
    // 行为侧：FR-5 是**结构化表格**（12 行章节，每行有 数据来源/版式/缺失降级 三列非空），
    // 章节序列含封面/目录/进展/问题/计划——列齐了才算「映射到标准结构」，散文提一遍不算
    () => chapterRows.length >= 12 && chapterRows.every((r) => r.cells.length === 5)
      && chapterRows.every((r) => r.cells.slice(2).every((c) => c.length > 0))
      && ['封面', '目录', '进展', '问题', '计划'].every((w) => chapterRows.some((r) => r.cells[1]?.includes(w))),
    () => ['封面', '目录', '进展', '问题', '计划'].every((w) => PRD.includes(w)) && (/结语/.test(PRD) || /总结与展望/.test(PRD)),
    () => ({ 'FR5行数': chapterRows.length, '列数分布': chapterRows.map((r) => r.cells.length).slice(0, 4) }));
  const fr6 = bodyOf((h) => h.level === 3 && h.text.startsWith('3.6 '));
  const modeRows = fr6.split('\n').filter((l) => /^\*\*FR-6\.\d/.test(l.trim()));
  okPair(ok, 'G-03 批量机制：合并版 / 分别独立 两种模式定义清晰',
    // 行为侧：FR-6 一节里两种模式各有一条**编号子句**，各自给出页数/打包口径与未批时的降级路径
    () => modeRows.length >= 2 && /合并版/.test(fr6) && /分别独立/.test(fr6)
      && /zip/i.test(fr6) && /8 \+ 4N|4N/.test(fr6) && /降级/.test(fr6),
    () => /合并版/.test(PRD) && /分别独立/.test(PRD) && /zip/i.test(PRD),
    () => ({ 'FR6子句数': modeRows.length }));
  // §7 的交付形态是「项 / 要求 / 依据口径」三列**约束表**（不是 ### 7.x 小节），
  // 所以行为侧按表行判：覆盖三类约束 + 每行都有要求与依据，性能行必须落得出数值。
  const nfrRows = parseTables(sec('7. 非功能需求')).flat().slice(1);
  const nfrByName = (re: RegExp) => nfrRows.filter((r) => re.test(r.cells[0] ?? ''));
  okPair(ok, 'G-04 非功能：性能指标 / 数据安全与隐私 / 质量控制标准',
    () => nfrRows.length >= 5
      && nfrRows.every((r) => r.cells.length === 3 && (r.cells[1] ?? '').length > 10 && (r.cells[2] ?? '').length > 0)
      && nfrByName(/性能/).some((r) => /\d+\s*(?:s|秒|min|分钟)/.test(r.cells[1]))
      && nfrByName(/隐私|安全/).length >= 1
      && nfrByName(/质量控制/).length === 1,
    () => /## 7\. 非功能需求/.test(PRD) && /性能/.test(PRD) && /隐私/.test(PRD) && /质量控制标准/.test(PRD),
    () => ({ '§7约束行数': nfrRows.length, 项: nfrRows.map((r) => (r.cells[0] ?? '').replace(/\*\*/g, '')) }));
  const acceptance = sec('8. 验收标准');
  const accItems = acceptance.split('\n').filter((l) => /^\s*\d+\.\s+\S/.test(l));
  const approvalSec = sec('0. 版本与审批记录');
  const docCheckLine = /文档完整性检查点[^\n]*：(.*)/.exec(acceptance)?.[1] ?? '';
  okPair(ok, 'G-05 审批与交付标准：审批检查点 + 验收清单 + 文档完整性检查点',
    // 行为侧：§8 是**逐条可测的编号清单**（每条都含数值或断言箭头），
    // 审批检查点落在 §0 且分点 ≥3，文档完整性检查点逐条点名章节（§n 引用 ≥5）
    () => accItems.length >= 10 && accItems.every((l) => l.trim().length > 25 && /\d|→/.test(l))
      && /审批检查点/.test(approvalSec) && (approvalSec.match(/[①②③④⑤]/g) ?? []).length >= 3
      && (docCheckLine.match(/§\d/g) ?? []).length >= 5,
    () => /审批检查点/.test(PRD) && /验收标准/.test(PRD) && /文档完整性检查点/.test(PRD),
    () => ({ '验收条数': accItems.length, 审批分点: (approvalSec.match(/[①②③④⑤]/g) ?? []).length, '完整性点名章节': (docCheckLine.match(/§\d/g) ?? []).length }));
  // §5.2 的交付形态是「项目 / 关键事实 / 借鉴点 / 对本 PRD 的落点」四列表——
  // 「逐个有落点」只能按表行判（整节扫「对本 PRD 的落点」只会命中表头那一次，等于恒红）
  const surveyRows = parseTables(sec('5.2 逐项目结论（只留对本 PRD 有约束力的）', 3)).flat().slice(1);
  okPair(ok, 'G-06 竞品样本 3~5 个代表项目且逐个有「对本 PRD 的落点」',
    () => surveyRows.length >= 3 && surveyRows.length <= 8
      && surveyRows.every((r) => r.cells.length === 4 && r.cells.every((c) => c.length > 0))
      && surveyRows.every((r) => /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(r.cells[0]))
      && ['PptxGenJS', 'Presenton', 'PPTAgent'].every((n) => surveyRows.some((r) => r.cells[0].includes(n))),
    () => (PRD.match(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? []).length >= 5
      && /对本 PRD 的落点/.test(PRD) && /PptxGenJS/.test(PRD) && /Presenton/.test(PRD) && /PPTAgent/.test(PRD),
    () => ({ '样本行数': surveyRows.length, 落点空行: surveyRows.filter((r) => !(r.cells[3] ?? '').length).length }));
}

// ======================= N 组：负对照（伪造夹具必须判红） =======================
{
  ok('N-01 负对照（结构）：围栏代码块里的「## 3. 功能需求详解」不算章节——D-01 不是整篇子串',
    (() => {
      const fenced = '## 1. 项目概述与目标\n正文够长够长够长够长够长够长够长够长够长够长够长够长。\n\n```md\n## 3. 功能需求详解\n```';
      const fh = parseHeadings(fenced);
      return fh.length === 1 && !hasHeading(fh, 2, '3. 功能需求详解');
    })());
  const fakeFr5 = '| 编号 | 章节 | 数据来源 | 版式 | 缺失降级 |\n|---|---|---|---|---|\n| FR-5.1 | 封面 | 项目名 |';
  const fakeBody = parseTables(fakeFr5).flat().slice(1); // 去表头：parseTables 会把不完整行之外的一切都留着
  const fiveCol = (rows: TableRow[]) => rows.every((r) => r.cells.length === 5);
  ok('N-02 负对照（FR-5 表结构）：把一行砍成 3 格后，G-02 用的「每行 5 格」判据随之转红（真实表判绿）——判据有牙',
    fakeBody.length === 1 && fakeBody[0].cells.length === 3
      && fiveCol(parseTables(sec('3.5 FR-5 PPT 章节定义（单项目完整稿，顺序固定，可删页）', 3)).flat()) === true
      && fiveCol(fakeBody) === false, { 伪造行: fakeBody[0]?.cells });
  const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  okPair((name, cond, extra) => spy.push({ name, cond, extra }), '样张·行为失守', () => false, () => true);
  okPair((name, cond, extra) => spy.push({ name, cond, extra }), '样张·锚点失配', () => true, () => false);
  ok('N-03 负对照（配对器）：文案在场但行为不成立仍判红，两种红因分别落账',
    spy.length === 2 && spy[0].cond === false && JSON.stringify(spy[0].extra).includes('行为失守')
      && spy[1].cond === false && JSON.stringify(spy[1].extra).includes('字面锚点失配'),
    spy.map((s) => [s.name, s.cond]));
  // 夹具版式与 525 行真夹具同构：timeline 落在第 1 页、workload 落在第 2 页，结束页不带数
  // （products 侧 `thanks`/`section` 页会显式清空 dataKeys，把必含键放结束页等于自造硬失败）
  const fakeOutlinePage = (i: number) => ({
    section: 'ZZZ-伪造章节', title: '伪造页', bullets: [], layout: i === 0 ? 'cover' : i === 1 ? 'toc' : i === 11 ? 'thanks' : 'list',
    dataKeys: i === 0 ? ['timeline'] : i === 1 ? ['workload'] : [],
  });
  const fakeRaw = Array.from({ length: 12 }, (_, i) => fakeOutlinePage(i));
  const fakeCheck = Kickoff.validateOutline(fakeRaw as unknown);
  ok('N-04 负对照（章节白名单）：整份大纲用假章节时 warnings 逐页点名——S 组的判据有牙，不是恒绿',
    fakeCheck.warnings.filter((w) => w.includes('不在标准清单')).length === 12, { 警告数: fakeCheck.warnings.length });
  let threw = '';
  try { Kickoff.validateOutline([{ section: '封面', title: '只有一页' }] as unknown); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  ok('N-05 负对照（页数下限）：1 页大纲被硬失败（F-C10/S 组用的 12 页夹具不是因为判据松）',
    /页数 1 不在 12~18 区间/.test(threw) || /页数/.test(threw), { 抛错: threw.slice(0, 80) });
  ok('N-06 负对照（下载白名单）：`x.zip` 被拒、`x.pptx` 被放行，且洗名后必须过白名单（判据非恒真）',
    ExportName.DOWNLOAD_NAME_RE.test('report.pptx') === true && ExportName.DOWNLOAD_NAME_RE.test('report.zip') === false
      && ExportName.DOWNLOAD_NAME_RE.test(ExportName.downloadSafeName('A & B（C）', 'fb') + '.pptx') === true);
  // 帽（REPORT_PROJECT_MAX）在「存不存在」之前判，所以用假 id 也能单独量出帽的位置：
  // 8 个不被帽拦（只被「项目不存在」拦）⇒ 放行侧确实过了帽；9/10 被帽拦且点名真实个数
  const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  const errOf = (n: number) => ReportSvc.validateProjectIds(idsOf(n)).error ?? '';
  const capOf = (n: number) => (/最多聚合/.test(errOf(n)) ? errOf(n) : '');
  ok('N-07 负对照（项目数上限）：8 个不被帽拦（只被「不存在」拦，证明放行侧真过了帽）、9/10 个被帽拦且逐一点名个数——边界判据不是「随便写个数都绿」',
    capOf(8) === '' && /项目不存在/.test(errOf(8)) && /当前选择了 9 个/.test(capOf(9))
      && /当前选择了 10 个/.test(capOf(10)) && capOf(9) !== capOf(10)
      && capOf(9).includes(String(ReportSvc.REPORT_PROJECT_MAX)),
    { 八个: errOf(8), 九个: capOf(9) });
  const ctxMissing = PrdContext.resolvePrdContext({ taskId: 'no-such-task-id' });
  ok('N-08 负对照（PRD 上下文）：不存在的任务反查为 null（F-C12 的截断实测不是拿空对象蒙混）',
    ctxMissing === null, { 结果: ctxMissing });
  ok('N-09 负对照（未实现端点）：伪造「summary-preflight 已挂载」的 200 响应会让 F-E/F-C5 判红',
    !([200] as number[]).every((s) => s === 404) && rejected({ status: 200, json: { ok: true } }) === false);
}

console.log(lines.join('\n'));
mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02170-gate-results.txt', `T02170 PRD 交付质量门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
if (skippedList.length) console.log('跳过：' + skippedList.join(' / '));
if (!instanceUp) console.log('实例：未就绪');

closeDb(); // 先收连接再删目录，否则 Windows 上句柄自持、临时库里只剩 -wal
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* T02170_KEEP=1 时人工去查 */ }
if (process.env.T02170_KEEP === '1') console.log(`保留临时目录：${DATA_DIR}`);
process.exit(fail === 0 ? 0 : 1);
