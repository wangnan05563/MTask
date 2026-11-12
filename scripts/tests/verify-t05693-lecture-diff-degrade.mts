/**
 * T05693 门：讲稿卡片「加载 diff」缺失提交降级 + 未回写任务禁勾。
 *
 * 现场：
 *   1. 勾选已完成任务后「加载 diff」报「选中的提交在仓库里不存在（分支被 rebase/force-push 丢弃？）」
 *      ——部分 SHA 失效时整批拒绝，可用子集也被搭上；
 *   2. 未回写 commit 的已完成任务灰显但仍可勾选，勾了只会让采集白跑。
 *
 * 判据：
 *   A 组 后端降级——collectCommitsUnion 不再因个别缺失整批 throw：批量失败逐条点名后继续，
 *        部分缺失降级为 warning + 可用子集采集；全部缺失才维持失败；resolveCommitsInfo 对外语义不动。
 *   B 组 前端禁勾——未回写 commit 的任务 checkbox disabled、悬浮说明、不可点指针。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05693-lecture-diff-degrade.mts
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

const COLLECT = readFileSync(join(ROOT, 'server/src/services/gitCollect.ts'), 'utf8');
const LECTURE = readFileSync(join(ROOT, 'web/src/pages/CodeReviewLecturePanel.tsx'), 'utf8');

// A 组：后端降级
const union = COLLECT.slice(COLLECT.indexOf('export async function collectCommitsUnion'));
ok('A-01 collectCommitsUnion 用 try/catch 包住 resolveCommitsInfo，批量失败走逐条点名复跑（collectCommitsOneByOne）',
  /let info: Map<string, GitGraphEntry>;\s*\n\s*try \{\s*\n\s*info = await resolveCommitsInfo\(cwd, shas\);\s*\n\s*\} catch \{[\s\S]{0,400}collectCommitsOneByOne\(cwd, shas, info, opts\)/.test(union));
ok('A-02 部分失效不再整批 throw——「都不存在」只在 entries.length === 0 时抛出',
  !/选中的提交在仓库里不存在：/.test(union)
  && /entries\.length === 0[\s\S]{0,300}选中的提交在仓库里都不存在/.test(union));
ok('A-03 缺失名单降级为 warning（missingNote 进 collection.warnings，含 rebase/force-push 说明与实采条数）',
  /missingNote = `跳过 \$\{missing\.length\} 条仓库里已不存在的提交/.test(union)
  && /if \(missingNote\) collection\.warnings\.unshift\(missingNote\);/.test(union));
ok('A-04 label 如实反映「实采/勾选」口径（失效项已跳过）',
  /已选 \$\{entries\.length\}\/\$\{shas\.length\} 个提交（\$\{runs\.length\} 段，失效项已跳过）/.test(union));
ok('A-05 resolveCommitsInfo 对外语义不动（gitCommitFiles 单条链路仍按原样报错）',
  /throw new GitCollectError\('failed', missingCommitsMessage\(missing\)\);/.test(COLLECT));

// B 组：前端禁勾
ok('B-01 未回写 commit 的任务 checkbox 禁用（disabled={!t.commits.length}）',
  /checked=\{checkedTaskIds\.includes\(t\.id\)\} disabled=\{!t\.commits\.length\}/.test(LECTURE));
ok('B-02 悬浮说明改为「不可勾选」，不再暗示勾了有效',
  /该任务未回写 commit，不可勾选（勾了也不会产生采集范围）/.test(LECTURE));
ok('B-03 灰显项指针为 not-allowed，正常项不受影响',
  /cursor: t\.commits\.length \? undefined : 'not-allowed'/.test(LECTURE));
ok('B-04 「加载 diff」入口保留（修复只动降级与禁勾，不动交互流）',
  /onClick=\{onLoadDiff\}/.test(LECTURE));

const body = [`T05693 diff 降级门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05693-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05693-gate-results.txt')}`);
