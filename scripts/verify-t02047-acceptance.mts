/**
 * T02047（PRD-估算视图 §9 非功能需求 + §12 风险逐项复验）验收门。
 *
 * 用法（与 E4b/E6/E9 同写法，Node 版本须与 better-sqlite3 的 ABI 对齐）：
 *   <node> node_modules/tsx/dist/cli.mjs scripts/verify-t02047-acceptance.mts
 * 环境变量：`T02047_PORT`（默认 39948）、`T02047_SKIP_COM=1` 跳过 §9 第③轨（Excel COM 重算）。
 *
 * 本门不复述各实施单的功能断言（那些归 E2/E4/E5/E6/E7/E9/E10 各门），只覆盖 §9 表格里
 * 「按维度」而非「按交付项」的那几行，以及 §12 风险表里可以在本机复验的条目：
 *
 *   A 组 §9 正确性·三轨之①公式轨 ②缓存轨 + §12-R8「双写」+ R1 常量 + R2 等价 + R5 件面脱敏；
 *   B 组 §9 正确性·三轨 ③重算轨（真 Excel `CalculateFull()` 后回读 `Value2` 与②比对），
 *      并保留 E0 Spike 的反证法：**故意篡改一条缓存值，③轨必须抓到偏差**——
 *      否则无法证明这一轨不是空转（§12-R7 的假阳性面）；
 *   S 组 源码守卫：§9 安全（服务端脱敏、导出闸门）、可维护（引擎单源）、§12-R4 字体、R6 会话键分区；
 *   R 组 隔离实例 REST：§9 性能四项在 500 行规模计时、数据一致（删除估算不动排期、软归档不级联、
 *      计划彻底删除后估算行保留且清理是显式动作）、R1 参数误改防护（范围校验 + 件面常量随参数走）、
 *      上线度量三项出数（导出次数 / 人工复核率 / 覆盖项目数）。
 *
 * 隔离纪律（skill 红线 8）：库与端口都是临时的，不碰生产数据目录；跑完 kill + 回收临时目录。
 * 真机侧（面板首屏渲染计时、三档视口、键盘可达、R6 视图切换回归）见 scripts/verify-t02047-ui.mjs。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02047-acc-'));
// 端口每次随机（定值 39948 实测撞过 Windows 动态端口保留区：子进程起不来还只留空日志，白跑一轮）
const PORT = Number(process.env.T02047_PORT ?? 39000 + Math.floor(Math.random() * 1000));
process.env.MTask_DATA_DIR = DATA_DIR;

const PizZip = (await import('pizzip')).default;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const E = await import('../server/src/services/estimate-engine.ts');
const X = await import('../server/src/services/estimateExportXlsx.ts');

type Row = Parameters<typeof X.layoutEstimate>[0]['rows'][number];
type Phase = Row['phase'];

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  }
};
const skipped = (name: string, why: string) => { skip += 1; console.log(`  [SKIP] ${name} —— ${why}`); };
const group = (t: string) => console.log(`\n=== ${t} ===`);
const near = (a: number, b: number, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PANEL_SRC = read('web', 'src', 'components', 'EstimatePanel.tsx');
const PLAN_PAGE_SRC = read('web', 'src', 'pages', 'PlanPage.tsx');
const API_SRC = read('web', 'src', 'api', 'estimates.ts');
const ROUTE_SRC = read('server', 'src', 'routes', 'estimates.ts');
const XLSX_SRC = read('server', 'src', 'services', 'estimateExportXlsx.ts');
const PDF_SRC = read('server', 'src', 'services', 'estimateExportPdf.ts');
const PRD_EXPORT_SRC = read('server', 'src', 'services', 'prdExport.ts');
const CODE = { panel: stripComments(PANEL_SRC), api: stripComments(API_SRC), route: stripComments(ROUTE_SRC) };

/** 源码清单（单源守卫要跨文件数出现次数；只扫生产码，不扫 scripts/ 里的历史断言） */
function listSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) listSources(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const SOURCES = [...listSources(join(ROOT, 'server', 'src')), ...listSources(join(ROOT, 'web', 'src'))];
const filesWith = (needle: string) => SOURCES.filter((f) => readFileSync(f, 'utf8').includes(needle));
const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// 导出件构造（同进程，地址全部取自 layout 返回值，不写死 R35/R40）
// ---------------------------------------------------------------------------
const CFG: import('../server/src/services/estimate-engine.ts').EstimateConfig = { ...E.DEFAULT_ESTIMATE_CONFIG };
const STD = CFG.manDaysPerManMonth;
const COEF_SUM = E.ESTIMATE_COEF_KEYS.reduce((a, k) => a + CFG.coefs[k], 0);

const mk = (over: Partial<Row> & { planId: string; phase: Phase }): Row => ({
  title: over.planId,
  detail: `验收夹具 ${over.planId}：三点值已知，便于独立重算。`,
  planKind: 'normal',
  milestone: '',
  optimistic: null,
  likely: null,
  pessimistic: null,
  source: 'manual',
  complexity: null,
  reqNos: [],
  ...over,
});

/** 六个阶段都有明细；开发段 8 行；三点值全部可手工验算 */
const DEV_PTS: Array<[number, number, number]> = [
  [2, 3, 4], [1, 2, 3], [4, 6, 12], [3, 3, 3], [2, 5, 14], [1, 4, 7], [5, 5, 8], [0.5, 1, 2.5],
];
const ROWS: Row[] = [
  mk({ planId: 'a-req', phase: 'req', optimistic: 5, likely: 8, pessimistic: 11 }),
  mk({ planId: 'a-design', phase: 'design', optimistic: 3, likely: 5, pessimistic: 9 }),
  ...DEV_PTS.map(([o, m, p], i) => mk({
    planId: `a-dev-${i + 1}`,
    phase: 'dev',
    milestone: i < 4 ? 'MS-A' : 'MS-B',
    optimistic: o,
    likely: m,
    pessimistic: p,
    source: i % 3 === 0 ? 'rule' : 'manual',
  })),
  mk({ planId: 'a-impl', phase: 'impl', optimistic: 2, likely: 4, pessimistic: 6 }),
  mk({ planId: 'a-common', phase: 'common', optimistic: 1, likely: 1, pessimistic: 3 }),
  mk({ planId: 'a-onsite', phase: 'onsite', optimistic: 2, likely: 2, pessimistic: 4 }),
];
const mkInput = (over: Record<string, unknown> = {}) => ({
  projectId: 'p-fixture',
  projectName: 'T02047 验收夹具项目',
  estimateDate: '2026-10-12',
  reviewer: '验收脚本',
  rows: ROWS,
  config: CFG,
  scope: 'all',
  audience: 'internal',
  generatedAt: '2026-10-12T00:00:00.000Z',
  ...over,
});
const LAYOUT = X.layoutEstimate(mkInput() as never);
const BUF = await X.buildEstimateXlsx(LAYOUT);

const unzip = (buf: Buffer) => (new (PizZip as any)(buf as unknown as ArrayBuffer) as {
  file: (n: string, data?: string) => { asText(): string } | null;
  generate: (o: { type: string }) => Uint8Array;
});
const mainXml = (buf: Buffer) => String(unzip(buf).file('xl/worksheets/sheet1.xml')?.asText() ?? '');
const wbXml = (buf: Buffer) => String(unzip(buf).file('xl/workbook.xml')?.asText() ?? '');
interface XmlCell { f: string; v: string; t: string; }
function parseCells(xml: string): Map<string, XmlCell> {
  const out = new Map<string, XmlCell>();
  // 必须同时吃「自闭合格」（`<c r="C20" s="6"/>` 是合并区非锚点格的形态）：
  // 只按 `>...</c>` 匹配会让自闭合格吞掉下一格的 `</c>`，整行读数错位（本门第一版就是这么漏掉 E20/E25 的）
  const re = /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[3] ?? '';
    const f = /<f[^>]*>(.*?)<\/f>/s.exec(body)?.[1] ?? '';
    const v = /<v>(.*?)<\/v>/s.exec(body)?.[1] ?? '';
    // t="s" 是共享字符串表头格（`<v>` 存的是索引号不是数），公式轨/缓存轨只管数字格
    const t = / t="([^"]+)"/.exec(m[2] ?? '')?.[1] ?? '';
    out.set(m[1], { f, v, t });
  }
  return out;
}
const CELLS = parseCells(mainXml(BUF));
const sumE = (o: number, m: number, p: number) => (o + 4 * m + p) / 6;

/**
 * 「本该是公式」的格子清单（与渲染层一一对应，不含 E/F/G 这类录入常量列）：
 * 阶段行 H/I、开发明细 H、小计行 E~H + 段首 I（开发段 I 是**单格纵向合并**，只有首格有公式）、
 * 汇总行 E~I、系数行 H/I、实际预估行 E~I。
 */
const FORMULA_ADDRS: string[] = [];
for (const p of LAYOUT.phaseRows) if (p.points) FORMULA_ADDRS.push(`H${p.rowNo}`, `I${p.rowNo}`);
for (const d of LAYOUT.devRows) if (d.points) FORMULA_ADDRS.push(`H${d.rowNo}`);
if (LAYOUT.devRows.length > 0) FORMULA_ADDRS.push(`I${LAYOUT.devRows[0].rowNo}`);
if (LAYOUT.subtotalRow) {
  const s = LAYOUT.subtotalRow.rowNo;
  FORMULA_ADDRS.push(`E${s}`, `F${s}`, `G${s}`, `H${s}`);
}
for (const c of ['E', 'F', 'G', 'H', 'I']) FORMULA_ADDRS.push(`${c}${LAYOUT.totalRow}`);
for (const c of LAYOUT.coefRows) FORMULA_ADDRS.push(`H${c.rowNo}`, `I${c.rowNo}`);
for (const c of ['E', 'F', 'G', 'H', 'I']) FORMULA_ADDRS.push(`${c}${LAYOUT.actualRow}`);


/** 件面「人天」侧的逐行 E 之和（明细 + 阶段行，小计行不算独立行——SUBTOTAL 天然跳过嵌套） */
/** 汇总行 H 的两个口径都提到模块作用域：A-13/B-03 的客户版与篡改轨都要与它比 */
const ROW_E_SUM = LAYOUT.devRows.filter((d) => d.points)
  .reduce((a, d) => a + sumE(d.points!.optimistic, d.points!.likely, d.points!.pessimistic), 0)
  + LAYOUT.phaseRows.filter((p) => p.points)
    .reduce((a, p) => a + sumE(p.points!.optimistic, p.points!.likely, p.points!.pessimistic), 0);

/** R35 是「人月」口径（模板 B35 文案：单位工作人月；公式 SUBTOTAL(9,H6:H34)/每人月工天标准） */
const RECALC_TOTAL_H = ROW_E_SUM / STD;
const GOT_TOTAL_H = Number(CELLS.get(`H${LAYOUT.totalRow}`)?.v);

// ---------------------------------------------------------------------------
group('A 组 §9 正确性·三轨之①公式轨 + ②缓存轨（含 §12-R8 双写、R1 常量、R7 断言基座）');
{
  const noFormula = FORMULA_ADDRS.filter((a) => !CELLS.get(a)?.f);
  ok('A-01 每一格「本该是公式」的位置都真的有 `<f>`', noFormula.length === 0 && FORMULA_ADDRS.length >= 30,
    { missing: noFormula, n: FORMULA_ADDRS.length });
  ok('A-01b 断言侧解析器自测（§12-R7 的假阴性面）：自闭合格不会吞掉下一格的读数',
    (CELLS.get(`C${LAYOUT.totalRow}`)?.f ?? '') === '' && (CELLS.get(`C${LAYOUT.totalRow}`)?.v ?? '') === ''
    && (CELLS.get(`E${LAYOUT.totalRow}`)?.f ?? '').startsWith('SUBTOTAL('),
    { C20: CELLS.get(`C${LAYOUT.totalRow}`), E20: CELLS.get(`E${LAYOUT.totalRow}`)?.f?.slice(0, 40) });
  const withEq = FORMULA_ADDRS.filter((a) => (CELLS.get(a)?.f ?? '').startsWith('='));
  ok('A-02 公式串无前导 `=`（§11.1 红线 1：带 `=` 会写成非规范形态、两次读取不一致）', withEq.length === 0, withEq);
  const noCache = FORMULA_ADDRS.filter((a) => (CELLS.get(a)?.v ?? '') === '');
  ok('A-03 §12-R8 的缓解方案落地即「双写」：带公式的格子同时带缓存值 `<v>`（预览类查看器读得到数字）',
    noCache.length === 0, noCache);
  ok('A-04 打开即重算：workbook.xml 的 calcPr 带 fullCalcOnLoad',
    /fullCalcOnLoad="1"|fullCalcOnLoad="true"/.test(wbXml(BUF)), wbXml(BUF).slice(0, 300));
  const names: Array<[string, string]> = [];
  const dn = /<definedName[^>]*name="([^"]+)"[^>]*>([^<]+)<\/definedName>/g;
  let dm: RegExpExecArray | null;
  while ((dm = dn.exec(wbXml(BUF)))) names.push([dm[1], dm[2]]);
  ok('A-05 §12-R1（D1 裁决 20.83）三处同源：引擎默认值 = 件内命名区域常量 = 本门读取值',
    E.DEFAULT_ESTIMATE_CONFIG.manDaysPerManMonth === 20.83 && STD === 20.83
    && names.some(([n, r]) => n === X.NAMED_RANGE_STD && r === String(20.83)), { names, std: STD });
  ok('A-05b §12-R1 命名区域带原文注释（红线 5：客户复核时依据不能只剩一个孤零零的数）',
    wbXml(BUF).includes(X.NAMED_RANGE_STD_COMMENT.slice(0, 18)), wbXml(BUF).slice(0, 400));
  const hBad: string[] = [];
  for (const d of LAYOUT.devRows) {
    if (!d.points) continue;
    const want = sumE(d.points.optimistic, d.points.likely, d.points.pessimistic);
    if (!near(Number(CELLS.get(`H${d.rowNo}`)?.v), want, 1e-9)) hBad.push(`H${d.rowNo}:${CELLS.get(`H${d.rowNo}`)?.v}!=${want}`);
  }
  for (const p of LAYOUT.phaseRows) {
    if (!p.points) continue;
    const want = sumE(p.points.optimistic, p.points.likely, p.points.pessimistic);
    if (!near(Number(CELLS.get(`H${p.rowNo}`)?.v), want, 1e-9)) hBad.push(`H${p.rowNo}:${CELLS.get(`H${p.rowNo}`)?.v}!=${want}`);
  }
  ok('A-06 明细/阶段 H 列缓存值 = 本脚本按 §4.2 标准式独立重算值（1e-9，不用被测代码当期望值）',
    hBad.length === 0, hBad);
  // R35 是「人月」口径（模板 B35 文案：单位工作人月；公式 SUBTOTAL(9,H6:H34)/每人月工天标准）
  ok('A-07 汇总行 H 缓存值 = 逐行 E 之和 ÷ 人月标准（小计行被嵌套 SUBTOTAL 天然排除，§10-14 的件侧一半）',
    near(GOT_TOTAL_H, RECALC_TOTAL_H, 1e-6) && near(Number(CELLS.get(`H${LAYOUT.subtotalRow!.rowNo}`)?.v),
      LAYOUT.devRows.filter((d) => d.points).reduce((a, d) => a + sumE(d.points!.optimistic, d.points!.likely, d.points!.pessimistic), 0), 1e-6),
    { GOT_TOTAL_H, RECALC_TOTAL_H, subtotal: CELLS.get(`H${LAYOUT.subtotalRow!.rowNo}`)?.v });
  const gotActualH = Number(CELLS.get(`H${LAYOUT.actualRow}`)?.v);
  ok('A-08 实际预估行 H = 汇总 H ×(1+Σ系数)，且四条系数在件里是四行公式而不是拍平的一个数',
    near(gotActualH, RECALC_TOTAL_H * (1 + COEF_SUM), 1e-6) && LAYOUT.coefRows.length === 4,
    { got: gotActualH, want: RECALC_TOTAL_H * (1 + COEF_SUM), coefs: LAYOUT.coefRows.map((c) => c.value) });
  ok('A-09 实际预估 I（件面 I40 位）缓存值 ≈ 100%（§10-8 的件侧读数，阶段比例 + 系数比例合起来收口）',
    near(Number(CELLS.get(`I${LAYOUT.actualRow}`)?.v), 1, 0.01), CELLS.get(`I${LAYOUT.actualRow}`)?.v);
  const ratioSumBad = LAYOUT.devRows.filter((d) => d.points)
    .filter((d) => !near(Number(CELLS.get(`I${LAYOUT.devRows[0].rowNo}`)?.v), LAYOUT.summary.phases.find((q) => q.phase === 'dev')!.ratio, 1e-9));
  ok('A-09b 开发段合并首格 I = 引擎 dev 阶段比例（合并区只落首格这一件事没有第二套口径）',
    ratioSumBad.length === 0, { first: LAYOUT.devRows[0].rowNo, v: CELLS.get(`I${LAYOUT.devRows[0].rowNo}`)?.v });
}

group('A 组补充 §12-R2：模板原式与标准式逐值等价 + 件面确实是原式');
{
  const probes: Array<[number, number, number]> = [[1, 1, 1], [2, 3, 4], [0.5, 1, 2.5], [1, 5, 9], [3, 3, 3],
    [4, 6, 12], [1, 2, 9], [5, 5, 8], [2, 5, 14], [0, 0, 0], [7, 8, 9], [1, 4, 7]];
  const bad = probes.filter(([o, m, p]) => Math.abs(E.expected({ optimistic: o, likely: m, pessimistic: p })
    - E.expectedByTemplateFormula({ optimistic: o, likely: m, pessimistic: p })) > 1e-12);
  ok('A-10 R2：导出写模板原式（MIN/MAX 定位极值）、面板算标准式，二者在 12 组探针上逐值等价',
    bad.length === 0, bad);
  const fH = CELLS.get(`H${LAYOUT.devRows[0].rowNo}`)?.f ?? '';
  ok('A-11 R2：件里 H 列公式串确实是模板形态（含 MIN/MAX/COUNTA），不是把标准式硬编码进去',
    /MIN\(/.test(fH) && /MAX\(/.test(fH) && /COUNTA\(/.test(fH), fH);
}

group('A 组补充 §12-R5 / §9 安全：客户版脱敏是**件面事实**而不是前端隐藏');
{
  const clientLayout = X.layoutEstimate(mkInput({ audience: 'client' }) as never);
  const clientBuf = await X.buildEstimateXlsx(clientLayout);
  const cw = wbXml(clientBuf);
  ok('A-12 R5：客户版件里根本没有两个内部 sheet（不是产了再隐藏）',
    !cw.includes(X.SHEET_DETAIL) && !cw.includes(X.SHEET_PARAMS) && cw.includes(X.SHEET_MAIN),
    { sheets: cw.match(/<sheet [^>]*>/g)?.length });
  ok('A-12b R5：客户版不写备注三条（附录 A 的第 2 条本身就是「交客户前应屏蔽」的自证）',
    clientLayout.remarkRow === null && !mainXml(clientBuf).includes(X.TEMPLATE_TEXTS.remarks.slice(0, 4)),
    { remarkRow: clientLayout.remarkRow });
  const cCells = parseCells(mainXml(clientBuf));
  ok('A-13 R5：脱敏不改报价数——同一份输入下内部版与客户版的 R40（实际预估人月）逐格同值',
    near(Number(cCells.get(`H${clientLayout.actualRow}`)?.v), Number(CELLS.get(`H${LAYOUT.actualRow}`)?.v), 1e-9)
    && near(Number(cCells.get(`H${clientLayout.totalRow}`)?.v), GOT_TOTAL_H, 1e-9),
    { client: cCells.get(`H${clientLayout.actualRow}`)?.v, internal: CELLS.get(`H${LAYOUT.actualRow}`)?.v });
  const foldedLayout = X.layoutEstimate(mkInput({ audience: 'client', config: { ...CFG, hideCoefsForClient: true } }) as never);
  const foldedBuf = await X.buildEstimateXlsx(foldedLayout);
  const foldedCells = parseCells(mainXml(foldedBuf));
  ok('A-14 R5：开「系数折叠」后四个系数并成一行合计（Σ系数不变），R40 报价数一分不差',
    foldedLayout.coefRows[0].label === X.TEMPLATE_TEXTS.foldedCoef
    && near(foldedLayout.coefRows.reduce((a, c) => a + c.value, 0), COEF_SUM, 1e-12)
    && near(Number(foldedCells.get(`H${foldedLayout.actualRow}`)?.v), Number(CELLS.get(`H${LAYOUT.actualRow}`)?.v), 1e-9),
    { labels: foldedLayout.coefRows.map((c) => c.label), values: foldedLayout.coefRows.map((c) => c.value) });
}

// ---------------------------------------------------------------------------
group('B 组 §9 正确性·三轨之③重算轨（真 Excel CalculateFull 后回读 Value2）');
{
  const cells = FORMULA_ADDRS.map((a) => ({ addr: a, cached: Number(CELLS.get(a)?.v ?? 'NaN') }));
  const xlsxPath = join(DATA_DIR, 't02047-internal.xlsx');
  const tamperedPath = join(DATA_DIR, 't02047-tampered.xlsx');
  const cellsPath = join(DATA_DIR, 't02047-cells.json');
  const outPath = join(DATA_DIR, 't02047-recalc.json');
  const outTampered = join(DATA_DIR, 't02047-recalc-tampered.json');
  writeFileSync(xlsxPath, BUF);
  writeFileSync(cellsPath, JSON.stringify(cells));

  // 反证夹具：把汇总行 H 的缓存值改成 999（公式原样保留）——②轨会放行，只有③轨能抓到
  const target = `H${LAYOUT.totalRow}`;
  const before = mainXml(BUF);
  const xml = before.replace(new RegExp(`<c r="${target}"[^>]*>.*?</c>`, 's'), (m) => m.replace(/<v>[^<]*<\/v>/, '<v>999</v>'));
  ok('B-00a 篡改夹具确实生效（否则 B-03 会空转通过）', xml !== before && /<v>999<\/v>/.test(xml), { target });
  const tzip = unzip(BUF);
  tzip.file('xl/worksheets/sheet1.xml', xml);
  writeFileSync(tamperedPath, Buffer.from(tzip.generate({ type: 'uint8array' } as never)));
  // zip 往返后再读一次：字符串层面改对了不代表写进件里了（B-03 的空转面就在这）
  const tCells = parseCells(mainXml(readFileSync(tamperedPath)));
  ok('B-00b 篡改确实进了件（只改缓存值、公式原样）——③轨要抓的就是这个形态',
    tCells.get(target)?.v === '999' && tCells.get(target)?.f === CELLS.get(target)?.f,
    { target, stored: tCells.get(target)?.v, formulaKept: tCells.get(target)?.f === CELLS.get(target)?.f });

  const ps1 = join(ROOT, 'scripts', 'verify-t02047-recalc.ps1');
  const runPs = (file: string, out: string) => spawnSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, file, cellsPath, out],
    { encoding: 'utf8', timeout: 240_000 });
  if (process.env.T02047_SKIP_COM) {
    skipped('B-01/B-02/B-03 Excel COM 重算轨', '显式 T02047_SKIP_COM=1（§9 v2.1 口径：这一轨不进 CI，本机实测一次即算取证）');
  } else {
    const r1 = runPs(xlsxPath, outPath);
    if (r1.status !== 0) {
      ok('B-01 本机 Excel COM 可用（③轨的前提；不可用则如实记为「本机不可达 → 客户机抽查归 T02085」）', false,
        { status: r1.status, err: (r1.stderr ?? '').slice(0, 300), out: (r1.stdout ?? '').slice(0, 200) });
    } else {
      const j = JSON.parse(readFileSync(outPath, 'utf8')) as { ok: boolean; error?: string; engine?: string; cells?: Record<string, { cached: number; recalc: number | null; raw?: string }> };
      ok('B-01 本机 Excel COM 可用并完成全表重算', j.ok === true, j.error);
      const entries = Object.entries(j.cells ?? {});
      const diffs = entries.filter(([, v]) => v.recalc === null || Math.abs(v.recalc - v.cached) > 1e-6)
        .map(([a, v]) => `${a}: cached=${v.cached} recalc=${v.recalc}`);
      ok('B-02 ③轨与②轨逐格同值（±1e-6）：件里写进去的缓存值就是 Excel 自己算出来的值',
        entries.length === FORMULA_ADDRS.length && diffs.length === 0, { n: entries.length, want: FORMULA_ADDRS.length, diffs });
      const r2 = runPs(tamperedPath, outTampered);
      const j2 = r2.status === 0 ? JSON.parse(readFileSync(outTampered, 'utf8')) as typeof j : null;
      const caught = j2?.cells?.[target]?.recalc;
      // ps1 里的 `cached` 是 Excel 打开后读到的值——件带 fullCalcOnLoad，打开即重算，所以它等于 recalc
      // 而不是件里存的 `<v>`。②轨看到的 999 由 B-00b 从件里直读，两轨各自的读数不混用（§12-R7 的能力边界）
      ok('B-03 反证：件里存的缓存值 999 与 Excel 重算值分离（③轨能把「写进去的数」和「Excel 算出来的数」分开看）',
        tCells.get(target)?.v === '999' && Number.isFinite(caught) && Math.abs(caught! - 999) > 0.01
        && Math.abs(caught! - GOT_TOTAL_H) < 1e-6,
        { target, storedInFile: tCells.get(target)?.v, excelRecalc: caught, want: GOT_TOTAL_H, excelReadback: j2?.cells?.[target]?.cached });
      const iAddr = `I${LAYOUT.actualRow}`;
      const iRecalc = j?.cells?.[iAddr]?.recalc;
      ok('B-04 §12-R7 实证面（本轮改掉的真缺陷）：自检格（模板 I40）不用嵌套 SUBTOTAL 原式——Excel 实测 `SUBTOTAL(9,I35:I39)` 只算出 Σ系数 0.187（②轨按代数放行），改 SUM 后 ②③ 同值为 100%，与面板「Σ估算比例」读数一致',
        (CELLS.get(iAddr)?.f ?? '').startsWith('SUM(') && near(Number(CELLS.get(iAddr)?.v), Number(iRecalc), 1e-6)
        && near(Number(iRecalc), 1, 1e-6),
        { addr: iAddr, formula: CELLS.get(iAddr)?.f, cached: CELLS.get(iAddr)?.v, recalc: iRecalc });
      console.log(`  [INFO] ③轨引擎：${j.engine}；抽样格数 ${entries.length}；篡改轨：${target} 件内存 999 → Excel 重算 ${caught}；自检格 ${iAddr}=${iRecalc}`);
    }
  }
}

// ---------------------------------------------------------------------------
group('S 组 源码守卫：§9 安全 / 可维护、§12-R4 字体、R6 会话键分区');
{
  ok('S-01 §9 安全·客户版分支在**服务端**两个构建器里（前端隐藏不算脱敏）',
    /audience\s*===\s*'client'/.test(stripComments(XLSX_SRC)) && /audience\s*===\s*'client'/.test(stripComments(PDF_SRC)));
  const audLines = CODE.panel.split('\n').filter((l) => l.includes('audience'));
  const trimmed = audLines.filter((l) => /\.filter\(|\.slice\(|\.splice\(|delete\s/.test(l));
  ok('S-02 §9 安全·面板/取数层没有按受众裁剪数据的行为（audience 只进 radio 与 query）',
    trimmed.length === 0 && audLines.length > 0 && !/audience\s*===\s*'client'/.test(CODE.api),
    { panelAudienceLines: audLines.length, trimmed: trimmed.slice(0, 3) });
  ok('S-03 §9 安全·两枚导出端点都挂 exportGate（不是各自裸奔）',
    (ROUTE_SRC.match(/exportGate/g) ?? []).length >= 2 && /export-xlsx/.test(ROUTE_SRC) && /export-pdf/.test(ROUTE_SRC),
    (ROUTE_SRC.match(/exportGate[^\n]*/g) ?? []).slice(0, 4));
  ok('S-04 §9 可维护·PERT/σ 算式只存在于引擎：面板与取数层源码里没有 (o+4m+p)/6、没有 Math.sqrt',
    !/4\s*\*/.test(CODE.panel) && !/Math\.sqrt/.test(CODE.panel) && !/Math\.sqrt/.test(CODE.api));
  ok('S-05 §9 可维护·系数键/标签/默认值单源在引擎（E13 参数页不得再抄一份）',
    filesWith('export const ESTIMATE_COEF_KEYS').map(rel).join() === 'server/src/services/estimate-engine.ts'
    && filesWith('客户协作配合/磨合调节').map(rel).join() === 'server/src/services/estimate-engine.ts'
    && filesWith(`manDaysPerManMonth: 20.83`).map(rel).join() === 'server/src/services/estimate-engine.ts',
    {
      keys: filesWith('export const ESTIMATE_COEF_KEYS').map(rel),
      labels: filesWith('客户协作配合/磨合调节').map(rel),
      std: filesWith('manDaysPerManMonth: 20.83').map(rel),
    });
  ok('S-05b §9 可维护·八个估算参数键名单源（`estimate.coef.collaboration` 字面量只出现在引擎）',
    filesWith(`'estimate.coef.collaboration'`).map(rel).join() === 'server/src/services/estimate-engine.ts',
    filesWith(`'estimate.coef.collaboration'`).map(rel));
  const PDF_CODE = stripComments(PDF_SRC);
  // T02155：估算 PDF 要「正文渲染完再逐张画图」，整件封装的 buildPrdPdf 表达不了这个时序，
  // 改为复用同一条链的下层出口（newPdfDoc 建 doc + renderMdPdf 渲正文，字体守卫仍只在 prdExport 里）。
  // 门禁意图不变（§12-R4 / 裁决 D4：不开第二套字体加载），只是把「链」的名字改成实际调用的出口。
  ok('S-06 §12-R4·估算 PDF 复用 `prdExport` 渲染链（buildPrdPdf 或 newPdfDoc+renderMdPdf），代码里不出现第二套字体加载（裁决 D4 的落点）',
    /buildPrdPdf|newPdfDoc/.test(PDF_CODE) && /renderMdPdf/.test(PDF_CODE)
    && !/simhei|Fonts[\\/]\/|registerFont/.test(PDF_CODE),
    PDF_CODE.match(/font[^\n]{0,80}/gi)?.slice(0, 3));
  ok('S-06b §12-R4·字体守卫在渲染链里且是「win32 + existsSync」双条件（非 Windows 不崩，PDF 定位为预览）',
    /existsSync/.test(PRD_EXPORT_SRC) && /simhei/i.test(PRD_EXPORT_SRC)
    && /process\.platform\s*===\s*'win32'/.test(PRD_EXPORT_SRC),
    PRD_EXPORT_SRC.match(/(process\.platform|existsSync)[^\n]{0,70}/g)?.slice(0, 4));
  ok('S-07 §12-R6·面板会话键独立且唯一（`plan.estimatePanelOpen` 不与 viewMode/collapsedMs 共名或复用）',
    (stripComments(PLAN_PAGE_SRC).match(/'plan\.estimatePanelOpen'/g) ?? []).length === 1
    && /'plan\.viewMode'/.test(PLAN_PAGE_SRC) && /'plan\.collapsedMs'/.test(PLAN_PAGE_SRC)
    && !/estimatePanelOpen/.test(stripComments(PANEL_SRC)),
    { keys: stripComments(PLAN_PAGE_SRC).match(/'plan\.[A-Za-z]+'/g)?.slice(0, 8) });
  ok('S-08 §9 可访问性·面板带语义标注（role=toolbar/region/status/alert/group + 区间条 role=img aria-label）',
    /role="toolbar"/.test(PANEL_SRC) && /role="region" aria-label="估算导出区"/.test(PANEL_SRC)
    && /role="status"/.test(PANEL_SRC) && /role="alert"/.test(PANEL_SRC)
    && /role="img"/.test(PANEL_SRC) && /aria-label=\{`区间条/.test(PANEL_SRC),
    (PANEL_SRC.match(/role="[a-z]+"/g) ?? []).slice(0, 8));
}

// ---------------------------------------------------------------------------
group('R 组 隔离实例 REST：§9 性能（500 行）/ 数据一致 / R1 参数防护 / 上线度量');

const db = getDb();
initSchema();
const T = '2026-10-11T00:00:00.000Z';
const insProj = db.prepare(`INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, '', ?, ?)`);
const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, start_date, end_date, duration_days, progress, status, sort_order,
     created_at, updated_at, kind, complexity, deps)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
insProj.run('p-acc', 'T02047 验收项目', T, T);
const shift = (n: number) => new Date(Date.UTC(2026, 9, 12 + n, 0, 0, 0)).toISOString().slice(0, 10);
const accPlans: Array<[string, string, number | null]> = [
  ['acc-1', '验收-需求分析', 5], ['acc-2', '验收-系统设计', 8], ['acc-3', '验收-开发甲', 3],
  ['acc-4', '验收-开发乙', 12], ['acc-5', '验收-集成测试', 6], ['acc-6', '验收-公共能力', 2],
  ['acc-7', '验收-现场实施', 4], ['acc-8', '验收-未估算行', null],
];
accPlans.forEach(([id, title, dur], i) => {
  insPlan.run(id, 'p-acc', title, shift(0), shift((dur ?? 5) + i), dur ?? 5, 20, 'doing', i + 1, T, T, 'normal', null, null);
});
const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, ?, ?, ?)`,
);
[['acc-1', 'req', 4, 6, 10, 'manual'], ['acc-2', 'design', 3, 5, 9, 'rule'],
  ['acc-3', 'dev', 2, 4, 6, 'manual'], ['acc-4', 'dev', 8, 12, 24, 'default'],
  ['acc-5', 'impl', 2, 3, 4, 'rule'], ['acc-6', 'common', 1, 2, 3, 'manual'],
  ['acc-7', 'onsite', 2, 2, 6, 'default']].forEach(([id, ph, o, m, p, src]) => {
  insEst.run(`e-${id}`, 'p-acc', id as string, ph as string, o as number, m as number, p as number, src as string, '验收夹具行', T, T);
});
closeDb();

// 启动器按 native 模块 ABI 探测（打包.bat 会把 better-sqlite3 重编译成 Electron ABI，
// 此时 process.execPath 直跑会 ERR_DLOPEN_FAILED）——见 isolated-server-launcher.mts
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const serverLog: string[] = [];
let childExit = 'running';
child.on('exit', (code: number | null, signal: string | null) => { childExit = `code=${code} signal=${signal}`; });
child.on('error', (e: Error) => serverLog.push(`spawn-error: ${e.message}`));
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
const BASE = `http://127.0.0.1:${PORT}`;
async function waitForServer(ms = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}
async function download(path: string): Promise<{ status: number; buf: Buffer; cd: string; snap: string }> {
  const res = await fetch(`${BASE}/api${path}`);
  return {
    status: res.status,
    buf: Buffer.from(await res.arrayBuffer()),
    cd: res.headers.get('content-disposition') ?? '',
    snap: res.headers.get('x-estimate-snapshot') ?? '',
  };
}

if (!(await waitForServer())) {
  ok('R-00 隔离服务启动', false, { exit: childExit, port: PORT, log: serverLog.join('').slice(-600) });
  // 失败时把日志留在仓库根的临时文件里并保住数据目录：60 秒空日志这类问题只能事后取证，不能顺手 rm 掉
  writeFileSync(join(ROOT, '.t02047-server-fail.log'), `exit=${childExit} port=${PORT}\n${serverLog.join('')}`);
  child.kill();
  console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip}`);
  process.exit(1);
}
ok(`R-00 隔离服务启动（临时端口 ${PORT} + 临时库 ${DATA_DIR}）`, true);

// R-1x §9 性能（500 行规模）
let HUGE_ID = '';
{
  const huge = (await api('POST', '/projects', { name: 'T02047 性能 500 行' })).json;
  HUGE_ID = String(huge?.id ?? '');
  const many = Array.from({ length: 500 }, (_, i) => ({
    title: `P500-${i + 1} 功能点`,
    description: '§9 性能面的实测规模夹具。',
    complexity: (i % 5) + 1,
    startDate: '2026-10-12',
    durationDays: 3 + (i % 7),
  }));
  const created = await api('POST', '/plans/batch', { projectId: HUGE_ID, items: many });
  ok('R-10 500 条计划批量入夹具（性能面的前置条件）',
    created.status === 200 && (created.json?.ids ?? []).length === 500,
    { status: created.status, n: (created.json?.ids ?? []).length, err: created.json?.error });

  const t0 = Date.now();
  const der = await api('POST', '/estimates/derive', { projectId: HUGE_ID, dryRun: false, scope: 'missing' });
  const deriveMs = Date.now() - t0;
  ok('R-11 §9 性能：`derive` 全量 500 行 <800ms',
    der.status === 200 && der.json?.written === der.json?.writableCount && der.json?.written === 500 && deriveMs < 800,
    { deriveMs, written: der.json?.written, writableCount: der.json?.writableCount, skipped: (der.json?.skipped ?? []).length, err: der.json?.error });

  const t1 = Date.now();
  const big = await api('GET', `/estimates?projectId=${HUGE_ID}`);
  const readMs = Date.now() - t1;
  ok('R-12 §9 性能：首屏取数（items+summary+checks，500 行）<500ms（面板首屏渲染的那一份数据来源）',
    big.status === 200 && (big.json?.items ?? []).length === 500 && readMs < 500,
    { readMs, items: (big.json?.items ?? []).length });

  const s = big.json.summary;
  const phaseSum = (s?.phases ?? []).reduce((a: number, q: any) => a + (q.expected ?? 0), 0);
  ok('R-13 §9 正确性·汇总自洽：Σ阶段 E = 直接投入人天（误差 <0.01），500 行规模下不漂',
    Math.abs(phaseSum - s?.directManDays?.expected) < 0.01, { phaseSum, direct: s?.directManDays?.expected });
  ok('R-14 §9 正确性·人月换算误差 <0.01：实际人月 = 直接人天 ÷ 人月标准 ×(1+Σ系数)',
    Math.abs(s?.actualManMonths?.expected - (s?.directManDays?.expected / STD) * (1 + COEF_SUM)) < 0.01,
    { actual: s?.actualManMonths?.expected, recomputed: (s?.directManDays?.expected / STD) * (1 + COEF_SUM) });

  const t2 = Date.now();
  const ex = await download(`/estimates/export-xlsx?projectId=${HUGE_ID}`);
  const xlsxMs = Date.now() - t2;
  ok('R-15 §9 性能：Excel 导出 500 行 <3s', ex.status === 200 && ex.buf.length > 20_000 && xlsxMs < 3_000,
    { xlsxMs, size: ex.buf.length, err: ex.status !== 200 });
  const t3 = Date.now();
  const pd = await download(`/estimates/export-pdf?projectId=${HUGE_ID}`);
  const pdfMs = Date.now() - t3;
  ok('R-16 §9 性能：PDF 导出 500 行 <6s（pdfkit 逐行渲染，PDF 侧唯一的规模闸门）',
    pd.status === 200 && pd.buf.slice(0, 5).toString() === '%PDF-' && pdfMs < 6_000,
    { pdfMs, size: pd.buf.length, status: pd.status });

  // 兼容面：500 行规模下结构无损（合并区随规模自适应，不再是模板的 28 处）
  const z = unzip(ex.buf);
  const xml500 = String(z.file('xl/worksheets/sheet1.xml')?.asText() ?? '');
  const cells500 = parseCells(xml500);
  const merges500 = (xml500.match(/<mergeCell /g) ?? []).length;
  const h500 = [...cells500.entries()].filter(([a, c]) => /^H\d+$/.test(a) && (c.f !== '' || c.v !== '') && (c.t === '' || c.t === 'n'));
  // 「齐全」= 每个 H 格都同时有 <f> 和 <v>（§12-R8 双写），逐格把缺的那一侧点名，
  // 否则断言失败只剩一个数字，分不清是命名区域没了还是某一行漏写缓存值（§12-R7 的自用面）
  const wb500 = wbXml(ex.buf);
  const noF = h500.filter(([, c]) => c.f === '').map(([a]) => a);
  const noV = h500.filter(([, c]) => c.v === '').map(([a]) => a);
  ok('R-17 §9 兼容：500 行导出件在 zip 只读回验下结构无损（主 sheet 名、命名区域、H 列公式+缓存值齐全）',
    wb500.includes(X.NAMED_RANGE_STD) && wb500.includes(X.SHEET_MAIN)
    && h500.length >= 500 && noF.length === 0 && noV.length === 0,
    { merges: merges500, hCells: h500.length, namedRange: wb500.includes(X.NAMED_RANGE_STD), sheetMain: wb500.includes(X.SHEET_MAIN), 缺公式: noF.slice(0, 6), 缺缓存值: noV.slice(0, 6) });
  console.log(`  [INFO] 500 行计时：derive ${deriveMs}ms / 取数 ${readMs}ms / xlsx ${xlsxMs}ms / pdf ${pdfMs}ms（xlsx ${(ex.buf.length / 1024).toFixed(0)}KB、PDF ${(pd.buf.length / 1024).toFixed(0)}KB、件内合并区 ${merges500} 处）`);
}

// R-2x §9 数据一致
{
  const before = (await api('GET', '/plans?projectId=p-acc')).json as any[];
  const rowBefore = before.find((p) => p.id === 'acc-4');
  const del = await api('DELETE', '/estimates/acc-4?projectId=p-acc');
  const after = (await api('GET', '/plans?projectId=p-acc')).json as any[];
  const rowAfter = after.find((p) => p.id === 'acc-4');
  ok('R-20 §9 数据一致：删除估算行不动 `plan_tasks`（排期/工期/进度/状态逐字段相同）',
    del.status === 200 && del.json?.removed === true && JSON.stringify(rowBefore) === JSON.stringify(rowAfter),
    { status: del.status, removed: del.json?.removed, before: rowBefore, after: rowAfter });
  const estAfter = (await api('GET', '/estimates?projectId=p-acc')).json;
  ok('R-21 删除后该行整条从明细消失（不是留一行 0/0/0 的假数据）',
    !(estAfter.items ?? []).some((i: any) => i.plan_id === 'acc-4'), (estAfter.items ?? []).length);

  const arch = await api('POST', '/plans/acc-3/archive');
  const hidden = (await api('GET', '/estimates?projectId=p-acc')).json;
  const shown = (await api('GET', '/estimates?projectId=p-acc&includeArchived=1')).json;
  const kept = (shown.items ?? []).find((i: any) => i.plan_id === 'acc-3');
  ok('R-22 §7/§9：计划软归档后估算行**不级联删除**（默认视图过滤掉、includeArchived 仍能取到原值）',
    arch.status === 200 && !(hidden.items ?? []).some((i: any) => i.plan_id === 'acc-3')
    && kept?.likely === 4 && kept?.optimistic === 2 && kept?.pessimistic === 6,
    { hidden: (hidden.items ?? []).length, shown: (shown.items ?? []).length, kept });
  await api('POST', '/plans/acc-3/restore');

  const cleanup = await api('DELETE', '/estimates/acc-1?projectId=p-acc');
  const plansNow = (await api('GET', '/plans?projectId=p-acc')).json as any[];
  ok('R-24 §9 数据一致：估算删除不影响计划条数',
    cleanup.status === 200 && plansNow.length === before.length, { now: plansNow.length, was: before.length });

  // §7「计划被彻底删除后估算行原样保留，清理是显式手动操作」
  // 彻底删除只作用于**已归档**计划（PlanService.purge 未归档时 `deleted:false` 且零删除，返回仍是 200）。
  // 本门第一版跳过归档直接 DELETE，把 200+空操作误读成「估算行被级联删了」——所以这里两步都断言。
  const purgeActive = await api('DELETE', '/plans/acc-6');
  const detachActive = (await api('GET', '/estimates/detach?projectId=p-acc')).json;
  ok('R-23a 未归档计划的彻底删除是空操作（deleted:false，估算行不进 detach 通道）',
    purgeActive.status === 200 && purgeActive.json?.deleted === false
    && !(detachActive?.rows ?? []).some((r: any) => r.plan_id === 'acc-6'),
    { deleted: purgeActive.json?.deleted, err: purgeActive.json?.error });

  const arch6 = await api('POST', '/plans/acc-6/archive');
  const purge = await api('DELETE', '/plans/acc-6');
  const detach = (await api('GET', '/estimates/detach?projectId=p-acc')).json;
  const orphan = (detach?.rows ?? []).find((r: any) => r.plan_id === 'acc-6');
  const stillShown = (await api('GET', '/estimates?projectId=p-acc&includeArchived=1')).json;
  ok('R-23 §7/§9 数据一致：计划被彻底删除后估算行原样保留（不出现在明细里、但 detach 通道能取到原三点）',
    arch6.status === 200 && purge.status === 200 && purge.json?.deleted === true
    && orphan?.likely === 2 && orphan?.optimistic === 1 && orphan?.pessimistic === 3
    && !(stillShown.items ?? []).some((i: any) => i.plan_id === 'acc-6'),
    { deleted: purge.json?.deleted, rows: (detach?.rows ?? []).length, orphan });
  const cleaned = await api('POST', '/estimates/detach/cleanup', { projectId: 'p-acc', ids: [orphan?.id] });
  const detachAfter = (await api('GET', '/estimates/detach?projectId=p-acc')).json;
  ok('R-23b 清理是显式动作且只删选中行（不会一键清掉历史报价依据）',
    cleaned.status === 200 && cleaned.json?.removed === 1
    && !(detachAfter?.rows ?? []).some((r: any) => r.plan_id === 'acc-6'),
    { removed: cleaned.json?.removed, left: (detachAfter?.rows ?? []).length });
}

// R-4x §12-R1 残余：参数页误改的防护面
{
  const bad = await api('PUT', '/estimates/params?projectId=p-acc', { settings: { 'estimate.manDaysPerManMonth': '200' } });
  ok('R-40 §12-R1 残余防护：人月标准越界（200>30）被服务端拒绝而不是静默接受',
    bad.status === 400 && /manDaysPerManMonth/.test(String(bad.json?.error))
    && /不得大于\s*30/.test(String(bad.json?.error)), bad);
  // 拒绝必须是零写入：先试算后落库（§3.3「一位小数写歪就是钱」），越界值不能留在库里等下次导出
  const afterBad = (await api('GET', '/estimates/params?projectId=p-acc')).json;
  ok('R-40b 拒绝是零写入（越界值不落库，参数页回读仍是原生效值）',
    afterBad?.config?.manDaysPerManMonth === 20.83, { config: afterBad?.config?.manDaysPerManMonth });
  const set20 = await api('PUT', '/estimates/params?projectId=p-acc', { settings: { 'estimate.manDaysPerManMonth': '20' } });
  const art20 = await download('/estimates/export-xlsx?projectId=p-acc');
  const names20: Array<[string, string]> = [];
  let d20: RegExpExecArray | null;
  const re20 = /<definedName[^>]*name="([^"]+)"[^>]*>([^<]+)<\/definedName>/g;
  while ((d20 = re20.exec(wbXml(art20.buf)))) names20.push([d20[1], d20[2]]);
  ok('R-41 §12-R1：改参数后件内命名区域常量跟着走（20）——件面数字不是硬编码的第二套口径',
    set20.status === 200 && set20.json?.config?.manDaysPerManMonth === 20
    && names20.some(([n, v]) => n === X.NAMED_RANGE_STD && v === '20'),
    { status: set20.status, config: set20.json?.config?.manDaysPerManMonth, names: names20, err: art20.status });
  const clear = await api('PUT', '/estimates/params?projectId=p-acc', { settings: { 'estimate.manDaysPerManMonth': '' } });
  const artDef = await download('/estimates/export-xlsx?projectId=p-acc');
  const namesDef: Array<[string, string]> = [];
  let ddf: RegExpExecArray | null;
  const reDf = /<definedName[^>]*name="([^"]+)"[^>]*>([^<]+)<\/definedName>/g;
  while ((ddf = reDf.exec(wbXml(artDef.buf)))) namesDef.push([ddf[1], ddf[2]]);
  ok('R-42 显式清空=回落默认 20.83（D1 裁决值是唯一默认，不靠调用方各自记）',
    clear.status === 200 && clear.json?.config?.manDaysPerManMonth === 20.83
    && namesDef.some(([n, v]) => n === X.NAMED_RANGE_STD && v === '20.83'),
    { cleared: clear.json?.cleared, config: clear.json?.config?.manDaysPerManMonth, names: namesDef });
}

// R-3x §9 上线度量三项（导出次数 / 人工复核率 / 覆盖项目数）
{
  const nBefore = ((await api('GET', '/estimates/snapshots?projectId=p-acc')).json?.snapshots ?? []).length;
  const e1 = await download('/estimates/export-xlsx?projectId=p-acc');
  const e2 = await download('/estimates/export-pdf?projectId=p-acc');
  const snaps = (await api('GET', '/estimates/snapshots?projectId=p-acc')).json;
  const list = snaps?.snapshots ?? [];
  ok('R-30 上线度量·导出次数从 `estimate_snapshots` 出数：每次导出 +1，响应头 X-Estimate-Snapshot 就是列表里那一条',
    e1.status === 200 && e2.status === 200 && Array.isArray(list) && list.length === nBefore + 2
    && list.some((r: any) => r.id === e1.snap) && list.some((r: any) => r.id === e2.snap)
    && new Set(list.slice(0, 2).map((r: any) => r.id)).size === 2
    // 两条新快照必须排在最前（列表按 created_at DESC；「导出次数」要能按时间取最近一次）
    && [e1.snap, e2.snap].every((s: string) => list.slice(0, 2).some((r: any) => r.id === s))
    && list.every((r: any) => r.project_id === 'p-acc'),
    { nBefore, n: list.length, h1: e1.snap, h2: e2.snap, top2: list.slice(0, 2).map((r: any) => ({ id: r.id, format: r.format })) });
  const latest = list[0];
  const payload = typeof latest?.payload === 'string' ? JSON.parse(latest.payload) : latest?.payload;
  const data = (await api('GET', '/estimates?projectId=p-acc')).json;
  const detail = (data.items ?? []).filter((i: any) => i.plan_kind !== 'milestone'
    && i.optimistic !== null && i.likely !== null && i.pessimistic !== null);
  const unreviewedLive = detail.filter((i: any) => i.source === 'rule' || i.source === 'default').length;
  ok('R-31 上线度量·人工复核率与件面「未复核」计数同源：快照 payload.unreviewed = 逐行 source∉{manual} 的计数',
    payload?.unreviewed === unreviewedLive && typeof payload?.detailRows === 'number',
    { inSnapshot: payload?.unreviewed, live: unreviewedLive, detail: detail.length, manual: detail.length - unreviewedLive });
  const cov = data.checks?.coverage;
  ok('R-31b §12-R3 口径：覆盖/来源分布在服务端一次算清（bySource 与逐行同源，面板不再自算）',
    cov && (cov.bySource?.manual ?? 0) + (cov.bySource?.rule ?? 0) + (cov.bySource?.default ?? 0) === detail.length,
    { bySource: cov?.bySource, detail: detail.length });
  console.log(`  [INFO] 快照最新一条：format=${latest?.format} filename=${String(latest?.filename).slice(0, 40)} unreviewed=${payload?.unreviewed} detailRows=${payload?.detailRows} merges=${payload?.merges}`);
}

group('R 组末 服务日志与进程收口');
{
  const noise = serverLog.join('').split('\n').filter((l) => /\bError\b|Unhandled|未处理|异常|throw/i.test(l));
  ok('R-90 服务日志无 §9 验收相关异常', noise.length === 0, noise.slice(0, 4));
}

child.kill();
await new Promise((r) => setTimeout(r, 1200));

// 只读库复验（上线度量·覆盖项目数）——服务已停，这里只做 SELECT
group('G 组 只读库复验：§9 上线度量·覆盖项目数与快照留存');
{
  const ro = getDb();
  const projCount = (ro.prepare('SELECT COUNT(DISTINCT project_id) AS n FROM estimate_items').get() as any).n;
  const snapAll = (ro.prepare('SELECT project_id, COUNT(*) AS n FROM estimate_snapshots GROUP BY project_id').all() as any[]);
  const manual = (ro.prepare("SELECT COUNT(*) AS n FROM estimate_items WHERE source='manual'").get() as any).n;
  const totalItems = (ro.prepare('SELECT COUNT(*) AS n FROM estimate_items').get() as any).n;
  ok('G-01 覆盖项目数可出数（distinct project_id ≥ 2：夹具项目 + 500 行项目都真的落库了）',
    projCount >= 2, { projCount });
  ok('G-02 快照按项目留存且与两次以上导出一致（R-30 的库侧一半证据）',
    snapAll.length >= 2 && snapAll.reduce((a: number, r: any) => a + r.n, 0) >= 6, { snapAll });
  ok('G-03 复核率的库侧口径与 REST 侧同数（500 行项目全为 rule 推导，夹具项目混有 manual）',
    manual > 0 && manual < totalItems, { manual, totalItems });
  closeDb();
}

rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip}`);
process.exit(fail === 0 ? 0 : 1);
