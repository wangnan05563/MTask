/**
 * MTask 四期·五期 功能模块培训 PPT — 原生 pptxgenjs 构建
 * 修复 html2pptx 转换质量差的问题：全部幻灯片用原生元素构建。
 * Run: node scripts/build-training-pptx.cjs
 */
const pptxgen = require('C:/Users/hspcadmin/.workbuddy/plugins/cache/experts/ppt-implement/1.0.13/skills/ppt-implement/scripts/export/node_modules/pptxgenjs');

const OUT = 'D:/code/otherProjects/26_MTask/artifacts/presentation.pptx';

// ============================================================
// SLIDE DIMENSIONS - LAYOUT_16x9
// ============================================================
const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
const SLIDE_W = 10, SLIDE_H = 5.625, MARGIN = 0.5;
const CX = 0.5, CW = 9; // content frame
const CENTER_X = SLIDE_W / 2;

// ============================================================
// THEME
// ============================================================
const C = {
  bg: '0A0E1A', surface: '111A2E', surface2: '0D1526', border: '22304F',
  cyan: '38BDF8', purple: 'A78BFA', amber: 'FBBF24', green: '34D399',
  text: 'E6EDF7', muted: '8FA3BF', ghost: '16223A', faint: '3B4A66',
  code: 'D4D4D4', comment: '6A9955', str: 'CE9178',
};
const FONT = 'Microsoft YaHei', MONO = 'Consolas';
const RRECT = 'roundRect', RECT = 'rect', OVAL = 'ellipse';

// ============================================================
// CONTAINER SYSTEM WITH TEXT OVERFLOW PROTECTION (required)
// ============================================================
function parseImageDimensions(path) {
  const match = path.match(/_(\d+)x(\d+)\.(png|jpg|jpeg|gif|webp)$/i);
  if (match) return { width: parseInt(match[1]), height: parseInt(match[2]) };
  return null;
}
function calculateScaledImageOpts(opts) {
  const { path, w: targetW, h: targetH, x = 0, y = 0, ...rest } = opts;
  if (!path || !targetW || !targetH) return opts;
  const dims = parseImageDimensions(path);
  if (!dims) return opts;
  const imgAspect = dims.width / dims.height;
  const targetAspect = targetW / targetH;
  let scaledW, scaledH, offsetX = 0, offsetY = 0;
  if (imgAspect > targetAspect) {
    scaledW = targetW; scaledH = targetW / imgAspect; offsetY = (targetH - scaledH) / 2;
  } else {
    scaledH = targetH; scaledW = targetH * imgAspect; offsetX = (targetW - scaledW) / 2;
  }
  return { path, x: x + offsetX, y: y + offsetY, w: scaledW, h: scaledH, ...rest };
}
function createVirtualNode(type, data, parentX = 0, parentY = 0) {
  const opts = data.opts || {};
  const node = { type, data, absX: parentX + (opts.x || 0), absY: parentY + (opts.y || 0), w: opts.w || 0, h: opts.h || 0, children: [] };
  node.addShape = function (shapeType, opts = {}) { const child = createVirtualNode('shape', { shapeType, opts }, node.absX, node.absY); node.children.push(child); return child; };
  node.addText = function (text, opts = {}) {
    const safeOpts = { fit: 'shrink', ...opts };
    const child = createVirtualNode('text', { text, opts: safeOpts }, node.absX, node.absY);
    node.children.push(child); return child;
  };
  node.addImage = function (opts = {}) { const scaledOpts = calculateScaledImageOpts(opts); const child = createVirtualNode('image', { opts: scaledOpts }, node.absX, node.absY); node.children.push(child); return child; };
  node.addTable = function (tableData, opts = {}) { const child = createVirtualNode('table', { tableData, opts }, node.absX, node.absY); node.children.push(child); return child; };
  return node;
}
function flattenNode(node, realSlide, pres) {
  const absOpts = { ...node.data.opts, x: node.absX, y: node.absY };
  if (node.type === 'shape') realSlide.addShape(node.data.shapeType, absOpts);
  else if (node.type === 'text') realSlide.addText(node.data.text, absOpts);
  else if (node.type === 'image') realSlide.addImage(absOpts);
  else if (node.type === 'table') realSlide.addTable(node.data.tableData, absOpts);
  node.children.forEach(child => flattenNode(child, realSlide, pres));
}
const originalAddSlide = pres.addSlide.bind(pres);
pres.addSlide = function (options) {
  const realSlide = originalAddSlide(options);
  const virtualSlide = {
    children: [], _realSlide: realSlide,
    set background(val) { realSlide.background = val; },
    get background() { return realSlide.background; },
    addShape: function (shapeType, opts = {}) { const node = createVirtualNode('shape', { shapeType, opts }, 0, 0); this.children.push(node); return node; },
    addText: function (text, opts = {}) { const safeOpts = { fit: 'shrink', ...opts }; const node = createVirtualNode('text', { text, opts: safeOpts }, 0, 0); this.children.push(node); return node; },
    addImage: function (opts = {}) { const scaledOpts = calculateScaledImageOpts(opts); const node = createVirtualNode('image', { opts: scaledOpts }, 0, 0); this.children.push(node); return node; },
    addTable: function (tableData, opts = {}) { const node = createVirtualNode('table', { tableData, opts }, 0, 0); this.children.push(node); return node; },
    addChart: function (chartType, data, opts = {}) { realSlide.addChart(chartType, data, opts); },
    render: function () { this.children.forEach(child => flattenNode(child, realSlide, pres)); },
  };
  return virtualSlide;
};

// ============================================================
// HELPERS
// ============================================================
let PAGE_NO = 0;
function baseSlide() {
  PAGE_NO++;
  const s = pres.addSlide();
  s.background = { color: C.bg };
  return s;
}
function footer(s) {
  s.addText(`MTASK P4/P5 TRAINING · ${String(PAGE_NO).padStart(2, '0')}/21`, {
    x: 6.7, y: 5.3, w: 2.85, h: 0.22, align: 'right', fontFace: FONT, fontSize: 8, color: C.faint, margin: 0,
  });
}
function cornerDeco(s) {
  s.addShape(RECT, { x: 8.85, y: 0.44, w: 0.6, h: 0.09, fill: { color: C.cyan } });
  s.addShape(RECT, { x: 9.5, y: 0.44, w: 0.25, h: 0.09, fill: { color: C.purple } });
}
function header(s, tag, titleText, accent = C.cyan, titleSize = 24) {
  s.addShape(RECT, { x: CX, y: 0.47, w: 0.1, h: 0.1, fill: { color: accent } });
  s.addText(tag, { x: CX + 0.2, y: 0.38, w: 7.6, h: 0.28, fontFace: FONT, fontSize: 10.5, bold: true, color: accent, charSpacing: 2, margin: 0 });
  s.addText(titleText, { x: CX, y: 0.68, w: CW, h: 0.6, fontFace: FONT, fontSize: titleSize, bold: true, color: C.text, margin: 0 });
  cornerDeco(s);
  footer(s);
}
function card(s, x, y, w, h, o) {
  const accent = o.accent || C.cyan;
  s.addShape(RRECT, { x, y, w, h, rectRadius: 0.05, fill: { color: C.surface }, line: { color: C.border, width: 0.75 } });
  s.addShape(RECT, { x, y: y + 0.12, w: 0.05, h: h - 0.24, fill: { color: accent } });
  let cy = y + 0.13;
  if (o.tag) { s.addText(o.tag, { x: x + 0.22, y: cy, w: w - 0.44, h: 0.24, fontFace: FONT, fontSize: 9.5, bold: true, color: accent, charSpacing: 1.2, margin: 0 }); cy += 0.26; }
  if (o.title) { s.addText(o.title, { x: x + 0.22, y: cy, w: w - 0.44, h: 0.32, fontFace: FONT, fontSize: 13.5, bold: true, color: C.text, margin: 0 }); cy += 0.36; }
  if (o.body) { s.addText(o.body, { x: x + 0.22, y: cy, w: w - 0.44, h: y + h - cy - 0.1, fontFace: FONT, fontSize: 10, color: C.muted, lineSpacingMultiple: 1.22, valign: 'top', margin: 0 }); }
}
function strip(s, label, text, accent = C.amber, y = 4.32, h = 0.62) {
  s.addShape(RRECT, { x: CX, y, w: CW, h, rectRadius: 0.05, fill: { color: C.surface2 }, line: { color: C.border, width: 0.75 } });
  s.addShape(RECT, { x: CX, y: y + 0.1, w: 0.05, h: h - 0.2, fill: { color: accent } });
  s.addText(label, { x: CX + 0.2, y, w: 1.25, h, valign: 'middle', fontFace: FONT, fontSize: 10.5, bold: true, color: accent, margin: 0 });
  s.addText(text, { x: CX + 1.5, y, w: CW - 1.75, h, valign: 'middle', fontFace: FONT, fontSize: 9.5, color: C.muted, lineSpacingMultiple: 1.15, margin: 0 });
}
function flow(s, nodes, y, h = 1.45) {
  const n = nodes.length, gap = 0.32;
  const nodeW = (CW - (n - 1) * gap) / n;
  nodes.forEach((nd, i) => {
    const x = CX + i * (nodeW + gap);
    s.addShape(RRECT, { x, y, w: nodeW, h, rectRadius: 0.06, fill: { color: C.surface2 }, line: { color: C.border, width: 0.75 } });
    s.addShape(RECT, { x, y, w: nodeW, h: 0.05, fill: { color: nd.accent || C.cyan } });
    s.addText(nd.k, { x: x + 0.13, y: y + 0.14, w: nodeW - 0.26, h: 0.24, fontFace: MONO, fontSize: 10, bold: true, color: nd.accent || C.cyan, charSpacing: 1, margin: 0 });
    s.addText(nd.t, { x: x + 0.13, y: y + 0.42, w: nodeW - 0.26, h: 0.34, fontFace: FONT, fontSize: 12, bold: true, color: C.text, margin: 0 });
    if (nd.d) s.addText(nd.d, { x: x + 0.13, y: y + 0.8, w: nodeW - 0.26, h: h - 0.92, fontFace: FONT, fontSize: 9.5, color: C.muted, lineSpacingMultiple: 1.15, valign: 'top', margin: 0 });
    if (i < n - 1) s.addText('→', { x: x + nodeW - 0.02, y: y + h / 2 - 0.22, w: gap + 0.04, h: 0.44, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 15, bold: true, color: C.cyan, margin: 0 });
  });
}
function chips(s, items, y) {
  const n = items.length, chipW = 1.7, gap = 0.55;
  const total = n * chipW + (n - 1) * gap;
  const x0 = CX + (CW - total) / 2;
  items.forEach((t, i) => {
    const x = x0 + i * (chipW + gap);
    s.addShape(RRECT, { x, y, w: chipW, h: 0.42, rectRadius: 0.21, fill: { color: C.surface2 }, line: { color: C.cyan, width: 0.75 } });
    s.addText(t, { x, y, w: chipW, h: 0.42, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 11, bold: true, color: C.text, margin: 0 });
    if (i < n - 1) s.addText('→', { x: x + chipW, y, w: gap, h: 0.42, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 13, bold: true, color: C.cyan, margin: 0 });
  });
}
function divider(num, ttl, sub, accent) {
  const s = baseSlide();
  s.addText(num, { x: 0.5, y: 0.85, w: 3.7, h: 3.3, fontFace: FONT, fontSize: 150, bold: true, color: C.ghost, margin: 0 });
  s.addShape(RECT, { x: 4.4, y: 1.85, w: 0.06, h: 1.65, fill: { color: accent } });
  s.addText('SECTION ' + num, { x: 4.75, y: 1.95, w: 4.5, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: accent, charSpacing: 3, margin: 0 });
  s.addText(ttl, { x: 4.75, y: 2.28, w: 4.8, h: 0.78, fontFace: FONT, fontSize: 34, bold: true, color: C.text, margin: 0 });
  s.addText(sub, { x: 4.75, y: 3.12, w: 4.8, h: 0.38, fontFace: FONT, fontSize: 13, color: C.muted, margin: 0 });
  cornerDeco(s);
  footer(s);
  s.render();
  return s;
}

// ============================================================
// SLIDE 1 — 封面
// ============================================================
{
  const s = baseSlide();
  s.addShape(RECT, { x: 0, y: 0, w: SLIDE_W, h: 0.07, fill: { color: C.cyan } });
  s.addShape(RECT, { x: 0, y: 0, w: 3.2, h: 0.07, fill: { color: C.purple } });
  s.addText('[ SYSTEM_READY · MTASK PHASE 4 / 5 ]', { x: 0.9, y: 1.1, w: 5.5, h: 0.3, fontFace: MONO, fontSize: 11, bold: true, color: C.cyan, charSpacing: 2, margin: 0 });
  s.addText('MTask 四期 · 五期', { x: 0.9, y: 1.5, w: 5.6, h: 0.95, fontFace: FONT, fontSize: 42, bold: true, color: C.text, margin: 0 });
  s.addText('功能模块培训', { x: 0.9, y: 2.5, w: 5.6, h: 0.6, fontFace: FONT, fontSize: 25, bold: true, color: C.cyan, margin: 0 });
  s.addShape(RECT, { x: 0.93, y: 3.3, w: 0.5, h: 0.05, fill: { color: C.amber } });
  s.addText('从项目计划 → 对外报价 → 一键成稿', { x: 0.9, y: 3.5, w: 5.5, h: 0.35, fontFace: FONT, fontSize: 14, color: C.muted, margin: 0 });
  s.addText('INTERNAL TRAINING · 2026', { x: 0.9, y: 4.85, w: 4, h: 0.28, fontFace: FONT, fontSize: 10, bold: true, color: C.faint, charSpacing: 2, margin: 0 });
  // 右侧装饰：终端窗口
  s.addShape(RRECT, { x: 6.6, y: 1.35, w: 2.7, h: 2.55, rectRadius: 0.07, fill: { color: C.surface }, line: { color: C.border, width: 1 } });
  [0, 1, 2].forEach(i => s.addShape(OVAL, { x: 6.82 + i * 0.24, y: 1.56, w: 0.12, h: 0.12, fill: { color: [C.red || 'F87171', C.amber, C.green][i] } }));
  const lines = [
    { w: 1.9, c: C.cyan }, { w: 1.5, c: C.border }, { w: 2.1, c: C.purple },
    { w: 1.2, c: C.border }, { w: 1.8, c: C.cyan }, { w: 2.2, c: C.border }, { w: 1.4, c: C.amber },
  ];
  lines.forEach((ln, i) => s.addShape(RECT, { x: 6.85, y: 1.92 + i * 0.27, w: ln.w, h: 0.08, fill: { color: ln.c } }));
  footer(s);
  s.render();
}

// ============================================================
// SLIDE 2 — 目录
// ============================================================
{
  const s = baseSlide();
  header(s, '[ CONTENTS ]', '目录 · 培训导航');
  const rows = [
    ['01', '背景与总览', '为何要做四期、五期，交付了什么', C.cyan],
    ['02', '四期详解', '估算 · 导出 · 测试用例管理', C.purple],
    ['03', '五期详解', 'AI 控制台 · 项目启动会 PPT 生成', C.amber],
    ['04', '实操与收尾', '使用流程 · 成效 · 边界', C.green],
  ];
  rows.forEach((r, i) => {
    const y = 1.52 + i * 0.88;
    s.addShape(RRECT, { x: CX, y, w: CW, h: 0.72, rectRadius: 0.05, fill: { color: C.surface }, line: { color: C.border, width: 0.75 } });
    s.addShape(RECT, { x: CX, y: y + 0.1, w: 0.05, h: 0.52, fill: { color: r[3] } });
    s.addText(r[0], { x: CX + 0.25, y, w: 0.85, h: 0.72, valign: 'middle', fontFace: FONT, fontSize: 20, bold: true, color: r[3], margin: 0 });
    s.addText(r[1], { x: CX + 1.25, y, w: 2.7, h: 0.72, valign: 'middle', fontFace: FONT, fontSize: 15, bold: true, color: C.text, margin: 0 });
    s.addText(r[2], { x: CX + 4.1, y, w: 4.6, h: 0.72, valign: 'middle', fontFace: FONT, fontSize: 11, color: C.muted, margin: 0 });
  });
  s.render();
}

// ============================================================
// SLIDE 3 — 章节页 01
// ============================================================
divider('01', '背景与总览', '为何要做四期、五期', C.cyan);

// ============================================================
// SLIDE 4 — 三个断点
// ============================================================
{
  const s = baseSlide();
  header(s, '[ BACKGROUND · 背景与痛点 ]', '资料"沉而不用"的三个断点');
  const w3 = 2.8, gap = 0.3;
  const cards = [
    ['01', '报价脱节', '计划、需求矩阵、测试用例、1580 条历史待办已沉淀，却只用于排期；对外报价仍手工誊抄 Excel，不可追溯、无法随计划刷新。', C.cyan],
    ['02', '用例零散', '用例散落文档与口头，缺统一库、缺覆盖度度量、缺与需求矩阵的双向溯源；质量保障难以量化，回归范围靠人脑记忆。', C.purple],
    ['03', '资料不转化', 'PRD / 矩阵 / 计划 / 用例沉淀后，启动会材料仍靠人工拼装 PPT，耗时且风格不一；一次启动会往往重做数小时排版。', C.amber],
  ];
  cards.forEach((c, i) => card(s, CX + i * (w3 + gap), 1.52, w3, 2.55, { tag: c[0], title: c[1], body: c[2], accent: c[3] }));
  strip(s, '现状证据', 'mtask四期 12 条需求（high 10 / normal 2）· 工期 normal avg 1.75 天 · milestone avg 7.0 天 —— 资料已够，只差"转化能力"。');
  s.render();
}

// ============================================================
// SLIDE 5 — 模块地图
// ============================================================
{
  const s = baseSlide();
  header(s, '[ OVERVIEW · 交付总览 ]', '四期 · 五期 三大能力模块地图');
  const w2 = 4.35, gap = 0.3;
  const cards = [
    ['PHASE 4', '估算面板与 PERT 引擎', '三点估算 O/M/P → 期望值 σ → 阶段人月汇总，把"不确定度"变成可见的报价口径。', C.cyan],
    ['PHASE 4', 'Excel / PDF 导出', '逐格复刻客户模板的 Excel 与可直接提交的 PDF，零二次排版；以 MCP 工具暴露。', C.purple],
    ['PHASE 4', '测试用例管理 + AI 生成', '结构化用例库 + 覆盖度度量 + 与需求矩阵双向溯源 + AI 草稿生成。', C.amber],
    ['PHASE 5', 'AI 启动会 PPT 生成', '读项目沉淀资料，一键生成 12~18 页可编辑原生 .pptx 启动会材料。', C.green],
  ];
  cards.forEach((c, i) => {
    const x = CX + (i % 2) * (w2 + gap), y = 1.5 + Math.floor(i / 2) * 1.75;
    card(s, x, y, w2, 1.5, { tag: c[0], title: c[1], body: c[2], accent: c[3] });
  });
  chips(s, ['计划', '估算报价', '用例覆盖', '启动会成稿'], 4.95);
  s.render();
}

// ============================================================
// SLIDE 6 — 章节页 02
// ============================================================
divider('02', '四期详解', '估算 · 导出 · 测试用例管理', C.purple);

// ============================================================
// SLIDE 7 — 估算面板
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P4 · 估算面板 ]', '估算面板与三点估算');
  s.addText('把单点拍脑袋，升级为可追溯的三点估算口径', { x: CX, y: 1.32, w: CW, h: 0.28, fontFace: FONT, fontSize: 11.5, italic: true, color: C.muted, margin: 0 });
  const w2 = 4.35, gap = 0.3;
  const cards = [
    ['01', '入口与布局', '在「项目管理」时间线视图右侧新增估算面板；每条计划条目即一个估算对象，沿用既有布局与 UI 守卫。', C.cyan],
    ['02', '三点录入', '每行录入乐观 O / 最可能 M / 悲观 P；支持批量填充与逐条覆盖，复杂度→系数可冷启动推导。', C.purple],
    ['03', '实时可视化', '不确定度随录入实时可见；标准差 / 置信区间让"估了多少、有多不确定"同时呈现。', C.amber],
    ['04', '数据联动', '每条估算锚定计划条目与需求编号，客户质询可逐行回放到需求与用例，全程可追溯。', C.green],
  ];
  cards.forEach((c, i) => {
    const x = CX + (i % 2) * (w2 + gap), y = 1.72 + Math.floor(i / 2) * 1.62;
    card(s, x, y, w2, 1.42, { tag: c[0], title: c[1], body: c[2], accent: c[3] });
  });
  s.render();
}

// ============================================================
// SLIDE 8 — PERT 引擎
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P4 · PERT 引擎 ]', 'PERT 计算与汇总引擎');
  flow(s, [
    { k: 'INPUT', t: '三点 O / M / P', d: '逐条计划录入' },
    { k: 'E', t: '(O+4M+P)/6', d: '期望值' },
    { k: 'σ', t: '(P−O)/6', d: '标准差' },
    { k: 'CI', t: '置信区间', d: '不确定度' },
    { k: 'Σ', t: '阶段人月', d: '汇总报价口径', accent: C.amber },
  ], 1.55);
  const w2 = 4.35, gap = 0.3;
  card(s, CX, 3.4, w2, 1.4, { tag: '汇总口径', title: '按阶段汇总', body: '按需求 / 设计 / 开发 / 实施等阶段聚合；最终估算 → 阶段人月 → 调节系数 → 实际预估人月，复刻客户模板 R35~R40。', accent: C.cyan });
  card(s, CX + w2 + gap, 3.4, w2, 1.4, { tag: '护栏', title: '排除规则', body: '排除小计行、里程碑不进 Σ；前端求和必须 ≈ 客户模板 H35 单元格，口径一致才可交付。', accent: C.amber });
  s.render();
}

// ============================================================
// SLIDE 9 — 导出
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P4 · 导出 ]', 'Excel / PDF 导出 · 交付即用');
  const w3 = 2.8, gap = 0.3;
  const cards = [
    ['.XLSX', 'Excel 复刻模板', 'sheet 名、合并区、公式、命名区域、列宽逐格对齐客户模板（阜新银行工作量评估表），无需二次排版。', C.cyan],
    ['.PDF', '可交付 PDF', '生成可直接提交客户的报价版 PDF；失败时快照留档 estimate_snapshots，可追溯可重放。', C.purple],
    ['MCP', '工具暴露', '以 mtask_* 家族工具暴露，可被外部 Agent 直接调用，复用既有清单与鉴权体系。', C.amber],
  ];
  cards.forEach((c, i) => card(s, CX + i * (w3 + gap), 1.52, w3, 2.55, { tag: c[0], title: c[1], body: c[2], accent: c[3] }));
  strip(s, '零新依赖', 'exceljs 4.4.0 · docx 9.7.1 · pdfkit 0.20.1（均在 server/package.json）；E0 Spike 已实测：{formula,result} 双写、命名区域写侧注入、28 处合并区无损。');
  s.render();
}

// ============================================================
// SLIDE 10 — 测试用例管理
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P4 · 测试用例管理 ]', '测试用例管理模块');
  s.addText('从零散 → 结构化库，并打通需求矩阵溯源', { x: CX, y: 1.32, w: CW, h: 0.28, fontFace: FONT, fontSize: 11.5, italic: true, color: C.muted, margin: 0 });
  const w2 = 4.35, gap = 0.3;
  const cards = [
    ['A', '数据模型', '新增 test_cases + case_steps 步骤子表；枚举常量服务端单源，前后端共用。', C.cyan],
    ['B', 'CRUD 与批量', '用例增删改查 + 批量操作（静态路径优先于 /:id）；导出接口齐备。', C.purple],
    ['C', '覆盖度度量', '按 P0~P3 优先级统计覆盖；参考基线 swork 71 条用例（P0 9 / P1 31 / P2 25 / P3 6）。', C.amber],
    ['D', '矩阵双向跳转', '需求跟踪矩阵与用例视图双向跳转，每条用例可溯源到需求编号。', C.green],
  ];
  cards.forEach((c, i) => {
    const x = CX + (i % 2) * (w2 + gap), y = 1.72 + Math.floor(i / 2) * 1.62;
    card(s, x, y, w2, 1.42, { tag: c[0], title: c[1], body: c[2], accent: c[3] });
  });
  s.render();
}

// ============================================================
// SLIDE 11 — AI 生成链路
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P4 · AI 生成链路 ]', 'AI 生成链路与 MCP 工具');
  flow(s, [
    { k: 'INPUT', t: 'PRD / 外部导入', d: '原始资料' },
    { k: 'SERVICE', t: 'TestCaseGenService', d: '生成服务', accent: C.purple },
    { k: 'DRAFT', t: '草稿确认视图', d: '人工确认' },
    { k: 'IMPORT', t: '确认导入', d: '写入用例库' },
    { k: 'MCP', t: 'mtask_* 暴露', d: '外部可调用', accent: C.amber },
  ], 1.55);
  const w2 = 4.35, gap = 0.3;
  card(s, CX, 3.4, w2, 1.4, { tag: '安全阀', title: '草稿优先', body: 'AI 生成用例草稿，人工确认后再导入，避免误写库；会话状态保持可续编。', accent: C.cyan });
  card(s, CX + w2 + gap, 3.4, w2, 1.4, { tag: '工程约束', title: '降级约束', body: '长文输出受 max_tokens 易截断 → 抬预算 / 分章；复用既有 report-worker 池调度。', accent: C.amber });
  s.render();
}

// ============================================================
// SLIDE 12 — 章节页 03
// ============================================================
divider('03', '五期详解', 'AI 控制台 · 项目启动会 PPT 生成', C.amber);

// ============================================================
// SLIDE 13 — 能力卡片与前置校验
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P5 · 入口与校验 ]', '能力卡片与前置校验');
  const w3 = 2.8, gap = 0.3;
  const cards = [
    ['07', '第 7 张卡', '在 ReportPage 的 reportCards 数组新增"项目启动会 PPT 生成"卡；复用 ReportCard 组件，不新造卡片 / 样式。', C.cyan],
    ['PRE', '前置校验', 'Preflight 聚合查询资料齐备性，缺料时硬阻塞并提示，避免半截生成浪费资源。', C.purple],
    ['UI', '面板互斥', '与既有 6 张卡一致的光晕 / hint 风格与面板开关，保持 AI 控制台整体一致性。', C.amber],
  ];
  cards.forEach((c, i) => card(s, CX + i * (w3 + gap), 1.52, w3, 2.55, { tag: c[0], title: c[1], body: c[2], accent: c[3] }));
  strip(s, '现状', 'AI 控制台已有 6 张卡（计划导入 / 离线周报 / AI 周报 / 需求生成 PRD / 导入计划 / 生成用例）；新卡为第 7 张。', C.cyan);
  s.render();
}

// ============================================================
// SLIDE 14 — 核心生成引擎
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P5 · 核心生成引擎 ]', '核心生成引擎 · 四组件');
  s.addText('新增的是"内容装配器"，不是新的 PPT 引擎', { x: CX, y: 1.32, w: CW, h: 0.28, fontFace: FONT, fontSize: 11.5, italic: true, color: C.muted, margin: 0 });
  const w2 = 4.35, gap = 0.3;
  const cards = [
    ['01', '版式断言层', '质量门禁（Node 移植技能路径纪律）：每个章节先断言版式，不符则重生成，保证成品规范。', C.cyan],
    ['02', 'PPT 装配器', '把 AI 组织的章节装配为原生 .pptx（pptxgenjs + worker 池），不引入 reveal / Slidev / Marp。', C.purple],
    ['03', '时间线绘制', '绘制甘特 / 时间线形状，把项目计划可视化为启动会关键视图。', C.amber],
    ['04', '工作量降级', '超预算时降级保交付：砍非核心章节，保甘特 / 工作量 / 风险 / 沟通主干。', C.green],
  ];
  cards.forEach((c, i) => {
    const x = CX + (i % 2) * (w2 + gap), y = 1.72 + Math.floor(i / 2) * 1.62;
    card(s, x, y, w2, 1.42, { tag: c[0], title: c[1], body: c[2], accent: c[3] });
  });
  s.render();
}

// ============================================================
// SLIDE 15 — SSE 流式
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P5 · 流式与交付 ]', 'SSE 流式生成与交付链路');
  flow(s, [
    { k: 'REQ', t: '卡片触发', d: '用户点击' },
    { k: 'STREAM', t: 'kickoff-ppt-stream', d: 'SSE 事件流', accent: C.purple },
    { k: 'ASSEMBLE', t: '流式装配', d: '章节装帧' },
    { k: 'SAVE', t: 'Buffer 落盘', d: '服务端暂存', accent: C.amber },
    { k: 'DL', t: 'saveBlob 下载', d: '浏览器交付' },
  ], 1.5, 1.4);
  const w3 = 2.8, gap = 0.3;
  card(s, CX, 3.25, w3, 1.55, { tag: '范式', title: 'SSE 复用', body: 'POST /api/plans/kickoff-ppt-stream，事件 stage / chunk / done / error；客户端断开即 abort。', accent: C.cyan });
  card(s, CX + w3 + gap, 3.25, w3, 1.55, { tag: '规格', title: '成品规格', body: '一次点击产出 12~18 页原生 .pptx：甘特、工作量、风险、沟通管理齐全。', accent: C.green });
  card(s, CX + 2 * (w3 + gap), 3.25, w3, 1.55, { tag: '护栏', title: '并发闸', body: '并发闸防流式生成打满资源；命名与下载走服务端 Buffer + Content-Disposition。', accent: C.amber });
  s.render();
}

// ============================================================
// SLIDE 16 — KickoffPptPanel
// ============================================================
{
  const s = baseSlide();
  header(s, '[ P5 · 前端交互 ]', 'KickoffPptPanel 交互');
  // 代码面板
  s.addShape(RRECT, { x: CX, y: 1.55, w: 5.6, h: 3.35, rectRadius: 0.06, fill: { color: C.surface2 }, line: { color: C.border, width: 1 } });
  [0, 1, 2].forEach(i => s.addShape(OVAL, { x: CX + 0.2 + i * 0.22, y: 1.72, w: 0.11, h: 0.11, fill: { color: ['F87171', C.amber, C.green][i] } }));
  const code = [
    [{ t: '// 一次点击，读取五类沉淀资料', c: C.comment }],
    [{ t: 'const sources = [', c: C.code }],
    [{ t: '  "PRD 文档", "需求跟踪矩阵", "项目计划",', c: C.str }],
    [{ t: '  "测试用例", "工作空间分析"', c: C.str }],
    [{ t: '];', c: C.code }],
    [{ t: '', c: C.code }],
    [{ t: '// AI 组织为章节 → 版式断言 → 装配', c: C.comment }],
    [{ t: 'const deck = await assembleKickoff(sources);', c: C.code }],
    [{ t: '', c: C.code }],
    [{ t: '// 产物：可继续编辑的原生 .pptx', c: C.comment }],
    [{ t: '// 含 甘特 / 工作量 / 风险 / 沟通管理', c: C.comment }],
  ];
  code.forEach((line, i) => {
    s.addText(line.map(r => ({ text: r.t, options: { color: r.c } })), {
      x: CX + 0.25, y: 1.95 + i * 0.265, w: 5.15, h: 0.26, fontFace: MONO, fontSize: 10, margin: 0,
    });
  });
  // 右侧价值卡
  const rx = 6.4, rw = 3.1;
  card(s, rx, 1.55, rw, 1.6, { tag: '核心价值', title: '数小时 → 一次点击', body: '把"人工拼装数小时"压缩为"一次点击"，且产物可继续编辑，而非图片死稿。', accent: C.amber });
  card(s, rx, 3.3, rw, 1.6, { tag: '体验', title: '生成过程可见', body: '生成中 glow 光晕、进度实时可见；完成后直接下载 .pptx，无缝衔接既有面板交互。', accent: C.cyan });
  s.render();
}

// ============================================================
// SLIDE 17 — 章节页 04
// ============================================================
divider('04', '实操与收尾', '使用流程 · 成效 · 边界', C.green);

// ============================================================
// SLIDE 18 — 使用流程
// ============================================================
{
  const s = baseSlide();
  header(s, '[ PRACTICE · 使用流程 ]', '一次点击，资料 → 成稿');
  const w3 = 2.8, gap = 0.3;
  const steps = [
    ['STEP 01', '① 选资料', '在 KickoffPptPanel 勾选要纳入的 PRD / 计划 / 用例；Preflight 校验资料齐备性。', C.cyan],
    ['STEP 02', '② 点生成', '点击卡片触发 SSE 流；版式断言保障规范，进度与 glow 光晕实时可见。', C.purple],
    ['STEP 03', '③ 得 .pptx', '下载 12~18 页原生 pptx，可继续编辑；无需任何手工排版。', C.amber],
  ];
  steps.forEach((c, i) => card(s, CX + i * (w3 + gap), 1.55, w3, 2.5, { tag: c[0], title: c[1], body: c[2], accent: c[3] }));
  chips(s, ['选资料', '点生成', '得成稿'], 4.45);
  s.render();
}

// ============================================================
// SLIDE 19 — 对照与成效
// ============================================================
{
  const s = baseSlide();
  header(s, '[ REVIEW · 对照与成效 ]', '能力对照与关键成效');
  const w2 = 4.35, gap = 0.3;
  const cards = [
    ['四期 · 估算', '三点 → 报价', '单点拍脑袋 → 三点法 + 置信区间，逐行可追溯到需求与用例。', C.cyan],
    ['四期 · 测试', '库 + 覆盖 + AI', '结构化用例库、P0~P3 覆盖度、矩阵双向溯源、AI 草稿生成。', C.purple],
    ['五期 · PPT', '资料 → 一键成稿', '沉淀资料一键生成 12~18 页可编辑 .pptx 启动会材料。', C.amber],
    ['成效', '零新依赖 · 复用', '沿用 exceljs / docx / pdfkit / pptxgenjs + worker 池；不改渲染链，维护成本低。', C.green],
  ];
  cards.forEach((c, i) => {
    const x = CX + (i % 2) * (w2 + gap), y = 1.52 + Math.floor(i / 2) * 1.75;
    card(s, x, y, w2, 1.5, { tag: c[0], title: c[1], body: c[2], accent: c[3] });
  });
  s.render();
}

// ============================================================
// SLIDE 20 — 注意事项与边界
// ============================================================
{
  const s = baseSlide();
  header(s, '[ CAUTION · 边界 ]', '注意事项与边界');
  const rows = [
    ['✕', 'F87171', '非目标', '四期不做资源费率管理 / 财务核算 / 跨项目组合（Portfolio）汇总；五期不做新 PPT 引擎，只做内容装配器。'],
    ['↓', C.amber, '降级策略', '长文 AI 输出受 max_tokens 易截断 → 抬预算 / 分章；版式断言层做质量门禁，不符则重生成。'],
    ['!', C.amber, '风险提示', '并发闸防流式生成打满资源；缺料时 Preflight 硬阻塞，需先补齐资料再生成。'],
    ['✓', C.green, '审批状态', '四期 PRD（估算 / 导出 / 测试）已批准 v1.3；五期 PRD（启动会 PPT）草案待审批 v1.0，以 WBS 为权威轨。'],
  ];
  rows.forEach((r, i) => {
    const y = 1.52 + i * 0.87, h = 0.75;
    s.addShape(RRECT, { x: CX, y, w: CW, h, rectRadius: 0.05, fill: { color: C.surface }, line: { color: C.border, width: 0.75 } });
    s.addShape(OVAL, { x: CX + 0.2, y: y + h / 2 - 0.19, w: 0.38, h: 0.38, fill: { color: C.surface2 }, line: { color: r[1], width: 1 } });
    s.addText(r[0], { x: CX + 0.2, y: y + h / 2 - 0.19, w: 0.38, h: 0.38, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 12, bold: true, color: r[1], margin: 0 });
    s.addText(r[2], { x: CX + 0.78, y, w: 1.6, h, valign: 'middle', fontFace: FONT, fontSize: 13, bold: true, color: C.text, margin: 0 });
    s.addText(r[3], { x: CX + 2.5, y, w: CW - 2.75, h, valign: 'middle', fontFace: FONT, fontSize: 9.5, color: C.muted, lineSpacingMultiple: 1.15, margin: 0 });
  });
  s.render();
}

// ============================================================
// SLIDE 21 — 谢谢
// ============================================================
{
  const s = baseSlide();
  s.addShape(RECT, { x: 0, y: 0, w: SLIDE_W, h: 0.07, fill: { color: C.cyan } });
  s.addShape(RECT, { x: 0, y: 0, w: 3.2, h: 0.07, fill: { color: C.purple } });
  s.addText('[ SESSION_END ]', { x: 0, y: 1.5, w: SLIDE_W, h: 0.3, align: 'center', fontFace: MONO, fontSize: 11, bold: true, color: C.cyan, charSpacing: 3, margin: 0 });
  s.addText('谢谢', { x: 0, y: 2.0, w: SLIDE_W, h: 1.1, align: 'center', fontFace: FONT, fontSize: 54, bold: true, color: C.text, margin: 0 });
  s.addText('MTask 团队 · 资料沉淀 → 报价 → 成稿', { x: 0, y: 3.25, w: SLIDE_W, h: 0.4, align: 'center', fontFace: FONT, fontSize: 14, color: C.muted, margin: 0 });
  s.addShape(RECT, { x: CENTER_X - 0.35, y: 3.85, w: 0.7, h: 0.05, fill: { color: C.amber } });
  footer(s);
  s.render();
}

// ============================================================
pres.writeFile({ fileName: OUT }).then(() => {
  console.log('OK ->', OUT, '| slides:', PAGE_NO);
}).catch(e => { console.error('FAIL', e); process.exit(1); });
