// 种子脚本：向沙箱独立库写入固定数据集（幂等，可重复执行）。
// 用法：node perf/seed/seed.js [沙箱库绝对路径]
// 固定 id 供 JMX fixtures 引用；任务日期分散在最近 30 天，保证周/月报表有数据。
const Database = require('better-sqlite3');
const path = require('node:path');

// 复用后端 initSchema 建表：先让 connection.getDb 指向沙箱库，再建表/播种
process.env.MTask_DATA_DIR = path.join(__dirname, '..', 'sandbox', 'data');
const { initSchema } = require('../../server/dist/db/schema.js');
initSchema();

const DB_PATH = process.env.MTask_DATA_DIR + '/mtask.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const t = new Date().toISOString();
const dayMs = 86400000;
const iso = (d) => new Date(Date.now() - d * dayMs).toISOString();

// 幂等：已播种则跳过（避免重复执行污染固定数据集）
if (db.prepare("SELECT 1 FROM projects WHERE id = 'proj-main'").get()) {
  console.log('[seed] 已播种，跳过');
  db.close();
  process.exit(0);
}

const ins = db.prepare('INSERT INTO projects (id,name,description,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?)');
const insTask = db.prepare(
  'INSERT INTO tasks (id,project_id,title,description,priority,status,verified,archived,archived_at,ai_summary,pinned,category_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
);

db.transaction(() => {
  ins.run('proj-main', '压测主项目', '', 0, t, t);
  ins.run('proj-secondary', '压测副项目', '', 1, t, t);

  // 500 任务：主项目 300 + 副项目 200；created_at 分布在最近 30 天
  for (let i = 1; i <= 500; i++) {
    const id = 'task-' + String(i).padStart(4, '0');
    const proj = i <= 300 ? 'proj-main' : 'proj-secondary';
    const created = iso(i % 30);
    insTask.run(id, proj, `压测任务-${i}`, `描述-${i}`.repeat((i % 5) + 1),
      i % 4 === 0 ? 'high' : 'normal', i % 3 === 0 ? 'done' : 'todo',
      i % 5 === 0 ? 1 : 0, 0, null, null, 0, null, created, created);
  }

  db.prepare('INSERT INTO task_categories (id,name,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('cat-perf', '压测分类', 0, t, t);

  db.prepare('INSERT INTO queues (id,name,date,status,created_at) VALUES (?,?,?,?,?)')
    .run('queue-perf', '压测队列', '2026-08-28', 'draft', t);

  db.prepare('INSERT INTO prompt_categories (id,name,description,sort_weight,builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('cat-prompt-perf', '压测提示词分类', '', 0, 0, t, t);
  db.prepare('INSERT INTO prompts (id,category_id,title,content,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('prompt-perf', 'cat-prompt-perf', '压测提示词', 'perf content', 0, t, t);

  db.prepare(
    'INSERT INTO ai_tools (id,name,type,purpose,endpoint,api_key_enc,model,temperature,max_tokens,timeout_ms,enabled,is_default_organize,is_default_develop,remark,console_url,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('tool-perf', '压测工具', 'openaiCompat', 'develop', 'http://127.0.0.1:9', null,
    'gpt-4o', 0.2, 4096, 60000, 1, 0, 0, '', '', 0, t, t);

  db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)')
    .run('defaultNoteProjectId', 'proj-main');
})();

const c = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
console.log(`[seed] 完成 tasks=${c} projects=2 cat/queue/prompt/tool=1`);
db.close();
