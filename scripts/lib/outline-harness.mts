/**
 * 大纲段「真链路」夹具（T02293 判据规约第 1、2 条落地件）。
 *
 * 提示词类断言原先一律 `readFileSync('server/src/services/kickoffService.ts')` 再正则匹配中文话术——
 * 等价重构（把话术挪进常量、改一个字、换模板串）就让门恒红，而链路其实没变。本夹具把同一批判据
 * 挪到**发往厂商的请求体**上：门内自建隔离库（自己写夹具，不读生产数据）+ 本机 127.0.0.1 随机端口的
 * OpenAI 兼容桩，跑真 `kickoffOutline` → 真 `AIService.askJson` → 真「首轮严格 / 第 2 轮起转软」协议，
 * 并把每一轮实际发出的 system/user 原文记录下来供断言。零真实配额、零生产库、不起服务。
 *
 * 用法：
 *   const h = await startOutlineHarness({ projectId: 'gate-1', projectName: '门内夹具项目', plans });
 *   const r = await h.run([JSON.stringify(outlineA), JSON.stringify(outlineB)]);
 *   // r.res = kickoffOutline 返回的大纲结果；r.systems = 实际发出的两轮 system 话术
 *   h.close();   // 关桩 → 关库句柄 → 删临时目录（动态 import 自持 SQLite 句柄，不关就删不掉）
 *
 * 纪律：`MTask_DATA_DIR` 在任何 `getDb()` 之前钉死成临时目录；调用方（门脚本）不要在 start 之前
 * 触发过库访问。close 之前不要 process.exit。
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = '2026-10-11T00:00:00.000Z';

export interface HarnessPlanRow {
  id: string;
  title: string;
  start_date: string;
  end_date: string;
  duration_days?: number;
  progress?: number;
  status?: string;
  assignee?: string;
  sort_order?: number;
  kind?: string;
  complexity?: number | null;
}

export interface HarnessOptions {
  projectId: string;
  projectName: string;
  plans: HarnessPlanRow[];
  /** 需求矩阵行数（P2 硬门只看条数，默认 14 条足以让预检判 ok） */
  reqCount?: number;
  prdFilename?: string;
  prdContentMd?: string;
  /** 工作空间路径：给一个真实目录可让 P4 判 ok，不给则记 warn（不阻塞生成） */
  workspacePath?: string;
}

export interface OutlineRunResult {
  /** `kickoffOutline` 的返回（outline / warnings / projectName / dataAsOf …） */
  res: any;
  /** 每一轮**实际发往厂商**的 system 话术（首轮 + 自动重试轮） */
  systems: string[];
  /** 每一轮实际发出的 user 段（【资料齐备性】与【样例事实】在这里） */
  users: string[];
  /** 厂商被打扰的次数——首轮合规应为 1，首轮被判失败应为 2 */
  asks: number;
}

export interface OutlineHarness {
  dataDir: string;
  toolId: string;
  run(replies: string[], projectId?: string): Promise<OutlineRunResult>;
  close(): void;
}

export async function startOutlineHarness(o: HarnessOptions): Promise<OutlineHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'outline-harness-'));
  process.env.MTask_DATA_DIR = dataDir;
  const DB = await import('../../server/src/db/connection.ts');
  const { initSchema } = await import('../../server/src/db/schema.ts');
  const SVC = await import('../../server/src/services/kickoffService.ts');
  initSchema();
  const db = DB.getDb();

  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(o.projectId, o.projectName, '', NOW, NOW);
  if (o.workspacePath) db.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(o.workspacePath, o.projectId);
  db.prepare('INSERT INTO prd_docs (id, project_id, filename, content_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`${o.projectId}-prd`, o.projectId, o.prdFilename ?? 'PRD-门内夹具.md',
      o.prdContentMd ?? '# 背景\n门内自造的口径来源说明，够预检 P1 判定即可。', NOW, NOW);
  const insReq = db.prepare(
    `INSERT INTO prd_requirements (id, project_id, req_no, title, content, source_ref, priority, status, sort_order, created_at, updated_at, prd_id)
     VALUES (?, ?, ?, ?, '', '', 'normal', ?, ?, ?, ?, ?)`,
  );
  const reqCount = o.reqCount ?? 14;
  for (let i = 0; i < reqCount; i++) {
    insReq.run(`${o.projectId}-r${i}`, o.projectId, `R${i + 1}`, `需求 ${i + 1}`, i < Math.ceil(reqCount / 2) ? 'done' : 'doing', i, NOW, NOW, `${o.projectId}-prd`);
  }
  const insPlan = db.prepare(
    `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days, progress, status,
       assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '')`,
  );
  o.plans.forEach((p, i) => insPlan.run(
    p.id, o.projectId, p.title, p.start_date, p.end_date, p.duration_days ?? 5, p.progress ?? 0,
    p.status ?? 'todo', p.assignee ?? '', p.sort_order ?? i, NOW, NOW, p.kind ?? 'normal', p.complexity ?? 3));

  /** mock OpenAI 兼容桩：记录每轮实际发出的话术，回复内容按场景排队给 */
  const requests: Array<{ system: string; user: string }> = [];
  let queue: string[] = [];
  const mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { messages?: Array<{ role: string; content: string }> };
      requests.push({ system: body.messages?.[0]?.content ?? '', user: body.messages?.[1]?.content ?? '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: queue.shift() ?? '[]' }, finish_reason: 'stop' }],
        usage: { total_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const toolId = `${o.projectId}-mock-tool`;
  db.prepare(
    `INSERT INTO ai_tools (id, name, type, purpose, endpoint, api_key_enc, model, temperature, max_tokens, timeout_ms, enabled, created_at, updated_at)
     VALUES (?, ?, 'openai-compatible', 'develop', ?, NULL, 'mock-outline', 0, 4096, 20000, 1, ?, ?)`,
  ).run(toolId, `${o.projectId}-mock`, `http://127.0.0.1:${(mock.address() as { port: number }).port}`, NOW, NOW);

  return {
    dataDir,
    toolId,
    async run(replies: string[], projectId?: string): Promise<OutlineRunResult> {
      requests.length = 0;
      queue = replies.slice();
      const res = await SVC.kickoffOutline(projectId ?? o.projectId, toolId);
      return { res, systems: requests.map((m) => m.system), users: requests.map((m) => m.user), asks: requests.length };
    },
    close(): void {
      mock.close();
      DB.closeDb();
      for (let i = 0; i < 10; i++) {
        try { rmSync(dataDir, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
      }
    },
  };
}
