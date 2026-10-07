#!/usr/bin/env node
/**
 * T01071 后续：i18n 抽取覆盖率检查（CI 门禁 + 进度报告）。
 *
 * 背景：验收口径是「95% 覆盖率」，但没有可执行的度量就等于没有口径——
 * 全站 2 万行前端、30+ 页面，靠人眼看永远不知道还差多少。本脚本给出可复现的定义：
 *
 *   **抽取覆盖率** = 走 t() 的中文串数量 / 页面里全部中文串数量（含 JSX 文本与字符串字面量）
 *   **译词命中率** = t() 用到的 key 中，在英文包（i18n.ts 骨架 + 术语表）里有译文的比例
 *   **术语一致性** = 使用了术语表登记过的异形写法（如「执行人」而非「负责人」）的条数
 *
 * 扫描做法：手写一个轻量词法器（不做完整 AST），把注释与字符串字面量从源码里「抹掉」，
 * 剩下的中文串即 JSX 文本；字符串字面量单独收集，并判断它是否落在 `t(...)` 的实参里。
 * 之所以不上 AST：CI 上多装一个 parser 依赖不划算，而本度量只需近似稳定即可比大小。
 *
 * 用法：
 *   node scripts/i18n-coverage.mjs                 # 门禁模式：低于 --threshold（默认 0.95）退出码 1
 *   node scripts/i18n-coverage.mjs --threshold=0    # 报告模式（npm run i18n:report）
 *   node scripts/i18n-coverage.mjs --json           # 机器可读输出（给后续看板用）
 *   node scripts/i18n-coverage.mjs --top=30         # 只列待抽取条数最多的 30 个文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = path.join(ROOT, 'web', 'src');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const THRESHOLD = Number(argOf('threshold', '0.95'));
const AS_JSON = args.includes('--json');
const TOP_N = Number(argOf('top', '15'));

const CJK = /[㐀-鿿豈-﫿]/;

/** i18n 基础设施自身不算页面（用正斜杠，避开 Windows 的 path.sep） */
const SELF_FILES = new Set(['i18n.ts', 'i18n/terms.ts']);

/** 文件 → 菜单（按菜单逐页迁移的进度视图） */
const MENU_OF = [
  [/^(?:web\/src\/)?pages\/(TasksPage|ArchivePage|HistoryPage)\.tsx$/, '任务'],
  [/^(?:web\/src\/)?pages\/(PlanPage|ReqPage|ReqMatrixPanel|MatrixTable)\.tsx$/, '计划/需求'],
  [/^(?:web\/src\/)?pages\/(PrdPanel|PrdImportPanel|PrdGenPanel)\.tsx$/, 'PRD'],
  [/^(?:web\/src\/)?pages\/(TestCase\w*)\.tsx$/, '用例'],
  [/^(?:web\/src\/)?pages\/(ReportPage|ReportConsole|PromptsPage|AIToolsPage|UsagePanel)\.tsx$/, '报告/AI'],
  [/^(?:web\/src\/)?pages\/(SettingsPage|RecurringTokensTabs|DbAdminTab|TunnelPanel|SupervisorPanel|ExecSessionsPage)\.tsx$/, '设置'],
  [/^(?:web\/src\/)?pages\/(QueuePage|LogsPage)\.tsx$/, '队列/日志'],
  [/^(?:web\/src\/)?pages\/(HelpTab|PageGuide|ProjectGuide|GuideDemos|guides)\.tsx$/, '帮助/引导'],
  [/^(?:web\/src\/)?pages\/(DashboardPage|CommandPalette)\.tsx$/, '总览'],
];

function menuOf(rel) {
  for (const [re, name] of MENU_OF) if (re.test(rel)) return name;
  return '其它';
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 轻量词法扫描：
 *  - 收集所有字符串字面量（含模板串）及其起始下标；
 *  - 同时产出一份「抹掉注释与字符串」的副本，剩下的中文串即 JSX 文本。
 */
function scan(src) {
  const strings = [];
  let masked = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { masked += ' '; i += 1; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        masked += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      masked += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = i;
      i += 1;
      masked += ' ';
      let buf = '';
      while (i < n) {
        if (src[i] === '\\') { buf += src[i] + (src[i + 1] ?? ''); masked += '  '; i += 2; continue; }
        if (src[i] === quote) break;
        buf += src[i];
        masked += ' ';
        i += 1;
      }
      masked += ' ';
      i += 1;
      strings.push({ start, end: i, text: buf });
      continue;
    }
    masked += c;
    i += 1;
  }
  return { strings, masked };
}

/** 语言内名（endonym）：语言切换按钮上的「EN / 中」，本来就不翻 */
const ENDONYMS = new Set(['中', 'EN', '中文', 'English']);

/** 找出所有 t(...) / term(...) 调用的实参区间（按括号配对，支持嵌套） */
function tCallArgs(src) {
  const spans = [];
  const re = /\b(?:t|term)\(\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    const from = j;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      j += 1;
    }
    if (depth === 0) spans.push({ from, to: j - 1 });
  }
  return spans;
}

/** registerDict('en', { ... }) 区间：里面的中文是**词条本身**，不该算作「未抽取的页面文案」 */
function dictBlockSpans(src) {
  const spans = [];
  const re = /registerDict\('en',\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    const from = j;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      j += 1;
    }
    if (depth === 0) spans.push({ from, to: j });
  }
  return spans;
}

/** 从「键: 值」文本抓译文（允许值换行到下一行——长句译文常另起一行） */
function collectPairs(text, dict) {
  const re = /'((?:[^'\\\n]|\\.)*)'\s*:\s*\n?\s*'((?:[^'\\\n]|\\.)*)'/g;
  let m;
  while ((m = re.exec(text)) !== null) dict.set(m[1], m[2]);
}

/** 英文包 = i18n.ts 骨架 + 术语表 + 各页面 registerDict（CI 不引依赖，故用正则解析） */
function loadEnglishDict(filesToScan) {
  const dict = new Map();
  const src = fs.readFileSync(path.join(WEB_SRC, 'i18n.ts'), 'utf8');
  const enBlock = src.match(/en:\s*\{([\s\S]*?)\n  \}/);
  collectPairs(enBlock ? enBlock[1] : src, dict);

  const terms = fs.readFileSync(path.join(WEB_SRC, 'i18n', 'terms.ts'), 'utf8');
  collectPairs(terms, dict);
  // 限定在同一行内找 aliases：否则没有 aliases 的条目会「顺走」下一个条目的异形词
  const tre = /zh:\s*'([^'\n]*)'\s*,\s*en:\s*'([^'\n]*)'(?:[^\n}]*aliases:\s*\[([^\]]*)\])?/g;
  const aliases = new Map();
  let m;
  while ((m = tre.exec(terms)) !== null) {
    dict.set(m[1], m[2]); // 术语表的 zh → en
    if (m[3]) for (const a of m[3].match(/'([^'\n]*)'/g) ?? []) aliases.set(a.slice(1, -1), m[1]);
  }
  for (const f of filesToScan) {
    const body = fs.readFileSync(f, 'utf8');
    for (const b of body.matchAll(/registerDict\('en',\s*\{([\s\S]*?)\n\}\)/g)) collectPairs(b[1], dict);
  }
  return { dict, aliases };
}

const allFiles = walk(WEB_SRC)
  .map((p) => ({ abs: p, rel: path.relative(ROOT, p).split(path.sep).join('/') }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

const { dict: EN, aliases: ALIAS } = loadEnglishDict(allFiles.map((f) => f.abs));

const files = allFiles.filter((f) => !SELF_FILES.has(f.rel.replace(/^web\/src\//, '')));

const perFile = [];
const missingKeys = new Map(); // 走 t() 但英文包没译 → 译文缺口
const aliasHits = new Map(); // 异形写法 → 出现次数

for (const f of files) {
  const src = fs.readFileSync(f.abs, 'utf8');
  if (!CJK.test(src)) continue;
  const { strings, masked } = scan(src);
  const spans = tCallArgs(src);
  const dictSpans = dictBlockSpans(src);
  const inTCall = (start) => spans.some((s) => start >= s.from && start < s.to);
  const inDictBlock = (start) => dictSpans.some((s) => start >= s.from && start < s.to);

  let wrapped = 0;
  const unwrapped = [];

  for (const s of strings) {
    if (!CJK.test(s.text)) continue;
    if (ENDONYMS.has(s.text.trim())) continue; // 语言内名（EN/中）本就不翻译
    if (inDictBlock(s.start)) continue;
    // 模板串里内插了 t()（如 `「${x}」${t('已改为 cron')}「${y}」`）也算已抽取：
    // 整句拆成「固定片段 + 插值」是 i18n 的标准做法，剩下的中文（书名号/冒号）是排版符号不是文案。
    const i18nTemplate = s.text.includes('${') && s.text.includes('t(');
    if (i18nTemplate || inTCall(s.start)) {
      // 只有第一个实参算「已抽取的 key」，其余（fallback / 插值参数）不计入分母
      const first = spans.find((sp) => s.start >= sp.from && s.start < sp.to);
      const before = first ? strings.filter((o) => o.start >= first.from && o.start < s.start) : [];
      if (i18nTemplate || before.length === 0) {
        wrapped += 1;
        if (!i18nTemplate && !EN.has(s.text)) missingKeys.set(s.text, (missingKeys.get(s.text) ?? 0) + 1);
      }
    } else {
      unwrapped.push(s.text);
    }
  }
  // JSX 文本：抹掉注释/字符串后剩下的中文串
  for (const run of masked.match(/[㐀-鿿豈-﫿][㐀-鿿豈-﫿\w·—…、，。？！：（）%/ ]*/g) ?? []) {
    const txt = run.trim();
    if (txt) unwrapped.push(txt);
  }

  const total = wrapped + unwrapped.length;
  if (total === 0) continue;
  for (const u of unwrapped) {
    const canon = ALIAS.get(u);
    if (canon) aliasHits.set(`${u} → ${canon}`, (aliasHits.get(`${u} → ${canon}`) ?? 0) + 1);
  }
  perFile.push({ rel: f.rel, menu: menuOf(f.rel), wrapped, missing: unwrapped.length, total, cov: wrapped / total, todo: unwrapped.slice(0, 20) });
}

const sum = (arr, k) => arr.reduce((a, b) => a + b[k], 0);
const totalWrapped = sum(perFile, 'wrapped');
const totalMissing = sum(perFile, 'missing');
const total = totalWrapped + totalMissing;
const coverage = total === 0 ? 1 : totalWrapped / total;

const byMenu = new Map();
for (const f of perFile) {
  const cur = byMenu.get(f.menu) ?? { menu: f.menu, wrapped: 0, missing: 0, files: 0 };
  cur.wrapped += f.wrapped;
  cur.missing += f.missing;
  cur.files += 1;
  byMenu.set(f.menu, cur);
}

const untranslated = [...missingKeys.entries()].sort((a, b) => b[1] - a[1]);
const worst = [...perFile].sort((a, b) => b.missing - a.missing).slice(0, TOP_N);

if (AS_JSON) {
  console.log(JSON.stringify({
    coverage: Number(coverage.toFixed(4)),
    total, wrapped: totalWrapped, missing: totalMissing,
    threshold: THRESHOLD,
    byMenu: [...byMenu.values()],
    files: perFile,
    untranslated: untranslated.slice(0, 50),
    aliasHits: [...aliasHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30),
  }, null, 2));
  process.exit(THRESHOLD > 0 && coverage < THRESHOLD ? 1 : 0);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log('i18n 抽取覆盖率报告（中文串 → t() 的比例）');
console.log('='.repeat(64));
console.log(`总计：${pct(coverage)}（${totalWrapped}/${total}）　门禁阈值：${pct(THRESHOLD)}`);
console.log('');
console.log('按菜单：');
for (const m of [...byMenu.values()].sort((a, b) => (a.wrapped / Math.max(1, a.wrapped + a.missing)) - (b.wrapped / Math.max(1, b.wrapped + b.missing)))) {
  const t2 = m.wrapped + m.missing;
  console.log(`  ${m.menu.padEnd(10)} ${pct(t2 ? m.wrapped / t2 : 1).padStart(7)}  ${String(m.wrapped).padStart(5)}/${String(t2).padEnd(6)} ${m.files} 个文件`);
}
console.log('');
console.log(`待抽取最多（前 ${TOP_N}）：`);
for (const w of worst) console.log(`  ${String(w.missing).padStart(5)}  ${w.rel}`);
if (untranslated.length > 0) {
  console.log('');
  console.log(`已走 t() 但英文包缺译文（前 10）：`);
  for (const [k, c] of untranslated.slice(0, 10)) console.log(`  ${String(c).padStart(3)}×  ${k}`);
}
if (aliasHits.size > 0) {
  console.log('');
  console.log('术语不一致（应收敛到规范词，前 10）：');
  for (const [k, c] of [...aliasHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(c).padStart(3)}×  ${k}`);
}
console.log('');

const pass = THRESHOLD <= 0 || coverage >= THRESHOLD;
console.log(pass ? `PASS：覆盖率 ${pct(coverage)} ≥ 阈值 ${pct(THRESHOLD)}` : `FAIL：覆盖率 ${pct(coverage)} < 阈值 ${pct(THRESHOLD)}（还差 ${totalMissing} 条待抽取）`);
process.exit(pass ? 0 : 1);
