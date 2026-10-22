/**
 * T02617：发布入口「守卫引用」的**唯一判定实现**（秒级、纯读、无副作用）。
 *
 * 拦的是一条比「守卫管不管用」更靠前的静默路径：守卫实现在 `scripts/lib/head-precheck.mjs`，
 * 但四条发布入口（`scripts/打包.mjs`、`scripts/dist.js`、`scripts/构建打包.bat`、
 * `scripts/build-pack-t.bat`）只是在各自文件里**引用**它。一次 WIP 覆盖（或一份没取消的旧
 * stage）把那一行引用删掉，守卫就再也不被调用——而文件本身还在、typecheck 全绿、安装包照出。
 * 引用可以消失在三个面上，且互相独立：工作树（现在跑的是哪份）、`HEAD`（重新 checkout 复现的是哪份）、
 * 索引（下一次不带路径的 `git commit` 会写进提交的是哪份）。只看工作树等于没看。
 *
 * 判定只认**调用形态**：注释里提一句 `head-precheck.mjs`（两处 .bat 的 REM 说明、js 的文件头注释）
 * 不算引用——否则「摘掉调用行、留着注释」正好是最像没事发生的一种退化。
 *
 * `scripts/lib/head-precheck.mjs` 在调用重门之前先跑一次本模块自检，
 * `scripts/verify-t02617-guard-reference.mjs` 用它做三条面的断言与负对照。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 守卫实现（唯一一份）。入口文件引用它，不各自复制预检逻辑。 */
export const GUARD_REL = 'scripts/lib/head-precheck.mjs';

/** 已知发布入口：三条面都必须带调用形态引用的「必查名单」。 */
export const RELEASE_ENTRIES = [
  'scripts/打包.mjs',
  'scripts/dist.js',
  'scripts/构建打包.bat',
  'scripts/build-pack-t.bat',
];

const GUARD_NAME_RE = /head-precheck\.mjs/;
/** 调用形态：ESM/CJS 导入，或 `node …head-precheck.mjs` 直跑（.bat 走这条）。 */
const CALL_FORM_RE = /\bimport\s*\(|\brequire\s*\(|(?:^|[\s;&(])node(?:\.exe)?[\s"']/i;

const isBat = (rel) => /\.(bat|cmd)$/i.test(rel.split(/[\\/]/).pop() ?? '');

/** 注释行判定：与 T02321 的 W-01 同口径（.bat 认 REM/::，js 认 // 与块注释续行）。 */
export function isCommentLine(rel, line) {
  const t = line.trim();
  if (!t) return true;
  if (isBat(rel)) return /^rem\b/i.test(t) || t.startsWith('::') || t.startsWith('@rem ');
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** 源码里是否存在「守卫调用形态」（逐行剔注释后再认）。 */
export function hasGuardCall(src, rel = GUARD_REL) {
  if (typeof src !== 'string' || src.length === 0) return false;
  return src.split(/\r?\n/).some((l) => !isCommentLine(rel, l) && GUARD_NAME_RE.test(l) && CALL_FORM_RE.test(l));
}

/** 一次 `git grep` 取多文件多行：三条面里除工作树外各只需 2 次 spawn（匹配 + 存在性），
 *  否则本门会退化成一分钟级——它守的是一条**每次发包前都要顺手自检**的接线。 */
const GREP_TOKEN = 'head-precheck.mjs';

function splitOut(text) { return String(text || '').split(/\r?\n/).filter(Boolean); }

/** 把 `git grep` 的 `HEAD:<path>:<n>:<行>` / `<path>:<n>:<行>` 输出按文件归行。 */
function collectGrepLines(stdout, rels, rev) {
  const map = Object.fromEntries(rels.map((r) => [r, []]));
  for (const line of splitOut(stdout)) {
    let rest = line;
    if (rev && rest.startsWith(`${rev}:`)) rest = rest.slice(rev.length + 1);
    const rel = rels.filter((r) => rest.startsWith(`${r}:`)).sort((a, b) => b.length - a.length)[0];
    if (!rel) continue;
    const after = rest.slice(rel.length + 1);
    const m = after.match(/^\d+:/);
    map[rel].push(m ? after.slice(m[0].length) : after);
  }
  return map;
}

const callLine = (rel, line) => !isCommentLine(rel, line) && GUARD_NAME_RE.test(line) && CALL_FORM_RE.test(line);

/**
 * 批量取多条入口的三条面（`opts.env` 用于把索引面指向 `GIT_INDEX_FILE` 副本做负对照）。
 * 返回 `[{ rel, faces:[{face,read,has,why}] }]`，与 `readFace` 逐条判定同结论（门里 G-06 交叉核对）。
 */
export function readFacesBatch(root, rels = RELEASE_ENTRIES, opts = {}) {
  const env = opts.env ? { ...process.env, ...opts.env } : undefined;
  const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, env });
  const cfg = ['-c', 'core.quotepath=off'];
  const base = [...cfg, 'grep', '-a', '-n', '-F', '-e', GREP_TOKEN];
  const gHead = run([...base, 'HEAD', '--', ...rels]);
  const gIndex = run([...base, '--cached', '--', ...rels]);
  const tHead = run([...cfg, 'ls-tree', '--name-only', '-r', 'HEAD', '--', ...rels]);
  const tIndex = run([...cfg, 'ls-files', '--', ...rels]);
  // grep 退出码：0 有命中、1 无命中（都算读到了）、其它才是真失败——失败一律按红，不静默放行。
  const faceOf = (rel, grep, listed, rev, label) => {
    if (grep.status > 1) return { face: label, read: false, has: false, why: `git grep 失败(${grep.status})：${(grep.stderr || '').trim().split(/\r?\n/)[0] || ''}` };
    const exists = splitOut(listed.stdout).includes(rel);
    if (!exists) return { face: label, read: false, has: false, why: `${label === 'head' ? 'HEAD' : '索引'}里没有该文件` };
    const lines = collectGrepLines(grep.stdout, [rel], rev)[rel];
    const has = lines.some((l) => callLine(rel, l));
    return { face: label, read: true, has, why: has ? '调用形态在' : `守卫名出现 ${lines.length} 行但无调用形态（多半只剩注释）` };
  };
  return rels.map((rel) => ({
    rel,
    faces: [readFace(root, 'worktree', rel),
      faceOf(rel, gHead, tHead, 'HEAD', 'head'),
      faceOf(rel, gIndex, tIndex, null, 'index')],
  }));
}

/**
 * 造一份「把守卫调用行摘掉」的源码（负对照夹具，只在内存/临时副本里用）。
 * 按语义定位（剔注释后命中调用形态的行整行删），不锁整行字面量——文案改写也能摘。
 */
export function withoutGuardCall(src, rel = GUARD_REL) {
  return src.split(/\r?\n/).filter((l) => !(hasGuardCall(l, rel) && !isCommentLine(rel, l))).join('\n');
}

function gitAt(root, args, env) {  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, env });
  if (r.status !== 0) return { ok: false, text: '', reason: (r.stderr || r.stdout || '').trim().split(/\r?\n/)[0] || `git ${args.join(' ')} 退出码 ${r.status}` };
  return { ok: true, text: r.stdout };
}

/**
 * 取某个面的入口内容。
 * 返回 `{ face, read, has, why }`：`read=false` 表示这个面根本读不到（文件不在 HEAD / 不在索引 /
 * 工作树缺失），它**必然是红**——「读不到」绝不是「引用还在」。
 */
export function readFace(root, face, rel, opts = {}) {
  const env = opts.env ? { ...process.env, ...opts.env } : undefined;
  if (face === 'worktree') {
    const abs = path.join(root, rel.replace(/\//g, path.sep));
    if (!existsSync(abs)) return { face, read: false, has: false, why: '工作树无此文件' };
    try {
      const src = readFileSync(abs, 'utf8');
      return { face, read: true, has: hasGuardCall(src, rel), why: hasGuardCall(src, rel) ? '调用形态在' : '调用形态缺失' };
    } catch (e) { return { face, read: false, has: false, why: `读工作树失败：${e.message}` }; }
  }
  const spec = face === 'head' ? `HEAD:${rel}` : `:${rel}`;
  const g = gitAt(root, ['show', spec], env);
  if (!g.ok) return { face, read: false, has: false, why: g.reason };
  return { face, read: true, has: hasGuardCall(g.text, rel), why: hasGuardCall(g.text, rel) ? '调用形态在' : '调用形态缺失' };
}

/** 发布入口普查（与 T02321 W-01 同语义，本模块自带一份——两条门各自成立，不互相依赖）。 */
const PUBLISH_INVOKE_RES = [
  /npx\s+electron-builder|electron-builder\s+--win|['"]electron-builder['"]/,
  /\bnpm run build\b|\bvite build\b|\btsc -p\b/,
  /打包\.mjs|dist\.js|bump-version\.js/,
];
const DELEGATE_TARGETS = ['构建打包.bat', 'build-pack-t.bat', '打包.mjs', 'dist.js', 'publish-oneclick.ps1'];

export function scanReleaseEntries(root) {
  const out = [];
  for (const dir of ['.', 'scripts']) {
    let names = [];
    try {
      names = readdirSync(path.join(root, dir))
        .filter((f) => /\.(bat|cmd|ps1|mjs|js)$/.test(f))
        .map((f) => (dir === '.' ? f : `${dir}/${f}`));
    } catch { names = []; }
    for (const rel of names) {
      const base = rel.split(/[\\/]/).pop() ?? '';
      if (/^verify-/.test(base) || /-test\.(mjs|js)$/.test(base)) continue; // 验收门不是发布入口
      let src = '';
      try { src = readFileSync(path.join(root, rel.replace(/\//g, path.sep)), 'utf8'); } catch { continue; }
      const acts = src.split(/\r?\n/).filter((l) => !isCommentLine(rel, l));
      if (!acts.some((l) => PUBLISH_INVOKE_RES.some((re) => re.test(l)))) continue;
      out.push({
        rel,
        called: hasGuardCall(src, rel),
        delegated: DELEGATE_TARGETS.filter((t) => src.includes(t)).join('/'),
      });
    }
  }
  return out;
}

/**
 * 汇总三条面 + 入口矩阵 + npm 扇出。不 exit——调用方决定怎么红：
 * 验收门逐条断言，`head-precheck.mjs` 只在「缺引用」时拦下发包。
 * `ok` 只统计**入口**的引用完整性；守卫实现自己不需要引用自己，单独用 `guardFileReadable` 表出。
 */
export function inspectGuardReferences(root, opts = {}) {
  const rels = opts.relPaths ?? RELEASE_ENTRIES;
  const entries = opts.perFaceRead
    ? rels.map((rel) => {
      const faces = ['worktree', 'head', 'index'].map((f) => readFace(root, f, rel, opts));
      return { rel, faces, ok: faces.every((f) => f.has) };
    })
    : readFacesBatch(root, rels, opts).map((e) => ({ ...e, ok: e.faces.every((f) => f.has) }));
  const matrix = scanReleaseEntries(root);
  const guardedNames = new Set(matrix.filter((m) => m.called).map((m) => m.rel.split(/[\\/]/).pop()));
  const bypass = matrix.filter((m) => !m.called && !m.delegated.split('/').some((t) => guardedNames.has(t)));
  let npmEntries = [];
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    npmEntries = Object.entries(pkg.scripts || {}).filter(([, v]) => /dist\.js|打包\.mjs|electron-builder/.test(String(v)));
  } catch { npmEntries = []; }
  const npmUnguarded = npmEntries.filter(([, v]) => !guardedNames.has(String(v).match(/([\w.-]+\.(?:mjs|js))/)?.[1] ?? ''));
  return {
    ok: entries.every((e) => e.ok) && bypass.length === 0 && npmUnguarded.length === 0,
    entries, matrix, guardedNames, bypass, npmEntries, npmUnguarded,
    guardFileReadable: existsSync(path.join(root, GUARD_REL)),
  };
}

export function summarize(res) {
  const e = res.entries.map((x) => `${x.rel}[${x.faces.map((f) => `${f.face}=${f.has ? 'G' : (f.read ? 'x' : '缺')}`).join(' ')}]`).join(' ');
  return `入口 ${res.entries.length}｜${e}｜矩阵 ${res.matrix.length} 条旁路=${res.bypass.map((b) => b.rel).join(',') || '无'}｜npm 未覆盖=${res.npmUnguarded.map(([k]) => k).join(',') || '无'}`;
}

/**
 * 夹具微型 git 仓库：只含发布面（必查名单 + 守卫本体 + 引用判定 lib + 一份 package.json），
 * 不复制 `node_modules`、不建 worktree——引用判定只需要这几份文件。`mode==='strip'` 时把每条入口
 * 的守卫调用行摘掉（其余原样），用来证明「摘掉即拦」这条行为腿。
 *
 * 原为 `verify-t02617` 的门内私有夹具；`verify-t02321` 的 W-02 改判后要用同一条行为腿，
 * 按规约 §9 单源收到这里——两处各写一遍，改了判定忘了改夹具就会造出两套「拦得住」的假证据。
 * 落盘目录由调用方给（本项目 C: 常年 0 可用，调用方应指 D:/code/tmp）。
 */
export function buildGuardFixture(root, tmpDir, mode = 'clean') {
  const GUARD_LIB_REL = 'scripts/lib/guard-reference.mjs';
  const fx = path.join(tmpDir, `fx-${mode}`);
  if (existsSync(path.join(fx, '.git'))) return fx;
  mkdirSync(path.join(fx, 'scripts', 'lib'), { recursive: true });
  for (const rel of [GUARD_REL, GUARD_LIB_REL]) {
    writeFileSync(path.join(fx, ...rel.split('/')), readFileSync(path.join(root, rel), 'utf8'));
  }
  for (const rel of RELEASE_ENTRIES) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    writeFileSync(path.join(fx, ...rel.split('/')), mode === 'strip' ? withoutGuardCall(src, rel) : src);
  }
  writeFileSync(path.join(fx, 'package.json'), JSON.stringify({ name: 'fx', scripts: { dist: 'node scripts/dist.js' } }, null, 2));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@local', ...a], { cwd: fx, encoding: 'utf8', shell: false });
  if (!existsSync(path.join(fx, '.git')) && g('init', '-q').status !== 0) throw new Error('夹具仓库 git init 失败');
  g('add', '-A');
  if (g('commit', '-q', '-m', 'fixture').status !== 0) throw new Error('夹具仓库 commit 失败');
  return fx;
}
