/**
 * T06306（REQ-039）数据打包备份契约测试。
 *
 * 覆盖：真实 SQLite 在线备份 → tar.gz 生成 → manifest 逐文件校验 →
 *       敏感/临时/旧快照排除 → 旁车哈希 → 归档内哈希篡改必须失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'backup-data-package.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't06306-fixture-'));
const checks = [];
const say = (name, ok, extra) => {
  checks.push({ name, ok: Boolean(ok), extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 1200)}`}`);
};
const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { /* 保留原文 */ }
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), json };
};
const tar = (args, cwd) => spawnSync('tar', args, { cwd, encoding: 'utf8', windowsHide: true });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

try {
  const dataDir = path.join(TMP, 'data');
  fs.mkdirSync(path.join(dataDir, 'artifacts', 'card'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'tunnel'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });

  const db = new Database(path.join(dataDir, 'mtask.db'));
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);');
  db.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run('T-1', '备份夹具任务');
  db.close();

  fs.writeFileSync(path.join(dataDir, 'artifacts', 'card', 'a.txt'), 'artifact-body\n');
  fs.writeFileSync(path.join(dataDir, 'templates', 't.json'), '{"name":"tpl"}\n');
  fs.writeFileSync(path.join(dataDir, 'tunnel', 'secret.json'), '{"token":"must-not-leak"}\n');
  fs.writeFileSync(path.join(dataDir, 'backups', 'mtask-backup-20200101-000000.db'), 'old-snapshot');
  fs.writeFileSync(path.join(dataDir, 'tmp', 'junk.txt'), 'junk');
  fs.writeFileSync(path.join(dataDir, 'server.log'), 'log');

  const pkg = path.join(TMP, 'mtask-data-backup-test.tar.gz');
  const created = run(['--data-dir', dataDir, '--out', pkg]);
  say('T06306-01 备份归档生成', created.status === 0 && created.json?.ok === true && fs.existsSync(pkg), created.json || created);
  say('T06306-02 旁车 SHA-256 与归档一致', fs.existsSync(`${pkg}.sha256`) && fs.readFileSync(`${pkg}.sha256`, 'utf8').trim().split(/\s+/)[0] === sha(pkg), { sidecar: fs.existsSync(`${pkg}.sha256`) });

  const listed = tar(['-tzf', path.basename(pkg)], path.dirname(pkg)).stdout.split(/\r?\n/).filter(Boolean);
  const has = (n) => listed.some((x) => x === n || x === `./${n}`);
  say('T06306-03 归档含 manifest/db/业务数据', has('manifest.json') && has('db/mtask.db') && has('files/artifacts/card/a.txt') && has('files/templates/t.json'), { entries: listed.slice(0, 12) });
  say('T06306-D 排除敏感目录/临时文件/旧快照/日志', !has('files/tunnel/secret.json') && !has('files/backups/mtask-backup-20200101-000000.db') && !has('files/tmp/junk.txt') && !has('files/server.log'), { entries: listed.slice(0, 12) });
  say('T06306-05 备份归档可完整校验', run(['--verify', pkg]).json?.ok === true, run(['--verify', pkg]).json);

  const tampered = path.join(TMP, 'tampered.tar.gz');
  fs.copyFileSync(pkg, tampered);
  fs.copyFileSync(`${pkg}.sha256`, `${tampered}.sha256`);
  const buf = fs.readFileSync(tampered);
  buf[buf.length - 2] = (buf[buf.length - 2] ^ 0xff);
  fs.writeFileSync(tampered, buf);
  const badSidecar = run(['--verify', tampered]);
  say('T06306-06 篡改归档被旁车哈希拦截', badSidecar.status !== 0 && badSidecar.json?.ok === false && (badSidecar.json?.errors || []).some((e) => /SHA-256/.test(e)), badSidecar.json);

  const extractDir = path.join(TMP, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  const ex = tar(['-xzf', path.basename(pkg), '-C', extractDir], path.dirname(pkg));
  if (ex.status !== 0) throw new Error(`解包失败：${ex.stderr}`);
  const manifestPath = path.join(extractDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const artifactEntry = manifest.entries.find((e) => e.path === 'files/artifacts/card/a.txt');
  artifactEntry.sha256 = '0'.repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const badInternal = path.join(TMP, 'bad-internal.tar.gz');
  const re = tar(['-czf', path.basename(badInternal), '-C', extractDir, '.'], path.dirname(badInternal));
  if (re.status !== 0) throw new Error(`重打包失败：${re.stderr}`);
  const internal = run(['--verify', badInternal]);
  say('T06306-07 归档内 manifest 哈希被逐文件校验拦截', internal.status !== 0 && (internal.json?.errors || []).some((e) => /SHA-256 不一致/.test(e)), internal.json);
  say('T06306-08 SQLite integrity_check 参与校验', internal.json?.sqliteIntegrity === 'ok', { integrity: internal.json?.sqliteIntegrity });
} catch (e) {
  say('T06306-ERR 测试异常', false, String(e?.stack || e));
} finally {
  const pass = checks.filter((x) => x.ok).length;
  const fail = checks.filter((x) => !x.ok).length;
  console.log(JSON.stringify({ pass, fail, tmp: TMP }, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(fail === 0 ? 0 : 1);
}
