/**
 * T05715 校验单测：直接调用前端纯函数 checkLectureScopeWorkspaces，覆盖需求用例 A / B 及边界。
 * 跑法：node scripts/tests/verify-t05715-validation.mts   （仓库根目录执行，需 tsx）
 */
import { checkLectureScopeWorkspaces, WORKSPACE_CROSS_ERROR } from '../../web/src/utils/lectureScopeCheck';

let pass = 0;
let fail = 0;
const lines: string[] = [];
const say = (name: string, cond: boolean, extra?: string) => {
  if (cond) pass += 1; else fail += 1;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

const task = (id: string, projectId: string, repoSubs: string[]) => ({
  id,
  projectId,
  commits: repoSubs.map((repoSub) => ({ repoSub })),
});

// 用例 A（通过）：同一工作空间，勾选 frontend 与 deploy 两个仓库的任务
{
  const tasks = [task('t1', 'P', ['frontend']), task('t2', 'P', ['deploy'])];
  const err = checkLectureScopeWorkspaces(tasks, ['t1', 't2']);
  say('用例A：同工作空间跨仓库勾选 → 校验通过(空错误)', err === '');
}

// 用例 A 变体：同项目，根仓库 + 子仓库混合
{
  const tasks = [task('t1', 'P', ['']), task('t2', 'P', ['frontend'])];
  const err = checkLectureScopeWorkspaces(tasks, ['t1', 't2']);
  say('用例A变体：根仓库+子仓库混合 → 校验通过', err === '');
}

// 用例 B（失败）：不同工作空间，勾选两个项目各一仓库
{
  const tasks = [task('t1', 'P1', ['frontend']), task('t2', 'P2', ['deploy'])];
  const err = checkLectureScopeWorkspaces(tasks, ['t1', 't2']);
  say('用例B：跨工作空间勾选 → 报错', err === WORKSPACE_CROSS_ERROR, err);
}

// 边界：未勾选任何任务
{
  const tasks = [task('t1', 'P1', ['frontend']), task('t2', 'P2', ['deploy'])];
  const err = checkLectureScopeWorkspaces(tasks, []);
  say('边界：未勾选 → 通过', err === '');
}

// 边界：勾选的任务无关联提交 → 忽略
{
  const tasks = [task('t1', 'P1', []), task('t2', 'P2', [])];
  const err = checkLectureScopeWorkspaces(tasks, ['t1', 't2']);
  say('边界：勾选任务无提交 → 通过(无工作空间维度)', err === '');
}

// 边界：仅勾选其一（不同工作空间各一个，但只勾一个）
{
  const tasks = [task('t1', 'P1', ['frontend']), task('t2', 'P2', ['deploy'])];
  const err = checkLectureScopeWorkspaces(tasks, ['t1']);
  say('边界：只勾选单一工作空间任务 → 通过', err === '');
}

const summary = `T05715 校验单测：${pass} 通过 / ${fail} 失败`;
lines.push('', summary);
console.log(lines.join('\n'));
if (fail > 0) process.exit(1);
