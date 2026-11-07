/**
 * T04573 验收门：存量派生单 → 母单快照核查工具（只读）的夹具与变异探针。
 *
 * work order 锚定词（R-318，均为本仓真实存在的路径/词形）：
 *   `scripts/verify/T04546-merge-revision-gate.mts`（增量路径的既有门，本门补存量一半）
 *   `alreadyMerged` / `mergedContentMatches` / `findMergedSections` / `refreshMergedBody`
 *   `派生单回填`（脚本补录节标题；与自动通道 `【派生单 … 处理结果 …】` 区分）
 *
 * 守的行为：
 *   A 组：夹具分类——首版快照 + 子单已修订 ⇒ stale；已含最新全文 ⇒ 不列出（fresh）；
 *         两节并存、从未归并、母单查无、子单无结论各自归类；差异行数与两侧时间戳如实带出；
 *   B 组：`--project` 过滤；文本报告按类分组；
 *   C 组：只读红线——整轮执行前后数据库 SHA256 逐字节不变；
 *   D 组：变异探针——短路 `mergedContentMatches` 后清单膨胀到「所有已归并单都上榜」；
 *   E 组：单源守卫——工具直接复用服务端 findMergedSections / mergedContentMatches，锚定词在位。
 *
 * 前置：门自建临时 SQLite 夹具库（只含 projects/tasks 两表），不启后端、不触碰用户库。
 * 运行：node D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/verify/T04573-derived-snapshot-audit-gate.mts
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
const TOOL = path.join(REPO, 'scripts', 'audit-derived-snapshots.mts');
const KEEP = process.env.T04573_KEEP === '1';
const root = mkdtempSync(path.join(os.tmpdir(), 't04573-gate-'));
const dbFile = path.join(root, 'fixture.db');

const V1 = '## 根因\n\n旧版结论。\n\n## 验证\n\n门 A 通过。';
const V2 = `${V1}\n新增1\n新增2\n新增3`;
const auto = (no: string, body: string) => `---\n【派生单 ${no} 处理结果 2026-11-06】\n${body}`;
const back = (no: string, body: string) => `## 派生单回填 ${no}（2026-11-06）\n${body}`;

/* ---------- 夹具：只含核查工具实际读取的两张表 ---------- */
function buildFixture() {
  const db = new Database(dbFile);
  try {
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, task_no TEXT NOT NULL, title TEXT NOT NULL, project_id TEXT NOT NULL,
        derived_from TEXT, handle_result TEXT, updated_at TEXT NOT NULL
      );
    `);
    const p = db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)');
    p.run('p1', '门项目一');
    p.run('p2', '门项目二');
    const t = db.prepare(`INSERT INTO tasks (id, task_no, title, project_id, derived_from, handle_result, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
    // 母单
    t.run('o1', 'T10001', '母单-首版快照', 'p1', null, auto('T20001', V1), '2026-11-06T01:00:00Z');
    t.run('o2', 'T10002', '母单-已含最新', 'p1', null, auto('T20002', V2), '2026-11-06T02:00:00Z');
    t.run('o3', 'T10003', '母单-两节并存', 'p1', null, `${auto('T20003', V2)}\n\n${back('T20003', V2)}`, '2026-11-06T03:00:00Z');
    t.run('o4', 'T10004', '母单-从未归并', 'p1', null, '母单自有结论，无派生节。', '2026-11-06T04:00:00Z');
    t.run('o5', 'T10005', '母单-补录首版', 'p1', null, back('T20007', V1), '2026-11-06T05:00:00Z');
    t.run('o6', 'T10006', '母单-行末空白', 'p1', null, auto('T20009', V2.replace(/\n/g, '   \n')), '2026-11-06T06:00:00Z');
    t.run('ob', 'T30000', '母单-另一项目', 'p2', null, auto('T30001', V1), '2026-11-06T07:00:00Z');
    // 派生单
    t.run('c1', 'T20001', '派生-首版快照已修订', 'p1', 'T10001', V2, '2026-11-06T09:00:00Z');
    t.run('c2', 'T20002', '派生-已含最新', 'p1', 'T10002', V2, '2026-11-06T09:01:00Z');
    t.run('c3', 'T20003', '派生-两节并存', 'p1', 'T10003', V2, '2026-11-06T09:02:00Z');
    t.run('c4', 'T20004', '派生-从未归并', 'p1', 'T10004', V2, '2026-11-06T09:03:00Z');
    t.run('c5', 'T20005', '派生-母单查无', 'p1', 'T99999', V2, '2026-11-06T09:04:00Z');
    t.run('c6', 'T20006', '派生-无结论', 'p1', 'T10001', '', '2026-11-06T09:05:00Z');
    t.run('c7', 'T20007', '派生-补录节已修订', 'p1', 'T10005', V2, '2026-11-06T09:06:00Z');
    t.run('c9', 'T20009', '派生-仅行末空白差异', 'p1', 'T10006', V2, '2026-11-06T09:07:00Z');
    t.run('cb', 'T30001', '派生-另一项目已修订', 'p2', 'T30000', V2, '2026-11-06T09:08:00Z');
  } finally {
    db.close();
  }
}

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function runAudit(extra: string[], tool = TOOL) {
  const r = spawnSync(NODE, ['--import', 'tsx', tool, '--db', dbFile, ...extra], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}
const auditJson = (extra: string[], tool = TOOL) => {
  const r = runAudit(['--json', ...extra], tool);
  let body: any = null;
  try { body = JSON.parse(r.out); } catch { /* 让断言带原始输出 */ }
  return { ...r, body };
};
const byNo = (body: any, no: string) => (body?.entries ?? []).find((e: any) => e.taskNo === no);
const staleNos = (body: any) => (body?.entries ?? []).filter((e: any) => e.issue === 'stale').map((e: any) => e.taskNo).sort();

let mutDir = '';
try {
  buildFixture();
  const hashBefore = sha(dbFile);

  group('A 组 · 夹具分类：首版快照上榜、最新全文不上榜');
  const all = auditJson([]);
  ok('A-00 工具退出码为 0 且 --json 输出可直接解析', all.code === 0 && all.body !== null,
    { code: all.code, err: all.err.slice(0, 300), out: all.out.slice(0, 200) });
  ok('A-01 stale 清单恰好是「有节但正文落后」的三张（含 otra 项目），不混入 fresh/unmerged',
    JSON.stringify(staleNos(all.body)) === JSON.stringify(['T20001', 'T20007', 'T30001']), staleNos(all.body));
  const s1 = byNo(all.body, 'T20001');
  ok('A-02 stale 条目带齐子单号/母单号/节标题/差异行数/两侧时间戳',
    s1?.originNo === 'T10001' && String(s1?.sectionHeading).includes('【派生单 T20001 处理结果 2026-11-06】')
    && s1?.diffLines === 3 && s1?.childUpdatedAt === '2026-11-06T09:00:00Z'
    && s1?.originUpdatedAt === '2026-11-06T01:00:00Z', s1);
  ok('A-03 补录节（## 派生单回填）同样能判定落后，形态如实标注 backfill',
    byNo(all.body, 'T20007')?.sectionForms?.[0] === 'backfill' && byNo(all.body, 'T20007')?.diffLines === 3,
    byNo(all.body, 'T20007'));
  ok('A-04 母单已含最新全文的单不列出，只计入 fresh（T20002/T20009）',
    !byNo(all.body, 'T20002') && !byNo(all.body, 'T20009') && all.body?.fresh === 2,
    { fresh: all.body?.fresh });
  ok('A-05 同一单两节并存单独归类 coexist（两种形态都在）',
    byNo(all.body, 'T20003')?.issue === 'coexist'
    && JSON.stringify(byNo(all.body, 'T20003')?.sectionForms) === JSON.stringify(['auto', 'backfill']),
    byNo(all.body, 'T20003'));
  ok('A-06 母单存在但无本单节 ⇒ unmerged；母单编号查无 ⇒ missing-origin',
    byNo(all.body, 'T20004')?.issue === 'unmerged' && byNo(all.body, 'T20005')?.issue === 'missing-origin',
    { u: byNo(all.body, 'T20004'), m: byNo(all.body, 'T20005') });
  ok('A-07 子单无结论跳过（不计入 stale / unmerged）',
    all.body?.skippedNoResult === 1 && !byNo(all.body, 'T20006') && all.body?.scanned === 9,
    { scanned: all.body?.scanned, skipped: all.body?.skippedNoResult });
  ok('A-08 行末空白不算修订（normalizeBody 生效）',
    byNo(all.body, 'T20009') === undefined && all.body?.fresh === 2);

  group('B 组 · 项目过滤与文本报告');
  const p1 = auditJson(['--project', 'p1']);
  ok('B-01 --project 过滤后不再出现另一项目的派生单',
    p1.code === 0 && p1.body?.scanned === 8 && !byNo(p1.body, 'T30001')
    && JSON.stringify(staleNos(p1.body)) === JSON.stringify(['T20001', 'T20007']),
    { scanned: p1.body?.scanned, stale: staleNos(p1.body) });
  const txt = runAudit(['--project', '门项目一']);
  ok('B-02 项目名也可作为过滤值，文本报告按类分组',
    txt.code === 0 && txt.out.includes('stale（母单快照落后）')
    && txt.out.includes('coexist（同一单两节并存）') && txt.out.includes('T20001 ← T10001'),
    txt.out.slice(0, 400));
  ok('B-03 文本报告显式声明只读与 R-333（回灌交用户决定）',
    txt.out.includes('不改库、不归档') && txt.out.includes('R-333'), txt.out.slice(-300));

  group('C 组 · 只读红线');
  ok('C-01 整轮核查前后数据库 SHA256 逐字节不变', sha(dbFile) === hashBefore,
    { before: hashBefore.slice(0, 16), after: sha(dbFile).slice(0, 16) });
  ok('C-02 只读连接未产生 -wal / -journal 旁路文件',
    !existsSync(`${dbFile}-wal`) && !existsSync(`${dbFile}-journal`));

  group('D 组 · 变异探针：短路内容判据 ⇒ 清单膨胀到所有已归并单');
  // 临时拷贝须落在仓库内，否则解析不到根 node_modules 的 better-sqlite3（会得到空清单假红）
  mutDir = mkdtempSync(path.join(REPO, 'scripts', '.t04573-mut-'));
  const mutTool = path.join(mutDir, 'audit-derived-snapshots.mts');
  copyFileSync(TOOL, mutTool);
  const src = readFileSync(mutTool, 'utf8');
  const target = 'const matches = mergedContentMatches(origin.handle_result, child.task_no, childHr);';
  // 临时拷贝不在原目录：把服务端判据的 import 改成绝对 file URL，否则相对路径失效（会得到空清单假红）
  const importLine = "} from '../server/src/services/derivedOrigin.ts';";
  const absImport = `} from '${pathToFileURL(path.join(REPO, 'server/src/services/derivedOrigin.ts')).href}';`;
  const relocated = src.includes(importLine) ? src.replace(importLine, absImport) : src;
  const mutated = relocated.replace(target, 'const matches = false; // T04573 mutation probe：恒不等价');
  writeFileSync(mutTool, mutated, 'utf8');
  ok('D-01 变异已种在内容判据调用点', mutated !== src && mutated.includes('T04573 mutation probe'));
  const mut = auditJson([], mutTool);
  ok('D-02 变异后 stale 清单膨胀到全部「有节的已归并单」（6 张），fresh 归零',
    mut.code === 0 && staleNos(mut.body).length === 6 && mut.body?.fresh === 0
    && staleNos(mut.body).includes('T20002') && staleNos(mut.body).includes('T20003'),
    { stale: staleNos(mut.body), fresh: mut.body?.fresh, err: mut.err.slice(0, 300) });
  ok('D-03 工作副本未被变异污染', readFileSync(TOOL, 'utf8') === src);
  ok('D-04 变异运行同样未改库', sha(dbFile) === hashBefore);

  group('E 组 · 单源守卫与锚定词');
  const toolSrc = readFileSync(TOOL, 'utf8');
  ok('E-01 工具直接复用服务端 findMergedSections / mergedContentMatches（不另写一套正则）',
    toolSrc.includes("findMergedSections,") && toolSrc.includes('mergedContentMatches(origin.handle_result'));
  ok('E-02 只读 + 不写母单的硬约束写在工具里（readonly / query_only / R-333）',
    toolSrc.includes('readonly: true') && toolSrc.includes('query_only = ON') && toolSrc.includes('R-333'));
  ok('E-03 锚定词在位：alreadyMerged / refreshMergedBody / 派生单回填 / T04546 门',
    ['alreadyMerged', 'refreshMergedBody', '派生单回填', 'scripts/verify/T04546-merge-revision-gate.mts']
      .every((k) => toolSrc.includes(k) || readFileSync(path.join(REPO, 'scripts/verify/T04573-derived-snapshot-audit-gate.mts'), 'utf8').includes(k)));
  ok('E-04 同族服务端门在位（T04546-merge-revision-gate.mts）',
    existsSync(path.join(REPO, 'scripts/verify/T04546-merge-revision-gate.mts')));
} catch (e) {
  fail += 1;
  console.error('[FAIL] 门执行异常：', e);
} finally {
  if (mutDir) { try { rmSync(mutDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ } }
  if (!KEEP) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  } else {
    console.log(`\n保留现场：${root}`);
  }
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
