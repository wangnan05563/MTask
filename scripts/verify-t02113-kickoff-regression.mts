/**
 * T02113 门（PRD §8 验收 1/10 + §6.3「回归测试：验证周报导出与并发闸不受影响」）。
 *
 * 与已有机门的分工：
 *   verify-t02105 证的是**接线**（启动会与周报共用同一闸名 REPORT_GATE、429 形态、defer）；
 *   T02108 的 UI 实测证的是**交互**（卡片点击开面板、互斥、深链落位）。
 *   本门补两层它们都没覆盖的回归事实：
 *     ① 验收 10 的原话主语是「周报四格式导出」——启动会接入之后，周报自己那条路
 *        必须逐格式出**内容正确的二进制**（不是只回 200），且并发上限在周报侧仍真的生效；
 *     ② 验收 1 的「第 7 位 / 复用 ReportCard / 全量互斥」是可回归的结构事实，
 *        UI 实测一次就过期，源码守卫才守得住后续改动（新卡片漏进互斥集是历史真坑，见 togglePanel 注释）。
 *
 * 断言组：
 *   R 组 周报四格式：xlsx/docx/pdf/pptx 逐个出正确魔数 + 体积达标 + 下载名合规（零 AI，纯离线生成）。
 *   G 组 并发闸：4 路并发周报恰好 2 接受 2 拒（上限默认 2）；批次跑完闸位归还；
 *              app_settings 调 1 后 2 路只放 1 路；混跑（1 路启动会在途 + 3 路周报）总并发不超上限。
 *   C 组 验收 1 结构守卫：启动会卡居第 7 位、前 6 卡顺序未被挤掉、同用 ReportCard、
 *              互斥集含 kickoffPpt 且由 Object.keys 全量派生、深链走「确保展开」而非 toggle。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02113-kickoff-regression.mts
 * 环境变量：`T02113_PORT`（默认随机 39700+rand300）。
 * 隔离纪律（skill 红线 8）：生产库只读副本落临时目录，设置项只写进副本，端口临时，收尾删目录。
 * 结果落 .workbuddy/t02113-gate-results.txt。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02113_PORT ?? 39_700 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02113-reg-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// C 组：验收 1 结构守卫（纯源码，最先跑——它不依赖实例，红了就是卡片被动过）
// =====================================================================
const PAGE = readFileSync(join(ROOT, 'web', 'src', 'pages', 'ReportPage.tsx'), 'utf8');
const cardsSrc = PAGE.slice(PAGE.indexOf('const reportCards: ReportCardCfg[] = ['));
const cardsBody = cardsSrc.slice(0, cardsSrc.indexOf('\n  ];'));
const cardKeys = [...cardsBody.matchAll(/\{ key: '([a-z-]+)'/g)].map((m) => m[1]);
const EXPECTED_ORDER = ['ai-import', 'offline', 'ai-live', 'prd-gen', 'prd-import', 'tc-gen', 'kickoff-ppt'];
ok('C-01 工作卡片恰 7 张且「项目启动会 PPT 生成」居第 7 位（验收 1 的位次是结构事实，不靠肉眼看）',
  cardKeys.length === 7 && cardKeys[6] === 'kickoff-ppt', cardKeys);
ok('C-02 前 6 张卡顺序未被挤掉（新卡只能尾部追加——历史坑：插中间会让既有深链/持久化错位）',
  JSON.stringify(cardKeys.slice(0, 6)) === JSON.stringify(EXPECTED_ORDER.slice(0, 6)), cardKeys.slice(0, 6));
ok('C-03 启动会卡片标题与描述逐字守 PRD 口径（FR-1.1 文案漂移会让验收 1 的「样式同源」失去参照）',
  /title: '项目启动会 PPT 生成'/.test(cardsBody) && /原生可编辑 \.pptx/.test(cardsBody),
  (cardsBody.match(/title: '[^']*'/g) ?? []).slice(0, 8));
ok('C-04 卡片仍由同一个 ReportCard 渲染（没有为启动会另造卡片组件——样式同源的定义就是同组件）',
  /function ReportCard\(/.test(PAGE) && /<ReportCard\b/.test(PAGE) && !/function KickoffPptCard|<KickoffPptCard/.test(PAGE));
const settersSrc = PAGE.slice(PAGE.indexOf('const panelSetters = {'));
const setterBody = settersSrc.slice(0, settersSrc.indexOf('} as const'));
ok('C-05 互斥集含 kickoffPpt（新增面板进同一套 setters，不再手挑 setX(false)）',
  /kickoffPpt: setShowKickoffPpt/.test(setterBody), (setterBody.match(/\w+:/g) ?? []));
ok('C-06 互斥由 Object.keys(panelSetters) 全量派生（漏关某面板的历史缺陷不可能复发）',
  /function togglePanel[\s\S]{0,260}Object\.keys\(panelSetters\)[\s\S]{0,200}panelSetters\[k\]\(/.test(PAGE),
  (PAGE.match(/function togglePanel[\s\S]{0,220}/) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 180));
ok('C-07 启动会面板只有一个挂载点，且与其余面板同在 ReportWorkPanels 内（互斥与重置都走同一容器）',
  (PAGE.match(/showKickoffPpt && \(/g) ?? []).length === 1 && /<KickoffPptPanel/.test(PAGE));
ok('C-08 校验清单深链走「确保展开」而非卡片 toggle（面板已展开时 toggle 会收起——用户点「去补充」反而没了）',
  /const openCard = [\s\S]{0,300}if \(panelOpen\[panel\]\) return;[\s\S]{0,120}togglePanel\(panel\)/.test(PAGE),
  (PAGE.match(/const openCard = [\s\S]{0,200}/) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 180));
ok('C-09 面板开关态走会话持久化（report.showKickoffPpt 与其余卡片同一 useSessionState 口径）',
  /useSessionState\('report\.showKickoffPpt', false\)/.test(PAGE),
  (PAGE.match(/useSessionState\('report\.[^']+'/g) ?? []).slice(0, 8));

// =====================================================================
// mock AI（只给 G 组混跑时占用启动会那一路用；周报四格式全程零 AI）
// =====================================================================
let mockDelayMs = 0;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ risks: [], comms: [] }) } }] }));
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
ok('R-00 生产库只读副本已生成（设置项只写进副本，不碰生产 app_settings）', existsSync(join(DATA_DIR, 'mtask.db')));

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
async function genReport(format: string, projectId: string) {
  const res = await fetch(BASE + '/report/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: 'week', format, projectId }),
  });
  const ctype = res.headers.get('content-type') ?? '';
  const disp = res.headers.get('content-disposition') ?? '';
  const buf = ctype.includes('json') ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
  const json = ctype.includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, ctype, disp, buf, json };
}
/** 启动会那一路只用来「占住闸位」，不需要读到完整产物 */
async function kickoffStreamPending(toolId: string, projectId: string, outline: any[]) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4_000);
  try {
    const res = await fetch(BASE + `/plans/kickoff-ppt-stream?projectId=${projectId}&toolId=${toolId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, toolId, outline }), signal: ac.signal,
    });
    return { status: res.status, ctype: res.headers.get('content-type') ?? '' };
  } catch {
    return { status: 0, ctype: 'aborted' };
  } finally {
    clearTimeout(timer);
  }
}

if (!(await waitUp())) {
  ok('X-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('X-00 隔离实例启动', true);
  const rdb = new Database(join(DATA_DIR, 'mtask.db'), { readonly: true });
  const rq = <T,>(sql: string, ...a: unknown[]) => rdb.prepare(sql).all(...a) as T[];
  const pid = rq<{ id: string; name: string }>('SELECT id, name FROM projects WHERE archived = 0 AND name = ?', 'mtask四期')[0];
  ok('X-01 回归样本项目存在（mtask四期，真实资料）', !!pid?.id, pid);

  // ---------------- R 组：周报四格式导出仍是「内容正确」而非只回 200 ----------------
  const MAGIC: Record<string, (b: Buffer) => boolean> = {
    xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b,
    docx: (b) => b[0] === 0x50 && b[1] === 0x4b,
    pptx: (b) => b[0] === 0x50 && b[1] === 0x4b,
    pdf: (b) => b.slice(0, 4).toString('latin1') === '%PDF',
  };
  for (const fmt of ['xlsx', 'docx', 'pdf', 'pptx']) {
    const r = await genReport(fmt, pid.id);
    ok(`R-01.${fmt} 周报 ${fmt} 导出 200 且魔数正确（OOXML=PK / PDF=%PDF，不是 JSON 错误体）`,
      r.status === 200 && MAGIC[fmt](r.buf), { status: r.status, bytes: r.buf.length, err: r.json?.error });
    ok(`R-02.${fmt} 周报 ${fmt} 产物非空壳（>10KB）`, r.buf.length > 10_000, { bytes: r.buf.length });
    ok(`R-03.${fmt} 下载名走 RFC5987 且后缀对（中文名不被退回 xlsx 名）`,
      /filename\*=UTF-8''[^;]+/.test(r.disp) && decodeURIComponent(r.disp).includes(`.${fmt}`), r.disp.slice(0, 120));
  }
  const bad = await fetch(BASE + '/report/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: 'week', format: 'md', projectId: pid.id }),
  });
  ok('R-04 非法格式仍被 400 拦（枚举校验没被启动会接入带松）', bad.status === 400, bad.status);

  // ---------------- G 组：并发上限在周报侧仍真的生效 ----------------
  const batch = await Promise.all(['xlsx', 'docx', 'pdf', 'pptx'].map((f) => genReport(f, pid.id)));
  const accepted = batch.filter((r) => r.status === 200).length;
  const rejected = batch.filter((r) => r.status === 429).length;
  ok('G-01 4 路并发周报 → 恰好 2 接受 + 2 拒（上限默认 2，超限拒绝而不是排队）',
    accepted === 2 && rejected === 2, batch.map((r) => r.status));
  ok('G-02 被拒的两路是结构化中文 429（前端可读文案重试，不是一片空白）',
    batch.filter((r) => r.status === 429).every((r) => typeof (r.json?.error ?? r.json?.message) === 'string' && (r.json?.error ?? r.json?.message).length > 0),
    batch.filter((r) => r.status === 429).map((r) => r.json));
  await sleep(1_500);
  // 单发一次确认闸位已彻底归零——上一批若有在途残留，这里就会被误判成「永久锁死」
  await genReport('pptx', pid.id);
  const after = await Promise.all([genReport('xlsx', pid.id), genReport('pdf', pid.id)]);
  ok('G-03 批次跑完闸位归还（再发 2 路全接受，不锁死）',
    after.every((r) => r.status === 200), after.map((r) => r.status));

  const tool = await fetch(BASE + '/aitools', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 't02113-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', model: 'mock-wording', timeoutMs: 20000 }),
  });
  const toolId = ((await tool.json().catch(() => null)) as any)?.id as string | undefined;
  ok('X-02 mock AI 工具已建（混跑只占闸位，零真实配额）', !!toolId, toolId);
  // 混跑：1 路启动会（措辞在途，闸位被占）+ 3 路周报 → 总计 ≤2 在途
  mockDelayMs = 3_000;
  const mixOutline = Array.from({ length: 12 }, (_, i) => ({
    section: i === 0 ? '封面' : i === 6 ? '项目计划' : i === 7 ? '工作量评估' : '项目需求',
    title: i === 0 ? '项目启动会' : `回归占位页 ${i + 1}`,
    bullets: i === 0 ? [] : ['范围与交付物'],
    dataKeys: i === 6 ? ['timeline'] : i === 7 ? ['workload'] : ['reqStats'],
    layout: i === 0 ? 'cover' : i === 6 ? 'timeline' : i === 7 ? 'chart' : 'table',
  }));
  const mix = await Promise.all([
    kickoffStreamPending(String(toolId), pid.id, mixOutline),
    genReport('xlsx', pid.id), genReport('docx', pid.id), genReport('pptx', pid.id),
  ]);
  mockDelayMs = 0;
  const mixOk = mix.filter((r: any) => r.status === 200).length;
  const mix429 = mix.filter((r: any) => r.status === 429).length;
  ok('G-04 混跑同闸生效：启动会在途 + 3 路周报 → 总接受数不超上限 2 且确有请求被拒（两处共用一闸的行为证据，不只是同名）',
    mixOk >= 1 && mixOk <= 2 && mix429 >= 1, mix.map((r: any) => r.status));
  await sleep(2_000);

  {
    const wdb = new Database(join(DATA_DIR, 'mtask.db'));
    wdb.prepare("insert into app_settings(key,value) values('exportGateLimit.report-generate','1') " +
      'on conflict(key) do update set value=excluded.value').run();
    wdb.close();
  }
  await sleep(300);
  const pair = await Promise.all([genReport('xlsx', pid.id), genReport('pdf', pid.id)]);
  ok('G-05 上限经 app_settings 即时生效（副本库调 report-generate=1 → 2 路只放 1 路；只写副本不碰生产）',
    pair.filter((r) => r.status === 200).length === 1 && pair.filter((r) => r.status === 429).length === 1,
    pair.map((r) => r.status));
  {
    const wdb = new Database(join(DATA_DIR, 'mtask.db'));
    wdb.prepare("delete from app_settings where key = 'exportGateLimit.report-generate'").run();
    wdb.close();
  }
  await sleep(300);
  await genReport('pdf', pid.id); // 同上：先单发把上一批的在途计数放干，再验默认上限
  const back = await Promise.all([genReport('xlsx', pid.id), genReport('docx', pid.id)]);
  ok('G-06 删键回落默认 2（配置读取是逐请求的，没有缓存住旧上限）',
    back.every((r) => r.status === 200), back.map((r) => r.status));

  ok('G-07 回归全程服务端无未捕获异常（闸与 worker 池没被并发打挂）',
    !/unhandledRejection|uncaughtException/.test(serverLog.join('')),
    (serverLog.join('').match(/unhandledRejection|uncaughtException[^\n]{0,120}/) ?? []).slice(0, 2));
  rdb.close();
}

// =====================================================================
// 收口
// =====================================================================
child.kill();
mock.close();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }

const summary = `T02113 回归门：PASS ${pass} / FAIL ${fail}\n` + lines.join('\n');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't02113-gate-results.txt'), summary, 'utf8');
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
