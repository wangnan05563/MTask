/**
 * T05790 门：记忆图谱进一步优化——① 回弹力反馈 ② 放大后标题全量显示 ③ 页面切换状态保持。
 *
 * 静态源码门（与 verify-t05738-memory-graph.mts 同风格）：sigma v4 图谱需 WebGL，无法在无头 DOM 稳定断言，
 * 故以「实现要素齐备 + 行为链闭合」为准；渲染/交互实测由 tsc + vite build + T05738 门回归 + 用户 GUI 复核兜底。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05790-memory-graph.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.MTASK_GATE_ROOT
  ? resolve(process.env.MTASK_GATE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

const GRAPH = readFileSync(join(ROOT, 'web/src/pages/MemoryGraph.tsx'), 'utf8');

// A 组：① 回弹力反馈
ok('A-01 全局统一回弹参数 BOUNCE（pull/maxPull/stiffness/damping/settleEps 单一来源，避免节点弹性差异）',
  /const BOUNCE = \{/.test(GRAPH)
  && /pull: [\d.]+/.test(GRAPH) && /maxPull: \d+/.test(GRAPH)
  && /stiffness: [\d.]+/.test(GRAPH) && /damping: [\d.]+/.test(GRAPH)
  && /settleEps: [\d.]+/.test(GRAPH));
ok('A-02 dragBounceRef 状态机：dragged + phase(drag|release) + 邻居 rest/off/v 映射',
  /dragBounceRef = useRef</.test(GRAPH)
  && /phase: 'drag' \| 'release'/.test(GRAPH)
  && /neighbors: Map<string, \{ restX: number; restY: number; offX: number; offY: number; vx: number; vy: number \}>/.test(GRAPH));
ok('A-03 nodeDragStart 记录一跳邻居 rest 坐标（graph.neighbors）并暂停 FA2',
  /sigma\.on\('nodeDragStart', \(\{ node \}\) => \{/.test(GRAPH)
  && /simPausedRef\.current = true/.test(GRAPH)
  && /graph\.neighbors\(node\)\.forEach/.test(GRAPH)
  && /dragBounceRef\.current = \{ dragged: node, phase: 'drag', neighbors \}/.test(GRAPH));
ok('A-04 drag 阶段橡皮筋牵引：邻居按 BOUNCE.pull 跟随、maxPull 限幅，停 FA2 由 stepBounce 接管',
  /bs\.phase === 'drag'/.test(GRAPH)
  && /\(dx - n\.restX\) \* BOUNCE\.pull/.test(GRAPH)
  && /BOUNCE\.maxPull/.test(GRAPH)
  && /g\.setNodeAttribute\(id, 'x', n\.restX \+ n\.offX\)/.test(GRAPH));
ok('A-05 release 阶段欠阻尼弹簧回位：v=(v-k·off)·damping、off+=v、收敛归位后恢复 FA2',
  /n\.vx = \(n\.vx - BOUNCE\.stiffness \* n\.offX\) \* BOUNCE\.damping/.test(GRAPH)
  && /n\.offX \+= n\.vx/.test(GRAPH)
  && /BOUNCE\.settleEps/.test(GRAPH)
  && /dragBounceRef\.current = null;\s*\n\s*simPausedRef\.current = false/.test(GRAPH));
ok('A-06 nodeDragEnd 转入 release；无邻居则直接恢复物理；rAF 每帧 stepBounce + refresh',
  /sigma\.on\('nodeDragEnd'/.test(GRAPH)
  && /phase = 'release'/.test(GRAPH)
  && /if \(dragBounceRef\.current\) \{[\s\S]{0,120}stepBounce\(\)/.test(GRAPH));

// B 组：② 放大后标题全量显示
ok('B-01 放大阈值常量 LABEL_ALL_RATIO（相机 ratio 越小＝越放大）',
  /const LABEL_ALL_RATIO = [\d.]+/.test(GRAPH));
ok('B-02 camera updated 监听：更新 ratio、门控翻转才 refresh（避免堆字）、节流保存',
  /sigma\.getCamera\(\)\.on\('updated', onCamera\)/.test(GRAPH)
  && /const onCamera = \(\) => \{/.test(GRAPH)
  && /if \(all !== labelsAllRef\.current\) \{ labelsAllRef\.current = all; sigma\.refresh\(\); \}/.test(GRAPH));
ok('B-03 nodeReducer 放大态强制全量标签：labelsAllRef → labelVisibility=visible（回放隐藏节点已提前 return）',
  /if \(labelsAllRef\.current\) res\.labelVisibility = 'visible';/.test(GRAPH));
ok('B-04 恢复视图时用 saved.ratio 初始化 labelsAllRef，切页回来门控状态一致',
  /labelsAllRef\.current = initCam\.ratio <= LABEL_ALL_RATIO/.test(GRAPH));

// C 组：③ 页面切换状态保持
ok('C-01 GraphViewState 结构（camera/positions/selectedId/savedAt）+ 按 productKey 隔离的 sessionStorage 键',
  /interface GraphViewState \{/.test(GRAPH)
  && /camera: \{ x: number; y: number; ratio: number \}/.test(GRAPH)
  && /positions: Record<string, \{ x: number; y: number \}>/.test(GRAPH)
  && /selectedId: string \| null/.test(GRAPH)
  && /viewStateKey = \(productKey: string\) => `mtask\.memoryGraph\.view\.\$\{productKey\}`/.test(GRAPH));
ok('C-02 read/write 容错（坏数据 / 配额失败静默回退）',
  /function readViewState\(productKey: string\): GraphViewState \| null/.test(GRAPH)
  && /function writeViewState\(productKey: string, v: GraphViewState\): void/.test(GRAPH)
  && /try \{ sessionStorage\.setItem/.test(GRAPH));
ok('C-03 saveView 节流写盘：相机 getState + 全节点坐标 + 选中 id',
  /const saveView = \(\) => \{/.test(GRAPH)
  && /now - lastSaveRef\.current < 400/.test(GRAPH)
  && /sigma\.getCamera\(\)\.getState\(\)/.test(GRAPH)
  && /graph\.nodes\(\)\.forEach/.test(GRAPH)
  && /selectedId: selectedRef\.current\?\.id \?\? null/.test(GRAPH));
ok('C-04 恢复守卫：节点集覆盖 ≥80% 才复用坐标，否则随机重排（避免增删错位）',
  /saved\.positions\[n\.id\]\)\.length >= Math\.ceil\(data\.nodes\.length \* 0\.8\)/.test(GRAPH)
  && /canRestore \? saved!\.positions\[n\.id\] : null/.test(GRAPH)
  && /if \(!canRestore\) \{[\s\S]{0,160}ForceAtlas2\.assign/.test(GRAPH));
ok('C-05 相机恢复：有 saved.camera 则还原中心/缩放，否则复位 0.5/0.5/1',
  /const initCam = canRestore && saved!\.camera/.test(GRAPH)
  && /sigma\.getCamera\(\)\.setState\(initCam\)/.test(GRAPH));
ok('C-06 选中项恢复：按 saved.selectedId 找回节点回填面板与 ref',
  /if \(canRestore && saved!\.selectedId\)/.test(GRAPH)
  && /data\.nodes\.find\(\(n\) => n\.id === saved!\.selectedId\)/.test(GRAPH));
ok('C-07 卸载前强制保存 + 移除 camera 监听（切页/刷新落盘，无泄漏）',
  /lastSaveRef\.current = 0;\s*\n\s*saveView\(\);/.test(GRAPH)
  && /sigma\.getCamera\(\)\.removeListener\('updated', onCamera\)/.test(GRAPH));
ok('C-08 「重排布局」显式跳过恢复（skipRestoreRef），产品切换仍默认恢复',
  /skipRestoreRef\.current = true; void load\(\)/.test(GRAPH)
  && /const saved = skipRestoreRef\.current \? null : readViewState\(productKey\)/.test(GRAPH));
ok('C-09 统一选中入口 selectNode 镜像 ref + refresh + 触发保存（点击/关闭/事件一致）',
  /const selectNode = useCallback/.test(GRAPH)
  && /selectedRef\.current = node;/.test(GRAPH)
  && /sigma\.on\('clickNode'[\s\S]{0,120}selectNode/.test(GRAPH)
  && /onClick=\{\(\) => selectNode\(null\)\}/.test(GRAPH));

mkdirSync(OUT_DIR, { recursive: true });
const summary = `T05790 门：${pass} 通过 / ${fail} 失败`;
lines.push('');
lines.push(summary);
writeFileSync(join(OUT_DIR, 't05790-gate-results.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
process.exit(fail === 0 ? 0 : 1);
