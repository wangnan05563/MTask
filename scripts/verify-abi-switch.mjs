/**
 * T02069 回归自测：better-sqlite3 ABI 切换的三条不变量（快照先于切换、按字节还原、缓存缺失 fail-fast），
 * 以及 scripts/dist.js / scripts/打包.mjs 的接线顺序守卫。
 *
 * 背景：package.json 的 build.npmRebuild = false，包内原生模块就是打包时工作区那一份，谁忘了切
 * Electron ABI 就会打出「装机即废」的包（0.1.1011.193 实测 NODE_MODULE_VERSION 127 vs 130），
 * 而顺序写反（切换后取快照）会让工作区永久留在 Electron ABI，本地 node 直跑 server/dist 反而坏掉。
 * 两个方向都由本脚本钉住。
 *
 * 用法：node scripts/verify-abi-switch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { switchAbi, snapshotWorkspaceAbi, restoreWorkspaceAbi } from './lib/abi-switch.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-switch-'));
const ws = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const put = (p, buf) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };
const opts = { fail: (m) => { throw new Error('FAIL:' + m); }, log: () => {} };

put(ws, Buffer.from('WS'));
put(path.join(root, 'build', 'native', 'electron', 'better_sqlite3.node'), Buffer.from('EL'));
put(path.join(root, 'build', 'native', 'dev', 'better_sqlite3.node'), Buffer.from('DV'));

// 1) 快照 → 切换 → 还原：工作区逐字节回到打包前
const snap = snapshotWorkspaceAbi(root);
switchAbi(root, 'electron', opts);
assert.equal(fs.readFileSync(ws).toString(), 'EL');
restoreWorkspaceAbi(root, snap, opts);
assert.equal(fs.readFileSync(ws).toString(), 'WS');
console.log('PASS 1 快照先于切换、按字节还原（工作区回到打包前内容）');

// 2) 反证：先切换再取快照 = 还原等于没做，Electron ABI 留在工作区
switchAbi(root, 'electron', opts);
restoreWorkspaceAbi(root, snapshotWorkspaceAbi(root), opts);
assert.equal(fs.readFileSync(ws).toString(), 'EL');
put(ws, Buffer.from('WS'));
console.log('PASS 2 反证：切换后取快照会把 Electron ABI 留在工作区（正确顺序已由此钉住）');

// 3) 缓存缺失 → fail-fast，工作区不被污染
assert.throws(() => switchAbi(root, 'nonexistent', opts), /ABI 缓存缺失/);
assert.equal(fs.readFileSync(ws).toString(), 'WS');
console.log('PASS 3 缓存缺失 fail-fast，未污染工作区');

// 4) 工作区本就没有 .node（快照为 null）→ 还原回落 dev 缓存
fs.rmSync(ws);
assert.equal(snapshotWorkspaceAbi(root), null);
switchAbi(root, 'electron', opts);
restoreWorkspaceAbi(root, null, opts);
assert.equal(fs.readFileSync(ws).toString(), 'DV');
console.log('PASS 4 无快照时还原回落 dev 缓存');

// 5) 接线守卫：两条打包链都必须复用同一实现、先快照后切换，dist.js 还须在 exit/error 两个出口都还原
const distSrc = fs.readFileSync(path.join(REPO, 'scripts', 'dist.js'), 'utf8');
assert.ok(distSrc.includes("import('./lib/abi-switch.mjs')"), 'dist.js 未复用共享实现');
assert.ok(distSrc.indexOf('snapshotWorkspaceAbi(') < distSrc.indexOf('switchAbi(ROOT'), 'dist.js 未先取快照再切换');
assert.equal((distSrc.match(/restoreWorkspaceAbi\(ROOT, prevAbi, abiOpts\)/g) || []).length, 2, 'dist.js 需在 exit/error 两条出口都还原');
const pkgSrc = fs.readFileSync(path.join(REPO, 'scripts', '打包.mjs'), 'utf8');
assert.ok(pkgSrc.includes("from './lib/abi-switch.mjs'"), '打包.mjs 未复用共享实现');
assert.ok(pkgSrc.indexOf('snapshotWorkspaceAbi(ROOT)') < pkgSrc.indexOf("switchAbi(ROOT, 'electron', abiOpts)"), '打包.mjs 未先取快照再切换');
assert.equal((pkgSrc.match(/restoreWorkspaceAbi\(ROOT, prevAbi, abiOpts\)/g) || []).length, 1);
console.log('PASS 5 dist.js / 打包.mjs 接线顺序与还原出口守卫');

fs.rmSync(root, { recursive: true, force: true });
console.log('\nverify-abi-switch: 5/5 PASS');
