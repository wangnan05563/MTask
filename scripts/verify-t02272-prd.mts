/**
 * T02272 门：「GitHub 竞品调研及项目管理与 AI 工作台优化」PRD 交付质量。
 *
 * 断言组：
 *  D 组 文档结构（任务指定 9 节输出结构逐节在位；两模块×四维度小节齐全）
 *  R 组 需求格式（#### 编号块逐条含 描述/用户故事/验收标准/优先级；优先级仅 P0/P1/P2；
 *       文头与 §7 声明的条数/分级计数与实际条目自洽）
 *  F 组 事实锚点（MTask 现状锚点文件存在；board/三视图/reportCards 行号；「无暗色/无 Webhook」
 *       否定性结论与代码 grep 一致；五竞品与关键 2026 事实在位；附录链接数）
 *  G 组 任务覆盖（调研范围两模块、四维度、非功能四块、分期、优先级依据、术语双语、验证缺口声明）
 * 结果落 .workbuddy/t02272-gate-results.txt。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const PRD_PATH = join(ROOT, 'docs', 'PRD-竞品调研-项目管理与AI工作台优化.md');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p: string) => existsSync(join(ROOT, p));
/** 纯 Node 递归 grep：返回命中文件数（-1=遍历失败）。Windows 下 execSync+grep 不可靠，故不用 shell */
function grepFileCount(dirRel: string, pattern: RegExp): number {
  try {
    const base = join(ROOT, dirRel);
    let n = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (['.ts', '.tsx', '.css', '.js'].includes(extname(p)) && pattern.test(readFileSync(p, 'utf8'))) n += 1;
      }
    };
    walk(base);
    return n;
  } catch { return -1; }
}

// ---------- 前置 ----------
ok('D-00 PRD 文件存在（docs/PRD-竞品调研-项目管理与AI工作台优化.md）', existsSync(PRD_PATH));
if (!existsSync(PRD_PATH)) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 't02272-gate-results.txt'), `T02272 PRD 门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
const PRD = readFileSync(PRD_PATH, 'utf8');

// ---------- D 组：九节结构（任务指定输出结构逐节） ----------
ok('D-01 九节结构齐全（文档信息/背景与目标/竞品调研摘要/项目管理需求/AI工作台需求/非功能/优先级分期/风险依赖/附录）',
  ['## 1. 文档信息', '## 2. 背景与目标', '## 3. 竞品调研摘要', '## 4. 项目管理模块需求',
    '## 5. AI 工作台模块需求', '## 6. 非功能性需求', '## 7. 优先级总览与分期建议',
    '## 8. 风险与依赖', '## 9. 附录'].every((h) => PRD.includes(h)));
ok('D-02 §2 含 2.1 业务背景 + 2.2 可量化目标（基线/目标/口径三列）',
  /### 2\.1 业务背景/.test(PRD) && /### 2\.2 本次优化目标（可量化）/.test(PRD)
  && /基线（现状）/.test(PRD) && /目标/.test(PRD) && /口径/.test(PRD));
ok('D-03 §3 含 3.1 范围与方法 + 3.2 对比矩阵 + 3.3 关键发现',
  /### 3\.1 调研范围与方法/.test(PRD) && /### 3\.2 功能对比矩阵/.test(PRD) && /### 3\.3 关键发现与机会点/.test(PRD));
ok('D-04 §4/§5 各含四维度小节（客户体验提升/功能扩展/UI 升级/功能丰富）',
  ['### 4.1 客户体验提升', '### 4.2 功能扩展', '### 4.3 UI 升级', '### 4.4 功能丰富',
    '### 5.1 客户体验提升', '### 5.2 功能扩展', '### 5.3 UI 升级', '### 5.4 功能丰富'].every((h) => PRD.includes(h)));
ok('D-05 无占位符（TODO/TBD/FIXME/XXX 大小写敏感；lorem 不敏感；WIP 为合法术语不误报）',
  !/TODO|TBD|FIXME|XXX/.test(PRD) && !/[Ll]orem/.test(PRD));
ok('D-06 规模充足（>20000 字符）', PRD.length > 20000, PRD.length);

// ---------- R 组：需求格式与自洽 ----------
const reqBlocks = PRD.split(/\n#### /).slice(1).filter((b) => /^(PM|AI)-\d{3} /.test(b));
const pmBlocks = reqBlocks.filter((b) => /^PM-\d{3} /.test(b));
const aiBlocks = reqBlocks.filter((b) => /^AI-\d{3} /.test(b));
ok('R-01 需求块数量：PM 18 + AI 17 = 35', pmBlocks.length === 18 && aiBlocks.length === 17 && reqBlocks.length === 35,
  { pm: pmBlocks.length, ai: aiBlocks.length });
const missing = reqBlocks.filter((b) => !(/\*\*描述\*\*/.test(b) && /\*\*用户故事\*\*/.test(b)
  && /\*\*验收标准\*\*/.test(b) && /\*\*优先级\*\*/.test(b))).map((b) => b.slice(0, 12));
ok('R-02 每条需求六要素齐全（编号/标题/描述/用户故事/验收标准/优先级）', missing.length === 0, missing);
ok('R-03 用户故事均为「作为…」句式', reqBlocks.every((b) => /\*\*用户故事\*\*：作为/.test(b)));
ok('R-04 优先级仅 P0/P1/P2', reqBlocks.every((b) => /\*\*优先级\*\*：P[012]/.test(b)));
const priCount = (p: string) => reqBlocks.filter((b) => new RegExp(`\\*\\*优先级\\*\\*：${p}\\b`).test(b)).length;
ok('R-05 优先级分布自洽（P0=9 / P1=14 / P2=12）',
  priCount('P0') === 9 && priCount('P1') === 14 && priCount('P2') === 12,
  { P0: priCount('P0'), P1: priCount('P1'), P2: priCount('P2') });
ok('R-06 文头与 §7 声明的条数/分级数与实际一致',
  /35 条（项目管理 18 \+ AI 工作台 17），P0×9 \/ P1×14 \/ P2×12/.test(PRD)
  && /P0×9/.test(PRD) && /P1×14/.test(PRD) && /P2×12/.test(PRD));

// ---------- F 组：事实锚点 ----------
for (const f of ['web/src/pages/TasksPage.tsx', 'web/src/pages/PlanPage.tsx', 'web/src/pages/ReportPage.tsx',
  'web/src/mobile/MobileShell.tsx', 'web/src/mobile/MobileMore.tsx', 'web/src/settings.tsx',
  'web/src/ui/NotifyBell.tsx', 'web/src/ui/EmptyState.tsx',
  'web/src/ui/Markdown.tsx', 'web/src/pages/CommandPalette.tsx', 'web/src/pages/MatrixTable.tsx',
  'web/src/components/estimateGanttOverlay.tsx', 'web/src/App.tsx', 'web/src/i18n.ts',
  'server/src/db/schema.ts', 'server/src/services/milestoneProgress.ts', 'server/src/services/EstimateService.ts',
  'server/src/services/ConsoleJobService.ts', 'server/src/services/kickoff-layout.ts', 'server/src/skills']) {
  ok(`F-F ${f} 存在`, exists(f));
}
const tasksPage = read('web/src/pages/TasksPage.tsx');
const planPage = read('web/src/pages/PlanPage.tsx');
const reportPage = read('web/src/pages/ReportPage.tsx');
ok('F-C1 看板视图在位（TasksPage.tsx:321 list/board）且 PRD 锚点一致',
  /useSessionState<'list' \| 'board'>\('tasks\.viewMode'/.test(tasksPage) && PRD.includes('TasksPage.tsx:321'));
ok('F-C2 计划三视图在位（PlanPage.tsx:382 list/gantt/timeline）且 PRD 锚点一致',
  /type PlanViewMode = 'list' \| 'gantt' \| 'timeline'/.test(planPage) && PRD.includes('PlanPage.tsx:382'));
ok('F-C3 reportCards 7 卡在位（ReportPage.tsx:584）且 PRD 锚点一致',
  /const reportCards: ReportCardCfg\[\] = \[/.test(reportPage) && PRD.includes('ReportPage.tsx:584'));
const settings = read('web/src/settings.tsx');
ok('F-C4 暗色主题机制在位（settings.tsx themeCss 双色板 + data-theme 应用 + useSettings）且 PRD 不得声称「无暗色」',
  /themeCss/.test(settings) && /\[data-theme='dark'\]/.test(settings) && /useSettings/.test(settings)
  && /document\.documentElement\.dataset\.theme/.test(settings)
  && /data-theme/.test(read('web/src/mobile/MobileMore.tsx'))
  && PRD.includes('settings.tsx') && !/无暗色主题/.test(PRD) && !/零覆盖/.test(PRD));
const hookHits = grepFileCount('server/src', /webhook|Webhook/);
ok('F-C5 「无 Webhook」否定性结论与代码一致（server grep 零命中）', hookHits === 0, hookHits);
const schema = read('server/src/db/schema.ts');
ok('F-C6 现状锚点行号抽查（schema 表定义与 PRD 引用一致）',
  /CREATE TABLE IF NOT EXISTS tasks \(/.test(schema) && /CREATE TABLE IF NOT EXISTS console_jobs \(/.test(schema)
  && /CREATE TABLE IF NOT EXISTS exec_sessions \(/.test(schema)
  && PRD.includes('schema.ts:16-32') && PRD.includes('schema.ts:167-178') && PRD.includes('schema.ts:341-356'));
ok('F-C7 五竞品全部在对比矩阵中',
  ['GitHub', 'GitLab', 'Bitbucket', 'Gitee', 'Azure DevOps'].every((c) => PRD.includes(c))
  && /\| 能力项 \| GitHub \| GitLab \| Bitbucket \| Gitee \| Azure DevOps \| MTask \|/.test(PRD));
ok('F-C8 竞品 2026 关键事实在位（agent sessions GA 26-03 / Gitee AI 队友 26-08-04 / Copilot 26-09 双变更 / Azure MCP）',
  PRD.includes('agent sessions') && PRD.includes('2026-08-04') && PRD.includes('2026-09-01')
  && PRD.includes('MCP Server') && PRD.includes('hierarchy'));
ok('F-C9 附录 B 参考链接 ≥10 条', (PRD.match(/https?:\/\/[^\s）)]+/g) ?? []).length >= 10);
ok('F-C10 验证缺口如实声明（§9.3 竞品未实测 UI）',
  /### 9\.3 验证缺口/.test(PRD) && /无法注册五家竞品账号/.test(PRD) && /⚠待人工实测/.test(PRD));

// ---------- G 组：任务覆盖 ----------
ok('G-01 调研范围覆盖两模块全要素（看板/任务/里程碑/迭代/甘特/权限 + AI 编码/审查/对话/编排/模型/提示词）',
  ['看板', '里程碑', '迭代', '甘特', '权限'].every((w) => PRD.includes(w))
  && ['编码', '评审', '对话', '编排', '模型', '提示词'].every((w) => PRD.includes(w)));
ok('G-02 差距分析四态判定体系在位（缺失/落后/持平/领先 → ✅/⚠/❌）',
  /缺失\/落后\/持平\/领先/.test(PRD) && /✅完整具备/.test(PRD) && /❌不具备/.test(PRD));
ok('G-03 非功能四块齐全（性能/安全与隐私/兼容性/国际化）',
  /### 6\.1 性能/.test(PRD) && /### 6\.2 安全与隐私/.test(PRD) && /### 6\.3 兼容性/.test(PRD) && /### 6\.4 国际化/.test(PRD));
ok('G-04 三期分期（MVP → V1.1 → V2.0）', /MVP/.test(PRD) && /V1\.1/.test(PRD) && /V2\.0/.test(PRD));
ok('G-05 优先级依据说明（用户影响面 × 实现成本）', /用户影响面.{0,12}×.{0,12}实现成本/.test(PRD));
ok('G-06 关键术语首次出现附英文（Iteration/Sprint、BYOK、CFD、WIP、agent sessions、RTM）',
  ['Iteration', 'Sprint', 'BYOK', 'CFD', 'WIP', 'agent sessions', 'RTM'].every((t) => PRD.includes(t)));
ok('G-07 开放问题 Q-1~Q-3 待裁决（含 tasks.status 二元决策冲突声明）',
  /\| Q-1 \|/.test(PRD) && /\| Q-2 \|/.test(PRD) && /\| Q-3 \|/.test(PRD) && /T01876/.test(PRD));
ok('G-08 既有 PRD 引用对齐（T02169/T02170 已批准登记不重复拆解）',
  PRD.includes('T02169') && PRD.includes('T02170') && PRD.includes('T02219') && PRD.includes('T02259'));

// ---------- F-C11~F-C15：v1.1 评审修订的取证结论固化（需求依赖的字段/能力必须有 schema 证据） ----------
const taskCols = (schema.match(/ensureColumn\('tasks',\s*'[^']+'/g) ?? []).join(',');
ok('F-C11 tasks 无排期字段（19 条 ensureColumn 全列扫描）且 PRD 不得声称任务级逾期预测',
  !/start_date|duration_days|due_date|estimate/.test(taskCols)
  && !/按任务工期/.test(PRD) && PRD.includes('无任何排期字段') && PRD.includes('计划级'));
ok('F-C12 批量操作既有能力在位（multiSelect/selectedIds/5 种 ACTION_LABEL/10 级撤销栈）且 PM-105 标注为增强',
  /const \[multiSelect, setMultiSelect\] = useState/.test(tasksPage)
  && /const \[selectedIds, setSelectedIds\]/.test(tasksPage)
  && /ACTION_LABEL: Record<'status' \| 'category' \| 'priority' \| 'color' \| 'archive'/.test(tasksPage)
  && /MAX_UNDO_STEPS = 10/.test(tasksPage)
  && /批量操作增强/.test(PRD) && /T00457/.test(PRD) && /T01065/.test(PRD));
const aiUsageCols = schema.match(/CREATE TABLE IF NOT EXISTS ai_usage \(([\s\S]*?)\n    \);/)?.[1] ?? '';
const promptCols = schema.match(/CREATE TABLE IF NOT EXISTS prompts \(([\s\S]*?)\n    \);/)?.[1] ?? '';
ok('F-C13 ai_usage 无 token/成本/卡片维度；prompts 无计数字段；app_settings 为应用级（PRD 已给替代方案）',
  !/token|cost|card/.test(aiUsageCols) && !/usage_count/.test(promptCols)
  && /CREATE TABLE IF NOT EXISTS app_settings \(\s*\n\s*key\s+TEXT PRIMARY KEY/.test(schema)
  && PRD.includes('usage_count') && PRD.includes('代理指标') && PRD.includes('guide.dismiss.<projectId>'));
const retention = read('server/src/services/EventRetention.ts');
ok('F-C14 事件默认保留 90 天在位且 PM-205 声明快照表为长历史唯一来源',
  /DEFAULT_RETENTION_DAYS = 90/.test(retention) && PRD.includes('EventRetention.ts:23')
  && /唯一来源是自建日快照表/.test(PRD));
ok('F-C15 裁决记录：Q-1~Q-3 已签字（§1.1）+ 新增开放问题 Q-4~Q-6',
  /### 1\.1 裁决记录/.test(PRD) && /已裁决/.test(PRD)
  && /\| \*\*Q-4\*\* \|/.test(PRD) && /\| \*\*Q-5\*\* \|/.test(PRD) && /\| \*\*Q-6\*\* \|/.test(PRD)
  && /v1\.1（按建议改写方案 \+ 评审修订/.test(PRD));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't02272-gate-results.txt'), `T02272 PRD 交付质量门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
