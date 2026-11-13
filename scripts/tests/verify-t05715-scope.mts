/**
 * T05715 源码锚门：静态断言「加载 diff」前置校验已从「禁止跨 Git 仓库」改为「禁止跨工作空间」，
 * 且请求按 (projectId, repoSub) 拆分、后端放开重复 projectId。
 * 跑法：node scripts/tests/verify-t05715-scope.mts   （仓库根目录执行）
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FRONTEND = resolve(ROOT, 'web/src/pages/CodeReviewLecturePanel.tsx');
const SCOPE = resolve(ROOT, 'server/src/services/lectureScope.ts');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const say = (name: string, cond: boolean, extra?: string) => {
  if (cond) pass += 1; else fail += 1;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const fe = readFileSync(FRONTEND, 'utf8');
const be = readFileSync(SCOPE, 'utf8');

// —— 前端：新校验文案（需求指定原文） ——
const NEW_TEXT =
  '勾选的提交跨了多个工作空间。一次只能采集同一工作空间内的提交，请确保所选任务属于同一工作空间，或分批加载不同工作空间的 diff。';
say('前端：包含新报错文案（按需求原文）', fe.includes(NEW_TEXT));

// —— 前端：旧「跨 Git 仓库」校验已移除 ——
say('前端：旧「一次只能采集同一仓库的提交」已移除', !fe.includes('一次只能采集同一仓库的提交'));
say('前端：旧「项目下勾选的提交跨了 N 个 Git 仓库」冲突逻辑已移除', !fe.includes('项目下勾选的提交跨了'));

// —— 前端：buildScopeBody 按 (projectId, repoSub) 归组，多仓库各自成条 ——
say('前端：buildScopeBody 按 `${projectId} ${c.repoSub}` 归组', fe.includes('const key = `${projectId} ${c.repoSub}`'));
say('前端：mergedCommits 保留每条提交 repoSub（SelectedCommit 类型）', fe.includes('interface SelectedCommit'));

// —— 后端：放开重复 projectId ——
say('后端：移除「项目「${projectId}」被重复选择」拦截', !be.includes('被重复选择'));
say('后端：parseLectureScopeRequest 不再用 seen.has(projectId)', !be.includes('seen.has(projectId)'));
say('后端：scanGitProject 按 item.range?.repoSub 解析仓库', be.includes('const repoSub = (item.range?.repoSub ?? '));

// —— 后端：preview/collected 透传 repoSub，避免前端同项目多仓库渲染折叠 ——
say('后端：LectureProjectPreview 新增 repoSub 字段', be.includes('repoSub?: string;'));

const summary = `T05715 源码锚门：${pass} 通过 / ${fail} 失败`;
lines.push('', summary);
console.log(lines.join('\n'));
if (fail > 0) process.exit(1);
