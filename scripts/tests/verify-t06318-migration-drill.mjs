#!/usr/bin/env node
/**
 * T06318 迁移数据演练（可重复）
 *
 * 流程：校验旧归档 → 恢复空目录 → 核对业务表 → 插入增量标记 → 二次备份
 *      → 再恢复空目录 → 核验标记与计数。
 *
 * 用法：
 *   node scripts/tests/verify-t06318-migration-drill.mjs --archive <旧备份.tar.gz> [--work <目录>] [--cleanup]
 *
 * 输出 JSON；任一步失败 exit 1。不覆盖生产数据目录，不测试损坏归档。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const backupCli = resolve(root, 'server/scripts/backup-data-package.mjs');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const archive = resolve(arg('archive'));
const work = resolve(arg('work', `${process.env.TEMP || '/tmp'}/t06318-drill-auto-${Date.now()}`));
const cleanup = process.argv.includes('--cleanup');
if (!existsSync(archive)) {
  console.error(JSON.stringify({ ok: false, error: `archive not found: ${archive}` }));
  process.exit(1);
}

function run(args) {
  const raw = execFileSync(process.execPath, [backupCli, ...args], { cwd: root, encoding: 'utf8', timeout: 600_000 });
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(`${args[0]} failed: ${JSON.stringify(parsed.errors)}`);
  return parsed;
}

function counts(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = {
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
      done: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='done'").get().n,
      projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
      plans: db.prepare('SELECT COUNT(*) AS n FROM plan_tasks').get().n,
      requirements: db.prepare('SELECT COUNT(*) AS n FROM prd_requirements').get().n,
      testcases: db.prepare('SELECT COUNT(*) AS n FROM test_cases').get().n,
      execSessions: db.prepare('SELECT COUNT(*) AS n FROM exec_sessions').get().n,
    };
    if (row.integrity !== 'ok') throw new Error(`integrity_check=${row.integrity}`);
    return row;
  } finally {
    db.close();
  }
}

let result;
try {
  mkdirSync(work, { recursive: true });
  const restore1 = resolve(work, 'restore1');
  const restore2 = resolve(work, 'restore2');
  const incremental = resolve(work, 'incremental.tar.gz');
  for (const dir of [restore1, restore2]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  const verify = run(['--verify', archive]);
  const first = run(['--restore', archive, '--target', restore1]);
  const before = counts(resolve(restore1, 'mtask.db'));

  const db = new Database(resolve(restore1, 'mtask.db'), { fileMustExist: true });
  let marker;
  try {
    const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id, task_no, project_id, title, description, priority, status, verified, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'normal', 'todo', 0, 0, ?, ?)`)
      .run('t06318-marker-task', 'T06318-MARK', project.id, 'T06318 增量迁移标记', '迁移演练增量数据', now, now);
    marker = db.prepare("SELECT id, task_no, title, status FROM tasks WHERE id='t06318-marker-task'").get();
    if (!marker) throw new Error('marker insert failed');
  } finally {
    db.close();
  }

  const second = run(['--data-dir', restore1, '--out', incremental]);
  const third = run(['--restore', incremental, '--target', restore2]);
  const after = counts(resolve(restore2, 'mtask.db'));

  const checkDb = new Database(resolve(restore2, 'mtask.db'), { readonly: true, fileMustExist: true });
  let migratedMarker;
  try {
    migratedMarker = checkDb.prepare("SELECT id, task_no, title, status FROM tasks WHERE id='t06318-marker-task'").get();
  } finally {
    checkDb.close();
  }

  const assertions = [
    ['源归档校验 ok', verify.ok === true],
    ['首恢复 SQLite ok', first.restored.sqliteIntegrity === 'ok'],
    ['首恢复文件数与清单一致', first.restored.files === verify.manifest.files],
    ['首恢复字节与清单一致', first.restored.bytes === verify.manifest.bytes],
    ['旧库业务表完整可读', before.tasks > 0 && before.projects > 0],
    ['增量备份 ok', second.ok === true],
    ['增量备份字节增加', second.manifest.bytes > verify.manifest.bytes],
    ['增量恢复 SQLite ok', third.restored.sqliteIntegrity === 'ok'],
    ['标记任务迁移成功', migratedMarker?.task_no === 'T06318-MARK'],
    ['任务数 = 旧库 + 1', after.tasks === before.tasks + 1],
    ['已完成数保持', after.done === before.done],
    ['迁移后完整性 ok', after.integrity === 'ok'],
  ];
  const failed = assertions.filter(([, ok]) => !ok).map(([name]) => name);

  result = {
    ok: failed.length === 0,
    archive,
    archiveSha256: verify.archiveSha256,
    work,
    prior: { files: verify.manifest.files, bytes: verify.manifest.bytes, durationMs: verify.durationMs },
    restore1: first.restored,
    before,
    incremental: { archiveSha256: second.archiveSha256, archiveSize: second.archiveSize, files: second.manifest.files, bytes: second.manifest.bytes },
    restore2: third.restored,
    marker: migratedMarker,
    after,
    assertions: Object.fromEntries(assertions),
    failed,
    cleanup,
  };
  if (failed.length) process.exitCode = 1;
} catch (error) {
  result = { ok: false, error: error.message, work };
  process.exitCode = 1;
} finally {
  if (cleanup && existsSync(work)) rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
