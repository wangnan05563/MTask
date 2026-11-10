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
 *                  数据面 = 门内自建「主夹具」项目（五维样例事实 + 超摘要预算的门内 PRD），
 *                  判据 2 起不再复制生产库、不再硬编码生产 projectId——门红只可能是功能坏，
 *                  不会是「生产库里那几条业务行变了」。
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
 *     R-13 同一 dataKey 跨页重复 → 200 + 后续页去重 + warning 点名（T05066 / T02156 遗留③）。
 *
 * 用法（与 T02095/T02126/T02131 同口径，better-sqlite3 需匹配当前 Node ABI）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02096-kickoff-outline.mts
 * 环境变量：`T02096_PORT`（默认随机 39700+rand300）。
 * 隔离纪律（skill 红线 8）：库副本/端口/临时目录全临时，跑完 kill + 回收。
 * 结果落 .workbuddy/t02096-gate-results-<运行标识>.txt（GBK 控制台乱码，以文件为权威）。
 */
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { waitIsolatedServer, bootEvidence } from '../lib/gate-boot.mts'; // T02965：就绪判据单源
import { createServer } from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults, gateArtifactPath } from '../lib/gate-results.mts';
import { okPair } from '../lib/anchor-pair.mts'; // T02293 判据 3：字面锚点必须配同义行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.T02096_PORT ?? 39_700 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02096-outline-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const SECTIONS = ['封面', '议程', '项目团队介绍', '项目背景', '项目需求', '项目范围', '项目计划', '工作量评估', '测试与质量策略', '项目风险', '沟通管理', '附录', '正文'];

// T02965：原 FIVE_PID 指生产项目，空库隔离实例里没有该行 → 改为门内自建（判据 2）。
let FIVE_PID = '';

const { resolveServerLauncher } = await import('../isolated-server-launcher.mts');
// T02223：装配层同口径自检（裁剪后不得再触发「超出 42 字」越界）——直接引 layout 单源，不经 HTTP
const LAY = await import('../../server/src/services/kickoff-layout.ts');
// T02293：S 组的行为侧走进程内纯函数（workloadOf / validateOutline / assertOutlineShape）——只读导出，不碰库
const SVC = await import('../../server/src/services/kickoffService.ts');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

// =====================================================================
// 字面锚点专用料（判据 3：源码正则只作 okPair 的字面侧，行为侧见文件末尾「S 组：契约守卫」）
// 取证面 = **已提交树**（反模式 11）：读工作树可能读到并发会话留下的过期产品文件，
// 红因会指错地方。行为腿不受影响——它跑的是 tsx 直接 import 的同一份模块。
// =====================================================================
const HEAD_CACHE = new Map<string, string>();
function headSrc(rel: string): string {
  if (!HEAD_CACHE.has(rel)) {
    let t = '';
    try {
      t = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
    } catch (e) {
      lines.push(`[WARN] git show HEAD:${rel} 取证失败：${(e as Error).message.slice(0, 140)}`);
    }
    HEAD_CACHE.set(rel, t);
  }
  return HEAD_CACHE.get(rel) as string;
}
const svcSrc = headSrc('server/src/services/kickoffService.ts');
const routeSrc = headSrc('server/src/routes/plans.ts');
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
// R 组：隔离实例（空数据目录 + 门内自建夹具；判据 2 起不复制生产库）
// =====================================================================
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
// 起服务前数据目录必须是空的：这条是「门没把生产库搬进来」的自证——
// 一旦有人重新接上 src.backup(copyPath)，此处立刻红。
ok('R-00a 隔离数据目录为空（无生产库副本，门内夹具稍后自建）', readdirSync(DATA_DIR).length === 0, readdirSync(DATA_DIR));

const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUp(): Promise<boolean> {
  // T02965：原实现只判 service，未就绪时无 upMs/预算/轮询次数读数——读者分不清「环境慢」与「判据失守」（判据 4）
  const b = await waitIsolatedServer({ base: BASE.replace(/\/api$/, ''), budgetMs: 180_000, envName: 'T02096_BOOT_BUDGET' });
  if (!b.up) console.log(`  · 就绪失败读数：${bootEvidence(b)}`);
  return b.up;
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

/** 造一份合规大纲：页数可调，timeline/workload 各占一页，bullet 均 ≤42 字。
 *  T05066：同一 dataKey 全稿只挂一页成为校验层行为——夹具兜底页从固定 ['preflight'] 改为逐页轮换
 *  互不相同的键（cover 置空、timeline/workload 释放 planRows/reqStats 进轮换池），保证夹具本身
 *  不触发跨页去重，重复行为由 R-13 专项构造。 */
function outlineJson(pages = 13, timelineAt = 6, workloadAt = 7) {
  const singleKeys = ['prdDoc', 'reqList', 'reqStats', 'planRows', 'milestones', 'coverage', 'assignees', 'risks', 'workspace', 'preflight'];
  let si = 0;
  return JSON.stringify(Array.from({ length: pages }, (_, i) => ({
    section: SECTIONS[i % SECTIONS.length],
    title: `启动会页 ${i + 1}`,
    bullets: i === timelineAt ? ['时间线按库内排期绘制'] : i === workloadAt ? ['工作量取估算口径'] : ['范围与交付物', '责任分工'],
    dataKeys: i === timelineAt ? ['timeline'] : i === workloadAt ? ['workload'] : i === 0 ? [] : [singleKeys[si++ % singleKeys.length]],
    layout: i === 0 ? 'cover' : i === timelineAt ? 'timeline' : i === workloadAt ? 'chart' : 'table',
  })));
}

if (!(await waitUp())) {
  ok('R-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('R-00 隔离实例启动', true);
  // 夹具必须覆盖 R-03d 的五个维度（需求样例 / 进行中 / 阻塞 / 已完成 / 里程碑），
  // 否则「样例事实五维齐备」会因为夹具没铺数据而红，读的人会误判成提示词回归。
  const fixProj = await call('POST', '/projects', { name: 'T02096 门内夹具项目' });
  FIVE_PID = String(fixProj.body?.id ?? '');
  ok('R-00c 门内夹具项目已建（零生产业务行）', fixProj.status === 201 && !!FIVE_PID, fixProj.body);
  await call('POST', '/plans/prd-docs', { projectId: FIVE_PID, filename: 'T02096夹具PRD.md', contentMd: `# 夹具 PRD\n\n${'夹具需求说明：覆盖需求登记、计划排期与风险跟踪三条主线。'.repeat(120)}` });
  for (let i = 1; i <= 5; i += 1) {
    await call('POST', '/plans/prd-requirements', { projectId: FIVE_PID, reqNo: `FR-00${i}`, title: `夹具需求 ${i} 项`, priority: i <= 2 ? 'high' : 'medium' });
  }
  const planSeed: Array<[string, string, string]> = [
    ['夹具里程碑甲', 'milestone', 'doing'],
    ['夹具里程碑乙', 'milestone', 'doing'],
    ['夹具进行中计划甲', 'normal', 'doing'],
    ['夹具进行中计划乙', 'normal', 'doing'],
    ['夹具阻塞计划甲', 'normal', 'blocked'],
    ['夹具已完成计划甲', 'normal', 'done'],
    ['夹具已完成计划乙', 'normal', 'done'],
  ];
  for (const [title, kind, status] of planSeed) {
    await call('POST', '/plans', { projectId: FIVE_PID, title, startDate: '2026-11-02', durationDays: 5, kind, status });
  }
  const seedReqs = await call('GET', `/plans/prd-requirements?projectId=${FIVE_PID}`);
  const seedPlans = await call('GET', `/plans?projectId=${FIVE_PID}`);
  ok('R-00d 夹具资料齐备（PRD 1 / 需求 5 / 计划 7）',
    seedReqs.status === 200 && seedReqs.body?.length === 5 && seedPlans.status === 200 && seedPlans.body?.length === 7,
    { reqs: seedReqs.body?.length, plans: seedPlans.body?.length, err: seedReqs.body?.error ?? seedPlans.body?.error });
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

  // R-12 参数校验
  const noTool = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID });
  const noPid = await call('POST', '/plans/kickoff-ppt-outline', { toolId: mockId });
  ok('R-12 projectId/toolId 缺失各自 400 点名', noTool.status === 400 && /toolId 必填/.test(String(noTool.body?.error)) && noPid.status === 400 && /projectId 必填/.test(String(noPid.body?.error)),
    { noTool: noTool.body, noPid: noPid.body });

  // R-13 跨页重复 dataKey（T05066 / T02156 遗留③）：同一数据块挂两页会被校验层去重——
  // 保留首次出现页、后续页去掉该键并记 warning，200 软着陆而非 400（不触发整稿重试烧配额）。
  const dupOutline = JSON.parse(outlineJson(12)) as any[];
  const dupKey = dupOutline[2].dataKeys[0]; // 第 3 页轮换到的键，再挂到第 5 页构造跨页重复
  dupOutline[4].dataKeys = [dupKey];
  mockQueue = [{ content: JSON.stringify(dupOutline) }];
  mockRequests.length = 0;
  const r13 = await call('POST', '/plans/kickoff-ppt-outline', { projectId: FIVE_PID, toolId: mockId });
  ok('R-13 同一 dataKey 跨页重复 → 200 + 后续页去掉该键 + warning 点名首次挂载页（首次出现保留，必含页不受影响）',
    r13.status === 200 && !r13.body?.outline?.[4]?.dataKeys?.includes(dupKey)
    && r13.body?.outline?.[2]?.dataKeys?.includes(dupKey)
    && (r13.body?.warnings ?? []).some((w: string) => new RegExp(`第 5 页 dataKeys ${dupKey} 已挂载于第 3 页`).test(w)),
    { status: r13.status, page5Keys: r13.body?.outline?.[4]?.dataKeys, warnings: r13.body?.warnings, error: r13.body?.error });

  // R-09 硬阻塞项目：400 拒生成 + 零 AI 请求
  const newProj = await call('POST', '/projects', { name: `T02096 空项目 ${Date.now()}` });
  mockQueue = [{ content: outlineJson(12) }];
  mockRequests.length = 0;
  const blocked = await call('POST', '/plans/kickoff-ppt-outline', { projectId: String(newProj.body?.id ?? ''), toolId: mockId });
  ok('R-09 硬阻塞项目 → 400 点名 P1~P3 且零 mock 请求（校验阶段不烧配额）',
    blocked.status === 400 && /资料不足，不能生成启动会稿：P1、P2、P3 全部缺失/.test(String(blocked.body?.error)) && mockRequests.length === 0,
    { status: blocked.status, error: blocked.body?.error, asks: mockRequests.length });

  writeFileSync(join(ROOT, '.workbuddy', 't02096-outline-sample.json'), JSON.stringify(good.body, null, 2), 'utf8');
}

try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
mock.close();
const summary = `T02096 大纲生成与校验门：PASS=${pass} FAIL=${fail}\n` + lines.join('\n') + '\n';
mkdirSync(join(ROOT, '.workbuddy'), { recursive: true });
writeFileSync(join(ROOT, '.workbuddy', 't02096-gate-results.txt'), summary, 'utf8');
for (let i = 0; i < 5; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
}
process.exit(fail === 0 ? 0 : 1);
