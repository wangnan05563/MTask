/**
 * 全端点压测种子脚本 v2（幂等，可重复执行）。
 * 用法：node perf/seed/seed-v2.js
 *
 * 与 seed.js 的区别：seed.js 只覆盖早期 31 个端点的夹具；本脚本为「全部可测 API 端点」
 * 铺齐确定性夹具（项目/任务/归档/父子/分类/队列+jobs/AI工具/提示词/通用需求/项目计划/
 * 节假日/控制台任务/AI用量/任务图片），并显式写入 task_no，使 /tasks/by-no/:taskNo 可定位。
 *
 * 目标库：perf/sandbox/data2（与 data 隔离，绝不触碰生产库 %APPDATA%\mtask\data 与 39877 实例）。
 */
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'sandbox', 'data2');
process.env.MTask_DATA_DIR = DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

// 复用后端 initSchema 建表（含全部 CREATE TABLE / 索引 / 迁移 / 内置种子）
const { initSchema } = require('../../server/dist/db/schema.js');
initSchema();

const db = new Database(path.join(DATA_DIR, 'mtask.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const t = new Date().toISOString();
const dayMs = 86400000;
const dayAgo = (d) => new Date(Date.now() - d * dayMs).toISOString();
// 生成 YYYY-MM-DD（相对今天 +offset 天，用于计划/节假日）
const dayStr = (offset) => new Date(Date.now() + offset * dayMs).toISOString().slice(0, 10);

// 幂等：以 proj-main 为哨兵
if (db.prepare("SELECT 1 FROM projects WHERE id = 'proj-main'").get()) {
  console.log('[seed-v2] 已播种，跳过');
  db.close();
  process.exit(0);
}

const P = (n) => String(n).padStart(3, '0');

const insProject = db.prepare('INSERT INTO projects (id,name,description,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?)');
const insTask = db.prepare(
  'INSERT INTO tasks (id,task_no,project_id,title,description,priority,status,verified,archived,archived_at,ai_summary,pinned,category_id,created_at,updated_at,parent_id,user_sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
const insCat = db.prepare('INSERT INTO task_categories (id,name,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?)');
const insTool = db.prepare(
  'INSERT INTO ai_tools (id,name,type,purpose,endpoint,api_key_enc,model,temperature,max_tokens,timeout_ms,enabled,is_default_organize,is_default_develop,remark,console_url,pinned,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
const insQueue = db.prepare('INSERT INTO queues (id,name,date,status,created_at) VALUES (?,?,?,?,?)');
const insPromptCat = db.prepare('INSERT INTO prompt_categories (id,name,description,sort_weight,builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
const insPrompt = db.prepare('INSERT INTO prompts (id,category_id,title,content,pinned,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
const insReqCat = db.prepare('INSERT INTO req_categories (id,name,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?)');
const insReq = db.prepare('INSERT INTO req_entries (id,category_id,title,content,pinned,sort_weight,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
const insConsole = db.prepare('INSERT INTO console_jobs (id,title,prompt,category,period,status,answer,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insPlan = db.prepare('INSERT INTO plan_tasks (id,project_id,title,description,start_date,end_date,duration_days,progress,status,assignee,sort_order,linked_task_id,archived,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insHoliday = db.prepare('INSERT OR REPLACE INTO holidays (date,name) VALUES (?,?)');
const insUsage = db.prepare('INSERT INTO ai_usage (id,tool_id,tool_name,model,kind,ok,duration_ms,content_chars,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insImage = db.prepare('INSERT INTO task_images (id,task_id,mime_type,data,created_at) VALUES (?,?,?,?,?)');

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

db.transaction(() => {
  // ---------------- 项目 ----------------
  insProject.run('proj-main', '压测主项目', '全端点压测主项目', 0, t, t);
  insProject.run('proj-secondary', '压测副项目', '', 1, t, t);
  insProject.run('proj-tri', '压测第三项目', '', 2, t, t);
  for (let i = 1; i <= 60; i++) insProject.run(`proj-del-${P(i)}`, `删除夹具项目-${i}`, '', 90 + i, t, t);

  // ---------------- 分类 ----------------
  insCat.run('cat-perf', '压测分类', 0, t, t);
  for (let i = 1; i <= 4; i++) insCat.run(`cat-extra-${P(i)}`, `辅助分类-${i}`, i, t, t);
  for (let i = 1; i <= 60; i++) insCat.run(`cat-del-${P(i)}`, `删除夹具分类-${i}`, 100 + i, t, t);

  // ---------------- 任务（活跃 500 + 归档 60 + 父子 30）----------------
  for (let i = 1; i <= 500; i++) {
    const id = `task-${String(i).padStart(4, '0')}`;
    const no = `T${String(i).padStart(5, '0')}`;
    const proj = i <= 300 ? 'proj-main' : 'proj-secondary';
    const created = dayAgo(i % 30);
    insTask.run(
      id, no, proj, `压测任务-${i}`, `描述-${i}`.repeat((i % 5) + 1),
      i % 4 === 0 ? 'high' : 'normal',
      i % 3 === 0 ? 'done' : 'todo',
      i % 5 === 0 ? 1 : 0,
      0, null, null,
      i % 7 === 0 ? 1 : 0,
      i % 6 === 0 ? 'cat-perf' : null,
      created, created, null,
      i <= 50 ? i : null,
    );
  }
  // 归档任务（供归档列表 / 还原 / 归档删除）
  for (let i = 1; i <= 60; i++) {
    const id = `task-a${P(i)}`;
    const no = `T${String(500 + i).padStart(5, '0')}`;
    insTask.run(id, no, i % 2 === 0 ? 'proj-main' : 'proj-secondary', `归档任务-${i}`, `归档描述-${i}`,
      'normal', 'done', 0, 1, dayAgo(i), null, 0, null, dayAgo(40 + i), dayAgo(i), null, null);
  }
  // 父子层级夹具（父 5 + 子 25）
  for (let i = 1; i <= 5; i++) {
    const no = `T${String(561 + i - 1).padStart(5, '0')}`;
    insTask.run(`task-p-${P(i)}`, no, 'proj-main', `父任务-${i}`, 'epic 根', 'high', 'todo', 0, 0, null, null, 0, null, t, t, null, null);
  }
  for (let i = 1; i <= 25; i++) {
    const no = `T${String(566 + i - 1).padStart(5, '0')}`;
    const parent = `task-p-${P(((i - 1) % 5) + 1)}`;
    insTask.run(`task-c-${P(i)}`, no, 'proj-main', `子任务-${i}`, 'epic 子项', 'normal', i % 2 ? 'todo' : 'done', 0, 0, null, null, 0, null, t, t, parent, null);
  }

  // ---------------- AI 工具 ----------------
  insTool.run('tool-perf', '压测工具', 'openaiCompat', 'develop', 'http://127.0.0.1:9', null, 'gpt-4o', 0.2, 4096, 60000, 1, 0, 1, '', '', 0, 0, t, t);
  insTool.run('tool-claude', '压测 Claude', 'claude', 'organize', 'http://127.0.0.1:9', null, 'claude-3-5-sonnet', 0.2, 4096, 60000, 1, 1, 0, '', '', 0, 1, t, t);
  insTool.run('tool-ollama', '压测 Ollama', 'ollama', 'develop', 'http://127.0.0.1:9', null, 'qwen2.5', 0.2, 4096, 60000, 1, 0, 0, '', '', 0, 2, t, t);
  for (let i = 1; i <= 60; i++) {
    insTool.run(`tool-del-${P(i)}`, `删除夹具工具-${i}`, 'openaiCompat', 'develop', 'http://127.0.0.1:9', null, 'gpt-4o', 0.2, 4096, 60000, 1, 0, 0, '', '', 0, 100 + i, t, t);
  }

  // ---------------- 队列 + 明细 ----------------
  insQueue.run('queue-perf', '压测队列', dayStr(0), 'draft', t);
  insQueue.run('queue-2', '压测队列2', dayStr(-1), 'draft', t);
  insQueue.run('queue-3', '压测队列3', dayStr(-2), 'done', t);
  for (let i = 1; i <= 50; i++) {
    insQueueJobSafe(i);
  }
  function insQueueJobSafe(i) {
    db.prepare(
      'INSERT INTO queue_jobs (id,queue_id,task_id,tool_id,order_index,status,request_payload,response_payload,error,sent_at,finished_at,ticket,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(`job-perf-${P(i)}`, 'queue-perf', `task-${String(i).padStart(4, '0')}`, 'tool-perf', i, i % 4 === 0 ? 'failed' : 'queued', null, null, null, null, null, null, null);
  }

  // ---------------- 提示词仓库 ----------------
  insPromptCat.run('cat-prompt-perf', '压测提示词分类', '', 0, 0, t, t);
  insPromptCat.run('cat-prompt-2', '压测提示词分类2', '', 1, 0, t, t);
  for (let i = 1; i <= 40; i++) insPromptCat.run(`cat-prompt-del-${P(i)}`, `删除夹具提示词分类-${i}`, '', 100 + i, 0, t, t);
  insPrompt.run('prompt-perf', 'cat-prompt-perf', '压测提示词', '# 压测提示词\n内容', 0, 0, t, t);
  for (let i = 1; i <= 39; i++) insPrompt.run(`prompt-${P(i)}`, 'cat-prompt-perf', `提示词-${i}`, `提示词内容-${i}`, i % 9 === 0 ? 1 : 0, i, t, t);
  for (let i = 1; i <= 60; i++) insPrompt.run(`prompt-del-${P(i)}`, 'cat-prompt-perf', `删除夹具提示词-${i}`, 'x', 0, 200 + i, t, t);

  // ---------------- 通用需求仓库 ----------------
  insReqCat.run('req-cat-perf', '压测需求分类', 0, t, t);
  insReqCat.run('req-cat-2', '压测需求分类2', 1, t, t);
  for (let i = 1; i <= 40; i++) insReqCat.run(`req-cat-del-${P(i)}`, `删除夹具需求分类-${i}`, 100 + i, t, t);
  insReq.run('req-perf', 'req-cat-perf', '压测需求', '# 压测通用需求\n内容', 0, 0, '', t, t);
  for (let i = 1; i <= 39; i++) insReq.run(`req-${P(i)}`, 'req-cat-perf', `需求条目-${i}`, `需求内容-${i}`, i % 8 === 0 ? 1 : 0, i, '', t, t);
  for (let i = 1; i <= 60; i++) insReq.run(`req-del-${P(i)}`, 'req-cat-perf', `删除夹具需求-${i}`, 'x', 0, 200 + i, '', t, t);

  // ---------------- 项目计划 ----------------
  for (let i = 1; i <= 40; i++) {
    const start = dayStr(i * 2 - 2);
    const end = dayStr(i * 2 - 1);
    insPlan.run(`plan-${P(i)}`, 'proj-main', `计划任务-${i}`, `计划描述-${i}`, start, end, 2, i % 5 === 0 ? 100 : (i * 7) % 100, i % 5 === 0 ? 'done' : 'todo', i % 3 === 0 ? '张三' : '', i, null, 0, null, t, t);
  }
  for (let i = 1; i <= 10; i++) {
    insPlan.run(`plan-a${P(i)}`, 'proj-main', `归档计划-${i}`, '', dayStr(-30 - i), dayStr(-29 - i), 2, 0, 'todo', '', 200 + i, null, 1, dayAgo(i), t, t);
  }
  for (let i = 1; i <= 40; i++) {
    insPlan.run(`plan-del-${P(i)}`, 'proj-tri', `删除夹具计划-${i}`, '', dayStr(i), dayStr(i + 1), 2, 0, 'todo', '', i, null, 0, null, t, t);
  }

  // ---------------- 节假日 ----------------
  insHoliday.run('2026-01-01', '元旦');
  insHoliday.run('2026-02-17', '春节');
  insHoliday.run('2026-05-01', '劳动节');
  insHoliday.run('2026-10-01', '国庆节');
  insHoliday.run('2026-12-25', '删除夹具节假日');

  // ---------------- 控制台任务 ----------------
  for (let i = 1; i <= 30; i++) {
    insConsole.run(`console-${P(i)}`, `控制台任务-${i}`, `分析提示-${i}`, 'custom', 'week', 'done', `分析结果-${i}`, null, dayAgo(i % 15), dayAgo(i % 15));
  }

  // ---------------- AI 用量 ----------------
  const kinds = ['organize', 'report', 'classify', 'chat'];
  const tools = [['tool-perf', '压测工具', 'gpt-4o'], ['tool-claude', '压测 Claude', 'claude-3-5-sonnet'], ['tool-ollama', '压测 Ollama', 'qwen2.5']];
  for (let i = 1; i <= 400; i++) {
    const [tid, tname, tmodel] = tools[i % 3];
    insUsage.run(`usage-${String(i).padStart(4, '0')}`, tid, tname, tmodel, kinds[i % 4], i % 11 === 0 ? 0 : 1, 300 + (i % 900), 200 + (i % 1500), i % 11 === 0 ? 'timeout' : null, dayAgo(i % 20));
  }

  // ---------------- 任务图片 ----------------
  for (let i = 1; i <= 10; i++) insImage.run(`img-${String(i).padStart(4, '0')}`, 'task-0001', 'image/png', PNG_1x1, t);

  // ---------------- 应用设置 ----------------
  db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)').run('defaultNoteProjectId', 'proj-main');
})();

const counts = {};
for (const tbl of ['projects', 'tasks', 'task_categories', 'ai_tools', 'queues', 'queue_jobs', 'prompt_categories', 'prompts', 'req_categories', 'req_entries', 'plan_tasks', 'holidays', 'console_jobs', 'ai_usage', 'task_images']) {
  counts[tbl] = db.prepare(`SELECT COUNT(*) c FROM ${tbl}`).get().c;
}
console.log('[seed-v2] 完成:', JSON.stringify(counts));
db.close();
