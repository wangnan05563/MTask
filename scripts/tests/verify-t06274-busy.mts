/**
 * T06274 / EX-18：SQLite 写锁（BUSY）下队列提交不得产生重复外部提交，
 * 队列不卡在 running，锁释放后可人工重试。只跑隔离临时库。
 */
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join('D:/tmp', `t06274-busy-${process.pid}`);
const DATA_DIR = join(TMP, 'data');

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  process.env.MTask_DATA_DIR = DATA_DIR;
  const schema = await import('../../server/src/db/schema.ts');
  schema.initSchema();
  const conn = await import('../../server/src/db/connection.ts');
  const db = conn.getDb();
  const { QueueService } = await import('../../server/src/services/QueueService.ts');

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, description, created_at, updated_at) VALUES ('p-busy', 'BUSY', '', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO ai_tools (id, name, type, purpose, endpoint, model, timeout_ms, enabled, created_at, updated_at)
    VALUES ('busy-tool', 'BUSY tool', 'codex-cli', 'develop', '', '', 3000, 1, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at, archived, ai_state)
    VALUES ('busy-task', 'p-busy', 'BUSY task', 'todo', 'normal', ?, ?, 0, '')`).run(now, now);
  const q = QueueService.create('BUSY 队列', now.slice(0, 10));
  const jobs = QueueService.addJobs(q.id, [{ taskId: 'busy-task', toolId: 'busy-tool' }]);

  const blocker = new Database(join(DATA_DIR, 'mtask.db'));
  blocker.pragma('journal_mode = WAL');
  blocker.exec('BEGIN IMMEDIATE');
  db.pragma('busy_timeout = 0');
  let submitCalls = 0;
  let err = '';
  try {
    await QueueService.submitAll(q.id, async () => {
      submitCalls += 1;
      return { ok: true, content: 'should not submit' };
    });
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  blocker.exec('ROLLBACK');
  blocker.close();
  db.pragma('busy_timeout = 5000');

  const afterBusyQueue = QueueService.getById(q.id);
  const afterBusyJob = QueueService.getJob(jobs[0].id);
  const noDuplicate = submitCalls === 0 && afterBusyJob?.status === 'queued';
  let pass = 0;
  let fail = 0;
  const ok = (cond: boolean, name: string, extra?: unknown) => {
    cond ? (pass += 1) : (fail += 1);
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  };
  console.log('[INFO] busy error:', err);
  ok(/busy|locked/i.test(err), 'EX-18 错误可识别为 SQLite BUSY/locked', { err });
  ok(noDuplicate, 'EX-18 BUSY 时未发生外部提交，job 保持 queued', { submitCalls, queueStatus: afterBusyQueue?.status, jobStatus: afterBusyJob?.status });
  ok(afterBusyQueue?.status !== 'running', 'EX-18 BUSY 后队列不卡在 running', { queueStatus: afterBusyQueue?.status });

  let retried = false;
  try {
    await QueueService.submitAll(q.id, async () => {
      submitCalls += 1;
      return { ok: true, content: 'retry ok' };
    });
    retried = QueueService.getJob(jobs[0].id)?.status === 'success';
  } catch (e) {
    console.log('[INFO] retry error:', e instanceof Error ? e.message : String(e));
  }
  ok(retried, 'EX-18 锁释放后可人工重试成功', { submitCalls, jobStatus: QueueService.getJob(jobs[0].id)?.status });

  console.log(`[t06274-busy] pass=${pass} fail=${fail}`);
  if (fail) process.exitCode = 1;
  try { conn.closeDb(); } catch { /* ignore */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 占用时保留 */ }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
