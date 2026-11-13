/**
 * T05715 后端受理门：导入 parseLectureScopeRequest，验证
 *   1) 同一 projectId 出现多次（每子仓库一条 range）不再被「被重复选择」拒绝；
 *   2) 解析后产出与入参条目数一致的 projects（多仓库各自成条）；
 *   3) 既有单项目单仓库、空 projects、缺 projectId 的校验仍生效。
 * 跑法：node scripts/tests/verify-t05715-backend.mts   （仓库根目录执行，需 tsx）
 */
import { parseLectureScopeRequest } from '../../server/src/services/lectureScope';

let pass = 0;
let fail = 0;
const lines: string[] = [];
const say = (name: string, cond: boolean, extra?: string) => {
  if (cond) pass += 1; else fail += 1;
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};

// 合法 40 位十六进制 SHA（normalizeSelectedCommits 会校验格式）
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// 用例 A（后端受理）：同项目、两个子仓库各自一条 range —— 旧逻辑会抛「被重复选择」
try {
  const r = parseLectureScopeRequest({
    projects: [
      { projectId: 'P', range: { shape: 'commits', commits: [SHA_A], repoSub: 'frontend' } },
      { projectId: 'P', range: { shape: 'commits', commits: [SHA_B], repoSub: 'deploy' } },
    ],
  });
  say('后端：同 projectId 多仓库(range.repoSub 不同) 不再被拒', r.projects.length === 2
    && r.projects[0].projectId === 'P' && (r.projects[0].range as { repoSub?: string }).repoSub === 'frontend'
    && (r.projects[1].range as { repoSub?: string }).repoSub === 'deploy', JSON.stringify(r.projects.map((p) => p.projectId)));
} catch (e) {
  say('后端：同 projectId 多仓库不再被拒', false, e instanceof Error ? e.message : String(e));
}

// 既有单项目单仓库仍正常
try {
  const r = parseLectureScopeRequest({ projects: [{ projectId: 'P', range: { shape: 'commits', commits: [SHA_A] } }] });
  say('后端：单项目单仓库仍可解析', r.projects.length === 1 && !('repoSub' in (r.projects[0].range as object)));
} catch (e) {
  say('后端：单项目单仓库仍可解析', false, e instanceof Error ? e.message : String(e));
}

// 空 projects 仍拒绝
try {
  parseLectureScopeRequest({ projects: [] });
  say('后端：空 projects 仍被拒', false, '未抛错');
} catch {
  say('后端：空 projects 仍被拒', true);
}

// 缺 projectId 仍拒绝
try {
  parseLectureScopeRequest({ projects: [{ range: { shape: 'commits', commits: ['aaa'] } }] });
  say('后端：缺 projectId 仍被拒', false, '未抛错');
} catch {
  say('后端：缺 projectId 仍被拒', true);
}

const summary = `T05715 后端受理门：${pass} 通过 / ${fail} 失败`;
lines.push('', summary);
console.log(lines.join('\n'));
if (fail > 0) process.exit(1);
