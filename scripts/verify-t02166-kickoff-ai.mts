/**
 * T02166 真链路门（真实 AI，非 mock）——证三条只有真模型+真数据才成立的结论：
 *   A 组：AI 大纲的 bullets **有指代**（引用库内真实需求/计划/里程碑名），不是无指代套话（P1-1）。
 *   B 组：真实 AI 措辞段不再因尾逗号被判失败（P0-2）——warnings 里不出现「风险措辞 AI 失败」「is not valid JSON」。
 *   C 组：真产物**不再整块丢数据**（P0-1/P1-2）——无「空间不足，已省略」，无越界降级页，各页正文有实质字数。
 *          T02171 后时间线页会按版面分页：页码↔幻灯片映射按装配层的**渲染页**序列，
 *          并加 C-07「页脚不再折计数」/C-08「续页仍是原生甘特」两条承接口径。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02166-kickoff-ai.mts
 * 隔离纪律（skill 红线 8）：生产库只读副本 → D: 盘临时 DATA_DIR（C: 常年 0 可用），端口随机，收尾删副本。
 * 结果落 .workbuddy/t02166-ai-gate-results.txt 与 t02166-ai.pptx（人工抽查）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import Database from 'better-sqlite3';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02166AI_PORT ?? 41_600 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
const DATA_DIR = join(OUT_DIR, 't02166-ai-data');
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(join(DATA_DIR, 'tmp'), { recursive: true });
process.env.MTask_DATA_DIR = DATA_DIR;
process.env.TMPDIR = DATA_DIR;

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 500)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const tool = q<{ id: string; name: string; model: string | null }>(
  'SELECT id, name, model FROM ai_tools WHERE enabled = 1 ORDER BY is_default_develop DESC, updated_at DESC LIMIT 1'
)[0];
if (!projRow || !tool) {
  writeFileSync(join(OUT_DIR, 't02166-ai-gate-results.txt'), '真链路门缺前提：项目或可用 AI 工具不存在\n', 'utf8');
  console.log('missing premise', { projRow, tool });
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
async function streamGen(path: string, body: unknown, ms = 600_000): Promise<{ status: number; events: Array<{ event: string; data: any }>; text: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const events: Array<{ event: string; data: any }> = [];
  let status = 0;
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
  } finally {
    clearTimeout(timer);
  }
  return { status, events, text: events.map((e) => `${e.event}:${JSON.stringify(e.data)}`).join('|') };
}
async function download(token: string, fileName: string) {
  const res = await fetch(BASE + '/report/ai-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, filename: fileName }),
  });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

if (!(await waitUp())) {
  ok('A-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('A-00 隔离实例启动（真 AI，生产库只读副本）', true);

  // ---------- A 组：AI 大纲指代率 ----------
  const outlineRes = await fetch(`${BASE}/plans/kickoff-ppt-outline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: PID, toolId: tool.id }),
  });
  const outlineBody = (await outlineRes.json().catch(() => null)) as { outline?: Array<{ title: string; bullets: string[]; dataKeys: string[]; layout: string }>; error?: string } | null;
  const outline = outlineBody?.outline ?? [];
  ok('A-01 真 AI 大纲返回 200 且 ≥ 6 页', outlineRes.status === 200 && outline.length >= 6,
    { status: outlineRes.status, error: outlineBody?.error, pages: outline.length });

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
  const anchored = (b: string): boolean =>
    nameHit(b) || /「[^」]{2,}」/.test(b) || /(T\d{4}|N\d+|P\d|v\d+(\.\d+)?|\d+(\.\d+)?\s*(条|页|字|人天|%|分钟))/.test(b);
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
  writeFileSync(join(OUT_DIR, 't02166-ai-outline.txt'), JSON.stringify(outline, null, 2), 'utf8');

  // ---------- B/C 组：真 AI 生成产物 ----------
  const gen = await streamGen(`/plans/kickoff-ppt-stream?projectId=${PID}&toolId=${tool.id}`, { projectId: PID, toolId: tool.id, outline });
  const done = gen.events.find((e) => e.event === 'done')?.data;
  const warns: string[] = done?.warnings ?? [];
  ok('B-01 真 AI 措辞段成功（warnings 无「风险措辞 AI 失败」/无 JSON 解析报错）',
    !!done && !warns.some((w) => /措辞 AI 失败|is not valid JSON|Unexpected token/.test(w)),
    { events: gen.events.map((e) => e.event), warns: warns.slice(0, 6) });

  const buf = done?.token ? (await download(String(done.token), String(done.fileName))).buf : Buffer.alloc(0);
  ok('C-01 产物可下载且为合法 pptx（PK 头 + 可解包）',
    buf[0] === 0x50 && buf[1] === 0x4b && buf.length > 20_000, { bytes: buf.length });
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

  if (buf.length) writeFileSync(join(OUT_DIR, 't02166-ai.pptx'), buf);
  lines.push('', `样本项目：${PNAME} · AI 工具：${tool.name}`, `warnings（全 ${warns.length} 条）：`, ...warns.map((w) => `  · ${w}`));
}

writeFileSync(join(OUT_DIR, 't02166-ai-gate-results.txt'), `T02166 真链路门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
console.log(`T02166 真链路：PASS=${pass} FAIL=${fail}`);
child.kill();
copy.close();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }
process.exit(fail === 0 ? 0 : 1);
