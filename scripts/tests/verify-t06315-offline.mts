/**
 * T06315 离线逻辑验证（REQ-073 / PRD §A5）：
 * ① 断网捕获 → 本地草稿队列（localStorage），刷新后仍可回放；
 * ② 旧 exec_session → Run 兼容回放（合成 3 步、稳定 ID、成本不伪造）。
 *
 * 边界：不测联网后的 flushDrafts 同步链路（任务明确「不测试同步」）。
 * 数据：临时 SQLite + 内存 localStorage；不碰生产库/浏览器真实磁盘。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = mkdtempSync(join(tmpdir(), 't06315-offline-'));
process.env.MTask_DATA_DIR = DATA;

class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}
const storage = new MemStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
(globalThis as any).location = { protocol: 'http:', href: 'http://localhost/index.html?m=1' };
(globalThis as any).document = { baseURI: 'http://localhost/index.html' };
let fetchCalls = 0;
(globalThis as any).fetch = async () => { fetchCalls += 1; throw new TypeError('Failed to fetch (simulated offline)'); };

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass += 1; else fail += 1;
  const tail = cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 500)}`;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${tail}`);
  console.log(lines[lines.length - 1]);
};

const offline = await import(pathToFileURL(join(ROOT, 'web/src/mobile/offline.ts')).href);
const payload = {
  title: '离线捕获 T06315',
  description: '断网场景写入草稿队列',
  priority: 'high',
  projectId: 'p-t06315-offline',
  images: ['data:image/png;base64,AA=='],
};
let threw = false;
try {
  await offline.submitQuickNote(payload);
} catch {
  threw = true; // QuickNote.submit 的真实 catch 分支：addDraft(payload)
}
const draft = offline.addDraft(payload);
ok('T06315-01 断网提交失败（fetch 真实拒绝）', threw && fetchCalls === 1, { threw, fetchCalls });
ok('T06315-02 捕获内容进入本地草稿队列', draft.saved === true && offline.loadDrafts().length === 1, { saved: draft.saved, drafts: offline.loadDrafts().length });
const saved = offline.loadDrafts()[0];
ok('T06315-03 草稿字段完整（标题/描述/优先级/项目/图片/时间）', saved?.title === payload.title
  && saved?.description === payload.description && saved?.priority === 'high' && saved?.projectId === payload.projectId
  && Array.isArray(saved?.images) && saved.images.length === 1 && Boolean(saved?.createdAt), saved);
ok('T06315-04 草稿可从存储重新回放（刷新等价）', storage.getItem('mtask.mobileDrafts')?.includes('离线捕获 T06315') === true,
  { rawLen: storage.getItem('mtask.mobileDrafts')?.length });
const second = offline.addDraft({ title: '离线第二条', priority: 'normal' });
const ids = offline.loadDrafts().map((d: any) => d.id);
ok('T06315-05 多条草稿按新到旧排列且 id 唯一', ids.length === 2 && ids[0] === second.id && new Set(ids).size === 2, ids);
offline.removeDraft(second.id);
ok('T06315-06 单条草稿可移除', offline.loadDrafts().length === 1 && offline.loadDrafts()[0].id === draft.id);
offline.clearDrafts();
ok('T06315-07 草稿队列可清空', offline.loadDrafts().length === 0);

// ---------- Run 旧数据回放 ----------
const schema = await import(pathToFileURL(join(ROOT, 'server/src/db/schema.ts')).href);
schema.initSchema();
const { getDb } = await import(pathToFileURL(join(ROOT, 'server/src/db/connection.ts')).href);
const db = getDb();
const { RunTraceService } = await import(pathToFileURL(join(ROOT, 'server/src/services/RunTraceService.ts')).href);
const now = new Date().toISOString();
const SESSION = 'sess-t06315-legacy';
db.prepare('DELETE FROM exec_sessions WHERE id = ?').run(SESSION);
db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p-t06315-run', 'T06315 Run 回放', now, now);
db.prepare('INSERT INTO tasks (id, task_no, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('task-t06315-run', 'T06315-RUN', 'p-t06315-run', 'Run 回放夹具', 'todo', now, now);
db.prepare(`INSERT INTO exec_sessions
  (id, platform, session_id, task_ids, status, progress, progress_reported, phase, last_heartbeat, started_at, finished_at)
  VALUES (?, 'workbuddy', ?, ?, 'done', 100, 1, ?, ?, ?, ?)`)
  .run(SESSION, 'wb-t06315', JSON.stringify(['task-t06315-run']), '执行完成', now, now, now);
const svc = new RunTraceService(db);
const run = svc.getRun(`legacy:exec_session:${SESSION}`);
ok('T06315-08 旧会话可回放且稳定 legacy ID', run?.id === `legacy:exec_session:${SESSION}` && run?.source === 'legacy_exec_session' && run?.legacy === true,
  { id: run?.id, source: run?.source });
ok('T06315-09 回放 3 个合成步骤（观察/观察/决策）', run?.steps?.length === 3
  && run.steps.map((s: any) => s.seq).join(',') === '0,1,2'
  && run.steps.map((s: any) => s.type).join(',') === 'observation,observation,decision'
  && run.steps.every((s: any) => s.synthetic === true), run?.steps?.map((s: any) => `${s.seq}:${s.type}:${s.status}`));
ok('T06315-10 回放不伪造成本/Token/审批', run?.cost === 0 && run?.tokens === 0
  && run?.stepCostTotal === 0 && run?.unattributedCost === 0 && run?.approval?.status === 'none', { cost: run?.cost, tokens: run?.tokens, approval: run?.approval?.status });
ok('T06315-11 旧数据缺口以 warning 明示', Array.isArray(run?.warnings) && run.warnings.length >= 2
  && run.warnings.some((w: string) => w.includes('合成')) && run.warnings.some((w: string) => w.includes('未记录模型成本')), run?.warnings);
const replayA = svc.getRun(SESSION);
ok('T06315-12 直接传 session id 与 legacy: 前缀回放一致', replayA?.id === run?.id
  && JSON.stringify(replayA?.steps) === JSON.stringify(run?.steps), { id: replayA?.id });
const replayB = svc.getRun(`legacy:exec_session:${SESSION}`);
ok('T06315-13 重复回放幂等（步骤序列逐字稳定）', JSON.stringify(replayB?.steps) === JSON.stringify(run?.steps)
  && replayB?.taskNo === 'T06315-RUN' && replayB?.status === 'succeeded', { taskNo: replayB?.taskNo, status: replayB?.status });
ok('T06315-14 不存在的旧会话返回 null（不伪造 Run）', svc.getRun('legacy:exec_session:missing-t06315') === null);

db.close();
rmSync(DATA, { recursive: true, force: true });
const summary = `PASS=${pass} FAIL=${fail}\nT06315 离线捕获草稿 + Run 旧数据回放\n${lines.join('\n')}\n`;
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
