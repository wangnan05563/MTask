/**
 * T02205 源码守卫门自证门（判据的判据）。
 *
 * 背景：仓库里有一批门用 `readFileSync` 把前端/服务端源码当字符串做守卫断言，锚的是 **字面写法**。
 * 重构一改写法（T02202 实例：`disabled={…blocked…}` → `disabled={!canGenerate}`），正则恒假，
 * 而门里其余几十条照常 PASS、FAIL 行只给一句「实测：…」——读的人分不清是**功能坏了**还是**判据坏了**。
 *
 * 本门做四件事（全部对 **HEAD 已提交树** 求值，不启服务、不碰库，与 ABI 无关；
 *  批㉝ 起第 4 件是全量加载面普查，本门由「秒级」变为**分钟级**，实测耗时写进 L-04 标签与 census 行）：
 *  1. 自证：把每个源码守卫门的锚点（正则/字面串）抽出来，对**HEAD 已提交树里的产品文件**求值命中数；
 *     命中 0 处的正向锚点＝判据本身失效，逐条点名（门号＋行号＋正则＋目标文件），不再让 `&&` 静默短路。
 *  2. 反向探针：把 HEAD 源码写法在内存里改坏（不碰磁盘），确认锚点命中数塌成 0、且点名逻辑确实咬住——
 *     证明「0 命中即点名」这条判据自己不是空转。
 *  3. 棘轮：恒假清单必须 ⊆ 已登记清单（W-04），且已登记项逐条给出裁定（已修／待修＋归属门），
 *     新增失配会在 CI 里直接 FAIL，而不是再读一遍。
 *  4. 批㉝（T02770）加载面自检（L 组）：AST 级「用了但解析不到的标识符」——`node --check` 只查语法，
 *     查不出这类错，而它正是「门跑到 `finally` 才抛 ReferenceError、PASS/FAIL 汇总整行丢失」的成因。
 *     夹具双向 12 例（该抓 6／不该抓 6，含母单点名的三类 grep 假阳）+ 真实门体变异 + 语法层分离 + 全量普查。
 *
 * 判据口径（服从 T02293 · `docs/验收门判据规约.md` 本轮改判）：
 *  - **被测的是 HEAD 那份产品代码，不是工作树**（反模式 11）：本工作区常年有并发会话在改 `server/`、`web/`，
 *    工作树里的 `WorkspaceService.ts`/`estimateCopy.ts` 等常比 HEAD 少一大截，直接读工作树会把 HEAD
 *    里早已存在的功能判成「锚点恒假」。门内所有取数一律 `git show HEAD:<path>` + `git ls-tree HEAD`；
 *    门文件本体也从 HEAD 枚举读取，使自证结论与工作树 WIP 无关、可在任意时点稳定复跑。
 *  - 审计器本身不读源码当判据：它的判据是「锚点命中计数」这类结构事实 + 反向探针的「破坏后归 0」行为，
 *    空表比空表/恒真没有牙齿的部分由 W-01（分母腿：门数/锚点数下限）、W-06（反向锚点数下限）、
 *    W-08（探针数与覆盖门数下限）钉住，任一塌到 0 即转红。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02205-guard-selfcheck.mts
 * 产物：.workbuddy/t02205-gate-results-<运行标识>.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';
import { checkSource, listHeadGateFiles } from './lib/undefined-identifier-check.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
mkdirSync(OUT_DIR, { recursive: true });

// —— 取数一律走 HEAD 已提交树（反模式 11）：工作树可能躺着并发会话留下的过期产品文件 ——
const gitCache = new Map<string, string | null>();
function headText(rel: string): string | null {
  const key = `text:${rel}`;
  if (gitCache.has(key)) return gitCache.get(key);
  let out: string | null = null;
  try { out = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch { out = null; }
  gitCache.set(key, out);
  return out;
}
const lsTreeCache: { files: string[] } = { files: [] };
function headTreeFiles(): string[] {
  if (!lsTreeCache.files.length) {
    try {
      lsTreeCache.files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
    } catch { lsTreeCache.files = []; }
  }
  return lsTreeCache.files;
}

const lines: string[] = [];
let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass += 1; lines.push(`[PASS] ${label}`); }
  else { fail += 1; lines.push(`[FAIL] ${label}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`); }
};

const esc = (s: string): string => s.replace(/[$()*+.?[\]\\^{|}]/g, '\\$&');
const BIND_HEAD = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*readFileSync\s*\(/g;

/**
 * 批㉘ 补的第二条绑定通道（反模式 41：门越合规、审计越瞎）。
 * T02293 改判把「读工作树」收成「读 HEAD」，各门于是改用**本文件内的小 helper**取数
 * （`const B = headSrc('server/src/services/kickoffBuilder.ts')`、`const PKG_H = headSource('server/package.json') ?? ''`，
 * 甚至套一层清洗 `const B_H = strip(headSource('…')) ?? ''`）。BIND_HEAD 只认 `readFileSync(` 直取，
 * 于是这批门整体从审计视野里消失——HEAD 实测有 10+ 支门用这种形态。
 * 这里按「行首 const/let + 行内出现取源码动作 + 行内第一条像仓库相对路径的字面量」补绑定；
 * 路径认不出时 countHits 返回 -4（不可静态判定，进 W-01 比例），不硬猜成某个文件——宁可少审一条，
 * 也不要把审错了当成审过了。
 */
const READ_FN = /\b(?:readFileSync|headSrc|headSource|headText|headTextAt|headShow|headBlob|gitShow|showHead|gitFile)\s*\(/;
/** 「这支门有没有取源码动作」的入门判据（比 READ_FN 宽：也认内联 `git show HEAD:`） */
const READ_ENTRY = /readFileSync|headSrc|headSource|headText|headShow|gitShow|showHead|git show HEAD|show HEAD:/;
// 覆盖面含 `.bat/.ps1/.html/.py/.yml` 等非 JS 产物：T02293 的改判对象里有一批门钉的就是发布入口
// （`verify-t02616-managed-node.mjs` 等读 .bat，其中还有 GBK 文件名的 `启动服务.bat`——路径字符类要收 CJK），
// 只列 JS 系扩展名会让这些门整体落在审计盲区。
const CJK = '\\u4e00-\\u9fff';
const PATH_LIT = new RegExp(`['"\`]((?:[\\w.@\\-${CJK}]+/)*[\\w.@\\-${CJK}]+\\.(?:ts|tsx|mts|js|jsx|mjs|cjs|css|json|md|bat|ps1|cmd|html|py|ya?ml))['"\`]`);

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
/**
 * 关键字后面也是「期望一个值」的位置（批㉘ 补，反模式 42）。原写法只认单字符前邻，
 * `return /readonly periodLabel: string;/.test(RP)` 这种「关键字 + 正则」被整条跳过，
 * 扫描随后从**闭合斜杠**处重新起算，把 `.test(RP) && ` 中间的斜杠对当成正则——
 * 抽出 `/.test(RP) && /` 这类跨锚点噪声，并让真锚点漏检（t02157:270 实测）。
 */
const RE_AFTER_KEYWORD = /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;
function canStartRegex(line: string, p: number): boolean {
  let i = p - 1;
  while (i >= 0 && /\s/.test(line[i])) i -= 1;
  if (i < 0) return true;
  let j = i;
  while (j >= 0 && /[\w$]/.test(line[j])) j -= 1;
  const word = line.slice(j + 1, i + 1);
  // 前邻是标识符（且不是关键字）→ 那是除法/属性名，不是正则
  if (word) return RE_AFTER_KEYWORD.test(word);
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
 * 源码文件索引（懒建，取自 HEAD 已提交树）：门里的路径常是 `join(WEB, 'App.tsx')` 这类**变量打头**的拼接，
 * 静态只能拿到末段文件名。按 basename 在源码树里唯一命中才认，认不出标「不可静态判定」而不是硬猜——
 * 宁可少审一条锚点，也不要把审错了当成审过了。取 HEAD 树而非工作树（反模式 11）。
 */
let srcIndex: Map<string, string[]> | null = null;
function buildIndex(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.workbuddy', 'coverage', 'vendor', 'out', 'release']);
  for (const rel of headTreeFiles()) {
    if (!/\.(ts|tsx|mts|js|jsx|mjs|cjs|md|css|json|bat|ps1|cmd|html|py|ya?ml)$/.test(rel)) continue;
    const segs = rel.split('/');
    if (segs.some((s) => skipDirs.has(s))) continue;
    const base = segs[segs.length - 1];
    out.set(base, [...(out.get(base) ?? []), rel]);
  }
  return out;
}
const headFileSet = new Set<string>();
const inHeadTree = (rel: string): boolean => {
  if (!headFileSet.size) for (const f of headTreeFiles()) headFileSet.add(f);
  return headFileSet.has(rel);
};
const resolveFile = (rel: string): string | null => {
  // 先认「门里写的整条相对路径就在 HEAD 树里」，否则按 basename 唯一命中——两者都以 HEAD 为准，
  // 不看工作树（反模式 11：工作树里的同名文件可能是并发会话留下的过期版本，拿它求值会把好锚点判成恒假）。
  if (inHeadTree(rel)) return rel;
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
    // 取 HEAD 已提交树里的产品文本求值（不读工作树，反模式 11）
    contentCache.set(rel, target == null ? null : headText(target));
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
  // 第二条绑定通道：helper 取数形态（见 READ_FN 注释）。逐行判，行首必须是 const/let，
  // 以免把门体里那些「夹具源码字符串」（缩进后带引号开头的假源码）误当绑定。
  text.split('\n').forEach((line) => {
    const bm = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (!bm || binds.has(bm[1]) || !READ_FN.test(line)) return;
    const pm = PATH_LIT.exec(line);
    if (pm) binds.set(bm[1], pm[1]);
  });
  if (!binds.size) return out;
  const byKey = new Map<string, Anchor>();
  /** 锚点 key → 它被赋给的布尔变量名（反模式 43：禁词写成「先赋值、后取非」） */
  const assignedTo = new Map<string, string>();
  text.split('\n').forEach((line, idx) => {
    const mask = stringMask(line);
    for (const [v, rel] of binds) {
      const vRe = new RegExp(`\\b${esc(v)}\\b`);
      if (!vRe.test(line)) continue;
      const add = (a: Omit<Anchor, 'gate' | 'line' | 'hits' | 'lineText'>, declName?: string) => {
        if (!a.body) return;
        const key = `${idx + 1}:${a.anchor}`;
        if (seen.has(key)) return;
        seen.add(key);
        const pushed: Anchor = { gate: gateName, line: idx + 1, ...a, hits: countHits(a), lineText: line.trim().slice(0, 220) };
        out.push(pushed);
        byKey.set(key, pushed);
        if (declName) assignedTo.set(key, declName);
      };
      const PIPELINE = new RegExp(`${esc(v)}\\s*\\.\\s*(?:replace|replaceAll|split|slice|substring|indexOf|lastIndexOf|search|concat|padStart|padEnd)\\s*\\(\\s*$`);
      /** head 里当前是否停在「当实参用的对象字面量」内部（ok/okPair 的第三个参数＝取证上下文） */
      const inArgObject = (head: string, lineMask: boolean[]): boolean => {
        let d = 0;
        for (let i = head.length - 1; i >= 0; i -= 1) {
          if (lineMask[i]) continue;
          const c = head[i];
          if (c === ')' || c === ']' || c === '}') d += 1;
          else if (c === '(' || c === '[') { if (d > 0) d -= 1; }
          else if (c === '{') {
            if (d > 0) { d -= 1; continue; }
            let k = i - 1;
            while (k >= 0 && /\s/.test(head[k])) k -= 1;
            // 只有「实参位的对象字面量」才是取证上下文；赋值位（`const x = { a: /re/.test(V) }`）
            // 语义歧义（也可能是守卫集合），保守按判据收——审计宁可多抽不误删。
            return k >= 0 && (head[k] === '(' || head[k] === ',');
          }
        }
        return false;
      };
      /**
       * 「这个位置上的字面量算不算判据」（批㉘ 补，三条分支共用同一谓词，不各写各的）：
       *  - 证据字段不是判据：`{ hex: V.match(/re/g) }`、`取色分支命中: fn(V)` 只是把取证结果写进
       *    上下文，红了的是别的判据，把它当锚点会凭空造出「恒假」；`key: /re/`（紧跟）与
       *    `key: fn(/re/)`（套一层取证函数）两种形态都要认。
       *  - 取证管线不是判据：`V.replace(/\\r\\n/g, '\\n')`、`V.split(...)` 只是把取来的源码归一形态，
       *    把它当守卫锚点会抽出 `/\r\n/g` 这种与产品内容无关的行尾噪声（t02290/t02291 实测）。
       * 歧义只留在「冒号」这一处：`a ? b : /re/.test(V)` 的 else 分支前邻也是标识符+冒号。
       * 先用**括号深度**判它到底在不在取证对象里（反模式 44）——原来只看「行内有没有 `?`」，
       * 而 t02288:137 的取证对象里带了个 `?? []`，于是那条 `旧值仍在: /re/.test(srcWs)` 被当成判据，
       * 与真禁词锚点同形混进恒假清单。行内没进取证对象、又出现过 `?`，才按判据处理（宁可多抽一条噪声，
       * 也不把真判据当证据字段——那是审计瞎）；管线那条不受此歧义影响：`V.replace(` 紧贴字面量，写法唯一。
       */
      const isGuardPosition = (head: string, lineMask: boolean[]): boolean => {
        if (PIPELINE.test(head)) return false;
        // 键名的字符类要收 CJK：本仓门的取证字段十有八九写成 `{ 旧值仍在: … }`，
        // 用 `[\w$]` 认不出中文键名，取证字段就连同真判据一起进了恒假清单（批㉘ t02288:137 实测）
        const colonKey = new RegExp(`[\\w$${CJK}]\\s*:\\s*(?:[\\w$.${CJK}]*\\(\\s*)?$`);
        if (colonKey.test(head)) {
          if (inArgObject(head, lineMask)) return false;
          return head.includes('?');
        }
        return true;
      };
      // 「正则紧贴 .test(V) / .exec(V)」才是这条锚点属于 V 的凭据。原来只看 40 字符窗口里有没有出现变量名，
      // 于是 `/A/.test(SSRC) && /B/.test(BSRC)` 这种链式条件里，第一条正则会因为窗口越过第二个变量而被
      // **错误归到 BSRC 那份文件上**（t02101:193 实测：`/const noData = execDays === 0/` 本属于 SSRC=
      // kickoffService.ts 且命中 1，被算到 kickoffBuilder.ts 上成 0 命中 → 假「恒假」）。
      const TEST_ADJ = new RegExp(`^\\s*\\.\\s*(?:test|exec)\\s*\\(\\s*(?:[\\w$.]+\\(\\s*)?${esc(v)}\\b`);
      /**
       * 「这条判据的结果被赋给了谁」：禁词常写成 `const old = /re/.test(src); … !old`，
       * 取非挂在中间变量上、字面量那行前邻没有 `!`（反模式 43，方向由收尾的间接取非道判）。
       * 只认「整个赋值表达式就是这条判据」的写法：`const X =` 直接接字面量，或 `const X = V.test(/includes(/match(`。
       */
      const DECL_HEAD = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:[A-Za-z_$][\w$.]*\s*\.\s*(?:test|includes|match|exec)\s*\()?)$/;
      const declNameOf = (head: string): string | undefined => DECL_HEAD.exec(head)?.[1];
      let p = line.indexOf('/');
      while (p >= 0) {
        const lit = mask[p] || !canStartRegex(line, p) ? null : literal(line, p);
        if (lit) {
          const tail = line.slice(lit.end, lit.end + 40);
          if (TEST_ADJ.test(tail)) {
            // 反向锚点三种写法都要认：`!/re/.test(V)` 前缀非、`/re/.test(V) === false` 后缀非、
            // `V.match(/re/) … length === 0` 计数为零。认漏一种就会把「断言某写法已消失」误判成「判据恒假」。
            const head = line.slice(0, p).trimEnd();
            const neg = head.endsWith('!')
              || /^\s*(===|==)\s*false\b/.test(tail.replace(/^\s*\.\s*test\(\s*[^)]*\)/, ''));
            if (isGuardPosition(head, mask)) {
              // 「先赋值给变量、之后整体取非」也是禁词写法——变量名交给收尾的间接取非道去判方向
              add({
                file: rel, kind: 're', body: lit.src, flags: lit.flags, anchor: `/${lit.src}/${lit.flags}`, neg,
              }, declNameOf(head));
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
        // 用「整条取数表达式」判位置（`{ hex: V.match(/re/g) }` 的冒号在函数名之前，只看 V 前面会漏）；
        // m[0] 末尾含匹配用的 `/`，判位置时要去掉，否则表达式不再以 `(` 结尾、字段冒号认不出
        if (isGuardPosition(line.slice(0, (m.index ?? 0) + m[0].length - 1), mask)) {
          add({
            file: rel, kind: 're', body: lit.src, flags: lit.flags, anchor: `/${lit.src}/${lit.flags}`,
            neg: /!\s*$/.test(before) || negCount,
          }, declNameOf(line.slice(0, (m.index ?? 0) + m[0].length - 1)));
        }
      }
      // V.includes('str')——引号字符类用 \x27\x22\x60 写，避免反引号把模板串提前终止
      for (const m of line.matchAll(new RegExp(`${esc(v)}\\s*\\.\\s*includes\\(\\s*([\\x27\\x22\\x60])([^\\x27\\x22\\x60]*)\\1`, 'g'))) {
        // 与 match 分支同一口径：前面挂 `!` 的是「不得含」负锚，抽成正锚会把「删掉即绿」判成「删掉即红」
        const headFull = line.slice(0, (m.index ?? 0) + m[0].length - 1);
        const neg = /!\s*$/.test(line.slice(0, m.index ?? 0).trimEnd());
        if (!isGuardPosition(headFull, mask)) continue;
        add({ file: rel, kind: 'str', body: m[2], flags: '', anchor: JSON.stringify(m[2]), neg }, declNameOf(headFull));
      }
    }
  });
  // 反模式 43（批㉘）：禁词的「取非」挂在中间变量上——`const oldCapAsCap = /=\\s*20000\\b/.test(srcWs);`
  // 之后 `!oldCapAsCap`。字面量那行前邻没有 `!`，逐行判方向必然把它当正向守卫，于是「命中 0 处」
  // （＝禁词确已消失，本是判据想要的好结果）被报成「判据恒假」。按整篇文本回看该变量的用法：
  // **全部用法都是取非**才翻向；同篇里还正着用（`assert(x)`）的不翻（宁可留一条假恒假给人看，
  // 也不把真失配静默掉）。t02288 W-A04 两条即此形态。
  for (const [key, name] of assignedTo) {
    const a = byKey.get(key);
    if (!a || a.neg) continue;
    let negUse = 0;
    let otherUse = 0;
    // 只取匹配点两侧各 12 字符的窗口判方向（整篇 slice 会把这一节变成 O(变量数 × 出现次数 × 文本长度)，
    // 实测门体上千行时一轮审计从 6 分钟涨到 14 分钟）
    for (const m of text.matchAll(new RegExp(`\\b${esc(name)}\\b`, 'g'))) {
      const at = m.index ?? 0;
      const before = text.slice(Math.max(0, at - 12), at);
      const after = text.slice(at + name.length, at + name.length + 12);
      if (/\b(?:const|let|var)\s+$/.test(before)) continue; // 声明位自身不算用法
      if (/!\s*$/.test(before) || /^\s*(?:===|==)\s*false\b/.test(after)) negUse += 1; else otherUse += 1;
    }
    if (negUse > 0 && otherUse === 0) a.neg = true;
  }
  return out;
}

// —— 已登记的恒假锚点（棘轮基线）——
// T02293 改判：基线**按锚点正文签名**（门|目标文件|锚点）登记，而不是 `门:行号`。原因：并发批次会移动这些门的
// 行号，按行号登记会因他门改判而让「已登记」项漂成「新失配」，把跨单失配错误地算到本门头上；按正文签名则稳定。
// 每条必须带裁定（W-05 要求非空），且裁定要写清「谁、为什么不修在这里」——审计只点名、不越界去改别人的门。
// 这些都是**别的路径/批次**的锚点（不在本单可改的四支门内），逐条如实标注归属：
// 批㉘ 删除过三条：
// ① `verify-t02156-kickoff-brand.mts | server/package.json | /cpSync\('src\/services\/assets'…/`
// ——该锚点已随 t02156 的改判退出门体（现在只在注释里被提及，判据改成了 `skipped()` 环境缺口），
// 签名不再被抽出＝W-05 的僵尸基线，按判据删登记而不是留着让它变成「谁都不会来看一眼」的例外清单。
// ②③ `verify-t02288-snapshot-cap.mts | server/src/services/WorkspaceService.ts` 的两条
// （`/if \(dirs\.size >= SYMBOL_SNAPSHOT_MAX_DIRS\)/` 与 `/=\s*20000\b/`）——**登记的裁定原本是错的**：
// 当时写成「t02288 的源码锚点与 HEAD 现状漂移，待该门改判批次收敛」，实测 HEAD 的 t02288 W-A04 是
// 「禁词已消失」的正常绿判据，恒假是**本审计**把「取非挂在中间变量上的禁词」（反模式 43）与
// 「中文键名的取证字段」（反模式 44）当成正向判据造成的。修抽取器后这两条签名自然退出恒假集，
// 僵尸点名（W-05）如实报出——留着一张写着别人名字的例外清单，就是把审计器的瞎转嫁成他门的债。
const KNOWN: Array<{ gate: string; file: string; anchor: string; verdict: string }> = [
  { gate: 'verify-t02099-kickoff-builder.mts', file: 'server/src/services/kickoffBuilder.ts',
    anchor: String.raw`/pptx\.defineLayout\(KICKOFF_LAYOUT_DEF_OTHER\)/`,
    verdict: 'okPair N-02 负对照演示锚点（故意引一个 HEAD 里不存在的符号来证明「字面锚点失配」红因可区分）——审计器无法区分负对照演示与正向守卫，非真失配，归属 t02099 批次' },
];
const sig = (a: Pick<Anchor, 'gate' | 'file' | 'anchor'>): string => `${a.gate}|${a.file}|${a.anchor}`;
const KNOWN_SIG = new Set(KNOWN.map((k) => `${k.gate}|${k.file}|${k.anchor}`));
const REGISTERED: Record<string, string> = {}; // 保留：按 `门:行号` 的即时登记位（本轮无）

// 门本体也从 HEAD 枚举读取（反模式 11）：并发会话正在改的门不影响本轮自证的确定性，可在任意时点复跑。
// T02293 批㉘：枚举面从「只有 .mts」扩到全部 JS 系门体。原写法把 `.mjs/.js/.ts` 整族排除在外，
// 而 `verify-t02616-managed-node.mjs`／`verify-t02617-guard-reference.mjs` 等确实有
// `const X = readFileSync(...)` 形态的源码守卫——审计看不见它们，census 报出来的「残留门数」就是虚低。
const gateFiles = headTreeFiles()
  .filter((f) => f.startsWith('scripts/verify-') && /\.(?:mts|mjs|js|ts)$/.test(f))
  .map((f) => f.slice('scripts/'.length));
const all: Anchor[] = [];
const guardGates: string[] = [];
for (const g of gateFiles) {
  const text = headText(`scripts/${g}`) ?? '';
  // 入门判据与绑定通道同源（批㉘）：原来写死 `text.includes('readFileSync')`，而 T02293 改判后的门改用
  // 本文件内的 HEAD 取数 helper（t02099 全文不含 `readFileSync` 这个词）——于是这些门**连被枚举的资格都没有**，
  // 「僵尸基线」的红其实是这里漏门。用 READ_ENTRY 而不是 READ_FN：还要认 `git show HEAD:` 内联取数。
  if (!READ_ENTRY.test(text)) continue;
  const a = collectAnchors(g, text);
  if (a.length) { guardGates.push(g); all.push(...a); }
}

const unresolvable = all.filter((a) => a.hits === -4);
// 审计盲区点名（留痕，不判成败）：门里有取源码动作、但抽取器一条锚点都认不出——多半是取数走了
// 间接形态（helper 函数 `read(...)`、变量拼路径 `readFileSync(srcPath)`），静态判不出目标文件。
// 不点名就会把「审计看不见」误读成「没有残留」（批㉗ 教训的另一个方向）。
const INDIRECT_GATES = gateFiles.filter((g) => {
  if (guardGates.includes(g)) return false;
  const t = headText(`scripts/${g}`) ?? '';
  return READ_ENTRY.test(t);
});
const anchorCountOf = (g: string): number => all.filter((a) => a.gate === g).length;
// 「审计器自己不是空转」的证据（T02293 批㉘ 重做）。
// 原写法拿 HEAD 生态数量当在位下限（≥15 门 / ≥100 锚点 / ≥10 门各≥3 锚点），但那三个数正是 T02293
// 要往下压的量——每收口一支门，本门就为自己的进度红一次（本轮 HEAD 实测 11 门 / 79 锚点 / 9 深门，
// W-01 与 W-08 双双转红，红的是改判成果而不是判据坏了）。在位性改由 W-09 的**内存夹具自证**承担，
// 生态数量降级为事实留痕（写进标签供人看趋势，不参与成败）。
const deepGates = guardGates.filter((g) => anchorCountOf(g) >= 3);

/**
 * W-09 夹具自证：假门体 + 假产品文本全在内存里（零落盘、与 HEAD 数量无关）。
 * 夹具门含 8 条守卫锚点：正向正则 / 正向字面串 / 前缀非反向锚 / 计数归零反向锚 /
 * **helper 取数通道**的正向锚 / **取非挂在中间变量上的禁词**（反模式 43）/ 两条与取证同现行的正向锚。
 * 另有 3 处**不该**产出锚点：一条行尾归一管线 + 两条 ok 的取证上下文对象字段（test 形态、match 形态）。
 * 抽取器退化、把反向锚认成正向、把取证字段当判据、或第二条绑定通道没把 helper 变量认成取数面，
 * 这一组都会当场塌——而 HEAD 上的门数怎么减少它都恒绿，这才是「审计器在位」的正确凭据。
 */
const FIXTURE_PRODUCT = [
  'export const WIDGET_LIMIT = 42;',
  'function renderWidget(el) {',
  "  return el.setAttribute('role', 'img');",
  '}',
].join('\n');
const FIXTURE_GATE = [
  "const FP = readFileSync(join(ROOT, 'fixture-widget.ts'), 'utf8');",
  // helper 取数形态：变量名不叫 readFileSync、外面还套了一层清洗函数
  "const FP2 = stripComments(headSrc('fixture-widget.ts'));",
  "ok('F-01 常量单一来源', /WIDGET_LIMIT\\s*=\\s*42/.test(FP));",
  "ok('F-02 可访问属性接线', FP.includes('role'));",
  "ok('F-03 旧写法已退役', !/var\\s+LIMIT\\b/.test(FP));",
  "ok('F-04 旧标识符计数归零', FP.match(/\\blegacyLimit\\b/g)?.length === 0);",
  "ok('F-05 helper 通道的锚点也进审计', /renderWidget\\s*\\(/.test(FP2));",
  // 反模式 43 的夹具面（t02288 W-A04 同款写法）：禁词的取非不在字面量那行，而在中间变量上
  'const legacyFlag = /\\blegacyToken\\b/.test(FP);',
  "ok('F-06 旧符号禁词（间接取非）', FP.includes('role') && !legacyFlag);",
  // 下面三行都**不该**产出守卫锚点：一条行尾归一管线 + 两条取证上下文对象字段（test 形态 / match 形态）。
  // 抽取器把取证动作误当判据，就会凭空造出「恒假锚点」（t02198/t02288:137/t02290/t02291 实测的同款假阳性）。
  'const normalized = FP.replace(/\\r\\n/g, "\\n");',
  "ok('F-07 判据与取证同现', /WIDGET_LIMIT/.test(FP), { 旧写法命中: /\\blegacyOther\\b/.test(FP) });",
  "ok('F-08 计数取证字段', /renderWidget/.test(FP), { 计数: FP.match(/legacyCountX/g)?.length });",
].join('\n');
// 夹具锚点不走真实文件解析（目标文件只存在于内存），求值口径改喂 FIXTURE_PRODUCT
const fixAnchors = collectAnchors('verify-fixture-selfcheck.mts', FIXTURE_GATE)
  .map((a) => ({ ...a, hits: hitsIn(FIXTURE_PRODUCT, a) }));
const fixBy = (anchor: string) => fixAnchors.filter((a) => a.anchor === anchor);
// F-01 与 F-07 的正向锚同现于两处（不同行＝不同 key），故夹具按「锚点正文」计数而非条数去重
const FIX_EXPECT: Array<{ anchor: string; kind: 're' | 'str'; neg: boolean; hits: number; count: number }> = [
  { anchor: String.raw`/WIDGET_LIMIT\s*=\s*42/`, kind: 're', neg: false, hits: 1, count: 1 },
  { anchor: JSON.stringify('role'), kind: 'str', neg: false, hits: 1, count: 2 },
  { anchor: String.raw`/var\s+LIMIT\b/`, kind: 're', neg: true, hits: 0, count: 1 },
  { anchor: String.raw`/\blegacyLimit\b/g`, kind: 're', neg: true, hits: 0, count: 1 },
  { anchor: String.raw`/renderWidget\s*\(/`, kind: 're', neg: false, hits: 1, count: 1 },
  { anchor: String.raw`/\blegacyToken\b/`, kind: 're', neg: true, hits: 0, count: 1 },
  { anchor: String.raw`/WIDGET_LIMIT/`, kind: 're', neg: false, hits: 1, count: 1 },
  { anchor: String.raw`/renderWidget/`, kind: 're', neg: false, hits: 1, count: 1 },
];
const FIX_EXPECT_TOTAL = FIX_EXPECT.reduce((n, e) => n + e.count, 0);
const fixtureBefore = { pass, fail };
// 取证字段/管线一旦误收，正文里必然带这些标识符或行尾转义（夹具产品文本里没有它们）
const FIX_FORBIDDEN = ['legacyOther', 'legacyCountX', '\\r'];
const fixtureNoise = fixAnchors.filter((a) => FIX_FORBIDDEN.some((f) => a.body.includes(f)));
ok(`W-09a 夹具抽取识别：${FIX_EXPECT.length} 种守卫锚点（共 ${FIX_EXPECT_TOTAL} 条，含 helper 取数通道与「取非挂变量」的禁词）全部认出、3 处非判据面（行尾归一管线 + 两条取证上下文字段）不误收（实测 ${fixAnchors.length} 条，逐条 kind/neg/命中数/目标文件与预期对齐）`,
  fixAnchors.length === FIX_EXPECT_TOTAL && fixtureNoise.length === 0 && FIX_EXPECT.every((e) => {
    const got = fixBy(e.anchor);
    return got.length === e.count && got.every((a) => a.kind === e.kind && a.neg === e.neg && a.hits === e.hits && a.file === 'fixture-widget.ts');
  }), { 实抽: fixAnchors.map((a) => `${a.anchor} kind=${a.kind} neg=${a.neg} hits=${a.hits} line=${a.line} file=${a.file}`), 误收非判据: fixtureNoise.map((a) => a.anchor) });
const fixMutated = FIXTURE_PRODUCT.replace('export const WIDGET_LIMIT = 42;', 'export const WidgetLimitValue = 42;');
const fixAfter = fixAnchors.map((a) => ({ ...a, hits: hitsIn(fixMutated, a) }));
const fixNamed = zeroHitsOf(fixAfter);
// 改名后被点名的条数＝夹具预期里「锚正文取自那个被改名的常量、且是正向锚」的条数（不手数）
const FIX_MUTATED_NAMED = FIX_EXPECT
  .filter((e) => !e.neg && e.anchor.includes('WIDGET_LIMIT'))
  .reduce((n, e) => n + e.count, 0);
ok('W-09b 夹具求值与点名：把写法等价改坏（常量改名）后，以常量名为锚的正向锚命中归 0，且恒假清单当场点名它们（不多不少、禁词与取证字段不进清单）——「0 命中即点名」这条判据自己咬得住',
  fixMutated !== FIXTURE_PRODUCT && /WidgetLimitValue/.test(fixMutated)
  && fixNamed.length === FIX_MUTATED_NAMED && fixNamed.every((a) => a.body.includes('WIDGET_LIMIT'))
  && fixAfter.filter((a) => a.anchor === FIX_EXPECT[0].anchor).every((a) => a.hits === 0),
  { 点名: fixNamed.map((a) => `${a.anchor}@${a.line}`), 应为: FIX_MUTATED_NAMED });
const fixOld = `${FIXTURE_PRODUCT}\nvar LIMIT = 7;`;
const fixRevive = fixAnchors.map((a) => ({ ...a, hits: hitsIn(fixOld, a) }));
const FIX_NEG_TOTAL = FIX_EXPECT.filter((e) => e.neg).reduce((n, e) => n + e.count, 0);
ok(`W-09c 反向锚识别方向正确：夹具里 ${FIX_NEG_TOTAL} 条禁词（前缀非／计数归零／取非挂变量三种写法各一）命中 0 却不进恒假清单（否则整批「断言某写法已消失」会被误报成判据坏了）；把旧写法插回后禁词命中数立刻 >0（门的禁词判据会转红）`,
  zeroHitsOf(fixAnchors).length === 0 && fixAnchors.filter((a) => a.neg).length === FIX_NEG_TOTAL
  && fixRevive.find((a) => a.anchor === FIX_EXPECT[2].anchor)?.hits === 1,
  { 夹具恒假清单: zeroHitsOf(fixAnchors).map((a) => a.anchor), 实抽禁词: fixAnchors.filter((a) => a.neg).map((a) => a.anchor), 插回后命中: fixRevive.find((a) => a.anchor === FIX_EXPECT[2].anchor)?.hits });
// 夹具组的绿数必须**增量**核对（不假设本组是门里第一批断言：以后在前面加判据也不会把这条变成恒真）
const fixtureGreen = fail === fixtureBefore.fail && pass === fixtureBefore.pass + 3;
ok(`W-01 审计枚举在位（实测 ${guardGates.length} 门 / ${all.length} 锚点 / ${deepGates.length} 门各≥3 锚点——这三个数是 HEAD 生态的**事实留痕**，随 T02293 改判下降属预期、不判成败）：门数与锚点数均 >0、目标路径不可静态判定占比 ≤ 40%，且 W-09 夹具自证三条全绿（在位性由夹具承担）`,
  fixtureGreen && guardGates.length >= 1 && all.length >= 1 && unresolvable.length <= all.length * 0.4,
  { 夹具组: fixtureGreen ? '全绿' : '有红（见 W-09a/b/c）', 门数: guardGates.length, 锚点数: all.length, 各: deepGates.length, 路径不可判定: unresolvable.length });

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
// 「未登记」= 正文签名不在 KNOWN 基线、且不在即时 REGISTERED（门:行号）里。
const fresh = zeroHits.filter((a) => !KNOWN_SIG.has(sig(a)) && !regKeys.has(`${a.gate}:${a.line}`));
ok(`W-04 棘轮：没有「未登记的恒假锚点」——正向锚点命中 0 处即点名「判据本身没命中（可能已被重构换掉写法）」，不再 && 静默短路（实测未登记 ${fresh.length} 条／恒假共 ${zeroHits.length} 条／基线登记 ${KNOWN_SIG.size} 条）`,
  fresh.length === 0,
  { 未登记清单: fresh.map((a) => `${a.gate}:${a.line} [${a.file}] ${a.anchor} ⟵ 门内原文：${a.lineText}`).slice(0, 40), 基线数: KNOWN_SIG.size });
// 基线项必须逐条带裁定：空壳登记＝把失配重新变回静默（反模式：例外清单本身是换了马甲的文本锚）。
const hollowKnown = KNOWN.filter((k) => !k.verdict?.trim() || !k.anchor.trim() || !k.file.trim());
const hollowReg = [...regKeys].filter((k) => !REGISTERED[k]?.trim());
// 覆盖牙齿：基线要正好覆盖当前恒假项、不多登记已恢复的僵尸项——否则基线自己悄悄膨胀成新文本锚。
const baselineCoversAll = zeroHits.every((a) => KNOWN_SIG.has(sig(a)) || regKeys.has(`${a.gate}:${a.line}`));
// 僵尸基线必须**点名到 sig**（T02293 批㉘）：基线按 `门|文件|锚点` 签名登记，而他门改判会把锚点本身删掉
// ——签名随之消失。原写法只输出一个 `僵尸基线:true`，读的人不知道是哪条该删，等于把棘轮的另一半做成哑判据。
const zombie = [...KNOWN].filter((k) => !zeroHits.some((a) => `${k.gate}|${k.file}|${k.anchor}` === sig(a)));
const noStaleBaseline = zombie.length === 0;
ok('W-05 基线/登记项逐条带裁定且与当前恒假集互相覆盖（空壳＝重新静默；僵尸基线＝漏检真失配；每条须写清归属门，越界只点名不改他门）',
  hollowKnown.length === 0 && hollowReg.length === 0 && baselineCoversAll && noStaleBaseline,
  { 空壳: hollowKnown.length, 即时登记空壳: hollowReg.slice(0, 5), 基线漏覆盖: !baselineCoversAll,
    僵尸基线: zombie.map((k) => `${k.gate}|${k.file}|${k.anchor} ⟵ 裁定原文：${k.verdict}`), 基线数: KNOWN_SIG.size });
// 反向锚点（断言「某种写法已经不存在」，如 builder 里零 hex 字面量、`.test(B) === false`）的识别
// 是这套审计的命门：一旦识别失效，它们会整批被误报成恒假，或被当成正向锚点反过来掩盖真失配。
const negTotal = all.filter((a) => a.neg).length;
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
// W-08 原判据写死「探针 ≥30 条、覆盖 ≥12 门」——同反模式 39：把 HEAD 生态数量当在位下限，
// 改判把带活锚点的门收口掉，探针数与覆盖门数就跟着掉，本门为自己的进度红（本轮实测 29 条／11 门即红）。
// 改成**比例判据**：凡「有活锚点的门」都必须被探针覆盖到（漏一门即红），且每门至少探到一条；
// 分母非空由 `gatesWithAliveAnchor.size > 0` 自证（防空分母恒真，反模式 20 同族）。
const gatesWithAliveAnchor = new Set(all.filter((a) => !a.neg && a.hits > 0).map((a) => a.gate));
const coveredGates = new Set(probeTargets.map((a) => a.gate));
const uncovered = [...gatesWithAliveAnchor].filter((g) => !coveredGates.has(g));
ok(`W-08 反向探针覆盖全部「有活锚点的门」并逐条点名：命中 0 处的锚点必然被恒假清单收录（与 W-04 复用同一判据，不是另写一遍）；覆盖按比例判——漏一门即红，不锁 HEAD 生态数量（实测有活锚点 ${gatesWithAliveAnchor.size} 门 / 已覆盖 ${coveredGates.size} 门 / 探针 ${probeTargets.length} 条）`,
  gatesWithAliveAnchor.size > 0 && uncovered.length === 0 && probeTargets.length >= coveredGates.size && mutatedMiss.length === 0,
  { 漏点名: mutatedMiss, 漏覆盖门: uncovered, 探针数: probeTargets.length, 覆盖门数: coveredGates.size, 有活锚点门数: gatesWithAliveAnchor.size });

// =====================================================================
// 批㉝（T02770）L 组：门体「用了但解析不到的标识符」自检接入审计器。
//
// 立项现场（批㉛ 实测）：给 `verify-t01875.mjs` 加 Z2 残留判据时写了 `existsSync(...)` 却漏加
// `import { existsSync } from 'node:fs'`。`node --check` **只做语法解析**，查不出未定义标识符，
// 于是门跑到 `finally` 才抛 `existsSync is not defined`——PASS/FAIL 汇总整行丢失、判据一条没落，
// 红看起来像「门自身崩溃的既有噪声」（反模式 47 的近亲：崩溃不是功能失守，却会被读成功能失守）。
//
// 本组判据打在**加载面结构事实**上：AST 级「读位置的根标识符 ∉ 全篇绑定名 ∪ 全局表」，
// 由 `./lib/undefined-identifier-check.mts` 实现。为什么不能是 grep（母单点名、本轮首轮全部复现）：
//   ① `import fs from 'node:fs'` + `fs.existsSync()` —— 读用的根是 `fs`，不是 `existsSync`；
//   ② `const { existsSync } = require('node:fs')` —— 解构绑定；
//   ③ 门体内嵌的**夹具字符串**（``script: `const fs=require('fs');…` ``）里的标识符不属于门体作用域。
//   我自己的第一版就中了 ①②（具名 import 未收绑定、重命名解构的**被导入名**当读用），
//   106 支门体报 102 支——那正是本判据要消灭的「红因不可归因」噪声的 AST 版本，故夹具必须双向下证。
//
// 取数面 = HEAD（`headText`），与并发工作树无关；本组零服务、零落盘。
type LoadCase = { id: string; name: string; fileName: string; code: string; expect: string[] };
const LOAD_CASES: LoadCase[] = [
  // —— 该抓的（正向有牙） ——
  { id: 'a1', name: '用了却没 import（批㉛ 真实缺陷形）', fileName: 'g.mjs', code: `import { readFileSync } from 'node:fs';\nif (existsSync('/tmp/x')) console.log(readFileSync('/tmp/x', 'utf8'));\n`, expect: ['existsSync'] },
  { id: 'a2', name: '重命名解构后误用被导入名', fileName: 'g.mts', code: `const { EstimateService: S } = await import('m');\nS.go();\nEstimateService.bad();\n`, expect: ['EstimateService'] },
  { id: 'a3', name: '对象字面量简写是真读用', fileName: 'g.mjs', code: `const o = { existsSync };\n`, expect: ['existsSync'] },
  { id: 'a4', name: '类继承的基类是运行时取值', fileName: 'g.mts', code: `class B extends BaseSvc { }\n`, expect: ['BaseSvc'] },
  { id: 'a5', name: '模板插值属门体自己的作用域', fileName: 'g.mjs', code: 'const t = `x${missingVar}y`;\n', expect: ['missingVar'] },
  { id: 'a6', name: '计算属性名与下标键', fileName: 'g.mjs', code: `const k = 'a';\nconst o = { [unknownKey]: 1 };\no[unknownIdx] = 2;\n`, expect: ['unknownKey', 'unknownIdx'] },
  // —— 不该抓的（母单点名的三类假阳 + 另外四类常见写法） ——
  { id: 'b1', name: '命名空间默认导入（fs.existsSync）', fileName: 'g.mjs', code: `import fs from 'node:fs';\nif (fs.existsSync('/tmp/x')) { }\n`, expect: [] },
  { id: 'b2', name: 'CJS 解构 require', fileName: 'g.js', code: `const { existsSync, readFileSync: rf } = require('node:fs');\nif (existsSync('/a')) rf('/a');\n`, expect: [] },
  { id: 'b3', name: '内嵌夹具字符串里的代码', fileName: 'g.mjs', code: 'const s = `const fs=require("fs"); fs.existsSync(p); undefinedInFixture()`;\nconsole.log(s);\n', expect: [] },
  { id: 'b4', name: '具名 import 全项（本仓绝大多数门体的写法）', fileName: 'g.mjs', code: `import { existsSync, join } from 'node:fs';\nimport { join as j2 } from 'node:path';\nconsole.log(existsSync(join('/a')), j2);\n`, expect: [] },
  { id: 'b5', name: '类型位不算读用', fileName: 'g.mts', code: `interface Foo { x: number }\nconst a: Foo = { x: 1 };\nfunction f(b: Array<string>): Map<string, number> { void b; return new Map(); }\nf([]);\nvoid a;\n`, expect: [] },
  { id: 'b6', name: 'catch 形参 / label / 可选链 / for-of 解构', fileName: 'g.mjs', code: `const xs = [1];\nouter: for (const [a, b] of [xs]) {\n  try { a?.b?.c(); } catch (e) { console.log(e.message, b); }\n  continue outer;\n}\n`, expect: [] },
];
const loadCaseResults = LOAD_CASES.map((c) => {
  const r = checkSource(c.code, c.fileName);
  const got = r.hits.map((h) => h.name);
  const miss = c.expect.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !c.expect.includes(n));
  return { id: c.id, name: c.name, got, miss, extra, parseError: r.parseError };
});
const loadCaseBad = loadCaseResults.filter((x) => x.miss.length > 0 || x.extra.length > 0 || x.parseError);
ok(`L-01 加载面自检器夹具双向自证：${LOAD_CASES.length} 例（${LOAD_CASES.filter((c) => c.expect.length).length} 例该抓、${LOAD_CASES.filter((c) => !c.expect.length).length} 例不该抓），逐例命中集必须与期望**完全相等**（多报即噪声、少报即无牙），实错 ${loadCaseBad.length} 例`,
  LOAD_CASES.length === 12 && loadCaseResults.length === LOAD_CASES.length && loadCaseBad.length === 0,
  { 失配例: loadCaseBad.map((x) => `${x.id} ${x.name} 命中=${JSON.stringify(x.got)} 漏=${JSON.stringify(x.miss)} 多报=${JSON.stringify(x.extra)}${x.parseError ? ` 语法层=${x.parseError}` : ''}`) });

// L-02 真实门体变异：夹具绿不等于对**真门**有牙（批㉘ W-09 的教训沿用）。
// 取 HEAD 的 `verify-t01875.mjs`（批㉛ 出事的那支）两态对照：
//   a) 原样 ⇒ 必须 0 命中（否则本判据在真实语料上虚报，L-04 的红就没有意义）；
//   b) 摘掉一个具名 import 项（就是批㉛ 的缺陷形态）⇒ 必须点名那个名字。
const REAL_GATE_FILE = 'scripts/verify-t01875.mjs';
const realGateSrc = headText(REAL_GATE_FILE) ?? '';
const realBaseline = realGateSrc ? checkSource(realGateSrc, REAL_GATE_FILE) : { hits: [], parseError: 'HEAD 取数失败' };
/** 从源码里按「首条具名 import 的花括号内容」取候选本地名（只认裸名，`a as b` 一律跳过，保证可精确回删） */
function namedImportCandidates(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s*\{([^}]*)\}\s*from\s*['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const p of m[1].split(',')) {
      const t = p.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}
/** 把某个具名 import 项从**声明处**摘掉（其余逐字保留），复现「用了没 import」 */
function spliceNamedImport(src: string, name: string): string | null {
  const re = /^import\s*\{([^}]*)\}\s*from\s*['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const parts = m[1].split(',');
    const idx = parts.findIndex((p) => p.trim() === name);
    if (idx >= 0) {
      parts.splice(idx, 1);
      const innerStart = m.index + m[0].indexOf('{') + 1;
      return src.slice(0, innerStart) + parts.join(',') + src.slice(innerStart + m[1].length);
    }
  }
  return null;
}
const realCands = namedImportCandidates(realGateSrc);
let realMut: { name: string; hits: string[]; tried: number } | null = null;
for (let i = 0; i < realCands.length; i++) {
  const name = realCands[i];
  const mutated = spliceNamedImport(realGateSrc, name);
  if (mutated === null) continue;
  const hits = checkSource(mutated, REAL_GATE_FILE).hits.map((h) => h.name);
  if (hits.includes(name)) { realMut = { name, hits, tried: i + 1 }; break; }
}
ok(`L-02 真实门体变异有牙：HEAD 的 ${REAL_GATE_FILE}（${realGateSrc.length} 字符）原样必须 0 命中（实得 ${JSON.stringify(realBaseline.hits.map((h) => h.name)).slice(0, 160)}），把某个具名 import 项从声明处摘掉（批㉛ 的真实缺陷形态）必须点名该名字（候选 ${realCands.length} 个，第 ${realMut?.tried ?? 0} 个即命中 ${realMut?.name ?? '（无）'}）`,
  realBaseline.hits.length === 0 && !realBaseline.parseError && realMut !== null,
  { 原样命中: realBaseline.hits.slice(0, 5), 语法层: realBaseline.parseError, 变异: realMut });

// L-03 分层归因：语法层坏 ≠ 未定义标识符。本判据的红只该来自「加载即 ReferenceError」，
// 语法坏由 `--check` 那一层负责；混在一起就又回到「红因不可归因」。
const syntaxCase = checkSource(`const a = ;\nif () {}\n`, 'broken.mjs');
ok('L-03 语法层失败单独回传 parseError 且**不产出**任何未定义标识符命中（AST 已不可信，行号不能报）',
  !!syntaxCase.parseError && syntaxCase.hits.length === 0,
  { parseError: syntaxCase.parseError, hits: syntaxCase.hits });

// L-04 全量普查（本单第 1 条要求的「批量体检」，进成败判定）：HEAD 的 verify-* 与 lib/* 逐支扫，
// 命中即点名。⚠ 不用「文件数下限」钉在位性（反模式 39：数量当在位下限会让自己为进度红），
// 在位性由 L-01/L-02 两条变异道负责；这里只补一条**非空转**守卫：枚举面与取数面必须逐支对上，
// 一支读不到源码就点名——否则「0 命中」可能只是「0 支被扫过」。
const loadScanFiles = listHeadGateFiles(ROOT);
const loadScanHits: Array<{ file: string; line: number; column: number; name: string }> = [];
const loadScanReadFail: string[] = [];
const loadScanSyntaxFail: string[] = [];
const loadScanT0 = Date.now();
let loadScanned = 0;
for (const rel of loadScanFiles) {
  const code = headText(rel);
  if (code === null) { loadScanReadFail.push(rel); continue; }
  loadScanned += 1;
  const r = checkSource(code, rel);
  if (r.parseError) { loadScanSyntaxFail.push(`${rel} :: ${r.parseError}`); continue; }
  for (const h of r.hits) loadScanHits.push({ file: rel, line: h.line, column: h.column, name: h.name });
}
const loadScanMs = Date.now() - loadScanT0;
ok(`L-04 全量普查 HEAD 门体族加载面：枚举 ${loadScanFiles.length} 支、实扫 ${loadScanned} 支（取数失败 ${loadScanReadFail.length}、语法层 ${loadScanSyntaxFail.length}），未定义标识符命中 ${loadScanHits.length} 处——本判据的红只会来自「真用了没解析到的名字」，并发工作树不参与（耗时 ${loadScanMs}ms，本门因此从秒级变为分钟级，读数写进标签供人看趋势）`,
  loadScanFiles.length > 0 && loadScanned === loadScanFiles.length && loadScanHits.length === 0,
  { 命中: loadScanHits.slice(0, 20), 取数失败: loadScanReadFail.slice(0, 10), 语法层: loadScanSyntaxFail.slice(0, 10) });

lines.push('');
lines.push(`[census] 加载面普查（批㉝/T02770）：扫 ${loadScanned} 支（verify-* + lib/*，取数面 HEAD），未定义标识符 ${loadScanHits.length} 处，耗时 ${loadScanMs}ms；夹具双向 ${LOAD_CASES.length - loadCaseBad.length}/${LOAD_CASES.length}，真实门体变异命中 ${realMut ? `${realMut.name}（第 ${realMut.tried}/${realCands.length} 个候选）` : '未命中'}`);
lines.push(loadScanHits.length
  ? loadScanHits.map((h) => `  - ${h.file}:${h.line}:${h.column} ${h.name}`).join('\n')
  : '  （无——含批㉛ 那次事故在内的门体族，当前 HEAD 全量干净）');

// —— census 留痕（不进成败判定，反模式 37 的留痕道）：批㉗ 的教训是「普查必须按 HEAD 实测定量报数，
// 沿用上一批的定性条数会让残留清单虚高、下一批入口选错」。本门即定量口径的唯一出处。
lines.push('');
lines.push(`[census] 枚举 JS 系门体 ${gateFiles.length} 支，其中带可静态判定源码守卫的 ${guardGates.length} 支：`);
lines.push(guardGates.map((g) => `  - ${g}：锚点 ${all.filter((a) => a.gate === g).length} 条（反向 ${all.filter((a) => a.gate === g && a.neg).length}）`).join('\n'));
lines.push(`[census] 当前恒假锚点 ${zeroHits.length} 条（已登记基线 ${KNOWN_SIG.size} 条）：`);
lines.push(zeroHits.length ? zeroHits.map((a) => `  - ${a.gate}:${a.line} [${a.file}] ${a.anchor}`).join('\n') : '  （无）');
lines.push(`[census] 取了源码却一条静态可判定的守卫锚点都没抽出（本审计的盲区：helper 拼路径、判据只落在渲染产物/HTTP 响应上、或纯 prose 提到 readFileSync）的 verify-* 门 ${INDIRECT_GATES.length} 支：`);
lines.push(INDIRECT_GATES.length
  ? [...INDIRECT_GATES.slice(0, 60).map((g) => `  - ${g}`), ...(INDIRECT_GATES.length > 60 ? [`  （其余 ${INDIRECT_GATES.length - 60} 支从略）`] : [])].join('\n')
  : '  （无）');

writeGateResults(OUT_DIR, 't02205-gate-results.txt', [`T02205 源码守卫自证门：PASS=${pass} FAIL=${fail}`, ...lines].join('\n'));
console.log(`T02205 源码守卫自证门：PASS=${pass} FAIL=${fail}`);
for (const l of lines) console.log(l);
process.exit(fail > 0 ? 1 : 0);
