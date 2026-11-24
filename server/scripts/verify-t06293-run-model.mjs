import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * T06293 验证：在内存库中执行 src/db/agentRunSchema.ts 的增量 DDL，覆盖
 * 幂等建表、外键动作、CHECK 约束、步骤序号唯一、级联删除与旧表不变。
 *
 * 运行：node server/scripts/verify-t06293-run-model.mjs
 */
const source = readFileSync(new URL('../src/db/agentRunSchema.ts', import.meta.url), 'utf8');
const match = source.match(/const AGENT_RUN_SCHEMA_SQL = `([\s\S]*?)`;/);
if (!match) throw new Error('未找到 AGENT_RUN_SCHEMA_SQL');
if (match[1].includes('${')) throw new Error('DDL 不应包含模板插值，验证脚本必须执行字面 SQL');
const initSource = readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8');
if (!/import \{ ensureAgentRunSchema \} from '\.\/agentRunSchema';/.test(initSource) ||
    !/ensureAgentRunSchema\(\);/.test(initSource)) {
  throw new Error('initSchema 未接入 ensureAgentRunSchema');
}

const ddl = match[1];
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT);
  CREATE TABLE queues (id TEXT PRIMARY KEY);
`);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const expectThrow = (fn, label) => {
  let message = '';
  try {
    fn();
  } catch (e) {
    message = String(e.message);
  }
  assert(/constraint|foreign key/i.test(message), `${label} 应当被约束拦截，实际：${message || '未抛错'}`);
};
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const indexes = () =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_agent_run%' ORDER BY name").all().map((r) => r.name);

try {
  const oldTasksBefore = JSON.stringify(columns('tasks'));
  db.exec(ddl);
  db.exec(ddl); // 重入：不得因表/索引已存在而失败

  assert(columns('agent_runs').length === 19, `agent_runs 列数应为 19，实际 ${columns('agent_runs').length}`);
  assert(columns('agent_run_steps').length === 12, `agent_run_steps 列数应为 12，实际 ${columns('agent_run_steps').length}`);
  const indexNames = indexes();
  assert(indexNames.length === 8, `应有 8 个 Run 索引，实际 ${indexNames.length}: ${indexNames.join(',')}`);
  assert(indexNames.includes('idx_agent_runs_legacy'), '缺少旧数据映射唯一索引');
  assert(JSON.stringify(columns('tasks')) === oldTasksBefore, '增量建表不应修改旧 tasks 表');

  const fks = db.prepare('PRAGMA foreign_key_list(agent_runs)').all();
  const fkByColumn = Object.fromEntries(fks.map((fk) => [fk.from, fk]));
  assert(fkByColumn.task_id?.on_delete === 'CASCADE', 'task_id 应 ON DELETE CASCADE');
  assert(fkByColumn.project_id?.on_delete === 'CASCADE', 'project_id 应 ON DELETE CASCADE');
  assert(fkByColumn.queue_id?.on_delete === 'SET NULL', 'queue_id 应 ON DELETE SET NULL');
  assert(fkByColumn.parent_run_id?.on_delete === 'SET NULL', 'parent_run_id 应 ON DELETE SET NULL');
  const stepFk = db.prepare('PRAGMA foreign_key_list(agent_run_steps)').all().find((fk) => fk.from === 'run_id');
  assert(stepFk?.on_delete === 'CASCADE', 'run_id 应 ON DELETE CASCADE');

  db.exec(`
    INSERT INTO projects(id) VALUES ('p1');
    INSERT INTO tasks(id, project_id) VALUES ('t1', 'p1');
    INSERT INTO queues(id) VALUES ('q1');
    INSERT INTO agent_runs(id, task_id, project_id, queue_id, status, trigger_type, model, prompt_version,
                            tokens, cost, executor, started_at, created_at, updated_at)
    VALUES ('r1', 't1', 'p1', 'q1', 'running', 'queue', 'gpt-5.2', 'v1',
            42, 0.0123, 'agent:dev', '2026-11-24T03:10:00Z', '2026-11-24T03:09:59Z', '2026-11-24T03:10:00Z');
    INSERT INTO agent_run_steps(id, run_id, seq, type, status, input, output, duration_ms, cost, risk_level, created_at, updated_at)
    VALUES ('s1', 'r1', 0, 'tool', 'succeeded', '{"cmd":"ls"}', 'ok', 120, 0.0001, 'R1',
            '2026-11-24T03:10:00Z', '2026-11-24T03:10:01Z');
  `);

  expectThrow(() => db.exec("INSERT INTO agent_runs(id, task_id, project_id, status, created_at, updated_at) VALUES ('badStatus','t1','p1','nope','x','x')"), '非法 Run 状态');
  expectThrow(() => db.exec("INSERT INTO agent_runs(id, task_id, project_id, created_at, updated_at) VALUES ('badTask','missing','p1','x','x')"), '任务外键');
  expectThrow(() => db.exec("INSERT INTO agent_runs(id, task_id, project_id, legacy_source, legacy_ref, created_at, updated_at) VALUES ('badLegacy','t1','p1','queue_job','','x','x')"), 'legacy 来源与引用必须成对');
  expectThrow(() => db.exec("INSERT INTO agent_runs(id, task_id, project_id, tokens, cost, created_at, updated_at) VALUES ('negCost','t1','p1',-1,-0.1,'x','x')"), '负 token / 成本');
  expectThrow(() => db.exec("INSERT INTO agent_run_steps(id, run_id, seq, type, status, risk_level, created_at, updated_at) VALUES ('dupSeq','r1',0,'prompt','pending','R0','x','x')"), '同 Run 步骤序号唯一');
  expectThrow(() => db.exec("INSERT INTO agent_run_steps(id, run_id, seq, type, status, risk_level, duration_ms, created_at, updated_at) VALUES ('badRisk','r1',1,'prompt','pending','R9',-1,'x','x')"), '非法风险等级 / 负时长');

  db.exec("INSERT INTO agent_runs(id, task_id, project_id, legacy_source, legacy_ref, created_at, updated_at) VALUES ('legacy1','t1','p1','queue_job','job-1','x','x')");
  expectThrow(() => db.exec("INSERT INTO agent_runs(id, task_id, project_id, legacy_source, legacy_ref, created_at, updated_at) VALUES ('legacy2','t1','p1','queue_job','job-1','x','x')"), '旧记录合成映射幂等');
  db.exec("INSERT INTO agent_runs(id, task_id, project_id, created_at, updated_at) VALUES ('native1','t1','p1','x','x')");
  db.exec("INSERT INTO agent_runs(id, task_id, project_id, created_at, updated_at) VALUES ('native2','t1','p1','x','x')");

  db.exec("INSERT INTO agent_runs(id, task_id, project_id, queue_id, created_at, updated_at) VALUES ('rq','t1','p1','q1','x','x')");
  db.exec("DELETE FROM queues WHERE id='q1'");
  assert(db.prepare("SELECT queue_id FROM agent_runs WHERE id='rq'").get().queue_id === null, '删除队列后 Run 的 queue_id 应为 NULL');

  db.exec("INSERT INTO agent_runs(id, task_id, project_id, created_at, updated_at) VALUES ('parent','t1','p1','x','x')");
  db.exec("INSERT INTO agent_runs(id, task_id, project_id, parent_run_id, created_at, updated_at) VALUES ('child','t1','p1','parent','x','x')");
  db.exec("DELETE FROM agent_runs WHERE id='parent'");
  assert(db.prepare("SELECT parent_run_id FROM agent_runs WHERE id='child'").get().parent_run_id === null, '删除父 Run 后子 Run 的 parent_run_id 应为 NULL');

  db.exec("DELETE FROM agent_runs WHERE id='r1'");
  assert(db.prepare("SELECT count(*) AS n FROM agent_run_steps WHERE run_id='r1'").get().n === 0, '删除 Run 应级联删除步骤');

  db.exec("DELETE FROM tasks WHERE id='t1'");
  assert(db.prepare('SELECT count(*) AS n FROM agent_runs').get().n === 0, '删除任务应级联删除其 Run');
  assert(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('agent_runs','agent_run_steps')").get().n === 2, '两张增量表应存在');

  console.log(JSON.stringify({
    status: 'PASS',
    tables: ['agent_runs', 'agent_run_steps'],
    columns: { agent_runs: 19, agent_run_steps: 12 },
    indexes: indexNames.length,
    checks: ['idempotent', 'fk-actions', 'check-constraints', 'unique-step-seq', 'legacy-idempotency', 'cascade', 'old-table-unchanged'],
  }, null, 2));
} finally {
  db.close();
}
