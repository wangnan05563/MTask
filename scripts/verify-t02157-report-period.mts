/**
 * T02157 门：AI 报表周期口吻与数据窗口（选月报出周报 / 月报窗口错）。
 *
 * 根因（两条，均已修复）：
 *   ① 提示词硬编码：system 写死「AI 周报分析师…① 本周概况…④ 下周建议」，且
 *      aiGenerateReport 与流式版各存一份相同拷贝——选月报/日报时 AI 仍被指令写周报；
 *   ② periodRange 月报分支起点误用「今日 0 点」，区间变成 [今天, 下月1日)：
 *      丢掉本月已发生的大部分活动，又混进未来日期。
 * 修复：buildReportPrompt(period, …) 按 period 分派角色与章节口吻（两入口共用），
 *      月报起点改本月 1 号 0 点。
 *
 * 断言组：
 *   S 组 源码守卫：入口不再各存提示词拷贝、无硬编码周报口吻、月分支取 1 号。
 *   U 组 真行为（生产库只读副本 + 临时 DATA_DIR）：三周期数据窗口正确；
 *      三周期提示词语句与周期严格对应（月报无「周」味、日报无「周/月」味）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02157-report-period.mts
 * 结果落 .workbuddy/t02157-gate-results-<运行标识>.txt。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ---------- S 组：源码守卫 ----------
const RS = strip(readFileSync(join(ROOT, 'server', 'src', 'services', 'ReportService.ts'), 'utf8'));

ok('S-01 提示词构造收敛为单源 buildReportPrompt，两个入口都调它（不再各存拷贝）',
  /export function buildReportPrompt\(/.test(RS)
  && (RS.match(/const \{ system, user \} = buildReportPrompt\(/g) ?? []).length === 2);
ok('S-02 入口层零硬编码周报口吻（周报分析师只允许出现在 REPORT_PERSONA 的 week 行）',
  (() => {
    const personaBlock = (/const REPORT_PERSONA[\s\S]*?\n};/.exec(RS)?.[0] ?? '');
    const rest = RS.replace(personaBlock, '');
    return !/AI 周报分析师/.test(rest) && !/本周概况/.test(rest) && !/下周工作建议/.test(rest) && !/中文周报洞察/.test(rest);
  })());
ok('S-03 周期口吻表按 period 分派（日报/周报/月报各自角色与起止章节）',
  /day: \{ role: 'AI 日报分析师', overview: '今日概况与总体结论', advice: '明日工作建议' \}/.test(RS)
  && /week: \{ role: 'AI 周报分析师', overview: '本周概况与总体结论', advice: '下周工作建议' \}/.test(RS)
  && /month: \{ role: 'AI 月报分析师', overview: '本月概况与总体结论', advice: '下月工作建议' \}/.test(RS));
ok('S-04 月报数据窗口起点 = 本月 1 号 0 点（不再是今日 0 点）',
  /return \{ start: new Date\(start\.getFullYear\(\), start\.getMonth\(\), 1\), end: new Date\(start\.getFullYear\(\), start\.getMonth\(\) \+ 1, 1\) \};/.test(RS));

// ---------- W 组：前端可见文案跟随周期（同源串台的第二层：UI 写死「周报」） ----------
const RC = strip(readFileSync(join(ROOT, 'web', 'src', 'pages', 'ReportConsole.tsx'), 'utf8'));
const RP = strip(readFileSync(join(ROOT, 'web', 'src', 'pages', 'ReportPage.tsx'), 'utf8'));
// 去掉注释行后再判「写死文案」，避免注释里的说明文字造成假阴
const code = (t: string) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

ok('W-01 控制台：tab 名/状态/下载名由 aiReportLabel 派生（不再写死「AI 周报」）',
  /const aiReportLabel = `AI \$\{periodLabelOf\(period\) \?\? '周报'\}`;/.test(RC)
  && /\{aiReportLabel\}/.test(RC) && !/AI 周报/.test(code(RC)) && !/'AI周报'|"AI周报"/.test(code(RC)));
ok('W-02 报表页：AI 与离线面板/按钮文案随周期联动（无写死「AI 周报生成」「离线周报生成」）',
  /const periodLabel = PERIODS\.find\(\(p\) => p\.key === period\)\?\.label \?\? '周报';/.test(RP)
  && /const aiReportLabel = `AI \$\{periodLabel\}生成`;/.test(RP)
  && /const offlineReportLabel = `离线\$\{periodLabel\}生成`;/.test(RP)
  && !/AI 周报生成/.test(code(RP)) && !/离线周报生成/.test(code(RP)));
ok('W-03 报表页下载入口按周期命名（下载按钮/aria/title 均取 periodLabel）',
  /readonly periodLabel: string;/.test(RP) && /下载 AI \{periodLabel\}/.test(RP) && /periodLabel=\{PERIODS\.find/.test(RP));
ok('W-04 两处周期标签同源（都映射到 日报/周报/月报 三值，无第四种口径）',
  /const PERIOD_LABEL: Record<string, string> = \{ day: '日报', week: '周报', month: '月报' \};/.test(RC)
  && /\{ key: 'day', label: '日报' \}/.test(RP) && /\{ key: 'month', label: '月报' \}/.test(RP));

// ---------- U 组：真行为（生产库只读副本 → 临时 DATA_DIR） ----------
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
if (!existsSync(prodDb)) {
  ok('U-00 生产库副本可生成（本机无 MTask 生产库时跳过行为断言）', false, prodDb);
} else {
  const dataDir = mkdtempSync(join(tmpdir(), 't02157-gate-'));
  process.env.MTask_DATA_DIR = dataDir;
  copyFileSync(prodDb, join(dataDir, 'mtask.db'));
  try {
    const { closeDb } = await import('../server/src/db/connection.ts');
    const { gatherReportData, buildReportPrompt } = await import('../server/src/services/ReportService.ts');
    const skill = { name: 'xlsx', desc: '表格版式' };
    const now = new Date();
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const day = gatherReportData('day');
    ok('U-01 日报窗口 = [今天, 明天)（label=日报）', day.periodLabel === '日报' && day.startDate === ymd(now) && day.endDate === ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)), { s: day.startDate, e: day.endDate });

    const week = gatherReportData('week');
    const offset = (now.getDay() + 6) % 7;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const nextMon = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
    ok('U-02 周报窗口 = [本周一, 下周一)（label=周报）', week.periodLabel === '周报' && week.startDate === ymd(monday) && week.endDate === ymd(nextMon), { s: week.startDate, e: week.endDate, expectS: ymd(monday) });

    const month = gatherReportData('month');
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextFirst = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    ok('U-03 月报窗口 = [本月 1 号, 下月 1 号)（label=月报）——修复前是 [今天, 下月1号)',
      month.periodLabel === '月报' && month.startDate === ymd(first) && month.endDate === ymd(nextFirst),
      { s: month.startDate, e: month.endDate, expectS: ymd(first) });
    ok('U-04 月报窗口完整覆盖本月已发生的日子（15 号当天也应含 1~14 号）',
      month.startDate <= `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-14`, month.startDate);

    const pm = buildReportPrompt('month', month, skill);
    ok('U-05 月报提示词：月报角色 + 本月概况 + 下月建议，且无任何周报口吻',
      /AI 月报分析师/.test(pm.system) && /中文月报洞察/.test(pm.system) && /① 本月概况与总体结论/.test(pm.system) && /④ 下月工作建议/.test(pm.system)
      && !/周报|本周|下周/.test(pm.system), pm.system.slice(0, 120));
    const pd = buildReportPrompt('day', day, skill);
    ok('U-06 日报提示词：日报角色 + 今日概况 + 明日建议，无周/月口吻',
      /AI 日报分析师/.test(pd.system) && /中文日报洞察/.test(pd.system) && /① 今日概况与总体结论/.test(pd.system) && /④ 明日工作建议/.test(pd.system)
      && !/周报|月报|本周|下周|下月/.test(pd.system), pd.system.slice(0, 120));
    const pw = buildReportPrompt('week', week, skill);
    ok('U-07 周报提示词保持原口吻（回归不改坏既有默认周期）',
      /AI 周报分析师/.test(pw.system) && /① 本周概况与总体结论/.test(pw.system) && /④ 下周工作建议/.test(pw.system), pw.system.slice(0, 120));
    ok('U-08 三周期 user 段都带正确周期标签与起止（数据口径与口吻一致）',
      /【周期】月报 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/.test(pm.user) && /【周期】日报 /.test(pd.user) && /【周期】周报 /.test(pw.user));
  } finally {
    // 先关库再删目录：better-sqlite3 持句柄时 Windows 下 rmSync 会 EBUSY
    try { closeDb(); } catch { /* 未打开则忽略 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言结论 */ }
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02157-gate-results.txt', `T02157 报表周期口吻/窗口门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
