/**
 * T05683 门：卡片运行态跨切换保持（大纲按钮）。
 *
 * 缺陷：大纲请求进行中切到别的卡片，面板卸载 → 组件内 `useState` 归零；请求仍在后台飞，
 * 切回来按钮却回到「生成大纲」可点态，用户会重复触发（重复烧模型配额）。
 * 修复：运行态提升到模块级 store（`summaryPptStore` / `kickoffPptStore`），面板只读 snap。
 *
 * 判据：
 *   A 组 行为——两个 store 都有 outlineBusy；setter 能置位/复位；abort 后归零。
 *   B 组 源码锚——面板不再有该局部 state；从 snap 解构；调用走 store；重挂载有恢复路径。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05683-card-busy-store.mts
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

const SM = await import('../../web/src/stores/summaryPptStore.ts');
const KM = await import('../../web/src/stores/kickoffPptStore.ts');

ok('A-01 summaryPptStore 暴露 outlineBusy（初始 false）',
  SM.summaryPptStore.get().outlineBusy === false, SM.summaryPptStore.get().outlineBusy);
SM.summaryPptStore.setOutlineBusy(true);
ok('A-02 summaryPptStore.setOutlineBusy(true) 立即可读（模块级，跨组件存活）',
  SM.summaryPptStore.get().outlineBusy === true);
SM.summaryPptStore.setOutlineBusy(false);
ok('A-03 复位后归 false（请求结束不会卡在运行态）',
  SM.summaryPptStore.get().outlineBusy === false);
SM.summaryPptStore.setOutlineBusy(true);
SM.summaryPptStore.abort();
ok('A-04 用户中止（abort）后运行态一并归零',
  SM.summaryPptStore.get().outlineBusy === false && SM.summaryPptStore.get().streaming === false);

ok('A-05 kickoffPptStore 同构（启动会卡片同样修）',
  KM.kickoffPptStore.get().outlineBusy === false);
KM.kickoffPptStore.setOutlineBusy(true);
ok('A-06 kickoffPptStore setter 可读可复位',
  KM.kickoffPptStore.get().outlineBusy === true);
KM.kickoffPptStore.setOutlineBusy(false);

const SUM = readFileSync(join(ROOT, 'web/src/pages/SummaryPptPanel.tsx'), 'utf8');
const KIC = readFileSync(join(ROOT, 'web/src/pages/KickoffPptPanel.tsx'), 'utf8');

ok('B-01 两页都不再有 outlineBusy 的局部 useState（卸载即丢的根源）',
  !/const \[outlineBusy, setOutlineBusy\] = useState/.test(SUM)
  && !/const \[outlineBusy, setOutlineBusy\] = useState/.test(KIC));
ok('B-02 两页都从 store 快照解构 outlineBusy',
  /const \{ streaming, result, outlineBusy \} = snap;/.test(SUM)
  && /const \{ streaming, result, outlineBusy \} = snap;/.test(KIC));
ok('B-03 置位/复位走 store 方法（不是组件 setter）',
  /summaryPptStore\.setOutlineBusy\(/.test(SUM) && /kickoffPptStore\.setOutlineBusy\(/.test(KIC));
ok('B-04 重挂载有恢复路径：大纲本身从 store/session 回灌（按钮不忙了，列表也要在）',
  /summaryPptStore\.get\(\)\.outline\.length > 0/.test(SUM) && /kickoffPptStore\.get\(\)\.outline\.length > 0/.test(KIC));

const body = [`T05683 卡片运行态门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05683-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05683-gate-results.txt')}`);
