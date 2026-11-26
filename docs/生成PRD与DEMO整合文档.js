/* 生成 PRD + DEMO 整合单文档（离线可开，无外部依赖） */
const fs = require('fs');
const path = require('path');

const DOCS = 'D:\\code\\otherProjects\\MTask\\docs';
const prdMd = fs.readFileSync(path.join(DOCS, 'PRD-测试菜单模块-T06393.md'), 'utf8');
const demoHtml = fs.readFileSync(path.join(DOCS, '测试菜单模块-DEMO.html'), 'utf8');

/* ---------- lightweight markdown renderer ---------- */
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  let out = esc(s);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (m, c) => { codes.push('<code>' + c + '</code>'); return '\u0000' + (codes.length - 1) + '\u0000'; });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[+i]);
  return out;
}
function splitRow(line) {
  const cells = []; let cur = ''; let inCode = false;
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
function renderMd(md) {
  const lines = md.split(/\r?\n/);
  const html = []; const toc = [];
  let i = 0, hId = 0;
  let listStack = []; // {indent, tag}
  const closeLists = (toIndent) => {
    while (listStack.length && listStack[listStack.length - 1].indent >= toIndent) {
      html.push('</' + listStack.pop().tag + '>');
    }
  };
  const closeAllLists = () => closeLists(0);
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      closeAllLists();
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      html.push('<div class="codeblock">' + (lang ? '<div class="code-lang">' + esc(lang) + (lang === 'mermaid' ? ' · 流程图源码（按代码展示）' : '') + '</div>' : '') + '<pre><code>' + esc(buf.join('\n')) + '</code></pre></div>');
      continue;
    }
    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeAllLists();
      const level = h[1].length; const id = 'sec-' + (hId++);
      if (level <= 3) toc.push({ id, level, text: h[2].replace(/`/g, '') });
      html.push('<h' + level + ' id="' + id + '">' + inline(h[2]) + '</h' + level + '>');
      i++; continue;
    }
    // hr
    if (/^---+\s*$/.test(line)) { closeAllLists(); html.push('<hr/>'); i++; continue; }
    // table
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      closeAllLists();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      html.push('<div class="table-wrap"><table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    // blockquote
    if (/^>\s?/.test(line)) {
      closeAllLists();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      html.push('<blockquote>' + buf.map(inline).join('<br/>') + '</blockquote>');
      continue;
    }
    // list
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const indent = Math.floor(li[1].length / 2);
      const tag = /^\d+\./.test(li[2]) ? 'ol' : 'ul';
      while (listStack.length && listStack[listStack.length - 1].indent > indent) html.push('</' + listStack.pop().tag + '>');
      if (!listStack.length || listStack[listStack.length - 1].indent < indent) {
        html.push('<' + tag + '>'); listStack.push({ indent, tag });
      } else if (listStack[listStack.length - 1].tag !== tag) {
        html.push('</' + listStack.pop().tag + '>'); html.push('<' + tag + '>'); listStack.push({ indent, tag });
      }
      html.push('<li>' + inline(li[3]) + '</li>');
      i++; continue;
    }
    // blank
    if (/^\s*$/.test(line)) { closeAllLists(); i++; continue; }
    // paragraph
    closeAllLists();
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|```|\||>\s?|---+\s*$|\s*([-*]|\d+\.)\s)/.test(lines[i])) { buf.push(lines[i]); i++; }
    html.push('<p>' + buf.map(inline).join('<br/>') + '</p>');
  }
  closeAllLists();
  return { html: html.join('\n'), toc };
}

function extractSection(md, startRe, endRe) {
  const lines = md.split(/\r?\n/);
  let s = -1, e = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (s < 0 && startRe.test(lines[i])) { s = i; continue; }
    if (s >= 0 && endRe.test(lines[i])) { e = i; break; }
  }
  return s < 0 ? '' : lines.slice(s, e).join('\n');
}

const prdRendered = renderMd(prdMd);
const linkageMd = extractSection(prdMd, /^### 4\.13 /, /^## 5\. /);
const acMd = extractSection(prdMd, /^## 8\. 验收标准/, /^## 9\. /);
const constraintsMd = extractSection(prdMd, /^### 9\.5 /, /^## 10\. /);
const linkageRendered = renderMd(linkageMd);
const acRendered = renderMd(acMd);
const constraintsRendered = renderMd(constraintsMd);

const tocHtml = prdRendered.toc.map(t => '<a class="toc-l' + t.level + '" href="#' + t.id + '" data-target="' + t.id + '">' + esc(t.text) + '</a>').join('');

const prdB64 = Buffer.from(prdMd, 'utf8').toString('base64');
const demoB64 = Buffer.from(demoHtml, 'utf8').toString('base64');

const guardrails = `
<div class="guard-grid">
  <div class="guard"><b>① 单源口径，禁止前端自算</b><p>作用域解析只走 <code>TestScopeService.resolveScope()</code>；KPI 全部服务端计算（§4.5.3）；可见性单源 <code>history_at IS NULL AND archived=0</code>；去重键 <code>sha1(normalize(node_code)+'|'+granularity+'|'+target_project_id)</code>，不含 map_scope（§4.4.4）。</p></div>
  <div class="guard"><b>② P0 / P1 / P2 边界不可越</b><p>P0 产品维度只读聚合预览，所有 <code>dimension=product</code> 写接口返回 <code>TEST_409_SCOPE_READONLY</code>（§6.5）；产品地图 rollup 发布、产品级草稿、变体抽屉 = P1；人工校正 = P2。DEMO 中产品发布按钮是 P1 超前演示，不是 P0 验收项。</p></div>
  <div class="guard"><b>③ 事件发射点唯一、事务后发射</b><p><code>test:maps / drafts / runs / issues / archive</code> 只在 §4.13.2 指定收口发射，禁止事务内发；任务 done/归档/删除释放 dedupe 必须发 <code>test:drafts</code>；测试四页 + 顶栏 scope 下拉订阅 <code>test:archive</code> / <code>projects</code> 自动刷新。</p></div>
  <div class="guard"><b>④ 深链契约与持久化分离</b><p>跨模块跳转统一带 <code>dimension/projectId/productKey</code> + 页面参数；非法/失效回落全部项目只读 + toast，不白屏；深链只覆盖本次会话，不写回 <code>mtask.activeScope.v1</code>，仅手动切换持久化（§4.11.1 / §4.13.3）。</p></div>
  <div class="guard"><b>⑤ 生命周期与 purge 级联</b><p>批次状态 active→snapshotted→archived→purged；purge 仅删测试表 + meta/dedupe + 移除「测试」tag，产品地图置 <code>stale + is_active=0</code> 隔离且任何读取不得返回；审计只追加 <code>test.batch.purge</code>；任务详情测试区块降级为「测试资产已删除」占位（§4.12 / §4.13 L-03）。</p></div>
  <div class="guard"><b>⑥ 会话与 run 终态解耦</b><p>AI 控制台终止会话不改 run 终态；租约到期由 <code>TestRunService</code> 回收；立即停止走测试侧 <code>abort</code>；监控页「会话失联」黄条（§4.13 L-08）。run 失败不改任务业务状态，health / quality_gate 独立（§4.8）。</p></div>
</div>
<h3>DEMO ↔ PRD ↔ AC 对照表（开发逐项验收）</h3>
<div class="table-wrap"><table><thead><tr><th>DEMO 交互</th><th>PRD 落点</th><th>验收</th><th>阶段</th></tr></thead><tbody>
<tr><td>顶栏「项目 / 产品」互斥切换 + 作用域下拉</td><td>§4.11.1 / §4.13 L-01</td><td>AC-34 / AC-42</td><td>P0</td></tr>
<tr><td>产品维度只读预览（89% / 282 节点 / P1 超前演示条）</td><td>§4.11.2~4.11.4 / §6.5</td><td>AC-36</td><td>P0 只读</td></tr>
<tr><td>产品地图 rollup 重建 → 发布（active 1/4）</td><td>§4.11.2 / §4.3.3</td><td>AC-37</td><td>P1</td></tr>
<tr><td>草稿去重 / skipped 占用 / 确认事务</td><td>§4.4.4 / §4.4.7</td><td>AC-35 / AC-42①</td><td>P0</td></tr>
<tr><td>历史资产沉淀（3 卡）与恢复（→2 卡）</td><td>§4.12.2 / §4.12.3</td><td>AC-38 / AC-39 / AC-42③</td><td>P0</td></tr>
<tr><td>归档第 8 sheet「测试资产」8 tabs / 11 列</td><td>§4.12.5</td><td>AC-40</td><td>P0</td></tr>
<tr><td>彻底删除影响预览 6 项 → 已删除 + 审计筛选</td><td>§4.12.6 / §4.12.7</td><td>AC-41 / AC-42②</td><td>P0</td></tr>
<tr><td>全部项目 / 全部产品只读 + TEST_409_SCOPE_READONLY</td><td>§4.11.4 / §6.5</td><td>AC-36</td><td>P0</td></tr>
<tr><td>深链优先 / 非法回落 / 不写回持久化</td><td>§4.11.1 / §4.13.3</td><td>AC-29 / AC-30</td><td>P0</td></tr>
<tr><td>非测试页签自动回项目维度</td><td>§4.11.5</td><td>AC-34</td><td>P0</td></tr>
<tr><td>全局搜索排除沉淀项目实体</td><td>§4.13 L-09</td><td>AC-42④</td><td>P0</td></tr>
</tbody></table></div>
<h3>实现期防御项（评审残留，随 P0 落实）</h3>
<ul>
<li><strong>R-06</strong>：批次外键避免 <code>ON DELETE CASCADE</code> 造成审计断链，建议 RESTRICT / 墓碑。</li>
<li><strong>R-07</strong>：<code>/history/restore</code> 对 <code>archived=1</code> 批次返回 409 <code>TEST_409_BATCH_ARCHIVED</code>。</li>
<li><strong>R-08~R-10</strong>：归档 sheet 命名歧义、product_key 显示名、零资产批次噪音，按评审报告 §12.3 处理。</li>
</ul>`;

const shell = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MTask 测试菜单模块 · PRD + DEMO 整合文档（T06393 · v1.2.2）</title>
<style>
:root{--blue:#2563eb;--blue-soft:#eff6ff;--blue-line:#bfdbfe;--text:#0f172a;--text-2:#334155;--muted:#64748b;--border:#e2e8f0;--surface:#f8fafc;--green:#16a34a;--amber:#d97706;--ease:cubic-bezier(.22,.8,.36,1)}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--text);background:#fff;font-size:14px;line-height:1.75}
.topbar{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:12px 28px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.topbar .logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:16px;flex:none}
.topbar h1{font-size:16px;font-weight:700}
.topbar .sub{font-size:11.5px;color:var(--muted)}
.badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--blue-soft);color:var(--blue);border:1px solid var(--blue-line)}
.badge.green{background:#f0fdf4;color:var(--green);border-color:#bbf7d0}
.tabs{display:flex;gap:6px;margin-left:auto}
.tabs button{border:1px solid var(--border);background:#fff;border-radius:9px;padding:7px 16px;font-size:13px;font-weight:600;color:var(--text-2);cursor:pointer;transition:all .18s var(--ease)}
.tabs button:hover{border-color:var(--blue-line);color:var(--blue)}
.tabs button.active{background:var(--blue);border-color:var(--blue);color:#fff;box-shadow:0 4px 14px rgba(37,99,235,.3)}
.pane{display:none}
.pane.active{display:block;animation:paneIn .3s var(--ease)}
@keyframes paneIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
/* PRD layout */
.doc-layout{display:flex;max-width:1440px;margin:0 auto}
.toc{width:280px;flex:none;position:sticky;top:61px;height:calc(100vh - 61px);overflow-y:auto;padding:20px 14px 40px 24px;border-right:1px solid var(--border);font-size:12.5px}
.toc .toc-title{font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.08em;margin-bottom:10px}
.toc a{display:block;color:var(--text-2);text-decoration:none;padding:3px 8px;border-radius:6px;border-left:2px solid transparent;transition:all .15s}
.toc a:hover{background:var(--blue-soft);color:var(--blue)}
.toc a.on{background:var(--blue-soft);color:var(--blue);border-left-color:var(--blue);font-weight:600}
.toc-l2{font-weight:600;margin-top:6px}
.toc-l3{padding-left:18px !important;color:var(--muted)}
.doc{flex:1;min-width:0;padding:32px 48px 90px}
.doc h1{font-size:26px;line-height:1.4;margin:8px 0 18px;padding-bottom:14px;border-bottom:2px solid var(--blue)}
.doc h2{font-size:20px;margin:44px 0 14px;padding:8px 0 8px 14px;border-left:4px solid var(--blue);background:linear-gradient(90deg,var(--blue-soft),transparent);border-radius:0 8px 8px 0}
.doc h3{font-size:16.5px;margin:30px 0 10px;color:var(--text)}
.doc h4{font-size:14.5px;margin:22px 0 8px;color:var(--text-2)}
.doc p{margin:8px 0}
.doc ul,.doc ol{margin:8px 0 8px 24px}
.doc li{margin:4px 0}
.doc blockquote{margin:12px 0;padding:10px 16px;background:var(--blue-soft);border-left:3px solid var(--blue);border-radius:0 8px 8px 0;color:var(--text-2);font-size:13px}
.doc hr{border:none;border-top:1px solid var(--border);margin:28px 0}
.doc code{font-family:ui-monospace,Consolas,Menlo,monospace;font-size:12px;background:var(--surface);border:1px solid var(--border);padding:1px 5px;border-radius:5px;color:#1e40af}
.doc a{color:var(--blue)}
.codeblock{margin:12px 0;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.code-lang{font-size:10.5px;font-weight:700;color:var(--muted);background:var(--surface);padding:5px 12px;border-bottom:1px solid var(--border);letter-spacing:.05em}
.codeblock pre{padding:14px 16px;overflow-x:auto;background:#fbfcfe}
.codeblock code{background:none;border:none;padding:0;font-size:12px;line-height:1.6;color:var(--text-2);white-space:pre}
.table-wrap{overflow-x:auto;margin:12px 0;border:1px solid var(--border);border-radius:10px}
.table-wrap table{border-collapse:collapse;width:100%;font-size:12.8px}
.table-wrap th{background:var(--surface);text-align:left;font-weight:700;color:var(--text-2);padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
.table-wrap td{padding:8px 12px;border-bottom:1px solid #eef2f7;vertical-align:top}
.table-wrap tr:last-child td{border-bottom:none}
.table-wrap tbody tr{transition:background .15s}
.table-wrap tbody tr:hover td{background:#fafbff}
/* demo pane */
.demo-pane{height:calc(100vh - 61px)}
.demo-pane iframe{width:100%;height:100%;border:none;display:block;background:#fff}
.demo-note{position:absolute;right:18px;bottom:14px;z-index:5;font-size:11px;color:var(--muted);background:rgba(255,255,255,.9);border:1px solid var(--border);border-radius:8px;padding:5px 10px}
/* linkage pane */
.link-doc{max-width:1180px;margin:0 auto;padding:32px 40px 90px}
.link-doc h2{font-size:20px;margin:36px 0 12px;padding:8px 0 8px 14px;border-left:4px solid var(--blue);background:linear-gradient(90deg,var(--blue-soft),transparent);border-radius:0 8px 8px 0}
.link-doc h3{font-size:16px;margin:26px 0 10px}
.link-doc h4{font-size:14px;margin:18px 0 8px;color:var(--text-2)}
.link-doc p{margin:8px 0}
.link-doc ul,.link-doc ol{margin:8px 0 8px 24px}
.link-doc li{margin:4px 0}
.link-doc code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--surface);border:1px solid var(--border);padding:1px 5px;border-radius:5px;color:#1e40af}
.link-doc blockquote{margin:12px 0;padding:10px 16px;background:var(--blue-soft);border-left:3px solid var(--blue);border-radius:0 8px 8px 0;font-size:13px}
.link-doc hr{border:none;border-top:1px solid var(--border);margin:24px 0}
.link-intro{background:linear-gradient(135deg,var(--blue-soft),#fff);border:1px solid var(--blue-line);border-radius:14px;padding:18px 22px;margin-bottom:8px}
.link-intro b{color:var(--blue)}
.guard-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin:16px 0}
.guard{border:1px solid var(--border);border-radius:12px;padding:14px 16px;background:#fff;transition:all .2s var(--ease)}
.guard:hover{border-color:var(--blue-line);box-shadow:0 8px 22px rgba(16,24,40,.07);transform:translateY(-2px)}
.guard b{display:block;font-size:13.5px;color:var(--blue);margin-bottom:6px}
.guard p{font-size:12.5px;color:var(--text-2);margin:0}
@media (max-width:960px){.toc{display:none}.doc{padding:24px 20px 70px}.guard-grid{grid-template-columns:1fr}.link-doc{padding:24px 18px 70px}}
@media print{.topbar,.toc,.demo-pane{display:none}.pane{display:block}.doc{padding:0}}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">M</div>
  <div><h1>MTask「测试」菜单模块 · PRD + DEMO 整合文档</h1><div class="sub">T06393 · 2026-11-26 · 开发唯一对照基线：PRD 全文 + 可交互 DEMO + 联动契约，三者同文件、同版本，避免偏离</div></div>
  <span class="badge">v1.2.2</span><span class="badge green">复审通过 · 冻结 P0</span>
  <div class="tabs">
    <button class="active" data-pane="prd">PRD 全文</button>
    <button data-pane="demo">交互 DEMO</button>
    <button data-pane="link">联动契约 · 开发基线</button>
  </div>
</div>

<div class="pane active" id="pane-prd">
  <div class="doc-layout">
    <nav class="toc"><div class="toc-title">目录 · 点击跳转</div>${tocHtml}</nav>
    <article class="doc" id="prdDoc">${prdRendered.html}</article>
  </div>
</div>

<div class="pane" id="pane-demo" style="position:relative">
  <div class="demo-pane"><iframe id="demoFrame" title="测试菜单模块交互 DEMO v1.2.2"></iframe></div>
  <div class="demo-note">内嵌 DEMO v1.2.2 · 数据为模拟 · 独立文件：<a href="测试菜单模块-DEMO.html" target="_blank">测试菜单模块-DEMO.html</a></div>
</div>

<div class="pane" id="pane-link">
  <div class="link-doc">
    <div class="link-intro"><b>开发防偏离六条硬约束</b> —— 以下每条都对应 PRD 章节与 AC，实现与评审逐项核对；DEMO 只作交互基线，功能验收以服务端 / MCP 联调为准。</div>
    ${guardrails}
    <h2>§4.13 跨模块联动契约（PRD 原文）</h2>
    ${linkageRendered.html}
    <h2>§9.5 关键实现约束（PRD 原文）</h2>
    ${constraintsRendered.html}
    <h2>§8 验收标准（AC-01 ~ AC-42，PRD 原文）</h2>
    ${acRendered.html}
  </div>
</div>

<script id="prdSource" type="text/plain">${prdB64}</script>
<script id="demoSource" type="text/plain">${demoB64}</script>
<script>
(function(){
  var tabs = document.querySelectorAll('.tabs button');
  var demoLoaded = false;
  function b64ToText(b64){
    var bin = atob(b64.replace(/\\s/g,''));
    var bytes = new Uint8Array(bin.length);
    for (var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function activate(name){
    tabs.forEach(function(b){ b.classList.toggle('active', b.dataset.pane===name); });
    document.querySelectorAll('.pane').forEach(function(p){ p.classList.toggle('active', p.id==='pane-'+name); });
    if (name==='demo' && !demoLoaded) {
      demoLoaded = true;
      var frame = document.getElementById('demoFrame');
      frame.srcdoc = b64ToText(document.getElementById('demoSource').textContent);
    }
    if (name!=='demo') window.scrollTo(0,0);
  }
  tabs.forEach(function(b){ b.addEventListener('click', function(){ activate(b.dataset.pane); }); });
  // TOC active highlight + smooth scroll within PRD pane
  var tocLinks = document.querySelectorAll('.toc a');
  tocLinks.forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault();
      var el = document.getElementById(a.dataset.target);
      if (el) el.scrollIntoView({behavior:'smooth', block:'start'});
    });
  });
  var heads = Array.prototype.slice.call(document.querySelectorAll('#prdDoc h2, #prdDoc h3'));
  var ticking = false;
  window.addEventListener('scroll', function(){
    if (ticking) return; ticking = true;
    requestAnimationFrame(function(){
      ticking = false;
      if (!document.getElementById('pane-prd').classList.contains('active')) return;
      var y = window.scrollY + 90, current = null;
      for (var i=0;i<heads.length;i++){ if (heads[i].offsetTop <= y) current = heads[i].id; else break; }
      tocLinks.forEach(function(a){ a.classList.toggle('on', a.dataset.target===current); });
    });
  }, {passive:true});
})();
</script>
</body>
</html>`;

const outPath = path.join(DOCS, '测试菜单模块-PRD与DEMO-T06393.html');
fs.writeFileSync(outPath, shell, 'utf8');
console.log('written', outPath, (fs.statSync(outPath).size / 1024).toFixed(0) + 'KB');
console.log('toc entries:', prdRendered.toc.length, '| linkage section chars:', linkageMd.length, '| ac chars:', acMd.length, '| constraints chars:', constraintsMd.length);