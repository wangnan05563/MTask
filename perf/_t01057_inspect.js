const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true });
try {
  const projs = db.prepare("SELECT id,name FROM projects WHERE COALESCE(history_at,'')='' AND COALESCE(archived,0)=0 ORDER BY created_at").all();
  console.log('projects:', projs.length);
  projs.slice(0,12).forEach(p => console.log('  ', p.id.slice(0,8), p.name));
  const byProj = db.prepare('SELECT project_id, COUNT(*) c FROM tasks WHERE archived=0 GROUP BY project_id').all();
  console.log('tasks by project:', byProj.map(r => r.project_id.slice(0,8)+':'+r.c).join('  '));
  const pend = db.prepare("SELECT task_no,status,ai_state,project_id,title FROM tasks WHERE ai_state IN ('unread','failed') AND archived=0 ORDER BY ai_state_at DESC LIMIT 8").all();
  console.log('pending(unread/failed):', pend.length);
  pend.forEach(t => console.log('  ', t.task_no, t.ai_state, t.status, t.project_id.slice(0,8), t.title.slice(0,30)));
} catch(e) { console.log('ERR', e.message); }
db.close();
