/**
 * T05678 门：启动会稿截图插槽（上传换令牌 → 生成只传短 token → PPTX/HTML 同时落图）。
 *
 * 为什么不让图片随 SSE 请求走：图片 base64 少则几百 KB、多则数 MB，塞进生成请求会把
 * 流式端点变成大对象上传口（超时/重试/断连回收全要重做）。所以拆成两段：
 *   1) `POST /plans/kickoff-image`：dataURL → 魔数校验 → 落 6h TTL 令牌；
 *   2) 生成请求只带 `imageTokens[]`（UUID），服务层读回、按魔数再验一次。
 *
 * 判据：
 *   A 组 行为——带图构建的 PPTX 里确有 `ppt/media/image*` 与 PNG 签名；无图时输出占位说明并 warning；
 *        HTML 模型的 image 页是 `image` 块（dataURL 内联）而非空页；版式枚举与 HTML 支持表都含 image。
 *   B 组 源码锚——上传端点的类型/大小/魔数三重校验；服务层只认魔数且最多 2 张；前端有上传入口与前置校验。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05678-image-slot.mts
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

const S = await import('../../server/src/services/kickoffService.ts');
const B = await import('../../server/src/services/kickoffBuilder.ts');
const H = await import('../../server/src/services/kickoffHtml.ts');
const D = await import('../../server/src/services/deckHtml.ts');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const baseBundle = {
  project: { id: 'p1', name: 'BEMP11月迭代', workspacePath: '' },
  prdDocs: [], prdDoc: null, prdExcerpt: '', prdTruncated: false,
  requirements: [], plans: [], milestones: [], risks: [], assignees: [],
  coverage: { caseTotal: 0, total: 0, covered: 0, uncovered: 0, rate: 0 },
  workload: {
    noData: true, counted: 0, manDays: { expected: 0, optimistic: null, pessimistic: null },
    manMonth: 0, quote: null, footer: '口径：工期推导', manDaysPerManMonth: 21.75,
    phases: [], complexity: [], source: 'duration',
  },
  preflight: { projectId: 'p1', projectName: 'BEMP11月迭代', items: [], blocked: false, missingHard: [], workloadSource: 'duration' },
  dataAsOf: '2026-11-12',
};
const outline = [
  { section: '封面', title: 'BEMP11月迭代启动会', bullets: [], dataKeys: [], layout: 'cover' },
  { section: '背景', title: '系统现状与本期目标', bullets: [], dataKeys: [], layout: 'image' },
  { section: '致谢', title: '谢谢', bullets: [], dataKeys: [], layout: 'thanks' },
] as never;

ok('A-01 大纲版式枚举含 image（schema 不会把图片页打死）',
  (S.KICKOFF_LAYOUTS as readonly string[]).includes('image'), S.KICKOFF_LAYOUTS);
ok('A-02 HTML 支持表含 image 与 cards（两套产物不各认一套版式）',
  (D.HTML_LAYOUT_SUPPORT as readonly string[]).includes('image')
  && (D.HTML_LAYOUT_SUPPORT as readonly string[]).includes('cards'), D.HTML_LAYOUT_SUPPORT);

const withImg = await B.buildKickoffPpt(
  { ...baseBundle, images: [{ mime: 'image/png', base64: PNG }] } as never, outline);
ok('A-03 带图构建：3 页、warnings 为空、PPTX 内出现 ppt/media/image 与 PNG 签名',
  withImg.pageCount === 3 && withImg.warnings.length === 0
  && withImg.buffer.includes(Buffer.from('ppt/media/image'))
  && withImg.buffer.includes(PNG_SIG),
  { pages: withImg.pageCount, warnings: withImg.warnings, bytes: withImg.buffer.length });

const noImg = await B.buildKickoffPpt({ ...baseBundle, images: [] } as never, outline);
ok('A-04 无图时输出占位说明并点名页码（不静默出一页空白）',
  noImg.warnings.some((w: string) => /第 2 页是图片页但未上传图片/.test(w))
  && !noImg.buffer.includes(PNG_SIG), noImg.warnings);

const modelWith = H.buildKickoffDeckModel(
  { ...baseBundle, images: [{ mime: 'image/png', base64: PNG }] } as never, outline as never);
const imgPage = modelWith.pages.find((p: { layout: string }) => p.layout === 'image')!;
ok('A-05 HTML 图片页是 image 块且内联 dataURL（离线可看）',
  imgPage.blocks.length === 1 && imgPage.blocks[0].type === 'image'
  && (imgPage.blocks[0] as { src: string }).src.startsWith('data:image/png;base64,'),
  imgPage.blocks);

const modelNo = H.buildKickoffDeckModel({ ...baseBundle, images: [] } as never, outline as never);
const noImgPage = modelNo.pages.find((p: { layout: string }) => p.layout === 'image')!;
ok('A-06 HTML 无图时降级为 note 占位（与 PPTX 同口径）',
  noImgPage.blocks.length === 1 && noImgPage.blocks[0].type === 'note', noImgPage.blocks);

// B 组：源码锚
const ROUTE = readFileSync(join(ROOT, 'server/src/routes/plans.ts'), 'utf8');
const SVC = readFileSync(join(ROOT, 'server/src/services/kickoffService.ts'), 'utf8');
const PANEL = readFileSync(join(ROOT, 'web/src/pages/KickoffPptPanel.tsx'), 'utf8');

ok('B-01 上传端点三重校验：dataURL 类型、3MB 上限、魔数（扩展名不作数）',
  /planApi\.post\('\/kickoff-image'/.test(ROUTE)
  && /\^data:\(image\\\/\(\?:png\|jpeg\)\);base64,/.test(ROUTE)
  && /3 \* 1024 \* 1024/.test(ROUTE)
  && /文件内容不是 PNG \/ JPEG（扩展名不作数）/.test(ROUTE)
  && /saveReportBuffer\(buf\)/.test(ROUTE));
ok('B-02 服务层只认魔数、最多 2 张、读不到就跳过（坏图不拖死整份稿）',
  /const isPng = buf\[0\] === 0x89/.test(SVC) && /out\.length >= 2/.test(SVC)
  && /if \(!isPng && !isJpeg\) continue/.test(SVC));
ok('B-03 生成请求只带 imageTokens（不是图片本体）',
  /imageTokens/.test(ROUTE) && /\^\[0-9a-f\]\{8\}-/.test(ROUTE) && /\.slice\(0, 2\)/.test(ROUTE));
ok('B-04 前端有上传入口、类型/大小前置校验与 imageTokens 透传',
  /aria-label="上传图片"/.test(PANEL) && /3 \* 1024 \* 1024/.test(PANEL)
  && /\/plans\/kickoff-image/.test(PANEL) && /imageTokens: images\.map/.test(PANEL));
ok('B-05 PPTX 与 HTML 共用同一份 bundle.images（不是两条链路各存一份）',
  /const bundleForBuild = \{ \.\.\.bundle, risks: built\.risks, images: toImageAssets\(imageTokens\) \}/.test(SVC)
  && /bundle\.images\?\.\[0\]/.test(readFileSync(join(ROOT, 'server/src/services/kickoffBuilder.ts'), 'utf8'))
  && /b\.images\?\.\[0\]/.test(readFileSync(join(ROOT, 'server/src/services/kickoffHtml.ts'), 'utf8')));

const body = [`T05678 截图插槽门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05678-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05678-gate-results.txt')}`);
