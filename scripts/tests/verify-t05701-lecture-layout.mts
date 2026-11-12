/**
 * T05701 门：讲稿卡片「生成文稿」视图布局重构。
 *
 * 现场（任务附图）：底部状态栏是单行 flex 塞 10 个子项，容器一窄所有子项被压成竖排——
 * 「停止 / 从第 3 节继续 / 导出」变窄条、计数文字竖排；默认展开的溯源面板长文本
 * （超预算「截断」说明）被挤成一列橙色长串溢出。
 *
 * 修复：Header 状态行 / Body 溯源行 / Footer 操作行三层 + 不可压缩元素 flexShrink:0
 * + 长文本任意字符换行 + 溯源超高滚动 + 正文卡片防溢出。交互与 data-lck 契约逐字保留。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05701-lecture-layout.mts
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

const SRC = readFileSync(join(ROOT, 'web/src/pages/CodeReviewLecturePanel.tsx'), 'utf8');
const FOOTER = SRC.slice(SRC.indexOf('function LectureStatusFooter'));
const SECTIONS = SRC.slice(SRC.indexOf('function LectureSections'));

// A 组：三层 footer 结构
ok('A-01 footer 改纵向三段布局（不再单行塞 10 项），minWidth:0 防撑破',
  /<footer data-lck="status-bar"[\s\S]{0,240}flexDirection: 'column', gap: 8, minWidth: 0/.test(FOOTER));
ok('A-02 状态行 flexWrap 折行 + 阶段文案任意字符换行 + 进度/计数不压缩',
  /display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0/.test(FOOTER)
  && /flex: '1 1 260px', minWidth: 0[\s\S]{0,160}overflowWrap: 'anywhere'/.test(FOOTER)
  && /width: 150, flexShrink: 0/.test(FOOTER)
  && /whiteSpace: 'nowrap', flexShrink: 0/.test(FOOTER));
ok('A-03 操作行右对齐折行，三个按钮 flexShrink:0 + nowrap（不再竖排窄条）',
  /justifyContent: 'flex-end', minWidth: 0/.test(FOOTER)
  && (FOOTER.match(/flexShrink: 0, whiteSpace: 'nowrap'/g) ?? []).length >= 3
  && /maxWidth: '100%', flexShrink: 1/.test(FOOTER));
ok('A-04 溯源独占整行：flexBasis 100% + 任意字符换行 + 超高滚动（长「截断」说明不撑破）',
  /data-lck="provenance-wrap"[\s\S]{0,260}flexBasis: '100%'[\s\S]{0,260}overflowWrap: 'anywhere', wordBreak: 'break-word', maxHeight: 220, overflowY: 'auto'/.test(FOOTER));

// B 组：正文卡片防溢出（长文本/代码片段/Unicode）
ok('B-01 八段卡片 minWidth/maxWidth 约束 + 标题任意字符换行',
  /data-lck=\{`section-\$\{r\.key\}`\}[\s\S]{0,180}minWidth: 0, maxWidth: '100%'/.test(SECTIONS)
  && /<strong style=\{\{ minWidth: 0, overflowWrap: 'anywhere' \}\}/.test(SECTIONS));
ok('B-02 展开正文任意字符换行 + 行高 1.7（阅读舒适度）',
  /overflowWrap: 'anywhere', lineHeight: 1\.7/.test(SECTIONS));

// C 组：交互与既有回归契约逐字保留
ok('C-01 所有 data-lck 与按钮仍在 status-bar 内（t02872 门按 [data-lck="status-bar"] button 定位停止按钮）',
  ['stage', 'anchor-count', 'mark-count', 'resume-btn', 'export-format', 'export-btn', 'provenance-wrap']
    .every((k) => FOOTER.includes(`data-lck="${k}"`))
  && /onClick=\{onStop\}/.test(FOOTER) && /onClick=\{onExport\}/.test(FOOTER));
ok('C-02 溯源组件参数与流式开关不变（!streaming 才渲染，cardKey/projectId/refreshKey 原样）',
  /\{!streaming && \(/.test(FOOTER)
  && /cardKey="ai\.code_review_lecture" projectId=\{provenanceProjectId\} refreshKey=\{result\?\.title \?\? ''\}/.test(FOOTER));
ok('C-03 文稿数据与交互回调未动（SectionBody 参数逐字保留）',
  /<SectionBody row=\{r\} markable=\{markable\} marks=\{marks\} onMark=\{onMark\} onAnchorClick=\{onAnchorClick\} \/>/.test(SECTIONS));

const body = [`T05701 讲稿布局门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05701-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05701-gate-results.txt')}`);
