/**
 * T02205 源码守卫门自证门（判据的判据）。
 *
 * 背景：仓库里有一批门用 `readFileSync` 把前端/服务端源码当字符串做守卫断言，锚的是 **字面写法**。
 * 重构一改写法（T02202 实例：`disabled={…blocked…}` → `disabled={!canGenerate}`），正则恒假，
 * 而门里其余几十条照常 PASS、FAIL 行只给一句「实测：…」——读的人分不清是**功能坏了**还是**判据坏了**。
 *
 * 本门做三件事（全部静态求值，不启服务、不碰库，跑得快且与 ABI 无关）：
 *  1. 自证：把每个源码守卫门的锚点（正则/字面串）抽出来，对**真实文件**求值命中数；
 *     命中 0 处的正向锚点＝判据本身失效，逐条点名（门号＋行号＋正则＋目标文件），不再让 `&&` 静默短路。
 *  2. 反向探针：把源码写法在内存里改坏（不碰磁盘），确认锚点命中数塌成 0、且点名逻辑确实咬住——
 *     证明「0 命中即点名」这条判据自己不是空转。
 *  3. 棘轮：恒假清单必须 ⊆ 已登记清单（W-04），且已登记项逐条给出裁定（已修／待修＋归属门），
 *     新增失配会在 CI 里直接 FAIL，而不是再等一轮没人发现。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02205-guard-selfcheck.mts
 * 产物：.workbuddy/t02205-gate-results-<运行标识>.txt
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_DIR = join(ROOT, 'scripts');
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(OUT_DIR, { recursive: true });

const lines: string[] = [];
let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass += 1; lines.push(`[PASS] ${label}`); }
  else { fail += 1; lines.push(`[FAIL] ${label}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`); }
};

const esc = (s: string): string => s.replace(/[$()*+.?[\]\\^{|}]/g, '\\$&');
const BIND_HEAD = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*readFileSync\s*\(/g;

/** 取 readFileSync( … ) 的第一个实参（内层括号/引号按平衡扫描） */
function balanced(s: string, open: number): string | null {
  let depth = 0;
  let i = open;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i += 1; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return s.slice(open + 1, i); }
    i += 1;
  }
  return null;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[i + 1] ?? ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') depth += 1;
    if (c === ')' || c === ']') depth -= 1;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 从 s[from]（必须是 '/'）起读一个正则字面量，返回体/旗标/结束位置；读不出返回 null */
function literal(s: string, from: number): { src: string; flags: string; end: number } | null {
  if (s[from] !== '/') return null;
  let i = from + 1;
  let out = '';
  let inClass = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { out += c + (s[i + 1] ?? ''); i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    else if (c === '\n') return null;
    out += c;
    i += 1;
  }
  if (s[i] !== '/') return null;
  i += 1;
  let flags = '';
  while (i < s.length && /[dgimsuyv]/.test(s[i])) { flags += s[i]; i += 1; }
  return { src: out, flags, end: i };
}

/** 行内「字符串字面量 / 行注释」覆盖标记：斜杠落在这些区段里就不可能是正则字面量的起点 */
function stringMask(line: string): boolean[] {
  const mask = new Array<boolean>(line.length).fill(false);
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      mask[i] = true;
      if (c === '\\') { if (i + 1 < line.length) { mask[i + 1] = true; i += 1; } continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; mask[i] = true; continue; }
    if (c === '/' && line[i + 1] === '/') { for (let k = i; k < line.length; k += 1) mask[k] = true; break; }
  }
  return mask;
}

/** 正则字面量只能出现在「期望一个值」的位置；出现在标识符/右括号之后那是除法 */
const RE_ALLOWED_BEFORE = new Set(['(', '=', '!', '&', '|', '?', ':', ',', ';', '{', '[', '<', '>', '+', '-', '*', '%', '~', '^']);
function canStartRegex(line: string, p: number): boolean {
  let i = p - 1;
  while (i >= 0 && /\s/.test(line[i])) i -= 1;
  if (i < 0) return true;
  return RE_ALLOWED_BEFORE.has(line[i]);
}

type Anchor = {
  gate: string;
  line: number;
  file: string;
  kind: 're' | 'str';
  body: string;
  flags: string;
  anchor: string;
  neg: boolean;
  hits: number;
  /** 门里那一行的原文：点名恒假时必须一起打出来，读的人才能当场判断是功能坏了还是判据坏了 */
  lineText: string;
};

/**
 * 源码文件索引（懒建）：门里的路径常是 `join(WEB, 'App.tsx')` 这类**变量打头**的拼接，
 * 静态只能拿到末段文件名。按 basename 在源码树里唯一命中才认，认不出标「不可静态判定」而不是硬猜——
 * 宁可少审一条锚点，也不要把审错了当成审过了。
 */
let srcIndex: Map<string, string[]> | null = null;
function buildIndex(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.workbuddy', 'coverage', 'vendor', 'out', 'release']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (/\.(ts|tsx|js|jsx|md|css|json)$/.test(e.name)) {
        const rel = abs.slice(ROOT.length + 1).replace(/\\/g, '/');
        out.set(e.name, [...(out.get(e.name) ?? []), rel]);
      }
    }
  };
  for (const top of ['server', 'web', 'scripts', 'docs', 'electron', 'src']) {
    if (existsSync(join(ROOT, top))) walk(join(ROOT, top), 0);
  }
  return out;
}
const resolveFile = (rel: string): string | null => {
  if (existsSync(join(ROOT, rel))) return rel;
  const base = rel.split('/').pop() ?? rel;
  const cands = (srcIndex ??= buildIndex()).get(base) ?? [];
  const tail = cands.filter((c) => c.endsWith(rel));
  const pool = tail.length ? tail : cands;
  return pool.length === 1 ? pool[0] : null;
};

const contentCache = new Map<string, string | null>();
const contentOf = (rel: string): string | null => {
  if (!contentCache.has(rel)) {
    const target = resolveFile(rel);
    if (target == null) contentCache.set(rel, null);
    else {
      try { contentCache.set(rel, readFileSync(join(ROOT, target), 'utf8')); }
      catch { contentCache.set(rel, null); }
    }
  }
  return contentCache.get(rel) ?? null;
};
const resolvable = (rel: string): boolean => resolveFile(rel) != null;

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globalFlags = (flags: string): string => [...new Set(`${flags.replace('g', '')}g`)].join('');

/** 在给定文本里数锚点命中数（求值口径全门唯一，W-04 与反向探针共用） */
function hitsIn(content: string, a: Pick<Anchor, 'kind' | 'body' | 'flags'>): number {
  if (a.kind === 'str') return content.split(a.body).length - 1;
  try {
    return [...content.matchAll(new RegExp(a.body, globalFlags(a.flags)))].length;
  } catch {
    return -3;
  }
}

function countHits(a: Pick<Anchor, 'file' | 'kind' | 'body' | 'flags'>): number {
  if (!resolvable(a.file)) return -4;
  const content = contentOf(a.file);
  if (content == null) return -2;
  return hitsIn(content, a);
}

/** 恒假判据本体：正向锚点 + 命中 0 处 */
const zeroHitsOf = (list: Anchor[]): Anchor[] => list.filter((x) => !x.neg && x.hits === 0);

/** 抽取一个门文件里的全部源码守卫锚点 */
function collectAnchors(gateName: string, text: string): Anchor[] {
  const out: Anchor[] = [];
  const seen = new Set<string>();
  const binds = new Map<string, string>();
  for (const m of text.matchAll(BIND_HEAD)) {
    const raw = balanced(text, (m.index ?? 0) + m[0].length - 1);
    if (raw == null) continue;
    const args = splitTopLevel(raw);
    if (!(args[1] ?? '').includes('utf8')) continue;
    const parts = [...(args[0] ?? '').matchAll(/['"`]([^'"`]+)['"`]/g)].map((p) => p[1]);
    if (!parts.length) continue;
    const rel = parts.join('/').replace(/\\/g, '/');
    if (!rel || rel.includes('$')) continue;
    binds.set(m[1], rel);
  }
  if (!binds.size) return out;
  text.split('\n').forEach((line, idx) => {
    const mask = stringMask(line);
    for (const [v, rel] of binds) {
      const vRe = new RegExp(`\\b${esc(v)}\\b`);
      if (!vRe.test(line)) continue;
      const add = (a: Omit<Anchor, 'gate' | 'line' | 'hits' | 'lineText'>) => {
        if (!a.body) return;
        const key = `${idx + 1}:${a.anchor}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ gate: gateName, line: idx + 1, ...a, hits: countHits(a), lineText: line.trim().slice(0, 220) });
      };
      let p = line.indexOf('/');
      while (p >= 0) {
        const lit = mask[p] || !canStartRegex(line, p) ? null : literal(line, p);
        if (lit) {
          const tail = line.slice(lit.end, lit.end + 40);
          if (vRe.test(tail)) {
            // 反向锚点三种写法都要认：`!/re/.test(V)` 前缀非、`/re/.test(V) === false` 后缀非、
            // `V.match(/re/) … length === 0` 计数为零。认漏一种就会把「断言某写法已消失」误判成「判据恒假」。
            const head = line.slice(0, p).trimEnd();
            const isEvidence = /[\w$]\s*:\s*$/.test(head) && !head.endsWith('?:');
            const neg = head.endsWith('!')
              || /^\s*(===|==)\s*false\b/.test(tail.replace(/^\s*\.\s*test\(\s*[^)]*\)/, ''));
            if (!isEvidence) {
              add({
                file: rel, kind: 're', body: lit.src, flags: lit.flags, anchor: `/${lit.src}/${lit.flags}`, neg,
              });
            }
          }
          p = line.indexOf('/', lit.end);
          continue;
        }
        p = line.indexOf('/', p + 1);
      }
      // V.match(/re/) 与 V.includes('str')
      for (const m of line.matchAll(new RegExp(`${esc(v)}\\s*\\.\\s*match\\(\\s*/`, 'g'))) {
        const lit = literal(line, (m.index ?? 0) + m[0].length - 1);
        if (!lit) continue;
        const before = line.slice(0, m.index ?? 0);
        const after = line.slice((m.index ?? 0) + m[0].length + lit.src.length + lit.flags.length + 2, (m.index ?? 0) + m[0].length + 120);
        const negCount = /length\s*(===|==)\s*0\b|\)\s*\.\s*length\s*===\s*0/.test(after);
        if (!/[\w$]\s*:\s*$/.test(before.trimEnd())) {
          add({
            file: rel, kind: 're', body: lit.src, flags: lit.flags, anchor: `/${lit.src}/${lit.flags}`,
            neg: /!\s*$/.test(before) || negCount,
          });
        }
      }
      // V.includes('str')——引号字符类用 \x27\x22\x60 写，避免反引号把模板串提前终止
      for (const m of line.matchAll(new RegExp(`${esc(v)}\\s*\\.\\s*includes\\(\\s*([\\x27\\x22\\x60])([^\\x27\\x22\\x60]*)\\1`, 'g'))) {
        add({ file: rel, kind: 'str', body: m[3], flags: '', anchor: JSON.stringify(m[3]), neg: false });
      }
    }
  });
  return out;
}

// —— 已登记的恒假锚点（棘轮基线）：key = `门:行号`，value = 裁定
// 'fixed' 表示本单已把该锚点改成锚语义/锚导出符号（行号会随改动变，故按锚点正文再比一次）
const REGISTERED: Record<string, string> = {};

const gateFiles = readdirSync(GATE_DIR).filter((n) => n.startsWith('verify-') && n.endsWith('.mts'));
const all: Anchor[] = [];
const guardGates: string[] = [];
for (const g of gateFiles) {
  const text = readFileSync(join(GATE_DIR, g), 'utf8');
  if (!text.includes('readFileSync')) continue;
  const a = collectAnchors(g, text);
  if (a.length) { guardGates.push(g); all.push(...a); }
}

const unresolvable = all.filter((a) => a.hits === -4);
const anchorCountOf = (g: string): number => all.filter((a) => a.gate === g).length;
const control = ['verify-t02096-kickoff-outline.mts', 'verify-t02111-kickoff-acceptance.mts', 'verify-t02198-kickoff-flow.mts'];
ok(`W-01 审计自身在位（实测枚举 ${guardGates.length} 门 / ${all.length} 锚点，其中目标路径不可静态判定 ${unresolvable.length} 条；控制组抽不出锚点＝审计器失配，不许当成全绿）`,
  guardGates.length >= 20 && all.length >= 150 && control.every((g) => anchorCountOf(g) >= 3)
  && unresolvable.length <= all.length * 0.4,
  { 门数: guardGates.length, 锚点数: all.length, 控制组: control.map((g) => `${g}=${anchorCountOf(g)}`), 路径不可判定: unresolvable.length });

const unreadable = all.filter((a) => a.hits === -2);
ok('W-02 锚点目标文件全部读得到（目标文件不存在＝守卫早已空转）', unreadable.length === 0,
  { 缺失: [...new Set(unreadable.map((a) => a.file))].slice(0, 8) });

const noise = all.filter((a) => a.hits === -3);
ok('W-03 抽出的正则全部可构造（不可构造＝抽取器把除法/JSX 误当字面量，属抽取噪声需收敛）',
  noise.length === 0, { 噪声: noise.slice(0, 5).map((a) => `${a.gate}:${a.line} ${a.anchor}`) });

const aliveByLine = new Map<string, boolean>();
for (const a of all) {
  if (a.neg || a.hits <= 0) continue;
  aliveByLine.set(`${a.gate}:${a.line}`, true);
}
// 同一行里 `A || B` 形式的两条正向锚点是**备择写法**（重构后写法二选一即可），
// 单条 0 命中不算失配——只有整行都没命中才是判据坏了。
const zeroHits = zeroHitsOf(all).filter((a) => !(/ \|\| /.test(a.lineText) && aliveByLine.get(`${a.gate}:${a.line}`)));
const regKeys = new Set(Object.keys(REGISTERED));
const fresh = zeroHits.filter((a) => !regKeys.has(`${a.gate}:${a.line}`));
ok(`W-04 棘轮：没有「未登记的恒假锚点」——正向锚点命中 0 处即点名「判据本身没命中（可能已被重构换掉写法）」，不再 && 静默短路（实测未登记 ${fresh.length} 条／恒假共 ${zeroHits.length} 条）`,
  fresh.length === 0,
  { 未登记清单: fresh.map((a) => `${a.gate}:${a.line} [${a.file}] ${a.anchor} ⟵ 门内原文：${a.lineText}`).slice(0, 40), 已登记: regKeys.size });
const hollow = [...regKeys].filter((k) => !REGISTERED[k]?.trim());
const negTotal = all.filter((a) => a.neg).length;
ok('W-05 已登记恒假项逐条带裁定文本（空壳登记等于把失配重新变回静默；清单为空是本单追求的状态）',
  hollow.length === 0, { 空壳: hollow.slice(0, 5), 登记数: regKeys.size });
// 反向锚点（断言「某种写法已经不存在」，如 builder 里零 hex 字面量、`.test(B) === false`）的识别
// 是这套审计的命门：一旦识别失效，它们会整批被误报成恒假，或被当成正向锚点反过来掩盖真失配。
ok(`W-06 反向锚点识别在位（实测 ${negTotal} 条；识别失效时这个数会塌到 0，整批误报）`,
  negTotal >= 5, { 反向锚点数: negTotal, 正向锚点数: all.length - negTotal });

// —— 反向探针：把锚点在**内存副本**里改坏（不碰磁盘），确认「0 命中即点名」这条判据自己咬得住
// 每个源码守卫门取若干条正向锚点做探针（不是抽样一两条了事：探针覆盖到的门数本身要能断言）
const probeTargets: Anchor[] = [];
for (const g of guardGates) {
  const alive = all.filter((a) => a.gate === g && !a.neg && a.hits > 0);
  probeTargets.push(...alive.slice(0, 3));
}
const mutatedMiss: string[] = [];
const stillAlive: string[] = [];
for (const a of probeTargets) {
  const content = contentOf(a.file) ?? '';
  const globalBody = a.kind === 'str' ? escRe(a.body) : a.body;
  const mutated = content.replace(new RegExp(globalBody, globalFlags(a.flags)), '/* T02205 反向探针：写法已改坏 */');
  const hitsAfter = hitsIn(mutated, a);
  if (hitsAfter > 0) stillAlive.push(`${a.gate}:${a.line} ${a.anchor} 残留 ${hitsAfter}`);
  // 点名逻辑与 W-04 同一条：命中 0 处 → 进恒假清单
  const named = zeroHitsOf([{ ...a, hits: hitsAfter }]).length === 1;
  if (hitsAfter === 0 && !named) mutatedMiss.push(`${a.gate}:${a.line} ${a.anchor}`);
}
ok(`W-07 反向探针前提（实测 ${probeTargets.length} 条探针 / 覆盖 ${new Set(probeTargets.map((a) => a.gate)).size} 门）：改坏写法后锚点命中数归 0（若仍有残留＝抽取器求值口径与门里不一致）`,
  stillAlive.length === 0, { 残留: stillAlive.slice(0, 6), 探针数: probeTargets.length });
ok('W-08 反向探针点名：命中 0 处的锚点必然被恒假清单收录（与 W-04 复用同一判据，不是另写一遍）',
  probeTargets.length >= 40 && new Set(probeTargets.map((a) => a.gate)).size >= 20 && mutatedMiss.length === 0,
  { 漏点名: mutatedMiss, 探针数: probeTargets.length, 覆盖门数: new Set(probeTargets.map((a) => a.gate)).size });

writeGateResults(OUT_DIR, 't02205-gate-results.txt', [`T02205 源码守卫自证门：PASS=${pass} FAIL=${fail}`, ...lines].join('\n'));
console.log(`T02205 源码守卫自证门：PASS=${pass} FAIL=${fail}`);
for (const l of lines) console.log(l);
process.exit(fail > 0 ? 1 : 0);
