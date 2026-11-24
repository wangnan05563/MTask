#!/usr/bin/env node
/**
 * T06306（REQ-039）：MTask 本地数据打包备份 + 完整性校验（不连接任何云端）。
 *
 * 产物：
 *   mtask-data-backup-YYYYMMDD-HHMMSS.tar.gz
 *   同名 .sha256 旁车文件（整个归档的 SHA-256）
 *
 * 归档内容：
 *   manifest.json                 逐文件 size + sha256、总量、排除项
 *   db/mtask.db                   SQLite online backup（运行中一致性由 SQLite 保证）
 *   files/<相对路径>              数据目录内除敏感/临时/旧快照外的数据文件
 *
 * 明确排除：
 *   backups/**（旧数据库快照，避免递归膨胀）、tmp/**、mtask-test-data/**、
 *   tunnel/**（含访问令牌，属敏感配置）、mtask.db-wal/shm、*.bak-*、preupgrade-*.db*、*.log。
 *
 * 用法：
 *   node server/scripts/backup-data-package.mjs
 *   node server/scripts/backup-data-package.mjs --data-dir <目录> --out <归档.tar.gz>
 *   node server/scripts/backup-data-package.mjs --verify <归档.tar.gz>
 *
 * 校验：
 *   1) 旁车 SHA-256 与归档实际哈希一致；
 *   2) 解包后逐文件 size + sha256 与 manifest 一致；
 *   3) 解包出的 SQLite 执行 PRAGMA integrity_check。
 * 退出码 0=通过，1=失败（stdout 为 JSON）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FORMAT = 'mtask-data-backup';
const FORMAT_VERSION = 1;
const EXCLUDED_TOP_DIRS = new Set(['backups', 'tmp', 'tunnel', 'mtask-test-data']);
const EXCLUDED_FILE_RES = [
  /^mtask\.db$/i,
  /^mtask\.db-(wal|shm)$/i,
  /^mtask\.db-shm$/i,
  /^mtask\.db-wal$/i,
  /^mtask\.db\.bak-/i,
  /^preupgrade-.*\.db(?:-wal|-shm)?$/i,
  /\.log$/i,
  /^mtask-data-backup-\d{8}-\d{6}\.tar\.gz(?:\.sha256)?$/i,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
];

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (buf) => h.update(buf));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}
function safeRel(rel) {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || norm.startsWith('/') || norm.includes('\0')) throw new Error(`非法归档路径：${rel}`);
  if (norm.split('/').some((seg) => seg === '..' || seg === '.')) throw new Error(`归档路径包含穿越片段：${rel}`);
  return norm;
}
function defaultDataDir() {
  const env = (process.env.MTask_DATA_DIR || '').trim();
  if (env) return path.resolve(env);
  if (process.platform === 'win32' && process.env.APPDATA) {
    const candidate = path.join(process.env.APPDATA, 'mtask', 'data');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(ROOT, 'server', 'data');
}
function defaultOut(dataDir) {
  return path.join(dataDir, 'backups', `mtask-data-backup-${stamp()}.tar.gz`);
}
function parseArgs(argv) {
  const opts = { mode: 'create', dataDir: '', out: '', archive: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.mode = 'help'; continue; }
    if (a === '--verify') { opts.mode = 'verify'; opts.archive = argv[++i] || ''; continue; }
    if (a === '--data-dir') { opts.dataDir = argv[++i] || ''; continue; }
    if (a === '--out') { opts.out = argv[++i] || ''; continue; }
    if (!opts.archive && !a.startsWith('--')) { opts.archive = a; opts.mode = 'verify'; continue; }
    throw new Error(`未知参数：${a}`);
  }
  return opts;
}
function isExcluded(rel) {
  const norm = rel.replace(/\\/g, '/');
  const segs = norm.split('/');
  if (segs.length > 1 && EXCLUDED_TOP_DIRS.has(segs[0])) return true;
  if (segs.length === 1 && EXCLUDED_TOP_DIRS.has(segs[0])) return true;
  if (segs.some((s) => EXCLUDED_TOP_DIRS.has(s) && (s === 'tmp' || s === 'tunnel'))) return true;
  const base = segs[segs.length - 1];
  return EXCLUDED_FILE_RES.some((re) => re.test(base));
}
function walkFiles(dataDir) {
  const out = [];
  const skipped = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(dataDir, abs).replace(/\\/g, '/');
      if (isExcluded(rel)) { skipped.push(rel); continue; }
      if (ent.isSymbolicLink()) { skipped.push(`${rel}（符号链接）`); continue; }
      if (ent.isDirectory()) { walk(abs); continue; }
      if (ent.isFile()) { out.push({ abs, rel }); continue; }
      skipped.push(`${rel}（非普通文件）`);
    }
  }
  walk(dataDir);
  return { files: out.sort((a, b) => a.rel.localeCompare(b.rel)), skipped };
}
function runTar(args, cwd) {
  const r = spawnSync('tar', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`调用 tar 失败（Windows 10+ / Linux/macOS 自带 tar）：${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar 退出码 ${r.status}：${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
  return `${r.stdout || ''}${r.stderr || ''}`;
}
async function createPackage({ dataDir, out }) {
  const t0 = Date.now();
  const srcDir = path.resolve(dataDir);
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) throw new Error(`数据目录不存在：${srcDir}`);
  const dbPath = path.join(srcDir, 'mtask.db');
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  if (fs.existsSync(outAbs)) throw new Error(`输出文件已存在，拒绝覆盖：${outAbs}`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-data-backup-'));
  try {
    const dbDest = path.join(staging, 'db', 'mtask.db');
    fs.mkdirSync(path.dirname(dbDest), { recursive: true });
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { await db.backup(dbDest); } finally { db.close(); }

    const entries = [];
    const dbStat = fs.statSync(dbDest);
    entries.push({ path: 'db/mtask.db', size: dbStat.size, sha256: await sha256File(dbDest), kind: 'database' });

    const { files, skipped } = walkFiles(srcDir);
    for (const f of files) {
      const rel = safeRel(f.rel);
      const dest = path.join(staging, 'files', ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
      entries.push({ path: `files/${rel}`, size: fs.statSync(dest).size, sha256: await sha256File(dest), kind: 'data' });
    }

    const totals = entries.reduce((acc, e) => ({ files: acc.files + 1, bytes: acc.bytes + e.size }), { files: 0, bytes: 0 });
    const manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      database: { path: 'db/mtask.db', size: dbStat.size },
      totals,
      entries,
      excluded: [
        'backups/**（旧数据库快照）',
        'tmp/**',
        'mtask-test-data/**',
        'tunnel/**（含访问令牌，敏感）',
        'mtask.db-wal/shm、*.bak-*、preupgrade-*.db*',
        '*.log',
      ],
      skipped,
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    runTar(['-czf', path.basename(outAbs), '-C', staging, '.'], path.dirname(outAbs));
    const sha = await sha256File(outAbs);
    fs.writeFileSync(`${outAbs}.sha256`, `${sha}  ${path.basename(outAbs)}\n`, 'utf8');
    const archiveSize = fs.statSync(outAbs).size;
    return {
      ok: true,
      action: 'create',
      archive: outAbs,
      archiveSize,
      archiveSha256: sha,
      manifest: { format: FORMAT, createdAt: manifest.createdAt, files: totals.files, bytes: totals.bytes, skipped: skipped.length },
      durationMs: Date.now() - t0,
    };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 清理失败不覆盖主结果 */ }
  }
}
function listArchive(archive) {
  const dir = path.dirname(archive);
  const base = path.basename(archive);
  const out = runTar(['-tzf', base], dir);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function extractArchive(archive, dest) {
  const dir = path.dirname(archive);
  const base = path.basename(archive);
  fs.mkdirSync(dest, { recursive: true });
  runTar(['-xzf', base, '-C', dest], dir);
}
async function verifyPackage(archivePath) {
  const t0 = Date.now();
  const archive = path.resolve(archivePath);
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(archive)) throw new Error(`归档不存在：${archive}`);
  const archiveSha256 = await sha256File(archive);
  const sidecar = `${archive}.sha256`;
  let sidecarOk = null;
  if (fs.existsSync(sidecar)) {
    const expected = (fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] || '').toLowerCase();
    sidecarOk = expected === archiveSha256;
    if (!sidecarOk) errors.push(`旁车 SHA-256 不一致：期望 ${expected}，实际 ${archiveSha256}`);
  } else {
    warnings.push('缺少 .sha256 旁车文件，仅按归档内 manifest 校验');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-data-verify-'));
  try {
    const names = listArchive(archive);
    for (const name of names) {
      const norm = name.replace(/^\.\//, '');
      if (!norm || norm === '.') continue;
      if (path.isAbsolute(norm) || norm.split('/').some((s) => s === '..')) {
        throw new Error(`归档包含不安全路径：${name}`);
      }
    }
    extractArchive(archive, tmp);
    const manifestPath = path.join(tmp, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('归档缺少 manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.format !== FORMAT || Number(manifest.formatVersion) !== FORMAT_VERSION) {
      throw new Error(`manifest 格式不支持：${manifest.format}/${manifest.formatVersion}`);
    }
    if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error('manifest.entries 为空');
    let verified = 0;
    let bytes = 0;
    for (const e of manifest.entries) {
      const rel = safeRel(String(e.path));
      const abs = path.join(tmp, ...rel.split('/'));
      if (!fs.existsSync(abs)) { errors.push(`文件缺失：${rel}`); continue; }
      const st = fs.statSync(abs);
      if (!st.isFile()) { errors.push(`不是普通文件：${rel}`); continue; }
      if (Number(e.size) !== st.size) errors.push(`大小不一致：${rel}（期望 ${e.size}，实际 ${st.size}）`);
      const actual = await sha256File(abs);
      if (String(e.sha256).toLowerCase() !== actual) errors.push(`SHA-256 不一致：${rel}`);
      verified += 1;
      bytes += st.size;
    }
    const dbEntry = manifest.entries.find((e) => e.path === 'db/mtask.db');
    const dbFile = path.join(tmp, 'db', 'mtask.db');
    let integrity = null;
    if (!dbEntry || !fs.existsSync(dbFile)) {
      errors.push('归档缺少 db/mtask.db');
    } else {
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare('PRAGMA integrity_check').get();
        integrity = row ? Object.values(row)[0] : null;
        if (String(integrity).toLowerCase() !== 'ok') errors.push(`SQLite integrity_check 失败：${integrity}`);
      } finally { db.close(); }
    }
    if (manifest.totals && Number(manifest.totals.files) !== verified) {
      warnings.push(`manifest 文件数与实校验数不一致：${manifest.totals.files} / ${verified}`);
    }
    return {
      ok: errors.length === 0,
      action: 'verify',
      archive,
      archiveSha256,
      sidecar: { present: fs.existsSync(sidecar), ok: sidecarOk },
      manifest: { format: manifest.format, createdAt: manifest.createdAt, files: verified, bytes },
      sqliteIntegrity: integrity,
      errors,
      warnings,
      durationMs: Date.now() - t0,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不覆盖主结果 */ }
  }
}

function help() {
  console.log([
    'T06306 本地数据打包备份 / 完整性校验',
    '',
    '创建：node server/scripts/backup-data-package.mjs [--data-dir <数据目录>] [--out <归档.tar.gz>]',
    '校验：node server/scripts/backup-data-package.mjs --verify <归档.tar.gz>',
    '',
    '默认数据目录：MTask_DATA_DIR > %APPDATA%\\mtask\\data > server/data；',
    '默认输出：<数据目录>/backups/mtask-data-backup-YYYYMMDD-HHMMSS.tar.gz。',
  ].join('\n'));
}

(async () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.mode === 'help') { help(); return; }
    const result = opts.mode === 'verify'
      ? await verifyPackage(opts.archive)
      : await createPackage({ dataDir: opts.dataDir || defaultDataDir(), out: opts.out || defaultOut(opts.dataDir || defaultDataDir()) });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, action: opts?.mode || 'unknown', error: e instanceof Error ? e.message : String(e) }, null, 2));
    process.exit(1);
  }
})();
