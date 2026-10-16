// T02211：符号索引单文件字节上限断言（真实临时目录树 + 内存假库，跑生产 dist 实现）
// 运行：node scripts/t02211-file-size-cap-test.mjs
// 背景（承接 T02200 让路）：让路以「一个文件」为最小工作单元，但 indexFileSymbols 没有字节维度上限
//   ——SYMBOL_LIMIT 只限符号条数。bemp 实测 8.8MB 的 vendor.js 让单个工作单元跑到几百毫秒
//   （T02200 记录的 368~380ms 尖峰即此），让出点形同虚设。检索侧早有 SEARCH_FILE_MAX_BYTES=1MB
//   （超它正文本就读不进 search/memo 窗口），索引侧对齐后：被跳过的文件对检索召回的贡献原为 0。
// 本用例锁：① 超限文件按字节跳过且不读正文；② 其余文件索引不受影响；③ oversized 每轮如实报数
//   （含日志可观测）；④ 单个可切片工作单元的耗时有可证上界。
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const DIST = join(ROOT, 'server', 'dist');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

// ---------- 记账桩：正文读取按路径计数（证明超限文件根本没被读） ----------
const fsMod = require('node:fs');
const origRead = fsMod.readFileSync;
const readByPath = new Map();
fsMod.readFileSync = (p, ...rest) => {
  const key = String(p).replace(/\\/g, '/');
  readByPath.set(key, (readByPath.get(key) ?? 0) + 1);
  return origRead(p, ...rest);
};

// ---------- 内存假库：只实现 WorkspaceService 用到的语句（与 t02210 同一套桩） ----------
const projects = new Map();
const symRows = [];
const delRuns = [];
const fakeDb = {
  prepare(sql) {
    const s = sql.trim();
    return {
      run: (...p) => {
        if (/^INSERT INTO workspace_symbols/i.test(s)) {
          symRows.push({ project_id: p[1], path: p[2], symbol: p[3], line: p[4], kind: p[5], file_mtime: p[6], workspace: p[7] });
          return { changes: 1 };
        }
        if (/^DELETE FROM workspace_symbols WHERE project_id = \? AND workspace <> \?/i.test(s)) {
          const b = symRows.length;
          for (let i = symRows.length - 1; i >= 0; i--) if (symRows[i].project_id === p[0] && symRows[i].workspace !== p[1]) symRows.splice(i, 1);
          return { changes: b - symRows.length };
        }
        if (/^DELETE FROM workspace_symbols WHERE project_id = \? AND path = \?/i.test(s)) {
          delRuns.push(`${p[0]}|${p[1]}`);
          const b = symRows.length;
          for (let i = symRows.length - 1; i >= 0; i--) if (symRows[i].project_id === p[0] && symRows[i].path === p[1]) symRows.splice(i, 1);
          return { changes: b - symRows.length };
        }
        if (/^DELETE FROM workspace_symbols WHERE project_id = \?\s*$/i.test(s)) {
          const b = symRows.length;
          for (let i = symRows.length - 1; i >= 0; i--) if (symRows[i].project_id === p[0]) symRows.splice(i, 1);
          return { changes: b - symRows.length };
        }
        return { changes: 0 };
      },
      get: (id) => (/^SELECT workspace_path FROM projects WHERE id = \?/i.test(s) ? { workspace_path: projects.get(id) ?? null } : undefined),
      all: (...p) => {
        if (/^SELECT path, MAX\(file_mtime\) AS m FROM workspace_symbols/i.test(s)) {
          const agg = new Map();
          for (const r of symRows) if (r.project_id === p[0]) agg.set(r.path, Math.max(agg.get(r.path) ?? -1, r.file_mtime));
          return [...agg.entries()].map(([path, m]) => ({ path, m }));
        }
        if (/^SELECT path, symbol, line, kind FROM workspace_symbols/i.test(s)) {
          const [pid, ws, like, limit] = p;
          const needle = String(like).replace(/^%|%$/g, '');
          return symRows
            .filter((r) => r.project_id === pid && r.workspace === ws && r.symbol.includes(needle))
            .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
            .slice(0, limit)
            .map((r) => ({ path: r.path, symbol: r.symbol, line: r.line, kind: r.kind }));
        }
        return [];
      },
    };
  },
  transaction: (fn) => fn,
};
const connPath = require.resolve(join(DIST, 'db', 'connection.js'));
require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: { getDb: () => fakeDb, reopenDb: () => {}, getDbFile: () => ':memory:' } };
const { WorkspaceService } = require(join(DIST, 'services', 'WorkspaceService.js'));

// ---------- 真实临时树（落 D:：C: 常年 0 可用会 SQLITE_FULL/写树假性失败） ----------
const BASE = 'D:/code/tmp/gate-tmp';
const WS = join(BASE, `t02211-ws-${Date.now().toString(36)}`);
const CAP_BYTES = 1024 * 1024; // 与 SEARCH_FILE_MAX_BYTES / SYMBOL_FILE_MAX_BYTES 同值
mkdirSync(WS, { recursive: true });
mkdirSync(join(WS, 'small'), { recursive: true });
mkdirSync(join(WS, 'mid'), { recursive: true });
mkdirSync(join(WS, 'big'), { recursive: true });
for (let i = 0; i < 6; i++) writeFileSync(join(WS, 'small', `s${i}.ts`), `export function cap_${i}T02211() {}\n`);
// 上限之内的大文件（~0.7MB）：必须照常索引，证明阈值不是「大就不管」
writeFileSync(join(WS, 'mid', 'm.ts'), `export function midMarkerT02211() {}\n${'// pad pad pad pad pad pad pad pad\n'.repeat(Math.floor((0.7 * CAP_BYTES) / 29))}`);
// 超限文件（~8MB）：里面确实有可抽符号，证明它是「本会被索引」而被字节上限拦下
writeFileSync(join(WS, 'big', 'huge.ts'), `export function hugeMarkerT02211() {}\n${'export const pad = 1;\n'.repeat(Math.floor((8 * CAP_BYTES) / 21))}`);
const BIG_REL = 'big/huge.ts';
const bigAbs = join(WS, BIG_REL);
check('F-00 夹具就位：超限文件确实 >1MB 且含可抽符号', statSync(bigAbs).size > CAP_BYTES, `${(statSync(bigAbs).size / 1048576).toFixed(1)}MB`);

const pid = 'p-cap';
projects.set(pid, WS);
// 预置一条「上限引入前已索引过」的大文件条目：新口径必须把它清掉，且只在首次清
symRows.push({ project_id: pid, path: 'big/huge.ts', symbol: 'legacyHugeT02211', line: 1, kind: 'function', file_mtime: 1, workspace: resolve(WS) });

console.log('--- 1. 主口径：超限文件按字节跳过、不读正文，其余不受影响 ---');
const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
const r1 = await WorkspaceService.refreshSymbols(pid, 60000);
console.log = realLog;
check('F-01 首轮 files 不含超限文件（6 小 + 1 中 = 7）', r1?.files === 7, JSON.stringify(r1));
check('F-02 oversized 如实报 1', r1?.oversized === 1, `oversized=${r1?.oversized}`);
check('F-03 超限文件正文一次都没读', (readByPath.get(bigAbs.replace(/\\/g, '/')) ?? 0) === 0, `reads=${readByPath.get(bigAbs.replace(/\\/g, '/')) ?? 0}`);
check('F-04 超限文件符号不入索引，且上限引入前的历史条目被清掉',
  WorkspaceService.querySymbols(pid, 'hugeMarkerT02211').length === 0 && WorkspaceService.querySymbols(pid, 'legacyHugeT02211').length === 0,
  `huge=0 legacy=${WorkspaceService.querySymbols(pid, 'legacyHugeT02211').length}`);
check('F-05 上限内的 0.7MB 文件照常索引', WorkspaceService.querySymbols(pid, 'midMarkerT02211').length === 1, 'query=midMarkerT02211 → 1');
check('F-06 其余文件索引不受影响', WorkspaceService.querySymbols(pid, 'cap_', 50).length === 6, `cap_ 命中=${WorkspaceService.querySymbols(pid, 'cap_', 50).length}`);
check('F-07 刷新日志点名按上限跳过（可观测，非静默降召回）', logs.some((l) => /上限跳过 1 个/.test(l)), logs.filter((l) => /上限/.test(l))[0] ?? '(无该日志行)');

console.log('--- 2. 观测稳定性与增量语义：oversized 每轮都报，删除只做一次 ---');
const r2 = await WorkspaceService.refreshSymbols(pid, 60000);
check('F-08 二轮仍报 oversized=1 且 files=0（mtime 增量未破）', r2?.oversized === 1 && r2?.files === 0, JSON.stringify(r2));
check('F-09 超限文件的条目删除只发生一次（不逐轮重复写）', delRuns.filter((d) => d.endsWith(`|${BIG_REL}`)).length === 1, `del=${delRuns.filter((d) => d.endsWith(`|${BIG_REL}`)).length}`);

console.log('--- 3. 单个可切片工作单元的耗时有可证上界（本单主诉求） ----------');
const WS2 = join(BASE, `t02211-onlybig-${Date.now().toString(36)}`);
mkdirSync(join(WS2, 'big'), { recursive: true });
writeFileSync(join(WS2, 'big', 'huge.ts'), origRead(bigAbs));
projects.set('p-only', WS2);
const t0 = performance.now();
const rOnly = await WorkspaceService.refreshSymbols('p-only', 60000);
const newCost = performance.now() - t0;
// 旧口径对照（只读预演，不入被测实现）：读正文 + 用生产同一组 extractor 正则扫
const extractors = WorkspaceService.SYMBOL_EXTRACTORS;
const t1 = performance.now();
const text = origRead(bigAbs, 'utf8');
for (const ex of extractors) {
  if (!ex.exts.map((e) => (e.startsWith('.') ? e : `.${e}`)).includes('.ts')) continue;
  const re = new RegExp(ex.re.source, ex.re.flags);
  let m, c = 0;
  while ((m = re.exec(text)) !== null && c < 200) { text.slice(0, m.index).split('\n').length; c++; }
}
const oldCost = performance.now() - t1;
check('F-10 新口径单轮（仅超限文件）远低于 25ms 时间片', newCost < 25 && rOnly?.oversized === 1 && rOnly?.files === 0, `${newCost.toFixed(1)}ms ${JSON.stringify(rOnly)}`);
check('F-11 旧口径（读正文+正则扫）成本可证地更高', oldCost > newCost * 3, `旧 ${oldCost.toFixed(1)}ms vs 新 ${newCost.toFixed(1)}ms`);

console.log('--- 4. 检索增强质量口径不回退 ---');
const ctx = await WorkspaceService.autoContext(pid, ['cap_0T02211']);
// memo 常驻文本按小写比对（原实现即如此），断言口径随之取小写
check('F-12 检索增强块仍命中代码片段', ctx.toLowerCase().includes('cap_0t02211') && ctx.length > 0, `ctx=${ctx.length}字`);
const src0 = origRead(join(ROOT, 'server', 'src', 'services', 'WorkspaceService.ts'), 'utf8');
check('F-13 超限文件在检索侧本来就是不可见的（本单未新增召回损失）',
  src0.includes('if (buf.length > SEARCH_FILE_MAX_BYTES) return 0;') && src0.includes('if (buf.length > SEARCH_FILE_MAX_BYTES) return -1;'),
  'search 与 memo 两处早于本单就按同一 1MB 阈值跳过正文');

console.log('--- 5. 接线静态核对 ---');
const src = origRead(join(ROOT, 'server', 'src', 'services', 'WorkspaceService.ts'), 'utf8');
check('G-01 字节上限与检索侧同族同值', /const SYMBOL_FILE_MAX_BYTES = SEARCH_FILE_MAX_BYTES;/.test(src), 'SYMBOL_FILE_MAX_BYTES ← SEARCH_FILE_MAX_BYTES');
check('G-02 上限判定发生在 mtime 增量之前（oversized 每轮如实）', src.indexOf('if (st.size > SYMBOL_FILE_MAX_BYTES)') < src.indexOf('if (seen) { ctx.skipped++; return; }'), 'size 检查在前');
check('G-03 符号上限截断仍不登记快照（T02210 护栏未被本单改动）', src.includes('else if (!state.truncated)') && src.includes('if (!job.state.truncated) commitTreeSnapshot'), '两处登记均受截断护栏');
check('G-04 短路返回复述 oversized（不抹成 0）', src.includes('oversized: snap.oversized'), '快照携带超限数');

// ---------- 收尾 ----------
fsMod.readFileSync = origRead;
for (const p of [pid, 'p-only']) WorkspaceService.clearSymbols(p);
rmSync(WS, { recursive: true, force: true });
rmSync(WS2, { recursive: true, force: true });
console.log(`\nT02211 单文件字节上限：PASS=${pass} FAIL=${fail}`);
process.exitCode = fail > 0 ? 1 : 0;
