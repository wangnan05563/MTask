/**
 * 全端点压测种子脚本 v3（2026-09-18 轮次）。
 * 用法：node perf/seed/seed-v3.js            # 幂等；已播种则跳过
 *       node perf/seed/seed-v3.js --reset    # 先清空再去播种
 *
 * 相对 v2 的新增（对应 09-13 之后新增的端点）：
 *   - projects.workspace_path：给 proj-main 绑定沙箱工作空间，使 /api/workspace/* 可测
 *   - 生成工作空间文件树（perf/sandbox/ws）：600 个源码/文档文件，用于衡量 FS 检索真实成本
 *   - workspace_symbols：预置 ~4000 行索引，供 /api/workspace/symbols 查询 & LIKE 走查
 *   - prd_docs / prd_requirements / prd_issues：需求跟踪矩阵夹具
 *   - 历史资产快照：projects.history_at 非空的项目 + 其任务/计划，供 /api/history/* 可测
 *
 * 目标库：perf/sandbox/data3（与 data/data2 隔离，绝不触碰生产库 %APPDATA%\mtask\data）
 */
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'sandbox', 'data3');
const WS_DIR = path.join(__dirname, '..', 'sandbox', 'ws');

if (process.argv.includes('--reset') && fs.existsSync(DATA_DIR)) {
  for (const f of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, f), { recursive: true, force: true });
}
process.env.MTask_DATA_DIR = DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

// 复用后端 initSchema 建表（含全部 CREATE TABLE / 索引 / 迁移 / 内置种子），保证与实际运行一致
const { initSchema } = require('../../server/dist/db/schema.js');
initSchema();

const db = new Database(path.join(DATA_DIR, 'mtask.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const t = new Date().toISOString();
const dayMs = 86400000;
const dayAgo = (d) => new Date(Date.now() - d * dayMs).toISOString();
const dayStr = (offset) => new Date(Date.now() + offset * dayMs).toISOString().slice(0, 10);
const P = (n) => String(n).padStart(3, '0');

// ============================================================================
// 0) 工作空间文件树（GET /workspace/search|file 的被测对象）
// ============================================================================
// 注意：必须避开 WorkspaceService.DEFAULT_IGNORE_DIRS（node_modules/dist/build/out/
// release*/coverage/.git/.workbuddy 等），否则文件会被忽略规则过滤掉，测不到真实遍历成本。
function makeWorkspaceTree() {
  if (fs.existsSync(path.join(WS_DIR, 'src'))) {
    let n = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { n++; if (e.isDirectory()) walk(path.join(d, e.name)); } };
    walk(WS_DIR);
    console.log(`[seed-v3] 工作空间已存在（约 ${n} 个条目），跳过生成`);
    return;
  }
  fs.mkdirSync(WS_DIR, { recursive: true });
  const dirs = [];
  const top = ['src', 'lib', 'services', 'docs', 'test', 'scripts', 'assets', 'config', 'internal', 'pkg'];
  for (const a of top) {
    for (let i = 0; i < 4; i++) {
      const d = path.join(WS_DIR, a, `mod${i + 1}`);
      fs.mkdirSync(d, { recursive: true });
      dirs.push({ dir: d, prefix: `${a}/mod${i + 1}` });
    }
  }
  const exts = ['.ts', '.ts', '.ts', '.js', '.md', '.py', '.json', '.yml'];
  let made = 0;
  for (const { dir, prefix } of dirs) {
    for (let f = 0; f < 15; f++) {
      const ext = exts[(f + made) % exts.length];
      const name = `${['handler', 'service', 'util', 'model', 'ctrl', 'index', 'repo', 'type'][f % 8]}_${f}${ext}`;
      const body = [
        `// ${prefix}/${name}`,
        ...Array.from({ length: 40 }, (_, i) =>
          ext === '.md' || ext === '.yml'
            ? `- item ${i}: 压测样例内容 perf-keyword-${f} 说明文本`
            : `export async function fn${i}_${f}(a: number, b: string): Promise<void> { /* line ${i} */ }`),
      ].join('\n');
      fs.writeFileSync(path.join(dir, name), body);
      made++;
    }
  }
  console.log(`[seed-v3] 工作空间文件树生成：${made} 个文件 / ${dirs.length} 个目录 → ${WS_DIR}`);
}
makeWorkspaceTree();

// 幂等哨兵
if (db.prepare("SELECT 1 FROM projects WHERE id = 'proj-main'").get()) {
  console.log('[seed-v3] 已播种，跳过');
  db.close();
  process.exit(0);
}

const insProject = db.prepare('INSERT INTO projects (id,name,description,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?)');
const insTask = db.prepare(
  'INSERT INTO tasks (id,task_no,project_id,title,description,priority,status,verified,archived,archived_at,ai_summary,pinned,category_id,created_at,updated_at,parent_id,user_sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
const insCat = db.prepare('INSERT INTO task_categories (id,name,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?)');
const insTool = db.prepare(
  'INSERT INTO ai_tools (id,name,type,purpose,endpoint,api_key_enc,model,temperature,max_tokens,timeout_ms,enabled,is_default_organize,is_default_develop,remark,console_url,pinned,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
const insQueue = db.prepare('INSERT INTO queues (id,name,date,status,created_at) VALUES (?,?,?,?,?)');
const insQueueJob = db.prepare('INSERT INTO queue_jobs (id,queue_id,task_id,tool_id,order_index,status,request_payload,response_payload,error,sent_at,finished_at,ticket,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insPromptCat = db.prepare('INSERT INTO prompt_categories (id,name,description,sort_weight,builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
const insPrompt = db.prepare('INSERT INTO prompts (id,category_id,title,content,pinned,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
const insReqCat = db.prepare('INSERT INTO req_categories (id,name,sort_weight,created_at,updated_at) VALUES (?,?,?,?,?)');
const insReq = db.prepare('INSERT INTO req_entries (id,category_id,title,content,pinned,sort_weight,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
const insConsole = db.prepare('INSERT INTO console_jobs (id,title,prompt,category,period,status,answer,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insPlan = db.prepare('INSERT INTO plan_tasks (id,project_id,title,description,start_date,end_date,duration_days,progress,status,assignee,sort_order,linked_task_id,archived,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insHoliday = db.prepare('INSERT OR REPLACE INTO holidays (date,name) VALUES (?,?)');
const insUsage = db.prepare('INSERT INTO ai_usage (id,tool_id,tool_name,model,kind,ok,duration_ms,content_chars,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insImage = db.prepare('INSERT INTO task_images (id,task_id,mime_type,data,created_at) VALUES (?,?,?,?,?)');
const insPrdDoc = db.prepare('INSERT INTO prd_docs (id,project_id,filename,content_md,created_at,updated_at) VALUES (?,?,?,?,?,?)');
const insPrdReq = db.prepare('INSERT INTO prd_requirements (id,project_id,req_no,title,content,source_ref,priority,status,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const insPrdIssue = db.prepare('INSERT INTO prd_issues (id,project_id,prd_id,question,answer,status,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
const insSym = db.prepare('INSERT INTO workspace_symbols (id,project_id,path,symbol,line,kind,file_mtime) VALUES (?,?,?,?,?,?,?)');

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
  // 历史资产快照项目（history_at 非空 → /api/history/* 的被测数据，且不出现在常规项目列表）
  for (let i = 1; i <= 6; i++) {
    insProject.run(`proj-hist-${P(i)}`, `历史快照项目-${i}`, '已沉淀为组织过程资产', 500 + i, dayAgo(200 + i * 10), t);
    db.prepare('UPDATE projects SET history_at = ? WHERE id = ?').run(dayAgo(i * 30), `proj-hist-${P(i)}`);
  }
  // T00776：给主项目绑定工作空间（/api/workspace/* 依赖它）
  db.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(WS_DIR, 'proj-main');

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
    insTask.run(id, no, proj, `压测任务-${i}`, `描述-${i}`.repeat((i % 5) + 1),
      i % 4 === 0 ? 'high' : 'normal', i % 3 === 0 ? 'done' : 'todo', i % 5 === 0 ? 1 : 0,
      0, null, null, i % 7 === 0 ? 1 : 0, i % 6 === 0 ? 'cat-perf' : null,
      created, created, null, i <= 50 ? i : null);
  }
  for (let i = 1; i <= 60; i++) {
    insTask.run(`task-a${P(i)}`, `T${String(500 + i).padStart(5, '0')}`, i % 2 === 0 ? 'proj-main' : 'proj-secondary',
      `归档任务-${i}`, `归档描述-${i}`, 'normal', 'done', 0, 1, dayAgo(i), null, 0, null, dayAgo(40 + i), dayAgo(i), null, null);
  }
  for (let i = 1; i <= 5; i++) {
    insTask.run(`task-p-${P(i)}`, `T${String(561 + i - 1).padStart(5, '0')}`, 'proj-main', `父任务-${i}`, 'epic 根', 'high', 'todo', 0, 0, null, null, 0, null, t, t, null, null);
  }
  for (let i = 1; i <= 25; i++) {
    insTask.run(`task-c-${P(i)}`, `T${String(566 + i - 1).padStart(5, '0')}`, 'proj-main', `子任务-${i}`, 'epic 子项',
      'normal', i % 2 ? 'todo' : 'done', 0, 0, null, null, 0, null, t, t, `task-p-${P(((i - 1) % 5) + 1)}`, null);
  }
  // 历史快照项目内的任务（供 /api/history/list 的 N+1 路径构造足够体量）
  for (let i = 1; i <= 6; i++) {
    for (let j = 1; j <= 60; j++) {
      insTask.run(`task-h${P(i)}-${P(j)}`, `T9${i}${P(j)}`, `proj-hist-${P(i)}`, `历史任务-${i}-${j}`,
        `历史任务描述-${i}-${j}`, j % 4 === 0 ? 'high' : 'normal', j % 3 === 0 ? 'done' : 'todo',
        j % 5 === 0 ? 1 : 0, 0, null, null, 0, null, dayAgo(300 + j), dayAgo(300 + j), null, null);
    }
  }

  // ---------------- AI 工具 ----------------
  insTool.run('tool-perf', '压测工具', 'openaiCompat', 'develop', 'http://127.0.0.1:9', null, 'gpt-4o', 0.2, 4096, 60000, 1, 0, 1, '', '', 0, 0, t, t);
  insTool.run('tool-claude', '压测 Claude', 'claude', 'organize', 'http://127.0.0.1:9', null, 'claude-3-5-sonnet', 0.2, 4096, 60000, 1, 1, 0, '', '', 0, 1, t, t);
  insTool.run('tool-ollama', '压测 Ollama', 'ollama', 'develop', 'http://127.0.0.1:9', null, 'qwen2.5', 0.2, 4096, 60000, 1, 0, 0, '', '', 0, 2, t, t);
  insTool.run('tool-perf2', '压测工具-归档', 'openaiCompat', 'develop', 'http://127.0.0.1:9', null, 'gpt-4o', 0.2, 4096, 60000, 1, 0, 0, '', '', 0, 3, dayAgo(5), dayAgo(5));
  db.prepare('UPDATE ai_tools SET archived = 1 WHERE id = ?').run('tool-perf2');
  for (let i = 1; i <= 60; i++) {
    insTool.run(`tool-del-${P(i)}`, `删除夹具工具-${i}`, 'openaiCompat', 'develop', 'http://127.0.0.1:9', null, 'gpt-4o', 0.2, 4096, 60000, 1, 0, 0, '', '', 0, 100 + i, t, t);
  }

  // ---------------- 队列 + 明细 ----------------
  insQueue.run('queue-perf', '压测队列', dayStr(0), 'draft', t);
  insQueue.run('queue-2', '压测队列2', dayStr(-1), 'draft', t);
  insQueue.run('queue-3', '压测队列3', dayStr(-2), 'done', t);
  for (let i = 1; i <= 50; i++) {
    insQueueJob.run(`job-perf-${P(i)}`, 'queue-perf', `task-${String(i).padStart(4, '0')}`, 'tool-perf', i,
      i % 4 === 0 ? 'failed' : 'queued', null, null, null, null, null, null, null);
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
    insPlan.run(`plan-${P(i)}`, 'proj-main', `计划任务-${i}`, `计划描述-${i}`, dayStr(i * 2 - 2), dayStr(i * 2 - 1), 2,
      i % 5 === 0 ? 100 : (i * 7) % 100, i % 5 === 0 ? 'done' : 'todo', i % 3 === 0 ? '张三' : '', i, null, 0, null, t, t);
  }
  for (let i = 1; i <= 10; i++) {
    insPlan.run(`plan-a${P(i)}`, 'proj-main', `归档计划-${i}`, '', dayStr(-30 - i), dayStr(-29 - i), 2, 0, 'todo', '', 200 + i, null, 1, dayAgo(i), t, t);
  }
  for (let i = 1; i <= 40; i++) {
    insPlan.run(`plan-del-${P(i)}`, 'proj-tri', `删除夹具计划-${i}`, '', dayStr(i), dayStr(i + 1), 2, 0, 'todo', '', i, null, 0, null, t, t);
  }
  // 历史快照项目内的计划
  for (let i = 1; i <= 6; i++) {
    for (let j = 1; j <= 20; j++) {
      insPlan.run(`plan-h${P(i)}-${P(j)}`, `proj-hist-${P(i)}`, `历史计划-${i}-${j}`, '', dayStr(-400 + j), dayStr(-399 + j), 2,
        j % 3 === 0 ? 100 : 20, j % 4 === 0 ? 'done' : 'todo', '', j, null, 0, null, dayAgo(300), dayAgo(300));
    }
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
    insUsage.run(`usage-${String(i).padStart(4, '0')}`, tid, tname, tmodel, kinds[i % 4], i % 11 === 0 ? 0 : 1,
      300 + (i % 900), 200 + (i % 1500), i % 11 === 0 ? 'timeout' : null, dayAgo(i % 20));
  }

  // ---------------- 任务图片 ----------------
  for (let i = 1; i <= 10; i++) insImage.run(`img-${String(i).padStart(4, '0')}`, 'task-0001', 'image/png', PNG_1x1, t);

  // ---------------- 需求跟踪矩阵：PRD 文档 / 需求 / 待确认问题 ----------------
  for (let i = 1; i <= 6; i++) {
    const md = Array.from({ length: 120 },
      (_, n) => n === 0 ? `# PRD ${i} 压测文档` : `- 第 ${n} 节：需求背景与目标描述 ${i}-${n}`).join('\n');
    insPrdDoc.run(`prd-${P(i)}`, 'proj-main', `压测PRD-${i}.md`, md, t, t);
  }
  for (let i = 1; i <= 400; i++) {
    insPrdReq.run(`prq-${P(i)}`, 'proj-main', `R-${P(i)}`, `需求项-${i}`,
      `需求描述-${i} `.repeat(4), `PRD-${(i % 6) + 1} 第${(i % 10) + 1}节`,
      ['high', 'normal', 'low'][i % 3], ['todo', 'doing', 'done'][i % 3], i, t, t);
  }
  for (let i = 1; i <= 80; i++) {
    insPrdIssue.run(`pri-${P(i)}`, 'proj-main', `prd-${P((i % 6) + 1)}`,
      `待确认问题-${i}：该功能的边界如何处理？`, i % 4 === 0 ? `结论-${i}` : '',
      i % 4 === 0 ? 'resolved' : 'open', i, t, t);
  }

  // ---------------- 工作空间符号索引（模拟"已建索引"的稳定态） ----------------
  const wsFiles = [];
  for (const a of ['src', 'lib', 'services', 'docs', 'test', 'scripts', 'assets', 'config', 'internal', 'pkg']) {
    for (let m = 1; m <= 4; m++) {
      for (let f = 0; f < 15; f++) {
        wsFiles.push(`${a}/mod${m}/${['handler', 'service', 'util', 'model', 'ctrl', 'index', 'repo', 'type'][f % 8]}_${f}.ts`);
      }
    }
  }
  let sidx = 0;
  for (const pth of wsFiles) {
    for (let k = 0; k < 7; k++) {
      insSym.run(`ws-${String(sidx++).padStart(6, '0')}`, 'proj-main', pth, `fn${k}`, k * 5 + 1, ['function', 'class', 'const'][k % 3], 1700000000);
    }
  }

  // ---------------- 应用设置 ----------------
  db.prepare('INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)').run('defaultNoteProjectId', 'proj-main');
})();

const counts = {};
for (const tbl of ['projects', 'tasks', 'task_categories', 'ai_tools', 'queues', 'queue_jobs', 'prompt_categories',
  'prompts', 'req_categories', 'req_entries', 'plan_tasks', 'holidays', 'console_jobs', 'ai_usage', 'task_images',
  'prd_docs', 'prd_requirements', 'prd_issues', 'workspace_symbols']) {
  try { counts[tbl] = db.prepare(`SELECT COUNT(*) c FROM ${tbl}`).get().c; } catch { counts[tbl] = 'n/a'; }
}
console.log('[seed-v3] 完成:', JSON.stringify(counts));
db.close();
