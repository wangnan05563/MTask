/**
 * T02157 门：AI 报表周期口吻与数据窗口（选月报出周报 / 月报窗口错）。
 *
 * 根因（两条，均已修复）：
 *   ① 提示词硬编码：system 写死「AI 周报分析师…① 本周概况…④ 下周建议」，且 aiGenerateReport
 *      与流式版各存一份相同拷贝——选月报/日报时 AI 仍被指令写周报；
 *   ② periodRange 月报分支起点误用「今日 0 点」，区间变成 [今天, 下月1日)：丢掉本月已发生的
 *      大部分活动，又混进未来日期。
 *
 * 本文件是 T02293「按 `docs/验收门判据规约.md` 四条硬判据改判」版。
 * 改判前 16 个断言点：S-01~S-04 读 `server/src/services/ReportService.ts` 源码再正则匹配标识符/整行
 * 字面量，W-01~W-04 读 `web/src/pages/ReportConsole.tsx`、`ReportPage.tsx` 源码再匹配中文文案——
 * 这 8 条打在**源码文本**上（等价重构一改写法门即恒红）；U 组 8 条行为断言整组以「本机存在生产库
 * 副本」为前提，缺库时直接记 FAIL（把环境缺口判成功能失守）。本轮改判后 62 个断言点（0 FAIL、0 SKIP），
 * 改判口径：
 *
 *  1) 判据 1：上述 8 条源码文本锚**全部降级为 `okPair` 的字面腿**（S-01~S-04、WL-01~WL-04），
 *     字面锚一律取 `git show HEAD:<path>`（反模式 11：工作树可能躺着并发 WIP）；行为腿换成实测对象——
 *     · P 组：模型侧**真正收到**的提示词（门自起的 mock AI 记录 /v1/chat/completions 请求体，
 *       非流式与流式两条入口 × 三周期各打一次），两入口同周期 system 还要求逐字相同（=「收敛为单源」
 *       的行为证据，不再靠数源码里有几处 `buildReportPrompt(`）；
 *     · F 组：`gatherReportData(period)` 的返回值（起止/标签/命中行 + 月报跨度=本月天数）；
 *     · A 组：`POST /report/generate` 与 `POST /report/ai-download` 换回的 xlsx **解包后**
 *       sharedStrings 标题行、工作簿 sheet 名、响应头 Content-Disposition 下载名（共 3 + 6 份产物）；
 *     · W 组：真实 React 组件（ReportConsole / ReportPage / AiResultDownload）经 esbuild 编译期
 *       追加导出 + react-dom 渲染，从**元素树/静态标记**里取实际文案（门临时目录，产品工作树零写入）；
 *       页面组件的周期来自 `useSessionState('report.period')`，故由门给 sessionStorage 喂会话值再渲染。
 *  2) 判据 2：摘掉生产库依赖——隔离库由产品 `initSchema()` 自建在 `D:/code/tmp` 下的临时数据目录，
 *     夹具经 REST 真建（`POST /projects` ×2、`POST /tasks` ×4、`PATCH /tasks/:id {archived:true}` 归档一条——
 *     产品口径 `checkTaskPatchFields` 拒数字，必须传布尔）、`POST /aitools` 挂 mock 端点，业务行零 sqlite 直写；
 *     「范围外项目不入范围报表」「归档行不入报表」「全范围确含之」这些取数判据只引用本轮自造的行。
 *  3) 判据 4：负对照 N-01~N-11 与产物侧对照 A-08——窗口谓词对「起点错一天」与「修复前 [今天,下月1号) 形态」
 *     判假、口吻谓词对「串台稿」与「日报冒充月报」判假、单源字面腿对「把其中一处调用换成内联拷贝」判假、
 *     月报起点字面腿对「改回今日 0 点」判假、标签同源谓词对「改掉一个键」判假并配「三表各 3 键」分母腿
 *     （防空表比空表）、渲染谓词对「忽略周期写死周报」的变体组件**对月报判假而对周报判真**（证明谓词不恒假）、
 *     产物窗口串谓词拿日报产物反证月报不命中、空提示词必须判假（防 mock 没收到请求时 P 组恒真）、
 *     同一令牌二次下载必须 404、非法 token 判 400 而合法未落盘判 404（两类缺口不混判）。
 *  4) 判据 2 + 反模式 14：环境缺口（隔离实例没起来 / 夹具没建成 / 前端渲染通道取不出产物）一律
 *     `skipped()` 留痕、不计 PASS；S/WL 配对项声明成**惰性数组**，等 F/A/P/W 组实测回填 `RT` 之后
 *     在末尾统一发射——不在原位用「源码里有这句」冒充行为腿，也不提前取值拿空对象。
 *  5) 「下载即删、tmp 归零」（A-07）配对照面 A-07b「六次下载之前 tmp 里确有 6 份产物」，
 *     防 TMP 目录指错或产物根本没落盘时整组恒绿；A-08 再把「即删」打成可观测的二次下载 404。
 *  6) 实测发现但未纳入断言的残留（如实记在结果文件的 [NOTE] 行，不改产品码就不判红）：xlsx 里承载 AI
 *     洞察的工作表名在 HEAD 仍写死「AI 周报洞察」，选日报/月报时该 sheet 名不随周期变——本门只改判
 *     gates 脚本、不动产品码，故以 [NOTE] 留痕而非伪造成 PASS/FAIL。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02157-report-period.mts
 * 环境变量：`T02157_PORT`（默认在 38600~38980 挑空闲端口）、`T02157_TMP_ROOT`（默认 D:/code/tmp，
 * 必须落可写盘——本机 C: 常年 0 可用会假性 SQLITE_FULL 把绿判成红）。
 * 隔离纪律：门只打自起的隔离实例与自起的 mock AI（零真实配额），绝不连生产实例做写操作。
 * 结果落 .workbuddy/t02157-gate-results-<运行标识>.txt（命名口径见 scripts/lib/gate-results.mts）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
// 临时根落 D:（规约「临时副本与破坏性反证的边界」：C: 常年 0 可用会假性 SQLITE_FULL）
const TMP_ROOT = process.env.T02157_TMP_ROOT ?? 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02157-gate-'));
const TMP_DIR = join(DATA_DIR, 'tmp');
const SCRATCH = join(OUT_DIR, `t02157-dom-${process.pid}-${Date.now()}`);
// ⚠ 先定隔离库再 import 产品模块：门进程直调 gatherReportData→getDb 都指到这里，绝不碰生产库
process.env.MTask_DATA_DIR = DATA_DIR;

let pass = 0;
let fail = 0;
const skippedList: string[] = [];
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
/** 环境缺口如实记 SKIP（不计 PASS，也不冒充 FAIL）——规约判据 2 */
const skipped = (name: string, why: string) => {
  skippedList.push(`${name}：${why}`);
  lines.push(`[SKIP] ${name} —— ${why}（不计 PASS）`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** 字面锚一律取**已提交树**（工作树可能躺着别的会话留下的过期产品文件，反模式 11） */
const gitCache = new Map<string, string | null>();
function headSource(rel: string): string | null {
  if (gitCache.has(rel)) return gitCache.get(rel);
  let out: string | null = null;
  try {
    out = execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8', 'show', `HEAD:${rel}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
  } catch { out = null; }
  gitCache.set(rel, out);
  return out;
}

// =====================================================================
// 判据料：门侧期望表 + 三个值级谓词（正判与负对照共用同一把量具，N 组才有意义）
// =====================================================================
type Period = 'day' | 'week' | 'month';
const PERIODS: Period[] = ['day', 'week', 'month'];
/** 门侧独立重算的期望口吻表（口径来自 PRD/本单根因描述，不是从产品源码里抄回来的） */
const EXPECT: Record<Period, { label: string; role: string; overview: string; advice: string; alien: RegExp }> = {
  day: { label: '日报', role: 'AI 日报分析师', overview: '今日概况与总体结论', advice: '明日工作建议', alien: /周报|月报|本周|下周|本月|下月/ },
  week: { label: '周报', role: 'AI 周报分析师', overview: '本周概况与总体结论', advice: '下周工作建议', alien: /日报|月报|今日|明日|本月|下月/ },
  month: { label: '月报', role: 'AI 月报分析师', overview: '本月概况与总体结论', advice: '下月工作建议', alien: /日报|周报|今日|明日|本周|下周/ },
};
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** 期望窗口：门自己按 PRD 口径算一遍（日报 [今天,明天)、周报 [本周一,下周一)、月报 [本月1号,下月1号)） */
function expectRange(p: Period, now = new Date()): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === 'day') return { start: ymd(start), end: ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)) };
  if (p === 'week') {
    const monday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - ((now.getDay() + 6) % 7));
    return { start: ymd(monday), end: ymd(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7)) };
  }
  const first = new Date(start.getFullYear(), start.getMonth(), 1);
  return { start: ymd(first), end: ymd(new Date(start.getFullYear(), start.getMonth() + 1, 1)) };
}
const daySpan = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86_400_000);
/** 窗口谓词：标签、起止逐字对表，再要求**取值自身的跨度**等于期望跨度（修复前月报跨度=本月剩余天数，会在这里露馅） */
function windowJudge(p: Period, got: { periodLabel?: string; startDate?: string; endDate?: string }, now = new Date()): boolean {
  const e = expectRange(p, now);
  return got.periodLabel === EXPECT[p].label && got.startDate === e.start && got.endDate === e.end
    && daySpan(got.startDate ?? '', got.endDate ?? '') === daySpan(e.start, e.end) && daySpan(e.start, e.end) >= 1;
}
/** 口吻谓词：角色/①章节/④章节逐字命中，且不得出现**别的周期**的口吻词 */
function personaJudge(p: Period, system: string): boolean {
  const e = EXPECT[p];
  if (!system) return false; // 空提示词一律判假（P 组取数为空时不得恒真，规约反模式「空比空」）
  return system.includes(`你是 MTask 的 ${e.role}`) && system.includes(`中文${e.label}洞察`)
    && system.includes(`① ${e.overview}`) && system.includes(`④ ${e.advice}`) && !e.alien.test(system);
}
/** 周期标签表谓词：三张表（服务端返回值 / 控制台模块 / 页面模块）必须逐键相等且恰好三键 */
function tablesAgree(server: Record<string, string>, console_: Record<string, string>, page: Record<string, string>): boolean {
  const norm = (t: Record<string, string>) => Object.keys(t).sort().map((k) => `${k}=${t[k]}`).join(',');
  const a = norm(server), b = norm(console_), c = norm(page);
  return PERIODS.every((p) => !!server[p] && !!console_[p] && !!page[p]) && a === b && b === c && Object.keys(server).length === 3;
}
/** 渲染谓词：组件渲染产物里出现的「AI X报」标签必须**有且只有**当前周期那一个（正判与负对照共用这把量具） */
function renderPersonaJudge(blob: string, p: Period): boolean {
  const hits = [...new Set(blob.match(/AI (?:日报|周报|月报)/g) ?? [])];
  return hits.length === 1 && hits[0] === `AI ${EXPECT[p].label}`;
}
/** 下载入口渲染谓词：产物里「下载 AI X报」三处（title / aria-label / 按钮文本）必须全是本周期标签 */
function downloadJudge(blob: string, p: Period): boolean {
  const hits = blob.match(/下载 AI (?:日报|周报|月报)/g) ?? [];
  return hits.length === 3 && hits.every((h) => h === `下载 AI ${EXPECT[p].label}`);
}

// =====================================================================
// 实测回填位（反模式 14：配对项的行为腿只能取这里，取值一律晚于实测）
// =====================================================================
const RT: Record<string, any> = {
  up: false, seeded: false, domOk: false,
  win: {} as Record<Period, any>, // gatherReportData 返回值
  prompts: {} as Record<string, { system: string; user: string }>, // key = `${period}:${entry}`
  hits: 0, // mock 收到的模型调用次数
  fixtureIn: '', fixtureOut: '', archivedTitle: '', scopeTag: '',
  art: {} as Record<string, { text: string; name: string }>, // 解包后的 xlsx 产物文本 + 下载名
  tokens: {} as Record<string, { token: string; filename: string }>, // `${period}:${entry}` → AI 产物令牌
  aiArts: [] as Array<{ key: string; period: Period; text: string; name: string; status: number; bytes: number; sheets: string[] }>,
  aiArt: { text: '', bytes: 0 },
  tmpPeak: 0, tmpEmpty: false,
  dom: {} as Record<string, string>, // 渲染产物里 harvest 到的文案串
  srvLabels: {} as Record<string, string>,
};

// =====================================================================
// S 组配对项（**惰性数组**，实测组跑完后统一发射）：字面腿=HEAD 源码锚，行为腿=上面的实测值
// =====================================================================
const S_PAIRS: Array<{ label: string; needs?: 'server' | 'dom'; behavior: () => boolean; literal: () => boolean; ctx: () => unknown }> = [
  {
    label: 'S-01 提示词构造收敛为单源 buildReportPrompt（行为=两条入口同周期的 system 逐字相同且模型侧确实收到；字面=函数体外无第二份拷贝）',
    needs: 'server',
    behavior: () => PERIODS.every((p) => !!RT.prompts[`${p}:post`] && RT.prompts[`${p}:post`].system === RT.prompts[`${p}:stream`].system)
      && RT.hits >= PERIODS.length * 2,
    literal: () => {
      const RS = strip(headSource('server/src/services/ReportService.ts') ?? '');
      return /export function buildReportPrompt\(/.test(RS)
        && (RS.match(/const \{ system, user \} = buildReportPrompt\(/g) ?? []).length === 2;
    },
    ctx: () => ({ 模型调用次数: RT.hits, 月报两入口相同: RT.prompts['month:post']?.system === RT.prompts['month:stream']?.system }),
  },
  {
    label: 'S-02 入口层零硬编码周报口吻（行为=选日报/月报时模型收到的 system 里没有任何周/月串台词；字面=周报分析师只出现在口吻表的 week 行）',
    needs: 'server',
    behavior: () => personaJudge('day', RT.prompts['day:post']?.system ?? '') && personaJudge('month', RT.prompts['month:post']?.system ?? '')
      && personaJudge('day', RT.prompts['day:stream']?.system ?? '') && personaJudge('month', RT.prompts['month:stream']?.system ?? ''),
    literal: () => {
      const RS = strip(headSource('server/src/services/ReportService.ts') ?? '');
      const personaBlock = /const REPORT_PERSONA[\s\S]*?\n};/.exec(RS)?.[0] ?? '';
      const rest = RS.replace(personaBlock, '');
      return /AI 周报分析师/.test(personaBlock) && !/AI 周报分析师/.test(rest) && !/本周概况/.test(rest)
        && !/下周工作建议/.test(rest) && !/中文周报洞察/.test(rest);
    },
    ctx: () => ({ 日报system首行: (RT.prompts['day:post']?.system ?? '').slice(0, 60), 月报system首行: (RT.prompts['month:post']?.system ?? '').slice(0, 60) }),
  },
  {
    label: 'S-03 周期口吻表按 period 分派（行为=三周期收到的 system 互不相同且各自口吻判真；字面=day/week/month 三行各自的角色与起止章节）',
    needs: 'server',
    behavior: () => {
      const sys = PERIODS.map((p) => RT.prompts[`${p}:post`]?.system ?? '');
      return PERIODS.every((p, i) => personaJudge(p, sys[i])) && new Set(sys).size === 3;
    },
    literal: () => {
      const RS = strip(headSource('server/src/services/ReportService.ts') ?? '');
      return /day: \{ role: 'AI 日报分析师', overview: '今日概况与总体结论', advice: '明日工作建议' \}/.test(RS)
        && /week: \{ role: 'AI 周报分析师', overview: '本周概况与总体结论', advice: '下周工作建议' \}/.test(RS)
        && /month: \{ role: 'AI 月报分析师', overview: '本月概况与总体结论', advice: '下月工作建议' \}/.test(RS);
    },
    ctx: () => ({ 三种system互异数: new Set(PERIODS.map((p) => RT.prompts[`${p}:post`]?.system ?? '')).size }),
  },
  {
    label: 'S-04 月报数据窗口起点 = 本月 1 号 0 点（行为=gatherReportData 返回值 + xlsx 产物标题行 + 下载名三处一致；字面=月分支取 getMonth() 的 1 号）',
    needs: 'server',
    behavior: () => windowJudge('month', RT.win.month ?? {}) && /MTask 月报（month · /.test(RT.art.month?.text ?? '')
      && /^MTask-月报-\d{4}-\d{2}-01\.xlsx$/.test(RT.art.month?.name ?? ''),
    literal: () => /return \{ start: new Date\(start\.getFullYear\(\), start\.getMonth\(\), 1\), end: new Date\(start\.getFullYear\(\), start\.getMonth\(\) \+ 1, 1\) \};/
      .test(strip(headSource('server/src/services/ReportService.ts') ?? '')),
    ctx: () => ({ 月报窗口: [RT.win.month?.startDate, RT.win.month?.endDate], 下载名: RT.art.month?.name }),
  },
  {
    label: 'WL-01 控制台 tab 名/状态/下载名由周期标签派生（行为=真实 ReportConsole 渲染产物随 period 变成「AI 日报/AI 月报」且不再出现「AI 周报」；字面=aiReportLabel 派生式 + 无写死文案）',
    needs: 'dom',
    behavior: () => renderPersonaJudge(RT.dom.rcMonth ?? '', 'month') && renderPersonaJudge(RT.dom.rcDay ?? '', 'day')
      && renderPersonaJudge(RT.dom.rcWeek ?? '', 'week'),
    literal: () => {
      const RC = strip(headSource('web/src/pages/ReportConsole.tsx') ?? '');
      const code = RC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      return /const aiReportLabel = `AI \$\{periodLabelOf\(period\) \?\? '周报'\}`;/.test(RC)
        && /\{aiReportLabel\}/.test(RC) && !/AI 周报/.test(code) && !/'AI周报'|"AI周报"/.test(code);
    },
    ctx: () => ({
      月报渲染标签: [...new Set((RT.dom.rcMonth ?? '').match(/AI (?:日报|周报|月报)/g) ?? [])],
      日报渲染标签: [...new Set((RT.dom.rcDay ?? '').match(/AI (?:日报|周报|月报)/g) ?? [])],
    }),
  },
  {
    label: 'WL-02 报表页 AI/离线面板文案随周期联动（行为=真实 ReportPage 在会话周期=月报/日报时渲染出「AI 月报生成」「离线月报生成」且无写死周报；字面=三处派生式）',
    needs: 'dom',
    behavior: () => /AI 月报生成/.test(RT.dom.rpMonth ?? '') && /离线月报生成/.test(RT.dom.rpMonth ?? '')
      && !/AI 周报生成|离线周报生成/.test(RT.dom.rpMonth ?? '')
      && /AI 日报生成/.test(RT.dom.rpDay ?? '') && !/AI 周报生成|离线周报生成/.test(RT.dom.rpDay ?? '')
      && /AI 周报生成/.test(RT.dom.rpWeek ?? ''),
    literal: () => {
      const RP = strip(headSource('web/src/pages/ReportPage.tsx') ?? '');
      const code = RP.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      return /const periodLabel = PERIODS\.find\(\(p\) => p\.key === period\)\?\.label \?\? '周报';/.test(RP)
        && /const aiReportLabel = `AI \$\{periodLabel\}生成`;/.test(RP)
        && /const offlineReportLabel = `离线\$\{periodLabel\}生成`;/.test(RP)
        && !/AI 周报生成/.test(code) && !/离线周报生成/.test(code);
    },
    ctx: () => ({ 月报页面标签: [...new Set((RT.dom.rpMonth ?? '').match(/(?:AI |离线)(?:日报|周报|月报)生成/g) ?? [])] }),
  },
  {
    label: 'WL-03 下载入口按周期命名（行为=真实 AiResultDownload 组件渲染出的按钮/aria-label/title 含「下载 AI 月报」「下载 AI 日报」；字面=三处取 periodLabel）',
    needs: 'dom',
    behavior: () => (RT.dom.dlMonth ?? '').includes('下载 AI 月报') && (RT.dom.dlDay ?? '').includes('下载 AI 日报')
      && !/周报/.test(RT.dom.dlMonth ?? '') && !/日报/.test(RT.dom.dlWeek ?? '') && (RT.dom.dlWeek ?? '').includes('下载 AI 周报'),
    literal: () => {
      const RP = strip(headSource('web/src/pages/ReportPage.tsx') ?? '');
      return /readonly periodLabel: string;/.test(RP) && /下载 AI \{periodLabel\}/.test(RP) && /periodLabel=\{PERIODS\.find/.test(RP);
    },
    ctx: () => ({ 月报下载名: (RT.dom.dlMonth ?? '').slice(0, 120) }),
  },
  {
    label: 'WL-04 三处周期标签同源（行为=服务端返回值、控制台模块常量、页面模块常量三张表逐键相等且恰好三键；字面=两张源码表都映射到日报/周报/月报）',
    needs: 'dom',
    behavior: () => tablesAgree(RT.srvLabels, RT.dom.consoleTable ?? {}, RT.dom.pageTable ?? {}),
    literal: () => {
      const RC = strip(headSource('web/src/pages/ReportConsole.tsx') ?? '');
      const RP = strip(headSource('web/src/pages/ReportPage.tsx') ?? '');
      return /const PERIOD_LABEL: Record<string, string> = \{ day: '日报', week: '周报', month: '月报' \};/.test(RC)
        && /\{ key: 'day', label: '日报' \}/.test(RP) && /\{ key: 'month', label: '月报' \}/.test(RP);
    },
    ctx: () => ({ 服务端: RT.srvLabels, 控制台: RT.dom.consoleTable, 页面: RT.dom.pageTable }),
  },
];

// =====================================================================
// mock AI：记录模型侧真正收到的提示词（openai 兼容 /v1/chat/completions），非流式给 JSON、流式给 SSE
// =====================================================================
const INSIGHT_TEXT = '## 门内洞察\n本月完成 3 项、进行中 2 项；风险提示：里程碑临近，建议例会跟节点走。';
let mockDelayMs = 0;
const captured: Array<{ stream: boolean; system: string; user: string }> = [];
const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    let j: any = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* 非 JSON 也照样回，交给产品自己的失败面 */ }
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    captured.push({ stream: j.stream === true, system: String(msgs[0]?.content ?? ''), user: String(msgs[1]?.content ?? '') });
    const reply = () => {
      if (j.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: INSIGHT_TEXT }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: INSIGHT_TEXT }, finish_reason: 'stop' }] }));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// 隔离实例（库由产品 initSchema 自建，零生产库接触）
// =====================================================================
const CN = (await import('../server/src/db/schema.ts')) as Record<string, any>;
CN.initSchema();
const DB = (await import('../server/src/db/connection.ts')) as Record<string, any>;
const RS = await import('../server/src/services/ReportService.ts') as Record<string, any>;
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));

async function freePort(): Promise<number> {
  const net = await import('node:net');
  for (let i = 0; i < 10; i++) {
    const p = 38_600 + Math.floor(Math.random() * 380);
    const usable = await new Promise<boolean>((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (usable) return p;
  }
  return 38_600 + Math.floor(Math.random() * 380);
}
const PORT = Number(process.env.T02157_PORT ?? (await freePort()));
const BASE = `http://127.0.0.1:${PORT}/api`;

const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
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
    await sleep(400);
  }
  return false;
}
async function call(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, body, ctype: res.headers.get('content-type') ?? '', disposition: res.headers.get('content-disposition') ?? '', text };
}
/** 解包 xlsx 拿正文文本（产物级判据，不比压缩包字节） */
async function unzipXlsxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const parts: string[] = [];
  for (const f of ['xl/sharedStrings.xml', 'xl/workbook.xml']) {
    const file = zip.file(f);
    if (file) parts.push(await file.async('string'));
  }
  return parts.join('\n').replace(/<[^>]+>/g, '|').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}
const dispositionName = (h: string) => {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(h);
  try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m?.[1] ?? ''; }
};
/** 解包 xlsx 拿工作表名（产物级： sheet 名也是用户看得见的口径） */
async function unzipXlsxSheets(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file('xl/workbook.xml');
  if (!file) return [];
  return [...(await file.async('string')).matchAll(/<sheet[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
}
/** 门侧 mock 回给产品的洞察正文里可寻址的三个片段（xlsx 里逐行落格，整段不可连续检索，故按片段打） */
const INSIGHT_FRAGMENTS = ['门内洞察', '本月完成 3 项', '里程碑临近'];

// =====================================================================
// 主流程
// =====================================================================
ok('E-00 隔离库已由产品自身 initSchema() 建在门内临时目录（判据 2：门不依赖任何既有库）',
  existsSync(join(DATA_DIR, 'mtask.db')), { dataDir: DATA_DIR });
RT.up = await waitUp();
if (!RT.up) ok('E-00b 隔离实例健康检查通过', false, serverLog.join('').slice(-600));

/** 夹具没建成时后面每条都是「环境缺口」而非「行为失守」——如实记 SKIP，不冒充 PASS/FAIL */
const okB = (name: string, cond: boolean, extra?: unknown) => {
  if (!RT.up || !RT.seeded) skipped(name, RT.up ? '门内夹具项目未建成（见 E-02）' : '隔离实例未启动，行为腿无从实测');
  else ok(name, cond, extra);
};

if (RT.up) {
  ok('E-00b 隔离实例健康检查通过', true);
  // ---------------- E 组：门内夹具（全部经 REST 真建，判据 2） ----------------
  const tag = `T02157夹具${process.pid % 10000}${Date.now() % 100000}`;
  RT.scopeTag = tag;
  const inName = `${tag}·范围内项目`;
  const outName = `${tag}·范围外项目`;
  const pIn = await call('POST', '/projects', { name: inName });
  const pOut = await call('POST', '/projects', { name: outName });
  const PID_IN = String(pIn.body?.id ?? '');
  const PID_OUT = String(pOut.body?.id ?? '');
  ok('E-02 门内经 POST /projects 真建两个夹具项目（范围内/范围外各一，不引用生产库任何一行）',
    pIn.status === 201 && pOut.status === 201 && PID_IN.length > 0 && PID_OUT.length > 0 && PID_IN !== PID_OUT,
    { inStatus: pIn.status, outStatus: pOut.status });

  const tA = `${tag}·月内任务A`;
  const tB = `${tag}·月内任务B`;
  const tC = `${tag}·将被归档的任务C`;
  const tOut = `${tag}·范围外任务X`;
  const mk = await Promise.all([
    call('POST', '/tasks', { projectId: PID_IN, title: tA, description: '门内夹具正文' }),
    call('POST', '/tasks', { projectId: PID_IN, title: tB, description: '门内夹具正文' }),
    call('POST', '/tasks', { projectId: PID_IN, title: tC, description: '门内夹具正文' }),
    call('POST', '/tasks', { projectId: PID_OUT, title: tOut, description: '门内夹具正文' }),
  ]);
  RT.fixtureIn = tA; RT.fixtureOut = tOut;
  ok('E-03 门内经 POST /tasks 真建 4 条任务（3 条在范围内项目、1 条在范围外项目），全部 201',
    mk.every((r) => r.status === 201), mk.map((r) => r.status));

  // 产品接口口径：PATCH /tasks/:id 的 archived 需为布尔值（checkTaskPatchFields 拒数字）
  const arch = await call('PATCH', `/tasks/${String(mk[2].body?.id ?? '')}`, { archived: true });
  RT.archivedTitle = tC;
  const archOk = arch.status === 200 && Number(arch.body?.archived) === 1;
  ok('E-04 归档一条任务经 PATCH /tasks/:id 生效（读回 archived=1，供「归档不入报表」判据用）',
    archOk, { status: arch.status, archived: arch.body?.archived, error: arch.body?.error });

  const tool = await call('POST', '/aitools', {
    name: `t02157-mock-${tag}`, type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`,
    apiKey: 'mock-key', model: 'mock-insight', timeoutMs: 20000,
  });
  const toolId = String(tool.body?.id ?? '');
  ok('E-05 mock AI 工具已建（提示词与洞察都走本地 mock，零真实配额）', tool.status === 201 && toolId.length > 0, tool.body);

  RT.seeded = pIn.status === 201 && pOut.status === 201 && toolId.length > 0 && mk.every((r) => r.status === 201) && archOk;
  if (!RT.seeded) skipped('E 组之后的 F/A/P 组', '夹具项目/任务/AI 工具未全部建成');

  // ---------------- F 组：周期窗口（纯函数返回值 + 库查询结果） ----------------
  const now = new Date();
  for (const p of PERIODS) RT.win[p] = RS.gatherReportData(p, [PID_IN]);
  okB('F-01 日报窗口 = [今天, 明天) 且 label=日报（gatherReportData 返回值）', windowJudge('day', RT.win.day), { s: RT.win.day?.startDate, e: RT.win.day?.endDate });
  okB('F-02 周报窗口 = [本周一, 下周一) 且 label=周报', windowJudge('week', RT.win.week), { s: RT.win.week?.startDate, e: RT.win.week?.endDate });
  okB('F-03 月报窗口 = [本月 1 号, 下月 1 号) 且 label=月报（修复前是 [今天, 下月1号)）', windowJudge('month', RT.win.month), { s: RT.win.month?.startDate, e: RT.win.month?.endDate, 期望: expectRange('month', now) });
  okB('F-04 月报窗口跨度 = 本月天数（跨度对不上就说明起点仍是「今日 0 点」）',
    daySpan(RT.win.month?.startDate ?? '', RT.win.month?.endDate ?? '') ===
      new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
    { 跨度: daySpan(RT.win.month?.startDate ?? '', RT.win.month?.endDate ?? ''), 本月天数: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() });
  const titlesIn = (d: any) => (d?.tasks ?? []).map((t: any) => t.title) as string[];
  okB('F-05 今天更新的夹具任务在三个窗口都命中（窗口真的把当期活动取进来）',
    PERIODS.every((p) => titlesIn(RT.win[p]).includes(tA) && titlesIn(RT.win[p]).includes(tB)),
    PERIODS.map((p) => titlesIn(RT.win[p]).length));
  okB('F-06 归档任务不进任何窗口报表（archived=0 过滤在位）',
    PERIODS.every((p) => !titlesIn(RT.win[p]).includes(tC)), PERIODS.map((p) => titlesIn(RT.win[p]).includes(tC)));
  okB('F-07 范围外项目的任务不进「范围内」报表（project_id 范围过滤在位）',
    PERIODS.every((p) => !titlesIn(RT.win[p]).includes(tOut)), PERIODS.map((p) => titlesIn(RT.win[p]).length));
  const all = RS.gatherReportData('month') as any;
  okB('F-08 对照面：不限范围时范围外任务确实出现（证明 F-07 的「不含」不是「报表本来就空」）',
    titlesIn(all).includes(tOut) && titlesIn(all).includes(tA), { 全范围条数: (all?.tasks ?? []).length });
  okB('F-09 服务端周期标签返回值构成 {day:日报, week:周报, month:月报} 这张表（供 WL-04 行为腿用）',
    PERIODS.every((p) => RT.win[p]?.periodLabel === EXPECT[p].label), PERIODS.map((p) => [p, RT.win[p]?.periodLabel]));
  RT.srvLabels = Object.fromEntries(PERIODS.map((p) => [p, String(RT.win[p]?.periodLabel ?? '')]));

  // ---------------- A 组：报表产物（解包后的 xlsx XML + 下载名） ----------------
  for (const p of PERIODS) {
    const res = await fetch(BASE + '/report/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period: p, format: 'xlsx', projectId: PID_IN }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    RT.art[p] = { text: buf.length > 200 ? await unzipXlsxText(buf) : '', name: dispositionName(res.headers.get('content-disposition') ?? ''), status: res.status };
  }
  const eM = expectRange('month', now);
  const eD = expectRange('day', now);
  okB('A-01 月报 xlsx 产物标题行含「MTask 月报（month · 本月1号 ~ 下月1号）」（解包 sharedStrings 实测）',
    (RT.art.month?.text ?? '').includes(`MTask 月报（month · ${eM.start} ~ ${eM.end}）`), (RT.art.month?.text ?? '').slice(0, 160));
  okB('A-02 日报 xlsx 产物标题行含「MTask 日报（day · 今天 ~ 明天）」',
    (RT.art.day?.text ?? '').includes(`MTask 日报（day · ${eD.start} ~ ${eD.end}）`), (RT.art.day?.text ?? '').slice(0, 160));
  okB('A-03 月报下载名 = MTask-月报-<本月1号>.xlsx（修复前用今日）',
    RT.art.month?.name === `MTask-月报-${eM.start}.xlsx`, { name: RT.art.month?.name, 期望: `MTask-月报-${eM.start}.xlsx` });
  okB('A-04 月报产物含范围内夹具任务标题、不含范围外任务标题（产物里的数据就是门内这批）',
    (RT.art.month?.text ?? '').includes(tA) && !(RT.art.month?.text ?? '').includes(tOut), { 命中: (RT.art.month?.text ?? '').includes(tA) });

  // ---------------- P 组：模型侧真正收到的提示词（两条入口 × 三周期），令牌全部回收 ----------------
  const before = () => captured.length;
  const take = (n0: number, stream: boolean) => captured.slice(n0).filter((c) => c.stream === stream).slice(-1)[0] ?? { stream, system: '', user: '' };
  for (const p of PERIODS) {
    const n0 = before();
    const r = await call('POST', '/report/ai-generate', { period: p, format: 'xlsx', projectId: PID_IN, toolId });
    RT.prompts[`${p}:post`] = take(n0, false);
    RT.tokens[`${p}:post`] = { token: String(r.body?.token ?? ''), filename: String(r.body?.filename ?? '') };
    okB(`P-0${PERIODS.indexOf(p) + 1} 非流式入口 ${EXPECT[p].label}：模型收到的 system 口吻与 period 严格对应`,
      r.status === 200 && personaJudge(p, (RT.prompts[`${p}:post`] as any).system), { status: r.status, 首行: (RT.prompts[`${p}:post`] as any).system.slice(0, 70) });
  }
  for (const p of PERIODS) {
    const n0 = before();
    const ac = new AbortController();
    let raw = '';
    let done: any = null;
    try {
      const res = await fetch(BASE + '/report/ai-generate-stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: p, format: 'xlsx', projectId: PID_IN, toolId }), signal: ac.signal,
      });
      const reader = res.body?.getReader();
      if (reader) for (;;) { const { done: d, value } = await reader.read(); if (d) break; raw += new TextDecoder().decode(value); }
    } catch { /* 流被产品正常收尾 */ }
    const ev = (name: string) => {
      const m = new RegExp(`event: ${name}\\ndata: (\\{.*?\\})\\n\\n`, 's').exec(raw);
      try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
    };
    done = ev('done');
    RT.prompts[`${p}:stream`] = take(n0, true);
    RT.tokens[`${p}:stream`] = { token: String(done?.token ?? ''), filename: String(done?.filename ?? '') };
    okB(`P-0${PERIODS.indexOf(p) + 4} 流式入口 ${EXPECT[p].label}：模型收到的 system 口吻同样随 period 走（两入口不再各存拷贝）`,
      !!done && personaJudge(p, (RT.prompts[`${p}:stream`] as any).system), { status: raw ? 200 : 0, 帧: raw.slice(0, 80), 首行: (RT.prompts[`${p}:stream`] as any).system.slice(0, 70) });
  }
  RT.hits = captured.length;
  okB('P-07 分母腿：mock 本轮确实收到 6 次模型调用（3 周期 × 2 入口；一次都没收到的话上面每条 P 都是空判据）',
    RT.hits === PERIODS.length * 2, { 次数: RT.hits, 明细: captured.map((c) => c.stream ? 'S' : 'N') });
  okB('P-08 三周期收到的 system 互不相同（同一段拷贝换标签的形态会在这里露馅）',
    new Set(PERIODS.map((p) => (RT.prompts[`${p}:post`] as any).system)).size === 3, PERIODS.map((p) => (RT.prompts[`${p}:post`] as any).system.slice(0, 30)));
  okB('P-09 两入口同周期的 system 逐字相同（提示词单源的行为证据）',
    PERIODS.every((p) => (RT.prompts[`${p}:post`] as any).system === (RT.prompts[`${p}:stream`] as any).system),
    PERIODS.map((p) => [(RT.prompts[`${p}:post`] as any).system.length, (RT.prompts[`${p}:stream`] as any).system.length]));
  okB('P-10 user 段【周期】行与 gatherReportData 的起止逐字一致（口吻与数据口径同源）',
    PERIODS.every((p) => new RegExp(`【周期】${EXPECT[p].label} ${RT.win[p].startDate} ~ ${RT.win[p].endDate}`).test((RT.prompts[`${p}:post`] as any).user)),
    PERIODS.map((p) => ((RT.prompts[`${p}:post`] as any).user.match(/【周期】[^\n]*/) ?? [''])[0]));
  okB('P-11 月报请求喂给模型的【任务明细】里确有门内夹具任务（提示词不是空壳）',
    (RT.prompts['month:post'] as any).user.includes(tA) && (RT.prompts['month:post'] as any).user.includes(inName),
    { user: ((RT.prompts['month:post'] as any).user ?? '').slice(0, 120) });

  // ---------------- A 组（AI 产物面）：两入口 × 三周期共 6 份令牌，逐份下载即删并解包 ----------------
  // 对照面取数点必须早于任何一次下载：此时 6 份产物都还躺在 tmp 里
  RT.tmpPeak = existsSync(TMP_DIR) ? readdirSync(TMP_DIR).length : 0;
  for (const p of PERIODS) {
    for (const entry of ['post', 'stream'] as const) {
      const key = `${p}:${entry}`;
      const token = String(RT.tokens[key]?.token ?? '');
      const filename = String(RT.tokens[key]?.filename ?? '');
      const dl = await fetch(BASE + '/report/ai-download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, filename }),
      });
      const buf = Buffer.from(await dl.arrayBuffer());
      RT.aiArts.push({
        key, period: p, status: dl.status, bytes: buf.length,
        text: buf.length > 200 ? await unzipXlsxText(buf) : '',
        name: dispositionName(dl.headers.get('content-disposition') ?? ''),
        sheets: buf.length > 200 ? await unzipXlsxSheets(buf) : [],
      });
    }
  }
  okB('A-05 六份 AI 产物（两入口 × 三周期）解包后的标题行都随 period 走（窗口串逐字对表，不再是月报独检）',
    RT.aiArts.length === PERIODS.length * 2 && RT.aiArts.every((a) => {
      const e = expectRange(a.period, now);
      return a.status === 200 && a.text.includes(`MTask ${EXPECT[a.period].label}（${a.period} · ${e.start} ~ ${e.end}）`);
    }), RT.aiArts.map((a) => [a.key, a.status, a.bytes, a.text.slice(0, 30)]));
  okB('A-05b 六份 AI 产物正文都含 mock 回传的洞察片段（洞察真落进产物，不是只回了个空壳）',
    RT.aiArts.length === PERIODS.length * 2 && RT.aiArts.every((a) => INSIGHT_FRAGMENTS.every((f) => a.text.includes(f))),
    { 片段: INSIGHT_FRAGMENTS, 首份命中: RT.aiArts.map((a) => INSIGHT_FRAGMENTS.map((f) => a.text.includes(f))) });
  okB('A-06 AI 产物下载名逐条 = MTask-AI-<周期标签>-<窗口起点>.xlsx（done 事件名与 Content-Disposition 回环一致）',
    RT.aiArts.every((a) => {
      const want = `MTask-AI-${EXPECT[a.period].label}-${expectRange(a.period, now).start}.xlsx`;
      return a.name === want && RT.tokens[a.key]?.filename === want;
    }), RT.aiArts.map((a) => [a.key, a.name, RT.tokens[a.key]?.filename]));
  const dupToken = RT.tokens['month:post']?.token ?? '';
  const dupName = RT.tokens['month:post']?.filename ?? '';
  const dup = await call('POST', '/report/ai-download', { token: dupToken, filename: dupName });
  okB('A-08 下载即删有牙：同一令牌二次下载必须 404（若仍返回 200 就是「即删」没生效）',
    dupToken.length > 0 && dup.status === 404, { status: dup.status, body: dup.body });
  // 产物面口径留痕（不是断言项）：xlsx 里 AI 工作表名在 HEAD 仍写死「AI 周报洞察」，
  // 选月报时该 sheet 名不随周期变——本门只改判 gates 脚本、不动产品码，故如实记 NOTE 不判红。
  const sheetNames = [...new Set(RT.aiArts.flatMap((a) => a.sheets))];
  lines.push(`[NOTE] 产物面残留周期串台（非断言项，产品码不在本轮改动范围）：xlsx 工作表名实测为 ${JSON.stringify(sheetNames)}`);

  // ---------------- W 组：真实组件渲染产物（esbuild 编译期追加导出 + react-dom） ----------------
  try {
    mkdirSync(SCRATCH, { recursive: true });
    const g = globalThis as any;
    g.document ??= { baseURI: `${BASE.replace(/\/api$/, '/')}`, body: { nodeType: 1, appendChild() {} }, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: () => ({ nodeType: 1, style: {} }) };
    g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
    const SEED: Record<string, string> = {};
    g.sessionStorage ??= { getItem: (k: string) => SEED[k] ?? null, setItem() {}, removeItem() {} };
    g.window ??= { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1280, innerHeight: 800 };
    const React = (await import('react')).default as any;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const esbuild = (await import('esbuild')).default as any;
    const build = async (productFile: string, expose: string[], tag2: string) => {
      const outfile = join(SCRATCH, `${tag2}.mjs`);
      const norm = productFile.replace(/[\\]/g, '/');
      await esbuild.build({
        absWorkingDir: ROOT, entryPoints: [productFile], bundle: true, format: 'esm',
        platform: 'browser', target: 'es2022', jsx: 'automatic', outfile, logLevel: 'silent',
        plugins: [{
          name: 't02157-expose-private',
          setup(b: any) {
            b.onResolve({ filter: /.*/ }, (a: any) => {
              const p = a.path.replace(/[\\]/g, '/');
              if (p === norm || p.startsWith('.') || /^([a-zA-Z]:[\\/]|\/)/.test(p) || p.startsWith('api:')) return undefined;
              return { path: a.path, external: true }; // 裸依赖留给 Node 解析（react/lucide-react）
            });
            b.onLoad({ filter: new RegExp(productFile.replace(/[\\\/]/g, '[\\\\/]') + '$') }, (a: any) => ({
              loader: 'tsx' as const,
              contents: readFileSync(a.path, 'utf8') + '\n' + expose.map((n) => `export { ${n} as __gate_${n} };`).join('\n') + '\n',
            }));
          },
        }],
      });
      const mod = await import(pathToFileURL(outfile).href);
      // 两条腿都在场才算真拿到了私有成员：追加导出指向不存在的名字时 esbuild 只给 warning，
      // 这里显式要求取到——组件改名/挪走时本组如实失明报错，不静默变绿（规约反模式 12）
      for (const n of expose) if (mod[`__gate_${n}`] === undefined) throw new Error(`产品里取不到 ${n}（改名或挪走 → W 组失明）`);
      return mod;
    };
    /** 最小 hooks 调度器：跑真实组件函数体拿它自己产出的元素树（页面组件无浏览器也行） */
    const mount = (Comp: any, props: any) => {
      const hooks: any[] = [];
      let idx = 0;
      const depKey = (d: any) => JSON.stringify(d ?? null);
      const dispatcher: any = {
        useState: (init: any) => { const i = idx++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], (v: any) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
        useReducer: (red: any, init: any) => { const i = idx++; if (!(i in hooks)) hooks[i] = init; return [hooks[i], (a: any) => { hooks[i] = red(hooks[i], a); }]; },
        useRef: (init: any) => { const i = idx++; if (!(i in hooks)) hooks[i] = { current: init === undefined ? null : init }; return hooks[i]; },
        useEffect: (_fn: any, deps: any) => { const i = idx++; const h = (hooks[i] ??= { dep: undefined as unknown }); h.dep = deps; },
        useLayoutEffect: (_fn: any, deps: any) => { const i = idx++; (hooks[i] ??= { dep: undefined }).dep = deps; },
        useMemo: (fn: any) => fn(), useCallback: (fn: any) => fn,
        useSyncExternalStore: (_sub: any, get: any, getServer?: any) => (getServer ?? get)(),
        useContext: (ctx: any) => ctx?._currentValue,
        useId: () => 'gate-id', useDebugValue: () => {}, useTransition: () => [false, (f: any) => f()],
        useDeferredValue: (v: any) => v, useImperativeHandle: () => {}, useInsertionEffect: () => {},
      };
      return (p: any = props) => {
        idx = 0;
        React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher;
        try { return Comp(p); } finally { React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = null; }
      };
    };
    const harvest = (node: any, out: string[]): string[] => {
      if (Array.isArray(node)) { for (const n of node) harvest(n, out); return out; }
      if (!node || typeof node !== 'object') { if (typeof node === 'string') out.push(node); return out; }
      const p = (node as any).props ?? {};
      for (const k of ['title', 'aria-label', 'placeholder']) if (typeof p[k] === 'string') out.push(p[k]);
      if (typeof node.type === 'string' && typeof p.children === 'string') out.push(p.children);
      harvest((node as any).children ?? p.children, out);
      return out;
    };

    const RC = await build(join(ROOT, 'web', 'src', 'pages', 'ReportConsole.tsx'), ['ReportConsole', 'PERIOD_LABEL'], 'rc');
    const RP = await build(join(ROOT, 'web', 'src', 'pages', 'ReportPage.tsx'), ['ReportPage', 'AiResultDownload', 'PERIODS'], 'rp');
    for (const p of PERIODS) {
      RT.dom[`rc${p[0].toUpperCase()}${p.slice(1)}`] = harvest(mount(RC.__gate_ReportConsole, { tools: [], toolId: '', onToolIdChange: () => {}, period: p })(), []).join(' | ');
      SEED['report.period'] = JSON.stringify(p); // 页面组件的周期来自 useSessionState，喂门内自造会话值
      RT.dom[`rp${p[0].toUpperCase()}${p.slice(1)}`] = harvest(mount(RP.__gate_ReportPage, {})(), []).join(' | ');
      RT.dom[`dl${p[0].toUpperCase()}${p.slice(1)}`] = renderToStaticMarkup(
        React.createElement(RP.__gate_AiResultDownload, { aiResult: { filename: `${tag}-月报.xlsx`, token: 'x' }, onDownload: async () => {}, periodLabel: EXPECT[p].label }),
      );
    }
    RT.dom.consoleTable = Object.fromEntries(Object.entries(RC.__gate_PERIOD_LABEL).filter(([k]) => PERIODS.includes(k as Period)));
    RT.dom.pageTable = Object.fromEntries((RP.__gate_PERIODS as Array<{ key: string; label: string }>).map((x) => [x.key, x.label]));
    RT.domOk = true;
    ok('W-01 真实 ReportConsole 渲染产物随 period 变（月报出「AI 月报」、日报出「AI 日报」，均无写死「AI 周报」）',
      renderPersonaJudge(RT.dom.rcMonth ?? '', 'month') && renderPersonaJudge(RT.dom.rcDay ?? '', 'day'),
      { 月报: [...new Set((RT.dom.rcMonth ?? '').match(/AI (?:日报|周报|月报)/g) ?? [])], 日报: [...new Set((RT.dom.rcDay ?? '').match(/AI (?:日报|周报|月报)/g) ?? [])] });
    ok('W-02 ReportConsole 选周报时仍是「AI 周报」（回归：联动不改坏默认周期）',
      renderPersonaJudge(RT.dom.rcWeek ?? '', 'week'), [...new Set((RT.dom.rcWeek ?? '').match(/AI (?:日报|周报|月报)/g) ?? [])]);
    ok('W-03 真实 ReportPage 的 AI/离线面板文案随会话周期联动（月报：AI 月报生成 + 离线月报生成，无周报字样）',
      /AI 月报生成/.test(RT.dom.rpMonth) && /离线月报生成/.test(RT.dom.rpMonth) && !/AI 周报生成|离线周报生成/.test(RT.dom.rpMonth),
      [...new Set(RT.dom.rpMonth.match(/(?:AI |离线)(?:日报|周报|月报)生成/g) ?? [])]);
    ok('W-03b 同一页面选日报时改出「AI 日报生成」「离线日报生成」（联动是随值移动，不是换个写死的第二常量）',
      /AI 日报生成/.test(RT.dom.rpDay) && /离线日报生成/.test(RT.dom.rpDay) && !/AI 周报生成|离线周报生成/.test(RT.dom.rpDay),
      [...new Set(RT.dom.rpDay.match(/(?:AI |离线)(?:日报|周报|月报)生成/g) ?? [])]);
    ok('W-04 真实 AiResultDownload 渲染的下载按钮/aria-label/title 都随 periodLabel 走（三周期各验一次）',
      PERIODS.every((p) => downloadJudge(RT.dom[`dl${p[0].toUpperCase()}${p.slice(1)}`] ?? '', p)), { 月报: (RT.dom.dlMonth ?? '').slice(0, 200) });
    ok('W-05 三处周期标签同源且恰三值（服务端返回值 / 控制台模块常量 / 页面模块常量逐键相等）',
      tablesAgree(RT.srvLabels, RT.dom.consoleTable, RT.dom.pageTable), { 服务端: RT.srvLabels, 控制台: RT.dom.consoleTable, 页面: RT.dom.pageTable });
    ok('W-06 分母腿：两张前端表都取到了真实值（拿空对象比空对象等于没测）',
      Object.keys(RT.dom.consoleTable ?? {}).length === 3 && Object.keys(RT.dom.pageTable ?? {}).length === 3 && RT.dom.rcMonth.length > 200,
      { 控制台键数: Object.keys(RT.dom.consoleTable ?? {}).length, 页面键数: Object.keys(RT.dom.pageTable ?? {}).length, 渲染长度: RT.dom.rcMonth.length });
  } catch (e) {
    skipped('W 组与 WL-01~WL-04 配对项', `前端渲染通道取不出产物：${e instanceof Error ? e.message : String(e)}`);
  }

  // ---------------- N 组：负对照（判据 4，同一把量具必须会翻脸） ----------------
  {
    const preFixMonth = { periodLabel: '月报', startDate: ymd(now), endDate: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 1)) };
    const offByOneDay = { periodLabel: '月报', startDate: `${eM.start.slice(0, 8)}02`, endDate: eM.end };
    const preFixDistinct = ymd(now) !== eM.start; // 只有「今日 ≠ 1 号」时修复前形态才与正确窗口可区分
    okB('N-01 窗口谓词有牙：起点错一天的月报窗口必判假；今日非 1 号时修复前形态 [今天, 下月1号) 也必判假；真实返回判真',
      windowJudge('month', offByOneDay) === false && windowJudge('month', RT.win.month) === true &&
        (!preFixDistinct || windowJudge('month', preFixMonth) === false),
      { 错一天: offByOneDay, 修复前形态: preFixMonth, 今日: ymd(now), 本月1号: eM.start, 可区分: preFixDistinct, 真实: [RT.win.month?.startDate, RT.win.month?.endDate] });
    const 串台 = (RT.prompts['month:post'] as any).system?.replace('中文月报洞察', '中文周报洞察').replace('① 本月概况与总体结论', '① 本周概况与总体结论') ?? '';
    okB('N-02 口吻谓词有牙：把月报 system 换成串台稿（月报角色 + 本周概况）必须判假，真实六条判真',
      串台.length > 0 && personaJudge('month', 串台) === false && PERIODS.every((p) => personaJudge(p, (RT.prompts[`${p}:post`] as any).system)),
      { 串台判定: personaJudge('month', 串台), 空串判定: personaJudge('month', '') });
    okB('N-03 口吻谓词对「另一种周期冒充」判假：拿日报的 system 去问月报，必须判假',
      personaJudge('month', (RT.prompts['day:post'] as any).system) === false && personaJudge('day', (RT.prompts['month:post'] as any).system) === false,
      { 日报当本月报: personaJudge('month', (RT.prompts['day:post'] as any).system) });
    const RS0 = strip(headSource('server/src/services/ReportService.ts') ?? '');
    const s1 = (t: string) => /export function buildReportPrompt\(/.test(t) && (t.match(/const \{ system, user \} = buildReportPrompt\(/g) ?? []).length === 2;
    const 分叉稿 = RS0.replace('const { system, user } = buildReportPrompt(', 'const { system, user } = { system: PERSONA_TEXT, user: PERSONA_TEXT },');
    okB('N-04 S-01 字面腿有牙：把其中一处单源调用换成内联拷贝（正是当初的 bug 形态），同一字面谓词必须转假',
      s1(RS0) === true && 分叉稿 !== RS0 && s1(分叉稿) === false, { 原样: s1(RS0), 换内联后: s1(分叉稿) });
    const s4 = (t: string) => /return \{ start: new Date\(start\.getFullYear\(\), start\.getMonth\(\), 1\), end: new Date\(start\.getFullYear\(\), start\.getMonth\(\) \+ 1, 1\) \};/.test(t);
    const 起点稿 = RS0.replace('new Date(start.getFullYear(), start.getMonth(), 1)', 'new Date(start.getFullYear(), start.getMonth(), start.getDate())');
    okB('N-05 S-04 字面腿有牙：把月分支起点改回「今日 0 点」，同一字面谓词必须转假',
      s4(RS0) === true && 起点稿 !== RS0 && s4(起点稿) === false, { 原样: s4(RS0), 改回今日: s4(起点稿) });
    const 改表 = { ...RT.dom.pageTable, day: '当日' } as Record<string, string>;
    okB('N-06 WL-04 同源谓词有牙：只改掉一个键（day→当日）必须判假；同时要求三张表键数都非零（防空表比空表）',
      tablesAgree(RT.srvLabels, RT.dom.consoleTable ?? {}, RT.dom.pageTable ?? {}) === true &&
        tablesAgree(RT.srvLabels, RT.dom.consoleTable ?? {}, 改表) === false &&
        Object.keys(RT.srvLabels).length === 3, { 改表判定: tablesAgree(RT.srvLabels, RT.dom.consoleTable ?? {}, 改表) });
    okB('N-07 产物窗口串谓词有牙：拿**日报**产物去问月报窗口串必须不命中，月报产物必须命中',
      (RT.art.day?.text ?? '').includes(`MTask 月报（month · ${eM.start} ~ ${eM.end}）`) === false &&
        (RT.art.month?.text ?? '').includes(`MTask 月报（month · ${eM.start} ~ ${eM.end}）`) === true,
      { 日报文本片段: (RT.art.day?.text ?? '').slice(0, 120) });
    okB('N-08 空判据反证：mock 没收到任何提示词时（空 system/user），P 组每条谓词都必须判假',
      personaJudge('month', '') === false && personaJudge('day', '') === false &&
        /【周期】月报/.test('') === false && ((RT.prompts['month:post'] as any).system ?? '').length > 100,
      { 实测system长度: ((RT.prompts['month:post'] as any).system ?? '').length });
    const badToken = await call('POST', '/report/ai-download', { token: 'not-a-uuid', filename: 'MTask-AI-月报-2026-10-01.xlsx' });
    const ghost = await call('POST', '/report/ai-download', { token: '00000000-0000-4000-8000-000000000000', filename: 'MTask-AI-月报-2026-10-01.xlsx' });
    okB('N-11 下载端点两类缺口不混判：非法 token 必须 400、合法但未落盘必须 404（若都返 200 则「下载即删」是假话）',
      badToken.status === 400 && ghost.status === 404, { 非法: badToken.status, 未落盘: ghost.status });
    // 「忽略周期写死周报」的变体组件：与正判共用同一把渲染量具，必须会翻脸
    let 写死 = '';
    try {
      const React2 = (await import('react')).default as any;
      const { renderToStaticMarkup: rt2 } = await import('react-dom/server');
      const Hardcoded = () => React2.createElement('button', { title: '下载 AI 周报', 'aria-label': '下载 AI 周报' }, '下载 AI 周报');
      写死 = rt2(React2.createElement(Hardcoded, { periodLabel: EXPECT.month.label }));
    } catch { /* 渲染通道不可用时下面两条记 SKIP */ }
    if (RT.domOk && 写死.length > 0) {
      ok('N-09 W-04 渲染谓词有牙：把下载入口换成「忽略 periodLabel 写死周报」的变体组件，同一谓词对月报判假、对周报判真（证明谓词不是恒假），真组件对月报判真',
        downloadJudge(写死, 'month') === false && downloadJudge(写死, 'week') === true && downloadJudge(RT.dom.dlMonth ?? '', 'month') === true,
        { 变体产物: 写死.slice(0, 120), 变体判月报: downloadJudge(写死, 'month'), 变体判周报: downloadJudge(写死, 'week') });
      ok('N-10 W-01 渲染谓词有牙：空产物判假、把日报渲染产物拿去问月报判假、真月报渲染产物判真',
        renderPersonaJudge('', 'month') === false && renderPersonaJudge(RT.dom.rcDay ?? '', 'month') === false && renderPersonaJudge(RT.dom.rcMonth ?? '', 'month') === true,
        { 空串: renderPersonaJudge('', 'month'), 日报产物问月报: renderPersonaJudge(RT.dom.rcDay ?? '', 'month') });
    } else if (RT.domOk) {
      skipped('N-09 变体组件渲染对照', 'react-dom 渲染变体组件失败，对照无产物可用');
    }
  }
} else {
  skipped('E/F/A/P/W/S/N 全部行为组', '隔离实例未启动（详见上面 E-00b 的服务端日志），不以源码文本冒充 PASS');
}

// =====================================================================
// S / WL 配对项发射（行为腿已由 F/A/P/W 组回填；缺口的记 SKIP）
// =====================================================================
lines.push('');
lines.push('== S/WL 组：源码文本锚降级后的配对项（字面锚取 git show HEAD:，行为腿取上面的实测值）');
for (const pr of S_PAIRS) {
  if (!RT.up || !RT.seeded) { skipped(pr.label, '隔离实例或门内夹具未就绪——行为腿无从实测'); continue; }
  if (pr.needs === 'dom' && !RT.domOk) { skipped(pr.label, '前端渲染通道取不出产物——行为腿无从实测'); continue; }
  okPair(ok, pr.label, pr.behavior, pr.literal, pr.ctx);
}

// =====================================================================
// 收尾：下载即删后 tmp 归零（配对照面），释放句柄、回收临时目录
// =====================================================================
RT.tmpEmpty = existsSync(TMP_DIR) ? readdirSync(TMP_DIR).length === 0 : true;
if (RT.up && RT.seeded) {
  ok('A-07 本轮所有 AI 产物都下载即删，隔离 tmp 目录回到空（门不留孤儿令牌）', RT.tmpEmpty === true, { tmp: existsSync(TMP_DIR) ? readdirSync(TMP_DIR) : [] });
  ok('A-07b 对照面：六次下载开始之前 tmp 里确有 6 份产物（否则 A-07 是拿空目录比空目录）', RT.tmpPeak >= PERIODS.length * 2, { tmpPeak: RT.tmpPeak });
} else {
  skipped('A-07 / A-07b 零残留判据', '未走完生成链路，无产物可核对');
}

mock.close();
child.kill();
try { DB.closeDb(); } catch { /* 未打开则忽略 */ }
for (const d of [SCRATCH]) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟 */ }
}
for (let i = 0; i < 25; i++) {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); break; }
  catch { if (i === 24) lines.push('[WARN] 临时目录未回收（子进程句柄未释放）：' + DATA_DIR); await sleep(200); }
}

lines.unshift(`T02157 报表周期口吻/窗口门（T02293 改判版）：PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02157-gate-results.txt', lines.join('\n') + (skippedList.length ? `\n跳过项：\n${skippedList.join('\n')}\n` : ''), { port: PORT, dataDir: DATA_DIR });
console.log(`PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
