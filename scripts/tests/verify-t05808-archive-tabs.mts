/**
 * T05808 门：归档类型 Sheet 页签「去归档前缀 + 数量 + 移除页签区标题」。
 *
 * 静态源码门：归档页是纯前端展示改动，不涉及后端数据结构；用源码断言保证
 * 7 个页签的标签/数量映射/无 h4 标题，视觉观感由构建 + GUI 复核兜底。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05808-archive-tabs.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.MTASK_GATE_ROOT
  ? resolve(process.env.MTASK_GATE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const ARCHIVE = readFileSync(join(ROOT, 'web/src/pages/ArchivePage.tsx'), 'utf8');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

ok('A-01 7 个归档类型页签仍齐备（tasks/plans/prompts/reqs/prd/matrix/cases）',
  ['tasks', 'plans', 'prompts', 'reqs', 'prd', 'matrix', 'cases']
    .every((key) => new RegExp(`key: '${key}'`).test(ARCHIVE)));

ok('A-02 页签标签已去除“归档”前缀（任务/计划/提示词/通用需求/PRD 文档/需求跟踪矩阵/测试用例）',
  /label: '任务'/.test(ARCHIVE)
  && /label: '计划'/.test(ARCHIVE)
  && /label: '提示词'/.test(ARCHIVE)
  && /label: '通用需求'/.test(ARCHIVE)
  && /label: 'PRD 文档'/.test(ARCHIVE)
  && /label: '需求跟踪矩阵'/.test(ARCHIVE)
  && /label: '测试用例'/.test(ARCHIVE)
  && !/label: '归档/.test(ARCHIVE));

ok('A-03 数量实时映射：3 个服务端分页 total + 4 个过滤后数组长度',
  /count: taskTotal/.test(ARCHIVE)
  && /count: planTotal/.test(ARCHIVE)
  && /count: promptTotal/.test(ARCHIVE)
  && /count: archivedReqs\.length/.test(ARCHIVE)
  && /count: archivedPrdDocs\.length/.test(ARCHIVE)
  && /count: archivedMatrixReqs\.length/.test(ARCHIVE)
  && /count: archivedCases\.length/.test(ARCHIVE));

ok('A-04 页签渲染格式为「标签名 (数量)」',
  /\{t\.label\} \(\{t\.count\}\)/.test(ARCHIVE)
  && /title=\{`\$\{t\.label\} \(\$\{t\.count\}\) — 点击切换归档类型`\}/.test(ARCHIVE));

ok('A-05 页签区域不再渲染 h4 标题/装饰性标题',
  !/<h4/.test(ARCHIVE));

ok('A-06 tablist 可访问性保留（role=tablist + role=tab + aria-selected）',
  /role="tablist"/.test(ARCHIVE)
  && /role="tab"/.test(ARCHIVE)
  && /aria-selected=\{archiveTab === t\.key\}/.test(ARCHIVE));

ok('A-07 不再保留“归档任务（共 N 条）”等重复标题文案',
  !/归档任务（共/.test(ARCHIVE)
  && !/归档项目计划（共/.test(ARCHIVE)
  && !/归档提示词（共/.test(ARCHIVE)
  && !/归档通用需求（共/.test(ARCHIVE)
  && !/归档 PRD 文档（共/.test(ARCHIVE)
  && !/归档需求跟踪矩阵（共/.test(ARCHIVE)
  && !/归档测试用例（共/.test(ARCHIVE));

mkdirSync(OUT_DIR, { recursive: true });
const summary = `T05808 门：${pass} 通过 / ${fail} 失败`;
lines.push('');
lines.push(summary);
writeFileSync(join(OUT_DIR, 't05808-gate-results.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
process.exit(fail === 0 ? 0 : 1);
