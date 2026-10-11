// T01995：多 PRD 合并导入的 old→new 重映射必须按来源文件分表 —— 对**真实生产实现**（web/src/pages/prdMerge.ts）做断言
// 运行：node t01995-merge-test.mjs        （自行用 tsc 把 prdMerge.ts 编成 ESM 再 import，不复制源码，避免「测的是复刻品」）
// 背景：旧实现跨文件共用一张 map，后份文档的 REQ-001 覆盖前份的同名旧号，前份的 WBS 草稿整体偏移到后份的行上
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根相对本脚本解析：不依赖调用时的 cwd（cwd 不对时 tsc 只会在找不到入参时回显 help）
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'web', 'src', 'pages', 'prdMerge.ts');
// Windows 下 npx 是 .cmd，execFileSync 不能直接调；用当前 node 跑 hoisted 的 tsc 入口。
// ⚠ 不能用 require('typescript/bin/tsc')——那是可执行 shim，require 即在**当前进程**里跑编译器
//   （读当前 argv → 无入参 → 打印 help 后 process.exit），故取 typescript 包路径旁的 lib/tsc.js
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript')), 'tsc.js');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

const dir = mkdtempSync(join(tmpdir(), 't01995-merge-'));
try {
  const OUT = join(dir, 'prdMerge.js');
  // tsc 单文件编译会连带检查仓库内全部 @types，噪音 lib 错误会抬高退出码：
  // 以「产物是否生成」为准，退出码非 0 只打印诊断不直接判死
  let diag = '';
  try {
    execFileSync(process.execPath, [TSC, SRC, '--module', 'es2022', '--target', 'es2022', '--skipLibCheck', '--outDir', dir], { stdio: 'pipe', cwd: ROOT });
  } catch (e) {
    diag = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join('\n');
  }
  if (!existsSync(OUT)) throw new Error(`编译产物缺失：${OUT}\n${diag}`);
  if (diag) console.log(`tsc 诊断（不影响产物）：\n${diag.slice(0, 600)}`);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}'); // 产物是 ESM，临时目录需显式声明模块类型
  const { mergePrdResults } = await import(new URL(`file:///${dir.replace(/\\/g, '/')}/prdMerge.js`).href);

  const reqFile = (prefix, n) => Array.from({ length: n }, (_, i) => {
    const no = `REQ-${String(i + 1).padStart(3, '0')}`;
    return { reqNo: no, title: `${prefix} 需求 ${i + 1}`, content: '', sourceRef: `${prefix}#${i + 1}`, priority: 'normal' };
  });
  // 每份文件的 WBS 都按「本文档内的本地编号」引用（AI 解析的真实形态）
  const planFile = (prefix, n) => Array.from({ length: n }, (_, i) => ({
    title: `${prefix} 计划 ${i + 1}`, description: '', durationDays: 1, kind: 'normal',
    reqNos: [`REQ-${String(i + 1).padStart(3, '0')}`],
  }));
  const A = { requirements: reqFile('A', 20), drafts: planFile('A', 20) };
  const B = { requirements: reqFile('B', 30), drafts: planFile('B', 30) };

  const m1 = mergePrdResults([A]);
  check('U-01 单文件导入不受影响', m1.requirements.length === 20 && m1.drafts.every((d, i) => d.reqNos[0] === `REQ-${String(i + 1).padStart(3, '0')}`),
    `reqs=${m1.requirements.length} 首条引用=${m1.drafts[0].reqNos[0]} 末条引用=${m1.drafts[19].reqNos[0]}`);

  const m2 = mergePrdResults([A, B]);
  check('U-02 合并后编号全局连续（50 行无重号）', m2.requirements.length === 50 && new Set(m2.requirements.map((x) => x.reqNo)).size === 50,
    `reqs=${m2.requirements.length} 唯一=${new Set(m2.requirements.map((x) => x.reqNo)).size}`);

  const aPlans = m2.drafts.filter((d) => d.title.startsWith('A '));
  const bPlans = m2.drafts.filter((d) => d.title.startsWith('B '));
  const aRefs = aPlans.flatMap((d) => d.reqNos);
  const bRefs = bPlans.flatMap((d) => d.reqNos);
  const inRange = (refs, lo, hi) => refs.every((r) => { const n = Number(r.slice(4)); return n >= lo && n <= hi; });
  check('U-03 前份计划只指向前份的行（REQ-001…020）', aRefs.length === 20 && inRange(aRefs, 1, 20), `refs=${aRefs.slice(0, 3).join(',')}…${aRefs.at(-1)}`);
  check('U-04 后份计划只指向后份的行（REQ-021…050）', bRefs.length === 30 && inRange(bRefs, 21, 50), `refs=${bRefs.slice(0, 3).join(',')}…${bRefs.at(-1)}`);
  check('U-05 逐条一一对应（A 计划 i → REQ-00(i+1)，B 计划 i → REQ-0(20+i)）',
    aRefs.every((r, i) => r === `REQ-${String(i + 1).padStart(3, '0')}`) && bRefs.every((r, i) => r === `REQ-${String(21 + i).padStart(3, '0')}`),
    `B 首条=${bRefs[0]} B 末条=${bRefs.at(-1)}`);
  check('U-06 偏移缺陷不复现（前份引用零命中后份区间）', !aRefs.some((r) => Number(r.slice(4)) > 20),
    `越界引用=${aRefs.filter((r) => Number(r.slice(4)) > 20).join(',') || '无'}`);

  const m3 = mergePrdResults([B, A]);
  const b3 = m3.drafts.filter((d) => d.title.startsWith('B ')).flatMap((d) => d.reqNos);
  check('U-07 文件顺序调换后归属仍正确（B 在前 → B 指 REQ-001…030）', inRange(b3, 1, 30), `refs=${b3[0]}…${b3.at(-1)}`);

  // 草稿引用了本文档不存在的需求编号：原样保留（交服务端 unlinkedReqNos 告警），不得借用其他文件的映射
  const stray = mergePrdResults([
    { requirements: reqFile('A', 2), drafts: [{ title: 'A 计划 1', description: '', durationDays: 1, reqNos: ['REQ-999'] }] },
    { requirements: reqFile('B', 2), drafts: [] },
  ]);
  check('U-08 本文档查不到的旧号不被其他文件表命中', stray.drafts[0].reqNos[0] === 'REQ-999', `reqNos=${JSON.stringify(stray.drafts[0].reqNos)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n== T01995 合并重映射：pass=${pass} fail=${fail} ==`);
process.exit(fail ? 1 : 0);
