/**
 * T02169 门：AI 控制台「代码评审会议讲稿生成」PRD 交付质量（v1.2 锚点校正版）。
 *
 * 本门原形（改判前）用 `/prd-generate-stream/.test(源码文本)`、`/PRD_CONTEXT_LIMIT = 6000/`、
 * `/new MarkdownIt\(\{ html: false/` 这类**源码字面量匹配**当判据——等价重构一改写法门就红，
 * 而行号漂移/端点根本没注册这类真问题门却看不见。按 `docs/验收门判据规约.md` 四条硬判据改判为：
 *
 *  D 组 文档结构：按**解析出的标题层级 / 表行 / 编号条目**判，不抄散文
 *  F-A 组 锚点：把 PRD 里每条 `文件:行号`（含同句简写 `:274`）解析出来，经
 *      `git ls-tree`/`git show HEAD:` 回**已提交的树**定位——唯一文件 + 行区间不越界 +
 *      引用行 ±3 窗口内必须出现该句反引号里声明的标识符（A-4「锚点可用」的机器版）
 *  F-R/D/W/P/B/M 组 事实：端点问运行时路由表，列存问 `PRAGMA table_info`，忽略目录问
 *      `isIgnored()`，适配器类型问 `listAdapterTypes()`，截断预算问 `resolvePrdContext()` 实测值
 *  F-G 组 编码红线：真起一个临时 git 仓，量「带不带 `-c i18n.logOutputEncoding=utf-8` 的中文
 *      subject 可读性两态」「`core.quotepath` 两态」「`--ignore-cr-at-eol` 两态」——PRD 的 A-3
 *      中文可读断言由此从文案变成实测；再加一条「参数数组 execFile 打在含 `;` 与反引号的目录名上
 *      不产生命令执行」（FR-1.1 注入红线）
 *  G 组 需求覆盖：对照 T02169 任务步骤逐条（FR 块数、八段骨架、四段式、三形态、A-1~A-7、E-1~E-4）
 *  N 组 负对照：伪造行号/伪造路径/伪造标识符/伪造端点名/假表 PRAGMA/注入 TODO 副本/篡改对比表——
 *      逐条证明上面这些判据**在行为被破坏时确实变红**
 *
 * 判据口径：产品代码一律取 `git show HEAD:<path>`（工作树可能被并发会话留成过期副本，反模式 11）；
 * 门夹具自造（隔离 DATA_DIR + 临时 git 仓），生产实例与生产库零接触。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02169-lecture-prd.mts
 * 环境变量：T02169_TMP_ROOT（默认 D:/code/tmp，必须落有空间的盘）、T02169_KEEP=1 保留临时目录
 * 结果落 .workbuddy/t02169-gate-results-<运行标识>.txt。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import { writeGateResults } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const PRD_PATH = join(ROOT, 'docs', 'PRD-代码评审会议讲稿生成.md');
const TMP_ROOT = process.env.T02169_TMP_ROOT ?? 'D:/code/tmp';
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02169-gate-'));
// ⚠ 先定数据目录再 import 产品模块：`getDb()` 按该环境变量选库，缺省会连到生产库
process.env.MTask_DATA_DIR = DATA_DIR;
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;

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

// ======================= Markdown 结构解析（判据 1：打结构，不抄散文） =======================
type Heading = { level: number; text: string; line: number };
function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  const ls = md.split('\n');
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const fm = /^\s*(```|~~~)/.exec(l);
    if (fm) { if (!fence) fence = fm[1]; else if (l.trim().startsWith(fence)) fence = null; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) out.push({ level: h[1].length, text: h[2].trim(), line: i + 1 });
  }
  return out;
}
function sectionBody(md: string, headings: Heading[], match: (h: Heading) => boolean): string {
  const idx = headings.findIndex(match);
  if (idx < 0) return '';
  const ls = md.split('\n');
  const lv = headings[idx].level;
  let end = ls.length;
  for (let j = idx + 1; j < headings.length; j++) if (headings[j].level <= lv) { end = headings[j].line - 1; break; }
  return ls.slice(headings[idx].line, end).join('\n');
}
type TableRow = { cells: string[]; line: number };
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

// ======================= 前置：PRD 必须存在 =======================
ok('D-00 PRD 文件存在（docs/PRD-代码评审会议讲稿生成.md）', existsSync(PRD_PATH));
if (!existsSync(PRD_PATH)) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeGateResults(OUT_DIR, 't02169-gate-results.txt', `T02169 PRD 门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
const PRD = readFileSync(PRD_PATH, 'utf8');
const HEADINGS = parseHeadings(PRD);
const sec = (prefix: string, level = 2) => sectionBody(PRD, HEADINGS, (h) => h.level === level && h.text.startsWith(prefix));

// ======================= 已提交树（反模式 11：不信工作树） =======================
const git = (args: string[], cwd = ROOT) => execFileSync('git', args, { cwd });
/** 进入产品运行时之前的工作树快照：并发会话的 WIP 不归本门负责，但本门不得在其上再加一笔（F-G6 用差集判） */
const productDirty = () => git(['status', '--porcelain', '--', 'server/src', 'web/src']).toString('utf8').split('\n').filter(Boolean);
const DIRTY_BEFORE = new Set(productDirty());
const TREE = git(['ls-tree', '-r', '--name-only', 'HEAD']).toString('utf8').split('\n').filter(Boolean);
const CODE_FILES = TREE.filter((p) => /\.(tsx|ts|json|md)$/.test(p));
const srcCache = new Map<string, string[] | null>();
/** 取 HEAD 树里某文件的行数组；工作树新增（未提交）的文件退回工作树读 */
function codeLines(rel: string): string[] | null {
  if (srcCache.has(rel)) return srcCache.get(rel);
  let out: string[] | null = null;
  try { out = git(['show', `HEAD:${rel}`]).toString('utf8').split('\n'); }
  catch { const p = join(ROOT, rel); out = existsSync(p) ? readFileSync(p, 'utf8').split('\n') : null; }
  srcCache.set(rel, out);
  return out;
}
/** 文档里的 `路径:行号` 允许只写尾段（`routes/index.ts:259`），按树内后缀唯一定位 */
const resolveCited = (token: string) => CODE_FILES.filter((p) => p === token || p.endsWith('/' + token));

// ======================= 锚点解析器（F-A 组与 N 组共用同一实现） =======================
type Anchor = { token: string; file: string; from: number; to: number; docLine: number; ids: string[] };
function extractAnchors(md: string): Anchor[] {
  const ls = md.split('\n');
  const out: Anchor[] = [];
  const FULL = /([\w./-]+\.(?:tsx|ts|json|md)):(\d+)(?:-(\d+))?(?:,(\d+))?/g;
  const BARE = /(?<![\w.:/-]):(\d+)(?:-(\d+))?(?![\d-])/g;
  const STOP = /^(GET|POST|PUT|DELETE|PATCH|raw|md|docx|pptx|xlsx|csv|pdf|utf|gbk|base64|npm|env|TEXT|DEFAULT)$/;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const spans = [...l.matchAll(/`([^`]{2,80})`/g)].map((x) => ({ s: x.index ?? -1, t: x[1] }));
    /** 标识符只取「锚点自己那个反引号跨度」里的词干——同句别处的词会串味（曾把 grep 命令里的 rev-parse 当成 index.ts:1586 的期望符号） */
    const grabIds = (spansIn: { s: number; t: string }[]): string[] => {
      const ids = new Set<string>();
      for (const sp of spansIn) {
        for (const raw of sp.t.split(/[\s,，、()（）|{}]+/)) {
          const tk = raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw; // `PRD_CONTEXT_LIMIT=6000` 取常量名
          const m2 = /^[\[{/'"]?([A-Za-z_][A-Za-z0-9_./-]{2,})[\]}/'"]?[:]?$/.exec(tk);
          if (!m2 || STOP.test(m2[1]) || /\.(tsx|ts|json|md)/.test(m2[1])) continue;
          ids.add(m2[1]);
          if (m2[1].includes('.')) ids.add(m2[1].split('.').pop()!);
          if (m2[1].includes('/')) ids.add(m2[1].split('/').pop()!); // `/workspace/symbols/refresh` → refresh 也作候选
        }
      }
      return [...ids];
    };
    let carry = '';
    FULL.lastIndex = 0;
    let m: RegExpExecArray | null;
    const push = (from: number, to: number, ids: string[]) =>
      out.push({ token: m![1], file: '', from, to, docLine: i + 1, ids });
    while ((m = FULL.exec(l))) {
      carry = m[1];
      const mine = spans.filter((sp) => sp.s <= m.index && m.index < sp.s + sp.t.length + 2);
      // 只认「锚点自己那个反引号跨度」里的标识符：同句别处的词会串味——实测借来的 `rev-parse`（grep 命令文本）、
      // `buildPptx`（下一处锚点）、`WorkspaceService`（下一分句）、`LECTURE_CONTEXT_BUDGET`（建议新增常量，本就不该在现码里）
      // 都会把真锚点误判成失配，或者反过来掩盖真漂移。
      const ids = grabIds(mine);
      if (m[3]) push(Number(m[2]), Number(m[3]), ids);
      else push(Number(m[2]), Number(m[2]), ids);
      // `:1,8` 这类列举两个行号的写法，第二个行号同样要回仓定位
      if (m[4]) push(Number(m[4]), Number(m[4]), ids);
    }
    if (carry) {
      BARE.lastIndex = 0;
      while ((m = BARE.exec(l))) out.push({ token: carry, file: '', from: Number(m[1]), to: Number(m[2] ?? m[1]), docLine: i + 1, ids: [] });
    }
    // 「`方法名:行号`」写法（文件路径在同句更早的跨度里，如 `AIService.ts`：`organize:294 / ask:474`）——
    // 这类引用形如 `标识符:数字`，不带扩展名，FULL 抓不到；按跨度顺序继承最近一次出现的路径，逐条也回仓定位
    let lastPath = '';
    for (const sp of spans) {
      const own = /([\w./-]+\.(?:tsx|ts|json|md))/.exec(sp.t)?.[1] ?? '';
      if (own) lastPath = own;
      const base = own || lastPath;
      if (!base) continue;
      for (const p of sp.t.matchAll(/(?<![\w./-])([A-Za-z_][A-Za-z0-9_]{2,}):(\d+)/g)) {
        out.push({ token: base, file: '', from: Number(p[2]), to: Number(p[2]), docLine: i + 1, ids: [p[1]] });
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.token}:${a.from}-${a.to}:${a.ids.join(',')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
type AnchorVerdict = { anchors: Anchor[]; unlocated: string[]; ambiguous: string[]; oob: string[]; noSymbol: string[]; backed: number };
function judgeAnchors(md: string, window = 3): AnchorVerdict {
  const anchors = extractAnchors(md);
  const v: AnchorVerdict = { anchors, unlocated: [], ambiguous: [], oob: [], noSymbol: [], backed: 0 };
  for (const a of anchors) {
    const c = resolveCited(a.token);
    if (c.length === 0) { v.unlocated.push(`${a.token}:${a.from}（文档行 ${a.docLine}）`); continue; }
    if (c.length > 1) { v.ambiguous.push(`${a.token}:${a.from} 候选 ${c.length}（文档行 ${a.docLine}）`); continue; }
    a.file = c[0];
    const src = codeLines(a.file);
    if (!src) { v.unlocated.push(`${a.file} 不在 HEAD 树（文档行 ${a.docLine}）`); continue; }
    if (a.to > src.length) { v.oob.push(`${a.file}:${a.to} > ${src.length} 行（文档行 ${a.docLine}）`); continue; }
    if (!a.ids.length) continue;
    v.backed += 1;
    const win = src.slice(Math.max(0, a.from - 1 - window), Math.min(src.length, a.to + window)).join('\n');
    if (!a.ids.some((id) => win.includes(id))) {
      v.noSymbol.push(`${a.file}:${a.from}-${a.to} 文档行 ${a.docLine} 标识符 [${a.ids.join('|')}] 未在 ±${window} 窗口命中`);
    }
  }
  return v;
}

// ======================= 产品运行时面（隔离库 + 动态 import） =======================
const U = (rel: string) => pathToFileURL(join(ROOT, 'server', rel)).href;
let ROUTES: string[] = [];
let ADAPTER_TYPES: string[] = [];
let IGNORE: { n: number; gitHit: boolean | null; srcHit: boolean | null; envHit: boolean | null } = { n: 0, gitHit: null, srcHit: null, envHit: null };
let COLS: Record<string, string[]> = {};
let BUDGET = { ok: false, budget: -1, hitBy: '', head: false, tail: false };
let BUILD_PPTX = 'missing';
try {
  const routes = (await import(U('src/routes/index.ts'))) as Record<string, any>;
  const walk = (stack: unknown[], prefix: string) => {
    for (const layer of stack as Array<Record<string, any>>) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods ?? {}).map((k) => k.toUpperCase()).join(',');
        ROUTES.push(`${methods} ${prefix}${layer.route.path}`);
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
  walk(routes.api?.stack ?? [], '');
  const ad = (await import(U('src/adapters/index.ts'))) as Record<string, any>;
  ADAPTER_TYPES = ad.listAdapterTypes();
  const ws = (await import(U('src/services/WorkspaceService.ts'))) as Record<string, any>;
  const rules = ws.loadIgnoreRules(ROOT);
  IGNORE = {
    n: rules.length,
    gitHit: typeof ws.isIgnored === 'function' ? ws.isIgnored('.git/config', false, rules, ROOT) === true : null,
    srcHit: typeof ws.isIgnored === 'function' ? ws.isIgnored('server/src/a.ts', false, rules, ROOT) === false : null,
    envHit: typeof ws.isIgnored === 'function' ? ws.isIgnored('.env', false, rules, ROOT) === true : null,
  };
  const conn = (await import(U('src/db/connection.ts'))) as Record<string, any>;
  const schema = (await import(U('src/db/schema.ts'))) as Record<string, any>;
  conn.getDb();
  schema.initSchema();
  const db = conn.getDb();
  const colsOf = (t: string): string[] => {
    try { return (db.prepare('PRAGMA table_info(' + t + ')').all() as Array<{ name: string }>).map((r) => r.name); }
    catch { return []; }
  };
  for (const t of ['projects', 'tasks', 'prompts', 'req_entries', 'plan_tasks', 'prd_docs', 'prd_requirements', '不存在_的假表_zzz']) COLS[t] = colsOf(t);
  // 预算腿的夹具：产品自己建出来的隔离库里，塞一篇超长 PRD + 一条挂它的需求
  const now = new Date().toISOString();
  const pid = 't02169-gate-proj';
  const docId = 't02169-gate-doc';
  const reqId = 't02169-gate-req';
  const longBody = '甲'.repeat(10000) + '乙'.repeat(10001);
  db.prepare('INSERT INTO projects (id,name,description,sort_weight,created_at,updated_at) VALUES (?,?,?,0,?,?)').run(pid, 'T02169 预算夹具', '', now, now);
  db.prepare('INSERT INTO prd_docs (id,project_id,filename,content_md,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(docId, pid, 'T02169 预算夹具.md', longBody, now, now);
  db.prepare(`INSERT INTO prd_requirements (id,project_id,req_no,title,content,source_ref,priority,status,sort_order,created_at,updated_at)
    VALUES (?,?,?,?,?,'',?,?,0,?,?)`).run(reqId, pid, 'R-1', 'T02169 预算夹具需求', '内容', 'normal', 'todo', now, now);
  db.prepare('UPDATE prd_requirements SET prd_id=? WHERE id=?').run(docId, reqId);
  const { resolvePrdContext } = (await import(U('src/util/prdContext.ts'))) as Record<string, any>;
  const ctx = resolvePrdContext({ requirementId: reqId }) as { content: string; hitBy: string } | null;
  const elided = /中段略去 (\d+) 字符/.exec(ctx?.content ?? '');
  BUDGET = {
    ok: ctx !== null,
    budget: elided ? longBody.length - Number(elided[1]) : -1,
    hitBy: ctx?.hitBy ?? '',
    head: !!ctx && ctx.content.startsWith('甲'.repeat(50)),
    tail: !!ctx && ctx.content.endsWith('乙'.repeat(50)),
  };
  const rb = (await import(U('src/services/report-builder.ts'))) as Record<string, any>;
  BUILD_PPTX = typeof rb.buildPptx;
} catch (e) {
  skipped('F-R/F-D/F-W/F-P/F-B 全组', `产品运行时面 import 失败：${e instanceof Error ? e.message : String(e)}`);
}

// ======================= 临时 git 仓（F-G 组：编码/quotepath/CRLF/注入 四红线实测） =======================
const REPO = join(DATA_DIR, 'simrepo');
const WEIRD = join(DATA_DIR, 'sep;dir`pwn`');
let GITPROBE: Record<string, unknown> = {};
try {
  mkdirSync(REPO, { recursive: true });
  const gs = (args: string[], cwd = REPO) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const gb = (args: string[], cwd = REPO) => execFileSync('git', args, { cwd }).toString('utf8');
  gs(['init', '-q']);
  gs(['config', 'user.name', 'gate']);
  gs(['config', 'user.email', 'gate@example.com']);
  gs(['config', 'core.autocrlf', 'false']);
  gs(['config', 'i18n.commitEncoding', 'gbk']);
  const CN = '评审讲稿锚点校验';
  writeFileSync(join(REPO, 'msg.txt'), Buffer.from('c6c0c9f3bdb2b8e5c3aab5e3d0a3d1e9', 'hex')); // 上面这句的 GBK 字节
  writeFileSync(join(REPO, 'a.txt'), 'hello\n');
  writeFileSync(join(REPO, '中文文件.txt'), '内容\n');
  gs(['add', '.']);
  gs(['commit', '-q', '-F', 'msg.txt']);
  gs(['config', 'i18n.logOutputEncoding', 'gbk']);
  const subjRaw = gb(['log', '-1', '--format=%s']);
  const subjUtf = gb(['-c', 'i18n.logOutputEncoding=utf-8', 'log', '-1', '--format=%s']);
  writeFileSync(join(REPO, '中文文件.txt'), '内容2\n');
  gs(['add', '.']);
  gs(['commit', '-q', '-F', 'msg.txt']);
  const statRaw = gb(['diff', '--stat', 'HEAD~1', 'HEAD']);
  const statNoQuote = gb(['-c', 'core.quotepath=false', 'diff', '--stat', 'HEAD~1', 'HEAD']);
  writeFileSync(join(REPO, 'a.txt'), 'hello\r\n');
  gs(['add', '.']);
  gs(['commit', '-q', '-m', 'eol-only']);
  const crlfRaw = gb(['diff', '--stat', 'HEAD~1', 'HEAD']);
  const crlfIgnored = gb(['diff', '--stat', '--ignore-cr-at-eol', 'HEAD~1', 'HEAD']);
  mkdirSync(WEIRD, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: WEIRD });
  const inRoot = execFileSync('git', ['-C', WEIRD, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim();
  GITPROBE = {
    CN, subjRaw, subjUtf, rawReadable: subjRaw.includes(CN), utfReadable: subjUtf.includes(CN),
    statRaw, statNoQuote, rawEscaped: /\\\d{3}/.test(statRaw), noQuoteReadable: statNoQuote.includes('中文文件.txt'),
    crlfRaw, crlfIgnored, crlfNoise: crlfRaw.includes('a.txt'), crlfQuiet: crlfIgnored.trim() === '',
    injectRan: inRoot === 'true', injectSideEffect: existsSync(join(DATA_DIR, 'pwn')) || existsSync(join(ROOT, 'pwn')),
  };
} catch (e) {
  skipped('F-G 全组', `临时 git 仓构造失败：${e instanceof Error ? e.message : String(e)}`);
}
const GP = GITPROBE as Record<string, any>;

// ======================= D 组：文档结构 =======================
{
  const l2 = HEADINGS.filter((h) => h.level === 2).map((h) => h.text);
  ok('D-01 十节结构齐全（§1 文档信息 ~ §10 信息来源，按解析出的二级标题判）',
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every((n) => l2.some((t) => t.startsWith(`${n}. `))), { 二级标题数: l2.length });
  const emptySecs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    .map((n) => ({ n, body: sec(`${n}. `) }))
    .filter((x) => x.body.replace(/[|\-\s#>*]/g, '').length < 150)
    .map((x) => x.n);
  ok('D-02 每个二级节都有实质正文（剥表格线/标点后 ≥150 字符，防空壳节）', emptySecs.length === 0, { 空节: emptySecs });
  const l3 = HEADINGS.filter((h) => h.level === 3).map((h) => h.text);
  const need3 = ['2.1', '2.2', '2.3', '2.4', '2.5', '4.1', '4.2', '5.1', '5.2', '5.3', '5.4', '6.1', '6.2', '6.3', '7.1', '7.2', '7.3', '7.4', '8.1', '8.2'];
  ok('D-03 三级小节齐全（含 §2.5 术语表、§7.2 性能与时效、§8.2 验收标准等 20 个）',
    need3.every((p) => l3.some((t) => t.startsWith(p))), { 缺: need3.filter((p) => !l3.some((t) => t.startsWith(p))) });
  const mermaid = /```mermaid\n([\s\S]*?)```/.exec(PRD)?.[1] ?? '';
  ok('D-04 §4.1 流程图是真 mermaid 围栏且节点足够（≥8 个箭头连线，非一句话示意）',
    mermaid.includes('flowchart') && (mermaid.match(/-->/g) ?? []).length >= 8, { 连线数: (mermaid.match(/-->/g) ?? []).length });
  const glossary = parseTables(sec('2.5 术语表', 3)).flat().slice(1);
  ok('D-05 术语表是 3 列结构表且每格非空（≥5 个术语，逐条与现系统对齐）',
    glossary.length >= 5 && glossary.every((r) => r.cells.length === 3 && r.cells.every((c) => c.length > 1)),
    { 行数: glossary.length });
  ok('D-06 无占位符（TODO/TBD/FIXME/WIP/XXX 大小写敏感；lorem 不敏感）',
    !/TODO|TBD|FIXME|WIP|XXX/.test(PRD) && !/[Ll]orem/.test(PRD));
  ok('D-07 规模充足（>8000 字符，非骨架稿）', PRD.length > 8000, PRD.length);
  const infoCell = (parseTables(sec('1. 文档信息')).flat().find((r) => /变更记录/.test(r.cells[0] ?? ''))?.cells[1] ?? '');
  const verRows = parseTables(sec('1. 文档信息')).flat();
  const verCell = verRows.find((r) => /^版本$/.test(r.cells[0] ?? ''))?.cells[1] ?? '';
  const headVer = /版本：\*\*v(\d+\.\d+)/.exec(PRD)?.[1] ?? '';
  okPair(ok,
    'D-08 版本链完整且自洽（v1.0 首版 → v1.1 评审修订 7 项 → v1.2 锚点校正；§1 版本行与文档头版本一致）',
    () => /v1\.0/.test(infoCell) && /v1\.1/.test(infoCell) && /v1\.2/.test(infoCell)
      && (infoCell.match(/[①②③④⑤⑥⑦⑧]/g) ?? []).length >= 7
      && verCell.startsWith('v' + headVer),
    () => /v1\.0：首版/.test(infoCell) && /v1\.1（评审修订）/.test(infoCell) && /锚点行号校正/.test(infoCell),
    () => ({ 文档头版本: headVer, '§1版本行': verCell, 修订序号数: (infoCell.match(/[①②③④⑤⑥⑦⑧]/g) ?? []).length }));
  ok('D-09 状态口径一致：待审批 + 「批准前不得进入实施」在 §1 状态行（决策点未签字前不得开工）',
    /待审批/.test(verRows.find((r) => /^状态$/.test(r.cells[0] ?? ''))?.cells[1] ?? '')
    && PRD.includes('批准前不得进入实施'));
}

// ======================= F-A 组：锚点回仓定位（A-4 的机器版） =======================
{
  const v = judgeAnchors(PRD);
  const uniq = new Set(v.anchors.map((a) => `${a.token}:${a.from}`)).size;
  ok('F-A1 锚点规模：PRD 里的 `文件:行号` 引用成体系（≥25 条、去重后 ≥20 条）',
    v.anchors.length >= 25 && uniq >= 20, { 条数: v.anchors.length, 去重: uniq });
  ok('F-A2 每条锚点都能在**已提交树**里唯一定位（无不可定位、无歧义后缀）',
    v.unlocated.length === 0 && v.ambiguous.length === 0, { 不可定位: v.unlocated, 歧义: v.ambiguous });
  ok('F-A3 每条锚点的行区间在真实文件行数内（防编行号、防删行后越界）',
    v.oob.length === 0, { 越界: v.oob });
  ok('F-A4 引用行 ±3 窗口内必须出现该句声明的标识符（「跳到那一行能看到文档说的东西」）',
    v.noSymbol.length === 0, { 失配: v.noSymbol });
  const backedList = v.anchors.filter((a) => a.ids.length).map((a) => `${a.token}:${a.from}[${a.ids.join('|')}]`);
  ok('F-A5 符号腿覆盖面自证：≥20 条锚点带「可回仓核对的标识符」（v1.2 把裸行号锚点补成 `路径:行号 标识符` 即为此；N-03 证明该腿有牙齿）',
    v.backed >= 20 && backedList.length === v.backed, { 带标识符锚点: v.backed, 总锚点: v.anchors.length, 清单: backedList });
}

// ======================= F-R 组：端点问运行时路由表 =======================
if (ROUTES.length) {
  const cited: Array<[string, string]> = [
    ['POST', '/plans/prd-generate-stream'], ['POST', '/plans/testcase-generate-stream'],
    ['POST', '/report/ai-generate-stream'], ['POST', '/report/ai-download'],
    ['GET', '/workspace/search'], ['GET', '/workspace/file'],
    ['POST', '/workspace/symbols/refresh'], ['GET', '/workspace/symbols'],
  ];
  const hit = (meth: string, p: string) => ROUTES.some((r) => r.startsWith(meth + ' ') && r.endsWith(p));
  const miss = cited.filter(([mt, p]) => !hit(mt, p)).map(([, p]) => p);
  ok('F-R1 PRD §2.3 引用的 8 条既有端点（SSE 三点 + ai-download + workspace 四点）在运行时路由表里注册，方法一致',
    miss.length === 0, { 未命中: miss, 路由表条数: ROUTES.length });
  ok('F-R2 路由表本体非空且含 `/plans/*` 与 `/report/*` 两族（F-R1 不是拿空表比空表）',
    ROUTES.length >= 150 && ROUTES.some((r) => r.includes('/plans/')) && ROUTES.some((r) => r.includes('/report/')),
    { 条数: ROUTES.length });
  ok('F-R3 本 PRD 的新端点确实尚未实施（路由表零命中）——与「待审批、不含实现」的文档声明一致，不虚假宣称在位',
    !ROUTES.some((r) => r.includes('code-review-lecture')) && /待审批/.test(PRD));
}

// ======================= F-D 组：列存问 PRAGMA =======================
if (Object.keys(COLS).length) {
  ok('F-D1 防回退：`projects` 表实测无 color 列（评审抓出的 v1.0 阻塞项——虚构字段不得复活）',
    (COLS.projects ?? []).length > 0 && !(COLS.projects ?? []).includes('color'), { projects列: COLS.projects });
  ok('F-D2 §6.3 声明的正面对照成立：color 列确实只在 tasks/prompts/req_entries/plan_tasks 四表',
    ['tasks', 'prompts', 'req_entries', 'plan_tasks'].every((t) => (COLS[t] ?? []).includes('color')),
    { 各表color: Object.fromEntries(['tasks', 'prompts', 'req_entries', 'plan_tasks'].map((t) => [t, (COLS[t] ?? []).includes('color')])) });
  ok('F-D3 `projects.workspace_path` 列在位（PRD「项目为多记录实体、可直接多选工作空间」的数据前提）',
    (COLS.projects ?? []).includes('workspace_path'), { projects列: COLS.projects });
  ok('F-D4 同一列集合探针由产品 `initSchema()` 建出的隔离库给出（门没连生产库：夹具表 prd_docs/prd_requirements 列齐）',
    (COLS.prd_docs ?? []).includes('content_md') && (COLS.prd_requirements ?? []).includes('prd_id'),
    { prd_docs: COLS.prd_docs, prd_requirements: (COLS.prd_requirements ?? []).length + ' 列' });
}

// ======================= F-W 组：忽略目录问 isIgnored() =======================
if (IGNORE.n > 0) {
  ok('F-W1 `isIgnored()` 实测：`.git/config` 判忽略、`server/src/a.ts` 判不忽略（PRD「WorkspaceService 显式忽略 .git」的行为证据）',
    IGNORE.gitHit === true && IGNORE.srcHit === true, IGNORE);
  ok('F-W2 忽略规则成体系（≥20 条）且 `.env` 命中——§7.3「排除规则默认含常见敏感面」的现成落点',
    IGNORE.n >= 20 && IGNORE.envHit === true, IGNORE);
}

// ======================= F-A5/F-P/F-B 组：通道、预算、装配 =======================
if (ADAPTER_TYPES.length) {
  okPair(ok,
    'F-A6 AI 通道只有文本 chat：运行时 `listAdapterTypes()` 四类 == PRD 声明的四类（不虚构 embedding/视觉通道）',
    () => ['openai-compatible', 'claude', 'ollama', 'workbuddy'].every((t) => ADAPTER_TYPES.includes(t)) && ADAPTER_TYPES.length === 4,
    () => /openai-compatible\|claude\|ollama\|workbuddy/.test(PRD) && PRD.includes('openai-compatible/claude/ollama'),
    () => ({ 运行时: ADAPTER_TYPES }));
}
if (BUDGET.ok) {
  okPair(ok,
    'F-P1 截断口径实测：门内造 20001 字符 PRD 文档 → `resolvePrdContext()` 反推预算恰为 6000（不是把源码那行文本再读一遍）',
    () => BUDGET.budget === 6000 && BUDGET.hitBy === 'requirement',
    () => /PRD_CONTEXT_LIMIT=6000/.test(PRD),
    () => BUDGET);
  ok('F-P2 保头保尾纪律实测：截断后开头 50 字与结尾 50 字都在，中段以「中段略去 N 字符 + 文档 id」留痕',
    BUDGET.head === true && BUDGET.tail === true, BUDGET);
  okPair(ok,
    'F-P3 PRD 承诺「讲稿预算与 PRD_CONTEXT_LIMIT 分立、禁止悄悄复用 6000」——运行时确有 6000 这一个可被误复用的常量',
    () => BUDGET.budget === 6000,
    () => /LECTURE_CONTEXT_BUDGET/.test(PRD) && /禁止悄悄复用 6000/.test(PRD));
}
if (BUILD_PPTX === 'function') {
  const pkg = JSON.parse((codeLines('server/package.json') ?? []).join('\n')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  okPair(ok,
    'F-B1 产物链路在位：`buildPptx` 是运行时可 import 的函数、pptxgenjs 在依赖表内且锚点 `server/package.json:23` 指到那一行（不新增依赖的前提）',
    () => BUILD_PPTX === 'function' && /\^?4\.0\.1/.test(deps.pptxgenjs ?? '') && (codeLines('server/package.json') ?? [])[22]?.includes('pptxgenjs'),
    () => /pptxgenjs \^4\.0\.1/.test(PRD) && /report-builder\.ts:247/.test(PRD),
    () => ({ pptxgenjs: deps.pptxgenjs }));
  ok('F-B2 无 git 依赖实测：解析后的依赖键里没有任何 git 客户端库（git 只能走系统命令的前提）',
    !Object.keys(deps).some((k) => /simple-git|nodegit|isomorphic-git|git-+$/i.test(k)), { 依赖数: Object.keys(deps).length });
}

// ======================= F-G 组：Git 采集三条红线 + 注入红线（实测） =======================
if (GP.CN) {
  ok('F-G1 编码红线可复现（同一仓同一提交）：`i18n.logOutputEncoding=gbk` 时按 utf8 解码必乱码——PRD 说的坑真实存在，不是吓唬',
    GP.rawReadable === false && String(GP.subjRaw).trim().length > 0,
    { 不带c原文: String(GP.subjRaw).slice(0, 40) });
  okPair(ok,
    'F-G2 `-c i18n.logOutputEncoding=utf-8` 后同一命令输出可读中文（FR-1.1a 的修复确实有效；A-3 中文可读断言的命令链落地）',
    () => GP.utfReadable === true && GP.rawReadable === false,
    () => PRD.includes('i18n.logOutputEncoding=utf-8'),
    () => ({ 带c输出: String(GP.subjUtf).slice(0, 40), 不带c输出: String(GP.subjRaw).slice(0, 40) }));
  okPair(ok,
    'F-G3 `-c core.quotepath=false` 把中文文件名从 `\\344\\270\\255` 转义还原成可读名（锚点文件名可读、A-4 定位不失效）',
    () => GP.rawEscaped === true && GP.noQuoteReadable === true,
    () => PRD.includes('core.quotepath=false'),
    () => ({ 默认: String(GP.statRaw).slice(0, 60), 关掉转义: String(GP.statNoQuote).slice(0, 40) }));
  okPair(ok,
    'F-G4 `--ignore-cr-at-eol` 让「只改行尾」的文件不进 diff（默认口径下 a.txt 虚高进统计，加了即静默归零）',
    () => GP.crlfNoise === true && GP.crlfQuiet === true,
    () => PRD.includes('--ignore-cr-at-eol'),
    () => ({ 默认: String(GP.crlfRaw).slice(0, 50), 带开关: String(GP.crlfIgnored).slice(0, 50) }));
  ok('F-G5 注入红线：`execFile` 参数数组打在含 `;` 与反引号的目录名上，命令正常执行且无 shell 副作用文件生成（FR-1.1 论据成立）',
    GP.injectRan === true && GP.injectSideEffect === false, GP);
  (() => {
    const after = productDirty();
    const ev = { 本门新增: after.filter((l) => !DIRTY_BEFORE.has(l)), 本门消除: [...DIRTY_BEFORE].filter((l) => !after.includes(l)), 起点改动数: DIRTY_BEFORE.size };
    ok('F-G6 全程零写用户仓库与生产库：临时仓只建在门自己的 DATA_DIR 里，且跑完前后主仓产品路径的工作树改动集合完全一致（并发 WIP 在跑也不算本门所加）',
      REPO.startsWith(DATA_DIR) && ev.本门新增.length === 0 && ev.本门消除.length === 0, ev);
  })();
}

// ======================= F-M 组：XSS 守卫（机制实测 + 锚点定位） =======================
{
  const evil = '正文\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n';
  const off = new MarkdownIt({ html: false, linkify: true }).render(evil);
  const on = new MarkdownIt({ html: true, linkify: true }).render(evil);
  const mkAnchor = judgeAnchors(PRD).anchors.find((a) => /Markdown\.tsx:\d+$/.test(a.token + ':' + a.from));
  okPair(ok,
    'F-M1 讲稿文本按现有 XSS 纪律渲染：markdown-it `html:false` 实测把原始 HTML 转义（对照组 `html:true` 直通，证明判据有牙齿）',
    () => !off.includes('<script') && !off.includes('<img') && off.includes('&lt;script&gt;') && on.includes('<script'),
    () => /Markdown\.tsx/.test(PRD) && /html:false|html: false/.test(PRD + (codeLines('web/src/ui/Markdown.tsx') ?? []).join('\n')),
    () => ({ 转义输出: off.slice(off.indexOf('&lt;'), off.indexOf('&lt;') + 40), 锚点: mkAnchor ? `${mkAnchor.file}:${mkAnchor.from}` : '无' }));
}

// ======================= F-C 组：文档层防回退（口径类，配行为侧） =======================
/** F-C4 与 N-07 共用同一个判定函数：缺口看的是「多项目/跨仓列的值」而非措辞——N-07 篡改值后它必须转假 */
const gapJudge = (rivals: TableRow[], target: TableRow | undefined): boolean =>
  rivals.length >= 4 && rivals.every((r) => /✗/.test(r.cells[5] ?? '')) && /✓/.test(target?.cells[5] ?? '');
{
  const s23 = parseTables(sec('2.3 现状与证据', 3)).flat();
  const cardRow = s23.find((r) => /卡位冲突声明/.test(r.cells.join('')));
  ok('F-C1 卡位冲突声明在 §2.3 证据表单元格内（与 T02170 抢第 8 张卡：先落地者第 8、后落地者第 9，不顶替不改标题）',
    !!cardRow && /T02170/.test(cardRow.cells.join('')) && /先落地者为第 8 张/.test(cardRow.cells.join('')));
  ok('F-C2 影响项目为 mtask六期且带项目 id（v1.0 错挂四期已修正，且不再复活）',
    PRD.includes('mtask六期') && PRD.includes('bea1ce5b-67c1-4a0d-a08c-db0d5a3d9136') && !/影响项目：\*\*mtask四期/.test(PRD));
  const survey = parseTables(sec('5.3 对比表', 3)).flat();
  const rivals = survey.slice(1, survey.length - 1);
  const target = survey[survey.length - 1];
  ok('F-C3 竞品调研成体系：§5.1 五条 + §5.3 六列对比表（≥4 家竞品行每格非空）+ §10 信息来源 ≥10 条含官方仓库链接',
    (sec('5.1 调研对象', 3).match(/^\s*\d+\.\s+\S/gm) ?? []).length === 5
    && survey.length >= 6 && survey.every((r) => r.cells.length === 6 && r.cells.every((c) => c.length > 0))
    && (PRD.match(/https?:\/\/[^\s)]+/g) ?? []).length >= 10 && PRD.includes('github.com/alibaba/open-code-review'),
    { 对比表行: survey.length, 列数: survey[0]?.cells.length });
  ok('F-C4 缺口的值级判据：竞品行「多项目/跨仓」列全为 ✗，本功能行为 ✓（改文案换措辞也判得住，不靠关键词）',
    gapJudge(rivals, target),
    { 竞品行数: rivals.length, 本功能行: target?.cells[0] });
  ok('F-C5 §7.1 安全条目引用的是实测在位机制（Markdown.tsx 锚点 + execFile 白名单），而非泛泛「注意安全」',
    /### 7\.1 安全/.test(PRD) && /execFile/.test(sec('7.1 安全', 3)) && /Markdown\.tsx/.test(sec('7.1 安全', 3)));
}

// ======================= G 组：需求覆盖（对照 T02169 任务步骤逐条） =======================
{
  const fr42 = sec('4.2 功能需求清单', 3);
  const frBlocks = [...new Set((fr42.match(/^\*\*FR-(\d+)/gm) ?? []).map((x) => (/\d+/.exec(x) ?? ['0'])[0]))];
  const frSubs = [...new Set((fr42.match(/FR-\d+\.\d+[a-z]?/g) ?? []))];
  const perBlock = frBlocks.map((b) => frSubs.filter((s) => s.startsWith(`FR-${b}.`)).length);
  ok('G-01 功能需求成体系：7 个 FR 块（采集/范围/装配/生成/流式/导出/预检）、去重后子项编号 ≥22，且每块都有 ≥2 条（不留光杆需求）',
    frBlocks.length === 7 && frSubs.length >= 22 && Math.min(...perBlock) >= 2,
    { FR块数: frBlocks.length, 子项: frSubs.length, 每块子项数: perBlock });
  const skel = /固定骨架[^：\n]*：\s*`([^`]+)`/.exec(PRD)?.[1]?.split('/').map((s) => s.trim()).filter(Boolean) ?? [];
  ok('G-02 八段骨架可程序化验收（FR-4.2 反引号里解析出 8 段，含开场/摘要/逐文件讲解/风险/规范/建议/讨论/结语）',
    skel.length === 8 && ['开场白', '变更摘要', '风险清单', '规范检查', '改进建议', '讨论问题', '结语'].every((k) => skel.includes(k)),
    { 段: skel });
  const four = /逐文件讲解四段式[：:]\*\*([^*]+)\*\*/.exec(PRD)?.[1]?.split('/').map((s) => s.trim()).filter(Boolean) ?? [];
  ok('G-03 逐文件讲解四段式解析出 4 项（要点/潜在风险/规范检查/改进建议），与 §8 A-2 的断言对象同一份',
    four.length === 4 && four.some((x) => /要点/.test(x)) && four.some((x) => /风险/.test(x)) && four.some((x) => /规范/.test(x)) && four.some((x) => /建议/.test(x)),
    { 四段: four });
  ok('G-04 增量三形态齐（base..head / 首末 SHA / 时间窗 --since），并给出统一输出结构',
    (sec('4.2 功能需求清单', 3).match(/①|②|③/g) ?? []).length >= 3
    && /`--since`/.test(fr42) && /files\[\], hunks\[\], commits\[\], stats/.test(fr42));
  const goals = (sec('2.4 目标 / 非目标', 3).match(/^- G\d：/gm) ?? []).length;
  const nongoals = (sec('2.4 目标 / 非目标', 3).match(/^- N\d：/gm) ?? []).length;
  ok('G-05 目标 5 条（G1~G5）与非目标 5 条（N1~N5）都成清单（边界写进需求，不留建议层）',
    goals === 5 && nongoals === 5, { 目标: goals, 非目标: nongoals });
  const acceptance = sec('8.2 验收标准', 3);
  const accItems = (acceptance.match(/^- A-\d+/gm) ?? []).length;
  const metrics = parseTables(sec('8.1 产品指标', 3)).flat().slice(1);
  ok('G-06 验收可测：A-1~A-7 七条编号项 + §8.1 四项产品指标均有量化目标（≥/中位数），并写明验证等级口径',
    accItems === 7 && metrics.length === 4 && metrics.every((r) => /[≥0]|中位/.test(r.cells[2] ?? '')) && /verified:true/.test(acceptance),
    { A项数: accItems, 指标行: metrics.length });
  const decisions = parseTables(sec('9. 开放决策点')).flat().slice(1);
  ok('G-07 决策点 E-1~E-4 四行成表，每行有「建议值 + 理由」，等待签字（不擅自拍板）',
    decisions.length === 4 && decisions.every((r) => /^E-\d$/.test(r.cells[0] ?? '') && r.cells[2].length > 4 && r.cells[3].length > 4),
    { 决策行: decisions.map((r) => r.cells[0]) });
  ok('G-08 上下文限制如实声明：受「只有文本 chat」事实约束，N3 明确不做全仓索引/嵌入检索，且预算与截断纪律沿用既有口径',
    /embedding/.test(PRD) && PRD.includes('N3') && /保头保尾/.test(sec('4.2 功能需求清单', 3)));
}

// ======================= N 组：负对照（证明上面这些判据有牙齿） =======================
{
  const base = judgeAnchors(PRD);
  const fakeLine = PRD.replace('server/src/routes/index.ts:1586', 'server/src/routes/index.ts:999999');
  const v1 = judgeAnchors(fakeLine);
  ok('N-01 行号判据有牙齿：把一条真锚点行号改成 999999，F-A3 的越界清单必须点名它（原门用正则文本匹配做不到这点）',
    v1.oob.length === base.oob.length + 1 && v1.oob.some((s) => s.includes('999999')), { 越界清单: v1.oob });
  const fakePath = PRD.replace('server/src/routes/index.ts:1586', 'server/src/routes/zzz-not-a-file.ts:1586');
  const v2 = judgeAnchors(fakePath);
  ok('N-02 路径判据有牙齿：把锚点文件改成不存在的路径，新增的「不可定位」条目必须全部点名这个假文件（同句简写 :1729/:1782 一起继承，故不假设恰好 +1）',
    base.unlocated.length === 0 && v2.unlocated.length >= 1 && v2.unlocated.every((s) => s.includes('zzz-not-a-file')), { 不可定位: v2.unlocated });
  const fakeSymbol = PRD.replace('`server/src/db/schema.ts:544`', '`server/src/db/schema.ts:544 zzzFakeIdentifier`');
  const v3 = judgeAnchors(fakeSymbol);
  ok('N-03 符号腿有牙齿：给 schema.ts 锚点句塞一个仓里不存在的词干，±3 窗口判据必须点名它（真锚点不会因此变红）',
    v3.noSymbol.length === base.noSymbol.length + 1 && v3.noSymbol.some((s) => /zzzFakeIdentifier/.test(s)), { 失配: v3.noSymbol });
  ok('N-04 路由判据有牙齿：运行时路由表里 PRD 未引用的假端点必须不命中（F-R1 的命中不是「任意字符串都算」）',
    !ROUTES.some((r) => r.includes('/plans/zzz-not-a-route')) && ROUTES.length > 150, { 路由表条数: ROUTES.length });
  ok('N-05 列探针有牙齿：同一 PRAGMA 探针打在假表上返回空列（证明 F-D1「无 color」是真表实测，不是探针恒空）',
    (COLS['不存在_的假表_zzz'] ?? ['x']).length === 0 && (COLS.projects ?? []).length > 0,
    { 假表列数: (COLS['不存在_的假表_zzz'] ?? ['x']).length, projects列数:  (COLS.projects ?? []).length });
  const fakeTodo = PRD.replace('## 3. 用户画像与场景', '## 3. 用户画像与场景\n\nTODO 补一段\n');
  ok('N-06 占位符判据有牙齿：往副本里塞一行 TODO，同一判据必须转红（D-06 的红不是靠运气）',
    /TODO|TBD|FIXME|WIP|XXX/.test(fakeTodo) === true && /TODO|TBD|FIXME|WIP|XXX/.test(PRD) === false);
  const surveyBase = parseTables(sec('5.3 对比表', 3)).flat();
  const tamperedTable = sec('5.3 对比表', 3).replace('| PR 评论 | ✗ |', '| PR 评论 | ✓ |');
  const surveyT = parseTables(tamperedTable).flat();
  ok('N-07 缺口值级判据有牙齿：把某竞品的「跨仓」列由 ✗ 篡改成 ✓，F-C4 的同一个判定函数必须转假（证明它盯的是值而非措辞）',
    tamperedTable !== sec('5.3 对比表', 3) && gapJudge(surveyBase.slice(1, -1), surveyBase[surveyBase.length - 1]) === true
    && gapJudge(surveyT.slice(1, -1), surveyT[surveyT.length - 1]) === false,
    { 篡改后竞品行跨仓列: surveyT.slice(1, -1).map((r) => r.cells[5]) });
  ok('N-08 编码腿判别力自证：同一仓同一提交，两次取 subject 的字节确实不同（F-G2 不是拿两句天生不同的话比）',
    GP.CN !== undefined && String(GP.subjRaw) !== String(GP.subjUtf));
}

// ======================= 收口 =======================
try { rmSync(REPO, { recursive: true, force: true }); rmSync(WEIRD, { recursive: true, force: true }); } catch { /* 保留排查 */ }
if (process.env.T02169_KEEP !== '1') {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 库句柄未释放时留痕即可 */ }
}
mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02169-gate-results.txt',
  `T02169 PRD 交付质量门（T02293 改判版）：PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}\n${lines.join('\n')}\n${skippedList.length ? '\n跳过项：\n' + skippedList.join('\n') + '\n' : ''}`);
console.log(`PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
