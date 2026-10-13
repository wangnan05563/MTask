/**
 * E6（T02043 · PRD-估算视图 §6.1/§11.1）验证脚本：逐格复刻客户模板 + 回读三轨断言。
 *
 * 用法（Node 版本须与 better-sqlite3 预编译 ABI 对齐，本机 Node22 ABI127 可加载）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02043-estimate-e6.mts
 *
 * 三轨（§11.1 红线 2 的教训：只断言「有缓存值」会放行错数，只断言「有公式」会放行 `#NAME?`）：
 *   结构轨：sheet 名 / 28 处合并区 / 列宽 / 阶段文案 / 备注 / 明细 sheet——exceljs **只读**回验
 *   公式轨：`xl/worksheets/sheet1.xml` 原始 XML 里每个 `<f>` 的文本形态（含「无前导 `=`」与命名区域引用）
 *   缓存值轨：每个 `<f>` 旁边的 `<v>` 与**本脚本独立重算**的引擎值逐格比对（1e-9）
 *   第四轨（可选）：openpyxl 只读交叉解析（`load_workbook` 两次，绝不 `save`）——换个 XML 解析器再读一遍，
 *     并独立读出命名区域的 `comment`（红线 5 的第二双眼睛）；python/openpyxl 缺失时记 SKIP 不记 PASS
 *
 * S 段（纯函数·不落库）覆盖布局/公式/值/客户版折叠/筛选与边界；
 * R 段（隔离实例·REST）覆盖 route 取数、`deps type=child` 里程碑通道、400 文案、快照同源、
 *   面板 Σ 与导出件 R40 同源（§10-14 的导出侧版本）。
 *
 * 隔离纪律（skill 红线 8）：库、端口、临时文件全部临时的，不碰生产数据目录，跑完 kill + 回收。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EstimateConfig, EstimatePhase, EstimateCoefKey } from '../server/src/services/estimate-engine.ts';
import type { EstimateExportInput, EstimateExportRow } from '../server/src/services/estimateExportXlsx.ts';
import { resolveServerLauncher } from './isolated-server-launcher.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02043-e6-'));
const OUT_DIR = join(DATA_DIR, 'out');
mkdirSync(OUT_DIR, { recursive: true });
process.env.MTask_DATA_DIR = DATA_DIR;

const E = await import('../server/src/services/estimate-engine.ts');
const X = await import('../server/src/services/estimateExportXlsx.ts');
const PizZip = (await import('pizzip')).default;
const ExcelJSMod: any = await import('exceljs');
const NewWorkbook = (): import('exceljs').Workbook => new (ExcelJSMod.default ?? ExcelJSMod).Workbook();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  }
};
const skipped = (name: string, why: string) => console.log(`  [SKIP] ${name}（${why}）——不计 PASS`);
const eq = (name: string, a: number, b: number, tol = 1e-9) =>
  ok(`${name}（${a} ≈ ${b}）`, Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol, { a, b });
const group = (t: string) => console.log(`\n== ${t}`);
const P = (o: number, m: number, p: number) => ({ optimistic: o, likely: m, pessimistic: p });
type Points = { optimistic: number; likely: number; pessimistic: number };

// =====================================================================
// 夹具（S 段，纯内存）：23 条开发明细（含 1 条未估算）+ 9 条非 dev 明细 + 2 条里程碑行。
// 23 这个数字不是随手取的：它让行落位复刻模板几何（R6/R7 阶段、R8~R30 明细、R31 小计、
// R32~R34 阶段、R35 理想、R36~R39 系数、R40 实际、R42 备注），合并区正好 28 处。
// =====================================================================
const CFG: EstimateConfig = { ...E.DEFAULT_ESTIMATE_CONFIG };
const STD = CFG.manDaysPerManMonth;
const COEF_SUM = E.ESTIMATE_COEF_KEYS.reduce((a, k) => a + CFG.coefs[k as EstimateCoefKey], 0);

const DEV_TAGS = [
  'MS-A', 'MS-A', 'MS-A', 'MS-A', '',
  'MS-B', 'MS-B', 'MS-B', 'MS-B', '',
  'MS-C', 'MS-C', 'MS-C', '',
  'MS-D', 'MS-D', '',
  'MS-E', 'MS-E', '',
  'MS-F', 'MS-F', '',
];
const UNESTIMATED_DEV_INDEX = 9; // 第 10 条（落 R17）无三点——留空而非写 0

const mk = (over: Partial<EstimateExportRow> & { planId: string; phase: EstimatePhase }): EstimateExportRow => ({
  title: over.planId,
  detail: over.planId,
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
const devRows: EstimateExportRow[] = DEV_TAGS.map((tag, i) => {
  const m = 2 + i;
  const un = i === UNESTIMATED_DEV_INDEX;
  return mk({
    planId: `pl-dev-${i + 1}`,
    phase: 'dev',
    title: `开发功能点 ${i + 1}`,
    detail: `实现${tag || '独立'}模块的第 ${i + 1} 个功能点，含编码、单元测试与联调。`,
    milestone: tag,
    optimistic: un ? null : m,
    likely: un ? null : m,
    pessimistic: un ? null : m + 3,
    source: un ? '' : i % 5 === 0 ? 'default' : 'manual',
    reqNos: [`REQ-${String(i + 1).padStart(3, '0')}`],
  });
});
const otherRows: EstimateExportRow[] = [
  mk({ planId: 'pl-req-1', phase: 'req', ...P(12, 12, 16) }),
  mk({ planId: 'pl-req-2', phase: 'req', ...P(8, 10, 12) }),
  mk({ planId: 'pl-req-3', phase: 'req', ...P(4, 6, 8), source: 'rule' }),
  mk({ planId: 'pl-design-1', phase: 'design', ...P(20, 20, 24) }),
  mk({ planId: 'pl-design-2', phase: 'design', ...P(10, 12, 14) }),
  mk({ planId: 'pl-impl-1', phase: 'impl', ...P(30, 30, 35) }),
  mk({ planId: 'pl-impl-2', phase: 'impl', ...P(6, 8, 10) }),
  mk({ planId: 'pl-common-1', phase: 'common', ...P(5, 7, 9) }),
  mk({ planId: 'pl-onsite-1', phase: 'onsite', ...P(3, 4, 5) }),
  // 里程碑行：带三点也只能做 C 列分组，绝不作为明细行进 Σ（§4.6）
  mk({ planId: 'pl-ms-a', phase: 'dev', planKind: 'milestone', title: 'MS-A', ...P(5, 5, 5) }),
  mk({ planId: 'pl-ms-b', phase: 'dev', planKind: 'milestone', title: 'MS-B' }),
];
const ALL_ROWS = [...otherRows.slice(0, 5), ...devRows, ...otherRows.slice(5)];

const input = (over: Partial<EstimateExportInput> = {}): EstimateExportInput => ({
  projectId: 'p-e6',
  projectName: 'T02043-导出E6',
  estimateDate: '2026-10-11',
  reviewer: '王南',
  rows: ALL_ROWS,
  config: CFG,
  scope: 'all',
  audience: 'internal',
  generatedAt: '2026-10-11T12:00:00.000Z',
  ...over,
});

// ---- 本脚本**独立**重算一套期望值（不读 layout 的输出，缓存值轨才是真对照而非同义反复）----
const est = (r: EstimateExportRow): r is EstimateExportRow & Points =>
  r.optimistic !== null && r.likely !== null && r.pessimistic !== null;
const sumP = (rs: EstimateExportRow[]): Points | null => {
  const w = rs.filter(est);
  if (w.length === 0) return null;
  return {
    optimistic: w.reduce((a, r) => a + r.optimistic, 0),
    likely: w.reduce((a, r) => a + r.likely, 0),
    pessimistic: w.reduce((a, r) => a + r.pessimistic, 0),
  };
};
const devEst = devRows.filter(est);
const byPhase = (p: EstimatePhase) => otherRows.filter((r) => r.phase === p && r.planKind !== 'milestone');
const phasePts = new Map<EstimatePhase, Points | null>(
  (['req', 'design', 'impl', 'common', 'onsite'] as EstimatePhase[]).map((p) => [p, sumP(byPhase(p))]));
const allEstRows = [...devEst, ...(['req', 'design', 'impl', 'common', 'onsite'] as EstimatePhase[]).flatMap((p) => byPhase(p).filter(est))];
const TOTAL_PTS = sumP(allEstRows) as Points;
const IDEAL_EXPECTED = E.expected(TOTAL_PTS) / STD;
const ACTUAL_EXPECTED = IDEAL_EXPECTED * (1 + COEF_SUM);

// ---- xlsx 字节 → 轨道读取工具 ----
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
interface XmlCell { f: string; v: string }
function parseCells(xml: string): Map<string, XmlCell> {
  const out = new Map<string, XmlCell>();
  const re = /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const inner = m[3] || '';
    const fm = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner);
    const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
    out.set(m[1], { f: fm ? unesc(fm[1]) : '', v: vm ? unesc(vm[1]) : '' });
  }
  return out;
}
const unzip = (buf: Buffer) => new PizZip(buf as unknown as ArrayBuffer);
const mainXml = (buf: Buffer) => unzip(buf).file('xl/worksheets/sheet1.xml')?.asText() ?? '';
const bookXml = (buf: Buffer) => unzip(buf).file('xl/workbook.xml')?.asText() ?? '';
const cellNum = (cs: Map<string, XmlCell>, ref: string) => {
  const c = cs.get(ref);
  return c && c.v !== '' ? Number(c.v) : NaN;
};
/** 合并区非锚点格在 XML 里是「存在但空」，所以「留空」= 不存在或 f/v 皆空 */
const isEmptyCell = (cs: Map<string, XmlCell>, ref: string) => {
  const c = cs.get(ref);
  return c === undefined || (c.f === '' && c.v === '');
};
async function loadWb(buf: Buffer): Promise<import('exceljs').Workbook> {
  const wb = NewWorkbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}
const cellText = (ws: import('exceljs').Worksheet | undefined, a: string): string => {
  if (!ws) return '';
  const v = ws.getCell(a).value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return String((v as { text?: string; result?: number }).text ?? (v as { result?: number }).result ?? '');
  return String(v);
};

// =====================================================================
group('G1 布局与行落位（§6.1 行结构还原，纯函数无 IO）');
{
  const L = X.layoutEstimate(input());
  ok('1-01 数据区起点 R6（模板表头占 R1~R5）', L.phaseRows[0].rowNo === X.FIRST_DATA_ROW, L.phaseRows[0].rowNo);
  ok('1-02 行序恒为 req→design→开发明细→小计→impl→common→onsite',
    L.phaseRows.map((p) => p.phase).join(',') === 'req,design,impl,common,onsite',
    L.phaseRows.map((p) => `${p.phase}@${p.rowNo}`));
  ok('1-03 开发明细 23 行落在 R8~R30', L.devRows.length === 23 && L.devRows[0].rowNo === 8 && L.devRows[22].rowNo === 30,
    { first: L.devRows[0].rowNo, last: L.devRows[22].rowNo, n: L.devRows.length });
  ok('1-04 明细区末行是「小计」行 R31（不是数据行）', L.subtotalRow?.rowNo === 31, L.subtotalRow);
  ok('1-05 汇总区几何 R35 理想 / R36~R39 系数 / R40 实际预估 / R42 备注',
    L.lastDataRow === 34 && L.totalRow === 35 && L.coefRows.map((c) => c.rowNo).join(',') === '36,37,38,39'
    && L.actualRow === 40 && L.remarkRow === 42,
    { lastDataRow: L.lastDataRow, totalRow: L.totalRow, actualRow: L.actualRow, remarkRow: L.remarkRow });
  ok('1-06 非 dev 阶段各聚合成 1 行（模板形态），条数记进 mergedCount',
    L.phaseRows.find((p) => p.phase === 'req')?.mergedCount === 3 && L.phaseRows.find((p) => p.phase === 'common')?.mergedCount === 1,
    L.phaseRows.map((p) => p.mergedCount));
  ok('1-07 里程碑行绝不成为明细行（只做 C 列分组），milestoneSkipped=2',
    L.devRows.every((d) => !d.planId.startsWith('pl-ms-')) && L.milestoneSkipped === 2, L.milestoneSkipped);
  ok('1-08 未估算行仍在主 sheet（scope=all）且三点为 null',
    L.devRows[UNESTIMATED_DEV_INDEX].points === null && L.devRows[UNESTIMATED_DEV_INDEX].rowNo === 17,
    L.devRows[UNESTIMATED_DEV_INDEX]);
  ok('1-09 聚合行来源标注偏严：成员含 default 即整体标 default，含 rule 次之（复核口径不能反向说成已复核）',
    L.phaseRows.find((p) => p.phase === 'req')?.source === 'rule'
    && X.layoutEstimate(input({ rows: [
      mk({ planId: 'x-1', phase: 'req', ...P(1, 1, 1), source: 'manual' }),
      mk({ planId: 'x-2', phase: 'req', ...P(1, 1, 1), source: 'default' }),
    ] })).phaseRows.find((p) => p.phase === 'req')?.source === 'default',
    L.phaseRows.find((p) => p.phase === 'req')?.source);
  ok('1-10 unreviewed = 有值且来源为规则/默认的非里程碑明细行数（§5.2 只看未复核同口径，不是只数 default）',
    L.unreviewed === ALL_ROWS.filter((r) => (r.source === 'rule' || r.source === 'default') && r.planKind !== 'milestone' && est(r)).length,
    L.unreviewed);
  const bad = allEstRows.filter((r) =>
    Math.abs(E.expected(P(r.optimistic, r.likely, r.pessimistic)) - E.expectedByTemplateFormula(P(r.optimistic, r.likely, r.pessimistic))) > 1e-12);
  ok('1-11 每行三点都满足 expected() ≡ expectedByTemplateFormula()（§12-R2）', bad.length === 0, bad.map((r) => r.planId));
}

group('G2 合并区清单（§6.1 实测 28 处的结构版）');
{
  const L = X.layoutEstimate(input());
  ok('2-01 内部版合并区恰 28 处', L.merges.length === 28, { n: L.merges.length, merges: L.merges });
  const fixed = ['B1:I1', 'H2:I2', 'B3:C3', 'D3:I3', 'B4:D4', 'E4:H4', 'I4:I5', 'B5:C5'];
  ok('2-02 表头 8 处逐字对齐模板', fixed.every((r) => L.merges.includes(r)), L.merges.slice(0, 8));
  ok('2-03 五个阶段行各一条 B:D', ['6', '7', '32', '33', '34'].every((r) => L.merges.includes(`B${r}:D${r}`)), L.merges);
  ok('2-04 开发段 B/I 纵向合并下界是**小计行 R31**（模板 B8:B31 / I8:I31）',
    L.merges.includes('B8:B31') && L.merges.includes('I8:I31'), L.merges.filter((m) => m.startsWith('B8:') || m.startsWith('I8:')));
  ok('2-05 C 列同模块连续行合并 6 处（分组 4/4/3/2/2/2）',
    L.merges.filter((m) => m.startsWith('C')).join('|') === 'C8:C11|C13:C16|C18:C20|C22:C23|C25:C26|C28:C29',
    L.merges.filter((m) => m.startsWith('C')));
  ok('2-06 无里程碑归属的 solo 行（R12/R17/R21/R24/R27/R30）不开 C 列合并区',
    ![12, 17, 21, 24, 27, 30].some((r) => L.merges.some((m) => m.startsWith(`C${r}:`))),
    L.merges.filter((m) => m.startsWith('C')));
  ok('2-07 汇总与系数 6 处 B:D + 备注 1 处 B:I',
    [35, 36, 37, 38, 39, 40].every((r) => L.merges.includes(`B${r}:D${r}`)) && L.merges.includes('B42:I42'));
  const cl = X.layoutEstimate(input({ audience: 'client' }));
  ok('2-08 客户版不写备注 → 27 处', cl.merges.length === 27 && !cl.merges.some((m) => m.startsWith('B42')), cl.merges.length);
}

// =====================================================================
const L = X.layoutEstimate(input());
const BUF = await X.buildEstimateXlsx(L);
const PATH = join(OUT_DIR, 'internal.xlsx');
writeFileSync(PATH, BUF);
const XML = mainXml(BUF);
const CELLS = parseCells(XML);
const formulaRefs = [...CELLS.entries()].filter(([, c]) => c.f !== '').map(([r]) => r);

group('G3 公式轨（原始 XML 里的每一个 `<f>`）');
{
  ok('3-01 导出件字节合法（xlsx 魔数 PK + 体积）', BUF.length > 15_000 && BUF[0] === 0x50 && BUF[1] === 0x4b, BUF.length);
  ok('3-02 公式格总数 55（阶段 H/I 10 + 明细 H 22 + 小计 4 + I8 1 + R35 5 + 系数 8 + R40 5）',
    formulaRefs.length === 55, { n: formulaRefs.length });
  const withEq = formulaRefs.filter((r) => CELLS.get(r)!.f.startsWith('='));
  ok('3-03 **没有任何 `<f>` 以前导 `=` 开头**（红线 1：会得到非规范形态、两次读取不一致）', withEq.length === 0, withEq);
  ok('3-04 H6 = 模板原式（MIN/MAX/SUM/COUNTA 那一条，不是我们的标准 PERT 式）',
    CELLS.get('H6')!.f === '(MIN(E6:G6)+MAX(E6:G6)+4*((SUM(E6:G6)-MIN(E6:G6)-MAX(E6:G6))/(COUNTA(E6:G6)-2)))/6',
    CELLS.get('H6')!.f);
  ok('3-05 22 条已估算开发明细的 H 都是同一条原式（行号跟随）',
    L.devRows.filter((d) => d.points).every((d) => CELLS.get(`H${d.rowNo}`)!.f === X.templateHFormula(d.rowNo)));
  ok('3-06 I6 引用**命名区域**而不是某个单元格（改 20.83 只需动一处）',
    CELLS.get('I6')!.f === 'IFERROR(H6/每人月工天标准/$H$40,"")', CELLS.get('I6')!.f);
  ok('3-07 开发段整体比例写在合并首格 I8，分子取小计行 H31（模板 I8→H31 那条例外），I9~I30 不再各写一条',
    CELLS.get('I8')!.f === 'IFERROR(H31/每人月工天标准/$H$40,"")'
    && [9, 15, 30].every((r) => { const c = CELLS.get(`I${r}`); return c === undefined || (c.f === '' && c.v === ''); }),
    CELLS.get('I8')!.f);
  ok('3-08 小计 R31 四条 SUBTOTAL(9,…) 区间是明细自身 E8:E30，不含本行',
    CELLS.get('E31')!.f === 'SUBTOTAL(9,E8:E30)' && CELLS.get('H31')!.f === 'SUBTOTAL(9,H8:H30)', CELLS.get('E31')!.f);
  ok('3-09 R35 四列 = SUBTOTAL(9,X6:X34)/每人月工天标准（区间含阶段行，小计行由 SUBTOTAL 语义排除）',
    ['E', 'F', 'G', 'H'].every((c) => CELLS.get(`${c}35`)!.f === `SUBTOTAL(9,${c}6:${c}34)/每人月工天标准`), CELLS.get('H35')!.f);
  ok('3-10 I35 = SUBTOTAL(9,I6:I34)', CELLS.get('I35')!.f === 'SUBTOTAL(9,I6:I34)', CELLS.get('I35')!.f);
  ok('3-11 系数行 R36~R39 按三点行处理：H 用原式、I 用 $H$35*H{r}/$H$40',
    [36, 37, 38, 39].every((r) => CELLS.get(`H${r}`)!.f === X.templateHFormula(r)
      && CELLS.get(`I${r}`)!.f === `IFERROR($H$35*H${r}/$H$40,"")`), CELLS.get('H36')!.f);
  ok('3-12 R40 = R35 × (1 + SUM(系数区间))，四列同形',
    ['E', 'F', 'G', 'H'].every((c) => CELLS.get(`${c}40`)!.f === `${c}35*(1+SUM(${c}36:${c}39))`), CELLS.get('H40')!.f);
  // T02047 ③轨实测把这一格从模板原式 `SUBTOTAL(9,I35:I39)` 改成了 `SUM(I35:I39)`：
  // I35 是嵌套 SUBTOTAL，会被同区间求和排除，Excel 只算出 0.187，而 §4.4 的自检格要的是 100%
  // （T02084 订正：模板备注第 3 条只要求「检查 I 列比例是否在合理区间」，=100% 是 §4.4 的自检口径，不是备注原文）
  ok('3-13 I40 = SUM(I35:I39)（§4.4 自检格：各阶段比例之和 100%；原式 SUBTOTAL 会排除嵌套的 I35，见 T02047 ③轨）',
    CELLS.get('I40')!.f === 'SUM(I35:I39)', CELLS.get('I40')!.f);
  ok('3-14 没有一处把 20.83 写死进公式（一律走命名区域）',
    formulaRefs.every((r) => !CELLS.get(r)!.f.includes('20.83')));
}

group('G4 缓存值轨（每个 `<v>` 与本脚本独立重算值逐格比对，红线 2）');
{
  for (const d of L.devRows.filter((x) => x.points)) {
    const pts = P(d.points!.optimistic, d.points!.likely, d.points!.pessimistic);
    eq(`4-H${d.rowNo} 缓存值 = 模板原式值`, cellNum(CELLS, `H${d.rowNo}`), E.expectedByTemplateFormula(pts));
  }
  for (const p of ['req', 'design', 'impl', 'common', 'onsite'] as EstimatePhase[]) {
    const pr = L.phaseRows.find((x) => x.phase === p)!;
    const pts = phasePts.get(p) as Points;
    eq(`4-H${pr.rowNo} 聚合行 = Σ成员期望（PERT 线性：先加后算 ≡ 先算后加）`,
      cellNum(CELLS, `H${pr.rowNo}`), allEstRows.filter((r) => r.phase === p && r.planKind !== 'milestone').reduce((a, r) => a + E.expected(P(r.optimistic, r.likely, r.pessimistic)), 0));
    eq(`4-H${pr.rowNo} 亦 = expected(Σ成员三点)`, cellNum(CELLS, `H${pr.rowNo}`), E.expectedByTemplateFormula(pts));
  }
  eq('4-05 小计 E31 = Σ开发明细最可能', cellNum(CELLS, 'E31'), devEst.reduce((a, r) => a + r.likely, 0));
  eq('4-06 小计 F31 = Σ最小', cellNum(CELLS, 'F31'), devEst.reduce((a, r) => a + r.optimistic, 0));
  eq('4-07 小计 G31 = Σ最大', cellNum(CELLS, 'G31'), devEst.reduce((a, r) => a + r.pessimistic, 0));
  eq('4-08 小计 H31 = Σ逐行期望（不是对聚合三点再算一次）',
    cellNum(CELLS, 'H31'), devEst.reduce((a, r) => a + E.expected(P(r.optimistic, r.likely, r.pessimistic)), 0));
  eq('4-09 R35·E = Σ全部已估算明细最可能 ÷ 20.83', cellNum(CELLS, 'E35'), TOTAL_PTS.likely / STD);
  eq('4-10 R35·H = Σ逐行期望 ÷ 20.83', cellNum(CELLS, 'H35'), IDEAL_EXPECTED);
  eq('4-11 R40·H = R35·H × (1 + Σ四个调节系数)', cellNum(CELLS, 'H40'), ACTUAL_EXPECTED);
  ok('4-12 R40·E/F/G 三列同样 = 对应列 ×(1+Σ系数)',
    (['E', 'F', 'G'] as const).every((c) => Math.abs(cellNum(CELLS, `${c}35`) * (1 + COEF_SUM) - cellNum(CELLS, `${c}40`)) < 1e-9));
  E.ESTIMATE_COEF_KEYS.forEach((k, i) => {
    const v = CFG.coefs[k as EstimateCoefKey];
    eq(`4-13 系数行 R${36 + i}·H = 系数本身（E=F=G 同值时原式退化）`, cellNum(CELLS, `H${36 + i}`), v);
    eq(`4-14 系数行 R${36 + i}·I = R35×系数 ÷ R40`, cellNum(CELLS, `I${36 + i}`), (IDEAL_EXPECTED * v) / ACTUAL_EXPECTED);
  });
  eq('4-15 I8 = 开发段整体比例 = H31 ÷ 20.83 ÷ H40', cellNum(CELLS, 'I8'), cellNum(CELLS, 'H31') / STD / cellNum(CELLS, 'H40'));
  eq('4-16 **I40 缓存值 = 1**（§4.4 自检口径：各阶段比例之和 100%）', cellNum(CELLS, 'I40'), 1);
  const phaseSum = ['6', '7', '8', '32', '33', '34'].reduce((a, r) => a + cellNum(CELLS, `I${r}`), 0);
  eq('4-17 逐格相加复核：五个阶段行 + 开发段整体（I8）= I35（SUBTOTAL 的缓存值就是这些行之和）',
    phaseSum, cellNum(CELLS, 'I35'), 1e-12);
  eq('4-18 再复核一层：I35 + 四条系数行 = I40 = 1（§4.4 自检口径的两侧同值）',
    cellNum(CELLS, 'I35') + ['36', '37', '38', '39'].reduce((a, r) => a + cellNum(CELLS, `I${r}`), 0), 1, 1e-9);
  const missing = formulaRefs.filter((r) => CELLS.get(r)!.v === '');
  ok('4-19 每个公式格都带缓存值（预览类查看器只读 `<v>`，缺值等于交一张空表）', missing.length === 0, missing);
  const tampered = parseCells(XML.replace(/(<f>H35\*\(1\+SUM\(H36:H39\)\)<\/f><v>)[^<]+/, '$1999'));
  ok('4-20 反向证据（红线 2 的牙齿）：把 H40 缓存值人为改成 999 后本轨必须判不一致',
    Math.abs(cellNum(tampered, 'H40') - ACTUAL_EXPECTED) > 1 && Math.abs(cellNum(CELLS, 'H40') - ACTUAL_EXPECTED) < 1e-9,
    { tampered: cellNum(tampered, 'H40'), real: cellNum(CELLS, 'H40'), want: ACTUAL_EXPECTED });
  const empties = ['E', 'F', 'G', 'H', 'I'].map((c) => CELLS.get(`${c}17`));
  ok('4-21 未估算行 R17 五列全空（既无公式也无 0——「没估」与「估 0 天」在报价件上是两回事）',
    empties.every((c) => c === undefined || (c.f === '' && c.v === '')), empties);
}

group('G5 结构轨（exceljs 只读回验：sheet 名 / 列宽 / 文案 / 合并 / 附加 sheet）');
{
  const wb = await loadWb(BUF);
  ok('5-01 三个 sheet：主表 + 估算明细 + 参数（附加 sheet 仅内部版）',
    wb.worksheets.map((w) => w.name).join('|') === `${X.SHEET_MAIN}|${X.SHEET_DETAIL}|${X.SHEET_PARAMS}`, wb.worksheets.map((w) => w.name));
  const ws = wb.getWorksheet(X.SHEET_MAIN);
  const widths = X.TEMPLATE_COLUMN_WIDTHS.map((_, i) => Number(ws?.getColumn(i + 1).width));
  ok('5-02 列宽逐列对齐附录 A（D 列 63.125 是关键：长描述不折成一堵墙）',
    widths.every((w, i) => Math.abs(w - X.TEMPLATE_COLUMN_WIDTHS[i]) < 0.01), widths);
  ok('5-03 表头文案逐字符（含模板里那个缺右括号的全角拼写）',
    cellText(ws, 'B1') === X.TEMPLATE_TEXTS.title && cellText(ws, 'E4') === X.TEMPLATE_TEXTS.resultHeader && cellText(ws, 'I4') === X.TEMPLATE_TEXTS.ratioHeader,
    [cellText(ws, 'B1'), cellText(ws, 'E4'), cellText(ws, 'I4')]);
  ok('5-04 B 列阶段文案用**模板文案**而非面板标签（两套口径不得混用）',
    cellText(ws, 'B7').startsWith(X.TEMPLATE_PHASE_LABELS.design) && cellText(ws, 'B8') === X.TEMPLATE_PHASE_LABELS.dev,
    [cellText(ws, 'B7'), cellText(ws, 'B8')]);
  ok('5-05 聚合阶段带「含 N 项」注记（req 3 条聚合成 1 行，客户看得见数量）',
    cellText(ws, 'B6') === '需求分析（含 3 项，详见内部导出版）', cellText(ws, 'B6'));
  ok('5-06 R35/R40 汇总行文案与 D31「小计：」',
    cellText(ws, 'B35') === X.TEMPLATE_TEXTS.ideal && cellText(ws, 'B40') === X.TEMPLATE_TEXTS.actual && cellText(ws, 'D31') === X.TEMPLATE_TEXTS.subtotal,
    [cellText(ws, 'B35'), cellText(ws, 'D31'), cellText(ws, 'B40')]);
  ok('5-07 备注四条落在 R42（内部版必带；T02084 起逐字符对齐客户原件，G10 组交叉验证）',
    cellText(ws, 'B42').includes(X.TEMPLATE_TEXTS.remarks) && X.TEMPLATE_REMARKS.every((s) => cellText(ws, 'B42').includes(s)),
    cellText(ws, 'B42').slice(0, 60));
  ok('5-08 C 列模块名来自里程碑归属，D 列是清洗后的功能点描述',
    cellText(ws, 'C8') === 'MS-A' && cellText(ws, 'D8').includes('功能点'), [cellText(ws, 'C8'), cellText(ws, 'D8').slice(0, 24)]);
  ok('5-09 XML 里的 mergeCell 数与 layout 清单同值（28）', (XML.match(/<mergeCell /g) || []).length === 28,
    (XML.match(/<mergeCell /g) || []).length);
  const colD = /<col min="4" max="4"[^>]*width="([^"]+)"/.exec(XML);
  ok('5-10 原始 `<cols>` 的 D 列宽度 = 63.125', colD !== null && Math.abs(Number(colD[1]) - 63.125) < 0.01, colD && colD[1]);
  const detail = wb.getWorksheet(X.SHEET_DETAIL);
  ok('5-11 明细 sheet 行数 = 全量明细（含被聚合的非 dev 行）+ 表头 + 生成时间 + 未复核注',
    detail?.rowCount === ALL_ROWS.filter((r) => r.planKind !== 'milestone').length + 3, detail?.rowCount);
  const nDetail = ALL_ROWS.filter((r) => r.planKind !== 'milestone').length;
  ok('5-12 明细 sheet 逐行给全（非 dev 明细不被聚合掉，内部对账要能看到每一条）',
    nDetail === 32 && detail !== undefined, nDetail);
  ok('5-13 明细 sheet 尾部「N 行为系统推导值，未人工复核」（§6.3 复核标注）',
    cellText(detail, `D${nDetail + 3}`) === `注：${L.unreviewed} 行为系统推导值，未人工复核`, cellText(detail, `D${nDetail + 3}`));
  const params = wb.getWorksheet(X.SHEET_PARAMS);
  ok('5-14 参数 sheet 第 2 行就是命名区域取值，第 3 行是 20 vs 20.83 口径冲突提示（D1 依据进交付件）',
    cellText(params, 'A2') === X.NAMED_RANGE_STD && cellText(params, 'A3').includes('口径冲突'),
    [cellText(params, 'A2'), cellText(params, 'A3')]);
  const p84Row = Array.from({ length: params?.rowCount ?? 0 }, (_, i) => i + 1)
    .find((r) => cellText(params, `A${r}`) === '对外报价 P84 人天');
  ok('5-15 参数 sheet 带对外报价 P84 与 ΣE（裁决 D2 的口径在件里可追溯）',
    p84Row !== undefined && Number(cellText(params, `B${p84Row}`)) > 0 && cellText(params, `B${p84Row}`) !== 'NaN',
    p84Row && [cellText(params, `A${p84Row}`), cellText(params, `B${p84Row}`)]);
  // T02086（裁决「不进」）：reviewer 未配置时导出留空由用户手填——不报错、不写假名（§6.1「或留空」分支）
  const noRev = await X.buildEstimateXlsx(X.layoutEstimate(input({ reviewer: '' })));
  const wsnr = (await loadWb(noRev)).getWorksheet(X.SHEET_MAIN);
  ok('5-16 reviewer 未配置（空串）导出不报错且 H2 留空——不写「（待填写）」这类假名（T02086 留空分支）',
    cellText(wsnr, 'H2') === '' && cellText(ws, 'H2') === '王南',
    [cellText(wsnr, 'H2'), cellText(ws, 'H2')]);
}

group('G6 命名区域与重算标记（红线 4 + 红线 5）');
{
  const BK = bookXml(BUF);
  const dn = /<definedName name="([^"]+)"([^>]*)>([^<]*)<\/definedName>/.exec(BK);
  ok('6-01 `<definedName>` 存在且是**常量形态**（不是单元格引用；本文件从零构建，不走模板往返）',
    dn !== null && dn[1] === X.NAMED_RANGE_STD && dn[3] === String(STD), dn && [dn[1], dn[2], dn[3]]);
  ok('6-02 注释原文已注入（红线 5：exceljs 的 DefinedNamesXform 不透传 comment，走写后补丁）',
    dn !== null && dn[2].includes(`comment="${X.NAMED_RANGE_STD_COMMENT}"`), dn && dn[2].slice(0, 40));
  ok('6-03 打开即重算：`<calcPr>` 带 fullCalcOnLoad（§12-R8 加固）',
    /<calcPr[^>]*fullCalcOnLoad="(?:1|true)"/.test(BK), /<calcPr[^>]*>/.exec(BK)?.[0]);
  ok('6-04 injectComment 纯函数：名字不存在时原样返回（不静默改坏 XML）',
    X.injectComment('<workbook><definedName name="别的">1</definedName></workbook>', X.NAMED_RANGE_STD, 'x')
      === '<workbook><definedName name="别的">1</definedName></workbook>');
  ok('6-05 injectComment 对属性特殊字符做转义',
    X.injectComment('<definedName name="A">1</definedName>', 'A', 'x<&>"y').includes('comment="x&lt;&amp;&gt;&quot;y"'));
  let throwMsg = '';
  try { await X.attachDefinedNameComment(BUF, '不存在的名字', 'x'); } catch (e) { throwMsg = (e as Error).message; }
  ok('6-06 补丁找不到命名区域时**报错而不是交出一份丢掉取值依据的件**', throwMsg.includes('未在 workbook.xml 中找到'), throwMsg);
  const wb2 = await loadWb(BUF);
  const re2 = Buffer.from(await wb2.xlsx.writeBuffer() as ArrayBuffer);
  const BK2 = bookXml(re2);
  ok('6-07 复现红线 4：exceljs read→write 往返后常量命名区域的取值不再可用（所以「复制模板再填」的方案不可行）',
    !/<definedName name="每人月工天标准"[^>]*>20\.83<\/definedName>/.test(BK2) && /<definedName name="每人月工天标准"/.test(BK),
    /<definedNames>[\s\S]*?<\/definedNames>/.exec(BK2)?.[0]?.slice(0, 160) ?? '往返后无 definedNames 段');
}

group('G7 客户版轨（§6.2 脱敏发生在服务端，前端隐藏不算脱敏）');
{
  const foldCfg: EstimateConfig = { ...CFG, hideCoefsForClient: true };
  const Lc = X.layoutEstimate(input({ audience: 'client', config: foldCfg }));
  ok('7-01 四系数折叠成 1 行合计 + 3 行 0，Σ 不变（R40 结果分文不差）',
    Lc.coefRows.map((c) => c.value).join(',') === `${COEF_SUM},0,0,0`, Lc.coefRows.map((c) => c.value));
  ok('7-02 折叠行标签「综合调节系数（内部明细略）」，其余三行标签为空',
    Lc.coefRows[0].label === X.TEMPLATE_TEXTS.foldedCoef && Lc.coefRows.slice(1).every((c) => c.label === ''),
    Lc.coefRows.map((c) => c.label));
  ok('7-03 折叠不改行号几何（模板公式几何是 R35/R36~R39/R40）',
    Lc.totalRow === 35 && Lc.actualRow === 40 && Lc.remarkRow === null,
    { totalRow: Lc.totalRow, actualRow: Lc.actualRow, remarkRow: Lc.remarkRow });
  const BUFc = await X.buildEstimateXlsx(Lc);
  writeFileSync(join(OUT_DIR, 'client.xlsx'), BUFc);
  const zc = unzip(BUFc);
  ok('7-04 客户版**只有 1 个 sheet**（明细/参数两个内部 sheet 不产出）',
    zc.file('xl/worksheets/sheet2.xml') === null && zc.file('xl/worksheets/sheet3.xml') === null,
    Object.keys(zc.files as object).filter((k) => k.startsWith('xl/worksheets')));
  const XMLc = mainXml(BUFc);
  const cellsC = parseCells(XMLc);
  ok('7-05 客户版 R40 的 SUM 区间仍是 36:39（折叠只改值不改几何，否则报价数会跳）',
    cellsC.get('H40')!.f === 'H35*(1+SUM(H36:H39))', cellsC.get('H40')!.f);
  eq('7-06 客户版 H40 = 内部版 H40（折叠不改动对外报价）', cellNum(cellsC, 'H40'), cellNum(CELLS, 'H40'));
  eq('7-07 客户版 I40 仍为 1（比例自检在交付件上成立）', cellNum(cellsC, 'I40'), 1);
  const wbc = await loadWb(BUFc);
  ok('7-08 客户版不写备注（不把「本报价单最好仅作为项目成本估算…」这类内部话术交给客户）',
    cellText(wbc.getWorksheet(X.SHEET_MAIN), 'B42') === '' && !(XMLc.includes('备注/说明')),
    cellText(wbc.getWorksheet(X.SHEET_MAIN), 'B42').slice(0, 40));
  ok('7-09 客户版仍带命名区域注释（取值依据是给客户看的，不是内部话术）',
    /<definedName name="每人月工天标准"[^>]*comment=/.test(bookXml(BUFc)));
  ok('7-10 客户版合并区 27 处、sheet 数 1',
    (XMLc.match(/<mergeCell /g) || []).length === 27 && wbc.worksheets.length === 1,
    [(XMLc.match(/<mergeCell /g) || []).length, wbc.worksheets.length]);
  const internalFold = await X.buildEstimateXlsx(X.layoutEstimate(input({ config: foldCfg })));
  const wbc2 = await loadWb(internalFold);
  const wsi = wbc2.getWorksheet(X.SHEET_MAIN);
  ok('7-11 折叠只作用于客户版：内部版即使开关打开仍保留四个系数分项（内部依据不能一起藏掉）',
    wbc2.worksheets.length === 3 && cellText(wsi, 'B36').includes('客户协作配合') && Math.abs(cellNum(CELLS, 'H40') - cellNum(parseCells(mainXml(internalFold)), 'H40')) < 1e-9,
    cellText(wsi, 'B36'));
}

group('G8 筛选 / 范围 / 边界');
{
  const Ld = X.layoutEstimate(input({ phases: ['dev'] }));
  ok('8-01 phases=dev 时非 dev 阶段行整体消失，行号与合并区一起重排（不是留空行）',
    Ld.phaseRows.length === 0 && Ld.devRows[0].rowNo === 6 && Ld.subtotalRow?.rowNo === 29 && Ld.totalRow === 30 && Ld.actualRow === 35,
    { devFirst: Ld.devRows[0].rowNo, subtotal: Ld.subtotalRow?.rowNo, totalRow: Ld.totalRow, actualRow: Ld.actualRow });
  ok('8-02 合并区随结构变：8 固定 + 2 开发纵向 + 6 C 组 + 6 汇总 + 1 备注 = 23', Ld.merges.length === 23, Ld.merges.length);
  const BUFd = await X.buildEstimateXlsx(Ld);
  const cellsD = parseCells(mainXml(BUFd));
  ok('8-03 公式引用跟着新行号走（分母 $H$35、系数行分子 $H$30）——行号单源，不存在第二套数行的地方',
    cellsD.get('I6')!.f === 'IFERROR(H29/每人月工天标准/$H$35,"")'
    && cellsD.get('I31')!.f === 'IFERROR($H$30*H31/$H$35,"")'
    && cellsD.get('H30')!.f === 'SUBTOTAL(9,H6:H29)/每人月工天标准',
    [cellsD.get('I6')?.f, cellsD.get('I31')?.f, cellsD.get('H30')?.f]);
  const Le = X.layoutEstimate(input({ scope: 'estimated_only' }));
  ok('8-04 scope=estimated_only 时未估算行不进主 sheet，明细变 22 行',
    Le.devRows.length === 22 && Le.devRows.every((d) => d.points !== null), Le.devRows.length);
  ok('8-05 过滤后几何重排：小计 R30 / 理想 R34 / 实际 R39 / 备注 R41',
    Le.subtotalRow?.rowNo === 30 && Le.totalRow === 34 && Le.actualRow === 39 && Le.remarkRow === 41,
    { subtotal: Le.subtotalRow?.rowNo, total: Le.totalRow, actual: Le.actualRow, remark: Le.remarkRow });
  const BUFs = await X.buildEstimateXlsx(Le);
  const cellsS = parseCells(mainXml(BUFs));
  ok('8-06 过滤后小计区间同步收窄（SUBTOTAL(9,H8:H29) 而不是残留 H8:H30），阶段行比例分母跟到 $H$39',
    cellsS.get('H30')!.f === 'SUBTOTAL(9,H8:H29)' && cellsS.get('I6')!.f === 'IFERROR(H6/每人月工天标准/$H$39,"")',
    [cellsS.get('H30')?.f, cellsS.get('I6')?.f]);
  const Ln = X.layoutEstimate(input({ rows: [] }));
  ok('8-07 空项目不报错也不炸行号（阶段行 points=null、无小计行、totalRow=lastDataRow+1）',
    Ln.devRows.length === 0 && Ln.subtotalRow === null && Ln.phaseRows.every((p) => p.points === null)
    && Ln.totalRow === Ln.lastDataRow + 1 && Ln.coefRows.length === 4, { lastDataRow: Ln.lastDataRow, totalRow: Ln.totalRow });
  const BUFn = await X.buildEstimateXlsx(Ln);
  const cellsN = parseCells(mainXml(BUFn));
  ok('8-08 空数据也能出件，且缓存值里没有一个 NaN（Excel 打开不报错）',
    BUFn.length > 3000 && !mainXml(BUFn).includes('NaN') && Number.isFinite(cellNum(cellsN, `H${Ln.actualRow}`)),
    { size: BUFn.length, actualRow: Ln.actualRow, v: cellNum(cellsN, `H${Ln.actualRow}`) });
  eq('8-09 空项目的 H40 缓存值 = 0（不是 null、不是上一版的残值）', cellNum(cellsN, `H${Ln.actualRow}`), 0);
  ok('8-10 cleanDetail：换行压平 + 空白归一', X.cleanDetail('第一行\n第二行\t带  空白', 'T') === '第一行 第二行 带 空白');
  const long = X.cleanDetail('x'.repeat(600), 'T', ['REQ-001', 'REQ-007']);
  ok('8-11 cleanDetail：>500 字截断并标出处', long.length === 500 + '…（见需求 REQ-001、REQ-007）'.length && long.endsWith('）'),
    long.slice(-24));
  ok('8-12 聚合只作用于非 dev 阶段；dev 逐条成行（模板开发段本就是明细段）',
    L.devRows.length === 23 && L.phaseRows.filter((p) => p.phase === 'dev').length === 0);
}

group('G9 第四轨：openpyxl 只读交叉解析（换个解析器的第二双眼睛，绝不 save）');
{
  const probe = spawnSync('python', ['-c', 'import openpyxl'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    skipped('G9 openpyxl 交叉轨', '本机 python/openpyxl 不可用');
  } else {
    const pyFile = join(DATA_DIR, 'cross.py');
    writeFileSync(pyFile, `import json, sys
from openpyxl import load_workbook
p = sys.argv[1]
wf = load_workbook(p)
wv = load_workbook(p, data_only=True)
sn = wf.sheetnames
ws, wsv = wf[sn[0]], wv[sn[0]]
dn = {}
for k, v in wf.defined_names.items():
    dn[k] = {'value': getattr(v, 'value', None), 'comment': getattr(v, 'comment', '') or ''}
print(json.dumps({
  'sheetnames': sn, 'merges': len(ws.merged_cells.ranges), 'defined': dn,
  'H6_f': ws['H6'].value, 'H6_v': wsv['H6'].value,
  'H40_f': ws['H40'].value, 'H40_v': wsv['H40'].value, 'I40_v': wsv['I40'].value,
  'B6': ws['B6'].value, 'D31': ws['D31'].value,
}, ensure_ascii=False))
`, 'utf-8');
    const run = spawnSync('python', [pyFile, PATH], { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (run.status !== 0) {
      skipped('G9 openpyxl 交叉轨', `openpyxl 读取失败：${(run.stderr || '').slice(0, 200)}`);
    } else {
      const j = JSON.parse((run.stdout.trim().split('\n').pop() as string)) as Record<string, any>;
      ok('9-01 openpyxl 能完整解析导出件（Excel 侧解析器认这份结构）', j.sheetnames?.[0] === X.SHEET_MAIN, j.sheetnames);
      ok('9-02 openpyxl 数到 28 处合并区（与 exceljs / 原始 XML 两轨同值）', j.merges === 28, j.merges);
      ok('9-03 命名区域被解析成常量 20.83', j.defined?.[X.NAMED_RANGE_STD]?.value === '20.83', j.defined);
      ok('9-04 命名区域的 comment 被独立读出（红线 5 的第二双眼睛）',
        String(j.defined?.[X.NAMED_RANGE_STD]?.comment || '').includes('每人年平均预估约 240 工作日'),
        String(j.defined?.[X.NAMED_RANGE_STD]?.comment || '').slice(0, 40));
      const f6 = String(j.H6_f ?? '').replace(/^=/, '');
      ok('9-05 公式交叉：openpyxl 读到的 H6 就是模板原式，且没有 `==` 畸形',
        f6.startsWith('(MIN(E6:G6)') && !String(j.H6_f ?? '').startsWith('=='), j.H6_f);
      eq('9-06 缓存值交叉：openpyxl 的 H40 与 XML 轨同值', Number(j.H40_v), cellNum(CELLS, 'H40'));
      eq('9-07 交叉轨复核 I40 = 100%', Number(j.I40_v), 1, 1e-9);
      ok('9-08 文案交叉：B6 聚合注记与 D31「小计：」在两套解析器下一致',
        String(j.B6).startsWith('需求分析（含 3 项') && String(j.D31) === '小计：', [j.B6, j.D31]);
    }
  }
}

// =====================================================================
group('G10 第五轨：客户模板原件交叉（T02084：备注四条/系数标签的真值源是 Desktop 原件，不是抄进断言的第二份口径）');
{
  // python 探测链：T02084_PYTHON 显式指定 → PATH 里的 python → 本机 venv
  // （openpyxl 只装在 venv，G9 的裸 python 因此在开发机必 SKIP——本组补上能真跑的那一双眼睛）
  const pyCands = [process.env.T02084_PYTHON, 'python',
    'C:/Users/hspcadmin/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
  ].filter(Boolean) as string[];
  let py: string | null = null;
  for (const c of pyCands) {
    if (spawnSync(c, ['-c', 'import openpyxl'], { encoding: 'utf-8' }).status === 0) { py = c; break; }
  }
  const TPL = process.env.T02084_TEMPLATE
    ?? 'C:/Users/hspcadmin/Desktop/工作量评估/阜新银行-票据系统优化-工作量评估V2.0.xlsx';
  if (!py || !existsSync(TPL)) {
    skipped('G10 模板原件交叉轨',
      [!py ? 'python/openpyxl 不可用' : '', !existsSync(TPL) ? `原件不在 ${TPL}` : ''].filter(Boolean).join('；')
      + '（T02084_PYTHON / T02084_TEMPLATE 可指定）');
  } else {
    const pyFile = join(DATA_DIR, 'tpl.py');
    writeFileSync(pyFile, `import json, sys
from openpyxl import load_workbook
tpl, exp = sys.argv[1], sys.argv[2]
def grab(p):
    wb = load_workbook(p, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    o = {'sheet': ws.title}
    for a in ['B1','B3','B4','E4','I4','B5','D5','E5','F5','G5','H5','D31','B35','B36','B37','B38','B39','B40','B42']:
        o[a] = ws[a].value
    b42 = o['B42']
    o['B42_lines'] = str(b42).split('\\n') if b42 else []
    o['Bcol'] = {('B%d' % r): ws.cell(row=r, column=2).value
                 for r in range(1, 45) if ws.cell(row=r, column=2).value not in (None, '')}
    return o
print(json.dumps({'tpl': grab(tpl), 'exp': grab(exp)}, ensure_ascii=False))
`, 'utf-8');
    const run = spawnSync(py, [pyFile, TPL, PATH], { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (run.status !== 0) {
      skipped('G10 模板原件交叉轨', `读取失败：${(run.stderr || '').slice(0, 200)}`);
    } else {
      const j = JSON.parse((run.stdout.trim().split('\n').pop() as string)) as any;
      const t = j.tpl as Record<string, any>;
      const e = j.exp as Record<string, any>;
      const COEF_ADDR = ['B36', 'B37', 'B38', 'B39'];
      const PHASES = ['req', 'design', 'dev', 'impl', 'common', 'onsite'] as const;

      ok('10-01 原件 B42 = 标签行 + 四条正文（PRD 附录 A 二手转述的「三条」是漏译，原件才是真值）',
        Array.isArray(t.B42_lines) && t.B42_lines.length === 5 && t.B42_lines[0] === X.TEMPLATE_TEXTS.remarks,
        t.B42_lines?.length);
      ok('10-02 TEMPLATE_REMARKS 四条与原件 B42 拆行逐字符一致且顺序一致（全角引号“”、全角等号＝原样保留）',
        X.TEMPLATE_REMARKS.length === 4 && X.TEMPLATE_REMARKS.every((s, i) => s === t.B42_lines[i + 1]),
        X.TEMPLATE_REMARKS.map((s, i) => [i + 1, s === t.B42_lines[i + 1]]));
      ok('10-03 拼接形态：remarks 标签 + 四条 \\n 相接 == 原件 B42 全值（导出件 cell.value 正是这个拼接）',
        `${X.TEMPLATE_TEXTS.remarks}\n${X.TEMPLATE_REMARKS.join('\n')}` === t.B42);
      ok('10-04 TEMPLATE_COEF_LABELS 四条与原件 B36~B39 逐字符一致（模板带「系数」后缀，此前误用引擎短标签）',
        E.ESTIMATE_COEF_KEYS.every((k, i) => X.TEMPLATE_COEF_LABELS[k] === t[COEF_ADDR[i]]),
        COEF_ADDR.map((a, i) => [a, X.TEMPLATE_COEF_LABELS[E.ESTIMATE_COEF_KEYS[i]], t[a]]));
      ok('10-05 原件 E4 拼写保留：半角左括号 + 全角右括号（「估算结果(单位：人天，1人天=8人时）」，不「修正」）',
        X.TEMPLATE_TEXTS.resultHeader === t.E4 && String(t.E4).includes('(单位') && String(t.E4).includes('人时）'),
        t.E4);
      ok('10-06 表头逐字符对齐原件（B4/E4/I4 行4 + B5/D5/E5/F5/G5/H5 行5 + B1 标题）',
        X.TEMPLATE_TEXTS.taskBreakdown === t.B4 && X.TEMPLATE_TEXTS.ratioHeader === t.I4
        && X.TEMPLATE_TEXTS.colBig === t.B5 && X.TEMPLATE_TEXTS.colSmall === t.D5
        && X.TEMPLATE_TEXTS.likely === t.E5 && X.TEMPLATE_TEXTS.min === t.F5
        && X.TEMPLATE_TEXTS.max === t.G5 && X.TEMPLATE_TEXTS.final === t.H5
        && X.TEMPLATE_TEXTS.title === t.B1,
        { B4: t.B4, I4: t.I4, B5: t.B5, D5: t.D5, E5: t.E5, F5: t.F5, G5: t.G5, H5: t.H5, B1: t.B1 });
      ok('10-07 汇总区文案逐字符对齐原件（D31 小计 / B35 理想 / B40 实际）',
        X.TEMPLATE_TEXTS.subtotal === t.D31 && X.TEMPLATE_TEXTS.ideal === t.B35 && X.TEMPLATE_TEXTS.actual === t.B40,
        { D31: t.D31, B35: t.B35, B40: t.B40 });
      ok('10-08 六个阶段名都能在原件 B 列精确找到（TEMPLATE_PHASE_LABELS 逐字符复制，不是照 PRD 文字臆造）',
        PHASES.every((p) => Object.values(t.Bcol as Record<string, string>).includes(X.TEMPLATE_PHASE_LABELS[p])),
        PHASES.map((p) => [p, X.TEMPLATE_PHASE_LABELS[p]]));
      // ---- 件面对齐：导出件 vs 原件（标准几何同址：系数 R36~R39 / 小计 R31 / 备注 R42）----
      ok('10-09 导出件 B42 与原件 B42 逐字符同值（交付件备注块 = 客户模板备注块）',
        e.B42 === t.B42, { exp: String(e.B42).slice(0, 30), tpl: String(t.B42).slice(0, 30) });
      ok('10-10 导出件 B36~B39 系数标签与原件同值（与客户模板并排看对得上名）',
        COEF_ADDR.every((a) => e[a] === t[a]), COEF_ADDR.map((a) => [a, e[a], t[a]]));
      ok('10-11 导出件 E4/H5/D31 与原件同格同值（表头拼写不漂）',
        e.E4 === t.E4 && e.H5 === t.H5 && e.D31 === t.D31, { E4: e.E4, H5: e.H5, D31: e.D31 });
      ok('10-12 导出件主 sheet 名与标题同原件（项目工作量估算表）',
        e.sheet === t.sheet && e.B1 === t.B1, [e.sheet, e.B1]);
    }
  }
}

// =====================================================================
console.log('\n=== R 段：/api/estimates/export-xlsx（隔离实例 REST 全链） ===');
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
{
  const db = getDb();
  const T = '2026-10-11T00:00:00.000Z';
  const PID = 'p-e6r';
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(PID, 'T02043-导出R段', '', T, T);
  const insPlan = db.prepare(
    `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
       progress, status, assignee, deps, req_ids, sort_order, created_at, updated_at, kind, complexity)
     VALUES (?, ?, ?, ?, '2026-10-12', '2026-10-12', ?, 0, 'todo', '', ?, ?, ?, ?, ?, ?, ?)`,
  );
  type Seed = [id: string, title: string, desc: string, dur: number, deps: string, reqIds: string, sort: number, kind: string, cx: number | null];
  const C1 = '[{"id":"r-ms-1","type":"child"}]';
  const C2 = '[{"id":"r-ms-2","type":"child"}]';
  const C3 = '[{"id":"r-ms-3","type":"child"}]';
  const seeds: Seed[] = [
    ['r-ms-1', 'M1 平台基座', '', 20, '[]', '[]', 1, 'milestone', 3],
    ['r-ms-2', 'M2 估算视图', '', 20, '[]', '[]', 2, 'milestone', 4],
    ['r-ms-3', 'M3 导出交付', '', 20, '[]', '[]', 3, 'milestone', 3],
    ['r-req-1', '需求分析：估算口径调研', '梳理客户模板三点列语义与命名区域取值。', 5, '[]', '["rq-1"]', 4, 'normal', 2],
    ['r-req-2', '需求分析：PRD 评审', '', 3, '[]', '[]', 5, 'normal', 2],
    ['r-design-1', '系统设计：估算数据模型', '', 4, '[]', '["rq-2"]', 6, 'normal', 3],
    ['r-dev-1', '开发：estimate_items 数据层', '第一行\n第二行 换行要压平', 6, C1, '[]', 7, 'normal', 3],
    ['r-dev-2', '开发：估算引擎三档', '', 6, C1, '[]', 8, 'normal', 3],
    ['r-dev-3', '开发：REST 通道', '', 6, C1, '[]', 9, 'normal', 2],
    ['r-dev-4', '开发：面板首段', '', 6, C1, '[]', 10, 'normal', 4],
    ['r-dev-5', '开发：行内录入', '', 6, C2, '[]', 11, 'normal', 3],
    ['r-dev-6', '开发：批量填充', '', 6, C2, '[]', 12, 'normal', 3],
    ['r-dev-7', '开发：区间条', '', 6, C2, '[]', 13, 'normal', 3],
    ['r-dev-8', '开发：脏数据兜底', '', 6, C3, '[]', 14, 'normal', 2],
    ['r-dev-9', '开发：导出接线', '', 6, C3, '[]', 15, 'normal', 2],
    ['r-dev-10', '开发：未估算的功能点', '这一行没有三点，导出件里必须留空', 6, '[]', '[]', 16, 'normal', 2],
    ['r-dev-11', '开发：无归属的功能点', '', 6, '[{"id":"r-ms-9","type":"serial"}]', '[]', 17, 'normal', 2],
    ['r-impl-1', '实施：部署与调测', '', 5, '[]', '[]', 18, 'normal', 2],
    ['r-common-1', '公共：项目管理分摊', '', 4, '[]', '[]', 19, 'normal', 1],
    ['r-onsite-1', '现场维护：驻员支持', '', 3, '[]', '[]', 20, 'normal', 1],
    ['r-arch-1', '开发：已归档的行不该出现在导出件', '', 6, '[]', '[]', 21, 'normal', 2],
  ];
  for (const [id, title, desc, dur, deps, reqIds, sort, kind, cx] of seeds) {
    insPlan.run(id, PID, title, desc, dur, deps, reqIds, sort, T, T, kind, cx);
  }
  db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ? WHERE id = ?').run(T, 'r-arch-1');
  const insReq = db.prepare(
    `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '', 'normal', 'todo', 0, ?, ?)`,
  );
  insReq.run('rq-1', PID, 'REQ-001', '估算口径来源', T, T);
  insReq.run('rq-2', PID, 'REQ-007', '数据模型来源', T, T);
  const insEst = db.prepare(
    `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, '', ?, ?)`,
  );
  const est: Array<[string, string, string, number, number, number, string]> = [
    ['e-arch', 'r-arch-1', 'dev', 9, 9, 9, 'manual'], // 归档行：不得进导出件
    ['e-ms', 'r-ms-1', 'dev', 5, 5, 5, 'manual'], // 里程碑行：有估算也不进 Σ（§4.6）
    ['e-1', 'r-dev-1', 'dev', 4, 6, 9, 'manual'],
    ['e-2', 'r-dev-2', 'dev', 4, 6, 9, 'manual'],
    ['e-3', 'r-dev-3', 'dev', 3, 5, 8, 'rule'],
    ['e-4', 'r-dev-4', 'dev', 5, 8, 12, 'default'],
    ['e-5', 'r-dev-5', 'dev', 4, 6, 9, 'manual'],
    ['e-6', 'r-dev-6', 'dev', 4, 6, 9, 'manual'],
    ['e-7', 'r-dev-7', 'dev', 3, 4, 6, 'default'],
    ['e-8', 'r-dev-8', 'dev', 2, 3, 5, 'manual'],
    ['e-9', 'r-dev-9', 'dev', 2, 3, 5, 'manual'],
    ['e-11', 'r-dev-11', 'dev', 2, 4, 7, 'manual'],
    ['e-req1', 'r-req-1', 'req', 4, 6, 9, 'manual'],
    ['e-req2', 'r-req-2', 'req', 2, 3, 4, 'rule'],
    ['e-des1', 'r-design-1', 'design', 3, 5, 7, 'manual'],
    ['e-imp1', 'r-impl-1', 'impl', 4, 5, 8, 'manual'],
    ['e-com1', 'r-common-1', 'common', 2, 3, 4, 'manual'],
    ['e-ons1', 'r-onsite-1', 'onsite', 1, 2, 3, 'manual'],
  ];
  for (const [id, planId, phase, o, m, p, source] of est) insEst.run(id, PID, planId, phase, o, m, p, source, T, T);
}
closeDb();

/** R 段夹具的独立重算（不读件内值，也不读 layout/summary）：排除归档行与里程碑行 */
function mineRest() {
  const pts: Points[] = [
    P(4, 6, 9), P(4, 6, 9), P(3, 5, 8), P(5, 8, 12), P(4, 6, 9), P(4, 6, 9), P(3, 4, 6), P(2, 3, 5), P(2, 3, 5), P(2, 4, 7),
    P(4, 6, 9), P(2, 3, 4), P(3, 5, 7), P(4, 5, 8), P(2, 3, 4), P(1, 2, 3),
  ];
  return { expectedTotal: pts.reduce((a, q) => a + E.expected(q), 0), coefSum: COEF_SUM };
}

const PORT = Number(process.env.T02043_PORT ?? 39935);
// 启动器按 native 模块 ABI 探测（打包.bat 会把 better-sqlite3 重编译成 Electron ABI，
// 此时 process.execPath 直跑会 ERR_DLOPEN_FAILED）——见 isolated-server-launcher.mts
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
const BASE = `http://127.0.0.1:${PORT}`;
async function waitForServer(ms = 60_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function api(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
  });
  let out: Record<string, any> | null = null;
  try { out = (await res.json()) as Record<string, any>; } catch { /* 非 JSON */ }
  return { status: res.status, json: out };
}
async function getXlsx(query: string) {
  const res = await fetch(`${BASE}/api/estimates/export-xlsx${query}`);
  if (!res.ok) {
    return { status: res.status, buf: Buffer.alloc(0), headers: res.headers, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  }
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers, json: null as Record<string, any> | null };
}
const PQ = 'projectId=p-e6r';

if (!(await waitForServer())) {
  console.log('  [FAIL] 隔离服务未就绪，R 段整体跳过');
  console.log(serverLog.join('').slice(-1500));
  fail += 1;
} else {
  group('R1 端点基本形态');
  {
    ok('R-01 隔离实例就绪', (await api('GET', '/api/health')).status === 200);
    const r = await getXlsx(`?${PQ}`);
    ok('R-02 GET export-xlsx 200 + xlsx MIME', r.status === 200 && String(r.headers.get('content-type')).includes('spreadsheetml.sheet'),
      [r.status, r.headers.get('content-type')]);
    ok('R-03 字节是合法 xlsx（能解出 sheet1 主表）', r.buf.length > 15_000 && unzip(r.buf).file('xl/worksheets/sheet1.xml') !== null, r.buf.length);
    const cd = String(r.headers.get('content-disposition'));
    ok('R-04 文件名走 RFC5987（中文项目名不变成 ???）',
      cd.includes("filename*=UTF-8''") && decodeURIComponent(cd.split("filename*=UTF-8''")[1]).startsWith('工作量评估-T02043-导出R段'), cd.slice(0, 80));
    ok('R-05 响应头回带快照 id（§6.3 每次导出留痕）', /^[\w-]+$/.test(String(r.headers.get('x-estimate-snapshot'))), r.headers.get('x-estimate-snapshot'));
    const noPid = await getXlsx('');
    ok('R-06 projectId 缺失 → 400 中文文案（不是半份导出件）', noPid.status === 400 && noPid.json?.error === 'projectId 必填', noPid.json);
    const badAud = await getXlsx(`?${PQ}&audience=bogus`);
    ok('R-07 未知版本 → 400（不能静默回落内部版，把内部 sheet 交给客户）', badAud.status === 400 && String(badAud.json?.error).includes('未知导出版本'), badAud.json);
    const badPh = await getXlsx(`?${PQ}&phases=bogus`);
    ok('R-08 未知阶段 → 400（静默吞掉会让「只导开发段」实际导出全部，报价范围悄悄变了）',
      badPh.status === 400 && String(badPh.json?.error).includes('未知阶段'), badPh.json);
    const badScope = await getXlsx(`?${PQ}&scope=bogus`);
    ok('R-09 未知范围 → 400', badScope.status === 400 && String(badScope.json?.error).includes('未知导出范围'), badScope.json);
    // R-10 曾断言 export-pdf 是 404（E6 当时的口径：「E7 未落地就不留占位路由」）。
    // E7 已落地（T02044），这里改为回归面：PDF 与 xlsx 共用 `buildEstimateArtifact`——
    // 两条通道都能出件、都带快照头，才证明「同一条流水线」不是文档说法。
    const pdf = await fetch(`${BASE}/api/estimates/export-pdf?${PQ}`);
    const pdfBuf = pdf.ok ? Buffer.from(await pdf.arrayBuffer()) : Buffer.alloc(0);
    ok('R-10a export-pdf 已落地：200 + PDF 魔数（与 xlsx 同一条 buildEstimateArtifact）',
      pdf.status === 200 && pdfBuf.slice(0, 5).toString() === '%PDF-' && pdfBuf.slice(-6).toString().includes('%%EOF'),
      { status: pdf.status, size: pdfBuf.length });
    ok('R-10b export-pdf 也回带快照 id（§6.3 留痕对两种格式一致）',
      /^[\w-]+$/.test(String(pdf.headers.get('x-estimate-snapshot'))), pdf.headers.get('x-estimate-snapshot'));
    const pdfNoPid = await fetch(`${BASE}/api/estimates/export-pdf`);
    ok('R-10c export-pdf 缺 projectId → 400 中文文案（与 xlsx 同词表，不出半份件）',
      pdfNoPid.status === 400 && String((await pdfNoPid.json().catch(() => ({})))?.error).includes('projectId'), pdfNoPid.status);
    const ghost = await getXlsx('?projectId=no-such-project-e6');
    if (ghost.status === 200) {
      const gc = parseCells(mainXml(ghost.buf));
      ok('R-11 不存在的项目：不 500、不编造数字（空件汇总缓存值为 0）',
        Number.isFinite(cellNum(gc, 'H16')) && cellNum(gc, 'H16') === 0, { status: ghost.status, h: cellNum(gc, 'H16') });
    } else {
      ok('R-11 不存在的项目：直接 400 中文报错（不交出一份看起来有数的空件）',
        ghost.status === 400 && String(ghost.json?.error).includes('项目不存在'), { status: ghost.status, json: ghost.json });
    }
  }

  group('R2 取数口径（deps child 通道 / 归档行 / 里程碑行 / 空行 / 需求编号）');
  {
    const r = await getXlsx(`?${PQ}`);
    const xml = mainXml(r.buf);
    const cs = parseCells(xml);
    const wb = await loadWb(r.buf);
    const ws = wb.getWorksheet(X.SHEET_MAIN);
    ok('R-12 几何按实际数据重排（小计 R19 / 理想 R23 / 系数 R24~R27 / 实际 R28）——行号不是写死的',
      cs.get('H19')!.f === 'SUBTOTAL(9,H8:H18)' && cs.get('H23')!.f === 'SUBTOTAL(9,H6:H22)/每人月工天标准'
      && cs.get('H28')!.f === 'H23*(1+SUM(H24:H27))', [cs.get('H19')?.f, cs.get('H23')?.f, cs.get('H28')?.f]);
    const mr = mineRest();
    ok('R-13 归档行 r-arch-1（9/9/9）没进导出件：H23 = Σ(其余行) ÷ 20.83',
      Math.abs(cellNum(cs, 'H23') - mr.expectedTotal / STD) < 1e-6, { got: cellNum(cs, 'H23'), want: mr.expectedTotal / STD });
    ok('R-14 里程碑行 r-ms-1 的三点（5/5/5）不进 Σ（§4.6 里程碑不重复计）',
      Math.abs(cellNum(cs, 'H28') - (mr.expectedTotal * (1 + mr.coefSum) / STD)) < 1e-6, cellNum(cs, 'H28'));
    ok('R-15 未估算行 r-dev-10 成行但三点留空（导出件不把「没估」写成 0）',
      cellText(ws, 'D17').includes('这一行没有三点') && cellText(ws, 'E17') === '' && isEmptyCell(cs, 'H17'),
      { d17: cellText(ws, 'D17').slice(0, 20), e17: cellText(ws, 'E17'), h17: cs.get('H17') });
    const cMerges = [...xml.matchAll(/<mergeCell ref="(C\d+:C\d+)"/g)].map((m) => m[1]);
    ok('R-16 C 列合并来自 `deps type=child` 的原始 JSON（planDeps 的 serial/parallel 归一里没有 child 这条通道）',
      cMerges.join('|') === 'C8:C11|C12:C14|C15:C16', cMerges);
    ok('R-17 r-dev-11 的 serial 依赖不被误判成里程碑归属（C18 无合并、C 列留空）',
      !cMerges.some((m) => m.includes('C18')) && cellText(ws, 'C18') === '', cMerges);
    ok('R-18 里程碑标题进 C 列、D 列是压平后的功能点（主 sheet 不长出「计划标题」列）',
      cellText(ws, 'C8') === 'M1 平台基座' && cellText(ws, 'D8').includes('换行要压平') && cs.get('H18') !== undefined,
      [cellText(ws, 'C8'), cellText(ws, 'D8').slice(0, 16)]);
    const detail = wb.getWorksheet(X.SHEET_DETAIL);
    const colA = Array.from({ length: detail?.rowCount ?? 0 }, (_, i) => cellText(detail, `A${i + 2}`));
    ok('R-19 明细 sheet 的需求编号列把 req_id 换成 REQ-xxx（不是内部 id）',
      colA.includes('REQ-001') && colA.includes('REQ-007'), colA.filter(Boolean));
    ok('R-20 描述换行在导出前压平（一个功能点一行，不能撑出模板行高）',
      Array.from({ length: detail?.rowCount ?? 0 }, (_, i) => cellText(detail, `D${i + 2}`)).some((t) => t.includes('第一行 第二行 换行要压平')));
    ok('R-21 合并区 25 处（8 固定 + 5 阶段 + 2 开发纵向 + 3 C 组 + 6 汇总 + 1 备注）',
      (xml.match(/<mergeCell /g) || []).length === 25, (xml.match(/<mergeCell /g) || []).length);
  }

  group('R3 面板 Σ 与导出件 R40 同源（§10-14 的导出侧）');
  {
    const list = await api('GET', `/api/estimates?${PQ}`);
    const items = (list.json?.items ?? []) as Array<Record<string, unknown>>;
    const s = E.buildSummary(items.map((v) => E.toEngineRow(v as never)), CFG);
    const r = await getXlsx(`?${PQ}`);
    const cs = parseCells(mainXml(r.buf));
    eq('R-22 导出件 H28（实际预估人月）= 面板 actualManMonths.expected', cellNum(cs, 'H28'), s.actualManMonths.expected);
    eq('R-23 导出件 H23（理想人月）= 面板 idealManMonths.expected', cellNum(cs, 'H23'), s.idealManMonths.expected);
    eq('R-24 导出件 I28 = 面板 ratioCheck.sumRatio（§4.4 自检口径两侧同值）', cellNum(cs, 'I28'), s.ratioCheck.sumRatio, 1e-9);
    ok('R-25 面板比例自检无 danger（完备数据 100%）', s.ratioCheck.danger === false && s.ratioCheck.unassigned.length === 0, s.ratioCheck);
    const snap = await api('GET', `/api/estimates/snapshots?${PQ}&limit=10`);
    const arr = (snap.json?.snapshots ?? []) as Array<Record<string, any>>;
    const mine2 = arr.find((x) => x.id === r.headers.get('x-estimate-snapshot'));
    const pl = typeof mine2?.payload === 'string' ? JSON.parse(mine2.payload) : mine2?.payload;
    ok('R-26 快照可按响应头 id 查到，payload 带汇总与结构计数',
      mine2 !== undefined && mine2.format === 'xlsx'
      && Math.abs((pl?.summary?.actualManMonths?.expected ?? NaN) - s.actualManMonths.expected) < 1e-9,
      { payloadKeys: pl && Object.keys(pl), snapshot: pl?.summary?.actualManMonths?.expected, panel: s.actualManMonths.expected });
    ok('R-27 快照 payload.merges = 件内合并区数（25，交叉对账）',
      pl?.merges === (mainXml(r.buf).match(/<mergeCell /g) || []).length, pl?.merges);
    ok('R-28 快照记录未复核行数 = 4（dev 的 rule 1 + default 2，req 的 rule 1；§6.3 复核标注的留痕侧）', pl?.unreviewed === 4, pl?.unreviewed);
    ok('R-29 快照 mainRows = 11 条明细 + 5 个有数据的阶段行 = 16', pl?.mainRows === 16, pl?.mainRows);
    ok('R-30 快照记录版本与范围（客户版/内部版可事后区分）', pl?.audience === 'internal' && pl?.scope === 'all', [pl?.audience, pl?.scope]);
  }

  group('R4 客户版 / 参数开关 / 范围筛选（REST 侧）');
  {
    const before = await getXlsx(`?${PQ}&audience=client`);
    const z = unzip(before.buf);
    const csC = parseCells(mainXml(before.buf));
    const csI = parseCells(mainXml((await getXlsx(`?${PQ}`)).buf));
    ok('R-31 客户版默认只有主 sheet（内部两个 sheet 不产出）',
      z.file('xl/worksheets/sheet2.xml') === null && z.file('xl/worksheets/sheet3.xml') === null,
      Object.keys(z.files as object).filter((k) => k.startsWith('xl/worksheets')));
    eq('R-32 未开折叠时客户版 H28 与内部版同值', cellNum(csC, 'H28'), cellNum(csI, 'H28'));
    const put = await api('PUT', `/api/estimates/params?${PQ}`, { settings: { 'estimate.hideCoefsForClient': '1' } });
    ok('R-33 参数页可开 hideCoefsForClient（开关真的进生效 config）', put.status === 200 && put.json?.config?.hideCoefsForClient === true, put.json?.config);
    const folded = await getXlsx(`?${PQ}&audience=client`);
    const cf = parseCells(mainXml(folded.buf));
    eq('R-34 折叠后对外报价不变（H28 分文不差）', cellNum(cf, 'H28'), cellNum(csI, 'H28'));
    ok('R-35 折叠后系数分项不再出现在交付件里（R24 是合计 0.23，R25~R27 为 0）',
      Math.abs(cellNum(cf, 'E24') - COEF_SUM) < 1e-12 && cellNum(cf, 'E25') === 0 && cellNum(cf, 'E27') === 0,
      { e24: cf.get('E24')?.v, e25: cf.get('E25')?.v });
    const wbc = await loadWb(folded.buf);
    const wsc = wbc.getWorksheet(X.SHEET_MAIN);
    ok('R-36 客户版不含备注四条与系数分项标签，含「综合调节系数（内部明细略）」',
      cellText(wsc, 'B30') === '' && !cellText(wsc, 'B24').includes('客户协作配合') && cellText(wsc, 'B24').includes(X.TEMPLATE_TEXTS.foldedCoef),
      cellText(wsc, 'B24'));
    eq('R-37 折叠版 I28 仍为 1（比例自检不因折叠失真）', cellNum(cf, 'I28'), 1);
    await api('PUT', `/api/estimates/params?${PQ}`, { settings: { 'estimate.hideCoefsForClient': '' } });
    const devOnly = await getXlsx(`?${PQ}&phases=dev`);
    const dv = parseCells(mainXml(devOnly.buf));
    ok('R-38 phases=dev：开发段整体比例的合并锚点（I6）指向本件的小计行 H17 与合计行 H23',
      dv.get('H6')!.f === X.templateHFormula(6) && dv.get('I6')!.f === 'IFERROR(H17/每人月工天标准/$H$23,"")',
      [dv.get('H6')?.f, dv.get('I6')?.f]);
    ok('R-39 dev-only 时阶段行不留空位，合并区降为 20 处',
      (mainXml(devOnly.buf).match(/<mergeCell /g) || []).length === 20, (mainXml(devOnly.buf).match(/<mergeCell /g) || []).length);
    const estOnly = await getXlsx(`?${PQ}&scope=estimated_only`);
    const eo = parseCells(mainXml(estOnly.buf));
    ok('R-40 scope=estimated_only 时未估算行不进主 sheet：小计上移到 R18（区间 H8:H17），合计行跟着收窄（非 dev 阶段行有三点仍保留）',
      eo.get('H18')!.f === 'SUBTOTAL(9,H8:H17)' && eo.get('H22')!.f === 'SUBTOTAL(9,H6:H21)/每人月工天标准',
      [eo.get('H18')?.f, eo.get('H22')?.f]);
  }

  group('R5 §7 快照对比：导出 payload 必须喂得动既有的 diffSnapshots（比对契约）');
  {
    const a = await getXlsx(`?${PQ}`);
    const idA = String(a.headers.get('x-estimate-snapshot'));
    // 改一行三点（走 REST：写路径的校验与 source 转人工都归服务端，脚本不直改库）
    const patch = await api('PATCH', `/api/estimates/r-dev-1?${PQ}`, { phase: 'dev', unit: 'man_day', optimistic: 4, likely: 12, pessimistic: 12 });
    const b = await getXlsx(`?${PQ}`);
    const idB = String(b.headers.get('x-estimate-snapshot'));
    const cmp = await api('GET', `/api/estimates/snapshots?${PQ}&limit=20&compare=${encodeURIComponent(`${idA},${idB}`)}`);
    const diff = cmp.json?.compare?.diff as Record<string, any> | undefined;
    ok('R-41 两份导出快照可成对比较（payload 不是「写得进读不出」的自说自话结构）',
      patch.status === 200 && cmp.status === 200 && diff !== undefined, [patch.status, patch.json?.error, cmp.status]);
    ok('R-42 逐阶段差异非空且点名到 dev（payload 顶层 phases 必须是 §7 要的「每阶段汇总」，不是导出筛选的字符串数组）',
      Array.isArray(diff?.phases) && diff.phases.length > 0
      && String(diff.phases.find((p: any) => p.phase === 'dev')?.expected?.delta ?? NaN) !== 'NaN',
      diff?.phases);
    // E=(O+4M+P)/6 手算两侧：(4,6,9)→(4,12,12) ⇒ 该阶段 E 差 4.5 人天（脚本不读服务端算出的那一份）
    const D_E = (4 + 4 * 12 + 12) / 6 - (4 + 4 * 6 + 9) / 6;
    const dev = (diff?.phases ?? []).find((p: any) => p.phase === 'dev');
    eq('R-43 差异数值 = 独立推算的 +4.5 人天（按 §4.2 原式手算）', dev?.expected?.delta ?? NaN, D_E, 1e-6);
    eq('R-44 合计口径同步：直接投入 +4.5 人天', diff?.totals?.directManDays ?? NaN, D_E, 1e-6);
    eq('R-45 人月合计差 = ΔE÷20.83×(1+Σ系数)（顶层 actualManMonths 走的是 ColumnSum.expected）',
      diff?.totals?.actualManMonths ?? NaN, (D_E / STD) * (1 + COEF_SUM), 1e-6);
    const snaps = (cmp.json?.snapshots ?? []) as Array<Record<string, any>>;
    const payloadOf = (id: string) => {
      const row = snaps.find((x) => x.id === id);
      const p = typeof row?.payload === 'string' ? JSON.parse(row.payload) : row?.payload;
      return p as Record<string, any>;
    };
    const pa = payloadOf(idA);
    ok('R-46 阶段筛选与逐阶段汇总各归各位（同名两用会让比对静默出空表）',
      Array.isArray(pa?.phaseFilter) && typeof pa?.phaseFilter?.[0] === 'string'
      && Array.isArray(pa?.phases) && typeof pa?.phases?.[0] === 'object',
      { phaseFilter: pa?.phaseFilter, phases0: pa?.phases?.[0] });
  }

  group('R6 T02086 裁决「不进」：reviewer 的 API 写入通道 + 留空路径 + 不进参数面');
  {
    // 反面：本键不是 §3.3 八键——/meta 的 settingKeys 面没有它，不参与生效值试算
    const meta = await api('GET', `/api/estimates/meta?${PQ}`);
    ok('R-47 estimate.reviewer 不进 settingKeys 面（裁决「不进」：不是 §3.3 八键、不进 E13 参数页）',
      !Object.values((meta.json?.settingKeys as Record<string, string> | undefined) ?? {}).includes('estimate.reviewer'),
      Object.values((meta.json?.settingKeys as Record<string, string> | undefined) ?? {}).filter((k) => k.includes('reviewer')));
    // 正面：API 级写入通道在（E7/v2.2 起为 PDF 署名开的口子），写后回读到导出件 H2
    const putRev = await api('PUT', `/api/estimates/params?${PQ}`, { settings: { 'estimate.reviewer': '王南' } });
    const withRev = await getXlsx(`?${PQ}`);
    const wsr = await loadWb(withRev.buf);
    ok('R-48 PUT /params 可写 reviewer 且落到导出件 H2（通道在、但参数页 UI 不出现该输入框）',
      putRev.status === 200 && cellText(wsr.getWorksheet(X.SHEET_MAIN), 'H2') === '王南',
      [putRev.status, cellText(wsr.getWorksheet(X.SHEET_MAIN), 'H2')]);
    // 留空路径：显式清空 → 导出不报错、H2 不留假名（§6.1「或留空」分支，也是裁决「不进」的日常形态）
    const clr = await api('PUT', `/api/estimates/params?${PQ}`, { settings: { 'estimate.reviewer': '' } });
    const noRev = await getXlsx(`?${PQ}`);
    const wsn = await loadWb(noRev.buf);
    ok('R-49 清空 reviewer 后导出不报错且 H2 留空——cleared 如实回明、不写假名',
      clr.status === 200 && ((clr.json?.cleared as string[] | undefined) ?? []).includes('estimate.reviewer')
      && cellText(wsn.getWorksheet(X.SHEET_MAIN), 'H2') === '',
      [clr.status, clr.json?.cleared, cellText(wsn.getWorksheet(X.SHEET_MAIN), 'H2')]);
  }
}

// 先收实例再回收临时目录：child.kill() 是异步的，立即 rmSync 会撞上还在被 sqlite 持有的 mtask.db-shm
await new Promise<void>((resolve) => {
  const done = () => resolve();
  child.once('exit', done);
  child.kill();
  setTimeout(done, 4000);
});
console.log(`\n合计 PASS=${pass} FAIL=${fail}`);
try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {
  console.log(`  [WARN] 临时目录回收失败（不影响断言结论）：${String((e as Error)?.message).slice(0, 120)}`);
}
process.exit(fail === 0 ? 0 : 1);
