/**
 * T03221（PM-302 ①③）组件单源 lint。
 *
 * 拦的是「一处多貌」重新长回来的四条路径：
 *   U-1  页面里再写一份字段/按钮样式常量（应改为消费 ui/primitives.ts）
 *   U-2  在 ui/priority.ts 之外再定义一份优先级 → 颜色/色调映射
 *   U-3  引用主题表里根本不存在的令牌（--bg / --warning 就是本次查出的两个哑弹：
 *        前者让计划页与全文检索框的底色失效，后者让看板「高优先级」在暗色下硬吃 #d97706）
 *   U-4  自己写满屏遮罩色（inset:0 + 黑色半透明），应走 --overlay / OVERLAY_MASK
 *        —— 抽屉单源两件（SlideOver / mobile HalfSheet）已收编，限额 0；
 *        其余内联弹窗按存量债务挂账，只锁增长
 *
 * 存量债务只减不增：命中数按「文件 → 条数上限」挂账（DEBT），在限额内放行、超出即红。
 * 迁移掉一处请把数字调小；lint 会在 PASS 行提示实际值低于挂账值。
 *
 * 用法：
 *   node scripts/lint-ui-single-source.mjs                  # 全量扫 web/src，并输出债务真值表
 *   node scripts/lint-ui-single-source.mjs --paths f1 f2    # 只扫给定文件
 *   node scripts/lint-ui-single-source.mjs --debt-report    # 只打印各文件各规则的实测命中数（JSON）
 * 退出码：0 干净 / 1 有违规（点名 file:line [规则]）/ 2 用法或 IO 错误。
 * 豁免：ui/primitives.ts、ui/priority.ts 是单源本体；settings.tsx 是主题表本体（遮罩色在那儿定义）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'web', 'src');
/** rel 一律用正斜杠，豁免表必须同形 */
const EXEMPT = new Set([
  'web/src/ui/primitives.ts',
  'web/src/ui/priority.ts',
  'web/src/ui/Badge.tsx',
  'web/src/settings.tsx',
]);
/** U-4 抽屉单源两件（SlideOver / mobile HalfSheet）已收编为 OVERLAY_MASK，限额 0；其余满屏遮罩挂账 */

const STYLE_CONST_NAMES = ['fieldStyle', 'inputStyle', 'btnStyle', 'buttonStyle', 'chipStyle', 'pillStyle', 'FIELD', 'BTN', 'PLAIN_INPUT', 'CELL_INPUT', 'ICON_BTN', 'BATCH_SELECT', 'CHIP', 'badgeTones'];
const RULES = [
  { id: 'U-1', re: new RegExp(`const (${STYLE_CONST_NAMES.join('|')})(:\\s*[^=]+?)?\\s*=\\s*\\{`), hint: '改为消费 ui/primitives.ts 的单源常量（BTN_*/FIELD*/SELECT*/CHIP）' },
  { id: 'U-2', re: /\b(PRIO_COLOR|PRIO_TONE|PRIO_P_LABEL|PRIO_LABEL|PRIORITY_COLOR|PRIORITY_TONE)\s*(?::[^=]+?)?\s*[=:]\s*\{/, hint: '优先级 → 颜色/文案的唯一映射在 ui/priority.ts' },
  { id: 'U-3', re: /var\(--(bg|warning)(?![\w-])/, hint: '该令牌在主题表里不存在（见 settings.tsx）；底色用 --card-bg、警告用 --warn' },
  // 满屏遮罩（inset:0 的铺底 + 黑色半透明）必须走 --overlay；boxShadow 里的 rgba 不是遮罩，不误伤
  { id: 'U-4', re: /inset:\s*0/, andRe: /background:\s*'rgba\(0,\s*0,\s*0/, hint: '遮罩底走 --overlay 令牌（ui/primitives.ts 的 OVERLAY_MASK）' },
];

/**
 * 挂账的存量债务：file → rule → 允许命中数。只允许往下调。
 * U-1 是尚未收编的本地样式常量；U-3 是带 fallback 的 --warning 族，
 * 每处的当前实际颜色各不相同（#c80 / var(--danger) / var(--accent)），
 * 一次性补令牌会把三种观感同时改掉 —— 需要逐处裁定，另立单，不在本单里顺手改。
 */
const DEBT = {
  'web/src/pages/DbAdminTab.tsx': { 'U-1': 2 },
  'web/src/pages/SettingsPage.tsx': { 'U-1': 1 },
  'web/src/components/EstimatePanel.tsx': { 'U-3': 2 },
  'web/src/pages/AIToolsPage.tsx': { 'U-3': 2 },
  'web/src/pages/PrdGenPanel.tsx': { 'U-3': 2 },
  'web/src/pages/PrdPanel.tsx': { 'U-3': 3 },
  'web/src/pages/TestCaseGenPanel.tsx': { 'U-3': 2 },
  'web/src/pages/UsagePanel.tsx': { 'U-3': 1 },
  'web/src/ui/DirBrowser.tsx': { 'U-3': 1 },
  // 内联弹窗自己写的满屏遮罩（alpha .32~.45、zIndex 60~1100 各不相同）：
  // 收编会同时改 8 处的观感（暗色下遮罩统一变深），需要逐处裁定 → 另立单，本单只锁住增长。
  'web/src/mobile/MobileShell.tsx': { 'U-4': 1 },
  'web/src/pages/PlanPage.tsx': { 'U-4': 2 },
  'web/src/pages/ReportPage.tsx': { 'U-4': 1 },
  'web/src/pages/ReqMatrixPanel.tsx': { 'U-4': 1 },
  'web/src/pages/TasksPage.tsx': { 'U-4': 3 },
};

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2).filter((a) => a !== '--debt-report');
const scopedAt = args.indexOf('--paths');
const debtReport = process.argv.slice(2).includes('--debt-report');
if (scopedAt >= 0 && args.length === scopedAt + 1) {
  console.error('用法：node scripts/lint-ui-single-source.mjs [--paths <file...>] [--debt-report]');
  process.exit(2);
}
let files;
try {
  files = scopedAt >= 0 ? args.slice(scopedAt + 1).map((f) => resolve(ROOT, f)) : listFiles(SRC);
} catch (e) {
  console.error(`[ERROR] 读取失败：${e.message}`);
  process.exit(2);
}

const relOf = (f) => f.slice(ROOT.length + 1).split(sep).join('/');
const hits = [];
const actual = {}; // rel → rule → count
let scanned = 0;
for (const f of files) {
  const rel = relOf(f);
  if (EXEMPT.has(rel)) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue; // 给定的路径不在仓里：忽略而不是崩
  }
  scanned += 1;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const rule of RULES) {
      if (!rule.re.test(lines[i])) continue;
      if (rule.andRe && !rule.andRe.test(lines[i])) continue;
      const byRule = (actual[rel] ??= {});
      byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
      const cap = DEBT[rel]?.[rule.id] ?? 0;
      if (byRule[rule.id] > cap) {
        hits.push({ file: rel, line: i + 1, rule: rule.id, hint: rule.hint, text: lines[i].trim().slice(0, 110) });
      }
    }
  }
}

if (debtReport) {
  console.log(JSON.stringify(actual, null, 2));
  process.exit(0);
}

const declaredTotal = Object.values(DEBT).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
const actualTotal = Object.values(actual).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);

if (hits.length === 0) {
  if (scopedAt >= 0) {
    // 只扫给定文件时不报债务账：给定面里多半全是单源本体（豁免），报「实测 0 处」会被读成账已清零
    console.log(`[PASS] 组件单源 lint（scoped：给定 ${files.length} 个文件，实际入扫 ${scanned} 个）— 无新增违规；债务账以全量跑为准`);
    process.exit(0);
  }
  const shrink = declaredTotal - actualTotal;
  console.log(`[PASS] 组件单源 lint：${scanned} 个文件 — 无新增违规（存量债务挂账 ${declaredTotal} 处 / 实测 ${actualTotal} 处${shrink > 0 ? `，已减少 ${shrink} 处，请把 DEBT 表调小` : ''}）`);
  process.exit(0);
}
console.log(`[FAIL] 组件单源 lint：${hits.length} 处违规（超出挂账限额）`);
for (const h of hits) console.log(`  ${h.file}:${h.line} [${h.rule}] ${h.text}\n        ↳ ${h.hint}`);
process.exit(1);
