/**
 * E3（T02037 · PRD-估算视图 §4.6/§7/§8）验证脚本：三档推导规则 + `/api/estimates*` REST 全链。
 *
 * 用法（Node 版本必须与 node_modules/better-sqlite3 的预编译 ABI 对齐，本机 Node22 ABI127 可加载）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02037-estimate-e3.mts
 *
 * 四段结构：
 *   S 段（同进程·只读）：`EstimateDerive` 三档规则逐档取值、0.5 网格、里程碑/人工行保护、覆盖面、
 *     「Σ 含里程碑 − Σ 仅 normal = 里程碑推导值」恒等式（§4.6 v1.4 判据）。**不落库**，
 *     把写路径完整留给 R 段的 REST，避免「服务层先写一遍、REST 再断言一遍」的同义反复。
 *   G 段（同进程·判据 3~4）：**改名模拟**——把 `ESTIMATE_ERRORS` / `ESTIMATE_POINT_LABELS` 的词干
 *     逐支改成 `ZZZ-<key>` 再触发同一校验，要求「照样拒绝、文案随单源表移动、旧词干零残留、还原逐字符
 *     相同、零副作用」；任一失守即说明某层留了第二份抄本。另含里程碑分类口径（T02123 / 3e4b613）的
 *     **新旧顺序反证**：R-09/R-20 的数字变化钉的是「结构性排除先于未估算」这条规则，不是数字本身。
 *   R 段（隔离实例·REST）：起一个 `MTask_PORT` + `MTask_DATA_DIR` 的临时服务进程，按 §8 端点清单
 *     逐条打真请求——路由挂载、静态路径优先于 `:planId`、`wrap` 的 400 中文文案、批量零写入、
 *     PATCH 人工转 manual、参数读写校验、快照 compare、脱离行清理、归档行不进 Σ。
 *     所有文案断言走 `rejected400`（行为侧=400+非空文案+拒绝即零写入，字面侧=单源词干）。
 *   H 段（跨进程·判据 4）：R 段登记的服务端原文与门进程词干表做同一性比对（逐条命中 + 假词干零命中
 *     + 同入参文案逐字符相同），自证「改措辞门不假红」靠的是同源，不是抄本。
 *
 * 隔离纪律（skill 红线 8）：库与端口都是临时的，不碰生产数据目录，跑完 kill + 回收临时目录。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：文案锚必须配行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02037-e3-'));
const PORT = Number(process.env.T02037_PORT ?? 39927);
process.env.MTask_DATA_DIR = DATA_DIR;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const D = await import('../server/src/services/EstimateDerive.ts');
const { buildSummary, resolveEstimateConfig, parseRuleRatio, expected, DEFAULT_ESTIMATE_CONFIG } = await import('../server/src/services/estimate-engine.ts');
const { pointsError, ESTIMATE_ERRORS, ESTIMATE_POINT_LABELS, ESTIMATE_META, EstimateService } = await import('../server/src/services/EstimateService.ts');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 260)}` : ''}`);
  }
};
const near = (a: number, b: number, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;
/**
 * 400 类断言的配对器（T02293 判据 3）。
 * 行为侧 = 请求真的被拒（400 + 非空错误文案，可再叠「库里没多出东西」这类副作用检查）；
 * 字面侧 = 文案含产品**单源词干**（`ESTIMATE_ERRORS`，见 `server/src/services/estimateCopy.ts`）。
 * 服务端进程与门进程读同一份常量表，所以改措辞时两侧一起动、门不假红；
 * 这个「跨进程同源」本身由 H-01 专门自证，不靠注释宣称。
 * 每条 400 文案同时登记进 `rest400`，供 H 段拿服务端原文与门进程词干做同一性比对。
 */
const rest400: Array<{ label: string; error: string }> = [];
const rejected400 = (
  label: string,
  res: { status: number; json?: Record<string, any> },
  stem: string,
  extraBehavior?: () => boolean,
) => {
  if (res.status === 400) rest400.push({ label, error: String(res.json?.error ?? '') });
  return okPair(ok, label,
    () => res.status === 400 && String(res.json?.error ?? '').length > 0 && (extraBehavior ? extraBehavior() : true),
    () => String(res.json?.error ?? '').includes(stem),
    () => ({ status: res.status, error: String(res.json?.error ?? '').slice(0, 140) }));
};
/** S 段（同进程抛错）的配对器：行为侧 = 确实抛了错（可叠「合法入参仍通过」），字面侧 = 命中单源词干 */
const rejectedMsg = (
  label: string,
  msg: string,
  stem: string,
  extraBehavior?: () => boolean,
) => okPair(ok, label,
  () => msg.length > 0 && (extraBehavior ? extraBehavior() : true),
  () => msg.includes(stem),
  () => ({ 文案: msg.slice(0, 140) }));
/** 把「应当抛错的调用」收成文案（不抛则空串，交给配对器的行为侧判红） */
const fire = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
const T = '2026-10-11T00:00:00.000Z';
const PID = 'p-e3';
const PID_B = 'p-e3b';

// ---------------- 夹具：直接写测试库（隔离临时库，不经 REST，也不碰生产） ----------------
initSchema();
const db = getDb();
const insProj = db.prepare(
  'INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
);
insProj.run(PID, 'T02037-估算E3', '', T, T);
insProj.run(PID_B, 'T02037-E3-第二项目', '', T, T);

const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?)`,
);
type PlanSeed = [id: string, title: string, dur: number, sort: number, kind?: string, complexity?: number | null];
const plans: PlanSeed[] = [
  ['pl-c3', '需求分析-复杂度3', 5, 1, 'normal', 3],
  ['pl-c1', '系统设计-复杂度1', 2, 2, 'normal', 1],
  ['pl-case', '开发甲-用例加权', 4, 3, 'normal', null],
  ['pl-dur', '实施部署-仅工期', 7, 4, 'normal', null],
  ['pl-ms', 'M1 阶段包络', 20, 5, 'milestone', 4],
  ['pl-man', '开发乙-已人工录入', 3, 6, 'normal', 2],
  ['pl-rule', '开发丙-已有规则值', 6, 7, 'normal', 3],
  ['pl-arch', '开发丁-已归档', 4, 8, 'normal', 5],
];
for (const [id, title, dur, sort, kind, cx] of plans) {
  insPlan.run(id, PID, title, '2026-10-12', '2026-10-12', dur, sort, T, T, kind ?? 'normal', cx ?? null);
}
db.prepare('UPDATE plan_tasks SET archived = 1, archived_at = ? WHERE id = ?').run(T, 'pl-arch');
db.prepare("UPDATE plan_tasks SET req_ids = ? WHERE id = 'pl-case'").run(JSON.stringify(['rq-1']));

const insReq = db.prepare(
  `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, '', '', 'normal', 'todo', 0, ?, ?)`,
);
insReq.run('rq-1', PID, 'REQ-001', '用例加权来源需求', T, T);
const insCase = db.prepare(
  `INSERT INTO test_cases (id, project_id, req_id, case_no, title, priority, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
// Σ权重 = P0 3 + P1 2 + P2 1 + P3 0.5 = 6.5；'PPX' 是未知档，权重记 0 并进 unknown 计数
[['tc-1', 'P0'], ['tc-2', 'P1'], ['tc-3', 'P2'], ['tc-4', 'P3'], ['tc-5', 'PPX']].forEach(([id, pri], i) => {
  insCase.run(id, PID, 'rq-1', `C-${i + 1}`, `用例${i + 1}`, pri as string, T, T);
});

const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, '', ?, ?)`,
);
insEst.run('es-man', PID, 'pl-man', 'dev', 3, 4, 8, 'manual', T, T);
insEst.run('es-rule', PID, 'pl-rule', 'dev', 2, 2, 2, 'rule', T, T);
insEst.run('es-gone', PID, 'pl-gone', 'common', 1, 2, 3, 'default', T, T);

const insSnap = db.prepare(
  'INSERT INTO estimate_snapshots (id, project_id, format, filename, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const payloadOf = (devE: number, dm: number, am: number) => JSON.stringify({
  phases: [{ phase: 'dev', expected: devE, idealManMonth: devE / 20.83, manMonth: devE / 20.83 }],
  directManDays: { optimistic: dm - 1, likely: dm, pessimistic: dm + 1, expected: dm },
  actualManMonths: { optimistic: am - 0.1, likely: am, pessimistic: am + 0.1, expected: am },
});
insSnap.run('sn-a', PID, 'xlsx', 'a.xlsx', payloadOf(10, 20, 2), '2026-10-01T00:00:00.000Z');
insSnap.run('sn-b', PID, 'xlsx', 'b.xlsx', payloadOf(12, 24, 2.4), '2026-10-05T00:00:00.000Z');

console.log('\n=== S 段：三档推导规则（同进程·只读） ===');
const CFG = DEFAULT_ESTIMATE_CONFIG;
const derive = () => D.deriveEstimates(PID, { config: resolveEstimateConfig({}) });

// S1 阶段关键字
ok('S-01 阶段关键字映射（需求/设计/开发/实施/维护/测试）',
  D.inferPhase('需求分析') === 'req' && D.inferPhase('系统架构设计') === 'design' && D.inferPhase('开发联调') === 'dev'
  && D.inferPhase('上线部署') === 'impl' && D.inferPhase('现场维护') === 'onsite' && D.inferPhase('测试与文档') === 'common');
ok('S-02 未命中关键字回落 dev（与 EstimateService 缺省同口径）', D.inferPhase('M1 阶段包络') === 'dev');

// S3 三档规则逐档取值（0.5 网格，§4.1 输入精度）
{
  const r = derive();
  const by = new Map(r.items.map((i) => [i.planId, i]));
  const c3 = by.get('pl-c3');
  ok('S-03 规则1 复杂度3：M=基准3.5、O=M×1、P=grid(3.5×1.6)=5.5',
    c3?.rule === 'complexity' && c3?.optimistic === 3.5 && c3?.likely === 3.5 && c3?.pessimistic === 5.5, c3);
  ok('S-04 规则1 E 由引擎单源算出（(3.5+4*3.5+5.5)/6）', c3 !== undefined && near(c3.expected, expected({ optimistic: 3.5, likely: 3.5, pessimistic: 5.5 })));
  const c1 = by.get('pl-c1');
  ok('S-05 规则1 复杂度1：M=1、P=grid(1.6)=1.5（不是 1.6——面板与导出同一个数）',
    c1?.likely === 1 && c1?.optimistic === 1 && c1?.pessimistic === 1.5 && c1?.phase === 'design', c1);
  const cs = by.get('pl-case');
  ok('S-06 规则2 用例加权：Σ权重6.5×k0.5=3.25 → M=grid(3.25)=3.5、P=grid(5.2)=5.0',
    cs?.rule === 'caseWeight' && cs?.optimistic === 3.5 && cs?.likely === 3.5 && cs?.pessimistic === 5, cs);
  ok('S-07 规则2 依据回传（5 条用例、1 条未知档、k 与 Σ权重可见）',
    cs?.basis.caseCount === 5 && cs?.basis.caseWeight === 6.5 && cs?.basis.caseWeightUnknown === 1 && cs?.basis.k === 0.5, cs?.basis);
  const du = by.get('pl-dur');
  ok('S-08 规则3 工期回退：M=duration7、O=grid(5.6)=5.5、P=grid(9.8)=10',
    du?.rule === 'duration' && du?.optimistic === 5.5 && du?.likely === 7 && du?.pessimistic === 10, du);
  ok('S-09 规则3 note 用 PRD 原文案（面板提示语不各写一套）', du?.note === D.DURATION_NOTE, du?.note);
  ok('S-10 规则优先级：复杂度非空即命中规则1（用例档不再参与）',
    by.get('pl-c3')?.rule === 'complexity' && (by.get('pl-c3')?.basis.caseCount ?? -1) === 0);
  ok('S-11 三点全程 O≤M≤P（落库前不违反 pointsError）',
    r.items.every((i) => i.optimistic <= i.likely && i.likely <= i.pessimistic), r.items.map((i) => [i.planId, i.optimistic, i.likely, i.pessimistic]));

  // S12~S16 跳过口径
  ok('S-12 里程碑行只出参考值、不落库（writable=false + skip=milestone）',
    by.get('pl-ms')?.skip === 'milestone' && by.get('pl-ms')?.writable === false);
  ok('S-13 人工行默认不被规则覆盖（skip=manual）', by.get('pl-man')?.skip === 'manual' && by.get('pl-man')?.existing === 'manual');
  ok('S-14 已有规则行在 scope=missing 下跳过（skip=exists）', by.get('pl-rule')?.skip === 'exists');
  ok('S-15 可写集合 = 4 条未估算明细（不含里程碑/人工/已有规则/归档）',
    r.writableCount === 4 && r.items.filter((i) => i.writable).map((i) => i.planId).sort().join(',') === 'pl-c1,pl-c3,pl-case,pl-dur',
    r.items.filter((i) => i.writable).map((i) => i.planId));
  ok('S-16 归档计划不进推导集合（pl-arch 不在 items 中）', !by.has('pl-arch') && !by.has('pl-gone'));

  // S17~S19 scope / includeManual
  const all = D.deriveEstimates(PID, { config: CFG, scope: 'all' });
  const allBy = new Map(all.items.map((i) => [i.planId, i]));
  ok('S-17 scope=all：已有规则行可重推，人工行仍受保护',
    allBy.get('pl-rule')?.writable === true && allBy.get('pl-man')?.skip === 'manual' && allBy.get('pl-ms')?.skip === 'milestone');
  const allM = D.deriveEstimates(PID, { config: CFG, scope: 'all', includeManual: true });
  ok('S-18 scope=all+includeManual：人工行也进可写集（显式才动）',
    allM.items.filter((i) => i.writable).length === 6 && allM.items.find((i) => i.planId === 'pl-man')?.writable === true,
    allM.items.filter((i) => i.writable).map((i) => i.planId));
  const one = D.deriveEstimates(PID, { config: CFG, planIds: ['pl-c3', 'pl-ms'] });
  ok('S-19 planIds 白名单生效（只返回指定行，顺序不变）',
    one.items.map((i) => i.planId).join(',') === 'pl-c3,pl-ms' && one.writableCount === 1, one.items.map((i) => i.planId));

  // S20 k 与比例配置真的进推导
  const k2 = D.deriveEstimates(PID, { config: CFG, caseWeightK: 2 });
  const k2cs = k2.items.find((i) => i.planId === 'pl-case');
  ok('S-20 覆盖 k=2 → M=grid(6.5×2)=13、P=grid(13×1.6)=20.8→21',
    k2cs?.likely === 13 && k2cs?.pessimistic === 21 && k2.caseWeightKFrom === 'override', k2cs);
  const r12 = D.deriveEstimates(PID, { config: { ...CFG, ruleRatio: { oMul: 1, pMul: 1.2 } } });
  const r12c3 = r12.items.find((i) => i.planId === 'pl-c3');
  ok('S-21 比例配置 pMul=1.2 → P=grid(4.2)=4.0（参数页与 derive 同一把尺子）',
    r12c3?.pessimistic === 4, r12c3);
  let kErr = '';
  try { D.deriveEstimates(PID, { config: CFG, caseWeightK: 0 }); } catch (e) { kErr = (e as Error).message; }
  okPair(ok, 'S-22 k=0 直接报错而不是静默回落',
    () => kErr !== '' && D.resolveCaseWeightK(PID, 1).k === 1,
    () => kErr.includes(ESTIMATE_ERRORS.mustBePositive), () => ({ 文案: kErr }));

  // S23 clamp
  const huge = D.deriveEstimates(PID, { config: CFG, caseWeightK: 100 });
  ok('S-23 规则2 M 按 §4.6 clamp 到 20（k 再大也不失控）',
    (huge.items.find((i) => i.planId === 'pl-case')?.likely ?? 0) === 20, huge.items.find((i) => i.planId === 'pl-case'));

  // S24 覆盖面
  const cov = D.coverage(PID);
  ok('S-24 覆盖面：normal6 / milestone1 / estimated2 / missing4 / detached1',
    cov.normal === 6 && cov.milestone === 1 && cov.estimated === 2 && cov.missing === 4 && cov.detached === 1, cov);
  ok('S-25 来源分布含 manual/rule/default 三类（复核率出数口）',
    cov.bySource.manual === 1 && cov.bySource.rule === 1 && cov.bySource.default === 1, cov.bySource);

  // S26 里程碑不重复计恒等式（§4.6 v1.4 判据）：拿「逐行推导后朴素全表求和」与引擎求和对比，
  // 差值必须正好等于里程碑那一行的推导值——这就是「阶段工作量被算两遍」的可执行反证。
  const toEngine = (list: typeof r.items) => list.map((i) => ({
    key: i.planId, phase: i.phase, role: 'detail' as const, planKind: i.kind,
    points: { optimistic: i.optimistic, likely: i.likely, pessimistic: i.pessimistic },
  }));
  const naiveAll = r.items.reduce((a, i) => a + i.expected, 0);
  const engineAll = buildSummary(toEngine(r.items), CFG).directManDays.expected;
  const msE = by.get('pl-ms')?.expected ?? 0;
  const normalEngine = buildSummary(toEngine(r.items.filter((i) => i.kind !== 'milestone')), CFG).directManDays.expected;
  ok('S-26 Σ(含里程碑推导行) − Σ(仅 normal) = 里程碑推导值（复杂4→E5.5，算两遍被抓住）',
    near(naiveAll - normalEngine, msE, 1e-9) && near(msE, 5.5, 1e-9), { naiveAll, normalEngine, msE });
  ok('S-27 引擎自己就把里程碑挡在 Σ 外：喂全表 = 喂 normal',
    near(engineAll, normalEngine, 1e-9)
    && buildSummary(toEngine(r.items), CFG).countedKeys.indexOf('pl-ms') === -1, { engineAll, normalEngine });
}

// S28 第二项目互不串味
{
  const r = D.deriveEstimates(PID_B, { config: CFG });
  ok('S-28 空项目：derive 返回空集合而非报错，coverage 全 0',
    r.items.length === 0 && r.writableCount === 0 && D.coverage(PID_B).normal === 0);
  let err = '';
  try { D.deriveEstimates('no-such-project', { config: CFG }); } catch (e) { err = (e as Error).message; }
  rejectedMsg('S-29 不存在的项目报错', err, ESTIMATE_ERRORS.projectNotFound,
    // 行为侧再钉一枚「合法项目照样出数」——只有报错文案变了不算失守，能报错又不误伤合法入参才是原口径
    () => D.deriveEstimates(PID, { config: CFG }).items.length === 7);
}

console.log('\n=== G 段：单源词干改名模拟 + 口径破行为反证（T02293 判据 3~4·同进程） ===');
{
  /**
   * 改名模拟（判据 4）：REST 层在另一个进程里，门改不动它的常量——所以这一支走**同进程的产品纯路径**
   * （引擎 / 服务层 / derive 三层都能直达），把 `ESTIMATE_ERRORS` 的词干改成 `ZZZ-<key>` 后重新触发同一校验，
   * 要求「照样拒绝、文案随单源移动、旧词干零残留、还原后逐字符相同」。
   * 任一条不成立即说明该文案在某层留了第二份抄本——那正是判据 1 要消灭的东西。
   */
  const ERR_TABLE = ESTIMATE_ERRORS as unknown as Record<string, string>;
  const LABEL_TABLE = ESTIMATE_POINT_LABELS as unknown as Record<string, string>;
  const estIds = () => (db.prepare('SELECT id FROM estimate_items').all() as Array<{ id: string }>)
    .map((r) => r.id).sort().join(',');
  const baselineIds = estIds();
  const cases: Array<{ table: Record<string, string>; key: string; title: string; run: () => string }> = [
    { table: ERR_TABLE, key: 'ordering', title: '三点顺序 O>M', run: () => pointsError(9, 5, 6) ?? '' },
    { table: ERR_TABLE, key: 'ordering', title: '三点顺序 M>P', run: () => pointsError(1, 5, 2) ?? '' },
    { table: ERR_TABLE, key: 'notNumber', title: '三点非数字', run: () => pointsError(Number.NaN, 1, 1) ?? '' },
    { table: ERR_TABLE, key: 'negative', title: '三点为负', run: () => pointsError(-1, 1, 1) ?? '' },
    { table: LABEL_TABLE, key: 'optimistic', title: '点值标签（乐观）', run: () => pointsError(9, 5, 6) ?? '' },
    { table: LABEL_TABLE, key: 'likely', title: '点值标签（最可能）', run: () => pointsError(1, 5, 2) ?? '' },
    { table: ERR_TABLE, key: 'ratioFormat', title: '推导比例格式', run: () => fire(() => parseRuleRatio('1:4')) },
    { table: ERR_TABLE, key: 'ratioMidPert', title: '推导比例中段', run: () => fire(() => parseRuleRatio('1:5:1.6')) },
    { table: ERR_TABLE, key: 'paramMin', title: '参数下限', run: () => fire(() => resolveEstimateConfig({ 'estimate.coef.scope': '-0.1' })) },
    { table: ERR_TABLE, key: 'paramMax', title: '参数上限', run: () => fire(() => resolveEstimateConfig({ 'estimate.coef.scope': '1.5' })) },
    { table: ERR_TABLE, key: 'notNumber', title: '参数非数字', run: () => fire(() => resolveEstimateConfig({ 'estimate.manDaysPerManMonth': 'abc' })) },
    { table: ERR_TABLE, key: 'caseWeightK', title: '用例权重 k 标签', run: () => fire(() => D.resolveCaseWeightK(PID, 0)) },
    { table: ERR_TABLE, key: 'mustBePositive', title: '用例权重 k 正值', run: () => fire(() => D.resolveCaseWeightK(PID, -1)) },
    { table: ERR_TABLE, key: 'projectIdRequired', title: 'projectId 缺失', run: () => fire(() => EstimateService.listByProject('')) },
    { table: ERR_TABLE, key: 'projectNotFound', title: '项目不存在', run: () => fire(() => EstimateService.listByProject('no-such-project')) },
    { table: ERR_TABLE, key: 'planIdRequired', title: 'planId 缺失', run: () => fire(() => EstimateService.upsert(PID, '', { optimistic: 1, likely: 1, pessimistic: 1 })) },
    { table: ERR_TABLE, key: 'planMissing', title: '计划不存在', run: () => fire(() => EstimateService.upsert(PID, 'pl-nope', { optimistic: 1, likely: 1, pessimistic: 1 })) },
    { table: ERR_TABLE, key: 'planNotInProject', title: '计划跨项目', run: () => fire(() => EstimateService.upsert(PID_B, 'pl-c1', { optimistic: 1, likely: 1, pessimistic: 1 })) },
    { table: ERR_TABLE, key: 'unknownPhase', title: '未知阶段', run: () => fire(() => EstimateService.upsert(PID, 'pl-c1', { optimistic: 1, likely: 1, pessimistic: 1, phase: 'qa' })) },
    { table: ERR_TABLE, key: 'pointsRequired', title: '三点必填', run: () => fire(() => EstimateService.upsert(PID, 'pl-case', { optimistic: 1 })) },
    { table: ERR_TABLE, key: 'paramLabel', title: '参数名前缀', run: () => fire(() => resolveEstimateConfig({ 'estimate.coef.scope': '-0.1' })) },
    { table: ERR_TABLE, key: 'unknownUnit', title: '未知计量单位', run: () => fire(() => EstimateService.upsert(PID, 'pl-c1', { optimistic: 1, likely: 1, pessimistic: 1, unit: 'hour' })) },
  ];
  // 里程碑只读支单独铺数据（夹具里 pl-ms 未收口），跑完恢复原状，不影响 R 段 PATCH
  db.prepare("UPDATE plan_tasks SET status = 'done', progress = 100 WHERE id = 'pl-ms'").run();
  cases.push({
    table: ERR_TABLE, key: 'milestoneReadonly', title: '收口里程碑只读',
    run: () => fire(() => EstimateService.upsert(PID, 'pl-ms', { optimistic: 1, likely: 1, pessimistic: 1 })),
  });
  const zj: string[] = [];
  for (const c of cases) {
    const stem = c.table[c.key];
    const before = c.run();
    if (!before.includes(stem)) {
      zj.push(`${c.title}：原始件文案没命中单源词干「${stem}」（实际「${before.slice(0, 60)}」）`);
      continue;
    }
    const renamed = `ZZZ-${c.key}`;
    c.table[c.key] = renamed;
    let after = '';
    try { after = c.run(); } finally { c.table[c.key] = stem; }
    if (after === '') zj.push(`${c.title}：改名后产品不再拒绝——校验本身失守（文案不是唯一挡点）`);
    else if (!after.includes(renamed)) zj.push(`${c.title}：改名后文案未随单源表移动（该层留了写死抄本）`);
    if (after.includes(stem)) zj.push(`${c.title}：改名后文案仍含旧词干「${stem}」= 第二份抄本`);
    if (c.run() !== before) zj.push(`${c.title}：还原后文案与原始件不逐字符相同（改表污染）`);
    if (estIds() !== baselineIds) {
      zj.push(`${c.title}：拒绝失效并落了行（副作用非零）`);
      for (const id of estIds().split(',').filter((id) => !baselineIds.split(',').includes(id))) {
        db.prepare('DELETE FROM estimate_items WHERE id = ?').run(id);
      }
    }
  }
  db.prepare("UPDATE plan_tasks SET status = 'todo', progress = 0 WHERE id = 'pl-ms'").run();
  ok('G-01 词干改名模拟全项通过（拒绝在、文案随单源移动、旧词干零残留、还原逐字符相同、零副作用）',
    zj.length === 0, zj);
  ok('G-02 改名模拟覆盖的词干数足够（本门 ≥ 15 支、四层都能触达）',
    cases.length >= 15, { 支数: cases.length, 去重词干: new Set(cases.map((c) => c.key)).size });

  // G-03 里程碑分类口径（T02123 / commit 3e4b613）的破行为反证。
  // R-09/R-20 的数字变了，不是因为「门写错了」，而是引擎的分类顺序改了：
  // 结构性排除（subtotal / milestone）先于「有没有三点」判定，无点值里程碑记 `excluded.milestone`。
  // 只把数字 5 改成 4 的门，换个人看不懂为什么——这里把新旧两种顺序喂同一份夹具，钉住「是哪条规则在生效」。
  type EngineRowLike = { key: string; phase: string; role: 'detail'; planKind: string; points: null };
  const oldOrder = (rows: EngineRowLike[]) => {
    const ex = { subtotal: 0, milestone: 0, unEstimated: 0 };
    for (const r of rows) {
      if (!r.points) { ex.unEstimated += 1; continue; }            // 旧顺序：先判点值
      if (r.planKind === 'milestone') { ex.milestone += 1; continue; }
    }
    return ex;
  };
  const mk = (key: string, planKind: string): EngineRowLike => ({ key, phase: 'dev', role: 'detail', planKind, points: null });
  const msNull = [mk('m1', 'milestone')];
  const detNull = [mk('d1', 'normal')];
  const newMsNull = buildSummary(msNull, CFG).ratioCheck.excluded;
  ok('G-03a 无点值里程碑记 excluded.milestone、不虚报未估算（T02123 口径）',
    newMsNull.milestone === 1 && newMsNull.unEstimated === 0, newMsNull);
  ok('G-03b 无点值明细行仍记 unEstimated（口径只收里程碑，没放宽成全盘排除）',
    buildSummary(detNull, CFG).ratioCheck.excluded.unEstimated === 1
    && buildSummary(detNull, CFG).ratioCheck.excluded.milestone === 0, buildSummary(detNull, CFG).ratioCheck.excluded);
  ok('G-03c 破行为反证成立：同一夹具在旧顺序下结论相反 → 断言钉的是规则不是数字',
    oldOrder(msNull).unEstimated === 1 && oldOrder(msNull).milestone === 0
    && JSON.stringify(newMsNull) !== JSON.stringify(oldOrder(msNull)), { 新: newMsNull, 旧: oldOrder(msNull) });
  ok('G-03d 有点值里程碑两版口径同判 milestone（改的只是无点值那一支）',
    (() => {
      const rows = [{ key: 'm2', phase: 'dev', role: 'detail' as const, planKind: 'milestone', points: { optimistic: 5, likely: 5, pessimistic: 8 } }];
      const ex = buildSummary(rows, CFG).ratioCheck.excluded;
      return ex.milestone === 1 && ex.unEstimated === 0 && JSON.stringify(ex) === JSON.stringify(oldOrder(rows as unknown as EngineRowLike[]));
    })(), buildSummary([{ key: 'm2', phase: 'dev', role: 'detail' as const, planKind: 'milestone', points: { optimistic: 5, likely: 5, pessimistic: 8 } }], CFG).ratioCheck.excluded);
}

console.log('\n=== R 段：/api/estimates* REST（隔离实例） ===');
closeDb();

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
async function waitForServer(ms = 45_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

type Resp = { status: number; json: Record<string, any> | null };
async function api(method: string, path: string, body?: unknown): Promise<Resp> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, any> | null = null;
  try { json = (await res.json()) as Record<string, any>; } catch { /* 非 JSON */ }
  return { status: res.status, json };
}
const Q = `?projectId=${PID}`;

if (!(await waitForServer())) {
  console.log('  [FAIL] 隔离服务未就绪，R 段整体跳过');
  console.log(serverLog.join('').slice(-1500));
  fail += 1;
} else {
  // R1 路由挂载 + 静态路径优先
  const health = await api('GET', '/api/health');
  ok('R-01 隔离实例就绪', health.status === 200);
  const params = await api('GET', `/api/estimates/params${Q}`);
  ok('R-02 静态路径 /params 不被 /:planId 抢占（plans.ts 同条红线）',
    params.status === 200 && params.json?.config?.manDaysPerManMonth === 20.83, params.json?.config);
  const meta = await api('GET', '/api/estimates/meta');
  okPair(ok, 'R-03 meta 单源下发阶段/系数标签与推导常量',
    () => meta.status === 200
      && JSON.stringify(Object.keys(meta.json?.phaseLabels ?? {})) === JSON.stringify([...ESTIMATE_META.phases])
      && ESTIMATE_META.phases.every((p) => meta.json?.phaseLabels?.[p] === ESTIMATE_META.phaseLabels[p])
      && meta.json?.complexityBaseDays?.[3] === 3.5 && meta.json?.casePriorityWeights?.P0 === 3
      && meta.json?.durationMul?.pMul === 1.4,
    // 字面侧取的是单源表**当前值**（不是文案抄本）：改措辞时两侧一起动，等价重构不会让门假红
    () => meta.json?.phaseLabels?.req === ESTIMATE_META.phaseLabels.req,
    () => ({ 下发: meta.json?.phaseLabels, 单源: ESTIMATE_META.phaseLabels }));
  const noPid = await api('GET', '/api/estimates');
  rejected400('R-04 projectId 必填走 400 中文文案', noPid, ESTIMATE_ERRORS.projectIdRequired,
    () => params.status === 200);

  // R5 GET 全量
  const g0 = await api('GET', `/api/estimates${Q}`);
  const items0 = g0.json?.items ?? [];
  ok('R-05 GET 全量：明细左联 + 汇总 + 参数 + 校验结果四块齐备',
    g0.status === 200 && Array.isArray(items0) && g0.json?.summary?.phases && g0.json?.params?.config && g0.json?.checks?.ratioCheck);
  ok('R-06 首屏明细=2 行（未 derive），里程碑无行',
    items0.length === 2 && items0.every((i: any) => i.plan_id !== 'pl-ms'));
  ok('R-07 汇总只算已有估算行：E = pl-man4.5 + pl-rule2 = 6.5',
    near(g0.json.summary.directManDays.expected, 6.5, 1e-9), g0.json.summary.directManDays);
  ok('R-08 自检集合含未估算计划（visiblePlans=7：6 normal + 1 milestone）',
    g0.json.checks.visiblePlans === 7, g0.json.checks);
  // 引擎的排除分类（T02123 / commit 3e4b613）：**结构性排除先于未估算判定**——
  // 里程碑行不论有没有三点都记 `excluded.milestone`，不再虚报成「未录入」（四期 49 行里 14 行里程碑曾被误报待录入）。
  // 故此处 unEstimated = 4 条无点值明细（pl-c3/pl-c1/pl-case/pl-dur），里程碑单独记 1。口径失守由 G-03 反证。
  ok('R-09 未估算明细计入自检（unEstimated=4）、里程碑计入结构性排除（milestone=1）',
    g0.json.summary.ratioCheck.excluded.unEstimated === 4
    && g0.json.summary.ratioCheck.excluded.milestone === 1
    && !(g0.json.summary.countedKeys ?? []).includes('pl-ms'), g0.json.summary.ratioCheck);
  ok('R-10 sumRatio 恒等自检不报错（danger=false，偏差 <1%）',
    g0.json.summary.ratioCheck.danger === false && near(g0.json.summary.ratioCheck.sumRatio, 1, 1e-6),
    g0.json.summary.ratioCheck);
  ok('R-11 脱离计划的估算行 =1（不进明细也不进 Σ）',
    g0.json.checks.detached === 1 && !items0.some((i: any) => i.plan_id === 'pl-gone'), g0.json.checks);
  ok('R-12 归档计划不进 Σ（pl-arch 缺席骨架）', g0.json.checks.coverage.normal === 6);

  // R13 derive 预览默认不落库
  const dv = await api('POST', '/api/estimates/derive', { projectId: PID });
  ok('R-13 POST /derive 默认 dryRun 且 written=0',
    dv.status === 200 && dv.json?.dryRun === true && dv.json?.written === 0 && dv.json?.items?.length === 7, dv.json?.dryRun);
  const g1 = await api('GET', `/api/estimates${Q}`);
  ok('R-14 预览之后库里行数不变（(project,plan) 仍 2 行）', g1.json?.items?.length === 2);
  const dvm = dv.json?.items?.find((i: any) => i.planId === 'pl-ms');
  ok('R-15 预览里里程碑带参考值但 skip=milestone', dvm?.skip === 'milestone' && dvm?.writable === false && near(dvm.expected, 5.5, 1e-9));

  // R16 落库
  const dw = await api('POST', '/api/estimates/derive', { projectId: PID, dryRun: false });
  ok('R-16 dryRun:false 落库 4 行并回传 planIds',
    dw.json?.dryRun === false && dw.json?.written === 4 && dw.json?.writtenPlanIds?.length === 4 && dw.json?.errors?.length === 0,
    { written: dw.json?.written, ids: dw.json?.writtenPlanIds });
  const g2 = await api('GET', `/api/estimates${Q}`);
  const byId = new Map((g2.json?.items ?? []).map((i: any) => [i.plan_id, i]));
  ok('R-17 落库后 6 行：新增 4 行 source=rule',
    g2.json.items.length === 6 && byId.get('pl-c3')?.source === 'rule' && byId.get('pl-dur')?.source === 'rule');
  ok('R-18 落库值与预览逐值相等（REST 不改口径）',
    byId.get('pl-c3')?.optimistic === 3.5 && byId.get('pl-c3')?.likely === 3.5 && byId.get('pl-c3')?.pessimistic === 5.5
    && byId.get('pl-case')?.phase === 'dev' && byId.get('pl-dur')?.phase === 'impl', byId.get('pl-c3'));
  ok('R-19 人工行原值未动（3/4/8）',
    byId.get('pl-man')?.optimistic === 3 && byId.get('pl-man')?.likely === 4 && byId.get('pl-man')?.pessimistic === 8);
  ok('R-20 里程碑仍无估算行（derive 限定 normal）且不在 Σ 里；落库后未估算归零、里程碑仍记结构性排除',
    !byId.has('pl-ms') && !(g2.json.summary.countedKeys ?? []).includes('pl-ms')
    && g2.json.summary.ratioCheck.excluded.unEstimated === 0
    && g2.json.summary.ratioCheck.excluded.milestone === 1, g2.json.summary.ratioCheck);
  ok('R-21 汇总随落库更新：E = 6.5 + 3.8333+1.0833+3.75+7.25 = 22.4166667',
    near(g2.json.summary.directManDays.expected, 22.416666666666668, 1e-9), g2.json.summary.directManDays);
  ok('R-22 覆盖面收口：estimated=6 / missing=0',
    g2.json.checks.coverage.estimated === 6 && g2.json.checks.coverage.missing === 0, g2.json.checks.coverage);
  const sum = g2.json.summary;
  const normalSum = (g2.json.items as any[]).reduce((a, i) => a + expected({ optimistic: i.optimistic, likely: i.likely, pessimistic: i.pessimistic }), 0);
  ok('R-23 Σ(全部估算行) = Σ(仅 normal 行) —— 没有第二处把里程碑算进去', near(sum.directManDays.expected, normalSum, 1e-9));

  // R24 PATCH 单行 + 人工转 manual
  const p1 = await api('PATCH', `/api/estimates/pl-c3${Q}`, { optimistic: 4, likely: 5, pessimistic: 6 });
  ok('R-24 PATCH 单行成功并回视图行', p1.status === 200 && p1.json?.item?.optimistic === 4 && p1.json?.item?.planTitle === '需求分析-复杂度3');
  ok('R-25 人工改过即转 manual（§4.6：不转则复核率虚高）', p1.json?.item?.source === 'manual', p1.json?.item?.source);
  const p2 = await api('PATCH', `/api/estimates/pl-c3${Q}`, { likely: 5, source: 'rule' });
  ok('R-26 显式 source 优先（AI/批量通道仍可写回 rule）', p2.json?.item?.source === 'rule');
  const p3 = await api('PATCH', `/api/estimates/pl-c3${Q}`, { optimistic: 9, likely: 5, pessimistic: 6 });
  const p4 = await api('PATCH', `/api/estimates/pl-nope${Q}`, { optimistic: 1, likely: 1, pessimistic: 1 });
  const gP = await api('GET', `/api/estimates${Q}`);
  const itemsP = gP.json?.items ?? [];
  const rowP = itemsP.find((i: any) => i.plan_id === 'pl-c3');
  rejected400('R-27 三点校验走 400 中文文案（O>M）', p3, ESTIMATE_ERRORS.ordering,
    // 行为侧钉「拒绝即零写入」：被拒的 9/5/6 没落库，原值仍是 R-24 的 4/5/6
    () => rowP?.optimistic === 4 && rowP?.likely === 5 && rowP?.pessimistic === 6);
  rejected400('R-28 不存在的计划报错', p4, ESTIMATE_ERRORS.planMissing,
    () => !itemsP.some((i: any) => i.plan_id === 'pl-nope') && itemsP.length === 6);

  // R29 批量
  const b1 = await api('POST', '/api/estimates/batch', {
    projectId: PID,
    items: [{ planId: 'pl-c1', phase: 'design', optimistic: 1, likely: 2, pessimistic: 3 },
      { planId: 'pl-dur', optimistic: 9, likely: 1, pessimistic: 2 }],
  });
  ok('R-29 批量任一行不合格 → 零写入 + 行级错误（带 index/planId）',
    b1.status === 200 && b1.json?.written === 0 && b1.json?.errors?.length === 1
    && b1.json.errors[0].index === 1 && b1.json.errors[0].planId === 'pl-dur', b1.json);
  const g3 = await api('GET', `/api/estimates${Q}`);
  const byId3 = new Map((g3.json?.items ?? []).map((i: any) => [i.plan_id, i]));
  ok('R-30 零写入是真的：同行批次的 pl-c1 未变（仍是 derive 的 1/1/1.5）',
    byId3.get('pl-c1')?.likely === 1 && byId3.get('pl-c1')?.pessimistic === 1.5);
  const b2 = await api('POST', '/api/estimates/batch', {
    projectId: PID, items: [{ planId: 'pl-c1', phase: 'design', optimistic: 1, likely: 2, pessimistic: 3 }],
  });
  ok('R-31 批量 mode=set 正常写入', b2.json?.written === 1 && b2.json?.errors?.length === 0, b2.json);
  const b3 = await api('POST', '/api/estimates/batch', { projectId: PID, mode: 'explode', items: [] });
  const b4 = await api('POST', '/api/estimates/batch', { projectId: PID, mode: 'set', items: [] });
  const gB = await api('GET', `/api/estimates${Q}`);
  const itemsB = (gB.json?.items ?? []).map((i: any) => `${i.plan_id}/${i.optimistic}/${i.likely}/${i.pessimistic}`);
  rejected400('R-32 未知批量模式报错', b3, ESTIMATE_ERRORS.unknownBatchMode, () => itemsB.length === 6);
  rejected400('R-33 空批量内容报错（不是静默成功）', b4, ESTIMATE_ERRORS.batchEmpty,
    // 行为侧：两次坏批次都没改动库——上一步 R-31 写的 pl-c1=1/2/3 原样在
    () => itemsB.length === 6 && itemsB.includes('pl-c1/1/2/3'));
  const b5 = await api('POST', '/api/estimates/batch', { projectId: PID, mode: 'derive', dryRun: true });
  ok('R-34 mode=derive + dryRun 只预览（written=0）', b5.json?.mode === 'derive' && b5.json?.dryRun === true && b5.json?.written === 0);

  // R35 参数读写
  const pu = await api('PUT', `/api/estimates/params${Q}`, {
    settings: { 'estimate.manDaysPerManMonth': '20', 'estimate.coef.scope': '0.1', 'estimate.rule.default.ratio': '1:4:1.2' },
  });
  ok('R-35 PUT /params 落配置并回读生效',
    pu.status === 200 && pu.json?.config?.manDaysPerManMonth === 20 && pu.json?.config?.coefs?.scope === 0.1
    && pu.json?.config?.ruleRatio?.pMul === 1.2, pu.json?.config);
  const g4 = await api('GET', `/api/estimates${Q}`);
  ok('R-36 人月换算按新参数走（÷20 而非 ÷20.83）',
    near(g4.json.summary.idealManMonths.expected, g4.json.summary.directManDays.expected / 20, 1e-9),
    g4.json.summary.idealManMonths);
  const bad = await api('PUT', `/api/estimates/params${Q}`, {
    settings: { 'estimate.manDaysPerManMonth': '25', 'estimate.rule.default.ratio': '1:5:1.6' },
  });
  rejected400('R-37 比例中段非 4 → 400 且整批零写入（一位小数写歪就是钱）', bad, ESTIMATE_ERRORS.ratioMidPert);
  const g5 = await api('GET', `/api/estimates/params${Q}`);
  ok('R-38 失败批次里合法键也没落库（manDays 仍 20）',
    g5.json?.config?.manDaysPerManMonth === 20, g5.json?.config);
  const unk = await api('PUT', `/api/estimates/params${Q}`, { settings: { 'estimate.nope': '1' } });
  const g5b = await api('GET', `/api/estimates/params${Q}`);
  rejected400('R-39 未知参数键拒绝', unk, ESTIMATE_ERRORS.unknownParamKey,
    // 行为侧：未知键整批被拒后，上一批落库的 manDays=20 仍在（没有部分写入）
    () => g5b.json?.config?.manDaysPerManMonth === 20);
  const kpu = await api('PUT', `/api/estimates/params${Q}`, { settings: { [`estimate.caseWeightK.${PID}`]: '1' } });
  ok('R-40 项目级 k 覆盖生效（§4.6 规则2「项目级可配」）',
    kpu.status === 200 && kpu.json?.caseWeightK?.k === 1 && kpu.json?.caseWeightK?.from === 'project', kpu.json?.caseWeightK);
  const dK = await api('POST', '/api/estimates/derive', { projectId: PID, dryRun: true, scope: 'all', planIds: ['pl-case'] });
  const cse = dK.json?.items?.[0];
  ok('R-41 derive 走项目级 k：M=grid(6.5×1)=6.5、P=grid(6.5×1.2)=8',
    cse?.likely === 6.5 && cse?.pessimistic === 8, cse);
  const badK = await api('PUT', `/api/estimates/params${Q}`, { settings: { 'estimate.caseWeightK': '0' } });
  const gK = await api('GET', `/api/estimates/params${Q}`);
  rejected400('R-42 k=0 拒绝（正数才有效）', badK, ESTIMATE_ERRORS.mustBePositive,
    // 行为侧：坏的全局 k 没落库，R-40 设的项目级 k=1 仍是生效值（拒绝即零写入）
    () => gK.json?.caseWeightK?.k === 1 && gK.json?.caseWeightK?.from === 'project');
  const clr = await api('PUT', `/api/estimates/params${Q}`, {
    settings: { 'estimate.manDaysPerManMonth': '', 'estimate.coef.scope': '', 'estimate.rule.default.ratio': '', 'estimate.hideCoefsForClient': 'true' },
  });
  ok('R-43 传空串=回落默认，脱敏开关可开',
    clr.status === 200 && clr.json?.config?.manDaysPerManMonth === 20.83 && clr.json?.config?.coefs?.scope === 0.05
    && clr.json?.config?.hideCoefsForClient === true, clr.json?.config);

  // R44 快照与 compare
  const sn = await api('GET', `/api/estimates/snapshots${Q}`);
  ok('R-44 快照列表按时间倒序（最近 20 条口径）',
    sn.status === 200 && sn.json?.snapshots?.length === 2 && sn.json.snapshots[0].id === 'sn-b');
  const cmp = await api('GET', `/api/estimates/snapshots${Q}&compare=sn-a,sn-b`);
  const dev = cmp.json?.compare?.diff?.phases?.find((p: any) => p.phase === 'dev');
  ok('R-45 compare 两版差异：dev E 10→12（Δ2）、人天合计 Δ4、人月合计 Δ0.4',
    cmp.status === 200 && near(dev?.expected?.delta, 2, 1e-9)
    && near(cmp.json.compare.diff.totals.directManDays, 4, 1e-9)
    && near(cmp.json.compare.diff.totals.actualManMonths, 0.4, 1e-9), cmp.json?.compare?.diff);
  const cmpBad = await api('GET', `/api/estimates/snapshots${Q}&compare=sn-a`);
  rejected400('R-46 compare 参数非两枚报错', cmpBad, ESTIMATE_ERRORS.compareNeedsTwo,
    () => cmp.status === 200);

  // R47 归档行与脱离行
  const pa = await api('PATCH', `/api/estimates/pl-arch${Q}`, { optimistic: 2, likely: 2, pessimistic: 2 });
  ok('R-47 归档计划仍可存估算（历史报价依据）', pa.status === 200 && pa.json?.item?.planArchived === 1);
  const g6 = await api('GET', `/api/estimates${Q}`);
  const g6a = await api('GET', `/api/estimates${Q}&includeArchived=1`);
  ok('R-48 默认列表/Σ 都不含归档行，includeArchived 只多列不改 Σ',
    !g6.json.items.some((i: any) => i.plan_id === 'pl-arch')
    && g6a.json.items.some((i: any) => i.plan_id === 'pl-arch')
    && near(g6.json.summary.directManDays.expected, g6a.json.summary.directManDays.expected, 1e-9),
    { a: g6.json.items.length, b: g6a.json.items.length });
  const dl = await api('GET', `/api/estimates/detach${Q}`);
  ok('R-49 脱离行单独通道可见（1 条 pl-gone）', dl.status === 200 && dl.json?.rows?.length === 1 && dl.json.rows[0].plan_id === 'pl-gone');
  const dcBad = await api('POST', '/api/estimates/detach/cleanup', { projectId: PID, ids: ['es-man'] });
  ok('R-50 清理只动确属脱离的行（在架行跳过）', dcBad.status === 200 && dcBad.json?.removed === 0, dcBad.json);
  const dc = await api('POST', '/api/estimates/detach/cleanup', { projectId: PID, ids: ['es-gone'] });
  const g7 = await api('GET', `/api/estimates${Q}`);
  ok('R-51 显式清理脱离行后 checks.detached 归零', dc.json?.removed === 1 && g7.json.checks.detached === 0, g7.json.checks);

  // R52 删除单行
  const del = await api('DELETE', `/api/estimates/pl-dur${Q}`);
  const g8 = await api('GET', `/api/estimates${Q}`);
  ok('R-52 DELETE 单行生效且汇总同步回落',
    del.json?.removed === true && g8.json.checks.coverage.missing === 1
    && near(g8.json.summary.directManDays.expected, g7.json.summary.directManDays.expected - 7.25, 1e-9),
    { before: g7.json.summary.directManDays.expected, after: g8.json.summary.directManDays.expected });

  // R53 里程碑行不能直接 PATCH 进 Σ（路由层不拦，但引擎按 kind 排除）
  const pms = await api('PATCH', `/api/estimates/pl-ms${Q}`, { optimistic: 5, likely: 5, pessimistic: 8 });
  const g9 = await api('GET', `/api/estimates${Q}`);
  ok('R-53 误给里程碑写估算也不进 Σ（planKind 排除是最后一道）',
    pms.status === 200 && near(g9.json.summary.directManDays.expected, g8.json.summary.directManDays.expected, 1e-9)
    && g9.json.summary.ratioCheck.excluded.milestone === 1);

  ok('R-54 服务日志无 estimates 相关异常', !/estimates[\s\S]{0,200}(Error|throw)/i.test(serverLog.join('')));

  // ============ H 段：跨进程同源自证（T02293 判据 4） ============
  // 上面每条 400 的文案出自**隔离服务进程**，门进程只持有 `ESTIMATE_ERRORS` 词干表。
  // 若门抄的是整句当下措辞，产品改词后本应一起红的两侧会分成「行为在、锚点失配」——配对器能分辨，
  // 但更彻底的做法是直接证明两边读的是同一张表：H-01 逐条词干命中，H-03/H-04 同入参逐字符相同。
  const stems = Object.values(ESTIMATE_ERRORS);
  const h1Miss = rest400.filter((r) => !stems.some((s) => r.error.includes(s)));
  ok('H-01 服务端 400 原文逐条命中门进程单源词干（≥8 条全中）',
    rest400.length >= 8 && h1Miss.length === 0, { 条数: rest400.length, 未命中: h1Miss.map((r) => r.label) });
  const fakeStem = 'ZZZ-本门不存在的词干';
  ok('H-02 假词干对全部 400 原文零命中（H-01 的比对不是恒真式）',
    rest400.length > 0 && rest400.every((r) => !r.error.includes(fakeStem)), { 条数: rest400.length });
  ok('H-03 三点校验：同一入参在服务端与门进程产出的文案逐字符相同',
    String(p3.json?.error ?? '') === (pointsError(9, 5, 6) ?? ''),
    { 服务端: p3.json?.error, 门进程: pointsError(9, 5, 6) });
  ok('H-04 比例中段校验：同一入参在服务端与门进程产出的文案逐字符相同',
    String(bad.json?.error ?? '') === fire(() => parseRuleRatio('1:5:1.6')),
    { 服务端: bad.json?.error, 门进程: fire(() => parseRuleRatio('1:5:1.6')) });
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
child.kill();
await new Promise((r) => setTimeout(r, 300));
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 句柄未放 */ }
process.exit(fail === 0 ? 0 : 1);
