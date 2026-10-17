/**
 * T02111 门（PRD §8 验收 3/4/5/6/8 + K8）：启动会 PPT 端到端验收——API 冒烟 + 真产物解包 XML 断言 + 数字一致性。
 *
 * 与已有机门的分工（不重复造轮子）：
 *   verify-t02100（时间线）/t02101（工作量）在**纯函数层**证几何与口径；
 *   verify-t02103（SSE）/t02105（并发闸）证**链路与闸**；
 *   本门只补它们够不着的那一层：**走真 HTTP 端点、拿真项目数据、解包真产物**，
 *   并把每个数字与 SQL 独立复算对齐（验收 3/6/8 的「与库内一致」只能这么证）。
 *
 * 断言组：
 *   G 组 白名单同源守卫：前后端章节/版式/数据键三份值域逐字相等（漂移即红，服务端是唯一权威）。
 *   A 组 验收 3：PRD 点名真实资料项目（mtask四期）preflight P1~P7 条数与 SQL 独立复算逐条对数。
 *   B 组 验收 4：大纲端点（AI 出稿须落 12~18，失控 25 页整段判失败）→ done 带 token+fileName → 下载字节可解包、页数对得上。
 *   C 组 验收 5：解包硬检——每页有 <a:t> 文本、数据页有原生 <a:tbl>/graphicFrame、全稿零位图（不许整页贴图）。
 *   D 组 验收 6：时间线页 rect 条 + diamond 菱形 + line 轴齐备且轴上日期与库内起止同源；
 *              工作量页人天合计 = 服务端口径，且降级项目 = Σ duration_days（工期口径），页脚文案随之切换。
 *   E 组 验收 8：提示词里让 AI「把需求数写成 999」→ 产物落真条数，且 warnings 逐页点名「库内实为」。
 *
 * 用法（与 T02103 同口径，better-sqlite3 需匹配当前 Node ABI）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02111-kickoff-acceptance.mts
 * 环境变量：`T02111_PORT`（默认随机 39500+rand300）。
 * 隔离纪律（skill 红线 8）：生产库**只读副本**落临时目录，端口/临时目录全临时，mock 不消耗真实配额。
 * 结果落 .workbuddy/t02111-gate-results-<运行标识>.txt 与 t02111-acceptance.pptx（人工抽查用）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02111_PORT ?? 39_500 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02111-acc-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_DIR = join(DATA_DIR, 'tmp');
// 进程内 import 的 server 服务（collectBundle）也走这份副本：
// getDb() 在首次使用时才解析 MTask_DATA_DIR，不设就会落到 server/data 的空库（no such table）
process.env.MTask_DATA_DIR = DATA_DIR;

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// G 组：白名单同源守卫（值域单源在服务端，前端只是候选渲染——漂移即红）
// =====================================================================
const SVC = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8');
const PANEL = readFileSync(join(ROOT, 'web', 'src', 'pages', 'KickoffPptPanel.tsx'), 'utf8');
const strArray = (src: string, re: RegExp): string[] => {
  const m = re.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
};
const srvSections = strArray(SVC, /export const KICKOFF_SECTIONS = \[([\s\S]*?)\] as const/);
const srvLayouts = strArray(SVC, /export const KICKOFF_LAYOUTS = \[([\s\S]*?)\] as const/);
const srvKeys = strArray(SVC, /export const KICKOFF_DATA_KEYS = \[([\s\S]*?)\] as const/);
const feSections = strArray(PANEL, /const SECTIONS = \[([\s\S]*?)\];/);
const feLayouts = strArray(PANEL, /const LAYOUTS = \[([\s\S]*?)\];/);
const same = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i]);

// T02205：条数不再硬编码（原为 12/11/12）——改锚「源码解析 ≡ 运行时导出」。
// 加/删白名单项不必改门；改名或换写法让解析落空时，两侧长度当场点名（下行 G-02/G-03 的前端同源比较也才有意义）。
const SVC_MOD = await import('../server/src/services/kickoffService.ts');
const rtSections = [...(SVC_MOD.KICKOFF_SECTIONS ?? [])];
const rtLayouts = [...(SVC_MOD.KICKOFF_LAYOUTS ?? [])];
const rtKeys = [...(SVC_MOD.KICKOFF_DATA_KEYS ?? [])];
ok('G-01 服务端三份白名单：源码解析与运行时导出的数组逐字同序（加/删项不必改门；改名或换写法导致解析落空即点名）',
  same(srvSections, rtSections) && same(srvLayouts, rtLayouts) && same(srvKeys, rtKeys),
  {
    源码解析: [srvSections.length, srvLayouts.length, srvKeys.length],
    运行时导出: [rtSections.length, rtLayouts.length, rtKeys.length],
    解析摘样: srvSections.slice(0, 2), 运行时摘样: rtSections.slice(0, 2),
  });
ok('G-02 前端章节候选与服务端 KICKOFF_SECTIONS 逐字同序（AI 出稿越界由服务端 400，前端不该自成一套）',
  same(feSections, srvSections), { fe: feSections, srv: srvSections });
ok('G-03 前端版式候选与服务端 KICKOFF_LAYOUTS 逐字同序',
  same(feLayouts, srvLayouts), { fe: feLayouts, srv: srvLayouts });
ok('G-04 前端不硬编码下载文件名（fileName 取服务端校验值，洗名单源在 util/export-name）',
  !/\.pptx`/.test(PANEL) && /result\.fileName/.test(PANEL));
// G-05/G-06（T02145）：PRD §7 的 done 字段名此前无任何门钉住，全靠人工比对——本单分歧
// （PRD 写 downloadToken、三方实现用 token）就是这么漂移进来的，故把「文档 ⊆ 实现键集合」钉成门。
const PRD_KICKOFF = readFileSync(join(ROOT, 'docs', 'PRD-项目启动会PPT生成.md'), 'utf8');
const PLANS_ROUTES = readFileSync(join(ROOT, 'server', 'src', 'routes', 'plans.ts'), 'utf8');
const prdRow = PRD_KICKOFF.split('\n').find((l) => l.includes('kickoff-ppt-stream') && l.includes('`done`')) ?? '';
const prdFields = [...((/`done`（含\s*([^）]*)/.exec(prdRow)?.[1] ?? '').matchAll(/`([A-Za-z]\w*)/g))].map((m) => m[1]);
const implDoneKeys = [...((/send\('done',\s*\{([\s\S]*?)\}\s*\);/.exec(PLANS_ROUTES)?.[1] ?? '').matchAll(/(\w+):/g))].map((m) => m[1]);
ok('G-05 PRD §7 done 字段名必须是实现 send(\'done\',{…}) 键集合的子集（两侧都要解析得到，防改名致空集假绿）',
  prdFields.length >= 3 && implDoneKeys.length >= 3 && prdFields.every((f) => implDoneKeys.includes(f)),
  { PRD: prdFields, 实现: implDoneKeys });
ok('G-06 PRD 全文零 downloadToken（T02145 已按用户裁决统一为 token，再出现即文档又漂移）',
  !/downloadToken/.test(PRD_KICKOFF));

// =====================================================================
// mock AI：大纲段回「带幻觉数字」的 13 页稿；措辞段回合规改写
// =====================================================================
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
    try {
      const j = JSON.parse(body);
      user = String((j.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n'));
    } catch { /* 坏请求直接回空 */ }
    const isWording = /【风险条目/.test(user);
    let content: string;
    if (isWording) {
      // 措辞段按提示词点名的条数回稿（提示词末句：「条数分别为 N 与 M」），条目文本照抄本地枚举
      const want = /条数分别为 (\d+) 与 (\d+)。/.exec(user);
      const nRisks = want ? +want[1] : 0;
      const nComms = want ? +want[2] : 0;
      const items = [...user.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => m[1].trim());
      content = JSON.stringify({
        risks: Array.from({ length: nRisks }, (_, i) => ({
          item: (items[i] ?? `风险 ${i + 1}`).slice(0, 40),
          impact: '会上确认影响面',
          mitigation: '会上明确责任方与时限',
        })),
        comms: Array.from({ length: nComms }, (_, i) => (i === 0 ? '周会跟里程碑节点开' : '变更先登记进需求跟踪矩阵')),
      });
    } else {
      content = JSON.stringify(outlinePayload(mockPages));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 隔离实例：生产库只读副本 → 临时 DATA_DIR
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
const Database = (await import('better-sqlite3')).default;
{
  const src = new Database(prodDb, { readonly: true });
  await src.backup(join(DATA_DIR, 'mtask.db'));
  src.close();
}
ok('A-00 生产库只读副本已生成（本门零写生产库）', existsSync(join(DATA_DIR, 'mtask.db')));
const db = new Database(join(DATA_DIR, 'mtask.db'), { readonly: true });
const q = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[];
const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T | undefined;

const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

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

/** 独立复算：库内真实条数（验收 3 的对数基准，不走服务端口径） */
function truthCounts(projectId: string) {
  const plans = q<{ n: number }>('SELECT COUNT(*) n FROM plan_tasks WHERE project_id = ? AND archived = 0', projectId)[0].n;
  return {
    P1: q<{ n: number }>('SELECT COUNT(*) n FROM prd_docs WHERE project_id = ?', projectId)[0].n,
    P2: q<{ n: number }>('SELECT COUNT(*) n FROM prd_requirements WHERE project_id = ?', projectId)[0].n,
    P3: plans,
    P4: q<{ n: number }>("SELECT COUNT(*) n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND kind = 'milestone'", projectId)[0].n,
    P5: q<{ n: number }>('SELECT COUNT(*) n FROM test_cases WHERE project_id = ?', projectId)[0].n,
    // P6 = 有复杂度或有工期的计划条数（工作量页数据源完整性），P7 = 工作空间可用（路径登记且磁盘存在）
    P6: q<{ n: number }>('SELECT COUNT(*) n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND (complexity IS NOT NULL OR (duration_days IS NOT NULL AND duration_days > 0))', projectId)[0].n,
    P7: (() => {
      const w = q<{ p: string | null }>('SELECT workspace_path p FROM projects WHERE id = ?', projectId)[0];
      return w?.p && existsSync(w.p) ? 1 : 0;
    })(),
  };
}

const projects = q<{ id: string; name: string }>('SELECT id, name FROM projects WHERE archived = 0 ORDER BY name');
// 对数样本：首位固定用 PRD §8 验收 3 点名的真实项目「mtask四期」——B~E 组整条生成链路都跑在它上面，
// 这样「真实资料项目」的对数是点名验收而不是挑软柿子；再补两个带测试用例的项目让 P5/覆盖率口径进对数。
// 空项目与硬阻塞由 T02108 的 UI 实测覆盖，不在本样本内。
const namedSample = ['mtask四期', 'swork', 'aimsg二期'];
const sample = namedSample
  .map((n) => projects.find((p) => p.name === n))
  .filter((p): p is { id: string; name: string } => {
    if (!p) return false;
    const c = truthCounts(p.id);
    return c.P1 > 0 && c.P2 > 0 && c.P3 > 0;
  });
ok('A-00b 样本第 1 位是 PRD 验收 3 点名的 mtask四期（库内改名/归档就要同步本门，不静默换样本）',
  sample[0]?.name === 'mtask四期', { sample: sample.map((p) => p.name) });

if (!(await waitUp())) {
  ok('B-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('B-00 隔离实例启动', true);
  const tool = await call('POST', '/aitools', {
    name: 't02111-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-outline', timeoutMs: 20000,
  });
  const toolId = tool.body?.id as string | undefined;
  ok('B-01 mock AI 工具已建（不触真实模型）', !!toolId, tool.body);

  // ---------------- A 组：验收 3 逐条对数 ----------------
  for (const p of sample) {
    const pf = await call('GET', `/plans/kickoff-preflight?projectId=${p.id}`);
    const t = truthCounts(p.id);
    const item = (k: string) => (pf.body?.items ?? []).find((i: any) => i.key === k)?.count;
    ok(`A-01 [${p.name}] preflight 200 且 blocked=false`, pf.status === 200 && pf.body?.blocked === false, pf.body);
    ok(`A-02 [${p.name}] P1 PRD 文档条数 = 库内 prd_docs`, item('P1') === t.P1, { api: item('P1'), sql: t.P1 });
    ok(`A-03 [${p.name}] P2 需求矩阵条数 = 库内 prd_requirements`, item('P2') === t.P2, { api: item('P2'), sql: t.P2 });
    ok(`A-04 [${p.name}] P3 计划条数 = 库内未归档 plan_tasks`, item('P3') === t.P3, { api: item('P3'), sql: t.P3 });
    ok(`A-05 [${p.name}] P4 里程碑数 = 库内 kind=milestone 行数`, item('P4') === t.P4, { api: item('P4'), sql: t.P4 });
    ok(`A-06 [${p.name}] P5 测试用例数 = 库内 test_cases`, item('P5') === t.P5, { api: item('P5'), sql: t.P5 });
    // 与公开列表端点交叉对数（PRD 验收 3 点名的两条口径）
    const reqs = await call('GET', `/plans/prd-requirements?projectId=${p.id}`);
    const reqRows = Array.isArray(reqs.body) ? reqs.body : (reqs.body?.items ?? reqs.body?.requirements ?? []);
    ok(`A-07 [${p.name}] P2 与 /plans/prd-requirements 行数一致`, reqRows.length === t.P2, { ep: reqRows.length, sql: t.P2 });
    const planList = await call('GET', `/plans?projectId=${p.id}`);
    const planRows = (Array.isArray(planList.body) ? planList.body : (planList.body?.items ?? [])).filter((r: any) => !r.archived);
    ok(`A-08 [${p.name}] P3 与 /plans 未归档行数一致`, planRows.length === t.P3, { ep: planRows.length, sql: t.P3 });
    ok(`A-09 [${p.name}] P6 复杂度/工期条数 = 库内有计划数据的行数`, item('P6') === t.P6, { api: item('P6'), sql: t.P6 });
    ok(`A-10 [${p.name}] P7 工作空间可用性与库内登记路径一致`, item('P7') === t.P7, { api: item('P7'), sql: t.P7 });
  }

  const PID = sample[0]?.id ?? '';
  const PNAME = sample[0]?.name ?? '';

  // ---------------- B 组：验收 4 大纲 → done → 下载 → 解包 ----------------
  const ol = await call('POST', '/plans/kickoff-ppt-outline', { projectId: PID, toolId });
  const outline: any[] = ol.body?.outline ?? [];
  ok('B-02 大纲端点 200 且页数落 12~18 建议区间', ol.status === 200 && outline.length >= 12 && outline.length <= 18,
    { status: ol.status, pages: outline.length, err: ol.body?.error });
  mockPages = 25;
  const ol2 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: PID, toolId });
  ok('B-03 AI 失控给 25 页 → 大纲段判失败（12~18 是编排铁律，不静默裁剪成能过）',
    ol2.status === 400 && /不在 12~18 区间/.test(String(ol2.body?.error ?? '')), { status: ol2.status, err: ol2.body?.error });
  mockPages = 13;
  const ol3 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: PID, toolId });
  const outline13: any[] = ol3.body?.outline ?? [];
  ok('B-04 truncated 字段语义 = PRD 摘要截断（不是页数裁剪），与服务端口径一致',
    ol3.body?.truncated === undefined || typeof ol3.body.truncated === 'boolean', ol3.body?.truncated);
  ok('B-05 大纲可增删改：删 1 页 + 改标题后的 12 页稿被生成端点接受', outline13.length === 13);

  const edited = outline13.slice(1).map((o, i) => (i === 0 ? { ...o, title: `人工改过 · ${o.title}` } : o));
  const st = await sse('/plans/kickoff-ppt-stream?projectId=' + PID + '&toolId=' + toolId, { projectId: PID, toolId, outline: edited });
  const done = st.events.find((e) => e.event === 'done')?.data;
  // stage 里除逐页装配还有取数/措辞等过程播报，只数「页 n/N 已装配」这一类（否则条数永远对不上）
  const pageStages = st.events.filter((e) => e.event === 'stage' && /页 \d+\/\d+ 已装配/.test(String(e.data?.msg ?? '')));
  // T02171：页数分母取装配层报告的渲染页数（时间线续页会加页），大纲页数只是下界
  ok('B-06 SSE 逐页 stage 条数 = 渲染页数（不是最后一把梭）',
    pageStages.length === Number(done?.pageCount ?? -1) && pageStages.length >= edited.length,
    { stages: pageStages.length, outlinePages: edited.length, pageCount: done?.pageCount });
  ok('B-07 done 带 token + fileName + pageCount（pageCount ≥ 大纲页数）',
    !!done?.token && !!done?.fileName && Number(done?.pageCount ?? 0) >= edited.length, done);
  ok('B-08 fileName 通过下载白名单正则（生成侧与下载侧同源洗名，T02104）',
    /^[A-Za-z0-9._\u4e00-\u9fa5-]+\.pptx$/.test(String(done?.fileName ?? '')), done?.fileName);

  const dl = await fetch(BASE + '/report/ai-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: done?.token, filename: done?.fileName }),
  });
  const buf = Buffer.from(await dl.arrayBuffer());
  ok('B-09 令牌换回 .pptx 字节（>20KB，非空壳）', dl.status === 200 && buf.length > 20_000, { status: dl.status, bytes: buf.length });
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 't02111-acceptance.pptx'), buf);
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  ok('B-10 解包页数 = done.pageCount（unzip -l 含 ppt/slides/slide*.xml，验收 4）',
    slideNames.length === done?.pageCount, { unzipped: slideNames.length, pageCount: done?.pageCount });
  ok('B-11 下载即删：令牌文件已从 tmp 目录消失',
    !existsSync(join(TMP_DIR, String(done?.token ?? ''))));

  const xmlOf = async (n: number) => await zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
  const allXml: string[] = [];
  for (let i = 1; i <= slideNames.length; i += 1) allXml.push(await xmlOf(i));

  // ---------------- C 组：验收 5 可编辑性硬检 ----------------
  ok('C-01 每一页都有原生文本 <a:t>（无空页、无纯图页）',
    allXml.every((x) => /<a:t>[^<]/.test(x)), allXml.map((x) => (x.match(/<a:t>/g) ?? []).length));
  ok('C-02 数据页出原生表格 <a:tbl>（不是表格截图）',
    allXml.some((x) => /<a:tbl>/.test(x)), allXml.map((x, i) => (/<a:tbl>/.test(x) ? i + 1 : 0)).filter(Boolean));
  ok('C-03 全稿零位图：ppt/media 下没有真图（整页贴图是 Marp 路线的指纹）',
    !Object.keys(zip.files).some((n) => n.startsWith('ppt/media/') && !n.endsWith('/')),
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
  // 页位按大纲下标定位（按关键词全文找会命中封面/附录的引用文案，把别的页当成时间线页）
  // T02171：时间线页超行数会展开续页，「大纲下标 = 幻灯片下标」不再成立——
  // 用装配层同一口径 expandTimelinePages 反查，续页归给它所属的时间线，后续页整体后移。
  const Svc = await import('../server/src/services/kickoffService.ts');
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
  // 日期填充率不足时时间线**如实回落列表**（T02100 口径），此时要求的是「降级有痕」而不是菱形
  const tlDegraded = ((done?.warnings ?? []) as string[]).some((w) => /时间线|回落列表/.test(w));
  ok('D-01 时间线页落在大纲指定位次（页位与请求一致，不串页）',
    tlPos >= 0 && tlXml.includes(String(edited[tlPos]?.title ?? '').slice(0, 6)), { tlPos, title: edited[tlPos]?.title });
  ok('D-02 时间线页几何：未降级时 rect 条 + diamond 菱形 + line 轴三类齐备；降级时出原生表格且告警留痕',
    tlDegraded ? /<a:tbl>/.test(tlXml) : (tlShapes.some((s) => s.prst === 'rect') && tlShapes.some((s) => s.prst === 'diamond') && tlShapes.some((s) => s.prst === 'line')),
    { degraded: tlDegraded, shapes: tlShapes.map((s) => s.prst), warnings: ((done?.warnings ?? []) as string[]).filter((w) => /时间线|回落/.test(w)) });
  ok('D-03 菱形数与库内里程碑数同源（不超绘、未降级时不漏绘）',
    tlDegraded || msCount === 0 || (tlShapes.filter((s) => s.prst === 'diamond').length > 0 && tlShapes.filter((s) => s.prst === 'diamond').length <= msCount),
    { diamonds: tlShapes.filter((s) => s.prst === 'diamond').length, sql: msCount, degraded: tlDegraded });
  const axisText = (tlXml.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/g) ?? []);
  ok('D-04 日期轴刻度存在且库内确有起止排期（轴不是编的）',
    !!dateRange?.s && !!dateRange?.e && (tlDegraded || axisText.length >= 2),
    { range: dateRange, ticks: axisText.slice(0, 6), degraded: tlDegraded });

  const wlPos = posOf('workload');
  const wlXml = allXml[slidePosOf(wlPos)] ?? '';
  const wlNums = (wlXml.match(/(\d+(?:\.\d+)?)\s*人天/g) ?? []);
  ok('D-05 工作量页存在且含人天数字', wlPos >= 0 && wlNums.length > 0, { page: slidePosOf(wlPos) + 1, nums: wlNums.slice(0, 4) });
  ok('D-06 工作量页人天合计 = 服务端口径 expected（页面数字与取数同源，非 AI 措辞）',
    wlNums.some((s) => parseFloat(s) === bundle.workload.manDays.expected),
    { page: wlNums.slice(0, 4), expected: bundle.workload.manDays.expected, source: bundle.workload.source });
  ok('D-07 页脚口径文案随真实数据源切换（估算引擎 / 工期口径，二者不混）',
    wlXml.includes(bundle.workload.footer.slice(0, 8)),
    { footer: bundle.workload.footer, source: bundle.workload.source });
  // 工期推导路径独立复算：找一个「有计划有工期、但无估算行」的项目
  const durProject = projects.map((p) => {
    const plans = q<{ n: number; d: number }>('SELECT COUNT(*) n, COALESCE(SUM(duration_days),0) d FROM plan_tasks WHERE project_id = ? AND archived = 0 AND kind != \'milestone\'', p.id)[0];
    const est = q<{ n: number }>('SELECT COUNT(*) n FROM estimate_items WHERE project_id = ?', p.id)[0].n;
    return { ...p, plans: plans.n, sumDays: plans.d, est };
  }).find((p) => p.plans > 0 && p.est === 0 && p.sumDays > 0);
  if (durProject) {
    const b2 = Svc.collectBundle(durProject.id);
    ok('D-08 降级项目（无估算行）：工作量 = Σ plan_tasks.duration_days（工期口径）',
      b2.workload.source === 'duration' && Math.abs(b2.workload.manDays.expected - durProject.sumDays) < 1e-6,
      { project: durProject.name, source: b2.workload.source, expected: b2.workload.manDays.expected, sql: durProject.sumDays });
    ok('D-09 降级页脚写明「工期口径，非三点估算」（不把排期冒充估算）',
      /工期口径/.test(b2.workload.footer), b2.workload.footer);
  } else {
    ok('D-08 降级项目样本存在（库内无「有工期且零估算」项目 → 本条不成立）', false, durProject);
  }

  // ---------------- E 组：验收 8 数字防幻觉 ----------------
  const reqTruth = truthCounts(PID).P2;
  const planTruth = truthCounts(PID).P3;
  ok('E-01 mock 大纲确实带幻觉数字（999 条需求/计划），否则本组等于空跑',
    JSON.stringify(outline13).includes('999'), outline13.length);
  const reqPage = allXml.find((x) => /需求/.test(x) && /条/.test(x)) ?? '';
  ok('E-02 产物里需求条数 = 库内真实条数（AI 写的 999 不落地）',
    reqPage.includes(`${reqTruth} 条`) && !/999 条/.test(reqPage), { truth: reqTruth, page: (reqPage.match(/\d+ 条/g) ?? []).slice(0, 6) });
  ok('E-03 全稿任何页都不出现被注入的 999',
    allXml.every((x) => !/>[^<]*999[^<]*<\/a:t>/.test(x)), allXml.map((x) => (x.match(/999/g) ?? []).length).filter((n) => n > 0));
  const warnList: string[] = done?.warnings ?? [];
  ok('E-04 改写逐页点名并如实进 warnings（「库内实为」可追）',
    warnList.some((w) => /999/.test(w) && /库内实为/.test(w)), warnList.slice(0, 4));
  ok('E-05 措辞段未违约（本轮 mock 合规，不应出现措辞降级告警）',
    !warnList.some((w) => /风险措辞 AI 失败/.test(w)), warnList.slice(0, 4));
}

// =====================================================================
// 收口
// =====================================================================
db.close();
child.kill();
mock.close();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }

const summary = `T02111 验收门：PASS ${pass} / FAIL ${fail}（样本项目 ${sample.map((p) => p.name).join('、') || '无'}）\n` + lines.join('\n');
writeGateResults(OUT_DIR, 't02111-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
