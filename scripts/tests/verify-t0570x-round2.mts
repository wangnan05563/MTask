/**
 * 2026-11-12 二轮验收门：T05689 / T05690 / T05691 / T05704 / T05705 / T05706。
 *
 * 三单为「验证失败回填」（status 被打回 todo/failed，意见追加在 handle_result 末尾）：
 *   T05689 401 修好后变 403；T05690「本次确认将关联到」需可点击勾选任务；T05691 右侧仍截断。
 * 三单为新任务：T05704 标题框粘贴图片、T05705 讲稿卡字体对齐 Git 卡、T05706 失败反馈录入框右侧重叠。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t0570x-round2.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');
let pass = 0, fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
};

const SONAR = readFileSync(join(ROOT, 'server/src/services/sonarSettings.ts'), 'utf8');
const MODAL = readFileSync(join(ROOT, 'web/src/ui/GitTreePickerModal.tsx'), 'utf8');
const TASKS = readFileSync(join(ROOT, 'web/src/pages/TasksPage.tsx'), 'utf8');
const LEC = readFileSync(join(ROOT, 'web/src/pages/CodeReviewLecturePanel.tsx'), 'utf8');
const GIT = readFileSync(join(ROOT, 'web/src/pages/GitExtractPanel.tsx'), 'utf8');

// A. T05689：401 修好后 403 —— 项目分析令牌无权 projects/search
ok('A-01 [T05689] 403 时降级 api/components/search（TRK），匿名/带 Token 双通道',
  /response\.res\.status === 403\)[\s\S]{0,500}api\/components\/search/.test(SONAR)
  && /qualifiers: 'TRK'/.test(SONAR) && /json\?\.components/.test(SONAR));
ok('A-02 [T05689] 仍被拒时给出可操作指引（User Token / 手输 projectKey），不再丢裸 403',
  /项目分析令牌/.test(SONAR) && /User Token/.test(SONAR) && /手动填写/.test(SONAR));

// B. T05690：「本次确认将关联到」可点击勾选任务列表
ok('B-01 [T05690] 弹窗新增 targetTasks 可选 props + 默认全选的勾选态',
  /readonly targetTasks\?: ReadonlyArray/.test(MODAL) && /checkedTargetIds/.test(MODAL));
ok('B-02 [T05690] 说明条内「点击勾选关联任务」按钮 + 可展开任务清单（全选/清空）',
  /data-lck="git-tree-target-toggle"/.test(MODAL) && /data-lck="git-tree-target-list"/.test(MODAL)
  && /点击勾选关联任务/.test(MODAL) && /全选/.test(MODAL) && /清空/.test(MODAL));
ok('B-03 [T05690] onConfirm 第四参回传勾选集，三处调用都带；全不选时禁止确认',
  (MODAL.match(/onConfirm\([\s\S]{0,140}checkedTargetIds\)/g) ?? []).length >= 3
  && /checkedTargetIds\.length > 0\)/.test(MODAL)
  && /targetIds\?: string\[\]/.test(MODAL));
ok('B-04 [T05690] TasksPage 传整条队列，确认按勾选集批量写关联',
  /targetTasks=\{gitLinkQueue\.map/.test(TASKS) && /targetIds\?: string\[\]/.test(TASKS)
  && /gitLinkQueue\.filter\(\(t\) => targetIds\.includes\(t\.id\)\)/.test(TASKS)
  && /prev\.filter\(\(t\) => !handled\.has\(t\.id\)\)/.test(TASKS));

// C. T05691：右侧留白与滚动条槽位
ok('C-01 [T05691] 容器预留滚动条槽位 scrollbarGutter: stable，右侧不再被滚动条挤占',
  /overflow: 'auto', scrollbarGutter: 'stable'/.test(MODAL));
ok('C-02 [T05691] 右栏与左栏一样留边缘空白（paddingRight 12 + minWidth/maxWidth 约束）',
  /minWidth: 0, maxWidth: '100%', paddingRight: 12/.test(MODAL));

// D. T05704：标题输入框粘贴图片自动落草稿
ok('D-01 [T05704] 粘贴函数泛化到 HTMLElement（标题 input 与 textarea 共用）',
  /function readClipboardImages\(e: ClipboardEvent<HTMLElement>/.test(TASKS));
ok('D-02 [T05704] 标题框 onPaste 自动展开描述区并落截图草稿 + 提示，无需先点「描述/截图」',
  /onPaste=\{\(e\) => \{\s*\n\s*if \(!readClipboardImages\(e, addNewImage\)\) return;/.test(TASKS)
  && /setNewDescOpen\(true\)/.test(TASKS) && /已粘贴截图，创建任务时会自动上传/.test(TASKS));

// E. T05705：讲稿卡字号对齐 Git 卡
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const lecXs = count(LEC, /fontSize: 'var\(--fs-xs\)'/g);
const lecS = count(LEC, /fontSize: 'var\(--fs-s\)'/g);
const gitXs = count(GIT, /fontSize: 'var\(--fs-xs\)'/g);
ok('E-01 [T05705] 讲稿卡以 --fs-xs 为主、--fs-s 仅余少量层级，不再有 --fs-m',
  lecXs >= 25 && lecS <= 3 && !/fontSize: 'var\(--fs-m\)'/.test(LEC));
ok('E-02 [T05705] 基准卡字号分布未动（Git 卡仍以 --fs-xs/--fs-s 为主）',
  gitXs >= 6 && /fontSize: 'var\(--fs-l\)'/.test(GIT));

// F. T05706：失败反馈录入框右侧重叠/截断
ok('F-01 [T05706] textarea 用 border-box + 左右对称 padding + minWidth/maxWidth 自适应',
  /boxSizing: 'border-box', padding: 8/.test(TASKS)
  && /width: '100%', minWidth: 0, maxWidth: '100%'/.test(TASKS)
  && /aria-label="验证失败反馈内容"/.test(TASKS));
ok('F-02 [T05706] 录入框交互保留（autoFocus / onChange / onPaste 截图通道）',
  /onPaste=\{\(e\) => readClipboardImages\(e, appendFailImage\)\}/.test(TASKS)
  && /autoFocus/.test(TASKS));

const body = [`T0570x 二轮验收门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't0570x-round2-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't0570x-round2-gate-results.txt')}`);
