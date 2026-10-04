#!/usr/bin/env node
/**
 * T01496/T01495：虚拟滚动命令级断言（窗口化数学 + 触发门控），编译被测真实源码验产品 import 的那份实现。
 *
 * 手法：`typescript.transpileModule` 直接编译 `web/src/pages/testCaseModel.ts`（纯函数、`import type` 被擦除、
 *  无运行时依赖），在 new Function 沙箱取导出——**验的是产品真正 import 的实现，不是脚本复制品**。
 *
 * 覆盖任务原文三条硬指标：
 *  1) 仅「全部」模式（pageSize=0）且 >1000 触发；分页(200/500)恒不触发（勿过度设计）；
 *  2) 大列表窗口行数上界 = 视口行 + 2×overscan，与条数无关（DOM 不随 N 线性增长）；
 *  3) 滚动区间与全量一致：padTop + 窗口高 + padBottom ≡ count×rowH。
 *
 * 输出协议：stdout 末行 `T01495:<json>`，逐条 PASS/FAIL 也走 stdout；全过 exit=0，有 FAIL exit=1。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ts = require(path.join(ROOT, 'node_modules', 'typescript'));

const results = [];
const ck = (k, cond, msg = '') => results.push({ k, pass: !!cond, msg: String(msg).slice(0, 200) });

const SRC = path.join(ROOT, 'web', 'src', 'pages', 'testCaseModel.ts');
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, () => { throw new Error('testCaseModel 不应有运行时 require'); });
const M = mod.exports;
ck('MODEL_exports_present', typeof M.shouldVirtualize === 'function' && typeof M.computeWindow === 'function',
  `shouldVirtualize=${typeof M.shouldVirtualize} computeWindow=${typeof M.computeWindow}`);

const TH = M.VIRTUAL_THRESHOLD; const ROW = M.VIRTUAL_ROW_H; const VP = M.VIRTUAL_VIEWPORT_H; const OSC = M.VIRTUAL_OVERSCAN;
ck('THRESHOLD_is_1000', TH === 1000, `VIRTUAL_THRESHOLD=${TH}（任务原文「>1000 条」）`);
const visible = Math.ceil(VP / ROW);

ck('gate_pagination_200_never', M.shouldVirtualize(200, 999999) === false, 'pageSize=200 恒不虚拟');
ck('gate_pagination_500_never', M.shouldVirtualize(500, 999999) === false, 'pageSize=500 恒不虚拟');
ck('gate_all_eq_threshold_off', M.shouldVirtualize(0, TH) === false, `count=${TH} 不触发（严格 >）`);
ck('gate_all_gt_threshold_on', M.shouldVirtualize(0, TH + 1) === true, `count=${TH + 1} 触发`);
ck('gate_all_big_on', M.shouldVirtualize(0, 5000) === true, 'count=5000 触发');

const w0 = M.computeWindow(0, 0);
ck('win_empty_all_zero', w0.start === 0 && w0.end === 0 && w0.padTop === 0 && w0.padBottom === 0, JSON.stringify(w0));
const wTop = M.computeWindow(0, 3000);
ck('win_top_start0', wTop.start === 0, `start=${wTop.start}`);
ck('win_top_end_visible_overscan', wTop.end === visible + OSC, `end=${wTop.end} 期望 ${visible}+${OSC}`);
ck('win_top_padTop0', wTop.padTop === 0, `padTop=${wTop.padTop}`);

let domBoundOk = true; let maxWindow = 0; let boundAt = null;
const bound = visible + 2 * OSC;
for (const count of [1001, 5000, 100000, 1000000]) {
  const totalH = count * ROW;
  for (let st = 0; st <= totalH; st += Math.max(1, Math.floor(totalH / 500))) {
    const w = M.computeWindow(st, count);
    const win = w.end - w.start;
    maxWindow = Math.max(maxWindow, win);
    if (win > bound) { domBoundOk = false; boundAt = { count, st, win }; break; }
  }
}
ck('win_dom_rows_bounded_regardless_of_count', domBoundOk, `上界=${bound}(visible ${visible}+2*overscan ${OSC})，实测峰值窗口行=${maxWindow}${boundAt ? ' @' + JSON.stringify(boundAt) : ''}；count 扫到 1e6`);

let hOk = true; let hBad = null;
for (const count of [1001, 3000, 9999]) {
  for (let st = 0; st <= count * ROW; st += ROW * 13 + 7) {
    const w = M.computeWindow(st, count);
    if (w.padTop + (w.end - w.start) * ROW + w.padBottom !== count * ROW) { hOk = false; hBad = { count, st, w }; break; }
    if (w.padTop !== w.start * ROW || w.padBottom !== (count - w.end) * ROW) { hOk = false; hBad = { count, st, w, why: 'pad≠index×rowH' }; break; }
    if (w.start > w.end || w.padTop < 0 || w.padBottom < 0) { hOk = false; hBad = { count, st, w, why: '越界/负' }; break; }
  }
}
ck('win_total_height_equals_full_list', hOk, hBad ? '不变式破裂：' + JSON.stringify(hBad) : 'padTop+(end-start)×rowH+padBottom ≡ count×rowH 全程成立');

let coverOk = true; let coverBad = null;
for (const count of [1001, 7777]) {
  for (let st = 0; st <= count * ROW; st += ROW * 7 + 3) {
    const w = M.computeWindow(st, count);
    const firstVisible = Math.min(count - 1, Math.floor(st / ROW));
    if (!(w.start <= firstVisible && firstVisible < w.end)) { coverOk = false; coverBad = { count, st, firstVisible, w }; break; }
  }
}
ck('win_covers_viewport_top_row', coverOk, coverBad ? '漏渲染：' + JSON.stringify(coverBad) : '任意滚动位置，视口顶行下标落在 [start,end) 内');

const count = 5000;
const wBot = M.computeWindow(count * ROW - VP, count);
ck('win_bottom_end_eq_count', wBot.end === count && wBot.padBottom === 0, `end=${wBot.end} padBottom=${wBot.padBottom}`);
const wOver = M.computeWindow(count * ROW + 999999, count);
ck('win_overscroll_clamp', wOver.end === count && wOver.start <= count, `start=${wOver.start} end=${wOver.end}`);

let monoOk = true; let prev = M.computeWindow(0, count);
for (let st = ROW; st <= count * ROW; st += ROW * 5) {
  const w = M.computeWindow(st, count);
  if (w.start < prev.start || w.end < prev.end) { monoOk = false; break; }
  prev = w;
}
ck('win_monotonic_non_decreasing', monoOk, 'start/end 随 scrollTop 单调不减');

const pass = results.filter((x) => x.pass).length;
const fail = results.length - pass;
process.stdout.write('T01495:' + JSON.stringify({ pass, fail, threshold: TH, rowH: ROW, viewportH: VP, overscan: OSC, visible, total: results.length }) + '\n');
for (const x of results) process.stdout.write(`${x.pass ? 'PASS' : 'FAIL'}  ${x.k}  ${x.msg}\n`);
process.exit(fail === 0 ? 0 : 1);
