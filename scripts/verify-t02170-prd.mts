/**
 * T02170 门：AI 工作台「阶段性项目总结汇报 PPT 生成」PRD 交付质量。
 *
 * 任务要求（T02170）：撰写可交付/可审批的 PRD——功能逻辑严格基于现有项目管理模块能力、
 * 不虚构 API/数据结构；竞品基于真实 GitHub 项目；含目标/功能详情/UI-UX/验收标准；
 * 简体中文 Markdown，开发可直接依据开发测试。
 *
 * 断言组：
 *  D 组 文档结构（存在、必含章节、附录、无占位符、简体中文规模）
 *  F 组 事实锚点（引用的表/文件/端点在代码库真实存在；关键口径与代码一致——防虚构 API）
 *  G 组 需求覆盖（对照 T02170 任务步骤逐条：交互流程/生成逻辑/批量机制/非功能/验收审批）
 * 结果落 .workbuddy/t02170-gate-results.txt。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const PRD_PATH = join(ROOT, 'docs', 'PRD-阶段性项目总结汇报PPT.md');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p: string) => existsSync(join(ROOT, p));

// ---------- 前置：PRD 必须存在 ----------
ok('D-00 PRD 文件存在（docs/PRD-阶段性项目总结汇报PPT.md）', existsSync(PRD_PATH));
if (!existsSync(PRD_PATH)) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 't02170-gate-results.txt'), `T02170 PRD 门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
const PRD = readFileSync(PRD_PATH, 'utf8');
const schema = read('server/src/db/schema.ts');
const reportSvc = read('server/src/services/ReportService.ts');
const planSvc = read('server/src/services/PlanService.ts');
const exportName = read('server/src/util/export-name.ts');
const reportPage = read('web/src/pages/ReportPage.tsx');
const plansRoute = read('server/src/routes/plans.ts');
const indexRoute = read('server/src/routes/index.ts');

// ---------- D 组：文档结构 ----------
ok('D-01 必含章节：背景与目标 / 功能需求详解 / 非功能需求 / 验收标准',
  /## 1\. 项目概述与目标/.test(PRD) && /## 3\. 功能需求详解/.test(PRD)
  && /## 7\. 非功能需求/.test(PRD) && /## 8\. 验收标准/.test(PRD));
ok('D-02 必含章节：界面与交互设计（角色场景 + UX 优化建议）/ 技术实现建议 / 竞品调研',
  /## 2\. 用户角色与场景/.test(PRD) && /## 5\. 竞品调研与优化建议/.test(PRD)
  && /### 5\.3 优化建议/.test(PRD) && /### 5\.4 技术选型结论/.test(PRD) && /## 6\. 数据依赖与技术实现说明/.test(PRD));
ok('D-03 附录 A（PPT 章节示例）+ 附录 B（调研来源链接）',
  /## 附录 A/.test(PRD) && /## 附录 B/.test(PRD) && /github\.com/.test(PRD));
ok('D-04 无占位符（TODO/TBD/FIXME/WIP/XXX 大小写敏感——不误伤 todo 等状态枚举值；lorem 大小写不敏感）',
  !/TODO|TBD|FIXME|WIP|XXX/.test(PRD) && !/[Ll]orem/.test(PRD));
ok('D-05 简体中文正文规模充足（>15000 字符，非骨架稿）', PRD.length > 15000, PRD.length);

// ---------- F 组：事实锚点（防虚构 API/表/文件） ----------
const TABLES = ['projects', 'tasks', 'plan_tasks', 'prd_requirements', 'prd_docs', 'prd_issues',
  'test_cases', 'estimate_items', 'estimate_snapshots', 'console_jobs', 'task_events'];
for (const t of TABLES) {
  ok(`F-T ${t} 表在 schema.ts 真实存在且被 PRD 引用`,
    new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`).test(schema) && PRD.includes(t));
}
const FILES = ['server/src/services/kickoffService.ts', 'server/src/services/kickoffBuilder.ts',
  'server/src/services/kickoff-layout.ts', 'server/src/services/ReportService.ts',
  'server/src/services/PlanService.ts', 'server/src/services/TaskService.ts',
  'server/src/services/milestoneProgress.ts', 'server/src/services/AIService.ts',
  'server/src/services/report-worker.ts', 'server/src/util/prdContext.ts',
  'server/src/util/export-name.ts', 'server/src/util/exportStyle.ts', 'server/src/util/export-gate.ts',
  'server/src/routes/plans.ts', 'server/src/routes/index.ts', 'server/src/db/schema.ts',
  'web/src/pages/ReportPage.tsx', 'web/src/pages/ReportConsole.tsx',
  'web/src/pages/KickoffPptPanel.tsx', 'web/src/ui/dialogs.tsx', 'web/src/api/sse.ts'];
for (const f of FILES) {
  ok(`F-F ${f} 文件真实存在`, exists(f));
}
ok('F-E 端点锚点：kickoff 三端点 + ai-download + events/recent 均在位',
  /kickoff-preflight/.test(plansRoute) && /kickoff-ppt-outline/.test(plansRoute)
  && /kickoff-ppt-stream/.test(plansRoute) && /report\/ai-download/.test(indexRoute)
  && /events\/recent/.test(indexRoute)
  && PRD.includes('summary-preflight') && PRD.includes('summary-ppt-stream'));
ok('F-C1 REPORT_PROJECT_MAX=8 与 PRD 声称一致',
  /REPORT_PROJECT_MAX = 8/.test(reportSvc) && PRD.includes('REPORT_PROJECT_MAX=8'));
ok('F-C2 PLAN_STATUSES 四值（todo/doing/done/blocked）与 PRD 一致',
  /PLAN_STATUSES = new Set<PlanStatus>\(\['todo', 'doing', 'done', 'blocked'\]\)/.test(planSvc)
  && PRD.includes("['todo','doing','done','blocked']"));
ok('F-C3 下载白名单不含 zip（PRD 的 A-2 约束前提为真：定义行含 pptx 且无 zip）',
  (() => {
    const dlLine = exportName.split('\n').find((l) => /^export const DOWNLOAD_NAME_RE/.test(l)) ?? '';
    return dlLine.includes('pptx') && !dlLine.includes('zip');
  })());
ok('F-C4 ReportPeriod 三值 + periodRange 存在（周期复用前提为真）',
  /export type ReportPeriod = 'day' \| 'week' \| 'month'/.test(reportSvc)
  && /function periodRange\(period: ReportPeriod\)/.test(reportSvc) && PRD.includes('periodRange'));
ok('F-C5 卡片现状：kickoff-ppt 已在位（第 7 张），summary-ppt 尚未实现（PRD 为前瞻需求文档）',
  /key: 'kickoff-ppt'/.test(reportPage) && !/key: 'summary-ppt'/.test(reportPage));
ok('F-C6 PRD 记录竞品检索日期与联网核验方式（2026-10-16 WebSearch）',
  PRD.includes('2026-10-16') && /WebSearch/.test(PRD));

// ---------- F-C7~F-C12：评审（v1.0→v1.1）取证结论固化，防口径回退 ----------
const retention = read('server/src/services/EventRetention.ts');
const msProg = read('server/src/services/milestoneProgress.ts');
const kickoffSvc = read('server/src/services/kickoffService.ts');
const reportBuilder = read('server/src/services/report-builder.ts');
ok('F-C7 B1 前提：task_events 默认保留 90 天且可配；PRD 生效口径已收敛为 90 天并加 S9 事件覆盖率',
  // 注：「92 天」在 v1.1 修订清单里是旧值记述（合法），故只校验生效口径句
  /DEFAULT_RETENTION_DAYS = 90/.test(retention) && /readEventRetentionDays/.test(retention)
  && /S9/.test(PRD) && /事件覆盖率/.test(PRD) && /自定义区间上限 \*\*90 天\*\*/.test(PRD));
ok('F-C8 I3 前提：里程碑无子项时不聚合（保留人工 progress）；PRD 已分两态渲染',
  /if \(total === 0\) return/.test(msProg) && /milestoneHasChildren/.test(msProg) && PRD.includes('milestoneHasChildren'));
ok('F-C9 I4 前提：kickoffService 四函数为单项目 projectId 签名；PRD 已限定复用口径为版式层+端点范式',
  /export function preflight\(projectId: string\)/.test(kickoffSvc)
  && /export function collectBundle\(projectId: string\)/.test(kickoffSvc)
  && /kickoffOutline\(projectId: string/.test(kickoffSvc)
  && /版式层 \+ 端点范式/.test(PRD));
ok('F-C10 I5 前提：仓内第二条 pptx 路径 buildPptx 在位（已支持多项目）；PRD 已作对照说明',
  /export async function buildPptx\(data: ReportData/.test(reportBuilder)
  && /scopeLine\(data, true\)/.test(reportBuilder) && PRD.includes('buildPptx'));
ok('F-C11 I1 前提：页面级 ProjectScopePicker + report.projects 会话键在位；PRD 改为消费而非新建',
  /ProjectScopePicker/.test(reportPage) && /useSessionState<string\[\]>\('report.projects'/.test(reportPage)
  && PRD.includes('report.projects'));
ok('F-C12 防回退：生效口径句必须是 90 天上限（原 92）与按项目数自适应预算（原每项目 1500 字）',
  /自定义区间上限 \*\*90 天\*\*（原 92）/.test(PRD)
  && /按项目数自适应/.test(PRD) && /每项目 = 6000\/N/.test(PRD));

// ---------- G 组：需求覆盖（对照 T02170 任务步骤） ----------
ok('G-01 交互流程：选中项目 / 设置汇报周期 / 选择模板风格',
  /选中项目|项目范围/.test(PRD) && /汇报周期/.test(PRD) && /模板风格|版式/.test(PRD));
ok('G-02 生成逻辑：关键节点/风险/成果映射到标准结构（封面/目录/进展/问题/计划/结语）',
  ['封面', '目录', '进展', '问题', '计划'].every((w) => PRD.includes(w))
  && (/结语/.test(PRD) || /总结与展望/.test(PRD)));
ok('G-03 批量机制：合并版 / 分别独立 两种模式定义清晰',
  /合并版/.test(PRD) && /分别独立/.test(PRD) && /zip/i.test(PRD));
ok('G-04 非功能：性能指标 / 数据安全与隐私 / 质量控制标准',
  /## 7\. 非功能需求/.test(PRD) && /性能/.test(PRD) && /隐私/.test(PRD) && /质量控制标准/.test(PRD));
ok('G-05 审批与交付标准：审批检查点 + 验收清单 + 文档完整性检查点',
  /审批检查点/.test(PRD) && /验收标准/.test(PRD) && /文档完整性检查点/.test(PRD));
ok('G-06 竞品样本 3~5 个代表项目且逐个有「对本 PRD 的落点」',
  (PRD.match(/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? []).length >= 5
  && /对本 PRD 的落点/.test(PRD) && /PptxGenJS/.test(PRD) && /Presenton/.test(PRD) && /PPTAgent/.test(PRD));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't02170-gate-results.txt'), `T02170 PRD 交付质量门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
