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
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const GATE = path.join(ROOT, 'scripts', 'verify-t02295-head-selfconsistency.mts');

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
 * 跑一次预检。返回 `{ skipped, sha, status }`——status 是子门退出码（跳过时为 0）。
 * 调用方决定是否 fail：本模块不 exit，便于 mjs 入口保留自己的步骤编号与措辞。
 */
export function runHeadPrecheck(opts = {}) {
  const sha = opts.sha ?? shortHead();
  if (opts.skip) {
    printSkipBanner(sha, opts.tag);
    return { skipped: true, sha, status: 0 };
  }
  const r = spawnSync(process.execPath, [TSX, GATE], {
    stdio: 'inherit', cwd: ROOT, shell: false,
    env: { ...process.env, T02295_TMP_ROOT: process.env.T02295_TMP_ROOT || TMP_ROOT_DEFAULT() },
  });
  return { skipped: false, sha, status: r.status ?? -1 };
}

export const HEAD_PRECHECK_ROOT = ROOT;

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const skip = isRequestedSkip();
  const res = runHeadPrecheck({ skip, tag: '[precheck]' });
  if (skip) process.exit(0);
  if (res.status !== 0) {
    console.error(`[ERROR] HEAD 自洽性预检未通过（commit ${res.sha || '未知'}）：该提交单独 checkout 编译不过，`
      + '安装包将不可复现。请补齐漏掉的提交（常见成因：定义留在工作树未入库）；'
      + '确属临时包时设 MTASK_SKIP_HEAD_CHECK=1（或加 --skip-head-check）并在发布说明里写明。');
    process.exit(1);
  }
  process.exit(0);
}
