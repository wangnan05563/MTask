/**
 * T02795 批㊳ 三档双向夹具（反模式 58 口径：0 读数必须由注入道负责在位性）。
 *
 * `undefined-identifier-check.mts` 的三档独立判据各配「注入必命中 + 合法必通过」成对例：
 *  - 档一 checkBlockScope 块作用域（块内词法声明块外读用）
 *  - 档二 checkTdz 先读后声明（含同语句初始化式自读、分组块容器）
 *  - 档三 checkModuleMix 模块体系错配（.mjs/.mts 里的 CJS 记号、.cjs/.cts 里的静态 import/export）
 *
 * 既单独可跑（`node node_modules/tsx/dist/cli.mjs scripts/t02795-tier-fixtures.mts`），
 * 也被 `verify-t02205-guard-selfcheck` 的 L-05 道 import 后并入成败判定——两处同一份表，不复制判例。
 */
import { checkBlockScope, checkTdz, checkModuleMix, type TierHit } from './lib/undefined-identifier-check.mts';

export type TierName = '块作用域' | 'TDZ' | '模块体系';
export interface TierCase {
  id: string;
  tier: TierName;
  name: string;
  fileName: string;
  code: string;
  /** true＝该例必须命中（注入）；false＝必须 0 命中（合法） */
  expectHit: boolean;
  /** 命中时期望点名的标识符；缺省只要求「有命中」 */
  expectName?: string;
}

const run: Record<TierName, (code: string, fileName: string) => TierHit[]> = {
  块作用域: checkBlockScope, TDZ: checkTdz, 模块体系: checkModuleMix,
};

export const TIER_CASES: TierCase[] = [
  // ── 档一 块作用域 ──
  { id: 's1', tier: '块作用域', name: '注入：if 块内 let、块外读用', fileName: 'probe1.ts', code: `function f(x){ if(x){ let a = 1; } return a; }`, expectHit: true, expectName: 'a' },
  { id: 's2', tier: '块作用域', name: '合法：块内读自家 let', fileName: 'probe1.ts', code: `function f(x){ if(x){ let a = 1; return a; } return 0; }`, expectHit: false },
  { id: 's3', tier: '块作用域', name: '合法：箭头参数跨链使用（.map((m)=>m.called)）', fileName: 'probe1.ts', code: `const ys = xs.filter(x=>x).map((m) => m.called);`, expectHit: false },
  { id: 's4', tier: '块作用域', name: '合法：var 提升语义不入本档', fileName: 'probe1.ts', code: `function f(x){ if(x){ var v = 1; } return v; }`, expectHit: false },
  { id: 's5', tier: '块作用域', name: '合法：for 头 let + 体内读', fileName: 'probe1.ts', code: `for (let i = 0; i < 3; i++) { console.log(i); }`, expectHit: false },
  { id: 's6', tier: '块作用域', name: '注入：函数上下文中 switch 内层块 let、switch 后读用', fileName: 'probe1.ts', code: `function g(k){ switch (k) { case 1: { let s = 2; break; } } console.log(s); }`, expectHit: true, expectName: 's' },
  { id: 's7', tier: '块作用域', name: '合法：switch 各 case 各自声明同名、各自块内读', fileName: 'probe1.ts', code: `function g(k){ switch (k) { case 1: { let s = 2; console.log(s); break; } case 2: { let s = 3; console.log(s); break; } } }`, expectHit: false },
  { id: 's8', tier: '块作用域', name: '合法：catch 形参在体内读', fileName: 'probe1.ts', code: `try { f(); } catch (e) { console.log(e.message); }`, expectHit: false },
  { id: 's9', tier: '块作用域', name: '注入：函数上下文中 catch 参数在体后读用', fileName: 'probe1.ts', code: `function h(){ try { f(); } catch (e) { g(); } return e; }`, expectHit: true, expectName: 'e' },
  { id: 's10', tier: '块作用域', name: '合法：重命名解构 const { a: b } = obj 只用 b', fileName: 'probe1.ts', code: `const { renderToStaticMarkup: rt2 } = await import('react-dom/server'); console.log(rt2);`, expectHit: false },
  // 取键位豁免的在位例：同名声明在**别的块里**（真语料 t02157:748/t02144:508 的形状）。
  // 只用 s10 顶形时该豁免撤掉也不红（顶层同名有可见域兜着），撤豁免的牙必须由这条配 L-06 真语料读数负责。
  { id: 's11', tier: '块作用域', name: '合法：重命名解构取键位即使同名在别的块里声明也不报', fileName: 'probe1.ts', code: `if (x) { const renderToStaticMarkup = 2; }\nconst { renderToStaticMarkup: rt2 } = obj; console.log(rt2);`, expectHit: false },
  // ── 档二 TDZ ──
  { id: 't1', tier: 'TDZ', name: '注入：const 之前语句级读用', fileName: 'probe2.ts', code: `console.log(z); const z = 1;`, expectHit: true, expectName: 'z' },
  { id: 't2', tier: 'TDZ', name: '合法：声明后读用', fileName: 'probe2.ts', code: `const z = 1; console.log(z);`, expectHit: false },
  { id: 't3', tier: 'TDZ', name: '合法：函数体内延后读用（main 在 top 前调用 ok）', fileName: 'probe2.ts', code: `async function main(){ await top(); } const top = 1; main();`, expectHit: false },
  { id: 't4', tier: 'TDZ', name: '注入：同语句块 let 自读（let x = x）', fileName: 'probe2.ts', code: `let x = x;`, expectHit: true, expectName: 'x' },
  { id: 't5', tier: 'TDZ', name: '合法：初始化式内读的是别的名字（含解构）', fileName: 'probe2.ts', code: `const a = 1; const { b } = { b: a }; const c = [a, b]; console.log(c);`, expectHit: false },
  { id: 't6', tier: 'TDZ', name: '合法：var 提升不判 TDZ', fileName: 'probe2.ts', code: `console.log(v); var v = 1;`, expectHit: false },
  { id: 't7', tier: 'TDZ', name: '注入：分组块内先读后声明', fileName: 'probe2.ts', code: `function f(){ { console.log(q); let q = 1; } }`, expectHit: true, expectName: 'q' },
  { id: 't8', tier: 'TDZ', name: '合法：各分组块各自声明同名、后续顶层再声明同名（t02043 逐段复用形）', fileName: 'probe2.mts', code: `{ const L = 1; console.log(L); }\n{ const L = 2; console.log(L); }\nconst L = 3; console.log(L);`, expectHit: false },
  { id: 't9', tier: 'TDZ', name: '合法：初始化式内箭头自递归（定义后调用不炸）', fileName: 'probe2.ts', code: `const fn = (n) => (n <= 0 ? 0 : fn(n - 1)); console.log(fn(3));`, expectHit: false },
  // ── 档三 模块体系 ──
  { id: 'm1', tier: '模块体系', name: '注入：.mjs 里 require', fileName: 'probe3.mjs', code: `const fs = require('fs'); console.log(fs);`, expectHit: true, expectName: 'require' },
  { id: 'm2', tier: '模块体系', name: '注入：.mts 里 __dirname', fileName: 'probe3.mts', code: `const p = __dirname; export default p;`, expectHit: true, expectName: '__dirname' },
  { id: 'm3', tier: '模块体系', name: '注入：.mjs 里 import= ', fileName: 'probe3.mjs', code: `import path = require('path'); console.log(path);`, expectHit: true },
  { id: 'm4', tier: '模块体系', name: '合法：.mjs 标准 ESM（require 只出现在字符串与属性名上）', fileName: 'probe3.mjs', code: `import fs from 'fs'; const s = "require('x')"; export default { require: s, fs };`, expectHit: false },
  { id: 'm5', tier: '模块体系', name: '合法：.mjs 里 createRequire 自建 require 垫片后调用', fileName: 'probe3.mjs', code: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const db = require('better-sqlite3'); export default db;`, expectHit: false },
  { id: 'm6', tier: '模块体系', name: '注入：.cjs 顶层 import', fileName: 'probe3.cjs', code: `import fs from 'fs'; module.exports = fs;`, expectHit: true, expectName: 'import' },
  { id: 'm7', tier: '模块体系', name: '注入：.cjs export 关键字', fileName: 'probe3.cjs', code: `export const a = 1;`, expectHit: true, expectName: 'export' },
  { id: 'm8', tier: '模块体系', name: '合法：.cjs 纯 CJS', fileName: 'probe3.cjs', code: `const fs = require('fs'); module.exports = { fs };`, expectHit: false },
];

export interface TierCaseResult {
  id: string; tier: TierName; name: string; expectHit: boolean;
  got: string[]; verdict: boolean;
}
export function runTierCases(): TierCaseResult[] {
  return TIER_CASES.map((c) => {
    const hits = run[c.tier](c.code, c.fileName);
    const got = hits.map((h) => h.name);
    const satisfied = c.expectHit
      ? hits.length > 0 && (!c.expectName || hits.some((h) => h.name === c.expectName))
      : hits.length === 0;
    return { id: c.id, tier: c.tier, name: c.name, expectHit: c.expectHit, got, verdict: satisfied };
  });
}

const invokedAsCli = !!process.argv[1] && /t02795-tier-fixtures\.(mts|ts|mjs|js)$/.test(process.argv[1]);
if (invokedAsCli) {
  const rs = runTierCases();
  for (const r of rs) console.log(`${r.verdict ? 'OK  ' : 'BAD '} [${r.tier}] ${r.id} ${r.name} → ${JSON.stringify(r.got)}`);
  const fails = rs.filter((r) => !r.verdict);
  console.log(fails.length === 0 ? `夹具全部通过（${rs.length} 例）` : `夹具失败 ${fails.length} 条`);
  process.exit(fails.length === 0 ? 0 : 1);
}
