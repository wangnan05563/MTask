#!/usr/bin/env node
/**
 * `verify-index-staleness.mjs` —— 共享索引陈旧守卫（T02713）。
 *
 * 它抓的不是「工作树脏」，而是**索引与 HEAD 发散**：本仓的并发会话纪律下，
 * 索引里可能存着某次 checkout/reset 留下的旧 blob，或干脆没有 HEAD 已有的路径（=暂存删除）。
 * 此时任何「按索引提交」的 `git commit` 会**静默摘掉已落地、且已有验收门的工作**——
 * 磁盘文件仍是新的，`git status` 只显示「已暂存」，只有 `git show` 那个 commit 才看得出。
 * T02630 入库现场实测：`git diff --cached HEAD` = 132 插入 / 871 删除，集中在 7 份已落地路径。
 *
 * 三条形态判据（互斥，逐路径点名）：
 *   D  索引里没有 HEAD 已有的路径      → 等同暂存删除，按索引提交会**整文件删掉**（最危险，无需阀值即红）
 *   S  索引 blob ≠ HEAD blob          → 索引存旧内容，按索引提交会把该文件**回退**（无需阀值即红）
 *   W  工作树 blob 与索引、HEAD 三方互异 → 并发混装，需人工判定（只点名不判红，避免替他人做决定）
 * 另有规模阀值 L：`git diff --cached HEAD` 的删除总行数超 `INDEX_STALE_MAX_DELS`（默认 200）判红——
 *   阈值依据实测：近 25 个提交的**提交级**删除量分布 p50=7 / p90=38 / max=47，200 远在自然态之外；
 *   建单时给的 200 是建议值，本轮按分布复核后沿用（并把它变成可覆盖的环境变量而不是常量）。
 *
 * 本轮实测自抓两条（都写进注释，因为它们正是本守卫要防的形态在守卫自己身上复发）：
 *   ① 解析 `git ls-files --stage` 的正则按印象写成空格分隔，实际分隔符是 TAB ⇒ 捕获组只有 3 个，
 *     取 `m[4]` 恒为 undefined ⇒ 索引表退化成 1 条 ⇒ 610/610 路径全被误判「索引缺路径」，
 *     为每个误报路径 spawn 一次 `git show`，跑到十分钟不止且点名表全是噪声。
 *     现补 A-00「索引行全部解析成功」：解析器不认的行数不为 0 就停手判红，不拿半截解析结果判形态。
 *   ② 变异轮里 `git rev-parse HEAD~1:<新增路径>` 直接 fatal，异常穿过 finally 后
 *     汇总照样打印 `PASS=3 FAIL=0` 并 exit 0 —— 半轮没跑完的变异被报成通过。
 *     现补 ST-AB/A-AB「中途抛错必须判红」，且靶子改为「两版都在、内容确有差异、改动量最大」的真实路径。
 *
 * 纪律（与 T02616 解析器同一口径）：**只出声不拦路**——判红只点名 + 给可收口选项，绝不自动 `git reset`
 * （共享索引里那坨可能是他人真想要的暂存态，AI 无权替它决定）。
 *
 * 用法：
 *   node scripts/verify-index-staleness.mjs            # 扫当前仓库索引（只读，A-05 自证字节未变）
 *   node scripts/verify-index-staleness.mjs --selftest # 变异负对照：临时索引造 D/S 两态，必须当场点名
 *   INDEX_STALE_MAX_DELS=500 node scripts/verify-index-staleness.mjs
 * 实测读数（2026-10-20 本机）：`--selftest` 8 PASS / 0 FAIL；正常模式 3 PASS / 3 FAIL（今天的共享索引
 * 确实与 HEAD 发散：D 8 路径、S 64 路径、删除 19243 行），红是事实不是门坏。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MAX_DELS = Number(process.env.INDEX_STALE_MAX_DELS ?? 200);
const SELFTEST = process.argv.includes('--selftest');

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` -> ${typeof extra === 'string' ? extra.slice(0, 400) : JSON.stringify(extra).slice(0, 400)}` : ''}`);
  }
};
const skipped = (name, why) => { skip += 1; console.log(`  [SKIP] ${name} :: ${why}`); };

const git = (args, env = {}) => execFileSync('git', ['-C', ROOT, '-c', 'core.quotePath=false', ...args], {
  encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  // stderr 收下不直喷：本仓 core.autocrlf=true，索引刷新会为几十个路径刷「LF will be replaced by
  // CRLF」告警，把证据冲得一干二净。真抛错时 stderr 仍在 e.stderr 里，红因不丢。
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...env },
}).trim();

/**
 * 解析一行 `git ls-files --stage`：`<mode> <sha40> <stage>\t<path>`（实测分隔符是 TAB 不是空格）。
 * ⚠ 这里踩过一次实测坑：正则写成 `(?:\d+ )?(.*)` 时捕获组只有 3 个，取 `m[4]` 恒得 undefined ⇒
 *   索引表退化成 1 条 ⇒ 全库 610 路径都被误判成「索引缺路径」，守卫为每个路径 spawn 一次 `git show`，
 *   跑到天荒地老且点名表全是噪声。改判据必须先看一眼真实输出格式，别按印象写分隔符。
 */
function parseIndexLine(l) {
  const m = l.match(/^(\d{6}) ([0-9a-f]{40}) ([0-3])\t(.*)$/);
  return m ? { mode: m[1], blob: m[2], stage: Number(m[3]), path: m[4] } : null;
}

/** 扫索引：返回逐路径形态表 + 删除规模。全程只读（git 只跑 ls-tree/ls-files/hash-object/diff）。 */
function scanIndex(env = {}) {
  // HEAD 侧一次取全（610 路径逐条 rev-parse 会跑成上百次 git 进程，本机实测不可接受）
  const head = new Map(); // rel -> blob
  for (const l of git(['ls-tree','-r','HEAD'], env).split('\n').filter(Boolean)) {
    const m = l.match(/^\d+ blob ([0-9a-f]{40})\t(.*)$/);
    if (m) head.set(m[2], m[1]);
  }
  const headPaths = [...head.keys()];
  const indexLines = git(['ls-files','--stage'], env).split('\n').filter(Boolean);
  const idx = new Map();
  let unparsed = 0;
  for (const l of indexLines) {
    const e = parseIndexLine(l);
    if (!e) { unparsed += 1; continue; }
    idx.set(e.path, e.blob); // 同路径多 stage（冲突态）取最后一条，冲突数另行点名
  }
  const conflictStages = indexLines.filter((l) => { const e = parseIndexLine(l); return e && e.stage > 0; }).length;
  const forms = { D: [], S: [], W: [] };
  // 解析器不认的行数如实带出去（由调用方判红）：绝不能把它当成「索引里没有这条」继续往下算——
  // 那会把整片健康路径误报成 D 形态，红因与真实风险无关（实测：一次正则写错就造成 610/610 误报）。
  if (unparsed > 0) return { forms, conflictStages, ins: 0, dels: 0, headCount: headPaths.length, idxCount: idx.size, unparsed, sample: indexLines.find((l) => !parseIndexLine(l)) ?? '' };
  for (const rel of headPaths) {
    const headBlob = head.get(rel);
    const indexBlob = idx.get(rel);
    if (indexBlob === undefined) { forms.D.push({ rel, headBlob, lines: blobLines(rel, env) }); continue; }
    if (indexBlob === headBlob) continue;
    const disk = existsSync(join(ROOT, rel));
    // 不加 -w：本判据只要 hash，不该往共享对象库塞悬挂 blob
    const workBlob = disk ? git(['hash-object','--',rel], env) : null;
    if (workBlob === headBlob) forms.S.push({ rel, headBlob, indexBlob, lines: blobLines(rel, env), why: '磁盘已跟 HEAD 一致，索引却存旧 blob——最典型的「checkout 后索引没刷新」' });
    else if (workBlob === indexBlob) forms.S.push({ rel, headBlob, indexBlob, lines: blobLines(rel, env), why: '索引与工作树同为旧 blob（磁盘本身是过期副本，见 memory stale-copy-overwrite）' });
    else forms.W.push({ rel, headBlob, indexBlob, workBlob, lines: disk ? blobLines(rel, env) : 0, why: disk ? '三方互异：并发混装' : '工作树已无该文件（可能是他人正在删）' });
  }
  const numstat = git(['diff','--cached','HEAD','--numstat'], env).split('\n').filter(Boolean);
  let dels = 0, ins = 0;
  for (const l of numstat) { const a = l.split('\t'); if (a.length === 3) { if (/^\d+$/.test(a[0])) ins += +a[0]; if (/^\d+$/.test(a[1])) dels += +a[1]; } }
  return { forms, conflictStages, ins, dels, headCount: headPaths.length, idxCount: idx.size };
}

/** 该路径在 HEAD 里占多少行——用来把「会被摘掉多少行」报成可判读规模而不是只给个文件名。 */
function blobLines(rel, env) {
  try { return git(['show', `HEAD:${rel}`], env).split('\n').length; } catch { return 0; }
}

/** 规模腿判据本体（抽成函数是为了让自证道能同一坨读数两端测牙：低阀判红、高阀判绿）。 */
const scaleBreached = (r, limit) => r.dels > limit;

const topMovers = (f) => [...f].sort((a, b) => (b.lines || 0) - (a.lines || 0)).slice(0, 12)
  .map((x) => `${x.rel}（HEAD ${x.lines} 行${x.indexBlob ? `，索引 blob ${x.indexBlob.slice(0, 8)} ≠ HEAD ${x.headBlob.slice(0, 8)}` : '，索引无此路径'}）`);

function report(r) {
  console.log(`  索引三方比对：HEAD ${r.headCount} 路径 / 索引 ${r.idxCount} 路径 / 冲突态 ${r.conflictStages}`);
  if (r.unparsed) console.log(`  ⚠ ${r.unparsed} 行索引输出未被解析（本守卫直接判红并停止形态比对，不猜）：${r.sample}`);
  console.log(`  \`git diff --cached HEAD\`：插入 ${r.ins} / 删除 ${r.dels}（阀值 ${MAX_DELS}）`);
  for (const [k, label] of [['D', '索引缺 HEAD 路径（按索引提交=整文件删除）'], ['S', '索引存旧 blob（按索引提交=文件回退）'], ['W', '三方互异（并发混装，只点名不判红）']]) {
    console.log(`  ${k} 形态 ${r.forms[k].length} 路径 :: ${label}`);
    topMovers(r.forms[k]).forEach((s) => console.log(`      · ${s}`));
  }
}

if (SELFTEST) {
  // ===== 变异负对照（判据 4）：全程在临时索引里做，共享索引一个字节都不动 =====
  const TMP = mkdtempSync(join(tmpdir(), 'idx-stale-'));
  const IDX = join(TMP, 'stale-index');
  let aborted = null;
  try {
    const env = { GIT_INDEX_FILE: IDX };
    git(['read-tree','HEAD'], env);
    // 靶子必须同时满足「在 HEAD 与某个更早提交里都存在」且「两版内容确有差异」——
    // 本轮实测抓到两次空转：① 按 ls-tree 顺序取到的文件在 HEAD~1 里根本没动（塞旧 blob = 没变异）；
    // ② 取到的是上一提交**新增**的路径，`HEAD~1:<path>` 直接 fatal ⇒ 半截跑抛错，
    //   而抛错被 finally 吞掉后汇总仍打 PASS=3 FAIL=0 并 exit 0（半轮变异被报成通过）。
    let victim = null, oldRef = null;
    for (let back = 1; back <= 12 && !victim; back += 1) {
      const ref = `HEAD~${back}`;
      let mods = [];
      try {
        mods = git(['diff','--numstat','--diff-filter=M',ref,'HEAD'], env).split('\n').filter(Boolean)
          .map((l) => { const a = l.split('\t'); return { p: a[2], n: (/^\d+$/.test(a[0]) ? +a[0] : 0) + (/^\d+$/.test(a[1]) ? +a[1] : 0) }; })
          // 取改动量最大的一条当靶子：ST-04 要验「超阀即红」，靶子只改 1 行的话这条腿会偶然空转
          .sort((x, y) => y.n - x.n);
      } catch { break; }
      victim = (mods.find((m) => m.p.startsWith('server/src/services/')) ?? mods[0])?.p ?? null;
      if (victim) oldRef = ref;
    }
    ok('ST-00 临时索引夹具可建，且靶子是「两版都在、内容确有差异」的真实路径',
      !!victim && !!oldRef, `靶子 ${victim} @ ${oldRef}`);
    const headBlobOfTarget = git(['rev-parse', `HEAD:${victim}`], env);
    const oldBlob = git(['rev-parse', `${oldRef}:${victim}`], env);
    ok('ST-00b 取到的旧 blob 确与 HEAD blob 不同（变异确有对象，不是同名同物）', oldBlob !== headBlobOfTarget,
      `${victim}: HEAD ${headBlobOfTarget.slice(0, 8)} vs ${oldRef} ${oldBlob.slice(0, 8)}`);
    // D 态：从索引里摘掉该路径（等同 git rm --cached，但只作用在临时索引）
    git(['update-index','--force-remove', victim], env);
    let r = scanIndex(env);
    ok('ST-01 造出「索引缺路径」⇒ 守卫当场点名该路径且报出 HEAD 行数',
      r.forms.D.some((x) => x.rel === victim && x.lines > 0),
      `D 命中 ${r.forms.D.length} 条，靶子在表里：${topMovers(r.forms.D).find((s) => s.includes(victim)) ?? '(没点名)'}`);
    // 换回即绿：证明它钉的是「索引与 HEAD 发散」这件事，不是某个写死的文件名
    git(['update-index','--add', victim], env);
    r = scanIndex(env);
    ok('ST-02 靶子换回索引 ⇒ D 形态归零（负对照不是恒真式）',
      r.forms.D.length === 0 && !r.forms.S.some((x) => x.rel === victim),
      `D=${r.forms.D.length} S=${r.forms.S.length}`);
    // S 态：把该路径的索引 blob 换成更早提交的旧版本
    git(['update-index','--cacheinfo', `100644,${oldBlob},${victim}`], env);
    r = scanIndex(env);
    ok('ST-03 索引塞入旧 blob ⇒ S 形态点名，并给出索引/HEAD 两个 blob 指纹',
      r.forms.S.some((x) => x.rel === victim && x.indexBlob === oldBlob && x.headBlob !== oldBlob),
      topMovers(r.forms.S).find((s) => s.includes(victim)) ?? '(没点名)');
    // 规模腿：把同一坨读数丢进「阀值=1」与「阀值=10 万」两端，必须一端判红一端判绿——
    // 证明这条腿真的有牙（MAX_DELS 在模块加载时读一次 env，进程内改 env 不影响它，所以这里直接测判据函数本身）
    const r2 = scanIndex(env);
    ok('ST-04 删除规模腿在低阀值下判红、高阀值下判绿（阀值不是装饰）',
      scaleBreached(r2, 1) && !scaleBreached(r2, 100000),
      `dels=${r2.dels} ins=${r2.ins}｜阀值 1 → ${scaleBreached(r2, 1)}，阀值 100000 → ${scaleBreached(r2, 100000)}`);
    // ST-05：清干净临时索引（read-tree HEAD）后三条腿必须一起转绿——守卫不会自己咬自己
    git(['read-tree','HEAD'], env);
    const r3 = scanIndex(env);
    ok('ST-05 索引==HEAD 时三形态全零且删除规模为 0（守卫对健康索引不误报）',
      r3.forms.D.length === 0 && r3.forms.S.length === 0 && r3.forms.W.length === 0 && r3.dels === 0
      && r3.idxCount === r3.headCount && !r3.unparsed,
      `D=${r3.forms.D.length} S=${r3.forms.S.length} W=${r3.forms.W.length} dels=${r3.dels} 索引解析出 ${r3.idxCount}/${r3.headCount} 路径 未解析 ${r3.unparsed ?? 0} 行`);
  } catch (e) {
    aborted = String(e?.stderr || e?.message || e).split('\n')[0];
  } finally {
    if (aborted) ok('ST-AB 变异轮全程未中途抛错（抛错必须判红，不能让汇总把半截跑报成绿）', false, aborted);
    else ok('ST-AB 变异轮全程未中途抛错（抛错必须判红，不能让汇总把半截跑报成绿）', true);
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 句柄未放 */ }
    console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip}（--selftest：变异负对照，未触碰共享索引）`);
    console.log(existsSync(TMP) ? '  ⚠ 临时索引目录未删净：' + TMP : '  · 临时索引目录已删净');
    process.exit(fail > 0 ? 1 : 0);
  }
}

// ===== 正常模式：只读扫当前共享索引 =====
console.log(`守卫只读扫索引（绝不 reset/rewrite）：ROOT=${ROOT}`);
const idxFile = process.env.GIT_INDEX_FILE ? resolve(process.env.GIT_INDEX_FILE) : join(ROOT, '.git', 'index');
const digest = () => { try { return createHash('sha256').update(readFileSync(idxFile)).digest('hex').slice(0, 16); } catch { return '(读不到索引文件)'; } };
const before = digest();
try {
  const r = scanIndex();
  report(r);
  ok('A-00 索引行全部解析成功（解析器不认的格式不能静默当成「索引没有这条」）', !r.unparsed,
    `${r.unparsed} 行未解析；样例 ${r.sample} —— 停在这里，不拿半截解析结果判形态`);
  if (!r.unparsed) {
    ok('A-01 索引里没有 HEAD 已有的路径（D 形态=按索引提交会整文件删除）', r.forms.D.length === 0,
      `${r.forms.D.length} 条：${topMovers(r.forms.D).join(' ｜ ')}`);
    ok('A-02 索引存的不是 HEAD 的 blob（S 形态=按索引提交会回退文件）', r.forms.S.length === 0,
      `${r.forms.S.length} 条：${topMovers(r.forms.S).join(' ｜ ')}`);
    ok('A-03 删除规模在自然态内（`git diff --cached HEAD` 删除行数 ≤ 阀值）', !scaleBreached(r, MAX_DELS),
      `实测删除 ${r.dels} 行 / 阀值 ${MAX_DELS}（自然提交级 p90=38、max=47，n=25；env INDEX_STALE_MAX_DELS 可覆盖）`);
    ok('A-04 索引里没有未解决的冲突态条目（stage>0 ⇒ 按索引提交会写出冲突三方）', r.conflictStages === 0,
      `冲突态 ${r.conflictStages} 条`);
    // W 形态只出声：他人并发态不由本守卫判红（口径：判红必须是我方可归因的事实）
    if (r.forms.W.length) console.log(`  · W 形态 ${r.forms.W.length} 条三方互异路径（需人工判定，本守卫不判红）：${topMovers(r.forms.W).slice(0, 6).join(' ｜ ')}`);
    console.log('\n收口选项（只提示，不代做）：');
    console.log('  1) 逐路径把索引刷新到 HEAD：`git update-index --add <path>`（要连工作树一起回 HEAD 才用 `git checkout HEAD -- <path>`）');
    console.log('  2) 确认他人不再需要这些暂存态后：`git restore --staged <path>`');
    console.log('  3) 本仓 AI 提交一律走临时索引配方（GIT_INDEX_FILE + read-tree HEAD + commit-tree + update-ref CAS），不改共享索引');
  }
} catch (e) {
  // 中途抛错必须判红并照常出汇总：实测过一次「git rev-parse 对新增路径 fatal ⇒ 进程抛错」，
  // 而当时的写法让汇总先打印 PASS=3 FAIL=0 再退出 0，把半轮变异报成了通过。
  ok('A-AB 守卫全程未中途抛错（抛错不得被当成通过）', false, String(e?.stderr || e?.message || e).split('\n')[0]);
}
// 「只读」是口头声明，不是判据——用扫描前后索引文件的 sha256 自证（实测本仓 autocrlf 下
// `git diff --cached` 只刷 stat 不写内容，但这条腿保证下次有人加写操作时当场暴露）。
ok('A-05 扫描前后共享索引文件字节不变（只读声明有自证，不是嘴上说说）', before === digest(),
  `${idxFile} 扫描前 ${before} → 扫描后 ${digest()}`);
console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip}`);
process.exit(fail > 0 ? 1 : (skip > 0 ? 2 : 0));
