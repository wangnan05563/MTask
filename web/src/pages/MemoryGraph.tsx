import { useCallback, useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma, { DEFAULT_STYLES } from 'sigma';
import ForceAtlas2 from 'graphology-layout-forceatlas2';
import { api } from '../api/client';
import { dragPullOffset, resolveLabelVisibility, springStep } from './memoryGraphMath';

/**
 * T05738：记忆图谱视图（Obsidian 式力导向图，sigma.js v4 + graphology + ForceAtlas2）。
 *
 * 数据源 `GET /memories/graph?productKey=`（服务端拼好 tag 共享边/替代链/项目聚簇，前端不做 N² 计算）。
 * 视觉：跟随当前亮/暗主题的图谱画布 + type 四色节点 + 失效灰显 + 悬停高亮一跳邻域
 * + 缩放门控标签（labelRenderedSizeThreshold 即 Obsidian 的 text fade threshold）+ 点击节点开详情面板。
 * 动效：参考 KarpathyWiki 的 vis-network 常开物理手感——FA2 只做种子布局，随后 rAF 持续单步迭代；
 * 原生拖拽期间暂停物理、松手续跑；边宽随相位轻微脉冲形成「流动感」。
 *
 * T05790 三项优化（对应工单「记忆管理图谱进一步优化」）：
 * 1. 回弹力反馈——拖拽时一跳邻居橡皮筋牵引，松手后阻尼弹簧回位（带轻微过冲），全局参数单一来源 BOUNCE；
 * 2. 放大后标题全量显示——相机 ratio 低于 LABEL_ALL_RATIO 时所有节点强制 visible 标签，缩回时恢复悬停态避免堆字；
 * 3. 页面切换状态保持——相机/节点坐标/选中项存 sessionStorage（按 productKey 隔离），切走再回来自动还原。
 */

interface GraphTheme {
  canvas: string;
  grid: string;
  label: string;
  labelBg: string;
  panelBg: string;
  panelBorder: string;
  panelText: string;
  panelMuted: string;
  panelHint: string;
  typeColors: Record<string, string>;
  projectColor: string;
  taskColor: string;
  deadColor: string;
  edgeTag: string;
  edgeProject: string;
  edgeSupersede: string;
  edgeTask: string;
  edgeDim: string;
  edgeDimSupersede: string;
  legendSupersede: string;
  legendProject: string;
  legendTask: string;
  glowAlpha: number;
  glowBlur: number;
}

/** 深色主题：沿用暗底发光图谱语汇，但底色与文字仍走同一套主题色系。 */
const DARK_THEME: GraphTheme = {
  canvas: 'radial-gradient(ellipse at 50% 38%, #182338 0%, #101827 55%, #0b1220 100%)',
  grid: 'radial-gradient(circle, rgba(148,163,184,0.14) 1px, transparent 1px)',
  label: '#e2e8f0',
  labelBg: 'rgba(8,13,25,0.72)',
  panelBg: 'rgba(15,23,42,0.94)',
  panelBorder: 'rgba(129,140,248,0.45)',
  panelText: '#f1f5f9',
  panelMuted: '#b6c2d8',
  panelHint: '#94a3b8',
  typeColors: {
    user: '#38bdf8',
    feedback: '#f472b6',
    project: '#34d399',
    reference: '#fbbf24',
  },
  projectColor: '#818cf8',
  taskColor: '#22d3ee',
  deadColor: '#526078',
  edgeTag: 'rgba(96,165,250,0.62)',
  edgeProject: 'rgba(129,140,248,0.72)',
  edgeSupersede: 'rgba(248,113,113,0.88)',
  edgeTask: 'rgba(34,211,238,0.72)',
  edgeDim: 'rgba(100,116,139,0.16)',
  edgeDimSupersede: 'rgba(248,113,113,0.22)',
  legendSupersede: '#f87171',
  legendProject: '#a5b4fc',
  legendTask: '#67e8f9',
  glowAlpha: 0.32,
  glowBlur: 11,
};

/** 浅色主题：白底/浅灰底上使用加深的节点色与更高不透明度的连线，避免“黑块+灰点”。 */
const LIGHT_THEME: GraphTheme = {
  canvas: 'radial-gradient(ellipse at 50% 38%, #ffffff 0%, #f4f7fb 58%, #e8eff7 100%)',
  grid: 'radial-gradient(circle, rgba(100,116,139,0.18) 1px, transparent 1px)',
  label: '#1e293b',
  labelBg: 'rgba(255,255,255,0.82)',
  panelBg: 'rgba(255,255,255,0.96)',
  panelBorder: 'rgba(79,70,229,0.32)',
  panelText: '#0f172a',
  panelMuted: '#475569',
  panelHint: '#64748b',
  typeColors: {
    user: '#0369a1',
    feedback: '#be185d',
    project: '#047857',
    reference: '#b45309',
  },
  projectColor: '#4f46e5',
  taskColor: '#0e7490',
  deadColor: '#94a3b8',
  edgeTag: 'rgba(37,99,235,0.56)',
  edgeProject: 'rgba(79,70,229,0.64)',
  edgeSupersede: 'rgba(220,38,38,0.72)',
  edgeTask: 'rgba(14,116,144,0.64)',
  edgeDim: 'rgba(100,116,139,0.12)',
  edgeDimSupersede: 'rgba(220,38,38,0.18)',
  legendSupersede: '#dc2626',
  legendProject: '#4338ca',
  legendTask: '#0e7490',
  glowAlpha: 0.18,
  glowBlur: 8,
};

/** 主题由 SettingsProvider 写到 documentElement.dataset.theme；监听它即可覆盖 light/dark/auto。 */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const sync = () => setDark(root.dataset.theme === 'dark');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** hex(#rrggbb) → 发光 rgba 色：backdrop shadow 用，节点色即光晕色（暗底上呈现「发光节点」效果） */
function glowOf(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return `rgba(148,163,184,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 入场位移动画：节点从随机初始位置插值滑向 ForceAtlas2 终位（easeOutCubic，700ms） */
function animateNodesIn(graph: Graph, start: Map<string, { x: number; y: number }>, sigma: Sigma): void {
  const targets: { node: string; x: number; y: number }[] = [];
  for (const [node, s] of start) {
    if (!graph.hasNode(node)) continue;
    targets.push({ node, x: graph.getNodeAttribute(node, 'x'), y: graph.getNodeAttribute(node, 'y') });
    graph.setNodeAttribute(node, 'x', s.x);
    graph.setNodeAttribute(node, 'y', s.y);
  }
  if (targets.length === 0) return;
  const duration = 700;
  const t0 = performance.now();
  const step = (now: number) => {
    const raw = Math.min(1, (now - t0) / duration);
    const t = 1 - Math.pow(1 - raw, 3); // easeOutCubic
    for (const { node, x, y } of targets) {
      if (!graph.hasNode(node)) continue;
      const sx = start.get(node)!;
      graph.setNodeAttribute(node, 'x', sx.x + (x - sx.x) * t);
      graph.setNodeAttribute(node, 'y', sx.y + (y - sx.y) * t);
    }
    sigma.refresh();
    if (raw < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const TYPE_LABELS: Record<string, string> = {
  user: '用户偏好', feedback: '反馈纠正', project: '项目事实', reference: '外部参考',
};

/**
 * 常开物理参数：对齐 KarpathyWiki 的 forceAtlas2Based 手感——
 * 低中心重力 + 较强斥力 + 阻尼，让图在种子布局后仍持续轻微收敛/回弹，而不是彻底冻结。
 */
const LIVE_PHYSICS = {
  gravity: 0.3,
  scalingRatio: 9,
  strongGravityMode: false,
  edgeWeightInfluence: 0.8,
  adjustSizes: true,
  slowDown: 2.4,
};

/**
 * T05790-① 回弹力反馈：全局统一参数（所有节点一致，避免不同节点弹性感差异）。
 * 拖拽中被拖节点的一跳邻居按「橡皮筋」被牵引一段距离，松手后以欠阻尼弹簧回位（带轻微过冲＝回弹手感）。
 * 位移用图坐标（与世界坐标一致，min/maxCameraRatio 限定缩放），每个邻居独立衰减，簇内互不干扰。
 */
const BOUNCE = {
  pull: 0.28,        // 邻居跟随被拖节点的牵引系数（占位移比例）
  maxPull: 12,       // 邻居最大牵引距离，防止被拖到图外
  stiffness: 0.22,   // 弹簧刚度：越大回位越快
  damping: 0.74,     // 阻尼：<1 欠阻尼产生轻微过冲（回弹），>1 过阻尼无回弹
  settleEps: 0.05,   // 回位收敛阈值（图坐标），低于此值停止 rAF 省电
};

/**
 * T05790-② 放大后标题全量显示阈值：相机 ratio ≤ 该值即视为「放大」，
 * nodeReducer 对所有节点强制 labelVisibility=visible，让记忆标题全量可读。
 * sigma 相机 ratio 越小＝越放大（minCameraRatio=0.08 为最放大，1 为默认全览）。
 */
const LABEL_ALL_RATIO = 0.62;

/** T05790-③ 图谱视图状态：相机 + 节点坐标 + 选中项；按 productKey 存 sessionStorage，切页/刷新后还原。 */
interface GraphViewState {
  camera: { x: number; y: number; ratio: number };
  positions: Record<string, { x: number; y: number }>;
  selectedId: string | null;
  savedAt: number;
}
const viewStateKey = (productKey: string) => `mtask.memoryGraph.view.${productKey}`;

function readViewState(productKey: string): GraphViewState | null {
  try {
    const raw = sessionStorage.getItem(viewStateKey(productKey));
    if (!raw) return null;
    const v = JSON.parse(raw) as GraphViewState;
    if (!v?.camera || typeof v.camera.x !== 'number' || typeof v.camera.y !== 'number'
      || typeof v.camera.ratio !== 'number' || !Number.isFinite(v.camera.ratio) || v.camera.ratio <= 0) return null;
    if (!v.positions || typeof v.positions !== 'object' || Array.isArray(v.positions)) return null;
    // 抽样校验坐标是有限数字：坏数据直接判不可恢复，避免把 NaN 灌进 sigma 相机/布局
    for (const id of Object.keys(v.positions)) {
      const p = v.positions[id];
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number'
        || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    }
    if (v.selectedId !== null && typeof v.selectedId !== 'string') return null;
    if (typeof v.savedAt !== 'number') return null;
    return v;
  } catch {
    return null;
  }
}
function writeViewState(productKey: string, v: GraphViewState): void {
  try { sessionStorage.setItem(viewStateKey(productKey), JSON.stringify(v)); } catch { /* 配额/隐私模式忽略 */ }
}

interface GraphNode {
  id: string;
  kind: 'memory' | 'project' | 'task';
  type?: string;
  title: string;
  content?: string;
  tags?: string[];
  projectId?: string | null;
  size: number;
  invalidated?: boolean;
  supersededBy?: string | null;
  sourceTaskId?: string | null;
  accessCount?: number;
  updatedAt?: string;
}
interface GraphEdge { id: string; source: string; target: string; kind: 'tag' | 'supersede' | 'project' | 'task'; tag?: string }
interface GraphData {
  ok: boolean; nodes: GraphNode[]; edges: GraphEdge[];
  stats: { memoryCount: number; projectCount: number; tagEdgeCount: number; supersedeCount: number; taskCount: number };
}

function nodeColor(n: GraphNode, theme: GraphTheme): string {
  if (n.invalidated) return theme.deadColor;
  if (n.kind === 'project') return theme.projectColor;
  if (n.kind === 'task') return theme.taskColor;
  return theme.typeColors[n.type ?? 'reference'] ?? theme.deadColor;
}

export function MemoryGraph({ productKey }: { productKey: string }) {
  const isDark = useIsDarkTheme();
  const theme = isDark ? DARK_THEME : LIGHT_THEME;
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  // T05738 P2 时间轴回放：cursor 之前的节点隐藏（逐桶生长）；ref 供 reducer 读避免 React 重渲染
  const [replayTick, setReplayTick] = useState(0); // 仅驱动控制条 UI（已显现计数）
  const [replayActive, setReplayActive] = useState(false);
  const replayRef = useRef<{ active: boolean; cursor: string | null }>({ active: false, cursor: null });
  const replayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  // hover/邻域状态放 ref：变化只 sigma.refresh()，不触发 React 重渲染
  const hoveredRef = useRef<string | null>(null);
  const graphRef = useRef<Graph | null>(null);
  // 常开物理循环：rAF 句柄 + 拖拽暂停标志（拖拽时让用户完全控制节点，松手后自然收敛）
  const simRafRef = useRef<number | null>(null);
  const simPausedRef = useRef(false);
  // T05790-① 拖拽回弹：被拖节点 + 一跳邻居的 rest/offset/速度；phase=drag 牵引、release 欠阻尼回位
  const dragBounceRef = useRef<{
    dragged: string;
    /** 被拖节点按下时的图坐标：drag 阶段用「当前坐标 - 起点」得到真实拖拽位移 */
    originX: number;
    originY: number;
    phase: 'drag' | 'release';
    neighbors: Map<string, { restX: number; restY: number; offX: number; offY: number; vx: number; vy: number }>;
  } | null>(null);
  // T05790-② 相机缩放 → 标题全量显示：只在「是否放大态」翻转时 sigma.refresh（ratio 本身无需留存）
  const labelsAllRef = useRef(false);
  // T05790-③ 视图状态持久化：selected 镜像（供 effect 内的 saveView 读最新值）+ 保存节流时间戳
  const selectedRef = useRef<GraphNode | null>(null);
  const lastSaveRef = useRef(0);
  // 「重排布局」显式要求重新播种：置 true 后本次 load 跳过视图恢复（产品切换不带此标记）
  const skipRestoreRef = useRef(false);

  /** effect 内的 saveView 以 ref 暴露给事件回调，避免闭包捕获旧 state。 */
  const saveViewRef = useRef<(() => void) | null>(null);
  /** 统一选中入口：镜像 ref + 触发 reducer 重算高亮（nodeReducer 闭包读 selectedRef）。 */
  const selectNode = useCallback((node: GraphNode | null) => {
    selectedRef.current = node;
    setSelected(node);
    sigmaRef.current?.refresh();
    saveViewRef.current?.();
  }, []);

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3000); };
  const [notice, setNotice] = useState('');

  /** P2 时间轴回放：按记忆 updated_at 升序分桶，逐桶显现（每桶 160ms），走到尽头自动复位全显 */
  const stopReplay = useCallback(() => {
    if (replayTimerRef.current) { clearInterval(replayTimerRef.current); replayTimerRef.current = null; }
    replayRef.current = { active: false, cursor: null };
    setReplayActive(false);
    sigmaRef.current?.refresh();
  }, []);

  const startReplay = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    stopReplay();
    const times = [...new Set(
      g.nodes().map((n) => g.getNodeAttribute(n, 'nodeUpdatedAt')).filter((t): t is string => !!t),
    )].sort((a, b) => a.localeCompare(b));
    if (times.length === 0) { flash('本图没有可回放的时间戳记忆'); return; }
    let i = 0;
    replayRef.current = { active: true, cursor: '' }; // '' 早于任何 ISO 时间戳 → 初始全隐
    setReplayActive(true);
    replayTimerRef.current = setInterval(() => {
      replayRef.current.cursor = times[i];
      sigmaRef.current?.refresh();
      setReplayTick((t) => t + 1);
      i++;
      if (i >= times.length) stopReplay();
    }, 160);
  }, [stopReplay]);

  // 卸载兜底：清回放定时器（sigma.kill 在渲染 effect 的 cleanup 里）
  useEffect(() => () => { if (replayTimerRef.current) clearInterval(replayTimerRef.current); }, []);

  const load = useCallback(async () => {
    if (!productKey) { setData(null); return; }
    stopReplay();
    setLoading(true);
    selectedRef.current = null;
    setSelected(null);
    try {
      const r = await api.get<GraphData>(`/memories/graph?productKey=${encodeURIComponent(productKey)}`);
      setData(r);
    } catch (e) {
      setData({ ok: false, nodes: [], edges: [], stats: { memoryCount: 0, projectCount: 0, tagEdgeCount: 0, supersedeCount: 0, taskCount: 0 }, error: e instanceof Error ? e.message : String(e) } as GraphData);
    } finally { setLoading(false); }
  }, [productKey, stopReplay]);

  useEffect(() => { void load(); }, [load]);

  // 图谱构建与渲染：数据变化时重建（量级 ≤ 数百节点，重建成本毫秒级）
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !data) return;
    // 「重排布局」标记必须在本轮数据消费时清掉：空图/请求失败也清，避免残留到下一次成功加载
    const skipRestore = skipRestoreRef.current;
    skipRestoreRef.current = false;
    if (data.nodes.length === 0) return;

    const graph = new Graph({ multi: false, type: 'undirected' });
    const startPositions = new Map<string, { x: number; y: number }>();
    // T05790-③ 视图状态恢复：仅当上次保存的节点集覆盖当前 ≥80% 时视为可复用，避免数据增删后错位。
    const saved = skipRestore ? null : readViewState(productKey);
    const savedIds = saved ? Object.keys(saved.positions) : [];
    const canRestore = !!saved && savedIds.length > 0
      && data.nodes.filter((n) => saved.positions[n.id]).length >= Math.ceil(data.nodes.length * 0.8);
    for (const n of data.nodes) {
      // T05790-③ 有可复用视图时直接用上次的坐标，否则随机初始位置（FA2 assign 会覆盖为布局终位）
      const prev = canRestore ? saved!.positions[n.id] : null;
      const x = prev ? prev.x : Math.random() * 100;
      const y = prev ? prev.y : Math.random() * 100;
      startPositions.set(n.id, { x, y });
      // nodeUpdatedAt：回放生长的时间轴锚点（记忆/任务节点有时间戳；项目聚簇节点恒可见）
      graph.addNode(n.id, { x, y, size: n.size, color: nodeColor(n, theme), label: n.title, nodeKind: n.kind, nodeUpdatedAt: n.updatedAt ?? null });
    }
    for (const e of data.edges) {
      if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.id)) {
        graph.addEdgeWithKey(e.id, e.source, e.target, { edgeKind: e.kind, edgeTag: e.tag ?? '' });
      }
    }
    graphRef.current = graph;

    // 第一步：FA2 种子布局（90 次），给节点一个稳定的初始骨架；
    // 真正的「持续力模拟」交给下面的 rAF 单步循环，避免一次性跑几百次造成首屏卡顿。
    // T05790-③ 可恢复视图时跳过种子重排，保住上次坐标（随后入场动画为 no-op）。
    if (!canRestore) {
      ForceAtlas2.assign(graph, {
        iterations: 90,
        settings: { ...LIVE_PHYSICS, barnesHutOptimize: data.nodes.length > 300 },
      });
    }

    // sigma v4：settings 与 styles 分层——门控/相机在 settings，标签颜色/字号在 styles.nodes
    const sigma = new Sigma(graph, container, {
      settings: {
        // 自动把图包围盒铺满画布；stagePadding 保证节点/标签不被边框裁掉
        autoRescale: true,
        autoRescaleContent: 'nodes',
        stagePadding: 56,
        // 默认只给大节点显示标签，避免十几个长标题叠在一起；缩放或 hover/选中后显示当前节点标签
        labelRenderedSizeThreshold: 7.4,
        labelDensity: 0.7,
        minCameraRatio: 0.08,
        maxCameraRatio: 8,
        // 方案 A：保留 sigma 原生节点拖拽；T05790 在其上叠加一跳邻居回弹，不改变原生拖拽的稳定性
        enableNodeDrag: true,
        dragTimeout: 60,
      },
      styles: {
        stage: {
          // 让 WebGL 画布保持透明，真正底色由外层容器的主题渐变绘制
          background: 'transparent',
        },
        nodes: {
          // sigma v4：传入 styles.nodes 会整体覆盖默认样式；必须先展开默认绑定，
          // 否则 color/x/y/size 等绑定丢失，节点会回落为默认灰色 #666。
          ...DEFAULT_STYLES.nodes,
          cursor: { whenState: 'isDragged', then: 'grabbing', else: 'grab' },
          labelColor: theme.label,
          labelSize: 12,
          labelFont: 'system-ui, sans-serif',
          labelBackgroundColor: theme.labelBg,
          labelBackgroundPadding: 3,
          // T05738 P1 发光：backdrop 常开，shadow 用节点色做光晕；暗底更亮、亮底更克制
          backdropVisibility: 'visible',
          backdropColor: 'rgba(0,0,0,0)',
          backdropPadding: 2,
          backdropBorderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.06)',
          backdropBorderWidth: 1,
          backdropShadowColor: (attrs: { color?: string }) => glowOf(String(attrs?.color ?? '#94a3b8'), theme.glowAlpha),
          backdropShadowBlur: { whenState: 'isHovered', then: 24, else: theme.glowBlur }, // NOSONAR - sigma 状态映射 API 固定字段名 then/else，并非 Promise thenable
        },
        edges: {
          ...DEFAULT_STYLES.edges,
          // 边宽/颜色仍由 edgeReducer 按 edgeKind 动态给出；这里只兜底默认值
          color: theme.edgeTag,
          size: 1.2,
        },
      },
      nodeReducer: (node, attrs) => {
        const res = { ...attrs } as Record<string, unknown>;
        // T05738 P2 回放：时间轴 cursor 之后的节点隐藏（isHidden 驱动 v4 visibility 状态机）
        const rp = replayRef.current;
        if (rp.active && rp.cursor !== null) {
          const ut = (attrs as unknown as Record<string, unknown>).nodeUpdatedAt as string | null | undefined;
          if (ut && ut > rp.cursor) { res.isHidden = true; return res; }
        }
        const baseSize = Number((attrs as unknown as Record<string, unknown>).size ?? 6);
        // T05738：默认隐藏标签，仅 hover/选中时显示。主题切换会重建画布并改变缩放，
        // 若依赖 labelRenderedSizeThreshold，缩放变大时全部标签会同时出现并互相压字。
        // T05790-② 放大态（相机 ratio ≤ LABEL_ALL_RATIO）：所有可见/已加载节点强制显示记忆标题。
        // 回放隐藏的节点上面已 return，不会被强制显示；标签可见性统一由 resolveLabelVisibility 决策。
        const hovered = hoveredRef.current;
        if (hovered === node) {
          res.size = baseSize;
          res.opacity = 1;
        } else if (hovered) {
          // 方案 A：悬停只做一跳邻域高亮（非邻域淡出但保留原色），不做呼吸/缩放式持续动画
          const isNeighbor = graph.areNeighbors(node, hovered);
          if (!isNeighbor) {
            res.opacity = 0.46;
          } else {
            res.size = baseSize;
            res.opacity = 1;
          }
        }
        // T05790-③ 用 ref 读选中态：selectNode 会 sigma.refresh()，选中/恢复都能即时高亮（原闭包 selected 会陈旧）
        const selectedSelf = selectedRef.current?.id === node;
        if (selectedSelf) res.opacity = 1;
        // T05790-② 放大态优先于 hover 的“仅显示悬停标签”：labelsAll 时所有节点标题保持可见。
        res.labelVisibility = resolveLabelVisibility({
          labelsAll: labelsAllRef.current,
          selected: selectedSelf,
          hoveredSelf: hovered === node,
        });
        return res;
      },
      edgeReducer: (edge, attrs) => {
        const res = { ...attrs } as Record<string, unknown>;
        const kind = String(res.edgeKind ?? 'tag');
        res.color = kind === 'supersede' ? theme.edgeSupersede : kind === 'project' ? theme.edgeProject : kind === 'task' ? theme.edgeTask : theme.edgeTag;
        // 边宽相位脉冲：同一时刻不同边相位错开，配合持续物理刷新形成轻微「流光」而不抢节点焦点
        const baseSize = kind === 'supersede' ? 2.4 : 1.5;
        const phase = performance.now() / 900 + (edge.charCodeAt(edge.length - 1) % 7);
        res.size = baseSize + (Math.sin(phase) * 0.5 + 0.5) * (kind === 'supersede' ? 0.9 : 0.45);
        // T05738 P2 回放：任一端未显现 → 整条边隐藏
        const rp = replayRef.current;
        if (rp.active && rp.cursor !== null) {
          const su = graph.getNodeAttribute(graph.source(edge), 'nodeUpdatedAt') as string | null | undefined;
          const tu = graph.getNodeAttribute(graph.target(edge), 'nodeUpdatedAt') as string | null | undefined;
          if ((su && su > rp.cursor) || (tu && tu > rp.cursor)) { res.isHidden = true; return res; }
        }
        const hovered = hoveredRef.current;
        if (hovered) {
          const touching = graph.hasEdge(edge)
            && (graph.source(edge) === hovered || graph.target(edge) === hovered);
          if (!touching) res.color = kind === 'supersede' ? theme.edgeDimSupersede : theme.edgeDim;
          else res.size = Math.max(Number(res.size), 1.9);
        }
        return res;
      },
    });
    sigmaRef.current = sigma;

    // T05790-③ 视图状态保存：相机 + 节点坐标 + 选中项，节流写入 sessionStorage。
    // 用 ref 暴露给 selectNode / 拖拽结束等外部回调；卸载前再强制写一次兜底。
    const saveView = () => {
      const now = performance.now();
      if (now - lastSaveRef.current < 400) return; // 节流：拖拽/回放每帧触发，400ms 一次足够
      lastSaveRef.current = now;
      const cam = sigma.getCamera().getState();
      const positions: Record<string, { x: number; y: number }> = {};
      graph.nodes().forEach((id) => {
        positions[id] = { x: graph.getNodeAttribute(id, 'x'), y: graph.getNodeAttribute(id, 'y') };
      });
      writeViewState(productKey, {
        camera: { x: cam.x, y: cam.y, ratio: cam.ratio },
        positions,
        selectedId: selectedRef.current?.id ?? null,
        savedAt: Date.now(),
      });
    };
    saveViewRef.current = saveView;

    // 第二步：常开物理——每 ~32ms 跑一次单步 FA2，让图持续轻微收敛/回弹（KarpathyWiki 的 physics.enabled 手感）。
    // 拖拽/回弹期间由 simPausedRef 暂停 FA2；rAF 循环本身保持，避免频繁重建定时器。
    // T05790-① 回弹：drag 阶段一跳邻居被牵引跟随；release 阶段以欠阻尼弹簧回位（off→0，带轻微过冲）。
    let lastPhysicsStep = 0;
    const stepBounce = () => {
      const bs = dragBounceRef.current;
      if (!bs) return;
      const g = graphRef.current;
      if (!g || !g.hasNode(bs.dragged)) { dragBounceRef.current = null; simPausedRef.current = false; return; }
      const dx = g.getNodeAttribute(bs.dragged, 'x') as number;
      const dy = g.getNodeAttribute(bs.dragged, 'y') as number;
      if (bs.phase === 'drag') {
        // 橡皮筋牵引：按被拖节点相对按下点的真实位移牵引邻居，避免起手就把初始间距当成位移
        const off = dragPullOffset(dx, dy, bs.originX, bs.originY, BOUNCE.pull, BOUNCE.maxPull);
        bs.neighbors.forEach((n, id) => {
          if (!g.hasNode(id)) return;
          n.offX = off.x; n.offY = off.y; n.vx = 0; n.vy = 0;
          g.setNodeAttribute(id, 'x', n.restX + n.offX);
          g.setNodeAttribute(id, 'y', n.restY + n.offY);
        });
      } else {
        // 欠阻尼弹簧回位：v = (v - k·off)·damping；off += v。带轻微过冲＝回弹手感。
        let settled = true;
        bs.neighbors.forEach((n, id) => {
          if (!g.hasNode(id)) return;
          const sx = springStep(n.offX, n.vx, BOUNCE.stiffness, BOUNCE.damping);
          const sy = springStep(n.offY, n.vy, BOUNCE.stiffness, BOUNCE.damping);
          n.offX = sx.off; n.vx = sx.v;
          n.offY = sy.off; n.vy = sy.v;
          if (Math.abs(n.offX) + Math.abs(n.offY) + Math.abs(n.vx) + Math.abs(n.vy) > BOUNCE.settleEps) settled = false;
          g.setNodeAttribute(id, 'x', n.restX + n.offX);
          g.setNodeAttribute(id, 'y', n.restY + n.offY);
        });
        if (settled) {
          // 收敛后归位到 rest 并恢复 FA2，避免邻居永久停在偏移位置
          bs.neighbors.forEach((n, id) => {
            if (g.hasNode(id)) { g.setNodeAttribute(id, 'x', n.restX); g.setNodeAttribute(id, 'y', n.restY); }
          });
          dragBounceRef.current = null;
          simPausedRef.current = false;
        }
      }
    };
    const stepSimulation = () => {
      if (!graphRef.current || graphRef.current.order === 0) return;
      if (dragBounceRef.current) {
        // 回弹接管：拖拽期间停 FA2，由弹簧把邻居牵引/释放回位
        stepBounce();
        sigma.refresh();
      } else if (!simPausedRef.current) {
        const now = performance.now();
        if (now - lastPhysicsStep >= 32) {
          lastPhysicsStep = now;
          ForceAtlas2.assign(graph, { iterations: 1, settings: { ...LIVE_PHYSICS, barnesHutOptimize: data.nodes.length > 300 } });
          sigma.refresh();
        }
      }
      simRafRef.current = requestAnimationFrame(stepSimulation);
    };
    const startSimulation = () => {
      if (simRafRef.current === null) simRafRef.current = requestAnimationFrame(stepSimulation);
    };
    const stopSimulation = () => {
      if (simRafRef.current !== null) {
        cancelAnimationFrame(simRafRef.current);
        simRafRef.current = null;
      }
    };
    // 入场动画 700ms；等它结束（780ms）再开物理，避免两套 x/y 插值互相拉扯
    const simulationStartTimer = window.setTimeout(startSimulation, 780);

    // T05790-③ 相机恢复：有可复用视图时还原上次的中心与缩放，否则复位到画布中心（默认全览）
    const initCam = canRestore && saved!.camera
      ? { x: saved!.camera.x, y: saved!.camera.y, ratio: saved!.camera.ratio }
      : { x: 0.5, y: 0.5, ratio: 1 };
    sigma.getCamera().setState(initCam);
    labelsAllRef.current = initCam.ratio <= LABEL_ALL_RATIO;

    // T05790-③ 相机 updated → 更新放大态（标题全显门控）+ 节流保存视角；只在门控翻转时 refresh
    const onCamera = () => {
      const all = sigma.getCamera().ratio <= LABEL_ALL_RATIO;
      if (all !== labelsAllRef.current) { labelsAllRef.current = all; sigma.refresh(); }
      saveView();
    };
    sigma.getCamera().on('updated', onCamera);

    // T05738 P1 入场动画：节点从随机初始位置滑向 FA2 终位（卡片切换/产品切换时重建即重播）
    // T05790-③ 可恢复视图时 startPositions 已是终位，动画为 no-op
    animateNodesIn(graph, startPositions, sigma);

    // 方案 A：悬停只做一跳邻域高亮；不做呼吸式缩放。节点拖拽的邻域位移由 T05790 回弹接管。
    sigma.on('enterNode', ({ node }) => {
      hoveredRef.current = node;
      sigma.refresh();
    });
    sigma.on('leaveNode', () => {
      hoveredRef.current = null;
      sigma.refresh();
    });

    // 原生拖拽 + T05790-① 回弹力：拖拽开始记录一跳邻居 rest 坐标，结束转入 release 弹簧回位。
    sigma.on('nodeDragStart', ({ node }) => {
      simPausedRef.current = true;
      const originX = graph.getNodeAttribute(node, 'x') as number;
      const originY = graph.getNodeAttribute(node, 'y') as number;
      const neighbors = new Map<string, { restX: number; restY: number; offX: number; offY: number; vx: number; vy: number }>();
      graph.neighbors(node).forEach((id) => {
        neighbors.set(id, {
          restX: graph.getNodeAttribute(id, 'x') as number,
          restY: graph.getNodeAttribute(id, 'y') as number,
          offX: 0, offY: 0, vx: 0, vy: 0,
        });
      });
      dragBounceRef.current = { dragged: node, originX, originY, phase: 'drag', neighbors };
    });
    sigma.on('nodeDragEnd', () => {
      if (dragBounceRef.current && dragBounceRef.current.neighbors.size > 0) {
        dragBounceRef.current.phase = 'release'; // 交回弹簧，收敛后自动恢复 FA2
      } else {
        dragBounceRef.current = null;
        simPausedRef.current = false;
      }
      // 先把节流时间戳清零再保存：否则上次保存 <400ms 时 saveView 会直接 return，拖拽结束不落盘
      lastSaveRef.current = 0;
      saveViewRef.current?.();
    });

    sigma.on('clickNode', ({ node }) => {
      const hit = data.nodes.find((n) => n.id === node);
      selectNode(hit ?? null);
    });
    sigma.on('clickStage', () => { selectNode(null); });

    // T05790-③ 选中项恢复：可恢复视图时按 id 找回上次选中的节点，回填面板与 ref
    if (canRestore && saved!.selectedId) {
      const hit = data.nodes.find((n) => n.id === saved!.selectedId) ?? null;
      selectedRef.current = hit;
      setSelected(hit);
    }

    return () => {
      // 离开页面前最后保存一次视角（节流窗口内也强制写），供切回时还原
      lastSaveRef.current = 0;
      saveView();
      saveViewRef.current = null;
      sigma.getCamera().removeListener('updated', onCamera);
      hoveredRef.current = null;
      dragBounceRef.current = null;
      window.clearTimeout(simulationStartTimer);
      stopSimulation();
      simPausedRef.current = false;
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isDark]);

  if (!productKey) return null;
  if (loading) return <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>图谱加载中…</div>;
  if (!data || data.nodes.length === 0) {
    return (
      <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', padding: 12 }}>
        本产品暂无可视化记忆（需先有记忆条目）。图谱把「共享标签 / 替代链 / 项目归属」画成连线，记忆越多连线越密。
      </div>
    );
  }

  const legend: { color: string; label: string }[] = [
    ...Object.keys(TYPE_LABELS).map((t) => ({ color: theme.typeColors[t], label: TYPE_LABELS[t] })),
    { color: theme.projectColor, label: '项目' },
    { color: theme.taskColor, label: '来源任务' },
    { color: theme.deadColor, label: '已失效' },
  ];
  // 回放进度：已显现节点数（replayTick 仅作渲染触发）
  const shownCount = replayRef.current.active && replayRef.current.cursor !== null
    ? data.nodes.filter((n) => n.updatedAt && n.updatedAt <= replayRef.current.cursor!).length
    : data.nodes.length;
  const totalDated = data.nodes.filter((n) => n.updatedAt).length;

  return (
    <div data-replay-tick={replayTick}>
      <div hidden aria-live="polite">{notice}</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {legend.map((l) => (
          <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: l.color, display: 'inline-block' }} />
            {l.label}
          </span>
        ))}
        <span>· 蓝细线=共享标签</span>
        <span style={{ color: theme.legendSupersede }}>· 红线=被替代</span>
        <span style={{ color: theme.legendProject }}>· 紫线=项目归属</span>
        <span style={{ color: theme.legendTask }}>· 青线=来源任务</span>
        <span>· 持续力模拟，悬停高亮邻域，拖动调整，点击看详情</span>
        <span style={{ marginLeft: 'auto' }}>
          {data.stats.memoryCount} 条记忆 · {data.stats.projectCount} 个项目 · {data.stats.taskCount} 个任务 · {data.stats.tagEdgeCount} 条标签连线
        </span>
        <button onClick={() => (replayActive ? stopReplay() : startReplay())} aria-label={replayActive ? '停止回放' : '回放记忆生长'}
          style={{
            fontSize: 'var(--fs-xs)', padding: '2px 8px', border: `1px solid ${replayActive ? 'var(--accent)' : 'var(--border-strong)'}`,
            borderRadius: 5, background: replayActive ? 'var(--accent)' : 'var(--card-bg)',
            color: replayActive ? 'var(--accent-text)' : 'var(--text-secondary)', cursor: 'pointer',
          }}>{replayActive ? '⏸ 停止回放' : '▶ 回放生长'}</button>
        <button onClick={() => { skipRestoreRef.current = true; void load(); }} title="重排布局 — 忽略上次保存的视角与坐标，重新播种力导向布局"
          style={{
            fontSize: 'var(--fs-xs)', padding: '2px 8px', border: '1px solid var(--border-strong)',
            borderRadius: 5, background: 'var(--card-bg)', color: 'var(--text-secondary)', cursor: 'pointer',
          }}>重排布局</button>
        {replayActive && (
          <span style={{ color: 'var(--accent)' }} data-lck="memory-graph-replay-progress">
            回放中：已显现 {shownCount}/{totalDated}
          </span>
        )}
      </div>
      <div style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <div
          ref={containerRef}
          data-lck="memory-graph-canvas"
          aria-label="记忆关系图谱"
          style={{
            width: '100%', height: 560, cursor: 'default',
            backgroundImage: `${theme.grid}, ${theme.canvas}`,
            backgroundSize: '20px 20px, auto',
            backgroundRepeat: 'repeat, no-repeat',
          }}
        />
        {selected && (
          <div style={{
            position: 'absolute', right: 12, top: 12, width: 300, maxHeight: 480, overflowY: 'auto',
            background: theme.panelBg, border: `1px solid ${theme.panelBorder}`, borderRadius: 8,
            padding: 12, boxSizing: 'border-box', backdropFilter: 'blur(4px)',
            boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.32)' : '0 8px 24px rgba(15,23,42,0.12)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{
                fontSize: 'var(--fs-xs)', color: '#fff', padding: '1px 8px', borderRadius: 999,
                background: nodeColor(selected, theme),
              }}>{selected.kind === 'project' ? '项目' : selected.kind === 'task' ? '来源任务' : (TYPE_LABELS[selected.type ?? ''] ?? selected.type)}</span>
              <button onClick={() => selectNode(null)} aria-label="关闭详情" style={{
                background: 'none', border: 'none', color: theme.panelHint, cursor: 'pointer', fontSize: 14, lineHeight: 1,
              }}>✕</button>
            </div>
            <div style={{ color: theme.panelText, fontSize: 'var(--fs-s)', fontWeight: 600, marginBottom: 6, overflowWrap: 'anywhere' }}>
              {selected.title}
            </div>
            {selected.content && (
              <div style={{ color: theme.panelMuted, fontSize: 'var(--fs-xs)', lineHeight: 1.7, marginBottom: 8, overflowWrap: 'anywhere' }}>
                {selected.content}
              </div>
            )}
            <div style={{ color: theme.panelHint, fontSize: 'var(--fs-xs)', display: 'grid', gap: 3 }}>
              {selected.kind === 'project' && <span>成员记忆：{data.nodes.filter((n) => n.kind === 'memory' && n.projectId === selected.projectId).length} 条</span>}
              {selected.kind === 'task' && <span>关联记忆：{data.nodes.filter((n) => n.kind === 'memory' && n.sourceTaskId === selected.sourceTaskId).length} 条</span>}
              {selected.kind === 'memory' && selected.tags && selected.tags.length > 0 && <span>标签：{selected.tags.join('、')}</span>}
              {selected.kind === 'memory' && <span>作用域：{selected.projectId ? '本期特有' : '产品级共享'}</span>}
              {selected.kind === 'memory' && selected.accessCount !== undefined && <span>访问：{selected.accessCount} 次</span>}
              {selected.kind === 'memory' && selected.sourceTaskId && <span>来源任务：{selected.sourceTaskId}</span>}
              {selected.kind === 'memory' && selected.updatedAt && <span>更新：{selected.updatedAt.slice(0, 16).replace('T', ' ')}</span>}
              {selected.invalidated && <span style={{ color: theme.legendSupersede }}>已失效{selected.supersededBy ? '（被其它记忆替代）' : ''}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
