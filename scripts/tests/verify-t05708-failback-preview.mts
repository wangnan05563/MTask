/**
 * T05708 门：任务列表「验证失败反馈」区截图点击无法放大。
 *
 * 现场（任务附图）：反馈窗内「反馈截图（N）— 点击放大」缩略图，点击后无反应。
 *
 * 根因：反馈截图缩略图 onClick={() => setPreviewId(img.id)} 设置了 previewId，
 * 但大图预览唯一挂载点在 renderDescSection 内，且条件含 descExpanded[t.id]
 * （要求展开任务描述板块）。用户只打开反馈窗、未展开描述区时点击缩略图：
 * 大图既不渲染（描述区收起）也渲染在反馈窗之外（描述区），表现为「点击无法放大」。
 *
 * 修复：引入 previewSrc（'desc' | 'failback'）来源标记，大图跟随点击位置原位渲染——
 * 描述区点击 → previewSrc='desc' 在描述板块下方渲染；
 * 反馈窗点击 → previewSrc='failback' 在反馈窗内原位渲染（flushLeft 不叠加 32 缩进）。
 * 两挂载点互斥，不双渲染。点击同图 toggle 收起语义与描述区一致。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05708-failback-preview.mts
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

const SRC = readFileSync(join(ROOT, 'web/src/pages/TasksPage.tsx'), 'utf8');

// 反馈窗内截图缩略图行（4151 区）：label 文案 + 缩略图容器 + 下方原位预览挂载
// 锚点用「反馈截图（{t.images.length}」唯一 token 起、「function renderTaskResult(」函数定义止（fromIndex 限定起点的首个）
const FB_START = SRC.indexOf('反馈截图（{t.images.length}');
const FB = SRC.slice(FB_START, SRC.indexOf('function renderTaskResult(', FB_START));

// 描述区大图挂载条件行 + 描述区缩略图点击
const DESC_PREVIEW = SRC.slice(SRC.indexOf('function renderDescSection'), SRC.indexOf('function renderTaskItem'));
const DESC_THUMB = SRC.slice(SRC.indexOf('renderTaskDescView'), SRC.indexOf('/** 大图预览'));

// A 组：来源标记 state 已引入
ok('A-01 引入 previewSrc 来源标记 state（desc/failback 互斥，防双渲染）',
  /const \[previewSrc, setPreviewSrc\] = useState<'desc' \| 'failback'>\(/.test(SRC));

// B 组：反馈窗内缩略图点击 toggle + 置 failback 来源
ok('B-01 反馈缩略图点击 toggle 收起语义（同图再点收起）',
  /onClick=\{\(\) => \{ setPreviewId\(previewId === img\.id \? '' : img\.id\); setPreviewSrc\('failback'\); \}\}/.test(FB));
ok('B-02 反馈缩略图 hover/选中态边框高亮（与描述区一致，反馈可感知放大态）',
  /border: previewId === img\.id \? '2px solid var\(--accent\)' : '1px solid var\(--border\)'/.test(FB));

// C 组：反馈窗内原位渲染大图预览（flushLeft 不叠加 32 缩进）
ok('C-01 反馈窗内挂载大图预览且要求 previewSrc===\'failback\'',
  /previewId && previewSrc === 'failback' && t\.images\.some\(\(i\) => i\.id === previewId\) && renderTaskPreview\(t, \{ flushLeft: true \}\)/.test(FB));

// D 组：描述区视觉不变——来源条件 + 缩略图点击置 desc + renderTaskPreview 支持 flushLeft
ok('D-01 描述区预览条件收敛到 previewSrc===\'desc\'（与反馈窗互斥，避免双渲染）',
  /previewId && previewSrc === 'desc' && descExpanded\[t\.id\] && t\.images\.some\(\(i\) => i\.id === previewId\) && renderTaskPreview\(t\)/.test(DESC_PREVIEW));
ok('D-02 描述区缩略图点击置 previewSrc=\'desc\'（既有放大/收起行为保留）',
  /setPreviewId\(previewId === img\.id \? '' : img\.id\); setPreviewSrc\('desc'\);/.test(DESC_THUMB));
ok('D-03 renderTaskPreview 支持 flushLeft 参数（反馈窗内不叠加卡片级 32 缩进）',
  /function renderTaskPreview\(t: Task, opts\?: \{ flushLeft\?: boolean \}\)[\s\S]{0,120}marginLeft: opts\?\.flushLeft \? 0 : 32/.test(SRC));

mkdirSync(OUT_DIR, { recursive: true });
const summary = `T05708 门：${pass} 通过 / ${fail} 失败`;
lines.push('');
lines.push(summary);
writeFileSync(join(OUT_DIR, 't05708-gate-results.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
process.exit(fail === 0 ? 0 : 1);
