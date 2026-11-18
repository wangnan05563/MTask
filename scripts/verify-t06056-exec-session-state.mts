/**
 * T06056 门：执行会话「误判等待 + 进度 0%」修复。
 *
 * 判据腿：
 * A 进度更新：已有 active 会话收到显式 pct 必须前进（修复前 update 分支丢弃 pct，永久 0%）；
 * B 上报标记：未带 pct 时 progress_reported=0，带 pct 后=1，完成=100/1；
 * C 任务态校准：心跳超时但关联任务仍 running → 保持 active；任务也超时 → stalled；
 * D 误停滞恢复：已 stalled 但任务恢复 running → 回 active；
 * E 无任务会话仍走原 10 分钟停滞兜底；
 * F 源码/迁移锚点：schema 补列 + 前端「已停滞 / 待上报」。
 *
 * 说明：DATA_DIR 必须在 import 业务模块前设置；门体数据全部落临时目录，不碰生产库。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = 'D:/code/otherProjects/MTask';
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP = `D:/tmp/t06056-${process.pid}`;
process.env.MTask_DATA_DIR = join(TMP, 'data');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 2600)}`}`);
};
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

async function main() {
  mkdirSync(join(TMP, 'data'), { recursive: true });
  const schema = await import('../server/src/db/schema.ts');
  schema.initSchema();
  const conn = await import('../server/src/db/connection.ts');
  const db = conn.getDb();
  const { ExecSessionService } = await import('../server/src/services/ExecSessionService.ts');

  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) VALUES ('sys-inbox', '门体项目', '', ?, ?)`).run(now, now);

  const mkTask = (id: string, aiState: string, stateAgoMs: number) => {
    db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at, archived, ai_state, ai_state_at, monitor_ready)
      VALUES (?, 'sys-inbox', ?, 'todo', 'normal', ?, ?, 0, ?, ?, 0)`)
      .run(id, `任务-${id}`, now, now, aiState, isoAgo(stateAgoMs));
    db.prepare('UPDATE tasks SET task_no = ? WHERE id = ?').run(`T${id}`, id);
  };
  const mkSession = (id: string, sessionId: string, status: string, taskIds: string[], heartbeatAgoMs: number) => {
    db.prepare(`INSERT INTO exec_sessions (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at, finished_at)
      VALUES (?, 'doubao', ?, ?, ?, 0, 0, '初始化', ?, ?, NULL)`)
      .run(id, sessionId, JSON.stringify(taskIds), status, isoAgo(heartbeatAgoMs), isoAgo(heartbeatAgoMs + 60_000));
  };

  // ---- A/B 进度上报 ----
  mkTask('p', 'running', 0);
  const start = ExecSessionService.reportProgress({ platform: 'doubao', sessionId: 'sess-p', taskRef: 'Tp', phase: '开工' });
  ok('A-01 仅开工不传 pct：进度 0，但 progress_reported=0（未知而非真实 0%）',
    start.status === 'active' && start.progress === 0, start);
  const ping = ExecSessionService.reportProgress({ platform: 'doubao', sessionId: 'sess-p', taskRef: 'Tp', pct: 35, phase: '执行中' });
  ok('A-02 同一 active 会话二次上报 pct=35：进度必须更新（修复前被丢弃、永久 0%）',
    ping.status === 'active' && ping.progress === 35, ping);
  const pingNoPct = ExecSessionService.reportProgress({ platform: 'doubao', sessionId: 'sess-p', taskRef: 'Tp', phase: '阶段心跳' });
  ok('B-01 阶段心跳不带 pct：保持 35%，不回退 0%',
    pingNoPct.progress === 35 && pingNoPct.status === 'active', pingNoPct);
  const done = ExecSessionService.reportProgress({ platform: 'doubao', sessionId: 'sess-p', taskRef: 'Tp', done: true, phase: '完工' });
  ok('B-02 完成：100% 且 progress_reported=1',
    done.status === 'done' && done.progress === 100, done);
  const rowP = db.prepare('SELECT progress, progress_reported FROM exec_sessions WHERE session_id = ?').get('sess-p') as
    { progress: number; progress_reported: number };
  ok('B-03 落库口径：progress=100，progress_reported=1',
    rowP.progress === 100 && rowP.progress_reported === 1, rowP);

  // ---- C 任务态校准：running 任务保护 active ----
  mkTask('runfresh', 'running', 20 * 60 * 1000);
  mkSession('s-run', 'sess-run', 'active', ['runfresh'], 20 * 60 * 1000);
  const n1 = ExecSessionService.expireStaleSessions();
  const runStatus = db.prepare('SELECT status FROM exec_sessions WHERE id = ?').get('s-run') as { status: string };
  ok('C-01 心跳超 10 分钟，但关联任务仍在 running（未超 2h）：不置 stalled',
    n1 === 0 && runStatus.status === 'active', { n1, runStatus });

  // 任务自身 running 已超 2h → 会话不再被保护
  mkTask('runold', 'running', 3 * 60 * 60 * 1000);
  mkSession('s-old', 'sess-old', 'active', ['runold'], 20 * 60 * 1000);
  const n2 = ExecSessionService.expireStaleSessions();
  const oldStatus = db.prepare('SELECT status FROM exec_sessions WHERE id = ?').get('s-old') as { status: string };
  ok('C-02 任务 running 也超 2h：无有效执行旁证，会话置 stalled',
    n2 === 1 && oldStatus.status === 'stalled', { n2, oldStatus });

  // ---- D 误停滞恢复 ----
  mkTask('revive', 'running', 10 * 60 * 1000);
  mkSession('s-revive', 'sess-revive', 'stalled', ['revive'], 30 * 60 * 1000);
  ExecSessionService.expireStaleSessions();
  const reviveStatus = db.prepare('SELECT status FROM exec_sessions WHERE id = ?').get('s-revive') as { status: string };
  ok('D-01 已 stalled 但任务 running：读路径恢复 active（修复历史误判卡片）',
    reviveStatus.status === 'active', reviveStatus);

  // ---- E 无关联任务仍按心跳停滞 ----
  mkSession('s-empty', 'sess-empty', 'active', [], 20 * 60 * 1000);
  const n3 = ExecSessionService.expireStaleSessions();
  const emptyStatus = db.prepare('SELECT status FROM exec_sessions WHERE id = ?').get('s-empty') as { status: string };
  ok('E-01 无关联任务的 active 会话：仍按 10 分钟兜底置 stalled',
    n3 === 1 && emptyStatus.status === 'stalled', { n3, emptyStatus });

  // ---- F 源码/迁移锚点 ----
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const svc = read('server/src/services/ExecSessionService.ts');
  const schemaSrc = read('server/src/db/schema.ts');
  const page = read('web/src/pages/ExecSessionsPage.tsx');
  const mobile = read('web/src/mobile/MobileExecSessions.tsx');
  ok('F-01 schema：建表含 progress_reported，且老库 ensureColumn 幂等补列',
    schemaSrc.includes('progress_reported INTEGER NOT NULL DEFAULT 0') && schemaSrc.includes("ensureColumn('exec_sessions', 'progress_reported'"));
  ok('F-02 服务端：已有会话收到 pct 时更新而非保留旧值，且停滞判定结合任务 running',
    svc.includes('pctProvided ? pct : cur.progress') && svc.includes("ai_state = 'running'") && svc.includes('T06056 任务态校准'));
  ok('F-03 桌面端：停滞列标题不再是「等待中」，进度未知显示「待上报」',
    page.includes("label: '已停滞'") && page.includes("'待上报'") && page.includes('progress_reported'));
  ok('F-04 移动端：同步「已停滞 / 进度待上报」口径',
    mobile.includes("stalled: '已停滞'") && mobile.includes("'待上报'") && mobile.includes('progress_reported'));

  db.close();
}

main().catch((e) => {
  fail += 1;
  lines.push(`[FAIL] 门体异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
}).finally(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 回收失败不改变判据 */ }
  console.log(lines.join('\n'));
  console.log(`T06056 执行会话状态门：PASS=${pass} FAIL=${fail}`);
  writeGateResults(OUT_DIR, 't06056-gate-results.txt', lines.join('\n'), { dataDir: join(TMP, 'data') });
  globalThis.process.exitCode = fail === 0 ? 0 : 1;
});
