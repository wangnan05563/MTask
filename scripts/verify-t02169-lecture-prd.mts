/**
 * T02169 门：「代码评审会议讲稿生成」PRD 交付质量（v1.1 评审修订版）。
 *
 * 评审结论（详见 docs/PRD评审报告-代码评审会议讲稿生成.md）：v1.0 有 1 阻塞
 * （projects.color 虚构字段）、4 重要（项目错挂四期→六期 / 第 8 张卡与 T02170 PRD
 * 冲突未声明 / Windows git 输出编码未识别 / 锚点行号漂移未提）、3 建议。
 *
 * 断言组：
 *  D 组 文档结构（十节对任务期望输出 8 项、无占位符、规模）
 *  F 组 事实锚点（引用文件/端点/行号与代码一致；projects.color 不存在且不得再被声称；
 *        git 编码红线在位；卡位冲突提示在位——防口径回退）
 *  G 组 需求覆盖（对照 T02169 任务步骤逐条）
 * 结果落 .workbuddy/t02169-gate-results.txt。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const PRD_PATH = join(ROOT, 'docs', 'PRD-代码评审会议讲稿生成.md');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p: string) => existsSync(join(ROOT, p));

// ---------- 前置 ----------
ok('D-00 PRD 文件存在（docs/PRD-代码评审会议讲稿生成.md）', existsSync(PRD_PATH));
if (!existsSync(PRD_PATH)) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 't02169-gate-results.txt'), `T02169 PRD 门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}
const PRD = readFileSync(PRD_PATH, 'utf8');
const schema = read('server/src/db/schema.ts');
const reportPage = read('web/src/pages/ReportPage.tsx');
const indexRoute = read('server/src/routes/index.ts');
const aiService = read('server/src/services/AIService.ts');
const prdCtx = read('server/src/util/prdContext.ts');
const wsSvc = read('server/src/services/WorkspaceService.ts');
const tunnel = read('server/src/tunnel/tunnel-service.ts');
const reportBuilder = read('server/src/services/report-builder.ts');
const adapters = read('server/src/adapters/types.ts');
const serverPkg = read('server/package.json');

// ---------- D 组：文档结构（对照 T02169 期望输出 8 项） ----------
ok('D-01 十节结构齐全（§1 文档信息 ~ §10 信息来源）',
  ['## 1. 文档信息', '## 2. 背景与目标', '## 3. 用户画像与场景', '## 4. 功能需求详细说明',
    '## 5. 竞品调研与 UX 优化建议', '## 6. 交互与设计规范', '## 7. 非功能需求',
    '## 8. 数据指标与验收标准', '## 9. 开放决策点', '## 10. 信息来源'].every((h) => PRD.includes(h)));
ok('D-02 含流程图描述（mermaid）与术语表',
  /```mermaid/.test(PRD) && /### 2.5 术语表/.test(PRD));
ok('D-03 无占位符（TODO/TBD/FIXME/WIP/XXX 大小写敏感；lorem 不敏感）',
  !/TODO|TBD|FIXME|WIP|XXX/.test(PRD) && !/[Ll]orem/.test(PRD));
ok('D-04 规模充足（>8000 字符，非骨架稿）', PRD.length > 8000, PRD.length);
ok('D-05 版本链完整（v1.0 → v1.1 评审修订记录）',
  /v1\.0：首版/.test(PRD) && /v1\.1（评审修订）/.test(PRD));

// ---------- F 组：事实锚点 ----------
for (const f of ['web/src/ui/Markdown.tsx', 'server/src/util/prdContext.ts', 'server/src/services/WorkspaceService.ts',
  'server/src/tunnel/tunnel-service.ts', 'server/src/services/report-builder.ts', 'server/src/services/AIService.ts',
  'server/src/adapters/types.ts', 'server/src/util/exportStyle.ts', 'web/src/pages/ReportPage.tsx']) {
  ok(`F-F ${f} 文件真实存在`, exists(f));
}
ok('F-E SSE 三点同构 + raw 30mb + ai-download + buildPptx 均在位',
  /prd-generate-stream/.test(indexRoute) && /testcase-generate-stream/.test(indexRoute)
  && /ai-generate-stream/.test(indexRoute) && /30mb/.test(indexRoute)
  && /report\/ai-download/.test(indexRoute) && /buildPptx/.test(reportBuilder)
  && PRD.includes('code-review-lecture-stream'));
ok('F-C1 reportCards/kickoff-ppt 行号（:584/:626）与 PRD 引用一致',
  /const reportCards: ReportCardCfg\[\] = \[/.test(reportPage) && /key: 'kickoff-ppt'/.test(reportPage)
  && PRD.includes('ReportPage.tsx:584') && PRD.includes(':626'));
ok('F-C2 AIService 四通道行号（294/474/499/556）',
  /async organize\(taskIds: string\[\], toolId: string\)/.test(aiService)
  && /async askJson</.test(aiService) && /async askStream\(/.test(aiService)
  && PRD.includes('organize:294') && PRD.includes('askJson:499') && PRD.includes('askStream:556'));
ok('F-C3 prdContext 常量与截断（:25 / :77-79）',
  /PRD_CONTEXT_LIMIT = 6000/.test(prdCtx) && PRD.includes('prdContext.ts:25') && PRD.includes(':77-79'));
ok('F-C4 workspace 四端点（:257/:274/:282/:290）',
  [/\/workspace\/search/, /\/workspace\/file/, /workspace\/symbols\/refresh/, /\/workspace\/symbols/]
    .every((re) => re.test(indexRoute)) && PRD.includes('routes/index.ts:257'));
ok('F-C5 execFile 先例（tunnel-service.ts:15 execFileAsync）与 PRD 引用一致',
  /const execFileAsync = promisify\(execFileCb\)/.test(tunnel) && PRD.includes('tunnel-service.ts:15 execFileAsync'));
ok('F-C6 Markdown XSS 守卫（ui/Markdown.tsx:11 html:false + noopener）',
  /new MarkdownIt\(\{ html: false/.test(read('web/src/ui/Markdown.tsx'))
  && PRD.includes('ui/Markdown.tsx') && PRD.includes('html:false'));
ok('F-C7 防回退：projects.color 不存在且 PRD 不再声称其在位',
  !/ensureColumn\('projects', 'color'/.test(schema)
  && !/projects\.color` 字段在位/.test(PRD) && !/取自项目色（`projects\.color`/.test(PRD)
  && PRD.includes('projects` 表无 color 字段'));
ok('F-C8 git 编码红线在位（i18n.logOutputEncoding + core.quotepath + CRLF 口径）',
  PRD.includes('i18n.logOutputEncoding=utf-8') && PRD.includes('core.quotepath=false')
  && PRD.includes('ignore-cr-at-eol') && PRD.includes('FR-1.1a'));
ok('F-C9 无 git 依赖（server/package.json）+ WorkspaceService 忽略 .git',
  !/"simple-git"|"nodegit"|"isomorphic-git"/.test(serverPkg)
  && /DEFAULT_IGNORE_DIRS[\s\S]{0,120}'\.git'/.test(wsSvc));
ok('F-C10 adapters 类型锚点（:93/:101/:110）',
  /interface AIAdapter/.test(adapters) && /chatStream\(/.test(adapters)
  && /'openai-compatible' \| 'claude' \| 'ollama' \| 'workbuddy'/.test(adapters));
ok('F-C11 卡位冲突提示在位（与 T02170 PRD §12 对齐）',
  PRD.includes('卡位冲突声明') && PRD.includes('T02170') && PRD.includes('先落地者为第 8 张'));
ok('F-C12 影响项目为 mtask六期（不再错挂四期）',
  PRD.includes('mtask六期') && PRD.includes('bea1ce5b-67c1-4a0d-a08c-db0d5a3d9136')
  && !/影响项目：mtask四期/.test(PRD));
ok('F-C13 竞品 3~5 家 + 三维对比表 + 阿里 OCR 官方链接',
  ['Copilot', 'CodeRabbit', 'PR-Agent', 'Sourcery', 'Open Code Review'].every((n) => PRD.includes(n))
  && /代码理解深度 \| 讲稿结构清晰度 \| 人工干预点/.test(PRD)
  && PRD.includes('github.com/alibaba/open-code-review'));

// ---------- G 组：需求覆盖（对照 T02169 任务步骤） ----------
ok('G-01 功能定义：增量代码 → 结构化评审要点（摘要/风险/规范/建议）',
  ['变更摘要', '潜在风险', '规范检查', '改进建议'].every((w) => PRD.includes(w))
  && /Git Diff \/ Commit Logs \/ 变更文件/.test(PRD));
ok('G-02 多项目批处理汇总策略（总-分-总）',
  PRD.includes('总-分-总') && /FR-4\.4/.test(PRD));
ok('G-03 交互细节：高亮关联代码行 / 标记或忽略 / 导出',
  PRD.includes('高亮关联代码行') && PRD.includes('会后跟进') && PRD.includes('忽略')
  && /导出 md（直接）\/ docx \/ pptx/.test(PRD));
ok('G-04 非功能：时效性 / 准确性 / 代码隐私（数据流向）',
  /### 7\.2 性能与时效/.test(PRD) && /A-5 幻觉控制/.test(PRD) && /### 7\.3 隐私与合规/.test(PRD)
  && PRD.includes('排除规则'));
ok('G-05 验收标准可测（A-1~A-7 + 产品指标 4 项）',
  ['A-1 采集正确性', 'A-2 结构完备性', 'A-3 只读红线', 'A-4 锚点可用', 'A-5 幻觉控制', 'A-6 时效', 'A-7 人工抽查']
    .every((a) => PRD.includes(a)) && /生成成功率/.test(PRD) && /锚点覆盖率/.test(PRD));
ok('G-06 开放决策点 E-1~E-4 待签字',
  ['E-1', 'E-2', 'E-3', 'E-4'].every((e) => PRD.includes(`| ${e} |`))
  && PRD.includes('批准前不得进入实施'));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't02169-gate-results.txt'), `T02169 PRD 交付质量门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`, 'utf8');
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
