/**
 * T02166 真链路门（真实 AI，非 mock）——证三条只有真模型+真数据才成立的结论：
 *   A 组：AI 大纲的 bullets **有指代**（引用库内真实需求/计划/里程碑名），不是无指代套话（P1-1）。
 *   B 组：真实 AI 措辞段不再因尾逗号被判失败（P0-2）——warnings 里不出现「风险措辞 AI 失败」「is not valid JSON」。
 *   C 组：真产物**不再整块丢数据**（P0-1/P1-2）——无「空间不足，已省略」，无越界降级页，各页正文有实质字数。
 *          T02171 后时间线页会按版面分页：页码↔幻灯片映射按装配层的**渲染页**序列，
 *          并加 C-07「页脚不再折计数」/C-08「续页仍是原生甘特」两条承接口径。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02166-kickoff-ai.mts
 * 环境变量：`T02166AI_PORT`、`T02166_AI_TOOL`（钉选厂商名/id；不钉则取库内默认开发工具，会随他人改配置而变）。
 *          T02269 新增 `T02166AI_OUTLINE_TIMEOUT_MS`（默认 660000，覆盖 undici 裸 300s 头超时）与
 *          `T02166AI_GEN_TIMEOUT_MS`（默认 600000）——机检「慢厂商不崩栈」时把两者压到秒级即可复现失败路径。
 * 隔离纪律（skill 红线 8）：生产库只读副本 → D: 盘临时 DATA_DIR（C: 常年 0 可用），端口随机，收尾删副本。
 *          T02269：结果文件与「子进程 kill + 副本 close + DATA_DIR 删除」放进 finally，
 *          任何一处抛出（含超时穿透）都保证证据落盘、不留孤儿实例与 DATA_DIR 残留。
 * 结果落 .workbuddy/t02166-ai-gate-results-<端口>.txt、t02166-ai-outline-<端口>.txt、
 * t02166-ai-outline-raw-<端口>.txt（T02311：A-01 失败时的厂商原始响应旁证）与
 * t02166-ai-<端口>.pptx（人工抽查）；隔离数据目录同规则 `.workbuddy/t02166-ai-data-<端口>`。
 *          T02285：目录与产物名一律带门端口——并发跑门是常态，固定名会互删副本库、互覆产物，
 *          甚至让后写 pptx 的一方拿 EBUSY 被误记成「门脚本异常中断」。本轮归属见结果首行。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02166AI_PORT ?? 41_600 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
// T02285：隔离目录与产物一律随门端口唯一化。固定名在并发跑门时是互踩源——后起的门会在下面那句
// rmSync 里直接删掉前一个还在跑的门的活动副本库（含 -wal/-shm，前者的断言于是变成假失败），
// T02269 新加的 finally 清理又会主动删对方正在用的目录；两个进程同写一个 pptx 时后写者拿 EBUSY，
// 会被顶层 catch 记成「门脚本异常中断」这种根本不存在的中断。目录名带端口后各自只碰自己的。
const DATA_DIR = join(OUT_DIR, `t02166-ai-data-${PORT}`);
const RESULTS_FILE = join(OUT_DIR, `t02166-ai-gate-results-${PORT}.txt`);
const OUTLINE_FILE = join(OUT_DIR, `t02166-ai-outline-${PORT}.txt`);
// T02311：A-01 失败时的厂商原始响应旁证（服务端落数据目录，门复制到带端口名再断言）
const RAW_FILE = join(OUT_DIR, `t02166-ai-outline-raw-${PORT}.txt`);
const PPTX_FILE = join(OUT_DIR, `t02166-ai-${PORT}.pptx`);
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(join(DATA_DIR, 'tmp'), { recursive: true });
process.env.MTask_DATA_DIR = DATA_DIR;
process.env.TMPDIR = DATA_DIR;

let pass = 0;
let fail = 0;
const lines: string[] = [];
// 归属行：并发时人工核对「这条结论是哪一轮跑的」只看这一行即可（残留点名行也带同一个目录名）。
lines.push(`本轮门实例：端口 ${PORT} · 数据目录 ${DATA_DIR} · 结果文件 ${RESULTS_FILE}`);
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 500)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// T02269：outline 调用此前是「裸 fetch」——厂商响应头超过 undici 默认 headersTimeout(300s) 即抛
// `TypeError: fetch failed / UND_ERR_HEADERS_TIMEOUT`，整个门脚本崩栈：结果文件不写、
// 隔离实例变孤儿进程、DATA_DIR 残留（证据全丢）。超时值留环境变量出口，便于本地机检时压低。
const OUTLINE_TIMEOUT_MS = Number(process.env.T02166AI_OUTLINE_TIMEOUT_MS ?? 660_000);
const GEN_TIMEOUT_MS = Number(process.env.T02166AI_GEN_TIMEOUT_MS ?? 600_000);
const fmtErr = (e: unknown) => {
  const x = e as { name?: string; message?: string; cause?: { code?: string } };
  return `${x?.name ?? 'Error'}: ${x?.message ?? String(e)}${x?.cause?.code ? ` cause=${x.cause.code}` : ''}`;
};
const writeResults = () => writeFileSync(RESULTS_FILE, `T02166 真链路门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');

// ---------- 生产库只读副本 ----------
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
{
  const src = new Database(prodDb, { readonly: true });
  await src.backup(join(DATA_DIR, 'mtask.db'));
  src.close();
}
const copy = new Database(join(DATA_DIR, 'mtask.db'), { readonly: true });
const q = <T,>(sql: string, ...a: unknown[]) => copy.prepare(sql).all(...a) as T[];

// 用户反馈的那份稿：日志里点名的 PRD 原文文档 id
const byDoc = q<{ project_id: string }>('SELECT project_id FROM prd_docs WHERE id = ?', 'd340d45f-f626-4830-831f-d28530e2c0d6')[0];
const projRow = byDoc
  ? q<{ id: string; name: string }>('SELECT id, name FROM projects WHERE id = ?', byDoc.project_id)[0]
  : q<{ id: string; name: string }>("SELECT id, name FROM projects WHERE name = 'mtask四期'")[0];
// T02204：默认口径取「默认开发工具」，但它是库内可变状态（并发会话/用户在 AI 配置页一改，
// 同一道门下一轮就换了厂商）——真链路门的判据要可比，得能钉住厂商。
// T02166_AI_TOOL 写工具名（如 groq / Agnes）或 id；钉了库里没有的名字直接判缺前提，不静默回落。
const pinnedTool = process.env.T02166_AI_TOOL?.trim();
const tool = pinnedTool
  ? q<{ id: string; name: string; model: string | null }>(
    'SELECT id, name, model FROM ai_tools WHERE enabled = 1 AND (name = ? OR id = ?)', pinnedTool, pinnedTool)[0]
  : q<{ id: string; name: string; model: string | null }>(
    'SELECT id, name, model FROM ai_tools WHERE enabled = 1 ORDER BY is_default_develop DESC, updated_at DESC LIMIT 1'
  )[0];
if (!projRow || !tool) {
  writeFileSync(RESULTS_FILE, `真链路门缺前提：项目或可用 AI 工具不存在\n本轮门实例：端口 ${PORT} · 数据目录 ${DATA_DIR}\n`, 'utf8');
  console.log('missing premise', { projRow, tool });
  // T02269：这条早退同样不能让 DATA_DIR 残留（此前 exit 直接跳过收尾清理）；
  // 副本连接不先 close，Windows 下删不掉正被占用的 mask.db 句柄。
  copy.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }
  process.exit(1);
}
const PID = projRow.id;
const PNAME = projRow.name;
console.log(`真链路样本：项目「${PNAME}」 · AI 工具「${tool.name}」(${tool.model ?? '-'})`);

// ---------- 隔离实例 ----------
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR, TMPDIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

async function waitUp(ms = 120_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok && (await res.json().catch(() => null))?.service === 'mtask-server') return true;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  return false;
}
async function streamGen(path: string, body: unknown, ms = GEN_TIMEOUT_MS): Promise<{ status: number; events: Array<{ event: string; data: any }>; text: string; error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const events: Array<{ event: string; data: any }> = [];
  let status = 0;
  let error = '';
  try {
    const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    status = res.status;
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
        const dataLines = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
        if (event) events.push({ event, data: dataLines.length ? JSON.parse(dataLines.join('\n')) : null });
        i = raw.indexOf('\n\n');
      }
    }
  } catch (e) {
    // T02269：超时/中止/流解析异常折成结构化失败返回给调用侧（走 B-01 断言 + [证据] 行），
    // 不让抛出穿透整个门脚本。
    error = fmtErr(e);
  } finally {
    clearTimeout(timer);
  }
  return { status, events, text: events.map((e) => `${e.event}:${JSON.stringify(e.data)}`).join('|'), error };
}
async function download(token: string, fileName: string) {
  const res = await fetch(BASE + '/report/ai-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, filename: fileName }),
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

try {
  if (!(await waitUp())) {
    ok('A-00 隔离实例启动', false, serverLog.join('').slice(-600));
  } else {
    ok('A-00 隔离实例启动（真 AI，生产库只读副本）', true);

    // ---------- A 组：AI 大纲指代率 ----------
    // T02269：outline 是最慢的一跳（真厂商两轮生成），裸 fetch 会让超时抛出穿透整个门脚本。
    // 现在钉住超时上限并兜住异常：慢厂商只让 A 组判失败 + 落一条点名结论行，B/C 组照常跑、证据照常落盘。
    let outlineRes: Response | null = null;
    let outlineErr = '';
    try {
      outlineRes = await fetch(`${BASE}/plans/kickoff-ppt-outline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: PID, toolId: tool.id }),
        signal: AbortSignal.timeout(OUTLINE_TIMEOUT_MS),
      });
    } catch (e) {
      outlineErr = fmtErr(e);
    }
    const outlineBody = outlineRes ? (await outlineRes.json().catch(() => null)) as { outline?: Array<{ title: string; bullets: string[]; dataKeys: string[]; layout: string }>; error?: string } | null : null;
    const outline = outlineBody?.outline ?? [];
    ok('A-01 真 AI 大纲返回 200 且 ≥ 6 页', (outlineRes?.status ?? 0) === 200 && outline.length >= 6,
      outlineErr
        ? { error: `outline 调用失败：${outlineErr}`, timeoutMs: OUTLINE_TIMEOUT_MS, pages: outline.length }
        : { status: outlineRes?.status, error: outlineBody?.error, pages: outline.length });
    if (outlineErr) {
      lines.push(`[证据] outline 调用失败：${outlineErr}（超时上限 ${OUTLINE_TIMEOUT_MS}ms）· 隔离实例日志尾：${serverLog.join('').slice(-800)}`);
    }

    // T02311：A-01 失败时的证据面——厂商原始响应必须留档（raw 旁证非空），否则事后无法定性
    // 「模型输出非法转义 vs 我方预处理改坏」（T02223 复验时旁证只有解析后的 []，零原始响应）。
    // A-01 通过时无失败路径，本条空过（计数稳定为 17，现有 16 条判据与断言名不改）。
    const a01Failed = (outlineRes?.status ?? 0) !== 200 || outline.length < 6;
    let rawDumped = '';
    if (a01Failed) {
      const raws = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => f.startsWith('kickoff-outline-raw-')).sort() : [];
      if (raws.length) {
        copyFileSync(join(DATA_DIR, raws[raws.length - 1]), RAW_FILE);
        rawDumped = readFileSync(RAW_FILE, 'utf8');
      }
    }
    ok('A-01r 大纲失败时厂商原始响应已留档（raw 旁证存在且非空；A-01 通过则无失败路径）',
      !a01Failed || (existsSync(RAW_FILE) && statSync(RAW_FILE).size > 0),
      { a01Failed, rawBytes: rawDumped.length, rawTail: rawDumped.slice(-160) || undefined });

    // 库内真实名称集合（与 outlineFacts 喂给模型的口径同源）
    const names = [
      ...q<{ title: string }>('SELECT title FROM prd_requirements WHERE project_id = ? AND title IS NOT NULL', PID).map((r) => r.title),
      ...q<{ title: string }>("SELECT title FROM plan_tasks WHERE project_id = ? AND archived = 0 AND title IS NOT NULL", PID).map((r) => r.title),
    ];
    const nameKeys = new Set<string>();
    for (const n of names) {
      const clean = n.replace(/\s+/g, '');
      for (let len = 8; len >= 4; len -= 1) if (clean.length >= len) nameKeys.add(clean.slice(0, len));
    }
    const dataPages = outline.filter((o) => o.dataKeys.length > 0 && o.bullets.length > 0 && o.layout !== 'cover' && o.layout !== 'toc');
    // 「如实标注数据缺口」句不算套话：该页引用的数据源在库内**确实为空**时，
    // 「名单待补充」是可核对的真结论，反而是硬约束 7（禁止编数字）要求的写法。
    // 口径直接取装配层 collectBundle（与页面同源），源非空就不豁免——否则套话可以自称「待补充」蒙过判据。
    const facts = (await import('../server/src/services/kickoffService.ts') as unknown as {
      collectBundle: (id: string) => { assignees: unknown[]; coverage: { total: number }; requirements: unknown[]; plans: unknown[] };
    }).collectBundle(PID);
    const sourceCounts: Record<string, number> = {
      assignees: facts.assignees.length,
      coverage: facts.coverage.total,
      reqList: facts.requirements.length,
      planRows: facts.plans.length,
    };
    const gapSentence = (b: string) => /待补充|待确认|需核查|暂缺|未提供|待完善/.test(b);
    const honestGap = (page: { dataKeys: string[] }, b: string): boolean =>
      gapSentence(b) && page.dataKeys.length > 0 && page.dataKeys.every((k) => sourceCounts[k] === 0);
    const bulletPages = dataPages.flatMap((o) => o.bullets.map((b) => ({ b, page: o })));
    const allBullets = bulletPages.map((x) => x.b);
    // 「有指代」= 命中库内真实名称片段，或带可核对的具体锚点（编号/数字/量词/引号包裹的名称）。
    // 只用名称子串匹配会误伤：模型写「现状痛点：长耗时生成无 SSE 流支持」是真内容，但不是需求标题原文。
    const nameHit = (b: string): boolean => {
      const clean = b.replace(/\s+/g, '');
      for (const k of nameKeys) if (clean.includes(k)) return true;
      return false;
    };
    // T02204：占位词包在「」里**不算指代**——实测厂商拿「待补充」凑锚点配额（提示词第 12 条已明写不计数），
    // 判据若仍把它算绿，6 成阈值就成了可自证的空转。真缺口另有 honestGap 那条路：按该页 dataKeys 的源是否真空豁免。
    const anchored = (b: string): boolean =>
      nameHit(b) || /「(?!(?:待补充|待确认|需核查|暂缺|未提供|待完善|未填))[^」]{2,}」/.test(b)
      || /(T\d{4}|N\d+|P\d|v\d+(\.\d+)?|\d+(\.\d+)?\s*(条|页|字|人天|%|分钟))/.test(b);
    const withAnchor = bulletPages.filter((x) => anchored(x.b) || honestGap(x.page, x.b));
    const referred = allBullets.filter(nameHit);
    ok(`A-02a 数据页 bullets 锚点率 ≥ 60%（真实测得 ${((withAnchor.length / Math.max(1, allBullets.length)) * 100).toFixed(0)}%，${withAnchor.length}/${allBullets.length}）`,
      allBullets.length >= 6 && withAnchor.length / Math.max(1, allBullets.length) >= 0.6,
      { rate: Number((withAnchor.length / Math.max(1, allBullets.length)).toFixed(2)), miss: bulletPages.filter((x) => !anchored(x.b) && !honestGap(x.page, x.b)).map((x) => x.b).slice(0, 4) });
    const nameRate = referred.length / Math.max(1, allBullets.length);
    ok(`A-02b 直接引用库内真实名称的 bullets ≥ 3 条（实测 ${referred.length} 条，指代率 ${(nameRate * 100).toFixed(0)}%）`,
      referred.length >= 3,
      { rate: Number(nameRate.toFixed(2)), sample: allBullets.filter((b) => !nameHit(b)).slice(0, 4) });
    ok('A-03 无指代套话句式不成为多数（「各方配合」「有序推进」这类空句 ≤ 2 条）',
      allBullets.filter((b) => /各方配合|有序推进|顺利开展|高度重视|圆满成功/.test(b)).length <= 2,
      allBullets.filter((b) => /各方配合|有序推进|顺利开展|高度重视|圆满成功/.test(b)));
    // T02204：空源必须写成「缺口」而不是「结论」。承担人全空时模型抄汇总数就写出「承担人配置：0 人」，
    // 页面读起来像「本项目无人承担」，真相是库里没填——预检点名 + bullets 不出现「0 人」两头都要钉住。
    // T02269：outline 被中止后会毁掉 undici 的 keep-alive 连接，紧接着的预检 GET 实测以
    // `fetch failed / cause=ECONNRESET` 抛出（run4 复现）。预检是本地纯 DB 接口，给它短重试；
    // 拿不到 body 时按空处理，A-04 照常点名失败，不再带走 B/C 组全部证据。
    let pfBody: { items?: Array<{ key: string; note: string }> } | null = null;
    for (let i = 0; i < 3 && !pfBody; i += 1) {
      try {
        const pfRes = await fetch(`${BASE}/plans/kickoff-preflight?projectId=${PID}`, { signal: AbortSignal.timeout(30_000) });
        pfBody = (await pfRes.json().catch(() => null)) as { items?: Array<{ key: string; note: string }> } | null;
      } catch { pfBody = null; await sleep(300); }
    }
    const p3note = String((pfBody?.items ?? []).find((i) => i.key === 'P3')?.note ?? '');
    const emptyAssignees = facts.assignees.length === 0;
    const zeroHeadcount = allBullets.filter((b) => /0\s*人(?!天)/.test(b));
    const assigneeBullets = allBullets.filter((b) => /承担人/.test(b));
    ok(emptyAssignees
      ? 'A-04 空源写成缺口不写结论数（承担人 0 人未填 → 预检 P3 点名「未填承担人」，bullets 无「0 人」，写了承担人的那条要点「待补充」）'
      : 'A-04 空源口径（承担人非空，本条只核预检不误报）',
      emptyAssignees
        ? /未填承担人/.test(p3note) && zeroHeadcount.length === 0 &&
          (assigneeBullets.length === 0 || assigneeBullets.every((b) => /待补充|未填/.test(b)))
        : !/未填承担人/.test(p3note),
      { emptyAssignees: facts.assignees.length, p3note, zeroHeadcount, assigneeBullets: assigneeBullets.slice(0, 3) });
    writeFileSync(OUTLINE_FILE, JSON.stringify(outline, null, 2), 'utf8');

    // ---------- B/C 组：真 AI 生成产物 ----------
    const gen = await streamGen(`/plans/kickoff-ppt-stream?projectId=${PID}&toolId=${tool.id}`, { projectId: PID, toolId: tool.id, outline });
    const done = gen.events.find((e) => e.event === 'done')?.data;
    const warns: string[] = done?.warnings ?? [];
    ok('B-01 真 AI 措辞段成功（warnings 无「风险措辞 AI 失败」/无 JSON 解析报错）',
      !gen.error && !!done && !warns.some((w) => /措辞 AI 失败|is not valid JSON|Unexpected token/.test(w)),
      { events: gen.events.map((e) => e.event), warns: warns.slice(0, 6), error: gen.error || undefined });
    if (gen.error) {
      lines.push(`[证据] 生成流调用失败：${gen.error}（超时上限 ${GEN_TIMEOUT_MS}ms）· SSE 事件=${gen.events.map((e) => e.event).join(',')} · 隔离实例日志尾：${serverLog.join('').slice(-800)}`);
    }

    const dl = done?.token ? await download(String(done.token), String(done.fileName)) : { status: 0, buf: Buffer.alloc(0) };
    const buf = dl.buf;
    ok('C-01 产物可下载且为合法 pptx（PK 头 + 可解包）',
      buf[0] === 0x50 && buf[1] === 0x4b && buf.length > 20_000,
      { bytes: buf.length, status: dl.status, hasDone: !!done, done: done ?? null, events: gen.events.map((e) => e.event) });
    // T02204：产物缺失时把证据落进门结果再正常收口。原先直接 JSZip.loadAsync(空) 抛栈，
    // 整轮 PASS/FAIL（含 A/B 组已经跑出来的真证据）连同结果文件一起丢失——读的人只剩一段
    // stack，分不清「功能坏了」「AI 侧没出稿」「环境缺配额」，这正是判据最没用的形态。
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      lines.push(`[证据] 真产物缺失：download status=${dl.status} bytes=${buf.length} · SSE 流尾=${gen.text.slice(-600)}`);
      lines.push(`[证据] 隔离实例日志尾：${serverLog.join('').slice(-1_200)}`);
      for (const n of ['C-02', 'C-07', 'C-08', 'C-09', 'C-03', 'C-04', 'C-05', 'C-06'])
        ok(`${n} 无法实测（真产物缺失，见 C-01 证据行）`, false);
    } else {
    const zip = await JSZip.loadAsync(buf);
    const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
    const xmls: string[] = [];
    for (const n of slideNames) xmls.push(await zip.file(n)!.async('string'));
    // T02171：计划超行数会展开成时间线续页——「页码 ↔ 幻灯片」的映射一律按装配层同一口径
    // 先算出的渲染页序列，不再假设一页大纲对应一张幻灯片（否则续页会把后面的判据整体错位）。
    const builder = (await import('../server/src/services/kickoffBuilder.ts')) as unknown as {
      expandTimelinePages: (b: unknown, o: unknown[]) => Array<{ layout: string; title: string; dataKeys: string[] }>;
    };
    const renderPages = builder.expandTimelinePages(facts, outline);
    const tlRenderIdx = renderPages.map((p, i) => (p.layout === 'timeline' ? i : -1)).filter((i) => i >= 0);
    ok(`C-02 页数与渲染页一致（大纲 ${outline.length} 页 → 时间线分页后 ${renderPages.length} 页，幻灯片 ${xmls.length} 张）`,
      xmls.length === renderPages.length && renderPages.length >= outline.length,
      { slides: xmls.length, outline: outline.length, render: renderPages.length });
    ok('C-07 页脚不再出现「超出本页可排行数」（计划全部有页承载；仅时间线页数触顶时才允许留计数注）',
      !warns.some((w) => /超出本页可排行数|折成页脚提示/.test(w)) || tlRenderIdx.length >= 6,
      warns.filter((w) => /时间线|页：/.test(w)));
    ok('C-08 续页与首页同为原生甘特（每页都有轴+条，不是把剩余行塞成文字）',
      tlRenderIdx.length > 1 &&
        tlRenderIdx.every((i) => /prst="line"/.test(xmls[i]) && /prst="rect"/.test(xmls[i]) && !/<a:tbl>/.test(xmls[i])),
      tlRenderIdx.map((i) => renderPages[i].title));

    // T02172：图表压到 0.45" 是 placed 但读不出结论——实排高按类型设下限，低于下限只能整块省略并点名
    const chartsIn = (x: string) =>
      (x.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g) ?? [])
        .filter((f) => /\/chart/.test(f))
        .map((f) => Number(/<a:ext cx="(\d+)" cy="(\d+)"/.exec(f)?.[2] ?? 0) / 914_400);
    const chartHeights = xmls.flatMap(chartsIn);
    const chartDrops = warns.filter((w) => /空间不足，已省略/.test(w) && /图表/.test(w));
    ok('C-09 真产物每张图表实排高 ≥ 1.2" 可读下限；画不下的必须带 drop 留痕（placed 或点名，二选一，不许静默压扁）',
      chartHeights.every((h) => h >= 1.2 - 1e-4) && (chartHeights.length > 0 || chartDrops.length > 0),
      { heights: chartHeights.map((h) => Number(h.toFixed(2))), chartDrops });

    // 「空间不足，已省略」只允许出现在**时间线形状页**：那一页同一批里程碑已由菱形/条形承载，
    // 同页再挂一张表格是重复信息，省略它是版式取舍；其他任何页丢块都是真丢内容（必须为 0）。
    const tlPageNos = new Set(tlRenderIdx.map((i) => i + 1));
    const droppedWarns = warns.filter((w) => /空间不足，已省略/.test(w));
    const badDrops = droppedWarns.filter((w) => {
      const no = Number(/第 (\d+) 页/.exec(w)?.[1] ?? '-1');
      return !tlPageNos.has(no);
    });
    ok('C-03 非时间线页零丢块（表格收行、图表等比裁之后不再有「空间不足，已省略」）',
      badDrops.length === 0, { droppedWarns, badDrops });
    ok('C-04 无越界降级页（warnings 不含「越界/超出页面/降级为」正文页版式）',
      !warns.some((w) => /越界|超出页面/.test(w)), warns.slice(0, 8));

    // 每个**带数据块的页**都要有实质字数（章节页/封面/目录/致谢是纯版式页，不参与此判据）
    const pageTextLen = xmls.map((x) => (x.match(/<a:t>[^<]*/g) ?? []).map((s) => s.slice(4)).join('').replace(/\s/g, '').length);
    const dataIdx = renderPages.map((o, i) => (o.dataKeys.length > 0 && o.layout !== 'cover' && o.layout !== 'toc' ? i : -1)).filter((i) => i >= 0);
    const thinPages = dataIdx.filter((i) => pageTextLen[i] < 60).map((i) => ({ no: i + 1, n: pageTextLen[i] }));
    ok(`C-05 数据页正文实字（≥60 字/页），实测数据页最少 ${Math.min(...dataIdx.map((i) => pageTextLen[i]))} 字`,
      dataIdx.length >= 4 && thinPages.length === 0, { thinPages, pageTextLen });

    // 表格边界：pptx 里 graphicFrame 的 ext 高度不得越过画布底（5.625in = 5143500 EMU… 用 914400/inch）
    const EMU = 914_400;
    const violations = xmls.flatMap((x, i) => {
      const out: string[] = [];
      for (const m of x.matchAll(/<a:graphicFrame>[\s\S]*?<\/a:graphicFrame>/g)) {
        const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(m[0]);
        const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(m[0]);
        if (!off || !ext) continue;
        const bottom = Number(off[2]) / EMU + Number(ext[2]) / EMU;
        if (bottom > 5.625 - 0.05) out.push(`第 ${i + 1} 页 graphicFrame 底边 ${bottom.toFixed(2)}"`);
      }
      return out;
    });
    ok('C-06 表格/图表框底边不出画布（越页在产物层被证伪）', violations.length === 0, violations.slice(0, 5));
    }

    if (buf.length) writeFileSync(PPTX_FILE, buf);
    lines.push('', `样本项目：${PNAME} · AI 工具：${tool.name}`, `warnings（全 ${warns.length} 条）：`, ...warns.map((w) => `  · ${w}`));
  }
} catch (e) {
  // T02269：任何一处抛出（含 fetch 超时/中止未被兜住）都不能让证据丢失——已跑出的断言照旧落盘。
  fail += 1;
  lines.push(`[证据] 门脚本异常中断：${fmtErr(e)}（已跑出的断言仍落盘）`);
} finally {
  // T02269：结果文件 + 子进程/副本清理放进 finally，慢厂商崩栈时不留孤儿实例与 DATA_DIR 残留。
  writeResults();
  console.log(`T02166 真链路：PASS=${pass} FAIL=${fail}`);
  // kill 是异步的：实测子进程句柄未释放就 rmSync，88MB 副本整堆留在 DATA_DIR 里
  // （且服务端会重建 tmp/tunnel 目录，让残留更晚才被发现）。先 kill、再等它真退出（上限 5s），最后删副本。
  child.kill();
  await new Promise<void>((r) => {
    if (child.exitCode !== null || child.signalCode !== null) return r();
    const t = setTimeout(r, 5_000);
    child.once('exit', () => { clearTimeout(t); r(); });
  });
  // 门进程自己也持有一份句柄：A 组 `await import(kickoffService.ts)` 会带起 connection.ts 的模块级连接
  // （打开 DATA_DIR 副本库）。不 closeDb，本进程退出前 rmSync 一定删不干净——实测残留 88MB。
  try {
    (await import('../server/src/db/connection.ts') as unknown as { closeDb: () => void }).closeDb();
  } catch { /* 未走到 A 组时本就没有这条连接 */ }
  copy.close();
  for (let i = 0; i < 8 && existsSync(DATA_DIR); i += 1) {
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 句柄释放延迟，下一轮重试 */ }
    await sleep(400);
  }
  if (existsSync(DATA_DIR)) {
    lines.push(`[证据] DATA_DIR 仍残留（句柄 3.2s 内未释放，需手工删 ${DATA_DIR}）`);
    writeResults();
  }
}
process.exit(fail === 0 ? 0 : 1);
