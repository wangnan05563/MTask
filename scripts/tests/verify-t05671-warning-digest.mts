/**
 * T05671 门：启动会稿「版式/降级提示」的可读化（分级 + 归并 + 去内部术语）。
 *
 * 缺陷形态（真实现场）：生成完成后面板平铺 8 条提示，其中 4 条是「第 N 页：要点为表格让位压缩排版
 * （自然高 2.71" → 实排 2.67"，多余部分按 pptxgenjs 截字）」，外加 PRD 文档 UUID、AI 超时的域名与
 * 毫秒数；溯源行再用「；」把这 8 条拼成 521 字一整段。用户既读不懂，也分不清「哪条要管、哪条是正常分页」。
 *
 * 判据：
 *   A 组 纯函数——真实 8 条样本归并为 5 条；同类版式合并并带页码；标题不含 UUID/域名/自然高/pptxgenjs；
 *        措辞降级压成一句人话；阶段链属「分页说明」而非降级；未知提示不吞；空输入不炸；入参不被改写。
 *   B 组 源码锚——service 产出 warningItems 且溯源用紧凑文案；done 负载下发 warningItems；
 *        前端默认折叠、优先结构化、旧结果可回退；原始 warnings 仍逐字下发（既有门与旧前端零回归）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05671-warning-digest.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

// ---------------- A 组：纯函数（T05671 任务描述里的 8 条原文，逐字） ----------------
const W = await import('../../server/src/services/kickoffWarnings.ts');

const RAW: string[] = [
  'PRD 摘要超出 6000 字已保头保尾截断（全文见 PRD 文档 028063cd-7f3e-4f33-8b61-2a739764f73f）',
  '风险措辞 AI 失败，已用本地条目（原因：fetch failed（原因：Connect Timeout Error (attempted address: apihub.agnes-ai.com:443, timeout: 10000ms)）（已自动重试 1 次））',
  '第 2 页：要点为表格让位压缩排版（自然高 2.71" → 实排 2.67"，多余部分按 pptxgenjs 截字）',
  '第 4 页：要点为表格让位压缩排版（自然高 1.51" → 实排 1.48"，多余部分按 pptxgenjs 截字）',
  '第 8 页：要点为表格让位压缩排版（自然高 1.21" → 实排 0.97"，多余部分按 pptxgenjs 截字）',
  '第 12 页：要点为表格让位压缩排版（自然高 1.51" → 实排 1.05"，多余部分按 pptxgenjs 截字）',
  '第 12 页：阶段链只承载前 5 个里程碑，其余 49 个见时间线页（一条不丢）',
  '第 12 页：4 个阶段名超出节点宽度，已截断显示（完整名称见里程碑页）',
];

const snapshot = JSON.stringify(RAW);
const items = W.classifyKickoffWarnings(RAW);
const compact = W.compactKickoffWarnings(RAW);
const summary = W.summarizeKickoffWarnings(items);
const byCode = (code: string) => items.filter((i) => i.code === code);
const one = (code: string) => byCode(code)[0];

ok('A-01 8 条原始提示归并为 5 条（4 条同类版式压缩合并成 1 条）',
  RAW.length === 8 && items.length === 5, { raw: RAW.length, items: items.map((i) => i.code) });

ok('A-02 分级正确：仅 1 条 warn（措辞降级）、0 条 error、4 条 info',
  summary.warnCount === 1 && summary.errorCount === 0 && summary.infoCount === 4, summary);

const compactItem = one('layout-compact');
ok('A-03 版式压缩带页码且页码升序去重（2/4/8/12）',
  !!compactItem && JSON.stringify(compactItem.pages) === JSON.stringify([2, 4, 8, 12])
  && compactItem.title.includes('4 页'), compactItem);

ok('A-04 版式标题不含内部度量（自然高 / 实排 / pptxgenjs）',
  !!compactItem && !/自然高|实排|pptxgenjs|2\.71|2\.67/.test(compactItem.title), compactItem?.title);

const prd = one('prd-truncated');
ok('A-05 PRD 截断标题不含文档 UUID 与字数，且仍是 info（不惊扰）',
  !!prd && prd.level === 'info' && !/028063cd|[0-9a-f]{8}-[0-9a-f]{4}-|6000/.test(prd.title), prd?.title);

const wording = one('wording-fallback');
ok('A-06 措辞降级压成一句人话：不含域名/超时毫秒/嵌套括号',
  !!wording && wording.level === 'warn'
  && !/apihub|agnes-ai|timeout|10000ms|fetch failed/i.test(wording.title)
  && /本地条目/.test(wording.title) && /超时/.test(wording.title), wording?.title);
ok('A-07 措辞降级的原始堆栈仍完整留在 detail（可追，不丢证据）',
  !!wording?.detail && /apihub\.agnes-ai\.com:443/.test(wording.detail), wording?.detail?.slice(0, 80));

const chain = one('milestone-paging');
ok('A-08 阶段链属「分页说明」而非降级，标题不含「第 12 页：」前缀',
  !!chain && chain.level === 'info' && !/^第\s*12\s*页/.test(chain.title) && /时间线页/.test(chain.title), chain?.title);

const clip = one('stage-label-clip');
ok('A-09 阶段名缩写同为说明级，且给出「完整名称在哪」的落点',
  !!clip && clip.level === 'info' && /完整名称见里程碑页/.test(clip.title), clip?.title);

ok('A-10 溯源紧凑文案显著变短（≤ 原文 1/3），条数不减少不等于丢信息',
  compact.length === items.length && compact.join('；').length <= RAW.join('；').length / 3,
  { rawLen: RAW.join('；').length, compactLen: compact.join('；').length, lines: compact.length });
ok('A-11 紧凑文案同样不含 UUID / 域名 / 自然高',
  !compact.some((s) => /028063cd|apihub|agnes-ai|自然高|pptxgenjs/.test(s)), compact);

ok('A-12 空输入不炸：返回空列表，摘要不出现 NaN/undefined',
  JSON.stringify(W.classifyKickoffWarnings([])) === '[]'
  && !/NaN|undefined/.test(W.summarizeKickoffWarnings([]).headline), W.summarizeKickoffWarnings([]));

const unknown = W.classifyKickoffWarnings(['第 7 页：这是一条尚未分类的新提示']);
ok('A-13 未知提示不被吞：降级为 warn/other，原文留 detail，页码仍解析',
  unknown.length === 1 && unknown[0].code === 'other' && unknown[0].level === 'warn'
  && unknown[0].detail === '第 7 页：这是一条尚未分类的新提示'
  && JSON.stringify(unknown[0].pages) === '[7]', unknown);

const htmlFail = W.classifyKickoffWarnings(['HTML 版生成失败，本次仅提供 PPTX（原因：写盘失败）']);
ok('A-14 HTML 版缺失是 error 级（功能缺口，不能被当成排版说明）',
  htmlFail.length === 1 && htmlFail[0].level === 'error' && /仅提供 PPTX/.test(htmlFail[0].title), htmlFail);

ok('A-15 纯函数：同一输入两次分类结果一致，且不改写入参数组',
  JSON.stringify(W.classifyKickoffWarnings(RAW)) === JSON.stringify(items) && JSON.stringify(RAW) === snapshot);

// ---------------- B 组：源码锚（工作树；提交后由既有门继续守） ----------------
const SVC = readFileSync(join(ROOT, 'server/src/services/kickoffService.ts'), 'utf8');
const ROUTE = readFileSync(join(ROOT, 'server/src/routes/plans.ts'), 'utf8');
const PANEL = readFileSync(join(ROOT, 'web/src/pages/KickoffPptPanel.tsx'), 'utf8');
const STORE = readFileSync(join(ROOT, 'web/src/stores/kickoffPptStore.ts'), 'utf8');

ok('B-01 service 用 classify 产出 warningItems，溯源 truncations 改用紧凑文案',
  /const warningItems = classifyKickoffWarnings\(allWarnings\)/.test(SVC)
  && /truncations: compactKickoffWarnings\(allWarnings\)/.test(SVC), {
  classify: /classifyKickoffWarnings\(allWarnings\)/.test(SVC),
  compact: /compactKickoffWarnings\(allWarnings\)/.test(SVC),
});

ok('B-02 原始 warnings 仍逐字下发（既有门 t02103/t02111/t02166 与旧前端零回归）',
  /warnings: allWarnings/.test(SVC) && /warnings: string\[\]/.test(SVC));

ok('B-03 SSE done 负载带 warningItems（与 warnings 同批同源）',
  /warningItems: r\.warningItems/.test(ROUTE));

ok('B-04 前端类型同时保留 warnings 原始数组与可选 warningItems',
  /warnings: string\[\]/.test(STORE) && /warningItems\?: KickoffWarningItem\[\]/.test(STORE));

ok('B-05 前端提示区默认折叠（details 不带 open），且优先消费结构化项',
  /data-t05671="warning-digest"/.test(PANEL)
  && !/<details data-t05671="warning-digest"\s+open/.test(PANEL)
  && /result\.warningItems\?\.length/.test(PANEL));

ok('B-06 旧结果可回退：无 warningItems 时按 warnings 逐条展示，不显示成「无提示」',
  /result\.warnings\.map\(\(w\) => \(\{ code: 'raw'/.test(PANEL));

ok('B-07 旧形态（8 条带索引平铺）已移除',
  !/result\.warnings\.map\(\(w, i\) => <div/.test(PANEL));

ok('B-08 技术细节二级折叠：原始串不占默认视觉',
  /技术细节/.test(PANEL) && /it\.detail/.test(PANEL));

const summaryLine = `T05671 提示可读化门：PASS ${pass} / FAIL ${fail}`;
lines.unshift(summaryLine);
const body = lines.join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05671-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05671-gate-results.txt')}`);
