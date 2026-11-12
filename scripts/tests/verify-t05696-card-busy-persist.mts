/**
 * T05696 门：五卡片按钮运行态跨页面切换保持。
 *
 * 现场：卡片是条件渲染——切换页面即卸载，组件内 useState 全部归零。长任务（SSE 提取、
 * 预检、导出）进行中切走再切回，按钮恢复可点 → 重复触发。
 *
 * 现状盘点（逐卡实扫）：
 *   - 启动会 / 阶段总结 PPT 卡：T05683 已把 streaming/outlineBusy 提进 kickoffPptStore/summaryPptStore ✅
 *   - 讲稿卡：streaming/diffLoading 早已在 codeReviewLectureStore；本轮补 preflightLoading/exporting ✅
 *   - Git 提取卡：本轮新建 gitExtractStore（running/aborted/jobId/stageIdx/runError/result + abortCtrl）✅
 *     卸载掐流语义保留（磁盘重操作不留后台包），仅把「已中止」状态落进 store
 *   - Sonar 卡：挂载时 `GET /sonar/scan/running` 服务端对账恢复运行态（338-345 行既有机制），不重复造 ✅
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05696-card-busy-persist.mts
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

const LEC_STORE = readFileSync(join(ROOT, 'web/src/stores/codeReviewLectureStore.ts'), 'utf8');
const LEC = readFileSync(ROOT + '/web/src/pages/CodeReviewLecturePanel.tsx', 'utf8');
const GIT_STORE = readFileSync(join(ROOT, 'web/src/stores/gitExtractStore.ts'), 'utf8');
const GIT = readFileSync(join(ROOT, 'web/src/pages/GitExtractPanel.tsx'), 'utf8');
const SONAR = readFileSync(join(ROOT, 'web/src/pages/SonarScanPanel.tsx'), 'utf8');

// A 组：讲稿卡（store 字段 + 面板换用）
ok('A-01 codeReviewLectureStore 增设 preflightLoading/exporting 字段与 setter',
  /preflightLoading: boolean/.test(LEC_STORE) && /exporting: boolean/.test(LEC_STORE)
  && /setPreflightLoading\(loading: boolean\)/.test(LEC_STORE) && /setExporting\(exporting: boolean\)/.test(LEC_STORE));
ok('A-02 面板不再用局部 useState 持有预检/导出态，改读 store 快照',
  !/useState\(false\)\);\s*\/\/?\s*exporting/.test(LEC)
  && !/\[preflightLoading, setPreflightLoading\] = useState/.test(LEC)
  && !/\[exporting, setExporting\] = useState/.test(LEC)
  && /const exporting = snap\.exporting/.test(LEC) && /const preflightLoading = snap\.preflightLoading/.test(LEC));
ok('A-03 置位/复位走 store setter（预检与导出各两处）',
  /codeReviewLectureStore\.setPreflightLoading\(true\)/.test(LEC)
  && /codeReviewLectureStore\.setPreflightLoading\(false\)/.test(LEC)
  && /codeReviewLectureStore\.setExporting\(true\)/.test(LEC)
  && /codeReviewLectureStore\.setExporting\(false\)/.test(LEC));
ok('A-04 既有长任务态不动（streaming/diffLoading 仍在 store，避免重复机制）',
  /streaming: false,/.test(LEC_STORE) && /setDiffLoading\(loading: boolean\)/.test(LEC_STORE));

// B 组：Git 提取卡（新 store + SSE 回调写 store）
ok('B-01 gitExtractStore 覆盖运行态六项（running/aborted/jobId/stageIdx/runError/result）',
  /running: boolean/.test(GIT_STORE) && /aborted: boolean/.test(GIT_STORE) && /jobId: string/.test(GIT_STORE)
  && /stageIdx: number/.test(GIT_STORE) && /runError: string/.test(GIT_STORE) && /result: ExtractView \| null/.test(GIT_STORE));
ok('B-02 面板从 store 快照解构运行态，不再持有同名 useState',
  !/\[running, setRunning\] = useState/.test(GIT) && !/\[result, setResult\] = useState/.test(GIT)
  && /const \{ running, stageIdx, jobId, result, runError, aborted \} = snap;/.test(GIT));
ok('B-03 SSE 回调与收口写 store（组件卸载期间事件照常落库）',
  /gitExtractStore\.startRun\(controller\)/.test(GIT) && /gitExtractStore\.patch\(\{ result: p as unknown as ExtractView/.test(GIT)
  && /gitExtractStore\.finishRun\(\)/.test(GIT));
ok('B-04 卸载掐流语义保留（磁盘重操作不留后台包），「已中止」落 store 切回可见',
  /服务端 res\.close 会 abort 子进程并回收 tmp/.test(GIT)
  && /gitExtractStore\.getAbortCtrl\(\)/.test(GIT) && /gitExtractStore\.markAborted\(\)/.test(GIT));
ok('B-05 mode 切换清场走 store.resetRun（单点，不散落五个 setState）',
  /setMode\(m\.key\); gitExtractStore\.resetRun\(\);/.test(GIT));

// C 组：Sonar 卡对账机制在位（不重复造 store）
ok('C-01 Sonar 卡挂载对账恢复运行态（GET /sonar/scan/running → setRunning(true) + jobId）',
  /\/sonar\/scan\/running/.test(SONAR) && /setRunning\(true\)/.test(SONAR) && /setJobId\(job\.jobId/.test(SONAR));
ok('C-02 对账恢复不吞「已按错误定性」的挂载（T04075 口径保留）',
  /不能改口说「已中止并回收」/.test(SONAR) || /已经按错误定性的挂载/.test(SONAR));

const body = [`T05696 按钮态持久门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05696-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05696-gate-results.txt')}`);
