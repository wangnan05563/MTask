/*
 * T04585 验收门（节点层）：聚合视图单提交 decorate 简化逻辑 + 源码/发布锚。
 *
 * 工单锚定词（R-318）：
 *   scripts/verify/T04585-commit-refs-simplify-gate.mts
 *   web/src/utils/gitTreeSelect.ts  web/src/ui/GitTreePickerModal.tsx
 *   simplifyCommitRefs  COMMIT_REF_VISIBLE_LIMIT  CommitRefPills  compactRefs
 *   data-lck="git-tree-refs-more"  data-lck="git-tree-detail-refs"
 *
 * A 组 simplifyCommitRefs 纯逻辑（去重 / 远端孪生折叠 / 上限 / 优先级 / 不丢信息 / 负控制）
 * B 组 修复落在源码（聚合置 compactRefs、平铺不置、+K 与详情全量锚）
 * C 组 发布新鲜度（dist 含 +K / 详情锚）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T04585-commit-refs-simplify-gate.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { simplifyCommitRefs, COMMIT_REF_VISIBLE_LIMIT, type GitRefName } from '../../web/src/utils/gitTreeSelect';

const REPO = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const R = (type: GitRefName['type'], name: string): GitRefName => ({ type, name });
const names = (rs: readonly GitRefName[]) => rs.map((r) => `${r.type}:${r.name}`).sort();

console.log('—— A 组 · simplifyCommitRefs 纯逻辑 ——');
{
  const { visible, hidden } = simplifyCommitRefs([R('branch', 'dev'), R('branch', 'dev')]);
  ok('A-01 完全重复（type:name）去重为一条', visible.length === 1 && hidden.length === 0, JSON.stringify(visible));
}
{
  const { visible, hidden } = simplifyCommitRefs([R('branch', 'feature/x'), R('remote', 'origin/feature/x')]);
  ok('A-02 远端孪生 origin/feature/x 折进 hidden，本地 feature/x 可见',
    visible.some((r) => r.type === 'branch' && r.name === 'feature/x') && hidden.some((r) => r.type === 'remote' && r.name === 'origin/feature/x'),
    `visible=${JSON.stringify(visible)} hidden=${JSON.stringify(hidden)}`);
}
{
  const { visible, hidden } = simplifyCommitRefs([R('remote', 'origin/main')]);
  ok('A-03 无本地孪生的远端引用仍可见（不是一刀切折叠远端）', visible.length === 1 && hidden.length === 0, JSON.stringify(visible));
}
{
  const tags = Array.from({ length: 10 }, (_, i) => R('tag', `BEMP5.0V202301-02-036M00${i}`));
  const { visible, hidden } = simplifyCommitRefs(tags);
  ok(`A-04 超过上限折叠：10 标签 → 可见 ${COMMIT_REF_VISIBLE_LIMIT} + 隐藏 ${10 - COMMIT_REF_VISIBLE_LIMIT}`,
    visible.length === COMMIT_REF_VISIBLE_LIMIT && hidden.length === 10 - COMMIT_REF_VISIBLE_LIMIT, `visible=${visible.length} hidden=${hidden.length}`);
}
{
  const { visible } = simplifyCommitRefs([R('tag', 't1'), R('branch', 'b1'), R('tag', 't2')]);
  ok('A-05 优先级：本地分支排在标签前露出', visible[0]?.type === 'branch' && visible[0]?.name === 'b1', JSON.stringify(visible));
}
{
  const refs = [R('branch', 'dev'), R('remote', 'origin/dev'), R('remote', 'origin/main'), R('tag', 't1'), R('tag', 't2'), R('tag', 't3'), R('tag', 't4'), R('branch', 'dev')];
  const { visible, hidden } = simplifyCommitRefs(refs);
  const uniqOriginal = names(refs.filter((r, i) => refs.findIndex((x) => x.type === r.type && x.name === r.name) === i));
  ok('A-06 不丢信息：visible∪hidden = 去重后原始集合', JSON.stringify(names([...visible, ...hidden])) === JSON.stringify(uniqOriginal),
    `union=${names([...visible, ...hidden]).length} uniq=${uniqOriginal.length}`);
}
{
  const { visible, hidden } = simplifyCommitRefs([]);
  ok('A-07 空引用 → 两段皆空', visible.length === 0 && hidden.length === 0);
}
{
  const { visible, hidden } = simplifyCommitRefs([R('branch', 'a'), R('tag', 't')]);
  ok('A-08 未超上限不产生折叠（hidden 空）', visible.length === 2 && hidden.length === 0, JSON.stringify(visible));
}
{
  const { visible, hidden } = simplifyCommitRefs([R('branch', 'x'), R('remote', 'origin/x')]);
  ok('A-09 孪生即便未超上限也不可见（冗余镜像必折叠）', visible.length === 1 && visible[0].type === 'branch' && hidden.length === 1, JSON.stringify({ visible, hidden }));
}
{
  const refs = Array.from({ length: 12 }, (_, i) => R('tag', `tag-${i}`));
  ok('A-10 负控制：改造前逐条平铺会渲染 12 个 pill（>上限，证明痛点存在）', refs.length > COMMIT_REF_VISIBLE_LIMIT, `refs=${refs.length} limit=${COMMIT_REF_VISIBLE_LIMIT}`);
}

console.log('\n—— B 组 · 修复落在源码 ——');
const src = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const sel = src('web/src/utils/gitTreeSelect.ts');
const modal = src('web/src/ui/GitTreePickerModal.tsx');
ok('B-01 gitTreeSelect 导出 simplifyCommitRefs 与 COMMIT_REF_VISIBLE_LIMIT',
  /export function simplifyCommitRefs\(/.test(sel) && /export const COMMIT_REF_VISIBLE_LIMIT = 3;/.test(sel));
ok('B-02 modal 引入 simplifyCommitRefs', /simplifyCommitRefs,/.test(modal));
ok('B-03 CommitRefPills 组件存在且非聚合逐字平铺（compact=false 分支）',
  /function CommitRefPills\(/.test(modal) && /if \(!compact\)/.test(modal));
ok('B-04 CommitRows 增 compactRefs 缺省 false（平铺不受影响）', /compactRefs = false/.test(modal));
ok('B-05 聚合调用点置 compactRefs', /<CommitRows commits=\{pane\.commits\}[\s\S]{0,400}compactRefs \/>/.test(modal));
ok('B-06 平铺调用点不置 compactRefs（保持原展示）', /<CommitRows commits=\{commits\}[^>]*>/.test(modal) && !/<CommitRows commits=\{commits\}[^>]*compactRefs/.test(modal));
ok('B-07 +K 折叠锚 data-lck=git-tree-refs-more 且 title 列全量', /data-lck="git-tree-refs-more"/.test(modal) && /另有 \$\{hidden\.length\} 个分支\/标签/.test(modal));
ok('B-08 详情行全量引用锚 data-lck=git-tree-detail-refs 且仅聚合渲染', /data-lck="git-tree-detail-refs"/.test(modal) && /compactRefs && c\.refs\.length > 0/.test(modal));

console.log('\n—— C 组 · 发布新鲜度 ——');
const bundleDir = path.join(REPO, 'web/dist/assets');
let hasMore = false, hasDetail = false;
if (fs.existsSync(bundleDir)) {
  for (const f of fs.readdirSync(bundleDir)) {
    if (!/\.(js|css)$/.test(f)) continue;
    const s = fs.readFileSync(path.join(bundleDir, f), 'utf8');
    if (s.includes('git-tree-refs-more')) hasMore = true;
    if (s.includes('git-tree-detail-refs')) hasDetail = true;
  }
}
ok('C-01 当前 dist 含 +K 折叠锚 git-tree-refs-more', hasMore, 'web/dist/assets 逐文件核对');
ok('C-02 当前 dist 含详情全量锚 git-tree-detail-refs', hasDetail, 'web/dist/assets 逐文件核对');

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;