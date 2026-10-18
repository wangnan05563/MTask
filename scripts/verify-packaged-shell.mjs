#!/usr/bin/env node
/**
 * T01664：打包桌面壳复验门（安装包解包目录全链 UI 复验，可直接作发版验收门）。
 *
 * T02293 批㉔ 判据落地（`docs/验收门判据规约.md`）：
 *  - **判据 1（断言打在行为/产物/结构上）**：行为腿全程不出现产品中文文案选择器，也不用 `.task-item`
 *    这类 CSS 类名。统一走结构句柄：夹具行＝`[data-ttask-id="<门内建的 task id>"]` 的 `closest('li')`；
 *    桌面抽屉＝文档流内**可见**的 `[role=dialog][aria-modal=true]`（SlideOver 常驻挂载，关闭态由祖先
 *    visibility:hidden 排除，可见模态数须恰为 1）；抽屉正文＝面板的第 2 个直接子 DIV；标签栏＝正文内
 *    「直接子 BUTTON ≥3 的那个 DIV」；查看态编辑入口＝正文的**首个直接子 BUTTON**（反模式 26：
 *    MarkdownContent 自带渲染/源码/复制工具条、结果历史面板另有按钮，按后代计数一律污染）；
 *    编辑态＝正文唯一 textarea ＋ 其下一兄弟的恰 2 枚直接子 BUTTON（取消先于保存）；
 *    附件缩略图＝「唯一子元素是 IMG」的 button；标题框选＝行内的 `[role=button]` 且文本含夹具标题；
 *    项目切换器＝`button[aria-haspopup="listbox"]` ＋ `[role=button][aria-pressed]` 选项行；
 *    视图切换＝页面唯一 FIELDSET 的直接子 BUTTON（DOM 序 列表/甘特/时间线）；用例面板＝点开某枚
 *    icon-only `button[aria-expanded]` 后**出现含夹具用例标题的 section** 的那一枚（按效果认定，不认文案）；
 *    时间线＝`[data-tl]` 行按 `data-plan-id` 落到夹具里程碑/夹具计划上；移动半屏＝可见的
 *    `dialog[open][aria-modal=true]` 且文本含夹具标题。**取消/保存/落库一律按服务端可观测效果认定**。
 *  - **判据 2（门内自造夹具、不断言生产数据）**：打包壳以**全新 userData**（落 D: 临时根）＋派生端口起，
 *    夹具（项目/任务/附件/里程碑/计划/用例）全部由门经 REST 自建；断言只引用本轮自己造的行，
 *    并用「项目数 ≤3」反向自证附着的就是本轮实例（E-02）。不连生产 39877、不读用户生产库。
 *  - **判据 3（字面锚一律配对）**：20 组锚点（app:// 协议、向导已读键、跨页导航事件、行句柄、
 *    抽屉入口可访问名、模态语义、关闭钮、五标签页、编辑态可访问名、取消先于保存的源码顺序、
 *    放大预览×2、标题 userSelect、两个项目选择器、视图切换 fieldset、用例入口与面板、时间线三个钩、
 *    移动偏好键、半屏模态）全部走 `scripts/lib/anchor-pair.mts` 的 `okPair`，取证面 `git show HEAD:`
 *    （反模式 11：绝不读工作树——工作树此刻正躺着并发会话的改动）。
 *  - **判据 4（负对照）**：N-01..N-08 八组（空源码 20 条字面腿全假、逐锚 HEAD 在场、抽干实测料后
 *    全部行为腿为假＋回填复原、逐锚改名自证 `tampered !== original`、`okPair` 两红因契约、
 *    逐腿结构破坏各自转假、旧门两种假绿形态不复现、关键句柄防空转）。
 *  - **临时根全落 D:**（C: 常年 0 可用会把绿判成红）；退出连树回收壳进程并清理临时目录。
 *
 * 用法：node scripts/verify-packaged-shell.mjs
 *   [--shell <MTask.exe>] [--user-data <dir>] [--cdp <port>] [--port <backendPort>]
 *   [--shots <dir>] [--filter <断言名子串>] [--token <X-Access-Token>] [--cdp-timeout <ms，默认 30000>]
 *   环境变量：MTASK_SHELL_EXE / T02293_SHELL_PORT / T02293_SHELL_CDP
 *   `--shell` 缺省时按 `release/win-unpacked` → `.t1569-app2` 顺序取第一个存在的解包壳。
 *
 * ⚠ ELECTRON_RUN_AS_NODE 必须从壳进程环境剥离（WorkBuddy 等 Electron 宿主终端会向子进程传播，
 *   继承它会让打包壳被当纯 node 执行——打印 bad option 后 exit 9，后端永不就绪，T01664 实测）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

/** 解包壳自动发现：优先发版产物 `release/win-unpacked`，回落历史夹具目录 `.t1569-app2` */
function findShell() {
  const explicit = argOf('shell', process.env.MTASK_SHELL_EXE || '');
  if (explicit) return path.resolve(ROOT, explicit);
  for (const rel of ['release/win-unpacked/MTask.exe', '.t1569-app2/MTask.exe']) {
    const p = path.join(ROOT, rel);
    if (existsSync(p)) return p;
  }
  return path.join(ROOT, 'release/win-unpacked/MTask.exe');
}

const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : os.tmpdir();
const RUN_TAG = String(Date.now()).slice(-6);
const SCRATCH = mkdtempSync(path.join(TMP_ROOT, `t02293-shell-${RUN_TAG}-`));
const EXE = findShell();
const USER_DATA = argOf('user-data', path.join(SCRATCH, 'userdata'));
const CDP = Number(argOf('cdp', process.env.T02293_SHELL_CDP ?? String(9500 + (Number(RUN_TAG) % 90))));
const PORT = Number(argOf('port', process.env.T02293_SHELL_PORT ?? String(40600 + (Number(RUN_TAG) % 90))));
const SHOTS_DIR = argOf('shots', path.join(SCRATCH, 'shots'));
const FILTER = argOf('filter', '');
const TOKEN = argOf('token', 'probe');
const API = `http://127.0.0.1:${PORT}/api`;

// 以下全是**门内夹具数据**（本轮 userData 自建），不是产品文案：判据里出现它们不算字面锚
const FIX = `T02293打包复验${RUN_TAG}`;
const PROJ_NAME = `${FIX}项目`;
const FIX_TITLE = `${FIX}抽屉就地编辑`;
const DESC0 = '夹具原始描述·待就地编辑';
const DESC_APPEND = '·打包态就地编辑写入';
const RESULT0 = '夹具原始结果·待就地编辑';
const RESULT_APPEND = '·打包态结果编辑写入';
const MS_TITLE = `${FIX}阶段里程碑`;
const PL_TITLE = `${FIX}已关联任务`;
const CASE_TITLE = `${FIX}用例`;
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4nGP8z8DAwMDAwMDAxMDAwMDExIChGRoYMDQAMjEDGo3vGkMAAAAASUVORK5CYII=';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let passed = 0;
const results = [];
const shots = [];
const check = (n, p, i) => {
  results.push({ n, p, i });
  if (p) { passed += 1; console.log(`  [PASS] ${n}`); return; }
  failures += 1;
  console.log(`  [FAIL] ${n}${i !== undefined ? ` -> ${JSON.stringify(i).toString().slice(0, 700)}` : ''}`);
};

// 字面腿取证面固定 HEAD（反模式 11：工作树可能正躺着并发会话的过期产品文件）
const headSource = (rel) => {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return '';
  }
};
const SRC = {
  MAIN: headSource('electron/main.js'),
  APP: headSource('web/src/App.tsx'),
  GUIDES: headSource('web/src/pages/guides.tsx'),
  TASKS: headSource('web/src/pages/TasksPage.tsx'),
  SLIDE: headSource('web/src/components/SlideOver.tsx'),
  DRAWER: headSource('web/src/components/TaskDetailDrawer.tsx'),
  PLAN: headSource('web/src/pages/PlanPage.tsx'),
  TL: headSource('web/src/components/PlanTimeline.tsx'),
  TC: headSource('web/src/pages/TestCasePanel.tsx'),
  MDETAIL: headSource('web/src/mobile/MobileTaskDetail.tsx'),
  MHOME: headSource('web/src/mobile/MobileHome.tsx'),
  MUI: headSource('web/src/mobile/ui.tsx'),
};
// 向导「已读键」直接取 HEAD 的 guides.tsx（与产品同源，不抄一份常量表）
const GUIDE_KEYS = [...new Set([...SRC.GUIDES.matchAll(/seenKey:\s*'([^']+)'/g)].map((m) => m[1]))];
if (!GUIDE_KEYS.includes('mtask.projectGuide.seen')) GUIDE_KEYS.push('mtask.projectGuide.seen');

const ANCHORS = {
  'P-01a': { src: SRC.MAIN, needle: `loadURL('app://ui/index.html')`, literal: (s) => s.includes(`loadURL('app://ui/index.html')`) },
  'P-02a': { src: SRC.GUIDES, needle: `seenKey: 'mtask.guide.seen.tasks'`, literal: (s) => /seenKey:\s*'mtask\.guide\.seen\.tasks'/.test(s) },
  'P-03a': { src: SRC.APP, needle: `addEventListener('mtaskNavigate'`, literal: (s) => /addEventListener\('mtaskNavigate'/.test(s) },
  'P-04a': { src: SRC.TASKS, needle: 'data-ttask-id={t.id}', literal: (s) => /data-ttask-id=\{t\.id\}/.test(s) },
  'P-05a': { src: SRC.TASKS, needle: 'aria-label="展开详情抽屉', literal: (s) => s.includes('aria-label="展开详情抽屉') },
  'P-06a': { src: SRC.SLIDE, needle: `aria-modal={passthrough ? undefined : 'true'}`, literal: (s) => /role="dialog"/.test(s) && /aria-modal=\{passthrough \? undefined : 'true'\}/.test(s) },
  'P-07a': { src: SRC.SLIDE, needle: 'aria-label="关闭抽屉"', literal: (s) => /aria-label="关闭抽屉"/.test(s) },
  'P-08a': { src: SRC.DRAWER, needle: 'aria-label={t.label}', literal: (s) => /tabs\.map[\s\S]{0,400}?aria-label=\{t\.label\}/.test(s) },
  'P-08b': { src: SRC.DRAWER, needle: `key: 'plans', label: '关联计划'`, literal: (s) => /key:\s*'desc'[\s\S]{0,400}?key:\s*'plans'/.test(s) },
  'P-09a': { src: SRC.DRAWER, needle: 'aria-label="编辑任务描述"', literal: (s) => /aria-label="编辑任务描述"/.test(s) },
  'P-10a': { src: SRC.DRAWER, needle: `void save('desc')`, literal: (s) => /setEditing\(null\)[\s\S]{0,700}?void save\('desc'\)/.test(s) },
  'P-11a': { src: SRC.DRAWER, needle: '放大预览', literal: (s) => /aria-label=\{previewId === img\.id[\s\S]{0,120}?放大预览/.test(s) },
  'P-12a': { src: SRC.TASKS, needle: `userSelect: 'text'`, literal: (s) => /role="button"[\s\S]{0,1400}?userSelect:\s*'text'/.test(s) },
  'P-13a': { src: SRC.TASKS, needle: 'aria-pressed={p.id === activeProject}', literal: (s) => /aria-haspopup="listbox"/.test(s) && /aria-pressed=\{p\.id === activeProject\}/.test(s) },
  'P-14a': { src: SRC.PLAN, needle: 'aria-label="选择项目"', literal: (s) => /aria-haspopup="listbox"/.test(s) && /aria-label="选择项目"/.test(s) },
  'P-15a': { src: SRC.PLAN, needle: 'aria-label="视图切换"', literal: (s) => /<fieldset[^>]*aria-label="视图切换"/.test(s) },
  'P-16a': { src: SRC.PLAN, needle: 'aria-label="测试用例"', literal: (s) => /aria-label="测试用例" aria-expanded/.test(s) },
  'P-16b': { src: SRC.TC, needle: 'aria-label="测试用例面板"', literal: (s) => /<section aria-label="测试用例面板"/.test(s) },
  'P-17a': { src: SRC.TL, needle: 'aria-label="计划时间线"', literal: (s) => /<ul aria-label="计划时间线"/.test(s) },
  'P-17b': { src: SRC.TL, needle: 'data-tl="collapse"', literal: (s) => /data-tl="collapse"/.test(s) },
  'P-17c': { src: SRC.TL, needle: 'data-tl="jump-linked"', literal: (s) => /data-tl="jump-linked"/.test(s) },
  'P-18a': { src: SRC.APP, needle: `getItem('mtask.uiMode')`, literal: (s) => /localStorage\.getItem\('mtask\.uiMode'\)/.test(s) },
  'P-19a': { src: SRC.MUI, needle: 'aria-modal="true"', literal: (s) => /<dialog[\s\S]{0,120}?aria-modal="true"/.test(s) },
  'P-19b': { src: SRC.MDETAIL, needle: 'title="任务详情"', literal: (s) => /<HalfSheet open title="任务详情"/.test(s) },
  'P-20a': { src: SRC.MDETAIL, needle: '放大预览', literal: (s) => /aria-label=\{previewId === img\.id[\s\S]{0,120}?放大预览/.test(s) },
};

// 运行期实测料（行为腿唯一取数面；N-02b 靠抽干它证明行为腿不恒真）
const EV = {
  href: '', startupLogSeen: false, abiLogClean: false, healthAfter: -1,
  projectCountFresh: -1, fixtureProjInApi: false,
  modalCountAtStart: -1, sheetCountAtStart: -1, nativeDialogOpenAtStart: -1, guideKeyCount: -1,
  fixtureChainBuilt: false,
  rowFound: false, rowIsLi: false, rowTitleMatches: false, entryFound: false, entryStrategy: '',
  rowHandleStrategy: '', mountedButtonCount: -1, fixtureRowReachable: false,
  pickerFound: false, pickerExpanded: false, optionRowCount: -1, pressedOptionCount: -1,
  optionMatchesFixture: false, rowAfterPick: false,
  modalCountWhileOpen: -1, drawerHasFixture: false, drawerTitleText: '', drawerTitleIsAria: false,
  headerButtonCount: -1,
  tabCount: -1, tabDescendantCount: -1, tabBodiesDistinct: -1, descTabHasFixtureDesc: false, resultTabHasFixtureResult: false,
  maskClosed: false, focusAfterMask: false,
  closeBtnFound: false, closeBtnClosed: false, focusAfterCloseBtn: false,
  escClosed: false, focusAfterEsc: false,
  descViewButtons: -1, editorOpened: false, textareaCount: -1, editRowButtons: -1,
  cancelClosedEditor: false, displayAfterCancel: '', serverAfterCancel: '',
  saveClicked: false, displayAfterSave: '', serverAfterSave: '',
  thumbCount: -1, thumbBeforeW: -1, thumbAfterW: -1, thumbCollapseW: -1, thumbZoomIsAccent: false,
  resultViewButtons: -1, resultEditorOpened: false, serverResultAfterSave: '', displayAfterResultSave: '',
  titleUserSelect: '', selectionText: '',
  navPlanStruct: false, navBackTaskStruct: false,
  planPickerFound: false, planOptionFound: false, planListHasFixture: false,
  panelToggleCandidates: -1, panelSectionFound: false, panelHasFixtureCase: false,
  panelSectionTotal: -1, panelCaseInBody: false, panelToggleHitIndex: -1, panelRootTag: 'none', panelRootHops: -1,
  panelTrail: [], fixtureCaseCount: -1,
  panelBorderW: -1, panelBorderStyle: '', panelBorderColor: '', accentRgb: '',
  viewFieldsetCount: -1, viewButtonCount: -1, timelineFound: false,
  tlMsRows: -1, tlItemRows: -1, jumpBadgeOnFixturePlan: false, collapseOnFixtureMs: false,
  tlBadgeTotal: -1, tlCollapseTotal: -1,
  collapseFlipped: false, childHiddenAfterCollapse: false, expandRestored: false,
  uiModeMobile: false, headerSelectFound: false, headerSelectSwitched: false,
  mobileRowFound: false, mobileRowButtons: -1, mobileRowDeepButtons: -1, sheetVisible: false, sheetHasFixture: false,
  mThumbCount: -1, mThumbBeforeW: -1, mThumbAfterW: -1, mThumbCollapseW: -1, sheetClosed: false,
  // N-06 旧门假绿形态取证
  bodyTextKeepsFixtureWhenClosed: false, visibleModalTextEmptyWhenClosed: false,
};
const withEV = (e, fn) => {
  const saved = { ...EV };
  for (const k of Object.keys(EV)) EV[k] = undefined;
  Object.assign(EV, e);
  let r = false;
  try { r = fn() === true; } catch { r = false; }
  Object.assign(EV, saved);
  return r;
};
const has = (text, s) => typeof text === 'string' && text.includes(s);
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/** 判据 3 的 20 组配对项（行为腿 + 字面锚）；判据 1 的单腿项见 SOLO。两组都在实测跑完后惰性发射（反模式 14） */
const PAIRS = [
  { id: 'P-01', label: 'renderer 由安装包 app:// 协议加载（非 file://、非 dev server）',
    behavior: () => String(EV.href).startsWith('app://'), anchors: ['P-01a'], ctx: () => ({ href: String(EV.href).slice(0, 90) }) },
  { id: 'P-02', label: '首屏不被向导模态拦截（已读键与产品同源预种）',
    behavior: () => EV.modalCountAtStart === 0 && EV.sheetCountAtStart === 0 && EV.nativeDialogOpenAtStart === 0 && EV.guideKeyCount >= 8,
    anchors: ['P-02a'], ctx: () => ({ 可见模态: EV.modalCountAtStart, 半屏: EV.sheetCountAtStart, 原生dialog: EV.nativeDialogOpenAtStart, 预种键数: EV.guideKeyCount }) },
  { id: 'P-03', label: '跨页导航事件可切页并切回（plan 结构在场 → 回 tasks 行句柄在场）',
    behavior: () => EV.navPlanStruct === true && EV.navBackTaskStruct === true, anchors: ['P-03a'], ctx: () => ({ 计划页: EV.navPlanStruct, 回任务页: EV.navBackTaskStruct }) },
  { id: 'P-04', label: '夹具行由行标识句柄命中（data-ttask-id → closest(li)，行内标题＝夹具标题）',
    behavior: () => EV.rowFound === true && EV.rowIsLi === true && EV.rowTitleMatches === true, anchors: ['P-04a'], ctx: () => ({ 命中: EV.rowFound, 行是LI: EV.rowIsLi, 标题同源: EV.rowTitleMatches }) },
  { id: 'P-05', label: '行内抽屉入口点击后出现唯一可见模态抽屉且标题含夹具标题',
    behavior: () => EV.entryFound === true && EV.modalCountWhileOpen === 1 && EV.drawerHasFixture === true,
    anchors: ['P-05a'], ctx: () => ({ 入口策略: EV.entryStrategy, 可见模态: EV.modalCountWhileOpen, 含夹具: EV.drawerHasFixture }) },
  { id: 'P-06', label: '抽屉面板为模态语义（关闭后可见模态归零、常驻挂载靠 visibility 排除）',
    behavior: () => EV.maskClosed === true && EV.visibleModalTextEmptyWhenClosed === true, anchors: ['P-06a'], ctx: () => ({ 遮罩关闭: EV.maskClosed, 关闭后可见模态文本为空: EV.visibleModalTextEmptyWhenClosed }) },
  { id: 'P-07', label: '面板头部恰 1 枚直接子关闭钮，点击即关闭且焦点归还入口',
    behavior: () => EV.headerButtonCount === 1 && EV.closeBtnFound === true && EV.closeBtnClosed === true && EV.focusAfterCloseBtn === true,
    anchors: ['P-07a'], ctx: () => ({ 头部钮数: EV.headerButtonCount, 关闭: EV.closeBtnClosed, 焦点归还: EV.focusAfterCloseBtn }) },
  { id: 'P-08', label: '抽屉五标签页（直接子计数）且逐页正文互不相同、描述页含夹具描述、结果页含夹具结果',
    behavior: () => EV.tabCount === 5 && EV.tabBodiesDistinct === 5 && EV.descTabHasFixtureDesc === true && EV.resultTabHasFixtureResult === true,
    anchors: ['P-08a', 'P-08b'], ctx: () => ({ 直接子计数: EV.tabCount, 后代计数: EV.tabDescendantCount, 不同正文数: EV.tabBodiesDistinct }) },
  { id: 'P-09', label: '查看态恰 1 枚直接子编辑钮，点进编辑态＝唯一 textarea ＋恰 2 钮',
    behavior: () => EV.descViewButtons === 1 && EV.editorOpened === true && EV.textareaCount === 1 && EV.editRowButtons === 2,
    anchors: ['P-09a'], ctx: () => ({ 查看态钮: EV.descViewButtons, textarea: EV.textareaCount, 编辑行钮: EV.editRowButtons }) },
  { id: 'P-10', label: '编辑行首钮（取消）不落库且丢弃草稿、末钮（保存）写入服务端',
    behavior: () => EV.cancelClosedEditor === true && EV.serverAfterCancel === DESC0 && !has(EV.displayAfterCancel, DESC_APPEND)
      && EV.saveClicked === true && EV.serverAfterSave === DESC0 + DESC_APPEND && has(EV.displayAfterSave, DESC_APPEND),
    anchors: ['P-10a'], ctx: () => ({ 取消后服务端: EV.serverAfterCancel, 保存后服务端: String(EV.serverAfterSave).slice(-24) }) },
  { id: 'P-11', label: '抽屉附件缩略图点击放大（宽度翻倍、放大态描边为 accent）、再点回落缩略尺寸',
    behavior: () => EV.thumbCount === 1 && EV.thumbBeforeW > 0 && EV.thumbAfterW > EV.thumbBeforeW * 2 && EV.thumbZoomIsAccent === true
      && EV.thumbCollapseW > 0 && Math.abs(EV.thumbCollapseW - EV.thumbBeforeW) <= 2,
    anchors: ['P-11a'], ctx: () => ({ 缩略: EV.thumbBeforeW, 放大: EV.thumbAfterW, 收起: EV.thumbCollapseW }) },
  { id: 'P-12', label: '行内标题计算样式可框选，真实拖拽后选区文本＝夹具标题',
    behavior: () => String(EV.titleUserSelect).startsWith('text') && has(EV.selectionText, FIX_TITLE),
    anchors: ['P-12a'], ctx: () => ({ userSelect: EV.titleUserSelect, 选区: String(EV.selectionText).slice(0, 40) }) },
  { id: 'P-13', label: '任务页项目切换器：展开后选项行 aria-pressed 恰 1、含夹具项目，选中后夹具行进列表',
    behavior: () => EV.pickerFound === true && EV.pickerExpanded === true && EV.optionRowCount >= 2 && EV.pressedOptionCount === 1
      && EV.optionMatchesFixture === true && EV.rowAfterPick === true,
    anchors: ['P-13a'], ctx: () => ({ 选项行: EV.optionRowCount, 选中态数: EV.pressedOptionCount, 夹具命中: EV.optionMatchesFixture }) },
  { id: 'P-14', label: '计划页项目选择器选中夹具项目后，夹具计划标题进入页面（与服务端同源）',
    behavior: () => EV.planPickerFound === true && EV.planOptionFound === true && EV.planListHasFixture === true,
    anchors: ['P-14a'], ctx: () => ({ 选择器: EV.planPickerFound, 选项: EV.planOptionFound, 列表命中: EV.planListHasFixture }) },
  { id: 'P-15', label: '计划页唯一 FIELDSET 恰 3 枚直接子钮，点第 3 枚出现时间线结构（[data-tl] 行）',
    behavior: () => EV.viewFieldsetCount === 1 && EV.viewButtonCount === 3 && EV.timelineFound === true,
    anchors: ['P-15a'], ctx: () => ({ fieldset数: EV.viewFieldsetCount, 钮数: EV.viewButtonCount, 时间线: EV.timelineFound }) },
  { id: 'P-16', label: '按效果认定的用例面板入口：打开的面板内含夹具用例标题（文本或输入值），其面板根上边框 solid ≈1px 且颜色等于 --accent',
    behavior: () => EV.panelToggleCandidates >= 3 && EV.panelSectionFound === true && EV.panelHasFixtureCase === true
      && EV.panelBorderW > 0.5 && EV.panelBorderW < 1.5 && EV.panelBorderStyle === 'solid' && EV.panelBorderColor === EV.accentRgb,
    anchors: ['P-16a', 'P-16b'], ctx: () => ({ 候选钮: EV.panelToggleCandidates, 面板: EV.panelSectionFound, 可见section: EV.panelSectionTotal, 正文含用例: EV.panelCaseInBody, 边框: `${EV.panelBorderW} ${EV.panelBorderStyle} ${EV.panelBorderColor}`, 面板根: `${EV.panelRootTag}@${EV.panelRootHops}`, section数: EV.panelSectionTotal, 用例服务端: EV.fixtureCaseCount, 逐钮留痕: EV.panelTrail, accent: EV.accentRgb }) },
  { id: 'P-17', label: '时间线行按 data-plan-id 落到夹具里程碑/夹具计划：角标在夹具计划行、折叠钮在夹具里程碑行',
    behavior: () => EV.tlMsRows >= 1 && EV.tlItemRows >= 1 && EV.jumpBadgeOnFixturePlan === true && EV.collapseOnFixtureMs === true,
    anchors: ['P-17a', 'P-17b', 'P-17c'], ctx: () => ({ 里程碑行: EV.tlMsRows, 任务行: EV.tlItemRows, 角标: EV.jumpBadgeOnFixturePlan, 角标在场: EV.tlBadgeTotal, 折叠钮: EV.collapseOnFixtureMs, 折叠钮在场: EV.tlCollapseTotal }) },
  { id: 'P-18', label: '移动偏好切换后落到移动布局（头部项目选择器在场且可切到夹具项目）',
    behavior: () => EV.uiModeMobile === true && EV.headerSelectFound === true && EV.headerSelectSwitched === true,
    anchors: ['P-18a'], ctx: () => ({ 移动布局: EV.headerSelectFound, 选择器切项目: EV.headerSelectSwitched }) },
  { id: 'P-19', label: '移动半屏详情＝可见 dialog[aria-modal]（原生 dialog 只开时渲染）且文本含夹具标题',
    behavior: () => EV.sheetVisible === true && EV.sheetHasFixture === true, anchors: ['P-19a', 'P-19b'],
    ctx: () => ({ 半屏可见: EV.sheetVisible, 含夹具: EV.sheetHasFixture }) },
  { id: 'P-20', label: '半屏附件缩略图点击放大（宽度翻倍）再点回落——桌面同因修复的第二处必须实测',
    behavior: () => EV.mThumbCount === 1 && EV.mThumbBeforeW > 0 && EV.mThumbAfterW > EV.mThumbBeforeW * 2
      && EV.mThumbCollapseW > 0 && Math.abs(EV.mThumbCollapseW - EV.mThumbBeforeW) <= 2,
    anchors: ['P-20a'], ctx: () => ({ 缩略: EV.mThumbBeforeW, 放大: EV.mThumbAfterW, 收起: EV.mThumbCollapseW }) },
];

/** 判据 1 的纯行为/结构/服务端同源项（不含字面锚） */
const SOLO = [
  { id: 'E-01', label: '打包壳内后端服务就绪（/api/health 200）', fn: () => EV.fixtureChainBuilt === true && EV.projectCountFresh >= 1,
    ctx: () => ({ 项目数: EV.projectCountFresh, 端口: PORT }) },
  { id: 'E-02', label: '附着实例即本轮全新 userData（项目数 ≤3 且夹具项目在 API 列表内）',
    fn: () => EV.projectCountFresh >= 1 && EV.projectCountFresh <= 3 && EV.fixtureProjInApi === true,
    ctx: () => ({ 项目数: EV.projectCountFresh, 夹具在列: EV.fixtureProjInApi, userData: USER_DATA }) },
  { id: 'E-03', label: 'better-sqlite3 ABI 健康（收尾仍可取数且启动日志无 DLOPEN/ABI 字样）',
    fn: () => EV.healthAfter > 0 && EV.abiLogClean === true, ctx: () => ({ 收尾项目数: EV.healthAfter, 日志在场: EV.startupLogSeen }) },
  { id: 'A-01', label: '遮罩点按即可关闭抽屉（关闭后可见模态归零）', fn: () => EV.maskClosed === true, ctx: () => ({ 关闭: EV.maskClosed }) },
  { id: 'A-02', label: 'ESC 关闭抽屉且焦点归还行内入口', fn: () => EV.escClosed === true && EV.focusAfterEsc === true,
    ctx: () => ({ 关闭: EV.escClosed, 焦点归还: EV.focusAfterEsc }) },
  { id: 'A-03', label: '抽屉头部标题节点经 aria-labelledby 解析且文本＝夹具标题',
    fn: () => EV.drawerTitleIsAria === true && has(EV.drawerTitleText, FIX_TITLE), ctx: () => ({ 标题: EV.drawerTitleText }) },
  { id: 'A-04', label: '结果页就地编辑末钮落库（服务端 handle_result 含追加文本）且抽屉正文同步',
    fn: () => EV.resultViewButtons === 1 && EV.resultEditorOpened === true && has(EV.serverResultAfterSave, RESULT_APPEND) && has(EV.displayAfterResultSave, RESULT_APPEND),
    ctx: () => ({ 查看态钮: EV.resultViewButtons, 服务端: String(EV.serverResultAfterSave).slice(-24) }) },
  { id: 'M-01', label: '移动布局夹具行在场（含夹具标题的 li 恰 2 枚直接子 BUTTON）',
    fn: () => EV.mobileRowFound === true && EV.mobileRowDeepButtons === 2, ctx: () => ({ 命中: EV.mobileRowFound, 直接子钮: EV.mobileRowButtons, 行内可见钮: EV.mobileRowDeepButtons }) },
  { id: 'M-02', label: '半屏关闭后原生 dialog 消失（只开时渲染，无需 visibility 排除）', fn: () => EV.sheetClosed === true, ctx: () => ({ 关闭: EV.sheetClosed }) },
];

const allLegs = () => [
  ...PAIRS.map((p) => ({ id: p.id, fn: p.behavior })),
  ...SOLO.map((s) => ({ id: s.id, fn: s.fn })),
];

// ---------- 连树回收与临时目录清理 ----------
const killTree = (pid) => {
  if (!pid) return;
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
};
let shell = null;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  killTree(shell?.pid);
  for (let i = 0; i < 10; i++) {
    try { rmSync(SCRATCH, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (i + 1)); }
  }
};
process.on('exit', cleanup);
process.on('uncaughtException', (e) => { console.log('UNCAUGHT: ' + (e && e.message)); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('REJECT: ' + (e && e.message)); cleanup(); process.exit(1); });

if (!existsSync(EXE)) {
  console.log(`未找到解包壳：${EXE}`);
  process.exit(1);
}
const asarPath = path.join(path.dirname(EXE), 'resources', 'app.asar');
let asarMtime = '';
try { asarMtime = statSync(asarPath).mtime.toISOString(); } catch { /* 无 asar */ }
let headCommitTime = '';
try { headCommitTime = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* 非 git */ }
console.log(`被测壳：${EXE}`);
console.log(`  asar 时间=${asarMtime || '未知'}｜HEAD 提交时间=${headCommitTime || '未知'}（留痕：壳若滞后于 HEAD，字面腿与行为腿的差异按「字面锚点失配」落账，不冒充功能失守）`);
console.log(`  临时根=${SCRATCH}（${TMP_ROOT}）userData=${USER_DATA} 端口=${PORT} CDP=${CDP}`);

// ---------- 起壳 ----------
const shellEnv = { ...process.env, MTask_PORT: String(PORT) };
delete shellEnv.ELECTRON_RUN_AS_NODE;
shell = spawn(EXE, [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${CDP}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900'], { stdio: 'ignore', env: shellEnv });

async function api(method, p, body) {
  const res = await fetch(API + p, {
    method, headers: { 'Content-Type': 'application/json', 'X-Access-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
let serverUp = false;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${API}/health`, { headers: { 'X-Access-Token': TOKEN } })).ok) { serverUp = true; break; } } catch { /* 未就绪 */ }
  await sleep(500);
}
if (!serverUp) {
  check('E-00 打包壳内后端服务就绪', false, { 端口: PORT, userData: USER_DATA });
  console.log('\n结果：PASS=0 FAIL=1（壳未就绪，终止）');
  cleanup();
  process.exit(1);
}

// ---------- 夹具（判据 2：门内经 sanctioned 写入通道自建）----------
let PROJECT = '';
let PROJ_NAMES = [];
let TASK_ID = '';
let MS = '';
let PL = '';
try {
  const proj = await api('POST', '/projects', { name: PROJ_NAME, description: 'T02293 打包态桌面壳复验夹具项目' });
  PROJECT = proj.id ?? proj.project?.id;
  const task = await api('POST', '/tasks', { projectId: PROJECT, title: FIX_TITLE, description: DESC0, priority: 'high', status: 'todo' });
  TASK_ID = task.id ?? task.task?.id;
  await api('POST', `/tasks/${TASK_ID}/images`, { data: PNG1, mimeType: 'image/png' });
  await api('PATCH', `/tasks/${TASK_ID}`, { handleResult: RESULT0 });
  const mk = async (title, kind, startDate, durationDays) => {
    const r = await api('POST', '/plans', { projectId: PROJECT, title, kind, startDate, durationDays });
    return r.id ?? r.plan?.id;
  };
  MS = await mk(MS_TITLE, 'milestone', '2026-03-02', 12);
  PL = await mk(PL_TITLE, 'normal', '2026-03-06', 3);
  await api('POST', `/plans/${PL}/create-todo`);
  await api('PATCH', `/plans/${PL}`, { deps: JSON.stringify([{ id: MS, type: 'child' }]) });
  await api('POST', '/plans/test-cases', { projectId: PROJECT, title: CASE_TITLE });
  const back = await api('GET', `/tasks?projectId=${PROJECT}&limit=500`);
  const t = Array.isArray(back) ? back.find((x) => x.id === TASK_ID) : null;
  // 夹具用例服务端计数（判据 2 的自证：面板腿红时能一眼分清「服务端没这条用例」还是「面板没把它显示出来」）
  const cases = await api('GET', `/plans/test-cases?projectId=${PROJECT}`).catch(() => null);
  const caseList = Array.isArray(cases) ? cases : Array.isArray(cases?.items) ? cases.items : Array.isArray(cases?.cases) ? cases.cases : null;
  EV.fixtureCaseCount = caseList ? caseList.filter((c) => String(c.title ?? '') === CASE_TITLE).length : -1;
  EV.fixtureChainBuilt = !!PROJECT && !!TASK_ID && !!MS && !!PL
    && String(t?.description ?? '') === DESC0 && String(t?.handle_result ?? '') === RESULT0;
  console.log(`夹具：P=${PROJECT} T=${TASK_ID} MS=${MS} PL=${PL} 用例=${CASE_TITLE}`);
} catch (e) {
  console.log('夹具创建失败：' + String(e.message).slice(0, 200));
}
{
  const projects = await api('GET', '/projects').catch(() => []);
  EV.projectCountFresh = Array.isArray(projects) ? projects.length : -1;
  EV.fixtureProjInApi = Array.isArray(projects) && projects.some((p) => p.id === PROJECT);
  PROJ_NAMES = Array.isArray(projects) ? projects.map((p) => String(p.name ?? '')) : [];
}
if (!EV.fixtureChainBuilt) {
  check('E-00 夹具链经 REST 建成（项目/任务/附件/结果/里程碑/计划/用例）', false, { PROJECT, TASK_ID, MS, PL });
  console.log('\n结果：PASS=0 FAIL=1（夹具未建成，终止）');
  cleanup();
  process.exit(1);
}

// ---------- CDP 附着 ----------
const PAGE_HELPERS = `(() => {
  const qa = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const direct = (el, tag) => (el ? Array.prototype.slice.call(el.children).filter((c) => c.tagName === tag) : []);
  const vis = (el) => !!el && (typeof el.checkVisibility === 'function'
    ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : el.getClientRects().length > 0);
  const inFlow = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.left < window.innerWidth - 4; };
  const text = (el) => (el ? String(el.innerText === '' ? el.textContent : (el.innerText || el.textContent || '')) : '');
  const modals = () => qa('[role="dialog"][aria-modal="true"]').filter((d) => vis(d) && inFlow(d));
  const sheets = () => qa('dialog[open][aria-modal="true"]').filter((d) => vis(d) && inFlow(d));
  const rowInner = (id) => document.querySelector('[data-ttask-id="' + id + '"]');
  // 行句柄双策略：主用行标识属性（结构句柄，随产品演进），取不到时回落「夹具标题所在 li」——
  // 回落键是**门内夹具数据**而非产品文案，故仍不构成字面依赖；策略记入证据，壳滞后时能分清是哪条腿的锅。
  const rowByTitle = (needle) => (needle ? qa('li').filter((l) => vis(l) && text(l).indexOf(needle) >= 0)[0] || null : null);
  const row = (id, needle) => { const n = rowInner(id); if (n && n.closest) { const li = n.closest('li'); if (li) return li; } return rowByTitle(needle); };
  const rowHandle = (id, needle) => (rowInner(id) ? 'data-ttask-id' : (rowByTitle(needle) ? 'fixture-row-text' : 'none'));
  const deepBtns = (el) => (el ? qa('button', el).filter(vis) : []);
  const entry = (id, prefix, needle) => {
    const r = row(id, needle);
    if (!r) return null;
    const byLabel = qa('button', r).filter((b) => (b.getAttribute('aria-label') || '').indexOf(prefix) === 0)[0];
    if (byLabel) return byLabel;
    const svgs = qa('button svg', r).map((g) => g.parentNode);
    for (const b of svgs) {
      const cls = Array.prototype.map.call(b.querySelectorAll('svg'), (s) => String(s.getAttribute('class') || '')).join(' ');
      if (cls.indexOf('panel-right') >= 0) return b;
    }
    return null;
  };
  globalThis.__h = { qa, direct, vis, text, modals, sheets, rowInner, rowByTitle, row, rowHandle, entry, deepBtns,
    panel: (needle) => modals().filter((d) => text(d).indexOf(needle) >= 0)[0] || null,
    body: (d) => direct(d, 'DIV')[1] || null,
    tabBar: (b) => direct(b, 'DIV').filter((el) => direct(el, 'BUTTON').length >= 3)[0] || null,
    content: (bar) => (bar ? bar.nextElementSibling : null),
    // 标签页正文容器跨构建版本可能多包一层 DIV（HEAD renderXTab 各返回一个 DIV 包裹），
    // 编辑入口钮要认在「带直接子 BUTTON 的那一层」——先就地判定，不猜层数。
    view: (c) => { if (!c) return null; if (direct(c, 'BUTTON').length > 0) return c; return direct(c, 'DIV')[0] || c; },
    editEntry: (c) => direct(c, 'BUTTON')[0] || null,
    thumbs: (c) => qa('button', c).filter((b) => b.children.length === 1 && b.firstElementChild && b.firstElementChild.tagName === 'IMG'),
    // 选择器触发钮/选项行只按**属性**认（跨构建版本稳定）：HEAD 选项行为 div[role=button]，早期壳为原生 button，
    // 两者都带 aria-pressed；选项行再以「项目名清单」认领——名单来自门内自建夹具与 API 列表（数据，不是产品文案），
    // 既避免把页面其它 aria-pressed 控件（Tab/筛选）算进来，也不依赖面板是否渲染在触发钮子树内（portal 友好）。
    picker: () => qa('[aria-haspopup="listbox"]').filter(vis)[0] || null,
    options: (names) => {
      const all = qa('[aria-pressed]').filter(vis);
      const list = Array.isArray(names) ? names : [];
      if (list.length === 0) return all;
      return all.filter((e) => list.some((n) => n && text(e).indexOf(n) >= 0));
    },
    // 面板入口按「带 aria-expanded 的可见钮」认领（不锁死图标层结构：不同构建里 SVG 可能包在一层 span 下），
    // 是否命中由**效果**判定——点开某枚后页面出现含夹具用例标题的 section，才算用例面板入口。
    // 面板开关钮：带 aria-expanded 但**不带** aria-haspopup 的按钮——haspopup 那两枚是选择器/排序菜单，
    // 点开的是浮层而非面板，混进来会让「逐枚试开」把真正的面板钮挤到候选队列末尾而漏点。
    iconToggles: () => qa('button[aria-expanded]').filter((b) => vis(b) && !b.hasAttribute('aria-haspopup')),

    sections: () => qa('section').filter(vis),
    // 跨构建版本的「面板根」认定：先按夹具串定位到最小可见节点（标题字身），再沿祖先链找第一枚
    // 「上边框 solid ≈1px」的盒子——判据不认标签名（HEAD 写成 <section>，早期壳写成 div），
    // 只认「含该串的面板确实有一圈 accent 描边」这个可观测效果。
    anchorIn: (needle) => {
      const hit = (e) => String(e.textContent || '').indexOf(needle) >= 0
        || (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && String(e.value || '').indexOf(needle) >= 0);
      const hits = qa('*').filter((e) => hit(e) && vis(e));
      let best = null, ba = Infinity;
      for (const e of hits) { const r = e.getBoundingClientRect(); const ar = r.width * r.height; if (ar > 0 && ar < ba) { ba = ar; best = e; } }
      return best;
    },
    borderedAncestor: (el) => {
      // 面板根的认定顺序：① 最近的**分段/地标元素**（section/main/aside/article/form/fieldset/dialog——
      // HEAD 与早期壳的用例面板根都是 <section>，这是 DOM 结构判据，不是类名也不是文案）；
      // ② 取不到才回落到「向上第一枚有实际描边的祖先」，并显式跳过表格构件与输入控件——
      //    否则 <tr> 的 0.67px 浅灰行边框会先被当成面板描边（实测踩过），把描边判据指向错的盒子。
      if (!el) return null;
      let n = el.closest ? el.closest('section,main,aside,article,form,fieldset,dialog,[role="dialog"]') : null;
      let hops = 0;
      if (!n) {
        n = el.parentElement; hops = 1;
        while (n && hops <= 10) {
          if (!/^(TR|TD|TH|TABLE|INPUT|TEXTAREA|SELECT)$/.test(n.tagName)) {
            const c = getComputedStyle(n); const w = parseFloat(c.borderTopWidth); const col = String(c.borderTopColor);
            const seeThrough = col === 'transparent' || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(col);
            if (w >= 0.5 && w <= 1.5 && c.borderTopStyle === 'solid' && !seeThrough) break;
          }
          n = n.parentElement; hops++;
        }
      }
      if (!n) return null;
      const c = getComputedStyle(n);
      return { w: parseFloat(c.borderTopWidth), style: c.borderTopStyle, color: String(c.borderTopColor), hops, tag: n.tagName };
    },
    titleSpan: (id, needle) => { const n = rowInner(id) || rowByTitle(needle); if (!n) return null; return qa('[role="button"]', n).filter((s) => text(s).indexOf(needle) >= 0)[0] || null; },
  };
  return true;
})()`;

const PRESEED = `(() => {
  try {
    const keys = ${JSON.stringify(GUIDE_KEYS)};
    for (const k of keys) localStorage.setItem(k, '1');
    // 注意：这里**不清理** mtask.uiMode——本脚本会在同一实例上切到移动布局后整页重载，
    // 预种脚本每个新文档都跑一遍，若在此抹掉偏好，重载后立刻弹回桌面布局（实测红因）。
  } catch (e) { /* 忽略 */ }
  ${PAGE_HELPERS}
  return true;
})()`;

let ws = null;
for (let i = 0; i < 90 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && String(t.url || '').startsWith('app://'));
    if (page) {
      const cand = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        const t = setTimeout(() => { try { cand.close(); } catch { /* */ } rej(new Error('timeout')); }, 15000);
        cand.addEventListener('open', () => { clearTimeout(t); res(); });
        cand.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); });
      });
      ws = cand;
    }
  } catch { /* 未就绪：重试 */ }
  if (!ws) await sleep(400);
}
if (!ws) {
  check('E-00 CDP 附着到 app:// renderer', false, { cdp: CDP });
  console.log('\n结果：PASS=0 FAIL=1（CDP 未就绪，终止）');
  cleanup();
  process.exit(1);
}
let seq = 0;
const pending = new Map();
// CDP 通道兜底：实测出现过「renderer/主进程都正常、唯独门侧这条命令永远不回的」僵尸挂起（14 分钟零输出、
// 进程不退出、临时目录不回收）。挂起不是判据，必须变成带名字的红：每条命令限时，超时/断链即整批拒掉，
// 由 uncaughtException 收口（cleanup 连进程树回收 + 临时根清理）。
const CDP_TIMEOUT_MS = Number(argOf('cdp-timeout', process.env.VERIFY_SHELL_CDP_TIMEOUT || '30000'));
let lastCall = '';
const abortPending = (why) => { pending.forEach((res, id) => { pending.delete(id); res({ id, __dropped: why }); }); };
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
ws.addEventListener('close', () => abortPending('CDP 连接已关闭'));
ws.addEventListener('error', () => abortPending('CDP 连接报错'));
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  lastCall = method;
  const timer = setTimeout(() => {
    pending.delete(id);
    rej(new Error(`CDP ${method} 在 ${CDP_TIMEOUT_MS}ms 内无响应（页面仍在、通道失联或渲染进程被阻塞）｜最后一条命令=${lastCall}`));
  }, CDP_TIMEOUT_MS);
  pending.set(id, (m) => { clearTimeout(timer); if (m.__dropped) return rej(new Error(`CDP ${method} 未获响应：${m.__dropped}`)); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const mark = (s) => console.log(`  · ${s}`);
async function R(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('页面异常 ' + JSON.stringify(r.result.exceptionDetails.exception?.description || '').slice(0, 240));
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result) { mkdirSync(SHOTS_DIR, { recursive: true }); writeFileSync(path.join(SHOTS_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64')); shots.push(name); }
}
async function until(expr, ms = 15000, every = 300) {
  const t0 = Date.now();
  for (;;) { const v = await R(expr); if (v === true) return true; if (Date.now() - t0 > ms) return false; await sleep(every); }
}
async function mouse(x, y, type, buttons) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: buttons ?? 0 }); }
async function clickPoint(x, y) { await mouse(x, y, 'mouseMoved'); await mouse(x, y, 'mousePressed'); await mouse(x, y, 'mouseReleased'); }
async function tap(expr) { return R(`(() => { const el = ${expr}; if (el && typeof el.click === 'function') { el.click(); return true; } return false; })()`); }
// typeInto：原生 value setter + input 事件（React 受控组件；Input.insertText 依赖已有焦点，实测静默丢字）
async function typeInto(expr, text) {
  return R(`(() => {
    const el = ${expr};
    if (!el) return false;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    d.set.call(el, String(el.value) + ${JSON.stringify(String(text))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
async function pressKey(key, vk) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
await send('Page.enable');
await send('Runtime.enable');
// 原生 alert/confirm 会阻塞渲染进程（TasksPage 错误分支会 alert）——自动接受，避免整轮挂死
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: PRESEED });
await send('Page.reload');
await sleep(6000);
// 首屏挂载就绪：结构判据（应用外壳的导航钮数）——不达标直接终止，
// 否则后续每条行为腿都会以「句柄取空」的形态报红，把一次环境失败伪装成二十条功能失守。
const mounted = await until('!!globalThis.__h && __h.qa("button").filter(__h.vis).length >= 5', 45000);
EV.mountedButtonCount = Number(await R('__h.qa("button").filter(__h.vis).length'));
if (!mounted) {
  check('E-00 壳内 renderer 挂载就绪（可见 BUTTON ≥5）', false, { 可见按钮: EV.mountedButtonCount, href: String(await R('location.href')) });
  console.log('\n结果：PASS=1 FAIL=1（首屏未挂载，终止——不铺开假红）');
  cleanup();
  process.exit(1);
}

EV.href = String(await R('location.href'));
mark(`首屏挂载就绪 href=${EV.href}`);
const ENTRY_PREFIX = '展开详情抽屉'; // 仅作定位策略 1；判据不认它（策略 2 为图标类名，取证见 P-05 字面腿）

// ---------- 首屏：向导不拦截 ----------
EV.modalCountAtStart = Number(await R('__h.modals().length'));
EV.sheetCountAtStart = Number(await R('__h.sheets().length'));
EV.nativeDialogOpenAtStart = Number(await R('__h.qa("dialog[open]").length'));
EV.guideKeyCount = GUIDE_KEYS.length;

// ---------- 任务页：选项目 → 夹具行 ----------
mark('项目选择器 → 夹具行');
const NAMES = JSON.stringify(PROJ_NAMES);
const PICKER = '__h.picker()';
EV.pickerFound = (await R(`!!${PICKER}`)) === true;
await until(`!!${PICKER}`, 25000);
EV.pickerFound = (await R(`!!${PICKER}`)) === true;
if (EV.pickerFound) {
  await R(`(() => { const b = ${PICKER}; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
  await sleep(1200);
  EV.pickerExpanded = (await R(`(() => { const b = ${PICKER}; return b.getAttribute('aria-expanded') === 'true'; })()`)) === true;
  EV.optionRowCount = Number(await R(`__h.options(${NAMES}).length`));
  EV.pressedOptionCount = Number(await R(`__h.options(${NAMES}).filter((e) => e.getAttribute('aria-pressed') === 'true').length`));
  EV.optionMatchesFixture = (await R(`__h.options(${NAMES}).some((e) => __h.text(e).indexOf(${JSON.stringify(PROJ_NAME)}) >= 0)`)) === true;
  await R(`(() => { const o = __h.options(${NAMES}).filter((e) => __h.text(e).indexOf(${JSON.stringify(PROJ_NAME)}) >= 0)[0]; if (o) o.click(); return !!o; })()`);
  EV.rowAfterPick = await until(`!!__h.row(${JSON.stringify(TASK_ID)}, ${JSON.stringify(FIX_TITLE)})`, 25000);
}
const ROW = `__h.row(${JSON.stringify(TASK_ID)}, ${JSON.stringify(FIX_TITLE)})`;
EV.rowHandleStrategy = String(await R(`__h.rowHandle(${JSON.stringify(TASK_ID)}, ${JSON.stringify(FIX_TITLE)})`));
EV.rowFound = (await R(`!!${ROW}`)) === true;
EV.rowIsLi = (await R(`(() => { const r = ${ROW}; return !!r && r.tagName === 'LI'; })()`)) === true;
EV.rowTitleMatches = (await R(`(() => { const r = ${ROW}; return !!r && __h.text(r).indexOf(${JSON.stringify(FIX_TITLE)}) >= 0; })()`)) === true;
// 夹具行是后续全部桌面腿的入场券（抽屉、编辑、放大、框选都挂在它上面）。取不到行说明列表/选择器这一层就断了，
// 此时逐条铺开只会得到二十条「句柄取空」的同源红——直接终止并把选择器实证打全，红因一眼可辨。
EV.fixtureRowReachable = EV.rowFound === true;
if (!EV.fixtureRowReachable) {
  check('E-00b 列表内可达夹具行（项目选择器 → 行句柄）', false,
    { 选择器: EV.pickerFound, 展开: EV.pickerExpanded, 选项行: EV.optionRowCount, 选中态: EV.pressedOptionCount, 含夹具项目: EV.optionMatchesFixture, 行策略: EV.rowHandleStrategy });
  console.log('\n结果：PASS=1 FAIL=1（夹具行不可达，终止——不再铺开同源假红）');
  cleanup();
  process.exit(1);
}
const ENTRY = `__h.entry(${JSON.stringify(TASK_ID)}, ${JSON.stringify(ENTRY_PREFIX)}, ${JSON.stringify(FIX_TITLE)})`;
EV.entryFound = (await R(`!!${ENTRY}`)) === true;
EV.entryStrategy = String(await R(`(() => { const e = ${ENTRY}; if (!e) return 'none'; return (e.getAttribute('aria-label') || '').indexOf(${JSON.stringify(ENTRY_PREFIX)}) === 0 ? 'accessible-name' : 'icon-class'; })()`));

// ---------- 抽屉：开 → 结构 → 三种关闭 + 焦点归还（必须排在任何保存之前）----------
mark('抽屉开合三态 + 焦点归还');
async function openDrawer() {
  const p = await R(`(() => { const el = ${ENTRY}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (p) await mouse(p.x, p.y, 'mouseMoved'); // 行工具栏靠 :hover/:focus-within 撑开，未 hover 时 focus() 静默失败
  await sleep(160);
  await R(`(() => { const el = ${ENTRY}; if (!el) return false; el.focus(); el.click(); return true; })()`);
  return await until('__h.modals().length === 1', 12000);
}
const DRAWER = `__h.panel(${JSON.stringify(FIX_TITLE)})`;
const DBODY = `__h.body(${DRAWER})`;
const TABBAR = `__h.tabBar(${DBODY})`;
const CONTENT = `__h.content(${TABBAR})`;
const VIEW = `__h.view(${CONTENT})`;

await openDrawer();
await sleep(300);
EV.modalCountWhileOpen = Number(await R('__h.modals().length'));
EV.drawerHasFixture = (await R(`!!${DRAWER}`)) === true;
EV.drawerTitleIsAria = (await R(`(() => { const d = ${DRAWER}; if (!d) return false; const lid = d.getAttribute('aria-labelledby'); return !!lid && !!document.getElementById(lid); })()`)) === true;
EV.drawerTitleText = String(await R(`(() => { const d = ${DRAWER}; if (!d) return ''; const lid = d.getAttribute('aria-labelledby'); const h = lid ? document.getElementById(lid) : null; return h ? __h.text(h) : ''; })()`));
EV.headerButtonCount = Number(await R(`(() => { const d = ${DRAWER}; if (!d) return -1; const head = __h.direct(d, 'DIV')[0]; return __h.direct(head, 'BUTTON').length; })()`));
EV.tabCount = Number(await R(`(() => { const b = ${TABBAR}; return b ? __h.direct(b, 'BUTTON').length : -1; })()`));
EV.tabDescendantCount = Number(await R(`(() => { const b = ${DBODY}; return b ? __h.qa('button', b).length : -1; })()`));
// 逐页点击：正文文本取样（判据只认「五页正文互不相同 + 描述页含夹具描述 + 某页含夹具结果」）
const bodies = [];
const tabCount = Number(EV.tabCount);
for (let i = 0; i < tabCount; i++) {
  await R(`(() => { const b = ${TABBAR}; const bs = __h.direct(b, 'BUTTON'); if (bs[${i}]) bs[${i}].click(); return true; })()`);
  await sleep(500);
  bodies.push(String(await R(`(() => { const c = ${CONTENT}; return c ? __h.text(c).slice(0, 400) : ''; })()`)));
}
EV.tabBodiesDistinct = new Set(bodies.map((x) => x.replace(/\s+/g, ' '))).size;
EV.descTabHasFixtureDesc = bodies.some((x) => x.includes(DESC0));
EV.resultTabHasFixtureResult = bodies.some((x) => x.includes(RESULT0));
await shot('a-drawer');

async function focusBackOnEntry() {
  return (await R(`(() => { const e = ${ENTRY}; const a = document.activeElement; return !!e && a === e; })()`)) === true;
}
// 1) 遮罩点按
const panelLeft = Number(await R(`(() => { const d = ${DRAWER}; return d ? Math.round(d.getBoundingClientRect().left) : -1; })()`));
const vp = await R('({ w: window.innerWidth, h: window.innerHeight })');
await clickPoint(Math.max(6, panelLeft - 40), Math.round(vp.h * 0.5));
await sleep(900);
EV.maskClosed = (await R('__h.modals().length === 0')) === true;
EV.bodyTextKeepsFixtureWhenClosed = (await R(`(() => document.body.innerText.indexOf(${JSON.stringify(FIX_TITLE)}) >= 0)()`)) === true;
EV.visibleModalTextEmptyWhenClosed = (await R(`__h.modals().map((d) => __h.text(d)).join("").indexOf(${JSON.stringify(FIX_TITLE)}) < 0`)) === true;
EV.focusAfterMask = await focusBackOnEntry();
// 2) 关闭钮
await openDrawer();
EV.closeBtnFound = (await R(`(() => { const d = ${DRAWER}; if (!d) return false; const head = __h.direct(d, 'DIV')[0]; return __h.direct(head, 'BUTTON').length === 1; })()`)) === true;
await R(`(() => { const d = ${DRAWER}; const head = d ? __h.direct(d, 'DIV')[0] : null; const b = head ? __h.direct(head, 'BUTTON')[0] : null; if (b) b.click(); return !!b; })()`);
EV.closeBtnClosed = await until('__h.modals().length === 0', 10000);
EV.focusAfterCloseBtn = await focusBackOnEntry();
// 3) ESC
await openDrawer();
await pressKey('Escape', 27);
await sleep(900);
EV.escClosed = (await R('__h.modals().length === 0')) === true;
EV.focusAfterEsc = await focusBackOnEntry();

// ---------- 描述就地编辑（首钮取消不落库、末钮保存落库）----------
mark('描述就地编辑（取消不落库 / 保存落库）');
await openDrawer();
// 标签页选择按**索引**（索引由上一轮逐页正文取样反推：哪一页的正文含夹具描述/结果），
// 不靠标签文字——产品改文案不该让门红，夹具数据是门自己的，可以放心当认领依据。
const idxOfDesc = bodies.findIndex((x) => x.includes(DESC0));
const idxOfResult = bodies.findIndex((x) => x.includes(RESULT0));
const clickTab = async (i) => { await R(`(() => { const b = ${TABBAR}; const bs = __h.direct(b, 'BUTTON'); if (bs[${i}]) bs[${i}].click(); return !!bs[${i}]; })()`); await sleep(600); };
await clickTab(idxOfDesc >= 0 ? idxOfDesc : 0);
EV.descViewButtons = Number(await R(`(() => { const v = ${VIEW}; return v ? __h.direct(v, 'BUTTON').length : -1; })()`));
await R(`(() => { const v = ${VIEW}; const b = __h.direct(v, 'BUTTON')[0]; if (b) b.click(); return !!b; })()`);
await sleep(450);
EV.editorOpened = (await R(`!!${CONTENT} && !!__h.qa('textarea', ${CONTENT})[0]`)) === true;
EV.textareaCount = Number(await R(`(() => { const c = ${CONTENT}; return c ? __h.qa('textarea', c).length : -1; })()`));
const TA = `__h.qa('textarea', ${CONTENT})[0]`;
EV.editRowButtons = Number(await R(`(() => { const t = ${TA}; if (!t) return -1; const row = t.nextElementSibling; return row ? __h.direct(row, 'BUTTON').length : -1; })()`));
await typeInto(TA, DESC_APPEND);
await sleep(350);
await R(`(() => { const t = ${TA}; const row = t ? t.nextElementSibling : null; const bs = row ? __h.direct(row, 'BUTTON') : []; if (bs[0]) bs[0].click(); return bs.length; })()`);
await sleep(700);
EV.cancelClosedEditor = (await R(`!__h.qa('textarea', ${CONTENT})[0]`)) === true;
EV.displayAfterCancel = String(await R(`(() => { const c = ${CONTENT}; return c ? __h.text(c).slice(0, 300) : ''; })()`));
const readServerTask = async () => {
  const list = await api('GET', `/tasks?projectId=${PROJECT}&limit=500`).catch(() => []);
  return Array.isArray(list) ? list.find((x) => x.id === TASK_ID) ?? {} : {};
};
EV.serverAfterCancel = String((await readServerTask()).description ?? '');
await R(`(() => { const v = ${VIEW}; const b = __h.direct(v, 'BUTTON')[0]; if (b) b.click(); return !!b; })()`);
await sleep(500);
await typeInto(TA, DESC_APPEND);
await sleep(350);
const savedOk = await R(`(() => { const t = ${TA}; const row = t ? t.nextElementSibling : null; const bs = row ? __h.direct(row, 'BUTTON') : []; if (bs.length < 2) return false; bs[bs.length - 1].click(); return true; })()`);
EV.saveClicked = savedOk === true;
await until(`(() => { const c = ${CONTENT}; return !!c && __h.text(c).indexOf(${JSON.stringify(DESC_APPEND)}) >= 0; })()`, 12000);
EV.displayAfterSave = String(await R(`(() => { const c = ${CONTENT}; return c ? __h.text(c).slice(0, 300) : ''; })()`));
EV.serverAfterSave = String((await readServerTask()).description ?? '');

// ---------- 附件点击放大（T01563：flex 宽度塌陷复验）----------
mark('附件点击放大');
EV.thumbCount = Number(await R(`(() => { const c = ${CONTENT}; return c ? __h.thumbs(c).length : -1; })()`));
const THUMB_BTN = `__h.thumbs(${CONTENT})[0]`;
const THUMB_IMG = `(() => { const b = ${THUMB_BTN}; return b ? b.firstElementChild : null; })()`;
const imgW = async () => Number(await R(`(() => { const el = ${THUMB_IMG}; return el ? Math.round(el.getBoundingClientRect().width) : -1; })()`));
EV.thumbBeforeW = await imgW();
await R(`(() => { const b = ${THUMB_BTN}; if (b) b.click(); return !!b; })()`);
await sleep(600);
EV.thumbAfterW = await imgW();
EV.thumbZoomIsAccent = (await R(`(() => {
  const el = ${THUMB_IMG}; if (!el) return false;
  const probe = document.createElement('div');
  probe.style.borderColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  document.body.appendChild(probe);
  const want = getComputedStyle(probe).borderTopColor;
  probe.remove();
  return getComputedStyle(el).borderTopColor === want;
})()`)) === true;
await shot('b-attach-zoom');
await R(`(() => { const b = ${THUMB_BTN}; if (b) b.click(); return !!b; })()`);
await sleep(500);
EV.thumbCollapseW = await imgW();

// ---------- 处理结果就地编辑（结果页，末钮落库）----------
mark('结果页就地编辑');
await clickTab(idxOfResult >= 0 ? idxOfResult : 1);
EV.resultViewButtons = Number(await R(`(() => { const v = ${VIEW}; return v ? __h.direct(v, 'BUTTON').length : -1; })()`));
await R(`(() => { const v = ${VIEW}; const b = __h.direct(v, 'BUTTON')[0]; if (b) b.click(); return !!b; })()`);
await sleep(500);
EV.resultEditorOpened = (await R(`!!__h.qa('textarea', ${CONTENT})[0]`)) === true;
const TA2 = `__h.qa('textarea', ${CONTENT})[0]`;
await typeInto(TA2, RESULT_APPEND);
await sleep(350);
await R(`(() => { const t = ${TA2}; const row = t ? t.nextElementSibling : null; const bs = row ? __h.direct(row, 'BUTTON') : []; if (bs.length) bs[bs.length - 1].click(); return bs.length; })()`);
await until(`(() => { const c = ${CONTENT}; return !!c && __h.text(c).indexOf(${JSON.stringify(RESULT_APPEND)}) >= 0; })()`, 12000);
EV.displayAfterResultSave = String(await R(`(() => { const c = ${CONTENT}; return c ? __h.text(c).slice(0, 300) : ''; })()`));
EV.serverResultAfterSave = String((await readServerTask()).handle_result ?? '');
await shot('c-result-saved');

// ---------- 标题框选（T01533）：先关抽屉，行内标题才可见 ----------
mark('标题框选');
await pressKey('Escape', 27);
await sleep(800);
const TITLE_SPAN = `__h.titleSpan(${JSON.stringify(TASK_ID)}, ${JSON.stringify(FIX_TITLE)})`;
EV.titleUserSelect = String(await R(`(() => { const b = ${TITLE_SPAN}; return b ? getComputedStyle(b).userSelect : 'NF'; })()`));
const tb = await R(`(() => { const b = ${TITLE_SPAN}; if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x1: Math.round(r.left + 3), x2: Math.round(r.right - 3), y: Math.round(r.top + r.height / 2) }; })()`);
if (tb) {
  await R('document.getSelection().removeAllRanges(); true');
  await mouse(tb.x1, tb.y, 'mouseMoved');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tb.x1, y: tb.y, button: 'left', clickCount: 1 });
  for (let x = tb.x1; x <= tb.x2; x += 12) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: tb.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tb.x2, y: tb.y, button: 'left', clickCount: 1 });
  await sleep(400);
  EV.selectionText = String(await R('String(document.getSelection() || "")'));
  await shot('d-title-select');
  await R('document.getSelection().removeAllRanges(); true');
}

// ---------- 计划页：跨页导航事件 → 选项目 → 用例面板 → 视图切换 → 时间线折叠 ----------
mark('计划页导航 → 选择器 → 用例面板 → 视图切换 → 时间线');
const navTo = async (tab) => { await R(`(() => { globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: ${JSON.stringify(tab)} } })); return true; })()`); await sleep(2500); };
await navTo('plan');
const planPicker = '__h.picker()';
EV.planPickerFound = (await R(`!!${planPicker}`)) === true;
EV.navPlanStruct = (await R(`(() => { const f = __h.qa('fieldset').filter((x) => __h.vis(x)); const p = ${planPicker}; return !!p && f.length === 1 && __h.direct(f[0], 'BUTTON').length === 3; })()`)) === true;
await R(`(() => { const b = ${planPicker}; if (b) b.click(); return !!b; })()`);
await sleep(1200);
EV.planOptionFound = (await R(`__h.options(${NAMES}).some((e) => __h.text(e).indexOf(${JSON.stringify(PROJ_NAME)}) >= 0)`)) === true;
await R(`(() => { const o = __h.options(${NAMES}).filter((e) => __h.text(e).indexOf(${JSON.stringify(PROJ_NAME)}) >= 0)[0]; if (o) o.click(); return !!o; })()`);
EV.planListHasFixture = await until(`document.body.innerText.indexOf(${JSON.stringify(PL_TITLE)}) >= 0`, 20000);

// 用例面板入口按效果认定：逐枚「aria-expanded 且非 haspopup」钮点开，看含夹具用例标题的可见节点是否出现，
// 再从该节点沿祖先链取第一枚「上边框 solid ≈1px」的盒子作为面板根（HEAD 是 <section>，早期壳是 div——
// 判据只认描边效果，不认标签名，两种构建同判）。
const CASE_T = JSON.stringify(CASE_TITLE);
EV.panelToggleCandidates = Number(await R('__h.iconToggles().length'));
for (let i = 0; i < Math.min(Number(EV.panelToggleCandidates) || 0, 8); i++) {
  await R('window.__t0 = document.body.innerText; true');
  const opened = await R(`(() => { const bs = __h.iconToggles(); const b = bs[${i}]; if (!b) return 'missing'; b.click(); return 'clicked'; })()`);
  if (opened !== 'clicked') break;
  await sleep(900);
  // 逐枚留痕（aria-label 只作**证据**，判据不认它）：红时能分清「面板钮根本没点开」「点开了但面板为空」
  // 与「面板有内容但里面没有这条用例」——故把点开后**新增出来的那段正文**原样带回来。
  EV.panelTrail.push(await R(`(() => {
    const b = __h.iconToggles()[${i}]; if (!b) return { 序: ${i}, 钮: 'missing' };
    const before = String(window.__t0 || ''), after = document.body.innerText;
    let k = 0; while (k < before.length && before[k] === after[k]) k++;
    const inValue = Array.prototype.slice.call(document.querySelectorAll('input,textarea'))
      .some((el) => String(el.value || '').indexOf(${CASE_T}) >= 0);
    return { 钮: String(b.getAttribute('aria-label') || b.textContent || '').slice(0, 18), 展开: b.getAttribute('aria-expanded'),
      正文含用例: after.indexOf(${CASE_T}) >= 0, 输入框含用例: inValue, 新增字数: after.length - before.length, 新增片段: after.slice(k, k + 600) };
  })()`) || { 序: i, 钮: 'missing' });
  const hit = (await R(`!!__h.anchorIn(${CASE_T})`)) === true;
  if (hit) { EV.panelToggleHitIndex = i; break; }
  await R(`(() => { const bs = __h.iconToggles(); const b = bs[${i}]; if (b) b.click(); return true; })()`); // 收起再试下一枚
  await sleep(500);
}
const caseAnchor = await R(`(() => { const a = __h.anchorIn(${CASE_T}); return !!a; })()`);
mark('用例面板逐钮留痕 ' + JSON.stringify(EV.panelTrail).slice(0, 2600));
EV.panelHasFixtureCase = caseAnchor === true;
const panelRoot = await R(`(() => { const a = __h.anchorIn(${CASE_T}); if (!a) return null; const r = __h.borderedAncestor(a); return r ? Object.assign({ anchorTag: a.tagName }, r) : null; })()`);
EV.panelSectionTotal = Number(await R('__h.sections().length'));
EV.panelCaseInBody = (await R(`document.body.innerText.indexOf(${CASE_T}) >= 0`)) === true;
EV.panelRootTag = panelRoot ? String(panelRoot.tag) : 'none';
EV.panelRootHops = panelRoot ? Number(panelRoot.hops) : -1;
EV.accentRgb = String(await R(`(() => { const d = document.createElement('div'); d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; })()`));
if (panelRoot) { EV.panelBorderW = panelRoot.w; EV.panelBorderStyle = panelRoot.style; EV.panelBorderColor = panelRoot.color; }
EV.panelSectionFound = !!panelRoot && EV.panelHasFixtureCase === true;
await shot('e-case-panel');

// 视图切换 → 时间线（fieldset 直接子第 3 枚）
// 时间线行句柄用 `[data-tl]`（跨构建版本稳定），**归属**认「夹具标题落在哪一行的正文里」。
// HEAD 另有 data-plan-id 可直连对号，早期壳没有该属性——两种构建都能认的判据只有夹具文本，
// 而夹具标题是门内自建数据（判据 2），不构成产品文案依赖。
// 时间线**行**句柄：带 `data-tl` 的元素里排除 BUTTON——折叠钮与关联角标自身也带 data-tl（HEAD 把它们
// 做成真 <button> 放在卡旁），按 [data-tl] 直取会把控件当成行、归属永远对不上；行的标签名两种构建
// 并不一致（HEAD 为 li，早期壳另有写法），故只按「非按钮的 data-tl 承载体 + 夹具标题在其中」认行。
const TL_ROWS = `__h.qa('[data-tl]').filter((x) => __h.vis(x) && x.tagName !== 'BUTTON')`;
const MS_T = JSON.stringify(MS_TITLE);
const PL_T = JSON.stringify(PL_TITLE);
// 视图切换：逐枚点 fieldset 直接子钮，直到出现 `[data-tl]` 行——按效果认「哪一枚是时间线视图」，
// 不假设视图顺序（顺序变了门不该红）。
EV.viewFieldsetCount = Number(await R(`__h.qa('fieldset').filter((x) => __h.vis(x)).length`));
EV.viewButtonCount = Number(await R(`(() => { const f = __h.qa('fieldset').filter((x) => __h.vis(x))[0]; return f ? __h.direct(f, 'BUTTON').length : -1; })()`));
let timelineBtnIndex = -1;
for (let i = 0; i < Math.min(Number(EV.viewButtonCount) || 0, 4); i++) {
  await R(`(() => { const f = __h.qa('fieldset').filter((x) => __h.vis(x))[0]; const bs = f ? __h.direct(f, 'BUTTON') : []; if (bs[${i}]) bs[${i}].click(); return !!bs[${i}]; })()`);
  await sleep(1200);
  const n = Number(await R(`${TL_ROWS}.length`));
  if (n > 0) { timelineBtnIndex = i; break; }
}
EV.timelineBtnIndex = timelineBtnIndex;
EV.timelineFound = await until(`(() => { const rows = ${TL_ROWS}; return rows.filter((r) => __h.text(r).indexOf(${MS_T}) >= 0).length > 0 && rows.filter((r) => __h.text(r).indexOf(${PL_T}) >= 0).length > 0; })()`, 20000);
const tlProbe = await R(`(() => {
  const rows = () => ${TL_ROWS};
  const ms = rows().filter((r) => __h.text(r).indexOf(${MS_T}) >= 0);
  const item = rows().filter((r) => __h.text(r).indexOf(${PL_T}) >= 0);
  const badge = document.querySelector('[data-tl="jump-linked"]');
  // 归属从**父级**向上找行：控件自身带 data-tl，closest('[data-tl]') 会命中它自己而不是行。
  const badgeRow = badge && badge.parentElement && badge.parentElement.closest ? badge.parentElement.closest('[data-tl]') : null;
  const collapse = document.querySelector('[data-tl="collapse"]');
  const collapseRow = collapse && collapse.parentElement && collapse.parentElement.closest ? collapse.parentElement.closest('[data-tl]') : null;
  return {
    ms: ms.length, item: item.length,
    badgeTotal: document.querySelectorAll('[data-tl="jump-linked"]').length,
    collapseTotal: document.querySelectorAll('[data-tl="collapse"]').length,
    badgeOnPlanRow: !!badgeRow && __h.text(badgeRow).indexOf(${PL_T}) >= 0,
    collapseOnMsRow: !!collapseRow && __h.text(collapseRow).indexOf(${MS_T}) >= 0,
    msCollapsedAttr: collapseRow ? collapseRow.getAttribute('data-tl-collapsed') : null,
  };
})()`);
EV.tlMsRows = tlProbe ? tlProbe.ms : -1;
EV.tlItemRows = tlProbe ? tlProbe.item : -1;
EV.jumpBadgeOnFixturePlan = tlProbe ? tlProbe.badgeOnPlanRow === true : false;
EV.tlBadgeTotal = tlProbe ? Number(tlProbe.badgeTotal) : -1;
EV.tlCollapseTotal = tlProbe ? Number(tlProbe.collapseTotal) : -1;
EV.collapseOnFixtureMs = tlProbe ? tlProbe.collapseOnMsRow === true : false;
// 折叠牙齿：点夹具里程碑行的折叠钮 → 夹具计划行不再可见；再点复原（判据只看可见性，不认属性写法）
const childVisible = async () => (await R(`(() => { const r = ${TL_ROWS}.filter((x) => __h.text(x).indexOf(${PL_T}) >= 0)[0]; return !!r && __h.vis(r); })()`)) === true;
const msRowCollapse = `(() => { const r = ${TL_ROWS}.filter((x) => __h.text(x).indexOf(${MS_T}) >= 0)[0]; if (!r) return null; const b = __h.qa('[data-tl="collapse"]', r)[0] || document.querySelector('[data-tl="collapse"]'); return b; })()`;
const beforeChild = await childVisible();
const msCollapsedAttr = async () => String(await R(`(() => { const r = ${TL_ROWS}.filter((x) => __h.text(x).indexOf(${MS_T}) >= 0)[0]; return r ? String(r.getAttribute('data-tl-collapsed')) : 'NF'; })()`));
const attrBefore = await msCollapsedAttr();
await R(`(() => { const b = ${msRowCollapse}; if (b) b.click(); return !!b; })()`);
await sleep(700);
const afterChild = await childVisible();
// 折叠生效的两条可观测面：子行可见性翻转（跨版本都成立），或折叠态属性发生变化（HEAD 写法）——
// 任一成立即认定「点下去确实改变了折叠态」，不拿属性写法当唯一判据。
EV.collapseFlipped = (beforeChild !== afterChild) || (await msCollapsedAttr()) !== attrBefore;
EV.childHiddenAfterCollapse = beforeChild === true && afterChild === false;
await R(`(() => { const b = ${msRowCollapse}; if (b) b.click(); return !!b; })()`);
await sleep(700);
EV.expandRestored = await childVisible();
await shot('f-timeline');

await navTo('tasks');
EV.navBackTaskStruct = (await R(`!!__h.row(${JSON.stringify(TASK_ID)}, ${JSON.stringify(FIX_TITLE)})`)) === true;

// ---------- 移动端半屏（同因修复的第二处，必须实测）----------
mark('移动端半屏');
// resolveUiMode() 只在 touch && small 时自动进移动布局，桌面壳里压视口不生效——走显式偏好 + 整页重载
await R(`(() => { localStorage.setItem('mtask.uiMode', 'mobile'); return true; })()`);
EV.uiModeMobile = (await R(`localStorage.getItem('mtask.uiMode')`)) === 'mobile';
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
await send('Page.reload');
await sleep(7000);
await until('!!globalThis.__h && !!document.querySelector("header select")', 40000);
EV.headerSelectFound = (await R('!!document.querySelector("header select")')) === true;
await R(`(() => {
  const s = document.querySelector('header select');
  if (!s) return false;
  const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  d.set.call(s, ${JSON.stringify(PROJECT)});
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(3000);
const mRowProbe = await R(`(() => {
  const lis = __h.qa('li').filter((l) => __h.vis(l) && __h.text(l).indexOf(${JSON.stringify(FIX_TITLE)}) >= 0 && __h.deepBtns(l).length > 0);
  const li = lis[0];
  if (!li) return { found: false, buttons: -1, deep: -1 };
  return { found: true, buttons: __h.direct(li, 'BUTTON').length, deep: __h.deepBtns(li).length };
})()`);
EV.mobileRowFound = mRowProbe?.found === true;
EV.mobileRowButtons = mRowProbe ? mRowProbe.buttons : -1;
EV.mobileRowDeepButtons = mRowProbe ? mRowProbe.deep : -1;
EV.headerSelectSwitched = (await R(`(() => { const s = document.querySelector('header select'); return !!s && s.value === ${JSON.stringify(PROJECT)}; })()`)) === true;
// 半屏入口＝行内那枚「详情」钮：按**夹具标题出现在可访问名里**认领（详情钮 aria-label 内插了任务标题，
// 标题是门内夹具数据），比按位置取末钮稳，也不必认产品文案。
await R(`(() => {
  const b = __h.qa('button').filter((x) => __h.vis(x) && String(x.getAttribute('aria-label') || '').indexOf(${JSON.stringify(FIX_TITLE)}) >= 0)[0];
  if (b) b.click();
  return !!b;
})()`);
await sleep(1200);
EV.sheetVisible = (await R('__h.sheets().length === 1')) === true;
EV.sheetHasFixture = (await R(`__h.sheets().some((d) => __h.text(d).indexOf(${JSON.stringify(FIX_TITLE)}) >= 0)`)) === true;
const SHEET = `__h.sheets()[0]`;
EV.mThumbCount = Number(await R(`(() => { const d = ${SHEET}; return d ? __h.thumbs(d).length : -1; })()`));
const M_THUMB = `__h.thumbs(${SHEET})[0]`;
const M_IMG = `(() => { const b = ${M_THUMB}; return b ? b.firstElementChild : null; })()`;
const mImgW = async () => Number(await R(`(() => { const el = ${M_IMG}; return el ? Math.round(el.getBoundingClientRect().width) : -1; })()`));
EV.mThumbBeforeW = await mImgW();
await R(`(() => { const b = ${M_THUMB}; if (b) b.click(); return !!b; })()`);
await sleep(700);
EV.mThumbAfterW = await mImgW();
await shot('g-mobile-zoom');
await R(`(() => { const b = ${M_THUMB}; if (b) b.click(); return !!b; })()`);
await sleep(600);
EV.mThumbCollapseW = await mImgW();
await pressKey('Escape', 27);
await sleep(800);
EV.sheetClosed = (await R('__h.sheets().length === 0')) === true;
await send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

// ---------- ABI / 收尾 ----------
mark('收尾取数');
{
  const logPath = path.join(USER_DATA, 'server-startup.log');
  const startup = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  EV.startupLogSeen = startup.length > 0;
  EV.abiLogClean = !/ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(startup);
  EV.healthAfter = (await api('GET', '/projects').then((r) => (Array.isArray(r) ? r.length : -1)).catch(() => -1));
}

// ---------- 发射（实测全部落 EV 后再判定，反模式 14）----------
check('E-00 夹具链经 REST 建成 + 壳内后端就绪（判据 2：门内自建夹具）', EV.fixtureChainBuilt === true && serverUp, { chain: EV.fixtureChainBuilt, serverUp });
for (const s of SOLO) check(`${s.id} ${s.label}`, (() => { try { return s.fn() === true; } catch { return false; } })(), s.ctx ? s.ctx() : undefined);
const { okPair } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
for (const p of PAIRS) {
  okPair(check, `${p.id} ${p.label}`, p.behavior, () => p.anchors.every((k) => ANCHORS[k].literal(ANCHORS[k].src)), p.ctx);
}

// ---------- N 组负对照 ----------
{
  const keys = Object.keys(ANCHORS);
  check('N-01 空源码负对照：25 条字面腿全假（每条正则/包含式确实承重）',
    keys.every((k) => ANCHORS[k].literal('') === false), keys.filter((k) => ANCHORS[k].literal('') !== false));
  check('N-02 HEAD 在场性：25 个锚在各自 HEAD 文件中确实存在且判据为真（取证面非空）',
    keys.every((k) => ANCHORS[k].src.length > 0 && ANCHORS[k].src.includes(ANCHORS[k].needle) && ANCHORS[k].literal(ANCHORS[k].src) === true),
    keys.filter((k) => !(ANCHORS[k].src.length > 0 && ANCHORS[k].src.includes(ANCHORS[k].needle) && ANCHORS[k].literal(ANCHORS[k].src) === true)));
  const legs = allLegs();
  check(`N-02b 抽干运行期实测料：${legs.length} 条行为腿全假——行为腿确实在读实测，不是恒真`,
    legs.every((l) => withEV({}, l.fn) === false), legs.filter((l) => withEV({}, l.fn) !== false).map((l) => l.id));
  check('N-02c 还原实证：实测料回填后同一批行为腿重新为真（N-02b 的红不是恒红）',
    legs.every((l) => l.fn() === true), legs.filter((l) => l.fn() !== true).map((l) => l.id));
  const renamed = keys.map((k) => {
    const a = ANCHORS[k];
    const tampered = a.src.split(a.needle).join('⟪改名⟫');
    return { k, selfProof: tampered !== a.src, gone: !tampered.includes(a.needle), literalFalse: a.literal(tampered) === false };
  });
  check('N-03 逐锚改名模拟：25 个锚从 HEAD 副本抹掉后字面判据各自转假（且自证 tampered !== original）',
    renamed.every((r) => r.selfProof && r.gone && r.literalFalse), renamed.filter((r) => !(r.selfProof && r.gone && r.literalFalse)));
  {
    const rec = [];
    const recOk = (n, c, i) => rec.push({ n, c, i });
    okPair(recOk, '契约-行为假', () => false, () => true);
    okPair(recOk, '契约-字面假', () => true, () => false);
    okPair(recOk, '契约-双真', () => true, () => true);
    check('N-04 okPair 落地：行为失守记「行为失守」、字面失配记「字面锚点失配」、两侧齐真才绿',
      rec.length === 3 && rec[0].c === false && /行为失守/.test(rec[0].i?.红因)
      && rec[1].c === false && /字面锚点失配/.test(rec[1].i?.红因) && rec[2].c === true, rec);
  }
  const MUT = {
    'P-01': (e) => { e.href = 'http://127.0.0.1:5175/'; },
    'P-02': (e) => { e.nativeDialogOpenAtStart = 1; },
    'P-03': (e) => { e.navBackTaskStruct = false; },
    'P-04': (e) => { e.rowIsLi = false; },
    'P-05': (e) => { e.modalCountWhileOpen = 2; },
    'P-06': (e) => { e.visibleModalTextEmptyWhenClosed = false; },
    'P-07': (e) => { e.headerButtonCount = 2; },
    'P-08': (e) => { e.tabBodiesDistinct = 4; },
    'P-09': (e) => { e.textareaCount = 2; },
    'P-10': (e) => { e.serverAfterCancel = DESC0 + DESC_APPEND; },
    'P-11': (e) => { e.thumbAfterW = e.thumbBeforeW; e.thumbZoomIsAccent = false; },
    'P-12': (e) => { e.titleUserSelect = 'none'; },
    'P-13': (e) => { e.pressedOptionCount = 2; },
    'P-14': (e) => { e.planListHasFixture = false; },
    'P-15': (e) => { e.viewButtonCount = 2; },
    'P-16': (e) => { e.panelBorderColor = 'rgb(255, 0, 0)'; },
    'P-17': (e) => { e.jumpBadgeOnFixturePlan = false; },
    'P-18': (e) => { e.headerSelectSwitched = false; },
    'P-19': (e) => { e.sheetHasFixture = false; },
    'P-20': (e) => { e.mThumbAfterW = e.mThumbBeforeW; },
    'E-02': (e) => { e.projectCountFresh = 9; },
    'E-03': (e) => { e.abiLogClean = false; },
    'A-02': (e) => { e.focusAfterEsc = false; },
    'A-03': (e) => { e.drawerTitleText = '别的任务'; },
    'A-04': (e) => { e.serverResultAfterSave = RESULT0; },
    'M-01': (e) => { e.mobileRowDeepButtons = 3; },
    'M-02': (e) => { e.sheetClosed = false; },
  };
  const mut = legs.filter((l) => MUT[l.id]).map((l) => {
    const e = { ...EV };
    MUT[l.id](e);
    return { id: l.id, turnedFalse: withEV(e, l.fn) === false };
  });
  check(`N-05 结构破坏反证：${mut.length} 类破坏（多模态／正文不同源／textarea 不唯一／取消即落库／放大未撑开／userSelect 非 text／选中态多枚／面板描边非 accent／折叠钮错位／壳内 ABI 脏 等）各自转假`,
    mut.length >= 20 && mut.every((r) => r.turnedFalse === true), mut.filter((r) => !r.turnedFalse));
  // 旧门形态不复现：① 常驻挂载的关闭态抽屉文本仍留在 body 全文里（旧门据此判「抽屉里有标题」会假绿）；
  // ② 标签页判据若按后代 BUTTON 计数（MarkdownContent 工具条污染）就不等于 5。
  check('N-06 旧门两种假绿形态不复现：关闭态 body 全文确含夹具标题（旧判据在此为真）而可见模态判据为假；标签栏直接子计数=5 而后代计数≠5',
    EV.bodyTextKeepsFixtureWhenClosed === true && EV.visibleModalTextEmptyWhenClosed === true
    && EV.tabCount === 5 && EV.tabDescendantCount !== 5,
    { body全文含夹具: EV.bodyTextKeepsFixtureWhenClosed, 可见模态为空: EV.visibleModalTextEmptyWhenClosed, 直接子: EV.tabCount, 后代: EV.tabDescendantCount });
  check('N-07 定位器防空转：关键结构句柄在实测中均命中非空（入口/标签栏/正文/编辑钮/缩略图/选择器/fieldset/section/时间线行/移动行/半屏）',
    EV.entryFound === true && EV.tabCount > 0 && EV.descViewButtons > 0 && EV.thumbCount === 1
    && EV.pickerFound === true && EV.planPickerFound === true && EV.viewButtonCount === 3
    && EV.panelSectionFound === true && EV.tlMsRows > 0 && EV.mobileRowFound === true && EV.sheetVisible === true,
    { 入口: EV.entryFound, 缩略图: EV.thumbCount, 面板: EV.panelSectionFound, 时间线里程碑行: EV.tlMsRows, 移动行: EV.mobileRowFound });
  check('N-08 壳新鲜度留痕不冒充判据：asar 与 HEAD 时间戳均已取到（壳滞后时字面腿红因走「字面锚点失配」，不由本条决定成败）',
    asarMtime.length > 0 && headCommitTime.length > 0, { asarMtime, headCommitTime });
}

// best-effort 清理夹具项目（后端 DELETE /projects/:id 级联删任务；userData 本就每轮全新）
try { await api('DELETE', `/projects/${PROJECT}`); console.log('夹具项目已清理：' + PROJ_NAME); } catch (e) { console.log('夹具项目清理失败（不影响结论）：' + String(e.message).slice(0, 120)); }

const counted = FILTER ? results.filter((r) => r.n.includes(FILTER)) : results;
const fail = counted.filter((r) => r.p !== true);
console.log(`VERIFY-SHELL total=${counted.length} fail=${fail.length} shots=${shots.join(',')} scratch=${SCRATCH}${FILTER ? ` filter=${FILTER}` : ''}`);
if (fail.length) console.log('FAILED: ' + fail.map((f) => f.n).join(' | '));
try { ws.close(); } catch { /* 已关闭 */ }
cleanup();
await sleep(1200);
process.exit(fail.length ? 1 : 0);
