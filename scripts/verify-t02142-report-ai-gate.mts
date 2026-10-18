/**
 * T02142 门（派生自 T02105：AI 周报两条生成端点补挂 REPORT_GATE——FR-5 共用闸补齐另一半）。
 *
 * 本版按 `docs/验收门判据规约.md` 四条硬判据改判（T02293）。改判前的毛病有三类：
 *   ① `S-01~S-05` 是 `readFileSync(routes/index.ts)` + 正则匹配**挂载点文本**——把两个处理函数提成共享
 *      工厂、把 `exportGate` 换成同名包装、给路由加一层数组式中间件，行为不变而门恒红；反过来
 *      「挂是挂了、闸名写错成另一只闸」这类真事故，文本正则看不见。现在矩阵打在**运行中的路由表**
 *      （`api.stack` 枚举）+ **饱和窗口里逐条真探测**的状态码上，字面量只留 `okPair` 的字面腿。
 *   ② `S-06~S-08` 匹配前端源码里的 `if (!res.ok) ... body.error` 与 `import { GATE_BUSY_MSG }`——
 *      `streamEvents` 是**可在 Node 里直接调用**的前端模块（配 `web-dom-shim`），于是真打两次：
 *      未饱和跑通、饱和时看它 reject 出来的 message 是不是闸文案，判据立刻落在值上。
 *   ③ 数据侧抄生产库（复制 `%APPDATA%/MTask/data/mtask.db`）并写死 `FIVE_PID=mtask五期`——判据 2 明令降级。
 *      现在门内 `initSchema()` 自建空库，夹具项目经**产品自己的写入口**（`POST /projects`/`POST /tasks`）
 *      建出，PRD/计划行按产品 schema 自造，取数口径问 `gatherReportData()` 的**返回值**，
 *      产物断言打在解包后的 OOXML 正文上（比对文本不比字节，反模式 2）。
 *
 * 分工不变：verify-t02105 证接线，verify-t02113 G 组证离线四格式上限，本门证 AI 周报这两条最重链路
 * 真的计入**同一只闸**，并且：
 *   M 组 活路由表当分母，占满闸后逐条打：重活必 429、轻活（下载/模板）必不被 429、GET 仍 200；
 *   R 组 门进程直调 `exportGate()` 中间件本体（假 req/res + 真事件），断言计数增减、拒绝不吃槽位、
 *        finish/close 各自归还且双事件不重复减、按闸名相互独立、app_settings 即时调限与非法值回退、
 *        defer 的「让出一次事件循环」在时序上可观测；
 *   K 组 令牌与文件名单源：非法 token 400、合法但未落盘 404、下载即删、白名单名回环、非白名单名在
 *        `Content-Disposition` 上**看得见**地回退、`sweepReportTmp` 只碰「过期 + UUID 名」两条同时成立者；
 *   A 组 产物字节解包：洞察锚点必须出现在 xlsx/docx/pptx 正文里，夹具名与任务标题必须在、
 *        生产项目名必须不在；PDF 是子集化字体（文本不可按 UTF-8 检索），该侧只断结构（页对象）与
 *        「数据量→体积」单调关系，缺口如实写在标签里；
 *   C 组 挂载点/单源常量字面锚：一律 `git show HEAD:`，只作 `okPair` 字面腿；
 *   N 组 负对照：成功响应打在闸文案判据上必为假、掺一条不存在路由进分母必转红、孤儿令牌双向、
 *        白名单双向、从未发送的标记必不命中、连拒后释放干净不留计数、内存里删掉挂载实参后字面腿必失配。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02142-report-ai-gate.mts
 * 环境变量：`T02142_PORT`（默认随机 39400+rand300）、`T02142_TMP_ROOT`（默认 D:/code/tmp，**必须落可写盘**，
 * C: 常年满盘会把 sqlite 判成 SQLITE_FULL 假红）、`T02142_KEEP=1` 保留临时目录。
 * 隔离纪律：不碰生产库与生产实例（39877）；数据目录/端口全临时；模型走本机 mock（零真实配额）；收尾删目录。
 * 结果落 .workbuddy/t02142-gate-results-<运行标识>.txt。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';
import { shimWebDocumentForNode } from './lib/web-dom-shim.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_ROOT = process.env.T02142_TMP_ROOT ?? 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02142-gate-'));
const TMP_DIR = join(DATA_DIR, 'tmp');
mkdirSync(TMP_DIR, { recursive: true });
const PORT = Number(process.env.T02142_PORT ?? 39_400 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}/api`;
const PROD_DATA_DIR = join(process.env.APPDATA ?? '', 'MTask', 'data');
// ⚠ 先钉死数据目录，再 import 任何产品模块：`getDb()` 按该环境变量选库，缺省会连到生产库
process.env.MTask_DATA_DIR = DATA_DIR;
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;

const AI_DELAY_MS = 1_800; // 让并发真的重叠，才量得出「2 接受 2 拒」而不是全过
const HOLD_MS = 6_000; // 占闸窗口用的长延迟（远大于矩阵探测耗时）
/** 门自造的洞察锚点：只可能由本轮 mock 产出，产物里出现它＝洞察正文真被搬进了文件 */
const INSIGHT_MARK = 'GATE2142INSIGHTANCHOR';
const FAKE_MARK = 'GATE2142NEVERSENT';
/** 生产库里的项目名片段：产物与夹具库里都不许出现（判据 2 的反向自证） */
const PROD_NAME_HINT = 'mtask五期';
const FIX_A_NAME = 'T02142门内夹具甲项目';
const FIX_B_NAME = 'T02142门内夹具乙空项目';
const TASK_TITLES = ['夹具任务甲一：口径核对', '夹具任务甲二：接口联调', '夹具任务甲三：回归归档'];
const NOW_ISO = new Date().toISOString();

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
const IDX_HEAD = headSource('server/src/routes/index.ts');
const PLANS_HEAD = headSource('server/src/routes/plans.ts');
const SSE_HEAD = headSource('web/src/api/sse.ts');
const EG_HEAD = headSource('server/src/util/export-gate.ts');
const KP_HEAD = headSource('web/src/pages/KickoffPptPanel.tsx');
const RP_HEAD = headSource('web/src/pages/ReportPage.tsx');
/** 挂载点字面判定：路由串闭引号之后紧跟 `, exportGate(REPORT_GATE`（原门注释里记着 split(',') 在内层逗号处断的教训） */
const mountedIn = (src: string, route: string) => {
  const quoted = `'${route}'`;
  const i = src.indexOf(quoted);
  if (i < 0) return false;
  return /^\s*,\s*exportGate\(REPORT_GATE\b/.test(src.slice(i + quoted.length));
};

/** 闸名以常量引用的**处数**：`exportGate(REPORT_GATE` 起头即算——实参允许带 `undefined`/`{defer}`，
 *  把闭括号写进正则会把 `exportGate(REPORT_GATE, undefined, {defer:true})` 这种合法挂载数成 0（实测 C-03 假红） */
const gateRefCount = (src: string) => (src.match(/exportGate\(\s*REPORT_GATE\b/g) ?? []).length;

// =====================================================================
// 判定函数（行为腿、C 组与 N 组共用同一实现——改判据只改这里）
// =====================================================================
/** 闸拒的分类判据：结构化体里的 error 串**包含**前端单源常量（包含而非全等，见 sse.ts 注释） */
const judgeBusyBody = (body: any, busyLit: string) =>
  busyLit.length > 0 && typeof body?.error === 'string' && body.error.includes(busyLit);
/** 429 必须是「先拒后答」的完整 JSON，不是半开的 event-stream */
const judgeRejected = (r: { status: number; ctype?: string; body?: any }, busyLit: string) =>
  r.status === 429 && /application\/json/.test(r.ctype ?? '') && judgeBusyBody(r.body, busyLit);
/** 放行侧的最低自我证明：200 + 令牌 + 洞察正文 */
const judgeAccepted = (r: { status: number; body?: any }) =>
  r.status === 200 && typeof r.body?.token === 'string' && typeof r.body?.insight === 'string';
/** 魔数与扩展名相符（比对的是内容魔数，不是两次构建的字节相等） */
const magicOf = (buf: Buffer, filename: string) =>
  /\.pdf$/i.test(filename) ? buf.subarray(0, 5).toString('latin1').startsWith('%PDF') : buf.subarray(0, 2).toString('latin1') === 'PK';
const pdfStructOf = (buf: Buffer) => {
  const s = buf.toString('latin1');
  return {
    header: s.startsWith('%PDF-'),
    pages: (s.match(/\/Type\s*\/Page[^s]/g) ?? []).length,
    eof: /%%EOF\s*$/.test(s.trimEnd()),
    bytes: buf.byteLength,
  };
};
/** OOXML 三形态统一取「解包后的正文文本」 */
async function ooxmlTextOf(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  let out = '';
  for (const name of Object.keys(zip.files).sort()) {
    if (!/\.xml$/i.test(name)) continue;
    out += (await zip.files[name].async('string')).replace(/<[^>]*>/g, ' ') + '\n';
  }
  return out;
}
/** 令牌目录里的 UUID 文件（与产品 sweep 同一把钥匙） */
const tokenFiles = () => readdirSync(TMP_DIR).filter((n) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n));
/** 只登记「本轮没被就地下载过」的令牌：既是收口统一验下载的名册，也是判定孤儿的依据 */
const tokens: Array<{ token: string; filename: string }> = [];
/** 孤儿判据（K-12 与 N-03 共用同一实现）：目录里出现「不在本门待下载名册上」的 UUID 文件即孤儿 */
const orphansOf = () => tokenFiles().filter((f) => !tokens.some((t) => t.token === f));
/** 归因探针：K-12 报「有孤儿」时得说清是哪个阶段开始漏的（不靠猜——每段落笔处记一次计数） */
const orphanMark = (stage: string) => evidence(`${stage} 落笔时：名册=${tokens.length} 在册文件=${tokens.filter((t) => existsSync(join(TMP_DIR, t.token))).length} 孤儿=${orphansOf().length}${orphansOf().length ? ` ${orphansOf().join(',')}` : ''}`);
/** 流式腿拿到的 done 事件里同样有令牌：不登记就会在收口时被判成孤儿，登记了才能下载并删净 */
const keepStream = (s: { events: Array<{ event: string; data: any }> }) => {
  for (const ev of s.events) {
    if (ev.event === 'done' && typeof ev.data?.token === 'string' && typeof ev.data?.filename === 'string') {
      tokens.push({ token: ev.data.token, filename: ev.data.filename });
    }
  }
};

// =====================================================================
// mock AI：openai 兼容形态的洞察服务（可调延迟 + 请求计数）
// =====================================================================
let mockDelayMs = 0;
let mockHits = 0;
const mockInsight = [INSIGHT_MARK, '本期完成 3 项、进行中 2 项；风险提示：里程碑临近，建议例会跟节点走。', '下步安排：按夹具排期推进，验收口径以门内数据为准。'].join('\n');
/** 同一枚洞察，两种协议形态：`chat()` 要 JSON，`chatStream()` 要 `data:` 逐 delta（见 adapters/openaiCompat.ts） */
const sseChunksOf = (content: string) => {
  const parts = content.split('\n').map((s, i, a) => (i < a.length - 1 ? s + '\n' : s)).filter((s) => s.length > 0);
  return [
    ...parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
};
const mock = createServer((req, res) => {
  mockHits += 1;
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const wantsStream = /"stream"\s*:\s*true/.test(body);
    const reply = () => {
      if (res.destroyed || res.writableEnded) return;
      if (wantsStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.end(sseChunksOf(mockInsight));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: mockInsight }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 进程内产品面：隔离库由 initSchema() 建出（**不复制生产库**），闸本体与令牌工具直接调用
// =====================================================================
const U = (rel: string) => pathToFileURL(join(ROOT, 'server', rel)).href;
let RUNTIME = false;
let db: any = null;
let closeDb: (() => void) | null = null;
let GATE: { exportGate: (n: string, l?: number, o?: { defer?: boolean }) => any; gateSnapshot: () => Record<string, number>; REPORT_GATE: string; EXPORT_GATE_LIMIT: number } | null = null;
let RS: { isReportToken: any; saveReportBuffer: any; readAndDeleteReport: any; discardReport: any; sweepReportTmp: any; gatherReportData: any; REPORT_TMP_TTL_MS: number } | null = null;
let NAMES: { DOWNLOAD_NAME_RE: RegExp; safeExportName: any; downloadSafeName: any } | null = null;
let SETTINGS: { setSetting: (k: string, v: string) => void; getSetting: (k: string) => string | null } | null = null;
let ROUTES: string[] = [];
let SEEDED_PROJECTS: string[] = [];
try {
  const conn = (await import(U('src/db/connection.ts'))) as Record<string, any>;
  const { initSchema } = (await import(U('src/db/schema.ts'))) as Record<string, any>;
  conn.getDb();
  initSchema(); // 产品自己建表与种子，门零读生产业务行
  db = conn.getDb();
  SEEDED_PROJECTS = (db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((r) => r.id);
  closeDb = typeof conn.closeDb === 'function' ? () => conn.closeDb() : null;
  GATE = (await import(U('src/util/export-gate.ts'))) as any;
  RS = (await import(U('src/services/ReportService.ts'))) as any;
  NAMES = (await import(U('src/util/export-name.ts'))) as any;
  SETTINGS = (await import(U('src/services/AppSettings.ts'))) as any;
  const routes = (await import(U('src/routes/index.ts'))) as Record<string, any>;
  const walk = (stack: unknown[], prefix: string) => {
    for (const layer of stack as Array<Record<string, any>>) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods ?? {}).map((k) => k.toUpperCase()).join(',');
        ROUTES.push(`${methods} ${prefix}${layer.route.path}`);
      } else if ((layer.handle as Record<string, any>)?.stack) {
        let mp = '';
        if (typeof layer.path === 'string' && layer.path.length > 1) mp = layer.path;
        else {
          const s = String(layer.regexp?.source ?? '');
          const a = s.indexOf('^\\/');
          if (a >= 0) {
            let rest = s.slice(a + 3);
            const b = rest.indexOf('\\/?');
            if (b >= 0) rest = rest.slice(0, b);
            mp = rest ? '/' + rest.split('\\/').join('/').split('\\.').join('.') : '';
          }
        }
        walk((layer.handle as Record<string, any>).stack, prefix + mp);
      }
    }
  };
  walk(routes.api?.stack ?? [], '');
  RUNTIME = true;
} catch (e) {
  skipped('W/R/K/A/C/N 组的产品侧腿', `运行时面不可加载（原生模块 ABI 或 schema 问题）：${e instanceof Error ? e.message : String(e)}`);
}

// =====================================================================
// HTTP 侧工具
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
/** 统一取「状态码 + content-type + 解析体 + 字节」——所有断言都打在这些**响应值**上 */
async function hit(method: string, path: string, json?: unknown): Promise<{ status: number; ctype: string; body: any; buf: Buffer }> {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const ctype = res.headers.get('content-type') ?? '';
  const buf = Buffer.from(await res.arrayBuffer());
  let body: any = null;
  if (/json/.test(ctype)) { try { body = JSON.parse(buf.toString('utf8')); } catch { /* 保持 null */ } }
  return { status: res.status, ctype, body, buf };
}
const aiGen = (body: Record<string, unknown>) => hit('POST', '/report/ai-generate', body);
const genReport = (body: Record<string, unknown>) => hit('POST', '/report/generate', body);
/** 流式腿：取首批事件帧与 content-type，随后主动断开（不跑完整轮，省时间也让闸位归还） */
async function aiGenStreamRaw(body: Record<string, unknown>, readMs = 2_500) {
  const ac = new AbortController();
  const events: Array<{ event: string; data: any }> = [];
  let ctype = '';
  let status = 0;
  let headText = '';
  try {
    const res = await fetch(BASE + '/report/ai-generate-stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
    status = res.status;
    ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('event-stream') && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      // ⚠ 不能用 `Promise.race([reader.read(), sleep(600)])`：race 被超时判负后，那一帧稍后
      //   落地的 promise 结果就没人要了——实测 done/chunk 全被这种「迟到的帧」丢掉，
      //   门只看到前两条 stage，令牌登记不进名册，落盘文件成了自己的孤儿（G-04b 抓到的那条）。
      //   正确写法是老实 await 每一帧，用总超时兜底，读到 done/error 立刻收尾。
      let finished = false;
      const pump = (async () => {
        while (!finished) {
          const r = await reader.read();
          if (r.value) headText += dec.decode(r.value, { stream: true });
          if (r.done) { finished = true; break; }
          if (/event:\s*(done|error)/.test(headText)) { finished = true; void reader.cancel().catch(() => undefined); break; }
        }
      })();
      await Promise.race([pump, sleep(readMs)]);
    } else {
      headText = (await res.text().catch(() => '')).slice(0, 400);
    }
    ac.abort();
  } catch { /* 主动断开 */ }
  for (const block of headText.split('\n\n')) {
    const ev = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const dn = /^data:\s*(.+)$/m.exec(block)?.[1]?.trim();
    if (ev && dn) { try { events.push({ event: ev, data: JSON.parse(dn) }); } catch { /* 忽略半帧 */ } }
  }
  return { status, ctype, headText, events };
}
/** 启动会稿开流只为占闸（长驻 SSE 才量得出跨链路共用计数；离线导出跑完即放，占不出这个窗口） */
const KICKOFF_OUTLINE = Array.from({ length: 3 }, (_, i) => ({
  section: '项目风险', title: `占闸页 ${i + 1}`, bullets: ['占位要点'], dataKeys: ['risks'], layout: 'table' as const,
}));
async function kickoffOpen(toolId: string, projectId: string) {
  const ac = new AbortController();
  const res = await fetch(BASE + '/plans/kickoff-ppt-stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, toolId, outline: KICKOFF_OUTLINE }), signal: ac.signal,
  }).catch(() => null);
  return { status: res?.status ?? 0, ctype: res?.headers.get('content-type') ?? '', ac };
}
/**
 * 反向占闸用的「在途 AI 周报流」把手。
 * ⚠ 不能拿 `aiGenStreamRaw` 连开两条：它自己 await 到读完才返回，两条会**串行**跑完，
 * 第一条早已 abort、闸位早已归还，探测那一刻实际只有 1 路在途——G-16 因此假红。
 * 这里只发请求、**不读 body**，两条同时挂在闸上，直到调用方 abort。
 */
async function aiStreamHold(body: Record<string, unknown>) {
  const ac = new AbortController();
  const res = await fetch(BASE + '/report/ai-generate-stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
  }).catch(() => null);
  return { status: res?.status ?? 0, ctype: res?.headers.get('content-type') ?? '', ac };
}
async function download(token: string, filename: string) {
  const res = await fetch(BASE + '/report/ai-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, filename }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, disposition: res.headers.get('content-disposition') ?? '', ctype: res.headers.get('content-type') ?? '' };
}
const decodedName = (disposition: string) => {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  return m ? decodeURIComponent(m[1]) : '';
};
/** 等到闸位再次放行（用一次注定 400 的非法入参探测：400 表示已过闸层，429 表示仍在占） */
async function waitGateOpen(timeoutMs = 25_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await aiGen({ period: 'day', format: 'xlsx', projectId: '门内探针不存在的id', toolId: '门内探针工具' });
    if (r.status !== 429) return true;
    await sleep(300);
  }
  return false;
}

// =====================================================================
// W 组：隔离与夹具自证（判据 2）
// =====================================================================
if (!RUNTIME) {
  ok('W-01 隔离库由门内 `initSchema()` 建出（表齐备，门零读生产库）', false, '运行时面未加载，见 SKIP');
} else {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
  ok('W-01 隔离库由门内 `initSchema()` 建出（projects/tasks/plan_tasks/prd_docs/ai_usage/app_settings 齐备），门零读生产库',
    ['projects', 'tasks', 'plan_tasks', 'prd_docs', 'ai_usage', 'app_settings'].every((t) => tables.includes(t)) && existsSync(join(DATA_DIR, 'mtask.db')),
    { 表数: tables.length, DB: join(DATA_DIR, 'mtask.db') });
  ok('W-02 数据目录落在可写临时根（D:），与生产数据目录不同源（改判前这里直接把生产库 backup 过来）',
    resolve(DATA_DIR).startsWith(resolve(TMP_ROOT)) && !resolve(DATA_DIR).startsWith(resolve(PROD_DATA_DIR)),
    { DATA_DIR, 生产目录: PROD_DATA_DIR });
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((r) => r.name);
  ok('W-03 夹具表列由产品 schema 给出（`PRAGMA table_info` 实测 tasks 有 status/archived/updated_at，app_settings 有 key/value）',
    ['status', 'archived', 'updated_at'].every((c) => cols('tasks').includes(c)) && ['key', 'value'].every((c) => cols('app_settings').includes(c)),
    { tasks: cols('tasks').length, app_settings: cols('app_settings') });
  const now = db.prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>;
  ok('W-04 建库后库内**只有产品种子行**（initSchema 自带的收件箱等），无生产业务项目、零任务行——后续断言只引用门自己写的行',
    now.every((p) => SEEDED_PROJECTS.includes(p.id)) && !now.some((p) => p.name.includes(PROD_NAME_HINT)) && db.prepare('SELECT COUNT(*) n FROM tasks').get().n === 0,
    { 项目: now.map((p) => p.name), 种子: SEEDED_PROJECTS });
}

const UP = await waitUp();
if (!UP) {
  const raw = serverLog.join('');
  // 只留尾 600 字会把「Error: …」第一行截掉（实测踩过：留下的全是栈帧，读不出原因）。头尾都留。
  ok('X-00 隔离实例启动', false, raw.length <= 1200 ? raw : `${raw.slice(0, 600)} ……(中略 ${raw.length - 1200} 字)…… ${raw.slice(-600)}`);
}
else ok('X-00 隔离实例启动（夹具空库经 `MTask_DATA_DIR` 挂载，未碰生产实例 39877）', true);

let FIX_A = '';
let FIX_B = '';
let toolId = '';
if (UP && RUNTIME) {
  // 夹具经**产品自己的写入口**建出（反模式 7：允许侧必须写真数据，不能用不存在的 id 空跑）
  const pa = await hit('POST', '/projects', { name: FIX_A_NAME, description: '本门自造夹具，本期有任务活动' });
  const pb = await hit('POST', '/projects', { name: FIX_B_NAME, description: '本门自造夹具，本期零任务' });
  FIX_A = String(pa.body?.id ?? '');
  FIX_B = String(pb.body?.id ?? '');
  let createdTasks = 0;
  for (const t of TASK_TITLES) {
    const r = await hit('POST', '/tasks', { projectId: FIX_A, title: t, description: '门内夹具任务', priority: 'high', status: 'todo' });
    if (r.status === 201) createdTasks += 1;
  }
  const back = await hit('GET', `/tasks?projectId=${encodeURIComponent(FIX_A)}`);
  const listed = Array.isArray(back.body) ? back.body : [];
  ok('W-05 夹具经产品写入口建成且可读回：`POST /projects`×2 + `POST /tasks`×3，`GET /tasks?projectId=` 数得回同样条数',
    pa.status === 201 && pb.status === 201 && FIX_A.length > 0 && createdTasks === TASK_TITLES.length && listed.length === TASK_TITLES.length,
    { createdTasks, 读回条数: listed.length, pa: pa.status, pb: pb.status });

  // PRD/计划行按产品 schema 自造：kickoff 预检要 P1/P2/P3 齐备，否则占闸那条链跑不到模型等待期
  const insPrd = db.prepare('INSERT INTO prd_docs (id,project_id,filename,content_md,created_at,updated_at) VALUES (?,?,?,?,?,?)');
  const insReq = db.prepare(
    `INSERT INTO prd_requirements (id,project_id,prd_id,req_no,title,content,source_ref,priority,status,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,'','','normal',?,?,?,?)`,
  );
  const insPlan = db.prepare(
    `INSERT INTO plan_tasks (id,project_id,title,description,start_date,end_date,duration_days,progress,status,
       assignee,sort_order,created_at,updated_at,kind,complexity,req_ids,deps)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '')`,
  );
  const plans: Array<[string, string, string, string, string]> = [
    ['p1', '夹具阶段一：需求澄清', '2026-10-05', '2026-10-09', 'done'],
    ['p2', '夹具阶段二：接口联调受阻', '2026-10-12', '2026-10-20', 'blocked'],
    ['p3', '夹具里程碑：方案评审', '2026-10-21', '2026-10-22', 'todo'],
  ];
  for (const [pid] of [[FIX_A], [FIX_B]] as Array<[string]>) {
    insPrd.run(`${pid}-prd`, pid, 'PRD-门内夹具.md', `# ${pid === FIX_A ? FIX_A_NAME : FIX_B_NAME}\n\n范围：仅用于本门自证闸门与产物链路。\n`.repeat(10), NOW_ISO, NOW_ISO);
    for (let i = 0; i < 8; i++) insReq.run(`${pid}-r${i}`, pid, `${pid}-prd`, `R${i + 1}`, `夹具需求 ${i + 1}`, i < 4 ? 'done' : 'doing', i, NOW_ISO, NOW_ISO);
    plans.forEach(([id, title, s, e, status], i) =>
      insPlan.run(`${pid}-${id}`, pid, title, s, e, 5, status === 'done' ? 100 : 0, status, `夹具责任人${i + 1}`, i, NOW_ISO, NOW_ISO,
        id === 'p3' ? 'milestone' : 'normal', 3));
  }
  db.prepare('UPDATE projects SET workspace_path = ? WHERE id IN (?, ?)').run(ROOT, FIX_A, FIX_B);

  const g = RS!.gatherReportData('week', [FIX_A]);
  const gEmpty = RS!.gatherReportData('week', [FIX_B]);
  ok('W-06 取数口径问产品函数**返回值**：`gatherReportData(week,[夹具甲])` 的任务数=门写的条数、项目名=夹具名（不是生产库里的聚合值）',
    g.tasks.length === TASK_TITLES.length && g.projects.some((p: any) => p.name === FIX_A_NAME) && !JSON.stringify(g).includes(PROD_NAME_HINT),
    { 任务: g.tasks.length, 项目: g.projects.map((p: any) => p.name), 期间: `${g.periodLabel} ${g.startDate}~${g.endDate}` });
  ok('W-07 空夹具侧同样由返回值证明：夹具乙本期零任务零项目汇总（PDF「数据量→体积」单调对比的另一半，不靠猜结构）',
    gEmpty.tasks.length === 0 && gEmpty.projects.length === 0, { 任务: gEmpty.tasks.length, 项目数: gEmpty.projects.length });

  const tool = await hit('POST', '/aitools', {
    name: 't02142-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-insight', timeoutMs: 20_000,
  });
  toolId = String(tool.body?.id ?? '');
  ok('X-01 mock AI 工具已建（洞察走本机 mock，零真实配额）', tool.status === 201 && toolId.length > 0, { status: tool.status, toolId });
} else if (UP) {
  skipped('W-05~W-07 与 R/K/A/C/N 组', '运行时面未加载，产品函数不可直调（见上方 SKIP 原因）');
}

// 前端单源常量：**取运行值**而不是读它的文本
let GATE_BUSY_FRONT = '';
let streamEvents: ((path: string, data: unknown, onEvent: (n: string, p: unknown) => void, s?: AbortSignal) => Promise<void>) | null = null;
if (UP) {
  try {
    shimWebDocumentForNode(PORT);
    const sse = (await import('../web/src/api/sse.ts')) as Record<string, any>;
    GATE_BUSY_FRONT = String(sse.GATE_BUSY_MSG ?? '');
    streamEvents = sse.streamEvents;
    ok('X-02 前端模块可在 Node 侧直接调用（`GATE_BUSY_MSG` 取的是运行值，不是 sse.ts 的文本）',
      GATE_BUSY_FRONT.length > 0 && typeof streamEvents === 'function', { GATE_BUSY_FRONT });
  } catch (e) {
    skipped('F 组（streamEvents 行为腿）', `前端模块不可在 Node 侧加载：${e instanceof Error ? e.message : String(e)}`);
  }
}
/** 分类判据用的判定串：优先取前端运行值；取不到时如实回落到 HEAD 文本里那枚串并留痕 */
const BUSY_LIT = GATE_BUSY_FRONT || ((SSE_HEAD.match(/export const GATE_BUSY_MSG = '([^']+)'/) ?? [])[1] ?? '');

// =====================================================================
// R 组：闸本体行为（门进程直调中间件，假 req/res + 真事件；断言计数与状态码，不读源码）
// =====================================================================
function fakeRes() {
  const rec: { status: number; body: any } = { status: 0, body: null };
  const res: any = new EventEmitter();
  res.status = (c: number) => { rec.status = c; return res; };
  res.json = (b: any) => { rec.body = b; return res; };
  res.setHeader = () => res;
  res.send = () => res;
  return { res, rec };
}
const mk = (body: any) => ({ body, headers: {} } as any);
/** 所有被放行的假 res 都登记在这里，N-06 用它证明「释放干净后不留计数」 */
const rHolders: Array<any> = [];
function drive(mw: any) {
  const f = fakeRes();
  let nextCalled = false;
  mw(mk({}), f.res, () => { nextCalled = true; });
  if (nextCalled) rHolders.push(f.res);
  return { ...f, nextCalled };
}
if (!RUNTIME || !GATE) {
  ok('R-00 闸本体可被门进程直调', false, '运行时面未加载，见 SKIP');
} else {
  const { exportGate, gateSnapshot, REPORT_GATE, EXPORT_GATE_LIMIT } = GATE;
  ok('R-00 闸本体可被门进程直调，闸名与默认上限由运行时给出（不是抄在门里的字面量）',
    typeof exportGate === 'function' && EXPORT_GATE_LIMIT >= 1 && REPORT_GATE.length > 0 && typeof gateSnapshot === 'function',
    { REPORT_GATE, EXPORT_GATE_LIMIT });

  const mw = exportGate(REPORT_GATE);
  const a = drive(mw);
  const b = drive(mw);
  const c = drive(mw);
  ok(`R-01 前 ${EXPORT_GATE_LIMIT} 路进闸（next 被调、计数到达上限），第 ${EXPORT_GATE_LIMIT + 1} 路 next 未被调`,
    a.nextCalled && b.nextCalled && !c.nextCalled && (gateSnapshot()[REPORT_GATE] ?? 0) === EXPORT_GATE_LIMIT,
    { snap: gateSnapshot(), a: a.nextCalled, b: b.nextCalled, c: c.nextCalled });
  ok('R-02 被拒那路是结构化 429 + 中文文案（分类判据认的是前端那枚常量的运行值）',
    c.rec.status === 429 && judgeBusyBody(c.rec.body, BUSY_LIT), c.rec);
  const extraRejects = Array.from({ length: 5 }, () => drive(mw));
  ok('R-03 拒绝不占槽位：连拒 5 路后计数仍是上限（若拒的一路也 +1，闸会自己把自己永久锁死）',
    extraRejects.every((x) => !x.nextCalled && x.rec.status === 429) && (gateSnapshot()[REPORT_GATE] ?? 0) === EXPORT_GATE_LIMIT,
    { snap: gateSnapshot() });
  a.res.emit('finish');
  const d = drive(mw);
  ok('R-04 `finish` 归还一个槽位（计数回落到上限-1），下一路随即被放行',
    d.nextCalled && (gateSnapshot()[REPORT_GATE] ?? 0) === EXPORT_GATE_LIMIT, { snap: gateSnapshot(), d: d.nextCalled });
  const e = drive(mw);
  ok('R-05 闸满时再来的那一路仍被拒（放行与否只看计数，不靠「谁先谁后」侥幸）',
    e.nextCalled === false && e.rec.status === 429, { snap: gateSnapshot() });
  b.res.emit('close');
  b.res.emit('finish'); // 同一响应 close 与 finish 都会来：once + released 标志必须只减一次
  ok('R-06 客户端断开（`close`）同样归还，且 `close` 后再来 `finish` 不会重复减（不会把别人槽位也吃掉）',
    (gateSnapshot()[REPORT_GATE] ?? 0) === EXPORT_GATE_LIMIT - 1, { snap: gateSnapshot() });
  d.res.emit('finish');
  d.res.emit('close');
  ok('R-07 全部持有者释放后该闸计数从快照里彻底消失（不留 0 值幽灵键，也不留正数占用）',
    gateSnapshot()[REPORT_GATE] === undefined, { snap: gateSnapshot() });

  const other = exportGate('t02142-另一只闸');
  const o1 = drive(other); const o2 = drive(other); const o3 = drive(other);
  ok('R-08 按闸名各自计数（不同名互不顶掉——「挂载是挂了、闸名写成另一只」正是文本正则看不见的那类事故）',
    o1.nextCalled && o2.nextCalled && !o3.nextCalled && (gateSnapshot()['t02142-另一只闸'] ?? 0) === 2 && gateSnapshot()[REPORT_GATE] === undefined,
    { snap: gateSnapshot() });

  const limitKey = `exportGateLimit.${REPORT_GATE}`;
  SETTINGS!.setSetting(limitKey, '1');
  const one = exportGate(REPORT_GATE);
  const p1 = drive(one); const p2 = drive(one);
  ok('R-09 `app_settings.exportGateLimit.<闸名>` 即时生效（设 1 → 第二路被拒；每请求读一次，无需重启）',
    p1.nextCalled && !p2.nextCalled && p2.rec.status === 429, { snap: gateSnapshot(), limit: SETTINGS!.getSetting(limitKey) });
  p1.res.emit('finish');
  SETTINGS!.setSetting(limitKey, 'abc');
  const q1 = drive(one); const q2 = drive(one); const q3 = drive(one);
  ok('R-10 非法上限值（非整数）回退默认而不是放行无限：仍严格上限 ' + EXPORT_GATE_LIMIT + ' 路',
    q1.nextCalled && q2.nextCalled && !q3.nextCalled, { snap: gateSnapshot(), raw: 'abc' });
  q1.res.emit('finish'); q2.res.emit('finish');
  SETTINGS!.setSetting(limitKey, '0');
  const z1 = drive(one);
  ok('R-11 上限 0 也按非法回退（0 会让闸永久拒绝，产品口径是不接受 0）', z1.nextCalled === true, { snap: gateSnapshot(), raw: '0' });
  z1.res.emit('finish');
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(limitKey);
  const after = drive(one);
  ok('R-12 删键回落默认（本门写的调限键收口时删净；`getSetting` 实测为 null）',
    SETTINGS!.getSetting(limitKey) === null && after.nextCalled === true, { snap: gateSnapshot() });
  after.res.emit('finish');

  // 这两路也被放行了（计数已 +1）：必须进 rHolders 名册，否则 N-06 的「释放干净后快照为空」
  // 会因两个没登记的名字恒红——名册注释说的是「所有被放行的假 res」，inline 驱动也不例外
  const neg = fakeRes(); let syncNext = false;
  exportGate('t02142-同步形')(mk({}), neg.res, () => { syncNext = true; });
  rHolders.push(neg.res);
  const def = fakeRes(); let deferNextImmediate = false;
  exportGate('t02142-让渡形', 2, { defer: true })(mk({}), def.res, () => { deferNextImmediate = true; });
  rHolders.push(def.res);
  const observed = deferNextImmediate;
  await sleep(30);
  ok('R-13 `defer` 的语义在时序上可观测：非 defer 同步调 next，defer 当拍未调、下一拍才调（同步重活不让拍会把并发数骗成 1，闸形同虚设）',
    syncNext === true && observed === false && deferNextImmediate === true, { syncNext, observed, deferNextImmediate });
  evidence(`R 组闸快照（收口前）：${JSON.stringify(gateSnapshot())}`);
}

// =====================================================================
// G 组：真链路上量行为（AI 周报两条端点是否真的计入同一只闸）
// =====================================================================
const aiBody = (format: string) => ({ period: 'week', format, projectId: FIX_A, toolId });
/** 只登记「本轮没被就地下载过」的令牌，收口时统一验下载（登记名册见文件头 `tokens`/`orphansOf`） */
const keep = (r: { status: number; body?: any }) => {
  if (typeof r.body?.token === 'string' && typeof r.body?.filename === 'string') tokens.push({ token: r.body.token, filename: r.body.filename });
};
let warm: Awaited<ReturnType<typeof aiGen>> | null = null;
let batch: Array<Awaited<ReturnType<typeof aiGen>>> = [];
let streams: Array<Awaited<ReturnType<typeof aiGenStreamRaw>>> = [];
let mix: any[] = [];
let duringKick = 0;
let kickProbeRow: { path: string; status: number; ctype: string; body: any } | null = null;
let heavyProbe: Array<{ path: string; status: number; ctype: string; body: any }> = [];
let lightProbe: Array<{ path: string; status: number; ctype: string; body: any }> = [];
let getProbe: { path: string; status: number } | null = null;
let heavyPaths: string[] = [];
let lightPaths: string[] = [];
let unsaturatedStream: { rejected: boolean; message: string; events: string[] } | null = null;
let saturatedStream: { rejected: boolean; message: string } | null = null;

if (UP && RUNTIME && FIX_A && toolId) {
  mockDelayMs = 0;
  warm = await aiGen(aiBody('xlsx'));
  ok('G-01 单发 AI 周报（非流式）在挂闸后仍走通（200 + 合法 UUID 令牌 + 含本轮锚点的洞察正文）',
    judgeAccepted(warm) && RS!.isReportToken(String(warm.body.token)) && String(warm.body.insight).includes(INSIGHT_MARK),
    { status: warm.status, filename: warm.body?.filename, err: warm.body?.error });
  keep(warm);

  mockDelayMs = AI_DELAY_MS;
  batch = await Promise.all([aiGen(aiBody('xlsx')), aiGen(aiBody('docx')), aiGen(aiBody('pdf')), aiGen(aiBody('pptx'))]);
  mockDelayMs = 0;
  const accepted = batch.filter((r) => r.status !== 429);
  const rejected = batch.filter((r) => r.status === 429);
  ok('G-02 4 路并发 AI 周报（非流式）→ 恰好 2 接受 + 2 拒：新挂的两条端点真的计入同一只闸（全过＝闸没生效）',
    accepted.length === 2 && rejected.length === 2, batch.map((r) => r.status));
  ok('G-03 被拒的是结构化中文 429（分类判据认的是运行值常量，不是服务端文案的字面抄写）',
    rejected.length > 0 && rejected.every((r) => judgeBusyBody(r.body, BUSY_LIT)), rejected.map((r) => r.body));
  accepted.forEach(keep);
  await sleep(2_500);

  mockDelayMs = AI_DELAY_MS;
  // 读到底为止（AI 回完还要构建文件，2.5s 只够看到 stage）：done 没读到就 abort，
  // 令牌登记不进名册，落盘文件就成了本门自造的孤儿（实测 2 个，K-12 因此假红）
  const STREAM_READ_MS = 25_000; // 读到 done/error 即退出循环，这只是上限：构建慢时 8s 内确实取不到 done（实测）
  streams = await Promise.all([aiGenStreamRaw(aiBody('xlsx'), STREAM_READ_MS), aiGenStreamRaw(aiBody('docx'), STREAM_READ_MS), aiGenStreamRaw(aiBody('pdf'), STREAM_READ_MS)]);
  const sse = streams.filter((s) => s.ctype.includes('event-stream'));
  const rej = streams.filter((s) => s.status === 429);
  ok('G-04 3 路并发 AI 周报（流式）→ 2 条 event-stream + 1 条 429（SSE 与离线导出共用一只闸）',
    sse.length === 2 && rej.length === 1, streams.map((s) => `${s.status}:${s.ctype.split(';')[0]}`));
  ok('G-05 流式端点被拒时是 JSON 429 而非半开事件流（前端 streamEvents 非 2xx 分支因此拿得到可读文案）',
    rej.length > 0 && rej.every((s) => /application\/json/.test(s.ctype) && s.headText.includes(BUSY_LIT)),
    rej.map((s) => ({ ctype: s.ctype.split(';')[0], body: s.headText.slice(0, 80) })));
  ok('G-06 被接受的两条流确实开始了（解析出的事件里有 stage/chunk，不是空转到超时）',
    sse.length === 2 && sse.every((s) => s.events.some((ev) => ev.event === 'stage' || ev.event === 'chunk')),
    sse.map((s) => s.events.map((ev) => ev.event).join(',')));
  // done 事件里的令牌必须登记：不登记就变孤儿，K-12/G-13 的「零残留」也假了
  streams.forEach(keepStream);
  ok('G-04b 被接受的两条流都读到了 done 且令牌进了名册（读不到 done＝门自己把产物读成孤儿，这条让它在红处显形而不是静默漏）',
    sse.length === 2 && sse.every((s) => s.events.some((ev) => ev.event === 'done' && typeof ev.data?.token === 'string'))
      && orphansOf().length === 0,
    { 事件: sse.map((s) => s.events.map((ev) => ev.event).join(',')), 末帧: sse.map((s) => s.headText.slice(-150)), 名册: tokens.length, 孤儿: orphansOf() });
  await sleep(2_500);

  mockDelayMs = AI_DELAY_MS;
  mix = await Promise.all([aiGen(aiBody('pptx')), genReport({ period: 'week', format: 'xlsx', projectId: FIX_A }), aiGenStreamRaw(aiBody('docx'), 25_000)]);
  mockDelayMs = 0;
  const mix429 = mix.filter((r: any) => r.status === 429).length;
  const mixPass = mix.filter((r: any) => r.status === 200).length;
  ok('G-07 混跑三条链路共用一闸：AI 非流式 + 离线导出 + AI 流式 → 确有请求被拒且放行数不超上限',
    mixPass >= 1 && mixPass <= 2 && mix429 >= 1, mix.map((r: any) => r.status));
  mix.forEach((r: any) => keep(r));
  // 混跑里那条是流式响应：令牌在 done 事件里，不在 body 上，必须走 keepStream 才登记得到
  mix.forEach((r: any) => { if (Array.isArray(r.events)) keepStream(r); });
  await sleep(2_500);
  orphanMark('G组并发+混跑后');

  // 跨链路占闸（本单点名的实测项）：启动会稿占满时 AI 周报必须被同一计数挡下
  mockDelayMs = AI_DELAY_MS;
  const k1 = await kickoffOpen(toolId, FIX_A);
  const k2 = await kickoffOpen(toolId, FIX_A);
  await sleep(500);
  const during = await aiGen(aiBody('xlsx'));
  duringKick = during.status;
  ok('G-14 两路启动会稿在途时 AI 周报被**同一计数**挡下 429（FR-5 共用闸的跨链路实测；离线导出跑完即放，占不出这个窗口）',
    k1.status === 200 && k2.status === 200 && during.status === 429 && judgeBusyBody(during.body, BUSY_LIT),
    { kickoff: [k1.status, k2.status], aiReport: during.status, msg: during.body?.error });
  k1.ac.abort();
  k2.ac.abort();
  const opened = await waitGateOpen();
  mockDelayMs = 0;
  const after = await Promise.all([aiGen(aiBody('xlsx')), aiGen(aiBody('docx'))]);
  ok('G-15 启动会稿客户端断开后闸位归还（无幽灵占用：断两路后 2 路 AI 周报恢复全接受）',
    opened && after.every((r) => r.status !== 429), after.map((r) => r.status));
  after.forEach(keep);
  await sleep(2_000);

  // 反向占闸：AI 周报侧占满时启动会稿必须被同一只闸挡下（共用是双向的）
  // ⚠ 这里必须用 `aiStreamHold`（发请求不读 body）而不是 `aiGenStreamRaw`：后者 await 到读完
  //   才返回，两条会串行跑完，探测那一刻闸上一个都没占（实测假红：kickoff 200）。
  mockDelayMs = HOLD_MS;
  const [s1, s2] = await Promise.all([aiStreamHold(aiBody('xlsx')), aiStreamHold(aiBody('docx'))]);
  await sleep(400);
  kickProbeRow = { path: '/plans/kickoff-ppt-stream', ...(await hit('POST', '/plans/kickoff-ppt-stream', { projectId: FIX_A, toolId, outline: KICKOFF_OUTLINE })) };
  ok('G-16 反向占闸：两路 AI 周报流在途时启动会稿被拒 429（共用计数不是只挂在 kickoff 那一侧的装饰）',
    s1.status === 200 && s2.status === 200 && kickProbeRow.status === 429 && judgeBusyBody(kickProbeRow.body, BUSY_LIT),
    { streams: [s1.status, s2.status], kickoff: kickProbeRow.status, ctype: kickProbeRow.ctype.split(';')[0] });
  s1.ac.abort();
  s2.ac.abort();
  mockDelayMs = 0;
  await waitGateOpen();
  await sleep(800);
  orphanMark('两路 AI 流真在途+abort 后');

  // app_settings 调限即时生效与删键回落（走产品写入口，不再另开库句柄写副本）
  SETTINGS!.setSetting(`exportGateLimit.${GATE!.REPORT_GATE}`, '1');
  await sleep(200);
  mockDelayMs = AI_DELAY_MS;
  const pair = await Promise.all([aiGen(aiBody('xlsx')), aiGen(aiBody('pdf'))]);
  mockDelayMs = 0;
  ok('G-08 上限即时生效（产品 `setSetting` 写 report-generate=1 → 2 路只放 1 路；AI 周报侧同样吃这个可调值）',
    pair.filter((r) => r.status !== 429).length === 1 && pair.filter((r) => r.status === 429).length === 1, pair.map((r) => r.status));
  pair.forEach(keep);
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(`exportGateLimit.${GATE!.REPORT_GATE}`);
  await waitGateOpen();
  mockDelayMs = AI_DELAY_MS;
  const back = await Promise.all([aiGen(aiBody('xlsx')), aiGen(aiBody('docx'))]);
  mockDelayMs = 0;
  ok('G-09 删键回落默认 2（两路全接受）', back.every((r) => r.status !== 429), back.map((r) => r.status));
  back.forEach(keep);
  await sleep(2_000);

  // 挂闸没吞掉入参校验
  const badPeriod = await aiGen({ period: 'hour', format: 'xlsx', projectId: FIX_A, toolId });
  const badFormat = await aiGen({ period: 'week', format: 'rtf', projectId: FIX_A, toolId });
  const badTool = await aiGen({ period: 'week', format: 'xlsx', projectId: FIX_A });
  ok('G-10 挂闸没吞掉入参校验：period/format 非法与缺 toolId 仍各自 400（闸在门外，不改变错误语义）',
    badPeriod.status === 400 && badFormat.status === 400 && badTool.status === 400,
    { badPeriod: badPeriod.status, badFormat: badFormat.status, badTool: badTool.status });
  const ghost = await aiGen({ period: 'week', format: 'xlsx', projectId: '门内不存在的项目id', toolId });
  ok('G-11 范围校验点名不存在的 id（400 且文案含该 id，不静默丢范围）',
    ghost.status === 400 && String(ghost.body?.error ?? '').includes('门内不存在的项目id'), { status: ghost.status, err: ghost.body?.error });

  // 矩阵：活路由表当分母 + 饱和窗口逐条探测
  const livePosts = ROUTES.filter((r) => r.startsWith('POST /report/')).map((r) => r.split(' ')[1]);
  const kickEntry = ROUTES.includes('POST /plans/kickoff-ppt-stream');
  heavyPaths = livePosts.filter((p) => /generate|export/.test(p));
  lightPaths = livePosts.filter((p) => !/generate|export/.test(p));
  ok('M-01 分母取自**运行中的路由表**（`api.stack` 枚举出的 POST /report/* 与 kickoff 流入口），不是源码正则也不是手点名',
    heavyPaths.length >= 3 && lightPaths.length >= 1 && kickEntry
      && heavyPaths.includes('/report/ai-generate') && heavyPaths.includes('/report/ai-generate-stream') && heavyPaths.includes('/report/generate'),
    { livePosts, heavyPaths, lightPaths, kickEntry });

  mockDelayMs = HOLD_MS;
  const h1 = await kickoffOpen(toolId, FIX_A);
  const h2 = await kickoffOpen(toolId, FIX_A);
  await sleep(400);
  for (const p of heavyPaths) {
    const body = p === '/report/generate' ? { period: 'week', format: 'xlsx', projectId: FIX_A } : aiBody('xlsx');
    heavyProbe.push({ path: p, ...(await hit('POST', p, body)) });
  }
  const kickWhileHeld = { path: '/plans/kickoff-ppt-stream', ...(await hit('POST', '/plans/kickoff-ppt-stream', { projectId: FIX_A, toolId, outline: KICKOFF_OUTLINE })) };
  for (const p of lightPaths) {
    lightProbe.push({ path: p, ...(await hit('POST', p, p === '/report/ai-download' ? { token: 'not-a-uuid', filename: 'x.xlsx' } : { filename: 1, data: 2 })) });
  }
  getProbe = { path: '/report/templates', status: (await hit('GET', '/report/templates')).status };
  h1.ac.abort();
  h2.ac.abort();
  mockDelayMs = 0;
  ok('M-02 占闸窗口内：报表族每条重活路由（含 kickoff 流入口）都被同一计数拒成 429 + 闸文案——齐全性由活路由表逐条实测',
    h1.status === 200 && h2.status === 200 && heavyProbe.length >= 3 && heavyProbe.every((r) => judgeRejected(r, BUSY_LIT))
      && kickWhileHeld.status === 429 && judgeBusyBody(kickWhileHeld.body, BUSY_LIT),
    { holders: [h1.status, h2.status], heavy: heavyProbe.map((r) => `${r.path}=${r.status}`), kickoff: `${kickWhileHeld.path}=${kickWhileHeld.status}` });
  ok('M-03 轻活不被牵连：下载与模板 POST 在饱和窗口里走到各自的校验/响应（非 429），GET 模板仍 200（拒的是闸，不是进程被打挂）',
    lightProbe.length >= 1 && lightProbe.every((r) => r.status !== 429) && getProbe?.status === 200,
    { light: lightProbe.map((r) => `${r.path}=${r.status}`), get: `${getProbe?.path}=${getProbe?.status}` });

  await waitGateOpen();
  await sleep(400);
  const reopen = await Promise.all([aiGen(aiBody('xlsx')), genReport({ period: 'week', format: 'docx', projectId: FIX_A })]);
  ok('M-04 放闸后同一批重活路由重新可放行（429 来自占闸而非该路由被永久封死——未饱和时的反证就长在这条上）',
    reopen.every((r) => r.status !== 429), reopen.map((r) => `${r.status}`));
  reopen.forEach(keep);
  orphanMark('M组矩阵后');

  // 前端消费侧：真调 streamEvents
  if (streamEvents) {
    const collect = async () => {
      const evs: string[] = [];
      try {
        await streamEvents!('/report/ai-generate-stream', aiBody('pptx'), (n, p) => {
          evs.push(n);
          if (n === 'done') {
            const tok = String((p as any)?.token ?? '');
            const fn = String((p as any)?.filename ?? '');
            if (tok && fn) tokens.push({ token: tok, filename: fn });
          }
        });
        return { rejected: false, message: '', events: evs };
      } catch (e) {
        return { rejected: true, message: e instanceof Error ? e.message : String(e), events: evs };
      }
    };
    mockDelayMs = 0;
    unsaturatedStream = await collect();
    ok('F-01 未饱和：真调前端 `streamEvents` 能跑完整条流（收到 stage/chunk/done，无 reject）——本条同时是 F-02 的反证基线',
      unsaturatedStream.rejected === false && /stage|chunk/.test(unsaturatedStream.events.join(',')) && unsaturatedStream.events.includes('done'),
      { events: unsaturatedStream.events.join(','), message: unsaturatedStream.message });

    mockDelayMs = HOLD_MS;
    const f1 = await kickoffOpen(toolId, FIX_A);
    const f2 = await kickoffOpen(toolId, FIX_A);
    await sleep(400);
    saturatedStream = await collect();
    f1.ac.abort();
    f2.ac.abort();
    mockDelayMs = 0;
    ok('F-02 饱和时前端 `streamEvents` 直接 reject，且抛出的 message **就是**闸文案（改判前 S-06 判的是 sse.ts 的文本）',
      saturatedStream.rejected === true && saturatedStream.message.includes(BUSY_LIT), saturatedStream);
    ok('F-03 两端同源的**值级**证明：服务端全文比前端判定串长（判定靠包含而非全等，措辞各自可动）',
      BUSY_LIT.length > 0 && !!saturatedStream && saturatedStream.message !== BUSY_LIT && saturatedStream.message.includes(BUSY_LIT),
      { 前端串: BUSY_LIT, 服务端串: saturatedStream?.message });
    const queuedOf = (msg: string) => msg.includes(BUSY_LIT);
    ok('F-04 「被闸拒」与「生成失败」在值上分得开：同一分类规则对闸文案为真、对缺模型/校验类错误为假（面板排队态分支因此不互串）',
      !!saturatedStream && queuedOf(saturatedStream.message) === true && queuedOf('请选择 AI 模型') === false && queuedOf('项目不存在或已删除：门内不存在的项目id') === false,
      { 闸文案: saturatedStream?.message });
    await waitGateOpen();
  } else {
    skipped('F-01~F-04', '前端 streamEvents 未能取到（见 X-02 的 SKIP）');
  }
} else if (UP) {
  skipped('G/M/F 组', '夹具项目或 mock 工具未能建立（W-05/X-01 已记 FAIL），并发腿没有可打的对象');
}

// =====================================================================
// K 组：令牌与文件名单源（状态码 + 响应头 + 目录实况）
// =====================================================================
let dlGoodName = '';
let dlGood: Awaited<ReturnType<typeof download>> | null = null;
let dlTwice: Awaited<ReturnType<typeof download>> | null = null;
let dlFallback: Awaited<ReturnType<typeof download>> | null = null;
let washedName = '';
if (UP && RUNTIME && FIX_A && toolId) {
  const bad1 = await download('..%2f..%2fmtask.db', 'x.xlsx');
  const bad2 = await download('not-a-uuid', 'x.xlsx');
  const bad3 = await download('', 'x.xlsx');
  ok('K-01 非法 token 一律 400（形状不符即拒，不给读任意路径的机会），响应是 JSON 而非文件',
    bad1.status === 400 && bad2.status === 400 && bad3.status === 400 && /json/.test(bad2.ctype),
    { bad1: bad1.status, bad2: bad2.status, bad3: bad3.status });
  const ghost = await download('deadbeef-0000-4000-8000-000000002142', 'x.xlsx');
  ok('K-02 形状合法但未落盘的令牌 404（与 400 分得开：门没有把所有意外揉成一个码）',
    ghost.status === 404 && /json/.test(ghost.ctype), { status: ghost.status, err: (JSON.parse(ghost.buf.toString('utf8') || '{}'))?.error });

  const g1 = await aiGen(aiBody('xlsx'));
  dlGoodName = String(g1.body?.filename ?? '');
  dlGood = await download(String(g1.body?.token), dlGoodName);
  ok('K-03 生成侧文件名必然通过下载侧白名单（同一把钥匙两端口径同源；Content-Disposition 原样回显，不回退兜名）',
    NAMES!.DOWNLOAD_NAME_RE.test(dlGoodName) && dlGood.status === 200 && decodedName(dlGood.disposition) === dlGoodName && magicOf(dlGood.buf, dlGoodName),
    { 生成名: dlGoodName, 回显名: decodedName(dlGood.disposition), 兜名: 'MTask-ai-report.xlsx' });
  dlTwice = await download(String(g1.body?.token), dlGoodName);
  ok('K-04 下载即删：同一令牌第二次下载 404（临时文件不会留在目录里等人再取）', dlTwice.status === 404, { status: dlTwice.status });

  const g2 = await aiGen(aiBody('pptx'));
  const hostileName = 'MTask-AI-周报（v2）&final.pptx';
  dlFallback = await download(String(g2.body?.token), hostileName);
  ok('K-05 非白名单名的回退是**可观测**的：Content-Disposition 明确给出兜名（改判前这条只在源码注释里，实际后果是用户拿到兜名而无人报错）',
    NAMES!.DOWNLOAD_NAME_RE.test(hostileName) === false && dlFallback.status === 200 && decodedName(dlFallback.disposition) === 'MTask-ai-report.xlsx',
    { 请求名: hostileName, 回显名: decodedName(dlFallback.disposition) });
  ok('K-06 兜名那一路的字节仍是真产物（pptx 能解包出正文 XML——回退只动名字，没把内容换掉）',
    magicOf(dlFallback.buf, 'x.pptx') && (await ooxmlTextOf(dlFallback.buf)).includes(INSIGHT_MARK), { bytes: dlFallback.buf.byteLength });

  const names: Array<{ format: string; filename: string; regex: boolean }> = [];
  for (const f of ['xlsx', 'docx', 'pdf', 'pptx']) {
    const r = await aiGen(aiBody(f));
    const fn = String(r.body?.filename ?? '');
    names.push({ format: f, filename: fn, regex: NAMES!.DOWNLOAD_NAME_RE.test(fn) });
    keep(r);
  }
  ok('K-07 四种格式的生成名逐个过白名单且扩展名与请求格式一致（覆盖面由格式清单做分母，不是只测一种再宣称同理）',
    names.length === 4 && names.every((n) => n.regex && n.filename.endsWith(`.${n.format}`)), names);

  const planted = Buffer.from('PK\u0003\u0004 门内自检字节');
  const tk = RS!.saveReportBuffer(planted);
  const existsAfterSave = existsSync(join(TMP_DIR, tk));
  const readBack = RS!.readAndDeleteReport(tk);
  ok('K-08 落盘单源链路自洽：`saveReportBuffer` 回的是过 `isReportToken` 的令牌、文件真在 tmp 下、`readAndDeleteReport` 取回同一字节并删净（二次读 undefined）',
    RS!.isReportToken(tk) === true && existsAfterSave && readBack?.equals(planted) === true && !existsSync(join(TMP_DIR, tk))
      && RS!.readAndDeleteReport(tk) === undefined, { existsAfterSave, got: readBack?.byteLength });
  ok('K-09 `discardReport` 对在场令牌真删、对不在场返回 false（不静默成功）',
    (() => {
      const t1 = RS!.saveReportBuffer(Buffer.from('x'));
      const r1 = RS!.discardReport(t1);
      const r2 = RS!.discardReport('deadbeef-0000-4000-8000-000000000001');
      return r1 === true && !existsSync(join(TMP_DIR, t1)) && r2 === false;
    })(), undefined);
  {
    const stale = RS!.saveReportBuffer(Buffer.from('stale'));
    const fresh = RS!.saveReportBuffer(Buffer.from('fresh'));
    const other = join(TMP_DIR, 'keep-me-not-a-token.txt');
    writeFileSync(other, 'keep');
    // 过期 = mtime 在**过去**且距今 > TTL（写反成未来时 sweep 判「未过期」，K-10 会假红）
    const longAgo = new Date(Date.now() - (RS!.REPORT_TMP_TTL_MS + 60 * 60 * 1000));
    utimesSync(join(TMP_DIR, stale), longAgo, longAgo);
    const removed = RS!.sweepReportTmp(RS!.REPORT_TMP_TTL_MS, Date.now());
    const goneStale = !existsSync(join(TMP_DIR, stale));
    const keptFresh = existsSync(join(TMP_DIR, fresh));
    const keptOther = existsSync(other);
    RS!.readAndDeleteReport(fresh);
    rmSync(other, { force: true });
    ok('K-10 `sweepReportTmp` 的回收口径是「过期 + UUID 名」两条同时成立：本轮删 1 留 2（判据认的是目录里的文件，不是「跑过了就该是空」）',
      removed === 1 && goneStale && keptFresh && keptOther, { removed, goneStale, keptFresh, keptOther });
  }
  washedName = NAMES!.downloadSafeName('项目/周报（v2）&final', 'fb');
  ok('K-11 生成侧洗名后必然过下载侧白名单（两个口径的同源性打在函数返回值上，不是注释里的声明）',
    washedName.length > 0 && NAMES!.DOWNLOAD_NAME_RE.test(`${washedName}.xlsx`) === true, { 洗后: washedName });
  // 判据认的是**孤儿**（不在本门待下载名册上的令牌），不是「目录里有没有令牌」：
  // 名册上的令牌本来就要留到收口才下载，中途数它们必假红（实测 K-12 一度数到 10+ 个在册文件）
  ok('K-12 门自检后 tmp 目录没有孤儿令牌（本门造成的每个令牌都在名册上，等收口下载；不留无名册的残留）',
    orphansOf().length === 0, { 孤儿: orphansOf(), 名册: tokens.length, 在册文件: tokens.filter((t) => existsSync(join(TMP_DIR, t.token))).length, 目录数: readdirSync(TMP_DIR).length });
}

// =====================================================================
// A 组：产物字节解包（AI 洞察与夹具数据是否真被搬进文件）
// =====================================================================
const art: Record<string, { filename: string; buf: Buffer; text: string; status: number }> = {};
if (UP && RUNTIME && FIX_A && toolId) {
  for (const f of ['xlsx', 'docx', 'pptx', 'pdf'] as const) {
    const gen = await aiGen(aiBody(f));
    const dl = await download(String(gen.body?.token), String(gen.body?.filename));
    art[f] = { filename: String(gen.body?.filename), buf: dl.buf, status: dl.status, text: dl.status === 200 && f !== 'pdf' ? await ooxmlTextOf(dl.buf) : '' };
  }
  const markIn = (f: string) => art[f] ? art[f].text.includes(INSIGHT_MARK) === true : false;
  ok('A-01 xlsx 解包正文含本轮洞察锚点（洞察字符串真被搬进 AI 洞察页，不是只活在 JSON 响应里）',
    art.xlsx.status === 200 && art.xlsx.buf.byteLength > 1_000 && markIn('xlsx'), { bytes: art.xlsx?.buf.byteLength });
  ok('A-02 docx 解包正文含同一洞察锚点', art.docx.status === 200 && art.docx.buf.byteLength > 1_000 && markIn('docx'), { bytes: art.docx?.buf.byteLength });
  ok('A-03 pptx 解包正文含同一洞察锚点', art.pptx.status === 200 && art.pptx.buf.byteLength > 1_000 && markIn('pptx'), { bytes: art.pptx?.buf.byteLength });
  ok('A-04 三种 OOXML 形态都含夹具项目名，且 xlsx/docx 含门写的任务标题（门自己写进去的行才会出现在产物里）',
    ['xlsx', 'docx', 'pptx'].every((f) => art[f].text.includes(FIX_A_NAME)) && art.xlsx.text.includes(TASK_TITLES[0]) && art.docx.text.includes(TASK_TITLES[1]),
    { 缺名: ['xlsx', 'docx', 'pptx'].filter((f) => !art[f].text.includes(FIX_A_NAME)) });
  ok('A-05 三种形态正文里都**没有**生产项目名片段（改判前这些字节来自复制生产库，产物必然带着 mtask五期）',
    ['xlsx', 'docx', 'pptx'].every((f) => !art[f].text.includes(PROD_NAME_HINT)), undefined);
  const pdfPop = pdfStructOf(art.pdf.buf);
  const pdfEmptyBuf = (await genReport({ period: 'week', format: 'pdf', projectId: FIX_B })).buf;
  const pdfEmp = pdfStructOf(pdfEmptyBuf);
  // PDF 用子集化内嵌字体（simhei），文本无法按 UTF-8 检索——该侧只断结构与「数据量→体积」单调性，缺口如实写在标签里
  ok('A-06 PDF 侧断结构与数据单调性：%PDF 头 + 页对象 ≥1 + %%EOF 尾，且本期有任务的产物体积 > 空期产物（PDF 文本为子集字体不可检索，此缺口如实记录）',
    pdfPop.header && pdfPop.pages >= 1 && pdfPop.eof && pdfEmp.header && pdfEmp.pages >= 1 && pdfPop.bytes > pdfEmp.bytes,
    { 有任务: pdfPop, 空期: pdfEmp });
  ok('A-07 四种格式的产出魔数与扩展名相符且体积非琐碎（比对内容魔数，不做两次构建的字节相等——反模式 2）',
    (['xlsx', 'docx', 'pptx', 'pdf'] as const).every((f) => art[f].status === 200 && art[f].buf.byteLength > 1_000 && magicOf(art[f].buf, art[f].filename)),
    (['xlsx', 'docx', 'pptx', 'pdf'] as const).map((f) => `${f}:${art[f]?.buf.byteLength}`));
}

// =====================================================================
// 收口：批次令牌全下载、tmp 归零、异常与实例健康
// =====================================================================
if (UP) {
  const dl = await Promise.all(tokens.map(async (t) => {
    const r = await download(t.token, t.filename);
    return { status: r.status, bytes: r.buf.byteLength, magic: magicOf(r.buf, t.filename), ext: t.filename.split('.').pop(), name: decodedName(r.disposition) };
  }));
  ok('G-12 批次里每个放行请求的令牌都能下载出真实产出（魔数与扩展名相符，不是 200 空壳）',
    dl.length >= 8 && dl.every((d) => d.status === 200 && d.bytes > 1_000 && d.magic), { 数: dl.length, 异常: dl.filter((d) => !(d.status === 200 && d.bytes > 1_000 && d.magic)).slice(0, 3) });
  const rosterGone = tokens.every((t) => !existsSync(join(TMP_DIR, t.token)));
  if (RUNTIME && RS) {
    // 名册全下载后目录里若仍有残留，只能是「done 已发出但用户没下载」那类正常放弃（T02144 口径：
    // 文件该留着，交给产品自己的 TTL 清扫回收）。所以这条分两步验：先验下载即删，再验残留可被
    // sweepReportTmp 按 TTL 收走，且收走时不碰非令牌名的文件——直接断「目录为空」会把产品正常保留
    // 的待下载文件误判成泄漏（实测 2 个残留即 G-16 那条被误放行的 kickoff 产出）。
    const leftovers = orphansOf();
    const keeper = join(TMP_DIR, 'keep-me-not-a-token.bin');
    writeFileSync(keeper, 'keep');
    const swept = RS.sweepReportTmp(0, Date.now() + 1_000);
    const keeperAlive = existsSync(keeper);
    rmSync(keeper, { force: true });
    ok('G-13 下载即删后名册令牌归零；残留令牌由产品 sweep 按 TTL 收走（收后无 UUID 残留），且清扫不动非令牌名文件',
      rosterGone && swept >= leftovers.length && orphansOf().length === 0 && readdirSync(TMP_DIR).length === 0 && keeperAlive,
      { 名册数: tokens.length, 收口残留: leftovers, sweep回收数: swept, 非令牌名存活: keeperAlive, 收后目录: readdirSync(TMP_DIR) });
  } else {
    ok('G-13 下载即删后临时目录彻底为空（含非 UUID 名的其它文件也不留）', rosterGone && readdirSync(TMP_DIR).length === 0,
      readdirSync(TMP_DIR));
  }
  ok('G-17 全程服务端无未捕获异常（并发打满 + SSE 被拒 + 中途 abort 都没打挂 worker 池）',
    !/unhandledRejection|uncaughtException/.test(serverLog.join('')),
    (serverLog.join('').match(/unhandledRejection|uncaughtException[^\n]{0,120}/) ?? []).slice(0, 2));
  const health = await hit('GET', '/health');
  ok('G-18 收口时实例仍健康（闸与 abort 都没把服务打死）', health.status === 200, { status: health.status });
  evidence(`mock 累计收到 AI 请求数=${mockHits}（全部由门自己的 mock 承接，零真实配额）`);
}

// =====================================================================
// C 组：挂载点与单源常量的字面锚（判据 3：只作 okPair 字面腿，源码一律读 HEAD）
// =====================================================================
if (RUNTIME) {
  okPair(ok,
    'C-01 AI 周报两条端点挂载 `exportGate(REPORT_GATE)` 的锚（行为腿＝M-02 饱和窗口里这两条实测 429）',
    () => heavyPaths.includes('/report/ai-generate') && heavyPaths.includes('/report/ai-generate-stream')
      && heavyProbe.filter((r) => /ai-generate/.test(r.path)).length >= 2 && heavyProbe.filter((r) => /ai-generate/.test(r.path)).every((r) => judgeRejected(r, BUSY_LIT)),
    () => mountedIn(IDX_HEAD, '/report/ai-generate') && mountedIn(IDX_HEAD, '/report/ai-generate-stream'),
    () => ({ 重活路由: heavyPaths, 探测: heavyProbe.map((r) => `${r.path}=${r.status}`) }));
  okPair(ok,
    'C-02 既有两处挂闸未被拆掉的锚（补齐另一半不等于拆掉已有一半；行为腿＝/report/generate 与 kickoff 流入口同窗 429）',
    () => heavyProbe.some((r) => r.path === '/report/generate' && judgeRejected(r, BUSY_LIT)) && (kickProbeRow?.status ?? 0) === 429,
    () => mountedIn(IDX_HEAD, '/report/generate') && mountedIn(PLANS_HEAD, '/kickoff-ppt-stream'),
    () => ({ generate: heavyProbe.find((r) => r.path === '/report/generate')?.status, kickoff: kickProbeRow?.status }));
  okPair(ok,
    'C-03 闸名以常量单源引用的锚（行为腿＝R-08 按闸名各自计数 + M-02/G-14 跨链路同一计数；挂载点写成两遍字面量迟早被拆回两只闸）',
    () => heavyProbe.length >= 3 && heavyProbe.every((r) => judgeRejected(r, BUSY_LIT)) && duringKick === 429,
    () => !/exportGate\(['"]report-generate['"]/.test(IDX_HEAD + PLANS_HEAD)
      && gateRefCount(IDX_HEAD) >= 3 && gateRefCount(PLANS_HEAD) >= 1
      && /export const REPORT_GATE = 'report-generate'/.test(EG_HEAD),
    () => ({ index挂载: gateRefCount(IDX_HEAD), plans挂载: gateRefCount(PLANS_HEAD), 单源定义: /export const REPORT_GATE = 'report-generate'/.test(EG_HEAD) }));
  okPair(ok,
    'C-04 排队态判定串单源在 sse.ts、两个面板各自 import 的锚（行为腿＝F-02/F-03：真调用 reject 出来的就是那枚常量的值）',
    () => !!saturatedStream && saturatedStream.rejected === true && saturatedStream.message.includes(BUSY_LIT) && !!unsaturatedStream && unsaturatedStream.rejected === false,
    () => /export const GATE_BUSY_MSG = '([^']+)'/.test(SSE_HEAD)
      && /import \{[^}]*GATE_BUSY_MSG[^}]*\} from '..\/api\/sse'/.test(RP_HEAD)
      && /import \{[^}]*GATE_BUSY_MSG[^}]*\} from '..\/api\/sse'/.test(KP_HEAD)
      && !/const GATE_BUSY_MSG/.test(KP_HEAD + RP_HEAD),
    () => ({ 运行值串: BUSY_LIT, reject文案: saturatedStream?.message }));
  okPair(ok,
    'C-05 服务端 429 文案包含前端判定串的锚（行为腿＝G-03 用真响应值跑同一分类判据）',
    () => batch.filter((r) => r.status === 429).length > 0 && batch.filter((r) => r.status === 429).every((r) => judgeBusyBody(r.body, BUSY_LIT)),
    () => {
      const serverLit = (EG_HEAD.match(/res\.status\(429\)\.json\(\{ error: '([^']+)' \}\)/) ?? [])[1] ?? '';
      const frontLit = (SSE_HEAD.match(/export const GATE_BUSY_MSG = '([^']+)'/) ?? [])[1] ?? '';
      return serverLit.length > 0 && frontLit.length > 0 && serverLit.includes(frontLit);
    },
    () => ({
      服务端串: (EG_HEAD.match(/res\.status\(429\)\.json\(\{ error: '([^']+)' \}\)/) ?? [])[1],
      前端串: (SSE_HEAD.match(/export const GATE_BUSY_MSG = '([^']+)'/) ?? [])[1],
    }));
}

// =====================================================================
// N 组：负对照（判据 4）——每条改判都要在「行为被破坏」时转红，否则它自己就是假判据
// =====================================================================
if (UP && RUNTIME) {
  ok('N-01 反证：闸文案分类判据打在单发成功响应（G-01 那次的真 body）上必须为假——否则「被拒」那条腿恒真',
    !!warm && judgeBusyBody(warm.body, BUSY_LIT) === false && judgeAccepted(warm) === true,
    { 成功body的error: warm?.body?.error ?? '(无 error 字段)', 分类结果: warm ? judgeBusyBody(warm.body, BUSY_LIT) : null });
  {
    const tainted = [...heavyProbe, { path: '/report/zz-fake-generate', status: 404, ctype: 'application/json', body: {} }];
    ok('N-02 反证：把一条不存在的路由混进分母，「重活全部 429」的同一判据必须转红（覆盖面判据不是「枚举到几条都算过」）',
      judgeRejected({ status: 404, ctype: 'application/json', body: {} }, BUSY_LIT) === false && tainted.every((r) => judgeRejected(r, BUSY_LIT)) === false,
      { 掺入后长度: tainted.length, 原判据长度: heavyProbe.length });
  }
  {
    const fake = 'deadbeef-0000-4000-8000-000000000214';
    const p = join(TMP_DIR, fake);
    writeFileSync(p, Buffer.from('PK\u0003\u0004 planted by gate negative control'));
    const orphansDuring = orphansOf();
    const red = orphansDuring.includes(fake);
    unlinkSync(p);
    // 与 G-13/K-12 同一条判据：数的是**孤儿**（不在名册上），不是「目录里有没有 UUID」。
    // 后者会让本条反证在名册未清空时两头都「非空」，看不出放置/删除的差异（实测假红）。
    ok('N-03 反证：往 tmp 放一个孤儿令牌，G-13/K-12 用的同一判据必须点名它并转红；删掉即复绿（双向）',
      red && !orphansOf().includes(fake) && orphansOf().length === 0, { 放置时孤儿: orphansDuring, 删除后孤儿: orphansOf() });
  }
  {
    const good = [dlGoodName, ...['xlsx', 'docx', 'pdf', 'pptx'].map((f) => `MTask-AI-周报-2026-10-12.${f}`)];
    const bad = ['a|b.xlsx', 'x.exe', '带/斜杠/x.xlsx', '全角（）.pptx', '.xlsx', 'no-ext', 'a&b.docx'];
    ok('N-04 反证：文件名白名单在两组值上都得出预期结果——合法名全通过、非法名全拒（只会说「通过」的正则等于没测）',
      good.every((n) => NAMES!.DOWNLOAD_NAME_RE.test(n) === true) && bad.every((n) => NAMES!.DOWNLOAD_NAME_RE.test(n) === false),
      { 通过: good, 被拒: bad.filter((n) => !NAMES!.DOWNLOAD_NAME_RE.test(n)) });
  }
  ok('N-05 反证：把洞察锚点换成门从未让 mock 发送过的标记，同一包含判定必须为假（否则 A-01~A-03 只是「文本非空」的伪装）',
    !!art.xlsx?.text && art.xlsx.text.includes(FAKE_MARK) === false && art.xlsx.text.includes(INSIGHT_MARK) === true,
    { 假标记命中: art.xlsx?.text.includes(FAKE_MARK), 真标记命中: art.xlsx?.text.includes(INSIGHT_MARK) });
  ok('N-06 反证：R 组全部被放行的假响应都发过 finish/close 后闸快照必须彻底为空（拒绝路径或释放缺失留下任一计数即计数泄漏）',
    (() => { for (const h of rHolders) { h.emit('finish'); h.emit('close'); } return Object.keys(GATE!.gateSnapshot()).length === 0; })(),
    { 持有者数: rHolders.length, snap: GATE!.gateSnapshot() });
  {
    const quoted = "'/report/ai-generate'";
    const i = IDX_HEAD.indexOf(quoted);
    const before = mountedIn(IDX_HEAD, '/report/ai-generate');
    const tampered = IDX_HEAD.replace("'//report/ai-generate'.x", '');
    const cut = IDX_HEAD.slice(0, i + quoted.length) + IDX_HEAD.slice(i + quoted.length).replace(/^\s*,\s*exportGate\(REPORT_GATE\b/, ',');
    const after = mountedIn(cut, '/report/ai-generate');
    ok('N-07 反证：在内存副本里把 ai-generate 的 `exportGate(REPORT_GATE)` 挂载实参删掉，C-01 的字面 matcher 必须失配（锚不是恒真正则）',
      i >= 0 && before === true && after === false && tampered.length > 0, { 原文命中: before, 篡改后命中: after });
  }
  ok('N-08 反证：同一条 `streamEvents` 在未饱和时必须跑通不抛错——否则 F-02 的 reject 与闸门无关，只是模块本身坏了',
    !!unsaturatedStream && !!saturatedStream && unsaturatedStream.rejected === false && saturatedStream.rejected === true,
    { 未饱和: unsaturatedStream && { rejected: unsaturatedStream.rejected, events: unsaturatedStream.events.join(',') }, 饱和: saturatedStream?.rejected });
  ok('N-09 反证：把 TTL 传到 10 小时，同一清扫函数对刚落的令牌必须一个都不删（否则 K-10 认的是「删了」而不是「按 TTL 删」）',
    (() => {
      const t = RS!.saveReportBuffer(Buffer.from('x'));
      const n = RS!.sweepReportTmp(10 * 60 * 60 * 1000, Date.now());
      const kept = existsSync(join(TMP_DIR, t));
      RS!.readAndDeleteReport(t);
      return n === 0 && kept === true;
    })(), undefined);
  ok('N-10 反证：共用闸必须**双向**都观测到拒绝（只测 kickoff→AI 会漏掉「只在 kickoff 侧挂了一层」的实现）',
    duringKick === 429 && (kickProbeRow?.status ?? 0) === 429, { AI在kickoff占闸时: duringKick, kickoff在AI占闸时: kickProbeRow?.status });
  ok('N-12 反证：闸名引用计数在空文本上为 0（空判据），把 plans 那一处改成字符串字面闸名后必须少 1（C-03 的字面腿对真实漂移敏感，不是「数到几都算过」）',
    gateRefCount('') === 0 && gateRefCount(PLANS_HEAD) >= 1
      && gateRefCount(PLANS_HEAD.replace('exportGate(REPORT_GATE', "exportGate('report-generate'")) === gateRefCount(PLANS_HEAD) - 1
      && gateRefCount(IDX_HEAD) >= 3,
    { 空文本: gateRefCount(''), index: gateRefCount(IDX_HEAD), plans: gateRefCount(PLANS_HEAD), plans改名后: gateRefCount(PLANS_HEAD.replace('exportGate(REPORT_GATE', "exportGate('report-generate'")) });
  ok('N-11 反证：把「生成名过白名单」判据打在门自己造的一个必然非法名上必须为假（K-07 认的是每个真实生成名，不是「跑过就算过」）',
    NAMES!.DOWNLOAD_NAME_RE.test('MTask-AI-周报（本轮未生成）&bad.xlsx') === false && dlGoodName.length > 0 && NAMES!.DOWNLOAD_NAME_RE.test(dlGoodName) === true,
    { 假名: 'MTask-AI-周报（本轮未生成）&bad.xlsx', 真名: dlGoodName });
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
if (process.env.T02142_KEEP !== '1') {
  for (let i = 0; i < 12; i++) {
    try { rmSync(DATA_DIR, { recursive: true, force: true }); removed = !existsSync(DATA_DIR); break; } catch { await sleep(1_000); }
  }
}
ok('Z-01 收尾零残留：临时数据目录已删除（或按 T02142_KEEP 显式保留），主仓产品路径未被本门写入',
  process.env.T02142_KEEP === '1' || removed, { DATA_DIR, 残留: existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : [] });

const summary = `T02142 AI 周报补挂闸门（T02293 改判版）：PASS ${pass} / FAIL ${fail}${skippedList.length ? ` / SKIP ${skippedList.length}` : ''}\n` + lines.join('\n')
  + (skippedList.length ? `\n\n跳过项：\n${skippedList.join('\n')}\n` : '');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02142-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
