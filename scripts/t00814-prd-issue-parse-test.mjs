// T00814 断言：PRD 待确认问题清单的三级容错解析 + Word 域代码清理
// 用法：node scripts/t00814-prd-issue-parse-test.mjs
// 依赖：server/dist（先 npm run build:server）——纯函数级测试，不调 LLM、不连库
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseIssuesJson, issuesFromSection, parsePrdIssues, splitPrdBody } = require('../server/dist/services/prdIssues.js');
const { stripWordFieldCodes, isWordFieldToken } = require('../server/dist/util/wordFields.js');

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}
const stages = [];
const onStage = (m) => stages.push(m);

// ---------- 1. JSON 解析容错 ----------
const cases = [
  ['严格协议', '<<<ISSUES>>>\n[{"level":"blocker","question":"导出范围是全部还是筛选结果？","context":"影响入参"}]', 1],
  ['代码围栏包裹', '正文…\n<<<ISSUES>>>\n```json\n[{"level":"suggested","question":"字段是否必输？"}]\n```\n以上。', 1],
  ['JSON 前后夹带解释', '<<<ISSUES>>>\n以下是问题清单：\n[{"question":"是否需要权限控制？"}]\n希望有帮助！', 1],
  ['无标记但有数组', '我先给出结论。\n[{"level":"info","question":"是否兼容旧数据？","context":"迁移"}]\n完毕。', 1],
  ['多个数组取有效者', '[1,2,3] 以及 [{"question":"真正的第一个问题在这里？"}]', 1],
  ['数组内含 ] 字符（配平扫描）', '<<<ISSUES>>>\n[{"question":"条件里含 ] 括号怎么办？","context":"x]y"}]', 1],
  ['空问题被过滤', '[{"question":"  "},{"level":"info"}]', 0],
];
for (const [name, text, want] of cases) {
  const got = parseIssuesJson(text);
  check(`J-${name}`, got.length === want, `得到 ${got.length} 条（期望 ${want}）${got[0] ? '｜示例：' + got[0].question.slice(0, 24) : ''}`);
}

// ---------- 2. 正文「待确认问题」节提取 ----------
const prdA = `# 需求说明\n正文…\n## 八、待确认问题汇总\n- 「导出范围」是全部待办还是当前筛选结果？\n1. 字段是否自研必输？\n\n## 九、附录\n- 这里不应被当成问题（后续章节）\n`;
const secA = issuesFromSection(prdA);
check('S-1 非精确标题（含序号）也能命中', secA.length === 2, `提取 ${secA.length} 条：${secA.map((x) => x.question.slice(0, 16)).join(' / ')}`);
check('S-2 到下一标题即止（不含附录内容）', !secA.some((x) => x.question.includes('不应被当成问题')), '');

const prdB = `## 待确认问题清单\n| 序号 | 待确认项 | 说明 |\n| --- | --- | --- |\n| 1 | 贷款用途字段的取值枚举？ | 影响校验 |\n| 2 | 存量数据是否需要刷数？ | 影响上线 |\n`;
const secB = issuesFromSection(prdB);
check('S-3 表格形式可提取', secB.length === 2, `提取 ${secB.length} 条：${secB.map((x) => x.question).join(' / ')}`);
check('S-4 表头/分隔行未被误收', !secB.some((x) => /序号|待确认项/.test(x.question)), '');

// ---------- 3. 端到端三级容错（parsePrdIssues） ----------
stages.length = 0;
const t1 = parsePrdIssues('PRD 正文\u2026\n<<<ISSUES>>>\n[{"level":"blocker","question":"问题一？"}]', 'PRD 正文\u2026', onStage);
check('E-1 命中协议 → 不走降级', t1.length === 1 && /已从 AI 输出解析/.test(stages.join('|')), stages.join(' | '));

stages.length = 0;
const t2 = parsePrdIssues('PRD 正文\u2026\n<ISSUES>\n[{"question":"问题二？"}]', 'PRD 正文\u2026', onStage);
check('E-2 标记变体 <ISSUES> 可识别', t2.length === 1, stages.join(' | '));

stages.length = 0;
// 用贴近真实长度的问句：解析器会过滤「≤4 字」的短噪声（如单字序号/占位），过短用例不代表真实场景
const docNoJson = 'PRD 正文\n## 待确认问题\n- 导出范围是全部待办还是当前筛选结果？';
const t3 = parsePrdIssues(docNoJson, docNoJson, onStage);
check('E-3 无 JSON → 从正文节提取（不触发补充提问）', t3.length === 1 && /已从 PRD 正文/.test(stages.join('|')), stages.join(' | '));
check('E-3b 阶段文案不再出现「解析失败」', !/解析失败/.test(stages.join('|')), '');

stages.length = 0;
const t4 = parsePrdIssues('PRD 正文，无问题也无 JSON', 'PRD 正文，无问题也无 JSON', onStage);
check('E-4 真的没有时才返回空（交由补充提问兜底）', t4.length === 0 && stages.length === 0, `stages=${stages.length}`);

// ---------- 4. 正文切分 ----------
check('B-1 切掉问题清单段', splitPrdBody('PRD 正文\n<<<ISSUES>>>\n[]') === 'PRD 正文', JSON.stringify(splitPrdBody('PRD 正文\n<<<ISSUES>>>\n[]')));
check('B-2 标记变体也切', !splitPrdBody('PRD 正文\n<ISSUES>\n[]').includes('ISSUES'), '');
check('B-3 无标记时原样返回', splitPrdBody('PRD 正文') === 'PRD 正文', '');

// ---------- 5. Word 域代码清理（用真实 docx 抽取文本） ----------
const DOC = 'D:\\code\\QJ\\BEMP5.0DEV\\docs\\原始需求\\2026.7.17《关于电票系统字段优化需求》-电票系统v20260914.docx';
try {
  const { PlanService } = require('../server/dist/services/PlanService.js');
  const md = await PlanService.docxToMarkdown(readFileSync(DOC));
  const noise = md.match(/HYPERLINK|PAGEREF|_Toc\d+|MERGEFORMAT/g) ?? [];
  check('W-1 真实 docx 抽取后无域代码噪声', noise.length === 0, `命中 ${noise.length}（修复前 60）`);
  const heads = md.split('\n').filter((l) => l.startsWith('#'));
  check('W-2 无「编号/日期」被误判为标题', !heads.some((l) => /^#+\s*(编号|日期|描述|版本|作者|审核|发布日期)\s*$/.test(l)), JSON.stringify(heads.slice(0, 6)));
  const { WorkspaceService } = require('../server/dist/services/WorkspaceService.js');
  const kws = WorkspaceService.extractKeywords(md);
  check('W-3 关键词不再是域码', !kws.some((k) => /HYPERLINK|PAGEREF|_Toc\d+/i.test(k)), JSON.stringify(kws));
} catch (e) {
  check('W 真实 docx 用例', false, String(e).slice(0, 120));
}
check('W-4 isWordFieldToken 判定', isWordFieldToken('_Toc18264') && isWordFieldToken('PAGEREF') && !isWordFieldToken('LoanPurpose'), '');
check('W-5 域码行清理后保留可读标题', stripWordFieldCodes('HYPERLINK \\l _Toc18264 1. 基本情况 PAGEREF _Toc18264 \\h 1') === '1. 基本情况', JSON.stringify(stripWordFieldCodes('HYPERLINK \\l _Toc18264 1. 基本情况 PAGEREF _Toc18264 \\h 1')));

console.log(`\n==== T00814 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail === 0 ? 0 : 1);
