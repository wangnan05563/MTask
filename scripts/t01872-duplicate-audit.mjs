// T01872 迁移前体检（全程只读）：逐项目导出重复编号组 + 核对目标库是否已有唯一索引
// 用法：node scripts/t01872-duplicate-audit.mjs [baseUrl] [mtask.db 路径]
//   第 1 参默认生产实例 http://127.0.0.1:39877；REST 需凭据时用环境变量 MTASK_TOKEN 传 X-Access-Token
//   第 2 参可选：传了才直查库文件（better-sqlite3 需与运行 node 的 ABI 匹配，本机用 ABI127 runtime）
// 唯一索引用的是排除空值的部分索引，故体检口径与索引一致：只统计非空 req_no 的**字面**同号组；
// REQ-01/REQ-001 这类「同一性混写」不参与索引判重，由 duplicates 接口（按 reqNoKey 归一）另行暴露。
const BASE = process.argv[2] ?? 'http://127.0.0.1:39877';
const DB = process.argv[3] ?? '';
const tok = process.env.MTASK_TOKEN ?? '';

async function api(p) {
  const r = await fetch(BASE + p, { headers: tok ? { 'X-Access-Token': tok } : {} });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const projects = (await api('/api/projects')).json ?? [];
const active = projects.filter((x) => !x.archived);
console.log(`项目总数 ${projects.length}，未归档 ${active.length}`);
let withDup = 0, totalGroups = 0, failed = 0;
for (const p of active) {
  const d = await api(`/api/plans/prd-requirements/duplicates?projectId=${p.id}`);
  if (d.status !== 200) { failed++; continue; }
  const groups = d.json?.groups ?? [];
  if (!groups.length) continue;
  withDup++; totalGroups += groups.length;
  console.log(`  重复 ${String(groups.length).padStart(2)} 组 | ${p.name} | ${groups.map((g) => `${g.reqNo}×${g.count}`).join(' ')}`);
}
console.log(`\n结论：${withDup} 个项目存在重复编号（共 ${totalGroups} 组）；duplicates 接口异常 ${failed} 次`);
console.log(`唯一索引迁移影响面判定：${totalGroups > 0 ? '存量重复未清零 → 迁移将走「只告警不建索引」分支，需人工改号后下次启动自动补建' : '无存量重复 → 迁移可直接建立索引'}`);

if (DB) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB, { readonly: true });
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='uniq_prd_req_project_no'").get();
  console.log(`\n装机库索引状态：${idx ? '已存在（说明该库已跑过 T01872 迁移）' : '不存在'}`);
  if (!idx) {
    const live = db.prepare("SELECT p.name AS 项目, r.req_no AS 编号, COUNT(*) AS 行数 FROM prd_requirements r JOIN projects p ON p.id=r.project_id WHERE r.req_no IS NOT NULL AND r.req_no<>'' GROUP BY r.project_id, r.req_no HAVING COUNT(*)>1 ORDER BY 行数 DESC LIMIT 30").all();
    const byProj = new Map();
    for (const g of live) byProj.set(g.项目, (byProj.get(g.项目) ?? 0) + 1);
    console.log(`装机库直查重复：共 ${live.length} 组，分布在 ${byProj.size} 个项目`);
    for (const [name, n] of byProj) console.log(`  ${n} 组 | ${name}`);
    for (const g of live.slice(0, 12)) console.log(`    ${g.项目} / ${g.编号} ×${g.行数}`);
  }
  db.close();
} else {
  console.log('（未传库路径，跳过装机库直查）');
}
