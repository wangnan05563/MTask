/**
 * T02046（PRD-估算视图 §7 + E9「变更影响分析」）验证脚本：偏差徽标 / 收口只读 / 重导提示 / 影响试算。
 *
 * 用法（Node 版本必须与 node_modules/better-sqlite3 的预编译 ABI 对齐；与 E4a/E4b 同写法）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02046-estimate-e9.mts
 *
 * 分段结构（沿用 E4b/E6 的取证范式）：
 *   S 段（同进程·纯函数 + 源码守卫）：
 *     1) `countWorkdaysBetween` 的**算术改写**与逐日推进参照实现全等（含节假日/加班日/同日期两集
 *        命中/长跨度）——§7 剩余排期是逐行调用的，成本不能再跟日期跨度挂钩；
 *     2) `rowDriftCheck` 的阈值边界、未估算行、过期排期、只读判定（与 `EstimateService.isClosedMilestone`
 *        同语义 = 写路径闸门与面板读数同一份定义）；
 *     3) 红线守卫：面板源码不得出现 1.5 / 0.67 字面量与任何比值/剩余排期算式（判定与阈值只在服务端）。
 *   R 段（隔离实例·REST）：
 *     `GET /api/estimates` 每行 drift 与 checks.drift 计数同源；已收口里程碑的 PATCH/DELETE/batch
 *     三条写通道一律 400 且零写入，显式 `unlock` 才放行；`POST /what-if` 前后对比 + `written=0`
 *     且改完参数面读数不动（真·不落库）；试算的参数校验与 `PUT /params` 同一把尺子；
 *     `changedSinceExport` 无快照/有快照/改计划/改估算/导出后归零的完整一圈；
 *     `holidays` 表真值进日历（插一条放假日 → 该行剩余排期少 1）。
 *   G 段（同进程·T02293 判据 1/3/4，REST 起实例前跑）：
 *     改名模拟——把 `ESTIMATE_ERRORS`/`ESTIMATE_POINT_LABELS` 的词干逐支改成 `ZZZ-<key>` 后用同一入参
 *     再触发同一校验（§7 只读闸门、参数上下限、三点判据、导出词表都能直达），要求「照样拒绝、文案随单源表
 *     移动、旧词干零残留、还原逐字符相同、零副作用」；顺带把 R/X 段要逐字符对账的产品文案在同进程取一份。
 *   X 段（隔离实例·导出件的产物事实）：xlsx/pdf 不看文案看字节与内容——PK/%PDF 魔数、exceljs 回读
 *     三张 sheet 的行数与 plan_id 集合、客户版不产明细 sheet、快照 payload 的汇总与当刻 GET 逐字相同、
 *     件名可由产品自己的 `estimateArtifactName` 逐字符复现（并带「换受众/换一秒即不同」的反证）。
 *   H 段（跨进程·判据 4）：R/X 段登记的每条拒绝原文都要能用门进程的单源词干解释，同入参直调产品函数
 *     得到的文案与服务端逐字符相同（REST 400 体是裸 `{ error }`，没有信封要剥）；末尾三条反证钉住
 *     配对器的判别力（字面在、行为无 ⇒ 红；合法对照一并被拒 ⇒ 红）。
 *
 * 隔离纪律（skill 红线 8）：库与端口都是临时的，不碰生产数据目录，跑完 kill + 回收临时目录。
 * 真机 UI 走查（§7 徽标/解锁/试算/重导提示）不在本脚本内，见 scripts/verify-t02046-ui.mjs。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02046-e9-'));
const PORT = Number(process.env.T02046_PORT ?? 39947);
process.env.MTask_DATA_DIR = DATA_DIR;

const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
const { isClosedMilestone, pointsError, ESTIMATE_ERRORS, ESTIMATE_POINT_LABELS, EstimateService, ESTIMATE_META }
  = await import('../server/src/services/EstimateService.ts');
const { ESTIMATE_FILE_BASE, ESTIMATE_FILE_CLIENT_MARK }
  = await import('../server/src/services/estimateCopy.ts');
// 路由层的导出词表解析器与件名拼装器是同进程可达的单源（`e10` 同写法）：
// X 段的「件名可复现」与 H 段的「同入参逐字符相同」都靠它们，门里不抄第二份模板串。
const { estimateArtifactName, parseAudience, parseScope, parsePhases }
  = await import('../server/src/routes/estimates.ts');
const { SHEET_MAIN, SHEET_DETAIL, SHEET_PARAMS, ESTIMATE_EXPORT_SCOPES }
  = await import('../server/src/services/estimateExportXlsx.ts');
const {
  rowDriftCheck, DURATION_RATIO_HIGH, DURATION_RATIO_LOW, ESTIMATE_COEF_KEYS, ESTIMATE_COEF_SETTING_KEYS,
  resolveEstimateConfig,
} = await import('../server/src/services/estimate-engine.ts');
const ExcelJSMod: any = await import('exceljs');
const NewWorkbook = (): import('exceljs').Workbook => new (ExcelJSMod.default ?? ExcelJSMod).Workbook();
const loadWb = async (buf: Buffer): Promise<import('exceljs').Workbook> => {
  const wb = NewWorkbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
};
const {
  countWorkdaysBetween, isWorkday, fmtDate, parseYmd, buildCalendar,
} = await import('../server/src/util/workdays.ts');
/** 与 `server/src/util/workdays.ts` 同形状（动态 import 的解构里不能带 `type` 修饰符，故本地重写一份类型） */
type WorkdayCal = { holidays: Set<string>; overtime: Set<string> };

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 260)}` : ''}`);
  }
};
const near = (a: number, b: number, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;
const T = '2026-10-11T00:00:00.000Z';
const PID = 'p-e9';
/** 夹具项目名（门自己写的数据，不是产品文案）：X 段的「件名可复现」按这一份正/反算 */
const PROJ_NAME = 'T02046-变更影响分析';
const PANEL_SRC = readFileSync(join(ROOT, 'web', 'src', 'components', 'EstimatePanel.tsx'), 'utf8');
const API_SRC = readFileSync(join(ROOT, 'web', 'src', 'api', 'estimates.ts'), 'utf8');
const ROUTE_SRC = readFileSync(join(ROOT, 'server', 'src', 'routes', 'estimates.ts'), 'utf8');
/** 把「应当抛错的调用」收成文案（不抛则空串，交给配对器的行为侧判红） */
const fire = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
/**
 * 拒绝类断言的配对器（T02293 判据 3）。
 * 行为侧 = 请求真的被拒（400/行级错误 + 非空文案），调用方再叠两件：
 *   ① 拒绝后**零副作用**的读数（行数/三点值/快照条数）——读数一律取在合法对照调用之前，
 *      否则对照自己那次写入会被算到坏请求头上；
 *   ② 只差一个合法值的对照调用仍然成功——防「把什么都拒掉换字面锚点全绿」（反证见 H-07）。
 * 字面侧 = 文案含产品单源词干（`ESTIMATE_ERRORS`/`ESTIMATE_POINT_LABELS`）；门里不抄整句。
 * 每条原文同时登记进 `restRejects`，供 H 段做跨进程同一性比对。
 */
const restRejects: Array<{ label: string; error: string }> = [];
const rejectedPair = (
  label: string,
  res: { status: number; json: Record<string, any> },
  stems: string | readonly string[],
  extraBehavior?: () => boolean,
  pick?: (json: Record<string, any>) => string,
  // 批量通道的「拒」是 HTTP 200 + `written=0` + 行级错误（部分失败语义），不是 400——
  // 判拒的方式由调用方给，缺省才是「400 才算拒」，避免把行级拒绝误判成放行。
  rejected?: (res: { status: number; json: Record<string, any> }) => boolean,
) => {
  const list = Array.isArray(stems) ? stems : [stems as string];
  const msg = pick ? pick(res.json) : String(res.json?.error ?? '');
  const isRejected = rejected ?? ((r) => r.status === 400);
  if (isRejected(res) || msg.length > 0) restRejects.push({ label, error: msg });
  return okPair(ok, label,
    () => isRejected(res) && msg.length > 0 && (extraBehavior ? extraBehavior() : true),
    () => list.every((s) => msg.includes(s)),
    () => ({ status: res.status, error: msg.slice(0, 150) }));
};
/** 同一入参在门进程直调产品函数得到的文案，与登记的服务端原文配对，由 H-03 逐字符比对 */
const sameSource: Array<{ label: string; server: string; mine: string }> = [];
/**
 * 「未知调节系数」整句里只有**可用档清单**是产品导出的常量（`ESTIMATE_COEF_KEYS`），词干本身没进单源表。
 * 所以这一支不冒充逐字符同源，改登记「三元组」：原文 + 越界键名 + 由常量拼出的可用清单，
 * 由 H-04 验「原文确实点名了越界键、且逐字列出产品自己的系数档」。
 */
let bogusCoefParts: { server: string; bad: string; list: string } | null = null;
/** G 段在同进程取到的产品原文（REST 起实例前），供 R/X 段跨进程逐字符对账 */
const inProc: Record<string, string> = {};

/** 参照实现：§7 之前的逐日推进口径（正确但成本与日期跨度挂钩），只在本脚本里当尺子用 */
function refCount(from: string, to: string, cal: WorkdayCal): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 0;
  if (to < from) return 0;
  let n = 0;
  const d = parseYmd(from);
  for (;;) {
    const cur = fmtDate(d);
    if (cur > to) break;
    if (isWorkday(d, cal)) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

console.log('\n=== S 段：剩余排期/偏差判据的纯函数与红线守卫（同进程·不碰磁盘） ===');

// S-01 算术实现 vs 逐日参照：全周起点 × 0..40 天 × 7 种日历 全等
{
  const cals: Array<[string, WorkdayCal]> = [
    ['空日历', buildCalendar([])],
    ['工作日放假', buildCalendar([{ date: '2026-10-07', kind: 'holiday' }])],
    ['周末放假（本就非工作日）', buildCalendar([{ date: '2026-10-10', kind: 'holiday' }])],
    ['周末加班', buildCalendar([{ date: '2026-10-10', kind: 'overtime' }])],
    ['工作日加班（无假日可减）', buildCalendar([{ date: '2026-10-07', kind: 'overtime' }])],
    ['同日期既假又加班（加班优先）', buildCalendar([
      { date: '2026-10-10', kind: 'holiday' }, { date: '2026-10-10', kind: 'overtime' },
    ])],
    ['跨月长假 + 加班', buildCalendar([
      { date: '2026-10-01', kind: 'holiday' }, { date: '2026-10-02', kind: null },
      { date: '2026-10-03', kind: undefined }, { date: '2026-11-07', kind: 'overtime' },
    ])],
  ];
  const starts = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
  let cases = 0;
  const bad: string[] = [];
  for (const [label, cal] of cals) {
    for (const s of starts) {
      for (let k = 0; k <= 40; k++) {
        const d = parseYmd(s);
        d.setDate(d.getDate() + k);
        const e = fmtDate(d);
        cases += 1;
        if (countWorkdaysBetween(s, e, cal) !== refCount(s, e, cal)) bad.push(`${label} ${s}~${e}`);
      }
    }
  }
  ok(`S-01 剩余排期算术实现与逐日参照全等（${cases} 格：${starts.length} 个周起点 × 0..40 天 × ${cals.length} 种日历）`,
    bad.length === 0, bad.slice(0, 6));
}

// S-02 成本与日期跨度解耦（§7 逐行调用；一条 2099 年的排期不该把请求拖住）
{
  const cal = buildCalendar([{ date: '2030-05-06', kind: 'holiday' }, { date: '2031-05-10', kind: 'overtime' }]);
  const from = '2026-10-12';
  const to = '2099-12-31';
  const ref = refCount(from, to, cal);
  const t0 = Date.now();
  let v = -1;
  for (let i = 0; i < 2000; i++) v = countWorkdaysBetween(from, to, cal);
  const ms = Date.now() - t0;
  ok(`S-02 73 年跨度：值与参照全等（${ref}）且 2000 次调用 ${ms}ms（参照实现单次即需 ${ref > 0 ? Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / 86400000) : 0} 次日推进）`,
    v === ref && ms < 400, { v, ref, ms });
}

// S-03 边界契约：to<from→0、非法→0、单日含两端
{
  const cal = buildCalendar([]);
  ok('S-03 排期已过期（to<from）→ 0 而不是负数（负数会把「E>剩余」算成通过）',
    countWorkdaysBetween('2026-10-20', '2026-10-12', cal) === 0);
  ok('S-03b 非法/空日期 → 0（缺排期由调用方按「无排期」跳过，不凭空造冲突）',
    countWorkdaysBetween('', '2026-10-20', cal) === 0
    && countWorkdaysBetween('2026-10-20', null as unknown as string, cal) === 0
    && countWorkdaysBetween('2026/10/20', '2026-13-45', cal) === 0);
  const mon = countWorkdaysBetween('2026-10-05', '2026-10-05', cal);
  const sat = countWorkdaysBetween('2026-10-10', '2026-10-10', cal);
  ok('S-03c 区间含两端：周一单日=1、周六单日=0', mon === 1 && sat === 0, { mon, sat });
}

// S-04 rowDriftCheck 阈值边界（>1.5 / <0.67，等号不算偏差）
{
  const cal = buildCalendar([]);
  const mk = (e: number | null, dur: number | null) => rowDriftCheck(
    { expected: e, durationDays: dur, endDate: '2026-12-31', planKind: 'normal', planStatus: 'todo', planProgress: 0 },
    cal, '2026-10-12');
  const atHigh = mk(3, 2);   // 1.5 恰好
  const overHigh = mk(3.1, 2);
  const atLow = mk(1.34, 2); // 0.67 恰好
  const underLow = mk(1.3, 2);
  ok(`S-04 比值取 E÷排期工作日并保留两位；边界按「>」/「<」判，等号不标黄（高=${DURATION_RATIO_HIGH} 低=${DURATION_RATIO_LOW}）`,
    atHigh.ratio === 1.5 && atHigh.flag === null && overHigh.flag === 'high'
    && atLow.ratio === 0.67 && atLow.flag === null && underLow.flag === 'low',
    { atHigh, overHigh, atLow, underLow });
  const noEst = mk(null, 5);
  const noDur = mk(5, null);
  const zeroDur = mk(5, 0);
  ok('S-04b 未估算 / 无工期 / 工期 0 → 比值 null（未录入的行不标黄，也不被标成偏差）',
    noEst.ratio === null && noEst.flag === null && noDur.ratio === null && zeroDur.ratio === null,
    { noEst, noDur, zeroDur });
}

// S-05 只读判定与写路径闸门同一份定义（§7 v2.3：范围只含已收口里程碑）
{
  const cal = buildCalendar([]);
  const v = (kind: string, status: string, progress: number) =>
    ({ expected: 5, durationDays: 5, endDate: '2026-12-31', planKind: kind, planStatus: status, planProgress: progress });
  const cases: Array<[string, ReturnType<typeof v>, boolean]> = [
    ['里程碑 done', v('milestone', 'done', 60), true],
    ['里程碑 progress=100（status 未同步）', v('milestone', 'doing', 100), true],
    ['里程碑未收口', v('milestone', 'doing', 40), false],
    ['普通任务 done（四期 34/37 已收口行是里程碑，普通行完成不代表报价封板）', v('normal', 'done', 100), false],
  ];
  const bad = cases.filter(([_, input, want]) => {
    const got = rowDriftCheck(input, cal, '2026-10-12').locked;
    return got !== want || got !== isClosedMilestone(input);
  }).map(([n]) => n);
  ok(`S-05 locked 四项口径全对，且与 EstimateService.isClosedMilestone 逐条同值（引擎与闸门共用一份定义）`,
    bad.length === 0, bad);
}

// S-06 排期压力：E 人天 > 剩余排期工作日（含过期=0、无日期不参与）
{
  const hol = buildCalendar([{ date: '2026-10-14', kind: 'holiday' }, { date: '2026-10-17', kind: 'overtime' }]);
  const mk = (e: number | null, endDate: string) => rowDriftCheck(
    { expected: e, durationDays: 3, endDate, planKind: 'normal', planStatus: 'todo', planProgress: 0 }, hol, '2026-10-12');
  const tight = mk(10, '2026-10-16');
  const loose = mk(2, '2026-10-16');
  const expired = mk(5, '2026-10-01');
  const none = mk(5, '');
  // 2026-10-12(一)~10-16(五)：5 个工作日，扣 10-14 放假 = 4
  ok('S-06 剩余排期按日历真值扣假日：10-12~10-16 = 4 个工作日',
    tight.remainingWorkdays === 4 && loose.remainingWorkdays === 4, { remaining: tight.remainingWorkdays });
  ok('S-06b E > 剩余 → pressure；E ≤ 剩余 → 不报（同一行只差三点值，判据不含系数）',
    tight.pressure === true && loose.pressure === false, { tight, loose });
  ok('S-06c 排期过期 → 剩余 0 且 E>0 即压力（不是负数）；无排期日期 → null 且不参与压力判定',
    expired.remainingWorkdays === 0 && expired.pressure === true
    && none.remainingWorkdays === null && none.pressure === false, { expired, none });
  ok('S-06d 加班日计入剩余（10-17 周六上班）：10-12~10-17 = 5 个正常工作日 - 1 放假 + 1 加班',
    rowDriftCheck({ expected: 1, durationDays: 3, endDate: '2026-10-17', planKind: 'normal', planStatus: 'todo', planProgress: 0 },
      hol, '2026-10-12').remainingWorkdays === 5);
}

// S-07 红线守卫：判定与阈值只在服务端，面板只排版
{
  const CODE = PANEL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('S-07 面板代码体不含 1.5 / 0.67 字面量（阈值只能来自 `checks.drift.thresholds`）',
    !/1\.5/.test(CODE) && !/0\.67/.test(CODE),
    { hit15: /1\.5/.test(CODE), hit067: /0\.67/.test(CODE) });
  const calc = [
    /expected\s*\/\s*duration/,        // 比值自算
    /remainingWorkdays\s*[<>]/,        // 剩余排期自判
    /countWorkdays|addWorkdays/,       // 工作日算式镜像到面板
    /\boptimistic\s*\+\s*likely/,      // PERT 式子
    /likely\s*\*\s*4/,
  ].map((re) => re.source).filter((s) => new RegExp(s).test(CODE));
  ok('S-07b 面板不重算比值/剩余排期（§5.2 零计算红线在 §7 落地后仍然成立）', calc.length === 0, calc);
  ok('S-07c 只读解锁只传一个显式标志给服务端（真值判定在服务端 `unlockFlag`，面板不做静默放行）',
    /input\.unlock\s*=\s*true/.test(CODE) && /removeItem\([^)]*unlock:/.test(CODE),
    /unlock[^,\n]{0,40}/.exec(CODE)?.[0]);
  // 界面要素不能只对文案（T02293 判据 3）：每个要素配一条「接线在不在」的行为断言，与 S-07h/S-07h2 同一口径。
  // 这些短语都是 JSX 内联字面量、产品侧没导出常量可取（清单见 T02293 报告），所以字面侧仍对源文本，
  // 由行为侧 + S-07z 的破行为反证兜住：改措辞 ⇒ 红因「字面锚点失配（行为在）」，掉接线 ⇒ 红因「行为失守」。
  const ui: Array<[name: string, phrase: string, wire: (code: string) => boolean]> = [
    ['§7 提示条（重导/压力/偏差/只读四行）', 'aria-label="估算变更影响提示"', (c) => /hasDriftNotices && \(/.test(c)
      && /data\.checks\.drift\.pressure/.test(c) && /data\.checks\.drift\.high \+ data\.checks\.drift\.low/.test(c)
      && /data\.checks\.drift\.locked/.test(c) && /data\.checks\.changedSinceExport\.count/.test(c)],
    ['偏差徽标', '偏差 ', (c) => /\{r\.drift\?\.flag && \(/.test(c) && /num\(r\.drift\.ratio\)/.test(c)],
    ['超排期徽标', '超排期', (c) => /\{r\.drift\?\.pressure && \(/.test(c) && /num\(r\.drift\.remainingWorkdays\)/.test(c)],
    ['只读徽标', '已收口·只读', (c) => /const locked = r\.drift\?\.locked === true;/.test(c)
      && /disabled=\{!editable \|\| busy\}/.test(c)],
    ['解锁改写入口', '解锁改写', (c) => /onClick=\{\(\) => toggleUnlock\(r\.planId\)\}/.test(c)
      && /setUnlockedRows/.test(c)],
    ['影响试算按钮', '影响试算', (c) => /onClick=\{openWhatIf\}/.test(c)
      && /onClick=\{\(\) => void runWhatIf\(\)\}/.test(c)],
    ['试算零写入声明', '未写入任何数据', (c) => /written=\{whatIf\.written\}/.test(c)
      && /estimatesApi\.whatIf\(projectId/.test(c)],
  ];
  const miss = ui.filter(([, s]) => !PANEL_SRC.includes(s)).map(([n]) => n);
  ok(`S-07d §7 承诺的界面要素全部存在（${ui.length} 项）`, miss.length === 0, miss);
  for (const [name, phrase, wire] of ui) {
    okPair(ok, `S-07d2 ${name}：读数/事件真的接在服务端下发值上（行为侧）+ 要素文案在面板里（字面侧）`,
      () => wire(CODE), () => PANEL_SRC.includes(phrase), () => ({ 短语: phrase }));
  }
  // 反证（判据 4）：只抹接线、不动文案，同一条判定函数必须翻假；否则行为侧读不出功能变化。
  const breakers: Array<[string, (c: string) => string]> = [
    ['§7 提示条（重导/压力/偏差/只读四行）', (c) => c.replace(/data\.checks\.drift\.locked/g, '0')],
    ['偏差徽标', (c) => c.replace(/\{r\.drift\?\.flag && \(/g, '{false && (')],
    ['超排期徽标', (c) => c.replace(/\{r\.drift\?\.pressure && \(/g, '{false && (')],
    ['只读徽标', (c) => c.replace(/const locked = r\.drift\?\.locked === true;/g, 'const locked = false;')],
    ['解锁改写入口', (c) => c.replace(/onClick=\{\(\) => toggleUnlock\(r\.planId\)\}/g, '')],
    ['影响试算按钮', (c) => c.replace(/onClick=\{openWhatIf\}/g, '')],
    ['试算零写入声明', (c) => c.replace(/written=\{whatIf\.written\}/g, '')],
  ];
  const toothless: string[] = [];
  for (const [name, breakIt] of breakers) {
    const item = ui.find(([n]) => n === name);
    if (!item) { toothless.push(`反证缺判定函数：${name}`); continue; }
    if (item[2](breakIt(CODE)) === true) toothless.push(`${name}：抹掉接线后行为侧仍判真（该断言无判别力）`);
    if (!PANEL_SRC.includes(item[1])) toothless.push(`${name}：反证过程动了文案，字面短语反查不到了`);
  }
  ok('S-07z 反证：七项 §7 界面要素的行为侧都有牙（只破坏接线、短语仍在，判定必须翻假）',
    toothless.length === 0, toothless);
  {
    // 反证 · 配对器语义：文案确实在源码里、但行为没接——必须判红且红因指行为。
    const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    okPair((name, cond, extra) => spy.push({ name, cond, extra }), '伪造件：徽标文案在、比值不接服务端',
      () => false, () => PANEL_SRC.includes('偏差 '));
    ok('S-07z2 反证：字面锚点命中而行为缺失时配对器判红，红因写「行为失守」（绿不是文案给的）',
      spy.length === 1 && spy[0].cond === false && String((spy[0].extra as any)?.红因 ?? '').includes('行为失守'), spy);
  }
  ok('S-07e API 层仍只有类型与请求收口（不含比值/剩余排期算式，也无第二次阈值）',
    !/1\.5|0\.67/.test(API_SRC.replace(/^\s*\*.*$/gm, '')) && !/countWorkdays/.test(API_SRC)
    && /drift:\s*RowDrift/.test(API_SRC) && /whatIf:/.test(API_SRC));
  ok('S-07f 服务端侧：判定在引擎、闸门在服务层、路由只喂数（三处各一份，无重复定义）',
    /rowDriftCheck\(/.test(ROUTE_SRC) && !/DURATION_RATIO_HIGH\s*=/.test(ROUTE_SRC)
    && /isClosedMilestone\(/.test(readFileSync(join(ROOT, 'server', 'src', 'services', 'EstimateService.ts'), 'utf8')));
  ok('S-07g what-if 与参数写入口共用同一份配置解析（试算能过的值真写不会被拒）',
    (ROUTE_SRC.match(/resolveEstimateConfig\(/g) ?? []).length >= 3
    && /written: 0/.test(ROUTE_SRC) && ROUTE_SRC.indexOf("'/what-if'") < ROUTE_SRC.indexOf("'/params'") + ROUTE_SRC.length);
  // S-07h 「可达性」守卫：`groupTimelinePhases`（T01621）把里程碑放在 `milestone` 字段而不是 `items`，
  // 而 §7 的只读判定**只对里程碑成立**——明细段如果只 map `group.items`，「已收口·只读」徽标与
  // 「解锁改写」按钮就成了永不渲染的死码（源码里字符串都在、S-07d 照过，界面却一点都摸不到）。
  // 这条断言把「渲染列表里含里程碑自己的行」钉住，是 S-07d 的唯一有效补强。
  ok('S-07h 里程碑自身的估算行进入明细渲染列表（否则 §7 只读徽标/解锁在面板里不可达）',
    /\[\s*msRow\s*,\s*\.\.\.group\.items\.map/.test(CODE) && !/!collapsed && group\.items\.map/.test(CODE),
    { msRowFirst: /\[\s*msRow\s*,\s*\.\.\.group\.items\.map/.test(CODE), oldItemsOnly: /!collapsed && group\.items\.map/.test(CODE) });
  ok('S-07h2 解锁后的里程碑行仍不参与批量填充（§4.6 红线一：勾选框对里程碑恒禁用，与只读态无关）',
    /disabled=\{r\.kind === 'milestone' \|\| !editable\}/.test(CODE));
}

console.log('\n=== R 段：隔离实例 REST（三条写通道 + 试算 + 重导提示） ===');

// 夹具：直接写隔离测试库（不经 REST，也不碰生产）
initSchema();
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, PROJ_NAME, '', T, T);

const TODAY = fmtDate(new Date());
const dayOffset = (n: number): string => {
  const d = parseYmd(TODAY);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
};

const insPlan = db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids)
   VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, NULL, NULL)`,
);
type Seed = [id: string, title: string, dur: number, kind: string, status: string, progress: number, end: string];
const seeds: Seed[] = [
  ['ms-done', 'M9 收口里程碑', 10, 'milestone', 'done', 100, dayOffset(30)],
  ['ms-open', 'M10 未收口里程碑', 6, 'milestone', 'doing', 40, dayOffset(20)],
  ['pl-high', '偏差-偏高', 2, 'normal', 'todo', 0, dayOffset(40)],
  ['pl-low', '偏差-偏低', 20, 'normal', 'todo', 0, dayOffset(40)],
  ['pl-ok', '偏差-正常', 5, 'normal', 'todo', 0, dayOffset(40)],
  ['pl-tight', '排期吃紧', 3, 'normal', 'todo', 0, dayOffset(2)],
  ['pl-expired', '排期已过期', 3, 'normal', 'doing', 50, dayOffset(-3)],
  ['pl-nodate', '无排期日期', 3, 'normal', 'todo', 0, ''],
  ['pl-unest', '未估算的行', 4, 'normal', 'todo', 0, dayOffset(15)],
];
seeds.forEach(([id, title, dur, kind, status, progress, end], i) => {
  // start_date 是 NOT NULL 列，无排期日期的夹具用「今天 + 空 end_date」表达（§7 关心的是 end_date 缺失）
  insPlan.run(id, PID, title, end || TODAY, end, dur, progress, status, String(10 + i), T, T, kind);
});

const insEst = db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, 'man_day', ?, ?, ?, ?, ?, ?, ?)`,
);
// (O + 4M + P) / 6 → E：15 / 2 / 4 / 10 / 10 / 4 / —
insEst.run('e-ms', PID, 'ms-done', 'impl', 3, 5, 9, 'manual', '收口里程碑的报价行', T, T);
insEst.run('e-ms-open', PID, 'ms-open', 'req', 2, 3, 4, 'manual', '未收口里程碑的行（§7 不该锁它）', T, T);
insEst.run('e-high', PID, 'pl-high', 'dev', 10, 15, 20, 'rule', 'E=15 / 工期 2', T, T);
insEst.run('e-low', PID, 'pl-low', 'design', 1, 2, 3, 'rule', 'E=2 / 工期 20', T, T);
insEst.run('e-ok', PID, 'pl-ok', 'dev', 3, 4, 5, 'rule', 'E=4 / 工期 5', T, T);
insEst.run('e-tight', PID, 'pl-tight', 'dev', 8, 10, 12, 'rule', 'E=10，排期只剩几天', T, T);
insEst.run('e-expired', PID, 'pl-expired', 'dev', 3, 4, 5, 'rule', 'E=4，排期已过', T, T);

console.log('\n=== G 段：单源词干改名模拟（T02293 判据 1/3/4·同进程，必须在 REST 实例启动前） ===');
{
  /**
   * 改名模拟（判据 1/3/4）：REST 那条腿在另一个进程里，门改不动它的常量——所以这一支走**同进程的产品路径**：
   * §7 只读闸门、参数上下限、三点判据、导出词表解析器都能直达。把词干改成 `ZZZ-<key>` 后用同一入参再触发
   * 一次，要求五件事全成立：照样拒绝、文案随单源表移动、旧词干零残留、还原逐字符相同、零副作用。
   * 任一条不成立即说明该文案在某层留了第二份抄本（或校验本身是按字面量写的）。
   * 必须跑在 `closeDb()` 之前：产品函数走的是同一个 `getDb()`，服务进程起来后再开第二条连接没意义、还添乱。
   */
  const ERR_TABLE = ESTIMATE_ERRORS as unknown as Record<string, string>;
  const LABEL_TABLE = ESTIMATE_POINT_LABELS as unknown as Record<string, string>;
  const estIds = () => (db.prepare('SELECT id FROM estimate_items').all() as Array<{ id: string }>)
    .map((r) => r.id).sort().join(',');
  const planIds = () => (db.prepare('SELECT id FROM plan_tasks').all() as Array<{ id: string }>)
    .map((r) => r.id).sort().join(',');
  const baselineEst = estIds();
  const baselinePlan = planIds();
  const full = { optimistic: 1, likely: 1, pessimistic: 1 };
  // 参数那一支与 R-09b 用**同一个系数键**（越界值的键名会进文案，键名不同就不是逐字符同源了）
  const PARAM_COEF_SETTING = ESTIMATE_COEF_SETTING_KEYS[ESTIMATE_COEF_KEYS[0]];
  /** 批量通道的行级错误不 throw（它把错误收进 `errors[]`），取文案要单独走一条 */
  const batchMsg = (items: Array<Record<string, unknown>>): string =>
    String((EstimateService.upsertBatch(PID, items as never).errors as Array<Record<string, any>>)[0]?.message ?? '');

  const cases: Array<{ table: Record<string, string>; key: string; title: string; run: () => string }> = [
    // 三点判据：与 R-09c 同入参（20/10/30），门里对的词干与服务端回的文案是同一条代码路径产的
    { table: ERR_TABLE, key: 'ordering', title: '三点顺序 O>M（试算入参同形）', run: () => pointsError(20, 10, 30) ?? '' },
    { table: ERR_TABLE, key: 'ordering', title: '三点顺序 M>P', run: () => pointsError(1, 5, 2) ?? '' },
    { table: ERR_TABLE, key: 'notNumber', title: '三点非数字', run: () => pointsError(Number.NaN, 5, 9) ?? '' },
    { table: ERR_TABLE, key: 'negative', title: '三点为负', run: () => pointsError(3, -1, 9) ?? '' },
    { table: LABEL_TABLE, key: 'optimistic', title: '点值标签（乐观）', run: () => pointsError(Number.NaN, 1, 1) ?? '' },
    { table: LABEL_TABLE, key: 'likely', title: '点值标签（最可能）', run: () => pointsError(1, 5, 2) ?? '' },
    { table: LABEL_TABLE, key: 'pessimistic', title: '点值标签（悲观）', run: () => pointsError(1, 1, 0) ?? '' },
    // §7 只读闸门的三条写通道（PATCH / DELETE / batch）与 R-03/R-04/R-06 逐字对账
    {
      table: ERR_TABLE, key: 'milestoneReadonly', title: '收口里程碑只读（单行写）',
      run: () => fire(() => EstimateService.upsert(PID, 'ms-done', { optimistic: 3, likely: 99, pessimistic: 9 })),
    },
    {
      table: ERR_TABLE, key: 'milestoneReadonly', title: '收口里程碑只读（删除）',
      run: () => fire(() => EstimateService.remove(PID, 'ms-done')),
    },
    {
      table: ERR_TABLE, key: 'milestoneReadonly', title: '收口里程碑只读（批量行级）',
      run: () => batchMsg([{ planId: 'ms-done', likely: 8 }]),
    },
    // 参数上下限：R-09b 的两个端点共用 `resolveEstimateConfig`，同进程这一支就是那把尺子本身
    {
      table: ERR_TABLE, key: 'paramMax', title: '参数越上界',
      run: () => fire(() => resolveEstimateConfig({ [ESTIMATE_COEF_SETTING_KEYS.schedule]: '9' })),
    },
    {
      table: ERR_TABLE, key: 'paramLabel', title: '参数名（同一句的另一半词干）',
      run: () => fire(() => resolveEstimateConfig({ [ESTIMATE_COEF_SETTING_KEYS.schedule]: '9' })),
    },
    {
      table: ERR_TABLE, key: 'paramMin', title: '参数越下界',
      run: () => fire(() => resolveEstimateConfig({ [ESTIMATE_COEF_SETTING_KEYS.schedule]: '-0.5' })),
    },
    // 服务层各写入口
    {
      table: ERR_TABLE, key: 'unknownPhase', title: '未知阶段（写路径）',
      run: () => fire(() => EstimateService.upsert(PID, 'pl-ok', { phase: 'qa' as never })),
    },
    {
      table: ERR_TABLE, key: 'unknownUnit', title: '未知计量单位',
      run: () => fire(() => EstimateService.upsert(PID, 'pl-ok', { unit: 'lightyear' as never })),
    },
    { table: ERR_TABLE, key: 'planMissing', title: '计划不存在', run: () => fire(() => EstimateService.upsert(PID, 'pl-nope-e9', full)) },
    { table: ERR_TABLE, key: 'pointsRequired', title: '三点必填（该行尚无估算）', run: () => fire(() => EstimateService.upsert(PID, 'pl-unest', { optimistic: 1 } as never)) },
    { table: ERR_TABLE, key: 'batchEmpty', title: '批量内容为空', run: () => fire(() => EstimateService.upsertBatch(PID, [])) },
    { table: ERR_TABLE, key: 'nothingToClean', title: '清理未选行', run: () => fire(() => EstimateService.removeDetached(PID, [])) },
    { table: ERR_TABLE, key: 'projectIdRequired', title: 'projectId 缺失', run: () => fire(() => EstimateService.listByProject('')) },
    { table: ERR_TABLE, key: 'projectNotFound', title: '项目不存在', run: () => fire(() => EstimateService.listByProject('no-such-project-e9')) },
    // 导出词表（X 段的坏参数请求逐字对账就靠这三条）
    { table: ERR_TABLE, key: 'unknownAudience', title: '未知导出版本', run: () => fire(() => parseAudience('both')) },
    { table: ERR_TABLE, key: 'unknownScope', title: '未知导出范围', run: () => fire(() => parseScope('bogus')) },
    { table: ERR_TABLE, key: 'unknownPhase', title: '未知阶段（导出筛选）', run: () => fire(() => parsePhases('dev,zzz-phase')) },
    { table: ERR_TABLE, key: 'emptyPhases', title: '阶段筛选被逗号吃空', run: () => fire(() => parsePhases(',,,')) },
  ];
  // 跨项目那一支要一个「别人的项目」：临时建、跑完删，不给 R/X 段留额外读数
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run('p-e9-x', 'T02046-改名模拟用他项目', '', T, T);
  cases.push({
    table: ERR_TABLE, key: 'planNotInProject', title: '计划跨项目',
    run: () => fire(() => EstimateService.upsert('p-e9-x', 'pl-high', full)),
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
    if (estIds() !== baselineEst || planIds() !== baselinePlan) {
      zj.push(`${c.title}：被拒的调用留下了副作用（估算行或计划数变化）`);
      for (const id of estIds().split(',').filter((x) => x && !baselineEst.split(',').includes(x))) {
        db.prepare('DELETE FROM estimate_items WHERE id = ?').run(id);
      }
    }
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run('p-e9-x');
  ok('G-01 词干改名模拟全项通过（拒绝在、文案随单源移动、旧词干零残留、还原逐字符相同、零副作用）',
    zj.length === 0, zj);
  ok('G-02 改名模拟覆盖的词干支数足够（本门 ≥ 22 支：三点判据 + §7 三条写通道 + 参数尺子 + 导出词表）',
    cases.length >= 22, { 支数: cases.length, 去重词干: new Set(cases.map((c) => c.key)).size });
  // 反证：改名期间**合法入参必须照旧通过**。若改名后连合法值都开始报错，说明校验是按字面量写的
  // （文案反过来决定了行为），那才是判据 1 最怕的形态。
  ok('G-03 改名期间合法值不受影响（判据不是按字面量写的，文案改造不会反向变严）', (() => {
    const orig = ESTIMATE_ERRORS.ordering;
    const origMax = ESTIMATE_ERRORS.paramMax;
    try {
      ERR_TABLE.ordering = 'ZZZ-ordering';
      ERR_TABLE.paramMax = 'ZZZ-paramMax';
      return pointsError(10, 20, 30) === null && pointsError(0, 0, 0) === null
        && resolveEstimateConfig({ [ESTIMATE_COEF_SETTING_KEYS.schedule]: '0.5' }).coefs.schedule === 0.5;
    } finally {
      ERR_TABLE.ordering = orig;
      ERR_TABLE.paramMax = origMax;
    }
  })(), { ordering: ESTIMATE_ERRORS.ordering, paramMax: ESTIMATE_ERRORS.paramMax });
  ok('G-04 改名模拟全程零库副作用（estimate_items / plan_tasks 集合与进入 G 段时逐字相同）',
    estIds() === baselineEst && planIds() === baselinePlan,
    { 现在: estIds(), 基线: baselineEst, 计划现在: planIds().split(',').length, 计划基线: baselinePlan.split(',').length });
  // 把 R/X 段要逐字符对账的产品原文在这一刻（词表未改、库为夹具初态）各取一份存下来
  inProc.readonlyUpsert = fire(() => EstimateService.upsert(PID, 'ms-done', { optimistic: 3, likely: 99, pessimistic: 9 }));
  inProc.readonlyRemove = fire(() => EstimateService.remove(PID, 'ms-done'));
  inProc.readonlyBatch = batchMsg([{ planId: 'ms-done', likely: 8 }]);
  // 门进程复现越界系数报错时，必须用**与 HTTP 侧同一个系数档**（ESTIMATE_COEF_KEYS[0]）：
  // 报错文案里带档名，换成别的档就成了「两句不同的话比逐字符」，红得没有信息量
  inProc.paramMax = fire(() => resolveEstimateConfig({ [ESTIMATE_COEF_SETTING_KEYS[ESTIMATE_COEF_KEYS[0]]]: '9' }));
  inProc.pts20 = pointsError(20, 10, 30) ?? '';
  inProc.badAudience = fire(() => parseAudience('both'));
  inProc.badScope = fire(() => parseScope('bogus'));
  inProc.badPhases = fire(() => parsePhases('dev,zzz-phase'));
  inProc.emptyPhases = fire(() => parsePhases(',,,'));
  ok('G-05 同进程原文采集完整（供 R/X 段跨进程逐字符对账的九支全非空）',
    Object.keys(inProc).length === 9 && Object.values(inProc).every((v) => v.length > 0), Object.keys(inProc));
}

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
type Item = Record<string, any> & { drift: Record<string, any> };
const get = async (): Promise<Record<string, any>> => (await api('GET', `/estimates?${qs}`)).json;
const itemOf = (data: Record<string, any>, planId: string): Item | undefined =>
  (data.items as Item[]).find((i) => i.plan_id === planId);

if (!(await waitForServer())) {
  ok('R-00 隔离服务启动', false, serverLog.join('').slice(-400));
  child.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\nPASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
ok('R-00 隔离服务启动（临时端口 + 临时库）', true);

// R-01 行级 drift 随 items 下发，checks.drift 的四个计数与逐行统计同源
{
  const data = await get();
  const items = data.items as Item[];
  const allHaveDrift = items.every((i) => i.drift && typeof i.drift.locked === 'boolean' && 'ratio' in i.drift
    && 'remainingWorkdays' in i.drift && 'pressure' in i.drift);
  ok('R-01 GET /api/estimates 每行都带 drift 四字段（面板零计算的正面条件）', allHaveDrift,
    items.find((i) => !i.drift)?.plan_id);
  const c = data.checks.drift;
  const count = (f: (i: Item) => boolean) => items.filter(f).length;
  ok('R-01b checks.drift 的 high/low/locked/pressure = 逐行统计（同一个数，不是第二套口径）',
    c.high === count((i) => i.drift.flag === 'high') && c.low === count((i) => i.drift.flag === 'low')
    && c.locked === count((i) => i.drift.locked) && c.pressure === count((i) => i.drift.pressure)
    && c.today === TODAY && c.thresholds.high === DURATION_RATIO_HIGH && c.thresholds.low === DURATION_RATIO_LOW,
    { c, high: count((i) => i.drift.flag === 'high'), locked: count((i) => i.drift.locked) });
  const high = itemOf(data, 'pl-high')!, low = itemOf(data, 'pl-low')!, mid = itemOf(data, 'pl-ok')!;
  ok('R-01c 偏差徽标逐行对号：E=15/工期2 → 7.5 偏高；E=2/工期20 → 0.1 偏低；E=4/工期5 → 0.8 不标',
    high.drift.ratio === 7.5 && high.drift.flag === 'high'
    && low.drift.ratio === 0.1 && low.drift.flag === 'low'
    && mid.drift.ratio === 0.8 && mid.drift.flag === null,
    { high: high.drift, low: low.drift, mid: mid.drift });
  const unest = itemOf(data, 'pl-unest');
  ok('R-01d 未估算的行根本不进 items（左联以估算表为主表），也就不会被标成偏差',
    unest === undefined, unest?.plan_id);
  const noDate = itemOf(data, 'pl-nodate');
  ok('R-01e 无排期日期行不在估算表里（同上），有过期行则剩余排期给 0 而不是负数',
    noDate === undefined || (noDate.drift.remainingWorkdays === null && noDate.drift.pressure === false),
    noDate?.drift);
  const exp = itemOf(data, 'pl-expired')!;
  ok('R-01f 排期已过期 → 剩余 0 个工作日 + 计入压力行',
    exp.drift.remainingWorkdays === 0 && exp.drift.pressure === true, exp.drift);
  const tight = itemOf(data, 'pl-tight')!;
  ok('R-01g 排期吃紧行 E=10 > 剩余工作日 → pressure',
    tight.drift.pressure === true && tight.drift.remainingWorkdays !== null
    && 10 > (tight.drift.remainingWorkdays as number), tight.drift);
}

// R-02/R-03/R-04 只读闸门：PATCH / DELETE / batch 三条写通道
{
  const data = await get();
  const msDone = itemOf(data, 'ms-done')!;
  const msOpen = itemOf(data, 'ms-open')!;
  ok('R-02 只有「已收口里程碑」被置只读，未收口里程碑不因 §7 锁定（§4.6 的里程碑不重复计是另一条规则）',
    msDone.drift.locked === true && (msOpen.drift?.locked ?? false) === false,
    { done: msDone.drift.locked, open: msOpen.drift?.locked });

  const locked = await api('PATCH', `/estimates/ms-done?${qs}`, { likely: 99 });
  // 零副作用读数一律取在合法对照调用之前——对照那次写入不能被算到坏请求头上
  const afterLocked = await get();
  const lockedRow = itemOf(afterLocked, 'ms-done')!;
  // 对照只差一个显式 `unlock`，且回写的是**当前同值**：放行证明闸门按「有没有解锁意图」拒，
  // 同值证明这条对照不会把后面的断言（R-05 的 3/5/9 起点）挪走。
  const unlockCtrl = await api('PATCH', `/estimates/ms-done?${qs}`, { likely: lockedRow.likely, unlock: true });
  rejectedPair('R-03 收口里程碑 PATCH 真被拒：400 + 三点原值不动 + 只差显式 unlock 的同值请求照放行（字面侧只取单源词干「已收口」）',
    locked, ESTIMATE_ERRORS.milestoneReadonly,
    () => {
      const it = itemOf(afterLocked, 'ms-done')!;
      return it.optimistic === 3 && it.likely === 5 && it.pessimistic === 9 && it.source === 'manual';
    });
  sameSource.push({ label: 'R-03', server: String(locked.json.error ?? ''), mine: inProc.readonlyUpsert });
  ok('R-03c 合法对照（同值 + unlock:true）仍然 200 且值没被挪（拒绝不是「把这条通道整个关掉」）',
    unlockCtrl.status === 200 && unlockCtrl.json.item?.likely === 5
    && JSON.stringify([unlockCtrl.json.item?.optimistic, unlockCtrl.json.item?.pessimistic]) === JSON.stringify([3, 9]),
    unlockCtrl.json);

  const del = await api('DELETE', `/estimates/ms-done?${qs}`);
  const stillThere = itemOf(await get(), 'ms-done') !== undefined;
  const delCtrl = await api('DELETE', `/estimates/ms-done?${qs}&unlock=1`);
  const restored = await api('PATCH', `/estimates/ms-done?${qs}`,
    { optimistic: 3, likely: 5, pessimistic: 9, source: 'manual', unlock: true });
  const restoredRow = itemOf(await get(), 'ms-done');
  rejectedPair('R-04 删除同受闸门管（「改不动就删了重建」会让只读化形同虚设）：400 + 行仍在 + 带 unlock 的删除真删得掉',
    del, ESTIMATE_ERRORS.milestoneReadonly, () => stillThere);
  sameSource.push({ label: 'R-04', server: String(del.json.error ?? ''), mine: inProc.readonlyRemove });
  ok('R-04b 删除通道的合法对照：unlock=1 真删（removed=true），随即按原值回写复原——拒的是这一条请求，不是这条通道',
    delCtrl.status === 200 && delCtrl.json.removed === true && restored.status === 200
    && restoredRow?.optimistic === 3 && restoredRow?.likely === 5 && restoredRow?.pessimistic === 9
    && restoredRow?.source === 'manual',
    { delCtrl: delCtrl.json, restored: restoredRow });
}

// R-05 显式解锁：unlock 的假值不放行，真值才放行，且只放行这一条请求
{
  const falsyCases: Array<[string, unknown]> = [
    ['未给 unlock', undefined], ['unlock=false', false], ['unlock=0', 0], ['unlock=""', ''], ['unlock="false"', 'false'],
  ];
  const bad: string[] = [];
  for (const [label, value] of falsyCases) {
    const r = await api('PATCH', `/estimates/ms-done?${qs}`,
      value === undefined ? { likely: 7 } : { likely: 7, unlock: value });
    if (r.status === 200) bad.push(label);
  }
  ok('R-05 unlock 假值（未给/false/0/空串/字符串 false）一律不放行——只有显式真值才改写',
    bad.length === 0, bad);
  const on = await api('PATCH', `/estimates/ms-done?${qs}`, { likely: 7, unlock: true });
  ok('R-05b unlock:true（body）放行并落库——面板「解锁改写」就是走这条通道',
    on.status === 200 && on.json.item?.likely === 7, on.json);
  await api('PATCH', `/estimates/ms-done?${qs}`, { likely: 7, unlock: true });
  const again = await api('PATCH', `/estimates/ms-done?${qs}`, { likely: 6 });
  ok('R-05c 下一条不带 unlock 的请求仍然被拒（服务端不保存「已解锁」状态，解锁是一次性的）',
    again.status === 400 && (itemOf(await get(), 'ms-done'))?.likely === 7, again.json);
  const qUnlock = await api('PATCH', `/estimates/ms-done?${qs}&unlock=1`, { likely: 8 });
  ok('R-05d PATCH 的 unlock 只认 body（query 上的 `unlock=1` 不算放行——写意图必须显式在请求体里，不能被 URL 侧信道带上）',
    qUnlock.status === 400 && (itemOf(await get(), 'ms-done'))?.likely === 7, qUnlock.json);
  const delOk = await api('DELETE', `/estimates/ms-done?${qs}&unlock=1`);
  ok('R-05e DELETE 没有 body 约定，`unlock=1` 走 query 同样被 `unlockFlag` 认真值并回传 removed=true',
    delOk.status === 200 && delOk.json.removed === true, delOk.json);
  const gone = itemOf(await get(), 'ms-done');
  ok('R-05f 删除后该行整条从明细消失（不是留一行 0/0/0 的假数据）',
    gone === undefined, gone);
  // 恢复：后续断言还要用这条收口行
  await api('PATCH', `/estimates/ms-done?${qs}`, { optimistic: 3, likely: 5, pessimistic: 9, source: 'manual', unlock: true });
}

// R-06 batch 三条腿：混入锁定行零写入；全 unlock 才整批落；derive 不碰里程碑
{
  const mixed = await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set',
    items: [{ planId: 'pl-ok', likely: 4.5 }, { planId: 'ms-done', likely: 8 }],
  });
  const mixedErr = (mixed.json.errors as Array<Record<string, any>>) ?? [];
  const plOkAfterBad = itemOf(await get(), 'pl-ok');
  const msDoneAfterBad = itemOf(await get(), 'ms-done');
  // 合法对照同样只差逐行 unlock，且回写当前同值（4 / 5）：证明批量通道拒的是「含未解锁收口行」这一批，
  // 而不是把 batch 端点整体关掉；同值则保证 R-06b/R-06c 的起点读数不动。
  const batchCtrl = await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set',
    items: [{ planId: 'pl-ok', likely: 4 }, { planId: 'ms-done', likely: 5, unlock: true }],
  });
  rejectedPair('R-06 batch 混入收口里程碑 → 整批零写入 + 行级错误点名 index/planId（其余行也不写）；文案词干取单源「已收口」',
    mixed, ESTIMATE_ERRORS.milestoneReadonly,
    () => mixedErr.length === 1 && mixedErr[0].planId === 'ms-done'
      && mixedErr[0].index === 1 && plOkAfterBad?.likely === 4 && msDoneAfterBad?.likely === 5,
    (json) => String(((json.errors as Array<Record<string, any>>) ?? [])[0]?.message ?? ''),
    (r) => r.status === 200 && r.json.written === 0 && ((r.json.errors as unknown[]) ?? []).length > 0);
  sameSource.push({
    label: 'R-06',
    server: String(mixedErr[0]?.message ?? ''),
    mine: inProc.readonlyBatch,
  });
  ok('R-06a 批量通道的合法对照：逐行 unlock 后同值整批落库（written=2、无行级错误、值仍是 4/5）',
    batchCtrl.json.written === 2 && (batchCtrl.json.errors as unknown[])?.length === 0
    && (itemOf(await get(), 'pl-ok'))?.likely === 4 && (itemOf(await get(), 'ms-done'))?.likely === 5,
    batchCtrl.json);
  const allUnlock = await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set',
    items: [{ planId: 'pl-ok', likely: 4.5 }, { planId: 'ms-done', likely: 8, unlock: true }],
  });
  ok('R-06b 逐行 unlock 后整批写入（批量通道不引入「全局解锁」这种绕过态）',
    allUnlock.json.written === 2 && (allUnlock.json.errors as unknown[])?.length === 0
    && (itemOf(await get(), 'ms-done'))?.likely === 8, allUnlock.json);
  await api('POST', '/estimates/batch', {
    projectId: PID, mode: 'set', items: [{ planId: 'pl-ok', likely: 4 }, { planId: 'ms-done', likely: 5, unlock: true }],
  });
  const derive = await api('POST', '/estimates/derive', { projectId: PID, dryRun: true, scope: 'all' });
  const msItems = (derive.json.items as Array<Record<string, any>>).filter((i) => i.kind === 'milestone');
  const msSkip = (derive.json.skipped as Array<Record<string, any>>).filter((s) => s.skip === 'milestone');
  ok('R-06c 推导预览不写里程碑行（§4.6 红线在前，§7 闸门不会误伤批量推导）',
    msItems.every((i) => i.writable === false) && msSkip.length >= 2,
    { items: msItems.map((i) => [i.planId, i.skip, i.writable]), skipped: msSkip.map((i) => i.planId) });
}

// R-07/R-08/R-09 影响试算：零写入、Δ% 自洽、参数校验同尺子
{
  const before = await get();
  const beforeActual = before.summary.actualManMonths.expected as number;
  const r = await api('POST', '/estimates/what-if', { projectId: PID, coefs: { schedule: 1 } });
  const j = r.json;
  ok('R-07 试算返回 before/after/delta/applied 四段且 written=0',
    r.status === 200 && j.before && j.after && j.delta && j.applied && j.written === 0
    && JSON.stringify(j.applied.coefs) === JSON.stringify(['schedule']), j.applied);
  ok('R-07b 系数只放大「实际预估人月」，不改「直接投入人天」（试算不会把 ΣE 洗掉）',
    j.delta.directManDays === 0 && near(j.before.directManDays, j.after.directManDays)
    && j.after.actualManMonths > beforeActual, { delta: j.delta, before: j.before.actualManMonths });
  ok('R-07c delta.pct 与 delta/before 自洽（面板显示「X → Y（Δ·%）」时不用自己再除一次）',
    near(j.delta.pct as number, (j.delta.actualManMonths / j.before.actualManMonths) * 100, 0.02),
    { pct: j.delta.pct, delta: j.delta.actualManMonths, before: j.before.actualManMonths });
  ok('R-07d 逐阶段 delta 与合计同向（phases 里非零项之和 = directManDays 变化）',
    (j.delta.phases as Array<Record<string, any>>).every((p) => near(p.delta, p.after - p.before, 1e-6))
    && (j.delta.phases as Array<Record<string, any>>).filter((p) => p.delta !== 0).length === 0,
    j.delta.phases);

  const rowsReq = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'pl-high', optimistic: 100, likely: 120, pessimistic: 200 }],
  });
  ok('R-08 行级三点覆盖走同一份汇总（改一行 → ΣE 变、系数放大后的人月也变）',
    rowsReq.status === 200 && rowsReq.json.delta.directManDays > 0
    && rowsReq.json.after.directManDays > rowsReq.json.before.directManDays
    && JSON.stringify(rowsReq.json.applied.rows) === JSON.stringify(['pl-high']),
    { delta: rowsReq.json.delta, applied: rowsReq.json.applied });

  const afterTry = await get();
  ok('R-08b 两次试算后库里的汇总与试算前逐字相同（「不落库」不是文案而是事实）',
    afterTry.summary.actualManMonths.expected === beforeActual
    && (itemOf(afterTry, 'pl-high'))?.likely === 15,
    { after: afterTry.summary.actualManMonths.expected, before: beforeActual });

  // 试算/参数两条通道的拒绝都不该改动库里的生效值——基线读数取在任何对照调用之前
  const sumBeforeBad = (await get()).summary.actualManMonths.expected;
  const COEF = ESTIMATE_COEF_KEYS[0];
  const COEF_SETTING = ESTIMATE_COEF_SETTING_KEYS[COEF];
  const badCoef = await api('POST', '/estimates/what-if', { projectId: PID, coefs: { whatever: 0.5 } });
  const badRange = await api('POST', '/estimates/what-if', { projectId: PID, coefs: { [COEF]: 9 } });
  const badRange2 = await api('PUT', '/estimates/params', { projectId: PID, settings: { [COEF_SETTING]: '9' } });
  const sumAfterBad = (await get()).summary.actualManMonths.expected;
  const params0 = await api('GET', `/estimates/params?${qs}`);
  const curCoef = params0.json.config.coefs[COEF] as number;
  // 合法对照：同一条通道换个合法系数照样出数；PUT 回写**当前生效值**（值不变、只证明通道开着）
  const okCoef = await api('POST', '/estimates/what-if', { projectId: PID, coefs: { [COEF]: 0.5 } });
  const okPut = await api('PUT', '/estimates/params', { projectId: PID, settings: { [COEF_SETTING]: String(curCoef) } });
  const params1 = await api('GET', `/estimates/params?${qs}`);
  const sumAfterCtrl = (await get()).summary.actualManMonths.expected;

  rejectedPair('R-09 未知系数名 → 真被拒（400 + 生效值不动 + 合法系数照跑），可用档清单逐字取产品导出的系数档常量',
    badCoef, ESTIMATE_COEF_KEYS.join(' / '),
    () => sumAfterBad === sumBeforeBad && okCoef.status === 200 && okCoef.json.written === 0
      && String(badCoef.json.error ?? '').includes('whatever'));
  bogusCoefParts = { server: String(badCoef.json.error ?? ''), bad: 'whatever', list: ESTIMATE_COEF_KEYS.join(' / ') };
  rejectedPair('R-09b 越界系数在试算通道被拒：400 + 汇总不动 + 同键回写生效值照过（词干取单源「估算参数/不得大于」）',
    badRange, [ESTIMATE_ERRORS.paramLabel, ESTIMATE_ERRORS.paramMax],
    () => sumAfterBad === sumBeforeBad && sumAfterCtrl === sumBeforeBad && okPut.status === 200);
  sameSource.push({ label: 'R-09b', server: String(badRange.json.error ?? ''), mine: inProc.paramMax });
  rejectedPair('R-09b2 同一个越界值在参数写入口同样被拒（两个端点共用一把尺子）',
    badRange2, [ESTIMATE_ERRORS.paramLabel, ESTIMATE_ERRORS.paramMax],
    () => params1.json.config.coefs[COEF] === curCoef && okPut.json.config?.coefs?.[COEF] === curCoef);
  sameSource.push({ label: 'R-09b2', server: String(badRange2.json.error ?? ''), mine: inProc.paramMax });
  ok('R-09b3 两条通道回的是**同一句话**：逐字符相同，且与门进程直调 resolveEstimateConfig 的原文逐字符相同',
    String(badRange.json.error ?? '') === String(badRange2.json.error ?? '')
    && String(badRange.json.error ?? '') === inProc.paramMax,
    { whatIf: badRange.json, params: badRange2.json, 门进程: inProc.paramMax });

  const badPts = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'pl-high', optimistic: 20, likely: 10, pessimistic: 30 }],
  });
  const sumAfterPts = (await get()).summary.actualManMonths.expected;
  // 只差把 O/M 换成合法次序：同一条行校验通道仍然放行
  const okPts = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'pl-high', optimistic: 10, likely: 20, pessimistic: 30 }],
  });
  rejectedPair('R-09c 试算行也过 pointsError（O>M 在 PATCH 里怎么拒，在试算里就怎么拒）：400 + 零写入 + 合法次序照跑',
    badPts, [ESTIMATE_ERRORS.ordering, ESTIMATE_POINT_LABELS.optimistic, ESTIMATE_POINT_LABELS.likely],
    () => sumAfterPts === sumBeforeBad && okPts.status === 200 && okPts.json.written === 0
      && String(badPts.json.error ?? '').includes('pl-high'));
  {
    // 路由给行级文案加了「试算行「planId」：」这个**未进单源表**的前缀，门里不抄它——
    // 按门进程原文长度截出尾部逐字符比，前缀是否由它拼的交给 R-09c2 的 endsWith 事实。
    const msg = String(badPts.json.error ?? '');
    const tail = msg.length >= inProc.pts20.length ? msg.slice(msg.length - inProc.pts20.length) : msg;
    sameSource.push({ label: 'R-09c', server: tail, mine: inProc.pts20 });
    ok('R-09c2 行级文案的服务端尾部与门进程 pointsError(20,10,30) 逐字符相同（同一份判据，无第二份抄本）',
      tail === inProc.pts20 && tail.length > 0 && msg.length > tail.length,
      { server: msg.slice(0, 120), 尾部: tail, 门进程: inProc.pts20 });
  }
  const badRow = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'no-such-plan', optimistic: 1, likely: 2, pessimistic: 3 }],
  });
  const sumAfterRow = (await get()).summary.actualManMonths.expected;
  const okRow = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'pl-low', optimistic: 1, likely: 2, pessimistic: 3 }],
  });
  rejectedPair('R-09d 试算行必须属于该项目在架计划（不认任意 planId，避免拿别的项目的数试算）',
    badRow, ESTIMATE_ERRORS.planNotInProject,
    () => sumAfterRow === sumBeforeBad && okRow.status === 200 && okRow.json.written === 0
      && String(badRow.json.error ?? '').includes('no-such-plan'));
  const lockedTry = await api('POST', '/estimates/what-if', {
    projectId: PID, rows: [{ planId: 'ms-done', optimistic: 3, likely: 400, pessimistic: 900 }],
  });
  ok('R-09e 收口里程碑可以「试算」但不能落库——试算通道写 0 条，闸门不因此放宽',
    lockedTry.status === 200 && lockedTry.json.written === 0
    && (itemOf(await get(), 'ms-done'))?.likely === 5, { status: lockedTry.status });
}

// R-10 §7 的剩余排期读的是 holidays 表真值（而不是「日历日 × 5/7」的近似）
// 注意：改日历会触发 PlanService.rescheduleFromDate 顺延排期，所以这里不能拿「同一天少 1」当判据——
// 判据是「服务端报的剩余排期 = 以当前 end_date + 当前日历逐日推进的参照值」，对全表逐行成立。
{
  const listEmpty = await api('GET', '/plans/holidays');
  ok('R-10a 隔离库初始无日历记录（下面的对照不受外部数据干扰）',
    listEmpty.status === 200 && Array.isArray(listEmpty.json) && (listEmpty.json as unknown[]).length === 0,
    listEmpty.json);

  const calOf = async (): Promise<WorkdayCal> => {
    const rows = (await api('GET', '/plans/holidays')).json as unknown as Array<{ date: string; kind?: string | null }>;
    return buildCalendar(rows);
  };
  /** 全表交叉核对：服务端报的剩余排期与「当前 end_date + 当前日历」的逐日参照逐行相等 */
  const crossCheck = async (): Promise<{ n: number; bad: string[] }> => {
    const cal = await calOf();
    const items = (await get()).items as Item[];
    const bad: string[] = [];
    let n = 0;
    for (const i of items) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.endDate || ''))) continue;
      n += 1;
      const want = refCount(TODAY, String(i.endDate), cal); // 过期区间在参照里同样是 0
      if (i.drift.remainingWorkdays !== want) bad.push(`${i.plan_id}: ${i.drift.remainingWorkdays} ≠ ${want}`);
    }
    return { n, bad };
  };
  const first = await crossCheck();
  ok(`R-10b 空日历下全表 ${first.n} 行的剩余排期与逐日参照全等`, first.bad.length === 0, first.bad.slice(0, 5));

  const tightBefore = itemOf(await get(), 'pl-tight')!;
  const add = await api('POST', '/plans/holidays', { date: tightBefore.endDate, name: '§7 日历真值取证', kind: 'holiday' });
  const second = await crossCheck();
  const tightAfter = itemOf(await get(), 'pl-tight')!;
  ok(`R-10c 把「今天之后第一个工作日」置为放假日后：接口收下、全表逐行仍与参照全等（服务端每次请求重读日历，无缓存态）`,
    add.status === 200 && second.n === first.n && second.bad.length === 0
    && tightAfter.drift.remainingWorkdays === refCount(TODAY, String(tightAfter.endDate), await calOf()),
    { bad: second.bad.slice(0, 5), before: tightBefore.drift.remainingWorkdays, after: tightAfter.drift.remainingWorkdays });
  ok('R-10d 日历改动的连带效应被 §7 如实反映（end_date 被 rescheduleFromDate 顺延 → 剩余排期按新排期报，不是按旧日期）',
    tightAfter.endDate !== tightBefore.endDate || tightAfter.drift.remainingWorkdays !== tightBefore.drift.remainingWorkdays,
    { endBefore: tightBefore.endDate, endAfter: tightAfter.endDate });

  const ot = await api('POST', '/plans/holidays', { date: dayOffset(6), name: '§7 加班日取证', kind: 'overtime' });
  const third = await crossCheck();
  ok('R-10e 加班日(kind=overtime)进同一张表后仍全等（周末加班被算进剩余排期，与放假日两条语义互不干扰）',
    ot.status === 200 && third.bad.length === 0, third.bad.slice(0, 5));
  // 清理按「表里还有什么」逐条删，而不是按「我以为写了哪两条」——排期顺延会让被记下的日期已经不是当初那条
  const left = (await api('GET', '/plans/holidays')).json as unknown as Array<{ date: string }>;
  for (const r of left) await api('DELETE', `/plans/holidays/${encodeURIComponent(r.date)}`);
  const fourth = await crossCheck();
  const cleared = (await api('GET', '/plans/holidays')).json as unknown[];
  ok('R-10f 撤掉全部日历记录后回到空日历，全表参照仍然全等',
    cleared.length === 0 && fourth.bad.length === 0, { cleared: cleared.length, bad: fourth.bad.slice(0, 5) });
}

// R-11 重导提示：无快照 → 空；导出后归零；改计划/改估算分别点名；再导出取最近一条
{
  const none = (await get()).checks.changedSinceExport;
  ok('R-11 无快照时 changedSinceExport 给空结构（count=0 / snapshotId=null），而不是报错',
    none.count === 0 && none.snapshotId === null && none.at === '' && (none.rows as unknown[]).length === 0, none);

  const exp1 = await fetch(`${BASE}/api/estimates/export-xlsx?${qs}`);
  const s1 = exp1.headers.get('x-estimate-snapshot') ?? '';
  const fresh = (await get()).checks.changedSinceExport;
  ok('R-11b 刚导完 → 重导提示归零（count=0），面板那条提示随之消失而不是长亮',
    exp1.status === 200 && s1 !== '' && fresh.snapshotId === s1 && fresh.count === 0,
    { status: exp1.status, s1, fresh });

  const touched = await api('PATCH', `/estimates/pl-low?${qs}`, { pessimistic: 3.5 });
  const afterEst = (await get()).checks.changedSinceExport;
  const lowRow = (afterEst.rows as Array<Record<string, any>>).find((r) => r.planId === 'pl-low');
  ok('R-11c 只改估算（O/M/P）也被点名 changed 含 estimate——只查计划会漏掉最该重导的情况',
    touched.status === 200 && afterEst.count === 1 && lowRow !== undefined
    && JSON.stringify(lowRow.changed) === JSON.stringify(['estimate']) && lowRow.estimateUpdatedAt > fresh.at,
    { count: afterEst.count, lowRow });

  const planTouched = await api('PATCH', '/plans/pl-ok', { title: '偏差-正常（导出后改的标题）' });
  const afterPlan = (await get()).checks.changedSinceExport;
  const okRow = (afterPlan.rows as Array<Record<string, any>>).find((r) => r.planId === 'pl-ok');
  ok('R-11d 只改计划侧字段也被点名 changed 含 plan（连同上一轮共 2 行）',
    planTouched.status === 200 && afterPlan.count === 2 && okRow !== undefined
    && JSON.stringify(okRow.changed) === JSON.stringify(['plan']) && typeof okRow.estimateUpdatedAt === 'string',
    { count: afterPlan.count, okRow });

  // 「导出后又排了期、还没录估算」是最常见的一类变更，`plansForDrift` 用 LEFT JOIN 就是为它开的
  await api('PATCH', '/plans/pl-unest', { title: '未估算的行（导出后排期改动）' });
  const afterUnest = (await get()).checks.changedSinceExport;
  const unestRow = (afterUnest.rows as Array<Record<string, any>>).find((r) => r.planId === 'pl-unest');
  ok('R-11d2 尚无估算行的计划也被点名（estimateUpdatedAt=null 不参与比较，而不是被整行漏掉）',
    afterUnest.count === 3 && unestRow !== undefined && unestRow.estimateUpdatedAt === null
    && JSON.stringify(unestRow.changed) === JSON.stringify(['plan']),
    { count: afterUnest.count, unestRow });

  const exp2 = await fetch(`${BASE}/api/estimates/export-xlsx?${qs}&scope=estimated_only`);
  const s2 = exp2.headers.get('x-estimate-snapshot') ?? '';
  const again = (await get()).checks.changedSinceExport;
  ok('R-11e 第二次导出后「上次导出」取最近一条而不是最早一条，提示再次归零',
    exp2.status === 200 && s2 !== '' && s2 !== s1 && again.snapshotId === s2 && again.count === 0,
    { s1, s2, snapshotId: again.snapshotId, count: again.count });

  const both = await api('PATCH', '/plans/pl-high', { title: '偏差-偏高（同名双改）' });
  await api('PATCH', `/estimates/pl-high?${qs}`, { optimistic: 9 });
  const bothRow = ((await get()).checks.changedSinceExport.rows as Array<Record<string, any>>)
    .find((r) => r.planId === 'pl-high');
  ok('R-11f 两侧都改过的行 changed 同时含 plan 与 estimate（提示文案能点名「改了哪一侧」）',
    both.status === 200 && JSON.stringify(bothRow?.changed) === JSON.stringify(['plan', 'estimate']), bothRow);

  const snaps = await api('GET', `/estimates/snapshots?${qs}&limit=5`);
  const ids = (snaps.json.snapshots as Array<Record<string, any>>).map((s) => s.id);
  ok('R-11g 点名所依据的「最近一条」与快照列表首条同 id（同一份数据，不是提示与列表各查各的）',
    ids.length >= 2 && ids[0] === s2 && ids[1] === s1, ids);
}

console.log('\n=== X 段：导出件的产物事实（字节 + 回读内容，不看文案看数据） ===');
{
  /** `Content-Disposition: attachment; filename*=UTF-8''<百分号编码件名>`（§6.3 响应头契约，只此一种写法） */
  const cdName = (cd: string | null): string => {
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd ?? '');
    return m ? decodeURIComponent(m[1]) : '';
  };
  /** 从件名反解出**本地时钟**的时间戳（`exportStamp` 用的就是本地时间，故按本地构造再交回产品函数） */
  const stampOf = (name: string): Date => {
    const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:\.[A-Za-z]+)?$/.exec(name);
    return m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
      : new Date(NaN);
  };
  const snapshotRows = async (): Promise<Array<Record<string, any>>> =>
    ((await api('GET', `/estimates/snapshots?${qs}&limit=50`)).json.snapshots as Array<Record<string, any>>) ?? [];
  const snapById = async (id: string): Promise<Record<string, any> | null> => {
    const row = (await snapshotRows()).find((s) => s.id === id);
    if (!row) return null;
    try { return JSON.parse(String(row.payload)) as Record<string, any>; } catch { return null; }
  };

  const plans0 = (await api('GET', `/plans?projectId=${PID}`)).json as unknown as Array<Record<string, any>>;
  const nonMsIds = plans0.filter((p) => p.kind !== 'milestone').map((p) => String(p.id)).sort();
  const sum0 = (await get()).summary;

  const expInt = await fetch(`${BASE}/api/estimates/export-xlsx?${qs}`);
  const bufInt = Buffer.from(await expInt.arrayBuffer());
  const nameInt = cdName(expInt.headers.get('content-disposition'));
  const snapInt = expInt.headers.get('x-estimate-snapshot') ?? '';
  const wbInt = await loadWb(bufInt);
  const namesInt = wbInt.worksheets.map((w: import('exceljs').Worksheet) => w.name);
  ok('X-01 内部版 xlsx 是真·xlsx 字节（PK 头 + 体量合理 + 声明为电子表格里格式），不是把文案塞进文本文件',
    expInt.status === 200 && bufInt.subarray(0, 2).toString('hex') === '504b' && bufInt.length > 8_000
    && String(expInt.headers.get('content-type')).includes('spreadsheetml'),
    { status: expInt.status, 头: bufInt.subarray(0, 4).toString('hex'), 字节: bufInt.length });
  ok('X-02 三张 sheet 名逐张都在且没有第四张（表名取产品的 SHEET_* 常量，门不抄中文名）',
    JSON.stringify(namesInt) === JSON.stringify([SHEET_MAIN, SHEET_DETAIL, SHEET_PARAMS]), namesInt);

  const det = wbInt.getWorksheet(SHEET_DETAIL);
  // 明细 sheet 的 plan_id 列：按表头反查列号，别把列序写死进门（列名是技术标识，不是文案）
  let planCol = 0;
  det.getRow(1).eachCell((cell: import('exceljs').Cell, n: number) => {
    if (String(cell.value ?? '') === 'plan_id') planCol = n;
  });
  const dataIds: string[] = [];
  for (let r = 2; r <= det.rowCount; r++) {
    const v = planCol ? det.getCell(r, planCol).value : null;
    if (typeof v === 'string' && v) dataIds.push(v);
  }
  ok('X-03 明细 sheet 的行集 = 在架非里程碑计划（逐字同集合，一条不多一条不少）——里程碑不重复计是 §4.6 的红线',
    planCol > 0 && dataIds.length === nonMsIds.length
    && [...dataIds].sort().join('|') === nonMsIds.join('|'),
    { planCol, 件内: dataIds.slice().sort(), 库内: nonMsIds });

  const main = wbInt.getWorksheet(SHEET_MAIN);
  const projNameCell = String(main.getCell('D3').value ?? '');
  const dateCell = String(main.getCell('D2').value ?? '');
  ok('X-04 主表把项目名与估算日期写进单元格（值在 D 列，标签在 B/C 列），不是只写在文件名里',
    projNameCell === PROJ_NAME && dateCell === new Date().toISOString().slice(0, 10),
    { projNameCell, dateCell });

  const parNums: number[] = [];
  wbInt.getWorksheet(SHEET_PARAMS).eachRow((row: import('exceljs').Row) => {
    row.eachCell((c: import('exceljs').Cell) => { if (typeof c.value === 'number') parNums.push(c.value); });
  });
  const hasNum = (v: number): boolean => parNums.some((n) => Math.abs(n - v) < 1e-6);
  ok('X-05 参数 sheet 里回读得到库内 ΣE 与实际预估人月（导出件带的数就是当刻数出来的数，不是模板占位）',
    hasNum(sum0.directManDays.expected) && hasNum(sum0.actualManMonths.expected),
    parNums.slice(0, 16));

  const expCli = await fetch(`${BASE}/api/estimates/export-xlsx?${qs}&audience=client`);
  const bufCli = Buffer.from(await expCli.arrayBuffer());
  const nameCli = cdName(expCli.headers.get('content-disposition'));
  const wbCli = await loadWb(bufCli);
  ok('X-06 客户版不产出明细/参数 sheet（§6.2 脱敏发生在服务端组装阶段，不是前端隐藏）',
    expCli.status === 200 && wbCli.worksheets.length === 1 && wbCli.worksheets[0].name === SHEET_MAIN,
    wbCli.worksheets.map((w: import('exceljs').Worksheet) => w.name));
  ok('X-07 客户版与内部版是两份不同字节（同项目同时刻，差异不是「换个后缀」）',
    !bufCli.equals(bufInt) && bufCli.length !== bufInt.length, { 内部: bufInt.length, 客户: bufCli.length });
  ok('X-08 件名前缀与客户版标记都取单源常量：客户版带标记、内部版不带',
    nameCli.includes(ESTIMATE_FILE_CLIENT_MARK) && !nameInt.includes(ESTIMATE_FILE_CLIENT_MARK)
    && nameInt.startsWith(ESTIMATE_FILE_BASE) && nameCli.startsWith(ESTIMATE_FILE_BASE), { nameInt, nameCli });
  const dInt = stampOf(nameInt);
  const dCli = stampOf(nameCli);
  ok('X-09 件名可由产品自己的 estimateArtifactName 逐字符复现（正算两份都对上，门里不抄模板串）',
    !Number.isNaN(dInt.getTime()) && estimateArtifactName(PROJ_NAME, 'internal', dInt) + '.xlsx' === nameInt
    && estimateArtifactName(PROJ_NAME, 'client', dCli) + '.xlsx' === nameCli,
    { nameInt, 复现: `${estimateArtifactName(PROJ_NAME, 'internal', dInt)}.xlsx` });
  ok('X-09b 反证：受众换成 client、或时间戳挪一秒，件名即不同（X-09 不是「任意串都能过」的宽松匹配）',
    estimateArtifactName(PROJ_NAME, 'client', dInt) + '.xlsx' !== nameInt
    && estimateArtifactName(PROJ_NAME, 'internal', new Date(dInt.getTime() + 1000)) + '.xlsx' !== nameInt,
    { nameInt, 换受众: `${estimateArtifactName(PROJ_NAME, 'client', dInt)}.xlsx` });

  const expPdf = await fetch(`${BASE}/api/estimates/export-pdf?${qs}`);
  const bufPdf = Buffer.from(await expPdf.arrayBuffer());
  ok('X-10 PDF 端点产出真件：%PDF- 头 + %%EOF 尾 + 声明为 application/pdf（渲染链跑完，不是半份文件）',
    expPdf.status === 200 && bufPdf.subarray(0, 5).toString() === '%PDF-'
    && bufPdf.subarray(-64).toString().includes('%%EOF')
    && String(expPdf.headers.get('content-type')).includes('pdf') && bufPdf.length > 4_000,
    { 头: bufPdf.subarray(0, 8).toString(), 尾: bufPdf.subarray(-16).toString(), 字节: bufPdf.length });

  const pay = await snapById(snapInt);
  ok('X-11 快照 payload 的汇总与当刻 GET /estimates 逐字相同，且带 projectId/项目名/范围/受众定位字段',
    pay !== null && pay.projectId === PID && pay.projectName === PROJ_NAME
    && pay.scope === 'all' && pay.audience === 'internal'
    && pay.directManDays?.expected === sum0.directManDays.expected
    && pay.actualManMonths?.expected === sum0.actualManMonths.expected,
    { 响应头快照: snapInt, payload: pay ? { ...pay, phases: undefined, summary: undefined } : null });
  ok('X-11b payload 的阶段筛选等于产品自己的阶段词表（不传即全阶段），明细行数与库内计划数对得上',
    pay !== null && JSON.stringify(pay.phaseFilter) === JSON.stringify([...ESTIMATE_META.phases])
    && pay.detailRows === plans0.length,
    { phaseFilter: pay?.phaseFilter, detailRows: pay?.detailRows, 计划数: plans0.length });

  // ---- 坏参数的导出请求：拒的是这一条，不是这条端点 ----
  const cntBefore = (await snapshotRows()).length;
  const newestBefore = (await snapshotRows())[0]?.id ?? '';
  const badAud = await api('GET', `/estimates/export-xlsx?${qs}&audience=both`);
  const badScp = await api('GET', `/estimates/export-xlsx?${qs}&scope=bogus`);
  const badPhs = await api('GET', `/estimates/export-xlsx?${qs}&phases=dev,zzz-phase`);
  const badEmpty = await api('GET', `/estimates/export-xlsx?${qs}&phases=,,,`);
  const badPdfAud = await api('GET', `/estimates/export-pdf?${qs}&audience=both`);
  const rowsAfter = await snapshotRows();
  const cntAfter = rowsAfter.length;
  const newestAfter = rowsAfter[0]?.id ?? '';
  const okExp = await fetch(`${BASE}/api/estimates/export-xlsx?${qs}&scope=estimated_only`);
  const okExpBuf = Buffer.from(await okExp.arrayBuffer());
  const snapOkCtrl = okExp.headers.get('x-estimate-snapshot') ?? '';
  const newestCtrl = (await snapshotRows())[0]?.id ?? '';
  const noNewSnapshot = (): boolean => cntAfter === cntBefore && newestAfter === newestBefore;

  rejectedPair('X-12 受众词表外的 xlsx 请求真被拒：400 + 一条快照都没写 + 合法受众（estimated_only）照出件',
    badAud, ESTIMATE_ERRORS.unknownAudience,
    () => noNewSnapshot() && okExp.status === 200 && okExpBuf.subarray(0, 2).toString('hex') === '504b'
      && snapOkCtrl !== '' && newestCtrl === snapOkCtrl);
  sameSource.push({ label: 'X-12', server: String(badAud.json.error ?? ''), mine: inProc.badAudience });
  rejectedPair('X-12b 同一条坏受众打在 PDF 端点上回的是同一句拒辞（两格式共用一个解析器）',
    badPdfAud, ESTIMATE_ERRORS.unknownAudience, () => noNewSnapshot()
    && String(badPdfAud.json.error ?? '') === String(badAud.json.error ?? ''));
  sameSource.push({ label: 'X-12b', server: String(badPdfAud.json.error ?? ''), mine: inProc.badAudience });
  rejectedPair('X-13 未知导出范围 → 真被拒（不静默回落成 all，报价范围悄悄变过就是钱）',
    badScp, [ESTIMATE_ERRORS.unknownScope, ESTIMATE_EXPORT_SCOPES.join(' / ')], () => noNewSnapshot());
  sameSource.push({ label: 'X-13', server: String(badScp.json.error ?? ''), mine: inProc.badScope });
  rejectedPair('X-14 未知阶段筛选 → 真被拒且列出产品自己的阶段词表',
    badPhs, [ESTIMATE_ERRORS.unknownPhase, ESTIMATE_META.phases.join(' / ')], () => noNewSnapshot());
  sameSource.push({ label: 'X-14', server: String(badPhs.json.error ?? ''), mine: inProc.badPhases });
  rejectedPair('X-15 逗号把阶段筛选举空（`phases=,,,`）也拒——空列表会被下游当成「全阶段」，范围又悄悄变了',
    badEmpty, ESTIMATE_ERRORS.emptyPhases, () => noNewSnapshot());
  sameSource.push({ label: 'X-15', server: String(badEmpty.json.error ?? ''), mine: inProc.emptyPhases });
  ok('X-16 合法对照导出确实写了新快照（上面几条的「零副作用」不是靠端点整体失效蒙出来的）',
    okExp.status === 200 && snapOkCtrl !== '' && newestCtrl === snapOkCtrl && (await snapById(snapOkCtrl)) !== null,
    { snapOkCtrl, newestCtrl });
}

// R-12 归档计划不进 drift 统计（§3.1 B5 视图层过滤在 §7 落地后仍然成立）
{
  const arc = await api('POST', '/plans/pl-expired/archive', {});
  const data = await get();
  const visible = (data.items as Item[]).filter((i) => i.plan_id === 'pl-expired');
  const arch = await api('GET', `/estimates?${qs}&includeArchived=1`);
  const withArchived = (arch.json.items as Item[]).filter((i) => i.plan_id === 'pl-expired');
  ok('R-12 归档计划的估算行默认不出现在明细里，includeArchived=1 才带出来（且仍带 drift 字段）',
    arc.status === 200 && visible.length === 0 && withArchived.length === 1
    && typeof withArchived[0].drift.remainingWorkdays === 'number',
    { visible: visible.length, withArchived: withArchived.length, drift: withArchived[0]?.drift });
  /** checks.drift 的四个计数必须等于「同一视图 items」的逐行统计（默认视图与含归档视图都成立） */
  const countsMatch = (payload: Record<string, any>): boolean => {
    const its = payload.items as Item[];
    const c = payload.checks.drift;
    const n = (f: (i: Item) => boolean) => its.filter(f).length;
    return c.high === n((i) => i.drift.flag === 'high') && c.low === n((i) => i.drift.flag === 'low')
      && c.locked === n((i) => i.drift.locked) && c.pressure === n((i) => i.drift.pressure);
  };
  ok('R-12b checks.drift 与 items 同筛选范围：两个视图各自的计数都对得上自己的逐行统计',
    countsMatch(data) && countsMatch(arch.json),
    { now: data.checks.drift, all: arch.json.checks.drift });
  await api('POST', '/plans/pl-expired/restore', {});
}

const logText = serverLog.join('');
ok('R-13 服务日志无 §7/试算相关异常',
  !/estimates[\s\S]{0,200}(Error|异常|unhandled|TypeError)/i.test(logText) && !/UnhandledPromiseRejection/.test(logText),
  logText.split('\n').filter((l) => /error|异常|typeerror/i.test(l)).slice(0, 3));

console.log('\n=== H 段：跨进程同源自证 + 配对器反证（T02293 判据 4） ===');
{
  // 上面每条被拒的文案出自**隔离服务进程**，门进程只持有单源词表与产品自己导出的枚举清单。
  // 若门抄的是整句当下措辞，产品改词后本应一起红的两侧会分成「行为在、锚点失配」——配对器能分辨，
  // 但更彻底的做法是直接证明两边读的是同一张表：H-01 逐条命中，H-03 同入参逐字符相同。
  const explainers = [
    ...Object.values(ESTIMATE_ERRORS),
    ...Object.values(ESTIMATE_POINT_LABELS),
    ESTIMATE_COEF_KEYS.join(' / '),
    ESTIMATE_META.phases.join(' / '),
    ESTIMATE_EXPORT_SCOPES.join(' / '),
  ];
  const h1Miss = restRejects.filter((r) => !explainers.some((s) => r.error.includes(s)));
  ok('H-01 服务端被拒原文逐条命中门进程的单源词干/产品导出清单（≥8 条全中）',
    restRejects.length >= 8 && h1Miss.length === 0,
    { 条数: restRejects.length, 未命中: h1Miss.map((r) => `${r.label}→${r.error.slice(0, 60)}`) });
  ok('H-02 假词干（改名模拟的 ZZZ- 前缀 + 本门不存在的措辞）对全部被拒原文零命中（H-01 不是恒真式）',
    restRejects.length > 0 && restRejects.every((r) => !r.error.includes('ZZZ-') && !r.error.includes('未知天晓得')),
    restRejects.map((r) => r.error.slice(0, 40)));
  const h3Bad = sameSource.filter((x) => x.server !== x.mine);
  ok('H-03 同一入参在服务端与门进程直调产品函数产出的文案逐字符相同（REST 400 体是裸 { error }，没有信封要剥）',
    sameSource.length >= 8 && h3Bad.length === 0,
    sameSource.map((x) => ({
      label: x.label, 相同: x.server === x.mine,
      服务端: x.server.slice(0, 56), 门进程: x.mine.slice(0, 56),
    })));
  ok('H-04 路由层拼装的系数档名错误由两个产品自己的部件解释得通（点名越界键 + 逐字列出导出的系数档清单）',
    !!bogusCoefParts && bogusCoefParts.server.includes(bogusCoefParts.bad)
    && bogusCoefParts.server.includes(bogusCoefParts.list) && bogusCoefParts.list === ESTIMATE_COEF_KEYS.join(' / '),
    bogusCoefParts);

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
  // 这一支钉的是「R-03/R-04 的绿不是文案给的」：只看 `includes(词干)` 的门会照样放行这份假件。
  {
    const fakeMsg = inProc.readonlyUpsert;
    const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    okPair((name, cond, extra) => spy.push({ name, cond, extra }), '伪造件：收口行报「已收口」但 PATCH 其实写成了 200',
      () => false, () => fakeMsg.includes(ESTIMATE_ERRORS.milestoneReadonly));
    ok('H-06 反证：单源词干原样出现在「没有拒绝」的响应里，配对器仍判红（红因指行为）',
      spy.length === 1 && spy[0].cond === false && String((spy[0].extra as any)?.红因 ?? '').includes('行为失守')
      && fakeMsg.includes(ESTIMATE_ERRORS.milestoneReadonly), spy);
  }
  // 反证三 · 「把什么都拒掉」换不来绿：坏请求 400 + 文案对，但合法对照也 400 时配对器必须判红。
  {
    const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    const fakeBad = { status: 400, json: { error: inProc.paramMax } };
    okPair((name, cond, extra) => spy.push({ name, cond, extra }), '伪造件：闸门全关（越界被拒、合法回写也被拒）',
      () => fakeBad.status === 400 && false,
      () => String(fakeBad.json.error).includes(ESTIMATE_ERRORS.paramMax));
    ok('H-07 反证：合法对照被一并拒掉时配对器判红（本门的绿建立在「坏的被拒、好的仍能过」两侧都成立上）',
      spy.length === 1 && spy[0].cond === false && String((spy[0].extra as any)?.红因 ?? '').includes('行为失守'), spy);
  }
  // 反证四 · 导出件的「产物事实」同样有牙：糊一个以 PK 开头的空壳件，X-01 的体量判据必须翻假、
  // exceljs 也必须回读不出工作簿——否则 X 段那几条字节断言是恒真式。
  {
    const fakeBuf = Buffer.concat([Buffer.from('504b', 'hex'), Buffer.alloc(64)]);
    const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    okPair((name, cond, extra) => spy.push({ name, cond, extra }), '伪造件：只糊了个 PK 头的空壳件',
      () => fakeBuf.subarray(0, 2).toString('hex') === '504b' && fakeBuf.length > 8_000,
      () => fakeBuf.length > 0);
    let loadErr = '';
    try { await loadWb(fakeBuf); } catch (e) { loadErr = e instanceof Error ? e.name : String(e); }
    ok('X-17 反证：假 xlsx（PK 头 + 空体积）过不了体量判据、exceljs 也回读不出工作簿（X-01/X-02 不是恒真式）',
      spy.length === 1 && spy[0].cond === false && loadErr !== '', { 判据: spy[0]?.cond, 回读异常: loadErr });
  }
}

child.kill();
await new Promise((r) => setTimeout(r, 600));
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\nPASS=${pass} FAIL=${fail}`);
console.log(`（系数档清单：${ESTIMATE_COEF_KEYS.join(' / ')}）`);
process.exit(fail === 0 ? 0 : 1);
