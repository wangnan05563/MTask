/**
 * T02355：HEAD 自洽性预检的**唯一实现**，被四条发布入口共用：
 *   - `scripts/打包.mjs` 的第 [3] 步（T02321 落的那道）
 *   - `scripts/dist.js`（`npm run dist`，原先只做版本名注入 + ABI 切换）
 *   - `scripts/构建打包.bat` / `scripts/build-pack-t.bat`（`一键发布.bat` 走的这条）
 *
 * 拦的是同一条静默路径：工作树 = HEAD + 并发会话未提交 hunk 的叠加态，「引用已入库、定义没入库」
 * 的缺口会被别人的 WIP 恰好补齐 → 工作树 typecheck 全绿、安装包照出，但按那个 commit 重新
 * checkout 编译不出来（发布件不可复现）。判据打在**提交**上，不是工作树叠加态。
 *
 * 直接跑本子模块即 .bat 入口：
 *   node scripts/lib/head-precheck.mjs [--skip-head-check]
 * 环境变量 `MTASK_SKIP_HEAD_CHECK=1` 与 `--skip-head-check` 等价（.bat 用后者透传、前者兜底）。
 * 跳过会打成醒目一行，不静默——静默跳过等于没这道门。
 *
 * T02617 再加一层**接线自检**：跑重门之前先确认四条发布入口在「工作树 / HEAD / 索引」三个面上
 * 都还**调用**着本守卫（判定实现在 `scripts/lib/guard-reference.mjs`）。引用行被 WIP 覆盖或被一份
 * 未取消的旧 stage 摘掉时，重门根本不不会被执行——那一层退化比 HEAD 不自洽更早、也更静默。
 * `node scripts/lib/head-precheck.mjs --check-only` 是这层自检的调用入口（只 spawn node + git，秒级）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inspectGuardReferences, summarize } from './guard-reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const GATE = path.join(ROOT, 'scripts', 'verify-head-selfconsistency.mts');

/** 预检子门自己的 worktree 副本根：落在仓库同级目录——不猜盘符（本机 C: 常年 0 可用，
 *  指过去会假性写失败/SQLITE_FULL，把绿 HEAD 报成红）。 */
const TMP_ROOT_DEFAULT = () => path.join(path.dirname(ROOT), '.mtask-pack-tmp');

export function shortHead(root = ROOT) {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** `--skip-head-check` 位置参数（mjs 入口）或 `MTASK_SKIP_HEAD_CHECK=1`（.bat 入口）都算显式跳过。 */
export function isRequestedSkip(argv = process.argv.slice(2)) {
  return argv.includes('--skip-head-check') || String(process.env.MTASK_SKIP_HEAD_CHECK || '') === '1';
}

export function printSkipBanner(sha, tag = '[3/7]') {
  console.log('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.log(`${tag} !! SKIP-HEAD-CHECK：已跳过 HEAD 自洽性预检——commit ${sha || '未知'} 可能编译不过，`);
  console.log('      本次产物按「不可复现的临时包」对待，不要作为正式版本分发。');
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
}

/**
 * T02617 接线自检（秒级、纯读）：跑重门之前先确认「四条发布入口在三个面上都还引用着本守卫」。
 * 拦的是比「HEAD 不自洽」更靠前的一步——引用行被一次 WIP 覆盖或一份未取消的旧 stage 摘掉后，
 * 本文件根本不会被调用，重门再准也没人跑。判定实现见 `scripts/lib/guard-reference.mjs`。
 * 返回 `{ blocked, warned, detail }`；`blocked` 由调用方决定是否拦下发包。
 */
export function checkGuardReference(root = ROOT) {
  try {
    const res = inspectGuardReferences(root);
    if (res.ok) return { blocked: false, warned: false, detail: summarize(res) };
    if (!res.guardFileReadable) {
      return { blocked: true, warned: false, detail: `守卫判定模块 scripts/lib/guard-reference.mjs 不在工作树——自检无从执行。${summarize(res)}` };
    }
    return { blocked: true, warned: false, detail: summarize(res) };
  } catch (e) {
    // 自检自己出异常也按红处理：宁可拦下一次好包，不可放过一次静默退化。
    return { blocked: true, warned: false, detail: `守卫引用自检异常：${e && e.message}` };
  }
}

function printGuardRefBanner(kind, detail, tag) {
  console.log('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.log(`${tag} !! GUARD-REFERENCE-${kind}：发布入口对 HEAD 自洽守卫的引用不完整，`);
  console.log(`      判定：${detail}`);
  console.log('      含义：某条入口（工作树 / HEAD / 索引 任一面）已不再调用 scripts/lib/head-precheck.mjs，');
  console.log('            预检会被静默绕过——把引用行补回来再发包。');
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
}

/**
 * 跑一次预检。返回 `{ skipped, sha, status }`——status 是子门退出码（跳过时为 0）。
 * 调用方决定是否 fail：本模块不 exit，便于 mjs 入口保留自己的步骤编号与措辞。
 */
export function runHeadPrecheck(opts = {}) {
  const root = opts.root ?? ROOT;
  const ref = checkGuardReference(root);
  if (ref.blocked && !opts.skip) {
    printGuardRefBanner('BLOCKED', ref.detail, opts.tag || '[3/7]');
    return { skipped: false, sha: shortHead(root), status: 1, guardRef: ref };
  }
  if (ref.blocked) printGuardRefBanner('WARNED（已显式跳过预检，仅告警不拦）', ref.detail, opts.tag || '[3/7]');
  const sha = opts.sha ?? shortHead(root);
  if (opts.skip) {
    printSkipBanner(sha, opts.tag);
    return { skipped: true, sha, status: 0, guardRef: ref };
  }
  const r = spawnSync(process.execPath, [TSX, GATE], {
    stdio: 'inherit', cwd: root, shell: false,
    env: { ...process.env, T02295_TMP_ROOT: process.env.T02295_TMP_ROOT || TMP_ROOT_DEFAULT() },
  });
  return { skipped: false, sha, status: r.status ?? -1, guardRef: ref };
}

export const HEAD_PRECHECK_ROOT = ROOT;

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  // T02617：`--check-only` 让验收门复用同一个调用入口跑接线自检（只 spawn node + git，秒级），
  // 断言的是「调用这条入口真能被拦下」，而不是去 grep 本文件的源码。
  if (process.argv.slice(2).includes('--check-only')) {
    const out = checkGuardReference();
    console.log(`[guard-reference] blocked=${out.blocked} ${out.detail}`);
    process.exit(out.blocked ? 1 : 0);
  }
  const skip = isRequestedSkip();
  const res = runHeadPrecheck({ skip, tag: '[precheck]' });
  if (skip) process.exit(0);
  if (res.status !== 0) {
    if (res.guardRef && res.guardRef.blocked) {
      console.error('[ERROR] 发布入口对守卫的引用不完整（工作树 / HEAD / 索引 任一面缺调用行）：预检会被静默绕过，'
        + '请先补回对 scripts/lib/head-precheck.mjs 的调用。判定：' + res.guardRef.detail);
    } else {
      console.error(`[ERROR] HEAD 自洽性预检未通过（commit ${res.sha || '未知'}）：该提交单独 checkout 编译不过，`
        + '安装包将不可复现。请补齐漏掉的提交（常见成因：定义留在工作树未入库）；'
        + '确属临时包时设 MTASK_SKIP_HEAD_CHECK=1（或加 --skip-head-check）并在发布说明里写明。');
    }
    process.exit(1);
  }
  process.exit(0);
}
