/**
 * T02142 门（派生自 T02105：AI 周报两条生成端点补挂 REPORT_GATE——FR-5 共用闸补齐另一半）。
 *
 * 分工（只补此前没人证过的那一层）：
 *   verify-t02105 证的是**接线**（启动会与离线周报共用同一闸名 + 429 形态）；
 *   verify-t02113 G 组证的是**离线四格式导出侧**的上限实测。
 *   本门证的是此前一直在闸外的那半张矩阵：
 *     ① `/report/ai-generate` 与 `/report/ai-generate-stream` 是**最重**的 AI 合成链路
 *        （AIService.ask 出洞察 + report-worker 合成文件），补挂后必须真的计入同一只闸；
 *     ② 报表族四条重活端点**齐全**挂闸（矩阵式断言，不是逐条点名——第 5 条新增时本断言会点名缺口）；
 *     ③ SSE 端点被拒时给的是**结构化 429 JSON**，不是半开的 event-stream（前端 streamEvents
 *        的非 2xx 分支因此有可读文案）；
 *     ④ 挂闸不能把既有的入参校验吞掉（period/format 非法仍 400）；
 *     ⑤ **与启动会稿共用计数**（G-14 用两条长驻 kickoff SSE 占满闸位再打 AI 周报）与
 *        **断开即放闸**（G-15）——这两条是本单 description 点名的实测项；
 *     ⑥ 面板把「被闸拒」与「生成失败」分开显示（S-07/S-08：判定串升为 sse.ts 单源，
 *        周报面板对齐启动会面板的排队态语气，且前端串必须是服务端 429 文案的子串）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02142-report-ai-gate.mts
 * 环境变量：`T02142_PORT`（默认随机 39400+rand300）。
 * 隔离纪律（skill 红线 8）：生产库只读副本落临时目录；上限调校只写副本；模型走进程内 mock（零真实配额）；收尾删目录。
 * 结果落 .workbuddy/t02142-gate-results-<运行标识>.txt。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02142_PORT ?? 39_400 + Math.floor(Math.random() * 300));
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(OUT_DIR, { recursive: true });
// 副本库放工作区（D:）不放系统 tmpdir（C:）：本门会复制生产库并让它涨 WAL，
// 实测 C: 剩余不足 30MB 时直接 `SQLITE_FULL` 崩在写令牌那一步——门跑不跑得住取决于盘，不该取决于此。
const DATA_DIR = mkdtempSync(join(OUT_DIR, 't02142-gate-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP_DIR = join(DATA_DIR, 'tmp');
process.env.MTask_DATA_DIR = DATA_DIR;

const FIVE_PID = '95f31a46-92f6-4046-8cb6-ee3c4e228a44'; // mtask五期（有任务与计划数据，报告能出内容）
const AI_DELAY_MS = 1_800; // 让 4 路并发在闸内真的重叠，才量得出「2 接受 2 拒」而不是全过

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// mock AI：洞察段走 openai 兼容形态（AIService.ask），带可调延迟与请求计数
// =====================================================================
let mockDelayMs = 0;
let mockHits = 0;
const mock = createServer((req, res) => {
  mockHits += 1;
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '本期完成 3 项、进行中 2 项；风险提示：里程碑临近，建议例会跟节点走。' } }],
      }));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const Database = (await import('better-sqlite3')).default;
{
  const src = new Database(join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db'), { readonly: true });
  await src.backup(join(DATA_DIR, 'mtask.db'));
  src.close();
}
ok('G-00 生产库只读副本已生成（上限调校只写副本，不碰生产 app_settings）', existsSync(join(DATA_DIR, 'mtask.db')));

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

/** 非流式 AI 周报：返回状态码与解析体（429/400/200 都要能区分） */
async function aiGen(body: Record<string, unknown>) {
  const res = await fetch(BASE + '/report/ai-generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}
/** 流式 AI 周报：只看首帧与 content-type——被拒时必须是 JSON 429，不能是半开的 event-stream */
async function aiGenStream(body: Record<string, unknown>) {
  const ac = new AbortController();
  try {
    const res = await fetch(BASE + '/report/ai-generate-stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
    const ctype = res.headers.get('content-type') ?? '';
    let firstChunk = '';
    if (ctype.includes('event-stream') && res.body) {
      const reader = res.body.getReader();
      const { value } = await Promise.race([reader.read(), sleep(2_500).then(() => ({ value: undefined }))]);
      firstChunk = value ? new TextDecoder().decode(value) : '';
      ac.abort(); // 只验「流开得住」，不把它跑完（省时间也让闸位归还）
    } else {
      const t = await res.text();
      firstChunk = t.slice(0, 200);
    }
    return { status: res.status, ctype, firstChunk };
  } catch (e) {
    return { status: 0, ctype: '', firstChunk: e instanceof Error ? e.message : String(e) };
  }
}
async function genReport(body: Record<string, unknown>) {
  const res = await fetch(BASE + '/report/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

/** 启动会稿开流（只为占闸）：3 页最小合法大纲，拿到响应头即算「已进入闸内」，收尾由调用方 abort */
const KICKOFF_OUTLINE = Array.from({ length: 3 }, (_, i) => ({
  section: '项目风险', title: `占闸页 ${i + 1}`, bullets: ['占位要点'], dataKeys: ['risks'], layout: 'table',
}));
async function kickoffOpen(toolId: string) {
  const ac = new AbortController();
  const res = await fetch(BASE + '/plans/kickoff-ppt-stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: FIVE_PID, toolId, outline: KICKOFF_OUTLINE }), signal: ac.signal,
  }).catch(() => null);
  return { status: res?.status ?? 0, ac };
}

// =====================================================================
// S 组：矩阵齐全（纯源码断言，先于行为跑——缺一条 mount，行为组测的就是旧态）
// =====================================================================
{
  const IDX = readFileSync(join(ROOT, 'server', 'src', 'routes', 'index.ts'), 'utf8');
  const PLANS = readFileSync(join(ROOT, 'server', 'src', 'routes', 'plans.ts'), 'utf8');
  const SSE = readFileSync(join(ROOT, 'web', 'src', 'api', 'sse.ts'), 'utf8');
  const mounted = (src: string, route: string) => {
    for (const obj of ['api', 'planApi']) {
      const key = `${obj}.post('${route}'`;
      const i = src.indexOf(key);
      if (i < 0) continue;
      // 不能用 split(',') 取第二个实参——`exportGate(REPORT_GATE, undefined, { defer: true })`
      // 内部就有逗号，切出的片段会在第一个内层逗号处断掉，已挂闸的启动会稿会被误判成未挂（首轮即如此）。
      // 改测「闭引号之后的文本是否以 `, exportGate(REPORT_GATE` 起头」。
      return /^\s*,\s*exportGate\(REPORT_GATE\b/.test(src.slice(i + key.length));
    }
    return false;
  };
  ok('S-01 /report/ai-generate 挂 exportGate(REPORT_GATE)', mounted(IDX, '/report/ai-generate'),
    IDX.slice(IDX.indexOf("api.post('/report/ai-generate'"), IDX.indexOf("api.post('/report/ai-generate'") + 90));
  ok('S-02 /report/ai-generate-stream 挂 exportGate(REPORT_GATE)', mounted(IDX, '/report/ai-generate-stream'));
  ok('S-03 /report/generate 与 /plans/kickoff-ppt-stream 的既有挂闸未被改动（补齐另一半不等于拆掉已有一半）',
    mounted(IDX, '/report/generate') && mounted(PLANS, '/kickoff-ppt-stream'));
  // 矩阵式：报表族所有「重活 POST」都必须出现在挂闸清单里，新增端点漏挂会被这条点名
  const heavyRoutes = [...IDX.matchAll(/api\.post\('\/report\/([a-z-]*(generate|export)[a-z-]*)'/g)].map((m) => `/report/${m[1]}`)
    .filter((r) => !/download|templates/.test(r));
  const unmounted = heavyRoutes.filter((r) => !mounted(IDX, r));
  ok('S-04 报表族重活端点矩阵齐全（自动枚举 generate/export 形态，不逐条手点名）',
    heavyRoutes.length >= 3 && unmounted.length === 0, { heavyRoutes, unmounted });
  ok('S-05 闸名以常量单源引用，四处挂点无字面量漂移（写成两遍迟早被后来者拆回两个闸）',
    !/exportGate\(['"]report-generate['"]/.test(IDX + PLANS) && (IDX.match(/exportGate\(REPORT_GATE\)/g) ?? []).length >= 3);
  ok('S-06 前端 streamEvents 对非 2xx 读出结构化 error 抛出（429 文案有归宿，本单无需改前端）',
    /if \(!res\.ok\)[\s\S]{0,160}body[\s\S]{0,80}\.error/.test(SSE));
  // S-07/S-08 对应本单第 5 条：面板要把「被闸拒」与「生成失败」分开显示（PRD §5 R6 排队态文案）。
  // 判定串此前只在启动会面板里各写一份；升到 sse.ts 单源后，两处面板共用一个常量——
  // 单源本身要钉住，否则后来者又抄一份字面量，服务端改措辞时前端静默退化成红叉。
  const KP = readFileSync(join(ROOT, 'web', 'src', 'pages', 'KickoffPptPanel.tsx'), 'utf8');
  const RP = readFileSync(join(ROOT, 'web', 'src', 'pages', 'ReportPage.tsx'), 'utf8');
  ok('S-07 排队态判定串单源在 sse.ts，两个面板各自 import（周报面板确有 queued 分支）',
    /export const GATE_BUSY_MSG/.test(SSE)
      && /import \{[^}]*GATE_BUSY_MSG[^}]*\} from '..\/api\/sse'/.test(RP)
      && /import \{[^}]*GATE_BUSY_MSG[^}]*\} from '..\/api\/sse'/.test(KP)
      && /msg\.includes\(GATE_BUSY_MSG\)/.test(RP)
      && !/const GATE_BUSY_MSG/.test(KP + RP),
    { rp_import: /from '..\/api\/sse'/.test(RP), kp_import: /from '..\/api\/sse'/.test(KP), rp_queued: /msg\.includes\(GATE_BUSY_MSG\)/.test(RP) });
  const GATE_SRC = readFileSync(join(ROOT, 'server', 'src', 'util', 'export-gate.ts'), 'utf8');
  const busyLit = (SSE.match(/export const GATE_BUSY_MSG = '([^']+)'/) ?? [])[1] ?? '';
  ok('S-08 前端判定串确实是服务端 429 文案的子串（两端同源，不靠巧合）',
    busyLit.length > 0 && (GATE_SRC.match(/res\.status\(429\)\.json\(\{ error: '([^']+)' \}\)/) ?? [])[1]?.includes(busyLit) === true,
    { busyLit, serverMsg: (GATE_SRC.match(/res\.status\(429\)\.json\(\{ error: '([^']+)' \}\)/) ?? [])[1] });
}

// =====================================================================
// G 组：真链路上量行为
// =====================================================================
mkdirSync(TMP_DIR, { recursive: true });
const tokens: Array<{ token: string; filename: string }> = [];
if (!(await waitUp())) {
  ok('X-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('X-00 隔离实例启动', true);
  const tool = await fetch(BASE + '/aitools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 't02142-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', model: 'mock-insight', timeoutMs: 20000 }),
  });
  const toolId = ((await tool.json().catch(() => null)) as any)?.id as string | undefined;
  ok('X-01 mock AI 工具已建（洞察走本地 mock，零真实配额）', !!toolId, toolId);

  const aiBody = (format: string) => ({ period: 'week', format, projectId: FIVE_PID, toolId });
  // 先单发一次跑干 warm-up（上一件事的在途计数不能混进并发判定），并拿到一个可下载的令牌
  mockDelayMs = 0;
  const warm = await aiGen(aiBody('xlsx'));
  ok('G-01 单发 AI 周报（非流式）在挂闸后仍走通（200 + 令牌 + 洞察正文）',
    warm.status === 200 && typeof warm.json?.token === 'string' && typeof warm.json?.insight === 'string',
    { status: warm.status, json: warm.json });
  if (warm.json?.token) tokens.push({ token: String(warm.json.token), filename: String(warm.json.filename) });

  // 4 路并发非流式：上限 2 → 恰好 2 接受 2 拒
  mockDelayMs = AI_DELAY_MS;
  const batch = await Promise.all([aiGen(aiBody('xlsx')), aiGen(aiBody('docx')), aiGen(aiBody('pdf')), aiGen(aiBody('pptx'))]);
  mockDelayMs = 0;
  const accepted = batch.filter((r) => r.status !== 429);
  const rejected = batch.filter((r) => r.status === 429);
  ok('G-02 4 路并发 AI 周报（非流式）→ 恰好 2 接受 + 2 拒：新挂的两条端点真的计入同一只闸（全过＝闸没生效）',
    accepted.length === 2 && rejected.length === 2, batch.map((r) => r.status));
  ok('G-03 被拒的是结构化中文 429（不是空体，也不是 SSE 半开头再断）',
    rejected.every((r) => typeof r.json?.error === 'string' && /导出任务过多/.test(r.json.error)),
    rejected.map((r) => r.json));
  for (const r of accepted) if (r.json?.token) tokens.push({ token: String(r.json.token), filename: String(r.json.filename) });
  await sleep(2_500); // 让在途批次彻底归零

  // 流式侧同闸：3 路并发 → 2 条 event-stream 起步 + 1 条 JSON 429
  mockDelayMs = AI_DELAY_MS;
  const streams = await Promise.all([aiGenStream(aiBody('xlsx')), aiGenStream(aiBody('docx')), aiGenStream(aiBody('pdf'))]);
  const sse = streams.filter((s) => s.ctype.includes('event-stream'));
  const rej = streams.filter((s) => s.status === 429);
  ok('G-04 3 路并发 AI 周报（流式）→ 2 条 event-stream + 1 条 429（SSE 与离线导出共用一只闸）',
    sse.length === 2 && rej.length === 1, streams.map((s) => `${s.status}:${s.ctype.split(';')[0]}`));
  ok('G-05 流式端点被拒时是 JSON 429 而非半开事件流（前端 streamEvents 非 2xx 分支因此拿得到可读文案）',
    rej.every((s) => /application\/json/.test(s.ctype) && /导出任务过多/.test(s.firstChunk)),
    rej.map((s) => ({ ctype: s.ctype, body: s.firstChunk.slice(0, 80) })));
  ok('G-06 被接受的两条流确实开始了（有 stage/chunk 帧，不是空转到超时）',
    sse.every((s) => /event: (stage|chunk)/.test(s.firstChunk)), sse.map((s) => s.firstChunk.slice(0, 60)));
  await sleep(2_500);

  // 跨链路混跑：1 路 AI 周报在途 + 1 路离线导出 + 1 路 AI 周报流式 → 同闸总量不超 2
  mockDelayMs = AI_DELAY_MS;
  const mix = await Promise.all([
    aiGen(aiBody('pptx')),
    genReport({ period: 'week', format: 'xlsx', projectId: FIVE_PID }),
    aiGenStream(aiBody('docx')),
  ]);
  mockDelayMs = 0;
  const mix429 = mix.filter((r: any) => r.status === 429).length;
  const mixPass = mix.filter((r: any) => r.status === 200).length;
  ok('G-07 混跑三条链路共用一闸：AI 非流式 + 离线导出 + AI 流式 → 确有请求被拒且放行数不超上限',
    mixPass >= 1 && mixPass <= 2 && mix429 >= 1, mix.map((r: any) => r.status));
  for (const r of mix as any[]) if (r.json?.token) tokens.push({ token: String(r.json.token), filename: String(r.json.filename) });
  await sleep(2_500);

  // 跨链路占闸（本单第 2 条字面要求）：**启动会稿**占满 2 路时，AI 周报必须被同一计数挡下。
  // G-07 用离线导出占闸证不了这条——离线导出跑完即放，占闸窗口太短；用两条长驻 SSE 才量得实。
  {
    mockDelayMs = AI_DELAY_MS;
    const h1 = await kickoffOpen(toolId!);
    const h2 = await kickoffOpen(toolId!);
    await sleep(500); // 两路确实进闸（defer 只推迟 next()，计数在中间件里同步已加）
    const during = await aiGen(aiBody('xlsx'));
    ok('G-14 两路启动会稿在途时，AI 周报被**同一计数**挡下 429（FR-5 共用闸的跨链路实测）',
      h1.status === 200 && h2.status === 200 && during.status === 429,
      { kickoff: [h1.status, h2.status], aiReport: during.status, msg: during.json?.error });
    // 断开即放闸（本单第 3 条）：闸位由 export-gate 的 res.once('close') 归还，此前只在离线导出侧实测过
    h1.ac.abort();
    h2.ac.abort();
    await sleep(1_500);
    const after = await Promise.all([aiGen(aiBody('xlsx')), aiGen(aiBody('docx'))]);
    mockDelayMs = 0;
    ok('G-15 启动会稿客户端断开后闸位归还（无幽灵占用：断两路后 2 路 AI 周报恢复全接受）',
      after.every((r) => r.status !== 429), after.map((r) => r.status));
    for (const r of after) if (r.json?.token) tokens.push({ token: String(r.json.token), filename: String(r.json.filename) });
    await sleep(2_500);
  }

  // app_settings 调限即时生效（只写副本库）
  {
    const wdb = new Database(join(DATA_DIR, 'mtask.db'));
    wdb.prepare("insert into app_settings(key,value) values('exportGateLimit.report-generate','1') on conflict(key) do update set value=excluded.value").run();
    wdb.close();
  }
  await sleep(300);
  await aiGen(aiBody('xlsx')).then((r) => { if (r.json?.token) tokens.push({ token: String(r.json.token), filename: String(r.json.filename) }); }); // 单发把闸位放干
  mockDelayMs = AI_DELAY_MS;
  const pair = await Promise.all([aiGen(aiBody('xlsx')), aiGen(aiBody('pdf'))]);
  mockDelayMs = 0;
  ok('G-08 上限经 app_settings 即时生效（副本库调 report-generate=1 → 2 路只放 1 路；AI 周报侧同样吃这个可调值）',
    pair.filter((r) => r.status !== 429).length === 1 && pair.filter((r) => r.status === 429).length === 1,
    pair.map((r) => r.status));
  for (const r of pair) if (r.json?.token) tokens.push({ token: String(r.json.token), filename: String(r.json.filename) });
  {
    const wdb = new Database(join(DATA_DIR, 'mtask.db'));
    wdb.prepare("delete from app_settings where key = 'exportGateLimit.report-generate'").run();
    wdb.close();
  }
  await sleep(2_500);
  await aiGen(aiBody('xlsx')).then((r) => { if (r.json?.token) tokens.push({ token: String(r.json.token), filename: String(r.json.filename) }); });
  const back = await Promise.all([aiGen(aiBody('xlsx')), aiGen(aiBody('docx'))]);
  ok('G-09 删键回落默认 2（两路全接受）', back.every((r) => r.status !== 429), back.map((r) => r.status));
  for (const r of back) if (r.json?.token) tokens.push({ token: String(r.json.token), filename: String(r.json.filename) });

  // 校验未被挂闸吞掉 + 令牌仍可下载 + 闸位归还 + 实例健康
  await sleep(2_500);
  const badPeriod = await aiGen({ period: 'hour', format: 'xlsx', projectId: FIVE_PID, toolId });
  const badFormat = await aiGen({ period: 'week', format: 'rtf', projectId: FIVE_PID, toolId });
  const badTool = await aiGen({ period: 'week', format: 'xlsx', projectId: FIVE_PID });
  ok('G-10 挂闸没吞掉入参校验：period/format 非法仍 400，缺 toolId 仍 400（闸在门外，不改变错误语义）',
    badPeriod.status === 400 && badFormat.status === 400 && badTool.status === 400,
    { badPeriod: badPeriod.status, badFormat: badFormat.status, badTool: badTool.status });

  const dl = await Promise.all(tokens.map(async (t) => {
    const res = await fetch(BASE + '/report/ai-download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t.token, filename: t.filename }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    // 判据用「魔数与扩展名相符 + 非琐碎大小」而非一刀切 >10KB：
    // 本数据集的 AI 周报实测 9.6~10.2KB（离线四格式导出与启动会稿才有 250KB 量级），
    // 拿 10KB 当门会把正常产出误判成空壳；魔数才真正区分「空壳」与「成品」。
    const magic = /\.pdf$/i.test(t.filename) ? buf.subarray(0, 4).toString('latin1') === '%PDF'
      : buf.subarray(0, 2).toString('latin1') === 'PK';
    return { status: res.status, bytes: buf.byteLength, magic, ext: t.filename.split('.').pop() };
  }));
  ok('G-11 批次里每个放行请求的令牌都能下载出真实产出（魔数与扩展名相符，不是 200 空壳）',
    dl.length > 0 && dl.every((d) => d.status === 200 && d.bytes > 1_000 && d.magic), { count: dl.length, dl: dl.slice(0, 4) });
  ok('G-12 下载即删后临时目录回到空（本门不留孤儿令牌）',
    readdirSync(TMP_DIR).length === 0, readdirSync(TMP_DIR));
  ok('G-13 全程服务端无未捕获异常（并发打满 + SSE 被拒 + 中途 abort 都没打挂 worker 池）',
    !/unhandledRejection|uncaughtException/.test(serverLog.join('')),
    (serverLog.join('').match(/unhandledRejection|uncaughtException[^\n]{0,120}/) ?? []).slice(0, 2));
}

child.kill();
mock.close();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }

const summary = `T02142 AI 周报补挂闸门：PASS ${pass} / FAIL ${fail}\n` + lines.join('\n');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02142-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
