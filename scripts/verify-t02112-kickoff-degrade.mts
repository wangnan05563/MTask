/**
 * T02112 门（PRD §8 验收 2/7/9 + §6.2「占位、越界降级与断连清理」）。
 *
 * 与已有机门的分工（只补真链路上没人证过的那一层）：
 *   verify-t02095 在**校验层**证阻塞口径（P1∧P2∧P3 全 fail 才 blocked）与端点结构；
 *   verify-t02099 在 **builder 纯函数层**证越界→降级（输入是自己造的 mock bundle）；
 *   verify-t02103/t02105 在**链路层**证断连与闸位；
 *   本门一律走真 HTTP 端点 + 真项目取数 + 真产物解包，并且补三条此前只有静态/单层证据的事实：
 *     ① 验收 2 的「全程零 AI 调用」用 mock 请求计数 + `ai_usage` 落库条数双向佐证（此前只有源码扫描）；
 *     ② 验收 7 的越界降级要在**用户可提交的长标题**路径上成立（`assertOutlineShape` 不裁标题，
 *        所以面板里手打的长标题会直达版式层——这条只有产物能证）；
 *     ③ 占位族（零用例 / 无里程碑 / 零估算）在产物里如实留痕，不编数字、不画假菱形。
 *
 * 断言组：
 *   N 组 验收 2：空项目 blocked + 3 条硬缺失点名深链 + 零 AI 调用 + 零落盘 + 前端禁用同源。
 *   D 组 验收 7：长标题越界 → done.warnings 点名降级 → 产物仍可解包、越界页只留标题正文、形状不出画布。
 *   P 组 占位：零用例→覆盖率页占位无百分比；无里程碑→时间线降级为表格且无菱形；零估算→页脚工期口径且人天=SQL 复算。
 *   C 组 验收 9：生成中客户端断开 → 无残留临时文件、闸位即时归还、实例仍健康、日志无未捕获异常。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02112-kickoff-degrade.mts
 * 环境变量：`T02112_PORT`（默认随机 39600+rand300）。
 * 隔离纪律（skill 红线 8）：生产库**只读副本**落临时目录，端口/数据全临时，mock 不消耗真实配额，收尾删临时目录。
 * 结果落 .workbuddy/t02112-gate-results.txt 与 t02112-degraded.pptx（人工抽查用）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02112_PORT ?? 39_600 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02112-deg-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_DIR = join(DATA_DIR, 'tmp');
// 进程内 import 的服务也读这份副本（getDb() 首次使用时才解析 MTask_DATA_DIR）
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
// mock AI：只承接措辞段（本门自造大纲，不走大纲端点）；带请求计数与可调延迟
// =====================================================================
let mockHits = 0;
let mockDelayMs = 0;
const mock = createServer((req, res) => {
  mockHits += 1;
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    let user = '';
    try {
      const j = JSON.parse(body);
      user = String((j.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n'));
    } catch { /* 坏请求回空 */ }
    const reply = () => {
      const want = /条数分别为 (\d+) 与 (\d+)。/.exec(user);
      const nRisks = want ? +want[1] : 2;
      const nComms = want ? +want[2] : 2;
      const items = [...user.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => m[1].trim());
      const content = JSON.stringify({
        risks: Array.from({ length: nRisks }, (_, i) => ({
          item: (items[i] ?? `风险 ${i + 1}`).slice(0, 40),
          impact: '会上确认影响面',
          mitigation: '会上明确责任方与时限',
        })),
        comms: Array.from({ length: nComms }, (_, i) => (i === 0 ? '周会跟里程碑节点开' : '变更先登记进需求跟踪矩阵')),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
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
ok('N-00 生产库只读副本已生成（本门零写生产库）', existsSync(join(DATA_DIR, 'mtask.db')));
const db = new Database(join(DATA_DIR, 'mtask.db'), { readonly: true });
const q = <T,>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[];

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
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}
/** 走 SSE；abortWhen 为真即由客户端断开（模拟面板「停止」/关面板；断在 AI 措辞在途时最考验清理） */
async function streamGen(path: string, body: unknown, opts: { abortWhen?: () => boolean } = {}): Promise<{
  status: number; events: Array<{ event: string; data: any }>; aborted: boolean; json: any;
}> {
  const ac = new AbortController();
  const events: Array<{ event: string; data: any }> = [];
  let aborted = false;
  let status = 0;
  let json: any = null;
  const kill = () => {
    if (aborted) return;
    aborted = true;
    ac.abort();
  };
  const poll = opts.abortWhen ? setInterval(() => { if (opts.abortWhen!()) kill(); }, 100) : null;
  try {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
    status = res.status;
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('event-stream')) return { status, events, aborted, json: await res.json().catch(() => null) };
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
  return { status, events, aborted, json };
}

/** 12 页标准稿（版式/章节/数据键全走服务端白名单，越界构造只改标题与要点） */
function baseOutline(longTitlePages: Record<number, string> = {}): any[] {
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
    ['沟通管理', '例会与变更口径', [], ['周会节奏', '变更登记']],
    ['附录', '数据口径与工作空间', ['workspace', 'prdDoc'], ['取数时间', '原文索引']],
  ];
  const layoutOf = (i: number) => (i === 0 ? 'cover' : i === 1 ? 'toc' : i === 6 ? 'timeline' : i === 7 ? 'chart' : i === 11 ? 'list' : 'table');
  return spec.map(([section, title, dataKeys, bullets], i) => ({
    section,
    title: longTitlePages[i] ?? title,
    bullets: section === '封面' ? [] : bullets,
    dataKeys,
    layout: layoutOf(i),
  }));
}
/** 必然越界：56 字标题直达版式层（`assertOutlineShape` 只校验枚举，不裁长度——面板手打长标题走的就是这条路） */
const OVERFLOW_TITLE = '本页标题刻意超长以逼出越界'.repeat(4);

const projects = q<{ id: string; name: string }>('SELECT id, name FROM projects WHERE archived = 0 AND name != ? ORDER BY name', '收件箱');
const counts = (id: string) => ({
  P1: q<{ n: number }>('SELECT COUNT(*) n FROM prd_docs WHERE project_id = ?', id)[0].n,
  P2: q<{ n: number }>('SELECT COUNT(*) n FROM prd_requirements WHERE project_id = ?', id)[0].n,
  P3: q<{ n: number }>('SELECT COUNT(*) n FROM plan_tasks WHERE project_id = ? AND archived = 0', id)[0].n,
  ms: q<{ n: number }>("SELECT COUNT(*) n FROM plan_tasks WHERE project_id = ? AND archived = 0 AND kind = 'milestone'", id)[0].n,
  tc: q<{ n: number }>('SELECT COUNT(*) n FROM test_cases WHERE project_id = ?', id)[0].n,
  est: q<{ n: number }>('SELECT COUNT(*) n FROM estimate_items WHERE project_id = ?', id)[0].n,
});
const findNamed = (names: string[], pred: (c: ReturnType<typeof counts>) => boolean) => {
  for (const n of names) {
    const p = projects.find((x) => x.name === n);
    if (p && pred(counts(p.id))) return p;
  }
  return projects.find((p) => pred(counts(p.id)));
};
const emptyProject = findNamed(['bemp', 'ac', 'news'], (c) => c.P1 === 0 && c.P2 === 0 && c.P3 === 0);
const noCaseProject = findNamed(['mtask四期'], (c) => c.P1 > 0 && c.tc === 0);
const noMilestoneProject = findNamed(['ev二期'], (c) => c.P3 >= 8 && c.ms === 0);

if (!(await waitUp())) {
  ok('X-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('X-00 隔离实例启动', true);
  const tool = await call('POST', '/aitools', {
    name: 't02112-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-wording', timeoutMs: 20000,
  });
  const toolId = tool.body?.id as string | undefined;
  ok('X-01 mock AI 工具已建（不触真实模型）', !!toolId, tool.body);

  // ---------------- N 组：验收 2 空项目硬阻塞 + 零 AI 佐证 ----------------
  if (!emptyProject) {
    ok('N-01 空项目样本存在（库内无 P1=P2=P3=0 的项目 → 本组不成立）', false, emptyProject);
  } else {
    const hitsBefore = mockHits;
    const usageBefore = q<{ n: number }>('SELECT COUNT(*) n FROM ai_usage')[0].n;
    const pf = await call('GET', `/plans/kickoff-preflight?projectId=${emptyProject.id}`);
    const items: any[] = pf.body?.items ?? [];
    const hard = items.filter((i) => i.hard);
    ok(`N-01 空项目样本 [${emptyProject.name}] 存在且资料三项皆零`, counts(emptyProject.id).P3 === 0);
    ok(`N-02 [${emptyProject.name}] preflight 200 且 blocked=true（FR-2.4 三项全 fail 才阻塞）`,
      pf.status === 200 && pf.body?.blocked === true, { status: pf.status, blocked: pf.body?.blocked, missingHard: pf.body?.missingHard });
    ok('N-03 硬缺失恰为 P1/P2/P3 三条并逐一点名（不是笼统一句「资料不足」）',
      JSON.stringify([...(pf.body?.missingHard ?? [])].sort()) === JSON.stringify(['P1', 'P2', 'P3']), pf.body?.missingHard);
    ok('N-04 三条硬缺失各带可跳转深链且互不重复',
      hard.length === 3 && hard.every((i) => typeof i.deepLink === 'string' && i.deepLink.length > 0) &&
        new Set(hard.map((i) => i.deepLink)).size === 3, hard.map((i) => ({ k: i.key, d: i.deepLink })));
    ok('N-05 每条 fail 项都写清「怎么补」（note 给出动作路径而非只报数）',
      hard.every((i) => /导入|补录|拆分|生成|矩阵|WBS|PRD/.test(String(i.note ?? ''))), hard.map((i) => i.note));
    ok('N-06 校验全程零 AI 请求（mock 侧请求计数为 0——验收 2 的「日志佐证」）',
      mockHits === hitsBefore, { before: hitsBefore, after: mockHits });
    ok('N-07 校验全程零 AI 用量落库（ai_usage 条数不变——验收 2 的「调用计数佐证」）',
      q<{ n: number }>('SELECT COUNT(*) n FROM ai_usage')[0].n === usageBefore, { before: usageBefore });
    ok('N-08 校验零落盘（FR-2.3 只读：data/tmp 不存在或为空）',
      !existsSync(TMP_DIR) || readdirSync(TMP_DIR).length === 0, existsSync(TMP_DIR) ? readdirSync(TMP_DIR) : 'no tmp dir');
  }
  const PANEL = readFileSync(join(ROOT, 'web', 'src', 'pages', 'KickoffPptPanel.tsx'), 'utf8');
  ok('N-09 面板「生成大纲」禁用与 blocked 同源（验收 2 的按钮不可用只有一个真值来源）',
    /disabled=\{[^}]*blocked[^}]*\}/.test(PANEL) && /canGenerate = [\s\S]{0,200}!blocked/.test(PANEL),
    (PANEL.match(/const canGenerate = .*/) ?? [''])[0]);

  // ---------------- D 组：验收 7 越界长标题 → 真链路降级 ----------------
  const PID = noCaseProject?.id ?? '';
  const PNAME = noCaseProject?.name ?? '';
  const dOutline = baseOutline({ 4: OVERFLOW_TITLE });
  const dGen = await streamGen(`/plans/kickoff-ppt-stream?projectId=${PID}&toolId=${toolId}`, { projectId: PID, toolId, outline: dOutline });
  const dDone = dGen.events.find((e) => e.event === 'done')?.data;
  const dWarn: string[] = dDone?.warnings ?? [];
  ok(`D-01 [${PNAME}] 56 字长标题直达版式层（assertOutlineShape 不裁长度——面板手打就是这条路）`,
    dGen.status === 200 && dOutline[4].title.length > 30, { len: dOutline[4].title.length, status: dGen.status });
  ok('D-02 done.warnings 点名「版式越界…已降级为「标题 + 正文」安全版式」（不静默出坏页）',
    dWarn.some((w) => /版式越界/.test(w) && /安全版式/.test(w)), dWarn.slice(0, 4));
  lines.push(`[证据] D-02 命中的降级告警原文：${dWarn.find((w) => /版式越界/.test(w)) ?? '（无）'}`);
  ok('D-03 降级点名到具体页码（第 5 页 = 构造的那一页）',
    dWarn.some((w) => /^第 5 页/.test(w) && /版式越界/.test(w)), dWarn.filter((w) => /越界/.test(w)));
  const dDl = dDone?.token ? await download(String(dDone.token), String(dDone.fileName)) : { status: 0, buf: Buffer.alloc(0) };
  ok('D-07 越界不阻断交付：仍能换回 .pptx 字节（>20KB）',
    dDl.status === 200 && dDl.buf.length > 20_000, { status: dDl.status, bytes: dDl.buf.length });
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 't02112-degraded.pptx'), dDl.buf);
  const zip = await JSZip.loadAsync(dDl.buf);
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const allXml: string[] = [];
  for (let i = 1; i <= slideNames.length; i += 1) allXml.push(await zip.file(`ppt/slides/slide${i}.xml`)!.async('string'));
  // T02171：时间线页超行数会展开续页，产物页数 ≥ 大纲页数——这里的不变量是
  // 「解包页数 == 服务端报告的 pageCount」（降级不吞页），大纲数只作下界。
  ok('D-04 降级后产物仍可解包且页数与报告一致（宁可素也不出坏页，验收 7 后半句）',
    slideNames.length === dDone?.pageCount && slideNames.length >= dOutline.length,
    { unzipped: slideNames.length, pageCount: dDone?.pageCount, outline: dOutline.length });
  const page5 = allXml[4] ?? '';
  const shapesIn = (xml: string) => xml.split('<p:sp>').slice(1).map((s) => ({
    prst: (s.match(/prst="([a-zA-Z]+)"/) ?? [])[1] ?? '',
    name: (s.match(/name="([^"]*)"/) ?? [])[1] ?? '',
    off: (s.match(/<a:off x="(\d+)" y="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / 914400),
    ext: (s.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/) ?? []).slice(1).map((v) => +v / 914400),
  })).filter((o) => /^Shape\b/.test(o.name));
  ok('D-05 越界页只留标题与正文（数据块被舍弃而不是溢出成坏页）',
    /本页标题刻意超长/.test(page5) && !/<a:tbl>/.test(page5) && !/其余 \d+ 条/.test(page5),
    { tbl: /<a:tbl>/.test(page5), texts: (page5.match(/<a:t>[^<]{0,18}/g) ?? []).slice(0, 4) });
  ok('D-06 常规页未被牵连（其余页照常出原生表格）',
    allXml.filter((x, i) => i !== 4).some((x) => /<a:tbl>/.test(x)), allXml.map((x) => (/<a:tbl>/.test(x) ? 1 : 0)));
  ok('D-08 全稿形状坐标仍在 10 × 5.625 画布内（降级页不许甩出界）',
    allXml.every((x) => shapesIn(x).every((s) => s.off.length === 2 && s.ext.length === 2 &&
      s.off[0] >= 0 && s.off[1] >= 0 && s.off[0] + s.ext[0] <= 10 + 1e-6 && s.off[1] + s.ext[1] <= 5.625 + 1e-6)),
    allXml.map((x) => shapesIn(x).filter((s) => s.off?.[0] + s.ext?.[0] > 10.000001).length).filter((n) => n > 0));

  // ---------------- P 组：占位与缺数据降级（全在真产物上） ----------------
  const cPage = allXml.find((x) => /用例|覆盖/.test(x)) ?? '';
  const covTexts = (cPage.match(/<a:t>[^<]*/g) ?? []).map((s) => s.replace('<a:t>', ''));
  ok(`P-01 [${PNAME}] 零用例项目的覆盖率页出占位文案（不空着、也不编数字）`,
    /待补充|本期未建/.test(covTexts.join('')), covTexts.slice(0, 8));
  ok('P-02 覆盖率页不出百分比结论（没用例就没有「覆盖率 N%」这种假数）',
      !/覆盖率\s*\d+(\.\d+)?\s*%/.test(covTexts.join('')), covTexts.filter((t) => /%/.test(t)).slice(0, 4));

  const MID = noMilestoneProject?.id ?? '';
  const MINAME = noMilestoneProject?.name ?? '';
  if (!MID) {
    ok('P-03 无里程碑样本存在（库内无「有计划、零里程碑」项目 → 本条不成立）', false, noMilestoneProject);
  } else {
    const mOutline = baseOutline();
    const mGen = await streamGen(`/plans/kickoff-ppt-stream?projectId=${MID}&toolId=${toolId}`, { projectId: MID, toolId, outline: mOutline });
    const mDone = mGen.events.find((e) => e.event === 'done')?.data;
    const mDl = mDone?.token ? await download(String(mDone.token), String(mDone.fileName)) : { status: 0, buf: Buffer.alloc(0) };
    const mzip = mDone?.token ? await JSZip.loadAsync(mDl.buf) : null;
    const mXml: string[] = [];
    if (mzip) {
      const names = Object.keys(mzip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      for (let i = 1; i <= names.length; i += 1) mXml.push(await mzip.file(`ppt/slides/slide${i}.xml`)!.async('string'));
    }
    const tlPage = mXml[6] ?? '';
    const tlShapes = shapesIn(tlPage);
    ok(`P-03 [${MINAME}] 无里程碑项目的时间线页不画菱形（里程碑不是装饰，画不出来就不画）`,
      mDl.status === 200 && tlShapes.every((s) => s.prst !== 'diamond') && !/prst="diamond"/.test(tlPage),
      { diamonds: tlShapes.filter((s) => s.prst === 'diamond').length });
    ok('P-04 无里程碑时时间线降级为原生表格/列表且页面无损（产物仍可解包、页数一致）',
      mXml.length === mOutline.length && /<a:tbl>/.test(tlPage),
      { slides: mXml.length, tbl: /<a:tbl>/.test(tlPage), warn: (mDone?.warnings ?? []).slice(0, 3) });
    const sum = q<{ d: number }>("SELECT COALESCE(SUM(duration_days),0) d FROM plan_tasks WHERE project_id = ? AND archived = 0 AND kind != 'milestone'", MID)[0].d;
    const wlPage = mXml[7] ?? '';
    const wlTexts = (wlPage.match(/<a:t>[^<]*/g) ?? []).map((s) => s.replace('<a:t>', ''));
    ok(`P-05 [${MINAME}] 零估算项目的工作量页走工期口径：页面人天 = Σ duration_days = ${sum}（SQL 独立复算）`,
      /工期口径/.test(wlTexts.join('')) && wlTexts.some((t) => new RegExp(`\\b${sum}\\b`).test(t)),
      { sql: sum, page: wlTexts.slice(0, 8) });
    ok('P-06 工期口径页不许谎称三点区间（乐观/悲观为空时不输出 ±）',
      !/±|P84|乐观/.test(wlTexts.join('')), wlTexts.slice(0, 6));
  }

  // ---------------- C 组：验收 9 断连清理 ----------------
  mockDelayMs = 3000;
  const hitsAtAbort = mockHits;
  // 断在「AI 措辞请求已发出、尚未回稿」这一瞬——清理路径最难看的一条（面板关窗就发生在这里）
  const ab = await streamGen(
    `/plans/kickoff-ppt-stream?projectId=${PID}&toolId=${toolId}`,
    { projectId: PID, toolId, outline: baseOutline() },
    { abortWhen: () => mockHits > hitsAtAbort },
  );
  ok('C-01 措辞在途时客户端断开被识别（未收到 done/error 帧）',
    ab.aborted && !ab.events.some((e) => e.event === 'done' || e.event === 'error'), { events: ab.events.map((e) => e.event) });
  let tmpAfter: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    tmpAfter = existsSync(TMP_DIR) ? readdirSync(TMP_DIR) : [];
    if (tmpAfter.length === 0) break;
  }
  ok('C-02 断连后零残留：data/tmp 目录无半成品 pptx 也无孤儿令牌（验收 9 前半句）',
    tmpAfter.length === 0, tmpAfter);
  mockDelayMs = 0;
  const recover = await streamGen(`/plans/kickoff-ppt-stream?projectId=${PID}&toolId=${toolId}`, { projectId: PID, toolId, outline: baseOutline() });
  const recDone = recover.events.find((e) => e.event === 'done')?.data;
  const recDl = recDone?.token ? await download(String(recDone.token), String(recDone.fileName)) : { status: 0, buf: Buffer.alloc(0) };
  ok('C-03 无僵尸会话：断连后闸位即时归还（紧接一次完整生成成功出稿并可下载，不必等超时）',
    !!recDone?.token && recDl.status === 200 && recDl.buf.length > 20_000,
    { done: !!recDone, status: recDl.status, bytes: recDl.buf.length });
  ok('C-04 断连请求不产生第二份落盘点（回收后 tmp 目录仍为空——只有一个落盘点才守得住这条）',
    !existsSync(TMP_DIR) || readdirSync(TMP_DIR).length === 0, existsSync(TMP_DIR) ? readdirSync(TMP_DIR) : 'no tmp dir');
  const health = await call('GET', '/health');
  ok('C-05 断连后实例仍健康（/health 正常应答，服务没被半路连接打挂）',
    health.status === 200 && health.body?.service === 'mtask-server', health.body);
  const logText = serverLog.join('');
  ok('C-06 服务端日志无未捕获异常（unhandledRejection / uncaughtException 零命中）',
    !/unhandledRejection|uncaughtException/.test(logText), (logText.match(/unhandledRejection|uncaughtException[^\n]{0,120}/) ?? []).slice(0, 2));
  ok('C-07 断连期间确有 AI 请求发生（否则 C 组等于空跑——措辞段被中止才有清理可证）',
    mockHits > hitsAtAbort, { hitsAtAbort, now: mockHits });
}

// =====================================================================
// 收口
// =====================================================================
db.close();
child.kill();
mock.close();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }

const sampleNames = [emptyProject?.name, noCaseProject?.name, noMilestoneProject?.name].filter(Boolean).join('、');
const summary = `T02112 降级与异常门：PASS ${pass} / FAIL ${fail}（样本：空项目 ${sampleNames}）\n` + lines.join('\n');
writeFileSync(join(OUT_DIR, 't02112-gate-results.txt'), summary, 'utf8');
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
