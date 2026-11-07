/**
 * T04573：存量派生单 → 母单归并快照的**只读**核查工具。
 *
 * 背景：T04546 修的是增量路径（子单再次回传时回灌母单）；**已经**被钉在首版快照上的母单
 * 不会自动纠正。本工具遍历 `derived_from` 非空的单，用服务端同一判据
 * `findMergedSections` + `mergedContentMatches` 判「母单那一节 == 子单当前结论」，只出报告。
 *
 * 红线（用户 2026-11-07 裁决 R-333）：默认**不改库**、不自动归档、不补录；数据库以
 * `readonly + query_only` 打开，回灌动作逐单交回用户决定。
 *
 * 用法：
 *   node D:/code/nodejs24/node.exe node_modules/tsx/dist/cli.mjs scripts/audit-derived-snapshots.mts
 *   ... --db <mtask.db> --project <项目id或名称> --json
 *
 * 报告分类（每条派生单只出现一次）：
 *   stale          母单已有本单归并节，但最后一节正文 ≠ 子单当前结论（存量缺口的正主）
 *   coexist        同一单两节并存（`【派生单 …】` 自动通道 + `## 派生单回填 …` 脚本通道）
 *   unmerged       母单存在，但没有任何本单归并节（从未归并）
 *   missing-origin 母单编号在库中查无
 *   （内容一致的单不列出，只计入 fresh 计数）
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findMergedSections,
  mergedContentMatches,
} from '../server/src/services/derivedOrigin.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = path.join(process.env.MTask_DATA_DIR ?? path.join(REPO, 'server', 'data'), 'mtask.db');

interface Args { db: string; project: string; json: boolean; help: boolean; }

function parseArgs(argv: string[]): Args {
  const a: Args = { db: DEFAULT_DB, project: '', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    const eq = x.indexOf('=');
    const key = eq >= 0 ? x.slice(0, eq) : x;
    const val = eq >= 0 ? x.slice(eq + 1) : '';
    if (key === '--db') a.db = val || argv[++i] || '';
    else if (key === '--project') a.project = val || argv[++i] || '';
    else if (key === '--json') a.json = true;
    else if (key === '--help' || key === '-h') a.help = true;
    else throw new Error(`未知参数：${x}`);
  }
  return a;
}

/** 行级增删估算：公共行（多重集交集）之外的增删行数；缺 3 行时得到 3。 */
export function diffLineCount(a: string, b: string): number {
  const lines = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const A = lines(a.trim());
  const B = lines(b.trim());
  const count = new Map<string, number>();
  for (const l of A) count.set(l, (count.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of B) {
    const n = count.get(l) ?? 0;
    if (n > 0) { common += 1; count.set(l, n - 1); }
  }
  return A.length + B.length - 2 * common;
}

type Issue = 'stale' | 'coexist' | 'unmerged' | 'missing-origin';
type SectionForm = 'auto' | 'backfill';

interface AuditEntry {
  issue: Issue;
  taskNo: string;
  title: string;
  projectId: string;
  originNo: string;
  childUpdatedAt: string;
  originUpdatedAt: string | null;
  sectionCount: number;
  sectionForms: SectionForm[];
  /** stale: 用于比对（最后一节）的标题行 */
  sectionHeading?: string;
  /** stale: 行级增删行数 */
  diffLines?: number;
  /** stale: 该单是否同时存在两节 */
  coexist?: boolean;
  /** coexist: 最后一节与子单当前结论是否一致 */
  contentMatchesLast?: boolean;
}

interface Report {
  db: string;
  project: string;
  scanned: number;
  fresh: number;
  skippedNoResult: number;
  counts: Record<Issue, number>;
  entries: AuditEntry[];
}

const ISSUE_LABEL: Record<Issue, string> = {
  stale: 'stale（母单快照落后）',
  coexist: 'coexist（同一单两节并存）',
  unmerged: 'unmerged（从未归并）',
  'missing-origin': 'missing-origin（母单编号查无）',
};

function audit(dbPath: string, project: string): Report {
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    let projectId = '';
    if (project) {
      const hit = db.prepare('SELECT id FROM projects WHERE id = ? OR name = ? LIMIT 1').get(project, project) as
        { id: string } | undefined;
      if (!hit) throw new Error(`项目不存在：${project}`);
      projectId = hit.id;
    }
    const rows = (projectId
      ? db.prepare(
        `SELECT id, task_no, title, project_id, derived_from, handle_result, updated_at
           FROM tasks WHERE TRIM(COALESCE(derived_from,'')) <> '' AND project_id = ?
          ORDER BY task_no`,
      ).all(projectId)
      : db.prepare(
        `SELECT id, task_no, title, project_id, derived_from, handle_result, updated_at
           FROM tasks WHERE TRIM(COALESCE(derived_from,'')) <> ''
          ORDER BY task_no`,
      ).all()) as Array<{
        id: string; task_no: string; title: string; project_id: string;
        derived_from: string; handle_result: string | null; updated_at: string;
      }>;
    const originStmt = db.prepare('SELECT task_no, handle_result, updated_at FROM tasks WHERE task_no = ?');

    const report: Report = {
      db: dbPath,
      project: projectId || '',
      scanned: rows.length,
      fresh: 0,
      skippedNoResult: 0,
      counts: { stale: 0, coexist: 0, unmerged: 0, 'missing-origin': 0 },
      entries: [],
    };
    for (const child of rows) {
      const originNo = (child.derived_from ?? '').trim();
      if (!originNo) continue;
      const childHr = (child.handle_result ?? '').trim();
      if (!childHr) { report.skippedNoResult += 1; continue; }
      const origin = originStmt.get(originNo) as
        { handle_result: string | null; updated_at: string } | undefined;
      if (!origin) {
        report.counts['missing-origin'] += 1;
        report.entries.push({
          issue: 'missing-origin', taskNo: child.task_no, title: child.title, projectId: child.project_id,
          originNo, childUpdatedAt: child.updated_at, originUpdatedAt: null, sectionCount: 0, sectionForms: [],
        });
        continue;
      }
      const sections = findMergedSections(origin.handle_result, child.task_no);
      if (!sections.length) {
        report.counts.unmerged += 1;
        report.entries.push({
          issue: 'unmerged', taskNo: child.task_no, title: child.title, projectId: child.project_id,
          originNo, childUpdatedAt: child.updated_at, originUpdatedAt: origin.updated_at, sectionCount: 0, sectionForms: [],
        });
        continue;
      }
      const forms = sections.map((s) => (s.headingLine.startsWith('【') ? 'auto' : 'backfill') as SectionForm);
      const last = sections[sections.length - 1];
      const matches = mergedContentMatches(origin.handle_result, child.task_no, childHr);
      if (!matches) {
        const body = (origin.handle_result ?? '').slice(last.bodyStart, last.bodyEnd);
        report.counts.stale += 1;
        report.entries.push({
          issue: 'stale', taskNo: child.task_no, title: child.title, projectId: child.project_id,
          originNo, childUpdatedAt: child.updated_at, originUpdatedAt: origin.updated_at,
          sectionCount: sections.length, sectionForms: forms,
          sectionHeading: last.headingLine, diffLines: diffLineCount(body, childHr),
          coexist: sections.length > 1,
        });
      } else if (sections.length > 1) {
        report.counts.coexist += 1;
        report.entries.push({
          issue: 'coexist', taskNo: child.task_no, title: child.title, projectId: child.project_id,
          originNo, childUpdatedAt: child.updated_at, originUpdatedAt: origin.updated_at,
          sectionCount: sections.length, sectionForms: forms,
          sectionHeading: last.headingLine, contentMatchesLast: true,
        });
      } else {
        report.fresh += 1;
      }
    }
    return report;
  } finally {
    db.close();
  }
}

function printText(r: Report): void {
  console.log('存量派生单 → 母单归并快照核查（只读，不改库、不归档）');
  console.log(`库：${r.db}${r.project ? `｜项目：${r.project}` : '｜范围：全库'}`);
  console.log(`扫描 derived_from 非空：${r.scanned}；一致：${r.fresh}；子单无结论跳过：${r.skippedNoResult}`);
  console.log(`问题合计：${r.entries.length}（stale=${r.counts.stale} coexist=${r.counts.coexist} unmerged=${r.counts.unmerged} missing-origin=${r.counts['missing-origin']}）`);
  for (const issue of ['stale', 'coexist', 'unmerged', 'missing-origin'] as Issue[]) {
    const list = r.entries.filter((e) => e.issue === issue);
    if (!list.length) continue;
    console.log(`\n—— ${ISSUE_LABEL[issue]}：${list.length} ——`);
    for (const e of list) {
      const forms = e.sectionForms.length ? ` 形态=${e.sectionForms.join('+')}` : '';
      const head = e.sectionHeading ? ` 节=${e.sectionHeading}` : '';
      const diff = e.diffLines === undefined ? '' : ` 差异行数=${e.diffLines}`;
      const co = e.coexist ? ' [两节并存]' : '';
      console.log(`${e.taskNo} ← ${e.originNo}${forms}${head}${diff}${co} 子单更新=${e.childUpdatedAt} 母单更新=${e.originUpdatedAt ?? '—'} ${e.title}`);
    }
  }
  console.log('\n提示：本工具只读；回灌动作请逐单交用户决定（R-333 不写母单）。');
}

const args = (() => {
  try { return parseArgs(process.argv.slice(2)); } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
})();
if (args.help) {
  console.log('用法：node tsx scripts/audit-derived-snapshots.mts [--db <mtask.db>] [--project <id|名称>] [--json]');
  process.exit(0);
}
try {
  const report = audit(args.db, args.project);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
} catch (e) {
  console.error(`核查失败：${(e as Error).message}`);
  process.exit(2);
}
