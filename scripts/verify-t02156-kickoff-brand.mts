/**
 * T02156 门：启动会 PPT 恒生模板视觉落地（PRD §7 非目标 N1 的 E-1 补单）。
 *
 * 背景：用户硬要求「项目启动会 PPT 生成」严格遵循 `2023恒生PPT模板.pptx` 品牌视觉规范
 * （原 N1 以「装机版无 Python 运行时读模板母版」为由搁置）。本单用 pptxgenjs 原生
 * 背景图 + 品牌色常量落地，不引 Python、不走母版套用、不加新依赖。
 *
 * 断言组：
 *   S 组 源码/资产守卫：品牌四色在 exportStyle 单源、装配层无裸 hex、五张背景资产在位且体积受控、
 *                      图表字体/颜色显式声明、背景缺失有降级分支、五背景映射与 section/thanks 版式三处同源。
 *   U 组 真产物（17 页 mtask五期样本，恒生五页面结构：封面/目录/章节×3/正文×11/结束）：
 *     五张背景按页面角色各就其位（同图只落一份媒体）· 内容零位图（无 <p:pic>，slide 零 embed）·
 *     全稿微软雅黑（图表不再 Arial 串行）· 无纯黑 000000 文字 · 表头品牌深底白字 ·
 *     标题/页脚品牌深蓝 · 图表用品牌色 · 工作量页无长浮点直出 · 章节页编号+标题 ·
 *     结束页致谢+项目口径 · 正文页标题让开左上装饰 · 降级页同样带背景。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02156-kickoff-brand.mts
 * 结果落 .workbuddy/t02156-gate-results-<运行标识>.txt；样本落 .workbuddy/t02156-brand-sample-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ---------- S 组：源码/资产守卫 ----------
const B = strip(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffBuilder.ts'), 'utf8'));
const LAY = strip(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoff-layout.ts'), 'utf8'));
const STYLE = readFileSync(join(ROOT, 'server', 'src', 'util', 'exportStyle.ts'), 'utf8');
const PKG = readFileSync(join(ROOT, 'server', 'package.json'), 'utf8');
const SVC = strip(readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8'));
const PANEL = readFileSync(join(ROOT, 'web', 'src', 'pages', 'KickoffPptPanel.tsx'), 'utf8');

ok('S-01 品牌四色在 exportStyle 单源定义（门禁 6 色值单源不破）',
  ['BRAND_DEEP', 'BRAND_BRIGHT', 'BRAND_PALE', 'ON_BRAND'].every((n) => new RegExp(`export const ${n} = '[0-9A-F]{6}'`).test(STYLE)),
  ['BRAND_DEEP', 'BRAND_BRIGHT', 'BRAND_PALE', 'ON_BRAND'].filter((n) => !new RegExp(`export const ${n} =`).test(STYLE)));
ok('S-02 品牌深/亮值与恒生模板取色一致（08409C / 0059E9）',
  /BRAND_DEEP = '08409C'/.test(STYLE) && /BRAND_BRIGHT = '0059E9'/.test(STYLE));
ok('S-03 装配层零裸 hex（色值只走 PALETTE，同 T02099 S-08 口径）', !/["'#][0-9a-fA-F]{6}/.test(B));
ok('S-04 版式层 PALETTE 收品牌四色且无裸 hex', /brandDeep: BRAND_DEEP/.test(LAY) && /brandBright: BRAND_BRIGHT/.test(LAY) && !/["'#][0-9a-fA-F]{6}/.test(LAY));
ok('S-05 五页面角色 → 五张背景的映射存在（封面/目录/章节/正文/结束各一）',
  /cover: 'bg-cover\.jpg'/.test(B) && /toc: 'bg-toc\.jpg'/.test(B) && /section: 'bg-section\.jpg'/.test(B)
  && /content: 'bg-content\.jpg'/.test(B) && /thanks: 'bg-thanks\.jpg'/.test(B));
ok('S-06 背景接线在适配层：defineSlideMaster 登记背景 + addSlide 按 layout 选版式',
  /defineBrandBackgrounds\(pptx\)/.test(B) && /pptx\.defineSlideMaster\(\{ title: BG_LAYOUT_NAMES\[kind\], background: \{ path: bgPath \} \}\)/.test(B) && /addSlide\(\{ masterName: BG_LAYOUT_NAMES\[bgKindOf\(item\.layout\)\]/.test(B));
ok('S-07 背景缺失不登记该版式（addSlide 找不到 masterName 回落默认白版式：丢背景不丢内容）',
  /if \(!bgPath\) continue;/.test(B) && /BG_LAYOUT_NAMES: Record<BgKind, string>/.test(B));
ok('S-08 五张背景资产在位且体积受控（各 ≤200KB，避免撑爆 asar）',
  (() => {
    const dir = join(ROOT, 'server', 'src', 'services', 'assets', 'kickoff');
    return ['bg-cover.jpg', 'bg-toc.jpg', 'bg-section.jpg', 'bg-content.jpg', 'bg-thanks.jpg'].every((f) => {
      const p = join(dir, f);
      return existsSync(p) && statSync(p).size <= 200 * 1024;
    });
  })(), ['bg-cover.jpg', 'bg-toc.jpg', 'bg-section.jpg', 'bg-content.jpg', 'bg-thanks.jpg'].map((f) => join(ROOT, 'server', 'src', 'services', 'assets', 'kickoff', f)));
ok('S-09 构建脚本把 assets 复制进 dist（dev 直跑 src、打包用 dist，两路都覆盖）',
  /cpSync\('src\/services\/assets','dist\/services\/assets'/.test(PKG));
ok('S-10 图表字体与颜色显式声明（修图表 Arial+纯黑与正文串行）',
  ['catAxisLabelFontFace', 'valAxisLabelFontFace', 'dataLabelFontFace', 'legendFontFace'].every((k) => new RegExp(`${k}: FONT\\.face`).test(B)) &&
  ['catAxisLabelColor', 'valAxisLabelColor', 'dataLabelColor', 'legendColor'].every((k) => new RegExp(`${k}: PALETTE\\.ink`).test(B)));
ok('S-11 表头品牌深底白字 + 时间线/图表走品牌色', /color: PALETTE\.onBrand, fill: \{ color: PALETTE\.brandDeep \}/.test(B) && /chartColors: \[PALETTE\.brandBright, PALETTE\.brandDeep/.test(B));
ok('S-12 派生量取整呈现（修 P84 43.020620726159656 直出），合计行仍取库内原值',
  /function fmtNum\(/.test(B) && /P84 \$\{fmtNum\(w\.quote\.p84ManDays\)\}/.test(B) && /`总工作量 \$\{range\} 人天/.test(B));
ok('S-13 标题与页脚用品牌深蓝', /color: PALETTE\.brandDeep/.test(B) && (B.match(/color: PALETTE\.brandDeep/g) ?? []).length >= 2);
ok('S-14 section/thanks 两版式进服务端枚举、大纲提示词与前端候选（三处同源）',
  /KICKOFF_LAYOUTS = \[[^\]]*'section', 'thanks'\]/.test(SVC) && /section 作章节页/.test(SVC) && /'section', 'thanks'\]/.test(PANEL));
ok('S-15 章节页/结束页的 dataKeys 在校验层清空并记 warning（纯版式页不挂数）',
  /dataKeys 已被清空/.test(SVC));
ok('S-16 章节页编号按出现序递增（与页码解耦）', /let sectionNo = 0;/.test(B) && /if \(item\.layout === 'section'\) sectionNo \+= 1;/.test(B));

// ---------- U 组：真产物 ----------
const M = await import('../server/src/services/kickoffBuilder.ts');
const L = await import('../server/src/services/kickoff-layout.ts');

ok('U-01 配色自检全过（含品牌三对：表头白字/品牌深底、品牌深/纸面、品牌亮/纸面）',
  L.auditPalette().length === 0, L.auditPalette());
ok('U-02 品牌深/亮压过 4.5（门禁 6 不放宽）',
  L.contrastRatio(L.PALETTE.onBrand, L.PALETTE.brandDeep) >= 4.5 && L.contrastRatio(L.PALETTE.brandDeep, L.PALETTE.paper) >= 4.5 && L.contrastRatio(L.PALETTE.brandBright, L.PALETTE.paper) >= 4.5,
  { onBrandDeep: L.contrastRatio(L.PALETTE.onBrand, L.PALETTE.brandDeep), deepPaper: L.contrastRatio(L.PALETTE.brandDeep, L.PALETTE.paper), brightPaper: L.contrastRatio(L.PALETTE.brandBright, L.PALETTE.paper) });

// 样本 Bundle：mtask五期库内真值口径（14 需求 / 23 计划 / 6 里程碑 / 估算 38.5~59.5）
const plan = (i: number, over: Record<string, unknown> = {}) => ({
  id: `q${i}`, project_id: 'p5', title: `任务 ${i + 1}`, description: '', start_date: '2026-10-12', end_date: '2026-10-27',
  duration_days: 3, progress: 100, status: 'done', assignee: '', sort_order: i, linked_task_id: null, req_ids: null,
  color: '', deps: '', complexity: (i % 5) + 1, kind: 'normal', archived: 0, archived_at: null, created_at: '', updated_at: '', ...over,
});
const bundle = {
  project: { id: 'p5', name: 'mtask五期', workspacePath: 'D:\\code\\otherProjects\\26_MTask' },
  prdDocs: [{ id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentChars: 1200 }],
  prdDoc: { id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentMd: '# 背景\n本节说明启动会稿的口径来源。\n## 目标\n把条数与工期对齐页面。' },
  prdExcerpt: '# 背景\n本节说明启动会稿的口径来源。\n## 目标\n把条数与工期对齐页面。',
  prdTruncated: false,
  requirements: Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`, project_id: 'p5', req_no: `REQ-${String(i + 1).padStart(3, '0')}`, title: `需求 ${i + 1}`, content: null, source_ref: null,
    priority: i % 3 === 0 ? 'high' : 'normal', status: 'done', sort_order: i, created_at: null, updated_at: null, prd_id: 'd1',
    linkedPlans: [{ id: 'x', title: '计划', status: 'done' }], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: 17 }, (_, i) => plan(i)),
  milestones: Array.from({ length: 6 }, (_, i) => plan(100 + i, {
    title: `${i + 1} M${i + 1} 里程碑`, kind: 'milestone', complexity: null, start_date: '2026-10-12',
    end_date: ['2026-10-15', '2026-10-16', '2026-10-27', '2026-10-15', '2026-10-19', '2026-10-16'][i],
  })),
  coverage: { total: 14, covered: 14, uncovered: 0, rate: 100 },
  assignees: [],
  risks: [{ item: '3 条计划复杂度 ≥4', impact: '单条体量偏大，估与做都易失控', mitigation: '按「≥4 建议拆分」口径拆到可交付粒度', source: 'plan_tasks' }],
  workload: {
    source: 'estimate', manDays: { expected: 38.5, optimistic: 38.5, pessimistic: 59.5 }, manMonth: 1.85,
    quote: { p50ManDays: 42, p84ManDays: 43.020620726159656 },
    phases: [{ phase: 'req', expected: 1, rowCount: 1 }, { phase: 'design', expected: 2, rowCount: 1 }, { phase: 'dev', expected: 32.5, rowCount: 13 }, { phase: 'common', expected: 3, rowCount: 2 }],
    complexity: [{ level: '1', count: 4 }, { level: '2', count: 4 }, { level: '3', count: 3 }, { level: '4', count: 3 }, { level: '5', count: 3 }],
    counted: 17, manDaysPerManMonth: 20.83,
    footer: '工作量来源：估算引擎（P50 42 人天 / P84 43 人天）',
  },
  preflight: {
    projectId: 'p5', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 23, 6, 14, 17, 1][i], status: 'ok' as const,
      note: '示例说明文字', deepLink: 'plan' as const, hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问，技术章节可引用其中素材',
  dataAsOf: '2026-10-14',
} as any;

// 17 页样本大纲：恒生五页面结构（封面/目录/章节×3/正文×11/结束），章节页只带标题
const outline = [
  { section: '封面', title: 'mtask五期 项目启动会', bullets: [], dataKeys: [], layout: 'cover' },
  { section: '议程', title: '启动会议程', bullets: ['项目背景与目标', '团队与范围', '计划与工作量', '质量与风险'], dataKeys: [], layout: 'toc' },
  { section: '项目背景', title: '项目背景与需求', bullets: [], dataKeys: [], layout: 'section' },
  { section: '项目背景', title: '项目背景与痛点', bullets: ['读取已沉淀项目管理资料', 'AI 组织原生 PPTX'], dataKeys: ['prdDoc'], layout: 'twoCol' },
  { section: '项目需求', title: '核心需求清单', bullets: ['卡片接入 AI 控制台', 'SSE 流式生成接口'], dataKeys: ['reqList'], layout: 'table' },
  { section: '项目需求', title: '需求完成情况', bullets: ['查看完成占比', '识别遗留缺口'], dataKeys: ['reqStats'], layout: 'list' },
  { section: '项目计划', title: '计划与工作量', bullets: [], dataKeys: [], layout: 'section' },
  { section: '项目范围', title: '里程碑节点', bullets: ['节点日期口径', '状态跟踪'], dataKeys: ['milestones'], layout: 'table' },
  { section: '项目计划', title: '项目时间线', bullets: [], dataKeys: ['timeline'], layout: 'timeline' },
  { section: '项目计划', title: '计划明细表', bullets: ['任务起止日期', '当前完成状态'], dataKeys: ['planRows'], layout: 'table' },
  { section: '工作量评估', title: '工作量与工期', bullets: ['复杂度分布统计', '估算口径说明'], dataKeys: ['workload'], layout: 'twoCol' },
  { section: '测试与质量策略', title: '质量与风险', bullets: [], dataKeys: [], layout: 'section' },
  { section: '测试与质量策略', title: '测试覆盖率与用例', bullets: ['覆盖率指标', '用例分布情况'], dataKeys: ['coverage'], layout: 'list' },
  { section: '项目风险', title: '关键风险与应对', bullets: ['本地风险信号', '缓解措施'], dataKeys: ['risks'], layout: 'table' },
  { section: '沟通管理', title: '前置校验结论', bullets: ['资料齐备性', '阻塞项清单'], dataKeys: ['preflight'], layout: 'table' },
  { section: '附录', title: '资料清单与溯源', bullets: ['数据源齐备性', '关键指标汇总'], dataKeys: ['workspace'], layout: 'list' },
  { section: '附录', title: '谢谢观看', bullets: [], dataKeys: [], layout: 'thanks' },
] as any[];

const built = await M.buildKickoffPpt(bundle, outline);
// T02171：计划超出单页行数的时间线页会展开成续页——「大纲第 i 项 = 第 i 张幻灯片」不再成立。
// 按装配层同一口径（expandTimelinePages）反查每个大纲项落在哪张幻灯片，续页归给它所属的时间线。
const renderPages = M.expandTimelinePages(bundle, outline) as any[];
const slideIdx = (oi: number) => M.expandTimelinePages(bundle, outline.slice(0, oi + 1)).length - 1;
ok('U-03 17 页样本出真 .pptx（PK 容器，页数与渲染页一致，含 3 章节页 + 1 结束页且不触发降级）',
  built.buffer[0] === 0x50 && built.buffer[1] === 0x4b && built.pageCount === renderPages.length && built.degradedPages.length === 0,
  { bytes: built.buffer.length, degraded: built.degradedPages, pageCount: built.pageCount, render: renderPages.length });

const JSZip = (await import('jszip')).default;
const zip = await JSZip.loadAsync(built.buffer);
const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const slideXmls = await Promise.all(slideNames.map(async (f) => await zip.file(f)!.async('string')));
const chartXmls = await Promise.all(Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).map(async (f) => await zip.file(f)!.async('string')));
const mediaFiles = Object.keys(zip.files).filter((n) => /^ppt\/media\/.+/.test(n) && !n.endsWith('/'));

// 背景落在版式层（defineSlideMaster 的 background）：slide 无 <p:bg>、无 embed，全部继承自 layout
const layoutNames = Object.keys(zip.files).filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const layoutXmls = await Promise.all(layoutNames.map(async (f) => await zip.file(f)!.async('string')));
const bgLayouts = layoutNames.filter((_f, i) => /<p:bg><p:bgPr><a:blipFill/.test(layoutXmls[i])).map((n) => n.replace('ppt/slideLayouts/', ''));
const layoutMediaOf = async (layoutName: string) => {
  const rels = await zip.file(`ppt/slideLayouts/_rels/${layoutName}.rels`)!.async('string');
  const xml = await zip.file(`ppt/slideLayouts/${layoutName}`)!.async('string');
  const embed = (xml.match(/r:embed="(rId\d+)"/) ?? [])[1] ?? '';
  const m = new RegExp(`Id="${embed}"[^>]*Target="([^"]+)"`).exec(rels);
  return m ? m[1] : '';
};
const bgMedia = await Promise.all(bgLayouts.map(layoutMediaOf));
const slideLayoutOf = async (n: number) => {
  const rels = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`)!.async('string');
  const m = /Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/.exec(rels);
  return m ? m[1] : '';
};
const slideLayouts = await Promise.all(Array.from({ length: slideXmls.length }, (_, i) => slideLayoutOf(i + 1)));

ok('U-04 五张恒生背景登记为自定义版式（layout 级 `<p:bg>`，页面继承——同图全稿只落一份媒体）',
  bgLayouts.length === 5 && mediaFiles.length === 5,
  { bgLayouts, media: mediaFiles });
ok('U-05 背景按页面角色各就其位：封面/目录/章节/结束四张不同图，其余内容页（含时间线续页）全同',
  (() => {
    const kindOfLayout = (lf: string) => bgMedia[bgLayouts.indexOf(lf)] ?? '';
    const layoutOfKind = (kind: string) => bgLayouts.find((lf) => new RegExp(kind, 'i').test(kindOfLayout(lf))) ?? '';
    const coverL = layoutOfKind('COVER');
    const tocL = layoutOfKind('TOC');
    const sectionL = layoutOfKind('SECTION');
    const thanksL = layoutOfKind('THANKS');
    const contentL = layoutOfKind('CONTENT');
    const sectionPages = outline.map((p: any, i: number) => (p.layout === 'section' ? slideIdx(i) : -1)).filter((i: number) => i >= 0);
    const thanksPage = slideIdx(outline.findIndex((p: any) => p.layout === 'thanks'));
    return !!coverL && !!tocL && !!sectionL && !!thanksL && !!contentL && new Set(bgMedia).size === 5
      && slideLayouts[0] === coverL && slideLayouts[1] === tocL
      && sectionPages.every((p: number) => slideLayouts[p] === sectionL)
      && slideLayouts[thanksPage] === thanksL
      && slideLayouts.every((lf, i) => lf === contentL
        || i === 0 || i === 1 || sectionPages.includes(i) || i === thanksPage);
  })(), { bgMedia, slideLayouts });

/** 取正则首个捕获组的去重集（matchAll——match 带 /g 只回全匹配不回组） */
const groupsOf = (s: string, re: RegExp): string[] => [...new Set([...s.matchAll(re)].map((m) => m[1]))];

ok('U-06 内容零位图：slide 无 <p:pic>、无任何 r:embed（背景全在版式层），版式里每个 embed 都来自 <p:bg> 的 blipFill（验收 5 不放宽）',
  slideXmls.every((x) => !/<p:pic/.test(x)) && slideXmls.every((x) => !/r:embed="/.test(x)) &&
    layoutXmls.every((x) => (x.match(/r:embed="/g) ?? []).length === (x.match(/<p:bg><p:bgPr><a:blipFill/g) ?? []).length),
  { media: mediaFiles, pics: slideXmls.filter((x) => /<p:pic/.test(x)).length, slideEmbeds: slideXmls.filter((x) => /r:embed="/.test(x)).length });
ok('U-07 全稿微软雅黑：slide 无 Arial；图表里 Arial 只允许残留在 doughnut/pie 的 dLbls 组级兜底块'
  + '（pptxgenjs 对该块硬编码 Arial/18pt/黑——逐点 <c:dLbl> 已用雅黑+墨色覆盖它，实际渲染取逐点值）；'
  + '图例/逐点标签的字体全部显式声明为雅黑',
  slideXmls.every((x) => !/typeface="Arial"/.test(x)) && chartXmls.length > 0 && chartXmls.every((x) => {
    // 组级兜底块（不在任何 <c:dLbl> 内、不在 <c:legend> 内）之外不允许出现 Arial
    const withoutGroupFallback = x.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g, (m) =>
      m.replace(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g, '').replace(/<a:latin typeface="Arial"\/>/g, ''));
    return !/typeface="Arial"/.test(withoutGroupFallback)
      && groupsOf(x, /<c:dLbl>(?:(?!<\/c:dLbl>).)*?typeface="([^"]+)"/gs).every((f) => /微软雅黑/.test(f))
      && /<c:legend>(?:(?!<\/c:legend>).)*?typeface="微软雅黑"/s.test(x);
  }), chartXmls.map((x) => [...new Set((x.match(/typeface="([^"]+)"/g) ?? []).map((s) => s.slice(10, -1)))]));
ok('U-08 无纯黑 000000 渲染文字：slide 零处；图表里 000000 只允许残留在上述 dLbls 组级兜底块（逐点已覆盖为墨色）',
  !slideXmls.join('').includes('val="000000"') && chartXmls.every((x) => {
    const withoutGroupFallback = x.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g, (m) =>
      m.replace(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g, '').replace(/<a:srgbClr val="000000"\/>/g, ''));
    return !/val="000000"/.test(withoutGroupFallback)
      && groupsOf(x, /<c:dLbl>(?:(?!<\/c:dLbl>).)*?srgbClr val="([0-9A-F]{6})"/gs).every((c) => c === '1F2937');
  }));
ok('U-09 表头品牌深底白字（08409C 底 + FFFFFF 字成对出现）',
  /srgbClr val="08409C"/.test(slideXmls.join('')) && /srgbClr val="FFFFFF"/.test(slideXmls.join('')));
ok('U-10 标题 run 全部品牌深蓝：每页 22/28/32pt 的 run 都带 08409C（页脚 9pt 另有其色）',
  (() => {
    const runsOf = (x: string) => x.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? [];
    return slideXmls.every((x) => {
      const titleRuns = runsOf(x).filter((r) => /sz="2200"|sz="2800"|sz="3200"/.test(r));
      return titleRuns.length > 0 && titleRuns.every((r) => /srgbClr val="08409C"/.test(r));
    });
  })(), slideXmls.map((x, i) => ({ p: i + 1, deep: /srgbClr val="08409C"/.test(x) })));
const tlIdx = slideIdx(outline.findIndex((p: any) => p.dataKeys.includes('timeline')));
ok('U-11 时间线形状走品牌色：条 0059E9、菱形与轴 08409C',
  (() => {
    const tl = slideXmls[tlIdx];
    return /prst="rect"[^>]*>(?:(?!<\/p:sp>).)*?srgbClr val="0059E9"/s.test(tl) && /prst="diamond"(?:(?!<\/p:sp>).)*?srgbClr val="08409C"/s.test(tl);
  })(), `slide${tlIdx + 1}`);
const wlIdx = slideIdx(outline.findIndex((p: any) => p.dataKeys.includes('workload')));
ok('U-12 工作量页无长浮点直出（P84 43.020620726159656 → 呈现 43；合计行仍取库内原值）',
  (() => {
    const wl = slideXmls[wlIdx];
    return !/\d\.\d{4,}/.test(wl) && /P84 43 人天/.test(wl) && /P50 42 人天/.test(wl) && /38\.5~59\.5（P50 38\.5）/.test(wl) && /≈ 1\.85 人月/.test(wl) && /阶段分布：req 1 \/ design 2 \/ dev 32\.5 \/ common 3 人天/.test(wl);
  })(), slideXmls[wlIdx].match(/总工作量[^<]*/)?.[0]);
ok('U-13 章节页：编号 01/02/03 依次递增 + 28pt 品牌深蓝标题居中（模板 slide3 同款几何），不挂数据块',
  (() => {
    const secIdxs = outline.map((p: any, i: number) => (p.layout === 'section' ? slideIdx(i) : -1)).filter((i: number) => i >= 0);
    return secIdxs.length === 3 && secIdxs.every((si: number, k: number) => {
      const x = slideXmls[si];
      const num = String(k + 1).padStart(2, '0');
      return new RegExp(`<a:t>${num}</a:t>`).test(x)
        && /sz="2800"[^>]*>(?:(?!<\/a:r>).)*?srgbClr val="08409C"/s.test(x)
        && !/<a:tbl>/.test(x) && !/<c:chart/.test(x); // 章节页只排编号与标题，不挂数据块
    });
  })(), outline.map((p: any, i: number) => (p.layout === 'section' ? `p${i + 1}:${p.title}` : null)).filter(Boolean));
ok('U-14 结束页：致谢标题 + 「项目名 · 数据截至」口径行，不带数据块',
  (() => {
    const thIdx = slideIdx(outline.findIndex((p: any) => p.layout === 'thanks'));
    const x = slideXmls[thIdx];
    return /<a:t>谢谢观看<\/a:t>/.test(x) && /mtask五期 · 数据截至 2026-10-14/.test(x) && !/<a:tbl>/.test(x) && !/<c:chart/.test(x);
  })());
ok('U-15 正文页标题让开左上装饰：标题盒 x ≥ 1.0"（装饰占 0~0.92"，不压字）',
  (() => {
    const contentIdx = slideIdx(outline.findIndex((p: any) => p.layout === 'twoCol'));
    const x = slideXmls[contentIdx];
    const titleSp = (x.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []).find((sp) => /sz="2200"/.test(sp)) ?? '';
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(titleSp);
    return !!off && Number(off[1]) / 914400 >= 1.0;
  })(), `slide${slideIdx(outline.findIndex((p: any) => p.layout === 'twoCol')) + 1}`);
ok('U-16 降级页（超长标题）也带品牌背景，不因降级退回纯白',
  await (async () => {
    const bad = outline.map((o, i) => (i === 3 ? { ...o, title: '本页标题刻意超长以逼出越界'.repeat(4) } : o));
    const dg = await M.buildKickoffPpt(bundle, bad as any);
    const z = await JSZip.loadAsync(dg.buffer);
    const rels = await z.file('ppt/slides/_rels/slide4.xml.rels')!.async('string');
    const m = /Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/.exec(rels);
    if (!m) return false;
    const lx = await z.file(`ppt/slideLayouts/${m[1]}`)!.async('string');
    return dg.degradedPages.includes(4) && /<p:bg><p:bgPr><a:blipFill/.test(lx);
  })());
ok('U-17 样本体积受控（五张背景各只落一份 + 17 页表格/图表本体：≤800KB；逐页贴背景会是 1MB+）', built.buffer.length <= 800 * 1024, built.buffer.length);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(gateArtifactPath(OUT_DIR, 't02156-brand-sample.pptx'), built.buffer);
writeGateResults(OUT_DIR, 't02156-gate-results.txt', `T02156 恒生模板视觉门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
