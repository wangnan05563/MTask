/**
 * T05700 门：讲稿「加载 diff」跨子仓库误报根因修复。
 *
 * 实证（见 tmp/result-T05700.md）：7900e17/e9930dc/2df7887 三个 SHA 全部真实存在，
 * 分别在 BEMP5.0DEV 工作空间的 banks/frontend/deploy 子仓库；旧链路把它们按 projectId
 * 合成一维 commits 且丢掉 repoSub → 服务端按工作空间根仓库 --no-walk 整条 fatal →
 * 误报「提交都不存在（rebase/force-push 丢弃？）」。
 *
 * 判据：
 *   A 组 前端——按项目聚合 repoSub；单仓库透传进 range；跨仓库明确阻断并给分批办法。
 *   B 组 后端——错误提示补「子仓库未分批」成因，T05693 降级链逐字不动。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05700-reposub-link.mts
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

const LEC = readFileSync(join(ROOT, 'web/src/pages/CodeReviewLecturePanel.tsx'), 'utf8');
const COLLECT = readFileSync(join(ROOT, 'server/src/services/gitCollect.ts'), 'utf8');
const ENDPOINT = readFileSync(join(ROOT, 'server/src/routes/gitLinks.ts'), 'utf8');

// A 组：前端 repoSub 路由（T05700 修复）
ok('A-01 done-task-commits 接口返回 repoSub（数据面本来就有，不是缺字段）',
  /l\.repo_sub/.test(ENDPOINT) && /repoSub: string/.test(ENDPOINT));
ok('A-02 前端按项目聚合「所有已勾选任务」的 repoSub（不能逐任务判定，会漏跨仓冲突）',
  /byProject = new Map<string, Set<string>>\(\)/.test(LEC)
  && /byProject\.set\(t\.projectId, set\)/.test(LEC)
  && /c\.repoSub \?\? ''/.test(LEC));
ok('A-03 跨仓库组合并冲突并明确阻断（给出「按仓库分批」的可操作路径）',
  /项目下勾选的提交跨了 \$\{uniq\.length\} 个 Git 仓库/.test(LEC)
  && /一次只能采集同一仓库的提交，请按仓库分批勾选/.test(LEC)
  && /repoScopePlan\.error\s*\?\s*\{ error: repoScopePlan\.error \}/.test(LEC));
ok('A-04 单仓库场景 repoSub 自动透传进 range（buildScopeBody 用 repoScopePlan.subs）',
  /subs\[pid\] = uniq\[0\]/.test(LEC)
  && /buildScopeBody\(\{ selectedIds, selectedCommits: mergedCommits, selectedRepoSubs: repoScopePlan\.subs \}\)/.test(LEC));
ok('A-05 三条入口（加载 diff / 预检 / 生成）仍统一拦截 scopeBody.error',
  (LEC.match(/if \(scopeBody\.error\)/g) ?? []).length >= 2);

// B 组：后端提示与降级链
ok('B-01 「都不存在」报错补「子仓库未分批」成因，不再把 rebase/force-push 当唯一解释',
  /选中的提交在仓库里都不存在：/.test(COLLECT) && /子仓库但未按仓库分批选择/.test(COLLECT));
ok('B-02 resolveCommitsInfo 对外文案同步（两条报错口径一致）',
  /return `选中的提交在仓库里不存在：/.test(COLLECT) && /子仓库但未按仓库分批选择/.test(COLLECT));
ok('B-03 T05693 降级链逐字保留（部分缺失子集采集 + warning，全部缺失才失败）',
  /if \(missingNote\) collection\.warnings\.unshift\(missingNote\);/.test(COLLECT)
  && /if \(entries\.length === 0\)/.test(COLLECT)
  && /collectCommitsOneByOne\(cwd, shas, info, opts\)/.test(COLLECT));

const body = [`T05700 repoSub 链路门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05700-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05700-gate-results.txt')}`);
