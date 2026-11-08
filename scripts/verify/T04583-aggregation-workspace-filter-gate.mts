/**
 * T04583 验收门：分支聚合查询按「当前项目工作空间」过滤生效（不再返回所有项目的所有分支）。
 *
 * 工单锚定词（R-318，均为本仓真实存在的路径/词形）：
 *   scripts/verify/T04583-aggregation-workspace-filter-gate.mts
 *   web/src/utils/gitRepoBranchGroups.ts  web/src/ui/GitTreePickerModal.tsx
 *   inputsForActiveWorkspace  buildRepoBranchGroups  blockedRepoRows  scopedCensus
 *   工作空间  子目录  跨工作空间  BEMP5.0DEV  feature/hnnxbank/dev
 *
 * 根因：buildRepoBranchGroups(inputs, activeProjectId) 的 activeProjectId 只决定行的 current/spare
 *   状态、排序与默认展开，**从不剔除别的项目的分支**。modal 被传入跨工作空间的所选项目时
 *   （CodeReviewLecturePanel selectedIds / gitScopePicker 多选），聚合把别的工作空间的分支一并归组，
 *   项目下拉切换只改顺序不改成员——过滤形同虚设（工单原话「返回了所有项目的所有分支」）。
 *
 * 分组：
 *   A 组（纯函数 inputsForActiveWorkspace）：跨空间剔除、同空间保留、子仓库保留、路径归一化、
 *      未绑定退回自身、找不到当前项目原样返回；
 *   B 组（与归组/不可用行联动）：收窄后分支组只含当前工作空间，跨空间分支与不可用行不再误召回；
 *      含负控制——证明「不收窄时确实会混入别的工作空间」（否则门可能是恒绿空跑）；
 *   C 组（修复落在源码）：helper 已导出、modal 用 scopedCensus 喂 repoGroups/blockedRows、
 *      runCensus 默认展开也按收窄后的分组算。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify/T04583-aggregation-workspace-filter-gate.mts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  inputsForActiveWorkspace,
  buildRepoBranchGroups,
  blockedRepoRows,
  type RepoBranchInput,
} from '../../web/src/utils/gitRepoBranchGroups.ts';

let pass = 0;
let fail = 0;
const lines: string[] = [];
const group = (t: string) => lines.push(`\n—— ${t} ——`);
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const WS = 'D:/code/QJ/BEMP5.0DEV';
const inp = (projectId: string, workspacePath: string, repoSub: string, branches: string[], available = true): RepoBranchInput => ({
  projectId, projectName: projectId.toUpperCase(), workspacePath, repoSub,
  refs: branches.map((name) => ({ name, type: 'branch' as const })), available,
});

// p1 当前项目（根 + 子仓库 served）；p2 别的工作空间；p3 与 p1 同一工作空间；p4 同空间但路径写法不同
const inputs: RepoBranchInput[] = [
  inp('p1', WS, '', ['master', 'feature/hnnxbank/dev']),
  inp('p1', WS, 'served', ['feature/hnnxbank/dev']),
  inp('p2', 'D:/code/other', '', ['other-branch']),
  inp('p3', WS, '', ['master']),
  inp('p4', 'D:\\code\\QJ\\BEMP5.0DEV\\', '', ['feature/hnnxbank/dev']),
];

/* ============================ A 组：纯函数收窄 ============================ */
group('A 组 · inputsForActiveWorkspace 按当前项目工作空间收窄');
const scoped = inputsForActiveWorkspace(inputs, 'p1');
ok('A-01 跨工作空间的 p2（D:/code/other）被剔除', !scoped.some((i) => i.projectId === 'p2'), scoped.map((i) => [i.projectId, i.workspacePath]));
ok('A-02 当前项目 p1 的根仓库与子仓库 served 都保留（子目录范围不误删）',
  scoped.some((i) => i.projectId === 'p1' && i.repoSub === '') && scoped.some((i) => i.projectId === 'p1' && i.repoSub === 'served'),
  scoped.map((i) => [i.projectId, i.repoSub]));
ok('A-03 同一工作空间的别的项目 p3 保留（同空间多项目聚合是需求本意，不该误删）',
  scoped.some((i) => i.projectId === 'p3'), scoped.map((i) => i.projectId));
ok('A-04 路径归一化：反斜杠+尾斜杠的 p4 与 p1 判为同一工作空间而保留',
  scoped.some((i) => i.projectId === 'p4'), scoped.map((i) => [i.projectId, i.workspacePath]));
ok('A-05 收窄结果行数 = 同空间行数（4：p1根/p1 served/p3/p4），不是全量 5',
  scoped.length === 4, { n: scoped.length });

const unbound: RepoBranchInput[] = [
  inp('p1', '', '', []),
  inp('p2', 'D:/code/other', '', ['other-branch']),
];
const scopedUnbound = inputsForActiveWorkspace(unbound, 'p1');
ok('A-06 当前项目未绑定（空路径）→ 仅留当前项目自身行，不把别的工作空间扯进来',
  scopedUnbound.length === 1 && scopedUnbound[0].projectId === 'p1', scopedUnbound.map((i) => i.projectId));
const notFound = inputsForActiveWorkspace(inputs, 'ghost');
ok('A-07 找不到当前项目 → 原样返回（不静默丢行，交由调用方兜底）',
  notFound.length === inputs.length, { n: notFound.length });
const caseScoped = inputsForActiveWorkspace([inp('p1', 'D:/Code/QJ/BEMP5.0DEV', '', ['master']), inp('p2', 'd:/code/qj/bemp5.0dev', '', ['x'])], 'p1');
ok('A-08 大小写不敏感（Windows 路径）：D:/Code 与 d:/code 判为同一工作空间',
  caseScoped.length === 2, caseScoped.map((i) => i.projectId));

/* ============================ B 组：与归组/不可用行联动 ============================ */
group('B 组 · 收窄后分支组只含当前工作空间');
const groupsScoped = buildRepoBranchGroups(inputsForActiveWorkspace(inputs, 'p1'), 'p1');
const branchNames = groupsScoped.map((g) => g.branchName);
ok('B-01 收窄后分支组不含别的工作空间的 other-branch', !branchNames.includes('other-branch'), branchNames);
ok('B-02 收窄后仍含当前工作空间的 master 与 feature/hnnxbank/dev',
  branchNames.includes('master') && branchNames.includes('feature/hnnxbank/dev'), branchNames);
const devGroup = groupsScoped.find((g) => g.branchName === 'feature/hnnxbank/dev');
ok('B-03 feature/hnnxbank/dev 组内仓库都落在当前工作空间（p1根/p1 served/p4，无 p2）',
  !!devGroup && devGroup.repos.every((r) => r.projectId !== 'p2') && devGroup.repos.length === 3,
  devGroup?.repos.map((r) => [r.projectId, r.repoSub]));

// 负控制：证明「不收窄」时确实会混入别的工作空间——否则本门可能是恒绿空跑
const groupsUnscoped = buildRepoBranchGroups(inputs, 'p1');
ok('B-04 负控制：不收窄时 other-branch 确实混入（bug 存在，修复有的放矢）',
  groupsUnscoped.some((g) => g.branchName === 'other-branch'), groupsUnscoped.map((g) => g.branchName));
ok('B-05 负控制：不收窄时 feature 组含 p2 之外的跨空间行总数 > 收窄后（证明过滤真的减少了成员）',
  (groupsUnscoped.find((g) => g.branchName === 'master')?.repos.length ?? 0) >= 2
  && groupsUnscoped.length > groupsScoped.length,
  { unscoped: groupsUnscoped.length, scoped: groupsScoped.length });

const blockedInputs: RepoBranchInput[] = [
  { ...inp('p1', WS, '', []), available: false, unavailableReason: 'Git 取数失败' },
  { ...inp('p2', 'D:/code/other', '', []), available: false, unavailableReason: 'Git 取数失败' },
];
const blockedScoped = blockedRepoRows(inputsForActiveWorkspace(blockedInputs, 'p1'), 'p1');
ok('B-06 不可用行也按工作空间收窄：别的工作空间 p2 的失败行不再误召回',
  blockedScoped.length === 1 && blockedScoped[0].projectId === 'p1', blockedScoped.map((r) => r.projectId));

/* ============================ C 组：修复落在源码 ============================ */
group('C 组 · 修复真的落在源码里');
const REPO = process.cwd();
const src = (p: string) => readFileSync(path.join(REPO, p), 'utf8');
const util = src('web/src/utils/gitRepoBranchGroups.ts');
const modal = src('web/src/ui/GitTreePickerModal.tsx');
ok('C-01 gitRepoBranchGroups.ts 导出 inputsForActiveWorkspace',
  /export function inputsForActiveWorkspace\(/.test(util), 'inputsForActiveWorkspace');
ok('C-02 GitTreePickerModal 引入 inputsForActiveWorkspace',
  /inputsForActiveWorkspace,/.test(modal), 'import 列表含该名');
ok('C-03 modal 用 scopedCensus = inputsForActiveWorkspace(census, projectId) 收窄',
  /const scopedCensus = useMemo\(\(\) => \(census \? inputsForActiveWorkspace\(census, projectId\) : \[\]\)/.test(modal),
  'scopedCensus memo');
ok('C-04 repoGroups 与 blockedRows 都改喂 scopedCensus（不再直接用全量 census）',
  /buildRepoBranchGroups\(scopedCensus, projectId\)/.test(modal) && /blockedRepoRows\(scopedCensus, projectId\)/.test(modal),
  'repoGroups/blockedRows');
ok('C-05 runCensus 默认展开按收窄后的分组算（与视图成员一致）',
  /buildRepoBranchGroups\(inputsForActiveWorkspace\(next, projectId\), projectId\)/.test(modal), 'runCensus default expansion');

console.log(lines.join('\n'));
console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;