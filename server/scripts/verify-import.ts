/**
 * 验证 SettingsService.importBundle 的 keep/merge 修复（含 app_settings 的 key 主键分支）。
 * 用 tsx 运行源码，避开外部 report 重构导致的整仓 tsc 类型错误。
 */
process.env.MTask_DATA_DIR = require('node:fs').mkdtempSync(require('node:os').tmpdir() + '/vimp-');

import { initSchema } from '../src/db/schema';
import { getDb } from '../src/db/connection';
import { exportBundle, importBundle } from '../src/services/SettingsService';

initSchema();
const db = getDb();

// 种子：项目 + 任务 + 一条 app_settings（KV）
db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)')
  .run('p1', 'P', '', new Date().toISOString(), new Date().toISOString());
db.prepare('INSERT INTO tasks (id, project_id, title, description, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run('t1', 'p1', 'T', '', 'high', 'todo', new Date().toISOString(), new Date().toISOString());
db.prepare("INSERT INTO app_settings (key, value) VALUES ('defaultNoteProjectId', 'p1')").run();

const b = exportBundle();
let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

// 种子已全量存在：keep 应幂等跳过（不得再报 no such column: id），merge 应全部以 update 处理成功
let keepR, mergeR;
try { keepR = importBundle(b, 'keep'); } catch (e) { console.log('KEEP_EXC:', e.message); }
try { mergeR = importBundle(b, 'merge'); } catch (e) { console.log('MERGE_EXC:', e.message); }
check('keep: 不再抛 no such column: id', !!keepR);
check('keep: 幂等（已有主键 skipped）', keepR?.imported === 0);
check('keep: 数据未丢失', db.prepare("SELECT COUNT(*) c FROM tasks").get().c === 1);
check('merge: 不抛错', !!mergeR);
console.log(`keep imported=${keepR?.imported} merge imported=${mergeR?.imported}`);

console.log(`\nsettings 修复验证：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);