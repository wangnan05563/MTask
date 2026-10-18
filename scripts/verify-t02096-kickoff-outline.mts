/**
 * T02096 门：启动会 PPT 大纲生成与 schema 校验（PRD-项目启动会PPT生成 §3.3 FR-3、技术方案 §2.2 §3.2）。
 *
 * 断言：
 *   S 组 契约守卫（T02293 判据 3 起为「字面锚点 + 同义行为断言」配对项）：校验在 parse 回调内、
 *                  必含页/页数硬失败、数字铁律入提示词、未配模型不静默回落、硬阻塞服务端二次拦截、
 *                  里程碑不进 Σ 工期、人月因子单源、风险四类本地枚举、路由注册顺序、时间线口径两处提示词。
 *                  行为侧一律取**隔离实例的 HTTP 响应 + mock 端收到的提示词工件 + 进程内纯函数返回值**，
 *                  夹具由门自建（判据 2：S 组风险/干净两个项目 + 门内长/短 PRD），不读生产业务行。
 *   R 组 隔离实例 + 本地 mock OpenAI 兼容服务（不消耗真实配额）：
 *     R-01 工具未配 model → 400 且原文透传「所选模型未配置…」（PRD §4 不静默回落）；
 *     R-02 合规 13 页大纲 → 200，页数/dataAsOf/truncated 如实；
 *     R-03 喂给模型的上下文带库内真实计数（需求/计划条数与端点一致）与数字禁令，不含编造数；
 *     R-04 页数不合规 → 触发自带重试（mock 收到 2 次请求）后 400 点名原因；
 *     R-05 首轮坏次轮好 → 200 且 warnings 记录重试；
 *     R-06 非法 dataKey / R-08 缺 timeline 页 → 400 逐条点名；
 *     R-07a 超长 bullet 首轮拒、重试轮裁剪为 42 字省略号收口（T02223）→ 200 + warnings；
 *     R-07c 裁剪结果过装配层字数自检（不把越界从服务层搬到版式层）；
 *     R-07b 标题超长、bullet 超行 → 200 + warnings（版式收敛类不把可用大纲打死）；
 *     R-09 硬阻塞项目 → 400 拒生成，且 mock 零请求（校验阶段不烧配额）；
 *     R-10 代码围栏与 {"outline":[...]} 包装两种输出形态均能收；
 *     R-11 extraNote 原文进提示词；R-12 参数缺失 400。
 *
 * 用法（与 T02095/T02126/T02131 同口径，better-sqlite3 需匹配当前 Node ABI）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02096-kickoff-outline.mts
 * 环境变量：`T02096_PORT`（默认随机 39700+rand300）。
 * 隔离纪律（skill 红线 8）：库副本/端口/临时目录全临时，跑完 kill + 回收。
 * 结果落 .workbuddy/t02096-gate-results-<运行标识>.txt（GBK 控制台乱码，以文件为权威）。
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：字面锚点必须配同义行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02096_PORT ?? 39_700 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02096-outline-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const FIVE_PID = '95f31a46-92f6-4046-8cb6-ee3c4e228a44'; // mtask五期
const SECTIONS = ['封面', '议程', '项目团队介绍', '项目背景', '项目需求', '项目范围', '项目计划', '工作量评估', '测试与质量策略', '项目风险', '沟通管理', '附录', '正文'];

const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
// T02223：装配层同口径自检（裁剪后不得再触发「超出 42 字」越界）——直接引 layout 单源，不经 HTTP
const LAY = await import('../server/src/services/kickoff-layout.ts');
// T02293：S 组的行为侧走进程内纯函数（workloadOf / validateOutline / assertOutlineShape）——只读导出，不碰库
const SVC = await import('../server/src/services/kickoffService.ts');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

// =====================================================================
// 字面锚点专用料（判据 3：源码正则只作 okPair 的字面侧，行为侧见文件末尾「S 组：契约守卫」）
// =====================================================================
const svcSrc = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8');
const routeSrc = readFileSync(join(ROOT, 'server', 'src', 'routes', 'plans.ts'), 'utf8');
const outlineSrc = svcSrc.slice(svcSrc.indexOf('// ---------- 大纲生成与校验'));
const bundleSrc = svcSrc.slice(svcSrc.indexOf('// ---------- 资料采集 Bundle'), svcSrc.indexOf('// ---------- 大纲生成与校验'));
const preflightSrc = svcSrc.slice(svcSrc.indexOf('// ---------- 前置校验'), svcSrc.indexOf('// ---------- 资料采集 Bundle'));
// S-01~S-12 的源码正则不再单独定绿：它们逐条搬到了下方 S 组 okPair 的字面侧，
// 绿必须先由「隔离实例 HTTP 响应 / mock 收到的提示词工件 / 纯函数返回值」成立。

// =====================================================================
// mock OpenAI 兼容服务（本地、零真实配额）
// =====================================================================
type MockReply = { content: string; status?: number };
let mockQueue: MockReply[] = [];
const mockRequests: Array<{ system: string; user: string }> = [];
const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}') as { messages?: Array<{ role: string; content: string }> };
    mockRequests.push({ system: body.messages?.[0]?.content ?? '', user: body.messages?.[1]?.content ?? '' });
    // 队列剩 1 条时重复返回同一条：重试类用例排一条坏输出即够，不必为每次重试复刻
    const reply = mockQueue.length > 1 ? mockQueue.shift() : mockQueue[0];
    if (!reply) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock 队列已空' } }));
      return;
    }
    if (reply.status && reply.status >= 400) {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock 上游异常' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply.content }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }));
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// R 组：隔离实例（生产库副本，只读打开后复制）
// =====================================================================
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
const copyPath = join(DATA_DIR, 'mtask.db');
{
  const Database = (await import('better-sqlite3')).default;
  const src = new Database(prodDb, { readonly: true });
  await src.backup(copyPath);
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
async function call(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
}

/** 造一份合规大纲：页数可调，timeline/workload 各占一页，bullet 均 ≤42 字 */
function outlineJson(pages = 13, timelineAt = 6, workloadAt = 7) {
  return JSON.stringify(Array.from({ length: pages }, (_, i) => ({
    section: SECTIONS[i % SECTIONS.length],
    title: `启动会页 ${i + 1}`,
    bullets: i === timelineAt ? ['时间线按库内排期绘制'] : i === workloadAt ? ['工作量取估算口径'] : ['范围与交付物', '责任分工'],
    dataKeys: i === timelineAt ? ['timeline', 'planRows'] : i === workloadAt ? ['workload', 'reqStats'] : ['preflight'],
    layout: i === 0 ? 'cover' : i === timelineAt ? 'timeline' : i === workloadAt ? 'chart' : 'table',
  })));
}

if (!(await waitUp())) {
  ok('R-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('R-00 隔离实例启动', true);
  const toolMock = await call('POST', '/aitools', { name: 't02096-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', model: 'mock-outline', timeoutMs: 15000 });
  const toolNoModel = await call('POST', '/aitools', { name: 't02096-nomodel', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', timeoutMs: 15000 });
  const mockId = String(toolMock.body?.id ?? '');
  const noModelId = String(toolNoModel.body?.id ?? '');
  ok('R-00b 两个测试工具已建（含无 model 的那个）', !!mockId && toolNoModel.status === 201 && !toolNoModel.body?.model, toolNoModel.body?.model);

  // R-01 未配模型：错误原文透传，不静默回落
  mockQueue = [];
  const noModel = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: noModelId });
  ok('R-01 未配 model → 400 透传「所选模型未配置…」且零 mock 请求',
    noModel.status === 400 && /所选模型未配置，请先在「模型管理」为该工具填写默认模型/.test(String(noModel.body?.error)) && mockRequests.length === 0,
    noModel.body);

  // R-02 合规大纲
  mockQueue = [{ content: outlineJson(13) }];
  mockRequests.length = 0;
  const good = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-02 合规 13 页 → 200 且 outline/dataAsOf 如实',
    good.status === 200 && good.body?.outline?.length === 13 && typeof good.body?.truncated === 'boolean' && /^\d{4}-\d{2}-\d{2}$/.test(String(good.body?.dataAsOf)),
    { status: good.status, pages: good.body?.outline?.length, err: good.body?.error });
  // truncated 与 warnings 必须同步：只标不告（或只告不标）都会让面板把「摘要不完整」这件事漏掉
  ok('R-02b truncated 与 PRD 截断告警同进同出',
    good.body?.truncated !== true || (good.body?.warnings ?? []).some((w: string) => /PRD 摘要超出/.test(w)),
    { truncated: good.body?.truncated, warnings: good.body?.warnings });

  // R-03 提示词带真实计数（与 T02095 端点同源），数字禁令在位
  const reqs = await call('GET', `/plans/prd-requirements?projectId=${FIVE_PID}`);
  const plans = await call('GET', `/plans?projectId=${FIVE_PID}`);
  const sys = mockRequests[0]?.system ?? '';
  const user = mockRequests[0]?.user ?? '';
  ok('R-03a user 提示词含库内真实需求/计划条数',
    user.includes(`需求 ${reqs.body.length} 条`) && user.includes(`计划 ${plans.body.length} 条`),
    { reqs: reqs.body?.length, plans: plans.body?.length, snippet: user.slice(0, 160) });
  ok('R-03b system 提示词含数字禁令与三套枚举',
    /严禁自行写数字/.test(sys) && sys.includes('timeline') && sys.includes('dataKeys'));
  const facts = user.split('【PRD 摘要】')[0] ?? '';
  // T02204：「占位假数」与「空源缺口口径」是两件事。999/XXX 这类测试哨兵必须零出现；
  // 「待补充」是 FR-4.1 的可见占位词，允许出现在**同时点名了缺失原因**的行——
  // 承担人全空时喂「承担人：待补充（N 条计划均未填）」，就是为了挡住模型抄出「0 人」这种像结论的数。
  const gapLines = facts.split('\n').filter((l) => /待补充/.test(l));
  ok('R-03c 真实计数段不含占位假数（999/XXX 零出现），「待补充」只在点名了缺失原因的行里',
    !/999|XXX/.test(facts) && gapLines.every((l) => /未填|未建|均无|暂无|未提供|样例/.test(l)),
    { gapLines });

  // T02204：真链路门 A-02a（bullets 锚点率 ≥60%）回落时，服务侧只负责一件事——
  // **有没有把可指代的真实名称喂进去**。喂不出名字，模型只能写套话；喂得出而模型不引用，
  // 才是提示词/模型侧的问题（那半归真链路门）。这条把「供给半」钉成不依赖配额的机检判据。
  // 判据自证：命中 0 处时把维度名单与样例段原文一起打出来，别让人猜是数据没了还是喂法改了。
  const sampleLine = facts.split('\n').find((l) => /样例事实/.test(l)) ?? '';
  const dims = ['需求样例', '进行中计划', '阻塞计划', '已完成计划', '里程碑'];
  const quotedNames = sampleLine.match(/「[^」]{2,}」/g) ?? [];
  ok('R-03d 样例事实五维齐备且可指代名称 ≥6 个（A-02a 的服务侧供给半）',
    dims.every((d) => sampleLine.includes(d)) && quotedNames.length >= 6,
    { 缺维度: dims.filter((d) => !sampleLine.includes(d)), 名称数: quotedNames.length, 样例段原文: sampleLine.slice(0, 300) });
  ok('R-03e 提示词带可机检锚点约束（每页≥1 条「」指代 / 全稿 6 成 = A-02a 的 60% 同口径 / 空源不写「0 人」）',
    /至少 1 条用「」/.test(sys) && /6 成/.test(sys) && /不得把「没填」写成「0 人/.test(sys),
    { "sys 锚点段": sys.slice(-300) });
  // T02204 归因实验：HEAD 副本（无第 12 条）真链路报「第 3 页 缺少标题 / 缺时间线页」，
  // 加了第 12 条后同一厂商改报「单条 bullet 超出 42 字」——模型为了凑指代，把 PRD 整段原文、
  // 反引号代码标识符、「工作空间 D:\\…」、以及「共 14 条需求」这类统计句整条塞进 bullets。
  // 所以第 12 条必须自带「只放名称本体 + 占位词不计数 + 不许加长句子」这三道收窄，否则锚点约束
  // 自身就成了新的 400 来源（也是 A-02a 的漏洞：「待补充」包进「」就能白拿一个锚点）。
  ok('R-03f 第 12 条自带收窄：「」只放≤12 字名称本体 / 禁整段原文·路径·代码 / 占位词不计入指代配额',
    /名称本体.*≤\s*12\s*字/.test(sys) && /整段原文、代码标识符、文件路径/.test(sys) && /不计入指代配额/.test(sys),
    { "sys 第 12 条": sys.slice(sys.indexOf('12. T02204'), sys.indexOf('12. T02204') + 520) });

  // R-04 页数不合规 → 重试后 400 点名
  mockQueue = [{ content: outlineJson(5) }];
  mockRequests.length = 0;
  const fewPages = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-04 页数 5 → 自动重试（mock 收到 2 次）后 400 点名页数区间',
    fewPages.status === 400 && mockRequests.length === 2 && /AI 未返回合规大纲/.test(String(fewPages.body?.error)) && /不在 12~18 区间/.test(String(fewPages.body?.error)),
    { status: fewPages.status, asks: mockRequests.length, error: fewPages.body?.error });

  // R-05 首轮坏次轮好 → 200 + warnings 记录
  mockQueue = [{ content: '这不是 JSON' }, { content: outlineJson(12) }];
  mockRequests.length = 0;
  const flaky = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-05 首轮坏/次轮好 → 200 且 warnings 记录已重试',
    flaky.status === 200 && flaky.body?.outline?.length === 12 && (flaky.body?.warnings ?? []).some((w: string) => /已自动重试 1 次/.test(w)),
    { status: flaky.status, warnings: flaky.body?.warnings, error: flaky.body?.error });
  // T02204：重试轮走的是另一份 system（OUTLINE_SYSTEM_RETRY），锚点约束只写在首轮等于半条判据——
  // 而恰恰是首轮不合格的稿才会进重试轮。断言两轮的约束同口径在位（同 A-02a 的 6 成 = 60%）。
  const retrySys = mockRequests[1]?.system ?? '';
  ok('R-05b 重试轮 system 同样带「每页≥1 条「」指代 / 6 成 / 空源不写 0 人」约束（不是只有首轮）',
    mockRequests.length === 2 && /至少|每页.*1 条/.test(retrySys) && /6 成/.test(retrySys) && /0 人/.test(retrySys),
    { asks: mockRequests.length, retrySysTail: retrySys.slice(-260) });
  // 重试轮恰恰是「上一轮已经超长」的那一稿——不收窄指代写法，重试只是把同一条 42 字违规再说一遍。
  ok('R-05c 重试轮同样带收窄（≤12 字名称本体 / 不放路径代码整段 / 占位词不计数），不是只重申 42 字上限',
    /≤\s*12\s*字的名称本体/.test(retrySys) && /不放整段原文、路径、代码标识符/.test(retrySys) && /不计入指代配额/.test(retrySys),
    { retrySysTail: retrySys.slice(-320) });

  // R-06 非法 dataKey
  const badKey = JSON.parse(outlineJson(12)) as any[];
  badKey[2].dataKeys = ['reqCount'];
  mockQueue = [{ content: JSON.stringify(badKey) }];
  const r6 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-06 非法 dataKey → 400 点名未知项', r6.status === 400 && /dataKeys 含未知项「reqCount」/.test(String(r6.body?.error)), r6.body?.error);

  // R-07a 单条 bullet 超 42 字：首轮硬失败触发重试；重试轮仍超限（T02223）→ 裁到上限 + warning，不再整稿 400
  const longBullet = JSON.parse(outlineJson(12)) as any[];
  longBullet[3].bullets = ['一'.repeat(60)];
  mockQueue = [{ content: JSON.stringify(longBullet) }];
  mockRequests.length = 0;
  const r7a = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  const clipped = String(r7a.body?.outline?.[3]?.bullets?.[0] ?? '');
  ok('R-07a 单条 bullet 超 42 字：首轮拒（mock 收到 2 次）→ 重试轮裁剪为 42 字省略号收口 → 200 + warnings 点名',
    r7a.status === 200 && mockRequests.length === 2 &&
    [...clipped].length === 42 && clipped.endsWith('…') &&
    (r7a.body?.warnings ?? []).some((w: string) => /第 4 页 第 1 条 bullet 60 字超出 42 字，重试后仍超限，已裁剪为 42 字/.test(w)),
    { status: r7a.status, asks: mockRequests.length, clippedLen: [...clipped].length, clipped, warnings: r7a.body?.warnings, error: r7a.body?.error });
  // T02223：裁剪只打通服务层字数门，装配层（kickoffBuilder 调 checkPageText）用自己的码点口径——
  // 裁后若仍报「超出 42 字」，等于把越界从服务层搬到版式层（降级页换汤不换药）。
  const clipIssues = LAY.checkPageText({ title: '启动会页 4', bullets: [clipped] });
  const cw = LAY.getContentFrame().w;
  ok('R-07c 裁剪结果过装配层同口径自检（无「超出 42 字」项；行数估算与 42 字合规上界同域）',
    !clipIssues.some((s: string) => /超出 42 字/.test(s)) &&
    LAY.bulletLineCount(clipped, cw, LAY.MIN_BODY_PT) === LAY.bulletLineCount('一'.repeat(42), cw, LAY.MIN_BODY_PT),
    { issues: clipIssues, clipped, lineCount: LAY.bulletLineCount(clipped, cw, LAY.MIN_BODY_PT) });

  // R-07b 标题超长/bullet 超行 → 规范化 + warnings，不硬失败
  const soft = JSON.parse(outlineJson(12)) as any[];
  soft[1].title = '标'.repeat(35);
  soft[1].bullets = Array.from({ length: 9 }, (_, i) => `要点${i + 1}`);
  soft[5].section = '技术架构';
  mockQueue = [{ content: JSON.stringify(soft) }];
  const r7b = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-07b 标题超长/bullet 超行/章节非清单 → 200 + warnings 逐条点名',
    r7b.status === 200 && r7b.body?.outline?.[1]?.title?.length === 30
    && (r7b.body?.warnings ?? []).some((w: string) => /标题 35 字超出 30 字，已截断/.test(w))
    && (r7b.body?.warnings ?? []).some((w: string) => /bullet 9 条超出 6 条，已截断/.test(w))
    && (r7b.body?.warnings ?? []).some((w: string) => /章节「技术架构」不在标准清单/.test(w)),
    { status: r7b.status, warnings: r7b.body?.warnings, error: r7b.body?.error });

  // R-08 缺 timeline 页
  const noTimeline = (JSON.parse(outlineJson(12)) as any[]).map((p) => ({ ...p, dataKeys: p.dataKeys.filter((k: string) => k !== 'timeline') }));
  mockQueue = [{ content: JSON.stringify(noTimeline) }];
  const r8 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-08 缺时间线页 → 400 点名', r8.status === 400 && /缺少时间线页/.test(String(r8.body?.error)), r8.body?.error);

  // R-10 代码围栏 / {"outline":[]} 包装两种形态
  mockQueue = [{ content: '```json\n' + outlineJson(14) + '\n```' }];
  const fenced = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  mockQueue = [{ content: JSON.stringify({ outline: JSON.parse(outlineJson(15)) }) }];
  const wrapped = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-10 围栏输出与 {"outline":[...]} 包装均可收',
    fenced.status === 200 && fenced.body?.outline?.length === 14 && wrapped.status === 200 && wrapped.body?.outline?.length === 15,
    { fenced: fenced.status, wrapped: wrapped.status, e1: fenced.body?.error, e2: wrapped.body?.error });

  // R-11 extraNote 原文进提示词
  mockQueue = [{ content: outlineJson(12) }];
  mockRequests.length = 0;
  await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId, extraNote: '客户强调两周内出原型' });
  ok('R-11 extraNote 原文注入 user 提示词', (mockRequests[0]?.user ?? '').includes('客户强调两周内出原型'), mockRequests[0]?.user?.slice(-120));

  // R-13 白名单外非法转义：清洗后 200 + warning 点名（T02311，mock 离线可测）
  // 构造法：先 JSON.stringify（会把 \d 转义成合法的 \\d），再把文本里的 \\d 换回单反斜杠 \d —— 这才是模型笔误的非法形态
  const arr13 = JSON.parse(outlineJson(12)) as Array<{ bullets: string[] }>;
  arr13[1].bullets[0] = '范围含\\d非法转义'; // JS 串：反斜杠 + d
  mockQueue = [{ content: JSON.stringify(arr13).replace('\\\\d', '\\d') }];
  const r13 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-13 模型输出含白名单外非法转义（\\d）→ 有约束清洗后 200 + warning 点名（不静默改写）',
    r13.status === 200 && r13.body?.outline?.length === 12
    && (r13.body?.warnings ?? []).some((w: string) => /非法转义/.test(w))
    && String(r13.body?.outline?.[1]?.bullets?.[0] ?? '').includes('\\d'),
    { status: r13.status, warnings: r13.body?.warnings, error: r13.body?.error });

  // R-13b 合法转义序列（Windows 路径）不被清洗误伤（T02311 真链路 41981 轮回归：无状态正则曾把
  // 合法的 `D:\\code` 后半个反斜杠误判非法、双写后造出 `\\\c` 把合法 JSON 改崩）
  const arr13b = JSON.parse(outlineJson(12)) as Array<{ bullets: string[] }>;
  arr13b[1].bullets[0] = '工作空间：D:\\code\\otherProjects 已配置'; // JS 串 = D:\code\otherProjects（单反斜杠）
  mockQueue = [{ content: JSON.stringify(arr13b) }];
  const r13b = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-13b 合法转义序列（Windows 路径 \\）原样通过——清洗不把 \\\\ 误判成非法、不误报 warning',
    r13b.status === 200 && r13b.body?.outline?.length === 12
    && String(r13b.body?.outline?.[1]?.bullets?.[0] ?? '').includes('D:\\code')
    && !(r13b.body?.warnings ?? []).some((w: string) => /非法转义/.test(w)),
    { status: r13b.status, warnings: r13b.body?.warnings, bullet: r13b.body?.outline?.[1]?.bullets?.[0] });

  // R-14 清洗修不了的非法转义（\u 后非四位 hex）：400 报错带位置上下文切片 + 厂商原始响应落档非空（T02311）
  const arr14 = JSON.parse(outlineJson(12)) as Array<{ bullets: string[] }>;
  arr14[1].bullets[0] = '范围含\\u00不完整转义'; // JS 串：反斜杠 + u + 0 + 0（u 在白名单内不清洗，parse 必失败）
  mockQueue = [{ content: JSON.stringify(arr14).replace('\\\\u00', '\\u00') }];
  const r14 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  const rawFiles = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => f.startsWith('kickoff-outline-raw-')).sort() : [];
  const rawNonEmpty = rawFiles.length > 0 && statSync(join(DATA_DIR, rawFiles[rawFiles.length - 1])).size > 0;
  ok('R-14 清洗修不了的非法转义 → 400 报错含位置上下文切片与留档文件名 + 数据目录内 raw 旁证非空',
    r14.status === 400 && /报错上下文/.test(String(r14.body?.error)) && /厂商原始响应已留档/.test(String(r14.body?.error)) && rawNonEmpty,
    { status: r14.status, error: String(r14.body?.error).slice(0, 160), rawFiles });

  // R-15 重试提示词注入首轮具体违规原因（T02314：真链路连续三轮栽在「有 timeline 版式无 timeline 数据键」）
  const noTl = (JSON.parse(outlineJson(12)) as any[]).map((p, i) => (i === 6 ? { ...p, dataKeys: p.dataKeys.filter((k: string) => k !== 'timeline') } : p));
  mockQueue = [{ content: JSON.stringify(noTl) }, { content: outlineJson(12) }];
  mockRequests.length = 0;
  const r15 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-15 首轮缺时间线页 → 重试提示词原样回喂该原因且二轮出合规稿（200 + 12 页）',
    r15.status === 200 && r15.body?.outline?.length === 12
    && mockRequests.length === 2
    && /缺少时间线页/.test(String(mockRequests[1]?.system ?? ''))
    && /必须逐条修正/.test(String(mockRequests[1]?.system ?? '')),
    { status: r15.status, asks: mockRequests.length, retrySysTail: String(mockRequests[1]?.system ?? '').slice(-160), error: r15.body?.error });

  // R-12 参数校验
  const noTool = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID });
  const noPid = await call('POST', '/plans/kickoff-ppt-outline', { toolId: mockId });
  ok('R-12 projectId/toolId 缺失各自 400 点名', noTool.status === 400 && /toolId 必填/.test(String(noTool.body?.error)) && noPid.status === 400 && /projectId 必填/.test(String(noPid.body?.error)),
    { noTool: noTool.body, noPid: noPid.body });

  // R-09 硬阻塞项目：400 拒生成 + 零 AI 请求
  const newProj = await call('POST', '/projects', { name: `T02096 空项目 ${Date.now()}` });
  mockQueue = [{ content: outlineJson(12) }];
  mockRequests.length = 0;
  const blocked = await call('POST', '/plans/kickoff-ppt-outline', { projectId: String(newProj.body?.id ?? ''), toolId: mockId });
  ok('R-09 硬阻塞项目 → 400 点名 P1~P3 且零 mock 请求（校验阶段不烧配额）',
    blocked.status === 400 && /资料不足，不能生成启动会稿：P1、P2、P3 全部缺失/.test(String(blocked.body?.error)) && mockRequests.length === 0,
    { status: blocked.status, error: blocked.body?.error, asks: mockRequests.length });

  // =====================================================================
  // S 组（T02293 改判）：契约守卫——源码字面锚点只作 okPair 的字面侧，行为侧走
  // 隔离实例 HTTP 响应 / mock 端收到的提示词工件 / 进程内纯函数返回值。
  // 夹具全部由门自建（判据 2）：两个新项目 + 门内长/短 PRD + 门内风险/干净计划组合。
  // =====================================================================
  lines.push('');
  lines.push('== S 组：契约守卫（字面锚点 + 同义行为断言）');

  const stamp = Date.now();
  const DAY = 86_400_000;
  const dstr = (off: number) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
  const mkProject = async (label: string): Promise<string> => String((await call('POST', '/projects', { name: `T02096 S组${label} ${stamp}` })).body?.id ?? '');
  const SENT = { head: '【门内首标SENTINELHEAD】', mid: '【门内中段禁入SENTINELMIDDLE】', tail: '【门内尾标SENTINELTAIL】' };
  const filler = (n: number, mark: string) => Array.from({ length: n }, (_, i) => `${mark}${i}：本节写明启动会稿的口径来源与验收标准，用来把门内文档撑到摘要预算之外。`).join('\n');
  const longPrd = `${SENT.head}\n${filler(200, '甲')}\n${SENT.mid}\n${filler(200, '乙')}\n${SENT.tail}\n`;
  const shortPrd = `${SENT.head}\n${filler(6, '丙')}\n${SENT.mid}\n${SENT.tail}\n`;

  // 风险夹具：四类信号各埋一条（阻塞态 / 进度落后 / 需求无承载 / 复杂度≥4）+ 超预算 PRD
  const fxRisk = await mkProject('风险夹具');
  await call('POST', '/plans/import-prd', {
    projectId: fxRisk, prdMd: longPrd, prdFilename: `T02096-门内长PRD-${stamp}.md`,
    requirements: [
      { reqNo: 'REQ-901', title: '门内需求甲（有承载）', priority: 'high' },
      { reqNo: 'REQ-902', title: '门内需求乙（有承载）', priority: 'normal' },
      { reqNo: 'REQ-903', title: '门内需求丙（无承载）', priority: 'normal' },
    ],
    plans: [
      { title: '门内阻塞计划', durationDays: 5, startDate: dstr(-30), reqNos: ['REQ-901'], status: 'blocked', complexity: 2 },
      { title: '门内落后计划', durationDays: 10, startDate: dstr(-60), reqNos: ['REQ-902'], status: 'doing', complexity: 3 },
      { title: '门内重复杂度计划', durationDays: 8, startDate: dstr(5), complexity: 5, status: 'todo' },
      { title: '门内里程碑', durationDays: 20, startDate: dstr(10), kind: 'milestone' },
    ],
  });
  // 干净夹具：四类信号一条都不埋 + PRD 在预算内（兜底分支与「不截断」的反证材料）
  const fxClean = await mkProject('干净夹具');
  await call('POST', '/plans/import-prd', {
    projectId: fxClean, prdMd: shortPrd, prdFilename: `T02096-门内短PRD-${stamp}.md`,
    requirements: [
      { reqNo: 'REQ-911', title: '门内需求一', priority: 'high' },
      { reqNo: 'REQ-912', title: '门内需求二', priority: 'normal' },
      { reqNo: 'REQ-913', title: '门内需求三', priority: 'normal' },
    ],
    plans: [
      { title: '门内正常计划甲', durationDays: 5, startDate: dstr(3), reqNos: ['REQ-911'], complexity: 2, status: 'todo' },
      { title: '门内正常计划乙', durationDays: 5, startDate: dstr(8), reqNos: ['REQ-912'], complexity: 3, status: 'todo' },
      { title: '门内正常计划丙', durationDays: 5, startDate: dstr(13), reqNos: ['REQ-913'], complexity: 2, status: 'todo' },
    ],
  });
  ok('S-00a 门内夹具落位（两个项目 + 长 PRD 超预算、短 PRD 在预算内）',
    !!fxRisk && !!fxClean && longPrd.length > 6000 && shortPrd.length < 6000,
    { fxRisk, fxClean, longLen: longPrd.length, shortLen: shortPrd.length });

  /** 走一次大纲生成，顺带取回 mock 端真正收到的提示词工件 */
  const askOutline = async (projectId: string, content: string, extra?: Record<string, unknown>) => {
    mockQueue = [{ content }];
    mockRequests.length = 0;
    const res = await call('POST', '/plans/kickoff-ppt-outline', { projectId, toolId: mockId, ...(extra ?? {}) });
    return { res, asks: mockRequests.length, sys: mockRequests[0]?.system ?? '', user: mockRequests[0]?.user ?? '', retrySys: mockRequests[1]?.system ?? '' };
  };
  const riskRound = await askOutline(fxRisk, outlineJson(13));
  const cleanRound = await askOutline(fxClean, outlineJson(13));
  // 重试轮的 system 只有「首轮不合格」才收得到：单独造一次坏输出
  const retryRound = await askOutline(fxRisk, outlineJson(5));

  // ---------- S-01 前置校验只读零 AI ----------
  mockRequests.length = 0;
  const pfRisk = await call('GET', `/plans/kickoff-preflight?projectId=${fxRisk}`);
  const pfClean = await call('GET', `/plans/kickoff-preflight?projectId=${fxClean}`);
  okPair(ok, 'S-01 前置校验段零 AI 依赖（FR-2.3 只读、零配额）',
    () => {
      const items = pfRisk.body?.items ?? [];
      return pfRisk.status === 200 && items.length === 7 && items.every((i: any) => ['ok', 'warn', 'fail'].includes(i.status))
        && pfClean.body?.blocked === false && pfRisk.body?.blocked === false
        && JSON.stringify(items.map((i: any) => i.key)) === JSON.stringify(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'])
        && mockRequests.length === 0;
    },
    () => !/AIService|askJson|fetch\(/.test(preflightSrc),
    () => ({ items: (pfRisk.body?.items ?? []).map((i: any) => `${i.key}=${i.status}`), blocked: pfRisk.body?.blocked, asks: mockRequests.length }));

  // ---------- S-02 校验在 parse 回调内：不合格即触发自带重试 ----------
  const badShape = await askOutline(fxRisk, outlineJson(6));
  const goodShape = await askOutline(fxRisk, outlineJson(13));
  okPair(ok, 'S-02 schema 校验在 askJson 的 parse 回调内（不合格即触发自带重试；第 2 轮才转软截断；失败留档）',
    () => badShape.res.status === 400 && badShape.asks === 2 && goodShape.res.status === 200 && goodShape.asks === 1
      && /AI 未返回合规大纲/.test(String(badShape.res.body?.error)) && /不在 12~18 区间/.test(String(badShape.res.body?.error))
      && /不在 12~18 区间/.test(String(badShape.retrySys)) && /必须逐条修正/.test(String(badShape.retrySys)),
    () => /askJson[\s\S]{0,600}parseRound\+\+[\s\S]{0,400}validateOutline\(parseOutlinePayload\(content(, cleanHits)?\), \{ lenientDataKeys: parseRound > 1, lenientBullets: parseRound > 1 \}\)/.test(outlineSrc),
    () => ({ badAsks: badShape.asks, goodAsks: goodShape.asks, err: badShape.res.body?.error, retrySys: String(badShape.retrySys).slice(0, 120) }));

  // ---------- S-03 页数区间与必含页：纯函数 + HTTP 双取 ----------
  const verdict = (raw: unknown) => {
    try { SVC.validateOutline(raw); return 'accepted'; }
    catch (e) { return `rejected:${(e as Error).message.slice(0, 28)}`; }
  };
  const bandChecks: string[] = [];
  for (const [pages, want] of [[12, true], [18, true], [11, false], [19, false]] as const) {
    const v = verdict(JSON.parse(outlineJson(pages)));
    if (want !== (v === 'accepted')) bandChecks.push(`纯函数侧 ${pages} 页判成 ${v}`);
    const r = await askOutline(fxRisk, outlineJson(pages));
    if ((r.res.status === 200) !== want) bandChecks.push(`HTTP 侧 ${pages} 页回 ${r.res.status}（期望 ${want ? '200' : '400'}）`);
    if (!want && !/不在 12~18 区间/.test(String(r.res.body?.error))) bandChecks.push(`${pages} 页的 400 没点名页数区间：${r.res.body?.error}`);
  }
  const noTlKeys = (arr: any[]) => arr.map((p) => ({ ...p, dataKeys: p.dataKeys.filter((k: string) => k !== 'timeline') }));
  const noWlKeys = (arr: any[]) => arr.map((p) => ({ ...p, dataKeys: p.dataKeys.filter((k: string) => k !== 'workload') }));
  const mustChecks: string[] = [];
  for (const [name, mutate, needle] of [
    ['缺时间线页', noTlKeys, '缺少时间线页'],
    ['缺工作量页', noWlKeys, '缺少工作量页'],
  ] as const) {
    const pure = verdict(mutate(JSON.parse(outlineJson(13))));
    if (!pure.includes(needle)) mustChecks.push(`${name}：纯函数侧判成 ${pure}`);
    const r = await askOutline(fxRisk, JSON.stringify(mutate(JSON.parse(outlineJson(13)))));
    if (r.res.status !== 400 || !String(r.res.body?.error).includes(needle)) mustChecks.push(`${name}：HTTP 侧回 ${r.res.status} / ${r.res.body?.error}`);
  }
  okPair(ok, 'S-03 页数 12~18 与必含 timeline/workload 硬失败并点名',
    () => bandChecks.length === 0 && mustChecks.length === 0,
    () => /页数 \$\{raw\.length\} 不在/.test(outlineSrc) && /缺少时间线页/.test(outlineSrc) && /缺少工作量页/.test(outlineSrc),
    () => ({ bandChecks, mustChecks }));

  // ---------- S-04 数字铁律真的交付给了模型（首轮 + 重试轮都收到） ----------
  okPair(ok, 'S-04 数字铁律写进 system 提示（数字只走 dataKeys，禁止模型自填）',
    () => /一律只写 dataKeys 引用/.test(riskRound.sys) && /严禁自行写数字或改写数字/.test(riskRound.sys)
      && /数字一律用 dataKeys 表示，禁止编造数字/.test(retryRound.retrySys)
      && (riskRound.res.body?.outline ?? []).every((p: any) => Array.isArray(p.dataKeys) && p.dataKeys.length > 0),
    () => /一律只写 dataKeys 引用/.test(outlineSrc) && /严禁自行写数字或改写数字/.test(outlineSrc),
    () => ({ 首轮含铁律: /严禁自行写数字/.test(riskRound.sys), 重试轮含铁律: /禁止编造数字/.test(retryRound.retrySys), 重试轮: retryRound.retrySys.slice(0, 80) }));

  // ---------- S-05 toolId 必填 + 不静默回落 ----------
  const noToolId = await call('POST', '/plans/kickoff-ppt-outline', { projectId: fxRisk });
  mockQueue = [{ content: outlineJson(13) }];
  mockRequests.length = 0;
  const noModelCall = await call('POST', '/plans/kickoff-ppt-outline', { projectId: fxRisk, toolId: noModelId });
  const noModelAsks = mockRequests.length;
  const withTool = await call('POST', '/plans/kickoff-ppt-outline', { projectId: fxRisk, toolId: mockId });
  okPair(ok, 'S-05 大纲端点不静默回落模型：toolId 必填 + 400 原样透传错误',
    () => noToolId.status === 400 && /toolId 必填/.test(String(noToolId.body?.error))
      && noModelCall.status === 400 && /所选模型未配置/.test(String(noModelCall.body?.error)) && noModelAsks === 0
      && withTool.status === 200,
    () => /toolId 必填（大纲生成需要模型工具）/.test(routeSrc) && /kickoffOutline\(projectId, toolId/.test(routeSrc),
    () => ({ noToolId: noToolId.body?.error, noModel: noModelCall.body?.error, noModelAsks, withTool: withTool.status }));

  // ---------- S-06 硬阻塞服务端二次拦截（绕过面板直接调用同样拒） ----------
  const fxEmpty = await mkProject('空夹具');
  const pfEmpty = await call('GET', `/plans/kickoff-preflight?projectId=${fxEmpty}`);
  const blockedRound = await askOutline(fxEmpty, outlineJson(13));
  okPair(ok, 'S-06 硬阻塞在服务端二次拦截（UI 置灰不是保险）',
    () => pfEmpty.body?.blocked === true && JSON.stringify(pfEmpty.body?.missingHard) === JSON.stringify(['P1', 'P2', 'P3'])
      && blockedRound.res.status === 400 && /资料不足，不能生成启动会稿/.test(String(blockedRound.res.body?.error))
      && blockedRound.asks === 0 && riskRound.res.status === 200,
    () => /bundle\.preflight\.blocked/.test(outlineSrc) && /资料不足，不能生成启动会稿/.test(outlineSrc),
    () => ({ missingHard: pfEmpty.body?.missingHard, err: blockedRound.res.body?.error, asks: blockedRound.asks }));

  // ---------- S-07 降级工期排除里程碑（纯函数） ----------
  const mkP = (i: number, days: number, kind = 'normal') => ({
    id: `q${i}`, project_id: 'p1', title: `门内任务 ${i}`, kind, duration_days: days,
    start_date: '2026-01-05', end_date: '2026-01-12', progress: 0, status: 'todo', assignee: '', complexity: 3,
  }) as any;
  const sumNoEst = (over: Record<string, unknown> = {}) => ({ countedKeys: [], phases: [], directManDays: { expected: 0, optimistic: null, pessimistic: null }, config: { manDaysPerManMonth: 20.83 }, quote: { p50ManDays: 0, p84ManDays: 0 }, ...over } as any);
  const pfOk = { items: [{ key: 'P6', status: 'ok' }] } as any;
  const mixed = SVC.workloadOf(sumNoEst(), [mkP(1, 10), mkP(2, 8), mkP(3, 20, 'milestone')], pfOk);
  okPair(ok, 'S-07 降级工期排除里程碑（T01001 里程碑工期=子任务之和，重复累加会翻倍）',
    () => mixed.source === 'duration' && mixed.manDays.expected === 18 && mixed.counted === 2
      && SVC.workloadOf(sumNoEst(), [mkP(1, 10, 'milestone'), mkP(2, 20, 'milestone')], pfOk).noData === true,
    () => /p\.kind !== 'milestone'/.test(bundleSrc),
    () => ({ expected: mixed.manDays.expected, counted: mixed.counted }));

  // ---------- S-08 人月因子取估算配置（不写死 20.83） ----------
  const mmAt = (factor: number) => SVC.workloadOf({ countedKeys: ['k1'], directManDays: { expected: 96, optimistic: 78, pessimistic: 132 }, config: { manDaysPerManMonth: factor }, quote: { p50ManDays: 96, p84ManDays: 118 }, phases: [] } as any, [mkP(1, 10)], pfOk);
  const mm1 = mmAt(20.83);
  const mm2 = mmAt(24);
  okPair(ok, 'S-08 人月换算因子取估算配置，kickoff 内不重复定义 20.83',
    () => Math.abs(mm1.manMonth - Math.round((96 / 20.83) * 100) / 100) < 1e-9
      && Math.abs(mm2.manMonth - 4) < 1e-9 && mm2.manMonth !== mm1.manMonth
      && mm1.manDaysPerManMonth === 20.83 && mm2.manDaysPerManMonth === 24,
    () => /toManMonth\(/.test(svcSrc) && !/20\.83/.test(svcSrc),
    () => ({ 因子20_83: mm1.manMonth, 因子24: mm2.manMonth }));

  // ---------- S-09 PRD 摘要预算：保头保尾截断落在真实交付的提示词上 ----------
  const riskSummary = riskRound.user.split('【PRD 摘要】')[1] ?? '';
  const cleanSummary = cleanRound.user.split('【PRD 摘要】')[1] ?? '';
  okPair(ok, 'S-09 PRD 摘要预算 6000 保头保尾（同 prdContext 策略，不跨模块改私有符号）',
    () => riskSummary.includes(SENT.head) && riskSummary.includes(SENT.tail) && !riskSummary.includes(SENT.mid)
      && /中段略去 \d+ 字符，全文见 PRD 文档/.test(riskSummary)
      && riskRound.res.body?.truncated === true
      && (riskRound.res.body?.warnings ?? []).some((w: string) => /PRD 摘要超出/.test(w))
      && riskSummary.length < longPrd.length / 2,
    () => /KICKOFF_PRD_LIMIT = 6000/.test(bundleSrc) && /中段略去/.test(bundleSrc),
    () => ({ 全文: longPrd.length, 摘要: riskSummary.length, 略去: /中段略去 (\d+) 字符/.exec(riskSummary)?.[1], truncated: riskRound.res.body?.truncated }));

  // ---------- S-10 风险四类本地枚举齐 + 无命中兜底 ----------
  const RISK_MARKS = ['阻塞态', '进度落后', '未关联任何计划', '复杂度 ≥4'];
  const riskLine = /本地风险信号：(\d+) 条（(.*)）/.exec(riskRound.user) ?? [];
  const cleanLine = /本地风险信号：(\d+) 条（(.*)）/.exec(cleanRound.user) ?? [];
  const riskChecks: string[] = [];
  for (const m of RISK_MARKS) if (!riskLine[2]?.includes(m)) riskChecks.push(`风险夹具的提示词里没有「${m}」这一类信号`);
  if (!(Number(riskLine[1]) >= 4)) riskChecks.push(`风险条数只有 ${riskLine[1]}（四类应各命中）`);
  if (!cleanLine[2]?.includes('系统内暂无风险信号')) riskChecks.push(`干净夹具没走兜底分支：${cleanLine[2]}`);
  if (RISK_MARKS.some((m) => cleanLine[2]?.includes(m))) riskChecks.push('干净夹具仍报出实信号（枚举规则没跟着夹具走）');
  okPair(ok, 'S-10 风险四类本地枚举齐（blocked/进度落后/需求无关联/复杂度≥4）+ 无命中兜底',
    () => riskChecks.length === 0 && riskRound.res.status === 200 && cleanRound.res.status === 200,
    () => /status === 'blocked'/.test(bundleSrc) && /expectedProgress\(/.test(bundleSrc) && /linkedPlans\.length === 0/.test(bundleSrc)
      && /RISK_COMPLEXITY_MIN/.test(bundleSrc) && /系统内暂无风险信号/.test(bundleSrc),
    () => ({ riskChecks, 风险条: riskLine[2]?.slice(0, 200), 干净条: cleanLine[2]?.slice(0, 80) }));

  // ---------- S-11 大纲路由注册在 /:id 之前（字面路径可直达，参数路由仍活） ----------
  const fxPlans = await call('GET', `/plans?projectId=${fxRisk}`);
  const onePlanId = String(fxPlans.body?.[0]?.id ?? '');
  const patched = await call('PATCH', `/plans/${onePlanId}`, { title: `门内改名计划 ${stamp}` });
  const plansAfter = await call('GET', `/plans?projectId=${fxRisk}`);
  const ghostPath = await call('POST', '/plans/kickoff-ppt-outline-not-a-route', { projectId: fxRisk, toolId: mockId });
  okPair(ok, 'S-11 大纲路由注册在 /:id 之前',
    () => noToolId.status === 400 && /toolId 必填/.test(String(noToolId.body?.error))
      && patched.status === 200 && plansAfter.body?.some((p: any) => p.title === `门内改名计划 ${stamp}`)
      && ghostPath.status !== 400 && !/toolId 必填/.test(String(ghostPath.body?.error ?? '')),
    () => routeSrc.indexOf('/kickoff-ppt-outline') < routeSrc.indexOf("planApi.patch('/:id'"),
    () => ({ literal: noToolId.status, patch: patched.status, ghost: ghostPath.status }));

  // ---------- S-12 时间线口径在两处提示词均按 dataKeys 写明且带否定示例 ----------
  const layoutOnly = JSON.parse(outlineJson(13)) as any[];
  layoutOnly[6].dataKeys = ['planRows']; // layout 仍是 'timeline'，但键被摘掉——T02314 的常见错形
  const layoutOnlyRound = await askOutline(fxRisk, JSON.stringify(layoutOnly));
  okPair(ok, 'S-12 时间线页要求在两处提示词均按 dataKeys 口径写明且带否定示例（T02314）',
    () => /必须至少一页 dataKeys 含 "timeline"/.test(riskRound.sys) && /把 layout 设成 "timeline" 但 dataKeys 里没有/.test(riskRound.sys)
      && /必须至少一页 dataKeys 含 "timeline"（只把 layout 设成 'timeline' 而 dataKeys 里没这个键不算/.test(retryRound.retrySys)
      && layoutOnlyRound.asks === 2 && /缺少时间线页/.test(layoutOnlyRound.retrySys)
      && layoutOnlyRound.res.status === 400 && /缺少时间线页/.test(String(layoutOnlyRound.res.body?.error))
      && riskRound.res.status === 200,
    () => /必须至少一页 dataKeys 含 "timeline"/.test(outlineSrc)
      && /只把 layout 设成 'timeline' 而 dataKeys 里没这个键不算/.test(outlineSrc)
      && /必须至少一页 dataKeys 含 "timeline"（只把 layout 设成 'timeline'/.test(outlineSrc),
    () => ({ 首轮示例: /把 layout 设成 "timeline"/.test(riskRound.sys), 重试轮示例: /没这个键不算/.test(retryRound.retrySys), 回喂: layoutOnlyRound.retrySys.slice(-120), layoutOnly: layoutOnlyRound.res.body?.error }));

  // =====================================================================
  // X 组：单源表改名模拟（判据 3~4）
  // =====================================================================
  lines.push('');
  lines.push('== X 组：单源表改名模拟');
  {
    /**
     * X-01 数据键单源表的改名模拟：`SVC.KICKOFF_DATA_KEYS` 是合法键集与提示词枚举的同源表。
     *  ① 同源自证（跨进程）：服务真正交付给模型的那行键枚举，逐字等于门内读到的导出表——
     *     服务侧若另抄一份键清单，这一条先红；
     *  ② 改名模拟（进程内）：把 'assignees' 改名后合法键集随表移动（新键被接受、旧键判未知项），
     *     还原后判定逐字复位。
     */
    const keys = SVC.KICKOFF_DATA_KEYS as unknown as string[];
    const idx = keys.indexOf('assignees');
    const xf: string[] = [];
    const enumLine = (sys: string) => sys.split('\n').find((l) => l.startsWith('4. dataKeys 只能取：')) ?? '';
    const baseRound = await askOutline(fxRisk, outlineJson(13));
    const delivered = enumLine(baseRound.sys).replace('4. dataKeys 只能取：', '').split('；')[0].trim();
    if (delivered !== keys.join(' / ')) xf.push(`交付给模型的键枚举与导出单源表不一致（第二来源）：${delivered.slice(0, 160)}`);
    if (idx < 0) xf.push('KICKOFF_DATA_KEYS 里没有 assignees（表形态变了，模拟需重新接线）');
    else {
      const orig = keys[idx];
      const renamed = 'ZZZ-assignees';
      const verdictKey = (k: string) => {
        try { SVC.assertOutlineShape([{ section: '项目团队介绍', title: 't', bullets: [], dataKeys: [k], layout: 'list' }]); return 'accepted'; }
        catch { return 'rejected'; }
      };
      const beforeOld = verdictKey(orig);
      const beforeNew = verdictKey(renamed);
      try {
        keys[idx] = renamed;
        if (verdictKey(renamed) !== beforeOld) xf.push(`新键没被同口径接受（${beforeOld} → ${verdictKey(renamed)}）`);
        if (verdictKey(orig) !== beforeNew) xf.push(`旧键改名后判定没变（合法键集没随单源表移动）：${verdictKey(orig)}`);
      } finally {
        keys[idx] = orig;
      }
      if (verdictKey(orig) !== beforeOld) xf.push('还原后合法键判定与初始不一致');
      if (enumLine((await askOutline(fxRisk, outlineJson(13))).sys) !== enumLine(baseRound.sys)) xf.push('还原后提示词键枚举行与初始不逐字相同');
    }
    ok(`X-01 数据键单源表改名模拟：交付枚举行逐字等于导出表、合法键集随表移动、旧键失效、还原复位`, xf.length === 0, xf);

    /**
     * X-02 真实计数通道的改名模拟：需求/计划条数与样例名称是产品把库内事实送进提示词的唯一通道。
     * 通道内容改了（门内改名 / 门内补一条需求），提示词必须整体跟着改、旧名称零残留。
     */
    const factsOf = (user: string) => (user.split('【PRD 摘要】')[0] ?? '');
    const baseFacts = factsOf(riskRound.user);
    const chf: string[] = [];
    const reqCount = (f: string) => Number(/需求 (\d+) 条/.exec(f)?.[1] ?? -1);
    const before = reqCount(baseFacts);
    const listBefore = await call('GET', `/plans/prd-requirements?projectId=${fxRisk}`);
    if (before !== (listBefore.body?.length ?? -1)) chf.push(`基线提示词的「需求 N 条」(${before}) 与端点条数 (${listBefore.body?.length}) 不一致`);
    await call('POST', '/plans/prd-requirements', { projectId: fxRisk, reqNo: 'REQ-904', title: '门内补录需求丁' });
    const afterR = await askOutline(fxRisk, outlineJson(13));
    const afterFacts = factsOf(afterR.user);
    if (reqCount(afterFacts) !== before + 1) chf.push(`补一条需求后提示词条数没跟上（${before} → ${reqCount(afterFacts)}）`);
    if (!afterFacts.includes('门内补录需求丁')) chf.push('新需求名称没进样例事实（计数通道动了、名称通道没动）');
    const renamed = await askOutline(fxRisk, outlineJson(13));
    if (!factsOf(renamed.user).includes(`门内改名计划 ${stamp}`)) chf.push('计划改名后提示词的样例名称没跟上');
    if (factsOf(renamed.user).includes('门内阻塞计划')) {
      chf.push('计划改名后提示词仍残留旧名称「门内阻塞计划」——名称通道另有抄本');
    }
    ok(`X-02 真实计数通道改名模拟：条数与名称逐一动到交付提示词上（+1 计数、新名称到位、旧名称零残留）`, chf.length === 0, chf);
  }

  // =====================================================================
  // N 组：负对照（判据 4）
  // =====================================================================
  lines.push('');
  lines.push('== N 组：负对照（证明判据有牙）');
  {
    const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    const sOk = (name: string, cond: boolean, extra?: unknown) => spy.push({ name, cond, extra });

    // N-01 假夹具：源码那句「严禁自行写数字」在（字面绿），但它没被交付给模型（行为红）
    okPair(sOk, 'N-01 假夹具：铁律在源码里、没发到模型端，配对必须判红',
      () => /严禁自行写数字/.test(retryRound.sys) && retryRound.sys.length > 0 && mockRequests.length === 0,
      () => /严禁自行写数字或改写数字/.test(outlineSrc),
      () => ({ 说明: '只看源码正则会把「写了但没发」放行' }));
    ok('N-01 负对照落地：只看字面会放行，配对判红且红因是「行为失守」',
      spy.length === 1 && spy[0].cond === false && JSON.stringify(spy[0].extra).includes('行为失守'), spy);

    // N-02 红因可区分：行为绿、锚点被等价重构换掉 → 红因必须是「字面锚点失配」
    okPair(sOk, 'N-02 红因区分样：行为绿、锚点失配',
      () => riskRound.res.status === 200,
      () => /KICKOFF_PRD_LIMIT = 8888/.test(bundleSrc));
    ok('N-02 负对照落地：两种红各带自己的红因，不都读成「功能挂了」',
      spy.length === 2 && spy[1].cond === false && JSON.stringify(spy[1].extra).includes('字面锚点失配'), spy[1]);

    // N-03 PRD 预算判据有牙：预算内的门内 PRD 不截断（否则 S-09 的标记判据是恒绿的）
    ok('N-03 摘要截断判据有牙：短 PRD 夹具全文入提示词、无略去标记、truncated 为假',
      cleanSummary.includes(SENT.mid) && !/中段略去/.test(cleanSummary) && cleanRound.res.body?.truncated === false,
      { 摘要长: cleanSummary.length, truncated: cleanRound.res.body?.truncated });

    // N-04 重试判据有牙：合规稿只发 1 次，坏稿发 2 次（重试不是常驻）
    ok('N-04 自动重试判据有牙：合规稿 1 请求、不合规稿 2 请求且第二轮带回喂原因',
      goodShape.asks === 1 && badShape.asks === 2 && badShape.retrySys.length > 0,
      { goodAsks: goodShape.asks, badAsks: badShape.asks });

    // N-05 里程碑排除判据有牙：同一批行改成 normal 后 Σ 必须随之变大（排除不是恒等式）
    const asNormal = SVC.workloadOf(sumNoEst(), [mkP(1, 10), mkP(2, 8), mkP(3, 20)], pfOk);
    ok('N-05 里程碑排除判据有牙：同批行 kind 换成 normal 后 Σ 工期含进 20（208 侧对照）',
      asNormal.manDays.expected === 38 && asNormal.manDays.expected !== mixed.manDays.expected,
      { normal: asNormal.manDays.expected, mixed: mixed.manDays.expected });

    // N-06 人月因子判据有牙：因子换 24 后人月必换（写死 20.83 就不会动）
    const mm3 = mmAt(12);
    ok('N-06 人月换算判据有牙：因子 12/20.83/24 三档人月各不相同且等于 96/因子',
      mm3.manMonth === Math.round((96 / 12) * 100) / 100 && new Set([mm3.manMonth, mm1.manMonth, mm2.manMonth]).size === 3,
      { f12: mm3.manMonth, f20_83: mm1.manMonth, f24: mm2.manMonth });

    // N-07 阻塞拦截判据有牙：同一端点对门内齐备项目放行（拦截不是逢请求即拒）
    ok('N-07 硬阻塞判据有牙：空夹具 400 且零 AI 请求、齐备夹具 200',
      blockedRound.res.status === 400 && blockedRound.asks === 0 && riskRound.res.status === 200 && riskRound.asks === 1,
      { blocked: blockedRound.res.status, blockedAsks: blockedRound.asks, ready: riskRound.res.status });

    // N-08 路由判据有牙：字面路径直达 400 点名，伪路径不被大纲路由吞（否则 S-11 判据恒绿）
    ok('N-08 路由判据有牙：toolId 缺失走大纲路由点名，伪路径不返回该点名',
      noToolId.status === 400 && /toolId 必填/.test(String(noToolId.body?.error)) && !/toolId 必填/.test(String(ghostPath.body?.error ?? '')),
      { noToolId: noToolId.body?.error, ghost: ghostPath.status, ghostBody: ghostPath.body?.error });
  }

  writeFileSync(gateArtifactPath(join(ROOT, '.workbuddy'), 't02096-outline-sample.json'), JSON.stringify(good.body, null, 2), 'utf8');
}

try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
mock.close();
const summary = `T02096 大纲生成与校验门：PASS=${pass} FAIL=${fail}\n` + lines.join('\n') + '\n';
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeGateResults(join(ROOT, '.workbuddy'), 't02096-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
for (let i = 0; i < 5; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
}
process.exit(fail === 0 ? 0 : 1);
