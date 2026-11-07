/**
 * T04572 验收门：技能脚本 merge 通道「先判后写」——二次执行不得把同一结论在母单叠加两遍。
 *
 * work order 锚定词（R-318，均为本仓/技能包真实存在的路径与词形）：
 *   `scripts/verify/T04546-merge-revision-gate.mts`（服务端同族判据的门，本门与其并行）
 *   `alreadyMerged` / `mergedContentMatches` / `refreshMergedBody`（服务端单源判据）
 *   `派生单回填` / `未回灌` / `mcp-direct-call.py`（技能脚本补录通道）
 *
 * 守的行为（整链真实执行，不读源码凑绿）：
 *   A 组：默认 dry-run——只打印拟写入的节 + 差异，母单逐字不动、派生单不归档（R-333 不写母单）；
 *   B 组：`--write` 先判后写——首次追加；同内容二次执行回「未重复追加」且母单字节数不变；
 *         修订结论只在原节就地刷新（不新挂第二节）；自动通道【…】标题与补录 ## 标题可互相识别；
 *   C 组：变异探针——把内容判据短路成「恒不等价」，二次执行不再出现「未重复追加」（用例转红）；
 *   D 组：单源守卫——脚本侧判据命名与服务端 derivedOrigin.ts 同构，锚定词与既有门在位。
 *
 * 前置：隔离后端（MTask_DATA_DIR=<tmp>/data、MTask_PORT=<空闲端口>），脚本经
 *       MTASK_MCP_URL / MTASK_SESSION_FILE 指向该临时实例，不触碰用户生产库与生产会话。
 * 运行：node D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/verify/T04572-merge-script-gate.mts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${String(JSON.stringify(extra)).slice(0, 320)}`}`);
};
const group = (t: string) => console.log(`\n—— ${t} ——`);

const REPO = process.cwd();
const NODE = process.env.MTASK_NODE || (existsSync('D:/code/nodejs24/node.exe') ? 'D:/code/nodejs24/node.exe' : process.execPath);
const PY = process.env.MTASK_PYTHON || 'python';
const SCRIPT = process.env.MTASK_MERGE_SCRIPT
  || path.join(os.homedir(), '.qoder-cn', 'skills', 'mtask', 'scripts', 'mcp-direct-call.py');
const KEEP = process.env.T04572_KEEP === '1';

if (!existsSync(SCRIPT)) {
  console.error(`merge 脚本不存在：${SCRIPT}（可用 MTASK_MERGE_SCRIPT 覆盖）`);
  process.exit(1);
}

const root = mkdtempSync(path.join(os.tmpdir(), 't04572-gate-'));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const DB_FILE = path.join(dataDir, 'mtask.db');
const SESSION_FILE = path.join(root, 'mcp-session.txt');
const serverLog = path.join(root, 'server.log');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolve(p));
  });
});

let server: ChildProcess | null = null;
const stopServer = async () => {
  if (!server) return;
  const child = server;
  server = null;
  child.kill();
  await sleep(400);
  // 兜底：node --import tsx 是单进程，kill 未退时再补一刀；不按映像名杀（会误伤用户实例）
  if (child.pid && child.exitCode === null) {
    try { process.kill(child.pid); } catch { /* 已退出 */ }
  }
};
process.on('exit', () => { try { server?.kill(); } catch { /* ignore */ } });

const json = async <T = any>(r: Response): Promise<T> => {
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.url}：${JSON.stringify(body).slice(0, 300)}`);
  return body as T;
};

async function waitHealth(base: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch { /* 端口未就绪 */ }
    await sleep(400);
  }
  throw new Error(`隔离后端未就绪（${ms}ms）：${base}`);
}

/** 读母单 handle_result / 派生单归档态：只读连接，绝不写库 */
function readRow(taskId: string): { handle_result: string | null; archived: number } {
  const db = new Database(DB_FILE, { readonly: true });
  try {
    db.pragma('busy_timeout = 5000');
    return (db.prepare('SELECT handle_result, archived FROM tasks WHERE id = ?').get(taskId)
      ?? { handle_result: null, archived: 0 }) as { handle_result: string | null; archived: number };
  } finally {
    db.close();
  }
}

interface MergeRun { code: number | null; out: string; }
function runMerge(scriptPath: string, derivedNo: string, originNo: string, mdPath: string, write: boolean, mcpUrl: string): MergeRun {
  const args = [scriptPath, 'merge', derivedNo, originNo, mdPath];
  if (write) args.push('--write');
  const r = spawnSync(PY, args, {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      MTASK_MCP_URL: mcpUrl,
      MTASK_SESSION_FILE: SESSION_FILE,
    },
  });
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

const sectionCount = (text: string | null, no: string) => {
  if (!text) return 0;
  const auto = new RegExp(`【派生单 ${no} 处理结果 [^】]*】`, 'g');
  const back = new RegExp(`##\\s*派生单回填 ${no}（[^）]*）`, 'g');
  return (text.match(auto) ?? []).length + (text.match(back) ?? []).length;
};
const bytes = (s: string | null) => Buffer.byteLength(s ?? '', 'utf8');

const V1 = '## 根因\n\n首版结论（T04572 门夹具）。';
const V2 = '## 根因\n\n修订后结论（T04572 门夹具）。';
const mdV1 = path.join(root, 'v1.md');
const mdV2 = path.join(root, 'v2.md');
writeFileSync(mdV1, V1, 'utf8');
writeFileSync(mdV2, V2, 'utf8');

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const mcpUrl = `${base}/api/mcp`;

  const logFd = await import('node:fs').then((m) => m.openSync(serverLog, 'w'));
  server = spawn(NODE, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: REPO,
    env: { ...process.env, MTask_DATA_DIR: dataDir, MTask_PORT: String(port) },
    stdio: ['ignore', logFd, logFd],
  });
  server.on('error', (e) => { console.error('后端启动失败：', e); });
  await waitHealth(base);

  const project = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `T04572 merge 门-${Date.now()}` }),
  }).then(json<{ id: string }>);
  const mkTask = (title: string) => fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, title }),
  }).then(json<{ id: string; task_no: string }>);

  const origin = await mkTask(`T04572 母单-${Date.now()}`);
  const derived = await mkTask(`T04572 派生单-${Date.now()}`);

  group('A 组 · 默认 dry-run：只输出拟写入节 + 差异，不改母单');
  const dry = runMerge(SCRIPT, derived.task_no, origin.task_no, mdV1, false, mcpUrl);
  const afterDry = readRow(origin.id);
  ok('A-01 dry-run 退出码为 0 且明确标注未写库', dry.code === 0 && dry.out.includes('dry-run：未写库'),
    { code: dry.code, out: dry.out.slice(-400) });
  ok('A-02 输出拟写入的节（`派生单回填` 标题）与差异段',
    dry.out.includes('--- 拟写入的节 ---') && dry.out.includes(`## 派生单回填 ${derived.task_no}（`)
    && dry.out.includes('--- 与母单现有内容的差异 ---'), dry.out.slice(-500));
  ok('A-03 dry-run 不触碰母单 handle_result，也不归档派生单（R-333 不写母单）',
    bytes(afterDry.handle_result) === 0 && afterDry.archived === 0 && dry.out.includes('未回灌'),
    { bytes: bytes(afterDry.handle_result), archived: afterDry.archived });
  ok('A-04 dry-run 未归档派生单（与写盘解耦）', dry.out.includes('dry-run：未归档派生单'), dry.out.slice(-300));

  group('B 组 · --write 先判后写：首写追加、同内容不重复、修订就地刷新');
  const first = runMerge(SCRIPT, derived.task_no, origin.task_no, mdV1, true, mcpUrl);
  const afterFirst = readRow(origin.id);
  ok('B-01 首次 --write 追加一节且落库成功',
    first.code === 0 && first.out.includes('已追加归并') && sectionCount(afterFirst.handle_result, derived.task_no) === 1,
    { code: first.code, sections: sectionCount(afterFirst.handle_result, derived.task_no), out: first.out.slice(-300) });
  await sleep(400); // 归档与结果写入走不同 MCP 调用，等最后一笔提交落定再取样
  const afterArchive = readRow(derived.id);
  ok('B-02 首次 --write 归档派生单（闭环语义保持）', afterArchive.archived === 1,
    { archived: afterArchive.archived, out: first.out.slice(-300) });

  const bytesAfterFirst = bytes(afterFirst.handle_result);
  const second = runMerge(SCRIPT, derived.task_no, origin.task_no, mdV1, true, mcpUrl);
  const afterSecond = readRow(origin.id);
  ok('B-03 同内容二次 --write 回「未重复追加」',
    second.code === 0 && second.out.includes('已含本单归并记录且内容一致，未重复追加'), second.out.slice(-400));
  ok('B-04 二次执行母单字节数逐字不变、节数仍为 1（本单的核心回归判据）',
    bytes(afterSecond.handle_result) === bytesAfterFirst
    && sectionCount(afterSecond.handle_result, derived.task_no) === 1,
    { before: bytesAfterFirst, after: bytes(afterSecond.handle_result), sections: sectionCount(afterSecond.handle_result, derived.task_no) });

  const rev = runMerge(SCRIPT, derived.task_no, origin.task_no, mdV2, true, mcpUrl);
  const afterRev = readRow(origin.id);
  ok('B-05 修订结论 --write 只就地刷新那一节，不新挂第二节',
    rev.code === 0 && rev.out.includes('已就地刷新归并') && sectionCount(afterRev.handle_result, derived.task_no) === 1,
    { code: rev.code, sections: sectionCount(afterRev.handle_result, derived.task_no), out: rev.out.slice(-300) });
  ok('B-06 刷新后母单正文就是修订版（旧版快照已被替换）',
    (afterRev.handle_result ?? '').includes('修订后结论（T04572 门夹具）')
    && !(afterRev.handle_result ?? '').includes('首版结论（T04572 门夹具）'), afterRev.handle_result);

  const revAgain = runMerge(SCRIPT, derived.task_no, origin.task_no, mdV2, true, mcpUrl);
  const afterRevAgain = readRow(origin.id);
  ok('B-07 同一修订再跑：未重复追加且字节数不变',
    revAgain.out.includes('未重复追加') && bytes(afterRevAgain.handle_result) === bytes(afterRev.handle_result),
    { before: bytes(afterRev.handle_result), after: bytes(afterRevAgain.handle_result) });

  const dry2 = runMerge(SCRIPT, derived.task_no, origin.task_no, mdV2, false, mcpUrl);
  const afterDry2 = readRow(origin.id);
  ok('B-08 已归并且一致时 dry-run 同样报「未重复追加」且不写库',
    dry2.code === 0 && dry2.out.includes('未重复追加')
    && bytes(afterDry2.handle_result) === bytes(afterRevAgain.handle_result), dry2.out.slice(-300));

  // 自动通道标题形态：【派生单 Txxxx 处理结果 日期】——脚本必须能识别，不能因标题形态不同再挂一节
  const originB = await mkTask(`T04572 母单(自动通道标题)-${Date.now()}`);
  const derivedB = await mkTask(`T04572 派生单(自动通道标题)-${Date.now()}`);
  await fetch(`${base}/api/tasks/${originB.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handleResult: `---\n【派生单 ${derivedB.task_no} 处理结果 2026-11-06】\n${V1}` }),
  }).then(json);
  const beforeB = readRow(originB.id);
  const cross = runMerge(SCRIPT, derivedB.task_no, originB.task_no, mdV1, true, mcpUrl);
  const afterB = readRow(originB.id);
  ok('B-09 母单是自动通道标题形态时同内容也判一致（两套标记互相识别，不再叠加）',
    cross.out.includes('未重复追加') && bytes(afterB.handle_result) === bytes(beforeB.handle_result)
    && sectionCount(afterB.handle_result, derivedB.task_no) === 1,
    { out: cross.out.slice(-300), before: bytes(beforeB.handle_result), after: bytes(afterB.handle_result) });

  group('C 组 · 变异探针：判据短路成「恒不等价」⇒ 二次执行用例转红');
  const mutDir = path.join(root, 'mut');
  mkdirSync(mutDir, { recursive: true });
  const mutScript = path.join(mutDir, 'mcp-direct-call.py');
  copyFileSync(SCRIPT, mutScript);
  const mutSrc = readFileSync(mutScript, 'utf8');
  const matchLine = '    return normalize_body((handle_result or "")[last["body_start"]:last["body_end"]]) == normalize_body(result)';
  const mutPatched = mutSrc.replace(matchLine, '    return False  # T04572 mutation probe：恒不等价');
  writeFileSync(mutScript, mutPatched, 'utf8');
  ok('C-01 变异已种在内容判据上（脚本结构未被改动成无法定位）', mutPatched !== mutSrc);

  const mutRun = runMerge(mutScript, derived.task_no, origin.task_no, mdV2, true, mcpUrl);
  ok('C-02 变异版二次执行不再出现「未重复追加」（B-03/B-07 的断言转红）',
    !mutRun.out.includes('未重复追加') && mutRun.out.includes('就地刷新'), mutRun.out.slice(-400));
  ok('C-03 工作副本未被变异污染（门只改临时拷贝）',
    readFileSync(SCRIPT, 'utf8') === mutSrc);

  group('D 组 · 单源守卫与锚定词');
  const scriptSrc = readFileSync(SCRIPT, 'utf8');
  ok('D-01 脚本侧判据命名与服务端 derivedOrigin.ts 同构（find/merged_content_matches/refresh_merged_body）',
    ['find_merged_sections', 'merged_content_matches', 'refresh_merged_body'].every((k) => scriptSrc.includes(k)));
  ok('D-02 脚本默认 dry-run、写盘需显式开关（--write），并保留「未重复追加」回告',
    scriptSrc.includes('--write') && scriptSrc.includes('dry-run') && scriptSrc.includes('未重复追加'));
  ok('D-03 服务端单源判据仍在位（alreadyMerged / mergedContentMatches / refreshMergedBody）',
    ['alreadyMerged', 'mergedContentMatches', 'refreshMergedBody'].every((k) =>
      readFileSync(path.join(REPO, 'server/src/services/derivedOrigin.ts'), 'utf8').includes(k)));
  ok('D-04 同族服务端门在位（T04546-merge-revision-gate.mts）',
    existsSync(path.join(REPO, 'scripts/verify/T04546-merge-revision-gate.mts')));
} catch (e) {
  fail += 1;
  console.error('[FAIL] 门执行异常：', e);
  if (existsSync(serverLog)) console.error('后端日志尾部：\n', readFileSync(serverLog, 'utf8').slice(-1500));
} finally {
  await stopServer();
  if (!KEEP) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  } else {
    console.log(`\n保留现场：${root}`);
  }
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
