/**
 * T04546 验收门：派生单结论二次修订必须回灌母单（alreadyMerged 幂等判据升级为内容等价）。
 *
 * work order 锚定词（R-318：本组断言引用的路径/词形与本单正文一致）：
 *   `scripts/verify/T04546-merge-revision-gate.mts`（本门自指）
 *   `alreadyMerged` / `mergedContentMatches` / `refreshMergedBody` / `派生单回填` / `未回灌`
 *   母单正文里的标记形态：`【派生单 Txxxx 处理结果 日期】`（自动归并通道）、
 *   `## 派生单回填 Txxxx（日期）`（技能脚本 `mcp-direct-call.py merge` 补录通道）
 *
 * 守的行为判据（不读源码文本凑绿）：
 *   A 组：幂等判据从「编号标记存在」升级为「内容等价」——一致才跳过，不一致即视为待回灌；
 *   B 组：回灌写法——母单其余内容逐字保留、只刷新本单最后一节、不新造第三种标题；
 *   C 组：接线字面锚点——结果通道真的用上了 A/B 两组判据（防「函数写了没接上」）。
 *
 * 用法：node ./node_modules/tsx/dist/cli.mjs scripts/verify/T04546-merge-revision-gate.mts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  alreadyMerged,
  findMergedSections,
  mergedContentMatches,
  refreshMergedBody,
} from '../../server/src/services/derivedOrigin.ts';

let pass = 0;
let fail = 0;
const lines: string[] = [];
const group = (t: string) => lines.push(`\n—— ${t} ——`);
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};

const NO = 'T04527';
const OTHER = 'T04186';
/** 自动归并通道写出的形态（与 `server/src/mcp/server.ts` 结果通道逐字一致） */
const autoSection = (no: string, date: string, body: string) => `---\n【派生单 ${no} 处理结果 ${date}】\n${body}`;
/** 技能脚本 merge 的补录形态（与 `mcp-direct-call.py merge` 逐字一致） */
const backfillSection = (no: string, date: string, body: string) => `## 派生单回填 ${no}（${date}）\n${body}`;

const V1 = '## 根因\n\n首版结论。\n\n## 验证\n\n门 A 通过。';
const V2 = '## 根因\n\n修订后结论。\n\n## 验证\n\n门 A 通过。';

// ---------------------------------------------------------------------------
group('A 组 · 幂等判据：一致才跳过，不一致即待回灌');
// ---------------------------------------------------------------------------
ok('A-01 母单无本单标记：既不算已归并、也无内容可比 ⇒ 走首次归并追加',
  alreadyMerged('母单自己的结论', NO) === false && mergedContentMatches('母单自己的结论', NO, V1) === false);
const M1 = `母单原文\n\n${autoSection(NO, '2026-11-06', V1)}`;
ok('A-02 已归并且内容逐字一致 ⇒ 判「内容一致」真幂等（不重复追加）',
  alreadyMerged(M1, NO) === true && mergedContentMatches(M1, NO, V1) === true);
ok('A-03 已归并但子单修订过 ⇒ 判不一致（旧判据在此静默跳过，母单永久停在首版快照）',
  alreadyMerged(M1, NO) === true && mergedContentMatches(M1, NO, V2) === false);
ok('A-04 归档门口径不变：内容不等价时 alreadyMerged 仍为真（T03637 只问「有没有归并记录」）',
  alreadyMerged(M1, NO) === true);
const M2 = `母单原文\n\n${backfillSection(NO, '2026-11-06', V1)}`;
ok('A-05 补录形态（脚本 merge 写的标题）同样能定位并比对',
  findMergedSections(M2, NO).length === 1 && mergedContentMatches(M2, NO, V1) === true
  && mergedContentMatches(M2, NO, V2) === false);
ok('A-06a CRLF 换的行尾差异不算修订', mergedContentMatches(M1, NO, V1.replace(/\n/g, '\r\n')) === true,
  JSON.stringify({ lf: mergedContentMatches(M1, NO, V1), crlf: mergedContentMatches(M1, NO, V1.replace(/\n/g, '\r\n')) }));
ok('A-06b 首尾空行不算修订', mergedContentMatches(M1, NO, `\n\n${V1}  \n`) === true);
ok('A-06c 行末空白不算修订（行中多一个空格仍算修订，判据不能糊掉真改动）',
  mergedContentMatches(M1, NO, V1.replace('## 根因', '## 根因   ')) === true
  && mergedContentMatches(M1, NO, V1.replace('首版结论', '首版结论 ')) === false);
ok('A-07 少一行就是少一行（正文长度差 1 行必须判不一致）',
  mergedContentMatches(autoSection(NO, '2026-11-06', V1), NO, V1 + '\n\n新增一行') === false);
const M3 = `母单原文\n\n${autoSection(NO, '2026-10-01', V1)}\n\n${autoSection(OTHER, '2026-10-02', '别单的结论')}`;
ok('A-08 母单里混着别的单的归并节：本单比对不受干扰',
  findMergedSections(M3, NO).length === 1 && mergedContentMatches(M3, NO, V1) === true);
ok('A-09 同一单历史叠加两节（旧缺陷留下的）⇒ 比最后一节',
  (() => {
    const text = `${autoSection(NO, '2026-09-01', '旧版快照')}\n\n${autoSection(NO, '2026-11-06', V1)}`;
    return findMergedSections(text, NO).length === 2 && mergedContentMatches(text, NO, V1) === true
      && mergedContentMatches(text, NO, '旧版快照') === false;
  })());
ok('A-10 编号查无对应节时不误判「内容一致」（UUID 兜底编号也按字面定位）',
  mergedContentMatches(autoSection('T99999', '2026-11-06', V1), NO, V1) === false
  && findMergedSections(autoSection(NO, '2026-11-06', V1), undefined).length === 0
  && findMergedSections(null, NO).length === 0);
ok('A-11 标题缺日期槽位（空日期）仍能定位槽位，不会把日期写进行首',
  (() => {
    const text = autoSection(NO, '', V1);
    const refreshed = refreshMergedBody(text, NO, V1, '2026-11-07');
    return findMergedSections(text, NO).length === 1
      && refreshed.includes(`【派生单 ${NO} 处理结果 2026-11-07】`)
      && !refreshed.startsWith('2026');
  })());

// ---------------------------------------------------------------------------
group('B 组 · 回灌写法：母单其余内容逐字保留，不新造第三种标题');
// ---------------------------------------------------------------------------
const r1 = refreshMergedBody(M1, NO, V2, '2026-11-07');
ok('B-01 刷新后母单含修订全文（旧版：此断言必红，正是本单缺陷本体）',
  r1.includes(V2) && !r1.includes('首版结论'), r1.slice(0, 160));
ok('B-02 母单原有正文逐字保留（前置内容一个字不许丢）',
  r1.startsWith('母单原文\n\n'));
ok('B-03 刷新后仍判「内容一致」⇒ 同版重复回传不会反复写库',
  mergedContentMatches(r1, NO, V2) === true);
ok('B-04 沿用命中的标题形态，只把日期槽写成本次回灌日（不新增第三种标记）',
  r1.includes(`【派生单 ${NO} 处理结果 2026-11-07】`) && (r1.match(/【派生单/g) || []).length === 1, r1.slice(0, 120));
const r2 = refreshMergedBody(M2, NO, V2, '2026-11-07');
ok('B-05 补录形态同样就地刷新（## 派生单回填 标题与日期槽保持原形）',
  r2.includes(`## 派生单回填 ${NO}（2026-11-07）`) && r2.includes(V2) && (r2.match(/派生单回填/g) || []).length === 1);
const r3 = refreshMergedBody(M3, NO, V2, '2026-11-07');
ok('B-06 别的单那一节原样不动（跨单不串写）',
  r3.includes(autoSection(OTHER, '2026-10-02', '别单的结论')), r3.slice(-200));
const r4 = refreshMergedBody(`${autoSection(NO, '2026-09-01', '旧版快照')}\n\n${autoSection(NO, '2026-11-06', V1)}`, NO, V2, '2026-11-07');
ok('B-07 历史两节只刷最后一节，前节留作对照',
  r4.includes('旧版快照') && r4.lastIndexOf(V2) > r4.lastIndexOf(V1) && (r4.match(/首版结论/g) || []).length === 0);
const r5 = refreshMergedBody('母单原文', NO, V2, '2026-11-07');
ok('B-08 标记存在但标题形制不认识（存量脏数据）⇒ 按补录通道标题追加，不硬改写',
  r5 === `母单原文\n\n${backfillSection(NO, '2026-11-07', V2)}` || (r5.includes('## 派生单回填') && r5.startsWith('母单原文')), r5.slice(0, 160));
ok('B-09 母单为空也能落第一版（不写出前导空行）',
  refreshMergedBody('', NO, V1, '2026-11-07') === backfillSection(NO, '2026-11-07', V1));
const r6 = refreshMergedBody(`母单原文\n\n${autoSection(NO, '2026-11-06', V1)}\n\n---\n【派生单 ${OTHER} 处理结果 2026-11-06】\n别单`, NO, V2, '2026-11-07');
ok('B-10 刷新后与下一节之间的分隔线仍在（不产出「正文紧贴 ---」的畸形文档）',
  r6.includes(`${V2}\n\n---\n`), r6.slice(r6.indexOf('## 验证'), r6.indexOf('## 验证') + 120));
ok('B-11 幂等：内容一致时通道不再调用刷新（判据分层，刷新只在需要时发生）',
  mergedContentMatches(r6, NO, V2) === true);

// ---------------------------------------------------------------------------
group('C 组 · 接线字面锚点（结果通道真的用上了这两把判据）');
// ---------------------------------------------------------------------------
const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const mcpSrc = src('server/src/mcp/server.ts');
const utilSrc = src('server/src/services/derivedOrigin.ts');
ok('C-01 结果通道引入内容等价判据与刷新函数（不是只加函数不接线）',
  /import \{[^}]*mergedContentMatches[^}]*refreshMergedBody[^}]*\} from '\.\.\/services\/derivedOrigin'/.test(mcpSrc));
const iA = mcpSrc.indexOf('else if (alreadyMerged(');
const iM = mcpSrc.indexOf('mergedContentMatches(', iA);
const iR = mcpSrc.indexOf('refreshMergedBody(', iM);
ok('C-02 已归并分支拆成「内容一致才跳过」+「不一致就回灌」（三者同一段落内按序出现）',
  iA > 0 && iM > iA && iR > iM && iR - iA < 900, { iA, iM, iR });
ok('C-03 回灌写回走 TaskService.update 的 handle_result（严禁绕过接口层直写库）',
  /TaskService\.update\(origin\.id, \{\s*handle_result: refreshMergedBody\(/.test(mcpSrc)
  && !/UPDATE tasks SET handle_result/.test(mcpSrc));
ok('C-04 回灌后置原单 unread（用户看得见母单有新内容），一致跳过时不打扰',
  (mcpSrc.match(/TaskService\.setAiState\(origin\.id, 'unread'\)/g) || []).length === 2
  && /内容一致，未重复追加/.test(mcpSrc));
ok('C-05 回执文案区分两种结局（修订回灌必须当场说出来，旧版对修订零提示）',
  /归并快照已按本次修订刷新/.test(mcpSrc) && /内容一致，未重复追加/.test(mcpSrc));
ok('C-06 判据单源：MCP 与脚本共用同一份 alreadyMerged，视图层没另写标记规则',
  (utilSrc.match(/export function alreadyMerged/g) || []).length === 1
  && !/UPDATE tasks SET handle_result/.test(utilSrc));
ok('C-07 纯函数模块不 import React/TaskService（可进 node 门，注释里的字样不算依赖）',
  !/^import\s[^\n]*TaskService/m.test(utilSrc) && !/^import\s[^\n]*from 'react/m.test(utilSrc)
  && /^import \{ getDb \} from '\.\.\/db\/connection';$/m.test(utilSrc));
ok('C-08 归档门仍按「有没有归并标记」判（本单只改回灌，不动 T03637 归档语义）',
  /if \(!origin \|\| !alreadyMerged\(origin\.handle_result, t\.task_no\)\) return false;/.test(src('server/src/services/TaskService.ts')));

console.log(lines.join('\n'));
console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
