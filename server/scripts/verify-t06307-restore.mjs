/**
 * T06307（REQ-039）备份恢复与完整性测试。
 *
 * 覆盖：备份 → 恢复到空目录 → DB/业务文件逐项复核 → 恢复报告 →
 *       非空目录拒绝覆盖 → 损坏归档拒绝落盘。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't06307-fixture-'));
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
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

try {
  const dataDir = path.join(TMP, 'data');
  fs.mkdirSync(path.join(dataDir, 'artifacts', 'card'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'templates'), { recursive: true });

  const db = new Database(path.join(dataDir, 'mtask.db'));
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT);');
  db.prepare('INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)').run('T-1', '恢复验证任务', 'todo');
  db.prepare('INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)').run('T-2', '已完成任务', 'done');
  db.close();
  fs.writeFileSync(path.join(dataDir, 'artifacts', 'card', 'evidence.txt'), 'restore-evidence\n');
  fs.writeFileSync(path.join(dataDir, 'templates', 't.json'), '{"name":"tpl"}\n');

  const pkg = path.join(TMP, 'data.tar.gz');
  const created = run(['--data-dir', dataDir, '--out', pkg]);
  say('T06307-01 备份包生成', created.status === 0 && created.json?.ok === true, created.json);

  const verify = run(['--verify', pkg]);
  say('T06307-02 恢复前完整性校验通过', verify.status === 0 && verify.json?.ok === true && verify.json?.sqliteIntegrity === 'ok', verify.json);

  const target = path.join(TMP, 'restored');
  const restored = run(['--restore', pkg, '--target', target]);
  say('T06307-03 备份恢复到空目录', restored.status === 0 && restored.json?.ok === true, restored.json);
  say('T06307-04 恢复报告写入目标目录', fs.existsSync(path.join(target, 'restore-report.json')), { report: fs.existsSync(path.join(target, 'restore-report.json')) });

  const rdb = new Database(path.join(target, 'mtask.db'), { readonly: true, fileMustExist: true });
  const rows = rdb.prepare('SELECT id, title, status FROM tasks ORDER BY id').all();
  const integrity = rdb.prepare('PRAGMA integrity_check').get();
  rdb.close();
  say('T06307-05 恢复后数据库内容一致', rows.length === 2 && rows[0].title === '恢复验证任务' && rows[1].status === 'done', { rows });
  say('T06307-06 恢复后 SQLite 完整性通过', String(Object.values(integrity)[0]).toLowerCase() === 'ok', { integrity });
  const restoredArtifact = fs.readFileSync(path.join(target, 'artifacts', 'card', 'evidence.txt'), 'utf8');
  say('T06307-07 恢复后业务文件字节一致', restoredArtifact === 'restore-evidence\n' && sha(path.join(target, 'artifacts', 'card', 'evidence.txt')) === sha(path.join(dataDir, 'artifacts', 'card', 'evidence.txt')), { restoredArtifact });
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'restore-report.json'), 'utf8'));
  say('T06307-08 恢复报告记录归档哈希与文件数', manifest.archiveSha256 === sha(pkg) && manifest.errors.length === 0 && manifest.files === 3, manifest);

  const nonEmpty = path.join(TMP, 'non-empty');
  fs.mkdirSync(nonEmpty, { recursive: true });
  fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'keep');
  const refused = run(['--restore', pkg, '--target', nonEmpty]);
  say('T06307-09 非空目录拒绝覆盖', refused.status !== 0 && refused.json?.ok === false && /非空/.test(refused.json?.error || ''), refused.json);
  say('T06307-10 拒绝后原目录内容未被改写', fs.readdirSync(nonEmpty).length === 1 && fs.readFileSync(path.join(nonEmpty, 'keep.txt'), 'utf8') === 'keep', { entries: fs.readdirSync(nonEmpty) });

  const corrupted = path.join(TMP, 'corrupted.tar.gz');
  fs.copyFileSync(pkg, corrupted);
  fs.copyFileSync(`${pkg}.sha256`, `${corrupted}.sha256`);
  const buf = fs.readFileSync(corrupted);
  buf[buf.length - 2] = (buf[buf.length - 2] ^ 0xff);
  fs.writeFileSync(corrupted, buf);
  const corruptTarget = path.join(TMP, 'corrupt-target');
  const refuseCorrupt = run(['--restore', corrupted, '--target', corruptTarget]);
  say('T06307-11 损坏归档拒绝恢复', refuseCorrupt.status !== 0 && refuseCorrupt.json?.ok === false && (refuseCorrupt.json?.errors || []).some((e) => /归档校验未通过/.test(e)), refuseCorrupt.json);
  say('T06307-12 校验失败不落盘', !fs.existsSync(corruptTarget) || fs.readdirSync(corruptTarget).length === 0, { exists: fs.existsSync(corruptTarget) });

  const missingTarget = run(['--restore', pkg]);
  say('T06307-13 缺少目标目录拒绝恢复', missingTarget.status !== 0 && /缺少目标目录/.test(missingTarget.json?.error || ''), missingTarget.json);
} catch (e) {
  say('T06307-ERR 测试异常', false, String(e?.stack || e));
} finally {
  const pass = checks.filter((x) => x.ok).length;
  const fail = checks.filter((x) => !x.ok).length;
  console.log(JSON.stringify({ pass, fail, tmp: TMP }, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(fail === 0 ? 0 : 1);
}
