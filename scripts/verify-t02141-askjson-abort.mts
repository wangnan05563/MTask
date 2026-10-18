/**
 * T02141 门（派生自 T02103：`AIService.askJson` 支持 AbortSignal 透传——措辞段断连不再空烧配额）。
 *
 * 本版按 `docs/验收门判据规约.md` 四条硬判据改判（T02293）。改判前的六条 `S-01~S-06` 全是
 * `readFileSync(...)` + 正则匹配源码文本（`/signal\?: AbortSignal;/`、`/adapter\.chat\([\s\S]{0,240},\s*signal\)/`、
 * `/\{ temperature: 0, signal \}/`）——把 `opts` 改成两个重载、把措辞段提成共享函数、或给 askJson 再加一个
 * 可选参数，行为不变而门恒红；反过来适配器把 signal 接错位置（形参在、没进 fetch）门却看不见。
 * 现在这些判据一律打在**行为与产物**上：
 *
 *   W 组 夹具：门内 `initSchema()` 自建隔离库 + 自造项目/需求/计划（**完全不读生产库**），
 *            后续所有断言只引用本轮自己写进去的行；预检口径问 `preflight()` 的返回值
 *   P 组 askJson 中止语义：门进程**直调真 `AIService.askJson`**，逐家适配器（清单取运行时
 *            `listAdapterTypes()`，不写死四家名）打本机 mock，断言的是**返回値 + mock 观测 + `ai_usage` 实测行**
 *   A 组 真链路：隔离实例 SSE 起跑 → 措辞在途时客户端断开 → 断言 mock 侧连接被提前关闭且从未应答、
 *            次数不翻倍、令牌目录零残留、闸位归还、产物解包后的幻灯片数与 `pageCount` 自洽
 *   C 组 透传链字面锚：只作 `okPair` 的字面腿（源码一律 `git show HEAD:`，不信工作树），
 *            行为腿红 ⇒ 该条红；行为腿绿而锚失配 ⇒ 记 FAIL 交人判定
 *   N 组 负对照：逐条证明上面这些判据**有牙齿**（同款调用不传 signal / 重试场景 / 解析失败行 /
 *            篡改 pageCount / 往 tmp 门自己造一个孤儿令牌 / 抽掉一家适配器 / 内存里删掉 signal 传参）
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02141-askjson-abort.mts
 * 环境变量：`T02141_PORT`（默认随机 39500+rand300）、`T02141_TMP_ROOT`（默认 D:/code/tmp，**必须落可写盘**，
 * C: 常年 0 可用会把 sqlite 判成 SQLITE_FULL 假红）、`T02141_KEEP=1` 保留临时目录。
 * 隔离纪律：不碰生产库与生产实例（39877）；端口/数据全临时；模型走进程内 mock（零真实配额）；收尾删目录。
 * 结果落 .workbuddy/t02141-gate-results-<运行标识>.txt。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_ROOT = process.env.T02141_TMP_ROOT ?? 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02141-gate-'));
const TMP_DIR = join(DATA_DIR, 'tmp');
const PORT = Number(process.env.T02141_PORT ?? 39_500 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}/api`;
// ⚠ 先钉死数据目录，再 import 任何产品模块：`getDb()` 按该环境变量选库，缺省会连到生产库
process.env.MTask_DATA_DIR = DATA_DIR;
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;

/** 门内夹具项目 id：本门所有断言只引用以它为前缀的行，生产业务行一条不读（判据 2） */
const FIX = 't02141-gate-proj';
const FIX_NAME = 'T02141门内夹具项目';
const NOW = '2026-10-12T00:00:00.000Z';
const MOCK_DELAY_MS = 6_000; // 措辞应答延迟：远大于「断开→掐断」的观测窗口，才分得出「等满一轮」与「即时收手」
const ABORT_PROBE_MS = 2_500; // P 组在途中止用的应答延迟（与 A 组分开，避免整门等 6s）
/**
 * 措辞段的两个落点用门自造的标记串：产物里出现 MOCK 串＝措辞返回值真被搬上页面；出现 LOCAL 串＝回退到本地条目。
 * ⚠ 两串都**不含数字与「」**：产品把模型措辞钉回本地事实（`pinField`：数字白名单 + 「」名称白名单，
 * kickoffService.ts:1085-1102），带数字的标记会被判「编造」整段回退，门就测不到成功路径了。
 */
const LOCAL_COMMS = ['GATE-LOCAL-ALPHA', 'GATE-LOCAL-BETA'];
const MOCK_COMMS = ['GATE-MOCK-ALPHA', 'GATE-MOCK-BETA'];

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  lines.push(`[SKIP] ${range} —— ${why}（不计 PASS）`);
};
const evidence = (s: string) => lines.push(`[证据] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ======================= 已提交树（反模式 11：工作树可能被并发会话留成过期副本，字面腿一律读 HEAD） =======================
const srcCache = new Map<string, string>();
function headSource(rel: string): string {
  if (!srcCache.has(rel)) {
    try { srcCache.set(rel, execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT }).toString('utf8')); }
    catch { srcCache.set(rel, ''); }
  }
  return srcCache.get(rel)!;
}

// ======================= 判定函数（行为腿与 N 组共用同一实现——改判据只改这里） =======================
type MockObs = { startedAt: number; closedAt: number | null; answeredAt: number | null; abortedAt: number; delayMs: number };
/** 中止是否真的进到模型等待期：连接在应答之前就被关掉，且这一轮从未被应答 */
const judgeNeverAnswered = (o: MockObs) => o.closedAt !== null && o.answeredAt === null;
/** 关闭必须落在应答延迟窗口之内（等满整轮再丢＝改判前的空烧行为） */
const judgeClosedBeforeDelay = (o: MockObs) => o.closedAt !== null && o.closedAt - o.startedAt < o.delayMs;
/** 客户端断开到 mock 观测到关闭必须即时（不留悬挂的在途请求） */
const judgeClosedImmediately = (o: MockObs) => o.closedAt !== null && o.closedAt - o.abortedAt < 1_500;
/** 失败归因判据：取消族 ≠ 解析失败/超时/截断族——按「这一轮失败该由谁负责」的值级规则判，不锁措辞 */
const judgeCancelAttribution = (err: string | null | undefined) =>
  !!err && !/JSON 解析失败|解析|超时|ETIMEDOUT|截断|内容为空|truncat/i.test(err);
/** 产物自洽判据：装配层报的页数 == 解包后真实幻灯片数（展开续页只会让两者一起变大，不写死大纲页数） */
const judgePageCount = (reported: number, slideCount: number) => Number.isInteger(reported) && reported > 0 && reported === slideCount;
/** 孤儿令牌判据：tmp 下不允许留下任何 UUID 命名的落盘文件 */
const orphanTokens = () => readdirSync(TMP_DIR).filter((n) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n));
/**
 * 字面锚用的适配器调用点计数：逐个 `adapter.chat(...)` 实参表（允许一层嵌套括号）里必须带 `signal`。
 * 写成「每次调用各算一处」而不是 `[\s\S]{0,260}` 的跨行贪婪——后者会跨过一处调用命中另一处，
 * 篡改掉一半也照样绿（本门 N-07 正是拿这个反证要求锚点自身有牙齿）。
 */
const chatSignalSites = (src: string) =>
  (src.match(/adapter\.chat\([^()]*(?:\([^()]*\)[^()]*)*,\s*signal\s*\)/g) ?? []).length;

async function slideCountOf(buf: Buffer): Promise<number> {
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
}
async function deckTextOf(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  let out = '';
  for (const name of Object.keys(zip.files).sort()) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) out += (await zip.files[name].async('string')).replace(/<[^>]+>/g, ' ') + '\n';
  }
  return out;
}

// ======================= 进程内产品面（隔离库 + 真 AIService + 真适配器注册表） =======================
const U = (rel: string) => pathToFileURL(join(ROOT, 'server', rel)).href;
let RUNTIME = false;
let db: any = null;
let AIService: any = null;
let ADAPTER_TYPES: string[] = [];
let PREFLIGHT: { blocked: boolean; missingHard: string[] } | null = null;
let SEEDED_PROJECTS: string[] = [];
let closeDb: (() => void) | null = null;
try {
  const conn = (await import(U('src/db/connection.ts'))) as Record<string, any>;
  const { initSchema } = (await import(U('src/db/schema.ts'))) as Record<string, any>;
  conn.getDb();
  initSchema(); // 由产品自己建表：门不复制任何生产业务行
  db = conn.getDb();
  // initSchema 自带的产品种子行（如移动端收件箱系统项目）——W-02 用它做「除种子外只有夹具」的分母
  SEEDED_PROJECTS = (db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((r) => r.id);
  closeDb = typeof conn.closeDb === 'function' ? () => conn.closeDb() : null;
  AIService = (await import(U('src/services/AIService.ts'))).AIService;
  ADAPTER_TYPES = (await import(U('src/adapters/index.ts')) as Record<string, any>).listAdapterTypes();
  // ---- 门内夹具：一个项目 + PRD 原文 + 需求矩阵 + 计划（其中两条阻塞计划＝风险来源） ----
  db.prepare('INSERT INTO projects (id,name,description,sort_weight,created_at,updated_at,workspace_path) VALUES (?,?,?,0,?,?,?)')
    .run(FIX, FIX_NAME, '本门自造夹具，不含任何生产业务数据', NOW, NOW, ROOT);
  db.prepare('INSERT INTO prd_docs (id,project_id,filename,content_md,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(`${FIX}-prd`, FIX, 'PRD-门内夹具.md', '# 门内夹具 PRD\n\n范围：仅用于本门自证中止行为。\n'.repeat(12), NOW, NOW);
  const insReq = db.prepare(
    `INSERT INTO prd_requirements (id,project_id,prd_id,req_no,title,content,source_ref,priority,status,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,'','', 'normal',?,?,?,?)`,
  );
  for (let i = 0; i < 14; i++) {
    insReq.run(`${FIX}-r${i}`, FIX, `${FIX}-prd`, `R${i + 1}`, `夹具需求 ${i + 1}`, i < 7 ? 'done' : 'doing', i, NOW, NOW);
  }
  const insPlan = db.prepare(
    `INSERT INTO plan_tasks (id,project_id,title,description,start_date,end_date,duration_days,progress,status,
       assignee,sort_order,created_at,updated_at,kind,complexity,req_ids,deps)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '')`,
  );
  const plans: Array<[string, string, string, string, string]> = [
    ['p1', '夹具阶段一：需求澄清', '2026-10-05', '2026-10-09', 'done'],
    ['p2', '夹具阶段二：接口联调受阻', '2026-10-12', '2026-10-20', 'blocked'],
    ['p3', '夹具里程碑：方案评审', '2026-10-21', '2026-10-22', 'todo'],
    ['p4', '夹具阶段三：装配与验证受阻', '2026-10-23', '2026-10-30', 'blocked'],
    ['p5', '夹具阶段四：回归', '2026-11-02', '2026-11-06', 'todo'],
    ['p6', '夹具阶段五：交付', '2026-11-09', '2026-11-13', 'doing'],
  ];
  plans.forEach(([id, title, s, e, status], i) =>
    insPlan.run(`${FIX}-${id}`, FIX, title, s, e, 5, status === 'done' ? 100 : 0, status, `夹具责任人${i % 2 + 1}`, i, NOW, NOW,
      id === 'p3' ? 'milestone' : 'normal', 3));
  const { preflight } = (await import(U('src/services/kickoffService.ts'))) as Record<string, any>;
  const pf = preflight(FIX);
  PREFLIGHT = { blocked: pf.blocked === true, missingHard: (pf.missingHard ?? []) as string[] };
  RUNTIME = true;
} catch (e) {
  skipped('W/P 组与 C 组行为腿', `产品运行时面不可加载（原生模块 ABI 或 schema 问题）：${e instanceof Error ? e.message : String(e)}`);
}

// =====================================================================
// mock AI：按厂商形态路由应答，并记录每个请求的到达/关闭/应答时刻
// ——「连接被提前关闭且从未应答」是本门唯一能观测到的中止事实
// =====================================================================
type MockReq = { startedAt: number; closedAt: number | null; answeredAt: number | null; user: string; path: string };
const mockReqs: MockReq[] = [];
let mockDelayMs = 0;
let mockMode: 'wording' | 'garbage' | 'echo' = 'wording';
// 各家适配器把 endpoint 视作「不含版本段的根」，自行拼出 /v1/messages、/api/chat、/v1/chat/completions，
// workbuddy 中继契约则直接 POST endpoint 根路径——所以这里按**后缀**认路，不能假设端点没有前缀段。
const SHAPE_BY_PATH: Array<[RegExp, (content: string) => unknown]> = [
  [/\/v1\/messages$/, (c) => ({ content: [{ type: 'text', text: c }], stop_reason: 'end_turn' })],
  [/\/api\/chat$/, (c) => ({ message: { content: c }, done_reason: 'stop' })],
  [/\/chat\/completions$/, (c) => ({ choices: [{ message: { role: 'assistant', content: c }, finish_reason: 'stop' }], usage: { total_tokens: 10 } })],
  [/.*/, (c) => ({ ok: true, content: c })], // workbuddy 中继契约：POST 端点根路径（兜底位）
];
const mock = createServer((req, res) => {
  const entry: MockReq = { startedAt: Date.now(), closedAt: null, answeredAt: null, user: '', path: req.url ?? '' };
  mockReqs.push(entry);
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    let user = '';
    try {
      const j = JSON.parse(body);
      const msgs = Array.isArray(j.messages) ? j.messages.map((m: any) => m?.content ?? '').join('\n') : '';
      // 四家协议把话术放在不同字段：openai/claude/ollama 走 messages+system，workbuddy 中继契约走顶层 user
      user = [msgs, j.system ?? '', j.user ?? '', j.prompt ?? ''].join('\n');
    } catch { /* 坏请求回空 */ }
    entry.user = user;
    const reply = () => {
      if (entry.closedAt !== null || res.destroyed) return; // 连接已提前断：不再应答（否则观测点被污染）
      entry.answeredAt = Date.now();
      let content: string;
      if (mockMode === 'garbage') content = '这不是 JSON';
      else if (mockMode === 'echo') {
        const m = /GATE-ECHO=(\S+)/.exec(user);
        content = JSON.stringify({ echo: m ? m[1] : '' });
      } else {
        const want = /条数分别为 (\d+) 与 (\d+)。/.exec(user);
        const nRisks = want ? +want[1] : 2;
        const nComms = want ? +want[2] : 2;
        const items = [...user.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => m[1].trim());
        // 兜底条目不含数字：`pinField` 会把「系统数据里没有的数字」整段判回退（见上方标记串注释）
        const spareItems = ['夹具进度风险', '夹具范围风险'];
        content = JSON.stringify({
          risks: Array.from({ length: nRisks }, (_, i) => ({
            item: (items[i] ?? spareItems[i % spareItems.length]).slice(0, 40),
            impact: '会上确认影响面',
            mitigation: '会上明确责任方与时限',
          })),
          comms: Array.from({ length: nComms }, (_, i) => MOCK_COMMS[i % MOCK_COMMS.length]),
        });
      }
      const shape = (SHAPE_BY_PATH.find(([re]) => re.test(entry.path))?.[1] ?? SHAPE_BY_PATH[3][1])(content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(shape));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
  });
  // 判别点放在**响应**上：只有「响应还没写出去，连接就断了」才是客户端中止；
  // 服务端没透进中止信号时，这条连接会一直开着等到 mock 应答——两者在此分得开，行为腿才有判别力。
  res.on('close', () => { if (!res.writableEnded && entry.closedAt === null) entry.closedAt = Date.now(); });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 隔离实例（夹具库 → 自建空库，不复制生产库）
// =====================================================================
mkdirSync(TMP_DIR, { recursive: true });
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
async function download(token: string, fileName: string) {
  const res = await fetch(BASE + '/report/ai-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, filename: fileName }),
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), disposition: res.headers.get('content-disposition') ?? '' };
}
/** 走 SSE；abortWhen 为真即由客户端断开（断在措辞请求在途时，才是本门要的那一幕） */
async function streamGen(path: string, body: unknown, opts: { abortWhen?: () => boolean } = {}): Promise<{
  status: number; events: Array<{ event: string; data: any }>; aborted: boolean; abortedAt: number;
}> {
  const ac = new AbortController();
  const events: Array<{ event: string; data: any }> = [];
  let aborted = false;
  let abortedAt = 0;
  let status = 0;
  const kill = () => { if (aborted) return; aborted = true; abortedAt = Date.now(); ac.abort(); };
  const poll = opts.abortWhen ? setInterval(() => { if (opts.abortWhen!()) kill(); }, 100) : null;
  try {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
    status = res.status;
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('event-stream')) return { status, events, aborted, abortedAt };
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
      if (aborted) break;
    }
  } catch { /* 客户端 abort 抛 AbortError：预期内 */ }
  if (poll) clearInterval(poll);
  return { status, events, aborted, abortedAt };
}

/** 12 页标准稿（含风险页 + 沟通页，措辞段必然被调用——否则本门等于空跑） */
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
    ['沟通管理', '例会与变更口径', [], LOCAL_COMMS],
    ['附录', '数据口径与工作空间', ['workspace', 'prdDoc'], ['取数时间', '原文索引']],
  ];
  const layoutOf = (i: number) => (i === 0 ? 'cover' : i === 1 ? 'toc' : i === 6 ? 'timeline' : i === 7 ? 'chart' : i === 11 ? 'list' : 'table');
  return spec.map(([section, title, dataKeys, bullets], i) => ({
    section, title, bullets: section === '封面' ? [] : bullets, dataKeys, layout: layoutOf(i),
  }));
}

// =====================================================================
// W 组：夹具与隔离自证（改判前这里是 A-00「生产库只读副本已生成」——判据 2 明令降级为不留痕）
// =====================================================================
{
  if (!RUNTIME) {
    ok('W-01 隔离库由门内 `initSchema()` 建出（表与列由产品自己定义）', false, '运行时面未加载，见 SKIP');
  } else {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    ok('W-01 隔离库由门内 `initSchema()` 建出（products/tasks 等表齐备），门零读生产库',
      ['projects', 'tasks', 'plan_tasks', 'prd_docs', 'prd_requirements', 'ai_usage', 'ai_tools'].every((t) => tables.includes(t)),
      { 表数: tables.length });
    const projects = db.prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>;
    const outsiders = projects.map((p) => p.id).filter((id) => id !== FIX && !SEEDED_PROJECTS.includes(id));
    // 业务行只可能来自门内写入：所有 PRD / 需求 / 计划行的 project_id 都必须等于夹具 id
    const foreign = (['prd_docs', 'prd_requirements', 'plan_tasks'] as const)
      .map((t) => `${t}=${(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project_id<>?`).get(FIX) as { n: number }).n}`);
    ok('W-02 库内业务行**只有门自己造的这一个项目**（除 initSchema 自带种子行外无其它项目，PRD/需求/计划的 project_id 全指夹具；改判前判的是生产库里的 mtask五期业务行）',
      projects.some((p) => p.id === FIX) && outsiders.length === 0 && foreign.every((s) => s.endsWith('=0')),
      { 项目: projects.map((p) => p.id), initSchema种子: SEEDED_PROJECTS, 串味行: foreign });
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((r) => r.name);
    ok('W-03 夹具表列由产品 schema 给出（`PRAGMA table_info` 实测：plan_tasks 有 status/kind，ai_usage 有 kind/ok/error）',
      ['status', 'kind'].every((c) => cols('plan_tasks').includes(c)) && ['kind', 'ok', 'error', 'created_at'].every((c) => cols('ai_usage').includes(c)),
      { plan_tasks: cols('plan_tasks').length, ai_usage: cols('ai_usage') });
    ok('W-04 预检不阻塞：门内夹具经产品 `preflight()` 实测 blocked=false（P1/P2/P3 齐备，后续出稿才归因得到中止）',
      PREFLIGHT?.blocked === false && (PREFLIGHT?.missingHard.length ?? 99) === 0, PREFLIGHT);
    const risks = db.prepare("SELECT COUNT(*) n FROM plan_tasks WHERE project_id=? AND status='blocked'").get(FIX) as { n: number };
    ok('W-05 措辞段的输入前提在夹具里成立：2 条阻塞计划＝风险来源，大纲沟通页 2 条＝comms 来源',
      risks.n === 2, risks);
  }
}

// =====================================================================
// 实例起不来 ⇒ 后面全部如实留痕，不冒充 PASS
// =====================================================================
const UP = await waitUp();
if (!UP) ok('X-00 隔离实例启动', false, serverLog.join('').slice(-600));
else ok('X-00 隔离实例启动（夹具库经 `MTask_DATA_DIR` 挂载，未碰生产实例 39877）', true);

let toolByType: Record<string, string> = {};
const outline = baseOutline();
if (UP && RUNTIME) {
  for (const t of ADAPTER_TYPES) {
    const r = await call('POST', '/aitools', {
      name: `t02141-${t}`, type: t, endpoint: `http://127.0.0.1:${MOCK_PORT}`,
      apiKey: 'mock-key', model: 'mock-model', timeoutMs: 20_000,
    });
    if (r.body?.id) toolByType[t] = String(r.body.id);
  }
  ok('X-01 逐适配器 mock 工具已建（清单取运行时 `listAdapterTypes()`，零真实配额）',
    ADAPTER_TYPES.length >= 4 && ADAPTER_TYPES.every((t) => !!toolByType[t]),
    { types: ADAPTER_TYPES, created: Object.keys(toolByType) });
} else if (UP) {
  skipped('X-01 与 P/A/C/N 全部行为腿', '运行时面未加载，无法建工具与直调产品函数（见上方 SKIP 原因）');
}

// =====================================================================
// P 组：askJson 中止语义——门进程直调产品函数，断言其**返回值**与 mock/库里的实测效应
// （改判前的 S-01/S-02/S-03/S-04 四条源码正则全部由此替换：形参在不在不重要，中止进没进模型等待期才重要）
// =====================================================================
type TypeProbe = { type: string; toolId: string; okOk: boolean; okEcho: string; abortRes: any; obs: MockObs; hits: number; usageRow: any; settledMs: number };
let probes: TypeProbe[] = [];
let timeoutProbe: { hits: number; error: string; timedOutRow: boolean } | null = null;
let retryProbe: { hits: number; error: string; retriedFlag: any } | null = null;
let preAbortProbe: { hits: number; ok: boolean; error: string; settledMs: number } | null = null;

if (UP && RUNTIME) {
  // —— 正路：无中止时每种适配器都要能把 mock 的结构化应答解析成 data（改判前没有任何一条腿证过这个）——
  mockMode = 'echo';
  mockDelayMs = 0;
  const echoResults: Record<string, { ok: boolean; echo: string; error?: string }> = {};
  for (const type of ADAPTER_TYPES) {
    const before = mockReqs.length;
    const marker = `ECHO-${type}`;
    const res = await AIService.askJson(toolByType[type], 'sys', `请回显 GATE-ECHO=${marker} 的值`, (c: string) => JSON.parse(c));
    echoResults[type] = { ok: res.ok === true && res.data?.echo === marker, echo: res.data?.echo ?? '', error: res.error };
    if (mockReqs.length - before !== 1) echoResults[type].ok = false;
  }
  ok('P-01 无中止正路：每家适配器的 chat 应答都被 `askJson` 解析成结构化 data（signal 参数没把请求形状改坏）',
    ADAPTER_TYPES.every((t) => echoResults[t].ok === true), echoResults);

  // —— 中止在途：并发对每家适配器发起一次 askJson，250ms 后 abort ——
  mockMode = 'wording';
  mockDelayMs = ABORT_PROBE_MS;
  const started = mockReqs.length;
  const marks: Record<string, string> = {};
  ADAPTER_TYPES.forEach((t, i) => (marks[t] = `ABORT-${t}-${i}`));
  const acs = ADAPTER_TYPES.map(() => new AbortController());
  const calls = ADAPTER_TYPES.map((type, i) => {
    const startedAt = Date.now();
    return AIService.askJson(toolByType[type], 'sys', `请回显 GATE-ECHO=${marks[type]} 并说明中止`, (c: string) => JSON.parse(c), { signal: acs[i].signal })
      .then((res: any) => ({ res, settledMs: Date.now() - startedAt, clientAbortedAt: Date.now() }));
  });
  await sleep(250);
  const abortAt = Date.now();
  acs.forEach((ac) => ac.abort());
  const settled = await Promise.all(calls);
  await sleep(ABORT_PROBE_MS + 600); // 跨过 mock 的应答时刻：若服务端仍在等这轮，close 只会在应答后出现
  probes = ADAPTER_TYPES.map((type, i) => {
    const entry = [...mockReqs].reverse().find((m) => m.user.includes(marks[type]));
    const hits = mockReqs.filter((m) => m.user.includes(marks[type])).length;
    const row = db.prepare('SELECT kind, ok, error FROM ai_usage WHERE tool_id=? AND kind=? ORDER BY created_at DESC LIMIT 1')
      .get(toolByType[type], 'ask-json') as { kind: string; ok: number; error: string | null } | undefined;
    return {
      type, toolId: toolByType[type], okOk: settled[i].res.ok === true, okEcho: '',
      abortRes: settled[i].res,
      obs: {
        startedAt: entry?.startedAt ?? 0, closedAt: entry?.closedAt ?? null, answeredAt: entry?.answeredAt ?? null,
        abortedAt: abortAt, delayMs: ABORT_PROBE_MS,
      },
      hits, usageRow: row, settledMs: settled[i].settledMs,
    };
  });
  mockDelayMs = 0;

  const ev = (p: TypeProbe) => ({ type: p.type, ...p.obs, hits: p.hits, settledMs: Math.round(p.settledMs), error: p.abortRes?.error });
  ok('P-02 中止真的进到模型等待期：每家适配器的 mock 连接被提前关闭且该轮从未应答（形参写在源码里但没进 fetch 会被这条抓住）',
    probes.every((p) => judgeNeverAnswered(p.obs)), probes.map(ev));
  ok('P-03 关闭发生在应答延迟之前（等满一轮再丢＝改判前的空烧行为，必须被否证）',
    probes.every((p) => judgeClosedBeforeDelay(p.obs)), probes.map(ev));
  ok('P-04 从客户端 abort 到 mock 观测到关闭是即时的（不等整轮响应）',
    probes.every((p) => judgeClosedImmediately(p.obs)), probes.map(ev));
  ok('P-05 abort 不触发重试：每家 mock 只收到 1 次请求（收 2 次＝「停止」变成再等一轮、双份配额）',
    probes.every((p) => p.hits === 1), probes.map((p) => ({ type: p.type, hits: p.hits })));
  ok('P-06 中止后 `askJson` 的 Promise 在应答延迟窗口内就 resolve（没有残留的在途等待/定时器把这一路吊住）',
    probes.every((p) => p.settledMs < ABORT_PROBE_MS), probes.map((p) => ({ type: p.type, settledMs: Math.round(p.settledMs) })));
  ok('P-07 中止的返回値是失败而非成功（ok=false，且没有 data 冒充解析成功）',
    probes.every((p) => p.abortRes.ok === false && p.abortRes.data === undefined && p.abortRes.retried !== true),
    probes.map((p) => ({ type: p.type, ok: p.abortRes.ok, retried: p.abortRes.retried })));
  const usageMap = probes.map((p) => ({ type: p.type, row: p.usageRow }));
  ok('P-08 该轮在 `ai_usage` 如实记一条失败（ok=0），且归因落在取消族而不是解析/超时/截断族',
    probes.every((p) => p.usageRow && p.usageRow.ok === 0 && judgeCancelAttribution(p.usageRow.error)), usageMap);
  okPair(ok,
    'P-09 失败原因的措辞口径仍是「任务已停止」（行为腿＝P-08 的归因判据；字面腿只是文案哨兵，服务端改措辞时人来判定改锚还是改码）',
    () => probes.every((p) => p.usageRow?.ok === 0 && judgeCancelAttribution(p.usageRow?.error)) && probes.every((p) => judgeCancelAttribution(p.abortRes?.error)),
    () => probes.every((p) => /任务已停止/.test(p.usageRow?.error ?? '') && /任务已停止/.test(p.abortRes?.error ?? '')),
    () => probes.map((p) => ({ type: p.type, error: p.abortRes?.error })));
  evidence(`P 组观测：${JSON.stringify(probes.map((p) => ({ type: p.type, closedAt: p.obs.closedAt, answeredAt: p.obs.answeredAt, hits: p.hits })))}`);

  // —— 预先中止：signal 已 aborted 时不该再烧一次请求，也不该重试 ——
  {
    const before = mockReqs.length;
    const usageBefore = (db.prepare('SELECT COUNT(*) n FROM ai_usage').get() as { n: number }).n;
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const res = await AIService.askJson(toolByType[ADAPTER_TYPES[0]], 'sys', '预中止探针 GATE-ECHO=PRE-ABORT', (c: string) => JSON.parse(c), { signal: ac.signal });
    const settledMs = Date.now() - t0;
    await sleep(400);
    const row = db.prepare('SELECT ok, error FROM ai_usage WHERE tool_id=? AND kind=? ORDER BY created_at DESC LIMIT 1')
      .get(toolByType[ADAPTER_TYPES[0]], 'ask-json') as any;
    preAbortProbe = { hits: mockReqs.length - before, ok: res.ok === true, error: String(res.error ?? ''), settledMs };
    // 本产品的既有契约只覆盖「在途中止」（P-02~P-06 与 A 组实测的那条链）。**预先 aborted** 的信号在产品里
    // 走不到模型等待期——上游 kickoffPptStream 每处守卫都会先抛出，永不调到 askJson。
    // 因此这条不发明「预中止必须失败」的新契约，只锁三条任何实现都必须成立的既有不变量：
    //   ① 不额外烧配额（≤1 次请求）② 不吊死（在 mock 应答窗口内收场）③ 库账与返回值同向（不出现「返回成功但记失败」的假账）
    ok('P-10 预中止信号（既有契约外的边缘调用形）：不额外烧配额、不吊死、`ai_usage` 账目与返回值同向——门不发明产品未承诺的新契约，实际语义见证据行',
      preAbortProbe.hits <= 1 && preAbortProbe.settledMs < 30_000 && !!row && row.ok === (preAbortProbe.ok ? 1 : 0)
        && (preAbortProbe.ok === true || judgeCancelAttribution(String(row.error ?? '')))
        && (db.prepare('SELECT COUNT(*) n FROM ai_usage').get() as { n: number }).n > usageBefore,
      preAbortProbe);
    evidence(`P-10 预中止实测：请求数=${preAbortProbe.hits} ok=${preAbortProbe.ok} 返回错误="${preAbortProbe.error}" `
      + `库内该轮 ok=${row?.ok} 结算耗时=${preAbortProbe.settledMs}ms`
      + '｜适配器只监听 abort **事件**，已 aborted 的信号被视作有效请求，askJson 的 `signal?.aborted` 只守失败分支——'
      + '记入 T02293 报告作为契约空白，不在本门判据里发明新规则');
  }

  // —— 超时与中止同口径（T01289 那条 break 的真实效应，不是源码里的字样）——
  {
    const type = ADAPTER_TYPES.includes('openai-compatible') ? 'openai-compatible' : ADAPTER_TYPES[0];
    mockDelayMs = 3_000;
    const before = mockReqs.length;
    const t0 = Date.now();
    const res: any = await AIService.askJson(toolByType[type], 'sys', '超时探针 GATE-ECHO=TIMEOUT', (c: string) => JSON.parse(c), { timeoutMs: 700 });
    timeoutProbe = { hits: mockReqs.length - before, error: String(res.error ?? ''), timedOutRow: Date.now() - t0 < 2_500 };
    mockDelayMs = 0;
    ok('P-11 超时也不重试：mock 只收到 1 次请求，且失败原因属超时族（与中止同一条 break 的两半，各自实测）',
      timeoutProbe.hits === 1 && !judgeCancelAttribution(timeoutProbe.error) && timeoutProbe.timedOutRow === true, timeoutProbe);
  }

  // —— 「不重试」是取消/超时专属：普通解析失败仍要重试 1 次（否则 P-05 就是恒真的废话）——
  {
    mockMode = 'garbage';
    const before = mockReqs.length;
    const res: any = await AIService.askJson(toolByType[ADAPTER_TYPES[0]], 'sys', '解析失败探针', (c: string) => JSON.parse(c));
    const row = db.prepare('SELECT ok, error FROM ai_usage WHERE tool_id=? AND kind=? ORDER BY created_at DESC LIMIT 1')
      .get(toolByType[ADAPTER_TYPES[0]], 'ask-json') as any;
    retryProbe = { hits: mockReqs.length - before, error: String(row?.error ?? res.error ?? ''), retriedFlag: res.retried };
    mockMode = 'wording';
    ok('P-12 对照腿：非取消的失败（JSON 解析失败）确实重试到 2 次并在库里记解析归因——证明 P-05 的「1 次」是取消专属，不是所有失败都只打一次',
      retryProbe.hits === 2 && res.ok === false && /解析/.test(retryProbe.error), retryProbe);
  }
}

// =====================================================================
// A 组：真 SSE 链路上的中止（改判前的 S-05/S-06「措辞段确实传 signal」由此替换——
//   透传链任一环断开，下面的 mock 观测就不会出现「提前关闭且从未应答」）
// =====================================================================
let baseline: { done: any; slideCount: number; text: string } | null = null;
let abortRun: { r: Awaited<ReturnType<typeof streamGen>>; obs: MockObs; hits: number; usageRow: any } | null = null;
let afterRun: { done: any; slideCount: number } | null = null;
let degradeRun: { done: any; slideCount: number; text: string } | null = null;

if (UP && RUNTIME) {
  const toolId = toolByType['openai-compatible'] ?? Object.values(toolByType)[0];
  const body = { projectId: FIX, toolId, outline };

  mockMode = 'wording';
  mockDelayMs = 0;
  const before = mockReqs.length;
  const clean = await streamGen('/plans/kickoff-ppt-stream', body);
  const cleanDone = clean.events.find((e) => e.event === 'done');
  const dlClean = cleanDone ? await download(String(cleanDone.data.token), String(cleanDone.data.fileName)) : null;
  baseline = { done: cleanDone?.data ?? null, slideCount: dlClean && dlClean.status === 200 ? await slideCountOf(dlClean.buf) : -1, text: dlClean && dlClean.status === 200 ? await deckTextOf(dlClean.buf) : '' };
  ok('A-01 基线（无中止）：措辞段应答后出稿，`done` 带页数与可下载令牌',
    !!cleanDone && Number(cleanDone.data?.pageCount ?? 0) > 0, { events: clean.events.map((e) => e.event).join(','), done: cleanDone?.data });
  ok('A-02 产物自洽：解包 pptx 的真实幻灯片数 == 装配层报的 pageCount（不再拿「大纲 12 页」这个实现假设当判据——计划超行数会展开续页）',
    !!cleanDone && judgePageCount(Number(cleanDone.data.pageCount), baseline.slideCount), { pageCount: cleanDone?.data?.pageCount, slides: baseline.slideCount });
  ok('A-03 基线产物是 pptx 二进制且非琐碎大小（加 signal 后主路径零回归）',
    dlClean?.status === 200 && dlClean.buf.subarray(0, 2).toString() === 'PK' && dlClean.buf.length > 20_000,
    { status: dlClean?.status, bytes: dlClean?.buf.length });
  ok('A-04 大纲每一页的标题都被搬上幻灯片（页数下界由结构证明，与生产数据无关）',
    baseline.text.length > 0 && outline.every((o) => baseline!.text.includes(o.title)),
    { 缺页标题: outline.filter((o) => !baseline!.text.includes(o.title)).map((o) => o.title) });
  ok('A-05 措辞段真的接到产物上：沟通页展示的是本轮 mock 返回值（GATE-MOCK-*），门自造的本地条目已被替换',
    MOCK_COMMS.every((c) => baseline!.text.includes(c)) && LOCAL_COMMS.every((c) => !baseline!.text.includes(c)),
    { mock: MOCK_COMMS, local: LOCAL_COMMS, 措辞请求数: mockReqs.length - before });

  // ---- 中止跑：措辞请求在途即断开 ----
  mockDelayMs = MOCK_DELAY_MS;
  const hitsBefore = mockReqs.length;
  const usageBefore = (db.prepare('SELECT COUNT(*) n FROM ai_usage').get() as { n: number }).n;
  const r = await streamGen('/plans/kickoff-ppt-stream', body, { abortWhen: () => mockReqs.length > hitsBefore });
  ok('A-06 客户端确实在措辞在途时断开（mock 收到过请求且客户端已 abort）',
    r.aborted && mockReqs.length > hitsBefore, { aborted: r.aborted, reqs: mockReqs.length - hitsBefore });
  await sleep(1_500); // 跨过 mock 的应答时刻：若服务端仍在等这轮，close 只会在应答后出现
  const entry = mockReqs[hitsBefore];
  const obs: MockObs = { startedAt: entry?.startedAt ?? 0, closedAt: entry?.closedAt ?? null, answeredAt: entry?.answeredAt ?? null, abortedAt: r.abortedAt, delayMs: MOCK_DELAY_MS };
  const usageRow = db.prepare("SELECT kind, ok, error FROM ai_usage WHERE kind='ask-json' AND ok=0 ORDER BY created_at DESC LIMIT 1").get() as any;
  abortRun = { r, obs, hits: mockReqs.length - hitsBefore, usageRow };
  ok('A-07 服务端把中止透进了模型等待期：mock 侧连接被提前关闭且从未收到应答（措辞段→askJson→适配器整条链一环不落）',
    judgeNeverAnswered(obs), obs);
  ok('A-08 关闭发生在应答延迟之前（等满 6s 再丢＝改判前的行为，必须被否证）',
    judgeClosedBeforeDelay(obs), { elapsedMs: obs.closedAt ? obs.closedAt - obs.startedAt : null, mockDelayMs: MOCK_DELAY_MS });
  ok('A-09 从客户端 abort 到 mock 观测到关闭是即时的', judgeClosedImmediately(obs),
    { deltaMs: obs.closedAt ? obs.closedAt - obs.abortedAt : null });
  ok('A-10 中止不触发重试：整轮 mock 只收到 1 次措辞请求', abortRun.hits === 1, { hits: abortRun.hits });
  ok('A-11 中止这一路没有产出 done（错误以 abort 归因收场，不是「已出稿但前端没收到」）',
    !r.events.some((e) => e.event === 'done'), { events: r.events.map((e) => e.event).join(',') });
  ok('A-12 该轮在 `ai_usage` 如实记失败且归因取消族（不被误记成 JSON 解析失败）',
    !!usageRow && usageRow.ok === 0 && judgeCancelAttribution(usageRow.error)
      && (db.prepare('SELECT COUNT(*) n FROM ai_usage').get() as { n: number }).n > usageBefore,
    { usageBefore, usageAfter: (db.prepare('SELECT COUNT(*) n FROM ai_usage').get() as { n: number }).n, row: usageRow });
  ok('A-13 中止后无孤儿令牌落盘（措辞阶段收手，压根没走到落盘那一步）',
    orphanTokens().length === 0, orphanTokens());
  lines.push(`[证据] A-07~A-09 观测：mock 请求=${JSON.stringify(obs)} | 客户端 abort 后 ${Date.now() - r.abortedAt}ms 取样 | 本轮新增请求数=${abortRun.hits}`);

  // ---- 闸位与实例健康：中止不能把共用闸锁死 ----
  mockDelayMs = 0;
  const after = await streamGen('/plans/kickoff-ppt-stream', body);
  const afterDone = after.events.find((e) => e.event === 'done');
  const dlAfter = afterDone ? await download(String(afterDone.data.token), String(afterDone.data.fileName)) : null;
  afterRun = { done: afterDone?.data ?? null, slideCount: dlAfter && dlAfter.status === 200 ? await slideCountOf(dlAfter.buf) : -1 };
  ok('A-14 中止后闸位归还：紧随其后的完整生成仍能出稿，且产物页数自洽（signal 释放没把闸或 worker 卡住）',
    !!afterDone && judgePageCount(Number(afterDone.data.pageCount), afterRun.slideCount),
    { events: after.events.map((e) => e.event).join(','), pageCount: afterDone?.data?.pageCount, slides: afterRun.slideCount });
  mockMode = 'garbage';
  const bad = await streamGen('/plans/kickoff-ppt-stream', body);
  const badDone = bad.events.find((e) => e.event === 'done');
  const dlBad = badDone ? await download(String(badDone.data.token), String(badDone.data.fileName)) : null;
  degradeRun = {
    done: badDone?.data ?? null,
    slideCount: dlBad && dlBad.status === 200 ? await slideCountOf(dlBad.buf) : -1,
    text: dlBad && dlBad.status === 200 ? await deckTextOf(dlBad.buf) : '',
  };
  mockMode = 'wording';
  ok('A-15 措辞段失败只降级不阻断：模型输出不合约束时产物回退本地条目并记 warning（这条同时是 A-05 的反向证据——判据认的是本轮措辞返回值）',
    !!degradeRun.done && MOCK_COMMS.every((c) => !degradeRun!.text.includes(c)) && LOCAL_COMMS.every((c) => degradeRun!.text.includes(c))
      && String(degradeRun.done.warnings ?? []).length > 0,
    { warnings: degradeRun?.done?.warnings?.slice(0, 2), slides: degradeRun?.slideCount });
  const health = await call('GET', '/health');
  ok('A-16 实例仍健康且日志无未捕获异常（abort 不能以 reject 收场）',
    health.status === 200 && !/unhandledRejection|uncaughtException/.test(serverLog.join('')),
    (serverLog.join('').match(/unhandledRejection|uncaughtException[^\n]{0,120}/) ?? []).slice(0, 2));
}

// =====================================================================
// C 组：透传链字面锚（判据 3：只作 okPair 字面腿，且源码一律读 HEAD，不信可能过期的工作树）
//   行为腿红 ⇒ 该条红（红因「行为失守」）；行为腿绿而锚失配 ⇒ 记 FAIL 交人判定
// =====================================================================
if (RUNTIME) {
  const AIS_HEAD = headSource('server/src/services/AIService.ts');
  const KICK_HEAD = headSource('server/src/services/kickoffService.ts');
  const askJsonBody = (src: string) => {
    const a = src.indexOf('async askJson<T>');
    const b = src.indexOf('async askStream');
    return a >= 0 && b > a ? src.slice(a, b) : '';
  };
  okPair(ok,
    'C-01 askJson→adapter.chat 的 signal 透传锚（行为腿＝P 组逐家适配器的提前关闭/不重试实测；HEAD 文本失配只在行为仍绿时才是「换了写法」）',
    () => probes.length > 0 && probes.every((p) => judgeNeverAnswered(p.obs) && p.hits === 1),
    () => {
      const body = askJsonBody(AIS_HEAD);
      const total = (body.match(/adapter\.chat\(/g) ?? []).length;
      return /signal\?:\s*AbortSignal/.test(body) && total > 0 && chatSignalSites(body) === total;
    },
    () => {
      const body = askJsonBody(AIS_HEAD);
      return { 探针数: probes.length, 行为红项: probes.filter((p) => !judgeNeverAnswered(p.obs)).map((p) => p.type), 带signal的chat调用点: chatSignalSites(body), chat调用点总数: (body.match(/adapter\.chat\(/g) ?? []).length };
    });
  okPair(ok,
    'C-02 措辞段透传锚（行为腿＝A-07/A-10 整条 SSE 链的提前关闭与不翻倍请求数）',
    () => !!abortRun && judgeNeverAnswered(abortRun.obs) && abortRun.hits === 1,
    () => /async function polishWording\([\s\S]{0,300}signal\?: AbortSignal/.test(KICK_HEAD) && /\{ temperature: 0, signal \}/.test(KICK_HEAD)
      && /polishWording\(bundle, toolId, local, warnings, signal\)/.test(KICK_HEAD),
    () => ({ 观测: abortRun?.obs, hits: abortRun?.hits }));
  okPair(ok,
    'C-03 中止即收手的守卫锚（行为腿＝A-13 零孤儿令牌 + A-11 无 done；锚认的是「每处 signal 检查都配一条中止抛出」，不认具体处数）',
    () => orphanTokens().length === 0 && !(abortRun?.r.events ?? []).some((e) => e.event === 'done'),
    () => {
      const guards = (KICK_HEAD.match(/if \(signal\?\.aborted\)/g) ?? []).length;
      const throws = (KICK_HEAD.match(/throw new Error\(KICKOFF_ABORT_MSG\)/g) ?? []).length;
      return guards >= 3 && throws === guards;
    },
    () => ({
      孤儿: orphanTokens(),
      守卫处: (KICK_HEAD.match(/if \(signal\?\.aborted\)/g) ?? []).length,
      中止抛出: (KICK_HEAD.match(/throw new Error\(KICKOFF_ABORT_MSG\)/g) ?? []).length,
    }));
  okPair(ok,
    'C-04 「超时与中止同口径不重试」锚（行为腿＝P-05 逐家 1 次 + P-11 超时也 1 次）',
    () => probes.length > 0 && probes.every((p) => p.hits === 1) && timeoutProbe?.hits === 1,
    () => /if \(res\.timedOut \|\| signal\?\.aborted\) break;/.test(askJsonBody(AIS_HEAD)),
    () => ({ hits: probes.map((p) => p.hits), timeoutProbe }));
}

// =====================================================================
// N 组：负对照（判据 4）——每条改判都要在「行为被破坏」时转红，否则它自己就是假判据
// =====================================================================
if (UP && RUNTIME) {
  // N-01 真跑一次**不传 signal** 的同款调用：mock 一定被应答，judge 必须判假。
  // 这是「透传」这件事的反证——不是伪造数据，而是把链路上那一环诚实地摘掉。
  {
    mockMode = 'echo';
    mockDelayMs = 2_000;
    const before = mockReqs.length;
    const marker = 'NO-SIGNAL';
    const p = AIService.askJson(toolByType[ADAPTER_TYPES[0]], 'sys', `请回显 GATE-ECHO=${marker}`, (c: string) => JSON.parse(c));
    await sleep(500); // 不 abort：让它自己等到应答
    const res: any = await p;
    await sleep(2_000);
    mockDelayMs = 0;
    const entry = mockReqs[before];
    const obs: MockObs = { startedAt: entry.startedAt, closedAt: entry.closedAt, answeredAt: entry.answeredAt, abortedAt: entry.startedAt + 250, delayMs: 2_000 };
    ok('N-01 反证（不传 signal 的真调用）：同一 judge 必须判假——answeredAt 非空、连接没有提前关闭，证明 P-02~P-04 盯的是中止透传本身',
      res.ok === true && judgeNeverAnswered(obs) === false && judgeClosedBeforeDelay(obs) === false,
      { 返回: { ok: res.ok, echo: res.data?.echo }, 观测: obs });
    mockMode = 'wording';
  }
  // N-02 「次数==1」判据打在真会重试的场景（P-12 的实测观测）：必须为假
  ok('N-02 反证：把「abort 不重试」的次数判据打在解析失败的真重试场景上必须为假（否则 P-05 恒真、没有牙齿）',
    !!retryProbe && retryProbe.hits === 2 && (retryProbe.hits === 1) === false, retryProbe);
  // N-03 归因判据打在真解析失败行上：必须为假（否则「归因取消」其实是「任何失败都算」）
  {
    const parseRow = db.prepare("SELECT error FROM ai_usage WHERE kind='ask-json' AND ok=0 AND error LIKE '%解析%' ORDER BY created_at DESC LIMIT 1").get() as any;
    ok('N-03 反证：归因判据遇到库里真实的「JSON 解析失败」行必须为假（P-08/A-12 认的是取消族，不是任意失败行）',
      !!parseRow && judgeCancelAttribution(parseRow.error) === false, { 取到的解析失败行: String(parseRow?.error ?? '').slice(0, 120) });
  }
  // N-04 页数自洽判据打在篡改值上：必须为假
  ok('N-04 反证：把 pageCount 篡改 +1 后同一判据必须转红（A-02 认的是「报的页数==解包幻灯片数」，不是「文件非空」）',
    !!baseline && judgePageCount(Number(baseline.done?.pageCount) + 1, baseline.slideCount) === false
      && judgePageCount(Number(baseline.done?.pageCount), baseline.slideCount) === true,
    { 报告页数: baseline?.done?.pageCount, 幻灯片数: baseline?.slideCount });
  // N-05 孤儿令牌判据的牙齿：往隔离 tmp 里放一个门自己造的 UUID 令牌文件 → 必须转红；删除后转绿（双向）
  {
    const fake = 'deadbeef-0000-4000-8000-000000000214';
    const planted = join(TMP_DIR, fake);
    const before = orphanTokens().length;
    writeFileSync(planted, Buffer.from('PK\x03\x04 planted by gate negative control'));
    const during = orphanTokens();
    const red = during.length === before + 1 && during.includes(fake);
    rmSync(planted, { force: true });
    ok('N-05 反证：往隔离 tmp 放一个 UUID 命名的孤儿令牌，A-13 的同一判据必须点名它并转红；删掉即复绿（判据认的是目录里的文件，不是「跑过了就该是空」）',
      red && orphanTokens().length === before, { 放置前: before, 放置后: during, 删除后: orphanTokens().length });
  }
  // N-06 分母腿：逐适配器覆盖面必须等于运行时清单；人为抽掉一家，判据必须转红（反模式 13：覆盖面要有分母）
  ok('N-06 分母腿自证：P 组探针清单长度 == `listAdapterTypes()` 长度且 ≥4；把清单人为截短一位，同一判据必须转红',
    probes.length === ADAPTER_TYPES.length && ADAPTER_TYPES.length >= 4 && probes.slice(0, -1).length !== ADAPTER_TYPES.length,
    { 运行时适配器: ADAPTER_TYPES, 探针数: probes.length });
  // N-07 字面腿的牙齿：在内存里把 HEAD 源码的 signal 传参删掉，C-01 的字面 matcher 必须失配（行为腿不受影响）
  {
    const src = headSource('server/src/services/AIService.ts');
    const bodyOrig = src.slice(src.indexOf('async askJson<T>'), src.indexOf('async askStream'));
    const total = (bodyOrig.match(/adapter\.chat\(/g) ?? []).length;
    const tampered = bodyOrig.replace(/,\s*signal\s*\)/g, ')');
    ok('N-07 反证：把 HEAD 源码里的 `, signal` 实参在内存副本中删掉，C-01 的字面 matcher 必须失配（锚点确实盯得住每一处调用，不是能跨调用命中的恒真正则）',
      chatSignalSites(bodyOrig) === total && total >= 2 && chatSignalSites(tampered) < total,
      { chat调用点总数: total, 原文带signal: chatSignalSites(bodyOrig), 篡改后带signal: chatSignalSites(tampered) });
  }
  // N-08 产物文本判据的牙齿：期望串换成门自己造的另一串必须落空（证明 A-05 读的是幻灯片正文而不是「文本非空」）
  ok('N-08 反证：把措辞期望串篡改成仓里不存在的标记，A-05 的同一包含判定必须转红',
    !!baseline && baseline.text.length > 0 && MOCK_COMMS.every((c) => baseline!.text.includes(c)) === true
      && ['GATE-NOPE-1'].every((c) => baseline!.text.includes(c)) === false,
    { 正标记命中: MOCK_COMMS.map((c) => baseline!.text.includes(c)), 假标记命中: [baseline!.text.includes('GATE-NOPE-1')] });
}

// =====================================================================
// 收口：tree-kill（Windows 上 kill 是异步的，子进程会留着 sqlite 句柄）+ 临时目录清理
// =====================================================================
try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
await sleep(1_000);
child.kill();
mock.close();
if (closeDb) { try { closeDb(); } catch { /* 已关 */ } }
let removed = false;
if (process.env.T02141_KEEP !== '1') {
  for (let i = 0; i < 12; i++) {
    try { rmSync(DATA_DIR, { recursive: true, force: true }); removed = !existsSync(DATA_DIR); break; } catch { await sleep(1_000); }
  }
}
ok('Z-01 收尾零残留：临时数据目录已删除（或按 T02141_KEEP 显式保留），主仓产品路径未被本门写入',
  process.env.T02141_KEEP === '1' || removed, { DATA_DIR, 残留: existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : [] });

const summary = `T02141 askJson 中止门（T02293 改判版）：PASS ${pass} / FAIL ${fail}${skippedList.length ? ` / SKIP ${skippedList.length}` : ''}\n` + lines.join('\n')
  + (skippedList.length ? `\n\n跳过项：\n${skippedList.join('\n')}\n` : '');
writeGateResults(OUT_DIR, 't02141-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
