/**
 * 用独立 esbuild 二进制把一个 .mts 校验脚本打包成 CJS 再执行。
 * 适用于 tsx/esbuild JS 包缺失但平台二进制仍在的环境（T06309 实测）。
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const entry = process.argv[2];
if (!entry) {
  console.error('用法：node scripts/tests/run-esbuild-gate.mjs <verify-*.mts>');
  process.exit(2);
}

const arch = { x64: 'win32-x64', arm64: 'win32-arm64', ia32: 'win32-ia32' }[process.arch];
const candidates = process.platform === 'win32'
  ? [join(ROOT, 'node_modules', '@esbuild', arch ?? 'win32-x64', 'esbuild.exe')]
  : [join(ROOT, 'node_modules', '@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild')];

const bin = candidates.find((p) => p && existsSync(p));
if (!bin) {
  console.error(`未找到独立 esbuild 二进制：${candidates.join(' / ')}`);
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), 'mtask-esbuild-gate-'));
const outFile = join(outDir, 'gate.cjs');
const build = spawnSync(bin, [
  entry,
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--jsx=automatic',
  `--outfile=${outFile}`,
  '--log-level=warning',
], { cwd: ROOT, stdio: 'inherit' });

if (build.status !== 0) process.exit(build.status ?? 1);

const run = spawnSync(process.execPath, [outFile], { cwd: ROOT, stdio: 'inherit' });
process.exit(run.status ?? 1);
