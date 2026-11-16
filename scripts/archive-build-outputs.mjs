#!/usr/bin/env node
/**
 * T05739：把可重复生成的构建产物集中到 release/，仓库根只保留源码。
 *
 * 目标：
 *   web/dist                    -> release/build-artifacts/web-dist
 *   server/dist                 -> release/build-artifacts/server-dist
 *   server/dist/data            -> release/runtime-data/server-dist-data（运行时数据，单独保护）
 *   build/native                -> release/.mtask-abi-cache（兼容旧布局的 ABI 缓存）
 *   .workbuddy/head-selfconsistency-gate-results-*.txt -> release/build-artifacts/logs
 *
 * 调用时机：electron-builder 成功、ABI 还原、版本定稿之后。失败只影响归档本身，
 * 不会回滚安装包；直接运行 `node scripts/archive-build-outputs.mjs` 可手动整理。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveRoot() {
  if (process.env.MTASK_PROJECT_ROOT) return path.resolve(process.env.MTASK_PROJECT_ROOT);
  const cwd = process.cwd();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (pkg.workspaces) return cwd;
  } catch {
    /* 不在 workspace 根，回退到脚本所在仓库 */
  }
  return SCRIPT_ROOT;
}

const exists = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

function moveDirectory(src, dest, { overwrite = true } = {}) {
  if (!exists(src)) return false;
  ensureDir(path.dirname(dest));
  if (exists(dest)) {
    if (!overwrite) throw new Error(`目标已存在且不允许覆盖：${dest}`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  return true;
}

function moveFile(src, dest, { overwrite = true } = {}) {
  if (!exists(src)) return false;
  ensureDir(path.dirname(dest));
  if (exists(dest)) {
    if (!overwrite) throw new Error(`目标已存在且不允许覆盖：${dest}`);
    fs.rmSync(dest, { force: true });
  }
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
  return true;
}

/** 合并目录：目标已有的文件不覆盖，仅补齐缺失项；用于 ABI 缓存兼容迁移。 */
function mergeCopy(src, dest) {
  if (!exists(dest)) {
    ensureDir(path.dirname(dest));
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.cpSync(src, dest, { recursive: true, force: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
  }
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      mergeCopy(s, d);
    } else if (!exists(d)) {
      ensureDir(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}

function uniqueRuntimePath(runtimeRoot, baseName) {
  let dest = path.join(runtimeRoot, baseName);
  if (!exists(dest)) return dest;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  dest = path.join(runtimeRoot, `${baseName}-${stamp}`);
  let i = 1;
  while (exists(dest)) {
    dest = path.join(runtimeRoot, `${baseName}-${stamp}-${i}`);
    i += 1;
  }
  return dest;
}

function archiveOne(label, src, dest, results) {
  if (!exists(src)) {
    results.push(`[skip] ${label} 不存在：${src}`);
    return;
  }
  moveDirectory(src, dest);
  results.push(`[move] ${label}：${src} -> ${dest}`);
}

/**
 * @param {string} [root] 仓库根；缺省按当前 workspace 解析
 * @returns {{moved:boolean, results:string[]}}
 */
export function archiveBuildOutputs(root = resolveRoot()) {
  const releaseDir = path.join(root, 'release');
  const buildDir = path.join(releaseDir, 'build-artifacts');
  const logsDir = path.join(buildDir, 'logs');
  const abiCacheDir = path.join(releaseDir, '.mtask-abi-cache');
  const runtimeDir = path.join(releaseDir, 'runtime-data');
  const results = [];

  ensureDir(releaseDir);
  ensureDir(buildDir);

  const serverDist = path.join(root, 'server', 'dist');
  const serverData = path.join(serverDist, 'data');
  if (exists(serverData)) {
    const runtimeDest = uniqueRuntimePath(runtimeDir, 'server-dist-data');
    moveDirectory(serverData, runtimeDest, { overwrite: false });
    results.push(`[move] server/dist/data -> ${runtimeDest}`);
  }

  archiveOne('web/dist', path.join(root, 'web', 'dist'), path.join(buildDir, 'web-dist'), results);
  archiveOne('server/dist', serverDist, path.join(buildDir, 'server-dist'), results);

  const legacyNative = path.join(root, 'build', 'native');
  if (exists(legacyNative)) {
    ensureDir(abiCacheDir);
    for (const name of fs.readdirSync(legacyNative)) {
      mergeCopy(path.join(legacyNative, name), path.join(abiCacheDir, name));
    }
    fs.rmSync(legacyNative, { recursive: true, force: true });
    results.push(`[move] build/native -> ${abiCacheDir}（已有缓存优先保留）`);
  } else {
    results.push('[skip] build/native 不存在（ABI 缓存已在 release 或未生成）');
  }

  const workbuddyDir = path.join(root, '.workbuddy');
  if (exists(workbuddyDir)) {
    const names = fs.readdirSync(workbuddyDir)
      .filter((n) => /^head-selfconsistency-gate-results-.*\.txt$/.test(n));
    if (names.length > 0) {
      ensureDir(logsDir);
      for (const name of names) {
        moveFile(path.join(workbuddyDir, name), path.join(logsDir, name), { overwrite: true });
      }
      results.push(`[move] HEAD 门日志 ${names.length} 个 -> ${logsDir}`);
    } else {
      results.push('[skip] 没有 HEAD 门日志');
    }
  } else {
    results.push('[skip] .workbuddy 不存在');
  }

  const moved = results.some((line) => line.startsWith('[move]'));
  for (const line of results) console.log(`[archive] ${line}`);
  if (!moved) console.log('[archive] 没有可归档的构建产物');
  else console.log(`[archive] 构建产物已集中到 ${releaseDir}`);
  return { moved, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    archiveBuildOutputs();
  } catch (err) {
    console.error(`[ERROR] 构建产物归档失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
