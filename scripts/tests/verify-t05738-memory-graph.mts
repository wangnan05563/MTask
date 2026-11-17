/**
 * T05738 门：记忆图谱可视化（Obsidian 式力导向图）。
 *
 * 交付：server `GET /memories/graph`（服务端拼 tag 共享边/替代链/项目聚簇，tag 成员数上限防蜘蛛网）
 * + web `MemoryGraph.tsx`（sigma v4 + graphology + ForceAtlas2，暗底四色、悬停邻域高亮、
 *   FA2 种子 + rAF 持续单步物理、原生拖拽暂停/续跑、缩放门控标签、click 详情面板、实例 kill 清理）+ MemoryTab「列表/图谱」视图切换。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05738-memory-graph.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库使用 junction 时 fileURLToPath 会解析到真实缓存目录；允许用 MTASK_GATE_ROOT 指回源码根。
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

const SVC = readFileSync(join(ROOT, 'server/src/services/MemoryService.ts'), 'utf8');
const ROUTE = readFileSync(join(ROOT, 'server/src/routes/memories.ts'), 'utf8');
const GRAPH = readFileSync(join(ROOT, 'web/src/pages/MemoryGraph.tsx'), 'utf8');
const TAB = readFileSync(join(ROOT, 'web/src/pages/MemoryTab.tsx'), 'utf8');
const SETTINGS = readFileSync(join(ROOT, 'web/src/pages/SettingsPage.tsx'), 'utf8');
const APP = readFileSync(join(ROOT, 'web/src/App.tsx'), 'utf8');

// A 组：服务端图谱数据端点
ok('A-01 buildMemoryGraph 服务函数：节点=记忆+项目聚簇+任务（P2），边=tag/替代链/归属/任务 四类',
  /export function buildMemoryGraph\(scope: ActiveMemoryScope\): MemoryGraph/.test(SVC)
  && /kind: 'memory' \| 'project' \| 'task'/.test(SVC)
  && /'tag' \| 'supersede' \| 'project' \| 'task'/.test(SVC));
ok('A-02 task 节点按 source_task_id 分批查 tasks 表（task_no 标签，回放时间取最早关联记忆）',
  /WHERE id IN \(\$\{chunk\.map\(\(\) => '\?'\)\.join\(','\)\}\)/.test(SVC)
  && /taskEarliest\.set\(r\.source_task_id, r\.updated_at\)/.test(SVC));
ok('A-02 tag 两两连边有成员数上限（防高频标签织蜘蛛网）+ 全量行硬上限',
  /GRAPH_TAG_FAN_MAX = \d+/.test(SVC) && /GRAPH_ROW_LIMIT = \d+/.test(SVC)
  && /members\.length > GRAPH_TAG_FAN_MAX\) continue;/.test(SVC));
ok('A-03 路由 GET /graph 必须带产品作用域校验（缺省 400 / 未绑产品空集+hint），且注册于 /:id 动态段语义之前',
  /memoriesApi\.get\('\/graph', \(req, res\) => \{[\s\S]{0,200}scopeOf\(\{[\s\S]{0,120}productKey: req\.query\.productKey/.test(ROUTE)
  && (ROUTE.indexOf("memoriesApi.get('/:id'") === -1
    || ROUTE.indexOf("memoriesApi.get('/graph'") < ROUTE.indexOf("memoriesApi.get('/:id'")));
ok('A-04 失效行保留（图谱含已失效记忆，前端灰显）',
  /buildMemoryScopeWhere\(scope, \{ includeInvalidated: true \}\)/.test(SVC));

// B 组：web 图谱组件（sigma v4 API）
ok('B-01 sigma v4 分层 options：settings(labelRenderedSizeThreshold 相机门控) + styles.nodes(labelColor) + 默认绑定不丢',
  /settings: \{[\s\S]{0,400}labelRenderedSizeThreshold: [\d.]+/.test(GRAPH)
  && /styles: \{[\s\S]{0,120}nodes: \{[\s\S]{0,300}labelColor: theme\.label/.test(GRAPH)
  && /\.\.\.DEFAULT_STYLES\.nodes/.test(GRAPH)
  && /\.\.\.DEFAULT_STYLES\.edges/.test(GRAPH));
ok('B-02 ForceAtlas2 种子布局 + rAF 持续单步物理（拖拽暂停/松手续跑）+ 大图 barnesHut 开关',
  /ForceAtlas2\.assign\(graph, \{[\s\S]{0,120}iterations: 90/.test(GRAPH)
  && /iterations: 1,[\s\S]{0,160}settings: \{ \.\.\.LIVE_PHYSICS/.test(GRAPH)
  && /requestAnimationFrame\(stepSimulation\)/.test(GRAPH)
  && /simPausedRef\.current = true/.test(GRAPH)
  && /simPausedRef\.current = false/.test(GRAPH)
  && /barnesHutOptimize: data\.nodes\.length > \d+/.test(GRAPH));
ok('B-03 悬停高亮一跳邻域：非邻域淡出 + 标签可见性统一由 resolveLabelVisibility 决策（T05790 放大态优先）',
  /graph\.areNeighbors\(node, hovered\)/.test(GRAPH)
  && /res\.opacity = 0\.46/.test(GRAPH)
  && /resolveLabelVisibility\(\{/.test(GRAPH)
  && /labelsAll: labelsAllRef\.current/.test(GRAPH));
ok('B-04 点击节点开详情面板 + clickStage 清除 + sigma.kill() 卸载清理',
  /sigma\.on\('clickNode'/.test(GRAPH) && /sigma\.on\('clickStage'/.test(GRAPH) && /sigma\.kill\(\)/.test(GRAPH));
ok('B-05 type 四色映射 + 失效灰显 + 项目聚簇色（图例齐备）',
  /user: '#[0-9a-f]{6}'/i.test(GRAPH) && /feedback: '#[0-9a-f]{6}'/i.test(GRAPH)
  && /project: '#[0-9a-f]{6}'/i.test(GRAPH) && /reference: '#[0-9a-f]{6}'/i.test(GRAPH)
  && /projectColor: '#[0-9a-f]{6}'/i.test(GRAPH)
  && /taskColor: '#[0-9a-f]{6}'/i.test(GRAPH)
  && /deadColor: '#[0-9a-f]{6}'/i.test(GRAPH));
ok('B-06 数据源只走 /memories/graph 端点（前端不做 N² 拼边）',
  /\/memories\/graph\?productKey=/.test(GRAPH) && !/for\s*\(let j = i \+ 1/.test(GRAPH));
ok('B-07 P1 发光：backdrop 常开 + shadow 按节点色生成光晕（hover 增强）',
  /backdropVisibility: 'visible'/.test(GRAPH)
  && /backdropColor: 'rgba\(0,0,0,0\)'/.test(GRAPH)
  && /backdropShadowColor: \(attrs: \{ color\?: string \}\) => glowOf\(/.test(GRAPH)
  && /backdropShadowBlur: \{ whenState: 'isHovered', then: \d+, else: theme\.glowBlur \}/.test(GRAPH));
ok('B-08 P1 入场动画：随机起始位置 → FA2 终位插值（easeOutCubic），不引入额外动画依赖',
  /function animateNodesIn\(graph: Graph, start: Map<string, \{ x: number; y: number \}>, sigma: Sigma\)/.test(GRAPH)
  && /1 - Math\.pow\(1 - raw, 3\)/.test(GRAPH)
  && /animateNodesIn\(graph, startPositions, sigma\)/.test(GRAPH));
ok('B-09 P2 时间轴回放：nodeUpdatedAt 锚点 + cursor 游标 isHidden 驱动（节点+边双隐藏，不重算布局）',
  /nodeUpdatedAt: n\.updatedAt \?\? null/.test(GRAPH)
  && /res\.isHidden = true; return res;/.test(GRAPH)
  && /graph\.getNodeAttribute\(graph\.source\(edge\), 'nodeUpdatedAt'\)/.test(GRAPH)
  && /setInterval\(/.test(GRAPH));
ok('B-10 P2 回放控制条：播放/停止切换 + 进度计数（data-lck 锚点）+ 卸载清定时器',
  /▶ 回放生长/.test(GRAPH) && /⏸ 停止回放/.test(GRAPH)
  && /data-lck="memory-graph-replay-progress"/.test(GRAPH)
  && /\(\) => \{ if \(replayTimerRef\.current\) clearInterval\(replayTimerRef\.current\); \}, \[\]/.test(GRAPH));
ok('B-11 悬停只做邻域高亮 + 原生拖拽；T05790 起在其上叠加一跳邻居回弹（不再有 hover 呼吸）',
  /enableNodeDrag: true/.test(GRAPH)
  && /sigma\.on\('enterNode'/.test(GRAPH)
  && /sigma\.on\('leaveNode'/.test(GRAPH)
  && /sigma\.on\('nodeDragStart'/.test(GRAPH)
  && /sigma\.on\('nodeDragEnd'/.test(GRAPH)
  && !/hoverPulseRef/.test(GRAPH)
  && !/0\.22 \/ Math\.max\(1, Math\.sqrt\(session\.neighbors\.size\)\)/.test(GRAPH));

// C 组：MemoryTab 接入
ok('C-01 列表/图谱视图切换（IconButton aria-pressed + 产品筛选共享）',
  /viewMode, setViewMode\] = useState<'list' \| 'graph'>\('list'\)/.test(TAB)
  && /pressed=\{viewMode === 'list'\}/.test(TAB)
  && /pressed=\{viewMode === 'graph'\}/.test(TAB)
  && /\{viewMode === 'graph' && <MemoryGraph productKey=\{productKey\} \/>\}/.test(TAB));
ok('C-02 图谱只读提示 + 列表主体按视图条件渲染（新增/表格/孤立标签归 list）',
  /图谱为只读视图；新增\/编辑\/删除请切回「列表」视图。/.test(TAB)
  && /\{viewMode === 'list' && \(<>/.test(TAB));
ok('C-03 sigma/graphology 依赖已登记（package.json）',
  /"sigma": "\^4\./.test(readFileSync(join(ROOT, 'web/package.json'), 'utf8'))
  && /"graphology"/.test(readFileSync(join(ROOT, 'web/package.json'), 'utf8')));
ok('C-04 记忆入口收敛到 设置→数据→记忆管理（T05765 移除顶部直达）',
  /移除顶部「记忆」导航入口；记忆管理仍由「设置 → 数据 → 记忆管理」进入/.test(APP)
  && /active === 'memory' && <MemoryTab \/>/.test(SETTINGS)
  && /data-tab=\{t\.key\}/.test(SETTINGS));

mkdirSync(OUT_DIR, { recursive: true });
const summary = `T05738 门：${pass} 通过 / ${fail} 失败`;
lines.push('');
lines.push(summary);
writeFileSync(join(OUT_DIR, 't05738-gate-results.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
process.exit(fail === 0 ? 0 : 1);
