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
 * 形态判据（逐路径点名，红只给「可归因的回退风险」）：
 *   D  索引里没有 HEAD 已有的路径      → 等同暂存删除，按索引提交会**整文件删掉**（最危险，无需阀值即红）
 *   S  索引 blob ≠ HEAD blob          → 索引存旧内容，按索引提交会把该文件**回退**（无需阀值即红）
 *   W  工作树 blob 与索引、HEAD 三方互异 → 并发混装，需人工判定（只点名不判红，避免替他人做决定）
 *   F  索引 blob 在该路径的已提交版本链里查无此版 → 异源/前向态（多半是他人未提交的暂存工作）：
 *     按索引提交不会**回退**已落地内容，所以不判红、也不计入规模。
 *   ⚠ 本轮实测自抓的口径缺陷：初版把「索引 blob ≠ HEAD blob」一律塞进 S 判红——但 `索引 ≠ HEAD`
 *     有两种危害相反的形态：索引是 HEAD 的**更旧**版本（一提交就回退已落地工作，真红）与索引是
 *     HEAD「之后」/异源的第三态（他人未提交的暂存工作，一提交正好帮它落地，不该红）。同判红 ⇒
 *     红因不可归因，还会把后者的删除行算进规模。现在 S 的红必须先取证方向：索引 blob 命中该路径
 *     版本链里更旧的版本（报「落后 N 版」）才算回退风险，取不出方向的列 F 不判红。
 *     本机当前读数（取证后）：F **0** 条、S 64 条全部带出落后版本数——例如 `server/src/routes/index.ts`
 *     索引与工作树同为 `4617441`＝HEAD 的第 1 个旧版本、`scripts/t02211-file-size-cap-test.mjs`
 *     同为 `e040d1f`＝HEAD 的第 1 个旧版本（两条都拿 `git log --raw --abbrev=40` 独立复核过，
 *     不是靠本守卫自说自话）。故本改判**没有**缩小今天该红的那 64 条，它关掉的是「他人前向暂存
 *     被误报成失守」这条通道，并把每条红从「hash 不等」升级成「落后 N 版」的可核对取证。
 * 另有规模阀值 L：**回退风险规模**（D ∪ S 两形态的删除行数）超 `INDEX_STALE_MAX_DELS`（默认 200）判红——
 *   阈值依据实测：近 25 个提交的**提交级**删除量分布 p50=7 / p90=38 / max=47，200 远在自然态之外；
 *   建单时给的 200 是建议值，本轮按分布复核后沿用（并把它变成可覆盖的环境变量而不是常量）。
 *   不用 `git diff --cached HEAD` 的删除总量：总量里混着他人未提交的暂存改动，两个方向的活聚成一个数就没法归因。
 *
 * 本轮实测自抓三条（都写进注释，因为它们正是本守卫要防的形态在守卫自己身上复发）：
 *   ① 解析 `git ls-files --stage` 的正则按印象写成空格分隔，实际分隔符是 TAB ⇒ 捕获组只有 3 个，
 *     取 `m[4]` 恒为 undefined ⇒ 索引表退化成 1 条 ⇒ 610/610 路径全被误判「索引缺路径」，
 *     为每个误报路径 spawn 一次 `git show`，跑到十分钟不止且点名表全是噪声。
 *     现补 A-00「索引行全部解析成功」：解析器不认的行数不为 0 就停手判红，不拿半截解析结果判形态。
 *   ② 变异轮里 `git rev-parse HEAD~1:<新增路径>` 直接 fatal，异常穿过 finally 后
 *     汇总照样打印 `PASS=3 FAIL=0` 并 exit 0 —— 半轮没跑完的变异被报成通过。
 *     现补 ST-AB/A-AB「中途抛错必须判红」，且靶子改为「两版都在、内容确有差异、改动量最大」的真实路径。
 *   ③ 夹具的**前置条件**没固定，腿就会随并发会话抖动：同一份工作树门体先 9/0、隔几分钟再跑变 7/2——只因为选靶逻辑按「改动量最大」抓到了他人正在改的文件（`MM`）。此时 `--cacheinfo` 旧 blob
 *     让索引/工作树/HEAD 三方互异 ⇒ 进 W 桶而不是 S 桶，ST-03（点名 S）与 ST-04（数回退删除量）双双失牙。
 *     现补 ST-00c「靶子工作树与 HEAD 一致」把前置条件钉成一条腿，并把 ST-04 的阀值改成 riskDels±1
 *     的边界两侧——让腿只对「计数对不对」敏感，不对「今天谁在改哪个文件」敏感。
 *
 * 纪律（与 T02616 解析器同一口径）：**只出声不拦路**——判红只点名 + 给可收口选项，绝不自动 `git reset`
 * （共享索引里那坨可能是他人真想要的暂存态，AI 无权替它决定）。
 *
 * 用法：
 *   node scripts/verify-index-staleness.mjs            # 扫当前仓库索引（只读，A-05 自证字节未变）
 *   node scripts/verify-index-staleness.mjs --selftest # 变异负对照：临时索引造 D/S/F 三态 + 规模两端，必须当场点名
 *   INDEX_STALE_MAX_DELS=500 node scripts/verify-index-staleness.mjs
 * 实测读数（2026-10-20 本机，方向取证版）：`--selftest` 连跑两轮均 **10 PASS / 0 FAIL**（首跑曾 7/1——
 * 夹具误用打印器取数导致半截抛错，靠 ST-AB 判红，见规约 52/54；第二跑 9/0 后把靶子换成他人正在改的
 * 文件又变 7/2——夹具前置条件不固定，见规约 55，现由 ST-00c 钉住）；正常模式 3 PASS / 3 FAIL：
 * D 9 路径（含本守卫自己这个文件与 364 行的 `verify-t02630-excluded-parity.mjs`，即共享索引把已入库的
 * 守卫整文件摘掉，门当场点名了自己）、S 63 路径（全部带「落后 N 版」取证）、F 0、W 10、回退风险规模
 * 17850 行 vs 阀值 200（`diff --cached HEAD` 总量 19496；S/W 计数会随并发会话抖动，本轮 63/10，
 * 上一轮 64/9）。红是事实不是门坏；本守卫不代做收口，只点名给选项。
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
  const forms = { D: [], S: [], F: [], W: [] };
  // 解析器不认的行数如实带出去（由调用方判红）：绝不能把它当成「索引里没有这条」继续往下算——
  // 那会把整片健康路径误报成 D 形态，红因与真实风险无关（实测：一次正则写错就造成 610/610 误报）。
  if (unparsed > 0) return { forms, conflictStages, ins: 0, dels: 0, riskDels: 0, classified: 0, headCount: headPaths.length, idxCount: idx.size, unparsed, sample: indexLines.find((l) => !parseIndexLine(l)) ?? '' };
  let classified = 0;
  for (const rel of headPaths) {
    const headBlob = head.get(rel);
    const indexBlob = idx.get(rel);
    if (indexBlob === undefined) { forms.D.push({ rel, headBlob, lines: blobLines(rel, env) }); continue; }
    if (indexBlob === headBlob) continue;
    const disk = existsSync(join(ROOT, rel));
    // 不加 -w：本判据只要 hash，不该往共享对象库塞悬挂 blob
    const workBlob = disk ? git(['hash-object','--',rel], env) : null;
    // 方向取证放在分类之前：同为「索引≠HEAD」，「索引是 HEAD 的旧版本」与「索引是他人未提交的第三态」
    // 危害完全相反（前者一提交就回退已落地工作，后者一提交正好帮他人落地）——不能同判红。
    const cls = classifyIndexBlob(rel, indexBlob, headBlob, env); classified += 1;
    const mark = { rel, headBlob, indexBlob, workBlob, depth: cls.depth, kind: cls.kind, lines: blobLines(rel, env) };
    if (cls.kind === 'foreign' || cls.kind === 'ahead' || cls.kind === 'unknown') {
      forms.F.push({ ...mark, why: cls.kind === 'foreign'
        ? '索引 blob 从未作为该路径的已提交版本出现 ⇒ 异源/前向态（很可能是他人未提交的暂存工作），按索引提交不会回退已落地内容'
        : `取证判为 ${cls.kind}（HEAD 之后 / 无法定位版本序），不判红` });
      continue;
    }
    if (workBlob === headBlob) forms.S.push({ ...mark, why: `磁盘已跟 HEAD 一致，索引却存 HEAD 的第 ${cls.depth} 个旧版本——「checkout 后索引没刷新」` });
    else if (workBlob === indexBlob) forms.S.push({ ...mark, why: `索引与工作树同为 HEAD 的第 ${cls.depth} 个旧版本（磁盘本身是过期副本，见 memory stale-copy-overwrite）` });
    else forms.W.push({ ...mark, lines: disk ? mark.lines : 0, why: disk ? '三方互异：并发混装' : '工作树已无该文件（可能是他人正在删）' });
  }
  const numstat = git(['diff','--cached','HEAD','--numstat'], env).split('\n').filter(Boolean);
  let dels = 0, ins = 0;
  const delsBy = new Map();
  for (const l of numstat) {
    const a = l.split('\t');
    if (a.length !== 3) continue;
    const i = /^\d+$/.test(a[0]) ? +a[0] : 0, d = /^\d+$/.test(a[1]) ? +a[1] : 0;
    ins += i; dels += d; delsBy.set(a[2], d);
  }
  // 风险规模只累计「按索引提交会摘掉/回退」的那些路径（D + 判为 behind 的 S）；
  // 把他人未提交的暂存改动也算进「删除规模」会把两个方向的活混成一个数，红因无法归因。
  let riskDels = 0;
  for (const x of [...forms.D, ...forms.S]) riskDels += delsBy.get(x.rel) ?? x.lines ?? 0;
  return { forms, conflictStages, ins, dels, riskDels, classified, headCount: headPaths.length, idxCount: idx.size };
}

/**
 * 判定「索引 blob 相对 HEAD 是**旧**还是**异源**」——A-02 的红必须是「按索引提交会把文件回退到旧版」，
 * 而不是「索引与 HEAD 不同」。只比 hash 不等就判红，会把他人未提交的暂存工作（磁盘+索引同为 HEAD 之后
 * 的第三态）也判成功能失守，红因不可归因。
 * 取证方式：`git log --format=%H --raw --abbrev=40 -- <rel>` 一次拿到该路径在 HEAD 历史里的 blob 链
 * （`:<oldmode> <newmode> <old> <new> <X>\t<path>`，新在前），取每条提交的 **new 侧**按序组成版本序列
 * （第 0 位就是 HEAD 版）；索引 blob 落在第 i>0 位 ⇒ 落后 i 个版本（真·旧快照）；一条都不命中 ⇒ 它从未
 * 作为该路径的已提交版本出现 ⇒ 异源/前向态（F，可能是他人未提交的暂存工作，不判红只点名）。
 * 实测样本（三条都另用 raw `git log --raw` 独立复核，不靠本函数自证）：
 *   `server/src/routes/index.ts` 索引 4617441 落 rank1 ⇒ behind 1，且工作树同为 4617441 ⇒「磁盘是过期副本」；
 *   `scripts/t02211-…mjs` 索引 e040d1f 落 rank1 ⇒ behind 1（同上形态，链里只有 0883626e/e040d1f 两版）；
 *   `scripts/verify-t02103-kickoff-stream.mts`（`MM`）索引 c3dfae9f 落 rank2 ⇒ behind 2，
 *     但工作树 == HEAD（3bfb0a7d）⇒ 报「磁盘已跟 HEAD 一致，索引没刷新」，同判红、但红的是索引那一侧。
 */
function classifyIndexBlob(rel, indexBlob, headBlob, env) {
  let chain;
  // --abbrev=40：默认 --raw 给 7 位短号，短号前缀在长历史上有撞车风险（撞车会把「他人前向暂存」误判成
  // 「落后 N 版」，正是要避免的不可归因红）。取全号后只做全等比较。
  try { chain = git(['log','--format=%H','--raw','--abbrev=40','-n','40','--',rel], env); } catch { return { kind: 'unknown', depth: -1 }; }
  const news = [];
  const olds = [];
  for (const l of chain.split('\n')) {
    const m = l.match(/^:\d{6} \d{6} ([0-9a-f]{7,40}) ([0-9a-f]{7,40}) [ACDMRTUV]\t/);
    if (m) { olds.push(m[1]); news.push(m[2]); }
  }
  const same = (a, b) => a === b || (a.length !== b.length && (a.startsWith(b) || b.startsWith(a)));
  const rank = news.findIndex((b) => same(indexBlob, b));
  const headRank = news.findIndex((b) => same(headBlob, b));
  if (headRank < 0) return { kind: 'unknown', depth: -1 };
  if (rank >= 0) return rank > headRank ? { kind: 'behind', depth: rank - headRank } : { kind: 'ahead', depth: headRank - rank };
  // 只出现在 old 侧（例如初始提交的父状态）也算「比 HEAD 旧」，但深度只能给下界
  if (olds.some((b) => same(indexBlob, b))) return { kind: 'behind', depth: news.length };
  return { kind: 'foreign', depth: -1 };
}

/** 该路径在 HEAD 里占多少行——用来把「会被摘掉多少行」报成可判读规模而不是只给个文件名。 */
function blobLines(rel, env) {
  try { return git(['show', `HEAD:${rel}`], env).split('\n').length; } catch { return 0; }
}

/** HEAD 侧 rel -> blob 全表（自证道挑「供体」用；一次 ls-tree 取回，不逐路径 spawn）。 */
function headList(env = {}) {
  const m = new Map();
  for (const l of git(['ls-tree', '-r', 'HEAD'], env).split('\n').filter(Boolean)) {
    const x = l.match(/^\d+ blob ([0-9a-f]{40})\t(.*)$/);
    if (x) m.set(x[2], x[1]);
  }
  return m;
}

/** 规模腿判据本体：只看**回退风险规模**（D+S 两形态的删除量），不用 `diff --cached` 总量——
 *  总量里混着他人未提交的暂存改动，把两个方向的活聚成一个数就没法归因（抽成函数是为了让自证道
 *  能用同一坨读数在低/高阀值两端测牙）。 */
const scaleBreached = (r, limit) => r.riskDels > limit;

const topMovers = (f) => [...f].sort((a, b) => (b.lines || 0) - (a.lines || 0)).slice(0, 12)
  .map((x) => `${x.rel}（HEAD ${x.lines} 行${x.depth >= 0 ? `，落后 ${x.depth} 版` : ''}${x.indexBlob ? `，索引 blob ${x.indexBlob.slice(0, 8)} ≠ HEAD ${x.headBlob.slice(0, 8)}` : '，索引无此路径'}）`);

function report(r) {
  console.log(`  索引三方比对：HEAD ${r.headCount} 路径 / 索引 ${r.idxCount} 路径 / 冲突态 ${r.conflictStages} / 方向取证 ${r.classified} 路径`);
  if (r.unparsed) console.log(`  ⚠ ${r.unparsed} 行索引输出未被解析（本守卫直接判红并停止形态比对，不猜）：${r.sample}`);
  console.log(`  \`git diff --cached HEAD\`：插入 ${r.ins} / 删除 ${r.dels}（其中**回退风险规模** ${r.riskDels} / 阀值 ${MAX_DELS}）`);
  for (const [k, label] of [
    ['D', '索引缺 HEAD 路径（按索引提交=整文件删除）'],
    ['S', '索引存 HEAD 的旧版本（按索引提交=文件回退，已取证落后版本数）'],
    ['F', '异源/前向态（他人未提交的暂存工作；按索引提交不会回退已落地内容 ⇒ 不判红）'],
    ['W', '三方互异（并发混装，只点名不判红）'],
  ]) {
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
    // 靶子必须同时满足三条，缺一条就会有一条腿空转（本轮实测抓到全部三种）：
    //   ① 在 HEAD 与某个更早提交里都存在且内容确有差异（否则「塞旧 blob」不是变异，实测踩过一次）；
    //   ② 取到的不是上一提交新增的路径（`HEAD~1:<path>` 直接 fatal ⇒ 半截抛错，实测踩过一次，靠 ST-AB 兜住）；
    //   ③ **工作树当时与 HEAD 一致**（本轮新增）——靶子若正被他人改着（`MM`），`--cacheinfo` 旧 blob 后
    //     索引/工作树/HEAD 三方互异 ⇒ 落 W 而不是 S，ST-03/ST-04 双双失牙（实测：换个并发脏文件当靶子
    //     就 7 PASS / 2 FAIL）。夹具的前置条件不固定，腿就成了「看当天谁在改哪个文件」。
    // 排序按 **dels** 降序：规模腿数的是删除行，靶子只改 1 行的话低阀值端会偶然不红。
    let victim = null, oldRef = null;
    outer: for (let back = 1; back <= 12 && !victim; back += 1) {
      const ref = `HEAD~${back}`;
      let mods = [];
      try {
        mods = git(['diff','--numstat','--diff-filter=M',ref,'HEAD'], env).split('\n').filter(Boolean)
          .map((l) => { const a = l.split('\t'); return { p: a[2], dels: /^\d+$/.test(a[1]) ? +a[1] : 0 }; })
          .filter((m) => m.p.startsWith('server/src/services/') || m.p.startsWith('scripts/'))
          .sort((x, y) => y.dels - x.dels);
      } catch { break; }
      for (const m of mods.slice(0, 6)) {
        let hb = null, wb = null;
        try { hb = git(['rev-parse', `HEAD:${m.p}`], env); wb = git(['hash-object','--',m.p], env); } catch { continue; }
        if (hb && wb && hb === wb) { victim = m.p; oldRef = ref; break outer; }
      }
    }
    ok('ST-00 临时索引夹具可建，且靶子是「两版都在、内容确有差异」的真实路径',
      !!victim && !!oldRef, `靶子 ${victim} @ ${oldRef}`);
    const headBlobOfTarget = git(['rev-parse', `HEAD:${victim}`], env);
    const oldBlob = git(['rev-parse', `${oldRef}:${victim}`], env);
    ok('ST-00b 取到的旧 blob 确与 HEAD blob 不同（变异确有对象，不是同名同物）', oldBlob !== headBlobOfTarget,
      `${victim}: HEAD ${headBlobOfTarget.slice(0, 8)} vs ${oldRef} ${oldBlob.slice(0, 8)}`);
    // 前置条件写成腿而不是注释：靶子的工作树必须与 HEAD 一致，否则「塞旧 blob」进的是 W 桶（三方互异），
    // ST-03/ST-04 会静默失牙——本轮就是这么红的（换到他人正在改的文件 ⇒ 7/2）。
    ok('ST-00c 靶子工作树与 HEAD 一致（夹具前置条件，不是碰运气）',
      git(['hash-object','--',victim], env) === headBlobOfTarget, `${victim} 工作树 blob ≠ HEAD，选靶逻辑有洞`);
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
    // 规模腿：同一坨读数在阀值边界两侧各测一次——低一边判红、高一边判绿，证明这条腿真的有牙
    // （MAX_DELS 在模块加载时读一次 env，进程内改 env 不影响它，所以直接测判据函数本身；
    //   边界取 riskDels±1 而不是写死 1/10 万，是为了让腿只对「计数对不对」敏感、不对「靶子当天多大」敏感）
    const r2 = scanIndex(env);
    ok('ST-04 删除规模腿在阀值边界两侧一红一绿（阀值不是装饰，且数的是回退风险量不是总量）',
      r2.riskDels > 0 && !scaleBreached(r2, r2.riskDels) && scaleBreached(r2, r2.riskDels - 1),
      `riskDels=${r2.riskDels} dels=${r2.dels} ins=${r2.ins}｜阀值 ${r2.riskDels} → ${scaleBreached(r2, r2.riskDels)}，阀值 ${r2.riskDels - 1} → ${scaleBreached(r2, r2.riskDels - 1)}（riskDels=0 说明 S 态没进规模，多半是靶子前置条件破了）`);
    // ST-05：清干净临时索引（read-tree HEAD）后各形态必须一起转绿——守卫不会自己咬自己
    git(['read-tree','HEAD'], env);
    const r3 = scanIndex(env);
    ok('ST-05 索引==HEAD 时四形态全零且删除规模为 0（守卫对健康索引不误报）',
      r3.forms.D.length === 0 && r3.forms.S.length === 0 && r3.forms.F.length === 0 && r3.forms.W.length === 0
      && r3.dels === 0 && r3.riskDels === 0
      && r3.idxCount === r3.headCount && !r3.unparsed,
      `D=${r3.forms.D.length} S=${r3.forms.S.length} F=${r3.forms.F.length} W=${r3.forms.W.length} dels=${r3.dels} riskDels=${r3.riskDels} 索引解析出 ${r3.idxCount}/${r3.headCount} 路径 未解析 ${r3.unparsed ?? 0} 行`);
    // ST-06（本轮新增的口径牙）：把**别的路径**的 HEAD blob 塞进靶子的索引位——它从来不是靶子的已提交
    // 版本，属「异源/前向态」（模拟他人未提交的暂存工作）。必须落 F 而不是 S：既不能判红，
    // 也不能把它的删除量算进回退风险规模，否则「他人正在干的活」会被报成「已落地工作要被回退」。
    // 供体从 ls-tree 全表里按扩展名挑文本路径，逐条试到「F 命中且 dels>0」为止。
    // ⚠ 这里两次踩到自己刚登记的坑：① 用 topMovers 当取数器（它返回的是打印字符串不是对象，
    //   `d.headBlob` 变 undefined ⇒ cacheinfo 参数非法 ⇒ 半截抛错，靠 ST-AB 当场判红才没被报成绿）；
    //   ② 给 600 条候选都跑一次 `git show` 量行数（= 上一个「为每个误报路径 spawn」的同形慢法）。
    const donorCandidates = [...headList(env).entries()]
      .filter(([p, b]) => p !== victim && b !== headBlobOfTarget && b !== oldBlob && /\.(ts|tsx|mjs|js|md)$/.test(p))
      .slice(0, 8)
      .map(([rel, headBlob]) => ({ rel, headBlob }));
    let r4 = null, donor = null;
    for (const d of donorCandidates) {
      git(['read-tree','HEAD'], env);
      git(['update-index','--cacheinfo', `100644,${d.headBlob},${victim}`], env);
      const cand = scanIndex(env);
      // dels>0 也作入选条件：供体若与靶子几乎同内容（或二进制导致 numstat 为 `-`）会让「不计入规模」这句
      // 断言空转——风险规模必须是「本来会被算进去、现在确实没算」才有牙。
      if (cand.forms.F.some((x) => x.rel === victim) && !cand.forms.S.some((x) => x.rel === victim) && cand.dels > 0) {
        r4 = cand; donor = d; break;
      }
    }
    ok('ST-06 索引塞入「该路径从未有过的版本」⇒ 归入 F（不判红）且不计入回退风险规模',
      !!r4 && r4.riskDels === 0 && r4.dels > 0 && r4.forms.S.length === 0,
      r4 ? `供体 ${donor.rel} 的 HEAD blob ${donor.headBlob.slice(0, 8)}｜F=${r4.forms.F.length} S=${r4.forms.S.length}｜原始删除 ${r4.dels} 行，回退风险 ${r4.riskDels} 行（应当 0）`
        : '未找到可当供体的异源 blob（这条腿没被执行，视同 FAIL）');
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
    ok('A-02 索引里没有 HEAD 的旧版本 blob（S 形态=按索引提交会回退文件；异源/前向态另列为 F 不判红）', r.forms.S.length === 0,
      `${r.forms.S.length} 条：${topMovers(r.forms.S).join(' ｜ ')}`);
    ok('A-03 回退风险规模在自然态内（D+S 两形态的删除行数 ≤ 阀值）', !scaleBreached(r, MAX_DELS),
      `实测回退风险 ${r.riskDels} 行（索引态总删除 ${r.dels} 行，含他人未提交暂存）/ 阀值 ${MAX_DELS}（自然提交级 p90=38、max=47，n=25；env INDEX_STALE_MAX_DELS 可覆盖）`);
    if (r.forms.F.length) console.log(`  · F 形态 ${r.forms.F.length} 条异源/前向路径（他人未提交的暂存工作，本守卫不判红）：${topMovers(r.forms.F).slice(0, 6).join(' ｜ ')}`);
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
