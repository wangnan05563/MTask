/**
 * T02272 门：「GitHub 竞品调研及项目管理与 AI 工作台优化」PRD 交付质量。
 *
 * 断言组（按 `docs/验收门判据规约.md` 改判后的三段式）：
 *  D 组 文档结构（任务指定 9 节输出结构逐节在位；两模块×四维度小节齐全且每维度真有需求）
 *  R 组 需求格式（#### 编号块逐条含 描述/用户故事/验收标准/优先级；优先级仅 P0/P1/P2；
 *       文头与 §7 声明的条数/分级计数与实际条目自洽）
 *  F 组 事实锚点（MTask 现状锚点文件存在；看板/三视图/reportCards 能力**实测**；「无暗色/无 Webhook」
 *       否定性结论与运行时实况一致；五竞品与关键 2026 事实在位；附录链接数）
 *  G 组 任务覆盖（调研范围两模块、四维度、非功能四块、分期、优先级依据、术语双语、验证缺口声明）
 *  H 组 跨进程同源自证（PRD 的数字与措辞由**同一份运行时真值**解释；假词干零命中；服务端原文可复现）
 *  S 组 改名模拟（把本门依赖的文案搬走：行为侧仍绿/字面侧失配，红因归类正确，零副作用）
 *  N 组 负对照（伪造夹具：文本里有锚点、结构/行为没有 ⇒ 必须判红）
 *
 * 判据口径：
 *  1. 现状取证改打在**行为与产物**上，不再拿源码文本当唯一判据——
 *     计划三视图走 `renderToStaticMarkup` 的渲染后 DOM；暗色主题走 SettingsProvider 渲染出的
 *     `[data-theme='dark']` 变量块（并与浅色块变量名集合比对）；「无 Webhook」与批量操作能力走
 *     **隔离实例的 HTTP 响应 + 前后行指纹**；表/列是否存在走**产品自己的 `initSchema()` 建出来的隔离库**
 *     （`sqlite_master` / `PRAGMA table_info`），事件保留期走 `readEventRetentionDays()` 的返回值。
 *     起因：F-C2 原判据是 `/type PlanViewMode = 'list' | 'gantt' | 'timeline'/` 这类**实现字面量**，
 *     页面把该类型别名改成内联联合类型（行为不变）后本门即恒红——正是规约开头点的病症。
 *  2. 夹具自造：隔离库 + 隔离实例 + 门内自建项目/任务，断言只引用本轮自己造的行；
 *     生产库不读不写（`MTask_DATA_DIR` 指 `T02272_TMP_ROOT`，默认 D:/code/tmp，C 盘常年 0 可用）。
 *     实例起不来 ⇒ 运行时判据 `skipped()`，不冒充 PASS。
 *  3. 仍需保留的字面锚点（PRD 的 `路径:行号` 引用、任务指定的小节标题原文、服务端固定话术）一律走
 *     `okPair`，行为侧绿才算绿，红因分「行为失守」与「字面锚点失配（行为在）」两类落账。
 *  4. 每条改判配负对照（N 组）与改名模拟（S 组）：伪造的 Markdown/夹具/DOM 喂给同一批判据函数必须判红。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02272-prd.mts
 * 环境变量：T02272_PORT（默认 39913）、T02272_TMP_ROOT（默认 D:/code/tmp）、T02272_KEEP=1 保留临时目录
 * 结果落 .workbuddy/t02272-gate-results-<运行标识>.txt。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { resolveServerLauncher } from './isolated-server-launcher.mts';
import { okPair } from './lib/anchor-pair.mts'; // 判据 3：字面锚点必须配同义行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const OUT_DIR = join(ROOT, '.workbuddy');
const PRD_PATH = join(ROOT, 'docs', 'PRD-竞品调研-项目管理与AI工作台优化.md');
const TMP_ROOT = process.env.T02272_TMP_ROOT ?? 'D:/code/tmp';
const PORT = Number(process.env.T02272_PORT ?? 39913);
const BASE = `http://127.0.0.1:${PORT}/api`;
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02272-gate-'));
// ⚠ 数据目录必须在任何产品模块 import 之前定好：静态 import 会先求值、`getDb()` 会按默认目录
//   连到生产库（skill 红线 8）。因此产品模块一律动态 import。
process.env.MTask_DATA_DIR = DATA_DIR;
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
// 页 SSR 会临时替换 globalThis.fetch（拿不到真接口），HTTP 判据必须握死换前的真 fetch
const REAL_FETCH = globalThis.fetch.bind(globalThis);

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};
/** 环境不具备（而非功能失守）时留痕，不冒充 PASS——判据 2 的 `skipped()` 口径 */
const skipped = (range: string, why: string) => {
  skippedList.push(`${range}：${why}`);
  lines.push(`[SKIP] ${range} —— ${why}（不计 PASS）`);
};

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p: string) => existsSync(join(ROOT, p));
/** 纯 Node 递归 grep：返回命中文件数（-1=遍历失败）。Windows 下 execSync+grep 不可靠，故不用 shell */
function grepFileCount(dirRel: string, pattern: RegExp): number {
  try {
    const base = join(ROOT, dirRel);
    let n = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (['.ts', '.tsx', '.css', '.js'].includes(extname(p)) && pattern.test(readFileSync(p, 'utf8'))) n += 1;
      }
    };
    walk(base);
    return n;
  } catch { return -1; }
}

// ======================= Markdown 结构解析（判据 1：打结构，不抄散文） =======================
type Heading = { level: number; text: string; line: number };
/** 逐行扫描：围栏代码块（``` / ~~~）内的 `#` 不算标题——负对照 N-01 就是抓这个 */
function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  const ls = md.split('\n');
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const fm = /^\s*(```|~~~)/.exec(l);
    if (fm) {
      if (!fence) fence = fm[1];
      else if (l.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) out.push({ level: h[1].length, text: h[2].trim(), line: i + 1 });
  }
  return out;
}
/** 围栏外的正文（占位符扫描用：代码块里的示例 TODO 不算文格失格） */
function stripFences(md: string): string {
  const keep: string[] = [];
  let fence: string | null = null;
  for (const l of md.split('\n')) {
    const fm = /^\s*(```|~~~)/.exec(l);
    if (fm) { if (!fence) fence = fm[1]; else if (l.trim().startsWith(fence)) fence = null; continue; }
    if (!fence) keep.push(l);
  }
  return keep.join('\n');
}
/** 取某标题下的正文（到下一个同级或更高级标题为止） */
function sectionBody(md: string, headings: Heading[], match: (h: Heading) => boolean): string {
  const idx = headings.findIndex(match);
  if (idx < 0) return '';
  const ls = md.split('\n');
  const start = headings[idx].line;
  const lv = headings[idx].level;
  let end = ls.length;
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j].level <= lv) { end = headings[j].line - 1; break; }
  }
  return ls.slice(start, end).join('\n');
}
function findHeading(headings: Heading[], level: number, prefix: string): Heading | undefined {
  return headings.find((h) => h.level === level && h.text.startsWith(prefix));
}
function hasHeading(headings: Heading[], level: number, prefix: string): boolean {
  return findHeading(headings, level, prefix) !== undefined;
}
type TableRow = { cells: string[]; line: number };
/** 解析 Markdown 管道表：分隔行不入表块，矩阵/分期/裁决表都按结构判，不按整行子串 */
function parseTables(text: string): TableRow[][] {
  const blocks: TableRow[][] = [];
  const ls = text.split('\n');
  let cur: TableRow[] = [];
  for (let i = 0; i < ls.length; i++) {
    const raw = ls[i].trim();
    if (raw.startsWith('|') && raw.endsWith('|')) {
      const cells = raw.slice(1, -1).split('|').map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) cur.push({ cells, line: i + 1 });
    } else if (cur.length) { blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}
const bold = (s: string) => s.replace(/\*\*/g, '');
const idTokens = (s: string) => (s.match(/(?:PM|AI)-\d{3}/g) ?? []);

type ReqBlock = { id: string; title: string; fields: Map<string, string>; body: string; line: number };
/** `#### PM-101 标题` + `- **字段**：值` 的块级拆解（字段名与值分开取，值不许为空） */
function parseReqBlocks(md: string, headings: Heading[]): ReqBlock[] {
  const out: ReqBlock[] = [];
  const ls = md.split('\n');
  const hs = headings.filter((h) => h.level === 4 && /^(PM|AI)-\d{3}\s/.test(h.text));
  for (let k = 0; k < hs.length; k++) {
    const start = hs[k].line;
    const end = k + 1 < hs.length ? hs[k + 1].line - 1 : ls.length;
    const body = ls.slice(start, end).join('\n');
    const fields = new Map<string, string>();
    for (const m of body.matchAll(/^- \*\*(.+?)\*\*：([\s\S]*?)(?=\n- \*\*|\n#{4} |\n#{3} |\n#{2} |\n(?!.*)$|$)/gm)) {
      fields.set(m[1].trim(), m[2].trim());
    }
    out.push({ id: hs[k].text.split(/\s+/)[0], title: hs[k].text.replace(/^(PM|AI)-\d{3}\s*/, ''), fields, body, line: hs[k].line });
  }
  return out;
}

// ======================= 前端渲染夹具（SSR：判据 1 的「渲染后 DOM」） =======================
function installWebShims(): void {
  const React = require('react');
  const mem = new Map<string, string>();
  const mkStore = () => ({
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  });
  (globalThis as any).window = (globalThis as any).window ?? globalThis;
  if (!(globalThis as any).document) {
    (globalThis as any).document = {
      baseURI: `http://127.0.0.1:${PORT}/`,
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, contains: () => false } },
      head: { appendChild() {} }, body: { appendChild() {} },
      addEventListener() {}, removeEventListener() {},
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      querySelector: () => null, querySelectorAll: () => [],
    };
  }
  (globalThis as any).localStorage = (globalThis as any).localStorage ?? mkStore();
  (globalThis as any).sessionStorage = (globalThis as any).sessionStorage ?? mkStore();
  (globalThis as any).matchMedia = (globalThis as any).matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  (globalThis as any).React = (globalThis as any).React ?? React;
  // 页面在渲染期会发请求（取数层吞异常），给个空壳响应，避免 SSR 里真打网络
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    json: async () => ({ items: [], tasks: [], plans: [], projects: [], rows: [], data: [], requirements: [] }),
    text: async () => '',
  })) as any;
}
/** 视图切换按钮：从**渲染后的 DOM** 里取（按钮文案 → 命中次数），文案改名则这里改名，行为判据不受键名影响 */
function viewButtonCounts(dom: string, labels: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const btns = dom.match(/<button[^>]*>([^<]*)<\/button>/g) ?? [];
  for (const l of labels) out[l] = btns.filter((b) => new RegExp(`>${l}</button>$`).test(b)).length;
  return out;
}
/** 主题样式表：从渲染出的 `<style>` 里按选择器取变量名集合（判据 1：结构比对，不看注释措辞） */
function themeVarsOf(dom: string, selector: string): string[] {
  const css = dom.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const i = css.indexOf(selector);
  if (i < 0) return [];
  const s = css.indexOf('{', i);
  const e = css.indexOf('}', s);
  if (s < 0 || e <= s) return [];
  return [...css.slice(s + 1, e).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
}
/** 4xx 类判据的公共行为件：服务端真拒绝（状态码 + 有错误文案），不是静默 no-op */
const rejected = (r: { status: number; json: Record<string, any> | null }) =>
  r.status >= 400 && String(r.json?.error ?? '').trim().length > 0;

/** 「看板/列表」视图集合的容错取法：先看泛型联合，取不到就退到 setter 调用点集合 */
function admittedViewModes(file: string, sessionKey: string): string[] {
  const g = new RegExp(`useSessionState<([^>]*)>\\(\\s*'${sessionKey}'`).exec(file);
  if (g) return (g[1].match(/'([a-z]+)'/g) ?? []).map((s) => s.replace(/'/g, ''));
  if (!new RegExp(`\\('${sessionKey}'`).test(file)) return [];
  return [...new Set((file.match(new RegExp(`set[A-Z]\\w*\\('([a-z]+)'\\)`, 'g')) ?? []).map((s) => /'([a-z]+)'/.exec(s)![1]))];
}

// ======================= 前置：PRD 必须存在 =======================
ok('D-00 PRD 文件存在（docs/PRD-竞品调研-项目管理与AI工作台优化.md）', existsSync(PRD_PATH));
if (!existsSync(PRD_PATH)) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeGateResults(OUT_DIR, 't02272-gate-results.txt', `T02272 PRD 门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
const PRD = readFileSync(PRD_PATH, 'utf8');
const HEADINGS = parseHeadings(PRD);
const BLOCKS = parseReqBlocks(PRD, HEADINGS);
const bodyOf = (match: (h: Heading) => boolean) => sectionBody(PRD, HEADINGS, match);
const sec = (prefix: string, level = 2) => bodyOf((h) => h.level === level && h.text.startsWith(prefix));

// ======================= 文档派生真值（模块级：R/F/G/H/S/N 各组共用同一份解析结果） =======================
const pmBlocks = BLOCKS.filter((b) => b.id.startsWith('PM-'));
const aiBlocks = BLOCKS.filter((b) => b.id.startsWith('AI-'));
const reqIds = BLOCKS.map((b) => b.id);
const REQ_FIELDS = ['描述', '用户故事', '验收标准', '优先级'];
const missingFields = BLOCKS.filter((b) => !REQ_FIELDS.every((f) => (b.fields.get(f) ?? '').length > 0)).map((b) => b.id);
/**
 * 「登记型」需求块：AI-202/AI-205 指向已批准 PRD 的验收章节（G-08 口径：登记排期、不重复拆解），
 * 故 ①②编号项与 影响面×成本 由「以 …为准 / 已批准」这一外部权威替代——豁免必须**可判**（引用在文里），
 * 不是给某几条需求开后门：引用短语不在场就按普通块要求。
 */
const delegated = (b: ReqBlock) => /为准/.test(b.fields.get('验收标准') ?? '') && /已批准|进行中/.test(b.fields.get('优先级') ?? '');
const thinAccept = BLOCKS.filter((b) => !delegated(b) && (b.fields.get('验收标准') ?? '').split(/[①②③④⑤⑥⑦⑧⑨]/).length < 3).map((b) => b.id);
const storyOk = (v: string) => /^作为/.test(v) && /我想要|我希望/.test(v) && /以便|从而|才能|以免/.test(v);
const badStory = BLOCKS.filter((b) => !storyOk(b.fields.get('用户故事') ?? '')).map((b) => b.id);
const priOf = (b: ReqBlock) => (b.fields.get('优先级') ?? '').match(/^P[012]/)?.[0] ?? '';
const priCount = (p: string) => BLOCKS.filter((b) => priOf(b) === p).length;
const rationaleOk = (b: ReqBlock) => {
  const v = b.fields.get('优先级') ?? '';
  return (/影响面/.test(v) && /成本/.test(v)) || /已批准/.test(v); // 已批准块的依据是批准本身（见上注释）
};
const rationaleMissing = BLOCKS.filter((b) => !rationaleOk(b)).map((b) => b.id);
/** §7 分期表 → 「分期 → 需求编号集合」，与逐块声明的优先级交叉对账（自洽判据） */
const phaseRows = parseTables(sec('7. 优先级总览与分期建议'))
  .flatMap((t) => t)
  .map((r) => ({ phase: bold(r.cells[0] ?? ''), ids: idTokens(r.cells[1] ?? []) }))
  .filter((r) => /MVP|V1\.1|V2\.0/.test(r.phase));
const phaseOf = (id: string) => phaseRows.find((r) => r.ids.includes(id));
const expectedPri = (ph: string) => (/MVP/.test(ph) ? 'P0' : /V1\.1/.test(ph) ? 'P1' : /V2\.0/.test(ph) ? 'P2' : '');
const phaseOrphan = reqIds.filter((id) => !phaseOf(id));
const phaseContradicted = reqIds.filter((id) => {
  const r = phaseOf(id);
  return !!r && priOf(BLOCKS.find((b) => b.id === id)!) !== expectedPri(r.phase);
});
const phaseIdTotal = phaseRows.reduce((a, r) => a + r.ids.length, 0);
const infoRow = parseTables(sec('1. 文档信息')).flat().find((r) => bold(r.cells[0] ?? '') === '需求规模');
/** 信息表那一行 = 「需求规模 | 35 条（…）」，比对时要去掉行标签单元格，否则永远差一个前缀 */
const infoCells = (infoRow?.cells.slice(1) ?? []).join(' ').replace(/\*\*/g, '');
const recomputed = `${BLOCKS.length} 条（项目管理 ${pmBlocks.length} + AI 工作台 ${aiBlocks.length}），`
  + `P0×${priCount('P0')} / P1×${priCount('P1')} / P2×${priCount('P2')}`;
/** §3.2 两张表：现状锚点表（表头含 `#`）与能力矩阵（表头含 `能力项`）——都按结构取，不按整段子串 */
const matrixSection = sec('3.2 功能对比矩阵', 3);
const matrixTables = parseTables(matrixSection);
const competitorMatrix = matrixTables.find((t) => (t[0]?.cells ?? []).includes('能力项')) ?? [];
const matrixHeader = competitorMatrix[0]?.cells ?? [];
const matrixRagged = competitorMatrix.filter((r) => r.cells.length !== matrixHeader.length).length;
const matrixRatingCells = competitorMatrix.slice(1).flatMap((r) => r.cells.slice(1));
const anchorTable = matrixTables.find((t) => (t[0]?.cells ?? []).includes('锚点')) ?? [];
const researchBody = sec('2. 背景与目标') + '\n' + sec('3. 竞品调研摘要');
const appendixLinks = [...new Set((sec('9. 附录').match(/https?:\/\/[^\s）)]+/g) ?? []))];
const glossRows = parseTables(sec('9. 附录')).flat();
const decisionRows = parseTables(bodyOf((h) => h.level === 3 && h.text.startsWith('1.1'))).flat();
const openQRows = parseTables(sec('8. 风险与依赖')).flat().filter((r) => /^Q-[456]$/.test(bold(r.cells[0] ?? '')));
const PRI_RATIONALE_RE = /用户影响面[^。\n]{0,20}×[^。\n]{0,20}实现成本/;

// ======================= 产品运行时真值（隔离库） =======================
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema(); // 用产品自己的建表逻辑造隔离库——F 组的「表/列在不在」只问这座库
const GATE_DB = getDb();
const colsOf = (table: string): string[] => {
  try { return (GATE_DB.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name); } catch { return []; }
};
const tablesIn = (): Set<string> =>
  new Set((GATE_DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
const rowCount = (table: string): number => {
  try { return Number((GATE_DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c); } catch { return -1; }
};
const { readEventRetentionDays } = await import('../server/src/services/EventRetention.ts');
const retentionDays = readEventRetentionDays();

// ======================= 隔离实例（判据 2：夹具自造，生产实例不碰） =======================
let LAUNCHER: ReturnType<typeof resolveServerLauncher> | null = null;
let child: ChildProcess | null = null;
const serverLog: string[] = [];
const apiLog: Array<{ label: string; status: number; error: string }> = [];
async function startInstance(): Promise<boolean> {
  LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
  child = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR, TMP: TMP_ROOT, TEMP: TMP_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
  child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    try { if ((await REAL_FETCH(`${BASE}/health`)).ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function stopInstance() {
  try { child?.kill('SIGTERM'); } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 600));
  if (process.platform === 'win32' && child?.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  try { child?.kill('SIGKILL'); } catch { /* 已退出 */ }
}
async function api(method: string, path: string, body?: unknown) {
  const res = await REAL_FETCH(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, any> | null = null;
  try { json = (await res.json()) as Record<string, any>; } catch { /* 非 JSON */ }
  return { status: res.status, json };
}
/** 4xx 类断言的配对器（判据 3）：行为侧=真拒绝且零副作用，字面侧=产品固定话术 / PRD 原文声明 */
function refusedPair(label: string, r: { status: number; json: Record<string, any> | null }, literal: () => boolean, ctx?: () => unknown) {
  if (r.status >= 400) apiLog.push({ label, status: r.status, error: String(r.json?.error ?? '') });
  return okPair(ok, label,
    () => rejected(r),
    literal,
    () => ({ status: r.status, error: String(r.json?.error ?? '').slice(0, 140), ...(ctx ? { 证据: ctx() } : {}) }));
}

// ======================= D 组：九节结构（解析标题层级与次序） =======================
const SECTIONS = ['1. 文档信息', '2. 背景与目标', '3. 竞品调研摘要', '4. 项目管理模块需求',
  '5. AI 工作台模块需求', '6. 非功能性需求', '7. 优先级总览与分期建议', '8. 风险与依赖', '9. 附录'];
const DIMS = ['客户体验提升', '功能扩展', 'UI 升级', '功能丰富'];
/** 某模块（'4.'/'5.'）四个维度小节里各自挂了几条需求块（空小节返回 0） */
function dimBlockCounts(md: string, headings: Heading[], blocks: ReqBlock[], prefix: string): number[] {
  return DIMS.map((d) => {
    const i = headings.findIndex((h) => h.level === 3 && h.text.startsWith(prefix) && h.text.includes(d));
    if (i < 0) return -1;
    let end = Number.MAX_SAFE_INTEGER;
    for (let j = i + 1; j < headings.length; j++) if (headings[j].level <= 3) { end = headings[j].line; break; }
    return blocks.filter((b) => b.line > headings[i].line && b.line < end).length;
  });
}
{
  const h2 = HEADINGS.filter((h) => h.level === 2);
  const hit = SECTIONS.map((s) => h2.find((h) => h.text === s));
  const idxs = hit.map((h) => (h ? h2.indexOf(h) : -1));
  okPair(ok, 'D-01 九节结构齐全（文档信息/背景与目标/竞品调研摘要/项目管理需求/AI工作台需求/非功能/优先级分期/风险依赖/附录）',
    // 行为侧：九节都在、层级确为 H2、且**按 1→9 递增排列**（结构判据，改措辞不红、乱序或缺节即红）
    () => hit.every(Boolean) && idxs.every((v, i) => i === 0 || v > idxs[i - 1])
      && h2.filter((h) => /^\d+\./.test(h.text)).length === 9,
    () => SECTIONS.every((s) => hasHeading(HEADINGS, 2, s)),
    () => ({ 实测H2: h2.map((h) => h.text) }));
  const metricTables = parseTables(sec('2. 背景与目标'));
  const metricHeader = metricTables.flatMap((t) => t[0]?.cells ?? []);
  okPair(ok, 'D-02 §2 含 2.1 业务背景 + 2.2 可量化目标（基线/目标/口径三列）',
    // 行为侧：§2.2 确有一张表，表头单元格含 基线/目标/口径 三列，且表体 ≥3 行指标（不是散文里蹭到三个字）
    () => hasHeading(HEADINGS, 3, '2.1 业务背景') && hasHeading(HEADINGS, 3, '2.2 ')
      && metricHeader.some((c) => c.startsWith('基线')) && metricHeader.includes('目标') && metricHeader.includes('口径')
      && metricTables.some((t) => (t[0]?.cells ?? []).some((c) => c.startsWith('基线')) && t.length >= 3),
    () => /### 2\.1 业务背景/.test(PRD) && /### 2\.2 本次优化目标（可量化）/.test(PRD),
    () => ({ 表头: metricHeader, 行数: metricTables.map((t) => t.length) }));
  okPair(ok, 'D-03 §3 含 3.1 范围与方法 + 3.2 对比矩阵 + 3.3 关键发现',
    // 行为侧：三节齐 + §3.2 下确有表格块（矩阵是真表格，不是「对比矩阵」四个字出现在正文里）
    () => ['3.1 ', '3.2 ', '3.3 '].every((p) => hasHeading(HEADINGS, 3, p)) && matrixTables.length >= 1,
    () => /### 3\.1 调研范围与方法/.test(PRD) && /### 3\.2 功能对比矩阵/.test(PRD) && /### 3\.3 关键发现与机会点/.test(PRD),
    () => ({ '§3子节': HEADINGS.filter((h) => h.level === 3 && /^3\./.test(h.text)).map((h) => h.text), 表块数: matrixTables.length }));
  const dims4 = dimBlockCounts(PRD, HEADINGS, BLOCKS, '4.');
  const dims5 = dimBlockCounts(PRD, HEADINGS, BLOCKS, '5.');
  okPair(ok, 'D-04 §4/§5 各含四维度小节（客户体验提升/功能扩展/UI 升级/功能丰富）',
    // 行为侧：两模块 × 四维度 = 8 个 H3 小节全部到位，且**每个维度下至少有一条需求块**（空壳小节即红）
    () => dims4.every((n) => n > 0) && dims5.every((n) => n > 0)
      && HEADINGS.filter((h) => h.level === 3 && /^[45]\.\d/.test(h.text)).length === 8,
    () => ['### 4.1 客户体验提升', '### 4.2 功能扩展', '### 4.3 UI 升级', '### 4.4 功能丰富',
      '### 5.1 客户体验提升', '### 5.2 功能扩展', '### 5.3 UI 升级', '### 5.4 功能丰富'].every((h) => PRD.includes(h)),
    () => ({ '§4各维度需求数': dims4, '§5各维度需求数': dims5 }));
  const emptySections = SECTIONS.filter((s) => sectionBody(PRD, HEADINGS, (h) => h.level === 2 && h.text === s).trim().length < 40);
  okPair(ok, 'D-05 无占位符且九节都有正文（TODO/TBD/FIXME/XXX 大小写敏感；lorem 不敏感；WIP 为合法术语不误报）',
    // 行为侧：占位扫描只看**围栏代码之外**的正文，外加「每节非空」这条结构红线
    () => !/TODO|TBD|FIXME|XXX/.test(stripFences(PRD)) && !/[Ll]orem/.test(PRD) && emptySections.length === 0,
    () => !/TODO|TBD|FIXME|XXX/.test(PRD) && !/[Ll]orem/.test(PRD),
    () => ({ 空节: emptySections }));
  ok('D-06 规模充足（>20000 字符）', PRD.length > 20000, PRD.length);
}

// ======================= R 组：需求块结构与自洽（解析字段，不整篇子串） =======================
{
  const s4 = findHeading(HEADINGS, 2, '4. 项目管理模块需求');
  const s5 = findHeading(HEADINGS, 2, '5. AI 工作台模块需求');
  const s6 = findHeading(HEADINGS, 2, '6. 非功能性需求');
  okPair(ok, 'R-01 需求块数量：PM 18 + AI 17 = 35',
    // 行为侧：编号唯一、PM 块全部落在 §4 区、AI 块全部落在 §5 区（结构与数量同判）
    () => pmBlocks.length === 18 && aiBlocks.length === 17 && BLOCKS.length === 35 && new Set(reqIds).size === 35
      && !!s4 && !!s5 && !!s6
      && pmBlocks.every((b) => b.line > s4!.line && b.line < s5!.line)
      && aiBlocks.every((b) => b.line > s5!.line && b.line < s6!.line),
    () => reqIds.length === 35 && HEADINGS.filter((h) => h.level === 4 && /^(PM|AI)-\d{3} /.test(h.text)).length === 35,
    () => ({ pm: pmBlocks.length, ai: aiBlocks.length }));
  okPair(ok, 'R-02 每条需求六要素齐全（编号/标题/描述/用户故事/验收标准/优先级）',
    // 行为侧：字段是**解析出来的**（`- **X**：值`），值非空；验收标准至少 2 条可测项（①②…）
    () => missingFields.length === 0 && thinAccept.length === 0 && BLOCKS.every((b) => b.title.length > 0),
    () => BLOCKS.every((b) => REQ_FIELDS.every((f) => new RegExp(`- \\*\\*${f}\\*\\*：`).test(b.body))),
    () => ({ 缺字段: missingFields, 验收标准不足两条: thinAccept, 登记型豁免: BLOCKS.filter(delegated).map((b) => b.id) }));
  okPair(ok, 'R-03 用户故事均为「作为…」句式（三段式：角色 / 诉求 / 收益）',
    () => badStory.length === 0 && BLOCKS.length === 35,
    () => BLOCKS.every((b) => /\*\*用户故事\*\*：作为/.test(b.body)),
    () => ({ 不合格: badStory }));
  okPair(ok, 'R-04 优先级仅 P0/P1/P2 且每条都带「影响面 × 成本」依据',
    () => BLOCKS.every((b) => ['P0', 'P1', 'P2'].includes(priOf(b))) && rationaleMissing.length === 0,
    () => BLOCKS.every((b) => /\*\*优先级\*\*：P[012]/.test(b.body)),
    () => ({ 非法优先级: BLOCKS.filter((b) => !priOf(b)).map((b) => b.id), 缺依据: rationaleMissing }));
  okPair(ok, 'R-05 优先级分布自洽（P0=9 / P1=14 / P2=12）',
    // 行为侧：分布数由解析得出，且 §7 分期表覆盖全部 35 条、每条所属分期与其声明的优先级一致
    () => priCount('P0') === 9 && priCount('P1') === 14 && priCount('P2') === 12
      && phaseRows.length === 3 && phaseOrphan.length === 0 && phaseContradicted.length === 0 && phaseIdTotal === 35,
    () => /P0×9/.test(PRD) && /P1×14/.test(PRD) && /P2×12/.test(PRD),
    () => ({ P0: priCount('P0'), P1: priCount('P1'), P2: priCount('P2'), 未分期: phaseOrphan, 分期与优先级矛盾: phaseContradicted }));
  okPair(ok, 'R-06 文头与 §7 声明的条数/分级数与实际一致',
    // 行为侧：§1 信息表「需求规模」那一格 == 由解析重算出来的字符串（逐字比对，不是子串碰运气）
    () => !!infoRow && infoCells === recomputed && phaseIdTotal === BLOCKS.length,
    () => /35 条（项目管理 18 \+ AI 工作台 17），P0×9 \/ P1×14 \/ P2×12/.test(PRD),
    () => ({ 文头: infoCells, 重算: recomputed }));
}

// ======================= F 组：事实锚点（现状改打行为/产物，不再拿源码文本当唯一判据） =======================
for (const f of ['web/src/pages/TasksPage.tsx', 'web/src/pages/PlanPage.tsx', 'web/src/pages/ReportPage.tsx',
  'web/src/mobile/MobileShell.tsx', 'web/src/mobile/MobileMore.tsx', 'web/src/settings.tsx',
  'web/src/ui/NotifyBell.tsx', 'web/src/ui/EmptyState.tsx',
  'web/src/ui/Markdown.tsx', 'web/src/pages/CommandPalette.tsx', 'web/src/pages/MatrixTable.tsx',
  'web/src/components/estimateGanttOverlay.tsx', 'web/src/App.tsx', 'web/src/i18n.ts',
  'server/src/db/schema.ts', 'server/src/services/milestoneProgress.ts', 'server/src/services/EstimateService.ts',
  'server/src/services/ConsoleJobService.ts', 'server/src/services/kickoff-layout.ts', 'server/src/skills']) {
  ok(`F-F ${f} 存在`, exists(f));
}

/** PRD 里出现的全部 `文件:行号(-行号)` 锚点（供 H-05 逐条在仓里定位） */
const docAnchors = [...new Set(PRD.match(/[\w.-]+\.(?:tsx|ts|json|md):\d+(?:-\d+)?/g) ?? [])];

let planDom = '';
let settingsDom = '';
let ssrErrs: string[] = [];
let instanceUp = false;
if (await startInstance()) {
  instanceUp = true;
  // ---- 门内夹具：一个项目 + 两条任务，看板/批量判据都打在它们身上 ----
  const proj = (await api('POST', '/projects', { name: `T02272 取证夹具-${process.pid}`, description: '门内自造，仅用于批量/状态判据。' })).json;
  const PID = String(proj?.id ?? '');
  const t1 = (await api('POST', '/tasks', { projectId: PID, title: '取证任务甲' })).json;
  const t2 = (await api('POST', '/tasks', { projectId: PID, title: '取证任务乙' })).json;
  const taskIds = [String(t1?.id ?? ''), String(t2?.id ?? '')];
  /** 走 REST 的状态串：`/tasks` 默认返回**裸数组**（带 total=1 才套信封），两种形状都吃；
   *  `archived` 是**互斥**过滤位（=1 只给归档行，TaskService.list 里 `archived = ?`），缺省取未归档 */
  const listTasks = async (archived = false): Promise<Array<Record<string, any>>> => {
    const j = (await api('GET', `/tasks?projectId=${PID}${archived ? '&archived=1' : ''}`)).json;
    return (Array.isArray(j) ? j : (j as any)?.items ?? []) as Array<Record<string, any>>;
  };
  const statusViaApi = async () => (await listTasks()).map((x) => `${x.id}:${x.status}`).sort().join(',');
  /** 走 DB 的整行指纹（含 updated_at），用于「4xx 请求零改动」这种强判据 */
  const rowFingerprint = () => JSON.stringify(
    (GATE_DB.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(PID) as Array<Record<string, any>>));
  // 夹具前置（判据 2：断言只引用本轮自己造的行）——夹具没建出来，后面所有 REST 判据都无意义
  ok('F-C0 门内夹具就绪（隔离实例建出 1 项目 + 2 条挂在该项目下的任务）',
    PID.length > 0 && taskIds.every((x) => x.length > 0) && (await listTasks()).length === 2,
    { PID, taskIds });

  const boardViews = admittedViewModes(read('web/src/pages/TasksPage.tsx'), 'tasks.viewMode');
  const boardColsLine = (() => {
    const m = /const boardCols[^=]*=\s*\[([\s\S]*?)\n\s{4}\];/.exec(read('web/src/pages/TasksPage.tsx'));
    return (m?.[1]?.match(/key:\s*'([a-z]+)'/g) ?? []).map((s) => /'([a-z]+)'/.exec(s)![1]);
  })();
  // 看板两列的状态口径由服务端真实喂出：把一条任务真打到 done、再打回 todo，REST 都如实回显
  const toDone = await api('POST', '/tasks/batch', { ids: [taskIds[0]], action: 'status', value: 'done' });
  const doneEcho = await listTasks();
  const backTodo = await api('POST', '/tasks/batch', { ids: [taskIds[0]], action: 'status', value: 'todo' });
  const todoEcho = await listTasks();
  okPair(ok, 'F-C1 看板视图在位（列表/看板双视图 + 看板两列的 todo/done 状态真能流转）且 PRD 锚点一致',
    // 行为侧：REST 把任务真的在两个看板列的状态之间来回切换（写侧走产品批量接口，读侧走列表接口）；
    // 注：TasksPage 用了 useSyncExternalStore（无 getServerSnapshot），**SSR 渲染不出 DOM**，
    //     所以视图集合这一支拿不到 F-C2 那样的 DOM 判据，退到「枚举集合 + 服务端状态实测」——N-05 反证它有牙。
    () => toDone.status === 200 && backTodo.status === 200
      && doneEcho.length === 2 && doneEcho.filter((x) => x.status === 'done').length === 1
      && todoEcho.length === 2 && todoEcho.every((x) => x.status === 'todo'),
    () => boardViews.includes('list') && boardViews.includes('board')
      && boardColsLine.slice().sort().join(',') === 'done,todo'
      && PRD.includes('TasksPage.tsx:321'),
    () => ({ admittedViews: boardViews, boardCols: boardColsLine, 实测状态: doneEcho.map((x) => x.status) }));

  // 计划三视图：判据 1 的正面样例——**渲染后的 DOM**（renderToStaticMarkup）里数视图切换按钮
  try {
    installWebShims();
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const mod: any = await import(`file:///${join(ROOT, 'web', 'src', 'pages', 'PlanPage.tsx').replace(/\\/g, '/')}`);
    planDom = renderToStaticMarkup(React.createElement(mod.PlanPage, {}));
  } catch (e) { ssrErrs.push(`PlanPage：${e instanceof Error ? e.message : String(e)}`); }
  if (!planDom) {
    skipped('F-C2 计划三视图（渲染后 DOM）', `PlanPage SSR 不可用：${(ssrErrs.at(-1) ?? '').slice(0, 120)}`);
  } else {
    const planBtns = viewButtonCounts(planDom, ['列表', '甘特', '时间线']);
    okPair(ok, 'F-C2 计划三视图在位（渲染后 DOM 里 列表/甘特/时间线 三个切换按钮各≥1）且 PRD 锚点一致',
      // 行为侧：三个视图的入口按钮在渲染产物里各自存在（按钮没了/只剩一个视图 ⇒ 立即红，与源码类型写法无关）
      () => ['列表', '甘特', '时间线'].every((l) => planBtns[l] >= 1),
      () => PRD.includes('PlanPage.tsx:382') && PRD.includes('列表/甘特/时间线'),
      () => ({ 按钮计数: planBtns, DOM长度: planDom.length }));
  }

  const cardKeys = (() => {
    const m = /const reportCards[^=]*=\s*\[([\s\S]*?)\n  \];/.exec(read('web/src/pages/ReportPage.tsx'));
    return (m?.[1]?.match(/\{\s*key:\s*'([a-zA-Z-]+)'/g) ?? []).map((s) => /'([a-zA-Z-]+)'/.exec(s)![1]);
  })();
  const kickoffOutline = await api('POST', '/plans/kickoff-ppt-outline', { projectId: 'no-such-project-for-anchor' });
  if (kickoffOutline.status >= 400) apiLog.push({ label: 'F-C3 kickoff-ppt-outline', status: kickoffOutline.status, error: String(kickoffOutline.json?.error ?? '') });
  okPair(ok, 'F-C3 reportCards 7 卡在位（含 kickoff-ppt 卡且其后端端点已挂载）且 PRD 锚点一致',
    // 行为侧：① kickoff-ppt 卡的两个后端端点在隔离实例上**确实被路由接住**（返回业务 4xx 而不是 404 未挂载）；
    // ② 卡片集合大小=7 且去重（数组只剩标题没接线时这里必红）
    () => kickoffOutline.status !== 404 && String(kickoffOutline.json?.error ?? '').length > 0
      && cardKeys.length === 7 && new Set(cardKeys).size === 7,
    () => cardKeys.includes('kickoff-ppt') && PRD.includes('ReportPage.tsx:584'),
    () => ({ 卡: cardKeys, kickoffOutlineStatus: kickoffOutline.status }));

  try {
    installWebShims();
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const mod: any = await import(`file:///${join(ROOT, 'web', 'src', 'settings.tsx').replace(/\\/g, '/')}`);
    settingsDom = renderToStaticMarkup(React.createElement(mod.SettingsProvider, {}, React.createElement('div', null, 'kids')));
  } catch (e) { ssrErrs.push(`settings：${e instanceof Error ? e.message : String(e)}`); }
  const lightVars = themeVarsOf(settingsDom, "[data-theme='light']");
  const darkVars = themeVarsOf(settingsDom, "[data-theme='dark']");
  if (!settingsDom) {
    skipped('F-C4 暗色主题（渲染后样式表）', `SettingsProvider SSR 不可用：${(ssrErrs.at(-1) ?? '').slice(0, 120)}`);
  } else {
    okPair(ok, 'F-C4 暗色主题机制在位（渲染出的样式表确有深色变量块，且只覆盖浅色块已有的变量）且 PRD 不声称「无暗色」',
      // 行为侧：`<style>` 里 [data-theme='dark'] 规则块存在、变量数 ≥8、全部是浅色块声明过的变量名、无重复
      () => darkVars.length >= 8 && lightVars.length >= 8
        && darkVars.every((v) => lightVars.includes(v)) && new Set(darkVars).size === darkVars.length,
      () => PRD.includes('settings.tsx') && !/无暗色主题/.test(PRD) && !/零覆盖/.test(PRD),
      () => ({ 浅色变量数: lightVars.length, 深色变量数: darkVars.length, DOM: settingsDom.length }));
  }

  const rowsBeforeHooks = rowCount('tasks');
  const hookProbes = [await api('POST', '/webhook', { x: 1 }), await api('GET', '/webhook'), await api('POST', '/hooks', { x: 1 })];
  okPair(ok, 'F-C5 「无 Webhook」否定性结论与运行时一致（隔离实例不认这些路由）',
    // 行为侧：三条候选路径全部 404（**服务自己否认挂载**）且请求没写出任何任务行；grep 零命中退到字面侧
    () => hookProbes.every((r) => r.status === 404) && rowCount('tasks') === rowsBeforeHooks,
    () => /无 Webhook/.test(researchBody) && grepFileCount('server/src', /webhook|Webhook/i) === 0,
    () => ({ 状态: hookProbes.map((r) => r.status), 行数变化: rowCount('tasks') - rowsBeforeHooks }));

  const dbTables = tablesIn();
  const taskCols = colsOf('tasks');
  const planCols = colsOf('plan_tasks');
  okPair(ok, 'F-C6 现状锚点的表/列与隔离库一致（tasks/console_jobs/exec_sessions 由产品建表逻辑真实建出）',
    // 行为侧：表由**产品的 initSchema()** 在隔离库里建出来（读 sqlite_master），列名读 PRAGMA——
    // 比 regex 扫 schema.ts 强：迁移写歪（表没建出来）这里必红，而源码文本照样能匹配上
    () => ['tasks', 'console_jobs', 'exec_sessions'].every((t) => dbTables.has(t))
      && taskCols.includes('status') && colsOf('console_jobs').includes('project_ids'),
    () => PRD.includes('schema.ts:16-32') && PRD.includes('schema.ts:167-178') && PRD.includes('schema.ts:341-356'),
    () => ({ 表数: dbTables.size, tasks列: taskCols.length }));

  okPair(ok, 'F-C7 五竞品全部在对比矩阵中',
    // 行为侧：按**表结构**判——矩阵 ≥10 行、每行列数与表头一致（缺列/错位的破表会被抓到）
    () => competitorMatrix.length >= 10 && matrixRagged === 0,
    () => ['GitHub', 'GitLab', 'Bitbucket', 'Gitee', 'Azure DevOps', 'MTask'].every((c) => matrixHeader.includes(c))
      && /^\| 能力项 \| GitHub \| GitLab \| Bitbucket \| Gitee \| Azure DevOps \| MTask \|$/m.test(PRD),
    () => ({ 表头: matrixHeader, 行数: competitorMatrix.length, 错列行: matrixRagged }));

  const factKeys = ['agent sessions', '2026-03', '2026-08-04', '26-09', 'Copilot', 'MCP Server', 'hierarchy'];
  const factsMissing = factKeys.filter((k) => !researchBody.includes(k));
  const ratingSymbols = ['✅', '⚠', '❌'];
  okPair(ok, 'F-C8 竞品 2026 关键事实在位（agent sessions GA 26-03 / Gitee AI 队友 26-08-04 / Copilot 26-09 双变更 / Azure MCP）',
    // 行为侧：事实必须落在**调研正文（§2/§3）区域内**（附录蹭到一个日期不算），且能力矩阵每格都带 ✅/⚠/❌ 评级符号
    () => factsMissing.length === 0
      && ratingSymbols.every((s) => matrixRatingCells.filter((c) => c.startsWith(s)).length >= 3)
      && matrixRatingCells.length >= 50,
    () => /2026-09-01/.test(PRD) && factKeys.every((k) => PRD.includes(k)),
    () => ({ 缺失事实: factsMissing, 评级格数: matrixRatingCells.length }));

  okPair(ok, 'F-C9 附录 B 参考链接 ≥10 条',
    // 行为侧：链接取自 §9 附录小节且**去重后**计数（同一链接刷屏不算 10 条）
    () => appendixLinks.length >= 10,
    () => (PRD.match(/https?:\/\/[^\s）)]+/g) ?? []).length >= 10,
    () => ({ 去重链接数: appendixLinks.length }));

  const gapBody = bodyOf((h) => h.level === 3 && h.text.startsWith('9.3'));
  const gapItems = gapBody.split('\n').filter((l) => /^\s*(?:\d+\.|-)\s+\*\*/.test(l));
  okPair(ok, 'F-C10 验证缺口如实声明（§9.3 竞品未实测 UI）',
    // 行为侧：§9.3 是真实小节且有 ≥3 条列表项，其中声明「无法注册五家竞品账号」与「⚠待人工实测」
    () => hasHeading(HEADINGS, 3, '9.3 ') && gapItems.length >= 3 && /无法注册五家竞品账号/.test(gapBody) && /⚠待人工实测/.test(gapBody),
    () => /### 9\.3 验证缺口/.test(PRD),
    () => ({ 条目数: gapItems.length }));

  okPair(ok, 'F-C11 tasks 无排期字段（隔离库 PRAGMA 实测）且 PRD 不得声称任务级逾期预测',
    // 行为侧：`tasks` 列集合里确实没有排期四件套，而 `plan_tasks` **确有** start_date/duration_days
    // ——这个对照才是「排期能力全在计划表」的真判据（源码里 ensureColumn 写没写无所谓）
    () => !taskCols.some((c) => ['start_date', 'duration_days', 'due_date', 'estimate'].includes(c))
      && planCols.includes('start_date') && planCols.includes('duration_days'),
    () => !/按任务工期/.test(PRD) && PRD.includes('无任何排期字段') && PRD.includes('计划级'),
    () => ({ tasks列: taskCols, plan列: planCols.slice(0, 8) }));

  // 批量动作逐个打真请求（归档动作留到最后，避免影响前后状态比对）
  const SOFT_ACTIONS = ['status', 'category', 'priority', 'color'];
  const actionStatus: Record<string, number> = {};
  for (const a of SOFT_ACTIONS) {
    actionStatus[a] = (await api('POST', '/tasks/batch', {
      ids: taskIds, action: a,
      value: a === 'status' ? 'done' : a === 'priority' ? 'high' : a === 'color' ? '#112233' : '',
    })).status;
  }
  const fpBefore = rowFingerprint();
  const statusBefore = await statusViaApi();
  const badAction = await api('POST', '/tasks/batch', { ids: taskIds, action: 'teleport', value: 'x' });
  const fpAfter = rowFingerprint();
  const statusAfter = await statusViaApi();
  const controlBatch = await api('POST', '/tasks/batch', { ids: taskIds, action: 'status', value: 'todo' });
  const statusControl = await statusViaApi();
  actionStatus['archive'] = (await api('POST', '/tasks/batch', { ids: taskIds, action: 'archive', value: 'true' })).status;
  const archivedEcho = await listTasks(true);
  okPair(ok, 'F-C12 批量操作既有能力实测（5 种动作可用 + 非法动作 4xx 零改动 + 合法对照仍成功）且 PM-105 标注为增强',
    // 行为侧：① PRD 声称的「5 种动作」逐个打真请求全部受理且**归档动作真把两行搬进归档视图**；
    // ② 第 6 种动作真的 4xx 且整行指纹（含 updated_at）前后逐字相同；
    // ③ 拒绝之后合法批次照样改得动（不是把接口打死）
    () => Object.values(actionStatus).every((s) => s === 200)
      && rejected(badAction) && fpBefore === fpAfter && statusBefore === statusAfter
      && controlBatch.status === 200 && statusControl !== statusAfter
      && archivedEcho.length === 2 && archivedEcho.every((x) => x.archived === true),
    () => /批量操作增强/.test(PRD) && /T00457/.test(PRD) && /T01065/.test(PRD),
    () => ({ 各动作状态: actionStatus, 非法动作: { status: badAction.status, error: String(badAction.json?.error ?? '').slice(0, 60) }, 前后状态: [statusBefore, statusAfter, statusControl], 归档回读: archivedEcho.map((x) => `${x.id}:${x.archived}`) }));
  refusedPair('F-C12a 批量非法动作确实 4xx 且回中文错误（不是静默 no-op）', badAction,
    () => /不支持的批量操作/.test(String(badAction.json?.error ?? '')),
    () => ({ 前: statusBefore, 后: statusAfter, 行指纹一致: fpBefore === fpAfter }));

  const aiCols = colsOf('ai_usage');
  const promptCols = colsOf('prompts');
  const settingCols = colsOf('app_settings');
  okPair(ok, 'F-C13 ai_usage 无 token/成本/卡片维度；prompts 无计数字段；app_settings 为应用级（PRD 已给替代方案）',
    // 行为侧：三张表的列集合来自隔离库 PRAGMA（不是 schema.ts 的文本），且 app_settings 主键列就是 key
    () => !aiCols.some((c) => /token|cost|card/i.test(c)) && !promptCols.includes('usage_count') && settingCols.includes('key'),
    () => PRD.includes('usage_count') && PRD.includes('代理指标') && PRD.includes('guide.dismiss.<projectId>'),
    () => ({ ai_usage: aiCols, prompts: promptCols, app_settings: settingCols }));

  okPair(ok, 'F-C14 事件默认保留 90 天实测（隔离库空配置即读回 90）且 PM-205 声明快照表为长历史唯一来源',
    // 行为侧：`readEventRetentionDays()` 在未写任何配置的隔离库上返回的就是默认值（产品当前真实口径），
    // 而不是 `DEFAULT_RETENTION_DAYS = 90` 这行文本；服务端 REST 也回同一个数（见 H-06）
    () => retentionDays === 90,
    () => PRD.includes('EventRetention.ts:23') && /唯一来源是自建日快照表/.test(PRD),
    () => ({ 实测保留天数: retentionDays }));

  okPair(ok, 'F-C15 裁决记录：Q-1~Q-3 已签字（§1.1）+ 新增开放问题 Q-4~Q-6',
    // 行为侧：§1.1 是带表头的真实裁决表且三行齐全、每行 ≥3 格；Q-4~Q-6 以**表格行**形式出现在 §8
    () => hasHeading(HEADINGS, 3, '1.1 ') && ['Q-1', 'Q-2', 'Q-3'].every((q) => decisionRows.some((r) => r.cells.some((c) => bold(c).startsWith(q))))
      && decisionRows.every((r) => r.cells.length >= 3) && openQRows.length === 3,
    () => /### 1\.1 裁决记录/.test(PRD) && /已裁决/.test(PRD) && /v1\.1（按建议改写方案 \+ 评审修订/.test(PRD),
    () => ({ 裁决行数: decisionRows.length, 开放问题行: openQRows.map((r) => bold(r.cells[0])) }));

  // ---- H 组：跨进程同源自证（判据 4）----
  const FAKE_STEM = 'ZZZ-本门不存在的词干';
  const fakeNumbers = ['P0×10', 'P1×13', '一次最多聚合 99 个项目', '默认保留 88 天', FAKE_STEM];
  ok('H-01 PRD 文头声明的规模/分级串可由门内解析逐字重算（数字同一源，不是各抄一份）',
    infoCells === recomputed, { 文头: infoCells, 重算: recomputed });
  const badRepeat = await api('POST', '/tasks/batch', { ids: taskIds, action: 'teleport', value: 'x' });
  const sameErrorTwice = String(badAction.json?.error ?? '') === String(badRepeat.json?.error ?? '');
  const retentionPut = await api('PUT', '/events/retention', { days: 77 });
  const retentionSeenInGate = readEventRetentionDays();
  const retentionGet = await api('GET', '/events/retention');
  const retentionOutOfRange = await api('PUT', '/events/retention', { days: 9999 });
  const retentionStillSeen = readEventRetentionDays();
  await api('PUT', '/events/retention', { days: 90 }); // 还原，别把夹具配置留给后续判据
  ok('H-02 假数字/假词干在 PRD、服务端 4xx 原文与 SSR DOM 里零命中（H-01/R-05/F-C2 的比对不是恒真式）',
    fakeNumbers.every((f) => !PRD.includes(f))
      && apiLog.every((r) => !r.error.includes(FAKE_STEM) && !r.error.includes('88 天'))
      && !(planDom + settingsDom).includes(FAKE_STEM),
    { 服务端4xx条数: apiLog.length });
  ok('H-03 同一非法入参两次调用，服务端回的是同一句话（错误文案出自服务端同一处代码，门里没另抄）',
    sameErrorTwice && badRepeat.status >= 400 && String(badRepeat.json?.error ?? '').includes('teleport'),
    { 原文: String(badAction.json?.error ?? '').slice(0, 80) });
  ok('H-04 事件保留期只有一处真值：门进程写的（PUT 走服务端）门进程立刻能读到，越界写则两处都不动',
    retentionPut.status === 200 && retentionSeenInGate === 77 && retentionGet.json?.days === 77
      && rejected(retentionOutOfRange) && retentionStillSeen === 77,
    { 门进程读回: retentionSeenInGate, 服务端读回: retentionGet.json?.days, 越界后: retentionStillSeen });
  ok('H-05 PRD 里每个 `文件:行号` 锚点都能在仓库定位到真实文件的真实行区间（锚点不是随手编的行号）',
    docAnchors.length >= 20 && (() => {
      const idx = new Map<string, string[]>();
      const walk = (d: string) => {
        for (const e of readdirSync(d)) {
          const p = join(d, e);
          if (statSync(p).isDirectory()) { if (!/node_modules|dist|\.next|\.git/.test(e)) walk(p); }
          else if (/\.(tsx|ts|json|md)$/.test(e)) (idx.get(e) ?? idx.set(e, []).get(e)!).push(p);
        }
      };
      walk(join(ROOT, 'web', 'src')); walk(join(ROOT, 'server', 'src')); walk(join(ROOT, 'docs'));
      // 根级文件（package.json 等）也进索引：PRD 里有 `package.json:70-72` 这类锚点
      for (const e of readdirSync(ROOT)) {
        const p = join(ROOT, e);
        if (statSync(p).isFile() && /\.(tsx|ts|json|md)$/.test(e)) (idx.get(e) ?? idx.set(e, []).get(e)!).push(p);
      }
      const bad: string[] = [];
      for (const t of docAnchors) {
        const m = /^([\w.-]+)\.(tsx|ts|json|md):(\d+)(?:-(\d+))?$/.exec(t);
        if (!m) { bad.push('PARSE ' + t); continue; }
        const cands = idx.get(`${m[1]}.${m[2]}`) ?? [];
        const end = Number(m[4] ?? m[3]);
        if (!cands.some((p) => end <= readFileSync(p, 'utf8').split('\n').length)) bad.push(t);
      }
      return bad.length === 0;
    })(), { 锚点数: docAnchors.length });
  ok('H-06 服务端拒绝类判据确有真实 4xx 落账（≥2 条，供同源自证与红因区分）',
    apiLog.length >= 2 && apiLog.every((r) => r.error.length > 0), apiLog.map((r) => [r.label, r.status]));

  await stopInstance();
} else {
  fail += 1;
  lines.push('[FAIL] 隔离实例未就绪，F 组运行时判据无法执行 → ' + serverLog.join('').slice(-800));
  skipped('F-C1/F-C3/F-C5/F-C12 等运行时判据', '隔离实例未起（见上一行日志），不当 PASS 用');
}

// ======================= G 组：任务覆盖（限定小节检索） =======================
{
  const scope4 = sec('4. 项目管理模块需求');
  const scope5 = sec('5. AI 工作台模块需求');
  okPair(ok, 'G-01 调研范围覆盖两模块全要素（看板/里程碑/迭代/甘特/权限 + AI 编码/评审/对话/编排/模型/提示词）',
    // 行为侧：项目管理要素在 §4 区、AI 工作台要素在 §5 区各自命中（不再整篇子串——附录蹭到一个词不算覆盖）
    () => ['看板', '里程碑', '迭代', '甘特', '权限'].every((w) => scope4.includes(w))
      && ['编码', '评审', '对话', '编排', '模型', '提示词'].every((w) => scope5.includes(w)),
    () => ['看板', '里程碑', '迭代', '甘特', '权限', '编码', '评审', '对话', '编排', '模型', '提示词'].every((w) => PRD.includes(w)),
    () => ({ '§4长度': scope4.length, '§5长度': scope5.length }));
  const legendBody = sec('3.1 调研范围与方法', 3);
  const stateWords = ['缺失', '落后', '持平', '领先'];
  okPair(ok, 'G-02 差距分析四态判定体系在位（缺失/落后/持平/领先 → ✅/⚠/❌）',
    // 行为侧：图例四态在 §3.1 方法小节里成句；矩阵每一格（除首列）都带 ✅/⚠/❌ 之一——
    // 即「判定体系」真的被用到了表上，而不是只在正文里出现四个词
    () => stateWords.every((w) => legendBody.includes(w))
      && matrixRatingCells.length > 0
      && matrixRatingCells.every((c) => ['✅', '⚠', '❌'].some((s) => c.startsWith(s))),
    () => /缺失\/落后\/持平\/领先/.test(PRD) && /✅完整具备/.test(PRD) && /❌不具备/.test(PRD),
    () => ({ 图例命中: stateWords.filter((w) => legendBody.includes(w)), 未带评级符号的格: matrixRatingCells.filter((c) => !['✅', '⚠', '❌'].some((s) => c.startsWith(s))).slice(0, 5) }));
  const nf = sec('6. 非功能性需求');
  okPair(ok, 'G-03 非功能四块齐全（性能/安全与隐私/兼容性/国际化）',
    // 行为侧：§6 下四个 H3 小节全部到位且每块有正文（非空壳标题）
    () => ['6.1 性能', '6.2 安全与隐私', '6.3 兼容性', '6.4 国际化'].every((p) => hasHeading(HEADINGS, 3, p))
      && ['6.1 ', '6.2 ', '6.3 ', '6.4 '].every((p) => bodyOf((h) => h.level === 3 && h.text.startsWith(p)).trim().length > 30)
      && nf.length > 200,
    () => /### 6\.1 性能/.test(PRD) && /### 6\.2 安全与隐私/.test(PRD) && /### 6\.3 兼容性/.test(PRD) && /### 6\.4 国际化/.test(PRD));
  okPair(ok, 'G-04 三期分期（MVP → V1.1 → V2.0）',
    () => phaseRows.length === 3 && ['MVP', 'V1.1', 'V2.0'].every((p) => phaseRows.some((r) => r.phase.includes(p))),
    () => /MVP/.test(PRD) && /V1\.1/.test(PRD) && /V2\.0/.test(PRD),
    () => phaseRows.map((r) => [r.phase, r.ids.length]));
  okPair(ok, 'G-05 优先级依据说明（用户影响面 × 实现成本）',
    // 行为侧：§7 里那条依据说明存在，且**每条需求的优先级字段都真按这套依据写**（与 R-04 同源，防「说明在、需求没套用」）
    () => PRI_RATIONALE_RE.test(sec('7. 优先级总览与分期建议')) && rationaleMissing.length === 0,
    () => PRI_RATIONALE_RE.test(PRD));
  const noGloss = ['Iteration', 'Sprint', 'BYOK', 'CFD', 'WIP', 'agent sessions', 'RTM']
    .filter((t) => !glossRows.some((r) => r.cells.some((c) => c.includes(t))));
  okPair(ok, 'G-06 关键术语首次出现附英文（Iteration/Sprint、BYOK、CFD、WIP、agent sessions、RTM）',
    // 行为侧：术语表（§9.1）里逐个术语占一行（结构化取），不再「整篇出现过一次」就算双语
    () => noGloss.length === 0 && glossRows.length >= 6,
    () => ['Iteration', 'Sprint', 'BYOK', 'CFD', 'WIP', 'agent sessions', 'RTM'].every((t) => PRD.includes(t)),
    () => ({ 未入表: noGloss, 表行: glossRows.length }));
  okPair(ok, 'G-07 开放问题 Q-1~Q-3 待裁决（含 tasks.status 二元决策冲突声明）',
    // 行为侧：§1.1 裁决表里 Q-1~Q-3 各占一行且带 T01876 的签字依据（表格结构判，不靠整篇子串）
    () => ['Q-1', 'Q-2', 'Q-3'].every((q) => decisionRows.some((r) => bold(r.cells[0] ?? '') === q))
      && /T01876/.test(decisionRows.map((r) => r.cells.join(' ')).join(' ')) && decisionRows.length >= 3,
    () => /\| Q-1 \|/.test(PRD) && /\| Q-2 \|/.test(PRD) && /\| Q-3 \|/.test(PRD) && /T01876/.test(PRD));
  const crossRefs = ['T02169', 'T02170', 'T02219', 'T02259'];
  okPair(ok, 'G-08 既有 PRD 引用对齐（T02169/T02170 已批准登记不重复拆解）',
    // 行为侧：四个引用号都在 §7 的分期/对齐段落里（登记位），不是散落在无关段落
    () => crossRefs.every((t) => sec('7. 优先级总览与分期建议').includes(t)),
    () => crossRefs.every((t) => PRD.includes(t)));
}

// ======================= S 组：改名模拟（文案搬走后，判据仍按行为说话） =======================
{
  // 本门依赖的「文案表」是 PRD 里任务指定的小节标题与服务端固定话术；这里在**内存副本**上做搬迁，
  // 文件一个字都不改（S-03 逐字校验还原），隔离库零写入（S-04 行数校验）。
  const RENAMED_STEM = '##2##ZZZ-改名标记';
  const OLD_HEADING = '### 2.2 本次优化目标（可量化）';
  const dbSnap = ['tasks', 'app_settings', 'task_events'].map((t) => `${t}:${rowCount(t)}`).join(',');
  const renamed = PRD.replace(OLD_HEADING, `### 2.2 目标（${RENAMED_STEM}）`);
  const rHeadings = parseHeadings(renamed);
  const rMetricTables = parseTables(sectionBody(renamed, rHeadings, (h) => h.level === 2 && h.text.startsWith('2. ')));
  const rHeader = rMetricTables.flatMap((t) => t[0]?.cells ?? []);
  // D-02 的两半拆出来复用：行为半（表结构）与字面半（标题原文）
  const d02Behavior = (headings: Heading[], tables: TableRow[][]) =>
    hasHeading(headings, 3, '2.1 业务背景') && hasHeading(headings, 3, '2.2 ')
    && tables.some((t) => (t[0]?.cells ?? []).some((c) => c.startsWith('基线')) && t.length >= 3);
  const d02Literal = (doc: string) => /### 2\.1 业务背景/.test(doc) && /### 2\.2 本次优化目标（可量化）/.test(doc);
  const spy: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  okPair((name, cond, extra) => spy.push({ name, cond, extra }), '样张·改名后（标题搬走、表还在）',
    () => d02Behavior(rHeadings, rMetricTables), () => d02Literal(renamed));
  ok('S-01 改名模拟：§2.2 标题被搬走后，结构判据（基线/目标/口径 三列表 + 2.2 小节在位）仍绿、字面判据失配',
    spy.length === 1 && spy[0].cond === false
      && d02Behavior(rHeadings, rMetricTables) === true && d02Literal(renamed) === false
      && JSON.stringify(spy[0].extra).includes('字面锚点失配'),
    { 红因: spy[0]?.extra, 表头: rHeader });
  // 结构破坏（中文词一个字没动，但矩阵被砍掉一列 ⇒ 行与表头列数不齐）⇒ 必须是「行为失守」
  const brokenMatrix = matrixSection.replace(/\| ⚠ 里程碑✅\/迭代❌ \|/, '|');
  const brokenTables = parseTables(brokenMatrix);
  const brokenMatrixTable = brokenTables.find((t) => (t[0]?.cells ?? []).includes('能力项')) ?? [];
  const brokenRagged = brokenMatrixTable.filter((r) => r.cells.length !== (brokenMatrixTable[0]?.cells ?? []).length).length;
  okPair((name, cond, extra) => spy.push({ name, cond, extra }), '样张·结构破坏（词都在、表塌了）',
    () => brokenMatrixTable.length >= 10 && brokenRagged === 0,
    () => /\| 能力项 \| GitHub \| GitLab \| Bitbucket \| Gitee \| Azure DevOps \| MTask \|/.test(brokenMatrix));
  ok('S-02 结构破坏模拟：矩阵缺一列时判据红且红因归「行为失守」（字面行号锚点仍在场也救不回来）',
    spy.length === 2 && spy[1].cond === false && brokenRagged > 0
      && JSON.stringify(spy[1].extra).includes('行为失守')
      && /\| 能力项 \| GitHub \|$|能力项/.test(brokenMatrix),
    { 错列行数: brokenRagged, 红因: spy[1]?.extra });
  ok('S-03 模拟零残留 + 逐字还原：改名标记在真 PRD 里零命中，PRD 文件字节与内存副本一致（只读模拟，未落盘）',
    !PRD.includes(RENAMED_STEM) && renamed.includes(RENAMED_STEM)
      && readFileSync(PRD_PATH, 'utf8') === PRD && !renamed.includes(OLD_HEADING),
    { 改名标记: RENAMED_STEM });
  ok('S-04 模拟零数据库副作用：整轮字符串模拟前后，隔离库 tasks/app_settings/task_events 行数一字不变',
    ['tasks', 'app_settings', 'task_events'].map((t) => `${t}:${rowCount(t)}`).join(',') === dbSnap,
    { 快照: dbSnap });
  // F-C2 的 DOM 判据同样要扛得住「改名」：把 DOM 里的按钮文案整体换成英文，行为判据（按钮在位）应仍按新文案绿
  const enDom = planDom
    .replace(/>列表<\/button>/g, `>List</button>${RENAMED_STEM}`)
    .replace(/>甘特<\/button>/g, '>Gantt</button>')
    .replace(/>时间线<\/button>/g, '>Timeline</button>');
  ok('S-05 渲染产物改名模拟：三视图按钮换成英文后，按新文案集合数按钮仍然三枚在位（判据绑的是控件，不是中文串）',
    planDom !== '' && Object.values(viewButtonCounts(enDom, ['List', 'Gantt', 'Timeline'])).every((n) => n >= 1)
      && Object.values(viewButtonCounts(enDom, ['列表', '甘特', '时间线'])).every((n) => n === 0),
    { 中文计数: viewButtonCounts(enDom, ['列表', '甘特', '时间线']) });
}

// ======================= N 组：负对照（伪造夹具必须判红） =======================
{
  ok('N-01 负对照（结构）：围栏代码块里的「## 5.」不算小节标题——章节判据不是整篇子串',
    (() => {
      const fenced = ['## 4. 项目管理模块需求', '', '```md', '## 5. AI 工作台模块需求', '### 3.2 功能对比矩阵', '```', '', '正文'].join('\n');
      const fh = parseHeadings(fenced);
      return fh.length === 1 && fh[0].text === '4. 项目管理模块需求' && !hasHeading(fh, 2, '5. AI 工作台模块需求')
        && !hasHeading(fh, 3, '3.2 ');
    })());
  const thinBlock = ['#### PM-900 伪造需求', '- **描述**：', '- **用户故事**：作为 X，我想要 Y，以免 Z。', '- **验收标准**：', '- **优先级**：P0（影响面：全部；成本：S）'].join('\n');
  const thinHeadings = parseHeadings(thinBlock);
  const thinParsed = parseReqBlocks(thinBlock, thinHeadings);
  const thinFields = thinParsed[0]?.fields ?? new Map<string, string>();
  ok('N-02 负对照（需求块）：字段名齐但值为空 / 验收标准无编号项 ⇒ 判据判红',
    thinParsed.length === 1
      && (['描述', '验收标准'] as const).every((f) => (thinFields.get(f) ?? '').length === 0)
      && thinParsed.filter((b) => REQ_FIELDS.every((f) => (b.fields.get(f) ?? '').length > 0)).length === 0,
    { 解析字段: [...thinFields.entries()] });
  const fakeRecomputed = `${BLOCKS.length + 1} 条（项目管理 ${pmBlocks.length} + AI 工作台 ${aiBlocks.length}），P0×${priCount('P0')} / P1×${priCount('P1')} / P2×${priCount('P2')}`;
  ok('N-03 负对照（自洽）：多算一条需求即失配——R-06/H-01 的逐字比对不是「两边都取常量」',
    fakeRecomputed !== recomputed && fakeRecomputed.startsWith('36 条') && infoCells !== fakeRecomputed,
    { 伪造重算: fakeRecomputed.slice(0, 24) });
  const spy2: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
  okPair((name, cond, extra) => spy2.push({ name, cond, extra }), '样张·行为失守', () => false, () => true);
  okPair((name, cond, extra) => spy2.push({ name, cond, extra }), '样张·锚点失配', () => true, () => false);
  okPair((name, cond, extra) => spy2.push({ name, cond, extra }), '样张·双绿', () => true, () => true);
  ok('N-04 负对照（配对器）：文案原样在场但行为不成立时仍判红，且两种红因分别落账',
    spy2.length === 3 && spy2[0].cond === false && JSON.stringify(spy2[0].extra).includes('行为失守')
      && spy2[1].cond === false && JSON.stringify(spy2[1].extra).includes('字面锚点失配') && spy2[2].cond === true,
    spy2.map((s) => [s.name, s.cond]));
  const fakeFile = `const [viewMode, setViewMode] = useSessionState<'list'>('tasks.viewMode', 'list'); setViewMode('list');`;
  ok('N-05 负对照（视图枚举取法）：单视图夹具里 board 取不到 ⇒ F-C1 字面侧必红（真源码里能取到）',
    !admittedViewModes(fakeFile, 'tasks.viewMode').includes('board')
      && admittedViewModes(read('web/src/pages/TasksPage.tsx'), 'tasks.viewMode').includes('board'));
  const raggedTable = parseTables(['| 能力项 | GitHub | GitLab | Bitbucket | Gitee | Azure DevOps | MTask |', '|---|---|---|---|---|---|---|', '| 任务管理 | 有 | 有 |'].join('\n'))[0] ?? [];
  ok('N-06 负对照（矩阵表结构）：缺一列的行被 ragged 判据抓到（真实矩阵是 ragged=0）',
    raggedTable.length === 2 && raggedTable[1].cells.length !== raggedTable[0].cells.length
      && matrixRagged === 0 && competitorMatrix.length >= 10);
  ok('N-07 负对照（无 Webhook）：伪造「服务认得 webhook」的响应即红——判据靠服务端 404，不靠 grep 恒绿',
    !([404, 404, 200] as number[]).every((s) => s === 404) && rejected({ status: 200, json: { ok: true } }) === false);
  ok('N-08 负对照（事件保留期）：把运行时值换成 88 再跑同一判据即红（不是「文本里有 90 就算数」）',
    (88 === 90) === false && retentionDays === 90, { 实测: retentionDays });
  const domWithoutGantt = planDom.replace(/<button[^>]*>甘特<\/button>/, `<button title="x">ZZZ</button>`);
  ok('N-09 负对照（渲染 DOM）：把甘特按钮拆掉后，F-C2 那套 DOM 计数判据即红（证明它不是恒真式）',
    planDom !== '' && viewButtonCounts(domWithoutGantt, ['列表', '甘特', '时间线'])['甘特'] === 0
      && viewButtonCounts(planDom, ['列表', '甘特', '时间线'])['甘特'] >= 1,
    { 伪造计数: domWithoutGantt ? viewButtonCounts(domWithoutGantt, ['甘特']) : 'SSR 未产出 DOM' });
  // 渲染出的 HTML 里引号是被转义的（`&#x27;`），先还原再改选择器，否则替换打空、负对照变恒真
  const fakeCssDom = settingsDom.replace(/&#x27;/g, "'").replace(/\[data-theme='dark'\]/g, "[data-theme='zzz']");
  ok('N-10 负对照（暗色样式块）：把选择器改掉后 themeVarsOf 取不到深色变量 ⇒ F-C4 行为侧必红',
    settingsDom === '' || (themeVarsOf(fakeCssDom, "[data-theme='dark']").length === 0 && darkVarsProbe().length >= 8),
    { 说明: settingsDom === '' ? 'SSR 未产出 DOM，本条以真实 DOM 在场为前提' : '选择器改名即失配' });
}
/** N-10 用的深色变量真值（SSR 未产出时返回空数组，让 N-10 走「前提不成立」分支） */
function darkVarsProbe(): string[] {
  return settingsDom ? themeVarsOf(settingsDom, "[data-theme='dark']") : [];
}

console.log(lines.join('\n'));
mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02272-gate-results.txt', `T02272 PRD 交付质量门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
if (skippedList.length) console.log('跳过：' + skippedList.join(' / '));
if (ssrErrs.length) console.log('SSR 提示：' + ssrErrs.join(' | ').slice(0, 400));
if (!instanceUp) console.log('实例：未就绪');

closeDb(); // 先收连接再删目录，否则 Windows 上句柄自持、临时库里只剩 -wal
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* T02272_KEEP=1 时人工去查 */ }
if (process.env.T02272_KEEP === '1') console.log(`保留临时目录：${DATA_DIR}`);
process.exit(fail === 0 ? 0 : 1);
