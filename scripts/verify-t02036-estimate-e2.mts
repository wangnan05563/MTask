/**
 * E2（T02036 · PRD-估算视图 §4）验证脚本——`estimate-engine.ts` 黄金样例 + 汇总口径 + 模板仿真对照。
 *
 * 用法：`<node22runtime> node_modules/tsx/dist/cli.mjs scripts/verify-t02036-estimate-e2.mts`
 *   ⚠ Node 版本须与 node_modules/better-sqlite3 的预编译 ABI 对齐（本机 2026-10-11 实测：
 *     Node22 ABI127 可加载，仓库默认 node24 直跑报 ERR_DLOPEN_FAILED）；runtime 由调用方传入，
 *     不在 package.json 硬编码绝对路径（同 verify-t02034-estimate-e1.mts 的写法）。
 *
 * 覆盖面：
 *   G1 期望值/σ 与模板原式逐值等价（§4.2/§4.3，含附录 A 的 H 列实测缓存值）
 *   G2 参数配置与换算（§3.3 + 裁决 D1 的 20.83，以及 §4.5 工作日换算）
 *   G3 汇总口径（§4.4 **排除小计行**、§4.6 **里程碑不进 Σ**、R35/R40 四列、系数行三点同值）
 *   G4 比例自检 I40（§4.4：完备数据恒 100%，未归阶段行触发 danger 并点名到行）
 *   G5 **Excel SUBTOTAL 语义仿真对照**（§10-14「前端 Σ ≈ 模板 H35」差 <0.01 人月，
 *      并正面复现「朴素 sum 把开发段算两遍」这个坑）
 *   G6 与 E1 数据层的接缝（隔离库 → EstimateService 视图行 → toEngineRow → buildSummary）
 *
 * 隔离纪律（skill 红线 8）：G6 用 `os.tmpdir()/t02036-e2-*` 新建空库，不碰生产库，跑完回收。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：文案锚必须配行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02036-e2-'));
process.env.MTask_DATA_DIR = DATA_DIR;

const E = await import('../server/src/services/estimate-engine.ts');
const { addWorkdays, buildCalendar } = await import('../server/src/util/workdays.ts');
// 单源词干表（G7 改名模拟要改的就是这个对象；引擎与门进程引用同一份 on-disk estimateCopy，改表即改文案）
const { ESTIMATE_ERRORS } = await import('../server/src/services/EstimateService.ts');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra).slice(0, 320)}` : ''}`);
  }
};
const eq = (name: string, a: number, b: number, tol = 1e-9) =>
  ok(`${name}（${a.toFixed(6)} ≈ ${b.toFixed(6)}）`, Math.abs(a - b) <= tol, { a, b, diff: Math.abs(a - b) });
const errOf = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
/**
 * 同进程抛错类断言的配对器（T02293 判据 3）：
 * 行为侧 = 确实抛了错（`extraBehavior` 再叠一枚「合法入参照样通过」，把「静默不校验」与「只是换了措辞」分开）；
 * 字面侧 = 文案含产品**单源词干**（`ESTIMATE_ERRORS`，见 `server/src/services/estimateCopy.ts`），门不重打整句。
 */
const rejectedMsg = (
  label: string,
  msg: string,
  stem: string,
  extraBehavior?: () => boolean,
) => okPair(ok, label,
  () => msg.length > 0 && (extraBehavior ? extraBehavior() : true),
  () => msg.includes(stem),
  () => ({ 文案: msg.slice(0, 140) }));
const group = (t: string) => console.log(`\n== ${t}`);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const P = (o: number, m: number, p: number) => ({ optimistic: o, likely: m, pessimistic: p });
/** 明细行快捷构造 */
const row = (key: string, phase: string, pts: { optimistic: number; likely: number; pessimistic: number } | null, extra: Record<string, unknown> = {}) =>
  ({ key, phase, points: pts, role: 'detail', planKind: 'normal', ...extra });

// =====================================================================
group('G1 期望值 / σ / 模板原式逐值等价（§4.2 §4.3）');
{
  eq('1-01 黄金样例 O=6 M=21 P=36 → E=21（PRD §4.2 明文样例）', E.expected(P(6, 21, 36)), 21);
  // 附录 A 的 H 列实测缓存值（三点同值退化输入下 E 值可直接比对）
  const appendix: Array<[string, number, number, number, number]> = [
    ['需求分析', 12, 12, 16, 12.667],
    ['系统设计', 20, 20, 24, 20.667],
    ['开发首行', 6, 6, 7, 6.167],
    ['实施', 30, 30, 35, 30.833],
    ['公共&远程投入', 20, 20, 20, 20],
    ['现场维护', 10, 10, 10, 10],
  ];
  for (const [label, o, m, p, want] of appendix) {
    eq(`1-02 附录 A ${label} ${o}/${m}/${p} → H=${want}`, r3(E.expected(P(o, m, p))), want, 5e-4);
  }
  eq('1-03 σ=(P−O)/6：12/12/16 → 0.666667', E.sigma(P(12, 12, 16)), 4 / 6);
  eq('1-04 σ：三点同值 → 0', E.sigma(P(20, 20, 20)), 0);

  // §4.2 硬要求：标准式与模板 MIN/MAX/COUNTA 式在 COUNTA=3 下**逐值相等**（0.5 精度全网格）
  const step = 0.5, max = 20;
  let cells = 0, worst = 0, worstAt = '';
  for (let o = 0; o <= max; o += step) {
    for (let m = o; m <= max; m += step) {
      for (let p = m; p <= max; p += step) {
        const d = Math.abs(E.expected(P(o, m, p)) - E.expectedByTemplateFormula(P(o, m, p)));
        cells += 1;
        if (d > worst) { worst = d; worstAt = `${o}/${m}/${p}`; }
      }
    }
  }
  ok(`1-05 O≤M≤P 全网格 ${cells} 格逐值相等（最大偏差 ${worst.toExponential(2)} @ ${worstAt || '—'}）`, cells > 1000 && worst < 1e-12, { cells, worst, worstAt });

  // 反例（写清楚才有意义）：三点**乱序**时两式不等价——模板式靠 MIN/MAX 定位中值，标准式按位次加权。
  // 所以「两式等价」的前提是 O≤M≤P，而这个前提由 E1 服务层校验守住（verify-t02034 C-10）；
  // 引擎本身不校验（录入校验只应有一个落点），因此这条契约必须被断言而不是靠默契。
  const badCase = P(0, 5, 1);
  ok('1-06 乱序三点两式不等价（反例 0/5/1：标准式 3.5 vs 模板式 1.5）——O≤M≤P 是等价前提，由 E1 校验守住',
    E.expected(badCase) === 3.5 && E.expectedByTemplateFormula(badCase) === 1.5
    && Math.abs(E.expected(badCase) - E.expectedByTemplateFormula(badCase)) > 1,
    { std: E.expected(badCase), tpl: E.expectedByTemplateFormula(badCase) });
  let divergeCount = 0, gridCount = 0;
  for (let a = 0; a <= 10; a += 1) for (let b = 0; b <= 10; b += 1) for (let c = 0; c <= 10; c += 1) {
    gridCount += 1;
    if (!(a <= b && b <= c)) continue;
    if (Math.abs(E.expected(P(a, b, c)) - E.expectedByTemplateFormula(P(a, b, c))) > 1e-12) divergeCount += 1;
  }
  ok(`1-06b 整数网格 ${gridCount} 格中，凡满足 O≤M≤P 者两式全部等价（违例 ${divergeCount} 条）`, divergeCount === 0, { gridCount, divergeCount });

  // 期望性是线性算子：Σ E_i == (ΣO + 4ΣM + ΣP)/6 —— R35 的 H 列与「先求和再套公式」必然同值
  const set = [P(6, 6, 7), P(12, 12, 16), P(30, 30, 35), P(2, 5, 20)];
  const sO = set.reduce((a, x) => a + x.optimistic, 0);
  const sM = set.reduce((a, x) => a + x.likely, 0);
  const sP = set.reduce((a, x) => a + x.pessimistic, 0);
  eq('1-07 Σ E_i == (ΣO+4ΣM+ΣP)/6（线性恒等，保证列和口径一致）',
    set.reduce((a, x) => a + E.expected(x), 0), (sO + 4 * sM + sP) / 6);

  const cf = E.confidence(21, 5);
  ok('1-08 置信区间 P68=[16,26] / P84=E+σ=26 / P95=[11,31] / P99=[6,36]',
    cf.p68[0] === 16 && cf.p68[1] === 26 && cf.p84 === 26 && cf.p95[0] === 11 && cf.p99[1] === 36, cf);
}

// =====================================================================
group('G2 参数配置与换算（§3.3 裁决 D1 + §4.5）');
{
  const d = E.DEFAULT_ESTIMATE_CONFIG;
  ok('2-01 默认值逐条对上 §3.3（20.83 / 8 / 0.06 / 0.06 / 0.05 / 0.06 / O=M,P=1.6M / 不隐藏系数）',
    d.manDaysPerManMonth === 20.83 && d.hoursPerManDay === 8
    && d.coefs.collaboration === 0.06 && d.coefs.quality === 0.06 && d.coefs.scope === 0.05 && d.coefs.schedule === 0.06
    && d.ruleRatio.oMul === 1 && d.ruleRatio.pMul === 1.6 && d.hideCoefsForClient === false, d);
  ok('2-02 §3.3 八个配置键名单源（E3 读写、E13 参数页共用同一张表）',
    Object.keys(E.ESTIMATE_SETTING_KEYS).length === 8
    && E.ESTIMATE_SETTING_KEYS.manDaysPerManMonth === 'estimate.manDaysPerManMonth'
    && E.ESTIMATE_SETTING_KEYS.hideCoefsForClient === 'estimate.hideCoefsForClient', E.ESTIMATE_SETTING_KEYS);
  ok('2-03 空 KV → 全默认', JSON.stringify(E.resolveEstimateConfig({})) === JSON.stringify(d));
  const over = E.resolveEstimateConfig({
    'estimate.manDaysPerManMonth': '20',
    'estimate.hoursPerManDay': 6,
    'estimate.coef.scope': '0.1',
    'estimate.hideCoefsForClient': 'true',
    'estimate.rule.default.ratio': '0.8:4:1.4',
  });
  ok('2-04 覆盖生效（20 / 6 / scope 0.1 / 隐藏系数 / 0.8:4:1.4）',
    over.manDaysPerManMonth === 20 && over.hoursPerManDay === 6 && over.coefs.scope === 0.1
    && over.hideCoefsForClient === true && over.ruleRatio.oMul === 0.8 && over.ruleRatio.pMul === 1.4, over);
  // 非法值一律报错不静默——四支各自配「合法入参照样通过」的行为侧，字面侧取单源词干而非整句抄本。
  // 原门把四类拒绝 AND 成一条 `ok`，红的时候读不出是哪一类失守；拆成四对 okPair 后覆盖面不缩、红因可定位。
  const cfgOk = () => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': '20.83', 'estimate.hoursPerManDay': '8' });
  rejectedMsg('2-05a 参数非数字 → 抛「必须是数字」（且合法入参照样解析）',
    errOf(() => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': 'abc' })), ESTIMATE_ERRORS.notNumber, () => !!cfgOk());
  rejectedMsg('2-05b 低于下限 → 抛「不得小于」（且合法入参照样解析）',
    errOf(() => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': '0' })), ESTIMATE_ERRORS.paramMin, () => !!cfgOk());
  rejectedMsg('2-05c 系数越上限 → 抛「不得大于」（且合法入参照样解析）',
    errOf(() => E.resolveEstimateConfig({ 'estimate.coef.quality': '1.5' })), ESTIMATE_ERRORS.paramMax, () => !!cfgOk());
  rejectedMsg('2-05d 工时越上限 → 抛「不得大于」（且合法入参照样解析）',
    errOf(() => E.resolveEstimateConfig({ 'estimate.hoursPerManDay': '25' })), ESTIMATE_ERRORS.paramMax, () => !!cfgOk());
  const ratioErr = errOf(() => E.parseRuleRatio('1:5:1.6'));
  rejectedMsg('2-06 ratio 中段必须是 PERT 权重 4（写错直接报错，不猜口径；合法比例仍解析）',
    ratioErr, ESTIMATE_ERRORS.ratioMidPert,
    () => JSON.stringify(E.parseRuleRatio('1:4:1.6')) === JSON.stringify({ oMul: 1, pMul: 1.6 }));
  rejectedMsg('2-07a ratio 段数不足 → 抛三段正数（合法比例仍解析）',
    errOf(() => E.parseRuleRatio('1:4')), ESTIMATE_ERRORS.ratioFormat, () => !!E.parseRuleRatio('1:4:1'));
  rejectedMsg('2-07b ratio 含负值 → 抛三段正数（合法比例仍解析）',
    errOf(() => E.parseRuleRatio('1:4:-1.6')), ESTIMATE_ERRORS.ratioFormat, () => !!E.parseRuleRatio('1:4:1'));
  eq('2-08 人天 → 人月 ÷20.83', E.toManMonth(20.83), 1);
  eq('2-09 人天 → 人时 ×8', E.toHours(2.5), 20);
  const cal = buildCalendar([
    { date: '2026-10-12', kind: 'holiday' },
    { date: '2026-10-17', kind: 'overtime' },
  ]);
  ok('2-10 E 值 → 日历天落点走工作日正向（10-09 周五起 3 人天：跳 10-10/11 周末与 10-12 放假 → 10-13/14/15）',
    E.expectedEndWorkday('2026-10-09', 3, cal) === '2026-10-15', E.expectedEndWorkday('2026-10-09', 3, cal));
  ok('2-11 小数 E 值向上取整为工作日（0.5 人天 → 1 个工作日）',
    E.expectedEndWorkday('2026-10-09', 0.5, cal) === '2026-10-13', E.expectedEndWorkday('2026-10-09', 0.5, cal));
  ok('2-12 加班日照常上班（10-17 周六是工作日：10-16 起 2 人天 → 10-19）',
    E.expectedEndWorkday('2026-10-16', 2, cal) === '2026-10-19', E.expectedEndWorkday('2026-10-16', 2, cal));
  ok('2-13 与 E1 的 addWorkdays 同一实现（引擎不自带第二套工作日口径）',
    E.expectedEndWorkday('2026-10-09', 5, cal) === addWorkdays('2026-10-09', 5, cal));
}

// =====================================================================
group('G3 汇总口径（§4.4 排除小计行 · §4.6 里程碑不进 Σ）');
{
  const cfg = E.DEFAULT_ESTIMATE_CONFIG;
  const rows = [
    row('m-req', 'req', P(12, 12, 16), { role: 'phase' }),
    row('m-design', 'design', P(20, 20, 24), { role: 'phase' }),
    row('d1', 'dev', P(6, 6, 7)),
    row('d2', 'dev', P(10, 12, 20)),
    row('d3', 'dev', P(2, 2, 2)),
    row('subtotal-dev', 'dev', P(18, 20, 29), { role: 'subtotal' }),   // 模板 R31：值恰为明细之和
    row('m-impl', 'impl', P(30, 30, 35), { role: 'phase' }),
    row('m-common', 'common', P(20, 20, 20), { role: 'phase' }),
    row('m-onsite', 'onsite', P(10, 10, 10), { role: 'phase' }),
    row('none', 'dev', null),
  ];
  const s = E.buildSummary(rows, cfg);
  const devWant = E.expected(P(6, 6, 7)) + E.expected(P(10, 12, 20)) + E.expected(P(2, 2, 2));
  eq('3-01 开发段 Σ 只含明细行，**小计行未被重复计入**', s.phases.find((p) => p.phase === 'dev')!.expected, devWant);
  ok('3-02 小计行计入 excluded.subtotal、未估行计入 excluded.unEstimated',
    s.ratioCheck.excluded.subtotal === 1 && s.ratioCheck.excluded.unEstimated === 1, s.ratioCheck.excluded);
  ok('3-03 六阶段齐全且按 ESTIMATE_PHASES 定序', s.phases.map((p) => p.phase).join(',') === 'req,design,dev,impl,common,onsite');
  ok('3-04 阶段 rowCount 只算进 Σ 的行', (() => {
    const dev = s.phases.find((p) => p.phase === 'dev')!;
    const req = s.phases.find((p) => p.phase === 'req')!;
    return dev.rowCount === 3 && req.rowCount === 1;
  })(), s.phases.map((p) => [p.phase, p.rowCount]));

  const phaseSum = s.phases.reduce((a, p) => a + p.expected, 0);
  eq('3-05 ΣE(各阶段) == directManDays.expected（R35 的 H 列求和区间）', phaseSum, s.directManDays.expected);
  eq('3-06 R35 H 列 == 理想人月 == 直接人天 ÷ 20.83', s.idealManMonths.expected, phaseSum / 20.83);
  eq('3-07 R40 H 列 == R35 × (1+Σ系数) = R35 × 1.23', s.actualManMonths.expected, s.idealManMonths.expected * 1.23);
  eq('3-08 Σ系数 = 0.23', s.coefSum, 0.23);
  ok('3-09 R35/R40 四列齐全（O/M/P/E 都要有值，导出缺一列客户改值不重算）',
    ['optimistic', 'likely', 'pessimistic', 'expected'].every((k) => Number.isFinite((s.idealManMonths as Record<string, number>)[k])
      && Number.isFinite((s.actualManMonths as Record<string, number>)[k])), s.idealManMonths);

  ok('3-10 四个系数行：三点同值 + E=系数本身 + 顺序对齐模板 R36~R39',
    s.coefRows.length === 4
    && s.coefRows.map((c) => c.key).join(',') === 'collaboration,quality,scope,schedule'
    && s.coefRows.every((c) => c.points.optimistic === c.points.likely && c.points.likely === c.points.pessimistic && Math.abs(c.expected - c.points.likely) < 1e-12),
    s.coefRows.map((c) => [c.key, c.expected]));
  const c0 = s.coefRows[0];
  eq('3-11 系数行比例 = H35×系数 ÷ H40（模板 I36~I39 原式）', c0.ratio, (s.idealManMonths.expected * 0.06) / s.actualManMonths.expected);
  eq('3-12 Σ系数行比例 = Σ系数 ÷ (1+Σ系数)', s.coefRows.reduce((a, c) => a + c.ratio, 0), 0.23 / 1.23);

  const sigmas = rows.filter((r) => s.countedKeys.includes(r.key)).reduce((a, r) => a + E.sigma(r.points!) ** 2, 0);
  eq('3-13 σ_total = √(Σσ_i²)（独立假设）', s.sigmaTotal, Math.sqrt(sigmas));
  ok('3-14 σ_total ≠ Σσ_i（多行时必须更小——相关性未计的口径提示依据）', (() => {
    const naive = s.phases.reduce((a, p) => a + p.sigma, 0);
    return naive > s.sigmaTotal + 1e-9;
  })());
  eq('3-15 报价 P84 = P50 + σ_total（§4.3 精确 84.13%）', s.quote.p84ManDays, s.quote.p50ManDays + s.sigmaTotal);
  eq('3-16 报价人月 P50 == 实际预估人月 R40（含 Σ系数；T02047 前旧口径误取理想人月，面板/PDF/交付件三处读数差 19%）',
    s.quote.p50ManMonth, s.actualManMonths.expected);
  eq('3-16b 报价人月 P84 = (直接投入人天 + σ_total) ÷ 人月标准 × (1+Σ系数)（人月含系数、人天不含，两列不同基）',
    s.quote.p84ManMonth, (s.directManDays.expected + s.sigmaTotal) / s.config.manDaysPerManMonth * (1 + s.coefSum));
  eq('3-16c 报价人月 P50 ≠ 理想人月（系数和不为 0 时必须不同——这条就是旧口径的反证）',
    s.quote.p50ManMonth - s.idealManMonths.expected, s.idealManMonths.expected * s.coefSum);
  eq('3-17 devSectionRatio == dev 阶段比例（模板 I8:I31 单格合并的整体比例）', E.devSectionRatio(s), s.phases.find((p) => p.phase === 'dev')!.ratio);
  ok('3-18 rowRatios 含未进 Σ 的行（展示用），但 countedKeys 不含',
    s.rowRatios.some((r) => r.key === 'subtotal-dev') && !s.countedKeys.includes('subtotal-dev'),
    { rows: s.rowRatios.length, counted: s.countedKeys.length });

  // §4.6「里程碑不重复计」的可断言形式：Σ(normal) 与「把里程碑行当明细」的 Σ 之差 = 里程碑行推导值之和
  const msPoints = P(40, 50, 70);
  const withMsExcluded = E.buildSummary([...rows, row('ms1', 'dev', msPoints, { planKind: 'milestone' })], cfg);
  const asNormal = E.buildSummary([...rows, row('ms1', 'dev', msPoints, { planKind: 'normal' })], cfg);
  const diff = asNormal.directManDays.expected - withMsExcluded.directManDays.expected;
  eq('3-19 Σ(normal) 与含 milestone 的 Σ 之差 = milestone 行推导值之和（§11-E3 明文断言，本单先行落进引擎）',
    diff, E.expected(msPoints));
  ok('3-20 里程碑行计入 excluded.milestone 且不进 countedKeys',
    withMsExcluded.ratioCheck.excluded.milestone === 1 && !withMsExcluded.countedKeys.includes('ms1'), withMsExcluded.ratioCheck.excluded);

  // T02123：`subtotal` / `milestone` 是**结构性排除**，判定必须先于 `!points`。
  // 旧顺序把「没有三点值的里程碑/小计行」计进 unEstimated——面板「未录入 N 行」据此把
  // mtask四期 10 条里程碑虚报成待录入（真机实测：修复后 unEstimated=0、milestone=10）。
  const structural = E.buildSummary([
    row('ms-nopoints', 'dev', null, { planKind: 'milestone' }),
    row('sub-nopoints', 'dev', null, { role: 'subtotal' }),
  ], cfg);
  ok('3-21 无点值的里程碑/小计行按结构性排除归类，不虚报为「未录入」（T02123 分类顺序回归）',
    structural.ratioCheck.excluded.milestone === 1 && structural.ratioCheck.excluded.subtotal === 1
    && structural.ratioCheck.excluded.unEstimated === 0 && structural.countedKeys.length === 0,
    structural.ratioCheck.excluded);
}

// =====================================================================
group('G4 比例自检 I40（§4.4 / §10-8 / §10-15）');
{
  const cfg = E.DEFAULT_ESTIMATE_CONFIG;
  const good = [
    row('m-req', 'req', P(12, 12, 16), { role: 'phase' }),
    row('m-design', 'design', P(20, 20, 24), { role: 'phase' }),
    row('d1', 'dev', P(6, 6, 7)),
    row('d2', 'dev', P(10, 12, 20)),
    row('subtotal-dev', 'dev', P(16, 18, 27), { role: 'subtotal' }),
    row('m-impl', 'impl', P(30, 30, 35), { role: 'phase' }),
    row('m-common', 'common', P(20, 20, 20), { role: 'phase' }),
    row('m-onsite', 'onsite', P(10, 10, 10), { role: 'phase' }),
  ];
  const s = E.buildSummary(good, cfg);
  eq('4-01 完备数据 Σ估算比例（I40）= 100.0000%', s.ratioCheck.sumRatio, 1, 1e-12);
  ok('4-02 偏差 0% 不告警、无未归阶段行', s.ratioCheck.danger === false && s.ratioCheck.unassigned.length === 0 && s.ratioCheck.deviationPct < 1e-9);
  const bad = E.buildSummary([...good, row('x1', '', P(50, 60, 80)), row('x2', 'unknown_phase', P(20, 20, 20))], cfg);
  ok('4-03 存在未归阶段行 → 比例和偏离 100% 并触发 danger（>1%）',
    bad.ratioCheck.sumRatio > s.ratioCheck.sumRatio && bad.ratioCheck.danger === true, bad.ratioCheck);
  ok('4-04 未归阶段行被点名到 key（面板据此定位，而不是只甩一个百分比）',
    bad.ratioCheck.unassigned.length === 2 && bad.ratioCheck.unassigned.some((u) => u.key === 'x1') && bad.ratioCheck.unassigned.some((u) => u.key === 'x2'),
    bad.ratioCheck.unassigned);
  ok('4-05 未归阶段行不进 Σ（directManDays 与完备数据同值）',
    Math.abs(bad.directManDays.expected - s.directManDays.expected) < 1e-12);
  const empty = E.buildSummary([], cfg);
  ok('4-06 空面板：全 0 且不出现 NaN（分母为 0 时比例取 0）',
    empty.actualManMonths.expected === 0 && empty.ratioCheck.sumRatio === 0 && Number.isFinite(empty.sigmaTotal)
    && empty.phases.every((p) => Number.isFinite(p.ratio)), empty.ratioCheck);
  // 附录 A 的黄金回归：三个 I 列实测值 + H40 量级
  const app = E.buildSummary([
    row('req', 'req', P(12, 12, 16), { role: 'phase' }),
    row('design', 'design', P(20, 20, 24), { role: 'phase' }),
    row('dev-sec', 'dev', P(150.4, 150.4, 150.4), { role: 'phase' }),
    row('impl', 'impl', P(30, 30, 35), { role: 'phase' }),
    row('common', 'common', P(20, 20, 20), { role: 'phase' }),
    row('onsite', 'onsite', P(10, 10, 10), { role: 'phase' }),
  ], cfg);
  const ratioOf = (ph: string) => app.phases.find((p) => p.phase === ph)!.ratio;
  const want: Array<[string, number, number]> = [['req', 0.0421, 2e-4], ['design', 0.0687, 2e-4], ['dev', 0.5001, 2e-4]];
  for (const [ph, w, tol] of want) {
    eq(`4-07 附录 A 实测比例 ${ph} = ${w}`, ratioOf(ph), w, tol);
  }
  eq('4-08 附录 A 反推的实际预估人月 H40 ≈ 14.44', app.actualManMonths.expected, 14.4415, 5e-3);
}

// =====================================================================
group('G5 模板 SUBTOTAL 语义仿真对照（§4.4 v1.1-B2 / §10-14）');
{
  const cfg = E.DEFAULT_ESTIMATE_CONFIG;
  /** Excel `SUBTOTAL(9, range)`：忽略范围内**其他 SUBTOTAL 的结果**；naive 模式不忽略（复现踩坑） */
  interface Cell { v: number; sub?: boolean }
  const subtotal9 = (cells: Cell[]) => cells.reduce((a, c) => (c.sub ? a : a + c.v), 0);
  const naiveSum = (cells: Cell[]) => cells.reduce((a, c) => a + c.v, 0);

  const devDetails = [P(6, 6, 7), P(10, 12, 20), P(2, 2, 2), P(4, 8, 24), P(3, 4, 5)];
  const phaseRows: Array<[string, ReturnType<typeof P>]> = [
    ['req', P(12, 12, 16)], ['design', P(20, 20, 24)],
    ['impl', P(30, 30, 35)], ['common', P(20, 20, 20)], ['onsite', P(10, 10, 10)],
  ];
  const engRows = [
    ...phaseRows.map(([ph, pts], i) => row(`ph-${ph}`, ph, pts, { role: 'phase' })),
    ...devDetails.map((pts, i) => row(`d${i}`, 'dev', pts)),
    // 模板 R31：E31..H31 = SUBTOTAL(9,X8:X30) —— 段内小计，落进 R35 的求和区间
    row('subtotal-dev', 'dev', (() => {
      const o = devDetails.reduce((a, x) => a + x.optimistic, 0);
      const m = devDetails.reduce((a, x) => a + x.likely, 0);
      const p = devDetails.reduce((a, x) => a + x.pessimistic, 0);
      return P(o, m, p);
    })(), { role: 'subtotal' }),
  ];
  const s = E.buildSummary(engRows, cfg);

  // 按模板行位 R6..R34 铺格（列序 E=最可能、F=最小、G=最大、H=最终估算值、I=估算比例）
  const grid: Record<'E' | 'F' | 'G' | 'H' | 'I', Cell[]> = { E: [], F: [], G: [], H: [], I: [] };
  const push = (key: string, pts: ReturnType<typeof P>, opts: { sub?: boolean; i?: number } = {}) => {
    grid.E.push({ v: pts.likely, sub: opts.sub });
    grid.F.push({ v: pts.optimistic, sub: opts.sub });
    grid.G.push({ v: pts.pessimistic, sub: opts.sub });
    grid.H.push({ v: E.expected(pts), sub: opts.sub });
    grid.I.push({ v: opts.i ?? 0, sub: opts.sub });
  };
  for (const [ph, pts] of phaseRows) if (ph !== 'dev') {
    const stat = s.phases.find((p) => p.phase === ph)!;
    push(ph, pts, { i: stat.ratio });
  }
  // 开发段 R8..R30 + R31 小计（I8:I31 合并：只有 I8 承载整体比例，其余为空 → 0）
  const devStat = s.phases.find((p) => p.phase === 'dev')!;
  devDetails.forEach((pts, i) => push(`d${i}`, pts, { i: i === 0 ? devStat.ratio : 0 }));
  const subO = devDetails.reduce((a, x) => a + x.optimistic, 0);
  const subM = devDetails.reduce((a, x) => a + x.likely, 0);
  const subP = devDetails.reduce((a, x) => a + x.pessimistic, 0);
  push('subtotal', P(subO, subM, subP), { sub: true });

  const denom = s.actualManMonths.expected;
  const std = cfg.manDaysPerManMonth;
  const sim = {
    E: subtotal9(grid.E) / std, F: subtotal9(grid.F) / std,
    G: subtotal9(grid.G) / std, H: subtotal9(grid.H) / std,
    I35: subtotal9(grid.I),
  };
  eq('5-01 引擎理想人月 H35 == 模板 SUBTOTAL(9,H6:H34)/每人月工天标准（§10-14 差 <0.01 人月，实测 <1e-9）',
    s.idealManMonths.expected, sim.H, 1e-9);
  eq('5-02 引擎 F35（乐观列）== 模板 SUBTOTAL(9,F6:F34)/标准', s.idealManMonths.optimistic, sim.F, 1e-9);
  eq('5-03 引擎 E35（最可能列）== 模板 SUBTOTAL(9,E6:E34)/标准', s.idealManMonths.likely, sim.E, 1e-9);
  eq('5-04 引擎 G35（悲观列）== 模板 SUBTOTAL(9,G6:G34)/标准', s.idealManMonths.pessimistic, sim.G, 1e-9);
  eq('5-05 引擎 Σ估算比例 == 模板 I40 = SUBTOTAL(9,I35:I39)', s.ratioCheck.sumRatio,
    sim.I35 + s.coefRows.reduce((a, c) => a + c.ratio, 0), 1e-9);
  // 反面对照：朴素 sum 把 R31 小计也算进去 → 开发段被算两遍
  const subHValue = E.expected(P(subO, subM, subP));
  const naiveH = naiveSum(grid.H) / std;
  eq('5-06 朴素 sum 与引擎之差 == 开发段小计值 ÷ 标准（证明「算两遍」是真实存在的坑，排除口径起作用）',
    naiveH - s.idealManMonths.expected, subHValue / std, 1e-12);
  ok('5-07 小计行的 H 恰等于其明细之和（SUBTOTAL(9,X8:X30) 的语义前提）',
    Math.abs(subHValue - devDetails.reduce((a, x) => a + E.expected(x), 0)) < 1e-12, { subHValue });
  ok('5-07b 朴素 sum 结果 > 引擎值 × 1.2（人月口径下真会翻盘的量级，不是四舍五入级差异）',
    naiveH > s.idealManMonths.expected * 1.2, { naiveH, engine: s.idealManMonths.expected });
  ok('5-08 系数行比例分母取 H40（=H35×1.23）而非 H35，否则 I40 恒 >100%',
    s.coefRows.every((c) => Math.abs(c.ratio - (s.idealManMonths.expected * c.expected) / denom) < 1e-12));
}

// =====================================================================
group('G6 与 E1 数据层的接缝（隔离库 → EstimateService 视图行 → 引擎）');
{
  const { initSchema } = await import('../server/src/db/schema.ts');
  const { getDb, closeDb } = await import('../server/src/db/connection.ts');
  const { EstimateService: S } = await import('../server/src/services/EstimateService.ts');
  initSchema();
  const db = getDb();
  const T = '2026-10-11T00:00:00.000Z';
  const PID = 'p-e2';
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(PID, 'E2 接缝测试', '', T, T);
  const insPlan = db.prepare(
    `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
       progress, status, assignee, sort_order, created_at, updated_at, kind, complexity)
     VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?)`,
  );
  const plan = (id: string, title: string, start: string, dur: number, sort: number, kind = 'normal', complexity: number | null = null) =>
    insPlan.run(id, PID, title, start, start, dur, sort, T, T, kind, complexity);
  plan('pl-a', '正常计划A', '2026-10-09', 5, 1, 'normal', 3);
  plan('pl-b', '正常计划B', '2026-10-09', 10, 2, 'normal', 4);
  plan('pl-ms', '里程碑（包络行）', '2026-10-09', 15, 3, 'milestone', 5);
  plan('pl-arch', '已归档计划', '2026-10-09', 3, 4, 'normal', 2);
  db.prepare("UPDATE plan_tasks SET archived = 1, archived_at = ? WHERE id = 'pl-arch'").run(T);
  S.upsert(PID, 'pl-a', { phase: 'dev', optimistic: 4, likely: 4, pessimistic: 6 });
  S.upsert(PID, 'pl-b', { phase: 'design', optimistic: 10, likely: 12, pessimistic: 20 });
  S.upsert(PID, 'pl-ms', { phase: 'dev', optimistic: 30, likely: 40, pessimistic: 60 });
  S.upsert(PID, 'pl-arch', { phase: 'impl', optimistic: 5, likely: 5, pessimistic: 5 });

  const views = S.listByProject(PID) as Array<Record<string, unknown>>;
  ok('6-01 默认视图按归档态过滤（3 行：pl-a/pl-b/pl-ms，归档计划不在内）',
    views.length === 3, views.map((v) => v.plan_id));
  const s = E.buildSummary(views.map((v) => E.toEngineRow(v as never)), E.DEFAULT_ESTIMATE_CONFIG);
  const wantDev = E.expected(P(4, 4, 6));
  const wantDesign = E.expected(P(10, 12, 20));
  eq('6-02 引擎吃 E1 视图行的开发段 Σ == 手算 (4+16+6)/6', s.phases.find((p) => p.phase === 'dev')!.expected, wantDev);
  eq('6-03 系统设计段 Σ == 手算 (10+48+20)/6', s.phases.find((p) => p.phase === 'design')!.expected, wantDesign);
  ok('6-04 里程碑估算行被 planKind 过滤（不进 Σ，但面板可见）',
    s.ratioCheck.excluded.milestone === 1 && s.rowRatios.some((r) => r.key === 'pl-ms'), s.ratioCheck.excluded);
  const withArch = E.buildSummary(
    (S.listByProject(PID, { includeArchived: true }) as Array<Record<string, unknown>>).map((v) => E.toEngineRow(v as never)),
    E.DEFAULT_ESTIMATE_CONFIG);
  eq('6-05 includeArchived 时归档行进入 Σ（差值恰为该行的 E 值，证明过滤发生在服务层而非引擎）',
    withArch.directManDays.expected - s.directManDays.expected, E.expected(P(5, 5, 5)));
  ok('6-06 接缝数据比例自检仍为 100%（未归阶段行=0）',
    Math.abs(s.ratioCheck.sumRatio - 1) < 1e-12 && s.ratioCheck.unassigned.length === 0, s.ratioCheck);
  ok('6-07 视图行的 phase 全部落在引擎可识别阶段（两侧枚举不会漂移：同一个 ESTIMATE_PHASES 数组）',
    views.every((v) => E.buildSummary([E.toEngineRow(v as never)]).phases.length === 6));
  closeDb();
}

// =====================================================================
group('G7 单源词干改名模拟（T02293 判据 4·同进程引擎层）');
{
  // 把 `ESTIMATE_ERRORS` 的词干逐支改成 `ZZZ-<key>` 再触发同一拒绝，要求「照样拒绝、文案随单源移动、
  // 旧词干零残留、还原逐字符相同」。任一不成立即说明某层留了第二份抄本——那正是判据 1 要消灭的东西。
  // 引擎这两个校验（resolveEstimateConfig / parseRuleRatio）是纯函数，不写库，故零副作用天然成立。
  const ERR_TABLE = ESTIMATE_ERRORS as unknown as Record<string, string>;
  const cases: Array<{ key: string; title: string; run: () => string }> = [
    { key: 'notNumber', title: '参数非数字', run: () => errOf(() => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': 'abc' })) },
    { key: 'paramMin', title: '参数下限', run: () => errOf(() => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': '0' })) },
    { key: 'paramMax', title: '参数上限', run: () => errOf(() => E.resolveEstimateConfig({ 'estimate.coef.quality': '1.5' })) },
    { key: 'paramLabel', title: '参数名前缀', run: () => errOf(() => E.resolveEstimateConfig({ 'estimate.coef.scope': '-0.1' })) },
    { key: 'ratioMidPert', title: '推导比例中段', run: () => errOf(() => E.parseRuleRatio('1:5:1.6')) },
    { key: 'ratioFormat', title: '推导比例格式', run: () => errOf(() => E.parseRuleRatio('1:4')) },
  ];
  const zj: string[] = [];
  for (const c of cases) {
    const stem = ERR_TABLE[c.key];
    const before = c.run();
    if (!before.includes(stem)) { zj.push(`${c.title}：原始件文案没命中单源词干「${stem}」（实际「${before.slice(0, 60)}」）`); continue; }
    const renamed = `ZZZ-${c.key}`;
    ERR_TABLE[c.key] = renamed;
    let after = '';
    try { after = c.run(); } finally { ERR_TABLE[c.key] = stem; }
    if (after === '') zj.push(`${c.title}：改名后引擎不再拒绝——校验失守（文案不是唯一挡点）`);
    else if (!after.includes(renamed)) zj.push(`${c.title}：改名后文案未随单源表移动（该层留了写死抄本）`);
    if (after.includes(stem)) zj.push(`${c.title}：改名后文案仍含旧词干「${stem}」= 第二份抄本`);
    if (c.run() !== before) zj.push(`${c.title}：还原后文案与原始件不逐字符相同（改表污染）`);
  }
  ok('G7-01 词干改名模拟全项通过（拒绝在、文案随单源移动、旧词干零残留、还原逐字符相同、纯函数零副作用）',
    zj.length === 0, zj);
  ok('G7-02 改名模拟覆盖引擎层单源词干 ≥6 支',
    cases.length >= 6, { 支数: cases.length, 去重词干: new Set(cases.map((c) => c.key)).size });
}

// =====================================================================
group('G8 跨进程同源自证（另起进程重算引擎文案，逐字符比对）');
{
  // 本门无 REST 服务端，判据 4 的「服务端原文 vs 门进程」适配为「子进程重算 vs 门进程」：
  // 子进程独立 import 同一份 on-disk 引擎，打同样五枚非法入参，把抛出的文案逐字符回传。
  // 门把自己的 `errOf` 结果与之比对——只要两侧读同一张 `estimateCopy`，改措辞门不假红；
  // 若门抄了整句当字面量，跨进程重算就对不上。假词干零命中保证比对不是恒真式。
  const snippet = join(DATA_DIR, 't02036-xproc.mts');
  const engineUrl = pathToFileURL(resolve(ROOT, 'server', 'src', 'services', 'estimate-engine.ts')).href;
  writeFileSync(snippet, [
    `const E = await import(${JSON.stringify(engineUrl)});`,
    `const fire = (fn) => { try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); } };`,
    `const calls = [`,
    `  () => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': 'abc' }),`,
    `  () => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': '0' }),`,
    `  () => E.resolveEstimateConfig({ 'estimate.coef.quality': '1.5' }),`,
    `  () => E.parseRuleRatio('1:5:1.6'),`,
    `  () => E.parseRuleRatio('1:4'),`,
    `];`,
    `console.log('XPROC_JSON::' + JSON.stringify(calls.map(fire)));`,
  ].join('\n'));
  const LAUNCHER = resolveServerLauncher(ROOT, snippet);
  const mine = [
    () => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': 'abc' }),
    () => E.resolveEstimateConfig({ 'estimate.manDaysPerManMonth': '0' }),
    () => E.resolveEstimateConfig({ 'estimate.coef.quality': '1.5' }),
    () => E.parseRuleRatio('1:5:1.6'),
    () => E.parseRuleRatio('1:4'),
  ].map(errOf);
  let child: string[] = [];
  let raw = '';
  let xprocErr = '';
  try {
    raw = execFileSync(LAUNCHER.exec, LAUNCHER.tsx, {
      cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_DATA_DIR: DATA_DIR },
      encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = raw.split('\n').find((l) => l.startsWith('XPROC_JSON::'));
    child = line ? (JSON.parse(line.slice('XPROC_JSON::'.length)) as string[]) : [];
  } catch (e) { xprocErr = String((e as Error)?.message).slice(0, 240); }
  const stems = Object.values(ESTIMATE_ERRORS);
  ok('G8-01 子进程与门进程各 5 条拒绝文案逐字符相同（跨进程同源）',
    xprocErr === '' && child.length === 5 && child.every((m, i) => m === mine[i]),
    { 启动器: LAUNCHER.label, xprocErr, childMsgs: child.map((m) => m.slice(0, 50)), 门进程: mine.map((m) => m.slice(0, 50)) });
  ok('G8-02 每条子进程拒绝文案都命中单源词干（门断言的是词干，不是整句抄本）',
    child.length === 5 && child.every((m) => stems.some((s) => m.includes(s))),
    child.map((m) => m.slice(0, 50)));
  const fake = 'ZZZ-本门不存在的词干';
  ok('G8-03 假词干对子进程全部文案零命中（G8-01/G8-02 的比对不是恒真式）',
    child.length > 0 && child.every((m) => !m.includes(fake)) && !raw.includes(fake), { 命中: raw.includes(fake) });
}

// =====================================================================
group('G9 配对器三态反证（负控·判据 3~4）');
{
  // 用 spy 版 ok 捕获配对器落账结果（不动全局计数），证明 okPair 真能分辨「行为失守」与「字面锚点失配」：
  // 造一份「文案含真词干、但行为缺失」的夹具，配对器必须判红且红因=行为失守，而不是被文案带绿。
  const seen: Array<{ cond: boolean; 红因?: string }> = [];
  const spy = (_name: string, cond: boolean, extra?: unknown) => {
    seen.push({ cond, 红因: (extra as Record<string, unknown> | undefined)?.红因 as string | undefined });
  };
  okPair(spy, 'NC-01（预期被配对器判红：行为失守）',
    () => false, () => `估算参数xx${ESTIMATE_ERRORS.notNumber}`.includes(ESTIMATE_ERRORS.notNumber));
  okPair(spy, 'NC-02（预期被配对器判红：锚点失配）',
    () => true, () => '必须是数字'.includes('完全不存在的旧词'));
  okPair(spy, 'NC-03（预期绿：双绿基准）',
    () => true, () => ESTIMATE_ERRORS.notNumber.includes(ESTIMATE_ERRORS.notNumber));
  ok('G9-01 负控：含真词干但行为缺失 → 配对器判红且红因=行为失守（非锚点失配）',
    seen[0]?.cond === false && /行为失守/.test(seen[0]?.红因 ?? ''), seen[0]);
  ok('G9-02 负控：行为在但锚抄错词 → 红因=字面锚点失配（行为在）',
    seen[1]?.cond === false && /字面锚点失配/.test(seen[1]?.红因 ?? ''), seen[1]);
  ok('G9-03 双绿基准：行为与锚同时成立才判绿',
    seen[2]?.cond === true, seen[2]);
}

// =====================================================================
console.log(`\n合计 PASS=${pass} FAIL=${fail}`);
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {
  console.log(`  [WARN] 临时目录回收失败（不影响断言结论）：${String((e as Error)?.message).slice(0, 120)}`);
}
process.exit(fail === 0 ? 0 : 1);
