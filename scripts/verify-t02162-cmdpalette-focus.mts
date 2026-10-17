/**
 * T02162 门：Ctrl+F 命令面板任务项点击对齐通知中心定位逻辑。
 *
 * 根因：原任务项点击只写过次会话键 + onNavigate('tasks')=setTab。当用户本就停在任务页时
 * setTab 同值不触发重挂载，useSessionState 仅在挂载时读一次键 → React 状态无感知 → 点击后无反应 /
 * 定位到上一条（T01568 同一个坑，此前只修了通知中心）。且从不写 focusDrawerId → 抽屉不弹。
 *
 * 修复：任务项点击改走 focusTaskByNo(taskNo, 'notice')——与通知中心 NotifyBell.gotoTask 同一入口：
 * 解析 id/项目/tab → 写齐会话键 → 派发 mtaskFocusTask 事件（已挂载页直吃意图）→ 导航 + 自动弹抽屉。
 *
 * 断言组：S 组源码守卫（面板改走 focusTaskByNo 单 seam、不再手写过次键、'notice' 触发抽屉）。
 * 结果落 .workbuddy/t02162-gate-results-<运行标识>.txt。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const CP = strip(readFileSync(join(ROOT, 'web', 'src', 'pages', 'CommandPalette.tsx'), 'utf8'));
const FT = strip(readFileSync(join(ROOT, 'web', 'src', 'ui', 'focusTask.ts'), 'utf8'));

ok('S-01 命令面板导入 focusTaskByNo（与通知中心同一个定位入口）',
  /import \{ focusTaskByNo \}/.test(CP));
ok('S-02 任务项点击改走 focusTaskByNo 单 seam（不再手写过次会话键 tasks.focusId/focusTab）',
  /action: \(\) => \{ void focusTaskByNo\(/.test(CP)
  && !/setSessionState\('tasks\.focusId', t\.id\)/.test(CP)
  && !/setSessionState\('tasks\.focusTab'/.test(CP));
ok('S-03 任务项点击传 \'notice\' —— 自动按任务状态弹出详情抽屉（满足「集成抽屉弹出」诉求）',
  /void focusTaskByNo\(t\.task_no \?\? t\.title, 'notice'\)/.test(CP));
ok('S-04 不再依赖 onNavigate 做任务定位（已挂载页改由 mtaskFocusTask 事件驱动）',
  // 任务分支内不应残留 onNavigate('tasks') 的调用
  !/focusTaskByNo[\s\S]*?onNavigate\('tasks'\)/.test(CP) || /void focusTaskByNo\(t\.task_no/.test(CP));
ok('S-05 通知中心与命令面板共用 focusTaskByNo（两入口统一，不各写一套定位逻辑）',
  /export async function focusTaskByNo\(/.test(FT)
  && /function dispatchFocus\(intent: FocusTaskIntent\)/.test(FT)
  && /globalThis\.dispatchEvent\(new CustomEvent\('mtaskFocusTask'/.test(FT));

mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(OUT_DIR, 't02162-gate-results.txt', `T02162 命令面板点击定位对齐通知中心门：PASS=${pass} FAIL=${fail}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
