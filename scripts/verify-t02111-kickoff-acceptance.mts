/**
 * T02111 门（PRD §8 验收 3/4/5/6/8 + K8）：启动会 PPT 端到端验收——API 冒烟 + 真产物解包 XML 断言 + 数字一致性。
 *
 * T02293 改判（本版）：
 *   - 判据 2：**不再复制生产库、不再钉 mtask四期**——空目录起库，门内自建两个夹具项目
 *     （主项目：长 PRD + 4 需求 + 2 里程碑 + 7 条计划 + 4 用例 + 3 条估算；工期项目：短 PRD、
 *     无估算、有工期），P1~P7 全部在夹具上独立复算。A-00b/A-00c 当面自证样本与夹具形状。
 *   - 判据 1：U/A/B/C/D/E 组只打 HTTP 响应、库查询、真 .pptx 解包 XML 与产品函数返回值。
 *   - 判据 3：残留字面锚（源码白名单、前端候选、PRD 字段、错误文案、页脚口径、告警措辞）
 *     全部降级为 `okPair` 字面腿；行为腿各自独立（真实提示词、真实 done 事件、真产物页数、
 *     真库口径），行为红⇒该条红，行为绿而锚失配⇒记「字面锚点失配（行为在）」交人判定。
 *   - 判据 4：N 组负对照——空源码探针、HEAD 在场性、负向锚注入、抽干实测料、逐锚改名模拟、
 *     11 条行为腿各按一类破坏形态转假、okPair 契约、样本夹具反证。
 *   - 反模式 11：字面腿取证面一律 `git show HEAD:`（工作树可能躺着别的会话的过期产品文件）。
 *   - 临时根优先 D:（C: 常年 0 可用会假性 SQLITE_FULL）。
 *
 * T02769 批㉜ 改判（中文串条件逐条三分判定 + 取数键拆配，实测读数见 N-07/N-08/N-09）：
 *   - 判据 3 补齐：门自造 mock 的**路由键/计数键**、逐页装配 stage 的**取数键**、量词「人天 / 条」
 *     原先都是「产品文案 + 行为计数」混在同一条件里，改措辞（等价重构）与功能失守都红且红因不可区分；
 *     现主键改走文案无关面（JSON 字段契约、n/N 分式、<a:t> 数字抽取），中文面降级为字面腿/兜底，
 *     N-08c 逐把键点名今日落在哪一面（落到兜底=形态漂移，不再让功能腿冒红）。
 *   - 反模式 49 新形态：`done.warnings` 里根本没有「时间线/回落列表」字样（kickoffBuilder 的 note
 *     不进 warnings），旧降级键是**恒假死通道**——被当豁免前置件等于豁免永不生效却无人点名。
 *     降级判据改结构键（刚性表格 + 无轴/菱形），N-08a 用两份合成副本一正一反证两键的承重关系。
 *   - 判据 2/4 的「被证明的豁免」：N-07 逐条登记每条中文串「是谁生成的」并 `git show HEAD:` 命中生成者；
 *     N-07b 证明三条门自造夹具文案在启动会产品四面零命中，且带正对照（探针坏了不能算零命中）。
 *
 * 用法（better-sqlite3 需匹配当前 Node ABI）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02111-kickoff-acceptance.mts
 * 环境变量：`T02111_PORT`（默认随机 39500+rand300）。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import Database from 'better-sqlite3';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const PORT = Number(process.env.T02111_PORT ?? 39_500 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02111-acc-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_DIR = join(DATA_DIR, 'tmp');
// 进程内 import 的 server 服务（collectBundle）也读这份夹具库：getDb() 首次使用时解析 MTask_DATA_DIR。
process.env.MTask_DATA_DIR = DATA_DIR;

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const killTree = (pid?: number) => {
  if (!pid) return;
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
};

// =====================================================================
// 取证面：字面腿只读已提交树（反模式 11）
// =====================================================================
const HEAD_CACHE = new Map<string, string>();
function headSource(rel: string): string {
  if (HEAD_CACHE.has(rel)) return HEAD_CACHE.get(rel) as string;
  let src = '';
  try { src = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch { src = ''; }
  HEAD_CACHE.set(rel, src);
  return src;
}
const HEAD = {
  svc: headSource('server/src/services/kickoffService.ts'),
  panel: headSource('web/src/pages/KickoffPptPanel.tsx'),
  prd: headSource('docs/PRD-项目启动会PPT生成.md'),
  routes: headSource('server/src/routes/plans.ts'),
};

// =====================================================================
// 夹具：空目录起库，门内自建（判据 2）
// =====================================================================
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = '2026-10-18T00:00:00.000Z';
const WS_DIR = join(DATA_DIR, 'fixture-ws');
mkdirSync(WS_DIR, { recursive: true });
const fdb = getDb();

const LONG_PRD = `# 门夹具 PRD\n\n${'需求说明。'.repeat(1200)}`;
const SHORT_PRD = `# 门夹具短 PRD\n\n${'进度与验收。'.repeat(200)}`;
const MAIN = { id: 'fix-main', name: '门夹具启动会' };
const DUR = { id: 'fix-dur', name: '门夹具工期口径' };

const insProject = fdb.prepare(
  'INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at, workspace_path) VALUES (?, ?, ?, 0, ?, ?, ?)',
);
insProject.run(MAIN.id, MAIN.name, '', T, T, WS_DIR);
insProject.run(DUR.id, DUR.name, '', T, T, '');

const insDoc = fdb.prepare(
  'INSERT INTO prd_docs (id, project_id, filename, content_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
);
insDoc.run('doc-main', MAIN.id, '门夹具PRD.md', LONG_PRD, T, T);
insDoc.run('doc-dur', DUR.id, '门夹具短PRD.md', SHORT_PRD, T, T);

const insReq = fdb.prepare(
  `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, '', '', 'normal', 'todo', ?, ?, ?)`,
);
const mainReqs = [
  ['req-1', 'FR-001', '登录与权限'],
  ['req-2', 'FR-002', '计划管理'],
  ['req-3', 'FR-003', '估算面板'],
  ['req-4', 'FR-004', 'Excel 导入导出'],
] as const;
mainReqs.forEach(([id, no, title], i) => insReq.run(id, MAIN.id, no, title, i, T, T));
const durReqs = [
  ['dreq-1', 'B-001', '排期维护'],
  ['dreq-2', 'B-002', '进度跟踪'],
  ['dreq-3', 'B-003', '验收留痕'],
] as const;
durReqs.forEach(([id, no, title], i) => insReq.run(id, DUR.id, no, title, i, T, T));

interface PlanSeed {
  id: string; title: string; start: string; end: string; dur: number;
  kind: 'normal' | 'milestone'; cx: number | null; assignee: string; reqs: string[] | null;
}
const insPlan = fdb.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', ?, ?, ?, ?, ?, ?, ?, '')`,
);
const mainPlans: PlanSeed[] = [
  { id: 'm1', title: '阶段一：需求与设计', start: '2026-11-02', end: '2026-11-13', dur: 10, kind: 'milestone', cx: null, assignee: '', reqs: null },
  { id: 'q1', title: '需求梳理', start: '2026-11-02', end: '2026-11-06', dur: 5, kind: 'normal', cx: 3, assignee: '甲', reqs: ['req-1', 'req-2'] },
  { id: 'q2', title: '方案设计', start: '2026-11-09', end: '2026-11-12', dur: 4, kind: 'normal', cx: 2, assignee: '乙', reqs: ['req-2'] },
  { id: 'm2', title: '阶段二：实施与验收', start: '2026-11-16', end: '2026-12-05', dur: 15, kind: 'milestone', cx: null, assignee: '', reqs: null },
  { id: 'q3', title: '开发实施', start: '2026-11-16', end: '2026-11-27', dur: 10, kind: 'normal', cx: 5, assignee: '甲', reqs: ['req-2', 'req-3'] },
  { id: 'q4', title: '测试验收', start: '2026-11-30', end: '2026-12-03', dur: 4, kind: 'normal', cx: 1, assignee: '丙', reqs: null },
  { id: 'q5', title: '上线发布', start: '2026-12-04', end: '2026-12-05', dur: 2, kind: 'normal', cx: null, assignee: '', reqs: null },
  { id: 'q6', title: '归档计划不应出现', start: '2026-12-08', end: '2026-12-09', dur: 2, kind: 'normal', cx: 1, assignee: '', reqs: null },
];
mainPlans.forEach((p, i) => insPlan.run(p.id, MAIN.id, p.title, p.start, p.end, p.dur, p.assignee, i, T, T, p.kind, p.cx, p.reqs ? JSON.stringify(p.reqs) : null));
const durPlans: PlanSeed[] = [
  { id: 'dm1', title: 'B 阶段一', start: '2026-11-02', end: '2026-11-04', dur: 0, kind: 'milestone', cx: null, assignee: '', reqs: null },
  { id: 'd1', title: '排期梳理', start: '2026-11-02', end: '2026-11-04', dur: 3, kind: 'normal', cx: 2, assignee: '甲', reqs: ['dreq-1'] },
  { id: 'd2', title: '进度跟踪实现', start: '2026-11-05', end: '2026-11-10', dur: 4, kind: 'normal', cx: 3, assignee: '乙', reqs: ['dreq-2'] },
  { id: 'd3', title: '验收留痕实现', start: '2026-11-11', end: '2026-11-17', dur: 5, kind: 'normal', cx: null, assignee: '甲', reqs: ['dreq-3'] },
];
durPlans.forEach((p, i) => insPlan.run(p.id, DUR.id, p.title, p.start, p.end, p.dur, p.assignee, i, T, T, p.kind, p.cx, p.reqs ? JSON.stringify(p.reqs) : null));
fdb.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ? WHERE id = ?').run(T, 'q6');

const insCase = fdb.prepare(
  'INSERT INTO test_cases (id, project_id, req_id, case_no, title, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
mainReqs.forEach(([rid, no], i) => insCase.run(`tc-${i + 1}`, MAIN.id, rid, `TC-${no}`, `用例 ${i + 1}`, 'P1', T, T));

const insEst = fdb.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, 'dev', 'man_day', 4, 5, 6, 'manual', '', ?, ?)`,
);
['q1', 'q2', 'q3'].forEach((pid, i) => insEst.run(`est-${i + 1}`, MAIN.id, pid, T, T));
closeDb();

const db = new Database(join(DATA_DIR, 'mtask.db'), { readonly: true });
const q = <R>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as R[];
const one = <R>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as R | undefined;

/** 独立复算：库内真实条数（验收 3 的对数基准，不走服务端口径） */
function truthCounts(projectId: string) {
  const plans = q<{ n: number }>('SELECT COUNT(*) n FROM plan_tasks WHERE project_id = ? AND archived = 0', projectId)[0].n;
  return {
    P1: q<{ n: number }>('SELECT COUNT(*) n FROM prd_docs WHERE project_id = ?', projectId)[0].n,
    P2: q<{ n: number }>('SELECT COUNT(*) n FROM prd_requirements WHERE project_id = ?', projectId)[0].n,
    P3: plans,
    P4: q<{ n: number }>("SELECT COUNT(*) n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND kind = 'milestone'", projectId)[0].n,
    P5: q<{ n: number }>('SELECT COUNT(*) n FROM test_cases WHERE project_id = ?', projectId)[0].n,
    P6: q<{ n: number }>('SELECT COUNT(*) n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND (complexity IS NOT NULL OR (duration_days IS NOT NULL AND duration_days > 0))', projectId)[0].n,
    P7: (() => {
      const w = q<{ p: string | null }>('SELECT workspace_path p FROM projects WHERE id = ?', projectId)[0];
      return w?.p && existsSync(w.p) ? 1 : 0;
    })(),
  };
}

/** 夹具声明（与种子同源；A-00c 用 SQL 复算自证，防止插错列/漏行） */
const FIXTURE = {
  main: { projectId: MAIN.id, name: MAIN.name, p1: 1, p2: 4, p3: 7, p4: 2, p5: 4, p6: 7, p7: 1 },
  dur: { projectId: DUR.id, name: DUR.name, p1: 1, p2: 3, p3: 4, p4: 1, p5: 0, p6: 3, p7: 0, sumDays: 12 },
};

// =====================================================================
// 服务端运行时白名单（行为腿的权威；源码只作字面腿）
// =====================================================================
const Svc = await import('../server/src/services/kickoffService.ts');
const rtSections = [...(Svc.KICKOFF_SECTIONS ?? [])] as string[];
const rtLayouts = [...(Svc.KICKOFF_LAYOUTS ?? [])] as string[];
const rtKeys = [...(Svc.KICKOFF_DATA_KEYS ?? [])] as string[];

const strArray = (src: string, re: RegExp): string[] => {
  const m = re.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
};
const same = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i]);
const parseSvcSections = (src: string) => strArray(src, /export const KICKOFF_SECTIONS = \[([\s\S]*?)\] as const/);
const parseSvcLayouts = (src: string) => strArray(src, /export const KICKOFF_LAYOUTS = \[([\s\S]*?)\] as const/);
const parseSvcKeys = (src: string) => strArray(src, /export const KICKOFF_DATA_KEYS = \[([\s\S]*?)\] as const/);
const parseFeSections = (src: string) => strArray(src, /const SECTIONS = \[([\s\S]*?)\];/);
const parseFeLayouts = (src: string) => strArray(src, /const LAYOUTS = \[([\s\S]*?)\];/);
const prdFieldsOf = (src: string) => {
  const row = src.split('\n').find((l) => l.includes('kickoff-ppt-stream') && l.includes('`done`')) ?? '';
  return [...((/`done`（含\s*([^）]*)/.exec(row)?.[1] ?? '').matchAll(/`([A-Za-z]\w*)/g))].map((m) => m[1]);
};
const implDoneKeysOf = (src: string) =>
  [...((/send\('done',\s*\{([\s\S]*?)\}\s*\);/.exec(src)?.[1] ?? '').matchAll(/(\w+):/g))].map((m) => m[1]);

const feSections = parseFeSections(HEAD.panel);
const feLayouts = parseFeLayouts(HEAD.panel);
const prdFields = prdFieldsOf(HEAD.prd);

// =====================================================================
// mock AI：大纲回 13 页（含 999 幻觉）；措辞段回合规改写
// =====================================================================
let outlinePrompt = '';
let wordingCalls = 0;
// 批㉜（T02769，反模式 49）：mock 原先只拿产品提示词里的中文串「【风险条目」当路由键。
// 产品改了措辞⇒措辞请求会被当大纲请求回答⇒wordingCalls=0，E-05 以「AI 措辞没进产物」的红出现，
// 真因却是 mock 取数键失配。现双键路由（JSON 字段契约优先、中文措辞兜底）并把命中的是哪把键留证。
let mockRouteBy = '未发起措辞请求';
let mockCountSrc = '未发起措辞请求';
const hallucinatedBullets = (section: string): string[] =>
  section === '项目需求' ? ['需求 999 条已梳理', '计划 999 条排期中'] : ['范围与交付物', '责任分工'];

function outlinePayload(pages: number) {
  return {
    outline: Array.from({ length: pages }, (_, i) => {
      const section = i === 0 ? '封面' : i === 1 ? '议程' : i === 2 ? '项目背景' : i === 3 ? '项目团队介绍'
        : i === 4 ? '项目需求' : i === 5 ? '项目范围' : i === 6 ? '项目计划' : i === 7 ? '工作量评估'
          : i === 8 ? '测试与质量策略' : i === 9 ? '项目风险' : i === 10 ? '沟通管理' : i === 11 ? '附录' : '项目需求';
      const dataKeys = i === 4 ? ['reqStats', 'reqList'] : i === 6 ? ['timeline', 'planRows']
        : i === 7 ? ['workload'] : i === 8 ? ['coverage'] : i === 9 ? ['risks'] : i === 5 ? ['reqList']
          : i === 3 ? ['assignees'] : i === 11 ? ['preflight', 'workspace'] : ['preflight'];
      return {
        section,
        title: i === 0 ? '项目启动会' : `${section} · 第 ${i + 1} 页`,
        bullets: section === '封面' ? [] : hallucinatedBullets(section),
        dataKeys,
        layout: i === 0 ? 'cover' : i === 1 ? 'toc' : i === 6 ? 'timeline' : i === 7 ? 'chart' : i === 10 ? 'list' : 'table',
      };
    }),
  };
}

let mockPages = 13;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    let user = '';
    let sys = '';
    try {
      const j = JSON.parse(body);
      sys = String((j.messages ?? []).filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n'));
      user = String((j.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n'));
    } catch { /* 坏请求直接回空 */ }
    const jsonKey = /"risks"\s*:\s*\[/.test(user) && /"comms"\s*:\s*\[/.test(user) && !/"outline"/.test(user);
    const cnKey = /【风险条目/.test(user);
    const isWording = jsonKey || cnKey;
    let content: string;
    if (isWording) {
      wordingCalls += 1;
      mockRouteBy = jsonKey ? 'JSON 字段契约（文案无关）' : '中文措辞兜底（漂移信号）';
      const want = /条数分别为 (\d+) 与 (\d+)。/.exec(user);
      const items = [...user.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => m[1].trim());
      const nRisks = want ? +want[1] : items.length;
      const nComms = want ? +want[2] : 0;
      mockCountSrc = want ? '文案键「条数分别为 N 与 M」' : `兜底：枚举行计数 ${items.length} 条（文案键已失配）`;
      content = JSON.stringify({
        risks: Array.from({ length: nRisks }, (_, i) => ({
          item: (items[i] ?? `风险 ${i + 1}`).slice(0, 40),
          impact: '会上确认影响面',
          mitigation: '会上明确责任方与时限',
        })),
        comms: Array.from({ length: nComms }, (_, i) => (i === 0 ? '周会跟里程碑节点开' : '变更先登记进需求跟踪矩阵')),
      });
    } else {
      outlinePrompt = `${sys}\n${user}`;
      content = JSON.stringify(outlinePayload(mockPages));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 隔离实例：空库起（夹具已写好），不复制生产库
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
const bye = () => { killTree(child.pid); try { mock.close(); } catch { /* 已关 */ } };
process.on('exit', bye);

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
async function call(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* 二进制 */ }
  return { status: res.status, body, text };
}
interface Sse { status: number; events: Array<{ event: string; data: any }>; json: any }
async function sse(path: string, body: unknown): Promise<Sse> {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('event-stream')) return { status: res.status, events: [], json: await res.json().catch(() => null) };
  const events: Array<{ event: string; data: any }> = [];
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
      const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
      const dataStr = /^data: (.*)$/m.exec(chunk)?.[1] ?? '{}';
      try { events.push({ event, data: JSON.parse(dataStr) }); } catch { /* 坏帧 */ }
      i = raw.indexOf('\n\n');
    }
  }
  return { status: res.status, events, json: null };
}

// =====================================================================
// 运行期实测料（行为腿只读它；N-02 会整包抽干验证行为腿不是恒真）
// =====================================================================
const EV: Record<string, any> = {
  rt: { sections: rtSections, layouts: rtLayouts, keys: rtKeys },
  fe: { sections: feSections, layouts: feLayouts },
  prdFields,
};
interface LitCtx {
  src: { svc: string; panel: string; prd: string; routes: string };
  done: any;
  err25: string;
  pageStages: number;
  footerDur: string;
  warnings: string[];
}
const baseCtx = (e: Record<string, any> = EV, src = HEAD): LitCtx => ({
  src,
  done: e.done,
  err25: e.err25 ?? '',
  pageStages: e.pageStages ?? 0,
  footerDur: e.durWorkload?.footer ?? '',
  warnings: e.warnings ?? [],
});

const litG1 = (c: LitCtx) => same(parseSvcSections(c.src.svc), rtSections)
  && same(parseSvcLayouts(c.src.svc), rtLayouts) && same(parseSvcKeys(c.src.svc), rtKeys);
const litG2 = (c: LitCtx) => same(parseFeSections(c.src.panel), rtSections);
const litG3 = (c: LitCtx) => same(parseFeLayouts(c.src.panel), rtLayouts);
const litG4 = (c: LitCtx) => !c.src.panel.includes('.pptx`') && c.src.panel.includes('result.fileName');
const litG5 = (c: LitCtx) => {
  const docFields = prdFieldsOf(c.src.prd);
  const impl = implDoneKeysOf(c.src.routes);
  return docFields.length >= 3 && impl.length >= 3 && docFields.every((f) => impl.includes(f));
};
const litG6 = (c: LitCtx) => !c.src.prd.includes('downloadToken');
const litB03 = (c: LitCtx) => c.err25.includes('不在 12~18 区间');
const litB06 = (c: LitCtx) => c.src.svc.includes('已装配：');
const litD09 = (c: LitCtx) => c.footerDur.includes('工期口径');
const litE04 = (c: LitCtx) => c.warnings.some((w) => w.includes('库内实为') && w.includes('999'));
const litE05 = (c: LitCtx) => !c.warnings.some((w) => w.includes('风险措辞 AI 失败'));

const J = {
  g1: (e: Record<string, any>) => {
    const p = String(e.outlinePrompt ?? '');
    return !!e.rt && e.rt.sections.length > 0 && e.rt.layouts.length > 0 && e.rt.keys.length > 0
      && new Set(e.rt.sections).size === e.rt.sections.length
      && e.rt.sections.every((s: string) => p.includes(s))
      && e.rt.layouts.every((s: string) => p.includes(s))
      && e.rt.keys.every((s: string) => p.includes(s));
  },
  g2: (e: Record<string, any>) => {
    const p = String(e.outlinePrompt ?? '');
    return !!e.fe?.sections?.length && e.fe.sections.every((s: string) => p.includes(s));
  },
  g3: (e: Record<string, any>) => {
    const p = String(e.outlinePrompt ?? '');
    return !!e.fe?.layouts?.length && e.fe.layouts.every((s: string) => p.includes(s));
  },
  g4: (e: Record<string, any>) => !!e.done?.fileName
    && String(e.done.fileName).includes(FIXTURE.main.name)
    && String(e.done.fileName).endsWith('.pptx') && Number(e.downloadBytes) > 20_000,
  g5: (e: Record<string, any>) => !!e.prdFields?.length && e.prdFields.length >= 3
    && e.prdFields.every((f: string) => !!e.done && Object.prototype.hasOwnProperty.call(e.done, f)),
  g6: (e: Record<string, any>) => !!e.done?.token && e.done?.downloadToken === undefined,
  b03: (e: Record<string, any>) => e.err25Status === 400 && typeof e.err25 === 'string' && e.err25.length > 0,
  b06: (e: Record<string, any>) => Number(e.slideCount) > 0 && e.done?.pageCount === e.slideCount
    && Number(e.pageStages) >= 1 && Number(e.stageCount) >= Number(e.pageStages),
  d09: (e: Record<string, any>) => e.durWorkload?.source === 'duration'
    && e.durWorkload?.expected === FIXTURE.dur.sumDays,
  e04: (e: Record<string, any>) => !!e.warnings?.some((w: string) => w.includes('999') && w.includes(String(e.reqTruth)))
    && (e.reqNums ?? []).includes(String(e.reqTruth)) && !(e.reqNums ?? []).includes('999'),
  e05: (e: Record<string, any>) => Number(e.wordingCalls) >= 1
    && !!e.allXml?.some((x: string) => x.includes('周会跟里程碑节点开')),
};

interface PairSpec {
  id: string;
  anchors: string[];
  scope: 'svc' | 'panel' | 'prd' | 'err25' | 'footerDur' | 'warnings';
  negative?: boolean;
  lit: (c: LitCtx) => boolean;
  behavior: (e: Record<string, any>) => boolean;
}
const PAIRS: PairSpec[] = [
  { id: 'G-01', anchors: ['KICKOFF_SECTIONS', 'KICKOFF_LAYOUTS', 'KICKOFF_DATA_KEYS'], scope: 'svc', lit: litG1, behavior: J.g1 },
  { id: 'G-02', anchors: [feSections[0], feSections[1], feSections.at(-1) ?? ''], scope: 'panel', lit: litG2, behavior: J.g2 },
  { id: 'G-03', anchors: ['cover', 'timeline', 'chart'], scope: 'panel', lit: litG3, behavior: J.g3 },
  { id: 'G-04', anchors: ['result.fileName'], scope: 'panel', lit: litG4, behavior: J.g4 },
  { id: 'G-05', anchors: ['kickoff-ppt-stream'], scope: 'prd', lit: litG5, behavior: J.g5 },
  { id: 'G-06', anchors: ['downloadToken'], scope: 'prd', negative: true, lit: litG6, behavior: J.g6 },
  { id: 'B-03', anchors: ['不在 12~18 区间'], scope: 'err25', lit: litB03, behavior: J.b03 },
  { id: 'B-06', anchors: ['已装配：'], scope: 'svc', lit: litB06, behavior: J.b06 },
  { id: 'D-09', anchors: ['工期口径'], scope: 'footerDur', lit: litD09, behavior: J.d09 },
  { id: 'E-04', anchors: ['库内实为'], scope: 'warnings', lit: litE04, behavior: J.e04 },
  { id: 'E-05', anchors: ['风险措辞 AI 失败'], scope: 'warnings', negative: true, lit: litE05, behavior: J.e05 },
];
function emitPair(id: string, label: string) {
  const p = PAIRS.find((x) => x.id === id) as PairSpec;
  okPair(ok, label,
    () => p.behavior(EV),
    () => p.lit(baseCtx()),
    () => ({ 锚点: p.anchors, 取证: 'git show HEAD: / 运行期实测', 行为料: { done: EV.done, err25: EV.err25, pageStages: EV.pageStages, footer: EV.durWorkload?.footer?.slice(0, 60), warn: (EV.warnings ?? []).slice(0, 3) } }));
}

// =====================================================================
// A 组：判据 2 —— 夹具自证 + P1~P7 逐条对数
// =====================================================================
ok('A-00 门内空目录起库并写入夹具（零生产库副本；库文件只落在临时 DATA_DIR）',
  existsSync(join(DATA_DIR, 'mtask.db')) && resolve(DATA_DIR).startsWith(resolve(TMP_ROOT)),
  { dataDir: DATA_DIR });
const sample = [FIXTURE.main, FIXTURE.dur];
const sampleJudge = (list: Array<{ projectId: string; name: string }>) =>
  list.length === 2 && list.every((p) => p.projectId === FIXTURE.main.projectId || p.projectId === FIXTURE.dur.projectId);
ok('A-00b 对数样本仅含门内夹具项目（生产项目名/ID 不得进入样本）',
  sampleJudge(sample), sample.map((p) => p.name));
const shapeOk = [FIXTURE.main, FIXTURE.dur].every((f) => {
  const t = truthCounts(f.projectId);
  return t.P1 === f.p1 && t.P2 === f.p2 && t.P3 === f.p3 && t.P4 === f.p4 && t.P5 === f.p5 && t.P6 === f.p6 && t.P7 === f.p7;
});
ok('A-00c 夹具形状自证：SQL 复算与夹具声明逐项一致（P1~P7，含主项目 workspace 可用/工期项目 workspace 为空两态）',
  shapeOk, { main: truthCounts(FIXTURE.main.projectId), dur: truthCounts(FIXTURE.dur.projectId) });

if (!(await waitUp())) {
  ok('B-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('B-00 隔离实例启动', true, { port: PORT });
  const tool = await call('POST', '/aitools', {
    name: 't02111-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-outline', timeoutMs: 20000,
  });
  const toolId = tool.body?.id as string | undefined;
  ok('B-01 mock AI 工具已建（不触真实模型）', !!toolId, tool.body);

  for (const p of sample) {
    const pf = await call('GET', `/plans/kickoff-preflight?projectId=${p.projectId}`);
    const t = truthCounts(p.projectId);
    const item = (k: string) => (pf.body?.items ?? []).find((i: any) => i.key === k)?.count;
    ok(`A-01 [${p.name}] preflight 200 且 blocked=false`, pf.status === 200 && pf.body?.blocked === false, pf.body);
    ok(`A-02 [${p.name}] P1 PRD 文档条数 = 库内 prd_docs`, item('P1') === t.P1, { api: item('P1'), sql: t.P1 });
    ok(`A-03 [${p.name}] P2 需求矩阵条数 = 库内 prd_requirements`, item('P2') === t.P2, { api: item('P2'), sql: t.P2 });
    ok(`A-04 [${p.name}] P3 计划条数 = 库内未归档 plan_tasks`, item('P3') === t.P3, { api: item('P3'), sql: t.P3 });
    ok(`A-05 [${p.name}] P4 里程碑数 = 库内 kind=milestone 行数`, item('P4') === t.P4, { api: item('P4'), sql: t.P4 });
    ok(`A-06 [${p.name}] P5 测试用例数 = 库内 test_cases`, item('P5') === t.P5, { api: item('P5'), sql: t.P5 });
    const reqs = await call('GET', `/plans/prd-requirements?projectId=${p.projectId}`);
    const reqRows = Array.isArray(reqs.body) ? reqs.body : (reqs.body?.items ?? reqs.body?.requirements ?? []);
    ok(`A-07 [${p.name}] P2 与 /plans/prd-requirements 行数一致`, reqRows.length === t.P2, { ep: reqRows.length, sql: t.P2 });
    const planList = await call('GET', `/plans?projectId=${p.projectId}`);
    const planRows = (Array.isArray(planList.body) ? planList.body : (planList.body?.items ?? [])).filter((r: any) => !r.archived);
    ok(`A-08 [${p.name}] P3 与 /plans 未归档行数一致`, planRows.length === t.P3, { ep: planRows.length, sql: t.P3 });
    ok(`A-09 [${p.name}] P6 复杂度/工期条数 = 库内有计划数据的行数`, item('P6') === t.P6, { api: item('P6'), sql: t.P6 });
    ok(`A-10 [${p.name}] P7 工作空间可用性与库内登记路径一致`, item('P7') === t.P7, { api: item('P7'), sql: t.P7 });
  }

  const PID = FIXTURE.main.projectId;

  // ---------------- B 组：验收 4 大纲 → done → 下载 → 解包 ----------------
  const ol = await call('POST', '/plans/kickoff-ppt-outline', { projectId: PID, toolId });
  const outline: any[] = ol.body?.outline ?? [];
  ok('B-02 大纲端点 200 且页数落 12~18 建议区间', ol.status === 200 && outline.length >= 12 && outline.length <= 18,
    { status: ol.status, pages: outline.length, err: ol.body?.error });
  mockPages = 25;
  const ol2 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: PID, toolId });
  EV.err25Status = ol2.status;
  EV.err25 = String(ol2.body?.error ?? '');
  emitPair('B-03', 'B-03 AI 失控给 25 页 → 大纲段判失败（行为腿：状态 400；字面腿：12~18 铁律文案）');
  mockPages = 13;
  const ol3 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: PID, toolId });
  const outline13: any[] = ol3.body?.outline ?? [];
  const olB = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIXTURE.dur.projectId, toolId });
  ok('B-04 truncated 语义 = PRD 摘要截断（长 PRD 项目 true / 短 PRD 项目 false，不是页数裁剪）',
    ol3.body?.truncated === true && olB.body?.truncated === false,
    { main: ol3.body?.truncated, dur: olB.body?.truncated, long: LONG_PRD.length, short: SHORT_PRD.length });

  const edited = outline13.slice(1).map((o, i) => (i === 0 ? { ...o, title: `人工改过 · ${o.title}` } : o));
  const st = await sse('/plans/kickoff-ppt-stream?projectId=' + PID + '&toolId=' + toolId, { projectId: PID, toolId, outline: edited });
  const done = st.events.find((e) => e.event === 'done')?.data;
  EV.done = done;
  EV.outlinePrompt = outlinePrompt;
  // stage 里除逐页装配还有取数/措辞等过程播报。批㉜（T02769，反模式 49）：取数键不能只认产品文案
  // 「页 n/N 已装配」——文案一改，pageStages=0 会让 B-06 以「逐页装配失守」的红出现。
  // 现按「文案锚优先、n/N 分式兜底」两把键取数，并把命中的是哪把键留证（N-08 探针据此分辨漂移与失守）。
  const stageMsgs = st.events.filter((e) => e.event === 'stage').map((e) => String(e.data?.msg ?? ''));
  const pageStagesText = stageMsgs.filter((m) => /页 \d+\/\d+ 已装配/.test(m)).length;
  const pageStagesFrac = stageMsgs.filter((m) => /\d+\/\d+/.test(m)).length;
  EV.pageStages = pageStagesText > 0 ? pageStagesText : pageStagesFrac;
  EV.pageStageKey = pageStagesText > 0 ? '文案锚「页 n/N 已装配」'
    : pageStagesFrac > 0 ? '分式兜底 n/N（文案锚已失配）' : '两键皆失配（stage 在场但无可计数形态）';
  EV.stageCount = stageMsgs.length;
  ok('B-07 done 带 token + fileName + pageCount（pageCount ≥ 大纲页数）',
    !!done?.token && !!done?.fileName && Number(done?.pageCount ?? 0) >= edited.length, done);
  ok('B-08 fileName 通过下载白名单正则（生成侧与下载侧同源洗名，T02104）',
    /^[A-Za-z0-9._\u4e00-\u9fa5-]+\.pptx$/.test(String(done?.fileName ?? '')), done?.fileName);

  const tokenPath = join(TMP_DIR, String(done?.token ?? ''));
  const tokenExisted = existsSync(tokenPath);
  const dl = await fetch(BASE + '/report/ai-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: done?.token, filename: done?.fileName }),
  });
  const buf = Buffer.from(await dl.arrayBuffer());
  EV.downloadBytes = buf.length;
  ok('B-09 令牌换回 .pptx 字节（>20KB，非空壳）', dl.status === 200 && buf.length > 20_000, { status: dl.status, bytes: buf.length });
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(gateArtifactPath(OUT_DIR, 't02111-acceptance.pptx'), buf);
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  EV.slideCount = slideNames.length;
  ok('B-10 解包页数 = done.pageCount（unzip -l 含 ppt/slides/slide*.xml，验收 4）',
    slideNames.length === done?.pageCount, { unzipped: slideNames.length, pageCount: done?.pageCount });
  ok('B-11 下载即删：令牌文件下载前在场、下载后从 tmp 目录消失',
    tokenExisted && !existsSync(tokenPath), { tokenPath, before: tokenExisted, after: existsSync(tokenPath) });
  emitPair('B-06', 'B-06 逐页 stage 不再一把梭（行为腿：产物页数 = done.pageCount 且 stage 事件 ≥ 页数；字面腿：逐页装配条数 = 渲染页数）');

  const xmlOf = async (n: number) => await zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
  const allXml: string[] = [];
  for (let i = 1; i <= slideNames.length; i += 1) allXml.push(await xmlOf(i));
  EV.allXml = allXml;
  ok('B-05 大纲可增删改：删 1 页 + 改标题后的 12 页稿被生成端点接受（产物里出现改后标题）',
    edited.length === outline13.length - 1 && allXml.some((x) => x.includes('人工改过')),
    { outline: outline13.length, edited: edited.length, title: edited[0]?.title });

  // ---------------- C 组：验收 5 可编辑性硬检 ----------------
  ok('C-01 每一页都有原生文本 <a:t>（无空页、无纯图页）',
    allXml.every((x) => /<a:t>[^<]/.test(x)), allXml.map((x) => (x.match(/<a:t>/g) ?? []).length));
  ok('C-02 数据页出原生表格 <a:tbl>（不是表格截图）',
    allXml.some((x) => /<a:tbl>/.test(x)), allXml.map((x, i) => (/<a:tbl>/.test(x) ? i + 1 : 0)).filter(Boolean));
  ok('C-03 内容零位图：无 <p:pic>，且每页每个 r:embed 都来自 <p:bg>（背景是版式不是内容）',
    allXml.every((x) => !/<p:pic/.test(x)) &&
      allXml.every((x) => (x.match(/r:embed="/g) ?? []).length === (x.match(/<p:bg>/g) ?? []).length),
    Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/')));
  ok('C-04 无 <p:pic> 图片元素（文本框/表格/图表全是可编辑对象）',
    allXml.every((x) => !/<p:pic/.test(x)));
  ok('C-05 图表页出原生 graphicFrame（chart 版式不是贴图）',
    allXml.some((x) => /<p:graphicFrame>/.test(x)) || allXml.some((x) => /<c:chart/.test(x) || /chart\d+\.xml/.test(x)),
    Object.keys(zip.files).filter((n) => n.includes('chart')));

  // ---------------- D 组：验收 6 时间线 + 工作量 ----------------
  const shapesIn = (xml: string) => xml.split('<p:sp>').slice(1).map((s) => ({
    prst: (s.match(/prst="([a-zA-Z]+)"/) ?? [])[1] ?? '',
    name: (s.match(/name="([^"]*)"/) ?? [])[1] ?? '',
  })).filter((o) => /^Shape\b/.test(o.name));
  const bundle = Svc.collectBundle(PID);
  const Builder = await import('../server/src/services/kickoffBuilder.ts');
  const slidePosOf = (oi: number) => (oi < 0 ? -1 : Builder.expandTimelinePages(bundle, edited.slice(0, oi + 1) as any[]).length - 1);
  const posOf = (key: string) => edited.findIndex((o: any) => (o.dataKeys ?? []).includes(key));
  const tlPos = posOf('timeline');
  const tlXml = allXml[slidePosOf(tlPos)] ?? '';
  const tlShapes = shapesIn(tlXml);
  const msCount = truthCounts(PID).P4;
  const dateRange = one<{ s: string | null; e: string | null }>(
    "SELECT MIN(start_date) s, MAX(end_date) e FROM plan_tasks WHERE project_id = ? AND archived = 0 AND start_date IS NOT NULL AND start_date != '' AND end_date IS NOT NULL AND end_date != ''", PID);
  // 批㉜（T02769，反模式 49）：文本抽取器成对准备——「<a:t> 里的数字」是文案无关面，
  // 「N 人天 / N 条」是产品措辞面。前者作行为腿，后者作字面腿，二者各自可红。
  const aTexts = (xml: string) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
  const numsIn = (xml: string) => aTexts(xml).flatMap((t) => t.match(/\d+(?:\.\d+)?/g) ?? []);
  const tlHasTable = /<a:tbl>/.test(tlXml);
  const tlHasAxisShapes = tlShapes.some((s) => s.prst === 'diamond') && tlShapes.some((s) => s.prst === 'line');
  // 降级判据取结构面（回落列表版＝一张刚性表格且没有轴/菱形），不再取 done.warnings 的文案：
  // 实测 done.warnings 里没有「时间线/回落列表」字样（kickoffBuilder 的 note 不进 warnings，见 kickoffBuilder.ts:877），
  // 旧文案键是恒假的死通道——用它当豁免前置件等于「豁免永不生效却没人点名」（N-08 有正反照自证）。
  const tlDegraded = tlHasTable && !tlHasAxisShapes;
  const tlWarnChannelHits = ((done?.warnings ?? []) as string[]).filter((w) => /时间线|回落列表/.test(w)).length;
  EV.tlDegradedStruct = tlDegraded;
  EV.tlWarnChannelHits = tlWarnChannelHits;
  EV.tlHasTable = tlHasTable;
  EV.tlHasAxisShapes = tlHasAxisShapes;
  ok('D-01 时间线页落在大纲指定位次（页位与请求一致，不串页）',
    tlPos >= 0 && tlXml.includes(String(edited[tlPos]?.title ?? '').slice(0, 6)), { tlPos, title: edited[tlPos]?.title });
  ok('D-02 时间线页几何：rect 条 + diamond 菱形 + line 轴三类齐备（夹具日期/里程碑齐全，不应降级）',
    !tlDegraded && tlShapes.some((s) => s.prst === 'rect') && tlShapes.some((s) => s.prst === 'diamond') && tlShapes.some((s) => s.prst === 'line'),
    { degraded: tlDegraded, shapes: tlShapes.map((s) => s.prst), warnings: ((done?.warnings ?? []) as string[]).filter((w) => /时间线|回落/.test(w)) });
  ok('D-03 菱形数与库内里程碑数同源（不超绘、未降级时不漏绘）',
    !tlDegraded && msCount > 0 && tlShapes.filter((s) => s.prst === 'diamond').length > 0
    && tlShapes.filter((s) => s.prst === 'diamond').length <= msCount,
    { diamonds: tlShapes.filter((s) => s.prst === 'diamond').length, sql: msCount, degraded: tlDegraded });
  const axisText = (tlXml.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/g) ?? []);
  ok('D-04 日期轴刻度存在且库内确有起止排期（轴不是编的）',
    !!dateRange?.s && !!dateRange?.e && !tlDegraded && axisText.length >= 2,
    { range: dateRange, ticks: axisText.slice(0, 6), degraded: tlDegraded });

  const wlPos = posOf('workload');
  const wlXml = allXml[slidePosOf(wlPos)] ?? '';
  const wlNums = (wlXml.match(/(\d+(?:\.\d+)?)\s*人天/g) ?? []);
  const wlAnyNums = numsIn(wlXml);
  EV.wlNumsText = wlNums.length;
  EV.wlNumsAny = wlAnyNums.length;
  EV.wlUnitTexts = wlNums;
  EV.wlAnyTexts = wlAnyNums;
  ok('D-05 工作量页存在且页面有数字（行为腿：文案无关面——<a:t> 里确有数值，不认单位措辞）',
    wlPos >= 0 && wlAnyNums.length > 0, { page: slidePosOf(wlPos) + 1, 文案无关数字: wlAnyNums.slice(0, 4), 带人天单位: wlNums.slice(0, 4) });
  ok('D-05b 工作量页单位措辞锚点「人天」（字面腿：产品把「人天」改成别的量词只红这一行，不冒充工作量失守）',
    wlNums.length > 0, { 带人天单位: wlNums.slice(0, 4), 生成者: 'server/src/services/kickoffBuilder.ts:604/284' });
  ok('D-06 工作量页数字 = 服务端口径 expected（行为腿：文案无关面命中同值，页面数字与取数同源、非 AI 措辞）',
    wlAnyNums.some((s) => parseFloat(s) === bundle.workload.manDays.expected),
    { 文案无关数字: wlAnyNums.slice(0, 6), expected: bundle.workload.manDays.expected, source: bundle.workload.source });
  ok('D-07 页脚口径文案随真实数据源切换（估算引擎页脚出自 bundle，不是硬编码）',
    wlXml.includes(bundle.workload.footer.slice(0, 8)),
    { footer: bundle.workload.footer, source: bundle.workload.source });
  const bundleDur = Svc.collectBundle(FIXTURE.dur.projectId);
  EV.durWorkload = {
    source: bundleDur.workload.source,
    expected: bundleDur.workload.manDays.expected,
    footer: bundleDur.workload.footer,
    sumDays: FIXTURE.dur.sumDays,
  };
  ok('D-08 降级项目（无估算行）：工作量 = Σ plan_tasks.duration_days（工期口径）',
    bundleDur.workload.source === 'duration' && Math.abs(bundleDur.workload.manDays.expected - FIXTURE.dur.sumDays) < 1e-6,
    { project: FIXTURE.dur.name, source: bundleDur.workload.source, expected: bundleDur.workload.manDays.expected, sql: FIXTURE.dur.sumDays });
  emitPair('D-09', 'D-09 降级页脚写明「工期口径，非三点估算」（行为腿：source=duration 且人天=Σ工期；字面腿：页脚文案）');

  // ---------------- E 组：验收 8 数字防幻觉 ----------------
  const reqTruth = truthCounts(PID).P2;
  EV.reqTruth = reqTruth;
  ok('E-01 mock 大纲确实带幻觉数字（999 条需求/计划），否则本组等于空跑',
    JSON.stringify(outline13).includes('999'), outline13.length);
  const reqIdx = posOf('reqList');
  const reqPage = allXml[slidePosOf(reqIdx)] ?? '';
  EV.reqPage = reqPage;
  const reqNums = numsIn(reqPage);
  EV.reqNums = reqNums;
  ok('E-02 产物里需求条数 = 库内真实条数（行为腿：文案无关面命中真值数字且不含被注入的 999）',
    reqIdx >= 0 && reqNums.includes(String(reqTruth)) && !reqNums.includes('999'),
    { truth: reqTruth, 页面数字: reqNums.slice(0, 8), 带量词: (reqPage.match(/\d+ 条/g) ?? []).slice(0, 6) });
  ok('E-02b 需求页量词措辞锚点「N 条」（字面腿：产品把量词换成别的写法只红这一行，不冒充防幻觉失守）',
    reqPage.includes(`${reqTruth} 条`), { truth: reqTruth, 生成者: 'server/src/services/kickoffBuilder.ts:573 TRUTH_TEXT 模板' });
  ok('E-03 全稿任何页都不出现被注入的 999',
    allXml.every((x) => !/>[^<]*999[^<]*<\/a:t>/.test(x)), allXml.map((x) => (x.match(/999/g) ?? []).length).filter((n) => n > 0));
  const warnList: string[] = done?.warnings ?? [];
  EV.warnings = warnList;
  EV.wordingCalls = wordingCalls;
  emitPair('E-04', 'E-04 改写逐页点名并如实进 warnings（行为腿：告警同时含 999 与库内真值且产物落真数；字面腿：「库内实为」）');
  emitPair('E-05', 'E-05 措辞段未违约（行为腿：AI 措辞真进了产物；字面腿：无措辞降级告警）');

  // ---------------- G 组：白名单/字段同源（配对） ----------------
  ok('G-00 字面腿取证面非空：四份已提交树文件均可读（git show HEAD:）',
    HEAD.svc.length > 400 && HEAD.panel.length > 400 && HEAD.prd.length > 400 && HEAD.routes.length > 400,
    { 长度: [HEAD.svc.length, HEAD.panel.length, HEAD.prd.length, HEAD.routes.length] });
  emitPair('G-01', 'G-01 服务端三份白名单：源码解析 ≡ 运行时导出（行为腿：运行时值逐项进了真实大纲提示词；字面腿：已提交树解析逐字同序）');
  emitPair('G-02', 'G-02 前端章节候选与服务端同源（行为腿：每个前端候选都出现在服务端真实提示词中；字面腿：两处清单逐字同序）');
  emitPair('G-03', 'G-03 前端版式候选与服务端同源（行为腿：每个前端候选都出现在服务端真实提示词中；字面腿：两处清单逐字同序）');
  emitPair('G-04', 'G-04 前端不硬编码下载文件名（行为腿：done.fileName 含夹具项目名、下载得到真字节；字面腿：面板用 result.fileName 不拼模板）');
  emitPair('G-05', 'G-05 PRD §7 done 字段名 ⊆ 实现键集合（行为腿：PRD 点名的字段在真实 done 事件里逐个在场；字面腿：两侧解析均非空且子集成立）');
  emitPair('G-06', 'G-06 PRD 全文零 downloadToken（行为腿：done 用 token 且无 downloadToken；字面腿：PRD 无该词）');
}

// =====================================================================
// N 组：负对照（判据 4）
// =====================================================================
console.log('\n=== N 组：负对照 ===');
{
  const positive = PAIRS.filter((p) => !p.negative);
  const empty = baseCtx({}, { svc: '', panel: '', prd: '', routes: '' });
  const vacuous = positive.filter((p) => p.lit(empty) === true);
  ok(`N-01 空源码探针：${positive.length} 条正向字面腿喂空串后全部为假（没有不承重的正则）`,
    positive.length === 9 && vacuous.length === 0, { 失配条目: vacuous.map((p) => p.id) });

  const missing = PAIRS.filter((p) => p.lit(baseCtx()) !== true).map((p) => p.id);
  const anchorMiss = PAIRS.flatMap((p) => {
    const ctx = baseCtx();
    const scopeSrc = p.scope === 'svc' || p.scope === 'panel' || p.scope === 'prd' ? ctx.src[p.scope]
      : p.scope === 'err25' ? ctx.err25 : p.scope === 'footerDur' ? ctx.footerDur
        : ctx.warnings.join('\n');
    if (p.negative) return [];
    return p.anchors.filter((a) => !scopeSrc.includes(a)).map((a) => ({ id: p.id, anchor: a }));
  });
  ok(`N-01b HEAD/实测在场性：${PAIRS.length} 组字面腿在真实证据上全部为真，且 ${positive.length} 组正向锚点逐字命中（不是拿不存在的词比）`,
    missing.length === 0 && anchorMiss.length === 0, { 未过: missing, 未命中: anchorMiss });

  const negBad: string[] = [];
  {
    const c = baseCtx();
    c.src = { ...c.src, prd: `${c.src.prd}\ndownloadToken` };
    if (litG6(c) !== false) negBad.push('G-06 注入 downloadToken 后仍为真');
    const c2 = baseCtx();
    c2.warnings = [...c2.warnings, '风险措辞 AI 失败，已用本地条目'];
    if (litE05(c2) !== false) negBad.push('E-05 注入降级告警后仍为真');
  }
  ok('N-01c 负向锚反证：往 PRD 注入 downloadToken / 往告警注入措辞失败后，两条负向字面腿各自转假（空串恒真不算牙）',
    negBad.length === 0, { 未转假: negBad });

  const keep = JSON.parse(JSON.stringify(EV));
  for (const k of Object.keys(EV)) delete EV[k];
  const stillGreen = Object.entries(J).filter(([, f]) => {
    try { return f(EV) === true; } catch { return false; }
  }).map(([k]) => k);
  for (const [k, v] of Object.entries(keep)) EV[k] = v;
  const JN = Object.keys(J).length;
  ok(`N-02 敏感度探针：抽干运行期实测料后 ${JN} 条行为腿全部转假——行为腿确实在读实测，不是恒真`,
    JN === 11 && Object.keys(keep).length >= 10 && stillGreen.length === 0,
    { 行为腿数: JN, 清空后仍为真: stillGreen });
  const backGreen = Object.entries(J).filter(([, f]) => {
    try { return f(EV) !== true; } catch { return true; }
  }).map(([k]) => k);
  ok('N-02b 还原实证：实测料回填后同一批行为腿重新为真（N-02 的红不是恒红）',
    backGreen.length === 0, { 还原后仍为假: backGreen });

  const n3Bad: Array<Record<string, string>> = [];
  let tamperedCount = 0;
  for (const p of positive) {
    for (const anchor of p.anchors.filter(Boolean)) {
      const c = baseCtx();
      if (p.scope === 'svc' || p.scope === 'panel' || p.scope === 'prd') {
        const before = c.src[p.scope];
        const after = before.split(anchor).join('§§');
        if (after === before) { n3Bad.push({ id: p.id, 锚: anchor, 因: '篡改未落地' }); continue; }
        tamperedCount += 1;
        c.src = { ...c.src, [p.scope]: after };
      } else {
        const before = String(c[p.scope as 'err25' | 'footerDur'] ?? '');
        const after = before.split(anchor).join('§§');
        if (after === before) { n3Bad.push({ id: p.id, 锚: anchor, 因: '篡改未落地' }); continue; }
        tamperedCount += 1;
        (c as any)[p.scope] = p.scope === 'warnings' ? c.warnings.map((w) => w.split(anchor).join('§§')) : after;
      }
      if (p.lit(c) !== false) n3Bad.push({ id: p.id, 锚: anchor, 因: '同一条判据未按预期翻转' });
    }
  }
  ok(`N-03 改名模拟：${tamperedCount} 个锚点逐个从 HEAD/实测副本中抹掉后字面判据各自转假（每条先自证副本≠原件）`,
    tamperedCount >= 9 && n3Bad.length === 0, { 已篡改: tamperedCount, 失牙: n3Bad });

  const broken: string[] = [];
  const tamper = (mut: (t: Record<string, any>) => void, judge: (e: Record<string, any>) => boolean, name: string) => {
    const t = JSON.parse(JSON.stringify(EV));
    mut(t);
    let got = true;
    try { got = judge(t); } catch { got = false; }
    if (got !== false) broken.push(name);
  };
  tamper((t) => { t.rt.sections = []; }, J.g1, 'G-01 运行时章节清空后仍判真');
  tamper((t) => { t.fe.sections = ['§外部章节§']; }, J.g2, 'G-02 前端候选漂移后仍判真');
  tamper((t) => { t.fe.layouts = ['§外部版式§']; }, J.g3, 'G-03 前端版式漂移后仍判真');
  tamper((t) => { t.done.fileName = 'report.pptx'; }, J.g4, 'G-04 文件名不含项目名后仍判真');
  tamper((t) => { delete t.done.token; }, J.g5, 'G-05 done 缺 PRD 点名字段后仍判真');
  tamper((t) => { t.done.downloadToken = t.done.token; }, J.g6, 'G-06 done 出现 downloadToken 后仍判真');
  tamper((t) => { t.err25Status = 200; }, J.b03, 'B-03 25 页未拒绝后仍判真');
  tamper((t) => { t.slideCount += 1; }, J.b06, 'B-06 产物页数与 done 不一致后仍判真');
  tamper((t) => { t.durWorkload.source = 'estimate'; }, J.d09, 'D-09 工期口径变估算后仍判真');
  tamper((t) => { t.reqNums = []; }, J.e04, 'E-04 产物未落真数后仍判真');
  tamper((t) => { t.wordingCalls = 0; }, J.e05, 'E-05 措辞段未跑后仍判真');
  ok('N-04 破坏形态反证：11 条行为腿各按一类「功能失守」副本（清空运行时/前端漂移/文件名丢项目/缺字段/多 downloadToken/未拒 25 页/页数不一致/口径错/产物无真数/措辞未跑）转假',
    broken.length === 0, { 未转假: broken });

  const spy: Array<{ name: string; cond: boolean; extra?: any }> = [];
  okPair((n, cond, e) => spy.push({ name: n, cond, extra: e }), 'N-05a 行为失守夹具',
    () => false, () => true);
  okPair((n, cond, e) => spy.push({ name: n, cond, extra: e }), 'N-05b 锚点失配夹具',
    () => true, () => false);
  okPair((n, cond, e) => spy.push({ name: n, cond, extra: e }), 'N-05c 双侧齐全',
    () => true, () => true);
  const reason = (x?: any) => String(x?.extra?.红因 ?? '');
  ok('N-05 okPair 落地：行为失守记「行为失守」、锚子失配记「字面锚点失配」、两者齐绿才判绿（两条红不是同一种红）',
    spy.length === 3 && spy[0].cond === false && reason(spy[0]).includes('行为失守') && !reason(spy[0]).includes('字面锚点')
    && spy[1].cond === false && reason(spy[1]).includes('字面锚点失配') && spy[2].cond === true,
    spy.map((s) => ({ 条: s.name, 判: s.cond, 红因: reason(s).slice(0, 40) })));

  const tamperedSample = [...sample, { projectId: 'prod-mtask4', name: 'mtask四期' }];
  ok('N-06 判据 2 反证：样本夹具自证有牙——混入生产项目名/ID 的样本列表被判假（本门不再以生产数据集为对数对象）',
    sampleJudge(sample) === true && sampleJudge(tamperedSample) === false,
    { sample: sample.map((p) => p.name), tampered: tamperedSample.map((p) => p.name) });

  // N-07 中文串条件三分登记表（T02769）：本门每一条「拿中文字面串当判据/取数键」的条件逐条登记
  // 「这串文案是谁生成的」，并用 git show HEAD: 证明生成者真生成它。豁免必须是「被证明的豁免」。
  const CAT: Array<{ 串: string; 类: string; 用处: string; 生成者: string }> = [
    { 串: '不在 ', 类: '① 产品生成', 用处: 'B-03 字面腿（模板含 ${PAGE_MIN}~${PAGE_MAX} 插值，区间一改本腿该红并交人判定）', 生成者: 'server/src/services/kickoffService.ts' },
    { 串: '已装配：', 类: '① 产品生成', 用处: 'B-06 字面腿 + 逐页 stage 取数键（现已加 n/N 分式兜底，见 N-08c）', 生成者: 'server/src/services/kickoffService.ts' },
    { 串: '工期口径，非三点估算', 类: '① 产品生成', 用处: 'D-09 字面腿', 生成者: 'server/src/services/kickoffService.ts' },
    { 串: '库内实为', 类: '① 产品生成', 用处: 'E-04 字面腿', 生成者: 'server/src/services/kickoffBuilder.ts' },
    { 串: '风险措辞 AI 失败', 类: '① 产品生成', 用处: 'E-05 负向字面腿（KICKOFF_WORDING_FALLBACK_MSG）', 生成者: 'server/src/services/kickoffService.ts' },
    { 串: ' 人天', 类: '① 产品生成', 用处: 'D-05b 量词字面腿（行为腿已改走文案无关数字面，见 N-09）', 生成者: 'server/src/services/kickoffBuilder.ts' },
    { 串: ' 条', 类: '① 产品生成', 用处: 'E-02b 量词字面腿（行为腿改走 numsIn，J.e04 同步摘掉文案依赖）', 生成者: 'server/src/services/kickoffBuilder.ts' },
    { 串: '【风险条目', 类: '① 产品生成', 用处: 'mock 路由兜底键（主键已改 JSON 字段契约）', 生成者: 'server/src/services/kickoffService.ts' },
    { 串: '条数分别为 ', 类: '① 产品生成', 用处: 'mock 计数键（失配时落枚举行计数兜底，由 N-08c 点名）', 生成者: 'server/src/services/kickoffService.ts' },
    { 串: '时间线回落列表版', 类: '① 产品生成（但不进 done.warnings）', 用处: '旧降级取数键——实测是死通道，已退役为证据面，降级判据改结构键（见 N-08a/b）', 生成者: 'server/src/services/kickoffBuilder.ts' },
    { 串: '人工改过', 类: '② 门自造夹具', 用处: 'B-05 大纲可改标题（本门注入 product 只是原样渲染）', 生成者: 'scripts/verify-t02111-kickoff-acceptance.mts' },
    { 串: '周会跟里程碑节点开', 类: '② 门自造夹具', 用处: 'J.e05 行为腿（mock 专属回复，产品面零命中见 N-07b）', 生成者: 'scripts/verify-t02111-kickoff-acceptance.mts' },
    { 串: '会上确认影响面', 类: '② 门自造夹具', 用处: 'mock 措辞回复料', 生成者: 'scripts/verify-t02111-kickoff-acceptance.mts' },
    { 串: '行为失守（功能未达成，与文案无关）', 类: '② 门禁库文案', 用处: 'N-05 契约判据', 生成者: 'scripts/lib/anchor-pair.mts' },
    { 串: '字面锚点失配（行为在）', 类: '② 门禁库文案', 用处: 'N-05 契约判据', 生成者: 'scripts/lib/anchor-pair.mts' },
  ];
  const catMiss = CAT.filter((c) => !headSource(c.生成者).includes(c.串)).map((c) => `${c.类} | ${c.串} | 声称生成者 ${c.生成者}`);
  ok(`N-07 ${CAT.length} 条中文串条件逐条命中其声称的生成者 HEAD 副本（逐条取证「这串文案是谁生成的」，不按计数猜；产品把整串搬走/删掉即点名失配）`,
    catMiss.length === 0, { 未命中: catMiss, 登记: CAT.map((c) => `${c.类}:${c.串}`) });
  const gateOnly = ['周会跟里程碑节点开', '会上确认影响面', '变更先登记进需求跟踪矩阵'];
  const kickoffTree = ['server/src/services/kickoffService.ts', 'server/src/services/kickoffBuilder.ts', 'server/src/routes/plans.ts', 'web/src/pages/KickoffPptPanel.tsx'];
  const grepProbe = (word: string, paths: string[]) => {
    try {
      return { ok: true, hits: execFileSync('git', ['--no-pager', 'grep', '-l', '-F', '-e', word, 'HEAD', '--', ...paths],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean) };
    } catch (e) {
      if ((e as { status?: number }).status === 1) return { ok: true, hits: [] as string[] };
      return { ok: false, hits: [] as string[], err: String((e as Error).message).slice(0, 60) };
    }
  };
  const catControl = grepProbe('已装配：', ['server']);
  const catProbe = gateOnly.map((w) => ({ 串: w, ...grepProbe(w, kickoffTree) }));
  ok('N-07b 门自造三条夹具文案在启动会产品四面零命中 + 探针道自证（正对照「已装配：」必须命中 server，否则「零命中」只是探针坏了——反模式 48 的负对照空转形态）',
    catControl.ok && catControl.hits.length > 0 && catProbe.every((x) => x.ok && x.hits.length === 0),
    { 正对照: { 命中: catControl.hits.slice(0, 3), 取数失败: (catControl as { err?: string }).err ?? null }, 门料产品面命中: catProbe.map((x) => ({ 串: x.串, 命中: x.hits.slice(0, 2), 取数失败: (x as { err?: string }).err ?? null })) });

  // N-08 取数面探针：降级判据的结构键 vs 文案键（正反照），以及三把取数键今日落在哪一面。
  const degProbe = (xml: string, prsts: string[], warns: string[]) => ({
    结构键: /<a:tbl>/.test(xml) && !(prsts.includes('diamond') && prsts.includes('line')),
    文案键: warns.some((w) => /时间线|回落列表/.test(w)),
  });
  const degFake = degProbe('<a:tbl><a:t>列表版</a:t></a:tbl>', [], ['要点为本页表格让位，未排入版面']);
  const shapeFake = degProbe('<p:sp><a:prstGeom prst="diamond"/></p:sp><p:sp><a:prstGeom prst="line"/></p:sp>', ['diamond', 'line', 'rect'], ['要点为本页表格让位，未排入版面']);
  ok('N-08a 降级判据自证：同一份「列表版」副本结构键判降级、文案键判不降级（done.warnings 里根本没有降级播报，文案键是恒假死通道）；形状版副本两键都判不降级（结构键不是恒真摆设）',
    degFake.结构键 === true && degFake.文案键 === false && shapeFake.结构键 === false,
    { 列表版副本: degFake, 形状版副本: shapeFake, 实测时间线: { hasTable: EV.tlHasTable, hasAxisShapes: EV.tlHasAxisShapes, degraded: EV.tlDegradedStruct, warnHits: EV.tlWarnChannelHits } });
  ok('N-08b 实测降级面读数：夹具时间线走结构键确为未降级，且 done.warnings 文案键命中数恰为 0（旧键哪天开始命中，本行立刻点名形态变化，不让功能腿冒红）',
    EV.tlDegradedStruct === false && EV.tlWarnChannelHits === 0 && EV.tlHasAxisShapes === true,
    { 结构: { hasTable: EV.tlHasTable, hasAxisShapes: EV.tlHasAxisShapes, degraded: EV.tlDegradedStruct }, 文案键命中: EV.tlWarnChannelHits });
  ok('N-08c 三把取数键今日落点：逐页装配=文案锚（分式兜底未启用）、mock 路由=JSON 字段契约（中文兜底未启用）、mock 计数=文案键（枚举行兜底未启用）；落到兜底面时本行点名「形态漂移」',
    String(EV.pageStageKey) === '文案锚「页 n/N 已装配」' && mockRouteBy === 'JSON 字段契约（文案无关）' && mockCountSrc === '文案键「条数分别为 N 与 M」',
    { 装配键: EV.pageStageKey, 路由键: mockRouteBy, 计数键: mockCountSrc, pageStages: EV.pageStages, stageCount: EV.stageCount, wordingCalls });

  // N-09 拆配形状反证（判据 4）：批㉜ 新拆的量词腿族跑三变异，红因必须各归其位——
  // 「只换措辞」若连行为腿一起红，说明两条腿读的是同一串文案（假拆配）。
  const unitCase = (label: string, anchor: string, texts: string[], nums: string[], reworded: string[]) => {
    const behavior = (n: string[]) => n.length > 0;
    const literal = (t: string[]) => t.some((x) => x.includes(anchor));
    return {
      label, anchor,
      双绿: behavior(nums) && literal(texts),
      换文案: behavior(nums) && !literal(reworded),
      破功能: !behavior([]) && literal(texts),
      实测在场: literal(texts),
    };
  };
  const unitCases = [
    unitCase('D-05/D-05b', ' 人天', (EV.wlUnitTexts ?? []) as string[], (EV.wlAnyTexts ?? []) as string[],
      ((EV.wlAnyTexts ?? []) as string[]).map((n) => `${n} person-days`)),
    unitCase('E-02/E-02b', ' 条', [String(EV.reqPage ?? '')], (EV.reqNums ?? []) as string[],
      [String(EV.reqPage ?? '').replace(/ 条/g, ' items')]),
  ];
  const unitBad = unitCases.filter((u) => !(u.双绿 && u.换文案 && u.破功能 && u.实测在场)).map((u) => u.label);
  ok(`N-09 ${unitCases.length} 组新拆量词对的形状反证（双绿／只换措辞→行为腿仍绿而字面腿该红／只清空数字面→行为腿该红，且锚点在实测料里真在场）`,
    unitBad.length === 0, { 不合格: unitBad, 读数: unitCases });
}

// =====================================================================
// 收口
// =====================================================================
try { db.close(); } catch { /* 已关 */ }
bye();
await sleep(1500);
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }

const summary = `T02111 验收门：PASS ${pass} / FAIL ${fail}（门内夹具项目 ${sample.map((p) => p.name).join('、')}）\n` + lines.join('\n');
writeGateResults(OUT_DIR, 't02111-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
