/**
 * T02104 门：交付命名与令牌换文件（PRD §3.5 FR-5 / 技术方案 §2.4）。
 * 本文件为 T02293「按 `docs/验收门判据规约.md` 四条硬判据改判」版。
 *
 * 改判前的问题（S 组 + U-10）：判据打在源码文本上——`/export const DOWNLOAD_NAME_RE/.test(源码)`、
 * `/DOWNLOAD_NAME_RE\.test\(filename\)/.test(index.ts)`、`/downloadSafeName\(/.test(kickoffService.ts)`、
 * `!/export function safeExportName/.test(plans.ts)`、`/MTask-ai-report\.xlsx/.test(index.ts)` 等。
 * 等价重构一改写法门即恒红，而「白名单与生成侧清洗是否真的同源」这一真实风险（分叉后果＝下载静默
 * 回退成 xlsx 兜名）门却看不见。改判为：
 *
 *  P 组 白名单判定行为一致性（替原 S-01/S-02/S-06）：把一批「洗后名 + 未洗脏名」逐条经隔离实例
 *        `/report/ai-download` 真下载，端点接受/兜名的判定必须与 `util.DOWNLOAD_NAME_RE` 逐名一致；
 *        不通过时端点命中兜名分支（Content-Type 报 xlsx、字节仍是 pptx）＝FR-5 静默坑真实存在。
 *        保留的字面锚（正则单源、端点引用它、注释机理）走 `okPair`，只在行为侧为绿时才参与判绿。
 *  G 组 生成侧清洗接线（替原 S-03/S-04）：脏名项目经 `kickoffFileName` 出稿后逐个真过下载端点＝
 *        与下载侧同源；`safeExportName` 作为 util 单源函数的字段级行为 + 两处引用不本地定义的 `okPair`。
 *  R 组 A-2 裁决（替原 S-05）：走查运行时 `api.stack` 路由表——`/report/ai-download` 在位、
 *        且没有新增 `kickoff-ppt-download` 端点（判的是「注册了什么」，不是「源码里写了什么」）。
 *  U 组 downloadSafeName 纯函数（U-01~U-10，返回值即判据，无源码文本）。
 *  N 组 kickoffFileName §2.4 形态（返回值判据）。
 *  E 组 隔离实例真下载端点（Content-Type/Content-Disposition/RFC5987/下载即删/字节原样）。
 *  X 组 负对照：篡改白名单口径 / 裸拼未洗名 / 空路由表 / 剥掉 import / 让一切命中兜名——
 *        逐条证明 P/G/R/E 的判据在行为被破坏时确实变红（判据 4）。
 *
 * 判据口径：产品代码字面锚一律取 `git show HEAD:<path>`（plans.ts/estimates.ts 工作树可能躺着并发 WIP，
 * 反模式 11）；运行时面（端点行为、路由表）由门自己 spawn 的隔离实例给出；夹具全门内自造，
 * 不依赖任何生产业务行、绝不读写生产库或生产实例。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02104-kickoff-naming.mts
 * 环境变量：`T02104_PORT`（默认随机 39800+rand300，被占用时改传）、`T02104_TMP_ROOT`（默认 D:/code/tmp，必须落可写盘）。
 * 结果落 .workbuddy/t02104-gate-results-<运行标识>.txt（口径见 scripts/lib/gate-results.mts）。
 */
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02104_PORT ?? 39_800 + Math.floor(Math.random() * 300));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02104-gate-results.txt';

// 临时根落 D:（本机 C: 常年 0 可用，指过去会假性 SQLITE_FULL 把绿判成红）——定完数据目录再 import 产品模块
const TMP_ROOT = process.env.T02104_TMP_ROOT ?? 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02104-naming-'));
process.env.MTask_DATA_DIR = DATA_DIR; // ⚠ 先定隔离库：import 的任何产品模块 getDb() 都指到这里，绝不连生产库
const TMP_DIR = join(DATA_DIR, 'tmp');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  lines.push(`[SKIP] ${range} —— ${why}（不计 PASS）`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 字面锚一律读**已提交树**：工作树里的 plans.ts/estimates.ts 可能是并发会话的过期 WIP（反模式 11） */
const gitCache = new Map<string, string | null>();
function headSource(rel: string): string | null {
  if (gitCache.has(rel)) return gitCache.get(rel);
  let out: string | null = null;
  try { out = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' }); }
  catch { out = null; }
  gitCache.set(rel, out);
  return out;
}

// 运行时面：util（纯函数）+ kickoffService（kickoffFileName），二者在 HEAD 与工作树一致（未列入并发 WIP）
const U = await import('../server/src/util/export-name.ts') as Record<string, any>;
const S = await import('../server/src/services/kickoffService.ts') as Record<string, any>;

// =====================================================================
// 判据函数（正判与负对照共用同一实现）
// =====================================================================
/** 下载端点的接受/拒绝口径：Content-Disposition 逐字回送＝接受；回成兜名＝拒绝 */
const FALLBACK = 'MTask-ai-report.xlsx';

/** 「端点判定 == 白名单判定」的差异清单。whitelist 参数可被负对照换成一个分叉的假口径 */
function judgeWhitelistAgreement(
  decisions: Array<{ name: string; endpoint: 'accept' | 'fallback' | 'other' }>,
  whitelist: (n: string) => boolean,
): string[] {
  return decisions
    .filter((d) => (whitelist(d.name) ? 'accept' : 'fallback') !== d.endpoint)
    .map((d) => `${d.name}：端点=${d.endpoint}，白名单=${whitelist(d.name) ? 'accept' : 'fallback'}`);
}

// =====================================================================
// U 组：downloadSafeName 纯函数（字段级处置 + 属性测试；返回值即判据）
// =====================================================================
ok('U-01 常规名逐字不动（清洗不该动合法字符）',
  U.downloadSafeName('项目启动会-mtask五期-20261013', '项目启动会') === '项目启动会-mtask五期-20261013');
ok('U-02 路径分隔与控制字符逐个换成 -（防 ../ 与换行注入）',
  U.downloadSafeName('a/b\\c:d*e?f"g<h>i|j\nk', 'x') === 'a-b-c-d-e-f-g-h-i-j-k');
ok('U-03 白名单外字符被处置（& # + 全角括号 中文标点 全角空格 emoji）',
  (() => {
    const dirty = '五期&A&B<C>#1 项目（kickoff） 测试 +emoji😀';
    return U.downloadSafeName(dirty, 'x').split('').every((ch) => /[A-Za-z0-9_\-().·\u4e00-\u9fa5 ]/.test(ch));
  })());
ok('U-04 前导点/尾随分隔剥掉（防 "..pptx" 与以 - 收尾的怪名）',
  U.downloadSafeName('..甲..', 'x') === '甲' && U.downloadSafeName('乙--', 'x') === '乙');
ok('U-05 洗空了才用兜名（兜名本身必须过白名单）',
  U.downloadSafeName('///***???', '项目启动会') === '项目启动会' &&
  U.downloadSafeName('', '项目启动会') === '项目启动会' &&
  U.DOWNLOAD_NAME_RE.test(`${U.downloadSafeName('', '项目启动会')}.pptx`));
ok('U-06 长度上限 80 且截断后仍过白名单',
  (() => {
    const long = U.downloadSafeName('项'.repeat(200), 'x');
    return long.length === 80 && U.DOWNLOAD_NAME_RE.test(`${long}.pptx`);
  })());
ok('U-07 连续分隔折叠（a//b → a-b，不是 a--b）', U.downloadSafeName('a//b', 'x') === 'a-b');
ok('U-08 属性测试：30+ 脏名洗后 + .pptx 必然通过下载白名单',
  (() => {
    const nasty = ['a/b', 'c:d', 'e*f', 'g?h', 'i"j', 'k<l>m', 'n|o', 'p\nq', '  空格  项目  ',
      '&amp&', '#1 期', 'kickoff+v1', '（全角括号）', '【中括号】', '《书名号》', '，、；：！？',
      '😀emoji', '混CLEAN中文', '..lead', 'trail..', 'a'.repeat(300), '项目启动会'.repeat(40),
      '\\\\双反斜杠', '%percent%', "'quote'", 'tab\tsep', 'null\0char', '中文-下划_线.点', '·间隔号·',
      '(半角括号)', '五期 2026-10-13'];
    return nasty.every((n) => U.DOWNLOAD_NAME_RE.test(`${U.downloadSafeName(n, '项目启动会')}.pptx`));
  })());
ok('U-09 反例钉：未清洗的脏名 + .pptx 确实过不了白名单（证明清洗是必需而非臆想）',
  ['五期&kickoff.pptx', '项目（五期）.pptx', 'a/b.pptx', '五期【2026】.pptx', 'a%b.pptx']
    .every((n) => !U.DOWNLOAD_NAME_RE.test(n)));
ok('U-10 safeExportName 是 util 导出的单源清洗函数（洗到无路径分隔/控制字符、空入参回兜名）',
  typeof U.safeExportName === 'function' &&
  U.safeExportName('a/b\\c:d*e?f:g', 'fb') === 'a-b-c-d-e-f-g' &&
  U.safeExportName('', 'fb') === 'fb' &&
  U.safeExportName('x'.repeat(200), 'fb').length <= 80);

// =====================================================================
// N 组：kickoffFileName（§2.4 形态，返回值判据）
// =====================================================================
ok('N-01 正常项目名逐字钉：项目启动会-<项目名>-<YYYYMMDD>.pptx（与 T02103 O-12 同钉防回归）',
  S.kickoffFileName('mtask五期', '2026-10-13') === '项目启动会-mtask五期-20261013.pptx');
ok('N-02 脏名项目出稿名仍可下载（含 / : & （） 仍过白名单）',
  (() => {
    const f = S.kickoffFileName('五期/启动：A&B（草稿）', '2026-10-13');
    return U.DOWNLOAD_NAME_RE.test(f) && f.endsWith('.pptx') && f.includes('20261013');
  })(), S.kickoffFileName('五期/启动：A&B（草稿）', '2026-10-13'));
ok('N-03 名字永远以 项目启动会- 起手或就是兜名（前缀不被清洗吃掉）',
  S.kickoffFileName('mtask五期', '2026-10-13').startsWith('项目启动会-') &&
  U.DOWNLOAD_NAME_RE.test(S.kickoffFileName('', '2026-10-13')));
ok('N-04 日期串保头去横杠（YYYYMMDD），空日期不产生尾随 - 悬空',
  S.kickoffFileName('p', '2026-10-13').includes('20261013') &&
  U.DOWNLOAD_NAME_RE.test(S.kickoffFileName('p', '')));

// =====================================================================
// E/P/R 组：隔离实例真下载端点 + 运行时路由表（隔离库 + 临时目录，不调模型）
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
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

/** 放一份 pptx 字节进 tmp 换令牌：本门只验「名字与下载头」，产物真实性由 T02103 E-03 把守 */
function putTmp(bytes: Buffer): string {
  const token = randomUUID();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, token), bytes);
  return token;
}
async function download(token: string, filename: string) {
  const res = await fetch(`${BASE}/report/ai-download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, filename }),
  });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}
const dispositionName = (h: Headers): string => {
  const raw = h.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(raw);
  return m ? decodeURIComponent(m[1]) : raw;
};
const mkPptx = (mark: string) => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from(mark.repeat(64))]);

/** 端点判定：接受（逐字回送）/ 拒绝（命中兜名）/ 其它（异常，理论不该出现） */
async function endpointDecide(name: string): Promise<'accept' | 'fallback' | 'other'> {
  const r = await download(putTmp(mkPptx('X')), name);
  if (r.status !== 200) return 'other';
  const disp = dispositionName(r.headers);
  if (disp === name) return 'accept';
  if (disp === FALLBACK) return 'fallback';
  return 'other';
}

if (!(await waitUp())) {
  ok('E-00 隔离实例启动', false, serverLog.join('').slice(-600));
  skipped('P/G/R/E/X 全组', '隔离实例未启动，端点行为与运行时路由表判据无法取数（不以源码文本冒充 PASS）');
} else {
  ok('E-00 隔离实例启动', true);
  // 隔离库由产品 initSchema() 自建：门不复制、不读写生产库（判据 2）
  {
    const res = await fetch(`${BASE}/projects`);
    const arr = (await res.json().catch(() => null)) as Array<{ id?: string }> | null;
    // 隔离库只含产品 initSchema 自种的系统收件箱（sys-inbox），没有任何生产业务行被带进实例
    const onlySystemInbox = Array.isArray(arr) && arr.every((p) => p.id === 'sys-inbox');
    ok('E-00a 隔离库经产品 initSchema() 自建、门零生产业务行（除自种收件箱外无项目，下载链路不依赖存量数据）',
      res.status === 200 && Array.isArray(arr) && onlySystemInbox,
      { status: res.status, ids: Array.isArray(arr) ? arr.map((p) => p.id) : res.status });
  }

  // ---------------- P 组：白名单判定行为一致性（端点判定 == util 白名单判定） ----------------
  const probeNames: string[] = [...new Set([
    S.kickoffFileName('mtask五期', '2026-10-13'),
    S.kickoffFileName('五期/启动：A&B（草稿）', '2026-10-13'),
    S.kickoffFileName('五期·启动会 验收', '2026-10-13'),
    '项目启动会.pptx', 'x.pptx', 'MTask-ai-report.xlsx', '报告.docx', 'a.pdf',
    '未洗脏名&kickoff.pptx', '项目（五期）.pptx', 'a/b.pptx', '五期【2026】.pptx', 'a%b.pptx', 'bad<>name.pptx',
  ])];
  const decisions: Array<{ name: string; endpoint: 'accept' | 'fallback' | 'other' }> = [];
  for (const n of probeNames) decisions.push({ name: n, endpoint: await endpointDecide(n) });

  okPair(ok,
    'P-01 端点的接受/拒绝判定与 util DOWNLOAD_NAME_RE 逐名一致（下载白名单真单源，不存在第二份分叉正则）',
    () => judgeWhitelistAgreement(decisions, (n) => U.DOWNLOAD_NAME_RE.test(n)).length === 0 &&
      decisions.filter((d) => d.endpoint === 'accept').length >= 6 &&
      decisions.filter((d) => d.endpoint === 'fallback').length >= 5,
    () => {
      const util = headSource('server/src/util/export-name.ts') ?? '';
      const index = headSource('server/src/routes/index.ts') ?? '';
      return /export const DOWNLOAD_NAME_RE = /.test(util) &&
        /DOWNLOAD_NAME_RE\.test\(filename\)/.test(index) &&
        /from '\.\.\/util\/export-name'/.test(index);
    },
    () => ({ 探针数: decisions.length, 差异: judgeWhitelistAgreement(decisions, (n) => U.DOWNLOAD_NAME_RE.test(n)) }));

  // 兜名分支真实存在（内容 pptx、名 xlsx）＝FR-5 静默坑的可观测后果
  {
    const bad = '未洗脏名&kickoff.pptx';
    const r = await download(putTmp(mkPptx('H')), bad);
    const disp = dispositionName(r.headers);
    const ct = r.headers.get('content-type') ?? '';
    okPair(ok,
      `P-02 白名单不通过时端点命中兜名分支（名回成 ${FALLBACK}、Content-Type 报 xlsx、而字节仍是我们的 pptx）＝不清洗就会静默换壳`,
      () => r.status === 200 && disp === FALLBACK && /spreadsheetml/.test(ct) &&
        r.buf.subarray(0, 4).toString('hex') === '504b0304' && !U.DOWNLOAD_NAME_RE.test(bad),
      () => {
        const util = headSource('server/src/util/export-name.ts') ?? '';
        return /MTask-ai-report\.xlsx/.test(util) && /回退/.test(util);
      },
      () => ({ disp, ct, head: r.buf.subarray(0, 4).toString('hex') }));
  }

  // ---------------- G 组：生成侧清洗接线（kickoffFileName 与下载侧同源） ----------------
  {
    const dirtyProjects = ['五期/启动：A&B（草稿）', '项目（试）版', 'x:y*z', 'a<b>|c', '五期😀emoji', 'a'.repeat(300)];
    const genNames = dirtyProjects.map((p) => S.kickoffFileName(p, '2026-10-13'));
    const genDecisions: Array<{ name: string; endpoint: 'accept' | 'fallback' | 'other' }> = [];
    for (const nm of genNames) genDecisions.push({ name: nm, endpoint: await endpointDecide(nm) });
    okPair(ok,
      'G-01 脏名项目经 kickoffFileName 出稿后逐个被下载端点原样接受（生成侧确实走清洗、与下载白名单同源）',
      () => genDecisions.every((d) => d.endpoint === 'accept') && genDecisions.length >= 6,
      () => {
        const svc = headSource('server/src/services/kickoffService.ts') ?? '';
        const cut = svc.indexOf('export function kickoffFileName');
        return cut >= 0 && /downloadSafeName\(/.test(svc.slice(cut)) &&
          /from '\.\.\/util\/export-name'/.test(svc);
      },
      () => ({ 出稿名与判定: genDecisions }));

    // X-03：把脏名项目裸拼成文件名（不经 downloadSafeName），未洗名必被端点判成 fallback（证明 G-01 的清洗有牙齿）
    const rawConcat = `项目启动会-五期/启动：A&B（草稿）-20261013.pptx`;
    ok('X-03 清洗有牙齿：脏名项目**不**经 downloadSafeName 直接裸拼成 项目启动会-<原名>-日期.pptx，端点必判 fallback（G-01 的接受不是白捡）',
      !U.DOWNLOAD_NAME_RE.test(rawConcat) && (await endpointDecide(rawConcat)) === 'fallback',
      { 裸拼名: rawConcat, 判定: await endpointDecide(rawConcat) });
  }
  okPair(ok,
    'G-02 safeExportName 单源：plans.ts 不本地定义、estimates.ts 从 util 取（口径不双份，避免两份清洗函数分叉）',
    () => typeof U.safeExportName === 'function' &&
      (() => {
        // 行为侧：util 的这一个函数就是清洗口径本身——脏名洗后不含路径分隔与控制字符
        const cleaned = U.safeExportName('启动会/a\\b:c*d?e"f<g>h|i', 'fb');
        return !/[\\/:*?"<>|]/.test(cleaned) && cleaned === '启动会-a-b-c-d-e-f-g-h-i';
      })(),
    () => {
      const plans = headSource('server/src/routes/plans.ts') ?? '';
      const est = headSource('server/src/routes/estimates.ts') ?? '';
      return !/export function safeExportName/.test(plans) && /safeExportName/.test(plans) &&
        !/safeExportName.*from '\.\/plans'/.test(est) && /from '\.\.\/util\/export-name'/.test(est);
    },
    () => ({ safeExportName类型: typeof U.safeExportName }));

  // ---------------- R 组：A-2 裁决（运行时路由表，非源码文本） ----------------
  let routes: string[] = [];
  try {
    const routesMod = (await import('../server/src/routes/index.ts')) as Record<string, any>;
    const walk = (stack: unknown[], prefix: string) => {
      for (const layer of stack as Array<Record<string, any>>) {
        if (layer.route) {
          const methods = Object.keys(layer.route.methods ?? {}).map((k) => k.toUpperCase()).join(',');
          routes.push(`${methods} ${prefix}${layer.route.path}`);
        } else if ((layer.handle as Record<string, any>)?.stack) {
          let mp = '';
          if (typeof layer.path === 'string' && layer.path.length > 1) mp = layer.path;
          else {
            const s = String(layer.regexp?.source ?? '');
            const a = s.indexOf('^\\/');
            if (a >= 0) {
              let rest = s.slice(a + 3);
              const b = rest.indexOf('\\/?');
              if (b >= 0) rest = rest.slice(0, b);
              mp = rest ? '/' + rest.split('\\/').join('/').split('\\.').join('.') : '';
            }
          }
          walk((layer.handle as Record<string, any>).stack, prefix + mp);
        }
      }
    };
    walk(routesMod.api?.stack ?? [], '');
  } catch (e) {
    skipped('R 组', `路由表 import 失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (routes.length) {
    const hasReuse = routes.some((r) => r.includes('POST') && r.endsWith('/report/ai-download'));
    const forbidden = routes.filter((r) => /kickoff-ppt-download/.test(r));
    ok('R-01 A-2 裁决未走偏（运行时路由表）：复用 /report/ai-download 已注册、且没有新增 kickoff-ppt-download 端点',
      hasReuse && forbidden.length === 0, { 复用端点在位: hasReuse, 违规端点: forbidden, 路由总数: routes.length });
    ok('R-02 路由表本体非空（R-01 的「无 kickoff-ppt-download」不是拿空表比空表）', routes.length >= 150, routes.length);
    ok('X-04 R 判据有牙齿：同一路由表里，一个 PRD 未注册的假端点必须不命中、真复用端点必须命中（不是空表恒真）',
      routes.some((r) => r.endsWith('/report/ai-download')) &&
      !routes.some((r) => r.endsWith('/report/zzz-not-a-route')) && routes.length >= 150,
      { 路由总数: routes.length });
  }

  // ---------------- E 组：隔离实例真端点（既有行为断言，无源码文本） ----------------
  const cleanName = S.kickoffFileName('五期/启动：A&B（草稿）', '2026-10-13');
  const r1 = await download(putTmp(mkPptx('A')), cleanName);
  ok('E-01 清洗后的下载名被接受（200 + pptx MIME + 名字逐字回来）',
    r1.status === 200 && /presentationml/.test(r1.headers.get('content-type') ?? '') &&
    dispositionName(r1.headers) === cleanName,
    { status: r1.status, ct: r1.headers.get('content-type'), name: dispositionName(r1.headers), sent: cleanName });

  const zh = S.kickoffFileName('五期·启动会 验收', '2026-10-13');
  const r2 = await download(putTmp(mkPptx('B')), zh);
  ok('E-02 中文名经 RFC5987 编码可无损还原（无乱码、空格保留）',
    r2.status === 200 && dispositionName(r2.headers) === zh && zh.includes('·'),
    dispositionName(r2.headers));

  const r3 = await download(putTmp(mkPptx('C')), '五期&kickoff.pptx');
  ok('E-03 未清洗脏名被挡下并回退兜名（内容仍是我们的字节，名却变了——正是要修的坑）',
    r3.status === 200 && dispositionName(r3.headers) === FALLBACK,
    dispositionName(r3.headers));

  const t4 = putTmp(mkPptx('D'));
  const first = await download(t4, S.kickoffFileName('mtask五期', '2026-10-13'));
  const second = await download(t4, '项目启动会.pptx');
  ok('E-04 下载即删：二次请求 404 且 tmp 不残留',
    first.status === 200 && second.status === 404 && !existsSync(join(TMP_DIR, t4)),
    { first: first.status, second: second.status });

  ok('E-05 字节原样返回（下载端点不因名字改写内容）',
    r1.buf.subarray(0, 4).toString('hex') === '504b0304' && r1.buf.equals(mkPptx('A')),
    { head: r1.buf.subarray(0, 4).toString('hex'), len: r1.buf.length });

  // =================================================================
  // X 组：负对照（判据 4）——在内存里把被测行为破坏掉，要求同一判据转红
  // =================================================================
  ok('X-01 P-01 判定有牙齿：换成一个更宽的假白名单（只按扩展名放行 & 等脏名），同一 agreement 判据必须报出差异',
    judgeWhitelistAgreement(decisions, (n) => /\.(pptx|xlsx|docx|pdf)$/i.test(n)).length > 0,
    { 假宽白名单差异数: judgeWhitelistAgreement(decisions, (n) => /\.(pptx|xlsx|docx|pdf)$/i.test(n)).length });

  ok('X-02 P-01 判定有牙齿：把端点全判成 accept（模拟「白名单形同虚设、脏名也放过」），agreement 必红',
    judgeWhitelistAgreement(decisions.map((d) => ({ ...d, endpoint: 'accept' as const })), (n) => U.DOWNLOAD_NAME_RE.test(n)).length > 0,
    judgeWhitelistAgreement(decisions.map((d) => ({ ...d, endpoint: 'accept' as const })), (n) => U.DOWNLOAD_NAME_RE.test(n)));

  ok('X-05 兜名判别有牙齿：合法名不被兜名（证明 P-02/E-03 的红是名字特异，不是「什么都兜」）',
    (await endpointDecide('项目启动会-合法名-20261013.pptx')) === 'accept');

  ok('X-06 字面锚 import 判别有牙齿（G-02 字面腿）：从 HEAD 源码里剥掉 util import / 塞回本地定义后同一字面判据必须转假',
    (() => {
      const plans = headSource('server/src/routes/plans.ts') ?? '';
      const est = headSource('server/src/routes/estimates.ts') ?? '';
      const leg = (p: string, e: string) =>
        !/export function safeExportName/.test(p) && /safeExportName/.test(p) &&
        !/safeExportName.*from '\.\/plans'/.test(e) && /from '\.\.\/util\/export-name'/.test(e);
      const tamperedEst = est.replace(/from '\.\.\/util\/export-name'/, "from './local-legacy-name'");
      const tamperedPlans = plans.replace(/import \{ safeExportName \} from '\.\.\/util\/export-name'/, 'export function safeExportName');
      return leg(plans, est) === true && leg(tamperedPlans, est) === false && leg(plans, tamperedEst) === false;
    })(), { plans有本地定义: /export function safeExportName/.test(headSource('server/src/routes/plans.ts') ?? '') });
}

child.kill();
// 隔离目录必须回收（红线 8）：Windows 上刚 kill 的子进程还压着 sqlite 句柄，直接 rm 会 EPERM
for (let i = 0; i < 25; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
    break;
  } catch {
    if (i === 24) lines.push('[WARN] 临时目录未回收（子进程句柄未释放）：' + DATA_DIR);
    await sleep(200);
  }
}
lines.unshift(`T02104 命名与下载门：PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
writeGateResults(OUT_DIR, OUT_BASE, lines.join('\n') + (skippedList.length ? `\n跳过项：\n${skippedList.join('\n')}\n` : ''), { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
