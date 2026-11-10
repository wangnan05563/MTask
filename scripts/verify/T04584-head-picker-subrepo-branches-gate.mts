/**
 * T04584 验收门：Git 树选范围「起点分支输入框」能查询工作空间子目录仓库的分支。
 *
 * 工单锚定词（R-318，均为本仓真实存在的路径/词形）：
 *   scripts/verify/T04584-head-picker-subrepo-branches-gate.mts
 *   web/src/utils/gitRepoBranchGroups.ts  web/src/utils/scopeControls.ts
 *   web/src/ui/GitScopeControls.tsx  web/src/ui/GitTreePickerModal.tsx
 *   branchOptionsFromCensus  filterBranches  BranchPicker  flatRepoSub  headOptions
 *   子目录  子仓库  banks  deploy  BEMP5.0DEV  repoSub
 *
 * 根因：平铺（单仓库）视图的 load() 恒以 repoSub='' 取根仓库，head 输入框 BranchPicker 的
 *   options={refs} 也只拿到根仓库 refs——工作空间目录里的子仓库（banks/deploy…）分支根本不出现，
 *   用户无从按子仓库分支取数（工单原话「起点分支输入框未能展示子目录下的分支信息」）。
 *   服务端 discoverNestedRepos 早已递归发现子仓库（T04525），缺口纯在前端候选与取数定位。
 *
 * 分组：
 *   A 组（纯函数 branchOptionsFromCensus）：只取当前项目可用仓库、根仓库无标注、子仓库带 repoSub/repoLabel、
 *      同名分支跨仓库不覆盖、根仓库排在子仓库前、原始引用名保留；
 *   B 组（filterBranches 去重键带 repoSub）：跨仓库同名保留、同仓库同名校去重、旧调用方行为不变；
 *      含负控制——证明「旧键 type:name 会把跨仓库同名折叠」（否则门可能是恒绿空跑）；
 *   C 组（修复落在源码）：helper 导出、modal flatRepoSub/headOptions/onOpen/onSelect/load/confirm 接线、
 *      BranchPicker onSelect 回调与仓库标注渲染、scopeControls BranchOption.repoSub 与去重键。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify/T04584-head-picker-subrepo-branches-gate.mts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { branchOptionsFromCensus, type RepoBranchInput } from '../../web/src/utils/gitRepoBranchGroups.ts';
import { filterBranches, type BranchOption } from '../../web/src/utils/scopeControls.ts';

let pass = 0;
let fail = 0;
const lines: string[] = [];
const group = (t: string) => lines.push(`\n—— ${t} ——`);
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const WS = 'D:/code/QJ/BEMP5.0DEV';
const ref = (name: string, type: 'branch' | 'remote' | 'tag' = 'branch') => ({ name, type });
const inp = (projectId: string, repoSub: string, refs: ReturnType<typeof ref>[], available = true): RepoBranchInput => ({
  projectId, projectName: 'BEMP', workspacePath: WS, repoSub, refs, available,
});

const inputs: RepoBranchInput[] = [
  inp('p1', '', [ref('master'), ref('feature/x'), ref('origin/main', 'remote'), ref('v1', 'tag')]),
  inp('p1', 'banks', [ref('master'), ref('dev')]),
  inp('p1', 'deploy', [ref('master'), ref('release')]),
  inp('p1', 'dead', [ref('deadbranch')], false), // 不可用仓库：不该进候选
  inp('p2', '', [ref('other')]), // 别的项目：平铺取数按当前 projectId，不该混进候选
];

/* ============================ A 组：候选折算 ============================ */
group('A 组 · branchOptionsFromCensus 把子仓库分支纳入起点候选');
const opts = branchOptionsFromCensus(inputs, 'p1');
const masters = opts.filter((o) => o.name === 'master');
ok('A-01 别的项目 p2 的分支 other 不进候选（平铺按当前 projectId 取数）',
  !opts.some((o) => o.name === 'other'), opts.map((o) => o.name));
ok('A-02 根仓库候选 repoSub 为空且无仓库标注（外观与改造前一致）',
  opts.some((o) => o.name === 'master' && (o.repoSub ?? '') === '' && o.repoLabel === undefined),
  opts.filter((o) => o.name === 'master').map((o) => [o.repoSub, o.repoLabel]));
ok('A-03 子仓库 banks 候选带 repoSub=banks 与标注「BEMP · banks」',
  opts.some((o) => o.name === 'dev' && o.repoSub === 'banks' && o.repoLabel === 'BEMP · banks'),
  opts.filter((o) => o.repoSub === 'banks'));
ok('A-04 同名分支 master 跨根/banks/deploy 三仓库各成一条候选（不互相覆盖）',
  masters.length === 3 && new Set(masters.map((o) => o.repoSub)).size === 3,
  masters.map((o) => o.repoSub));
ok('A-05 不可用仓库 dead 的 deadbranch 不进候选',
  !opts.some((o) => o.name === 'deadbranch'), opts.map((o) => o.name));
ok('A-06 根仓库候选排在子仓库之前（首条 repoSub 为空）',
  opts.length > 0 && (opts[0].repoSub ?? '') === '', opts.slice(0, 3).map((o) => o.repoSub));
ok('A-07 远端引用原始名 origin/main 原样保留（取数直接当 head 用）',
  opts.some((o) => o.name === 'origin/main' && o.type === 'remote'), opts.filter((o) => o.type === 'remote'));
ok('A-08 标签 v1 类型为 tag', opts.some((o) => o.name === 'v1' && o.type === 'tag'), opts.filter((o) => o.type === 'tag'));

/* ============================ B 组：去重键带 repoSub ============================ */
group('B 组 · filterBranches 按 type:name:repoSub 去重');
const filteredAll = filterBranches(opts, '', 100);
ok('B-01 空查询保留跨仓库三条 master（去重键含 repoSub）',
  filteredAll.filter((o) => o.name === 'master').length === 3, filteredAll.filter((o) => o.name === 'master').map((o) => o.repoSub));
const dup: BranchOption[] = [
  { type: 'branch', name: 'main', repoSub: 'banks' },
  { type: 'branch', name: 'main', repoSub: 'banks' },
];
ok('B-02 同仓库同名重复候选去重为一条', filterBranches(dup, '', 100).length === 1, filterBranches(dup, '', 100));
const legacy: BranchOption[] = [{ type: 'branch', name: 'main' }, { type: 'branch', name: 'main' }];
ok('B-03 旧调用方（无 repoSub）同名同型仍去重一条，行为不变', filterBranches(legacy, '', 100).length === 1);
// 负控制：复刻修复前的去重键 type:name，证明它确实会把跨仓库同名折叠成一条
const oldDedup = (list: readonly BranchOption[]) => {
  const seen = new Set<string>();
  return list.filter((o) => { const k = `${o.type}:${o.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
};
ok('B-04 负控制：旧键 type:name 把跨仓库三条 master 折叠成一条（bug 存在）',
  oldDedup(masters).length === 1 && filterBranches(masters, '', 100).length === 3,
  { old: oldDedup(masters).length, neu: filterBranches(masters, '', 100).length });
ok('B-05 模糊查询 dev 命中子仓库 banks 的 dev 分支',
  filterBranches(opts, 'dev', 100).some((o) => o.name === 'dev' && o.repoSub === 'banks'),
  filterBranches(opts, 'dev', 100).map((o) => [o.name, o.repoSub]));

/* ============================ C 组：修复落在源码 ============================ */
group('C 组 · 修复真的落在源码里');
const REPO = process.cwd();
const src = (p: string) => readFileSync(path.join(REPO, p), 'utf8');
const util = src('web/src/utils/gitRepoBranchGroups.ts');
const modal = src('web/src/ui/GitTreePickerModal.tsx');
const picker = src('web/src/ui/GitScopeControls.tsx');
const scope = src('web/src/utils/scopeControls.ts');
ok('C-01 gitRepoBranchGroups.ts 导出 branchOptionsFromCensus', util.includes('export function branchOptionsFromCensus('));
ok('C-02 modal 引入 branchOptionsFromCensus', modal.includes('branchOptionsFromCensus,'));
ok('C-03 modal 有平铺仓库状态 flatRepoSub', modal.includes("const [flatRepoSub, setFlatRepoSub] = useState('')"));
ok('C-04 modal headOptions 普查后改用 branchOptionsFromCensus(scopedCensus, projectId)',
  modal.includes('branchOptionsFromCensus(scopedCensus, projectId)'));
ok('C-05 BranchPicker options={headOptions} 且 onSelect 切 flatRepoSub',
  modal.includes('options={headOptions}') && modal.includes("onSelect={(opt) => setFlatRepoSub(opt.repoSub ?? '')}"));
ok('C-06 BranchPicker onOpen 懒普查（首次展开才逐仓扫）',
  modal.includes('if (!census && !scanning && projects.length > 0) void runCensus(projects)'));
ok('C-07 load 取数带上 flatRepoSub（子仓库分支真按该仓库取数）',
  modal.includes('buildLogQuery(projectId, head, allBranches, search, nextSkip, flatRepoSub)'));
ok('C-08 平铺确认回传 flatRepoSub（子仓库选择不被当根仓库）',
  modal.includes('onConfirm(projectId, orderSelected(commits, selected), flatRepoSub)'));
ok('C-09 切项目重置 flatRepoSub', modal.includes("setFlatRepoSub(''); // T04584"));
// T04912 起 load 依赖追加了 mixRepos / repoChoices.length（混合开关与仓库清单回来要重取）；
// 本断言守住的是「flatRepoSub 必须仍在依赖里」，不再钉死逐字相等的旧数组。
ok('C-10 load 触发依赖含 flatRepoSub', /\[projectId, head, allBranches, repoView, flatRepoSub[^\]]*\]/.test(modal));
ok('C-11 BranchPicker 新增 onSelect 回调 prop', picker.includes('readonly onSelect?: (option: BranchOption) => void'));
ok('C-12 BranchPicker commit 交回整条 option（含 repoSub）',
  picker.includes('const commit = (option: BranchOption) => { onSelect?.(option); onChange(option.name); close(); }'));
ok('C-13 BranchPicker 子仓库候选渲染仓库标注 + data-ref-sub',
  picker.includes('{option.repoLabel && <span') && picker.includes('data-ref-sub={option.repoSub || undefined}'));
ok('C-14 scopeControls BranchOption 含 repoSub/repoLabel 字段',
  scope.includes('repoSub?: string;') && scope.includes('repoLabel?: string;'));
ok('C-15 filterBranches 去重键含 repoSub',
  scope.includes("const key = `${option.type}:${option.name}:${option.repoSub ?? ''}`"));

console.log(lines.join('\n'));
console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;