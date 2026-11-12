/**
 * T05682 门：讲稿卡片「精简筛选 + 已完成任务勾选」。
 *
 * 需求：移除 base..head / base / head / 提交人 / 粘贴 patch 五类入口，只保留「从 Git 树选范围」；
 * 新增按项目的「已完成任务」复选，勾选后以任务的关联提交作为采集范围，且与 Git 树点选并存。
 *
 * 判据：
 *   A 组 后端——批量端点只取 `status='done'` 的任务、LEFT JOIN `task_git_links`、按 projectIds 过滤；
 *        返回按任务分组（taskNo/title/commits），无关联提交的任务也要出现（commits 空数组）。
 *   B 组 前端——五类旧入口的 DOM 已不存在；Git 树按钮保留；任务区渲染 + 勾选合并进 commits；
 *        生成入参只走 `shape='commits'`，缺提交时给可操作提示（不再要求填 base）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05682-lecture-task-scope.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

const LINKS = readFileSync(join(ROOT, 'server/src/routes/gitLinks.ts'), 'utf8');
const PANEL = readFileSync(join(ROOT, 'web/src/pages/CodeReviewLecturePanel.tsx'), 'utf8');

ok('A-01 批量端点存在且只取已完成任务',
  /gitLinksApi\.get\('\/git\/done-task-commits'/.test(LINKS)
  && /t\.status = 'done'/.test(LINKS), {});
ok('A-02 端点按 projectIds 过滤并 LEFT JOIN 关联提交（无提交的任务也要出现）',
  /LEFT JOIN task_git_links/.test(LINKS) && /t\.project_id IN \(\$\{marks\}\)/.test(LINKS)
  && /if \(r\.sha\) task\.commits\.push/.test(LINKS));
ok('A-03 返回按任务分组，字段与前端类型一致（id/taskNo/title/projectId/commits）',
  /taskNo: r\.task_no \?\? ''/.test(LINKS) && /commits: \[\]/.test(LINKS) && /res\.json\(\{ ok: true, tasks: \[\.\.\.map\.values\(\)\] \}\)/.test(LINKS));

ok('B-01 五类旧入口的 DOM 已移除（区间形态 / 起止 / 提交人 / patch）',
  !/aria-label="区间起点"/.test(PANEL) && !/aria-label="区间终点"/.test(PANEL)
  && !/aria-label="Git 区间形态"/.test(PANEL) && !/testId="lecture-author-filter"/.test(PANEL)
  && !/aria-label="粘贴 patch 全文"/.test(PANEL) && !/粘贴 patch（无 git 时的降级通道）/.test(PANEL));
ok('B-02 「从 Git 树选范围」入口保留（不可删的兼容路径）',
  /data-lck="git-tree-btn"/.test(PANEL) && /从 Git 树选范围/.test(PANEL));
ok('B-03 已完成任务区渲染：只读列表 + 复选 + 提交数标注',
  /data-lck="done-tasks"/.test(PANEL) && /checkedTaskIds\.includes\(t\.id\)/.test(PANEL)
  && /commits\.length\} 提交/.test(PANEL));
ok('B-04 勾选任务的提交与 Git 树点选取并集（同项目去重）',
  /const mergedCommits = useMemo/.test(PANEL)
  && /new Set\(\[\.\.\.\(out\[t\.projectId\] \?\? \[\]\), \.\.\.t\.commits\.map\(\(c\) => c\.sha\)\]\)/.test(PANEL));
ok('B-05 生成入参只走 commits 形态，缺提交时给可操作提示（不再要求填 base）',
  /range: \{ shape: 'commits', commits: picked/.test(PANEL)
  && /请用「从 Git 树选范围」或勾选「已完成任务」/.test(PANEL)
  && !/需要填写 base（分支\/标签\/SHA）/.test(PANEL));
ok('B-06 生成入参使用 mergedCommits（不是只读的 Git 树点选）',
  /selectedCommits: mergedCommits/.test(PANEL));

const body = [`T05682 讲稿范围门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05682-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05682-gate-results.txt')}`);
