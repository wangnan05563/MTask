#!/usr/bin/env node
/**
 * T02776：把共享索引守卫接进提交链路，并把这份配方从 D:/code/tmp 收进仓库。
 *
 * 背景：`scripts/tests/verify-index-staleness.mjs`（T02713 落地）只负责「出声」，它不在任何
 * 提交链路上被强制调用；此前 AI 提交靠临时目录里的 shell 配方，换机器或清临时目录即失传。
 *
 * 本配方的三条纪律（与 docs/验收门判据规约.md 的提交纪律一致）：
 *   1. 提交前跑守卫，只把 A-01/A-02 的点名结果打进输出——完整读数仍以守卫自身为准，
 *      避免配方再抄一份会漂的汇总。
 *   2. D/S 命中时**只提示不代做**：绝不 `git reset` / `git restore --staged`。共享索引里
 *      可能是别的并发会话正想要的暂存态，替他人清索引属于越权（T02777 的裁决面）。
 *   3. 提交走隔离索引（GIT_INDEX_FILE 副本 + commit-tree + update-ref CAS），不碰共享索引；
 *      `git add` 只加显式列出的路径，防止把别人的 staged 改动裹挟进本次提交。
 *
 * 用法：
 *   node scripts/safe-commit.mjs --check-only
 *      只跑守卫（提交前自检；健康索引静默给两行 PASS，D/S 命中给提示）+ 字号 lint 全量扫描
 *   node scripts/safe-commit.mjs -m "提交信息" -- <路径...>
 *      隔离索引提交；`--` 之后的路径才会被 add
 *   node scripts/safe-commit.mjs -m "提交信息" --dry-run -- <路径...>
 *      走到 commit-tree 但不 update-ref（可核对将要提交的树）
 *
 * 退出码：0 成功（守卫命中 D/S 不算失败——本配方不改共享索引，命中是「提醒」）；
 *         1 前置件/参数/提交本身失败。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts', 'tests', 'verify-index-staleness.mjs');
const FONT_LINT = join(ROOT, 'scripts', 'lint-font-tokens.mjs');

function git(args, env = {}) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 守卫只出声：它的非零退出码不代表「本次提交被拦」，只代表共享索引里存在发散项。
 * 之所以不让它决定配方退出码：本配方根本不读写共享索引，用别人的索引状态否决自己的
 * 隔离提交会把两件事混成一件（反模式 47：前置件状态不得冒充本次操作失败）。
 */
function runGuard() {
  if (!existsSync(GUARD)) {
    console.log('[WARN] 索引守卫不在盘上（scripts/tests/ 未随仓库分发）——本次提交无索引发散检查');
    return [];
  }
  const r = spawnSync(process.execPath, [GUARD], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const picked = out.split('\n').filter((l) => /\[(PASS|FAIL)\]\s+A-0[12]\b/.test(l)).map((l) => l.trim());
  console.log('— 共享索引守卫：A-01/A-02 点名（完整读数请直接跑守卫）—');
  for (const l of picked) console.log(`  ${l}`);
  if (picked.some((l) => l.includes('[FAIL]'))) {
    console.log('  ⚠ 命中 D/S 形态。本配方不碰共享索引，因此不会自动 reset；');
    console.log('    若上面点名的路径正是你这次要提交的文件，请先自行处理该路径的索引/工作树版本。');
  }
  return picked;
}

/**
 * T03220（UX-11）字号令牌 lint：本次要提交的 web 源码里不得有数字字号。
 * 只扫显式列出的路径（同反模式 47：别人未提交的 WIP 不得冒充本次提交的失败）；
 * `--check-only` 且没给路径时退化为全量扫描，供提交前自检。
 * 与索引守卫不同，这条**会拦住提交**——它是「禁止新增」的执行点。
 */
function runFontLint(paths, checkOnly) {
  if (!existsSync(FONT_LINT)) {
    console.log('[WARN] 字号 lint 不在盘上（scripts/lint-font-tokens.mjs 缺失）——本次提交无数字字号检查');
    return true;
  }
  const scoped = paths.filter((p) => /\.(tsx?|mts)$/.test(p) && relative(ROOT, resolve(ROOT, p)).startsWith(join('web', 'src')));
  const args = [FONT_LINT];
  if (checkOnly && scoped.length === 0) {
    console.log('— 字号令牌 lint（全量 web/src）—');
  } else {
    if (scoped.length === 0) return true;
    console.log(`— 字号令牌 lint（本次提交 ${scoped.length} 个 web 源码文件）—`);
    args.push('--paths', ...scoped);
  }
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  for (const l of `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')) console.log(`  ${l.trim()}`);
  if (r.status !== 0) {
    console.log('  ✗ 数字字号会把该元素钉死在默认档，用户切字号档时它不跟随。');
    console.log('    请改成档位令牌 fontSize: \'var(--fs-2xs|xs|s|m|l|xl|2xl|title)\'（默认档下像素不变）。');
    return false;
  }
  return true;
}

const argv = process.argv.slice(2);const checkOnly = argv.includes('--check-only');
const dryRun = argv.includes('--dry-run');
const sep = argv.indexOf('--');
const headArgs = sep >= 0 ? argv.slice(0, sep) : argv;
const paths = sep >= 0 ? argv.slice(sep + 1) : [];
const mi = headArgs.indexOf('-m');
const message = mi >= 0 ? headArgs[mi + 1] : '';

runGuard();

if (!runFontLint(paths, checkOnly)) {
  console.error('\n[FAIL] 字号令牌 lint 拦住本次提交（见上面点名的 file:line）');
  process.exit(1);
}

if (checkOnly) {
  console.log('\n（--check-only：未提交任何内容）');
  process.exit(0);
}
if (!message || !paths.length) {
  console.error('用法：node scripts/safe-commit.mjs -m "提交信息" -- <路径...> [--dry-run]');
  process.exit(1);
}

// 隔离索引放在系统临时目录：与共享 .git/index 彻底分开，配方中途失败也不会留下半成品索引。
const idxFile = join(tmpdir(), `mtask-safe-index-${process.pid}`);
const env = { GIT_INDEX_FILE: idxFile };
const msgFile = join(tmpdir(), `mtask-safe-msg-${process.pid}.txt`);
try {
  const head = git(['rev-parse', 'HEAD']).trim();
  git(['read-tree', 'HEAD'], env);
  git(['add', '--', ...paths], env);
  const tree = git(['write-tree'], env).trim();
  writeFileSync(msgFile, message, 'utf8');
  const commit = git(['commit-tree', tree, '-p', head, '-F', msgFile]).trim();
  if (dryRun) {
    console.log(`\n[dry-run] tree=${tree} commit=${commit}（未 update-ref）`);
  } else {
    const branch = git(['symbolic-ref', '--short', 'HEAD']).trim();
    // CAS：带旧值守卫，若 HEAD 在提交期间被别人推进，update-ref 会失败而不是覆盖他人提交。
    git(['update-ref', `refs/heads/${branch}`, commit, head]);
    console.log(`\n[OK] ${branch} ${head.slice(0, 8)} → ${commit.slice(0, 8)}`);
    console.log(`     本次提交路径：${paths.join(', ')}`);
  }
} catch (e) {
  console.error(`[FAIL] 隔离提交失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  try { unlinkSync(idxFile); } catch { /* 首次失败时可能未生成 */ }
  try { unlinkSync(`${idxFile}.lock`); } catch { /* 同上 */ }
  try { rmSync(msgFile, { force: true }); } catch { /* 同上 */ }
}
