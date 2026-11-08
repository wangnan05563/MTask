#!/usr/bin/env node
/**
 * T03731：`.bat` 发布入口用的 ABI 切换 CLI（单一实现，逻辑全部落在 scripts/lib/abi-switch.mjs）。
 *
 * 旧做法把「能不能覆盖 better_sqlite3.node」的判定写成内联 PowerShell + %TEMP% 共享文件，
 * 探针没跑成时变量读空、判据把空值当「被锁」，构建无端中止（且版本号已经 +1）。这里改成：
 *   probe   —— 缓存缺失即非 0（此时必然打包不出可用包）；二进制被占用只告警并列出占用进程，
 *              因为 switch 会用改名旁路接管，硬拦只会白烧版本号；
 *   switch  —— 快照当前二进制 → 切到指定 ABI（重试 + 改名接管 + 哈希校验），状态落盘；
 *   restore —— 按快照逐字节还原并校验，失败即非 0。
 *
 * 用法：node scripts/lib/abi-cli.mjs probe|switch <dev|electron>|restore
 * 状态目录：node_modules/.cache/mtask-pack（node_modules 已被 .gitignore 忽略，不留仓库噪音）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  cachePath, describeHolders, lockSidecarPath, restoreWorkspaceAbi,
  sha256File, snapshotWorkspaceAbi, switchAbi, waitForWritable, workspaceNodePath,
} from './abi-switch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DIR = path.join(ROOT, 'node_modules', '.cache', 'mtask-pack');
const STATE_FILE = path.join(STATE_DIR, 'abi-state.json');
const SNAPSHOT_FILE = path.join(STATE_DIR, 'workspace-before.node');

const fail = (msg, code = 1) => { console.error(`[ERROR] ${msg}`); process.exit(code); };
const log = (m) => console.log(m);

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function writeState(mode, sidecar) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ mode, sidecar, pid: process.pid, at: new Date().toISOString() }, null, 2));
}

function clearState() {
  for (const p of [STATE_FILE, SNAPSHOT_FILE]) fs.rmSync(p, { force: true });
}

function probe() {
  for (const mode of ['dev', 'electron']) {
    if (!fs.existsSync(cachePath(ROOT, mode))) fail(`ABI 缓存缺失：${cachePath(ROOT, mode)}（可用 scripts/native-switch.bat dev 重建）`, 3);
  }
  const dst = workspaceNodePath(ROOT);
  const devSha = sha256File(cachePath(ROOT, 'dev'));
  const elSha = sha256File(cachePath(ROOT, 'electron'));
  log(`[ABI] 缓存 dev=${devSha.slice(0, 12)} electron=${elSha.slice(0, 12)}`);

  const stale = readState();
  if (stale) {
    log(`[ABI][WARN] 检测到上次未收尾的切换状态（${stale.at}，目标 ${stale.mode}）；若打包已被中断，请先执行：node scripts/lib/abi-cli.mjs restore`);
  }

  if (!fs.existsSync(dst)) {
    log('[ABI] 工作区尚无 better_sqlite3.node，打包时会直接落 Electron 版本');
    return 0;
  }
  let cur = null;
  try { cur = sha256File(dst); } catch (e) { cur = null; log(`[ABI][WARN] 读取工作区二进制失败（${e.code || e.message}），可能正被独占占用`); }
  if (cur) log(`[ABI] 工作区 ${cur.slice(0, 12)}（${cur === devSha ? 'dev' : cur === elSha ? 'electron' : '未知' }）`);

  let probeRes = waitForWritable(dst, { tries: 4, delayMs: 750 });
  if (!probeRes.writable) {
    // 只警告、不拦：真正能不能换得动由 switch 的重试 + 改名旁路接管判定，失败时版本号会整体回滚。
    // 旧脚本在这里直接退出，于是「dev server 在跑」= 每次都白烧一个版本号、还要人工改回三份文件。
    const holders = describeHolders(ROOT);
    log(`[ABI][WARN] 工作区 better_sqlite3.node 暂不可写（${probeRes.code}），切换阶段将用改名旁路接管；`
      + '若下方有 dev server / 桌面壳，建议先停掉，避免打包窗口期内它重启加载到 Electron ABI。');
    if (holders.length) log(`  可能的占用进程：\n   - ${holders.join('\n   - ')}`);
  } else {
    log('[ABI] 可写性检查通过');
  }
  return 0;
}

function main() {
  const [cmd, mode] = process.argv.slice(2);
  if (cmd === 'probe') return probe();

  if (cmd === 'switch') {
    if (mode !== 'dev' && mode !== 'electron') fail('用法：abi-cli.mjs switch <dev|electron>');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const snap = snapshotWorkspaceAbi(ROOT);
    if (snap) fs.writeFileSync(SNAPSHOT_FILE, snap);
    else fs.rmSync(SNAPSHOT_FILE, { force: true });
    const r = switchAbi(ROOT, mode, { fail, log });
    writeState(mode, r.sidecar);
    return 0;
  }

  if (cmd === 'restore') {
    const state = readState();
    const snap = fs.existsSync(SNAPSHOT_FILE) ? fs.readFileSync(SNAPSHOT_FILE) : null;
    restoreWorkspaceAbi(ROOT, snap, { fail, log, sidecar: state?.sidecar ?? lockSidecarPath(ROOT) });
    clearState();
    return 0;
  }

  return fail('用法：abi-cli.mjs probe|switch <dev|electron>|restore');
}

process.exit(main());
