/*
 * T05437 门（源码锚）：需求跟踪矩阵「关联PRD / 关联SDD」列单行截断 + 悬浮全文。
 *
 * 根因：按钮是 inline-flex，内部 span 只写了 `overflow:hidden/textOverflow:ellipsis`，
 * 但 flex 子项默认 `min-width:auto` 不收缩 → 省略号不生效，长文件名把单元格撑宽并换行，
 * 单条记录高度被抬高。修复：按钮与 span 都补 `minWidth:0`、td 固定列宽 + nowrap，
 * 悬浮用原生 title 给完整文件名（零新依赖）。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify/T05437-matrix-doc-cell-gate.mts
 * 无需后端、无需浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass += 1; console.log(`[PASS] ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name} :: ${detail}`); }
};
const src = fs.readFileSync(path.join(ROOT, 'web/src/pages/MatrixTable.tsx'), 'utf8');
// 注意：签名里有 `}: {`（`}` 在行首），用 `\n}\n` 才不会把类型块误当成函数体结束
const docCell = (src.match(/function DocCell\([\s\S]*?\n\}\n/) ?? [''])[0];
console.log('—— A 组 · 单行截断实现 ——');
ok('A-01 文档列固定列宽且强制单行（td width/maxWidth + nowrap，两列各一处）',
  (src.match(/'4px 6px', width: 168, maxWidth: 168, whiteSpace: 'nowrap'/g) ?? []).length === 2);
ok('A-02 按钮自身可收缩（inline-flex + minWidth:0 + maxWidth:100%）',
  /display: 'inline-flex'[\s\S]{0,400}maxWidth: '100%', minWidth: 0/.test(docCell));
ok('A-03 文件名 span 三件套 + flex 收缩（省略号才会真的出现）',
  /flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'/.test(docCell));
ok('A-04 图标不参与收缩（flexShrink:0，避免被压扁）', /flexShrink: 0/.test(docCell));

console.log('—— B 组 · 悬浮全文与可访问性 ——');
ok('B-01 title 用模板插值给出完整文件名（不是截断后的值）',
  /title=\{`\$\{head\}：\$\{doc\.filename\}\$\{titleDetail \?\? ''\}`\}/.test(docCell));
ok('B-02 PRD 列保留「定位到章节」提示（titleDetail 由调用方传入）',
  /titleDetail=\{\`（定位到「\$\{r\.title\}」章节）\`\}/.test(src));
ok('B-03 aria-label 仍然带完整文件名（读屏可达）',
  /aria-label=\{`打开关联 \$\{label\} \$\{doc\.filename\}`\}/.test(docCell));
ok('B-04 无文档时仍渲染占位「—」（空态不变）',
  /if \(!doc\) return <span style=\{\{ color: 'var\(--text-muted\)' \}\}>—<\/span>/.test(docCell));

console.log('—— C 组 · 改动范围 ——');
ok('C-01 两列共用同一个 DocCell（单实现，不会两套口径）',
  /<DocCell doc=\{r\.prdDoc\} kind="prd"/.test(src) && /<DocCell doc=\{r\.sddDoc\} kind="sdd"/.test(src));
ok('C-02 DocCell 定义在模块级（不是组件内新建函数，避免每次渲染重挂载）',
  /^function DocCell\(/m.test(src) && !/  function DocCell\(/.test(src));
ok('C-03 只动这两列：关联计划/关联待办仍是无固定宽、无 nowrap 的旧写法',
  (src.match(/<td style=\{\{ padding: '4px 6px', maxWidth: 200 \}\}>/g) ?? []).length === 2);
ok('C-04 表头与其他字段未被改动（关联SDD 表头 title 仍在）',
  /title="主 PRD 显式关联的方案设计文档（SDD）；点击查看原文"/.test(src));
ok('C-05 未引入第三方 tooltip/表格依赖（零新依赖）',
  !/from '(@radix-ui|react-tooltip|rc-tooltip|@tanstack)/.test(src));

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exitCode = 1;
