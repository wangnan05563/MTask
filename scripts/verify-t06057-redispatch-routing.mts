/**
 * T06057 门：重试派发路由——MCP 拉取平台归位就绪池，仅中继平台才走 relayToolId。
 *
 * 判据腿：
 * A workbuddy（MCP 拉取）重试：不调用中继、ok=true/state=ready、任务归位就绪池；
 * B 已声明中继平台但缺 relayToolId：结构化 reason=relay_not_configured，任务仍就绪；
 * C 其他 MCP 拉取平台（doubao/qcoder）同样不走中继；
 * D 源码锚点：redispatchSession 先判 isRelayPlatform；前端把配置缺失翻译为设置页指引。
 * DATA_DIR 必须模块顶层设置。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = 'D:/code/otherProjects/MTask';
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP = `D:/tmp/t06057-${process.pid}`;
const DATA_DIR = join(TMP, 'data');
process.env.MTask_DATA_DIR = DATA_DIR;

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 3000)}`}`);
};

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const schema = await import('../server/src/db/schema.ts');
  schema.initSchema();
  const conn = await import('../server/src/db/connection.ts');
  const db = conn.getDb();
  const { ExecSessionService } = await import('../server/src/services/ExecSessionService.ts');
  const { setSetting } = await import('../server/src/services/AppSettings.ts');

  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) VALUES ('sys-inbox', '门体项目', '', ?, ?)`).run(now, now);

  const mkTask = (id: string) => {
    db.prepare(`INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at, archived, ai_state, monitor_ready)
      VALUES (?, 'sys-inbox', ?, 'todo', 'normal', ?, ?, 0, 'running', 0)`).run(id, `任务-${id}`, now, now);
    db.prepare('UPDATE tasks SET task_no = ? WHERE id = ?').run(`T${id}`, id);
  };
  const mkSession = (id: string, platform: string, taskId: string) => {
    db.prepare(`INSERT INTO exec_sessions (id, platform, session_id, task_ids, status, progress, phase, last_heartbeat, started_at, finished_at)
      VALUES (?, ?, ?, ?, 'stalled', 40, '执行中', ?, ?, NULL)`)
      .run(id, platform, `sess-${id}`, JSON.stringify([taskId]), now, now);
  };
  const taskState = (id: string) => db.prepare('SELECT ai_state, monitor_ready, exec_session_id, monitor_retry FROM tasks WHERE id = ?').get(id) as
    { ai_state: string; monitor_ready: number; exec_session_id: string | null; monitor_retry: number };

  // 默认无中继平台、无中继工具
  setSetting('supervisor.relayPlatforms', '');
  setSetting('supervisor.relayToolId', '');

  // ---- A workbuddy 走 MCP 就绪池 ----
  mkTask('wb');
  mkSession('wb-sess', 'workbuddy', 'wb');
  const rWb = await ExecSessionService.redispatchSession('wb-sess');
  const eWb = rWb.entries[0];
  ok('A-01 workbuddy 重试不报中继缺失：ok=true / state=ready',
    rWb.ok === true && eWb.dispatched === true && eWb.ok === true && eWb.state === 'ready', rWb);
  ok('A-02 文案明确走 MCP 拉取、不出现「不支持 MCP」',
    String(eWb.detail).includes('MCP 拉取') && !String(eWb.detail).includes('不支持 MCP'), eWb);
  const wbState = taskState('wb');
  ok('A-03 任务归位就绪池：ai_state 清空、monitor_ready=1、解绑会话、retry+1',
    wbState.ai_state === '' && wbState.monitor_ready === 1 && wbState.exec_session_id === null && wbState.monitor_retry === 1, wbState);

  // ---- B 中继平台缺 relayToolId：结构化配置缺失 ----
  setSetting('supervisor.relayPlatforms', 'wb-relay');
  mkTask('relay');
  mkSession('relay-sess', 'wb-relay', 'relay');
  const rRelay = await ExecSessionService.redispatchSession('relay-sess');
  const eRelay = rRelay.entries[0];
  ok('B-01 中继平台缺工具：ok=false / state=ready / reason=relay_not_configured',
    rRelay.ok === false && eRelay.dispatched === true && eRelay.ok === false && eRelay.state === 'ready'
    && eRelay.reason === 'relay_not_configured', eRelay);
  ok('B-02 提示可操作：指向设置页「监督与审计」与 relayToolId',
    String(eRelay.detail).includes('监督与审计') && String(eRelay.detail).includes('relayToolId'), eRelay);
  const relayState = taskState('relay');
  ok('B-03 配置缺失仍保留就绪：ai_state 清空、monitor_ready=1、retry+1',
    relayState.ai_state === '' && relayState.monitor_ready === 1 && relayState.monitor_retry === 1, relayState);

  // ---- C 其他 MCP 平台同样不走中继 ----
  setSetting('supervisor.relayPlatforms', '');
  mkTask('db');
  mkSession('db-sess', 'doubao', 'db');
  const rDb = await ExecSessionService.redispatchSession('db-sess');
  ok('C-01 doubao 重试归位就绪池（不要求 relayToolId）',
    rDb.ok === true && rDb.entries[0].ok === true && rDb.entries[0].state === 'ready', rDb);
  mkTask('qd');
  mkSession('qd-sess', 'qoder', 'qd');
  const rQd = await ExecSessionService.redispatchSession('qd-sess');
  ok('C-02 qoder 重试归位就绪池（不要求 relayToolId）',
    rQd.ok === true && rQd.entries[0].ok === true && rQd.entries[0].state === 'ready', rQd);

  // ---- D 源码锚点 ----
  const svc = readFileSync(join(ROOT, 'server/src/services/ExecSessionService.ts'), 'utf8');
  const relay = readFileSync(join(ROOT, 'server/src/services/RelayDispatchService.ts'), 'utf8');
  const page = readFileSync(join(ROOT, 'web/src/pages/ExecSessionsPage.tsx'), 'utf8');
  ok('D-01 重派先判 isRelayPlatform，非中继分支 armReady 后 continue',
    svc.includes('if (!isRelayPlatform(row.platform))') && svc.includes('armReady(taskId, row.platform)'));
  ok('D-02 中继缺工具返回 relay_not_configured 且提示设置页',
    relay.includes("reason: 'relay_not_configured'") && relay.includes('监督与审计'));
  ok('D-03 前端把 relay_not_configured 翻译为可操作指引',
    page.includes("e.reason === 'relay_not_configured'") && page.includes('待配置中继工具') && page.includes('supervisor.relayToolId'));

  db.close();
}

main().catch((e) => {
  fail += 1;
  lines.push(`[FAIL] 门体异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
}).finally(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 回收失败不改变判据 */ }
  console.log(lines.join('\n'));
  console.log(`T06057 重试派发路由门：PASS=${pass} FAIL=${fail}`);
  writeGateResults(OUT_DIR, 't06057-gate-results.txt', lines.join('\n'), { dataDir: DATA_DIR });
  globalThis.process.exitCode = fail === 0 ? 0 : 1;
});
