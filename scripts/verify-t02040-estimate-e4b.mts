/**
 * T02040（PRD-估算视图 §5.3 + E5）验证脚本：估算面板的**写路径**与「判定权在服务端」这条红线。
 *
 * 用法（Node 版本必须与 node_modules/better-sqlite3 的预编译 ABI 对齐，本机 Node22 ABI127 可加载；
 *   与 verify-t02039-estimate-e4a 同写法，不在 package.json 硬编码 node 绝对路径）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02040-estimate-e4b.mts
 *
 * 分段结构（沿用 E4 首段 e4a 的取证范式）：
 *   S 段（同进程·纯函数 + 源码守卫）：
 *     1) `toGrid` 前端镜像与服务端逐格对照——「统一值 + 相对幅度」是面板唯一一处算术，
 *        镜像漂移就会让面板与 Excel 出两套数；
 *     2) 快照/枚举单源（`BATCH_RULE_LABEL`/`SKIP_LABEL` 必须覆盖服务端 `DERIVE_RULES`/`DERIVE_SKIPS`）；
 *     3) 红线守卫：面板源码**不得**出现 O≤M≤P 判据（谁被拒只能由服务端说），也不得出现 PERT 式子。
 *   R 段（隔离实例·REST）：按面板真实的写路径打请求——
 *     PATCH 单字段（沿用原值 + 规则行转人工）、建议行首次落库、`O>M` 与非数字被 400 拒且零写入、
 *     batch mode=set 任一行不合格零写入、batch mode=derive 的 `onlyRule` 过滤（offRule 整行跳过、
 *     不换个档硬凑）、撤销的两条通道（还原快照含 source / 删除本次新建行）、脱离计划行的显式清理。
 *   G 段（同进程·T02293 判据 1/3/4，须在 REST 实例启动前跑）：
 *     改名模拟——把 `ESTIMATE_ERRORS`/`ESTIMATE_POINT_LABELS` 的词干逐支改成 `ZZZ-<key>` 后触发
 *     同一校验，要求「照样拒绝、文案随单源表移动、旧词干零残留、还原逐字符相同、零副作用」；
 *     任一条失守即说明某层留了第二份抄本。另证「改名期间合法值照旧通过」（校验不是按字面量写的）。
 *   H 段（跨进程·判据 4）：R 段每条 400 原文登记在册，逐条要能用门进程的单源词干解释，
 *     且同一入参在门进程直调 `pointsError` 得到的文案与服务端逐字符相同
 *     （REST 的 400 体是裸 `{ error }`，没有 MCP 那种信封要剥）；末尾两条反证钉住配对器的判别力
 *     （字面在、行为无 ⇒ 判红且红因指行为；连合法对照都被拒 ⇒ 判红，门不会因为「什么都拒」而绿）。
 *
 * 隔离纪律（skill 红线 8）：库与端口都是临时的，不碰生产数据目录，跑完 kill + 回收临时目录。
 * 真机 UI 走查（§10-3/4/5）不在本脚本内，见 scripts/verify-t02040-ui.mjs。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { shimWebDocumentForNode } from './lib/web-dom-shim.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02040-e4b-'));
const PORT = Number(process.env.T02040_PORT ?? 39931);
process.env.MTask_DATA_DIR = DATA_DIR;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const { ESTIMATE_SOURCES, pointsError, ESTIMATE_ERRORS, ESTIMATE_POINT_LABELS, EstimateService }
  = await import('../server/src/services/EstimateService.ts');
const {
  DERIVE_RULES, DERIVE_SKIPS, COMPLEXITY_BASE_DAYS, toGrid: srvToGrid,
} = await import('../server/src/services/EstimateDerive.ts');
shimWebDocumentForNode(PORT);
const P = await import('../web/src/components/EstimatePanel.tsx');
const FE = await import('../web/src/api/estimates.ts');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 260)}` : ''}`);
  }
};
const near = (a: number, b: number, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;
const T = '2026-10-11T00:00:00.000Z';
const PID = 'p-e4b';
const PANEL_SRC = readFileSync(join(ROOT, 'web', 'src', 'components', 'EstimatePanel.tsx'), 'utf8');
const API_SRC = readFileSync(join(ROOT, 'web', 'src', 'api', 'estimates.ts'), 'utf8');
/** 输入网格步进：由服务端 `toGrid` 反推（0.26 与 0.24 落两格），不在门里写死「0.5」 */
const GRID_STEP = srvToGrid(0.26) - srvToGrid(0.24);
/** 把「应当抛错的调用」收成文案（不抛则空串，交给配对器的行为侧判红） */
const fire = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
/**
 * 400 类断言的配对器（T02293 判据 3）。
 * 行为侧 = 请求真的被拒（400 + 非空文案），调用方再叠两件：拒绝后**零副作用**的读数、
 * 以及只差一个合法值的对照调用仍能成功——后者防的是「把什么都拒掉换字面锚点全绿」。
 * 字面侧 = 文案含产品**单源词干**（`ESTIMATE_ERRORS`/`ESTIMATE_POINT_LABELS`，见 `server/src/services/estimateCopy.ts`），
 * 门里一个字都不抄；每条 400 原文同时登记进 `rest400`，供 H 段与服务端做同一性比对。
 */
const rest400: Array<{ label: string; error: string }> = [];
const rejectedPair = (
  label: string,
  res: { status: number; json: Record<string, any> },
  stems: string | readonly string[],
  extraBehavior?: () => boolean,
) => {
  const list = Array.isArray(stems) ? stems : [stems as string];
  const msg = String(res.json?.error ?? '');
  if (res.status === 400) rest400.push({ label, error: msg });
  return okPair(ok, label,
    () => res.status === 400 && msg.length > 0 && (extraBehavior ? extraBehavior() : true),
    () => list.every((s) => msg.includes(s)),
    () => ({ status: res.status, error: msg.slice(0, 140) }));
};
/** 同一入参在门进程直调产品函数的文案，与登记的 400 原文配对存下来，由 H-03 逐字符比对 */
const sameSource: Array<{ label: string; server: string; mine: string }> = [];
/** 路由层拼装的那一条（档名清单来自 `DERIVE_RULES`），由 H-04 按部件比对 */
let bogusRouteParts: { server: string; bad: string; rules: string } | null = null;

// ---------------- 夹具：直接写隔离测试库（不经 REST，也不碰生产） ----------------
initSchema();
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, 'T02040-行内录入与批量填充', '', T, T);

const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids)
   VALUES (?, ?, ?, '', ?, ?, ?, 0, 'todo', '', ?, ?, ?, ?, ?, ?)`,
);
type Seed = [id: string, title: string, dur: number, sort: number, kind: string, cx: number | null, reqs: string[]];
const seeds: Seed[] = [
  ['ms-1', 'M1 需求阶段', 10, 1, 'milestone', 4, []],
  ['pl-cx', '需求分析-复杂度档', 5, 2, 'normal', 3, ['rq-1']],
  ['pl-cx2', '开发实施-复杂度2档', 4, 3, 'normal', 2, []],
  ['pl-case', '系统设计-用例加权', 4, 4, 'normal', null, ['rq-1']],
  ['pl-dur', '开发联调-仅工期', 7, 5, 'normal', null, []],
  ['pl-man', '开发实施-人工已录', 3, 6, 'normal', 2, []],
];
for (const [id, title, dur, sort, kind, cx, reqs] of seeds) {
  insPlan.run(id, PID, title, '2026-10-12', '2026-10-12', dur, sort, T, T, kind, cx, reqs.length ? JSON.stringify(reqs) : null);
}
db.prepare(`INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, '', '', 'normal', 'todo', 0, ?, ?)`)
  .run('rq-1', PID, 'REQ-001', '行内录入取证需求', T, T);
db.prepare(`INSERT INTO test_cases (id, project_id, req_id, case_no, title, priority, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('tc-1', PID, 'rq-1', 'C-1', '用例1', 'P0', T, T);

const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, ?, ?, ?)`,
);
insEst.run('es-man', PID, 'pl-man', 'impl', 3, 4, 8, 'manual', '人工复核过的行', T, T);
insEst.run('es-dur', PID, 'pl-dur', 'dev', 5.5, 7, 9.5, 'rule', '规则写入', T, T);
insEst.run('es-case', PID, 'pl-case', 'design', 2, 2.5, 3.5, 'rule', '规则写入', T, T);
// 脱离计划的估算行：plan_id 指向不存在的计划（§7 计划被彻底删除后估算原样保留）
insEst.run('es-gone', PID, 'pl-gone', 'dev', 1, 1, 1.6, 'rule', '脱离行', T, T);

console.log('\n=== S 段：写路径的纯函数与红线守卫（同进程·不碰磁盘） ===');

// S1-S2 toGrid 镜像逐格对照（面板「统一值」档唯一的算术，必须与服务端同一语义）
{
  const vals = [0, 0.1, 0.25, 0.3, 0.4, 0.5, 0.6, 0.74, 0.75, 1.2, 1.24, 1.26, 2.5, 3.7, 7.35, 19.8, 20, 20.2, 41.6];
  const diff = vals.filter((v) => FE.toGrid(v) !== srvToGrid(v));
  ok(`S-01 toGrid 前端镜像与服务端逐格一致（${vals.length} 个取样，含 .25/.75 半格边界）`, diff.length === 0, diff);
  const up = P.uniformPoints(3, 0.8, 1.4);
  ok('S-02 uniformPoints 只算「M×倍率 + 落网格」，不碰 E/σ（§5.3 模式③ 的例子 M=3 → 2.5/3/4）',
    up.optimistic === srvToGrid(3 * 0.8) && up.likely === 3 && up.pessimistic === srvToGrid(3 * 1.4)
    && up.optimistic === 2.5 && up.pessimistic === 4, up);
  ok('S-02b 三点仍满足 O≤M≤P（倍率合法时面板给出的候选值不自相矛盾，最终判定权在服务端）',
    up.optimistic <= up.likely && up.likely <= up.pessimistic, up);
}

// S3-S5 撤销快照与枚举单源
{
  type Row = ReturnType<typeof P.buildPanelRows>[number];
  const asPlan = (id: string, kind = 'normal', complexity: number | null = null) => ({
    id, title: id, description: null, kind, start_date: '2026-10-12', end_date: '2026-10-12',
    duration_days: 3, progress: 0, status: 'todo', assignee: null, linked_task_id: null, complexity,
  });
  const mkItem = (planId: string, o: number, m: number, p: number, source: string, phase = 'dev') => ({
    id: `e-${planId}`, project_id: PID, plan_id: planId, phase, unit: 'man_day',
    optimistic: o, likely: m, pessimistic: p, source, note: '', created_at: T, updated_at: T,
    planTitle: planId, planKind: 'normal', planArchived: 0, planStatus: 'todo', planProgress: 0,
    startDate: '2026-10-12', endDate: '2026-10-12', durationDays: 3, complexity: null,
  }) as unknown as Parameters<typeof P.buildPanelRows>[1][number];

  const rows: Row[] = P.buildPanelRows(
    [asPlan('pl-a'), asPlan('pl-b'), asPlan('ms-x', 'milestone')],
    [mkItem('pl-a', 2, 3, 4, 'rule', 'req')], [], [], {},
  );
  const persisted = rows.find((r) => r.planId === 'pl-a')!;
  const suggestion = rows.find((r) => r.planId === 'pl-b')!;
  ok('S-03 persisted/source 两字段到位：落库行 = true+实际 source，无行 = false+none（撤销与「只看未复核」按它判，不靠徽标文案）',
    persisted.persisted === true && persisted.source === 'rule' && suggestion.persisted === false && suggestion.source === 'none',
    { persisted, suggestion });
  const snap = P.snapshotRow(persisted);
  ok('S-04 快照带三点 + source + phase（缺 source 就会被 PATCH 的「转 manual」洗掉人工/规则标记，撤销不等价于还原）',
    snap?.optimistic === 2 && snap?.likely === 3 && snap?.pessimistic === 4 && snap?.source === 'rule' && snap?.phase === 'req', snap);
  ok('S-05 未落库行快照为 null：撤销语义=删掉本次新建的估算行，而不是写 0',
    P.snapshotRow(suggestion) === null, P.snapshotRow(suggestion));

  const batchKeys = Object.keys(P.BATCH_RULE_LABEL);
  ok('S-06 BATCH_RULE_LABEL 键集 = 服务端 DERIVE_RULES 三档（批量按钮名单与推导档同源）',
    DERIVE_RULES.every((r) => batchKeys.includes(r)) && batchKeys.length === DERIVE_RULES.length,
    { batchKeys, DERIVE_RULES });
  ok('S-07 SKIP_LABEL 覆盖服务端 DERIVE_SKIPS 全集（含 T02040 新增的 offRule），面板不翻译不出的跳过原因',
    DERIVE_SKIPS.every((k) => k in P.SKIP_LABEL) && 'offRule' in P.SKIP_LABEL,
    { skips: DERIVE_SKIPS, labels: Object.keys(P.SKIP_LABEL) });
  ok('S-08 POINT_FIELDS 就是 O/M/P 三列且与 EstimateInput 字段名逐字相同（PATCH 直接按它拼 body）',
    JSON.stringify(P.POINT_FIELDS) === '["optimistic","likely","pessimistic"]'
    && ['optimistic', 'likely', 'pessimistic'].every((f) => f in P.POINT_LABEL), P.POINT_FIELDS);
  ok('S-08b 来源枚举仍单源：面板徽标表覆盖 ESTIMATE_SOURCES 且不扩造',
    ESTIMATE_SOURCES.every((x) => x in P.SOURCE_BADGE), { ESTIMATE_SOURCES });
}

// S9-S12 红线守卫（源码特征）
{
  // 判据守卫只看**代码体**：面板头部注释里会出现「前端不复写一份 pointsError」这类说明文字，
  // 那是口径声明而不是判据；把注释剥掉再比，免得为过断言去改写文档。
  const CODE = PANEL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const guards: Array<[string, RegExp]> = [
    ['O>likely 判据', /optimistic\s*>/],
    ['likely>P 判据', /likely\s*>/],
    ['服务端校验函数名', /pointsError/],
  ];
  // 「服务端错误原文」这一路原来抄的是整句中文（`不能大于最可能值|必须是数字`），
  // 换成从单源表取词干（判据 1）：词干比整句更宽，守卫只会更严不会更松；
  // 产品日后改措辞时守卫随表移动，不会因门里的抄本过时而误报面板「留了第二份判据」。
  const copyStems = [ESTIMATE_ERRORS.ordering, ESTIMATE_ERRORS.notNumber, ESTIMATE_ERRORS.negative];
  const hit = [
    ...guards.filter(([, re]) => re.test(CODE)).map(([n]) => n),
    ...copyStems.filter((s) => CODE.includes(s)).map(() => '服务端错误原文'),
  ];
  ok('S-09 行内录入不前置判 O≤M≤P：判据只有一份（服务端），面板只转录 400 文案', hit.length === 0, hit);
  // 配对器口径（判据 3）：行为侧证明「判定权真的不在面板」——纯函数拿到一组自相矛盾的三点
  // 照样出行、不带任何本地拒绝标记，也不从面板模块导出第二份判据函数。
  {
    type Row = ReturnType<typeof P.buildPanelRows>[number];
    const bad = {
      id: 'e-bad', project_id: PID, plan_id: 'pl-bad', phase: 'dev', unit: 'man_day',
      optimistic: 12, likely: 6, pessimistic: 9.5, source: 'manual', note: '', created_at: T, updated_at: T,
      planTitle: 'pl-bad', planKind: 'normal', planArchived: 0, planStatus: 'todo', planProgress: 0,
      startDate: '2026-10-12', endDate: '2026-10-12', durationDays: 3, complexity: null,
    } as unknown as Parameters<typeof P.buildPanelRows>[1][number];
    const plan = {
      id: 'pl-bad', title: 'pl-bad', description: null, kind: 'normal', start_date: '2026-10-12',
      end_date: '2026-10-12', duration_days: 3, progress: 0, status: 'todo', assignee: null,
      linked_task_id: null, complexity: null,
    };
    const rows = P.buildPanelRows([plan], [bad], [], [], {}) as unknown as Array<Row & Record<string, unknown>>;
    const veto = rows.filter((r) => 'error' in r || 'rejected' in r || 'invalid' in r).length;
    okPair(ok, 'S-09b 三点判据唯一份在服务端：面板纯函数收下 O>M 的行不拒绝，服务端却按单源词干拒绝',
      () => rows.length === 1 && rows[0].optimistic === 12 && rows[0].likely === 6 && veto === 0 && !('pointsError' in P),
      () => (pointsError(12, 6, 9.5) ?? '').includes(ESTIMATE_ERRORS.ordering),
      () => ({ 面板行: rows[0], 服务端文案: pointsError(12, 6, 9.5) }));
  }
  const pert = [/\boptimistic\s*\+\s*likely/, /likely\s*\*\s*4/, /\/\s*6\b/, /sigma\s*\(/, /\bexpected\s*=\s*\(/];
  const pertHit = pert.map((re) => re.source).filter((s) => new RegExp(s).test(PANEL_SRC));
  ok('S-10 写路径落地后零计算红线仍在（不含 PERT/σ 式子；新增的只有 M×倍率与落网格）', pertHit.length === 0, pertHit);
  ok('S-11 走 REST 写：PATCH/DELETE/batch 三个通道都经 estimatesApi，面板不直接 fetch 也不引服务端模块',
    /estimatesApi\.patchItem/.test(PANEL_SRC) && /estimatesApi\.batchSet/.test(PANEL_SRC)
    && /estimatesApi\.batchDerive/.test(PANEL_SRC) && /estimatesApi\.removeItem/.test(PANEL_SRC)
    && !/\bfetch\(/.test(PANEL_SRC) && !/\.\.\/\.\.\/server\//.test(PANEL_SRC),
    { hasFetch: /\bfetch\(/.test(PANEL_SRC) });
  ok('S-12 二次确认全部走 askConfirm，不用 Electron 里不可靠的原生 confirm/prompt',
    /askConfirm/.test(PANEL_SRC) && !/window\.(confirm|prompt|alert)/.test(PANEL_SRC));
  // 界面要素不能只对文案：每个要素都配一条「接线在不在」的行为断言（判据 3，与 S-13b/S-13c 同一口径）。
  // 这些短语都是 JSX 内联字面量、产品侧没有导出常量可取（清单见 T02293 报告），
  // 所以字面侧只能继续对源文本，靠行为侧 + S-13z 的破行为反证兜住：措辞变了红因写「字面锚点失配（行为在）」，
  // 接线掉了红因写「行为失守」，两者不会混在同一条红里。
  const ui: Array<[name: string, phrase: string, wire: (code: string) => boolean]> = [
    ['行内编辑三列', 'type="number"', (c) => /POINT_FIELDS\.map\(\(f\) => \(/.test(c)
      && /onChange=\{\(e\) => setDraft\(\{ planId: r\.planId, field: f, value: e\.target\.value \}\)\}/.test(c)
      && /onBlur=\{\(\) => void commitDraft\(draft\)\}/.test(c)],
    ['0.5 步进', 'step={0.5}', (c) => Number(/step=\{([\d.]+)\}\s+min=\{0\}/.exec(c)?.[1] ?? Number.NaN) === GRID_STEP],
    ['撤销提示（§5.3 原文口径）', '行 · 撤销', (c) => /onClick=\{\(\) => void undoLast\(\)\}/.test(c)
      && /, w\.written/.test(c) && /\{last\.count\}/.test(c)],
    ['只看未复核筛选', '只看未复核', (c) => /onlyUnreviewed && r\.source === 'manual'/.test(c)
      && /onChange=\{\(e\) => setOnlyUnreviewed\(e\.target\.checked\)\}/.test(c)],
    ['批量工具条', 'aria-label="估算批量填充工具条"', (c) => /role="toolbar"/.test(c)
      && /batchRuleKeys\.map\(\(rule\) => \(/.test(c)],
    ['底部行内错误条', 'aria-label="行内录入错误提示"', (c) => /role="alert"/.test(c)
      && /Object\.entries\(rowErrors\)\.map/.test(c) && /setRowErrors/.test(c)],
    ['脱离行显式清理入口', '清理脱离行', (c) => /onClick=\{\(\) => void cleanupDetached\(\)\}/.test(c)
      && /estimatesApi\.listDetached\(projectId\)/.test(c)],
  ];
  const miss = ui.filter(([, s]) => !PANEL_SRC.includes(s)).map(([n]) => n);
  ok(`S-13 §5.3/§5.2 承诺的界面要素全部存在（${ui.length} 项）`, miss.length === 0, miss);
  for (const [name, phrase, wire] of ui) {
    okPair(ok, `S-13w ${name}：接线真的挂着（行为侧）+ 要素文案在面板里（字面侧）`,
      () => wire(CODE), () => PANEL_SRC.includes(phrase), () => ({ 短语: phrase }));
  }
  // 反证（判据 4）：只抹接线、不动文案，同一条判定函数必须判假；
  // 否则行为侧读不出功能变化，S-13w 就退化成第二次文案对账（真机走查抓到过的「按钮有、onClick 没挂」照旧放行）。
  const breakers: Array<[string, (c: string) => string]> = [
    ['行内编辑三列', (c) => c.replace(/onBlur=\{\(\) => void commitDraft\(draft\)\}/g, '')],
    ['0.5 步进', (c) => c.replace(/step=\{0\.5\}/g, 'step={0.1}')],
    ['撤销提示（§5.3 原文口径）', (c) => c.replace(/onClick=\{\(\) => void undoLast\(\)\}/g, '')],
    ['只看未复核筛选', (c) => c.replace(/onlyUnreviewed && r\.source === 'manual'/g, '')],
    ['批量工具条', (c) => c.replace(/role="toolbar"/g, '')],
    ['底部行内错误条', (c) => c.replace(/Object\.entries\(rowErrors\)\.map/g, '')],
    ['脱离行显式清理入口', (c) => c.replace(/onClick=\{\(\) => void cleanupDetached\(\)\}/g, '')],
  ];
  const toothless: string[] = [];
  for (const [name, breakIt] of breakers) {
    const item = ui.find(([n]) => n === name);
    if (!item) { toothless.push(`反证缺判定函数：${name}`); continue; }
    if (item[2](breakIt(CODE)) === true) toothless.push(`${name}：抹掉接线后行为侧仍判真（该断言无判别力）`);
    if (!PANEL_SRC.includes(item[1])) toothless.push(`${name}：反证过程破坏了文案侧，字面短语反查不到了`);
  }
  ok('S-13z 反证：七项界面要素的行为侧都有牙（只破坏行为、短语仍在，判定必须翻假）', toothless.length === 0, toothless);
  // 反证 · 配对器语义（判据 4）：「短语确实在源码里、但行为没有」必须判红且红因指行为。
  {
    const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    okPair((name, cond, extra) => spy.push({ name, cond, extra }), '伪造件：文案在、筛选不接线',
      () => false, () => PANEL_SRC.includes('只看未复核'));
    ok('S-13x 反证：字面锚点命中而行为缺失时配对器判红，红因写「行为失守」（绿不是文案给的）',
      spy.length === 1 && spy[0].cond === false && String((spy[0].extra as any)?.红因 ?? '').includes('行为失守'), spy);
  }
  // 真机走查抓到过的问题：三个规则按钮若不把 `onlyRule` 传给接口，就只有文案不同、行为全是「服务端自动择档」，
  // 面板却宣称「不属于该档的行整行跳过」。断言只看代码体（头部注释里也写了 onlyRule）。
  ok('S-13b 三个规则按钮各自收口档位：runBatch 把 onlyRule 传给预览与写入两个调用',
    /onlyRule:\s*mode/.test(CODE) && (CODE.match(/batchDerive\(/g) ?? []).length >= 2,
    /onlyRule[^,\n]*/.exec(CODE)?.[0]);
  // 真机走查抓到的另一类问题：按钮渲染出来、文案对得上，但没挂 onClick——数据层断言永远看不见它。
  ok('S-13c 规则按钮真的接线了（onClick 调 runBatch，不是只有样子的死按钮）',
    /onClick=\{\(\) => void runBatch\(rule\)\}/.test(CODE));
  ok('S-14 API 层不含任何三点运算（只有 toGrid 一处网格镜像；E/σ/汇总仍在服务端）',
    !/\/\s*6\b/.test(API_SRC) && !/sigma\s*\(/.test(API_SRC) && /export function toGrid/.test(API_SRC));
}

console.log('\n=== G 段：单源词干改名模拟（T02293 判据 1/3/4·同进程，必须在 REST 实例启动前） ===');
{
  /**
   * 改名模拟：REST 那条腿在另一个进程里，门改不动它的常量——所以这一支走**同进程的产品路径**
   * （`pointsError` 与 `EstimateService` 的各写入口都能直达），把词干改成 `ZZZ-<key>` 后用同一入参
   * 再触发一次，要求五件事全部成立：照样拒绝、文案随单源表移动、旧词干零残留、还原逐字符相同、零副作用。
   * 任一条不成立即说明该文案在某层留了第二份抄本（或校验本身是按字面量写的）。
   */
  const ERR_TABLE = ESTIMATE_ERRORS as unknown as Record<string, string>;
  const LABEL_TABLE = ESTIMATE_POINT_LABELS as unknown as Record<string, string>;
  const estIds = () => (db.prepare('SELECT id FROM estimate_items').all() as Array<{ id: string }>)
    .map((r) => r.id).sort().join(',');
  const baselineIds = estIds();
  const full = { optimistic: 1, likely: 1, pessimistic: 1 };
  // R-04/R-05/R-05b 三条用同一组原值（pl-dur 此时是 5.5/6/9.5），改名模拟也照这组值触达，
  // 这样「门里对的词干」和「R 段服务端回的文案」是同一条代码路径产出的。
  const cases: Array<{ table: Record<string, string>; key: string; title: string; run: () => string }> = [
    { table: ERR_TABLE, key: 'ordering', title: '三点顺序 O>M', run: () => pointsError(12, 6, 9.5) ?? '' },
    { table: ERR_TABLE, key: 'ordering', title: '三点顺序 M>P', run: () => pointsError(1, 5, 2) ?? '' },
    { table: ERR_TABLE, key: 'notNumber', title: '三点非数字', run: () => pointsError(Number.NaN, 6, 9.5) ?? '' },
    { table: ERR_TABLE, key: 'negative', title: '三点为负', run: () => pointsError(5.5, -1, 9.5) ?? '' },
    { table: LABEL_TABLE, key: 'optimistic', title: '点值标签（乐观）', run: () => pointsError(Number.NaN, 1, 1) ?? '' },
    { table: LABEL_TABLE, key: 'likely', title: '点值标签（最可能）', run: () => pointsError(1, 5, 2) ?? '' },
    { table: LABEL_TABLE, key: 'pessimistic', title: '点值标签（悲观）', run: () => pointsError(1, 1, 0) ?? '' },
    { table: ERR_TABLE, key: 'unknownPhase', title: '未知阶段', run: () => fire(() => EstimateService.upsert(PID, 'pl-dur', { ...full, phase: 'qa' as never })) },
    { table: ERR_TABLE, key: 'planMissing', title: '计划不存在', run: () => fire(() => EstimateService.upsert(PID, 'pl-nope-e4b', full)) },
    { table: ERR_TABLE, key: 'pointsRequired', title: '三点必填（建议行首次落库）', run: () => fire(() => EstimateService.upsert(PID, 'pl-cx', { optimistic: 1 } as never)) },
    { table: ERR_TABLE, key: 'batchEmpty', title: '批量内容为空', run: () => fire(() => EstimateService.upsertBatch(PID, [])) },
    { table: ERR_TABLE, key: 'nothingToClean', title: '清理未选行', run: () => fire(() => EstimateService.removeDetached(PID, [])) },
    { table: ERR_TABLE, key: 'projectIdRequired', title: 'projectId 缺失', run: () => fire(() => EstimateService.listByProject('')) },
    { table: ERR_TABLE, key: 'projectNotFound', title: '项目不存在', run: () => fire(() => EstimateService.listByProject('no-such-project-e4b')) },
  ];
  // 跨项目那一支要一个「别人的项目」：临时建、跑完删，不给 R 段留额外读数
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run('p-e4b-x', 'T02040-改名模拟用他项目', '', T, T);
  cases.push({
    table: ERR_TABLE, key: 'planNotInProject', title: '计划跨项目',
    run: () => fire(() => EstimateService.upsert('p-e4b-x', 'pl-dur', full)),
  });
  // 收口里程碑只读（§7 闸门）：本门 R 段不碰它，但同一张词干表得一并自证——临时收口 ms-1，跑完还原
  db.prepare("UPDATE plan_tasks SET status = 'done', progress = 100 WHERE id = 'ms-1'").run();
  cases.push({
    table: ERR_TABLE, key: 'milestoneReadonly', title: '收口里程碑只读',
    run: () => fire(() => EstimateService.upsert(PID, 'ms-1', full)),
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
      for (const id of estIds().split(',').filter((x) => !baselineIds.split(',').includes(x))) {
        db.prepare('DELETE FROM estimate_items WHERE id = ?').run(id);
      }
    }
  }
  db.prepare("UPDATE plan_tasks SET status = 'todo', progress = 0 WHERE id = 'ms-1'").run();
  db.prepare('DELETE FROM projects WHERE id = ?').run('p-e4b-x');
  ok('G-01 词干改名模拟全项通过（拒绝在、文案随单源移动、旧词干零残留、还原逐字符相同、零副作用）',
    zj.length === 0, zj);
  ok('G-02 改名模拟覆盖的词干数足够（本门 ≥ 14 支：三点判据 + 各写入口 + 归属校验）',
    cases.length >= 14, { 支数: cases.length, 去重词干: new Set(cases.map((c) => c.key)).size });
  // 反证：改名期间**合法入参必须照旧通过**。若把词干改名后连合法值都开始报错，说明校验是按字面量写的
  // （文案反过来决定了行为），那才是判据 1 最怕的形态。
  ok('G-03 改名期间合法值不受影响（三点判据不是按字面量写的，校验不会因文案改造反向变严）', (() => {
    const orig = ESTIMATE_ERRORS.ordering;
    try {
      ERR_TABLE.ordering = 'ZZZ-ordering';
      return pointsError(1, 2, 3) === null && pointsError(0, 0, 0) === null;
    } finally {
      ERR_TABLE.ordering = orig;
    }
  })(), { ordering: ESTIMATE_ERRORS.ordering });
  ok('G-04 三点判据本身零副作用（改名模拟与纯判据都不会写库，estimate_items 集合与进入 G 段时一致）',
    estIds() === baselineIds, { 现在: estIds(), 基线: baselineIds });
}

console.log('\n=== R 段：按面板真实写路径打 REST（隔离实例） ===');
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
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as Record<string, any> };
}
const qs = `projectId=${PID}`;
const rowOf = async (planId: string): Promise<Record<string, any> | undefined> => {
  const r = await api('GET', `/estimates?${qs}`);
  return (r.json.items as Array<Record<string, any>>).find((i) => i.plan_id === planId);
};

if (!(await waitForServer())) {
  ok('R-00 隔离服务启动', false, serverLog.join('').slice(-400));
  child.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
ok('R-00 隔离服务启动（临时端口 + 临时库）', true);

// R1 参数面：批量按钮名单与跳过原因枚举由服务端下发（面板不再各写一份）
{
  const meta = await api('GET', '/estimates/meta');
  ok('R-01 /meta 暴露 deriveRules 与 deriveSkips（含 offRule）',
    meta.status === 200 && JSON.stringify(meta.json.deriveRules) === JSON.stringify(DERIVE_RULES)
    && (meta.json.deriveSkips as string[]).includes('offRule'), { status: meta.status, skips: meta.json.deriveSkips });
}

// R2 PATCH 单字段：其余两点沿用原值，规则行被人工改过即转 manual
{
  const r = await api('PATCH', `/estimates/pl-dur?${qs}`, { likely: 6 });
  const item = r.json.item as Record<string, any>;
  ok('R-02 PATCH 只改 M：O/P 沿用原值（5.5/9.5 不动）、source 由 rule 转 manual（§4.6 复核率口径）',
    r.status === 200 && item?.likely === 6 && item?.optimistic === 5.5 && item?.pessimistic === 9.5 && item?.source === 'manual', item);
}

// R3 建议行首次落库：三点 + 阶段一次给全（面板 commitDraft 的新行分支）
{
  const r = await api('PATCH', `/estimates/pl-cx?${qs}`, { optimistic: 3, likely: 3.5, pessimistic: 5.6, phase: 'req' });
  const item = r.json.item as Record<string, any>;
  ok('R-03 无估算行的计划 PATCH 三点即建行（阶段落 req，不是恒缺省 dev）',
    r.status === 200 && item?.phase === 'req' && item?.likely === 3.5 && item?.source === 'manual', item);
  const row = await rowOf('pl-cx');
  ok('R-03b 建行后可从 GET 明细读回（面板重取就是按这条路径刷新 E/σ）', row?.plan_id === 'pl-cx' && row?.optimistic === 3, row);
}

// R4/R5 不合格值由服务端拒且零写入
{
  const base = await rowOf('pl-dur');
  const bad = await api('PATCH', `/estimates/pl-dur?${qs}`, { optimistic: 12 });
  // 零副作用的读数必须在**合法对照调用之前**取：对照自己也写一次，取晚了就把对照的写入算到坏请求头上
  const afterBad = await rowOf('pl-dur');
  rejectedPair('R-04 O>M 被服务端拒（400 + 文案点名两个值，前端不另判一遍）', bad,
    [ESTIMATE_ERRORS.ordering, ESTIMATE_POINT_LABELS.optimistic, ESTIMATE_POINT_LABELS.likely],
    () => afterBad?.optimistic === base?.optimistic && afterBad?.likely === base?.likely);
  sameSource.push({
    label: 'R-04', server: String(bad.json.error ?? ''),
    mine: pointsError(12, base?.likely ?? Number.NaN, base?.pessimistic ?? Number.NaN) ?? '',
  });
  const after = await rowOf('pl-dur');
  ok('R-04b 被拒后原值不动（O 仍 5.5、M 仍 6）', after?.optimistic === 5.5 && after?.likely === 6, after);
  const ctrlOrder = await api('PATCH', `/estimates/pl-dur?${qs}`, { pessimistic: 9.5 });
  const ctrlRow = await rowOf('pl-dur');
  ok('R-04c 合法对照仍成功：同一 PATCH 通道写回合法值 200（门不是因为「什么都拒」才绿）',
    ctrlOrder.status === 200 && ctrlRow?.optimistic === 5.5 && ctrlRow?.likely === 6 && ctrlRow?.pessimistic === 9.5,
    { status: ctrlOrder.status, row: ctrlRow });

  const nan = await api('PATCH', `/estimates/pl-dur?${qs}`, { optimistic: 'abc' });
  const afterNan = await rowOf('pl-dur');
  rejectedPair('R-05 非数字值由服务端判「必须是数字」（面板把输入框原值直接送出，不预筛）', nan,
    [ESTIMATE_ERRORS.notNumber, ESTIMATE_POINT_LABELS.optimistic],
    () => afterNan?.optimistic === base?.optimistic && afterNan?.likely === base?.likely);
  sameSource.push({
    label: 'R-05', server: String(nan.json.error ?? ''),
    mine: pointsError(Number.NaN, base?.likely ?? Number.NaN, base?.pessimistic ?? Number.NaN) ?? '',
  });
  const ctrlNan = await api('PATCH', `/estimates/pl-dur?${qs}`, { optimistic: 5.5 });
  ok('R-05c 合法数字走同一通道即落库 200（拒的是这一枚值，不是这条写路径）',
    ctrlNan.status === 200 && (await rowOf('pl-dur'))?.optimistic === 5.5, ctrlNan.json);

  const neg = await api('PATCH', `/estimates/pl-dur?${qs}`, { likely: -1 });
  const afterNeg = await rowOf('pl-dur');
  rejectedPair('R-05b 负值同样被拒（不能为负）', neg,
    [ESTIMATE_ERRORS.negative, ESTIMATE_POINT_LABELS.likely],
    () => afterNeg?.optimistic === base?.optimistic && afterNeg?.likely === base?.likely && afterNeg?.pessimistic === base?.pessimistic);
  sameSource.push({
    label: 'R-05b', server: String(neg.json.error ?? ''),
    mine: pointsError(base?.optimistic ?? Number.NaN, -1, base?.pessimistic ?? Number.NaN) ?? '',
  });
  const ctrlNeg = await api('PATCH', `/estimates/pl-dur?${qs}`, { likely: 6 });
  ok('R-05d 0 与负数被拒、正常 M 值仍写得住（合法对照成功，闸门没有全关）',
    ctrlNeg.status === 200 && (await rowOf('pl-dur'))?.likely === 6, ctrlNeg.json);
}

// R6 batch mode=set：任一行不合格 → 整体零写入 + 行级错误
{
  const beforeCase = await rowOf('pl-case');
  const r = await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set',
    items: [
      { planId: 'pl-case', optimistic: 2, likely: 3, pessimistic: 4, source: 'manual' },
      { planId: 'pl-cx2', optimistic: 9, likely: 1, pessimistic: 2 },
    ],
  });
  ok('R-06 批量 set 有一行不合格 → written=0 且回传行级错误（与 Excel 导入同口径）',
    r.status === 200 && r.json.written === 0 && (r.json.errors as unknown[]).length === 1
    && (r.json.errors as Array<Record<string, any>>)[0].planId === 'pl-cx2', r.json);
  const afterCase = await rowOf('pl-case');
  ok('R-06b 零写入是真的零写入：合格那行的原值一字未改',
    afterCase?.optimistic === beforeCase?.optimistic && afterCase?.likely === beforeCase?.likely, { beforeCase, afterCase });
  // 行级错误的文案同样只认单源词干；合法对照就是紧接其后的 R-07（同一条批量通道写入 2 行）。
  const rowMsg = String((r.json.errors as Array<Record<string, any>>)[0]?.message ?? '');
  sameSource.push({ label: 'R-06', server: rowMsg, mine: pointsError(9, 1, 2) ?? '' });
  okPair(ok, 'R-06c 批量行级错误文案与三点判据同源（词干取自 ESTIMATE_ERRORS，门里不抄整句）',
    () => r.json.written === 0 && rowMsg.length > 0 && afterCase?.likely === beforeCase?.likely,
    () => rowMsg.includes(ESTIMATE_ERRORS.ordering),
    () => ({ message: rowMsg.slice(0, 140) }));
}

// R7 batch mode=set 全合格：显式 source 被保留（撤销回写还原原来源的依据）
{
  const r = await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set',
    items: [
      { planId: 'pl-case', optimistic: 2, likely: 3, pessimistic: 4, source: 'rule' },
      { planId: 'pl-cx2', optimistic: 1.5, likely: 2, pessimistic: 3.2, source: 'rule' },
    ],
  });
  ok('R-07 批量 set 全合格 → 两行都写入，且显式 source=rule 不被改成 manual',
    r.json.written === 2 && (r.json.errors as unknown[]).length === 0, r.json);
  const row = await rowOf('pl-case');
  ok('R-07b 回读三点=写入值、来源仍 rule（面板快照里的 source 就是靠这条通道还原）',
    row?.likely === 3 && row?.source === 'rule', row);
}

// R8/R9/R10 批量推导 onlyRule：过滤不是强制改算式
{
  const beforeDur = await rowOf('pl-dur');
  const beforeMan = await rowOf('pl-man');
  const planIds = ['pl-cx2', 'pl-case', 'pl-dur', 'pl-man'];
  const preview = await api('POST', '/estimates/batch', { projectId: PID, mode: 'derive', planIds, scope: 'all', onlyRule: 'complexity', dryRun: true });
  const skipped = preview.json.skipped as Array<{ planId: string; skip: string }>;
  ok('R-08 dryRun 预览：只有自然择档为 complexity 的行可写，其余整行跳过（offRule）',
    preview.status === 200 && preview.json.onlyRule === 'complexity' && preview.json.writableCount === 1
    && (preview.json.items as Array<Record<string, any>>).find((i) => i.planId === 'pl-cx2')?.writable === true,
    { writableCount: preview.json.writableCount, skipped });
  ok('R-09 跳过原因可解释：用例档行=offRule、人工行=manual（批量通道仍守 §4.6 红线二，不覆盖人工值）',
    skipped.some((s) => s.planId === 'pl-case' && s.skip === 'offRule')
    && skipped.some((s) => s.planId === 'pl-man' && s.skip === 'manual'), skipped);

  const write = await api('POST', '/estimates/batch', { projectId: PID, mode: 'derive', planIds, scope: 'all', onlyRule: 'complexity' });
  ok('R-10 预览行数 = 写入行数（按钮文案与落库不打架，§10-5）',
    write.json.written === preview.json.writableCount && write.json.written === 1
    && JSON.stringify(write.json.writtenPlanIds) === JSON.stringify(['pl-cx2']),
    { preview: preview.json.writableCount, written: write.json.written, ids: write.json.writtenPlanIds });
  const cx2 = await rowOf('pl-cx2');
  const ratio = (await api('GET', `/estimates?${qs}`)).json.params.config.ruleRatio as { oMul: number; pMul: number };
  const baseM = COMPLEXITY_BASE_DAYS[2];
  ok('R-10b 写入的三点就是服务端 complexity 档基准值 × 比例配置（面板不参与算，也只可能改动这一行）',
    cx2?.likely === srvToGrid(baseM) && cx2?.optimistic === srvToGrid(baseM * ratio.oMul)
    && cx2?.pessimistic === srvToGrid(baseM * ratio.pMul) && cx2?.source === 'rule', { cx2, ratio, baseM });
  const afterDur = await rowOf('pl-dur');
  const afterMan = await rowOf('pl-man');
  ok('R-10c offRule/manual 行分毫未动（没有「换个档硬凑」的假数据，也没有洗掉人工值）',
    afterDur?.likely === beforeDur?.likely && afterDur?.optimistic === beforeDur?.optimistic
    && afterMan?.likely === beforeMan?.likely && afterMan?.source === 'manual',
    { beforeDur, afterDur, beforeMan, afterMan });

  // 非法档名的「零副作用」读数取在合法对照之前，且对照用 dryRun（不写行，只证这条通道没被整体关掉）
  const cntBefore = ((await api('GET', `/estimates?${qs}`)).json.items as unknown[]).length;
  const bogus = await api('POST', '/estimates/batch', { projectId: PID, mode: 'derive', onlyRule: 'bogus', dryRun: true });
  const cntAfter = ((await api('GET', `/estimates?${qs}`)).json.items as unknown[]).length;
  const okRule = await api('POST', '/estimates/batch', { projectId: PID, mode: 'derive', onlyRule: 'complexity', dryRun: true });
  rejectedPair('R-10d 档位名非法直接 400（不让拼错的档名静默退化成「全档自动择」）', bogus,
    ESTIMATE_ERRORS.unknownDeriveRule,
    // 行为侧：拒绝后明细行数分毫未动，且只差一个合法档名的同端点请求照常出预览
    () => cntAfter === cntBefore && okRule.status === 200 && Array.isArray(okRule.json.items));
  ok('R-10e 合法档名的预览照常出（对照证明 R-10d 的 400 不是「什么都拒」换来的）',
    okRule.status === 200 && (okRule.json.skipped as unknown[]).length > 0, { status: okRule.status });
  // 这一支的整句由路由层拼装（`未知推导档位：<值>（可用 <档名清单>）`），门进程够不到那个私有函数，
  // 所以不进 sameSource 逐字符队列，改由 H-04 对它的**两个单源部件**（词干 + DERIVE_RULES 清单）取证。
  bogusRouteParts = { server: String(bogus.json.error ?? ''), bad: 'bogus', rules: DERIVE_RULES.join(' / ') };
}

// R11 撤销的两条通道：快照回写（含 source）/ 删除本次新建行
{
  const snapshot = { planId: 'pl-case', optimistic: 2, likely: 3, pessimistic: 4, source: 'rule', phase: 'design' };
  const dirty = await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set',
    items: [{ planId: 'pl-case', optimistic: 5, likely: 6, pessimistic: 7, source: 'manual' }],
  });
  ok('R-11 撤销前先制造「被批量改过」的行（统一值模式会转 manual）',
    dirty.json.written === 1 && (await rowOf('pl-case'))?.source === 'manual', dirty.json);
  const undo = await api('POST', '/estimates/batch', { projectId: PID, mode: 'set', items: [snapshot] });
  const row = await rowOf('pl-case');
  ok('R-11b 撤销=按写入前快照回写，三点与 phase 还原，source 也回到 rule（不是被洗成 manual）',
    undo.json.written === 1 && row?.optimistic === 2 && row?.likely === 3 && row?.pessimistic === 4
    && row?.source === 'rule' && row?.phase === 'design', row);
  const del = await api('DELETE', `/estimates/pl-cx2?${qs}`);
  ok('R-11c 撤销「本次新建的行」走删除（原态无估算行，删除才等价于回滚）',
    del.status === 200 && del.json.removed === true && (await rowOf('pl-cx2')) === undefined, del.json);
}

// R12 脱离计划行的显式清理（§7：清理是显式手动操作，不进撤销栈）
{
  const list = await api('GET', `/estimates/detach?${qs}`);
  const ids = (list.json.rows as Array<Record<string, any>>).map((r) => r.id);
  ok('R-12 GET /detach 列出脱离行（INNER JOIN 看不见的那批，单开反查通道）',
    list.status === 200 && ids.length === 1 && (list.json.rows as Array<Record<string, any>>)[0].plan_id === 'pl-gone', list.json);
  const pre = await api('GET', `/estimates?${qs}`);
  ok('R-12b GET /estimates 的 checks.detached 与反查同源（面板告警条读数不是第二套口径）',
    (pre.json.checks.detached as number) === 1, { detached: pre.json.checks.detached });
  const clean = await api('POST', '/estimates/detach/cleanup', { projectId: PID, ids: [...ids, 'not-exist-id'] });
  ok('R-12c 清理只删确属该项目且仍脱离的行，不存在的 id 如实跳过（removed=1 而不是按入参长度报数）',
    clean.json.removed === 1, clean.json);
  const post = await api('GET', `/estimates?${qs}`);
  ok('R-12d 清理后脱离计数归零，估算明细未受影响',
    (post.json.checks.detached as number) === 0 && (post.json.items as unknown[]).length >= 3,
    { detached: post.json.checks.detached, items: (post.json.items as unknown[]).length });
}

// R13 汇总随写路径重算（面板零计算的正面证据：改一行，服务端 summary 就跟着变）
{
  const before = (await api('GET', `/estimates?${qs}`)).json.summary.directManDays as { expected: number };
  await api('PATCH', `/estimates/pl-dur?${qs}`, { pessimistic: 20 });
  const after = (await api('GET', `/estimates?${qs}`)).json.summary.directManDays as { expected: number };
  ok('R-13 行内改 M 后 ΣE 由服务端重算并随 GET 下发（面板只是把新读数搬上屏）',
    after.expected > before.expected && Number.isFinite(after.expected), { before, after });
}

const logText = serverLog.join('');
ok('R-14 服务日志无 estimates 写路径相关异常',
  !/estimates[\s\S]{0,160}(Error|异常|unhandled)/i.test(logText) && !/UnhandledPromiseRejection/.test(logText),
  logText.split('\n').filter((l) => /error|异常/i.test(l)).slice(0, 3));

console.log('\n=== H 段：跨进程同源自证 + 配对器反证（T02293 判据 4） ===');
{
  // 上面每条 400 的文案出自**隔离服务进程**，门进程只持有单源词干表。
  // 若门抄的是整句当下措辞，产品改词后本应一起红的两侧会分成「行为在、锚点失配」——配对器能分辨，
  // 但更彻底的做法是直接证明两边读的是同一张表：H-01 逐条词干命中，H-03 同入参逐字符相同。
  const stems = Object.values(ESTIMATE_ERRORS);
  const h1Miss = rest400.filter((r) => !stems.some((s) => r.error.includes(s)));
  ok('H-01 服务端 400 原文逐条命中门进程单源词干（≥4 条全中）',
    rest400.length >= 4 && h1Miss.length === 0, { 条数: rest400.length, 未命中: h1Miss.map((r) => r.label) });
  ok('H-02 假词干（改名模拟的 ZZZ- 前缀 + 本门不存在的措辞）对全部 400 原文零命中（H-01 不是恒真式）',
    rest400.length > 0 && rest400.every((r) => !r.error.includes('ZZZ-') && !r.error.includes('未知天晓得')),
    rest400.map((r) => r.error.slice(0, 40)));
  const h3Bad = sameSource.filter((x) => x.server !== x.mine);
  ok('H-03 同一入参在服务端与门进程直调产品函数产出的文案逐字符相同（REST 400 体是裸 { error }，无信封要剥）',
    sameSource.length >= 4 && h3Bad.length === 0,
    sameSource.map((x) => ({ ...x, 相同: x.server === x.mine })));
  ok('H-04 路由层拼装的档名错误也由两个单源部件解释得通（词干开头 + 内嵌 DERIVE_RULES 清单）',
    !!bogusRouteParts && bogusRouteParts.server.startsWith(ESTIMATE_ERRORS.unknownDeriveRule)
    && bogusRouteParts.server.includes(bogusRouteParts.bad) && bogusRouteParts.server.includes(bogusRouteParts.rules),
    bogusRouteParts);

  // 反证一 · 配对器三态语义：三种输入落出三种结果且红因可区分——配对器若退化成「只看字面锚点」，
  // 下面必有一条红，即本组自身带判别力。
  const rec: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  const probeOk = (name: string, cond: boolean, extra?: unknown) => { rec.push({ name, cond, extra }); };
  okPair(probeOk, 'A 行为失守', () => false, () => true);
  okPair(probeOk, 'B 行为在、锚点失配', () => true, () => false);
  okPair(probeOk, 'C 双绿', () => true, () => true);
  const why = (i: number): string => String((rec[i]?.extra as any)?.红因 ?? '');
  ok('H-05 okPair 三态语义：行为失守判红且红因指行为、行为在而锚点失配判红且红因指锚点、双绿才 PASS',
    rec.length === 3 && rec[0].cond === false && why(0).includes('行为失守')
    && rec[1].cond === false && why(1).includes('字面锚点失配') && rec[2].cond === true, rec);

  // 反证二 · 伪造件：文案里就放着服务端那句原话，但请求实际**没被拒**（200）——配对器必须判红。
  // 这一支钉的是「R-04/R-05 的绿不是文案给的」：只看 `includes(词干)` 的门会照样放行这份假件。
  {
    const fakeMsg = pointsError(12, 6, 9.5) ?? '';
    const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    okPair((name, cond, extra) => spy.push({ name, cond, extra }), '伪造件：三点被拒了但其实写进去',
      () => false, () => String(fakeMsg).includes(ESTIMATE_ERRORS.ordering));
    ok('H-06 反证：字面词干原样出现在「没有拒绝」的响应里，配对器仍判红（红因指行为）',
      spy.length === 1 && spy[0].cond === false && String((spy[0].extra as any)?.红因 ?? '').includes('行为失守')
      && fakeMsg.includes(ESTIMATE_ERRORS.ordering), spy);
  }
  // 反证三 · 「把什么都拒掉」换不来绿：坏请求 400 + 文案对，但合法对照也 400 时配对器必须判红。
  {
    const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    const label = '伪造件：闸门全关（坏请求被拒、合法对照也被拒）';
    const fakeBad = { status: 400, json: { error: pointsError(12, 6, 9.5) ?? '' } };
    okPair((name, cond, extra) => spy.push({ name, cond, extra }), label,
      () => fakeBad.status === 400 && false, // 行为侧：合法对照失败 → 整体行为不成立
      () => String(fakeBad.json.error).includes(ESTIMATE_ERRORS.ordering));
    ok('H-07 反证：合法对照被一并拒掉时配对器判红（本门的绿必须建立在「坏的被拒、好的仍能过」两侧都成立上）',
      spy.length === 1 && spy[0].cond === false && String((spy[0].extra as any)?.红因 ?? '').includes('行为失守'), spy);
  }
}

child.kill();
await new Promise((r) => setTimeout(r, 600));
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
